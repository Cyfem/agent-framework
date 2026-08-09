# `@ruixutong.manee/maneeagent-executor-http`

Manee Agent Framework 的 HTTP Subagent wire 基础包。当前 `2.0.0` checkout 提供严格的单包 `multipart/mixed` 编解码、HMAC-SHA256 v1 验签、原子 replay cache SPI、owner scope 授权顺序、脱敏 admission 结果，C7c-5b 的 closed poll command、route↔RPC policy 和 semantic packet receipt，C7c-5c 的 create/replay Job Store 地基，以及 C7c-5d-a 的 current-attachment delivery/ACK/wait Store 地基。

> **当前范围与发布状态**：该包尚未发布到 npm，也还不是可运行的 HTTP Executor。C7c-5d-a 只在 C7c-5c create/replay Store 上增加 Store IO context、当前初始 attachment 的 outbound delivery ledger、单包 offer/精确 ACK 和有界 wait；它不包含 production durable Store adapter、HTTP listener/client、heartbeat handler、delivery response codec、attachment/generation rotate、Peer pending/resequence import、approval resume、external reconnect 或 Remote `SubAgentExecutor`。这些能力仍属于后续 C7c-5；因此当前 Phase 2 仍未通过。`npm pack` 成功不等于已经发布。

要求 Node.js >= 22。包同时输出 ESM、CJS、TypeScript 声明和 source map，peer dependency 为 `@ruixutong.manee/maneeagent-framework@^2.0.0`。

## 安装（`2.0.0` 发布后）

```bash
npm install @ruixutong.manee/maneeagent-framework@^2.0.0 \
  @ruixutong.manee/maneeagent-executor-http@^2.0.0
```

仓库内通过 `workspace:^` 使用 Core；demo 的 `@manee/*` workspace alias 不是 npm 安装名。

## 已交付能力

- 精确解析七条 v1 route：`/v1/heartbeat`、`/v1/jobs/create`、四条 job action route 和 control reply route。
- 将一个 Core `SubAgentTransportPeerPacket` 编码为一次完整、可签名的 `multipart/mixed` body，或在所有 part 验证后返回 owned packet。
- 生成并验证六个单值 `Manee-*` header，签名覆盖 method、原始 request target 和完整 multipart body digest。
- 在签名通过后原子消费 `(keyId, nonce)` replay receipt；生产模式只接受调用方提供的 distributed cache。
- 在无业务副作用的 multipart/strict RPC decode 后解析 owner scope，再独立执行 authorization；只有授权成功才调用 `onPacket`。
- 返回固定、`no-store` 的 401/400/503/500 安全响应，并只允许脱敏 diagnostic。
- 编解码最大 4 KiB 的 closed poll command，并将 `channelGeneration`、`ackCursor` 与 Core event sequence/Peer sequence 分离。
- 对七条 route 与 strict RPC kind/operation/mode 做 closed 匹配，并为合法 packet 计算忽略 HTTP/Peer 重试身份的 semantic SHA-256 receipt。
- 从一次严格 owned `jobs.create` decode 生成排除 transport-relative `remainingMs` 的 create identity，并通过三条唯一索引原子 create/replay 初始 job record。
- 提供 full-scope load、只返回 owner 的 pre-authorization lookup，以及同时受 job 数和 protocol-retained bytes 限制的 loopback-test Memory Store。
- 在同一初始 Core Peer channel/generation 内原子 enqueue target outbound packet，以独立 remote cursor 做单包 offer、精确 cumulative ACK、response-loss replay 和有界 change wait。

当前包不打开端口、不访问网络、不读取环境变量或 API key，也不会发起真实模型请求。

## HMAC v1

固定 canonical string 为：

```text
MANEE-HMAC-SHA256-V1
<keyId>
<timestamp>
<nonce>
POST
<exact request target>
<lowercase sha256 of raw multipart body>
```

末尾没有换行。六个 header 为：

- `Manee-Auth-Version: 1`
- `Manee-Key-Id`
- `Manee-Timestamp`
- `Manee-Nonce`
- `Manee-Body-SHA256`
- `Manee-Signature`

`keyId` 使用最多 128 字符的 opaque ASCII token；key 至少 32 bytes。timestamp 默认窗口为正负 60 秒且边界有效；nonce 是无 padding、canonical base64url，解码后 16～64 bytes；signature 解码后必须精确为 32 bytes并使用 constant-time compare。认证成功后 replay receipt 的 TTL 固定为 120 秒。

