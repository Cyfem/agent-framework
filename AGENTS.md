# AGENTS

<!-- BEGIN bootstrap-project-agent-docs -->

## Repo Context

- 修改代码前先阅读 [README.md](./README.md)，了解仓库定位、workspace 结构、运行命令与安全边界。
- 根据改动范围继续阅读相关项目文档：
  - 核心库、公共 API、Skills 和上下文压缩：[packages/core/README.md](./packages/core/README.md)
  - 可运行示例、真实模型配置和费用边界：[demo/README.md](./demo/README.md)
  - 尚未实现的 Subagent v2 生产运行时设计与验收：[PLAN.md](./plans/subagent-v2-production-runtime/PLAN.md)、[TECHNICAL_CHANGES.md](./plans/subagent-v2-production-runtime/TECHNICAL_CHANGES.md) 与 [TEST_ACCEPTANCE_PLAN.md](./plans/subagent-v2-production-runtime/TEST_ACCEPTANCE_PLAN.md)

## Working Rules

- 修改前确认改动属于核心库、demo，还是跨项目工作，并理解 workspace link 与发布包名的区别。
- 实现 Subagent v2 前先阅读对应 plans；plans 描述未来设计，不能当成当前公共 API 或已交付能力。
- 如果改动影响目录结构、命令、公共 API、协议、依赖、外部集成或环境变量，必须同步更新根 README 和相关项目 README。
- 每次完成改动后，复核 `README.md`、相关项目文档、`AGENTS.md` 与 `CLAUDE.md` 是否仍与仓库事实一致。
<!-- END bootstrap-project-agent-docs -->
