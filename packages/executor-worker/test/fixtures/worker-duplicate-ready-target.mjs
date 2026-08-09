import { assertWorkerNetworkDenyInstalled } from './worker-network-deny.mjs';

import { isMainThread, workerData } from 'node:worker_threads';

import { workerHandshakeManifest } from './worker-handshake-manifest.mjs';

if (isMainThread) throw new Error('This fixture must run in a worker thread.');
assertWorkerNetworkDenyInstalled();

const port = workerData.port;
const ready = { version: '1', type: 'ready', manifest: workerHandshakeManifest };
port.postMessage(ready);
port.postMessage(ready);
port.on('message', () => undefined);
port.start();
await new Promise(() => undefined);
