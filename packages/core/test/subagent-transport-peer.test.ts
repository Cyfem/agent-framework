import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { acceptanceIt } from '../../../testkit';

import type { SubAgentExecutionRequest, SubAgentExecutorBinding } from '../src/subagent/executor';
import { DEFAULT_SUBAGENT_LIMITS } from '../src/subagent/limits';
import {
  SubAgentTransportPeer,
  SubAgentTransportPeerError,
  createSubAgentTransportPeerWriterAdmission,
  type SubAgentTransportPeerHandlerRequest,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportPeerRequestHandler,
  type SubAgentTransportPeerWriter,
} from '../src/subagent/transport-peer';
import {
  createSubAgentTransportRpcEnvelope,
  decodeSubAgentTransportRpcFrame,
  encodeSubAgentTransportRpcFrame,
} from '../src/subagent/transport-rpc-codec';
import { createSubAgentExecutionRequestWire } from '../src/subagent/transport-codec';
import { SUBAGENT_TRANSPORT_MAX_SEQUENCE_WINDOW } from '../src/subagent/transport';
import type {
  CreateSubAgentTransportRpcEnvelopeInput,
  SubAgentTransportRpcEnvelope,
} from '../src/subagent/transport-rpc';
import { createSubAgentTransportArtifactSidecar } from '../src/subagent/transport-sidecar';

const TASK_ID = 'task-1';
const OPERATION_ID = 'operation-1';

function messageIds(prefix: string): () => string {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

function createBinding(): SubAgentExecutorBinding {
  return {
    version: '1',
    executorName: 'process',
    ownerSessionId: 'owner-session-1',
    taskId: TASK_ID,
    subagentSessionId: 'subagent-session-1',
    definitionName: 'researcher',
    definitionVersion: '2',
    runnerId: 'builtin-child-runner',
    runnerVersion: '1',
    adapterStateVersion: '1',
    recoveryData: { kind: 'process/v1', jobId: 'job-1' },
  };
}

function createExecutionRequest(): SubAgentExecutionRequest<{ readonly query: string }> {
  return {
    operation: {
      type: 'create',
      operationId: OPERATION_ID,
      idempotencyKey: 'idempotency-1',
    },
    ownerSessionId: 'owner-session-1',
    runId: 'run-1',
    taskId: TASK_ID,
    subagentSessionId: 'subagent-session-1',
    path: [TASK_ID],
    attempt: 1,
    executionEpoch: 'epoch-1',
    executionFencingToken: '1',
    definition: { name: 'researcher', version: '2' },
    input: { query: 'hello' },
    projectedContext: [{ kind: 'text', name: 'brief', text: 'Use primary sources.' }],
    delegation: {
      version: '1',
      ownerSessionId: 'owner-session-1',
      runId: 'run-1',
      parentTaskId: TASK_ID,
      path: [TASK_ID],
      depth: 1,
      catalogRevision: 1,
      definitions: [{ name: 'reviewer', version: '1', executors: ['process'] }],
    },
    limits: DEFAULT_SUBAGENT_LIMITS,
    signal: new AbortController().signal,
    deadlineAt: 121_000,
  };
}

function eventsReply(): {
  readonly kind: 'events.page';
  readonly payload: { readonly events: []; readonly nextSequence: 0; readonly done: true };
} {
  return {
    kind: 'events.page',
    payload: { events: [], nextSequence: 0, done: true },
  };
}

function modelRequest() {
  return {
    kind: 'model.request' as const,
    taskId: TASK_ID,
    operationId: 'provider-operation-1',
    payload: {
      providerOperationId: 'provider-operation-1',
      gatewayId: 'controller-gateway-1',
      protocol: 'openai-chat',
      codecVersion: '1',
      runId: 'run-1',
      executionAttempt: 1,
      executionEpoch: 'epoch-1',
      executionFencingToken: '7',
      checkpointOperationId: 'child-checkpoint-1',
      checkpointDigest: 'c'.repeat(64),
      purpose: 'agent' as const,
      iteration: 0,
      requestAttempt: 1,
      requestHash: 'a'.repeat(64),
      context: [{ role: 'user', content: 'hello' }],
      tools: [],
      remainingMs: 30_000,
    },
  };
}

function modelReply(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'model.reply' as const,
    payload: {
      providerOperationId: 'provider-operation-1',
      gatewayId: 'controller-gateway-1',
      protocol: 'openai-chat',
      codecVersion: '1',
      runId: 'run-1',
      executionAttempt: 1,
      executionEpoch: 'epoch-1',
      executionFencingToken: '7',
      checkpointOperationId: 'child-checkpoint-1',
      checkpointDigest: 'c'.repeat(64),
      requestHash: 'a'.repeat(64),
      ok: true as const,
      resultHash: 'b'.repeat(64),
      messages: [{ role: 'assistant', content: 'done' }],
      ...overrides,
    },
  };
}

function spawnRequest(executionRequest = createExecutionRequest()) {
  return {
    kind: 'executor.request' as const,
    taskId: TASK_ID,
    operationId: OPERATION_ID,
    payload: {
      mode: 'spawn' as const,
      request: createSubAgentExecutionRequestWire(executionRequest, {
        now: () => 1_000,
      }),
    },
  };
}

function taskEvent(sequence: number) {
  return {
    eventId: `event-${sequence}`,
    sequence,
    type: 'progress.reported' as const,
    sessionId: 'owner-session-1',
    runId: 'run-1',
    taskId: TASK_ID,
    path: [TASK_ID],
    definition: { name: 'researcher', version: '2' },
    executor: 'process',
    attempt: 1,
    timestamp: 1_000 + sequence,
    data: { length: sequence },
  };
}

function unboundCreateSettlement() {
  return {
    kind: 'executor.settled' as const,
    payload: {
      mode: 'spawn' as const,
      outcome: {
        type: 'recovery_required' as const,
        reason: 'unbound_create' as const,
        operationId: OPERATION_ID,
        causeCode: 'PROCESS_EXIT',
      },
    },
  };
}

function terminalSpawnSettlement() {
  return {
    kind: 'executor.settled' as const,
    payload: {
      mode: 'spawn' as const,
      outcome: {
        type: 'terminal' as const,
        result: {
          status: 'succeeded' as const,
          task: {
            taskId: TASK_ID,
            subAgent: { name: 'researcher', version: '2' },
          },
          executor: 'process',
          output: { proof: 'done' },
          usage: { turns: 1, providerCalls: 1 },
        },
      },
    },
  };
}

