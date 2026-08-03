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
- **上下文压缩**：支持 active-only 工具 payload 裁剪、外部定义的摘要事务，以及 context-length 错误恢复；raw history 始终保留原文。
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

## Context compact

`contextCompact` 整体未配置时不压缩。只要传入对象，缺省的 `toolInput` 与 `toolResult` 都会启用框架内置字符裁剪：input 为 `8192 → 4096`，result 为 `16384 → 8192`（UTF-16 code unit）。

```ts
const agent = new Agent({
  llm: model,
  contextCompact: {},
});
```

工具始终使用原始 arguments 执行，`getHistory()` 返回 append-only raw history，`getContext()` 返回下一次模型请求使用的 active context。压缩只 copy-on-write 改写 active payload；框架不会裁剪 raw history，也不解决内存、持久化或敏感数据留存。

可以逐类覆盖长度、完全接管或关闭策略：

```ts
const agent = new Agent({
  llm: model,
  contextCompact: {
    toolInput: { strategy: 'default', thresholdChars: 12_000, targetChars: 6_000 },
    toolResult: async (original, info) =>
      info.call.name === 'search' ? compactSearchResult(original) : undefined,
  },
});
```

自定义 callback 完全覆盖缺省策略；返回 `undefined` 或原文表示不替换，不会回退到内置策略。值为 `false` 时关闭该类。仅启用摘要时必须同时配置 `toolInput: false` 与 `toolResult: false`，因为 `{ summary }` 也会缺省启用两类工具压缩。

摘要的业务语义由调用方通过 `trigger/select/prompt/validate` 定义；框架只负责选择默认 boundary、用当前 Model 发起无工具的 `context-summary` 请求、验证响应并通过 revision CAS 原子提交。context-length 错误可复用同一摘要策略恢复。普通未知模型错误默认额外重试 3 次，context handler 默认执行 2 次；可用 `modelErrorRecovery` 覆盖，并通过 `onBeforeModelErrorRecovery()` / `onAfterModelErrorRecovery()` 控制动作。

内置 payload 压缩只保证格式规则和目标字符上限，不保证工具 schema、业务语义或脱敏。自定义 Model 在实际产生工具 replacement 时还需要实现 `rewriteToolPayloads()`，并可覆盖 `classifyError()` 识别 context-length 错误。完整配置、恢复决策和风险说明见 [packages/core/README.md](./packages/core/README.md)。离线示例位于 [Chat](./demo/src/context-compact-chat.ts) 与 [Responses](./demo/src/context-compact-responses.ts)。

## 更多文档

完整 API 用法、事件、skills、子代理、自定义 Model 和多模态说明见 [packages/core/README.md](./packages/core/README.md)。
