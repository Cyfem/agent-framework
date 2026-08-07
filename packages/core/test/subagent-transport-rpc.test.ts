import { describe, expect, it } from 'vitest';
import { acceptanceIt } from '../../../testkit';

import {
  DEFAULT_SUBAGENT_LIMITS,
  SubAgentTransportError,
  createSubAgentExecutionRequestWire,
  type SubAgentExecutionRequest,
  type SubAgentExecutorBinding,
  type SubAgentTaskEvent,
} from '../src';
import {
  SUBAGENT_TRANSPORT_RPC_KINDS,
  SubAgentTransportRpcError,
  type SubAgentTransportRpcEnvelope,
  type SubAgentTransportRpcKind,
} from '../src/subagent/transport-rpc';
import {
  assertSubAgentTransportRpcEnvelope,
  createSubAgentTransportRpcEnvelope,
  decodeSubAgentTransportRpcFrame,
  encodeSubAgentTransportRpcFrame,
} from '../src/subagent/transport-rpc-codec';

const textEncoder = new TextEncoder();

const requestKinds = [
  'executor.request',
  'control.request',
  'cancel.request',
  'snapshot.request',
  'events.request',
  'model.request',
] as const satisfies readonly SubAgentTransportRpcKind[];

const replyKinds = [
  'executor.accepted',
  'executor.settled',
  'control.reply',
  'cancel.ack',
  'snapshot.reply',
  'events.page',
  'model.reply',
] as const satisfies readonly SubAgentTransportRpcKind[];

function createBinding(overrides: Partial<SubAgentExecutorBinding> = {}): SubAgentExecutorBinding {
  return {
    version: '1',
    executorName: 'process',
    ownerSessionId: 'owner-session-1',
    taskId: 'task-1',
    subagentSessionId: 'subagent-session-1',
    definitionName: 'researcher',
    definitionVersion: '2',
    runnerId: 'builtin-child-runner',
    runnerVersion: '1',
    adapterStateVersion: '1',
    recoveryData: { kind: 'process/v1', jobId: 'job-1' },
    ...overrides,
  };
}

function createExecutionRequest(
  overrides: Partial<SubAgentExecutionRequest<{ readonly query: string }>> = {},
): SubAgentExecutionRequest<{ readonly query: string }> {
  return {
    operation: {
      type: 'create',
      operationId: 'operation-1',
      idempotencyKey: 'idempotency-1',
    },
    ownerSessionId: 'owner-session-1',
    runId: 'run-1',
    taskId: 'task-1',
    subagentSessionId: 'subagent-session-1',
    path: ['task-1'],
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
      parentTaskId: 'task-1',
      path: ['task-1'],
      depth: 1,
      catalogRevision: 1,
      definitions: [{ name: 'reviewer', version: '1', executors: ['process'] }],
    },
    limits: DEFAULT_SUBAGENT_LIMITS,
    signal: new AbortController().signal,
    deadlineAt: 121_000,
    ...overrides,
  };
}

function createTaskEvent(): SubAgentTaskEvent {
  return {
    eventId: 'event-1',
    sequence: 1,
    type: 'progress.reported',
    sessionId: 'owner-session-1',
    runId: 'run-1',
    taskId: 'task-1',
    path: ['task-1'],
    definition: { name: 'researcher', version: '2' },
    executor: 'process',
    attempt: 1,
    timestamp: 1_000,
    data: { status: 'running', length: 12 },
  };
}

function createRpcEnvelope(
  kind: SubAgentTransportRpcKind,
  payload: unknown,
  options: {
    readonly response?: boolean;
    readonly sequence?: number;
    readonly messageId?: string;
    readonly operationId?: string;
  } = {},
): SubAgentTransportRpcEnvelope {
  return {
    version: '1',
    channelId: 'channel-1',
    sequence: options.sequence ?? 1,
    messageId: options.messageId ?? `message-${kind}`,
    ...(options.response ? { correlationId: 'request-message-1' } : {}),
    taskId: 'task-1',
    operationId: options.operationId ?? 'operation-1',
    kind,
    payload,
  } as unknown as SubAgentTransportRpcEnvelope;
}

