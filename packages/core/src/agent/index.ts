import { z } from 'zod';

import { getToolDefinitions, Tool } from './decorators';
import { getDefaultToolParametersSchema, toOpenAIToolParameters } from './schema';
import type {
  AfterToolCallCallback,
  AgentConstructor,
  AgentContext,
  AgentErrorCallback,
  AgentFunctionCallItem,
  AgentFunctionCallOutputItem,
  AgentOptions,
  AgentResponseOutputItem,
  AgentSkill,
  AgentStatus,
  AgentStatusChangedCallback,
  BeforeToolCallCallback,
  ModelResponseCallback,
  ModelToolDefinition,
  ToolCallErrorCallback,
  ToolDefinition,
  ToolEventOptions,
  ToolRuntimeDefinition,
  Unsubscribe,
} from './types';

interface ToolEventListener<TCallback> {
  toolName: string;
  callback: TCallback;
  options: Required<ToolEventOptions>;
}

interface AgentStatusListener {
  status: AgentStatus;
  callback: AgentStatusChangedCallback;
}

const beforeToolErrorPrefix = '函数调用的前置工作出现异常，异常为：';
const internalEndAgentPrompt =
  '框架约束：当任务完成时，必须单独调用 end-agent 工具结束任务；不能仅用自然语言回答表示结束，也不能把 end-agent 与其他工具放在同一轮调用。';
// 装饰器 initializer 早于类字段 initializer 执行，因此借助 symbol-backed
// 存储和公开访问器保留实例工具，避免工具数组被字段初始化覆盖。
const toolsStorageKey: unique symbol = Symbol('agent.tools');

interface ToolsStorageCarrier {
  [toolsStorageKey]?: ToolRuntimeDefinition[];
}

/**
 * 运行于 Node.js 的 Agent 主执行器。
 *
 * Agent 管理 Responses 上下文、工具、技能、子代理与生命周期事件。配置完运行时
 * 工具或子代理后，必须先调用 `init()`，再调用 `agent()` 或 `toolCall()`。
 */
export class Agent {
  /**
   * 当前 Agent 实例可调用的运行时工具集合。
   *
   * 装饰器工具会在实例构造阶段自动注册；也可以在 `init()` 前追加仅在本实例
   * 生效的工具。
   */
  get tools(): ToolRuntimeDefinition[] {
    return getToolsStorage(this);
  }

  set tools(tools: ToolRuntimeDefinition[]) {
    setToolsStorage(this, tools);
  }

  #rawContext: AgentContext[] = [];
  #context: AgentContext[] = [];
  #skills: AgentSkill[] = [];
  #systemPrompts: string[] = [];
  #status: AgentStatus = 'idle';
  #maxIterations: number | undefined;
  #llm: AgentOptions['llm'];
  #initialized = false;

  #beforeToolListeners: ToolEventListener<BeforeToolCallCallback>[] = [];
  #afterToolListeners: ToolEventListener<AfterToolCallCallback>[] = [];
  #toolCallErrorListeners: ToolCallErrorCallback[] = [];
  #statusListeners: AgentStatusListener[] = [];
  #modelResponseListeners: ModelResponseCallback[] = [];

  #agentErrorListeners: AgentErrorCallback[] = [];

  /** 该类作为子代理暴露时使用的人类可读说明。 */
  static description?: string;

  /** 可由内置 `agent` 工具调度的子代理类集合。 */
  subAgents: AgentConstructor[] = [];

  /** 当前类及其父类通过装饰器声明的静态工具定义。 */
  static get toolsDefinition(): readonly ToolDefinition[] {
    return getToolDefinitions(this);
  }

