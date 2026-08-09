import {
  canonicalJsonSha256,
  type JsonValue,
  type SubAgentTransportArtifactSidecarDescriptor,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

import { HTTP_SUBAGENT_PACKET_VERSION } from './http-constants';
import { requireClosedDataRecord } from './http-internal';
import { decodeHttpSubAgentRoutedPacket } from './http-route-policy';
import type { HttpSubAgentRoute } from './http-route';

export interface HttpSubAgentPacketSemanticReceiptInput {
  readonly route: HttpSubAgentRoute;
  readonly packet: SubAgentTransportPeerPacket;
}

/** Hashes only stable HTTP route, RPC business semantics and verified sidecar descriptors. */
export function createHttpSubAgentPacketSemanticReceipt(
  input: HttpSubAgentPacketSemanticReceiptInput,
): string {
  const record = requireClosedDataRecord(
    input,
    ['route', 'packet'],
    'HTTP Subagent semantic receipt input',
  );
  const routed = decodeHttpSubAgentRoutedPacket(
    record.route as HttpSubAgentRoute,
    record.packet as SubAgentTransportPeerPacket,
  );
  const route =
    routed.route.id === 'jobs.create' || routed.route.id === 'heartbeat'
      ? { id: routed.route.id }
      : { id: routed.route.id, jobId: routed.route.jobId };
  const rpc = {
    version: routed.envelope.version,
    kind: routed.envelope.kind,
    ...(routed.envelope.taskId === undefined ? {} : { taskId: routed.envelope.taskId }),
    ...(routed.envelope.operationId === undefined
      ? {}
      : { operationId: routed.envelope.operationId }),
    payload: routed.envelope.payload,
  };
  const sidecars = [...routed.packet.sidecars]
    .map((sidecar) => sidecar.descriptor)
    .sort(compareSidecarDescriptors);

  return canonicalJsonSha256({
    version: HTTP_SUBAGENT_PACKET_VERSION,
    route,
    rpc,
    sidecars,
  } as unknown as JsonValue);
}

function compareSidecarDescriptors(
  left: SubAgentTransportArtifactSidecarDescriptor,
  right: SubAgentTransportArtifactSidecarDescriptor,
): number {
  return left.sidecarId < right.sidecarId ? -1 : left.sidecarId > right.sidecarId ? 1 : 0;
}