生产适配器必须从真实 socket/listener 状态构造 `transport.tls`、`transport.loopback`、`requestTargetPreserved` 和 `redirectCount`，不能从用户 header 推断或相信调用方正文。production 模式要求 TLS、原始 request target 未被改写、无 redirect 和 distributed replay cache；`loopback-test` 只允许 TLS 或显式 loopback。

Node.js 22 的 HTTP parser 会在 `rawHeaders` 暴露前去掉 header value 外围 OWS。因此 verifier 把外围 SP/TAB 按 HTTP 语义视为等价，但仍拒绝 duplicate/merged value、空值、内部 TAB、逗号、ASCII C0/DEL 和非 canonical 字段格式。若部署必须拒绝 wire 上的外围 OWS，应由能够观察原始 TLS bytes 的前置代理执行，不能由 Node `IncomingMessage` handler 伪造保证。

## Multipart wire

top-level `Content-Type` 必须是未加引号的精确 `multipart/mixed; boundary=<token>`。body 没有 preamble 或 epilogue：

1. 第一 part 只有一行精确 `Content-Type: application/vnd.maneeagent.packet+json`，正文是 closed `{ version, frame, sidecars }` JSON。
2. 后续 binary part 按 descriptor 顺序出现，每个 part 只有按固定顺序、大小写和 `: ` 格式写入的 `Content-Type: application/octet-stream` 与 `Content-ID`。
3. closing boundary 后只能有一个 CRLF。

不支持 nested multipart、`Content-Transfer-Encoding`、base64 fallback、未知 part header、preamble/epilogue 或任意 content sniffing。decoder 根据已验 descriptor 的 `byteLength` 读取 binary，不在任意二进制里搜索 boundary；完整 packet、RPC frame、sidecar count/order/ID/length/SHA-256 全部通过后才返回 owned copy。

## Poll command、route policy 与 semantic receipt

poll transport command 使用精确 `Content-Type: application/vnd.maneeagent.poll+json`，body 是最大 4 KiB 的 closed JSON：

```json
{
  "version": "1",
  "channelId": "trusted-channel-id",
  "channelGeneration": "1",
  "ackCursor": "0",
  "waitMs": 10000
}
```

`channelId` 是最多 128 字符的 opaque ASCII token；`channelGeneration` 与 `ackCursor` 是 canonical decimal uint64 string；`waitMs` 是 `0..10000` 的整数。它们只定义后续 HTTP job transport 的 signed command wire，不会自行查找 job、确认 delivery、启动 long poll 或推进任何 cursor。remote cursor、Core task-event `sequence` 与 Peer envelope `sequence` 是三个独立域，不能互相复用。

`decodeHttpSubAgentRoutedPacket()` 会重新验证 parsed route、strict RPC frame、sidecar bytes/digest 和默认 Core hard cap，再执行以下纯 policy；它不调用 Peer/Core：

| route                      | 允许的 packet                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `heartbeat`                | 不允许 packet                                                                                                   |
| `jobs.create`              | `executor.request` + `operation=create` + `mode=execute` 或 `mode=spawn`                                        |
| `jobs.resume`              | `executor.request` + `operation=resume` + `mode=execute`                                                        |
| `jobs.reconnect`           | `executor.request` + `operation=reconnect` + `mode=spawn`                                                       |
| `jobs.cancel`              | `cancel.request`                                                                                                |
| `jobs.poll` multipart 分支 | `snapshot.request` 或 `events.request`                                                                          |
| `jobs.control-reply`       | `control.reply`、`model.reply`、`events.page` 或 `protocol.error`，且 path `requestId` 等于 RPC `correlationId` |

`createHttpSubAgentPacketSemanticReceipt()` 对合法 routed packet 计算 JCS SHA-256。投影保留 route kind/job scope、RPC kind/task/operation/payload 和按 `sidecarId` 排序的完整 descriptor；排除 HMAC nonce/timestamp/signature、multipart boundary，以及 Peer `channelId/sequence/messageId/correlationId` 和 control-reply path requestId。相同业务重试因此稳定，任何业务 payload、task/operation、job scope 或已验 sidecar 内容变化都会得到不同 receipt。它不是 job store、delivery ACK 或 create idempotency ledger。

## C7c-5c create/replay Job Store 地基

`createHttpSubAgentJobCreateIdentity({ route, packet })` 只接受通过 `jobs.create` policy 的 strict `executor.request + operation=create`。它只 decode/own 完整 packet 一次，并从同一 snapshot 返回 owner/run/task/operation/idempotency/mode/channel/remaining metadata、owned packet、`createIdentity` 和首包 `createReceipt`：

