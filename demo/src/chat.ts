/**
 * Chat 协议离线 demo：不请求真实模型，只复用 `OpenAIChatModel` 的 builder/parser。
 *
 * 这个示例覆盖新版 Chat 工具闭环：
 * assistant.tool_calls[] -> 本地工具 -> role="tool" 工具结果 -> 下一轮模型请求。
 */
import { z } from 'zod';

import {
  Agent,
  OpenAIChatModel,
  Tool,
  type AgentSkill,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type OpenAIChatProtocol,
  type OpenAIChatTool,
} from '@manee/agent-framework';

const billingSkill: AgentSkill = {
  name: '账单回复流程',
  description: '当用户需要处理客户账单疑问时，先查客户资料，再计算可用补偿，最后生成回复。',
  systemContent: '账单相关回复需要清楚说明事实、金额和下一步动作，语气保持克制友好。',
  sops: [
    {
      description: '处理客户账单疑问',
      content: [
        '1. 读取客户资料和最近账单摘要。',
        '2. 计算本次可提供的补偿或抵扣额度。',
        '3. 生成一段可以直接发送给客户的回复。',
      ].join('\n'),
    },
  ],
};

/** 使用私有装饰器工具模拟账单客服处理流程。 */
class ChatDemoAgent extends Agent<OpenAIChatProtocol> {
  @Tool({
    name: 'lookup-customer',
    description: 'Lookup a customer profile and recent billing facts.',
    parameters: z.object({
      customerId: z.string().min(1),
    }),
  })
  #lookupCustomer(parameters: unknown): Record<string, unknown> {
    // demo 固定返回一份客户资料，便于断言工具结果进入 Chat `tool` message。
    const { customerId } = parameters as { customerId: string };

    return {
      customerId,
      plan: 'Pro',
      tier: 'gold',
      lastInvoice: 128.5,
      issue: '客户反馈上月账单中有一次重复计费。',
    };
  }

  @Tool({
    name: 'compose-reply',
    description: 'Compose a short customer-facing billing reply.',
    strict: true,
    parameters: z.object({
      customerId: z.string().min(1),
      credit: z.number().nonnegative(),
      tone: z.enum(['warm', 'concise']),
    }),
  })
  #composeReply(parameters: unknown): string {
    // 最终回复生成工具用于验证 strict=true 工具声明和字符串工具结果。
    const { customerId, credit, tone } = parameters as {
      customerId: string;
      credit: number;
      tone: 'warm' | 'concise';
    };

    const prefix = tone === 'warm' ? '您好，感谢您的耐心等待。' : '您好。';

    return `${prefix}我们已核对客户 ${customerId} 的账单，确认可为本次疑问提供 ${credit.toFixed(
      2,
    )} 元抵扣，并会在下一张账单中体现。`;
  }
}

/** 确定性 Chat mock：复用真实 Chat adapter 的 builder/parser，只模拟模型输出。 */
class ChatMockModel extends OpenAIChatModel {
  readonly requests: ModelGenerateRequest<OpenAIChatProtocol>[] = [];
  #turn = 0;

  constructor() {
    super({
      apiKey: 'offline-chat-mock-key',
      model: 'offline-chat-mock-model',
    });
  }

  override async generate(
    request: ModelGenerateRequest<OpenAIChatProtocol>,
  ): Promise<ModelGenerateResult<OpenAIChatProtocol>> {
    // 每一轮返回固定 assistant message，覆盖单条消息内多个 tool_calls 的展开顺序。
    this.requests.push(request);
    this.#turn += 1;

    if (this.#turn === 1) {
      assertToolStrict(request.tools, 'get-skill', undefined);
      assertToolStrict(request.tools, 'calculate-credit', false);
      assertToolStrict(request.tools, 'compose-reply', true);

      return {
        messages: [
          {
            role: 'assistant',
            content: '我会先读取技能手册并查询客户账单资料。',
            tool_calls: [
              {
                id: 'call_skill',
                type: 'function',
                function: {
                  name: 'get-skill',
                  arguments: JSON.stringify({ index: 0 }),
                },
              },
              {
                id: 'call_lookup_customer',
                type: 'function',
                function: {
                  name: 'lookup-customer',
                  arguments: JSON.stringify({ customerId: 'C-10086' }),
                },
              },
            ],
          },
        ],
      };
    }

    if (this.#turn === 2) {
      return {
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: '资料已拿到，继续计算抵扣并生成回复。',
              },
            ],
            tool_calls: [
              {
                id: 'call_calculate_credit',
                type: 'function',
                function: {
                  name: 'calculate-credit',
                  arguments: JSON.stringify({ invoiceAmount: 128.5, rate: 0.2 }),
                },
              },
              {
                id: 'call_compose_reply',
                type: 'function',
                function: {
                  name: 'compose-reply',
                  arguments: JSON.stringify({
                    customerId: 'C-10086',
                    credit: 25.7,
                    tone: 'warm',
                  }),
                },
              },
            ],
          },
        ],
      };
    }

    return {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '已完成客户账单回复草稿，并确认工具结果已写入 Chat 上下文。',
            },
          ],
          tool_calls: [
            {
              id: 'call_end_agent',
              type: 'function',
              function: {
                name: 'end-agent',
                arguments: '{}',
              },
            },
          ],
        },
      ],
    };
  }
}

