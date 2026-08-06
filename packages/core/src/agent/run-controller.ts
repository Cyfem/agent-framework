import { randomUUID } from 'node:crypto';

import type { AgentCheckpointMigrator, AgentProtocolCheckpointCodec } from '../subagent/checkpoint';
import { createResourceNotFoundError, SubAgentRuntimeError } from '../subagent/errors';
import {
  assertJsonValue,
  canonicalJsonSha256,
  canonicalizeJson,
  parseJsonValue,
  type JsonValue,
} from '../subagent/json';
import {
  resolveSubAgentLimits,
  type ResolvedSubAgentLimits,
  type TreeBudgetSnapshot,
} from '../subagent/limits';
import { assertPendingBatchInvariants } from '../subagent/pending-batch-invariants';
import {
  appendSafeTaskEvents,
  isTerminalSubAgentTaskState,
  reserveTreeBudget,
  transitionSubAgentTask,
} from '../subagent/state-machine';
import { commitRuntimeStateMutation, type RuntimeTaskMutation } from '../subagent/state-controller';
import type {
  AgentRuntimeStateStore,
  StateLease,
  StoredAgentRun,
  StoredAgentRunStatus,
  StoredModelOperationPurpose,
  StoredModelOperationV1,
  StoredPendingToolBatch,
  StoredTask,
  StoredTaskControlOperation,
} from '../subagent/state-store';
import type { ApprovalRequest } from '../subagent/approval';
import type { SubAgentErrorDescriptor } from '../subagent/errors';
import {
  type CompactTransactionRecoveryAction,
  type DurableCompactTransaction,
  getCompactTransactionRecoveryAction,
} from './context-compact';
import { ContextStore } from './context-store';
import type { AgentProtocol, ContextOf } from './types';

export const AGENT_RUN_CHECKPOINT_VERSION = '1';
export const DEFAULT_AGENT_RUN_LEASE_TTL_MS = 30_000;
const MIN_AGENT_RUN_LEASE_TTL_MS = 30;

const EMPTY_TREE_BUDGET: Readonly<TreeBudgetSnapshot> = Object.freeze({
  descendantsCreated: 0,
  activeExecutions: 0,
  providerCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
});

/** `maxIterations: null` is the durable representation of the public omitted value. */
export type DurableStoredAgentRun = StoredAgentRun;

export type AgentRunCheckpointRecovery<P extends AgentProtocol = AgentProtocol> =
  | { readonly action: 'continue' }
  | {
      readonly action: 'execute_model';
      readonly operation: StoredModelOperationV1 & { readonly phase: 'prepared' };
    }
  | {
      readonly action: 'apply_model';
      readonly operation: StoredModelOperationV1 & { readonly phase: 'result_ready' };
      readonly messages: readonly ContextOf<P>[];
    }
  | {
      readonly action: 'fail_model_outcome_unknown';
      readonly operation: StoredModelOperationV1 & { readonly phase: 'in_flight' };
      readonly error: {
        readonly code: 'INTERNAL_ERROR';
        readonly message: string;
        readonly retryable: false;
        readonly causeCode: 'MODEL_OUTCOME_UNKNOWN';
        readonly outcomeUnknown: true;
      };
    }
  | {
      readonly action: 'execute_compact';
      readonly transaction: DurableCompactTransaction & { readonly phase: 'prepared' };
    }
  | {
      readonly action: 'apply_compact';
      readonly transaction: DurableCompactTransaction & { readonly phase: 'result_ready' };
    }
  | {
      readonly action: 'fail_outcome_unknown';
      readonly error: {
        readonly code: 'INTERNAL_ERROR';
        readonly message: string;
        readonly retryable: false;
        readonly causeCode: 'COMPACT_OUTCOME_UNKNOWN';
        readonly outcomeUnknown: true;
      };
    };

export interface RestoredAgentRunCheckpoint<P extends AgentProtocol> {
  readonly record: DurableStoredAgentRun;
  readonly contextStore: ContextStore<P>;
  readonly protocolContext: readonly ContextOf<P>[];
  readonly recovery: AgentRunCheckpointRecovery<P>;
}

export interface AgentRunCheckpointControllerOptions<P extends AgentProtocol> {
  readonly ownerSessionId: string;
  readonly stateStore: AgentRuntimeStateStore;
  readonly checkpointCodec: AgentProtocolCheckpointCodec<P>;
  readonly checkpointMigrators?: readonly AgentCheckpointMigrator[];
  readonly now?: () => number;
  readonly createRunId?: () => string;
}

export interface AcquireAgentRunLeaseOptions {
  readonly signal?: AbortSignal;
  readonly leaseTtlMs?: number;
}

export interface ActiveAgentRunCheckpoint<P extends AgentProtocol> {
  readonly lease: AgentRunLease;
  readonly checkpoint: RestoredAgentRunCheckpoint<P>;
}

export interface CreateAgentRunCheckpointInput<P extends AgentProtocol> {
  readonly contextStore: ContextStore<P>;
  readonly limits: Readonly<ResolvedSubAgentLimits>;
  readonly maxIterations?: number;
  /** SHA-256 of the initialized Agent configuration that controls durable replay semantics. */
  readonly configurationHash?: string;
  readonly runId?: string;
  readonly modelIteration?: number;
}

export interface UpdateAgentRunCheckpointInput<P extends AgentProtocol> {
  readonly runId: string;
  readonly contextStore: ContextStore<P>;
  readonly status?: StoredAgentRunStatus;
  readonly modelIteration?: number;
  readonly pendingBatch?: StoredPendingToolBatch | null;
  readonly pendingApprovals?: readonly ApprovalRequest[];
  readonly endRequested?: boolean;
  readonly compactTransaction?: DurableCompactTransaction | null;
}

export interface PrepareAgentModelOperationInput {
  readonly runId: string;
  readonly operationId: string;
  readonly iteration: number;
  readonly purpose: StoredModelOperationPurpose;
  /** RFC 8785/JCS request projection SHA-256, computed before provider dispatch. */
  readonly requestHash: string;
}

export interface CommitAgentModelOperationResultInput<P extends AgentProtocol> {
  readonly runId: string;
  readonly operationId: string;
  readonly messages: readonly ContextOf<P>[];
}

export interface ApplyAgentModelOperationInput<
  P extends AgentProtocol,
> extends UpdateAgentRunCheckpointInput<P> {
  readonly operationId: string;
}

export interface TerminalizeAgentRunInput<P extends AgentProtocol> {
  readonly runId: string;
  readonly contextStore: ContextStore<P>;
  readonly status: Extract<StoredAgentRunStatus, 'cancelled' | 'failed'>;
  readonly error: SubAgentErrorDescriptor;
  readonly modelIteration?: number;
}

export interface TerminalizeAgentRunWithTasksInput<P extends AgentProtocol> extends Omit<
  TerminalizeAgentRunInput<P>,
  'status'
> {
  readonly status: 'cancelled';
  readonly reason?: string;
  readonly operationId?: string;
}

export interface TerminalizedAgentRunWithTasks<
  P extends AgentProtocol,
> extends RestoredAgentRunCheckpoint<P> {
  readonly cancellationOperationId: string;
  readonly cancelledTaskIds: readonly string[];
}

interface PreparedAgentRunCheckpointUpdate {
  readonly contextStore: StoredAgentRun['contextStore'];
  readonly protocolContext: StoredAgentRun['protocolContext'];
  readonly pendingBatch: StoredPendingToolBatch | null | undefined;
  readonly pendingApprovals: readonly ApprovalRequest[] | undefined;
  readonly compactTransaction: DurableCompactTransaction | null | undefined;
}

interface MigratedAgentRunRecord {
  readonly changed: boolean;
  readonly record: DurableStoredAgentRun;
}

type RootCheckpointMigrator = Extract<AgentCheckpointMigrator, { readonly protocol: string }>;

/**
 * Exclusive, renewing ownership of one root Agent run. The fixed fencing token
 * identifies the whole provider-execution epoch; renewal never changes it.
 */
export class AgentRunLease {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly key: string;
  readonly fencingToken: string;
  readonly signal: AbortSignal;

  readonly #controllerIdentity: object;
  readonly #ttlMs: number;
  readonly #lost = new AbortController();
  readonly #releasedSignal = new AbortController();
  #current: StateLease;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #exclusiveTail: Promise<void> = Promise.resolve();
  #releaseRequested = false;
  #released = false;

