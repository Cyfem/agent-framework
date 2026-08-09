import { describe, expect } from 'vitest';

import { acceptanceIt, createExecutorConformanceChildCheckpoint } from '../../../testkit';

import {
  DEFAULT_SUBAGENT_LIMITS,
  SUBAGENT_TRANSPORT_RPC_KINDS,
  createSubAgentExecutionRequestWire,
  createSubAgentTransportRpcEnvelope,
  encodeSubAgentTransportRpcFrame,
  type CreateSubAgentTransportRpcEnvelopeInput,
  type SubAgentExecutionRequest,
  type SubAgentExecutorBinding,
  type SubAgentTransportArtifactSidecar,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportRpcEnvelope,
  type SubAgentTransportRpcKind,
} from '@ruixutong.manee/maneeagent-framework';

import {
  HTTP_SUBAGENT_MAX_POLL_BODY_BYTES,
  HTTP_SUBAGENT_MAX_POLL_WAIT_MS,
  HTTP_SUBAGENT_POLL_MEDIA_TYPE,
  HTTP_SUBAGENT_POLL_VERSION,
  createHttpSubAgentHmacHeaders,
  createHttpSubAgentPacketSemanticReceipt,
  decodeHttpSubAgentMultipartPacket,
  decodeHttpSubAgentPollCommand,
  decodeHttpSubAgentRoutedPacket,
  encodeHttpSubAgentMultipartPacket,
  encodeHttpSubAgentPollCommand,
  parseHttpSubAgentRoute,
  type HttpSubAgentPollCommand,
  type HttpSubAgentPollInput,
  type HttpSubAgentRoute,
} from '../src/index';
import {
  HTTP_TEST_KEY,
  HTTP_TEST_KEY_ID,
  HTTP_TEST_NOW,
  bytes,
  createSidecar,
  nonce,
  text,
} from './http-security-fixture';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const UINT64_MAX = '18446744073709551615';
const JOB_ID = 'http-job-1';
const CONTROL_REQUEST_ID = 'http-control-request-1';
const TASK_ID = 'http-task-1';
const OPERATION_ID = 'http-operation-1';
const DEFINITION = Object.freeze({ name: 'researcher', version: '2' });
const POLL_COMMAND = Object.freeze({
  version: HTTP_SUBAGENT_POLL_VERSION,
  channelId: 'http-channel-1',
  channelGeneration: '7',
  ackCursor: '11',
  waitMs: 250,
}) satisfies HttpSubAgentPollCommand;

const REQUEST_KINDS = new Set<SubAgentTransportRpcKind>([
  'executor.request',
  'control.request',
  'cancel.request',
  'snapshot.request',
  'events.request',
  'model.request',
]);

interface EnvelopeOptions {
  readonly channelId?: string;
  readonly sequence?: number;
  readonly messageId?: string;
  readonly correlationId?: string;
  readonly taskId?: string;
  readonly operationId?: string;
  readonly sidecars?: readonly SubAgentTransportArtifactSidecar[];
}

function pollInput(overrides: Readonly<Record<string, unknown>> = {}): HttpSubAgentPollInput {
  return {
    contentType: HTTP_SUBAGENT_POLL_MEDIA_TYPE,
    body: bytes(JSON.stringify({ ...POLL_COMMAND, ...overrides })),
  };
}

function decodePollBody(body: Uint8Array): HttpSubAgentPollCommand {
  return decodeHttpSubAgentPollCommand({
    contentType: HTTP_SUBAGENT_POLL_MEDIA_TYPE,
    body,
  });
}

function createBinding(taskId = TASK_ID): SubAgentExecutorBinding {
  return Object.freeze({
    version: '1',
    executorName: 'http',
    ownerSessionId: 'http-owner-session-1',
    taskId,
    subagentSessionId: `http-subagent-session:${taskId}`,
    definitionName: DEFINITION.name,
    definitionVersion: DEFINITION.version,
    runnerId: 'http-child-runner',
    runnerVersion: '1',
    adapterStateVersion: '1',
    recoveryData: { kind: 'http/v1', jobId: JOB_ID },
  });
}

