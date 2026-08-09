import { MessagePort } from 'node:worker_threads';
import { types as nodeTypes } from 'node:util';

import { SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES } from '@ruixutong.manee/maneeagent-framework';
import type {
  SubAgentTargetRunnerManifest,
  SubAgentTransportArtifactSidecar,
  SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

export const WORKER_SUBAGENT_CHANNEL_VERSION = '1' as const;

export interface WorkerSubAgentBootstrapData {
  readonly version: typeof WORKER_SUBAGENT_CHANNEL_VERSION;
  readonly jobId: string;
  readonly ownerSessionId: string;
  readonly executorName: string;
  readonly channelId: string;
  readonly port: MessagePort;
}

export type WorkerSubAgentInboundMessage =
  | {
      readonly version: typeof WORKER_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'packet';
      readonly packet: WorkerSubAgentPacket;
    }
  | {
      readonly version: typeof WORKER_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'shutdown';
    };

export type WorkerSubAgentOutboundMessage =
  | {
      readonly version: typeof WORKER_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'ready';
      readonly manifest: SubAgentTargetRunnerManifest;
    }
  | {
      readonly version: typeof WORKER_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'packet';
      readonly packet: WorkerSubAgentPacket;
    }
  | {
      readonly version: typeof WORKER_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'fatal';
      readonly code: 'TARGET_START_FAILED' | 'TARGET_PROTOCOL_FAILED';
    }
  | {
      readonly version: typeof WORKER_SUBAGENT_CHANNEL_VERSION;
      readonly type: 'stopped';
    };

interface WorkerSubAgentPacket {
  readonly frame: string | ArrayBuffer;
  readonly sidecars: readonly WorkerSubAgentSidecar[];
}

interface WorkerSubAgentSidecar {
  readonly descriptor: SubAgentTransportArtifactSidecar['descriptor'];
  readonly bytes: ArrayBuffer;
}

export function decodeWorkerBootstrapData(value: unknown): WorkerSubAgentBootstrapData {
  const record = requireClosedRecord(
    value,
    ['channelId', 'executorName', 'jobId', 'ownerSessionId', 'port', 'version'],
    'Worker bootstrap data',
  );
  if (record.version !== WORKER_SUBAGENT_CHANNEL_VERSION) {
    throw new TypeError('The Worker bootstrap protocol version is unsupported.');
  }
  assertIdentifier(record.jobId, 'Worker bootstrap jobId');
  assertTransportIdentifier(record.ownerSessionId, 'Worker bootstrap ownerSessionId');
  assertIdentifier(record.executorName, 'Worker bootstrap executorName');
  assertIdentifier(record.channelId, 'Worker bootstrap channelId');
  if (nodeTypes.isProxy(record.port) || !(record.port instanceof MessagePort)) {
    throw new TypeError('Worker bootstrap data requires one transferred MessagePort.');
  }
  return Object.freeze({
    version: WORKER_SUBAGENT_CHANNEL_VERSION,
    jobId: record.jobId as string,
    ownerSessionId: record.ownerSessionId as string,
    executorName: record.executorName as string,
    channelId: record.channelId as string,
    port: record.port,
  });
}

export function encodeWorkerPacket(
  packet: SubAgentTransportPeerPacket,
): Readonly<{ readonly packet: WorkerSubAgentPacket; readonly transfer: readonly ArrayBuffer[] }> {
  const transfer: ArrayBuffer[] = [];
  const frame =
    typeof packet.frame === 'string' ? packet.frame : copyForTransfer(packet.frame, transfer);
  const sidecars = packet.sidecars.map((sidecar) =>
    Object.freeze({
      descriptor: sidecar.descriptor,
      bytes: copyForTransfer(sidecar.data, transfer),
    }),
  );
  return Object.freeze({
    packet: Object.freeze({ frame, sidecars: Object.freeze(sidecars) }),
    transfer: Object.freeze(transfer),
  });
}

export function decodeWorkerPacket(value: unknown): SubAgentTransportPeerPacket {
  const packet = requireClosedRecord(value, ['frame', 'sidecars'], 'Worker transport packet');
  if (
    typeof packet.frame !== 'string' &&
    (nodeTypes.isProxy(packet.frame) || !(packet.frame instanceof ArrayBuffer))
  ) {
    throw new TypeError('Worker transport packet frame must be a string or ArrayBuffer.');
  }
  const encodedSidecars = requireSafeArray(packet.sidecars, 'Worker transport packet sidecars');
  const sidecars = encodedSidecars.map((value, index) => {
    const sidecar = requireClosedRecord(
      value,
      ['bytes', 'descriptor'],
      `Worker transport sidecar ${index}`,
    );
    if (nodeTypes.isProxy(sidecar.bytes) || !(sidecar.bytes instanceof ArrayBuffer)) {
      throw new TypeError('Worker transport sidecar bytes must be an ArrayBuffer.');
    }
    return Object.freeze({
      descriptor: sidecar.descriptor as SubAgentTransportArtifactSidecar['descriptor'],
      data: new Uint8Array(sidecar.bytes),
    });
  });
  return Object.freeze({
    frame: typeof packet.frame === 'string' ? packet.frame : new Uint8Array(packet.frame),
    sidecars: Object.freeze(sidecars),
  });
}

export function decodeWorkerMessage(
  value: unknown,
  direction: 'inbound' | 'outbound',
): WorkerSubAgentInboundMessage | WorkerSubAgentOutboundMessage {
  const base = requireRecord(value, 'Worker channel message');
  if (base.version !== WORKER_SUBAGENT_CHANNEL_VERSION || typeof base.type !== 'string') {
    throw new TypeError('Worker channel message version or type is invalid.');
  }
  switch (base.type) {
    case 'packet': {
      const record = requireClosedRecord(
        value,
        ['packet', 'type', 'version'],
        'Worker packet message',
      );
      return Object.freeze({
        version: WORKER_SUBAGENT_CHANNEL_VERSION,
        type: 'packet',
        packet: record.packet as WorkerSubAgentPacket,
      });
    }
    case 'shutdown':
      if (direction !== 'inbound') break;
      requireClosedRecord(value, ['type', 'version'], 'Worker shutdown message');
      return Object.freeze({ version: WORKER_SUBAGENT_CHANNEL_VERSION, type: 'shutdown' });
    case 'ready': {
      if (direction !== 'outbound') break;
      const record = requireClosedRecord(
        value,
        ['manifest', 'type', 'version'],
        'Worker ready message',
      );
      return Object.freeze({
        version: WORKER_SUBAGENT_CHANNEL_VERSION,
        type: 'ready',
        manifest: record.manifest as SubAgentTargetRunnerManifest,
      });
    }
    case 'fatal': {
      if (direction !== 'outbound') break;
      const record = requireClosedRecord(
        value,
        ['code', 'type', 'version'],
        'Worker fatal message',
      );
      if (record.code !== 'TARGET_START_FAILED' && record.code !== 'TARGET_PROTOCOL_FAILED') {
        throw new TypeError('Worker fatal message code is invalid.');
      }
      return Object.freeze({
        version: WORKER_SUBAGENT_CHANNEL_VERSION,
        type: 'fatal',
        code: record.code,
      });
    }
    case 'stopped':
      if (direction !== 'outbound') break;
      requireClosedRecord(value, ['type', 'version'], 'Worker stopped message');
      return Object.freeze({ version: WORKER_SUBAGENT_CHANNEL_VERSION, type: 'stopped' });
    default:
  }
  throw new TypeError('Worker channel message type is not allowed in this direction.');
}

function requireSafeArray(value: unknown, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${label} must be an array.`);
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

function copyForTransfer(value: Uint8Array | ArrayBuffer, transfer: ArrayBuffer[]): ArrayBuffer {
  const source = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  const owned = new Uint8Array(source.byteLength);
  owned.set(source);
  transfer.push(owned.buffer);
  return owned.buffer;
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
