# @manee/agent-framework

面向 Node.js 的 TypeScript AI Agent 编排框架。它的核心目标是把 Agent 编排逻辑与模型协议解耦：`Agent<P>` 管任务循环、上下文、工具、事件和子代理；`Model<P>` 管协议消息、工具 wire structure、工具调用解析和实际模型请求。

## 安装

```bash
npm install @manee/agent-framework zod
```

要求：

- Node.js >= 22
- TypeScript 项目
- 使用 `@Tool(...)` 时，构建链需要支持 2023-11 decorators
- API key 使用环境变量注入，不要硬编码到源码或提交历史中

## 能力概览

- `Agent<P>`：协议无关的任务循环、上下文、系统提示词、技能、工具、事件和子代理编排器。
- `Model<P>`：协议适配抽象，负责 builder、parser 和 `generate()`。
- `OpenAIResponsesModel`：OpenAI-compatible Responses API 适配器，附带 Files 上传能力。
- `OpenAIChatModel`：OpenAI-compatible Chat Completions API 适配器。
- `Tool`：基于 2023-11 decorators 的工具声明。
- Zod 参数校验：工具参数在本地执行前会先通过 schema 校验。
- 事件系统：可观察模型响应、工具调用、工具错误、Agent 状态和 Agent 错误。
- Context compact：active-only 工具 payload 压缩、外部摘要策略与 context-length 恢复，raw history 保留原文。
- Skills：以索引化手册形式指导模型调用内置 `get-skill`。
- Sub-agents：通过内置 `agent` 工具调度同协议子代理。

## 快速开始

```ts
import {
  Agent,
  OpenAIResponsesModel,
  Tool,
  type OpenAIResponsesProtocol,
} from '@manee/agent-framework';
import { z } from 'zod';

class NotesAgent extends Agent<OpenAIResponsesProtocol> {
  @Tool({
    name: 'save-note',
    description: '保存一条笔记。',
    parameters: z.object({
      text: z.string().min(1),
    }),
  })
  #saveNote(parameters: unknown): string {
    const { text } = parameters as { text: string };
    return `saved:${text}`;
  }
}

const model = new OpenAIResponsesModel({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4.1',
});

const agent = new NotesAgent({
  llm: model,
  systemPrompts: ['你是一个会按需调用工具的助手。'],
});

agent.init();

const context = await agent.agent('请保存一条笔记：今天完成 README。');
console.log(context);
```

`init()` 是显式配置校验入口。调用 `agent()` 或 `toolCall()` 前必须先调用它；如果之后修改了 `agent.tools` 或 `agent.subAgents`，需要再次调用 `init()`。

## Agent 与 Model

`Agent<P>` 不直接生成某个模型 API 的消息结构。它只使用协议无关的基础语义：

- 文本任务交给 `llm.buildUserMessage()`。
- 内部约束、技能提示和用户 system prompt 交给 `llm.buildSystemMessage()`。
- 本地工具结果交给 `llm.buildToolCallOutputMessage()`。
- 工具定义交给 `llm.buildToolMessage()`。
- 模型输出交给 `llm.parseToolCalls()` 提取本地工具调用。

`Model<P>` 是协议边界：

```ts
abstract class Model<P extends AgentProtocol> {
  abstract generate(request: ModelGenerateRequest<P>): Promise<ModelGenerateResult<P>>;
  abstract buildUserMessage(input: AgentBaseUserMessage | UserMessageOf<P>): ContextOf<P>;
  abstract buildSystemMessage(input: AgentBaseSystemMessage | SystemMessageOf<P>): ContextOf<P>;
  abstract buildToolCallOutputMessage(
    input: AgentBaseToolCallOutputMessage | ToolCallOutputMessageOf<P>,
  ): ContextOf<P>;
  abstract buildToolMessage(input: AgentToolDefinitionInput): ToolOf<P>;
  abstract parseToolCalls(context: readonly ContextOf<P>[]): readonly AgentToolCall<P>[];
}
```

完整抽象还包括 `parseUserMessages()`、`parseSystemMessages()`、`parseAssistantMessages()` 和 `parseToolCallOutputMessages()`。parser 接收混合 context，只返回匹配类型，并保留 `sourceMessage`；工具调用额外保留 `sourceCall`。

