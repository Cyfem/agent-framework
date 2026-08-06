# Agent Framework Demo

`demo` 是仓库内可运行的示例包，通过 pnpm workspace alias `@manee/agent-framework` 与 `@manee/agent-executor-local` 分别引用 [`packages/core`](../packages/core) 和 [`packages/executor-local`](../packages/executor-local) 的对应可发布 workspace 包。别名只用于仓库内 import，不是额外的 npm 包。

当前两个 workspace manifest 都是待发布的 `2.0.0`；npm registry 上 Core 的 `latest` 仍为 `1.0.0`，Local Executor 尚未发布。因此本目录的 Subagent v2 demo 必须从当前 workspace 运行；两个 v2 包发布后，外部用户再安装真实包名 `@ruixutong.manee/maneeagent-framework` 与 `@ruixutong.manee/maneeagent-executor-local`。

## 方舟 Agent Plan 综合验收

综合入口会真实请求方舟 Agent Plan，同时使用 Chat Completions 与 Responses 两种协议验证框架能力：

```bash
pnpm demo:features:ark
```

先复制环境变量示例并填写凭据；`demo/.env` 已被 Git 忽略，shell 中已经导出的变量优先级更高。

```powershell
Copy-Item demo/.env.example demo/.env
```

| 变量                | 必填 | 默认值                                          |
| ------------------- | ---- | ----------------------------------------------- |
| `ARK_API_KEY`       | 是   | 无                                              |
| `ARK_PLAN_BASE_URL` | 否   | `https://ark.cn-beijing.volces.com/api/plan/v3` |
| `ARK_PLAN_MODEL`    | 否   | `kimi-k3`                                       |

每种协议执行同一条严格调用链：

1. 使用内置 `skill` 工具加载 Skill、读取 reference、读取 asset、运行本地 script。
2. 调用带 Zod 参数校验的 `@Tool` 装饰器工具。
3. 调用运行时工具生成约 20K 字符的结果。
4. 使用 v2 `{ subAgent, executor, input }` wire 调度该场景协议的隔离 child Agent。
5. 子代理调用自身装饰器工具，通过 `agent-result` 汇报 proof，再调用 `end-agent`。
6. 父代理收到 proof 后单独调用 `end-agent`。

Chat 场景使用 inline Skill，Responses 场景使用 [`fixtures/skills/portable-demo`](./fixtures/skills/portable-demo) 文件 Skill。两者都通过 typed definition、ready Runtime 和 Local Executor registry 创建 child；child 的 Model、Tools、system prompt 与 `maxIterations` 显式配置，不假定继承父 Agent。验收还会检查一次真实 `context-summary` 请求、自定义 tool-input/tool-result 压缩、active context 与 raw history 的差异、Skill 结果默认不压缩、工具事件以及父子代理上下文隔离。

## 调用边界与结果

- 父代理 `maxIterations` 为 10，子代理为 6。
- 每种协议最多 12 次 provider generate，完整运行最多 24 次真实请求。
- SDK 单次请求超时 120 秒；SDK 重试和框架模型错误重试均关闭。
- Chat 与 Responses 独立执行。一个协议失败后仍会运行另一个，但最终进程退出码为 1。
- 模型跳步、重复、同轮调用多个工具、没有返回精确 proof 或压缩断言不成立都会失败。
- 缺少 `ARK_API_KEY` 时在任何 provider 请求前失败。

命令会输出逐行 JSON，仅包含场景、阶段、工具名、消息/字符数量、状态和稳定错误元数据。成功时 Chat、Responses 与 suite 均会出现 `"phase":"passed"`；日志不会打印 API key、prompt、完整工具参数、响应正文、headers 或 provider 错误体。

## 安全说明

- 该命令会产生真实模型调用和费用，不属于默认 `pnpm test`。
- Skill script 是仓库内受信任代码，通过宿主 Node.js 子进程执行。框架使用 `shell: false` 并关闭 stdin，但不提供沙箱、默认执行超时、输出上限、网络隔离或环境变量清理。
- context compact 只改写发给后续模型请求的 active context。`getHistory()` 仍保留原始工具参数、完整大结果和其他历史内容，应按敏感数据留存要求保护。
- `.env`、请求正文和原始响应不得提交到仓库或复制到公开日志。

## 其他入口

根 [`README.md`](../README.md) 列出了离线回归、普通方舟、Windows、Electron 微信和金融新闻命令。常用的无需凭据验证包括：

```bash
pnpm test
pnpm demo
pnpm demo:chat
pnpm demo:finance-news:smoke
```

框架 API、Skills、context compact、Subagent v2 outcome/resume 与当前 Local placement 边界见 [`packages/core/README.md`](../packages/core/README.md) 和 [`packages/executor-local/README.md`](../packages/executor-local/README.md)。
