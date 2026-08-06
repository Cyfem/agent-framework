import { randomUUID } from 'node:crypto';

import type { AgentCheckpointMigrator, AgentProtocolCheckpointCodec } from '../subagent/checkpoint';
import { createResourceNotFoundError, SubAgentRuntimeError } from '../subagent/errors';
import {
  assertJsonValue,
  canonicalizeJson,
  parseJsonValue,
  type JsonValue,
} from '../subagent/json';
import type { TreeBudgetSnapshot } from '../subagent/limits';
import { commitRuntimeStateMutation, type RuntimeTaskMutation } from '../subagent/state-controller';
import type {
  AgentRuntimeStateStore,
  StateLease,
  StoredAgentRun,
  StoredAgentRunStatus,
  StoredPendingToolBatch,
} from '../subagent/state-store';
import type { ApprovalRequest } from '../subagent/approval';
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

export type AgentRunCheckpointRecovery =
  | { readonly action: 'continue' }
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
  readonly recovery: AgentRunCheckpointRecovery;
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
  readonly maxIterations?: number;
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
    readonly parentSignal: AbortSignal;
    readonly ttlMs: number;
  }) {
    this.#controllerIdentity = input.controllerIdentity;
    this.ownerSessionId = input.ownerSessionId;
    this.runId = input.runId;
    this.key = input.lease.key;
    this.fencingToken = input.lease.fencingToken;
    this.#current = input.lease;
    this.#ttlMs = input.ttlMs;
    this.signal = AbortSignal.any([
      input.parentSignal,
      this.#lost.signal,
      this.#releasedSignal.signal,
    ]);
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
      return work(this.#current);
    });
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
      parentSignal,
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
    if (!migrated.changed) return this.#restoreRecord(original);

    let committed!: DurableStoredAgentRun;
    let restored!: RestoredAgentRunCheckpoint<P>;
    await lease.use(this.#leaseIdentity, this.ownerSessionId, runId, async (stateLease) => {
      const observedNow = this.#now();
      assertTimestamp(observedNow, 'now');
      committed = Object.freeze({
        ...migrated.record,
        ownerSessionId: original.ownerSessionId,
        runId: original.runId,
        recordVersion: original.recordVersion,
        revision: original.revision + 1,
        fencingToken: stateLease.fencingToken,
        createdAt: original.createdAt,
        updatedAt: Math.max(observedNow, original.updatedAt),
      });
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
      const current = await this.#stateStore.loadRun(this.ownerSessionId, input.runId);
      if (current === undefined) throw createResourceNotFoundError();
      this.#validateRecord(current);
      next = this.#buildNextRecord(current, input, prepared, stateLease.fencingToken);
      await commitRuntimeStateMutation(this.#stateStore, this.ownerSessionId, stateLease, {
        run: { previous: current, next },
        tasks,
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
      recovery: compactRecovery(record.compactTransaction),
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
    if (record.pendingBatch !== undefined) {
      assertPendingBatch(record.pendingBatch);
      if (record.pendingBatch.iteration !== record.modelIteration) {
        throw checkpointMismatch('The pending Tool batch iteration is inconsistent.');
      }
    }
    if (record.status === 'waiting_approval') {
      if (record.pendingBatch === undefined || record.pendingApprovals.length === 0) {
        throw checkpointMismatch(
          'A waiting root Agent run requires a pending batch and approvals.',
        );
      }
    } else if (
      (record.status === 'succeeded' ||
        record.status === 'cancelled' ||
        record.status === 'failed') &&
      record.pendingBatch !== undefined
    ) {
      throw checkpointMismatch('A terminal root Agent run cannot retain a pending Tool batch.');
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
  const decoded = codec.decode(JSON.parse(canonicalizeJson(value)) as JsonValue);
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

function assertPendingBatch(batch: StoredPendingToolBatch): void {
  assertNonEmpty(batch.batchId, 'pendingBatch.batchId');
  assertNonNegativeInteger(batch.iteration, 'pendingBatch.iteration');
  assertTimestamp(batch.createdAt, 'pendingBatch.createdAt');
  const orders = new Set<number>();
  const ids = new Set<string>();
  for (const call of batch.calls) {
    assertNonEmpty(call.callId, 'pendingBatch.callId');
    assertNonEmpty(call.name, 'pendingBatch.name');
    assertNonNegativeInteger(call.order, 'pendingBatch.order');
    if (orders.has(call.order) || ids.has(call.callId)) {
      throw checkpointMismatch('The pending Tool batch contains duplicate identity or order.');
    }
    if (call.kind !== 'tool' && call.kind !== 'agent' && call.kind !== 'end-agent') {
      throw checkpointMismatch('The pending Tool batch contains an invalid call kind.');
    }
    if (
      call.status !== 'pending' &&
      call.status !== 'running' &&
      call.status !== 'paused' &&
      call.status !== 'settled' &&
      call.status !== 'applied'
    ) {
      throw checkpointMismatch('The pending Tool batch contains an invalid call phase.');
    }
    const resultReady = call.status === 'settled' || call.status === 'applied';
    if (resultReady !== (call.output !== undefined)) {
      throw checkpointMismatch('The pending Tool call result does not match its durable phase.');
    }
    if (!resultReady && call.error !== undefined) {
      throw checkpointMismatch('An unresolved pending Tool call cannot retain a result error.');
    }
    if (call.status === 'paused' && call.kind !== 'agent') {
      throw checkpointMismatch('Only an agent Tool call can be paused.');
    }
    if (
      call.kind === 'agent' &&
      (call.status === 'running' || call.status === 'paused') &&
      call.taskId === undefined
    ) {
      throw checkpointMismatch('An active agent Tool call requires a taskId.');
    }
    orders.add(call.order);
    ids.add(call.callId);
  }
  for (let order = 0; order < batch.calls.length; order += 1) {
    if (!orders.has(order)) {
      throw checkpointMismatch('The pending Tool batch provider order is not contiguous.');
    }
  }
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
