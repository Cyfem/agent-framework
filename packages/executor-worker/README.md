# `@ruixutong.manee/maneeagent-executor-worker`

Manee Agent Framework 的官方 `worker_threads` Subagent Executor。它把一个受信任的 child Agent 放到独立 Worker isolate 中运行，并通过 Core transport bridge 把 checkpoint、审批、结果、事件、嵌套委派和 Model 请求接回 controller。

> **发布状态**：当前 checkout 的 package manifest 是待发布 `2.0.0`；该包尚未发布到 npm。发布前请通过本仓库 workspace 使用和验收，不能把 `npm pack` 成功视为已经发布。

要求 Node.js >= 22。包同时输出 ESM、CJS、TypeScript 声明和 source map，peer dependency 为 `@ruixutong.manee/maneeagent-framework@^2.0.0`。

## 能力边界

- 每个 live task 使用一个真实 `worker_threads.Worker`、一个 `MessageChannel` 和两端 Core Peer/bridge。
- Worker target 由 controller 通过本地 `file:` URL 静态选择；模型输入和 RPC wire 都不能选择模块路径、entrypoint 或任意代码。
- target 启动后先返回完整、闭合的 runner manifest。controller 重算 canonical digest 并逐字段匹配 `expectedManifest`，匹配前不发送 execution RPC。
- Worker binding 只保存版本化 `kind + jobId`；不保存 thread ID、路径、URL、Model 凭据或 raw handle。
- 支持 `execute`、`spawn`、cancel、事件、审批、provider usage 和 durable child checkpoint；`resume=checkpoint`，`reconnect=none`。
- child 的 Model 请求通过 credential-free protocol surface 和 controller-owned Model gateway 反向执行。方舟/OpenAI API key 应只存在于 controller Model 中，不能注入 Worker 环境、argv、workerData、binding、日志或 artifact。
- 这是 child execution placement，不是 handoff：根 Agent、run、session 和权威 StateStore 仍归 controller 所有。

## 安装（`2.0.0` 发布后）

```bash
npm install @ruixutong.manee/maneeagent-framework@^2.0.0 \
  @ruixutong.manee/maneeagent-executor-worker@^2.0.0 zod
```

仓库内使用 `workspace:^` 连接 Core；不要使用 demo 的 `@manee/*` workspace alias 作为 npm 安装名。

## 静态 Worker target

target entry 必须在模块顶层调用 `serveWorkerSubAgentTarget()`。`createRegistry()` 收到的是延迟、无凭据的 `modelExchange`；target 用它构造与 manifest 中 `gatewayId/protocol/codecVersion` 一致的 Model proxy。

```ts
// worker-target.ts
import {
  Agent,
  SubAgentTargetRunnerRegistry,
  createOpenAIResponsesProtocolSurface,
  createSubAgentTransportModelProxy,
  defineSubAgent,
  type SubAgentTargetRunnerRegistration,
} from '@ruixutong.manee/maneeagent-framework';
import { serveWorkerSubAgentTarget } from '@ruixutong.manee/maneeagent-executor-worker';
import { z } from 'zod';

const definition = defineSubAgent({
  name: 'research-child',
  version: '2',
  description: '在独立 Worker 中执行研究任务。',
  inputSchema: z.object({ query: z.string().min(1) }).strict(),
  outputSchema: z.object({ answer: z.string().min(1) }).strict(),
});

await serveWorkerSubAgentTarget({
  createRegistry: ({ modelExchange }) => {
    const registration = {
      definition,
      runnerId: 'research-worker-runner',
      runnerVersion: '2.0.0',
      childCheckpointVersions: ['1'],
      modelBinding: {
        gatewayId: 'research-responses',
        protocol: 'openai-responses',
        codecVersion: '1',
      },
      create: ({ executorName }) => {
        const agent = new Agent({
          llm: createSubAgentTransportModelProxy({
            protocol: createOpenAIResponsesProtocolSurface(),
            gatewayId: 'research-responses',
            exchange: modelExchange,
          }),
          maxIterations: 6,
        });
        return {
          run: (request, control) => {
            const input = definition.inputSchema.parse(request.input);
            return agent.runAsSubAgent({
              request,
              control,
              runnerId: 'research-worker-runner',
              runnerVersion: '2.0.0',
              executorName,
              checkpointMode: 'durable',
              input: input.query,
              outputSchema: definition.outputSchema,
            });
          },
        };
      },
    } satisfies SubAgentTargetRunnerRegistration<{ query: string }, { answer: string }>;

    return new SubAgentTargetRunnerRegistry().register(registration).seal();
  },
});
```

target entry 是受信任的部署配置。构造器拒绝非 `file:` URL、UNC/host、query 和 fragment；不能用 URL 参数动态切换 runner。
`runAsSubAgent()` 只接受 fresh、尚未 `init()` 的 child Agent，并会在 child 初始化阶段自行完成 `init()`；不要按普通根 Agent 的用法提前初始化该实例。

## Controller 侧

controller 必须持有与 target 完全一致的 `expectedManifest`，以及一个接入 Core `SubAgentTransportModelGatewayHandler` 的请求处理器：

```ts
import { WorkerSubAgentExecutor } from '@ruixutong.manee/maneeagent-executor-worker';

const workerExecutor = new WorkerSubAgentExecutor({
  targetEntry: new URL('./dist/worker-target.js', import.meta.url),
  expectedManifest,
  model: controllerModelRequestHandler,
  handshakeTimeoutMs: 10_000,
  terminateTimeoutMs: 5_000,
  maxConcurrentWorkers: 64,
  maxRetainedTasks: 10_000,
});
```

