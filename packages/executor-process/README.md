# `@ruixutong.manee/maneeagent-executor-process`

Manee Agent Framework 的官方 `child_process` Subagent Executor。它把一个受信任的 child Agent 放到独立 Node.js 子进程中运行，并通过 Core transport bridge 把 checkpoint、审批、结果、事件、嵌套委派和 Model 请求接回 controller。

> **发布状态**：当前 checkout 的 package manifest 是待发布 `2.0.0`；该包尚未发布到 npm。发布前请通过本仓库 workspace 使用和验收，不能把 `npm pack` 成功视为已经发布。

要求 Node.js >= 22。包同时输出 ESM、CJS、TypeScript 声明和 source map，peer dependency 为 `@ruixutong.manee/maneeagent-framework@^2.0.0`。

## 能力边界

- 每个 live task 使用一个真实 `node:child_process` 子进程和一条 advanced-serialization IPC channel。
- target 由 controller 通过本地 `file:` URL 静态选择；模型输入和 RPC wire 都不能选择模块路径、entrypoint、PID 或任意代码。
- 子进程启动后先返回完整、闭合的 runner manifest；controller 重算 canonical digest 并逐字段匹配 `expectedManifest`，匹配前不发送 execution RPC。
- Process binding 只保存版本化 `kind + jobId`，不保存 PID、路径、URL、Model 凭据或 raw handle。
- 支持 `execute`、`spawn`、`cancel`、事件、审批、provider usage 和 durable child checkpoint；`resume=checkpoint`，`reconnect=none`。
- child 的 Model 请求通过 credential-free protocol surface 和 controller-owned Model gateway 反向执行。方舟/OpenAI API key 应只存在于 controller Model 内存中，不能注入子进程环境、argv、binding、IPC 日志或 artifact。
- 这是 child execution placement，不是 handoff：根 Agent、run、session、StateStore 和权限仍归 controller 所有。

## 安装（`2.0.0` 发布后）

```bash
npm install @ruixutong.manee/maneeagent-framework@^2.0.0 \
  @ruixutong.manee/maneeagent-executor-process@^2.0.0 zod
```

仓库内使用 `workspace:^` 连接 Core；不要使用 demo 的 `@manee/*` workspace alias 作为 npm 安装名。

## 静态 Process target

target entry 必须在模块顶层调用 `serveProcessSubAgentTarget()`。`createRegistry()` 收到的是延迟、无凭据的 `modelExchange`；target 用它构造与 manifest 中 `gatewayId/protocol/codecVersion` 一致的 Model proxy。

```ts
// process-target.ts
import {
  Agent,
  SubAgentTargetRunnerRegistry,
  createOpenAIResponsesProtocolSurface,
  createSubAgentTransportModelProxy,
  defineSubAgent,
  type SubAgentTargetRunnerRegistration,
} from '@ruixutong.manee/maneeagent-framework';
import { serveProcessSubAgentTarget } from '@ruixutong.manee/maneeagent-executor-process';
import { z } from 'zod';

const definition = defineSubAgent({
  name: 'research-child',
  version: '2',
  description: '在独立 Node.js 子进程中执行研究任务。',
  inputSchema: z.object({ query: z.string().min(1) }).strict(),
  outputSchema: z.object({ answer: z.string().min(1) }).strict(),
});

await serveProcessSubAgentTarget({
  createRegistry: ({ modelExchange }) => {
    const registration = {
      definition,
      runnerId: 'research-process-runner',
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
              runnerId: 'research-process-runner',
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

target entry 是受信任的部署配置。构造器拒绝非 `file:` URL、UNC/host、query 和 fragment；不能用 URL 参数动态切换 runner。`runAsSubAgent()` 要求 fresh、尚未 `init()` 的 child Agent，并会在 child 初始化阶段自行完成 `init()`。

## Controller 侧

controller 必须持有与 target 完全一致的 `expectedManifest`，以及接入 Core `SubAgentTransportModelGatewayHandler` 的请求处理器：

```ts
import { ProcessSubAgentExecutor } from '@ruixutong.manee/maneeagent-executor-process';

