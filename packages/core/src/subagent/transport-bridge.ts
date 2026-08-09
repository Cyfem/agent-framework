import { randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import type { ApprovalDirective } from './approval';
import type {
  ExecutorAvailabilityProbe,
  ExecutorCatalogSnapshot,
  SubAgentCatalogEntry,
  SubAgentExecutorDescriptor,
} from './catalog';
import type { SubAgentChildCheckpoint } from './checkpoint';
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
import {
  hashSubAgentTransportModelRequest,
  type SubAgentTransportModelExchange,
} from './transport-model-gateway';
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
  decodeSubAgentExecutionRequestWire,
  reconstructSubAgentExecutionRequest,
} from './transport-codec';
import {
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
} from './transport';
import {
  SubAgentTransportPeerError,
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
  type PreparedSubAgentTargetRunner,
  type SubAgentTargetModelBinding,
  type SubAgentTargetRunnerIdentity,
} from './target-runner-registry';

type PeerProvider = SubAgentTransportPeer | (() => SubAgentTransportPeer);
type TargetPeerProvider = SubAgentTransportPeer | ((channelId: string) => SubAgentTransportPeer);
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

interface BoundControllerExecution {
  readonly request: SubAgentExecutionRequest;
  readonly release: () => void;
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
    const bound = this.#bindControl(this.#ownRequestBinding(request), control);
    try {
      const exchange = this.#openExecutorRequest(bound.request, 'execute');
      const response = await requireNext(exchange);
      const outcome = readExecutorSettlement(response, 'execute');
      this.#releaseTerminalNestedHandles(bound.request, outcome);
      await requireDone(exchange);
      return outcome;
    } finally {
      bound.release();
    }
  }

  async spawn(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<ExecutorTaskHandle | SubAgentExecutorRecoveryRequired> {
    const bound = this.#bindControl(this.#ownRequestBinding(request), control);
    let exchange: SubAgentTransportPeerExchange | undefined;
    try {
      exchange = this.#openExecutorRequest(bound.request, 'spawn');
      const first = await requireNext(exchange);
      if (first.envelope.kind === 'protocol.error') {
        await requireDone(exchange);
        throw new SubAgentRuntimeError(first.envelope.payload.error);
      }
      if (first.envelope.kind === 'executor.settled') {
        const outcome = readExecutorSettlement(first, 'spawn');
        await requireDone(exchange);
        bound.release();
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

      const binding = this.#assertBinding(first.envelope.payload.binding, bound.request);
      const scope = Object.freeze({
        ownerSessionId: bound.request.ownerSessionId,
        taskId: bound.request.taskId,
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
        .finally(bound.release);
      void background.catch(() => undefined);
      exchange = undefined;
      return facade;
    } catch (error) {
      bound.release();
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
    const owned = this.#assertBindingForExecutor(binding);
    const response = await requestOne(this.#resolvePeer(), {
      kind: 'cancel.request',
      taskId: owned.taskId,
      operationId: options.operationId,
      payload: {
        binding: owned,
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

  #bindControl(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): BoundControllerExecution {
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
    const scopedRequest = Object.freeze({
      ...request,
      signal: scope.signal,
      deadlineAt,
    });
    let released = false;
    const release = (): void => {
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
    return Object.freeze({ request: scopedRequest, release });
  }

  async #consumeSpawnSettlement(
    exchange: SubAgentTransportPeerExchange,
    scope: Readonly<{ readonly ownerSessionId: string; readonly taskId: string }>,
  ): Promise<void> {
    const response = await requireNext(exchange);
    const outcome = readExecutorSettlement(response, 'spawn');
    if (outcome.type === 'terminal') {
      this.#handles.markTerminal(scope);
      this.#nestedTaskHandles.forgetParentScope(scope.ownerSessionId, scope.taskId);
    }
    await requireDone(exchange);
  }

  #releaseTerminalNestedHandles(
    request: Pick<SubAgentExecutionRequest, 'ownerSessionId' | 'taskId'>,
    outcome: SubAgentExecutorOperationResult,
  ): void {
    if (outcome.type !== 'terminal') return;
    this.#nestedTaskHandles.forgetParentScope(request.ownerSessionId, request.taskId);
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

  #assertBinding(candidate: unknown, request: SubAgentExecutionRequest): SubAgentExecutorBinding {
    const binding = this.#assertBindingForExecutor(candidate);
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
    return binding;
  }

  #ownRequestBinding(request: SubAgentExecutionRequest): SubAgentExecutionRequest {
    const operation = readExecutionOperation(request);
    const operationType = readExecutionOperationType(operation);
    if (
      operationType === 'create' ||
      (operationType !== 'resume' && operationType !== 'reconnect')
    ) {
      return request;
    }

    const binding = this.#assertBinding(readExecutionOperationBinding(operation), request);
    return Object.freeze({
      ...request,
      operation: Object.freeze({ ...operation, binding }),
    });
  }

  #assertBindingForExecutor(candidate: unknown): SubAgentExecutorBinding {
    const binding = ownedBinding(candidate, this.descriptor.maxBindingBytes);
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
    return binding;
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

/** Trusted placement-local binding check run before any target runner factory is invoked. */
export interface SubAgentTransportTargetBindingValidationContext {
  readonly request: SubAgentExecutionRequest;
  readonly binding: SubAgentExecutorBinding;
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

export interface SubAgentTransportTargetCheckpointCommitContext {
  readonly operationId: string;
  readonly ownerSessionId: string;
  readonly taskId: string;
  readonly executionAttempt: number;
  readonly executionEpoch: string;
  readonly executionFencingToken: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly binding: SubAgentExecutorBinding;
  readonly checkpoint: SubAgentChildCheckpoint;
}

export interface CreateSubAgentTransportTargetBridgeOptions {
  /** Trusted owner authenticated by the placement channel; never inferred from an RPC payload. */
  readonly ownerSessionId: string;
  readonly executorName: string;
  readonly registry: SubAgentTargetRunnerRegistry;
  readonly bindingCodec: SubAgentExecutorBindingCodec;
  /** Resolve the exact authenticated placement channel named by the trusted handler request. */
  readonly peer: TargetPeerProvider;
  readonly createBinding: (
    context: SubAgentTransportTargetBindingContext,
  ) => SubAgentExecutorBinding | Promise<SubAgentExecutorBinding>;
  /**
   * Optional adapter-specific check for opaque recovery data such as a Worker logical job ID.
   * It runs for create, resume and reconnect before a runner factory or resident runner is used.
   */
  readonly validateBinding?: (
    context: SubAgentTransportTargetBindingValidationContext,
  ) => void | Promise<void>;
  readonly resolveCatalog?: (request: SubAgentExecutionRequest) => SubAgentTransportTargetCatalog;
  readonly events?: (
    context: SubAgentTransportTargetEventsContext,
  ) => AsyncIterable<SubAgentTaskEvent>;
  /**
   * Explicitly enables fresh-runner recovery for a live external job. The bridge still rejects a
   * reconnect unless the old runner has a controller-acknowledged compatible checkpoint.
   */
  readonly reconnect?: 'external_binding';
  /**
   * Durable, idempotent and fencing-aware placement hook invoked only after the authoritative
   * controller ACKs a checkpoint. Required when `reconnect` is `external_binding`. The hook must
   * use owner/task + execution scope + operationId as a CAS identity and reject a late write after
   * its signal/deadline is revoked; Core can quarantine, but cannot cancel, an arbitrary Promise.
   */
  readonly checkpointCommitted?: (
    context: SubAgentTransportTargetCheckpointCommitContext,
  ) => void | Promise<void>;
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

type TargetTaskPhase = 'active' | 'quiescing' | 'detached' | 'settled' | 'cancelled';

interface TargetProviderOutcomeUnknown {
  readonly requestHash: string;
  /** A correlated Model reply is authoritative; transport-only uncertainty may be queried again. */
  readonly terminal: boolean;
}

interface TargetTaskRecord {
  readonly ownerSessionId: string;
  channelId: string;
  readonly binding: SubAgentExecutorBinding;
  readonly modelBinding: SubAgentTargetModelBinding;
  readonly runnerIdentity: SubAgentTargetRunnerIdentity;
  readonly runner: SubAgentChildRunner;
  readonly controller: AbortController;
  readonly accessController: AbortController;
  readonly generation: number;
  attachmentRevision: number;
  request: SubAgentExecutionRequest;
  runStarted: Promise<void>;
  promise: Promise<SubAgentExecutionOutcome>;
  checkpointExchangeTail: Promise<void>;
  checkpointGap: boolean;
  /** providerOperationId -> canonical identity for an admitted request without a known result. */
  readonly providerOutcomeUnknown: Map<string, TargetProviderOutcomeUnknown>;
  readonly providerActiveOperations: Set<string>;
  providerOutcomeTerminal: boolean;
  checkpoint?: SubAgentChildCheckpoint;
  outcome?: SubAgentExecutionOutcome;
  cancelRequested: boolean;
  hardFenced: boolean;
  activeControlExchanges: number;
  controlDrain: Promise<void>;
  resolveControlDrain?: () => void;
  phase: TargetTaskPhase;
  runnerRunning: boolean;
  updatedAt: number;
}

interface TargetOperationRecord {
  /** `remainingMs` is transport-relative, so it is not part of the stable request identity. */
  readonly requestIdentity: string;
  /** The first accepted budget is a ceiling: retries may age, but cannot extend the deadline. */
  readonly initialRemainingMs: number;
  readonly mode: 'execute' | 'spawn';
  readonly channelId: string;
  readonly started: Promise<TargetTaskRecord>;
}

interface PendingTargetReconnect {
  readonly resident: TargetTaskRecord;
  readonly controller: AbortController;
  readonly channelId: string;
}

/** Target-side request handler shared by Worker, Process and HTTP placement packages. */
export class SubAgentTransportTargetBridge {
  readonly handler: SubAgentTransportPeerRequestHandler;
  readonly modelExchange: SubAgentTransportModelExchange;

  readonly #ownerSessionId: string;
  readonly #executorName: string;
  readonly #registry: SubAgentTargetRunnerRegistry;
  readonly #bindingCodec: SubAgentExecutorBindingCodec;
  readonly #peer: TargetPeerProvider;
  readonly #createBinding: CreateSubAgentTransportTargetBridgeOptions['createBinding'];
  readonly #validateBinding: NonNullable<
    CreateSubAgentTransportTargetBridgeOptions['validateBinding']
  >;
  readonly #resolveCatalog: NonNullable<
    CreateSubAgentTransportTargetBridgeOptions['resolveCatalog']
  >;
  readonly #events: CreateSubAgentTransportTargetBridgeOptions['events'];
  readonly #reconnect: CreateSubAgentTransportTargetBridgeOptions['reconnect'] | 'none';
  readonly #checkpointCommitted: NonNullable<
    CreateSubAgentTransportTargetBridgeOptions['checkpointCommitted']
  >;
  readonly #now: () => number;
  readonly #lifecycle = new AbortController();
  readonly #signal: AbortSignal;
  readonly #maxEventPageSize: number;
  readonly #maxRetainedTasks: number;
  readonly #maxRetainedOperations: number;
  readonly #createOperationId: SubAgentTransportOperationIdFactory;
  readonly #tasks = new Map<string, TargetTaskRecord>();
  readonly #startingTasks = new Set<string>();
  readonly #pendingReconnects = new Map<string, PendingTargetReconnect>();
  readonly #operations = new Map<string, TargetOperationRecord>();
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #nextOperationSequence = 1;
  #nextTaskGeneration = 1;

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
    if (options.validateBinding !== undefined && typeof options.validateBinding !== 'function') {
      throw new TypeError('A target transport binding validator must be a function.');
    }
    if (options.reconnect !== undefined && options.reconnect !== 'external_binding') {
      throw new TypeError('A target transport reconnect mode is invalid.');
    }
    if (
      options.checkpointCommitted !== undefined &&
      typeof options.checkpointCommitted !== 'function'
    ) {
      throw new TypeError('A target checkpoint commit hook must be a function.');
    }
    if (options.checkpointCommitted !== undefined && options.reconnect !== 'external_binding') {
      throw new TypeError(
        'A target checkpoint commit hook requires external-binding reconnect support.',
      );
    }
    if (options.reconnect === 'external_binding' && options.checkpointCommitted === undefined) {
      throw new TypeError(
        'External-binding reconnect requires a durable target checkpoint commit hook.',
      );
    }
    if (options.reconnect === 'external_binding' && typeof options.peer !== 'function') {
      throw new TypeError(
        'External-binding reconnect requires an authenticated channel-aware peer provider.',
      );
    }
    this.#ownerSessionId = options.ownerSessionId;
    this.#executorName = options.executorName;
    this.#registry = options.registry;
    this.#bindingCodec = options.bindingCodec;
    this.#peer = options.peer;
    this.#createBinding = options.createBinding;
    this.#validateBinding = options.validateBinding ?? (() => undefined);
    this.#resolveCatalog = options.resolveCatalog ?? emptyTargetCatalog;
    this.#events = options.events;
    this.#reconnect = options.reconnect ?? 'none';
    this.#checkpointCommitted = options.checkpointCommitted ?? (() => undefined);
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
    this.modelExchange = async (request) => {
      const task = this.#requireTask(request.taskId);
      const generation = task.generation;
      const attachmentRevision = task.attachmentRevision;
      const channelId = task.channelId;
      const scope = Object.freeze({
        executionAttempt: request.payload.executionAttempt,
        executionEpoch: request.payload.executionEpoch,
        executionFencingToken: request.payload.executionFencingToken,
      });
      this.#assertTaskExecutionScope(task, scope);
      if (task.providerOutcomeTerminal) throw providerOutcomeUnknownError();
      this.#assertActiveTaskScope(task, scope);
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
      const runnerSignal = AbortSignal.any([task.request.signal, task.controller.signal]);
      const signal =
        request.signal === undefined
          ? runnerSignal
          : AbortSignal.any([runnerSignal, request.signal]);
      const exchangeStartedAt = this.#readNow();
      const taskRemainingMs = remainingMs(task.request.deadlineAt, () => exchangeStartedAt);
      if (
        request.timeoutMs !== undefined &&
        (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
      ) {
        throw new TypeError('Target Model exchange timeoutMs must be a positive safe integer.');
      }
      const exchangeDeadlineAt =
        request.timeoutMs === undefined || request.timeoutMs >= taskRemainingMs
          ? task.request.deadlineAt
          : exchangeStartedAt + request.timeoutMs;
      const providerOperationId = request.payload.providerOperationId;
      if (request.operationId !== providerOperationId) {
        throw new SubAgentRuntimeError({
          code: 'BINDING_INVALID',
          message: 'The target Model operation identity is invalid.',
          retryable: false,
        });
      }
      const providerRequestHash = hashSubAgentTransportModelRequest({
        gatewayId: request.payload.gatewayId,
        protocol: request.payload.protocol,
        codecVersion: request.payload.codecVersion,
        runId: request.payload.runId,
        checkpointOperationId: request.payload.checkpointOperationId,
        checkpointDigest: request.payload.checkpointDigest,
        purpose: request.payload.purpose,
        iteration: request.payload.iteration,
        requestAttempt: request.payload.requestAttempt,
        context: request.payload.context,
        tools: request.payload.tools,
      });
      if (providerRequestHash !== request.payload.requestHash) {
        throw new SubAgentRuntimeError({
          code: 'BINDING_INVALID',
          message: 'The target Model request hash is invalid.',
          retryable: false,
        });
      }
      const unresolved = task.providerOutcomeUnknown.get(providerOperationId);
      if (
        task.providerOutcomeTerminal ||
        (task.providerOutcomeUnknown.size > 0 &&
          (unresolved?.requestHash !== providerRequestHash || unresolved.terminal))
      ) {
        throw new SubAgentRuntimeError({
          code: 'EXECUTOR_FAILED',
          message: 'A previous provider model request has an unknown outcome.',
          retryable: false,
          causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        });
      }
      if (task.providerActiveOperations.has(providerOperationId)) {
        throw new SubAgentRuntimeError({
          code: 'INVALID_STATE_TRANSITION',
          message: 'The provider model operation is already active.',
          retryable: false,
        });
      }
      const release = this.#admitReverseActivity(task, scope, channelId);
      task.providerActiveOperations.add(providerOperationId);
      let admitted = false;
      let definitiveReply = false;
      try {
        const reply = await this.#performTargetModelExchange(
          request,
          signal,
          exchangeDeadlineAt,
          channelId,
          () => {
            admitted = true;
            if (!task.providerOutcomeUnknown.has(providerOperationId)) {
              task.providerOutcomeUnknown.set(
                providerOperationId,
                Object.freeze({ requestHash: providerRequestHash, terminal: false }),
              );
            }
          },
        );
        definitiveReply = true;
        this.#assertTaskAttachmentScope(task, generation, attachmentRevision, channelId, scope);
        let continuationFailure: Readonly<{ error: unknown }> | undefined;
        try {
          this.#assertActiveTaskContinuation(
            task,
            generation,
            attachmentRevision,
            channelId,
            scope,
          );
        } catch (error) {
          continuationFailure = Object.freeze({ error });
        }
        if (!reply.ok && reply.error.outcomeUnknown === true) {
          task.providerOutcomeUnknown.set(
            providerOperationId,
            Object.freeze({ requestHash: providerRequestHash, terminal: true }),
          );
          this.#markProviderOutcomeTerminal(task);
        } else {
          const currentUnknown = task.providerOutcomeUnknown.get(providerOperationId);
          if (currentUnknown?.requestHash === providerRequestHash) {
            if (currentUnknown.terminal) throw providerOutcomeUnknownError();
            task.providerOutcomeUnknown.delete(providerOperationId);
          }
        }
        if (continuationFailure !== undefined) throw continuationFailure.error;
        return reply;
      } catch (error) {
        const transportOutcomeUnknown =
          !definitiveReply && (admitted || isOutcomeUnknownFailure(error));
        if (transportOutcomeUnknown && !task.providerOutcomeUnknown.has(providerOperationId)) {
          task.providerOutcomeUnknown.set(
            providerOperationId,
            Object.freeze({ requestHash: providerRequestHash, terminal: false }),
          );
        }
        if (transportOutcomeUnknown && !isOutcomeUnknownFailure(error)) {
          throw providerOutcomeUnknownError();
        }
        throw error;
      } finally {
        task.providerActiveOperations.delete(providerOperationId);
        release();
      }
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
      running: [...this.#tasks.values()].filter(({ runnerRunning }) => runnerRunning).length,
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
      ...[...this.#tasks.values()].map(({ checkpointExchangeTail }) => checkpointExchangeTail),
      ...[...this.#operations.values()].map(({ started }) =>
        started.then(({ promise }) => promise),
      ),
    ];
    if (!this.#lifecycle.signal.aborted) this.#lifecycle.abort(reason);
    for (const task of this.#tasks.values()) {
      task.cancelRequested = true;
      task.phase = 'cancelled';
      if (!task.accessController.signal.aborted) task.accessController.abort(reason);
      if (task.runnerRunning && !task.controller.signal.aborted) task.controller.abort(reason);
    }
    this.#disposePromise = Promise.allSettled(settlements).then(() => {
      this.#tasks.clear();
      this.#startingTasks.clear();
      this.#pendingReconnects.clear();
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
    let wire: SubAgentTransportRpcPayloadMap['executor.request']['request'];
    try {
      wire = decodeSubAgentExecutionRequestWire(envelope.payload.request, {
        expectedExecutorName: this.#executorName,
        maxBindingBytes: DEFAULT_EXECUTOR_MAX_BINDING_BYTES,
      });
    } catch {
      await request.reply({
        kind: 'protocol.error',
        payload: { error: safeError(bindingInvalidError()) },
      });
      return;
    }
    if (!this.#ownsExecutionWire(envelope.taskId, wire)) {
      await request.reply({
        kind: 'protocol.error',
        payload: { error: SAFE_RESOURCE_NOT_FOUND_ERROR },
      });
      return;
    }
    const mode = envelope.payload.mode;
    const candidate = targetOperationRequestIdentity(wire);
    const key = `${this.#ownerSessionId}\0${envelope.taskId}\0${envelope.operationId}`;
    const existing = this.#operations.get(key);
    if (existing !== undefined && existing.channelId !== request.channelId) {
      await request.reply({
        kind: 'protocol.error',
        payload: { error: SAFE_RESOURCE_NOT_FOUND_ERROR },
      });
      return;
    }
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
      const started = this.#start(wire, request.channelId);
      void started.catch(() => undefined);
      operation = Object.freeze({
        requestIdentity: candidate.requestIdentity,
        initialRemainingMs: candidate.remainingMs,
        mode,
        channelId: request.channelId,
        started,
      });
      this.#operations.set(key, operation);
    }

    try {
      const task = await operation.started;
      const generation = task.generation;
      const attachmentRevision = task.attachmentRevision;
      this.#assertInboundTask(task, generation, attachmentRevision, request.channelId);
      if (mode === 'spawn') {
        await request.reply({
          kind: 'executor.accepted',
          payload: { mode: 'spawn', binding: task.binding },
        });
      }
      const outcome = await task.promise;
      this.#assertInboundTask(task, generation, attachmentRevision, request.channelId);
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
    channelId: string,
  ): Promise<TargetTaskRecord> {
    let claimedTaskKey: string | undefined;
    const receiver = new AbortController();
    const forwardAbort = (): void => receiver.abort(this.#signal.reason);
    const reconstruction = reconstructSubAgentExecutionRequest(wire, {
      signal: receiver.signal,
      now: this.#now,
      expectedExecutorName: this.#executorName,
    });
    if (this.#signal.aborted) forwardAbort();
    else this.#signal.addEventListener('abort', forwardAbort, { once: true });
    const request = reconstruction.request;
    try {
      if (request.ownerSessionId !== this.#ownerSessionId) {
        throw createResourceNotFoundError();
      }
      if (request.operation.type === 'reconnect') {
        const reconnectBinding = request.operation.binding;
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
        if (resident === undefined || resident.phase === 'cancelled') {
          throw createResourceNotFoundError();
        }
        this.#assertTaskBinding(resident, reconnectBinding);
        assertForwardResume(resident.request, request);
        if (resident.cancelRequested && resident.phase !== 'settled') {
          throw createResourceNotFoundError();
        }
        await runWithSignal(
          () => this.#validateBinding(Object.freeze({ request, binding: reconnectBinding })),
          request.signal,
        );
        remainingMs(request.deadlineAt, this.#now);
        if (this.#disposed || this.#tasks.get(taskKey) !== resident) {
          throw createResourceNotFoundError();
        }
        if (resident.cancelRequested && resident.phase !== 'settled') {
          throw createResourceNotFoundError();
        }
        if (resident.phase === 'settled') {
          this.#assertProviderRecoverySafe(resident);
          if (request.signal.aborted) throw abortReason(request.signal);
          remainingMs(request.deadlineAt, this.#now);
          if (this.#disposed || this.#tasks.get(taskKey) !== resident) {
            throw createResourceNotFoundError();
          }
          const updatedAt = this.#readNow();
          remainingMs(request.deadlineAt, () => updatedAt);
          resident.channelId = channelId;
          resident.request = request;
          resident.attachmentRevision += 1;
          resident.updatedAt = updatedAt;
          this.#startingTasks.delete(taskKey);
          claimedTaskKey = undefined;
          reconstruction.dispose();
          this.#signal.removeEventListener('abort', forwardAbort);
          return resident;
        }
        if (this.#reconnect !== 'external_binding') {
          throw new SubAgentRuntimeError({
            code: 'RECOVERY_UNSUPPORTED',
            message:
              'A live target runner cannot be rebound to a new execution epoch by the generic transport bridge.',
            retryable: false,
          });
        }
        if (resident.channelId === channelId) {
          throw new SubAgentRuntimeError({
            code: 'RECOVERY_UNSUPPORTED',
            message: 'A live external reconnect requires a fresh authenticated channel.',
            retryable: false,
          });
        }
        this.#resolvePeerForChannel(channelId);
        const checkpointMayAdvance =
          resident.phase === 'active' && resident.activeControlExchanges > 0;
        if (!checkpointMayAdvance) this.#assertProviderRecoverySafe(resident);
        if (resident.checkpointGap && !checkpointMayAdvance) {
          throw new SubAgentRuntimeError({
            code: 'RECOVERY_UNSUPPORTED',
            message: 'The external target job has an unresolved acknowledged-checkpoint gap.',
            retryable: false,
          });
        }
        const initialCheckpoint = resident.checkpoint;
        if (initialCheckpoint === undefined && !checkpointMayAdvance) {
          throw new SubAgentRuntimeError({
            code: 'RECOVERY_UNSUPPORTED',
            message: 'The external target job has no controller-acknowledged child checkpoint.',
            retryable: false,
          });
        }
        let prepared =
          initialCheckpoint === undefined
            ? undefined
            : this.#registry.prepareExternalReconnect(
                request,
                initialCheckpoint,
                this.#executorName,
              );
        if (prepared !== undefined && prepared.modelBinding === undefined) {
          throw new SubAgentRuntimeError({
            code: 'BINDING_INVALID',
            message: 'The target runner has no registered Model gateway binding.',
            retryable: false,
          });
        }
        const catalog = this.#resolveCatalog(request);
        const control = this.#createRemoteControl(request, catalog, channelId);
        if (request.signal.aborted) throw abortReason(request.signal);
        remainingMs(request.deadlineAt, this.#now);
        this.#pendingReconnects.set(
          taskKey,
          Object.freeze({ resident, controller: receiver, channelId }),
        );
        const superseded = new SubAgentRuntimeError({
          code: 'CANCELLED',
          message: 'The previous external target attachment was superseded.',
          retryable: false,
        });
        try {
          if (resident.phase === 'active') {
            resident.phase = 'quiescing';
            await waitForTaskQuiescence(resident.controlDrain, request.signal);
            if (request.signal.aborted) throw abortReason(request.signal);
            remainingMs(request.deadlineAt, this.#now);
            if (this.#disposed || this.#tasks.get(taskKey) !== resident) {
              throw createResourceNotFoundError();
            }
            if (targetTaskHasPhase(resident, 'settled')) {
              throw new SubAgentRuntimeError({
                code: 'RECOVERY_UNSUPPORTED',
                message: 'The external target runner settled while reconnect was quiescing.',
                retryable: false,
              });
            }
            if (resident.checkpointGap) {
              throw new SubAgentRuntimeError({
                code: 'RECOVERY_UNSUPPORTED',
                message: 'The external target job has an unresolved acknowledged-checkpoint gap.',
                retryable: false,
              });
            }
            this.#assertProviderRecoverySafe(resident);
            const drainedCheckpoint = resident.checkpoint;
            if (drainedCheckpoint === undefined) {
              throw new SubAgentRuntimeError({
                code: 'RECOVERY_UNSUPPORTED',
                message: 'The external target job lost its recoverable child checkpoint.',
                retryable: false,
              });
            }
            if (prepared === undefined || drainedCheckpoint !== initialCheckpoint) {
              prepared = this.#registry.prepareExternalReconnect(
                request,
                drainedCheckpoint,
                this.#executorName,
              );
            }
            remainingMs(request.deadlineAt, this.#now);
            this.#resolvePeerForChannel(channelId);
            if (request.signal.aborted) throw abortReason(request.signal);
            remainingMs(request.deadlineAt, this.#now);
            resident.channelId = channelId;
            resident.request = request;
            resident.attachmentRevision += 1;
            delete resident.outcome;
            resident.hardFenced = true;
            if (!resident.accessController.signal.aborted) {
              resident.accessController.abort(superseded);
            }
            if (!resident.controller.signal.aborted) resident.controller.abort(superseded);
          } else if (resident.phase === 'quiescing' || resident.phase === 'detached') {
            resident.channelId = channelId;
            resident.request = request;
            resident.attachmentRevision += 1;
          } else {
            throw createResourceNotFoundError();
          }
          if (resident.phase === 'quiescing') {
            await waitForTaskQuiescence(resident.promise, request.signal);
            if (request.signal.aborted) throw abortReason(request.signal);
            remainingMs(request.deadlineAt, this.#now);
            if (
              this.#disposed ||
              this.#tasks.get(taskKey) !== resident ||
              resident.cancelRequested ||
              targetTaskHasPhase(resident, 'cancelled')
            ) {
              throw createResourceNotFoundError();
            }
            resident.phase = 'detached';
            resident.runnerRunning = false;
            delete resident.outcome;
            resident.updatedAt = this.#readNow();
          }
        } catch (error) {
          if (
            resident.phase === 'quiescing' &&
            !resident.controller.signal.aborted &&
            resident.runnerRunning
          ) {
            resident.phase = 'active';
          }
          throw error;
        }
        if (request.signal.aborted) throw abortReason(request.signal);
        remainingMs(request.deadlineAt, this.#now);
        if (this.#disposed || this.#tasks.get(taskKey) !== resident) {
          throw createResourceNotFoundError();
        }
        if (resident.checkpointGap) {
          throw new SubAgentRuntimeError({
            code: 'RECOVERY_UNSUPPORTED',
            message: 'The external target job has an undurable acknowledged checkpoint.',
            retryable: false,
          });
        }
        this.#assertProviderRecoverySafe(resident);
        const checkpoint = resident.checkpoint;
        if (checkpoint === undefined) {
          throw new SubAgentRuntimeError({
            code: 'RECOVERY_UNSUPPORTED',
            message: 'The external target job lost its recoverable child checkpoint.',
            retryable: false,
          });
        }
        if (prepared === undefined || checkpoint !== initialCheckpoint) {
          prepared = this.#registry.prepareExternalReconnect(
            request,
            checkpoint,
            this.#executorName,
          );
        }
        const modelBinding = prepared.modelBinding;
        if (modelBinding === undefined) {
          throw new SubAgentRuntimeError({
            code: 'BINDING_INVALID',
            message: 'The target runner has no registered Model gateway binding.',
            retryable: false,
          });
        }
        const runner = await runWithSignal(() => {
          remainingMs(request.deadlineAt, this.#now);
          this.#resolvePeerForChannel(channelId);
          if (request.signal.aborted) throw abortReason(request.signal);
          remainingMs(request.deadlineAt, this.#now);
          return prepared.create();
        }, request.signal);
        if (request.signal.aborted) throw abortReason(request.signal);
        remainingMs(request.deadlineAt, this.#now);
        this.#resolvePeerForChannel(channelId);
        if (request.signal.aborted) throw abortReason(request.signal);
        remainingMs(request.deadlineAt, this.#now);
        if (
          this.#disposed ||
          this.#tasks.get(taskKey) !== resident ||
          resident.phase !== 'detached'
        ) {
          throw createResourceNotFoundError();
        }
        const updatedAt = this.#readNow();
        remainingMs(request.deadlineAt, () => updatedAt);
        const task = this.#launchTargetTask({
          request,
          channelId,
          prepared,
          runner,
          binding: resident.binding,
          modelBinding,
          control,
          controller: receiver,
          checkpoint,
          updatedAt,
          beforeRun: () => this.#resolvePeerForChannel(channelId),
          restoreOnPreRunFailure: resident,
          releaseRequest: () => {
            reconstruction.dispose();
            this.#signal.removeEventListener('abort', forwardAbort);
          },
        });
        this.#tasks.set(taskKey, task);
        this.#pendingReconnects.delete(taskKey);
        await task.runStarted;
        this.#startingTasks.delete(taskKey);
        claimedTaskKey = undefined;
        return task;
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
      if (
        resident !== undefined &&
        (resident.phase === 'active' ||
          resident.phase === 'quiescing' ||
          resident.phase === 'detached')
      ) {
        throw new SubAgentRuntimeError({
          code: 'INVALID_STATE_TRANSITION',
          message: 'The target task is already running.',
          retryable: false,
        });
      }
      if (request.operation.type === 'resume' && resident !== undefined) {
        if (resident.phase === 'cancelled') throw createResourceNotFoundError();
        this.#assertTaskBinding(resident, request.operation.binding);
        assertForwardResume(resident.request, request);
        this.#assertProviderRecoverySafe(resident);
        if (
          resident.outcome?.type === 'terminal' ||
          (resident.outcome?.type === 'paused' && request.operation.reason !== 'approval') ||
          (resident.outcome === undefined && request.operation.reason !== 'checkpoint')
        ) {
          throw new SubAgentRuntimeError({
            code: 'INVALID_STATE_TRANSITION',
            message: 'The target task state does not permit this resume operation.',
            retryable: false,
          });
        }
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
      const catalog = this.#resolveCatalog(request);
      let initialBindingCommitOpen = request.operation.type === 'create';
      const control = this.#createRemoteControl(
        request,
        catalog,
        channelId,
        () => initialBindingCommitOpen,
      );
      const bindingCandidate =
        request.operation.type === 'create'
          ? await this.#createBinding({ request, runner: prepared.runner, modelBinding })
          : request.operation.binding;
      if (this.#disposed) throw createResourceNotFoundError();
      const binding = ownedBinding(bindingCandidate);
      this.#assertCreatedBinding(binding, request, prepared.runner, modelBinding);
      await this.#validateBinding(Object.freeze({ request, binding }));
      if (this.#disposed || isCancelledTargetTask(resident)) throw createResourceNotFoundError();
      const runner =
        request.operation.type === 'resume' &&
        request.operation.reason === 'approval' &&
        resident !== undefined
          ? resident.runner
          : await prepared.create();
      if (this.#disposed || isCancelledTargetTask(resident)) throw createResourceNotFoundError();
      if (request.operation.type === 'create') {
        try {
          await control.commitBinding(request.operation.operationId, binding);
        } finally {
          initialBindingCommitOpen = false;
        }
      }
      if (this.#disposed) throw createResourceNotFoundError();

      const task = this.#launchTargetTask({
        request,
        channelId,
        prepared,
        runner,
        binding,
        modelBinding,
        control,
        controller: receiver,
        ...(request.operation.type === 'resume'
          ? { checkpoint: request.operation.checkpoint }
          : {}),
        releaseRequest: () => {
          reconstruction.dispose();
          this.#signal.removeEventListener('abort', forwardAbort);
        },
      });
      this.#tasks.set(taskKey, task);
      this.#startingTasks.delete(taskKey);
      claimedTaskKey = undefined;
      return task;
    } catch (error) {
      if (claimedTaskKey !== undefined) {
        this.#startingTasks.delete(claimedTaskKey);
        const pending = this.#pendingReconnects.get(claimedTaskKey);
        if (pending?.controller === receiver) this.#pendingReconnects.delete(claimedTaskKey);
      }
      if (!receiver.signal.aborted) {
        receiver.abort(error instanceof Error ? error : createResourceNotFoundError());
      }
      reconstruction.dispose();
      this.#signal.removeEventListener('abort', forwardAbort);
      throw error;
    }
  }

  async #handleCancel(request: SubAgentTransportPeerHandlerRequest): Promise<void> {
    const envelope = request.envelope;
    if (envelope.kind !== 'cancel.request') return;
    try {
      const binding = ownedBinding(envelope.payload.binding);
      if (binding.ownerSessionId !== this.#ownerSessionId) {
        throw createResourceNotFoundError();
      }
      const taskKey = this.#taskKey(envelope.taskId);
      const pending = this.#pendingReconnects.get(taskKey);
      if (pending !== undefined) {
        if (pending.channelId !== request.channelId) throw createResourceNotFoundError();
        this.#assertTaskBinding(pending.resident, binding);
        const cancellation = new SubAgentRuntimeError({
          code: 'CANCELLED',
          message: envelope.payload.reason?.trim()
            ? 'The remote child was cancelled by its host.'
            : 'The remote child was cancelled.',
          retryable: false,
        });
        if (pending.resident.phase === 'settled') {
          if (!pending.controller.signal.aborted) pending.controller.abort(cancellation);
          await request.reply({ kind: 'cancel.ack', payload: { cancelled: true } });
          return;
        }
        pending.resident.cancelRequested = true;
        pending.resident.channelId = pending.channelId;
        pending.resident.phase = 'cancelled';
        pending.resident.attachmentRevision += 1;
        if (!pending.resident.accessController.signal.aborted) {
          pending.resident.accessController.abort(cancellation);
        }
        if (!pending.controller.signal.aborted) pending.controller.abort(cancellation);
        if (!pending.resident.controller.signal.aborted) {
          pending.resident.controller.abort(cancellation);
        }
        await request.reply({ kind: 'cancel.ack', payload: { cancelled: true } });
        return;
      }
      const task = this.#tasks.get(taskKey);
      if (task === undefined || task.channelId !== request.channelId) {
        throw createResourceNotFoundError();
      }
      this.#assertTaskBinding(task, binding);
      if (task.phase !== 'settled' && task.phase !== 'cancelled') {
        const cancellation = new SubAgentRuntimeError({
          code: 'CANCELLED',
          message: envelope.payload.reason?.trim()
            ? 'The remote child was cancelled by its host.'
            : 'The remote child was cancelled.',
          retryable: false,
        });
        task.cancelRequested = true;
        if (task.phase !== 'active') {
          task.phase = 'cancelled';
          task.attachmentRevision += 1;
        }
        if (task.phase !== 'active' && !task.accessController.signal.aborted) {
          task.accessController.abort(cancellation);
        }
        if (!task.controller.signal.aborted && task.runnerRunning) {
          task.controller.abort(cancellation);
        }
      }
      await request.reply({ kind: 'cancel.ack', payload: { cancelled: true } });
    } catch (error) {
      await request.reply({ kind: 'protocol.error', payload: { error: safeError(error) } });
    }
  }

  #createRemoteControl(
    request: SubAgentExecutionRequest,
    catalog: SubAgentTransportTargetCatalog,
    channelId: string,
    initialBindingCommitAllowed: () => boolean = () => false,
  ): SubAgentExecutionControl {
    return createRemoteSubAgentExecutionControl({
      taskId: request.taskId,
      executionAttempt: request.attempt,
      executionEpoch: request.executionEpoch,
      executionFencingToken: request.executionFencingToken,
      signal: request.signal,
      deadlineAt: request.deadlineAt,
      delegationSnapshot: request.delegation,
      catalog: catalog.catalog,
      catalogEntries: catalog.catalogEntries,
      exchange: (controlRequest, context) =>
        this.#exchangeControl(controlRequest, context, channelId, initialBindingCommitAllowed),
      createOperationId: (method, identity) =>
        this.#nextControlOperation(request.taskId, method, identity),
      events: (taskId, eventOptions) => {
        const signal =
          eventOptions?.signal === undefined
            ? request.signal
            : AbortSignal.any([request.signal, eventOptions.signal]);
        return this.#remoteControllerEvents(
          taskId,
          Object.freeze({
            ...(eventOptions?.afterSequence === undefined
              ? {}
              : { afterSequence: eventOptions.afterSequence }),
            ...(eventOptions?.limit === undefined ? {} : { limit: eventOptions.limit }),
            signal,
          }),
          Object.freeze({
            executionAttempt: request.attempt,
            executionEpoch: request.executionEpoch,
            executionFencingToken: request.executionFencingToken,
          }),
        );
      },
    });
  }

  #launchTargetTask(options: {
    readonly request: SubAgentExecutionRequest;
    readonly channelId: string;
    readonly prepared: PreparedSubAgentTargetRunner;
    readonly runner: SubAgentChildRunner;
    readonly binding: SubAgentExecutorBinding;
    readonly modelBinding: SubAgentTargetModelBinding;
    readonly control: SubAgentExecutionControl;
    readonly controller: AbortController;
    readonly checkpoint?: SubAgentChildCheckpoint;
    readonly updatedAt?: number;
    readonly beforeRun?: () => void;
    readonly restoreOnPreRunFailure?: TargetTaskRecord;
    readonly releaseRequest: () => void;
  }): TargetTaskRecord {
    const runnerController = new AbortController();
    const accessController = new AbortController();
    const forwardRequestAbort = (): void => {
      const reason = options.controller.signal.reason;
      if (!runnerController.signal.aborted) runnerController.abort(reason);
      if (!accessController.signal.aborted) accessController.abort(reason);
    };
    if (options.controller.signal.aborted) forwardRequestAbort();
    else options.controller.signal.addEventListener('abort', forwardRequestAbort, { once: true });
    const runnerSignal = AbortSignal.any([
      options.prepared.request.signal,
      runnerController.signal,
    ]);
    const runnerRequest = Object.freeze({ ...options.prepared.request, signal: runnerSignal });
    const runnerControl = Object.freeze({ ...options.control, signal: runnerSignal });
    let resolveRunStarted = (): void => undefined;
    let rejectRunStarted: (error: unknown) => void = () => undefined;
    const runStarted = new Promise<void>((resolve, reject) => {
      resolveRunStarted = resolve;
      rejectRunStarted = reject;
    });
    void runStarted.catch(() => undefined);
    const task: TargetTaskRecord = {
      ownerSessionId: options.request.ownerSessionId,
      channelId: options.channelId,
      binding: options.binding,
      modelBinding: options.modelBinding,
      runnerIdentity: options.prepared.runner,
      runner: options.runner,
      controller: runnerController,
      accessController,
      generation: this.#nextTaskGeneration++,
      attachmentRevision: 1,
      request: options.request,
      runStarted,
      promise: Promise.resolve(undefined as never),
      checkpointExchangeTail: Promise.resolve(),
      checkpointGap: false,
      providerOutcomeUnknown: new Map<string, TargetProviderOutcomeUnknown>(),
      providerActiveOperations: new Set<string>(),
      providerOutcomeTerminal: false,
      ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
      cancelRequested: false,
      hardFenced: false,
      activeControlExchanges: 0,
      controlDrain: Promise.resolve(),
      phase: 'active',
      runnerRunning: true,
      updatedAt: options.updatedAt ?? this.#readNow(),
    };
    let runnerInvoked = false;
    const promise = Promise.resolve()
      .then(() => {
        try {
          if (options.request.signal.aborted) throw abortReason(options.request.signal);
          remainingMs(options.request.deadlineAt, this.#now);
          options.beforeRun?.();
          if (options.request.signal.aborted) throw abortReason(options.request.signal);
          remainingMs(options.request.deadlineAt, this.#now);
          runnerInvoked = true;
          resolveRunStarted();
          return options.runner.run(runnerRequest, runnerControl);
        } catch (error) {
          const fallback = options.restoreOnPreRunFailure;
          if (
            fallback !== undefined &&
            !runnerInvoked &&
            !task.cancelRequested &&
            fallback.phase === 'detached' &&
            this.#tasks.get(this.#taskKey(options.request.taskId)) === task
          ) {
            this.#tasks.set(this.#taskKey(options.request.taskId), fallback);
          }
          rejectRunStarted(error);
          throw error;
        }
      })
      .then(
        (outcome) => {
          if (task.providerOutcomeUnknown.size > 0) {
            this.#markProviderOutcomeTerminal(task);
            throw providerOutcomeUnknownError();
          }
          if (task.phase === 'active' || (task.phase === 'quiescing' && !task.hardFenced)) {
            task.outcome = outcome;
            task.phase = 'settled';
          }
          return outcome;
        },
        (error: unknown) => {
          if (task.providerOutcomeUnknown.size > 0) {
            this.#markProviderOutcomeTerminal(task);
            throw providerOutcomeUnknownError();
          }
          throw error;
        },
      )
      .finally(() => {
        task.runnerRunning = false;
        if (task.cancelRequested && !runnerInvoked) {
          task.phase = 'cancelled';
        } else if (task.phase === 'active' || (task.phase === 'quiescing' && !task.hardFenced)) {
          task.phase = 'settled';
        }
        try {
          task.updatedAt = this.#readNow();
        } catch {
          // A diagnostics clock failure must not replace a runner outcome or skip lifecycle cleanup.
        }
        if (!accessController.signal.aborted) {
          accessController.abort(createResourceNotFoundError());
        }
        if (!runnerController.signal.aborted) {
          runnerController.abort(createResourceNotFoundError());
        }
        options.controller.signal.removeEventListener('abort', forwardRequestAbort);
        if (!options.controller.signal.aborted) {
          options.controller.abort(createResourceNotFoundError());
        }
        options.releaseRequest();
      });
    void promise.catch(() => undefined);
    task.promise = promise;
    return task;
  }

  async #handleSnapshot(request: SubAgentTransportPeerHandlerRequest): Promise<void> {
    const envelope = request.envelope;
    if (envelope.kind !== 'snapshot.request') return;
    try {
      const task = this.#requireTask(envelope.taskId);
      const generation = task.generation;
      const attachmentRevision = task.attachmentRevision;
      this.#assertInboundTask(task, generation, attachmentRevision, request.channelId);
      if (envelope.payload.mode === 'snapshot') {
        const snapshot = Object.freeze({
          taskId: envelope.taskId,
          state: task.runnerRunning ? 'running' : stateFromOutcome(task.outcome),
          binding: task.binding,
          updatedAt: task.updatedAt,
        });
        this.#assertInboundTask(task, generation, attachmentRevision, request.channelId);
        await request.reply({
          kind: 'snapshot.reply',
          payload: {
            mode: 'snapshot',
            snapshot,
          },
        });
        return;
      }
      const outcome = await task.promise;
      this.#assertInboundTask(task, generation, attachmentRevision, request.channelId);
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
      const generation = task.generation;
      const attachmentRevision = task.attachmentRevision;
      this.#assertInboundTask(task, generation, attachmentRevision, request.channelId);
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
          signal: task.phase === 'active' ? task.accessController.signal : this.#signal,
        }) ?? emptyEvents();
      const page = await readEventPage(
        source,
        envelope.taskId,
        afterSequence,
        limit,
        task.ownerSessionId,
      );
      this.#assertInboundTask(task, generation, attachmentRevision, request.channelId);
      await request.reply({
        kind: 'events.page',
        payload: page,
      });
    } catch (error) {
      await request.reply({ kind: 'protocol.error', payload: { error: safeError(error) } });
    }
  }

  async #exchangeControl(
    controlRequest: SubAgentTransportControlRequest,
    context: SubAgentTransportControlExchangeContext,
    channelId: string,
    initialBindingCommitAllowed: () => boolean,
  ): Promise<SubAgentTransportControlReply> {
    if (controlRequest.method === 'execution.commitBinding') {
      if (!initialBindingCommitAllowed()) throw createResourceNotFoundError();
      return this.#performRemoteControlExchange(controlRequest, context, channelId);
    }
    const task = this.#requireTask(controlRequest.taskId);
    if (task.cancelRequested && controlRequest.method === 'execution.reportProgress') {
      const generation = task.generation;
      const attachmentRevision = task.attachmentRevision;
      this.#assertCancellationProgress(task, generation, attachmentRevision, context, channelId);
      this.#assertProviderActivitySafe(task);
      const reply = await this.#performRemoteControlExchange(controlRequest, context, channelId);
      this.#assertCancellationProgress(task, generation, attachmentRevision, context, channelId);
      return reply;
    }
    this.#assertActiveTaskScope(task, context);
    if (task.channelId !== channelId) throw createResourceNotFoundError();
    this.#assertProviderActivitySafe(task);
    const checkpointCandidate = checkpointFromControlRequest(controlRequest);
    const checkpoint =
      checkpointCandidate === undefined
        ? undefined
        : this.#ownCheckpointForTask(task, context, checkpointCandidate);
    const generation = task.generation;
    const release = this.#admitReverseActivity(task, context, channelId);
    try {
      if (checkpoint === undefined) {
        const reply = await this.#performRemoteControlExchange(controlRequest, context, channelId);
        this.#assertControlLease(task, generation, context, channelId);
        return reply;
      }
      const previous = task.checkpointExchangeTail;
      const pending = previous
        .catch(() => undefined)
        .then(() =>
          this.#performCheckpointControlExchange(
            task,
            generation,
            controlRequest,
            context,
            channelId,
            checkpoint,
          ),
        );
      task.checkpointExchangeTail = pending.then(
        () => undefined,
        () => undefined,
      );
      return await pending;
    } finally {
      release();
    }
  }

  async #performRemoteControlExchange(
    controlRequest: SubAgentTransportControlRequest,
    context: SubAgentTransportControlExchangeContext,
    channelId: string,
    onAdmitted?: () => void,
  ): Promise<SubAgentTransportControlReply> {
    const response = await requestOne(
      this.#resolvePeerForChannel(channelId),
      {
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
      },
      onAdmitted,
    );
    if (response.envelope.kind === 'protocol.error') {
      throw new SubAgentRuntimeError(response.envelope.payload.error);
    }
    if (response.envelope.kind !== 'control.reply') {
      throw bridgeInternalError('The reverse control exchange returned an invalid reply.');
    }
    return response.envelope.payload;
  }

  async #performTargetModelExchange(
    request: Parameters<SubAgentTransportModelExchange>[0],
    signal: AbortSignal,
    deadlineAt: number,
    channelId: string,
    onAdmitted: () => void,
  ): Promise<SubAgentTransportRpcPayloadMap['model.reply']> {
    if (signal.aborted) throw abortReason(signal);
    remainingMs(deadlineAt, this.#now);
    const peer = this.#resolvePeerForChannel(channelId);
    if (signal.aborted) throw abortReason(signal);
    const timeoutMs = remainingMs(deadlineAt, this.#now);
    const response = await requestOne(
      peer,
      {
        kind: 'model.request',
        taskId: request.taskId,
        operationId: request.operationId,
        payload: request.payload,
        signal,
        timeoutMs,
      },
      onAdmitted,
    );
    if (response.envelope.kind === 'protocol.error') {
      throw new SubAgentRuntimeError(response.envelope.payload.error);
    }
    if (response.envelope.kind !== 'model.reply') {
      throw bridgeInternalError('The controller Model gateway returned an invalid reply.');
    }
    const reply = response.envelope.payload;
    const expected = request.payload;
    if (
      reply.providerOperationId !== expected.providerOperationId ||
      reply.gatewayId !== expected.gatewayId ||
      reply.protocol !== expected.protocol ||
      reply.codecVersion !== expected.codecVersion ||
      reply.runId !== expected.runId ||
      reply.executionAttempt !== expected.executionAttempt ||
      reply.executionEpoch !== expected.executionEpoch ||
      reply.executionFencingToken !== expected.executionFencingToken ||
      reply.checkpointOperationId !== expected.checkpointOperationId ||
      reply.checkpointDigest !== expected.checkpointDigest ||
      reply.requestHash !== expected.requestHash
    ) {
      throw bridgeInternalError('The controller Model gateway reply identity is invalid.');
    }
    return reply;
  }

  async #performCheckpointControlExchange(
    task: TargetTaskRecord,
    generation: number,
    controlRequest: SubAgentTransportControlRequest,
    context: SubAgentTransportControlExchangeContext,
    channelId: string,
    checkpoint: SubAgentChildCheckpoint,
  ): Promise<SubAgentTransportControlReply> {
    this.#assertControlLease(task, generation, context, channelId);
    const previousGap = task.checkpointGap;
    let admitted = false;
    try {
      const reply = await this.#performRemoteControlExchange(
        controlRequest,
        context,
        channelId,
        () => {
          admitted = true;
          task.checkpointGap = true;
        },
      );
      this.#assertControlLease(task, generation, context, channelId);
      assertCheckpointControlReplyMatchesRequest(
        controlRequest,
        reply,
        task.request.ownerSessionId,
      );
      if (!reply.ok) {
        task.checkpointGap =
          controlRequest.method === 'execution.authorizeTool' &&
          reply.error.code === 'INTERNAL_ERROR'
            ? true
            : previousGap;
        return reply;
      }
      await runWithSignal(
        () =>
          this.#checkpointCommitted(
            Object.freeze({
              operationId: controlRequest.operationId,
              ownerSessionId: task.request.ownerSessionId,
              taskId: task.request.taskId,
              executionAttempt: task.request.attempt,
              executionEpoch: task.request.executionEpoch,
              executionFencingToken: task.request.executionFencingToken,
              signal: context.signal,
              deadlineAt: context.deadlineAt,
              binding: task.binding,
              checkpoint,
            }),
          ),
        context.signal,
      );
      this.#assertControlLease(task, generation, context, channelId);
      task.checkpoint = checkpoint;
      task.checkpointGap = false;
      return reply;
    } catch (error) {
      const outcomeUnknown =
        error instanceof SubAgentTransportPeerError && error.descriptor.outcomeUnknown === true;
      if (admitted || outcomeUnknown) {
        if (
          this.#tasks.get(this.#taskKey(task.request.taskId)) === task &&
          task.generation === generation &&
          task.channelId === channelId
        ) {
          task.checkpointGap = true;
        }
      } else if (this.#isControlLeaseCurrent(task, generation, context, channelId)) {
        task.checkpointGap = previousGap;
      }
      throw error;
    }
  }

  #ownCheckpointForTask(
    task: TargetTaskRecord,
    context: SubAgentTransportControlExchangeContext,
    candidate: SubAgentChildCheckpoint,
  ): SubAgentChildCheckpoint {
    this.#assertActiveTaskScope(task, context);
    const checkpoint = ownedChildCheckpoint(candidate);
    if (
      checkpoint.runnerId !== task.runnerIdentity.runnerId ||
      checkpoint.runnerVersion !== task.runnerIdentity.runnerVersion ||
      !task.runnerIdentity.childCheckpointVersions.includes(checkpoint.version)
    ) {
      throw new SubAgentRuntimeError({
        code: 'CHECKPOINT_VERSION_MISMATCH',
        message: 'The proposed checkpoint does not match the active target runner.',
        retryable: false,
      });
    }
    return checkpoint;
  }

  async *#remoteControllerEvents(
    taskId: string,
    options: SubAgentEventStreamOptions,
    scope: Readonly<{
      executionAttempt: number;
      executionEpoch: string;
      executionFencingToken: string;
    }>,
  ): AsyncIterable<SubAgentTaskEvent> {
    let cursor = options.afterSequence ?? 0;
    const limit = Math.min(options.limit ?? this.#maxEventPageSize, this.#maxEventPageSize);
    let active: SubAgentTransportPeerExchange | undefined;
    try {
      while (true) {
        const task = this.#requireTask(taskId);
        const generation = task.generation;
        const attachmentRevision = task.attachmentRevision;
        const channelId = task.channelId;
        this.#assertActiveTaskScope(task, scope);
        this.#assertProviderActivitySafe(task);
        active = this.#resolvePeerForChannel(channelId).request({
          kind: 'events.request',
          taskId,
          operationId: this.#nextOperation('events', taskId, String(cursor)),
          payload: { ...(cursor === 0 ? {} : { afterSequence: cursor }), limit },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const response = await requireNext(active);
        await requireDone(active);
        active = undefined;
        this.#assertActiveTaskContinuation(task, generation, attachmentRevision, channelId, scope);
        if (response.envelope.kind === 'protocol.error') {
          throw new SubAgentRuntimeError(response.envelope.payload.error);
        }
        if (response.envelope.kind !== 'events.page') {
          throw bridgeInternalError('The controller event source returned an invalid reply.');
        }
        for (const event of response.envelope.payload.events) {
          this.#assertActiveTaskContinuation(
            task,
            generation,
            attachmentRevision,
            channelId,
            scope,
          );
          yield event;
        }
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

  #assertInboundTask(
    task: TargetTaskRecord,
    generation: number,
    attachmentRevision: number,
    channelId: string,
  ): void {
    if (
      this.#disposed ||
      task.generation !== generation ||
      task.attachmentRevision !== attachmentRevision ||
      task.channelId !== channelId ||
      (task.phase !== 'active' && task.phase !== 'settled') ||
      this.#tasks.get(this.#taskKey(task.request.taskId)) !== task
    ) {
      throw createResourceNotFoundError();
    }
  }

  #admitReverseActivity(
    task: TargetTaskRecord,
    context: Readonly<{
      executionAttempt: number;
      executionEpoch: string;
      executionFencingToken: string;
    }>,
    channelId: string,
  ): () => void {
    this.#assertActiveTaskScope(task, context);
    if (task.channelId !== channelId) throw createResourceNotFoundError();
    if (task.activeControlExchanges === 0) {
      let resolve = (): void => undefined;
      task.controlDrain = new Promise<void>((settle) => {
        resolve = settle;
      });
      task.resolveControlDrain = resolve;
    }
    task.activeControlExchanges += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      task.activeControlExchanges -= 1;
      if (task.activeControlExchanges === 0) {
        task.resolveControlDrain?.();
        delete task.resolveControlDrain;
        task.controlDrain = Promise.resolve();
      }
    };
  }

  #isControlLeaseCurrent(
    task: TargetTaskRecord,
    generation: number,
    context: SubAgentTransportControlExchangeContext,
    channelId: string,
  ): boolean {
    if (context.signal.aborted) return false;
    try {
      if (deadlineExpired(context.deadlineAt, this.#now)) return false;
    } catch {
      return false;
    }
    return (
      !this.#disposed &&
      this.#tasks.get(this.#taskKey(task.request.taskId)) === task &&
      task.generation === generation &&
      task.channelId === channelId &&
      (task.phase === 'active' || task.phase === 'quiescing') &&
      !task.cancelRequested &&
      task.request.attempt === context.executionAttempt &&
      task.request.executionEpoch === context.executionEpoch &&
      task.request.executionFencingToken === context.executionFencingToken
    );
  }

  #assertControlLease(
    task: TargetTaskRecord,
    generation: number,
    context: SubAgentTransportControlExchangeContext,
    channelId: string,
  ): void {
    if (!this.#isControlLeaseCurrent(task, generation, context, channelId)) {
      throw createResourceNotFoundError();
    }
  }

  #assertCurrentTask(task: TargetTaskRecord, generation: number): void {
    if (
      this.#disposed ||
      task.generation !== generation ||
      this.#tasks.get(this.#taskKey(task.request.taskId)) !== task
    ) {
      throw createResourceNotFoundError();
    }
  }

  #assertActiveTaskContinuation(
    task: TargetTaskRecord,
    generation: number,
    attachmentRevision: number,
    channelId: string,
    scope: Readonly<{
      executionAttempt: number;
      executionEpoch: string;
      executionFencingToken: string;
    }>,
  ): void {
    if (
      this.#disposed ||
      (task.phase !== 'active' && (task.phase !== 'quiescing' || task.hardFenced)) ||
      task.cancelRequested ||
      task.request.signal.aborted ||
      deadlineExpired(task.request.deadlineAt, this.#now)
    ) {
      throw createResourceNotFoundError();
    }
    this.#assertTaskAttachmentScope(task, generation, attachmentRevision, channelId, scope);
  }

  #assertTaskAttachmentScope(
    task: TargetTaskRecord,
    generation: number,
    attachmentRevision: number,
    channelId: string,
    scope: Readonly<{
      executionAttempt: number;
      executionEpoch: string;
      executionFencingToken: string;
    }>,
  ): void {
    if (
      this.#tasks.get(this.#taskKey(task.request.taskId)) !== task ||
      task.generation !== generation ||
      task.attachmentRevision !== attachmentRevision ||
      task.channelId !== channelId ||
      task.hardFenced ||
      task.request.attempt !== scope.executionAttempt ||
      task.request.executionEpoch !== scope.executionEpoch ||
      task.request.executionFencingToken !== scope.executionFencingToken
    ) {
      throw createResourceNotFoundError();
    }
  }

  #assertActiveTaskScope(
    task: TargetTaskRecord,
    scope: Readonly<{
      executionAttempt: number;
      executionEpoch: string;
      executionFencingToken: string;
    }>,
  ): void {
    if (!task.runnerRunning || task.phase !== 'active' || task.cancelRequested) {
      throw createResourceNotFoundError();
    }
    this.#assertTaskExecutionScope(task, scope);
  }

  #assertCancellationProgress(
    task: TargetTaskRecord,
    generation: number,
    attachmentRevision: number,
    context: SubAgentTransportControlExchangeContext,
    channelId: string,
  ): void {
    if (
      this.#disposed ||
      this.#tasks.get(this.#taskKey(task.request.taskId)) !== task ||
      task.generation !== generation ||
      task.attachmentRevision !== attachmentRevision ||
      task.channelId !== channelId ||
      task.phase !== 'active' ||
      !task.cancelRequested ||
      task.hardFenced ||
      !task.runnerRunning ||
      task.accessController.signal.aborted ||
      context.signal.aborted ||
      deadlineExpired(context.deadlineAt, this.#now)
    ) {
      throw createResourceNotFoundError();
    }
    this.#assertTaskExecutionScope(task, context);
  }

  #assertTaskExecutionScope(
    task: TargetTaskRecord,
    scope: Readonly<{
      executionAttempt: number;
      executionEpoch: string;
      executionFencingToken: string;
    }>,
  ): void {
    if (
      task.request.attempt !== scope.executionAttempt ||
      task.request.executionEpoch !== scope.executionEpoch ||
      task.request.executionFencingToken !== scope.executionFencingToken
    ) {
      throw createResourceNotFoundError();
    }
  }

  #requireTask(taskId: string): TargetTaskRecord {
    const task = this.#tasks.get(this.#taskKey(taskId));
    if (task === undefined || (task.phase !== 'active' && task.phase !== 'settled')) {
      throw createResourceNotFoundError();
    }
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

  #assertProviderRecoverySafe(task: TargetTaskRecord): void {
    if (task.providerOutcomeTerminal || task.providerOutcomeUnknown.size > 0) {
      throw new SubAgentRuntimeError({
        code: 'RECOVERY_UNSUPPORTED',
        message: 'The target task has an unresolved provider outcome.',
        retryable: false,
      });
    }
  }

  #assertProviderActivitySafe(task: TargetTaskRecord): void {
    if (task.providerOutcomeTerminal || task.providerOutcomeUnknown.size > 0) {
      throw providerOutcomeUnknownError();
    }
  }

  #markProviderOutcomeTerminal(task: TargetTaskRecord): void {
    task.providerOutcomeTerminal = true;
    for (const [operationId, unresolved] of task.providerOutcomeUnknown) {
      if (!unresolved.terminal) {
        task.providerOutcomeUnknown.set(
          operationId,
          Object.freeze({ requestHash: unresolved.requestHash, terminal: true }),
        );
      }
    }
    const reason = providerOutcomeUnknownError();
    if (!task.accessController.signal.aborted) task.accessController.abort(reason);
    if (!task.controller.signal.aborted) task.controller.abort(reason);
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

  #resolvePeerForChannel(channelId: string): SubAgentTransportPeer {
    const peer = typeof this.#peer === 'function' ? this.#peer(channelId) : this.#peer;
    if (peer === null || typeof peer !== 'object' || typeof peer.request !== 'function') {
      throw new TypeError('Subagent target bridge peer provider returned an invalid peer.');
    }
    if (peer.channelId !== channelId) throw createResourceNotFoundError();
    if (peer.state === 'closed') throw createResourceNotFoundError();
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
  onAdmitted?: () => void,
): Promise<SubAgentTransportPeerResponse> {
  const exchange = peer.request(request);
  try {
    onAdmitted?.();
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

function isOutcomeUnknownFailure(error: unknown): boolean {
  return (
    (error instanceof SubAgentTransportPeerError || error instanceof SubAgentRuntimeError) &&
    error.descriptor.outcomeUnknown === true
  );
}

function providerOutcomeUnknownError(): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'EXECUTOR_FAILED',
    message: 'The provider model request has an unknown outcome.',
    retryable: false,
    causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN',
    outcomeUnknown: true,
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

function isCancelledTargetTask(task: TargetTaskRecord | undefined): boolean {
  return task?.phase === 'cancelled' || task?.cancelRequested === true;
}

function targetTaskHasPhase(task: TargetTaskRecord, phase: TargetTaskPhase): boolean {
  return task.phase === phase;
}

function checkpointFromControlRequest(
  request: SubAgentTransportControlRequest,
): SubAgentChildCheckpoint | undefined {
  switch (request.method) {
    case 'execution.commitCheckpoint':
    case 'execution.authorizeTool':
      return request.args.checkpoint;
    default:
      return undefined;
  }
}

function assertCheckpointControlReplyMatchesRequest(
  request: SubAgentTransportControlRequest,
  reply: SubAgentTransportControlReply,
  ownerSessionId: string,
): void {
  if (reply.method !== request.method) {
    throw bridgeInternalError('The remote control reply did not match its request.');
  }
  if (!reply.ok || request.method !== 'execution.authorizeTool') return;
  const directive = reply.result as ApprovalDirective;
  if (
    directive.type === 'suspend' &&
    (directive.request.taskId !== request.taskId ||
      directive.request.ownerSessionId !== ownerSessionId ||
      directive.request.callId !== request.args.request.callId ||
      directive.request.toolName !== request.args.request.toolName ||
      directive.request.summary !== request.args.request.summary ||
      directive.request.expiresAt !== request.args.request.expiresAt)
  ) {
    throw bridgeInternalError('The remote approval directive did not match its request scope.');
  }
}

function ownedChildCheckpoint(candidate: unknown): SubAgentChildCheckpoint {
  try {
    assertJsonValue(candidate, {
      maxBytes: DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
      maxDepth: DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
      maxNodes: DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
      label: 'Subagent controller-acknowledged checkpoint',
    });
    const checkpoint = parseJsonValue(canonicalizeJson(candidate as JsonValue));
    deepFreezeJson(checkpoint);
    return checkpoint as unknown as SubAgentChildCheckpoint;
  } catch {
    throw new SubAgentRuntimeError({
      code: 'CHECKPOINT_MIGRATION_FAILED',
      message: 'The controller-acknowledged child checkpoint is invalid.',
      retryable: false,
    });
  }
}

async function waitForTaskQuiescence(task: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    await Promise.race([
      task.then(
        () => undefined,
        () => undefined,
      ),
      aborted,
    ]);
  } finally {
    removeAbortListener();
  }
}

async function runWithSignal<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  const pending = Promise.resolve().then(() => {
    if (signal.aborted) throw abortReason(signal);
    return operation();
  });
  void pending.catch(() => undefined);
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    removeAbortListener();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new SubAgentRuntimeError({
        code: 'CANCELLED',
        message: 'The external reconnect was cancelled before the previous runner quiesced.',
        retryable: false,
      });
}

