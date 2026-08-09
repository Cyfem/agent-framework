import { describe, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  acceptanceIt,
  createExecutorConformanceControl,
  createExecutorConformanceRequest,
} from '../../../testkit';

import {
  canonicalJsonSha256,
  defineSubAgent,
  MemoryProviderOperationLedgerStore,
  OpenAIChatModel,
  OpenAIResponsesModel,
  ProviderOperationLedger,
  SubAgentTargetRunnerRegistry,
  SubAgentTransportModelGatewayHandler,
  SubAgentTransportModelGatewayRegistry,
  type JsonValue,
  type SubAgentDefinitionRegistration,
  type SubAgentChildCheckpoint,
  type SubAgentExecutionControl,
  type SubAgentTargetRunnerManifest,
  type SubAgentTransportModelRequestHandler,
} from '@ruixutong.manee/maneeagent-framework';

import { WorkerSubAgentExecutor } from '../src';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const TARGET_ENTRY = new URL('./fixtures/worker-protocol-target.mjs', import.meta.url);
const PROOF = 'worker-protocol-proxy-proof';

const outputSchema = z.object({ proof: z.string().min(1) }).strict();
const chatDefinition = createDefinition('worker-chat-child');
const responsesDefinition = createDefinition('worker-responses-child');

function createDefinition(name: string) {
  return defineSubAgent({
    name,
    version: '2',
    description: `Run the ${name} protocol through the controller Model gateway.`,
    inputSchema: z.object({ proof: z.string().min(1) }).strict(),
    outputSchema,
  });
}

function createExpectedManifest(): SubAgentTargetRunnerManifest {
  const manifestChatDefinition = createManifestDefinition(chatDefinition.name);
  const manifestResponsesDefinition = createManifestDefinition(responsesDefinition.name);
  return new SubAgentTargetRunnerRegistry()
    .register({
      definition: manifestChatDefinition,
      runnerId: 'worker-chat-child-runner',
      runnerVersion: '2.0.0',
      childCheckpointVersions: ['1'],
      modelBinding: {
        gatewayId: 'worker-chat-gateway',
        protocol: 'openai-chat',
        codecVersion: '1',
      },
      create: unreachableFactory,
    })
    .register({
      definition: manifestResponsesDefinition,
      runnerId: 'worker-responses-child-runner',
      runnerVersion: '2.0.0',
      childCheckpointVersions: ['1'],
      modelBinding: {
        gatewayId: 'worker-responses-gateway',
        protocol: 'openai-responses',
        codecVersion: '1',
      },
      create: unreachableFactory,
    })
    .seal()
    .manifest();
}

function createManifestDefinition(name: string): SubAgentDefinitionRegistration {
  return Object.freeze({
    name,
    version: '2',
    description: 'Manifest-only erased Worker protocol definition.',
    inputSchema: z.json(),
    outputSchema: z.json(),
  });
}

function unreachableFactory(): never {
  throw new Error('The controller manifest registry must never create a runner.');
}

interface ProtocolHarness {
  readonly executor: WorkerSubAgentExecutor;
  readonly sdkCreate: ReturnType<typeof vi.fn>;
  readonly control: SubAgentExecutionControl;
  readonly checkpoints: Map<
    string,
    Readonly<{ digest: string; revision: number; checkpoint: SubAgentChildCheckpoint }>
  >;
  readonly reserved: string[];
}

function createChatHarness(): ProtocolHarness {
  const sdkCreate = vi
    .fn()
    .mockResolvedValueOnce(
      chatToolResponse('worker-chat-result', 'agent-result', {
        result: { proof: PROOF },
      }),
    )
    .mockResolvedValueOnce(chatToolResponse('worker-chat-end', 'end-agent', {}));
  const model = new OpenAIChatModel({
    model: 'offline-worker-chat',
    client: { chat: { completions: { create: sdkCreate } } } as never,
  });
  return createHarness({
    gatewayId: 'worker-chat-gateway',
    protocol: 'openai-chat',
    definitionName: chatDefinition.name,
    model,
    sdkCreate,
  });
}

function createResponsesHarness(): ProtocolHarness {
  const sdkCreate = vi
    .fn()
    .mockResolvedValueOnce(
      responsesToolResponse('worker-responses-result', 'agent-result', {
        result: { proof: PROOF },
      }),
    )
    .mockResolvedValueOnce(responsesToolResponse('worker-responses-end', 'end-agent', {}));
  const model = new OpenAIResponsesModel({
    model: 'offline-worker-responses',
    client: { responses: { create: sdkCreate } } as never,
  });
  return createHarness({
    gatewayId: 'worker-responses-gateway',
    protocol: 'openai-responses',
    definitionName: responsesDefinition.name,
    model,
    sdkCreate,
  });
}

