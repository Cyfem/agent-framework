import { types as nodeTypes } from 'node:util';

import {
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_CACHED_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES,
  assertSubAgentTransportArtifactSidecarDescriptor,
  decodeSubAgentTransportArtifactSidecar,
} from '@ruixutong.manee/maneeagent-framework';
import type {
  SubAgentTargetRunnerManifest,
  SubAgentTransportArtifactSidecar,
  SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

export const PROCESS_SUBAGENT_CHANNEL_VERSION = '1' as const;

const DEFAULT_MAX_PENDING_IPC_MESSAGES = 64;
const DEFAULT_MAX_PENDING_IPC_BYTES = DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_CACHED_BYTES;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer')
  ?.get as (this: Uint8Array) => ArrayBufferLike;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteOffset',
)?.get as (this: Uint8Array) => number;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get as (this: Uint8Array) => number;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;

export interface ProcessSubAgentBootstrapData {
  readonly version: typeof PROCESS_SUBAGENT_CHANNEL_VERSION;
  readonly jobId: string;
  readonly ownerSessionId: string;
  readonly executorName: string;
  readonly channelId: string;
}

export type ProcessSubAgentInboundMessage =
  | {
      readonly version: typeof PROCESS_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'bootstrap';
      readonly jobId: string;
      readonly ownerSessionId: string;
      readonly executorName: string;
      readonly channelId: string;
    }
  | {
      readonly version: typeof PROCESS_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'packet';
      readonly packet: ProcessSubAgentPacket;
    }
  | {
      readonly version: typeof PROCESS_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'shutdown';
    };

export type ProcessSubAgentOutboundMessage =
  | {
      readonly version: typeof PROCESS_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'ready';
      readonly manifest: SubAgentTargetRunnerManifest;
    }
  | {
      readonly version: typeof PROCESS_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'packet';
      readonly packet: ProcessSubAgentPacket;
    }
  | {
      readonly version: typeof PROCESS_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'fatal';
      readonly code: 'TARGET_START_FAILED' | 'TARGET_PROTOCOL_FAILED';
    }
  | {
      readonly version: typeof PROCESS_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'stopped';
    };

export type ProcessSubAgentChannelMessage =
  | ProcessSubAgentInboundMessage
  | ProcessSubAgentOutboundMessage;

export interface ProcessSubAgentIpcWriter {
  readonly pendingMessages: number;
  readonly pendingBytes: number;
  assertCapacity(bytes: number): void;
  write(message: ProcessSubAgentChannelMessage): {
    readonly admitted: true;
    readonly settled: PromiseLike<void>;
  };
  close(reason?: unknown): void;
}

export interface CreateProcessSubAgentIpcWriterOptions {
  readonly connected: () => boolean;
  readonly send: (
    message: ProcessSubAgentChannelMessage,
    callback: (error: Error | null) => void,
  ) => void;
  readonly maxPendingMessages?: number;
  readonly maxPendingBytes?: number;
  readonly onFailure?: () => void;
}

/**
 * Owns a bounded FIFO in front of Node IPC. `child.send() === false` only means backpressure, so
 * admission is decided before calling Node and I/O settlement is tied exclusively to its callback.
 */
