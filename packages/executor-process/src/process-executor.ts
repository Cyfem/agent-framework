import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { types as nodeTypes } from 'node:util';

import {
  DEFAULT_EXECUTOR_MAX_BINDING_BYTES,
  DEFAULT_EXECUTOR_MAX_EVENT_PAGE_SIZE,
  SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES,
  SubAgentRuntimeError,
  SubAgentTransportTaskHandleRegistry,
  assertJsonValue,
  canonicalJsonSha256,
  canonicalizeJson,
  createResourceNotFoundError,
  createSubAgentTransportExecutorBridge,
  createSubAgentTransportPeer,
  decodeSubAgentTransportRpcFrame,
  parseJsonValue,
  type ExecutorAvailabilityProbe,
  type ExecutorTaskHandle,
  type ExecutorTaskSnapshot,
  type JsonValue,
  type SubAgentChildCheckpoint,
  type SubAgentDefinitionRef,
  type SubAgentExecutionControl,
  type SubAgentExecutionOutcome,
  type SubAgentExecutionRequest,
  type SubAgentExecutor,
  type SubAgentExecutorBinding,
  type SubAgentExecutorDescriptor,
  type SubAgentExecutorOperationResult,
  type SubAgentExecutorRecoveryRequired,
  type SubAgentTargetRunnerManifest,
  type SubAgentTaskEvent,
  type SubAgentTaskHandle,
  type SubAgentTransportControllerEvents,
  type SubAgentTransportModelRequestHandler,
  type SubAgentTransportPeer,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportTaskHandleResolver,
} from '@ruixutong.manee/maneeagent-framework';

import {
  decodeProcessBinding,
  PROCESS_SUBAGENT_ADAPTER_STATE_VERSION,
  processSubAgentBindingCodec,
} from './process-binding';
import {
  decodeProcessMessage,
  decodeProcessPacket,
  encodeProcessPacket,
  estimateProcessPacketBytes,
  PROCESS_SUBAGENT_CHANNEL_VERSION,
  createProcessSubAgentIpcWriter,
  type ProcessSubAgentIpcWriter,
  type ProcessSubAgentBootstrapData,
} from './process-protocol';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 5_000;
const MAX_TERMINATE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETAINED_TASKS = 10_000;
const DEFAULT_MAX_CONCURRENT_PROCESSES = 64;
const MAX_CAPTURED_STREAM_BYTES = 64 * 1024;
const MAX_CANCEL_RECEIPTS_PER_TASK = 64;
const MAX_ACTIVE_PROCESS_MESSAGES = 64;
const PROCESS_DISCONNECT_EXIT_GRACE_MS = 50;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ProcessSubAgentExecutorOptions {
  readonly targetEntry: URL;
  readonly expectedManifest: SubAgentTargetRunnerManifest;
  readonly model: SubAgentTransportModelRequestHandler;
  readonly name?: string;
  readonly description?: string;
  readonly useCases?: readonly string[];
  readonly handshakeTimeoutMs?: number;
  /** Bounded graceful cancellation window; it cannot exceed the fixed five-second Oracle. */
  readonly terminateTimeoutMs?: number;
  readonly maxRetainedTasks?: number;
  readonly maxConcurrentProcesses?: number;
  readonly events?: SubAgentTransportControllerEvents;
  readonly resolveNestedTaskHandle?: SubAgentTransportTaskHandleResolver<SubAgentTaskHandle>;
}

export interface ProcessSubAgentExecutorDiagnostics {
  readonly activeProcesses: number;
  readonly startingProcesses: number;
  readonly retainedTasks: number;
  readonly cancelReceipts: number;
  readonly channels: number;
  readonly timers: number;
  readonly terminations: number;
  readonly crashes: number;
  readonly capturedOutputBytes: number;
  readonly draining: boolean;
  readonly disposed: boolean;
}

interface RetainedProcessTask {
  readonly ownerSessionId: string;
  readonly taskId: string;
  readonly jobId: string;
  readonly stableTaskIdentity: string;
  readonly createdAt: number;
  updatedAt: number;
  executionAttempt: number;
  executionEpoch: string;
  executionFencingToken: string;
  deadlineAt: number;
  executionRemainingMs: number;
  session?: ProcessTaskSession;
  binding?: SubAgentExecutorBinding;
  latestCheckpoint?: SubAgentChildCheckpoint;
  internalRecoveryExecutionEpoch?: string;
  createIdentity?: string;
  residentRequestIdentity?: string;
  residentMode?: ProcessOperationMode;
  terminalRequestIdentity?: string;
  terminalMode?: 'execute' | 'spawn';
  terminal?: SubAgentExecutionOutcome;
  terminalBinding?: SubAgentExecutorBinding;
  lastSettlement?: SubAgentExecutorOperationResult;
  lastSessionCrashed?: boolean;
  failure?: SubAgentRuntimeError;
  executionScopeWatch?: ProcessExecutionScopeWatch;
  executionScopeCleanup?: ProcessExecutionScopeCleanup;
  readonly cancelOperations: Map<string, ProcessCancelReceipt>;
}

interface ProcessExecutionScopeWatch {
  readonly session: ProcessTaskSession;
  readonly signals: readonly AbortSignal[];
  readonly onAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
  disposed: boolean;
}

interface ProcessExecutionScopeCleanup {
  readonly session: ProcessTaskSession;
  readonly promise: Promise<void>;
}

interface ProcessExecutionScopeIdentity {
  readonly attempt: number;
  readonly executionEpoch: string;
  readonly executionFencingToken: string;
}

interface ProcessCancelReceipt {
  readonly identity: string;
  readonly promise: Promise<void>;
}

interface ProcessSessionOptions {
  readonly targetEntry: URL;
  readonly expectedManifest: SubAgentTargetRunnerManifest;
  readonly descriptor: SubAgentExecutorDescriptor;
  readonly task: RetainedProcessTask;
  readonly model: SubAgentTransportModelRequestHandler;
  readonly handshakeTimeoutMs: number;
  readonly terminateTimeoutMs: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly nestedTaskHandles: SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>;
  readonly events?: SubAgentTransportControllerEvents;
  readonly resolveNestedTaskHandle?: SubAgentTransportTaskHandleResolver<SubAgentTaskHandle>;
  readonly onTimerAdded: (timer: ReturnType<typeof setTimeout>) => void;
  readonly onTimerRemoved: (timer: ReturnType<typeof setTimeout>) => void;
  readonly onTerminated: (session: ProcessTaskSession) => void;
  readonly onCrash: (session: ProcessTaskSession) => void;
  readonly onSettlement: (
    task: RetainedProcessTask,
    outcome: SubAgentExecutorOperationResult,
    session: ProcessTaskSession,
  ) => void | Promise<void>;
}

type ProcessOperationMode = 'execute' | 'spawn';

type ActiveProcessOperation =
  | {
      readonly mode: 'execute';
      readonly identity: string;
      readonly control: SubAgentExecutionControl;
      readonly promise: Promise<SubAgentExecutorOperationResult>;
    }
  | {
      readonly mode: 'spawn';
      readonly identity: string;
      readonly control: SubAgentExecutionControl;
      readonly promise: Promise<ExecutorTaskHandle | SubAgentExecutorRecoveryRequired>;
    };

/** Official child_process placement. A statically selected, trusted entry serves one task. */
export class ProcessSubAgentExecutor implements SubAgentExecutor {
  readonly descriptor: SubAgentExecutorDescriptor;
  readonly bindingCodec = processSubAgentBindingCodec;

  readonly #targetEntry: URL;
  readonly #expectedManifest: SubAgentTargetRunnerManifest;
  readonly #model: SubAgentTransportModelRequestHandler;
  readonly #handshakeTimeoutMs: number;
  readonly #terminateTimeoutMs: number;
  readonly #maxRetainedTasks: number;
  readonly #maxConcurrentProcesses: number;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #events: SubAgentTransportControllerEvents | undefined;
  readonly #resolveNestedTaskHandle:
    | SubAgentTransportTaskHandleResolver<SubAgentTaskHandle>
    | undefined;
  readonly #nestedTaskHandles = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
  readonly #tasks = new Map<string, RetainedProcessTask>();
  readonly #activeOperations = new Map<string, ActiveProcessOperation>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #draining = false;
  #disposed = false;
  #terminations = 0;
  #crashes = 0;
  #capturedOutputBytes = 0;