function createPacket(
  input: CreateSubAgentTransportRpcEnvelopeInput,
  sidecars: SubAgentTransportPeerPacket['sidecars'] = [],
): SubAgentTransportPeerPacket {
  const envelope = createSubAgentTransportRpcEnvelope(input);
  return Object.freeze({
    frame: encodeSubAgentTransportRpcFrame(envelope),
    sidecars,
  });
}

function responseInput(options: {
  readonly channelId: string;
  readonly correlationId: string;
  readonly sequence?: number;
  readonly messageId?: string;
  readonly taskId?: string;
  readonly operationId?: string;
  readonly kind?: 'events.page' | 'cancel.ack';
}): CreateSubAgentTransportRpcEnvelopeInput {
  const kind = options.kind ?? 'events.page';
  return {
    channelId: options.channelId,
    sequence: options.sequence ?? 1,
    messageId: options.messageId ?? 'remote-reply-1',
    correlationId: options.correlationId,
    taskId: options.taskId ?? TASK_ID,
    operationId: options.operationId ?? OPERATION_ID,
    kind,
    payload:
      kind === 'events.page' ? { events: [], nextSequence: 0, done: true } : { cancelled: true },
  } as CreateSubAgentTransportRpcEnvelopeInput;
}

function requestPacket(channelId: string, sequence = 1, messageId = 'remote-request-1') {
  return createPacket({
    channelId,
    sequence,
    messageId,
    taskId: TASK_ID,
    operationId: OPERATION_ID,
    kind: 'events.request',
    payload: {},
  });
}

function expectPeerFailure(error: unknown, reason: SubAgentTransportPeerError['reason']): void {
  expect(error).toBeInstanceOf(SubAgentTransportPeerError);
  expect((error as SubAgentTransportPeerError).reason).toBe(reason);
  expect((error as SubAgentTransportPeerError).descriptor).not.toHaveProperty('stack');
  expect((error as SubAgentTransportPeerError).descriptor).not.toHaveProperty('cause');
}