function createExecutorOperation(
  type: 'create' | 'resume' | 'reconnect',
  taskId: string,
  operationId: string,
): SubAgentExecutionRequest['operation'] {
  if (type === 'create') {
    return Object.freeze({
      type,
      operationId,
      idempotencyKey: `idempotency:${taskId}`,
    });
  }
  const binding = createBinding(taskId);
  if (type === 'reconnect') {
    return Object.freeze({ type, operationId, binding });
  }
  return Object.freeze({
    type,
    operationId,
    reason: 'checkpoint',
    binding,
    checkpoint: createExecutorConformanceChildCheckpoint({
      runnerId: binding.runnerId,
      runnerVersion: binding.runnerVersion,
    }),
  });
}

function createExecutionRequest(
  operation: SubAgentExecutionRequest['operation'],
  taskId: string,
): SubAgentExecutionRequest {
  return Object.freeze({
    operation,
    ownerSessionId: 'http-owner-session-1',
    runId: 'http-run-1',
    taskId,
    parentTaskId: 'http-parent-task-1',
    subagentSessionId: `http-subagent-session:${taskId}`,
    path: Object.freeze(['http-parent-task-1', taskId]),
    attempt: operation.type === 'create' ? 1 : 2,
    executionEpoch: `http-epoch:${operation.type}`,
    executionFencingToken: operation.type === 'create' ? '1' : '2',
    definition: DEFINITION,
    input: { query: 'strict HTTP route policy' },
    projectedContext: Object.freeze([
      Object.freeze({ kind: 'text' as const, name: 'brief', text: 'Use verified evidence.' }),
    ]),
    delegation: Object.freeze({
      version: '1' as const,
      ownerSessionId: 'http-owner-session-1',
      runId: 'http-run-1',
      parentTaskId: taskId,
      path: Object.freeze(['http-parent-task-1', taskId]),
      depth: 2,
      catalogRevision: 1,
      definitions: Object.freeze([
        Object.freeze({
          name: DEFINITION.name,
          version: DEFINITION.version,
          executors: Object.freeze(['http']),
        }),
      ]),
    }),
    limits: DEFAULT_SUBAGENT_LIMITS,
    signal: new AbortController().signal,
    deadlineAt: 121_000,
  });
}

function packetFromEnvelope(
  envelope: SubAgentTransportRpcEnvelope,
  sidecars: readonly SubAgentTransportArtifactSidecar[] = [],
): SubAgentTransportPeerPacket {
  return Object.freeze({
    frame: encodeSubAgentTransportRpcFrame(envelope),
    sidecars: Object.freeze([...sidecars]),
  });
}

function createCorePacket(
  kind: SubAgentTransportRpcKind,
  payload: unknown,
  options: EnvelopeOptions = {},
): SubAgentTransportPeerPacket {
  const taskId = options.taskId ?? TASK_ID;
  const operationId = options.operationId ?? OPERATION_ID;
  const input = {
    channelId: options.channelId ?? 'http-peer-channel-1',
    sequence: options.sequence ?? 1,
    messageId: options.messageId ?? `http-message:${kind}`,
    ...(!REQUEST_KINDS.has(kind)
      ? { correlationId: options.correlationId ?? CONTROL_REQUEST_ID }
      : {}),
    taskId,
    operationId,
    kind,
    payload,
  } as unknown as CreateSubAgentTransportRpcEnvelopeInput;
  return packetFromEnvelope(createSubAgentTransportRpcEnvelope(input), options.sidecars ?? []);
}

function createExecutorRequestPacket(
  operationType: 'create' | 'resume' | 'reconnect',
  mode: 'execute' | 'spawn',
  options: EnvelopeOptions = {},
): SubAgentTransportPeerPacket {
  const taskId = options.taskId ?? TASK_ID;
  const operationId = options.operationId ?? OPERATION_ID;
  const operation = createExecutorOperation(operationType, taskId, operationId);
  const request = createSubAgentExecutionRequestWire(createExecutionRequest(operation, taskId), {
    now: () => 1_000,
  });
  return createCorePacket('executor.request', { mode, request }, options);
}