  @Tool({
    name: 'agent',
    description: ({ subAgents }) => {
      const agentList =
        subAgents.length === 0
          ? '当前没有可调度的子代理。'
          : subAgents.map(formatSubAgentDescription).join('\n\n');

      return [
        '这是一个子代理调度工具，当你需要调用一个子代理来完成某个任务时，请使用这个工具。调用时请在参数中说明需要调用的子代理名称和输入子代理的内容。',
        '每次调度同一子代理都是全新的代理，并且可以同时调度多个相同子代理。',
        '调度子代理时，需要指定任务的描述，以及需要子代理最后汇报你的东西的描述。比如如果是一个任务，那需要汇报你任务的报告；如果是需要一个问题的答案，则是问题的回答。',
        '以下是当前可用的子代理列表：',
        agentList,
      ].join('\n\n');
    },
    parameters: z.object({
      agentName: z.string().describe('要调用的子代理名称'),
      input: z.string().describe('输入子代理的内容'),
      outputDescription: z
        .string()
        .describe('需要让子代理最后交付你的东西的描述，比如任务的报告、问题的回答'),
    }),
  })
  async #toolSubAgent(parameters: unknown): Promise<string> {
    const { agentName, input, outputDescription } = parameters as {
      agentName: string;
      input: string;
      outputDescription: string;
    };
    const TargetAgent = this.subAgents.find((agent) => agent.name === agentName);

    if (!TargetAgent) {
      return `没有找到名称为 ${agentName} 的子代理。`;
    }

    let agentResult: string | undefined;
    const BaseSubAgent = TargetAgent as typeof Agent;

    // 为本次调度创建临时子类，仅向这一轮子代理执行暴露 `agent-result`。
    class RuntimeSubAgent extends BaseSubAgent {
      @Tool({
        name: 'agent-result',
        description: `这是一个结果汇报工具，你需要在完成任务后调用这个工具把结果汇报回来`,
        parameters: z.object({
          result: z.string().describe(outputDescription),
        }),
      })
      #reportResult(parameters: unknown): string {
        const { result } = parameters as { result: string };

