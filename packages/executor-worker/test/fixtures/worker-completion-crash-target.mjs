import process from 'node:process';
import { BroadcastChannel, isMainThread } from 'node:worker_threads';

import { z } from 'zod';

import {
  canonicalJsonSha256,
  defineSubAgent,
  SubAgentTargetRunnerRegistry,
} from '../../../core/dist/index.js';
import { serveWorkerSubAgentTarget } from '../../dist/index.js';
import { assertWorkerNetworkDenyInstalled } from './worker-network-deny.mjs';

if (isMainThread) throw new Error('The completion crash fixture must run in a worker thread.');
assertWorkerNetworkDenyInstalled();

const RESULT_CALL_ID = 'worker-completion-crash-result';
const COMPLETION_CALL_ID = 'worker-completion-crash-end';

const definition = defineSubAgent({
  name: 'worker-completion-crash-child',
  version: '2',
  description: 'Exercise result-receipt and terminal completion reply-loss windows.',
  inputSchema: z
    .object({
      scenario: z.enum(['result-receipt', 'terminal-completion']),
      proof: z.string().min(1),
      barrierId: z.string().min(1),
    })
    .strict(),
  outputSchema: z
    .object({
      proof: z.string().min(1),
      scenario: z.enum(['result-receipt', 'terminal-completion']),
      attempt: z.number().int().positive(),
      executionEpoch: z.string().min(1),
      executionFencingToken: z.string().regex(/^(0|[1-9][0-9]*)$/u),
    })
    .strict(),
});

await serveWorkerSubAgentTarget({
  createRegistry: () =>
    new SubAgentTargetRunnerRegistry()
      .register({
        definition,
        runnerId: 'worker-completion-crash-runner',
        runnerVersion: '2.0.0',
        childCheckpointVersions: ['1'],
        modelBinding: {
          gatewayId: 'worker-completion-crash-model',
          protocol: 'openai-chat',
          codecVersion: '1',
        },
        create: ({ definition: registeredDefinition, executorName }) => ({
          run: (request, control) =>
            runCompletionCrash({
              request,
              control,
              definition: registeredDefinition,
              executorName,
            }),
        }),
      })
      .seal(),
});

async function runCompletionCrash({
  request,
  control,
  definition: registeredDefinition,
  executorName,
}) {
  if (request.attempt !== 1 || request.checkpoint !== undefined) {
    throw new Error('A completion crash window must never create a replacement Worker execution.');
  }

  const crashChannel = new BroadcastChannel(
    `maneeagent-worker-completion-crash-${request.input.barrierId}`,
  );
  crashChannel.onmessage = (event) => {
    if (event.data === 'crash-after-authoritative-cas') process.exit(83);
  };

  try {
    await control.reportProgress('worker-completion-crash-ready', {
      message: 'completion-crash-channel-ready',
      data: { attempt: request.attempt },
    });

    const checkpoint = createCheckpoint();
    await control.commitCheckpoint('worker-completion-crash-checkpoint', checkpoint);

    const output = {
      proof: request.input.proof,
      scenario: request.input.scenario,
      attempt: request.attempt,
      executionEpoch: request.executionEpoch,
      executionFencingToken: request.executionFencingToken,
    };
    registeredDefinition.outputSchema.parse(output);

    await control.completion.submitResult(RESULT_CALL_ID, output);
    await control.commitCheckpoint(
      'worker-completion-crash-result-checkpoint',
      createResultCheckpoint(checkpoint, output),
    );
    await control.completion.complete(COMPLETION_CALL_ID, { isStandalone: true });

    return {
      type: 'terminal',
      result: {
        status: 'succeeded',
        task: { taskId: request.taskId, subAgent: request.definition },
        executor: executorName,
        output,
      },
    };
  } finally {
    crashChannel.close();
  }
}

function createCheckpoint() {
  return {
    version: '1',
    runnerId: 'worker-completion-crash-runner',
    runnerVersion: '2.0.0',
    protocolContext: { protocol: 'openai-chat', codecVersion: '1', value: [] },
    contextStore: {
      version: '1',
      protocol: 'openai-chat',
      codecVersion: '1',
      revision: 0,
      rawHistory: [],
      activeSpans: [
        {
          spanId: 'context-span-1',
          kind: 'seed',
          closed: true,
          originalContext: [],
          entries: [],
        },
      ],
      nextRawItemId: 1,
      nextSpanId: 2,
      nextEntryId: 1,
    },
    modelIteration: 0,
    maxIterations: 1,
  };
}

function createResultCheckpoint(checkpoint, output) {
  return {
    ...checkpoint,
    resultSubmission: {
      version: '1',
      callId: RESULT_CALL_ID,
      output,
      outputHash: canonicalJsonSha256(output),
    },
  };
}
