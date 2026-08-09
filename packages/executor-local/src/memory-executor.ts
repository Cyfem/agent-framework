import { randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import {
  assertJsonValue,
  canonicalJsonSha256,
  canonicalizeJson,
  parseJsonValue,
  SubAgentRuntimeError,
  type ExecutorAvailabilityProbe,
  type ExecutorTaskHandle,
  type ExecutorTaskSnapshot,
  type JsonValue,
  type SubAgentChildRunRequest,
  type SubAgentChildRunner,
  type SubAgentExecutionControl,
  type SubAgentExecutionOutcome,
  type SubAgentExecutionRequest,
  type SubAgentExecutor,
  type SubAgentExecutorBinding,
  type SubAgentExecutorDescriptor,
  type SubAgentTaskEvent,
  type SubAgentTaskState,
  type PreparedSubAgentTargetRunner,
} from '@ruixutong.manee/maneeagent-framework';

import { LocalSubAgentRunnerRegistry } from './local-runner-registry';

const MEMORY_EXECUTOR_MAX_BINDING_BYTES = 64 * 1024;
const MEMORY_EXECUTOR_MAX_BINDING_DEPTH = 64;
const MEMORY_EXECUTOR_MAX_BINDING_NODES = 10_000;

interface MemoryBindingState {
  readonly kind: 'maneeagent-memory-local/v1';
  readonly handleId: string;
}

interface MemoryExecution {
  request: SubAgentChildRunRequest;
  readonly createIdentity?: MemoryCreateIdentity;
  readonly binding: SubAgentExecutorBinding;
  readonly runner: SubAgentChildRunner;
  controller: AbortController;
  promise: Promise<SubAgentExecutionOutcome>;
  outcome?: SubAgentExecutionOutcome;
  running: boolean;
  updatedAt: number;
}

interface MemoryCreateIdentity {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface MemorySubAgentExecutorOptions {
  readonly registry: LocalSubAgentRunnerRegistry;
  readonly name?: string;
  readonly description?: string;
  readonly useCases?: readonly string[];
}

/**
 * Official in-process placement. Each create gets a fresh child runner. Approval resume reuses
 * that runner while it is available; after process loss a complete compatible checkpoint creates
 * a replacement runner from the trusted registry.
 */
export class MemorySubAgentExecutor implements SubAgentExecutor {
  readonly descriptor: SubAgentExecutorDescriptor;
  readonly bindingCodec = Object.freeze({
    adapterStateVersion: '1',
    encode: (state: MemoryBindingState): JsonValue =>
      Object.freeze({ ...decodeBindingState(state) }),
    decode: (value: JsonValue): MemoryBindingState => decodeBindingState(value),
  });
  readonly #registry: LocalSubAgentRunnerRegistry;
  readonly #executions = new Map<string, MemoryExecution>();
  readonly #pendingStarts = new Map<string, Promise<MemoryExecution>>();

  constructor(options: MemorySubAgentExecutorOptions) {
    this.#registry = options.registry.seal();
    const name = options.name ?? 'local';
    const runnerCompatibility = this.#registry.listRunnerCompatibility();
    if (runnerCompatibility.length === 0) {
      throw new TypeError('Memory Local checkpoint recovery requires a registered child runner.');
    }
    const checkpointVersions = Object.freeze([
      ...new Set(runnerCompatibility.flatMap((runner) => runner.childCheckpointVersions)),
    ]);
    this.descriptor = Object.freeze({
      runtimeProtocolVersion: '1' as const,
      taskRecordVersions: Object.freeze(['1']),
      childCheckpointVersions: checkpointVersions,
      runnerCompatibility,
      name,
      description: options.description ?? 'Execute an isolated child Agent in the host process.',
      useCases: Object.freeze([...(options.useCases ?? ['Low-latency trusted local execution.'])]),
      capabilities: Object.freeze({
        execute: true as const,
        spawn: true,
        cancel: true,
        events: true,
        approval: true,
        usage: 'provider' as const,
        recovery: Object.freeze({
          resume: 'checkpoint' as const,
          reconnect: 'none' as const,
        }),
      }),
      adapterStateVersion: '1',
      maxBindingBytes: MEMORY_EXECUTOR_MAX_BINDING_BYTES,
      maxEventPageSize: 256,
    });
  }

  getAvailability(): ExecutorAvailabilityProbe {
    return {
      status: 'available',
      supportedDefinitions: this.#registry.list(),
    };
  }

  supports(definition: SubAgentExecutionRequest['definition']): boolean {
    return this.#registry.has(definition);
  }

  async execute(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<SubAgentExecutionOutcome> {
    const execution = await this.#start(request, control);
    return execution.promise;
  }

  async spawn(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<ExecutorTaskHandle> {
    const execution = await this.#start(request, control);
    return this.#createHandle(execution);
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
    const ownedBinding = normalizeMemoryBinding(
      binding,
      this.descriptor.name,
      this.descriptor.maxBindingBytes,
    );
    options.signal.throwIfAborted();
    const execution = this.#executions.get(ownedBinding.taskId);
    if (
      execution === undefined ||
      execution.binding.ownerSessionId !== ownedBinding.ownerSessionId
    ) {
      throw runtimeError('RESOURCE_NOT_FOUND', 'The requested Subagent resource was not found.');
    }
    if (!sameBinding(execution.binding, ownedBinding)) {
      throw invalidBinding('The Memory Local binding does not match its logical task.');
    }
    if (!execution.running) return;
    execution.controller.abort(
      runtimeError(
        'CANCELLED',
        options.reason?.trim()
          ? 'The local child was cancelled by its host.'
          : 'The local child was cancelled.',
      ),
    );
  }

  /** Explicit lifecycle cleanup for long-lived hosts after Core no longer needs terminal handles. */
  disposeTask(taskId: string): boolean {
    const execution = this.#executions.get(taskId);
    if (execution?.running || execution?.outcome?.type !== 'terminal') return false;
    return this.#executions.delete(taskId);
  }

  async #start(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<MemoryExecution> {
    const ownedRequest = normalizeExecutionRequestOperation(
      request,
      this.descriptor.name,
      this.descriptor.maxBindingBytes,
    );
    const prepared = this.#registry.prepareExecution(ownedRequest, this.descriptor.name);
    if (ownedRequest.operation.type === 'reconnect') {
      throw runtimeError('RECOVERY_UNSUPPORTED', 'Local execution does not support reconnect.');
    }
    const createIdentity =
      ownedRequest.operation.type === 'create'
        ? createMemoryCreateIdentity(
            ownedRequest.operation.operationId,
            ownedRequest.operation.idempotencyKey,
            ownedRequest,
            prepared.request,
          )
        : undefined;

    const pending = this.#pendingStarts.get(ownedRequest.taskId);
    if (pending !== undefined) {
      const execution = await pending;
      if (ownedRequest.operation.type === 'create') {
        assertCreateReplay(execution, createIdentity as MemoryCreateIdentity);
        return execution;
      }
      return this.#start(ownedRequest, control);
    }

    const start = this.#startPrepared(ownedRequest, control, prepared, createIdentity).finally(
      () => {
        if (this.#pendingStarts.get(ownedRequest.taskId) === start) {
          this.#pendingStarts.delete(ownedRequest.taskId);
        }
      },
    );
    this.#pendingStarts.set(ownedRequest.taskId, start);
    return start;
  }

  async #startPrepared(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
    prepared: PreparedSubAgentTargetRunner,
    createIdentity: MemoryCreateIdentity | undefined,
  ): Promise<MemoryExecution> {
    if (request.operation.type === 'reconnect') {
      throw runtimeError('RECOVERY_UNSUPPORTED', 'Local execution does not support reconnect.');
    }
    let execution = this.#executions.get(request.taskId);
    if (request.operation.type === 'create') {
      if (execution !== undefined) {
        assertCreateReplay(execution, createIdentity as MemoryCreateIdentity);
        return execution;
      }
      const bindingOperationId = request.operation.operationId;
      const runner = await prepared.create();
      const bindingState: MemoryBindingState = {
        kind: 'maneeagent-memory-local/v1',
        handleId: randomUUID(),
      };
      const binding = createBinding(
        prepared.request,
        this.descriptor.name,
        prepared.runner,
        bindingState,
      );
      const controller = new AbortController();
      execution = {
        request: prepared.request,
        createIdentity: createIdentity as MemoryCreateIdentity,
        binding,
        runner,
        controller,
        promise: Promise.resolve(invalidPendingOutcome()),
        running: false,
        updatedAt: Date.now(),
      };
      this.#executions.set(request.taskId, execution);
      try {
        await control.commitBinding(bindingOperationId, binding);
      } catch (error) {
        this.#executions.delete(request.taskId);
        throw error;
      }
    } else {
      const state = this.bindingCodec.decode(request.operation.binding.recoveryData);
      if (request.operation.binding.adapterStateVersion !== this.bindingCodec.adapterStateVersion) {
        throw runtimeError(
          'RECOVERY_TARGET_LOST',
          'The persisted Local child binding uses an unsupported adapter state version.',
        );
      }
      const binding = createBinding(prepared.request, this.descriptor.name, prepared.runner, state);
      if (execution !== undefined) {
        if (
          !sameExecutionIdentity(execution.request, request) ||
          !sameBinding(execution.binding, binding) ||
          this.bindingCodec.decode(execution.binding.recoveryData).handleId !== state.handleId
        ) {
          throw runtimeError(
            'RECOVERY_TARGET_LOST',
            'The persisted Local child binding does not match the resident execution.',
          );
        }
        if (execution.running) {
          throw runtimeError('INVALID_STATE_TRANSITION', 'The local child is already running.');
        }
      }

      if (execution === undefined || request.operation.reason === 'checkpoint') {
        const originalCreateIdentity = execution?.createIdentity;
        const runner = await prepared.create();
        execution = {
          request: prepared.request,
          ...(originalCreateIdentity === undefined
            ? {}
            : { createIdentity: originalCreateIdentity }),
          binding,
          runner,
          controller: new AbortController(),
          promise: Promise.resolve(invalidPendingOutcome()),
          running: false,
          updatedAt: Date.now(),
        };
        this.#executions.set(request.taskId, execution);
      } else {
        execution.request = prepared.request;
        execution.controller = new AbortController();
      }
    }

    if (execution === undefined) {
      throw runtimeError('INTERNAL_ERROR', 'The Local child execution was not initialized.');
    }
    const activeExecution = execution;
    activeExecution.running = true;
    activeExecution.updatedAt = Date.now();
    const childSignal = AbortSignal.any([request.signal, activeExecution.controller.signal]);
    const childRequest = withSignal(activeExecution.request, childSignal);
    const childControl = Object.freeze({ ...control, signal: childSignal });
    const run = Promise.resolve().then(() =>
      activeExecution.runner.run(childRequest, childControl),
    );
    run.catch(() => undefined);
    activeExecution.promise = raceWithAbort(run, childSignal)
      .then((outcome) => {
        activeExecution.outcome = outcome;
        return outcome;
      })
      .finally(() => {
        activeExecution.running = false;
        activeExecution.updatedAt = Date.now();
      });
    return activeExecution;
  }

  #createHandle(execution: MemoryExecution): ExecutorTaskHandle {
    return Object.freeze({
      taskId: execution.request.taskId,
      binding: execution.binding,
      snapshot: async () => this.#snapshot(execution),
      wait: () => execution.promise,
      cancel: async (reason?: string) => {
        if (!execution.running) return;
        execution.controller.abort(
          runtimeError(
            'CANCELLED',
            reason?.trim()
              ? 'The local child was cancelled by its host.'
              : 'The local child was cancelled.',
          ),
        );
      },
      events: () => emptyEvents(),
    });
  }

  #snapshot(execution: MemoryExecution): ExecutorTaskSnapshot {
    return Object.freeze({
      taskId: execution.request.taskId,
      state: execution.running ? 'running' : stateFromOutcome(execution.outcome),
      binding: execution.binding,
      updatedAt: execution.updatedAt,
    });
  }
}