        agentResult = result;
        return result;
      }
    }

    // 子代理复用模型适配器，但拥有独立上下文，并在启动前走同样的配置校验。
    const subAgent = new RuntimeSubAgent({
      llm: this.#llm,
      systemPrompts: [
        `你现在是被主代理调度的子代理：${agentName}。`,
        `主代理输入给你的任务：\n${input}`,
        [
          '完成任务后，调用 end-agent 前必须先调用 agent-result 工具把结果汇报回来。',
          `agent-result.result 必须满足如下交付描述：\n${outputDescription}`,
        ].join('\n'),
      ],
    });

    subAgent.init();
    await subAgent.agent(input);

    return agentResult ?? '子代理已结束但未通过 agent-result 汇报结果。';
  }

  /** 使用模型适配器及可选运行配置创建 Agent 实例。 */
  constructor(options: AgentOptions) {
    this.#llm = options.llm;
    this.#maxIterations = options.maxIterations;
    this.#context = [...(options.initContext ?? options.initRawContext ?? [])];
    this.#rawContext = [...(options.initRawContext ?? options.initContext ?? [])];
    this.tools ??= [];
    this.subAgents = [...(options.subAgents ?? [])];

    if (
      this.#maxIterations !== undefined &&
      (this.#maxIterations < 1 || !Number.isInteger(this.#maxIterations))
    ) {
      throw new Error('maxIterations must be a positive integer.');
    }

    this.addSkill(...(options.skills ?? []));
    this.addSystemPrompts(...(options.systemPrompts ?? []));
  }

  /** 获取完整历史记录；返回的数组为浅拷贝。 */
  getHistory(): readonly AgentContext[] {
    return [...this.#rawContext];
  }

  /** 获取模型请求使用的活动上下文，不包含临时注入的内部系统提示词。 */
  getContext(): readonly AgentContext[] {
    return [...this.#context];
  }

  /**
   * 校验运行时配置并将 Agent 标记为已初始化。
   *
   * 修改 `tools` 或 `subAgents` 后应重新调用本方法；重复调用只重新校验配置，
   * 不会清空历史或事件监听。
   */
  init(): this {
    this.#initialized = false;
    this.#assertUniqueToolNames();
    this.#assertUniqueSubAgentNames();
    this.#initialized = true;

    return this;
  }

  /** 追加非空系统提示词；请求模型时它们排在框架内部提示词之后。 */
  addSystemPrompts(...prompts: string[]): this {
    for (const prompt of prompts) {
      if (prompt.trim().length > 0) {
        this.#systemPrompts.push(prompt);
      }
    }

    return this;
  }

  /** 追加技能手册；新增技能会从下一次模型请求开始对模型可见。 */
  addSkill(...skills: AgentSkill[]): this {
    this.#skills.push(...skills);
    return this;
  }

  /** 向完整历史和活动上下文同时追加文本或多模态消息。 */
  appendContext(message: AgentContext): this {
    this.#appendMessage(message);
    return this;
  }

  /** 在任一模型输出 item 写入上下文前，监听该轮完整 output 数组。 */
  onModelResponse(callback: ModelResponseCallback): Unsubscribe {
    return addListener(this.#modelResponseListeners, callback);
  }

  /** 监听指定工具的调用前阶段；可通过 options 等待回调或在异常时取消调用。 */
  onBeforeToolCall(
    toolName: string,
    callback: BeforeToolCallCallback,
    options?: ToolEventOptions,
  ): Unsubscribe {
    return addListener(this.#beforeToolListeners, {
      toolName,
      callback,
      options: normalizeToolEventOptions(options),
    });
  }

  /** 监听指定工具处理器返回后的阶段；回调异常会上报，但不会中断主流程。 */
  onAfterToolCall(
    toolName: string,
    callback: AfterToolCallCallback,
    options?: ToolEventOptions,
  ): Unsubscribe {
    return addListener(this.#afterToolListeners, {
      toolName,
      callback,
      options: normalizeToolEventOptions(options),
    });
  }

  /** 监听工具在 `before`、`calling` 或 `after` 阶段发生的异常。 */
  onToolCallError(callback: ToolCallErrorCallback): Unsubscribe {
    return addListener(this.#toolCallErrorListeners, callback);
  }

  /** 监听 Agent 进入指定状态的事件。 */
  onAgentStatusChanged(status: AgentStatus, callback: AgentStatusChangedCallback): Unsubscribe {
    return addListener(this.#statusListeners, {
      status,
      callback,
    });
  }

  /** 监听 `agent()` 抛出的错误；listener 自身异常不会影响 Agent 状态。 */
  onAgentError(callback: AgentErrorCallback): Unsubscribe {
    return addListener(this.#agentErrorListeners, callback);
  }

  @Tool({
    name: 'get-skill',
    description: '获取指定下标的技能手册完整内容。',
    parameters: z.object({
      index: z.number().int().nonnegative(),
    }),
  })
  #getSkill(parameters: unknown): string {
    const { index } = parameters as { index: number };
    const skill = this.#skills[index];

    if (!skill) {
      return `没有找到下标为 ${index} 的技能手册。`;
    }

    const parts = [
      `手册标题：${skill.name}`,
      `手册描述：${skill.description}`,
      skill.systemContent ? `全局适用内容：${skill.systemContent}` : '',
      ...(skill.sops ?? []).map((sop, sopIndex) =>
        [`工作流${sopIndex + 1}：${sop.description}`, `执行流程：\n${sop.content}`].join('\n'),
      ),
    ].filter((part) => part.length > 0);

    return parts.join('\n\n');
  }

  @Tool({
    name: 'end-agent',
    description:
      '当你认为你已经彻底完成了用户交代的任务，并且不需要更多信息时，请调用这个工具。该工具必须在任务确定结束时单独调用，不能跟其他工具一起调用。',
  })
  #endAgent(): string {
    this.#changeStatus('ended');
    return 'Agent 已结束。';
  }

  /**
   * 执行一个已解析的模型函数调用，并返回本地结果 item。
   *
   * 成功结果会先写入上下文，再触发 after listener，使 listener 追加的消息
   * 排在对应的 `function_call_output` 之后。
   */
  async toolCall(callInfo: AgentFunctionCallItem): Promise<AgentFunctionCallOutputItem> {
    this.#assertInitialized();

    const tool = this.tools.find((candidate) => candidate.name === callInfo.name);
    const fallbackParameters: unknown = {};

    if (!tool) {
      const error = new Error(`Unknown tool: ${callInfo.name}`);
      await this.#emitToolCallError(callInfo.name, 'calling', error, fallbackParameters, callInfo);
      return this.#appendToolMessage(
        createToolMessage(callInfo.call_id, normalizeErrorMessage(error)),
      );
    }

    const parsedArguments = await this.#parseToolArguments(tool, callInfo);

    if (!parsedArguments.ok) {
      return this.#appendToolMessage(createToolMessage(callInfo.call_id, parsedArguments.message));
    }

    const parameters = parsedArguments.parameters;
    const beforeResult = await this.#runBeforeToolListeners(tool.name, parameters, callInfo);

    if (beforeResult.canceled) {
      return this.#appendToolMessage(
        createToolMessage(
          callInfo.call_id,
          `${beforeToolErrorPrefix}${normalizeErrorMessage(beforeResult.error)}`,
        ),
      );
    }

    let result: unknown;

    try {
      result = await tool.handler(parameters);
    } catch (error) {
      await this.#emitToolCallError(tool.name, 'calling', error, parameters, callInfo);
      return this.#appendToolMessage(
        createToolMessage(callInfo.call_id, normalizeErrorMessage(error)),
      );
    }

    const resultMessage = this.#appendToolMessage(
      createToolMessage(callInfo.call_id, serializeToolResult(result)),
    );

    await this.#runAfterToolListeners(tool.name, parameters, callInfo, result);

    return resultMessage;
  }

  /**
   * 启动 Agent 任务循环。
   *
   * 每轮先原样保存完整模型 output，再按顺序执行其中的 `function_call`。
   * 只有内置 `end-agent` 工具把状态改为 `ended` 后任务才结束；当前版本
   * 尚不支持流式调用。
   */
  async agent(message: string, stream = false): Promise<AgentContext[]> {
    let shouldFailOnError = true;

    try {
      this.#assertInitialized();

      if (this.#status === 'running') {
        shouldFailOnError = false;
        throw new Error('Agent is already running.');
      }

      if (stream) {
        throw new Error('Agent streaming is not supported in this version.');
      }

      this.#appendMessage({
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: message,
          },
        ],
      });

      this.#changeStatus('running');

      for (
        let iteration = 0;
        this.#maxIterations === undefined || iteration < this.#maxIterations;
        iteration += 1
      ) {
        const response = await this.#responsesWithEmptyOutputRetry();

        await this.#emitModelResponse(response.output);

        // 模型 output 带有提供方元数据，必须整批原样保存后再执行本地工具。
        for (const outputItem of response.output) {
          this.#appendMessage(outputItem);
        }

        for (const outputItem of response.output) {
          if (isFunctionCallItem(outputItem)) {
            await this.toolCall(outputItem);
          }
        }

        if (this.#status === 'ended') {
          return [...this.#context];
        }
      }

      throw new Error(`Agent exceeded maxIterations: ${this.#maxIterations}.`);
    } catch (error) {
      const agentError = toError(error);

      if (shouldFailOnError && this.#status !== 'ended') {
        this.#changeStatus('failed');
      }

      this.#emitAgentError(agentError);

      throw error instanceof Error ? error : agentError;
    }
  }

  #assertUniqueToolNames(): void {
    this.tools ??= [];
    const seen = new Set<string>();

    for (const tool of this.tools) {
      if (seen.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }

      seen.add(tool.name);
    }
  }

  #assertUniqueSubAgentNames(): void {
    const seen = new Set<string>();

    for (const agent of this.subAgents) {
      if (seen.has(agent.name)) {
        throw new Error(`Duplicate sub-agent name: ${agent.name}`);
      }

      seen.add(agent.name);
    }
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw new Error('Agent has not been initialized. Call init() before agent().');
    }
  }

  #buildInputForModel(): AgentContext[] {
    // 框架协议提示词仅在请求模型时临时前置，不写入 context/history。
    const systemMessages: AgentContext[] = [
      internalEndAgentPrompt,
      this.#buildSkillPrompt(),
      ...this.#systemPrompts,
    ].map((content) => ({
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: content,
        },
      ],
    }));

    return [...systemMessages, ...this.#context];
  }

  #buildSkillPrompt(): string {
    // 技能选择指引放在 system prompt 中，让 `get-skill` 的工具描述保持精简。
    const skillList =
      this.#skills.length === 0
        ? '当前没有可查询的技能手册，不要调用 get-skill。'
        : this.#skills
            .map(
              (skill, index) =>
                `技能手册${index}：\n名称：${skill.name}\n描述：${skill.description}`,
            )
            .join('\n\n');

    return [
      '框架技能约束：当正在执行的任务匹配到如下技能手册描述时，必须先调用 get-skill 工具获取对应下标的完整手册内容，然后检查手册内是否有具体工作流；如果匹配到具体工作流，必须按照该工作流执行。',
      skillList,
    ].join('\n\n');
  }

  #buildToolsForModel(): ModelToolDefinition[] {
    return this.tools.map((tool) => {
      const toolContext: {
        name: string;
        parameters?: NonNullable<ToolRuntimeDefinition['parameters']>;
      } = {
        name: tool.name,
      };

      if (tool.parameters) {
        toolContext.parameters = tool.parameters;
      }

      const description =
        typeof tool.description === 'function'
          ? tool.description({
              skills: [...this.#skills],
              subAgents: [...this.subAgents],
              context: [...this.#context],
              history: [...this.#rawContext],
              systemPrompts: [...this.#systemPrompts],
              tool: toolContext,
            })
          : tool.description;

      return {
        type: 'function',
        name: tool.name,
        description,
        parameters: toOpenAIToolParameters(tool.parameters ?? getDefaultToolParametersSchema()),
        strict: true,
      };
    });
  }

  async #responsesWithEmptyOutputRetry() {
    let lastResponseText = 'Model returned no output.';

    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const response = await this.#llm.responses({
        input: this.#buildInputForModel(),
        tools: this.#buildToolsForModel(),
      });

      if (response.output.length > 0) {
        return response;
      }

      lastResponseText = `Model returned no output after ${attempt + 1} attempt(s).`;
    }

    throw new Error(lastResponseText);
  }

  async #parseToolArguments(
    tool: ToolRuntimeDefinition,
    callInfo: AgentFunctionCallItem,
  ): Promise<
    | {
        ok: true;
        parameters: unknown;
      }
    | {
        ok: false;
        message: string;
      }
  > {
    let rawParameters: unknown;

    try {
      rawParameters = callInfo.arguments.trim().length > 0 ? JSON.parse(callInfo.arguments) : {};
    } catch (error) {
      await this.#emitToolCallError(tool.name, 'calling', error, {}, callInfo);
      return {
        ok: false,
        message: normalizeErrorMessage(error),
      };
    }

    const schema = tool.parameters ?? getDefaultToolParametersSchema();
    const parsed = schema.safeParse(rawParameters);

    if (!parsed.success) {
      await this.#emitToolCallError(tool.name, 'calling', parsed.error, rawParameters, callInfo);
      return {
        ok: false,
        message: normalizeErrorMessage(parsed.error),
      };
    }

    return {
      ok: true,
      parameters: parsed.data,
    };
  }

  async #runBeforeToolListeners(
    toolName: string,
    parameters: unknown,
    message: AgentFunctionCallItem,
  ): Promise<
    | {
        canceled: true;
        error: unknown;
      }
    | {
        canceled: false;
      }
  > {
    for (const listener of this.#beforeToolListeners.filter((item) => item.toolName === toolName)) {
      try {
        const result = listener.callback(parameters, message);

        if (listener.options.await) {
          await result;
        } else {
          void Promise.resolve(result).catch((error: unknown) => {
            void this.#emitToolCallError(toolName, 'before', error, parameters, message);
          });
        }
      } catch (error) {
        await this.#emitToolCallError(toolName, 'before', error, parameters, message);

        // 只有 before listener 可以通过异常取消真实工具调用。
        if (listener.options.errorCancel) {
          return {
            canceled: true,
            error,
          };
        }
      }
    }

    return {
      canceled: false,
    };
  }

  async #runAfterToolListeners(
    toolName: string,
    parameters: unknown,
    message: AgentFunctionCallItem,
    result: unknown,
  ): Promise<void> {
    for (const listener of this.#afterToolListeners.filter((item) => item.toolName === toolName)) {
      try {
        const callbackResult = listener.callback(parameters, message, result);

        if (listener.options.await) {
          await callbackResult;
        } else {
          void Promise.resolve(callbackResult).catch((error: unknown) => {
            void this.#emitToolCallError(toolName, 'after', error, parameters, message, result);
          });
        }
      } catch (error) {
        // after listener 的失败可以被观察，但不能中断 Agent 主循环。
        await this.#emitToolCallError(toolName, 'after', error, parameters, message, result);
      }
    }
  }

  async #emitModelResponse(output: readonly AgentResponseOutputItem[]): Promise<void> {
    for (const listener of this.#modelResponseListeners) {
      try {
        await listener(output);
      } catch {
        // 模型响应 listener 仅用于观察，不应打断 Agent 主循环。
      }
    }
  }

  async #emitToolCallError(
    name: string,
    triggerType: 'before' | 'calling' | 'after',
    error: unknown,
    parameters: unknown,
    message: AgentFunctionCallItem,
    result?: unknown,
  ): Promise<void> {
    for (const listener of this.#toolCallErrorListeners) {
      try {
        await listener(name, triggerType, error, parameters, message, result);
      } catch {
        // 工具错误 listener 仅用于观察，不应产生新的工具错误。
      }
    }
  }

  #emitAgentError(error: Error): void {
    for (const listener of this.#agentErrorListeners) {
      try {
        const result = listener(error);

        void Promise.resolve(result).catch((listenerError: unknown) => {
          void listenerError;
          // 错误 listener 属于非阻塞观察者；暂不向控制台重复输出其异常。
        });
      } catch (listenerError) {
        void listenerError;
        // Agent 错误 listener 仅用于观察，不应制造新的 Agent 错误。
      }
    }
  }

  #appendMessage(message: AgentContext): void {
    this.#rawContext.push(message);
    this.#context.push(message);
  }

  #appendToolMessage(message: AgentFunctionCallOutputItem): AgentFunctionCallOutputItem {
    this.#appendMessage(message);
    return message;
  }

  #changeStatus(status: AgentStatus): void {
    if (this.#status === status) {
      return;
    }

    this.#status = status;

    for (const listener of this.#statusListeners.filter((item) => item.status === status)) {
      void Promise.resolve(listener.callback([...this.#rawContext], [...this.#context])).catch(
        () => {
          // 状态 listener 仅用于观察，不应打断状态迁移。
        },
      );
    }
  }
}