  /** @internal Constructed only by AgentRunCheckpointController.acquire(). */
  constructor(input: {
    readonly controllerIdentity: object;
    readonly ownerSessionId: string;
    readonly runId: string;
    readonly lease: StateLease;
    readonly ttlMs: number;
  }) {
    this.#controllerIdentity = input.controllerIdentity;
    this.ownerSessionId = input.ownerSessionId;
    this.runId = input.runId;
    this.key = input.lease.key;
    this.fencingToken = input.lease.fencingToken;
    this.#current = input.lease;
    this.#ttlMs = input.ttlMs;
    // Caller cancellation/deadline controls Agent work, not durable ownership. Keeping the
    // ownership signal independent lets the current fenced owner persist a cancelled terminal.
    this.signal = AbortSignal.any([this.#lost.signal, this.#releasedSignal.signal]);
    this.signal.addEventListener('abort', () => this.#clearTimer(), { once: true });
    this.#scheduleRenewal();
  }

  get expiresAt(): number {
    return this.#current.expiresAt;
  }

  get released(): boolean {
    return this.#released;
  }

  /** Release only after every Model/Tool/Executor operation using `signal` has settled. */
  async release(): Promise<void> {
    if (this.#releaseRequested) {
      await this.#exclusiveTail;
      return;
    }
    this.#releaseRequested = true;
    this.#clearTimer();
    await this.#exclusive(async () => {
      if (this.#released) return;
      this.#released = true;
      this.#releasedSignal.abort(invalidState('The root Agent run lease was released.'));
      try {
        await this.#current.release();
      } catch {
        // A lost/taken-over lease is already fenced; cleanup cannot restore ownership.
      }
    });
  }

  /** @internal Serializes Store operations with renewal so one exact lease handle is used. */
  async use<T>(
    controllerIdentity: object,
    ownerSessionId: string,
    runId: string,
    work: (lease: StateLease) => Promise<T>,
  ): Promise<T> {
    return this.#exclusive(async () => {
      this.#assertOwned(controllerIdentity, ownerSessionId, runId);
      try {
        return await work(this.#current);
      } catch (error) {
        // StateStore adapters are not required to expose a common fencing-loss error. Probe the
        // exact lease while this exclusive turn is still held: a successful renewal proves the
        // work error was unrelated, while any failure/identity drift proves this owner is stale.
        try {
          const renewed = await this.#current.renew(this.#ttlMs);
          if (renewed.key !== this.key || renewed.fencingToken !== this.fencingToken) {
            throw rootLeaseLostError();
          }
          this.#current = renewed;
        } catch (renewalError) {
          const ownershipError = rootLeaseLostError(renewalError);
          this.#lost.abort(ownershipError);
          throw ownershipError;
        }
        throw error;
      }
    });
  }

  /**
   * Structural ownership proof consumed by SubAgentRuntime root-scoped mutations.
   * The callback runs against the exact live StateLease and is serialized with renewal.
   */
  async useStateLease<T>(work: (lease: StateLease) => Promise<T>): Promise<T> {
    return this.use(this.#controllerIdentity, this.ownerSessionId, this.runId, work);
  }

  #assertOwned(controllerIdentity: object, ownerSessionId: string, runId: string): void {
    if (
      controllerIdentity !== this.#controllerIdentity ||
      ownerSessionId !== this.ownerSessionId ||
      runId !== this.runId
    ) {
      throw invalidState('The root Agent run lease does not own this checkpoint.');
    }
    if (this.#releaseRequested || this.#released) {
      throw invalidState('The root Agent run lease is no longer active.');
    }
    if (this.signal.aborted) throwAbortReason(this.signal);
    if (this.#current.key !== this.key || this.#current.fencingToken !== this.fencingToken) {
      throw rootLeaseLostError();
    }
  }

  #scheduleRenewal(): void {
    if (this.#releaseRequested || this.signal.aborted) return;
    this.#timer = setTimeout(
      () => {
        void this.#renew();
      },
      Math.max(10, Math.floor(this.#ttlMs / 3)),
    );
    this.#timer.unref?.();
  }

  async #renew(): Promise<void> {
    if (this.#releaseRequested || this.signal.aborted) return;
    try {
      await this.#exclusive(async () => {
        if (this.#releaseRequested || this.signal.aborted) return;
        const renewed = await this.#current.renew(this.#ttlMs);
        if (renewed.key !== this.key || renewed.fencingToken !== this.fencingToken) {
          throw rootLeaseLostError();
        }
        this.#current = renewed;
      });
      this.#scheduleRenewal();
    } catch (error) {
      this.#lost.abort(rootLeaseLostError(error));
    }
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#exclusiveTail;
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    this.#exclusiveTail = previous.then(
      () => turn,
      () => turn,
    );
    await previous;
    try {
      return await work();
    } finally {
      releaseTurn();
    }
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

/** Durable root-loop checkpoint controller; it never runs Model, Tool, or Executor work. */
export class AgentRunCheckpointController<P extends AgentProtocol> {
  readonly ownerSessionId: string;
  readonly #stateStore: AgentRuntimeStateStore;
  readonly #codec: AgentProtocolCheckpointCodec<P>;
  readonly #migrators: readonly AgentCheckpointMigrator[];
  readonly #now: () => number;
  readonly #createRunId: () => string;
  readonly #leaseIdentity = Object.freeze({});

  get transactionDomainId(): string {
    return this.#stateStore.transactionDomainId;
  }

  constructor(options: AgentRunCheckpointControllerOptions<P>) {
    assertNonEmpty(options.ownerSessionId, 'ownerSessionId');
    assertCheckpointCodec(options.checkpointCodec);
    if (
      typeof options.stateStore !== 'object' ||
      options.stateStore === null ||
      typeof options.stateStore.transactionDomainId !== 'string' ||
      options.stateStore.transactionDomainId.length === 0
    ) {
      throw new TypeError('Agent run checkpoints require a valid AgentRuntimeStateStore.');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('Agent run checkpoint now must be a function.');
    }
    if (options.createRunId !== undefined && typeof options.createRunId !== 'function') {
      throw new TypeError('Agent run checkpoint createRunId must be a function.');
    }

    this.ownerSessionId = options.ownerSessionId;
    this.#stateStore = options.stateStore;
    this.#codec = options.checkpointCodec;
    this.#migrators = validateRootCheckpointMigrators(
      options.checkpointMigrators ?? [],
      this.#codec.protocol,
    );
    this.#now = options.now ?? Date.now;
    this.#createRunId = options.createRunId ?? (() => `run-${randomUUID()}`);
  }

  /** Acquire ownership before creating/restoring state or issuing any provider request. */
  async acquire(runId: string, options: AcquireAgentRunLeaseOptions = {}): Promise<AgentRunLease> {
    assertNonEmpty(runId, 'runId');
    const ttlMs = options.leaseTtlMs ?? DEFAULT_AGENT_RUN_LEASE_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_AGENT_RUN_LEASE_TTL_MS) {
      throw new RangeError(
        `Agent run leaseTtlMs must be a safe integer of at least ${MIN_AGENT_RUN_LEASE_TTL_MS}ms.`,
      );
    }
    const parentSignal = options.signal ?? new AbortController().signal;
    if (parentSignal.aborted) throwAbortReason(parentSignal);
    const key = createRunLeaseKey(this.ownerSessionId, runId);
    const stateLease = await this.#stateStore.acquireLease(key, ttlMs);
    if (parentSignal.aborted) {
      await stateLease.release();
      throwAbortReason(parentSignal);
    }
    return new AgentRunLease({
      controllerIdentity: this.#leaseIdentity,
      ownerSessionId: this.ownerSessionId,
      runId,
      lease: stateLease,
      ttlMs,
    });
  }