function bindingsEqual(left: SubAgentExecutorBinding, right: SubAgentExecutorBinding): boolean {
  return (
    canonicalizeJson(left as unknown as JsonValue) ===
    canonicalizeJson(right as unknown as JsonValue)
  );
}

function readExecutionOperation(
  request: SubAgentExecutionRequest,
): SubAgentExecutionRequest['operation'] {
  if (request === null || typeof request !== 'object' || nodeTypes.isProxy(request as object)) {
    throw bindingInvalidError();
  }
  const descriptor = Object.getOwnPropertyDescriptor(request, 'operation');
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    throw bindingInvalidError();
  }
  return descriptor.value as SubAgentExecutionRequest['operation'];
}

function readExecutionOperationType(operation: SubAgentExecutionRequest['operation']): unknown {
  if (
    operation === null ||
    typeof operation !== 'object' ||
    nodeTypes.isProxy(operation as object)
  ) {
    throw bindingInvalidError();
  }
  const descriptor = Object.getOwnPropertyDescriptor(operation, 'type');
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    throw bindingInvalidError();
  }
  return descriptor.value;
}

function readExecutionOperationBinding(operation: SubAgentExecutionRequest['operation']): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(operation, 'binding');
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    throw bindingInvalidError();
  }
  return descriptor.value;
}

