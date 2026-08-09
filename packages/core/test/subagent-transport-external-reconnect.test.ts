import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createSubAgentTransportExecutorBridge,
  createSubAgentTransportTargetBridge,
  type CreateSubAgentTransportTargetBridgeOptions,
  type SubAgentTransportModelRequestContext,
  type SubAgentTransportModelRequestHandler,
  type SubAgentTransportTargetCheckpointCommitContext,
} from '../src/subagent/transport-bridge';
import type { SubAgentChildCheckpoint } from '../src/subagent/checkpoint';
import type { SubAgentChildRunRequest, SubAgentChildRunner } from '../src/subagent/child-runner';
import type { SubAgentExecutorDescriptor } from '../src/subagent/catalog';
import { defineSubAgent } from '../src/subagent/definition';
import type {
  SubAgentExecutionControl,
  SubAgentExecutionRequest,
  SubAgentExecutorBinding,
} from '../src/subagent/executor';
import { canonicalJsonSha256, type JsonValue } from '../src/subagent/json';
import { DEFAULT_SUBAGENT_LIMITS } from '../src/subagent/limits';
import { createSubAgentExecutionRequestWire } from '../src/subagent/transport-codec';
import {
  SubAgentTransportPeer,
  createSubAgentTransportPeerWriterAdmission,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportPeerWriterAdmission,
} from '../src/subagent/transport-peer';
import {
  hashSubAgentTransportModelRequest,
  type SubAgentTransportModelExchange,
} from '../src/subagent/transport-model-gateway';
import type { SubAgentTransportRpcPayloadMap } from '../src/subagent/transport-rpc';
import { SubAgentTargetRunnerRegistry } from '../src/subagent/target-runner-registry';
import type { SubAgentExecutionOutcome } from '../src/subagent/result';
import type { SubAgentTaskEvent } from '../src/subagent/telemetry';

const NOW = 1_000;

const definition = defineSubAgent({
  name: 'external-reviewer',
  version: '2',
  description: 'Review one query through an external placement.',
  inputSchema: z.object({ query: z.string().trim().min(1) }),
  outputSchema: z.object({ answer: z.string() }),
});

const descriptor: SubAgentExecutorDescriptor = Object.freeze({
  runtimeProtocolVersion: '1',
  taskRecordVersions: Object.freeze(['1']),
  childCheckpointVersions: Object.freeze(['1']),
  runnerCompatibility: Object.freeze([
    Object.freeze({
      runnerId: 'external-runner',
      runnerVersion: '1',
      childCheckpointVersions: Object.freeze(['1']),
    }),
  ]),
  name: 'http',
  description: 'External reconnect loopback placement.',
  useCases: Object.freeze(['Tests']),
  capabilities: Object.freeze({
    execute: true,
    spawn: true,
    cancel: true,
    events: true,
    approval: true,
    usage: 'provider',
    recovery: Object.freeze({ resume: 'checkpoint', reconnect: 'external_binding' }),
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
      throw new TypeError('Invalid external binding state.');
    }
    const record = value as { readonly [key: string]: JsonValue };
    if (typeof record.jobId !== 'string') throw new TypeError('Invalid external binding state.');
    return Object.freeze({ jobId: record.jobId });
  },
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRequest(
  overrides: Partial<SubAgentExecutionRequest> = {},
): SubAgentExecutionRequest {
  return Object.freeze({
    operation: Object.freeze({
      type: 'create' as const,
      operationId: 'create-1',
      idempotencyKey: 'request-1',
    }),
    ownerSessionId: 'owner-session-1',
    runId: 'run-1',
    taskId: 'task-1',
    subagentSessionId: 'subagent-session-1',
    path: Object.freeze(['task-1']),
    attempt: 1,
    executionEpoch: 'epoch-1',
    executionFencingToken: '1',
    definition: Object.freeze({ name: definition.name, version: definition.version }),
    input: Object.freeze({ query: 'hello' }),
    projectedContext: Object.freeze([]),
    delegation: Object.freeze({
      version: '1' as const,
      ownerSessionId: 'owner-session-1',
      runId: 'run-1',
      parentTaskId: 'task-1',
      path: Object.freeze(['task-1']),
      depth: 1,
      catalogRevision: 1,
      definitions: Object.freeze([]),
    }),
    limits: DEFAULT_SUBAGENT_LIMITS,
    signal: new AbortController().signal,
    deadlineAt: NOW + 120_000,
    ...overrides,
  });
}

function createReconnectRequest(
  created: SubAgentExecutionRequest,
  binding: SubAgentExecutorBinding,
  operationId = 'reconnect-2',
  overrides: Readonly<{
    attempt?: number;
    executionEpoch?: string;
    executionFencingToken?: string;
    signal?: AbortSignal;
    deadlineAt?: number;
  }> = {},
): SubAgentExecutionRequest {
  return createRequest({
    ...created,
    operation: Object.freeze({
      type: 'reconnect' as const,
      operationId,
      binding,
    }),
    attempt: overrides.attempt ?? 2,
    executionEpoch: overrides.executionEpoch ?? 'epoch-2',
    executionFencingToken: overrides.executionFencingToken ?? '2',
    signal: overrides.signal ?? new AbortController().signal,
    ...(overrides.deadlineAt === undefined ? {} : { deadlineAt: overrides.deadlineAt }),
  });
}

function createResumeRequest(
  created: SubAgentExecutionRequest,
  binding: SubAgentExecutorBinding,
  operationId: string,
  checkpoint: SubAgentChildCheckpoint,
  overrides: Readonly<{
    attempt?: number;
    executionEpoch?: string;
    executionFencingToken?: string;
  }> = {},
): SubAgentExecutionRequest {
  return createRequest({
    ...created,
    operation: Object.freeze({
      type: 'resume' as const,
      operationId,
      reason: 'checkpoint' as const,
      binding,
      checkpoint,
    }),
    attempt: overrides.attempt ?? 2,
    executionEpoch: overrides.executionEpoch ?? 'epoch-2',
    executionFencingToken: overrides.executionFencingToken ?? '2',
    signal: new AbortController().signal,
  });
}

function createApprovalResumeRequest(
  created: SubAgentExecutionRequest,
  binding: SubAgentExecutorBinding,
  operationId: string,
  checkpoint: SubAgentChildCheckpoint,
): SubAgentExecutionRequest {
  return createRequest({
    ...created,
    operation: Object.freeze({
      type: 'resume' as const,
      operationId,
      reason: 'approval' as const,
      binding,
      checkpoint,
      approvals: Object.freeze([
        Object.freeze({
          approvalId: 'approval-resume-1',
          decision: 'approved' as const,
          expectedRevision: 1,
        }),
      ]),
    }),
    attempt: 2,
    executionEpoch: 'epoch-2',
    executionFencingToken: '2',
    signal: new AbortController().signal,
  });
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
    runnerId: 'external-runner',
    runnerVersion: '1',
    adapterStateVersion: bindingCodec.adapterStateVersion,
    modelBinding: Object.freeze({
      gatewayId: 'controller-model',
      protocol: 'openai-chat',
      codecVersion: '1',
    }),
    recoveryData: Object.freeze({ jobId: `job-${request.taskId}` }),
  });
}

function childCheckpoint(
  overrides: Partial<SubAgentChildCheckpoint> = {},
): SubAgentChildCheckpoint {
  return Object.freeze({
    version: '1',
    runnerId: 'external-runner',
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
    ...overrides,
  });
}