## 工具系统

### 装饰器工具

```ts
class BillingAgent extends Agent<OpenAIResponsesProtocol> {
  @Tool({
    name: 'lookup-invoice',
    description: '查询账单摘要。',
    parameters: z.object({
      invoiceId: z.string().min(1),
    }),
  })
  #lookupInvoice(parameters: unknown): Record<string, unknown> {
    const { invoiceId } = parameters as { invoiceId: string };

    return {
      invoiceId,
      amount: 128.5,
      status: 'paid',
    };
  }
}
```

`@Tool` 会做两件事：

- 把工具定义写入类级 metadata，使 `Agent.toolsDefinition` 可在不实例化时读取。
- 在实例初始化阶段把绑定后的 handler 加入 `agent.tools`，private method 也可以安全执行。

### 运行时工具

```ts
agent.tools.push({
  name: 'runtime-state-report',
  description: '返回当前上下文长度。',
  strict: false,
  parameters: z.object({}),
  handler: () => ({
    contextMessages: agent.getContext().length,
  }),
});

agent.init();
```

工具定义字段：

- `name`：工具名，同一个 Agent 实例中必须唯一。
- `description`：字符串或动态函数；动态函数会在每次构建模型请求时执行。
- `parameters`：Zod object schema；省略时使用空对象 schema。
- `strict`：可选透传值；不设置时请求工具中不包含该字段。
- `handler`：运行时工具函数，接收校验后的参数对象。

工具 handler 可以返回字符串、对象或 Promise。非字符串结果会被序列化为字符串工具结果。参数 JSON 解析失败、Zod 校验失败和工具本体异常不会直接终止 Agent，而是写成工具结果交给模型处理，并触发错误事件。

## 事件系统

```ts
const unsubscribe = agent.onModelResponse((messages) => {
  console.log('模型消息写入 context 前：', messages);
});

agent.onBeforeToolCall(
  'lookup-invoice',
  async (parameters, call) => {
    console.log(parameters, call.name);
  },
  { await: true, errorCancel: true },
);

agent.onAfterToolCall('lookup-invoice', (_parameters, _call, result) => {
  console.log('工具结果已写入 context：', result);
});

agent.onToolCallError((name, triggerType, error, parameters, call, result) => {
  console.log(name, triggerType, error, parameters, call, result);
});

agent.onAgentStatusChanged('ended', (_history, context) => {
  console.log(context.length);
});

agent.onAgentError((error) => {
  console.log(error.message);
});

unsubscribe();
```

事件语义：

- `onModelResponse`：模型消息写入 context 前触发。
- `onBeforeToolCall`：工具 handler 执行前触发。
- `onAfterToolCall`：工具结果已经写入 context 后触发。
- `onToolCallError`：`before`、`calling`、`after` 任一阶段发生错误时触发。
- `onAgentStatusChanged`：进入指定状态后触发。
- `onAgentError`：`agent()` 抛错时触发。

`before` listener 如果希望异步异常取消真实工具调用，必须同时设置 `{ await: true, errorCancel: true }`。`after` listener 异常只会上报，不会中断 Agent 主循环。

## 上下文与历史

Agent 维护两份上下文：

- `getContext()`：当前模型请求使用的 active context。
- `getHistory()`：完整 raw history。

二者返回的都是数组浅拷贝。系统提示词、内部结束约束和技能提示词只在请求模型时临时前置，不写入持久上下文。

```ts
const initContext = [
  {
    role: 'user',
    content: [{ type: 'input_text', text: '上一轮用户请求。' }],
  },
] as const;

const agent = new Agent<OpenAIResponsesProtocol>({
  llm: model,
  initContext,
  initRawContext: [
    ...initContext,
    {
      type: 'message',
      role: 'assistant',
      id: 'msg_previous',
      status: 'completed',
      content: [{ type: 'output_text', text: '上一轮回答。', annotations: [] }],
    },
  ],
});
```

需要手动插入协议消息时，可以使用 `appendContext()`：

```ts
agent.appendContext(
  model.buildUserMessage({
    content: [{ type: 'text', text: '补充一条用户上下文。' }],
  }),
);
```

## Context compact

