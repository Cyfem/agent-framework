import { types as nodeTypes } from 'node:util';

import {
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
  canonicalJsonSha256,
  canonicalizeJson,
  decodeSubAgentTransportArtifactSidecar,
  decodeSubAgentTransportRpcFrame,
  encodeSubAgentTransportRpcFrame,
  type JsonValue,
  type SubAgentTransportArtifactSidecar,
  type SubAgentTransportArtifactSidecarDescriptor,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportRpcEnvelope,
} from '@ruixutong.manee/maneeagent-framework';

import { copyHttpBytes, requireClosedDataRecord, requireDenseDataArray } from './http-internal';

const PEER_PACKET_KEYS = Object.freeze(['frame', 'sidecars'] as const);
const SIDECAR_KEYS = Object.freeze(['descriptor', 'data'] as const);
const OUTBOUND_PACKET_RECEIPT_VERSION = '1' as const;
const TEXT_ENCODER = new TextEncoder();

export interface HttpSubAgentOutboundPacketLimits {
  readonly maxFrameBytes: number;
  readonly maxSidecars: number;
  readonly maxSidecarItemBytes: number;
  readonly maxSidecarBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
}

export interface OwnedHttpSubAgentOutboundFrame {
  readonly envelope: SubAgentTransportRpcEnvelope;
  readonly frame: string;
}

export interface OwnedHttpSubAgentOutboundPacket extends OwnedHttpSubAgentOutboundFrame {
  readonly packet: SubAgentTransportPeerPacket;
  readonly packetReceipt: string;
  readonly retainedBytes: number;
}

/** @internal Distinguishes an attachment fence so Store callers can preserve their error domain. */
export class HttpSubAgentOutboundPacketChannelMismatchError extends TypeError {
  constructor() {
    super('HTTP outbound Peer packet channel does not match the expected attachment.');
    this.name = 'HttpSubAgentOutboundPacketChannelMismatchError';
  }
}

const DEFAULT_OUTBOUND_PACKET_LIMITS = Object.freeze({
  maxFrameBytes: DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  maxSidecars: DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
  maxSidecarItemBytes: DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
  maxSidecarBytes: DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES,
  maxJsonDepth: DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
  maxJsonNodes: DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
}) satisfies HttpSubAgentOutboundPacketLimits;

/** @internal Strictly owns one target-to-controller packet and its full transport receipt. */
export function ownHttpSubAgentOutboundPacket(
  value: unknown,
  expectedChannelId: string,
  limits: HttpSubAgentOutboundPacketLimits = DEFAULT_OUTBOUND_PACKET_LIMITS,
): OwnedHttpSubAgentOutboundPacket {
  const record = requireClosedDataRecord(value, PEER_PACKET_KEYS, 'HTTP outbound Peer packet');
  const ownedFrame = ownHttpSubAgentOutboundFrame(record.frame, expectedChannelId, limits);
  const sidecars = ownHttpSubAgentOutboundSidecars(record.sidecars, limits);
  return finalizeOwnedHttpSubAgentOutboundPacket(ownedFrame, sidecars);
}

/** @internal Validates direction and attachment before any sidecar bytes are owned. */
export function ownHttpSubAgentOutboundFrame(
  value: unknown,
  expectedChannelId: string,
  limits: HttpSubAgentOutboundPacketLimits,
): OwnedHttpSubAgentOutboundFrame {
  let frame: string | Uint8Array;
  if (typeof value === 'string') {
    frame = value;
  } else {
    if (nodeTypes.isProxy(value) || !nodeTypes.isUint8Array(value)) {
      throw new TypeError('HTTP outbound Peer packet frame must be a string or Uint8Array.');
    }
    frame = copyHttpBytes(value, 'HTTP outbound Peer packet frame', limits.maxFrameBytes);
  }
  const envelope = decodeSubAgentTransportRpcFrame(frame, {
    maxFrameBytes: limits.maxFrameBytes,
    maxJsonDepth: limits.maxJsonDepth,
    maxJsonNodes: limits.maxJsonNodes,
  });
  assertTargetToControllerRpcKind(envelope);
  if (envelope.channelId !== expectedChannelId) {
    throw new HttpSubAgentOutboundPacketChannelMismatchError();
  }
  return Object.freeze({
    envelope,
    frame: encodeSubAgentTransportRpcFrame(envelope, {
      maxFrameBytes: limits.maxFrameBytes,
      maxJsonDepth: limits.maxJsonDepth,
      maxJsonNodes: limits.maxJsonNodes,
    }),
  });
}

