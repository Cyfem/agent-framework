# Subagent v2 测试与真实方舟 Agent Plan 验收计划

## 1. 文档状态

- 设计状态：验收方案，随 [PLAN.md](./PLAN.md) 与 [TECHNICAL_CHANGES.md](./TECHNICAL_CHANGES.md) 一起作为 Subagent v2 实施基线。
- 当前实现状态：当前 checkout 已完成 C0～C6 的 Core v2、官方 Local、公开 Agent durable loop、Phase 1 离线/进程恢复证据，以及 C7a/C7b/C7c-1 的 Core transport/RPC/control/Peer/artifact-sidecar、target registry、controller/target bridge、controller-owned Model gateway、C7c-2/C7c-3 离线 Worker/Process placement、C7c-4 HTTP wire-security、C7c-5b poll/route/receipt wire 基础、C7c-5c create/replay Store、C7c-5d-a current-attachment delivery/ACK/wait Store 地基、C7c-5d-b closed poll delivery response wire 和仅同进程 resident task 生效的 Core external reconnect 前置。`C7-WORKER`、`C7-PROCESS`、`C7-HTTP` 与 `C7-AUTH` requirement 因缺少 L5/L6/Ark 或完整 placement 证据仍为 `planned`；HTTP Executor、production durable Store、response authentication/真实网络交付、attachment recovery、listener/heartbeat/durable reconnect 尚未交付，Phase 2 未通过，C8/C9 与 Docker/Linux/真实方舟最终证据仍是待交付要求。
- 目标范围：Phase 1 Core/Local、Phase 2 Worker/Process/HTTP Remote、Phase 3 PostgreSQL/BullMQ/Docker/S3/OTel、Compose，以及完整离线与真实方舟验收。
- 目标版本：所有公开包统一 `2.0.0`；不为 v1 legacy Subagent 提供兼容验收。
- 明确排除：conversation handoff、active-agent 所有权转移、Windows/Electron 桌面交互、任意云厂商 transport 的产品化实现。

本文件只定义如何证明两份设计已经正确落地。若本文件与前两份设计的公共语义冲突，以 `PLAN.md` 和 `TECHNICAL_CHANGES.md` 为准，并先修订设计再实现测试，不能通过放宽断言绕过冲突。

## 2. 验收目标

Subagent v2 只有同时满足以下三类证据才可发布：

1. **确定性正确性**：用纯离线状态、协议 fixture、Executor conformance、独立进程和故障注入证明 schema、状态机、CAS、WAL、lease/fencing、幂等、审批和恢复不变量。
2. **真实模型可用性**：用真实方舟 Agent Plan 的 Chat Completions 与 Responses 验证模型能理解动态目录、显式选择 Executor、按 v2 Tool wire 委派、跨协议取得类型化结果，并在审批恢复后继续原任务。
3. **仓库交付完整性**：类型、包边界、发布产物、demo、文档、默认无凭证门禁和安全日志全部与 v2 事实一致。

“真实方舟完整验收”不等于把所有断言都交给 LLM。真实模型无法稳定制造 CAS 冲突、旧 fencing owner、WAL 半提交或恶意协议重放，也不能成为这些不变量的可靠 oracle。因此：

- 所有模型可见、用户可见和跨协议场景都必须经过真实方舟。
- 所有存储、安全、竞态和故障窗口都必须经过确定性测试。
- 两类门禁都通过才算完整验收；任何一类都不能替代另一类。

## 3. 当前仓库基线

当前 checkout 有以下可复用事实：

- Core、Local、Worker、Process 与 HTTP 待发布包统一为 `2.0.0`；v1 `subAgents`、`AgentConstructor`、动态 `RuntimeSubAgent` 与旧模型 wire 已由 legacy 门禁禁止。
- 根 `pnpm test` 显式组合 Core、Local、Worker、Process、HTTP security 默认 unit/conformance 和 5 个 Local Windows 进程恢复用例，默认无 API key、网络访问或真实费用；Vitest 统一使用 Node 环境、network deny setup 与 2023-11 decorators transform。真实 `worker_threads` 与 `child_process` crash/lifecycle 用例分别由 `pnpm acceptance:subagent:v2:worker:offline` 和 `pnpm acceptance:subagent:v2:process:offline` 独立 shard 执行，不混入默认测试。
- Phase 1 manifest 当前覆盖 Core/Local、跨协议、审批、上下文压缩、provider intent、tree budget、lease/fencing、Atomic File WAL 和 process-crash recovery；具体 case 数与 digest 以每次 `pnpm validate:subagent:v2:manifest` 输出为准。
- `pnpm demo:features:ark` 已迁移到 v2 Local Runtime，继续复用配置加载、Observed Model、严格序列、marker、Skills fixture、压缩断言和白名单日志；它不会进入默认 `pnpm test`。
- `pnpm demo:ark:subagent` 继续作为独立真实模型 smoke，但不替代完整 v2 manifest、placement profile 或离线竞态证据。
- C7 Core 已有 closed transport、strict RPC/control、双向 Peer、replay/rollover、artifact sidecar 和 process-local external reconnect 前置的 L1/L2 测试；前四项已有 manifest 映射，reconnect 前置作为 C7c-5 内部 prerequisite 单独回归。Worker 与 Process 包及其离线 acceptance 已交付，HTTP 包的 multipart/HMAC/replay/authz、poll/route/receipt wire、create/replay Store、current-attachment delivery/ACK/wait Store 与 closed poll delivery response L1/L2 基础也已交付。Worker/Process 仍缺 L5 真实方舟 placement 与 L6/Docker/Linux live gate，HTTP 仍缺 Executor、production durable Store、response authentication/真实网络交付、attachment recovery、listener/heartbeat/durable reconnect、L5/L6，不能把 manifest 的 `C7-WORKER`、`C7-PROCESS`、`C7-HTTP` 或 `C7-AUTH` requirement 改为 implemented。C8/C9 的 PostgreSQL、BullMQ、Docker、S3、OTel、Compose 与 release report 同样不能由这些离线证据代替。
- 当前环境未具备 Docker live gate；没有显式方舟凭证和调用确认时也不运行真实 provider 验收。

## 4. 验收原则

### 4.1 Oracle 原则

- 业务通过与否以 Runtime、StateStore、事件、handler 计数和协议消息断言为准，不以模型自然语言自述为准。
- 真实模型每一步必须返回预期 Tool call；跳步、重复、额外 prose、错误 Executor、错误参数或超出调用预算立即判定该场景失败。
- 负向 schema、重放和竞态场景使用 scripted Model/Executor 或测试控制面精确注入；不依赖提示模型“故意出错”。
- 所有真实场景使用固定 proof marker 和精确类型化 output，不做语义相似度判断。
- 协议断言检查真实 Chat/Responses adapter 生成和解析的 wire，不直接伪造父 Tool result 绕过 adapter。

### 4.2 幂等与故障原则

- 每个故障注入点都必须证明：没有重复 task/handler/结果/审批，状态和事件没有半提交，恢复没有创建替代 task/job 或 fallback。唯一例外是 binding 尚未持久化时，可以用同一 idempotency key 重放原 create operation 取回同一个 job/binding；它不是业务 retry。
- 所有时间相关用例使用可控时钟；所有 ID 相关用例使用可控高熵 ID factory 或确定性测试 ID。
- 所有并发用例使用 barrier/deferred 精确控制顺序，不用不稳定的 `setTimeout` 猜测竞态。
- 测试私有 failpoint 通过构造依赖或内部 adapter 注入，不加入包根公共 API，不依赖修改私有字段或全局 monkey patch。
- 真正的进程崩溃由专用 worker 在指定 failpoint 主动退出；父测试进程只读验收产物并重建 Runtime。

### 4.3 Provider 用量与凭证原则

- 默认 `pnpm test` 和所有离线门禁不读取 `ARK_API_KEY`、不访问网络、不产生模型费用。
- 真实方舟命令保持 opt-in；每个 profile 必须用 CLI 精确确认灾损调用硬上限。
- provider 调用在发出请求前原子预留预算，失败请求同样占用次数；SDK 和框架都不得自动重试。
- API key、prompt、完整上下文、Tool payload、output、binding、recoveryData、headers、provider body/message 永不写入验收日志或产物。
- Skill script 只运行仓库内固定、可审计的 fixture。它运行在宿主 Node.js、继承宿主环境且不受沙箱保护；运行 full profile 即表示操作者信任该 fixture。

## 5. 验收分层与发布门禁

| 层级                    | 目的                                                    | 模型/环境                        | Phase 1            | Phase 2/3                   |
| ----------------------- | ------------------------------------------------------- | -------------------------------- | ------------------ | --------------------------- |
| L0 静态契约             | 类型、导出、breaking 删除、依赖方向、pack               | TypeScript/build                 | 必须               | 必须                        |
| L1 Core 确定性测试      | 定义、Router、状态机、CAS、审批、预算、安全反例         | scripted Model/Executor          | 必须               | 必须回归                    |
| L2 Executor conformance | execute/spawn/handle/capability/错误统一语义            | 参数化 fake/具体 Executor        | Local 必须         | 每个 Executor 必须          |
| L3 进程与持久化故障     | File Store、WAL、lease/fencing、父批次恢复              | 独立 Node 进程                   | 必须               | 必须扩展                    |
| L4 协议适配集成         | Chat/Responses 四象限、批处理、callId 与 signal         | 真实 adapter + scripted provider | 必须               | 必须回归                    |
| L5 方舟 Agent Plan      | 真实目录理解、Executor 选择、跨协议、审批恢复、综合能力 | 真实付费 API                     | 发布前必须显式执行 | 每个新 placement 至少 smoke |
| L6 远程/分布式混沌      | IPC、网络、重复乱序、滚动升级、多节点 fencing           | process/loopback/生产 adapter    | 不适用             | 对应阶段必须                |

阶段退出规则：

- **Phase 1**：L0-L4 全绿；Memory/File Store conformance 与进程恢复全绿；L5 smoke 和 full 各有一次当前 release candidate 的成功证据。
- **Phase 2**：Worker Thread、Child Process、Remote template 复用 L2；各自完成 L3/L6；至少一个真实方舟 child 通过每种 placement 执行，不引入 handoff。
- **Phase 3**：每个 DB/queue/container adapter 复用 L2/L6，并单独证明认证接入、加密、配额、死信、清理、滚动升级和多节点 fencing。Core 仍只识别可信 `sessionId`。

## 6. 建议测试目录与基础设施

```text
packages/core/test/subagent/
  definition-catalog.test.ts
  router.test.ts
  result-controller.test.ts
  task-state.test.ts
  session-recovery.test.ts
  approval.test.ts
  batch-concurrency.test.ts
  limits-budget.test.ts
  context-isolation.test.ts
  events-redaction.test.ts
  protocol-chat.test.ts
  protocol-responses.test.ts
  helpers/
    scripted-model.ts
    protocol-fixtures.ts
    scripted-executor.ts
    recording-state-store.ts
    manual-clock.ts
    deterministic-ids.ts
    deferred.ts
    event-recorder.ts
    failpoints.ts
    network-deny-guard.ts

testkit/subagent/
  executor-conformance.ts
  protocol-fixtures.ts
  acceptance-reporter.ts
  acceptance-it.ts

test/acceptance/
  subagent-v2.manifest.json
  validate-manifest.mjs
  validate-evidence.mjs
  validate-legacy-source.mjs
  validate-pack.mjs
  run-offline-acceptance.mjs
  merge-release-report.mjs

packages/executor-local/test/
  local-executor.conformance.test.ts
  memory-store.integration.test.ts
  file-store.integration.test.ts
  file-restart.process.test.ts
  fixtures/
    file-store-worker.ts
    crash-controller.ts
  vite.config.ts
  vitest.process.config.ts
  vite.test-worker.config.ts

tooling/vite/
  decorators.ts

demo/src/subagent-v2-acceptance/
  ark-agent-plan.ts
  configuration.ts
  cli-options.ts
  observed-models.ts
  ark-model-gateway.ts
  budget-authority.ts
  scenario-manifest.ts
  provider-usage-ledger.ts
  token-estimator.ts
  scenario-runner.ts
  artifact-recorder.ts
  process-controller.ts
  process-worker.ts
  ipc-protocol.ts
  scenarios/
    integrated-features.ts
    protocol-matrix.ts
    routing.ts
    batch.ts
    nested.ts
    approval-resume.ts
    approval-outcomes.ts
    background-spawn.ts
    result-crash.ts
    budget-cancel.ts
    retry.ts
    root-failure.ts
```

`testkit/subagent` 是仓库私有测试源码，不进入任何 npm exports 或 tarball。Core 与官方 Local/Worker/Process Executor 的 Vitest/tsconfig 通过显式相对路径包含同一份 conformance runner，禁止复制；共享 Vitest resolve config 将实际发布包名 alias 到 `packages/core/src/index.ts`，让 testkit 只从 public root surface 导入 contracts，同时不依赖可能缺失或陈旧的 `dist`。未来独立 Executor 仓库若不能直接引用该目录，应把 conformance testkit 单独版本化发布，而不是复制断言。

独立进程 fixture 不能假定 Node.js 22 可直接执行 TypeScript。`packages/executor-local` 的 process script 先显式调用专用 Vite config，把 worker/controller 构建到 OS 临时目录中的 `.mjs`，再由 `process.execPath` 启动；不能只依赖不会被直接命令触发的 `pretest`，也不能把生成代码放入仓库或 `.artifacts`。2023-11 decorators 插件提取到 `tooling/vite/decorators.ts`，供 Core、Local Executor、demo 和测试 worker 复用。

L3 文件统一命名 `*.process.test.ts`：普通 Local Vitest config 显式 exclude，`vitest.process.config.ts` 只 include L3 并设置 `fileParallelism: false`、明确的 `testTimeout/hookTimeout`。根 `pnpm test` 顺序组合 Core、Local 非进程和 L3 各一次；聚焦 `test:subagent:v2` 不隐式重复 L3。每例创建唯一临时目录，使用 pipe + IPC 启动 worker，stdout/stderr 不直接继承终端且关闭前进入 secret scan；先完成 IPC `ready`/`failpoint-armed` handshake 再触发动作，并在 `finally` 中 kill、wait、关闭 pipe 和清理。业务顺序只依赖 IPC/barrier/exit event，不用 sleep 猜测。

需要从现有测试提取并复用：

- `packages/core/test/helpers/mock-models.ts` 的响应队列、异常、请求快照和 Tool call helper。
- `tool-payload-compact.test.ts` 中的 Chat/Responses wire fixture、gate 和请求快照。
- `context-store.test.ts` 的 revision CAS、回滚和并发 append 模式。
- `agent-regression.test.ts` 的 Tool 顺序、事件顺序和单实例 re-entry 断言。
- Skills 测试中的临时目录、fake process、脚本错误脱敏和 progressive disclosure fixture。
- `public-api.test.ts` 的类型等价与包根出口断言。

共享 harness 至少提供：

- `ManualClock`：控制 queued/running/approval/expiry/lease 的业务语义时间；跨进程由 controller 提供共享 logical clock。
- `DeterministicIdFactory`：生成可断言但不进入模型的 session/run/task/approval/event ID。
- `ScriptedExecutor`：记录 create/resume/reconnect/handler 次数，按 barrier 返回 outcome。
- `RecordingStateStore`：暴露只读 transaction/event digest，不能绕过生产 SPI 修改状态。
- `FaultInjector`：按一次性 failpoint 中断；默认关闭，不成为公共配置。
- `NetworkDenyGuard`：L0-L4 入口在构造测试对象前封锁 `fetch`、OpenAI SDK transport、HTTP(S)、DNS 与裸 socket；任何未显式注入的网络访问直接失败，真实方舟命令不加载该 guard。
- `ObservedChatModel` / `ObservedResponsesModel`：捕获内存快照、校验真实响应，并向 controller 的 `ArkCallBudgetAuthority` 预留一次性 network-attempt token。重复的 IPC reservation 消息按 `scenario + logicalRequestId + attemptId` 幂等，不重复计数；已消费 token 永远不能授权第二次 SDK create，新的网络尝试必须使用新的 attemptId 并再次占用配额。reservation 发出后即使 worker 崩溃也不返还。
- `ArkModelGateway`：常驻 controller 独占 API key、真实 Chat/Responses adapter、调用/token usage ledger 与脱敏 evidence 聚合；真实进程场景中的父/child factory 显式注入 protocol-specific Model proxy，经继承的本地 IPC 调用 gateway。原始 HTTP body/headers、SDK response wrapper 和 credential 只在受信进程内存/IPC 中短暂存在，不进入 argv、环境变量、StateStore、stdout/stderr 或 artifact；gateway 返回的规范化 Model context、assistant Tool-call 与 Tool checkpoint 则由 Runtime 按技术设计写入受保护 StateStore，供 durable resume 使用。worker 断线会 abort 或把在途请求记为 outcome unknown，绝不自动重发。
- `FakeOpenAIClient`：让 L4 真正进入 `OpenAIChatModel.generate()` / `OpenAIResponsesModel.generate()`，只 mock SDK 的 `chat.completions.create` / `responses.create`；精确断言 signal 进入 SDK request options，deadline/runtime metadata 不泄漏进 provider payload。
- `SafeArtifactRecorder`：由常驻 controller 汇总 worker 的白名单事件，只接受白名单字段，拒绝任意对象直接序列化；每条 IPC evidence 都带 scenario/case/sequence，worker 崩溃后仍可验证已确认的最后证据点。

真实 OS process exit、file lock 和 provider timeout 仍由 wall-clock watchdog 保证测试不会挂死；watchdog 不参与 timeout/lease 的业务结果断言。

## 7. 未来命令设计

以下是 v2 的完整目标命令集。当前 checkout 已实现其中的 Core/Local/Worker/Process/HTTP security 默认测试、Worker/Process 离线 shard、HTTP security 离线入口、manifest/legacy/五包 pack 校验和既有 demo；尚无对应 script 的命令仍是后续目标，是否可运行以根 `package.json` 为准：

```bash
pnpm test
pnpm test:subagent:v2
pnpm test:subagent:v2:process
pnpm acceptance:subagent:v2:worker:offline
pnpm acceptance:subagent:v2:process:offline
pnpm acceptance:subagent:v2:http-security:offline
pnpm acceptance:subagent:v2:offline
pnpm validate:subagent:v2:manifest
pnpm validate:subagent:v2:evidence
pnpm validate:subagent:v2:legacy
pnpm validate:subagent:v2:pack
pnpm validate:subagent:v2:pack:worker
pnpm validate:subagent:v2:pack:process
pnpm validate:subagent:v2:pack:http
pnpm validate:subagent:v2:release-report
pnpm demo:subagent:v2:ark:smoke
pnpm demo:subagent:v2:ark:full
```

命令语义：