const model = new ChatMockModel();
const agent = new ChatDemoAgent({
  llm: model,
  skills: [billingSkill],
  maxIterations: 8,
  systemPrompts: ['你是一个离线 Chat 协议测试代理，请按工具结果完成账单回复草稿。'],
});

agent.tools.push({
  name: 'calculate-credit',
  description: 'Calculate a billing credit from invoice amount and rate.',
  strict: false,
  parameters: z.object({
    invoiceAmount: z.number().positive(),
    rate: z.number().min(0).max(1),
  }),
  handler(parameters) {
    // 运行时工具在 init 前追加，验证它和装饰器工具会被同一套配置校验处理。
    const { invoiceAmount, rate } = parameters as {
      invoiceAmount: number;
      rate: number;
    };

    return {
      invoiceAmount,
      rate,
      credit: Number((invoiceAmount * rate).toFixed(2)),
    };
  },
});

const observedToolCalls: string[] = [];
const observedToolResults: string[] = [];
let modelResponseCount = 0;

agent.onModelResponse((messages) => {
  modelResponseCount += 1;
  const calls = model.parseToolCalls(messages).map((call) => call.name);

  console.log(
    `model response ${modelResponseCount}: roles=${messages
      .map((message) => message.role)
      .join(',')} calls=${calls.join(',') || 'none'}`,
  );
});

for (const toolName of ['get-skill', 'lookup-customer', 'calculate-credit', 'compose-reply']) {
  agent.onBeforeToolCall(toolName, (_parameters, call) => {
    observedToolCalls.push(call.name);
    console.log(`before tool: ${call.name} ${call.arguments}`);
  });

  agent.onAfterToolCall(toolName, (_parameters, call, result) => {
    observedToolResults.push(call.id);
    console.log(`after tool: ${call.name} -> ${summarize(result)}`);
  });
}

agent.onAfterToolCall(
  'compose-reply',
  (_parameters, call) => {
    const toolResults = model.parseToolCallOutputMessages(agent.getContext());

    assertDemo(
      toolResults.some((item) => item.message.callId === call.id),
      'after hook should observe the compose-reply tool result in context',
    );
  },
  { await: true },
);

agent.onAgentStatusChanged('ended', (_history, context) => {
  console.log(`status ended: context=${context.length}`);
});

agent.init();
const finalContext = await agent.agent('请处理客户 C-10086 的账单疑问，并给出回复草稿。');

const parsedUsers = model.parseUserMessages(finalContext);
const parsedAssistants = model.parseAssistantMessages(finalContext);
const parsedToolCalls = model.parseToolCalls(finalContext);
const parsedToolOutputs = model.parseToolCallOutputMessages(finalContext);

assertDemo(parsedUsers.length === 1, 'chat parser should recover the initial user message');
assertDemo(parsedAssistants.length === 3, 'chat parser should recover assistant messages');
assertDemo(
  parsedToolCalls.map((call) => call.name).join(',') ===
    'get-skill,lookup-customer,calculate-credit,compose-reply,end-agent',
  'chat parser should expand tool_calls in protocol order',
);
assertDemo(
  parsedToolOutputs.length === 5,
  'chat tool result parser should recover all tool outputs',
);
assertDemo(
  observedToolCalls.join(',') === 'get-skill,lookup-customer,calculate-credit,compose-reply',
  'before hooks should observe business tool calls in order',
);
assertDemo(
  observedToolResults.join(',') ===
    'call_skill,call_lookup_customer,call_calculate_credit,call_compose_reply',
  'after hooks should observe business tool results in order',
);
assertDemo(model.requests.length === 3, 'chat model should be called for three turns');

console.log('chat demo complete');
console.log(
  JSON.stringify(
    {
      requests: model.requests.length,
      contextMessages: finalContext.length,
      toolCalls: parsedToolCalls.map((call) => call.name),
      toolOutputs: parsedToolOutputs.map((item) => item.message.callId),
    },
    null,
    2,
  ),
);

/** 断言指定工具的 `strict` 字段是否按用户声明原样透传。 */
function assertToolStrict(
  tools: readonly OpenAIChatTool[],
  name: string,
  expected: boolean | undefined,
): void {
  const tool = tools.find((candidate) => candidate.function.name === name);

  assertDemo(Boolean(tool), `expected chat tool ${name} to be present`);

  const hasStrict = Object.hasOwn(tool!.function, 'strict');

  if (expected === undefined) {
    assertDemo(!hasStrict, `expected chat tool ${name} to omit strict`);
    return;
  }

  assertDemo(tool!.function.strict === expected, `expected chat tool ${name} strict=${expected}`);
}

/** demo 内部使用的轻量断言，失败时直接中断脚本。 */
function assertDemo(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[chat demo assertion failed] ${message}`);
  }
}

/** 将工具结果压缩成适合终端显示的一行文本。 */
function summarize(result: unknown): string {
  if (typeof result === 'string') {
    return result.slice(0, 120);
  }

  try {
    return JSON.stringify(result).slice(0, 120);
  } catch {
    return String(result).slice(0, 120);
  }
}