function withSignal(
  request: SubAgentChildRunRequest,
  signal: AbortSignal,
): SubAgentChildRunRequest {
  return Object.freeze({
    ...request,
    signal,
  });
}

function createBinding(
  request: SubAgentChildRunRequest,
  executorName: string,
  runner: { readonly runnerId: string; readonly runnerVersion: string },
  state: MemoryBindingState,
): SubAgentExecutorBinding {
  return Object.freeze({
    version: '1',
    executorName,
    ownerSessionId: request.ownerSessionId,
    taskId: request.taskId,
    subagentSessionId: request.subagentSessionId,
    definitionName: request.definition.name,
    definitionVersion: request.definition.version,
    runnerId: runner.runnerId,
    runnerVersion: runner.runnerVersion,
    adapterStateVersion: '1',
    recoveryData: Object.freeze({ ...state }),
  });
}

function decodeBindingState(value: unknown): MemoryBindingState {
  try {
    const owned = cloneBindingJson(value, MEMORY_EXECUTOR_MAX_BINDING_BYTES);
    if (
      typeof owned !== 'object' ||
      owned === null ||
      Array.isArray(owned) ||
      Object.keys(owned).sort().join(',') !== 'handleId,kind'
    ) {
      throw new TypeError('Memory Local binding state must be a closed object.');
    }
    const record = owned as { readonly handleId?: unknown; readonly kind?: unknown };
    if (
      record.kind !== 'maneeagent-memory-local/v1' ||
      typeof record.handleId !== 'string' ||
      record.handleId.length === 0
    ) {
      throw new TypeError('Memory Local binding state identity is invalid.');
    }
    return Object.freeze({ kind: record.kind, handleId: record.handleId });
  } catch {
    throw invalidBinding('The Memory Local Executor binding state is invalid.');
  }
}

