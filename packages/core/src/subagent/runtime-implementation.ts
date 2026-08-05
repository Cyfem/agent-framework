import { isDeepStrictEqual } from 'node:util';

import type { ApprovalDecision, ApprovalDirective, ApprovalRequestInput } from './approval';
import {
  BUILTIN_AGENT_PROTOCOL_CHECKPOINT_CODECS,
  type AgentCheckpointMigrator,
  type AgentProtocolCheckpointCodec,
} from './checkpoint';
import type { ExecutorCatalogSnapshot, SubAgentCatalogEntry } from './catalog';
import type {
  SubAgentContextItem,
  SubAgentDefinition,
  SubAgentDefinitionRegistration,
} from './definition';
import { defineSubAgent } from './definition';
import { SubAgentDefinitionRegistry } from './definition-registry';
import {
  createResourceNotFoundError,
  SUBAGENT_ERROR_CODES,
  SubAgentRuntimeError,
  type SubAgentErrorDescriptor,
} from './errors';
import type {
  ExecutorTaskHandle,
  SubAgentExecutionControl,
  SubAgentExecutionRequest,
  SubAgentExecutorBinding,
  SubAgentExecutorOperation,
} from './executor';
import { SubAgentExecutorRegistry, type SubAgentExecutionTarget } from './executor-registry';
import { assertJsonValue, canonicalJsonSha256, type JsonValue } from './json';
import {
  DEFAULT_SUBAGENT_IO_LIMITS,
  resolveSubAgentLimits,
  type ResolvedSubAgentLimits,
} from './limits';
import type { SubAgentExecutionOutcome, SubAgentProgress, SubAgentUsageDelta } from './result';
import {
  assertRuntimeReady,
  assertRuntimeSession,
  cloneJsonValue,
  createOperationSignal,
  createRuntimeId,
  createSubAgentError,
  DEFAULT_RUNTIME_EVENT_POLL_MS,
  normalizeProjectedContext,
  raceWithOperationSignal,
  safeExecutorError,
  taskOutcome,
  throwIfOperationAborted,
  waitForRuntimeRetry,
  withRuntimeLease,
} from './runtime-support';
import type {
  ChildDelegationRequest,
  ModelSubAgentRequest,
  SubAgentDelegationClient,
  SubAgentDispatchContext,
  SubAgentExecuteRequest,
  SubAgentRuntime,
  SubAgentRuntimeOptions,
  SubAgentTaskHandle,
} from './runtime';
import { commitRuntimeStateMutation } from './state-controller';
import {
  appendSafeTaskEvents,
  completeSubAgentTask,
  decideApproval,
  reserveTreeBudget,
  submitSubAgentResult,
  transitionSubAgentTask,
} from './state-machine';
import type { AgentRuntimeStateStore, StateLease, StoredAgentRun, StoredTask } from './state-store';
import type { SubAgentSessionSnapshot, SubAgentTaskSnapshot } from './identity';
import {
  NOOP_AGENT_TELEMETRY_SINK,
  type AgentTelemetrySink,
  type ExecutorEventInput,
  type SubAgentTaskEvent,
} from './telemetry';

interface PreparedCreate {
  readonly request: SubAgentExecuteRequest;
  readonly definition: SubAgentDefinition;
  readonly input: JsonValue;
  readonly inputHash: string;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

interface CreatedTask {
  readonly status: 'created' | 'existing';
  readonly task: StoredTask;
}

interface ActiveExecution {
  readonly promise: Promise<SubAgentExecutionOutcome>;
  readonly controller: AbortController;
  rawHandle?: ExecutorTaskHandle;
}

interface StartResult {
  readonly task: StoredTask;
  readonly run: StoredAgentRun;
  readonly outcome?: SubAgentExecutionOutcome;
}

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'cancelled', 'failed']);

/** Synchronously construct a Runtime; asynchronous probing and codec checks happen in init(). */
export function createSubAgentRuntime(options: SubAgentRuntimeOptions): SubAgentRuntime {
  return new DefaultSubAgentRuntime(options);
}

class DefaultSubAgentRuntime implements SubAgentRuntime {
  readonly sessionId: string;
  readonly stateStore: AgentRuntimeStateStore;
  readonly #definitions: SubAgentDefinitionRegistry;
  readonly #executors: SubAgentExecutorRegistry;
  readonly #limits: Readonly<ResolvedSubAgentLimits>;
  readonly #telemetry: AgentTelemetrySink;
  readonly #checkpointCodecs: readonly AgentProtocolCheckpointCodec[];
  readonly #migrators: readonly AgentCheckpointMigrator[];
  readonly #active = new Map<string, ActiveExecution>();
  #ready = false;
  #initPromise: Promise<void> | undefined;

