import { assertWorkerNetworkDenyInstalled } from './worker-network-deny.mjs';

import { isMainThread, workerData } from 'node:worker_threads';

import { workerHandshakeManifest } from './worker-handshake-manifest.mjs';

if (isMainThread) throw new Error('This fixture must run in a worker thread.');
assertWorkerNetworkDenyInstalled();

const port = workerData.port;
port.postMessage({
  version: '1',
  type: 'ready',
  manifest: { ...workerHandshakeManifest, forgedEntry: 'untrusted/runner.mjs' },
});
port.on('message', () => undefined);
port.start();
await new Promise(() => undefined);
