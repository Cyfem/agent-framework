/**
 * 离线 Chat 示例：真实使用 Chat adapter 的 copy-on-write 改写能力，但不发起网络请求。
 *
 * 第一轮让模型产生超长 arguments，工具收到的仍是完整原文并返回超长文本；
 * 第二轮验证 active context 已按缺省限制压缩，而 raw history 仍逐字保留原值。
 */
import {
  Agent,
  DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS,
  OpenAIChatModel,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type OpenAIChatProtocol,
} from '@manee/agent-framework';
import { z } from 'zod';

const rawArguments = JSON.stringify({ payload: 'input-'.repeat(1_600) });
const rawToolResult = 'result-'.repeat(3_000);

class OfflineCompactChatModel extends OpenAIChatModel {
  #round = 0;

  constructor() {
    super({
      apiKey: 'offline-chat-key',
      model: 'offline-chat-model',
    });
  }

  override async generate(
    request: ModelGenerateRequest<OpenAIChatProtocol>,
  ): Promise<ModelGenerateResult<OpenAIChatProtocol>> {
    this.#round += 1;

    if (this.#round === 1) {
      return {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_long_payload',
                type: 'function',
                function: {
                  name: 'echo-long-payload',
                  arguments: rawArguments,
                },
              },
            ],
          },
        ],
      };
    }

    const compactedCall = this.parseToolCalls(request.context).find(
      (call) => call.id === 'call_long_payload',
    );
    const compactedResult = this.parseToolCallOutputMessages(request.context).find(
      ({ message }) => message.callId === 'call_long_payload',
    );

    assertDemo(compactedCall !== undefined, 'Expected the compacted Chat function call.');
    assertDemo(compactedResult !== undefined, 'Expected the compacted Chat tool result.');
    assertDemo(
      compactedCall.arguments.length <= DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolInput.targetChars,
      'Expected active tool input to respect the default target.',
    );
    assertDemo(
      compactedResult.message.output.length <=
        DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolResult.targetChars,
      'Expected active tool result to respect the default target.',
    );
    assertDemo(
      compactedCall.arguments !== rawArguments && compactedResult.message.output !== rawToolResult,
      'Expected only the active payloads to be replaced.',
    );

    return {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_end',
              type: 'function',
              function: { name: 'end-agent', arguments: '{}' },
            },
          ],
        },
      ],
    };
  }
}

const model = new OfflineCompactChatModel();
const agent = new Agent<OpenAIChatProtocol>({
  llm: model,
  // 对象存在而字段缺省：input/result 都启用框架内置压缩器。
  contextCompact: {},
});

agent.tools.push({
  name: 'echo-long-payload',
  description: 'Receive a long value and return a long offline result.',
  parameters: z.object({ payload: z.string() }),
  handler(parameters) {
    const { payload } = parameters as { payload: string };

    assertDemo(
      payload === JSON.parse(rawArguments).payload,
      'Tool execution must use the original arguments.',
    );
    return rawToolResult;
  },
});

agent.init();
await agent.agent('运行离线 Chat context compact 示例。');

const rawCall = model
  .parseToolCalls(agent.getHistory())
  .find((call) => call.id === 'call_long_payload');
const rawResult = model
  .parseToolCallOutputMessages(agent.getHistory())
  .find(({ message }) => message.callId === 'call_long_payload');

assertDemo(rawCall?.arguments === rawArguments, 'Raw history must retain the original arguments.');
assertDemo(
  rawResult?.message.output === rawToolResult,
  'Raw history must retain the original tool result.',
);

console.log('Chat compact demo passed:', {
  rawInputChars: rawArguments.length,
  activeInputChars:
    model.parseToolCalls(agent.getContext()).find((call) => call.id === 'call_long_payload')
      ?.arguments.length ?? 0,
  rawResultChars: rawToolResult.length,
  activeResultChars:
    model
      .parseToolCallOutputMessages(agent.getContext())
      .find(({ message }) => message.callId === 'call_long_payload')?.message.output.length ?? 0,
});

function assertDemo(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
