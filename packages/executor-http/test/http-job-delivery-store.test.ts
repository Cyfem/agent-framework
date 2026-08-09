import { describe, expect } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import {
  DEFAULT_SUBAGENT_LIMITS,
  canonicalizeJson,
  createSubAgentExecutionRequestWire,
  createSubAgentTransportRpcEnvelope,
  encodeSubAgentTransportRpcFrame,
  type JsonValue,
  type SubAgentExecutionRequest,
  type SubAgentTransportArtifactSidecar,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

import {
  HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
  MemoryHttpSubAgentJobStore,
  normalizeHttpSubAgentJobDeliveryState,
  parseHttpSubAgentRoute,
  type HttpSubAgentJobCreateInput,
  type HttpSubAgentJobScope,
  type HttpSubAgentJobStoreErrorCategory,
} from '../src/index';
import { bytes, createSidecar } from './http-security-fixture';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const PRINCIPAL_ID = 'http-delivery-principal-1';
const OWNER_SESSION_ID = 'http-delivery-owner-1';
const RUN_ID = 'http-delivery-run-1';
const TASK_ID = 'http-delivery-task-1';
const PARENT_TASK_ID = 'http-delivery-parent-task-1';
const OPERATION_ID = 'http-delivery-operation-1';
const IDEMPOTENCY_KEY = 'http-delivery-idempotency-1';
const JOB_ID = 'http-delivery-job-1';
const CHANNEL_ID = 'http-delivery-channel-1';
const NOW = 1_800_000_000_000;
const CREATE_ROUTE = parseHttpSubAgentRoute('POST', '/v1/jobs/create');
const TEXT_ENCODER = new TextEncoder();
const FIXTURE_LIMITS = Object.freeze({
  ...DEFAULT_SUBAGENT_LIMITS,
  timeoutMs: 180_000,
});

interface CreateFixtureOptions {
  readonly principalId?: string;
  readonly ownerSessionId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly operationId?: string;
  readonly idempotencyKey?: string;
  readonly jobId?: string;
  readonly channelId?: string;
}

interface OutboundFixtureOptions {
  readonly messageId: string;
  readonly sequence: number;
  readonly channelId?: string;
  readonly correlationId?: string;
  readonly sidecarId?: string;
  readonly sidecarText?: string;
  readonly frameAsBytes?: boolean;
}

function createJobInput(options: CreateFixtureOptions = {}): HttpSubAgentJobCreateInput {
  const ownerSessionId = options.ownerSessionId ?? OWNER_SESSION_ID;
  const runId = options.runId ?? RUN_ID;
  const taskId = options.taskId ?? TASK_ID;
  const operationId = options.operationId ?? OPERATION_ID;
  const idempotencyKey = options.idempotencyKey ?? IDEMPOTENCY_KEY;
  const request = Object.freeze({
    operation: Object.freeze({ type: 'create' as const, operationId, idempotencyKey }),
    ownerSessionId,
    runId,
    taskId,
    parentTaskId: PARENT_TASK_ID,
    subagentSessionId: `http-delivery-session:${taskId}`,
    path: Object.freeze([PARENT_TASK_ID, taskId]),
    attempt: 1,
    executionEpoch: 'http-delivery-execution-epoch-1',
    executionFencingToken: '1',
    definition: Object.freeze({ name: 'researcher', version: '2' }),
    input: Object.freeze({ query: 'verify durable HTTP outbound delivery' }),
    projectedContext: Object.freeze([
      Object.freeze({ kind: 'text' as const, name: 'brief', text: 'Use verified evidence.' }),
    ]),
    delegation: Object.freeze({
      version: '1' as const,
      ownerSessionId,
      runId,
      parentTaskId: taskId,
      path: Object.freeze([PARENT_TASK_ID, taskId]),
      depth: 2,
      catalogRevision: 1,
      definitions: Object.freeze([
        Object.freeze({ name: 'researcher', version: '2', executors: Object.freeze(['http']) }),
      ]),
    }),
    limits: FIXTURE_LIMITS,
    signal: new AbortController().signal,
    deadlineAt: NOW + 120_000,
  }) satisfies SubAgentExecutionRequest;
  const wire = createSubAgentExecutionRequestWire(request, { now: () => NOW });
  const packet = Object.freeze({
    frame: encodeSubAgentTransportRpcFrame(
      createSubAgentTransportRpcEnvelope({
        channelId: options.channelId ?? CHANNEL_ID,
        sequence: 1,
        messageId: 'http-delivery-create-message-1',
        taskId,
        operationId,
        kind: 'executor.request',
        payload: Object.freeze({ mode: 'execute' as const, request: wire }),
      }),
    ),
    sidecars: Object.freeze([]),
  }) satisfies SubAgentTransportPeerPacket;

  return Object.freeze({
    principalId: options.principalId ?? PRINCIPAL_ID,
    ownerSessionId,
    idempotencyKey,
    jobId: options.jobId ?? JOB_ID,
    route: CREATE_ROUTE,
    packet,
  });
}

function scopeFor(input: HttpSubAgentJobCreateInput): HttpSubAgentJobScope {
  return Object.freeze({
    principalId: input.principalId,
    ownerSessionId: input.ownerSessionId,
    jobId: input.jobId,
  });
}

function createOutboundPacket(options: OutboundFixtureOptions): SubAgentTransportPeerPacket {
  const frame = encodeSubAgentTransportRpcFrame(
    createSubAgentTransportRpcEnvelope({
      channelId: options.channelId ?? CHANNEL_ID,
      sequence: options.sequence,
      messageId: options.messageId,
      correlationId: options.correlationId ?? `http-correlation:${options.messageId}`,
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      kind: 'cancel.ack',
      payload: Object.freeze({ cancelled: true as const }),
    }),
  );
  const sidecars: readonly SubAgentTransportArtifactSidecar[] =
    options.sidecarText === undefined
      ? Object.freeze([])
      : Object.freeze([
          createSidecar(
            options.sidecarId ?? `http-delivery-sidecar:${options.messageId}`,
            bytes(options.sidecarText),
          ),
        ]);
  return Object.freeze({
    frame: options.frameAsBytes === true ? TEXT_ENCODER.encode(frame) : frame,
    sidecars,
  });
}

function createDirectionDeniedPackets(
  create: HttpSubAgentJobCreateInput,
): readonly SubAgentTransportPeerPacket[] {
  const packet = (
    input: Parameters<typeof createSubAgentTransportRpcEnvelope>[0],
  ): SubAgentTransportPeerPacket =>
    Object.freeze({
      frame: encodeSubAgentTransportRpcFrame(createSubAgentTransportRpcEnvelope(input)),
      sidecars: Object.freeze([]),
    });
  const replyRoute = Object.freeze({
    correlationId: 'direction-correlation-1',
    taskId: TASK_ID,
    operationId: OPERATION_ID,
  });
  return Object.freeze([
    create.packet,
    packet({
      channelId: CHANNEL_ID,
      sequence: 1,
      messageId: 'direction-control-reply',
      ...replyRoute,
      kind: 'control.reply',
      payload: Object.freeze({
        method: 'execution.reportProgress' as const,
        ok: true as const,
        result: null,
      }),
    }),
    packet({
      channelId: CHANNEL_ID,
      sequence: 1,
      messageId: 'direction-cancel-request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      kind: 'cancel.request',
      payload: Object.freeze({
        binding: Object.freeze({
          version: '1' as const,
          executorName: 'http',
          ownerSessionId: OWNER_SESSION_ID,
          taskId: TASK_ID,
          subagentSessionId: `http-delivery-session:${TASK_ID}`,
          definitionName: 'researcher',
          definitionVersion: '2',
          runnerId: 'http-runner-1',
          runnerVersion: '1',
          adapterStateVersion: '1',
          recoveryData: Object.freeze({ kind: 'http-test/v1', jobId: JOB_ID }),
        }),
      }),
    }),
    packet({
      channelId: CHANNEL_ID,
      sequence: 1,
      messageId: 'direction-snapshot-request',
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      kind: 'snapshot.request',
      payload: Object.freeze({ mode: 'snapshot' as const }),
    }),
    packet({
      channelId: CHANNEL_ID,
      sequence: 1,
      messageId: 'direction-model-reply',
      ...replyRoute,
      kind: 'model.reply',
      payload: Object.freeze({
        providerOperationId: OPERATION_ID,
        gatewayId: 'direction-gateway-1',
        protocol: 'openai-chat',
        codecVersion: '1',
        runId: RUN_ID,
        executionAttempt: 1,
        executionEpoch: 'http-delivery-execution-epoch-1',
        executionFencingToken: '1',
        checkpointOperationId: 'direction-checkpoint-1',
        checkpointDigest: 'c'.repeat(64),
        requestHash: 'a'.repeat(64),
        ok: true as const,
        resultHash: 'b'.repeat(64),
        messages: Object.freeze([{ role: 'assistant', content: 'done' }]),
      }),
    }),
  ]);
}

function enqueueInput(scope: HttpSubAgentJobScope, packet: SubAgentTransportPeerPacket) {
  return Object.freeze({
    ...scope,
    channelId: CHANNEL_ID,
    channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
    packet,
  });
}

function pollInput(scope: HttpSubAgentJobScope, ackCursor: string) {
  return Object.freeze({
    ...scope,
    channelId: CHANNEL_ID,
    channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
    ackCursor,
  });
}

function waitInput(scope: HttpSubAgentJobScope, observedRevision: string, waitMs = 10_000) {
  return Object.freeze({
    ...scope,
    channelId: CHANNEL_ID,
    channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
    observedRevision,
    waitMs,
  });
}

function packetRetainedBytes(packet: SubAgentTransportPeerPacket): number {
  let total =
    typeof packet.frame === 'string'
      ? TEXT_ENCODER.encode(packet.frame).byteLength
      : packet.frame.byteLength;
  for (const sidecar of packet.sidecars) {
    total +=
      TEXT_ENCODER.encode(canonicalizeJson(sidecar.descriptor as unknown as JsonValue)).byteLength +
      sidecar.data.byteLength;
  }
  return total;
}

async function expectStoreError(
  promise: Promise<unknown>,
  category: HttpSubAgentJobStoreErrorCategory,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'HttpSubAgentJobStoreError',
    code: 'HTTP_SUBAGENT_JOB_STORE_ERROR',
    category,
  });
}