function normalizeExecutionRequestOperation(
  request: SubAgentExecutionRequest,
  executorName: string,
  maxBindingBytes: number,
): SubAgentExecutionRequest {
  try {
    if (nodeTypes.isProxy(request)) {
      throw new TypeError('Memory Local execution request must not be a Proxy.');
    }
    const operationDescriptor = Object.getOwnPropertyDescriptor(request, 'operation');
    if (
      operationDescriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(operationDescriptor, 'value')
    ) {
      throw new TypeError('Memory Local execution operation must be an own data property.');
    }
    assertJsonValue(operationDescriptor.value);
    if (
      typeof operationDescriptor.value !== 'object' ||
      operationDescriptor.value === null ||
      Array.isArray(operationDescriptor.value)
    ) {
      throw new TypeError('Memory Local execution operation must be an object.');
    }
    const operation = operationDescriptor.value as Record<string, JsonValue>;
    let ownedOperation: JsonValue;
    if (operation.type === 'create') {
      assertClosedKeys(operation, ['idempotencyKey', 'operationId', 'type']);
      ownedOperation = Object.freeze({
        type: 'create',
        operationId: requireOperationString(operation, 'operationId'),
        idempotencyKey: requireOperationString(operation, 'idempotencyKey'),
      });
    } else if (operation.type === 'resume') {
      if (operation.reason !== 'approval' && operation.reason !== 'checkpoint') {
        throw new TypeError('Memory Local resume reason is invalid.');
      }
      assertClosedKeys(
        operation,
        operation.reason === 'approval'
          ? ['approvals', 'binding', 'checkpoint', 'operationId', 'reason', 'type']
          : ['binding', 'checkpoint', 'operationId', 'reason', 'type'],
      );
      const binding = normalizeMemoryBinding(operation.binding, executorName, maxBindingBytes);
      requireOperationString(operation, 'operationId');
      ownedOperation = Object.freeze({
        ...operation,
        binding: binding as unknown as JsonValue,
      });
    } else if (operation.type === 'reconnect') {
      assertClosedKeys(operation, ['binding', 'operationId', 'type']);
      const binding = normalizeMemoryBinding(operation.binding, executorName, maxBindingBytes);
      ownedOperation = Object.freeze({
        type: 'reconnect',
        operationId: requireOperationString(operation, 'operationId'),
        binding: binding as unknown as JsonValue,
      });
    } else {
      throw new TypeError('Memory Local execution operation type is invalid.');
    }
    const descriptors: Record<PropertyKey, PropertyDescriptor> =
      Object.getOwnPropertyDescriptors(request);
    descriptors.operation = {
      configurable: false,
      enumerable: true,
      value: ownedOperation,
      writable: false,
    };
    return Object.freeze(Object.defineProperties({}, descriptors)) as SubAgentExecutionRequest;
  } catch (error) {
    if (error instanceof SubAgentRuntimeError && error.code === 'BINDING_INVALID') throw error;
    throw invalidBinding('The Memory Local Executor operation is invalid.');
  }
}

