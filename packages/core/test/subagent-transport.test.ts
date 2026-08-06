import { describe, expect, it, vi } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import {
  DEFAULT_SUBAGENT_LIMITS,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_SEQUENCE_WINDOW,
  SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES,
  SUBAGENT_TRANSPORT_MAX_SEQUENCE_WINDOW,
  SUBAGENT_TRANSPORT_VERSION,
  SubAgentTransportError,
  SubAgentTransportSequenceTracker,
  assertSubAgentExecutionRequestWire,
  assertSubAgentTransportEnvelope,
  canonicalJsonSha256,
  createSubAgentExecutionRequestWire,
  decodeSubAgentExecutionRequestWire,
  decodeSubAgentTransportFrame,
  encodeSubAgentTransportFrame,
  encodeSubAgentTransportFrameBytes,
  measureCanonicalJsonBytes,
  reconstructSubAgentExecutionRequest,
  subAgentTransportEnvelopeSha256,
  subAgentTransportPayloadSha256,
  type SubAgentExecutionRequest,
  type SubAgentExecutionRequestWire,
  type SubAgentChildCheckpoint,
  type SubAgentExecutorBinding,
  type JsonValue,
  type SubAgentTransportEnvelope,
} from '../src';

const textEncoder = new TextEncoder();

function createEnvelope(
  overrides: Partial<SubAgentTransportEnvelope<string, JsonValue>> = {},
): SubAgentTransportEnvelope<string, JsonValue> {
  return {
    version: '1',
    channelId: 'channel-1',
    sequence: 1,
    messageId: 'message-1',
    kind: 'executor.execute',
    payload: { query: 'hello' },
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
      idempotencyKey: 'request-1',
    },
    ownerSessionId: 'owner-session-1',
    runId: 'run-1',
    taskId: 'task-1',
    subagentSessionId: 'subagent-session-1',
    path: ['task-1'],
    attempt: 1,
    executionEpoch: 'epoch-1',
    executionFencingToken: 'fence-1',
    definition: { name: 'researcher', version: '2' },
    input: { query: 'hello' },
    projectedContext: [
      { kind: 'text', name: 'brief', text: 'Use primary sources.' },
      { kind: 'data', name: 'constraints', value: { citations: true } },
    ],
    delegation: {
      version: '1',
      ownerSessionId: 'owner-session-1',
      runId: 'run-1',
      parentTaskId: 'task-1',
      path: ['task-1'],
      depth: 1,
      catalogRevision: 1,
      definitions: [{ name: 'reviewer', version: '1', executors: ['local', 'process'] }],
    },
    limits: DEFAULT_SUBAGENT_LIMITS,
    signal: new AbortController().signal,
    deadlineAt: 121_000,
    ...overrides,
  };
}

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

function createCheckpoint(
  overrides: Partial<SubAgentChildCheckpoint> = {},
): SubAgentChildCheckpoint {
  return {
    version: '1' as const,
    runnerId: 'builtin-child-runner',
    runnerVersion: '1',
    protocolContext: { protocol: 'openai-chat', codecVersion: '1', value: [] },
    contextStore: {
      version: '1' as const,
      protocol: 'openai-chat',
      codecVersion: '1',
      revision: 0,
      rawHistory: [],
      activeSpans: [
        {
          spanId: 'context-span-1',
          kind: 'seed',
          closed: true,
          originalContext: [],
          entries: [],
        },
      ],
      nextRawItemId: 1,
      nextSpanId: 2,
      nextEntryId: 1,
    },
    modelIteration: 0,
    maxIterations: 6,
    ...overrides,
  };
}

function createPendingCheckpoint(): SubAgentChildCheckpoint {
  const input = { query: 'child work' } as const;
  return createCheckpoint({
    pendingBatch: {
      version: '1',
      batchId: 'batch-1',
      assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
      calls: [
        {
          version: '1',
          operationId: 'child-operation-1',
          kind: 'tool',
          callId: 'child-call-1',
          name: 'lookup',
          input,
          inputHash: canonicalJsonSha256(input),
          status: 'prepared',
          order: 0,
        },
      ],
      endRequested: false,
      createdAt: 10,
    },
  });
}

function createRestorablePendingCheckpoint(): SubAgentChildCheckpoint {
  const toolInput = { query: 'durable lookup' } as const;
  const agentInput = { subAgent: 'reviewer', executor: 'process', input: 'review proof' } as const;
  return createCheckpoint({
    pendingBatch: {
      version: '1',
      batchId: 'batch-rich-pending',
      assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
      calls: [
        {
          version: '1',
          operationId: 'rich-tool-operation',
          kind: 'tool',
          callId: 'rich-tool-call',
          name: 'lookup',
          input: toolInput,
          inputHash: canonicalJsonSha256(toolInput),
          status: 'result_ready',
          order: 0,
          result: { proof: 'tool-ready' },
        },
        {
          version: '1',
          operationId: 'rich-agent-operation',
          kind: 'agent',
          callId: 'rich-agent-call',
          name: 'agent',
          input: agentInput,
          inputHash: canonicalJsonSha256(agentInput),
          status: 'waiting_approval',
          order: 1,
          taskId: 'rich-agent-task',
          approvals: ['rich-approval-1', 'rich-approval-2'],
        },
      ],
      endRequested: false,
      createdAt: 15,
    },
  });
}

function createResultSubmissionCheckpoint(): SubAgentChildCheckpoint {
  const output = { proof: 'accepted' } as const;
  const outputHash = canonicalJsonSha256(output);
  const input = { result: output } as const;
  return createCheckpoint({
    pendingBatch: {
      version: '1',
      batchId: 'batch-result-1',
      assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
      calls: [
        {
          version: '1',
          operationId: 'child-operation-result-1',
          kind: 'tool',
          callId: 'child-call-result-1',
          name: 'agent-result',
          input,
          inputHash: canonicalJsonSha256(input),
          status: 'result_submitted',
          order: 0,
          // ToolExecutionRecord persists handler output as a JSON string in pending checkpoints.
          result: JSON.stringify({ ok: true, status: 'accepted', outputHash }),
        },
      ],
      endRequested: false,
      createdAt: 20,
    },
    resultSubmission: {
      version: '1',
      callId: 'child-call-result-1',
      output,
      outputHash,
    },
  });
}

