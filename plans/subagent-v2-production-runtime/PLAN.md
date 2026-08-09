# Subagent v2 生产运行时改造计划

## 摘要

将当前“父 Agent 通过内置 `agent` Tool 同步实例化同协议子类”的实现，直接升级为面向生产环境的 Subagent v2。v2 把子代理定义、任务状态、Executor 选择、会话归属、审批、恢复、预算和可观测性提升为稳定公共契约；具体子代理循环、模型、Tool 与运行环境全部交给外部 Executor 适配器执行。

本次是明确的 2.0 breaking change：删除旧 `AgentOptions.subAgents`、`AgentConstructor`、动态 `RuntimeSubAgent` 和旧 `agentName/input/outputDescription` Tool 协议，不提供兼容适配层。官方本地 Executor 作为独立 workspace 包交付，核心包只保留协议无关的语义、路由和状态控制面。

实施状态：当前 checkout 已完成 C0～C6（Core v2、官方 Local、公开 Agent durable loop、v1 原子切换与 Phase 1 离线/进程恢复门禁），并交付 C7a/C7b、C7c-1 的 Core transport/RPC/control/Peer/artifact-sidecar、target registry、controller/target bridge 与 controller-owned Model gateway、C7c-2/C7c-3 的离线 Worker/Process placement、C7c-4 的 HTTP signed multipart/HMAC/replay/authz 安全基础、C7c-5a 的 Core 同进程 external reconnect 前置、C7c-5b 的 closed poll command/route↔RPC policy/semantic packet receipt、C7c-5c 的原子 create/replay Job Store 地基，以及 C7c-5d-a 的 Store IO context 与 current-attachment delivery/ACK/wait Memory ledger。Core 前置只允许显式 opt-in 的 target bridge 在 fresh trusted channel 上，从 controller-ACK 且 placement 已提交的 checkpoint 替换当前进程内 resident runner；HTTP Store 只在 create record 已固定的初始 Core channel/generation 内提供有界 outbound enqueue、单包 offer、精确 ACK 与 change wait，不开放 attachment rotate，也没有 response codec、production durable adapter 或完整 job lifecycle。两者都不是 production durable HTTP job、跨 bridge/process restore 或完整 reconnect。`C7-WORKER`、`C7-PROCESS`、`C7-HTTP` 与 `C7-AUTH` requirement 仍保持 `planned`：当前只有相应 L1～L4 或 L1/L2 离线 acceptance，L5 真实方舟 placement 与 L6/Docker/Linux live gate 尚未完成；HTTP Executor、production durable Store、delivery response、attachment recovery、listener、heartbeat 与 durable reconnect 仍待 C7c-5 后续批次，因此 Phase 2 仍未通过。C8/C9 与完整真实方舟验收仍未完成。下文“背景与现状”保留立项时的 v1 问题陈述，不代表当前源码仍存在这些旧接口。

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
- Core 不执行具体 child Agent 循环，也不拥有 Worker/Process/HTTP endpoint、认证、部署 transport、容器、队列或模型客户端；Core 只提供 placement-neutral 的 transport/RPC/Peer contract。
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

当前增量状态：Core 已公开 closed transport v1、14-kind strict RPC、16-method control dispatcher/proxy、双向 Peer、canonical replay、同步 writer admission、带 settlement headroom 的 channel rollover、spawn 的 accepted-or-direct-unbound 生命周期、有界 abort tombstone、默认 32 MiB artifact sidecar、target registry、controller/target bridge 与 controller-owned Model gateway。`reconstructSubAgentExecutionRequest()` 返回 `{ request, dispose }`，placement adapter 必须在 settle 后清理接收端 timer/listener。Remote proxy 暂不提供 artifact `put`。在这套地基上，C7c-2/C7c-3 已分别交付真实 `worker_threads` 和真实 Node.js `child_process` placement：两者都使用静态受信 target、controller-owned Model gateway、cancel/强制终止、checkpoint 恢复、F08/F09/F19 故障窗和有界资源清理；Worker 使用 transferable sidecar，Process 使用 advanced-serialization owned `Uint8Array`、最小环境、受控 stdio 及 exit/close/orphan 分类。C7c-4 又交付 HTTP 单包 multipart、HMAC-SHA256 v1、replay cache SPI、owner scope authorization 和脱敏 admission；C7c-5b 再交付无副作用的 poll command codec、route↔strict RPC policy 与 semantic packet receipt；C7c-5c 进一步交付三索引原子 create/replay、scoped load、最小 pre-authorization owner lookup 与同时按 job 数/协议保留 bytes 有界的 loopback-test Memory Store；C7c-5d-a 又在该 Store 上加入 caller-local IO context，以及仅限 create record 初始 attachment 的 outbound delivery enqueue、单包 offer、精确 ACK、response-loss replay和有界 wait。它仍没有实现 Executor、response wire、production durable Store 或网络/job 生命周期。Core 还先行交付了显式 opt-in、仅同一 target bridge 进程内生效的 external reconnect 基础：trusted channel resolver、controller-ACK checkpoint commit hook、全 exchange 串行/gap、soft quiesce、fresh-channel fencing 与 detached retry；它不提供 durable job/spool、Peer pending import 或 target 进程重建。`C7-WORKER`、`C7-PROCESS`、`C7-HTTP` 与 `C7-AUTH` requirement 因缺少对应 L5/L6/Ark 或完整 placement 证据仍为 `planned`；HTTP Executor、production durable Store、delivery response、attachment recovery、listener、heartbeat 与 durable reconnect 仍是 Phase 2 待交付内容。

