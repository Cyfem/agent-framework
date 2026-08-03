# Context Compact 实施计划

## 1. 目标

在保持未配置 compact 的成功路径兼容，并明确升级模型异常路径的前提下，为 Agent 框架增加：

- loop 结束后的 `tool_input/tool_result` 字符串压缩，包含框架缺省规则、自定义覆盖和逐类关闭；
- 请求前主动摘要和 context-length 错误后的摘要恢复；
- raw history 与 active context 的稳定双轨存储；
- Model 错误分类、内置 handler、before/after 控制 hooks 和重试状态机；
- Chat 与 Responses 两套协议的不可变 payload 改写。

详细设计以同目录的 `technical-architecture.md` 为准。

## 2. 公共接口变更

- `AgentOptions<P>` 新增：
  - `contextCompact?: ContextCompactOptions<P>`；
  - `modelErrorRecovery?: ModelErrorRecoveryOptions`。
- 新增 `ToolPayloadCompactConfig`、`DefaultToolPayloadCompactOptions`、冻结的 `ToolPayloadCompactCallSnapshot`、工具 payload compactor、缺省长度常量，以及摘要 trigger/select/prompt/validate 及其 snapshot 类型。
- 工具配置采用三态语义：`contextCompact` 存在且单项缺省时使用内置规则，callback 完全覆盖，`false` 关闭；整体未配置时保持关闭。
- 新增 `ModelErrorDescriptor`、错误种类、重试 ledger、before/after hook 事件和决策类型。
- Agent 新增：
  - `onBeforeModelErrorRecovery()`；
  - `onAfterModelErrorRecovery()`。
- `ModelGenerateRequest` 新增可选 `purpose`。
- `Model<P>` 新增带默认实现的：
  - `rewriteToolPayloads()`；
  - `extractAssistantText()`；
  - `classifyError()`。
- 所有新公共类型从包根入口导出。

## 3. 实施阶段

### 阶段一：建立正式测试基线

- 引入 Vitest 并复用现有 Vite/decorator 配置。
- 增加 workspace 和 core 的 `test` script。
- 将当前关键离线 demo 行为提炼为基础回归测试：
  - Responses 原样透传；
  - Chat 单 assistant 多工具；
  - tool error 结果写入；
  - raw/context 初始化与浅拷贝；
  - maxIterations、空消息重试、并发 agent 保护。
- 记录变更前 `typecheck`、`lint`、`build`、回归测试结果。

验收：未增加 compact 代码前已有行为全部有自动化保护。

### 阶段二：引入 ContextStore

- 新建内部 `ContextStore<P>`，实现 raw append-only、active entries、spans、summary boundary 和 revision。
- 将构造时的 `initContext/initRawContext` 迁移为 opaque seed span。
- 将 `getHistory()`、`getContext()`、`appendContext()` 和动态工具描述上下文改为通过 ContextStore 读取。
- 支持 user、external、loop、summary、preserved span。
- preserved provenance 同时支持完整同序 span 复用和 entry-level 原文映射；部分选择不能误带入整个原 span。
- 为 open loop 增加 `snapshotOpenLoop()`、revision CAS commit 和 `abortOpenLoopSpan()`；失败后不得把 span 留给下一次 Agent 调用。
- 主模型成功后先打开 loop span，再触发 `onModelResponse`，保持“模型消息写入前触发”的现有顺序；随后将模型输出、工具结果和 awaited listener 追加归入同一 span。
- 暂不启用任何压缩，确认 flatten 后请求结构与当前版本一致。

验收：未配置 compact 时，成功请求、历史、事件顺序和返回值不发生变化；错误恢复行为留待阶段五按新默认值更新。

### 阶段三：实现工具 payload compact