  /** Select the run ID, acquire its lease, then persist the initial checkpoint. */
  async beginCreate(
    input: CreateAgentRunCheckpointInput<P>,
    options: AcquireAgentRunLeaseOptions = {},
  ): Promise<ActiveAgentRunCheckpoint<P>> {
    const runId = input.runId ?? this.#createRunId();
    const lease = await this.acquire(runId, options);
    try {
      const checkpoint = await this.create({ ...input, runId }, lease);
      return Object.freeze({ lease, checkpoint });
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  /** Acquire the run lease before decoding a resumable checkpoint. */
  async beginResume(
    runId: string,
    options: AcquireAgentRunLeaseOptions = {},
  ): Promise<ActiveAgentRunCheckpoint<P>> {
    const lease = await this.acquire(runId, options);
    try {
      const checkpoint = await this.resume(runId, lease);
      return Object.freeze({ lease, checkpoint });
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async create(
    input: CreateAgentRunCheckpointInput<P>,
    lease: AgentRunLease,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    const runId = input.runId ?? lease.runId;
    assertNonEmpty(runId, 'runId');
    const modelIteration = input.modelIteration ?? 0;
    assertNonNegativeInteger(modelIteration, 'modelIteration');
    assertOptionalMaxIterations(input.maxIterations);
    if (input.configurationHash !== undefined) {
      assertSha256(input.configurationHash, 'configurationHash');
    }
    const limits = resolveSubAgentLimits(input.limits);
    if (canonicalizeJson(limits) !== canonicalizeJson(input.limits)) {
      throw new TypeError('Root Agent limits must be a complete resolved limits snapshot.');
    }
    const now = this.#now();
    assertTimestamp(now, 'now');
    const protocolContext = encodeProtocolContext(
      this.#codec,
      input.contextStore.getActiveContext(),
    );
    const record: DurableStoredAgentRun = Object.freeze({
      recordVersion: '1' as const,
      ownerSessionId: this.ownerSessionId,
      runId,
      status: 'running' as const,
      revision: 0,
      fencingToken: lease.fencingToken,
      agentCheckpointVersion: AGENT_RUN_CHECKPOINT_VERSION,
      protocolContext,
      contextStore: input.contextStore.exportCheckpoint(this.#codec),
      modelIteration,
      maxIterations: input.maxIterations ?? null,
      configurationHash:
        input.configurationHash ??
        canonicalJsonSha256({
          version: '1',
          maxIterations: input.maxIterations ?? null,
          limits,
        }),
      limits,
      budget: EMPTY_TREE_BUDGET,
      pendingApprovals: Object.freeze([]),
      endRequested: false,
      createdAt: now,
      updatedAt: now,
    });

    await lease.use(this.#leaseIdentity, this.ownerSessionId, runId, async () => {
      await this.#stateStore.createRun(record);
    });
    return this.#restoreRecord(record);
  }

  async load(runId: string, lease: AgentRunLease): Promise<RestoredAgentRunCheckpoint<P>> {
    assertNonEmpty(runId, 'runId');
    const record = await lease.use(this.#leaseIdentity, this.ownerSessionId, runId, async () =>
      this.#stateStore.loadRun(this.ownerSessionId, runId),
    );
    if (record === undefined) throw createResourceNotFoundError();
    return this.#restoreRecord(record);
  }

  /**
   * Copy-on-write resume normalization. Migrators run on detached JSON outside
   * the StateStore transaction; only the fully validated final record is CASed.
   */
  async resume(runId: string, lease: AgentRunLease): Promise<RestoredAgentRunCheckpoint<P>> {
    assertNonEmpty(runId, 'runId');
    const original = await lease.use(this.#leaseIdentity, this.ownerSessionId, runId, async () =>
      this.#stateStore.loadRun(this.ownerSessionId, runId),
    );
    if (original === undefined) throw createResourceNotFoundError();
    if (original.runId !== runId || original.ownerSessionId !== this.ownerSessionId) {
      throw createResourceNotFoundError();
    }

    const migrated = await this.#migrateResumeRecord(original);
    const unknownModelOutcome =
      migrated.record.modelOperation?.phase === 'in_flight' &&
      !(
        migrated.record.status === 'failed' &&
        migrated.record.error?.outcomeUnknown === true &&
        migrated.record.error.causeCode === 'MODEL_OUTCOME_UNKNOWN'
      );
    if (!migrated.changed && !unknownModelOutcome) return this.#restoreRecord(original);

    let committed!: DurableStoredAgentRun;
    let restored!: RestoredAgentRunCheckpoint<P>;
    await lease.use(this.#leaseIdentity, this.ownerSessionId, runId, async (stateLease) => {
      const observedNow = this.#now();
      assertTimestamp(observedNow, 'now');
      const normalized = {
        ...migrated.record,
        ownerSessionId: original.ownerSessionId,
        runId: original.runId,
        recordVersion: original.recordVersion,
        revision: original.revision + 1,
        fencingToken: stateLease.fencingToken,
        createdAt: original.createdAt,
        updatedAt: Math.max(observedNow, original.updatedAt),
      } as DurableStoredAgentRun;
      committed = Object.freeze(
        unknownModelOutcome
          ? {
              ...normalized,
              status: 'failed' as const,
              error: modelOutcomeUnknownError(),
            }
          : normalized,
      );
      try {
        restored = this.#restoreRecord(committed);
      } catch (error) {
        throw checkpointMigrationFailed(
          'The migrated root Agent checkpoint failed final validation.',
          error,
        );
      }
      await commitRuntimeStateMutation(this.#stateStore, this.ownerSessionId, stateLease, {
        run: { previous: original, next: committed },
      });
    });
    return restored;
  }

  /** Waiting approval must retain the exact open Tool batch and open ContextStore span. */
  async restoreWaitingApproval(
    runId: string,
    lease: AgentRunLease,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    const restored = await this.load(runId, lease);
    if (restored.record.status !== 'waiting_approval') {
      throw invalidState('The root Agent run is not waiting for approval.');
    }
    if (
      restored.record.pendingBatch === undefined ||
      restored.record.pendingApprovals.length === 0 ||
      !restored.contextStore.hasOpenLoopSpan
    ) {
      throw checkpointMismatch('The waiting-approval root checkpoint is incomplete.');
    }
    return restored;
  }

  /** Persist provider intent before any request can be issued. */
  async prepareModelOperation(
    input: PrepareAgentModelOperationInput,
    lease: AgentRunLease,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    assertNonEmpty(input.runId, 'runId');
    assertNonEmpty(input.operationId, 'model operationId');
    assertNonNegativeInteger(input.iteration, 'model operation iteration');
    assertModelPurpose(input.purpose);
    assertSha256(input.requestHash, 'model operation requestHash');
    return this.#commitModelOperationTransition(input.runId, lease, (current, now) => {
      if (current.modelOperation !== undefined) {
        throw invalidState('A root Agent run already has an open Model operation.');
      }
      if (current.status !== 'running' || current.modelIteration !== input.iteration) {
        throw invalidState('A Model operation must match the active root Agent iteration.');
      }
      return Object.freeze({
        version: '1' as const,
        operationId: input.operationId,
        iteration: input.iteration,
        purpose: input.purpose,
        requestHash: input.requestHash,
        phase: 'prepared' as const,
        preparedAt: now,
        updatedAt: now,
      });
    });
  }

