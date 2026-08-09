import {
  canonicalJsonSha256,
  type JsonValue,
  type SubAgentTransportArtifactSidecarDescriptor,
} from '@ruixutong.manee/maneeagent-framework';

import { HTTP_SUBAGENT_PACKET_VERSION } from './http-constants';
import type { HttpSubAgentRoutedPacket } from './http-route-policy';

export function sortedHttpSubAgentSidecarDescriptors(
  routed: HttpSubAgentRoutedPacket,
): readonly SubAgentTransportArtifactSidecarDescriptor[] {
  const descriptors: SubAgentTransportArtifactSidecarDescriptor[] = [];
  for (const sidecar of routed.packet.sidecars) descriptors.push(sidecar.descriptor);
  descriptors.sort(compareSidecarDescriptors);
  return Object.freeze(descriptors);
}

export function createHttpSubAgentRoutedPacketSemanticReceipt(
  routed: HttpSubAgentRoutedPacket,
): string {
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

  return canonicalJsonSha256({
    version: HTTP_SUBAGENT_PACKET_VERSION,
    route,
    rpc,
    sidecars: sortedHttpSubAgentSidecarDescriptors(routed),
  } as unknown as JsonValue);
}

function compareSidecarDescriptors(
  left: SubAgentTransportArtifactSidecarDescriptor,
  right: SubAgentTransportArtifactSidecarDescriptor,
): number {
  return left.sidecarId < right.sidecarId ? -1 : left.sidecarId > right.sidecarId ? 1 : 0;
}
