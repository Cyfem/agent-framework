import type { SubAgentTransportPeerPacket } from '@ruixutong.manee/maneeagent-framework';

import { requireClosedDataRecord } from './http-internal';
import { decodeHttpSubAgentRoutedPacket } from './http-route-policy';
import type { HttpSubAgentRoute } from './http-route';
import { createHttpSubAgentRoutedPacketSemanticReceipt } from './http-semantic-receipt-internal';

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
  return createHttpSubAgentRoutedPacketSemanticReceipt(routed);
}
