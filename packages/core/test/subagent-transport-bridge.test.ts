import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { acceptanceIt } from '../../../testkit';

import {
  createSubAgentTransportExecutorBridge,
  createSubAgentTransportTargetBridge,
  type SubAgentTransportModelRequestContext,
  type SubAgentTransportModelRequestHandler,
  type SubAgentTransportTargetCatalog,
} from '../src/subagent/transport-bridge';
import type { SubAgentChildCheckpoint } from '../src/subagent/checkpoint';
import type { SubAgentChildRunRequest, SubAgentChildRunner } from '../src/subagent/child-runner';
import type { SubAgentExecutorDescriptor } from '../src/subagent/catalog';
import { defineSubAgent } from '../src/subagent/definition';
import { SubAgentRuntimeError } from '../src/subagent/errors';
import type {
  SubAgentExecutionControl,
  SubAgentExecutionRequest,
  SubAgentExecutorBinding,
} from '../src/subagent/executor';
import { canonicalJsonSha256, type JsonValue } from '../src/subagent/json';
import { DEFAULT_SUBAGENT_LIMITS } from '../src/subagent/limits';
import { hashSubAgentTransportModelRequest } from '../src/subagent/transport-model-gateway';
import {
  SubAgentTransportPeer,
  createSubAgentTransportPeerWriterAdmission,
  type SubAgentTransportPeerExchange,
  type SubAgentTransportPeerHandlerRequest,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportPeerReply,
  type SubAgentTransportPeerResponse,
} from '../src/subagent/transport-peer';
import { createSubAgentTransportRpcEnvelope } from '../src/subagent/transport-rpc-codec';
import type { SubAgentTransportRpcPayloadMap } from '../src/subagent/transport-rpc';
import { createSubAgentExecutionRequestWire } from '../src/subagent/transport-codec';
import { SubAgentTargetRunnerRegistry } from '../src/subagent/target-runner-registry';
import type { SubAgentExecutionOutcome } from '../src/subagent/result';
import type { SubAgentTaskHandle } from '../src/subagent/runtime';
import type { SubAgentTaskEvent } from '../src/subagent/telemetry';

const NOW = 1_000;
const definition = defineSubAgent({
  name: 'reviewer',
  version: '2',
  description: 'Review one query.',
  inputSchema: z.object({ query: z.string().trim().min(1) }),
  outputSchema: z.object({ answer: z.string() }),
});

const descriptor: SubAgentExecutorDescriptor = Object.freeze({
  runtimeProtocolVersion: '1',
  taskRecordVersions: Object.freeze(['1']),
  childCheckpointVersions: Object.freeze(['1']),
  runnerCompatibility: Object.freeze([
    Object.freeze({
      runnerId: 'bridge-runner',
      runnerVersion: '1',
      childCheckpointVersions: Object.freeze(['1']),
    }),
  ]),
  name: 'process',
  description: 'Loopback placement.',
  useCases: Object.freeze(['Tests']),
  capabilities: Object.freeze({
    execute: true,
    spawn: true,
    cancel: true,
    events: true,
    approval: true,
    usage: 'provider',
    recovery: Object.freeze({ resume: 'checkpoint', reconnect: 'none' }),
  }),
  adapterStateVersion: '1',
  maxBindingBytes: 64 * 1024,
  maxEventPageSize: 2,
});

const bindingCodec = Object.freeze({
  adapterStateVersion: '1',
  encode: (state: { readonly jobId: string }): JsonValue => ({ jobId: state.jobId }),
  decode: (value: JsonValue): { readonly jobId: string } => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('Invalid binding state.');
    }
    const record = value as { readonly [key: string]: JsonValue };
    if (typeof record.jobId !== 'string') throw new TypeError('Invalid binding state.');
    return Object.freeze({ jobId: record.jobId });
  },
});

function createRequest(
  overrides: Partial<SubAgentExecutionRequest> = {},
): SubAgentExecutionRequest {
  return {
    operation: {
      type: 'create',
      operationId: 'create-1',
      idempotencyKey: 'request-1',
    },
    ownerSessionId: 'owner-session-1',
    runId: 'run-1',
    taskId: 'task-1',
    subagentSessionId: 'subagent-session-1',
    path: ['task-1'],
    attempt: 1,
    executionEpoch: 'epoch-1',
    executionFencingToken: '1',
    definition: { name: definition.name, version: definition.version },
    input: { query: 'hello' },
    projectedContext: [],
    delegation: {
      version: '1',
      ownerSessionId: 'owner-session-1',
      runId: 'run-1',
      parentTaskId: 'task-1',
      path: ['task-1'],
      depth: 1,
      catalogRevision: 1,
      definitions: [],
    },
    limits: DEFAULT_SUBAGENT_LIMITS,
    signal: new AbortController().signal,
    deadlineAt: NOW + 120_000,
    ...overrides,
  };
}

function createBinding(request: SubAgentExecutionRequest): SubAgentExecutorBinding {
  return Object.freeze({
    version: '1',
    executorName: descriptor.name,
    ownerSessionId: request.ownerSessionId,
    taskId: request.taskId,
    subagentSessionId: request.subagentSessionId,
    definitionName: request.definition.name,
    definitionVersion: request.definition.version,
    runnerId: 'bridge-runner',
    runnerVersion: '1',
    adapterStateVersion: bindingCodec.adapterStateVersion,
    modelBinding: {
      gatewayId: 'controller-model',
      protocol: 'openai-chat',
      codecVersion: '1',
    },
    recoveryData: { jobId: `job-${request.taskId}` },
  });
}

function createBindingWithoutModel(request: SubAgentExecutionRequest): SubAgentExecutorBinding {
  const candidate = { ...createBinding(request) } as Partial<SubAgentExecutorBinding>;
  Reflect.deleteProperty(candidate, 'modelBinding');
  return candidate as SubAgentExecutorBinding;
}

function createAccessorBinding(request: SubAgentExecutionRequest): {
  readonly binding: SubAgentExecutorBinding;
  readonly reads: () => number;
} {
  const candidate = { ...createBinding(request) } as Record<PropertyKey, unknown>;
  let reads = 0;
  Object.defineProperty(candidate, 'ownerSessionId', {
    enumerable: true,
    configurable: true,
    get: () => {
      reads += 1;
      return request.ownerSessionId;
    },
  });
  return {
    binding: candidate as unknown as SubAgentExecutorBinding,
    reads: () => reads,
  };
}

function createProxyBinding(request: SubAgentExecutionRequest): {
  readonly binding: SubAgentExecutorBinding;
  readonly traps: () => number;
} {
  let traps = 0;
  const binding = new Proxy(
    { ...createBinding(request) },
    {
      get(target, key, receiver) {
        traps += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        traps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        traps += 1;
        return Reflect.ownKeys(target);
      },
    },
  );
  return { binding, traps: () => traps };
}

function terminalOutcome(
  request: Pick<SubAgentExecutionRequest, 'taskId' | 'definition'>,
  status: 'succeeded' | 'cancelled' = 'succeeded',
): SubAgentExecutionOutcome {
  if (status === 'succeeded') {
    return Object.freeze({
      type: 'terminal',
      result: Object.freeze({
        status,
        task: Object.freeze({ taskId: request.taskId, subAgent: request.definition }),
        executor: descriptor.name,
        output: Object.freeze({ answer: 'done' }),
      }),
    });
  }
  return Object.freeze({
    type: 'terminal',
    result: Object.freeze({
      status,
      task: Object.freeze({ taskId: request.taskId, subAgent: request.definition }),
      executor: descriptor.name,
      error: Object.freeze({
        code: 'CANCELLED',
        message: 'cancelled',
        retryable: false,
      }),
    }),
  });
}

function taskEvent(request: SubAgentExecutionRequest, sequence: number): SubAgentTaskEvent {
  return Object.freeze({
    eventId: `event-${sequence}`,
    sequence,
    type: 'progress.reported',
    sessionId: request.ownerSessionId,
    runId: request.runId,
    taskId: request.taskId,
    path: request.path,
    definition: request.definition,
    executor: descriptor.name,
    attempt: request.attempt,
    timestamp: NOW + sequence,
    data: Object.freeze({ length: sequence }),
  });
}

function createDelegatingRequest(
  overrides: Partial<SubAgentExecutionRequest> = {},
): SubAgentExecutionRequest {
  const request = createRequest(overrides);
  return Object.freeze({
    ...request,
    delegation: Object.freeze({
      ...request.delegation,
      definitions: Object.freeze([
        Object.freeze({
          name: definition.name,
          version: definition.version,
          executors: Object.freeze([descriptor.name]),
        }),
      ]),
    }),
  });
}

function createNestedCatalog(): SubAgentTransportTargetCatalog {
  const executor = Object.freeze({ ...descriptor, status: 'available' as const });
  return Object.freeze({
    catalog: Object.freeze({
      revision: 1,
      capturedAt: NOW,
      executors: Object.freeze([
        Object.freeze({
          descriptor,
          status: 'available' as const,
          supportedDefinitions: Object.freeze([
            Object.freeze({ name: definition.name, version: definition.version }),
          ]),
        }),
      ]),
    }),
    catalogEntries: Object.freeze([
      Object.freeze({
        definition: Object.freeze({ name: definition.name, version: definition.version }),
        description: definition.description,
        inputSchema: definition.inputSchema,
        executors: Object.freeze([executor]),
      }),
    ]),
  });
}