- 将内部工具执行重构为可产生 `ToolExecutionRecord<P>`，保持公开 `toolCall()` 返回类型不变。
- 实现纯函数缺省 compactor：input 默认超过 8,192 压到 4,096，result 默认超过 16,384 压到 8,192；长度使用 UTF-16 code unit，支持配置校验和 surrogate-safe 裁剪。
- 对不超过 1,048,576 个 UTF-16 code units 的合法 JSON 进行有界结构裁剪；候选仍过长时生成 JSON preview envelope，非 JSON result 使用纯文本头尾 preview，并严格保证 target 上限。
- 在 `init()` 时把 input/result 分别解析为 default/custom/disabled effective compactor；callback 返回 `undefined` 时不 fallback 到缺省策略。
- compactor 只接收冻结的 id/name/arguments 值快照，不暴露内部 `sourceMessage/sourceCall`；真实定位引用只留在 execution record。
- 在每轮全部工具执行结束后，按 call 顺序对每条 record 先 input 后 result 串行执行 effective compactor。
- listener settle 后捕获 open span id/revision；收集 replacements 后一次调用 `Model.rewriteToolPayloads()`，再通过 CAS 只替换并关闭当前 loop span active projection。
- 在 Model 基类实现兼容默认行为。
- 在 Chat adapter 实现共享 assistant message 的分组 clone 和批量改写。
- 在 Responses adapter 实现独立 call/output item clone。
- Model adapter 严格校验每个 replacement 精确命中一次；Agent 严格校验返回类型、数组长度、目标索引、非目标引用等协议无关结构约束。
- 将 `end-agent` 改为 pending end：handler 只请求结束，terminating result、listener settle 和 tool compact 成功后再提交 ended；失败则进入 failed。
- 仅在 input/result 至少一个 effective compactor 启用时收集本轮非阻塞 before/after listener promises，在不阻塞后续工具的前提下，于 compact 前等待 settle；两类都关闭时保持原 fire-and-forget 时序。
- 没有 tool record 或两类 compactor 都关闭时同步关闭 loop span，跳过 `await`、snapshot、rewrite 和 CAS，不能引入额外微任务竞争窗口。
- 用 `try/finally` 保证 callback、adapter、校验或 CAS 失败时执行 `abortOpenLoopSpan()`，保留原始 active/raw、关闭 span并清理 pending end/records。

验收：`contextCompact: {}` 无需 callback 即可压缩长 payload；工具执行始终使用原文；下一轮请求使用压缩值；raw history 逐字保真；callback 与 `false` 的优先级符合契约。

### 阶段四：实现主动摘要事务

- 增加 `ModelGenerateRequest.purpose` 和 `Model.extractAssistantText()`。
- 实现 summary snapshot：active、boundary original/active、raw history、previous summary、pending request。
- 实现默认选择：主动摘要旧 spans，保留最近完整 span。
- 支持外部 selector 返回任意 `contextToSummarize/preservedContext`。
- 使用当前 Model、内部 guard、外部 prompt 和 `tools=[]` 发起 summary 请求。
- 摘要响应不触发既有 `onModelResponse`，不写入 raw history；错误通过带 summary purpose 的 recovery hooks 暴露。
- 完成工具调用拒绝、文本提取、非空校验和可选 validate。
- 使用 user-role memory wrapper 构造 summary message。
- 通过 revision CAS 原子提交 active context，raw history 不写摘要产物。
- 每次主模型请求前运行 trigger；摘要后只重建请求，不重复 trigger。

验收：首次请求可摘要 init history；后续摘要可滚动合并 previous summary；完整原始工具载荷对 selector/prompt 可见。

### 阶段五：实现模型错误恢复

- 在 Model 基类增加 `classifyError()` 默认实现。
- 提取 OpenAI-compatible 共享错误 classifier，接入 Chat/Responses。
- 新建 recovery coordinator、内置 handler registry、retry ledger 和 recovery error。
- 实现默认配置：普通未处理错误额外重试 3 次，context handler 执行 2 次。
- 增加 before/after 控制 hooks及其完整事件信息。
- 按注册顺序 await，并采用最后一个非 default 决策。
- 实现 `default/retry/continue/stop` 决策表。
- 所有重试使用迭代式循环并重建 request，不增加 Agent iteration。
- 不给 forced retry 设置硬上限，但记录全部计数与 trace。
- 保持空消息重试为独立路径。

