# Manee Agent Local Executor

`@ruixutong.manee/maneeagent-executor-local` 是 Subagent v2 的官方宿主进程内 Executor 包，同时提供 Memory 与 Atomic File 两种 Core runtime state 适配器。要求 Node.js >= 22，并与 `@ruixutong.manee/maneeagent-framework` 2.x 配套使用。

当前 checkout 中该包的 manifest 是待发布的 `2.0.0`，npm registry 尚无此包；Core 的 npm `latest` 仍是 `1.0.0`。下面的安装命令面向两个 `2.0.0` 包发布后，在此之前请使用仓库 workspace。

```bash
npm install @ruixutong.manee/maneeagent-framework @ruixutong.manee/maneeagent-executor-local zod
```

## 组件

- `MemorySubAgentExecutor` 在宿主进程内为每个 task 创建隔离 child runner。同一 Executor 实例会复用等待审批的 runner；进程退出后，新实例可根据持久 binding 和完整 child checkpoint，从受信任 registry 精确重建 runner。
- `LocalSubAgentRunnerRegistry` 的每项注册都固定 definition 版本、`runnerId`、`runnerVersion` 和非空 `childCheckpointVersions`。Executor 会发布这份兼容矩阵，并把实际 runner identity 写入 binding。
- `createLocalAgentRunnerRegistration()` 把受信任的 definition-version Agent 工厂接到 Core 的 `runAsSubAgent()` 入口；工厂必须为每个 task 返回尚未运行的新实例，并显式把 definition input 映射为该协议的 user input。
- `MemoryAgentRuntimeStateStore` 提供进程内 state、lease 和 fencing。
- `AtomicFileAgentRuntimeStateStore` 为单个受信任本地主机提供进程崩溃恢复。使用前必须 `await store.init()`；不可变 WAL、checksum 链、commit marker 与 durable head 会检测缺失、重复或回滚的提交历史。
- `LocalFilesystemVerifier` / `defaultLocalFilesystemVerifier` 负责 Atomic File root 的 fail-closed 本地文件系统判定；其他平台或自定义文件系统必须由宿主显式提供 verifier。

```ts
import {
  Agent,
  defineSubAgent,
  type Model,
  type OpenAIChatProtocol,
} from '@ruixutong.manee/maneeagent-framework';
import {
  createLocalAgentRunnerRegistration,
  LocalSubAgentRunnerRegistry,
  MemoryAgentRuntimeStateStore,
  MemorySubAgentExecutor,
} from '@ruixutong.manee/maneeagent-executor-local';
import { z } from 'zod';

declare const reviewerModel: Model<OpenAIChatProtocol>;

const reviewerDefinition = defineSubAgent({
  name: 'reviewer',
  version: '2.0.0',
  description: 'Review one typed change request.',
  inputSchema: z.object({ change: z.string() }),
  outputSchema: z.object({ verdict: z.string(), findings: z.array(z.string()) }),
});

class ReviewerAgent extends Agent<OpenAIChatProtocol> {}

const stateStore = new MemoryAgentRuntimeStateStore();
const registry = new LocalSubAgentRunnerRegistry([
  createLocalAgentRunnerRegistration({
    definition: reviewerDefinition,
    runnerId: 'reviewer-agent',
    runnerVersion: '2.0.0',
    createAgent: () =>
      new ReviewerAgent({
        llm: reviewerModel,
        maxIterations: 8,
        systemPrompts: ['只审查当前 change；先提交 agent-result，再单独调用 end-agent。'],
      }),
    buildInput: ({ input }) => `请审查以下变更：\n${input.change}`,
  }),
]);
const executor = new MemorySubAgentExecutor({ registry });
```

`runAsSubAgent()` 会在 child 专用初始化阶段注入 typed `agent-result` 与 standalone `end-agent`、校验保留名冲突，并把 request 的 signal、deadline、task runtime metadata 与完整 checkpoint 交给独立 Agent loop。Local 不会调用普通 `init()`，也不会隐式继承父 Agent 的 Model、Tools、Skills、system prompts 或 context；这些能力必须在 `createAgent()` 中显式配置。`buildInput()` 是必填的协议映射，框架不会猜测 `JSON.stringify(input)`。

