import { assertWorkerNetworkDenyInstalled } from './worker-network-deny.mjs';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isMainThread, workerData } from 'node:worker_threads';

import {
  decodeWorkerBootstrapData,
  decodeWorkerMessage,
  decodeWorkerPacket,
} from '../../.artifacts/worker-test/worker-protocol.js';

if (isMainThread) throw new Error('This fixture must run in a worker thread.');
assertWorkerNetworkDenyInstalled();

const bootstrap = decodeWorkerBootstrapData(workerData);
bootstrap.port.once('message', (value) => {
  const message = decodeWorkerMessage(value, 'inbound');
  if (message.type !== 'packet') throw new Error('Expected one Worker packet message.');
  const packet = decodeWorkerPacket(message.packet);
  const frame = typeof packet.frame === 'string' ? Buffer.from(packet.frame) : packet.frame;
  bootstrap.port.postMessage({
    version: 'test-only',
    networkDenyInstalled: true,
    frame: { length: frame.byteLength, digest: digest(frame) },
    sidecars: packet.sidecars.map((sidecar) => ({
      sidecarId: sidecar.descriptor.sidecarId,
      length: sidecar.data.byteLength,
      digest: digest(sidecar.data),
    })),
  });
});
bootstrap.port.start();

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