function ownedBinding(
  candidate: unknown,
  maxBytes = DEFAULT_EXECUTOR_MAX_BINDING_BYTES,
): SubAgentExecutorBinding {
  try {
    // JSON validation rejects Proxy, accessor, symbol-keyed and non-plain values by inspecting
    // descriptors. It must run before any binding field or key is read.
    assertJsonValue(candidate, {
      maxBytes,
      maxDepth: 64,
      maxNodes: 10_000,
      label: 'Subagent transport binding',
    });
    const cloned = parseJsonValue(canonicalizeJson(candidate as JsonValue));
    assertOwnedBindingShape(cloned);
    deepFreezeJson(cloned);
    return cloned as unknown as SubAgentExecutorBinding;
  } catch {
    throw bindingInvalidError();
  }
}

function assertOwnedBindingShape(value: JsonValue): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw bindingInvalidError();
  }
  const record = value as { readonly [key: string]: JsonValue };
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
  const actualKeys = Object.keys(record).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    record.version !== '1'
  ) {
    throw bindingInvalidError();
  }
  for (const key of [
    'executorName',
    'ownerSessionId',
    'taskId',
    'subagentSessionId',
    'definitionName',
    'definitionVersion',
    'runnerId',
    'runnerVersion',
    'adapterStateVersion',
  ] as const) {
    assertIdentifier(record[key] as string, `transport binding ${key}`);
  }
  const modelBinding = record.modelBinding;
  if (modelBinding === null || typeof modelBinding !== 'object' || Array.isArray(modelBinding)) {
    throw bindingInvalidError();
  }
  const modelRecord = modelBinding as { readonly [key: string]: JsonValue };
  const modelKeys = Object.keys(modelRecord).sort();
  const expectedModelKeys = ['codecVersion', 'gatewayId', 'protocol'];
  if (
    modelKeys.length !== expectedModelKeys.length ||
    modelKeys.some((key, index) => key !== expectedModelKeys[index])
  ) {
    throw bindingInvalidError();
  }
  for (const key of expectedModelKeys) {
    assertIdentifier(modelRecord[key] as string, `transport binding modelBinding.${key}`);
  }
}