function createNestedHostHandle(
  parent: SubAgentExecutionRequest,
  taskId = `nested-${parent.taskId}`,
): SubAgentTaskHandle {
  const snapshot = Object.freeze({
    taskId,
    subAgent: Object.freeze({ name: definition.name, version: definition.version }),
    ownerSessionId: parent.ownerSessionId,
    runId: parent.runId,
    subagentSessionId: `session-${taskId}`,
    parentTaskId: parent.taskId,
    path: Object.freeze([...parent.path, taskId]),
    executor: descriptor.name,
    state: 'running' as const,
    revision: 1,
    attempt: 1,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    recoveryRequired: false,
  });
  const outcome: SubAgentExecutionOutcome = Object.freeze({
    type: 'terminal',
    result: Object.freeze({
      status: 'succeeded',
      task: Object.freeze({ taskId, subAgent: snapshot.subAgent }),
      executor: descriptor.name,
      output: Object.freeze({ answer: 'nested-done' }),
    }),
  });
  return Object.freeze({
    taskId,
    snapshot: vi.fn(async () => snapshot),
    wait: vi.fn(async () => outcome),
    cancel: vi.fn(async () =>
      Object.freeze({
        ...snapshot,
        state: 'cancelled' as const,
        revision: 2,
        updatedAt: NOW + 1,
        completedAt: NOW + 1,
      }),
    ),
    events: () => emptyEvents(),
  });
}

function childCheckpoint(): SubAgentChildCheckpoint {
  return Object.freeze({
    version: '1',
    runnerId: 'bridge-runner',
    runnerVersion: '1',
    protocolContext: Object.freeze({
      protocol: 'openai-chat',
      codecVersion: '1',
      value: Object.freeze([]),
    }),
    contextStore: Object.freeze({
      version: '1',
      protocol: 'openai-chat',
      codecVersion: '1',
      revision: 0,
      rawHistory: Object.freeze([]),
      activeSpans: Object.freeze([
        Object.freeze({
          spanId: 'context-span-1',
          kind: 'seed' as const,
          closed: true,
          originalContext: Object.freeze([]),
          entries: Object.freeze([]),
        }),
      ]),
      nextRawItemId: 1,
      nextSpanId: 2,
      nextEntryId: 1,
    }),
    modelIteration: 0,
    maxIterations: 8,
  });
}

function approvalCheckpoint(approvalId: string): SubAgentChildCheckpoint {
  const checkpoint = childCheckpoint();
  const input = Object.freeze({});
  return Object.freeze({
    ...checkpoint,
    pendingBatch: Object.freeze({
      version: '1' as const,
      batchId: 'outer-approval-batch-1',
      assistantMessage: Object.freeze({
        protocol: 'openai-chat',
        codecVersion: '1',
        value: Object.freeze([]),
      }),
      calls: Object.freeze([
        Object.freeze({
          version: '1' as const,
          operationId: 'outer-sensitive-operation-1',
          kind: 'tool' as const,
          callId: 'outer-sensitive-call',
          name: 'outer-sensitive-tool',
          input,
          inputHash: canonicalJsonSha256(input),
          status: 'waiting_approval' as const,
          order: 0,
          approvals: Object.freeze([approvalId]),
        }),
      ]),
      endRequested: false,
      createdAt: NOW,
    }),
  });
}

function modelPayload(
  request: SubAgentChildRunRequest | SubAgentExecutionRequest,
  operationId: string,
): SubAgentTransportRpcPayloadMap['model.request'] {
  const context = Object.freeze([]);
  const tools = Object.freeze([]);
  const canonical = Object.freeze({
    gatewayId: 'controller-model',
    protocol: 'openai-chat',
    codecVersion: '1',
    runId: request.runId,
    checkpointOperationId: `checkpoint-${request.taskId}`,
    checkpointDigest: 'c'.repeat(64),
    purpose: 'agent' as const,
    iteration: 0,
    requestAttempt: 1,
    context,
    tools,
  });
  return Object.freeze({
    providerOperationId: operationId,
    ...canonical,
    executionAttempt: request.attempt,
    executionEpoch: request.executionEpoch,
    executionFencingToken: request.executionFencingToken,
    requestHash: hashSubAgentTransportModelRequest(canonical),
    remainingMs: request.deadlineAt - NOW,
  });
}

function modelReply(
  payload: SubAgentTransportRpcPayloadMap['model.request'],
): SubAgentTransportRpcPayloadMap['model.reply'] {
  return Object.freeze({
    providerOperationId: payload.providerOperationId,
    gatewayId: payload.gatewayId,
    protocol: payload.protocol,
    codecVersion: payload.codecVersion,
    runId: payload.runId,
    executionAttempt: payload.executionAttempt,
    executionEpoch: payload.executionEpoch,
    executionFencingToken: payload.executionFencingToken,
    checkpointOperationId: payload.checkpointOperationId,
    checkpointDigest: payload.checkpointDigest,
    requestHash: payload.requestHash,
    ok: true,
    resultHash: 'e'.repeat(64),
    messages: Object.freeze([]),
  });
}

function createControl() {
  const commitBinding = vi.fn(async () => undefined);
  const commitCheckpoint = vi.fn(async () => undefined);
  const reportProgress = vi.fn(async () => undefined);
  const consumeBudget = vi.fn(async () => undefined);
  const authorizeTool = vi.fn(async () => {
    throw new Error('not used');
  });
  const pauseDelegation = vi.fn(async () => {
    throw new Error('not used');
  });
  const emit = vi.fn(async () => undefined);
  const submitResult = vi.fn(async () => ({
    schemaVersion: '1' as const,
    receiptId: 'result-receipt-1',
    taskId: 'task-1',
    callId: 'result-call-1',
    revision: 2,
    outputHash: 'a'.repeat(64),
    submittedAt: NOW,
    status: 'accepted' as const,
  }));
  const complete = vi.fn(async () => ({
    schemaVersion: '1' as const,
    receiptId: 'completion-receipt-1',
    taskId: 'task-1',
    callId: 'end-call-1',
    revision: 3,
    completedAt: NOW,
    status: 'completed' as const,
  }));
  const fail = vi.fn(async () => {
    throw new Error('not used');
  });
  const control: SubAgentExecutionControl = {
    signal: new AbortController().signal,
    deadlineAt: NOW + 120_000,
    delegation: {
      getCatalog: () => ({ revision: 1, capturedAt: NOW, executors: [] }),
      getCatalogEntries: () => [],
      submitTool: async () => {
        throw new Error('not used');
      },
      dispatchTool: async () => {
        throw new Error('not used');
      },
      execute: async () => {
        throw new Error('not used');
      },
      spawn: async () => {
        throw new Error('not used');
      },
      resumeTool: async () => {
        throw new Error('not used');
      },
    },
    completion: {
      submitResult,
      complete,
      fail,
    },
    commitBinding,
    commitCheckpoint,
    authorizeTool,
    pauseDelegation,
    reportProgress,
    consumeBudget,
    emit,
  };
  return {
    control,
    commitBinding,
    commitCheckpoint,
    reportProgress,
    consumeBudget,
    authorizeTool,
    pauseDelegation,
    emit,
    submitResult,
    complete,
    fail,
  };
}

interface LoopbackOptions {
  readonly run: (
    request: SubAgentChildRunRequest,
    control: SubAgentExecutionControl,
  ) => Promise<SubAgentExecutionOutcome>;
  readonly now?: () => number;
  readonly factory?: () => SubAgentChildRunner | Promise<SubAgentChildRunner>;
  readonly events?: (
    request: SubAgentExecutionRequest,
    afterSequence: number,
  ) => AsyncIterable<SubAgentTaskEvent>;
  readonly model?: SubAgentTransportModelRequestHandler;
  readonly createBinding?: (request: SubAgentExecutionRequest) => SubAgentExecutorBinding;
  readonly validateBinding?: Parameters<
    typeof createSubAgentTransportTargetBridge
  >[0]['validateBinding'];
  readonly resolveCatalog?: Parameters<
    typeof createSubAgentTransportTargetBridge
  >[0]['resolveCatalog'];
  readonly resolveNestedTaskHandle?: Parameters<
    typeof createSubAgentTransportExecutorBridge
  >[0]['resolveNestedTaskHandle'];
  readonly maxRetainedTasks?: number;
  readonly maxRetainedOperations?: number;
}

function createLoopback(options: LoopbackOptions) {
  const factory = vi.fn(
    options.factory ??
      (() => ({
        run: options.run,
      })),
  );
  const registry = new SubAgentTargetRunnerRegistry()
    .register({
      definition,
      runnerId: 'bridge-runner',
      runnerVersion: '1',
      childCheckpointVersions: ['1'],
      modelBinding: {
        gatewayId: 'controller-model',
        protocol: 'openai-chat',
        codecVersion: '1',
      },
      create: factory,
    })
    .seal();
  const targetCreateBinding = vi.fn(options.createBinding ?? createBinding);

  const peers: {
    controller?: SubAgentTransportPeer;
    target?: SubAgentTransportPeer;
  } = {};
  const requirePeer = (side: 'controller' | 'target'): SubAgentTransportPeer => {
    const peer = peers[side];
    if (peer === undefined) throw new Error(`The ${side} loopback peer is not ready.`);
    return peer;
  };
  const controller = createSubAgentTransportExecutorBridge({
    descriptor,
    bindingCodec,
    peer: () => requirePeer('controller'),
    getAvailability: () => ({
      status: 'available',
      supportedDefinitions: registry.list(),
    }),
    supports: (candidate) => registry.has(candidate),
    now: options.now ?? (() => NOW),
    createOperationId: ({ kind, sequence }) => `controller-${kind}-${sequence}`,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.resolveNestedTaskHandle === undefined
      ? {}
      : { resolveNestedTaskHandle: options.resolveNestedTaskHandle }),
  });
  const target = createSubAgentTransportTargetBridge({
    ownerSessionId: 'owner-session-1',
    executorName: descriptor.name,
    registry,
    bindingCodec,
    peer: () => requirePeer('target'),
    createBinding: ({ request }) => targetCreateBinding(request),
    ...(options.validateBinding === undefined ? {} : { validateBinding: options.validateBinding }),
    ...(options.resolveCatalog === undefined ? {} : { resolveCatalog: options.resolveCatalog }),
    now: options.now ?? (() => NOW),
    createOperationId: ({ kind, sequence }) => `target-${kind}-${sequence}`,
    maxEventPageSize: descriptor.maxEventPageSize,
    ...(options.maxRetainedTasks === undefined
      ? {}
      : { maxRetainedTasks: options.maxRetainedTasks }),
    ...(options.maxRetainedOperations === undefined
      ? {}
      : { maxRetainedOperations: options.maxRetainedOperations }),
    ...(options.events === undefined
      ? {}
      : {
          events: ({ request, afterSequence }) =>
            options.events?.(request, afterSequence) ?? emptyEvents(),
        }),
  });

  const deliver = (receiver: () => SubAgentTransportPeer, packet: SubAgentTransportPeerPacket) => {
    const settled = Promise.resolve().then(() => receiver().receive(packet));
    return createSubAgentTransportPeerWriterAdmission(settled);
  };
  const controllerPeer = new SubAgentTransportPeer({
    channelId: 'bridge-loopback',
    now: options.now ?? (() => NOW),
    writer: (packet) => deliver(() => requirePeer('target'), packet),
    handler: controller.handler,
    createMessageId: messageIds('controller'),
  });
  const targetPeer = new SubAgentTransportPeer({
    channelId: 'bridge-loopback',
    now: options.now ?? (() => NOW),
    writer: (packet) => deliver(() => requirePeer('controller'), packet),
    handler: target.handler,
    createMessageId: messageIds('target'),
  });
  peers.controller = controllerPeer;
  peers.target = targetPeer;
  return { controller, target, factory, targetCreateBinding, controllerPeer, targetPeer };
}

