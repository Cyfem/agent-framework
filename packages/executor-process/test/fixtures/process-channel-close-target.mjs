import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';

import { processHandshakeManifest } from './process-handshake-manifest.mjs';

assertProcessNetworkDenyInstalled();

process.once('message', () => {
  process.send({ version: '1', type: 'ready', manifest: processHandshakeManifest }, () =>
    setTimeout(() => process.disconnect(), 25),
  );
});
setInterval(() => undefined, 1_000);
