import { randomBytes } from 'node:crypto';

import { types as nodeTypes } from 'node:util';

import {
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
  assertSubAgentTransportArtifactSidecarDescriptor,
  decodeSubAgentTransportArtifactSidecar,
  decodeSubAgentTransportRpcFrame,
  parseJsonValue,
  type SubAgentTransportArtifactSidecar,
  type SubAgentTransportArtifactSidecarDescriptor,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

import { HTTP_SUBAGENT_PACKET_MEDIA_TYPE, HTTP_SUBAGENT_PACKET_VERSION } from './http-constants';
import {
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
  concatHttpBytes,
  copyHttpBytes,
  observedHttpByteLength,
  requireAllowedDataRecord,
  requireClosedDataRecord,
  requireDenseDataArray,
  type HttpBytes,
} from './http-internal';

/** Hard maximum for one complete signed multipart body. */
export const HTTP_SUBAGENT_MAX_MULTIPART_BODY_BYTES = 161 * 1024 * 1024;
/** Hard maximum for the closed first JSON part after frame string escaping. */
export const HTTP_SUBAGENT_MAX_PACKET_JSON_BYTES = 32 * 1024 * 1024 + 64 * 1024;
/** Hard maximum for one MIME part header block. */
export const HTTP_SUBAGENT_MAX_PART_HEADER_BYTES = 16 * 1024;
const MAX_BOUNDARY_BYTES = 70;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const BOUNDARY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,69}$/u;
const CONTENT_TYPE_PATTERN = /^multipart\/mixed; boundary=([A-Za-z0-9][A-Za-z0-9._-]{0,69})$/u;
const PACKET_KEYS = Object.freeze(['version', 'frame', 'sidecars'] as const);
const PEER_PACKET_KEYS = Object.freeze(['frame', 'sidecars'] as const);
const SIDECAR_KEYS = Object.freeze(['descriptor', 'data'] as const);
const LIMIT_KEYS = Object.freeze([
  'maxBodyBytes',
  'maxHeaderBytes',
  'maxPacketJsonBytes',
  'maxFrameBytes',
  'maxSidecars',
  'maxSidecarItemBytes',
  'maxSidecarBytes',
  'maxJsonDepth',
  'maxJsonNodes',
] as const);
const ENCODE_OPTION_KEYS = Object.freeze([...LIMIT_KEYS, 'boundary'] as const);

export interface HttpSubAgentMultipartLimits {
  readonly maxBodyBytes?: number;
  readonly maxHeaderBytes?: number;
  readonly maxPacketJsonBytes?: number;
  readonly maxFrameBytes?: number;
  readonly maxSidecars?: number;
  readonly maxSidecarItemBytes?: number;
  readonly maxSidecarBytes?: number;
  readonly maxJsonDepth?: number;
  readonly maxJsonNodes?: number;
}

export interface HttpSubAgentMultipartEncodeOptions extends HttpSubAgentMultipartLimits {
  /** Optional deterministic boundary for tests or a caller-owned request builder. */
  readonly boundary?: string;
}

export interface HttpSubAgentEncodedMultipartPacket {
  readonly contentType: string;
  readonly body: Uint8Array;
}

export interface HttpSubAgentMultipartInput {
  readonly contentType: string;
  readonly body: HttpBytes;
}

/** @internal Fully owned limits shared by the package-internal multipart codecs. */
export interface ResolvedHttpSubAgentMultipartLimits {
  readonly maxBodyBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxPacketJsonBytes: number;
  readonly maxFrameBytes: number;
  readonly maxSidecars: number;
  readonly maxSidecarItemBytes: number;
  readonly maxSidecarBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
}

/** @internal One already-owned binary part in a closed JSON + sidecar document. */
export interface HttpSubAgentMultipartDocumentPart {
  readonly contentId: string;
  readonly data: Uint8Array;
}

