import { assertWorkerNetworkDenyInstalled } from './worker-network-deny.mjs';

import { isMainThread, workerData } from 'node:worker_threads';

if (isMainThread) throw new Error('This fixture must run in a worker thread.');
assertWorkerNetworkDenyInstalled();

const port = workerData.port;
port.on('message', () => undefined);
port.start();
await new Promise(() => undefined);