- `createIdentity` 是 `{ version, mode, requestWithoutRemainingMs, sidecarDescriptorsSortedBySidecarId }` 的 JCS SHA-256。它排除 HTTP/HMAC/multipart 与 Peer `channelId/sequence/messageId/correlationId`，也排除会随重试衰减的 `remainingMs`；完整 create request 业务字段和已验 sidecar descriptor 仍参与 hash。
- `createReceipt` 是 C7c-5b 的完整 semantic packet receipt，保留首次请求的 `remainingMs` 业务快照；它用于审计首写证据，不替代 `createIdentity`。

`HttpSubAgentJobStore.createOrReplay()` 的原子唯一域固定为三条索引：

1. create key：`principalId + ownerSessionId + idempotencyKey`；
2. route job：`principalId + jobId`；
3. logical task：`principalId + ownerSessionId + taskId`。

首写创建 closed `HttpSubAgentJobRecordV1`：`state='created'`、`revision='0'`、`channelGeneration='0'`，并保留首次 `channelId`、`remainingMsCeiling`、Store clock 生成且相等的 `createdAt/updatedAt` 及完整 owned `createPacket`。相同 create key 只有在 `createIdentity` 相同且新的 `remainingMs <= remainingMsCeiling` 时返回原 record；replay 的 candidate `jobId` 被忽略，且不会读取 clock、修改 timestamp/revision 或扩张 deadline。identity 变化、deadline 扩张、principal-scoped jobId 冲突或 logical task 冲突统一以 `HttpSubAgentJobStoreError.category='idempotency_conflict'` fail closed。

`load({ principalId, ownerSessionId, jobId })` 必须完整命中 scope；错 principal、错 owner 与 unknown 都返回 `undefined`。`resolveForAuthorization({ principalId, jobId })` 只向受信 handler 返回 frozen `{ ownerSessionId }`，用于随后立即调用独立 authorizer；它不会在授权前复制或暴露 task/hash/full packet，也不能把 found/missing/owner 差异直接映射到外部响应。

`MemoryHttpSubAgentJobStore` 只能用 `{ mode: 'loopback-test' }` 构造，默认最多保留 10,000 个 job、256 MiB protocol-retained bytes。`retainedBytes` 精确定义为 canonical frame UTF-8 bytes，加每个 canonical sidecar descriptor JSON UTF-8 bytes，再加 raw sidecar bytes；它不是 JavaScript heap 总量估算。job 数或 bytes 任一耗尽时，新 create 返回 `capacity_exhausted`，不会 LRU/TTL/逐 job 删除；已经保留的合法 replay 仍优先命中。`dispose()` 幂等地归零 Store-owned sidecar bytes并清空三个 Memory 索引，之后 create/load/authorization lookup 固定返回 `disposed`。每次公开 create/load 结果都重新复制 packet bytes，调用方修改返回的 `Uint8Array` 不会改变 Store 内部 record。

## C7c-5d-a current-attachment delivery Store 地基

`HttpSubAgentJobDeliveryStore` 在 5c 的 immutable create record 之外维护 closed delivery state，并只接受该 record 已固定的 `channelId` 与初始 `channelGeneration='0'`。它不开放任意 record CAS，也不提供 attachment rotate：Core Peer frame 已包含 channel、sequence、message 与 correlation identity，而当前 Core 不导出 pending exchange/sequence state；因此旧 channel 的 raw packet 既不能喂给 fresh Peer，也不能在没有 authoritative recovery proof 时静默删除。

target outbound packet 先经过 strict Core RPC canonical decode/re-encode 和 sidecar descriptor/length/SHA-256 验证；方向 allowlist 只接受 `executor.accepted|executor.settled|cancel.ack|snapshot.reply|events.page|control.request|model.request|events.request|protocol.error`，且在任何 sidecar ownership/hash 前拒绝错误方向或错误 inner channel。随后 Store 按完整 Core transport envelope 加按 `sidecarId` 排序的 descriptor 计算 packet receipt。该 receipt 故意保留 `channelId/sequence/messageId/correlationId`，不能复用 C7c-5b 会排除这些重试字段的 routed semantic receipt。Memory Store 同时维护 `messageId` 与 outbound Peer `sequence` 的 compact 索引；首包 sequence 必须从独立 target→controller 域的 `1` 开始，之后连续递增，而 HTTP delivery cursor 仍是另一个独立域。