describe('Subagent transport peer exchange and admission', () => {
  it('uses the same Peer sequence domain for Model gateway RPC and fail-closes semantic mismatch', async () => {
    const peers: { client?: SubAgentTransportPeer } = {};
    const server: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-model-gateway',
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(peers.client!.receive(packet)),
      handler: (request) => request.reply(modelReply()),
      createMessageId: messageIds('server-model'),
    });
    const client = new SubAgentTransportPeer({
      channelId: 'channel-model-gateway',
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(server.receive(packet)),
      createMessageId: messageIds('client-model'),
    });
    peers.client = client;

    const exchange = client.openRequest(modelRequest());
    const reply = await exchange.next();
    expect(reply.done).toBe(false);
    expect(reply.value?.envelope.kind).toBe('model.reply');
    expect(client.state).toBe('open');

    const badPeers: { client?: SubAgentTransportPeer } = {};
    const badServer: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-model-mismatch',
      writer: (packet) =>
        createSubAgentTransportPeerWriterAdmission(badPeers.client!.receive(packet)),
      handler: (request) =>
        request.reply(modelReply({ gatewayId: 'different-controller-gateway' })),
      createMessageId: messageIds('bad-server-model'),
    });
    const badClient = new SubAgentTransportPeer({
      channelId: 'channel-model-mismatch',
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(badServer.receive(packet)),
      createMessageId: messageIds('bad-client-model'),
    });
    badPeers.client = badClient;
    const badExchange = badClient.openRequest(modelRequest());
    const failure = await badExchange.next().catch((error: unknown) => error);
    expectPeerFailure(failure, 'writer-failed');
    expect(badClient.state).toBe('closed');
    expect(badServer.state).toBe('closed');
  });

  it('supports bidirectional sequence spaces and reverse control without holding dispatch admission', async () => {
    const calls: string[] = [];
    const leftHandler: SubAgentTransportPeerRequestHandler = async (request) => {
      calls.push(`left:${request.envelope.operationId}`);
      await request.reply(eventsReply());
    };
    const rightHandler: SubAgentTransportPeerRequestHandler = async (request) => {
      calls.push(`right:${request.envelope.operationId}`);
      const reverse = right.openRequest({
        kind: 'events.request',
        taskId: TASK_ID,
        operationId: 'operation-reverse',
        payload: {},
      });
      const reverseReply = await reverse.next();
      expect(reverseReply.done).toBe(false);
      expect(reverseReply.value?.envelope.kind).toBe('events.page');
      await request.reply(eventsReply());
    };

    const left: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-duplex',
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(right.receive(packet)),
      handler: leftHandler,
      createMessageId: messageIds('left'),
      now: () => 1_000,
    });
    const right: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-duplex',
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(left.receive(packet)),
      handler: rightHandler,
      createMessageId: messageIds('right'),
      now: () => 2_000,
    });

    const exchange = left.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      payload: {},
    });
    const reply = await exchange.next();

    expect(reply.done).toBe(false);
    expect(reply.value?.envelope.kind).toBe('events.page');
    await expect(exchange.next()).resolves.toEqual({ done: true, value: undefined });
    expect(calls).toEqual(['right:operation-1', 'left:operation-reverse']);
    expect(left.state).toBe('open');
    expect(right.state).toBe('open');
  });

  it('delivers spawn acceptance then settlement through successive next calls', async () => {
    const server: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-spawn',
      createMessageId: messageIds('server'),
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(client.receive(packet)),
      handler: async (request) => {
        await request.reply({
          kind: 'executor.accepted',
          payload: { mode: 'spawn', binding: createBinding() },
        });
        await request.reply(terminalSpawnSettlement());
      },
    });
    const client: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-spawn',
      createMessageId: messageIds('client'),
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(server.receive(packet)),
    });

    const exchange = client.openRequest(spawnRequest());

    const accepted = await exchange.next();
    const settled = await exchange.next();
    expect(accepted.value?.envelope.kind).toBe('executor.accepted');
    expect(settled.value?.envelope.kind).toBe('executor.settled');
    if (settled.value?.envelope.kind === 'executor.settled') {
      expect(settled.value.envelope.payload.mode).toBe('spawn');
      expect(settled.value.envelope.payload.outcome.type).toBe('terminal');
    }
    await expect(exchange.next()).resolves.toEqual({ done: true, value: undefined });
  });

  acceptanceIt('C7-TRANSPORT-08.l1.rpc-peer', 'rpc-peer', async () => {
    let releaseSettlement!: () => void;
    const settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });

    const clientHandler: SubAgentTransportPeerRequestHandler = async (request) => {
      if (request.envelope.kind !== 'events.request') throw new Error('Unexpected request kind.');
      await request.reply(eventsReply());
    };
    const serverHandler: SubAgentTransportPeerRequestHandler = async (request) => {
      if (request.envelope.kind === 'events.request') {
        await request.reply(eventsReply());
        return;
      }
      if (request.envelope.kind !== 'executor.request') {
        throw new Error('Unexpected request kind.');
      }
      const reverse = server.openRequest({
        kind: 'events.request',
        taskId: TASK_ID,
        operationId: 'operation-reverse-near-bound',
        payload: {},
      });
      expect((await reverse.next()).value?.envelope.kind).toBe('events.page');
      await expect(reverse.next()).resolves.toEqual({ done: true, value: undefined });
      await request.reply({
        kind: 'executor.accepted',
        payload: { mode: 'spawn', binding: createBinding() },
      });
      await settlementGate;
      await request.reply(terminalSpawnSettlement());
    };

    const server: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-near-bound',
      createMessageId: messageIds('server-near-bound'),
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(client.receive(packet)),
      handler: serverHandler,
      maxTrackedSequences: 4,
      settlementSequenceHeadroom: 2,
    });
    const client: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-near-bound',
      createMessageId: messageIds('client-near-bound'),
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(server.receive(packet)),
      handler: clientHandler,
      maxTrackedSequences: 4,
      settlementSequenceHeadroom: 2,
    });

    const spawn = client.openRequest(spawnRequest());
    expect((await spawn.next()).value?.envelope.kind).toBe('executor.accepted');
    expect(client.state).toBe('draining');
    expect(server.state).toBe('draining');
    expect(() => client.openRequest(spawnRequest())).toThrowError(SubAgentTransportPeerError);

    const continuation = client.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: 'operation-continuation-near-bound',
      payload: {},
    });
    expect((await continuation.next()).value?.envelope.kind).toBe('events.page');
    await expect(continuation.next()).resolves.toEqual({ done: true, value: undefined });

    releaseSettlement();
    expect((await spawn.next()).value?.envelope.kind).toBe('executor.settled');
    await expect(spawn.next()).resolves.toEqual({ done: true, value: undefined });
    expect(client.state).toBe('draining');
    expect(server.state).toBe('draining');
  });

  it('allows a spawn to settle directly only for unbound-create recovery', async () => {
    const server: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-spawn-unbound',
      createMessageId: messageIds('server'),
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(client.receive(packet)),
      handler: async (request) => request.reply(unboundCreateSettlement()),
    });
    const client: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-spawn-unbound',
      createMessageId: messageIds('client'),
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(server.receive(packet)),
    });

    const exchange = client.openRequest(spawnRequest());
    const settled = await exchange.next();
    expect(settled.value?.envelope.kind).toBe('executor.settled');
    if (settled.value?.envelope.kind === 'executor.settled') {
      expect(settled.value.envelope.payload.outcome).toMatchObject({
        type: 'recovery_required',
        reason: 'unbound_create',
      });
    }
    await expect(exchange.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('fail-closes an unbound-create settlement received after spawn acceptance', async () => {
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-spawn-invalid-unbound',
      createMessageId: messageIds('client'),
      writer: () => createSubAgentTransportPeerWriterAdmission(),
    });
    const exchange = peer.openRequest(spawnRequest());
    const accepted = createPacket({
      channelId: 'channel-spawn-invalid-unbound',
      sequence: 1,
      messageId: 'server-accepted',
      correlationId: exchange.messageId,
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      kind: 'executor.accepted',
      payload: { mode: 'spawn', binding: createBinding() },
    });
    await peer.receive(accepted);
    expect((await exchange.next()).value?.envelope.kind).toBe('executor.accepted');

    const invalid = createPacket({
      channelId: 'channel-spawn-invalid-unbound',
      sequence: 2,
      messageId: 'server-invalid-settlement',
      correlationId: exchange.messageId,
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      ...unboundCreateSettlement(),
    });
    const receiveFailure = await peer.receive(invalid).catch((error: unknown) => error);
    expectPeerFailure(receiveFailure, 'protocol-violation');
    expect(peer.state).toBe('closed');
    const exchangeFailure = await exchange.next().catch((error: unknown) => error);
    expectPeerFailure(exchangeFailure, 'protocol-violation');
  });

  it('maps handler exceptions to a safe protocol descriptor without raw error details', async () => {
    const responsePackets: SubAgentTransportPeerPacket[] = [];
    const server: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-safe-error',
      createMessageId: messageIds('server'),
      writer: (packet) => {
        responsePackets.push(packet);
        return createSubAgentTransportPeerWriterAdmission(client.receive(packet));
      },
      handler: () => {
        throw Object.assign(new Error('provider body contains secret-token'), {
          body: { apiKey: 'secret-token' },
        });
      },
    });
    const client: SubAgentTransportPeer = new SubAgentTransportPeer({
      channelId: 'channel-safe-error',
      createMessageId: messageIds('client'),
      writer: (packet) => createSubAgentTransportPeerWriterAdmission(server.receive(packet)),
    });

    const exchange = client.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      payload: {},
    });
    const failure = await exchange.next();

    expect(failure.value?.envelope.kind).toBe('protocol.error');
    expect(JSON.stringify(failure.value)).not.toContain('secret-token');
    expect(String(responsePackets[0]?.frame)).not.toContain('secret-token');
    if (failure.value?.envelope.kind === 'protocol.error') {
      expect(Object.keys(failure.value.envelope.payload.error).sort()).toEqual([
        'causeCode',
        'code',
        'message',
        'retryable',
      ]);
    }
  });

  it('fail-closes replies with wrong correlation, task, operation or request/reply mapping', async () => {
    const variants = [
      { name: 'correlation', correlationId: 'unknown-request' },
      { name: 'task', taskId: 'different-task' },
      { name: 'operation', operationId: 'different-operation' },
      { name: 'mapping', kind: 'cancel.ack' as const },
    ];

    for (const [index, variant] of variants.entries()) {
      const channelId = `channel-binding-${index}`;
      const sent: SubAgentTransportPeerPacket[] = [];
      const peer = new SubAgentTransportPeer({
        channelId,
        createMessageId: messageIds('local'),
        writer: (packet) => {
          sent.push(packet);
          return createSubAgentTransportPeerWriterAdmission();
        },
      });
      const exchange = peer.openRequest({
        kind: 'events.request',
        taskId: TASK_ID,
        operationId: OPERATION_ID,
        payload: {},
      });
      const packet = createPacket(
        responseInput({
          channelId,
          correlationId: variant.correlationId ?? exchange.messageId,
          ...(variant.taskId === undefined ? {} : { taskId: variant.taskId }),
          ...(variant.operationId === undefined ? {} : { operationId: variant.operationId }),
          ...(variant.kind === undefined ? {} : { kind: variant.kind }),
        }),
      );

      const error = await peer.receive(packet).catch((caught: unknown) => caught);
      expectPeerFailure(error, 'protocol-violation');
      expect(peer.state, variant.name).toBe('closed');
      const pendingFailure = await exchange.next().catch((caught: unknown) => caught);
      expectPeerFailure(pendingFailure, 'protocol-violation');
    }

    const controlPeer = new SubAgentTransportPeer({
      channelId: 'channel-control-method',
      createMessageId: messageIds('control-local'),
      writer: () => createSubAgentTransportPeerWriterAdmission(),
    });
    const control = controlPeer.openRequest({
      kind: 'control.request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      payload: {
        executionAttempt: 1,
        executionEpoch: 'epoch-1',
        executionFencingToken: '1',
        method: 'execution.reportProgress',
        args: { update: { message: 'halfway' } },
      },
    });
    const wrongMethod = createPacket({
      channelId: 'channel-control-method',
      sequence: 1,
      messageId: 'control-remote-1',
      correlationId: control.messageId,
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      kind: 'control.reply',
      payload: { method: 'execution.consumeBudget', ok: true, result: null },
    });
    const methodError = await controlPeer.receive(wrongMethod).catch((caught: unknown) => caught);
    expectPeerFailure(methodError, 'protocol-violation');
    expect(controlPeer.state).toBe('closed');
  });

  it('binds executor acceptance to the request identity and any requested recovery route', async () => {
    const identityMismatches: readonly Partial<SubAgentExecutorBinding>[] = [
      { ownerSessionId: 'owner-session-other' },
      { subagentSessionId: 'subagent-session-other' },
      { definitionName: 'reviewer' },
      { definitionVersion: '3' },
    ];
    for (const [index, mismatch] of identityMismatches.entries()) {
      const channelId = `channel-accepted-identity-${index}`;
      const peer = new SubAgentTransportPeer({
        channelId,
        createMessageId: messageIds('client'),
        writer: () => createSubAgentTransportPeerWriterAdmission(),
      });
      const exchange = peer.openRequest(spawnRequest());
      const error = await peer
        .receive(
          createPacket({
            channelId,
            sequence: 1,
            messageId: 'server-accepted',
            correlationId: exchange.messageId,
            taskId: TASK_ID,
            operationId: OPERATION_ID,
            kind: 'executor.accepted',
            payload: { mode: 'spawn', binding: { ...createBinding(), ...mismatch } },
          }),
        )
        .catch((caught: unknown) => caught);
      expectPeerFailure(error, 'protocol-violation');
    }

    const requestedBinding = createBinding();
    const reconnectRequest: SubAgentExecutionRequest<{ readonly query: string }> = {
      ...createExecutionRequest(),
      operation: {
        type: 'reconnect',
        operationId: OPERATION_ID,
        binding: requestedBinding,
      },
    };
    const routeMismatches: readonly Partial<SubAgentExecutorBinding>[] = [
      { executorName: 'worker' },
      { runnerId: 'other-runner' },
      { runnerVersion: '2' },
    ];
    for (const [index, mismatch] of routeMismatches.entries()) {
      const channelId = `channel-accepted-route-${index}`;
      const peer = new SubAgentTransportPeer({
        channelId,
        createMessageId: messageIds('client'),
        writer: () => createSubAgentTransportPeerWriterAdmission(),
      });
      const exchange = peer.openRequest(spawnRequest(reconnectRequest));
      const error = await peer
        .receive(
          createPacket({
            channelId,
            sequence: 1,
            messageId: 'server-accepted',
            correlationId: exchange.messageId,
            taskId: TASK_ID,
            operationId: OPERATION_ID,
            kind: 'executor.accepted',
            payload: { mode: 'spawn', binding: { ...requestedBinding, ...mismatch } },
          }),
        )
        .catch((caught: unknown) => caught);
      expectPeerFailure(error, 'protocol-violation');
    }
  });

  it('binds terminal and paused task definitions plus terminal executors to the request', async () => {
    const terminalMismatches = [
      {
        subAgent: { name: 'reviewer', version: '2' },
        executor: 'process',
      },
      {
        subAgent: { name: 'researcher', version: '2' },
        executor: 'worker',
      },
    ] as const;
    for (const [index, mismatch] of terminalMismatches.entries()) {
      const channelId = `channel-settlement-correlation-${index}`;
      const peer = new SubAgentTransportPeer({
        channelId,
        createMessageId: messageIds('client'),
        writer: () => createSubAgentTransportPeerWriterAdmission(),
      });
      const exchange = peer.openRequest(spawnRequest());
      await peer.receive(
        createPacket({
          channelId,
          sequence: 1,
          messageId: 'server-accepted',
          correlationId: exchange.messageId,
          taskId: TASK_ID,
          operationId: OPERATION_ID,
          kind: 'executor.accepted',
          payload: { mode: 'spawn', binding: createBinding() },
        }),
      );
      await exchange.next();
      const settlement = terminalSpawnSettlement();
      const error = await peer
        .receive(
          createPacket({
            channelId,
            sequence: 2,
            messageId: 'server-settled',
            correlationId: exchange.messageId,
            taskId: TASK_ID,
            operationId: OPERATION_ID,
            kind: settlement.kind,
            payload: {
              ...settlement.payload,
              outcome: {
                ...settlement.payload.outcome,
                result: {
                  ...settlement.payload.outcome.result,
                  task: {
                    ...settlement.payload.outcome.result.task,
                    subAgent: mismatch.subAgent,
                  },
                  executor: mismatch.executor,
                },
              },
            },
          }),
        )
        .catch((caught: unknown) => caught);
      expectPeerFailure(error, 'protocol-violation');
    }

    const channelId = 'channel-paused-correlation';
    const peer = new SubAgentTransportPeer({
      channelId,
      createMessageId: messageIds('client'),
      writer: () => createSubAgentTransportPeerWriterAdmission(),
    });
    const request = spawnRequest();
    const exchange = peer.openRequest({
      ...request,
      payload: { ...request.payload, mode: 'execute' },
    });
    const error = await peer
      .receive(
        createPacket({
          channelId,
          sequence: 1,
          messageId: 'server-paused',
          correlationId: exchange.messageId,
          taskId: TASK_ID,
          operationId: OPERATION_ID,
          kind: 'executor.settled',
          payload: {
            mode: 'execute',
            outcome: {
              type: 'paused',
              reason: 'approval',
              task: {
                taskId: TASK_ID,
                subAgent: { name: 'reviewer', version: '2' },
              },
              approvals: [
                {
                  callId: 'call-1',
                  toolName: 'dangerous-tool',
                  summary: 'Approve operation.',
                  approvalId: 'approval-1',
                  ownerSessionId: 'owner-session-1',
                  taskId: TASK_ID,
                  createdAt: 0,
                  revision: 1,
                },
              ],
              checkpointRevision: 1,
            },
          },
        }),
      )
      .catch((caught: unknown) => caught);
    expectPeerFailure(error, 'protocol-violation');
  });

  it('enforces events cursor and page limits from the original request', async () => {
    const invalidPages = [
      { events: [], nextSequence: 4, done: true },
      { events: [taskEvent(6), taskEvent(7)], nextSequence: 7, done: false },
      { events: [taskEvent(5)], nextSequence: 5, done: false },
      { events: [taskEvent(6)], nextSequence: 7, done: false },
    ] as const;
    for (const [index, payload] of invalidPages.entries()) {
      const channelId = `channel-events-correlation-${index}`;
      const peer = new SubAgentTransportPeer({
        channelId,
        createMessageId: messageIds('client'),
        writer: () => createSubAgentTransportPeerWriterAdmission(),
      });
      const exchange = peer.openRequest({
        kind: 'events.request',
        taskId: TASK_ID,
        operationId: OPERATION_ID,
        payload: { afterSequence: 5, limit: 1 },
      });
      const error = await peer
        .receive(
          createPacket({
            channelId,
            sequence: 1,
            messageId: 'server-events',
            correlationId: exchange.messageId,
            taskId: TASK_ID,
            operationId: OPERATION_ID,
            kind: 'events.page',
            payload,
          }),
        )
        .catch((caught: unknown) => caught);
      expectPeerFailure(error, 'protocol-violation');
    }

    const peer = new SubAgentTransportPeer({
      channelId: 'channel-events-correlation-valid',
      createMessageId: messageIds('client'),
      writer: () => createSubAgentTransportPeerWriterAdmission(),
    });
    const exchange = peer.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      payload: { afterSequence: 5, limit: 1 },
    });
    await peer.receive(
      createPacket({
        channelId: 'channel-events-correlation-valid',
        sequence: 1,
        messageId: 'server-events-valid',
        correlationId: exchange.messageId,
        taskId: TASK_ID,
        operationId: OPERATION_ID,
        kind: 'events.page',
        payload: { events: [taskEvent(6)], nextSequence: 6, done: false },
      }),
    );
    expect((await exchange.next()).value?.envelope.kind).toBe('events.page');
  });

  it('runs an in-flight request handler once and replays its exact cached reply', async () => {
    const requests: SubAgentTransportPeerPacket[] = [];
    const replies: SubAgentTransportPeerPacket[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async (request: SubAgentTransportPeerHandlerRequest) => {
      await gate;
      await request.reply(eventsReply());
    });
    const sender = new SubAgentTransportPeer({
      channelId: 'channel-replay',
      createMessageId: messageIds('sender'),
      writer: (packet) => {
        requests.push(packet);
        return createSubAgentTransportPeerWriterAdmission();
      },
    });
    const receiver = new SubAgentTransportPeer({
      channelId: 'channel-replay',
      createMessageId: messageIds('receiver'),
      writer: (packet) => {
        replies.push(packet);
        return createSubAgentTransportPeerWriterAdmission();
      },
      handler,
    });
    sender.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      payload: {},
    });
    const original = requests[0]!;
    const decodedOriginal = decodeSubAgentTransportRpcFrame(original.frame);
    const equivalentFrame = JSON.stringify(
      {
        payload: decodedOriginal.payload,
        kind: decodedOriginal.kind,
        operationId: decodedOriginal.operationId,
        taskId: decodedOriginal.taskId,
        messageId: decodedOriginal.messageId,
        sequence: decodedOriginal.sequence,
        channelId: decodedOriginal.channelId,
        version: decodedOriginal.version,
      },
      undefined,
      2,
    );

    const first = receiver.receive(original);
    const replay = receiver.receive({ frame: equivalentFrame, sidecars: [] });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, replay]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(replies).toHaveLength(2);
    expect(replies[1]?.frame).toBe(replies[0]?.frame);
    expect(replies[1]?.sidecars).toEqual(replies[0]?.sidecars);

    const conflict = {
      ...decodedOriginal,
      payload: { limit: 1 },
    } as SubAgentTransportRpcEnvelope;
    const conflictError = await receiver
      .receive({ frame: encodeSubAgentTransportRpcFrame(conflict), sidecars: [] })
      .catch((caught: unknown) => caught);
    expectPeerFailure(conflictError, 'protocol-violation');
    expect(receiver.state).toBe('closed');
  });

  it('fail-closes a sequence gap before invoking the handler', async () => {
    const handler = vi.fn(async (request: SubAgentTransportPeerHandlerRequest) =>
      request.reply(eventsReply()),
    );
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-gap',
      writer: () => createSubAgentTransportPeerWriterAdmission(),
      handler,
    });

    const error = await peer
      .receive(requestPacket('channel-gap', 2))
      .catch((caught: unknown) => caught);
    expectPeerFailure(error, 'protocol-violation');
    expect(handler).not.toHaveBeenCalled();
    expect(peer.state).toBe('closed');
  });

  it('decodes the owned frame snapshot instead of rereading caller-owned bytes', async () => {
    const initial = createPacket({
      channelId: 'channel-owned-frame',
      sequence: 1,
      messageId: 'owned-frame-request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      kind: 'events.request',
      payload: { limit: 1 },
    });
    const replacement = createPacket({
      channelId: 'channel-owned-frame',
      sequence: 1,
      messageId: 'owned-frame-request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      kind: 'events.request',
      payload: { limit: 2 },
    });
    const initialBytes = new TextEncoder().encode(initial.frame as string);
    const replacementBytes = new TextEncoder().encode(replacement.frame as string);
    expect(replacementBytes.byteLength).toBe(initialBytes.byteLength);

    class MutationOnByteLengthRead extends Uint8Array {
      readonly replacement: Uint8Array;

      constructor(source: Uint8Array, replacementValue: Uint8Array) {
        super(source);
        this.replacement = replacementValue;
      }

      override get byteLength(): number {
        this.set(this.replacement);
        return this.buffer.byteLength;
      }
    }

    let receivedLimit: number | undefined;
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-owned-frame',
      writer: () => createSubAgentTransportPeerWriterAdmission(),
      handler: async (request) => {
        if (request.envelope.kind !== 'events.request') throw new Error('Unexpected request kind.');
        receivedLimit = request.envelope.payload.limit;
        await request.reply(eventsReply());
      },
    });

    await peer.receive({
      frame: new MutationOnByteLengthRead(initialBytes, replacementBytes),
      sidecars: [],
    });
    expect(receivedLimit).toBe(1);
  });
});

