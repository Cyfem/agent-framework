import { z } from 'zod';

import { defineSubAgent, SubAgentTargetRunnerRegistry } from '../../../core/dist/index.js';

const definition = defineSubAgent({
  name: 'worker-conformance-child',
  version: '2',
  description: 'Handshake-only Worker fixture definition.',
  inputSchema: z.json(),
  outputSchema: z.json(),
});

export const workerHandshakeManifest = new SubAgentTargetRunnerRegistry()
  .register({
    definition,
    runnerId: 'worker-conformance-runner',
    runnerVersion: '2.0.0',
    childCheckpointVersions: ['1'],
    modelBinding: {
      gatewayId: 'worker-conformance-model',
      protocol: 'openai-chat',
      codecVersion: '1',
    },
    create: () => ({
      run: async () => {
        throw new Error('A handshake-only fixture must not receive executor traffic.');
      },
    }),
  })
  .seal()
  .manifest();