| 命令                                                | 语义                                                                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                         | 显式组合 Core、Local、Worker、Process、HTTP security 默认 unit/conformance、L1-L4 和既有 Local 进程恢复；真实 Worker/Process crash/lifecycle 保持在独立 offline shard。不能盲目递归执行未来可能联网的 workspace test。 |
| `pnpm test:subagent:v2`                             | 聚焦 L1、L2、L4，便于开发者快速定位 v2 合约失败；L0 由独立静态/pack 门禁完成。                                                                                                                                         |
| `pnpm test:subagent:v2:process`                     | 聚焦 L3，启动真实 child process 验证 File Store、WAL 和 fencing。                                                                                                                                                      |
| `pnpm acceptance:subagent:v2:worker:offline`        | 使用真实 `worker_threads` 运行 C7c-2 的独立离线 shard；不读取 API key、不访问真实模型。                                                                                                                                |
| `pnpm acceptance:subagent:v2:process:offline`       | 使用真实 Node.js 子进程运行 C7c-3 的独立离线 shard，覆盖 advanced IPC、kill/exit/close、orphan watchdog 与恢复窗口；不读取 API key、不访问真实模型。                                                                   |
| `pnpm acceptance:subagent:v2:http-security:offline` | 运行 C7c-4 的 multipart/HMAC/replay/authz/admission L1/L2 离线矩阵；加载 network deny，不创建 listener、job 或真实模型调用。                                                                                           |
| `pnpm acceptance:subagent:v2:offline`               | 创建唯一 evidenceRunId，按发布顺序编排静态、测试、process、pack、回归 demo 与 evidence 校验，输出当前平台 shard。                                                                                                      |
| `pnpm validate:subagent:v2:manifest`                | 纯静态校验 manifest schema、全局唯一 caseId、requirement/layer/variant 完整性，并将所有测试源码中的 literal `acceptanceIt` 与 file/caseId/variant 精确双向核对；动态或未登记注册失败。                                 |
| `pnpm validate:subagent:v2:evidence`                | 在测试完成后把本次 Vitest/process/pack/平台 reporter 产物与 manifest、git SHA 和构建版本对照，拒绝陈旧证据。                                                                                                           |
| `pnpm validate:subagent:v2:legacy`                  | 只扫描可执行源码并拒绝未 allowlist 的 v1 Subagent symbol/wire。                                                                                                                                                        |
| `pnpm validate:subagent:v2:pack`                    | 在唯一临时 consumer 中构建并验证 Core/Local/Worker/Process/HTTP 的 dry-run、真实 tarball、ESM/CJS/NodeNext 和负向文件清单。                                                                                            |
| `pnpm validate:subagent:v2:pack:worker`             | 只运行 Worker 的发布包、Core peer、公开类型和敏感内容边界校验，便于 C7c-2 聚焦诊断。                                                                                                                                   |
| `pnpm validate:subagent:v2:pack:process`            | 只运行 Process 的发布包、Core peer、公开类型、内部 IPC 根导出和敏感内容边界校验，便于 C7c-3 聚焦诊断。                                                                                                                 |
| `pnpm validate:subagent:v2:pack:http`               | 只运行 HTTP security 包、Core peer、公开类型、精确 runtime exports、内部 owned decoder 与敏感内容边界校验，便于 C7c-4 聚焦诊断。                                                                                       |
| `pnpm validate:subagent:v2:release-report`          | 显式接收 Windows、Linux 与 Ark evidence 路径，校验同一 commit/manifest/package/lock 后合并 release report。                                                                                                            |
| `pnpm demo:subagent:v2:ark:smoke`                   | 复用当前综合 feature suite，运行两个跨协议、Skills/context compact 集成场景，硬上限 24 次 provider generate。                                                                                                          |
| `pnpm demo:subagent:v2:ark:full`                    | 包含 smoke 和全部模型可见/控制终态 v2 场景；要求 `--ack-provider-calls=112`，精确 110 次 SDK attempt，reservation 硬上限 112。                                                                                         |

现有 `pnpm demo:features:ark` 应迁移到 v2 wire 并作为 smoke 的实现基线或兼容别名；复用其配置加载、Skill fixture、marker、Observed Model 思路和安全日志，不复用当前“每轮恰好一个 Tool call”的 sequence validator、按协议保存的进程级 evidence 或单 Model 实例调用计数。不能保留旧 `agentName/input/outputDescription` 的可执行路径。`pnpm demo:ark:subagent` 保留独立 smoke 的命令定位，但实现同样必须迁移到 v2 wire，且不计入 v2 full 通过证据。

新的真实 demo script 在启动前必须按 pnpm dependency-filter 语义构建 demo 的 workspace dependencies，至少包括 Core 与 Local Executor，不能沿用当前只硬编码构建 Core 的脚本而读取旧或缺失的 Local `dist`。

## 8. 真实方舟配置、预算与运行策略

### 8.1 配置

沿用当前配置：

| 变量                | 必填 | 默认值                                          | 说明                                                                       |
| ------------------- | ---- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `ARK_API_KEY`       | 是   | 无                                              | 缺失时在任何 provider 调用前失败。                                         |
| `ARK_PLAN_BASE_URL` | 否   | `https://ark.cn-beijing.volces.com/api/plan/v3` | Chat/Responses 共用 Agent Plan base URL。                                  |
| `ARK_PLAN_MODEL`    | 否   | `kimi-k3`                                       | 父与 child Model 都由 Executor factory 显式注入；不得从父 Agent 隐式继承。 |

full 不使用可长期保存在 `.env` 的确认变量。每次运行都必须在 CLI 显式传入 `--ack-provider-calls=112`；调用确认值不精确等于当前 profile 硬上限时，在构造 Model/Executor、创建目录或运行 Skill script 前失败。客户端不设置 CNY/AFP 额度，套餐额度及超额策略由方舟侧执行。`demo/.env` 继续被 Git 忽略，shell 中显式环境变量优先；`.env.example` 只列上表三个方舟变量和非秘密默认值，不包含调用确认或 key。

配置预检顺序固定为：解析 profile/CLI → 校验静态 scenario 调用/token 预算与调用确认 → 将 key 读入只存在 controller 内存的配置对象 → 从 runner 的 `process.env` 移除 `ARK_API_KEY` → 创建 artifact/临时状态目录 → 单进程场景通过闭包、跨进程场景通过 protocol-specific `ArkModelGateway` proxy 显式构造父/child Model。key 不通过 worker 环境变量、argv、文件或 IPC 下发。验收专用 Skill script executor 还要使用最小环境白名单，排除 `ARK_API_KEY`、`OPENAI_API_KEY`、`Authorization` 以及非必要的 `*_TOKEN`、`*_SECRET`、`*_KEY`；fixture 必须断言 `hasArkApiKey=false`。这只收窄验收 runner，不声称改变框架通用 Skill 默认继承宿主环境的行为。

### 8.2 固定边界

- SDK `maxRetries: 0`。
- 单次 provider 请求 timeout 为 120 秒。
- 框架 `unhandledRetryLimit: 0`、`contextLengthRecoveryLimit: 0`。
- 每个父 Agent 显式设置 `maxIterations=10`，每个 child/coordinator/leaf Agent 设置 `maxIterations=6`，Runtime task `maxTurns=6`；scenario manifest 另设更小的精确 Tool 序列和调用配额，不能依赖这些灾损上限多试几轮。
- smoke 精确且最多 24 次 SDK create attempt；full 精确 110 次 SDK create attempt、最多 112 次 reservation。
- 每次 Chat 请求设置 `max_completion_tokens=2048`，每次 Responses 请求设置 `max_output_tokens=2048`；adapter 或目标 endpoint 不接受该硬上限时场景失败，不能无界调用。
- smoke 总 input/output token ceiling 分别为 300,000/30,000；full 为 1,250,000/120,000。controller 在请求前用已注册模型 estimator 预留 input 上界和 max output，响应后用归一化 provider usage 结算；实际 usage 超过预留是验收失败。
- full 只使用 call/token usage ledger；自定义 model 没有可信 token estimator 时不能把 full 标记通过。
- timeout、abort、5xx、连接断开或 outcome unknown 没有可信 usage 时不释放预留 token；报告将其列为 unknown attempt，并按 token 预留上界保守占用。provider 最终账单与套餐扣减以服务商为准，验收报告不推算或宣称 CNY/AFP 费用。
- 每个 scenario 有独立不可借用的调用配额；一个场景的异常循环不能消费其他场景预算。
- smoke 整套 wall-clock 上限为 30 分钟，full 为 120 分钟；到期通过同一根 `AbortSignal` 终止当前请求、队列、Executor 和后续场景。
- 预算在 `super.generate()` 前预留；达到上限时在网络调用前失败。
- 全局和场景调用计数器必须支持并发原子预留，ARK-05A/05B 的两个 child 不能分别读取旧值后超卖。
- 跨进程场景由不退出的 controller 统一持有 global/scenario ledger；进程 A、进程 B、父/child 和两种协议都必须通过 IPC 预留后才能发请求。worker 重建不能把计数器重置为 0。
- controller 将 reservation 状态区分为 granted、consumed、settled 和 outcome_unknown；只有 consumed 会进入已用次数。IPC 重放只能取回原状态，不能再次消费 token。worker 在 SDK create 前原子 consume，随后崩溃时按已发出请求计费且禁止框架重试；无法证明 create 未发生时一律按 outcome_unknown 计入硬上限。
- 已发出但 timeout/5xx 的请求计入已用次数；因达到上限而在网络前拒绝的请求不把计数写成 `limit + 1`。
- 每个场景使用独立 root run、Model proxy 和场景配额。普通断言失败立即关闭该场景但继续其余隔离场景，确保另一协议仍收集证据，最终统一退出码为 1；凭证/调用确认/全局硬上限/证据泄密/StateStore 损坏等安全故障可以中止整套运行。
- 401/403、凭证缺失、无效 endpoint/model、账号/配额不可用属于全局配置故障，为避免继续费用可停止剩余场景；报告为未通过，而不是跳过。
- provider 临时故障不自动重试。人工重跑是新的付费验收，必须重新传入该 profile 的调用确认。

调用计数采用四个不混淆的口径：`reservedCalls` 约束 112 次灾损上限；`sdkCreateAttempts` 表示已经进入真实 SDK create 的计费尝试，也是场景表“generate”的精确验收口径；`completedCalls` 表示收到 provider 响应；`usageReportedCalls` 表示响应携带可结算 usage。成功 full 必须 `reservedCalls=sdkCreateAttempts=110`，但主动 abort 的场景允许后两项更小；任何 reservation-only 间隙或 outcome unknown 都必须保守占用硬上限并使该场景失败，不能拿“没有完成响应”抵扣费用。

ARK-01/02 的第一个 Chat/Responses 调用同时充当 endpoint capability check：验证 Agent Plan 接受对应 output-token 上限并返回 usage。不能额外发送未计入 manifest 的探测请求；任一协议不满足时结束该协议并使 full 失败。

### 8.3 脱敏证据

每次真实运行写入已忽略目录：

```text
.artifacts/subagent-v2-ark/<timestamp>-<nonce>/
  manifest.json
  assertions.ndjson
  events.ndjson
  state-digests.json
  summary.json
```

可恢复的 Runtime operational state 使用另一个权限受限的临时目录，不属于验收证据：

```text
<os-temp>/manee-subagent-v2-ark/<run-id>/runtime-state/
```

该目录可以包含恢复原 pending call 所必需的协议 context、Tool call 和 checkpoint，因此必须使用可验证的 owner-only ACL adapter，并在提供加密 codec 时启用，绝不能复制到 `.artifacts`。POSIX mode 与 Windows ACL 分别实测，Windows 不能把 `mode: 0o700` 当作权限证明；当前平台无法验证 ACL 时，必须强制使用已验收的加密 codec，否则在首次 provider 调用前失败。成功或失败后都在 `finally` 清理；未显式使用本次 CLI 的 `--keep-runtime-state` 时只要仍有残留就判定安全门禁失败。显式保留时终端必须提示该路径可能含敏感上下文。API key、Authorization、provider headers/body 无论如何都不得进入 StateStore。

允许写入验收 evidence：scenario/test ID、协议、definition/executor 名称与版本、状态、事件类型/sequence、attempt、调用次数、归一化的 token usage 数值（若 provider 提供）、耗时、字符长度、稳定错误 code、marker hash、通过/失败。

禁止写入验收 evidence：API key、Authorization、prompt、完整 request/context/history、Tool arguments/result、child transcript、approval 原始参数、binding、recoveryData、provider response/body/message/headers、未清洗 stack。这里不禁止 Runtime 按 durable checkpoint 合约把规范化 context、Tool call/result、binding 和 recoveryData 写入独立的受保护 StateStore；两类目录的保留与脱敏规则不能混用。

raw history、active context 和 provider 原始 response 只在进程内做断言；产物只保存长度、预定义 marker 是否存在及白名单状态投影的 SHA-256 digest，不能直接 hash 完整 StateStore 文件。`SafeArtifactRecorder` 对未知字段直接抛错，不能用对象 spread 把 provider error/usage 写入磁盘。

产物关闭后执行两类本地扫描：一类按禁止字段名和已知 raw marker 检查 evidence 结构；另一类在内存中用 API key 字节和 Authorization/header sentinel 检查 evidence、捕获的 stdout/stderr 以及 Runtime 目录是否意外包含凭证。凭证扫描无论是否使用 `--keep-runtime-state` 都必须执行；只有 prompt/raw-context marker 扫描可以对显式保留且本来允许包含恢复上下文的 Runtime 目录豁免。报告只能写命中数量和文件类别，绝不能回显命中内容。

## 9. 真实方舟 Agent Plan 场景

### 9.1 场景与调用上限

| ID      | 场景                                            | 父 → 子协议                  | 预期/上限 generate | profile    |
| ------- | ----------------------------------------------- | ---------------------------- | ------------------ | ---------- |
| ARK-01  | 综合 Skills/context compact + v2 typed dispatch | Chat → Responses             | 12 / 12            | smoke/full |
| ARK-02  | 综合 Skills/context compact + v2 typed dispatch | Responses → Chat             | 12 / 12            | smoke/full |
| ARK-03  | child Skill + artifact projection 类型化闭环    | Chat → Chat                  | 7 / 7              | full       |
| ARK-04  | 类型化基本闭环                                  | Responses → Responses        | 5 / 5              | full       |
| ARK-05A | 普通 Tool 后同批两个 agent 反序完成             | Chat → Chat + Responses      | 8 / 8              | full       |
| ARK-05B | 一个 child 审批拒绝、兄弟继续完成               | Chat → Chat + Responses      | 6 / 6              | full       |
| ARK-06  | allowlist 嵌套委派                              | Responses → Chat → Responses | 8 / 8              | full       |
| ARK-07  | Executor TOCTOU、无 fallback、显式重选          | Chat → Responses             | 6 / 6              | full       |
| ARK-08  | 已完成 sibling + 审批 child 的 File 重启恢复    | Chat → Chat + Responses      | 8 / 8              | full       |
| ARK-09  | 后台 spawn 审批隔离与显式恢复                   | host → Chat/Responses        | 6 / 6              | full       |
| ARK-10A | result receipt 后崩溃并形成 partial             | Responses → Chat             | 3 / 3              | full       |
| ARK-10B | terminal CAS 后、完成响应前崩溃                 | Responses → Chat             | 4 / 4              | full       |
| ARK-11A | approval reject 后父消费 failed envelope        | Chat → Responses             | 3 / 3              | full       |
| ARK-11B | approval expire 后父消费 failed envelope        | Responses → Chat             | 3 / 3              | full       |
| ARK-11C | approval host cancel 后父消费 cancelled         | Chat → Responses             | 3 / 3              | full       |
| ARK-12A | provider budget_exceeded                        | Responses → Chat             | 2 / 2              | full       |
| ARK-12B | active timeout 中止 child provider call         | Chat → Responses             | 3 / 3              | full       |
| ARK-12C | host cancel child provider call                 | Responses → Chat             | 3 / 3              | full       |
| ARK-12D | root cancel fan-out 两个并发 child              | Chat → Chat + Responses      | 3 / 3              | full       |
| ARK-13  | host retryOf 使用同版本、不同 Executor          | host → Chat                  | 4 / 4              | full       |
| ARK-14  | 真实响应后的根 Model adapter 故障               | Responses root               | 1 / 1              | full       |

表内精确预算合计为 110 次；full 的 112 次是不可突破的二级灾损保险，不是允许模型额外尝试的配额。每个 scenario 仍必须严格等于自己的预期序列，2 次余量不能在一次运行中借给异常场景。新增或修改任何场景仍必须同步更新本表、精确合计、静态 scenario manifest 和调用确认文案，不能因为总数尚未超过 112 就静默加入。

runner 启动时从只读 scenario manifest 计算并断言 smoke=24、full=110、hard limit=112。调用公式固定为：ARK-01/02 各 summary 1 + parent 8 + child 3；ARK-03 为 parent dispatch 1 + child Skill 3 + child result/end 2 + parent end 1，ARK-04 为 parent dispatch 1 + child proof/result/end 3 + parent end 1；ARK-05A/05B 见下节；ARK-06 为 parent dispatch 1 + coordinator dispatch 1 + leaf 3 + coordinator result/end 2 + parent end 1；ARK-07 为失败选择 1 + 显式重选 1 + child 3 + parent end 1；ARK-08 为 parent batch 1 + completed sibling 3 + approval child 3 + parent end 1；ARK-09 为两个 host-spawn child 各 3；ARK-10A 为 parent dispatch 1 + child result 1 + parent end 1，ARK-10B 为 parent dispatch 1 + child result/end 2 + parent end 1；ARK-11A/B/C 各 parent dispatch 1 + approval Tool 1 + parent end 1；ARK-12A 为 parent dispatch 1 + child 首次 call 1，ARK-12B/C 为 parent dispatch 1 + 已发出的 child call 1 + parent end 1，ARK-12D 为 parent 同批 dispatch 1 + 两个已发出的 child calls 2；ARK-13 为首次失败 child call 1 + retry child proof/result/end 3；ARK-14 为真实 root provider call 1。任何 manifest 公式、profile 合计、CLI 确认值或全局硬上限不一致都在首次网络调用前失败。

### 9.2 ARK-01 / ARK-02：综合能力与跨协议

复用当前 `feature-suite` 的严格链路：

1. 父模型通过内置 `skill` 依次 load、read reference、read asset、run trusted script。
2. 调用带 Zod 参数校验的装饰器 Tool，handler 收到原始长参数。
3. 调用运行时 Tool 生成约 20K 字符结果。
4. 通过 v2 `agent({ subAgent, executor, input })` 调用相反协议 child。
5. child 调用装饰器 proof Tool，以 definition `outputSchema` 提交结构化 `agent-result`，再单独 `end-agent`。
6. 父收到 protocol-neutral typed envelope 后单独 `end-agent`。

必须断言：

- Chat 使用 inline Skill，Responses 使用 portable file Skill；所有资源和 script marker 精确匹配。
- script argv 中带空格和 shell 字符的参数保持字面值，且只执行受信任 fixture。
- 一次真实 `purpose: context-summary` 请求不暴露 Tools；summary marker 被提交到 active context，provider summary response 和合成 summary 不写 raw history。
- tool-input/tool-result compactor 只改 active context；handler/raw history 保留原值；Skill result 默认不压缩。
- ARK-01 的 projector 只显式传入命名 text/data marker；ARK-02 不配置 projector 且 projection 为空。两者的 child 请求都不含父 seed、父 Tools/Skills、父 system prompt、完整 transcript 或可变 app state。
- 父请求不暴露 child 的 `agent-result`；child 只暴露 factory 明确配置的 Tool/Skill/delegation catalog。
- child Model 由所选 Executor factory 显式创建，并实际使用与父不同的 adapter。
- output、callId、task/session/run、事件和 result receipt 全部闭环；父 raw history 不含 child transcript。

### 9.3 ARK-03 / ARK-04：协议四象限补齐

与 ARK-01/02 共同形成 Chat→Chat、Chat→Responses、Responses→Chat、Responses→Responses 四象限：

