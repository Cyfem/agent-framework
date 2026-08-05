import type { Model } from '../llm/base';
import type {
  ModelGeneratePurpose,
  ModelGenerateRequest,
  ModelGenerateResult,
} from '../llm/base/types';

/** 同步或异步扩展点的统一返回类型。 */
export type MaybePromise<T> = T | Promise<T>;

/** Agent 的生命周期状态。 */
export type AgentStatus = 'idle' | 'running' | 'ended' | 'failed';

/** 触发工具调用错误事件的处理阶段。 */
export type ToolCallErrorTrigger = 'before' | 'calling' | 'after';

/** 事件注册方法返回的取消监听函数。 */
export type Unsubscribe = () => void;

/** 工具参数转换后使用的 JSON 对象结构。 */
export type JsonObject = Record<string, unknown>;

/** 框架工具所需的最小 schema 契约，Zod object schema 可直接满足该契约。 */
export interface ToolParametersSchema {
  safeParse(data: unknown):
    | {
        success: true;
        data: unknown;
      }
    | {
        success: false;
        error: unknown;
      };
}

/**
 * 一个模型协议需要关联的消息、工具和原始返回类型。
 *
 * Agent 仅通过这些关联类型保存和拼装上下文；具体 wire structure 由 `Model`
 * 的 builder/parser 处理。
 */
export interface AgentProtocol {
  /** Agent 持久保存并传回 Model 的协议上下文项。 */
  context: unknown;
  /** Model API 接收的工具声明结构。 */
  tool: unknown;
  /** 应用可交给 `buildUserMessage()` 的协议用户消息结构。 */
  userMessage: unknown;
  /** 应用可交给 `buildSystemMessage()` 的协议系统消息结构。 */
  systemMessage: unknown;
  /** `parseAssistantMessages()` 返回的协议 assistant 抽象结构。 */
  assistantMessage: unknown;
  /** 应用可交给 `buildToolCallOutputMessage()` 的协议工具结果结构。 */
  toolCallOutputMessage: unknown;
  /** 单个原始工具调用项，用于保真保存 `sourceCall`。 */
  rawToolCall: unknown;
  /** Model SDK 返回的完整原始响应对象。 */
  rawResponse: unknown;
}

/** 从协议规格中取出上下文项类型。 */
export type ContextOf<P extends AgentProtocol> = P['context'];
/** 从协议规格中取出工具声明类型。 */
export type ToolOf<P extends AgentProtocol> = P['tool'];
/** 从协议规格中取出用户消息 builder 输入类型。 */
export type UserMessageOf<P extends AgentProtocol> = P['userMessage'];
/** 从协议规格中取出系统消息 builder 输入类型。 */
export type SystemMessageOf<P extends AgentProtocol> = P['systemMessage'];
/** 从协议规格中取出 assistant parser 输出类型。 */
export type AssistantMessageOf<P extends AgentProtocol> = P['assistantMessage'];
/** 从协议规格中取出工具结果 builder 输入类型。 */
export type ToolCallOutputMessageOf<P extends AgentProtocol> = P['toolCallOutputMessage'];
/** 从协议规格中取出单个原始工具调用类型。 */
export type RawToolCallOf<P extends AgentProtocol> = P['rawToolCall'];

/** 工具 payload 的压缩位置。 */
export type ToolPayloadKind = 'tool_input' | 'tool_result';