  constructor(options: SubAgentRuntimeOptions) {
    assertSessionId(options.sessionId);
    if (
      typeof options.stateStore !== 'object' ||
      options.stateStore === null ||
      typeof options.stateStore.transactionDomainId !== 'string' ||
      options.stateStore.transactionDomainId.length === 0
    ) {
      throw new TypeError('SubAgentRuntime requires a valid AgentRuntimeStateStore.');
    }

    this.sessionId = options.sessionId;
    this.stateStore = options.stateStore;
    this.#limits = resolveSubAgentLimits(options.limits);
    this.#telemetry = options.telemetrySink ?? NOOP_AGENT_TELEMETRY_SINK;
    this.#checkpointCodecs = Object.freeze([
      ...BUILTIN_AGENT_PROTOCOL_CHECKPOINT_CODECS,
      ...(options.protocolCheckpointCodecs ?? []),
    ]);
    this.#migrators = Object.freeze([...(options.checkpointMigrators ?? [])]);

    const activeDefinitions = options.activeDefinitions.map(normalizeRuntimeDefinition);
    const recoveryDefinitions = (options.recoveryDefinitions ?? []).map(normalizeRuntimeDefinition);
    this.#definitions = new SubAgentDefinitionRegistry({
      activeDefinitions,
      recoveryDefinitions,
    });
    this.#executors = new SubAgentExecutorRegistry({
      definitions: this.#definitions,
      executors: options.executors,
      ...(options.catalogPolicy === undefined ? {} : { catalogPolicy: options.catalogPolicy }),
    });
  }

  get ready(): boolean {
    return this.#ready;
  }

  init(): Promise<void> {
    if (this.#ready) return Promise.resolve();
    if (this.#initPromise !== undefined) return this.#initPromise;

    this.#initPromise = (async () => {
      validateCheckpointConfiguration(this.#checkpointCodecs, this.#migrators);
      await this.#executors.init();
      this.#ready = true;
    })().catch((error: unknown) => {
      this.#initPromise = undefined;
      throw error;
    });
    return this.#initPromise;
  }

  getCatalog(): ExecutorCatalogSnapshot {
    assertRuntimeReady(this.#ready);
    return this.#executors.getCatalog();
  }

  getCatalogEntries(): readonly SubAgentCatalogEntry[] {
    assertRuntimeReady(this.#ready);
    return this.#executors.getCatalogEntries();
  }

  async refreshCatalog(): Promise<ExecutorCatalogSnapshot> {
    assertRuntimeReady(this.#ready);
    return this.#executors.refreshCatalog();
  }

  async dispatchTool(
    request: ModelSubAgentRequest,
    context: SubAgentDispatchContext,
  ): Promise<SubAgentExecutionOutcome> {
    assertRuntimeSession(context.ownerSessionId, this.sessionId);
    return this.execute({
      ...request,
      runId: context.runId,
      requestId: context.requestId,
      ...(context.parentTaskId === undefined ? {} : { parentTaskId: context.parentTaskId }),
      parentContext: context.parentContext,
      parentRawHistory: context.parentRawHistory,
      ...(context.stream === undefined ? {} : { stream: context.stream }),
      signal: context.signal,
      ...(context.deadlineAt === undefined ? {} : { deadlineAt: context.deadlineAt }),
    });
  }

  async execute(request: SubAgentExecuteRequest): Promise<SubAgentExecutionOutcome> {
    const dispatched = await this.#createAndDispatch(request, 'execute');
    if ('wait' in dispatched) return dispatched.wait;
    return dispatched.handle.wait();
  }

  async spawn(request: SubAgentExecuteRequest): Promise<SubAgentTaskHandle> {
    const dispatched = await this.#createAndDispatch(request, 'spawn');
    if ('wait' in dispatched) return this.#createHandle(dispatched.task.taskId);
    return dispatched.handle;
  }

  async #createAndDispatch(
    request: SubAgentExecuteRequest,
    mode: 'execute' | 'spawn',
  ): Promise<
    | { readonly handle: SubAgentTaskHandle; readonly task: StoredTask }
    | { readonly wait: SubAgentExecutionOutcome; readonly task: StoredTask }
  > {
    if (request.stream === true) {
      throw createSubAgentError(
        'STREAMING_UNSUPPORTED',
        'Subagent v2 does not support streaming execution.',
      );
    }
    assertRuntimeReady(this.#ready);
    const prepared = this.#prepareCreate(request);

    const replay = await this.stateStore.findTaskByIdempotencyKey(
      this.sessionId,
      request.runId,
      request.requestId,
    );
    if (replay !== undefined) {
      this.#assertIdempotentReplay(replay, prepared);
      return this.#dispatchIdempotentTask(replay, mode, prepared.signal, prepared.deadlineAt);
    }

    const target = this.#executors.select(request);
    if (mode === 'spawn' && !target.descriptor.capabilities.spawn) {
      throw createSubAgentError(
        'UNSUPPORTED_CAPABILITY',
        'The selected Executor does not support background spawn.',
      );
    }
    throwIfOperationAborted(prepared.signal, prepared.deadlineAt);

    const parent = await this.#loadAndValidateParent(prepared);
    this.#validateRetry(prepared, parent);
    const projectedContext = await this.#projectContext(prepared, parent);
    const created = await this.#persistCreatedTask(prepared, target, parent, projectedContext);
    this.#assertIdempotentReplay(created.task, prepared);

    const existingOutcome = taskOutcome(created.task);
    if (existingOutcome !== undefined) return { wait: existingOutcome, task: created.task };
    if (created.status === 'existing') {
      return this.#dispatchIdempotentTask(created.task, mode, prepared.signal, prepared.deadlineAt);
    }

    if (!this.#active.has(created.task.taskId)) {
      this.#startExecution(created.task, target, mode, prepared.signal, prepared.deadlineAt);
    }
    return { handle: this.#createHandle(created.task.taskId), task: created.task };
  }

  async #dispatchIdempotentTask(
    task: StoredTask,
    mode: 'execute' | 'spawn',
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<
    | { readonly handle: SubAgentTaskHandle; readonly task: StoredTask }
    | { readonly wait: SubAgentExecutionOutcome; readonly task: StoredTask }
  > {
    const outcome = taskOutcome(task);
    if (outcome !== undefined) return { wait: outcome, task };
    if (this.#active.has(task.taskId)) {
      return { handle: this.#createHandle(task.taskId), task };
    }
    const target = this.#executors.selectRecovery(task.definition, task.executor);
    if (mode === 'spawn' && !target.descriptor.capabilities.spawn) {
      throw createSubAgentError(
        'UNSUPPORTED_CAPABILITY',
        'The selected Executor does not support background spawn.',
      );
    }
    if (task.state === 'queued') {
      this.#startExecution(task, target, mode, signal, deadlineAt);
      return { handle: this.#createHandle(task.taskId), task };
    }
    if (task.state === 'running' && task.binding === undefined) {
      let replay: StoredTask;
      try {
        replay = await this.#prepareUnboundCreateReplay(task.taskId, signal, deadlineAt);
      } catch (error) {
        if (error instanceof SubAgentRuntimeError && error.code === 'TIMED_OUT') {
          const timedOut = await this.#finalizeExecutionError(
            task.taskId,
            task.attempt,
            error,
            true,
          );
          return { wait: timedOut, task: await this.#loadTask(task.taskId) };
        }
        throw error;
      }
      this.#startReplayedCreateExecution(replay, target, mode, signal, deadlineAt);
      return { handle: this.#createHandle(replay.taskId), task: replay };
    }
    throw createSubAgentError(
      'RECOVERY_UNSUPPORTED',
      'The idempotent task requires explicit resume or reconnect.',
    );
  }

  #prepareCreate(request: SubAgentExecuteRequest): PreparedCreate {
    assertNonEmpty(request.runId, 'runId');
    assertNonEmpty(request.requestId, 'requestId');
    assertNonEmpty(request.subAgent, 'subAgent');
    assertNonEmpty(request.executor, 'executor');
    const definition = this.#definitions.getActive(request.subAgent);
    if (definition === undefined) {
      throw createSubAgentError(
        'DEFINITION_NOT_FOUND',
        'The selected subagent definition is unavailable.',
      );
    }

    const result = definition.inputSchema.safeParse(request.input);
    if (!result.success) {
      throw createSubAgentError('INVALID_INPUT', 'The subagent input failed schema validation.');
    }
    const parsed: unknown = result.data;
    try {
      assertJsonValue(parsed, {
        maxBytes: DEFAULT_SUBAGENT_IO_LIMITS.maxInputBytes,
        label: 'Subagent input',
      });
    } catch {
      throw createSubAgentError(
        'INVALID_INPUT',
        'The subagent input is not JSON-safe or exceeds the input byte limit.',
      );
    }
    const input = cloneJsonValue(parsed as JsonValue);
    const now = Date.now();
    const requestedDeadline = request.deadlineAt ?? now + this.#limits.timeoutMs;
    const deadlineAt = Math.min(requestedDeadline, now + this.#limits.timeoutMs);
    const signal = createOperationSignal({
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      deadlineAt,
    });
    throwIfOperationAborted(signal, deadlineAt);

    return {
      request,
      definition,
      input,
      inputHash: canonicalJsonSha256(input),
      deadlineAt,
      signal,
    };
  }

  #assertIdempotentReplay(task: StoredTask, prepared: PreparedCreate): void {
    const request = prepared.request;
    const same =
      task.ownerSessionId === this.sessionId &&
      task.runId === request.runId &&
      task.requestId === request.requestId &&
      task.definition.name === prepared.definition.name &&
      task.definition.version === prepared.definition.version &&
      task.executor === request.executor &&
      task.inputHash === prepared.inputHash &&
      task.parentTaskId === request.parentTaskId &&
      task.retryOf === request.retryOf;
    if (!same) {
      throw createSubAgentError(
        'IDEMPOTENCY_CONFLICT',
        'The request ID is already bound to a different subagent task.',
      );
    }
  }

  async #loadAndValidateParent(prepared: PreparedCreate): Promise<StoredTask | undefined> {
    const parentTaskId = prepared.request.parentTaskId;
    if (parentTaskId === undefined) return undefined;
    const parent = await this.stateStore.loadTask(this.sessionId, parentTaskId);
    if (parent === undefined || parent.runId !== prepared.request.runId) {
      throw createResourceNotFoundError();
    }

    const parentDefinition = this.#definitions.getExact(parent.definition);
    if (parentDefinition === undefined) {
      throw createSubAgentError(
        'DEFINITION_VERSION_MISMATCH',
        'The parent subagent definition version is unavailable.',
      );
    }
    const delegation = parentDefinition.delegation;
    const allowed =
      delegation?.mode === 'allowlist' &&
      delegation.definitions.includes(prepared.definition.name) &&
      (prepared.definition.name !== parentDefinition.name || delegation.allowSelf === true);
    if (!allowed) {
      throw createSubAgentError(
        'CHILD_DEFINITION_DISALLOWED',
        'The parent task does not allow this child definition.',
      );
    }
    return parent;
  }

  #validateRetry(prepared: PreparedCreate, parent: StoredTask | undefined): void {
    if (prepared.request.retryOf === undefined) return;
    if (parent !== undefined) {
      throw createSubAgentError(
        'INVALID_STATE_TRANSITION',
        'Child delegation cannot create a host retry.',
      );
    }
    // The source is checked asynchronously in #persistCreatedTask immediately before creation.
  }

  async #projectContext(
    prepared: PreparedCreate,
    parent: StoredTask | undefined,
  ): Promise<readonly SubAgentContextItem[]> {
    const projector = prepared.definition.contextProjector;
    if (projector === undefined) return Object.freeze([]);
    try {
      const candidate = await raceWithOperationSignal(
        Promise.resolve(
          projector({
            ownerSessionId: this.sessionId,
            runId: prepared.request.runId,
            ...(parent === undefined ? {} : { parentTaskId: parent.taskId }),
            definition: prepared.definition,
            input: prepared.input,
            parentContext: prepared.request.parentContext ?? [],
            parentRawHistory: prepared.request.parentRawHistory ?? [],
            signal: prepared.signal,
            deadlineAt: prepared.deadlineAt,
          }),
        ),
        prepared.signal,
        prepared.deadlineAt,
      );
      return normalizeProjectedContext(candidate);
    } catch (error) {
      if (error instanceof SubAgentRuntimeError) throw error;
      throw createSubAgentError(
        'CONTEXT_PROJECTION_FAILED',
        'The subagent context projector failed.',
      );
    }
  }

  async #persistCreatedTask(
    prepared: PreparedCreate,
    target: SubAgentExecutionTarget,
    parent: StoredTask | undefined,
    projectedContext: readonly SubAgentContextItem[],
  ): Promise<CreatedTask> {
    throwIfOperationAborted(prepared.signal, prepared.deadlineAt);
    const now = Date.now();
    const remainingMs = Math.max(0, Math.floor(prepared.deadlineAt - now));
    if (remainingMs < 1) throw createSubAgentError('TIMED_OUT', 'The subagent task timed out.');

    const taskId = createRuntimeId('task');
    const subagentSessionId = createRuntimeId('session');
    const path = Object.freeze([...(parent?.path ?? []), taskId]);
    const depth = parent === undefined ? 1 : parent.depth + 1;
    if (depth > this.#limits.maxDepth) {
      throw createSubAgentError('LIMIT_EXCEEDED', 'The subagent task exceeds maxDepth.');
    }

    return withRuntimeLease(
      this.stateStore,
      this.sessionId,
      prepared.signal,
      prepared.deadlineAt,
      async (lease) =>
        this.stateStore.transaction(this.sessionId, lease, async (transaction) => {
          const existing = await transaction.findTaskByIdempotencyKey(
            prepared.request.runId,
            prepared.request.requestId,
          );
          if (existing !== undefined) {
            this.#assertIdempotentReplay(existing, prepared);
            return { status: 'existing' as const, task: existing };
          }

          const run = await transaction.loadRun(prepared.request.runId);
          if (run === undefined) throw createResourceNotFoundError();
          if (TERMINAL_RUN_STATUSES.has(run.status)) {
            throw createSubAgentError(
              'INVALID_STATE_TRANSITION',
              'A terminal root run cannot create another subagent task.',
            );
          }
          if (run.budget.descendantsCreated >= this.#limits.maxDescendants) {
            throw createSubAgentError(
              'LIMIT_EXCEEDED',
              'The subagent tree exceeds maxDescendants.',
            );
          }

          if (parent !== undefined) {
            const currentParent = await transaction.loadTask(parent.taskId);
            if (
              currentParent === undefined ||
              currentParent.runId !== run.runId ||
              !isDeepStrictEqual(currentParent.definition, parent.definition)
            ) {
              throw createResourceNotFoundError();
            }
          }

          if (prepared.request.retryOf !== undefined) {
            const source = await transaction.loadTask(prepared.request.retryOf);
            const sourceResult = source?.result;
            const validRetry =
              source !== undefined &&
              source.runId === run.runId &&
              sourceResult !== undefined &&
              sourceResult.status !== 'succeeded' &&
              source.definition.name === target.definition.name &&
              source.definition.version === target.definition.version;
            if (!validRetry) {
              throw createSubAgentError(
                'INVALID_STATE_TRANSITION',
                'Host retry requires a non-success terminal task with the same definition version.',
              );
            }
          }

          const initial: StoredTask = {
            recordVersion: '1',
            ownerSessionId: this.sessionId,
            runId: run.runId,
            taskId,
            ...(parent === undefined ? {} : { parentTaskId: parent.taskId }),
            subagentSessionId,
            requestId: prepared.request.requestId,
            idempotencyKey: prepared.request.requestId,
            definition: Object.freeze({
              name: target.definition.name,
              version: target.definition.version,
            }),
            executor: target.descriptor.name,
            input: prepared.input,
            inputHash: prepared.inputHash,
            projectedContext,
            state: 'queued',
            revision: 0,
            fencingToken: lease.fencingToken,
            path,
            depth,
            attempt: 1,
            ...(prepared.request.retryOf === undefined
              ? {}
              : { retryOf: prepared.request.retryOf }),
            approvals: Object.freeze([]),
            approvalDecisions: Object.freeze([]),
            recoveryRequired: false,
            activeElapsedMs: 0,
            remainingMs,
            eventSequence: 0,
            createdAt: now,
            updatedAt: now,
          };
          const created = await transaction.createTask(initial);
          if (created.status === 'existing') {
            this.#assertIdempotentReplay(created.task, prepared);
            return created;
          }

          const queued = appendSafeTaskEvents(
            initial,
            [{ type: 'task.queued', timestamp: now, data: { status: 'queued' } }],
            {
              eventIds: [createRuntimeId('event')],
              defaultTimestamp: now,
            },
          );
          const queuedTask = Object.freeze({
            ...queued.task,
            fencingToken: lease.fencingToken,
          }) as StoredTask;
          const nextRun: StoredAgentRun = Object.freeze({
            ...run,
            revision: run.revision + 1,
            fencingToken: lease.fencingToken,
            budget: Object.freeze({
              ...run.budget,
              descendantsCreated: run.budget.descendantsCreated + 1,
            }),
            updatedAt: now,
          });
          const runCommitted = await transaction.compareAndSetRun(
            run.runId,
            run.revision,
            lease.fencingToken,
            nextRun,
          );
          const taskCommitted = await transaction.compareAndSetTask(
            initial.taskId,
            initial.revision,
            lease.fencingToken,
            queuedTask,
          );
          if (!runCommitted || !taskCommitted) {
            throw createSubAgentError(
              'INVALID_STATE_TRANSITION',
              'The task create transaction lost its revision or fencing CAS.',
              { retryable: true, causeCode: 'STATE_CAS_CONFLICT' },
            );
          }
          await transaction.appendEvents(initial.taskId, queued.events);
          return { status: 'created' as const, task: queuedTask };
        }),
    );
  }

  #startExecution(
    task: StoredTask,
    target: SubAgentExecutionTarget,
    mode: 'execute' | 'spawn',
    parentSignal: AbortSignal,
    parentDeadlineAt: number,
  ): void {
    const controller = new AbortController();
    const signal = createOperationSignal({
      signal: parentSignal,
      deadlineAt: Math.min(parentDeadlineAt, task.createdAt + task.remainingMs),
      controller,
    });
    const promise = this.#runCreatedTask(task, target, mode, signal, controller)
      .catch(async (error: unknown) =>
        this.#finalizeExecutionError(task.taskId, task.attempt, error),
      )
      .finally(() => {
        this.#active.delete(task.taskId);
      });
    this.#active.set(task.taskId, { promise, controller });
  }

  #startReplayedCreateExecution(
    task: StoredTask,
    target: SubAgentExecutionTarget,
    mode: 'execute' | 'spawn',
    parentSignal: AbortSignal,
    parentDeadlineAt: number,
  ): void {
    const controller = new AbortController();
    const deadlineAt = Math.min(
      parentDeadlineAt,
      (task.activeStartedAt ?? Date.now()) + task.remainingMs,
    );
    const signal = createOperationSignal({ signal: parentSignal, deadlineAt, controller });
    const promise = this.#executeCreateOperation(task, target, mode, signal, deadlineAt)
      .catch(async (error: unknown) =>
        this.#finalizeExecutionError(task.taskId, task.attempt, error, true),
      )
      .finally(() => this.#active.delete(task.taskId));
    this.#active.set(task.taskId, { promise, controller });
  }

  async #runCreatedTask(
    initial: StoredTask,
    target: SubAgentExecutionTarget,
    mode: 'execute' | 'spawn',
    signal: AbortSignal,
    controller: AbortController,
  ): Promise<SubAgentExecutionOutcome> {
    const started = await this.#waitForExecutionSlot(initial.taskId, signal);
    if (started.outcome !== undefined) return started.outcome;
    const task = started.task;
    const deadlineAt = (task.activeStartedAt ?? Date.now()) + task.remainingMs;
    const operationSignal = createOperationSignal({ signal, deadlineAt, controller });
    return this.#executeCreateOperation(task, target, mode, operationSignal, deadlineAt);
  }

  async #executeCreateOperation(
    task: StoredTask,
    target: SubAgentExecutionTarget,
    mode: 'execute' | 'spawn',
    operationSignal: AbortSignal,
    deadlineAt: number,
  ): Promise<SubAgentExecutionOutcome> {
    const control = this.#createExecutionControl(task, target, operationSignal, deadlineAt);
    const request = this.#buildExecutionRequest(task, target, operationSignal, deadlineAt, {
      type: 'create',
      idempotencyKey: task.idempotencyKey,
    });

    if (mode === 'execute') {
      const operation = Promise.resolve(target.executor.execute(request, control));
      operation.catch(() => undefined);
      const outcome = await raceWithOperationSignal(operation, operationSignal, deadlineAt);
      return this.#normalizeExecutorOutcome(task.taskId, outcome);
    }

    const rawHandle = await raceWithOperationSignal(
      Promise.resolve(target.executor.spawn(request, control)),
      operationSignal,
      deadlineAt,
    );
    this.#assertRawHandle(task, rawHandle);
    const active = this.#active.get(task.taskId);
    if (active !== undefined) active.rawHandle = rawHandle;
    await this.#commitBinding(task.taskId, target, rawHandle.binding, task.attempt);
    const wait = Promise.resolve(rawHandle.wait());
    wait.catch(() => undefined);
    const outcome = await raceWithOperationSignal(wait, operationSignal, deadlineAt);
    return this.#normalizeExecutorOutcome(task.taskId, outcome);
  }

  async #prepareUnboundCreateReplay(
    taskId: string,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<StoredTask> {
    return withRuntimeLease(this.stateStore, this.sessionId, signal, deadlineAt, async (lease) => {
      const task = await this.#loadTask(taskId);
      if (task.state !== 'running' || task.binding !== undefined) {
        throw createSubAgentError(
          'RECOVERY_UNSUPPORTED',
          'Only an unbound running create operation can be replayed idempotently.',
        );
      }
      const now = Date.now();
      const elapsed = Math.max(0, now - (task.activeStartedAt ?? now));
      const remainingMs = Math.max(0, task.remainingMs - elapsed);
      if (remainingMs < 1) {
        throw createSubAgentError('TIMED_OUT', 'The unbound create replay timed out.');
      }
      const changed = Object.freeze({
        ...task,
        revision: task.revision + 1,
        attempt: task.attempt + 1,
        activeElapsedMs: task.activeElapsedMs + elapsed,
        remainingMs,
        activeStartedAt: now,
        fencingToken: lease.fencingToken,
        updatedAt: now,
      }) as StoredTask;
      const withEvent = appendSafeTaskEvents(
        changed,
        [{ type: 'recovery.started', data: { status: 'running' } }],
        {
          eventIds: [createRuntimeId('event')],
          defaultTimestamp: now,
          revisionMode: 'preserve',
        },
      );
      await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
        tasks: [{ previous: task, next: withEvent.task, events: withEvent.events }],
      });
      return withEvent.task;
    });
  }

  async #waitForExecutionSlot(taskId: string, signal: AbortSignal): Promise<StartResult> {
    for (;;) {
      const taskBefore = await this.#loadTask(taskId);
      const deadlineAt = taskBefore.createdAt + taskBefore.remainingMs;
      throwIfOperationAborted(signal, deadlineAt);
      const result = await withRuntimeLease(
        this.stateStore,
        this.sessionId,
        signal,
        deadlineAt,
        async (lease) =>
          this.stateStore.transaction(this.sessionId, lease, async (transaction) => {
            const task = await transaction.loadTask(taskId);
            if (task === undefined) throw createResourceNotFoundError();
            const existingOutcome = taskOutcome(task);
            const run = await transaction.loadRun(task.runId);
            if (run === undefined) throw createResourceNotFoundError();
            if (existingOutcome !== undefined) {
              return { status: 'done' as const, task, run, outcome: existingOutcome };
            }
            if (task.state !== 'queued') {
              throw createSubAgentError(
                'INVALID_STATE_TRANSITION',
                `A create operation cannot start a task in state ${task.state}.`,
              );
            }
            if (run.budget.activeExecutions >= this.#limits.maxConcurrent) {
              return { status: 'wait' as const };
            }

            const now = Date.now();
            const remainingMs = Math.max(0, task.createdAt + task.remainingMs - now);
            if (remainingMs < 1) {
              const timedOut = transitionSubAgentTask(task, 'timed_out', {
                now,
                error: {
                  code: 'TIMED_OUT',
                  message: 'The subagent task timed out while queued.',
                  retryable: false,
                },
              });
              const withEvent = appendSafeTaskEvents(
                { ...timedOut, fencingToken: lease.fencingToken } as StoredTask,
                [{ type: 'task.timed_out', data: { status: 'timed_out' }, timestamp: now }],
                {
                  eventIds: [createRuntimeId('event')],
                  defaultTimestamp: now,
                  revisionMode: 'preserve',
                },
              );
              const committed = await transaction.compareAndSetTask(
                task.taskId,
                task.revision,
                lease.fencingToken,
                withEvent.task,
              );
              if (!committed) throw stateCasConflict();
              await transaction.appendEvents(task.taskId, withEvent.events);
              return {
                status: 'done' as const,
                task: withEvent.task,
                run,
                outcome: taskOutcome(withEvent.task) as SubAgentExecutionOutcome,
              };
            }

            const running = transitionSubAgentTask(task, 'running', { now });
            const fenced = Object.freeze({
              ...running,
              fencingToken: lease.fencingToken,
              remainingMs,
            }) as StoredTask;
            const withEvent = appendSafeTaskEvents(
              fenced,
              [{ type: 'task.started', data: { status: 'running' }, timestamp: now }],
              {
                eventIds: [createRuntimeId('event')],
                defaultTimestamp: now,
                revisionMode: 'preserve',
              },
            );
            const nextRun: StoredAgentRun = Object.freeze({
              ...run,
              revision: run.revision + 1,
              fencingToken: lease.fencingToken,
              budget: Object.freeze({
                ...run.budget,
                activeExecutions: run.budget.activeExecutions + 1,
              }),
              updatedAt: now,
            });
            const runCommitted = await transaction.compareAndSetRun(
              run.runId,
              run.revision,
              lease.fencingToken,
              nextRun,
            );
            const taskCommitted = await transaction.compareAndSetTask(
              task.taskId,
              task.revision,
              lease.fencingToken,
              withEvent.task,
            );
            if (!runCommitted || !taskCommitted) throw stateCasConflict();
            await transaction.appendEvents(task.taskId, withEvent.events);
            return { status: 'started' as const, task: withEvent.task, run: nextRun };
          }),
      );

      if (result.status === 'wait') {
        await waitForRuntimeRetry(signal, deadlineAt);
        continue;
      }
      return {
        task: result.task,
        run: result.run,
        ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
      };
    }
  }

  #buildExecutionRequest(
    task: StoredTask,
    _target: SubAgentExecutionTarget,
    signal: AbortSignal,
    deadlineAt: number,
    operation: SubAgentExecutorOperation,
  ): SubAgentExecutionRequest {
    return Object.freeze({
      operation,
      ownerSessionId: this.sessionId,
      runId: task.runId,
      taskId: task.taskId,
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      subagentSessionId: task.subagentSessionId,
      path: task.path,
      attempt: task.attempt,
      ...(task.retryOf === undefined ? {} : { retryOf: task.retryOf }),
      definition: task.definition,
      input: task.input,
      projectedContext: normalizeProjectedContext(task.projectedContext),
      limits: Object.freeze({ ...this.#limits, timeoutMs: task.remainingMs }),
      signal,
      deadlineAt,
    });
  }

  #assertRawHandle(task: StoredTask, handle: ExecutorTaskHandle): void {
    if (
      typeof handle !== 'object' ||
      handle === null ||
      handle.taskId !== task.taskId ||
      typeof handle.wait !== 'function' ||
      typeof handle.cancel !== 'function' ||
      typeof handle.snapshot !== 'function' ||
      typeof handle.events !== 'function'
    ) {
      throw createSubAgentError('EXECUTOR_FAILED', 'The Executor returned an invalid task handle.');
    }
  }

  #createExecutionControl(
    task: StoredTask,
    target: SubAgentExecutionTarget,
    signal: AbortSignal,
    deadlineAt: number,
  ): SubAgentExecutionControl {
    return Object.freeze({
      signal,
      deadlineAt,
      delegation: this.#createDelegationClient(task, signal, deadlineAt),
      completion: Object.freeze({
        submitResult: (callId: string, candidate: JsonValue) =>
          this.#submitResult(
            task.taskId,
            target,
            task.attempt,
            callId,
            candidate,
            signal,
            deadlineAt,
          ),
        complete: (callId: string, proof: { readonly isStandalone: boolean }) =>
          this.#completeTask(
            task.taskId,
            target,
            task.attempt,
            callId,
            proof.isStandalone,
            signal,
            deadlineAt,
          ),
      }),
      commitBinding: (binding: SubAgentExecutorBinding) =>
        this.#commitBinding(task.taskId, target, binding, task.attempt, signal, deadlineAt),
      authorizeTool: (request: ApprovalRequestInput) =>
        this.#authorizeTool(task.taskId, target, task.attempt, request, signal, deadlineAt),
      reportProgress: (update: SubAgentProgress) =>
        this.#reportProgress(task.taskId, target, task.attempt, update, signal, deadlineAt),
      consumeBudget: (delta: SubAgentUsageDelta) =>
        this.#consumeBudget(task.taskId, target, task.attempt, delta, signal, deadlineAt),
      emit: (event: ExecutorEventInput) =>
        this.#emitTaskEvent(task.taskId, target, task.attempt, event, signal, deadlineAt),
    });
  }

  async #submitResult(
    taskId: string,
    target: SubAgentExecutionTarget,
    expectedAttempt: number,
    callId: string,
    candidate: JsonValue,
    signal: AbortSignal,
    deadlineAt: number,
  ) {
    assertNonEmpty(callId, 'result callId');
    await this.#preflightOperationOwner(taskId, target, expectedAttempt);
    const parsed = target.definition.outputSchema.safeParse(candidate);
    if (!parsed.success) {
      throw createSubAgentError('INVALID_OUTPUT', 'The subagent result failed schema validation.');
    }
    try {
      assertJsonValue(parsed.data, {
        maxBytes: DEFAULT_SUBAGENT_IO_LIMITS.maxOutputBytes,
        label: 'Subagent output',
      });
    } catch {
      throw createSubAgentError(
        'INVALID_OUTPUT',
        'The subagent result is not JSON-safe or exceeds the output byte limit.',
      );
    }
    const output = cloneJsonValue(parsed.data as JsonValue);

    return withRuntimeLease(this.stateStore, this.sessionId, signal, deadlineAt, async (lease) => {
      const task = await this.#loadTask(taskId);
      this.#assertOperationOwner(task, target, expectedAttempt);
      const submitted = submitSubAgentResult(task, {
        callId,
        receiptId: createRuntimeId('receipt'),
        submittedAt: Date.now(),
        output,
      });
      if (submitted.replayed) return submitted.receipt;
      const withEvent = appendSafeTaskEvents(
        { ...submitted.task, fencingToken: lease.fencingToken } as StoredTask,
        [
          {
            type: 'task.result_submitted',
            data: { status: 'result_submitted', callId },
          },
        ],
        {
          eventIds: [createRuntimeId('event')],
          defaultTimestamp: Date.now(),
          revisionMode: 'preserve',
        },
      );
      await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
        tasks: [{ previous: task, next: withEvent.task, events: withEvent.events }],
      });
      return submitted.receipt;
    });
  }

  async #completeTask(
    taskId: string,
    target: SubAgentExecutionTarget,
    expectedAttempt: number,
    callId: string,
    isStandalone: boolean,
    signal: AbortSignal,
    deadlineAt: number,
  ) {
    assertNonEmpty(callId, 'completion callId');
    await this.#preflightOperationOwner(taskId, target, expectedAttempt);
    return withRuntimeLease(this.stateStore, this.sessionId, signal, deadlineAt, async (lease) => {
      const task = await this.#loadTask(taskId);
      this.#assertOperationOwner(task, target, expectedAttempt);
      const outputDecodable =
        task.output !== undefined && target.definition.outputSchema.safeParse(task.output).success;
      const completed = completeSubAgentTask(task, {
        callId,
        receiptId: createRuntimeId('receipt'),
        completedAt: Date.now(),
        isStandalone,
        outputDecodable,
      });
      if (completed.replayed) return completed.receipt;
      const withEvent = appendSafeTaskEvents(
        { ...completed.task, fencingToken: lease.fencingToken } as StoredTask,
        [{ type: 'task.succeeded', data: { status: 'succeeded', callId } }],
        {
          eventIds: [createRuntimeId('event')],
          defaultTimestamp: Date.now(),
          revisionMode: 'preserve',
        },
      );
      const run = await this.#loadRun(task.runId);
      const nextRun = this.#releaseActiveExecution(run, lease, Date.now());
      await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
        run: { previous: run, next: nextRun },
        tasks: [{ previous: task, next: withEvent.task, events: withEvent.events }],
      });
      this.#emitTelemetry({
        type: 'task.completed',
        timestamp: Date.now(),
        sessionId: this.sessionId,
        runId: task.runId,
        taskId,
      });
      return completed.receipt;
    });
  }

  async #commitBinding(
    taskId: string,
    target: SubAgentExecutionTarget,
    binding: SubAgentExecutorBinding,
    expectedAttempt: number,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<void> {
    await this.#preflightOperationOwner(taskId, target, expectedAttempt);
    const effectiveDeadline = deadlineAt ?? Date.now() + this.#limits.timeoutMs;
    const effectiveSignal = signal ?? createOperationSignal({ deadlineAt: effectiveDeadline });
    validateBinding(binding, taskId, this.sessionId, target);
    await withRuntimeLease(
      this.stateStore,
      this.sessionId,
      effectiveSignal,
      effectiveDeadline,
      async (lease) => {
        const task = await this.#loadTask(taskId);
        this.#assertOperationOwner(task, target, expectedAttempt);
        if (binding.subagentSessionId !== task.subagentSessionId) {
          throw createSubAgentError(
            'BINDING_INVALID',
            'The Executor binding child session identity is invalid.',
          );
        }
        if (task.binding !== undefined) {
          if (isDeepStrictEqual(task.binding, binding)) return;
          throw createSubAgentError('BINDING_INVALID', 'The task binding is already committed.');
        }
        const next = Object.freeze({
          ...task,
          binding: Object.freeze({
            ...binding,
            recoveryData: cloneJsonValue(binding.recoveryData),
          }),
          revision: task.revision + 1,
          fencingToken: lease.fencingToken,
          updatedAt: Date.now(),
        }) as StoredTask;
        await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
          tasks: [{ previous: task, next }],
        });
      },
    );
  }

  async #authorizeTool(
    taskId: string,
    target: SubAgentExecutionTarget,
    expectedAttempt: number,
    input: ApprovalRequestInput,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<ApprovalDirective> {
    await this.#preflightOperationOwner(taskId, target, expectedAttempt);
    if (!target.descriptor.capabilities.approval) {
      throw createSubAgentError(
        'UNSUPPORTED_CAPABILITY',
        'The selected Executor does not support approval suspension.',
      );
    }
    validateApprovalRequestInput(input);

    const directive = await withRuntimeLease(
      this.stateStore,
      this.sessionId,
      signal,
      deadlineAt,
      async (lease): Promise<ApprovalDirective> => {
        const task = await this.#loadTask(taskId);
        this.#assertOperationOwner(task, target, expectedAttempt);
        if (task.state !== 'running') {
          throw createSubAgentError(
            'INVALID_STATE_TRANSITION',
            'Approval can be requested or replayed only by the current running attempt.',
          );
        }
        const decided = task.approvalDecisions.find(({ callId }) => callId === input.callId);
        if (decided !== undefined) {
          if (decided.decision === 'approved') {
            return { type: 'approved', approvalId: decided.approvalId };
          }
          throw createSubAgentError(
            decided.decision === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REJECTED',
            decided.decision === 'expired'
              ? 'The approval request expired.'
              : 'The approval request was rejected.',
          );
        }
        if (task.binding === undefined) {
          throw createSubAgentError(
            'BINDING_INVALID',
            'Approval suspension requires a durable Executor binding.',
          );
        }

        const now = Date.now();
        const approval = Object.freeze({
          ...input,
          approvalId: createRuntimeId('approval'),
          ownerSessionId: this.sessionId,
          taskId,
          createdAt: now,
          revision: task.revision + 1,
        });
        const paused = transitionSubAgentTask(task, 'waiting_approval', {
          now,
          approvals: [...task.approvals, approval],
        });
        const withEvents = appendSafeTaskEvents(
          { ...paused, fencingToken: lease.fencingToken } as StoredTask,
          [
            {
              type: 'approval.requested',
              data: {
                approvalId: approval.approvalId,
                toolName: approval.toolName,
                callId: approval.callId,
              },
            },
            { type: 'task.paused', data: { status: 'waiting_approval' } },
          ],
          {
            eventIds: [createRuntimeId('event'), createRuntimeId('event')],
            defaultTimestamp: now,
            revisionMode: 'preserve',
          },
        );
        const run = await this.#loadRun(task.runId);
        const nextRun = this.#releaseActiveExecution(run, lease, now);
        await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
          run: { previous: run, next: nextRun },
          tasks: [{ previous: task, next: withEvents.task, events: withEvents.events }],
        });
        return {
          type: 'suspend',
          request: approval,
          checkpointRevision: withEvents.task.revision,
        };
      },
    );
    if (directive.type === 'suspend') {
      queueMicrotask(() => {
        this.#active
          .get(taskId)
          ?.controller.abort(
            createSubAgentError('APPROVAL_REQUIRED', 'The task is waiting for host approval.'),
          );
      });
    }
    return directive;
  }

  async #reportProgress(
    taskId: string,
    target: SubAgentExecutionTarget,
    expectedAttempt: number,
    update: SubAgentProgress,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<void> {
    await this.#preflightOperationOwner(taskId, target, expectedAttempt);
    if (typeof update.message !== 'string' || update.message.length === 0) {
      throw new TypeError('Subagent progress message must be non-empty.');
    }
    if (
      update.percent !== undefined &&
      (!Number.isFinite(update.percent) || update.percent < 0 || update.percent > 100)
    ) {
      throw new RangeError('Subagent progress percent must be between 0 and 100.');
    }
    if (update.data !== undefined) assertJsonValue(update.data);
    await this.#appendExecutorEvent(
      taskId,
      target,
      expectedAttempt,
      {
        type: 'progress.reported',
        data: { length: new TextEncoder().encode(update.message).byteLength },
      },
      signal,
      deadlineAt,
    );
  }

  async #emitTaskEvent(
    taskId: string,
    target: SubAgentExecutionTarget,
    expectedAttempt: number,
    event: ExecutorEventInput,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<void> {
    await this.#preflightOperationOwner(taskId, target, expectedAttempt);
    const allowed = new Set<ExecutorEventInput['type']>([
      'progress.reported',
      'recovery.started',
      'recovery.resumed',
      'recovery.reconnected',
      'recovery.failed',
    ]);
    if (!allowed.has(event.type)) {
      throw new TypeError(
        'Executor emit() cannot publish authoritative task, approval, usage or budget events.',
      );
    }
    await this.#appendExecutorEvent(taskId, target, expectedAttempt, event, signal, deadlineAt);
  }

  async #appendExecutorEvent(
    taskId: string,
    target: SubAgentExecutionTarget,
    expectedAttempt: number,
    event: ExecutorEventInput,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<void> {
    await withRuntimeLease(this.stateStore, this.sessionId, signal, deadlineAt, async (lease) => {
      const task = await this.#loadTask(taskId);
      this.#assertOperationOwner(task, target, expectedAttempt);
      if (taskOutcome(task) !== undefined) {
        throw createSubAgentError(
          'INVALID_STATE_TRANSITION',
          'A terminal or paused task cannot append Executor events.',
        );
      }
      const withEvent = appendSafeTaskEvents(task, [event], {
        eventIds: [createRuntimeId('event')],
        defaultTimestamp: Date.now(),
      });
      const next = Object.freeze({
        ...withEvent.task,
        fencingToken: lease.fencingToken,
      }) as StoredTask;
      await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
        tasks: [{ previous: task, next, events: withEvent.events }],
      });
    });
  }

  async #consumeBudget(
    taskId: string,
    target: SubAgentExecutionTarget,
    expectedAttempt: number,
    delta: SubAgentUsageDelta,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<void> {
    await this.#preflightOperationOwner(taskId, target, expectedAttempt);
    validateUsageDelta(delta);
    await withRuntimeLease(this.stateStore, this.sessionId, signal, deadlineAt, async (lease) => {
      const task = await this.#loadTask(taskId);
      this.#assertOperationOwner(task, target, expectedAttempt);
      if (task.state !== 'running' && task.state !== 'result_submitted') {
        throw createSubAgentError(
          'INVALID_STATE_TRANSITION',
          'Budget can be consumed only by an active task.',
        );
      }
      const run = await this.#loadRun(task.runId);
      const currentUsage = task.usage ?? { turns: 0, providerCalls: 0 };
      const usage = Object.freeze({
        turns: currentUsage.turns + (delta.turns ?? 0),
        providerCalls: currentUsage.providerCalls + (delta.providerCalls ?? 0),
        inputTokens: (currentUsage.inputTokens ?? 0) + (delta.inputTokens ?? 0),
        outputTokens: (currentUsage.outputTokens ?? 0) + (delta.outputTokens ?? 0),
        cost: (currentUsage.cost ?? 0) + (delta.cost ?? 0),
      });
      let budget: StoredAgentRun['budget'];
      let budgetFailure: SubAgentRuntimeError | undefined;
      try {
        if (usage.turns > this.#limits.maxTurns) {
          throw createSubAgentError('BUDGET_EXCEEDED', 'The subagent task exceeds maxTurns.');
        }
        budget = reserveTreeBudget(
          run.budget,
          {
            providerCalls: delta.providerCalls ?? 0,
            inputTokens: delta.inputTokens ?? 0,
            outputTokens: delta.outputTokens ?? 0,
            ...(delta.cost === undefined ? {} : { cost: delta.cost }),
          },
          this.#limits,
        );
      } catch (error) {
        if (!(error instanceof SubAgentRuntimeError) || error.code !== 'BUDGET_EXCEEDED') {
          throw error;
        }
        budgetFailure = error;
        budget = run.budget;
      }
      const now = Date.now();
      if (budgetFailure !== undefined) {
        const terminal = transitionSubAgentTask(task, 'budget_exceeded', {
          now,
          error: budgetFailure.descriptor,
        });
        const eventInputs: ExecutorEventInput[] = [
          {
            type: 'budget.rejected',
            data: { status: 'budget_exceeded', errorCode: 'BUDGET_EXCEEDED' },
          },
          {
            type: 'task.budget_exceeded',
            data: { status: 'budget_exceeded', errorCode: 'BUDGET_EXCEEDED' },
          },
        ];
        const withEvents = appendSafeTaskEvents(
          { ...terminal, fencingToken: lease.fencingToken } as StoredTask,
          eventInputs,
          {
            eventIds: eventInputs.map(() => createRuntimeId('event')),
            defaultTimestamp: now,
            revisionMode: 'preserve',
          },
        );
        const nextRun = this.#releaseActiveExecution(run, lease, now);
        await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
          run: { previous: run, next: nextRun },
          tasks: [{ previous: task, next: withEvents.task, events: withEvents.events }],
        });
        throw budgetFailure;
      }
      const changed = Object.freeze({
        ...task,
        usage,
        revision: task.revision + 1,
        fencingToken: lease.fencingToken,
        updatedAt: now,
      }) as StoredTask;
      const withEvent = appendSafeTaskEvents(
        changed,
        [{ type: 'usage.updated', data: { usage } }],
        {
          eventIds: [createRuntimeId('event')],
          defaultTimestamp: now,
          revisionMode: 'preserve',
        },
      );
      const nextRun: StoredAgentRun = Object.freeze({
        ...run,
        budget,
        revision: run.revision + 1,
        fencingToken: lease.fencingToken,
        updatedAt: now,
      });
      await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
        run: { previous: run, next: nextRun },
        tasks: [{ previous: task, next: withEvent.task, events: withEvent.events }],
      });
    });
  }

  #createDelegationClient(
    parent: StoredTask,
    signal: AbortSignal,
    deadlineAt: number,
  ): SubAgentDelegationClient {
    const execute = async (request: ChildDelegationRequest) => {
      await this.#assertDelegationOwner(parent);
      return this.execute({
        ...request,
        runId: parent.runId,
        parentTaskId: parent.taskId,
        parentContext: [],
        parentRawHistory: [],
        signal,
        deadlineAt,
      });
    };
    const spawn = async (request: ChildDelegationRequest) => {
      await this.#assertDelegationOwner(parent);
      return this.spawn({
        ...request,
        runId: parent.runId,
        parentTaskId: parent.taskId,
        parentContext: [],
        parentRawHistory: [],
        signal,
        deadlineAt,
      });
    };

    return Object.freeze({
      getCatalog: () => this.#delegatedCatalog(parent),
      getCatalogEntries: () => this.#delegatedCatalogEntries(parent),
      dispatchTool: (request: ModelSubAgentRequest, context: SubAgentDispatchContext) => {
        assertRuntimeSession(context.ownerSessionId, this.sessionId);
        if (context.runId !== parent.runId || context.parentTaskId !== parent.taskId) {
          throw createResourceNotFoundError();
        }
        return execute({ ...request, requestId: context.requestId });
      },
      execute,
      spawn,
    });
  }

  #delegatedCatalog(parent: StoredTask): ExecutorCatalogSnapshot {
    const entries = this.#delegatedCatalogEntries(parent);
    const allowedExecutors = new Set(
      entries.flatMap(({ executors }) => executors.map(({ name }) => name)),
    );
    const catalog = this.getCatalog();
    return Object.freeze({
      revision: catalog.revision,
      capturedAt: catalog.capturedAt,
      executors: Object.freeze(
        catalog.executors.filter(({ descriptor }) => allowedExecutors.has(descriptor.name)),
      ),
    });
  }

  async #assertDelegationOwner(parent: StoredTask): Promise<void> {
    const current = await this.#loadTask(parent.taskId);
    if (current.attempt !== parent.attempt || current.state !== 'running') {
      throw createSubAgentError(
        'RECOVERY_TARGET_LOST',
        'The parent delegation client belongs to an obsolete task attempt.',
      );
    }
  }

  #delegatedCatalogEntries(parent: StoredTask): readonly SubAgentCatalogEntry[] {
    const definition = this.#definitions.getExact(parent.definition);
    if (definition?.delegation?.mode !== 'allowlist') return Object.freeze([]);
    const delegation = definition.delegation;
    const allowed = new Set(delegation.definitions);
    return Object.freeze(
      this.getCatalogEntries().filter(({ definition: child }) => {
        if (!allowed.has(child.name)) return false;
        return child.name !== definition.name || delegation.allowSelf === true;
      }),
    );
  }

  async #normalizeExecutorOutcome(
    taskId: string,
    candidate: SubAgentExecutionOutcome,
  ): Promise<SubAgentExecutionOutcome> {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      (candidate.type !== 'terminal' && candidate.type !== 'paused')
    ) {
      throw createSubAgentError(
        'EXECUTOR_FAILED',
        'The Executor returned an invalid execution outcome.',
      );
    }
    const task = await this.#loadTask(taskId);
    const outcome = taskOutcome(task);
    if (outcome !== undefined) return outcome;
    throw createSubAgentError(
      'RESULT_REQUIRED',
      'The Executor finished without committing a typed result or approval checkpoint.',
    );
  }

  async #finalizeExecutionError(
    taskId: string,
    expectedAttempt: number,
    error: unknown,
    recovery = false,
  ): Promise<SubAgentExecutionOutcome> {
    const existing = await this.stateStore.loadTask(this.sessionId, taskId);
    if (existing === undefined) throw createResourceNotFoundError();
    if (existing.attempt !== expectedAttempt) {
      throw createSubAgentError(
        'RECOVERY_TARGET_LOST',
        'An obsolete Executor attempt cannot finalize the current task.',
      );
    }
    const existingOutcome = taskOutcome(existing);
    if (existingOutcome !== undefined) return existingOutcome;

    const descriptor = safeExecutorError(error);
    const state =
      descriptor.code === 'CANCELLED'
        ? 'cancelled'
        : descriptor.code === 'TIMED_OUT'
          ? 'timed_out'
          : descriptor.code === 'BUDGET_EXCEEDED'
            ? 'budget_exceeded'
            : 'failed';
    return withRuntimeLease(
      this.stateStore,
      this.sessionId,
      createOperationSignal({ deadlineAt: Date.now() + this.#limits.timeoutMs }),
      Date.now() + this.#limits.timeoutMs,
      async (lease) => {
        const task = await this.#loadTask(taskId);
        if (task.attempt !== expectedAttempt) {
          throw createSubAgentError(
            'RECOVERY_TARGET_LOST',
            'An obsolete Executor attempt cannot finalize the current task.',
          );
        }
        const replay = taskOutcome(task);
        if (replay !== undefined) return replay;
        const now = Date.now();
        const terminal = transitionSubAgentTask(task, state, {
          now,
          error: descriptor,
        });
        const eventType =
          state === 'cancelled'
            ? 'task.cancelled'
            : state === 'timed_out'
              ? 'task.timed_out'
              : state === 'budget_exceeded'
                ? 'task.budget_exceeded'
                : 'task.failed';
        const eventInputs: ExecutorEventInput[] = [
          ...(recovery
            ? ([
                {
                  type: 'recovery.failed',
                  timestamp: now,
                  data: { status: state, errorCode: descriptor.code },
                },
              ] satisfies ExecutorEventInput[])
            : []),
          {
            type: eventType,
            timestamp: now,
            data: {
              status: state,
              errorCode: descriptor.code,
              ...(descriptor.outcomeUnknown === undefined
                ? {}
                : { outcomeUnknown: descriptor.outcomeUnknown }),
            },
          },
        ];
        const withEvent = appendSafeTaskEvents(
          { ...terminal, fencingToken: lease.fencingToken } as StoredTask,
          eventInputs,
          {
            eventIds: eventInputs.map(() => createRuntimeId('event')),
            defaultTimestamp: now,
            revisionMode: 'preserve',
          },
        );
        const run = await this.#loadRun(task.runId);
        const wasActive = task.activeStartedAt !== undefined;
        const nextRun = wasActive ? this.#releaseActiveExecution(run, lease, now) : run;
        await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
          ...(wasActive ? { run: { previous: run, next: nextRun } } : {}),
          tasks: [{ previous: task, next: withEvent.task, events: withEvent.events }],
        });
        this.#emitTelemetry({
          type: 'task.failed',
          timestamp: now,
          sessionId: this.sessionId,
          runId: task.runId,
          taskId,
          errorCode: descriptor.code,
        });
        return taskOutcome(withEvent.task) as SubAgentExecutionOutcome;
      },
    );
  }

  #releaseActiveExecution(run: StoredAgentRun, lease: StateLease, now: number): StoredAgentRun {
    if (run.budget.activeExecutions < 1) {
      throw createSubAgentError(
        'INVALID_STATE_TRANSITION',
        'The root run has no active subagent execution to release.',
      );
    }
    return Object.freeze({
      ...run,
      revision: run.revision + 1,
      fencingToken: lease.fencingToken,
      budget: Object.freeze({
        ...run.budget,
        activeExecutions: run.budget.activeExecutions - 1,
      }),
      updatedAt: now,
    });
  }

  #assertExecutionTarget(task: StoredTask, target: SubAgentExecutionTarget): void {
    if (
      task.executor !== target.descriptor.name ||
      task.definition.name !== target.definition.name ||
      task.definition.version !== target.definition.version
    ) {
      throw createSubAgentError(
        'RECOVERY_TARGET_LOST',
        'The task no longer matches the selected exact execution target.',
      );
    }
  }

  #assertOperationOwner(
    task: StoredTask,
    target: SubAgentExecutionTarget,
    expectedAttempt: number,
  ): void {
    this.#assertExecutionTarget(task, target);
    if (task.attempt !== expectedAttempt) {
      throw createSubAgentError(
        'RECOVERY_TARGET_LOST',
        'The Executor operation belongs to an obsolete task attempt.',
      );
    }
  }

  async #preflightOperationOwner(
    taskId: string,
    target: SubAgentExecutionTarget,
    expectedAttempt: number,
  ): Promise<void> {
    this.#assertOperationOwner(await this.#loadTask(taskId), target, expectedAttempt);
  }

  #createHandle(taskId: string): SubAgentTaskHandle {
    return Object.freeze({
      taskId,
      snapshot: () => this.getTask(this.sessionId, taskId),
      wait: () => this.wait(this.sessionId, taskId),
      cancel: (reason?: string) => this.cancel(this.sessionId, taskId, reason),
      events: (options?: { readonly afterSequence?: number }) =>
        this.events(this.sessionId, taskId, options),
    });
  }

  async getTask(sessionId: string, taskId: string): Promise<SubAgentTaskSnapshot> {
    assertRuntimeSession(sessionId, this.sessionId);
    return taskSnapshot(await this.#loadTask(taskId));
  }

  async getSubAgentSession(
    sessionId: string,
    subagentSessionId: string,
  ): Promise<SubAgentSessionSnapshot> {
    assertRuntimeSession(sessionId, this.sessionId);
    const task = await this.stateStore.findTaskBySubAgentSession(this.sessionId, subagentSessionId);
    if (task === undefined) throw createResourceNotFoundError();
    return Object.freeze({
      ownerSessionId: this.sessionId,
      runId: task.runId,
      taskId: task.taskId,
      subagentSessionId: task.subagentSessionId,
      subAgent: Object.freeze({ ...task.definition }),
      revision: task.revision,
      ...(task.binding === undefined
        ? {}
        : { checkpointVersion: task.binding.adapterStateVersion }),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  async wait(sessionId: string, taskId: string): Promise<SubAgentExecutionOutcome> {
    assertRuntimeSession(sessionId, this.sessionId);
    const task = await this.#loadTask(taskId);
    const outcome = taskOutcome(task);
    if (outcome !== undefined) return outcome;
    const active = this.#active.get(taskId);
    if (active === undefined) {
      throw createSubAgentError(
        'RECOVERY_UNSUPPORTED',
        'The task is not active in this process and requires explicit resume or reconnect.',
      );
    }
    return active.promise;
  }

  async cancel(sessionId: string, taskId: string, reason?: string): Promise<SubAgentTaskSnapshot> {
    assertRuntimeSession(sessionId, this.sessionId);
    const before = await this.#loadTask(taskId);
    if (taskOutcome(before) !== undefined) return taskSnapshot(before);

    const executor = this.#executors.getExecutor(before.executor);
    if (
      (before.state === 'running' || before.state === 'result_submitted') &&
      executor !== undefined &&
      !executor.descriptor.capabilities.cancel
    ) {
      throw createSubAgentError(
        'UNSUPPORTED_CAPABILITY',
        'The selected Executor does not support cancellation.',
      );
    }
    const active = this.#active.get(taskId);
    active?.controller.abort(
      createSubAgentError('CANCELLED', 'The task was cancelled by the host.'),
    );
    const deadlineAt = Date.now() + this.#limits.timeoutMs;
    const signal = createOperationSignal({ deadlineAt });
    if (active?.rawHandle !== undefined) {
      try {
        await raceWithOperationSignal(
          Promise.resolve(active.rawHandle.cancel(reason)),
          signal,
          deadlineAt,
        );
      } catch {
        // Core cancellation remains authoritative even when an adapter cannot acknowledge it.
      }
    }

    return withRuntimeLease(this.stateStore, this.sessionId, signal, deadlineAt, async (lease) => {
      const task = await this.#loadTask(taskId);
      if (taskOutcome(task) !== undefined) return taskSnapshot(task);
      const now = Date.now();
      const descriptor: SubAgentErrorDescriptor = Object.freeze({
        code: 'CANCELLED',
        message: reason?.trim()
          ? 'The subagent task was cancelled by the host.'
          : 'The subagent task was cancelled.',
        retryable: false,
      });
      const cancelled = transitionSubAgentTask(task, 'cancelled', {
        now,
        error: descriptor,
      });
      const withEvent = appendSafeTaskEvents(
        { ...cancelled, fencingToken: lease.fencingToken } as StoredTask,
        [{ type: 'task.cancelled', timestamp: now, data: { status: 'cancelled' } }],
        {
          eventIds: [createRuntimeId('event')],
          defaultTimestamp: now,
          revisionMode: 'preserve',
        },
      );
      const run = await this.#loadRun(task.runId);
      const wasActive = task.activeStartedAt !== undefined;
      const nextRun = wasActive ? this.#releaseActiveExecution(run, lease, now) : run;
      await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
        ...(wasActive ? { run: { previous: run, next: nextRun } } : {}),
        tasks: [{ previous: task, next: withEvent.task, events: withEvent.events }],
      });
      return taskSnapshot(withEvent.task);
    });
  }

  async resume(
    sessionId: string,
    taskId: string,
    options: { readonly decisions?: readonly ApprovalDecision[] },
  ): Promise<SubAgentExecutionOutcome> {
    assertRuntimeSession(sessionId, this.sessionId);
    assertRuntimeReady(this.#ready);
    let task = await this.#loadTask(taskId);
    const terminal = taskOutcome(task);
    if (terminal?.type === 'terminal') {
      throw createSubAgentError(
        'INVALID_STATE_TRANSITION',
        'A terminal subagent task cannot be resumed.',
      );
    }
    if (task.error?.outcomeUnknown === true) {
      throw createSubAgentError(
        'RECOVERY_UNSUPPORTED',
        'A provider outcome-unknown task cannot be resumed automatically.',
      );
    }
    const currentExecution = this.#active.get(taskId);
    if (currentExecution !== undefined) {
      if (task.state !== 'waiting_approval') return currentExecution.promise;
      await currentExecution.promise;
      task = await this.#loadTask(taskId);
    }

    let target: SubAgentExecutionTarget;
    let operation: SubAgentExecutorOperation;
    if (task.state === 'waiting_approval') {
      target = this.#resolveRecoveryTarget(task, 'approval');
      const decisions = Object.freeze([...(options.decisions ?? [])]);
      validateApprovalDecisionSet(task, decisions);
      task = await this.#commitApprovalDecisions(taskId, decisions);
      const outcome = taskOutcome(task);
      if (outcome !== undefined) return outcome;
      operation = {
        type: 'resume',
        reason: 'approval',
        binding: task.binding as SubAgentExecutorBinding,
        approvals: decisions,
      };
    } else {
      target = this.#resolveRecoveryTarget(task, 'checkpoint');
      if (!task.recoveryRequired || task.state !== 'running') {
        throw createSubAgentError(
          'RECOVERY_UNSUPPORTED',
          'The task has no durable checkpoint recovery to resume.',
        );
      }
      task = await this.#commitCheckpointRecovery(taskId);
      const recoveryOutcome = taskOutcome(task);
      if (recoveryOutcome !== undefined) return recoveryOutcome;
      operation = {
        type: 'resume',
        reason: 'checkpoint',
        binding: task.binding as SubAgentExecutorBinding,
      };
    }

    this.#startRecoveredExecution(task, target, operation, 'execute');
    return this.#active.get(taskId)!.promise;
  }

  async reconnect(sessionId: string, taskId: string): Promise<SubAgentTaskHandle> {
    assertRuntimeSession(sessionId, this.sessionId);
    assertRuntimeReady(this.#ready);
    const task = await this.#loadTask(taskId);
    const terminal = taskOutcome(task);
    if (terminal !== undefined) {
      throw createSubAgentError(
        'INVALID_STATE_TRANSITION',
        'A terminal subagent task cannot be reconnected.',
      );
    }
    if (task.error?.outcomeUnknown === true) {
      throw createSubAgentError(
        'RECOVERY_UNSUPPORTED',
        'A provider outcome-unknown task cannot be reconnected automatically.',
      );
    }
    if (this.#active.has(taskId)) return this.#createHandle(taskId);
    const target = this.#resolveRecoveryTarget(task, 'reconnect');
    if (target.descriptor.capabilities.recovery.reconnect !== 'external_binding') {
      throw createSubAgentError(
        'RECOVERY_UNSUPPORTED',
        'The persisted Executor does not support external reconnect.',
      );
    }
    const reconnected = await this.#commitReconnectRecovery(taskId);
    if (taskOutcome(reconnected) !== undefined) return this.#createHandle(taskId);
    this.#startRecoveredExecution(
      reconnected,
      target,
      { type: 'reconnect', binding: reconnected.binding as SubAgentExecutorBinding },
      'spawn',
    );
    return this.#createHandle(taskId);
  }

  async *events(
    sessionId: string,
    taskId: string,
    options?: { readonly afterSequence?: number },
  ): AsyncIterable<SubAgentTaskEvent> {
    assertRuntimeSession(sessionId, this.sessionId);
    let cursor = options?.afterSequence ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new RangeError('Event cursor must be a non-negative safe integer.');
    }
    for (;;) {
      const task = await this.#loadTask(taskId);
      const events = await this.stateStore.readEvents(this.sessionId, taskId, cursor);
      for (const event of events) {
        cursor = event.sequence;
        yield event;
      }
      if (taskOutcome(task)?.type === 'terminal' && cursor >= task.eventSequence) return;
      await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_RUNTIME_EVENT_POLL_MS));
    }
  }

  #resolveRecoveryTarget(
    task: StoredTask,
    kind: 'approval' | 'checkpoint' | 'reconnect',
  ): SubAgentExecutionTarget {
    const target = this.#executors.selectRecovery(task.definition, task.executor);
    this.#assertExecutionTarget(task, target);
    if (task.binding === undefined) {
      throw createSubAgentError(
        'BINDING_INVALID',
        'Recovery requires a committed Executor binding.',
      );
    }
    validateBinding(task.binding, task.taskId, this.sessionId, target);
    if (task.binding.subagentSessionId !== task.subagentSessionId) {
      throw createSubAgentError(
        'BINDING_INVALID',
        'The persisted Executor binding child session identity is invalid.',
      );
    }
    const resumeCapability = target.descriptor.capabilities.recovery.resume;
    if (
      (kind === 'approval' && resumeCapability === 'none') ||
      (kind === 'checkpoint' && resumeCapability !== 'checkpoint')
    ) {
      throw createSubAgentError(
        'RECOVERY_UNSUPPORTED',
        'The persisted Executor does not support resume.',
      );
    }
    return target;
  }

  async #commitApprovalDecisions(
    taskId: string,
    decisions: readonly ApprovalDecision[],
  ): Promise<StoredTask> {
    const deadlineAt = Date.now() + this.#limits.timeoutMs;
    const signal = createOperationSignal({ deadlineAt });
    return withRuntimeLease(this.stateStore, this.sessionId, signal, deadlineAt, async (lease) =>
      this.stateStore.transaction(this.sessionId, lease, async (transaction) => {
        const original = await transaction.loadTask(taskId);
        if (original === undefined) throw createResourceNotFoundError();
        const run = await transaction.loadRun(original.runId);
        if (run === undefined) throw createResourceNotFoundError();
        if (original.state !== 'waiting_approval') {
          const outcome = taskOutcome(original);
          if (outcome !== undefined) return original;
          throw createSubAgentError(
            'INVALID_STATE_TRANSITION',
            'Approval decisions require a waiting task.',
          );
        }
        validateApprovalDecisionSet(original, decisions);
        let current: StoredTask = original;
        const eventInputs: ExecutorEventInput[] = [];
        for (const decision of decisions) {
          const decided = decideApproval(current, { decision, now: Date.now() });
          current = decided.task as StoredTask;
          if (!decided.replayed) {
            eventInputs.push({
              type: 'approval.decided',
              data: {
                approvalId: decided.decision.approvalId,
                reasonCode: decided.decision.decision,
              },
            });
          }
          if (current.state !== 'waiting_approval') break;
        }
        if (
          current.state === 'running' &&
          run.budget.activeExecutions >= this.#limits.maxConcurrent
        ) {
          throw createSubAgentError(
            'LIMIT_EXCEEDED',
            'No subagent execution slot is available for approval resume.',
            { retryable: true },
          );
        }
        if (current.state === 'running') {
          eventInputs.push({ type: 'task.resumed', data: { status: 'running' } });
        } else if (current.result !== undefined) {
          eventInputs.push({
            type: 'task.failed',
            data: {
              status: current.state,
              ...(current.error === undefined ? {} : { errorCode: current.error.code }),
            },
          });
        }
        const withEvents = appendSafeTaskEvents(
          { ...current, fencingToken: lease.fencingToken } as StoredTask,
          eventInputs,
          {
            eventIds: eventInputs.map(() => createRuntimeId('event')),
            defaultTimestamp: Date.now(),
            revisionMode: 'preserve',
          },
        );
        let nextRun = run;
        if (current.state === 'running') {
          nextRun = Object.freeze({
            ...run,
            revision: run.revision + 1,
            fencingToken: lease.fencingToken,
            budget: Object.freeze({
              ...run.budget,
              activeExecutions: run.budget.activeExecutions + 1,
            }),
            updatedAt: Date.now(),
          });
        }
        const taskCommitted = await transaction.compareAndSetTask(
          original.taskId,
          original.revision,
          lease.fencingToken,
          withEvents.task,
        );
        const runCommitted =
          nextRun === run ||
          (await transaction.compareAndSetRun(
            run.runId,
            run.revision,
            lease.fencingToken,
            nextRun,
          ));
        if (!taskCommitted || !runCommitted) throw stateCasConflict();
        await transaction.appendEvents(original.taskId, withEvents.events);
        return withEvents.task;
      }),
    );
  }

  async #commitCheckpointRecovery(taskId: string): Promise<StoredTask> {
    return this.#commitRunningRecovery(taskId, 'checkpoint');
  }

  async #commitReconnectRecovery(taskId: string): Promise<StoredTask> {
    return this.#commitRunningRecovery(taskId, 'reconnect');
  }

  async #commitRunningRecovery(
    taskId: string,
    kind: 'checkpoint' | 'reconnect',
  ): Promise<StoredTask> {
    const deadlineAt = Date.now() + this.#limits.timeoutMs;
    const signal = createOperationSignal({ deadlineAt });
    return withRuntimeLease(this.stateStore, this.sessionId, signal, deadlineAt, async (lease) => {
      const task = await this.#loadTask(taskId);
      const validState = task.state === 'running' || task.state === 'result_submitted';
      if (
        !validState ||
        (kind === 'checkpoint' && (task.state !== 'running' || !task.recoveryRequired))
      ) {
        throw createSubAgentError(
          'RECOVERY_UNSUPPORTED',
          `The task does not support ${kind} recovery in its current state.`,
        );
      }
      const now = Date.now();
      const elapsed = Math.max(0, now - (task.activeStartedAt ?? now));
      const remainingMs = Math.max(0, task.remainingMs - elapsed);
      const stoppedDraft = { ...task };
      delete stoppedDraft.activeStartedAt;
      const stopped = Object.freeze({
        ...stoppedDraft,
        activeElapsedMs: task.activeElapsedMs + elapsed,
        remainingMs,
      }) as StoredTask;
      if (remainingMs < 1) {
        const timedOut = transitionSubAgentTask(stopped, 'timed_out', {
          now,
          error: {
            code: 'TIMED_OUT',
            message: 'The subagent task timed out before recovery.',
            retryable: false,
          },
        });
        const withEvent = appendSafeTaskEvents(
          { ...timedOut, fencingToken: lease.fencingToken } as StoredTask,
          [{ type: 'task.timed_out', data: { status: 'timed_out' } }],
          {
            eventIds: [createRuntimeId('event')],
            defaultTimestamp: now,
            revisionMode: 'preserve',
          },
        );
        const run = await this.#loadRun(task.runId);
        const nextRun = this.#releaseActiveExecution(run, lease, now);
        await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
          run: { previous: run, next: nextRun },
          tasks: [{ previous: task, next: withEvent.task, events: withEvent.events }],
        });
        return withEvent.task;
      }
      const changed = Object.freeze({
        ...stopped,
        revision: task.revision + 1,
        attempt: task.attempt + 1,
        recoveryRequired: false,
        remainingMs,
        activeStartedAt: now,
        fencingToken: lease.fencingToken,
        updatedAt: now,
      }) as StoredTask;
      const withEvents = appendSafeTaskEvents(
        changed,
        [
          { type: 'recovery.started', data: { status: task.state } },
          ...(kind === 'checkpoint'
            ? ([
                { type: 'recovery.resumed', data: { status: task.state } },
              ] satisfies ExecutorEventInput[])
            : []),
        ],
        {
          eventIds:
            kind === 'checkpoint'
              ? [createRuntimeId('event'), createRuntimeId('event')]
              : [createRuntimeId('event')],
          defaultTimestamp: now,
          revisionMode: 'preserve',
        },
      );
      await commitRuntimeStateMutation(this.stateStore, this.sessionId, lease, {
        tasks: [{ previous: task, next: withEvents.task, events: withEvents.events }],
      });
      return withEvents.task;
    });
  }

  #startRecoveredExecution(
    task: StoredTask,
    target: SubAgentExecutionTarget,
    operation: SubAgentExecutorOperation,
    mode: 'execute' | 'spawn',
  ): void {
    const controller = new AbortController();
    const deadlineAt = Date.now() + task.remainingMs;
    const signal = createOperationSignal({ deadlineAt, controller });
    const promise = this.#runRecoveredTask(task, target, operation, mode, signal, deadlineAt)
      .catch(async (error: unknown) =>
        this.#finalizeExecutionError(task.taskId, task.attempt, error, true),
      )
      .finally(() => this.#active.delete(task.taskId));
    this.#active.set(task.taskId, { promise, controller });
  }

  async #runRecoveredTask(
    task: StoredTask,
    target: SubAgentExecutionTarget,
    operation: SubAgentExecutorOperation,
    mode: 'execute' | 'spawn',
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<SubAgentExecutionOutcome> {
    const control = this.#createExecutionControl(task, target, signal, deadlineAt);
    const request = this.#buildExecutionRequest(task, target, signal, deadlineAt, operation);
    if (mode === 'execute') {
      const pending = Promise.resolve(target.executor.execute(request, control));
      pending.catch(() => undefined);
      const outcome = await raceWithOperationSignal(pending, signal, deadlineAt);
      return this.#normalizeExecutorOutcome(task.taskId, outcome);
    }
    const rawHandle = await raceWithOperationSignal(
      Promise.resolve(target.executor.spawn(request, control)),
      signal,
      deadlineAt,
    );
    this.#assertRawHandle(task, rawHandle);
    if (operation.type !== 'reconnect') {
      throw createSubAgentError(
        'INTERNAL_ERROR',
        'A recovered spawn operation must use reconnect semantics.',
      );
    }
    validateBinding(rawHandle.binding, task.taskId, this.sessionId, target);
    if (
      rawHandle.binding.subagentSessionId !== task.subagentSessionId ||
      !isDeepStrictEqual(rawHandle.binding, operation.binding)
    ) {
      throw createSubAgentError(
        'BINDING_INVALID',
        'The reconnected Executor handle does not match the persisted binding.',
      );
    }
    const active = this.#active.get(task.taskId);
    if (active !== undefined) active.rawHandle = rawHandle;
    await this.#appendExecutorEvent(
      task.taskId,
      target,
      task.attempt,
      { type: 'recovery.reconnected', data: { status: task.state } },
      signal,
      deadlineAt,
    );
    const pending = Promise.resolve(rawHandle.wait());
    pending.catch(() => undefined);
    const outcome = await raceWithOperationSignal(pending, signal, deadlineAt);
    return this.#normalizeExecutorOutcome(task.taskId, outcome);
  }

  async #loadTask(taskId: string): Promise<StoredTask> {
    assertNonEmpty(taskId, 'taskId');
    const task = await this.stateStore.loadTask(this.sessionId, taskId);
    if (task === undefined) throw createResourceNotFoundError();
    return task;
  }

  async #loadRun(runId: string): Promise<StoredAgentRun> {
    const run = await this.stateStore.loadRun(this.sessionId, runId);
    if (run === undefined) throw createResourceNotFoundError();
    return run;
  }

  #emitTelemetry(event: Parameters<AgentTelemetrySink['emit']>[0]): void {
    try {
      void Promise.resolve(this.#telemetry.emit(event)).catch(() => undefined);
    } catch {
      // Telemetry is observational and cannot change task state.
    }
  }
}