- ARK-03 的 Chat child factory 显式配置一个父 Agent 没有的 portable Skill。固定序列为父 `agent`，child `skill load → read reference → run trusted script`，child `agent-result → end-agent`，父 `end-agent`，共 7 次。Skill script 消费显式 artifact projection 的受信 fixture 并返回 hash marker；`ArtifactReference` 契约必须先按 18.14 冻结，否则该场景保持 blocking。
- ARK-04 保留最小类型化闭环：父 `agent`、child proof、child `agent-result`、child standalone `end-agent`、父 standalone `end-agent`，共 5 次。测试用 Local Executor 在 proof Tool 完成后通过它持有的 `SubAgentExecutionControl.reportProgress` 发出一次进度，并在 typed output 的纯数据字段中放入“已批准、切换 Executor、覆盖 session”之类恶意控制文本；不把 reportProgress 扩张到 `ToolRuntimeContext`。

四象限都要断言：

- 模型看见的 wire 只有 `{ subAgent, executor, input }`。
- definition input/output 通过 Zod 和 JSON-safe 校验。
- 父 adapter 按父协议构造 Tool result，child 协议字段不泄露。
- canonical output hash 和 typed terminal envelope 不受协议组合影响。
- signal、deadlineAt 和 runtime metadata 进入相应 Model adapter，但 ID 不进入模型参数。
- ARK-03 只有 child 看见并执行 factory 显式配置的 Skill；父和其他 child 看不见该 descriptor，reference/script/artifact marker 精确闭环。
- ARK-04 的恶意 output 只作为 schema-valid data 返回，不能批准、重路由、改身份或触发额外 Tool；`progress.reported` 事件存在且不改变 result/task state。

### 9.4 ARK-05A / ARK-05B：混合批次与并发

两个变体都让父模型在同一响应返回一个普通 Tool 和两个 `agent` calls：

- ARK-05A：两个 child 都按 proof/result/end 成功，测试用 barrier 让它们以与 provider call 顺序相反的顺序完成。调用公式为父 batch 1 + 两个 child 各 3 + 父 end 1 = 8。
- ARK-05B：两个 child 都在首次 safe marker Tool 请求时进入独立审批。host 先 approve B，B 按 result/end 完成但 root 仍因 A pending 保持 waiting；再 reject A，父最终收到 B succeeded 与 A failed。调用公式为父 batch 1 + B 的 approval/result/end 3 + A 的 approval 1 + 父 end 1 = 6。

必须断言：

- 批次在执行前完整分类；普通 Tool 先串行 settle 并持久化，期间没有 child 启动。
- 普通阶段结束后两个 agent calls 一次性 submit，实际重叠且不超过 `maxConcurrent`。
- ARK-05B 的两个 approval 同时进入聚合 checkpoint；部分 decision 只恢复对应 B，不能让父模型提前继续或默认批准 A。A 最终 failed + `APPROVAL_REJECTED`，B succeeded，不触发默认 fail-fast。
- Tool results 最终按 provider 原 call 顺序回填，不按完成顺序回填。
- ARK-05B 每次暂停时，已完成 B 结果、剩余 A approval 和两个 binding 都进入父 checkpoint；A 解决后父按原 call 顺序收到两个独立 terminal envelope。

### 9.5 ARK-06：嵌套委派

Responses 父调用 Chat coordinator；coordinator 通过 task-scoped delegation client 调用 allowlisted Responses leaf。

必须断言：

- delegation 默认目录为空；只有显式 allowlist 后 leaf 才可见。
- child 无法覆盖 ownerSessionId、runId、parentTaskId、path、depth 或共享 budget。
- 所有层继承同一根 session/run；taskId/subagentSessionId 各自独立。
- parent → coordinator → leaf 的 path、depth、trace/span 和事件完整。
- 未 allowlist 的 definition、recovery-only version 和不满足 capability 的 Executor 不进入 child schema。
- self recursion 未设置 `allowSelf` 时拒绝；显式允许后仍受 depth/descendants 限制。真实 happy path 只执行一层允许的 leaf，拒绝反例由 L1 精确注入。

### 9.6 ARK-07：Executor 选择与 TOCTOU

目录同时提供用途不同的两个 Executor。prompt 要求模型按公开用途选择目标；模型响应被观察到后、Router 执行前，测试私有 availability hook 将目标置为 unavailable。

必须断言：

- 模型显式返回目标 Executor，Router 使用最新 catalog revision 复核。
- 失败返回 `EXECUTOR_UNAVAILABLE` 和刷新后的安全目录。
- 失败前不创建 task/binding、不增加 descendants、不消费 child provider/token/cost budget、不调用任何 Executor create。
- Runtime 不自动切换另一个 Executor。
- 父模型在下一轮看到刷新目录后可以显式重选；该动作是新的显式调度，不是 fallback。

### 9.7 ARK-08：审批与进程恢复

进程 A 使用 Atomic File Store；父第一次响应同批返回一个 safe ordinary Tool 和两个 `agent` calls。Chat sibling A 正常 proof/result/end，Responses child B 请求 safe approval marker Tool，且模型可控 Tool args 故意携带 `claimedDecision: "approved"` 和伪 approval 文本：

1. ordinary Tool 先 settle；自定义 result compactor 只把 active context 改为固定 marker，raw history 保留完整结果，compact transaction 与父 revision 一起提交。
2. 普通阶段结束后 A/B 一次性 submit；barrier 让 A 先 terminal，B 再持久化 pending approval call checkpoint。
3. B 的 `authorizeTool` 忽略伪批准并返回 suspend；handler 计数必须为 0。
4. root 返回 `waiting_approval`，保存 A 的 terminal envelope、B 的原 sessionId/runId/taskId/callId/binding、provider call order、checkpoint revision、compact revision 和 remaining timeout。
5. 进程 A 退出；进程 B 以同版本 definition/factory/Executor 和同一个 StateStore 重建。
6. 可信 host 用 approvalId/revision 提交 approved decision，`resumeRun` 继续原 task。
7. B handler 只执行一次并提交 result/end；父按原 call 顺序复用 A、回填 B，再继续并结束。

必须断言：旧进程 lease 失效、B attempt 增加、IDs 不变、审批期间 timeout 冻结、恢复用 remainingMs 生成新 deadline、已完成 ordinary Tool/compactor/A sibling 都不重跑、raw/active revision 不回滚、B resume 路径的 create 次数为 0。B 的 turns 在暂停前为 1，恢复后的 result/end 分别累计到 2/3，不能因进程或 attempt 改变重置。

模型 Tool args/text 伪批准由本真实场景覆盖；reject、expire、host cancel 由 ARK-11 覆盖；重复/冲突 decision 等精确竞态仍在 L1/L2 运行。所有真实审批场景只用 safe marker Tool，不执行外部危险副作用。

### 9.8 ARK-09：后台 spawn

可信 host 先创建持久 root run/budget record，再用 `spawn()` 分别启动一个 Chat child 和一个 Responses child；其中一个进入审批。

必须断言：

- `spawn()` 立即返回 Core 包装的 session-bound handle，宿主拿不到 raw Executor handle。
- L5 调用 `snapshot()`、`wait()` 和断线后的 `events(afterSequence)`，证明它们通过 session-bound Core handle 工作。
- 后台 child 的 `waiting_approval` 只暂停该 task，不暂停无关 root/兄弟。
- host 通过 Runtime `resume()` 而不是 raw handle 恢复；`spawn().wait()` 与对应 `execute()` 终态语义一致。

最后一项比较规范化 outcome 与同一 conformance fixture 的离线 `execute()` 基准，不额外发起一次真实 `execute()`，因此不会突破 6 次 provider 预算。guarded handle 的跨 session、cancel 和 execute 等价由 L1/L2 精确覆盖，不强塞进同一批真实 task。

### 9.9 ARK-10A / ARK-10B：result 与 terminal 崩溃窗口

两个变体严格遵守现有恢复矩阵，不从 `result_submitted` 调用未定义的 resume：

- ARK-10A：child 用真实方舟提交有效 typed `agent-result`；在 result receipt CAS 成功、receipt 尚未返回 child 时让 Executor 进程崩溃。该 task 不满足 approval/checkpoint resume 条件，Core 将其置为 failed，保留 `partialOutput`。父 run 恢复后收到 failed terminal envelope，再调用父 `end-agent`。
- ARK-10B：child 先完成 result，再单独调用 `end-agent`；在 `result_submitted → succeeded` terminal CAS 成功、completion 尚未返回父调用方时崩溃。父 run 恢复时直接读取原 terminal outcome 并关闭 pending call，不 resume/reconnect/create task，也不再请求 child 模型。

共同断言：output/hash/callId/receipt 不丢失、不覆盖，result/terminal 事件不重复，父 checkpoint 使用原 task/callId。相同 result replay 与 terminal completion replay 的精确 receipt 行为继续由 L1/L3 scripted protocol 测试覆盖；ARK-10 的本地 replay 不计 provider generate。

### 9.10 ARK-11A / ARK-11B / ARK-11C：审批控制终态

三个真实父/child 流程都让 child 正常请求同一个 safe approval marker Tool，随后由可信测试控制面分别执行：

- ARK-11A：host reject，task 为 failed + `APPROVAL_REJECTED`。
- ARK-11B：controller 推进 logical clock 到 `expiresAt`，task 为 failed + `APPROVAL_EXPIRED`，不用 wall-clock sleep。
- ARK-11C：host 显式 cancel，task 为 cancelled，不得伪装成 reject。

三者都必须证明 handler=0、父模型收到相应 protocol-neutral terminal envelope 后只调用父 `end-agent`、没有 child provider retry。approval decision replay/conflict 和多个 pending approvals 的精确竞态仍由 L1/L3 补充。

### 9.11 ARK-12A 至 ARK-12D：预算、超时与取消

- ARK-12A：只使用原设计已有的 root-run 共享 ledger，并设置 `maxProviderCalls=2`。父 dispatch 消耗第一次，child 第一次真实调用返回 safe proof 并消耗第二次；child 在下一轮 generate 前被共享预算拒绝，task 进入 budget_exceeded。父 checkpoint 写入 terminal error envelope，但根 ledger 已耗尽，因此不再调用父模型，root `AgentRunOutcome` 为 failed + `BUDGET_EXCEEDED`。它不引入不存在的 task 级预算或“父调用保留额度”。
- ARK-12B：child provider request 已向 controller 预留并进入 SDK create 后，controller 触发 active timeout；请求被 abort，task 为 timed_out，父消费 envelope并结束。
- ARK-12C：与 B 相同，但由同 session host 显式 cancel 该 child；task 为 cancelled，父消费 envelope并结束。单 child cancel 不影响兄弟的反例由 L1/L2 覆盖。
- ARK-12D：父模型同一响应 dispatch Chat/Responses 两个 child；controller 通过双 barrier 确认两个 provider SDK create 都开始后 cancel root run。signal fan-out 到两个在途调用，两个 task 与 root `AgentRunOutcome` 均为 cancelled，不再调用父模型结束。

已发出的 B/C/D 请求即使在网络栈完成前被 abort 也计入调用预算。必须断言 SDK 与框架 retry 都为 0、summary/context recovery 不启动、signal 传播到正确 Chat/Responses SDK request options，且所有 queue/slot/lease/listener 释放。

### 9.12 ARK-13：host `retryOf`

可信 host 先创建 root run record。旧 child 完成一次真实 provider generate 后，测试私有 Executor failpoint 在处理该响应时注入非恢复型 `EXECUTOR_FAILED`，使旧 task 确定进入 failed；不依赖普通 Tool handler 抛错是否继续模型循环的未定义策略。随后 host 使用旧 taskId 作为 `retryOf`，以同一个 definition name/version、当前允许的另一个 Executor 创建新 task；新 child 按 proof/result/end 三次真实调用成功。

必须断言：旧终态不变，新 taskId/subagentSessionId、attempt=1，retryOf 正确，descendant/timeout/concurrency/budget 重新消费，允许更换 Executor但不得更换 definition version。鉴于模型 Tool wire 禁止 taskId/retryOf，本验收把 retry 定义为 host-only；若产品仍要求“父模型发起 retry”，必须先在技术设计中增加不暴露模型可控 taskId 的可信关联机制，再增加对应 L5 场景。

### 9.13 ARK-14：根 Agent failed outcome

Responses root 的 prompt 只要求返回一个 standalone `end-agent`；Observed Model 先验证真实 provider 响应恰好包含该 Tool call 且无 prose，并完成 adapter wire 校验，再由测试私有 failpoint 在把结果交回 Agent 前抛出已脱敏的稳定 adapter failure。框架的 model error recovery 为 0，不能再调用 provider。

必须断言：root `AgentRunOutcome.status=failed`，原 sessionId/runId 和安全 `AgentRunError` 存在，context/run record 与事件终态一致，没有 Subagent task、审批或恢复记录，raw provider error/response/stack 不进入 outcome、事件、stdout 或 artifact，所有 signal/listener/timer 被释放。它与其他场景共同覆盖 succeeded、waiting_approval、cancelled、failed 四种根 outcome；该 failpoint 只属于验收 Model wrapper，不扩张公共 Model API。

### 9.14 Phase 2/3 真实 placement 扩展

Phase 1 的 110/112 预算只验收 Local placement。新增 Worker Thread、Child Process、Remote 或生产 Executor 时，先通过 conformance/L6，再运行独立 placement profile：

- 每个 Executor 至少运行 Chat parent→Responses child 与 Responses parent→Chat child 的 typed happy path。
- Worker/Child Process 还要在三个窗口分别 crash/kill，并使用固定 oracle：SDK create 已发出但没有持久化规范化响应时标记原 task failed + `EXECUTOR_FAILED`/`outcomeUnknown=true`，不 resume/reconnect/自动重发，只有可信 host 可显式创建 `retryOf` 新 task；result receipt CAS 成功后按 ARK-10A 保留 partial 并失败；terminal CAS 成功后按 ARK-10B 只读原 terminal outcome。三者都不得 create 替代原 task。
- Remote template 使用真实方舟 child job 演示幂等 create、controller 断线、external binding reconnect、approval resume 和 terminal reconnect；任何路径都不能 create 替代 job。
- Phase 3 DB/queue/container adapter 至少运行一条真实方舟跨协议 happy path和一条滚动升级/旧版本恢复路径，其余多节点混沌仍由确定性 provider fixture 控制成本。

placement profile 使用自己的静态 scenario manifest、call/token ledger、精确调用合计和 CLI acknowledgement，不占用或复用 Phase 1 的 112 次 ledger。它验证的是 child task 执行位置，父 Agent 控制权始终不转移。

各 profile 的精确 SDK attempt 与灾损硬上限冻结如下；runner 从各自静态 manifest 复算，合计不一致时在任何 provider 调用前失败：

| Profile                            | 精确 SDK attempts | 灾损硬上限 |
| ---------------------------------- | ----------------: | ---------: |
| standalone smoke                   |                24 |         24 |
| Worker placement                   |                19 |         21 |
| Process placement                  |                19 |         21 |
| HTTP Remote placement              |                11 |         13 |
| BullMQ placement + rolling upgrade |                15 |         16 |
| Docker placement + rolling upgrade |                15 |         16 |
| Core full ARK-01～14               |               110 |        112 |
| **合计**                           |           **213** |    **223** |

## 10. 确定性覆盖矩阵

### 10.1 定义、目录与 Executor 路由

| ID     | 场景与核心断言                                                                                            | 层级  |
| ------ | --------------------------------------------------------------------------------------------------------- | ----- |
| DEF-01 | name/version/description 空白、超限、保留 Tool 名冲突在 init 失败。                                       | L0/L1 |
| DEF-02 | active catalog 同 name 多 active version 拒绝；一个 active 与多个 recovery-only 可共存。                  | L1    |
| DEF-03 | recovery-only 不进入模型 schema、不能 create；存量任务可按精确版本恢复。                                  | L1/L3 |
| DEF-04 | active 升级后历史 factory/binding 仍可恢复，不能自动升级或按 semver 猜测。                                | L2/L3 |
| DEF-05 | allowedNames 省略、空数组、命中/未命中和 requiredCapabilities 强交集。                                    | L1    |
| DEF-06 | catalog 排序/schema/revision 稳定；构建模型请求不隐式访问网络。                                           | L1    |
| DEF-07 | unavailable 隐藏；degraded 按显式 host policy；模型目录无 ID/factory/binding/recoveryData/prompt。        | L1/L5 |
| DEF-08 | 所有组合被过滤后的空目录按实施前确认规则移除 `agent` Tool 或暴露固定不可调用形态，且模型不能制造 create。 | L1/L4 |
| EXE-01 | Executor 重名、空 name、无效 adapterStateVersion、矛盾 capability 在 init 失败。                          | L1    |
| EXE-02 | supportedDefinitions、supports、allowlist、capability、availability 取保守交集。                          | L1/L2 |
| EXE-03 | checkpoint 可满足 same_process 要求，反向不成立；external reconnect 只由 external_binding 满足。          | L1    |
| EXE-04 | snapshot 后下线由 Router 二次校验，返回刷新目录且不 create/消费/fallback。                                | L1/L5 |
| EXE-05 | 不支持的方法仍稳定返回 `UNSUPPORTED_CAPABILITY`；Core 不暴露 raw handle。                                 | L1/L2 |
| EXE-06 | binding 固定字段、codec、adapter version 任一篡改都在 Executor operation 前拒绝。                         | L1/L2 |

### 10.2 输入、输出、身份与幂等

| ID    | 场景与核心断言                                                                                                                                                           | 层级     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| IO-01 | 模型 Tool、host execute/spawn、远端入站分别重新 Zod parse，不能信任上一边界。                                                                                            | L1/L2/L5 |
| IO-02 | undefined、bigint、NaN、Infinity、Date、Map、函数、symbol、循环对象等非 JSON-safe 值拒绝。                                                                               | L1       |
| IO-03 | input 只作为结构化 task data；不进入 framework/child system prompt。                                                                                                     | L1/L5    |
| IO-04 | input/output/projection 在等于上限时通过，超一字节/一项时稳定失败。                                                                                                      | L1       |
| IO-05 | outputSchema 不匹配不进入 result_submitted；非 JSON-safe output 单独返回对应错误。                                                                                       | L1/L2    |
| IO-06 | child output 中的“批准、换 Executor、修改权限”只作为数据，不改变控制面。                                                                                                 | L1/L5    |
| ID-01 | 每次新 root `agent()` 创建新 runId；只有 `resumeRun` 使用原 runId。                                                                                                      | L1       |
| ID-02 | pause/resume/reconnect 保持 sessionId/runId/taskId/subagentSessionId，nested 继承根 owner/run。                                                                          | L1/L3/L5 |
| ID-03 | session/run/task/subagent/approval/binding 永不出现在模型 Tool schema 或可控文本解析。                                                                                   | L1/L5    |
| ID-04 | 同 session 的 get/wait/cancel/resume/reconnect/child-session query 成功；跨 session 全部拒绝且不泄露存在性。                                                             | L1       |
| ID-05 | model 路径 runId+callId、host 路径按最终确认作用域使用 requestId 形成唯一幂等索引；重放返回同 task。                                                                     | L1/L3    |
| ID-06 | 同 key 但 definition/executor/canonical input hash 不同返回冲突。                                                                                                        | L1       |
| ID-07 | input parse/hash 后优先查幂等记录；原 task 创建后即使 Executor 下线、budget 耗尽、projector 改变/抛错或当前 limits 已满，合法 replay 仍直接返回原 task，不重跑这些步骤。 | L1/L3    |
| ID-08 | 业务 retry 创建新 task/subagentSession、attempt=1、保留旧终态并写 retryOf。                                                                                              | L1       |
| ID-09 | retry 指向允许的旧终态且必须同 definition name+version；可换当前允许 Executor；recovery-only 版本不能 retry create；retry 重新消费全部限制。                             | L1/L5    |
| ID-10 | 同一个有状态 Agent 实例并发 `agent()`/`resumeRun()` 拒绝，独立 task 可并发。                                                                                             | L1       |
| ID-11 | 两调用/双进程并发使用相同 requestId：同 payload 只创建一个 task，冲突 payload 只一个成功；不同 session/run 的相同 requestId 按最终作用域产生明确结果。                   | L1/L3    |

