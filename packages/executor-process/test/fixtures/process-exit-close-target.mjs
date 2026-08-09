import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import process from 'node:process';

assertProcessNetworkDenyInstalled();

const payload = 'exit-before-close-stdio-proof:'.padEnd(64 * 1024, 'x');
process.stdout.write(payload);
process.exitCode = 81;
