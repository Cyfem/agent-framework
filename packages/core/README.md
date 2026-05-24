# @manee/agent-framework

面向 Node.js 的 TypeScript Agent 编排框架。核心设计是协议解耦：`Agent<P>` 只负责任务循环、上下文、工具执行、事件和子代理调度；具体模型协议的消息构建、工具 wire structure、工具调用解析由 `Model<P>` 负责。

包内提供：

- `Agent<P>`：任务循环、系统提示词、技能手册、工具调用、事件、子代理和上下文管理。
- `Tool`：基于 2023-11 decorators 的工具声明。
- `Model<P>`：自定义模型协议 adapter 的抽象基类。
- `OpenAIResponsesModel`：OpenAI-compatible Responses adapter，并提供 Files 上传能力。
- `OpenAIChatModel`：OpenAI-compatible Chat Completions adapter。

## 安装

```bash
npm install @manee/agent-framework zod
```

要求：

- Node.js >= 22
- TypeScript 项目
- 使用 `@Tool(...)` 时，构建链需要支持 2023-11 decorators

API key 应通过环境变量注入，不要硬编码到源码或提交历史中。

## 快速开始：Responses

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
    description: '保存一条简短笔记。',
    parameters: z.object({
      note: z.string().min(1),
    }),
  })
  #saveNote(parameters: unknown): string {
    const { note } = parameters as { note: string };
    return `saved:${note}`;
  }
}

const model = new OpenAIResponsesModel({
  apiKey: process.env.ARK_API_KEY,
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seed-2-0-pro-260215',
});

const agent = new NotesAgent({
  llm: model,
  systemPrompts: ['你是一个会按需调用工具的助手。'],
});

agent.init();

const context = await agent.agent('保存一条笔记：今天完成 Agent 框架文档。');
console.log(context);
```

`init()` 是显式配置校验入口。调用 `agent()` 或 `toolCall()` 前必须先调用 `init()`；如果运行时修改了 `agent.tools` 或 `agent.subAgents`，需要再次调用 `init()`。

## Agent 与 Model 的分工

`Agent<P>` 只处理协议无关的编排工作：

- 将文本任务交给 `llm.buildUserMessage()`。
- 将内部结束约束、技能提示词和用户 system prompt 交给 `llm.buildSystemMessage()`。
- 将本地工具结果交给 `llm.buildToolCallOutputMessage()`。
- 将工具定义交给 `llm.buildToolMessage()`。
- 调用 `llm.generate()` 获取模型消息。
- 调用 `llm.parseToolCalls()` 提取需要执行的本地工具调用。

`Model<P>` 负责协议细节：

- builder：把 Agent 基础结构构建成目标 API 的消息和工具。
- parser：从混合 context 中筛选 user/system/assistant/tool-call/tool-result 等消息。
- generate：执行实际模型请求。

parser 会跳过不匹配的消息类型，并保留 `sourceMessage`；工具调用还会保留 `sourceCall`。协议类型是封闭定义，需要支持新字段时应先在对应 protocol 中显式声明。

## 工具

装饰器工具和运行时工具都只声明通用字段：`name`、`description`、`parameters`、`strict` 和 handler。Chat/Responses 的工具外层结构由 Model adapter 生成。

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

`strict` 是可选透传值：

- 不设置：请求工具中不包含 `strict` 字段。
- `true` 或 `false`：adapter 按原值传给模型 API。

工具 handler 可以返回字符串或对象；Agent 会把对象序列化为字符串形式的工具结果。参数解析失败、Zod 校验失败或工具本体异常都会被包装成工具结果交给模型继续处理，同时触发对应事件。

## 事件

```ts
agent.onModelResponse((messages) => {
  console.log('模型消息写入 context 前：', messages);
});

agent.onBeforeToolCall(
  'save-note',
  async (parameters, call) => {
    console.log(parameters, call.name);
  },
  { await: true, errorCancel: true },
);

agent.onAfterToolCall('save-note', (_parameters, _call, result) => {
  console.log('工具结果已写入 context：', result);
});

