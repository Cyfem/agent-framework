import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import { z } from 'zod';

import {
  Agent,
  createOpenAIChatProtocolSurface,
  createOpenAIResponsesProtocolSurface,
  createSubAgentTransportModelProxy,
  defineSubAgent,
  SubAgentTargetRunnerRegistry,
} from '../../../core/dist/index.js';
import { serveProcessSubAgentTarget } from '../../dist/index.js';

assertProcessNetworkDenyInstalled();

const outputSchema = z.object({ proof: z.string().min(1) }).strict();
const chatDefinition = createDefinition('process-chat-child');
const responsesDefinition = createDefinition('process-responses-child');

await serveProcessSubAgentTarget({
  createRegistry: ({ modelExchange }) =>
    new SubAgentTargetRunnerRegistry()
      .register(
        createRegistration({
          definition: chatDefinition,
          gatewayId: 'process-chat-gateway',
          protocol: 'openai-chat',
          protocolSurface: createOpenAIChatProtocolSurface(),
          modelExchange,
        }),
      )
      .register(
        createRegistration({
          definition: responsesDefinition,
          gatewayId: 'process-responses-gateway',
          protocol: 'openai-responses',
          protocolSurface: createOpenAIResponsesProtocolSurface(),
          modelExchange,
        }),
      )
      .seal(),
});

function createDefinition(name) {
  return defineSubAgent({
    name,
    version: '2',
    description: `Run the ${name} protocol through the controller Model gateway.`,
    inputSchema: z.object({ proof: z.string().min(1) }).strict(),
    outputSchema,
  });
}

function createRegistration(options) {
  return {
    definition: options.definition,
    runnerId: `${options.definition.name}-runner`,
    runnerVersion: '2.0.0',
    childCheckpointVersions: ['1'],
    modelBinding: {
      gatewayId: options.gatewayId,
      protocol: options.protocol,
      codecVersion: '1',
    },
    create: ({ definition, executorName }) => {
      const agent = new Agent({
        llm: createSubAgentTransportModelProxy({
          protocol: options.protocolSurface,
          gatewayId: options.gatewayId,
          exchange: options.modelExchange,
        }),
        maxIterations: 3,
        modelErrorRecovery: {
          unhandledRetryLimit: 0,
          contextLengthRecoveryLimit: 0,
        },
      });
      let previousTaskId;
      return {
        run: async (request, control) => {
          if (previousTaskId !== undefined && previousTaskId !== request.taskId) {
            throw new Error('A Process protocol runner cannot be rebound to another task.');
          }
          previousTaskId = request.taskId;
          return agent.runAsSubAgent({
            request,
            control,
            runnerId: `${options.definition.name}-runner`,
            runnerVersion: '2.0.0',
            executorName,
            checkpointMode: 'durable',
            input: `Return this exact proof marker through agent-result: ${request.input.proof}`,
            outputSchema: definition.outputSchema,
          });
        },
      };
    },
  };
}