describe('Subagent transport peer cancellation and limits', () => {
  it('requires synchronous writer admission while allowing settlements to finish out of order', async () => {
    const invalidWriters: readonly {
      readonly invoke: 'openRequest' | 'request';
      readonly writer: SubAgentTransportPeerWriter;
    }[] = [
      {
        invoke: 'openRequest',
        writer: (() => undefined) as unknown as SubAgentTransportPeerWriter,
      },
      {
        invoke: 'request',
        writer: (() => Promise.resolve()) as unknown as SubAgentTransportPeerWriter,
      },
      {
        invoke: 'openRequest',
        writer: (() => ({ admitted: false })) as unknown as SubAgentTransportPeerWriter,
      },
      {
        invoke: 'request',
        writer: (() => ({ admitted: true, settled: 1 })) as unknown as SubAgentTransportPeerWriter,
      },
    ];
    for (const [index, testCase] of invalidWriters.entries()) {
      const peer = new SubAgentTransportPeer({
        channelId: `channel-invalid-admission-${index}`,
        writer: testCase.writer,
      });
      let failure: unknown;
      try {
        peer[testCase.invoke]({
          kind: 'events.request',
          taskId: TASK_ID,
          operationId: `operation-invalid-admission-${index}`,
          payload: {},
        });
      } catch (caught) {
        failure = caught;
      }
      expectPeerFailure(failure, 'writer-failed');
      expect(peer.state).toBe('closed');
    }

    const admitted: number[] = [];
    const settlers = new Map<number, () => void>();
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-settle-order',
      writer: (packet) => {
        const sequence = decodeSubAgentTransportRpcFrame(packet.frame).sequence;
        admitted.push(sequence);
        const settled = new Promise<void>((resolve) => settlers.set(sequence, resolve));
        return createSubAgentTransportPeerWriterAdmission(settled);
      },
    });
    peer.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: 'operation-settle-first',
      payload: {},
    });
    peer.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: 'operation-settle-second',
      payload: {},
    });

    expect(admitted).toEqual([1, 2]);
    settlers.get(2)?.();
    await Promise.resolve();
    expect(peer.state).toBe('open');
    settlers.get(1)?.();
    await Promise.resolve();
    expect(peer.state).toBe('open');
    peer.close();
  });

  it('converts a raw writer exception into a synchronous safe closed-channel failure', () => {
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-writer-failure',
      writer: () => {
        throw Object.assign(new Error('socket secret-token'), {
          response: { authorization: 'secret-token' },
        });
      },
    });
    let failure: unknown;
    try {
      peer.openRequest({
        kind: 'events.request',
        taskId: TASK_ID,
        operationId: OPERATION_ID,
        payload: {},
      });
    } catch (caught) {
      failure = caught;
    }
    expectPeerFailure(failure, 'writer-failed');
    expect(JSON.stringify((failure as SubAgentTransportPeerError).descriptor)).not.toContain(
      'secret-token',
    );
    expect(peer.state).toBe('closed');
  });

  it('throws writer admission failures synchronously from handler reply', async () => {
    const invalidReplyWriters: readonly SubAgentTransportPeerWriter[] = [
      (() => undefined) as unknown as SubAgentTransportPeerWriter,
      (() => Promise.resolve()) as unknown as SubAgentTransportPeerWriter,
      (() => {
        throw new Error('raw reply writer failure');
      }) as SubAgentTransportPeerWriter,
      (() => ({ admitted: false })) as unknown as SubAgentTransportPeerWriter,
    ];
    for (const [index, writer] of invalidReplyWriters.entries()) {
      let replyFailure: unknown;
      const channelId = `channel-reply-admission-failure-${index}`;
      const peer = new SubAgentTransportPeer({
        channelId,
        writer,
        handler: (request) => {
          try {
            request.reply(eventsReply());
          } catch (caught) {
            replyFailure = caught;
          }
        },
      });

      await peer.receive(requestPacket(channelId));
      expectPeerFailure(replyFailure, 'writer-failed');
      expect(peer.state).toBe('closed');
    }
  });

  it('reports a valid admission receipt settlement failure asynchronously', async () => {
    let rejectSettlement!: (reason?: unknown) => void;
    const settled = new Promise<void>((_resolve, reject) => {
      rejectSettlement = reject;
    });
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-async-settlement-failure',
      writer: () => createSubAgentTransportPeerWriterAdmission(settled),
    });
    const exchange = peer.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      payload: {},
    });
    expect(peer.state).toBe('open');

    rejectSettlement(new Error('raw socket failure'));
    const failure = await exchange.next().catch((caught: unknown) => caught);
    expectPeerFailure(failure, 'writer-failed');
    expect(peer.state).toBe('closed');
  });

  it('does not send or retain task state when preparation aborts before writer admission', async () => {
    const controller = new AbortController();
    const writer = vi.fn(() => createSubAgentTransportPeerWriterAdmission());
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-pre-admission-abort',
      createMessageId: () => {
        controller.abort(new Error('raw preparation abort'));
        return 'prepared-but-not-admitted';
      },
      writer,
    });

    let failure: unknown;
    try {
      peer.openRequest({ ...spawnRequest(), signal: controller.signal });
    } catch (caught) {
      failure = caught;
    }
    expectPeerFailure(failure, 'aborted');
    expect(writer).not.toHaveBeenCalled();
    expect(peer.pendingCount).toBe(0);
    expect(peer.state).toBe('open');

    peer.beginDrain();
    let continuationFailure: unknown;
    try {
      peer.openRequest({
        kind: 'events.request',
        taskId: TASK_ID,
        operationId: 'operation-after-preparation-abort',
        payload: {},
      });
    } catch (caught) {
      continuationFailure = caught;
    }
    expectPeerFailure(continuationFailure, 'draining');

    const lateReplyFailure = await peer
      .receive(
        createPacket(
          responseInput({
            channelId: 'channel-pre-admission-abort',
            correlationId: 'prepared-but-not-admitted',
          }),
        ),
      )
      .catch((caught: unknown) => caught);
    expectPeerFailure(lateReplyFailure, 'protocol-violation');
  });

  it('retains an abort tombstone so a late, correctly-bound reply is safely ignored', async () => {
    const packets: SubAgentTransportPeerPacket[] = [];
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-abort',
      createMessageId: messageIds('local'),
      writer: (packet) => {
        packets.push(packet);
        return createSubAgentTransportPeerWriterAdmission();
      },
    });
    const exchange = peer.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      payload: {},
      signal: controller.signal,
    });
    controller.abort(new Error('raw abort reason'));

    const aborted = await exchange.next().catch((caught: unknown) => caught);
    expectPeerFailure(aborted, 'aborted');
    expect(removeListener).toHaveBeenCalledTimes(1);
    const late = createPacket(
      responseInput({
        channelId: 'channel-abort',
        correlationId: exchange.messageId,
      }),
    );
    await expect(peer.receive(late)).resolves.toBeUndefined();
    await expect(peer.receive(late)).resolves.toBeUndefined();
    expect(peer.state).toBe('open');
    expect(JSON.stringify(aborted)).not.toContain('raw abort reason');
  });

  it('bounds admitted abort tombstones and fail-closes instead of retaining them indefinitely', async () => {
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-tombstone-bound',
      createMessageId: messageIds('bounded'),
      writer: () => createSubAgentTransportPeerWriterAdmission(),
      maxTombstones: 1,
    });
    const first = peer.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: 'bounded-operation-1',
      payload: {},
      signal: firstAbort.signal,
    });
    const second = peer.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: 'bounded-operation-2',
      payload: {},
      signal: secondAbort.signal,
    });

    firstAbort.abort();
    expectPeerFailure(await first.next().catch((error: unknown) => error), 'aborted');
    expect(peer.state).toBe('draining');
    expect(peer.tombstoneCount).toBe(1);

    secondAbort.abort();
    expectPeerFailure(await second.next().catch((error: unknown) => error), 'aborted');
    expect(peer.state).toBe('closed');
    expect(peer.pendingCount).toBe(0);
    expect(peer.tombstoneCount).toBe(0);
  });

  it('close clears timeout/signal resources and rejects pending next calls', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const timerHandle = Object.freeze({ id: 1 });
    const timers = {
      set: vi.fn(() => timerHandle),
      clear: vi.fn(),
    };
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-close',
      writer: () => createSubAgentTransportPeerWriterAdmission(),
      timers,
    });
    const exchange = peer.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      payload: {},
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    const pending = exchange.next();
    peer.close();

    const error = await pending.catch((caught: unknown) => caught);
    expectPeerFailure(error, 'closed');
    expect(timers.set).toHaveBeenCalledWith(expect.any(Function), 5_000);
    expect(timers.clear).toHaveBeenCalledWith(timerHandle);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(peer.pendingCount).toBe(0);
    expect(peer.state).toBe('closed');
  });

  it('chunks timeouts above the Node timer ceiling without shortening them', async () => {
    const scheduled: {
      readonly callback: () => void;
      readonly delayMs: number;
      readonly id: number;
    }[] = [];
    const cleared: number[] = [];
    let nextTimerId = 1;
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-long-timeout',
      writer: () => createSubAgentTransportPeerWriterAdmission(),
      timers: {
        set: (callback, delayMs) => {
          const timer = { callback, delayMs, id: nextTimerId++ };
          scheduled.push(timer);
          return timer.id;
        },
        clear: (handle) => cleared.push(handle as number),
      },
    });
    const exchange = peer.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      payload: {},
      timeoutMs: 2 ** 31,
    });

    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([2_147_483_647]);
    scheduled[0]!.callback();
    expect(peer.pendingCount).toBe(1);
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([2_147_483_647, 1]);
    scheduled[1]!.callback();
    const failure = await exchange.next().catch((caught: unknown) => caught);
    expectPeerFailure(failure, 'timed-out');
    expect(peer.pendingCount).toBe(0);
    expect(cleared).toEqual([]);
  });

  it('resets the public cached request count when the peer closes', async () => {
    const peer = new SubAgentTransportPeer({
      channelId: 'channel-cache-count-close',
      writer: () => createSubAgentTransportPeerWriterAdmission(),
      handler: (request) => request.reply(eventsReply()),
    });
    await peer.receive(requestPacket('channel-cache-count-close'));
    expect(peer.cachedRequestCount).toBe(1);

    peer.close();
    expect(peer.cachedRequestCount).toBe(0);
  });

  it('requires rollover at pending, request-cache, byte-cache and sequence bounds', async () => {
    const pendingPeer = new SubAgentTransportPeer({
      channelId: 'channel-pending-limit',
      writer: () => createSubAgentTransportPeerWriterAdmission(),
      maxPending: 1,
    });
    pendingPeer.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: 'operation-first',
      payload: {},
    });
    let pendingError: unknown;
    try {
      pendingPeer.openRequest({
        kind: 'events.request',
        taskId: TASK_ID,
        operationId: 'operation-second',
        payload: {},
      });
    } catch (error) {
      pendingError = error;
    }
    expectPeerFailure(pendingError, 'pending-limit-exceeded');
    expect(pendingPeer.state).toBe('draining');

    const byteHandler = vi.fn();
    const bytePeer = new SubAgentTransportPeer({
      channelId: 'channel-byte-limit',
      writer: () => createSubAgentTransportPeerWriterAdmission(),
      handler: byteHandler,
      maxCachedBytes: 1,
    });
    const byteError = await bytePeer
      .receive(requestPacket('channel-byte-limit'))
      .catch((caught: unknown) => caught);
    expectPeerFailure(byteError, 'cache-limit-exceeded');
    expect(byteHandler).not.toHaveBeenCalled();

    const senderPackets: SubAgentTransportPeerPacket[] = [];
    const sender = new SubAgentTransportPeer({
      channelId: 'channel-request-limit',
      createMessageId: messageIds('sender'),
      writer: (packet) => {
        senderPackets.push(packet);
        return createSubAgentTransportPeerWriterAdmission();
      },
    });
    const cacheHandler = vi.fn(async (request: SubAgentTransportPeerHandlerRequest) =>
      request.reply(eventsReply()),
    );
    const cachedReplies: SubAgentTransportPeerPacket[] = [];
    const cachePeer = new SubAgentTransportPeer({
      channelId: 'channel-request-limit',
      createMessageId: messageIds('cache'),
      writer: (packet) => {
        cachedReplies.push(packet);
        return createSubAgentTransportPeerWriterAdmission();
      },
      handler: cacheHandler,
      maxCachedRequests: 1,
    });
    sender.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: 'operation-cached',
      payload: {},
    });
    await cachePeer.receive(senderPackets[0]!);
    expect(cachePeer.state).toBe('draining');
    await cachePeer.receive(senderPackets[0]!);
    expect(cacheHandler).toHaveBeenCalledTimes(1);
    expect(cachedReplies).toHaveLength(2);

    sender.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: 'operation-new',
      payload: {},
    });
    const rollover = await cachePeer.receive(senderPackets[1]!).catch((caught: unknown) => caught);
    expectPeerFailure(rollover, 'rollover-required');
    expect(cachePeer.state).toBe('closed');

    const sequencePeer = new SubAgentTransportPeer({
      channelId: 'channel-sequence-limit',
      writer: () => createSubAgentTransportPeerWriterAdmission(),
      maxTrackedSequences: 1,
    });
    sequencePeer.openRequest({
      kind: 'events.request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      payload: {},
    });
    expect(sequencePeer.state).toBe('draining');
    expect(
      () =>
        new SubAgentTransportPeer({
          channelId: 'channel-sequence-too-large',
          writer: () => createSubAgentTransportPeerWriterAdmission(),
          maxTrackedSequences: SUBAGENT_TRANSPORT_MAX_SEQUENCE_WINDOW + 1,
        }),
    ).toThrow(/between 1 and 1000000/u);
  });

  it('validates missing, orphan, duplicate, corrupt and oversized sidecars before dispatch', async () => {
    const data = Uint8Array.from([1, 2]);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const sidecar = createSubAgentTransportArtifactSidecar({
      sidecarId: 'sidecar-1',
      artifact: {
        version: '1',
        id: 'artifact-1',
        mediaType: 'application/octet-stream',
        size: data.byteLength,
        sha256,
      },
      data,
    });
    const secondData = Uint8Array.from([3, 4]);
    const secondSha256 = createHash('sha256').update(secondData).digest('hex');
    const secondSidecar = createSubAgentTransportArtifactSidecar({
      sidecarId: 'sidecar-2',
      artifact: {
        version: '1',
        id: 'artifact-2',
        mediaType: 'application/octet-stream',
        size: secondData.byteLength,
        sha256: secondSha256,
      },
      data: secondData,
    });
    class UnderreportsFirstByteLength extends Uint8Array {
      reads = 0;

      override get byteLength(): number {
        this.reads += 1;
        return this.reads === 1 ? 1 : this.buffer.byteLength;
      }
    }
    const changingLengthSidecar = {
      descriptor: secondSidecar.descriptor,
      data: new UnderreportsFirstByteLength(secondData),
    };

    const cases: readonly {
      readonly name: string;
      readonly sidecars: SubAgentTransportPeerPacket['sidecars'];
      readonly expected: readonly string[];
      readonly maxSidecarBytes?: number;
      readonly maxSidecars?: number;
      readonly reason: SubAgentTransportPeerError['reason'];
    }[] = [
      { name: 'orphan', sidecars: [sidecar], expected: [], reason: 'protocol-violation' },
      { name: 'missing', sidecars: [], expected: ['sidecar-1'], reason: 'protocol-violation' },
      {
        name: 'duplicate',
        sidecars: [sidecar, sidecar],
        expected: ['sidecar-1'],
        reason: 'protocol-violation',
      },
      {
        name: 'corrupt',
        sidecars: [{ descriptor: sidecar.descriptor, data: Uint8Array.from([9, 9]) }],
        expected: ['sidecar-1'],
        reason: 'protocol-violation',
      },
      {
        name: 'oversized',
        sidecars: [sidecar],
        expected: ['sidecar-1'],
        maxSidecarBytes: 1,
        reason: 'sidecar-limit-exceeded',
      },
      {
        name: 'too-many',
        sidecars: [sidecar, sidecar],
        expected: ['sidecar-1'],
        maxSidecars: 1,
        reason: 'sidecar-limit-exceeded',
      },
      {
        name: 'owned-total-recheck',
        sidecars: [sidecar, changingLengthSidecar],
        expected: ['sidecar-1', 'sidecar-2'],
        maxSidecarBytes: 3,
        reason: 'sidecar-limit-exceeded',
      },
    ];

    for (const testCase of cases) {
      const channelId = `channel-sidecar-${testCase.name}`;
      const handler = vi.fn();
      const peer = new SubAgentTransportPeer({
        channelId,
        writer: () => createSubAgentTransportPeerWriterAdmission(),
        handler,
        validateSidecars: () => testCase.expected,
        ...(testCase.maxSidecarBytes === undefined
          ? {}
          : { maxSidecarBytes: testCase.maxSidecarBytes }),
        ...(testCase.maxSidecars === undefined ? {} : { maxSidecars: testCase.maxSidecars }),
      });
      const packet = requestPacket(channelId);
      const error = await peer
        .receive({ frame: packet.frame, sidecars: testCase.sidecars })
        .catch((caught: unknown) => caught);
      expectPeerFailure(error, testCase.reason);
      expect(handler, testCase.name).not.toHaveBeenCalled();
      expect(peer.state).toBe('closed');
    }

    const validHandler = vi.fn(async (request: SubAgentTransportPeerHandlerRequest) =>
      request.reply(eventsReply()),
    );
    const validPeer = new SubAgentTransportPeer({
      channelId: 'channel-sidecar-valid',
      writer: () => createSubAgentTransportPeerWriterAdmission(),
      handler: validHandler,
      validateSidecars: (envelope) => (envelope.kind === 'events.request' ? ['sidecar-1'] : []),
    });
    const validPacket = requestPacket('channel-sidecar-valid');
    await expect(
      validPeer.receive({ frame: validPacket.frame, sidecars: [sidecar] }),
    ).resolves.toBeUndefined();
    expect(validHandler).toHaveBeenCalledTimes(1);

    const replayReplies: SubAgentTransportPeerPacket[] = [];
    const replayHandler = vi.fn(async (request: SubAgentTransportPeerHandlerRequest) =>
      request.reply(eventsReply()),
    );
    const replayPeer = new SubAgentTransportPeer({
      channelId: 'channel-sidecar-order-replay',
      writer: (packet) => {
        replayReplies.push(packet);
        return createSubAgentTransportPeerWriterAdmission();
      },
      handler: replayHandler,
      validateSidecars: (envelope) =>
        envelope.kind === 'events.request' ? ['sidecar-1', 'sidecar-2'] : [],
    });
    const replayPacket = requestPacket('channel-sidecar-order-replay');
    await replayPeer.receive({ frame: replayPacket.frame, sidecars: [sidecar, secondSidecar] });
    await replayPeer.receive({ frame: replayPacket.frame, sidecars: [secondSidecar, sidecar] });
    expect(replayHandler).toHaveBeenCalledTimes(1);
    expect(replayReplies).toHaveLength(2);
    expect(replayReplies[1]?.frame).toBe(replayReplies[0]?.frame);
  });
});