function assertSessionId(value: string): void {
  assertNonEmpty(value, 'sessionId');
}

function normalizeRuntimeDefinition(
  definition: SubAgentDefinitionRegistration,
): SubAgentDefinition {
  return defineSubAgent(definition as unknown as SubAgentDefinition);
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function stateCasConflict(): SubAgentRuntimeError {
  return createSubAgentError(
    'INVALID_STATE_TRANSITION',
    'The state mutation lost its revision or fencing CAS.',
    { retryable: true, causeCode: 'STATE_CAS_CONFLICT' },
  );
}

function validateBinding(
  binding: SubAgentExecutorBinding,
  taskId: string,
  ownerSessionId: string,
  target: SubAgentExecutionTarget,
): void {
  const valid =
    typeof binding === 'object' &&
    binding !== null &&
    binding.taskId === taskId &&
    binding.ownerSessionId === ownerSessionId &&
    binding.executorName === target.descriptor.name &&
    binding.definitionName === target.definition.name &&
    binding.definitionVersion === target.definition.version;
  if (!valid) {
    throw createSubAgentError('BINDING_INVALID', 'The Executor binding identity is invalid.');
  }
  if (
    binding.adapterStateVersion !== target.descriptor.adapterStateVersion ||
    binding.adapterStateVersion !== target.executor.bindingCodec.adapterStateVersion
  ) {
    throw createSubAgentError(
      'ADAPTER_STATE_VERSION_MISMATCH',
      'The Executor binding adapter state version is unavailable.',
    );
  }
  assertNonEmpty(binding.subagentSessionId, 'binding subagentSessionId');
  assertJsonValue(binding.recoveryData);
  try {
    target.executor.bindingCodec.decode(binding.recoveryData);
  } catch {
    throw createSubAgentError('BINDING_INVALID', 'The Executor binding payload is invalid.');
  }
}

function validateApprovalRequestInput(input: ApprovalRequestInput): void {
  assertNonEmpty(input.callId, 'approval callId');
  assertNonEmpty(input.toolName, 'approval toolName');
  assertNonEmpty(input.summary, 'approval summary');
  if (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt)) {
    throw new TypeError('approval expiresAt must be a finite timestamp.');
  }
}

