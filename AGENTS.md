# AGENTS

<!-- BEGIN bootstrap-project-agent-docs -->

## Repo Context

- 修改代码前先阅读 [README.md](./README.md)，了解仓库定位、workspace 结构、运行命令与安全边界。
- 根据改动范围继续阅读相关项目文档：
  - 核心库、公共 API、Skills 和上下文压缩：[packages/core/README.md](./packages/core/README.md)
  - 官方本地 Executor、Memory/Atomic File Store 与文件系统边界：[packages/executor-local/README.md](./packages/executor-local/README.md)
  - 可运行示例、真实模型配置和费用边界：[demo/README.md](./demo/README.md)
  - 分批实施中的 Subagent v2 生产运行时设计与验收：[PLAN.md](./plans/subagent-v2-production-runtime/PLAN.md)、[TECHNICAL_CHANGES.md](./plans/subagent-v2-production-runtime/TECHNICAL_CHANGES.md) 与 [TEST_ACCEPTANCE_PLAN.md](./plans/subagent-v2-production-runtime/TEST_ACCEPTANCE_PLAN.md)
  - 当前 checkout 已完成 C6，并交付 C7 的 Core transport/RPC/control/Peer/artifact-sidecar 与 recoverable Executor settle 地基；Worker/Process/HTTP placement 尚未交付、Phase 2 未通过，C8–C9 分布式能力仍以源码、测试和 README 状态为准。
  - Core/Local package manifest 已固定为待发布 `2.0.0`，但 npm Core `latest` 仍是 `1.0.0`、Local 尚未发布；不得把 manifest、pack 成功或计划状态写成 npm 已发布。

## Working Rules

- 修改前确认改动属于核心库、demo，还是跨项目工作，并理解两个 demo workspace alias、真实包名与 npm 实际发布状态的区别。
- 实现 Subagent v2 前先阅读对应 plans；plans 描述最终目标，各批次已交付能力以源码、测试和相关 README 为准。
- 如果改动影响目录结构、命令、公共 API、协议、依赖、外部集成或环境变量，必须同步更新根 README 和相关项目 README。
- 每次完成改动后，复核 `README.md`、相关项目文档、`AGENTS.md` 与 `CLAUDE.md` 是否仍与仓库事实一致。
<!-- END bootstrap-project-agent-docs -->
