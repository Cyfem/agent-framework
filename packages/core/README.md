# @ruixutong.manee/maneeagent-framework

[![npm version](https://img.shields.io/npm/v/%40ruixutong.manee%2Fmaneeagent-framework?logo=npm)](https://www.npmjs.com/package/@ruixutong.manee/maneeagent-framework)
![Node.js >= 22](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)

面向 Node.js、以 TypeScript 为主要开发体验的 AI Agent 编排框架。它的核心目标是把 Agent 编排逻辑与模型协议解耦：`Agent<P>` 管任务循环、上下文、工具、事件和子代理；`Model<P>` 管协议消息、工具 wire structure、工具调用解析和实际模型请求。

## 安装

本 README 对应当前 checkout 中待发布的 `2.0.0` 源码。npm registry 上该包的 `latest` 目前仍是 `1.0.0`；以下安装命令与 v2 API 示例应在 `2.0.0` 发布后使用。在此之前请从仓库 workspace 构建和验收。

```bash
npm install @ruixutong.manee/maneeagent-framework zod
```

运行与兼容性：

- Node.js >= 22
- 同时提供 ESM、CommonJS 和 TypeScript 声明；TypeScript 是推荐体验，但不是运行时工具 API 的硬要求
- 使用 `@Tool(...)` 时，构建链需要支持 2023-11 decorators
- 核心库不读取固定环境变量；API key、`baseURL`、模型名或已配置的 OpenAI client 均通过 Model options 注入
- API key 应从环境变量或密钥服务读取，不要硬编码到源码或提交历史中

## 能力概览

- `Agent<P>`：协议无关的任务循环、上下文、系统提示词、技能、工具、事件和子代理编排器。
- `Model<P>`：协议适配抽象，负责 builder、parser 和 `generate()`。
- `OpenAIResponsesModel`：OpenAI-compatible Responses API 适配器，附带 Files 上传能力。
- `OpenAIChatModel`：OpenAI-compatible Chat Completions API 适配器。
- `Tool`：基于 2023-11 decorators 的工具声明。
- Zod 参数校验：工具参数在本地执行前会先通过 schema 校验。
- 事件系统：可观察模型响应、工具调用、工具错误、Agent 状态和 Agent 错误。
- Context compact：active-only 工具 payload 压缩、外部摘要策略与 context-length 恢复，raw history 保留原文。
- Skills：通过内置 `skill` 工具按名称渐进加载 instructions、文本资源和显式启用的脚本。
- Subagent v2：typed definition、显式 Executor placement、跨协议 child Agent、审批/嵌套审批、持久 resume、typed result、树级取消、官方 Local/Worker/Process placement，以及 C7 transport/RPC/control/Peer/recovery contract。

## 公开入口

| 根入口导出                                                                          | 用途                                                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `Agent` / `AgentRunOutcome`                                                         | 协议无关的任务循环与四类 durable run outcome。                              |
| `Tool` / `ToolRuntimeContext`                                                       | 装饰器/运行时 Tool，以及可信的 call、signal、deadline、run/task metadata。  |
| `Model` / `ModelGenerateUsage` / OpenAI adapters                                    | 自定义协议抽象、标准化 token usage 与两个 OpenAI-compatible adapter。       |
| `defineSubAgent` / `SubAgentDefinition` / `SubAgentRuntime`                         | typed definition、Catalog/Router、持久状态与控制面 Runtime。                |
| `SubAgentExecutor` / `ExecutorTaskHandle`                                           | placement adapter 与 Core 包装前的 Executor task SPI。                      |
| `SubAgentTransportEnvelope` / execution wire codec                                  | placement 共用的 closed JSON transport v1 与本地 deadline 重建。            |
| `SubAgentTransportRpcEnvelope` / RPC frame codec                                    | 14-kind strict request/reply/outcome/control/model 语义层。                 |
| `SubAgentTransportPeer` / `createSubAgentTransportPeerWriterAdmission()`            | 双向交换、同步写入准入、精确 replay 与带 settlement headroom 的 rollover。  |
| `SubAgentTransportArtifactSidecar`                                                  | closed descriptor 与校验后、独立于 JSON frame 的 artifact bytes。           |
| `createSubAgentTransportControlDispatcher` / `createRemoteSubAgentExecutionControl` | 16-method closed control 面、scope/receipt 校验与安全错误映射。             |
| `SubAgentTransportExecutorBridge` / `SubAgentTransportTargetBridge`                 | placement-neutral controller/target 调度桥、owner 分区与有界 receipt。      |
| `SubAgentTransportModelGatewayHandler` / `createSubAgentTransportModelProxy`        | controller-owned provider 调用、持久 provider ledger 与 child Model proxy。 |
| `SubAgentTargetRunnerRegistry` / `SubAgentTransportTaskHandleRegistry`              | 受信任 runner 重建与 session-bound、可回收的远程 handle façade。            |
| `SubAgentExecutorRecoveryRequired`                                                  | Executor crash settle marker；只由 Core 消费并按持久状态决定是否恢复。      |
| `AgentRuntimeStateStore` / `ArtifactStore`                                          | durable run/task state 与 opaque artifact 的 adapter SPI。                  |
| `SubAgentChildRunner` / `AgentProtocolCheckpointCodec`                              | 协议无关 child loop bridge 与版本化协议 checkpoint codec。                  |
| `AgentTelemetrySink` 及 Subagent state/result/approval contracts                    | Executor、StateStore、telemetry adapter 共用的稳定控制面契约。              |
| `createSubAgentRuntime`                                                             | 同步创建 session-bound Runtime；异步校验由 `runtime.init()` 完成。          |

包根入口同时导出 Agent、Model、Responses、Chat 与 Subagent v2 的配套 TypeScript 类型、常量和 adapter-facing state/control records。当前只公开 `.`，不提供子路径入口或 CLI `bin`。

## 快速开始

```ts
import {
  Agent,
  OpenAIResponsesModel,
  Tool,
  type OpenAIResponsesProtocol,
} from '@ruixutong.manee/maneeagent-framework';
import { z } from 'zod';

const apiKey = process.env.OPENAI_API_KEY;
const modelName = process.env.OPENAI_MODEL;

if (!apiKey || !modelName) {
  throw new Error('Missing OPENAI_API_KEY or OPENAI_MODEL.');
}

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
  apiKey,
  model: modelName,
  // OpenAI-compatible 服务可在这里额外传入 baseURL。
});

const agent = new NotesAgent({
  llm: model,
  maxIterations: 8,
  systemPrompts: ['按需调用工具；完成任务后单独调用 end-agent。'],
});

agent.init();

const outcome = await agent.agent('请保存一条笔记：今天完成 README。');

if (outcome.status === 'succeeded') {
  console.log(outcome.context);
} else {
  console.log(outcome.status, outcome.runId);
}
```

`OPENAI_API_KEY` 和 `OPENAI_MODEL` 只是这个示例使用的环境变量名称，不是框架约定。`init()` 是显式配置校验入口：调用 `agent()` 或 `toolCall()` 前必须先调用它；如果之后修改了 Tools、system prompts、Skills/`skillRuntime`、context compact 或模型错误恢复等运行语义配置，需要再次调用。示例显式设置 `maxIterations`，避免模型没有按要求调用 `end-agent` 时持续请求。

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

每个 Agent 实例都会注册 `skill` 和 `end-agent`；只有 ready Runtime 的有效 Catalog 非空时，才向模型加入 `agent` Tool。child Agent 还会由 Executor bridge 注入 typed `agent-result`。这些名称属于框架保留名，自定义工具不得冲突；`init()` 会统一校验。

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
- `onAgentError`：run 失败、取消或配置/调用错误被 Agent 观察到时触发；可恢复的 `failed` / `cancelled` run 通常同时以 outcome 返回。

`before` listener 如果希望异步异常取消真实工具调用，必须同时设置 `{ await: true, errorCancel: true }`。`after` listener 异常只会上报，不会中断 Agent 主循环。

`agent(input, options)` 与 `toolCall(call, options)` 可接收 `signal` 和绝对 Unix 毫秒时间戳 `deadlineAt`。同一 run 的 Model、Tool、摘要、payload compactor、listener 和 model-error recovery 共用取消链路；取消/超时不会进入普通模型错误分类与 retry。声明两个参数的 Tool handler 会收到第二个 `ToolRuntimeContext`，其中包含当前 call、signal、deadline 和由框架生成的可选 session/run/task identity；这些身份不来自模型输入。单参数 handler 保持原调用方式。自定义异步实现必须协作式监听 signal，框架不能强制终止任意第三方 Promise。

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

Skills 是给模型按需读取的结构化能力手册。框架首轮只在内部 system prompt 和动态工具描述中暴露冻结的 `name + description`；instructions、资源内容、脚本源码、本地路径和 executable 只有模型明确调用内置 `skill` 工具后才会进入相应流程。

Inline 结构体是跨运行时的规范配置：

```ts
const agent = new Agent({
  llm: model,
  skills: [
    {
      name: 'billing-review',
      description: 'Review invoices, refunds, credits, and duplicate charges.',
      instructions: [
        'Read references/policy.md before deciding.',
        'When validation is needed, run scripts/check.js with the invoice id.',
      ].join('\n'),
      references: {
        'policy.md': '# Billing policy\nVerify facts before proposing a credit.',
      },
      assets: {
        'reply-template.md': '# Reply\nFacts, decision, and next action.',
      },
      scripts: {
        check: {
          extension: '.js',
          content: 'console.log(JSON.stringify({ invoice: process.argv[2] }))',
          description: 'Validate one invoice id.',
        },
      },
    },
  ],
  skillRuntime: {
    // Skill result 默认不进入 tool-result payload compact。
    compactResult: false,
    scripts: {
      autoDetect: true,
    },
  },
});
```

内置工具输入固定为 `{ skill: string, args?: string }`，命令如下：

| 命令                             | 行为                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| 省略 `args`、空值或 `load [...]` | 返回 instructions 和当前 resource/script manifest          |
| `read <resource-id>`             | 读取已登记的 `references/...` 或 `assets/...` 文本         |
| `run <script-id> [argv...]`      | 用已解析 executor 运行已登记脚本；模型参数只作为 argv 传入 |

`load` 支持字面量 `$ARGUMENTS` 替换。DSL 只把 TAB、LF、CR 和普通空格作为分隔符；它没有 Shell 语义，不解释变量、glob、管道、重定向、命令替换或控制运算符。

### File Skill adapter

Node 文件能力可用时，也可以显式配置目录或其中的 `SKILL.md`：

```ts
const agent = new Agent({
  llm: model,
  skills: [{ source: 'file', path: '/absolute/path/to/billing-review' }],
  skillRuntime: {
    resourceExtensions: ['.md', '.txt', '.json'],
    scripts: false,
  },
});

agent.init();
console.log(agent.getSkillSourceDiagnostics());
```

该 adapter 明确实现 **Agent Skills portable text subset**，不承诺完整 Agent Skills 物理目录兼容：

- `SKILL.md` 接受 name、description、license、compatibility、metadata 和 Markdown body；`allowed-tools` 不产生授权行为。
- `references/`、`assets/` 只发现声明扩展名的 UTF-8 文本。缺省扩展名为 `.md/.txt/.json/.yaml/.yml/.csv/.xml`，自定义数组整体替换；非法 UTF-8 在 lazy read 时返回工具调用错误。
- 候选路径拒绝空 segment、`.`/`..`、反斜杠、ASCII control/DEL、`<>:"|?*`、NUL、末尾空格/点、Windows 保留 basename，以及 NFC/大小写 alias 和 file/directory prefix collision。因此 POSIX 合法的 `query?.md`、`a:b.md` 也不属于本 subset。
- unsupported resource 和无后缀 script 在候选校验前忽略；三类 well-known 根必须缺失或为真实普通目录，树内 symlink 和特殊文件忽略且不跟随。
- 非 Node、缺少 `process.getBuiltinModule()`、文件 capability 不可用或初始化读取被权限拒绝时，file source 会被忽略；框架不读取或回显 capability 缺失 source 的 path。`getSkillSourceDiagnostics()` 只返回 0-based `sourceIndex + reason`，不写 console。

Inline load/read 不依赖 Node 文件或进程能力。file run 需要 file + process capability；inline run 还需要临时文件 capability。脚本默认关闭，`scripts: {}` 也不会自动启用 executor；`autoDetect` 默认 `false`，也可以用 `executors` 手工覆盖或用 `false` 删除某一后缀。

脚本固定通过 `shell: false` 启动，stdin 关闭，但它仍是宿主显式信任的本地代码：框架不提供沙箱、默认 timeout、输出上限、网络隔离或环境变量清理。子进程继承宿主环境；Deno 自动检测只配置裸 `deno run`，所需 read/env/network 权限必须由手工 executor 明确添加。Windows 自动检测不会把 `.cmd/.bat` shim 当作可由 `shell: false` 直接执行的程序。

Inline script 每次运行都会在独立临时目录物化完整 Skill（`SKILL.md`、references、assets 和 scripts），以 Skill root 为 cwd，并在结束后 best-effort 清理。file script 直接执行重新校验后的登记文件，不复制或修改原目录。

`addSkill()` 只修改 configured sources。非运行状态下会立即使 Agent 回到未初始化；运行中添加只标记 dirty，当前 run 继续使用旧 snapshot。两种情况都必须在下一次运行前重新 `init()`，新 Skill 才会生效。父 Agent 的 Skill 和 runtime 配置不会自动传播给动态子代理。

## Subagent v2

当前 checkout 的 `2.0.0` 源码已把 durable Runtime 接入公开 `Agent` loop，并删除迁移前的 `subAgents` 类数组和旧 model wire。Subagent 由三层组成：

1. `SubAgentDefinition` 声明稳定 name/version、Zod input/output、Executor policy、context projection 和可选 delegation allowlist。
2. `SubAgentRuntime` 绑定 owner session、definitions、Executors、StateStore、limits 与 telemetry，并生成当前可用 Catalog。
3. 具体 Executor 在受信任 registry 中解析 definition version，创建一个全新的 child Agent；Core 不从模型输入动态加载类或模块。

官方本地实现位于 [`@ruixutong.manee/maneeagent-executor-local`](../executor-local/README.md)，真实 `worker_threads` placement 位于 [`@ruixutong.manee/maneeagent-executor-worker`](../executor-worker/README.md)，真实 Node.js 子进程 placement 位于 [`@ruixutong.manee/maneeagent-executor-process`](../executor-process/README.md)。三者当前都是 workspace 中的待发布 `2.0.0`，尚未出现在 npm registry；下面的安装命令只安装本示例使用的 Local 包。示例故意让 Responses 父 Agent 调度 Chat child，说明协议不是继承关系。

```bash
npm install @ruixutong.manee/maneeagent-framework @ruixutong.manee/maneeagent-executor-local zod
```

```ts
import {
  Agent,
  createSubAgentRuntime,
  defineSubAgent,
  type Model,
  type OpenAIChatProtocol,
  type OpenAIResponsesProtocol,
} from '@ruixutong.manee/maneeagent-framework';
import {
  createLocalAgentRunnerRegistration,
  LocalSubAgentRunnerRegistry,
  MemoryAgentRuntimeStateStore,
  MemorySubAgentExecutor,
} from '@ruixutong.manee/maneeagent-executor-local';
import { z } from 'zod';

declare const parentModel: Model<OpenAIResponsesProtocol>;
declare const reviewerModel: Model<OpenAIChatProtocol>;

const reviewer = defineSubAgent({
  name: 'reviewer',
  version: '2.0.0',
  description: '审查一段文本并返回 typed findings。',
  inputSchema: z.object({ text: z.string().min(1) }).strict(),
  outputSchema: z
    .object({ verdict: z.enum(['pass', 'revise']), findings: z.array(z.string()) })
    .strict(),
});

const registry = new LocalSubAgentRunnerRegistry([
  createLocalAgentRunnerRegistration({
    definition: reviewer,
    runnerId: 'reviewer-chat-agent',
    runnerVersion: '2.0.0',
    createAgent: () =>
      new Agent<OpenAIChatProtocol>({
        llm: reviewerModel,
        maxIterations: 8,
        systemPrompts: ['先调用 agent-result 提交 typed result，再单独调用 end-agent。'],
      }),
    buildInput: ({ input }) => `请审查：${input.text}`,
  }),
]);

const stateStore = new MemoryAgentRuntimeStateStore();
const runtime = createSubAgentRuntime({
  sessionId: 'session-42',
  activeDefinitions: [reviewer],
  executors: [new MemorySubAgentExecutor({ name: 'local', registry })],
  stateStore,
});

await runtime.init();

const parent = new Agent<OpenAIResponsesProtocol>({
  llm: parentModel,
  sessionId: 'session-42',
  subAgentRuntime: runtime,
  maxIterations: 8,
}).init();

const outcome = await parent.agent('请调用 reviewer 审查这段文本。');
```

`createSubAgentRuntime()` 是同步构造；`await runtime.init()` 才会校验 Catalog、Executor `supports()`、binding/checkpoint codec 和 migrator。同步 `Agent.init()` 只接受 ready Runtime，并要求 `Agent.sessionId === runtime.sessionId`。`refreshCatalog()` 显式更新 availability revision；已初始化 Agent 会在下一次模型请求边界按新 revision 重建模型可见 schema，不会在一次 provider response 的处理中途换表，也不会静默 fallback 到另一个 Executor。

### 模型如何选择 Subagent 与 Executor

模型只看到 `{ subAgent, executor, input }`。Core 将有效 definition、definition allowlist、Executor capability、`supports()` 和 availability 做保守交集，并用根 object + `oneOf` 生成动态 schema：

```json
{
  "subAgent": "reviewer",
  "executor": "local",
  "input": { "text": "..." }
}
```

taskId、session、binding、recoveryData、retryOf、权限和审批数据不会进入模型 wire。Catalog 为空时，`agent` Tool 完全不出现。模型显式选择不支持的组合会确定失败，不会降级或重路由。

父批次先把普通 Tool 串行 settle 并持久化，再并发提交同批 `agent` calls；child 完成顺序可以不同，但结果始终按 provider call 顺序回填。`end-agent` 必须单独成批。child 使用独立 Agent/context，通过 typed `agent-result` 提交 output schema 候选，再单独调用 `end-agent`；result receipt、completion receipt 和 terminal CAS 都是 authoritative，Executor 的 raw return 不能覆盖持久结果。

### 生命周期与审批恢复

`agent()` 和 `resumeRun()` 返回四类 outcome：

- `succeeded`：包含 `sessionId`、`runId` 和 active `context`。
- `waiting_approval`：包含 `checkpointRevision` 和一个或多个 leaf `approvals`；handler 尚未执行。
- `cancelled` / `failed`：包含稳定 error descriptor 与当前 active `context`。

配置、未初始化、错误 session、并发调用、无效 resume 和 `stream: true` 等编程/能力错误仍会抛异常。导致 run 无法继续的 Model/runtime error 会触发 `onAgentError`，并由 `agent()` / `resumeRun()` 返回 `failed` outcome，而不是把 provider/runtime error 直接抛给调用方；单个 Tool call 的错误仍按工具事件与工具结果语义处理。一个实例有待审批 run 时不能启动新 run；可在原实例或使用相同 session、Runtime 与 durable configuration identity 的新实例上提交 decisions：

```ts
if (outcome.status === 'waiting_approval') {
  const resumed = await parent.resumeRun({
    runId: outcome.runId,
    decisions: outcome.approvals.map((approval) => ({
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: 'approved' as const,
    })),
  });
  console.log(resumed.status);
}
```

Child Tool 的 approval summary 来自受信任工具配置，不能拼接模型参数。Core 在 handler 前保存完整 call checkpoint；只有原子提交的 `approved` decision 才会执行 handler。`now < expiresAt` 才有效，边界及之后原子过期。嵌套 Subagent 通过 definition 的 `delegation` allowlist 获得 task-scoped Catalog；多个 leaf approvals 会和父 checkpoint 原子关联，允许分批 decision，并沿原 task identity 恢复：

```ts
const coordinator = defineSubAgent({
  name: 'coordinator',
  version: '2.0.0',
  description: 'Delegate selected checks.',
  inputSchema: z.object({ request: z.string() }).strict(),
  outputSchema: z.object({ result: z.string() }).strict(),
  delegation: { mode: 'allowlist', definitions: ['reviewer'] },
});
```

父 Agent 的 Model、Tools、Skills、system prompts、context compact、错误恢复与上下文不会隐式传播。每个 Executor factory 必须显式构造 child 并映射 definition input；context 共享只能通过受限制的 `contextProjector` 输出 text/data/artifact 项。根 run 会持久化 `maxIterations`、初始化后的 configuration hash 和 `runtime.limits`；恢复时三者必须与当前 Agent/Runtime 精确匹配。hash 覆盖协议 codec、system prompts、Tools、Skills/`skillRuntime`、compact 与 recovery 语义，但不固定 provider client 或模型部署名称，替换后者的兼容性由宿主负责。

### Runtime 程序化入口与恢复边界

宿主也可直接使用 `runtime.execute()` / `spawn()`，以及 session-guarded handle 的 `wait()`、`cancel()`、`snapshot()`、`events()`。对父 checkpoint 已关联的 task，`runtime.recover()` 是首选 reconcile 入口：它会按 authoritative state 复用 terminal、等待 resident execution、应用审批、采用 lease 已过期的 checkpoint，或转交 external reconnect，绝不创建替代 task。`resume()` 是显式审批/checkpoint 控制，`reconnect()` 只适用于声明 external binding 的 Executor。Host retry 通过新的 `execute({ retryOf })` 创建新 task，只允许引用同 definition version 的非成功终态；原 task 不会被重开。

`runtime.stageTool()` 是供公开 `Agent` loop 使用的 host-only 原子关联 SPI，不属于模型 wire。它先生成稳定 task identity 与可选 create mutation；父 pending call 与新 child task 在同一 StateStore transaction 成功后，Agent 才调用 staged `dispatch()`。崩溃发生在提交前时 task 不可见，发生在提交后/dispatch 前时恢复进程沿原 run/task/call/request identity 补 dispatch，不会另建 task。

Core 使用 RFC 8785/JCS hash、run/task 独立 revision、lease/fencing、operation receipt 和不可逆 terminal state。公开 `StateLease.fencingToken` 契约固定为 canonical unsigned base-10 字符串：只接受 `0` 或不带前导零的正十进制整数；Core 在 acquire、renew、恢复和 transport 边界都会重验，比较时按任意精度整数语义处理。`StateLease.expiresAt` 属于 StateStore 自己的 logical clock domain，不得与无关进程的 `Date.now()` 直接比较；执行 owner 会从每次 acquire/renew 请求开始，以宿主单调时钟维护保守的本地 TTL proof，续租在 proof 边界仍未确认时立即失去写终态资格。lease acquire 本身也受调用方 signal/deadline 约束；若不可取消的 Store acquire 在调用已经结束后才成功，Core 会 best-effort 释放该迟到 lease，避免把 key 无故占用到 TTL 结束。完整 checkpoint 包含 Chat/Responses 协议 context、稳定 provenance ContextStore、模型迭代、待处理整批 calls 和 compact transaction；summary 与 tool-payload compact 的 prepared、in-flight、result-ready 崩溃窗口都可恢复。caller 取消 root run 时，root 与所有非终态 descendants 会先在同一 fenced StateStore transaction 中原子进入 `cancelled`，提交成功后才 best-effort 通知具体 Executor 清理 placement；task CAS 竞争会整批回滚、重载并重算，未确认的 adapter cleanup 可以用相同 `operationId` 幂等重放。durable provider operation 在 SDK dispatch 前取消会得到 `cancelled`；intent 已持久化为 `in_flight` 后发生 abort、超时或连接结果不确定时，原 task/run 进入 `failed + outcomeUnknown`，即使取消同时到达也不会覆盖该状态，更不会自动重发真实请求。明确收到的 HTTP 4xx/5xx provider rejection 则可清除 in-flight intent，并进入配置的 model-error recovery。

### Executor transport 与 crash settle

Core 根入口导出 transport v1 的 closed envelope、frame codec、sequence tracker 和 `SubAgentExecutionRequestWire`。默认单帧上限是 16 MiB，按实际 UTF-8 bytes 计；frame 和 payload 使用 RFC 8785/JCS，sequence 按 channel/方向从 1 连续推进，同 `messageId` 只有在 payload 与 routing identity 都一致时才是 replay。tracker 默认最多保留 4096 个连续 sequence；窗口耗尽时返回 `sequence-window-exhausted`，调用方必须创建新 channel，不能淘汰旧 receipt 后继续接受可能重复的 ID。错版本、额外字段、sequence gap、未知旧 sequence、同 ID 冲突、非 JSON-safe 或超限值会在调用 Executor/Core callback 前失败。

`createSubAgentExecutionRequestWire()` 显式复制协议字段，不会把 `AbortSignal`、宿主绝对时间或意外 closure 跨边界传输；wire 只携带 `remainingMs`。接收端的 `reconstructSubAgentExecutionRequest()` 返回 `{ request, dispose }`：`request` 把 transport cancel signal 与本地 timeout signal 合并，并以接收端时钟重建绝对 deadline；超过 Node 单个 timer 上限 `2^31-1 ms` 的合法长 deadline 会被拆成连续 timer，不会溢出、缩短或退化成近即时超时。adapter 必须在 execute/spawn/wait 处理 settle 后（包括失败或取消）调用幂等的 `dispose()`，释放接收端 timer 与 listener；不能只取出 `request` 后遗忘生命周期。decoder 会递归冻结返回值，默认限制 canonical payload 为 16 MiB、JSON 深度为 128、展开节点为 1,000,000，并重验 binding、checkpoint hash/状态/provenance、projection 和 parent path；目标侧仍必须通过受信任 registry 精确解析 definition/runner 及 codec。schema、factory、模块路径和 credential 不是 execution wire 的一部分。

strict RPC 语义层固定为 14 个 kind：`executor.request/accepted/settled`、`control.request/reply`、`cancel.request/ack`、`snapshot.request/reply`、`events.request/page`、`model.request/reply` 与 `protocol.error`。codec 对 request/reply routing、execute/spawn/wait mode、binding、snapshot、outcome、event page、Model operation scope 和 safe error 做 closed-union 重验；routing 与嵌套 identifier 都拒绝 C0/DEL，且 `maxCanonicalBytes` 不能大于 `maxFrameBytes`。raw error、stack、provider body、binding metadata 与 `eventCursor` 不能进入跨边界错误。`control.request` 与 `model.request/reply` 都绑定精确的 execution attempt、epoch 和 fencing token；旧 runner 在新 execution 生效后不能调用新 dispatcher 或触发 provider 费用。

`SubAgentTargetRunnerRegistry` 在 seal 后发布不可变的 definition/runner/checkpoint compatibility snapshot，并在 factory 调用前重新校验完整 execution request、schema、binding 与 checkpoint。transport-ready registration 必须声明 `{ gatewayId, protocol, codecVersion }`；该身份会写入持久 `SubAgentExecutorBinding`，resume 时必须精确一致，因此 target 重启后不能在不改变 binding 的情况下静默切换 Model gateway。Gateway ID 应由宿主按实际 provider/model 配置做版本化。`SubAgentTransportExecutorBridge` 把可信 Core control 和 controller Model 留在宿主侧；`SubAgentTransportTargetBridge` 只在 target 侧重建受信任 runner。Target bridge 的 `ownerSessionId` 来自经认证 channel，而不是 wire，自始至终按 owner + task + operation 分区；跨 session 查询统一返回 `RESOURCE_NOT_FOUND`。placement adapter 可通过异步 `validateBinding({ request, binding })` 在 runner factory 或 resident runner 被使用前校验 opaque recovery data 与受信 bootstrap 身份，例如要求 Worker binding 的 logical job ID 与本次 MessagePort bootstrap 完全一致；该 hook 不替代 Core 对 closed binding、definition、runner、Model binding 和 checkpoint 的通用校验。同一 task 的初始化有独立 single-flight fence，即使 operation ID 不同也不会重复调用 runner factory。通用 bridge 默认最多各保留 10,000 个 task 与 operation receipt，容量耗尽时稳定 fail closed，不会淘汰幂等证据后重跑；`dispose()` 会取消并等待 live runner、清理 listener/timer/receipt，且之后不可复用。它只允许 settled resident 的只读 reconnect；live external reconnect 需要具体 HTTP adapter 提供 durable rebind SPI，当前通用 bridge 返回 `RECOVERY_UNSUPPORTED`。

远程 child 不能持有 controller 的 provider client 或 API key。`createSubAgentTransportModelProxy()` 只接受 Core 审计并冻结的官方 `createOpenAIChatProtocolSurface()` / `createOpenAIResponsesProtocolSurface()`；这两个 surface 只含 protocol builder/parser/codec，不含 `generate()`。surface 与 proxy 当前必须来自同一个 Core module instance；ESM/CJS 双包在同一进程交叉混用会因审计品牌隔离而 fail closed。未经品牌化的 structural custom surface 和 provider-capable Model 都会在 exchange 前被拒绝；自定义远程协议 surface 目前不受支持。Controller gateway 只接受显式声明 `providerMaxRetries === 0` 的 Model；内置 Chat/Responses 同时在每次 OpenAI SDK request option 强制 `maxRetries: 0`。自定义 Model 的声明属于受信任宿主契约，其实现仍必须确保一次 `generate()` 不在内部重试。框架级 model-error recovery 每次 retry 都是新的、受预算控制的 provider operation，不等同于 SDK 内部重试。

Controller Model gateway 的顺序固定为 checkpoint ACK → durable request admission → tree budget reservation → provider `prepared/in_flight` → SDK。相同 canonical operation 的本地重入和跨 Handler 并发只预留一次 budget、调用一次 SDK；冲突 hash 在 budget 前失败。live duplicate 只观察 authoritative terminal，不能自行把仍在运行的调用改成 unknown。host 证明旧 owner 已退出后，可显式接管遗留的 request admission，并以相同幂等 budget identity 继续；host 证明 provider owner 已退出后，才可把遗留 `in_flight` 固定为 `outcome_unknown`。Store I/O、观察等待、checkpoint、预算和 SDK 都受 controller signal/deadline 约束；持久 observer 使用有上限的指数退避。`MemoryProviderOperationLedgerStore` 的 `operationCapacity` / `requestAdmissionCapacity` 默认各为 10,000，容量耗尽时 fail closed，并可通过冻结的 `diagnostics()` 观察；正式 durable adapter 必须提供等价的 retention/归档策略。

Gateway ledger 只保存 closed normalized result，不保存 API key、raw request、provider body、SDK error 或旧 execution wire reply。Provider 已完成但 reply 丢失时，新 channel 和推进后的 attempt/epoch/fencing 会以同一 provider operation ID 读取 completed result、按当前授权 scope 重新封装，Chat 与 Responses 都不会重复 SDK 调用；child checkpoint 同时保存精确 `requestAttempt`，因此 attempt 2 及之后的回复丢失也会以原 provider hash 重放。真正遗留的 `in_flight` 则在显式 recovery 后 fail closed，禁止自动重发。确定收到的 provider HTTP rejection 会作为白名单 safe classification 完成并可重放，让 child 的 context-length recovery 继续工作；网络、abort 或无法证明结果的错误才是 `outcomeUnknown`。成功响应的 `inputTokens/outputTokens/totalTokens` 会经过 closed non-negative-safe-integer 校验后写入 normalized reply；child 用稳定 usage operation ID 幂等结算 token budget，root 在提交 `result_ready` 时原子结算。Controller 的可信 signal 和绝对 deadline 对 target 的 `remainingMs` 取更早边界；target 不能扩张截止时间，host cancel/release 会只中止对应 execution 的 provider 请求。

control 面固定为 16 个 method：execution 7 个、completion 3 个、delegation 3 个、task 3 个。`createSubAgentTransportControlDispatcher()` 在调用可信 Core control closure 前重验 task/session scope、operation identity、binding、checkpoint、approval/result/completion receipt、budget、event 和 child handle；`createRemoteSubAgentExecutionControl()` 只向远端 runner 暴露对应的 typed proxy，并把受信任本地 catalog 与 delegation snapshot 取保守交集，不从远端加载 definition、schema 或权限。两端会在构造时复制并冻结同一组 JSON boundary options，后续修改调用方对象不能放宽限制。Controller bridge 会把 request 与可信 control 的 signal 取组合取消、deadline 取较早值；任一 signal 取消或任一 deadline 到期都会中止同一 outbound exchange 和 target child，wire 不能扩张宿主授权窗口。当前 proxy 暂不暴露 `artifacts.put`：sidecar 只能搬运已有 `ArtifactReference` 对应的 bytes，远程 artifact 写入要等独立 reserve/stage 语义落地。

`SubAgentTransportTaskHandleRegistry` 按 `ownerSessionId + parentTaskId + childTaskId` 保存 controller 侧 raw child handle capability，raw handle 不进入 wire 或持久状态。`task.wait` 返回 terminal outcome、`task.snapshot` 返回 terminal state，或 `task.cancel` 返回 terminal snapshot 后，registry 会在当前 operation、resolver 与 event subscriber 全部退出后延迟驱逐；后续新 channel 如仍需读取该 task，必须由 authoritative Runtime resolver 按完整 scope 惰性重建，并在缓存 raw handle 前用 authoritative snapshot 证明 owner、parent 与 child identity 全部一致。失败或越权的惰性 lookup 会在 operation 退出时驱逐，不会因枚举未知 task ID 积累 entry。父 execution terminal 时，controller bridge 会调用 `forgetParentScope()` 清理同 scope 下包括从未 `task.wait` 的 nested handle；`waiting_approval` / paused outcome 不触发父 scope 清理，因此 approval resume 仍可继续使用原 handle capability，直到 child 或 parent 真正进入 terminal。

`SubAgentTransportPeer` 在同一 channel 上提供双向 request/reply、每方向连续 sequence、correlation/task/operation 校验和精确 replay cache。writer 必须同步返回 `createSubAgentTransportPeerWriterAdmission()` 生成的准入 receipt；同步 throw、Promise、void 或非法 receipt 会让 `openRequest()`/`request()`/`reply()` 在返回前失败并关闭 channel。可选 `settled` 只报告稍后的 I/O 完成，Peer 不等待它来串行下一次准入，因此反向 control 不会被 Promise mutex 锁死。准备请求期间发生 abort/timeout 时不会调用 writer、提交 sequence 或留下 tombstone；已准入请求的迟到 reply 才通过 tombstone 完成协议校验。tombstone 有固定上限，耗尽后 channel 进入 drain/fail-close，不会因永远缺失的迟到 reply 无界增长。大于 `2^31-1 ms` 的 timeout 会分段调度，不会被 Node 压缩成近即时超时。

spawn 只接受 `executor.accepted` 后同一 exchange 的 `executor.settled(mode: 'spawn')`，或在尚未绑定时直接返回 `unbound_create` recovery settlement；accepted 之后不能再伪装成 unbound create。Peer 会把 accepted binding、terminal/paused task identity 和已知 executor 与原 execution request 交叉校验；events page 必须遵守请求的 cursor/limit，`nextSequence` 精确等于最后返回事件或空页的原 cursor，不能跳过事件。入站 replay 按解码后的 canonical envelope 判断，sidecar 按 `sidecarId` 无序比较；语义相同的 replay 复用缓存 reply 而不重复运行 handler，sequence gap、同 ID 冲突、错 reply 或超限会 fail closed。sequence 默认预留 256 个 settlement headroom（最多为 window - 1）；soft drain 后只允许所有 reply/replay 以及 active executor task 的 control/cancel/snapshot/events continuation，达到 hard bound 则关闭 channel。`maxTrackedSequences` 最大为 1,000,000，pending、cache 或 sequence window 到达边界时必须 drain/rollover，不能淘汰 receipt 后继续复用。

artifact sidecar 使用 closed v1 descriptor；Peer 默认单件上限 32 MiB、每个 packet 最多 8 件且合计 128 MiB。`maxSidecarItemBytes` 独立限制单件，既有 `maxSidecarBytes` 始终表示 packet 合计，不能用放宽合计上限的方式绕过单件边界；默认 replay cache 为 160 MiB，足以容纳一个默认最大 frame 与默认最大 sidecar packet 后再 fail closed。descriptor 会把已有 `ArtifactReference` 的 size/SHA-256 与独立 `byteLength`/`sha256` 交叉校验；入站 `Uint8Array`/`ArrayBuffer` 会拒绝 Proxy，通过原生 internal-slot getter 固定长度并复制到普通 `Uint8Array`，不调用可覆写的 getter、iterator、`slice()` 或 `Symbol.species`，再校验实际长度和明文 SHA-256。因此源 buffer 后续变更不能修改已验收 bytes，数据也不会以 base64 塞进 JSON frame 或在校验前交给 handler。Core transport/RPC/control/Peer/sidecar、target registry、controller/target bridge 与 Model gateway 已公开；官方 Worker 与 Process 包已经分别使用这套地基完成真实线程和真实子进程 placement，但 HTTP 尚未交付，Phase 2 仍未通过。

官方 Worker Executor 每个 live task 使用一个静态受信 target、一个 `worker_threads.Worker` 和一个 `MessageChannel`。启动 manifest 在任何 execution RPC 前做 closed decode、canonical digest 和完整内容匹配；Worker 只收到闭合 job/session/channel bootstrap，默认 `env: {}`、`argv: []`、`execArgv: []`，stdout/stderr 有界消费且不回显。binding 仅保存 opaque logical job ID，resume 使用完整 checkpoint，`reconnect=none`；`model_result_ready` 回复丢失时在仍有效 scope 内最多进行一次精确 checkpoint replay，不新建 provider operation。它不是文件系统、网络或不受信代码沙箱，也不改变根 Agent/run/session 的 controller 归属；完整用法与安全边界见 [Worker Executor README](../executor-worker/README.md)。

官方 Process Executor 每个 live task 使用一个静态受信 target、一个由当前 `process.execPath` 启动的 Node.js 子进程和 advanced-serialization IPC。controller 在 `spawn` 成功后发送闭合 bootstrap，双方使用有界 FIFO，并以 send callback 而不是 `send()` 的 backpressure 布尔值判定 I/O settle；IPC `sendHandle` 被拒绝，frame/sidecar 在复制前执行数量和字节上限检查。子进程只收到最小启动环境，stdout/stderr 有界丢弃；cancel 先走协议，再在最多五秒的窗口内强制终止直属 child，并以 `close` 而非 `exit` 或 `child.killed` 作为 stdio/IPC 已释放的证据。Process 同样只执行受信 target，不是文件系统、网络或进程树沙箱；完整用法、恢复窗口与安全边界见 [Process Executor README](../executor-process/README.md)。

Executor 的 `execute()`、`spawn()` 或 raw handle `wait()` 可以返回 `SubAgentExecutorRecoveryRequired`。该 marker 不是 task state、host handle outcome 或 Agent outcome；Core 会校验 live operation identity、attempt/epoch/fencing、binding、checkpoint、runner/codec compatibility 和持久 result/provider 状态。合法 marker 会先原子 settle 当前 operation、释放 active slot，再至多自动恢复一次：`unbound_create` 保持原 `operationId` 与 idempotency key，只推进 attempt/epoch/fencing；`checkpoint` 使用原 task/binding 和完整 checkpoint，不伪装成 reconnect。第二个 marker 保留 `running + recoveryRequired`，等待 host 显式 `recover()`。provider 已 `in_flight` 时固定为 `failed + outcomeUnknown`，result receipt 已提交时固定为带 `partialOutput` 的 `failed`，authoritative terminal 永远只读。

`runtime.limits` 是初始化后可读的冻结 resolved snapshot，默认 `maxDepth=3`、`maxDescendants=32`、`maxConcurrent=4`、`maxTurns=16`、`timeoutMs=120000`；`maxProviderCalls`、input/output token 与 cost 上限默认不启用。该 snapshot 会持久化到 root run 并由所有 descendant task 继承，恢复时不允许漂移。`maxProviderCalls` 使用同一树级持久 ledger：root 普通请求、`context-summary` 与 child 请求都在 SDK dispatch 前按 operation ID 原子、幂等地预留一次；达到上限时不调用 provider。

Chat/Responses 内置版本化 codec。自定义协议没有 codec 时只能使用宿主实现、Catalog 明确声明 `same_process` 的内存 placement：原 Agent 实例可以保留进程内 identity 并恢复根审批，终态后会释放这些 identity；替换 Agent、跨进程恢复，以及无 codec child 自身产生的 durable 审批仍不支持。Agent 会在每个模型请求边界以及创建 child task 前重新校验当前 effective Catalog；刷新后只要出现 `checkpoint` resume 或 `external_binding` reconnect，就会以 `RECOVERY_UNSUPPORTED` 阻止下一次 provider dispatch 或 task stage。官方 `MemorySubAgentExecutor` 声明的是 `checkpoint` recovery，需要可重建 registry 和持久 StateStore，并不提供这条无 codec `same_process` 路径；它也不支持 external reconnect。远程 placement 只是 child execution location，不转移根 Agent、run、会话或对话所有权，也不实现 handoff。

`ArtifactReference` 只包含版本、opaque ID、media type、大小和 SHA-256，不含路径、URL 或凭据。默认 input/output 各 256 KiB，projection 最多 32 项、单项 64 KiB、合计 128 KiB；默认单 artifact 32 MiB、每 task 8 件/128 MiB。StateStore transaction 内只允许等待 Store 操作，禁止调用 Model、Tool、Executor 或外部网络。

## Responses API

内置 Chat 与 Responses adapter 在每次 OpenAI SDK 请求上固定 `maxRetries: 0`，避免一次框架 provider operation 被 SDK 隐式扩成多次 HTTP attempt；需要重试时由 Agent 的显式 recovery 和预算控制。两者会把 provider usage 规范化为 `ModelGenerateResult.usage` 的 `inputTokens/outputTokens/totalTokens`。注入自定义 SDK client 不会放宽零重试 request option。

`OpenAIResponsesModel` 使用 Responses API 的 `input` / `tools` / `output` 语义。模型返回的 output item 会作为协议 context 原样保存和回传；Agent 只识别 `function_call` 来执行本地工具。下面沿用快速开始中已经校验的 `apiKey` 和 `modelName`。

```ts
const model = new OpenAIResponsesModel({
  apiKey,
  model: modelName,
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
import {
  Agent,
  OpenAIChatModel,
  type OpenAIChatProtocol,
} from '@ruixutong.manee/maneeagent-framework';

// 由应用提供，例如 data:image/png;base64,...
declare const imageDataUrl: string;

const chatModel = new OpenAIChatModel({
  apiKey,
  model: modelName,
});

const chatAgent = new Agent<OpenAIChatProtocol>({
  llm: chatModel,
  maxIterations: 8,
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
- 如能读取 provider token 统计，在 `ModelGenerateResult.usage` 返回非负安全整数；框架会在进入 durable budget 前做 closed runtime 校验。
- 若要启用工具 payload compact，实现 `rewriteToolPayloads()` 的精确 copy-on-write 定位与批量改写。
- 若要识别 provider 的 context-length 错误，覆盖 `classifyError()`；需要不同摘要输出结构时覆盖 `extractAssistantText()`。

```ts
class MyModel extends Model<MyProtocol> {
  // 只有确实保证一次 generate 不做内部 provider retry 时才能这样声明；
  // controller Model gateway 会拒绝 undefined 或非零值。
  override readonly providerMaxRetries = 0;

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

这些新增方法都有非 abstract 缺省实现，旧自定义 Model 源码仍可编译。`providerMaxRetries` 默认是 `undefined`，普通本地 Agent 仍可使用；只有注册到 controller Model gateway 时才必须显式为 `0`。默认 `rewriteToolPayloads()` 对空 replacements 返回新的数组浅拷贝，实际需要非空改写时抛出明确 capability error；默认 `classifyError()` 归类为 `unknown`。内置 Chat/Responses adapter 已实现 identity 精确匹配、provider metadata 保真和 OpenAI-compatible 错误分类。

## 生命周期与错误处理

- 调用 `agent()` 或 `toolCall()` 前必须先执行 `init()`；修改 Tools、system prompts、Skills/`skillRuntime`、context compact 或模型错误恢复等运行语义配置后需要重新执行。配置了 `subAgentRuntime` 时，必须先 `await runtime.init()`。
- `agent(input)` 会先把输入构建为 user message，再进入循环，并返回 `AgentRunOutcome`，而不是直接返回 context。
- Agent 默认不设置迭代次数上限；真实模型场景建议通过 `maxIterations` 设置保护，达到上限时 run 返回 `failed` outcome。
- 内置 `end-agent` 是唯一正常结束条件，模型应在单独一轮中调用；loop 会等它的结果、listener 和 compact 全部成功后再提交 `ended`。
- 成功响应但没有消息时会额外重试 3 次，即总计最多 4 次响应尝试。
- 未识别或没有匹配 handler 的模型异常默认额外重试 3 次；设置 `modelErrorRecovery: { unhandledRetryLimit: 0 }` 可恢复旧的立即抛错行为。
- 配置 summary 后，`context_length_exceeded` 默认由 `core.context_compaction` handler 最多实际执行 2 次；没有 summary 时按普通未知异常处理。
- 并发调用第二个 `agent()` 会抛出 `Agent is already running.`，但不会把正在运行的任务标记为失败。
- `agent(input, { stream: true })` 当前不支持，会在创建 run/task 前抛出 `STREAMING_UNSUPPORTED`。
- 父子 Agent 可以使用不同 `AgentProtocol`；每次新执行或 checkpoint 重建都由 Executor factory 提供独立 child 实例和显式配置。
- 同一实例存在 `waiting_approval` run 时，必须先用对应 `runId` 调用 `resumeRun()`，不能启动另一个 run。
- root execution lease 被 takeover 时，旧 owner 返回带 `RECOVERY_TARGET_LOST` 的 `failed` outcome，但不会取消 descendants 或写 terminal；新 owner 依据持久 checkpoint 决定继续、apply 或以 `outcomeUnknown` 安全失败。

### 模型错误恢复

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

before/after hook 或 classifier 抛错会让恢复引擎立即终止并包装；handler 失败仍进入 after，允许 after 选择重试。发生过恢复活动后仍无法继续时，引擎把包含 initial/terminal cause、最终 descriptor/reason、ledger、stage failures，以及最近 64 条 decision trace 的 `ModelErrorRecoveryError` 交回 Agent loop；若第一次失败没有发生恢复活动，则交回原 provider error。公开 `agent()` / `resumeRun()` 会通过 `onAgentError` 暴露该错误并返回 `failed` outcome，不会把这两类运行期错误直接抛给调用方。

`retry` / `continue` 属于 forced retry，恢复策略本身没有独立硬上限。配置 `SubAgentRuntime.limits.maxProviderCalls` 时，共享树级 ledger 仍会在 SDK dispatch 前阻断超额请求；未配置时，hook 持续返回 forced retry 可能造成无限模型请求和费用，生产环境应结合 event ledger、外部取消信号、超时或自有预算明确终止。

离线参考实现见仓库中的 [Chat 工具 payload compact](../../demo/src/context-compact-chat.ts) 和 [Responses 摘要 compact](../../demo/src/context-compact-responses.ts)。

## 发布内容

当前 checkout 只生成待发布的 `2.0.0` 包内容；`npm pack --dry-run` 验证文件与入口，不等同于执行 `npm publish`。

包根目录只公开 `.` 入口：

- ESM `import` 使用 `dist/index.js`。
- CommonJS `require` 使用 `dist/index.cjs`。
- TypeScript 使用 `dist/index.d.ts`，并按需引用 `dist` 下的配套声明文件。

发布包包含完整 `dist` 目录和本 README，因此也会包含构建生成的 source map 与嵌套声明文件。声明构建会把内部相对 module specifier 固化为 NodeNext 可解析的 `.js` 或 `/index.js` 路径；仓库的 `pnpm validate:subagent:v2:pack` 只允许根 manifest/README/license 与 `dist` 中的 ESM/CJS、声明、source map，并先执行敏感产物、源码泄漏、缺 map、child 超时/输出超限等负例。真实临时 tarball 解包后，门禁以正式包名执行 ESM `import()` / CommonJS `require()` runtime smoke，并同时编译 `type: module` ESM 与 `.cts` CommonJS 消费者。两种类型消费者都使用 `module/moduleResolution: NodeNext`、`strict: true`、`skipLibCheck: false`、关键公开 contract/字段非 `any` 断言和 missing-export 负检；包名、Node.js 要求、根 exports 和无 `bin` 也会被锁定。声明文件保留中文 TSDoc，便于在 IDE 中查看 API 用法。
