/**
 * 方舟 Responses 冒烟 demo：通过一次真实模型对话验证工具调用、事件通知与
 * `end-agent` 生命周期结束流程。
 */
import { Agent, OpenAIModel, Tool, type AgentResponseOutputItem } from '@manee/agent-framework';
import { z } from 'zod';

const defaultArkBaseURL = 'https://ark.cn-beijing.volces.com/api/v3';
const defaultArkModel = 'doubao-seed-2-0-pro-260215';

/** 保存一条模型生成事实的最小 Agent，用来证明真实函数调用闭环可运行。 */
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

/** 创建方舟模型连接、挂载观测事件并运行单次真实冒烟任务。 */
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

  agent.onModelResponse((output) => {
    console.log(`model: ${summarizeOutput(output)}`);
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

function summarizeOutput(output: readonly AgentResponseOutputItem[]): string {
  return output
    .map((item) => {
      if (item.type === 'function_call' && 'name' in item) {
        return `function_call:${String(item.name)}`;
      }

      if (item.type === 'message' && 'role' in item) {
        return `message:${String(item.role)}`;
      }

      return item.type;
    })
    .join(', ');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