function validateApprovalDecisionSet(
  task: StoredTask,
  decisions: readonly ApprovalDecision[],
): void {
  if (task.state !== 'waiting_approval' || task.approvals.length === 0) {
    throw createSubAgentError(
      'INVALID_STATE_TRANSITION',
      'Approval decisions require a waiting task with pending approvals.',
    );
  }
  const pendingIds = new Set(task.approvals.map(({ approvalId }) => approvalId));
  const decisionIds = decisions.map(({ approvalId }) => approvalId);
  const uniqueDecisionIds = new Set(decisionIds);
  if (
    decisions.length !== task.approvals.length ||
    uniqueDecisionIds.size !== decisions.length ||
    decisionIds.some((approvalId) => !pendingIds.has(approvalId))
  ) {
    throw createSubAgentError(
      'APPROVAL_REQUIRED',
      'Resume requires exactly one decision for every current approval request.',
    );
  }
}

function validateUsageDelta(delta: SubAgentUsageDelta): void {
  for (const key of ['turns', 'providerCalls', 'inputTokens', 'outputTokens'] as const) {
    const value = delta[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`Subagent usage ${key} must be a non-negative safe integer.`);
    }
  }
  if (delta.cost !== undefined && (!Number.isFinite(delta.cost) || delta.cost < 0)) {
    throw new RangeError('Subagent usage cost must be a non-negative finite number.');
  }
}

