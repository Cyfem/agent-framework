import { randomUUID } from 'node:crypto';

import type {
  ExecutorAvailabilityProbe,
  ExecutorCatalogSnapshot,
  SubAgentCatalogEntry,
  SubAgentExecutorDescriptor,
} from './catalog';
import type { SubAgentChildRunner } from './child-runner';
import {
  createResourceNotFoundError,
  RESOURCE_NOT_FOUND_ERROR,
  SubAgentRuntimeError,
} from './errors';
import {
  DEFAULT_EXECUTOR_MAX_BINDING_BYTES,
  DEFAULT_EXECUTOR_MAX_EVENT_PAGE_SIZE,
  type ExecutorTaskHandle,
  type ExecutorTaskSnapshot,
  type SubAgentExecutionControl,
  type SubAgentExecutionRequest,
  type SubAgentExecutor,
  type SubAgentExecutorBinding,
  type SubAgentExecutorBindingCodec,
} from './executor';
import { assertJsonValue, canonicalizeJson, parseJsonValue, type JsonValue } from './json';
import type {
  SubAgentExecutorRecoveryRequired,
  SubAgentExecutorOperationResult,
  SubAgentExecutionOutcome,
  SubAgentTaskState,
} from './result';
import type { SubAgentEventStreamOptions, SubAgentTaskHandle } from './runtime';
import type { SubAgentTaskEvent } from './telemetry';
import type { SubAgentTransportModelExchange } from './transport-model-gateway';
import {
  createRemoteSubAgentExecutionControl,
  createSubAgentTransportControlDispatcher,
  type SubAgentTransportControlReply,
  type SubAgentTransportControlRequest,
  type SubAgentTransportControlExchangeContext,
  type SubAgentTransportControlMethod,
} from './transport-control';
import {
  createSubAgentExecutionRequestWire,
  reconstructSubAgentExecutionRequest,
} from './transport-codec';
import {
  type SubAgentTransportPeer,
  type SubAgentTransportPeerExchange,
  type SubAgentTransportPeerHandlerRequest,
  type SubAgentTransportPeerRequestHandler,
  type SubAgentTransportPeerResponse,
} from './transport-peer';
import type { SubAgentTransportRpcPayloadMap } from './transport-rpc';
import {
  SubAgentTransportTaskHandleRegistry,
  rememberExecutorTaskHandle,
  type SubAgentTransportTaskHandleResolver,
} from './transport-task-handle-registry';
import {
  projectSubAgentTransportExecutorOperationResult,
  projectSubAgentTransportSafeError,
  type SubAgentTransportSafeError,
} from './transport-wire';
import {
  SubAgentTargetRunnerRegistry,
  type SubAgentTargetModelBinding,
  type SubAgentTargetRunnerIdentity,
} from './target-runner-registry';

type PeerProvider = SubAgentTransportPeer | (() => SubAgentTransportPeer);
const SAFE_RESOURCE_NOT_FOUND_ERROR = projectSubAgentTransportSafeError(RESOURCE_NOT_FOUND_ERROR);

export interface SubAgentTransportOperationIdContext {
  readonly kind: 'snapshot' | 'wait' | 'cancel' | 'events' | 'control';
  readonly taskId: string;
  readonly sequence: number;
  readonly identity?: string;
}

export type SubAgentTransportOperationIdFactory = (
  context: SubAgentTransportOperationIdContext,
) => string;

export interface SubAgentTransportModelRequestContext {
  readonly taskId: string;
  /** Trusted controller-local scope; never derived from the model RPC payload. */
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly executionEpoch: string;
  readonly executionFencingToken: string;
  readonly executionAttempt: number;
  readonly generation: number;
  /** Trusted controller-host cancellation scope, combined with bridge lifecycle release. */
  readonly signal: AbortSignal;
  /** Trusted absolute host deadline. Consumers intersect it with target-provided remainingMs. */
  readonly deadlineAt: number;
  readonly operationId: string;
  readonly payload: SubAgentTransportRpcPayloadMap['model.request'];
  readonly receivedAt: number;
}

export type SubAgentTransportModelRequestHandler = (
  context: SubAgentTransportModelRequestContext,
) =>
  | SubAgentTransportRpcPayloadMap['model.reply']
  | Promise<SubAgentTransportRpcPayloadMap['model.reply']>;