  constructor(options: ProcessSubAgentExecutorOptions) {
    if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
      throw new TypeError('Process Executor options must be a trusted host object.');
    }
    assertExecutorOptions(options);
    this.#targetEntry = normalizeTargetEntry(options.targetEntry);
    this.#expectedManifest = normalizeTargetManifest(options.expectedManifest);
    if (typeof options.model !== 'function') {
      throw new TypeError('Process Executor requires a controller Model request handler.');
    }
    this.#model = options.model;
    this.#handshakeTimeoutMs = positiveIntegerAtMost(
      options.handshakeTimeoutMs,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      MAX_HANDSHAKE_TIMEOUT_MS,
      'handshakeTimeoutMs',
    );
    this.#terminateTimeoutMs = nonNegativeIntegerAtMost(
      options.terminateTimeoutMs,
      DEFAULT_TERMINATE_TIMEOUT_MS,
      MAX_TERMINATE_TIMEOUT_MS,
      'terminateTimeoutMs',
    );
    this.#maxRetainedTasks = positiveInteger(
      options.maxRetainedTasks,
      DEFAULT_MAX_RETAINED_TASKS,
      'maxRetainedTasks',
    );
    this.#maxConcurrentProcesses = positiveInteger(
      options.maxConcurrentProcesses,
      DEFAULT_MAX_CONCURRENT_PROCESSES,
      'maxConcurrentProcesses',
    );
    this.#environment = createMinimalProcessEnvironment();
    this.#events = options.events;
    this.#resolveNestedTaskHandle = options.resolveNestedTaskHandle;
    const name = options.name ?? 'process';
    assertIdentifier(name, 'Process Executor name');
    const runnerCompatibility = Object.freeze(
      this.#expectedManifest.registrations.map(({ runner }) => runner),
    );
    const checkpointVersions = Object.freeze([
      ...new Set(
        runnerCompatibility.flatMap(({ childCheckpointVersions }) => childCheckpointVersions),
      ),
    ]);
    this.descriptor = Object.freeze({
      runtimeProtocolVersion: '1' as const,
      taskRecordVersions: Object.freeze(['1']),
      childCheckpointVersions: checkpointVersions,
      runnerCompatibility,
      name,
      description:
        options.description ?? 'Execute one trusted child Agent in a dedicated child process.',
      useCases: Object.freeze([
        ...(options.useCases ?? ['Isolate trusted child Agent state in a separate OS process.']),
      ]),
      capabilities: Object.freeze({
        execute: true as const,
        spawn: true,
        cancel: true,
        events: true,
        approval: true,
        usage: 'provider' as const,
        recovery: Object.freeze({ resume: 'checkpoint' as const, reconnect: 'none' as const }),
      }),
      adapterStateVersion: PROCESS_SUBAGENT_ADAPTER_STATE_VERSION,
      maxBindingBytes: DEFAULT_EXECUTOR_MAX_BINDING_BYTES,
      maxEventPageSize: DEFAULT_EXECUTOR_MAX_EVENT_PAGE_SIZE,
    });
  }

  getAvailability(): ExecutorAvailabilityProbe {
    const processCapacityExhausted = this.#liveProcessCount() >= this.#maxConcurrentProcesses;
    const retentionCapacityExhausted = this.#tasks.size >= this.#maxRetainedTasks;
    const unavailable =
      this.#disposed || this.#draining || processCapacityExhausted || retentionCapacityExhausted;
    return Object.freeze({
      status: unavailable ? 'unavailable' : 'available',
      ...(unavailable
        ? {
            reasonCode: processCapacityExhausted
              ? 'PROCESS_CAPACITY'
              : retentionCapacityExhausted
                ? 'PROCESS_RETENTION_CAPACITY'
                : 'PROCESS_DRAINING',
          }
        : {}),
      supportedDefinitions: Object.freeze(
        this.#expectedManifest.registrations.map(({ definition }) => definition),
      ),
    });
  }

  supports(definition: SubAgentDefinitionRef): boolean {
    return this.#expectedManifest.registrations.some(
      ({ definition: candidate }) =>
        candidate.name === definition.name && candidate.version === definition.version,
    );
  }

  diagnostics(): Readonly<ProcessSubAgentExecutorDiagnostics> {
    const sessions = [...this.#tasks.values()].map(({ session }) => session).filter(isDefined);
    return Object.freeze({
      activeProcesses: sessions.filter(({ ready, closed }) => ready && !closed).length,
      startingProcesses: sessions.filter(({ ready, closed }) => !ready && !closed).length,
      retainedTasks: this.#tasks.size,
      cancelReceipts: [...this.#tasks.values()].reduce(
        (total, task) => total + task.cancelOperations.size,
        0,
      ),
      channels: sessions.filter(({ channelClosed }) => !channelClosed).length,
      timers: this.#timers.size,
      terminations: this.#terminations,
      crashes: this.#crashes,
      capturedOutputBytes: sessions.reduce(
        (total, session) => total + session.capturedOutputBytes,
        this.#capturedOutputBytes,
      ),
      draining: this.#draining,
      disposed: this.#disposed,
    });
  }

  async execute(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<SubAgentExecutorOperationResult> {
    const ownedRequest = normalizeExecutionRequestBinding(
      request,
      this.descriptor.name,
      this.descriptor.maxBindingBytes,
    );
    assertProcessOperationSupported(ownedRequest);
    const identity = executionRequestIdentity(ownedRequest);
    const active = this.#admitOperation(ownedRequest, control, 'execute', identity);
    if (active !== undefined) {
      if (active.mode !== 'execute') throw invalidActiveOperation();
      return active.promise;
    }
    const promise = this.#executeOnce(ownedRequest, control);
    const owned: ActiveProcessOperation = { mode: 'execute', identity, control, promise };
    this.#activeOperations.set(ownedRequest.taskId, owned);
    try {
      return await promise;
    } finally {
      if (this.#activeOperations.get(ownedRequest.taskId) === owned) {
        this.#activeOperations.delete(ownedRequest.taskId);
      }
    }
  }

  async #executeOnce(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<SubAgentExecutorOperationResult> {
    let task: RetainedProcessTask;
    try {
      task = await this.#prepareTask(request, control);
    } catch (error) {
      const retained = this.#tasks.get(request.taskId);
      if (isSessionStartupCrash(retained, error)) {
        const mapped = await this.#recoverOrMapExecuteFailure(retained, request, control, error);
        return mapped;
      }
      throw error;
    }
    if (task.terminal !== undefined) return task.terminal;
    this.#rememberResidentOperation(task, request, 'execute');
    const session = task.session as ProcessTaskSession;
    await this.#activateExecutionScope(task, session, request, control);
    const trackedControl = this.#trackControl(task, control, session);
    try {
      const outcome = await session.bridge.execute(
        transportExecutionRequest(request),
        trackedControl,
      );
      if (outcome.type === 'terminal') await this.#settleTerminal(task, outcome);
      else await this.#stopSettledSession(task, session);
      return outcome;
    } catch (error) {
      return this.#recoverOrMapExecuteFailure(task, request, control, error);
    }
  }

  async spawn(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<ExecutorTaskHandle | SubAgentExecutorRecoveryRequired> {
    const ownedRequest = normalizeExecutionRequestBinding(
      request,
      this.descriptor.name,
      this.descriptor.maxBindingBytes,
    );
    assertProcessOperationSupported(ownedRequest);
    const identity = executionRequestIdentity(ownedRequest);
    const active = this.#admitOperation(ownedRequest, control, 'spawn', identity);
    if (active !== undefined) {
      if (active.mode !== 'spawn') throw invalidActiveOperation();
      return active.promise;
    }
    const promise = this.#spawnOnce(ownedRequest, control);
    const owned: ActiveProcessOperation = { mode: 'spawn', identity, control, promise };
    this.#activeOperations.set(ownedRequest.taskId, owned);
    try {
      return await promise;
    } finally {
      if (this.#activeOperations.get(ownedRequest.taskId) === owned) {
        this.#activeOperations.delete(ownedRequest.taskId);
      }
    }
  }

  async #spawnOnce(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<ExecutorTaskHandle | SubAgentExecutorRecoveryRequired> {
    let task: RetainedProcessTask;
    try {
      task = await this.#prepareTask(request, control);
    } catch (error) {
      const retained = this.#tasks.get(request.taskId);
      if (isSessionStartupCrash(retained, error)) {
        return this.#recoverOrMapSpawnFailure(retained, request, control, error);
      }
      throw error;
    }
    if (task.terminal !== undefined && task.terminalBinding !== undefined) {
      return this.#terminalHandle(task, task.terminalBinding);
    }
    this.#rememberResidentOperation(task, request, 'spawn');
    const session = task.session as ProcessTaskSession;
    await this.#activateExecutionScope(task, session, request, control);
    const trackedControl = this.#trackControl(task, control, session);
    try {
      const raw = await session.bridge.spawn(transportExecutionRequest(request), trackedControl);
      if (isRecoveryRequired(raw)) return raw;
      task.binding = raw.binding;
      this.#monitorSpawn(task, raw);
      return this.#wrapHandle(task, raw, request, control, session);
    } catch (error) {
      return this.#recoverOrMapSpawnFailure(task, request, control, error);
    }
  }

  #admitOperation(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
    mode: ProcessOperationMode,
    identity: string,
  ): ActiveProcessOperation | undefined {
    const task = this.#tasks.get(request.taskId);
    if (task !== undefined && task.ownerSessionId !== request.ownerSessionId) {
      throw createResourceNotFoundError();
    }
    const active = this.#activeOperations.get(request.taskId);
    if (active !== undefined) {
      if (active.identity !== identity) {
        throw new SubAgentRuntimeError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The Process task already has a conflicting active operation.',
          retryable: false,
        });
      }
      if (active.mode !== mode || active.control !== control) throw invalidActiveOperation();
      return active;
    }
    if (task?.terminal !== undefined) {
      if (task.terminalRequestIdentity !== identity) {
        throw new SubAgentRuntimeError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The Process terminal task cannot be replayed with another request.',
          retryable: false,
        });
      }
      if (task.terminalMode !== mode) throw invalidActiveOperation();
    }
    if (task?.session !== undefined && !task.session.closed) {
      if (request.operation.type === 'create') {
        throw new SubAgentRuntimeError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The Process create operation is already resident in a live Process.',
          retryable: false,
        });
      }
      throw invalidActiveOperation();
    }
    return undefined;
  }

  #rememberResidentOperation(
    task: RetainedProcessTask,
    request: SubAgentExecutionRequest,
    mode: ProcessOperationMode,
  ): void {
    task.residentRequestIdentity = executionRequestIdentity(request);
    task.residentMode = mode;
    delete task.lastSettlement;
  }

  async cancel(
    binding: SubAgentExecutorBinding,
    options: {
      readonly operationId: string;
      readonly reason?: string;
      readonly signal: AbortSignal;
      readonly deadlineAt: number;
    },
  ): Promise<void> {
    const ownedBinding = normalizeProcessBinding(
      binding,
      this.descriptor.name,
      this.descriptor.maxBindingBytes,
    );
    assertTransportIdentifier(options.operationId, 'Process cancel operationId');
    const task = this.#tasks.get(ownedBinding.taskId);
    if (task === undefined || task.ownerSessionId !== ownedBinding.ownerSessionId) {
      throw createResourceNotFoundError();
    }
    const state = decodeProcessBinding(ownedBinding.recoveryData);
    if (
      state.jobId !== task.jobId ||
      ownedBinding.executorName !== this.descriptor.name ||
      task.binding === undefined ||
      !bindingsEqual(task.binding, ownedBinding)
    ) {
      throw new SubAgentRuntimeError({
        code: 'BINDING_INVALID',
        message: 'The Process binding does not match its logical task.',
        retryable: false,
      });
    }
    const identity = canonicalJsonSha256({
      binding: ownedBinding as unknown as JsonValue,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    const existing = task.cancelOperations.get(options.operationId);
    if (existing !== undefined) {
      if (existing.identity !== identity) {
        throw new SubAgentRuntimeError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The Process cancel operationId was reused with a conflicting payload.',
          retryable: false,
        });
      }
      return existing.promise;
    }
    options.signal.throwIfAborted();
    this.#reserveCancelReceipt(task);
    const promise = this.#cancelOwned(task, ownedBinding, options);
    const receipt: ProcessCancelReceipt = { identity, promise };
    task.cancelOperations.set(options.operationId, receipt);
    return promise;
  }

  async #cancelOwned(
    task: RetainedProcessTask,
    binding: SubAgentExecutorBinding,
    options: {
      readonly operationId: string;
      readonly reason?: string;
      readonly signal: AbortSignal;
      readonly deadlineAt: number;
    },
  ): Promise<void> {
    if (task.terminal !== undefined) return;
    this.#forgetNestedTaskScope(task);
    const session = task.session;
    if (session === undefined || session.closed) {
      throw new SubAgentRuntimeError({
        code: 'RECOVERY_TARGET_LOST',
        message: 'The Process task is no longer resident.',
        retryable: false,
      });
    }
    this.#clearExecutionScopeWatch(task, session);
    const killDeadline = Math.min(options.deadlineAt, Date.now() + this.#terminateTimeoutMs);
    let cancellationError: unknown;
    try {
      await session.bridge.cancel(binding, { ...options, deadlineAt: killDeadline });
    } catch (error) {
      cancellationError = error;
    }
    const settled = await session.waitForTerminal(Math.max(0, killDeadline - Date.now()));
    const shutdownBudget = Math.max(0, killDeadline - Date.now());
    if (settled && shutdownBudget > 0) await session.stop(shutdownBudget);
    else {
      task.failure = cancelledError();
      await session.forceTerminate();
    }
    this.#releaseSession(task, session);
    if (cancellationError !== undefined) throw cancellationError;
  }

  #reserveCancelReceipt(task: RetainedProcessTask): void {
    if (task.cancelOperations.size < MAX_CANCEL_RECEIPTS_PER_TASK) return;
    throw new SubAgentRuntimeError({
      code: 'LIMIT_EXCEEDED',
      message: 'The Process task cancel receipt capacity is exhausted.',
      retryable: false,
    });
  }

  async drain(): Promise<void> {
    this.#draining = true;
  }

  async dispose(): Promise<void> {
    if (this.#disposed && this.#tasks.size === 0) return;
    this.#disposed = true;
    this.#draining = true;
    for (const task of this.#tasks.values()) this.#clearExecutionScopeWatch(task);
    const sessions = [...this.#tasks.values()].map(({ session }) => session).filter(isDefined);
    await Promise.allSettled(sessions.map((session) => session.stop()));
    const stillOpen = sessions.filter(({ closed }) => !closed);
    if (stillOpen.length > 0) {
      await Promise.allSettled(stillOpen.map((session) => session.forceTerminate()));
    }
    if (sessions.some(({ closed }) => !closed)) {
      throw new SubAgentRuntimeError({
        code: 'EXECUTOR_UNAVAILABLE',
        message: 'The Process Executor could not close every child process.',
        retryable: false,
      });
    }
    this.#capturedOutputBytes = sessions.reduce(
      (total, session) => Math.min(Number.MAX_SAFE_INTEGER, total + session.capturedOutputBytes),
      this.#capturedOutputBytes,
    );
    for (const task of this.#tasks.values()) this.#forgetNestedTaskScope(task);
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#tasks.clear();
  }

  async #prepareTask(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
    sameExecutionScope = false,
  ): Promise<RetainedProcessTask> {
    if (request.operation.type === 'reconnect') {
      throw new SubAgentRuntimeError({
        code: 'RECOVERY_UNSUPPORTED',
        message: 'Process placement does not support reconnect.',
        retryable: false,
      });
    }
    let task = this.#tasks.get(request.taskId);
    if (task !== undefined && task.ownerSessionId !== request.ownerSessionId) {
      throw createResourceNotFoundError();
    }
    const requestStableTaskIdentity = stableTaskIdentity(request);
    if (task !== undefined && task.stableTaskIdentity !== requestStableTaskIdentity) {
      throw new SubAgentRuntimeError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The Process task request conflicts with its retained logical child identity.',
        retryable: false,
      });
    }
    if (
      task !== undefined &&
      request.operation.type === 'create' &&
      task.createIdentity !== createRequestIdentity(request)
    ) {
      throw new SubAgentRuntimeError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The Process task create operation conflicts with its retained request.',
        retryable: false,
      });
    }
    if (task?.terminal !== undefined) {
      if (request.operation.type === 'resume') {
        this.#normalizeRequestBinding(request, request.operation.binding);
      }
      return task;
    }
    const initialScopeFailure = executionScopeFailure(request, control);
    if (initialScopeFailure !== undefined) throw initialScopeFailure;
    assertExecutionTimeout(request.limits.timeoutMs);
    if (!this.supports(request.definition)) {
      throw new SubAgentRuntimeError({
        code: 'DEFINITION_NOT_FOUND',
        message: 'The Process target does not register this definition version.',
        retryable: false,
      });
    }
    const resumeBinding =
      request.operation.type === 'resume'
        ? this.#normalizeRequestBinding(request, request.operation.binding)
        : undefined;
    const existingSnapshot =
      task === undefined
        ? undefined
        : {
            executionAttempt: task.executionAttempt,
            executionEpoch: task.executionEpoch,
            executionFencingToken: task.executionFencingToken,
            deadlineAt: task.deadlineAt,
            executionRemainingMs: task.executionRemainingMs,
            session: task.session,
            binding: task.binding,
            latestCheckpoint: task.latestCheckpoint,
            lastSessionCrashed: task.lastSessionCrashed,
            failure: task.failure,
          };
    let createdTask = false;
    if (task === undefined) {
      if (this.#disposed || this.#draining) {
        throw new SubAgentRuntimeError({
          code: 'EXECUTOR_UNAVAILABLE',
          message: 'The Process Executor is draining.',
          retryable: false,
        });
      }
      if (this.#liveProcessCount() >= this.#maxConcurrentProcesses) {
        throw new SubAgentRuntimeError({
          code: 'EXECUTOR_UNAVAILABLE',
          message: 'The Process Executor concurrent-process capacity is exhausted.',
          retryable: false,
        });
      }
      const jobId =
        request.operation.type === 'create'
          ? randomUUID()
          : decodeProcessBinding((resumeBinding as SubAgentExecutorBinding).recoveryData).jobId;
      const checkpoint =
        request.operation.type === 'resume'
          ? structuredClone(request.operation.checkpoint)
          : undefined;
      const createIdentity =
        request.operation.type === 'create' ? createRequestIdentity(request) : undefined;
      const candidate: RetainedProcessTask = {
        ownerSessionId: request.ownerSessionId,
        taskId: request.taskId,
        jobId,
        stableTaskIdentity: requestStableTaskIdentity,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        executionAttempt: request.attempt,
        executionEpoch: request.executionEpoch,
        executionFencingToken: request.executionFencingToken,
        deadlineAt: request.deadlineAt,
        executionRemainingMs: request.limits.timeoutMs,
        cancelOperations: new Map<string, ProcessCancelReceipt>(),
        ...(request.operation.type === 'resume'
          ? {
              binding: resumeBinding as SubAgentExecutorBinding,
              latestCheckpoint: checkpoint as SubAgentChildCheckpoint,
            }
          : {}),
        ...(createIdentity === undefined ? {} : { createIdentity }),
      };
      if (this.#tasks.size >= this.#maxRetainedTasks) {
        throw new SubAgentRuntimeError({
          code: 'EXECUTOR_UNAVAILABLE',
          message: 'The Process Executor retained-task capacity is exhausted.',
          retryable: false,
        });
      }
      task = candidate;
      this.#tasks.set(request.taskId, task);
      createdTask = true;
    } else {
      if (request.operation.type === 'create') {
        if (task.terminal !== undefined) return task;
        if (!sameExecutionScope) this.#assertExecutionScopeAdvance(task, request);
      } else {
        const binding = resumeBinding as SubAgentExecutorBinding;
        const state = decodeProcessBinding(binding.recoveryData);
        if (
          state.jobId !== task.jobId ||
          (task.binding !== undefined && !bindingsEqual(task.binding, binding))
        ) {
          throw new SubAgentRuntimeError({
            code: 'BINDING_INVALID',
            message: 'The Process resume binding identifies another logical job.',
            retryable: false,
          });
        }
        if (task.terminal !== undefined) return task;
        if (sameExecutionScope) this.#assertSameExecutionScope(task, request);
        else this.#assertExecutionScopeAdvance(task, request);
      }

      if (
        (task.session === undefined || task.session.closed) &&
        this.#liveProcessCount() >= this.#maxConcurrentProcesses
      ) {
        throw new SubAgentRuntimeError({
          code: 'EXECUTOR_UNAVAILABLE',
          message: 'The Process Executor concurrent-process capacity is exhausted.',
          retryable: false,
        });
      }

      if (!sameExecutionScope) this.#applyExecutionScopeAdvance(task, request);
      if (request.operation.type === 'resume') {
        task.binding ??= resumeBinding as SubAgentExecutorBinding;
        task.latestCheckpoint = structuredClone(request.operation.checkpoint);
      }
    }

    if (task.terminal !== undefined) return task;
    if (task.session === undefined || task.session.closed) {
      try {
        task.session = new ProcessTaskSession({
          targetEntry: this.#targetEntry,
          expectedManifest: this.#expectedManifest,
          descriptor: this.descriptor,
          task,
          model: this.#model,
          handshakeTimeoutMs: this.#handshakeTimeoutMs,
          terminateTimeoutMs: this.#terminateTimeoutMs,
          environment: this.#environment,
          nestedTaskHandles: this.#nestedTaskHandles,
          ...(this.#events === undefined ? {} : { events: this.#events }),
          ...(this.#resolveNestedTaskHandle === undefined
            ? {}
            : { resolveNestedTaskHandle: this.#resolveNestedTaskHandle }),
          onTimerAdded: (timer) => this.#timers.add(timer),
          onTimerRemoved: (timer) => this.#timers.delete(timer),
          onTerminated: (session) => {
            this.#terminations += 1;
            this.#clearExecutionScopeWatch(task, session);
          },
          onCrash: (session) => {
            this.#crashes += 1;
            this.#clearExecutionScopeWatch(task, session);
            if (this.#ownsExecutionScope(task, session)) {
              task.lastSessionCrashed = true;
              if (task.failure === undefined && session.failure !== undefined) {
                task.failure = session.failure;
              }
            }
          },
          onSettlement: (settledTask, outcome, session) =>
            this.#settleProcessOutcome(settledTask, outcome, session),
        });
      } catch (error) {
        this.#rollbackPreparation(task, createdTask, existingSnapshot);
        throw error;
      }
    }
    const startingSession = task.session;
    try {
      await this.#awaitSessionStartup(startingSession, request, control);
    } catch (error) {
      const scopeFailure = executionScopeFailure(request, control);
      if (scopeFailure !== undefined) {
        await startingSession.forceTerminate();
        this.#rollbackPreparation(task, createdTask, existingSnapshot);
        throw scopeFailure;
      }
      if (!startingSession.crashed) {
        await startingSession.stop();
        this.#rollbackPreparation(task, createdTask, existingSnapshot);
      }
      throw error;
    }
    return task;
  }

  async #awaitSessionStartup(
    session: ProcessTaskSession,
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<void> {
    const deadlineAt = Math.min(request.deadlineAt, control.deadlineAt);
    const combinedSignal = AbortSignal.any([request.signal, control.signal]);
    const remaining = deadlineAt - Date.now();
    const failure = executionScopeFailure(request, control);
    if (failure !== undefined || remaining <= 0) throw failure ?? timedOutError();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        combinedSignal.removeEventListener('abort', onAbort);
        if (timer !== undefined) {
          clearTimeout(timer);
          this.#timers.delete(timer);
        }
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = (): void =>
        finish(executionScopeFailure(request, control) ?? cancelledError());
      if (remaining <= this.#handshakeTimeoutMs) {
        timer = setTimeout(() => finish(timedOutError()), remaining);
        this.#timers.add(timer);
      }
      combinedSignal.addEventListener('abort', onAbort, { once: true });
      void session.start().then(() => finish(), finish);
    });
  }

  async #activateExecutionScope(
    task: RetainedProcessTask,
    session: ProcessTaskSession,
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<void> {
    this.#clearExecutionScopeWatch(task);
    const initialFailure = executionScopeFailure(request, control);
    if (initialFailure !== undefined) {
      await this.#expireExecutionScope(task, session, initialFailure);
      throw initialFailure;
    }

    const deadlineAt = Math.min(request.deadlineAt, control.deadlineAt);
    if (!Number.isSafeInteger(deadlineAt)) {
      throw new TypeError('Process execution deadlines must be safe integers.');
    }
    const signals = Object.freeze([...new Set([request.signal, control.signal])]);
    const watch: ProcessExecutionScopeWatch = {
      session,
      signals,
      onAbort: () => {
        const failure = executionScopeFailure(request, control) ?? cancelledError();
        void this.#expireExecutionScope(task, session, failure).catch(() => undefined);
      },
      disposed: false,
    };
    task.executionScopeWatch = watch;
    for (const signal of signals) signal.addEventListener('abort', watch.onAbort, { once: true });

    const armDeadline = (): void => {
      if (watch.disposed || task.executionScopeWatch !== watch) return;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        watch.onAbort();
        return;
      }
      const timer = setTimeout(
        () => {
          this.#timers.delete(timer);
          if (watch.timer === timer) delete watch.timer;
          armDeadline();
        },
        Math.min(remaining, MAX_TIMER_DELAY_MS),
      );
      watch.timer = timer;
      this.#timers.add(timer);
    };
    armDeadline();

    const racedFailure = executionScopeFailure(request, control);
    if (racedFailure !== undefined) {
      await this.#expireExecutionScope(task, session, racedFailure);
      throw racedFailure;
    }
  }

  #clearExecutionScopeWatch(task: RetainedProcessTask, expectedSession?: ProcessTaskSession): void {
    const watch = task.executionScopeWatch;
    if (
      watch === undefined ||
      (expectedSession !== undefined && watch.session !== expectedSession)
    ) {
      return;
    }
    watch.disposed = true;
    for (const signal of watch.signals) signal.removeEventListener('abort', watch.onAbort);
    if (watch.timer !== undefined) {
      clearTimeout(watch.timer);
      this.#timers.delete(watch.timer);
      delete watch.timer;
    }
    delete task.executionScopeWatch;
  }

  async #expireExecutionScope(
    task: RetainedProcessTask,
    session: ProcessTaskSession,
    failure: SubAgentRuntimeError,
  ): Promise<void> {
    const activeCleanup = task.executionScopeCleanup;
    if (activeCleanup?.session === session) return activeCleanup.promise;
    if (!this.#ownsExecutionScope(task, session)) return;
    this.#clearExecutionScopeWatch(task, session);
    const promise = this.#cancelResident(task, failure, session);
    const cleanup: ProcessExecutionScopeCleanup = { session, promise };
    task.executionScopeCleanup = cleanup;
    try {
      await promise;
    } finally {
      if (task.executionScopeCleanup === cleanup) delete task.executionScopeCleanup;
    }
  }

  #rollbackPreparation(
    task: RetainedProcessTask,
    createdTask: boolean,
    snapshot:
      | {
          readonly executionAttempt: number;
          readonly executionEpoch: string;
          readonly executionFencingToken: string;
          readonly deadlineAt: number;
          readonly executionRemainingMs: number;
          readonly session: ProcessTaskSession | undefined;
          readonly binding: SubAgentExecutorBinding | undefined;
          readonly latestCheckpoint: SubAgentChildCheckpoint | undefined;
          readonly lastSessionCrashed: boolean | undefined;
          readonly failure: SubAgentRuntimeError | undefined;
        }
      | undefined,
  ): void {
    if (createdTask || snapshot === undefined) {
      if (this.#tasks.get(task.taskId) === task) this.#tasks.delete(task.taskId);
      return;
    }
    task.executionAttempt = snapshot.executionAttempt;
    task.executionEpoch = snapshot.executionEpoch;
    task.executionFencingToken = snapshot.executionFencingToken;
    task.deadlineAt = snapshot.deadlineAt;
    task.executionRemainingMs = snapshot.executionRemainingMs;
    if (snapshot.session === undefined) delete task.session;
    else task.session = snapshot.session;
    if (snapshot.binding === undefined) delete task.binding;
    else task.binding = snapshot.binding;
    if (snapshot.latestCheckpoint === undefined) delete task.latestCheckpoint;
    else task.latestCheckpoint = snapshot.latestCheckpoint;
    if (snapshot.lastSessionCrashed === undefined) delete task.lastSessionCrashed;
    else task.lastSessionCrashed = snapshot.lastSessionCrashed;
    if (snapshot.failure === undefined) delete task.failure;
    else task.failure = snapshot.failure;
  }

  #assertExecutionScopeAdvance(task: RetainedProcessTask, request: SubAgentExecutionRequest): void {
    if (
      (task.session !== undefined && !task.session.closed) ||
      request.attempt <= task.executionAttempt ||
      request.executionEpoch === task.executionEpoch ||
      parseFencingToken(request.executionFencingToken) <=
        parseFencingToken(task.executionFencingToken) ||
      !Number.isSafeInteger(request.limits.timeoutMs) ||
      request.limits.timeoutMs <= 0 ||
      request.limits.timeoutMs > task.executionRemainingMs
    ) {
      throw new SubAgentRuntimeError({
        code: 'INVALID_STATE_TRANSITION',
        message: 'The Process execution scope did not advance monotonically.',
        retryable: false,
      });
    }
  }

  #applyExecutionScopeAdvance(task: RetainedProcessTask, request: SubAgentExecutionRequest): void {
    task.executionAttempt = request.attempt;
    task.executionEpoch = request.executionEpoch;
    task.executionFencingToken = request.executionFencingToken;
    task.deadlineAt = request.deadlineAt;
    task.executionRemainingMs = request.limits.timeoutMs;
    delete task.lastSessionCrashed;
    delete task.failure;
  }

  #assertSameExecutionScope(task: RetainedProcessTask, request: SubAgentExecutionRequest): void {
    if (
      request.attempt !== task.executionAttempt ||
      request.executionEpoch !== task.executionEpoch ||
      request.executionFencingToken !== task.executionFencingToken ||
      request.deadlineAt !== task.deadlineAt ||
      request.limits.timeoutMs !== task.executionRemainingMs
    ) {
      throw new SubAgentRuntimeError({
        code: 'BINDING_INVALID',
        message: 'The Process internal recovery changed the live execution scope.',
        retryable: false,
      });
    }
  }

  #normalizeRequestBinding(
    request: SubAgentExecutionRequest,
    input: SubAgentExecutorBinding,
  ): SubAgentExecutorBinding {
    if (input.ownerSessionId !== request.ownerSessionId || input.taskId !== request.taskId) {
      throw createResourceNotFoundError();
    }
    assertJsonValue(input, {
      maxBytes: DEFAULT_EXECUTOR_MAX_BINDING_BYTES,
      label: 'Process resume binding',
    });
    const owned = parseJsonValue(canonicalizeJson(input as unknown as JsonValue));
    deepFreezeJson(owned);
    const binding = owned as unknown as SubAgentExecutorBinding;
    const expectedKeys = [
      'adapterStateVersion',
      'definitionName',
      'definitionVersion',
      'executorName',
      'modelBinding',
      'ownerSessionId',
      'recoveryData',
      'runnerId',
      'runnerVersion',
      'subagentSessionId',
      'taskId',
      'version',
    ];
    const expectedModelBinding = binding.modelBinding;
    const registration = this.#expectedManifest.registrations.find(
      ({ definition, runner, modelBinding }) =>
        definition.name === request.definition.name &&
        definition.version === request.definition.version &&
        runner.runnerId === binding.runnerId &&
        runner.runnerVersion === binding.runnerVersion &&
        modelBinding !== undefined &&
        expectedModelBinding !== undefined &&
        modelBinding.gatewayId === expectedModelBinding.gatewayId &&
        modelBinding.protocol === expectedModelBinding.protocol &&
        modelBinding.codecVersion === expectedModelBinding.codecVersion,
    );
    if (
      Object.keys(binding).sort().join(',') !== expectedKeys.join(',') ||
      binding.version !== '1' ||
      binding.executorName !== this.descriptor.name ||
      binding.subagentSessionId !== request.subagentSessionId ||
      binding.definitionName !== request.definition.name ||
      binding.definitionVersion !== request.definition.version ||
      binding.adapterStateVersion !== PROCESS_SUBAGENT_ADAPTER_STATE_VERSION ||
      binding.modelBinding === undefined ||
      registration === undefined ||
      request.operation.type !== 'resume' ||
      request.operation.checkpoint.runnerId !== binding.runnerId ||
      request.operation.checkpoint.runnerVersion !== binding.runnerVersion
    ) {
      throw new SubAgentRuntimeError({
        code: 'BINDING_INVALID',
        message: 'The Process resume binding does not match the trusted execution identity.',
        retryable: false,
      });
    }
    decodeProcessBinding(binding.recoveryData);
    return binding;
  }

  #trackControl(
    task: RetainedProcessTask,
    control: SubAgentExecutionControl,
    session: ProcessTaskSession,
  ): SubAgentExecutionControl {
    return Object.freeze({
      signal: control.signal,
      deadlineAt: control.deadlineAt,
      delegation: control.delegation,
      ...(control.artifacts === undefined ? {} : { artifacts: control.artifacts }),
      completion: control.completion,
      commitBinding: async (
        operationId: Parameters<SubAgentExecutionControl['commitBinding']>[0],
        binding: Parameters<SubAgentExecutionControl['commitBinding']>[1],
      ) => {
        if (!this.#ownsExecutionScope(task, session)) throw staleTaskHandleError();
        await control.commitBinding(operationId, binding);
        if (!this.#ownsExecutionScope(task, session)) throw staleTaskHandleError();
        task.binding = binding;
        task.updatedAt = Date.now();
      },
      commitCheckpoint: async (
        operationId: Parameters<SubAgentExecutionControl['commitCheckpoint']>[0],
        checkpoint: Parameters<SubAgentExecutionControl['commitCheckpoint']>[1],
      ) => {
        if (!this.#ownsExecutionScope(task, session)) throw staleTaskHandleError();
        await control.commitCheckpoint(operationId, checkpoint);
        if (!this.#ownsExecutionScope(task, session)) throw staleTaskHandleError();
        task.latestCheckpoint = structuredClone(checkpoint);
        task.updatedAt = Date.now();
      },
      authorizeTool: (...args: Parameters<SubAgentExecutionControl['authorizeTool']>) =>
        control.authorizeTool(...args),
      pauseDelegation: (...args: Parameters<SubAgentExecutionControl['pauseDelegation']>) =>
        control.pauseDelegation(...args),
      reportProgress: (...args: Parameters<SubAgentExecutionControl['reportProgress']>) =>
        control.reportProgress(...args),
      consumeBudget: (...args: Parameters<SubAgentExecutionControl['consumeBudget']>) =>
        control.consumeBudget(...args),
      emit: (...args: Parameters<SubAgentExecutionControl['emit']>) => control.emit(...args),
    });
  }

  async #settleProcessOutcome(
    task: RetainedProcessTask,
    outcome: SubAgentExecutorOperationResult,
    session: ProcessTaskSession,
  ): Promise<void> {
    if (!this.#ownsExecutionScope(task, session)) return;
    this.#clearExecutionScopeWatch(task, session);
    task.lastSettlement = outcome;
    task.updatedAt = Date.now();
    if (outcome.type === 'terminal') {
      await this.#settleTerminal(task, outcome, false);
    }
  }

  async #settleTerminal(
    task: RetainedProcessTask,
    outcome: SubAgentExecutionOutcome,
    stopSession = true,
  ): Promise<void> {
    if (outcome.type !== 'terminal') return;
    task.terminal ??= outcome;
    const active = this.#activeOperations.get(task.taskId);
    if (active !== undefined) {
      task.terminalRequestIdentity ??= active.identity;
      task.terminalMode ??= active.mode;
    } else {
      if (task.residentRequestIdentity !== undefined) {
        task.terminalRequestIdentity ??= task.residentRequestIdentity;
      }
      if (task.residentMode !== undefined) task.terminalMode ??= task.residentMode;
    }
    if (task.terminalBinding === undefined && task.binding !== undefined) {
      task.terminalBinding = task.binding;
    }
    delete task.latestCheckpoint;
    delete task.lastSettlement;
    delete task.lastSessionCrashed;
    delete task.failure;
    delete task.residentRequestIdentity;
    delete task.residentMode;
    task.updatedAt = Date.now();
    this.#forgetNestedTaskScope(task);
    const session = task.session;
    if (stopSession && session !== undefined) {
      if (!session.closed) await session.stop();
      this.#releaseSession(task, session);
    }
  }

  async #recoverOrMapExecuteFailure(
    task: RetainedProcessTask,
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
    error: unknown,
  ): Promise<SubAgentExecutorOperationResult> {
    if (executionScopeFailure(request, control) !== undefined) {
      return this.#mapExecutionFailure(task, request, control, error);
    }
    const bindingFailure = bindingIntegrityFailure(task, error);
    if (bindingFailure !== undefined) {
      this.#forgetNestedTaskScope(task);
      await this.#stopRejectedSession(task);
      throw bindingFailure;
    }
    if (!this.#canInternallyRecover(task, request)) {
      return this.#mapExecutionFailure(task, request, control, error);
    }
    const recoveryRequest = this.#beginInternalRecovery(task, request);
    try {
      const recovered = await this.#prepareTask(recoveryRequest, control, true);
      const recoveredSession = recovered.session as ProcessTaskSession;
      await this.#activateExecutionScope(recovered, recoveredSession, recoveryRequest, control);
      const trackedControl = this.#trackControl(recovered, control, recoveredSession);
      const outcome = await recoveredSession.bridge.execute(
        transportExecutionRequest(recoveryRequest),
        trackedControl,
      );
      if (isRecoveryRequired(outcome)) {
        throw processFailedError('The Process failed again after its one internal recovery.');
      }
      if (outcome.type === 'terminal') await this.#settleTerminal(recovered, outcome);
      else {
        await this.#stopSettledSession(recovered, recovered.session as ProcessTaskSession);
      }
      return outcome;
    } catch (recoveryError) {
      if (executionScopeFailure(request, control) !== undefined) {
        return this.#mapExecutionFailure(task, request, control, recoveryError);
      }
      await this.#stopFailedInternalRecovery(task);
      this.#forgetNestedTaskScope(task);
      const failure = task.failure ?? task.session?.failure;
      if (failure !== undefined) throw failure;
      if (recoveryError instanceof SubAgentRuntimeError) throw recoveryError;
      throw processFailedError('The Process internal checkpoint replay failed.');
    }
  }

  async #recoverOrMapSpawnFailure(
    task: RetainedProcessTask,
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
    error: unknown,
  ): Promise<ExecutorTaskHandle | SubAgentExecutorRecoveryRequired> {
    if (executionScopeFailure(request, control) !== undefined) {
      return this.#mapExecutionFailure(task, request, control, error);
    }
    const bindingFailure = bindingIntegrityFailure(task, error);
    if (bindingFailure !== undefined) {
      this.#forgetNestedTaskScope(task);
      await this.#stopRejectedSession(task);
      throw bindingFailure;
    }
    if (!this.#canInternallyRecover(task, request)) {
      return this.#mapExecutionFailure(task, request, control, error);
    }
    const recoveryRequest = this.#beginInternalRecovery(task, request);
    try {
      const recovered = await this.#prepareTask(recoveryRequest, control, true);
      const recoveredSession = recovered.session as ProcessTaskSession;
      await this.#activateExecutionScope(recovered, recoveredSession, recoveryRequest, control);
      const trackedControl = this.#trackControl(recovered, control, recoveredSession);
      const raw = await recoveredSession.bridge.spawn(
        transportExecutionRequest(recoveryRequest),
        trackedControl,
      );
      if (isRecoveryRequired(raw)) {
        throw processFailedError('The Process failed again after its one internal recovery.');
      }
      recovered.binding = raw.binding;
      this.#monitorSpawn(recovered, raw);
      return this.#wrapHandle(recovered, raw, request, control, recoveredSession);
    } catch (recoveryError) {
      if (executionScopeFailure(request, control) !== undefined) {
        return this.#mapExecutionFailure(task, request, control, recoveryError);
      }
      await this.#stopFailedInternalRecovery(task);
      this.#forgetNestedTaskScope(task);
      const failure = task.failure ?? task.session?.failure;
      if (failure !== undefined) throw failure;
      if (recoveryError instanceof SubAgentRuntimeError) throw recoveryError;
      throw processFailedError('The Process internal checkpoint replay failed.');
    }
  }

  #canInternallyRecover(task: RetainedProcessTask, request: SubAgentExecutionRequest): boolean {
    return (
      (task.session?.crashed === true || task.lastSessionCrashed === true) &&
      task.internalRecoveryExecutionEpoch !== request.executionEpoch &&
      task.binding !== undefined &&
      task.latestCheckpoint?.modelOperation?.phase === 'in_flight'
    );
  }

  async #stopFailedInternalRecovery(task: RetainedProcessTask): Promise<void> {
    if (task.terminal === undefined) await this.#stopRejectedSession(task);
  }

  async #stopRejectedSession(
    task: RetainedProcessTask,
    expectedSession: ProcessTaskSession | undefined = task.session,
  ): Promise<void> {
    if (expectedSession === undefined || !this.#ownsExecutionScope(task, expectedSession)) return;
    this.#clearExecutionScopeWatch(task, expectedSession);
    if (!expectedSession.closed) await expectedSession.stop();
    if (expectedSession.crashed) task.lastSessionCrashed = true;
    if (task.failure === undefined && expectedSession.failure !== undefined) {
      task.failure = expectedSession.failure;
    }
    this.#releaseSession(task, expectedSession);
  }

  async #stopSettledSession(task: RetainedProcessTask, session: ProcessTaskSession): Promise<void> {
    if (!this.#ownsExecutionScope(task, session)) return;
    this.#clearExecutionScopeWatch(task, session);
    if (!session.closed) await session.stop();
    this.#releaseSession(task, session);
  }

  #releaseSession(task: RetainedProcessTask, session: ProcessTaskSession): void {
    if (!this.#ownsExecutionScope(task, session) || !session.closed) return;
    this.#clearExecutionScopeWatch(task, session);
    this.#capturedOutputBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.#capturedOutputBytes + session.capturedOutputBytes,
    );
    delete task.session;
  }

  #monitorSpawn(task: RetainedProcessTask, raw: ExecutorTaskHandle): void {
    const session = task.session;
    void raw
      .wait()
      .then(async (outcome) => {
        if (session === undefined || !this.#ownsExecutionScope(task, session)) return;
        task.lastSettlement ??= outcome;
        if (outcome.type === 'terminal') await this.#settleTerminal(task, outcome, false);
        if (session !== undefined) await this.#stopSettledSession(task, session);
      })
      .catch(async () => {
        if (session === undefined || !this.#ownsExecutionScope(task, session)) return;
        await this.#stopRejectedSession(task, session);
        if (!this.#canPreserveNestedTaskScope(task)) this.#forgetNestedTaskScope(task);
      })
      .catch(() => undefined);
  }

  #beginInternalRecovery(
    task: RetainedProcessTask,
    request: SubAgentExecutionRequest,
  ): SubAgentExecutionRequest {
    const binding = task.binding;
    const checkpoint = task.latestCheckpoint;
    if (binding === undefined || checkpoint?.modelOperation?.phase !== 'in_flight') {
      throw processFailedError('The Process checkpoint is not eligible for internal recovery.');
    }
    task.internalRecoveryExecutionEpoch = request.executionEpoch;
    delete task.lastSessionCrashed;
    delete task.failure;
    return Object.freeze({
      ...request,
      operation: Object.freeze({
        type: 'resume' as const,
        operationId: `process-internal-resume:${canonicalJsonSha256({
          operationId: request.operation.operationId,
          executionEpoch: request.executionEpoch,
        })}`,
        reason: 'checkpoint' as const,
        binding,
        checkpoint,
      }),
    });
  }

  async #mapExecutionFailure(
    task: RetainedProcessTask,
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
    error: unknown,
  ): Promise<SubAgentExecutorRecoveryRequired> {
    const scopeFailure = executionScopeFailure(request, control);
    if (scopeFailure !== undefined) {
      const session = task.session;
      if (session !== undefined) await this.#expireExecutionScope(task, session, scopeFailure);
      throw scopeFailure;
    }
    const bindingFailure = bindingIntegrityFailure(task, error);
    if (bindingFailure !== undefined) {
      this.#forgetNestedTaskScope(task);
      await this.#stopRejectedSession(task);
      throw bindingFailure;
    }
    const failure = task.failure ?? task.session?.failure;
    if (task.session?.crashed === true || task.lastSessionCrashed === true) {
      if (task.binding === undefined) {
        const marker = Object.freeze({
          type: 'recovery_required',
          reason: 'unbound_create',
          operationId: request.operation.operationId,
          causeCode: 'PROCESS_EXIT',
        } as const);
        await this.#stopRejectedSession(task);
        return marker;
      }
      if (task.latestCheckpoint !== undefined) {
        if (task.internalRecoveryExecutionEpoch === request.executionEpoch) {
          this.#forgetNestedTaskScope(task);
          await this.#stopRejectedSession(task);
          throw processFailedError('The Process failed again after its one internal recovery.');
        }
        const marker = Object.freeze({
          type: 'recovery_required',
          reason: 'checkpoint',
          operationId: request.operation.operationId,
          causeCode: 'PROCESS_EXIT',
        } as const);
        await this.#stopRejectedSession(task);
        return marker;
      }
      this.#forgetNestedTaskScope(task);
      await this.#stopRejectedSession(task);
      throw processFailedError(
        'The Process exited after binding but before a checkpoint was saved.',
      );
    }
    if (failure !== undefined) {
      this.#forgetNestedTaskScope(task);
      await this.#stopRejectedSession(task);
      throw failure;
    }
    if (error instanceof SubAgentRuntimeError) {
      this.#forgetNestedTaskScope(task);
      await this.#stopRejectedSession(task);
      throw error;
    }
    this.#forgetNestedTaskScope(task);
    await this.#stopRejectedSession(task);
    throw processFailedError('The Process execution channel failed.');
  }

  async #cancelResident(
    task: RetainedProcessTask,
    failure: SubAgentRuntimeError = cancelledError(),
    expectedSession?: ProcessTaskSession,
  ): Promise<void> {
    const session = task.session;
    if (
      task.terminal !== undefined ||
      session === undefined ||
      session.closed ||
      !this.#ownsExecutionScope(task, session) ||
      (expectedSession !== undefined && session !== expectedSession)
    ) {
      return;
    }
    this.#forgetNestedTaskScope(task);
    this.#clearExecutionScopeWatch(task, session);
    task.failure = failure;
    if (task.binding !== undefined) {
      const cleanupSignal = new AbortController().signal;
      const killDeadline = Date.now() + this.#terminateTimeoutMs;
      try {
        await session.bridge.cancel(task.binding, {
          operationId: `process-abort-cleanup:${randomUUID()}`,
          reason: 'host execution scope aborted',
          signal: cleanupSignal,
          deadlineAt: killDeadline,
        });
      } catch {
        // The bounded termination below remains mandatory after an ambiguous cancel acknowledgement.
      }
      const settled = await session.waitForTerminal(Math.max(0, killDeadline - Date.now()));
      const shutdownBudget = Math.max(0, killDeadline - Date.now());
      if (settled && shutdownBudget > 0) await session.stop(shutdownBudget);
      else await session.forceTerminate();
      this.#releaseSession(task, session);
      return;
    }
    await session.forceTerminate();
    this.#releaseSession(task, session);
  }

  #wrapHandle(
    task: RetainedProcessTask,
    raw: ExecutorTaskHandle,
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
    expectedSession: ProcessTaskSession,
  ): ExecutorTaskHandle {
    const requestIdentity = executionRequestIdentity(request);
    const matchesRetainedOperation = (): boolean =>
      (task.terminalRequestIdentity === requestIdentity && task.terminalMode === 'spawn') ||
      (task.residentRequestIdentity === requestIdentity && task.residentMode === 'spawn');
    const matchesExecutionScope = (): boolean =>
      this.#matchesExecutionScope(task, expectedSession.executionScope);
    const ownsExecutionScope = (): boolean => this.#ownsExecutionScope(task, expectedSession);
    let observedOutcome: SubAgentExecutorOperationResult | undefined;
    return Object.freeze({
      taskId: raw.taskId,
      binding: raw.binding,
      snapshot: async () => {
        if (observedOutcome !== undefined) {
          return settledSnapshot(task, raw.binding, observedOutcome);
        }
        if (task.terminal !== undefined && matchesRetainedOperation()) {
          return terminalSnapshot(task, raw.binding);
        }
        if (task.lastSettlement !== undefined && matchesRetainedOperation()) {
          return settledSnapshot(task, raw.binding, task.lastSettlement);
        }
        return raw.snapshot();
      },
      wait: async () => {
        if (observedOutcome !== undefined) return observedOutcome;
        if (task.terminal !== undefined && matchesRetainedOperation()) {
          observedOutcome = task.terminal;
          return observedOutcome;
        }
        if (task.lastSettlement !== undefined && matchesRetainedOperation()) {
          if (ownsExecutionScope()) await this.#stopSettledSession(task, expectedSession);
          observedOutcome = task.lastSettlement;
          return observedOutcome;
        }
        try {
          const outcome = await raw.wait();
          observedOutcome = outcome;
          if (ownsExecutionScope()) {
            if (outcome.type === 'terminal') await this.#settleTerminal(task, outcome);
            else await this.#stopSettledSession(task, expectedSession);
          }
          return outcome;
        } catch (error) {
          if (
            !matchesExecutionScope() ||
            (task.session !== undefined && task.session !== expectedSession)
          ) {
            throw staleTaskHandleError();
          }
          return this.#recoverOrMapExecuteFailure(task, request, control, error);
        }
      },
      cancel: async (reason?: string) => {
        if (!ownsExecutionScope()) {
          if (task.terminal !== undefined && matchesRetainedOperation()) return;
          throw staleTaskHandleError();
        }
        return this.cancel(raw.binding, {
          operationId: `process-handle-cancel:${randomUUID()}`,
          ...(reason === undefined ? {} : { reason }),
          signal: new AbortController().signal,
          deadlineAt: Date.now() + this.#terminateTimeoutMs,
        });
      },
      events: (options?: Parameters<ExecutorTaskHandle['events']>[0]) => {
        if (
          observedOutcome !== undefined ||
          ((task.terminal !== undefined || task.lastSettlement !== undefined) &&
            matchesRetainedOperation())
        ) {
          return terminalEvents(options?.signal);
        }
        return raw.events(options);
      },
    });
  }

  #terminalHandle(task: RetainedProcessTask, binding: SubAgentExecutorBinding): ExecutorTaskHandle {
    return Object.freeze({
      taskId: task.taskId,
      binding,
      snapshot: async () => terminalSnapshot(task, binding),
      wait: async () => task.terminal as SubAgentExecutionOutcome,
      cancel: async () => undefined,
      events: (options?: Parameters<ExecutorTaskHandle['events']>[0]) =>
        terminalEvents(options?.signal),
    });
  }

  #liveProcessCount(): number {
    return [...this.#tasks.values()].filter(
      ({ session }) => session !== undefined && !session.closed,
    ).length;
  }

  #canPreserveNestedTaskScope(task: RetainedProcessTask): boolean {
    return (
      task.lastSessionCrashed === true &&
      task.internalRecoveryExecutionEpoch !== task.executionEpoch &&
      (task.binding === undefined || task.latestCheckpoint !== undefined)
    );
  }

  #forgetNestedTaskScope(task: RetainedProcessTask): void {
    this.#nestedTaskHandles.forgetParentScope(task.ownerSessionId, task.taskId);
  }

  #ownsExecutionScope(task: RetainedProcessTask, session: ProcessTaskSession): boolean {
    return task.session === session && this.#matchesExecutionScope(task, session.executionScope);
  }

  #matchesExecutionScope(task: RetainedProcessTask, scope: ProcessExecutionScopeIdentity): boolean {
    return (
      task.executionAttempt === scope.attempt &&
      task.executionEpoch === scope.executionEpoch &&
      task.executionFencingToken === scope.executionFencingToken
    );
  }
}

