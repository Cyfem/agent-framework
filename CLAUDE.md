# CLAUDE

<!-- BEGIN bootstrap-project-agent-docs -->

## Workspace Primer

- 开始工作前先阅读 [README.md](./README.md)，了解仓库结构、跨项目关系、开发命令与运行风险。
- 核心框架改动继续阅读 [packages/core/README.md](./packages/core/README.md)；本地 Executor 或持久文件状态改动继续阅读 [packages/executor-local/README.md](./packages/executor-local/README.md)；Worker placement 改动继续阅读 [packages/executor-worker/README.md](./packages/executor-worker/README.md)；Process placement 改动继续阅读 [packages/executor-process/README.md](./packages/executor-process/README.md)；HTTP signed wire/security 与 poll/route/receipt 改动继续阅读 [packages/executor-http/README.md](./packages/executor-http/README.md)；demo、真实模型或桌面集成改动继续阅读 [demo/README.md](./demo/README.md)。
- Subagent v2 改造继续阅读分批实施中的 [PLAN.md](./plans/subagent-v2-production-runtime/PLAN.md)、[TECHNICAL_CHANGES.md](./plans/subagent-v2-production-runtime/TECHNICAL_CHANGES.md) 与 [TEST_ACCEPTANCE_PLAN.md](./plans/subagent-v2-production-runtime/TEST_ACCEPTANCE_PLAN.md)；区分目标设计与源码、测试、README 已证明的当前能力。
- 当前 checkout 已完成 C6，并交付 C7a/C7b/C7c-1 的 Core transport/RPC/control/Peer/artifact-sidecar、recoverable Executor settle、target registry、controller/target bridge 与 controller-owned Model gateway、C7c-2/C7c-3 的离线 Worker/Process placement、C7c-4 的 HTTP wire-security、C7c-5b 的 poll/route/receipt wire 基础，以及显式 opt-in、仅同进程 resident task 生效的 Core external reconnect 前置地基；HTTP Executor/job store/listener/delivery cursor/durable reconnect 尚未交付、Phase 2 未通过，C8–C9 分布式能力仍须以源码、测试和 README 证明，不能把 plans 中的目标 API 当作当前行为。
- Core/Local/Worker/Process/HTTP manifest 已固定为待发布 `2.0.0`，但 npm Core `latest` 仍是 `1.0.0`、四个配套包尚未发布。`npm pack --dry-run` 不是发布证明，文档必须区分 checkout、pack 与 registry 状态。

## Documentation Maintenance

- 对跨项目修改、公共 API 变更、命令变化、目录重组、依赖和外部集成保持敏感。
- 上述事实变化时，同步更新根 README 与对应项目 README。
- 完成修改后必须复核 `README.md`、相关项目文档、`AGENTS.md` 和 `CLAUDE.md` 是否仍然准确。
<!-- END bootstrap-project-agent-docs -->