  /** Fence the request as outcome-uncertain immediately before calling the provider SDK. */
  async markModelOperationInFlight(
    runId: string,
    operationId: string,
    lease: AgentRunLease,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    assertNonEmpty(runId, 'runId');
    assertNonEmpty(operationId, 'model operationId');
    let next!: DurableStoredAgentRun;
    await lease.use(this.#leaseIdentity, this.ownerSessionId, runId, async (stateLease) => {
      const current = await this.#stateStore.loadRun(this.ownerSessionId, runId);
      if (current === undefined) throw createResourceNotFoundError();
      this.#validateRecord(current);
      const operation = assertOpenModelOperation(current, operationId, 'prepared');
      if (current.status !== 'running') {
        throw invalidState('Only a running root Agent operation can dispatch a provider call.');
      }
      const observedNow = this.#now();
      assertTimestamp(observedNow, 'now');
      const now = Math.max(observedNow, current.updatedAt);
      const budget = reserveTreeBudget(
        current.budget,
        { providerCalls: 1, inputTokens: 0, outputTokens: 0 },
        current.limits,
      );
      next = Object.freeze({
        ...current,
        revision: current.revision + 1,
        fencingToken: stateLease.fencingToken,
        modelOperation: Object.freeze({
          ...operation,
          phase: 'in_flight' as const,
          updatedAt: now,
        }),
        budget,
        updatedAt: now,
      });
      this.#validateRecord(next);
      await commitRuntimeStateMutation(this.#stateStore, this.ownerSessionId, stateLease, {
        run: { previous: current, next },
      });
    });
    return this.#restoreRecord(next);
  }

  /** Durably encode provider messages before any of them are applied to active context. */
  async commitModelOperationResult(
    input: CommitAgentModelOperationResultInput<P>,
    lease: AgentRunLease,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    assertNonEmpty(input.runId, 'runId');
    assertNonEmpty(input.operationId, 'model operationId');
    const result = encodeProtocolContext(this.#codec, input.messages);
    return this.#commitModelOperationTransition(input.runId, lease, (current, now) => {
      const operation = assertOpenModelOperation(current, input.operationId, 'in_flight');
      return Object.freeze({
        ...operation,
        phase: 'result_ready' as const,
        result,
        updatedAt: now,
      });
    });
  }

  /**
   * Settle a dispatched provider request whose result cannot be proven. No provider cause, body or
   * credential-bearing error is persisted, and the operation remains for durable audit evidence.
   */
  async failModelOperationOutcomeUnknown(
    runId: string,
    operationId: string,
    lease: AgentRunLease,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    assertNonEmpty(runId, 'runId');
    assertNonEmpty(operationId, 'model operationId');
    let next!: DurableStoredAgentRun;
    await lease.use(this.#leaseIdentity, this.ownerSessionId, runId, async (stateLease) => {
      const current = await this.#stateStore.loadRun(this.ownerSessionId, runId);
      if (current === undefined) throw createResourceNotFoundError();
      this.#validateRecord(current);
      assertOpenModelOperation(current, operationId, 'in_flight');
      if (current.status !== 'running') {
        throw invalidState('Only a running root Agent operation can fail outcome-unknown.');
      }
      const observedNow = this.#now();
      assertTimestamp(observedNow, 'now');
      const mutable = {
        ...current,
        status: 'failed' as const,
        revision: current.revision + 1,
        fencingToken: stateLease.fencingToken,
        error: modelOutcomeUnknownError(),
        pendingApprovals: Object.freeze([]),
        endRequested: false,
        updatedAt: Math.max(observedNow, current.updatedAt),
      } as Record<string, unknown>;
      delete mutable.pendingBatch;
      delete mutable.compactTransaction;
      next = Object.freeze(mutable) as unknown as DurableStoredAgentRun;
      this.#validateRecord(next);
      await commitRuntimeStateMutation(this.#stateStore, this.ownerSessionId, stateLease, {
        run: { previous: current, next },
      });
    });
    return this.#restoreRecord(next);
  }

  /** Settle a provider request that returned an explicit rejection and is therefore safe to retry. */
  async rejectModelOperation(
    runId: string,
    operationId: string,
    lease: AgentRunLease,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    assertNonEmpty(runId, 'runId');
    assertNonEmpty(operationId, 'model operationId');
    let next!: DurableStoredAgentRun;
    await lease.use(this.#leaseIdentity, this.ownerSessionId, runId, async (stateLease) => {
      const current = await this.#stateStore.loadRun(this.ownerSessionId, runId);
      if (current === undefined) throw createResourceNotFoundError();
      this.#validateRecord(current);
      assertOpenModelOperation(current, operationId, 'in_flight');
      if (current.status !== 'running') {
        throw invalidState('Only a running root Agent operation can record provider rejection.');
      }
      const observedNow = this.#now();
      assertTimestamp(observedNow, 'now');
      const mutable = {
        ...current,
        revision: current.revision + 1,
        fencingToken: stateLease.fencingToken,
        updatedAt: Math.max(observedNow, current.updatedAt),
      } as Record<string, unknown>;
      delete mutable.modelOperation;
      next = Object.freeze(mutable) as unknown as DurableStoredAgentRun;
      this.#validateRecord(next);
      await commitRuntimeStateMutation(this.#stateStore, this.ownerSessionId, stateLease, {
        run: { previous: current, next },
      });
    });
    return this.#restoreRecord(next);
  }

  /** Persist a non-success root terminal with all resumable state cleared in one fenced CAS. */
  async terminalize(
    input: TerminalizeAgentRunInput<P>,
    lease: AgentRunLease,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    assertNonEmpty(input.runId, 'runId');
    if (input.status !== 'cancelled' && input.status !== 'failed') {
      throw new TypeError('Agent terminalization status must be cancelled or failed.');
    }
    if (input.modelIteration !== undefined) {
      assertNonNegativeInteger(input.modelIteration, 'modelIteration');
    }
    const prepared = this.#prepareCheckpointUpdate({
      runId: input.runId,
      contextStore: input.contextStore,
      status: input.status,
      ...(input.modelIteration === undefined ? {} : { modelIteration: input.modelIteration }),
      pendingBatch: null,
      pendingApprovals: [],
      compactTransaction: null,
      endRequested: false,
    });
    let next!: DurableStoredAgentRun;
    await lease.use(this.#leaseIdentity, this.ownerSessionId, input.runId, async (stateLease) => {
      const current = await this.#stateStore.loadRun(this.ownerSessionId, input.runId);
      if (current === undefined) throw createResourceNotFoundError();
      this.#validateRecord(current);
      if (
        current.status === 'succeeded' ||
        current.status === 'cancelled' ||
        current.status === 'failed'
      ) {
        // A terminal record is authoritative and immutable. Replayed failure/cancel paths
        // return it verbatim without incrementing revision or replacing its safe error.
        next = current;
        return;
      }
      next = this.#buildNextRecord(
        current,
        {
          runId: input.runId,
          contextStore: input.contextStore,
          status: input.status,
          ...(input.modelIteration === undefined ? {} : { modelIteration: input.modelIteration }),
          pendingBatch: null,
          pendingApprovals: [],
          compactTransaction: null,
          endRequested: false,
        },
        prepared,
        stateLease.fencingToken,
        true,
      );
      next = Object.freeze({ ...next, error: Object.freeze({ ...input.error }) });
      this.#validateRecord(next);
      await commitRuntimeStateMutation(this.#stateStore, this.ownerSessionId, stateLease, {
        run: { previous: current, next },
      });
    });
    return this.#restoreRecord(next);
  }

  /**
   * Persist caller cancellation of the root run and every non-terminal descendant in one
   * fenced transaction. Task CAS contention rolls the whole attempt back before the latest
   * authoritative task set is loaded and staged again.
   */
  async terminalizeWithTasks(
    input: TerminalizeAgentRunWithTasksInput<P>,
    lease: AgentRunLease,
  ): Promise<TerminalizedAgentRunWithTasks<P>> {
    assertNonEmpty(input.runId, 'runId');
    if (input.status !== 'cancelled') {
      throw new TypeError('Agent task terminalization status must be cancelled.');
    }
    if (input.modelIteration !== undefined) {
      assertNonNegativeInteger(input.modelIteration, 'modelIteration');
    }
    const cancellationOperationId =
      input.operationId ??
      `cancel-run-${canonicalJsonSha256({ runId: input.runId, reason: input.reason ?? null })}`;
    assertNonEmpty(cancellationOperationId, 'cancel run operationId');
    const payload = cloneCheckpointJson({ reason: input.reason ?? null });
    const prepared = this.#prepareCheckpointUpdate({
      runId: input.runId,
      contextStore: input.contextStore,
      status: 'cancelled',
      ...(input.modelIteration === undefined ? {} : { modelIteration: input.modelIteration }),
      pendingBatch: null,
      pendingApprovals: [],
      compactTransaction: null,
      endRequested: false,
    });
    let next!: DurableStoredAgentRun;
    let cancelledTaskIds: readonly string[] = Object.freeze([]);

    await lease.use(this.#leaseIdentity, this.ownerSessionId, input.runId, async (stateLease) => {
      for (;;) {
        const current = await this.#stateStore.loadRun(this.ownerSessionId, input.runId);
        if (current === undefined) throw createResourceNotFoundError();
        this.#validateRecord(current);
        if (
          current.status === 'succeeded' ||
          current.status === 'cancelled' ||
          current.status === 'failed'
        ) {
          next = current;
          cancelledTaskIds = Object.freeze([]);
          return;
        }

        const tasks = await this.#stateStore.listTasksByRun(this.ownerSessionId, input.runId);
        if (
          tasks.some(
            (task) => task.ownerSessionId !== this.ownerSessionId || task.runId !== input.runId,
          )
        ) {
          throw invalidState('The StateStore returned a task outside the requested root run.');
        }
        const observedNow = this.#now();
        assertTimestamp(observedNow, 'now');
        let now = Math.max(observedNow, current.updatedAt);
        for (const task of tasks) now = Math.max(now, task.updatedAt);
        const staged = stageCancelledDescendantTasks({
          tasks,
          operationRoot: cancellationOperationId,
          payload,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          now,
          fencingToken: stateLease.fencingToken,
        });
        if (staged.activeCancelled > current.budget.activeExecutions) {
          throw invalidState(
            'The root run active execution budget is inconsistent with descendant tasks.',
          );
        }
        next = this.#buildNextRecord(
          current,
          {
            runId: input.runId,
            contextStore: input.contextStore,
            status: 'cancelled',
            ...(input.modelIteration === undefined ? {} : { modelIteration: input.modelIteration }),
            pendingBatch: null,
            pendingApprovals: [],
            compactTransaction: null,
            endRequested: false,
          },
          prepared,
          stateLease.fencingToken,
          true,
        );
        next = Object.freeze({
          ...next,
          budget: Object.freeze({
            ...next.budget,
            activeExecutions: next.budget.activeExecutions - staged.activeCancelled,
          }),
          error: Object.freeze({ ...input.error }),
        });
        this.#validateRecord(next);

        try {
          await commitRuntimeStateMutation(this.#stateStore, this.ownerSessionId, stateLease, {
            run: { previous: current, next },
            ...(staged.mutations.length === 0 ? {} : { tasks: staged.mutations }),
          });
          cancelledTaskIds = staged.cancelledTaskIds;
          return;
        } catch (error) {
          if (!isStateCasConflict(error)) throw error;
          lease.signal.throwIfAborted();
        }
      }
    });

    return Object.freeze({
      ...this.#restoreRecord(next),
      cancellationOperationId,
      cancelledTaskIds,
    });
  }

  /** Apply one durable provider result and clear its operation in the same fenced run CAS. */
  async applyModelOperation(
    input: ApplyAgentModelOperationInput<P>,
    lease: AgentRunLease,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    assertNonEmpty(input.operationId, 'model operationId');
    return this.#commitCheckpoint(input, lease, [], input.operationId);
  }

  /**
   * Persist a complete ContextStore snapshot and root-loop state with one fenced
   * run CAS. All encoding occurs before the transaction callback.
   */
  async checkpoint(
    input: UpdateAgentRunCheckpointInput<P>,
    lease: AgentRunLease,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    return this.#commitCheckpoint(input, lease, []);
  }

  /**
   * Atomically advances the parent checkpoint and affected child task records
   * in this controller's one authoritative StateStore transaction domain.
   */
  async commitWithTasks(
    input: UpdateAgentRunCheckpointInput<P>,
    lease: AgentRunLease,
    tasks: readonly RuntimeTaskMutation[],
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new TypeError('commitWithTasks requires at least one child task mutation.');
    }
    return this.#commitCheckpoint(input, lease, Object.freeze([...tasks]));
  }

  async #commitCheckpoint(
    input: UpdateAgentRunCheckpointInput<P>,
    lease: AgentRunLease,
    tasks: readonly RuntimeTaskMutation[],
    applyModelOperationId?: string,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    assertNonEmpty(input.runId, 'runId');
    if (input.modelIteration !== undefined) {
      assertNonNegativeInteger(input.modelIteration, 'modelIteration');
    }
    if (input.compactTransaction !== undefined && input.compactTransaction !== null) {
      getCompactTransactionRecoveryAction(input.compactTransaction);
    }
    const prepared = this.#prepareCheckpointUpdate(input);
    let next!: DurableStoredAgentRun;

    await lease.use(this.#leaseIdentity, this.ownerSessionId, input.runId, async (stateLease) => {
      for (;;) {
        const current = await this.#stateStore.loadRun(this.ownerSessionId, input.runId);
        if (current === undefined) throw createResourceNotFoundError();
        this.#validateRecord(current);
        if (applyModelOperationId !== undefined) {
          assertOpenModelOperation(current, applyModelOperationId, 'result_ready');
        } else if (current.modelOperation !== undefined) {
          throw invalidState(
            'An open Model operation must settle through its dedicated durable transition API.',
          );
        }
        next = this.#buildNextRecord(
          current,
          input,
          prepared,
          stateLease.fencingToken,
          applyModelOperationId !== undefined,
        );
        const stagedCreateCount = tasks.filter((task) => 'create' in task).length;
        if (stagedCreateCount > 0) {
          next = Object.freeze({
            ...next,
            budget: Object.freeze({
              ...next.budget,
              descendantsCreated: next.budget.descendantsCreated + stagedCreateCount,
            }),
          });
          this.#validateRecord(next);
        }
        try {
          await commitRuntimeStateMutation(this.#stateStore, this.ownerSessionId, stateLease, {
            run: { previous: current, next },
            tasks,
          });
          return;
        } catch (error) {
          // Child tasks update the shared run budget under their own short control-plane
          // transactions. A checkpoint-only mutation can safely reload that authoritative
          // budget and retry; task-bearing commits must retain strict all-or-nothing CAS.
          if (tasks.length > 0 || !isStateCasConflict(error)) throw error;
          lease.signal.throwIfAborted();
        }
      }
    });

    return this.#restoreRecord(next);
  }

  async #commitModelOperationTransition(
    runId: string,
    lease: AgentRunLease,
    transition: (current: DurableStoredAgentRun, now: number) => StoredModelOperationV1,
  ): Promise<RestoredAgentRunCheckpoint<P>> {
    assertNonEmpty(runId, 'runId');
    let next!: DurableStoredAgentRun;
    await lease.use(this.#leaseIdentity, this.ownerSessionId, runId, async (stateLease) => {
      const current = await this.#stateStore.loadRun(this.ownerSessionId, runId);
      if (current === undefined) throw createResourceNotFoundError();
      this.#validateRecord(current);
      if (current.status !== 'running') {
        throw invalidState('A terminal or paused root Agent run cannot issue a Model operation.');
      }
      const observedNow = this.#now();
      assertTimestamp(observedNow, 'now');
      const now = Math.max(observedNow, current.updatedAt);
      next = Object.freeze({
        ...current,
        revision: current.revision + 1,
        fencingToken: stateLease.fencingToken,
        modelOperation: transition(current, now),
        updatedAt: now,
      });
      this.#validateRecord(next);
      await commitRuntimeStateMutation(this.#stateStore, this.ownerSessionId, stateLease, {
        run: { previous: current, next },
      });
    });
    return this.#restoreRecord(next);
  }

  #prepareCheckpointUpdate(
    input: UpdateAgentRunCheckpointInput<P>,
  ): PreparedAgentRunCheckpointUpdate {
    return Object.freeze({
      contextStore: input.contextStore.exportCheckpoint(this.#codec),
      protocolContext: encodeProtocolContext(this.#codec, input.contextStore.getActiveContext()),
      pendingBatch:
        input.pendingBatch === undefined || input.pendingBatch === null
          ? input.pendingBatch
          : clonePendingBatch(input.pendingBatch),
      pendingApprovals:
        input.pendingApprovals === undefined
          ? undefined
          : Object.freeze(input.pendingApprovals.map((approval) => Object.freeze({ ...approval }))),
      compactTransaction:
        input.compactTransaction === undefined || input.compactTransaction === null
          ? input.compactTransaction
          : cloneCompactTransaction(input.compactTransaction),
    });
  }

  #buildNextRecord(
    current: DurableStoredAgentRun,
    input: UpdateAgentRunCheckpointInput<P>,
    prepared: PreparedAgentRunCheckpointUpdate,
    fencingToken: string,
    clearModelOperation = false,
  ): DurableStoredAgentRun {
    const status = input.status ?? current.status;
    assertRunStatusTransition(current.status, status);
    const observedNow = this.#now();
    assertTimestamp(observedNow, 'now');
    const now = Math.max(observedNow, current.updatedAt);
    const mutable = {
      ...current,
      status,
      revision: current.revision + 1,
      fencingToken,
      protocolContext: prepared.protocolContext,
      contextStore: prepared.contextStore,
      modelIteration: input.modelIteration ?? current.modelIteration,
      pendingApprovals: prepared.pendingApprovals ?? current.pendingApprovals,
      endRequested: input.endRequested ?? current.endRequested,
      updatedAt: now,
    } as Record<string, unknown>;
    if (prepared.pendingBatch === null) delete mutable.pendingBatch;
    else if (prepared.pendingBatch !== undefined) mutable.pendingBatch = prepared.pendingBatch;
    if (prepared.compactTransaction === null) delete mutable.compactTransaction;
    else if (prepared.compactTransaction !== undefined) {
      mutable.compactTransaction = prepared.compactTransaction;
    }
    if (clearModelOperation) delete mutable.modelOperation;

    const next = Object.freeze(mutable) as unknown as DurableStoredAgentRun;
    this.#validateRecord(next);
    return next;
  }

  async #migrateResumeRecord(original: DurableStoredAgentRun): Promise<MigratedAgentRunRecord> {
    if (original.ownerSessionId !== this.ownerSessionId) throw createResourceNotFoundError();
    if (original.recordVersion !== '1') {
      throw checkpointMismatch('The root Agent record version is unsupported.');
    }
    return migrateAgentRunCheckpointCopyOnWrite(original, this.#codec, this.#migrators);
  }

  #restoreRecord(record: DurableStoredAgentRun): RestoredAgentRunCheckpoint<P> {
    this.#validateRecord(record);
    const contextStore = ContextStore.restoreCheckpoint(record.contextStore, this.#codec);
    const protocolContext = decodeProtocolContext(this.#codec, record.protocolContext.value);
    if (
      canonicalizeJson(this.#codec.encode(contextStore.getActiveContext())) !==
        canonicalizeJson(record.protocolContext.value) ||
      canonicalizeJson(this.#codec.encode(protocolContext)) !==
        canonicalizeJson(record.protocolContext.value)
    ) {
      throw checkpointMismatch('The root protocol context does not match ContextStore state.');
    }

    return Object.freeze({
      record: cloneDurableRecord(record),
      contextStore,
      protocolContext: Object.freeze([...protocolContext]),
      recovery:
        modelRecovery(record.modelOperation, this.#codec) ??
        compactRecovery(record.compactTransaction),
    });
  }

  #validateRecord(record: DurableStoredAgentRun): void {
    if (
      record.recordVersion !== '1' ||
      record.agentCheckpointVersion !== AGENT_RUN_CHECKPOINT_VERSION
    ) {
      throw checkpointMismatch('The root Agent checkpoint version is unsupported.');
    }
    if (record.ownerSessionId !== this.ownerSessionId) throw createResourceNotFoundError();
    assertNonEmpty(record.runId, 'runId');
    assertNonNegativeInteger(record.revision, 'revision');
    assertNonEmpty(record.fencingToken, 'fencingToken');
    assertNonNegativeInteger(record.modelIteration, 'modelIteration');
    assertNullableMaxIterations(record.maxIterations);
    if (record.configurationHash === undefined) {
      throw checkpointMismatch('The root Agent configuration hash is missing.');
    }
    assertSha256(record.configurationHash, 'configurationHash');
    let resolvedLimits: Readonly<ResolvedSubAgentLimits>;
    try {
      resolvedLimits = resolveSubAgentLimits(record.limits);
    } catch {
      throw checkpointMismatch('The root Agent limits are invalid.');
    }
    if (canonicalizeJson(resolvedLimits) !== canonicalizeJson(record.limits)) {
      throw checkpointMismatch('The root Agent limits snapshot is incomplete.');
    }
    assertTimestamp(record.createdAt, 'createdAt');
    assertTimestamp(record.updatedAt, 'updatedAt');
    if (record.updatedAt < record.createdAt) {
      throw checkpointMismatch('The root Agent checkpoint timestamps are invalid.');
    }
    if (
      record.protocolContext.protocol !== this.#codec.protocol ||
      record.protocolContext.codecVersion !== this.#codec.version ||
      record.contextStore.protocol !== this.#codec.protocol ||
      record.contextStore.codecVersion !== this.#codec.version
    ) {
      throw checkpointMismatch('The root Agent checkpoint codec is incompatible.');
    }
    if (record.compactTransaction !== undefined) {
      getCompactTransactionRecoveryAction(record.compactTransaction);
    }
    if (record.modelOperation !== undefined) {
      assertStoredModelOperation(record.modelOperation, this.#codec);
      if (record.modelOperation.iteration !== record.modelIteration) {
        throw checkpointMismatch('The Model operation iteration is inconsistent.');
      }
      if (
        record.status !== 'running' &&
        !(
          record.status === 'failed' &&
          record.modelOperation.phase === 'in_flight' &&
          record.error?.outcomeUnknown === true
        )
      ) {
        throw checkpointMismatch('A Model operation is incompatible with the root run status.');
      }
      if (record.pendingBatch !== undefined) {
        throw checkpointMismatch(
          'A root Agent checkpoint cannot retain a Model operation and Tool batch together.',
        );
      }
    }
    if (record.pendingBatch !== undefined) {
      assertPendingBatch(record.pendingBatch);
      if (record.pendingBatch.iteration !== record.modelIteration) {
        throw checkpointMismatch('The pending Tool batch iteration is inconsistent.');
      }
    }
    const approvalIds = assertPendingApprovalRequests(record.pendingApprovals, this.ownerSessionId);
    const pausedCalls = record.pendingBatch?.calls.filter((call) => call.status === 'paused') ?? [];
    const referencedApprovalIds = pausedCalls.flatMap((call) => [...(call.approvalIds ?? [])]);
    if (record.status === 'waiting_approval') {
      if (
        record.pendingBatch === undefined ||
        approvalIds.size === 0 ||
        pausedCalls.length === 0 ||
        referencedApprovalIds.length !== approvalIds.size ||
        referencedApprovalIds.some((approvalId) => !approvalIds.has(approvalId))
      ) {
        throw checkpointMismatch(
          'A waiting root Agent run requires an exact pending approval mapping.',
        );
      }
    } else {
      if (approvalIds.size > 0 || pausedCalls.length > 0) {
        throw checkpointMismatch('Only a waiting root Agent run may retain pending approvals.');
      }
      if (
        (record.status === 'succeeded' ||
          record.status === 'cancelled' ||
          record.status === 'failed') &&
        record.pendingBatch !== undefined
      ) {
        throw checkpointMismatch('A terminal root Agent run cannot retain a pending Tool batch.');
      }
    }
  }
}

async function migrateAgentRunCheckpointCopyOnWrite<P extends AgentProtocol>(
  original: DurableStoredAgentRun,
  codec: AgentProtocolCheckpointCodec<P>,
  migrators: readonly AgentCheckpointMigrator[],
): Promise<MigratedAgentRunRecord> {
  let root = cloneMigrationObject(original, 'root Agent checkpoint');
  let changed = false;
  const runStates = new Set<string>();

  for (;;) {
    const protocolContext = migrationObjectMember(
      root,
      'protocolContext',
      'root protocol checkpoint',
    );
    const protocol = migrationStringMember(protocolContext, 'protocol', 'root protocol checkpoint');
    if (protocol !== codec.protocol) {
      throw checkpointMismatch('The root Agent checkpoint protocol is incompatible.');
    }
    const recordVersion = migrationStringMember(
      root,
      'agentCheckpointVersion',
      'root Agent checkpoint',
    );
    const codecVersion = migrationStringMember(
      protocolContext,
      'codecVersion',
      'root protocol checkpoint',
    );
    if (recordVersion === AGENT_RUN_CHECKPOINT_VERSION && codecVersion === codec.version) {
      break;
    }

    const state = `${recordVersion}\u0000${codecVersion}`;
    if (runStates.has(state)) {
      throw checkpointMigrationFailed('The root Agent checkpoint migration path contains a cycle.');
    }
    runStates.add(state);
    const migrator = findRootCheckpointMigrator(
      migrators,
      'agent-run',
      codec.protocol,
      recordVersion,
      codecVersion,
    );
    if (migrator === undefined) {
      throw checkpointMismatch('No compatible root Agent checkpoint migration path is registered.');
    }

    const next = await invokeRootCheckpointMigrator(migrator, root);
    assertMigratedRunIdentity(original, next);
    const nextProtocol = migrationObjectMember(
      next,
      'protocolContext',
      'migrated root protocol checkpoint',
    );
    if (
      migrationStringMember(next, 'agentCheckpointVersion', 'migrated root Agent checkpoint') !==
        migrator.toVersion ||
      migrationStringMember(nextProtocol, 'protocol', 'migrated root protocol checkpoint') !==
        codec.protocol ||
      migrationStringMember(nextProtocol, 'codecVersion', 'migrated root protocol checkpoint') !==
        migrator.toCodecVersion
    ) {
      throw checkpointMigrationFailed(
        'The root Agent checkpoint migrator returned the wrong target version.',
      );
    }
    root = next;
    changed = true;
  }

  let context = migrationObjectMember(root, 'contextStore', 'ContextStore checkpoint');
  const contextStates = new Set<string>();
  for (;;) {
    const protocol = migrationStringMember(context, 'protocol', 'ContextStore checkpoint');
    if (protocol !== codec.protocol) {
      throw checkpointMismatch('The ContextStore checkpoint protocol is incompatible.');
    }
    const recordVersion = migrationStringMember(context, 'version', 'ContextStore checkpoint');
    const codecVersion = migrationStringMember(context, 'codecVersion', 'ContextStore checkpoint');
    if (recordVersion === '1' && codecVersion === codec.version) break;

    const state = `${recordVersion}\u0000${codecVersion}`;
    if (contextStates.has(state)) {
      throw checkpointMigrationFailed(
        'The ContextStore checkpoint migration path contains a cycle.',
      );
    }
    contextStates.add(state);
    const migrator = findRootCheckpointMigrator(
      migrators,
      'context',
      codec.protocol,
      recordVersion,
      codecVersion,
    );
    if (migrator === undefined) {
      throw checkpointMismatch(
        'No compatible ContextStore checkpoint migration path is registered.',
      );
    }

    const next = await invokeRootCheckpointMigrator(migrator, context);
    if (
      migrationStringMember(next, 'version', 'migrated ContextStore checkpoint') !==
        migrator.toVersion ||
      migrationStringMember(next, 'protocol', 'migrated ContextStore checkpoint') !==
        codec.protocol ||
      migrationStringMember(next, 'codecVersion', 'migrated ContextStore checkpoint') !==
        migrator.toCodecVersion
    ) {
      throw checkpointMigrationFailed(
        'The ContextStore checkpoint migrator returned the wrong target version.',
      );
    }
    context = next;
    changed = true;
  }

  if (changed) root = { ...root, contextStore: context };
  return Object.freeze({
    changed,
    record: root as unknown as DurableStoredAgentRun,
  });
}

function validateRootCheckpointMigrators(
  candidates: readonly AgentCheckpointMigrator[],
  protocol: string,
): readonly RootCheckpointMigrator[] {
  if (!Array.isArray(candidates)) {
    throw new TypeError('checkpointMigrators must be an array.');
  }
  const result: RootCheckpointMigrator[] = [];
  const sources = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.recordKind !== 'agent-run' && candidate.recordKind !== 'context') continue;
    assertNonEmpty(candidate.protocol, 'checkpoint migrator protocol');
    assertNonEmpty(candidate.fromVersion, 'checkpoint migrator fromVersion');
    assertNonEmpty(candidate.toVersion, 'checkpoint migrator toVersion');
    assertNonEmpty(candidate.fromCodecVersion, 'checkpoint migrator fromCodecVersion');
    assertNonEmpty(candidate.toCodecVersion, 'checkpoint migrator toCodecVersion');
    if (typeof candidate.migrate !== 'function') {
      throw new TypeError('Checkpoint migrators require migrate().');
    }
    if (
      candidate.fromVersion === candidate.toVersion &&
      candidate.fromCodecVersion === candidate.toCodecVersion
    ) {
      throw new TypeError('A root checkpoint migrator must advance a record or codec version.');
    }
    if (candidate.protocol !== protocol) continue;
    const source = `${candidate.recordKind}\u0000${candidate.fromVersion}\u0000${candidate.fromCodecVersion}`;
    if (sources.has(source)) {
      throw new TypeError(`Ambiguous ${candidate.recordKind} checkpoint migration source.`);
    }
    sources.add(source);
    result.push(Object.freeze({ ...candidate }));
  }
  return Object.freeze(result);
}

function findRootCheckpointMigrator(
  migrators: readonly AgentCheckpointMigrator[],
  recordKind: 'agent-run' | 'context',
  protocol: string,
  fromVersion: string,
  fromCodecVersion: string,
): RootCheckpointMigrator | undefined {
  return migrators.find(
    (candidate): candidate is RootCheckpointMigrator =>
      (candidate.recordKind === 'agent-run' || candidate.recordKind === 'context') &&
      candidate.recordKind === recordKind &&
      candidate.protocol === protocol &&
      candidate.fromVersion === fromVersion &&
      candidate.fromCodecVersion === fromCodecVersion,
  );
}

async function invokeRootCheckpointMigrator(
  migrator: RootCheckpointMigrator,
  value: Readonly<Record<string, JsonValue>>,
): Promise<Readonly<Record<string, JsonValue>>> {
  try {
    const migrated = await Promise.resolve(migrator.migrate(cloneMigrationJson(value)));
    return cloneMigrationObject(migrated, `${migrator.recordKind} migrator output`);
  } catch (error) {
    if (error instanceof SubAgentRuntimeError && error.code === 'CHECKPOINT_MIGRATION_FAILED') {
      throw error;
    }
    throw checkpointMigrationFailed(
      `The ${migrator.recordKind} checkpoint migrator failed.`,
      error,
    );
  }
}

function assertMigratedRunIdentity(
  original: DurableStoredAgentRun,
  migrated: Readonly<Record<string, JsonValue>>,
): void {
  const matches =
    migrationStringMember(migrated, 'recordVersion', 'migrated root Agent checkpoint') ===
      original.recordVersion &&
    migrationStringMember(migrated, 'ownerSessionId', 'migrated root Agent checkpoint') ===
      original.ownerSessionId &&
    migrationStringMember(migrated, 'runId', 'migrated root Agent checkpoint') === original.runId &&
    migrationStringMember(migrated, 'status', 'migrated root Agent checkpoint') ===
      original.status &&
    migrationNumberMember(migrated, 'revision', 'migrated root Agent checkpoint') ===
      original.revision &&
    migrationStringMember(migrated, 'fencingToken', 'migrated root Agent checkpoint') ===
      original.fencingToken &&
    migrationNumberMember(migrated, 'createdAt', 'migrated root Agent checkpoint') ===
      original.createdAt &&
    migrationNumberMember(migrated, 'updatedAt', 'migrated root Agent checkpoint') ===
      original.updatedAt;
  if (!matches) {
    throw checkpointMigrationFailed(
      'A root Agent checkpoint migrator changed immutable run identity or state.',
    );
  }
}

function cloneMigrationObject(value: unknown, label: string): Readonly<Record<string, JsonValue>> {
  const cloned = cloneMigrationJson(value);
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) {
    throw checkpointMigrationFailed(`${label} must be a JSON object.`);
  }
  return cloned as Readonly<Record<string, JsonValue>>;
}

function cloneMigrationJson(value: unknown): JsonValue {
  assertJsonValue(value);
  return parseJsonValue(canonicalizeJson(value));
}

function migrationObjectMember(
  value: Readonly<Record<string, JsonValue>>,
  key: string,
  label: string,
): Readonly<Record<string, JsonValue>> {
  const member = value[key];
  if (typeof member !== 'object' || member === null || Array.isArray(member)) {
    throw checkpointMigrationFailed(`${label}.${key} must be a JSON object.`);
  }
  return member as Readonly<Record<string, JsonValue>>;
}

function migrationStringMember(
  value: Readonly<Record<string, JsonValue>>,
  key: string,
  label: string,
): string {
  const member = value[key];
  if (typeof member !== 'string' || member.length === 0) {
    throw checkpointMigrationFailed(`${label}.${key} must be a non-empty string.`);
  }
  return member;
}

function migrationNumberMember(
  value: Readonly<Record<string, JsonValue>>,
  key: string,
  label: string,
): number {
  const member = value[key];
  if (typeof member !== 'number' || !Number.isSafeInteger(member) || member < 0) {
    throw checkpointMigrationFailed(`${label}.${key} must be a non-negative safe integer.`);
  }
  return member;
}

function modelRecovery<P extends AgentProtocol>(
  operation: StoredModelOperationV1 | undefined,
  codec: AgentProtocolCheckpointCodec<P>,
): AgentRunCheckpointRecovery<P> | undefined {
  if (operation === undefined) return undefined;
  if (operation.phase === 'prepared') {
    return Object.freeze({
      action: 'execute_model' as const,
      operation: cloneModelOperation(operation) as StoredModelOperationV1 & {
        readonly phase: 'prepared';
      },
    });
  }
  if (operation.phase === 'in_flight') {
    return Object.freeze({
      action: 'fail_model_outcome_unknown' as const,
      operation: cloneModelOperation(operation) as StoredModelOperationV1 & {
        readonly phase: 'in_flight';
      },
      error: modelOutcomeUnknownError(),
    });
  }
  const result = operation.result;
  if (result === undefined) {
    throw checkpointMismatch('A result-ready Model operation is missing its provider result.');
  }
  return Object.freeze({
    action: 'apply_model' as const,
    operation: cloneModelOperation(operation) as StoredModelOperationV1 & {
      readonly phase: 'result_ready';
    },
    messages: Object.freeze([...decodeProtocolContext(codec, result.value)]),
  });
}

function modelOutcomeUnknownError(): Readonly<{
  readonly code: 'INTERNAL_ERROR';
  readonly message: string;
  readonly retryable: false;
  readonly causeCode: 'MODEL_OUTCOME_UNKNOWN';
  readonly outcomeUnknown: true;
}> {
  return Object.freeze({
    code: 'INTERNAL_ERROR' as const,
    message: 'The provider request outcome could not be confirmed.',
    retryable: false as const,
    causeCode: 'MODEL_OUTCOME_UNKNOWN' as const,
    outcomeUnknown: true as const,
  });
}

function compactRecovery(
  transaction: DurableCompactTransaction | undefined,
): AgentRunCheckpointRecovery {
  if (transaction === undefined) return Object.freeze({ action: 'continue' as const });
  const action: CompactTransactionRecoveryAction = getCompactTransactionRecoveryAction(transaction);
  if (action === 'execute') {
    return Object.freeze({
      action: 'execute_compact' as const,
      transaction: transaction as DurableCompactTransaction & { readonly phase: 'prepared' },
    });
  }
  if (action === 'apply') {
    return Object.freeze({
      action: 'apply_compact' as const,
      transaction: transaction as DurableCompactTransaction & { readonly phase: 'result_ready' },
    });
  }
  if (action === 'fail_outcome_unknown') {
    return Object.freeze({
      action: 'fail_outcome_unknown' as const,
      error: Object.freeze({
        code: 'INTERNAL_ERROR' as const,
        message: 'The compact operation outcome could not be confirmed.',
        retryable: false as const,
        causeCode: 'COMPACT_OUTCOME_UNKNOWN' as const,
        outcomeUnknown: true as const,
      }),
    });
  }
  return Object.freeze({ action: 'continue' as const });
}

function assertStoredModelOperation<P extends AgentProtocol>(
  operation: StoredModelOperationV1,
  codec: AgentProtocolCheckpointCodec<P>,
): void {
  if (operation.version !== '1') {
    throw checkpointMismatch('The Model operation version is unsupported.');
  }
  assertNonEmpty(operation.operationId, 'model operationId');
  assertNonNegativeInteger(operation.iteration, 'model operation iteration');
  assertModelPurpose(operation.purpose);
  if (
    operation.phase !== 'prepared' &&
    operation.phase !== 'in_flight' &&
    operation.phase !== 'result_ready'
  ) {
    throw checkpointMismatch('The Model operation phase is unsupported.');
  }
  assertSha256(operation.requestHash, 'model operation requestHash');
  assertTimestamp(operation.preparedAt, 'model operation preparedAt');
  assertTimestamp(operation.updatedAt, 'model operation updatedAt');
  if (operation.updatedAt < operation.preparedAt) {
    throw checkpointMismatch('The Model operation timestamps are invalid.');
  }
  if (operation.phase === 'result_ready') {
    if (
      operation.result === undefined ||
      operation.result.protocol !== codec.protocol ||
      operation.result.codecVersion !== codec.version
    ) {
      throw checkpointMismatch('The Model operation result codec is incompatible.');
    }
    // Decode before accepting the result as a replayable provider response.
    decodeProtocolContext(codec, operation.result.value);
  } else if (operation.result !== undefined) {
    throw checkpointMismatch('Only a result-ready Model operation may retain a provider result.');
  }
}

function assertOpenModelOperation(
  run: DurableStoredAgentRun,
  operationId: string,
  phase: StoredModelOperationV1['phase'],
): StoredModelOperationV1 {
  assertNonEmpty(operationId, 'model operationId');
  const operation = run.modelOperation;
  if (
    operation === undefined ||
    operation.operationId !== operationId ||
    operation.phase !== phase
  ) {
    throw invalidState(`The root Agent Model operation is not in the required ${phase} phase.`);
  }
  return operation;
}

function cloneModelOperation(operation: StoredModelOperationV1): StoredModelOperationV1 {
  return Object.freeze(structuredClone(operation));
}

function encodeProtocolContext<P extends AgentProtocol>(
  codec: AgentProtocolCheckpointCodec<P>,
  context: readonly ContextOf<P>[],
): DurableStoredAgentRun['protocolContext'] {
  const value = codec.encode(context);
  // Canonicalization both validates JSON-safety and detaches the persisted value.
  return Object.freeze({
    protocol: codec.protocol,
    codecVersion: codec.version,
    value: JSON.parse(canonicalizeJson(value)) as JsonValue,
  });
}

function decodeProtocolContext<P extends AgentProtocol>(
  codec: AgentProtocolCheckpointCodec<P>,
  value: JsonValue,
): readonly ContextOf<P>[] {
  let decoded: readonly ContextOf<P>[];
  try {
    decoded = codec.decode(JSON.parse(canonicalizeJson(value)) as JsonValue);
  } catch (error) {
    throw new SubAgentRuntimeError(
      {
        code: 'CHECKPOINT_VERSION_MISMATCH',
        message: 'The protocol checkpoint codec could not decode persisted context.',
        retryable: false,
      },
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  if (!Array.isArray(decoded)) {
    throw checkpointMismatch('The protocol checkpoint codec did not return a context array.');
  }
  return decoded;
}

function assertRunStatusTransition(
  current: StoredAgentRunStatus,
  next: StoredAgentRunStatus,
): void {
  if (current === next) return;
  if (current === 'succeeded' || current === 'cancelled' || current === 'failed') {
    throw invalidState('A terminal root Agent run is immutable.');
  }
  if (current === 'waiting_approval' && next === 'succeeded') {
    throw invalidState('A waiting root Agent run must resume running before succeeding.');
  }
}

interface StagedCancelledDescendantTasks {
  readonly mutations: readonly RuntimeTaskMutation[];
  readonly cancelledTaskIds: readonly string[];
  readonly activeCancelled: number;
}

function stageCancelledDescendantTasks(input: {
  readonly tasks: readonly StoredTask[];
  readonly operationRoot: string;
  readonly payload: JsonValue;
  readonly reason?: string;
  readonly now: number;
  readonly fencingToken: string;
}): StagedCancelledDescendantTasks {
  const mutations: RuntimeTaskMutation[] = [];
  const cancelledTaskIds: string[] = [];
  let activeCancelled = 0;
  const payloadHash = canonicalJsonSha256(input.payload);

  for (const task of input.tasks) {
    if (isTerminalSubAgentTaskState(task.state)) continue;
    const operationId = `${input.operationRoot}:${task.taskId}`;
    const existing = task.controlOperations.find(
      (operation) => operation.operationId === operationId,
    );
    if (existing !== undefined) {
      if (existing.kind !== 'cancel' || existing.payloadHash !== payloadHash) {
        throw new SubAgentRuntimeError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The cancellation operation ID is already bound to a different payload.',
          retryable: false,
        });
      }
      continue;
    }
    if (task.controlOperations.length >= 4_096) {
      throw new SubAgentRuntimeError({
        code: 'LIMIT_EXCEEDED',
        message: 'The task has too many persisted control operation receipts.',
        retryable: false,
      });
    }

    const descriptor: SubAgentErrorDescriptor = Object.freeze({
      code: 'CANCELLED',
      message: input.reason?.trim()
        ? 'The subagent task was cancelled by the host.'
        : 'The subagent task was cancelled.',
      retryable: false,
    });
    const cancelled = transitionSubAgentTask(task, 'cancelled', {
      now: input.now,
      error: descriptor,
    });
    const settled = settleStoredExecutorOperation(cancelled as StoredTask, input.now);
    const withEvent = appendSafeTaskEvents(
      { ...settled, fencingToken: input.fencingToken } as StoredTask,
      [{ type: 'task.cancelled', timestamp: input.now, data: { status: 'cancelled' } }],
      {
        eventIds: [`event-${randomUUID()}`],
        defaultTimestamp: input.now,
        revisionMode: 'preserve',
      },
    );
    const receipt: StoredTaskControlOperation = Object.freeze({
      operationId,
      kind: 'cancel',
      payloadHash,
      completedAt: input.now,
    });
    const next: StoredTask = Object.freeze({
      ...withEvent.task,
      controlOperations: Object.freeze([...withEvent.task.controlOperations, receipt]),
      fencingToken: input.fencingToken,
      updatedAt: input.now,
    });
    mutations.push(Object.freeze({ previous: task, next, events: withEvent.events }));
    cancelledTaskIds.push(task.taskId);
    if (task.activeStartedAt !== undefined) activeCancelled += 1;
  }

  return Object.freeze({
    mutations: Object.freeze(mutations),
    cancelledTaskIds: Object.freeze(cancelledTaskIds),
    activeCancelled,
  });
}

function settleStoredExecutorOperation(task: StoredTask, now: number): StoredTask {
  if (task.executorOperation === undefined || task.executorOperation.status === 'settled') {
    return task;
  }
  return Object.freeze({
    ...task,
    executorOperation: Object.freeze({
      ...task.executorOperation,
      status: 'settled' as const,
      updatedAt: now,
    }),
  });
}

function cloneCheckpointJson(value: unknown): JsonValue {
  assertJsonValue(value);
  return parseJsonValue(canonicalizeJson(value));
}

function assertPendingBatch(batch: StoredPendingToolBatch): void {
  assertNonEmpty(batch.batchId, 'pendingBatch.batchId');
  assertNonNegativeInteger(batch.iteration, 'pendingBatch.iteration');
  assertTimestamp(batch.createdAt, 'pendingBatch.createdAt');
  const orders = new Set<number>();
  const ids = new Set<string>();
  const operationIds = new Set<string>();
  for (const call of batch.calls) {
    assertNonEmpty(call.operationId, 'pendingBatch.operationId');
    assertNonEmpty(call.callId, 'pendingBatch.callId');
    assertNonEmpty(call.name, 'pendingBatch.name');
    assertNonNegativeInteger(call.order, 'pendingBatch.order');
    if (orders.has(call.order) || ids.has(call.callId) || operationIds.has(call.operationId)) {
      throw checkpointMismatch('The pending Tool batch contains duplicate identity or order.');
    }
    if (!/^[a-f0-9]{64}$/.test(call.inputHash)) {
      throw checkpointMismatch('The pending Tool call inputHash must be lowercase SHA-256.');
    }
    try {
      if (canonicalJsonSha256(call.input) !== call.inputHash) {
        throw checkpointMismatch('The pending Tool call input does not match its durable hash.');
      }
    } catch (error) {
      if (error instanceof SubAgentRuntimeError) throw error;
      throw checkpointMismatch('The pending Tool call input must be JSON-safe.');
    }
    if (call.kind !== 'tool' && call.kind !== 'agent' && call.kind !== 'end-agent') {
      throw checkpointMismatch('The pending Tool batch contains an invalid call kind.');
    }
    if (
      call.status !== 'pending' &&
      call.status !== 'running' &&
      call.status !== 'paused' &&
      call.status !== 'settled' &&
      call.status !== 'result_submitted' &&
      call.status !== 'applied'
    ) {
      throw checkpointMismatch('The pending Tool batch contains an invalid call phase.');
    }
    const resultReady =
      call.status === 'settled' || call.status === 'result_submitted' || call.status === 'applied';
    if (resultReady !== (call.output !== undefined)) {
      throw checkpointMismatch('The pending Tool call result does not match its durable phase.');
    }
    if (!resultReady && call.error !== undefined) {
      throw checkpointMismatch('An unresolved pending Tool call cannot retain a result error.');
    }
    if (call.taskId !== undefined) assertNonEmpty(call.taskId, 'pendingBatch.taskId');
    const approvalIds = call.approvalIds ?? [];
    if (
      approvalIds.some((approvalId) => approvalId.trim().length === 0) ||
      new Set(approvalIds).size !== approvalIds.length
    ) {
      throw checkpointMismatch('The pending Tool call contains invalid approval IDs.');
    }
    orders.add(call.order);
    ids.add(call.callId);
    operationIds.add(call.operationId);
  }
  for (let order = 0; order < batch.calls.length; order += 1) {
    if (!orders.has(order)) {
      throw checkpointMismatch('The pending Tool batch provider order is not contiguous.');
    }
  }
  assertPendingBatchInvariants(
    {
      calls: Object.freeze(
        batch.calls.map((call) =>
          Object.freeze({
            kind: call.kind,
            name: call.name,
            status:
              call.status === 'pending'
                ? ('prepared' as const)
                : call.status === 'running'
                  ? ('in_flight' as const)
                  : call.status === 'paused'
                    ? ('waiting_approval' as const)
                    : call.status === 'settled'
                      ? ('result_ready' as const)
                      : call.status,
            order: call.order,
            ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
            approvalIds: Object.freeze([...(call.approvalIds ?? [])]),
            ...(call.output === undefined ? {} : { result: call.output }),
            ...(call.error === undefined ? {} : { error: call.error }),
          }),
        ),
      ),
      endRequested: batch.endRequested,
      requireResultSubmissionForEnd: false,
      requireRejectedEndErrorDescriptor: true,
    },
    (message): never => {
      throw checkpointMismatch(message);
    },
  );
}

function assertPendingApprovalRequests(
  approvals: readonly ApprovalRequest[],
  ownerSessionId: string,
): ReadonlySet<string> {
  if (!Array.isArray(approvals)) {
    throw checkpointMismatch('The root Agent pending approvals must be an array.');
  }
  const ids = new Set<string>();
  for (const approval of approvals) {
    assertNonEmpty(approval.approvalId, 'pendingApproval.approvalId');
    assertNonEmpty(approval.ownerSessionId, 'pendingApproval.ownerSessionId');
    assertNonEmpty(approval.taskId, 'pendingApproval.taskId');
    assertNonEmpty(approval.callId, 'pendingApproval.callId');
    assertNonEmpty(approval.toolName, 'pendingApproval.toolName');
    assertNonEmpty(approval.summary, 'pendingApproval.summary');
    assertTimestamp(approval.createdAt, 'pendingApproval.createdAt');
    assertNonNegativeInteger(approval.revision, 'pendingApproval.revision');
    if (approval.expiresAt !== undefined) {
      assertTimestamp(approval.expiresAt, 'pendingApproval.expiresAt');
    }
    if (approval.ownerSessionId !== ownerSessionId || ids.has(approval.approvalId)) {
      throw checkpointMismatch('The root Agent pending approvals contain invalid identity.');
    }
    ids.add(approval.approvalId);
  }
  return ids;
}

function clonePendingBatch(batch: StoredPendingToolBatch): StoredPendingToolBatch {
  return Object.freeze(structuredClone(batch));
}

function cloneCompactTransaction(
  transaction: DurableCompactTransaction,
): DurableCompactTransaction {
  return Object.freeze(structuredClone(transaction));
}

function cloneDurableRecord(record: DurableStoredAgentRun): DurableStoredAgentRun {
  return Object.freeze(structuredClone(record));
}

function createRunLeaseKey(ownerSessionId: string, runId: string): string {
  return `agent-run:${canonicalizeJson([ownerSessionId, runId])}`;
}

function rootLeaseLostError(cause?: unknown): SubAgentRuntimeError {
  return new SubAgentRuntimeError(
    {
      code: 'RECOVERY_TARGET_LOST',
      message: 'The root Agent execution lease was lost.',
      retryable: true,
      causeCode: 'ROOT_EXECUTION_LEASE_LOST',
    },
    cause instanceof Error ? { cause } : undefined,
  );
}

function throwAbortReason(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  throw new SubAgentRuntimeError({
    code: 'CANCELLED',
    message: 'The root Agent execution was cancelled.',
    retryable: false,
  });
}

function assertCheckpointCodec<P extends AgentProtocol>(
  codec: AgentProtocolCheckpointCodec<P>,
): void {
  if (
    typeof codec !== 'object' ||
    codec === null ||
    typeof codec.protocol !== 'string' ||
    codec.protocol.length === 0 ||
    typeof codec.version !== 'string' ||
    codec.version.length === 0 ||
    typeof codec.encode !== 'function' ||
    typeof codec.decode !== 'function'
  ) {
    throw new TypeError('Agent run checkpoints require a valid protocol codec.');
  }
}

function assertOptionalMaxIterations(value: number | undefined): void {
  if (value !== undefined) assertPositiveInteger(value, 'maxIterations');
}

function assertNullableMaxIterations(value: number | null): void {
  if (value !== null) assertPositiveInteger(value, 'maxIterations');
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

function assertTimestamp(value: number, label: string): void {
  assertNonNegativeInteger(value, label);
}

function assertModelPurpose(value: StoredModelOperationPurpose): void {
  if (value !== 'agent' && value !== 'context-summary') {
    throw new TypeError('model operation purpose must be agent or context-summary.');
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string.`);
  }
}

function checkpointMismatch(message: string): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'CHECKPOINT_VERSION_MISMATCH',
    message,
    retryable: false,
  });
}

function checkpointMigrationFailed(message: string, cause?: unknown): SubAgentRuntimeError {
  return new SubAgentRuntimeError(
    {
      code: 'CHECKPOINT_MIGRATION_FAILED',
      message,
      retryable: false,
    },
    cause instanceof Error ? { cause } : undefined,
  );
}

function invalidState(message: string): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'INVALID_STATE_TRANSITION',
    message,
    retryable: false,
  });
}

function isStateCasConflict(error: unknown): boolean {
  return (
    error instanceof SubAgentRuntimeError &&
    error.code === 'INVALID_STATE_TRANSITION' &&
    error.descriptor.causeCode === 'STATE_CAS_CONFLICT'
  );
}