function createPacketForKind(
  kind: SubAgentTransportRpcKind,
  options: EnvelopeOptions = {},
): SubAgentTransportPeerPacket {
  const taskId = options.taskId ?? TASK_ID;
  const operationId = options.operationId ?? OPERATION_ID;
  const binding = createBinding(taskId);
  switch (kind) {
    case 'executor.request':
      return createExecutorRequestPacket('create', 'execute', options);
    case 'executor.accepted':
      return createCorePacket(kind, { mode: 'spawn', binding }, options);
    case 'executor.settled':
      return createCorePacket(
        kind,
        {
          mode: 'execute',
          outcome: {
            type: 'terminal',
            result: {
              status: 'succeeded',
              task: { taskId, subAgent: DEFINITION },
              executor: 'http',
              output: { proof: 'done' },
              usage: { turns: 2, providerCalls: 1 },
            },
          },
        },
        options,
      );
    case 'control.request':
      return createCorePacket(
        kind,
        {
          executionAttempt: 1,
          executionEpoch: 'http-epoch-1',
          executionFencingToken: '1',
          method: 'execution.reportProgress',
          args: { update: { message: 'halfway', percent: 50 } },
        },
        options,
      );
    case 'control.reply':
      return createCorePacket(
        kind,
        { method: 'execution.reportProgress', ok: true, result: null },
        options,
      );
    case 'cancel.request':
      return createCorePacket(kind, { binding, reason: 'HTTP cancellation' }, options);
    case 'cancel.ack':
      return createCorePacket(kind, { cancelled: true }, options);
    case 'snapshot.request':
      return createCorePacket(kind, { mode: 'snapshot' }, options);
    case 'snapshot.reply':
      return createCorePacket(
        kind,
        { mode: 'snapshot', snapshot: { taskId, state: 'running', binding, updatedAt: 1_000 } },
        options,
      );
    case 'events.request':
      return createCorePacket(kind, { afterSequence: 0, limit: 32 }, options);
    case 'events.page':
      return createCorePacket(kind, { events: [], nextSequence: 0, done: true }, options);
    case 'model.request':
      return createCorePacket(
        kind,
        {
          providerOperationId: operationId,
          gatewayId: 'http-controller-gateway-1',
          protocol: 'openai-chat',
          codecVersion: '1',
          runId: 'http-run-1',
          executionAttempt: 1,
          executionEpoch: 'http-epoch-1',
          executionFencingToken: '1',
          checkpointOperationId: 'http-checkpoint-operation-1',
          checkpointDigest: 'c'.repeat(64),
          purpose: 'agent',
          iteration: 1,
          requestAttempt: 1,
          requestHash: 'a'.repeat(64),
          context: [{ role: 'user', content: 'hello' }],
          tools: [],
          remainingMs: 30_000,
        },
        options,
      );
    case 'model.reply':
      return createCorePacket(
        kind,
        {
          providerOperationId: operationId,
          gatewayId: 'http-controller-gateway-1',
          protocol: 'openai-chat',
          codecVersion: '1',
          runId: 'http-run-1',
          executionAttempt: 1,
          executionEpoch: 'http-epoch-1',
          executionFencingToken: '1',
          checkpointOperationId: 'http-checkpoint-operation-1',
          checkpointDigest: 'c'.repeat(64),
          requestHash: 'a'.repeat(64),
          ok: true,
          resultHash: 'b'.repeat(64),
          messages: [{ role: 'assistant', content: 'done' }],
        },
        options,
      );
    case 'protocol.error':
      return createCorePacket(
        kind,
        {
          error: {
            code: 'EXECUTOR_FAILED',
            message: 'The remote executor rejected the request.',
            retryable: true,
            causeCode: 'REMOTE_REJECTED',
          },
        },
        options,
      );
  }
}

function route(requestTarget: string): HttpSubAgentRoute {
  return parseHttpSubAgentRoute('POST', requestTarget);
}

function expectRouteAccepted(value: HttpSubAgentRoute, packet: SubAgentTransportPeerPacket): void {
  expect(() => decodeHttpSubAgentRoutedPacket(value, packet)).not.toThrow();
}

function expectRouteRejected(value: HttpSubAgentRoute, packet: SubAgentTransportPeerPacket): void {
  expect(() => decodeHttpSubAgentRoutedPacket(value, packet)).toThrow();
}