function addListener<TListener>(listeners: TListener[], listener: TListener): Unsubscribe {
  listeners.push(listener);

  return () => {
    const index = listeners.indexOf(listener);

    if (index >= 0) {
      listeners.splice(index, 1);
    }
  };
}

function normalizeToolEventOptions(options?: ToolEventOptions): Required<ToolEventOptions> {
  return {
    await: options?.await ?? false,
    errorCancel: options?.errorCancel ?? false,
  };
}

function createToolMessage(callId: string, content: string): AgentFunctionCallOutputItem {
  return {
    type: 'function_call_output',
    call_id: callId,
    output: content,
  };
}

function isFunctionCallItem(item: AgentResponseOutputItem): item is AgentFunctionCallItem {
  return (
    item.type === 'function_call' &&
    typeof item.call_id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.arguments === 'string'
  );
}

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (result === undefined) {
    return '';
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return serializeToolResult(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getToolsStorage(agent: object): ToolRuntimeDefinition[] {
  const carrier = agent as ToolsStorageCarrier;

  carrier[toolsStorageKey] ??= [];

  return carrier[toolsStorageKey];
}

function setToolsStorage(agent: object, tools: ToolRuntimeDefinition[]): void {
  const carrier = agent as ToolsStorageCarrier;

  carrier[toolsStorageKey] = tools;
}

function formatSubAgentDescription(agent: AgentConstructor, index: number): string {
  const toolList =
    agent.toolsDefinition.length === 0
      ? '    当前子代理没有声明工具能力。'
      : agent.toolsDefinition.map(formatStaticToolDescription).join('\n');

  return [
    `子代理${index + 1}：`,
    `  名称：${agent.name || '未命名代理'}`,
    `  描述：${agent.description ?? '未提供描述。'}`,
    '  工具能力：',
    toolList,
  ].join('\n');
}

function formatStaticToolDescription(tool: ToolDefinition, index: number): string {
  return [
    `    - 工具${index + 1}：${tool.name}`,
    `      描述：${typeof tool.description === 'function' ? '动态描述，运行时生成。' : tool.description}`,
  ].join('\n');
}

export { Tool };
export type * from './types';
