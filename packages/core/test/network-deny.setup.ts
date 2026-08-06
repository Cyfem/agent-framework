import { NetworkDenyGuard } from '../../../testkit';

// Core's default test suite is a zero-network gate. Real Ark profiles use a
// separate command and never load this process-wide guard.
new NetworkDenyGuard().install();