function createEndAgentCheckpoint(
  status: 'prepared' | 'in_flight' | 'result_ready' | 'applied',
): SubAgentChildCheckpoint {
  const resultReady = status === 'result_ready' || status === 'applied';
  const input = {} as const;
  const submittedOutput = { proof: 'accepted-before-end' } as const;
  return createCheckpoint({
    pendingBatch: {
      version: '1',
      batchId: `batch-end-${status}`,
      assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
      calls: [
        {
          version: '1',
          operationId: `child-operation-end-${status}`,
          kind: 'end-agent',
          callId: `child-call-end-${status}`,
          name: 'end-agent',
          input,
          inputHash: canonicalJsonSha256(input),
          status,
          order: 0,
          ...(resultReady ? { result: 'Agent ended.' } : {}),
        },
      ],
      endRequested: resultReady,
      createdAt: 30,
    },
    resultSubmission: {
      version: '1',
      callId: 'child-call-result-before-end',
      output: submittedOutput,
      outputHash: canonicalJsonSha256(submittedOutput),
    },
  });
}

function createResumeWire(
  checkpoint: SubAgentChildCheckpoint = createCheckpoint(),
  binding: SubAgentExecutorBinding = createBinding(),
): SubAgentExecutionRequestWire {
  return createSubAgentExecutionRequestWire(
    createExecutionRequest({
      operation: {
        type: 'resume',
        operationId: 'operation-resume-1',
        reason: 'checkpoint',
        binding,
        checkpoint,
      },
    }),
    { now: () => 1_000 },
  );
}

function replaceResumeCheckpoint(wire: SubAgentExecutionRequestWire, checkpoint: unknown): unknown {
  return {
    ...wire,
    operation: { ...wire.operation, checkpoint },
  };
}

function expectTransportReason(action: () => unknown, reason: string): void {
  expect(action).toThrowError(
    expect.objectContaining({
      name: 'SubAgentTransportError',
      code: 'SUBAGENT_TRANSPORT_ERROR',
      reason,
    }),
  );
}

describe('Subagent transport v1 envelope codec', () => {
  acceptanceIt('C7-TRANSPORT-01.l1.envelope-codec', 'transport-v1', () => {
    expect(SUBAGENT_TRANSPORT_VERSION).toBe('1');
    expect(DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);

    const envelope = createEnvelope({
      correlationId: 'request-1',
      taskId: 'task-1',
      operationId: 'operation-1',
      payload: { z: 1, a: ['\u{1f600}', true] },
    });
    const encoded = encodeSubAgentTransportFrame(envelope);

    expect(encoded).toBe(
      '{"channelId":"channel-1","correlationId":"request-1","kind":"executor.execute","messageId":"message-1","operationId":"operation-1","payload":{"a":["\u{1f600}",true],"z":1},"sequence":1,"taskId":"task-1","version":"1"}',
    );
    expect(decodeSubAgentTransportFrame(encoded)).toEqual(envelope);
    expect(decodeSubAgentTransportFrame(encodeSubAgentTransportFrameBytes(envelope))).toEqual(
      envelope,
    );
  });

  it('measures the actual UTF-8 frame at the exact configured boundary', () => {
    const empty = createEnvelope({ payload: '' });
    const exact = createEnvelope({ payload: '\u20ac' });
    const emptyBytes = textEncoder.encode(encodeSubAgentTransportFrame(empty)).byteLength;
    const exactBytes = emptyBytes + 3;
    const exactFrame = encodeSubAgentTransportFrame(exact, { maxFrameBytes: exactBytes });

    expect(textEncoder.encode(exactFrame)).toHaveLength(exactBytes);
    expect(() =>
      decodeSubAgentTransportFrame(exactFrame, { maxFrameBytes: exactBytes }),
    ).not.toThrow();
    expectTransportReason(
      () =>
        encodeSubAgentTransportFrame(createEnvelope({ payload: '\u20acx' }), {
          maxFrameBytes: exactBytes,
        }),
      'frame-too-large',
    );
    expectTransportReason(
      () => decodeSubAgentTransportFrame(`${exactFrame} `, { maxFrameBytes: exactBytes }),
      'frame-too-large',
    );
  });

  it('enforces the exact default 16 MiB frame boundary', () => {
    const emptyFrameBytes = textEncoder.encode(
      encodeSubAgentTransportFrame(createEnvelope({ payload: '' })),
    ).byteLength;
    const payloadBytes = DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES - emptyFrameBytes;
    const exact = createEnvelope({ payload: 'x'.repeat(payloadBytes) });
    const exactFrame = encodeSubAgentTransportFrame(exact);

    expect(textEncoder.encode(exactFrame)).toHaveLength(DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES);
    expectTransportReason(
      () => encodeSubAgentTransportFrame(createEnvelope({ payload: `${exact.payload}x` })),
      'frame-too-large',
    );
  });

  it('rejects extra and missing fields, wrong versions and invalid identifiers', () => {
    expectTransportReason(
      () => assertSubAgentTransportEnvelope({ ...createEnvelope(), extra: true }),
      'invalid-envelope',
    );
    const missingMessageId = { ...createEnvelope() } as Record<string, unknown>;
    delete missingMessageId.messageId;
    expectTransportReason(
      () => assertSubAgentTransportEnvelope(missingMessageId),
      'invalid-envelope',
    );
    expectTransportReason(
      () => assertSubAgentTransportEnvelope({ ...createEnvelope(), version: '2' }),
      'unsupported-version',
    );
    expectTransportReason(
      () => assertSubAgentTransportEnvelope(createEnvelope({ channelId: ' channel-1' })),
      'invalid-identifier',
    );
    expectTransportReason(
      () =>
        assertSubAgentTransportEnvelope(
          createEnvelope({ messageId: 'x'.repeat(SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES + 1) }),
        ),
      'invalid-identifier',
    );
    expect(() =>
      assertSubAgentTransportEnvelope(
        createEnvelope({ channelId: 'x'.repeat(SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES) }),
      ),
    ).not.toThrow();
  });

  it('rejects malformed UTF-8, duplicate keys and non-JCS-safe strings before dispatch', () => {
    expectTransportReason(
      () => decodeSubAgentTransportFrame(new Uint8Array([0xc3, 0x28])),
      'invalid-frame',
    );
    expectTransportReason(
      () =>
        decodeSubAgentTransportFrame(
          '{"version":"1","channelId":"channel-1","sequence":1,"messageId":"message-1","kind":"event","payload":{"a":1,"a":2}}',
        ),
      'invalid-frame',
    );
    expectTransportReason(
      () =>
        decodeSubAgentTransportFrame(
          '{"version":"1","channelId":"channel-1","sequence":1,"messageId":"message-1","kind":"event","payload":"\\ud800"}',
        ),
      'invalid-frame',
    );
  });

  it('bounds raw and in-memory frame structure before recursive validation', () => {
    const hostilePayload = `${'['.repeat(10_000)}0${']'.repeat(10_000)}`;
    const hostileFrame = `{"version":"1","channelId":"channel-1","sequence":1,"messageId":"message-1","kind":"event","payload":${hostilePayload}}`;
    expectTransportReason(
      () => decodeSubAgentTransportFrame(hostileFrame, { maxJsonDepth: 128 }),
      'invalid-frame',
    );

    const nested = createEnvelope({ payload: { nested: [true] } });
    expectTransportReason(
      () => encodeSubAgentTransportFrame(nested, { maxJsonDepth: 2 }),
      'invalid-envelope',
    );
    expectTransportReason(
      () => decodeSubAgentTransportFrame(encodeSubAgentTransportFrame(nested), { maxJsonNodes: 5 }),
      'invalid-frame',
    );
  });

  it('rejects non-positive structural frame limit configuration', () => {
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => encodeSubAgentTransportFrame(createEnvelope(), { maxJsonDepth: value })).toThrow(
        RangeError,
      );
      expect(() => decodeSubAgentTransportFrame('{}', { maxJsonNodes: value })).toThrow(RangeError);
    }
  });

  it('recursively freezes decoded envelopes before they reach dispatch code', () => {
    const decoded = decodeSubAgentTransportFrame(
      encodeSubAgentTransportFrame(
        createEnvelope({ payload: { nested: { values: [1, { stable: true }] } } }),
      ),
    ) as unknown as {
      payload: { nested: { values: Array<number | { stable: boolean }> } };
    };

    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.payload)).toBe(true);
    expect(Object.isFrozen(decoded.payload.nested)).toBe(true);
    expect(Object.isFrozen(decoded.payload.nested.values)).toBe(true);
    expect(Object.isFrozen(decoded.payload.nested.values[1])).toBe(true);
    expect(() => decoded.payload.nested.values.push(2)).toThrow(TypeError);
    expect(decoded.payload.nested.values).toHaveLength(2);
  });

  it('uses JCS for stable payload and envelope SHA-256 digests', () => {
    const left = createEnvelope({ payload: { z: -0, a: [2, 1] } });
    const right = {
      payload: { a: [2, 1], z: 0 },
      kind: 'executor.execute',
      messageId: 'message-1',
      sequence: 1,
      channelId: 'channel-1',
      version: '1',
    };

    expect(subAgentTransportPayloadSha256(left.payload)).toBe(
      canonicalJsonSha256({ a: [2, 1], z: 0 }),
    );
    expect(subAgentTransportEnvelopeSha256(left)).toBe(subAgentTransportEnvelopeSha256(right));
  });
});