Context compact 只改变下一次模型请求使用的 active context，不裁剪 append-only raw history：

- `getContext()` 返回 active context，可能含压缩后的工具 payload 或框架生成的摘要 memory。
- `getHistory()` 返回 raw history，始终保留模型原始 tool arguments、完整工具结果和正常对话消息。
- 摘要 prompt、摘要响应和 synthetic summary message 都不写入 raw history。

因此该能力用于控制 provider 请求上下文，并不解决进程内存、历史持久化或敏感信息留存；两种 getter 仍只返回数组浅拷贝，消息对象本身不会深拷贝。

### 缺省工具 payload 压缩

完全不传 `contextCompact` 时，工具压缩关闭，原有成功路径和 fire-and-forget listener 时序不变。只要传入 `contextCompact` 对象，未配置的 `toolInput` / `toolResult` 就启用内置策略：

```ts
const agent = new Agent<OpenAIResponsesProtocol>({
  llm: model,
  contextCompact: {},
});
```

缺省字符限制如下，单位都是 JavaScript `string.length` 的 UTF-16 code unit，不是 token：

| payload       | 仅当长度大于 | replacement 最长 |
| ------------- | ------------ | ---------------- |
| `tool_input`  | 8,192        | 4,096            |
| `tool_result` | 16,384       | 8,192            |

阈值相等时不压缩。可以通过运行时冻结的 `DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS` 读取缺省值，也可以逐类覆盖：

```ts
const agent = new Agent<OpenAIResponsesProtocol>({
  llm: model,
  contextCompact: {
    toolInput: {
      strategy: 'default',
      thresholdChars: 12_000,
      targetChars: 6_000,
    },
    toolResult: {
      strategy: 'default',
      thresholdChars: 24_000,
      targetChars: 10_000,
    },
  },
});
```

长度必须是安全整数，`targetChars >= 512` 且 `thresholdChars > targetChars`；非法配置在 `init()` 阶段失败。工具 handler、参数 JSON 解析和 schema 校验始终读取原始 arguments；只有本轮全部工具与 listener 完成后，框架才一次性 copy-on-write 改写 active entries。任一 callback、adapter、校验或 revision CAS 失败都会放弃整批 replacement，raw/active 保留本轮原值。

内置策略只对不超过 1,048,576 个 UTF-16 code units 的字符串尝试解析 JSON，并对过深容器、超大数组/对象和长字符串做有界结构裁剪。仍需进一步缩小时：

- tool input 使用合法 JSON envelope，`format` 为 `json`、`invalid-json` 或 `not-inspected`；
- 已确认合法 JSON 的 tool result 使用同类 JSON envelope；非法 JSON 或因过大而未探测的 result 使用带 `[context compacted: ...]` marker 的纯文本头尾预览；
- 所有结果严格不超过配置的 `targetChars`，头尾切分不会留下孤立 surrogate。

envelope 的稳定外形如下：

```json
{
  "__context_compact__": {
    "version": 1,
    "kind": "tool_input",
    "format": "json",
    "originalChars": 18000,
    "omittedChars": 14000,
    "head": "...",
    "tail": "..."
  }
}
```

这只是通用、有界的字符压缩：合法 JSON 只保证语法，不保证仍满足原工具 schema；它不理解业务语义，也不提供敏感信息脱敏。需要这些保证时应使用自定义 callback。

### 自定义或关闭工具压缩

```ts
const agent = new Agent<OpenAIResponsesProtocol>({
  llm: model,
  contextCompact: {
    toolInput: false,
    toolResult: async (original, info) => {
      if (info.call.name !== 'search-documents' || original.length < 2_000) {
        return undefined;
      }

      return JSON.stringify({
        compacted: true,
        callId: info.call.id,
        preview: original.slice(0, 1_500),
      });
    },
  },
});
```

callback 完全覆盖该类缺省策略，并按模型调用顺序对每条记录先 input 后 result 串行 `await`。它只得到冻结的 `id/name/arguments` 值快照和从 0 开始的 `iteration`，不会得到 provider message 或 ContextStore 引用。返回 `undefined` 或原文表示“不替换”，不会回退到内置策略；抛错、rejection 或返回非字符串会使本轮 compact 失败。`false` 则彻底关闭该类。

