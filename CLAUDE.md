# CLAUDE

<!-- BEGIN bootstrap-project-agent-docs -->

## Workspace Primer

- 开始工作前先阅读 [README.md](./README.md)，了解仓库结构、跨项目关系、开发命令与运行风险。
- 核心框架改动继续阅读 [packages/core/README.md](./packages/core/README.md)；demo、真实模型或桌面集成改动继续阅读 [demo/README.md](./demo/README.md)。
- Subagent v2 改造继续阅读分批实施中的 [PLAN.md](./plans/subagent-v2-production-runtime/PLAN.md)、[TECHNICAL_CHANGES.md](./plans/subagent-v2-production-runtime/TECHNICAL_CHANGES.md) 与 [TEST_ACCEPTANCE_PLAN.md](./plans/subagent-v2-production-runtime/TEST_ACCEPTANCE_PLAN.md)；区分目标设计与源码、测试、README 已证明的当前能力。
- 当前源码已完成 C3 持久状态域；Catalog/Router、Executor 和 Agent v2 接线尚未完成，不能把 plans 中的目标 API 当作当前行为。

## Documentation Maintenance

- 对跨项目修改、公共 API 变更、命令变化、目录重组、依赖和外部集成保持敏感。
- 上述事实变化时，同步更新根 README 与对应项目 README。
- 完成修改后必须复核 `README.md`、相关项目文档、`AGENTS.md` 和 `CLAUDE.md` 是否仍然准确。
<!-- END bootstrap-project-agent-docs -->