describe('HTTP job wire primitives', () => {
  acceptanceIt(
    'C7C-HTTP-POLL01.l1.closed-poll-json',
    'closed-fields-owned-and-byte-bounded',
    () => {
      assertNetworkDenyGuardInstalled();
      expect(HTTP_SUBAGENT_POLL_VERSION).toBe('1');
      expect(HTTP_SUBAGENT_POLL_MEDIA_TYPE).toBe('application/vnd.maneeagent.poll+json');
      expect(HTTP_SUBAGENT_MAX_POLL_BODY_BYTES).toBe(4_096);

      const mutableCommand = { ...POLL_COMMAND };
      const encoded = encodeHttpSubAgentPollCommand(mutableCommand);
      const canonicalBody =
        '{"version":"1","channelId":"http-channel-1","channelGeneration":"7","ackCursor":"11","waitMs":250}';
      expect(encoded.contentType).toBe(HTTP_SUBAGENT_POLL_MEDIA_TYPE);
      expect(text(encoded.body)).toBe(canonicalBody);
      expect(encoded.body.byteLength).toBeLessThanOrEqual(HTTP_SUBAGENT_MAX_POLL_BODY_BYTES);
      expect(Object.isFrozen(encoded)).toBe(true);

      expect(Reflect.set(mutableCommand, 'channelId', 'mutated-after-encode')).toBe(true);
      expect(text(encoded.body)).toBe(canonicalBody);
      const encodedSnapshot = encoded.body.slice();
      encoded.body.fill(0);
      expect(encodeHttpSubAgentPollCommand(POLL_COMMAND).body).toEqual(encodedSnapshot);

      const ownedSource = encodedSnapshot.slice();
      const decoded = decodePollBody(ownedSource);
      ownedSource.fill(0);
      expect(decoded).toEqual(POLL_COMMAND);
      expect(Object.keys(decoded)).toEqual([
        'version',
        'channelId',
        'channelGeneration',
        'ackCursor',
        'waitMs',
      ]);
      expect(Object.isFrozen(decoded)).toBe(true);

      for (const contentType of [
        'application/json',
        'Application/Vnd.Maneeagent.Poll+Json',
        `${HTTP_SUBAGENT_POLL_MEDIA_TYPE}; charset=utf-8`,
        ` ${HTTP_SUBAGENT_POLL_MEDIA_TYPE}`,
      ]) {
        expect(() =>
          decodeHttpSubAgentPollCommand({ contentType, body: encodedSnapshot }),
        ).toThrow();
      }

      for (const malformed of [
        { body: encodedSnapshot },
        { contentType: HTTP_SUBAGENT_POLL_MEDIA_TYPE },
        { contentType: HTTP_SUBAGENT_POLL_MEDIA_TYPE, body: encodedSnapshot, extra: true },
      ]) {
        expect(() => decodeHttpSubAgentPollCommand(malformed as HttpSubAgentPollInput)).toThrow();
      }

      for (const malformedJson of [
        '{}',
        '[]',
        'null',
        '{"version":"1","channelId":"http-channel-1","channelGeneration":"7","ackCursor":"11","waitMs":250,"extra":true}',
        '{"version":"1","channelId":"http-channel-1","channelId":"shadow","channelGeneration":"7","ackCursor":"11","waitMs":250}',
      ]) {
        expect(() => decodePollBody(bytes(malformedJson))).toThrow();
      }

      expect(() => decodePollBody(Uint8Array.of(0xc3, 0x28))).toThrow();
      expect(() =>
        decodePollBody(Uint8Array.from([0xef, 0xbb, 0xbf, ...encodedSnapshot])),
      ).toThrow();
      expect(() => decodePollBody(new Uint8Array(HTTP_SUBAGENT_MAX_POLL_BODY_BYTES + 1))).toThrow();

      let accessorReads = 0;
      const accessorInput = {
        get contentType() {
          accessorReads += 1;
          return HTTP_SUBAGENT_POLL_MEDIA_TYPE;
        },
        body: encodedSnapshot,
      };
      const accessorCommand = {
        get version() {
          accessorReads += 1;
          return '1' as const;
        },
        channelId: POLL_COMMAND.channelId,
        channelGeneration: POLL_COMMAND.channelGeneration,
        ackCursor: POLL_COMMAND.ackCursor,
        waitMs: POLL_COMMAND.waitMs,
      };
      expect(() =>
        decodeHttpSubAgentPollCommand(accessorInput as unknown as HttpSubAgentPollInput),
      ).toThrow();
      expect(() =>
        encodeHttpSubAgentPollCommand(accessorCommand as unknown as HttpSubAgentPollCommand),
      ).toThrow();
      expect(accessorReads).toBe(0);

      const proxyInput = new Proxy(
        { contentType: HTTP_SUBAGENT_POLL_MEDIA_TYPE, body: encodedSnapshot },
        {
          get() {
            throw new Error('poll input Proxy trap must not run');
          },
        },
      );
      const proxyCommand = new Proxy(POLL_COMMAND, {
        get() {
          throw new Error('poll command Proxy trap must not run');
        },
      });
      expect(() => decodeHttpSubAgentPollCommand(proxyInput)).toThrow();
      expect(() => encodeHttpSubAgentPollCommand(proxyCommand)).toThrow();

      let bodyPrototypeTraps = 0;
      const hostileBody = encodedSnapshot.slice();
      Object.setPrototypeOf(
        hostileBody,
        new Proxy(Uint8Array.prototype, {
          getPrototypeOf() {
            bodyPrototypeTraps += 1;
            throw new Error('poll body prototype trap must not run');
          },
        }),
      );
      expect(decodePollBody(hostileBody)).toEqual(POLL_COMMAND);
      expect(bodyPrototypeTraps).toBe(0);

      const sparseBody = new Array<number>(encodedSnapshot.byteLength);
      sparseBody[0] = encodedSnapshot[0]!;
      expect(() =>
        decodeHttpSubAgentPollCommand({
          contentType: HTTP_SUBAGENT_POLL_MEDIA_TYPE,
          body: sparseBody as unknown as Uint8Array,
        }),
      ).toThrow();
      const sparseCommand = new Array<unknown>(5);
      sparseCommand[0] = HTTP_SUBAGENT_POLL_VERSION;
      expect(() =>
        encodeHttpSubAgentPollCommand(sparseCommand as unknown as HttpSubAgentPollCommand),
      ).toThrow();

      for (const unsafeCommand of [
        { ...POLL_COMMAND, extra: true },
        Object.assign(Object.create({ inherited: true }), POLL_COMMAND),
        { ...POLL_COMMAND, channelId: 'x'.repeat(129) },
      ]) {
        expect(() =>
          encodeHttpSubAgentPollCommand(unsafeCommand as HttpSubAgentPollCommand),
        ).toThrow();
      }
    },
  );

  acceptanceIt('C7C-HTTP-POLL02.l1.canonical-uint64-wait', 'uint64-and-long-poll-bounds', () => {
    assertNetworkDenyGuardInstalled();
    expect(HTTP_SUBAGENT_MAX_POLL_WAIT_MS).toBe(10_000);

    for (const field of ['channelGeneration', 'ackCursor'] as const) {
      for (const value of ['0', UINT64_MAX]) {
        const command = { ...POLL_COMMAND, [field]: value };
        expect(encodeHttpSubAgentPollCommand(command)).toMatchObject({
          contentType: HTTP_SUBAGENT_POLL_MEDIA_TYPE,
        });
        expect(decodeHttpSubAgentPollCommand(pollInput({ [field]: value }))[field]).toBe(value);
      }

      for (const value of ['+1', '-1', '01', '1.0', '1e0', '18446744073709551616']) {
        expect(() =>
          encodeHttpSubAgentPollCommand({
            ...POLL_COMMAND,
            [field]: value,
          }),
        ).toThrow();
        expect(() => decodeHttpSubAgentPollCommand(pollInput({ [field]: value }))).toThrow();
      }
    }

    for (const waitMs of [0, HTTP_SUBAGENT_MAX_POLL_WAIT_MS]) {
      const command = { ...POLL_COMMAND, waitMs };
      expect(decodeHttpSubAgentPollCommand(encodeHttpSubAgentPollCommand(command))).toEqual(
        command,
      );
    }

    for (const waitMs of [
      -1,
      HTTP_SUBAGENT_MAX_POLL_WAIT_MS + 1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '0',
      null,
      true,
    ]) {
      expect(() =>
        encodeHttpSubAgentPollCommand({
          ...POLL_COMMAND,
          waitMs: waitMs as number,
        }),
      ).toThrow();
      expect(() => decodeHttpSubAgentPollCommand(pollInput({ waitMs }))).toThrow();
    }
  });

  acceptanceIt(
    'C7C-HTTP-RECEIPT01.l1.semantic-delivery-receipt',
    'nonce-boundary-peer-sequence-invariant',
    () => {
      assertNetworkDenyGuardInstalled();
      const sidecarA = createSidecar('receipt-a', bytes('alpha'));
      const sidecarB = createSidecar('receipt-b', bytes('bravo'));
      const baseRoute = route(`/v1/jobs/${JOB_ID}/control/${CONTROL_REQUEST_ID}/reply`);
      const basePacket = createPacketForKind('control.reply', {
        correlationId: CONTROL_REQUEST_ID,
        sidecars: [sidecarA, sidecarB],
      });
      const receipt = createHttpSubAgentPacketSemanticReceipt({
        route: baseRoute,
        packet: basePacket,
      });
      expect(receipt).toMatch(/^[0-9a-f]{64}$/u);

      const multipartA = encodeHttpSubAgentMultipartPacket(basePacket, {
        boundary: 'receipt-boundary-a',
      });
      const multipartB = encodeHttpSubAgentMultipartPacket(basePacket, {
        boundary: 'receipt-boundary-b',
      });
      const roundTripA = decodeHttpSubAgentMultipartPacket(multipartA);
      const roundTripB = decodeHttpSubAgentMultipartPacket(multipartB);
      expect(multipartA.body).not.toEqual(multipartB.body);
      expect(
        createHttpSubAgentPacketSemanticReceipt({ route: baseRoute, packet: roundTripA }),
      ).toBe(receipt);
      expect(
        createHttpSubAgentPacketSemanticReceipt({ route: baseRoute, packet: roundTripB }),
      ).toBe(receipt);

      const hmacA = createHttpSubAgentHmacHeaders({
        method: 'POST',
        requestTarget: baseRoute.requestTarget,
        body: multipartA.body,
        keyId: HTTP_TEST_KEY_ID,
        key: HTTP_TEST_KEY,
        timestamp: HTTP_TEST_NOW,
        nonce: nonce(201),
      });
      const hmacB = createHttpSubAgentHmacHeaders({
        method: 'POST',
        requestTarget: baseRoute.requestTarget,
        body: multipartB.body,
        keyId: HTTP_TEST_KEY_ID,
        key: HTTP_TEST_KEY,
        timestamp: HTTP_TEST_NOW,
        nonce: nonce(202),
      });
      expect(hmacA).not.toEqual(hmacB);
      expect(hmacA['Manee-Nonce']).not.toBe(hmacB['Manee-Nonce']);
      expect(
        createHttpSubAgentPacketSemanticReceipt({ route: baseRoute, packet: roundTripA }),
      ).toBe(createHttpSubAgentPacketSemanticReceipt({ route: baseRoute, packet: roundTripB }));

      const equivalentPackets: ReadonlyArray<{
        readonly route: HttpSubAgentRoute;
        readonly packet: SubAgentTransportPeerPacket;
      }> = [
        {
          route: baseRoute,
          packet: createPacketForKind('control.reply', {
            channelId: 'http-peer-channel-2',
            correlationId: CONTROL_REQUEST_ID,
            sidecars: [sidecarA, sidecarB],
          }),
        },
        {
          route: baseRoute,
          packet: createPacketForKind('control.reply', {
            sequence: 4_096,
            correlationId: CONTROL_REQUEST_ID,
            sidecars: [sidecarA, sidecarB],
          }),
        },
        {
          route: baseRoute,
          packet: createPacketForKind('control.reply', {
            messageId: 'http-message:retried-delivery',
            correlationId: CONTROL_REQUEST_ID,
            sidecars: [sidecarA, sidecarB],
          }),
        },
        {
          route: route(`/v1/jobs/${JOB_ID}/control/http-control-request-2/reply`),
          packet: createPacketForKind('control.reply', {
            correlationId: 'http-control-request-2',
            sidecars: [sidecarA, sidecarB],
          }),
        },
        {
          route: baseRoute,
          packet: createPacketForKind('control.reply', {
            correlationId: CONTROL_REQUEST_ID,
            sidecars: [sidecarB, sidecarA],
          }),
        },
      ];
      for (const equivalent of equivalentPackets) {
        expect(createHttpSubAgentPacketSemanticReceipt(equivalent)).toBe(receipt);
      }

      const changedReceipts = [
        createHttpSubAgentPacketSemanticReceipt({
          route: baseRoute,
          packet: createPacketForKind('control.reply', {
            taskId: 'http-task-2',
            correlationId: CONTROL_REQUEST_ID,
            sidecars: [sidecarA, sidecarB],
          }),
        }),
        createHttpSubAgentPacketSemanticReceipt({
          route: baseRoute,
          packet: createPacketForKind('control.reply', {
            operationId: 'http-operation-2',
            correlationId: CONTROL_REQUEST_ID,
            sidecars: [sidecarA, sidecarB],
          }),
        }),
        createHttpSubAgentPacketSemanticReceipt({
          route: baseRoute,
          packet: createPacketForKind('protocol.error', {
            correlationId: CONTROL_REQUEST_ID,
            sidecars: [sidecarA, sidecarB],
          }),
        }),
        createHttpSubAgentPacketSemanticReceipt({
          route: baseRoute,
          packet: createCorePacket(
            'control.reply',
            {
              method: 'execution.reportProgress',
              ok: false,
              error: {
                code: 'EXECUTOR_FAILED',
                message: 'The progress update failed.',
                retryable: false,
              },
            },
            {
              correlationId: CONTROL_REQUEST_ID,
              sidecars: [sidecarA, sidecarB],
            },
          ),
        }),
        createHttpSubAgentPacketSemanticReceipt({
          route: route(`/v1/jobs/http-job-2/control/${CONTROL_REQUEST_ID}/reply`),
          packet: basePacket,
        }),
        createHttpSubAgentPacketSemanticReceipt({
          route: baseRoute,
          packet: createPacketForKind('control.reply', {
            correlationId: CONTROL_REQUEST_ID,
            sidecars: [createSidecar('receipt-a', bytes('alpha changed')), sidecarB],
          }),
        }),
      ];
      for (const changed of changedReceipts) expect(changed).not.toBe(receipt);
      expect(new Set(changedReceipts).size).toBe(changedReceipts.length);

      expect(() =>
        createHttpSubAgentPacketSemanticReceipt({
          route: baseRoute,
          packet: basePacket,
          nonce: 'transport-nonce-is-outside-the-semantic-receipt',
        } as unknown as Parameters<typeof createHttpSubAgentPacketSemanticReceipt>[0]),
      ).toThrow();
    },
  );

  acceptanceIt('C7C-HTTP-ROUTE01.l1.closed-route-kind-policy', 'route-operation-kind-table', () => {
    assertNetworkDenyGuardInstalled();
    const routes = {
      heartbeat: route('/v1/heartbeat'),
      create: route('/v1/jobs/create'),
      resume: route(`/v1/jobs/${JOB_ID}/resume`),
      reconnect: route(`/v1/jobs/${JOB_ID}/reconnect`),
      cancel: route(`/v1/jobs/${JOB_ID}/cancel`),
      poll: route(`/v1/jobs/${JOB_ID}/poll`),
      controlReply: route(`/v1/jobs/${JOB_ID}/control/${CONTROL_REQUEST_ID}/reply`),
    } as const;

    expectRouteRejected(routes.heartbeat, createPacketForKind('snapshot.request'));

    const operationPolicies = [
      { route: routes.create, operation: 'create', mode: 'execute', accepted: true },
      { route: routes.create, operation: 'create', mode: 'spawn', accepted: true },
      { route: routes.create, operation: 'resume', mode: 'execute', accepted: false },
      { route: routes.create, operation: 'resume', mode: 'spawn', accepted: false },
      { route: routes.create, operation: 'reconnect', mode: 'execute', accepted: false },
      { route: routes.create, operation: 'reconnect', mode: 'spawn', accepted: false },
      { route: routes.resume, operation: 'create', mode: 'execute', accepted: false },
      { route: routes.resume, operation: 'create', mode: 'spawn', accepted: false },
      { route: routes.resume, operation: 'resume', mode: 'execute', accepted: true },
      { route: routes.resume, operation: 'resume', mode: 'spawn', accepted: false },
      { route: routes.resume, operation: 'reconnect', mode: 'execute', accepted: false },
      { route: routes.resume, operation: 'reconnect', mode: 'spawn', accepted: false },
      { route: routes.reconnect, operation: 'create', mode: 'execute', accepted: false },
      { route: routes.reconnect, operation: 'create', mode: 'spawn', accepted: false },
      { route: routes.reconnect, operation: 'resume', mode: 'execute', accepted: false },
      { route: routes.reconnect, operation: 'resume', mode: 'spawn', accepted: false },
      { route: routes.reconnect, operation: 'reconnect', mode: 'execute', accepted: false },
      { route: routes.reconnect, operation: 'reconnect', mode: 'spawn', accepted: true },
    ] as const;
    for (const policy of operationPolicies) {
      const packet = createExecutorRequestPacket(policy.operation, policy.mode);
      if (policy.accepted) expectRouteAccepted(policy.route, packet);
      else expectRouteRejected(policy.route, packet);
    }

    expectRouteAccepted(routes.cancel, createPacketForKind('cancel.request'));
    expectRouteAccepted(routes.poll, createPacketForKind('snapshot.request'));
    expectRouteAccepted(routes.poll, createPacketForKind('events.request'));

    const controlReplyKinds = new Set<SubAgentTransportRpcKind>([
      'control.reply',
      'model.reply',
      'events.page',
      'protocol.error',
    ]);
    for (const kind of controlReplyKinds) {
      expectRouteAccepted(
        routes.controlReply,
        createPacketForKind(kind, { correlationId: CONTROL_REQUEST_ID }),
      );
      expectRouteRejected(
        routes.controlReply,
        createPacketForKind(kind, { correlationId: 'wrong-control-request' }),
      );
    }

    const baselinePackets = Object.fromEntries(
      SUBAGENT_TRANSPORT_RPC_KINDS.map((kind) => [
        kind,
        createPacketForKind(kind, { correlationId: CONTROL_REQUEST_ID }),
      ]),
    ) as Record<SubAgentTransportRpcKind, SubAgentTransportPeerPacket>;
    const routeKindPolicies: ReadonlyArray<{
      readonly route: HttpSubAgentRoute;
      readonly allowed: ReadonlySet<SubAgentTransportRpcKind>;
    }> = [
      { route: routes.create, allowed: new Set(['executor.request']) },
      { route: routes.resume, allowed: new Set() },
      { route: routes.reconnect, allowed: new Set() },
      { route: routes.cancel, allowed: new Set(['cancel.request']) },
      {
        route: routes.poll,
        allowed: new Set(['snapshot.request', 'events.request']),
      },
      { route: routes.controlReply, allowed: controlReplyKinds },
    ];
    for (const policy of routeKindPolicies) {
      for (const kind of SUBAGENT_TRANSPORT_RPC_KINDS) {
        if (policy.allowed.has(kind)) expectRouteAccepted(policy.route, baselinePackets[kind]);
        else expectRouteRejected(policy.route, baselinePackets[kind]);
      }
    }

    const owned = decodeHttpSubAgentRoutedPacket(
      routes.poll,
      createPacketForKind('events.request'),
    );
    expect(owned.route).toEqual(routes.poll);
    expect(owned.envelope.kind).toBe('events.request');
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.packet)).toBe(true);
    expect(Object.isFrozen(owned.packet.sidecars)).toBe(true);

    expectRouteRejected(
      { ...routes.poll, id: 'jobs.cancel' } as HttpSubAgentRoute,
      createPacketForKind('events.request'),
    );
    expectRouteRejected(
      {
        ...routes.poll,
        requestTarget: `/v1/jobs/${JOB_ID}/cancel`,
      } as HttpSubAgentRoute,
      createPacketForKind('events.request'),
    );
    expectRouteRejected(
      { ...routes.poll, unexpected: true } as unknown as HttpSubAgentRoute,
      createPacketForKind('events.request'),
    );

    let frameProxyTraps = 0;
    const proxiedFrame = new Proxy(new Uint8Array([0x7b, 0x7d]), {
      getPrototypeOf() {
        frameProxyTraps += 1;
        throw new Error('routed frame Proxy trap must not run');
      },
    });
    expectRouteRejected(routes.poll, {
      ...createPacketForKind('events.request'),
      frame: proxiedFrame,
    });
    expect(frameProxyTraps).toBe(0);

    let bytePrototypeTraps = 0;
    const eventsPacket = createPacketForKind('events.request');
    const frameBytes = bytes(
      typeof eventsPacket.frame === 'string'
        ? eventsPacket.frame
        : new TextDecoder().decode(eventsPacket.frame),
    );
    Object.setPrototypeOf(
      frameBytes,
      new Proxy(Uint8Array.prototype, {
        getPrototypeOf() {
          bytePrototypeTraps += 1;
          throw new Error('routed byte prototype trap must not run');
        },
      }),
    );
    expectRouteAccepted(routes.poll, { ...eventsPacket, frame: frameBytes });

    const sidecar = createSidecar('hostile-sidecar-data', bytes('sidecar bytes'));
    const sidecarData = sidecar.data.slice();
    Object.setPrototypeOf(
      sidecarData,
      new Proxy(Uint8Array.prototype, {
        getPrototypeOf() {
          bytePrototypeTraps += 1;
          throw new Error('routed byte prototype trap must not run');
        },
      }),
    );
    expectRouteAccepted(routes.poll, {
      ...createPacketForKind('events.request', { sidecars: [{ ...sidecar, data: sidecarData }] }),
    });
    expect(bytePrototypeTraps).toBe(0);
  });
});