工具压缩启用时，`{ await: false }` 的 before/after listener 仍不会阻塞当前工具及后续工具，但框架会在 loop finalization、改写与关闭 span 前等待它 settle。永不 settle 的 listener 会永久挂起这一轮；应用必须自行设置超时或保证 promise 能结束。两类工具压缩都关闭时不会增加这次 finalization 等待。

公开的 standalone `agent.toolCall()` 不属于 Agent loop，因此不会自动 compact。父 Agent 创建动态子代理时也不会传播自己的 `contextCompact`、`modelErrorRecovery` 或恢复 hooks；需要时由子代理显式配置。

### 摘要策略

框架不内置业务摘要提示词、tokenizer、模型窗口表或触发规则。调用方通过 `trigger/select/prompt/validate` 定义语义，框架负责快照、模型调用、校验与 revision CAS：

```ts
const agent = new Agent<OpenAIResponsesProtocol>({
  llm: model,
  contextCompact: {
    // summary-only 必须显式关闭，否则对象字段缺省会启用两类工具压缩。
    toolInput: false,
    toolResult: false,
    summary: {
      trigger: ({ activeContext, previousSummary }) =>
        activeContext.length > 80 || (previousSummary?.text.length ?? 0) > 8_000,

      // select 可省略：主动摘要默认保留最近一个完整 span，压缩更早 boundary。
      select: ({ boundaryOriginalContext, boundaryActiveContext }) => ({
        contextToSummarize: boundaryOriginalContext.slice(0, -10),
        preservedContext: boundaryActiveContext.slice(-10),
      }),

      prompt: ({ selection, previousSummary }) =>
        [
          '把所选历史压缩成事实、决策、未完成事项和工具结论。',
          `本次消息数：${selection.contextToSummarize.length}`,
          previousSummary ? '请合并已有摘要，避免丢失仍有效的事实。' : '',
        ]
          .filter(Boolean)
          .join('\n'),

      validate: ({ summary }) =>
        summary.trim().length >= 40
          ? { ok: true }
          : { ok: false, reason: '摘要过短，不能原子提交。' },
    },
  },
});
```

每个 Agent iteration 只运行一次 proactive `trigger`；同一 iteration 内的模型异常重试和空响应重试不会重复触发。省略 `select` 时，主动模式压缩更早的 boundary original projection 并保留最近完整 span；context-length emergency 模式压缩整个 boundary 并默认不保留消息。滚动摘要时，`previousSummary` 会进入策略快照和下一次摘要请求。

摘要固定复用当前 Model，设置 `purpose: "context-summary"`、`tools: []`，并只发送框架 guard、已有摘要、所选原文和外部 `prompt`。它不会触发 `onModelResponse`。含工具调用、没有 assistant 文本、validator 拒绝或 revision 冲突时不提交半成品；成功后 active context 变为 synthetic user-role memory 加 preserved context，raw history 不变。摘要调用自身的 context-length 错误不会递归触发摘要 handler。

## 系统提示词与 Skills

用户 system prompt 可通过构造函数或 `addSystemPrompts()` 添加：

```ts
agent.addSystemPrompts('回复要简洁，必要时调用工具。');
```

Skills 是给模型读取的结构化手册。框架会在内部 system prompt 中列出技能索引；模型匹配到任务时，应调用内置 `get-skill` 获取完整手册。

```ts
agent.addSkill({
  name: '账单处理手册',
  description: '当用户询问账单、退款或抵扣时使用。',
  systemContent: '处理账单问题时必须先查事实，再给结论。',
  sops: [
    {
      description: '处理重复计费',
      content: '1. 查询账单。\n2. 核对重复项。\n3. 生成用户可读回复。',
    },
  ],
});
```

## 子代理

子代理必须与父代理使用同一个协议规格。父代理通过内置 `agent` 工具按子代理类名调度子代理，子代理通过运行时注入的 `agent-result` 工具汇报结果。

```ts
class ReviewAgent extends Agent<OpenAIResponsesProtocol> {
  static description = '审查文本质量并输出修改建议。';

  @Tool({
    name: 'score-writing',
    description: '给文本质量打分。',
    parameters: z.object({
      text: z.string().min(1),
    }),
  })
  #scoreWriting(parameters: unknown): Record<string, unknown> {
    const { text } = parameters as { text: string };
    return {
      length: text.length,
      score: 8,
    };
  }
}

const parent = new Agent<OpenAIResponsesProtocol>({
  llm: model,
  subAgents: [ReviewAgent],
});

parent.init();
```