const processExecutor = new ProcessSubAgentExecutor({
  targetEntry: new URL('./dist/process-target.js', import.meta.url),
  expectedManifest,
  model: controllerModelRequestHandler,
  handshakeTimeoutMs: 10_000,
  terminateTimeoutMs: 5_000,
  maxConcurrentProcesses: 64,
  maxRetainedTasks: 10_000,
});
```

`controllerModelRequestHandler` 负责把 execution scope、checkpoint ACK、幂等 provider-operation ledger、预算和 controller Model 连接起来。不要在 Process target 中构造带 API key 的 SDK client。

## IPC、取消与生命周期

- Executor 固定使用当前绝对 `process.execPath`、空 `execArgv`、advanced serialization、`detached: false` 和单一 IPC fd；`fork()` 本身不通过 shell。
- 两个方向都有同步、有界的 message/byte admission。`child.send()` 返回 `false` 只表示 Node IPC backlog，不表示消息未接纳；真正的 I/O settle 由 callback 决定，adapter 不因此重发。
- IPC packet 仍按 Core closed wire 重验。frame 最大 16 MiB，sidecar 最多 8 件、单件 32 MiB、合计 128 MiB；adapter 在复制前检查数量和字节上限，并拒绝 IPC `sendHandle`。
- request signal、`executor.cancel()` 和 raw handle `cancel()` 都先发送协议 cancel；未在配置窗口内关闭时强制终止直属子进程，并以 `close` 事件作为 stdio/IPC 已释放的最终证据。`exit`、`kill()` 返回值或 `child.killed` 都不是资源已经释放的证明。
- controller IPC 意外断开时，target 会启动 ref'ed 有界 watchdog，尝试清理后强制退出，避免正常事件循环仍可调度时的受控直属子进程长期失联。该 watchdog 是协作式 Node.js 生命周期边界；target 若永久阻塞事件循环，timer 本身无法提供操作系统级强制隔离。
- `drain()` 拒绝新 task，但不主动终止已运行子进程；`dispose()` 幂等停止 resident child。若强制终止后仍未观察到 `close`，dispose 会失败并保留可审计的 child handle，不会伪报资源已清零。
- `maxRetainedTasks` 保存 compact create/cancel terminal receipt。终态会释放 Process、Peer、IPC、stdio 和 timer 等重资源，但不会通过 LRU 删除仍需幂等重放的证据；容量耗尽时新 task fail closed，直到整个 Executor `dispose()`。

## 崩溃与恢复

- 子进程在持久 checkpoint 后崩溃时返回 checkpoint recovery marker，由 Core 使用原 task/binding 推进 execution attempt、epoch 和 fencing；不降级为 create，也不执行 live reconnect。
- 对 `model_result_ready` 回复丢失窗口，adapter 在仍有效的 execution scope 内最多进行一次精确 checkpoint replay，使 controller provider ledger 返回已持久化结果；不创建新 provider operation，也不重复 SDK dispatch。
- provider operation 仍停留在 `in_flight` 且没有持久化规范化结果时，原 task 固定失败并带 `outcomeUnknown=true`；Process 不自动重发 provider 调用，只能由可信 host 显式创建业务 retry。
- result receipt 已通过权威 CAS、但回复尚未到达 child 时进程崩溃，原 task 固定为 `failed` 并保留 `partialOutput`；receipt 只读重放，不创建 replacement job。
- terminal CAS 已提交为 `succeeded`、但 completion 回复尚未到达调用方时进程崩溃，原成功终态保持不变；completion receipt 只读重放，不创建 replacement job。

## 安全边界

子进程使用最小启动环境：`PATH` 显式为空，只保留 Node/Windows 启动所需的少量系统变量；不继承 `NODE_*`、`ARK_*`、`TOKEN`、`SECRET`、`KEY`、`PASSWORD`、`CREDENTIAL`、`AUTH`、`COOKIE`、`LD_*` 或 `DYLD_*`。Windows 可能由操作系统/Node 补充非凭据系统变量，因此安全保证是“敏感宿主变量不传播”，不是“环境键集合完全为空”。stdout/stderr 由 controller 有界消费并丢弃，不回显正文；任一流超过 64 KiB 会 fail closed。

`child_process` 只提供独立进程与受控直属子进程的协作式生命周期，**不是安全沙箱**。target 仍是宿主信任的 Node.js 代码，能够使用宿主文件系统、网络权限、阻塞自己的事件循环并自行创建后代进程；本包不隔离恶意代码，也不承诺清理任意进程树。需要执行不受信代码时，应使用容器或专用 sandbox。

## 开发与验收

从仓库根目录运行：

```bash
pnpm --filter @ruixutong.manee/maneeagent-executor-process typecheck
pnpm --filter @ruixutong.manee/maneeagent-executor-process lint
pnpm --filter @ruixutong.manee/maneeagent-executor-process build
pnpm --filter @ruixutong.manee/maneeagent-executor-process test
pnpm acceptance:subagent:v2:process:offline
pnpm validate:subagent:v2:pack:process
```

默认 package test 和独立 Process offline shard 都不读取 API key、不访问真实模型，也不会产生费用。当前离线 case 覆盖 conformance、静态 target/manifest、环境和 secret 边界、binding/session scope、Chat/Responses fake SDK、advanced-serialization sidecar、真实子进程 handshake/cancel/kill/exit/close、孤儿 watchdog、容量/资源清理和 F08/F09/F19 恢复窗口。真实方舟 Process placement 属于独立 L5 profile，L6/Docker/Linux 也尚未执行；因此 `C7-PROCESS` requirement 仍为 `planned`，Phase 2 尚未通过。

## 公共 API

- `ProcessSubAgentExecutor`
- `ProcessSubAgentExecutorOptions` / `ProcessSubAgentExecutorDiagnostics`
- `serveProcessSubAgentTarget()` / `ServeProcessSubAgentTargetOptions` / `ProcessSubAgentTargetRegistryContext`
- `processSubAgentBindingCodec` / `decodeProcessBinding()` / `ProcessSubAgentBindingState`
- `PROCESS_SUBAGENT_ADAPTER_STATE_VERSION` / `PROCESS_SUBAGENT_BINDING_KIND`

Process channel message、bootstrap wire、IPC writer、PID、entry path、内部 failpoint 和 child handle 不属于包根公共 API。
