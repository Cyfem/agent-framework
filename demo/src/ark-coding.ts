/**
 * 方舟 Coding Plan 真实 smoke demo。
 *
 * Coding Plan endpoint 使用 OpenAI-compatible Chat Completions 路径，
 * 因此这里验证 `OpenAIChatModel` 的真实工具调用闭环。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Agent,
  OpenAIChatModel,
  Tool,
  type OpenAIChatContext,
  type OpenAIChatProtocol,
} from '@manee/agent-framework';
import { z } from 'zod';

const defaultArkCodingBaseURL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const defaultArkCodingModel = 'glm-5.1';

loadLocalEnv();

const apiKey = process.env.ARK_API_KEY;

class ArkCodingDemoAgent extends Agent<OpenAIChatProtocol> {
  #facts: string[] = [];

  @Tool({
    name: 'record-coding-plan-fact',
    description:
      'Record one concise fact learned during this Ark Coding Plan Chat smoke test. Use this tool exactly once.',
    parameters: z.object({
      fact: z.string().min(1),
    }),
  })
  #recordCodingPlanFact(parameters: unknown): Record<string, unknown> {
    // 保存真实模型工具调用传入的事实，用于确认 Chat tool result 闭环成功。
    const { fact } = parameters as { fact: string };

    this.#facts.push(fact);

    return {
      saved: true,
      count: this.#facts.length,
      facts: this.#facts,
    };
  }
}

async function runArkCodingDemo(apiKey: string): Promise<void> {
  // Coding Plan 使用 Chat endpoint，因此这里专门验证 OpenAIChatModel。
  const baseURL = process.env.ARK_CODING_BASE_URL ?? defaultArkCodingBaseURL;
  const modelName = process.env.ARK_CODING_MODEL ?? defaultArkCodingModel;

  const agent = new ArkCodingDemoAgent({
    llm: new OpenAIChatModel({
      apiKey,
      baseURL,
      model: modelName,
    }),
    maxIterations: 6,
    systemPrompts: [
      'You are testing a Node.js agent framework through Ark Coding Plan Chat Completions.',
      'Call record-coding-plan-fact exactly once, wait for its tool result, then call end-agent by itself.',
      'Do not modify files. Keep the fact short.',
    ],
  });

  agent.onModelResponse((messages) => {
    console.log(`model: ${summarizeMessages(messages)}`);
  });

  agent.onBeforeToolCall(
    'record-coding-plan-fact',
    (parameters) => {
      console.log(`before record-coding-plan-fact: ${JSON.stringify(parameters)}`);
    },
    {
      await: true,
      errorCancel: true,
    },
  );

  agent.onAfterToolCall(
    'record-coding-plan-fact',
    (_parameters, _call, result) => {
      console.log(`after record-coding-plan-fact: ${JSON.stringify(result)}`);
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

  agent.onAgentStatusChanged('running', (_rawContext, context) => {
    console.log(`status: running context=${context.length}`);
  });

  agent.onAgentStatusChanged('ended', (_rawContext, context) => {
    console.log(`status: ended context=${context.length}`);
  });

  agent.onAgentStatusChanged('failed', (_rawContext, context) => {
    console.log(`status: failed context=${context.length}`);
  });

  agent.init();

  console.log(`ark coding demo: baseURL=${baseURL} model=${modelName}`);

  const finalContext = await agent.agent(
    [
      'Run a minimal smoke test for this agent framework on Ark Coding Plan.',
      'Use record-coding-plan-fact to save one short fact about this test.',
      'After the tool result is available, call end-agent alone.',
    ].join('\n'),
  );

  const toolOutputs = finalContext.filter((message) => message.role === 'tool');

  console.log(
    `ark coding demo complete: messages=${finalContext.length} toolOutputs=${toolOutputs.length}`,
  );
}

function loadLocalEnv(): void {
  // demo/.env 仅作为本地便利入口，已存在的环境变量优先级更高。
  const currentFile = fileURLToPath(import.meta.url);
  const demoRoot = dirname(dirname(currentFile));
  const envPath = resolve(demoRoot, '.env');

  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex < 1) {
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    process.env[name] ??= value;
  }
}

function summarizeMessages(messages: readonly OpenAIChatContext[]): string {
  // 只输出消息角色和工具名，避免把完整模型文本刷到终端。
  return messages
    .map((message) => {
      if (message.role === 'assistant') {
        const calls = message.tool_calls?.map((call) =>
          call.type === 'function' ? call.function.name : call.type,
        );

        return calls && calls.length > 0 ? `assistant(tool_calls=${calls.join(',')})` : 'assistant';
      }

      return message.role;
    })
    .join(', ');
}

function toErrorMessage(error: unknown): string {
  // 事件回调传入 unknown，日志统一转换为短错误文本。
  return error instanceof Error ? error.message : String(error);
}

if (!apiKey) {
  console.error('Missing ARK_API_KEY. Put it in demo/.env or export it before running.');
  process.exitCode = 1;
} else {
  await runArkCodingDemo(apiKey);
}