function normalizeMemoryBinding(
  value: unknown,
  executorName: string,
  maxBindingBytes: number,
): SubAgentExecutorBinding {
  try {
    const owned = cloneBindingJson(value, maxBindingBytes);
    if (typeof owned !== 'object' || owned === null || Array.isArray(owned)) {
      throw new TypeError('Memory Local Executor binding must be an object.');
    }
    const record = owned as Record<string, JsonValue>;
    assertClosedKeys(record, [
      'adapterStateVersion',
      'definitionName',
      'definitionVersion',
      'executorName',
      'ownerSessionId',
      'recoveryData',
      'runnerId',
      'runnerVersion',
      'subagentSessionId',
      'taskId',
      'version',
    ]);
    if (
      record.version !== '1' ||
      record.executorName !== executorName ||
      record.adapterStateVersion !== '1'
    ) {
      throw new TypeError('Memory Local Executor binding identity is invalid.');
    }
    const ownerSessionId = requireBindingString(record, 'ownerSessionId');
    const taskId = requireBindingString(record, 'taskId');
    const subagentSessionId = requireBindingString(record, 'subagentSessionId');
    const definitionName = requireBindingString(record, 'definitionName');
    const definitionVersion = requireBindingString(record, 'definitionVersion');
    const runnerId = requireBindingString(record, 'runnerId');
    const runnerVersion = requireBindingString(record, 'runnerVersion');
    const state = decodeBindingState(record.recoveryData);
    const recoveryData: JsonValue = Object.freeze({
      kind: state.kind,
      handleId: state.handleId,
    });
    return Object.freeze({
      version: '1',
      executorName,
      ownerSessionId,
      taskId,
      subagentSessionId,
      definitionName,
      definitionVersion,
      runnerId,
      runnerVersion,
      adapterStateVersion: '1',
      recoveryData,
    });
  } catch {
    throw invalidBinding('The Memory Local Executor binding is invalid.');
  }
}

