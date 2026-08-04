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
- Skills：以索引化手册形式指导模型调用内置 `get-skill`。
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

每个 Agent 实例都会自动注册三个框架工具：`agent` 用于调度子代理，`get-skill` 用于读取技能手册，`end-agent` 用于正常结束任务。即使当前没有子代理或 Skills，这些工具仍属于 Agent 的运行时工具集合；自定义工具不得与它们重名，`init()` 会统一校验工具名和子代理类名是否唯一。

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

```ts
class MyModel extends Model<MyProtocol> {
  async generate(
    request: ModelGenerateRequest<MyProtocol>,
  ): Promise<ModelGenerateResult<MyProtocol>> {
    // 调用你的模型服务，并返回协议消息。
    return { messages: [] };
  }

  // 继续实现 buildUserMessage、buildSystemMessage、buildToolMessage、parser 等方法。
}
```

## 生命周期与错误处理

- 调用 `agent()` 或 `toolCall()` 前必须先执行 `init()`；修改 `tools` 或 `subAgents` 后需要重新执行。
- `agent(input)` 会先把输入构建为 user message，再进入循环。
- Agent 默认不设置迭代次数上限；真实模型场景建议通过 `maxIterations` 设置保护，达到上限时会抛错并进入 `failed`。
- 内置 `end-agent` 是唯一正常结束条件，而且必须在单独一轮工具调用中执行。
- 成功响应但没有消息时会重试 3 次；网络/API 异常不重试。
- 并发调用第二个 `agent()` 会抛出 `Agent is already running.`，但不会把正在运行的任务标记为失败。
- `stream=true` 当前不支持，会抛出错误。
- 父代理和子代理必须使用同一个 `AgentProtocol`；每次调度都会创建新的子代理实例和独立上下文。

## 包入口与发布内容

包根目录只公开 `.` 入口：

- ESM `import` 使用 `dist/index.js`。
- CommonJS `require` 使用 `dist/index.cjs`。
- TypeScript 使用 `dist/index.d.ts`，并按需引用 `dist` 下的配套声明文件。

发布包包含完整 `dist` 目录和本 README，因此也会包含构建生成的 source map 与嵌套声明文件。声明文件保留中文 TSDoc，便于在 IDE 中查看 API 用法。