/** Closed target-side Model RPC helper; placement packages never reimplement Peer settlement. */
export function createSubAgentTransportModelExchange(
  peer: PeerProvider,
): SubAgentTransportModelExchange {
  return async (request) => {
    assertIdentifier(request.taskId, 'model exchange taskId');
    assertIdentifier(request.operationId, 'model exchange operationId');
    const response = await requestOne(resolvePeerProvider(peer), {
      kind: 'model.request',
      taskId: request.taskId,
      operationId: request.operationId,
      payload: request.payload,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    if (response.envelope.kind === 'protocol.error') {
      throw new SubAgentRuntimeError(response.envelope.payload.error);
    }
    if (response.envelope.kind !== 'model.reply') {
      throw bridgeInternalError('The controller Model gateway returned an invalid reply.');
    }
    return response.envelope.payload;
  };
}

export interface SubAgentTransportControllerEventsContext {
  readonly taskId: string;
  readonly afterSequence: number;
  readonly limit: number;
  /** Trusted active parent scopes on this channel; the resolver must authorize the child task. */
  readonly activeExecutions: readonly {
    readonly taskId: string;
    readonly ownerSessionId: string;
    readonly generation: number;
  }[];
}

export interface SubAgentTransportAuthorizedEvents {
  readonly ownerSessionId: string;
  readonly source: AsyncIterable<SubAgentTaskEvent>;
}

export type SubAgentTransportControllerEvents = (
  context: SubAgentTransportControllerEventsContext,
) => SubAgentTransportAuthorizedEvents | Promise<SubAgentTransportAuthorizedEvents>;

export interface CreateSubAgentTransportExecutorBridgeOptions {
  readonly descriptor: SubAgentExecutorDescriptor;
  readonly bindingCodec: SubAgentExecutorBindingCodec;
  readonly peer: PeerProvider;
  readonly getAvailability: () => ExecutorAvailabilityProbe | Promise<ExecutorAvailabilityProbe>;
  readonly supports: (
    definition: SubAgentExecutionRequest['definition'],
  ) => boolean | Promise<boolean>;
  readonly now?: () => number;
  readonly createOperationId?: SubAgentTransportOperationIdFactory;
  readonly model?: SubAgentTransportModelRequestHandler;
  /** Shared nested-task handles survive dispatcher/channel replacement within this controller. */
  readonly nestedTaskHandles?: SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>;
  /** Authoritative Runtime-backed resolver used by durable HTTP controller reconstruction. */
  readonly resolveNestedTaskHandle?: SubAgentTransportTaskHandleResolver<SubAgentTaskHandle>;
  /** Optional controller-local source used by target-side delegated task event handles. */
  readonly events?: SubAgentTransportControllerEvents;
}

interface ActiveControllerExecution {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly executionEpoch: string;
  readonly executionFencingToken: string;
  readonly executionAttempt: number;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly lifecycle: AbortController;
  readonly dispose: () => void;
  readonly dispatcher: ReturnType<typeof createSubAgentTransportControlDispatcher>;
  references: number;
}

/**
 * Controller-side placement-neutral Executor. The peer carries only wire data; the authoritative
 * control object remains in this process and is reachable solely through the reverse RPC handler.
 */
export class SubAgentTransportExecutorBridge implements SubAgentExecutor {
  readonly descriptor: SubAgentExecutorDescriptor;
  readonly bindingCodec: SubAgentExecutorBindingCodec;
  readonly handler: SubAgentTransportPeerRequestHandler;

  readonly #peer: PeerProvider;
  readonly #getAvailability: CreateSubAgentTransportExecutorBridgeOptions['getAvailability'];
  readonly #supports: CreateSubAgentTransportExecutorBridgeOptions['supports'];
  readonly #now: () => number;
  readonly #createOperationId: SubAgentTransportOperationIdFactory;
  readonly #model: SubAgentTransportModelRequestHandler | undefined;
  readonly #events: SubAgentTransportControllerEvents | undefined;
  readonly #nestedTaskHandles: SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>;
  readonly #resolveNestedTaskHandle:
    | SubAgentTransportTaskHandleResolver<SubAgentTaskHandle>
    | undefined;
  readonly #active = new Map<string, ActiveControllerExecution>();
  readonly #handles: SubAgentTransportTaskHandleRegistry<ExecutorTaskHandle>;
  readonly #handleBindings = new Map<string, string>();
  #nextOperationSequence = 1;
  #nextExecutionGeneration = 1;

  constructor(options: CreateSubAgentTransportExecutorBridgeOptions) {
    assertBridgeOptions(options);
    this.descriptor = options.descriptor;
    this.bindingCodec = options.bindingCodec;
    this.#peer = options.peer;
    this.#getAvailability = options.getAvailability;
    this.#supports = options.supports;
    this.#now = options.now ?? Date.now;
    this.#createOperationId = options.createOperationId ?? defaultOperationId;
    this.#model = options.model;
    this.#events = options.events;
    this.#nestedTaskHandles =
      options.nestedTaskHandles ?? new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    this.#resolveNestedTaskHandle = options.resolveNestedTaskHandle;
    this.#handles = new SubAgentTransportTaskHandleRegistry<ExecutorTaskHandle>({
      onEvict: (scope) => this.#handleBindings.delete(transportHandleScopeKey(scope)),
    });
    this.handler = (request) => this.#handleInbound(request);
  }

  getAvailability(): ExecutorAvailabilityProbe | Promise<ExecutorAvailabilityProbe> {
    return this.#getAvailability();
  }

  supports(definition: SubAgentExecutionRequest['definition']): boolean | Promise<boolean> {
    return this.#supports(definition);
  }

  diagnostics(): Readonly<{
    activeExecutions: number;
    taskHandles: number;
    handleBindings: number;
    nestedTaskHandles: number;
  }> {
    return Object.freeze({
      activeExecutions: this.#active.size,
      taskHandles: this.#handles.diagnostics().entries,
      handleBindings: this.#handleBindings.size,
      nestedTaskHandles: this.#nestedTaskHandles.diagnostics().entries,
    });
  }

  async execute(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<SubAgentExecutorOperationResult> {
    const release = this.#bindControl(request, control);
    try {
      const exchange = this.#openExecutorRequest(request, 'execute');
      const response = await requireNext(exchange);
      await requireDone(exchange);
      return readExecutorSettlement(response, 'execute');
    } finally {
      release();
    }
  }

  async spawn(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<ExecutorTaskHandle | SubAgentExecutorRecoveryRequired> {
    const release = this.#bindControl(request, control);
    let exchange: SubAgentTransportPeerExchange | undefined;
    try {
      exchange = this.#openExecutorRequest(request, 'spawn');
      const first = await requireNext(exchange);
      if (first.envelope.kind === 'protocol.error') {
        await requireDone(exchange);
        throw new SubAgentRuntimeError(first.envelope.payload.error);
      }
      if (first.envelope.kind === 'executor.settled') {
        const outcome = readExecutorSettlement(first, 'spawn');
        await requireDone(exchange);
        release();
        if (outcome.type !== 'recovery_required') {
          throw bridgeInternalError(
            'A spawn may settle before acceptance only when recovery is required.',
          );
        }
        return outcome;
      }
      if (first.envelope.kind !== 'executor.accepted') {
        throw bridgeInternalError('The remote spawn did not return an acceptance binding.');
      }

      const binding = first.envelope.payload.binding;
      this.#assertBinding(binding, request);
      const scope = Object.freeze({
        ownerSessionId: request.ownerSessionId,
        taskId: request.taskId,
      });
      const handleScope = transportHandleScopeKey(scope);
      const bindingIdentity = canonicalizeJson(binding as unknown as JsonValue);
      const previousBinding = this.#handleBindings.get(handleScope);
      if (previousBinding !== undefined && previousBinding !== bindingIdentity) {
        throw new SubAgentRuntimeError({
          code: 'BINDING_INVALID',
          message: 'A transport task handle cannot be rebound to a different target identity.',
          retryable: false,
        });
      }
      const facade = rememberExecutorTaskHandle(this.#handles, {
        ownerSessionId: request.ownerSessionId,
        taskId: request.taskId,
        binding,
        resolver: () => this.#createRawHandle(binding),
      });
      this.#handleBindings.set(handleScope, bindingIdentity);

      const background = this.#consumeSpawnSettlement(exchange, scope)
        .catch((error: unknown) => {
          // A lost settlement channel cannot retain process-local capabilities forever. The
          // returned facade keeps its trusted resolver and may reconstruct on the next operation.
          this.#handles.forget(scope);
          throw error;
        })
        .finally(release);
      void background.catch(() => undefined);
      exchange = undefined;
      return facade;
    } catch (error) {
      release();
      if (exchange !== undefined) await closeExchange(exchange);
      throw error;
    }
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
    this.#assertBindingForExecutor(binding);
    const response = await requestOne(this.#resolvePeer(), {
      kind: 'cancel.request',
      taskId: binding.taskId,
      operationId: options.operationId,
      payload: {
        binding,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      },
      signal: options.signal,
      timeoutMs: remainingMs(options.deadlineAt, this.#now),
    });
    if (response.envelope.kind === 'protocol.error') {
      throw new SubAgentRuntimeError(response.envelope.payload.error);
    }
    if (response.envelope.kind !== 'cancel.ack') {
      throw bridgeInternalError('The remote cancellation returned an invalid reply.');
    }
  }

  #openExecutorRequest(
    request: SubAgentExecutionRequest,
    mode: 'execute' | 'spawn',
  ): SubAgentTransportPeerExchange {
    return this.#resolvePeer().request({
      kind: 'executor.request',
      taskId: request.taskId,
      operationId: request.operation.operationId,
      payload: {
        mode,
        request: createSubAgentExecutionRequestWire(request, {
          now: this.#now,
          expectedExecutorName: this.descriptor.name,
          maxBindingBytes: this.descriptor.maxBindingBytes,
        }),
      },
      signal: request.signal,
      timeoutMs: remainingMs(request.deadlineAt, this.#now),
    });
  }

  #bindControl(request: SubAgentExecutionRequest, control: SubAgentExecutionControl): () => void {
    const existing = this.#active.get(request.taskId);
    if (existing !== undefined) {
      if (existing.ownerSessionId !== request.ownerSessionId) throw createResourceNotFoundError();
      throw new SubAgentRuntimeError({
        code: 'INVALID_STATE_TRANSITION',
        message: 'A transport execution is already active for this task.',
        retryable: false,
      });
    }
    const lifecycle = new AbortController();
    const deadlineAt = Math.min(request.deadlineAt, control.deadlineAt);
    const scope = createBridgeAbortScope(
      AbortSignal.any([request.signal, control.signal, lifecycle.signal]),
      deadlineAt,
      this.#now,
    );
    const active: ActiveControllerExecution = {
      ownerSessionId: request.ownerSessionId,
      runId: request.runId,
      executionEpoch: request.executionEpoch,
      executionFencingToken: request.executionFencingToken,
      executionAttempt: request.attempt,
      generation: this.#nextExecutionGeneration++,
      signal: scope.signal,
      deadlineAt,
      lifecycle,
      dispose: scope.dispose,
      dispatcher: createSubAgentTransportControlDispatcher({
        control,
        taskId: request.taskId,
        ownerSessionId: request.ownerSessionId,
        taskHandles: this.#nestedTaskHandles,
        ...(this.#resolveNestedTaskHandle === undefined
          ? {}
          : { resolveTaskHandle: this.#resolveNestedTaskHandle }),
      }),
      references: 1,
    };
    this.#active.set(request.taskId, active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active.references -= 1;
      if (active.references === 0 && this.#active.get(request.taskId) === active) {
        if (!active.lifecycle.signal.aborted) {
          active.lifecycle.abort(createResourceNotFoundError());
        }
        active.dispose();
        this.#active.delete(request.taskId);
      }
    };
  }

  async #consumeSpawnSettlement(
    exchange: SubAgentTransportPeerExchange,
    scope: Readonly<{ readonly ownerSessionId: string; readonly taskId: string }>,
  ): Promise<void> {
    const response = await requireNext(exchange);
    await requireDone(exchange);
    const outcome = readExecutorSettlement(response, 'spawn');
    if (outcome.type === 'terminal') this.#handles.markTerminal(scope);
  }

  #createRawHandle(binding: SubAgentExecutorBinding): ExecutorTaskHandle {
    const request = async (
      mode: 'snapshot' | 'wait',
      signal?: AbortSignal,
    ): Promise<SubAgentTransportPeerResponse> =>
      requestOne(this.#resolvePeer(), {
        kind: 'snapshot.request',
        taskId: binding.taskId,
        operationId: this.#nextOperation(mode, binding.taskId),
        payload: { mode },
        ...(signal === undefined ? {} : { signal }),
      });

    return Object.freeze({
      taskId: binding.taskId,
      binding,
      snapshot: async (): Promise<ExecutorTaskSnapshot> => {
        const response = await request('snapshot');
        if (response.envelope.kind === 'protocol.error') {
          throw new SubAgentRuntimeError(response.envelope.payload.error);
        }
        if (response.envelope.kind !== 'snapshot.reply') {
          throw bridgeInternalError('The remote snapshot returned an invalid reply.');
        }
        return response.envelope.payload.snapshot;
      },
      wait: async (): Promise<SubAgentExecutorOperationResult> => {
        const response = await request('wait');
        return readExecutorSettlement(response, 'wait');
      },
      cancel: async (reason?: string): Promise<void> =>
        this.cancel(binding, {
          operationId: this.#nextOperation('cancel', binding.taskId),
          ...(reason === undefined ? {} : { reason }),
          signal: new AbortController().signal,
          deadlineAt: this.#now() + 120_000,
        }),
      events: (options?: Parameters<ExecutorTaskHandle['events']>[0]) =>
        this.#remoteEvents(binding, options),
    });
  }

  async *#remoteEvents(
    binding: SubAgentExecutorBinding,
    options: Parameters<ExecutorTaskHandle['events']>[0] = {},
  ): AsyncIterable<SubAgentTaskEvent> {
    let cursor = options.afterSequence ?? 0;
    const limit = Math.min(
      options.limit ?? this.descriptor.maxEventPageSize,
      this.descriptor.maxEventPageSize,
      DEFAULT_EXECUTOR_MAX_EVENT_PAGE_SIZE,
    );
    let active: SubAgentTransportPeerExchange | undefined;
    try {
      while (true) {
        active = this.#resolvePeer().request({
          kind: 'events.request',
          taskId: binding.taskId,
          operationId: this.#nextOperation('events', binding.taskId, String(cursor)),
          payload: {
            ...(cursor === 0 ? {} : { afterSequence: cursor }),
            limit,
          },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const response = await requireNext(active);
        await requireDone(active);
        active = undefined;
        if (response.envelope.kind === 'protocol.error') {
          throw new SubAgentRuntimeError(response.envelope.payload.error);
        }
        if (response.envelope.kind !== 'events.page') {
          throw bridgeInternalError('The remote event stream returned an invalid reply.');
        }
        for (const event of response.envelope.payload.events) yield event;
        if (!response.envelope.payload.done && response.envelope.payload.events.length === 0) {
          throw bridgeInternalError(
            'The remote event page made no progress before reporting more data.',
          );
        }
        cursor = response.envelope.payload.nextSequence;
        if (response.envelope.payload.done) return;
      }
    } finally {
      if (active !== undefined) await closeExchange(active);
    }
  }

  async #handleInbound(request: SubAgentTransportPeerHandlerRequest): Promise<void> {
    const { envelope } = request;
    if (envelope.kind === 'control.request') {
      const active = this.#active.get(envelope.taskId);
      if (
        active === undefined ||
        envelope.payload.executionAttempt !== active.executionAttempt ||
        envelope.payload.executionEpoch !== active.executionEpoch ||
        envelope.payload.executionFencingToken !== active.executionFencingToken ||
        active.signal.aborted ||
        deadlineExpired(active.deadlineAt, this.#now)
      ) {
        await request.reply({
          kind: 'control.reply',
          payload: controlErrorReply(envelope.payload.method, SAFE_RESOURCE_NOT_FOUND_ERROR),
        });
        return;
      }
      const controlRequest = {
        taskId: envelope.taskId,
        operationId: envelope.operationId,
        method: envelope.payload.method,
        args: envelope.payload.args,
      } as SubAgentTransportControlRequest;
      await request.reply({
        kind: 'control.reply',
        payload: await active.dispatcher.dispatch(controlRequest),
      });
      return;
    }
    if (envelope.kind === 'model.request') {
      const model = this.#model;
      const active = this.#active.get(envelope.taskId);
      if (model === undefined || active === undefined) {
        await request.reply({
          kind: 'protocol.error',
          payload: { error: SAFE_RESOURCE_NOT_FOUND_ERROR },
        });
        return;
      }
      if (
        envelope.payload.runId !== active.runId ||
        envelope.payload.executionAttempt !== active.executionAttempt ||
        envelope.payload.executionEpoch !== active.executionEpoch ||
        envelope.payload.executionFencingToken !== active.executionFencingToken ||
        envelope.payload.providerOperationId !== envelope.operationId
      ) {
        await request.reply({
          kind: 'protocol.error',
          payload: {
            error: {
              code: 'BINDING_INVALID',
              message: 'The Model request does not belong to the active execution.',
              retryable: false,
            },
          },
        });
        return;
      }
      try {
        if (active.signal.aborted || deadlineExpired(active.deadlineAt, this.#now)) {
          throw active.signal.reason ?? createResourceNotFoundError();
        }
        const reply = await model({
          taskId: envelope.taskId,
          ownerSessionId: active.ownerSessionId,
          runId: active.runId,
          executionEpoch: active.executionEpoch,
          executionFencingToken: active.executionFencingToken,
          executionAttempt: active.executionAttempt,
          generation: active.generation,
          signal: active.signal,
          deadlineAt: active.deadlineAt,
          operationId: envelope.operationId,
          payload: envelope.payload,
          receivedAt: request.receivedAt,
        });
        if (
          this.#active.get(envelope.taskId) !== active ||
          active.signal.aborted ||
          deadlineExpired(active.deadlineAt, this.#now)
        ) {
          throw createResourceNotFoundError();
        }
        await request.reply({ kind: 'model.reply', payload: reply });
      } catch (error) {
        await request.reply({ kind: 'protocol.error', payload: { error: safeError(error) } });
      }
      return;
    }
    const events = this.#events;
    if (envelope.kind === 'events.request' && events !== undefined) {
      try {
        const activeExecutions = Object.freeze(
          [...this.#active.entries()].map(([taskId, active]) =>
            Object.freeze({
              taskId,
              ownerSessionId: active.ownerSessionId,
              generation: active.generation,
            }),
          ),
        );
        if (activeExecutions.length === 0) throw createResourceNotFoundError();
        const authorized = await events({
          taskId: envelope.taskId,
          afterSequence: envelope.payload.afterSequence ?? 0,
          limit: envelope.payload.limit ?? DEFAULT_EXECUTOR_MAX_EVENT_PAGE_SIZE,
          activeExecutions,
        });
        assertIdentifier(authorized.ownerSessionId, 'authorized event ownerSessionId');
        const page = await readEventPage(
          authorized.source,
          envelope.taskId,
          envelope.payload.afterSequence ?? 0,
          envelope.payload.limit ?? DEFAULT_EXECUTOR_MAX_EVENT_PAGE_SIZE,
          authorized.ownerSessionId,
        );
        await request.reply({ kind: 'events.page', payload: page });
      } catch (error) {
        await request.reply({ kind: 'protocol.error', payload: { error: safeError(error) } });
      }
      return;
    }
    await request.reply({
      kind: 'protocol.error',
      payload: { error: SAFE_RESOURCE_NOT_FOUND_ERROR },
    });
  }

  #resolvePeer(): SubAgentTransportPeer {
    const peer = typeof this.#peer === 'function' ? this.#peer() : this.#peer;
    if (peer === null || typeof peer !== 'object' || typeof peer.request !== 'function') {
      throw new TypeError('Subagent transport bridge peer provider returned an invalid peer.');
    }
    return peer;
  }

  #nextOperation(
    kind: SubAgentTransportOperationIdContext['kind'],
    taskId: string,
    identity?: string,
  ): string {
    const operationId = this.#createOperationId({
      kind,
      taskId,
      sequence: this.#nextOperationSequence++,
      ...(identity === undefined ? {} : { identity }),
    });
    assertIdentifier(operationId, 'transport operationId');
    return operationId;
  }

  #assertBinding(binding: SubAgentExecutorBinding, request: SubAgentExecutionRequest): void {
    this.#assertBindingForExecutor(binding);
    if (
      binding.ownerSessionId !== request.ownerSessionId ||
      binding.taskId !== request.taskId ||
      binding.subagentSessionId !== request.subagentSessionId ||
      binding.definitionName !== request.definition.name ||
      binding.definitionVersion !== request.definition.version
    ) {
      throw new SubAgentRuntimeError({
        code: 'BINDING_INVALID',
        message: 'The transport acceptance binding does not match the execution request.',
        retryable: false,
      });
    }
  }

  #assertBindingForExecutor(binding: SubAgentExecutorBinding): void {
    if (
      binding.executorName !== this.descriptor.name ||
      binding.adapterStateVersion !== this.bindingCodec.adapterStateVersion
    ) {
      throw new SubAgentRuntimeError({
        code: 'BINDING_INVALID',
        message: 'The transport binding does not belong to this Executor.',
        retryable: false,
      });
    }
    try {
      this.bindingCodec.decode(binding.recoveryData);
    } catch {
      throw new SubAgentRuntimeError({
        code: 'BINDING_INVALID',
        message: 'The transport binding recovery data is invalid.',
        retryable: false,
      });
    }
  }
}

