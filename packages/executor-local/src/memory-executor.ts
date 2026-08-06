import { randomUUID } from 'node:crypto';

import {
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
} from '@ruixutong.manee/maneeagent-framework';

import { LocalSubAgentRunnerRegistry } from './local-runner-registry';

interface MemoryBindingState {
  readonly kind: 'maneeagent-memory-local/v1';
  readonly handleId: string;
}

interface MemoryExecution {
  request: SubAgentExecutionRequest;
  readonly binding: SubAgentExecutorBinding;
  readonly runner: SubAgentChildRunner;
  controller: AbortController;
  promise: Promise<SubAgentExecutionOutcome>;
  outcome?: SubAgentExecutionOutcome;
  running: boolean;
  updatedAt: number;
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
    encode: (state: MemoryBindingState): JsonValue => ({ ...state }),
    decode: (value: JsonValue): MemoryBindingState => decodeBindingState(value),
  });
  readonly #registry: LocalSubAgentRunnerRegistry;
  readonly #executions = new Map<string, MemoryExecution>();

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
      maxBindingBytes: 64 * 1024,
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
    options.signal.throwIfAborted();
    const execution = this.#executions.get(binding.taskId);
    if (execution === undefined || !sameBinding(execution.binding, binding)) {
      throw runtimeError(
        'RECOVERY_TARGET_LOST',
        'The original in-process child runner is no longer available.',
      );
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
    if (request.operation.type === 'reconnect') {
      throw runtimeError('RECOVERY_UNSUPPORTED', 'Local execution does not support reconnect.');
    }

    let execution = this.#executions.get(request.taskId);
    if (request.operation.type === 'create') {
      if (execution !== undefined) {
        if (!sameExecutionIdentity(execution.request, request)) {
          throw runtimeError('IDEMPOTENCY_CONFLICT', 'The local task identity is already in use.');
        }
        return execution;
      }
      const childRequest = toChildRequest(request);
      const runner = await this.#registry.create(childRequest);
      const runnerIdentity = this.#registry.runnerFor(request.definition);
      const bindingState: MemoryBindingState = {
        kind: 'maneeagent-memory-local/v1',
        handleId: randomUUID(),
      };
      const binding = createBinding(request, this.descriptor.name, runnerIdentity, bindingState);
      const controller = new AbortController();
      execution = {
        request,
        binding,
        runner,
        controller,
        promise: Promise.resolve(invalidPendingOutcome()),
        running: false,
        updatedAt: Date.now(),
      };
      this.#executions.set(request.taskId, execution);
      try {
        await control.commitBinding(request.operation.operationId, binding);
      } catch (error) {
        this.#executions.delete(request.taskId);
        throw error;
      }
    } else {
      const state = this.bindingCodec.decode(request.operation.binding.recoveryData);
      const runnerIdentity = this.#registry.runnerFor(request.definition);
      if (
        !bindingMatchesRequest(
          request.operation.binding,
          request,
          this.descriptor.name,
          runnerIdentity,
        ) ||
        !checkpointMatchesRunner(request.operation.checkpoint, runnerIdentity)
      ) {
        throw runtimeError(
          'CHECKPOINT_VERSION_MISMATCH',
          'The Local child checkpoint is incompatible with the persisted runner binding.',
        );
      }
      if (execution !== undefined) {
        if (
          !sameExecutionIdentity(execution.request, request) ||
          !sameBinding(execution.binding, request.operation.binding) ||
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
        const runner = await this.#registry.create(toChildRequest(request));
        execution = {
          request,
          binding: request.operation.binding,
          runner,
          controller: new AbortController(),
          promise: Promise.resolve(invalidPendingOutcome()),
          running: false,
          updatedAt: Date.now(),
        };
        this.#executions.set(request.taskId, execution);
      } else {
        execution.request = request;
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
    const childRequest = toChildRequest(request, childSignal);
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

function toChildRequest(
  request: SubAgentExecutionRequest,
  signal = request.signal,
): SubAgentChildRunRequest {
  return Object.freeze({
    ownerSessionId: request.ownerSessionId,
    runId: request.runId,
    taskId: request.taskId,
    ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
    subagentSessionId: request.subagentSessionId,
    path: request.path,
    attempt: request.attempt,
    executionEpoch: request.executionEpoch,
    executionFencingToken: request.executionFencingToken,
    definition: request.definition,
    input: request.input,
    projectedContext: request.projectedContext,
    delegation: request.delegation,
    limits: request.limits,
    ...(request.operation.type === 'resume' ? { checkpoint: request.operation.checkpoint } : {}),
    signal,
    deadlineAt: request.deadlineAt,
  });
}

function createBinding(
  request: SubAgentExecutionRequest,
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
    recoveryData: { ...state },
  });
}

function checkpointMatchesRunner(
  checkpoint: Extract<
    SubAgentExecutionRequest['operation'],
    { readonly type: 'resume' }
  >['checkpoint'],
  runner: {
    readonly runnerId: string;
    readonly runnerVersion: string;
    readonly childCheckpointVersions: readonly string[];
  },
): boolean {
  return (
    checkpoint.runnerId === runner.runnerId &&
    checkpoint.runnerVersion === runner.runnerVersion &&
    runner.childCheckpointVersions.includes(checkpoint.version)
  );
}

function decodeBindingState(value: JsonValue): MemoryBindingState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid Memory Local Executor binding.');
  }
  const record = value as { readonly [key: string]: JsonValue };
  if (
    record.kind !== 'maneeagent-memory-local/v1' ||
    typeof record.handleId !== 'string' ||
    record.handleId.length === 0
  ) {
    throw new TypeError('Invalid Memory Local Executor binding.');
  }
  return Object.freeze({ kind: record.kind, handleId: record.handleId });
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

function sameExecutionIdentity(
  left: SubAgentExecutionRequest,
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

function bindingMatchesRequest(
  binding: SubAgentExecutorBinding,
  request: SubAgentExecutionRequest,
  executorName: string,
  runner: { readonly runnerId: string; readonly runnerVersion: string },
): boolean {
  return (
    binding.version === '1' &&
    binding.executorName === executorName &&
    binding.ownerSessionId === request.ownerSessionId &&
    binding.taskId === request.taskId &&
    binding.subagentSessionId === request.subagentSessionId &&
    binding.definitionName === request.definition.name &&
    binding.definitionVersion === request.definition.version &&
    binding.runnerId === runner.runnerId &&
    binding.runnerVersion === runner.runnerVersion &&
    binding.adapterStateVersion === '1'
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
    | 'CANCELLED'
    | 'CHECKPOINT_VERSION_MISMATCH'
    | 'IDEMPOTENCY_CONFLICT'
    | 'INTERNAL_ERROR'
    | 'INVALID_STATE_TRANSITION'
    | 'RECOVERY_TARGET_LOST'
    | 'RECOVERY_UNSUPPORTED',
  message: string,
): SubAgentRuntimeError {
  return new SubAgentRuntimeError({ code, message, retryable: false });
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