### 10.3 状态机、Result Controller 与 end-agent

| ID     | 场景与核心断言                                                                                   | 层级  |
| ------ | ------------------------------------------------------------------------------------------------ | ----- |
| STA-01 | `queued → running → result_submitted → succeeded` 完整 happy path。                              | L1/L5 |
| STA-02 | queued 的 cancel/timeout/budget 直接终态，不启动 Executor。                                      | L1    |
| STA-03 | 只有 approval 产生 `waiting_approval` 与 `paused(reason=approval)`。                             | L1/L5 |
| STA-04 | 故障 checkpoint 保持 `running + recoveryRequired`，不产生额外 paused/recovering 状态。           | L1/L3 |
| STA-05 | waiting_approval 释放执行槽；resume 后重新排队/占槽。                                            | L1/L2 |
| STA-06 | cancel/result/end/timeout/budget 并发时首个合法 fenced CAS 胜出，最终只有一个不可逆终态。        | L1    |
| STA-07 | terminal external reconnect 只读返回原 outcome；任何 terminal operation 不重新推进。             | L1/L2 |
| STA-08 | 每个非法状态转换返回稳定 `INVALID_STATE_TRANSITION`，且无事件/handler 副作用。                   | L1    |
| RES-01 | 首次有效 result 保存 canonical output、SHA-256 hash、callId、receiptId、时间和 schema version。  | L1/L5 |
| RES-02 | 同 callId+同 hash 重放返回原 receipt、无重复事件；同 callId 异 payload 冲突。                    | L1/L3 |
| RES-03 | 不同 callId 第二次提交拒绝，第一次 output 永不覆盖。                                             | L1    |
| RES-04 | canonical object key 顺序不影响 hash、数组顺序影响 hash；所有 Executor 使用同一 golden vectors。 | L1/L2 |
| RES-05 | 无 result 的 end 返回 `RESULT_REQUIRED`；合法 end 必须 standalone。                              | L1    |
| RES-06 | result+end 同轮只提交 result 并拒绝 end；end 与其他 calls 同轮只拒绝 end；多个 end 全拒绝。      | L1/L4 |
| RES-07 | end 批级校验在任何 handler 前完成。                                                              | L1    |
| RES-08 | result_submitted 后普通 Tool、新审批、nested dispatch、新 result 全部拒绝且 handler=0。          | L1    |
| RES-09 | result/terminal CAS 前后崩溃重放幂等；result 后失败/cancel/timeout/budget 保留 partialOutput。   | L1/L3 |
| RES-10 | progress 只产生事件，不满足 outputSchema、不改变 result/task state。                             | L1/L2 |

### 10.4 审批、恢复与重连

| ID     | 场景与核心断言                                                                                           | 层级     |
| ------ | -------------------------------------------------------------------------------------------------------- | -------- |
| APP-01 | pending Tool call checkpoint 在 `authorizeTool` 之前；suspend 后 handler=0。                             | L2/L3/L5 |
| APP-02 | 决策仅来自可信 host API；模型文本、input、Tool output 不能批准。                                         | L1/L5    |
| APP-03 | approved 用同 task/callId 恢复且 handler 只一次；reject/expire/cancel 分别映射正确终态。                 | L1/L2/L5 |
| APP-04 | 同 decision/revision 重放幂等；冲突 decision 或旧 revision 返回 `APPROVAL_CONFLICT`。                    | L1/L3    |
| APP-05 | 多 child approvals 聚合、逐个决定，全部解决后父模型才继续。                                              | L1/L5    |
| APP-06 | blocking execute 暂停 root；background spawn 只暂停自身。                                                | L1/L5    |
| APP-07 | approval 期间 task timeout 冻结，approval expiresAt 独立生效。                                           | L1       |
| APP-08 | 聚合审批中一个 reject 时该 task 失败，其他 pending approval/兄弟状态、事件和 slot 按设计清理且不误批准。 | L1/L3    |
| REC-01 | `resume(approval)` 只接受 waiting_approval+有效 decision。                                               | L1/L2    |
| REC-02 | `resume(checkpoint)` 只接受 running+recoveryRequired、checkpoint capability、失效旧 lease。              | L1/L3    |
| REC-03 | same_process 只在原进程且原 handle 存活时恢复；否则 target lost。                                        | L2/L3    |
| REC-04 | Atomic File 在新进程 checkpoint resume 原 task；不改变任何稳定 ID。                                      | L3/L5    |
| REC-05 | reconnect 只用于 external_binding 原 job；checkpoint-only Executor 拒绝。                                | L1/L2    |
| REC-06 | reconnect 到 waiting_approval 后仍先由 host decision，再 approval resume。                               | L1/L2    |
| REC-07 | 外部 job 丢失返回 `RECOVERY_TARGET_LOST`；resume/reconnect 的 create 次数始终为 0。                      | L1/L2    |
| REC-08 | definition/executor/adapter/checkpoint/binding mismatch 确定失败，绝不 fallback。                        | L1/L3    |
| REC-09 | 无 checkpoint migrator 时版本不匹配确定失败；有 migrator 时原记录保持不可变。                            | L3       |

Phase 1 的 external reconnect 由 fake external Executor 证明 Core 契约；官方 Local Executor 必须声明 reconnect=`none`。Phase 2 再由 Remote template 运行同一条件用例。

### 10.5 批处理、限制、预算与 signal

| ID     | 场景与核心断言                                                                                 | 层级     |
| ------ | ---------------------------------------------------------------------------------------------- | -------- |
| SCH-01 | 混合批次普通 Tools 按相对顺序串行 settle。                                                     | L1/L4    |
| SCH-02 | 普通阶段全部结束后才一次性 submit agent sub-batch；两阶段不重叠。                              | L1/L5    |
| SCH-03 | 同批 child 实际并发不超过 maxConcurrent，结果按 provider call 顺序回填。                       | L1/L4/L5 |
| SCH-04 | 一个 child 失败/取消/超时不自动取消兄弟。                                                      | L1/L5    |
| SCH-05 | A 已完成、B 审批暂停后重启：A 不重跑，B 用原 task/callId 继续。                                | L3/L5    |
| SCH-06 | root cancel fan-out 所有非终态后代；单 child cancel 不影响兄弟。                               | L1/L2    |
| SCH-07 | queued cancel/timeout 不创建 binding；所有退出路径释放 queue/slot/lease/timer/listener。       | L1/L2    |
| LIM-01 | root depth=0；depth 边界允许、超一层拒绝。                                                     | L1       |
| LIM-02 | self recursion 默认拒绝；allowSelf 后仍受 depth/descendants/concurrency/budget。               | L1       |
| LIM-03 | descendants 包含 retry，不包含 idempotent replay。                                             | L1       |
| LIM-04 | maxTurns 跨 resume/reconnect 累计，不能重置。                                                  | L1/L5    |
| LIM-05 | timeout 统计 queued/running/recovery；approval 冻结；resume 用 remainingMs 重建 deadline。     | L1/L3    |
| BUD-01 | 并发 siblings 在同一 ledger 原子预留调用预算，不超卖。                                         | L1       |
| BUD-02 | provider calls/input tokens/output tokens/cost 预留与结算；真实方舟 usage 可用时与记录一致。   | L1/L5    |
| BUD-03 | budget 拒绝产生 budget_exceeded 终态、`task.budget_exceeded` 与 `budget.rejected`。            | L1       |
| BUD-04 | usage=none 不宣称 token/cost 硬限制；definition/host policy 可将其过滤。                       | L1       |
| ABT-01 | AbortSignal 贯穿 queue、Executor wait、Model、Tool、summary、recovery 和 adapter SDK options。 | L1/L2/L4 |
| ABT-02 | abort/cancel/timeout 不进入普通 model retry 或 context-length recovery。                       | L1/L5    |

### 10.6 上下文、Skills、压缩、嵌套与协议

| ID      | 场景与核心断言                                                                                   | 层级     |
| ------- | ------------------------------------------------------------------------------------------------ | -------- |
| CTX-01  | 无 projector 时 projection 为空；父 transcript/raw/Tools/Skills/system/app state 不继承。        | L1/L5    |
| CTX-02A | text/data projection 正确、受大小限制并在 Executor 边界重验；ARK-01 使用显式 marker。            | L1/L2/L5 |
| CTX-02B | artifact projection 的 schema/授权/解析/大小/远端可达性正确；ARK-03 读取受信 fixture。           | L1/L2/L5 |
| CTX-03  | projector 异常时 task 不创建，返回 `CONTEXT_PROJECTION_FAILED`。                                 | L1       |
| CTX-04  | projection 作为标记 task context，不拼入 framework system prompt。                               | L1/L5    |
| CTX-05  | 父 raw history 只含 terminal Tool envelope，不含 child transcript。                              | L1/L4/L5 |
| CTX-06  | context compact 与父 checkpoint 同事务；恢复不重复 summary/compactor。                           | L1/L3/L5 |
| CTX-07  | summary/input/result replacement 不破坏 pending batch、callId、binding、receipt 或 raw history。 | L1/L3/L5 |
| SKL-01  | child 无自动 Skills；只有 Executor factory 显式配置后才有 descriptor/load/read/run。             | L1/L5    |
| SKL-02  | Skill reference/asset/script 与现有安全断言保持；script 明确为宿主 Node.js 非沙箱代码。          | L1/L5    |
| NEST-01 | delegation 默认 none，目录为空；allowlist 只暴露 active、允许、可用组合。                        | L1/L5    |
| NEST-02 | task-scoped client 固定 owner/run/parent/path/depth/budget，child API 无覆盖字段。               | L0/L1    |
| NEST-03 | allowlist 含自身但 allowSelf=false 仍拒绝；allowSelf=true 后受全局限制。                         | L1       |
| NEST-04 | result_submitted 后 nested dispatch 返回 `RESULT_PHASE_CLOSED`。                                 | L1       |
| PRO-01  | Chat parent → Chat child。                                                                       | L4/L5    |
| PRO-02  | Chat parent → Responses child。                                                                  | L4/L5    |
| PRO-03  | Responses parent → Chat child。                                                                  | L4/L5    |
| PRO-04  | Responses parent → Responses child。                                                             | L4/L5    |

每个 `PRO-*` 都要复用同一 typed fixture，断言父协议 Tool result、child 协议隔离、callId 闭环、错误/partial envelope、signal、canonical hash 和结果顺序。

### 10.7 StateStore、WAL、lease、事件与脱敏

| ID     | 场景与核心断言                                                                                                                                         | 层级     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| STO-01 | createRun 的 ownerSessionId+runId 唯一；task、run-scoped idempotency、child-session 索引同事务创建，transaction-local read/index 可见本事务 mutation。 | L1       |
| STO-02 | Agent/Runtime 必须使用同一 StateStore 实例和 transactionDomainId，错配 init 失败。                                                                     | L1       |
| STO-03 | task/run revision CAS 冲突只有一个成功。                                                                                                               | L1       |
| STO-04 | 父 run、child task、budget、审批和事件原子提交，无半状态。                                                                                             | L1/L3    |
| STO-05 | lease acquire/renew/release 与 TTL 正确；新 owner fencing token 单调更高。                                                                             | L1/L3    |
| STO-06 | 旧 owner 延迟恢复后所有 CAS 被拒；两进程争抢只有最新 fencing owner 推进。                                                                              | L3       |
| STO-07 | temp write、fsync、commit marker、snapshot apply、atomic rename、cleanup 各阶段崩溃恢复。                                                              | L3       |
| STO-08 | 只重放带 commit marker 的事务；run/task/budget/event 不能半提交。                                                                                      | L3       |
| STO-09 | commit 成功但调用方未收到响应时，重放保持同 task/receipt/decision。                                                                                    | L3       |
| STO-10 | terminal、result receipt、approval decision 不可回滚覆盖。                                                                                             | L1/L3    |
| STO-11 | File Store 只在本机磁盘受控 failover 验收，不扩张为网络 FS/通用多写一致性声明。                                                                        | 文档门禁 |
| STO-12 | 截断但带 marker 的 journal、checksum mismatch、磁盘满、权限拒绝、fsync/atomic rename 失败都安全终止，无半事务并释放 lease。                            | L3       |
| STO-13 | Runtime 目录 owner-only ACL、可选加密 codec、无 key/provider body；未 opt-in 的残留目录使安全门禁失败。                                                | L3/L5    |
| OBS-01 | 每个事件含 session/run/task/parent/path/definition/executor/attempt/time。                                                                             | L1       |
| OBS-02 | task sequence 严格递增、eventId 全局去重；afterSequence 续读无丢失/重复。                                                                              | L1/L2    |
| OBS-03 | queued/started/approval/result/terminal/recovery/budget/usage/progress 事件齐全。                                                                      | L1/L5    |
| OBS-04 | 事件与对应 state mutation 同事务。                                                                                                                     | L1/L3    |
| OBS-05 | root run span → task span → model/tool spans 层级正确。                                                                                                | L1/L5    |
| OBS-06 | 默认事件、错误、stdout 和 artifact 不含 prompt/args/output/key/provider body/recoveryData。                                                            | L1/L5    |
| OBS-07 | Executor/provider 异常映射为 safe code/cause，不泄露原始异常体。                                                                                       | L1/L2/L5 |

### 10.8 Agent 集成、公共契约与父 checkpoint

| ID      | 场景与核心断言                                                                                                                                                                                             | 层级     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| API-01  | 包根导出 v2 Definition/Runtime/Executor/StateStore/Result/Approval/Handle/RunOutcome；legacy `subAgents`、`AgentConstructor`、`AgentInstance` 构造器契约与动态 RuntimeSubAgent 出口消失。                  | L0       |
| API-02  | 内置 `agent` schema 只有 `{ subAgent, executor, input }`；根 object + `oneOf` 可被 schema converter 接受，Router Zod discriminated union 不降级。                                                          | L0/L1/L4 |
| API-03  | Core 编译和依赖图不引用 concrete Executor；Local Executor 只依赖 Core contracts。                                                                                                                          | L0       |
| API-04  | public types、Tool wire、events 和 state 中没有 handoff/active-agent ownership transfer；父 run 始终拥有 child 调度与最终 Tool result。                                                                    | L0/L1/L5 |
| API-05  | Core 导出协议无关 `SubAgentChildRunner`/completion SPI；Local/Worker/Process runner 注入 typed result/end，Core 依赖图不反向引用实现。                                                                     | L0/L2    |
| PRO-05  | Chat/Responses versioned checkpoint codec 可跨进程恢复；custom protocol 无 codec 时 durable/cross-process init 失败但 Memory same-process 可用。                                                           | L1/L3/L4 |
| INIT-01 | `createSubAgentRuntime()` 同步返回、`await runtime.init()` 异步校验 supports/codec/migrator；`Agent.init()` 只接受 ready Runtime；availability 仅由 `refreshCatalog()` 更新 revision。                     | L1       |
| INIT-02 | 保留名 `agent-result`/`end-agent` 与 child 自定义 Tool 冲突在 init 失败。                                                                                                                                  | L1/L2    |
| INIT-03 | Definition/Executor/StateStore/保留名的所有配置错误都在 `init()` 阶段、任何 Model/Executor operation 或网络访问前失败，且不留下半初始化 registry/run/task。                                                | L1       |
| TOOL-01 | 装饰器与运行时 handler 的第二参数都收到正确 session/run/task/call/signal/deadline；只声明第一个参数的 handler 仍可运行。                                                                                   | L0/L1    |
| TOOL-02 | child Tool、Model、summary 和 error recovery 共享同一 runtime signal/deadline；取消后没有后续 handler/provider 调用。                                                                                      | L1/L2/L4 |
| RUN-01  | 父 checkpoint 在 assistant Tool-call 已写入、暂停 call result 未写入的精确位置提交。                                                                                                                       | L1/L3    |
| RUN-02  | checkpoint 完整保存 provider call 顺序、已完成兄弟结果、未完成 task/binding、open-loop/context revision、compact transaction、endRequested、iteration/remaining turns、tree budget 与全部 schema version。 | L1/L3    |
| RUN-03  | `resumeRun` 同事务校验 session/run/revision/lease、提交 approvals、选择唯一 resume/reconnect 路径并复用已完成结果。                                                                                        | L1/L3/L5 |
| RUN-04  | 恢复后所有 terminal envelopes 按原 call 顺序回填，关闭原 open-loop span，再继续下一轮；不生成新 runId。                                                                                                    | L1/L3/L4 |
| RUN-05  | Agent、task、definition、Executor adapter 任一 checkpoint schema version 不匹配时确定失败；没有迁移器不得静默读取。                                                                                        | L1/L3    |
| RUN-06  | checkpoint 发生在 summary/Tool compact transaction 各阶段时，恢复既不重复 provider summary/compactor，也不丢 raw/active revision。                                                                         | L1/L3    |
| RUN-07  | `AgentRunOutcome` 的 succeeded、waiting_approval、cancelled、failed 四种形态分别校验 sessionId/runId/context/error 与持久状态。                                                                            | L0/L1/L5 |
| RUN-08  | 未配置 SubAgent Runtime 的普通 Agent 仍接收并传播 AbortSignal，且不会创建 Subagent task/state。                                                                                                            | L1/L4    |

## 11. 稳定错误码覆盖

每个公共错误码至少有一个精确测试，不能只检查“抛错”：

| Requirement | 测试组                    | 必须覆盖的错误码                                                                                                                                   |
| ----------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| ERR-01      | Definition/Input          | `DEFINITION_NOT_FOUND`、`DEFINITION_VERSION_MISMATCH`、`INVALID_INPUT`、`INVALID_OUTPUT`、`OUTPUT_NOT_JSON_SAFE`、`CONTEXT_PROJECTION_FAILED`      |
| ERR-02      | Executor/Binding          | `EXECUTOR_NOT_FOUND`、`EXECUTOR_DISALLOWED`、`EXECUTOR_UNAVAILABLE`、`UNSUPPORTED_CAPABILITY`、`BINDING_INVALID`、`ADAPTER_STATE_VERSION_MISMATCH` |
| ERR-03      | Session/Idempotency/State | `SESSION_MISMATCH`、`IDEMPOTENCY_CONFLICT`、`INVALID_STATE_TRANSITION`                                                                             |
| ERR-04      | Result/End                | `RESULT_REQUIRED`、`RESULT_ALREADY_SUBMITTED`、`RESULT_REPLAY_CONFLICT`、`RESULT_PHASE_CLOSED`、`END_AGENT_MUST_BE_STANDALONE`                     |
| ERR-05      | Approval/Delegation       | `APPROVAL_REQUIRED`、`APPROVAL_REJECTED`、`APPROVAL_EXPIRED`、`APPROVAL_CONFLICT`、`CHILD_DEFINITION_DISALLOWED`                                   |
| ERR-06      | Recovery/Limits           | `RECOVERY_UNSUPPORTED`、`RECOVERY_TARGET_LOST`、`LIMIT_EXCEEDED`、`BUDGET_EXCEEDED`、`TIMED_OUT`、`CANCELLED`                                      |
| ERR-07      | Adapter/Internal          | `EXECUTOR_FAILED`、`INTERNAL_ERROR`                                                                                                                |