export function createProcessSubAgentIpcWriter(
  options: CreateProcessSubAgentIpcWriterOptions,
): ProcessSubAgentIpcWriter {
  const maxMessages = options.maxPendingMessages ?? DEFAULT_MAX_PENDING_IPC_MESSAGES;
  const maxBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_IPC_BYTES;
  if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) {
    throw new TypeError('Process IPC maxPendingMessages must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('Process IPC maxPendingBytes must be a positive safe integer.');
  }

  type Entry = {
    readonly message: ProcessSubAgentChannelMessage;
    readonly bytes: number;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
    readonly promise: Promise<void>;
    exposed: boolean;
    settled: boolean;
  };
  const queue: Entry[] = [];
  let pendingBytes = 0;
  let active = false;
  let closed = false;
  let closedReason: unknown;

  const fail = (entry: Entry, reason: unknown): void => {
    if (entry.settled) return;
    entry.settled = true;
    pendingBytes -= entry.bytes;
    entry.reject(reason);
  };
  const succeed = (entry: Entry): void => {
    if (entry.settled) return;
    entry.settled = true;
    pendingBytes -= entry.bytes;
    entry.resolve();
  };
  const failAll = (reason: unknown, reportFailure = true): void => {
    const entries = queue.splice(0);
    active = false;
    for (const entry of entries) fail(entry, reason);
    if (reportFailure) options.onFailure?.();
  };
  const pump = (propagateSynchronousFailure = false): void => {
    if (active || closed) return;
    const entry = queue[0];
    if (entry === undefined) return;
    if (!options.connected()) {
      closed = true;
      closedReason = new Error('The Process IPC channel is closed.');
      failAll(closedReason);
      return;
    }
    active = true;
    try {
      options.send(entry.message, (error) => {
        if (queue[0] !== entry) return;
        queue.shift();
        active = false;
        if (error === null) succeed(entry);
        else fail(entry, new Error('The Process IPC write failed.'));
        if (error !== null) {
          closed = true;
          closedReason = new Error('The Process IPC writer failed.');
          failAll(closedReason);
          return;
        }
        pump();
      });
    } catch {
      queue.shift();
      active = false;
      const failure = new Error(
        entry.exposed
          ? 'The Process IPC writer failed.'
          : 'The Process IPC write failed before admission.',
      );
      if (!entry.exposed) void entry.promise.catch(() => undefined);
      fail(entry, failure);
      closed = true;
      closedReason = new Error('The Process IPC writer failed.');
      failAll(closedReason);
      if (propagateSynchronousFailure && !entry.exposed) throw closedReason;
    }
  };
  const assertCapacity = (bytes: number): void => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError('Process IPC message byte estimate must be a non-negative safe integer.');
    }
    if (closed || !options.connected()) {
      throw closedReason ?? new Error('The Process IPC channel is closed.');
    }
    if (queue.length >= maxMessages || bytes > maxBytes - pendingBytes) {
      throw new Error('The Process IPC outbound queue capacity is exhausted.');
    }
  };

  return Object.freeze({
    get pendingMessages(): number {
      return queue.length;
    },
    get pendingBytes(): number {
      return pendingBytes;
    },
    assertCapacity,
    write(message: ProcessSubAgentChannelMessage) {
      const bytes = estimateMessageBytes(message);
      assertCapacity(bytes);
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const settled = new Promise<void>((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      const entry: Entry = {
        message,
        bytes,
        resolve,
        reject,
        promise: settled,
        exposed: false,
        settled: false,
      };
      queue.push(entry);
      pendingBytes += bytes;
      pump(true);
      entry.exposed = true;
      return Object.freeze({ admitted: true as const, settled });
    },
    close(reason: unknown = new Error('The Process IPC writer was closed.')): void {
      if (closed) return;
      closed = true;
      closedReason = reason;
      failAll(reason, false);
    },
  });
}

interface ProcessSubAgentPacket {
  readonly frame: string | Uint8Array;
  readonly sidecars: readonly ProcessSubAgentSidecar[];
}

interface ProcessSubAgentSidecar {
  readonly descriptor: SubAgentTransportArtifactSidecar['descriptor'];
  readonly bytes: Uint8Array;
}

export function decodeProcessBootstrapData(value: unknown): ProcessSubAgentBootstrapData {
  const record = requireClosedRecord(
    value,
    ['channelId', 'executorName', 'jobId', 'ownerSessionId', 'version'],
    'Process bootstrap data',
  );
  if (record.version !== PROCESS_SUBAGENT_CHANNEL_VERSION) {
    throw new TypeError('The Process bootstrap protocol version is unsupported.');
  }
  assertIdentifier(record.jobId, 'Process bootstrap jobId');
  assertTransportIdentifier(record.ownerSessionId, 'Process bootstrap ownerSessionId');
  assertIdentifier(record.executorName, 'Process bootstrap executorName');
  assertIdentifier(record.channelId, 'Process bootstrap channelId');
  return Object.freeze({
    version: PROCESS_SUBAGENT_CHANNEL_VERSION,
    jobId: record.jobId,
    ownerSessionId: record.ownerSessionId,
    executorName: record.executorName,
    channelId: record.channelId,
  });
}

export function encodeProcessPacket(packet: SubAgentTransportPeerPacket): ProcessSubAgentPacket {
  estimateProcessPacketBytes(packet);
  const frame =
    typeof packet.frame === 'string'
      ? assertBoundedFrameString(packet.frame)
      : copyPlainBytes(packet.frame, DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES, 'frame');
  if (packet.sidecars.length > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS) {
    throw new RangeError('Process transport packet has too many sidecars.');
  }
  let totalSidecarBytes = 0;
  const sidecars = packet.sidecars.map((sidecar) =>
    (() => {
      const bytes = copyPlainBytes(
        sidecar.data,
        DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
        'sidecar',
      );
      totalSidecarBytes += bytes.byteLength;
      if (totalSidecarBytes > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES) {
        throw new RangeError('Process transport sidecars exceed the aggregate byte limit.');
      }
      return Object.freeze({ descriptor: sidecar.descriptor, bytes });
    })(),
  );
  return Object.freeze({ frame, sidecars: Object.freeze(sidecars) });
}

export function estimateProcessPacketBytes(packet: SubAgentTransportPeerPacket): number {
  const frameBytes =
    typeof packet.frame === 'string'
      ? Buffer.byteLength(assertBoundedFrameString(packet.frame))
      : plainByteLength(packet.frame, 'frame');
  if (frameBytes > DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES) {
    throw new RangeError('Process transport frame exceeds its byte limit.');
  }
  if (packet.sidecars.length > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS) {
    throw new RangeError('Process transport packet has too many sidecars.');
  }
  let sidecarBytes = 0;
  let descriptorBytes = 0;
  for (const sidecar of packet.sidecars) {
    const bytes = plainByteLength(sidecar.data, 'sidecar');
    if (bytes > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES) {
      throw new RangeError('Process transport sidecar exceeds the item byte limit.');
    }
    sidecarBytes += bytes;
    if (sidecarBytes > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES) {
      throw new RangeError('Process transport sidecars exceed the aggregate byte limit.');
    }
    descriptorBytes += Buffer.byteLength(JSON.stringify(sidecar.descriptor));
  }
  const total = frameBytes + sidecarBytes + descriptorBytes + 128;
  if (total > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_CACHED_BYTES) {
    throw new RangeError('Process transport packet exceeds the total byte limit.');
  }
  return total;
}

export function decodeProcessPacket(value: unknown): SubAgentTransportPeerPacket {
  const packet = requireClosedRecord(value, ['frame', 'sidecars'], 'Process transport packet');
  if (typeof packet.frame !== 'string' && !isPlainByteSequence(packet.frame)) {
    throw new TypeError('Process transport packet frame must be a string or Uint8Array.');
  }
  const frameBytes =
    typeof packet.frame === 'string'
      ? Buffer.byteLength(assertBoundedFrameString(packet.frame))
      : plainByteLength(packet.frame, 'frame');
  if (frameBytes > DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES) {
    throw new RangeError('Process transport frame exceeds its byte limit.');
  }
  const encodedSidecars = requireSafeArray(
    packet.sidecars,
    'Process transport packet sidecars',
    DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
  );
  const preflight: Array<
    Readonly<{
      descriptor: unknown;
      bytes: Uint8Array;
    }>
  > = [];
  let totalSidecarBytes = 0;
  let descriptorBytes = 0;
  for (let index = 0; index < encodedSidecars.length; index += 1) {
    const value = encodedSidecars[index];
    const sidecar = requireClosedRecord(
      value,
      ['bytes', 'descriptor'],
      `Process transport sidecar ${index}`,
    );
    if (!isPlainByteSequence(sidecar.bytes)) {
      throw new TypeError('Process transport sidecar bytes must be a Uint8Array.');
    }
    const observedBytes = plainByteLength(sidecar.bytes, 'sidecar');
    if (observedBytes > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES) {
      throw new RangeError('Process transport sidecar exceeds the item byte limit.');
    }
    totalSidecarBytes += observedBytes;
    if (totalSidecarBytes > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES) {
      throw new RangeError('Process transport sidecars exceed the aggregate byte limit.');
    }
    assertSubAgentTransportArtifactSidecarDescriptor(sidecar.descriptor, {
      maxBytes: DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
    });
    if (sidecar.descriptor.byteLength !== observedBytes) {
      throw new TypeError('Process transport sidecar length does not match its descriptor.');
    }
    const descriptor = requireClosedRecord(
      sidecar.descriptor,
      ['artifact', 'byteLength', 'sha256', 'sidecarId', 'version'],
      `Process transport sidecar descriptor ${index}`,
    );
    requireClosedRecord(
      descriptor.artifact,
      ['id', 'mediaType', 'sha256', 'size', 'version'],
      `Process transport artifact reference ${index}`,
    );
    descriptorBytes += Buffer.byteLength(JSON.stringify(sidecar.descriptor));
    preflight.push(
      Object.freeze({
        descriptor: sidecar.descriptor,
        bytes: sidecar.bytes,
      }),
    );
  }
  const packetBytes = frameBytes + totalSidecarBytes + descriptorBytes + 128;
  if (packetBytes > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_CACHED_BYTES) {
    throw new RangeError('Process transport packet exceeds the total byte limit.');
  }
  const frame =
    typeof packet.frame === 'string'
      ? packet.frame
      : copyPlainBytes(packet.frame, DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES, 'frame');
  const sidecars = preflight.map(({ descriptor, bytes }) => {
    return decodeSubAgentTransportArtifactSidecar(descriptor, bytes, {
      maxBytes: DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
    });
  });
  return Object.freeze({
    frame,
    sidecars: Object.freeze(sidecars),
  });
}

export function decodeProcessMessage(
  value: unknown,
  direction: 'inbound' | 'outbound',
): ProcessSubAgentInboundMessage | ProcessSubAgentOutboundMessage {
  const base = requireRecord(value, 'Process channel message');
  if (base.version !== PROCESS_SUBAGENT_CHANNEL_VERSION || typeof base.type !== 'string') {
    throw new TypeError('Process channel message version or type is invalid.');
  }
  switch (base.type) {
    case 'bootstrap': {
      if (direction !== 'inbound') break;
      const record = requireClosedRecord(
        value,
        ['channelId', 'executorName', 'jobId', 'ownerSessionId', 'type', 'version'],
        'Process bootstrap message',
      );
      const data = decodeProcessBootstrapData({
        version: record.version,
        jobId: record.jobId,
        ownerSessionId: record.ownerSessionId,
        executorName: record.executorName,
        channelId: record.channelId,
      });
      return Object.freeze({
        ...data,
        type: 'bootstrap',
      });
    }
    case 'packet': {
      const record = requireClosedRecord(
        value,
        ['packet', 'type', 'version'],
        'Process packet message',
      );
      return Object.freeze({
        version: PROCESS_SUBAGENT_CHANNEL_VERSION,
        type: 'packet',
        packet: record.packet as ProcessSubAgentPacket,
      });
    }
    case 'shutdown':
      if (direction !== 'inbound') break;
      requireClosedRecord(value, ['type', 'version'], 'Process shutdown message');
      return Object.freeze({ version: PROCESS_SUBAGENT_CHANNEL_VERSION, type: 'shutdown' });
    case 'ready': {
      if (direction !== 'outbound') break;
      const record = requireClosedRecord(
        value,
        ['manifest', 'type', 'version'],
        'Process ready message',
      );
      return Object.freeze({
        version: PROCESS_SUBAGENT_CHANNEL_VERSION,
        type: 'ready',
        manifest: record.manifest as SubAgentTargetRunnerManifest,
      });
    }
    case 'fatal': {
      if (direction !== 'outbound') break;
      const record = requireClosedRecord(
        value,
        ['code', 'type', 'version'],
        'Process fatal message',
      );
      if (record.code !== 'TARGET_START_FAILED' && record.code !== 'TARGET_PROTOCOL_FAILED') {
        throw new TypeError('Process fatal message code is invalid.');
      }
      return Object.freeze({
        version: PROCESS_SUBAGENT_CHANNEL_VERSION,
        type: 'fatal',
        code: record.code,
      });
    }
    case 'stopped':
      if (direction !== 'outbound') break;
      requireClosedRecord(value, ['type', 'version'], 'Process stopped message');
      return Object.freeze({ version: PROCESS_SUBAGENT_CHANNEL_VERSION, type: 'stopped' });
    default:
  }
  throw new TypeError('Process channel message type is not allowed in this direction.');
}

function isPlainByteSequence(value: unknown): value is Uint8Array {
  return (
    !nodeTypes.isProxy(value) &&
    value instanceof Uint8Array &&
    Object.getPrototypeOf(value) === Uint8Array.prototype &&
    !Object.prototype.hasOwnProperty.call(value, 'buffer') &&
    !Object.prototype.hasOwnProperty.call(value, 'byteOffset') &&
    !Object.prototype.hasOwnProperty.call(value, 'byteLength')
  );
}

function plainByteLength(value: Uint8Array, label: string): number {
  if (!isPlainByteSequence(value)) {
    throw new TypeError(`Process transport ${label} must be a plain Uint8Array.`);
  }
  return Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
}

function copyPlainBytes(value: Uint8Array, maxBytes: number, label: string): Uint8Array {
  const observedByteLength = plainByteLength(value, label);
  if (observedByteLength > maxBytes) {
    throw new RangeError(`Process transport ${label} exceeds its byte limit.`);
  }
  const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
  const byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, value, []);
  const fixed = new Uint8Array(buffer, byteOffset, observedByteLength);
  const owned = new Uint8Array(observedByteLength);
  Reflect.apply(TYPED_ARRAY_SET, owned, [fixed]);
  return owned;
}