function dataCloneWithAccessor(value: object, field: string, onRead: () => void): object {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  descriptors[field] = {
    configurable: true,
    enumerable: true,
    get() {
      onRead();
      return Reflect.get(value, field);
    },
  };
  return Object.defineProperties({}, descriptors);
}

describe('HTTP durable outbound delivery Store', () => {
  acceptanceIt(
    'C7C-HTTP-STORE04.l2.delivery-enqueue-cursor',
    'message-receipt-monotonic-uint64',
    async () => {
      assertNetworkDenyGuardInstalled();
      const invalidChannelStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 2,
        maxRetainedBytes: 4 * 1024 * 1024,
        now: () => NOW,
      });
      await expect(
        invalidChannelStore.createOrReplay(createJobInput({ channelId: '\u901a\u9053' })),
      ).rejects.toThrow();
      await expect(
        invalidChannelStore.createOrReplay(createJobInput({ channelId: 'a'.repeat(129) })),
      ).rejects.toThrow();
      expect(invalidChannelStore.diagnostics).toMatchObject({
        retainedJobs: 0,
        retainedBytes: 0,
        outstandingDeliveries: 0,
        retainedDeliveryReceipts: 0,
      });

      const store = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 2,
        maxRetainedBytes: 4 * 1024 * 1024,
        deliveryCapacity: 32,
        maxDeliveryRetainedBytes: 4 * 1024 * 1024,
        deliveryReceiptCapacity: 64,
        waiterCapacity: 8,
        now: () => NOW,
      });
      const create = createJobInput();
      const scope = scopeFor(create);
      await store.createOrReplay(create);

      const initialState = await store.loadDelivery(scope);
      expect(initialState).toMatchObject({
        deliveryVersion: '1',
        revision: '0',
        channelId: CHANNEL_ID,
        channelGeneration: '0',
        ackCursor: '0',
        offeredCursor: null,
        outstandingDeliveries: 0,
        updatedAt: NOW,
      });
      if (initialState === undefined) throw new Error('Expected the initial delivery state.');
      expect(
        normalizeHttpSubAgentJobDeliveryState({
          ...initialState,
          revision: '1',
          offeredCursor: '1',
          outstandingDeliveries: 1,
        }),
      ).toMatchObject({ ackCursor: '0', offeredCursor: '1', outstandingDeliveries: 1 });
      expect(() =>
        normalizeHttpSubAgentJobDeliveryState({
          ...initialState,
          revision: '2',
          offeredCursor: '2',
          outstandingDeliveries: 1,
        }),
      ).toThrow();
      expect(() =>
        normalizeHttpSubAgentJobDeliveryState({
          ...initialState,
          revision: '1',
          offeredCursor: '1',
          outstandingDeliveries: 0,
        }),
      ).toThrow();
      expect(() =>
        normalizeHttpSubAgentJobDeliveryState({
          ...initialState,
          ackCursor: '1',
        }),
      ).toThrow();
      expect(() =>
        normalizeHttpSubAgentJobDeliveryState({
          ...initialState,
          revision: '18446744073709551615',
          ackCursor: '18446744073709551615',
          offeredCursor: null,
          outstandingDeliveries: 1,
        }),
      ).toThrow();

      for (const denied of createDirectionDeniedPackets(create)) {
        await expect(store.enqueueOutbound(enqueueInput(scope, denied))).rejects.toThrow();
        await expect(store.loadDelivery(scope)).resolves.toEqual(initialState);
        expect(store.diagnostics).toMatchObject({
          outstandingDeliveries: 0,
          deliveryRetainedBytes: 0,
          retainedDeliveryReceipts: 0,
        });
      }

      const firstPacket = createOutboundPacket({
        messageId: 'outbound-message-1',
        sequence: 1,
        sidecarId: 'outbound-sidecar-1',
        sidecarText: 'first-delivery',
        frameAsBytes: true,
      });
      const firstReplayPacket = createOutboundPacket({
        messageId: 'outbound-message-1',
        sequence: 1,
        sidecarId: 'outbound-sidecar-1',
        sidecarText: 'first-delivery',
      });
      const first = await store.enqueueOutbound(enqueueInput(scope, firstPacket));
      if (first === undefined) throw new Error('Expected the first outbound enqueue to resolve.');
      expect(first).toMatchObject({
        status: 'enqueued',
        revision: '1',
        cursor: '1',
        messageId: 'outbound-message-1',
      });
      expect(first.packetReceipt).toMatch(/^[0-9a-f]{64}$/u);

      firstPacket.sidecars[0]?.data.fill(0);
      if (firstPacket.frame instanceof Uint8Array) firstPacket.frame.fill(0);
      const firstReplay = await store.enqueueOutbound(enqueueInput(scope, firstReplayPacket));
      expect(firstReplay).toMatchObject({
        status: 'replayed',
        revision: '1',
        cursor: '1',
        messageId: 'outbound-message-1',
        packetReceipt: first.packetReceipt,
      });

      const stateAfterFirst = await store.loadDelivery(scope);
      if (stateAfterFirst === undefined) throw new Error('Expected delivery state after enqueue.');
      await expectStoreError(
        store.enqueueOutbound(
          enqueueInput(
            scope,
            createOutboundPacket({
              messageId: 'outbound-message-1',
              sequence: 1,
              sidecarId: 'outbound-sidecar-1',
              sidecarText: 'changed-delivery',
            }),
          ),
        ),
        'idempotency_conflict',
      );
      await expectStoreError(
        store.enqueueOutbound(
          enqueueInput(
            scope,
            createOutboundPacket({
              messageId: 'outbound-message-1',
              sequence: 1,
              correlationId: 'different-correlation-for-same-message',
              sidecarId: 'outbound-sidecar-1',
              sidecarText: 'first-delivery',
            }),
          ),
        ),
        'idempotency_conflict',
      );
      await expectStoreError(
        store.enqueueOutbound(
          enqueueInput(
            scope,
            createOutboundPacket({ messageId: 'outbound-message-1', sequence: 2 }),
          ),
        ),
        'idempotency_conflict',
      );
      await expectStoreError(
        store.enqueueOutbound(
          enqueueInput(
            scope,
            createOutboundPacket({ messageId: 'different-message-same-sequence', sequence: 1 }),
          ),
        ),
        'idempotency_conflict',
      );
      await expectStoreError(
        store.enqueueOutbound(
          enqueueInput(scope, createOutboundPacket({ messageId: 'future-gap', sequence: 3 })),
        ),
        'idempotency_conflict',
      );
      expect(await store.loadDelivery(scope)).toEqual(stateAfterFirst);

      const second = await store.enqueueOutbound(
        enqueueInput(scope, createOutboundPacket({ messageId: 'outbound-message-2', sequence: 2 })),
      );
      expect(second).toMatchObject({ status: 'enqueued', cursor: '2' });
      await expectStoreError(
        store.enqueueOutbound(
          enqueueInput(
            scope,
            createOutboundPacket({ messageId: 'unknown-old-sequence', sequence: 1 }),
          ),
        ),
        'idempotency_conflict',
      );

      const concurrent = await Promise.all(
        Array.from({ length: 14 }, (_, index) => {
          const sequence = index + 3;
          return store.enqueueOutbound(
            enqueueInput(
              scope,
              createOutboundPacket({
                messageId: `outbound-message-${sequence}`,
                sequence,
              }),
            ),
          );
        }),
      );
      expect(concurrent).toHaveLength(14);
      expect(
        concurrent.map((result) => {
          if (result === undefined) throw new Error('Expected the concurrent enqueue to resolve.');
          expect(result.status).toBe('enqueued');
          return result.cursor;
        }),
      ).toEqual(Array.from({ length: 14 }, (_, index) => String(index + 3)));

      const duplicateResults = await Promise.all(
        Array.from({ length: 32 }, () =>
          store.enqueueOutbound(
            enqueueInput(
              scope,
              createOutboundPacket({ messageId: 'outbound-message-17', sequence: 17 }),
            ),
          ),
        ),
      );
      expect(duplicateResults.filter((result) => result?.status === 'enqueued')).toHaveLength(1);
      expect(duplicateResults.filter((result) => result?.status === 'replayed')).toHaveLength(31);
      expect(new Set(duplicateResults.map((result) => result?.cursor))).toEqual(new Set(['17']));

      const invalidSidecarPacket = createOutboundPacket({
        messageId: 'outbound-message-18',
        sequence: 18,
        sidecarId: 'outbound-sidecar-invalid',
        sidecarText: 'verified-bytes',
      });
      invalidSidecarPacket.sidecars[0]?.data.fill(0);
      await expect(
        store.enqueueOutbound(enqueueInput(scope, invalidSidecarPacket)),
      ).rejects.toThrow();

      await expectStoreError(
        store.enqueueOutbound({
          ...enqueueInput(
            scope,
            createOutboundPacket({ messageId: 'wrong-channel', sequence: 18 }),
          ),
          channelId: 'another-channel',
        }),
        'attachment_fenced',
      );
      let fencedSidecarReads = 0;
      const hostileFencedSidecars = new Proxy([] as SubAgentTransportArtifactSidecar[], {
        get() {
          fencedSidecarReads += 1;
          throw new Error('A fenced packet must not read its hostile sidecars.');
        },
        getOwnPropertyDescriptor() {
          fencedSidecarReads += 1;
          throw new Error('A fenced packet must not inspect its hostile sidecars.');
        },
      });
      const wrongInnerChannel = createOutboundPacket({
        messageId: 'packet-channel-mismatch',
        sequence: 18,
        channelId: 'another-channel',
      });
      await expectStoreError(
        store.enqueueOutbound(
          enqueueInput(
            scope,
            Object.freeze({
              frame: wrongInnerChannel.frame,
              sidecars: hostileFencedSidecars,
            }),
          ),
        ),
        'attachment_fenced',
      );
      expect(fencedSidecarReads).toBe(0);
      await expectStoreError(
        store.enqueueOutbound({
          ...enqueueInput(
            scope,
            createOutboundPacket({ messageId: 'wrong-generation', sequence: 18 }),
          ),
          channelGeneration: '1',
        }),
        'attachment_fenced',
      );
      await expect(
        store.enqueueOutbound({
          ...enqueueInput(
            scope,
            createOutboundPacket({ messageId: 'noncanonical-generation', sequence: 18 }),
          ),
          channelGeneration: '00',
        }),
      ).rejects.toThrow();

      const unknownScope = Object.freeze({ ...scope, jobId: 'unknown-delivery-job' });
      await expectStoreError(
        store.enqueueOutbound(
          enqueueInput(
            unknownScope,
            createOutboundPacket({ messageId: 'unknown-job-message', sequence: 1 }),
          ),
        ),
        'resource_not_found',
      );
      await expect(store.loadDelivery(unknownScope)).resolves.toBeUndefined();

      let proxyReads = 0;
      const hostileInput = new Proxy(
        enqueueInput(
          scope,
          createOutboundPacket({ messageId: 'hostile-outbound-message', sequence: 18 }),
        ),
        {
          get() {
            proxyReads += 1;
            throw new Error('A hostile delivery input Proxy trap must not run.');
          },
        },
      );
      await expect(
        Promise.resolve().then(() => Reflect.apply(store.enqueueOutbound, store, [hostileInput])),
      ).rejects.toThrow();
      expect(proxyReads).toBe(0);
      expect(store.diagnostics).toMatchObject({
        outstandingDeliveries: 17,
        retainedDeliveryReceipts: 17,
        activeWaiters: 0,
      });

      const offeredFirst = await store.pollOutbound(pollInput(scope, '0'));
      if (offeredFirst === undefined || offeredFirst.delivery === null) {
        throw new Error('Expected the first outbound delivery.');
      }
      expect(offeredFirst).toMatchObject({
        deliveryVersion: '1',
        channelId: CHANNEL_ID,
        channelGeneration: '0',
        ackCursor: '0',
        delivery: { cursor: '1', packetReceipt: first.packetReceipt },
      });
      expect(offeredFirst.delivery.packet.sidecars[0]?.data).toEqual(bytes('first-delivery'));
      expect(Object.isFrozen(offeredFirst)).toBe(true);
      expect(Object.isFrozen(offeredFirst.delivery)).toBe(true);
      expect(Object.isFrozen(offeredFirst.delivery.packet)).toBe(true);
      offeredFirst.delivery.packet.sidecars[0]?.data.fill(0);

      const replayedOffer = await store.pollOutbound(pollInput(scope, '0'));
      if (replayedOffer === undefined || replayedOffer.delivery === null) {
        throw new Error('Expected the response-loss replay delivery.');
      }
      expect(replayedOffer.delivery.cursor).toBe('1');
      expect(replayedOffer.delivery.packetReceipt).toBe(first.packetReceipt);
      expect(replayedOffer.delivery.packet).not.toBe(offeredFirst.delivery.packet);
      expect(replayedOffer.delivery.packet.sidecars[0]?.data).toEqual(bytes('first-delivery'));

      const offeredSecond = await store.pollOutbound(pollInput(scope, '1'));
      if (offeredSecond === undefined || offeredSecond.delivery === null) {
        throw new Error('Expected the second outbound delivery.');
      }
      expect(offeredSecond).toMatchObject({
        ackCursor: '1',
        delivery: { cursor: '2' },
      });
      const replayedSecond = await store.pollOutbound(pollInput(scope, '1'));
      expect(replayedSecond).toMatchObject({
        ackCursor: '1',
        delivery: { cursor: '2', packetReceipt: offeredSecond.delivery.packetReceipt },
      });
      await expectStoreError(store.pollOutbound(pollInput(scope, '0')), 'cursor_conflict');
      await expectStoreError(store.pollOutbound(pollInput(scope, '3')), 'cursor_conflict');
      await expectStoreError(
        store.pollOutbound(pollInput(scope, '18446744073709551615')),
        'cursor_conflict',
      );
      await expect(store.pollOutbound(pollInput(scope, '01'))).rejects.toThrow();

      let page = offeredSecond;
      for (let expectedCursor = 2; expectedCursor <= 17; expectedCursor += 1) {
        if (page.delivery === null)
          throw new Error('Expected a contiguous outbound delivery page.');
        expect(page.delivery.cursor).toBe(String(expectedCursor));
        const advanced = await store.pollOutbound(pollInput(scope, String(expectedCursor)));
        if (advanced === undefined) throw new Error('Expected the outbound ACK to resolve.');
        page = advanced;
      }
      expect(page).toMatchObject({ ackCursor: '17', delivery: null });
      await expect(store.pollOutbound(pollInput(scope, '17'))).resolves.toMatchObject({
        ackCursor: '17',
        delivery: null,
      });
      await expect(
        store.enqueueOutbound(enqueueInput(scope, firstReplayPacket)),
      ).resolves.toMatchObject({ status: 'replayed', cursor: '1' });
      await expect(store.pollOutbound(pollInput(scope, '17'))).resolves.toMatchObject({
        ackCursor: '17',
        delivery: null,
      });
      expect(store.diagnostics).toMatchObject({
        outstandingDeliveries: 0,
        deliveryRetainedBytes: 0,
        retainedDeliveryReceipts: 17,
      });

      const capacityPacketA = createOutboundPacket({
        messageId: 'capacity-message-a',
        sequence: 1,
        sidecarId: 'capacity-sidecar-a',
        sidecarText: 'capacity-payload',
      });
      const capacityPacketB = createOutboundPacket({
        messageId: 'capacity-message-b',
        sequence: 2,
        sidecarId: 'capacity-sidecar-b',
        sidecarText: 'capacity-payload',
      });
      expect(packetRetainedBytes(capacityPacketB)).toBe(packetRetainedBytes(capacityPacketA));
      const capacityStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 1,
        maxRetainedBytes: 4 * 1024 * 1024,
        deliveryCapacity: 1,
        maxDeliveryRetainedBytes: packetRetainedBytes(capacityPacketA),
        deliveryReceiptCapacity: 2,
        waiterCapacity: 1,
        now: () => NOW,
      });
      await capacityStore.createOrReplay(create);
      await capacityStore.enqueueOutbound(enqueueInput(scope, capacityPacketA));
      await expectStoreError(
        capacityStore.enqueueOutbound(enqueueInput(scope, capacityPacketB)),
        'capacity_exhausted',
      );
      await capacityStore.pollOutbound(pollInput(scope, '0'));
      await capacityStore.pollOutbound(pollInput(scope, '1'));
      await expect(
        capacityStore.enqueueOutbound(enqueueInput(scope, capacityPacketB)),
      ).resolves.toMatchObject({ status: 'enqueued', cursor: '2' });
      await capacityStore.pollOutbound(pollInput(scope, '1'));
      await capacityStore.pollOutbound(pollInput(scope, '2'));
      await expectStoreError(
        capacityStore.enqueueOutbound(
          enqueueInput(
            scope,
            createOutboundPacket({ messageId: 'capacity-message-c', sequence: 3 }),
          ),
        ),
        'capacity_exhausted',
      );
      await expect(
        capacityStore.enqueueOutbound(enqueueInput(scope, capacityPacketA)),
      ).resolves.toMatchObject({ status: 'replayed', cursor: '1' });
      expect(capacityStore.diagnostics).toMatchObject({
        outstandingDeliveries: 0,
        deliveryRetainedBytes: 0,
        retainedDeliveryReceipts: 2,
      });

      let triggerClockReentry = false;
      let clockReentered = false;
      let innerPoll: ReturnType<MemoryHttpSubAgentJobStore['pollOutbound']> | undefined;
      const reentrantStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 1,
        maxRetainedBytes: 4 * 1024 * 1024,
        deliveryCapacity: 2,
        maxDeliveryRetainedBytes: 4 * 1024 * 1024,
        deliveryReceiptCapacity: 2,
        waiterCapacity: 1,
        now: () => {
          if (triggerClockReentry && !clockReentered) {
            clockReentered = true;
            innerPoll = reentrantStore.pollOutbound(pollInput(scope, '0'));
          }
          return NOW;
        },
      });
      await reentrantStore.createOrReplay(create);
      await reentrantStore.enqueueOutbound(
        enqueueInput(
          scope,
          createOutboundPacket({ messageId: 'clock-existing-message', sequence: 1 }),
        ),
      );
      triggerClockReentry = true;
      await expect(
        reentrantStore.enqueueOutbound(
          enqueueInput(
            scope,
            createOutboundPacket({ messageId: 'clock-outer-message', sequence: 2 }),
          ),
        ),
      ).resolves.toMatchObject({ status: 'enqueued', cursor: '2', revision: '3' });
      if (innerPoll === undefined) throw new Error('Expected the clock callback to reenter poll.');
      await expect(innerPoll).resolves.toMatchObject({
        revision: '2',
        ackCursor: '0',
        delivery: { cursor: '1' },
      });
      await expect(reentrantStore.loadDelivery(scope)).resolves.toMatchObject({
        revision: '3',
        ackCursor: '0',
        offeredCursor: '1',
        outstandingDeliveries: 2,
      });
      await expect(reentrantStore.waitForOutbound(waitInput(scope, '1', 0))).resolves.toMatchObject(
        {
          status: 'changed',
          state: { revision: '3' },
        },
      );
      await expect(reentrantStore.waitForOutbound(waitInput(scope, '3', 0))).resolves.toMatchObject(
        {
          status: 'timed_out',
          state: { revision: '3' },
        },
      );
      expect(reentrantStore.diagnostics).toMatchObject({
        outstandingDeliveries: 2,
        retainedDeliveryReceipts: 2,
      });

      let rollbackClock = NOW;
      let armNestedClockRollback = false;
      let nestedClockRollbackTriggered = false;
      let insideNestedClockMutation = false;
      let nestedRollbackPoll: ReturnType<MemoryHttpSubAgentJobStore['pollOutbound']> | undefined;
      const rollbackStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 1,
        maxRetainedBytes: 4 * 1024 * 1024,
        deliveryCapacity: 3,
        maxDeliveryRetainedBytes: 4 * 1024 * 1024,
        deliveryReceiptCapacity: 3,
        waiterCapacity: 1,
        now: () => {
          if (insideNestedClockMutation) return NOW + 2;
          if (armNestedClockRollback && !nestedClockRollbackTriggered) {
            nestedClockRollbackTriggered = true;
            insideNestedClockMutation = true;
            nestedRollbackPoll = rollbackStore.pollOutbound(pollInput(scope, '0'));
            insideNestedClockMutation = false;
            return NOW + 1;
          }
          return rollbackClock;
        },
      });
      await rollbackStore.createOrReplay(create);
      await rollbackStore.enqueueOutbound(
        enqueueInput(
          scope,
          createOutboundPacket({ messageId: 'rollback-existing-message', sequence: 1 }),
        ),
      );
      const rollbackOuterPacket = createOutboundPacket({
        messageId: 'rollback-outer-message',
        sequence: 2,
      });
      armNestedClockRollback = true;
      await expect(
        rollbackStore.enqueueOutbound(enqueueInput(scope, rollbackOuterPacket)),
      ).rejects.toThrow('Memory HTTP job Store clock must be monotonic.');
      if (nestedRollbackPoll === undefined) {
        throw new Error('Expected the rollback clock callback to reenter poll.');
      }
      await expect(nestedRollbackPoll).resolves.toMatchObject({
        revision: '2',
        ackCursor: '0',
        delivery: { cursor: '1' },
      });
      await expect(rollbackStore.loadDelivery(scope)).resolves.toMatchObject({
        revision: '2',
        ackCursor: '0',
        offeredCursor: '1',
        outstandingDeliveries: 1,
      });
      expect(rollbackStore.diagnostics).toMatchObject({
        outstandingDeliveries: 1,
        retainedDeliveryReceipts: 1,
      });
      armNestedClockRollback = false;
      rollbackClock = NOW + 3;
      await expect(
        rollbackStore.enqueueOutbound(enqueueInput(scope, rollbackOuterPacket)),
      ).resolves.toMatchObject({ status: 'enqueued', revision: '3', cursor: '2' });
      const stateBeforeFlatRollback = await rollbackStore.loadDelivery(scope);
      rollbackClock = NOW + 2;
      await expect(
        rollbackStore.enqueueOutbound(
          enqueueInput(
            scope,
            createOutboundPacket({ messageId: 'rollback-flat-message', sequence: 3 }),
          ),
        ),
      ).rejects.toThrow('Memory HTTP job Store clock must be monotonic.');
      await expect(rollbackStore.loadDelivery(scope)).resolves.toEqual(stateBeforeFlatRollback);
      expect(rollbackStore.diagnostics).toMatchObject({
        outstandingDeliveries: 2,
        retainedDeliveryReceipts: 2,
      });

      await Promise.all([
        invalidChannelStore.dispose(),
        store.dispose(),
        capacityStore.dispose(),
        reentrantStore.dispose(),
        rollbackStore.dispose(),
      ]);
    },
  );

  acceptanceIt(
    'C7C-HTTP-STORE07.l2.waiter-lifecycle',
    'lost-wake-abort-deadline-dispose',
    async () => {
      assertNetworkDenyGuardInstalled();
      let armLostWake = false;
      let lostWakeTriggered = false;
      let wakeupEnqueue: ReturnType<MemoryHttpSubAgentJobStore['enqueueOutbound']> | undefined;
      const create = createJobInput();
      const scope = scopeFor(create);
      const store = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 1,
        maxRetainedBytes: 4 * 1024 * 1024,
        deliveryCapacity: 4,
        maxDeliveryRetainedBytes: 4 * 1024 * 1024,
        deliveryReceiptCapacity: 4,
        waiterCapacity: 2,
        now: () => {
          if (armLostWake && !lostWakeTriggered) {
            lostWakeTriggered = true;
            wakeupEnqueue = store.enqueueOutbound(
              enqueueInput(
                scope,
                createOutboundPacket({
                  messageId: 'lost-wake-outbound-message',
                  sequence: 1,
                }),
              ),
            );
          }
          return NOW;
        },
      });
      await store.createOrReplay(create);
      const initial = await store.loadDelivery(scope);
      if (initial === undefined) throw new Error('Expected initial delivery state.');

      armLostWake = true;
      const changed = await store.waitForOutbound(waitInput(scope, initial.revision));
      if (wakeupEnqueue === undefined) throw new Error('Expected the lost-wake enqueue to run.');
      await expect(wakeupEnqueue).resolves.toMatchObject({ status: 'enqueued', cursor: '1' });
      expect(changed).toMatchObject({
        status: 'changed',
        state: { revision: '1', outstandingDeliveries: 1 },
      });
      expect(Object.isFrozen(changed)).toBe(true);
      expect(Object.isFrozen(changed?.state)).toBe(true);
      expect(store.diagnostics.activeWaiters).toBe(0);

      await expect(store.waitForOutbound(waitInput(scope, '0'))).resolves.toMatchObject({
        status: 'changed',
        state: { revision: '1' },
      });
      const current = await store.loadDelivery(scope);
      if (current === undefined) throw new Error('Expected current delivery state.');
      await expect(
        store.waitForOutbound(waitInput(scope, current.revision, 0)),
      ).resolves.toMatchObject({
        status: 'timed_out',
        state: { revision: current.revision },
      });
      expect(store.diagnostics.activeWaiters).toBe(0);

      let armZeroWaitReentry = false;
      let zeroWaitReentryTriggered = false;
      let zeroWaitPoll: ReturnType<MemoryHttpSubAgentJobStore['pollOutbound']> | undefined;
      const zeroWaitStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 1,
        maxRetainedBytes: 4 * 1024 * 1024,
        deliveryCapacity: 1,
        maxDeliveryRetainedBytes: 4 * 1024 * 1024,
        deliveryReceiptCapacity: 1,
        waiterCapacity: 1,
        now: () => {
          if (armZeroWaitReentry && !zeroWaitReentryTriggered) {
            zeroWaitReentryTriggered = true;
            zeroWaitPoll = zeroWaitStore.pollOutbound(pollInput(scope, '0'));
          }
          return NOW;
        },
      });
      await zeroWaitStore.createOrReplay(create);
      await zeroWaitStore.enqueueOutbound(
        enqueueInput(
          scope,
          createOutboundPacket({ messageId: 'zero-wait-existing-message', sequence: 1 }),
        ),
      );
      const zeroWaitCurrent = await zeroWaitStore.loadDelivery(scope);
      if (zeroWaitCurrent === undefined) throw new Error('Expected zero-wait delivery state.');
      armZeroWaitReentry = true;
      await expect(
        zeroWaitStore.waitForOutbound(waitInput(scope, zeroWaitCurrent.revision, 0), {
          deadlineAt: NOW + 1_000,
        }),
      ).resolves.toMatchObject({
        status: 'changed',
        state: { revision: '2', offeredCursor: '1' },
      });
      if (zeroWaitPoll === undefined) throw new Error('Expected zero-wait clock reentry poll.');
      await expect(zeroWaitPoll).resolves.toMatchObject({ revision: '2' });
      expect(zeroWaitStore.diagnostics.activeWaiters).toBe(0);

      const naturalTimeoutAbort = new AbortController();
      let naturalTimeoutSettlements = 0;
      const naturalTimeout = store
        .waitForOutbound(waitInput(scope, current.revision, 5), {
          signal: naturalTimeoutAbort.signal,
          deadlineAt: NOW + 1_000,
        })
        .then(
          (result) => {
            naturalTimeoutSettlements += 1;
            return result;
          },
          (error: unknown) => {
            naturalTimeoutSettlements += 1;
            throw error;
          },
        );
      await Promise.resolve();
      expect(store.diagnostics.activeWaiters).toBe(1);
      await expect(naturalTimeout).resolves.toMatchObject({
        status: 'timed_out',
        state: { revision: current.revision },
      });
      expect(store.diagnostics.activeWaiters).toBe(0);
      naturalTimeoutAbort.abort();
      await Promise.resolve();
      expect(naturalTimeoutSettlements).toBe(1);

      const futureDeadlineAbort = new AbortController();
      let futureDeadlineSettlements = 0;
      const futureDeadline = store
        .waitForOutbound(waitInput(scope, current.revision, 1_000), {
          signal: futureDeadlineAbort.signal,
          deadlineAt: NOW + 5,
        })
        .then(
          (result) => {
            futureDeadlineSettlements += 1;
            return result;
          },
          (error: unknown) => {
            futureDeadlineSettlements += 1;
            throw error;
          },
        );
      await Promise.resolve();
      expect(store.diagnostics.activeWaiters).toBe(1);
      await expectStoreError(futureDeadline, 'deadline_exceeded');
      expect(store.diagnostics.activeWaiters).toBe(0);
      futureDeadlineAbort.abort();
      await Promise.resolve();
      expect(futureDeadlineSettlements).toBe(1);

      const abortController = new AbortController();
      const abortedWait = store.waitForOutbound(waitInput(scope, current.revision), {
        signal: abortController.signal,
      });
      await Promise.resolve();
      expect(store.diagnostics.activeWaiters).toBe(1);
      abortController.abort();
      await expectStoreError(abortedWait, 'aborted');
      expect(store.diagnostics.activeWaiters).toBe(0);

      const preAborted = new AbortController();
      preAborted.abort();
      await expectStoreError(
        store.enqueueOutbound(
          enqueueInput(
            scope,
            createOutboundPacket({ messageId: 'pre-aborted-message', sequence: 2 }),
          ),
          { signal: preAborted.signal },
        ),
        'aborted',
      );
      await expectStoreError(store.loadDelivery(scope, { deadlineAt: NOW }), 'deadline_exceeded');
      await expectStoreError(
        store.waitForOutbound(waitInput(scope, current.revision), { deadlineAt: NOW }),
        'deadline_exceeded',
      );
      expect(await store.loadDelivery(scope)).toEqual(current);

      const unknownScope = Object.freeze({ ...scope, jobId: 'unknown-wait-job' });
      await expectStoreError(
        store.waitForOutbound(waitInput(unknownScope, '0')),
        'resource_not_found',
      );
      expect(store.diagnostics.activeWaiters).toBe(0);
      await expect(store.waitForOutbound(waitInput(scope, current.revision, -1))).rejects.toThrow();
      await expect(
        store.waitForOutbound(waitInput(scope, current.revision, 10_001)),
      ).rejects.toThrow();
      expect(store.diagnostics.activeWaiters).toBe(0);

      let contextProxyReads = 0;
      const hostileContext = new Proxy(
        { signal: new AbortController().signal },
        {
          get() {
            contextProxyReads += 1;
            throw new Error('A hostile IO context Proxy trap must not run.');
          },
        },
      );
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(store.loadDelivery, store, [scope, hostileContext]),
        ),
      ).rejects.toThrow();
      expect(contextProxyReads).toBe(0);

      let signalAccessorReads = 0;
      const accessorContext = dataCloneWithAccessor(
        { signal: new AbortController().signal },
        'signal',
        () => {
          signalAccessorReads += 1;
        },
      );
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(store.loadDelivery, store, [scope, accessorContext]),
        ),
      ).rejects.toThrow();
      expect(signalAccessorReads).toBe(0);

      let waitProxyReads = 0;
      const hostileWait = new Proxy(waitInput(scope, current.revision), {
        get() {
          waitProxyReads += 1;
          throw new Error('A hostile wait input Proxy trap must not run.');
        },
      });
      await expect(
        Promise.resolve().then(() => Reflect.apply(store.waitForOutbound, store, [hostileWait])),
      ).rejects.toThrow();
      expect(waitProxyReads).toBe(0);
      expect(store.diagnostics.activeWaiters).toBe(0);

      const waiterStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 1,
        maxRetainedBytes: 4 * 1024 * 1024,
        deliveryCapacity: 2,
        maxDeliveryRetainedBytes: 4 * 1024 * 1024,
        deliveryReceiptCapacity: 2,
        waiterCapacity: 1,
        now: () => NOW,
      });
      await waiterStore.createOrReplay(create);
      const waiterAbort = new AbortController();
      const retainedWaiter = waiterStore.waitForOutbound(waitInput(scope, '0'), {
        signal: waiterAbort.signal,
      });
      await Promise.resolve();
      expect(waiterStore.diagnostics.activeWaiters).toBe(1);
      await expectStoreError(
        waiterStore.waitForOutbound(waitInput(scope, '0')),
        'capacity_exhausted',
      );
      expect(waiterStore.diagnostics.activeWaiters).toBe(1);
      waiterAbort.abort();
      await expectStoreError(retainedWaiter, 'aborted');
      expect(waiterStore.diagnostics.activeWaiters).toBe(0);

      const disposedWait = waiterStore.waitForOutbound(waitInput(scope, '0'));
      await Promise.resolve();
      expect(waiterStore.diagnostics.activeWaiters).toBe(1);
      await waiterStore.dispose();
      await expectStoreError(disposedWait, 'disposed');
      expect(waiterStore.diagnostics).toMatchObject({
        outstandingDeliveries: 0,
        deliveryRetainedBytes: 0,
        retainedDeliveryReceipts: 0,
        activeWaiters: 0,
      });
      await expectStoreError(waiterStore.waitForOutbound(waitInput(scope, '0')), 'disposed');

      await store.dispose();
      await zeroWaitStore.dispose();
      expect(store.diagnostics).toMatchObject({
        outstandingDeliveries: 0,
        deliveryRetainedBytes: 0,
        retainedDeliveryReceipts: 0,
        activeWaiters: 0,
      });
    },
  );
});
