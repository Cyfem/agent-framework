import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import process from 'node:process';
import { z } from 'zod';

import { defineSubAgent, SubAgentTargetRunnerRegistry } from '../../../core/dist/index.js';
import { serveProcessSubAgentTarget } from '../../dist/index.js';

assertProcessNetworkDenyInstalled();

const definition = defineSubAgent({
  name: 'process-send-handle-child',
  version: '2',
  description: 'Reject a forged parent-to-target sendHandle before registry creation.',
  inputSchema: z.json(),
  outputSchema: z.json(),
});

await serveProcessSubAgentTarget({
  createRegistry: () => {
    process.send?.({ version: 'test-only', type: 'factory-called' });
    return new SubAgentTargetRunnerRegistry()
      .register({
        definition,
        runnerId: 'process-send-handle-runner',
        runnerVersion: '2.0.0',
        childCheckpointVersions: ['1'],
        modelBinding: {
          gatewayId: 'process-send-handle-model',
          protocol: 'openai-chat',
          codecVersion: '1',
        },
        create: () => ({ run: async () => await new Promise(() => undefined) }),
      })
      .seal();
  },
});
