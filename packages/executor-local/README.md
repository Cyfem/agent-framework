# Manee Agent Local Executor

`@ruixutong.manee/maneeagent-executor-local` 是 Subagent v2 的官方宿主进程内 Executor 包，同时提供 Memory 与 Atomic File 两种 Core runtime state 适配器。要求 Node.js >= 22，并与 `@ruixutong.manee/maneeagent-framework` 2.x 配套使用。

```bash
pnpm add @ruixutong.manee/maneeagent-framework @ruixutong.manee/maneeagent-executor-local
```

## 组件

- `MemorySubAgentExecutor` 在宿主进程内为每个 task 创建隔离 child runner。同一 Executor 实例会复用等待审批的 runner；进程退出后，新实例可根据持久 binding 和完整 child checkpoint，从受信任 registry 精确重建 runner。
- `LocalSubAgentRunnerRegistry` 的每项注册都固定 definition 版本、`runnerId`、`runnerVersion` 和非空 `childCheckpointVersions`。Executor 会发布这份兼容矩阵，并把实际 runner identity 写入 binding。
- `MemoryAgentRuntimeStateStore` 提供进程内 state、lease 和 fencing。
- `AtomicFileAgentRuntimeStateStore` 为单个受信任本地主机提供进程崩溃恢复。使用前必须 `await store.init()`；不可变 WAL、checksum 链、commit marker 与 durable head 会检测缺失、重复或回滚的提交历史。

```ts
import type {
  SubAgentChildRunRequest,
  SubAgentChildRunner,
} from '@ruixutong.manee/maneeagent-framework';
import {
  LocalSubAgentRunnerRegistry,
  MemoryAgentRuntimeStateStore,
  MemorySubAgentExecutor,
} from '@ruixutong.manee/maneeagent-executor-local';

declare function createTrustedReviewerRunner(
  request: SubAgentChildRunRequest,
): SubAgentChildRunner | Promise<SubAgentChildRunner>;

const stateStore = new MemoryAgentRuntimeStateStore();
const registry = new LocalSubAgentRunnerRegistry([
  {
    definition: { name: 'reviewer', version: '2.0.0' },
    runnerId: 'reviewer-agent',
    runnerVersion: '2.0.0',
    childCheckpointVersions: ['1'],
    create: async ({ request }) => createTrustedReviewerRunner(request),
  },
]);
const executor = new MemorySubAgentExecutor({ registry });
```

上例中的 `createTrustedReviewerRunner()` 由宿主实现，必须返回 Core 的 `SubAgentChildRunner`。Registry 只接受受信任工厂；它不是从模型输入动态加载代码的机制。

## StateStore scope

两个 StateStore 只接受 Core 生成的 scope：

- `subagent-session:<ownerSessionId>`
- `subagent-task:<ownerSessionId>:<taskId>`
- 根 run 使用的 canonical JSON scope：`agent-run:[<ownerSessionId>,<runId>]`

它们都会拒绝来自其他 owner session 的 lease，并在 transaction commit 时重新校验 lease 与 fencing ownership。

## Atomic File 安全与一致性边界

Atomic File 不是远程或分布式 StateStore，只承诺受控本地主机上的 process-crash recovery，不承诺断电一致性或多节点写入。宿主必须提供已经校验、由当前 owner 控制的本地目录：

- 拒绝 UNC 路径与符号链接 root；POSIX 目录必须仅 owner 可访问。
- Windows 默认拒绝 `DriveType=4` 映射盘。
- Linux 会交叉检查 `/proc/self/mountinfo` 最长匹配项与 `statfs()` magic，拒绝已知 NFS、SMB、CIFS、9P 和 Ceph 类型。
- 未知 drive、mount、filesystem 或校验失败全部 fail closed。其他平台或文件系统必须显式注入返回 `local` 的 `LocalFilesystemVerifier`。
- 本包不声明已完成 Windows ACL 验证或 race-free no-follow 全路径遍历；构造 Store 前应由部署层设置并验证目录 ACL。
- owner generation 与发布前遗留 candidate 会保留，避免迟到 contender 删除或复用旧 owner 路径。只能在全部 writer 停止的维护窗口清理。

Local Executor 声明 checkpoint recovery。新实例恢复时，Core 必须提供完整 checkpoint，且其版本、`runnerId`、`runnerVersion` 必须与受信任 registry 精确匹配。与 `AtomicFileAgentRuntimeStateStore` 配合可恢复本地进程崩溃，但不会获得断电、网络文件系统、多主机或 external reconnect 保证。