/** @internal One ordered binary-part declaration produced by the closed JSON decoder. */
export interface HttpSubAgentMultipartDocumentPartPlan<TContext> {
  readonly contentId: string;
  readonly byteLength: number;
  readonly context: TContext;
}

/** @internal The closed JSON value and its exact ordered binary-part declarations. */
export interface HttpSubAgentMultipartDocumentPlan<TValue, TPartContext> {
  readonly value: TValue;
  readonly parts: readonly HttpSubAgentMultipartDocumentPartPlan<TPartContext>[];
}

/** @internal Result of decoding a complete closed JSON + sidecar document. */
export interface HttpSubAgentMultipartDocument<TValue, TPart> {
  readonly value: TValue;
  readonly parts: readonly TPart[];
}

/** @internal Shared encoder input for a complete closed JSON + sidecar document. */
export interface HttpSubAgentMultipartDocumentEncodeInput {
  readonly boundary?: string;
  readonly firstPartMediaType: string;
  readonly firstPartJson: string;
  readonly firstPartLabel: string;
  readonly parts: readonly HttpSubAgentMultipartDocumentPart[];
}

/** @internal Shared decoder callbacks for a complete closed JSON + sidecar document. */
export interface HttpSubAgentMultipartDocumentDecodeOptions<TValue, TPartContext, TPart> {
  readonly firstPartMediaType: string;
  readonly firstPartLabel: string;
  readonly decodeFirstPart: (
    json: string,
  ) => HttpSubAgentMultipartDocumentPlan<TValue, TPartContext>;
  readonly decodePart: (context: TPartContext, bytes: Uint8Array, index: number) => TPart;
}

/** @internal Validates and owns multipart limits before any request side effect. */
export function normalizeHttpSubAgentMultipartLimits(
  options: HttpSubAgentMultipartLimits = {},
): HttpSubAgentMultipartLimits {
  return resolveHttpSubAgentMultipartLimits(options);
}

/** Encodes one complete Peer packet into a signed-body-ready multipart/mixed byte sequence. */
export function encodeHttpSubAgentMultipartPacket(
  packet: SubAgentTransportPeerPacket,
  options: HttpSubAgentMultipartEncodeOptions = {},
): HttpSubAgentEncodedMultipartPacket {
  const limits = resolveHttpSubAgentMultipartLimits(options, true);
  const record = requireClosedDataRecord(packet, PEER_PACKET_KEYS, 'HTTP Peer packet');
  const frame = ownFrame(record.frame, limits);
  const sidecarValues = requireDenseDataArray(record.sidecars, 'HTTP Peer packet sidecars');
  if (sidecarValues.length > limits.maxSidecars) {
    throw new RangeError('HTTP Peer packet exceeds the configured sidecar count.');
  }

  const sidecars: SubAgentTransportArtifactSidecar[] = [];
  const sidecarIds = new Set<string>();
  let sidecarBytes = 0;
  for (let index = 0; index < sidecarValues.length; index += 1) {
    const value = sidecarValues[index];
    const sidecar = requireClosedDataRecord(value, SIDECAR_KEYS, `HTTP sidecar ${index}`);
    const decoded = decodeSubAgentTransportArtifactSidecar(
      sidecar.descriptor,
      sidecar.data as HttpBytes,
      {
        maxBytes: limits.maxSidecarItemBytes,
      },
    );
    if (sidecarIds.has(decoded.descriptor.sidecarId)) {
      throw new TypeError('HTTP Peer packet contains duplicate sidecar IDs.');
    }
    sidecarIds.add(decoded.descriptor.sidecarId);
    sidecarBytes = addBounded(
      sidecarBytes,
      decoded.data.byteLength,
      limits.maxSidecarBytes,
      'HTTP Peer packet exceeds the configured aggregate sidecar bytes.',
    );
    sidecars.push(decoded);
  }

  const boundary = resolveHttpSubAgentMultipartBoundary(options.boundary);
  const descriptorRecords: SubAgentTransportArtifactSidecarDescriptor[] = [];
  for (const sidecar of sidecars) descriptorRecords.push(sidecar.descriptor);
  const packetJson = JSON.stringify({
    version: HTTP_SUBAGENT_PACKET_VERSION,
    frame,
    sidecars: descriptorRecords,
  });
  const jsonBytes = UTF8_ENCODER.encode(packetJson);
  if (jsonBytes.byteLength > limits.maxPacketJsonBytes) {
    throw new RangeError('HTTP multipart packet JSON exceeds the configured byte limit.');
  }
  parseJsonValue(packetJson, {
    maxBytes: limits.maxPacketJsonBytes,
    maxDepth: limits.maxJsonDepth,
    maxNodes: limits.maxJsonNodes,
    label: 'HTTP multipart packet JSON',
  });

  return encodeHttpSubAgentMultipartDocument(
    {
      boundary,
      firstPartMediaType: HTTP_SUBAGENT_PACKET_MEDIA_TYPE,
      firstPartJson: packetJson,
      firstPartLabel: 'HTTP multipart packet JSON',
      parts: sidecars.map((sidecar) => ({
        contentId: sidecar.descriptor.sidecarId,
        data: sidecar.data,
      })),
    },
    limits,
  );
}