`MemorySubAgentExecutor` 对同一 create operation 的重放会先重新运行 registry/schema 校验，再比较 operation ID、idempotency key 和完整 owned child request hash；input、path、projection、delegation、limits 或其他稳定字段发生漂移都会返回 `IDEMPOTENCY_CONFLICT`，并发重复也只创建一个 runner。`LocalSubAgentRunnerRegistry.create()` 仅保留为无 checkpoint 的兼容入口，首次调用会 seal registry；传入 checkpoint 时会明确返回 `RECOVERY_UNSUPPORTED`，不会静默丢弃 checkpoint 或从头运行。新的 Executor/adapter 应直接使用 Core `prepareExecution()` 和完整 create/resume operation。

Child Tool 可以声明固定的 `approval: { summary, expiresInMs? }`。Core 会在 handler 前保存包含原 call 的 checkpoint，再通过 Local 透传的 `SubAgentExecutionControl.authorizeTool()` 请求宿主审批：首次返回 `suspend` 时 handler 不执行；宿主提交持久 decision 后，原 task、callId 和 checkpoint 恢复，只有 `approved` 才会执行一次 handler。`summary` 必须来自受信任配置，不能拼接模型参数；Local 本身不替宿主做授权判断。child 还可按 definition 的 delegation allowlist 调度下一层 Subagent；多 leaf approval 会和父 checkpoint 原子保存并按原 task identity 恢复。并发 leaf 的审批可以先后到达：每轮恢复都会重新核对 authoritative task 与父 pending batch，只暴露尚未决定的审批，已完成 sibling、Tool handler 和 provider 结果不会重放。

Local child 的普通 Model 请求、`context-summary` 和父 Agent 请求使用同一 root-run provider ledger，并在 SDK dispatch 前原子预留；达到 `maxProviderCalls` 时不会调用 provider。已明确返回的 HTTP 4xx/5xx 可以清除本次 in-flight intent，再进入配置的 model-error recovery；例如 `context_length_exceeded` 可执行 durable summary 与安全 retry。相反，provider intent 已持久化为 `in_flight` 后发生 abort、超时或连接结果不确定时，checkpoint 比同时到达的取消更权威：task 固定进入 `failed + MODEL_OUTCOME_UNKNOWN`，不能自动恢复或重发。

Registry 只接受宿主代码注册的受信任工厂，不会根据模型输入动态加载类或模块。需要直接适配其他协议无关 loop 时，仍可注册底层 `SubAgentChildRunner`。内置 Chat/Responses Model 提供版本化 checkpoint codec。当前 `MemorySubAgentExecutor` 明确声明 `checkpoint` recovery，因此 `createLocalAgentRunnerRegistration()` 会向 Agent 传入 `checkpointMode: 'durable'`，没有 codec 的自定义协议会在任何 provider 请求前被拒绝；它只能改用宿主实现、Catalog 明确声明 `same_process` 的其他内存 placement，且不能审批暂停、checkpoint resume 或跨进程恢复。本包没有提供这条 `same_process` placement。

## StateStore scope

两个 StateStore 只接受 Core 生成的 scope：

- `subagent-session:<ownerSessionId>`
- `subagent-task:<ownerSessionId>:<taskId>`
- 根 run 使用的 canonical JSON scope：`agent-run:[<ownerSessionId>,<runId>]`

它们都会拒绝来自其他 owner session 的 lease，并在 transaction commit 时重新校验 lease 与 fencing ownership。公开 fencing token 使用 canonical unsigned base-10 字符串（`0` 或无前导零的正整数）；Memory/Atomic File Store 都按严格单调的大整数语义生成，Core 会在 acquire、renew、恢复及 transport 边界重验。

## Atomic File 安全与一致性边界

Atomic File 不是远程或分布式 StateStore，只承诺受控本地主机上的 process-crash recovery，不承诺断电一致性或多节点写入。宿主必须提供已经校验、由当前 owner 控制的本地目录：