export function createSubAgentTransportExecutorBridge(
  options: CreateSubAgentTransportExecutorBridgeOptions,
): SubAgentTransportExecutorBridge {
  return new SubAgentTransportExecutorBridge(options);
}

export interface SubAgentTransportTargetBindingContext {
  readonly request: SubAgentExecutionRequest;
  readonly runner: SubAgentTargetRunnerIdentity;
  readonly modelBinding: SubAgentTargetModelBinding;
}

export interface SubAgentTransportTargetCatalog {
  readonly catalog: ExecutorCatalogSnapshot;
  readonly catalogEntries: readonly SubAgentCatalogEntry[];
}

export interface SubAgentTransportTargetEventsContext {
  readonly request: SubAgentExecutionRequest;
  readonly binding: SubAgentExecutorBinding;
  readonly afterSequence: number;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface CreateSubAgentTransportTargetBridgeOptions {
  /** Trusted owner authenticated by the placement channel; never inferred from an RPC payload. */
  readonly ownerSessionId: string;
  readonly executorName: string;
  readonly registry: SubAgentTargetRunnerRegistry;
  readonly bindingCodec: SubAgentExecutorBindingCodec;
  readonly peer: PeerProvider;
  readonly createBinding: (
    context: SubAgentTransportTargetBindingContext,
  ) => SubAgentExecutorBinding | Promise<SubAgentExecutorBinding>;
  readonly resolveCatalog?: (request: SubAgentExecutionRequest) => SubAgentTransportTargetCatalog;
  readonly events?: (
    context: SubAgentTransportTargetEventsContext,
  ) => AsyncIterable<SubAgentTaskEvent>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly maxEventPageSize?: number;
  /**
   * Process-local receipt ceiling. Exact replays remain available until `dispose()`; reaching the
   * ceiling fails closed instead of evicting an idempotency receipt and rerunning an operation.
   */
  readonly maxRetainedTasks?: number;
  readonly maxRetainedOperations?: number;
  readonly createOperationId?: SubAgentTransportOperationIdFactory;
}

interface TargetTaskRecord {
  readonly ownerSessionId: string;
  readonly binding: SubAgentExecutorBinding;
  readonly modelBinding: SubAgentTargetModelBinding;
  readonly runner: SubAgentChildRunner;
  readonly controller: AbortController;
  request: SubAgentExecutionRequest;
  promise: Promise<SubAgentExecutionOutcome>;
  outcome?: SubAgentExecutionOutcome;
  running: boolean;
  updatedAt: number;
}

interface TargetOperationRecord {
  /** `remainingMs` is transport-relative, so it is not part of the stable request identity. */
  readonly requestIdentity: string;
  /** The first accepted budget is a ceiling: retries may age, but cannot extend the deadline. */
  readonly initialRemainingMs: number;
  readonly mode: 'execute' | 'spawn';
  readonly started: Promise<TargetTaskRecord>;
}

/** Target-side request handler shared by Worker, Process and HTTP placement packages. */
export class SubAgentTransportTargetBridge {
  readonly handler: SubAgentTransportPeerRequestHandler;
  readonly modelExchange: SubAgentTransportModelExchange;