/**
 * @internal Encodes an exact closed JSON + ordered binary-sidecar multipart document.
 * The calling codec must first own and validate the media type, JSON, content IDs, part bytes,
 * and resolved limits; this shared serializer deliberately does not expose a second schema layer.
 */
export function encodeHttpSubAgentMultipartDocument(
  input: HttpSubAgentMultipartDocumentEncodeInput,
  limits: ResolvedHttpSubAgentMultipartLimits,
): HttpSubAgentEncodedMultipartPacket {
  const boundary = resolveHttpSubAgentMultipartBoundary(input.boundary);
  const jsonBytes = UTF8_ENCODER.encode(input.firstPartJson);
  if (jsonBytes.byteLength > limits.maxPacketJsonBytes) {
    throw new RangeError(`${input.firstPartLabel} exceeds the configured byte limit.`);
  }

  const firstHeaders = ascii(`Content-Type: ${input.firstPartMediaType}`);
  assertHeaderBytes(firstHeaders, limits.maxHeaderBytes);
  const chunks: Uint8Array[] = [
    ascii(`--${boundary}\r\n`),
    firstHeaders,
    ascii('\r\n\r\n'),
    jsonBytes,
  ];
  for (const part of input.parts) {
    const partHeaders = ascii(
      `Content-Type: application/octet-stream\r\nContent-ID: ${part.contentId}`,
    );
    assertHeaderBytes(partHeaders, limits.maxHeaderBytes);
    chunks.push(ascii(`\r\n--${boundary}\r\n`), partHeaders, ascii('\r\n\r\n'), part.data);
  }
  chunks.push(ascii(`\r\n--${boundary}--\r\n`));
  const body = concatHttpBytes(chunks, limits.maxBodyBytes);
  return Object.freeze({
    contentType: `multipart/mixed; boundary=${boundary}`,
    body,
  });
}

/**
 * Strictly decodes and validates a whole multipart packet before returning any frame or sidecar.
 * Binary parts are consumed by their signed descriptor lengths rather than by scanning payloads.
 */
export function decodeHttpSubAgentMultipartPacket(
  input: HttpSubAgentMultipartInput,
  options: HttpSubAgentMultipartLimits = {},
): SubAgentTransportPeerPacket {
  const limits = resolveHttpSubAgentMultipartLimits(options);
  const record = requireClosedDataRecord(input, ['contentType', 'body'], 'HTTP multipart input');
  if (typeof record.contentType !== 'string') {
    throw new TypeError('HTTP multipart contentType must be a string.');
  }
  const body = copyHttpBytes(record.body as HttpBytes, 'HTTP multipart body', limits.maxBodyBytes);
  return decodeOwnedMultipartBody(record.contentType, body, limits);
}