function validateCheckpointConfiguration(
  codecs: readonly AgentProtocolCheckpointCodec[],
  migrators: readonly AgentCheckpointMigrator[],
): void {
  const codecKeys = new Set<string>();
  for (const codec of codecs) {
    assertNonEmpty(codec.protocol, 'checkpoint codec protocol');
    assertNonEmpty(codec.version, 'checkpoint codec version');
    if (typeof codec.encode !== 'function' || typeof codec.decode !== 'function') {
      throw new TypeError('Checkpoint codecs require encode and decode functions.');
    }
    const key = `${codec.protocol}\u0000${codec.version}`;
    if (codecKeys.has(key)) throw new TypeError(`Duplicate checkpoint codec ${key}.`);
    codecKeys.add(key);
  }
  const migratorKeys = new Set<string>();
  for (const migrator of migrators) {
    assertNonEmpty(migrator.fromVersion, 'checkpoint migrator fromVersion');
    assertNonEmpty(migrator.toVersion, 'checkpoint migrator toVersion');
    if (migrator.fromVersion === migrator.toVersion || typeof migrator.migrate !== 'function') {
      throw new TypeError('Checkpoint migrators require distinct versions and migrate().');
    }
    const key = `${migrator.recordKind}\u0000${migrator.fromVersion}\u0000${migrator.toVersion}`;
    if (migratorKeys.has(key)) throw new TypeError(`Duplicate checkpoint migrator ${key}.`);
    migratorKeys.add(key);
  }
}

