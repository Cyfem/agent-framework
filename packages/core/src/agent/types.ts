/** Agent 的生命周期状态。 */
export type AgentStatus = 'idle' | 'running' | 'ended' | 'failed';

/** 触发工具调用错误事件的处理阶段。 */
export type ToolCallErrorTrigger = 'before' | 'calling' | 'after';

/** 事件注册方法返回的取消监听函数。 */
export type Unsubscribe = () => void;

/** 工具参数 schema 转换后使用的 JSON 对象结构。 */
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

/** Responses API 输出 item 中可能携带的状态值。 */
export type AgentResponseStatus = 'in_progress' | 'completed' | 'incomplete';

/** 框架生成的 Responses 输入消息中的文本内容块。 */
export interface AgentInputTextContentPart {
  type: 'input_text';
  text: string;
}

/** 通过 Files API 上传后，在 Responses 输入消息中引用的图片内容块。 */
export interface AgentInputImageContentPart {
  type: 'input_image';
  file_id: string;
  detail?: 'auto' | 'low' | 'high' | undefined;
}

/** 通过 Files API 上传后，在 Responses 输入消息中引用的通用文件内容块。 */
export interface AgentInputFileContentPart {
  type: 'input_file';
  file_id: string;
}

/** 通过 Files API 上传后，在 Responses 输入消息中引用的视频内容块。 */
export interface AgentInputVideoContentPart {
  type: 'input_video';
  file_id: string;
}

/** 通过 Files API 上传后，在 Responses 输入消息中引用的音频内容块。 */
export interface AgentInputAudioContentPart {
  type: 'input_audio';
  file_id: string;
}

/** 框架生成 Responses 输入消息时支持的内容块联合类型。 */
export type AgentInputContentPart =
  | AgentInputTextContentPart
  | AgentInputImageContentPart
  | AgentInputFileContentPart
  | AgentInputVideoContentPart
  | AgentInputAudioContentPart;

/**
 * 由 Agent 生成或由应用代码主动追加的 Responses 输入消息。
 *
 * 框架生成的输入消息不会伪造 `id`、`status` 等仅属于模型响应的字段。
 */
export interface AgentInputMessage {
  role: 'system' | 'developer' | 'user';
  content: readonly AgentInputContentPart[];
  type?: 'message';
}

/** 方舟 Responses `reasoning` 输出 item 中返回的推理摘要项。 */
export interface AgentReasoningSummary {
  type: 'summary_text';
  text: string;
  [key: string]: unknown;
}

/** 模型返回并在对话上下文中原样保留的推理 item。 */
export interface AgentReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: readonly AgentReasoningSummary[];
  status?: AgentResponseStatus;
  [key: string]: unknown;
}

/** assistant Responses 消息中的文本输出内容块。 */
export interface AgentOutputTextContentPart {
  type: 'output_text';
  text: string;
  [key: string]: unknown;
}

/** 模型返回并原样保留的 assistant 输出消息。 */
export interface AgentAssistantOutputMessage {
  type: 'message';
  role: 'assistant';
  id?: string;
  content: readonly (AgentOutputTextContentPart | Record<string, unknown>)[];
  status?: AgentResponseStatus;
  [key: string]: unknown;
}

/**
 * 模型返回的函数调用 item。
 *
 * 写入 context 以及后续重新发送时，会保留响应中的全部字段，包括提供方扩展字段。
 */
export interface AgentFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  id?: string;
  status?: AgentResponseStatus;
  [key: string]: unknown;
}

/** 方舟 Responses 兼容提供方返回的其他输出 item。 */
export interface AgentUnknownResponseOutputItem {
  type: string;
  [key: string]: unknown;
}

/** 模型 Responses 输出 item；框架会不经投影地保存并在后续请求中回传。 */
export type AgentResponseOutputItem =
  | AgentReasoningItem
  | AgentAssistantOutputMessage
  | AgentFunctionCallItem
  | AgentUnknownResponseOutputItem;

/** 执行模型请求的函数调用后，由本地生成的函数结果 item。 */
export interface AgentFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

/** Agent 持久保存并作为 Responses `input` 发送的上下文 item 联合类型。 */
export type AgentContext =
  | AgentInputMessage
  | AgentFunctionCallOutputItem
  | AgentResponseOutputItem;

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

