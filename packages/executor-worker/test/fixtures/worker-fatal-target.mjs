import { assertWorkerNetworkDenyInstalled } from './worker-network-deny.mjs';

import { isMainThread, workerData } from 'node:worker_threads';

if (isMainThread) throw new Error('This fixture must run in a worker thread.');
assertWorkerNetworkDenyInstalled();

const port = workerData.port;
port.postMessage({ version: '1', type: 'fatal', code: 'TARGET_START_FAILED' });
port.start();
await new Promise(() => undefined);