function cloneBindingJson(value: unknown, maxBytes?: number): JsonValue {
  assertJsonValue(value, {
    label: 'Memory Local Executor binding',
    ...(maxBytes === undefined ? {} : { maxBytes }),
    maxDepth: MEMORY_EXECUTOR_MAX_BINDING_DEPTH,
    maxNodes: MEMORY_EXECUTOR_MAX_BINDING_NODES,
  });
  return parseJsonValue(canonicalizeJson(value));
}

function assertClosedKeys(record: Record<string, JsonValue>, expected: readonly string[]): void {
  if (Object.keys(record).sort().join(',') !== [...expected].sort().join(',')) {
    throw new TypeError('Memory Local Executor value contains unknown or missing fields.');
  }
}

function requireBindingString(record: Record<string, JsonValue>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Memory Local Executor binding ${key} is invalid.`);
  }
  return value;
}

function requireOperationString(record: Record<string, JsonValue>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Memory Local Executor operation ${key} is invalid.`);
  }
  return value;
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? runtimeError('CANCELLED', 'Cancelled.'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? runtimeError('CANCELLED', 'Cancelled.'));
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function createMemoryCreateIdentity(
  operationId: string,
  idempotencyKey: string,
  request: SubAgentExecutionRequest,
  preparedRequest: SubAgentChildRunRequest,
): MemoryCreateIdentity {
  const stablePreparedRequest = Object.fromEntries(
    Object.entries(preparedRequest).filter(([key]) => key !== 'signal'),
  ) as Record<string, JsonValue>;
  const stableRequest = {
    operation: { type: 'create', operationId, idempotencyKey },
    ...stablePreparedRequest,
    ...(request.retryOf === undefined ? {} : { retryOf: request.retryOf }),
  };
  return Object.freeze({
    operationId,
    idempotencyKey,
    requestHash: canonicalJsonSha256(stableRequest as unknown as JsonValue),
  });
}