/** 调用动态工具描述函数时传入的上下文。 */
export interface ToolDescriptionContext {
  /** 当前 Agent 可见的技能手册。 */
  skills: readonly AgentSkill[];
  /** 可通过内置 `agent` 工具调度的子代理构造器。 */
  subAgents: readonly AgentConstructor[];
  /** 当前有效的 Responses 输入上下文，不包含临时注入的 system prompt。 */
  context: readonly AgentContext[];
  /** 原始历史记录，可与有效上下文分别初始化。 */
  history: readonly AgentContext[];
  /** 用户提供的 system prompt，不包含框架内部提示词。 */
  systemPrompts: readonly string[];
  /** 当前正在转换并暴露给模型的工具。 */
  tool: {
    name: string;
    parameters?: ToolParametersSchema;
  };
}

/** 静态工具描述，或在每次构建模型请求时动态生成的工具描述。 */
export type ToolDescription = string | ((ctx: ToolDescriptionContext) => string);

/** `@Tool` 装饰器和运行时工具共用的公开工具定义。 */
export interface ToolDefinition {
  name: string;
  description: ToolDescription;
  parameters?: ToolParametersSchema;
}

/** 参数解析和校验成功后执行的运行时工具函数。 */
export type ToolHandler = (parameters: unknown) => unknown | Promise<unknown>;

/** 绑定了实例 handler、可由 Agent 执行的运行时工具定义。 */
export interface ToolRuntimeDefinition extends ToolDefinition {
  handler: ToolHandler;
}

/** 传入 Model 实现的方舟 Responses 兼容函数工具定义。 */
export interface ModelToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonObject;
  strict: true;
}

/** 基于 Responses 的 Model 实现所接收的请求结构。 */
export interface ModelResponsesRequest {
  input: readonly AgentContext[];
  tools: readonly ModelToolDefinition[];
}

/**
 * 基于 Responses 的 Model 实现所返回的响应结构。
 *
 * `output` 中的 item 将由 Agent 原样写入 context/history，并在下一轮作为 `input` 回传。
 */
export interface ModelResponsesResponse {
  output: readonly AgentResponseOutputItem[];
  raw?: unknown;
}

/** 子代理实例必须满足的最小契约。 */
export interface AgentInstance {
  init(): this;
  agent(message: string, stream?: boolean): Promise<AgentContext[]>;
}

/** `AgentOptions.subAgents` 接收的子代理构造器契约。 */
export interface AgentConstructor<TAgent extends AgentInstance = AgentInstance> {
  new (options: AgentOptions): TAgent;
  readonly name: string;
  readonly description?: string;
  readonly toolsDefinition: readonly ToolDefinition[];
}

/** 创建 Agent 或 Agent 子类实例时使用的选项。 */
export interface AgentOptions {
  /** 基于 Responses 的 LLM 适配器；`OpenAIModel` 或自定义 `Model` 子类均可提供此能力。 */
  llm: {
    responses(request: ModelResponsesRequest): Promise<ModelResponsesResponse>;
  };
  /** 通过内部 system prompt 向模型展示索引的技能手册。 */
  skills?: readonly AgentSkill[];
  /** 可由内置 `agent` 工具调度的子代理类。 */
  subAgents?: readonly AgentConstructor[];
  /** 用户 system prompt；框架内部提示词会排列在这些提示词之前。 */
  systemPrompts?: readonly string[];
  /** 初始有效 Responses 输入上下文；省略时回退到 `initRawContext`。 */
  initContext?: readonly AgentContext[];
  /** 初始原始历史记录；省略时回退到 `initContext`。 */
  initRawContext?: readonly AgentContext[];
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
export type BeforeToolCallCallback = (
  parameters: unknown,
  message: AgentFunctionCallItem,
) => void | Promise<void>;

/** 指定工具 handler 返回后触发的监听器。 */
export type AfterToolCallCallback = (
  parameters: unknown,
  message: AgentFunctionCallItem,
  result: unknown,
) => void | Promise<void>;

/** 每次模型响应触发一次；触发时整批 `output` 尚未写入上下文。 */
export type ModelResponseCallback = (
  output: readonly AgentResponseOutputItem[],
) => void | Promise<void>;

/** before/calling/after 任一工具处理阶段发生错误时触发的监听器。 */
export type ToolCallErrorCallback = (
  name: string,
  triggerType: ToolCallErrorTrigger,
  error: unknown,
  parameters: unknown,
  message: AgentFunctionCallItem,
  result?: unknown,
) => void | Promise<void>;

/** Agent 进入已注册状态后触发的监听器。 */
export type AgentStatusChangedCallback = (
  rawContext: readonly AgentContext[],
  context: readonly AgentContext[],
) => void | Promise<void>;

/** `agent()` 抛出错误时触发的监听器。 */
export type AgentErrorCallback = (error: Error) => void | Promise<void>;