function createRpcFixtures(): Record<SubAgentTransportRpcKind, SubAgentTransportRpcEnvelope> {
  const binding = createBinding();
  const request = createSubAgentExecutionRequestWire(createExecutionRequest(), {
    now: () => 1_000,
  });

  return {
    'executor.request': createRpcEnvelope('executor.request', { mode: 'execute', request }),
    'executor.accepted': createRpcEnvelope(
      'executor.accepted',
      { mode: 'spawn', binding },
      { response: true },
    ),
    'executor.settled': createRpcEnvelope(
      'executor.settled',
      {
        mode: 'execute',
        outcome: {
          type: 'terminal',
          result: {
            status: 'succeeded',
            task: {
              taskId: 'task-1',
              subAgent: { name: 'researcher', version: '2' },
            },
            executor: 'process',
            output: { proof: 'done' },
            usage: { turns: 2, providerCalls: 1 },
          },
        },
      },
      { response: true },
    ),
    'control.request': createRpcEnvelope('control.request', {
      executionAttempt: 1,
      executionEpoch: 'epoch-1',
      executionFencingToken: '1',
      method: 'execution.reportProgress',
      args: {
        update: { message: 'halfway', percent: 50, data: { phase: 'research' } },
      },
    }),
    'control.reply': createRpcEnvelope(
      'control.reply',
      { method: 'execution.reportProgress', ok: true, result: null },
      { response: true },
    ),
    'cancel.request': createRpcEnvelope('cancel.request', {
      binding,
      reason: 'host-cancelled',
    }),
    'cancel.ack': createRpcEnvelope('cancel.ack', { cancelled: true }, { response: true }),
    'snapshot.request': createRpcEnvelope('snapshot.request', { mode: 'snapshot' }),
    'snapshot.reply': createRpcEnvelope(
      'snapshot.reply',
      {
        mode: 'snapshot',
        snapshot: {
          taskId: 'task-1',
          state: 'running',
          binding,
          updatedAt: 1_000,
        },
      },
      { response: true },
    ),
    'events.request': createRpcEnvelope('events.request', {
      afterSequence: 0,
      limit: 32,
    }),
    'events.page': createRpcEnvelope(
      'events.page',
      { events: [createTaskEvent()], nextSequence: 1, done: false },
      { response: true },
    ),
    'model.request': createRpcEnvelope(
      'model.request',
      {
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
        purpose: 'agent',
        iteration: 2,
        requestAttempt: 1,
        requestHash: 'a'.repeat(64),
        context: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'proof', parameters: {} } }],
        remainingMs: 30_000,
      },
      { operationId: 'provider-operation-1' },
    ),
    'model.reply': createRpcEnvelope(
      'model.reply',
      {
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
        ok: true,
        resultHash: 'b'.repeat(64),
        messages: [{ role: 'assistant', content: 'done' }],
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
      { response: true, operationId: 'provider-operation-1' },
    ),
    'protocol.error': createRpcEnvelope(
      'protocol.error',
      {
        error: {
          code: 'EXECUTOR_FAILED',
          message: 'The remote executor rejected the request.',
          retryable: true,
          causeCode: 'REMOTE_REJECTED',
        },
      },
      { response: true },
    ),
  };
}

function expectInvalidRpc(action: () => unknown): void {
  expect(action).toThrowError(SubAgentTransportRpcError);
}

function expectInvalidFrame(action: () => unknown): void {
  expect(action).toThrowError(SubAgentTransportError);
}