  readonly #ownerSessionId: string;
  readonly #executorName: string;
  readonly #registry: SubAgentTargetRunnerRegistry;
  readonly #bindingCodec: SubAgentExecutorBindingCodec;
  readonly #peer: PeerProvider;
  readonly #createBinding: CreateSubAgentTransportTargetBridgeOptions['createBinding'];
  readonly #resolveCatalog: NonNullable<
    CreateSubAgentTransportTargetBridgeOptions['resolveCatalog']
  >;
  readonly #events: CreateSubAgentTransportTargetBridgeOptions['events'];
  readonly #now: () => number;
  readonly #lifecycle = new AbortController();
  readonly #signal: AbortSignal;
  readonly #maxEventPageSize: number;
  readonly #maxRetainedTasks: number;
  readonly #maxRetainedOperations: number;
  readonly #createOperationId: SubAgentTransportOperationIdFactory;
  readonly #tasks = new Map<string, TargetTaskRecord>();
  readonly #startingTasks = new Set<string>();
  readonly #operations = new Map<string, TargetOperationRecord>();
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #nextOperationSequence = 1;

  constructor(options: CreateSubAgentTransportTargetBridgeOptions) {
    assertIdentifier(options.ownerSessionId, 'target ownerSessionId');
    assertIdentifier(options.executorName, 'target executorName');
    if (!options.registry.sealed) {
      throw new TypeError('Seal the target runner registry before creating a transport bridge.');
    }
    options.registry.assertTransportReady();
    if (typeof options.createBinding !== 'function') {
      throw new TypeError('A target transport bridge requires a binding factory.');
    }
    this.#ownerSessionId = options.ownerSessionId;
    this.#executorName = options.executorName;
    this.#registry = options.registry;
    this.#bindingCodec = options.bindingCodec;
    this.#peer = options.peer;
    this.#createBinding = options.createBinding;
    this.#resolveCatalog = options.resolveCatalog ?? emptyTargetCatalog;
    this.#events = options.events;
    this.#now = options.now ?? Date.now;
    this.#signal =
      options.signal === undefined
        ? this.#lifecycle.signal
        : AbortSignal.any([options.signal, this.#lifecycle.signal]);
    this.#maxEventPageSize = positiveInteger(
      options.maxEventPageSize,
      DEFAULT_EXECUTOR_MAX_EVENT_PAGE_SIZE,
      'maxEventPageSize',
    );
    this.#maxRetainedTasks = positiveInteger(options.maxRetainedTasks, 10_000, 'maxRetainedTasks');
    this.#maxRetainedOperations = positiveInteger(
      options.maxRetainedOperations,
      10_000,
      'maxRetainedOperations',
    );
    this.#createOperationId = options.createOperationId ?? defaultOperationId;
    this.handler = (request) => this.#handleInbound(request);
    const exchange = createSubAgentTransportModelExchange(options.peer);
    this.modelExchange = async (request) => {
      const task = this.#requireTask(request.taskId);
      if (
        request.payload.gatewayId !== task.modelBinding.gatewayId ||
        request.payload.protocol !== task.modelBinding.protocol ||
        request.payload.codecVersion !== task.modelBinding.codecVersion
      ) {
        throw new SubAgentRuntimeError({
          code: 'BINDING_INVALID',
          message: 'The target Model request does not match its registered gateway binding.',
          retryable: false,
        });
      }
      return exchange(request);
    };
  }

