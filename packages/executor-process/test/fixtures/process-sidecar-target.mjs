import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import process from 'node:process';

assertProcessNetworkDenyInstalled();

let bootstrapped = false;
process.on('message', (value, sendHandle) => {
  if (sendHandle !== undefined) throw new Error('Process fixture rejects IPC send handles.');
  if (!bootstrapped) {
    assertClosed(value, [
      'channelId',
      'executorName',
      'jobId',
      'ownerSessionId',
      'type',
      'version',
    ]);
    if (value.version !== '1' || value.type !== 'bootstrap') {
      throw new Error('Expected a closed Process bootstrap message first.');
    }
    bootstrapped = true;
    return;
  }

  assertClosed(value, ['packet', 'type', 'version']);
  if (value.version !== '1' || value.type !== 'packet') {
    throw new Error('Expected one Process packet after bootstrap.');
  }
  const { frame, sidecars } = value.packet;
  if (!(frame instanceof Uint8Array) || !Array.isArray(sidecars)) {
    throw new Error('Advanced serialization must preserve typed-array packet fields.');
  }
  const evidence = {
    version: 'test-only',
    networkDenyInstalled: true,
    frame: { length: frame.byteLength, digest: digest(frame) },
    sidecars: sidecars.map((sidecar) => {
      if (!(sidecar.bytes instanceof Uint8Array)) {
        throw new Error('Advanced serialization must preserve sidecar typed arrays.');
      }
      return {
        sidecarId: sidecar.descriptor.sidecarId,
        length: sidecar.bytes.byteLength,
        digest: digest(sidecar.bytes),
      };
    }),
  };
  process.send(evidence, (error) => {
    if (error !== null) throw error;
    process.disconnect();
  });
});

function assertClosed(value, keys) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  ) {
    throw new Error('Process IPC fixture received a non-closed message.');
  }
}

function digest(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}
