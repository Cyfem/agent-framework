# @manee/agent-framework

`@manee/agent-framework` 是一个运行在 Node.js 端的 TypeScript AI Agent 编排框架。它把“Agent 如何循环、保存上下文、执行工具、触发事件、调度子代理”与“某个模型 API 的消息格式如何构建和解析”拆开，让同一套 Agent 逻辑可以接入不同协议。

这个仓库是框架源码仓库；发布到 npm 的包文档位于 [packages/core/README.md](./packages/core/README.md)。

## 核心特性

- **协议解耦**：`Agent<P>` 只负责编排，`Model<P>` 负责消息构建、工具声明构建、工具调用解析和模型请求。
- **双协议适配**：内置 `OpenAIResponsesModel` 与 `OpenAIChatModel`，覆盖 Responses API 与 Chat Completions API。
- **工具调用**：支持 `@Tool` 装饰器工具和运行时 `agent.tools.push()` 工具，参数校验使用 Zod。
- **事件系统**：支持模型响应、工具调用前后、工具错误、Agent 状态和 Agent 错误事件。
- **技能手册**：通过 `skills` 暴露可索引的操作手册，模型可调用内置 `get-skill` 获取完整内容。
- **子代理调度**：通过内置 `agent` 工具调度同协议子代理，并使用 `agent-result` 汇报结果。
- **多模态上下文**：Responses 支持 Files 上传后通过 `input_image.file_id` 等内容块注入；Chat 支持 `image_url` 等内容块。
- **发布友好**：公开 API 带中文 TSDoc，构建后的 `.d.ts` 会保留说明。

## 安装

```bash
npm install @manee/agent-framework zod
```

要求：

- Node.js >= 22
- TypeScript 项目
- 使用 `@Tool` 时，构建链需要支持 2023-11 decorators

## 最小示例

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

`init()` 是显式初始化入口。调用 `agent()` 或 `toolCall()` 前必须先调用 `init()`；如果后续修改 `tools` 或 `subAgents`，需要再次调用 `init()`。

## 基本概念

`Agent<P>` 的职责：

- 保存 active context 与 raw history。
- 注入内部 system prompt、用户 system prompt 和技能提示。
- 管理工具、子代理和生命周期状态。
- 调用模型、执行工具、写入工具结果。
- 分发模型响应、工具调用和错误事件。

`Model<P>` 的职责：

- `buildUserMessage()`：构建协议用户消息。
- `buildSystemMessage()`：构建协议系统消息。
- `buildToolCallOutputMessage()`：构建协议工具结果消息。
- `buildToolMessage()`：构建协议工具声明。
- `generate()`：执行一轮模型请求。
- `parseToolCalls()`：从模型输出中提取本地工具调用。
- 其他 parser：从混合 context 中筛选并反解析 user/system/assistant/tool-result 消息。

协议类型 `P` 是封闭关联类型。需要保存或访问新的 provider 字段时，应在对应 protocol 中显式声明，而不是随意向消息对象附加字段。

## 生命周期

- 默认状态为 `idle`。
- 调用 `agent()` 后进入 `running`。
- 只有内置 `end-agent` 工具被调用后才进入 `ended`。
- 发生未处理错误时进入 `failed`。
- 默认没有迭代次数上限，可通过 `maxIterations` 设置硬上限。
- 当前版本只支持非流式 `generate()`；`stream=true` 会抛错。
- 并发调用第二个 `agent()` 会抛出 `Agent is already running.`，但不会影响正在运行的任务状态。

## 更多文档

完整 API 用法、事件、skills、子代理、自定义 Model 和多模态说明见 [packages/core/README.md](./packages/core/README.md)。
