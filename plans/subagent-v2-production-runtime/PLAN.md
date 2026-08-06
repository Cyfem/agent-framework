# Subagent v2 生产运行时改造计划

## 摘要

将当前“父 Agent 通过内置 `agent` Tool 同步实例化同协议子类”的实现，直接升级为面向生产环境的 Subagent v2。v2 把子代理定义、任务状态、Executor 选择、会话归属、审批、恢复、预算和可观测性提升为稳定公共契约；具体子代理循环、模型、Tool 与运行环境全部交给外部 Executor 适配器执行。

本次是明确的 2.0 breaking change：删除旧 `AgentOptions.subAgents`、`AgentConstructor`、动态 `RuntimeSubAgent` 和旧 `agentName/input/outputDescription` Tool 协议，不提供兼容适配层。官方本地 Executor 作为独立 workspace 包交付，核心包只保留协议无关的语义、路由和状态控制面。

实施状态：当前 checkout 已完成 C0～C6（Core v2、官方 Local、公开 Agent durable loop、v1 原子切换与 Phase 1 离线/进程恢复门禁），正在实施 C7 Worker/Process/HTTP placement；C8/C9、Docker live gate 与完整真实方舟验收仍未完成。下文“背景与现状”保留立项时的 v1 问题陈述，不代表当前源码仍存在这些旧接口。

## 背景与现状

当前实现位于 `packages/core/src/agent/index.ts` 与 `packages/core/src/agent/types.ts`，已经具备 manager-as-tool、每次创建全新子代理实例、父子上下文默认隔离、Chat/Responses 共用调度路径等基础能力，但存在以下生产阻断项：

- 子代理通过构造器静态 `name` 注册，公共类型只要求最小 `AgentInstance`，运行时却强制把它当成真实 `Agent` 子类动态继承，类型契约与实现假设不一致。
- 内置 `agent` Tool 只接收 `agentName`、字符串 `input` 与提示性质的 `outputDescription`，没有强类型输入输出契约。
- 模型可控的 `input` 与 `outputDescription` 被写入 child system prompt，形成不必要的提示词提权面。
- `agent-result` 可不调用或重复调用，后一次会覆盖前一次；`end-agent` 与结果提交之间没有持久化状态约束。
- 未知子代理、缺少结果和子代理异常最终都可能表现为普通 Tool 文本，父代理与宿主无法稳定区分成功、失败、取消或部分结果。
- 同一模型响应中的多个子代理 Tool call 当前逐个 `await`，与 Tool 描述中的并发承诺不一致。
- 没有 task ID、父子任务树、取消、超时、审批、恢复、并发池、共享预算或层级事件。
- 父代理仅把同一个 Model 传给子代理，其他配置需要子类自行重建；没有明确的 Executor 边界与远程执行扩展点。
- 核心单元测试没有覆盖 Subagent，最强验证依赖真实模型 demo。

## 业界基线

方案吸收以下公开实现的共同能力，但不照搬任一框架的 API：

- Claude Code：隔离子代理上下文、前台/后台任务、任务恢复、权限收窄和父子生命周期 hooks。
- OpenAI Agents SDK：manager-style agent-as-tool、类型化结果、HITL 中断/恢复与层级 tracing。
- LangChain/LangGraph：显式上下文投影、持久 checkpoint、interrupt/resume 和后台任务控制面。
- Google ADK：隔离 session branch、并行 workflow、取消信号和从已完成步骤恢复。
- AutoGen：有状态 Agent 实例不可并发复用、可组合终止条件与团队状态保存。

参考资料：

- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
- [OpenAI Agents SDK - Multi-agent orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/)
- [OpenAI Agents SDK - Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
- [OpenAI Agents SDK - Results](https://openai.github.io/openai-agents-js/guides/results/)
- [OpenAI Agents SDK - Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
- [LangChain Subagents](https://docs.langchain.com/oss/python/langchain/multi-agent/subagents)
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
- [Google ADK Workflows](https://adk.dev/workflows/)
- [AutoGen Teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)

## 已确认的设计决策

### 产品与兼容性边界

- 目标是分阶段交付的生产版 Subagent Runtime，而不是继续扩充当前同步 Tool helper。
- 直接发布 v2，不保留旧 `subAgents` shorthand、旧 Tool wire shape 或运行时兼容适配器。
- 保留两个独立完成 Tool：`agent-result` 提交强类型业务结果，`end-agent` 结束生命周期。
- Handoff 不属于本框架本轮或后续既定范围；v2 只实现“父 Agent 保持控制权、子任务返回结果”的 manager-as-tool 语义。

### Core 与 Executor 职责

- Core 负责 Subagent 定义、注册、模型可见目录、Executor 过滤与选择校验、任务状态机、会话绑定、预算、审批协调、事件和错误契约。
- Core 不执行具体 child Agent 循环，不拥有远程 transport、容器、队列或模型客户端。
- Executor 适配器完整承载 child task 的模型、Tools、Skills、上下文、checkpoint 与运行循环。
- 官方本地 Executor 独立成包；后续 Worker Thread、Child Process 与远程 Executor 继续以独立包或模板扩展。
- 定义采用 local-object-first，不强制函数、Zod schema 或本地 factory 可序列化。跨进程/远程执行通过 `definitionName + definitionVersion` 在目标 Executor 注册表中重新解析。
- 模型 active catalog 每个 definition name 只暴露一个 active version；恢复 registry 可以保留多个 `name + version`，历史版本不得自动进入模型目录或用于新 create。

### 选择、输入与结果

- 宿主注册 Executor 的名称、用途说明和能力集合。
- Core 按 Executor 当前可用性、定义允许名单和所需能力生成过滤后的目录；模型必须从目录中显式选择一个 Executor。
- Router 在执行前再次校验选择。Executor 不存在、暂不可用或被定义禁止时，返回结构化失败和刷新后的可选目录，不做任何隐式 fallback，也不创建任务。
- `SubAgentDefinition` 同时声明 Zod `inputSchema` 与 `outputSchema`。模型输入、程序化输入、远端入站与最终结果都必须在各自信任边界重新校验。
- 父代理传给子代理的是受 schema 约束的 task data，不进入 child system prompt。
- `agent-result` 只接受 `outputSchema` 对应的 payload，并以持久化 compare-and-set 语义 exactly-once 接受；重复提交不得覆盖第一次结果。
- `end-agent` 只有在有效结果已持久化后才能成功。结果已提交但尚未结束时发生失败、取消或崩溃，终态可以携带 partial output。
- task 进入 `result_submitted` 后，只允许 standalone `end-agent` 或完全相同的协议重放；普通 Tool、新审批和嵌套委派全部拒绝。

### 会话、身份与恢复

- Core 唯一稳定的访问归属标识是根 `sessionId`，不定义 `agentId`、principal、tenant 或用户身份。
- 每个子任务仍有框架生成的 `taskId`、`subagentSessionId` 和 operation `attempt`，根逻辑执行具有 `runId`；它们都是运行标识，不是新的访问主体。
- 根逻辑执行的 `runId` 在 pause/resume/reconnect 期间保持不变；嵌套 task 的 `ownerSessionId` 始终继承树根 `sessionId`。
- 所有 task 操作都绑定创建它的根 `sessionId`。只有同一个可信 session 上下文可以查询、等待、恢复、重连或取消任务。
- 新 ID 只能由 Core 或可信宿主创建，绝不作为模型 Tool 参数，也不能从 agent 文本中提取。
- 根 Agent 从持久化数据恢复时必须继续使用原 `sessionId`；换用新 session 等同于新的访问域，不能接管旧任务。
- Core 的 session 一致性检查不是身份认证。HTTP/RPC 层必须先完成自己的认证授权，再把可信 `sessionId` 传给 Core。
- Executor 必须声明恢复能力和所需恢复信息，并返回稳定 binding。内部操作明确区分 `create`、`resume` 和 `reconnect`。
- `resume(approval)` 继续 `waiting_approval`，`resume(checkpoint)` 从可重建 checkpoint 恢复失去 lease 的原 task；`reconnect` 只连接仍存在的外部 job。三者严格按 Executor capability 执行，都不能隐式创建新任务。
- 原 Executor、定义版本或 binding 不可用时返回明确错误。需要重新执行时必须显式创建新 task，并通过 `retryOf` 关联旧 task。

### 运行控制

- Executor 同时提供阻塞 `execute(): Promise<ExecutionOutcome>` 与非阻塞 `spawn(): TaskHandle`；Phase 1 的 `execute()` 只会返回终态或 `reason: approval` 的暂停结果，故障 checkpoint 仍保持原 task 为 `running + recoveryRequired`。
- 模型可见的内置 `agent` Tool 固定使用阻塞 `execute()`；宿主程序可以使用 `spawn()` 查询、监听、取消和恢复后台任务。
- 同一模型响应先按相对顺序完成全部普通 Tool，再一次性提交所有 `agent` calls；普通 Tool 与 Subagent 不重叠，Subagent 彼此由 Core 全局并发池和 Executor 调度，最终 Tool 结果按原协议 call 顺序回填。
- 默认 child 上下文完全隔离。只有定义显式提供 projector 时，才投影最小必要上下文；父 Tools、Skills、可变 app state 与完整消息历史都不自动传播。
- 嵌套委派默认关闭。定义显式配置 child-definition allowlist 后，Core 才提供固定根 session/run/parent/path/budget 的 task-scoped delegation client；自递归还需单独允许。
- 默认安全上限：`maxDepth = 3`、`maxDescendants = 32`、`maxConcurrent = 4`、每个 child `maxTurns = 16`、活跃执行超时 `timeoutMs = 120_000`。
- 同一定义递归默认禁止。显式允许递归后仍受深度、后代数、并发和共享预算约束。
- 请求次数、token 与费用预算属于根 session/run 的共享 ledger；子任务只能消费剩余额度，不能重置预算。
- `AbortSignal` 与 deadline 必须从 Core 贯穿 Executor、child runner、Model 和 Tool。task 持久化 active elapsed/remaining time，审批期间冻结 timeout，恢复时重新计算 operation deadline；取消或超时后必须释放队列槽并进入单一终态。

### 审批、事件与数据安全

- 审批决定只能来自可信宿主 API；模型文本、Tool 输出或子代理消息不能构成批准。
- 阻塞 child 的审批请求向上冒泡并暂停 root run；后台 `spawn()` task 只暂停自身。
- Executor 必须在危险 Tool handler 执行前 checkpoint pending call 并请求授权；收到 suspend directive 后不得执行 handler，只有恢复后持久 decision 为 approved 才能继续。
- 审批与结果提交都必须持久化，重复 resume 或网络重放不得重复接受同一决定或结果；外部 Tool 副作用仍由业务 idempotency key 约束。
- 事件至少带 `sessionId`、`runId`、`taskId`、`parentTaskId`、`path`、definition、executor、attempt 与 timestamp。
- 默认事件和错误不记录原始 prompt、Tool payload、结果正文、API key 或 `recoveryData`。需要诊断正文时由宿主显式 opt-in 并负责脱敏。

### 已冻结实施 Oracle

- canonical JSON 固定使用 RFC 8785/JCS；输入和输出默认各 256 KiB，投影默认最多 32 项、单项 64 KiB、合计 128 KiB。
- cancel、timeout、budget、result/end 与 approval expiry 竞争由第一个合法 revision/lease/fencing CAS 决定，终态不可逆；approval 仅在 `now < expiresAt` 时可批准。
- create 固定按 identity/input/hash -> run-scope idempotency lookup -> catalog/projector/limits/budget 执行；一致重放命中后不再执行后半段。
- `supports()`、availability、allowlist 与 capability 取保守交集；Runtime 只通过显式异步 `refreshCatalog()` 更新 snapshot/revision。
- retry 是 host-only 操作，只能指向同 definition name/version 的非成功终态；模型 wire 不包含 `taskId` 或 `retryOf`。
- `stream=true` 在创建 run/task 前以 `STREAMING_UNSUPPORTED` 失败；空模型目录时完全移除内置 `agent` Tool。
- public lookup/control 对未知资源和跨 session 统一返回 `RESOURCE_NOT_FOUND`；`SESSION_MISMATCH` 仅供已鉴权的内部诊断边界使用。
- provider 请求结果不确定时，原 task 进入 `failed` 并持久化 `outcomeUnknown=true`；禁止自动重发，只允许 host 显式 retry。
- `ArtifactReference` 仅包含版本、opaque ID、media type、字节数和 SHA-256；默认单件 32 MiB、每 task 8 件且合计 128 MiB，不包含路径、URL 或凭证。
- 完整 22 项状态、API、背压、迁移器和错误码 Oracle 以 [TEST_ACCEPTANCE_PLAN.md](./TEST_ACCEPTANCE_PLAN.md#18-已冻结的验收-oracle) 为准，编码不得重新解释。

## 目标公共行为

### 模型可见目录

模型只看到当前 definition 与 Executor 的可用组合，不看到本地 factory、binding、session ID、task ID、恢复数据或宿主权限对象。每条目录项包含：

- Subagent 稳定名称、版本、用途说明和输入说明。
- 当前允许且可用的 Executor 名称、用途和关键能力摘要。
- definition-specific 的 `inputSchema`。

内置 `agent` Tool 的概念参数调整为：

```ts
{
  subAgent: string;
  executor: string;
  input: unknown;
}
```

实际 Tool schema 按可用 definition 构建可判别联合；无论 provider 是否完整执行 JSON Schema，Router 都必须再次用对应 Zod schema 校验。

### 程序化入口

Core Runtime 对宿主提供与模型 Tool 一致的安全入口：

- `execute(request)`：阻塞到终态或审批暂停边界，供模型 Tool 与简单宿主调用。
- `spawn(request)`：立即返回 session-bound handle。
- `getTask(sessionId, taskId)` / `wait(...)`：读取或等待状态。
- `getSubAgentSession(sessionId, subagentSessionId)`：按根 session 作用域读取 child checkpoint/session 元数据。
- `cancel(sessionId, taskId, reason?)`：传播取消信号并持久化终态。
- `resume(sessionId, taskId, options?)`：提交审批决定，或按 capability 从原 checkpoint 继续。
- `reconnect(sessionId, taskId)`：使用原 binding 连接原 task。
- `events(sessionId, taskId)`：订阅已脱敏任务事件。

所有入口先执行 session 归属、definition version、Executor binding 和状态迁移校验，再调用适配器。

### 稳定任务状态

```text
queued -> running -> result_submitted -> succeeded
             |             |
             |             +-> failed | cancelled | timed_out | budget_exceeded
             +-> waiting_approval -> running
             +-> failed | cancelled | timed_out | budget_exceeded
```

`reconnect` / `resume` 是操作与事件，不额外引入可持久的 recovering 状态。终态不可逆；`result_submitted` 中保存的有效 output 不能被后续调用覆盖，并在非 `succeeded` 终态中作为 partial output 暴露。

## 实施阶段

### Phase 1：Core v2 与官方本地 Executor

交付内容：

- 新建 Core Subagent 模块：definition/registry、Executor contract/catalog、Router、task state machine、session guard、budget、approval、events、errors 与 store SPI。
- 替换内置 `agent` Tool wire shape；删除 legacy `subAgents`、`AgentConstructor` 和动态子类注入路径。
- 为根 Agent 增加稳定 session、可暂停 run、checkpoint/resume 以及 `AbortSignal` 传播。
- 父 Agent checkpoint 必须保存 pending Tool batch、原 call 顺序、已完成兄弟结果、未完成 task binding、open-loop revision 和共享预算，恢复时不得重复提交已完成 child。
- Agent 与 SubAgent Runtime 使用同一事务域的 StateStore；父 run checkpoint、child task CAS、幂等/child-session 索引、预算和事件必须原子提交，并由 lease/fencing 阻止旧进程推进。
- 让同一模型响应中的多个 Subagent 调用批量提交，并维持协议 Tool 结果顺序。
- 新建独立本地 Executor 包，提供本地 definition-to-factory registry、child Agent runner、并发队列、取消、审批、事件和 usage 汇总。
- 本地包提供内存 StateStore 与原子文件 StateStore。文件实现通过 revision CAS、lease 和 fencing 支持受控的单宿主进程重启恢复，不宣称支持多节点或网络文件系统一致性。
- 通过 definition name/version registry 在重建 Agent/Executor 后恢复任务；所有恢复路径执行相同的 session 与版本校验。
- 建立完全离线的 Subagent v2 单元、集成和 Executor conformance 测试。

Phase 1 退出标准：

- Chat 与 Responses mock 均能完成类型化父子调用，且不再要求同协议 child。
- 输入、输出、结果 exactly-once、两 Tool 完成顺序和 partial output 均有离线断言。
- `execute()`、`spawn()`、取消、超时、审批暂停/恢复、checkpoint resume、external reconnect、队列和并发限制通过测试。
- 同 session 恢复成功，跨 session、错 Executor、错 definition version、binding 缺失均确定失败。
- 文件 StateStore 通过独立 child process 的中断后恢复测试。
- 默认事件不泄露 payload 或 recovery data。

### Phase 2：进程隔离与远程 Executor 模板

交付内容：

- 新增 `@ruixutong.manee/maneeagent-executor-worker`、`@ruixutong.manee/maneeagent-executor-process` 与 `@ruixutong.manee/maneeagent-executor-http`，复用 Core conformance suite。
- 明确进程 IPC 协议、schema 重验证、signal/cancel 传播、进程退出分类和 artifact 引用。
- HTTP Remote Executor 包含外部认证接入点、心跳、重连、binding codec、幂等 create、状态轮询/事件流和错误脱敏；默认 transport authentication 固定为 TLS + HMAC-SHA256 v1（`keyId/timestamp/nonce/bodyDigest`、时钟窗口和分布式 replay cache），并允许宿主替换为企业 IAM verifier。
- 加入网络断开、迟到响应、重复请求、乱序事件与 Executor 暂不可用测试。

Phase 2 退出标准：

- Worker/Child Process 与本地 Executor 对同一合约测试产出一致状态和结果。
- 进程崩溃后使用原 task/binding 恢复，不产生重复 task。
- Remote 模板可以演示 create/reconnect/resume，但不包含 agent handoff 语义。

### Phase 3：分布式生产生态

交付内容：

- 新增 `@ruixutong.manee/maneeagent-state-postgres`、`@ruixutong.manee/maneeagent-executor-bullmq`、`@ruixutong.manee/maneeagent-executor-docker`、`@ruixutong.manee/maneeagent-artifact-s3` 与 `@ruixutong.manee/maneeagent-observability-otel`。
- PostgreSQL 是 task、lease、fencing 与 outbox 的唯一权威；Redis/BullMQ 仅投递和唤醒。Docker definition 只能绑定预注册 image digest/entrypoint，task 容器非 root、只读 rootfs、无 Docker socket 且默认无网络。
- Executor registry/discovery、健康状态缓存和版本协商。
- 多租户认证、授权、配额与审计由宿主/transport 层接入；Core 继续只识别可信 `sessionId`。
- 持久适配器通过统一 `KeyProvider` 做 AES-256-GCM 信封加密；S3-compatible artifact store 使用明文 SHA-256 校验、短时授权、orphan/retention 清理。Core 只提供稳定 telemetry sink，OpenTelemetry bridge 保持独立可选包。
- Docker Compose 验收栈固定包含 PostgreSQL、Redis、MinIO、HTTP/BullMQ worker、隔离 Docker Engine、controller 与故障代理。
- 故障注入、长时间运行、滚动升级、跨版本恢复和多节点一致性测试。

Phase 3 退出标准：

- 同一 conformance suite 可验证本地、进程与至少一个远程/队列 Executor。
- 生产适配器对认证、加密、幂等、重试、死信、观测和数据清理给出明确运维契约。
- 仍不引入 handoff；如果未来需要，应作为独立 RFC 评估主动 Agent 切换和对话归属。

## 迁移要求

这是一次显式的 v2 迁移，调用方需要完成以下替换：

| v1                                       | v2                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `AgentOptions.subAgents: [WorkerAgent]`  | 注册 `SubAgentDefinition`、Executor 与 Core Runtime                         |
| class `static name/description` 充当定义 | `defineSubAgent({ name, version, description, inputSchema, outputSchema })` |
| 父 Model 自动传给 child                  | Executor binding/factory 显式选择 child Model 与配置                        |
| `agentName`                              | `subAgent`                                                                  |
| 字符串 `input`                           | definition-specific 强类型 `input`                                          |
| `outputDescription`                      | definition 的固定 `outputSchema` 与输出说明                                 |
| 同协议 `AgentConstructor<P>`             | 协议无关 Executor 结果边界                                                  |
| 无 task identity 的字符串结果            | session-bound `SubAgentTaskResult<T>`                                       |
| 子代理自行重建限制                       | 根共享 limits/budget + Executor 强制执行                                    |

不得提供把旧构造器自动包进本地 Executor 的兼容层。迁移说明可以给出机械改写示例，但错误配置必须在编译期或 `init()` 阶段尽早失败。

## 测试计划

### Core 离线测试

- active definition name 唯一、recovery registry 多版本、空值、保留名、schema 和目录稳定排序。
- Executor 描述、能力过滤、definition allowlist、暂不可用、选择竞态和禁止 fallback。
- 模型 Tool 与程序化入口的输入 schema 校验，远端边界再次校验。
- 类型化输出、invalid output、缺少结果、callId + canonical hash 重放/冲突、结果持久化 CAS、result phase closed、partial output。
- `agent-result` 与 `end-agent` 的顺序、重复调用和 crash window。
- model callId/host requestId 幂等索引、create/resume/reconnect 分流、幂等重放、`retryOf` 同 definition version 的新 task 语义。
- 同 session 访问、跨 session 拒绝、根 session 恢复、definition version mismatch、Executor missing。
- 普通 Tool 与 Subagent 两阶段批处理、queue、并发上限、结果顺序、cancel、timeout freeze/resume、max turns、max depth、max descendants 和递归策略。
- 根共享 provider-call/token/cost budget 的消费与拒绝行为。
- 审批先 suspend 后执行、冒泡、批准、拒绝、过期、重复决定、后台 task 独立暂停和根 run durable resume。
- 默认上下文隔离、自定义 projector、父 Tools/Skills/app state 不隐式继承、nested delegation 默认关闭与显式 allowlist。
- StateStore createRun、跨 run/task transaction、幂等/child-session 索引、event cursor、lease renew/release 与 fencing。
- Chat/Responses Tool wire 与结果闭环；跨协议 child 通过协议中立结果工作。
- 事件层级、attempt、usage、错误因果链和默认脱敏。

### Executor conformance

能力相关用例按 descriptor 声明选择性启用，至少覆盖：

- `execute` 与 `spawn().wait()` 等价。
- create 幂等、handle status/wait/events/cancel 一致。
- approval、resume、reconnect、recovery capability 与 binding 字段完整性。
- 取消/超时后资源和并发槽清理。
- 终态不可逆，重复事件不改变最终结果。
- Executor 异常、进程退出和网络断开被映射为稳定 Core 错误，不泄露原始 provider body。

### 仓库回归

每个阶段至少运行：

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm demo
pnpm demo:chat
pnpm demo:finance-news:smoke
```

真实方舟验收继续 opt-in，不能进入默认测试：

```bash
pnpm demo:ark:subagent
pnpm demo:features:ark
```

真实验收需要同步迁移到 v2 Tool wire，并继续遵守现有 API 成本、调用次数和凭证安全边界。

## 文档交付

实现阶段必须同步更新：

- 根 `README.md`：workspace 新包、v2 定位、迁移入口、开发和 demo 命令。
- `packages/core/README.md`：完整 v2 API、任务状态、session/Executor/审批/恢复限制。
- `demo/README.md`：离线与真实模型 Subagent v2 验收、费用和故障定位。
- `AGENTS.md` 与 `CLAUDE.md`：仅在仓库结构、维护规则或文档路由发生变化时更新其受管块。
- 新 Executor 包自己的 README：能力声明、StateStore 边界、恢复语义、安全限制和 conformance 结果。

## 非目标

- 不实现 conversation handoff、active-agent 切换或去中心化 agent-to-agent 对话。
- 不在 Core 内实现云厂商 SDK、消息队列、容器编排、认证系统或租户模型。
- 不自动把任意本地 factory/Zod schema 序列化到远程节点。
- 不承诺任意 Tool 副作用 exactly-once；框架只保证 `agent-result` 接受与任务状态转换的 exactly-once。外部副作用仍需 Tool/Executor 使用 idempotency key。
- 不让 sessionId 替代 HTTP/RPC 认证，也不把模型选择的 Executor 当成授权决定。
- Phase 1 文件 StateStore 不承担通用多写者 workload 或多节点一致性，但必须支持同宿主 failover 争抢，并保证只有最新 lease/fencing owner 可以推进。

## 假设与待实施时确认项

以下项目已冻结，不再留给实施者命名或行为决策：

- 官方本地 Executor 的 workspace 为 `packages/executor-local`，npm 包名为 `@ruixutong.manee/maneeagent-executor-local`。
- Core 新模块暂定放在 `packages/core/src/subagent/`；实际拆文件时可按现有导出风格微调，但不能把 concrete Executor 重新塞回 Core。
- token/cost budget 只有在 Model/Executor 能提供可信 usage 时才能硬执行；无法计量的 Executor 必须在 descriptor 中声明，宿主可以据此禁用它。
- 原子文件 StateStore 面向单宿主与重启恢复；允许受控 failover 争抢 lease，但不支持长期多写者或网络文件系统 workload，后者需使用 Phase 3 的数据库/队列实现。
- definition version 使用宿主维护的不透明非空字符串；恢复时要求精确匹配，不在 Core 内推断 semver 兼容性。
- Core 与 Phase 1/2/3 的所有公开包统一使用 `2.0.0` 首发版本；内部 workspace 依赖使用 `workspace:^`。
- 正式发布证据固定使用 Node.js 22 与 `pnpm@11.1.3`：Windows bootstrap 下载便携 Node 并核验官方 SHA-256，Linux 使用固定 digest 的 Node 22 acceptance 镜像。

更细的接口、状态、不变量与文件级改造见 [TECHNICAL_CHANGES.md](./TECHNICAL_CHANGES.md)，分层测试、故障注入与真实方舟 Agent Plan 发布门禁见 [TEST_ACCEPTANCE_PLAN.md](./TEST_ACCEPTANCE_PLAN.md)。