/** @internal Reuses a body already owned by the HMAC verifier; not exported from the package root. */
export function decodeOwnedHttpSubAgentMultipartPacket(
  input: HttpSubAgentMultipartInput,
  options: HttpSubAgentMultipartLimits = {},
): SubAgentTransportPeerPacket {
  const limits = resolveHttpSubAgentMultipartLimits(options);
  const record = requireClosedDataRecord(
    input,
    ['contentType', 'body'],
    'Owned HTTP multipart input',
  );
  if (
    typeof record.contentType !== 'string' ||
    nodeTypes.isProxy(record.body) ||
    !nodeTypes.isUint8Array(record.body)
  ) {
    throw new TypeError('Owned HTTP multipart input is invalid.');
  }
  const bodyLength = observedHttpByteLength(record.body, 'Owned HTTP multipart body');
  if (bodyLength > limits.maxBodyBytes) {
    throw new RangeError('Owned HTTP multipart body exceeds the configured byte limit.');
  }
  return decodeOwnedMultipartBody(record.contentType, record.body, limits);
}

function decodeOwnedMultipartBody(
  contentType: string,
  body: Uint8Array,
  limits: ResolvedHttpSubAgentMultipartLimits,
): SubAgentTransportPeerPacket {
  const document = decodeOwnedHttpSubAgentMultipartDocument(contentType, body, limits, {
    firstPartMediaType: HTTP_SUBAGENT_PACKET_MEDIA_TYPE,
    firstPartLabel: 'HTTP multipart packet JSON',
    decodeFirstPart: (packetJson) => {
      const packetValue = parseJsonValue(packetJson, {
        maxBytes: limits.maxPacketJsonBytes,
        maxDepth: limits.maxJsonDepth,
        maxNodes: limits.maxJsonNodes,
        label: 'HTTP multipart packet JSON',
      });
      const packet = requireClosedDataRecord(
        packetValue,
        PACKET_KEYS,
        'HTTP multipart packet JSON',
      );
      if (packet.version !== HTTP_SUBAGENT_PACKET_VERSION || typeof packet.frame !== 'string') {
        throw new TypeError('HTTP multipart packet version or frame is invalid.');
      }
      const frameBytes = UTF8_ENCODER.encode(packet.frame);
      if (frameBytes.byteLength > limits.maxFrameBytes) {
        throw new RangeError('HTTP multipart frame exceeds the configured byte limit.');
      }
      decodeSubAgentTransportRpcFrame(packet.frame, {
        maxFrameBytes: limits.maxFrameBytes,
        maxJsonDepth: limits.maxJsonDepth,
        maxJsonNodes: limits.maxJsonNodes,
      });

      const descriptorValues = requireDenseDataArray(
        packet.sidecars,
        'HTTP multipart sidecar descriptors',
      );
      if (descriptorValues.length > limits.maxSidecars) {
        throw new RangeError('HTTP multipart exceeds the configured sidecar count.');
      }
      const descriptors: SubAgentTransportArtifactSidecarDescriptor[] = [];
      const ids = new Set<string>();
      let aggregateBytes = 0;
      for (const value of descriptorValues) {
        assertSubAgentTransportArtifactSidecarDescriptor(value, {
          maxBytes: limits.maxSidecarItemBytes,
        });
        if (ids.has(value.sidecarId)) {
          throw new TypeError('HTTP multipart contains duplicate sidecar IDs.');
        }
        ids.add(value.sidecarId);
        aggregateBytes = addBounded(
          aggregateBytes,
          value.byteLength,
          limits.maxSidecarBytes,
          'HTTP multipart exceeds the configured aggregate sidecar bytes.',
        );
        descriptors.push(value);
      }

      return {
        value: packet.frame,
        parts: descriptors.map((descriptor) => ({
          contentId: descriptor.sidecarId,
          byteLength: descriptor.byteLength,
          context: descriptor,
        })),
      };
    },
    decodePart: (descriptor, bytes) =>
      decodeSubAgentTransportArtifactSidecar(descriptor, bytes, {
        maxBytes: limits.maxSidecarItemBytes,
      }),
  });

  return Object.freeze({ frame: document.value, sidecars: document.parts });
}