  diagnostics(): Readonly<{
    disposed: boolean;
    tasks: number;
    operations: number;
    starting: number;
    running: number;
    taskCapacity: number;
    operationCapacity: number;
  }> {
    return Object.freeze({
      disposed: this.#disposed,
      tasks: this.#tasks.size,
      operations: this.#operations.size,
      starting: this.#startingTasks.size,
      running: [...this.#tasks.values()].filter(({ running }) => running).length,
      taskCapacity: this.#maxRetainedTasks,
      operationCapacity: this.#maxRetainedOperations,
    });
  }

  /**
   * Releases this process-local channel and all retained terminal/idempotency receipts. Disposal is
   * irreversible: later requests fail closed, so clearing receipts can never cause an operation to
   * run again. Durable HTTP reconstruction is supplied by its placement adapter in a later phase.
   */
  dispose(reason: unknown = createResourceNotFoundError()): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    const settlements = [
      ...[...this.#tasks.values()].map(({ promise }) => promise),
      ...[...this.#operations.values()].map(({ started }) =>
        started.then(({ promise }) => promise),
      ),
    ];
    if (!this.#lifecycle.signal.aborted) this.#lifecycle.abort(reason);
    for (const task of this.#tasks.values()) {
      if (task.running && !task.controller.signal.aborted) task.controller.abort(reason);
    }
    this.#disposePromise = Promise.allSettled(settlements).then(() => {
      this.#tasks.clear();
      this.#startingTasks.clear();
      this.#operations.clear();
    });
    return this.#disposePromise;
  }

  async #handleInbound(request: SubAgentTransportPeerHandlerRequest): Promise<void> {
    if (this.#disposed) {
      await request.reply({
        kind: 'protocol.error',
        payload: { error: SAFE_RESOURCE_NOT_FOUND_ERROR },
      });
      return;
    }
    switch (request.envelope.kind) {
      case 'executor.request':
        await this.#handleExecutorRequest(request);
        return;
      case 'cancel.request':
        await this.#handleCancel(request);
        return;
      case 'snapshot.request':
        await this.#handleSnapshot(request);
        return;
      case 'events.request':
        await this.#handleEvents(request);
        return;
      default:
        await request.reply({
          kind: 'protocol.error',
          payload: { error: SAFE_RESOURCE_NOT_FOUND_ERROR },
        });
    }
  }