function messageIds(prefix: string): () => string {
  let sequence = 1;
  return () => `${prefix}-${sequence++}`;
}

function singleResponseExchange(
  response: SubAgentTransportPeerResponse,
): SubAgentTransportPeerExchange {
  const taskId = response.envelope.taskId;
  const operationId = response.envelope.operationId;
  if (taskId === undefined || operationId === undefined) {
    throw new TypeError('A scripted Executor response requires task and operation identity.');
  }
  let yielded = false;
  let closed = false;
  const exchange: SubAgentTransportPeerExchange = {
    messageId: response.envelope.correlationId,
    taskId,
    operationId,
    requestKind: 'executor.request',
    openedAt: NOW,
    abort: () => {
      closed = true;
    },
    next: async () => {
      if (closed || yielded) {
        return { done: true, value: undefined } as IteratorReturnResult<undefined>;
      }
      yielded = true;
      return { done: false, value: response } as IteratorYieldResult<SubAgentTransportPeerResponse>;
    },
    return: async () => {
      closed = true;
      return { done: true, value: undefined } as IteratorReturnResult<undefined>;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return exchange;
}

async function* emptyEvents(): AsyncIterable<SubAgentTaskEvent> {}

async function invokeTarget(
  target: ReturnType<typeof createSubAgentTransportTargetBridge>,
  envelope: SubAgentTransportPeerHandlerRequest['envelope'],
): Promise<readonly SubAgentTransportPeerReply[]> {
  const replies: SubAgentTransportPeerReply[] = [];
  await target.handler({
    channelId: 'direct-target-handler',
    envelope,
    sidecars: [],
    receivedAt: NOW,
    reply: async (reply) => {
      replies.push(reply);
    },
  });
  return replies;
}

describe('Subagent transport controller/target bridge', () => {
  acceptanceIt('C7-GATEWAY-06.l1.transport-bridge', 'transport-bridge', async () => {
    const run = vi.fn(async (request, control: SubAgentExecutionControl) => {
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.input).toEqual({ query: 'hello' });
      await control.reportProgress('progress-1', { message: 'working', percent: 50 });
      await control.completion.submitResult('result-call-1', { answer: 'done' });
      await control.completion.complete('end-call-1', { isStandalone: true });
      return terminalOutcome(createRequest());
    });
    const loopback = createLoopback({ run });
    const fixtures = createControl();

    await expect(loopback.controller.execute(createRequest(), fixtures.control)).resolves.toEqual(
      terminalOutcome(createRequest()),
    );
    expect(loopback.factory).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(fixtures.commitBinding).toHaveBeenCalledWith(
      'create-1',
      expect.objectContaining({ taskId: 'task-1', executorName: 'process' }),
    );
    expect(fixtures.reportProgress).toHaveBeenCalledWith('progress-1', {
      message: 'working',
      percent: 50,
    });
    expect(fixtures.submitResult).toHaveBeenCalledTimes(1);
    expect(fixtures.complete).toHaveBeenCalledTimes(1);
    expect(loopback.target.diagnostics()).toEqual({
      disposed: false,
      tasks: 1,
      operations: 1,
      starting: 0,
      running: 0,
      taskCapacity: 10_000,
      operationCapacity: 10_000,
    });
  });

  it('runs a placement binding validator after createBinding but before runner or control effects', async () => {
    const run = vi.fn(async (request: SubAgentChildRunRequest) => terminalOutcome(request));
    const model = vi.fn<SubAgentTransportModelRequestHandler>();
    const validateBinding = vi.fn(
      async ({ binding }: { readonly binding: SubAgentExecutorBinding }) => {
        const state = bindingCodec.decode(binding.recoveryData);
        if (state.jobId !== 'trusted-worker-job') {
          throw new SubAgentRuntimeError({
            code: 'BINDING_INVALID',
            message: 'The Worker binding does not belong to this bootstrap job.',
            retryable: false,
          });
        }
      },
    );
    const loopback = createLoopback({ run, model, validateBinding });
    const fixtures = createControl();

    await expect(
      loopback.controller.execute(createRequest(), fixtures.control),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(loopback.targetCreateBinding).toHaveBeenCalledTimes(1);
    expect(validateBinding).toHaveBeenCalledTimes(1);
    expect(loopback.factory).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fixtures.commitBinding).not.toHaveBeenCalled();
    expect(fixtures.commitCheckpoint).not.toHaveBeenCalled();
    expect(fixtures.reportProgress).not.toHaveBeenCalled();
    expect(fixtures.consumeBudget).not.toHaveBeenCalled();
    expect(fixtures.submitResult).not.toHaveBeenCalled();
    expect(fixtures.complete).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('rejects an accessor binding from createBinding without invoking the getter or child effects', async () => {
    const request = createRequest();
    const hostile = createAccessorBinding(request);
    const run = vi.fn(async (childRequest: SubAgentChildRunRequest) =>
      terminalOutcome(childRequest),
    );
    const model = vi.fn<SubAgentTransportModelRequestHandler>();
    const validateBinding = vi.fn(async () => undefined);
    const loopback = createLoopback({
      run,
      model,
      validateBinding,
      createBinding: () => hostile.binding,
    });
    const fixtures = createControl();

    await expect(loopback.controller.execute(request, fixtures.control)).rejects.toMatchObject({
      code: 'BINDING_INVALID',
    });
    expect(hostile.reads()).toBe(0);
    expect(validateBinding).not.toHaveBeenCalled();
    expect(loopback.factory).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fixtures.commitBinding).not.toHaveBeenCalled();
    expect(fixtures.commitCheckpoint).not.toHaveBeenCalled();
    expect(fixtures.reportProgress).not.toHaveBeenCalled();
    expect(fixtures.consumeBudget).not.toHaveBeenCalled();
    expect(fixtures.submitResult).not.toHaveBeenCalled();
    expect(fixtures.complete).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('rejects a createBinding result without modelBinding before validator or child effects', async () => {
    const request = createRequest();
    const run = vi.fn(async (childRequest: SubAgentChildRunRequest) =>
      terminalOutcome(childRequest),
    );
    const model = vi.fn<SubAgentTransportModelRequestHandler>();
    const validateBinding = vi.fn(async () => undefined);
    const loopback = createLoopback({
      run,
      model,
      validateBinding,
      createBinding: (candidate) => createBindingWithoutModel(candidate),
    });
    const fixtures = createControl();

    await expect(loopback.controller.execute(request, fixtures.control)).rejects.toMatchObject({
      code: 'BINDING_INVALID',
    });
    expect(loopback.targetCreateBinding).toHaveBeenCalledTimes(1);
    expect(validateBinding).not.toHaveBeenCalled();
    expect(loopback.factory).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fixtures.commitBinding).not.toHaveBeenCalled();
    expect(fixtures.commitCheckpoint).not.toHaveBeenCalled();
    expect(fixtures.authorizeTool).not.toHaveBeenCalled();
    expect(fixtures.pauseDelegation).not.toHaveBeenCalled();
    expect(fixtures.reportProgress).not.toHaveBeenCalled();
    expect(fixtures.consumeBudget).not.toHaveBeenCalled();
    expect(fixtures.emit).not.toHaveBeenCalled();
    expect(fixtures.submitResult).not.toHaveBeenCalled();
    expect(fixtures.complete).not.toHaveBeenCalled();
    expect(fixtures.fail).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('rejects an accepted transport binding without modelBinding before retaining a task handle', async () => {
    const request = createRequest();
    const accepted = createSubAgentTransportRpcEnvelope({
      channelId: 'missing-model-accepted',
      sequence: 1,
      messageId: 'missing-model-accepted-1',
      correlationId: 'missing-model-request-1',
      taskId: request.taskId,
      operationId: request.operation.operationId,
      kind: 'executor.accepted',
      payload: {
        mode: 'spawn',
        binding: createBindingWithoutModel(request),
      },
    });
    const peerRequest = vi.fn(() =>
      singleResponseExchange({
        envelope: accepted as SubAgentTransportPeerResponse['envelope'],
        sidecars: [],
      }),
    );
    const controller = createSubAgentTransportExecutorBridge({
      descriptor,
      bindingCodec,
      peer: { request: peerRequest } as unknown as SubAgentTransportPeer,
      getAvailability: () => ({ status: 'available', supportedDefinitions: [] }),
      supports: () => true,
      now: () => NOW,
    });
    const fixtures = createControl();

    await expect(controller.spawn(request, fixtures.control)).rejects.toMatchObject({
      code: 'BINDING_INVALID',
    });
    expect(peerRequest).toHaveBeenCalledTimes(1);
    expect(controller.diagnostics()).toEqual({
      activeExecutions: 0,
      taskHandles: 0,
      handleBindings: 0,
      nestedTaskHandles: 0,
    });
    expect(fixtures.commitBinding).not.toHaveBeenCalled();
    expect(fixtures.commitCheckpoint).not.toHaveBeenCalled();
    expect(fixtures.authorizeTool).not.toHaveBeenCalled();
    expect(fixtures.pauseDelegation).not.toHaveBeenCalled();
    expect(fixtures.reportProgress).not.toHaveBeenCalled();
    expect(fixtures.consumeBudget).not.toHaveBeenCalled();
    expect(fixtures.emit).not.toHaveBeenCalled();
    expect(fixtures.submitResult).not.toHaveBeenCalled();
    expect(fixtures.complete).not.toHaveBeenCalled();
    expect(fixtures.fail).not.toHaveBeenCalled();
  });

  it.each([
    ['execute', 'resume'],
    ['spawn', 'reconnect'],
  ] as const)(
    'rejects a missing-modelBinding host %s/%s before Peer or control effects',
    async (method, operationType) => {
      const initial = createRequest();
      const run = vi.fn(async (childRequest: SubAgentChildRunRequest) =>
        terminalOutcome(childRequest),
      );
      const model = vi.fn<SubAgentTransportModelRequestHandler>();
      const loopback = createLoopback({ run, model });
      const peerRequest = vi.spyOn(loopback.controllerPeer, 'request');
      const fixtures = createControl();
      const request = createRequest({
        operation:
          operationType === 'resume'
            ? {
                type: 'resume',
                operationId: 'missing-model-resume-1',
                reason: 'checkpoint',
                binding: createBindingWithoutModel(initial),
                checkpoint: childCheckpoint(),
              }
            : {
                type: 'reconnect',
                operationId: 'missing-model-reconnect-1',
                binding: createBindingWithoutModel(initial),
              },
        attempt: 2,
        executionEpoch: 'epoch-2',
        executionFencingToken: '2',
      });

      const operation =
        method === 'execute'
          ? loopback.controller.execute(request, fixtures.control)
          : loopback.controller.spawn(request, fixtures.control);
      await expect(operation).rejects.toMatchObject({ code: 'BINDING_INVALID' });
      expect(peerRequest).not.toHaveBeenCalled();
      expect(loopback.controller.diagnostics()).toEqual({
        activeExecutions: 0,
        taskHandles: 0,
        handleBindings: 0,
        nestedTaskHandles: 0,
      });
      expect(loopback.target.diagnostics()).toMatchObject({ tasks: 0, operations: 0, starting: 0 });
      expect(loopback.targetCreateBinding).not.toHaveBeenCalled();
      expect(loopback.factory).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(fixtures.commitBinding).not.toHaveBeenCalled();
      expect(fixtures.commitCheckpoint).not.toHaveBeenCalled();
      expect(fixtures.authorizeTool).not.toHaveBeenCalled();
      expect(fixtures.pauseDelegation).not.toHaveBeenCalled();
      expect(fixtures.reportProgress).not.toHaveBeenCalled();
      expect(fixtures.consumeBudget).not.toHaveBeenCalled();
      expect(fixtures.emit).not.toHaveBeenCalled();
      expect(fixtures.submitResult).not.toHaveBeenCalled();
      expect(fixtures.complete).not.toHaveBeenCalled();
      expect(fixtures.fail).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing-modelBinding host cancel before Peer or task-handle effects', async () => {
    const request = createRequest();
    const run = vi.fn(async (childRequest: SubAgentChildRunRequest) =>
      terminalOutcome(childRequest),
    );
    const model = vi.fn<SubAgentTransportModelRequestHandler>();
    const loopback = createLoopback({ run, model });
    const peerRequest = vi.spyOn(loopback.controllerPeer, 'request');

    await expect(
      loopback.controller.cancel(createBindingWithoutModel(request), {
        operationId: 'missing-model-cancel-1',
        signal: new AbortController().signal,
        deadlineAt: NOW + 120_000,
      }),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(peerRequest).not.toHaveBeenCalled();
    expect(loopback.controller.diagnostics()).toEqual({
      activeExecutions: 0,
      taskHandles: 0,
      handleBindings: 0,
      nestedTaskHandles: 0,
    });
    expect(loopback.target.diagnostics()).toMatchObject({ tasks: 0, operations: 0, starting: 0 });
    expect(loopback.targetCreateBinding).not.toHaveBeenCalled();
    expect(loopback.factory).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('rejects an accessor resume binding before execute registers control or reaches the target', async () => {
    const initial = createRequest();
    const hostile = createAccessorBinding(initial);
    const run = vi.fn(async (childRequest: SubAgentChildRunRequest) =>
      terminalOutcome(childRequest),
    );
    const model = vi.fn<SubAgentTransportModelRequestHandler>();
    const loopback = createLoopback({ run, model });
    const fixtures = createControl();
    const resume = createRequest({
      operation: {
        type: 'resume',
        operationId: 'resume-hostile-binding-1',
        reason: 'checkpoint',
        binding: hostile.binding,
        checkpoint: childCheckpoint(),
      },
      attempt: 2,
      executionEpoch: 'epoch-2',
      executionFencingToken: '2',
    });

    await expect(loopback.controller.execute(resume, fixtures.control)).rejects.toMatchObject({
      code: 'BINDING_INVALID',
    });
    expect(hostile.reads()).toBe(0);
    expect(loopback.controller.diagnostics()).toEqual({
      activeExecutions: 0,
      taskHandles: 0,
      handleBindings: 0,
      nestedTaskHandles: 0,
    });
    expect(loopback.target.diagnostics()).toMatchObject({ tasks: 0, operations: 0, starting: 0 });
    expect(loopback.targetCreateBinding).not.toHaveBeenCalled();
    expect(loopback.factory).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fixtures.commitBinding).not.toHaveBeenCalled();
    expect(fixtures.commitCheckpoint).not.toHaveBeenCalled();
    expect(fixtures.reportProgress).not.toHaveBeenCalled();
    expect(fixtures.consumeBudget).not.toHaveBeenCalled();
    expect(fixtures.submitResult).not.toHaveBeenCalled();
    expect(fixtures.complete).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('rejects a Proxy reconnect binding before spawn invokes a Proxy trap or target handler', async () => {
    const initial = createRequest();
    const hostile = createProxyBinding(initial);
    const run = vi.fn(async (childRequest: SubAgentChildRunRequest) =>
      terminalOutcome(childRequest),
    );
    const model = vi.fn<SubAgentTransportModelRequestHandler>();
    const loopback = createLoopback({ run, model });
    const fixtures = createControl();
    const reconnect = createRequest({
      operation: {
        type: 'reconnect',
        operationId: 'reconnect-hostile-binding-1',
        binding: hostile.binding,
      },
      attempt: 2,
      executionEpoch: 'epoch-2',
      executionFencingToken: '2',
    });

    await expect(loopback.controller.spawn(reconnect, fixtures.control)).rejects.toMatchObject({
      code: 'BINDING_INVALID',
    });
    expect(hostile.traps()).toBe(0);
    expect(loopback.controller.diagnostics()).toEqual({
      activeExecutions: 0,
      taskHandles: 0,
      handleBindings: 0,
      nestedTaskHandles: 0,
    });
    expect(loopback.target.diagnostics()).toMatchObject({ tasks: 0, operations: 0, starting: 0 });
    expect(loopback.targetCreateBinding).not.toHaveBeenCalled();
    expect(loopback.factory).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fixtures.commitBinding).not.toHaveBeenCalled();
    expect(fixtures.commitCheckpoint).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it.each(['resume', 'reconnect'] as const)(
    'canonical-clones a target %s binding before owner scope or registry lookup',
    async (operationType) => {
      const initial = createRequest();
      const hostile = createAccessorBinding(initial);
      const run = vi.fn(async (childRequest: SubAgentChildRunRequest) =>
        terminalOutcome(childRequest),
      );
      const loopback = createLoopback({ run });
      const request = createRequest({
        operation:
          operationType === 'resume'
            ? {
                type: 'resume',
                operationId: 'target-hostile-resume-1',
                reason: 'checkpoint',
                binding: createBinding(initial),
                checkpoint: childCheckpoint(),
              }
            : {
                type: 'reconnect',
                operationId: 'target-hostile-reconnect-1',
                binding: createBinding(initial),
              },
        attempt: 2,
        executionEpoch: 'epoch-2',
        executionFencingToken: '2',
      });
      const wire = createSubAgentExecutionRequestWire(request, {
        now: () => NOW,
        expectedExecutorName: descriptor.name,
      });
      const validEnvelope = createSubAgentTransportRpcEnvelope({
        channelId: 'target-hostile-binding',
        sequence: 1,
        messageId: `target-hostile-${operationType}`,
        taskId: request.taskId,
        operationId: request.operation.operationId,
        kind: 'executor.request',
        payload: { mode: 'execute', request: wire },
      });
      const envelope = {
        ...validEnvelope,
        payload: {
          ...validEnvelope.payload,
          request: {
            ...wire,
            operation: { ...wire.operation, binding: hostile.binding },
          },
        },
      } as unknown as SubAgentTransportPeerHandlerRequest['envelope'];

      await expect(invokeTarget(loopback.target, envelope)).resolves.toEqual([
        {
          kind: 'protocol.error',
          payload: {
            error: expect.objectContaining({ code: 'BINDING_INVALID', retryable: false }),
          },
        },
      ]);
      expect(hostile.reads()).toBe(0);
      expect(loopback.target.diagnostics()).toMatchObject({ tasks: 0, operations: 0, starting: 0 });
      expect(loopback.targetCreateBinding).not.toHaveBeenCalled();
      expect(loopback.factory).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'symbol-keyed',
      (request: SubAgentExecutionRequest) => {
        const candidate = { ...createBinding(request) } as Record<PropertyKey, unknown>;
        candidate[Symbol('hostile')] = true;
        return candidate as unknown as SubAgentExecutorBinding;
      },
    ],
    [
      'oversized',
      (request: SubAgentExecutionRequest) => ({
        ...createBinding(request),
        recoveryData: { padding: 'x'.repeat(descriptor.maxBindingBytes) },
      }),
    ],
  ] as const)(
    'rejects a %s cancel binding before sending a cancellation request',
    async (_variant, makeBinding) => {
      const request = createRequest();
      const run = vi.fn(async (childRequest: SubAgentChildRunRequest) =>
        terminalOutcome(childRequest),
      );
      const model = vi.fn<SubAgentTransportModelRequestHandler>();
      const loopback = createLoopback({ run, model });
      const fixtures = createControl();

      await expect(
        loopback.controller.cancel(makeBinding(request), {
          operationId: 'cancel-hostile-binding-1',
          signal: new AbortController().signal,
          deadlineAt: NOW + 120_000,
        }),
      ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
      expect(loopback.target.diagnostics()).toMatchObject({ tasks: 0, operations: 0, starting: 0 });
      expect(loopback.targetCreateBinding).not.toHaveBeenCalled();
      expect(loopback.factory).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(fixtures.commitBinding).not.toHaveBeenCalled();
      expect(fixtures.commitCheckpoint).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
    },
  );

  it('validates delegated catalog and control scope before binding or runner factories', async () => {
    const run = vi.fn(async (request: SubAgentChildRunRequest) => terminalOutcome(request));
    const model = vi.fn<SubAgentTransportModelRequestHandler>();
    const fixtures = createControl();
    const loopback = createLoopback({
      run,
      model,
      resolveCatalog: () =>
        ({
          catalog: { revision: 1, capturedAt: NOW, executors: null },
          catalogEntries: [],
        }) as unknown as SubAgentTransportTargetCatalog,
    });

    await expect(
      loopback.controller.execute(createRequest(), fixtures.control),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(loopback.targetCreateBinding).not.toHaveBeenCalled();
    expect(loopback.factory).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fixtures.commitBinding).not.toHaveBeenCalled();
    expect(fixtures.commitCheckpoint).not.toHaveBeenCalled();
    expect(fixtures.authorizeTool).not.toHaveBeenCalled();
    expect(fixtures.pauseDelegation).not.toHaveBeenCalled();
    expect(fixtures.reportProgress).not.toHaveBeenCalled();
    expect(fixtures.consumeBudget).not.toHaveBeenCalled();
    expect(fixtures.emit).not.toHaveBeenCalled();
    expect(fixtures.submitResult).not.toHaveBeenCalled();
    expect(fixtures.complete).not.toHaveBeenCalled();
    expect(fixtures.fail).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('validates a resumed placement binding before creating a replacement runner', async () => {
    const initial = createRequest();
    const run = vi.fn(async (request: SubAgentChildRunRequest) => terminalOutcome(request));
    const model = vi.fn<SubAgentTransportModelRequestHandler>();
    const validateBinding = vi.fn(
      async ({ binding }: { readonly binding: SubAgentExecutorBinding }) => {
        const state = bindingCodec.decode(binding.recoveryData);
        if (state.jobId !== 'trusted-worker-job') {
          throw new SubAgentRuntimeError({
            code: 'BINDING_INVALID',
            message: 'The Worker binding does not belong to this bootstrap job.',
            retryable: false,
          });
        }
      },
    );
    const loopback = createLoopback({ run, model, validateBinding });
    const fixtures = createControl();
    const resume = createRequest({
      operation: {
        type: 'resume',
        operationId: 'resume-worker-checkpoint-1',
        reason: 'checkpoint',
        binding: createBinding(initial),
        checkpoint: childCheckpoint(),
      },
      attempt: 2,
      executionEpoch: 'epoch-2',
      executionFencingToken: '2',
    });

    await expect(loopback.controller.execute(resume, fixtures.control)).rejects.toMatchObject({
      code: 'BINDING_INVALID',
    });
    expect(loopback.targetCreateBinding).not.toHaveBeenCalled();
    expect(validateBinding).toHaveBeenCalledTimes(1);
    expect(loopback.factory).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fixtures.commitBinding).not.toHaveBeenCalled();
    expect(fixtures.commitCheckpoint).not.toHaveBeenCalled();
    expect(fixtures.reportProgress).not.toHaveBeenCalled();
    expect(fixtures.consumeBudget).not.toHaveBeenCalled();
    expect(fixtures.submitResult).not.toHaveBeenCalled();
    expect(fixtures.complete).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('rejects a missing reconnect target before adapter-specific binding validation', async () => {
    const initial = createRequest();
    const validateBinding = vi.fn(async () => {
      throw new SubAgentRuntimeError({
        code: 'BINDING_INVALID',
        message: 'The Worker bootstrap job does not match the reconnect binding.',
        retryable: false,
      });
    });
    const run = vi.fn(async (request: SubAgentChildRunRequest) => terminalOutcome(request));
    const loopback = createLoopback({ run, validateBinding });
    const fixtures = createControl();
    const reconnect = createRequest({
      operation: {
        type: 'reconnect',
        operationId: 'reconnect-worker-1',
        binding: createBinding(initial),
      },
      attempt: 2,
      executionEpoch: 'epoch-2',
      executionFencingToken: '2',
    });

    await expect(loopback.controller.execute(reconnect, fixtures.control)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(validateBinding).not.toHaveBeenCalled();
    expect(loopback.targetCreateBinding).not.toHaveBeenCalled();
    expect(loopback.factory).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fixtures.commitBinding).not.toHaveBeenCalled();
  });

  acceptanceIt(
    'C7-GATEWAY-22.l1.target-task-initialization',
    'distinct-operation-single-initialization',
    async () => {
      let releaseFactory!: () => void;
      const factoryBarrier = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      const run = vi.fn(async (request: SubAgentChildRunRequest) => terminalOutcome(request));
      const loopback = createLoopback({
        run,
        factory: async () => {
          await factoryBarrier;
          return { run };
        },
      });
      const firstRequest = createRequest();
      const secondRequest = createRequest({
        operation: {
          type: 'create',
          operationId: 'create-distinct-2',
          idempotencyKey: 'create-distinct-2',
        },
      });

      const first = loopback.controller.execute(firstRequest, createControl().control);
      await vi.waitFor(() => expect(loopback.factory).toHaveBeenCalledTimes(1));
      await expect(
        loopback.controller.execute(secondRequest, createControl().control),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(loopback.factory).toHaveBeenCalledTimes(1);

      releaseFactory();
      await expect(first).resolves.toMatchObject({ type: 'terminal' });
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it('returns a lazy spawn handle whose snapshot, paged events and wait stay on the RPC bridge', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const eventReturns = vi.fn();
    const request = createRequest();
    const loopback = createLoopback({
      run: async () => {
        await barrier;
        return terminalOutcome(request);
      },
      events: (_activeRequest, afterSequence) => ({
        [Symbol.asyncIterator]() {
          const values = [taskEvent(request, 1), taskEvent(request, 2)].filter(
            ({ sequence }) => sequence > afterSequence,
          );
          let index = 0;
          return {
            next: async () =>
              index < values.length
                ? { done: false as const, value: values[index++] as SubAgentTaskEvent }
                : { done: true as const, value: undefined },
            return: async () => {
              eventReturns();
              return { done: true as const, value: undefined };
            },
          };
        },
      }),
    });
    const fixtures = createControl();
    const handle = await loopback.controller.spawn(request, fixtures.control);
    expect('taskId' in handle).toBe(true);
    if (!('taskId' in handle)) throw new Error('Expected a task handle.');

    await expect(handle.snapshot()).resolves.toMatchObject({
      taskId: request.taskId,
      state: 'running',
    });
    const iterator = handle.events({ afterSequence: 0, limit: 1 })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { sequence: 1 }, done: false });
    await expect(iterator.next()).resolves.toMatchObject({ value: { sequence: 2 }, done: false });
    await iterator.return?.();
    expect(eventReturns).toHaveBeenCalledTimes(2);

    release();
    await vi.waitFor(() =>
      expect(loopback.controller.diagnostics()).toEqual({
        activeExecutions: 0,
        taskHandles: 0,
        handleBindings: 0,
        nestedTaskHandles: 0,
      }),
    );
    // The returned facade carries only the trusted resolver. It rehydrates from the target's
    // retained terminal receipt and is evicted again after the read-only query settles.
    await expect(handle.wait()).resolves.toEqual(terminalOutcome(request));
    expect(loopback.controller.diagnostics()).toEqual({
      activeExecutions: 0,
      taskHandles: 0,
      handleBindings: 0,
      nestedTaskHandles: 0,
    });
    await vi.waitFor(() => expect(loopback.target.diagnostics().running).toBe(0));
    expect(loopback.factory).toHaveBeenCalledTimes(1);
  });

  it('releases an unobserved nested handle when its parent reaches a terminal outcome', async () => {
    const request = createDelegatingRequest();
    const nested = createNestedHostHandle(request);
    const fixtures = createControl();
    const spawn = vi.fn(async () => nested);
    const control: SubAgentExecutionControl = Object.freeze({
      ...fixtures.control,
      delegation: Object.freeze({ ...fixtures.control.delegation, spawn }),
    });
    const loopback = createLoopback({
      resolveCatalog: () => createNestedCatalog(),
      run: async (_child, remoteControl) => {
        await remoteControl.delegation.spawn({
          requestId: 'nested-unobserved-spawn',
          subAgent: definition.name,
          executor: descriptor.name,
          input: { query: 'nested work' },
        });
        return terminalOutcome(request);
      },
    });

    await expect(loopback.controller.execute(request, control)).resolves.toEqual(
      terminalOutcome(request),
    );
    expect(spawn).toHaveBeenCalledOnce();
    expect(nested.wait).not.toHaveBeenCalled();
    expect(loopback.controller.diagnostics()).toEqual({
      activeExecutions: 0,
      taskHandles: 0,
      handleBindings: 0,
      nestedTaskHandles: 0,
    });
  });

  it('releases an unobserved nested handle after a spawned parent settles in the background', async () => {
    const request = createDelegatingRequest();
    const nested = createNestedHostHandle(request);
    const fixtures = createControl();
    const control: SubAgentExecutionControl = Object.freeze({
      ...fixtures.control,
      delegation: Object.freeze({
        ...fixtures.control.delegation,
        spawn: vi.fn(async () => nested),
      }),
    });
    const loopback = createLoopback({
      resolveCatalog: () => createNestedCatalog(),
      run: async (_child, remoteControl) => {
        await remoteControl.delegation.spawn({
          requestId: 'nested-unobserved-background-spawn',
          subAgent: definition.name,
          executor: descriptor.name,
          input: { query: 'nested background work' },
        });
        return terminalOutcome(request);
      },
    });

    const parent = await loopback.controller.spawn(request, control);
    if (!('taskId' in parent)) throw new Error('Expected a spawned parent handle.');
    await expect(parent.wait()).resolves.toEqual(terminalOutcome(request));
    await vi.waitFor(() =>
      expect(loopback.controller.diagnostics()).toEqual({
        activeExecutions: 0,
        taskHandles: 0,
        handleBindings: 0,
        nestedTaskHandles: 0,
      }),
    );
    expect(nested.wait).not.toHaveBeenCalled();
  });

  it('keeps a paused parent nested handle through approval resume, then evicts it on child wait', async () => {
    let currentNow = NOW;
    const request = createDelegatingRequest({
      limits: Object.freeze({ ...DEFAULT_SUBAGENT_LIMITS, timeoutMs: 60_000 }),
      deadlineAt: currentNow + 60_000,
    });
    const nested = createNestedHostHandle(request);
    const firstFixtures = createControl();
    const spawn = vi.fn(async () => nested);
    const firstControl: SubAgentExecutionControl = Object.freeze({
      ...firstFixtures.control,
      delegation: Object.freeze({ ...firstFixtures.control.delegation, spawn }),
    });
    let nestedTaskId: string | undefined;
    const approval = Object.freeze({
      approvalId: 'outer-approval-1',
      ownerSessionId: request.ownerSessionId,
      taskId: request.taskId,
      callId: 'outer-sensitive-call',
      toolName: 'outer-sensitive-tool',
      summary: 'Approve the outer child continuation.',
      createdAt: NOW,
      revision: 1,
    });
    const loopback = createLoopback({
      now: () => currentNow,
      resolveCatalog: () => createNestedCatalog(),
      run: async (child, remoteControl) => {
        if (child.attempt === 1) {
          const handle = await remoteControl.delegation.spawn({
            requestId: 'nested-before-approval',
            subAgent: definition.name,
            executor: descriptor.name,
            input: { query: 'continue after approval' },
          });
          nestedTaskId = handle.taskId;
          return Object.freeze({
            type: 'paused' as const,
            reason: 'approval' as const,
            task: Object.freeze({ taskId: child.taskId, subAgent: child.definition }),
            approvals: Object.freeze([approval]),
            checkpointRevision: 1,
          });
        }
        if (nestedTaskId === undefined) throw new Error('The nested task was not spawned.');
        const resumed = await remoteControl.delegation.resumeTool(nestedTaskId);
        await resumed.wait();
        return terminalOutcome(request);
      },
    });

    const paused = await loopback.controller.execute(request, firstControl);
    expect(paused).toMatchObject({ type: 'paused', reason: 'approval' });
    expect(loopback.controller.diagnostics()).toEqual({
      activeExecutions: 0,
      taskHandles: 0,
      handleBindings: 0,
      nestedTaskHandles: 1,
    });

    const resumeTool = vi.fn(async () => nested);
    const resumeFixtures = createControl();
    const resumeControl: SubAgentExecutionControl = Object.freeze({
      ...resumeFixtures.control,
      delegation: Object.freeze({ ...resumeFixtures.control.delegation, resumeTool }),
    });
    currentNow += 30_000;
    const resume = createDelegatingRequest({
      operation: Object.freeze({
        type: 'resume',
        operationId: 'outer-approval-resume-1',
        reason: 'approval',
        binding: createBinding(request),
        checkpoint: approvalCheckpoint(approval.approvalId),
        approvals: Object.freeze([
          Object.freeze({
            approvalId: approval.approvalId,
            decision: 'approved' as const,
            expectedRevision: approval.revision,
          }),
        ]),
      }),
      attempt: 2,
      executionEpoch: 'epoch-2',
      executionFencingToken: '2',
      delegation: Object.freeze({
        ...request.delegation,
        catalogRevision: request.delegation.catalogRevision + 1,
      }),
      limits: Object.freeze({ ...request.limits, timeoutMs: 50_000 }),
      deadlineAt: currentNow + 50_000,
    });

    await expect(loopback.controller.execute(resume, resumeControl)).resolves.toEqual(
      terminalOutcome(request),
    );
    expect(resumeTool).toHaveBeenCalledWith(nested.taskId);
    expect(nested.wait).toHaveBeenCalledOnce();
    expect(resume.deadlineAt).toBeGreaterThan(request.deadlineAt);
    expect(resume.delegation.catalogRevision).toBeGreaterThan(request.delegation.catalogRevision);
    expect(loopback.controller.diagnostics()).toEqual({
      activeExecutions: 0,
      taskHandles: 0,
      handleBindings: 0,
      nestedTaskHandles: 0,
    });
  });

  it('rejects resume timeout expansion and stale business scope before replacing a resident', async () => {
    const created = createRequest();
    const loopback = createLoopback({ run: async () => terminalOutcome(created) });
    await expect(loopback.controller.execute(created, createControl().control)).resolves.toEqual(
      terminalOutcome(created),
    );

    const invalidResumes = [
      createRequest({
        operation: {
          type: 'resume',
          operationId: 'resume-expanded-timeout',
          reason: 'checkpoint',
          binding: createBinding(created),
          checkpoint: childCheckpoint(),
        },
        attempt: 2,
        executionEpoch: 'epoch-expanded-timeout',
        executionFencingToken: '2',
        limits: Object.freeze({
          ...created.limits,
          timeoutMs: created.limits.timeoutMs + 1,
        }),
        deadlineAt: created.deadlineAt + 1,
      }),
      createRequest({
        operation: {
          type: 'resume',
          operationId: 'resume-stale-delegation-scope',
          reason: 'checkpoint',
          binding: createBinding(created),
          checkpoint: childCheckpoint(),
        },
        attempt: 2,
        executionEpoch: 'epoch-stale-delegation',
        executionFencingToken: '2',
        retryOf: 'different-retry-lineage',
        delegation: Object.freeze({
          ...created.delegation,
          catalogRevision: created.delegation.catalogRevision + 1,
        }),
      }),
    ];

    for (const resume of invalidResumes) {
      await expect(
        loopback.controller.execute(resume, createControl().control),
      ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    }
    expect(loopback.factory).toHaveBeenCalledOnce();
  });

  it('evicts process-local handle state when an accepted spawn loses its settlement channel', async () => {
    let releaseRunner!: () => void;
    const runnerBarrier = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const request = createRequest();
    const loopback = createLoopback({
      run: async () => {
        await runnerBarrier;
        return terminalOutcome(request);
      },
    });

    const handle = await loopback.controller.spawn(request, createControl().control);
    if (!('taskId' in handle)) throw new Error('Expected an accepted task handle.');
    expect(loopback.controller.diagnostics()).toMatchObject({
      activeExecutions: 1,
      taskHandles: 1,
      handleBindings: 1,
    });

    loopback.controllerPeer.close();
    releaseRunner();

    await vi.waitFor(() =>
      expect(loopback.controller.diagnostics()).toMatchObject({
        activeExecutions: 0,
        taskHandles: 0,
        handleBindings: 0,
      }),
    );
  });

  it('cancels by exact binding and does not expose a raw target handle on the wire', async () => {
    const request = createRequest();
    let postCancelCheckpointError: unknown;
    const loopback = createLoopback({
      run: async (childRequest, control) => {
        await new Promise<void>((resolve) => {
          childRequest.signal.addEventListener(
            'abort',
            () => {
              void (async () => {
                await control.reportProgress('cancel-observed', {
                  message: 'cancel-observed',
                });
                try {
                  await control.commitCheckpoint('checkpoint-after-cancel', childCheckpoint());
                } catch (error) {
                  postCancelCheckpointError = error;
                }
                resolve();
              })();
            },
            { once: true },
          );
        });
        return terminalOutcome(request, 'cancelled');
      },
    });
    const hostControl = createControl();
    const handle = await loopback.controller.spawn(request, hostControl.control);
    if (!('taskId' in handle)) throw new Error('Expected a task handle.');
    expect(JSON.parse(JSON.stringify(handle))).toEqual({
      taskId: request.taskId,
      binding: createBinding(request),
    });

    await handle.cancel('stop');
    await expect(handle.wait()).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'cancelled' },
    });
    expect(hostControl.reportProgress).toHaveBeenCalledWith('cancel-observed', {
      message: 'cancel-observed',
    });
    expect(postCancelCheckpointError).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(hostControl.commitCheckpoint).not.toHaveBeenCalled();
  });

  acceptanceIt('C7-GATEWAY-14.l1.target-session-scope', 'target-session-scope', async () => {
    const events = vi.fn(() => emptyEvents());
    const loopback = createLoopback({
      run: async (request) => terminalOutcome(request),
      events: () => events(),
    });
    const foreign = createRequest({
      operation: {
        type: 'create',
        operationId: 'foreign-create',
        idempotencyKey: 'foreign-request',
      },
      ownerSessionId: 'owner-session-2',
      runId: 'foreign-run',
      taskId: 'foreign-task',
      subagentSessionId: 'foreign-subagent-session',
      path: ['foreign-task'],
      delegation: {
        ...createRequest().delegation,
        ownerSessionId: 'owner-session-2',
        runId: 'foreign-run',
        parentTaskId: 'foreign-task',
        path: ['foreign-task'],
      },
    });
    const foreignBinding = createBinding(foreign);
    const envelopes: SubAgentTransportPeerHandlerRequest['envelope'][] = [
      createSubAgentTransportRpcEnvelope({
        channelId: 'owner-one-channel',
        sequence: 1,
        messageId: 'foreign-execute',
        taskId: foreign.taskId,
        operationId: foreign.operation.operationId,
        kind: 'executor.request',
        payload: {
          mode: 'execute',
          request: createSubAgentExecutionRequestWire(foreign, {
            now: () => NOW,
            expectedExecutorName: descriptor.name,
          }),
        },
      }) as SubAgentTransportPeerHandlerRequest['envelope'],
      createSubAgentTransportRpcEnvelope({
        channelId: 'owner-one-channel',
        sequence: 2,
        messageId: 'foreign-snapshot',
        taskId: foreign.taskId,
        operationId: 'foreign-snapshot-operation',
        kind: 'snapshot.request',
        payload: { mode: 'snapshot' },
      }) as SubAgentTransportPeerHandlerRequest['envelope'],
      createSubAgentTransportRpcEnvelope({
        channelId: 'owner-one-channel',
        sequence: 3,
        messageId: 'foreign-wait',
        taskId: foreign.taskId,
        operationId: 'foreign-wait-operation',
        kind: 'snapshot.request',
        payload: { mode: 'wait' },
      }) as SubAgentTransportPeerHandlerRequest['envelope'],
      createSubAgentTransportRpcEnvelope({
        channelId: 'owner-one-channel',
        sequence: 4,
        messageId: 'foreign-events',
        taskId: foreign.taskId,
        operationId: 'foreign-events-operation',
        kind: 'events.request',
        payload: { afterSequence: 0, limit: 1 },
      }) as SubAgentTransportPeerHandlerRequest['envelope'],
      createSubAgentTransportRpcEnvelope({
        channelId: 'owner-one-channel',
        sequence: 5,
        messageId: 'foreign-cancel',
        taskId: foreign.taskId,
        operationId: 'foreign-cancel-operation',
        kind: 'cancel.request',
        payload: { binding: foreignBinding, reason: 'guess another owner task' },
      }) as SubAgentTransportPeerHandlerRequest['envelope'],
    ];

    for (const envelope of envelopes) {
      await expect(invokeTarget(loopback.target, envelope)).resolves.toEqual([
        {
          kind: 'protocol.error',
          payload: {
            error: expect.objectContaining({ code: 'RESOURCE_NOT_FOUND', retryable: false }),
          },
        },
      ]);
    }
    expect(loopback.factory).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(loopback.target.diagnostics()).toMatchObject({ tasks: 0, operations: 0 });
  });

  acceptanceIt('C7-GATEWAY-15.l1.bridge-lifecycle', 'bridge-lifecycle-bounds', async () => {
    let currentNow = NOW;
    const initialDeadlineAt = NOW + 100_000;
    const request = createRequest({ deadlineAt: initialDeadlineAt });
    const loopback = createLoopback({
      run: async () => terminalOutcome(request),
      now: () => currentNow,
      maxRetainedTasks: 1,
      maxRetainedOperations: 1,
    });

    await expect(
      loopback.controller.execute(request, createControl().control),
    ).resolves.toMatchObject({
      type: 'terminal',
    });
    currentNow += 1_000;
    await expect(
      loopback.controller.execute(request, createControl().control),
    ).resolves.toMatchObject({
      type: 'terminal',
    });
    expect(loopback.factory).toHaveBeenCalledTimes(1);

    await expect(
      loopback.controller.execute(
        createRequest({ deadlineAt: initialDeadlineAt + 2_000 }),
        createControl().control,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(loopback.factory).toHaveBeenCalledTimes(1);

    await expect(
      loopback.controller.execute(
        createRequest({ input: { query: 'different' }, deadlineAt: initialDeadlineAt }),
        createControl().control,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(loopback.factory).toHaveBeenCalledTimes(1);

    const second = createRequest({
      operation: {
        type: 'create',
        operationId: 'create-2',
        idempotencyKey: 'request-2',
      },
      taskId: 'task-2',
      subagentSessionId: 'subagent-session-2',
      path: ['task-2'],
      delegation: {
        ...request.delegation,
        parentTaskId: 'task-2',
        path: ['task-2'],
      },
      deadlineAt: initialDeadlineAt,
    });
    await expect(
      loopback.controller.execute(second, createControl().control),
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      descriptor: { causeCode: 'TARGET_RECEIPT_CAPACITY_EXHAUSTED', retryable: false },
    });
    expect(loopback.factory).toHaveBeenCalledTimes(1);
    expect(loopback.target.diagnostics()).toMatchObject({
      disposed: false,
      tasks: 1,
      operations: 1,
      running: 0,
      taskCapacity: 1,
      operationCapacity: 1,
    });

    await Promise.all([loopback.target.dispose(), loopback.target.dispose()]);
    expect(loopback.target.diagnostics()).toEqual({
      disposed: true,
      tasks: 0,
      operations: 0,
      starting: 0,
      running: 0,
      taskCapacity: 1,
      operationCapacity: 1,
    });
    await expect(
      loopback.controller.execute(request, createControl().control),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(loopback.factory).toHaveBeenCalledTimes(1);
  });

  it('waits for an aborted live runner before disposal releases retained receipts', async () => {
    let markAborted!: () => void;
    let releaseCleanup!: () => void;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const request = createRequest();
    const loopback = createLoopback({
      run: async (childRequest) => {
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            markAborted();
            resolve();
          };
          if (childRequest.signal.aborted) onAbort();
          else childRequest.signal.addEventListener('abort', onAbort, { once: true });
        });
        await cleanup;
        return terminalOutcome(request, 'cancelled');
      },
    });
    const handle = await loopback.controller.spawn(request, createControl().control);
    if (!('taskId' in handle)) throw new Error('Expected a task handle.');

    let disposalSettled = false;
    const disposal = loopback.target.dispose().then(() => {
      disposalSettled = true;
    });
    await aborted;
    expect(disposalSettled).toBe(false);
    expect(loopback.target.diagnostics()).toMatchObject({
      disposed: true,
      tasks: 1,
      operations: 1,
      running: 1,
    });

    releaseCleanup();
    await disposal;
    expect(loopback.target.diagnostics()).toMatchObject({
      disposed: true,
      tasks: 0,
      operations: 0,
      running: 0,
    });
    await vi.waitFor(() =>
      expect(loopback.controller.diagnostics()).toEqual({
        activeExecutions: 0,
        taskHandles: 0,
        handleBindings: 0,
        nestedTaskHandles: 0,
      }),
    );
  });

  it('reconnects a settled resident read-only and advances its fencing lineage', async () => {
    const created = createRequest();
    const loopback = createLoopback({ run: async () => terminalOutcome(created) });
    await expect(loopback.controller.execute(created, createControl().control)).resolves.toEqual(
      terminalOutcome(created),
    );
    const reconnect = createRequest({
      operation: {
        type: 'reconnect',
        operationId: 'reconnect-1',
        binding: createBinding(created),
      },
      attempt: 2,
      executionEpoch: 'epoch-2',
      executionFencingToken: '2',
    });

    await expect(loopback.controller.execute(reconnect, createControl().control)).resolves.toEqual(
      terminalOutcome(created),
    );
    expect(loopback.factory).toHaveBeenCalledTimes(1);

    await expect(
      loopback.controller.execute(
        createRequest({
          ...reconnect,
          operation: {
            type: 'reconnect',
            operationId: 'reconnect-stale',
            binding: createBinding(created),
          },
        }),
        createControl().control,
      ),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(loopback.factory).toHaveBeenCalledTimes(1);
  });

  it('fails closed instead of rebinding a live runner to a new execution epoch', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created = createRequest();
    const loopback = createLoopback({
      run: async () => {
        await barrier;
        return terminalOutcome(created);
      },
    });
    const handle = await loopback.controller.spawn(created, createControl().control);
    if (!('taskId' in handle)) throw new Error('Expected a task handle.');
    const reconnect = createRequest({
      operation: {
        type: 'reconnect',
        operationId: 'live-reconnect-1',
        binding: createBinding(created),
      },
      attempt: 2,
      executionEpoch: 'epoch-2',
      executionFencingToken: '2',
    });
    const replies: Array<{ readonly kind: string; readonly payload: unknown }> = [];
    const envelope = createSubAgentTransportRpcEnvelope({
      channelId: 'direct-live-reconnect',
      sequence: 1,
      messageId: 'direct-live-reconnect-request',
      taskId: created.taskId,
      operationId: reconnect.operation.operationId,
      kind: 'executor.request',
      payload: {
        mode: 'execute',
        request: createSubAgentExecutionRequestWire(reconnect, {
          now: () => NOW,
          expectedExecutorName: descriptor.name,
        }),
      },
    });

    await loopback.target.handler({
      channelId: envelope.channelId,
      envelope: envelope as Extract<typeof envelope, { readonly kind: 'executor.request' }>,
      sidecars: [],
      receivedAt: NOW,
      reply: async (reply) => {
        replies.push(reply);
      },
    });
    expect(replies).toEqual([
      {
        kind: 'protocol.error',
        payload: {
          error: expect.objectContaining({
            code: 'RECOVERY_UNSUPPORTED',
            retryable: false,
          }),
        },
      },
    ]);
    expect(loopback.factory).toHaveBeenCalledTimes(1);

    release();
    await expect(handle.wait()).resolves.toEqual(terminalOutcome(created));
  });

  it('uses a distinct control signal to abort the controller-side execution exchange', async () => {
    const requestAbort = new AbortController();
    const controlAbort = new AbortController();
    let markStarted!: () => void;
    let markTargetAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const targetAborted = new Promise<void>((resolve) => {
      markTargetAborted = resolve;
    });
    const request = createRequest({ signal: requestAbort.signal });
    const loopback = createLoopback({
      run: async (childRequest) => {
        markStarted();
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            markTargetAborted();
            resolve();
          };
          if (childRequest.signal.aborted) onAbort();
          else childRequest.signal.addEventListener('abort', onAbort, { once: true });
        });
        return terminalOutcome(request, 'cancelled');
      },
    });
    const fixtures = createControl();
    const control: SubAgentExecutionControl = {
      ...fixtures.control,
      signal: controlAbort.signal,
    };

    const execution = loopback.controller.execute(request, control);
    await started;
    controlAbort.abort(new Error('distinct control scope cancelled'));

    await expect(execution).rejects.toMatchObject({
      reason: 'aborted',
      descriptor: { code: 'CANCELLED', causeCode: 'TRANSPORT_REQUEST_ABORTED' },
    });
    expect(requestAbort.signal.aborted).toBe(false);
    expect(loopback.controller.diagnostics()).toMatchObject({ activeExecutions: 0 });

    await loopback.target.dispose();
    await targetAborted;
  });

  it('serializes the earliest control deadline into the target execution scope', async () => {
    const request = createRequest({ deadlineAt: NOW + 120_000 });
    const fixtures = createControl();
    const control: SubAgentExecutionControl = {
      ...fixtures.control,
      deadlineAt: NOW + 40_000,
    };
    const run = vi.fn(
      async (childRequest: SubAgentChildRunRequest, childControl: SubAgentExecutionControl) => {
        expect(childRequest.deadlineAt).toBe(NOW + 40_000);
        expect(childControl.deadlineAt).toBe(NOW + 40_000);
        return terminalOutcome(childRequest);
      },
    );
    const loopback = createLoopback({ run });

    await expect(loopback.controller.execute(request, control)).resolves.toEqual(
      terminalOutcome(request),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  acceptanceIt(
    'C7-GATEWAY-18.l1.host-model-scope',
    'host-model-cancel-deadline-scope',
    async () => {
      const hostOne = new AbortController();
      const hostTwo = new AbortController();
      let markOneStarted!: () => void;
      let markTwoStarted!: () => void;
      let markOneAborted!: () => void;
      let releaseTwo!: () => void;
      const oneStarted = new Promise<void>((resolve) => {
        markOneStarted = resolve;
      });
      const twoStarted = new Promise<void>((resolve) => {
        markTwoStarted = resolve;
      });
      const oneAborted = new Promise<void>((resolve) => {
        markOneAborted = resolve;
      });
      const twoRelease = new Promise<void>((resolve) => {
        releaseTwo = resolve;
      });
      const contexts = new Map<string, SubAgentTransportModelRequestContext>();
      const model = vi.fn(async (context: SubAgentTransportModelRequestContext) => {
        contexts.set(context.taskId, context);
        if (context.taskId === 'task-1') {
          markOneStarted();
          await new Promise<void>((resolve) => {
            const onAbort = (): void => {
              markOneAborted();
              resolve();
            };
            if (context.signal.aborted) onAbort();
            else context.signal.addEventListener('abort', onAbort, { once: true });
          });
          throw context.signal.reason;
        }
        markTwoStarted();
        await twoRelease;
        return modelReply(context.payload);
      });
      const loopback: ReturnType<typeof createLoopback> = createLoopback({
        model,
        run: async (request) => {
          const payload = modelPayload(request, `provider-${request.taskId}`);
          try {
            await loopback.target.modelExchange({
              taskId: request.taskId,
              operationId: payload.providerOperationId,
              payload,
              signal: request.signal,
              timeoutMs: 120_000,
            });
            return terminalOutcome(request);
          } catch {
            return terminalOutcome(request, 'cancelled');
          }
        },
      });
      const requestOne = createRequest({ signal: hostOne.signal });
      const requestTwo = createRequest({
        operation: {
          type: 'create',
          operationId: 'create-2',
          idempotencyKey: 'request-2',
        },
        taskId: 'task-2',
        subagentSessionId: 'subagent-session-2',
        path: ['task-2'],
        signal: hostTwo.signal,
        delegation: {
          ...createRequest().delegation,
          parentTaskId: 'task-2',
          path: ['task-2'],
        },
      });
      const fixturesOne = createControl();
      const fixturesTwo = createControl();
      const controlOne: SubAgentExecutionControl = {
        ...fixturesOne.control,
        signal: hostOne.signal,
        deadlineAt: NOW + 40_000,
      };
      const controlTwo: SubAgentExecutionControl = {
        ...fixturesTwo.control,
        signal: hostTwo.signal,
      };

      const executionOne = loopback.controller.execute(requestOne, controlOne);
      const executionTwo = loopback.controller.execute(requestTwo, controlTwo);
      await Promise.all([oneStarted, twoStarted]);

      const contextOne = contexts.get('task-1');
      const contextTwo = contexts.get('task-2');
      expect(contextOne).toBeDefined();
      expect(contextTwo).toBeDefined();
      expect(contextOne?.deadlineAt).toBe(NOW + 40_000);
      expect(
        Math.min(
          contextOne?.deadlineAt ?? Number.MAX_SAFE_INTEGER,
          (contextOne?.receivedAt ?? 0) + (contextOne?.payload.remainingMs ?? 0),
        ),
      ).toBe(NOW + 40_000);

      hostOne.abort(new Error('host-one-stop'));
      await oneAborted;
      await executionOne.catch(() => undefined);
      expect(contextOne?.signal.aborted).toBe(true);
      expect(contextTwo?.signal.aborted).toBe(false);

      const stalePayload = modelPayload(requestOne, 'provider-task-1-stale');
      await expect(
        loopback.target.modelExchange({
          taskId: requestOne.taskId,
          operationId: stalePayload.providerOperationId,
          payload: stalePayload,
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({
        code: 'EXECUTOR_FAILED',
        descriptor: {
          causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        },
      });
      expect(model).toHaveBeenCalledTimes(2);
      expect(contextTwo?.signal.aborted).toBe(false);

      releaseTwo();
      await expect(executionTwo).resolves.toEqual(terminalOutcome(requestTwo));
    },
  );

  acceptanceIt(
    'C7-GATEWAY-19.l1.control-execution-scope',
    'stale-control-execution-scope',
    async () => {
      let staleControl!: SubAgentExecutionControl;
      let markRecoveredStarted!: () => void;
      let releaseRecovered!: () => void;
      const recoveredStarted = new Promise<void>((resolve) => {
        markRecoveredStarted = resolve;
      });
      const recoveredRelease = new Promise<void>((resolve) => {
        releaseRecovered = resolve;
      });
      const created = createRequest();
      const recovered = createRequest({
        operation: {
          type: 'resume',
          operationId: 'resume-2',
          reason: 'checkpoint',
          binding: createBinding(created),
          checkpoint: childCheckpoint(),
        },
        attempt: 2,
        executionEpoch: 'epoch-2',
        executionFencingToken: '2',
      });
      const loopback = createLoopback({
        run: async (request, control) => {
          if (request.attempt === 1) {
            staleControl = control;
            throw new Error('simulated recoverable target failure');
          }
          markRecoveredStarted();
          await recoveredRelease;
          return terminalOutcome(recovered);
        },
      });

      await expect(
        loopback.controller.execute(created, createControl().control),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      const recoveredFixtures = createControl();
      const recoveredExecution = loopback.controller.execute(recovered, recoveredFixtures.control);
      await recoveredStarted;

      const staleCalls = await Promise.allSettled([
        staleControl.commitCheckpoint('stale-checkpoint', childCheckpoint()),
        staleControl.completion.submitResult('stale-result', { answer: 'stale' }),
        staleControl.consumeBudget('stale-budget', { turns: 1, providerCalls: 1 }),
      ]);
      expect(staleCalls).toHaveLength(3);
      for (const result of staleCalls) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
        }
      }
      expect(recoveredFixtures.commitCheckpoint).not.toHaveBeenCalled();
      expect(recoveredFixtures.submitResult).not.toHaveBeenCalled();
      expect(recoveredFixtures.consumeBudget).not.toHaveBeenCalled();

      releaseRecovered();
      await expect(recoveredExecution).resolves.toEqual(terminalOutcome(recovered));
    },
  );

  it('projects factory failures to a closed safe error without leaking the raw message', async () => {
    const factory = vi.fn(() => {
      throw new Error('secret target module path');
    });
    const loopback = createLoopback({
      factory,
      run: async () => terminalOutcome(createRequest()),
    });

    let failure: unknown;
    try {
      await loopback.controller.execute(createRequest(), createControl().control);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SubAgentRuntimeError);
    expect((failure as SubAgentRuntimeError).descriptor).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'The remote transport operation failed.',
      retryable: false,
      causeCode: 'REMOTE_BRIDGE_FAILED',
    });
    expect(String(failure)).not.toContain('secret target module path');
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
