import { runInNewContext } from 'node:vm';

import { describe, expect } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import {
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
  canonicalJsonSha256,
  createSubAgentTransportRpcEnvelope,
  decodeSubAgentTransportRpcFrame,
  encodeSubAgentTransportRpcFrame,
  type CreateSubAgentTransportRpcEnvelopeInput,
  type JsonValue,
  type SubAgentExecutorBinding,
  type SubAgentTransportArtifactSidecar,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportRpcKind,
} from '@ruixutong.manee/maneeagent-framework';

import {
  HTTP_SUBAGENT_DELIVERY_RESPONSE_CACHE_CONTROL,
  HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE,
  HTTP_SUBAGENT_DELIVERY_RESPONSE_VERSION,
  HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
  HTTP_SUBAGENT_JOB_DELIVERY_VERSION,
  HTTP_SUBAGENT_MAX_MULTIPART_BODY_BYTES,
  HTTP_SUBAGENT_MAX_PACKET_JSON_BYTES,
  HTTP_SUBAGENT_MAX_PART_HEADER_BYTES,
  HTTP_SUBAGENT_PACKET_VERSION,
  createHttpSubAgentHmacHeaders,
  createHttpSubAgentPollRequestReceipt,
  decodeHttpSubAgentDeliveryResponse,
  encodeHttpSubAgentDeliveryResponse,
  parseHttpSubAgentRoute,
  type HttpSubAgentDeliveryResponseEncodeInput,
  type HttpSubAgentDeliveryResponseEncodeOptions,
  type HttpSubAgentDeliveryResponseInput,
  type HttpSubAgentDeliveryResponseLimits,
  type HttpSubAgentEncodedDeliveryResponse,
  type HttpSubAgentJobPollOutboundResult,
  type HttpSubAgentPollCommand,
  type HttpSubAgentPollRoute,
} from '../src/index';
import {
  HTTP_TEST_KEY,
  HTTP_TEST_KEY_ID,
  HTTP_TEST_NOW,
  bytes,
  concatBytes,
  createSidecar,
  multipartBoundary,
  nonce,
  packetJson,
  replaceBytes,
  replacePacketJson,
  text,
} from './http-security-fixture';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const JOB_ID = 'http-delivery-wire-job-1';
const CHANNEL_ID = 'http-delivery-wire-channel-1';
const TASK_ID = 'http-delivery-wire-task-1';
const OPERATION_ID = 'http-delivery-wire-operation-1';
const CONTROL_REQUEST_ID = 'http-delivery-wire-control-1';
const OWNER_SESSION_ID = 'http-delivery-wire-owner-1';
const UINT64_MAX = '18446744073709551615';
const TEXT_ENCODER = new TextEncoder();

const TARGET_TO_CONTROLLER_KINDS = Object.freeze([
  'executor.accepted',
  'executor.settled',
  'cancel.ack',
  'snapshot.reply',
  'events.page',
  'control.request',
  'model.request',
  'events.request',
  'protocol.error',
] as const satisfies readonly SubAgentTransportRpcKind[]);

const REQUEST_KINDS = new Set<SubAgentTransportRpcKind>([
  'executor.request',
  'control.request',
  'cancel.request',
  'snapshot.request',
  'events.request',
  'model.request',
]);

interface PacketOptions {
  readonly channelId?: string;
  readonly sequence?: number;
  readonly messageId?: string;
  readonly correlationId?: string;
  readonly taskId?: string;
  readonly operationId?: string;
  readonly sidecars?: readonly SubAgentTransportArtifactSidecar[];
  readonly frameAsBytes?: boolean;
}

interface ResultOptions {
  readonly command?: HttpSubAgentPollCommand;
  readonly packet?: SubAgentTransportPeerPacket;
  readonly revision?: string;
  readonly channelId?: string;
  readonly channelGeneration?: string;
  readonly ackCursor?: string;
  readonly cursor?: string;
  readonly packetReceipt?: string;
}

interface DeliveryWirePacketJson {
  readonly version: string;
  readonly frame: string;
  readonly sidecars: readonly Record<string, unknown>[];
}

interface DeliveryWireJson {
  readonly version: string;
  readonly requestReceipt: string;
  readonly revision: string;
  readonly channelId: string;
  readonly channelGeneration: string;
  readonly ackCursor: string;
  readonly delivery: null | Readonly<{
    cursor: string;
    packetReceipt: string;
    packet: DeliveryWirePacketJson;
  }>;
}

function createPollRoute(jobId = JOB_ID): HttpSubAgentPollRoute {
  const route = parseHttpSubAgentRoute('POST', `/v1/jobs/${jobId}/poll`);
  if (route.id !== 'jobs.poll') throw new Error('Expected a jobs.poll route fixture.');
  return Object.freeze({
    id: 'jobs.poll',
    requestTarget: route.requestTarget,
    jobId: route.jobId,
  });
}

const POLL_ROUTE = createPollRoute();
const POLL_COMMAND = Object.freeze({
  version: '1',
  channelId: CHANNEL_ID,
  channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
  ackCursor: '4',
  waitMs: 250,
}) satisfies HttpSubAgentPollCommand;

function pollCommand(overrides: Partial<HttpSubAgentPollCommand> = {}): HttpSubAgentPollCommand {
  return { ...POLL_COMMAND, ...overrides };
}

function createBinding(taskId = TASK_ID): SubAgentExecutorBinding {
  return Object.freeze({
    version: '1',
    executorName: 'http',
    ownerSessionId: OWNER_SESSION_ID,
    taskId,
    subagentSessionId: `http-delivery-wire-session:${taskId}`,
    definitionName: 'researcher',
    definitionVersion: '2',
    runnerId: 'http-delivery-wire-runner-1',
    runnerVersion: '1',
    adapterStateVersion: '1',
    recoveryData: Object.freeze({ kind: 'http-delivery-wire/v1', jobId: JOB_ID }),
  });
}

function createPacket(
  kind: SubAgentTransportRpcKind,
  payload: unknown,
  options: PacketOptions = {},
): SubAgentTransportPeerPacket {
  const input = {
    channelId: options.channelId ?? CHANNEL_ID,
    sequence: options.sequence ?? 17,
    messageId: options.messageId ?? `http-delivery-message:${kind}`,
    ...(!REQUEST_KINDS.has(kind)
      ? { correlationId: options.correlationId ?? CONTROL_REQUEST_ID }
      : {}),
    taskId: options.taskId ?? TASK_ID,
    operationId: options.operationId ?? OPERATION_ID,
    kind,
    payload,
  } as unknown as CreateSubAgentTransportRpcEnvelopeInput;
  const frame = encodeSubAgentTransportRpcFrame(createSubAgentTransportRpcEnvelope(input));
  return Object.freeze({
    frame: options.frameAsBytes === true ? TEXT_ENCODER.encode(frame) : frame,
    sidecars: Object.freeze([...(options.sidecars ?? [])]),
  });
}

