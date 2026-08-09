import { types as nodeTypes } from 'node:util';

import {
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
  decodeSubAgentTransportArtifactSidecar,
  decodeSubAgentTransportRpcFrame,
  encodeSubAgentTransportRpcFrame,
  type SubAgentTransportArtifactSidecar,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportRpcEnvelope,
} from '@ruixutong.manee/maneeagent-framework';

import {
  copyHttpBytes,
  requireAllowedDataRecord,
  requireClosedDataRecord,
  requireDenseDataArray,
} from './http-internal';
import { parseHttpSubAgentRoute, type HttpSubAgentRoute } from './http-route';

const ROUTE_KEYS = Object.freeze(['id', 'requestTarget', 'jobId', 'requestId'] as const);
const PEER_PACKET_KEYS = Object.freeze(['frame', 'sidecars'] as const);
const SIDECAR_KEYS = Object.freeze(['descriptor', 'data'] as const);

export interface HttpSubAgentRoutedPacket {
  readonly route: HttpSubAgentRoute;
  readonly envelope: SubAgentTransportRpcEnvelope;
  readonly packet: SubAgentTransportPeerPacket;
}

/** Owns one untrusted Peer packet and locks its strict RPC semantics to the parsed HTTP route. */
export function decodeHttpSubAgentRoutedPacket(
  route: HttpSubAgentRoute,
  packet: SubAgentTransportPeerPacket,
): HttpSubAgentRoutedPacket {
  const ownedRoute = ownRoute(route);
  if (ownedRoute.id === 'heartbeat') {
    throw new TypeError('HTTP Subagent heartbeat does not accept a Peer packet.');
  }

  const packetRecord = requireClosedDataRecord(packet, PEER_PACKET_KEYS, 'HTTP routed Peer packet');
  const frame = ownFrame(packetRecord.frame);
  const envelope = decodeSubAgentTransportRpcFrame(frame, {
    maxFrameBytes: DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  });
  const canonicalFrame = encodeSubAgentTransportRpcFrame(envelope, {
    maxFrameBytes: DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  });
  const sidecars = ownSidecars(packetRecord.sidecars);
  const ownedPacket = Object.freeze({
    frame: canonicalFrame,
    sidecars,
  }) satisfies SubAgentTransportPeerPacket;

  assertRouteRpcPolicy(ownedRoute, envelope);
  return Object.freeze({ route: ownedRoute, envelope, packet: ownedPacket });
}

function ownRoute(value: HttpSubAgentRoute): HttpSubAgentRoute {
  const candidate = requireAllowedDataRecord(value, ROUTE_KEYS, 'HTTP Subagent route');
  const parsed = parseHttpSubAgentRoute('POST', candidate.requestTarget);
  const expectedKeys =
    parsed.id === 'heartbeat' || parsed.id === 'jobs.create'
      ? (['id', 'requestTarget'] as const)
      : parsed.id === 'jobs.control-reply'
        ? (['id', 'requestTarget', 'jobId', 'requestId'] as const)
        : (['id', 'requestTarget', 'jobId'] as const);
  requireClosedDataRecord(candidate, expectedKeys, 'HTTP Subagent route');
  if (
    candidate.id !== parsed.id ||
    candidate.requestTarget !== parsed.requestTarget ||
    ('jobId' in parsed && candidate.jobId !== parsed.jobId) ||
    ('requestId' in parsed && candidate.requestId !== parsed.requestId)
  ) {
    throw new TypeError('HTTP Subagent route fields do not match its canonical request-target.');
  }
  return parsed;
}

function ownFrame(value: unknown): string | Uint8Array {
  if (typeof value === 'string') return value;
  if (nodeTypes.isProxy(value) || !nodeTypes.isUint8Array(value)) {
    throw new TypeError('HTTP routed Peer packet frame must be a string or Uint8Array.');
  }
  return copyHttpBytes(
    value,
    'HTTP routed Peer packet frame',
    DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  );
}

function ownSidecars(value: unknown): readonly SubAgentTransportArtifactSidecar[] {
  const candidates = requireDenseDataArray(value, 'HTTP routed Peer packet sidecars');
  if (candidates.length > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS) {
    throw new RangeError('HTTP routed Peer packet exceeds the default sidecar count.');
  }

  const result: SubAgentTransportArtifactSidecar[] = [];
  const sidecarIds = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = requireClosedDataRecord(
      candidates[index],
      SIDECAR_KEYS,
      `HTTP routed Peer packet sidecar ${index}`,
    );
    const sidecar = decodeSubAgentTransportArtifactSidecar(
      candidate.descriptor,
      candidate.data as Uint8Array | ArrayBuffer,
      { maxBytes: DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES },
    );
    if (sidecarIds.has(sidecar.descriptor.sidecarId)) {
      throw new TypeError('HTTP routed Peer packet contains duplicate sidecar IDs.');
    }
    if (sidecar.data.byteLength > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES - totalBytes) {
      throw new RangeError('HTTP routed Peer packet exceeds the default aggregate sidecar bytes.');
    }
    sidecarIds.add(sidecar.descriptor.sidecarId);
    totalBytes += sidecar.data.byteLength;
    result.push(sidecar);
  }
  return Object.freeze(result);
}

function assertRouteRpcPolicy(
  route: Exclude<HttpSubAgentRoute, { readonly id: 'heartbeat' }>,
  envelope: SubAgentTransportRpcEnvelope,
): void {
  switch (route.id) {
    case 'jobs.create':
      if (
        envelope.kind !== 'executor.request' ||
        envelope.payload.request.operation.type !== 'create' ||
        (envelope.payload.mode !== 'execute' && envelope.payload.mode !== 'spawn')
      ) {
        throw new TypeError('HTTP jobs.create requires an execute or spawn create request.');
      }
      return;
    case 'jobs.resume':
      if (
        envelope.kind !== 'executor.request' ||
        envelope.payload.request.operation.type !== 'resume' ||
        envelope.payload.mode !== 'execute'
      ) {
        throw new TypeError('HTTP jobs.resume requires an execute resume request.');
      }
      return;
    case 'jobs.reconnect':
      if (
        envelope.kind !== 'executor.request' ||
        envelope.payload.request.operation.type !== 'reconnect' ||
        envelope.payload.mode !== 'spawn'
      ) {
        throw new TypeError('HTTP jobs.reconnect requires a spawn reconnect request.');
      }
      return;
    case 'jobs.cancel':
      if (envelope.kind !== 'cancel.request') {
        throw new TypeError('HTTP jobs.cancel requires a cancel request.');
      }
      return;
    case 'jobs.poll':
      if (envelope.kind !== 'snapshot.request' && envelope.kind !== 'events.request') {
        throw new TypeError('HTTP jobs.poll requires a snapshot or events request.');
      }
      return;
    case 'jobs.control-reply':
      if (
        envelope.kind !== 'control.reply' &&
        envelope.kind !== 'model.reply' &&
        envelope.kind !== 'events.page' &&
        envelope.kind !== 'protocol.error'
      ) {
        throw new TypeError('HTTP jobs.control-reply requires a registered reply RPC kind.');
      }
      if (envelope.correlationId !== route.requestId) {
        throw new TypeError('HTTP control reply correlationId does not match the route requestId.');
      }
      return;
  }
}
