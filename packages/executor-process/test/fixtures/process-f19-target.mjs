import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import process from 'node:process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';

import { z } from 'zod';

import {
  canonicalJsonSha256,
  createOpenAIChatProtocolSurface,
  createSubAgentTransportModelProxy,
  defineSubAgent,
  SubAgentTargetRunnerRegistry,
} from '../../../core/dist/index.js';
import { serveProcessSubAgentTarget } from '../../dist/index.js';

assertProcessNetworkDenyInstalled();

const definition = defineSubAgent({
  name: 'process-f19-child',
  version: '2',
  description: 'Exercise Process provider reply-loss and outcome-unknown recovery windows.',
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

await serveProcessSubAgentTarget({
  createRegistry: ({ modelExchange }) => {
    const model = createSubAgentTransportModelProxy({
      protocol: createOpenAIChatProtocolSurface(),
      gatewayId: 'process-f19-gateway',
      exchange: modelExchange,
    });
    return new SubAgentTargetRunnerRegistry()
      .register({
        definition,
        runnerId: 'process-f19-runner',
        runnerVersion: '2.0.0',
        childCheckpointVersions: ['1'],
        modelBinding: {
          gatewayId: 'process-f19-gateway',
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
  const providerOperationId = `process-f19-provider-${request.taskId}`;
  const mustCrash = request.checkpoint === undefined || request.input.crashOnResume === true;
  const crashPath = join(tmpdir(), `maneeagent-${request.taskId}.signal`);
  const crashTimer = mustCrash
    ? setInterval(() => {
        if (!existsSync(crashPath)) return;
        rmSync(crashPath, { force: true });
        process.exit(79);
      }, 5)
    : undefined;
  if (crashTimer !== undefined) {
    await control.reportProgress(`process-f19-crash-ready-${request.attempt}`, {
      message: 'process-f19-crash-channel-ready',
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
  const checkpointOperationId = `process-f19-checkpoint-${checkpointDigest}`;
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
    if (crashTimer !== undefined) clearInterval(crashTimer);
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
  await control.completion.submitResult('process-f19-result', output);
  await control.completion.complete('process-f19-complete', { isStandalone: true });
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
    runnerId: 'process-f19-runner',
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