每项同时断言 `safe message`、`retryable`、`causeCode` 和必要 ID 的白名单形态；模型、普通事件和 artifact 都不得出现原始 cause、stack 或 provider body。

## 12. Executor conformance

`runExecutorConformance(factory, advertisedCapabilities)` 对每个 Executor 运行同一套参数化合约：

| Requirement | 合约                                                                                   |
| ----------- | -------------------------------------------------------------------------------------- |
| CONF-01     | `execute()` 与 `spawn().wait()` 对同一 fixture 产生等价规范化 outcome。                |
| CONF-02     | create idempotency、handle snapshot/wait/events/cancel 和 terminal 不可逆。            |
| CONF-03     | queued/running/approval/terminal 的 binding、attempt、usage 和事件一致。               |
| CONF-04     | cancel/timeout/error 的 signal 与 slot/lease/listener 清理。                           |
| CONF-05     | descriptor 声明支持的 approval/resume/reconnect/usage 条件用例必须全过。               |
| CONF-06     | descriptor 声明不支持的能力仍验证稳定 `UNSUPPORTED_CAPABILITY`，方法不能为 undefined。 |
| CONF-07     | Executor 异常、process exit、network loss 映射为 Core safe error。                     |
| CONF-08     | canonical output hash 与 Core golden vectors 一致。                                    |

适配器门禁：

| Executor            | 必须能力与专项用例                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Local + Memory      | execute/spawn/cancel/events/approval/usage；官方 descriptor 为 checkpoint；Memory Store 仅能在原进程提供该 checkpoint，进程退出后 target lost。 |
| Local + Atomic File | Memory 全部能力；checkpoint resume、WAL、lease/fencing、双进程争抢、重启恢复；reconnect=`none`。                                                |
| Worker package      | `maneeagent-executor-worker`：IPC schema 重验、signal/cancel、worker crash、checkpoint/result/event sequence 恢复，reconnect=`none`。           |
| Process package     | `maneeagent-executor-process`：Worker 契约 + kill/exit 分类、stdio/IPC 脱敏、孤儿进程清理，reconnect=`none`。                                   |
| HTTP package        | `maneeagent-executor-http`：TLS + HMAC-SHA256 v1、幂等 create、heartbeat、event cursor、approval/resume/external reconnect。                    |
| Phase 3 packages    | PostgreSQL 权威状态/outbox、BullMQ 投递/DLQ、Docker 隔离、S3 artifact 加密与 OTel bridge 分别通过 adapter/L6 门禁。                             |

新 Executor 不能仅通过一条真实方舟 happy path 声称兼容；必须先通过 conformance，再运行对应 placement 的真实方舟 smoke。

Phase 2/3 的 L6 运维契约还要按 adapter 能力运行以下门禁：

| Requirement | 场景与核心断言                                                                                                                                                          | 阶段 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| L6-01       | transport 在进入 Core 前完成认证/授权并映射可信 session；缺失、越权和仅猜中 sessionId 都拒绝，模型选择 Executor 不构成授权。                                            | 2/3  |
| L6-02       | TLS + HMAC-SHA256 v1 的 keyId/timestamp/nonce/bodyDigest、时钟窗口、分布式 replay cache，以及 payload/binding/schema 正反例；secret/recoveryData 不入日志、事件或 DLQ。 | 2/3  |
| L6-03       | heartbeat 健康、迟到、断开和恢复驱动 availability revision；目录构建不联网，Router 执行前仍复核且不 fallback。                                                          | 2/3  |
| L6-04       | create/result/event/decision 的重复、乱序、迟到和 reconnect cursor 均幂等；unknown outcome 不创建替代 job。                                                             | 2/3  |
| L6-05       | 旧 worker drain、滚动升级、definition/adapter/checkpoint 版本偏斜、显式 migrator 成败和回滚策略全部有证据。                                                             | 2/3  |
| L6-06       | 宿主 tenant/principal 配额与审计在 Core 外接入；越权/超配额在调用 Runtime 前拒绝，Core report 只保留可信 session 级安全字段。                                           | 3    |
| L6-07       | `KeyProvider` AES-256-GCM 信封加密、S3/MinIO 明文 SHA-256、密钥轮换、短时授权、retention/orphan 清理符合 adapter 运维契约。                                             | 3    |
| L6-08       | queue retry 只重送同一幂等 operation，poison message 进入脱敏 DLQ；redrive 不跨版本、不绕过审批、不重复业务副作用。                                                     | 3    |
| L6-09       | 长时间 soak、网络分区、进程/节点滚动重启、背压和高并发后，无孤儿 job、slot/lease/listener/timer 泄漏或 sequence 缺口。                                                  | 3    |
| L6-10       | 多节点同时恢复、网络分区愈合和旧消息迟到时只有最新 fencing owner 能推进，terminal/receipt/approval 不可回滚。                                                           | 3    |

L6-01/02 使用本地 transport test double 即可验证模板 hook，不要求 Core 自建认证系统；Phase 3 则必须由实际生产 adapter 的部署级 harness 提供证据。长时间 soak 与混沌测试使用 scripted provider 控制成本，结束时再运行 9.14 的少量真实方舟 placement profile。

### 12.1 C7 Transport/Placement 固定验收 Oracle

- Transport：closed envelope、错版本/额外字段、16 MiB 边界、JCS digest、双向连续 sequence、same-ID/canonical-envelope replay、same-ID/different-semantics conflict、sidecar 无序重放、sequence gap，以及 execution `remainingMs` 本地重建 deadline；`2^31` 与 `2^32 ms` 长 timeout 必须保持原时长并可取消，不能触发 Node timer overflow 或 1 ms 退化。
- 生命周期：`reconstructSubAgentExecutionRequest()` 必须返回 `{ request, dispose }`；正常 settle、失败、取消和长 timeout 都要证明 listener/timer 被幂等释放。Peer writer 必须同步返回 admission receipt；throw/void/Promise/非法 receipt 在调用返回前失败，可选 I/O `settled` 不得串行阻塞反向 control。准入前 abort 不发送、不提交 sequence、不留 tombstone；准入后 abort/timeout 才保留 tombstone 校验并吞掉迟到 reply。Peer 与 execution reconstruction 的超长 timeout 都必须分段调度。Peer 的 spawn 只允许 `accepted → settled(mode: 'spawn')`，或绑定提交前 direct `unbound_create` recovery settlement；soft drain 预留 settlement headroom 并允许 active-task continuation，hard sequence bound 才 fail-close。
- Worker retention：终态释放 Worker/Peer/Port/timer 等重资源，但 create/cancel 的 compact terminal receipt/tombstone 必须保留以支持幂等重放；`maxRetainedTasks` 不得 LRU 删除这些证据。容量耗尽时新 task fail closed，直到 Executor `dispose()`；当前没有公开的逐 task retention 删除 API。
- 入站重验：definition/runner/checkpoint/adapter identity、Zod input、JSON-safe、projection/artifact limits 和 binding/outcome/control payload；任何失败发生在 child runner/Core mutation 前。
- 恢复窗口：unbound create 只重放原 operation；完整 checkpoint crash 使用原 task/binding，attempt、epoch、fencing 按恢复规则推进且 reconnect count 为 0；provider `in_flight` 为 `failed + outcomeUnknown`；result receipt 窗口为 `failed + partial`；terminal CAS 后重放只读原 terminal。每次 live dispatch 最多自动恢复一次。
- Worker/Process：严格环境白名单、secret 不进 env/argv/stdout/stderr/binding；protocol cancel、5 秒 kill fallback、exit/close 分类和无孤儿资源；两者 `reconnect=none`。
- HTTP/HMAC：method/path/body/timestamp/nonce/signature 全部篡改负例，正负 60 秒边界、120 秒原子 replay TTL、统一安全 401、session authorization、幂等 create/control reply、heartbeat 30/60 秒阈值、cursor 断线重连、lost job 不 create 替代。
- Reply 关联：accepted binding、terminal/paused task identity、已知 executor 必须与原 execution request 一致；events page 不得超过请求 limit，所有 sequence 必须大于 cursor，`nextSequence` 必须等于末项或空页原 cursor，不能跳读。
- Artifact sidecar：三种 transport 都验证 byte length 与 SHA-256；拒绝 Proxy、shadowed typed-array 属性、ArrayBuffer `slice`/`Symbol.species` 绕过与源 mutation，确保 handler 只收到普通 owned copy。JSON envelope 不允许携带大块 base64 数据，binding/job/event/error 不含路径、URL、cursor 或 credential。

Phase 2 manifest 分为 `C7-TRANSPORT`、`C7-WORKER`、`C7-PROCESS`、`C7-HTTP`、`C7-AUTH` 与 `C7-PACK`，并显式映射 CONF-01～08、L6-01～05 和 F02/F08/F09/F12～F19。默认 `pnpm test` 只加入已经实现 adapter 的无外网 unit/conformance；真实 Worker 与 Process crash/lifecycle 分别由 `pnpm acceptance:subagent:v2:worker:offline` 和 `pnpm acceptance:subagent:v2:process:offline` 独立运行，后续再与 HTTP loopback 汇入完整 `acceptance:subagent:v2:phase2:offline`。真实方舟始终需要显式凭证和调用确认。

当前 closed envelope、sequence/replay、execution wire 与 recoverable settle 四项 L1 证据单列为 `C7-TRANSPORT-FOUNDATION`；14-kind strict RPC、16-method control dispatcher/proxy、32 MiB artifact sidecar 与双向 Peer 已分别映射 `rpc-outcome`、`rpc-control`、`artifact-sidecar`、`rpc-peer`，因此 `C7-TRANSPORT` requirement 已改为 `implemented`。C7c-1 的 target registry、controller/target bridge 和 Model gateway 分别登记在 `C7-TARGET-REGISTRY`、`C7-BRIDGE` 与 `C7-MODEL-GATEWAY`；覆盖 owner/session scope、handle/receipt 生命周期、canonical decimal fencing、execution-scoped control/Model、跨 Handler single-flight、Chat/Responses reply-loss replay、显式 in-flight recovery oracle 与官方 credential-free protocol surface。C7c-5 的 Core prerequisite 另由 `subagent-transport-external-reconnect.test.ts` 锁定同进程 checkpoint full-exchange ordering/gap、Model admission/single-flight/outcome-unknown、fresh channel fence、soft quiesce、detached retry、factory deadline 与旧异步 reply；它不是 HTTP adapter/manifest evidence。C7c-2 又登记了 `C7-WORKER-01`～`C7-WORKER-29`：01～11 覆盖 L1/L2/L4 conformance、静态 target、环境/secret、binding、Chat/Responses proxy 与 transferable sidecar，12～29 通过真实 `worker_threads` 覆盖 handshake、cancel/terminate、crash/checkpoint、scope/capacity/cleanup 和恢复故障窗。其中 20/21/25 固定 F19，28 固定 F08，29 固定 F09。C7c-3 登记 `C7-PROCESS-01`～`C7-PROCESS-32`：01～11 以 Process adapter 覆盖同一 conformance/Model/binding/advanced sidecar，12～29 使用真实 OS child process 覆盖 handshake、cancel/kill、exit/close、crash/checkpoint 和 F08/F09/F19，30～32 再锁定固定 fork 契约、IPC backpressure/callback settle 与 controller 断连 orphan watchdog。双向 sendHandle 拒绝和 exit-before-close stdio drain 作为 15/23 的附加 L3 case 单独登记。C7c-4 登记 `C7C-HTTP-MP01`～`MP05` 与 `AUTH01`～`AUTH07`，C7c-5b 再登记 `POLL01`～`POLL02`、`RECEIPT01` 与 `ROUTE01`，C7c-5c 登记 `STORE01`、`STORE02`、`STORE05`、`STORE06`、`STORE08` 与 `STORE09`，C7c-5d-a 再登记 current-attachment delivery/ACK/wait 的 `STORE04` 与 `STORE07`，C7c-5d-b 登记 `DELIVERY01`～`DELIVERY04`；它们锁定 closed multipart/RPC、sidecar 顺序与 limits、exact routes、六 header HMAC、时钟/nonce/key/replay、owner scope authz、生产 transport policy、固定 401/400/503/500、closed poll、canonical remote cursor、route-kind mapping、semantic receipt，以及原子 create/replay、三索引、deadline ceiling、scope/owned copy、有界 Memory retention、hostile input、outbound receipt/cursor/ACK、waiter 生命周期和 closed delivery response correlation/ownership。上述仍只证明 Worker/Process 离线子集、HTTP L1/L2 wire/Store/response-codec 地基与 Core process-local reconnect prerequisite；因为 L5/L6/Ark 和 HTTP production durable Store/runtime/response authentication/真实网络交付/attachment recovery/durable reconnect 尚未完成，manifest 中 `C7-WORKER`、`C7-PROCESS`、`C7-HTTP` 与 `C7-AUTH` requirement 都继续保持 `planned`。完整 Phase 2 离线门禁和真实 placement profile 仍待交付。

Ark placement 调用公式固定为：Worker/Process 各为两条跨协议 5-call flow，加 provider in-flight 2、result receipt 3、terminal CAS 4，共 19 次（hard limit 21）；HTTP 为两条 5-call 跨协议 flow 加 1-call lost-target，共 11 次（hard limit 13）。ARK key 只在 controller 内存，child 通过受控 Model gateway 请求，不进入 Worker、Process、HTTP remote 的 env、argv、binding、job store、日志或 evidence。

Phase 3 Docker Compose 必须同时启动 PostgreSQL、Redis、MinIO、HTTP worker、BullMQ worker、隔离 Docker Engine、controller 与故障代理；Docker task 容器断言非 root、只读 rootfs、无 Docker socket、默认无网络。Core telemetry sink 与独立 `maneeagent-observability-otel` bridge 的 span 映射分别验收，Core tarball 不得依赖 OTel SDK。所有公开包和 evidence 统一版本 `2.0.0`。

### 12.2 C7c Placement bridge、Model gateway 与 HTTP 安全验收矩阵

本节冻结 C7c 的目标验收 Oracle。C7c-1、Worker/Process 离线 case、C7c-4 HTTP wire-security case、C7c-5b poll/route/receipt case、C7c-5c create/replay Store case、C7c-5d-a current-attachment delivery/ACK/wait 的 STORE04/STORE07 与 C7c-5d-b closed response 的 DELIVERY01～04 已有对应实现和 manifest 映射；Core external reconnect prerequisite 已有额外内部对抗回归，但不计作 HTTP placement evidence。矩阵中尚未覆盖的 Worker/Process L5/L6/Ark、HTTP production durable Store/runtime/response authentication/真实网络交付/attachment recovery/durable reconnect/L5/L6/Ark 条目仍是 `pending_external_evidence` 或未满足 requirement，不能据此宣称 `C7-WORKER`、`C7-PROCESS`、`C7-HTTP`、`C7-AUTH` 或 Phase 2 passed。C7c 仍只改变 child execution placement，父 Agent、root run、owner session 和审批控制权都留在 controller，不实现 handoff。

#### 12.2.1 Target registry 与 controller/target bridge

`SubAgentTargetRunnerRegistry` 是 host-only 的受信 registry。模型只看见既有 `{ subAgent, executor, input }`，transport 对端也不能提交模块路径、构造器、factory、entrypoint、环境变量或 argv 来选择可执行代码。

| ID         | 正向与边界场景                                                                                                                                                                              | 必须拒绝/证明                                                                                                                                                                                                              | 层级  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| C7C-REG-01 | init 对每个 target entry 校验稳定 target identity、definition name/version、协议、runner factory 与所需 checkpoint codec；成功后生成不可变 snapshot。                                       | 空白/超 schema 上限/控制字符 identity、重复 target、缺 factory、未知协议、缺 codec、definition 或 adapter identity 不一致时在 Worker/Process/HTTP 创建及任何网络前失败，不留下半 registry。                                | L1/L2 |
| C7C-REG-02 | public catalog 的 `(subAgent, executor)` 经过 definition allowlist、Executor `supports()`、availability 和 target registry 保守交集后唯一解析到受信 target。                                | wire 中伪造 target/module/path/URL、未知 target、recovery-only target 用于新建、同一公开选择解析到多个 target，统一安全失败；不得 `import()`、`eval`、spawn 任意代码或 fallback 到另一个 target/Executor。                 | L1/L2 |
| C7C-REG-03 | execution request、checkpoint、binding、protocol 和 adapter identity 与路由时 registry revision 精确绑定；in-flight task 使用创建时 snapshot，显式刷新只影响后续 create。                   | registry mutation、旧 revision、版本降级、checkpoint/runner/协议错配确定失败；恢复只能找回原 identity 或使用显式 migrator，不能把同名新 factory 当成原 target。                                                            | L1/L3 |
| C7C-REG-04 | 每个 task 从 target factory 创建独立 child runner；同一 target 可以处理不同 task，但不能共享 Agent/context/Tool 实例或可变 app state。                                                      | factory 返回已使用 runner、父 Agent、另一 task 的 runner 或跨 session 对象时失败；一个 task 的 context、approval、artifact、Model proxy 与 event 不得被另一个 task观察。                                                   | L2/L4 |
| C7C-REG-05 | Router 在实际 dispatch 前用最新 availability revision 复核，target resolver 再按已授权 identity 做最后一次闭合校验。                                                                        | catalog snapshot 后 target 消失、不健康或被撤销时不创建 task/job、不消费 child provider budget且不 fallback；失败目录只返回模型可见的安全公开字段，不泄漏 target key、registry revision 或内部原因。                       | L1/L2 |
| C7C-BRG-01 | 全链路必须真实经过 Runtime/Router → placement Executor → `SubAgentTransportPeer` → execution RPC → target registry → request reconstruction → child runner → reverse control proxy。        | 禁止测试直接调用 child runner、伪造 settled outcome 或绕过 Peer/dispatcher；每个 trust boundary 都重验 closed schema、scope、identity、hash、signal/deadline 和 limits，首个失败点之后 Core mutation 计数为 0。            | L2/L4 |
| C7C-BRG-02 | child 的 checkpoint/result/end/progress/approval/delegation 通过 16-method control proxy 返回 controller，controller 写权威 StateStore；settled reply 再按原 call order 回到父 checkpoint。 | raw `SubAgentExecutionControl`、StateStore、API key、父 Agent、raw task handle 或未脱敏 error 不得进入 target factory、binding、wire、日志或 child context；reverse call 的 task/session/call correlation 任一错配都失败。 | L2/L4 |
| C7C-BRG-03 | `execute`、`spawn`、approval resume、checkpoint recovery、cancel、snapshot、wait 和 events 都使用同一 bridge，规范化 outcome 与 Local conformance golden 一致。                             | adapter 不得为某个方法建立旁路或在进程/网络失败后 create 替代 task；Worker/Process 固定 `reconnect=none`，HTTP 只能 reconnect 原 external binding。                                                                        | L2/L3 |
| C7C-BRG-04 | `reconstructSubAgentExecutionRequest()` 的 `dispose()` 在 success/failure/cancel/timeout/runner throw 的 `finally` 中恰好生效，重复调用幂等。                                               | settle 后 signal listener、分段 deadline timer、MessagePort/IPC/request body、sidecar owned buffer、child runner 与 registry lease 均为 0；迟到 reply 只能命中 tombstone，不能复活 task。                                  | L1/L3 |