/** @internal Owns and verifies an exact, bounded sidecar array. */
export function ownHttpSubAgentOutboundSidecars(
  value: unknown,
  limits: HttpSubAgentOutboundPacketLimits,
): readonly SubAgentTransportArtifactSidecar[] {
  const candidates = requireDenseDataArray(value, 'HTTP outbound Peer packet sidecars');
  if (candidates.length > limits.maxSidecars) {
    throw new RangeError('HTTP outbound Peer packet exceeds the configured sidecar count.');
  }
  const sidecars: SubAgentTransportArtifactSidecar[] = [];
  const sidecarIds = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = requireClosedDataRecord(
      candidates[index],
      SIDECAR_KEYS,
      `HTTP outbound Peer packet sidecar ${index}`,
    );
    const sidecar = decodeSubAgentTransportArtifactSidecar(
      candidate.descriptor,
      candidate.data as Uint8Array | ArrayBuffer,
      { maxBytes: limits.maxSidecarItemBytes },
    );
    if (sidecarIds.has(sidecar.descriptor.sidecarId)) {
      throw new TypeError('HTTP outbound Peer packet contains duplicate sidecar IDs.');
    }
    if (sidecar.data.byteLength > limits.maxSidecarBytes - totalBytes) {
      throw new RangeError('HTTP outbound Peer packet exceeds the aggregate sidecar limit.');
    }
    sidecarIds.add(sidecar.descriptor.sidecarId);
    totalBytes += sidecar.data.byteLength;
    sidecars.push(sidecar);
  }
  return Object.freeze(sidecars);
}

/** @internal Finalizes already-owned frame and sidecars using the one receipt projection. */
export function finalizeOwnedHttpSubAgentOutboundPacket(
  ownedFrame: OwnedHttpSubAgentOutboundFrame,
  sidecars: readonly SubAgentTransportArtifactSidecar[],
): OwnedHttpSubAgentOutboundPacket {
  const packet = Object.freeze({
    frame: ownedFrame.frame,
    sidecars,
  }) satisfies SubAgentTransportPeerPacket;
  const descriptors = [...sidecars.map((sidecar) => sidecar.descriptor)].sort(
    compareDeliverySidecarDescriptors,
  );
  return Object.freeze({
    envelope: ownedFrame.envelope,
    frame: ownedFrame.frame,
    packet,
    packetReceipt: canonicalJsonSha256({
      version: OUTBOUND_PACKET_RECEIPT_VERSION,
      rpc: ownedFrame.envelope,
      sidecarDescriptorsSortedBySidecarId: descriptors,
    } as unknown as JsonValue),
    retainedBytes: httpSubAgentPacketRetainedBytes(packet),
  });
}

/** @internal Counts canonical frame, descriptor JSON and raw sidecar bytes. */
export function httpSubAgentPacketRetainedBytes(packet: SubAgentTransportPeerPacket): number {
  let total =
    typeof packet.frame === 'string'
      ? TEXT_ENCODER.encode(packet.frame).byteLength
      : packet.frame.byteLength;
  for (const sidecar of packet.sidecars) {
    const descriptorBytes = TEXT_ENCODER.encode(
      canonicalizeJson(sidecar.descriptor as unknown as JsonValue),
    ).byteLength;
    total = addRetainedBytes(total, descriptorBytes);
    total = addRetainedBytes(total, sidecar.data.byteLength);
  }
  return total;
}

function compareDeliverySidecarDescriptors(
  left: SubAgentTransportArtifactSidecarDescriptor,
  right: SubAgentTransportArtifactSidecarDescriptor,
): number {
  return left.sidecarId < right.sidecarId ? -1 : left.sidecarId > right.sidecarId ? 1 : 0;
}

function assertTargetToControllerRpcKind(envelope: SubAgentTransportRpcEnvelope): void {
  switch (envelope.kind) {
    case 'executor.accepted':
    case 'executor.settled':
    case 'cancel.ack':
    case 'snapshot.reply':
    case 'events.page':
    case 'control.request':
    case 'model.request':
    case 'events.request':
    case 'protocol.error':
      return;
    default:
      throw new TypeError('HTTP outbound Peer packet RPC kind is not target-to-controller.');
  }
}

function addRetainedBytes(total: number, increment: number): number {
  if (
    !Number.isSafeInteger(increment) ||
    increment < 0 ||
    total > Number.MAX_SAFE_INTEGER - increment
  ) {
    throw new RangeError('HTTP job retained byte count exceeds safe integer range.');
  }
  return total + increment;
}