/**
 * @internal Decodes one exact closed JSON + ordered binary-sidecar multipart document.
 * Binary payloads are consumed by lengths returned from the validated first-part callback.
 * The calling codec must supply an owned, bounded, non-Proxy body and synchronous internal
 * callbacks. Its plan must already enforce count, content-ID, safe length, and aggregate limits;
 * decodePart must return an owned value and neither callback may perform external side effects.
 */
export function decodeOwnedHttpSubAgentMultipartDocument<TValue, TPartContext, TPart>(
  contentType: string,
  body: Uint8Array,
  limits: ResolvedHttpSubAgentMultipartLimits,
  options: HttpSubAgentMultipartDocumentDecodeOptions<TValue, TPartContext, TPart>,
): HttpSubAgentMultipartDocument<TValue, TPart> {
  const boundaryMatch = CONTENT_TYPE_PATTERN.exec(contentType);
  if (boundaryMatch === null) {
    throw new TypeError('HTTP multipart Content-Type is not the exact v1 media type.');
  }
  const boundary = boundaryMatch[1] as string;
  assertBoundary(boundary);
  const cursor = new MultipartCursor(body, boundary, limits.maxHeaderBytes);

  cursor.expectOpeningBoundary();
  const firstHeaders = cursor.readHeaders();
  assertExactHeaders(firstHeaders, [['Content-Type', options.firstPartMediaType]]);
  const firstPartBytes = cursor.readUntilBoundary(
    limits.maxPacketJsonBytes,
    options.firstPartLabel,
  );
  const firstPartJson = decodeUtf8(firstPartBytes, options.firstPartLabel);
  const plan = options.decodeFirstPart(firstPartJson);

  const parts: TPart[] = [];
  for (let index = 0; index < plan.parts.length; index += 1) {
    const part = plan.parts[index] as HttpSubAgentMultipartDocumentPartPlan<TPartContext>;
    cursor.expectNextPart();
    const headers = cursor.readHeaders();
    assertExactHeaders(headers, [
      ['Content-Type', 'application/octet-stream'],
      ['Content-ID', part.contentId],
    ]);
    const bytes = cursor.readBytes(part.byteLength);
    parts.push(options.decodePart(part.context, bytes, index));
    cursor.expectBoundaryAfterBinary(index === plan.parts.length - 1);
  }
  if (plan.parts.length === 0) cursor.expectClosingBoundary();
  cursor.expectEnd();

  return Object.freeze({ value: plan.value, parts: Object.freeze(parts) });
}

function ownFrame(value: unknown, limits: ResolvedHttpSubAgentMultipartLimits): string {
  let frame: string;
  if (typeof value === 'string') {
    frame = value;
  } else {
    const bytes = copyHttpBytes(value as HttpBytes, 'HTTP Peer packet frame', limits.maxFrameBytes);
    frame = decodeUtf8(bytes, 'HTTP Peer packet frame');
  }
  if (UTF8_ENCODER.encode(frame).byteLength > limits.maxFrameBytes) {
    throw new RangeError('HTTP Peer packet frame exceeds the configured byte limit.');
  }
  decodeSubAgentTransportRpcFrame(frame, {
    maxFrameBytes: limits.maxFrameBytes,
    maxJsonDepth: limits.maxJsonDepth,
    maxJsonNodes: limits.maxJsonNodes,
  });
  return frame;
}

