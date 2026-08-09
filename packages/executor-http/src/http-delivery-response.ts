import {
  assertSubAgentTransportArtifactSidecarDescriptor,
  canonicalJsonSha256,
  decodeSubAgentTransportArtifactSidecar,
  parseJsonValue,
  type JsonValue,
  type SubAgentTransportArtifactSidecarDescriptor,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

import { HTTP_SUBAGENT_PACKET_VERSION } from './http-constants';
import { copyHttpBytes, requireClosedDataRecord, requireDenseDataArray } from './http-internal';
import type {
  HttpSubAgentJobOutboundDeliveryV1,
  HttpSubAgentJobPollOutboundResult,
} from './http-job-store';
import {
  finalizeOwnedHttpSubAgentOutboundPacket,
  ownHttpSubAgentOutboundFrame,
  ownHttpSubAgentOutboundPacket,
  type HttpSubAgentOutboundPacketLimits,
  type OwnedHttpSubAgentOutboundFrame,
  type OwnedHttpSubAgentOutboundPacket,
} from './http-outbound-packet';
import {
  decodeOwnedHttpSubAgentMultipartDocument,
  encodeHttpSubAgentMultipartDocument,
  resolveHttpSubAgentMultipartLimits,
  type HttpSubAgentMultipartEncodeOptions,
  type HttpSubAgentMultipartLimits,
  type ResolvedHttpSubAgentMultipartLimits,
} from './multipart';
import {
  decodeHttpSubAgentPollCommand,
  encodeHttpSubAgentPollCommand,
  type HttpSubAgentPollCommand,
} from './http-poll';
import { parseHttpSubAgentRoute } from './http-route';

export const HTTP_SUBAGENT_DELIVERY_RESPONSE_VERSION = '1' as const;
/** Exact media type of the first JSON part, not the top-level multipart Content-Type. */
export const HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE =
  'application/vnd.maneeagent.delivery+json' as const;
export const HTTP_SUBAGENT_DELIVERY_RESPONSE_CACHE_CONTROL = 'no-store' as const;

const HTTP_OK = 200 as const;
const INITIAL_CHANNEL_GENERATION = '0' as const;
const RECEIPT_INPUT_KEYS = Object.freeze(['route', 'command'] as const);
const ENCODE_INPUT_KEYS = Object.freeze(['route', 'command', 'result'] as const);
const DECODE_INPUT_KEYS = Object.freeze([
  'route',
  'command',
  'status',
  'contentType',
  'cacheControl',
  'body',
] as const);
const POLL_ROUTE_KEYS = Object.freeze(['id', 'requestTarget', 'jobId'] as const);
const RESULT_KEYS = Object.freeze([
  'deliveryVersion',
  'revision',
  'channelId',
  'channelGeneration',
  'ackCursor',
  'delivery',
] as const);
const DOCUMENT_KEYS = Object.freeze([
  'version',
  'requestReceipt',
  'revision',
  'channelId',
  'channelGeneration',
  'ackCursor',
  'delivery',
] as const);
const DELIVERY_KEYS = Object.freeze(['cursor', 'packetReceipt', 'packet'] as const);
const DELIVERY_PACKET_KEYS = Object.freeze(['version', 'frame', 'sidecars'] as const);
const LOWER_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UINT64_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const UINT64_MAX_DECIMAL = '18446744073709551615';
const UINT64_MAX = 18_446_744_073_709_551_615n;
const UTF8_ENCODER = new TextEncoder();
const MULTIPART_CONTENT_TYPE_PATTERN =
  /^multipart\/mixed; boundary=[A-Za-z0-9][A-Za-z0-9._-]{0,69}$/u;

export interface HttpSubAgentPollRoute {
  readonly id: 'jobs.poll';
  readonly requestTarget: string;
  readonly jobId: string;
}

export interface HttpSubAgentPollRequestReceiptInput {
  readonly route: HttpSubAgentPollRoute;
  readonly command: HttpSubAgentPollCommand;
}

export interface HttpSubAgentDeliveryResponseEncodeInput extends HttpSubAgentPollRequestReceiptInput {
  readonly result: HttpSubAgentJobPollOutboundResult;
}

export interface HttpSubAgentDeliveryResponseInput extends HttpSubAgentPollRequestReceiptInput {
  readonly status: number;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly body: Uint8Array | ArrayBuffer;
}

export interface HttpSubAgentEncodedDeliveryResponse {
  readonly status: 200;
  readonly contentType: string;
  readonly cacheControl: typeof HTTP_SUBAGENT_DELIVERY_RESPONSE_CACHE_CONTROL;
  readonly body: Uint8Array;
}

export interface HttpSubAgentDeliveryResponseV1 {
  readonly version: typeof HTTP_SUBAGENT_DELIVERY_RESPONSE_VERSION;
  readonly requestReceipt: string;
  readonly revision: string;
  readonly channelId: string;
  readonly channelGeneration: typeof INITIAL_CHANNEL_GENERATION;
  readonly ackCursor: string;
  readonly delivery: HttpSubAgentJobOutboundDeliveryV1 | null;
}

export type HttpSubAgentDeliveryResponseLimits = HttpSubAgentMultipartLimits;
export type HttpSubAgentDeliveryResponseEncodeOptions = HttpSubAgentMultipartEncodeOptions;

interface OwnedPollRequestContext {
  readonly route: HttpSubAgentPollRoute;
  readonly command: HttpSubAgentPollCommand;
  readonly requestReceipt: string;
}

interface OwnedDelivery {
  readonly cursor: string;
  readonly packetReceipt: string;
  readonly packet: SubAgentTransportPeerPacket;
}

interface OwnedDeliveryResult {
  readonly revision: string;
  readonly channelId: string;
  readonly channelGeneration: typeof INITIAL_CHANNEL_GENERATION;
  readonly ackCursor: string;
  readonly delivery: OwnedDelivery | null;
}

interface DeliveryDocumentPlan {
  readonly requestReceipt: string;
  readonly revision: string;
  readonly channelId: string;
  readonly channelGeneration: typeof INITIAL_CHANNEL_GENERATION;
  readonly ackCursor: string;
  readonly delivery: null | Readonly<{
    cursor: string;
    packetReceipt: string;
    ownedFrame: OwnedHttpSubAgentOutboundFrame;
  }>;
}

/** Creates the stable JCS receipt for one exact poll route and complete poll command. */
export function createHttpSubAgentPollRequestReceipt(
  input: HttpSubAgentPollRequestReceiptInput,
): string {
  try {
    return createPollRequestReceipt(input);
  } catch (error) {
    throwDeliveryCodecError(error);
  }
}

function createPollRequestReceipt(input: HttpSubAgentPollRequestReceiptInput): string {
  const record = requireClosedDataRecord(
    input,
    RECEIPT_INPUT_KEYS,
    'HTTP poll request receipt input',
  );
  const route = ownPollRoute(record.route);
  const command = ownPollCommand(record.command);
  return createOwnedPollRequestReceipt(route, command);
}

/** Encodes a correlated Store poll result as one always-multipart HTTP 200 response. */
export function encodeHttpSubAgentDeliveryResponse(
  input: HttpSubAgentDeliveryResponseEncodeInput,
  options: HttpSubAgentDeliveryResponseEncodeOptions = {},
): HttpSubAgentEncodedDeliveryResponse {
  try {
    return encodeDeliveryResponse(input, options);
  } catch (error) {
    throwDeliveryCodecError(error);
  }
}

function encodeDeliveryResponse(
  input: HttpSubAgentDeliveryResponseEncodeInput,
  options: HttpSubAgentDeliveryResponseEncodeOptions,
): HttpSubAgentEncodedDeliveryResponse {
  const limits = resolveHttpSubAgentMultipartLimits(options, true);
  const record = requireClosedDataRecord(
    input,
    ENCODE_INPUT_KEYS,
    'HTTP delivery response encode input',
  );
  const request = ownPollRequestContext(record.route, record.command);
  const result = ownDeliveryResult(record.result, request.command, limits);
  const delivery = result.delivery;
  const firstPartJson = JSON.stringify({
    version: HTTP_SUBAGENT_DELIVERY_RESPONSE_VERSION,
    requestReceipt: request.requestReceipt,
    revision: result.revision,
    channelId: result.channelId,
    channelGeneration: result.channelGeneration,
    ackCursor: result.ackCursor,
    delivery:
      delivery === null
        ? null
        : {
            cursor: delivery.cursor,
            packetReceipt: delivery.packetReceipt,
            packet: {
              version: HTTP_SUBAGENT_PACKET_VERSION,
              frame: delivery.packet.frame,
              sidecars: delivery.packet.sidecars.map((sidecar) => sidecar.descriptor),
            },
          },
  });
  if (UTF8_ENCODER.encode(firstPartJson).byteLength > limits.maxPacketJsonBytes) {
    throw new RangeError('HTTP delivery response JSON exceeds the configured byte limit.');
  }
  parseJsonValue(firstPartJson, {
    maxBytes: limits.maxPacketJsonBytes,
    maxDepth: limits.maxJsonDepth,
    maxNodes: limits.maxJsonNodes,
    label: 'HTTP delivery response JSON',
  });
  const boundary = options.boundary;
  const encoded = encodeHttpSubAgentMultipartDocument(
    {
      ...(boundary === undefined ? {} : { boundary }),
      firstPartMediaType: HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE,
      firstPartJson,
      firstPartLabel: 'HTTP delivery response JSON',
      parts:
        delivery === null
          ? []
          : delivery.packet.sidecars.map((sidecar) => ({
              contentId: sidecar.descriptor.sidecarId,
              data: sidecar.data,
            })),
    },
    limits,
  );
  return Object.freeze({
    status: HTTP_OK,
    contentType: encoded.contentType,
    cacheControl: HTTP_SUBAGENT_DELIVERY_RESPONSE_CACHE_CONTROL,
    body: encoded.body,
  });
}

/** Strictly decodes and correlates one complete always-multipart delivery response. */
export function decodeHttpSubAgentDeliveryResponse(
  input: HttpSubAgentDeliveryResponseInput,
  options: HttpSubAgentDeliveryResponseLimits = {},
): HttpSubAgentDeliveryResponseV1 {
  try {
    return decodeDeliveryResponse(input, options);
  } catch (error) {
    throwDeliveryCodecError(error);
  }
}

function decodeDeliveryResponse(
  input: HttpSubAgentDeliveryResponseInput,
  options: HttpSubAgentDeliveryResponseLimits,
): HttpSubAgentDeliveryResponseV1 {
  const limits = resolveHttpSubAgentMultipartLimits(options);
  const record = requireClosedDataRecord(
    input,
    DECODE_INPUT_KEYS,
    'HTTP delivery response decode input',
  );
  const request = ownPollRequestContext(record.route, record.command);
  if (record.status !== HTTP_OK) {
    throw new TypeError('HTTP delivery response status must be exactly 200.');
  }
  if (
    typeof record.contentType !== 'string' ||
    !MULTIPART_CONTENT_TYPE_PATTERN.test(record.contentType)
  ) {
    throw new TypeError('HTTP delivery response contentType must be canonical multipart/mixed.');
  }
  if (record.cacheControl !== HTTP_SUBAGENT_DELIVERY_RESPONSE_CACHE_CONTROL) {
    throw new TypeError('HTTP delivery response cacheControl must be exactly no-store.');
  }
  const body = copyHttpBytes(
    record.body as Uint8Array | ArrayBuffer,
    'HTTP delivery response body',
    limits.maxBodyBytes,
  );
  const document = decodeOwnedHttpSubAgentMultipartDocument(record.contentType, body, limits, {
    firstPartMediaType: HTTP_SUBAGENT_DELIVERY_RESPONSE_MEDIA_TYPE,
    firstPartLabel: 'HTTP delivery response JSON',
    decodeFirstPart: (json) => decodeDeliveryDocumentPlan(json, request, limits),
    decodePart: (descriptor, bytes) =>
      decodeSubAgentTransportArtifactSidecar(descriptor, bytes, {
        maxBytes: limits.maxSidecarItemBytes,
      }),
  });
  const plan = document.value;
  if (plan.delivery === null) {
    return freezeDecodedResponse(plan, null);
  }
  const packet = finalizeOwnedHttpSubAgentOutboundPacket(plan.delivery.ownedFrame, document.parts);
  if (packet.packetReceipt !== plan.delivery.packetReceipt) {
    throw new TypeError('HTTP delivery response packet receipt does not match its packet.');
  }
  return freezeDecodedResponse(
    plan,
    Object.freeze({
      cursor: plan.delivery.cursor,
      packetReceipt: packet.packetReceipt,
      packet: packet.packet,
    }),
  );
}

function ownPollRequestContext(
  routeValue: unknown,
  commandValue: unknown,
): OwnedPollRequestContext {
  const route = ownPollRoute(routeValue);
  const command = ownPollCommand(commandValue);
  if (command.channelGeneration !== INITIAL_CHANNEL_GENERATION) {
    throw new TypeError('HTTP delivery response only supports the initial channel generation.');
  }
  return Object.freeze({
    route,
    command,
    requestReceipt: createHttpSubAgentPollRequestReceipt({ route, command }),
  });
}

function ownPollRoute(value: unknown): HttpSubAgentPollRoute {
  const record = requireClosedDataRecord(value, POLL_ROUTE_KEYS, 'HTTP poll route');
  const parsed = parseHttpSubAgentRoute('POST', record.requestTarget);
  if (record.id !== 'jobs.poll' || parsed.id !== 'jobs.poll') {
    throw new TypeError('HTTP poll route fields do not match its canonical request-target.');
  }
  if (record.jobId !== parsed.jobId) {
    throw new TypeError('HTTP poll route fields do not match its canonical request-target.');
  }
  return Object.freeze({
    id: 'jobs.poll',
    requestTarget: parsed.requestTarget,
    jobId: parsed.jobId,
  });
}

function ownPollCommand(value: unknown): HttpSubAgentPollCommand {
  return decodeHttpSubAgentPollCommand(
    encodeHttpSubAgentPollCommand(value as HttpSubAgentPollCommand),
  );
}

function createOwnedPollRequestReceipt(
  route: HttpSubAgentPollRoute,
  command: HttpSubAgentPollCommand,
): string {
  return canonicalJsonSha256({
    version: HTTP_SUBAGENT_DELIVERY_RESPONSE_VERSION,
    route: { id: route.id, jobId: route.jobId },
    command,
  } as unknown as JsonValue);
}

function ownDeliveryResult(
  value: unknown,
  command: HttpSubAgentPollCommand,
  limits: ResolvedHttpSubAgentMultipartLimits,
): OwnedDeliveryResult {
  const record = requireClosedDataRecord(value, RESULT_KEYS, 'HTTP delivery response result');
  if (record.deliveryVersion !== HTTP_SUBAGENT_DELIVERY_RESPONSE_VERSION) {
    throw new TypeError('HTTP delivery response result version must be exactly v1.');
  }
  const scalars = ownResponseScalars(record, command, 'HTTP delivery response result');
  return Object.freeze({
    ...scalars,
    delivery: ownDelivery(record.delivery, command, limits),
  });
}

function ownResponseScalars(
  record: Record<string, unknown>,
  command: HttpSubAgentPollCommand,
  label: string,
): Omit<OwnedDeliveryResult, 'delivery'> {
  const revision = requireCanonicalUint64Decimal(record.revision, `${label} revision`);
  if (record.channelId !== command.channelId) {
    throw new TypeError(`${label} channelId does not match the poll command.`);
  }
  if (
    record.channelGeneration !== INITIAL_CHANNEL_GENERATION ||
    record.channelGeneration !== command.channelGeneration
  ) {
    throw new TypeError(`${label} channelGeneration does not match the initial attachment.`);
  }
  if (record.ackCursor !== command.ackCursor) {
    throw new TypeError(`${label} ackCursor does not match the poll command.`);
  }
  return Object.freeze({
    revision,
    channelId: command.channelId,
    channelGeneration: INITIAL_CHANNEL_GENERATION,
    ackCursor: command.ackCursor,
  });
}

function ownDelivery(
  value: unknown,
  command: HttpSubAgentPollCommand,
  limits: ResolvedHttpSubAgentMultipartLimits,
): OwnedDelivery | null {
  if (value === null) return null;
  const record = requireClosedDataRecord(value, DELIVERY_KEYS, 'HTTP delivery response delivery');
  const cursor = requireExactNextCursor(record.cursor, command.ackCursor);
  const packetReceipt = requireLowerSha256(
    record.packetReceipt,
    'HTTP delivery response packetReceipt',
  );
  const packet: OwnedHttpSubAgentOutboundPacket = ownHttpSubAgentOutboundPacket(
    record.packet,
    command.channelId,
    limits,
  );
  if (packet.packetReceipt !== packetReceipt) {
    throw new TypeError('HTTP delivery response packet receipt does not match its packet.');
  }
  return Object.freeze({ cursor, packetReceipt, packet: packet.packet });
}

function decodeDeliveryDocumentPlan(
  json: string,
  request: OwnedPollRequestContext,
  limits: ResolvedHttpSubAgentMultipartLimits,
): Readonly<{
  value: DeliveryDocumentPlan;
  parts: readonly Readonly<{
    contentId: string;
    byteLength: number;
    context: SubAgentTransportArtifactSidecarDescriptor;
  }>[];
}> {
  const value = parseJsonValue(json, {
    maxBytes: limits.maxPacketJsonBytes,
    maxDepth: limits.maxJsonDepth,
    maxNodes: limits.maxJsonNodes,
    label: 'HTTP delivery response JSON',
  });
  const record = requireClosedDataRecord(value, DOCUMENT_KEYS, 'HTTP delivery response JSON');
  if (record.version !== HTTP_SUBAGENT_DELIVERY_RESPONSE_VERSION) {
    throw new TypeError('HTTP delivery response JSON version must be exactly v1.');
  }
  if (record.requestReceipt !== request.requestReceipt) {
    throw new TypeError('HTTP delivery response request receipt does not match the poll request.');
  }
  const scalars = ownResponseScalars(record, request.command, 'HTTP delivery response JSON');
  if (record.delivery === null) {
    return Object.freeze({
      value: Object.freeze({
        requestReceipt: request.requestReceipt,
        ...scalars,
        delivery: null,
      }),
      parts: Object.freeze([]),
    });
  }
  const delivery = requireClosedDataRecord(
    record.delivery,
    DELIVERY_KEYS,
    'HTTP delivery response JSON delivery',
  );
  const cursor = requireExactNextCursor(delivery.cursor, request.command.ackCursor);
  const packetReceipt = requireLowerSha256(
    delivery.packetReceipt,
    'HTTP delivery response JSON packetReceipt',
  );
  const packet = requireClosedDataRecord(
    delivery.packet,
    DELIVERY_PACKET_KEYS,
    'HTTP delivery response JSON packet',
  );
  if (packet.version !== HTTP_SUBAGENT_PACKET_VERSION) {
    throw new TypeError('HTTP delivery response packet version must be exactly v1.');
  }
  const ownedFrame: OwnedHttpSubAgentOutboundFrame = ownHttpSubAgentOutboundFrame(
    packet.frame,
    request.command.channelId,
    limits,
  );
  const descriptors = ownDeliveryDescriptors(packet.sidecars, limits);
  return Object.freeze({
    value: Object.freeze({
      requestReceipt: request.requestReceipt,
      ...scalars,
      delivery: Object.freeze({ cursor, packetReceipt, ownedFrame }),
    }),
    parts: Object.freeze(
      descriptors.map((descriptor) =>
        Object.freeze({
          contentId: descriptor.sidecarId,
          byteLength: descriptor.byteLength,
          context: descriptor,
        }),
      ),
    ),
  });
}

function ownDeliveryDescriptors(
  value: unknown,
  limits: HttpSubAgentOutboundPacketLimits,
): readonly SubAgentTransportArtifactSidecarDescriptor[] {
  const candidates = requireDenseDataArray(value, 'HTTP delivery response sidecar descriptors');
  if (candidates.length > limits.maxSidecars) {
    throw new RangeError('HTTP delivery response exceeds the configured sidecar count.');
  }
  const descriptors: SubAgentTransportArtifactSidecarDescriptor[] = [];
  const sidecarIds = new Set<string>();
  let totalBytes = 0;
  for (const candidate of candidates) {
    assertSubAgentTransportArtifactSidecarDescriptor(candidate, {
      maxBytes: limits.maxSidecarItemBytes,
    });
    if (sidecarIds.has(candidate.sidecarId)) {
      throw new TypeError('HTTP delivery response contains duplicate sidecar IDs.');
    }
    if (candidate.byteLength > limits.maxSidecarBytes - totalBytes) {
      throw new RangeError('HTTP delivery response exceeds the aggregate sidecar limit.');
    }
    sidecarIds.add(candidate.sidecarId);
    totalBytes += candidate.byteLength;
    descriptors.push(candidate);
  }
  return Object.freeze(descriptors);
}

function freezeDecodedResponse(
  plan: DeliveryDocumentPlan,
  delivery: OwnedDelivery | null,
): HttpSubAgentDeliveryResponseV1 {
  return Object.freeze({
    version: HTTP_SUBAGENT_DELIVERY_RESPONSE_VERSION,
    requestReceipt: plan.requestReceipt,
    revision: plan.revision,
    channelId: plan.channelId,
    channelGeneration: plan.channelGeneration,
    ackCursor: plan.ackCursor,
    delivery,
  });
}

function requireExactNextCursor(value: unknown, ackCursor: string): string {
  const cursor = requireCanonicalUint64Decimal(value, 'HTTP delivery response cursor');
  if (ackCursor === UINT64_MAX_DECIMAL || BigInt(cursor) !== BigInt(ackCursor) + 1n) {
    throw new TypeError(
      'HTTP delivery response cursor must exactly follow the acknowledged cursor.',
    );
  }
  return cursor;
}

function requireCanonicalUint64Decimal(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !UINT64_DECIMAL_PATTERN.test(value) ||
    (value.length === UINT64_MAX_DECIMAL.length && value > UINT64_MAX_DECIMAL) ||
    BigInt(value) > UINT64_MAX
  ) {
    throw new TypeError(`${label} must be a canonical uint64 decimal string.`);
  }
  return value;
}

function requireLowerSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !LOWER_SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function throwDeliveryCodecError(error: unknown): never {
  if (error instanceof RangeError) {
    throw new RangeError('HTTP delivery response exceeds a configured protocol limit.');
  }
  throw new TypeError('HTTP delivery response is invalid.');
}