#### C7c 实施前冻结决策（C7c-1～C7c-4、Core reconnect 前置与 C7c-5b/C7c-5c/C7c-5d-a 基础已实现，其余待交付）

以下决策是 Worker、Process 与 HTTP placement 开工前的固定 Oracle。当前 checkout 已具备 C7c-1 的 Core bridge/Model gateway 地基、C7c-2/C7c-3 的离线 Worker/Process placement、C7c-4 的 HTTP wire-security、C7c-5b 的 poll/route/receipt wire 基础、C7c-5c 的 create/replay Store、C7c-5d-a 的 current-attachment delivery Store，以及只覆盖进程内 resident runner replacement 的 Core reconnect 前置；这不表示两种本地 placement 的 L5/L6/Ark requirement 已通过，也不表示已经具备 HTTP Executor、production durable Store、delivery response、attachment recovery 或 durable reconnect 生命周期。在 C7c 全部门禁通过前，Phase 2 状态仍为未完成：

- Core 新增受信任的 target registry，按精确的 `definition name + definition version + runner identity` 解析 target-local child runner factory、schema/codec 与模型绑定。registry 在 `init()` 时拒绝重复或不完整条目，并生成不可变 snapshot；factory、Zod object、模块路径、环境变量与凭证都不能来自 wire，也不能在目标侧做动态加载或版本 fallback。
- Core 提供一对 placement-neutral controller/target bridge。controller bridge 把 `SubAgentExecutor` 的 execute/spawn/control 操作接入现有 Peer/RPC，并托管反向 control 与 Model gateway；target bridge 只在完整解码、scope 校验和 registry 命中后重建 execution request、创建独立 child runner，并在唯一 settle 路径的 `finally` 中调用 `dispose()`。target bridge 默认拒绝 live reconnect；显式 `external_binding` opt-in 必须提供 durable/fencing-aware checkpoint commit hook，并只允许不同的 trusted channel 在完整排空旧 mutating control/checkpoint 与 provider Model exchange 后从最后 committed checkpoint 替换同进程 runner。Worker、Process、HTTP 包只负责各自的 I/O、生命周期与认证，不复制 Core 状态机、RPC union 或 control dispatcher。
- control dispatcher 不再依赖单个 channel 内的临时 `Map` 保存 nested task handle，而是注入 session-scoped task handle registry。registry 以 `ownerSessionId + parentTaskId + childTaskId` 为可信索引，支持 register、resolve 与 terminal release；handle 本身不序列化。Worker/Process 可以使用进程生命周期内的内存实现，HTTP 必须通过 controller 的 authoritative Runtime 懒解析旧 handle，使新 channel 上的 reconnect/control 不依赖旧 dispatcher 对象。
- strict RPC vocabulary 从 12 kind 精确扩展为 14 kind，只新增 `model.request` 与 `model.reply`；既有 12 kind 的 wire 和 16 个 control method 均不改变。`model.request` 携带稳定 `providerOperationId`、受信模型 binding、协议/codec 版本、JSON-safe generate request 与 `remainingMs`；`model.reply` 用同一 ID 返回已归一化的成功结果/usage，或白名单失败与 `outcomeUnknown`。SDK client、HTTP headers/body、原始 provider wrapper、stack、credential 与任意非 JSON-safe 对象都不可进入该 RPC。
- `providerOperationId` 在首次 provider dispatch 前生成并随 child checkpoint/controller ledger 持久化；同一 ID 加相同 canonical request 只可取回原 reservation、在途状态或已缓存 reply，同一 ID 不同语义立即冲突。controller 必须先用 durable CAS 把 operation 置为 `in_flight`，随后才可调用 SDK create；只要恢复时 authoritative ledger 仍停留在 `in_flight`，无论 crash 发生在 SDK create 之前还是之后，都固定把原 task 标记为 `outcomeUnknown` 并禁止自动重发。controller 对一个 ID 最多启动一次 SDK create；transport 重放、channel reconnect、进程重建和 timeout 都不得生成新 ID 或自动再次请求 provider。
- 真实方舟 adapter 与 call/token ledger 只存在于 controller，`ARK_API_KEY` 只保留在 controller 内存。key 不进入 Worker/Process/HTTP target 的 env、argv、workerData、IPC/RPC、binding、job store、checkpoint、日志、错误或 artifact；target child 只能使用注入的 Model proxy 经 `model.request` 请求 controller。
- external reconnect 只允许接回仍存在、没有未决 provider 调用的 HTTP job。Core 前置只解决同一 bridge 内 runner replacement：checkpoint reply-loss/timeout/持久化失败会留下不可回退的 gap，旧 channel 的 cancel/snapshot/events/settlement 被 fresh channel fencing，factory/deadline 失败只保留 detached recovery slot而不新建 task。target 对每个 `providerOperationId` 强制 single-flight；Model packet 已同步 admission 但没有完整 correlated reply 时，只允许相同 ID 与重新计算后相同的 canonical request hash 查询 controller 的原 durable result，不同语义、伪造 hash、runner 带未决结果 settle 或权威 `outcomeUnknown` 都 fail closed。HTTP 仍必须另外提供 durable job/spool、channel generation、attachment/store CAS 和跨进程 restore。若 controller 已把 `model.request` 标记为 provider in-flight，但连接丢失前没有持久化归一化 `model.reply`，原 task 固定失败为 `EXECUTOR_FAILED + outcomeUnknown=true`，禁止 reconnect/resume/自动重发；若 reply 已持久化，则新 channel 只能重放同一 reply，不能产生第二次 SDK dispatch。Worker/Process 的 `reconnect` 仍固定为 `none`。
- HTTP 每个 Peer packet 使用一次 signed `multipart/mixed` POST：首 part 的 `Content-Type` 固定为 `application/vnd.maneeagent.packet+json`，body 是且只能是 closed JSON `{ "version": "1", "frame": string, "sidecars": [...] }`；`frame` 是已经序列化的 RPC 字符串而不是嵌套 object。随后严格按 `sidecars` descriptor 顺序放置 binary parts；不提供独立 unsigned sidecar route，也不把 bytes base64 放入 JSON。单件上限 32 MiB、每 packet 最多 8 件且合计 128 MiB。handler 必须先完整校验 multipart 结构、part 顺序、数量、长度、SHA-256、packet scope 与全部 owned-copy 边界，再把一个完整 packet 交给 Peer；任一 part 或认证失败都必须零调用 Peer、零 stage、零部分可见副作用。
- HTTP HMAC-SHA256 v1 固定使用六个 header：`Manee-Auth-Version: 1`、`Manee-Key-Id`、`Manee-Timestamp`、`Manee-Nonce`、`Manee-Body-SHA256`、`Manee-Signature`。canonical UTF-8 signing string 精确为 `MANEE-HMAC-SHA256-V1\n${keyId}\n${timestamp}\n${nonce}\n${METHOD}\n${path}\n${bodyDigest}`，末尾没有 LF；其中 method 必须 uppercase，path 使用 raw request path 且请求到达 verifier 时就必须已经是唯一 canonical form，verifier 不做 decode、normalize 或 re-encode，timestamp 是 Unix 毫秒，body digest 是完整 multipart 原始 bytes 的 lowercase SHA-256。raw request path 禁止 query、fragment、百分号编码、反斜线、`.`/`..` segment、重复斜线和尾斜线；redirect 一律拒绝。Node.js 22 的 llhttp 会在 `IncomingMessage.rawHeaders` 暴露 value 前去掉外围 OWS，因此生产边界把外围 OWS 视为 HTTP 等价；仍须利用 `rawHeaders` 拒绝重复、合并多值、空值、内部空白和控制字符。
- HMAC key 至少 32 bytes；nonce 是无 padding base64url，解码后 16～64 bytes；signature 解码后必须正好 32 bytes 并做 constant-time compare。默认时钟窗口为 `±60s` 且两端边界有效，原子 `ReplayCache.consume(keyId, nonce, expiresAt)` 的 TTL 固定为 120 秒。版本、key、时间、nonce、body digest、签名或 replay 任一认证失败都返回相同的安全 401，不泄露命中阶段；生产 handler 必须使用分布式 replay cache，内存实现只允许显式 loopback/test。认证与重放通过后，handler 无业务副作用地完整解码 signed multipart，再由 route、packet 或受信 job state 解析 owner scope，并独立调用 `authorize(authContext, { ownerSessionId, method, routeId })`；这里的 `method` 是 canonical HTTP `POST`，endpoint 权限由 `routeId` 表示。已交付的 closed route policy 在 Peer/Core 前把 route 约束到 strict RPC kind/operation/mode。heartbeat 不是第 15 种 Core RPC，也不经过 packet admission，而是在后续 endpoint handler 中以 `ownerSessionId = null` 授权。`sessionId` 不是认证凭据。
- poll transport command 固定为精确 `application/vnd.maneeagent.poll+json` 与最大 4 KiB 的 closed `{version:'1',channelId,channelGeneration,ackCursor,waitMs}` JSON；generation/cursor 是 canonical decimal uint64，`waitMs` 为 `0..10000`。它只承载 signed transport intent，不调用 Peer、不查找 job、不推进 ACK。remote delivery cursor、Core task-event sequence 与 Peer sequence 是三个独立域。
- route↔RPC policy 固定为：heartbeat 无 packet；create/resume/reconnect 分别只接收 operation/mode 精确匹配的 `executor.request`；cancel 只接收 `cancel.request`；poll multipart 只接收 `snapshot.request|events.request`；control-reply 只接收 `control.reply|model.reply|events.page|protocol.error` 且 path requestId 等于 correlationId。semantic packet receipt 保留 route kind/job、RPC kind/task/operation/payload 与排序后的 sidecar descriptor，排除 HMAC、multipart boundary、Peer identity/correlation 和 control path requestId；它不是 delivery ACK 或 job idempotency store。
- current-attachment delivery Store 只接受 5c create record 固定的 Core `channelId` 与 `channelGeneration='0'`。outbound packet receipt 保留完整 Core channel/sequence/message/correlation identity，并按独立 message 与 sequence 索引锁定 target→controller 连续顺序；remote cursor 仅用于 Store offer/ACK。每次 poll 最多 offer 一包，重复 current ACK 稳定重放同一 offer，只有精确 offered cursor 可原子确认并取下一包；ACK 后释放完整 packet retained bytes、归零 mutable sidecar 并保留 bounded compact receipt。wait 只观察 revision，必须无 lost wake 且在 timeout/abort/deadline/dispose 后清零本地资源。
- 5d-a 不开放 attachment/generation rotate。旧 Core packet 已把 channel、sequence、message 与 correlation identity 写入 frame，而当前 Peer 不导出 pending/sequence state；因此旧 raw packet 不能交给 fresh Peer，也不能在没有 authoritative checkpoint/terminal/provider proof 时丢弃。后续 attachment recovery 必须和 Peer rebase/import 或等价 authoritative semantic recovery 同批设计，不能由任意 Store CAS/force flag绕过。
- 包边界固定如下：`@ruixutong.manee/maneeagent-executor-worker` 只实现 `worker_threads`、transferable `ArrayBuffer`、每 task 一个受信 Worker、最小环境/`execArgv: []`、cancel/terminate 与 `reconnect=none`；`@ruixutong.manee/maneeagent-executor-process` 只实现 `child_process` advanced serialization、受限 stdio/env、cancel/kill/exit/close 分类、孤儿清理与 `reconnect=none`；`@ruixutong.manee/maneeagent-executor-http` 实现 signed multipart client/server、heartbeat、binding codec、幂等 job、event cursor、approval/resume/external reconnect、HMAC/authz 与 safe error mapping。三包都通过 Core target registry/bridge 运行受信条目，不携带方舟 key，不实现 handoff，也不相互依赖。