/** @internal Resolves the shared multipart limits without widening package-root exports. */
export function resolveHttpSubAgentMultipartLimits(
  options: HttpSubAgentMultipartLimits,
  allowBoundary = false,
): ResolvedHttpSubAgentMultipartLimits {
  requireAllowedDataRecord(
    options,
    allowBoundary ? ENCODE_OPTION_KEYS : LIMIT_KEYS,
    'HTTP multipart limits',
  );
  const maxBodyBytes = options.maxBodyBytes ?? HTTP_SUBAGENT_MAX_MULTIPART_BODY_BYTES;
  const maxHeaderBytes = options.maxHeaderBytes ?? HTTP_SUBAGENT_MAX_PART_HEADER_BYTES;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES;
  const maxSidecars = options.maxSidecars ?? DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS;
  const maxSidecarItemBytes =
    options.maxSidecarItemBytes ?? DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES;
  const maxSidecarBytes =
    options.maxSidecarBytes ?? DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES;
  const defaultPacketJsonBytes = Math.min(
    HTTP_SUBAGENT_MAX_PACKET_JSON_BYTES,
    maxBodyBytes,
    maxFrameBytes * 2 + maxSidecars * 4_096 + 4_096,
  );
  const maxPacketJsonBytes = options.maxPacketJsonBytes ?? defaultPacketJsonBytes;
  const maxJsonDepth = options.maxJsonDepth ?? DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH;
  const maxJsonNodes = options.maxJsonNodes ?? DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES;
  assertPositiveSafeInteger(maxBodyBytes, 'HTTP multipart maxBodyBytes');
  assertPositiveSafeInteger(maxHeaderBytes, 'HTTP multipart maxHeaderBytes');
  assertPositiveSafeInteger(maxPacketJsonBytes, 'HTTP multipart maxPacketJsonBytes');
  assertPositiveSafeInteger(maxFrameBytes, 'HTTP multipart maxFrameBytes');
  assertNonNegativeSafeInteger(maxSidecars, 'HTTP multipart maxSidecars');
  assertPositiveSafeInteger(maxSidecarItemBytes, 'HTTP multipart maxSidecarItemBytes');
  assertNonNegativeSafeInteger(maxSidecarBytes, 'HTTP multipart maxSidecarBytes');
  assertNonNegativeSafeInteger(maxJsonDepth, 'HTTP multipart maxJsonDepth');
  assertPositiveSafeInteger(maxJsonNodes, 'HTTP multipart maxJsonNodes');
  assertAtMost(maxBodyBytes, HTTP_SUBAGENT_MAX_MULTIPART_BODY_BYTES, 'HTTP multipart maxBodyBytes');
  assertAtMost(
    maxHeaderBytes,
    HTTP_SUBAGENT_MAX_PART_HEADER_BYTES,
    'HTTP multipart maxHeaderBytes',
  );
  assertAtMost(
    maxPacketJsonBytes,
    HTTP_SUBAGENT_MAX_PACKET_JSON_BYTES,
    'HTTP multipart maxPacketJsonBytes',
  );
  assertAtMost(
    maxFrameBytes,
    DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
    'HTTP multipart maxFrameBytes',
  );
  assertAtMost(
    maxSidecars,
    DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
    'HTTP multipart maxSidecars',
  );
  assertAtMost(
    maxSidecarItemBytes,
    DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
    'HTTP multipart maxSidecarItemBytes',
  );
  assertAtMost(
    maxSidecarBytes,
    DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES,
    'HTTP multipart maxSidecarBytes',
  );
  assertAtMost(
    maxJsonDepth,
    DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
    'HTTP multipart maxJsonDepth',
  );
  assertAtMost(
    maxJsonNodes,
    DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
    'HTTP multipart maxJsonNodes',
  );
  if (maxSidecarItemBytes > maxSidecarBytes && maxSidecars > 0) {
    throw new RangeError('HTTP multipart item bytes must not exceed aggregate sidecar bytes.');
  }
  if (maxPacketJsonBytes > maxBodyBytes) {
    throw new RangeError('HTTP multipart packet JSON bytes must not exceed body bytes.');
  }
  return Object.freeze({
    maxBodyBytes,
    maxHeaderBytes,
    maxPacketJsonBytes,
    maxFrameBytes,
    maxSidecars,
    maxSidecarItemBytes,
    maxSidecarBytes,
    maxJsonDepth,
    maxJsonNodes,
  });
}