验收：错误分类、handler、hooks、普通重试和强制重试严格符合状态机。

### 阶段六：接入 context-length handler

- 注册首个内置 handler：`core.context_compaction`。
- 主模型发生 `context_length_exceeded` 时，绕过主动 trigger，直接执行带 error cause 的 summary transaction。
- 未提供外部 selector 时摘要全部 boundary，保留为空。
- handler 成功后由 recovery coordinator 在 after hook 完成后重试当前逻辑请求。
- 达到默认 2 次后 proposed action 为 stop；hook 可越过。
- summary generate 禁用递归 context compact handler，其他错误走普通 3 次策略。
- 没有 summary policy 时把 context-length 错误作为未处理错误。

验收：context-length 错误能原子摘要并恢复；summary 自身错误不会递归摘要。

### 阶段七：导出、文档和示例

- 补齐 Agent、LLM 和包根入口导出。
- 为所有公共类型和方法增加中文 TSDoc。
- 更新 README：
  - `contextCompact: {}` 缺省压缩、长度覆盖、自定义 callback 和 `false` 关闭示例；
  - 缺省 JSON envelope/text marker 的稳定格式、1,048,576 code-unit 探测上限和非语义保证；
  - tool compact 启用后 `{ await: false }` 仍会在 loop finalization 被等待及永久 pending 风险；
  - trigger/select/prompt/validate 示例；
  - `getHistory/getContext` 双轨说明；
  - 自定义 Model 的 rewrite/classify 能力；
  - before/after hook 决策表；
  - forced retry 无限请求风险。
- 增加 Responses 与 Chat 的离线 compact 示例。

验收：发布后的 `.d.ts` 包含完整接口说明，示例可离线运行。

## 4. 文件改动清单

| 模块                                      | 改动                                                               |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `agent/types.ts`                          | Compact、summary、错误恢复、hooks、replacement 类型及 AgentOptions |
| `agent/context-store.ts`                  | 新增 raw/active/span/boundary/revision store                       |
| `agent/context-compact.ts`                | 新增工具压缩和摘要事务                                             |
| `agent/default-tool-payload-compactor.ts` | 新增缺省阈值、JSON 结构裁剪和 preview fallback                     |
| `agent/model-error-recovery.ts`           | 新增错误 handler、hooks 聚合与 retry coordinator                   |
| `agent/index.ts`                          | 主循环、tool records、ContextStore、preflight/recovery 接入        |
| `llm/base/types.ts`                       | request purpose 与错误分类上下文                                   |
| `llm/base/index.ts`                       | rewrite、文本提取、错误分类默认能力                                |
| `llm/openai-error.ts`                     | 新增 OpenAI-compatible classifier                                  |
| `llm/chat/index.ts`                       | Chat payload rewrite 与分类接入                                    |
| `llm/responses/index.ts`                  | Responses payload rewrite 与分类接入                               |
| 包入口与 README                           | 新 API 导出、语义、示例和风险文档                                  |
| 测试配置与测试文件                        | Vitest、协议矩阵、状态机与兼容测试                                 |

## 5. 测试计划

### 5.1 双轨与原子性

- raw history 保留原始嵌套对象和长 payload。
- active context 仅包含 compact 副本。
- summary prompt/response/memory 不进入 raw history。
- callback、validator、adapter 或 revision 失败时 active 不提交。
- tool compact 的 revision 冲突不会覆盖并发追加，失败后的 open span 已关闭且下一次 `agent()` 可安全启动。
- `initContext/initRawContext` 长度不同仍可作为 seed 恢复。
- 完整 span 与部分/重排 preserved entry 的 original provenance 都不扩大选择范围。

### 5.2 协议矩阵