describe('Subagent transport v1 semantic RPC codec', () => {
  it('accepts the complete closed kind union with its exact payload and routing shape', () => {
    const fixtures = createRpcFixtures();

    expect(SUBAGENT_TRANSPORT_RPC_KINDS).toEqual([
      'executor.request',
      'executor.accepted',
      'executor.settled',
      'control.request',
      'control.reply',
      'cancel.request',
      'cancel.ack',
      'snapshot.request',
      'snapshot.reply',
      'events.request',
      'events.page',
      'model.request',
      'model.reply',
      'protocol.error',
    ]);

    for (const kind of SUBAGENT_TRANSPORT_RPC_KINDS) {
      expect(() => assertSubAgentTransportRpcEnvelope(fixtures[kind])).not.toThrow();
      expect(
        decodeSubAgentTransportRpcFrame(encodeSubAgentTransportRpcFrame(fixtures[kind])),
      ).toEqual(fixtures[kind]);
    }
  });

  it('rejects unknown kinds, payload swaps and extra payload fields', () => {
    const fixtures = createRpcFixtures();

    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['snapshot.request'],
        kind: 'executor.future',
      }),
    );

    for (let index = 0; index < SUBAGENT_TRANSPORT_RPC_KINDS.length; index += 1) {
      const kind = SUBAGENT_TRANSPORT_RPC_KINDS[index]!;
      const otherKind =
        SUBAGENT_TRANSPORT_RPC_KINDS[(index + 1) % SUBAGENT_TRANSPORT_RPC_KINDS.length]!;
      expectInvalidRpc(() =>
        assertSubAgentTransportRpcEnvelope({
          ...fixtures[kind],
          payload: fixtures[otherKind].payload,
        }),
      );
    }

    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['snapshot.request'],
        payload: { unexpected: true },
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['control.reply'],
        payload: {
          method: 'execution.reportProgress',
          ok: true,
          result: null,
          providerBody: 'must-not-cross',
        },
      }),
    );
  });

  it('normalizes nested semantic validator failures to the stable RPC payload error', () => {
    const fixtures = createRpcFixtures();
    const executionRequest = (
      fixtures['executor.request'].payload as {
        readonly request: Record<string, unknown>;
      }
    ).request;
    const invalidPayloads = [
      {
        ...fixtures['executor.request'],
        payload: {
          mode: 'execute',
          request: { ...executionRequest, remainingMs: 0 },
        },
      },
      {
        ...fixtures['executor.accepted'],
        payload: {
          mode: 'spawn',
          binding: createBinding({ recoveryData: { payload: 'x'.repeat(70 * 1024) } }),
        },
      },
    ];

    for (const envelope of invalidPayloads) {
      let failure: unknown;
      try {
        assertSubAgentTransportRpcEnvelope(envelope);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SubAgentTransportRpcError);
      expect(failure).toMatchObject({
        code: 'SUBAGENT_TRANSPORT_RPC_ERROR',
        reason: 'invalid-rpc-payload',
      });
      expect((failure as Error).cause).toBeDefined();
    }

    let routingFailure: unknown;
    try {
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['executor.request'],
        taskId: 'different-task',
      });
    } catch (error) {
      routingFailure = error;
    }
    expect(routingFailure).toMatchObject({
      code: 'SUBAGENT_TRANSPORT_RPC_ERROR',
      reason: 'invalid-rpc-routing',
    });
  });

  it('requires an exact execution scope on every reverse control request', () => {
    const control = createRpcFixtures()['control.request'];
    if (control.kind !== 'control.request') throw new Error('Expected a control request fixture.');
    const { executionAttempt: _attempt, ...withoutAttempt } = control.payload;
    const { executionEpoch: _epoch, ...withoutEpoch } = control.payload;
    const { executionFencingToken: _fencing, ...withoutFencing } = control.payload;
    expect([_attempt, _epoch, _fencing]).toEqual([1, 'epoch-1', '1']);

    for (const payload of [
      withoutAttempt,
      withoutEpoch,
      withoutFencing,
      { ...control.payload, executionAttempt: 0 },
      { ...control.payload, executionEpoch: '' },
      { ...control.payload, executionFencingToken: '01' },
      { ...control.payload, generation: 1 },
    ]) {
      expectInvalidRpc(() =>
        assertSubAgentTransportRpcEnvelope({
          ...control,
          payload,
        } as unknown as SubAgentTransportRpcEnvelope),
      );
    }
  });

  it('enforces request/reply correlation and task/operation routing identity', () => {
    const fixtures = createRpcFixtures();

    for (const kind of requestKinds) {
      expectInvalidRpc(() =>
        assertSubAgentTransportRpcEnvelope({
          ...fixtures[kind],
          correlationId: 'unexpected-correlation',
        }),
      );
    }

    for (const kind of replyKinds) {
      const missingCorrelation = { ...fixtures[kind] } as Record<string, unknown>;
      delete missingCorrelation.correlationId;
      expectInvalidRpc(() => assertSubAgentTransportRpcEnvelope(missingCorrelation));
    }

    for (const kind of [...requestKinds, ...replyKinds]) {
      for (const field of ['taskId', 'operationId'] as const) {
        const missingIdentity = { ...fixtures[kind] } as Record<string, unknown>;
        delete missingIdentity[field];
        expectInvalidRpc(() => assertSubAgentTransportRpcEnvelope(missingIdentity));
      }
    }

    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['executor.request'],
        taskId: 'different-task',
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['executor.request'],
        operationId: 'different-operation',
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['executor.accepted'],
        taskId: 'different-task',
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['executor.settled'],
        taskId: 'different-task',
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['control.request'],
        payload: {
          method: 'execution.reportProgress',
          args: {
            operationId: 'operation-1',
            update: { message: 'must-not-repeat-route-identity' },
          },
        },
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['cancel.request'],
        taskId: 'different-task',
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['snapshot.reply'],
        taskId: 'different-task',
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['events.page'],
        taskId: 'different-task',
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['model.request'],
        operationId: 'different-provider-operation',
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['model.reply'],
        payload: {
          ...fixtures['model.reply'].payload,
          providerOperationId: 'different-provider-operation',
        },
      }),
    );
  });

  it('keeps Model gateway payloads closed and provider-safe', () => {
    const fixtures = createRpcFixtures();
    const request = fixtures['model.request'];
    const reply = fixtures['model.reply'];

    for (const payload of [
      { ...request.payload, apiKey: 'secret' },
      { ...request.payload, headers: { authorization: 'secret' } },
      { ...request.payload, baseURL: 'https://provider.invalid' },
      { ...reply.payload, raw: { providerResponse: true } },
    ]) {
      expectInvalidRpc(() =>
        assertSubAgentTransportRpcEnvelope({
          ...(Object.hasOwn(payload, 'raw') ? reply : request),
          payload,
        }),
      );
    }

    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...request,
        payload: { ...request.payload, requestHash: 'A'.repeat(64) },
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...reply,
        payload: { ...reply.payload, messages: { not: 'an-array' } },
      }),
    );
  });

  it('rejects C0 and DEL characters in every nested identifier family', () => {
    const fixtures = createRpcFixtures();
    const event = createTaskEvent();
    const invalidEnvelopes = [
      {
        ...fixtures['executor.accepted'],
        payload: {
          mode: 'spawn',
          binding: createBinding({ ownerSessionId: 'owner\u0000hidden' }),
        },
      },
      {
        ...fixtures['executor.accepted'],
        payload: {
          mode: 'spawn',
          binding: createBinding({ subagentSessionId: 'session\u007fhidden' }),
        },
      },
      {
        ...fixtures['executor.settled'],
        payload: {
          mode: 'execute',
          outcome: {
            type: 'paused',
            reason: 'approval',
            task: {
              taskId: 'task-1',
              subAgent: { name: 'researcher', version: '2' },
            },
            approvals: [
              {
                callId: 'call-1',
                toolName: 'dangerous-tool',
                summary: 'Approve operation.',
                approvalId: 'approval\u0000hidden',
                ownerSessionId: 'owner-session-1',
                taskId: 'task-1',
                createdAt: 0,
                revision: 1,
              },
            ],
            checkpointRevision: 1,
          },
        },
      },
      {
        ...fixtures['events.page'],
        payload: {
          events: [{ ...event, eventId: 'event\u007fhidden' }],
          nextSequence: 1,
          done: false,
        },
      },
      {
        ...fixtures['events.page'],
        payload: {
          events: [{ ...event, path: ['task-1', 'child\u0000hidden'] }],
          nextSequence: 1,
          done: false,
        },
      },
    ];

    for (const envelope of invalidEnvelopes) {
      let failure: unknown;
      try {
        assertSubAgentTransportRpcEnvelope(envelope);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SubAgentTransportRpcError);
      expect(failure).toMatchObject({
        code: 'SUBAGENT_TRANSPORT_RPC_ERROR',
        reason: 'invalid-rpc-routing',
      });
    }
  });

  acceptanceIt('C7-TRANSPORT-06.l1.rpc-outcome', 'rpc-outcome', () => {
    const fixtures = createRpcFixtures();
    const request = (
      fixtures['executor.request'].payload as {
        readonly request: unknown;
      }
    ).request;

    expect(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['executor.request'],
        payload: { mode: 'spawn', request },
      }),
    ).not.toThrow();
    expect(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['snapshot.request'],
        payload: { mode: 'wait' },
      }),
    ).not.toThrow();
    expect(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['executor.settled'],
        payload: { ...fixtures['executor.settled'].payload, mode: 'wait' },
      }),
    ).not.toThrow();
    expect(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['executor.settled'],
        payload: { ...fixtures['executor.settled'].payload, mode: 'spawn' },
      }),
    ).not.toThrow();
    expect(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['executor.settled'],
        payload: {
          mode: 'execute',
          outcome: {
            type: 'paused',
            reason: 'approval',
            task: {
              taskId: 'task-1',
              subAgent: { name: 'researcher', version: '2' },
            },
            approvals: [
              {
                callId: 'call-1',
                toolName: 'dangerous-tool',
                summary: 'Approve operation.',
                approvalId: 'approval-1',
                ownerSessionId: 'owner-session-1',
                taskId: 'task-1',
                createdAt: 0,
                revision: 1,
              },
            ],
            checkpointRevision: 1,
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['executor.settled'],
        payload: {
          mode: 'spawn',
          outcome: {
            type: 'recovery_required',
            reason: 'unbound_create',
            operationId: 'operation-1',
            causeCode: 'REMOTE_CREATE_UNKNOWN',
          },
        },
      }),
    ).not.toThrow();
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['executor.accepted'],
        payload: { ...fixtures['executor.accepted'].payload, mode: 'execute' },
      }),
    );
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['snapshot.reply'],
        payload: { ...fixtures['snapshot.reply'].payload, mode: 'wait' },
      }),
    );
  });

  it('cross-checks every paused approval task identity', () => {
    const settled = createRpcFixtures()['executor.settled'];
    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...settled,
        payload: {
          mode: 'execute',
          outcome: {
            type: 'paused',
            reason: 'approval',
            task: {
              taskId: 'task-1',
              subAgent: { name: 'researcher', version: '2' },
            },
            approvals: [
              {
                callId: 'call-1',
                toolName: 'dangerous-tool',
                summary: 'Approve operation.',
                approvalId: 'approval-1',
                ownerSessionId: 'owner-session-1',
                taskId: 'other-task',
                createdAt: 0,
                revision: 1,
              },
            ],
            checkpointRevision: 1,
          },
        },
      }),
    );
  });

  it('forces the factory-owned transport version even on a forged runtime input', () => {
    const fixture = createRpcFixtures()['snapshot.request'];
    const created = createSubAgentTransportRpcEnvelope({
      ...fixture,
      version: '2',
    } as unknown as Parameters<typeof createSubAgentTransportRpcEnvelope>[0]);
    expect(created.version).toBe('1');
  });

  it('requires protocol.error correlation and paired optional task/operation identity', () => {
    const protocolError = createRpcFixtures()['protocol.error'];
    const missingCorrelation = { ...protocolError } as Record<string, unknown>;
    delete missingCorrelation.correlationId;
    expectInvalidRpc(() => assertSubAgentTransportRpcEnvelope(missingCorrelation));

    const correlationOnly = { ...protocolError } as Record<string, unknown>;
    delete correlationOnly.taskId;
    delete correlationOnly.operationId;
    expect(() => assertSubAgentTransportRpcEnvelope(correlationOnly)).not.toThrow();

    const taskOnly = { ...protocolError } as Record<string, unknown>;
    delete taskOnly.operationId;
    expectInvalidRpc(() => assertSubAgentTransportRpcEnvelope(taskOnly));

    const operationOnly = { ...protocolError } as Record<string, unknown>;
    delete operationOnly.taskId;
    expectInvalidRpc(() => assertSubAgentTransportRpcEnvelope(operationOnly));
  });

  it('accepts only the safe error descriptor and never a raw Error, body, stack or cause', () => {
    const fixtures = createRpcFixtures();
    const safeDescriptor = {
      code: 'EXECUTOR_FAILED',
      message: 'Executor unavailable.',
      retryable: true,
      causeCode: 'PROCESS_EXIT',
      outcomeUnknown: true,
    } as const;

    expect(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['protocol.error'],
        payload: { error: safeDescriptor },
      }),
    ).not.toThrow();
    expect(() =>
      assertSubAgentTransportRpcEnvelope({
        ...fixtures['control.reply'],
        payload: { method: 'execution.reportProgress', ok: false, error: safeDescriptor },
      }),
    ).not.toThrow();

    for (const unsafeError of [
      new Error('raw error'),
      { ...safeDescriptor, body: '{"apiKey":"secret"}' },
      { ...safeDescriptor, stack: 'at providerCall (...)' },
      { ...safeDescriptor, cause: { response: 'raw provider response' } },
      { ...safeDescriptor, eventCursor: 17 },
      { ...safeDescriptor, unexpected: true },
    ]) {
      expectInvalidRpc(() =>
        assertSubAgentTransportRpcEnvelope({
          ...fixtures['protocol.error'],
          payload: { error: unsafeError },
        }),
      );
      expectInvalidRpc(() =>
        assertSubAgentTransportRpcEnvelope({
          ...fixtures['control.reply'],
          payload: { method: 'execution.reportProgress', ok: false, error: unsafeError },
        }),
      );
    }
  });

  it('uses canonical JCS encoding and rejects non-JSON-safe runtime values', () => {
    const envelope = {
      ...createRpcFixtures()['control.reply'],
      payload: {
        method: 'completion.submitResult',
        ok: true,
        result: {
          schemaVersion: '1',
          receiptId: 'receipt-1',
          taskId: 'task-1',
          callId: 'call-1',
          revision: 1,
          outputHash: 'a'.repeat(64),
          submittedAt: 0,
          status: 'accepted',
        },
      },
    } as unknown as SubAgentTransportRpcEnvelope;

    expect(encodeSubAgentTransportRpcFrame(envelope)).toBe(
      `{"channelId":"channel-1","correlationId":"request-message-1","kind":"control.reply","messageId":"message-control.reply","operationId":"operation-1","payload":{"method":"completion.submitResult","ok":true,"result":{"callId":"call-1","outputHash":"${'a'.repeat(64)}","receiptId":"receipt-1","revision":1,"schemaVersion":"1","status":"accepted","submittedAt":0,"taskId":"task-1"}},"sequence":1,"taskId":"task-1","version":"1"}`,
    );

    expectInvalidRpc(() =>
      assertSubAgentTransportRpcEnvelope({
        ...createRpcFixtures()['control.reply'],
        payload: {
          method: 'execution.reportProgress',
          ok: true,
          result: { callback: () => undefined },
        },
      }),
    );
    expectInvalidFrame(() =>
      decodeSubAgentTransportRpcFrame(
        '{"version":"1","channelId":"channel-1","sequence":1,"messageId":"message-1","correlationId":"request-message-1","taskId":"task-1","operationId":"operation-1","kind":"control.reply","payload":{"method":"execution.reportProgress","ok":true,"result":null,"result":null}}',
      ),
    );
  });

  it('enforces frame, JSON depth and expanded-node limits before dispatch', () => {
    const fixtures = createRpcFixtures();
    const frame = encodeSubAgentTransportRpcFrame(fixtures['events.request']);
    const frameBytes = textEncoder.encode(frame).byteLength;

    expect(() =>
      encodeSubAgentTransportRpcFrame(fixtures['events.request'], {
        maxFrameBytes: frameBytes,
      }),
    ).not.toThrow();
    expectInvalidRpc(() =>
      encodeSubAgentTransportRpcFrame(fixtures['events.request'], {
        maxFrameBytes: frameBytes - 1,
      }),
    );
    expectInvalidFrame(() =>
      decodeSubAgentTransportRpcFrame(frame, { maxFrameBytes: frameBytes - 1 }),
    );
    expect(() =>
      decodeSubAgentTransportRpcFrame(frame, { maxCanonicalBytes: frameBytes }),
    ).not.toThrow();
    expectInvalidRpc(() =>
      decodeSubAgentTransportRpcFrame(frame, { maxCanonicalBytes: frameBytes - 1 }),
    );
    expect(() =>
      decodeSubAgentTransportRpcFrame(frame, {
        maxFrameBytes: frameBytes,
        maxCanonicalBytes: frameBytes,
      }),
    ).not.toThrow();
    for (const action of [
      () =>
        assertSubAgentTransportRpcEnvelope(fixtures['events.request'], {
          maxFrameBytes: frameBytes,
          maxCanonicalBytes: frameBytes + 1,
        }),
      () =>
        encodeSubAgentTransportRpcFrame(fixtures['events.request'], {
          maxFrameBytes: frameBytes,
          maxCanonicalBytes: frameBytes + 1,
        }),
      () =>
        decodeSubAgentTransportRpcFrame(frame, {
          maxFrameBytes: frameBytes,
          maxCanonicalBytes: frameBytes + 1,
        }),
    ]) {
      expect(action).toThrowError(RangeError);
    }

    const nested = {
      ...fixtures['control.reply'],
      payload: {
        method: 'completion.submitResult',
        ok: true,
        result: {
          schemaVersion: '1',
          receiptId: 'receipt-1',
          taskId: 'task-1',
          callId: 'call-1',
          revision: 1,
          outputHash: 'a'.repeat(64),
          submittedAt: 0,
          status: 'accepted',
        },
      },
    } as unknown as SubAgentTransportRpcEnvelope;
    const nestedFrame = encodeSubAgentTransportRpcFrame(nested);
    expectInvalidFrame(() => decodeSubAgentTransportRpcFrame(nestedFrame, { maxJsonDepth: 2 }));
    expectInvalidFrame(() => decodeSubAgentTransportRpcFrame(nestedFrame, { maxJsonNodes: 8 }));

    let deepCandidate: unknown = null;
    for (let depth = 0; depth < 130; depth += 1) deepCandidate = { next: deepCandidate };
    const explicitlyDeeper = {
      ...fixtures['control.request'],
      payload: {
        executionAttempt: 1,
        executionEpoch: 'epoch-1',
        executionFencingToken: '1',
        method: 'completion.submitResult',
        args: { callId: 'call-deep', candidate: deepCandidate },
      },
    } as unknown as SubAgentTransportRpcEnvelope;
    const explicitlyDeeperFrame = encodeSubAgentTransportRpcFrame(explicitlyDeeper, {
      maxJsonDepth: 150,
    });
    expect(() =>
      decodeSubAgentTransportRpcFrame(explicitlyDeeperFrame, { maxJsonDepth: 150 }),
    ).not.toThrow();
  });

  it('allows the zero cursor for an empty first events page', () => {
    const page = createRpcFixtures()['events.page'];
    expect(() =>
      assertSubAgentTransportRpcEnvelope({
        ...page,
        payload: { events: [], nextSequence: 0, done: false },
      }),
    ).not.toThrow();
  });

  it('recursively freezes every decoded semantic payload before dispatch', () => {
    const envelope = {
      ...createRpcFixtures()['control.reply'],
      payload: {
        method: 'completion.submitResult',
        ok: true,
        result: {
          schemaVersion: '1',
          receiptId: 'receipt-1',
          taskId: 'task-1',
          callId: 'call-1',
          revision: 1,
          outputHash: 'a'.repeat(64),
          submittedAt: 0,
          status: 'accepted',
        },
      },
    } as unknown as SubAgentTransportRpcEnvelope;
    const decoded = decodeSubAgentTransportRpcFrame(
      encodeSubAgentTransportRpcFrame(envelope),
    ) as unknown as {
      payload: {
        result: { receiptId: string };
      };
    };

    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.payload)).toBe(true);
    expect(Object.isFrozen(decoded.payload.result)).toBe(true);
    expect(decoded.payload.result.receiptId).toBe('receipt-1');
    expect(() => {
      decoded.payload.result.receiptId = 'changed';
    }).toThrow(TypeError);
  });
});