## Responses API

`OpenAIResponsesModel` 使用 Responses API 的 `input` / `tools` / `output` 语义。模型返回的 output item 会作为协议 context 原样保存和回传；Agent 只识别 `function_call` 来执行本地工具。

```ts
const model = new OpenAIResponsesModel({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4.1',
  defaultParams: {
    temperature: 0.2,
  },
});
```

Responses 多模态适合使用 Files 上传：

```ts
const file = await model.uploadFile('/absolute/path/image.png');

agent.appendContext(
  model.buildUserMessage({
    content: [
      { type: 'input_image', file_id: file.id, detail: 'high' },
      { type: 'text', text: '请判断这张图片中的信息。' },
    ],
  }),
);
```

已声明的 Responses 内容块包括 `input_text`、`input_image`、`input_file`、`input_video` 和 `input_audio`。`uploadFile()` 默认使用 `purpose: "user_data"`。

## Chat Completions API

`OpenAIChatModel` 使用 Chat Completions 的 `messages` 和 function tools。Chat parser 会从 assistant message 的 `tool_calls[]` 中按原始顺序展开本地 function tool call。

```ts
import { Agent, OpenAIChatModel, type OpenAIChatProtocol } from '@manee/agent-framework';

const chatModel = new OpenAIChatModel({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4.1',
});

const chatAgent = new Agent<OpenAIChatProtocol>({
  llm: chatModel,
});

chatAgent.appendContext(
  chatModel.buildUserMessage({
    content: [
      { type: 'text', text: '请读取这张图片。' },
      {
        type: 'image_url',
        image_url: {
          url: imageDataUrl,
          detail: 'high',
        },
      },
    ],
  }),
);

chatAgent.init();
```

当前 Chat 协议只保留新版 `tool_calls[]` / `tool` role 工具闭环，不包含 deprecated `function_call` 或 `function` role。

## 自定义 Model

可以通过继承 `Model<P>` 接入任意协议。核心要求是：

- 定义一个 `AgentProtocol`，明确 context、tool、userMessage、systemMessage、assistantMessage、toolCallOutputMessage、rawToolCall、rawResponse。
- 实现 builder，把 Agent 基础结构转成协议结构。
- 实现 parser，从混合 context 中筛选目标消息，其他类型直接跳过。
- 实现 `generate()`，返回需要写入 context/history 的协议消息。
- 若要启用工具 payload compact，实现 `rewriteToolPayloads()` 的精确 copy-on-write 定位与批量改写。
- 若要识别 provider 的 context-length 错误，覆盖 `classifyError()`；需要不同摘要输出结构时覆盖 `extractAssistantText()`。

```ts
class MyModel extends Model<MyProtocol> {
  async generate(
    request: ModelGenerateRequest<MyProtocol>,
  ): Promise<ModelGenerateResult<MyProtocol>> {
    // 调用你的模型服务，并返回协议消息。
    return { messages: [] };
  }

  override rewriteToolPayloads(context, replacements) {
    // inputs 由 sourceMessage + sourceCall identity 唯一定位，results 由
    // sourceMessage + callId 唯一定位；每个 replacement 必须恰好命中一次。
    // 保持数组长度、顺序和全部未知 provider metadata，只 clone 被改写的项。
    return rewriteMyProtocolPayloads(context, replacements);
  }

  override classifyError(error, { purpose, request }) {
    const providerError = readMyProviderError(error);

    return {
      kind:
        providerError.code === 'context_window_exceeded' ? 'context_length_exceeded' : 'unknown',
      message: providerError.message,
      provider: 'my-provider',
      providerCode: providerError.code,
      status: providerError.status,
      requestId: providerError.requestId,
    };
  }

  // 继续实现 buildUserMessage、buildSystemMessage、buildToolMessage、parser 等方法。
}
```