type ProcessSessionState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed' | 'closed';

class ProcessTaskSession {
  readonly bridge: ReturnType<typeof createSubAgentTransportExecutorBridge>;
  readonly executionScope: ProcessExecutionScopeIdentity;
  readonly #options: ProcessSessionOptions;
  readonly #process: ChildProcess;
  readonly #ipcWriter: ProcessSubAgentIpcWriter;
  readonly #peer: SubAgentTransportPeer;
  readonly #startPromise: Promise<void>;
  readonly #closePromise: Promise<void>;
  readonly #terminalWaiters = new Set<() => void>();
  #resolveStart!: () => void;
  #rejectStart!: (error: unknown) => void;
  #resolveClose!: () => void;
  #startSettled = false;
  #closeSettled = false;
  readonly #activeMessages = new Set<Promise<void>>();
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #state: ProcessSessionState = 'starting';
  #hostStop = false;
  #protocolFailure = false;
  #spawned = false;
  #spawnError = false;
  #stopPromise: Promise<void> | undefined;
  #terminatePromise: Promise<void> | undefined;
  #terminationReported = false;
  #crashReported = false;
  #channelClosed = false;
  #exitRecord:
    | Readonly<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
    | undefined;
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #outputLimitTriggered = false;
  crashed = false;
  failure: SubAgentRuntimeError | undefined;

