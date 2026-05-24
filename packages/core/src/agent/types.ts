import type { Model } from '../llm/base';

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

/** 技能手册中的一条具体操作流程。 */
export interface AgentSkillSop {
  description: string;
  content: string;
}

/**
 * 技能手册元数据。
 *
 * 框架通过内部 system prompt 暴露技能索引；模型应先调用内置 `get-skill`
 * 获取完整手册，再按照匹配到的流程执行。
 */
export interface AgentSkill {
  name: string;
  description: string;
  systemContent?: string;
  sops?: AgentSkillSop[];
}

/**
 * 调用动态工具描述函数时传入的协议无关上下文。
 *
 * 装饰器定义属于类级 metadata，本期不将其绑定到具体 Model 协议。
 */
export interface ToolDescriptionContext {
  skills: readonly AgentSkill[];
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
  /** 通过内部 system prompt 向模型展示索引的技能手册。 */
  skills?: readonly AgentSkill[];
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
}

/** before/after 工具调用监听器的行为控制选项。 */
export interface ToolEventOptions {
  /** 是否等待该监听器完成后再继续工具执行流程。 */
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
