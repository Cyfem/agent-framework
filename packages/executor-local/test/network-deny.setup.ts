import { NetworkDenyGuard } from '../../../testkit';

// Local and process acceptance tests must not reach provider or arbitrary
// network surfaces. IPC pipes and filesystem access remain available.
const networkDenyGuard = new NetworkDenyGuard().install();

/** Keeps this setup reachable in bundled process fixtures and verifies ownership. */
export function assertNetworkDenyGuardInstalled(): void {
  const owner = Reflect.get(globalThis, Symbol.for('maneeagent.testkit.network-deny-owner.v1'));
  if (owner !== networkDenyGuard) {
    throw new Error('Process fixture requires the network deny guard before runtime setup.');
  }
}