这些新增方法都有非 abstract 缺省实现，旧自定义 Model 源码仍可编译。默认 `rewriteToolPayloads()` 对空 replacements 返回新的数组浅拷贝，实际需要非空改写时抛出明确 capability error；默认 `classifyError()` 归类为 `unknown`。内置 Chat/Responses adapter 已实现 identity 精确匹配、provider metadata 保真和 OpenAI-compatible 错误分类。

## 生命周期与错误处理

- `agent(input)` 会先把输入构建为 user message，再进入循环。
- Agent 默认不设置迭代次数上限；可通过 `maxIterations` 设置保护。
- 内置 `end-agent` 是唯一正常结束条件；loop 中会等 terminating result、listener 和 compact 全部成功后再提交 `ended`。
- 成功响应但没有消息时仍独立保持总计 4 次响应尝试。
- 未识别或没有匹配 handler 的模型异常默认额外重试 3 次；设置 `modelErrorRecovery: { unhandledRetryLimit: 0 }` 可恢复旧的立即抛错行为。
- 配置 summary 后，`context_length_exceeded` 默认由 `core.context_compaction` handler 最多实际执行 2 次；没有 summary 时按普通未知异常处理。
- 并发调用第二个 `agent()` 会抛出 `Agent is already running.`，但不会把正在运行的任务标记为失败。
- `stream=true` 当前不支持，会抛出错误。

恢复额度可在构造时覆盖：

```ts
const agent = new Agent<OpenAIResponsesProtocol>({
  llm: model,
  modelErrorRecovery: {
    unhandledRetryLimit: 1,
    contextLengthRecoveryLimit: 3,
  },
  contextCompact: {
    toolInput: false,
    toolResult: false,
    summary,
  },
});
```

`onBeforeModelErrorRecovery()` 与 `onAfterModelErrorRecovery()` 是按注册顺序串行 `await` 的控制 hooks；`undefined` 等价于 `default`，多个 listener 取最后一个非 `default` 决策。事件包含原始 `cause`、错误 `descriptor`、请求 `purpose`、失败 `request`、1-based `requestAttempt`、retry `ledger`、已解析 `limits`、匹配的 handler 和 context revision。

```ts
agent.onBeforeModelErrorRecovery((event) => {
  auditRecovery('before', event);

  if (event.descriptor.providerCode === 'account_disabled') {
    return 'stop';
  }

  return 'default';
});

agent.onAfterModelErrorRecovery((event) => {
  auditRecovery('after', event);

  if (event.handlerOutcome === 'failed' && canUseFallbackRegion()) {
    switchToFallbackRegion();
    return 'retry';
  }

  return 'default';
});
```

决策语义如下：

| 阶段   | 决策       | 行为                                                  |
| ------ | ---------- | ----------------------------------------------------- |
| before | `default`  | 按额度和匹配 handler 执行默认路径                     |
| before | `retry`    | 跳过 handler，进入 after，然后强制重试                |
| before | `continue` | 即使超过默认 handler 额度也执行 handler，再进入 after |
| before | `stop`     | 立即停止，不执行 handler 或 after                     |
| after  | `default`  | 接受 `proposedAction`                                 |
| after  | `retry`    | 无视默认额度，强制重试                                |
| after  | `stop`     | 立即停止                                              |

before/after hook 或 classifier 抛错会立即终止并包装；handler 失败仍进入 after，允许 after 选择重试。发生过恢复活动后仍无法继续时会抛出 `ModelErrorRecoveryError`，其中保留 initial/terminal cause、最终 descriptor/reason、ledger、stage failures，以及最近 64 条 decision trace 和丢弃数量。若第一次失败没有发生重试、handler 或 hook 控制，则继续原样抛出 provider error。

`retry` / `continue` 属于 forced retry，没有框架硬上限。hook 如果持续返回它们，可能造成无限模型请求和费用；生产环境应结合 event ledger、外部取消信号、超时或自有预算明确终止。

离线参考实现见仓库中的 [Chat 工具 payload compact](../../demo/src/context-compact-chat.ts) 和 [Responses 摘要 compact](../../demo/src/context-compact-responses.ts)。

## 发布内容

npm 包包含：

- `dist/index.js`
- `dist/index.cjs`
- `dist/index.d.ts`
- `README.md`

声明文件会保留中文 TSDoc，便于在 IDE 中查看 API 用法。