  async #handleExecutorRequest(request: SubAgentTransportPeerHandlerRequest): Promise<void> {
    const envelope = request.envelope;
    if (envelope.kind !== 'executor.request') return;
    if (!this.#ownsExecutionWire(envelope.taskId, envelope.payload.request)) {
      await request.reply({
        kind: 'protocol.error',
        payload: { error: SAFE_RESOURCE_NOT_FOUND_ERROR },
      });
      return;
    }
    const mode = envelope.payload.mode;
    const candidate = targetOperationRequestIdentity(envelope.payload.request);
    const key = `${this.#ownerSessionId}\0${envelope.taskId}\0${envelope.operationId}`;
    const existing = this.#operations.get(key);
    if (
      existing !== undefined &&
      (existing.requestIdentity !== candidate.requestIdentity ||
        existing.mode !== mode ||
        candidate.remainingMs > existing.initialRemainingMs)
    ) {
      await request.reply({
        kind: 'protocol.error',
        payload: {
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'The transport operation was replayed with a conflicting request.',
            retryable: false,
          },
        },
      });
      return;
    }

    let operation = existing;
    if (operation === undefined) {
      if (this.#operations.size >= this.#maxRetainedOperations) {
        await request.reply({
          kind: 'protocol.error',
          payload: { error: targetCapacityError('operation receipt') },
        });
        return;
      }
      const started = this.#start(envelope.payload.request);
      void started.catch(() => undefined);
      operation = Object.freeze({
        requestIdentity: candidate.requestIdentity,
        initialRemainingMs: candidate.remainingMs,
        mode,
        started,
      });
      this.#operations.set(key, operation);
    }

    try {
      const task = await operation.started;
      if (mode === 'spawn') {
        await request.reply({
          kind: 'executor.accepted',
          payload: { mode: 'spawn', binding: task.binding },
        });
      }
      const outcome = await task.promise;
      await request.reply({
        kind: 'executor.settled',
        payload: {
          mode,
          outcome: projectSubAgentTransportExecutorOperationResult(outcome),
        },
      });
    } catch (error) {
      await request.reply({ kind: 'protocol.error', payload: { error: safeError(error) } });
    }
  }

  async #start(
    wire: SubAgentTransportRpcPayloadMap['executor.request']['request'],
  ): Promise<TargetTaskRecord> {
    let claimedTaskKey: string | undefined;
    const receiver = new AbortController();
    const forwardAbort = (): void => receiver.abort(this.#signal.reason);
    if (this.#signal.aborted) forwardAbort();
    else this.#signal.addEventListener('abort', forwardAbort, { once: true });
    const reconstruction = reconstructSubAgentExecutionRequest(wire, {
      signal: receiver.signal,
      now: this.#now,
      expectedExecutorName: this.#executorName,
    });
    const request = reconstruction.request;
    try {
      if (request.ownerSessionId !== this.#ownerSessionId) {
        throw createResourceNotFoundError();
      }
      if (request.operation.type === 'reconnect') {
        const resident = this.#requireTask(request.taskId);
        this.#assertTaskBinding(resident, request.operation.binding);
        assertForwardResume(resident.request, request);
        if (resident.running) {
          throw new SubAgentRuntimeError({
            code: 'RECOVERY_UNSUPPORTED',
            message:
              'A live target runner cannot be rebound to a new execution epoch by the generic transport bridge.',
            retryable: false,
          });
        }
        resident.request = request;
        resident.updatedAt = this.#readNow();
        reconstruction.dispose();
        this.#signal.removeEventListener('abort', forwardAbort);
        return resident;
      }

      const taskKey = this.#taskKey(request.taskId);
      if (this.#startingTasks.has(taskKey)) {
        throw new SubAgentRuntimeError({
          code: 'INVALID_STATE_TRANSITION',
          message: 'The target task is already being initialized.',
          retryable: false,
        });
      }
      this.#startingTasks.add(taskKey);
      claimedTaskKey = taskKey;
      const resident = this.#tasks.get(taskKey);
      if (request.operation.type === 'create' && resident !== undefined) {
        throw new SubAgentRuntimeError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The target task identity is already in use.',
          retryable: false,
        });
      }
      if (resident?.running === true) {
        throw new SubAgentRuntimeError({
          code: 'INVALID_STATE_TRANSITION',
          message: 'The target task is already running.',
          retryable: false,
        });
      }
      if (request.operation.type === 'resume' && resident !== undefined) {
        this.#assertTaskBinding(resident, request.operation.binding);
        assertForwardResume(resident.request, request);
      }
      if (resident === undefined && this.#tasks.size >= this.#maxRetainedTasks) {
        throw new SubAgentRuntimeError(targetCapacityError('task receipt'));
      }

      const prepared = this.#registry.prepareExecution(request, this.#executorName);
      const modelBinding = prepared.modelBinding;
      if (modelBinding === undefined) {
        throw new SubAgentRuntimeError({
          code: 'BINDING_INVALID',
          message: 'The target runner has no registered Model gateway binding.',
          retryable: false,
        });
      }
      const runner =
        request.operation.type === 'resume' &&
        request.operation.reason === 'approval' &&
        resident !== undefined
          ? resident.runner
          : await prepared.create();
      if (this.#disposed) throw createResourceNotFoundError();
      const bindingCandidate =
        request.operation.type === 'create'
          ? await this.#createBinding({ request, runner: prepared.runner, modelBinding })
          : request.operation.binding;
      if (this.#disposed) throw createResourceNotFoundError();
      const binding = ownedBinding(bindingCandidate);
      this.#assertCreatedBinding(binding, request, prepared.runner, modelBinding);

      const catalog = this.#resolveCatalog(request);
      const control = createRemoteSubAgentExecutionControl({
        taskId: request.taskId,
        executionAttempt: request.attempt,
        executionEpoch: request.executionEpoch,
        executionFencingToken: request.executionFencingToken,
        signal: request.signal,
        deadlineAt: request.deadlineAt,
        delegationSnapshot: request.delegation,
        catalog: catalog.catalog,
        catalogEntries: catalog.catalogEntries,
        exchange: (controlRequest, context) => this.#exchangeControl(controlRequest, context),
        createOperationId: (method, identity) =>
          this.#nextControlOperation(request.taskId, method, identity),
        events: (taskId, eventOptions) => this.#remoteControllerEvents(taskId, eventOptions),
      });
      if (request.operation.type === 'create') {
        await control.commitBinding(request.operation.operationId, binding);
      }
      if (this.#disposed) throw createResourceNotFoundError();

      const taskController = new AbortController();
      const childSignal = AbortSignal.any([request.signal, taskController.signal]);
      const childRequest = Object.freeze({ ...prepared.request, signal: childSignal });
      const childControl = Object.freeze({ ...control, signal: childSignal });
      const task: TargetTaskRecord = {
        ownerSessionId: request.ownerSessionId,
        binding,
        modelBinding,
        runner,
        controller: taskController,
        request,
        promise: Promise.resolve(undefined as never),
        running: true,
        updatedAt: this.#readNow(),
      };
      this.#tasks.set(taskKey, task);
      this.#startingTasks.delete(taskKey);
      claimedTaskKey = undefined;
      const promise = Promise.resolve()
        .then(() => runner.run(childRequest, childControl))
        .then((outcome) => {
          task.outcome = outcome;
          return outcome;
        })
        .finally(() => {
          task.running = false;
          task.updatedAt = this.#readNow();
          reconstruction.dispose();
          this.#signal.removeEventListener('abort', forwardAbort);
        });
      void promise.catch(() => undefined);
      task.promise = promise;
      return task;
    } catch (error) {
      if (claimedTaskKey !== undefined) this.#startingTasks.delete(claimedTaskKey);
      reconstruction.dispose();
      this.#signal.removeEventListener('abort', forwardAbort);
      throw error;
    }
  }

  async #handleCancel(request: SubAgentTransportPeerHandlerRequest): Promise<void> {
    const envelope = request.envelope;
    if (envelope.kind !== 'cancel.request') return;
    try {
      if (envelope.payload.binding.ownerSessionId !== this.#ownerSessionId) {
        throw createResourceNotFoundError();
      }
      const task = this.#requireTask(envelope.taskId);
      this.#assertTaskBinding(task, envelope.payload.binding);
      if (!task.controller.signal.aborted && task.running) {
        task.controller.abort(
          new SubAgentRuntimeError({
            code: 'CANCELLED',
            message: envelope.payload.reason?.trim()
              ? 'The remote child was cancelled by its host.'
              : 'The remote child was cancelled.',
            retryable: false,
          }),
        );
      }
      await request.reply({ kind: 'cancel.ack', payload: { cancelled: true } });
    } catch (error) {
      await request.reply({ kind: 'protocol.error', payload: { error: safeError(error) } });
    }
  }

  async #handleSnapshot(request: SubAgentTransportPeerHandlerRequest): Promise<void> {
    const envelope = request.envelope;
    if (envelope.kind !== 'snapshot.request') return;
    try {
      const task = this.#requireTask(envelope.taskId);
      if (envelope.payload.mode === 'snapshot') {
        await request.reply({
          kind: 'snapshot.reply',
          payload: {
            mode: 'snapshot',
            snapshot: Object.freeze({
              taskId: envelope.taskId,
              state: task.running ? 'running' : stateFromOutcome(task.outcome),
              binding: task.binding,
              updatedAt: task.updatedAt,
            }),
          },
        });
        return;
      }
      const outcome = await task.promise;
      await request.reply({
        kind: 'executor.settled',
        payload: {
          mode: 'wait',
          outcome: projectSubAgentTransportExecutorOperationResult(outcome),
        },
      });
    } catch (error) {
      await request.reply({ kind: 'protocol.error', payload: { error: safeError(error) } });
    }
  }

  async #handleEvents(request: SubAgentTransportPeerHandlerRequest): Promise<void> {
    const envelope = request.envelope;
    if (envelope.kind !== 'events.request') return;
    try {
      const task = this.#requireTask(envelope.taskId);
      const afterSequence = envelope.payload.afterSequence ?? 0;
      const limit = Math.min(
        envelope.payload.limit ?? this.#maxEventPageSize,
        this.#maxEventPageSize,
      );
      const source =
        this.#events?.({
          request: task.request,
          binding: task.binding,
          afterSequence,
          limit,
        }) ?? emptyEvents();
      await request.reply({
        kind: 'events.page',
        payload: await readEventPage(
          source,
          envelope.taskId,
          afterSequence,
          limit,
          task.ownerSessionId,
        ),
      });
    } catch (error) {
      await request.reply({ kind: 'protocol.error', payload: { error: safeError(error) } });
    }
  }

  async #exchangeControl(
    controlRequest: SubAgentTransportControlRequest,
    context: SubAgentTransportControlExchangeContext,
  ): Promise<SubAgentTransportControlReply> {
    const response = await requestOne(this.#resolvePeer(), {
      kind: 'control.request',
      taskId: controlRequest.taskId,
      operationId: controlRequest.operationId,
      payload: {
        executionAttempt: context.executionAttempt,
        executionEpoch: context.executionEpoch,
        executionFencingToken: context.executionFencingToken,
        method: controlRequest.method,
        args: controlRequest.args,
      } as SubAgentTransportRpcPayloadMap['control.request'],
      signal: context.signal,
      timeoutMs: remainingMs(context.deadlineAt, this.#now),
    });
    if (response.envelope.kind === 'protocol.error') {
      throw new SubAgentRuntimeError(response.envelope.payload.error);
    }
    if (response.envelope.kind !== 'control.reply') {
      throw bridgeInternalError('The reverse control exchange returned an invalid reply.');
    }
    return response.envelope.payload;
  }

  async *#remoteControllerEvents(
    taskId: string,
    options: SubAgentEventStreamOptions = {},
  ): AsyncIterable<SubAgentTaskEvent> {
    let cursor = options.afterSequence ?? 0;
    const limit = Math.min(options.limit ?? this.#maxEventPageSize, this.#maxEventPageSize);
    let active: SubAgentTransportPeerExchange | undefined;
    try {
      while (true) {
        active = this.#resolvePeer().request({
          kind: 'events.request',
          taskId,
          operationId: this.#nextOperation('events', taskId, String(cursor)),
          payload: { ...(cursor === 0 ? {} : { afterSequence: cursor }), limit },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const response = await requireNext(active);
        await requireDone(active);
        active = undefined;
        if (response.envelope.kind === 'protocol.error') {
          throw new SubAgentRuntimeError(response.envelope.payload.error);
        }
        if (response.envelope.kind !== 'events.page') {
          throw bridgeInternalError('The controller event source returned an invalid reply.');
        }
        for (const event of response.envelope.payload.events) yield event;
        if (!response.envelope.payload.done && response.envelope.payload.events.length === 0) {
          throw bridgeInternalError(
            'The controller event page made no progress before reporting more data.',
          );
        }
        cursor = response.envelope.payload.nextSequence;
        if (response.envelope.payload.done) return;
      }
    } finally {
      if (active !== undefined) await closeExchange(active);
    }
  }

  #requireTask(taskId: string): TargetTaskRecord {
    const task = this.#tasks.get(this.#taskKey(taskId));
    if (task === undefined) throw createResourceNotFoundError();
    return task;
  }

  #taskKey(taskId: string): string {
    return `${this.#ownerSessionId}\0${taskId}`;
  }

  #ownsExecutionWire(
    taskId: string,
    wire: SubAgentTransportRpcPayloadMap['executor.request']['request'],
  ): boolean {
    if (
      wire.ownerSessionId !== this.#ownerSessionId ||
      wire.delegation.ownerSessionId !== this.#ownerSessionId ||
      wire.taskId !== taskId
    ) {
      return false;
    }
    return wire.operation.type === 'create'
      ? true
      : wire.operation.binding.ownerSessionId === this.#ownerSessionId &&
          wire.operation.binding.taskId === taskId;
  }

  #assertTaskBinding(task: TargetTaskRecord, binding: SubAgentExecutorBinding): void {
    if (
      binding.ownerSessionId !== this.#ownerSessionId ||
      task.ownerSessionId !== this.#ownerSessionId ||
      !bindingsEqual(task.binding, binding)
    ) {
      throw createResourceNotFoundError();
    }
  }

  #assertCreatedBinding(
    binding: SubAgentExecutorBinding,
    request: SubAgentExecutionRequest,
    runner: SubAgentTargetRunnerIdentity,
    modelBinding: SubAgentTargetModelBinding,
  ): void {
    if (
      binding.version !== '1' ||
      binding.executorName !== this.#executorName ||
      binding.ownerSessionId !== request.ownerSessionId ||
      binding.taskId !== request.taskId ||
      binding.subagentSessionId !== request.subagentSessionId ||
      binding.definitionName !== request.definition.name ||
      binding.definitionVersion !== request.definition.version ||
      binding.runnerId !== runner.runnerId ||
      binding.runnerVersion !== runner.runnerVersion ||
      !modelBindingsEqual(binding.modelBinding, modelBinding) ||
      binding.adapterStateVersion !== this.#bindingCodec.adapterStateVersion
    ) {
      throw new SubAgentRuntimeError({
        code: 'BINDING_INVALID',
        message: 'The target binding factory returned an incompatible binding.',
        retryable: false,
      });
    }
    try {
      this.#bindingCodec.decode(binding.recoveryData);
    } catch {
      throw new SubAgentRuntimeError({
        code: 'BINDING_INVALID',
        message: 'The target binding factory returned invalid recovery data.',
        retryable: false,
      });
    }
  }

  #resolvePeer(): SubAgentTransportPeer {
    const peer = typeof this.#peer === 'function' ? this.#peer() : this.#peer;
    if (peer === null || typeof peer !== 'object' || typeof peer.request !== 'function') {
      throw new TypeError('Subagent target bridge peer provider returned an invalid peer.');
    }
    return peer;
  }

  #nextControlOperation(
    taskId: string,
    method: SubAgentTransportControlMethod,
    identity?: string,
  ): string {
    return this.#nextOperation('control', taskId, `${method}:${identity ?? ''}`);
  }

  #nextOperation(
    kind: SubAgentTransportOperationIdContext['kind'],
    taskId: string,
    identity?: string,
  ): string {
    const operationId = this.#createOperationId({
      kind,
      taskId,
      sequence: this.#nextOperationSequence++,
      ...(identity === undefined ? {} : { identity }),
    });
    assertIdentifier(operationId, 'transport operationId');
    return operationId;
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Subagent target bridge clock must return a non-negative safe integer.');
    }
    return value;
  }
}