  constructor(options: ProcessSessionOptions) {
    this.#options = options;
    this.executionScope = Object.freeze({
      attempt: options.task.executionAttempt,
      executionEpoch: options.task.executionEpoch,
      executionFencingToken: options.task.executionFencingToken,
    });
    const channelId = `process:${options.task.jobId}`;
    this.#process = fork(fileURLToPath(options.targetEntry), [], {
      execPath: process.execPath,
      execArgv: [],
      env: options.environment,
      serialization: 'advanced',
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsVerbatimArguments: false,
    });
    this.#ipcWriter = createProcessSubAgentIpcWriter({
      connected: () => this.#process.connected && !this.#channelClosed,
      send: (message, callback) => {
        this.#process.send(message, callback);
      },
      onFailure: () => {
        queueMicrotask(() => {
          void this.#protocolFail(processFailedError('The Process IPC writer failed.'));
        });
      },
    });
    this.#peer = createSubAgentTransportPeer({
      channelId,
      writer: (packet) => {
        if (this.#state !== 'ready') {
          throw processFailedError('The Process channel is not ready for controller packets.');
        }
        this.#ipcWriter.assertCapacity(estimateProcessPacketBytes(packet));
        return this.#ipcWriter.write(
          Object.freeze({
            version: PROCESS_SUBAGENT_CHANNEL_VERSION,
            type: 'packet',
            packet: encodeProcessPacket(packet),
          }),
        );
      },
      handler: (request) => this.bridge.handler(request),
    });
    this.bridge = createSubAgentTransportExecutorBridge({
      descriptor: options.descriptor,
      bindingCodec: processSubAgentBindingCodec,
      peer: this.#peer,
      getAvailability: () => ({
        status: this.#state === 'ready' ? 'available' : 'unavailable',
        supportedDefinitions: options.expectedManifest.registrations.map(
          ({ definition }) => definition,
        ),
      }),
      supports: (definition) =>
        options.expectedManifest.registrations.some(
          ({ definition: candidate }) =>
            candidate.name === definition.name && candidate.version === definition.version,
        ),
      model: options.model,
      nestedTaskHandles: options.nestedTaskHandles,
      ...(options.events === undefined ? {} : { events: options.events }),
      ...(options.resolveNestedTaskHandle === undefined
        ? {}
        : { resolveNestedTaskHandle: options.resolveNestedTaskHandle }),
    });
    this.#startPromise = new Promise<void>((resolve, reject) => {
      this.#resolveStart = resolve;
      this.#rejectStart = reject;
    });
    void this.#startPromise.catch(() => undefined);
    this.#closePromise = new Promise<void>((resolve) => {
      this.#resolveClose = resolve;
    });
    const bootstrap: ProcessSubAgentBootstrapData = Object.freeze({
      version: PROCESS_SUBAGENT_CHANNEL_VERSION,
      jobId: options.task.jobId,
      ownerSessionId: options.task.ownerSessionId,
      executorName: options.descriptor.name,
      channelId,
    });
    this.#wireLifecycle(bootstrap);
  }

  #sendBootstrap(bootstrap: ProcessSubAgentBootstrapData): void {
    try {
      const receipt = this.#ipcWriter.write(
        Object.freeze({
          ...bootstrap,
          type: 'bootstrap',
        }),
      );
      void Promise.resolve(receipt.settled).catch(() =>
        this.#protocolFail(processFailedError('The Process bootstrap write failed.')),
      );
    } catch (error) {
      queueMicrotask(() => {
        void this.#protocolFail(error);
      });
    }
  }

  get ready(): boolean {
    return this.#state === 'ready';
  }

  get closed(): boolean {
    return this.#closeSettled;
  }

  get channelClosed(): boolean {
    return this.#channelClosed || !this.#process.connected;
  }

  get capturedOutputBytes(): number {
    return Math.min(Number.MAX_SAFE_INTEGER, this.#stdoutBytes + this.#stderrBytes);
  }

  start(): Promise<void> {
    return this.#startPromise;
  }

  async waitForTerminal(timeoutMs: number): Promise<boolean> {
    if (this.#options.task.terminal !== undefined) return true;
    if (this.closed || timeoutMs === 0) return false;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        this.#terminalWaiters.delete(onTerminal);
        this.#clearTimer(timer);
        resolve(value);
      };
      const onTerminal = (): void => finish(true);
      const timer = this.#setTimer(() => finish(false), timeoutMs);
      this.#terminalWaiters.add(onTerminal);
      void this.#closePromise.then(() => finish(false));
    });
  }

  stop(timeoutMs = this.#options.terminateTimeoutMs): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#hostStop = true;
    if (this.closed) return Promise.resolve();
    if (this.#state === 'failed') return this.#terminate(false);
    this.#state = 'stopping';
    this.#stopPromise = this.#stopGracefully(timeoutMs);
    return this.#stopPromise;
  }

  forceTerminate(): Promise<void> {
    if (!this.crashed && !this.#protocolFailure) this.#hostStop = true;
    return this.#terminate(true);
  }

  #wireLifecycle(bootstrap: ProcessSubAgentBootstrapData): void {
    this.#handshakeTimer = this.#setTimer(() => {
      void this.#protocolFail(
        processFailedError('The Process target startup handshake timed out.'),
      );
    }, this.#options.handshakeTimeoutMs);

    this.#process.on('message', (value: unknown, sendHandle: unknown) => {
      if (sendHandle !== undefined) {
        void this.#protocolFail(
          processFailedError('The Process attempted to transfer an IPC handle.'),
        );
        return;
      }
      if (this.#activeMessages.size >= MAX_ACTIVE_PROCESS_MESSAGES) {
        void this.#protocolFail(processFailedError('The Process message capacity is exhausted.'));
        return;
      }
      const handling = this.#handleMessage(value);
      this.#activeMessages.add(handling);
      void handling
        .catch((error: unknown) => this.#protocolFail(error))
        .finally(() => {
          this.#activeMessages.delete(handling);
        });
    });
    this.#process.once('disconnect', () => {
      this.#channelClosed = true;
      this.#ipcWriter.close(processFailedError('The Process IPC channel disconnected.'));
      if (
        this.closed ||
        this.#hostStop ||
        this.#state === 'stopped' ||
        this.#options.task.terminal !== undefined ||
        this.#exitRecord !== undefined ||
        this.#disconnectTimer !== undefined
      )
        return;
      this.#disconnectTimer = this.#setTimer(() => {
        this.#disconnectTimer = undefined;
        if (
          this.closed ||
          this.#hostStop ||
          this.#state === 'stopped' ||
          this.#options.task.terminal !== undefined ||
          this.#exitRecord !== undefined
        )
          return;
        void this.#protocolFail(
          processFailedError('The Process IPC channel disconnected unexpectedly.'),
        );
      }, PROCESS_DISCONNECT_EXIT_GRACE_MS);
    });
    this.#process.once('spawn', () => {
      this.#spawned = true;
      this.#sendBootstrap(bootstrap);
    });
    this.#process.on('error', () => {
      if (this.closed || this.#hostStop) return;
      if (!this.#spawned) {
        this.#spawnError = true;
        void this.#recordOsCrash(processFailedError('The Process target failed to spawn.'));
      } else {
        void this.#protocolFail(processFailedError('The Process target channel failed.'));
      }
    });
    this.#process.once('exit', (code, signal) => {
      const candidate = Object.freeze({ code, signal });
      if (
        this.#exitRecord !== undefined &&
        (this.#exitRecord.code !== candidate.code || this.#exitRecord.signal !== candidate.signal)
      ) {
        void this.#protocolFail(processFailedError('The Process emitted conflicting exit state.'));
        return;
      }
      this.#exitRecord = candidate;
    });
    this.#process.once('close', (code, signal) => {
      this.#handleClose(code, signal);
    });

    this.#consumeStream(this.#process.stdout, 'stdout');
    this.#consumeStream(this.#process.stderr, 'stderr');
  }

  async #handleMessage(value: unknown): Promise<void> {
    const message = decodeProcessMessage(value, 'outbound');
    switch (message.type) {
      case 'ready': {
        if (this.#state !== 'starting') {
          throw processFailedError('The Process target sent out-of-order startup readiness.');
        }
        const actual = normalizeTargetManifest(message.manifest);
        if (
          actual.digest !== this.#options.expectedManifest.digest ||
          canonicalizeJson(actual as unknown as JsonValue) !==
            canonicalizeJson(this.#options.expectedManifest as unknown as JsonValue)
        ) {
          throw new SubAgentRuntimeError({
            code: 'BINDING_INVALID',
            message: 'The Process target manifest does not match the trusted controller manifest.',
            retryable: false,
          });
        }
        this.#state = 'ready';
        this.#clearHandshakeTimer();
        this.#resolveStartOnce();
        return;
      }
      case 'packet': {
        if (this.#state !== 'ready') {
          throw processFailedError('The Process target sent a packet outside the ready state.');
        }
        const packet = decodeProcessPacket(message.packet);
        await this.#peer.receive(packet);
        const settlement = readExecutionSettlement(packet);
        if (settlement !== undefined) {
          await this.#options.onSettlement(this.#options.task, settlement, this);
          if (settlement.type === 'terminal') {
            for (const waiter of this.#terminalWaiters) waiter();
            this.#terminalWaiters.clear();
          }
        }
        return;
      }
      case 'fatal':
        throw processFailedError('The Process target rejected its startup or channel protocol.');
      case 'stopped':
        if (this.#state !== 'stopping') {
          throw processFailedError('The Process target sent an out-of-order stopped message.');
        }
        this.#state = 'stopped';
        return;
      default:
        throw processFailedError('The Process target sent an unsupported channel message.');
    }
  }

  async #stopGracefully(timeoutMs: number): Promise<void> {
    if (this.closed) return;
    try {
      const receipt = this.#ipcWriter.write(
        Object.freeze({
          version: PROCESS_SUBAGENT_CHANNEL_VERSION,
          type: 'shutdown',
        }),
      );
      void Promise.resolve(receipt.settled).catch(() => undefined);
    } catch {
      await this.#terminate(true);
      return;
    }
    if (!(await this.#waitForClose(timeoutMs))) {
      await this.#terminate(true);
    }
  }

  async #waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.closed) return true;
    if (timeoutMs === 0) return false;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        this.#clearTimer(timer);
        resolve(value);
      };
      const timer = this.#setTimer(() => finish(false), timeoutMs);
      void this.#closePromise.then(() => finish(true));
    });
  }

  #consumeStream(stream: NodeJS.ReadableStream | null, kind: 'stdout' | 'stderr'): void {
    stream?.on('error', () => {
      if (!this.#hostStop && !this.closed) {
        void this.#protocolFail(processFailedError(`The Process ${kind} stream failed.`));
      }
    });
    stream?.on('data', (chunk: unknown) => {
      const bytes =
        typeof chunk === 'string'
          ? Buffer.byteLength(chunk)
          : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
            ? chunk.byteLength
            : 0;
      if (kind === 'stdout') {
        this.#stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, this.#stdoutBytes + bytes);
      } else {
        this.#stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.#stderrBytes + bytes);
      }
      if (
        !this.#outputLimitTriggered &&
        (this.#stdoutBytes > MAX_CAPTURED_STREAM_BYTES ||
          this.#stderrBytes > MAX_CAPTURED_STREAM_BYTES)
      ) {
        this.#outputLimitTriggered = true;
        void this.#protocolFail(
          processFailedError('The Process output safety limit was exceeded.'),
        );
      }
    });
    stream?.resume();
  }

  async #protocolFail(error: unknown): Promise<void> {
    if (this.closed || this.#protocolFailure) return;
    this.#protocolFailure = true;
    this.#state = 'failed';
    const safe =
      error instanceof SubAgentRuntimeError ? error : processFailedError('Process failed.');
    this.failure ??= safe;
    this.#clearHandshakeTimer();
    this.#rejectStartOnce(safe);
    this.#peer.close();
    await this.#terminate(false).catch(() => undefined);
  }

  async #recordOsCrash(error: SubAgentRuntimeError): Promise<void> {
    if (!this.crashed && !this.#hostStop && !this.#protocolFailure) {
      this.crashed = true;
      this.failure ??= error;
      this.#state = 'failed';
      this.#rejectStartOnce(this.failure);
      if (!this.#crashReported) {
        this.#crashReported = true;
        this.#options.onCrash(this);
      }
    }
    this.#peer.close();
    await this.#terminate(false).catch(() => undefined);
  }

  #handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#closeSettled) return;
    this.#process.removeAllListeners('error');
    const exit = this.#exitRecord;
    if (
      (exit !== undefined && (exit.code !== code || exit.signal !== signal)) ||
      (exit === undefined && !this.#spawnError)
    ) {
      this.#protocolFailure = true;
      this.failure ??= processFailedError('The Process exit and close state is inconsistent.');
      this.#state = 'failed';
    }
    this.#closeSettled = true;
    this.#channelClosed = true;
    this.#clearHandshakeTimer();
    this.#clearDisconnectTimer();
    this.#ipcWriter.close(this.failure ?? processFailedError('The Process channel closed.'));
    this.#peer.close();

    if (
      !this.#hostStop &&
      !this.#protocolFailure &&
      this.#options.task.terminal === undefined &&
      !this.crashed
    ) {
      this.crashed = true;
      this.failure ??= processFailedError(
        code === 0 && signal === null ? 'The Process exited unexpectedly.' : 'The Process crashed.',
      );
      if (!this.#crashReported) {
        this.#crashReported = true;
        this.#options.onCrash(this);
      }
    }
    if (this.#state !== 'failed') this.#state = 'closed';
    this.#rejectStartOnce(this.failure ?? processFailedError('Process startup failed.'));
    this.#resolveClose();
  }

  #terminate(hostInitiated: boolean): Promise<void> {
    if (hostInitiated && !this.crashed && !this.#protocolFailure) this.#hostStop = true;
    if (this.closed) return Promise.resolve();
    if (this.#terminatePromise !== undefined) return this.#terminatePromise;
    if (!this.#terminationReported) {
      this.#terminationReported = true;
      this.#options.onTerminated(this);
    }
    const operation = (async () => {
      if (this.#exitRecord === undefined) {
        try {
          this.#process.kill('SIGKILL');
        } catch {
          // A concurrent OS exit can race the signal; close remains the authoritative boundary.
        }
      }
      if (!(await this.#waitForClose(MAX_TERMINATE_TIMEOUT_MS))) {
        throw processFailedError('The Process did not close after the hard-kill deadline.');
      }
    })();
    this.#terminatePromise = operation;
    void operation.catch(() => {
      if (!this.closed && this.#terminatePromise === operation) {
        this.#terminatePromise = undefined;
      }
    });
    return operation;
  }

  #resolveStartOnce(): void {
    if (this.#startSettled) return;
    this.#startSettled = true;
    this.#resolveStart();
  }

  #rejectStartOnce(error: unknown): void {
    if (this.#startSettled) return;
    this.#startSettled = true;
    this.#rejectStart(error);
  }

  #setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.#options.onTimerRemoved(timer);
      callback();
    }, delayMs);
    this.#options.onTimerAdded(timer);
    return timer;
  }

  #clearTimer(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    this.#options.onTimerRemoved(timer);
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer === undefined) return;
    this.#clearTimer(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
  }

  #clearDisconnectTimer(): void {
    if (this.#disconnectTimer === undefined) return;
    this.#clearTimer(this.#disconnectTimer);
    this.#disconnectTimer = undefined;
  }
}