function createHarness(options: {
  readonly gatewayId: string;
  readonly protocol: 'openai-chat' | 'openai-responses';
  readonly definitionName: string;
  readonly model: OpenAIChatModel | OpenAIResponsesModel;
  readonly sdkCreate: ReturnType<typeof vi.fn>;
}): ProtocolHarness {
  const taskId = `worker-protocol-${options.definitionName}`;
  const request = createExecutorConformanceRequest({
    executorName: 'worker',
    taskId,
    definition: { name: options.definitionName, version: '2' },
    input: { proof: PROOF },
  });
  const recorder = createExecutorConformanceControl({
    ownerSessionId: request.ownerSessionId,
    taskId,
    signal: request.signal,
    deadlineAt: request.deadlineAt,
    approval: 'approved',
  });
  const checkpoints = new Map<
    string,
    Readonly<{ digest: string; revision: number; checkpoint: SubAgentChildCheckpoint }>
  >();
  const control = Object.freeze({
    ...recorder.control,
    commitCheckpoint: async (operationId: string, checkpoint: SubAgentChildCheckpoint) => {
      const digest = canonicalJsonSha256(checkpoint as unknown as JsonValue);
      const existing = checkpoints.get(operationId);
      if (existing !== undefined) {
        expect(existing.checkpoint).toEqual(checkpoint);
        return;
      }
      checkpoints.set(
        operationId,
        Object.freeze({ digest, revision: checkpoints.size + 1, checkpoint }),
      );
      await recorder.control.commitCheckpoint(operationId, checkpoint);
    },
  });

  const gatewayRegistry = new SubAgentTransportModelGatewayRegistry();
  if (options.protocol === 'openai-chat') {
    const model = options.model as OpenAIChatModel;
    gatewayRegistry.register({
      gatewayId: options.gatewayId,
      protocol: options.protocol,
      codec: model.checkpointCodec,
      model,
    });
  } else {
    const model = options.model as OpenAIResponsesModel;
    gatewayRegistry.register({
      gatewayId: options.gatewayId,
      protocol: options.protocol,
      codec: model.checkpointCodec,
      model,
    });
  }
  gatewayRegistry.seal();
  const reserved: string[] = [];
  const gateway = new SubAgentTransportModelGatewayHandler({
    registry: gatewayRegistry,
    ledger: new ProviderOperationLedger({ store: new MemoryProviderOperationLedgerStore() }),
    acknowledgeCheckpoint: (operation) => {
      const stored = checkpoints.get(operation.checkpointOperationId);
      if (stored === undefined) {
        throw new Error('The Worker target requested a Model before its checkpoint ACK.');
      }
      expect(stored.digest).toBe(operation.checkpointDigest);
      return {
        checkpointRevision: stored.revision,
        checkpointDigest: stored.digest,
      };
    },
    reserveBudget: (operation) => {
      reserved.push(operation.providerOperationId);
    },
  });
  const modelHandler: SubAgentTransportModelRequestHandler = (context) =>
    gateway.handle({
      ownerSessionId: context.ownerSessionId,
      taskId: context.taskId,
      operationId: context.operationId,
      payload: context.payload,
      signal: context.signal,
      deadlineAt: context.deadlineAt,
    });
  return {
    executor: new WorkerSubAgentExecutor({
      targetEntry: TARGET_ENTRY,
      expectedManifest: createExpectedManifest(),
      model: modelHandler,
      handshakeTimeoutMs: 5_000,
      terminateTimeoutMs: 100,
    }),
    sdkCreate: options.sdkCreate,
    control,
    checkpoints,
    reserved,
  };
}

async function executeProtocolHarness(harness: ProtocolHarness, definitionName: string) {
  assertNetworkDenyGuardInstalled();
  const taskId = `worker-protocol-${definitionName}`;
  const request = createExecutorConformanceRequest({
    executorName: 'worker',
    taskId,
    definition: { name: definitionName, version: '2' },
    input: { proof: PROOF },
  });
  try {
    const outcome = await harness.executor.execute(request, harness.control);
    expect(outcome).toMatchObject({
      type: 'terminal',
      result: {
        status: 'succeeded',
        output: { proof: PROOF },
      },
    });
    expect(harness.sdkCreate).toHaveBeenCalledTimes(2);
    for (const call of harness.sdkCreate.mock.calls) {
      expect(call[1]).toMatchObject({ maxRetries: 0 });
    }
    expect(harness.checkpoints.size).toBeGreaterThanOrEqual(2);
    expect(new Set(harness.reserved).size).toBe(2);
  } finally {
    await harness.executor.dispose();
  }
}

describe('Worker placement Chat and Responses Model proxies', () => {
  acceptanceIt('C7-WORKER-08.l4.chat-model-proxy', 'fake-openai-chat-sdk', async () => {
    await executeProtocolHarness(createChatHarness(), chatDefinition.name);
  });

  acceptanceIt('C7-WORKER-09.l4.responses-model-proxy', 'fake-openai-responses-sdk', async () => {
    await executeProtocolHarness(createResponsesHarness(), responsesDefinition.name);
  });
});

function chatToolResponse(callId: string, name: string, parameters: JsonValue) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: { name, arguments: JSON.stringify(parameters) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}

function responsesToolResponse(callId: string, name: string, parameters: JsonValue) {
  return {
    output: [
      {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: JSON.stringify(parameters),
        status: 'completed',
      },
    ],
    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
  };
}
