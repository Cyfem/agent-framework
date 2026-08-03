# Agent Skills 实施计划

## 1. 目标

在现有 Skill 手册能力上，按 [Agent Skills Specification](https://agentskills.io/specification) 实现通用、分层加载的 Skill 子系统：

- System Prompt 只暴露有效 Skill 的 `name` 和 `description`。
- 模型通过统一的 `skill` 工具按名称加载完整 instructions。
- 模型继续通过同一工具按需读取 references/assets 文本资源或运行 scripts。
- 直接结构体是跨运行时核心配置，同时支持 Node 环境从 Agent Skills portable text subset 目录或 `SKILL.md` 加载；不宣称兼容规范允许的任意宿主文件名和二进制 assets。
- 文件和进程能力在访问前完成 Node capability 与权限检查；只有 file capability 缺失时忽略 file source，process/temp capability 缺失只使对应 run unavailable，inline Skill 的 load/read 仍可用。
- 脚本默认禁止，显式启用后支持主流执行器自动检测和手工覆盖。
- Skill 沿用现有工具事件、raw/active context、Context Compact 和 standalone `toolCall()` 语义。

本次是旧 Skills API 的破坏性替换，不保留 `AgentSkillSop`、`systemContent`、`sops` 或 `get-skill(index)` 兼容层。完整数据结构、命令语法和错误语义以同目录 `technical-architecture.md` 为准。

## 2. 公共接口变更

新增并从 Agent 入口及包根入口导出：

- `SkillToolInput`：`{ skill: string; args?: string }`。
- `AgentSkillDescriptor`：严格只读 `name + description`，作为唯一 discovery 视图。
- `AgentSkillScript`：inline script 的 extension、content 和可选 description。
- `AgentSkill`：descriptor、source metadata（license、compatibility、metadata）、instructions、references、assets 和 scripts。
- `AgentSkillFileSource`：`{ source: 'file'; path: string }`。
- `AgentSkillSource`：inline Skill 与 file source 的联合类型。
- `SkillScriptExecutor`、`SkillScriptExecutorMap`、`SkillScriptRuntimeOptions`。
- `SkillRuntimeOptions`：result compact、scripts 和文本资源扩展名配置。
- `SkillScriptExecutionResult`：exitCode、signal、stdout 和 stderr。
- `DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS`：冻结的缺省文本扩展名。
- `detectSkillScriptExecutors()`：同步返回深度独立、可修改的 executor map；非 Node 返回空对象。

修改既有接口：

- `AgentOptions.skills` 改为 `readonly AgentSkillSource[]`。
- `AgentOptions` 新增 `skillRuntime?: SkillRuntimeOptions`。
- `Agent.addSkill(...sources)` 接受新 source；idle 时立即回到未初始化状态，running 时只标 dirty 并在当前 run finalization 后转为未初始化。
- 新增 `Agent.getSkillSourceDiagnostics()`，返回最近一次成功 init 的冻结、无 path、0-based source diagnostics；reason 固定为 `node_unavailable | file_capability_unavailable | read_permission_denied | source_access_denied`。
- `ToolDescriptionContext.skills` 改为只读 `AgentSkillDescriptor[]`，不能泄漏 source metadata、instructions、资源正文、脚本源码或本地路径。
- 删除 `AgentSkillSop` 和旧 `AgentSkill.systemContent/sops`。
- 删除 `get-skill`，新增固定名称 `skill` 工具；用户注册同名工具时继续由 `init()` 报重复工具名。
- 不实现 `allowed-tools`；文件 frontmatter 出现该字段时忽略，不修改 Agent 权限。

缺省配置固定为：

- `skillRuntime.compactResult` 默认 `false`。
- `skillRuntime.scripts` 省略或为 `false` 时禁止脚本执行。
- `scripts: {}` 不自动启用任何 executor。
- `autoDetect` 默认 `false`。
- `resourceExtensions` 省略时使用 `.md/.txt/.json/.yaml/.yml/.csv/.xml`；提供数组时整体替换，空数组表示不发现文本资源。
- resource/executor/script extension 统一使用单后缀 `/^\.[a-z0-9]+$/i`，并在 `init()` 归一化为小写。

## 3. 实施阶段

### 阶段一：建立迁移基线

- 增加 Skill 专项回归测试，先保护非 Skill 的 Agent 初始化、工具事件、tool result、standalone `toolCall()`、raw/active context 和 Context Compact 行为。
- 在 core 增加 `yaml` runtime dependency；Vite external 同步加入 `yaml`，并更新 lockfile。
- 搜索 core、两级 README 和全部 demo 中的 `get-skill`、`AgentSkillSop`、`systemContent`、`sops` 和 `{ index }` 调用。
- 记录当前 `pnpm test/typecheck/lint/format:check/build` 基线。
- 保持 `Agent.init(): this` 为同步 API，不把初始化链改为 Promise。

验收：非 Skill 行为有自动化保护；破坏性迁移范围和基线结果明确。

### 阶段二：公共类型、Registry 与 inline Skill

- 重定义 `AgentSkill` 并新增 source、descriptor、runtime、executor 和 result 类型。
- 新建 `SkillRegistry`，分离 configured sources 与最近一次成功构建的 effective snapshot。
- `init()` 先构建局部 candidate，所有 source/runtime/重名校验成功后一次替换 registry 并清除 dirty；失败不得留下半成品。
- inline Skill 校验：
  - name 长度 1–64，只允许小写字母、数字和单连字符，不能首尾为连字符或包含连续连字符；
  - description 非空且不超过 1,024 Unicode code points；
  - license 提供时是非空字符串，不额外增加规范之外的长度上限；
  - compatibility 提供时非空且不超过 500 Unicode code points；
  - metadata 是字符串到字符串的普通对象；
  - instructions 是字符串；
  - inline/script/runtime 结构及 references/assets/scripts 都是合法的非数组普通对象；file source 先识别 discriminator，path payload 仅在 file capability 存在时校验；未知字段忽略；
  - 逻辑 key 使用可移植相对名称：拒绝绝对路径、空 segment、`.`、`..`、反斜杠、控制字符、Windows 非法字符/保留名、NUL 和 segment 末尾空格/点；用逐目录 NFC + lowercase trie 拒绝大小写/规范等价 segment 和 file/directory 前缀冲突；
  - script extension 必须匹配单后缀规则并按小写后缀匹配；
  - 归一化后的 resource/script id 不得重复。
- 生成固定逻辑 id：
  - references key → `references/<key>`；
  - assets key → `assets/<key>`；
  - script key + extension → `scripts/<key><extension>`。
- Registry 对外只提供严格 `name + description` 的冻结 descriptor 副本；license/compatibility/metadata 仅保存在内部 source metadata，不进入任何模型请求。
- Skill 名称在 inline/file 间统一检查，任意重复都使 `init()` 失败，不做覆盖或 merge。
- Skill/discovery 保持 configured source 顺序；resources/scripts manifest 和最终 executor map 使用 JS `<`/`>` 的 UTF-16 code-unit 稳定排序，不依赖 `readdir`、locale 或 PATH 扫描返回顺序。

验收：纯 inline Skill 不依赖文件能力即可生成稳定 discovery catalog 和内容索引。

### 阶段三：实现 Skill 命令 DSL

- 新建无 Shell 语义的 lexer/parser，输出 load/read/run 内部 AST。
- 空白集合固定为 U+0009/U+000A/U+000D/U+0020；NBSP、U+2028 等作为普通字符。load 不应用全局 trailing-whitespace 消费，read/run 才丢弃 token 间和末尾 ASCII 空白。
- 语法固定为：
  - 省略、空字符串或全空白 args → `load`；
  - `load [raw arguments]` → 加载 instructions；
  - `read <resource-id>` → 读取已登记文本资源；
  - `run <script-id> [argv...]` → 运行已登记脚本。
- 只有首 token 为 `load/read/run` 才合法；其他首 token 返回 unknown-command 工具结果，不做隐式 load。
- `load` 后的 raw tail 原样保留，不经 token 重组：
  - command 与参数之间的分隔空白全部消费，之后的引号、反斜杠和末尾空白原样保留；
  - 替换 instructions 中全部字面量 `$ARGUMENTS`；
  - 使用 callback replacement，保证 `$&` 等字符不被当作 replacement pattern；
  - 没有占位符且参数非空时追加独立 `ARGUMENTS:` 区块。
- read/run lexer 支持完整 token 单引号、双引号和反斜杠转义下一个 Unicode code point；closing quote 后只能是 ASCII 空白或 EOF。只有这两个分支会产生未闭合 quote/悬空 escape 错误；load 的 raw tail 完全不进入 lexer。任何分支先拒绝 NUL，且都不处理变量、glob、管道、重定向、命令替换或控制运算符。
- discovery description 与 manifest script description 使用 JSON string literal 转义；load 结果使用固定 Markdown envelope，追加 resource/script id、执行可用性和 DSL 用法；空 section 固定写 `- none`，含空白 id 用双引号渲染并可被 lexer 无损还原。
- 未知 Skill、命令、ID、参数数量错误、脚本未启用或缺少 executor 返回 `{ ok: false, error: { code, message } }`；code 固定为 `skill_not_found | invalid_command | invalid_arguments | resource_not_found | script_not_found | script_execution_unavailable`。
- 错误优先级固定为 input NUL/invalid skill → skill lookup → command → read/run lexer/arity/id → resource/script lookup → script availability；未知 script 即使 scripts disabled 也先返回 `script_not_found`，load raw tail 不做 quote 校验。
- 正确性错误不抛异常；其 message 只回显已校验的 Skill 名/逻辑 id 和固定 usage，不回显原始 args 或本地路径。

验收：模型只能通过已登记 Skill 和逻辑 id 访问第二、三层内容；任何 DSL token 都不会变成 Shell command。

### 阶段四：实现文件型 Skill 适配器

- 将 file source 的兼容级别固定命名为 **Agent Skills portable text subset**：支持 Agent Skills `SKILL.md` 核心字段/body、配置扩展名的 UTF-8 references/assets 和单后缀 scripts，但不支持二进制资源、`allowed-tools` 行为或不满足 portable-id 的候选文件名。
- portable-id 明确拒绝空/点 segment、反斜杠、ASCII control/DEL、`<>:"|?*`、NUL、末尾空格/点和 Windows 保留 basename；例如 POSIX 合法的 `query?.md`、`a:b.md` 也不属于该 subset。完整物化路径继续拒绝 NFC/case collision 和 file/directory prefix collision。
- 新增共享 `skill-node-runtime.ts` capability provider；Skill 新模块不得顶层静态导入 `node:fs/path/os/child_process`，file adapter、script runtime 和 detector 都单向复用 provider。
- 通过 `globalThis.process` 和 `process.getBuiltinModule()` 获取同步最小能力：
  - `getBuiltinModule` 不存在时按 capability 缺失处理；Node 22.0–22.2 因此会忽略 file source 并禁用脚本，不提高现有 engines 下限；
  - 测试使用注入 capability，不修改真实全局对象。
- capability snapshot 拆成 file、process、temporary-files 三层：file source/load/read 只要求 file capability；file run 需要 file + process，inline run 需要 process + temporary-files，executor detection 只消费封装了 PATH executable 校验的 process capability。缺少 process capability 不能阻断 inline 或 file 的 load/read。
- permission API 明确拒绝 `child` 时 process capability 缺失，detector 返回空 map、run unavailable；明确拒绝 temp root 的 `fs.write` 时只禁用 inline run，不影响 file run。
- file source 的 path 可指向目录或其中的 `SKILL.md`：
  - path 必须是非空 string，不能全空白或含 NUL；
  - 相对路径在成功 `init()` 时相对当时 `process.cwd()` 解析并固定；
  - 文件入口 basename 必须是 `SKILL.md`；
  - Skill root 为其父目录。
- 在 source 初始化期间检查环境和读权限：
  - 非 Node、file capability 缺失、permission API 明确拒绝，或 root resolve、SKILL.md read、任一目录扫描步骤抛 `EACCES/EPERM/ERR_ACCESS_DENIED` 时，原子忽略整个 source，不保留部分 manifest；
  - `ENOENT`、错误类型、frontmatter 非法等属于配置错误。
- ignored file source 生成不含 path 的冻结 diagnostic candidate；不得为 diagnostics 读取 capability 缺失 source 的 path。成功 init 时 diagnostics 与 registry 原子替换，配置错误不生成 diagnostic，库不写 console/event。
- 使用 `yaml` 解析 frontmatter，只接收 name、description、license、compatibility 和 metadata；忽略 `allowed-tools` 与其他未知顶层字段。closing delimiter 行及紧随的一个 LF/CRLF 不进入正文；EOF delimiter 得到空正文，其后内容从第一个 UTF-16 code unit 起完全保真。
- `SKILL.md` 和 lazy text resource 使用 fatal UTF-8 decoder；允许 BOM，非法字节分别作为 init 配置错误或运行时 calling error。
- file Skill name 必须与 canonical real Skill root basename 一致；configured root 为 symlink 时不使用 symlink 名，并执行与 inline 相同的标准校验。
- 递归索引 `references/`、`assets/`、`scripts/`：
  - 三个 well-known 根缺失等价于空目录，普通目录递归；根本身为 symlink、普通文件或特殊文件属于配置错误；
  - 只登记普通文件；
  - 树内 symlink 和 socket/FIFO/device 忽略且不跟随；开始遍历后的 `ENOENT/ENOTDIR/ELOOP` 或类型变化属于配置错误；
  - realpath containment 使用 `path.relative()` 与 separator-aware 判定，禁止字符串前缀判断；
  - ordinary file 先按 suffix 分类：unsupported resource 与无后缀 script 立即忽略，只有候选项再做 portable-id/trie/realpath 校验；
  - resource 只登记调用方声明为文本的配置扩展名；discovery 不为判断 binary 预读正文；
  - 无后缀 script 和 `.env` 形式 dotfile 忽略；多后缀只取最后一段，其他 script 保留逻辑 id 大小写，并用小写后缀匹配 executor；
  - 对模型只暴露 `/` 分隔逻辑 id。
- instructions、descriptor 和 manifest 在 `init()` 快照；file resource 正文在 read 时以 UTF-8 延迟读取。
- `resourceExtensions` 每项匹配单后缀规则，规范化为小写并拒绝重复；它只过滤 file source，不过滤 inline string resource。allowed 文件在 lazy read 时做 fatal UTF-8 解码，非法字节走 calling error。
- 每次 lazy read/run 前重新 `lstat + realpath + regular-file/root-containment` 校验，降低 init 后 symlink 替换风险；不宣称这能消除所有宿主机 TOCTOU。
- init 成功后的 lazy permission error 不再忽略 source，抛出带脱敏 message 和原始 `cause` 的内部 wrapper，进入既有 calling error listener/result 流程。
- 新增、删除或重命名目录项需要重新 `init()`；已登记文件运行时失效走工具 calling error。

验收：满足 portable text subset 的目录和 SKILL.md 入口产生同一 resolved model；违反 portable-id 的候选文件稳定配置失败，unsupported resource/无后缀 script 在候选校验前忽略；环境降级不访问文件，真实 Node 配置错误不静默。

### 阶段五：实现脚本执行 Runtime

- 对 `skillRuntime`、`compactResult`、`resourceExtensions`、`scripts`、`autoDetect`、`executors` 和 executor member 做完整 runtime shape 校验；executor key/inline extension 使用单后缀规则，command/commandArgs 拒绝 NUL，command 只接受绝对路径或 PATH basename；非法类型在 `init()` 失败，不做 truthy/falsy 转换。

- `detectSkillScriptExecutors()` 与 `autoDetect: true` 使用固定候选：
  - `.js/.mjs/.cjs`：当前 Node executable；
  - `.ts/.mts/.cts/.tsx/.jsx`：tsx → Bun → Deno；
  - `.py`：python3 → python；
  - `.sh`：bash → sh；
  - `.ps1`：pwsh → powershell；
  - `.rb`：Ruby；
  - `.php`：PHP。
- JS 始终使用当前 Node；TS 不回退到 Node 的部分 TypeScript 支持。
- Deno 自动只使用 `commandArgs: ['run']`，不默认授予文件或网络权限；所需 Deno 权限由用户手工 executor 明确配置。
- PowerShell 自动使用 `commandArgs: ['-File']`。
- PATH resolver：
  - POSIX 接受具有执行权限的普通文件和 shebang executable；
  - Windows 只接受可由 `shell: false` 直接启动的 `.exe/.com`，拒绝 `.cmd/.bat` shim；
  - 因此 Windows 上 npm 提供的 `tsx.cmd` 不自动启用，随后尝试 Bun/Deno native executable。
- 手工 executors 在 auto 之后应用：entry 覆盖自动结果，`false` 删除。auto candidate 不存在/不可访问/不可执行时继续下一候选；process capability 存在时，手工 command 的同类问题使 `init()` 失败；process capability 缺失时只做配置 shape 校验，effective executor 固定为空，不访问 PATH。
- 执行固定使用：

  ```ts
  spawn(command, [...commandArgs, scriptPath, ...argv], {
    cwd: skillRoot,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ```

- 不开放 stdin，不设置默认 timeout、输出上限或沙箱；stdout/stderr 用独立增量 UTF-8 decoder 完整累积并在 close flush。
- file Skill 直接执行重新安全校验后的登记脚本，以 Skill root 为 cwd。
- inline Skill 每次 run 创建独立临时 Skill root：
  - 用 YAML serializer 按固定字段顺序物化 descriptor + source metadata + 原始 instructions 的 `SKILL.md`，metadata key 稳定排序，并写入全部 references/assets/scripts；
  - 目录逐级创建并区分“同一逻辑目录”与宿主 alias，文件使用 `wx`，额外的大小写/Unicode 碰撞只能失败、不能覆盖；
  - 以临时根为 cwd；
  - 成功、非零退出、signal 或异常都在 `finally` 清理；
  - cleanup 失败静默 best-effort，不新增 logger/event，也不覆盖已经取得的脚本结果。
- 正常退出、非零退出和 signal 都返回 `SkillScriptExecutionResult`；spawn/物化失败抛出并沿用现有工具 calling error。
- 底层文件/spawn 异常包装成脱敏 `SkillRuntimeError`；`onToolCallError` 收到 wrapper 并可通过 `cause` 诊断，模型 tool result 只看到 wrapper message。

验收：使用 Node executor 的 inline fixture 可相对读取自身资源；Deno auto 只表示可启动，所需 read/env/network 权限必须由 manual executor 显式配置。模型参数只作为 argv，不能通过 Shell 控制符改变 executable 或由 dispatcher 启动额外命令。

### 阶段六：垂直接入 Agent 与 Context Compact

- 用 Skill configured sources + Registry 替换 Agent 内部 `#skills` 数组。
- 构造函数只复制 source/config，不做文件或 PATH I/O。
- `init()` 增加 running guard：Agent 状态为 running 时立即抛错，且不得先修改初始化状态或 registry。
- `addSkill()` 追加 source 后设置 `#skillConfigurationDirty = true`：
  - idle/ended/failed 下同时设置 `#initialized = false`，后续 `agent()` 或 `toolCall()` 必须先重新 init；
  - running 中允许登记，但不能提前清空当前 run 的初始化通行状态；当前 run 始终使用既有 immutable registry snapshot，所有 finalization 路径离开 running 时再设置 `#initialized = false`，新 Skill 只有重新 init 后可见。
- 删除 `get-skill` method，新增 async `skill` 内置工具和固定 Zod schema。
- 新 system prompt 只列 effective `name + description` descriptor，并要求 load 后依据 manifest 再 read/run；不包含 source metadata、正文、资源 id、源码、路径或 executor。
- 动态工具 description 每轮只得到同一 `name + description` descriptor snapshot。
- `skill` 工具复用既有 parse/schema/before/handler/result/after/error 链；Model、Chat、Responses 和 ContextStore 不新增 Skill 协议分支。
- 为内部 `ToolExecutionRecord` 增加 `compactResult`：
  - 普通工具为 true；
  - 通过 init 时保存的实际内置 runtime definition 对象身份识别 Skill，不能只比较 call name；同名替换工具按普通工具处理；
  - 实际内置 skill 工具取 `skillRuntime.compactResult`，缺省 false，且 JSON/schema/before/handler error 与成功 record 使用同一值；
  - false 时 result 阶段不调用 default/custom compactor，也不生成 replacement；
  - input 仍服从全局 toolInput；
  - raw 始终完整，summary 仍可处理历史；
  - true 时完整复用现有 rewrite/CAS/rollback。
- standalone `toolCall()` 继续不自动执行 loop compact。

验收：首轮只见 `name + description`；load/read/run 结果按调用进入 context；同一 loop 的 Skill 与普通工具可分别决定 result compact。

### 阶段七：导出、文档与示例迁移

- 从 Agent 和包根入口导出新类型、constant 和 detector runtime value。
- 更新 public API 编译测试，检查生成 `.d.ts` 不把内部 Node capability 类型带入公共契约。
- 更新根 README 和 core README：
  - inline/file source；
  - 统一使用“Agent Skills portable text subset”，明确不承诺完整 Agent Skills 目录兼容；
  - 直接列出 UTF-8/text extension，以及空/点 segment、反斜杠、ASCII control/DEL、`<>:"|?*`、NUL、末尾空格/点、Windows 保留 basename、NFC/case/path-prefix collision；用 `query?.md`、`a:b.md` 说明 POSIX 合法文件名仍可能不属于 subset，并写明候选配置失败与 ignored-file 的判定优先级；
  - progressive disclosure 与严格 load/read/run DSL；
  - `$ARGUMENTS`；
  - Node capability/权限忽略规则；
  - resourceExtensions；
  - scripts 默认关闭、auto/manual executor；
  - addSkill snapshot/re-init；
  - compactResult；
  - 无沙箱、无 timeout、无输出上限、环境继承和 Windows shim 风险。
- 迁移所有 demo：
  - 中文或其他非法 Skill name 改为标准 slug；
  - `systemContent/sops` 合并为 instructions，必要内容拆为 references/assets/scripts；
  - `{ index }` 改为 `{ skill, args }`；
  - complex demo 的运行中热添加断言改为“当前 run 不可见，run 后 re-init 才可见”。
- Chat/Responses 继续使用离线 mock，不引入网络测试。
- 搜索清理发布源码、测试、README 和 demo 中所有旧 API 引用。

验收：消费者只阅读 README 和 `.d.ts` 即可配置 inline Skill、file Skill、文本资源和显式脚本运行。

## 4. 文件改动清单

| 模块                                              | 改动                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/core/src/agent/types.ts`                | 新 Skill source、descriptor、runtime、executor、输入与结果类型              |
| `packages/core/src/agent/skill-registry.ts`       | source 归一化、校验、catalog、查找和 dispatch                               |
| `packages/core/src/agent/skill-command.ts`        | load/read/run DSL lexer/parser 和参数渲染                                   |
| `packages/core/src/agent/skill-node-runtime.ts`   | 共享且可注入的 file/process capability provider                             |
| `packages/core/src/agent/skill-file-source.ts`    | SKILL.md、权限、目录发现和 lazy revalidation                                |
| `packages/core/src/agent/skill-script-runtime.ts` | executable 检测、合并、inline 物化、spawn 和 cleanup                        |
| `packages/core/src/agent/index.ts`                | Registry 生命周期、`skill` 工具、prompt、running guard 和 addSkill snapshot |
| `packages/core/src/agent/context-compact.ts`      | ToolExecutionRecord 增加 result compact eligibility                         |
| `packages/core/src/index.ts`                      | 导出新类型、constant 和 detector                                            |
| `packages/core/package.json`/lock/Vite            | 增加并 externalize `yaml`                                                   |
| `README.md`、`packages/core/README.md`            | 破坏性迁移、使用示例和安全说明                                              |
| `demo/src/main.ts`、`chat.ts`、`complex.ts`       | 迁移索引工具、旧结构和 addSkill snapshot 断言                               |
| `demo/src/windows.ts`、`windows-chat.ts`          | 迁移共享 Windows Skill 和提示词                                             |
| core tests                                        | DSL、Registry、file source、runtime、Agent 集成、compact 和 public API      |

最终文件名可以调整，但 Registry、command parser、Node provider、file adapter、script runtime 和 Agent orchestration 职责必须分离，不能把 fs/spawn 逻辑重新放回 Agent 主类。Decorators、LLM adapters、Model 和 ContextStore 不需要代码改动。

## 5. 测试计划

### 5.1 公共契约与配置

- 根入口导入全部新类型、constant 和 detector。
- `.d.ts` 不要求消费者引用 Node 类型。
- 默认文本扩展常量与 effective descriptor array/object 冻结，detector 每次返回独立可修改对象。
- source diagnostics 数组/成员冻结、0-based 顺序、reason 映射、成功 init 原子替换、失败保留旧 snapshot，以及 capability 缺失时不访问 path getter。
- name/description discovery 与 license/compatibility/metadata source metadata 校验。
- inline/file/runtime 普通对象 shape，Node file capability 下的 path、resource/script key、单后缀 extension、command/argv NUL、归一化冲突和 traversal。
- Agent、file/inline、同批 source 的 Skill 重名。
- `addSkill()` 后拒绝下一次运行，re-init 后恢复。
- running 中 addSkill 不改变当前 snapshot；running 中 init 被拒绝。
- re-init 失败不提交部分 registry。
- 用户工具名 `skill` 与内置工具冲突。
- 旧 `get-skill` 和旧 Skill 类型完全移除。

### 5.2 Progressive disclosure 与 DSL

- System Prompt 和动态 ToolDescriptionContext 只包含 `name + description` descriptor。
- instructions、resource/script 内容、file path 和 executable 不在首轮出现。
- configured Skill 顺序、UTF-16 manifest/executor 排序、description JSON escaping。
- 无 Skill 时提示模型不要调用 `skill`。
- omitted/empty/load、ASCII-only 分隔、NBSP/U+2028、raw 尾部空白/quotes/backslashes、`$ARGUMENTS` 替换和无占位符追加。
- 固定 load Markdown envelope、空 section、resource/script id、description 和 availability。
- read/run 的 Unicode、单双引号、反斜杠和空参数。
- 管道、重定向、glob、分号、`$()` 和反引号只作为 argv。
- unknown command 不做 implicit load，所有分支拒绝 NUL。
- 未知 Skill、resource、script、disabled/missing executor 的固定 error code/envelope，且不泄漏 path/executable/raw args。

### 5.3 Inline 与 file source

- inline instructions/references/assets/scripts id。
- NFC/case、父目录 alias、file/directory prefix collision 拒绝，fake case-insensitive fs 下只失败不覆盖，以及生成 SKILL.md 的字段顺序、YAML quoting 和原始 instructions 保真。
- 非 Node inline load/read。
- 目录与 SKILL.md 两种 file 入口。
- 相对路径按 init cwd 固定。
- frontmatter 必填字段、长度、metadata、未知字段和 ignored allowed-tools。
- closing delimiter LF/CRLF/EOF 正文起点与 inline/file round-trip 保真。
- file name 与目录名不一致。
- recursive discovery、text extension replacement、空列表、portable logical id 和 allowed extension 的 lazy 非 UTF-8 错误。
- unsupported/no-suffix 先忽略、候选项再做 portable-id/trie 校验的优先级。
- instructions/manifest 快照、resource lazy read。
- 新目录项 re-init 前不可见，已登记项删除时报运行错误。
- symlink、separator-aware realpath containment、canonical root basename、init 后替换的重新校验和 TOCTOU 边界说明。
- 非 Node、分层 capability 缺失、`fs.read/fs.write/child` permission deny，以及初始化任一步 EACCES/EPERM/ERR_ACCESS_DENIED 原子忽略且不产生部分 manifest；file capability 缺失用抛错 path getter 证明配置未被读取。
- ENOENT、非法 YAML、错误文件类型在 init 失败。
- well-known 根与树内普通目录/普通文件/symlink/socket/FIFO/device 的完整类型矩阵，以及扫描中 ENOTDIR/ELOOP/类型变化。

### 5.4 Executor 与脚本

- fake PATH/PATHEXT 验证候选优先级，不依赖 CI 安装 Python/Bun 等环境。
- Node、tsx/Bun/Deno、Python、Shell、PowerShell、Ruby、PHP。
- Deno auto 仅 `run`、availability 不保证权限，以及 PowerShell commandArgs。
- Windows `.cmd/.bat` 拒绝与 native executable fallback。
- auto + manual 覆盖、`false` 删除、command 不存在。
- auto/manual resolver 遇到 EACCES/EPERM/ERR_ACCESS_DENIED 时分别跳过候选/配置失败。
- scripts 缺省关闭、空配置、auto-only、manual-only。
- 使用当前 Node 执行 `.js` fixture。
- executable/commandArgs/script/argv 顺序、cwd、环境继承和 stdin 关闭。
- shell 注入字符不会启动第二进程。
- stdout/stderr/exitCode/signal 结构、跨 chunk UTF-8 与非法字节 replacement；signal 使用 fake child-process emitter，不依赖真实 OS signal。
- 非零退出不触发工具错误，spawn/物化失败触发 calling error。
- inline 临时目录包含完整布局，并在所有结束路径清理。
- file script 不复制或修改源目录。

### 5.5 Agent、协议与 Context Compact

- Chat/Responses 的 `skill` schema、call、result 和后续请求。
- load → read、load → run 多轮离线流程。
- before/handler/result/after 事件顺序。
- handler error、standalone `toolCall()` 和 raw/active。
- `compactResult` 默认 false 时 default/custom result compactor 均不收到 Skill result。
- `compactResult: true` 时参与现有 rewrite、callback failure 和 CAS rollback。
- 同一 loop 混合 Skill/普通工具时逐 record 生效。
- actual runtime definition identity、同名替换工具，以及 Skill schema/before/handler error record eligibility。
- tool input compact 不受影响，summary 可摘要此前 Skill result。
- pending end、listener settle、ContextStore、recovery 和非 Skill compact 回归。
- 子代理不继承父 Agent skills/runtime。

### 5.6 文档与 demo

- 全部 demo typecheck/build。
- Chat/Responses 示例离线运行。
- 搜索确认发布源码和文档不存在旧 API。
- README 统一使用“Agent Skills portable text subset”且不出现完整目录兼容承诺；明确文本扩展名与 lazy UTF-8 校验，并逐项列出空/点 segment、反斜杠、ASCII control/DEL、`<>:"|?*`、NUL、末尾空格/点、Windows 保留 basename、NFC/case/path-prefix collision，以及 POSIX-only 示例和 ignored-file 优先级。
- README 明确受信任脚本、Deno 权限例外、无框架沙箱/timeout/output limit 和环境继承风险。

### 5.7 测试落点与跨平台策略

- 修改 `public-api.test.ts`、`agent-regression.test.ts`、`tool-payload-compact.test.ts`。
- 新增 `skill-command.test.ts`、`skill-registry.test.ts`、`skill-file-source.test.ts`、`skill-script-runtime.test.ts`、`skill-agent-integration.test.ts`。
- PATH/PATHEXT、Windows shim、permission、EACCES、symlink/realpath 和 child-process event 使用注入 capability/fake；真实 symlink/fs 用例按平台条件运行，Windows CI 不要求 symlink privilege。

## 6. 完成标准

依次执行：

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm --filter ./packages/core build
pnpm --filter @manee/agent-framework-demo typecheck
pnpm --filter @manee/agent-framework-demo build
pnpm build
git diff --check
```

并满足：

- inline Skill 在无 Node 文件能力时可完成 discovery、load 和 read。
- file source 在 Node file capability 可读环境加载，file capability 缺失或 source read 权限拒绝时忽略；process/temp 权限只影响对应 run availability。
- 只有满足 Agent Skills portable text subset 的 file source 才要求成功加载；README/TSDoc 不使用“完整 Agent Skills 目录兼容”措辞。候选路径的空/点 segment、反斜杠、ASCII control/DEL、`<>:"|?*`、NUL、末尾空格/点、Windows 保留 basename、NFC/case alias 和 file/directory prefix collision 均稳定失败，POSIX-only 的 `query?.md`、`a:b.md` 也不例外；unsupported resource/无后缀 script 继续先行忽略。
- 首轮模型请求不包含 Skill 正文、资源、源码或路径。
- load/read/run 只能选择 Registry 已登记的逻辑 id。
- 脚本参数从不经过 Shell。
- file/inline run 返回统一结构化结果。
- Skill result 默认不 compact，显式开启后才进入全局 result compactor。
- 旧 Skills API 从类型、运行时、文档和 demo 中完整移除。

## 7. 明确边界

- 不自动发现 `.claude/skills`、`.codex/skills`、项目父目录或用户主目录；只处理显式 sources。
- 不实现远程、URL、压缩包、Git 或 MCP Skill source。
- 不实现 `allowed-tools`、审批或动态工具授权。
- 不提供二进制 asset 的读取或 provider 多模态封装；file source 仅兼容 Agent Skills portable text subset。候选路径拒绝空/点 segment、反斜杠、ASCII control/DEL、`<>:"|?*`、NUL、末尾空格/点、Windows 保留 basename、NFC/case collision 和 file/directory prefix collision；这比 Agent Skills 规范允许的宿主文件名更严格。
- 不提供脚本沙箱、默认 timeout、输出上限、资源配额、stdin、流式输出或进程取消。
- 同步 file discovery 不设置默认递归深度或文件数上限，超大 Skill 目录可能阻塞 `init()`；resource 正文仍 lazy read。
- 不安装脚本语言、第三方依赖或 Skill 声明的系统依赖。
- spawn 接收宿主环境且框架不提供沙箱；脚本被视为宿主显式配置的受信任代码。Deno auto 是已记录例外：bare `deno run` 仍执行其原生权限检查，需 manual executor 才能追加授权。
- lazy read/run 的重复路径校验降低但不能完全消除宿主机 TOCTOU。
- file instructions/manifest 只有 re-init 刷新；已登记资源正文和脚本使用调用时内容。
- file source 忽略只适用于非 Node、capability 缺失或明确权限拒绝；坏路径和坏 Skill 报配置错误。
- Node 22.0–22.2 因缺少 `process.getBuiltinModule()` 会安全降级，不承诺 file/script 能力。
- 当前 npm 包总体仍是 Node 构建；本功能的门控不等于完整浏览器兼容。
- 父 Agent 的 Skill 和 runtime 配置不传播给动态子代理。
- Skill result 只跳过 payload compact，不跳过后续 summary compact；raw history 不裁剪。
- read/script result 不设大小上限，会完整占用内存与 raw history，缺省还会保留在 active context。
- 不执行版本发布、提交、推送或包名迁移。
