import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import process from 'node:process';
import { setInterval } from 'node:timers';

assertProcessNetworkDenyInstalled();

process.once('message', () => undefined);
setInterval(() => undefined, 1_000);