- 配置解析：`contextCompact` 缺失时关闭、`{}` 时两类缺省启用、`false` 逐类关闭、全关闭对象 inert、callback 覆盖且 `undefined` 不 fallback。
- 缺省边界：threshold 等于/加一、非法 runtime shape、自定义参数校验、冻结常量不可篡改、input/result 不同默认值、输出幂等。
- JSON 缺省算法：object/array/scalar、深度/数组/key 上限、marker key 冲突、特殊 key 原型污染防护、非安全数字和 1,048,576 code-unit 探测上限。
- Fallback：非法/空白/超大 input 的合法 JSON envelope，非 JSON result 的头尾文本，escape-heavy 内容的目标长度和 Unicode surrogate 完整性。
- Chat：一个 assistant 两个 function calls，分别压缩和同时压缩。
- Chat：custom call、audio、annotations、refusal、name 保真。
- Responses：reasoning、多个 call/output、status/id/namespace/created_by 保真。
- 工具所有错误路径、内容数组解析和 terminating tool result。
- default input 成功、后续 custom result 失败时整批 rollback。
- custom callback 期间并发 `appendContext()` 导致 CAS conflict；adapter 零命中/重复命中和 abort 后复用 Agent。
- 无 records 与全 disabled 分支同步 close，不因 fire-and-forget listener 引入 CAS 或额外等待。
- deferred `{ await: false }` listener 在 tool compact 启用/全关闭时分别验证 finalization 等待/不等待，不使用永久 pending 测试。

### 5.3 Summary

- trigger true/false、异步 trigger/prompt/select/validate。
- 默认 boundary 和自定义任意 context。
- previous summary 滚动合并。
- 首次请求和 context-error emergency 模式。
- 空文本、tool call、reasoning-only、refusal-only、validator 拒绝。
- summary 并发 mutation 与 summary generate 错误。

### 5.4 Error recovery

- OpenAI error code/type/message 分类优先级。
- 未处理错误默认额外 3 次。
- context handler 默认 2 次。
- before/after 最后非 default 聚合。
- retry、continue、stop 对 handler 和下一请求的影响。
- forced retry 超过默认额度后的计数。
- summary purpose 防递归。
- 最终 `ModelErrorRecoveryError` 和一次 `onAgentError`。

### 5.5 回归

- 未配置 compact 时所有现有成功路径 demo 行为不变；模型异常默认额外重试 3 次是有意变化，设置 `unhandledRetryLimit: 0` 可恢复旧行为。
- `{ summary }` 会同时启用 input/result 缺省规则；summary-only 配置显式传入两个 `false`。
- 自定义 Model 未覆盖新方法时仍可编译；仅在实际需要非空 rewrite 时抛 capability error。
- maxIterations、并发保护、动态工具描述、skills、sub-agent、模型响应/工具事件顺序和空消息重试保持现状；ended status event 有意延后到 terminating result 与 compact 成功之后。

## 6. 完成标准

- `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全部通过。
- Chat 和 Responses 离线测试均验证 raw/active 分离和 provider metadata 保真。
- context-length 恢复和所有 hook 决策路径有确定性测试。
- 未配置 compact 的成功请求快照与变更前一致；错误路径按新 recovery 快照验收。
- `contextCompact: {}` 对超过缺省阈值的 input/result 产生不超过目标长度的 replacement，无需外部 callback。
- README 和生成的类型声明足以让接入方不阅读内部源码即可实现自定义压缩策略。

## 7. 明确假设

- compact 仅作用于 Agent loop；standalone `toolCall()` 不自动压缩。
- `contextCompact` 整体未配置时缺省工具压缩也不启用；对象一旦存在，未显式配置的 input/result 使用框架缺省策略。
- 缺省策略保证 replacement 长度；JSON 候选和 envelope 保证 JSON 语法，但不保证原工具 schema、业务语义摘要或敏感信息脱敏。
- 父 Agent 的 compact 和错误 hooks 不自动传给动态子代理。
- 自定义 selector 的任意 context 由接入方保证协议合法。
- raw history 保留全部原文并持续增长。
- 所有 compact 相关控制回调默认 fail-closed。
- forced retry/continue 没有硬上限，可能造成无限模型请求。
