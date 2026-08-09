import { z } from 'zod';

import { defineSubAgent, SubAgentTargetRunnerRegistry } from '../../../core/dist/index.js';

const definition = defineSubAgent({
  name: 'process-conformance-child',
  version: '2',
  description: 'Handshake-only Process fixture definition.',
  inputSchema: z.json(),
  outputSchema: z.json(),
});

export const processHandshakeManifest = new SubAgentTargetRunnerRegistry()
  .register({
    definition,
    runnerId: 'process-conformance-runner',
    runnerVersion: '2.0.0',
    childCheckpointVersions: ['1'],
    modelBinding: {
      gatewayId: 'process-conformance-model',
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
