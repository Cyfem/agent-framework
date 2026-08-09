import { NetworkDenyGuard } from '../../../testkit';

// C7c-4 exercises only the in-memory HTTP wire-security boundary. Provider and
// arbitrary network access stay disabled; a real loopback server belongs to C7c-5.
const networkDenyGuard = new NetworkDenyGuard().install();

/** Verifies the test process still owns the process-wide deny guard. */
export function assertNetworkDenyGuardInstalled(): void {
  const owner = Reflect.get(globalThis, Symbol.for('maneeagent.testkit.network-deny-owner.v1'));
  if (owner !== networkDenyGuard) {
    throw new Error('HTTP security tests require the network deny guard before runtime setup.');
  }
}