function assertCreateReplay(execution: MemoryExecution, requested: MemoryCreateIdentity): void {
  if (
    execution.createIdentity?.operationId !== requested.operationId ||
    execution.createIdentity?.idempotencyKey !== requested.idempotencyKey ||
    execution.createIdentity.requestHash !== requested.requestHash
  ) {
    throw runtimeError(
      'IDEMPOTENCY_CONFLICT',
      'The local task create identity is already bound to a different prepared request.',
    );
  }
}

function sameExecutionIdentity(
  left: SubAgentChildRunRequest,
  right: SubAgentExecutionRequest,
): boolean {
  return (
    left.ownerSessionId === right.ownerSessionId &&
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.subagentSessionId === right.subagentSessionId &&
    left.definition.name === right.definition.name &&
    left.definition.version === right.definition.version
  );
}

function sameBinding(left: SubAgentExecutorBinding, right: SubAgentExecutorBinding): boolean {
  return (
    left.version === right.version &&
    left.executorName === right.executorName &&
    left.ownerSessionId === right.ownerSessionId &&
    left.taskId === right.taskId &&
    left.subagentSessionId === right.subagentSessionId &&
    left.definitionName === right.definitionName &&
    left.definitionVersion === right.definitionVersion &&
    left.runnerId === right.runnerId &&
    left.runnerVersion === right.runnerVersion &&
    left.adapterStateVersion === right.adapterStateVersion &&
    decodeBindingState(left.recoveryData).handleId ===
      decodeBindingState(right.recoveryData).handleId
  );
}

function runtimeError(
  code:
    | 'BINDING_INVALID'
    | 'CANCELLED'
    | 'CHECKPOINT_VERSION_MISMATCH'
    | 'IDEMPOTENCY_CONFLICT'
    | 'INTERNAL_ERROR'
    | 'INVALID_STATE_TRANSITION'
    | 'RECOVERY_TARGET_LOST'
    | 'RECOVERY_UNSUPPORTED'
    | 'RESOURCE_NOT_FOUND',
  message: string,
): SubAgentRuntimeError {
  return new SubAgentRuntimeError({ code, message, retryable: false });
}

function invalidBinding(message: string): SubAgentRuntimeError {
  return runtimeError('BINDING_INVALID', message);
}

function stateFromOutcome(outcome: SubAgentExecutionOutcome | undefined): SubAgentTaskState {
  if (outcome === undefined) return 'queued';
  if (outcome.type === 'paused') return 'waiting_approval';
  return outcome.result.status;
}

function invalidPendingOutcome(): SubAgentExecutionOutcome {
  return {
    type: 'terminal',
    result: {
      status: 'failed',
      task: { taskId: 'pending', subAgent: { name: 'pending', version: '1' } },
      executor: 'local',
      error: { code: 'INTERNAL_ERROR', message: 'Execution has not started.', retryable: false },
    },
  };
}

function emptyEvents(): AsyncIterable<SubAgentTaskEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true as const, value: undefined }),
      };
    },
  };
}
