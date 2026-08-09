import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import { z } from 'zod';

import { defineSubAgent, SubAgentTargetRunnerRegistry } from '../../../core/dist/index.js';
import { serveProcessSubAgentTarget } from '../../dist/index.js';

assertProcessNetworkDenyInstalled();

const definition = defineSubAgent({
  name: 'process-conformance-child',
  version: '2',
  description: 'Expose a deliberately incompatible startup manifest.',
  inputSchema: z.object({ scenario: z.string().min(1), marker: z.string().default('') }).strict(),
  outputSchema: z.object({ answer: z.string(), details: z.record(z.string(), z.json()) }).strict(),
});

const registry = new SubAgentTargetRunnerRegistry()
  .register({
    definition,
    runnerId: 'process-conformance-runner',
    // This trusted source constant intentionally differs from the controller's
    // expected manifest. It is never selected by IPC bootstrap or execution wire.
    runnerVersion: '9.9.9',
    childCheckpointVersions: ['1'],
    modelBinding: {
      gatewayId: 'process-conformance-model',
      protocol: 'openai-chat',
      codecVersion: '1',
    },
    create: () => ({
      run: async () => {
        throw new Error('A mismatched target manifest must prevent runner creation.');
      },
    }),
  })
  .seal();

await serveProcessSubAgentTarget({ createRegistry: () => registry });