agent.onToolCallError((name, triggerType, error) => {
  console.log(name, triggerType, error);
});

agent.onAgentError((error) => {
  console.log(error.message);
});
```

事件要点：

- `onModelResponse` 在本轮模型消息写入 context 前触发一次。
- `before` listener 只有在 `{ await: true, errorCancel: true }` 同时设置时，异步异常才会取消真实工具调用。
- 工具结果会先写入 context，再触发 `after` listener，便于 listener 追加后续 user message。
- `after` 和 error observer 的异常只会上报或吞掉，不会打断 Agent 主循环。

## Skills 与子代理

`skills` 会进入框架内部 system prompt。模型应先调用内置 `get-skill` 获取完整手册，再按手册执行。

```ts
const billingSkill = {
  name: '账单回复流程',
  description: '处理客户账单疑问时使用。',
  systemContent: '回复需要说明事实、金额和下一步动作。',
  sops: [
    {
      description: '处理重复计费疑问',
      content: '1. 查询客户信息。\n2. 计算补偿。\n3. 生成回复草稿。',
    },
  ],
};
```

子代理必须与父代理使用同一协议规格：

```ts
class QualityReviewAgent extends Agent<OpenAIResponsesProtocol> {
  static description = '审查产物并汇报质量结论。';
}

const parent = new Agent<OpenAIResponsesProtocol>({
  llm: model,
  subAgents: [QualityReviewAgent],
});
```

内置 `agent` 工具会按子代理类名调度子代理。子代理通过运行时注入的 `agent-result` 工具向父代理汇报结果。

## 历史与上下文

`initContext` 表示当前有效上下文，`initRawContext` 表示完整历史。二者都会浅拷贝，系统提示词不会写入其中。

```ts
const initContext = [
  {
    role: 'user',
    content: [{ type: 'input_text', text: '上一轮请求。' }],
  },
] as const;

const restored = new Agent<OpenAIResponsesProtocol>({
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

`getContext()` 和 `getHistory()` 返回数组浅拷贝。需要手动追加协议消息时，可使用 `appendContext(message)`；该方法会同时写入 active context 和 raw history。

## Responses Files 与多模态

Responses 版本适合通过 Files 上传本地图片、截图或文档，再使用 `file_id` 构建多模态输入。

```ts
const file = await model.uploadFile('/absolute/path/window.png');

agent.appendContext(
  model.buildUserMessage({
    content: [
      { type: 'input_image', file_id: file.id, detail: 'high' },
      { type: 'text', text: '请判断这张截图中的窗口状态。' },
    ],
  }),
);
```

当前 Responses protocol 显式包含 OpenAI 标准的 `input_image`、`input_file`，以及方舟 `api/v3` 兼容 endpoint 声明的 `input_video`、`input_audio`、`partial`、图片 `xhigh` 和 `image_pixel_limit`。公共 `uploadFile()` 仅暴露标准 `purpose: "user_data"`。

## Chat 多模态

Chat 版本使用 Chat 原生 `messages` 和 function tools。图片输入可通过 `image_url`，例如 data URL：

```ts
const chatModel = new OpenAIChatModel({
  apiKey: process.env.ARK_API_KEY,
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seed-2-0-pro-260215',
});

const chatAgent = new Agent<OpenAIChatProtocol>({ llm: chatModel });

chatAgent.appendContext(
  chatModel.buildUserMessage({
    content: [
      { type: 'text', text: '读取这张截图。' },
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

Chat parser 会从一条 assistant message 的 `tool_calls[]` 中按原始顺序展开多个 function tool call；deprecated `function_call` 和 `function` role 不再属于本包的 Chat 协议。

## 生命周期

- `agent(string)` 会先构建 user message，再进入循环。
- Agent 只有在内置 `end-agent` 工具被调用后才进入 `ended`。
- 默认没有迭代次数上限；可通过 `maxIterations` 设置应用侧保护。
- 当前版本只支持非流式 `generate()`；`stream=true` 会抛错。
- 并发调用第二个 `agent()` 会抛出 `Agent is already running.`，但不会把正在运行的首个任务标记为失败。