- 拒绝 UNC 路径与符号链接 root；POSIX 目录必须仅 owner 可访问。
- Windows 默认拒绝 `DriveType=4` 映射盘。
- Linux 会交叉检查 `/proc/self/mountinfo` 最长匹配项与 `statfs()` magic，拒绝已知 NFS、SMB、CIFS、9P 和 Ceph 类型。
- 未知 drive、mount、filesystem 或校验失败全部 fail closed。其他平台或文件系统必须显式注入返回 `local` 的 `LocalFilesystemVerifier`。
- 本包不声明已完成 Windows ACL 验证或 race-free no-follow 全路径遍历；构造 Store 前应由部署层设置并验证目录 ACL。
- owner generation 与发布前遗留 candidate 会保留，避免迟到 contender 删除或复用旧 owner 路径。只能在全部 writer 停止的维护窗口清理。

Local Executor 声明 checkpoint recovery。新实例恢复时，Core 必须提供完整 checkpoint，且其版本、`runnerId`、`runnerVersion` 必须与受信任 registry 精确匹配。与 `AtomicFileAgentRuntimeStateStore` 配合可恢复本地进程崩溃，但不会获得断电、网络文件系统、多主机或 external reconnect 保证。

## 跨进程恢复验收

L3 专用配置包含五类真实 Node.js 进程恢复：

- Executor task 测试让进程 A 持久化等待审批的 task、binding 与完整 checkpoint，并持有 lease；宿主终止 A，通过共享 `ManualClock` 精确推进到 lease 过期边界，进程 B 再从同一个 Atomic File Store 重建 runtime 与 registry。它锁定 stable ID、旧 fencing CAS 拒绝、新 fencing 严格递增，以及 result receipt 与审计 event 不重复。
- 完整根 Agent 测试让同一 provider batch 先执行普通 Tool，再并发放置一个等待审批和一个已经完成的 child。宿主在 root `waiting_approval` 后终止进程 A；进程 B 重建 Runtime/Agent 并调用 `resumeRun()`，验证普通 Tool 和成功 sibling 不重放、原 run/task/call ID 不变、typed 结果按 provider 顺序回填。
- 父子 dispatch failpoint 测试分别在 task staged 但尚未原子关联父 call，以及父 call/task 已原子提交但尚未 dispatch 时终止进程。未提交 task 对恢复进程不可见；已提交 task 则由新进程按原 run/task/call/request identity 仅 dispatch 一次。
- running child 测试在普通 child Tool 结果已持久化为 `result_ready` 且 execution lease 仍有效时终止进程 A。共享 `ManualClock` 同时推进 root 与 execution lease；进程 B 取得更高 fencing、采用原 checkpoint 继续执行，并验证 provider 与已完成 Tool 均不重放、没有走 external reconnect。
- 跨协议根 Agent 测试分别覆盖 Responses parent → Chat child 与 Chat parent → Responses child。每个方向都在 approval pause 后强杀进程 A，由进程 B 使用各自版本化 codec 恢复同一 run/task/call；同时验证 Local 明确拒绝 `reconnect()`、仅走 checkpoint resume，父普通 Tool、审批 Tool 与 provider 请求均不重放。

五类 fixture 都先构建到操作系统临时目录。子进程仅继承严格环境变量白名单，stdout/stderr 会做凭证关键字扫描，临时状态和 bundle 在结束时清理。

普通 Local Vitest 配置显式排除该进程级用例；使用单线程专用配置运行：

```bash
pnpm --filter @ruixutong.manee/maneeagent-executor-local exec vitest run --config vitest.process.config.ts
```

## 发布内容

包根入口公开 `MemorySubAgentExecutor`、`LocalSubAgentRunnerRegistry`、`createLocalAgentRunnerRegistration()`、Memory/Atomic File StateStore、filesystem verifier 及其配套 options/types，不提供子路径入口或 CLI `bin`。构建产物包含 ESM `dist/index.js`、CommonJS `dist/index.cjs`、NodeNext-safe TypeScript 声明、source map 和本 README；仓库的 `pnpm validate:subagent:v2:pack` 会把 Local 与同一轮生成、peer range 可接受的 Core 真实 tarball 一起解包，不借用 workspace Core 目录，再以正式包名执行 ESM/CommonJS runtime smoke、NodeNext 双消费者类型检查、关键公开 class/constructor/options 非 `any` 断言和 missing-export 负检。门禁同时锁定包名、Node.js 要求、根 exports、无 `bin`、发布文件正向白名单与敏感文件拒绝；child process 使用最小环境白名单和 wall-clock watchdog。`npm pack --dry-run` 或临时生成 tarball 都只验证待发布内容，不代表该包已经发布到 registry。