describe('Subagent transport sequence tracker', () => {
  acceptanceIt('C7-TRANSPORT-02.l1.replay-sequence', 'transport-replay', () => {
    const tracker = new SubAgentTransportSequenceTracker('channel-1');
    const first = createEnvelope();

    expect(tracker.observe(first)).toMatchObject({ status: 'accepted', sequence: 1 });
    expect(tracker.observe(first)).toMatchObject({
      status: 'replay',
      sequence: 1,
      originalSequence: 1,
    });
    expect(tracker.observe(createEnvelope({ sequence: 2 }))).toMatchObject({
      status: 'replay',
      sequence: 2,
      originalSequence: 1,
    });
    expect(tracker.nextSequence).toBe(3);
  });

  it('rejects sequence gaps, unknown old sequences and same-id payload conflicts', () => {
    const gapTracker = new SubAgentTransportSequenceTracker('channel-1');
    expectTransportReason(
      () => gapTracker.observe(createEnvelope({ sequence: 2 })),
      'sequence-gap',
    );

    const replayTracker = new SubAgentTransportSequenceTracker('channel-1');
    replayTracker.observe(createEnvelope());
    expectTransportReason(
      () =>
        replayTracker.observe(createEnvelope({ sequence: 1, messageId: 'unknown-old-message' })),
      'sequence-replay-unknown',
    );
    expectTransportReason(
      () => replayTracker.observe(createEnvelope({ payload: { query: 'different' } })),
      'message-replay-conflict',
    );
    expectTransportReason(
      () => replayTracker.observe(createEnvelope({ kind: 'executor.cancel' })),
      'message-replay-conflict',
    );
    expectTransportReason(
      () => replayTracker.observe(createEnvelope({ correlationId: 'different-request' })),
      'message-replay-conflict',
    );

    const collisionTracker = new SubAgentTransportSequenceTracker('channel-1');
    collisionTracker.observe(createEnvelope());
    collisionTracker.observe(createEnvelope({ sequence: 2, messageId: 'message-2' }));
    expectTransportReason(
      () => collisionTracker.observe(createEnvelope({ sequence: 2 })),
      'message-replay-conflict',
    );
  });

  it('requires stable channel rollover when its bounded replay window is exhausted', () => {
    expect(DEFAULT_SUBAGENT_TRANSPORT_SEQUENCE_WINDOW).toBe(4_096);
    const tracker = new SubAgentTransportSequenceTracker('channel-1', {
      maxTrackedSequences: 2,
    });
    const first = createEnvelope();
    const second = createEnvelope({ sequence: 2, messageId: 'message-2' });
    const third = createEnvelope({ sequence: 3, messageId: 'message-3' });

    tracker.observe(first);
    tracker.observe(second);
    expect(tracker.observe(first)).toMatchObject({ status: 'replay', originalSequence: 1 });
    expectTransportReason(() => tracker.observe(third), 'sequence-window-exhausted');
    expectTransportReason(() => tracker.observe(third), 'sequence-window-exhausted');
    expect(tracker.nextSequence).toBe(3);

    const rolledOver = new SubAgentTransportSequenceTracker('channel-2', {
      maxTrackedSequences: 2,
    });
    expect(
      rolledOver.observe(
        createEnvelope({ channelId: 'channel-2', sequence: 1, messageId: 'rollover-1' }),
      ),
    ).toMatchObject({ status: 'accepted', sequence: 1 });
    expect(
      () =>
        new SubAgentTransportSequenceTracker('channel-1', {
          maxTrackedSequences: 0,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new SubAgentTransportSequenceTracker('channel-1', {
          maxTrackedSequences: SUBAGENT_TRANSPORT_MAX_SEQUENCE_WINDOW + 1,
        }),
    ).toThrow(RangeError);
  });
});

describe('Subagent execution request transport wire', () => {
  acceptanceIt('C7-TRANSPORT-03.l1.execution-wire', 'execution-wire', () => {
    const senderSignal = new AbortController().signal;
    const request = {
      ...createExecutionRequest({ signal: senderSignal }),
      hostClosure: () => 'must-not-cross',
    };
    const wire = createSubAgentExecutionRequestWire(request, { now: () => 1_000 });

    expect(wire.remainingMs).toBe(120_000);
    expect(wire).not.toHaveProperty('deadlineAt');
    expect(wire).not.toHaveProperty('signal');
    expect(wire).not.toHaveProperty('hostClosure');
    expect(Object.values(wire).some((value) => typeof value === 'function')).toBe(false);

    const receiverController = new AbortController();
    const timeoutController = new AbortController();
    const timeoutRequests: number[] = [];
    const reconstruction = reconstructSubAgentExecutionRequest(wire, {
      signal: receiverController.signal,
      now: () => 50_000,
      timeoutSignalFactory(remainingMs) {
        timeoutRequests.push(remainingMs);
        return timeoutController.signal;
      },
    });
    const reconstructed = reconstruction.request;
    expect(reconstructed.deadlineAt).toBe(170_000);
    expect(timeoutRequests).toEqual([120_000]);
    expect(reconstructed.signal).not.toBe(receiverController.signal);
    expect(reconstructed.signal).not.toBe(senderSignal);
    expect(reconstructed.signal.aborted).toBe(false);

    receiverController.abort('receiver-cancelled');
    expect(reconstructed.signal.aborted).toBe(true);
    expect(reconstructed.signal.reason).toBe('receiver-cancelled');
    reconstruction.dispose();
    reconstruction.dispose();
  });

  it('round-trips and freezes a resumable rich pending child batch exactly', () => {
    const checkpoint = createRestorablePendingCheckpoint();
    const wire = createSubAgentExecutionRequestWire(
      createExecutionRequest({
        operation: {
          type: 'resume',
          operationId: 'rich-resume-operation',
          reason: 'checkpoint',
          binding: createBinding(),
          checkpoint,
        },
      }),
      { now: () => 1_000 },
    );
    if (wire.operation.type !== 'resume') throw new Error('expected resume wire');
    expect(wire.operation.checkpoint).toEqual(checkpoint);
    expect(wire.operation.checkpoint).not.toBe(checkpoint);
    expect(wire.operation.checkpoint.pendingBatch?.calls).toEqual(checkpoint.pendingBatch?.calls);
    expect(Object.isFrozen(wire)).toBe(true);
    expect(Object.isFrozen(wire.operation)).toBe(true);
    expect(Object.isFrozen(wire.operation.checkpoint)).toBe(true);
    expect(Object.isFrozen(wire.operation.checkpoint.pendingBatch)).toBe(true);
    expect(Object.isFrozen(wire.operation.checkpoint.pendingBatch?.calls)).toBe(true);
    expect(Object.isFrozen(wire.operation.checkpoint.pendingBatch?.calls[0]?.result)).toBe(true);

    const decoded = decodeSubAgentExecutionRequestWire(wire);
    if (decoded.operation.type !== 'resume') throw new Error('expected decoded resume wire');
    expect(decoded.operation.checkpoint).toEqual(checkpoint);
    expect(decoded.operation.checkpoint).not.toBe(wire.operation.checkpoint);

    const reconstruction = reconstructSubAgentExecutionRequest(decoded, {
      signal: new AbortController().signal,
      now: () => 5_000,
      timeoutSignalFactory: () => new AbortController().signal,
    });
    const reconstructed = reconstruction.request;
    if (reconstructed.operation.type !== 'resume') {
      throw new Error('expected reconstructed resume operation');
    }
    expect(reconstructed.operation.checkpoint).toEqual(checkpoint);
    expect(reconstructed.operation.checkpoint.pendingBatch?.calls).toEqual(
      checkpoint.pendingBatch?.calls,
    );
    reconstruction.dispose();
  });

  it('aborts reconstructed execution when its receiver-local timeout wins', () => {
    const wire = createSubAgentExecutionRequestWire(createExecutionRequest(), { now: () => 1_000 });
    const receiverController = new AbortController();
    const timeoutController = new AbortController();
    const reconstruction = reconstructSubAgentExecutionRequest(wire, {
      signal: receiverController.signal,
      now: () => 10_000,
      timeoutSignalFactory: () => timeoutController.signal,
    });
    const reconstructed = reconstruction.request;

    timeoutController.abort(new DOMException('Timed out', 'TimeoutError'));
    expect(reconstructed.signal.aborted).toBe(true);
    expect(reconstructed.signal.reason).toEqual(expect.objectContaining({ name: 'TimeoutError' }));
    expect(receiverController.signal.aborted).toBe(false);

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort('cancelled-before-reconstruction');
    const cancelled = reconstructSubAgentExecutionRequest(wire, {
      signal: alreadyCancelled.signal,
      timeoutSignalFactory: () => new AbortController().signal,
    }).request;
    expect(cancelled.signal.aborted).toBe(true);
    expect(cancelled.signal.reason).toBe('cancelled-before-reconstruction');
    expectTransportReason(
      () =>
        reconstructSubAgentExecutionRequest(wire, {
          signal: receiverController.signal,
          timeoutSignalFactory: () => ({}) as AbortSignal,
        }),
      'invalid-execution-request',
    );
  });

  it('disposes receiver-local timeout resources idempotently after execution settles', () => {
    vi.useFakeTimers();
    try {
      const wire = createSubAgentExecutionRequestWire(createExecutionRequest(), {
        now: () => 1_000,
      });
      const reconstruction = reconstructSubAgentExecutionRequest(wire, {
        signal: new AbortController().signal,
        now: () => 10_000,
      });

      expect(vi.getTimerCount()).toBe(1);
      reconstruction.dispose();
      reconstruction.dispose();
      expect(vi.getTimerCount()).toBe(0);
      expect(reconstruction.request.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches both receiver and timeout cancellation listeners on disposal', () => {
    const wire = createSubAgentExecutionRequestWire(createExecutionRequest(), {
      now: () => 1_000,
    });
    const receiver = new AbortController();
    const timeout = new AbortController();
    const receiverRemoval = vi.spyOn(receiver.signal, 'removeEventListener');
    const timeoutRemoval = vi.spyOn(timeout.signal, 'removeEventListener');
    const reconstruction = reconstructSubAgentExecutionRequest(wire, {
      signal: receiver.signal,
      now: () => 10_000,
      timeoutSignalFactory: () => timeout.signal,
    });

    reconstruction.dispose();
    expect(receiverRemoval).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(timeoutRemoval).toHaveBeenCalledWith('abort', expect.any(Function));
    receiver.abort('late-receiver-abort');
    timeout.abort('late-timeout-abort');
    expect(reconstruction.request.signal.aborted).toBe(false);
  });

  it('accepts remainingMs at 1 and the resolved timeout, rejecting expired and over-limit values', () => {
    const oneMillisecond = createSubAgentExecutionRequestWire(
      createExecutionRequest({ deadlineAt: 1_001 }),
      { now: () => 1_000 },
    );
    const fullLimit = createSubAgentExecutionRequestWire(createExecutionRequest(), {
      now: () => 1_000,
    });
    const extendedLimit = createSubAgentExecutionRequestWire(
      createExecutionRequest({
        limits: { ...DEFAULT_SUBAGENT_LIMITS, timeoutMs: 240_000 },
        deadlineAt: 241_000,
      }),
      { now: () => 1_000 },
    );

    expect(oneMillisecond.remainingMs).toBe(1);
    expect(fullLimit.remainingMs).toBe(DEFAULT_SUBAGENT_LIMITS.timeoutMs);
    expect(extendedLimit.remainingMs).toBe(240_000);
    expectTransportReason(
      () =>
        createSubAgentExecutionRequestWire(createExecutionRequest({ deadlineAt: 1_000 }), {
          now: () => 1_000,
        }),
      'deadline-expired',
    );
    expectTransportReason(
      () =>
        assertSubAgentExecutionRequestWire({
          ...fullLimit,
          remainingMs: DEFAULT_SUBAGENT_LIMITS.timeoutMs + 1,
        }),
      'invalid-execution-request',
    );
  });

  it('preserves 2^31 and 2^32 millisecond deadlines without timer overflow or shortening', () => {
    vi.useFakeTimers();
    try {
      const maxTimerDelay = 2_147_483_647;
      for (const remainingMs of [2 ** 31, 2 ** 32]) {
        const wire = createSubAgentExecutionRequestWire(
          createExecutionRequest({
            limits: { ...DEFAULT_SUBAGENT_LIMITS, timeoutMs: remainingMs },
            deadlineAt: remainingMs + 1_000,
          }),
          { now: () => 1_000 },
        );
        const reconstruction = reconstructSubAgentExecutionRequest(wire, {
          signal: new AbortController().signal,
          now: () => 10_000,
        });
        const reconstructed = reconstruction.request;

        let pendingMs = remainingMs;
        while (pendingMs > maxTimerDelay) {
          vi.advanceTimersByTime(maxTimerDelay);
          pendingMs -= maxTimerDelay;
          expect(reconstructed.signal.aborted).toBe(false);
        }
        if (pendingMs > 1) {
          vi.advanceTimersByTime(pendingMs - 1);
          expect(reconstructed.signal.aborted).toBe(false);
        }
        vi.advanceTimersByTime(1);
        expect(reconstructed.signal.aborted).toBe(true);
        expect(reconstructed.signal.reason).toEqual(
          expect.objectContaining({ name: 'TimeoutError' }),
        );
        reconstruction.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('canonical-clones valid requests and rejects top-level or operation extensions', () => {
    const wire = createSubAgentExecutionRequestWire(createExecutionRequest(), { now: () => 1_000 });
    const decoded = decodeSubAgentExecutionRequestWire(wire);

    expect(decoded).toEqual(wire);
    expect(decoded).not.toBe(wire);
    expectTransportReason(
      () => assertSubAgentExecutionRequestWire({ ...wire, signal: {} }),
      'invalid-execution-request',
    );
    expectTransportReason(
      () =>
        assertSubAgentExecutionRequestWire({
          ...wire,
          operation: { ...wire.operation, executorFallback: 'local' },
        }),
      'invalid-execution-request',
    );
  });

  it('recursively freezes decoded execution wires and rejects direct decode resource bombs', () => {
    const wire = createSubAgentExecutionRequestWire(createExecutionRequest(), { now: () => 1_000 });
    const decoded = decodeSubAgentExecutionRequestWire(wire) as unknown as {
      input: { query: string };
      projectedContext: Array<{ value?: { citations: boolean } }>;
    };

    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.input)).toBe(true);
    expect(Object.isFrozen(decoded.projectedContext)).toBe(true);
    expect(Object.isFrozen(decoded.projectedContext[1]?.value)).toBe(true);
    expect(() => {
      decoded.input.query = 'mutated';
    }).toThrow(TypeError);
    expect(decoded.input.query).toBe('hello');

    expectTransportReason(
      () =>
        decodeSubAgentExecutionRequestWire(wire, {
          maxCanonicalBytes: measureCanonicalJsonBytes(wire as unknown as JsonValue) - 1,
        }),
      'invalid-execution-request',
    );
    expectTransportReason(
      () => decodeSubAgentExecutionRequestWire(wire, { maxJsonDepth: 2 }),
      'invalid-execution-request',
    );
    expectTransportReason(
      () => decodeSubAgentExecutionRequestWire(wire, { maxJsonNodes: 10 }),
      'invalid-execution-request',
    );

    let deepInput: unknown = 'leaf';
    for (let depth = 0; depth < 200; depth += 1) {
      deepInput = { child: deepInput };
    }
    expectTransportReason(
      () => decodeSubAgentExecutionRequestWire({ ...wire, input: deepInput }),
      'invalid-execution-request',
    );
    expect(() => decodeSubAgentExecutionRequestWire(wire, { maxJsonDepth: 0 })).toThrow(RangeError);
    expect(() => decodeSubAgentExecutionRequestWire(wire, { maxJsonNodes: 0 })).toThrow(RangeError);
  });

  it('accepts strict checkpoint resume and rejects forbidden approval or binding identity drift', () => {
    const binding = createBinding();
    const checkpoint = createCheckpoint();
    const wire = createResumeWire(checkpoint, binding);

    expect(wire.operation.type).toBe('resume');
    expectTransportReason(
      () =>
        assertSubAgentExecutionRequestWire({
          ...wire,
          operation: { ...wire.operation, approvals: [] },
        }),
      'invalid-execution-request',
    );
    expectTransportReason(
      () =>
        assertSubAgentExecutionRequestWire({
          ...wire,
          operation: {
            ...wire.operation,
            binding: { ...binding, definitionVersion: 'other-version' },
          },
        }),
      'invalid-execution-request',
    );
    expectTransportReason(
      () =>
        assertSubAgentExecutionRequestWire({
          ...wire,
          operation: {
            ...wire.operation,
            binding: { ...binding, taskId: 'other-task' },
          },
        }),
      'invalid-execution-request',
    );
  });

  it('validates checkpoint protocol, Model iteration, phase, result and time semantics', () => {
    const baseWire = createResumeWire();
    const baseCheckpoint = createCheckpoint();
    const modelResult = {
      protocol: 'openai-chat',
      codecVersion: '1',
      value: [{ role: 'assistant', content: 'ready' }],
    } as const;
    const modelCheckpoint = createCheckpoint({
      modelIteration: 1,
      modelOperation: {
        version: '1',
        operationId: 'model-operation-1',
        iteration: 1,
        purpose: 'agent',
        requestHash: canonicalJsonSha256({ request: 'child-model' }),
        phase: 'result_ready',
        result: modelResult,
        preparedAt: 10,
        updatedAt: 20,
      },
    });

    expect(() => createResumeWire(modelCheckpoint)).not.toThrow();
    const invalidCheckpoints: readonly unknown[] = [
      {
        ...baseCheckpoint,
        contextStore: { ...baseCheckpoint.contextStore, protocol: 'openai-responses' },
      },
      { ...baseCheckpoint, modelIteration: 7 },
      {
        ...modelCheckpoint,
        modelOperation: { ...modelCheckpoint.modelOperation, iteration: 0 },
      },
      {
        ...modelCheckpoint,
        modelOperation: { ...modelCheckpoint.modelOperation, updatedAt: 9 },
      },
      {
        ...modelCheckpoint,
        modelOperation: {
          ...modelCheckpoint.modelOperation,
          result: { ...modelResult, protocol: 'openai-responses' },
        },
      },
      {
        ...modelCheckpoint,
        modelOperation: { ...modelCheckpoint.modelOperation, phase: 'prepared' },
      },
      {
        ...modelCheckpoint,
        modelOperation: { ...modelCheckpoint.modelOperation, result: undefined },
      },
    ];

    for (const checkpoint of invalidCheckpoints) {
      expectTransportReason(
        () => assertSubAgentExecutionRequestWire(replaceResumeCheckpoint(baseWire, checkpoint)),
        'invalid-execution-request',
      );
    }
  });

  it('validates durable compact transactions and ContextStore provenance counters', () => {
    const baseWire = createResumeWire();
    const baseCheckpoint = createCheckpoint();
    const compactCheckpoint = createCheckpoint({
      compactTransaction: {
        schemaVersion: '1',
        transactionId: 'compact-1',
        kind: 'summary',
        contextRevision: 0,
        phase: 'result_ready',
        preparedAt: 10,
        updatedAt: 20,
        result: { summary: 'stable' },
      },
    });
    const compact = compactCheckpoint.compactTransaction!;
    const invalidCheckpoints: readonly unknown[] = [
      {
        ...compactCheckpoint,
        compactTransaction: { ...compact, updatedAt: 9 },
      },
      {
        ...compactCheckpoint,
        compactTransaction: { ...compact, phase: 'prepared' },
      },
      {
        ...compactCheckpoint,
        compactTransaction: { ...compact, outcomeUnknown: true },
      },
      {
        ...baseCheckpoint,
        contextStore: { ...baseCheckpoint.contextStore, activeSpans: [] },
      },
      {
        ...baseCheckpoint,
        contextStore: { ...baseCheckpoint.contextStore, nextSpanId: 1 },
      },
      {
        ...baseCheckpoint,
        contextStore: {
          ...baseCheckpoint.contextStore,
          activeSpans: [
            {
              ...baseCheckpoint.contextStore.activeSpans[0],
              spanId: 'external-span-1',
            },
          ],
        },
      },
    ];

    expect(() => createResumeWire(compactCheckpoint)).not.toThrow();
    for (const candidate of invalidCheckpoints) {
      expectTransportReason(
        () => assertSubAgentExecutionRequestWire(replaceResumeCheckpoint(baseWire, candidate)),
        'invalid-execution-request',
      );
    }
  });

  it('validates every pending child call identity, order, approval, result and end state', () => {
    const baseWire = createResumeWire();
    const checkpoint = createPendingCheckpoint();
    const batch = checkpoint.pendingBatch!;
    const call = batch.calls[0]!;
    expect(() =>
      createResumeWire({ ...checkpoint, pendingBatch: { ...batch, calls: [] } }),
    ).not.toThrow();
    const invalidCheckpoints: readonly unknown[] = [
      {
        ...checkpoint,
        pendingBatch: {
          ...batch,
          calls: [{ ...call, inputHash: '0'.repeat(64) }],
        },
      },
      {
        ...checkpoint,
        pendingBatch: { ...batch, calls: [{ ...call, order: 1 }] },
      },
      {
        ...checkpoint,
        pendingBatch: {
          ...batch,
          calls: [call, { ...call, operationId: 'child-operation-2', order: 1 }],
        },
      },
      {
        ...checkpoint,
        pendingBatch: { ...batch, calls: [{ ...call, status: 'unknown' }] },
      },
      {
        ...checkpoint,
        pendingBatch: { ...batch, calls: [{ ...call, status: 'waiting_approval' }] },
      },
      {
        ...checkpoint,
        pendingBatch: { ...batch, calls: [{ ...call, approvals: ['approval-1'] }] },
      },
      {
        ...checkpoint,
        pendingBatch: { ...batch, calls: [{ ...call, result: 'too-early' }] },
      },
      {
        ...checkpoint,
        pendingBatch: {
          ...batch,
          calls: [{ ...call, status: 'result_submitted', result: 'impossible-tool-phase' }],
        },
      },
      {
        ...checkpoint,
        pendingBatch: {
          ...batch,
          calls: [
            {
              ...call,
              name: 'agent-result',
              status: 'result_ready',
              result: 'impossible-agent-result-phase',
            },
          ],
        },
      },
      {
        ...checkpoint,
        pendingBatch: { ...batch, calls: [{ ...call, taskId: 'foreign-task' }] },
      },
      {
        ...checkpoint,
        pendingBatch: { ...batch, calls: [{ ...call, name: 'agent' }] },
      },
      {
        ...checkpoint,
        pendingBatch: { ...batch, calls: [{ ...call, name: 'end-agent' }] },
      },
      {
        ...checkpoint,
        pendingBatch: {
          ...batch,
          calls: [{ ...call, kind: 'agent', name: 'agent', status: 'in_flight' }],
        },
      },
      {
        ...checkpoint,
        pendingBatch: {
          ...batch,
          calls: [
            {
              ...call,
              kind: 'agent',
              name: 'agent',
              taskId: 'premature-task',
            },
          ],
        },
      },
      {
        ...checkpoint,
        pendingBatch: {
          ...batch,
          calls: [
            {
              ...call,
              status: 'waiting_approval',
              approvals: ['approval-1', 'approval-2'],
            },
          ],
        },
      },
      {
        ...checkpoint,
        pendingBatch: {
          ...batch,
          calls: [
            {
              ...call,
              kind: 'agent',
              name: 'agent',
              status: 'waiting_approval',
              approvals: ['approval-1'],
            },
          ],
        },
      },
      {
        ...checkpoint,
        pendingBatch: {
          ...batch,
          endRequested: false,
          calls: [
            {
              ...call,
              kind: 'end-agent',
              name: 'end-agent',
              status: 'result_ready',
              result: 'done',
            },
          ],
        },
      },
    ];

    expect(() => createResumeWire(checkpoint)).not.toThrow();
    expect(() =>
      createResumeWire(
        createCheckpoint({
          pendingBatch: {
            ...batch,
            calls: [
              {
                ...call,
                kind: 'agent',
                name: 'agent',
                status: 'in_flight',
                taskId: 'child-task-1',
              },
            ],
          },
        }),
      ),
    ).not.toThrow();
    for (const status of ['prepared', 'in_flight', 'result_ready', 'applied'] as const) {
      expect(() => createResumeWire(createEndAgentCheckpoint(status))).not.toThrow();
    }
    for (const candidate of invalidCheckpoints) {
      expectTransportReason(
        () => assertSubAgentExecutionRequestWire(replaceResumeCheckpoint(baseWire, candidate)),
        'invalid-execution-request',
      );
    }
  });

  it('enforces serial Tool, delayed agent-sub-batch and provider-order apply invariants', () => {
    const checkpoint = createPendingCheckpoint();
    const batch = checkpoint.pendingBatch!;
    const first = batch.calls[0]!;
    const secondInput = { query: 'second' } as const;
    const second = {
      ...first,
      operationId: 'child-operation-2',
      callId: 'child-call-2',
      name: 'second-tool',
      input: secondInput,
      inputHash: canonicalJsonSha256(secondInput),
      order: 1,
    } as const;

    const legalMixedEnd = createCheckpoint({
      pendingBatch: {
        ...batch,
        calls: [
          first,
          {
            ...second,
            kind: 'end-agent',
            name: 'end-agent',
            status: 'result_ready',
            result: {
              ok: false,
              error: {
                code: 'END_AGENT_MUST_BE_STANDALONE',
                message: 'end-agent must be the only Tool call in its provider batch.',
                retryable: false,
              },
            },
          },
        ],
      },
    });
    expect(() => createResumeWire(legalMixedEnd)).not.toThrow();

    const invalidCheckpoints: readonly SubAgentChildCheckpoint[] = [
      createCheckpoint({
        pendingBatch: {
          ...batch,
          calls: [
            first,
            {
              ...second,
              kind: 'end-agent',
              name: 'end-agent',
              status: 'result_ready',
              result: 'tampered-mixed-end-result',
            },
          ],
        },
      }),
      createCheckpoint({
        pendingBatch: {
          ...batch,
          calls: [first, { ...second, status: 'result_ready', result: 'skipped' }],
        },
      }),
      createCheckpoint({
        pendingBatch: {
          ...batch,
          calls: [
            first,
            {
              ...second,
              kind: 'agent',
              name: 'agent',
              status: 'in_flight',
              taskId: 'child-task-2',
            },
          ],
        },
      }),
      createCheckpoint({
        pendingBatch: {
          ...batch,
          calls: [
            { ...first, status: 'result_ready', result: 'ready' },
            {
              ...second,
              kind: 'agent',
              name: 'agent',
              status: 'applied',
              result: 'applied-out-of-order',
            },
          ],
        },
      }),
      createCheckpoint({
        pendingBatch: {
          ...batch,
          calls: [
            {
              ...first,
              kind: 'agent',
              name: 'agent',
              status: 'in_flight',
              taskId: 'shared-task',
            },
            {
              ...second,
              kind: 'agent',
              name: 'agent',
              status: 'in_flight',
              taskId: 'shared-task',
            },
          ],
        },
      }),
      createCheckpoint({
        pendingBatch: {
          ...batch,
          calls: [
            {
              ...first,
              kind: 'agent',
              name: 'agent',
              status: 'waiting_approval',
              taskId: 'child-task-1',
              approvals: ['shared-approval'],
            },
            {
              ...second,
              kind: 'agent',
              name: 'agent',
              status: 'waiting_approval',
              taskId: 'child-task-2',
              approvals: ['shared-approval'],
            },
          ],
        },
      }),
    ];

    for (const candidate of invalidCheckpoints) {
      expectTransportReason(() => createResumeWire(candidate), 'invalid-execution-request');
    }
  });

  it('requires typed result projections for completed child result/end phases', () => {
    const submitted = createResultSubmissionCheckpoint();
    const completedResultWithoutProjection = { ...submitted };
    delete completedResultWithoutProjection.resultSubmission;
    expectTransportReason(
      () => createResumeWire(completedResultWithoutProjection),
      'invalid-execution-request',
    );

    const completedEnd = createEndAgentCheckpoint('result_ready');
    const completedEndWithoutProjection = { ...completedEnd };
    delete completedEndWithoutProjection.resultSubmission;
    expectTransportReason(
      () => createResumeWire(completedEndWithoutProjection),
      'invalid-execution-request',
    );

    const resultBatch = submitted.pendingBatch!;
    const resultCall = resultBatch.calls[0]!;
    const callBeforeReceipt = { ...resultCall };
    delete callBeforeReceipt.result;
    const casCommittedBeforeHandlerReturn = createCheckpoint({
      ...submitted,
      pendingBatch: {
        ...resultBatch,
        calls: [{ ...callBeforeReceipt, status: 'in_flight' }],
      },
    });
    expect(() => createResumeWire(casCommittedBeforeHandlerReturn)).not.toThrow();
  });

  it('accepts partial approval decisions only for IDs paused in the child checkpoint', () => {
    const input = { subAgent: 'researcher', executor: 'process', input: 'proof' } as const;
    const pausedCheckpoint = createCheckpoint({
      pendingBatch: {
        version: '1',
        batchId: 'batch-paused-agents',
        assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
        calls: [
          {
            version: '1',
            operationId: 'child-operation-agent-1',
            kind: 'agent',
            callId: 'child-call-agent-1',
            name: 'agent',
            input,
            inputHash: canonicalJsonSha256(input),
            status: 'waiting_approval',
            order: 0,
            taskId: 'nested-task-1',
            approvals: ['approval-1', 'approval-2'],
          },
          {
            version: '1',
            operationId: 'child-operation-agent-2',
            kind: 'agent',
            callId: 'child-call-agent-2',
            name: 'agent',
            input,
            inputHash: canonicalJsonSha256(input),
            status: 'waiting_approval',
            order: 1,
            taskId: 'nested-task-2',
            approvals: ['approval-3'],
          },
        ],
        endRequested: false,
        createdAt: 40,
      },
    });
    const approvalWire = createSubAgentExecutionRequestWire(
      createExecutionRequest({
        operation: {
          type: 'resume',
          operationId: 'operation-approval-1',
          reason: 'approval',
          binding: createBinding(),
          checkpoint: pausedCheckpoint,
          approvals: [{ approvalId: 'approval-2', decision: 'approved', expectedRevision: 3 }],
        },
      }),
      { now: () => 1_000 },
    );
    expect(() => assertSubAgentExecutionRequestWire(approvalWire)).not.toThrow();
    expectTransportReason(
      () =>
        assertSubAgentExecutionRequestWire({
          ...approvalWire,
          operation: { ...approvalWire.operation, approvals: [] },
        }),
      'invalid-execution-request',
    );
    expectTransportReason(
      () =>
        assertSubAgentExecutionRequestWire({
          ...approvalWire,
          operation: {
            ...approvalWire.operation,
            approvals: [
              { approvalId: 'foreign-approval', decision: 'approved', expectedRevision: 3 },
            ],
          },
        }),
      'invalid-execution-request',
    );
  });

  it('validates child result submission size, hash and authoritative pending-call link', () => {
    const baseWire = createResumeWire();
    const checkpoint = createResultSubmissionCheckpoint();
    const batch = checkpoint.pendingBatch!;
    const call = batch.calls[0]!;
    const submission = checkpoint.resultSubmission!;
    const oversizedOutput = 'x'.repeat(256 * 1024);
    const invalidCheckpoints: readonly unknown[] = [
      {
        ...checkpoint,
        resultSubmission: { ...submission, outputHash: '0'.repeat(64) },
      },
      {
        ...checkpoint,
        resultSubmission: {
          ...submission,
          output: oversizedOutput,
          outputHash: canonicalJsonSha256(oversizedOutput),
        },
      },
      {
        ...checkpoint,
        resultSubmission: { ...submission, callId: 'other-call' },
      },
      {
        ...checkpoint,
        pendingBatch: {
          ...batch,
          calls: [
            {
              ...call,
              result: JSON.stringify({
                ok: true,
                status: 'accepted',
                outputHash: '0'.repeat(64),
              }),
            },
          ],
        },
      },
      {
        ...checkpoint,
        pendingBatch: {
          ...batch,
          calls: [
            {
              ...call,
              result: {
                ok: true,
                status: 'accepted',
                outputHash: submission.outputHash,
              },
            },
          ],
        },
      },
    ];

    expect(() => createResumeWire(checkpoint)).not.toThrow();
    for (const candidate of invalidCheckpoints) {
      expectTransportReason(
        () => assertSubAgentExecutionRequestWire(replaceResumeCheckpoint(baseWire, candidate)),
        'invalid-execution-request',
      );
    }
  });

  it('cross-checks parent paths and closed bounded Executor bindings against receiver identity', () => {
    const nestedRequest = createExecutionRequest({
      parentTaskId: 'parent-task-1',
      path: ['parent-task-1', 'task-1'],
      delegation: {
        ...createExecutionRequest().delegation,
        path: ['parent-task-1', 'task-1'],
        depth: 2,
      },
    });
    expect(() =>
      createSubAgentExecutionRequestWire(nestedRequest, { now: () => 1_000 }),
    ).not.toThrow();

    const rootWire = createSubAgentExecutionRequestWire(createExecutionRequest(), {
      now: () => 1_000,
    });
    expectTransportReason(
      () =>
        assertSubAgentExecutionRequestWire({
          ...rootWire,
          path: ['unexpected-parent', 'task-1'],
          delegation: {
            ...rootWire.delegation,
            path: ['unexpected-parent', 'task-1'],
            depth: 2,
          },
        }),
      'invalid-execution-request',
    );
    const nestedWire = createSubAgentExecutionRequestWire(nestedRequest, { now: () => 1_000 });
    expectTransportReason(
      () => assertSubAgentExecutionRequestWire({ ...nestedWire, parentTaskId: 'wrong-parent' }),
      'invalid-execution-request',
    );

    const binding = createBinding();
    const resumeWire = createResumeWire(createCheckpoint(), binding);
    expect(() =>
      assertSubAgentExecutionRequestWire(resumeWire, { expectedExecutorName: 'process' }),
    ).not.toThrow();
    expectTransportReason(
      () => assertSubAgentExecutionRequestWire(resumeWire, { expectedExecutorName: 'worker' }),
      'invalid-execution-request',
    );
    expectTransportReason(
      () =>
        assertSubAgentExecutionRequestWire({
          ...resumeWire,
          operation: {
            ...resumeWire.operation,
            binding: { ...binding, leakedField: 'must-be-rejected' },
          },
        }),
      'invalid-execution-request',
    );
    expectTransportReason(
      () =>
        assertSubAgentExecutionRequestWire(resumeWire, {
          maxBindingBytes: measureCanonicalJsonBytes(binding as unknown as JsonValue) - 1,
        }),
      'invalid-execution-request',
    );
    const oversizedBinding = createBinding({ recoveryData: 'x'.repeat(64 * 1024) });
    const wireWithOversizedBinding = {
      ...resumeWire,
      operation: { ...resumeWire.operation, binding: oversizedBinding },
    };
    expectTransportReason(
      () => assertSubAgentExecutionRequestWire(wireWithOversizedBinding),
      'invalid-execution-request',
    );
  });

  it('keeps the JsonValue generic while rejecting non-JSON-safe runtime payloads', () => {
    const typed: SubAgentExecutionRequestWire<{ readonly query: string }> =
      createSubAgentExecutionRequestWire(createExecutionRequest(), { now: () => 1_000 });
    expect(typed.input.query).toBe('hello');
    expectTransportReason(
      () =>
        assertSubAgentExecutionRequestWire({
          ...typed,
          input: { query: 'hello', callback: () => undefined },
        }),
      'invalid-execution-request',
    );
    expect(SubAgentTransportError).toBeTypeOf('function');
  });
});