function assertBoundedFrameString(value: string): string {
  if (Buffer.byteLength(value) > DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES) {
    throw new RangeError('Process transport frame exceeds its byte limit.');
  }
  return value;
}

function estimateMessageBytes(message: ProcessSubAgentChannelMessage): number {
  if (message.type !== 'packet') {
    return Buffer.byteLength(JSON.stringify(message));
  }
  const frameBytes =
    typeof message.packet.frame === 'string'
      ? Buffer.byteLength(message.packet.frame)
      : message.packet.frame.byteLength;
  return message.packet.sidecars.reduce(
    (total, sidecar) =>
      total + sidecar.bytes.byteLength + Buffer.byteLength(JSON.stringify(sidecar.descriptor)),
    frameBytes + 128,
  );
}

function requireSafeArray(value: unknown, label: string, maxLength: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${label} must be an array.`);
  }
  if (value.length > maxLength) {
    throw new RangeError(`${label} exceeds its item limit.`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = ['length', ...Array.from({ length: value.length }, (_, index) => String(index))];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new TypeError(`${label} must be a dense closed array.`);
  }
  const owned: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new TypeError(`${label} entries must be enumerable data properties.`);
    }
    owned.push(descriptor.value);
  }
  return Object.freeze(owned);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be an object.`);
  }
  const owned: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new TypeError(`${label} cannot contain symbol fields.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new TypeError(`${label} fields must be enumerable data properties.`);
    }
    owned[key] = descriptor.value;
  }
  return owned;
}

function requireClosedRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) {
    throw new TypeError(`${label} contains unknown or missing fields.`);
  }
  return record;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function assertTransportIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) as number;
      return codePoint <= 31 || codePoint === 127;
    }) ||
    new TextEncoder().encode(value).byteLength > SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}