#### C7c 稳定提交拆分

C7c 只按以下可独立回滚、可通过对应门禁的提交推进；任何中间提交都不得把 Phase 2 或尚未完成的包写成已交付：

1. **C7c-1 Core bridge 与 Model gateway**：target registry、controller/target bridge、session-scoped task handle registry、12→14 kind RPC、可执行的 controller Model gateway，以及 authoritative provider-operation ledger 必须在同一稳定批次交付；ledger 锁定 reservation/`in_flight`/settled/`outcomeUnknown` 状态、canonical request 幂等、reply cache 与 target checkpoint ACK。codec/golden/type/pack、checkpoint ACK、幂等重放和 `in_flight` 在 SDK create 前后崩溃的故障测试全部通过后，Worker placement 才可以依赖该地基；既有 12 kind 与 16 control method 保持兼容。
2. **C7c-2 Worker placement（离线实现已交付）**：新增 Worker 包、target bootstrap、transferable sidecar、cancel/terminate/cleanup、crash/checkpoint oracle 与无网络 conformance；包内 `reconnect=none`。当前 `C7-WORKER-01`～`C7-WORKER-29` 只关闭离线子集，完整 requirement 继续等待 L5/L6/Ark 证据。
3. **C7c-3 Process placement（离线实现已交付）**：新增 Process 包、advanced serialization、env/argv/stdio 边界、cancel/kill/exit/close、孤儿 watchdog、F08/F09/F19 与资源清理测试；包内 `reconnect=none`。完整 requirement 继续等待 L5/L6/Ark 证据。
4. **C7c-4 HTTP wire security（离线实现已交付）**：已独立交付 signed multipart codec、完整包全验后准入、HMAC 六 header、path/time/nonce/replay/authz 正反例；`C7C-HTTP-MP01`～`MP05` 与 `AUTH01`～`AUTH07` 只关闭 L1/L2 安全基础，该提交不宣称 remote job 生命周期完成。
5. **C7c-5a Core external reconnect 前置（已交付）**：target handler 使用 trusted channel identity；显式 opt-in bridge 只从 controller-ACK 且 placement 已提交的 checkpoint 恢复同一进程 resident task，并锁定 full-exchange ordering/gap、Model single-flight/outcome-unknown、soft quiesce、fresh-channel fencing、detached retry、旧异步 reply 与 factory deadline。该提交不声明 HTTP job、bridge/process restart、Peer pending restore 或跨 replica recovery。
6. **C7c-5b HTTP poll/route/receipt wire 基础（已交付）**：新增 closed poll codec、canonical uint64 cursor/generation、route↔RPC policy 与 semantic packet receipt；本批只登记 L1 wire evidence，不创建 listener/job/store/delivery 或 Peer 副作用。
7. **C7c-5c HTTP create/replay Store 地基（已交付）**：新增 closed create identity/record、create-key/principal-job/logical-task 三索引原子 create/replay、full-scope load、最小 pre-authorization owner lookup，以及同时按 job 数和 protocol-retained bytes 有界的显式 loopback-test Memory Store；首次 `remainingMs` 是不可扩张 ceiling，replay 不刷新 timestamp/packet/revision。该批只登记 L1/L2 Store foundation，不暴露任意 CAS，不创建 delivery/spool/wait/listener/Peer 副作用，也不声明 production durable adapter。
8. **C7c-5d-a HTTP current-attachment delivery Store（已交付）**：为 Store I/O 增加 caller-local signal/deadline，并在 create record 的初始 channel/generation 上实现 strict outbound packet receipt、message/sequence replay fence、独立 remote cursor、单包 offer、精确 ACK、compact receipt 与有界 wait。显式 loopback-test Memory 实现同时限制 delivery count/bytes、receipt 与 waiter；本批不创建 response wire、production adapter、attachment rotate、listener 或 Peer 副作用。
9. **C7c-5d-b 及后续 HTTP placement**：新增 closed delivery response codec与真实 semantic response correlation；只有 authoritative checkpoint/terminal/provider proof 和 Peer pending/rebase 设计闭合后才新增 attachment/generation recovery mutation。随后实现 production durable Store、HTTP client/server、target registry、authoritative handle resolution、heartbeat、approval/resume/external reconnect 与 provider in-flight fail-closed 故障注入。
10. **C7c-6 Phase 2 release gate**：补齐三个公开包的 README/manifest/pack、根文档、离线 Phase 2 acceptance 和独立 Ark placement profiles；只有固定 clean SHA 的全部离线门禁通过且真实 profile 有合规 evidence 时，才分别记录对应通过状态。缺少 Docker 或 `ARK_API_KEY` 时继续如实记录未执行，不能用 Core unit test 替代。

每个提交先运行受影响包的 unit/type/lint/build/conformance，再运行仓库 `format:check`、`typecheck`、`lint`、`build` 与默认离线 `test`；通过后单独提交并推送当前分支，失败只追加修复提交，不改写历史。

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
