import { assertWorkerNetworkDenyInstalled } from './worker-network-deny.mjs';

import process from 'node:process';
import { BroadcastChannel, isMainThread } from 'node:worker_threads';

import { z } from 'zod';

import {
  canonicalJsonSha256,
  createOpenAIChatProtocolSurface,
  createSubAgentTransportModelProxy,
  defineSubAgent,
  SubAgentTargetRunnerRegistry,
} from '../../../core/dist/index.js';
import { serveWorkerSubAgentTarget } from '../../dist/index.js';

if (isMainThread) throw new Error('The F19 fixture must run in a worker thread.');
assertWorkerNetworkDenyInstalled();

const definition = defineSubAgent({
  name: 'worker-f19-child',
  version: '2',
  description: 'Exercise Worker provider reply-loss and outcome-unknown recovery windows.',
  inputSchema: z
    .object({
      scenario: z.enum(['result-ready', 'outcome-unknown']),
      proof: z.string().min(1),
      crashOnResume: z.boolean().default(false),
    })
    .strict(),
  outputSchema: z
    .object({
      proof: z.string().min(1),
      attempt: z.number().int().positive(),
      executionEpoch: z.string().min(1),
      executionFencingToken: z.string().regex(/^(0|[1-9][0-9]*)$/u),
      providerOperationId: z.string().min(1),
    })
    .strict(),
});

await serveWorkerSubAgentTarget({
  createRegistry: ({ modelExchange }) => {
    const model = createSubAgentTransportModelProxy({
      protocol: createOpenAIChatProtocolSurface(),
      gatewayId: 'worker-f19-gateway',
      exchange: modelExchange,
    });
    return new SubAgentTargetRunnerRegistry()
      .register({
        definition,
        runnerId: 'worker-f19-runner',
        runnerVersion: '2.0.0',
        childCheckpointVersions: ['1'],
        modelBinding: {
          gatewayId: 'worker-f19-gateway',
          protocol: 'openai-chat',
          codecVersion: '1',
        },
        create: ({ definition: registeredDefinition, executorName }) => ({
          run: (request, control) =>
            runF19({
              request,
              control,
              model,
              definition: registeredDefinition,
              executorName,
            }),
        }),
      })
      .seal();
  },
});

async function runF19({ request, control, model, definition: registeredDefinition, executorName }) {
  const context = [
    model.buildUserMessage({
      content: [{ type: 'text', text: `Return exactly: ${request.input.proof}` }],
    }),
  ];
  const providerOperationId = `worker-f19-provider-${request.taskId}`;
  const mustCrash = request.checkpoint === undefined || request.input.crashOnResume === true;
  const crashChannel = mustCrash
    ? new BroadcastChannel(`maneeagent-worker-f19-${request.taskId}`)
    : undefined;
  if (crashChannel !== undefined) {
    crashChannel.onmessage = (event) => {
      if (event.data === 'crash-after-controller-barrier') process.exit(79);
    };
    await control.reportProgress(`worker-f19-crash-ready-${request.attempt}`, {
      message: 'worker-f19-crash-channel-ready',
      data: {
        attempt: request.attempt,
        executionEpoch: request.executionEpoch,
        executionFencingToken: request.executionFencingToken,
      },
    });
  }
  const checkpoint =
    request.checkpoint ??
    createInFlightCheckpoint({
      context,
      providerOperationId,
      model,
    });
  const checkpointDigest = canonicalJsonSha256(checkpoint);
  const checkpointOperationId = `worker-f19-checkpoint-${checkpointDigest}`;
  await control.commitCheckpoint(checkpointOperationId, checkpoint);

  const generated = model.generate({
    context,
    tools: [],
    signal: request.signal,
    deadlineAt: request.deadlineAt,
    runtime: {
      sessionId: request.ownerSessionId,
      runId: request.runId,
      taskId: request.taskId,
      executionAttempt: request.attempt,
      executionEpoch: request.executionEpoch,
      executionFencingToken: request.executionFencingToken,
      providerOperationId,
      checkpointOperationId,
      checkpointDigest,
      iteration: 0,
      requestAttempt: 1,
    },
  });
  let result;
  try {
    result = await generated;
  } finally {
    crashChannel?.close();
  }
  const proof = readAssistantText(result.messages);
  const output = {
    proof,
    attempt: request.attempt,
    executionEpoch: request.executionEpoch,
    executionFencingToken: request.executionFencingToken,
    providerOperationId,
  };
  registeredDefinition.outputSchema.parse(output);
  await control.completion.submitResult('worker-f19-result', output);
  await control.completion.complete('worker-f19-complete', { isStandalone: true });
  return {
    type: 'terminal',
    result: {
      status: 'succeeded',
      task: { taskId: request.taskId, subAgent: request.definition },
      executor: executorName,
      output,
    },
  };
}

function createInFlightCheckpoint({ context, providerOperationId, model }) {
  const now = 1;
  return {
    version: '1',
    runnerId: 'worker-f19-runner',
    runnerVersion: '2.0.0',
    protocolContext: {
      protocol: 'openai-chat',
      codecVersion: '1',
      value: model.checkpointCodec.encode(context),
    },
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
    modelOperation: {
      version: '1',
      operationId: providerOperationId,
      iteration: 0,
      purpose: 'agent',
      requestAttempt: 1,
      requestHash: 'a'.repeat(64),
      phase: 'in_flight',
      preparedAt: now,
      updatedAt: now,
    },
  };
}

function readAssistantText(messages) {
  const message = messages[0];
  if (message?.role !== 'assistant' || typeof message.content !== 'string') {
    throw new Error('The F19 controller Model must return one assistant text message.');
  }
  return message.content;
}