export function createSubAgentTransportTargetBridge(
  options: CreateSubAgentTransportTargetBridgeOptions,
): SubAgentTransportTargetBridge {
  return new SubAgentTransportTargetBridge(options);
}

async function closeExchange(exchange: SubAgentTransportPeerExchange): Promise<void> {
  await exchange.return?.().catch(() => undefined);
}

async function requestOne(
  peer: SubAgentTransportPeer,
  request: Parameters<SubAgentTransportPeer['request']>[0],
): Promise<SubAgentTransportPeerResponse> {
  const exchange = peer.request(request);
  try {
    const response = await requireNext(exchange);
    await requireDone(exchange);
    return response;
  } catch (error) {
    await closeExchange(exchange);
    throw error;
  }
}

async function requireNext(
  exchange: SubAgentTransportPeerExchange,
): Promise<SubAgentTransportPeerResponse> {
  const step = await exchange.next();
  if (step.done) throw bridgeInternalError('The remote transport exchange ended without a reply.');
  return step.value;
}

async function requireDone(exchange: SubAgentTransportPeerExchange): Promise<void> {
  const step = await exchange.next();
  if (!step.done) {
    await closeExchange(exchange);
    throw bridgeInternalError('The remote transport exchange returned an unexpected extra reply.');
  }
}

function readExecutorSettlement(
  response: SubAgentTransportPeerResponse,
  mode: 'execute' | 'spawn' | 'wait',
): SubAgentExecutorOperationResult {
  if (response.envelope.kind === 'protocol.error') {
    throw new SubAgentRuntimeError(response.envelope.payload.error);
  }
  if (response.envelope.kind !== 'executor.settled' || response.envelope.payload.mode !== mode) {
    throw bridgeInternalError('The remote execution returned an invalid settlement.');
  }
  return response.envelope.payload.outcome;
}

async function readEventPage(
  source: AsyncIterable<SubAgentTaskEvent>,
  taskId: string,
  afterSequence: number,
  limit: number,
  ownerSessionId?: string,
): Promise<SubAgentTransportRpcPayloadMap['events.page']> {
  const iterator = source[Symbol.asyncIterator]();
  const events: SubAgentTaskEvent[] = [];
  let done = false;
  try {
    while (events.length < limit) {
      const step = await iterator.next();
      if (step.done) {
        done = true;
        break;
      }
      if (
        step.value.taskId !== taskId ||
        step.value.sequence <= afterSequence ||
        (ownerSessionId !== undefined && step.value.sessionId !== ownerSessionId)
      ) {
        throw createResourceNotFoundError();
      }
      events.push(step.value);
    }
  } finally {
    await iterator.return?.();
  }
  const nextSequence = events.at(-1)?.sequence ?? afterSequence;
  return Object.freeze({ events: Object.freeze(events), nextSequence, done });
}

function controlErrorReply(
  method: SubAgentTransportControlMethod,
  error: SubAgentTransportSafeError,
): SubAgentTransportControlReply {
  return Object.freeze({ method, ok: false, error }) as SubAgentTransportControlReply;
}

function safeError(error: unknown): Readonly<SubAgentTransportSafeError> {
  if (error instanceof SubAgentRuntimeError) {
    return projectSubAgentTransportSafeError(error.descriptor);
  }
  return Object.freeze({
    code: 'INTERNAL_ERROR',
    message: 'The remote transport operation failed.',
    retryable: false,
    causeCode: 'REMOTE_BRIDGE_FAILED',
  });
}

function bridgeInternalError(message: string): SubAgentRuntimeError {
  return new SubAgentRuntimeError({ code: 'INTERNAL_ERROR', message, retryable: false });
}

function targetCapacityError(resource: string): Readonly<SubAgentTransportSafeError> {
  return Object.freeze({
    code: 'LIMIT_EXCEEDED',
    message: `The target transport ${resource} capacity has been exhausted.`,
    retryable: false,
    causeCode: 'TARGET_RECEIPT_CAPACITY_EXHAUSTED',
  });
}

