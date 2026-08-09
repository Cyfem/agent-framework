# Agent Framework

[![npm version](https://img.shields.io/npm/v/%40ruixutong.manee%2Fmaneeagent-framework?logo=npm)](https://www.npmjs.com/package/@ruixutong.manee/maneeagent-framework)
![Node.js >= 22](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)

`@ruixutong.manee/maneeagent-framework` 是一个运行在 Node.js 端、以 TypeScript 为主要开发体验的 AI Agent 编排框架。它把 Agent 的任务循环、上下文、工具、事件和子代理，与具体模型 API 的消息格式和请求方式解耦，使同一套 Agent 逻辑可以接入不同协议。

本仓库是框架源码和示例所在的 pnpm workspace。可发布的核心包位于 [`packages/core`](./packages/core)，完整 API 文档见 [`packages/core/README.md`](./packages/core/README.md)；官方 Local、Worker 与 Process Executor 分别见 [`packages/executor-local`](./packages/executor-local)、[`packages/executor-worker`](./packages/executor-worker) 和 [`packages/executor-process`](./packages/executor-process)，HTTP signed-wire 安全基础见 [`packages/executor-http`](./packages/executor-http)。

> **发布状态**：当前 checkout 中 Core、Local、Worker、Process 与 HTTP wire-security 包的 package manifest 都是待发布的 `2.0.0`，但 npm registry 上 Core 的 `latest` 仍是 `1.0.0`，四个配套包尚未发布。本文的 v2 API 与 npm 安装示例面向 `2.0.0` 发布物；在正式发布前，请在本仓库通过 workspace 命令构建和验收，不能用 manifest 版本推断 npm 已发布。

## 核心能力

- **协议解耦**：`Agent<P>` 负责编排，`Model<P>` 负责协议消息、工具声明、工具调用解析和模型请求。
- **双协议适配**：内置 OpenAI-compatible `OpenAIResponsesModel` 与 `OpenAIChatModel`。
- **工具调用**：支持 `@Tool` 装饰器和运行时工具，调用前通过 Zod-compatible schema 校验参数。
- **上下文与历史**：分别维护模型使用的 active context 和完整 raw history，并保留 provider 原始字段。
- **事件系统**：可观察模型响应、工具调用前后、工具异常、Agent 状态和 Agent 错误。
- **渐进式 Skills**：首轮只暴露 `name + description`，模型通过内置 `skill` 工具按需加载 instructions、读取文本资源或运行显式启用的脚本。
- **Subagent v2**：通过 typed `SubAgentDefinition`、模型可见 `{ subAgent, executor, input }` wire 和独立 Executor 调度隔离 child Agent；支持跨协议 placement、审批暂停/恢复、嵌套委派、持久 checkpoint、取消与 typed result，并提供 Local、真实 `worker_threads` 与真实 `child_process` placement、C7 transport v1、14-kind strict RPC、controller/target bridge、controller-owned Model gateway、双向 Peer、artifact sidecar 与可恢复 Executor settle contract。
- **HTTP wire security**：提供严格单包 multipart、HMAC-SHA256 v1、原子 replay SPI、owner scope authorization 和脱敏 admission；HTTP job/client/server、heartbeat handler、cursor 与 reconnect 仍属后续批次。
- **上下文压缩与恢复**：支持 active-only 工具 payload 裁剪、外部摘要事务和 context-length 错误恢复；raw history 始终保留原文。
- **多模态上下文**：Responses 支持文件上传和图片、文件、视频、音频内容块；Chat 支持图片、音频和文件内容块。
- **扩展 Model**：可继承 `Model<P>` 接入其他消息协议或 OpenAI-compatible 服务。

## 快速开始

### 安装 npm 包（`2.0.0` 发布后）

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

const outcome = await agent.agent('请保存一条笔记：今天完成 README。');

if (outcome.status === 'succeeded') {
  console.log(outcome.context);
} else {
  console.log(outcome.status, outcome.runId);
}
```

`init()` 是显式配置校验入口。调用 `agent()` 或 `toolCall()` 前必须先调用它；修改 Tools、system prompts、Skills/`skillRuntime`、context compact 或模型错误恢复等运行语义配置后也需要再次调用。`agent()` 返回 `succeeded`、`waiting_approval`、`cancelled` 或 `failed` outcome；配置、初始化和编程错误仍会抛异常。`maxIterations` 用于限制模型循环次数，避免模型没有按要求调用 `end-agent` 时持续请求。

使用 `@Tool` 时，应用构建链需要支持 2023-11 decorators；不使用装饰器的 JavaScript/TypeScript 项目可以通过 `agent.tools.push()` 注册运行时工具。更多用法见 [核心包文档](./packages/core/README.md)。

## 仓库结构

| 路径                        | 说明                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| `packages/core`             | Core `2.0.0` 待发布源码，输出 ESM、CJS 和 TypeScript 声明。              |
| `packages/executor-local`   | Local Executor 与 Memory/Atomic File StateStore 的 `2.0.0` 待发布包。    |
| `packages/executor-worker`  | 每 task 一个受信 `worker_threads.Worker` 的 `2.0.0` 待发布 Executor 包。 |
| `packages/executor-process` | 每 task 一个受信 Node.js 子进程的 `2.0.0` 待发布 Executor 包。           |
| `packages/executor-http`    | HTTP signed multipart/HMAC/replay/authz 的 `2.0.0` 待发布安全基础包。    |
| `demo/src`                  | CLI 示例、离线回归、真实方舟调用、金融新闻和 Windows 工具。              |
| `demo/electron-weixin`      | Windows Electron 微信消息示例。                                          |
| `plans`                     | Subagent v2 的目标架构与验收方案；已实现范围以源码和各包 README 为准。   |

五个待发布包都没有 `bin` CLI；下文命令都是本仓库的 pnpm workspace scripts。demo 源码中的 `@manee/agent-framework` 与 `@manee/agent-executor-local` 是 workspace alias，分别指向待发布包 `@ruixutong.manee/maneeagent-framework` 与 `@ruixutong.manee/maneeagent-executor-local`；它们只是仓库内 import 名，不是另外两个 npm 包。

## 本地开发

要求：

- Node.js >= 22
- pnpm 11；仓库通过 `packageManager` 固定为 `pnpm@11.1.3`

```bash
pnpm install --frozen-lockfile
pnpm demo
```

`pnpm demo` 是无需 API key 的离线综合回归，可用于确认本地环境和核心构建链正常。

正式验收证据使用固定的 Node.js 22 和 `pnpm@11.1.3`。Windows 上可运行 `pnpm toolchain:node22`，脚本会把便携工具链安装到被忽略的 `.tools/` 目录，并在解压前核对 Node.js 官方 SHA-256；日常开发可继续使用满足版本要求的本机工具链。

Subagent v2 实施期间可运行 `pnpm validate:subagent:v2:manifest`、`pnpm validate:subagent:v2:legacy` 和 `pnpm validate:subagent:v2:pack` 校验需求追踪、旧 API/wire 零残留与 Core/Local/Worker/Process/HTTP 五个待发布包的内容。manifest 门禁会静态核对所有测试源码中的 literal `acceptanceIt(caseId, variant, fn)` 与清单记录，拒绝动态、重复、错文件或未登记 case；legacy 门禁以 `--forbid-all` 扫描整个 `packages` 与 `demo` 可执行源码树；pack 门禁会先运行敏感产物、源码泄漏、缺 source map、超时和输出超限负例，再重新构建五包并比对 dry-run 与真实临时 tarball。发布文件只允许根 `package.json`、README/license，以及 `dist` 中的 ESM/CJS、声明和 source map，并叠加 secret-sensitive 文件拒绝。真实 tarball 解包后会以正式包名执行 ESM `import()` 与 CommonJS `require()` smoke，并同时编译 `type: module` ESM 与 `.cts` CommonJS 消费者；两者都使用 `module/moduleResolution: NodeNext`、`strict: true`、`skipLibCheck: false`、关键 contract/字段非 `any` 断言和 missing-export 负检。门禁还锁定包名、Node.js 要求、根 exports、无 `bin` 与 peer range；Local/Worker/Process/HTTP 使用同一轮生成、解包且 semver 兼容的 Core tarball，不借用 workspace Core。除本地 `npm pack` 外的 tar/tsc/runtime child 只收到最小环境白名单，所有 child 都有 wall-clock watchdog，因而不会把 `ARK_API_KEY` 等凭证带入消费 smoke。`validate:subagent:v2:evidence` 还需通过 `--evidence=<repo-relative.json>` 显式指定本次证据 shard。这些是仓库验收命令，不是 npm 包 CLI；临时生成 tarball 也不代表执行了 `npm publish`。

## Skills

Skills 支持跨运行时的 inline 结构体，以及仅在 Node 文件能力可用时启用的 file source。模型首轮只看到 `name + description`，随后通过内置 `skill({ skill, args? })` 工具按需执行 `load`、`read <resource-id>` 或 `run <script-id> [args...]`；脚本默认关闭，必须通过 `skillRuntime.scripts` 显式配置 executor 或开启自动检测。

Skill script 是宿主显式信任的本地代码。框架使用 `shell: false` 并关闭 stdin，但不提供沙箱、默认 timeout、输出上限、网络隔离或环境变量清理，子进程也会继承宿主环境。完整配置、portable text subset 和安全边界见 [核心包 Skills 文档](./packages/core/README.md#系统提示词与-skills)。

## Demo

### 离线回归

这些命令使用固定 mock 或 fixture，不请求真实模型，也不需要 API key。

| 命令                           | 覆盖内容                                                                  |
| ------------------------------ | ------------------------------------------------------------------------- |
| `pnpm demo`                    | Responses/Chat、工具、Skills、事件、上下文、Subagent v2、错误和并发保护。 |
| `pnpm demo:chat`               | Chat `tool_calls[]` / `tool` role 工具闭环。                              |
| `pnpm demo:finance-news:smoke` | 固定 RSS fixture、筛选、排序、笔记和金融简报工具链。                      |

### 真实模型与网络

以下 CLI demo 会请求真实方舟 endpoint，可能产生模型调用费用；金融新闻示例还会访问公共 RSS。运行前请从 shell 注入 `ARK_API_KEY`，不要把 key 写入源码或提交历史。

| 命令                     | 协议与用途                                                             |
| ------------------------ | ---------------------------------------------------------------------- |
| `pnpm demo:ark:smoke`    | Responses 最小真实工具调用冒烟。                                       |
| `pnpm demo:ark`          | Responses 完整能力场景；与 `pnpm demo:complex` 使用同一入口。          |
| `pnpm demo:ark:coding`   | Coding Plan Chat Completions 工具闭环。                                |
| `pnpm demo:ark:subagent` | 分别验证 Responses 与 Chat 子代理调度。                                |
| `pnpm demo:features:ark` | Agent Plan Chat/Responses 综合验收：Skills、Tool、子代理与上下文压缩。 |
| `pnpm demo:finance-news` | 通过公共 RSS 生成带来源链接的中文市场简报。                            |

`demo:ark:coding`、`demo:ark:subagent` 和 `demo:features:ark` 会自动读取已忽略的 `demo/.env`；其他真实 CLI demo 只读取当前进程环境。综合验收默认使用方舟 Agent Plan `/api/plan/v3` 和 `kimi-k3`，依次运行 Chat 与 Responses；每种协议最多 12 次 provider generate、单次请求超时 120 秒，SDK 与框架错误重试均关闭，因此一次完整通过最多产生 24 次真实、可计费请求。一个协议失败后另一个仍会运行，任一失败都会使命令以非零状态退出。

综合验收的日志只输出协议、阶段、工具名、长度和稳定错误元数据，不输出 API key、prompt、完整工具 payload 或响应体。Skill script 作为受信任宿主 Node.js 子进程运行，不受框架沙箱保护；context compact 只缩短 active context，raw history 仍保留原始内容。详细运行和安全说明见 [`demo/README.md`](./demo/README.md)。

### Windows 与微信

| 命令                        | 说明                                                            |
| --------------------------- | --------------------------------------------------------------- |
| `pnpm demo:windows`         | Windows 微信窗口控制，使用 Responses 和文件上传传递截图。       |
| `pnpm demo:windows:chat`    | Windows 微信窗口控制，使用 Chat `image_url` data URL 传递截图。 |
| `pnpm demo:electron:weixin` | Electron GUI，通过界面配置 Chat 模型、任务和交互授权。          |

两个 CLI Windows demo 默认只允许查找窗口和截图观察。只有显式设置 `ARK_WINDOWS_DEMO_INTERACTIVE=1` 才会解锁点击、键盘输入和消息发送；请同时设置明确的联系人和消息，不要依赖源码中的演示默认值。

Electron demo 同样要求在界面中显式勾选交互授权。它内置仓库中的微信技能手册，并向模型提供筛选后的 Win32 工具以及框架内置的 `agent`、`skill`、`end-agent` 工具。

Electron 截图会写入 `.artifacts/electron-weixin`，本地通过 `serve` 监听 2345 端口，再使用当前硬编码的 `https://weixin-agent.maneerui.com/<file>` 地址交给模型。仓库不会创建或配置 Cloudflare Tunnel；运行者必须预先把该公网域名路由到本地 2345 端口。截图可能经公网 URL 暴露给模型服务，运行前请确认网络配置并避免采集敏感内容。因此该 demo 是部署绑定型示例，不是克隆后即可一键运行的通用应用。

## Demo 环境变量

| 变量                                          | 使用范围                          | 说明                                      |
| --------------------------------------------- | --------------------------------- | ----------------------------------------- |
| `ARK_API_KEY`                                 | 所有真实 CLI demo                 | 必填的模型凭据；Electron 从界面读取配置。 |
| `ARK_BASE_URL` / `ARK_MODEL`                  | Responses、Windows、金融新闻 demo | 覆盖示例默认 endpoint 和模型。            |
| `ARK_CODING_BASE_URL` / `ARK_CODING_MODEL`    | `demo:ark:coding`                 | 覆盖 Coding Plan Chat endpoint 和模型。   |
| `ARK_SUBAGENT_MODEL`                          | `demo:ark:subagent`               | 覆盖子代理 smoke 使用的模型。             |
| `ARK_PLAN_BASE_URL` / `ARK_PLAN_MODEL`        | `demo:features:ark`               | 覆盖 Agent Plan endpoint 和模型。         |
| `FINANCE_NEWS_QUERY`                          | `demo:finance-news`               | 自定义研究任务；命令行参数优先级更高。    |
| `ARK_WINDOWS_DEMO_INTERACTIVE`                | Windows CLI demo                  | 设为 `1` 才允许点击、输入和发送。         |
| `ARK_WEIXIN_RECIPIENT` / `ARK_WEIXIN_MESSAGE` | Windows CLI demo                  | 指定微信联系人和发送内容。                |
| `AGENT_FRAMEWORK_WINDOWS_ARTIFACT_ROOT`       | Windows CLI demo                  | 覆盖截图和调试产物目录。                  |
| `ARK_DEBUG_DUMP`                              | Windows Responses demo            | 设为 `1` 时保存调试请求与响应。           |
| `ELECTRON_WEIXIN_DEVTOOLS`                    | Electron demo                     | 设为 `1` 时打开 Electron DevTools。       |

## 开发校验

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm acceptance:subagent:v2:worker:offline
pnpm acceptance:subagent:v2:process:offline
pnpm acceptance:subagent:v2:http-security:offline
```

`pnpm test` 显式组合 Core、Local、Worker、Process Executor 与 HTTP wire-security 的无网络测试，以及 Local 专用跨进程恢复测试，不需要模型凭据或网络访问，也不会递归触发真实模型命令。`acceptance:subagent:v2:worker:offline` 额外运行真实 `worker_threads` 的崩溃、terminate、checkpoint 和资源回收 shard；`acceptance:subagent:v2:process:offline` 运行真实 Node.js 子进程的 handshake、IPC、cancel/kill、exit/close、orphan watchdog、checkpoint 和恢复故障窗；`acceptance:subagent:v2:http-security:offline` 验证 multipart、HMAC、replay、authorization 与安全响应。三者都使用离线 fixture/fake SDK，不读取 API key。`pnpm demo`、`pnpm demo:chat` 和 `pnpm demo:finance-news:smoke` 是额外的离线回归入口。

## 当前限制

- 当前只支持非流式 `generate()`；`agent(input, { stream: true })` 会在创建 run/task 前抛出 `STREAMING_UNSUPPORTED`。
- Agent 必须通过内置 `end-agent` 工具正常结束，且该工具需要单独调用。
- `maxIterations` 默认不设上限，真实模型场景建议显式配置。
- 同一个 Agent 实例不能并发执行多个 `agent()` 调用。
- 父 Agent 与 child Agent 可以使用不同协议；child 的 Model、Tools、Skills、system prompts、compact 与错误恢复配置由受信任 Executor factory 独立提供，不从父 Agent 隐式继承。
- durable root resume 和跨进程 child resume 需要 ready `SubAgentRuntime`、持久 StateStore 以及兼容的版本化 checkpoint codec。无 codec 自定义协议仅限宿主提供、Catalog 明确声明 `same_process` 的 placement：同一 Agent 实例可以保留进程内 checkpoint 并恢复根审批；替换实例、跨进程恢复和无 codec child 自身产生的 durable 审批仍会被拒绝。官方 Local Executor 声明的是 `checkpoint`，不是 `same_process`。
- 当前 checkout 已实现宿主进程内 Local Executor、真实 `worker_threads` Worker Executor、真实 Node.js `child_process` Executor、单机 Memory/Atomic File StateStore，以及 C7 Core 共用的 closed JSON transport v1、14-kind strict RPC、16-method control dispatcher/proxy、controller/target bridge、controller-owned Model gateway、双向 Peer、32 MiB 单件/128 MiB 单 packet artifact sidecar 和 `recovery_required` settle contract。Target bridge 绑定经认证的单一 owner session，并把 Model gateway/protocol/codec 身份固定到持久 binding；Model gateway 支持幂等 budget、显式 crash takeover、attempt-aware reply-loss replay、token usage 结算与有界内存 receipt，内置 OpenAI adapter 每次 SDK dispatch 强制 `maxRetries: 0`。Worker 与 Process 都使用静态受信 target、支持 checkpoint resume 且不支持 reconnect；两者都不是文件系统、网络或不受信代码沙箱。Process 只保证受控直属子进程的有界清理，不承诺回收 target 自行创建的任意进程树。HTTP 包当前只交付严格 signed multipart、HMAC-SHA256 v1、原子 replay SPI、owner scope authz 和脱敏 admission，尚无 Executor/job/listener/heartbeat handler/cursor/reconnect。Core target bridge 默认仍对 live external reconnect fail closed；显式配置 `reconnect: 'external_binding'` 与 durable `checkpointCommitted` hook 时，只提供同一 bridge 进程内的 runner replacement 地基：按受信 channel fence 旧 attachment，排空已准入 control/checkpoint 与 provider Model exchange，并从最后一个 controller-ACK 且 placement 已持久化的兼容 checkpoint 重建原 task。Model transport 结果不确定时，只有同一 `providerOperationId + canonical request hash` 可以查询 controller 已持久化的原结果；权威 `outcomeUnknown` 不可逆，也不会授权第二次 provider dispatch。它不导入旧 Peer pending 状态，不恢复已退出 bridge/process，也不等同于 HTTP durable reconnect。Remote control proxy 暂不提供 artifact `put`。完整 HTTP placement 与分布式生产适配器仍属于后续 C7–C9，Phase 2 尚未通过，且当前四个配套包尚未发布到 npm。
- `@Tool` 需要应用构建链支持 2023-11 decorators。

`agent()` 和独立 `toolCall()` 支持传入 `AbortSignal` 与绝对 `deadlineAt`。取消信号会贯穿 Model、Tool、摘要、payload compactor 和模型错误恢复；Chat/Responses 适配器只把 `signal` 作为 SDK request option 传递，不会把截止时间或运行时身份写入 provider body。取消是协作式的，第三方 Model、Tool 或 callback 仍需主动遵守收到的 signal。对 durable provider operation，SDK dispatch 前收到取消会得到 `cancelled`；请求 intent 已持久化为 `in_flight` 后再发生 abort、超时或连接结果不确定，则 run/task 固定为 `failed + outcomeUnknown`，不会自动重发可能已经执行的请求。

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

核心 API、事件、上下文、Skills、子代理、Responses/Chat 适配和自定义 Model 的完整说明见 [`packages/core/README.md`](./packages/core/README.md)。

Subagent v2 正按三阶段计划分批实施。当前 checkout 的 Core/Local/Worker/Process/HTTP manifest 为 `2.0.0`，C2–C6 源码已完成 Core contracts、持久状态域、Catalog/Router、公开 `Agent` durable loop、v1 原子删除、跨协议 Local placement、审批/嵌套审批恢复、context compact 崩溃窗口恢复，以及 Memory/Atomic File StateStore；C7 Core 层已进一步交付 transport v1、14-kind strict RPC/control、双向 Peer、artifact sidecar、recoverable Executor settle、target registry、controller/target bridge、controller-owned Model gateway，以及显式 opt-in、仅同进程 resident task 生效的 external reconnect 前置地基，C7c-2/C7c-3 已交付离线 Worker/Process placement，C7c-4 已交付 HTTP signed multipart/HMAC/replay/authz 安全基础。HTTP Executor/job/listener/durable reconnect 以及 C8–C9 的分布式适配器、Compose、完整 evidence/release report 尚未交付，Phase 2 尚未通过；Worker/Process/HTTP 方舟 L5、Docker/Linux live gate 与完整真实方舟验收也未执行。npm 发布状态独立于这些 manifest。实际 API 与运行边界见 [`packages/core/README.md`](./packages/core/README.md)、[`packages/executor-local/README.md`](./packages/executor-local/README.md)、[`packages/executor-worker/README.md`](./packages/executor-worker/README.md)、[`packages/executor-process/README.md`](./packages/executor-process/README.md) 与 [`packages/executor-http/README.md`](./packages/executor-http/README.md)。
