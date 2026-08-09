# AGENTS

<!-- BEGIN bootstrap-project-agent-docs -->

## Repo Context

- 修改代码前先阅读 [README.md](./README.md)，了解仓库定位、workspace 结构、运行命令与安全边界。
- 根据改动范围继续阅读相关项目文档：
  - 核心库、公共 API、Skills 和上下文压缩：[packages/core/README.md](./packages/core/README.md)
  - 官方本地 Executor、Memory/Atomic File Store 与文件系统边界：[packages/executor-local/README.md](./packages/executor-local/README.md)
  - 官方 Worker Executor、静态 target、线程生命周期与安全边界：[packages/executor-worker/README.md](./packages/executor-worker/README.md)
  - 官方 Process Executor、advanced IPC、子进程生命周期与安全边界：[packages/executor-process/README.md](./packages/executor-process/README.md)
  - HTTP signed multipart、HMAC/replay/authz、poll/route/receipt 与当前非 Executor 边界：[packages/executor-http/README.md](./packages/executor-http/README.md)
  - 可运行示例、真实模型配置和费用边界：[demo/README.md](./demo/README.md)
  - 分批实施中的 Subagent v2 生产运行时设计与验收：[PLAN.md](./plans/subagent-v2-production-runtime/PLAN.md)、[TECHNICAL_CHANGES.md](./plans/subagent-v2-production-runtime/TECHNICAL_CHANGES.md) 与 [TEST_ACCEPTANCE_PLAN.md](./plans/subagent-v2-production-runtime/TEST_ACCEPTANCE_PLAN.md)
  - 当前 checkout 已完成 C6，并交付 C7a/C7b/C7c-1 的 Core transport/RPC/control/Peer/artifact-sidecar、recoverable Executor settle、target registry、controller/target bridge 与 controller-owned Model gateway、C7c-2/C7c-3 的离线 Worker/Process placement、C7c-4 的 HTTP wire-security、C7c-5b 的 poll/route/receipt wire 基础、C7c-5c 的原子 create/replay Job Store 地基、C7c-5d-a 的 Store IO context 与仅限初始 attachment 的 delivery/ACK/wait Memory ledger，以及显式 opt-in、仅同进程 resident task 生效的 Core external reconnect 前置地基；HTTP Executor、production durable Store、delivery response wire、attachment recovery、listener/heartbeat/durable reconnect 尚未交付、Phase 2 未通过，C8–C9 分布式能力仍以源码、测试和 README 状态为准。
  - Core/Local/Worker/Process/HTTP package manifest 已固定为待发布 `2.0.0`，但 npm Core `latest` 仍是 `1.0.0`、四个配套包尚未发布；不得把 manifest、pack 成功或计划状态写成 npm 已发布。

## Working Rules

- 修改前确认改动属于核心库、demo，还是跨项目工作，并理解两个 demo workspace alias、真实包名与 npm 实际发布状态的区别。
- 实现 Subagent v2 前先阅读对应 plans；plans 描述最终目标，各批次已交付能力以源码、测试和相关 README 为准。
- 如果改动影响目录结构、命令、公共 API、协议、依赖、外部集成或环境变量，必须同步更新根 README 和相关项目 README。
- 每次完成改动后，复核 `README.md`、相关项目文档、`AGENTS.md` 与 `CLAUDE.md` 是否仍与仓库事实一致。
<!-- END bootstrap-project-agent-docs -->