function normalizeExecutionRequestBinding(
  request: SubAgentExecutionRequest,
  executorName: string,
  maxBindingBytes: number,
): SubAgentExecutionRequest {
  const operation = request.operation;
  if (operation.type === 'create') return request;
  const bindingDescriptor = Object.getOwnPropertyDescriptor(operation, 'binding');
  if (
    bindingDescriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(bindingDescriptor, 'value')
  ) {
    throw new SubAgentRuntimeError({
      code: 'BINDING_INVALID',
      message: 'The Process Executor binding is invalid.',
      retryable: false,
    });
  }
  const binding = normalizeProcessBinding(bindingDescriptor.value, executorName, maxBindingBytes);
  return Object.freeze({
    ...request,
    operation: Object.freeze({ ...operation, binding }),
  }) as SubAgentExecutionRequest;
}

function normalizeProcessBinding(
  value: unknown,
  executorName: string,
  maxBindingBytes: number,
): SubAgentExecutorBinding {
  try {
    assertJsonValue(value, {
      label: 'Process Executor binding',
      maxBytes: maxBindingBytes,
      maxDepth: 64,
      maxNodes: 10_000,
    });
    const owned = parseJsonValue(canonicalizeJson(value));
    if (typeof owned !== 'object' || owned === null || Array.isArray(owned)) {
      throw new TypeError('Process Executor binding must be an object.');
    }
    const record = owned as Record<string, JsonValue>;
    const expectedKeys = [
      'adapterStateVersion',
      'definitionName',
      'definitionVersion',
      'executorName',
      'modelBinding',
      'ownerSessionId',
      'recoveryData',
      'runnerId',
      'runnerVersion',
      'subagentSessionId',
      'taskId',
      'version',
    ];
    if (Object.keys(record).sort().join(',') !== expectedKeys.sort().join(',')) {
      throw new TypeError('Process Executor binding contains unknown or missing fields.');
    }
    if (record.version !== '1' || record.executorName !== executorName) {
      throw new TypeError('Process Executor binding identity is invalid.');
    }
    assertIdentifier(record.executorName, 'Process binding executorName');
    assertTransportIdentifier(record.ownerSessionId as string, 'Process binding ownerSessionId');
    assertTransportIdentifier(record.taskId as string, 'Process binding taskId');
    assertTransportIdentifier(
      record.subagentSessionId as string,
      'Process binding subagentSessionId',
    );
    assertIdentifier(record.definitionName as string, 'Process binding definitionName');
    assertVersionIdentifier(
      record.definitionVersion as string,
      'Process binding definitionVersion',
    );
    assertIdentifier(record.runnerId as string, 'Process binding runnerId');
    assertVersionIdentifier(record.runnerVersion as string, 'Process binding runnerVersion');
    if (record.adapterStateVersion !== PROCESS_SUBAGENT_ADAPTER_STATE_VERSION) {
      throw new TypeError('Process binding adapterStateVersion is invalid.');
    }
    const modelBinding = record.modelBinding;
    if (typeof modelBinding !== 'object' || modelBinding === null || Array.isArray(modelBinding)) {
      throw new TypeError('Process binding modelBinding is invalid.');
    }
    const modelBindingRecord = modelBinding as Record<string, JsonValue>;
    if (Object.keys(modelBindingRecord).sort().join(',') !== 'codecVersion,gatewayId,protocol') {
      throw new TypeError('Process binding modelBinding contains unknown or missing fields.');
    }
    assertIdentifier(modelBindingRecord.gatewayId as string, 'Process binding gatewayId');
    assertIdentifier(modelBindingRecord.protocol as string, 'Process binding protocol');
    assertVersionIdentifier(
      modelBindingRecord.codecVersion as string,
      'Process binding codecVersion',
    );
    decodeProcessBinding(record.recoveryData);
    deepFreezeJson(owned);
    return owned as unknown as SubAgentExecutorBinding;
  } catch {
    throw new SubAgentRuntimeError({
      code: 'BINDING_INVALID',
      message: 'The Process Executor binding is invalid.',
      retryable: false,
    });
  }
}

