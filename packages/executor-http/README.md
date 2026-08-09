# `@ruixutong.manee/maneeagent-executor-http`

Manee Agent Framework 的 HTTP Subagent wire-security 基础包。当前 `2.0.0` checkout 提供严格的单包 `multipart/mixed` 编解码、HMAC-SHA256 v1 验签、原子 replay cache SPI、owner scope 授权顺序和脱敏 admission 结果。

> **当前范围与发布状态**：该包尚未发布到 npm，也还不是可运行的 HTTP Executor。它不包含 HTTP listener/client、job store、heartbeat handler、event cursor、approval resume、external reconnect 或 Remote `SubAgentExecutor`。这些能力属于后续 C7c-5；因此当前 Phase 2 仍未通过。`npm pack` 成功不等于已经发布。

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

## 组合 admission

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
  onPacket: async ({ packet, ownerSessionId }) => peerFor(ownerSessionId).receive(packet),
});
```

`rawRequest.rawHeaders` 必须来自 Node `IncomingMessage.rawHeaders` 的 owned snapshot；body、header array 和 transport facts 应在第一次异步调用前固定。`resolveOwnerSessionId` 只能读取已经签名并严格 decode 的 packet、route 或后续 C7c-5 的受信 job state。`scope.method` 当前固定为 canonical HTTP `POST`，`routeId` 表示 endpoint 权限；C7c-5 还必须用 closed route policy 约束 route 与 Core RPC kind 的对应关系。

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

其中 Vitest/acceptance 测试加载 network-deny guard；整组离线命令均不读取 API key、不访问真实 HTTP endpoint 或模型，也不产生费用。当前 acceptance 只证明 multipart/HMAC/replay/authz/admission 的 L1/L2 安全基础；没有证明真实 listener、job 生命周期、external reconnect、L5 方舟或 L6 Docker/Linux，因此 `C7-HTTP`、`C7-AUTH` 和 Phase 2 requirement 仍保持 `planned`。

## 公共 API

- route/常量：`parseHttpSubAgentRoute()`、`HTTP_SUBAGENT_*`
- multipart：`encodeHttpSubAgentMultipartPacket()`、`decodeHttpSubAgentMultipartPacket()` 与相关 types/limits
- HMAC：`createHttpSubAgentHmacHeaders()`、`createHttpSubAgentHmacVerifier()`、`createStaticHttpSubAgentHmacKeyResolver()`、`HttpSubAgentSecurityError` 与 auth/replay contracts
- replay：`HttpSubAgentReplayCache`、`MemoryHttpSubAgentReplayCache`
- admission：`admitHttpSubAgentPacket()` 与 owner resolver、authorization、diagnostic/result contracts

内部 owned-body decoder、multipart config normalizer、MIME scanner、header parser、canonical string builder 和测试 failpoint 不属于包根公共 API。