- `enqueueOutbound()` 对同 message/sequence/receipt 返回首写 cursor，不重复增加 revision、bytes 或队列；任一索引异义、sequence gap、错 channel/generation 或容量耗尽都在写入前 fail closed。
- `pollOutbound()` 每次最多 offer 一个 packet。请求 `ackCursor` 只能等于当前已确认 cursor（重放同一 offer或取队首）或当前 offered cursor（原子确认并取下一项）；旧值、跳跃或未来值固定冲突。ACK 会从 delivery retained-byte 账本释放完整 canonical frame、descriptor 与 raw bytes，归零 Store-owned mutable sidecar bytes并丢弃其余重引用，但保留有界 compact receipt；响应丢失后的 enqueue/poll retry 不会重新投递已确认 packet。
- `waitForOutbound()` 以 delivery revision 为 advisory change token，在同一线性化区完成 revision recheck 与 waiter 注册；wake 后调用方仍须重新 poll。protocol wait、外部 `AbortSignal`/`deadlineAt`、dispose 和容量边界都会一次性清理 timer/listener/waiter。
- `HttpSubAgentJobStoreIoContext` 为非 dispose 的 Store I/O 提供 caller-local signal/deadline；它不持久化、不扩张 create request deadline，也不能把已经提交的 durable mutation伪装成未发生。`dispose()` 始终不可取消，Memory 实现会拒绝全部 waiter、清零 owned bytes并清空本地索引。

Memory delivery 默认上限分别为 10,000 个未 ACK packet、256 MiB delivery protocol-retained bytes、100,000 条 compact delivery receipt 与 1,000 个 waiter。四个上限独立计数；满时精确 replay、load、已有 offer/ACK 仍优先，新副作用固定 `capacity_exhausted`，不会 LRU/TTL/逐 job 删除。ACK 只释放未确认 packet count/bytes，不删除 compact replay evidence；所有计数通过 `diagnostics` 观察。

本批仍没有 production durable Store adapter、delivery response envelope/codec、HTTP listener/client、heartbeat、attachment/generation rotate、Peer pending/resequence import、approval/resume 或 external reconnect。完整 HTTP job lifecycle 与带 authoritative checkpoint/terminal/provider proof 的 attachment recovery 留给后续 C7c-5；当前 delivery Store 只证明单进程 loopback ledger 语义。

固定 hard cap：

| 资源                   |            上限 |
| ---------------------- | --------------: |
| 完整 multipart body    |         161 MiB |
| 第一 JSON part         | 32 MiB + 64 KiB |
| 单个 part header block |          16 KiB |
| boundary               |        70 bytes |
| Core RPC frame         |          16 MiB |
| sidecar 数量           |               8 |
| 单件 sidecar           |          32 MiB |
| sidecar 合计           |         128 MiB |
| JSON depth / nodes     | 128 / 1,000,000 |

`HttpSubAgentMultipartLimits` 只能收紧这些值，不能放宽。admission 会在验签或消费 replay receipt 前、没有请求副作用时预校验配置；配置和编程错误使 async 调用返回 rejected Promise，不会被伪装成安全 HTTP 请求失败。

## C7c-4 admission 基础组合

```ts
import { Buffer } from 'node:buffer';

import {
  MemoryHttpSubAgentReplayCache,
  admitHttpSubAgentPacket,
  createStaticHttpSubAgentHmacKeyResolver,
} from '@ruixutong.manee/maneeagent-executor-http';

const replayCache = new MemoryHttpSubAgentReplayCache({
  mode: 'loopback-test',
});

const keyResolver = createStaticHttpSubAgentHmacKeyResolver([
  {
    keyId: 'local-controller',
    principalId: 'controller-dev',
    key: Buffer.from(process.env.LOCAL_HTTP_HMAC_KEY!, 'base64url'),
  },
]);

const result = await admitHttpSubAgentPacket(rawRequest, {
  securityPolicy: { mode: 'loopback-test' },
  keyResolver,
  replayCache,
  resolveOwnerSessionId: ({ route, packet }) => lookupSignedOwnerScope(route, packet),
  authorize: async (authContext, scope) => policyAllows(authContext.principalId, scope),
  // 这里只记录已授权输入，不连接 Peer/Core。
  onPacket: async (context) => recordAuthorizedPacketForTest(context),
});
```

该示例只展示 C7c-4 的认证/授权 admission，并故意不调用 Peer/Core。当前 `admitHttpSubAgentPacket()` 尚未把 C7c-5b route policy 组合进 protocol-error 映射；不能把示例中的测试 sink 直接替换为 `peer.receive()`。后续 endpoint 层必须在 Peer/Core 副作用前调用 `decodeHttpSubAgentRoutedPacket()`，把 route-kind mismatch 投影为认证后的固定 400，再交付合法的 `routed.packet`。