function assertExecutorOptions(options: ProcessSubAgentExecutorOptions): void {
  if (
    Object.getPrototypeOf(options) !== Object.prototype &&
    Object.getPrototypeOf(options) !== null
  ) {
    throw new TypeError('Process Executor options must use a plain object prototype.');
  }
  const allowed = new Set([
    'description',
    'events',
    'expectedManifest',
    'handshakeTimeoutMs',
    'maxConcurrentProcesses',
    'maxRetainedTasks',
    'model',
    'name',
    'resolveNestedTaskHandle',
    'targetEntry',
    'terminateTimeoutMs',
    'useCases',
  ]);
  const keys = Reflect.ownKeys(options);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError('Process Executor options contain an unknown field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new TypeError('Process Executor options must contain enumerable data fields only.');
    }
  }
  for (const required of ['expectedManifest', 'model', 'targetEntry']) {
    if (!Object.prototype.hasOwnProperty.call(options, required)) {
      throw new TypeError(`Process Executor options require an own ${required} field.`);
    }
  }
}

function createMinimalProcessEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  // Node on Windows may otherwise synthesize the parent PATH even when options.env omits it.
  environment.PATH = '';
  const allowed =
    process.platform === 'win32' ? ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'] : ['TMPDIR'];
  const names = Object.keys(process.env);
  for (const canonicalName of allowed) {
    const matches = names
      .filter((name) => name.toUpperCase() === canonicalName)
      .sort((left, right) => left.localeCompare(right));
    const value = matches[0] === undefined ? undefined : process.env[matches[0]];
    if (typeof value === 'string') environment[canonicalName] = value;
  }
  return Object.freeze(environment);
}

