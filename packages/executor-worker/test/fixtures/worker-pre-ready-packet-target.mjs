import { assertWorkerNetworkDenyInstalled } from './worker-network-deny.mjs';

import { isMainThread, workerData } from 'node:worker_threads';

if (isMainThread) throw new Error('This fixture must run in a worker thread.');
assertWorkerNetworkDenyInstalled();

const port = workerData.port;
port.postMessage({
  version: '1',
  type: 'packet',
  packet: { frame: 'not-decoded-before-readiness', sidecars: [] },
});
port.on('message', () => undefined);
port.start();
await new Promise(() => undefined);