`rawRequest.rawHeaders` 必须来自 Node `IncomingMessage.rawHeaders` 的 owned snapshot；body、header array 和 transport facts 应在第一次异步调用前固定。`resolveOwnerSessionId` 只能读取已经签名并严格 decode 的 packet、route 或后续 C7c-5 的受信 job state。`scope.method` 当前固定为 canonical HTTP `POST`，`routeId` 表示 endpoint 权限。

验证顺序固定为：配置预校验 → route/header/body bounds → body digest/HMAC → 原子 replay → 完整 multipart/strict RPC decode → owner scope → authorization → `onPacket`。`/v1/heartbeat` 不是第十五种 Core RPC，也不能调用 packet admission；它将在后续 HTTP endpoint 层单独组合 verifier、endpoint authorization 和 heartbeat handler。

状态分层：

- path、认证、replay 或 authorization denial：固定 401。
- 已认证后的 multipart、RPC 或 owner scope malformed：固定 400。
- key resolver、replay cache、owner resolver 或 authorizer backend 异常：固定 503。
- 已授权后的 `onPacket`/Core callback 异常：固定 500。

diagnostic 只包含固定 category、status 和不可逆 correlation digest；不包含 key、nonce、signature、raw header/body、owner/task ID、stack 或 callback error。correlation digest 绑定 canonical request、nonce 和收到的 signature，不用于跨 nonce 指纹聚类。

## Replay cache

`HttpSubAgentReplayCache.consume()` 必须对 `(keyId, nonce)` 做原子 consume。返回 `false` 表示 replay denial；throw 或返回非 boolean 表示 backend unavailable。

`MemoryHttpSubAgentReplayCache` 只能通过 `{ mode: 'loopback-test' }` 显式构造，供单进程测试和本地 loopback 使用。它有容量上限并 fail closed，但不是分布式 cache，不得用于多副本或 production handler。生产实现应使用共享、原子、带 TTL 的存储，并把 `mode` 声明为 `distributed`。

## 开发与验收

从仓库根目录运行：

```bash
pnpm --filter @ruixutong.manee/maneeagent-executor-http typecheck
pnpm --filter @ruixutong.manee/maneeagent-executor-http lint
pnpm --filter @ruixutong.manee/maneeagent-executor-http build
pnpm --filter @ruixutong.manee/maneeagent-executor-http test
pnpm acceptance:subagent:v2:http-security:offline
pnpm validate:subagent:v2:pack:http
```

其中 Vitest/acceptance 测试加载 network-deny guard；整组离线命令均不读取 API key、不访问真实 HTTP endpoint 或模型，也不产生费用。当前 acceptance 只证明 multipart/HMAC/replay/authz/admission、poll/route/receipt wire、create/replay Store，以及 current-attachment delivery/ACK/wait 的 L1/L2 基础；没有证明真实 listener、production durable Store、delivery response wire、attachment recovery、完整 job 生命周期、external reconnect、L5 方舟或 L6 Docker/Linux，因此 `C7-HTTP`、`C7-AUTH` 和 Phase 2 requirement 仍保持 `planned`。

## 公共 API

- route/常量：`parseHttpSubAgentRoute()`、`HTTP_SUBAGENT_*`
- multipart：`encodeHttpSubAgentMultipartPacket()`、`decodeHttpSubAgentMultipartPacket()` 与相关 types/limits
- poll：`encodeHttpSubAgentPollCommand()`、`decodeHttpSubAgentPollCommand()` 与相关 types/constants
- route/receipt：`decodeHttpSubAgentRoutedPacket()`、`createHttpSubAgentPacketSemanticReceipt()` 与相关 types
- job Store：`createHttpSubAgentJobCreateIdentity()`、`normalizeHttpSubAgentJobRecord()`、`normalizeHttpSubAgentJobDeliveryState()`、`HttpSubAgentJobStore`、`HttpSubAgentJobDeliveryStore`、`MemoryHttpSubAgentJobStore`、`HttpSubAgentJobStoreError` 与 create/delivery/IO context 相关 constants/types
- HMAC：`createHttpSubAgentHmacHeaders()`、`createHttpSubAgentHmacVerifier()`、`createStaticHttpSubAgentHmacKeyResolver()`、`HttpSubAgentSecurityError` 与 auth/replay contracts
- replay：`HttpSubAgentReplayCache`、`MemoryHttpSubAgentReplayCache`
- admission：`admitHttpSubAgentPacket()` 与 owner resolver、authorization、diagnostic/result contracts

内部 owned-body decoder、multipart config normalizer、MIME scanner、header parser、canonical string builder 和测试 failpoint 不属于包根公共 API。
