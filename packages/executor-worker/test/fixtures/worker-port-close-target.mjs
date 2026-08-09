import { assertWorkerNetworkDenyInstalled } from './worker-network-deny.mjs';

import { setInterval, setTimeout } from 'node:timers';
import { isMainThread, workerData } from 'node:worker_threads';

import { workerHandshakeManifest } from './worker-handshake-manifest.mjs';

if (isMainThread) throw new Error('This fixture must run in a worker thread.');
assertWorkerNetworkDenyInstalled();

const port = workerData.port;
port.postMessage({ version: '1', type: 'ready', manifest: workerHandshakeManifest });
port.start();
setTimeout(() => port.close(), 25).unref();
setInterval(() => undefined, 1_000);