Core external reconnect prerequisite 还必须以内部 deterministic suite 证明：默认 bridge 对 live task 固定 `RECOVERY_UNSUPPORTED`；opt-in 必须同时提供 durable/fencing-aware checkpoint hook，并只接受不同的 trusted `channelId`。checkpoint request/reply/hook/local update 全链路串行，method/scope mismatch、reply-loss、timeout 与 late hook 都不能清 gap 或回退旧 checkpoint；reconnect 在 hard fence 前排空已准入的 mutating control/checkpoint 与 provider Model exchange，已准入 events 的迟到结果只可 quarantine，旧 channel 的 cancel/snapshot/events 与旧 wait/events reply 均不能影响新 runner；factory throw/deadline 后 detached slot 可由更高 scope + 另一 fresh channel恢复或取消。Model exchange 必须以同步 transport admission 为不确定性起点，并按 `providerOperationId` single-flight；target 在 Peer 前重算 canonical body hash，只有相同 ID/hash 可以查询 controller 的原 durable result，不同 hash、保留旧 hash 但篡改 body、pre-admission failure 与 resolver 越过 deadline都不能污染或清除状态。admitted reply-loss 只允许取回原 result，权威 `outcomeUnknown`、runner 带未决 Model settle 与迟到冲突 reply 必须单调 fail closed，provider effect 最多一次，原 runner 后续 checkpoint/control、resume 与 reconnect 均为 0。该 suite 只证明单个 `SubAgentTransportTargetBridge` 实例内的 runner replacement，不证明 target 进程重启、Peer pending restore、HTTP durable job/spool 或跨 replica reconnect。

task-handle registry 必须是 lazy、session-bound 且可回收的，不能把原始 Worker/Process/HTTP handle 当作持久状态：

| ID         | 场景                                                                                                                     | Oracle                                                                                                                                                                                                  | 层级  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| C7C-HDL-01 | accepted binding 后首次 `snapshot/wait/events/cancel` 才按 `ownerSessionId + parentTaskId + taskId` 解析 lazy handle。   | 仅 create/terminal 但未调用 handle API 时不注册 listener/timer；checkpoint、binding、event 与 artifact 不序列化 raw handle、PID、threadId、socket、URL 或 closure。                                     | L1/L2 |
| C7C-HDL-02 | 同 owner/parent scope 对同 task 重复解析复用同一受控 operation state；并发首次解析通过 single-flight。                   | unknown 与跨 session/parent 都返回相同 `RESOURCE_NOT_FOUND` 投影；错误 owner、parent、task、binding、executor 或 target identity 在接触 adapter 前失败，不泄漏资源是否存在。                            | L1/L2 |
| C7C-HDL-03 | `events(afterSequence)` 按需建立一个 cursor subscription，重复/断线重连只回放 `sequence > afterSequence` 的权威事件。    | iterator `return()`、AbortSignal、HTTP disconnect、terminal、Peer close 和异常路径都移除 listener；同 cursor 重连不重复事件、不跳 sequence、不保持旧 response writer。                                  | L2/L3 |
| C7C-HDL-04 | terminal 且没有 pending operation/subscriber 后驱逐 lazy entry；后续只读查询从 StateStore/remote terminal receipt 重建。 | 10,000 次 create/resolve/cancel/terminal 与反复 events connect/disconnect 后，registry entry、listener、timer、MessagePort、child process、socket 和 pending promise 回到基线，不得随 task 数单调增长。 | L2/L6 |

#### 12.2.2 14-kind RPC 与受控 Model gateway

C7c 将现有 12-kind closed RPC union 只增加 `model.request` 与 `model.reply` 两个 kind，总数必须精确为 14；未知第 15 种 kind、额外字段或把 model payload 塞入普通 control/execution kind 都在 Model、SDK 和 StateStore 前拒绝。`model.request/model.reply` 复用同一 Peer sequence、correlation、canonical replay、packet/sidecar limits 和同步 writer admission，不建立第二套无界 IPC。

Model gateway 的持久顺序固定为：

```text
child checkpoint CAS committed
  -> checkpoint ACK(task/revision/digest) recorded
  -> model.request admitted
  -> provider budget token reserved
  -> provider state prepared -> in_flight CAS
  -> SDK create started
  -> normalized result + result hash recorded as result_ready
  -> model.reply admitted
```

`checkpoint ACK` 之前 `model.request admission count=0`、`provider reservation count=0` 且 `SDK create count=0`；`prepared -> in_flight` CAS 必须先于 SDK create。一旦进入 `in_flight`，即使 SDK 尚未真正开始也按 outcome unknown 处理；`result_ready` 记录成功后，即使 reply/connection 丢失也不能再次调用 provider。

| ID         | 正向场景                                                                                                                                                                    | 负例与精确 Oracle                                                                                                                                                                                                                                           | 层级     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| C7C-MDL-01 | Chat 与 Responses 各通过 protocol-specific Model proxy 发出 closed `model.request`，controller 只用 registry 绑定的 adapter/model endpoint 处理并返回同协议 reply。         | protocol/adapter/target/task 错配、custom protocol、未知 purpose、额外字段、target 指定 endpoint/model/baseURL 或任意 provider options 均失败；不能把一种协议的 context/reply 交给另一 adapter。                                                            | L1/L4/L5 |
| C7C-MDL-02 | request 关联原 owner/session/run/task/attempt、logical model request ID、checkpoint revision/digest 和规范化请求 SHA-256；reply 关联同一 scope、request ID 与 result hash。 | 任一 scope、attempt、ACK、protocol 或 hash 错配返回稳定安全错误；不能因只匹配 transport correlationId 就接受 reply，迟到 reply 不能推进 failed/terminal task。                                                                                              | L1/L2    |
| C7C-MDL-03 | child checkpoint commit/ACK 先于 `model.request` admission；丢失 ACK 后相同 scope/ID/hash 重放返回原 ACK，再准入至多一次 model request/provider attempt。                   | 无 ACK、ACK 未提交、旧 revision、错误 digest、另一 task 的 ACK、ACK 后 StateStore rollback 模拟均在 model request/provider 前失败；trace 必须满足 `checkpoint.acked < model.request.admitted < budget.reserved < provider.in_flight < sdk.create.started`。 | L1/L3    |
| C7C-MDL-04 | 幂等 key 的作用域包含受信 task scope 与 logical request/attempt；canonical request hash 覆盖协议、purpose、context、Tools、runtime request metadata 和 checkpoint digest。  | 同 key + 同 hash 只 reserve/create 一次并返回同 ACK/reply；同 key + 不同 canonical hash 为 `IDEMPOTENCY_CONFLICT`，SDK=0；对象 key 顺序差异等价，Unicode、数字、lone surrogate 等继续服从 JCS Oracle。                                                      | L1/L3    |
| C7C-MDL-05 | provider 返回后先保存允许恢复的规范化 Chat/Responses result 与 hash，再发送 `model.reply`；reply 丢失后重放返回 byte-equivalent semantic reply。                            | SDK create 成功但结果是否返回不确定时不得伪造缓存；结果已保存时不得标 `outcomeUnknown` 或再次 create；同 request ID 的不同 result/hash、重复 completion、乱序旧 reply 都不能覆盖第一份已提交结果。                                                          | L1/L3    |
| C7C-MDL-06 | `signal`、remaining deadline、共享 provider ledger 和 `maxRetries: 0` 进入 controller adapter；abort 精确中止对应 SDK request。                                             | target 不能扩张 deadline、重置 attempt、跳过 budget、触发 SDK/framework retry 或把一个 task 的 abort 传播到无关 task；timeout/cancel 后 listener、reservation 和 pending reply 全清理。                                                                     | L1/L4/L5 |
| C7C-MDL-07 | L4 使用 Fake OpenAI client 真正进入 `OpenAIChatModel.generate()` 与 `OpenAIResponsesModel.generate()`；L5 再用方舟验证两种协议 Tool-call/result checkpoint。                | fake fixture 不能绕过正式 adapter parse/build/rewrite；Chat `tool_calls[]`/`tool` role、Responses item/call ID、summary purpose 与 typed Tool schema 不交叉泄漏，checkpoint restore 后 provider call 序列不重复。                                           | L4/L5    |
| C7C-MDL-08 | API key 与 provider credential 从始至终只存在于 controller Model gateway 内存；proxy 只携带协议安全请求与稳定关联字段。                                                     | fake secret marker 扫描 Worker `env/workerData/argv`、Process `env/argv/stdio/IPC`、HTTP headers/body/job/binding、checkpoint/WAL、event、error、DLQ、日志、trace、artifact/evidence 必须 0 命中。                                                          | L2/L3/L6 |

#### 12.2.3 四个故障窗口与 placement 变体

四个窗口必须由 Worker、Process 和 HTTP 各自的确定性 offline harness 全覆盖；只有会实际发生 provider attempt 的窗口进入既有 Ark profile，准入前/后零调用用例不能为了“真实”标签浪费或新增 SDK calls。