function approvalCheckpoint(approvalId = 'approval-resume-1'): SubAgentChildCheckpoint {
  const checkpoint = childCheckpoint();
  const input = Object.freeze({});
  return Object.freeze({
    ...checkpoint,
    pendingBatch: Object.freeze({
      version: '1' as const,
      batchId: 'approval-resume-batch-1',
      assistantMessage: Object.freeze({
        protocol: 'openai-chat',
        codecVersion: '1',
        value: Object.freeze([]),
      }),
      calls: Object.freeze([
        Object.freeze({
          version: '1' as const,
          operationId: 'approval-resume-operation-1',
          kind: 'tool' as const,
          callId: 'approval-call-1',
          name: 'write-report',
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

function terminalOutcome(
  request: Pick<SubAgentChildRunRequest | SubAgentExecutionRequest, 'taskId' | 'definition'>,
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

function modelPayload(
  request: SubAgentChildRunRequest | SubAgentExecutionRequest,
  operationId: string,
): SubAgentTransportRpcPayloadMap['model.request'] {
  const checkpointOperationId = `checkpoint-${request.taskId}`;
  const checkpointDigest = 'c'.repeat(64);
  const context = Object.freeze([]);
  const tools = Object.freeze([]);
  const canonical = Object.freeze({
    gatewayId: 'controller-model',
    protocol: 'openai-chat',
    codecVersion: '1',
    runId: request.runId,
    checkpointOperationId,
    checkpointDigest,
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

function modelFailureReply(
  payload: SubAgentTransportRpcPayloadMap['model.request'],
  outcomeUnknown = false,
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
    ok: false,
    error: Object.freeze({
      code: 'EXECUTOR_FAILED',
      message: outcomeUnknown
        ? 'The authoritative Model outcome is unknown.'
        : 'The authoritative Model request failed.',
      retryable: false,
      ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
    }),
  });
}

function taskEvent(request: SubAgentExecutionRequest, sequence: number): SubAgentTaskEvent {
  return Object.freeze({
    eventId: `event-${request.attempt}-${sequence}`,
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

interface HostControlOptions {
  readonly commitCheckpoint?: (
    operationId: string,
    checkpoint: SubAgentChildCheckpoint,
  ) => Promise<void>;
  readonly authorizeTool?: SubAgentExecutionControl['authorizeTool'];
}

function createHostControl(options: HostControlOptions = {}) {
  const commitBinding = vi.fn(async () => undefined);
  const commitCheckpoint = vi.fn(options.commitCheckpoint ?? (async () => undefined));
  const reportProgress = vi.fn(async () => undefined);
  const consumeBudget = vi.fn(async () => undefined);
  const authorizeTool = vi.fn(
    options.authorizeTool ??
      (async () => {
        throw new Error('not used');
      }),
  );
  const pauseDelegation = vi.fn(async () => {
    throw new Error('not used');
  });
  const emit = vi.fn(async () => undefined);
  const submitResult = vi.fn(async () =>
    Object.freeze({
      schemaVersion: '1' as const,
      receiptId: 'result-receipt-1',
      taskId: 'task-1',
      callId: 'result-call-1',
      revision: 2,
      outputHash: 'a'.repeat(64),
      submittedAt: NOW,
      status: 'accepted' as const,
    }),
  );
  const complete = vi.fn(async () =>
    Object.freeze({
      schemaVersion: '1' as const,
      receiptId: 'completion-receipt-1',
      taskId: 'task-1',
      callId: 'end-call-1',
      revision: 3,
      completedAt: NOW,
      status: 'completed' as const,
    }),
  );
  const fail = vi.fn(async () => {
    throw new Error('not used');
  });
  const control: SubAgentExecutionControl = Object.freeze({
    signal: new AbortController().signal,
    deadlineAt: NOW + 120_000,
    delegation: Object.freeze({
      getCatalog: () => Object.freeze({ revision: 1, capturedAt: NOW, executors: [] }),
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
    }),
    completion: Object.freeze({ submitResult, complete, fail }),
    commitBinding,
    commitCheckpoint,
    authorizeTool,
    pauseDelegation,
    reportProgress,
    consumeBudget,
    emit,
  });
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

interface HarnessOptions {
  readonly runners: readonly SubAgentChildRunner[];
  readonly createRunner?: (
    context: Readonly<{ readonly request: SubAgentChildRunRequest }>,
    factoryIndex: number,
  ) => SubAgentChildRunner | Promise<SubAgentChildRunner>;
  readonly externalReconnect?: boolean;
  readonly checkpointCommitted?: (
    context: SubAgentTransportTargetCheckpointCommitContext,
  ) => void | Promise<void>;
  readonly events?: CreateSubAgentTransportTargetBridgeOptions['events'];
  readonly validateBinding?: CreateSubAgentTransportTargetBridgeOptions['validateBinding'];
  readonly resolveTargetPeer?: (
    context: Readonly<{ readonly channelId: string; readonly peer: SubAgentTransportPeer }>,
  ) => void;
  readonly now?: () => number;
  readonly targetNow?: () => number;
}

type HarnessPacketInterceptor = (
  packet: SubAgentTransportPeerPacket,
  deliver: (replacement?: SubAgentTransportPeerPacket) => SubAgentTransportPeerWriterAdmission,
) => SubAgentTransportPeerWriterAdmission;

interface HarnessConnectionOptions {
  readonly model?: SubAgentTransportModelRequestHandler;
  readonly controllerToTarget?: HarnessPacketInterceptor;
  readonly targetToController?: HarnessPacketInterceptor;
}

function createHarness(options: HarnessOptions) {
  const factoryRequests: SubAgentChildRunRequest[] = [];
  const factory = vi.fn(async (context: { readonly request: SubAgentChildRunRequest }) => {
    factoryRequests.push(context.request);
    const factoryIndex = factoryRequests.length - 1;
    if (options.createRunner !== undefined) {
      return options.createRunner(context, factoryIndex);
    }
    const runner = options.runners[factoryIndex];
    if (runner === undefined) throw new Error('Unexpected fresh target runner factory call.');
    return runner;
  });
  const registry = new SubAgentTargetRunnerRegistry()
    .register({
      definition,
      runnerId: 'external-runner',
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
  const targetCreateBinding = vi.fn(
    async ({ request }: { readonly request: SubAgentExecutionRequest }) => createBinding(request),
  );
  const now = options.now ?? (() => NOW);
  const targetPeers = new Map<string, SubAgentTransportPeer>();
  const target = createSubAgentTransportTargetBridge({
    ownerSessionId: 'owner-session-1',
    executorName: descriptor.name,
    registry,
    bindingCodec,
    peer: (channelId) => {
      const peer = targetPeers.get(channelId);
      if (peer === undefined) {
        throw new Error(`No target loopback peer is registered for channel ${channelId}.`);
      }
      options.resolveTargetPeer?.(Object.freeze({ channelId, peer }));
      return peer;
    },
    createBinding: targetCreateBinding,
    ...(options.validateBinding === undefined ? {} : { validateBinding: options.validateBinding }),
    now: options.targetNow ?? now,
    createOperationId: ({ kind, sequence }) => `target-${kind}-${sequence}`,
    ...(options.events === undefined ? {} : { events: options.events }),
    ...(options.externalReconnect === true
      ? {
          reconnect: 'external_binding' as const,
          checkpointCommitted: options.checkpointCommitted ?? (() => Promise.resolve(undefined)),
        }
      : {}),
  });
  const peers: SubAgentTransportPeer[] = [];
  let connectionSequence = 1;

  const connect = (
    modelOrOptions?: SubAgentTransportModelRequestHandler | HarnessConnectionOptions,
  ) => {
    const connectionOptions: HarnessConnectionOptions =
      typeof modelOrOptions === 'function' ? { model: modelOrOptions } : (modelOrOptions ?? {});
    const connectionId = connectionSequence++;
    const channelId = `external-reconnect-${connectionId}`;
    const pair: { controller?: SubAgentTransportPeer; target?: SubAgentTransportPeer } = {};
    const requirePeer = (side: 'controller' | 'target'): SubAgentTransportPeer => {
      const peer = pair[side];
      if (peer === undefined) throw new Error(`The ${side} loopback peer is not ready.`);
      return peer;
    };
    const controller = createSubAgentTransportExecutorBridge({
      descriptor,
      bindingCodec,
      peer: () => requirePeer('controller'),
      getAvailability: () => ({ status: 'available', supportedDefinitions: registry.list() }),
      supports: (candidate) => registry.has(candidate),
      now,
      createOperationId: ({ kind, sequence }) => `controller-${connectionId}-${kind}-${sequence}`,
      ...(connectionOptions.model === undefined ? {} : { model: connectionOptions.model }),
    });
    const deliver = (
      receiver: () => SubAgentTransportPeer,
      packet: SubAgentTransportPeerPacket,
    ) => {
      const settled = Promise.resolve().then(() => receiver().receive(packet));
      return createSubAgentTransportPeerWriterAdmission(settled);
    };
    const controllerPeer = new SubAgentTransportPeer({
      channelId,
      now,
      writer: (packet) =>
        connectionOptions.controllerToTarget?.(packet, (replacement = packet) =>
          deliver(() => requirePeer('target'), replacement),
        ) ?? deliver(() => requirePeer('target'), packet),
      handler: controller.handler,
      createMessageId: messageIds(`controller-${connectionId}`),
    });
    pair.controller = controllerPeer;
    const targetPeer = new SubAgentTransportPeer({
      channelId,
      now,
      writer: (packet) =>
        connectionOptions.targetToController?.(packet, (replacement = packet) =>
          deliver(() => requirePeer('controller'), replacement),
        ) ?? deliver(() => requirePeer('controller'), packet),
      handler: target.handler,
      createMessageId: messageIds(`target-${connectionId}`),
    });
    pair.target = targetPeer;
    targetPeers.set(channelId, targetPeer);
    peers.push(controllerPeer, targetPeer);
    return {
      controller,
      controllerPeer,
      targetPeer,
      channelId,
    };
  };

  return {
    target,
    factory,
    factoryRequests,
    targetCreateBinding,
    connect,
    unregisterTargetPeer: (channelId: string): void => {
      targetPeers.delete(channelId);
    },
    dispose: async () => {
      await target.dispose();
      for (const peer of peers) peer.close();
    },
    forceDispose: async () => {
      for (const peer of peers) peer.close();
      await target.dispose();
    },
  };
}

function messageIds(prefix: string): () => string {
  let sequence = 1;
  return () => `${prefix}-${sequence++}`;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

function packetEnvelope(packet: SubAgentTransportPeerPacket): Readonly<{
  kind?: unknown;
  operationId?: unknown;
  payload?: unknown;
}> {
  const text =
    typeof packet.frame === 'string' ? packet.frame : new TextDecoder().decode(packet.frame);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Expected a transport object frame.');
  }
  return parsed;
}

function rewriteControlReplyMethod(
  packet: SubAgentTransportPeerPacket,
  method: string,
): SubAgentTransportPeerPacket {
  const envelope = packetEnvelope(packet);
  const payload = envelope.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new TypeError('Expected a control reply object payload.');
  }
  return Object.freeze({
    frame: JSON.stringify({ ...envelope, payload: { ...payload, method } }),
    sidecars: packet.sidecars,
  });
}

function delayedAdmission(
  delayMs: number,
  deliver: () => SubAgentTransportPeerWriterAdmission,
  delivered?: Deferred<void>,
): SubAgentTransportPeerWriterAdmission {
  const settled = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      try {
        const admission = deliver();
        Promise.resolve(admission.settled).then(() => {
          delivered?.resolve();
          resolve();
        }, reject);
      } catch (error) {
        reject(error);
      }
    }, delayMs);
  });
  return createSubAgentTransportPeerWriterAdmission(settled);
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function expectPending<T>(promise: Promise<T>, label: string, delayMs = 25): Promise<void> {
  const state = await Promise.race([
    promise.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), delayMs)),
  ]);
  expect(state, label).toBe('pending');
}

describe('Subagent transport external reconnect prerequisite', () => {
  it('rejects a scalar Peer when external reconnect requires trusted channel resolution', () => {
    const scalarPeer = new SubAgentTransportPeer({
      channelId: 'external-scalar-peer',
      writer: () => createSubAgentTransportPeerWriterAdmission(),
      createMessageId: messageIds('external-scalar-peer'),
    });
    const registry = new SubAgentTargetRunnerRegistry()
      .register({
        definition,
        runnerId: 'external-runner',
        runnerVersion: '1',
        childCheckpointVersions: ['1'],
        modelBinding: {
          gatewayId: 'controller-model',
          protocol: 'openai-chat',
          codecVersion: '1',
        },
        create: async () => ({ run: async (request) => terminalOutcome(request) }),
      })
      .seal();

    expect(() =>
      createSubAgentTransportTargetBridge({
        ownerSessionId: 'owner-session-1',
        executorName: descriptor.name,
        registry,
        bindingCodec,
        peer: scalarPeer,
        createBinding: ({ request }) => createBinding(request),
        reconnect: 'external_binding',
        checkpointCommitted: async () => undefined,
      }),
    ).toThrow(/channel-aware peer provider/u);
    scalarPeer.close();
  });

  it('keeps live reconnect unsupported unless the target explicitly opts in', async () => {
    const checkpointReady = deferred();
    const release = deferred();
    let oldSignal: AbortSignal | undefined;
    const checkpoint = childCheckpoint();
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        oldSignal = request.signal;
        await control.commitCheckpoint('checkpoint-1', checkpoint);
        checkpointReady.resolve();
        await release.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({ runners: [oldRunner] });
    const first = harness.connect();
    const created = createRequest();
    const host = createHostControl();
    const handle = await first.controller.spawn(created, host.control);
    if (!('taskId' in handle)) throw new Error('Expected a task handle.');
    await checkpointReady.promise;

    const second = harness.connect();
    await expect(
      second.controller.execute(
        createReconnectRequest(created, createBinding(created)),
        createHostControl().control,
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
    expect(harness.factory).toHaveBeenCalledTimes(1);
    expect(oldSignal?.aborted).toBe(false);

    release.resolve();
    await expect(handle.wait()).resolves.toEqual(terminalOutcome(created));
    await harness.dispose();
  });

  it('rejects a live external reconnect on the resident authenticated channel without fencing it', async () => {
    const checkpointReady = deferred();
    const releaseOld = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 1 });
    let oldSignal: AbortSignal | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        oldSignal = request.signal;
        await control.commitCheckpoint('checkpoint-before-same-channel-reconnect', checkpoint);
        checkpointReady.resolve();
        await releaseOld.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [oldRunner, { run: async (request) => terminalOutcome(request) }],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    const first = harness.connect();
    const created = createRequest();
    const oldHandle = await first.controller.spawn(created, createHostControl().control);
    if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
    await checkpointReady.promise;

    const reconnect = createReconnectRequest(
      created,
      createBinding(created),
      'reconnect-on-resident-channel',
    );
    const sameChannelExchange = first.controllerPeer.openRequest({
      kind: 'executor.request',
      taskId: reconnect.taskId,
      operationId: reconnect.operation.operationId,
      payload: {
        mode: 'execute',
        request: createSubAgentExecutionRequestWire(reconnect, {
          now: () => NOW,
          expectedExecutorName: descriptor.name,
          maxBindingBytes: descriptor.maxBindingBytes,
        }),
      },
      signal: reconnect.signal,
      timeoutMs: reconnect.deadlineAt - NOW,
    });
    const rejected = await sameChannelExchange.next();
    expect(rejected).toMatchObject({
      done: false,
      value: {
        envelope: {
          kind: 'protocol.error',
          payload: { error: { code: 'RECOVERY_UNSUPPORTED' } },
        },
      },
    });
    await expect(sameChannelExchange.next()).resolves.toEqual({ done: true, value: undefined });
    expect(oldSignal?.aborted).toBe(false);
    expect(harness.factory).toHaveBeenCalledTimes(1);

    releaseOld.resolve();
    await expect(oldHandle.wait()).resolves.toEqual(terminalOutcome(created));
    await harness.dispose();
  });

  it('allows a read-only reconnect of a settled receipt on its existing channel', async () => {
    const harness = createHarness({
      runners: [{ run: async (request) => terminalOutcome(request) }],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    const first = harness.connect();
    const created = createRequest();
    const original = await first.controller.spawn(created, createHostControl().control);
    if (!('taskId' in original)) throw new Error('Expected an original task handle.');
    await expect(original.wait()).resolves.toEqual(terminalOutcome(created));
    await vi.waitFor(() => expect(first.controller.diagnostics().activeExecutions).toBe(0));

    const reconnect = createReconnectRequest(
      created,
      createBinding(created),
      'same-channel-settled-reconnect',
    );
    const receipt = await first.controller.spawn(reconnect, createHostControl().control);
    if (!('taskId' in receipt)) throw new Error('Expected a settled reconnect handle.');
    await expect(receipt.wait()).resolves.toEqual(terminalOutcome(reconnect));
    expect(harness.factory).toHaveBeenCalledTimes(1);
    await harness.dispose();
  });

  it.each(['terminal', 'settled-reconnect'] as const)(
    'rejects a generic resume after $variant without reviving its terminal receipt',
    async (variant) => {
      const harness = createHarness({
        runners: [{ run: async (request) => terminalOutcome(request) }],
        externalReconnect: true,
        checkpointCommitted: async () => undefined,
      });
      const first = harness.connect();
      const created = createRequest();
      const original = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in original)) throw new Error('Expected an original task handle.');
      await expect(original.wait()).resolves.toEqual(terminalOutcome(created));
      await vi.waitFor(() => expect(first.controller.diagnostics().activeExecutions).toBe(0));

      let currentHandle = original;
      let currentRequest = created;
      if (variant === 'settled-reconnect') {
        const second = harness.connect();
        currentRequest = createReconnectRequest(
          created,
          createBinding(created),
          'settled-reconnect-before-generic-resume',
        );
        const reconnected = await second.controller.spawn(
          currentRequest,
          createHostControl().control,
        );
        if (!('taskId' in reconnected)) throw new Error('Expected a settled reconnect handle.');
        currentHandle = reconnected;
        await expect(currentHandle.wait()).resolves.toEqual(terminalOutcome(currentRequest));
        await vi.waitFor(() => expect(second.controller.diagnostics().activeExecutions).toBe(0));
      }

      const resumeConnection = harness.connect();
      const resumeAttempt = variant === 'terminal' ? 2 : 3;
      const resume = createResumeRequest(
        created,
        createBinding(created),
        `resume-after-${variant}`,
        childCheckpoint({ modelIteration: 1 }),
        {
          attempt: resumeAttempt,
          executionEpoch: `epoch-${resumeAttempt}`,
          executionFencingToken: String(resumeAttempt),
        },
      );
      await expect(
        resumeConnection.controller.spawn(resume, createHostControl().control),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(harness.factory).toHaveBeenCalledTimes(1);
      await expect(currentHandle.wait()).resolves.toEqual(terminalOutcome(currentRequest));
      await expect(currentHandle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'succeeded',
      });
      await harness.dispose();
    },
  );

  it('rejects checkpoint resume for an approval-paused resident and preserves the paused receipt', async () => {
    const approval = Object.freeze({
      approvalId: 'approval-resume-1',
      ownerSessionId: 'owner-session-1',
      taskId: 'task-1',
      callId: 'approval-call-1',
      toolName: 'write-report',
      summary: 'Approve report writing.',
      createdAt: NOW,
      revision: 1,
    });
    const pausedRunner: SubAgentChildRunner = {
      run: async (request) =>
        Object.freeze({
          type: 'paused' as const,
          reason: 'approval' as const,
          task: Object.freeze({ taskId: request.taskId, subAgent: request.definition }),
          approvals: Object.freeze([approval]),
          checkpointRevision: 1,
        }),
    };
    const harness = createHarness({
      runners: [pausedRunner, { run: async (request) => terminalOutcome(request) }],
    });
    const first = harness.connect();
    const created = createRequest();
    const pausedHandle = await first.controller.spawn(created, createHostControl().control);
    if (!('taskId' in pausedHandle)) throw new Error('Expected a paused task handle.');
    await expect(pausedHandle.wait()).resolves.toMatchObject({
      type: 'paused',
      reason: 'approval',
      approvals: [approval],
    });
    await vi.waitFor(() => expect(first.controller.diagnostics().activeExecutions).toBe(0));

    const second = harness.connect();
    const invalidResume = createResumeRequest(
      created,
      createBinding(created),
      'checkpoint-resume-after-approval-pause',
      childCheckpoint({ modelIteration: 1 }),
    );
    await expect(
      second.controller.spawn(invalidResume, createHostControl().control),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    expect(harness.factory).toHaveBeenCalledTimes(1);
    await expect(pausedHandle.snapshot()).resolves.toMatchObject({
      taskId: created.taskId,
      state: 'waiting_approval',
    });
    await expect(pausedHandle.wait()).resolves.toMatchObject({
      type: 'paused',
      reason: 'approval',
    });
    await harness.dispose();
  });

  it.each(['approval', 'checkpoint'] as const)(
    'allows only checkpoint resume after a runner rejection: $variant',
    async (variant) => {
      const runnerRejected = deferred();
      const rejection = new Error('original target runner rejected');
      const rejectingRunner: SubAgentChildRunner = {
        run: async () => {
          runnerRejected.resolve();
          throw rejection;
        },
      };
      const resumedRunner: SubAgentChildRunner = {
        run: async (request) => terminalOutcome(request),
      };
      const harness = createHarness({ runners: [rejectingRunner, resumedRunner] });
      const first = harness.connect();
      const created = createRequest();
      const failedHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in failedHandle)) throw new Error('Expected an accepted task handle.');
      await runnerRejected.promise;
      await vi.waitFor(() => expect(harness.target.diagnostics().running).toBe(0));
      await vi.waitFor(() => expect(first.controller.diagnostics().activeExecutions).toBe(0));

      const second = harness.connect();
      const checkpoint =
        variant === 'approval' ? approvalCheckpoint() : childCheckpoint({ modelIteration: 1 });
      const resume =
        variant === 'approval'
          ? createApprovalResumeRequest(
              created,
              createBinding(created),
              'approval-resume-after-runner-rejection',
              checkpoint,
            )
          : createResumeRequest(
              created,
              createBinding(created),
              'checkpoint-resume-after-runner-rejection',
              checkpoint,
            );
      if (variant === 'approval') {
        await expect(
          second.controller.spawn(resume, createHostControl().control),
        ).rejects.toMatchObject({
          code: 'INVALID_STATE_TRANSITION',
        });
        expect(harness.factory).toHaveBeenCalledTimes(1);
      } else {
        const resumedHandle = await second.controller.spawn(resume, createHostControl().control);
        if (!('taskId' in resumedHandle)) throw new Error('Expected a resumed task handle.');
        await expect(resumedHandle.wait()).resolves.toEqual(terminalOutcome(resume));
        expect(harness.factory).toHaveBeenCalledTimes(2);
      }
      await harness.dispose();
    },
  );

  it('preserves the runner outcome and cleanup when the target clock fails during settlement', async () => {
    const runnerStarted = deferred();
    const releaseRunner = deferred();
    let failTargetClock = false;
    let runnerSignal: AbortSignal | undefined;
    let controlSignal: AbortSignal | undefined;
    const runner: SubAgentChildRunner = {
      run: async (request, control) => {
        runnerSignal = request.signal;
        controlSignal = control.signal;
        runnerStarted.resolve();
        await releaseRunner.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [runner],
      targetNow: () => {
        if (failTargetClock) throw new Error('target clock failed during runner settlement');
        return NOW;
      },
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const handle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in handle)) throw new Error('Expected an original task handle.');
      await runnerStarted.promise;
      const terminal = handle.wait();
      void terminal.catch(() => undefined);

      failTargetClock = true;
      releaseRunner.resolve();
      await expect(within(terminal, 'clock-failure terminal result')).resolves.toEqual(
        terminalOutcome(created),
      );
      expect(runnerSignal?.aborted).toBe(true);
      expect(controlSignal?.aborted).toBe(true);
      expect(harness.target.diagnostics()).toMatchObject({ running: 0, tasks: 1 });
      await expect(
        within(harness.target.dispose(), 'clock-failure target disposal'),
      ).resolves.toBeUndefined();
      expect(harness.target.diagnostics()).toMatchObject({
        disposed: true,
        tasks: 0,
        starting: 0,
        running: 0,
      });
    } finally {
      failTargetClock = false;
      releaseRunner.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('does not accumulate lifecycle listeners when hostile target clocks reject reconstruction', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    const harness = createHarness({
      runners: [],
      targetNow: () => {
        throw new Error('hostile reconstruction clock');
      },
    });
    try {
      const connection = harness.connect();
      for (let index = 1; index <= 32; index += 1) {
        const created = createRequest({
          operation: Object.freeze({
            type: 'create' as const,
            operationId: `hostile-clock-create-${index}`,
            idempotencyKey: `hostile-clock-idempotency-${index}`,
          }),
        });
        const exchange = connection.controllerPeer.openRequest({
          kind: 'executor.request',
          taskId: created.taskId,
          operationId: created.operation.operationId,
          payload: {
            mode: 'execute',
            request: createSubAgentExecutionRequestWire(created, {
              now: () => NOW,
              expectedExecutorName: descriptor.name,
              maxBindingBytes: descriptor.maxBindingBytes,
            }),
          },
          signal: created.signal,
          timeoutMs: created.deadlineAt - NOW,
        });
        await expect(exchange.next()).resolves.toMatchObject({
          done: false,
          value: { envelope: { kind: 'protocol.error' } },
        });
        await expect(exchange.next()).resolves.toEqual({ done: true, value: undefined });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(
        warnings.filter(({ name, message }) =>
          `${name} ${message}`.includes('MaxListenersExceededWarning'),
        ),
      ).toEqual([]);
      expect(harness.factory).not.toHaveBeenCalled();
      expect(harness.target.diagnostics()).toMatchObject({
        tasks: 0,
        starting: 0,
        running: 0,
      });
      await expect(
        within(harness.target.dispose(), 'hostile-clock target disposal'),
      ).resolves.toBeUndefined();
    } finally {
      process.removeListener('warning', onWarning);
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('rejects a reconnect whose fresh Peer closes during binding validation before fencing the resident', async () => {
    const checkpointReady = deferred();
    const validationStarted = deferred();
    const releaseValidation = deferred();
    const freshStarted = deferred();
    const releaseFresh = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 2 });
    let oldSignal: AbortSignal | undefined;
    let recoveredRequest: SubAgentChildRunRequest | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        oldSignal = request.signal;
        await control.commitCheckpoint('checkpoint-before-peer-close-validation', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const freshRunner: SubAgentChildRunner = {
      run: async (request) => {
        recoveredRequest = request;
        freshStarted.resolve();
        await releaseFresh.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [oldRunner, freshRunner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      validateBinding: async ({ request }) => {
        if (
          request.operation.type === 'reconnect' &&
          request.operation.operationId === 'reconnect-peer-closes-during-validation'
        ) {
          validationStarted.resolve();
          await releaseValidation.promise;
        }
      },
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const failedConnection = harness.connect();
      const failedReconnect = failedConnection.controller.spawn(
        createReconnectRequest(
          created,
          createBinding(created),
          'reconnect-peer-closes-during-validation',
          { deadlineAt: NOW + 150 },
        ),
        createHostControl().control,
      );
      void failedReconnect.catch(() => undefined);
      await validationStarted.promise;
      failedConnection.targetPeer.close();
      releaseValidation.resolve();
      await expect(
        within(failedReconnect, 'closed fresh-Peer reconnect rejection'),
      ).rejects.toBeDefined();
      await vi.waitFor(() => expect(harness.target.diagnostics().starting).toBe(0));
      expect(oldSignal?.aborted).toBe(false);
      expect(harness.factory).toHaveBeenCalledTimes(1);
      await expect(oldHandle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'running',
      });

      const recoveredConnection = harness.connect();
      const reconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-after-fresh-peer-close',
      );
      const recoveredHandle = await recoveredConnection.controller.spawn(
        reconnect,
        createHostControl().control,
      );
      if (!('taskId' in recoveredHandle)) throw new Error('Expected a recovered task handle.');
      await freshStarted.promise;
      expect(recoveredRequest?.checkpoint).toEqual(checkpoint);
      expect(harness.factory).toHaveBeenCalledTimes(2);

      releaseFresh.resolve();
      await expect(recoveredHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
    } finally {
      releaseValidation.resolve();
      releaseFresh.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('rejects when channel resolution crosses the absolute reconnect deadline before fencing the resident', async () => {
    const checkpointReady = deferred();
    const releaseOld = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 2 });
    const freshRun = vi.fn(async (request: SubAgentChildRunRequest) => terminalOutcome(request));
    let now = NOW;
    let expiringChannelId: string | undefined;
    let freshResolutionCount = 0;
    let oldSignal: AbortSignal | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        oldSignal = request.signal;
        await control.commitCheckpoint('checkpoint-before-peer-resolution-deadline', checkpoint);
        checkpointReady.resolve();
        await releaseOld.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [oldRunner, { run: freshRun }],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      now: () => now,
      resolveTargetPeer: ({ channelId }) => {
        if (channelId !== expiringChannelId) return;
        freshResolutionCount += 1;
        if (freshResolutionCount === 2) now = NOW + 100;
      },
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const second = harness.connect();
      expiringChannelId = second.channelId;
      const expiredReconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-peer-resolution-crosses-deadline',
        { deadlineAt: NOW + 100 },
      );
      await expect(
        within(
          second.controller.spawn(expiredReconnect, createHostControl().control),
          'peer-resolution deadline reconnect rejection',
        ),
      ).rejects.toMatchObject({ code: 'TIMED_OUT' });
      expect(now).toBe(expiredReconnect.deadlineAt);
      expect(freshResolutionCount).toBe(2);
      expect(oldSignal?.aborted).toBe(false);
      expect(harness.factory).toHaveBeenCalledTimes(1);
      expect(freshRun).not.toHaveBeenCalled();
      expect(harness.target.diagnostics()).toMatchObject({
        tasks: 1,
        starting: 0,
        running: 1,
      });
      await expect(oldHandle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'running',
      });

      releaseOld.resolve();
      await expect(oldHandle.wait()).resolves.toEqual(terminalOutcome(created));
    } finally {
      releaseOld.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it.each([
    Object.freeze({
      resolutionCall: 3,
      expectedFactoryCalls: 1,
      boundary: 'fresh factory invocation',
    }),
    Object.freeze({
      resolutionCall: 4,
      expectedFactoryCalls: 2,
      boundary: 'fresh runner launch',
    }),
  ])(
    'keeps the resident detached when channel resolution crosses the deadline before $boundary',
    async ({ resolutionCall, expectedFactoryCalls }) => {
      const checkpointReady = deferred();
      const checkpoint = childCheckpoint({ modelIteration: 2 });
      const freshRun = vi.fn(async (request: SubAgentChildRunRequest) => terminalOutcome(request));
      let now = NOW;
      let expiringChannelId: string | undefined;
      let freshResolutionCount = 0;
      let oldSignal: AbortSignal | undefined;
      let freshFactorySignal: AbortSignal | undefined;
      const oldRunner: SubAgentChildRunner = {
        run: async (request, control) => {
          oldSignal = request.signal;
          await control.commitCheckpoint(
            `checkpoint-before-peer-resolution-${resolutionCall}`,
            checkpoint,
          );
          checkpointReady.resolve();
          await waitForAbort(request.signal);
          return terminalOutcome(request, 'cancelled');
        },
      };
      const harness = createHarness({
        runners: [],
        externalReconnect: true,
        checkpointCommitted: async () => undefined,
        now: () => now,
        resolveTargetPeer: ({ channelId }) => {
          if (channelId !== expiringChannelId) return;
          freshResolutionCount += 1;
          if (freshResolutionCount === resolutionCall) now = NOW + 100;
        },
        createRunner: (context, factoryIndex) => {
          if (factoryIndex === 0) return oldRunner;
          if (factoryIndex === 1) {
            freshFactorySignal = context.request.signal;
            return { run: freshRun };
          }
          throw new Error('An expired resolver boundary must not create another runner.');
        },
      });
      try {
        const first = harness.connect();
        const created = createRequest();
        const oldHandle = await first.controller.spawn(created, createHostControl().control);
        if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
        await checkpointReady.promise;

        const second = harness.connect();
        expiringChannelId = second.channelId;
        const expiredReconnect = createReconnectRequest(
          created,
          createBinding(created),
          `reconnect-peer-resolution-${resolutionCall}-crosses-deadline`,
          { deadlineAt: NOW + 100 },
        );
        await expect(
          within(
            second.controller.spawn(expiredReconnect, createHostControl().control),
            `peer-resolution ${resolutionCall} deadline reconnect rejection`,
          ),
        ).rejects.toMatchObject({ code: 'TIMED_OUT' });
        expect(now).toBe(expiredReconnect.deadlineAt);
        expect(freshResolutionCount).toBe(resolutionCall);
        expect(oldSignal?.aborted).toBe(true);
        expect(harness.factory).toHaveBeenCalledTimes(expectedFactoryCalls);
        expect(freshRun).not.toHaveBeenCalled();
        if (resolutionCall === 3) expect(freshFactorySignal).toBeUndefined();
        else expect(freshFactorySignal?.aborted).toBe(true);
        expect(harness.target.diagnostics()).toMatchObject({
          tasks: 1,
          starting: 0,
          running: 0,
        });

        await expect(
          second.controller.cancel(createBinding(created), {
            operationId: `cancel-expired-peer-resolution-${resolutionCall}`,
            reason: 'clean up the deadline-fenced detached slot',
            signal: new AbortController().signal,
            deadlineAt: now + 1_000,
          }),
        ).resolves.toBeUndefined();
        expect(freshRun).not.toHaveBeenCalled();
      } finally {
        await harness.forceDispose().catch(() => undefined);
      }
    },
  );

  it('keeps a detached slot recoverable when the final runner microtask reaches the reconnect deadline', async () => {
    const checkpointReady = deferred();
    const recoveredStarted = deferred();
    const releaseRecovered = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 2 });
    const expiredRun = vi.fn(async (request: SubAgentChildRunRequest) => terminalOutcome(request));
    let now = NOW;
    let expiringChannelId: string | undefined;
    let freshResolutionCount = 0;
    let finalLaunchClockArmed = false;
    let finalLaunchClockReadCount = 0;
    let runnerGateReachedDeadline = false;
    let expiredFactorySignal: AbortSignal | undefined;
    let recoveredRequest: SubAgentChildRunRequest | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-final-runner-clock', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const recoveredRunner: SubAgentChildRunner = {
      run: async (request) => {
        recoveredRequest = request;
        recoveredStarted.resolve();
        await releaseRecovered.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      now: () => now,
      targetNow: () => {
        if (!finalLaunchClockArmed) return now;
        finalLaunchClockReadCount += 1;
        if (finalLaunchClockReadCount < 3) return NOW + 99;
        runnerGateReachedDeadline = true;
        return NOW + 100;
      },
      resolveTargetPeer: ({ channelId }) => {
        if (channelId !== expiringChannelId) return;
        freshResolutionCount += 1;
        if (freshResolutionCount === 4) {
          finalLaunchClockReadCount = 0;
          finalLaunchClockArmed = true;
        }
      },
      createRunner: (context, factoryIndex) => {
        if (factoryIndex === 0) return oldRunner;
        if (factoryIndex === 1) {
          expiredFactorySignal = context.request.signal;
          return { run: expiredRun };
        }
        if (factoryIndex === 2) return recoveredRunner;
        throw new Error('Unexpected runner factory after final-clock recovery.');
      },
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const original = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in original)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const second = harness.connect();
      expiringChannelId = second.channelId;
      const expiredReconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-final-runner-clock-deadline',
        { deadlineAt: NOW + 100 },
      );
      await expect(
        within(
          second.controller.spawn(expiredReconnect, createHostControl().control),
          'final runner-clock reconnect rejection',
        ),
      ).rejects.toMatchObject({ code: 'TIMED_OUT' });
      expect(freshResolutionCount).toBe(4);
      expect(finalLaunchClockReadCount).toBeGreaterThanOrEqual(3);
      expect(runnerGateReachedDeadline).toBe(true);
      expect(harness.factory).toHaveBeenCalledTimes(2);
      expect(expiredRun).not.toHaveBeenCalled();
      expect(expiredFactorySignal?.aborted).toBe(true);
      expect(harness.target.diagnostics()).toMatchObject({
        tasks: 1,
        starting: 0,
        running: 0,
      });

      finalLaunchClockArmed = false;
      expiringChannelId = undefined;
      now = NOW;
      const third = harness.connect();
      const recovered = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-after-final-runner-clock-deadline',
        {
          attempt: 3,
          executionEpoch: 'epoch-3',
          executionFencingToken: '3',
        },
      );
      const recoveredHandle = await third.controller.spawn(recovered, createHostControl().control);
      if (!('taskId' in recoveredHandle)) throw new Error('Expected a recovered task handle.');
      await recoveredStarted.promise;
      expect(harness.factory).toHaveBeenCalledTimes(3);
      expect(recoveredRequest?.checkpoint).toEqual(checkpoint);
      expect(expiredRun).not.toHaveBeenCalled();

      releaseRecovered.resolve();
      await expect(recoveredHandle.wait()).resolves.toEqual(terminalOutcome(recovered));
    } finally {
      releaseRecovered.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('restores the detached slot when the exact fresh Peer closes before the runner microtask gate', async () => {
    const checkpointReady = deferred();
    const recoveredStarted = deferred();
    const releaseRecovered = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 2 });
    const candidateRun = vi.fn(async (request: SubAgentChildRunRequest) =>
      terminalOutcome(request),
    );
    let candidateChannelId: string | undefined;
    let candidateResolutionCount = 0;
    let closeCandidatePeer: (() => void) | undefined;
    let candidateSignal: AbortSignal | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-final-peer-gate', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const recoveredRunner: SubAgentChildRunner = {
      run: async (request) => {
        recoveredStarted.resolve();
        await releaseRecovered.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      resolveTargetPeer: ({ channelId }) => {
        if (channelId !== candidateChannelId) return;
        candidateResolutionCount += 1;
        if (candidateResolutionCount === 4) {
          queueMicrotask(() => closeCandidatePeer?.());
        }
      },
      createRunner: (context, factoryIndex) => {
        if (factoryIndex === 0) return oldRunner;
        if (factoryIndex === 1) {
          candidateSignal = context.request.signal;
          return { run: candidateRun };
        }
        if (factoryIndex === 2) return recoveredRunner;
        throw new Error('Unexpected runner factory after final Peer-gate recovery.');
      },
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const failedConnection = harness.connect();
      candidateChannelId = failedConnection.channelId;
      closeCandidatePeer = () => failedConnection.targetPeer.close();
      await expect(
        failedConnection.controller.spawn(
          createReconnectRequest(
            created,
            createBinding(created),
            'reconnect-final-peer-gate-closes',
          ),
          createHostControl().control,
        ),
      ).rejects.toBeDefined();
      expect(candidateResolutionCount).toBe(5);
      expect(harness.factory).toHaveBeenCalledTimes(2);
      expect(candidateRun).not.toHaveBeenCalled();
      expect(candidateSignal?.aborted).toBe(true);
      expect(harness.target.diagnostics()).toMatchObject({
        tasks: 1,
        starting: 0,
        running: 0,
      });

      candidateChannelId = undefined;
      const recoveredConnection = harness.connect();
      const recovered = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-after-final-peer-gate-close',
        {
          attempt: 3,
          executionEpoch: 'epoch-3',
          executionFencingToken: '3',
        },
      );
      const recoveredHandle = await recoveredConnection.controller.spawn(
        recovered,
        createHostControl().control,
      );
      if (!('taskId' in recoveredHandle)) throw new Error('Expected a recovered task handle.');
      await recoveredStarted.promise;
      expect(harness.factory).toHaveBeenCalledTimes(3);

      releaseRecovered.resolve();
      await expect(recoveredHandle.wait()).resolves.toEqual(terminalOutcome(recovered));
    } finally {
      releaseRecovered.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('restores the old attachment when the fresh Peer closes during soft control drain', async () => {
    const checkpointAReady = deferred();
    const hookBStarted = deferred();
    const releaseHookB = deferred();
    const checkpointBComplete = deferred();
    const reconnectReachedTarget = deferred();
    const releaseOld = deferred();
    const checkpointA = childCheckpoint({ modelIteration: 2 });
    const checkpointB = childCheckpoint({ modelIteration: 3 });
    let oldControl: SubAgentExecutionControl | undefined;
    let oldSignal: AbortSignal | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        oldControl = control;
        oldSignal = request.signal;
        await control.commitCheckpoint('checkpoint-before-control-drain-peer-close', checkpointA);
        checkpointAReady.resolve();
        await control.commitCheckpoint('checkpoint-blocking-control-drain', checkpointB);
        checkpointBComplete.resolve();
        await releaseOld.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [oldRunner, { run: async (request) => terminalOutcome(request) }],
      externalReconnect: true,
      checkpointCommitted: async ({ operationId }) => {
        if (operationId !== 'checkpoint-blocking-control-drain') return;
        hookBStarted.resolve();
        await releaseHookB.promise;
      },
      validateBinding: ({ request }) => {
        if (request.operation.type === 'reconnect') reconnectReachedTarget.resolve();
      },
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const oldHost = createHostControl();
      const oldHandle = await first.controller.spawn(created, oldHost.control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointAReady.promise;
      await hookBStarted.promise;

      const failedConnection = harness.connect();
      const failedReconnect = failedConnection.controller.spawn(
        createReconnectRequest(
          created,
          createBinding(created),
          'reconnect-peer-closes-during-control-drain',
          { deadlineAt: NOW + 200 },
        ),
        createHostControl().control,
      );
      void failedReconnect.catch(() => undefined);
      await reconnectReachedTarget.promise;
      await expectPending(failedReconnect, 'reconnect waiting on old control drain');

      failedConnection.targetPeer.close();
      releaseHookB.resolve();
      await checkpointBComplete.promise;
      await expect(
        within(failedReconnect, 'closed-Peer control-drain reconnect rejection'),
      ).rejects.toBeDefined();
      expect(oldSignal?.aborted).toBe(false);
      expect(harness.factory).toHaveBeenCalledTimes(1);
      if (oldControl === undefined) throw new Error('Expected the old runner control.');
      await expect(
        oldControl.reportProgress('old-progress-after-fresh-peer-close', {
          message: 'old attachment remains active',
        }),
      ).resolves.toBeUndefined();
      expect(oldHost.reportProgress).toHaveBeenCalledTimes(1);
      await expect(oldHandle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'running',
      });
    } finally {
      releaseHookB.resolve();
      releaseOld.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('reconnects only after a controller-acknowledged durable checkpoint and quiesces the old runner first', async () => {
    const checkpointReady = deferred();
    const oldAborted = deferred();
    const releaseOldCleanup = deferred();
    const newStarted = deferred();
    const releaseNew = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 1 });
    const order: string[] = [];
    let oldControl: SubAgentExecutionControl | undefined;
    let oldCleanupComplete = false;
    let newRequest: SubAgentChildRunRequest | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        oldControl = control;
        await control.commitCheckpoint('checkpoint-1', checkpoint);
        order.push('checkpoint-returned');
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        order.push('old-aborted');
        oldAborted.resolve();
        await releaseOldCleanup.promise;
        oldCleanupComplete = true;
        order.push('old-quiesced');
        return terminalOutcome(request, 'cancelled');
      },
    };
    const newRunner: SubAgentChildRunner = {
      run: async (request) => {
        newRequest = request;
        order.push('new-run');
        newStarted.resolve();
        await releaseNew.promise;
        return terminalOutcome(request);
      },
    };
    const checkpointCommitted = vi.fn(
      async (context: SubAgentTransportTargetCheckpointCommitContext) => {
        order.push('target-checkpoint-hook');
        expect(context).toMatchObject({
          operationId: 'checkpoint-1',
          ownerSessionId: created.ownerSessionId,
          taskId: created.taskId,
          executionAttempt: 1,
          executionEpoch: 'epoch-1',
          executionFencingToken: '1',
          binding: createBinding(created),
          checkpoint,
        });
      },
    );
    const harness = createHarness({
      runners: [oldRunner, newRunner],
      externalReconnect: true,
      checkpointCommitted,
    });
    const first = harness.connect();
    const created = createRequest();
    const hostOne = createHostControl({
      commitCheckpoint: async () => {
        order.push('controller-checkpoint-ack');
      },
    });
    const oldHandle = await first.controller.spawn(created, hostOne.control);
    if (!('taskId' in oldHandle)) throw new Error('Expected a task handle.');
    await checkpointReady.promise;
    expect(order.slice(0, 3)).toEqual([
      'controller-checkpoint-ack',
      'target-checkpoint-hook',
      'checkpoint-returned',
    ]);

    const modelTwo = vi.fn(async (context: SubAgentTransportModelRequestContext) =>
      modelReply(context.payload),
    );
    const second = harness.connect(modelTwo);
    const reconnect = createReconnectRequest(created, createBinding(created));
    const hostTwo = createHostControl();
    const reconnecting = second.controller.spawn(reconnect, hostTwo.control);
    await oldAborted.promise;
    expect(harness.factory).toHaveBeenCalledTimes(1);
    expect(oldCleanupComplete).toBe(false);

    releaseOldCleanup.resolve();
    const newHandle = await reconnecting;
    if (!('taskId' in newHandle)) throw new Error('Expected a reconnected task handle.');
    await newStarted.promise;
    expect(harness.factory).toHaveBeenCalledTimes(2);
    expect(oldCleanupComplete).toBe(true);
    expect(order.indexOf('old-quiesced')).toBeLessThan(order.indexOf('new-run'));
    expect(newRequest).toMatchObject({
      attempt: 2,
      executionEpoch: 'epoch-2',
      executionFencingToken: '2',
      checkpoint,
    });
    expect(newRequest?.checkpoint).not.toBe(checkpoint);
    expect(harness.targetCreateBinding).toHaveBeenCalledTimes(1);

    if (oldControl === undefined) throw new Error('Expected the original runner control.');
    const staleControlCalls = await Promise.allSettled([
      oldControl.commitCheckpoint('stale-checkpoint', childCheckpoint({ modelIteration: 8 })),
      oldControl.completion.submitResult('stale-result', { answer: 'stale' }),
    ]);
    expect(staleControlCalls).toHaveLength(2);
    expect(staleControlCalls.every(({ status }) => status === 'rejected')).toBe(true);
    expect(hostTwo.commitCheckpoint).not.toHaveBeenCalled();
    expect(hostTwo.submitResult).not.toHaveBeenCalled();
    expect(checkpointCommitted).toHaveBeenCalledTimes(1);

    await expect(
      harness.target.modelExchange({
        taskId: created.taskId,
        operationId: 'stale-provider-operation',
        payload: modelPayload(created, 'stale-provider-operation'),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(modelTwo).not.toHaveBeenCalled();

    releaseNew.resolve();
    await expect(newHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
    await vi.waitFor(() => expect(first.controller.diagnostics().activeExecutions).toBe(0));
    await harness.dispose();
  });

  it.each(['reply', 'authoritative-failure'] as const)(
    'keeps a fresh reconnect in soft quiescence until an admitted old-channel Model $variant settles',
    async (variant) => {
      const checkpointReady = deferred();
      const modelStarted = deferred();
      const releaseModel = deferred();
      const oldAborted = deferred();
      const freshStarted = deferred();
      const releaseFresh = deferred();
      const checkpoint = childCheckpoint({ modelIteration: 1 });
      let oldSignal: AbortSignal | undefined;
      let reconnectChannelId: string | undefined;
      let reconnectResolutionCount = 0;
      const oldRunner: SubAgentChildRunner = {
        run: async (request, control) => {
          oldSignal = request.signal;
          await control.commitCheckpoint(`checkpoint-before-model-${variant}`, checkpoint);
          checkpointReady.resolve();
          await waitForAbort(request.signal);
          oldAborted.resolve();
          return terminalOutcome(request, 'cancelled');
        },
      };
      const freshRun = vi.fn(async (request: SubAgentChildRunRequest) => {
        freshStarted.resolve();
        await releaseFresh.promise;
        return terminalOutcome(request);
      });
      const model = vi.fn(async (context: SubAgentTransportModelRequestContext) => {
        modelStarted.resolve();
        await releaseModel.promise;
        return variant === 'reply'
          ? modelReply(context.payload)
          : modelFailureReply(context.payload);
      });
      const harness = createHarness({
        runners: [oldRunner, { run: freshRun }],
        externalReconnect: true,
        checkpointCommitted: async () => undefined,
        resolveTargetPeer: ({ channelId }) => {
          if (channelId === reconnectChannelId) reconnectResolutionCount += 1;
        },
      });
      try {
        const first = harness.connect(model);
        const created = createRequest();
        const oldHandle = await first.controller.spawn(created, createHostControl().control);
        if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
        await checkpointReady.promise;

        const payload = modelPayload(created, `old-model-${variant}`);
        const inFlightModel = harness.target.modelExchange({
          taskId: created.taskId,
          operationId: payload.providerOperationId,
          payload,
        });
        void inFlightModel.catch(() => undefined);
        await modelStarted.promise;

        const second = harness.connect();
        reconnectChannelId = second.channelId;
        const reconnect = createReconnectRequest(
          created,
          createBinding(created),
          `reconnect-waits-for-model-${variant}`,
        );
        const reconnecting = second.controller.spawn(reconnect, createHostControl().control);
        void reconnecting.catch(() => undefined);
        await vi.waitFor(() => expect(reconnectResolutionCount).toBe(1));
        await expectPending(reconnecting, `reconnect during old Model ${variant}`);
        expect(oldSignal?.aborted).toBe(false);
        expect(harness.factory).toHaveBeenCalledTimes(1);
        expect(freshRun).not.toHaveBeenCalled();

        releaseModel.resolve();
        await expect(
          within(inFlightModel, `old Model ${variant} settlement`),
        ).resolves.toMatchObject({ ok: variant === 'reply' });
        await within(oldAborted.promise, `old runner abort after Model ${variant}`);

        const freshHandle = await within(reconnecting, `reconnect after Model ${variant}`);
        if (!('taskId' in freshHandle)) throw new Error('Expected a reconnected task handle.');
        await freshStarted.promise;
        expect(harness.factory).toHaveBeenCalledTimes(2);
        expect(freshRun).toHaveBeenCalledTimes(1);
        expect(model).toHaveBeenCalledTimes(1);

        releaseFresh.resolve();
        await expect(freshHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
      } finally {
        releaseModel.resolve();
        releaseFresh.resolve();
        await harness.forceDispose().catch(() => undefined);
      }
    },
  );

  it('recovers an admitted reply-loss Model operation only through the same operation and request hash', async () => {
    const checkpointReady = deferred();
    const lostReply = deferred();
    const releaseLostReply = deferred();
    const lostReplyDelivered = deferred();
    const recoveredStarted = deferred();
    const releaseRecovered = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 1 });
    const lostRequest = new AbortController();
    let dropFirstReply = true;
    let modelRequestPackets = 0;
    let providerEffectCount = 0;
    let cachedReply: SubAgentTransportRpcPayloadMap['model.reply'] | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-model-reply-loss', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const recoveredRunner: SubAgentChildRunner = {
      run: async (request) => {
        recoveredStarted.resolve();
        await releaseRecovered.promise;
        return terminalOutcome(request);
      },
    };
    const model = vi.fn(async (context: SubAgentTransportModelRequestContext) => {
      if (cachedReply === undefined) {
        providerEffectCount += 1;
        cachedReply = modelReply(context.payload);
      }
      return cachedReply;
    });
    const harness = createHarness({
      runners: [oldRunner, recoveredRunner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    try {
      const first = harness.connect({
        model,
        targetToController: (packet, deliver) => {
          if (packetEnvelope(packet).kind === 'model.request') modelRequestPackets += 1;
          return deliver();
        },
        controllerToTarget: (packet, deliver) => {
          if (dropFirstReply && packetEnvelope(packet).kind === 'model.reply') {
            dropFirstReply = false;
            lostReply.resolve();
            const settled = releaseLostReply.promise.then(async () => {
              const admission = deliver();
              await Promise.resolve(admission.settled);
              lostReplyDelivered.resolve();
            });
            return createSubAgentTransportPeerWriterAdmission(settled);
          }
          return deliver();
        },
      });
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const payload = modelPayload(created, 'old-model-reply-loss');
      const lostModel = harness.target.modelExchange({
        taskId: created.taskId,
        operationId: payload.providerOperationId,
        payload,
        signal: lostRequest.signal,
      });
      void lostModel.catch(() => undefined);
      await lostReply.promise;
      lostRequest.abort(new Error('controller Model reply was lost after admission'));
      await expect(within(lostModel, 'admitted Model reply-loss failure')).rejects.toMatchObject({
        descriptor: {
          code: 'EXECUTOR_FAILED',
          causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        },
      });
      releaseLostReply.resolve();
      await lostReplyDelivered.promise;
      expect(modelRequestPackets).toBe(1);
      expect(model).toHaveBeenCalledTimes(1);
      expect(providerEffectCount).toBe(1);

      const blockedConnection = harness.connect();
      await expect(
        blockedConnection.controller.spawn(
          createReconnectRequest(
            created,
            createBinding(created),
            'reconnect-before-model-reply-loss-lookup',
          ),
          createHostControl().control,
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
      expect(harness.factory).toHaveBeenCalledTimes(1);

      const tamperedContext = Object.freeze([
        Object.freeze({ role: 'user', content: 'tampered while preserving the old hash' }),
      ]);
      const preservedHashTamper = Object.freeze({
        ...payload,
        context: tamperedContext,
      });
      await expect(
        harness.target.modelExchange({
          taskId: created.taskId,
          operationId: payload.providerOperationId,
          payload: preservedHashTamper,
        }),
      ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
      expect(modelRequestPackets).toBe(1);
      expect(model).toHaveBeenCalledTimes(1);
      expect(providerEffectCount).toBe(1);

      const differentHashPayload = Object.freeze({
        ...payload,
        context: tamperedContext,
        requestHash: hashSubAgentTransportModelRequest({
          gatewayId: payload.gatewayId,
          protocol: payload.protocol,
          codecVersion: payload.codecVersion,
          runId: payload.runId,
          checkpointOperationId: payload.checkpointOperationId,
          checkpointDigest: payload.checkpointDigest,
          purpose: payload.purpose,
          iteration: payload.iteration,
          requestAttempt: payload.requestAttempt,
          context: tamperedContext,
          tools: payload.tools,
        }),
      });
      await expect(
        harness.target.modelExchange({
          taskId: created.taskId,
          operationId: payload.providerOperationId,
          payload: differentHashPayload,
        }),
      ).rejects.toMatchObject({
        descriptor: { code: 'EXECUTOR_FAILED', outcomeUnknown: true },
      });
      expect(modelRequestPackets).toBe(1);
      expect(model).toHaveBeenCalledTimes(1);
      expect(providerEffectCount).toBe(1);

      await expect(oldHandle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'running',
      });

      await expect(
        harness.target.modelExchange({
          taskId: created.taskId,
          operationId: payload.providerOperationId,
          payload,
        }),
      ).resolves.toMatchObject({ ok: true, requestHash: payload.requestHash });
      expect(modelRequestPackets).toBe(2);
      expect(model).toHaveBeenCalledTimes(2);
      expect(providerEffectCount).toBe(1);

      const second = harness.connect();
      const reconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-after-model-reply-loss-lookup',
      );
      const recoveredHandle = await second.controller.spawn(reconnect, createHostControl().control);
      if (!('taskId' in recoveredHandle)) throw new Error('Expected a recovered task handle.');
      await recoveredStarted.promise;
      expect(harness.factory).toHaveBeenCalledTimes(2);

      releaseRecovered.resolve();
      await expect(recoveredHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
    } finally {
      lostRequest.abort();
      releaseLostReply.resolve();
      releaseRecovered.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('forces an outcome-unknown receipt when the runner settles after an admitted Model request aborts', async () => {
    const checkpointReady = deferred();
    const modelStarted = deferred();
    const releaseModel = deferred();
    const releaseRunner = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 1 });
    const modelRequest = new AbortController();
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-admitted-model-abort', checkpoint);
        checkpointReady.resolve();
        await releaseRunner.promise;
        return terminalOutcome(request);
      },
    };
    const model = vi.fn(async (context: SubAgentTransportModelRequestContext) => {
      modelStarted.resolve();
      await releaseModel.promise;
      return modelReply(context.payload);
    });
    const harness = createHarness({
      runners: [oldRunner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    try {
      const first = harness.connect(model);
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const payload = modelPayload(created, 'admitted-model-abort-before-runner-settle');
      const abortedModel = harness.target.modelExchange({
        taskId: created.taskId,
        operationId: payload.providerOperationId,
        payload,
        signal: modelRequest.signal,
      });
      void abortedModel.catch(() => undefined);
      await modelStarted.promise;
      modelRequest.abort(new Error('host abandoned the admitted Model lookup'));
      await expect(within(abortedModel, 'admitted Model abort')).rejects.toMatchObject({
        descriptor: {
          code: 'EXECUTOR_FAILED',
          causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        },
      });

      releaseRunner.resolve();
      await expect(oldHandle.wait()).rejects.toMatchObject({
        code: 'EXECUTOR_FAILED',
        descriptor: { causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN', outcomeUnknown: true },
      });
      expect(model).toHaveBeenCalledTimes(1);

      const reconnectConnection = harness.connect();
      await expect(
        reconnectConnection.controller.spawn(
          createReconnectRequest(
            created,
            createBinding(created),
            'reconnect-after-admitted-model-abort',
          ),
          createHostControl().control,
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
      expect(harness.factory).toHaveBeenCalledTimes(1);
    } finally {
      modelRequest.abort();
      releaseRunner.resolve();
      releaseModel.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('single-flights a Model operation and keeps its authoritative outcome-unknown reply terminal', async () => {
    const checkpointReady = deferred();
    const firstModelStarted = deferred();
    const releaseFirstModel = deferred();
    const releaseOld = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 1 });
    let modelCallCount = 0;
    let modelRequestPackets = 0;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-duplicate-model-race', checkpoint);
        checkpointReady.resolve();
        await releaseOld.promise;
        return terminalOutcome(request);
      },
    };
    const model = vi.fn(async (context: SubAgentTransportModelRequestContext) => {
      modelCallCount += 1;
      if (modelCallCount !== 1) {
        throw new Error('A single-flight Model operation must not be sent twice.');
      }
      firstModelStarted.resolve();
      await releaseFirstModel.promise;
      return modelFailureReply(context.payload, true);
    });
    const harness = createHarness({
      runners: [oldRunner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    try {
      const first = harness.connect({
        model,
        targetToController: (packet, deliver) => {
          if (packetEnvelope(packet).kind === 'model.request') modelRequestPackets += 1;
          return deliver();
        },
      });
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const payload = modelPayload(created, 'duplicate-model-outcome-race');
      const firstModel = harness.target.modelExchange({
        taskId: created.taskId,
        operationId: payload.providerOperationId,
        payload,
      });
      void firstModel.catch(() => undefined);
      await firstModelStarted.promise;
      const secondModel = harness.target.modelExchange({
        taskId: created.taskId,
        operationId: payload.providerOperationId,
        payload,
      });
      await expect(secondModel).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(modelRequestPackets).toBe(1);
      expect(model).toHaveBeenCalledTimes(1);

      releaseFirstModel.resolve();
      await expect(firstModel).resolves.toMatchObject({
        ok: false,
        error: { outcomeUnknown: true },
      });

      await expect(
        harness.target.modelExchange({
          taskId: created.taskId,
          operationId: payload.providerOperationId,
          payload,
        }),
      ).rejects.toMatchObject({
        descriptor: { code: 'EXECUTOR_FAILED', outcomeUnknown: true },
      });
      expect(modelRequestPackets).toBe(1);
      expect(model).toHaveBeenCalledTimes(1);

      const second = harness.connect();
      await expect(
        second.controller.spawn(
          createReconnectRequest(
            created,
            createBinding(created),
            'reconnect-after-terminal-model-unknown',
          ),
          createHostControl().control,
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
      expect(harness.factory).toHaveBeenCalledTimes(1);

      releaseOld.resolve();
      await expect(oldHandle.wait()).rejects.toMatchObject({
        code: 'EXECUTOR_FAILED',
        descriptor: { causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN', outcomeUnknown: true },
      });
      await expect(oldHandle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'failed',
      });
    } finally {
      releaseFirstModel.resolve();
      releaseOld.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('aborts runner access before returning an authoritative outcome-unknown Model reply', async () => {
    const initialCheckpointReady = deferred();
    const authoritativeReplyObserved = deferred();
    const postUnknownCheckpointAttempted = deferred();
    const initialCheckpoint = childCheckpoint({ modelIteration: 1 });
    const modelExchangeRef: { current?: SubAgentTransportModelExchange } = {};
    let observedReply: SubAgentTransportRpcPayloadMap['model.reply'] | undefined;
    let requestSignalAborted = false;
    let controlSignalAborted = false;
    let postUnknownCheckpointFailure: unknown;
    let controlRequestPackets = 0;
    let controlRequestBaseline = 0;
    const runner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint(
          'checkpoint-before-authoritative-model-unknown',
          initialCheckpoint,
        );
        controlRequestBaseline = controlRequestPackets;
        initialCheckpointReady.resolve();
        const exchangeModel = modelExchangeRef.current;
        if (exchangeModel === undefined) throw new Error('Expected the target Model exchange.');
        const payload = modelPayload(request, 'authoritative-model-outcome-unknown');
        observedReply = await exchangeModel({
          taskId: request.taskId,
          operationId: payload.providerOperationId,
          payload,
        });
        requestSignalAborted = request.signal.aborted;
        controlSignalAborted = control.signal.aborted;
        authoritativeReplyObserved.resolve();
        try {
          await control.commitCheckpoint(
            'checkpoint-after-authoritative-model-unknown',
            childCheckpoint({ modelIteration: 2 }),
          );
        } catch (error) {
          postUnknownCheckpointFailure = error;
        }
        postUnknownCheckpointAttempted.resolve();
        return terminalOutcome(request);
      },
    };
    const checkpointCommitted = vi.fn(async () => undefined);
    const model = vi.fn(async (context: SubAgentTransportModelRequestContext) =>
      modelFailureReply(context.payload, true),
    );
    const harness = createHarness({
      runners: [runner],
      externalReconnect: true,
      checkpointCommitted,
    });
    modelExchangeRef.current = harness.target.modelExchange;
    try {
      const first = harness.connect({
        model,
        targetToController: (packet, deliver) => {
          if (packetEnvelope(packet).kind === 'control.request') controlRequestPackets += 1;
          return deliver();
        },
      });
      const created = createRequest();
      const host = createHostControl();
      const handle = await first.controller.spawn(created, host.control);
      if (!('taskId' in handle)) throw new Error('Expected an accepted task handle.');
      await initialCheckpointReady.promise;
      await within(authoritativeReplyObserved.promise, 'authoritative Model unknown reply');
      await within(
        postUnknownCheckpointAttempted.promise,
        'post-unknown runner checkpoint rejection',
      );

      expect(observedReply).toMatchObject({
        ok: false,
        error: { code: 'EXECUTOR_FAILED', outcomeUnknown: true },
      });
      expect(requestSignalAborted).toBe(true);
      expect(controlSignalAborted).toBe(true);
      expect(postUnknownCheckpointFailure).toBeDefined();
      expect(controlRequestBaseline).toBe(2);
      expect(controlRequestPackets).toBe(controlRequestBaseline);
      expect(host.commitCheckpoint).toHaveBeenCalledTimes(1);
      expect(host.commitCheckpoint).toHaveBeenCalledWith(
        'checkpoint-before-authoritative-model-unknown',
        expect.anything(),
      );
      expect(checkpointCommitted).toHaveBeenCalledTimes(1);
      expect(model).toHaveBeenCalledTimes(1);

      await expect(handle.wait()).rejects.toMatchObject({
        code: 'EXECUTOR_FAILED',
        descriptor: { causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN', outcomeUnknown: true },
      });
      await expect(handle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'failed',
      });

      const resumeConnection = harness.connect();
      await expect(
        resumeConnection.controller.spawn(
          createResumeRequest(
            created,
            createBinding(created),
            'resume-after-authoritative-model-unknown',
            initialCheckpoint,
          ),
          createHostControl().control,
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
      const reconnectConnection = harness.connect();
      await expect(
        reconnectConnection.controller.spawn(
          createReconnectRequest(
            created,
            createBinding(created),
            'reconnect-after-authoritative-model-unknown',
          ),
          createHostControl().control,
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
      expect(harness.factory).toHaveBeenCalledTimes(1);
      expect(controlRequestPackets).toBe(controlRequestBaseline);
      expect(host.commitCheckpoint).toHaveBeenCalledTimes(1);
      expect(checkpointCommitted).toHaveBeenCalledTimes(1);
    } finally {
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it.each(['active-signal-abort', 'absolute-deadline-cross'] as const)(
    'classifies a known controller Model result at the target boundary when %s wins before target consumption',
    async (variant) => {
      const runnerStarted = deferred();
      const releaseRunner = deferred();
      const replyReady = deferred();
      const releaseReply = deferred();
      const replyDelivered = deferred();
      const modelSignal = new AbortController();
      let targetTime = NOW;
      let delayReply = true;
      const runner: SubAgentChildRunner = {
        run: async (request) => {
          runnerStarted.resolve();
          await releaseRunner.promise;
          return terminalOutcome(request);
        },
      };
      const model = vi.fn(async (context: SubAgentTransportModelRequestContext) =>
        modelReply(context.payload),
      );
      const harness = createHarness({
        runners: [runner],
        externalReconnect: true,
        checkpointCommitted: async () => undefined,
        now: () => NOW,
        targetNow: () => targetTime,
      });
      try {
        const first = harness.connect({
          model,
          controllerToTarget: (packet, deliver) => {
            if (delayReply && packetEnvelope(packet).kind === 'model.reply') {
              delayReply = false;
              replyReady.resolve();
              const settled = releaseReply.promise.then(async () => {
                const admission = deliver();
                await Promise.resolve(admission.settled);
                replyDelivered.resolve();
              });
              return createSubAgentTransportPeerWriterAdmission(settled);
            }
            return deliver();
          },
        });
        const created = createRequest();
        const handle = await first.controller.spawn(created, createHostControl().control);
        if (!('taskId' in handle)) throw new Error('Expected an accepted task handle.');
        await runnerStarted.promise;

        const payload = modelPayload(created, `known-model-${variant}`);
        const modelSettlement = harness.target
          .modelExchange({
            taskId: created.taskId,
            operationId: payload.providerOperationId,
            payload,
            ...(variant === 'active-signal-abort' ? { signal: modelSignal.signal } : {}),
          })
          .then(
            (value) => Object.freeze({ status: 'fulfilled' as const, value }),
            (reason: unknown) => Object.freeze({ status: 'rejected' as const, reason }),
          );
        await replyReady.promise;
        if (variant === 'active-signal-abort') {
          modelSignal.abort(new Error('active Model consumption was cancelled'));
        } else {
          targetTime = created.deadlineAt;
        }
        releaseReply.resolve();
        await replyDelivered.promise;

        const modelResult = await within(modelSettlement, `known Model ${variant} settlement`);
        if (variant === 'active-signal-abort') {
          expect(modelResult).toMatchObject({
            status: 'rejected',
            reason: {
              code: 'EXECUTOR_FAILED',
              descriptor: {
                causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN',
                outcomeUnknown: true,
              },
            },
          });
        } else if (modelResult.status === 'fulfilled') {
          expect(modelResult.value).toMatchObject({ ok: true, requestHash: payload.requestHash });
        } else {
          expect(modelResult.reason).not.toMatchObject({
            descriptor: {
              causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN',
              outcomeUnknown: true,
            },
          });
        }
        expect(model).toHaveBeenCalledTimes(1);

        releaseRunner.resolve();
        if (variant === 'active-signal-abort') {
          await expect(handle.wait()).rejects.toMatchObject({
            code: 'EXECUTOR_FAILED',
            descriptor: {
              causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN',
              outcomeUnknown: true,
            },
          });
          await expect(handle.snapshot()).resolves.toMatchObject({
            taskId: created.taskId,
            state: 'failed',
          });
        } else {
          await expect(handle.wait()).resolves.toEqual(terminalOutcome(created));
          await expect(handle.snapshot()).resolves.toMatchObject({
            taskId: created.taskId,
            state: 'succeeded',
          });
        }
        expect(model).toHaveBeenCalledTimes(1);
      } finally {
        modelSignal.abort();
        releaseReply.resolve();
        releaseRunner.resolve();
        await harness.forceDispose().catch(() => undefined);
      }
    },
  );

  it('keeps an exact authoritative outcome-unknown Model reply terminal across a deadline race', async () => {
    const runnerStarted = deferred();
    const releaseRunner = deferred();
    const replyReady = deferred();
    const releaseReply = deferred();
    const replyDelivered = deferred();
    let targetTime = NOW;
    let delayReply = true;
    const runner: SubAgentChildRunner = {
      run: async (request) => {
        runnerStarted.resolve();
        await releaseRunner.promise;
        return terminalOutcome(request);
      },
    };
    const model = vi.fn(async (context: SubAgentTransportModelRequestContext) =>
      modelFailureReply(context.payload, true),
    );
    const harness = createHarness({
      runners: [runner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      now: () => NOW,
      targetNow: () => targetTime,
    });
    try {
      const first = harness.connect({
        model,
        controllerToTarget: (packet, deliver) => {
          if (delayReply && packetEnvelope(packet).kind === 'model.reply') {
            delayReply = false;
            replyReady.resolve();
            const settled = releaseReply.promise.then(async () => {
              const admission = deliver();
              await Promise.resolve(admission.settled);
              replyDelivered.resolve();
            });
            return createSubAgentTransportPeerWriterAdmission(settled);
          }
          return deliver();
        },
      });
      const created = createRequest();
      const handle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in handle)) throw new Error('Expected an accepted task handle.');
      await runnerStarted.promise;

      const payload = modelPayload(created, 'unknown-model-deadline-race');
      const modelSettlement = harness.target
        .modelExchange({
          taskId: created.taskId,
          operationId: payload.providerOperationId,
          payload,
        })
        .then(
          (value) => Object.freeze({ status: 'fulfilled' as const, value }),
          (reason: unknown) => Object.freeze({ status: 'rejected' as const, reason }),
        );
      await replyReady.promise;
      targetTime = created.deadlineAt;
      releaseReply.resolve();
      await replyDelivered.promise;
      await within(modelSettlement, 'authoritative unknown deadline-race settlement');
      expect(model).toHaveBeenCalledTimes(1);

      releaseRunner.resolve();
      await expect(handle.wait()).rejects.toMatchObject({
        code: 'EXECUTOR_FAILED',
        descriptor: { causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN', outcomeUnknown: true },
      });
      await expect(handle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'failed',
      });
      expect(model).toHaveBeenCalledTimes(1);
    } finally {
      releaseReply.resolve();
      releaseRunner.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('terminalizes an admitted pending Model operation when the runner settles before its reply', async () => {
    const checkpointReady = deferred();
    const modelStarted = deferred();
    const releaseModel = deferred();
    const releaseRunner = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 1 });
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-floating-model-settlement', checkpoint);
        checkpointReady.resolve();
        await releaseRunner.promise;
        return terminalOutcome(request);
      },
    };
    const model = vi.fn(async (context: SubAgentTransportModelRequestContext) => {
      modelStarted.resolve();
      await releaseModel.promise;
      return modelReply(context.payload);
    });
    const harness = createHarness({
      runners: [oldRunner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    try {
      const first = harness.connect(model);
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const payload = modelPayload(created, 'floating-model-before-runner-settlement');
      const pendingModel = harness.target.modelExchange({
        taskId: created.taskId,
        operationId: payload.providerOperationId,
        payload,
      });
      void pendingModel.catch(() => undefined);
      await modelStarted.promise;

      releaseRunner.resolve();
      await expect(oldHandle.wait()).rejects.toMatchObject({
        code: 'EXECUTOR_FAILED',
        descriptor: { causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN', outcomeUnknown: true },
      });
      releaseModel.resolve();
      await expect(
        within(pendingModel, 'late definitive Model reply after runner settlement'),
      ).rejects.toMatchObject({
        descriptor: { code: 'EXECUTOR_FAILED', outcomeUnknown: true },
      });
      expect(model).toHaveBeenCalledTimes(1);

      const resumeConnection = harness.connect();
      await expect(
        resumeConnection.controller.spawn(
          createResumeRequest(
            created,
            createBinding(created),
            'checkpoint-resume-after-floating-model-unknown',
            checkpoint,
          ),
          createHostControl().control,
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
      const reconnectConnection = harness.connect();
      await expect(
        reconnectConnection.controller.spawn(
          createReconnectRequest(
            created,
            createBinding(created),
            'reconnect-after-floating-model-unknown',
          ),
          createHostControl().control,
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
      expect(harness.factory).toHaveBeenCalledTimes(1);
    } finally {
      releaseRunner.resolve();
      releaseModel.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('does not record provider uncertainty when a closed old Peer rejects a Model request before admission', async () => {
    const checkpointReady = deferred();
    const recoveredStarted = deferred();
    const releaseRecovered = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 1 });
    let modelRequestPackets = 0;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-pre-admission-model-close', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const recoveredRunner: SubAgentChildRunner = {
      run: async (request) => {
        recoveredStarted.resolve();
        await releaseRecovered.promise;
        return terminalOutcome(request);
      },
    };
    const model = vi.fn(async (context: SubAgentTransportModelRequestContext) =>
      modelReply(context.payload),
    );
    const harness = createHarness({
      runners: [oldRunner, recoveredRunner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    try {
      const first = harness.connect({
        model,
        targetToController: (packet, deliver) => {
          if (packetEnvelope(packet).kind === 'model.request') modelRequestPackets += 1;
          return deliver();
        },
      });
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      first.targetPeer.close();
      const payload = modelPayload(created, 'pre-admission-closed-model');
      await expect(
        harness.target.modelExchange({
          taskId: created.taskId,
          operationId: payload.providerOperationId,
          payload,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(modelRequestPackets).toBe(0);
      expect(model).not.toHaveBeenCalled();

      const second = harness.connect();
      const reconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-after-pre-admission-model-close',
      );
      const recoveredHandle = await second.controller.spawn(reconnect, createHostControl().control);
      if (!('taskId' in recoveredHandle)) throw new Error('Expected a recovered task handle.');
      await recoveredStarted.promise;
      expect(harness.factory).toHaveBeenCalledTimes(2);

      releaseRecovered.resolve();
      await expect(recoveredHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
    } finally {
      releaseRecovered.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('does not admit a Model packet when its channel resolver crosses the absolute deadline', async () => {
    const checkpointReady = deferred();
    const recoveredStarted = deferred();
    const releaseRecovered = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 1 });
    let targetTime = NOW;
    let deadlineChannelId: string | undefined;
    let crossDeadlineOnResolve = false;
    let modelRequestPackets = 0;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-model-resolver-deadline', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const recoveredRunner: SubAgentChildRunner = {
      run: async (request) => {
        recoveredStarted.resolve();
        await releaseRecovered.promise;
        return terminalOutcome(request);
      },
    };
    const model = vi.fn(async (context: SubAgentTransportModelRequestContext) =>
      modelReply(context.payload),
    );
    const harness = createHarness({
      runners: [oldRunner, recoveredRunner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      now: () => NOW,
      targetNow: () => targetTime,
      resolveTargetPeer: ({ channelId }) => {
        if (crossDeadlineOnResolve && channelId === deadlineChannelId) {
          crossDeadlineOnResolve = false;
          targetTime = NOW + 100;
        }
      },
    });
    try {
      const first = harness.connect({
        model,
        targetToController: (packet, deliver) => {
          if (packetEnvelope(packet).kind === 'model.request') modelRequestPackets += 1;
          return deliver();
        },
      });
      deadlineChannelId = first.channelId;
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const payload = modelPayload(created, 'model-resolver-crosses-deadline');
      crossDeadlineOnResolve = true;
      await expect(
        harness.target.modelExchange({
          taskId: created.taskId,
          operationId: payload.providerOperationId,
          payload,
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({ code: 'TIMED_OUT' });
      expect(targetTime).toBe(NOW + 100);
      expect(modelRequestPackets).toBe(0);
      expect(model).not.toHaveBeenCalled();

      targetTime = NOW;
      await expect(
        harness.target.modelExchange({
          taskId: created.taskId,
          operationId: payload.providerOperationId,
          payload,
          timeoutMs: 100,
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(modelRequestPackets).toBe(1);
      expect(model).toHaveBeenCalledTimes(1);

      const second = harness.connect();
      const reconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-after-model-resolver-deadline',
      );
      const recoveredHandle = await second.controller.spawn(reconnect, createHostControl().control);
      if (!('taskId' in recoveredHandle)) throw new Error('Expected a recovered task handle.');
      await recoveredStarted.promise;
      expect(harness.factory).toHaveBeenCalledTimes(2);

      releaseRecovered.resolve();
      await expect(recoveredHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
    } finally {
      releaseRecovered.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('rejects a live reconnect before a fresh factory when the resident has no checkpoint', async () => {
    const ready = deferred();
    const release = deferred();
    let oldSignal: AbortSignal | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request) => {
        oldSignal = request.signal;
        ready.resolve();
        await release.promise;
        return terminalOutcome(request);
      },
    };
    const checkpointCommitted = vi.fn(async () => undefined);
    const harness = createHarness({
      runners: [oldRunner],
      externalReconnect: true,
      checkpointCommitted,
    });
    const first = harness.connect();
    const created = createRequest();
    const handle = await first.controller.spawn(created, createHostControl().control);
    if (!('taskId' in handle)) throw new Error('Expected a task handle.');
    await ready.promise;

    const second = harness.connect();
    await expect(
      second.controller.execute(
        createReconnectRequest(created, createBinding(created), 'reconnect-without-checkpoint'),
        createHostControl().control,
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
    expect(harness.factory).toHaveBeenCalledTimes(1);
    expect(oldSignal?.aborted).toBe(false);

    release.resolve();
    await expect(handle.wait()).resolves.toEqual(terminalOutcome(created));
    await harness.dispose();
  });

  it('rejects an incompatible checkpoint acknowledgement and keeps live reconnect unavailable', async () => {
    const checkpointAttempted = deferred();
    const release = deferred();
    let checkpointFailure: unknown;
    let oldSignal: AbortSignal | undefined;
    const checkpointCommitted = vi.fn(async () => undefined);
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        oldSignal = request.signal;
        try {
          await control.commitCheckpoint(
            'checkpoint-incompatible',
            childCheckpoint({ runnerId: 'different-runner' }),
          );
        } catch (error) {
          checkpointFailure = error;
        }
        checkpointAttempted.resolve();
        await release.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [oldRunner],
      externalReconnect: true,
      checkpointCommitted,
    });
    const first = harness.connect();
    const created = createRequest();
    const host = createHostControl();
    const handle = await first.controller.spawn(created, host.control);
    if (!('taskId' in handle)) throw new Error('Expected a task handle.');
    await checkpointAttempted.promise;
    expect(checkpointFailure).toMatchObject({ code: 'CHECKPOINT_VERSION_MISMATCH' });
    expect(host.commitCheckpoint).not.toHaveBeenCalled();
    expect(checkpointCommitted).not.toHaveBeenCalled();
    expect(harness.factory).toHaveBeenCalledTimes(1);
    expect(oldSignal?.aborted).toBe(false);

    const second = harness.connect();
    await expect(
      second.controller.execute(
        createReconnectRequest(
          created,
          createBinding(created),
          'reconnect-after-incompatible-checkpoint',
        ),
        createHostControl().control,
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
    expect(harness.factory).toHaveBeenCalledTimes(1);
    expect(oldSignal?.aborted).toBe(false);

    release.resolve();
    await expect(handle.wait()).resolves.toEqual(terminalOutcome(created));
    await harness.dispose();
  });

  it('does not make a controller-rejected checkpoint eligible for reconnect', async () => {
    const checkpointAttempted = deferred();
    const release = deferred();
    let checkpointFailure: unknown;
    const checkpointCommitted = vi.fn(async () => undefined);
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        try {
          await control.commitCheckpoint('checkpoint-rejected', childCheckpoint());
        } catch (error) {
          checkpointFailure = error;
        }
        checkpointAttempted.resolve();
        await release.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [oldRunner],
      externalReconnect: true,
      checkpointCommitted,
    });
    const first = harness.connect();
    const created = createRequest();
    const host = createHostControl({
      commitCheckpoint: async () => {
        throw new Error('controller durable checkpoint rejected');
      },
    });
    const handle = await first.controller.spawn(created, host.control);
    if (!('taskId' in handle)) throw new Error('Expected a task handle.');
    await checkpointAttempted.promise;
    expect(checkpointFailure).toBeDefined();
    expect(host.commitCheckpoint).toHaveBeenCalledTimes(1);
    expect(checkpointCommitted).not.toHaveBeenCalled();

    const second = harness.connect();
    await expect(
      second.controller.execute(
        createReconnectRequest(
          created,
          createBinding(created),
          'reconnect-after-controller-reject',
        ),
        createHostControl().control,
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
    expect(harness.factory).toHaveBeenCalledTimes(1);

    release.resolve();
    await expect(handle.wait()).resolves.toEqual(terminalOutcome(created));
    await harness.dispose();
  });

  it('does not make a checkpoint eligible when the fencing-aware durable hook rejects it', async () => {
    const checkpointAttempted = deferred();
    const release = deferred();
    let checkpointFailure: unknown;
    const hookFailure = new Error('target durable checkpoint rejected');
    const checkpointCommitted = vi.fn(
      async (context: SubAgentTransportTargetCheckpointCommitContext) => {
        expect(context).toMatchObject({
          operationId: 'checkpoint-hook-rejected',
          ownerSessionId: 'owner-session-1',
          taskId: 'task-1',
          executionAttempt: 1,
          executionEpoch: 'epoch-1',
          executionFencingToken: '1',
        });
        throw hookFailure;
      },
    );
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        try {
          await control.commitCheckpoint('checkpoint-hook-rejected', childCheckpoint());
        } catch (error) {
          checkpointFailure = error;
        }
        checkpointAttempted.resolve();
        await release.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [oldRunner],
      externalReconnect: true,
      checkpointCommitted,
    });
    const first = harness.connect();
    const created = createRequest();
    const host = createHostControl();
    const handle = await first.controller.spawn(created, host.control);
    if (!('taskId' in handle)) throw new Error('Expected a task handle.');
    await checkpointAttempted.promise;
    expect(host.commitCheckpoint).toHaveBeenCalledTimes(1);
    expect(checkpointCommitted).toHaveBeenCalledTimes(1);
    expect(checkpointFailure).toBe(hookFailure);

    const second = harness.connect();
    await expect(
      second.controller.execute(
        createReconnectRequest(created, createBinding(created), 'reconnect-after-hook-reject'),
        createHostControl().control,
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
    expect(harness.factory).toHaveBeenCalledTimes(1);

    release.resolve();
    await expect(handle.wait()).resolves.toEqual(terminalOutcome(created));
    await harness.dispose();
  });

  it.each([
    { label: 'the same durable checkpoint operation', retryOperationId: 'checkpoint-b' },
    { label: 'a newer durable checkpoint operation', retryOperationId: 'checkpoint-c' },
  ])(
    'keeps an acknowledged reply-loss gap closed to reconnect until $label completes',
    async ({ retryOperationId }) => {
      let now = NOW;
      const checkpointAReady = deferred();
      const startLostCheckpoint = deferred();
      const lostCheckpointFailed = deferred();
      const retryCheckpoint = deferred();
      const retryCheckpointComplete = deferred();
      const lostReplyDelivered = deferred();
      const newStarted = deferred();
      const releaseNew = deferred();
      const checkpointA = childCheckpoint({ modelIteration: 1 });
      const checkpointB = childCheckpoint({ modelIteration: 2 });
      const checkpointC = childCheckpoint({ modelIteration: 3 });
      const recoveredCheckpoint = retryOperationId === 'checkpoint-b' ? checkpointB : checkpointC;
      let lostCheckpointFailure: unknown;
      let oldSignal: AbortSignal | undefined;
      let recoveredRequest: SubAgentChildRunRequest | undefined;
      const checkpointCommitted = vi.fn(async () => undefined);
      const oldRunner: SubAgentChildRunner = {
        run: async (request, control) => {
          oldSignal = request.signal;
          await control.commitCheckpoint('checkpoint-a', checkpointA);
          checkpointAReady.resolve();
          await startLostCheckpoint.promise;
          try {
            await control.commitCheckpoint('checkpoint-b', checkpointB);
          } catch (error) {
            lostCheckpointFailure = error;
          }
          lostCheckpointFailed.resolve();
          const retryDisposition = await Promise.race([
            retryCheckpoint.promise.then(() => 'retry' as const),
            waitForAbort(request.signal).then(() => 'aborted' as const),
          ]);
          if (retryDisposition === 'aborted') return terminalOutcome(request, 'cancelled');
          await control.commitCheckpoint(retryOperationId, recoveredCheckpoint);
          retryCheckpointComplete.resolve();
          await waitForAbort(request.signal);
          return terminalOutcome(request, 'cancelled');
        },
      };
      const newRunner: SubAgentChildRunner = {
        run: async (request) => {
          recoveredRequest = request;
          newStarted.resolve();
          await releaseNew.promise;
          return terminalOutcome(request);
        },
      };
      let delayed = false;
      const harness = createHarness({
        runners: [oldRunner, newRunner],
        externalReconnect: true,
        checkpointCommitted,
        now: () => now,
      });
      const first = harness.connect({
        controllerToTarget: (packet, deliver) => {
          const envelope = packetEnvelope(packet);
          if (
            !delayed &&
            envelope.kind === 'control.reply' &&
            envelope.operationId === 'checkpoint-b'
          ) {
            delayed = true;
            return delayedAdmission(25, deliver, lostReplyDelivered);
          }
          return deliver();
        },
      });
      const created = createRequest();
      const host = createHostControl();
      const oldHandle = await first.controller.spawn(created, host.control);
      if (!('taskId' in oldHandle)) throw new Error('Expected a task handle.');
      await checkpointAReady.promise;

      now = created.deadlineAt - 5;
      startLostCheckpoint.resolve();
      await lostCheckpointFailed.promise;
      expect(lostCheckpointFailure).toBeDefined();
      now = NOW;
      await lostReplyDelivered.promise;
      expect(checkpointCommitted).toHaveBeenCalledTimes(1);

      const blockedConnection = harness.connect();
      await expect(
        blockedConnection.controller.spawn(
          createReconnectRequest(created, createBinding(created), 'reconnect-with-checkpoint-gap'),
          createHostControl().control,
        ),
      ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
      expect(harness.factory).toHaveBeenCalledTimes(1);
      expect(oldSignal?.aborted).toBe(false);

      retryCheckpoint.resolve();
      await retryCheckpointComplete.promise;
      expect(checkpointCommitted).toHaveBeenCalledTimes(2);
      expect(host.commitCheckpoint).toHaveBeenCalledTimes(3);
      expect(host.commitCheckpoint.mock.calls.map(([operationId]) => operationId)).toEqual([
        'checkpoint-a',
        'checkpoint-b',
        retryOperationId,
      ]);

      const recoveredConnection = harness.connect();
      const reconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-after-checkpoint-gap-closed',
        {
          attempt: 3,
          executionEpoch: 'epoch-3',
          executionFencingToken: '3',
        },
      );
      const newHandle = await recoveredConnection.controller.spawn(
        reconnect,
        createHostControl().control,
      );
      if (!('taskId' in newHandle)) throw new Error('Expected a reconnected task handle.');
      await newStarted.promise;
      expect(harness.factory).toHaveBeenCalledTimes(2);
      expect(recoveredRequest?.checkpoint).toEqual(recoveredCheckpoint);
      expect(recoveredRequest).toMatchObject({
        attempt: 3,
        executionEpoch: 'epoch-3',
        executionFencingToken: '3',
      });

      releaseNew.resolve();
      await expect(newHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
      await harness.dispose();
    },
  );

  it('keeps the last durable checkpoint eligible when the old Peer fails before a new commit is admitted', async () => {
    const checkpointAReady = deferred();
    const attemptCheckpointB = deferred();
    const checkpointBFailed = deferred();
    const freshStarted = deferred();
    const releaseFresh = deferred();
    const checkpointA = childCheckpoint({ modelIteration: 3 });
    const checkpointB = childCheckpoint({ modelIteration: 4 });
    let checkpointFailure: unknown;
    let recoveredRequest: SubAgentChildRunRequest | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-old-peer-close', checkpointA);
        checkpointAReady.resolve();
        await attemptCheckpointB.promise;
        try {
          await control.commitCheckpoint('checkpoint-after-old-peer-close', checkpointB);
        } catch (error) {
          checkpointFailure = error;
        }
        checkpointBFailed.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const freshRunner: SubAgentChildRunner = {
      run: async (request) => {
        recoveredRequest = request;
        freshStarted.resolve();
        await releaseFresh.promise;
        return terminalOutcome(request);
      },
    };
    const checkpointCommitted = vi.fn(async () => undefined);
    const harness = createHarness({
      runners: [oldRunner, freshRunner],
      externalReconnect: true,
      checkpointCommitted,
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointAReady.promise;
      expect(checkpointCommitted).toHaveBeenCalledTimes(1);

      first.targetPeer.close();
      attemptCheckpointB.resolve();
      await within(checkpointBFailed.promise, 'closed-Peer checkpoint admission failure');
      expect(checkpointFailure).toBeDefined();
      expect(checkpointCommitted).toHaveBeenCalledTimes(1);

      const second = harness.connect();
      const reconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-after-unadmitted-checkpoint',
      );
      const recoveredHandle = await second.controller.spawn(reconnect, createHostControl().control);
      if (!('taskId' in recoveredHandle)) throw new Error('Expected a recovered task handle.');
      await freshStarted.promise;
      expect(recoveredRequest?.checkpoint).toEqual(checkpointA);
      expect(recoveredRequest?.checkpoint).not.toEqual(checkpointB);
      expect(harness.factory).toHaveBeenCalledTimes(2);

      releaseFresh.resolve();
      await expect(recoveredHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
    } finally {
      releaseFresh.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it.each(['delivered-then-throw', 'invalid-receipt'] as const)(
    'keeps reconnect closed when a checkpoint writer has an outcome-unknown $variant failure',
    async (variant) => {
      const checkpointAReady = deferred();
      const attemptCheckpointB = deferred();
      const checkpointBFailed = deferred();
      const releaseOld = deferred();
      const checkpointA = childCheckpoint({ modelIteration: 3 });
      const checkpointB = childCheckpoint({ modelIteration: 4 });
      let checkpointFailure: unknown;
      let oldSignal: AbortSignal | undefined;
      const oldRunner: SubAgentChildRunner = {
        run: async (request, control) => {
          oldSignal = request.signal;
          await control.commitCheckpoint('checkpoint-before-unknown-writer', checkpointA);
          checkpointAReady.resolve();
          await attemptCheckpointB.promise;
          try {
            await control.commitCheckpoint('checkpoint-unknown-writer', checkpointB);
          } catch (error) {
            checkpointFailure = error;
          }
          checkpointBFailed.resolve();
          await releaseOld.promise;
          return terminalOutcome(request);
        },
      };
      const harness = createHarness({
        runners: [oldRunner],
        externalReconnect: true,
        checkpointCommitted: async () => undefined,
      });
      try {
        const first = harness.connect({
          targetToController: (packet, deliver) => {
            const envelope = packetEnvelope(packet);
            if (
              envelope.kind !== 'control.request' ||
              envelope.operationId !== 'checkpoint-unknown-writer'
            ) {
              return deliver();
            }
            const delivered = deliver();
            void Promise.resolve(delivered.settled).catch(() => undefined);
            if (variant === 'delivered-then-throw') {
              throw new Error('writer threw after handing off an outcome-unknown checkpoint');
            }
            return { admitted: false } as unknown as SubAgentTransportPeerWriterAdmission;
          },
        });
        const created = createRequest();
        const oldHandle = await first.controller.spawn(created, createHostControl().control);
        if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
        await checkpointAReady.promise;

        attemptCheckpointB.resolve();
        await within(checkpointBFailed.promise, `${variant} checkpoint writer failure`);
        expect(checkpointFailure).toMatchObject({
          descriptor: { outcomeUnknown: true },
        });

        const second = harness.connect();
        await expect(
          second.controller.spawn(
            createReconnectRequest(created, createBinding(created), `reconnect-after-${variant}`),
            createHostControl().control,
          ),
        ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
        expect(harness.factory).toHaveBeenCalledTimes(1);
        expect(oldSignal?.aborted).toBe(false);
      } finally {
        releaseOld.resolve();
        await harness.forceDispose().catch(() => undefined);
      }
    },
  );

  it('rejects old-channel cancel, snapshot and events after reconnect without disturbing the new runner', async () => {
    const checkpointReady = deferred();
    const newStarted = deferred();
    const releaseNew = deferred();
    const checkpoint = childCheckpoint();
    let newSignal: AbortSignal | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-channel-fence', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const newRunner: SubAgentChildRunner = {
      run: async (request) => {
        newSignal = request.signal;
        newStarted.resolve();
        const disposition = await Promise.race([
          releaseNew.promise.then(() => 'released' as const),
          waitForAbort(request.signal).then(() => 'aborted' as const),
        ]);
        return terminalOutcome(request, disposition === 'aborted' ? 'cancelled' : 'succeeded');
      },
    };
    const harness = createHarness({
      runners: [oldRunner, newRunner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    const first = harness.connect();
    const created = createRequest();
    const oldHandle = await within(
      first.controller.spawn(created, createHostControl().control),
      'the original task acceptance',
    );
    if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
    await within(checkpointReady.promise, 'the original recoverable checkpoint');

    const second = harness.connect();
    const reconnect = createReconnectRequest(
      created,
      createBinding(created),
      'reconnect-channel-fence',
    );
    const newHandle = await second.controller.spawn(reconnect, createHostControl().control);
    if (!('taskId' in newHandle)) throw new Error('Expected a reconnected task handle.');
    await newStarted.promise;

    const oldEvents = oldHandle.events()[Symbol.asyncIterator]();
    const staleOperations = await Promise.allSettled([
      oldHandle.cancel('stale-channel-cancel'),
      oldHandle.snapshot(),
      oldEvents.next(),
    ]);
    expect(staleOperations).toHaveLength(3);
    expect(staleOperations.map(({ status }) => status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    for (const operation of staleOperations) {
      if (operation.status === 'rejected') {
        expect(operation.reason).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      }
    }
    expect(newSignal?.aborted).toBe(false);
    await expect(newHandle.snapshot()).resolves.toMatchObject({
      taskId: created.taskId,
      state: 'running',
      binding: createBinding(created),
    });

    releaseNew.resolve();
    await expect(newHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
    await harness.dispose();
  });

  it('retains a hard-fenced detached slot after a fresh factory throws and reconnects it again', async () => {
    const checkpointReady = deferred();
    const recoveredStarted = deferred();
    const releaseRecovered = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 4 });
    const factoryFailure = new Error('fresh external runner factory failed');
    let recoveredRequest: SubAgentChildRunRequest | undefined;
    let failedFactorySignal: AbortSignal | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-factory-failure', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const recoveredRunner: SubAgentChildRunner = {
      run: async (request) => {
        recoveredRequest = request;
        recoveredStarted.resolve();
        await releaseRecovered.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      createRunner: async (context, factoryIndex) => {
        if (factoryIndex === 0) return oldRunner;
        if (factoryIndex === 1) {
          failedFactorySignal = context.request.signal;
          throw factoryFailure;
        }
        if (factoryIndex === 2) return recoveredRunner;
        throw new Error('Unexpected target runner factory call.');
      },
    });
    const first = harness.connect();
    const created = createRequest();
    const oldHandle = await first.controller.spawn(created, createHostControl().control);
    if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
    await checkpointReady.promise;

    const failedConnection = harness.connect();
    await expect(
      failedConnection.controller.spawn(
        createReconnectRequest(created, createBinding(created), 'reconnect-factory-fails'),
        createHostControl().control,
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(harness.factory).toHaveBeenCalledTimes(2);
    expect(failedFactorySignal?.aborted).toBe(true);
    expect(harness.target.diagnostics()).toMatchObject({
      tasks: 1,
      starting: 0,
      running: 0,
    });

    await expect(
      failedConnection.controller.spawn(
        createReconnectRequest(
          created,
          createBinding(created),
          'reconnect-on-failed-candidate-channel',
          {
            attempt: 3,
            executionEpoch: 'epoch-3',
            executionFencingToken: '3',
          },
        ),
        createHostControl().control,
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
    expect(harness.factory).toHaveBeenCalledTimes(2);

    const recoveredConnection = harness.connect();
    const recovered = createReconnectRequest(
      created,
      createBinding(created),
      'reconnect-after-factory-failure',
      {
        attempt: 4,
        executionEpoch: 'epoch-4',
        executionFencingToken: '4',
      },
    );
    const recoveredHandle = await recoveredConnection.controller.spawn(
      recovered,
      createHostControl().control,
    );
    if (!('taskId' in recoveredHandle)) throw new Error('Expected a recovered task handle.');
    await recoveredStarted.promise;
    expect(harness.factory).toHaveBeenCalledTimes(3);
    expect(recoveredRequest).toMatchObject({
      attempt: 4,
      executionEpoch: 'epoch-4',
      executionFencingToken: '4',
      checkpoint,
    });

    releaseRecovered.resolve();
    await expect(recoveredHandle.wait()).resolves.toEqual(terminalOutcome(recovered));
    await harness.dispose();
  });

  it('retains a failed receipt after a fresh runner synchronously starts, mutates state, and throws', async () => {
    const checkpointReady = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 4 });
    const runnerFailure = new Error('fresh runner failed after its first side effect');
    const sideEffect = vi.fn<(attempt: number) => void>();
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-sync-runner-failure', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const failingRunner: SubAgentChildRunner = {
      run: (request) => {
        sideEffect(request.attempt);
        throw runnerFailure;
      },
    };
    const harness = createHarness({
      runners: [oldRunner, failingRunner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const second = harness.connect();
      const failedReconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-runner-sync-side-effect-failure',
      );
      const failedHandle = await second.controller.spawn(
        failedReconnect,
        createHostControl().control,
      );
      if (!('taskId' in failedHandle)) throw new Error('Expected an accepted failed task handle.');
      await vi.waitFor(() =>
        expect(harness.target.diagnostics()).toMatchObject({
          tasks: 1,
          starting: 0,
          running: 0,
        }),
      );
      expect(sideEffect).toHaveBeenCalledExactlyOnceWith(2);
      expect(harness.factory).toHaveBeenCalledTimes(2);
      await expect(failedHandle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'failed',
      });
      await expect(failedHandle.wait()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

      const third = harness.connect();
      const receiptReconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-after-runner-sync-side-effect-failure',
        {
          attempt: 3,
          executionEpoch: 'epoch-3',
          executionFencingToken: '3',
        },
      );
      const receiptHandle = await third.controller.spawn(
        receiptReconnect,
        createHostControl().control,
      );
      if (!('taskId' in receiptHandle)) throw new Error('Expected a failed receipt handle.');
      expect(harness.factory).toHaveBeenCalledTimes(2);
      expect(sideEffect).toHaveBeenCalledExactlyOnceWith(2);
      await expect(receiptHandle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'failed',
      });
      await expect(receiptHandle.wait()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(harness.factory).toHaveBeenCalledTimes(2);
      expect(sideEffect).toHaveBeenCalledExactlyOnceWith(2);
    } finally {
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('does not launch a synchronously created runner after its absolute reconnect deadline', async () => {
    const checkpointReady = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 5 });
    const candidateRun = vi.fn(async (request: SubAgentChildRunRequest) =>
      terminalOutcome(request),
    );
    const candidateRunner: SubAgentChildRunner = { run: candidateRun };
    let now = NOW;
    let candidateSignal: AbortSignal | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-sync-deadline-factory', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const harness = createHarness({
      runners: [],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      now: () => now,
      createRunner: (context, factoryIndex) => {
        if (factoryIndex === 0) return oldRunner;
        if (factoryIndex === 1) {
          candidateSignal = context.request.signal;
          now = NOW + 100;
          return candidateRunner;
        }
        throw new Error('An expired synchronous factory must not be retried automatically.');
      },
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const second = harness.connect();
      const expiredReconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-sync-factory-crosses-deadline',
        { deadlineAt: NOW + 100 },
      );
      await expect(
        second.controller.spawn(expiredReconnect, createHostControl().control),
      ).rejects.toMatchObject({ code: 'TIMED_OUT' });
      expect(harness.factory).toHaveBeenCalledTimes(2);
      expect(candidateRun).not.toHaveBeenCalled();
      expect(candidateSignal?.aborted).toBe(true);
      expect(harness.target.diagnostics()).toMatchObject({
        tasks: 1,
        starting: 0,
        running: 0,
      });

      await expect(
        second.controller.cancel(createBinding(created), {
          operationId: 'cancel-expired-sync-factory-slot',
          reason: 'clean up the deadline-fenced slot',
          signal: new AbortController().signal,
          deadlineAt: now + 1_000,
        }),
      ).resolves.toBeUndefined();
      expect(candidateRun).not.toHaveBeenCalled();
    } finally {
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('does not launch a factory result after the fresh Peer closes and recovers on a third channel', async () => {
    const checkpointReady = deferred();
    const pendingFactoryStarted = deferred();
    const pendingFactory = deferred<SubAgentChildRunner>();
    const recoveredStarted = deferred();
    const releaseRecovered = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 5 });
    const lateRun = vi.fn(async (request: SubAgentChildRunRequest) => terminalOutcome(request));
    const lateRunner: SubAgentChildRunner = { run: lateRun };
    let failedFactorySignal: AbortSignal | undefined;
    let recoveredRequest: SubAgentChildRunRequest | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-factory-peer-close', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const recoveredRunner: SubAgentChildRunner = {
      run: async (request) => {
        recoveredRequest = request;
        recoveredStarted.resolve();
        await releaseRecovered.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      createRunner: (context, factoryIndex) => {
        if (factoryIndex === 0) return oldRunner;
        if (factoryIndex === 1) {
          failedFactorySignal = context.request.signal;
          pendingFactoryStarted.resolve();
          return pendingFactory.promise;
        }
        if (factoryIndex === 2) return recoveredRunner;
        throw new Error('Unexpected runner factory call after fresh-Peer recovery.');
      },
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await checkpointReady.promise;

      const failedConnection = harness.connect();
      const failedReconnect = failedConnection.controller.spawn(
        createReconnectRequest(
          created,
          createBinding(created),
          'reconnect-peer-closes-during-factory',
          { deadlineAt: NOW + 200 },
        ),
        createHostControl().control,
      );
      void failedReconnect.catch(() => undefined);
      await pendingFactoryStarted.promise;
      failedConnection.targetPeer.close();
      pendingFactory.resolve(lateRunner);
      await expect(
        within(failedReconnect, 'closed-Peer factory reconnect rejection'),
      ).rejects.toBeDefined();
      expect(lateRun).not.toHaveBeenCalled();
      expect(failedFactorySignal?.aborted).toBe(true);
      expect(harness.factory).toHaveBeenCalledTimes(2);
      expect(harness.target.diagnostics()).toMatchObject({
        tasks: 1,
        starting: 0,
        running: 0,
      });

      const recoveredConnection = harness.connect();
      const recovered = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-after-factory-peer-close',
        {
          attempt: 3,
          executionEpoch: 'epoch-3',
          executionFencingToken: '3',
        },
      );
      const recoveredHandle = await recoveredConnection.controller.spawn(
        recovered,
        createHostControl().control,
      );
      if (!('taskId' in recoveredHandle)) throw new Error('Expected a recovered task handle.');
      await recoveredStarted.promise;
      expect(recoveredRequest?.checkpoint).toEqual(checkpoint);
      expect(lateRun).not.toHaveBeenCalled();
      expect(harness.factory).toHaveBeenCalledTimes(3);

      releaseRecovered.resolve();
      await expect(recoveredHandle.wait()).resolves.toEqual(terminalOutcome(recovered));
    } finally {
      pendingFactory.resolve(lateRunner);
      releaseRecovered.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('never runs a late factory result after reconnect deadline and lets cancel terminate the detached slot', async () => {
    const checkpointReady = deferred();
    const pendingFactoryStarted = deferred();
    const pendingFactory = deferred<SubAgentChildRunner>();
    const checkpoint = childCheckpoint({ modelIteration: 5 });
    const lateRun = vi.fn(async (request: SubAgentChildRunRequest) => terminalOutcome(request));
    const lateRunner: SubAgentChildRunner = { run: lateRun };
    let pendingFactorySignal: AbortSignal | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-pending-factory', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const harness = createHarness({
      runners: [],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      createRunner: async (context, factoryIndex) => {
        if (factoryIndex === 0) return oldRunner;
        if (factoryIndex === 1) {
          pendingFactorySignal = context.request.signal;
          pendingFactoryStarted.resolve();
          return pendingFactory.promise;
        }
        throw new Error('A cancelled detached slot must not create another runner.');
      },
    });
    const first = harness.connect();
    const created = createRequest();
    const oldHandle = await within(
      first.controller.spawn(created, createHostControl().control),
      'the pending-factory original task acceptance',
    );
    if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
    await within(checkpointReady.promise, 'the pending-factory original recoverable checkpoint');

    const pendingConnection = harness.connect();
    const timedReconnect = createReconnectRequest(
      created,
      createBinding(created),
      'reconnect-pending-factory-deadline',
      { deadlineAt: NOW + 100 },
    );
    const reconnecting = pendingConnection.controller.spawn(
      timedReconnect,
      createHostControl().control,
    );
    await within(pendingFactoryStarted.promise, 'the pending reconnect factory');
    if (pendingFactorySignal === undefined) throw new Error('Expected the pending factory signal.');
    await expect(within(reconnecting, 'the reconnect deadline')).rejects.toBeDefined();
    await within(waitForAbort(pendingFactorySignal), 'the pending factory abort signal');

    pendingFactory.resolve(lateRunner);
    await vi.waitFor(() =>
      expect(harness.target.diagnostics()).toMatchObject({
        tasks: 1,
        starting: 0,
        running: 0,
      }),
    );
    expect(lateRun).not.toHaveBeenCalled();
    expect(harness.factory).toHaveBeenCalledTimes(2);

    await expect(
      within(
        pendingConnection.controller.cancel(createBinding(created), {
          operationId: 'cancel-detached-after-deadline',
          reason: 'host terminates detached external job',
          signal: new AbortController().signal,
          deadlineAt: NOW + 120_000,
        }),
        'detached-slot cancellation',
      ),
    ).resolves.toBeUndefined();
    expect(lateRun).not.toHaveBeenCalled();

    const afterCancel = harness.connect();
    await expect(
      within(
        afterCancel.controller.spawn(
          createReconnectRequest(
            created,
            createBinding(created),
            'reconnect-after-detached-cancel',
            {
              attempt: 3,
              executionEpoch: 'epoch-3',
              executionFencingToken: '3',
            },
          ),
          createHostControl().control,
        ),
        'post-cancel reconnect rejection',
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(harness.factory).toHaveBeenCalledTimes(2);
    expect(lateRun).not.toHaveBeenCalled();
    await within(harness.dispose(), 'detached target disposal');
  });

  it('rejects old wait and events replies that settle after a reconnect generation is fenced', async () => {
    const checkpointReady = deferred();
    const oldWaitRequested = deferred();
    const oldEventsStarted = deferred();
    const releaseOldEvents = deferred();
    const newStarted = deferred();
    const releaseNew = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 6 });
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        await control.commitCheckpoint('checkpoint-before-async-replies', checkpoint);
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        return terminalOutcome(request, 'cancelled');
      },
    };
    const newRunner: SubAgentChildRunner = {
      run: async (request) => {
        newStarted.resolve();
        await releaseNew.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [oldRunner, newRunner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      events: ({ request }) =>
        (async function* (): AsyncIterable<SubAgentTaskEvent> {
          if (request.attempt === 1) {
            oldEventsStarted.resolve();
            await releaseOldEvents.promise;
          }
          yield taskEvent(request, 1);
        })(),
    });
    const first = harness.connect({
      controllerToTarget: (packet, deliver) => {
        const envelope = packetEnvelope(packet);
        const payload = envelope.payload;
        if (
          envelope.kind === 'snapshot.request' &&
          typeof payload === 'object' &&
          payload !== null &&
          !Array.isArray(payload) &&
          Reflect.get(payload, 'mode') === 'wait'
        ) {
          oldWaitRequested.resolve();
        }
        return deliver();
      },
    });
    const created = createRequest();
    const oldHandle = await first.controller.spawn(created, createHostControl().control);
    if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
    await checkpointReady.promise;

    const oldWait = oldHandle.wait();
    await oldWaitRequested.promise;
    const oldEvents = oldHandle.events()[Symbol.asyncIterator]();
    const oldEvent = oldEvents.next();
    await oldEventsStarted.promise;

    const second = harness.connect();
    const reconnect = createReconnectRequest(
      created,
      createBinding(created),
      'reconnect-with-pending-old-replies',
    );
    const newHandle = await second.controller.spawn(reconnect, createHostControl().control);
    if (!('taskId' in newHandle)) throw new Error('Expected a reconnected task handle.');
    await newStarted.promise;

    releaseOldEvents.resolve();
    await expect(oldWait).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(oldEvent).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(newHandle.snapshot()).resolves.toMatchObject({
      taskId: created.taskId,
      state: 'running',
    });
    const newEvents = newHandle.events()[Symbol.asyncIterator]();
    await expect(newEvents.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 1, attempt: 2 },
    });

    releaseNew.resolve();
    await expect(newHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
    await harness.dispose();
  });

  it.each(['reconnect', 'dispose'] as const)(
    'tracks a non-cooperative expired checkpoint hook until it really settles before $action',
    async (action) => {
      const checkpointAReady = deferred();
      const hookBStarted = deferred();
      const releaseHookB = deferred();
      const checkpointCallerFailed = deferred();
      const releaseOldRunner = deferred();
      const oldRunnerSettled = deferred();
      const checkpointA = childCheckpoint({ modelIteration: 7 });
      const checkpointB = childCheckpoint({ modelIteration: 8 });
      let checkpointFailure: unknown;
      let hookBReturned = false;
      const checkpointCommitted = vi.fn(
        async (context: SubAgentTransportTargetCheckpointCommitContext) => {
          if (context.operationId === 'checkpoint-before-noncooperative-hook') return;
          hookBStarted.resolve();
          await releaseHookB.promise;
          hookBReturned = true;
        },
      );
      const oldRunner: SubAgentChildRunner = {
        run: async (request, control) => {
          await control.commitCheckpoint('checkpoint-before-noncooperative-hook', checkpointA);
          checkpointAReady.resolve();
          try {
            await control.commitCheckpoint('checkpoint-noncooperative-hook', checkpointB);
          } catch (error) {
            checkpointFailure = error;
          }
          checkpointCallerFailed.resolve();
          await releaseOldRunner.promise;
          oldRunnerSettled.resolve();
          return terminalOutcome(request, 'cancelled');
        },
      };
      const unexpectedRunner: SubAgentChildRunner = {
        run: async (request) => terminalOutcome(request),
      };
      const harness = createHarness({
        runners: [oldRunner, unexpectedRunner],
        externalReconnect: true,
        checkpointCommitted,
      });
      try {
        const first = harness.connect();
        const created = createRequest({ deadlineAt: NOW + 150 });
        const oldHandle = await first.controller.spawn(created, createHostControl().control);
        if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
        await checkpointAReady.promise;
        await hookBStarted.promise;
        await within(
          checkpointCallerFailed.promise,
          'the expired checkpoint caller failure',
          1_000,
        );
        expect(checkpointFailure).toBeDefined();
        expect(hookBReturned).toBe(false);
        expect(checkpointCommitted).toHaveBeenCalledTimes(2);

        if (action === 'reconnect') {
          const second = harness.connect();
          const reconnecting = second.controller.spawn(
            createReconnectRequest(
              created,
              createBinding(created),
              'reconnect-while-hook-still-running',
              { deadlineAt: NOW + 120_000 },
            ),
            createHostControl().control,
          );
          await expect(
            within(reconnecting, 'quarantined-hook reconnect rejection'),
          ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
          expect(harness.factory).toHaveBeenCalledTimes(1);

          releaseHookB.resolve();
          await vi.waitFor(() => expect(hookBReturned).toBe(true));
          const third = harness.connect();
          await expect(
            third.controller.spawn(
              createReconnectRequest(
                created,
                createBinding(created),
                'reconnect-after-quarantined-hook-return',
                {
                  attempt: 3,
                  executionEpoch: 'epoch-3',
                  executionFencingToken: '3',
                  deadlineAt: NOW + 120_000,
                },
              ),
              createHostControl().control,
            ),
          ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
          expect(harness.factory).toHaveBeenCalledTimes(1);
          releaseOldRunner.resolve();
          await oldRunnerSettled.promise;
        } else {
          releaseOldRunner.resolve();
          await oldRunnerSettled.promise;
          await vi.waitFor(() => expect(harness.target.diagnostics().running).toBe(0));
          const disposing = harness.target.dispose();
          await expect(
            within(disposing, 'quarantined-hook target disposal'),
          ).resolves.toBeUndefined();
          expect(hookBReturned).toBe(false);
          releaseHookB.resolve();
          await vi.waitFor(() => expect(hookBReturned).toBe(true));
        }
      } finally {
        releaseHookB.resolve();
        releaseOldRunner.resolve();
        await harness.dispose().catch(() => undefined);
      }
    },
  );

  it('preserves a naturally settled old result when soft quiescence closes with an unrecoverable checkpoint gap', async () => {
    const hostCheckpointStarted = deferred();
    const releaseHostCheckpoint = deferred();
    const releaseOldRunner = deferred();
    const oldRunnerReturned = deferred();
    const checkpointRequestSettled = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 6 });
    let checkpointFailure: unknown;
    let hostCheckpointExited = false;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        void control
          .commitCheckpoint('checkpoint-soft-quiesce-gap', checkpoint)
          .catch((error: unknown) => {
            checkpointFailure = error;
          })
          .finally(() => checkpointRequestSettled.resolve());
        await releaseOldRunner.promise;
        oldRunnerReturned.resolve();
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [oldRunner, { run: async (request) => terminalOutcome(request) }],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const host = createHostControl({
        commitCheckpoint: async () => {
          hostCheckpointStarted.resolve();
          try {
            await releaseHostCheckpoint.promise;
            throw new Error('controller checkpoint persistence failed after soft quiescence');
          } finally {
            hostCheckpointExited = true;
          }
        },
      });
      const oldHandle = await first.controller.spawn(created, host.control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await within(hostCheckpointStarted.promise, 'soft-quiesce checkpoint dispatch');

      const second = harness.connect();
      const reconnecting = second.controller.spawn(
        createReconnectRequest(created, createBinding(created), 'reconnect-soft-quiesce-gap'),
        createHostControl().control,
      );
      void reconnecting.catch(() => undefined);
      await expectPending(reconnecting, 'soft-quiescing reconnect');
      expect(harness.factory).toHaveBeenCalledTimes(1);

      releaseOldRunner.resolve();
      await within(oldRunnerReturned.promise, 'natural old-runner settlement');
      await within(checkpointRequestSettled.promise, 'aborted soft-quiesce checkpoint exchange');

      expect(checkpointFailure).toBeDefined();
      await expect(within(reconnecting, 'soft-quiesce reconnect rejection')).rejects.toMatchObject({
        code: 'RECOVERY_UNSUPPORTED',
      });
      await expect(within(oldHandle.wait(), 'original natural terminal result')).resolves.toEqual(
        terminalOutcome(created),
      );
      expect(hostCheckpointExited).toBe(false);
      expect(harness.factory).toHaveBeenCalledTimes(1);
      await expect(oldHandle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'succeeded',
      });
    } finally {
      releaseOldRunner.resolve();
      releaseHostCheckpoint.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('cancels only the pending reconnect when its resident naturally settles during soft quiescence', async () => {
    const hostCheckpointStarted = deferred();
    const releaseHostCheckpoint = deferred();
    const releaseOldRunner = deferred();
    const oldRunnerReturning = deferred();
    const checkpointSettled = deferred();
    const checkpoint = childCheckpoint({ modelIteration: 7 });
    let checkpointFailure: unknown;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        void control
          .commitCheckpoint('checkpoint-before-pending-reconnect-cancel', checkpoint)
          .catch((error: unknown) => {
            checkpointFailure = error;
          })
          .finally(() => checkpointSettled.resolve());
        await releaseOldRunner.promise;
        oldRunnerReturning.resolve();
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [oldRunner, { run: async (request) => terminalOutcome(request) }],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const host = createHostControl({
        commitCheckpoint: async () => {
          hostCheckpointStarted.resolve();
          await releaseHostCheckpoint.promise;
        },
      });
      const oldHandle = await first.controller.spawn(created, host.control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await hostCheckpointStarted.promise;

      const second = harness.connect();
      const reconnecting = second.controller.spawn(
        createReconnectRequest(
          created,
          createBinding(created),
          'reconnect-cancel-after-natural-settle',
        ),
        createHostControl().control,
      );
      void reconnecting.catch(() => undefined);
      await expectPending(reconnecting, 'soft reconnect before resident settlement');

      releaseOldRunner.resolve();
      await oldRunnerReturning.promise;
      await Promise.resolve();
      await Promise.resolve();
      await expect(
        second.controller.cancel(createBinding(created), {
          operationId: 'cancel-pending-reconnect-after-natural-settle',
          reason: 'cancel only the pending external attachment',
          signal: new AbortController().signal,
          deadlineAt: NOW + 120_000,
        }),
      ).resolves.toBeUndefined();

      await expect(reconnecting).rejects.toMatchObject({ code: 'CANCELLED' });
      await checkpointSettled.promise;
      expect(checkpointFailure).toBeDefined();
      expect(harness.factory).toHaveBeenCalledTimes(1);
      await expect(oldHandle.wait()).resolves.toEqual(terminalOutcome(created));
    } finally {
      releaseOldRunner.resolve();
      releaseHostCheckpoint.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it.each(['ok', 'negative'] as const)(
    'rejects a checkpoint $replyKind reply with a mismatched method without trusting its state',
    async (replyKind) => {
      const checkpointAReady = deferred();
      const attemptCheckpointB = deferred();
      const checkpointBFailed = deferred();
      const releaseOld = deferred();
      const checkpointA = childCheckpoint({ modelIteration: 3 });
      const checkpointB = childCheckpoint({ modelIteration: 4 });
      let checkpointFailure: unknown;
      let oldSignal: AbortSignal | undefined;
      const checkpointCommitted = vi.fn(async () => undefined);
      const oldRunner: SubAgentChildRunner = {
        run: async (request, control) => {
          oldSignal = request.signal;
          await control.commitCheckpoint('checkpoint-method-base', checkpointA);
          checkpointAReady.resolve();
          await attemptCheckpointB.promise;
          try {
            await control.commitCheckpoint('checkpoint-method-mismatch', checkpointB);
          } catch (error) {
            checkpointFailure = error;
          }
          checkpointBFailed.resolve();
          const disposition = await Promise.race([
            releaseOld.promise.then(() => 'released' as const),
            waitForAbort(request.signal).then(() => 'aborted' as const),
          ]);
          return terminalOutcome(request, disposition === 'aborted' ? 'cancelled' : 'succeeded');
        },
      };
      const harness = createHarness({
        runners: [oldRunner, { run: async (request) => terminalOutcome(request) }],
        externalReconnect: true,
        checkpointCommitted,
      });
      try {
        let rewritten = false;
        const first = harness.connect({
          controllerToTarget: (packet, deliver) => {
            const envelope = packetEnvelope(packet);
            if (
              !rewritten &&
              envelope.kind === 'control.reply' &&
              envelope.operationId === 'checkpoint-method-mismatch'
            ) {
              rewritten = true;
              return deliver(rewriteControlReplyMethod(packet, 'execution.reportProgress'));
            }
            return deliver();
          },
        });
        const created = createRequest();
        const host = createHostControl({
          commitCheckpoint: async (operationId) => {
            if (replyKind === 'negative' && operationId === 'checkpoint-method-mismatch') {
              throw new Error('controller rejects checkpoint candidate');
            }
          },
        });
        const oldHandle = await first.controller.spawn(created, host.control);
        if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
        await within(checkpointAReady.promise, 'method-mismatch base checkpoint');
        checkpointCommitted.mockClear();

        attemptCheckpointB.resolve();
        await within(checkpointBFailed.promise, 'method-mismatch checkpoint rejection');
        expect(checkpointFailure).toBeDefined();
        expect(rewritten).toBe(true);
        expect(checkpointCommitted).not.toHaveBeenCalled();

        const blocked = harness.connect();
        await expect(
          within(
            blocked.controller.spawn(
              createReconnectRequest(
                created,
                createBinding(created),
                `reconnect-after-${replyKind}-method-mismatch`,
              ),
              createHostControl().control,
            ),
            `${replyKind} method-mismatch reconnect rejection`,
          ),
        ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
        expect(harness.factory).toHaveBeenCalledTimes(1);
        expect(oldSignal?.aborted).toBe(false);
      } finally {
        releaseOld.resolve();
        await harness.forceDispose().catch(() => undefined);
      }
    },
  );

  it.each(['task', 'call'] as const)(
    'rejects an authorizeTool result with a mismatched $scope scope before checkpoint persistence',
    async (scope) => {
      const checkpointAReady = deferred();
      const authorizeAttempted = deferred();
      const releaseOld = deferred();
      const checkpointA = childCheckpoint({ modelIteration: 5 });
      const checkpointB = childCheckpoint({ modelIteration: 6 });
      const approvalInput = Object.freeze({
        callId: 'call-authorize-scope',
        toolName: 'write-report',
        summary: 'Write the reviewed report.',
        expiresAt: 10_000,
      });
      let authorizeFailure: unknown;
      let oldSignal: AbortSignal | undefined;
      const checkpointCommitted = vi.fn(async () => undefined);
      const oldRunner: SubAgentChildRunner = {
        run: async (request, control) => {
          oldSignal = request.signal;
          await control.commitCheckpoint('checkpoint-authorize-base', checkpointA);
          checkpointAReady.resolve();
          try {
            await control.authorizeTool('authorize-scope-mismatch', approvalInput, checkpointB);
          } catch (error) {
            authorizeFailure = error;
          }
          authorizeAttempted.resolve();
          const disposition = await Promise.race([
            releaseOld.promise.then(() => 'released' as const),
            waitForAbort(request.signal).then(() => 'aborted' as const),
          ]);
          return terminalOutcome(request, disposition === 'aborted' ? 'cancelled' : 'succeeded');
        },
      };
      const harness = createHarness({
        runners: [oldRunner, { run: async (request) => terminalOutcome(request) }],
        externalReconnect: true,
        checkpointCommitted,
      });
      try {
        const first = harness.connect();
        const created = createRequest();
        const host = createHostControl({
          authorizeTool: async () => ({
            type: 'suspend',
            request: {
              ...approvalInput,
              approvalId: 'approval-scope-mismatch',
              ownerSessionId: created.ownerSessionId,
              taskId: scope === 'task' ? 'other-task' : created.taskId,
              callId: scope === 'call' ? 'other-call' : approvalInput.callId,
              createdAt: NOW,
              revision: 1,
            },
            checkpointRevision: 2,
          }),
        });
        const oldHandle = await first.controller.spawn(created, host.control);
        if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
        await within(checkpointAReady.promise, 'authorize-scope base checkpoint');
        checkpointCommitted.mockClear();
        await within(authorizeAttempted.promise, 'authorize-scope rejection');

        expect(authorizeFailure).toBeDefined();
        expect(host.authorizeTool).toHaveBeenCalledTimes(1);
        expect(checkpointCommitted).not.toHaveBeenCalled();

        const blocked = harness.connect();
        await expect(
          within(
            blocked.controller.spawn(
              createReconnectRequest(
                created,
                createBinding(created),
                `reconnect-after-authorize-${scope}-mismatch`,
              ),
              createHostControl().control,
            ),
            `${scope} authorize-scope reconnect rejection`,
          ),
        ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
        expect(harness.factory).toHaveBeenCalledTimes(1);
        expect(oldSignal?.aborted).toBe(false);
      } finally {
        releaseOld.resolve();
        await harness.forceDispose().catch(() => undefined);
      }
    },
  );

  it('allows only the bootstrap binding commit and rejects runner-visible commits while active or quiescing', async () => {
    const checkpointReady = deferred();
    const oldAborted = deferred();
    const releaseOldCleanup = deferred();
    const newStarted = deferred();
    const releaseNew = deferred();
    const created = createRequest();
    const binding = createBinding(created);
    let oldControl: SubAgentExecutionControl | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        oldControl = control;
        await control.commitCheckpoint(
          'checkpoint-before-runner-binding-commit',
          childCheckpoint({ modelIteration: 7 }),
        );
        checkpointReady.resolve();
        await waitForAbort(request.signal);
        oldAborted.resolve();
        await releaseOldCleanup.promise;
        return terminalOutcome(request, 'cancelled');
      },
    };
    const newRunner: SubAgentChildRunner = {
      run: async (request) => {
        newStarted.resolve();
        await releaseNew.promise;
        return terminalOutcome(request);
      },
    };
    const harness = createHarness({
      runners: [oldRunner, newRunner],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
    });
    try {
      const first = harness.connect();
      const oldHost = createHostControl();
      const oldHandle = await first.controller.spawn(created, oldHost.control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await within(checkpointReady.promise, 'runner-binding base checkpoint');
      expect(oldHost.commitBinding).toHaveBeenCalledTimes(1);
      if (oldControl === undefined) throw new Error('Expected runner-visible control.');

      await expect(
        within(
          oldControl.commitBinding('runner-active-binding-commit', binding),
          'active runner-visible binding rejection',
        ),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(oldHost.commitBinding).toHaveBeenCalledTimes(1);

      const second = harness.connect();
      const reconnect = createReconnectRequest(
        created,
        binding,
        'reconnect-after-binding-commit-probes',
      );
      const reconnecting = second.controller.spawn(reconnect, createHostControl().control);
      await within(oldAborted.promise, 'old runner supersede abort');
      expect(harness.factory).toHaveBeenCalledTimes(1);

      await expect(
        within(
          oldControl.commitBinding('runner-quiescing-binding-commit', binding),
          'quiescing runner-visible binding rejection',
        ),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(oldHost.commitBinding).toHaveBeenCalledTimes(1);
      expect(harness.factory).toHaveBeenCalledTimes(1);

      releaseOldCleanup.resolve();
      const newHandle = await within(reconnecting, 'binding-probe reconnect');
      if (!('taskId' in newHandle)) throw new Error('Expected a reconnected task handle.');
      await within(newStarted.promise, 'binding-probe fresh runner');
      expect(harness.factory).toHaveBeenCalledTimes(2);

      releaseNew.resolve();
      await expect(newHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
    } finally {
      releaseOldCleanup.resolve();
      releaseNew.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('does not mutate a settled attachment when binding validation crosses the reconnect deadline', async () => {
    const validationStarted = deferred();
    const releaseValidation = deferred();
    let validationReturned = false;
    let blockTimedReconnect = true;
    let validationSignal: AbortSignal | undefined;
    const validateBinding = vi.fn(
      async ({
        request,
      }: Parameters<
        NonNullable<CreateSubAgentTransportTargetBridgeOptions['validateBinding']>
      >[0]) => {
        if (
          blockTimedReconnect &&
          request.operation.type === 'reconnect' &&
          request.operation.operationId === 'reconnect-settled-validation-deadline'
        ) {
          validationSignal = request.signal;
          validationStarted.resolve();
          await releaseValidation.promise;
          validationReturned = true;
        }
      },
    );
    const harness = createHarness({
      runners: [{ run: async (request) => terminalOutcome(request) }],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      validateBinding,
      now: () => NOW,
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await vi.waitFor(() => expect(harness.target.diagnostics().running).toBe(0));

      const second = harness.connect();
      const deadlineAt = NOW + 150;
      const timedReconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-settled-validation-deadline',
        { deadlineAt },
      );
      const timed = second.controller.spawn(timedReconnect, createHostControl().control);
      void timed.catch(() => undefined);
      await validationStarted.promise;
      await expectPending(timed, 'settled reconnect binding validation');
      await expect(within(timed, 'settled validation deadline')).rejects.toMatchObject({
        descriptor: { code: 'TIMED_OUT', outcomeUnknown: true },
      });
      if (validationSignal === undefined) throw new Error('Expected the target validation signal.');
      await within(waitForAbort(validationSignal), 'target validation deadline signal');
      expect(validationReturned).toBe(false);

      await expect(oldHandle.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'succeeded',
      });
      await expect(oldHandle.wait()).resolves.toEqual(terminalOutcome(created));

      releaseValidation.resolve();
      await vi.waitFor(() => expect(validationReturned).toBe(true));
      blockTimedReconnect = false;

      const third = harness.connect();
      const validReconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-settled-after-validation-deadline',
      );
      const validHandle = await third.controller.spawn(validReconnect, createHostControl().control);
      if (!('taskId' in validHandle)) throw new Error('Expected a settled reconnect handle.');
      await expect(validHandle.wait()).resolves.toEqual(terminalOutcome(validReconnect));
      expect(harness.factory).toHaveBeenCalledTimes(1);
      expect(validateBinding).toHaveBeenCalledTimes(3);
    } finally {
      releaseValidation.resolve();
      await harness.dispose().catch(() => undefined);
    }
  });

  it('does not mutate a settled attachment when its final updatedAt clock read reaches the reconnect deadline', async () => {
    let finalClockArmed = false;
    let finalClockReadCount = 0;
    const harness = createHarness({
      runners: [{ run: async (request) => terminalOutcome(request) }],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      now: () => NOW,
      targetNow: () => {
        if (!finalClockArmed) return NOW;
        finalClockReadCount += 1;
        return finalClockReadCount === 3 ? NOW + 100 : NOW;
      },
      validateBinding: ({ request }) => {
        if (
          request.operation.type === 'reconnect' &&
          request.operation.operationId === 'reconnect-settled-final-clock-deadline'
        ) {
          finalClockReadCount = 0;
          finalClockArmed = true;
        }
      },
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const original = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in original)) throw new Error('Expected an original task handle.');
      await expect(original.wait()).resolves.toEqual(terminalOutcome(created));
      await vi.waitFor(() => expect(harness.target.diagnostics().running).toBe(0));

      const second = harness.connect();
      const expiredReconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-settled-final-clock-deadline',
        { deadlineAt: NOW + 100 },
      );
      await expect(
        within(
          second.controller.spawn(expiredReconnect, createHostControl().control),
          'settled final-clock reconnect rejection',
        ),
      ).rejects.toMatchObject({ code: 'TIMED_OUT' });
      expect(finalClockReadCount).toBe(3);

      await expect(original.snapshot()).resolves.toMatchObject({
        taskId: created.taskId,
        state: 'succeeded',
      });
      await expect(original.wait()).resolves.toEqual(terminalOutcome(created));

      finalClockArmed = false;
      const third = harness.connect();
      const validReconnect = createReconnectRequest(
        created,
        createBinding(created),
        'reconnect-settled-after-final-clock-deadline',
      );
      const validHandle = await third.controller.spawn(validReconnect, createHostControl().control);
      if (!('taskId' in validHandle)) throw new Error('Expected a settled reconnect handle.');
      await expect(validHandle.wait()).resolves.toEqual(terminalOutcome(validReconnect));
      expect(harness.factory).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose().catch(() => undefined);
    }
  });

  it('disposes promptly while reconnect binding validation is non-cooperative', async () => {
    const validationStarted = deferred();
    const releaseValidation = deferred();
    let validationReturned = false;
    const harness = createHarness({
      runners: [{ run: async (request) => terminalOutcome(request) }],
      externalReconnect: true,
      checkpointCommitted: async () => undefined,
      validateBinding: async ({ request }) => {
        if (request.operation.type !== 'reconnect') return;
        validationStarted.resolve();
        await releaseValidation.promise;
        validationReturned = true;
      },
    });
    try {
      const first = harness.connect();
      const created = createRequest();
      const oldHandle = await first.controller.spawn(created, createHostControl().control);
      if (!('taskId' in oldHandle)) throw new Error('Expected an original task handle.');
      await oldHandle.wait();

      const second = harness.connect();
      const reconnecting = second.controller.spawn(
        createReconnectRequest(
          created,
          createBinding(created),
          'reconnect-noncooperative-validation-dispose',
        ),
        createHostControl().control,
      );
      void reconnecting.catch(() => undefined);
      await validationStarted.promise;
      await expectPending(reconnecting, 'non-cooperative validation before disposal');

      await expect(
        within(harness.target.dispose(), 'target disposal during binding validation'),
      ).resolves.toBeUndefined();
      await expect(within(reconnecting, 'disposed reconnect rejection')).rejects.toBeDefined();
      expect(validationReturned).toBe(false);
      expect(harness.factory).toHaveBeenCalledTimes(1);
      expect(harness.target.diagnostics()).toMatchObject({
        disposed: true,
        tasks: 0,
        starting: 0,
        running: 0,
      });

      releaseValidation.resolve();
      await vi.waitFor(() => expect(validationReturned).toBe(true));
      expect(harness.factory).toHaveBeenCalledTimes(1);
    } finally {
      releaseValidation.resolve();
      await harness.forceDispose().catch(() => undefined);
    }
  });

  it('serializes concurrent checkpoint hooks and reconnects from the last committed checkpoint', async () => {
    const hookAStarted = deferred();
    const releaseHookA = deferred();
    const hookBStarted = deferred();
    const releaseHookB = deferred();
    const oldAborted = deferred();
    const newStarted = deferred();
    const releaseNew = deferred();
    const reconnectReachedTarget = deferred();
    const checkpointA = childCheckpoint({ modelIteration: 1 });
    const checkpointB = childCheckpoint({ modelIteration: 2 });
    const hookOrder: string[] = [];
    let oldSignal: AbortSignal | undefined;
    const oldRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        oldSignal = request.signal;
        const firstCommit = control.commitCheckpoint('checkpoint-a', checkpointA);
        await hookAStarted.promise;
        const secondCommit = control.commitCheckpoint('checkpoint-b', checkpointB);
        await Promise.all([firstCommit, secondCommit]);
        await waitForAbort(request.signal);
        oldAborted.resolve();
        return terminalOutcome(request, 'cancelled');
      },
    };
    let recoveredRequest: SubAgentChildRunRequest | undefined;
    const newRunner: SubAgentChildRunner = {
      run: async (request, control) => {
        recoveredRequest = request;
        await control.reportProgress('fresh-channel-progress', {
          message: 'fresh runner reached its authenticated channel',
        });
        newStarted.resolve();
        await releaseNew.promise;
        return terminalOutcome(request);
      },
    };
    const checkpointCommitted = vi.fn(
      async (context: SubAgentTransportTargetCheckpointCommitContext) => {
        if (context.operationId === 'checkpoint-a') {
          hookOrder.push('a-start');
          hookAStarted.resolve();
          await releaseHookA.promise;
          hookOrder.push('a-end');
          return;
        }
        hookOrder.push('b-start');
        hookBStarted.resolve();
        await releaseHookB.promise;
        hookOrder.push('b-end');
      },
    );
    const harness = createHarness({
      runners: [oldRunner, newRunner],
      externalReconnect: true,
      checkpointCommitted,
      validateBinding: ({ request }) => {
        if (request.operation.type === 'reconnect') reconnectReachedTarget.resolve();
      },
    });
    const first = harness.connect();
    const created = createRequest();
    const hostOne = createHostControl();
    const oldHandle = await first.controller.spawn(created, hostOne.control);
    if (!('taskId' in oldHandle)) throw new Error('Expected a task handle.');
    await hookAStarted.promise;
    expect(hostOne.commitCheckpoint).toHaveBeenCalledTimes(1);
    expect(hookOrder).toEqual(['a-start']);

    const second = harness.connect();
    const reconnect = createReconnectRequest(created, createBinding(created), 'reconnect-latest');
    const hostTwo = createHostControl();
    const reconnecting = second.controller.spawn(reconnect, hostTwo.control);
    void reconnecting.catch(() => undefined);
    await reconnectReachedTarget.promise;
    await vi.waitFor(() => expect(second.controller.diagnostics().activeExecutions).toBe(1));
    expect(harness.factory).toHaveBeenCalledTimes(1);
    expect(oldSignal?.aborted).toBe(false);
    expect(hostOne.commitCheckpoint).toHaveBeenCalledTimes(1);
    expect(hostTwo.commitCheckpoint).not.toHaveBeenCalled();

    releaseHookA.resolve();
    await hookBStarted.promise;
    expect(hostOne.commitCheckpoint).toHaveBeenCalledTimes(2);
    expect(hostTwo.commitCheckpoint).not.toHaveBeenCalled();
    expect(hookOrder).toEqual(['a-start', 'a-end', 'b-start']);

    releaseHookB.resolve();
    const newHandle = await reconnecting;
    if (!('taskId' in newHandle)) throw new Error('Expected a reconnected task handle.');
    await oldAborted.promise;
    await newStarted.promise;
    expect(hookOrder).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    expect(recoveredRequest?.checkpoint).toEqual(checkpointB);
    expect(recoveredRequest?.checkpoint).not.toEqual(checkpointA);
    expect(harness.factoryRequests[1]?.checkpoint).toEqual(checkpointB);
    expect(hostOne.reportProgress).not.toHaveBeenCalled();
    expect(hostTwo.reportProgress).toHaveBeenCalledTimes(1);

    releaseNew.resolve();
    await expect(newHandle.wait()).resolves.toEqual(terminalOutcome(reconnect));
    await vi.waitFor(() => expect(first.controller.diagnostics().activeExecutions).toBe(0));
    await harness.dispose();
  });
});