/** @internal Generates or validates the one canonical boundary form shared by HTTP codecs. */
export function resolveHttpSubAgentMultipartBoundary(value?: string): string {
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError('HTTP multipart boundary must be a string.');
  }
  const boundary = value ?? `manee-${randomBytes(24).toString('base64url')}`;
  assertBoundary(boundary);
  return boundary;
}

function assertBoundary(value: string): void {
  if (UTF8_ENCODER.encode(value).byteLength > MAX_BOUNDARY_BYTES || !BOUNDARY_PATTERN.test(value)) {
    throw new TypeError('HTTP multipart boundary is not a canonical MIME token.');
  }
}

function ascii(value: string): Uint8Array {
  if (/[^\x20-\x7e\r\n]/u.test(value)) {
    throw new TypeError('HTTP multipart protocol text must be ASCII.');
  }
  return UTF8_ENCODER.encode(value);
}

function decodeUtf8(value: Uint8Array, label: string): string {
  try {
    return UTF8_DECODER.decode(value);
  } catch {
    throw new TypeError(`${label} must be valid UTF-8.`);
  }
}

function addBounded(current: number, next: number, maximum: number, message: string): number {
  const total = current + next;
  if (!Number.isSafeInteger(total) || total > maximum) throw new RangeError(message);
  return total;
}

function assertAtMost(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new RangeError(`${label} exceeds the protocol hard maximum.`);
}

function assertHeaderBytes(value: Uint8Array, maximum: number): void {
  if (value.byteLength > maximum) {
    throw new RangeError('HTTP multipart part headers exceed the configured byte limit.');
  }
}

function assertExactHeaders(
  actual: readonly (readonly [string, string])[],
  expected: readonly (readonly [string, string])[],
): void {
  if (
    actual.length !== expected.length ||
    actual.some(
      (header, index) => header[0] !== expected[index]?.[0] || header[1] !== expected[index]?.[1],
    )
  ) {
    throw new TypeError('HTTP multipart part headers do not match the closed v1 schema.');
  }
}

class MultipartCursor {
  readonly #body: Uint8Array;
  readonly #boundary: Uint8Array;
  readonly #openingBoundary: Uint8Array;
  readonly #nextBoundary: Uint8Array;
  readonly #maxHeaderBytes: number;
  #offset = 0;

  constructor(body: Uint8Array, boundary: string, maxHeaderBytes: number) {
    this.#body = body;
    this.#boundary = ascii(`--${boundary}`);
    this.#openingBoundary = ascii(`--${boundary}\r\n`);
    this.#nextBoundary = ascii(`\r\n--${boundary}`);
    this.#maxHeaderBytes = maxHeaderBytes;
  }

  expectOpeningBoundary(): void {
    this.#expect(this.#openingBoundary);
  }