| 窗口                 | 注入点                                                                                                                   | task/job/Model Oracle                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre_admission`      | writer 返回 admission receipt 前 throw/abort，或 HTTP 在认证/完整 multipart 校验前断开。                                 | 不消费 Peer sequence、不创建 target job/runner、不写 checkpoint、不 reserve/provider call、不留 lazy handle/tombstone；host 可用同 operation 原样重试。                                                                             |
| `post_admission`     | execution/placement packet 已同步 admitted，但 accepted binding 或 child checkpoint ACK 尚未提交时进程/连接失败。        | 只允许按同 operation ID/hash 重放原 operation；task/job 最多各 1，model request admission=0、provider call=0。相同语义继续，冲突语义 `IDEMPOTENCY_CONFLICT`；不能 create 替代 task/job 或 fallback。                                |
| `provider_in_flight` | A：`prepared -> in_flight` CAS 已提交但 SDK create 前 crash；B：SDK 已启动但 `result_ready` 尚未记录时 worker/连接丢失。 | 两个子变体都让原 task `failed + EXECUTOR_FAILED + outcomeUnknown=true` 且禁止恢复/自动重发；A 确定 `SDK create=0`，B 确定 `SDK create=1`。reservation/attempt 不返还，迟到 reply 被吞掉，只有可信 host 可以创建 `retryOf` 新 task。 |
| `model_result_ready` | 规范化 result/hash 已提交，但 `model.reply` 或 target ACK 丢失，随后 runner/controller 重连。                            | 同 request replay 返回原 result/hash且 provider exactly once；child 从原 checkpoint 继续，再由 F08/F09 分别验 result receipt 与 terminal CAS。不能把确定结果降级为 unknown，也不能覆盖结果或增加 provider attempt。                 |

| Placement | 必须执行的 bridge/OS/network 证据                                                                                                                                                                                                                                                                                | Ark profile 内的既有调用映射                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker    | 真实 `worker_threads`、受信 target registry、transferable owned `ArrayBuffer` sidecar、最小 env/空 `execArgv`、双向 MessagePort、protocol cancel → 5 秒 terminate fallback、`error/exit` 分类；四窗口与 reverse control 并发后无 Port/runner/listener 泄漏，`reconnect=none`。                                   | 保持 19/21：两条跨协议 5-call flow；provider in-flight 2；`model_result_ready` 可与既有 result-receipt 3-call flow 共用同一 provider result；terminal CAS 4；pre/post admission 为 0-call offline case。 |
| Process   | 真实 child process、固定 `execPath`、advanced serialization、`detached=false` 且 `fork()` 不通过 shell、严格 env 白名单、64 KiB stdio 上限、IPC send callback/backpressure/sendHandle、close/exit/kill 分类、protocol cancel → 5 秒 kill fallback和孤儿清理；四窗口与 reverse control 不死锁，`reconnect=none`。 | 保持 19/21，公式与 Worker 相同；crash evidence 必须来自真实 OS process，不得用同进程 throw 冒充。                                                                                                        |
| HTTP      | TLS（生产）或显式 loopback-test 模式、HMAC verifier、单 packet multipart、幂等 job、heartbeat、cursor events、approval resume、external binding reconnect；controller/target 任一断线都只找回原 job，四窗口和 lazy event stream 全部无 socket/request writer/staged sidecar 泄漏。                               | 保持 11/13：两条跨协议 5-call flow 中一条嵌入 result-ready reply 丢失/重放且不增加 SDK call；1-call lost-target 覆盖 provider in-flight unknown；pre/post admission 为 0-call offline case。             |

上述映射不修改 9.14 的 standalone 24/24、Worker 19/21、Process 19/21、HTTP 11/13、BullMQ 15/16、Docker 15/16 和 Core full 110/112；总计仍必须精确为 **213/223**。manifest、CLI acknowledgement 或 ledger 若因新增 C7c case 变成其他合计，必须在读取 `ARK_API_KEY`、创建 Model、target registry 或运行 Skill script 前失败。

#### 12.2.4 HTTP 单包 multipart 与 HMAC-SHA256 v1 负例

HTTP sidecar 固定为一次已签名的 `multipart/mixed` packet，不提供先传 artifact 再发 frame、单独 raw sidecar route 或客户端可选两阶段协议。第一 part 的 `Content-Type` 必须精确为 `application/vnd.maneeagent.packet+json`，body 是 closed packet JSON；`frame` 必须是已经序列化的 RPC frame 字符串，不能是嵌套 JSON object：

```json
{ "version": "1", "frame": "<serialized-rpc-frame>", "sidecars": [] }
```

`sidecars` 非空时包含既有 closed descriptor object。其余 part 必须按 descriptor 顺序逐一携带原始 binary，`Content-ID` 与对应 sidecar ID 精确一致。所有 part 都使用固定 header allowlist；禁止 nested multipart、MIME `Content-Transfer-Encoding` 或其他 transfer-encoding 语义和未知 part header。descriptor 仍受单件 32 MiB、每 packet 8 件、合计 128 MiB 限制；HTTP parser 自身还要在分配/落盘前限制累计 body 与 header/boundary 开销。`Manee-Body-SHA256` 覆盖未经重序列化的完整 multipart raw body。只有 body digest/HMAC、closed JSON、所有 part、count/order/ID/length/SHA-256 和 limits 全部通过后，才能一次性把 owned sidecars 交给 Peer；任一失败都要求 `Peer.receive=0`、target/Model/Core/StateStore 调用=0、artifact stage/put/残留=0。

| ID            | multipart/route 反例                                                                                                                                                                                           | Oracle                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C7C-HTTP-MP01 | 缺/错 `multipart/mixed` boundary；首 part Content-Type 不是精确 `application/vnd.maneeagent.packet+json`；packet version/frame/sidecars 缺失或有额外字段；`frame` 非 string；JSON 重复 key/超深/超 nodes。     | 在 Peer 前返回固定安全 protocol error；不尝试宽松 JSON、把 nested object 当 frame、content sniffing、base64 fallback 或第二条 route。                        |
| C7C-HTTP-MP02 | binary part 少/多/乱序、重复或未知 `Content-ID`、descriptor 重复、part media type 不符、零件声明但无 bytes、无 descriptor 却附加 bytes；nested multipart、MIME/part transfer-encoding 或任一未知 part header。 | 整 packet 原子失败；已读临时 bytes 立即清理，不能 decode transfer encoding、递归解析 multipart、忽略 header、留下部分 stage 或让 frame 先执行。              |
| C7C-HTTP-MP03 | 单件/件数/合计恰好等于上限通过；任一超 1 byte/1 件、声明 length 与实际不符、截断、trailing bytes、sidecar SHA-256 不符。                                                                                       | 越界/不完整在 Peer 前失败；不得截断、忽略尾部、只信 `Content-Length` 或分批提交。                                                                            |
| C7C-HTTP-MP04 | 发送后 mutation、Proxy/伪 typed array 由发送端 sidecar guard 拒绝；raw body 任一 boundary、CRLF、part header、JSON key order 或 binary byte 被未重新签名地篡改。                                               | 发送端仍只产生 owned copy；接收端 body digest/HMAC 失败且 Core=0。即使测试用可信 key 对结构非法 body 重新签名，multipart closed validator 仍失败且零 stage。 |
| C7C-HTTP-MP05 | 非法 method/未知 route、artifact upload/download 辅助 route、同 path 的 trailing slash/query 变体、把 binary 直接放 JSON/base64。                                                                              | 不做 route fallback/redirect/内容协商；在认证/route policy 定义的安全边界失败，绝不把相近路径解释成合法 RPC。                                                |

HMAC 必填 header 精确为 `Manee-Auth-Version: 1`、`Manee-Key-Id`、`Manee-Timestamp`、`Manee-Nonce`、`Manee-Body-SHA256`、`Manee-Signature`。canonical string 按以下字节序列构造，最后没有换行：

```text
MANEE-HMAC-SHA256-V1\nkeyId\ntimestamp\nnonce\nMETHOD\npath\nbodyDigest
```

`METHOD` 必须是 uppercase；收到的 raw path 自身必须已经是 route table 中唯一的 absolute canonical form，禁止 query、fragment、`%` 编码、反斜杠、`.`/`..` segment、重复 `/` 和 trailing `/`。服务端绝不能先 normalize、decode 或重写 path 再验签。`bodyDigest` 是完整 raw body 的 lowercase SHA-256 hex。timestamp 是无符号十进制 Unix 毫秒，默认窗口 `now ± 60_000 ms` 且两个边界都有效；nonce 是无 padding base64url，解码后 16～64 bytes；配置 key 至少 32 bytes；signature 是无 padding base64url HMAC-SHA256，解码后精确 32 bytes并 constant-time compare。replay cache 原子消费 `(keyId, nonce)`，TTL 固定 120 秒。

| ID              | HMAC/authorization 反例                                                                                                                                                         | Oracle                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C7C-HTTP-AUTH01 | 六 header 任一缺失/重复/合并多值/空值/内部 SP 或 TAB/控制字符，Auth-Version 非 `1`，timestamp 使用 `+`/负数/小数/指数/前导零，digest 非 64 位 lowercase hex。                   | verifier 统一安全 401，响应不区分原因；route handler、multipart parser、Peer、target registry、Model gateway 和 Core 调用均为 0。Node.js 22 的 llhttp 在 `rawHeaders` 前已去掉 header value 外围 OWS，因此它按 HTTP 等价值验签，不能把 socket 上已不可见的外围 OWS 写成拒绝证据。                                                                                                                                             |
| C7C-HTTP-AUTH02 | canonical method 大小写变化，raw path 添加 query/fragment/百分号编码/反斜杠/dot segment/重复 slash/trailing slash，交换 canonical 行、添加尾换行，body boundary/byte 变化。     | 未重签名时 signature/digest 失败；即使使用测试 key 重签，非 canonical raw method/path 仍拒绝。服务端必须按收到的 raw path 验证，绝不能先 decode/normalize/rewrite，也不得让代理重写产生第二种有效 canonical form。                                                                                                                                                                                                            |
| C7C-HTTP-AUTH03 | timestamp 恰好 `now-60_000` 与 `now+60_000` 通过；`±60_001`、非整数、溢出或解析后精度丢失失败。                                                                                 | ManualClock 下边界确定；失败不消费 replay nonce、不进入 authorize/Core。                                                                                                                                                                                                                                                                                                                                                      |
| C7C-HTTP-AUTH04 | nonce 非 base64url/有 padding/解码少于 16 或多于 64 bytes；key 配置少于 32 bytes；signature 非 base64url/有 padding/不等于 32 bytes；未知 keyId、错 body digest、错 signature。 | 弱 key 在 server init/listen 前失败；请求侧所有 verifier failure 对外仍是相同 401。signature 比较只对固定 32-byte buffers做 constant-time compare，不因首个错误 byte 位置改变可观察分类。                                                                                                                                                                                                                                     |
| C7C-HTTP-AUTH05 | 同 `(keyId, nonce)` 顺序重放、并发 100 次重放、body/method/path 不同但 nonce 相同、两个 server 实例同时消费。                                                                   | distributed/loopback atomic cache 精确一个 winner，其余统一 401；TTL=120 秒内不能因 timestamp/body变化复用。内存 cache 只能在显式 loopback/test profile 使用，不能产生 production L6 passed 证据。                                                                                                                                                                                                                            |
| C7C-HTTP-AUTH06 | authentication 成功但 principal 无 owner session/method 权限、猜中另一 session/task、授权在验签后撤销；TLS 缺失或 production handler 被配置为 loopback verifier。               | authn/replay 后允许先无副作用完整解码 signed multipart，再由 route、packet 或受信 job state解析 owner scope；`authorize(authContext, { ownerSessionId, method, routeId })` 必须在 Peer/Core 前执行，其中 method 精确为 canonical HTTP `POST`。denial 固定 401 且 Core=0；heartbeat 以 `ownerSessionId = null` 做 endpoint-scope 授权，其他 route 缺失/非法 owner 固定 400；授权后还必须通过已交付的 closed route↔RPC policy。 |
| C7C-HTTP-AUTH07 | 错 key、错签名、过期、未来时间、replay、body tamper，以及 key/replay/authz backend 和 Peer/Core callback 异常的 stdout/stderr、diagnostic 与响应扫描。                          | auth/path/replay/authz denial 固定 401，认证后的协议/scope malformed 固定 400，认证依赖异常固定 503，业务 callback 异常固定 500；只记录固定分类、request correlation digest和状态，不得记录 header value、canonical string、raw body、nonce、signature、key material、session/task existence、provider payload 或内部 stack。                                                                                                 |

#### 12.2.5 HTTP poll、route-kind 与 semantic receipt wire 基础

本小节只冻结 C7c-5b 的无副作用 wire primitives。poll command 不等于 long-poll handler，semantic receipt 不等于 durable idempotency/delivery ledger，route policy 也尚未组合真实 listener 或 Peer pump。

| ID                 | 输入/反例                                                                                                                                                                                                  | Oracle                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C7C-HTTP-POLL01    | 精确 `application/vnd.maneeagent.poll+json` 与 closed `{version,channelId,channelGeneration,ackCursor,waitMs}`；missing/unknown/duplicate key、Proxy/accessor/sparse data、BOM/非法 UTF-8、body 超 4 KiB。 | encode/decode 都只接受 data property，decode 返回 owned frozen record；任一非法输入在 job/store/Peer 前同步失败。                                              |
| C7C-HTTP-POLL02    | generation/cursor 的 `0`、uint64 max、`+1`、`-1`、`01`、小数、指数与 max+1；wait 的 `0`、`10000`、负数、fraction、`10001`、NaN/Infinity。                                                                  | 只接受 canonical decimal uint64 与 `0..10000` safe integer；remote cursor 不映射 Core event 或 Peer sequence。                                                 |
| C7C-HTTP-ROUTE01   | heartbeat 携带 packet；create/resume/reconnect 的错误 operation/mode；cancel/poll/control-reply 使用错误 kind/direction；control path requestId 与 correlationId 不一致。                                  | strict RPC 与 sidecar 完整 owned decode 后执行 closed table；非法组合在 Peer/Core 前拒绝，无 fallback。                                                        |
| C7C-HTTP-RECEIPT01 | 同一业务 packet 更换 HMAC nonce、multipart boundary、Peer channel/sequence/message/correlation、control path requestId 或 sidecar 顺序；另改 task/operation/kind/payload/job scope/sidecar byte。          | 前一组得到同一 lowercase SHA-256；后一组任一变化得到不同 SHA-256。receipt 只覆盖 verified semantic projection，不声称推进 ACK、创建 job 或验证 HTTP response。 |

#### 12.2.6 HTTP create/replay Store 地基

本小节只冻结 C7c-5c 的初始 create/replay Store。不暴露任意 record CAS，也不实现 delivery/spool、ACK/poll wait、listener/client、production durable adapter 或 reconnect；`STORE03` 继续保留给具备 authoritative recovery proof 与 Peer rebase/import 的 attachment mutation，`STORE04`/`STORE07` 已由下一小节交付。

| ID               | 输入/竞态                                                                                                                                   | Oracle                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C7C-HTTP-STORE01 | 同 create key 的首次写、相同 identity 更小/相等 `remainingMs`、更大 deadline、业务/operation/sidecar 变化；同 task 换 key/job。             | 首次仅一条 `created`；合法 replay 返回原 job/packet/timestamp/ceiling，deadline 不扩张；identity 或 logical task 冲突固定 `idempotency_conflict`，原 record byte-semantic 不变。                            |
| C7C-HTTP-STORE02 | 100-way 同 key/identity 并发；100-way 同 principal/owner/task 但不同 key/job；clock callback 重入同 key、jobId、task、capacity 或 dispose。 | create-key、principal/jobId、principal/owner/taskId 三索引在一个无 `await` 临界区 linearize；精确一个 winner，其余 replay/conflict；clock 返回后必须重查 disposed、全部索引与 count/byte capacity。         |
| C7C-HTTP-STORE05 | create 后改输入 sidecar、改返回 bytes 再 load；错 principal/owner/unknown；authorization lookup。                                           | Store 保留完整 owned first packet；每次 create/load 返回 frozen metadata 与 fresh owned bytes；full-scope mismatch 都是 `undefined`；授权前 resolver 只返回 frozen `{ownerSessionId}`，不复制 full packet。 |
| C7C-HTTP-STORE06 | 精确 count/byte 边界、满后新 create、已有 replay、读取旧记录、重复 dispose 与 dispose 后调用。                                              | retained bytes 精确计 canonical frame UTF-8 + canonical descriptor JSON UTF-8 + raw sidecar；满时不 LRU/TTL/驱逐，合法 replay优先；dispose 归零 Store-owned bytes、清索引，之后固定 `disposed`。            |
| C7C-HTTP-STORE08 | options/create/scope/lookup/record 的 Proxy、accessor、unknown key、自定义 prototype；恶意 clock 重入。                                     | 调用方 trap 为 0，任何非法输入在写入前拒绝；重入只允许一个线性化结果，不覆盖索引、不重复计 bytes、不在 dispose 后写入。                                                                                     |
| C7C-HTTP-STORE09 | 更换 HTTP nonce/boundary、Peer identity、sidecar 顺序、衰减 deadline；另改 owner/run/task/operation/idempotency/mode/payload/sidecar。      | create identity 忽略 transport identity 与 `remainingMs`，但所有业务/作用域/sidecar digest 变化都改变固定 golden SHA-256；full semantic receipt继续保留首次 packet 审计证据。                               |

#### 12.2.7 HTTP current-attachment delivery Store 地基

本小节只冻结 C7c-5d-a 在 create record 初始 Core channel/generation 上的 Store mutation。它不包含 response codec、production durable adapter、listener/client、attachment rotate、Peer pending/resequence import 或 durable reconnect；`C7-HTTP` requirement 继续保持 `planned`。

| ID               | 输入/竞态                                                                                                                                                                                                                                                                                                                           | Oracle                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C7C-HTTP-STORE04 | strict outbound packet 首写/响应丢失重放；messageId 或 Peer sequence 异义、sequence gap、sidecar/hash 变化；current ACK 重放、exact offered ACK、stale/skip/future ACK；enqueue/poll 并发；packet count/bytes/compact receipt容量与 uint64 边界；输入/返回 bytes突变、Proxy/accessor、错 scope/channel/generation、abort/deadline。 | receipt 覆盖完整 canonical Core transport envelope与排序后的 verified descriptor，不复用 routed semantic receipt；message 与 target→controller sequence双索引只允许同 receipt replay，新写 cursor/revision连续且不混用 Peer sequence；每次只 offer 一包，ACK+取下一包原子，ACK释放完整 delivery bytes并归零 mutable sidecar但保留 compact receipt；所有失败零 revision/cursor/bytes副作用，返回 fresh owned packet。 |
| C7C-HTTP-STORE07 | observed revision 已变化或未变化；wait/register 与 enqueue 两种先后顺序；`waitMs=0/10000`、pre/mid abort、absolute deadline、waiter capacity、clock重入、dispose 与迟到 timer/wake 竞态。                                                                                                                                           | revision recheck 与 waiter register 在同一线性化区，无 lost wake；immediate change不占 waiter容量，timeout返回 frozen state；abort/deadline/dispose 固定 cause-free错误并一次性移除 timer/listener/waiter，迟到 callback不二次 settle或改变 state；dispose不可取消并清零所有 Memory delivery/receipt/wait资源。                                                                                                      |

#### 12.2.8 HTTP closed poll delivery response wire

本小节只冻结 C7c-5d-b 的纯 response codec。它不调用 Store/Peer，不认证 response，不实现 endpoint、long poll、listener/client 或 attachment recovery；request receipt 仅在真实 endpoint 已独立验证 TLS identity 后提供 semantic correlation。`C7-HTTP` requirement 继续保持 `planned`。

| ID                  | 输入/篡改                                                                                                                                       | Oracle                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C7C-HTTP-DELIVERY01 | empty/nonempty Store poll result；固定/随机 boundary；修改编码与解码后 bytes。                                                                  | 两种结果都固定 `200 + no-store + multipart`，first JSON 使用同一 closed schema；roundtrip 返回 frozen metadata 与 fresh-owned packet/sidecar bytes，调用方修改不回写。       |
| C7C-HTTP-DELIVERY02 | first/binary part header、顺序、ID、length、digest、缺失/多余/trailing/boundary 与 body/frame/sidecar/count/header/JSON limits 的边界及 +1。    | 精确 MIME/header/CRLF/closing 与 descriptor 顺序；按已验 length 读取 binary；所有 part 与全量 digest 原子通过后才返回，任一篡改全包拒绝。                                    |
| C7C-HTTP-DELIVERY03 | route/job/poll command、request receipt、response channel/generation/ACK/cursor、inner channel、packet receipt 与 target→controller kind 变化。 | receipt 绑定完整 poll 语义但排除 HMAC/raw formatting；generation 固定 `0`，delivery cursor 精确 `ack+1` 且不等同 Peer sequence；full transport packet receipt 必须内部重算。 |
| C7C-HTTP-DELIVERY04 | encode/decode/expected context 的 Proxy/accessor/symbol/unknown/sparse/custom/cross-realm wrapper、伪 typed array 与原型 trap。                 | hostile wrapper 在调用方 trap=0 时拒绝；null-prototype closed record与真实 cross-realm bytes按契约接受并 intrinsic-copy；失败不返回部分 delivery。                           |

C7c manifest 至少拆分 `C7-TARGET-REGISTRY`、`C7-BRIDGE`、`C7-MODEL-GATEWAY`、`C7-WORKER`、`C7-PROCESS`、`C7-HTTP`、`C7-AUTH` 与 `C7-PACK`，并把上表每个 ID 映射到 literal `acceptanceIt(caseId, variant, fn)`、真实进程 reporter 或 Ark scenario。L1/L2 unit/conformance 可进入默认无网络 `pnpm test`；真实 Worker/Process crash 与 HTTP loopback 进入 Phase 2 offline shard；Chat/Responses Fake SDK 进入 L4；Ark placement 只有在显式 key/ack 和精确 ledger 下进入 L5。缺任一 variant 是未完成 requirement，不是 skip/pass。

## 13. 故障注入矩阵

测试私有 failpoint：

| ID  | 注入点                                                     | 必须证明                                                                                                                                                                   |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | task/idempotency transaction 提交前、提交后响应前          | 无重复 task/descendant/budget。                                                                                                                                            |
| F02 | Executor create 前后、binding commit 前后                  | binding 未提交时只允许用相同 idempotency key 重放原 create 并取得同一个 job/binding；提交后 resume/reconnect 不再 create。task/job 始终各 1，无替代 task/job 或 fallback。 |
| F03 | 普通 Tool 全 settle 后、agent sub-batch submit 前          | 普通 Tool 不重复，child 尚未启动。                                                                                                                                         |
| F04 | 一个 sibling terminal、另一个 waiting_approval             | 已完成结果复用，未完成原 task 恢复。                                                                                                                                       |
| F05 | approval pending call checkpoint 前后                      | suspend 前状态完整，handler=0。                                                                                                                                            |
| F06 | approval decision CAS 前后、handler 前                     | 重放同 decision 幂等，handler 最多一次。                                                                                                                                   |
| F07 | handler 完成后、Tool result checkpoint 前                  | 业务副作用由 idempotency key 保护；框架不虚假承诺 exactly-once。                                                                                                           |
| F08 | result receipt CAS 前后                                    | output 不丢失、不覆盖、receipt 重放一致。                                                                                                                                  |
| F09 | terminal CAS 后、completion response 前                    | succeeded 不回滚，重放不推进。                                                                                                                                             |
| F10 | lease 过期后旧进程恢复运行                                 | 旧 fencing token 所有 CAS 失败。                                                                                                                                           |
| F11 | WAL temp write/fsync/commit marker/snapshot/rename/cleanup | 只恢复完整已提交事务。                                                                                                                                                     |
| F12 | remote create/reconnect 重复、迟到、乱序、target lost      | 不创建替代 task，不改变终态。                                                                                                                                              |
| F13 | queue/Model/Tool/summary/recovery 各阶段 abort             | 单一终态、无 retry、资源释放。                                                                                                                                             |
| F14 | catalog snapshot 后 availability revision 改变             | Router 二次校验且无 fallback。                                                                                                                                             |
| F15 | budget reserve/settle 前后、并发 siblings 同时到边界       | ledger 不超卖，budget 事件与终态原子。                                                                                                                                     |
| F16 | placement packet 同步 admission 前                         | sequence/job/runner/checkpoint/provider 均为 0；同 operation 可安全重试，无 tombstone 或 lazy handle。                                                                     |
| F17 | placement packet admitted 后、binding/checkpoint ACK 前    | 原 operation ID/hash 幂等重放，task/job 各至多 1且 provider=0；冲突 payload 失败，不创建替代 job。                                                                         |
| F18 | provider `prepared -> in_flight` CAS 后、result_ready 前   | 分别注入 SDK create 前 crash（SDK=0）与 SDK 已启动后 crash（SDK=1）；两者都 failed + `outcomeUnknown=true`、attempt 不返还且不自动重发，只允许 host retry 新 task。        |
| F19 | normalized Model result/hash 已记录、reply/target ACK 前   | 重放原 result且 provider exactly once；随后继续 F08/F09，不覆盖结果、不回滚为 unknown。                                                                                    |

failpoint 按 capability/phase 选择，不要求不存在的能力伪造通过：

- Core recording/Memory：F01-F10、F13-F15；same-process 不宣称 WAL/remote 语义。
- Atomic File + 真实 child process：F01-F11、F13-F15。
- Phase 2 Worker/Process/HTTP：F01、F02、F08、F09、F12-F19；三种 placement 都必须分别覆盖 F16-F19，不能用 Core Peer unit test 替代 adapter/OS/network evidence。
- 真实方舟只复用与模型可见流程有关的 F04-F06、F08-F10、F13-F15、F18-F19；F16-F17 是零 provider 调用的 Phase 2 offline 证据，存储原子性仍以 L1-L3 为权威。

WAL 或 remote 专属点因 descriptor 不支持而不运行时，acceptance report 记录固定 `unsupported_by_descriptor` variant，不使用普通 Vitest skip 掩盖缺口。每个实际启用的 failpoint 都必须证明无重复任务/副作用、无半事务、无替代 create/fallback。

## 14. 状态/API 交叉验收

所有宿主入口都要按状态与 session 做表驱动测试：

| Requirement | API                  | 正向状态                                      | 必须拒绝/只读的状态                                                                                   |
| ----------- | -------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| API-ST-01   | `execute`            | 新 create；阻塞到 terminal 或 approval paused | 相同 requestId 冲突；无可用 Executor；跨 session 不存在入口                                           |
| API-ST-02   | `spawn`              | 新 create，立即返回 guarded handle            | capability 不支持、预算/输入失败时不创建 task                                                         |
| API-ST-03   | `getTask`            | 任意已存在状态                                | 跨 session 与未知 task 使用安全错误，不泄露存在性                                                     |
| API-ST-04   | `getSubAgentSession` | 同 owner session 的已存在 child               | 跨 session、错误 subagentSessionId 拒绝                                                               |
| API-ST-05   | `wait`               | queued/running/waiting/terminal               | 跨 session 拒绝；取消等待不能取消 task，除非显式 cancel                                               |
| API-ST-06   | `cancel`             | queued/running/waiting/result_submitted       | terminal 按实施前确认的 per-API oracle 返回 snapshot、幂等成功或状态冲突，但绝不推进；跨 session 拒绝 |
| API-ST-07   | `resume`             | waiting_approval；running+recoveryRequired    | queued、普通 running、result_submitted、terminal 拒绝                                                 |
| API-ST-08   | `reconnect`          | external binding 的 running/waiting/terminal  | Local/checkpoint-only、binding lost/mismatch 拒绝                                                     |
| API-ST-09   | `events`             | 任意已存在 task，支持 afterSequence           | 跨 session 拒绝；消费者取消后 listener 清理                                                           |
| API-ST-10   | `resumeRun`          | 原 session/run 的 root waiting checkpoint     | 新 runId、错 revision、错 lease、并发同实例拒绝                                                       |

## 15. 仓库回归与发布验证

Phase 1 release candidate 按顺序执行：

```bash
pnpm install --frozen-lockfile
pnpm acceptance:subagent:v2:offline
```

offline orchestrator 创建唯一 artifact 目录，并把同一个只存在进程环境/参数中的 `evidenceRunId` 传给 reporter、process worker 与 pack validator。其内部固定执行：

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm build
pnpm validate:subagent:v2:manifest
pnpm validate:subagent:v2:legacy
pnpm test
pnpm validate:subagent:v2:pack
pnpm demo
pnpm demo:chat
pnpm demo:finance-news:smoke
pnpm validate:subagent:v2:evidence
```

`validate:subagent:v2:legacy` 使用 Node 校验脚本，扫描整个 `packages` 与 `demo` 树中的可执行源码（包括各包测试），忽略 README、plans、声明文件和构建产物。C6 的 `--forbid-all` 门禁不保留例外；任一 `subAgents`、`AgentConstructor`、`AgentInstance`、`RuntimeSubAgent`、`agentName` 或 `outputDescription` 命中都退出 1，不能用原始 `rg` 的命中退出码充当门禁。

`pnpm validate:subagent:v2:pack` 在唯一 OS 临时目录中为 Core、Local 和 Worker 三个发布包分别执行 pack dry-run，并验证真实打包消费。其内部等价步骤为：