function bindingInvalidError(): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'BINDING_INVALID',
    message: 'The Subagent transport binding is invalid.',
    retryable: false,
  });
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
    ...(previous.retryOf === undefined ? {} : { retryOf: previous.retryOf }),
    definition: previous.definition,
    input: previous.input,
    projectedContext: previous.projectedContext,
  } as unknown as JsonValue;
  const currentStable = {
    ownerSessionId: current.ownerSessionId,
    runId: current.runId,
    taskId: current.taskId,
    ...(current.parentTaskId === undefined ? {} : { parentTaskId: current.parentTaskId }),
    subagentSessionId: current.subagentSessionId,
    path: current.path,
    ...(current.retryOf === undefined ? {} : { retryOf: current.retryOf }),
    definition: current.definition,
    input: current.input,
    projectedContext: current.projectedContext,
  } as unknown as JsonValue;
  if (
    canonicalizeJson(previousStable) !== canonicalizeJson(currentStable) ||
    !sameTransportDelegationScope(previous.delegation, current.delegation) ||
    !sameTransportStableLimits(previous.limits, current.limits) ||
    current.attempt <= previous.attempt ||
    current.executionEpoch === previous.executionEpoch ||
    parseExecutionFencingToken(current.executionFencingToken) <=
      parseExecutionFencingToken(previous.executionFencingToken) ||
    !Number.isSafeInteger(current.limits.timeoutMs) ||
    current.limits.timeoutMs < 1 ||
    current.limits.timeoutMs > previous.limits.timeoutMs
  ) {
    throw new SubAgentRuntimeError({
      code: 'BINDING_INVALID',
      message: 'The resumed transport execution does not advance the resident task identity.',
      retryable: false,
    });
  }
}

function sameTransportDelegationScope(
  left: SubAgentExecutionRequest['delegation'],
  right: SubAgentExecutionRequest['delegation'],
): boolean {
  return (
    left.version === right.version &&
    left.ownerSessionId === right.ownerSessionId &&
    left.runId === right.runId &&
    left.parentTaskId === right.parentTaskId &&
    left.depth === right.depth &&
    left.path.length === right.path.length &&
    left.path.every((part, index) => part === right.path[index])
  );
}

function sameTransportStableLimits(
  left: SubAgentExecutionRequest['limits'],
  right: SubAgentExecutionRequest['limits'],
): boolean {
  return (
    left.maxDepth === right.maxDepth &&
    left.maxDescendants === right.maxDescendants &&
    left.maxConcurrent === right.maxConcurrent &&
    left.maxTurns === right.maxTurns &&
    left.maxProviderCalls === right.maxProviderCalls &&
    left.maxInputTokens === right.maxInputTokens &&
    left.maxOutputTokens === right.maxOutputTokens &&
    left.maxCost === right.maxCost
  );
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
