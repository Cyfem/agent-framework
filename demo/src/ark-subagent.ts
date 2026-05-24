/**
 * 方舟真实子代理 smoke demo。
 *
 * 同一套子代理验证流程分别跑 Responses 与 Chat：
 * - Responses: https://ark.cn-beijing.volces.com/api/v3
 * - Chat: https://ark.cn-beijing.volces.com/api/coding/v3
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Agent,
  OpenAIChatModel,
  OpenAIResponsesModel,
  Tool,
  type AgentOptions,
  type OpenAIChatContext,
  type OpenAIChatProtocol,
  type OpenAIResponsesContext,
  type OpenAIResponsesProtocol,
} from '@manee/agent-framework';
import { z } from 'zod';

const responsesBaseURL = 'https://ark.cn-beijing.volces.com/api/v3';
const chatBaseURL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const defaultModel = 'glm-5.1';

loadLocalEnv();

const apiKey = process.env.ARK_API_KEY;

const observed = {
  responsesProofCalls: 0,
  chatProofCalls: 0,
};

class ResponsesVerifierAgent extends Agent<OpenAIResponsesProtocol> {
  static override name = 'responses-subagent-verifier';
  static override description = 'Verifies sub-agent dispatch under the Responses protocol.';

  constructor(options: AgentOptions<OpenAIResponsesProtocol>) {
    super({
      ...options,
      maxIterations: 6,
      systemPrompts: [
        ...(options.systemPrompts ?? []),
        [
          'You are a focused sub-agent verifier for Responses.',
          'Call build-subagent-proof exactly once.',
          'Then call agent-result with a result that includes the exact proof string returned by build-subagent-proof.',
          'After agent-result succeeds, call end-agent alone.',
        ].join('\n'),
      ],
    });
  }

  @Tool({
    name: 'build-subagent-proof',
    description: 'Build a deterministic proof string for the Responses sub-agent smoke test.',
    parameters: z.object({
      label: z.string().min(1),
      numbers: z.array(z.number()).min(1),
    }),
  })
  #buildSubagentProof(parameters: unknown): Record<string, unknown> {
    // 子代理内部工具生成可断言的 proof，父代理最终必须收到该字符串。
    const { label, numbers } = parameters as { label: string; numbers: number[] };
    const sum = numbers.reduce((total, item) => total + item, 0);
    const proof = `SUBAGENT_PROOF::responses::${label}::${sum}`;

    observed.responsesProofCalls += 1;
    console.log(`[responses] subagent proof built: ${proof}`);

    return {
      protocol: 'responses',
      label,
      sum,
      proof,
    };
  }
}

class ChatVerifierAgent extends Agent<OpenAIChatProtocol> {
  static override name = 'chat-subagent-verifier';
  static override description = 'Verifies sub-agent dispatch under the Chat protocol.';

  constructor(options: AgentOptions<OpenAIChatProtocol>) {
    super({
      ...options,
      maxIterations: 6,
      systemPrompts: [
        ...(options.systemPrompts ?? []),
        [
          'You are a focused sub-agent verifier for Chat.',
          'Call build-subagent-proof exactly once.',
          'Then call agent-result with a result that includes the exact proof string returned by build-subagent-proof.',
          'After agent-result succeeds, call end-agent alone.',
        ].join('\n'),
      ],
    });
  }

  @Tool({
    name: 'build-subagent-proof',
    description: 'Build a deterministic proof string for the Chat sub-agent smoke test.',
    parameters: z.object({
      label: z.string().min(1),
      numbers: z.array(z.number()).min(1),
    }),
  })
  #buildSubagentProof(parameters: unknown): Record<string, unknown> {
    // Chat 版本使用同名工具，验证子代理逻辑与协议无关。
    const { label, numbers } = parameters as { label: string; numbers: number[] };
    const sum = numbers.reduce((total, item) => total + item, 0);
    const proof = `SUBAGENT_PROOF::chat::${label}::${sum}`;

    observed.chatProofCalls += 1;
    console.log(`[chat] subagent proof built: ${proof}`);

    return {
      protocol: 'chat',
      label,
      sum,
      proof,
    };
  }
}

class ResponsesParentAgent extends Agent<OpenAIResponsesProtocol> {}
class ChatParentAgent extends Agent<OpenAIChatProtocol> {}

async function runResponsesSubAgentSmoke(apiKey: string, model: string): Promise<void> {
  // 父代理只通过内置 agent 工具调度子代理，不直接调用子代理工具。
  const parentResultSnippets: string[] = [];
  const agent = new ResponsesParentAgent({
    llm: new OpenAIResponsesModel({
      apiKey,
      baseURL: responsesBaseURL,
      model,
    }),
    subAgents: [ResponsesVerifierAgent],
    maxIterations: 6,
    systemPrompts: [
      [
        'You are testing sub-agent dispatch with Ark Responses.',
        'First call the agent tool with agentName "responses-subagent-verifier".',
        'Use input: "Call build-subagent-proof with label responses-smoke and numbers [2,3,5], then report the proof string."',
        'Use outputDescription: "A concise result containing SUBAGENT_PROOF::responses::responses-smoke::10".',
        'After the agent tool result is available, call end-agent alone.',
      ].join('\n'),
    ],
  });

  agent.onModelResponse((messages) => {
    console.log(`[responses] model: ${summarizeResponses(messages)}`);
  });

  agent.onBeforeToolCall('agent', (_parameters, call) => {
    console.log(`[responses] before parent agent tool: ${call.arguments}`);
  });

  agent.onAfterToolCall(
    'agent',
    (_parameters, _call, result) => {
      const text = String(result);

      parentResultSnippets.push(text);
      console.log(`[responses] after parent agent tool: ${text.slice(0, 240)}`);
    },
    { await: true },
  );

  agent.onToolCallError((name, triggerType, error) => {
    console.log(`[responses] tool error: ${name}/${triggerType}/${toErrorMessage(error)}`);
  });

  agent.onAgentStatusChanged('ended', (_rawContext, context) => {
    console.log(`[responses] status ended: context=${context.length}`);
  });

  agent.init();

  console.log(`[responses] baseURL=${responsesBaseURL} model=${model}`);
  await agent.agent(
    [
      'Run the Responses sub-agent smoke test.',
      'Delegate the proof-building work to the configured sub-agent.',
      'Do not answer directly before the sub-agent result is available.',
    ].join('\n'),
  );

  assertDemo(
    observed.responsesProofCalls > 0,
    'Responses sub-agent should call build-subagent-proof.',
  );
  assertDemo(
    parentResultSnippets.some((text) =>
      text.includes('SUBAGENT_PROOF::responses::responses-smoke::10'),
    ),
    'Responses parent should receive the sub-agent proof through agent-result.',
  );
}

async function runChatSubAgentSmoke(apiKey: string, model: string): Promise<void> {
  // Chat 父代理走 coding/v3 endpoint，验证同一套子代理协议在 Chat 下可工作。
  const parentResultSnippets: string[] = [];
  const agent = new ChatParentAgent({
    llm: new OpenAIChatModel({
      apiKey,
      baseURL: chatBaseURL,
      model,
    }),
    subAgents: [ChatVerifierAgent],
    maxIterations: 6,
    systemPrompts: [
      [
        'You are testing sub-agent dispatch with Ark Coding Plan Chat.',
        'First call the agent tool with agentName "chat-subagent-verifier".',
        'Use input: "Call build-subagent-proof with label chat-smoke and numbers [4,6], then report the proof string."',
        'Use outputDescription: "A concise result containing SUBAGENT_PROOF::chat::chat-smoke::10".',
        'After the agent tool result is available, call end-agent alone.',
      ].join('\n'),
    ],
  });

  agent.onModelResponse((messages) => {
    console.log(`[chat] model: ${summarizeChat(messages)}`);
  });

  agent.onBeforeToolCall('agent', (_parameters, call) => {
    console.log(`[chat] before parent agent tool: ${call.arguments}`);
  });

  agent.onAfterToolCall(
    'agent',
    (_parameters, _call, result) => {
      const text = String(result);

      parentResultSnippets.push(text);
      console.log(`[chat] after parent agent tool: ${text.slice(0, 240)}`);
    },
    { await: true },
  );

  agent.onToolCallError((name, triggerType, error) => {
    console.log(`[chat] tool error: ${name}/${triggerType}/${toErrorMessage(error)}`);
  });

  agent.onAgentStatusChanged('ended', (_rawContext, context) => {
    console.log(`[chat] status ended: context=${context.length}`);
  });

  agent.init();

  console.log(`[chat] baseURL=${chatBaseURL} model=${model}`);
  await agent.agent(
    [
      'Run the Chat sub-agent smoke test.',
      'Delegate the proof-building work to the configured sub-agent.',
      'Do not answer directly before the sub-agent result is available.',
    ].join('\n'),
  );

  assertDemo(observed.chatProofCalls > 0, 'Chat sub-agent should call build-subagent-proof.');
  assertDemo(
    parentResultSnippets.some((text) => text.includes('SUBAGENT_PROOF::chat::chat-smoke::10')),
    'Chat parent should receive the sub-agent proof through agent-result.',
  );
}

function loadLocalEnv(): void {
  // 允许直接运行脚本时从 demo/.env 补齐 ARK_API_KEY。
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

function summarizeResponses(messages: readonly OpenAIResponsesContext[]): string {
  // Responses 摘要展示 item 类型和 function_call 名称。
  return messages
    .map((message) => {
      if (message.type === 'function_call') {
        return `function_call:${message.name}`;
      }

      if (message.type === 'message' && 'role' in message) {
        return `message:${message.role}`;
      }

      return message.type;
    })
    .join(', ');
}

function summarizeChat(messages: readonly OpenAIChatContext[]): string {
  // Chat 摘要展示 role 和 tool_calls 名称。
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

function assertDemo(condition: unknown, message: string): asserts condition {
  // smoke demo 使用同步断言让失败原因直接体现在终端。
  if (!condition) {
    throw new Error(`[ark subagent demo assertion failed] ${message}`);
  }
}

function toErrorMessage(error: unknown): string {
  // SDK 错误和普通异常统一转成短文本。
  return error instanceof Error ? error.message : String(error);
}

if (!apiKey) {
  console.error('Missing ARK_API_KEY. Put it in demo/.env or export it before running.');
  process.exitCode = 1;
} else {
  const model = process.env.ARK_SUBAGENT_MODEL ?? defaultModel;
  const failures: string[] = [];

  try {
    await runResponsesSubAgentSmoke(apiKey, model);
    console.log('[responses] subagent smoke passed');
  } catch (error) {
    const message = `[responses] subagent smoke failed: ${toErrorMessage(error)}`;

    failures.push(message);
    console.log(message);
  }

  try {
    await runChatSubAgentSmoke(apiKey, model);
    console.log('[chat] subagent smoke passed');
  } catch (error) {
    const message = `[chat] subagent smoke failed: ${toErrorMessage(error)}`;

    failures.push(message);
    console.log(message);
  }

  if (failures.length > 0) {
    console.log('ark subagent demo finished with failure(s)');
    process.exitCode = 1;
  } else {
    console.log('ark subagent demo complete');
  }
}