/** 传给工具 payload 压缩器的脱敏值快照。 */
export interface ToolPayloadCompactCallSnapshot {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** 工具 payload 压缩器的调用信息。 */
export interface ToolPayloadCompactInfo {
  readonly kind: ToolPayloadKind;
  /** 从 0 开始的 Agent loop 序号；模型请求重试不增加该值。 */
  readonly iteration: number;
  readonly call: ToolPayloadCompactCallSnapshot;
}

/** 完全接管某一类工具 payload 的自定义压缩器。 */
export type ToolPayloadCompactor = (
  original: string,
  info: ToolPayloadCompactInfo,
) => MaybePromise<string | undefined>;

/** 框架缺省字符裁剪策略的可覆盖长度。 */
export interface DefaultToolPayloadCompactOptions {
  readonly strategy: 'default';
  readonly thresholdChars?: number;
  readonly targetChars?: number;
}

/** 单类工具 payload 可使用缺省策略、自定义策略，或显式关闭。 */
export type ToolPayloadCompactConfig =
  | false
  | DefaultToolPayloadCompactOptions
  | ToolPayloadCompactor;

/** 精确定位一个工具输入并替换其 arguments 的协议无关描述。 */
export interface ToolInputReplacement<P extends AgentProtocol> {
  readonly sourceMessage: ContextOf<P>;
  readonly sourceCall: RawToolCallOf<P>;
  readonly replacement: string;
}

/** 精确定位一个工具结果并替换其 output/content 的协议无关描述。 */
export interface ToolResultReplacement<P extends AgentProtocol> {
  readonly sourceMessage: ContextOf<P>;
  readonly callId: string;
  readonly replacement: string;
}

/** 一轮工具调用一次性交给 Model adapter 的批量替换。 */
export interface ToolPayloadReplacements<P extends AgentProtocol> {
  readonly inputs: readonly ToolInputReplacement<P>[];
  readonly results: readonly ToolResultReplacement<P>[];
}

/** Model 错误的框架级分类；允许 Model 扩展自定义种类。 */
export type ModelErrorKind = 'context_length_exceeded' | 'unknown' | (string & {});

/** Model adapter 对 provider 异常提取出的稳定描述。 */
export interface ModelErrorDescriptor {
  readonly kind: ModelErrorKind;
  readonly message: string;
  readonly provider?: string;
  readonly providerCode?: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryableHint?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Model 错误分类时可读取的逻辑请求信息。 */
export interface ModelErrorClassificationContext<P extends AgentProtocol> {
  readonly purpose: ModelGeneratePurpose;
  readonly request: Readonly<ModelGenerateRequest<P>>;
}

/** 本次摘要由主动 trigger 或 context-length 恢复触发。 */
export type ContextCompactCause =
  | { readonly type: 'trigger' }
  | {
      readonly type: 'context_length_exceeded';
      readonly error: ModelErrorDescriptor;
      readonly cause: unknown;
    };

/** 上一次成功摘要的正文及 synthetic memory 消息。 */
export interface SummaryValue<P extends AgentProtocol> {
  readonly text: string;
  readonly message: ContextOf<P>;
}

/** 摘要策略每个阶段都能读取的不可变上下文视图。 */
export interface SummaryCompactSnapshot<P extends AgentProtocol> {
  readonly cause: ContextCompactCause;
  readonly iteration: number;
  readonly activeContext: readonly ContextOf<P>[];
  readonly boundaryOriginalContext: readonly ContextOf<P>[];
  readonly boundaryActiveContext: readonly ContextOf<P>[];
  readonly rawHistory: readonly ContextOf<P>[];
  readonly pendingRequest: Readonly<ModelGenerateRequest<P>>;
  readonly previousSummary?: SummaryValue<P>;
}

/** 交给摘要模型的内容与摘要成功后需要保留的 active 内容。 */
export interface SummaryContextSelection<P extends AgentProtocol> {
  readonly contextToSummarize: readonly ContextOf<P>[];
  readonly preservedContext: readonly ContextOf<P>[];
}

/** 生成外部摘要 prompt 时的完整快照。 */
export interface SummaryPromptSnapshot<P extends AgentProtocol> extends SummaryCompactSnapshot<P> {
  readonly selection: SummaryContextSelection<P>;
}

/** 外部摘要校验器看到的完整候选事务。 */
export interface SummaryValidationSnapshot<
  P extends AgentProtocol,
> extends SummaryPromptSnapshot<P> {
  readonly prompt: string;
  readonly summary: string;
  readonly response: ModelGenerateResult<P>;
  readonly summaryMessage: ContextOf<P>;
  readonly candidateActiveContext: readonly ContextOf<P>[];
}

/** 摘要校验结果；失败原因会进入摘要事务错误。 */
export type SummaryValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** 摘要语义完全由外部定义，框架只负责调用、校验和原子提交。 */
export interface SummaryCompactPolicy<P extends AgentProtocol> {
  trigger(input: SummaryCompactSnapshot<P>): MaybePromise<boolean>;
  select?(input: SummaryCompactSnapshot<P>): MaybePromise<SummaryContextSelection<P> | undefined>;
  prompt(input: SummaryPromptSnapshot<P>): MaybePromise<string>;
  validate?(input: SummaryValidationSnapshot<P>): MaybePromise<SummaryValidationResult>;
}

/** Agent context compact 总配置。对象存在时缺省启用两类工具压缩。 */
export interface ContextCompactOptions<P extends AgentProtocol> {
  readonly toolInput?: ToolPayloadCompactConfig;
  readonly toolResult?: ToolPayloadCompactConfig;
  readonly summary?: SummaryCompactPolicy<P>;
}

/** 一个逻辑模型请求的累计重试账本。 */
export interface ModelRetryLedger {
  readonly requestAttempts: number;
  readonly totalRetries: number;
  readonly forcedRetries: number;
  readonly unhandledRetries: number;
  readonly contextRecoveryAttempts: number;
}

/** 已解析并校验的模型错误恢复上限。 */
export interface ResolvedModelErrorRecoveryLimits {
  readonly unhandledRetryLimit: number;
  readonly contextLengthRecoveryLimit: number;
}

/** 内置恢复 handler 的公开只读身份。 */
export interface ModelErrorRecoveryHandlerMatch {
  readonly id: string;
  readonly kind: ModelErrorKind;
}

/** 恢复 handler 的实际运行结果。 */
export type ModelErrorRecoveryHandlerOutcome =
  | 'not-run'
  | 'succeeded'
  | 'failed'
  | 'unavailable'
  | 'limit-exceeded';

/** 恢复协调器下一步会重试或停止。 */
export type ModelErrorRecoveryAction = 'retry' | 'stop';

/** before hook 可执行的控制决策。 */
export type BeforeModelErrorRecoveryDecision = 'default' | 'retry' | 'continue' | 'stop';

/** after hook 可执行的控制决策。 */
export type AfterModelErrorRecoveryDecision = 'default' | 'retry' | 'stop';

/** before/after 恢复事件的稳定公共字段。 */
export interface ModelErrorRecoveryEventBase<P extends AgentProtocol> {
  readonly cause: unknown;
  readonly descriptor: ModelErrorDescriptor;
  readonly purpose: ModelGeneratePurpose;
  readonly request: Readonly<ModelGenerateRequest<P>>;
  /** 当前失败请求的 1-based 尝试序号。 */
  readonly requestAttempt: number;
  readonly ledger: Readonly<ModelRetryLedger>;
  readonly limits: Readonly<ResolvedModelErrorRecoveryLimits>;
  readonly matchedHandler?: Readonly<ModelErrorRecoveryHandlerMatch>;
  readonly contextRevision: number;
}

/** handler 执行前发出的控制事件。 */
export interface BeforeModelErrorRecoveryEvent<
  P extends AgentProtocol,
> extends ModelErrorRecoveryEventBase<P> {
  readonly defaultAction: ModelErrorRecoveryAction;
}

/** handler 执行或跳过后发出的控制事件。 */
export interface AfterModelErrorRecoveryEvent<
  P extends AgentProtocol,
> extends ModelErrorRecoveryEventBase<P> {
  readonly beforeDecision: BeforeModelErrorRecoveryDecision;
  readonly handlerOutcome: ModelErrorRecoveryHandlerOutcome;
  readonly proposedAction: ModelErrorRecoveryAction;
  readonly handlerFailure?: unknown;
}

/** before recovery 控制 hook。`undefined` 等价于 `default`。 */
export type BeforeModelErrorRecoveryCallback<P extends AgentProtocol> = (
  event: Readonly<BeforeModelErrorRecoveryEvent<P>>,
) => MaybePromise<BeforeModelErrorRecoveryDecision | undefined>;

/** after recovery 控制 hook。`undefined` 等价于 `default`。 */
export type AfterModelErrorRecoveryCallback<P extends AgentProtocol> = (
  event: Readonly<AfterModelErrorRecoveryEvent<P>>,
) => MaybePromise<AfterModelErrorRecoveryDecision | undefined>;

/** 模型异常默认恢复额度。 */
export interface ModelErrorRecoveryOptions {
  /** 首次失败之后允许的普通额外请求数；默认 3。 */
  readonly unhandledRetryLimit?: number;
  /** context-length handler 默认最多真正开始的次数；默认 2。 */
  readonly contextLengthRecoveryLimit?: number;
}

/** 有界恢复决策轨迹中的单条记录。 */
export interface ModelErrorRecoveryDecisionTrace {
  readonly stage: 'before' | 'handler' | 'after' | 'retry' | 'terminal';
  readonly requestAttempt: number;
  readonly decision?: string;
  readonly handlerOutcome?: ModelErrorRecoveryHandlerOutcome;
  readonly action?: ModelErrorRecoveryAction;
}

/** classifier、hook 或 handler 自身失败的稳定记录。 */
export interface ModelErrorRecoveryStageFailure {
  readonly stage: 'classify' | 'before-hook' | 'handler' | 'after-hook';
  readonly cause: unknown;
  readonly requestAttempt: number;
  readonly handlerId?: string;
}

/** 最终停止恢复的原因。 */
export type ModelErrorRecoveryTerminalReason =
  | 'stopped'
  | 'unhandled-retry-limit'
  | 'context-recovery-limit'
  | 'handler-unavailable'
  | 'handler-failed'
  | 'classifier-failed'
  | 'before-hook-failed'
  | 'after-hook-failed';

/** Agent 生成文本输入时使用的协议无关内容块。 */
export interface AgentTextPart {
  /** 固定为文本内容块。 */
  type: 'text';
  /** 文本内容。 */
  text: string;
}

/** Agent 启动文本任务时必须能由 Model 构建的用户消息基础结构。 */
export interface AgentBaseUserMessage {
  /** Agent 基础用户输入只要求支持文本内容块。 */
  content: readonly AgentTextPart[];
}

/** 框架内部提示词交给 Model 构建时使用的系统消息基础结构。 */
export interface AgentBaseSystemMessage {
  /** system prompt 文本。 */
  content: string;
}

/** Model 反解析普通 assistant 文本输出时使用的基础结构。 */
export interface AgentBaseAssistantMessage {
  /** assistant 文本内容块；provider refusal 可由具体协议额外表示。 */
  content: readonly AgentTextPart[];
}

/** 工具执行结果交给 Model 构建时使用的基础结构。 */
export interface AgentBaseToolCallOutputMessage {
  /** 模型工具调用 id；Chat 对应 `tool_call_id`，Responses 对应 `call_id`。 */
  callId: string;
  /** 本地工具执行结果的字符串表示。 */
  output: string;
}

/** Agent 交给 Model 构建为协议工具定义的基础结构。 */
export interface AgentToolDefinitionInput {
  /** 工具名，必须在同一个 Agent 实例中唯一。 */
  name: string;
  /** 提供给模型的工具说明；动态说明会在 Agent 构建工具时先计算为字符串。 */
  description: string;
  /** 工具参数 schema；省略时由 Agent 使用空对象 schema。 */
  parameters?: ToolParametersSchema;
  /** 设置后原值传给协议 Model；省略时请求工具中也不包含 `strict`。 */
  strict?: boolean;
}

/** 反解析后的基础消息及其原始协议消息载体。 */
export interface AgentParsedMessage<TMessage, TContext> {
  /** parser 反解析出的协议抽象消息。 */
  message: TMessage;
  /** 承载该解析结果的原始上下文项。 */
  sourceMessage: TContext;
}

/**
 * Model 从一个协议消息中提取出的单个工具调用。
 *
 * Chat 中一条 assistant message 可能展开为多个调用；`sourceCall` 精确指向
 * 其中对应的原始项，而 `sourceMessage` 保留承载它的完整消息。
 */
export interface AgentToolCall<P extends AgentProtocol> {
  /** 工具调用 id，用于把执行结果关联回模型请求。 */
  id: string;
  /** 本地工具名。 */
  name: string;
  /** 模型输出的原始 JSON 参数字符串。 */
  arguments: string;
  /** 承载该调用的完整协议上下文项。 */
  sourceMessage: ContextOf<P>;
  /** 单个原始调用项；Chat 中是一条 `tool_calls[]` 元素，Responses 中是 `function_call` item。 */
  sourceCall: RawToolCallOf<P>;
}

/** 内置 `skill` 工具的参数。 */
export interface SkillToolInput {
  /** 需要激活的 Skill 名称。 */
  readonly skill: string;
  /** 可选的 load/read/run 命令字符串；省略时等价于 load。 */
  readonly args?: string;
}

/** Progressive disclosure 第一层允许暴露给模型的 Skill 信息。 */
export interface AgentSkillDescriptor {
  readonly name: string;
  readonly description: string;
}

/** 直接以内存源码定义的一条 Skill script。 */
export interface AgentSkillScript {
  /** 带前导点的单后缀，例如 `.py` 或 `.js`。 */
  readonly extension: string;
  readonly content: string;
  readonly description?: string;
}

/** 跨运行时的结构化 Skill 定义。 */
export interface AgentSkill extends AgentSkillDescriptor {
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly instructions: string;
  readonly references?: Readonly<Record<string, string>>;
  readonly assets?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, AgentSkillScript>>;
}

/** Node 文件能力可用时，从 Agent Skills portable text subset 目录或 SKILL.md 加载。 */
export interface AgentSkillFileSource {
  readonly source: 'file';
  readonly path: string;
}

/** Agent 可配置的 Skill 来源。 */
export type AgentSkillSource = AgentSkill | AgentSkillFileSource;

/** 一个脚本后缀对应的可直接启动 executable 及其固定前置参数。 */
export interface SkillScriptExecutor {
  readonly command: string;
  readonly commandArgs?: readonly string[];
}

/** 手工 executor 覆盖；`false` 删除同后缀的自动检测结果。 */
export type SkillScriptExecutorMap = Readonly<Record<string, SkillScriptExecutor | false>>;

/** Skill 脚本执行配置；所有能力默认关闭。 */
export interface SkillScriptRuntimeOptions {
  readonly autoDetect?: boolean;
  readonly executors?: SkillScriptExecutorMap;
}

/** Skill 子系统运行配置。 */
export interface SkillRuntimeOptions {
  /** `true` 时 Skill 结果才参与全局 tool-result compact；默认 false。 */
  readonly compactResult?: boolean;
  /** 省略或 false 时禁止执行任何 Skill script。 */
  readonly scripts?: false | SkillScriptRuntimeOptions;
  /** 替换 file source 的缺省文本资源后缀。 */
  readonly resourceExtensions?: readonly string[];
}

/** 一次已启动 Skill script 的完整退出结果。 */
export interface SkillScriptExecutionResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** file source 在最近一次成功初始化中被忽略的稳定原因。 */
export type AgentSkillSourceDiagnosticReason =
  | 'node_unavailable'
  | 'file_capability_unavailable'
  | 'read_permission_denied'
  | 'source_access_denied';

/** 不包含本地路径的 file source 初始化诊断。 */
export interface AgentSkillSourceDiagnostic {
  /** configured sources 中的 0-based 下标。 */
  readonly sourceIndex: number;
  readonly reason: AgentSkillSourceDiagnosticReason;
}

/**
 * 调用动态工具描述函数时传入的协议无关上下文。
 *
 * 装饰器定义属于类级 metadata，本期不将其绑定到具体 Model 协议。
 */
export interface ToolDescriptionContext {
  skills: readonly AgentSkillDescriptor[];
  subAgents: readonly AgentConstructor<AgentProtocol>[];
  context: readonly unknown[];
  history: readonly unknown[];
  systemPrompts: readonly string[];
  tool: {
    name: string;
    parameters?: ToolParametersSchema;
    strict?: boolean;
  };
}

/** 静态工具描述，或在每次构建模型请求时动态生成的工具描述。 */
export type ToolDescription = string | ((ctx: ToolDescriptionContext) => string);

/** `@Tool` 装饰器和运行时工具共用的公开工具定义。 */
export interface ToolDefinition {
  name: string;
  description: ToolDescription;
  parameters?: ToolParametersSchema;
  /** 可选的协议严格参数标记；框架不设置默认值，也不修改 schema。 */
  strict?: boolean;
}

/** 参数解析和校验成功后执行的运行时工具函数。 */
export type ToolHandler = (parameters: unknown) => unknown | Promise<unknown>;

/** 绑定了实例 handler、可由 Agent 执行的运行时工具定义。 */
export interface ToolRuntimeDefinition extends ToolDefinition {
  handler: ToolHandler;
}

/** 子代理实例必须满足的最小契约。 */
export interface AgentInstance<P extends AgentProtocol> {
  init(): this;
  agent(input: string | UserMessageOf<P>, stream?: boolean): Promise<ContextOf<P>[]>;
}

/** `AgentOptions.subAgents` 接收的同协议子代理构造器契约。 */
export interface AgentConstructor<P extends AgentProtocol> {
  new (options: AgentOptions<P>): AgentInstance<P>;
  readonly name: string;
  readonly description?: string;
  readonly toolsDefinition: readonly ToolDefinition[];
}

/** 创建 Agent 或 Agent 子类实例时使用的选项。 */
export interface AgentOptions<P extends AgentProtocol> {
  /** 提供消息构建、反解析和生成能力的协议 Model。 */
  llm: Model<P>;
  /** 通过 progressive disclosure 暴露给模型的 Skill 来源。 */
  skills?: readonly AgentSkillSource[];
  /** Skill 的文本资源、脚本和 compact 行为配置。 */
  skillRuntime?: SkillRuntimeOptions;
  /** 可由内置 `agent` 工具调度的同协议子代理类。 */
  subAgents?: readonly AgentConstructor<P>[];
  /** 用户 system prompt；框架内部提示词会排列在这些提示词之前。 */
  systemPrompts?: readonly string[];
  /** 初始有效上下文；省略时回退到 `initRawContext`。 */
  initContext?: readonly ContextOf<P>[];
  /** 初始原始历史记录；省略时回退到 `initContext`。 */
  initRawContext?: readonly ContextOf<P>[];
  /** 可选的 Agent 循环硬上限；省略表示不显式限制迭代轮数。 */
  maxIterations?: number;
  /** active-only 工具 payload 与摘要压缩策略。 */
  contextCompact?: ContextCompactOptions<P>;
  /** 模型异常的普通重试与 context-length 恢复额度。 */
  modelErrorRecovery?: ModelErrorRecoveryOptions;
}

/** before/after 工具调用监听器的行为控制选项。 */
export interface ToolEventOptions {
  /**
   * 是否等待该监听器完成后再继续工具执行流程。
   * 启用工具 compact 时，`false` 仍会在 loop finalization 前等待；永不 settle
   * 的 listener 会永久阻塞该轮完成。
   */
  await?: boolean;
  /**
   * 仅对 before 监听器生效：监听器报错时取消真实工具调用。
   * 异步监听器 rejection 只有在 `await` 同时为 `true` 时才能触发取消。
   */
  errorCancel?: boolean;
}

/** 模型请求的指定函数在真正执行前触发的监听器。 */
export type BeforeToolCallCallback<P extends AgentProtocol> = (
  parameters: unknown,
  call: AgentToolCall<P>,
) => void | Promise<void>;

/** 指定工具 handler 返回后触发的监听器。 */
export type AfterToolCallCallback<P extends AgentProtocol> = (
  parameters: unknown,
  call: AgentToolCall<P>,
  result: unknown,
) => void | Promise<void>;

/** 每次模型响应触发一次；触发时整批原始协议消息尚未写入上下文。 */
export type ModelResponseCallback<P extends AgentProtocol> = (
  messages: readonly ContextOf<P>[],
) => void | Promise<void>;

/** before/calling/after 任一工具处理阶段发生错误时触发的监听器。 */
export type ToolCallErrorCallback<P extends AgentProtocol> = (
  name: string,
  triggerType: ToolCallErrorTrigger,
  error: unknown,
  parameters: unknown,
  call: AgentToolCall<P>,
  result?: unknown,
) => void | Promise<void>;

/** Agent 进入已注册状态后触发的监听器。 */
export type AgentStatusChangedCallback<P extends AgentProtocol> = (
  rawContext: readonly ContextOf<P>[],
  context: readonly ContextOf<P>[],
) => void | Promise<void>;

/** `agent()` 抛出错误时触发的监听器。 */
export type AgentErrorCallback = (error: Error) => void | Promise<void>;
