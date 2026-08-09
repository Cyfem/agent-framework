import { assertWorkerNetworkDenyInstalled } from './worker-network-deny.mjs';

import { isMainThread } from 'node:worker_threads';

import { z } from 'zod';

import { defineSubAgent, SubAgentTargetRunnerRegistry } from '../../../core/dist/index.js';
import { serveWorkerSubAgentTarget } from '../../dist/index.js';

assertWorkerNetworkDenyInstalled();

if (isMainThread) {
  throw new Error('The mismatched Worker target must run in a worker thread.');
}

const definition = defineSubAgent({
  name: 'worker-conformance-child',
  version: '2',
  description: 'Expose a deliberately incompatible startup manifest.',
  inputSchema: z.object({ scenario: z.string().min(1), marker: z.string().default('') }).strict(),
  outputSchema: z.object({ answer: z.string(), details: z.record(z.string(), z.json()) }).strict(),
});

const registry = new SubAgentTargetRunnerRegistry()
  .register({
    definition,
    runnerId: 'worker-conformance-runner',
    // This trusted source constant intentionally differs from the controller's
    // expected manifest. It is never selected by workerData or execution wire.
    runnerVersion: '9.9.9',
    childCheckpointVersions: ['1'],
    modelBinding: {
      gatewayId: 'worker-conformance-model',
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

await serveWorkerSubAgentTarget({ createRegistry: () => registry });