function normalizeTargetEntry(input: URL): URL {
  let serialized: string;
  try {
    serialized = URL.prototype.toString.call(input);
  } catch {
    throw new TypeError('Process targetEntry must be a trusted URL object.');
  }
  const entry = new URL(serialized);
  if (entry.protocol !== 'file:') {
    throw new TypeError('Process targetEntry must use a local file URL.');
  }
  if (entry.hostname !== '') {
    throw new TypeError('Process targetEntry cannot use a host or UNC path.');
  }
  if (entry.search !== '') {
    throw new TypeError('Process targetEntry cannot include a query or search component.');
  }
  if (entry.hash !== '') {
    throw new TypeError('Process targetEntry cannot include a hash or fragment.');
  }
  return entry;
}

function normalizeTargetManifest(
  input: SubAgentTargetRunnerManifest,
): SubAgentTargetRunnerManifest {
  assertJsonValue(input as unknown);
  const owned = parseJsonValue(canonicalizeJson(input as unknown as JsonValue));
  if (typeof owned !== 'object' || owned === null || Array.isArray(owned)) {
    throw new TypeError('Process target manifest must be an object.');
  }
  const record = owned as Record<string, JsonValue>;
  if (
    Object.keys(record).sort().join(',') !==
      'digest,registrations,runtimeProtocolVersion,version' ||
    record.version !== '1' ||
    record.runtimeProtocolVersion !== '1' ||
    typeof record.digest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.digest) ||
    !Array.isArray(record.registrations)
  ) {
    throw new TypeError('Process target manifest is not a closed v1 manifest.');
  }
  const body = {
    version: record.version,
    runtimeProtocolVersion: record.runtimeProtocolVersion,
    registrations: record.registrations,
  } satisfies JsonValue;
  if (canonicalJsonSha256(body) !== record.digest) {
    throw new TypeError('Process target manifest digest does not match its canonical body.');
  }
  for (const registration of record.registrations) assertManifestRegistration(registration);
  deepFreezeJson(owned);
  return owned as unknown as SubAgentTargetRunnerManifest;
}

