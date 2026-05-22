import { Agent, OpenAIModel, Tool, type AgentContext } from '@manee/agent-framework';
import { z } from 'zod';

const defaultArkBaseURL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const defaultArkModel = 'glm-5.1';

class ArkGlmDemoAgent extends Agent {
  #facts: string[] = [];

  @Tool({
    name: 'record-agent-fact',
    description:
      'Record one concise fact learned during this framework smoke test. Use this tool once before ending the task.',
    parameters: z.object({
      fact: z.string().min(1),
    }),
  })
  #recordAgentFact(parameters: unknown): string {
    const { fact } = parameters as { fact: string };
    this.#facts.push(fact);

    return JSON.stringify({
      saved: true,
      count: this.#facts.length,
      facts: this.#facts,
    });
  }
}

const apiKey = process.env.ARK_API_KEY;

if (!apiKey) {
  console.error('Missing ARK_API_KEY. Run this demo with an Ark Coding Plan API key.');
  process.exitCode = 1;
} else {
  await runArkGlmDemo(apiKey);
}

async function runArkGlmDemo(apiKey: string): Promise<void> {
  const baseURL = process.env.ARK_BASE_URL ?? defaultArkBaseURL;
  const modelName = process.env.ARK_MODEL ?? defaultArkModel;

  const agent = new ArkGlmDemoAgent({
    llm: new OpenAIModel({
      apiKey,
      baseURL,
      model: modelName,
    }),
    maxIterations: 6,
    systemPrompts: [
      'You are testing a Node.js agent framework through Ark Coding Plan.',
      'For this smoke test, call record-agent-fact exactly once, then call end-agent by itself in a later step.',
    ],
  });

  agent.onModelResponse((message) => {
    console.log(`model: ${summarizeMessage(message)}`);
  });

  agent.onBeforeToolCall(
    'record-agent-fact',
    (parameters) => {
      console.log(`before record-agent-fact: ${JSON.stringify(parameters)}`);
    },
    {
      await: true,
      errorCancel: true,
    },
  );

  agent.onAfterToolCall(
    'record-agent-fact',
    (_parameters, _message, result) => {
      console.log(`after record-agent-fact: ${String(result)}`);
    },
    {
      await: true,
    },
  );

  agent.onToolCallError((name, triggerType, error) => {
    console.log(`tool error: ${name}/${triggerType}/${toErrorMessage(error)}`);
  });

  agent.onAgentError((error) => {
    console.log(`agent error: ${error.message}`);
  });

  agent.onAgentStatusChanged('running', (rawContext, context) => {
    console.log(`status: running raw=${rawContext.length} context=${context.length}`);
  });

  agent.onAgentStatusChanged('ended', (rawContext, context) => {
    console.log(`status: ended raw=${rawContext.length} context=${context.length}`);
  });

  agent.onAgentStatusChanged('failed', (rawContext, context) => {
    console.log(`status: failed raw=${rawContext.length} context=${context.length}`);
  });

  agent.init();

  console.log(`ark demo: baseURL=${baseURL} model=${modelName}`);

  const finalContext = await agent.agent(
    [
      'Run a minimal smoke test for this agent framework.',
      'Use record-agent-fact to save one short fact about the test.',
      'After the tool result is available, call end-agent alone.',
      'Do not modify files.',
    ].join('\n'),
  );

  console.log(`ark demo complete: messages=${finalContext.length}`);
}

function summarizeMessage(message: AgentContext): string {
  if (message.role === 'assistant') {
    const toolNames = message.toolCalls?.map((toolCall) => toolCall.name).join(', ') ?? 'none';
    const content = message.content?.replace(/\s+/g, ' ').trim() ?? '';
    return `assistant content=${JSON.stringify(content)} tools=${toolNames}`;
  }

  return message.role;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