  readHeaders(): readonly (readonly [string, string])[] {
    const terminator = ascii('\r\n\r\n');
    const end = indexOfBytes(this.#body, terminator, this.#offset, this.#maxHeaderBytes + 1);
    if (end < 0 || end - this.#offset > this.#maxHeaderBytes) {
      throw new RangeError('HTTP multipart part headers exceed the configured byte limit.');
    }
    const source = this.#body.subarray(this.#offset, end);
    for (let index = 0; index < source.byteLength; index += 1) {
      const byte = source[index] as number;
      if ((byte < 0x20 && byte !== 0x0d && byte !== 0x0a) || byte > 0x7e) {
        throw new TypeError('HTTP multipart part headers must be printable ASCII.');
      }
    }
    const text = decodeUtf8(source, 'HTTP multipart part headers');
    this.#offset = end + terminator.byteLength;
    if (text.length === 0) throw new TypeError('HTTP multipart part headers are required.');
    return Object.freeze(
      text.split('\r\n').map((line) => {
        const separator = line.indexOf(': ');
        if (separator < 1 || line.indexOf(': ', separator + 2) >= 0) {
          throw new TypeError('HTTP multipart part header syntax is invalid.');
        }
        const name = line.slice(0, separator);
        const value = line.slice(separator + 2);
        if (!/^[A-Za-z0-9-]+$/u.test(name) || value.length === 0 || /[\s,]/u.test(value)) {
          throw new TypeError('HTTP multipart part header name or value is invalid.');
        }
        return Object.freeze([name, value] as const);
      }),
    );
  }

  readUntilBoundary(maxBytes: number, label: string): Uint8Array {
    const end = indexOfBytes(this.#body, this.#nextBoundary, this.#offset, maxBytes + 1);
    if (end < 0) throw new TypeError(`${label} is not terminated.`);
    if (end - this.#offset > maxBytes) {
      throw new RangeError(`${label} exceeds the configured byte limit.`);
    }
    const result = this.#body.subarray(this.#offset, end);
    this.#offset = end + 2 + this.#boundary.byteLength;
    return result;
  }

  expectNextPart(): void {
    this.#expect(ascii('\r\n'));
  }

  readBytes(byteLength: number): Uint8Array {
    const end = this.#offset + byteLength;
    if (!Number.isSafeInteger(end) || end > this.#body.byteLength) {
      throw new TypeError('HTTP multipart binary part is truncated.');
    }
    const result = this.#body.subarray(this.#offset, end);
    this.#offset = end;
    return result;
  }

  expectBoundaryAfterBinary(last: boolean): void {
    this.#expect(this.#nextBoundary);
    if (last) this.#expect(ascii('--\r\n'));
  }

  expectClosingBoundary(): void {
    this.#expect(ascii('--\r\n'));
  }

  expectEnd(): void {
    if (this.#offset !== this.#body.byteLength) {
      throw new TypeError('HTTP multipart body contains trailing bytes.');
    }
  }

  #expect(expected: Uint8Array): void {
    if (!matchesBytes(this.#body, expected, this.#offset)) {
      throw new TypeError('HTTP multipart body structure is invalid.');
    }
    this.#offset += expected.byteLength;
  }
}

function matchesBytes(source: Uint8Array, expected: Uint8Array, offset: number): boolean {
  if (offset + expected.byteLength > source.byteLength) return false;
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (source[offset + index] !== expected[index]) return false;
  }
  return true;
}

function indexOfBytes(
  source: Uint8Array,
  expected: Uint8Array,
  offset: number,
  maxDistance = Number.POSITIVE_INFINITY,
): number {
  if (expected.byteLength === 0) return offset <= source.byteLength ? offset : -1;
  const limit = Math.min(source.byteLength, offset + maxDistance + expected.byteLength);
  const prefix = new Uint32Array(expected.byteLength);
  for (let index = 1, matched = 0; index < expected.byteLength; index += 1) {
    while (matched > 0 && expected[index] !== expected[matched]) matched = prefix[matched - 1]!;
    if (expected[index] === expected[matched]) matched += 1;
    prefix[index] = matched;
  }
  for (let index = offset, matched = 0; index < limit; index += 1) {
    while (matched > 0 && source[index] !== expected[matched]) matched = prefix[matched - 1]!;
    if (source[index] === expected[matched]) matched += 1;
    if (matched === expected.byteLength) {
      const start = index - expected.byteLength + 1;
      return start - offset <= maxDistance ? start : -1;
    }
  }
  return -1;
}
