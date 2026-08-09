import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import process from 'node:process';
import { setInterval } from 'node:timers';

assertProcessNetworkDenyInstalled();

process.once('message', () => {
  process.send({ version: '1', type: 'fatal', code: 'TARGET_START_FAILED' });
});
setInterval(() => undefined, 1_000);
