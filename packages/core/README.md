# @ruixutong.manee/maneeagent-framework

[![npm version](https://img.shields.io/npm/v/%40ruixutong.manee%2Fmaneeagent-framework?logo=npm)](https://www.npmjs.com/package/@ruixutong.manee/maneeagent-framework)
![Node.js >= 22](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)

面向 Node.js、以 TypeScript 为主要开发体验的 AI Agent 编排框架。它的核心目标是把 Agent 编排逻辑与模型协议解耦：`Agent<P>` 管任务循环、上下文、工具、事件和子代理；`Model<P>` 管协议消息、工具 wire structure、工具调用解析和实际模型请求。

## 安装

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
- Sub-agents：通过内置 `agent` 工具调度同协议子代理。

## 公开入口

| 运行时导出             | 用途                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `Agent`                | 协议无关的任务循环、上下文、工具和生命周期编排。            |
| `Tool`                 | 将类方法注册为 Agent 工具的标准装饰器。                     |
| `Model`                | 接入自定义消息协议时实现的抽象基类。                        |
| `OpenAIResponsesModel` | Responses API 与 OpenAI-compatible endpoint 适配器。        |
| `OpenAIChatModel`      | Chat Completions API 与 OpenAI-compatible endpoint 适配器。 |

包根入口还导出 Agent、Model、Responses 和 Chat 的配套 TypeScript 类型，不提供子路径入口或 CLI `bin`。

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

const context = await agent.agent('请保存一条笔记：今天完成 README。');
console.log(context);
```

`OPENAI_API_KEY` 和 `OPENAI_MODEL` 只是这个示例使用的环境变量名称，不是框架约定。`init()` 是显式配置校验入口：调用 `agent()` 或 `toolCall()` 前必须先调用它；如果之后修改了 `agent.tools` 或 `agent.subAgents`，需要再次调用。示例显式设置 `maxIterations`，避免模型没有按要求调用 `end-agent` 时持续请求。

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

每个 Agent 实例都会自动注册三个框架工具：`agent` 用于调度子代理，`skill` 用于渐进加载技能，`end-agent` 用于正常结束任务。即使当前没有子代理或 Skills，这些工具仍属于 Agent 的运行时工具集合；自定义工具不得与它们重名，`init()` 会统一校验工具名和子代理类名是否唯一。

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

`agent(input, options)` 与 `toolCall(call, options)` 可接收 `signal`、绝对 Unix 毫秒时间戳 `deadlineAt` 和只在宿主内部传播的 `runtime` identity。同一 run 的 Model、Tool、摘要、payload compactor、listener 和 model-error recovery 共用取消链路；取消/超时不会进入普通模型错误分类与 retry。声明两个参数的 Tool handler 会收到第二个 `ToolRuntimeContext`，其中包含当前 call、signal、deadline 和可选的 session/run/task identity；单参数 handler 保持原调用方式。自定义异步实现必须协作式监听 signal，框架不能强制终止任意第三方 Promise。

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

## Subagent v2 Core Runtime（C2–C5）

当前 workspace 版本为 `2.0.0`，包根已导出下列协议无关 contracts，供后续 Runtime 和独立 Executor 包实现：

- 严格 JSON-safe 边界、duplicate-aware parser、RFC 8785/JCS canonical JSON、UTF-8 尺寸与 SHA-256。
- `SubAgentDefinition`、Executor policy、显式 context projection、Artifact opaque reference 与固定 IO/projection/artifact limits。
- `SubAgentExecutor`、版本化 binding codec、availability probe、create/resume/reconnect operation 和隐藏 binding 的 host handle。
- task/result/error/approval/budget contracts，以及 exactly-once `ResultReceipt` / `CompletionReceipt`。
- `AgentRuntimeStateStore`、run/task 独立 revision、lease/fencing、稳定 provenance checkpoint、Chat/Responses codec 和 migrator SPI。
- `SubAgentChildRunner`、`ToolRuntimeContext`、`AgentRunOutcome`、安全 telemetry sink 与 `SubAgentRuntime` contract。
- `ContextStore.exportCheckpoint()` / `ContextStore.restoreCheckpoint()`：使用稳定 raw/span/entry ID 保存并恢复 raw history、active projection、rolling summary 和 open loop，不依赖进程内对象引用。
- 纯任务状态机：终态不可逆、首个合法 revision/fencing CAS 胜出、JCS result receipt、持久 completion receipt、严格 approval 过期边界、树级 budget 与安全事件序列。
- `commitRuntimeStateMutation()`：用声明式 plan 在同一 StateStore transaction 中提交 root run、child task 与事件；事务 callback 不向调用者开放，内部只等待 transaction-local Store 操作。
- `createStoredTaskIdempotently()`：在最终写入点执行 transaction-local 幂等 lookup/create，关闭并发 create 竞态。
- `SubAgentDefinitionRegistry` 与 `SubAgentExecutorRegistry`：区分 active/recovery-only definition，`init()` 冻结 `supports()`，仅 `refreshCatalog()` 更新 availability revision；allowlist、capability 与 availability 取保守交集。
- `createModelSubAgentToolDefinition()`：只在非空目录时生成模型工具，wire 精确为 `{ subAgent, executor, input }`，JSON schema 使用根 object 与 `oneOf`，空目录时返回 `null`。
- `createSubAgentRuntime()`：同步构造、异步 `init()`，支持无 fallback 的显式 placement、run-scope 幂等 create、树级 limits/budget、typed result、standalone completion、后台 handle、session guard、审批 open-loop resume、Host-only retry、取消、事件 cursor 与精确版本恢复。
- Executor control plane 使用 operation ID + payload hash 保存可重放 receipt；task execution epoch 持有固定 fencing token 的续租 lease，失租会中止本次执行。binding、child checkpoint、审批、进度、预算、事件和取消都在 durable CAS 边界内提交。
- 完整 child checkpoint 保存 runner identity、协议 context、稳定 provenance `ContextStore`、模型迭代、整批待处理 calls 和 compact transaction；runner checkpoint 在 resume、Executor binding 在 resume/reconnect 的真实恢复路径执行 copy-on-write 迁移，失败不会覆盖原记录。
- 内部 `AgentRunCheckpointController` 与 durable Tool batch planner 已实现根 run 长 lease、父 checkpoint + child task 原子 CAS、审批 open-loop 恢复、普通 Tool 串行 settle、同批 agent call 两阶段并发提交和 provider 顺序回填。这些是 C6 接入公开 `Agent` loop 的基础，不是一个单独的 npm API 入口。

`ModelSubAgentRequest` 的公开字段精确为 `{ subAgent, executor, input }`。task/session/binding/retry/approval 等 host metadata 不属于模型 wire。`ArtifactReference` 也只包含版本、opaque ID、media type、大小和 SHA-256，不含路径、URL 或凭据。

官方 [`@ruixutong.manee/maneeagent-executor-local`](../executor-local/README.md) 已提供本地 Executor、Memory StateStore 与单机 Atomic File StateStore。Core 仍未把上述 controller 接入公开 `Agent` loop，也尚未删除 `AgentOptions.subAgents`；这两件事必须在 C6 原子切换。在此之前，下方说明仍对应当前可运行的迁移前 Agent loop，不是 v2 兼容层承诺。

## 子代理（迁移前 Agent loop）

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

- 调用 `agent()` 或 `toolCall()` 前必须先执行 `init()`；修改 `tools` 或 `subAgents` 后需要重新执行。
- `agent(input)` 会先把输入构建为 user message，再进入循环。
- Agent 默认不设置迭代次数上限；真实模型场景建议通过 `maxIterations` 设置保护，达到上限时会抛错并进入 `failed`。
- 内置 `end-agent` 是唯一正常结束条件，模型应在单独一轮中调用；loop 会等它的结果、listener 和 compact 全部成功后再提交 `ended`。
- 成功响应但没有消息时会额外重试 3 次，即总计最多 4 次响应尝试。
- 未识别或没有匹配 handler 的模型异常默认额外重试 3 次；设置 `modelErrorRecovery: { unhandledRetryLimit: 0 }` 可恢复旧的立即抛错行为。
- 配置 summary 后，`context_length_exceeded` 默认由 `core.context_compaction` handler 最多实际执行 2 次；没有 summary 时按普通未知异常处理。
- 并发调用第二个 `agent()` 会抛出 `Agent is already running.`，但不会把正在运行的任务标记为失败。
- `stream=true` 当前不支持，会抛出错误。
- 父代理和子代理必须使用同一个 `AgentProtocol`；每次调度都会创建新的子代理实例和独立上下文。

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

before/after hook 或 classifier 抛错会立即终止并包装；handler 失败仍进入 after，允许 after 选择重试。发生过恢复活动后仍无法继续时会抛出 `ModelErrorRecoveryError`，其中保留 initial/terminal cause、最终 descriptor/reason、ledger、stage failures，以及最近 64 条 decision trace 和丢弃数量。若第一次失败没有发生重试、handler 或 hook 控制，则继续原样抛出 provider error。

`retry` / `continue` 属于 forced retry，没有框架硬上限。hook 如果持续返回它们，可能造成无限模型请求和费用；生产环境应结合 event ledger、外部取消信号、超时或自有预算明确终止。

离线参考实现见仓库中的 [Chat 工具 payload compact](../../demo/src/context-compact-chat.ts) 和 [Responses 摘要 compact](../../demo/src/context-compact-responses.ts)。

## 发布内容

包根目录只公开 `.` 入口：

- ESM `import` 使用 `dist/index.js`。
- CommonJS `require` 使用 `dist/index.cjs`。
- TypeScript 使用 `dist/index.d.ts`，并按需引用 `dist` 下的配套声明文件。

发布包包含完整 `dist` 目录和本 README，因此也会包含构建生成的 source map 与嵌套声明文件。声明文件保留中文 TSDoc，便于在 IDE 中查看 API 用法。