function createTargetPacket(
  kind: (typeof TARGET_TO_CONTROLLER_KINDS)[number],
  options: PacketOptions = {},
): SubAgentTransportPeerPacket {
  const taskId = options.taskId ?? TASK_ID;
  const operationId = options.operationId ?? OPERATION_ID;
  const binding = createBinding(taskId);
  switch (kind) {
    case 'executor.accepted':
      return createPacket(kind, { mode: 'spawn', binding }, options);
    case 'executor.settled':
      return createPacket(
        kind,
        {
          mode: 'execute',
          outcome: {
            type: 'terminal',
            result: {
              status: 'succeeded',
              task: { taskId, subAgent: { name: 'researcher', version: '2' } },
              executor: 'http',
              output: { proof: 'delivery-wire' },
              usage: { turns: 2, providerCalls: 1 },
            },
          },
        },
        options,
      );
    case 'cancel.ack':
      return createPacket(kind, { cancelled: true }, options);
    case 'snapshot.reply':
      return createPacket(
        kind,
        {
          mode: 'snapshot',
          snapshot: { taskId, state: 'running', binding, updatedAt: HTTP_TEST_NOW },
        },
        options,
      );
    case 'events.page':
      return createPacket(kind, { events: [], nextSequence: 0, done: true }, options);
    case 'control.request':
      return createPacket(
        kind,
        {
          executionAttempt: 1,
          executionEpoch: 'http-delivery-wire-epoch-1',
          executionFencingToken: '1',
          method: 'execution.reportProgress',
          args: { update: { message: 'halfway', percent: 50 } },
        },
        options,
      );
    case 'model.request':
      return createPacket(
        kind,
        {
          providerOperationId: operationId,
          gatewayId: 'http-delivery-wire-gateway-1',
          protocol: 'openai-chat',
          codecVersion: '1',
          runId: 'http-delivery-wire-run-1',
          executionAttempt: 1,
          executionEpoch: 'http-delivery-wire-epoch-1',
          executionFencingToken: '1',
          checkpointOperationId: 'http-delivery-wire-checkpoint-1',
          checkpointDigest: 'c'.repeat(64),
          purpose: 'agent',
          iteration: 1,
          requestAttempt: 1,
          requestHash: 'a'.repeat(64),
          context: [{ role: 'user', content: 'verify delivery response' }],
          tools: [],
          remainingMs: 30_000,
        },
        options,
      );
    case 'events.request':
      return createPacket(kind, { afterSequence: 0, limit: 32 }, options);
    case 'protocol.error':
      return createPacket(
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

function packetReceipt(packet: SubAgentTransportPeerPacket): string {
  const envelope = decodeSubAgentTransportRpcFrame(packet.frame);
  const descriptors = [...packet.sidecars.map((sidecar) => sidecar.descriptor)].sort(
    (left, right) =>
      left.sidecarId < right.sidecarId ? -1 : left.sidecarId > right.sidecarId ? 1 : 0,
  );
  return canonicalJsonSha256({
    version: '1',
    rpc: envelope,
    sidecarDescriptorsSortedBySidecarId: descriptors,
  } as unknown as JsonValue);
}

function createResult(options: ResultOptions = {}): HttpSubAgentJobPollOutboundResult {
  const command = options.command ?? POLL_COMMAND;
  const packet = options.packet;
  return {
    deliveryVersion: HTTP_SUBAGENT_JOB_DELIVERY_VERSION,
    revision: options.revision ?? '9',
    channelId: options.channelId ?? command.channelId,
    channelGeneration: (options.channelGeneration ??
      command.channelGeneration) as typeof HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
    ackCursor: options.ackCursor ?? command.ackCursor,
    delivery:
      packet === undefined
        ? null
        : {
            cursor: options.cursor ?? String(BigInt(command.ackCursor) + 1n),
            packetReceipt: options.packetReceipt ?? packetReceipt(packet),
            packet,
          },
  };
}

function encodeResponse(
  result: HttpSubAgentJobPollOutboundResult,
  command: HttpSubAgentPollCommand = POLL_COMMAND,
  route: HttpSubAgentPollRoute = POLL_ROUTE,
  options: HttpSubAgentDeliveryResponseEncodeOptions = {},
): HttpSubAgentEncodedDeliveryResponse {
  return encodeHttpSubAgentDeliveryResponse({ route, command, result }, options);
}

function decodeResponse(
  encoded: HttpSubAgentEncodedDeliveryResponse,
  command: HttpSubAgentPollCommand = POLL_COMMAND,
  route: HttpSubAgentPollRoute = POLL_ROUTE,
  limits: HttpSubAgentDeliveryResponseLimits = {},
) {
  return decodeHttpSubAgentDeliveryResponse({ route, command, ...encoded }, limits);
}

function parseDeliveryJson(encoded: HttpSubAgentEncodedDeliveryResponse): DeliveryWireJson {
  return JSON.parse(packetJson(encoded)) as DeliveryWireJson;
}

function replaceDeliveryJson(
  encoded: HttpSubAgentEncodedDeliveryResponse,
  replacement: string,
): HttpSubAgentEncodedDeliveryResponse {
  const replaced = replacePacketJson(encoded, replacement);
  return { ...encoded, ...replaced };
}

function multipartSegments(encoded: HttpSubAgentEncodedDeliveryResponse): readonly string[] {
  return text(encoded.body).split(`--${multipartBoundary(encoded.contentType)}`);
}

function withMultipartSegments(
  encoded: HttpSubAgentEncodedDeliveryResponse,
  segments: readonly string[],
): HttpSubAgentEncodedDeliveryResponse {
  const boundary = multipartBoundary(encoded.contentType);
  return { ...encoded, body: bytes(segments.join(`--${boundary}`)) };
}

function expectDecodeRejected(
  encoded: HttpSubAgentEncodedDeliveryResponse,
  command: HttpSubAgentPollCommand = POLL_COMMAND,
  route: HttpSubAgentPollRoute = POLL_ROUTE,
  limits: HttpSubAgentDeliveryResponseLimits = {},
): void {
  expect(() => decodeResponse(encoded, command, route, limits)).toThrow(
    'HTTP delivery response is invalid.',
  );
}

function dataCloneWithAccessor<T extends object>(value: T, field: keyof T, onRead: () => void): T {
  const descriptors = Object.getOwnPropertyDescriptors(value) as PropertyDescriptorMap;
  descriptors[String(field)] = {
    configurable: true,
    enumerable: true,
    get() {
      onRead();
      return Reflect.get(value, field);
    },
  };
  return Object.defineProperties({}, descriptors) as T;
}

function nullRecord<T extends object>(value: T): T {
  return Object.assign(Object.create(null) as object, value) as T;
}

describe('HTTP job delivery response wire', () => {
  acceptanceIt(
    'C7C-HTTP-DELIVERY01.l1.closed-response-envelope',
    'empty-nonempty-owned-frozen-roundtrip',
    () => {
      assertNetworkDenyGuardInstalled();
      expect(HTTP_SUBAGENT_DELIVERY_RESPONSE_VERSION).toBe('1');
      expect(HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE).toBe(
        'application/vnd.maneeagent.delivery+json',
      );
      expect(HTTP_SUBAGENT_DELIVERY_RESPONSE_CACHE_CONTROL).toBe('no-store');
      expect(HTTP_SUBAGENT_JOB_DELIVERY_VERSION).toBe('1');
      expect(HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION).toBe('0');
      expect(HTTP_SUBAGENT_PACKET_VERSION).toBe('1');

      const requestReceipt = createHttpSubAgentPollRequestReceipt({
        route: POLL_ROUTE,
        command: POLL_COMMAND,
      });
      const emptyResult = createResult();
      const empty = encodeResponse(emptyResult, POLL_COMMAND, POLL_ROUTE, {
        boundary: 'delivery-empty',
      });
      const emptyJson = JSON.stringify({
        version: '1',
        requestReceipt,
        revision: '9',
        channelId: CHANNEL_ID,
        channelGeneration: '0',
        ackCursor: '4',
        delivery: null,
      });
      expect(Object.keys(empty)).toEqual(['status', 'contentType', 'cacheControl', 'body']);
      expect(empty.status).toBe(200);
      expect(empty.contentType).toBe('multipart/mixed; boundary=delivery-empty');
      expect(empty.cacheControl).toBe('no-store');
      expect(Object.isFrozen(empty)).toBe(true);
      expect(packetJson(empty)).toBe(emptyJson);
      expect(text(empty.body)).toBe(
        [
          '--delivery-empty\r\n',
          `Content-Type: ${HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE}\r\n\r\n`,
          emptyJson,
          '\r\n--delivery-empty--\r\n',
        ].join(''),
      );

      const decodedEmpty = decodeResponse(empty);
      expect(decodedEmpty).toEqual({
        version: '1',
        requestReceipt,
        revision: '9',
        channelId: CHANNEL_ID,
        channelGeneration: '0',
        ackCursor: '4',
        delivery: null,
      });
      expect(Object.keys(decodedEmpty)).toEqual([
        'version',
        'requestReceipt',
        'revision',
        'channelId',
        'channelGeneration',
        'ackCursor',
        'delivery',
      ]);
      expect(Object.isFrozen(decodedEmpty)).toBe(true);

      const randomBoundaryResponse = encodeResponse(emptyResult);
      expect(randomBoundaryResponse.contentType).toMatch(
        /^multipart\/mixed; boundary=manee-[A-Za-z0-9_-]{32}$/u,
      );
      expect(decodeResponse(randomBoundaryResponse)).toEqual(decodedEmpty);

      for (const invalid of [
        { ...empty, status: 199 },
        { ...empty, status: 201 },
        { ...empty, cacheControl: 'private, no-store' },
        { ...empty, cacheControl: 'No-Store' },
        { ...empty, contentType: HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE },
        { ...empty, contentType: `${empty.contentType}; charset=utf-8` },
        { ...empty, unexpected: true },
      ]) {
        expect(() =>
          decodeHttpSubAgentDeliveryResponse({
            route: POLL_ROUTE,
            command: POLL_COMMAND,
            ...invalid,
          } as HttpSubAgentDeliveryResponseInput),
        ).toThrow('HTTP delivery response is invalid.');
      }

      const sourceSidecar = createSidecar('delivery-owned-sidecar', bytes('OWNED-DELIVERY-BYTES'));
      const sourcePacket = createTargetPacket('cancel.ack', {
        frameAsBytes: true,
        sidecars: [sourceSidecar],
      });
      const sourceResult = createResult({ packet: sourcePacket });
      const nonempty = encodeResponse(sourceResult, POLL_COMMAND, POLL_ROUTE, {
        boundary: 'delivery-nonempty',
      });
      const bodyBeforeSourceMutation = nonempty.body.slice();
      sourceSidecar.data.fill(0);
      if (sourcePacket.frame instanceof Uint8Array) sourcePacket.frame.fill(0);
      expect(nonempty.body).toEqual(bodyBeforeSourceMutation);
      expect(nonempty.status).toBe(200);
      expect(nonempty.cacheControl).toBe('no-store');
      expect(nonempty.contentType).toBe('multipart/mixed; boundary=delivery-nonempty');

      const decodeBody = nonempty.body.slice();
      const decodedNonempty = decodeResponse({ ...nonempty, body: decodeBody });
      decodeBody.fill(0);
      if (decodedNonempty.delivery === null) throw new Error('Expected one delivery.');
      expect(decodedNonempty.delivery.cursor).toBe('5');
      expect(decodedNonempty.delivery.packetReceipt).toBe(sourceResult.delivery?.packetReceipt);
      expect(decodedNonempty.delivery.packet.sidecars[0]?.data).toEqual(
        bytes('OWNED-DELIVERY-BYTES'),
      );
      expect(typeof decodedNonempty.delivery.packet.frame).toBe('string');
      expect(Object.isFrozen(decodedNonempty)).toBe(true);
      expect(Object.isFrozen(decodedNonempty.delivery)).toBe(true);
      expect(Object.isFrozen(decodedNonempty.delivery.packet)).toBe(true);
      expect(Object.isFrozen(decodedNonempty.delivery.packet.sidecars)).toBe(true);
      expect(Object.isFrozen(decodedNonempty.delivery.packet.sidecars[0])).toBe(true);
      expect(Object.isFrozen(decodedNonempty.delivery.packet.sidecars[0]?.descriptor)).toBe(true);

      const firstOwnedBytes = decodedNonempty.delivery.packet.sidecars[0]!.data;
      firstOwnedBytes.fill(0);
      const decodedAgain = decodeResponse(nonempty);
      if (decodedAgain.delivery === null) throw new Error('Expected the replayed delivery.');
      expect(decodedAgain.delivery.packet.sidecars[0]?.data).toEqual(bytes('OWNED-DELIVERY-BYTES'));
      expect(decodedAgain.delivery.packet.sidecars[0]?.data).not.toBe(firstOwnedBytes);

      nonempty.body.fill(0);
      const freshPacket = createTargetPacket('cancel.ack', {
        frameAsBytes: true,
        sidecars: [createSidecar('delivery-owned-sidecar', bytes('OWNED-DELIVERY-BYTES'))],
      });
      const freshEncoded = encodeResponse(
        createResult({ packet: freshPacket }),
        POLL_COMMAND,
        POLL_ROUTE,
        { boundary: 'delivery-nonempty' },
      );
      expect(freshEncoded.body).toEqual(bodyBeforeSourceMutation);
      expect(freshEncoded.body).not.toBe(nonempty.body);
    },
  );

  acceptanceIt(
    'C7C-HTTP-DELIVERY02.l2.multipart-sidecar-integrity',
    'exact-headers-order-digest-and-bounds',
    () => {
      assertNetworkDenyGuardInstalled();
      expect(DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
      expect(DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH).toBe(128);
      expect(DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES).toBe(1_000_000);
      expect(DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES).toBe(32 * 1024 * 1024);
      expect(DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS).toBe(8);
      expect(DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES).toBe(128 * 1024 * 1024);
      expect(HTTP_SUBAGENT_MAX_MULTIPART_BODY_BYTES).toBe(161 * 1024 * 1024);
      expect(HTTP_SUBAGENT_MAX_PACKET_JSON_BYTES).toBe(32 * 1024 * 1024 + 64 * 1024);
      expect(HTTP_SUBAGENT_MAX_PART_HEADER_BYTES).toBe(16 * 1024);

      const sidecarB = createSidecar('delivery-integrity-b', bytes('BRAVO'));
      const sidecarA = createSidecar('delivery-integrity-a', bytes('ALPHA'));
      const packet = createTargetPacket('cancel.ack', { sidecars: [sidecarB, sidecarA] });
      const result = createResult({ packet });
      const encoded = encodeResponse(result, POLL_COMMAND, POLL_ROUTE, {
        boundary: 'delivery-integrity',
      });
      const json = packetJson(encoded);
      expect(text(encoded.body)).toBe(
        [
          '--delivery-integrity\r\n',
          `Content-Type: ${HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE}\r\n\r\n`,
          json,
          '\r\n--delivery-integrity\r\n',
          'Content-Type: application/octet-stream\r\n',
          'Content-ID: delivery-integrity-b\r\n\r\n',
          'BRAVO',
          '\r\n--delivery-integrity\r\n',
          'Content-Type: application/octet-stream\r\n',
          'Content-ID: delivery-integrity-a\r\n\r\n',
          'ALPHA',
          '\r\n--delivery-integrity--\r\n',
        ].join(''),
      );
      const decoded = decodeResponse(encoded);
      expect(
        decoded.delivery?.packet.sidecars.map((sidecar) => sidecar.descriptor.sidecarId),
      ).toEqual(['delivery-integrity-b', 'delivery-integrity-a']);
      expect(decoded.delivery?.packet.sidecars.map((sidecar) => text(sidecar.data))).toEqual([
        'BRAVO',
        'ALPHA',
      ]);

      const segments = multipartSegments(encoded);
      expect(segments).toHaveLength(5);
      for (const invalidSegments of [
        [segments[0]!, segments[1]!, segments[2]!, segments[4]!],
        [segments[0]!, segments[1]!, segments[2]!, segments[3]!, segments[3]!, segments[4]!],
        [segments[0]!, segments[1]!, segments[3]!, segments[2]!, segments[4]!],
      ]) {
        expectDecodeRejected(withMultipartSegments(encoded, invalidSegments));
      }

      const headerMutations = [
        [
          `Content-Type: ${HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE}`,
          'Content-Type: application/json',
        ],
        [
          `Content-Type: ${HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE}`,
          `content-type: ${HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE}`,
        ],
        ['Content-Type: application/octet-stream', 'Content-Type: text/plain'],
        ['Content-Type: application/octet-stream', 'content-type: application/octet-stream'],
        ['Content-ID: delivery-integrity-b', 'Content-Id: delivery-integrity-b'],
        ['Content-ID: delivery-integrity-b', 'Content-ID: unknown-delivery-sidecar'],
        [
          'Content-Type: application/octet-stream\r\nContent-ID: delivery-integrity-b',
          'Content-ID: delivery-integrity-b\r\nContent-Type: application/octet-stream',
        ],
        [
          'Content-Type: application/octet-stream',
          'Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64',
        ],
        [
          'Content-Type: application/octet-stream',
          'Content-Type: application/octet-stream\r\nX-Unknown-Part-Header: rejected',
        ],
        [
          `Content-Type: ${HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE}\r\n\r\n`,
          `Content-Type: ${HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE}` +
            '\r\nX-Unknown: rejected\r\n\r\n',
        ],
      ] as const;
      for (const [search, replacement] of headerMutations) {
        expectDecodeRejected({
          ...encoded,
          body: replaceBytes(encoded.body, search, replacement),
        });
      }

      for (const [search, replacement] of [
        ['Content-ID: delivery-integrity-b\r\n', ''],
        [
          'Content-ID: delivery-integrity-b\r\n',
          'Content-ID: delivery-integrity-b\r\nContent-ID: delivery-integrity-b\r\n',
        ],
        ['Content-Type: application/octet-stream\r\n', ''],
        ['\r\n\r\nBRAVO', '\n\nBRAVO'],
        ['\r\n--delivery-integrity--\r\n', '\r\n--delivery-integrity--'],
      ] as const) {
        expectDecodeRejected({
          ...encoded,
          body: replaceBytes(encoded.body, search, replacement),
        });
      }
      expectDecodeRejected({ ...encoded, body: concatBytes(encoded.body, bytes('epilogue')) });
      expectDecodeRejected({
        ...encoded,
        body: replaceBytes(encoded.body, 'BRAVO', 'XRAVO'),
      });

      const document = parseDeliveryJson(encoded);
      if (document.delivery === null) throw new Error('Expected a non-empty delivery document.');
      const delivery = document.delivery;
      expect(Object.keys(document)).toEqual([
        'version',
        'requestReceipt',
        'revision',
        'channelId',
        'channelGeneration',
        'ackCursor',
        'delivery',
      ]);
      expect(Object.keys(delivery)).toEqual(['cursor', 'packetReceipt', 'packet']);
      expect(Object.keys(delivery.packet)).toEqual(['version', 'frame', 'sidecars']);
      expect(delivery.packet.version).toBe(HTTP_SUBAGENT_PACKET_VERSION);
      const firstDescriptor = delivery.packet.sidecars[0]!;
      const secondDescriptor = delivery.packet.sidecars[1]!;
      const missingPartDescriptor = createSidecar(
        'delivery-integrity-missing-part',
        bytes('MISSING'),
      ).descriptor as unknown as Record<string, unknown>;
      const firstArtifact = firstDescriptor.artifact as Record<string, unknown>;
      const missingRevision = { ...document } as Record<string, unknown>;
      delete missingRevision.revision;
      const malformedDocuments: readonly unknown[] = [
        { ...document, extra: true },
        missingRevision,
        { ...document, version: '2' },
        { ...document, delivery: { ...delivery, extra: true } },
        {
          ...document,
          delivery: { ...delivery, packet: { ...delivery.packet, extra: true } },
        },
        {
          ...document,
          delivery: {
            ...delivery,
            packet: { ...delivery.packet, sidecars: [] },
          },
        },
        {
          ...document,
          delivery: {
            ...delivery,
            packet: {
              ...delivery.packet,
              sidecars: [...delivery.packet.sidecars, missingPartDescriptor],
            },
          },
        },
        {
          ...document,
          delivery: {
            ...delivery,
            packet: {
              ...delivery.packet,
              sidecars: [
                firstDescriptor,
                { ...secondDescriptor, sidecarId: firstDescriptor.sidecarId },
              ],
            },
          },
        },
        {
          ...document,
          delivery: {
            ...delivery,
            packet: {
              ...delivery.packet,
              sidecars: [
                { ...firstDescriptor, byteLength: Number(firstDescriptor.byteLength) - 1 },
                secondDescriptor,
              ],
            },
          },
        },
        {
          ...document,
          delivery: {
            ...delivery,
            packet: {
              ...delivery.packet,
              sidecars: [
                {
                  ...firstDescriptor,
                  sha256: '0'.repeat(64),
                  artifact: { ...firstArtifact, sha256: '0'.repeat(64) },
                },
                secondDescriptor,
              ],
            },
          },
        },
      ];
      for (const malformed of malformedDocuments) {
        expectDecodeRejected(replaceDeliveryJson(encoded, JSON.stringify(malformed)));
      }
      for (const malformedJson of [
        '{}',
        '[]',
        'null',
        '{',
        `${json} trailing`,
        json.replace('"version":"1"', '"version":"1","version":"1"'),
      ]) {
        expectDecodeRejected(replaceDeliveryJson(encoded, malformedJson));
      }

      const limits = Object.freeze({
        maxSidecarItemBytes: 4,
        maxSidecars: 2,
        maxSidecarBytes: 8,
      });
      const exactPacket = createTargetPacket('cancel.ack', {
        sidecars: [
          createSidecar('delivery-bounds-a', bytes('ABCD')),
          createSidecar('delivery-bounds-b', bytes('EFGH')),
        ],
      });
      const exact = encodeResponse(
        createResult({ packet: exactPacket }),
        POLL_COMMAND,
        POLL_ROUTE,
        { ...limits, boundary: 'delivery-bounds' },
      );
      expect(() => decodeResponse(exact, POLL_COMMAND, POLL_ROUTE, limits)).not.toThrow();
      expect(() =>
        encodeResponse(
          createResult({
            packet: createTargetPacket('cancel.ack', {
              sidecars: [createSidecar('delivery-over-item', bytes('ABCDE'))],
            }),
          }),
          POLL_COMMAND,
          POLL_ROUTE,
          limits,
        ),
      ).toThrow('HTTP delivery response exceeds a configured protocol limit.');
      expect(() =>
        encodeResponse(
          createResult({
            packet: createTargetPacket('cancel.ack', {
              sidecars: [
                createSidecar('delivery-count-a', bytes('A')),
                createSidecar('delivery-count-b', bytes('B')),
                createSidecar('delivery-count-c', bytes('C')),
              ],
            }),
          }),
          POLL_COMMAND,
          POLL_ROUTE,
          limits,
        ),
      ).toThrow('HTTP delivery response exceeds a configured protocol limit.');
      expect(() =>
        encodeResponse(
          createResult({
            packet: createTargetPacket('cancel.ack', {
              sidecars: [
                createSidecar('delivery-total-a', bytes('ABCD')),
                createSidecar('delivery-total-b', bytes('EFGHI')),
              ],
            }),
          }),
          POLL_COMMAND,
          POLL_ROUTE,
          { ...limits, maxSidecarItemBytes: 5 },
        ),
      ).toThrow('HTTP delivery response exceeds a configured protocol limit.');

      expect(() =>
        decodeResponse(exact, POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          maxBodyBytes: exact.body.byteLength,
        }),
      ).not.toThrow();
      expect(() =>
        decodeResponse(exact, POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          maxBodyBytes: exact.body.byteLength - 1,
        }),
      ).toThrow('HTTP delivery response exceeds a configured protocol limit.');
      expect(() =>
        encodeResponse(createResult({ packet: exactPacket }), POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          boundary: 'delivery-bounds',
          maxBodyBytes: exact.body.byteLength,
        }),
      ).not.toThrow();
      expect(() =>
        encodeResponse(createResult({ packet: exactPacket }), POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          boundary: 'delivery-bounds',
          maxBodyBytes: exact.body.byteLength - 1,
        }),
      ).toThrow('HTTP delivery response exceeds a configured protocol limit.');
      const exactJsonBytes = bytes(packetJson(exact)).byteLength;
      expect(() =>
        decodeResponse(exact, POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          maxPacketJsonBytes: exactJsonBytes,
        }),
      ).not.toThrow();
      expect(() =>
        decodeResponse(exact, POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          maxPacketJsonBytes: exactJsonBytes - 1,
        }),
      ).toThrow('HTTP delivery response exceeds a configured protocol limit.');
      expect(() =>
        encodeResponse(createResult({ packet: exactPacket }), POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          boundary: 'delivery-bounds',
          maxPacketJsonBytes: exactJsonBytes,
        }),
      ).not.toThrow();
      expect(() =>
        encodeResponse(createResult({ packet: exactPacket }), POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          boundary: 'delivery-bounds',
          maxPacketJsonBytes: exactJsonBytes - 1,
        }),
      ).toThrow('HTTP delivery response exceeds a configured protocol limit.');
      const frameBytes = bytes(String(exactPacket.frame)).byteLength;
      expect(() =>
        decodeResponse(exact, POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          maxFrameBytes: frameBytes,
        }),
      ).not.toThrow();
      expect(() =>
        decodeResponse(exact, POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          maxFrameBytes: frameBytes - 1,
        }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        encodeResponse(createResult({ packet: exactPacket }), POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          boundary: 'delivery-bounds',
          maxFrameBytes: frameBytes,
        }),
      ).not.toThrow();
      expect(() =>
        encodeResponse(createResult({ packet: exactPacket }), POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          boundary: 'delivery-bounds',
          maxFrameBytes: frameBytes - 1,
        }),
      ).toThrow('HTTP delivery response is invalid.');
      const firstHeaderBytes = bytes(
        `Content-Type: ${HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE}`,
      ).byteLength;
      const binaryHeaderBytes = bytes(
        'Content-Type: application/octet-stream\r\nContent-ID: delivery-bounds-a',
      ).byteLength;
      const exactHeaderBytes = Math.max(firstHeaderBytes, binaryHeaderBytes);
      expect(() =>
        decodeResponse(exact, POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          maxHeaderBytes: exactHeaderBytes,
        }),
      ).not.toThrow();
      expect(() =>
        decodeResponse(exact, POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          maxHeaderBytes: exactHeaderBytes - 1,
        }),
      ).toThrow('HTTP delivery response exceeds a configured protocol limit.');
      expect(() =>
        encodeResponse(createResult({ packet: exactPacket }), POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          boundary: 'delivery-bounds',
          maxHeaderBytes: exactHeaderBytes,
        }),
      ).not.toThrow();
      expect(() =>
        encodeResponse(createResult({ packet: exactPacket }), POLL_COMMAND, POLL_ROUTE, {
          ...limits,
          boundary: 'delivery-bounds',
          maxHeaderBytes: exactHeaderBytes - 1,
        }),
      ).toThrow('HTTP delivery response exceeds a configured protocol limit.');
      for (const tightened of [
        { ...limits, maxSidecars: 1 },
        { ...limits, maxSidecarItemBytes: 3 },
        { ...limits, maxSidecarBytes: 7 },
        { ...limits, maxJsonDepth: 1 },
        { ...limits, maxJsonNodes: 1 },
      ]) {
        expect(() => decodeResponse(exact, POLL_COMMAND, POLL_ROUTE, tightened)).toThrow();
      }

      const maximumBoundary = `a${'b'.repeat(69)}`;
      expect(
        encodeResponse(createResult(), POLL_COMMAND, POLL_ROUTE, {
          boundary: maximumBoundary,
        }).contentType,
      ).toBe(`multipart/mixed; boundary=${maximumBoundary}`);
      expect(() =>
        encodeResponse(createResult(), POLL_COMMAND, POLL_ROUTE, {
          boundary: `a${'b'.repeat(70)}`,
        }),
      ).toThrow('HTTP delivery response is invalid.');
    },
  );

  acceptanceIt(
    'C7C-HTTP-DELIVERY03.l1.semantic-response-correlation',
    'job-channel-generation-ack-cursor-receipt',
    () => {
      assertNetworkDenyGuardInstalled();
      const requestReceipt = createHttpSubAgentPollRequestReceipt({
        route: POLL_ROUTE,
        command: POLL_COMMAND,
      });
      expect(requestReceipt).toMatch(/^[0-9a-f]{64}$/u);
      expect(requestReceipt).toBe(
        canonicalJsonSha256({
          version: '1',
          route: { id: 'jobs.poll', jobId: JOB_ID },
          command: POLL_COMMAND,
        } as unknown as JsonValue),
      );
      expect(
        createHttpSubAgentPollRequestReceipt({
          route: { ...POLL_ROUTE },
          command: { ...POLL_COMMAND },
        }),
      ).toBe(requestReceipt);

      const hmacA = createHttpSubAgentHmacHeaders({
        method: 'POST',
        requestTarget: POLL_ROUTE.requestTarget,
        body: bytes('signed-poll-command'),
        keyId: HTTP_TEST_KEY_ID,
        key: HTTP_TEST_KEY,
        timestamp: HTTP_TEST_NOW,
        nonce: nonce(221),
      });
      const hmacB = createHttpSubAgentHmacHeaders({
        method: 'POST',
        requestTarget: POLL_ROUTE.requestTarget,
        body: bytes('signed-poll-command'),
        keyId: HTTP_TEST_KEY_ID,
        key: HTTP_TEST_KEY,
        timestamp: HTTP_TEST_NOW + 1,
        nonce: nonce(222),
      });
      expect(hmacA).not.toEqual(hmacB);
      expect(
        createHttpSubAgentPollRequestReceipt({ route: POLL_ROUTE, command: POLL_COMMAND }),
      ).toBe(requestReceipt);

      const changedRequestReceipts = [
        createHttpSubAgentPollRequestReceipt({
          route: createPollRoute('http-delivery-wire-job-2'),
          command: POLL_COMMAND,
        }),
        createHttpSubAgentPollRequestReceipt({
          route: POLL_ROUTE,
          command: pollCommand({ channelId: 'http-delivery-wire-channel-2' }),
        }),
        createHttpSubAgentPollRequestReceipt({
          route: POLL_ROUTE,
          command: pollCommand({ channelGeneration: '1' }),
        }),
        createHttpSubAgentPollRequestReceipt({
          route: POLL_ROUTE,
          command: pollCommand({ ackCursor: '5' }),
        }),
        createHttpSubAgentPollRequestReceipt({
          route: POLL_ROUTE,
          command: pollCommand({ waitMs: 251 }),
        }),
      ];
      for (const changed of changedRequestReceipts) expect(changed).not.toBe(requestReceipt);
      expect(new Set(changedRequestReceipts).size).toBe(changedRequestReceipts.length);
      expect(() =>
        createHttpSubAgentPollRequestReceipt({
          route: { ...POLL_ROUTE, requestTarget: '/v1/jobs/http-delivery-wire-job-2/poll' },
          command: POLL_COMMAND,
        }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        createHttpSubAgentPollRequestReceipt({
          route: POLL_ROUTE,
          command: POLL_COMMAND,
          nonce: 'transport-fields-are-not-receipt-input',
        } as unknown as Parameters<typeof createHttpSubAgentPollRequestReceipt>[0]),
      ).toThrow('HTTP delivery response is invalid.');

      const sidecarA = createSidecar('receipt-order-a', bytes('receipt-alpha'));
      const sidecarB = createSidecar('receipt-order-b', bytes('receipt-bravo'));
      const basePacket = createTargetPacket('cancel.ack', {
        sequence: 73,
        messageId: 'receipt-full-envelope',
        correlationId: 'receipt-correlation',
        sidecars: [sidecarB, sidecarA],
      });
      const basePacketReceipt = packetReceipt(basePacket);
      expect(basePacketReceipt).toMatch(/^[0-9a-f]{64}$/u);
      const reorderedPacket = createTargetPacket('cancel.ack', {
        sequence: 73,
        messageId: 'receipt-full-envelope',
        correlationId: 'receipt-correlation',
        sidecars: [sidecarA, sidecarB],
      });
      expect(packetReceipt(reorderedPacket)).toBe(basePacketReceipt);
      const reorderedResponse = encodeResponse(
        createResult({ packet: reorderedPacket, packetReceipt: basePacketReceipt }),
      );
      expect(decodeResponse(reorderedResponse).delivery?.packetReceipt).toBe(basePacketReceipt);

      const changedPacketReceipts = [
        packetReceipt(
          createTargetPacket('cancel.ack', {
            channelId: 'http-delivery-wire-channel-2',
            sequence: 73,
            messageId: 'receipt-full-envelope',
            correlationId: 'receipt-correlation',
            sidecars: [sidecarB, sidecarA],
          }),
        ),
        packetReceipt(
          createTargetPacket('cancel.ack', {
            sequence: 74,
            messageId: 'receipt-full-envelope',
            correlationId: 'receipt-correlation',
            sidecars: [sidecarB, sidecarA],
          }),
        ),
        packetReceipt(
          createTargetPacket('cancel.ack', {
            sequence: 73,
            messageId: 'receipt-full-envelope-changed',
            correlationId: 'receipt-correlation',
            sidecars: [sidecarB, sidecarA],
          }),
        ),
        packetReceipt(
          createTargetPacket('cancel.ack', {
            sequence: 73,
            messageId: 'receipt-full-envelope',
            correlationId: 'receipt-correlation-changed',
            sidecars: [sidecarB, sidecarA],
          }),
        ),
        packetReceipt(
          createTargetPacket('cancel.ack', {
            sequence: 73,
            messageId: 'receipt-full-envelope',
            correlationId: 'receipt-correlation',
            taskId: 'http-delivery-wire-task-2',
            sidecars: [sidecarB, sidecarA],
          }),
        ),
        packetReceipt(
          createTargetPacket('cancel.ack', {
            sequence: 73,
            messageId: 'receipt-full-envelope',
            correlationId: 'receipt-correlation',
            operationId: 'http-delivery-wire-operation-2',
            sidecars: [sidecarB, sidecarA],
          }),
        ),
        packetReceipt(
          createPacket(
            'protocol.error',
            {
              error: {
                code: 'EXECUTOR_FAILED',
                message: 'A different valid protocol error payload.',
                retryable: false,
                causeCode: 'REMOTE_REJECTED',
              },
            },
            {
              sequence: 73,
              messageId: 'receipt-full-envelope',
              correlationId: 'receipt-correlation',
              sidecars: [sidecarB, sidecarA],
            },
          ),
        ),
        packetReceipt(
          createTargetPacket('cancel.ack', {
            sequence: 73,
            messageId: 'receipt-full-envelope',
            correlationId: 'receipt-correlation',
            sidecars: [createSidecar('receipt-order-b', bytes('receipt-bravo-changed')), sidecarA],
          }),
        ),
      ];
      for (const changed of changedPacketReceipts) expect(changed).not.toBe(basePacketReceipt);
      expect(new Set(changedPacketReceipts).size).toBe(changedPacketReceipts.length);

      const independentCursorCommand = pollCommand({ ackCursor: '41' });
      const independentSequencePacket = createTargetPacket('cancel.ack', {
        sequence: 7,
        sidecars: [createSidecar('cursor-domain-proof', bytes('cursor-is-not-sequence'))],
      });
      const independentCursorResponse = encodeResponse(
        createResult({
          command: independentCursorCommand,
          packet: independentSequencePacket,
          cursor: '42',
        }),
        independentCursorCommand,
        POLL_ROUTE,
        { boundary: 'delivery-cursor-domain' },
      );
      const independentCursorDecoded = decodeResponse(
        independentCursorResponse,
        independentCursorCommand,
      );
      expect(independentCursorDecoded.delivery?.cursor).toBe('42');
      expect(
        decodeSubAgentTransportRpcFrame(independentCursorDecoded.delivery!.packet.frame).sequence,
      ).toBe(7);

      for (const kind of TARGET_TO_CONTROLLER_KINDS) {
        const allowedPacket = createTargetPacket(kind);
        const allowed = encodeResponse(createResult({ packet: allowedPacket }));
        expect(decodeResponse(allowed).delivery?.packetReceipt).toBe(packetReceipt(allowedPacket));
      }
      for (const deniedPacket of [
        createPacket('snapshot.request', { mode: 'snapshot' }),
        createPacket('cancel.request', {
          binding: createBinding(),
          reason: 'wrong delivery direction',
        }),
        createPacket('control.reply', {
          method: 'execution.reportProgress',
          ok: true,
          result: null,
        }),
        createPacket('model.reply', {
          providerOperationId: OPERATION_ID,
          gatewayId: 'http-delivery-wire-gateway-1',
          protocol: 'openai-chat',
          codecVersion: '1',
          runId: 'http-delivery-wire-run-1',
          executionAttempt: 1,
          executionEpoch: 'http-delivery-wire-epoch-1',
          executionFencingToken: '1',
          checkpointOperationId: 'http-delivery-wire-checkpoint-1',
          checkpointDigest: 'c'.repeat(64),
          requestHash: 'a'.repeat(64),
          ok: true,
          resultHash: 'b'.repeat(64),
          messages: [{ role: 'assistant', content: 'wrong direction' }],
        }),
      ]) {
        expect(() => encodeResponse(createResult({ packet: deniedPacket }))).toThrow(
          'HTTP delivery response is invalid.',
        );
      }

      const scalarPacket = createTargetPacket('cancel.ack', {
        sidecars: [createSidecar('scalar-proof', bytes('scalar-proof'))],
      });
      for (const invalidResult of [
        createResult({ packet: scalarPacket, revision: '01' }),
        createResult({ packet: scalarPacket, revision: '18446744073709551616' }),
        createResult({ packet: scalarPacket, channelId: 'wrong-channel' }),
        createResult({ packet: scalarPacket, channelGeneration: '1' }),
        createResult({ packet: scalarPacket, ackCursor: '3' }),
        createResult({ packet: scalarPacket, cursor: '4' }),
        createResult({ packet: scalarPacket, cursor: '6' }),
        createResult({ packet: scalarPacket, cursor: '05' }),
        createResult({ packet: scalarPacket, packetReceipt: '0'.repeat(64) }),
      ]) {
        expect(() => encodeResponse(invalidResult)).toThrow('HTTP delivery response is invalid.');
      }
      expect(() =>
        encodeResponse(
          createResult({
            packet: createTargetPacket('cancel.ack', { channelId: 'wrong-inner-channel' }),
          }),
        ),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() => encodeResponse(createResult(), pollCommand({ channelGeneration: '1' }))).toThrow(
        'HTTP delivery response is invalid.',
      );

      const maxCommand = pollCommand({ ackCursor: UINT64_MAX });
      const emptyAtMax = encodeResponse(createResult({ command: maxCommand }), maxCommand);
      expect(decodeResponse(emptyAtMax, maxCommand).delivery).toBeNull();
      expect(() =>
        encodeResponse(
          createResult({
            command: maxCommand,
            packet: createTargetPacket('cancel.ack'),
            cursor: UINT64_MAX,
          }),
          maxCommand,
        ),
      ).toThrow('HTTP delivery response is invalid.');

      const correlated = encodeResponse(
        createResult({ packet: basePacket }),
        POLL_COMMAND,
        POLL_ROUTE,
        { boundary: 'delivery-correlation' },
      );
      const correlatedDocument = parseDeliveryJson(correlated);
      if (correlatedDocument.delivery === null) {
        throw new Error('Expected a correlated delivery document.');
      }
      expect(correlatedDocument.requestReceipt).toBe(requestReceipt);
      expect(correlatedDocument.delivery.packetReceipt).toBe(basePacketReceipt);
      for (const tampered of [
        { ...correlatedDocument, requestReceipt: '0'.repeat(64) },
        { ...correlatedDocument, revision: '01' },
        { ...correlatedDocument, channelId: 'wrong-channel' },
        { ...correlatedDocument, channelGeneration: '1' },
        { ...correlatedDocument, ackCursor: '3' },
        {
          ...correlatedDocument,
          delivery: { ...correlatedDocument.delivery, cursor: '6' },
        },
        {
          ...correlatedDocument,
          delivery: { ...correlatedDocument.delivery, packetReceipt: '0'.repeat(64) },
        },
      ]) {
        expectDecodeRejected(replaceDeliveryJson(correlated, JSON.stringify(tampered)));
      }
      expectDecodeRejected(correlated, pollCommand({ waitMs: POLL_COMMAND.waitMs + 1 }));
      expectDecodeRejected(correlated, pollCommand({ ackCursor: '3' }));
      expectDecodeRejected(correlated, POLL_COMMAND, createPollRoute('http-delivery-wire-job-2'));

      let earlySidecarTraps = 0;
      const hostileSidecars = new Proxy([] as SubAgentTransportArtifactSidecar[], {
        get() {
          earlySidecarTraps += 1;
          throw new Error('scalar mismatch must reject before reading packet sidecars');
        },
        getOwnPropertyDescriptor() {
          earlySidecarTraps += 1;
          throw new Error('scalar mismatch must reject before inspecting packet sidecars');
        },
      });
      const hostilePacket = {
        frame: createTargetPacket('cancel.ack').frame,
        sidecars: hostileSidecars,
      } as SubAgentTransportPeerPacket;
      expect(() =>
        encodeResponse(
          createResult({
            packet: hostilePacket,
            channelId: 'wrong-channel',
            packetReceipt: '0'.repeat(64),
          }),
        ),
      ).toThrow('HTTP delivery response is invalid.');
      expect(earlySidecarTraps).toBe(0);

      let fencedSidecarTraps = 0;
      const fencedSidecars = new Proxy([] as SubAgentTransportArtifactSidecar[], {
        get() {
          fencedSidecarTraps += 1;
          throw new Error('inner channel mismatch must reject before reading sidecars');
        },
        getOwnPropertyDescriptor() {
          fencedSidecarTraps += 1;
          throw new Error('inner channel mismatch must reject before inspecting sidecars');
        },
      });
      const wrongInnerFrame = createTargetPacket('cancel.ack', {
        channelId: 'wrong-inner-channel',
      }).frame;
      expect(() =>
        encodeResponse(
          createResult({
            packet: { frame: wrongInnerFrame, sidecars: fencedSidecars },
            packetReceipt: '0'.repeat(64),
          }),
        ),
      ).toThrow('HTTP delivery response is invalid.');
      expect(fencedSidecarTraps).toBe(0);
    },
  );

  acceptanceIt(
    'C7C-HTTP-DELIVERY04.l2.hostile-codec-input',
    'proxy-accessor-prototype-cross-realm-zero-trap',
    () => {
      assertNetworkDenyGuardInstalled();
      const packet = createTargetPacket('cancel.ack', {
        sidecars: [createSidecar('delivery-hostile-sidecar', bytes('HOSTILE-PROOF'))],
      });
      const result = createResult({ packet });
      const encodeInput = {
        route: POLL_ROUTE,
        command: POLL_COMMAND,
        result,
      } satisfies HttpSubAgentDeliveryResponseEncodeInput;
      const encoded = encodeHttpSubAgentDeliveryResponse(encodeInput, {
        boundary: 'delivery-hostile',
      });
      const decodeInput = {
        route: POLL_ROUTE,
        command: POLL_COMMAND,
        ...encoded,
      } satisfies HttpSubAgentDeliveryResponseInput;

      let proxyTraps = 0;
      const proxyHandler = {
        get() {
          proxyTraps += 1;
          throw new Error('delivery codec Proxy get trap must not run');
        },
        ownKeys() {
          proxyTraps += 1;
          throw new Error('delivery codec Proxy ownKeys trap must not run');
        },
        getOwnPropertyDescriptor() {
          proxyTraps += 1;
          throw new Error('delivery codec Proxy descriptor trap must not run');
        },
        getPrototypeOf() {
          proxyTraps += 1;
          throw new Error('delivery codec Proxy prototype trap must not run');
        },
      } as const;
      expect(() =>
        encodeHttpSubAgentDeliveryResponse(
          new Proxy(encodeInput, proxyHandler) as HttpSubAgentDeliveryResponseEncodeInput,
        ),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        encodeHttpSubAgentDeliveryResponse({
          ...encodeInput,
          route: new Proxy(POLL_ROUTE, proxyHandler),
        }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        encodeHttpSubAgentDeliveryResponse({
          ...encodeInput,
          command: new Proxy(POLL_COMMAND, proxyHandler),
        }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        encodeHttpSubAgentDeliveryResponse({
          ...encodeInput,
          result: new Proxy(result, proxyHandler),
        }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        decodeHttpSubAgentDeliveryResponse(
          new Proxy(decodeInput, proxyHandler) as HttpSubAgentDeliveryResponseInput,
        ),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        createHttpSubAgentPollRequestReceipt(
          new Proxy({ route: POLL_ROUTE, command: POLL_COMMAND }, proxyHandler),
        ),
      ).toThrow('HTTP delivery response is invalid.');
      expect(proxyTraps).toBe(0);

      let accessorReads = 0;
      expect(() =>
        encodeHttpSubAgentDeliveryResponse(
          dataCloneWithAccessor(encodeInput, 'route', () => {
            accessorReads += 1;
          }),
        ),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        encodeHttpSubAgentDeliveryResponse({
          ...encodeInput,
          route: dataCloneWithAccessor(POLL_ROUTE, 'requestTarget', () => {
            accessorReads += 1;
          }),
        }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        encodeHttpSubAgentDeliveryResponse({
          ...encodeInput,
          command: dataCloneWithAccessor(POLL_COMMAND, 'waitMs', () => {
            accessorReads += 1;
          }),
        }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        encodeHttpSubAgentDeliveryResponse({
          ...encodeInput,
          result: dataCloneWithAccessor(result, 'revision', () => {
            accessorReads += 1;
          }),
        }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        decodeHttpSubAgentDeliveryResponse(
          dataCloneWithAccessor(decodeInput, 'body', () => {
            accessorReads += 1;
          }),
        ),
      ).toThrow('HTTP delivery response is invalid.');
      expect(accessorReads).toBe(0);

      const symbolicInput = { ...encodeInput } as HttpSubAgentDeliveryResponseEncodeInput &
        Record<PropertyKey, unknown>;
      symbolicInput[Symbol('unsupported-input')] = true;
      expect(() => encodeHttpSubAgentDeliveryResponse(symbolicInput)).toThrow(
        'HTTP delivery response is invalid.',
      );
      const symbolicOptions = {} as HttpSubAgentDeliveryResponseEncodeOptions &
        Record<PropertyKey, unknown>;
      symbolicOptions[Symbol('unsupported-option')] = true;
      expect(() => encodeHttpSubAgentDeliveryResponse(encodeInput, symbolicOptions)).toThrow(
        'HTTP delivery response is invalid.',
      );

      const customPrototypeInput = Object.assign(Object.create({ inherited: true }), encodeInput);
      expect(() =>
        encodeHttpSubAgentDeliveryResponse(
          customPrototypeInput as HttpSubAgentDeliveryResponseEncodeInput,
        ),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        encodeHttpSubAgentDeliveryResponse({
          ...encodeInput,
          route: Object.assign(Object.create({ inherited: true }), POLL_ROUTE),
        }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        encodeHttpSubAgentDeliveryResponse({
          ...encodeInput,
          command: Object.assign(Object.create({ inherited: true }), POLL_COMMAND),
        }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        encodeHttpSubAgentDeliveryResponse({
          ...encodeInput,
          result: Object.assign(Object.create({ inherited: true }), result),
        }),
      ).toThrow('HTTP delivery response is invalid.');

      const sparseSidecars = new Array<SubAgentTransportArtifactSidecar>(1);
      const sparsePacket = {
        frame: packet.frame,
        sidecars: sparseSidecars,
      } as SubAgentTransportPeerPacket;
      expect(() =>
        encodeResponse(
          createResult({
            packet: sparsePacket,
            packetReceipt: '0'.repeat(64),
          }),
        ),
      ).toThrow('HTTP delivery response is invalid.');
      let iteratorCalls = 0;
      const symbolicSidecars = [packet.sidecars[0]!] as SubAgentTransportArtifactSidecar[];
      Object.defineProperty(symbolicSidecars, Symbol.iterator, {
        configurable: true,
        value: () => {
          iteratorCalls += 1;
          return [packet.sidecars[0]!][Symbol.iterator]();
        },
      });
      expect(() =>
        encodeResponse(
          createResult({
            packet: { frame: packet.frame, sidecars: symbolicSidecars },
            packetReceipt: '0'.repeat(64),
          }),
        ),
      ).toThrow('HTTP delivery response is invalid.');
      expect(iteratorCalls).toBe(0);

      let boundaryTraps = 0;
      const hostileBoundary = new Proxy(
        {
          toString() {
            boundaryTraps += 1;
            throw new Error('boundary toString trap must not run');
          },
          valueOf() {
            boundaryTraps += 1;
            throw new Error('boundary valueOf trap must not run');
          },
        },
        {
          get() {
            boundaryTraps += 1;
            throw new Error('boundary Proxy get trap must not run');
          },
        },
      );
      for (const boundary of [
        7,
        {
          toString() {
            boundaryTraps += 1;
            throw new Error('plain boundary toString must not run');
          },
          valueOf() {
            boundaryTraps += 1;
            throw new Error('plain boundary valueOf must not run');
          },
        },
        hostileBoundary,
      ]) {
        expect(() =>
          encodeHttpSubAgentDeliveryResponse(encodeInput, {
            boundary: boundary as unknown as string,
          }),
        ).toThrow('HTTP delivery response is invalid.');
      }
      expect(boundaryTraps).toBe(0);

      let optionsProxyTraps = 0;
      const hostileOptions = new Proxy(
        {},
        {
          get() {
            optionsProxyTraps += 1;
            throw new Error('delivery options Proxy get trap must not run');
          },
          ownKeys() {
            optionsProxyTraps += 1;
            throw new Error('delivery options Proxy ownKeys trap must not run');
          },
        },
      ) as HttpSubAgentDeliveryResponseEncodeOptions;
      expect(() => encodeHttpSubAgentDeliveryResponse(encodeInput, hostileOptions)).toThrow(
        'HTTP delivery response is invalid.',
      );
      expect(optionsProxyTraps).toBe(0);

      let bodyProxyTraps = 0;
      const proxiedBody = new Proxy(encoded.body, {
        get() {
          bodyProxyTraps += 1;
          throw new Error('delivery body Proxy get trap must not run');
        },
        getPrototypeOf() {
          bodyProxyTraps += 1;
          throw new Error('delivery body Proxy prototype trap must not run');
        },
      });
      expect(() =>
        decodeHttpSubAgentDeliveryResponse({ ...decodeInput, body: proxiedBody }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(bodyProxyTraps).toBe(0);

      const sparseBody = new Array<number>(encoded.body.byteLength);
      sparseBody[0] = encoded.body[0]!;
      expect(() =>
        decodeHttpSubAgentDeliveryResponse({
          ...decodeInput,
          body: sparseBody as unknown as Uint8Array,
        }),
      ).toThrow('HTTP delivery response is invalid.');
      const forgedBody = Object.create(Uint8Array.prototype) as Uint8Array;
      expect(() =>
        decodeHttpSubAgentDeliveryResponse({ ...decodeInput, body: forgedBody }),
      ).toThrow('HTTP delivery response is invalid.');

      let bytePrototypeTraps = 0;
      const hostilePrototypeBody = encoded.body.slice();
      Object.setPrototypeOf(
        hostilePrototypeBody,
        new Proxy(Uint8Array.prototype, {
          getPrototypeOf() {
            bytePrototypeTraps += 1;
            throw new Error('typed-array prototype trap must not run');
          },
          get() {
            bytePrototypeTraps += 1;
            throw new Error('typed-array prototype get trap must not run');
          },
        }),
      );
      expect(
        decodeHttpSubAgentDeliveryResponse({
          ...decodeInput,
          body: hostilePrototypeBody,
        }).delivery?.packet.sidecars[0]?.data,
      ).toEqual(bytes('HOSTILE-PROOF'));
      expect(bytePrototypeTraps).toBe(0);

      const crossRealmBody = runInNewContext('Uint8Array.from(values)', {
        values: Array.from(encoded.body),
      }) as Uint8Array;
      const crossRealmBuffer = runInNewContext('Uint8Array.from(values).buffer', {
        values: Array.from(encoded.body),
      }) as ArrayBuffer;
      expect(
        decodeHttpSubAgentDeliveryResponse({ ...decodeInput, body: crossRealmBody }).delivery
          ?.packet.sidecars[0]?.data,
      ).toEqual(bytes('HOSTILE-PROOF'));
      expect(
        decodeHttpSubAgentDeliveryResponse({ ...decodeInput, body: crossRealmBuffer }).delivery
          ?.packet.sidecars[0]?.data,
      ).toEqual(bytes('HOSTILE-PROOF'));

      const crossRealmWrapper = runInNewContext(
        '({ route, command, status, contentType, cacheControl, body })',
        decodeInput,
      ) as HttpSubAgentDeliveryResponseInput;
      expect(() => decodeHttpSubAgentDeliveryResponse(crossRealmWrapper)).toThrow(
        'HTTP delivery response is invalid.',
      );
      const crossRealmEncodeWrapper = runInNewContext('({ route, command, result })', {
        route: POLL_ROUTE,
        command: POLL_COMMAND,
        result,
      }) as HttpSubAgentDeliveryResponseEncodeInput;
      expect(() => encodeHttpSubAgentDeliveryResponse(crossRealmEncodeWrapper)).toThrow(
        'HTTP delivery response is invalid.',
      );
      const crossRealmRoute = runInNewContext('({ ...route })', {
        route: POLL_ROUTE,
      }) as HttpSubAgentPollRoute;
      const crossRealmCommand = runInNewContext('({ ...command })', {
        command: POLL_COMMAND,
      }) as HttpSubAgentPollCommand;
      expect(() =>
        decodeHttpSubAgentDeliveryResponse({ ...decodeInput, route: crossRealmRoute }),
      ).toThrow('HTTP delivery response is invalid.');
      expect(() =>
        decodeHttpSubAgentDeliveryResponse({ ...decodeInput, command: crossRealmCommand }),
      ).toThrow('HTTP delivery response is invalid.');
      const crossRealmProxyState = { traps: 0 };
      const crossRealmProxy = runInNewContext(
        `new Proxy(
          { route, command, status, contentType, cacheControl, body },
          {
            get() { state.traps += 1; throw new Error('cross-realm get trap'); },
            ownKeys() { state.traps += 1; throw new Error('cross-realm ownKeys trap'); },
            getPrototypeOf() { state.traps += 1; throw new Error('cross-realm prototype trap'); }
          }
        )`,
        { ...decodeInput, state: crossRealmProxyState },
      ) as HttpSubAgentDeliveryResponseInput;
      expect(() => decodeHttpSubAgentDeliveryResponse(crossRealmProxy)).toThrow(
        'HTTP delivery response is invalid.',
      );
      expect(crossRealmProxyState.traps).toBe(0);

      const nullRoute = nullRecord({ ...POLL_ROUTE });
      const nullCommand = nullRecord({ ...POLL_COMMAND });
      const nullPacket = nullRecord({
        frame: packet.frame,
        sidecars: [...packet.sidecars],
      }) as SubAgentTransportPeerPacket;
      const nullDelivery = nullRecord({
        cursor: '5',
        packetReceipt: packetReceipt(packet),
        packet: nullPacket,
      });
      const nullResult = nullRecord({
        deliveryVersion: HTTP_SUBAGENT_JOB_DELIVERY_VERSION,
        revision: '9',
        channelId: CHANNEL_ID,
        channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
        ackCursor: '4',
        delivery: nullDelivery,
      }) as HttpSubAgentJobPollOutboundResult;
      const nullEncoded = encodeHttpSubAgentDeliveryResponse(
        nullRecord({ route: nullRoute, command: nullCommand, result: nullResult }),
        { boundary: 'delivery-null-records' },
      );
      const nullDecoded = decodeHttpSubAgentDeliveryResponse(
        nullRecord({
          route: nullRoute,
          command: nullCommand,
          status: nullEncoded.status,
          contentType: nullEncoded.contentType,
          cacheControl: nullEncoded.cacheControl,
          body: nullEncoded.body,
        }),
      );
      expect(nullDecoded.delivery?.packet.sidecars[0]?.data).toEqual(bytes('HOSTILE-PROOF'));
      expect(Object.isFrozen(nullDecoded)).toBe(true);
      expect(Object.isFrozen(nullDecoded.delivery)).toBe(true);

      const secretJobId = 'secret-delivery-job-id';
      const secretReceipt = 'f'.repeat(64);
      let captured: unknown;
      try {
        decodeHttpSubAgentDeliveryResponse({
          ...decodeInput,
          route: createPollRoute(secretJobId),
          body: replaceDeliveryJson(
            encoded,
            JSON.stringify({ ...parseDeliveryJson(encoded), requestReceipt: secretReceipt }),
          ).body,
        });
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(TypeError);
      expect(captured).toMatchObject({ message: 'HTTP delivery response is invalid.' });
      expect(captured instanceof Error && 'cause' in captured).toBe(false);
      expect(String(captured)).not.toContain(secretJobId);
      expect(String(captured)).not.toContain(secretReceipt);
      expect(String(captured)).not.toContain(JOB_ID);
      expect(String(captured)).not.toContain(CHANNEL_ID);
    },
  );
});
