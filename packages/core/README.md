# @manee/agent-framework

面向 Node.js 的 TypeScript Agent 框架，模型层采用非流式 Responses API 协议。包内提供：

- `Agent`：任务循环、Responses 上下文、系统提示词、技能手册、工具调度、子代理与事件。
- `Tool`：支持 2023-11 decorators 的工具声明。
- `Model`：自定义模型适配器抽象基类。
- `OpenAIModel`：基于 OpenAI SDK 的 Responses 与 Files API 适配器，可连接方舟等兼容服务。

## 安装

```bash
npm install @manee/agent-framework zod
```

要求 Node.js >= 22。使用 `@Tool` 装饰器时，项目构建链需要支持 2023-11 decorators。

## 快速开始

```ts
import { Agent, OpenAIModel, Tool } from '@manee/agent-framework';
import { z } from 'zod';

class DemoAgent extends Agent {
  @Tool({
    name: 'save-note',
    description: '保存一条简短笔记。',
    parameters: z.object({ note: z.string().min(1) }),
  })
  #saveNote(parameters: unknown): string {
    return `saved:${(parameters as { note: string }).note}`;
  }
}

const agent = new DemoAgent({
  llm: new OpenAIModel({
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4.1-mini',
  }),
  systemPrompts: ['你是一个会按需调用工具的助手。'],
});

agent.init();
const context = await agent.agent('保存一条笔记，然后结束任务。');
console.log(context);
```

`init()` 是显式配置校验入口。调用 `agent()` 或 `toolCall()` 前必须执行 `init()`；向 `tools` 或 `subAgents` 动态追加内容后，也应重新调用一次 `init()`。

## 方舟 Responses 接入

```ts
import { Agent, OpenAIModel } from '@manee/agent-framework';

const model = new OpenAIModel({
  apiKey: process.env.ARK_API_KEY,
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seed-2-0-pro-260215',
});

const agent = new Agent({ llm: model });
agent.init();
await agent.agent('执行一次 Responses API smoke test。');
```

API key 应通过环境变量注入，不要硬编码到源码或提交历史中。

`OpenAIModel` 还提供 Files 上传入口，可将上传文件作为 Responses 多模态输入引用：

```ts
const image = await model.uploadFile('/absolute/path/window.png', {
  purpose: 'user_data',
});

agent.appendContext({
  role: 'user',
  content: [
    { type: 'input_image', file_id: image.id, detail: 'high' },
    { type: 'input_text', text: '请判断这张截图中的窗口状态。' },
  ],
});
```

图片使用 `input_image`，通用文件使用 `input_file`，视频和音频分别使用 `input_video`、`input_audio`。

## Responses 上下文

`Agent` 将模型返回的完整 `output` item 数组写入 context/history，并在下一轮 `input` 中原样回传。模型返回的 `id`、`status`、`summary` 以及提供方追加字段不会被框架投影或丢弃。框架自己创建的内容仅使用请求字段：

```ts
const initContext = [
  {
    role: 'user',
    content: [{ type: 'input_text', text: '上一轮请求。' }],
  },
  {
    type: 'message',
    role: 'assistant',
    id: 'msg_previous',
    status: 'completed',
    content: [{ type: 'output_text', text: '上一轮回答。' }],
  },
] as const;

const agent = new Agent({
  llm,
  initContext,
  initRawContext: [
    ...initContext,
    { role: 'user', content: [{ type: 'input_text', text: '额外原始历史。' }] },
  ],
});
```

`getContext()` 与 `getHistory()` 返回浅拷贝。框架内部 end-agent/skill 系统提示词仅在请求模型时临时前置，不写入这两个数组。

## 工具

工具参数使用 Zod object schema，框架会构建 Responses function tool：

```ts
class TicketAgent extends Agent {
  @Tool({
    name: 'create-ticket',
    description: '创建一个内存工单。',
    parameters: z.object({
      title: z.string().min(3),
      priority: z.enum(['low', 'medium', 'high']),
    }),
  })
  #createTicket(parameters: unknown): { id: string } {
    const { title } = parameters as { title: string };
    return { id: `ticket:${title}` };
  }
}
```

也可以在初始化前追加运行时工具：

```ts
agent.tools.push({
  name: 'runtime-state-report',
  description: '返回当前上下文长度。',
  handler: () => ({ contextMessages: agent.getContext().length }),
});
agent.init();
```

模型工具调用使用 Responses 的 `function_call`，工具结果由框架写为 `function_call_output`，通过同一个 `call_id` 关联。

## 技能与子代理

`skills` 会被整理成内部 system prompt；任务匹配技能描述时，模型可调用内置 `get-skill` 获取完整手册：

```ts
const agent = new Agent({
  llm,
  skills: [
    {
      name: 'ticket-playbook',
      description: '处理工单创建与总结。',
      sops: [{ description: '处理流程', content: '创建工单，然后总结。' }],
    },
  ],
});
```

子代理通过内置 `agent` 工具调度，类需要提供静态元信息：

```ts
class QualityReviewAgent extends Agent {
  static name = 'quality-reviewer';
  static description = '审查产物并汇报质量结论。';
}

const agent = new Agent({ llm, subAgents: [QualityReviewAgent] });
```

## 事件

```ts
agent.onModelResponse((output) => {
  console.log('output before append:', output);
});

agent.onBeforeToolCall(
  'create-ticket',
  async (parameters) => {
    console.log(parameters);
  },
  { await: true, errorCancel: true },
);

agent.onAfterToolCall('create-ticket', (_parameters, _call, result) => {
  console.log(result);
});

agent.onToolCallError((name, triggerType, error, parameters, call, result) => {
  console.log({ name, triggerType, error, parameters, call, result });
});
```

`onModelResponse` 每次模型响应触发一次，收到完整 `output` 数组，并且触发时该批 item 尚未写入 context。异步 `before` listener 若希望异常取消真实工具调用，必须同时设置 `{ await: true, errorCancel: true }`；`await: false` 的异步 rejection 只会上报 `onToolCallError`。`after` listener 的异常会被上报，但不会中断 Agent。

## 生命周期

- `agent(message)` 首先写入一条 `input_text` user input，随后循环请求模型并执行所有返回的 `function_call`。
- Agent 只有在内置 `end-agent` 工具被调用后才结束；该约束由框架的内部 system prompt 管理。
- 默认没有迭代次数上限；如需保护边界，可设置 `maxIterations`。
- 第一版仅支持非流式 Responses；`stream=true` 会抛错。
