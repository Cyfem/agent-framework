# AGENTS

<!-- BEGIN bootstrap-project-agent-docs -->

## Repo Context

- 修改代码前先阅读 [README.md](./README.md)，了解仓库定位、workspace 结构、运行命令与安全边界。
- 根据改动范围继续阅读相关项目文档：
  - 核心库、公共 API、Skills 和上下文压缩：[packages/core/README.md](./packages/core/README.md)
  - 可运行示例、真实模型配置和费用边界：[demo/README.md](./demo/README.md)
  - 分批实施中的 Subagent v2 生产运行时设计与验收：[PLAN.md](./plans/subagent-v2-production-runtime/PLAN.md)、[TECHNICAL_CHANGES.md](./plans/subagent-v2-production-runtime/TECHNICAL_CHANGES.md) 与 [TEST_ACCEPTANCE_PLAN.md](./plans/subagent-v2-production-runtime/TEST_ACCEPTANCE_PLAN.md)
  - 当前实现已完成 C3 持久状态域；Catalog/Router、Executor 与 Agent v2 接线仍以源码和 README 的后续批次状态为准。

## Working Rules

- 修改前确认改动属于核心库、demo，还是跨项目工作，并理解 demo workspace alias 与发布包名的区别。
- 实现 Subagent v2 前先阅读对应 plans；plans 描述最终目标，各批次已交付能力以源码、测试和相关 README 为准。
- 如果改动影响目录结构、命令、公共 API、协议、依赖、外部集成或环境变量，必须同步更新根 README 和相关项目 README。
- 每次完成改动后，复核 `README.md`、相关项目文档、`AGENTS.md` 与 `CLAUDE.md` 是否仍与仓库事实一致。
<!-- END bootstrap-project-agent-docs -->
