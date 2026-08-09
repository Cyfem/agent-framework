import { NetworkDenyGuard } from '../../../testkit';

// Process placement acceptance is fully offline. Child-process IPC remains available,
// while provider and arbitrary network surfaces are denied in the controller.
const networkDenyGuard = new NetworkDenyGuard().install();

/** Verifies the controller test process still owns the process-wide deny guard. */
export function assertNetworkDenyGuardInstalled(): void {
  const owner = Reflect.get(globalThis, Symbol.for('maneeagent.testkit.network-deny-owner.v1'));
  if (owner !== networkDenyGuard) {
    throw new Error('Process fixture requires the network deny guard before runtime setup.');
  }
}
