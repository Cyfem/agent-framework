# Agent Framework

[![npm version](https://img.shields.io/npm/v/%40ruixutong.manee%2Fmaneeagent-framework?logo=npm)](https://www.npmjs.com/package/@ruixutong.manee/maneeagent-framework)
![Node.js >= 22](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)

`@ruixutong.manee/maneeagent-framework` 是一个运行在 Node.js 端、以 TypeScript 为主要开发体验的 AI Agent 编排框架。它把 Agent 的任务循环、上下文、工具、事件和子代理，与具体模型 API 的消息格式和请求方式解耦，使同一套 Agent 逻辑可以接入不同协议。

本仓库是框架源码和示例所在的 pnpm workspace。可发布的核心包位于 [`packages/core`](./packages/core)，完整 API 文档见 [`packages/core/README.md`](./packages/core/README.md)。

## 核心能力

- **协议解耦**：`Agent<P>` 负责编排，`Model<P>` 负责协议消息、工具声明、工具调用解析和模型请求。
- **双协议适配**：内置 OpenAI-compatible `OpenAIResponsesModel` 与 `OpenAIChatModel`。
- **工具调用**：支持 `@Tool` 装饰器和运行时工具，调用前通过 Zod-compatible schema 校验参数。
- **上下文与历史**：分别维护模型使用的 active context 和完整 raw history，并保留 provider 原始字段。
- **事件系统**：可观察模型响应、工具调用前后、工具异常、Agent 状态和 Agent 错误。
- **Skills 与子代理**：通过内置 `get-skill` 按需读取技能手册，通过内置 `agent` 工具调度同协议子代理。
- **多模态上下文**：Responses 支持文件上传和图片、文件、视频、音频内容块；Chat 支持图片、音频和文件内容块。
- **扩展 Model**：可继承 `Model<P>` 接入其他消息协议或 OpenAI-compatible 服务。

## 快速开始

### 安装 npm 包

```bash
npm install @ruixutong.manee/maneeagent-framework zod
```

下面的示例使用 Responses adapter 和一个装饰器工具。`OPENAI_API_KEY`、`OPENAI_MODEL` 只是示例约定；核心库本身不读取固定环境变量，模型凭据和 endpoint 通过 Model options 或已配置的 OpenAI client 注入。

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

`init()` 是显式配置校验入口。调用 `agent()` 或 `toolCall()` 前必须先调用它；修改 `tools` 或 `subAgents` 后也需要再次调用。`maxIterations` 用于限制模型循环次数，避免模型没有按要求调用 `end-agent` 时持续请求。

使用 `@Tool` 时，应用构建链需要支持 2023-11 decorators；不使用装饰器的 JavaScript/TypeScript 项目可以通过 `agent.tools.push()` 注册运行时工具。更多用法见 [核心包文档](./packages/core/README.md)。

## 仓库结构

| 路径                   | 说明                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `packages/core`        | 唯一发布到 npm 的核心库，输出 ESM、CJS 和 TypeScript 声明。 |
| `demo/src`             | CLI 示例、离线回归、真实方舟调用、金融新闻和 Windows 工具。 |
| `demo/electron-weixin` | Windows Electron 微信消息示例。                             |

核心包没有 `bin` CLI；下文命令都是本仓库的 pnpm workspace scripts。demo 源码中的 `@manee/agent-framework` 是指向 `packages/core` 的本地 link alias，不是 npm 发布名。

## 本地开发

要求：

- Node.js >= 22
- pnpm 11；仓库通过 `packageManager` 固定为 `pnpm@11.1.3`

```bash
pnpm install --frozen-lockfile
pnpm demo
```

`pnpm demo` 是无需 API key 的离线综合回归，可用于确认本地环境和核心构建链正常。

## Demo

### 离线回归

这些命令使用固定 mock 或 fixture，不请求真实模型，也不需要 API key。

| 命令                           | 覆盖内容                                                             |
| ------------------------------ | -------------------------------------------------------------------- |
| `pnpm demo`                    | Responses/Chat、工具、Skills、事件、上下文、子代理、错误和并发保护。 |
| `pnpm demo:chat`               | Chat `tool_calls[]` / `tool` role 工具闭环。                         |
| `pnpm demo:finance-news:smoke` | 固定 RSS fixture、筛选、排序、笔记和金融简报工具链。                 |

### 真实模型与网络

以下 CLI demo 会请求真实方舟 endpoint，可能产生模型调用费用；金融新闻示例还会访问公共 RSS。运行前请从 shell 注入 `ARK_API_KEY`，不要把 key 写入源码或提交历史。

| 命令                     | 协议与用途                                                    |
| ------------------------ | ------------------------------------------------------------- |
| `pnpm demo:ark:smoke`    | Responses 最小真实工具调用冒烟。                              |
| `pnpm demo:ark`          | Responses 完整能力场景；与 `pnpm demo:complex` 使用同一入口。 |
| `pnpm demo:ark:coding`   | Coding Plan Chat Completions 工具闭环。                       |
| `pnpm demo:ark:subagent` | 分别验证 Responses 与 Chat 子代理调度。                       |
| `pnpm demo:finance-news` | 通过公共 RSS 生成带来源链接的中文市场简报。                   |

只有 `demo:ark:coding` 和 `demo:ark:subagent` 会自动读取已忽略的 `demo/.env`；其他真实 CLI demo 只读取当前进程环境。

### Windows 与微信

| 命令                        | 说明                                                            |
| --------------------------- | --------------------------------------------------------------- |
| `pnpm demo:windows`         | Windows 微信窗口控制，使用 Responses 和文件上传传递截图。       |
| `pnpm demo:windows:chat`    | Windows 微信窗口控制，使用 Chat `image_url` data URL 传递截图。 |
| `pnpm demo:electron:weixin` | Electron GUI，通过界面配置 Chat 模型、任务和交互授权。          |

两个 CLI Windows demo 默认只允许查找窗口和截图观察。只有显式设置 `ARK_WINDOWS_DEMO_INTERACTIVE=1` 才会解锁点击、键盘输入和消息发送；请同时设置明确的联系人和消息，不要依赖源码中的演示默认值。

Electron demo 同样要求在界面中显式勾选交互授权。它内置仓库中的微信技能手册，并向模型提供筛选后的 Win32 工具以及框架内置的 `agent`、`get-skill`、`end-agent` 工具。

Electron 截图会写入 `.artifacts/electron-weixin`，本地通过 `serve` 监听 2345 端口，再使用当前硬编码的 `https://weixin-agent.maneerui.com/<file>` 地址交给模型。仓库不会创建或配置 Cloudflare Tunnel；运行者必须预先把该公网域名路由到本地 2345 端口。截图可能经公网 URL 暴露给模型服务，运行前请确认网络配置并避免采集敏感内容。因此该 demo 是部署绑定型示例，不是克隆后即可一键运行的通用应用。

## Demo 环境变量

| 变量                                          | 使用范围                          | 说明                                      |
| --------------------------------------------- | --------------------------------- | ----------------------------------------- |
| `ARK_API_KEY`                                 | 所有真实 CLI demo                 | 必填的模型凭据；Electron 从界面读取配置。 |
| `ARK_BASE_URL` / `ARK_MODEL`                  | Responses、Windows、金融新闻 demo | 覆盖示例默认 endpoint 和模型。            |
| `ARK_CODING_BASE_URL` / `ARK_CODING_MODEL`    | `demo:ark:coding`                 | 覆盖 Coding Plan Chat endpoint 和模型。   |
| `ARK_SUBAGENT_MODEL`                          | `demo:ark:subagent`               | 覆盖子代理 smoke 使用的模型。             |
| `FINANCE_NEWS_QUERY`                          | `demo:finance-news`               | 自定义研究任务；命令行参数优先级更高。    |
| `ARK_WINDOWS_DEMO_INTERACTIVE`                | Windows CLI demo                  | 设为 `1` 才允许点击、输入和发送。         |
| `ARK_WEIXIN_RECIPIENT` / `ARK_WEIXIN_MESSAGE` | Windows CLI demo                  | 指定微信联系人和发送内容。                |
| `AGENT_FRAMEWORK_WINDOWS_ARTIFACT_ROOT`       | Windows CLI demo                  | 覆盖截图和调试产物目录。                  |
| `ARK_DEBUG_DUMP`                              | Windows Responses demo            | 设为 `1` 时保存调试请求与响应。           |
| `ELECTRON_WEIXIN_DEVTOOLS`                    | Electron demo                     | 设为 `1` 时打开 Electron DevTools。       |

## 开发校验

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
```

仓库当前没有独立的 `test` script 或单元测试框架；`pnpm demo`、`pnpm demo:chat` 和 `pnpm demo:finance-news:smoke` 是现有的离线回归入口。

## 当前限制

- 当前只支持非流式 `generate()`；`agent(input, true)` 会抛错。
- Agent 必须通过内置 `end-agent` 工具正常结束，且该工具需要单独调用。
- `maxIterations` 默认不设上限，真实模型场景建议显式配置。
- 同一个 Agent 实例不能并发执行多个 `agent()` 调用。
- 父子代理必须使用同一个协议规格。
- `@Tool` 需要应用构建链支持 2023-11 decorators。

## 更多文档

核心 API、事件、上下文、Skills、子代理、Responses/Chat 适配和自定义 Model 的完整说明见 [`packages/core/README.md`](./packages/core/README.md)。