function taskSnapshot(task: StoredTask): SubAgentTaskSnapshot {
  return Object.freeze({
    taskId: task.taskId,
    subAgent: Object.freeze({ ...task.definition }),
    ownerSessionId: task.ownerSessionId,
    runId: task.runId,
    subagentSessionId: task.subagentSessionId,
    ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
    path: Object.freeze([...task.path]),
    executor: task.executor,
    state: task.state,
    revision: task.revision,
    attempt: task.attempt,
    ...(task.retryOf === undefined ? {} : { retryOf: task.retryOf }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.activeStartedAt === undefined ? {} : { startedAt: task.activeStartedAt }),
    ...(task.terminalAt === undefined ? {} : { completedAt: task.terminalAt }),
    recoveryRequired: task.recoveryRequired,
    ...(task.error?.outcomeUnknown === undefined
      ? {}
      : { outcomeUnknown: task.error.outcomeUnknown }),
    ...(task.usage === undefined ? {} : { usage: task.usage }),
    ...(task.error === undefined ? {} : { error: sanitizeResultError(task.error) }),
  });
}

function sanitizeResultError(error: SubAgentErrorDescriptor): SubAgentErrorDescriptor {
  const code = SUBAGENT_ERROR_CODES.includes(error.code) ? error.code : 'EXECUTOR_FAILED';
  return Object.freeze({
    code,
    message:
      typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : 'The subagent execution failed.',
    retryable: error.retryable === true,
    ...(error.causeCode === undefined ? {} : { causeCode: error.causeCode }),
    ...(error.outcomeUnknown === undefined ? {} : { outcomeUnknown: error.outcomeUnknown }),
    ...(error.eventCursor === undefined ? {} : { eventCursor: error.eventCursor }),
  });
}
