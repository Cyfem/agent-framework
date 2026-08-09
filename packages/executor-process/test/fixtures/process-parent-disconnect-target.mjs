import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import process from 'node:process';
import { setInterval } from 'node:timers';

import { z } from 'zod';

import { defineSubAgent, SubAgentTargetRunnerRegistry } from '../../../core/dist/index.js';
import { serveProcessSubAgentTarget } from '../../dist/index.js';

assertProcessNetworkDenyInstalled();

const definition = defineSubAgent({
  name: 'process-parent-disconnect-child',
  version: '2',
  description: 'Hold a permanent ref after the controller IPC channel disappears.',
  inputSchema: z.json(),
  outputSchema: z.json(),
});

const registry = new SubAgentTargetRunnerRegistry()
  .register({
    definition,
    runnerId: 'process-parent-disconnect-runner',
    runnerVersion: '2.0.0',
    childCheckpointVersions: ['1'],
    modelBinding: {
      gatewayId: 'process-parent-disconnect-model',
      protocol: 'openai-chat',
      codecVersion: '1',
    },
    create: () => ({ run: async () => await new Promise(() => undefined) }),
  })
  .seal();

// This intentionally remains referenced. The Process target's parent-disconnect watchdog,
// rather than natural event-loop quiescence, must bound the direct child lifetime.
setInterval(() => undefined, 1_000);

if (process.argv[2] === 'waiting-bootstrap-disconnect') {
  const serving = serveProcessSubAgentTarget({ createRegistry: () => registry });
  await sendFixtureState('waiting-bootstrap');
  await serving;
} else if (process.argv[2] === 'disconnected-before-serve') {
  await sendFixtureState('before-serve');
  if (process.connected) await new Promise((resolve) => process.once('disconnect', resolve));
  await serveProcessSubAgentTarget({ createRegistry: () => registry });
} else {
  await serveProcessSubAgentTarget({ createRegistry: () => registry });
}
await new Promise(() => undefined);

function sendFixtureState(state) {
  return new Promise((resolve, reject) => {
    process.send?.({ type: 'fixture-state', state }, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}