function assertManifestRegistration(value: JsonValue): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Process target manifest registration must be an object.');
  }
  if (Object.keys(value).sort().join(',') !== 'definition,modelBinding,runner') {
    throw new TypeError('Process transport registrations require a closed Model binding.');
  }
  const registration = value as { readonly [key: string]: JsonValue };
  const definition = registration.definition;
  const runner = registration.runner;
  const modelBinding = registration.modelBinding;
  const definitionRecord =
    typeof definition === 'object' && definition !== null && !Array.isArray(definition)
      ? (definition as { readonly [key: string]: JsonValue })
      : undefined;
  const runnerRecord =
    typeof runner === 'object' && runner !== null && !Array.isArray(runner)
      ? (runner as { readonly [key: string]: JsonValue })
      : undefined;
  const modelBindingRecord =
    typeof modelBinding === 'object' && modelBinding !== null && !Array.isArray(modelBinding)
      ? (modelBinding as { readonly [key: string]: JsonValue })
      : undefined;
  if (
    definitionRecord === undefined ||
    Object.keys(definitionRecord).sort().join(',') !== 'name,version' ||
    typeof definitionRecord.name !== 'string' ||
    typeof definitionRecord.version !== 'string' ||
    runnerRecord === undefined ||
    Object.keys(runnerRecord).sort().join(',') !==
      'childCheckpointVersions,runnerId,runnerVersion' ||
    typeof runnerRecord.runnerId !== 'string' ||
    typeof runnerRecord.runnerVersion !== 'string' ||
    !Array.isArray(runnerRecord.childCheckpointVersions) ||
    !runnerRecord.childCheckpointVersions.every((item: JsonValue) => typeof item === 'string') ||
    modelBindingRecord === undefined ||
    Object.keys(modelBindingRecord).sort().join(',') !== 'codecVersion,gatewayId,protocol' ||
    typeof modelBindingRecord.gatewayId !== 'string' ||
    typeof modelBindingRecord.protocol !== 'string' ||
    typeof modelBindingRecord.codecVersion !== 'string'
  ) {
    throw new TypeError('Process target manifest registration is invalid.');
  }
}

function readExecutionSettlement(
  packet: SubAgentTransportPeerPacket,
): SubAgentExecutorOperationResult | undefined {
  const envelope = decodeSubAgentTransportRpcFrame(packet.frame);
  if (envelope.kind !== 'executor.settled') return undefined;
  return envelope.payload.outcome;
}

function terminalSnapshot(
  task: RetainedProcessTask,
  binding: SubAgentExecutorBinding,
): ExecutorTaskSnapshot {
  const outcome = task.terminal;
  const state = outcome?.type === 'terminal' ? outcome.result.status : 'failed';
  return Object.freeze({
    taskId: task.taskId,
    state,
    binding,
    updatedAt: task.updatedAt,
  });
}

function settledSnapshot(
  task: RetainedProcessTask,
  binding: SubAgentExecutorBinding,
  outcome: SubAgentExecutorOperationResult,
): ExecutorTaskSnapshot {
  const state =
    outcome.type === 'terminal'
      ? outcome.result.status
      : outcome.type === 'paused'
        ? 'waiting_approval'
        : 'running';
  return Object.freeze({ taskId: task.taskId, state, binding, updatedAt: task.updatedAt });
}

function terminalEvents(signal?: AbortSignal): AsyncIterable<SubAgentTaskEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          signal?.throwIfAborted();
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

function processFailedError(message: string): SubAgentRuntimeError {
  return new SubAgentRuntimeError({ code: 'EXECUTOR_FAILED', message, retryable: false });
}

function cancelledError(): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'CANCELLED',
    message: 'The Process child execution was cancelled.',
    retryable: false,
  });
}

function timedOutError(): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'TIMED_OUT',
    message: 'The Process execution scope timed out during startup.',
    retryable: false,
  });
}

function executionScopeFailure(
  request: SubAgentExecutionRequest,
  control: SubAgentExecutionControl,
): SubAgentRuntimeError | undefined {
  if (Date.now() >= Math.min(request.deadlineAt, control.deadlineAt)) return timedOutError();
  if (!request.signal.aborted && !control.signal.aborted) return undefined;
  const reason = request.signal.aborted ? request.signal.reason : control.signal.reason;
  return reason instanceof SubAgentRuntimeError &&
    (reason.code === 'CANCELLED' || reason.code === 'TIMED_OUT')
    ? reason
    : cancelledError();
}

function assertExecutionTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Process execution timeoutMs must be a positive safe integer.');
  }
}

function isSessionStartupCrash(
  task: RetainedProcessTask | undefined,
  error: unknown,
): task is RetainedProcessTask {
  return task?.session?.crashed === true && task.session.failure === error;
}

function bindingIntegrityFailure(
  task: RetainedProcessTask,
  error: unknown,
): SubAgentRuntimeError | undefined {
  if (error instanceof SubAgentRuntimeError && error.code === 'BINDING_INVALID') return error;
  const retained = task.failure ?? task.session?.failure;
  return retained?.code === 'BINDING_INVALID' ? retained : undefined;
}

function assertProcessOperationSupported(request: SubAgentExecutionRequest): void {
  if (request.operation.type !== 'reconnect') return;
  throw new SubAgentRuntimeError({
    code: 'RECOVERY_UNSUPPORTED',
    message: 'Process placement does not support reconnect.',
    retryable: false,
  });
}

function executionRequestIdentity(request: SubAgentExecutionRequest): string {
  return canonicalJsonSha256({
    ...stableExecutionRequest(request),
    attempt: request.attempt,
    executionEpoch: request.executionEpoch,
    executionFencingToken: request.executionFencingToken,
    deadlineAt: request.deadlineAt,
  });
}

function transportExecutionRequest(request: SubAgentExecutionRequest): SubAgentExecutionRequest {
  const deadlineAt = Math.min(request.deadlineAt, Date.now() + request.limits.timeoutMs);
  return deadlineAt === request.deadlineAt ? request : Object.freeze({ ...request, deadlineAt });
}

function createRequestIdentity(request: SubAgentExecutionRequest): string {
  if (request.operation.type !== 'create') {
    throw new TypeError('A Process create identity requires a create operation.');
  }
  const body = {
    ...stableTaskRequest(request),
    operation: request.operation,
    delegation: request.delegation,
  };
  assertJsonValue(body);
  return canonicalJsonSha256(body);
}

function stableTaskIdentity(request: SubAgentExecutionRequest): string {
  const body = stableTaskRequest(request);
  assertJsonValue(body);
  return canonicalJsonSha256(body);
}

function stableTaskRequest(request: SubAgentExecutionRequest) {
  const limits = {
    maxDepth: request.limits.maxDepth,
    maxDescendants: request.limits.maxDescendants,
    maxConcurrent: request.limits.maxConcurrent,
    maxTurns: request.limits.maxTurns,
    ...(request.limits.maxProviderCalls === undefined
      ? {}
      : { maxProviderCalls: request.limits.maxProviderCalls }),
    ...(request.limits.maxInputTokens === undefined
      ? {}
      : { maxInputTokens: request.limits.maxInputTokens }),
    ...(request.limits.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: request.limits.maxOutputTokens }),
    ...(request.limits.maxCost === undefined ? {} : { maxCost: request.limits.maxCost }),
  };
  return Object.freeze({
    ownerSessionId: request.ownerSessionId,
    runId: request.runId,
    taskId: request.taskId,
    ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
    subagentSessionId: request.subagentSessionId,
    path: request.path,
    ...(request.retryOf === undefined ? {} : { retryOf: request.retryOf }),
    definition: request.definition,
    input: request.input,
    projectedContext: request.projectedContext,
    delegation: {
      version: request.delegation.version,
      ownerSessionId: request.delegation.ownerSessionId,
      runId: request.delegation.runId,
      parentTaskId: request.delegation.parentTaskId,
      path: request.delegation.path,
      depth: request.delegation.depth,
    },
    limits,
  });
}

function stableExecutionRequest(
  request: SubAgentExecutionRequest,
): Readonly<Record<string, JsonValue>> {
  return {
    operation: request.operation,
    ownerSessionId: request.ownerSessionId,
    runId: request.runId,
    taskId: request.taskId,
    ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
    subagentSessionId: request.subagentSessionId,
    path: request.path,
    ...(request.retryOf === undefined ? {} : { retryOf: request.retryOf }),
    definition: request.definition,
    input: request.input,
    projectedContext: request.projectedContext,
    delegation: request.delegation,
    limits: request.limits,
  } as unknown as Readonly<Record<string, JsonValue>>;
}

function bindingsEqual(left: SubAgentExecutorBinding, right: SubAgentExecutorBinding): boolean {
  return (
    canonicalizeJson(left as unknown as JsonValue) ===
    canonicalizeJson(right as unknown as JsonValue)
  );
}

function invalidActiveOperation(): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'INVALID_STATE_TRANSITION',
    message: 'The Process task already has an incompatible active operation.',
    retryable: false,
  });
}

function staleTaskHandleError(): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'INVALID_STATE_TRANSITION',
    message: 'The Process task handle belongs to an obsolete execution scope.',
    retryable: false,
  });
}

function parseFencingToken(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new SubAgentRuntimeError({
      code: 'BINDING_INVALID',
      message: 'The Process execution fencing token is invalid.',
      retryable: false,
    });
  }
  return BigInt(value);
}

function deepFreezeJson(value: JsonValue): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    deepFreezeJson(child);
  }
  Object.freeze(value);
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

function positiveIntegerAtMost(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = positiveInteger(value, fallback, label);
  if (resolved > maximum) {
    throw new RangeError(`${label} cannot exceed ${maximum}.`);
  }
  return resolved;
}

function nonNegativeIntegerAtMost(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new RangeError(`${label} must be a safe integer from 0 through ${maximum}.`);
  }
  return resolved;
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function assertVersionIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function assertTransportIdentifier(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) as number;
      return codePoint <= 31 || codePoint === 127;
    }) ||
    new TextEncoder().encode(value).byteLength > SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES
  ) {
    throw new TypeError(
      `${label} must be a trimmed 1-${SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES} byte identifier without control characters.`,
    );
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isRecoveryRequired(value: unknown): value is SubAgentExecutorRecoveryRequired {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'recovery_required'
  );
}