function transportHandleScopeKey(scope: {
  readonly ownerSessionId: string;
  readonly taskId: string;
}): string {
  return `${scope.ownerSessionId}\0${scope.taskId}`;
}

function stateFromOutcome(outcome: SubAgentExecutionOutcome | undefined): SubAgentTaskState {
  if (outcome === undefined) return 'failed';
  return outcome.type === 'paused' ? 'waiting_approval' : outcome.result.status;
}

function bindingsEqual(left: SubAgentExecutorBinding, right: SubAgentExecutorBinding): boolean {
  return (
    canonicalizeJson(left as unknown as JsonValue) ===
    canonicalizeJson(right as unknown as JsonValue)
  );
}

function ownedBinding(binding: SubAgentExecutorBinding): SubAgentExecutorBinding {
  const expectedKeys = [
    'adapterStateVersion',
    'definitionName',
    'definitionVersion',
    'executorName',
    ...(binding.modelBinding === undefined ? [] : ['modelBinding']),
    'ownerSessionId',
    'recoveryData',
    'runnerId',
    'runnerVersion',
    'subagentSessionId',
    'taskId',
    'version',
  ];
  const actualKeys = Object.keys(binding).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new SubAgentRuntimeError({
      code: 'BINDING_INVALID',
      message: 'The target binding factory returned a non-closed binding.',
      retryable: false,
    });
  }
  try {
    assertJsonValue(binding, {
      maxBytes: DEFAULT_EXECUTOR_MAX_BINDING_BYTES,
      label: 'Target transport binding',
    });
    const cloned = parseJsonValue(canonicalizeJson(binding as unknown as JsonValue));
    deepFreezeJson(cloned);
    return cloned as unknown as SubAgentExecutorBinding;
  } catch (error) {
    if (error instanceof SubAgentRuntimeError) throw error;
    throw new SubAgentRuntimeError({
      code: 'BINDING_INVALID',
      message: 'The target binding factory returned an invalid binding.',
      retryable: false,
    });
  }
}

function modelBindingsEqual(
  left: SubAgentExecutorBinding['modelBinding'],
  right: SubAgentTargetModelBinding,
): boolean {
  return (
    left !== undefined &&
    left.gatewayId === right.gatewayId &&
    left.protocol === right.protocol &&
    left.codecVersion === right.codecVersion
  );
}

function targetOperationRequestIdentity(
  request: SubAgentTransportRpcPayloadMap['executor.request']['request'],
): Readonly<{ requestIdentity: string; remainingMs: number }> {
  const { remainingMs: requestRemainingMs, ...stableRequest } = request;
  return Object.freeze({
    requestIdentity: canonicalizeJson(stableRequest as unknown as JsonValue),
    remainingMs: requestRemainingMs,
  });
}

function assertForwardResume(
  previous: SubAgentExecutionRequest,
  current: SubAgentExecutionRequest,
): void {
  const previousStable = {
    ownerSessionId: previous.ownerSessionId,
    runId: previous.runId,
    taskId: previous.taskId,
    ...(previous.parentTaskId === undefined ? {} : { parentTaskId: previous.parentTaskId }),
    subagentSessionId: previous.subagentSessionId,
    path: previous.path,
    definition: previous.definition,
    input: previous.input,
    projectedContext: previous.projectedContext,
    delegation: previous.delegation,
    limits: previous.limits,
  } as unknown as JsonValue;
  const currentStable = {
    ownerSessionId: current.ownerSessionId,
    runId: current.runId,
    taskId: current.taskId,
    ...(current.parentTaskId === undefined ? {} : { parentTaskId: current.parentTaskId }),
    subagentSessionId: current.subagentSessionId,
    path: current.path,
    definition: current.definition,
    input: current.input,
    projectedContext: current.projectedContext,
    delegation: current.delegation,
    limits: current.limits,
  } as unknown as JsonValue;
  if (
    canonicalizeJson(previousStable) !== canonicalizeJson(currentStable) ||
    current.attempt <= previous.attempt ||
    current.executionEpoch === previous.executionEpoch ||
    parseExecutionFencingToken(current.executionFencingToken) <=
      parseExecutionFencingToken(previous.executionFencingToken) ||
    current.deadlineAt > previous.deadlineAt
  ) {
    throw new SubAgentRuntimeError({
      code: 'BINDING_INVALID',
      message: 'The resumed transport execution does not advance the resident task identity.',
      retryable: false,
    });
  }
}

function parseExecutionFencingToken(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new SubAgentRuntimeError({
      code: 'BINDING_INVALID',
      message: 'The transport execution fencing token is invalid.',
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

function remainingMs(deadlineAt: number, now: () => number): number {
  const current = now();
  if (!Number.isSafeInteger(deadlineAt) || !Number.isSafeInteger(current)) {
    throw new TypeError('Transport deadline and clock must be safe integers.');
  }
  const value = deadlineAt - current;
  if (value < 1) {
    throw new SubAgentRuntimeError({
      code: 'TIMED_OUT',
      message: 'The transport operation deadline has expired.',
      retryable: false,
    });
  }
  return value;
}

function deadlineExpired(deadlineAt: number, now: () => number): boolean {
  const current = now();
  if (!Number.isSafeInteger(deadlineAt) || !Number.isSafeInteger(current)) {
    throw new TypeError('Transport deadline and clock must be safe integers.');
  }
  return current >= deadlineAt;
}

function createBridgeAbortScope(
  parentSignal: AbortSignal,
  deadlineAt: number,
  now: () => number,
): Readonly<{ readonly signal: AbortSignal; readonly dispose: () => void }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const abortFromParent = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal.reason ?? createResourceNotFoundError());
    }
  };
  const armDeadline = (): void => {
    if (disposed || controller.signal.aborted) return;
    const current = now();
    if (!Number.isSafeInteger(deadlineAt) || !Number.isSafeInteger(current)) {
      controller.abort(
        new SubAgentRuntimeError({
          code: 'INTERNAL_ERROR',
          message: 'The transport deadline or clock is invalid.',
          retryable: false,
        }),
      );
      return;
    }
    const remaining = deadlineAt - current;
    if (remaining <= 0) {
      controller.abort(
        new SubAgentRuntimeError({
          code: 'TIMED_OUT',
          message: 'The transport operation deadline has expired.',
          retryable: false,
        }),
      );
      return;
    }
    timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  armDeadline();

  return Object.freeze({
    signal: controller.signal,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      parentSignal.removeEventListener('abort', abortFromParent);
    },
  });
}

function defaultOperationId(context: SubAgentTransportOperationIdContext): string {
  return `${context.kind}-${context.sequence}-${randomUUID()}`;
}

function resolvePeerProvider(provider: PeerProvider): SubAgentTransportPeer {
  const peer = typeof provider === 'function' ? provider() : provider;
  if (peer === null || typeof peer !== 'object' || typeof peer.request !== 'function') {
    throw new TypeError('Subagent transport peer provider returned an invalid peer.');
  }
  return peer;
}

function emptyTargetCatalog(request: SubAgentExecutionRequest): SubAgentTransportTargetCatalog {
  return Object.freeze({
    catalog: Object.freeze({
      revision: request.delegation.catalogRevision,
      capturedAt: 0,
      executors: Object.freeze([]),
    }),
    catalogEntries: Object.freeze([]),
  });
}

async function* emptyEvents(): AsyncIterable<SubAgentTaskEvent> {}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

function assertBridgeOptions(options: CreateSubAgentTransportExecutorBridgeOptions): void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Subagent transport Executor bridge options must be an object.');
  }
  if (
    options.descriptor === null ||
    typeof options.descriptor !== 'object' ||
    typeof options.bindingCodec?.decode !== 'function' ||
    typeof options.bindingCodec?.encode !== 'function' ||
    typeof options.getAvailability !== 'function' ||
    typeof options.supports !== 'function'
  ) {
    throw new TypeError('Subagent transport Executor bridge options are incomplete.');
  }
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string.`);
  }
}