```bash
cd packages/core
npm pack --dry-run --json
npm pack --json --pack-destination <temp-package-dir>

cd ../executor-local
npm pack --dry-run --json
npm pack --json --pack-destination <temp-package-dir>

cd ../executor-worker
npm pack --dry-run --json
npm pack --json --pack-destination <temp-package-dir>
```

dry-run JSON 用于检查文件清单；真实 pack 生成 tarball。脚本随后在唯一临时 consumer 中同时安装 Core、Local 与 Worker Executor tarball，并验证：

- Node 22 `.mjs` consumer 的 ESM `import`。
- Node 22 `.cjs` consumer 的 CommonJS `require`。
- `module/moduleResolution: NodeNext` TypeScript consumer 的声明编译与 public types。
- source map 和 README 随包发布。
- Core 包不依赖 concrete Local/Worker Executor。
- Local/Worker Executor 的 Core dependency/peer range 与目标 2.0 版本一致。
- tarball 不含 test、fixture、`.env`、checkpoint、artifact、WAL 或验收临时文件。
- 解包后的全部允许文件都执行内容级 secret scan；`.map` 的 `sourcesContent` 同样纳入扫描，但 `ARK_API_KEY` 等环境变量名本身不是凭证命中。
- Core 根导出不暴露 ledger failpoint、protocol-surface audit marker 或内部 fencing helper。

pack validator 先运行敏感 dist 产物、TypeScript 源码、普通文件 secret marker、source map `sourcesContent` secret marker、缺 source map、child 超时和输出超限负例，再锁定包名、`engines.node`、仅根 exports、无 `bin`、peer range、内部 helper 不可见性及发布文件正向白名单。内容扫描只匹配私钥头和具有足够结构/长度的常见 token，不把环境变量名称或普通 API 标识误判为 credential。Local/Worker/Process consumer 必须使用同轮生成且 semver 兼容的 Core tarball；tar/tsc/runtime child 使用不含 provider key 的最小环境白名单，所有 npm/tar/tsc/runtime child 都有 wall-clock watchdog，并在超限后等待进程关闭再进入 `finally` 清理。validator 输出四个 tarball digest、package version 和 consumer caseId；这些字段进入本次 evidence shard，不能靠人工阅读 `npm pack` 输出完成门禁。

默认 `pnpm test` 必须完全无网络。前置 `pnpm install --frozen-lockfile` 可以在验收计时外预热 store；offline orchestrator 中的 tarball consumer 强制使用 pnpm/npm cache 的 offline 模式，缺依赖时失败且不能回退访问 registry。若要单独诊断 packaging network，应使用另一个不产生 platform passed 的显式命令。两种路径都禁止访问方舟或其他模型 provider。

真实方舟在上述无凭证门禁全部通过后执行：

```bash
pnpm demo:subagent:v2:ark:smoke
pnpm demo:subagent:v2:ark:full -- --ack-provider-calls=112
```

PowerShell 示例：

```powershell
pnpm demo:subagent:v2:ark:full -- --ack-provider-calls=112
```

根 script 必须把 `--` 后的参数原样转发给 acceptance runner；确认参数不读取 `demo/.env`，也不写入任何持久配置。

Windows 与 Linux 都必须运行 Atomic File/进程恢复离线门禁，因为 rename、locking 和进程语义不同。正式证据统一使用 Node.js 22 与 `pnpm@11.1.3`：Windows bootstrap 把便携 Node 下载到已忽略工具目录并用官方 `SHASUMS256.txt` 校验 SHA-256 后才执行；Linux 使用固定 image digest 的 Node 22 acceptance 容器并在容器内启用固定 pnpm。真实方舟 full 至少在一个 Node.js 22 的受支持平台执行；不要求 Windows/Electron GUI 进入自动门禁。

两个平台各自产生同结构的 offline acceptance report。release aggregator 只有在两份报告的 git SHA、Node major、acceptance manifest digest 和构建产物版本一致时才合并为 passed；缺少任一平台是 release evidence incomplete，不是 skip/pass。单次本地 `pnpm test` 只证明当前平台，不能声称同时完成双平台验收。

## 16. 需求可追踪性与验收报告

### 16.1 设计能力总映射

这张表是对两份设计的人工可读索引；机器门禁仍以逐条 requirement manifest 为准。`—` 表示该能力不适合让概率模型制造 oracle，必须由确定性或真实进程测试验收，不代表缺少覆盖。

| 设计能力                                               | 确定性/进程 requirement                           | 真实方舟场景                  |
| ------------------------------------------------------ | ------------------------------------------------- | ----------------------------- |
| Definition、active/recovery catalog、Router 与 TOCTOU  | DEF、EXE、INIT                                    | ARK-03/04、ARK-06/07          |
| v2 Tool wire、Zod/JSON-safe、协议四象限与 typed output | IO、API、PRO、RES                                 | ARK-01 至 ARK-04              |
| Context projection、Skills、compact 与 transcript 隔离 | CTX、SKL、RUN                                     | ARK-01/02/03/08               |
| 两阶段批处理、并发、顺序回填与兄弟隔离                 | SCH、APP                                          | ARK-05A/05B                   |
| 嵌套 delegation、树身份、depth/descendant              | NEST、ID、LIM                                     | ARK-06                        |
| 显式 Executor 选择、能力过滤、无 fallback              | DEF、EXE、CONF                                    | ARK-07                        |
| 审批、checkpoint resume、background spawn              | APP、REC、RUN、API-ST                             | ARK-05B/08/09、ARK-11A/B/C    |
| result receipt、terminal CAS 与崩溃恢复                | STA、RES、STO、F08/F09                            | ARK-10A/10B                   |
| provider budget、timeout、cancel 与 AbortSignal        | BUD、ABT、SCH、API-ST                             | ARK-12A 至 ARK-12D            |
| retry 与 replay 分离                                   | ID、LIM、STO                                      | ARK-13                        |
| 根 Agent succeeded/waiting/cancelled/failed 生命周期   | RUN、STA、API-ST                                  | ARK-01/08/12D/14              |
| StateStore、WAL、lease/fencing、事务与安全落盘         | STO、F01/F02/F05-F15                              | ARK-08/10 提供模型侧衔接证据  |
| 稳定错误、事件、脱敏与 public lookup guard             | ERR、OBS、API-ST                                  | 全部 ARK 场景的安全投影       |
| Executor 通用合约与 Phase 2/3 placement                | CONF、L2/L3/L6                                    | 9.14 的独立 placement profile |
| v1 删除、无 handoff、包边界、ESM/CJS/types 与文档      | L0、API-01/API-03/API-04、pack/legacy/README 门禁 | —                             |

### 16.2 Manifest 与实际执行证据

实现时新增 `test/acceptance/subagent-v2.manifest.json`。它是需求追踪清单，不是代码覆盖率；字段至少包括：

```json
{
  "requirementId": "PRO-02",
  "requiredLayers": ["L4", "L5"],
  "requiredVariants": ["chat-parent.responses-child"],
  "cases": [
    {
      "caseId": "PRO-02.l4.chat-responses.local",
      "variant": "chat-parent.responses-child",
      "phase": "phase-1",
      "layer": "L4",
      "evidenceSource": {
        "type": "vitest",
        "file": "packages/core/test/subagent/protocol-chat.test.ts",
        "testName": "Chat parent consumes a Responses child result"
      }
    },
    {
      "caseId": "PRO-02.l5.ark-01",
      "variant": "chat-parent.responses-child",
      "phase": "phase-1",
      "layer": "L5",
      "evidenceSource": {
        "type": "ark-scenario",
        "scenarioId": "ARK-01"
      }
    }
  ]
}
```

`requirementId` 可以被多层、多 Executor、多平台证据重复引用；`caseId` 必须全局唯一。Vitest case 统一通过 `acceptanceIt(caseId, variant, fn)` 注册，process/pack/Ark runner 使用同一 reporter protocol；不能靠模糊匹配测试标题推断 ID。

每次根验收先创建唯一 `evidenceRunId`，锁定 git SHA、platform、Node、package/lock digest 并传给所有子进程。各 suite 写独立 shard，禁止并发覆盖同一个文件：

```text
.artifacts/subagent-v2-tests/<evidence-run-id>/
  core.json
  executor-local.json
  process.json
  pack.json
  regression.json
  merged-platform.json
```

`validate:subagent:v2:manifest` 只做不依赖旧产物的静态检查；offline orchestrator 严格按 `test → pack → offline regressions → evidence` 执行。最后的 `validate:subagent:v2:evidence` 校验 shard 的 runId/SHA/platform/suite 集合后再与 manifest 对照，生成当前平台的 `merged-platform.json`。它只关闭 L0-L4、pack、离线 demo regression 和当前平台要求；manifest 中的 L5 case 明确记录为 `pending_external_evidence`，既不是 skip 也不是 pass。任一旧 run、缺失 shard 或重复 case 都失败。发布脚本检查：

- 当前 offline profile 要求的每个 requirement/layer/variant 都有已执行 case，且 caseId 无重复。
- capability-conditioned 用例只能因 descriptor 明确声明不支持而跳过；不支持方法本身仍有错误测试。
- 任意 skip 必须有固定 reason code；真实 provider 不可用是 release gate 未完成，不是 pass。
- 同一个真实运行的 `summary.json` 列出所有 scenario、实际/预算调用数、状态、usage、artifact digest 和失败分类。
- 真实场景的 `coveredRequirementIds` 只能补充 L5 证据，不能覆盖缺失的 L1-L3 case。

### 16.3 报告格式

每个平台的 offline shard 只包含当前平台，不伪造另一个平台证据：

```json
{
  "schema": "subagent-v2-platform-evidence/v1",
  "evidenceRunId": "<nonce>",
  "commit": "<git sha>",
  "platform": "win32|linux",
  "node": "22.x",
  "packageVersion": "2.0.0",
  "packageManager": "pnpm@<version>",
  "lockDigest": "sha256:<digest>",
  "manifestDigest": "sha256:<digest>",
  "buildDigest": "sha256:<public-dist-digest>",
  "status": "passed",
  "tarballDigests": ["sha256:<core>", "sha256:<executor-local>", "sha256:<executor-worker>"]
}
```

Windows/Linux shard 和单独的 Ark full report 由以下命令显式合并：

```bash
pnpm validate:subagent:v2:release-report -- --windows=<windows-shard> --linux=<linux-shard> --ark=<ark-report>
```

merged release report 最少包含：

```json
{
  "design": "subagent-v2",
  "phase": "phase-1",
  "commit": "<git sha>",
  "packageVersion": "2.0.0",
  "packageManager": "pnpm@<version>",
  "lockDigest": "sha256:<digest>",
  "platformEvidence": [
    { "platform": "win32", "node": "22.x", "status": "passed", "digest": "sha256:<digest>" },
    { "platform": "linux", "node": "22.x", "status": "passed", "digest": "sha256:<digest>" }
  ],
  "offline": { "status": "passed", "manifestDigest": "sha256:<digest>" },
  "ark": {
    "profile": "full",
    "model": "kimi-k3|sha256:<custom-model-digest>",
    "buildDigest": "sha256:<public-dist-digest>",
    "status": "passed",
    "reservedCalls": 110,
    "sdkCreateAttempts": 110,
    "completedCalls": "<integer <= 110>",
    "usageReportedCalls": "<integer <= completedCalls>",
    "hardLimit": 112,
    "inputTokens": {
      "settled": "<integer>",
      "heldForUnknown": "<integer>",
      "limit": 1250000
    },
    "outputTokens": {
      "settled": "<integer>",
      "heldForUnknown": "<integer>",
      "limit": 120000
    },
    "unknownAttempts": "<integer>"
  },
  "artifactsDigest": "sha256:<digest>"
}
```

aggregator 必须要求三个输入的 commit、manifest digest、package version、package manager/lock digest 和 public dist build digest 一致，另要求 Windows/Linux shard 的 tarball digests 一致；Ark report 必须来自同一 checkout/build 的 full profile。它在合并后再次遍历完整 manifest，只有 Phase 1 每个 requirement 的所有必需 layer/variant（包括 L5）都有实际 case evidence 才能生成 release passed。只提供当前平台 shard 时只能得到 platform passed，不能生成 release passed。

不得把 key、endpoint credential、prompt 或业务正文加入报告。默认公开 alias `kimi-k3` 可以记录；自定义 `ARK_PLAN_MODEL` 可能是私有 endpoint ID，只记录 SHA-256 digest。自定义 base URL 同样只记录允许公开的 origin 或 digest。`commit` 必须是运行时 checkout 的 SHA，避免用旧验收产物批准新代码。

## 17. 通过、失败与重跑规则

- 任何必填测试、scenario、协议或 release platform 失败，阶段状态为 failed。
- 真实 provider 的 5xx、timeout、限流或区域故障记为 inconclusive/failed gate，命令仍退出 1；不能当成框架 passed。
- 模型未遵守严格 Tool 序列属于真实兼容性失败，不自动重试或把 prompt 临时放宽后忽略记录。
- 若确需修改 prompt/schema，必须提交代码、更新预期调用预算并从头运行整个 smoke/full profile。
- 人工重跑使用全新的 artifact 目录和根 session/run；只有专门的 resume/reconnect scenario 可以加载同一次场景的旧 checkpoint。
- 任何 provider generate 超过场景或全局预算时，在下一次网络调用前失败并终止该场景。
- full 通过要求 ARK-01 至 ARK-14 的所有变体均 passed，`sdkCreateAttempts=110` 与静态 manifest 一致，`reservedCalls=110` 且不超过 112；artifact secret scan 为 0 命中。`completedCalls` 与 `usageReportedCalls` 单独报告，不把被 abort 的真实尝试伪装成完成响应。

## 18. 已冻结的验收 Oracle

以下 22 项是实现与测试的唯一基线，不再保留 blocking 设计分支：

1. canonical JSON 固定为 RFC 8785/JCS：对象 key 按 UTF-16 code unit 排序、ECMAScript 数字序列化、`-0` 归一为 `0`、Unicode 不做 normalization、lone surrogate/非 I-JSON 字符拒绝；生成跨 Executor golden vectors。
2. input/output 默认各 256 KiB；projection 默认最多 32 项、单项 64 KiB、合计 128 KiB。等于上限通过，超一字节或一项失败。
3. cancel、timeout、budget、result/end 与 approval expiry 竞争由第一个合法 revision/lease/fencing CAS 胜出；terminal 不可逆，不设置隐藏优先级。
4. `retryOf` 只允许指向同 definition name/version 的非成功 terminal task；retry 创建新 task，成功终态和非终态都拒绝。
5. `supports()`、`supportedDefinitions`、availability、definition allowlist 与 capability 取保守交集，任一拒绝即不可选。
6. `contextProjector` 输入增加 `signal` 与 `deadlineAt`；取消/超时后不得继续创建 task。
7. v2 不支持 streaming；`stream=true` 在创建 run/task 前返回 `STREAMING_UNSUPPORTED`。
8. 普通父 Tool 失败写稳定脱敏 error envelope，继续 settle 并进入 agent sub-batch；只有 root cancel/timeout/状态损坏中止未提交 child。
9. StateStore event log 是权威；live subscriber 默认缓冲 256 项，取消立即清 listener，溢出返回 `EVENT_BACKPRESSURE` 和 cursor 后由 `afterSequence` 重放；长期 retention 由 Phase 3 adapter 配置。
10. approval 仅在 `now < expiresAt` 时可批准；`now >= expiresAt` 固定由 expiry CAS 进入 failed + `APPROVAL_EXPIRED`。
11. Memory same-process 恢复要求原 raw Handle 仍存活；Handle 丢失即 `RECOVERY_TARGET_LOST`。
12. Runtime 只通过显式异步 `refreshCatalog()` 刷新 availability 并递增 revision；构建模型 schema 不联网。
13. checkpoint migrator 在 init 按 `{recordKind,fromVersion,toVersion}` 注册；无路径为 `CHECKPOINT_VERSION_MISMATCH`，执行/输出失败为 `CHECKPOINT_MIGRATION_FAILED`，原记录不可变。
14. `ArtifactReference` 只含 `version/id/mediaType/size/sha256`，不含路径、URL 或凭证；默认单件 32 MiB、每 task 8 件/128 MiB，通过 owner session/task-scoped `ArtifactStore` 解析，Memory 生命周期不超过 task，durable retention 显式配置。
15. public lookup/control 对 unknown 与跨 session 统一返回固定 `RESOURCE_NOT_FOUND`、`retryable=false` 且不泄露存在性；`SESSION_MISMATCH` 仅供已鉴权内部诊断。
16. create 顺序固定为 identity/input/hash -> `ownerSessionId + runId + requestId` 幂等查询 -> catalog/projector/limits/budget；一致命中后直接返回原 task。
17. retry 是 host-only；模型 wire 不含 `taskId`/`retryOf`，父模型不能发起。
18. terminal 时 `getTask/getSubAgentSession/wait/events` 只读返回原状态，`cancel` 幂等返回原 snapshot，`resume` 返回 `INVALID_STATE_TRANSITION`；只有 external-binding `reconnect` 可只读返回原 terminal outcome。
19. host `requestId` 唯一作用域为 `ownerSessionId + runId`；不同 session/run 可复用同值，同作用域冲突 payload 返回 `IDEMPOTENCY_CONFLICT`。
20. 正常 paused 使用 outcome，不返回错误；`APPROVAL_REQUIRED` 只表示 `resume` 缺少当前有效 decisions；unknown 用 `RESOURCE_NOT_FOUND`，checkpoint 版本和 migrator 失败分别使用第 13 项错误码。
21. 过滤后目录为空时完全移除内置 `agent` Tool，模型请求中不存在占位 schema。
22. provider outcome unknown 时原 task 固定为 `failed + EXECUTOR_FAILED + outcomeUnknown=true`，该字段进入安全 snapshot/error/event；SDK、框架、队列和 Executor 都不得自动重发，只允许 host 显式 retry。

对应 requirement 必须以这些 Oracle 编写正反例，不得通过 skip 或适配器私有语义改写。

## 19. 完成定义

只有同时满足以下条件，本测试验收计划才算实施完成：

- L1-L4 的所有 Phase 1 requirement/variant 进入默认 `pnpm test` 并稳定通过；L0 由 typecheck/lint/build/manifest/legacy/pack 静态发布门禁完成。
- Core、Memory Local、Atomic File Local 通过 conformance；File Store 在 Windows/Linux 的真实进程故障测试通过。
- Chat/Responses 四种父子协议组合在 mock adapter 与真实方舟均通过。
- ARK smoke 保持 24 次硬上限；ARK full 的 14 个场景组以精确 110 次 SDK create attempt 在 112 次 reservation 硬上限内全部通过。
- Skills、Tool、context compact、summary、typed result、批处理、嵌套、审批、spawn、resume 和崩溃窗口都有真实模型证据。
- CAS、WAL、lease/fencing、幂等、安全反例和所有稳定错误码都有确定性证据。
- 默认日志与 artifact 通过 secret/payload 脱敏扫描。
- legacy `subAgents`、`AgentConstructor`、动态 `RuntimeSubAgent`、`agentName` 和 `outputDescription` 只允许出现在迁移文档，不出现在可执行代码。
- 包构建、ESM/CJS/types、README、demo 命令、环境变量和 pack 内容与 v2 一致。
- 默认 `pnpm test` 不需要 API key、不访问真实模型、不产生费用。

本方案中的远程真实验收始终验证 child task 的 execution placement；父 Agent 仍保持控制权，不测试也不暗示 handoff。
