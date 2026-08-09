import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import process from 'node:process';
import { setInterval } from 'node:timers';

import { processHandshakeManifest } from './process-handshake-manifest.mjs';

assertProcessNetworkDenyInstalled();

process.once('message', () => {
  const ready = { version: '1', type: 'ready', manifest: processHandshakeManifest };
  process.send(ready, () => process.send(ready));
});
setInterval(() => undefined, 1_000);