`controllerModelRequestHandler` 负责把 execution scope、checkpoint ACK、幂等 provider-operation ledger、预算和 controller Model 连接起来；不要在 Worker target 中直接构造带 API key 的 SDK client。可运行的 Chat/Responses fake-SDK 例子见仓库测试 `test/worker-protocol-proxy.test.ts`，完整 gateway contract 见 Core README。

## 取消、恢复与生命周期

- request signal、`executor.cancel()` 和 raw handle `cancel()` 都先发送协议 cancel；child 未在配置窗口内终止时调用 `Worker.terminate()`。`terminateTimeoutMs` 最大为 5 秒。
- Worker 在持久 checkpoint 后崩溃时返回 checkpoint recovery marker，由 Core 使用原 task/binding 并推进 execution attempt、epoch 和 fencing；不会降级为 create，也不会执行 live reconnect。
- 对 `model_result_ready` 回复丢失窗口，adapter 在仍有效的 execution scope 内最多进行一次精确 checkpoint replay，使 controller provider ledger 返回已持久化结果；不会为同一 provider operation 自动生成新 ID 或重复 SDK dispatch。
- provider operation 仍停留在 `in_flight`、没有持久化规范化结果时，原 task 固定失败并带 `outcomeUnknown=true`；Worker 不 resume、reconnect 或自动重发，只能由可信 host 显式创建业务 retry。
- result receipt 已经通过权威 CAS、但回复尚未到达 child 时发生 Worker crash，原 task 固定为 `failed` 并保留 `partialOutput`；receipt 只读重放，不创建 replacement job，不再调用 Model。
- terminal CAS 已经提交为 `succeeded`、但 completion 回复尚未到达调用方时发生 Worker crash，原成功终态保持不变；completion receipt 只读重放，不创建 replacement job，不再调用 Model。
- `drain()` 拒绝新 task，但不强杀正在运行的 Worker；`dispose()` 幂等停止所有 resident Worker 并释放 Port、timer 和 retained state。
- `maxRetainedTasks` 限制的是为 create/cancel 幂等保留的 compact terminal receipt/tombstone。终态会立即释放 Worker、Peer、Port、timer 等重资源，但不会用 LRU 删除仍需重放的 terminal/cancel 证据；容量耗尽时新 task fail closed，直到整个 Executor `dispose()`。当前没有公开的逐 task retention 删除 API。
- `diagnostics()` 只返回计数和生命周期状态，不返回 target 输出、prompt、凭据、路径或 thread capability。

## 安全边界

Worker 默认使用 `env: {}`、`argv: []`、`execArgv: []`、`stdin: false` 和 `trackUnmanagedFds: true`。stdout/stderr 由 controller 有界消费并丢弃，不回显内容；超出安全上限会终止 Worker。

`worker_threads` 只提供 JavaScript isolate 和独立执行生命周期，**不是安全沙箱**。target 仍是宿主 Node.js 进程中的受信任代码，能够使用宿主文件系统和网络权限；本包不隔离恶意代码，也不承诺操作系统级内存、CPU、文件或网络边界。需要执行不受信代码时，应使用容器或专用 sandbox，而不是本 Executor。

Artifact sidecar 使用 transferable owned `ArrayBuffer`，仍受 Core 默认边界约束：最多 8 件、单件 32 MiB、单 packet 合计 128 MiB。binding、RPC 错误和日志不得包含 artifact 路径、URL 或凭据。

## 开发与验收

从仓库根目录运行：

```bash
pnpm --filter @ruixutong.manee/maneeagent-executor-worker typecheck
pnpm --filter @ruixutong.manee/maneeagent-executor-worker lint
pnpm --filter @ruixutong.manee/maneeagent-executor-worker build
pnpm --filter @ruixutong.manee/maneeagent-executor-worker test
pnpm acceptance:subagent:v2:worker:offline
pnpm validate:subagent:v2:pack:worker
```

默认 package test 和 Worker offline shard 都不读取 API key、不访问真实模型，也不会产生费用。当前离线 manifest 已登记 `C7-WORKER-01`～`C7-WORKER-29`，覆盖 conformance、静态 target/manifest、环境与 secret 边界、binding/session scope、Chat/Responses fake SDK、transferable sidecar、真实 Worker 生命周期与 F08/F09/F19 恢复窗口。真实方舟 Worker placement 属于独立 L5 profile，L6/Docker/Linux 也尚未执行；因此 `C7-WORKER` requirement 仍为 `planned`，Phase 2 未通过。未运行的外部证据只能记录为 pending external evidence。

## 公共 API

- `WorkerSubAgentExecutor`
- `WorkerSubAgentExecutorOptions` / `WorkerSubAgentExecutorDiagnostics`
- `serveWorkerSubAgentTarget()` / `ServeWorkerSubAgentTargetOptions` / `WorkerSubAgentTargetRegistryContext`
- `workerSubAgentBindingCodec` / `decodeWorkerBinding()` / `WorkerSubAgentBindingState`
- `WORKER_SUBAGENT_ADAPTER_STATE_VERSION` / `WORKER_SUBAGENT_BINDING_KIND`

Worker channel message、bootstrap wire、内部 failpoint 和 Worker instance 不属于包根公共 API。
