import { z } from 'zod';

import type { ModelGeneratePurpose, ModelGenerateRequest, ModelGenerateResult } from '../llm/base';
import {
  awaitWithAbort,
  createAbortScope,
  isAbortError,
  throwIfAborted,
  type AbortScope,
} from '../llm/base/abort';
import type { ToolRuntimeContext } from '../subagent/agent-run';
import {
  createSummaryCompactSnapshot,
  hasToolPayloadCompactor,
  resolveContextCompactOptions,
  rewriteOpenLoopToolPayloads,
  runSummaryCompactTransaction,
  type ResolvedContextCompactOptions,
  type ToolExecutionRecord,
} from './context-compact';
import { ContextStore } from './context-store';
import type { ContextStoreSummarySnapshot } from './context-store';
import { DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS } from './default-tool-payload-compactor';
import { getToolDefinitions, Tool } from './decorators';
import {
  DEFAULT_MODEL_ERROR_RECOVERY_LIMITS,
  generateWithModelErrorRecovery,
  MODEL_ERROR_RECOVERY_TRACE_LIMIT,
  ModelErrorRecoveryError,
  resolveModelErrorRecoveryLimits,
} from './model-error-recovery';
import { getDefaultToolParametersSchema } from './schema';
import { renderSkillDiscoveryCatalog } from './skill-command';
import { createSkillFileSourceAdapter } from './skill-file-source';
import { getSkillNodeCapabilities } from './skill-node-runtime';
import { SkillRegistry } from './skill-registry';
import {
  DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS,
  detectSkillScriptExecutors,
  resolveSkillRuntimeOptions,
  SkillScriptRuntime,
  type ResolvedSkillRuntimeOptions,
} from './skill-script-runtime';
import type {
  AfterModelErrorRecoveryCallback,
  AfterToolCallCallback,
  AgentConstructor,
  AgentErrorCallback,
  AgentExecutionOptions,
  AgentOptions,
  AgentProtocol,
  AgentSkillSource,
  AgentSkillSourceDiagnostic,
  AgentStatus,
  AgentStatusChangedCallback,
  AgentToolCall,
  BeforeModelErrorRecoveryCallback,
  BeforeToolCallCallback,
  ContextCompactCause,
  ContextCompactOptions,
  ContextOf,
  ModelResponseCallback,
  ModelErrorRecoveryOptions,
  ResolvedModelErrorRecoveryLimits,
  SkillRuntimeOptions,
  SkillToolInput,
  ToolOf,
  ToolCallErrorCallback,
  ToolDefinition,
  ToolEventOptions,
  ToolCallExecutionOptions,
  ToolRuntimeDefinition,
  Unsubscribe,
  UserMessageOf,
} from './types';

interface ToolEventListener<TCallback> {
  toolName: string;
  callback: TCallback;
  options: Required<ToolEventOptions>;
}

interface AgentStatusListener<P extends AgentProtocol> {
  status: AgentStatus;
  callback: AgentStatusChangedCallback<P>;
}

interface ActiveAgentExecution extends AbortScope {
  readonly deadlineAt?: number;
  readonly runtime?: AgentExecutionOptions['runtime'];
}

interface ResolvedAgentExecutionOptions extends AgentExecutionOptions {
  readonly stream: boolean;
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
 * Agent 管理由模型协议泛型指定的上下文、工具、技能、子代理与生命周期事件。
 * 协议消息的生成和工具调用解析由 `Model<P>` 提供；配置完运行时工具或子代理后，
 * 必须先调用 `init()`，再调用 `agent()` 或 `toolCall()`。
 */
export class Agent<P extends AgentProtocol> {
  /**
   * 当前 Agent 实例可调用的运行时工具集合。
   *
   * 装饰器工具会在实例构造阶段自动注册；也可以在 `init()` 前追加仅在本实例
   * 生效的工具。
   */
  get tools(): ToolRuntimeDefinition[] {
    return getToolsStorage(this);
  }

  /** 替换当前实例工具集合；替换后需要重新调用 `init()` 进行重复名校验。 */
  set tools(tools: ToolRuntimeDefinition[]) {
    setToolsStorage(this, tools);
  }

  #contextStore: ContextStore<P>;
  #skillSources: AgentSkillSource[] = [];
  #skillRuntimeConfig: SkillRuntimeOptions | undefined;
  #skillRuntime!: ResolvedSkillRuntimeOptions;
  #skillRegistry = SkillRegistry.empty();
  #skillSourceDiagnostics: readonly AgentSkillSourceDiagnostic[] = Object.freeze([]);
  #skillConfigurationDirty = true;
  #builtinSkillRuntimeDefinition: ToolRuntimeDefinition;
  #systemPrompts: string[] = [];
  #status: AgentStatus = 'idle';
  #maxIterations: number | undefined;
  #llm: AgentOptions<P>['llm'];
  #contextCompactConfig: ContextCompactOptions<P> | undefined;
  #contextCompact: ResolvedContextCompactOptions<P> = {
    toolInput: { source: 'disabled' },
    toolResult: { source: 'disabled' },
  };
  #modelErrorRecoveryConfig: ModelErrorRecoveryOptions | undefined;
  #modelErrorRecoveryLimits: Readonly<ResolvedModelErrorRecoveryLimits> =
    resolveModelErrorRecoveryLimits();
  #initialized = false;
  #endRequested = false;
  #trackedToolListenerPromises: Promise<void>[] | undefined;

  #beforeToolListeners: ToolEventListener<BeforeToolCallCallback<P>>[] = [];
  #afterToolListeners: ToolEventListener<AfterToolCallCallback<P>>[] = [];
  #toolCallErrorListeners: ToolCallErrorCallback<P>[] = [];
  #statusListeners: AgentStatusListener<P>[] = [];
  #modelResponseListeners: ModelResponseCallback<P>[] = [];
  #beforeModelErrorRecoveryListeners: BeforeModelErrorRecoveryCallback<P>[] = [];
  #afterModelErrorRecoveryListeners: AfterModelErrorRecoveryCallback<P>[] = [];

  #agentErrorListeners: AgentErrorCallback[] = [];

  /** 该类作为子代理暴露时使用的人类可读说明。 */
  static description?: string;

  /** 可由内置 `agent` 工具调度的子代理类集合。 */
  subAgents: AgentConstructor<P>[] = [];

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
  async #toolSubAgent(parameters: unknown, runtime: ToolRuntimeContext<P>): Promise<string> {
    // `agent` 工具的 handler 只接收一个参数对象，便于所有协议共用同一套调用约定。
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
    const BaseSubAgent = TargetAgent as unknown as new (options: AgentOptions<P>) => Agent<P>;

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
    await subAgent.agent(input, {
      signal: runtime.signal,
      ...(runtime.deadlineAt === undefined ? {} : { deadlineAt: runtime.deadlineAt }),
    });

    return agentResult ?? '子代理已结束但未通过 agent-result 汇报结果。';
  }

  /** 使用模型适配器及可选运行配置创建 Agent 实例。 */
  constructor(options: AgentOptions<P>) {
    this.#llm = options.llm;
    this.#maxIterations = options.maxIterations;
    this.#contextStore = new ContextStore(options.initContext, options.initRawContext);
    this.#contextCompactConfig = options.contextCompact;
    this.#modelErrorRecoveryConfig = options.modelErrorRecovery;
    this.#skillRuntimeConfig = options.skillRuntime;
    this.tools ??= [];
    const builtinSkillRuntimeDefinition = this.tools.find((tool) => tool.name === 'skill');

    if (!builtinSkillRuntimeDefinition) {
      throw new Error('Internal skill tool was not registered.');
    }

    this.#builtinSkillRuntimeDefinition = builtinSkillRuntimeDefinition;
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
  getHistory(): readonly ContextOf<P>[] {
    return this.#contextStore.getRawHistory();
  }

  /** 获取模型请求使用的活动上下文，不包含临时注入的内部系统提示词。 */
  getContext(): readonly ContextOf<P>[] {
    return this.#contextStore.getActiveContext();
  }

  /**
   * 校验运行时配置并将 Agent 标记为已初始化。
   *
   * 修改 `tools` 或 `subAgents` 后应重新调用本方法；重复调用只重新校验配置，
   * 不会清空历史或事件监听。
   */
  init(): this {
    if (this.#status === 'running') {
      throw new Error('Cannot initialize an Agent while it is running.');
    }

    this.#initialized = false;
    this.#assertUniqueToolNames();
    this.#assertUniqueSubAgentNames();
    const capabilities = getSkillNodeCapabilities();
    const skillRuntime = resolveSkillRuntimeOptions(this.#skillRuntimeConfig, capabilities);
    const fileSource = createSkillFileSourceAdapter({
      capabilities,
      resourceExtensions: skillRuntime.resourceExtensions,
    });
    const scriptRuntime = new SkillScriptRuntime(skillRuntime, capabilities);
    const skills = SkillRegistry.build({
      sources: this.#skillSources,
      fileSource,
      scriptRuntime,
    });
    const contextCompact = resolveContextCompactOptions(this.#contextCompactConfig);
    const modelErrorRecoveryLimits = resolveModelErrorRecoveryLimits(
      this.#modelErrorRecoveryConfig,
    );

    this.#skillRuntime = skillRuntime;
    this.#skillRegistry = skills.registry;
    this.#skillSourceDiagnostics = skills.diagnostics;
    this.#contextCompact = contextCompact;
    this.#modelErrorRecoveryLimits = modelErrorRecoveryLimits;
    this.#skillConfigurationDirty = false;
    this.#initialized = true;

    return this;
  }

  /** 返回最近一次成功 init 的冻结、无路径 file source 诊断快照。 */
  getSkillSourceDiagnostics(): readonly AgentSkillSourceDiagnostic[] {
    return this.#skillSourceDiagnostics;
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

  /** 追加 configured Skill source；重新 init 成功后才进入 effective registry。 */
  addSkill(...skills: AgentSkillSource[]): this {
    if (skills.length === 0) {
      return this;
    }

    this.#skillSources.push(...skills);
    this.#skillConfigurationDirty = true;

    if (this.#status !== 'running') {
      this.#initialized = false;
    }

    return this;
  }

  /** 向完整历史和活动上下文同时追加文本或多模态消息。 */
  appendContext(message: ContextOf<P>): this {
    if (this.#contextStore.hasOpenLoopSpan) {
      this.#contextStore.appendToOpenLoop(message);
    } else {
      this.#contextStore.appendStandalone(message, 'external');
    }
    return this;
  }

  /** 在任一模型返回消息写入上下文前，监听该轮完整消息数组。 */
  onModelResponse(callback: ModelResponseCallback<P>): Unsubscribe {
    return addListener(this.#modelResponseListeners, callback);
  }

  /** 监听指定工具的调用前阶段；可通过 options 等待回调或在异常时取消调用。 */
  onBeforeToolCall(
    toolName: string,
    callback: BeforeToolCallCallback<P>,
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
    callback: AfterToolCallCallback<P>,
    options?: ToolEventOptions,
  ): Unsubscribe {
    return addListener(this.#afterToolListeners, {
      toolName,
      callback,
      options: normalizeToolEventOptions(options),
    });
  }

  /** 监听工具在 `before`、`calling` 或 `after` 阶段发生的异常。 */
  onToolCallError(callback: ToolCallErrorCallback<P>): Unsubscribe {
    return addListener(this.#toolCallErrorListeners, callback);
  }

  /** 监听 Agent 进入指定状态的事件。 */
  onAgentStatusChanged(status: AgentStatus, callback: AgentStatusChangedCallback<P>): Unsubscribe {
    return addListener(this.#statusListeners, {
      status,
      callback,
    });
  }

  /** 监听 `agent()` 抛出的错误；listener 自身异常不会影响 Agent 状态。 */
  onAgentError(callback: AgentErrorCallback): Unsubscribe {
    return addListener(this.#agentErrorListeners, callback);
  }

  /** 在框架执行默认模型错误恢复动作前注册控制 hook。 */
  onBeforeModelErrorRecovery(callback: BeforeModelErrorRecoveryCallback<P>): Unsubscribe {
    return addListener(this.#beforeModelErrorRecoveryListeners, callback);
  }

  /** 在 handler 执行或跳过后注册最终动作控制 hook。 */
  onAfterModelErrorRecovery(callback: AfterModelErrorRecoveryCallback<P>): Unsubscribe {
    return addListener(this.#afterModelErrorRecoveryListeners, callback);
  }

  @Tool({
    name: 'skill',
    description:
      '按名称渐进加载 Skill。省略 args 或使用 load 获取 instructions；使用 read <resource-id> 读取文本资源；使用 run <script-id> [args...] 运行已登记脚本。',
    parameters: z.object({
      skill: z.string(),
      args: z.string().optional(),
    }),
  })
  async #skillTool(parameters: unknown): Promise<unknown> {
    return this.#skillRegistry.dispatch(parameters as SkillToolInput);
  }

  @Tool({
    name: 'end-agent',
    description:
      '当你认为你已经彻底完成了用户交代的任务，并且不需要更多信息时，请调用这个工具。该工具必须在任务确定结束时单独调用，不能跟其他工具一起调用。',
  })
  #endAgent(): string {
    // loop 内先记录结束请求；只有 result/listener/compact 均成功后才提交 ended。
    this.#endRequested = true;
    return 'Agent 已结束。';
  }

  /**
   * 执行一个已解析的模型函数调用，并返回本地结果 item。
   *
   * 成功结果会先由 Model 构建并写入上下文，再触发 after listener，使 listener
   * 追加的消息排在对应工具结果之后。
   */
  async toolCall(
    callInfo: AgentToolCall<P>,
    options?: ToolCallExecutionOptions,
  ): Promise<ContextOf<P>> {
    this.#assertInitialized();
    const execution = createActiveAgentExecution(options);
    const standalone = !this.#contextStore.hasOpenLoopSpan;
    let record: ToolExecutionRecord<P>;

    try {
      throwIfAborted(execution.signal, execution.deadlineAt);
      record = await this.#executeToolCallWithRecord(callInfo, execution, {
        callIndex: 0,
        callCount: 1,
        isStandalone: true,
      });
    } catch (error) {
      if (standalone) {
        this.#endRequested = false;
      }
      throw error;
    } finally {
      execution.dispose();
    }

    // standalone toolCall 没有 loop compact 阶段；只等待其 awaited listeners 后提交结束。
    if (standalone && this.#endRequested) {
      this.#endRequested = false;
      this.#changeStatus('ended');
    }

    return record.resultMessage;
  }

  async #executeToolCallWithRecord(
    callInfo: AgentToolCall<P>,
    execution: ActiveAgentExecution,
    batch: ToolRuntimeContext<P>['batch'],
  ): Promise<ToolExecutionRecord<P>> {
    throwIfAborted(execution.signal, execution.deadlineAt);
    const tool = this.tools.find((candidate) => candidate.name === callInfo.name);
    const fallbackParameters: unknown = {};

    if (!tool) {
      const error = new Error(`Unknown tool: ${callInfo.name}`);
      await this.#emitToolCallError(callInfo.name, 'calling', error, fallbackParameters, callInfo);
      throwIfAborted(execution.signal, execution.deadlineAt);
      return this.#createToolExecutionRecord(callInfo, normalizeErrorMessage(error), true);
    }

    const compactResult =
      tool === this.#builtinSkillRuntimeDefinition ? this.#skillRuntime.compactResult : true;

    const parsedArguments = await this.#parseToolArguments(tool, callInfo);
    throwIfAborted(execution.signal, execution.deadlineAt);

    if (!parsedArguments.ok) {
      return this.#createToolExecutionRecord(callInfo, parsedArguments.message, compactResult);
    }

    const parameters = parsedArguments.parameters;
    const beforeResult = await this.#runBeforeToolListeners(
      tool.name,
      parameters,
      callInfo,
      execution.signal,
    );
    throwIfAborted(execution.signal, execution.deadlineAt);

    if (beforeResult.canceled) {
      return this.#createToolExecutionRecord(
        callInfo,
        `${beforeToolErrorPrefix}${normalizeErrorMessage(beforeResult.error)}`,
        compactResult,
      );
    }

    let result: unknown;
    const runtimeContext: ToolRuntimeContext<P> = Object.freeze({
      ...execution.runtime,
      call: callInfo,
      batch: Object.freeze({ ...batch }),
      signal: execution.signal,
      ...(execution.deadlineAt === undefined ? {} : { deadlineAt: execution.deadlineAt }),
    });

    try {
      const handlerArguments =
        tool.handler.length >= 2 ? [parameters, runtimeContext] : [parameters];
      result = await awaitWithAbort(
        Promise.resolve(Reflect.apply(tool.handler, tool, handlerArguments)),
        execution.signal,
      );
    } catch (error) {
      if (isAbortError(error, execution.signal)) {
        throwIfAborted(execution.signal, execution.deadlineAt);
        throw error;
      }

      await this.#emitToolCallError(tool.name, 'calling', error, parameters, callInfo);
      return this.#createToolExecutionRecord(callInfo, normalizeErrorMessage(error), compactResult);
    }

    throwIfAborted(execution.signal, execution.deadlineAt);

    const record = this.#createToolExecutionRecord(
      callInfo,
      serializeToolResult(result),
      compactResult,
    );

    await this.#runAfterToolListeners(tool.name, parameters, callInfo, result, execution.signal);
    throwIfAborted(execution.signal, execution.deadlineAt);

    return record;
  }

  /**
   * 启动 Agent 任务循环。
   *
   * 每轮先原样保存模型返回的协议消息，再执行 Model 反解析出的工具调用。
   * 只有内置 `end-agent` 工具把状态改为 `ended` 后任务才结束；当前版本
   * 尚不支持流式调用。
   */
  async agent(
    input: string | UserMessageOf<P>,
    streamOrOptions: boolean | AgentExecutionOptions = false,
  ): Promise<ContextOf<P>[]> {
    let shouldFailOnError = true;
    let execution: ActiveAgentExecution | undefined;

    try {
      this.#assertInitialized();
      const options = normalizeAgentExecutionOptions(streamOrOptions);

      if (this.#status === 'running') {
        shouldFailOnError = false;
        throw new Error('Agent is already running.');
      }

      if (options.stream) {
        throw new Error('Agent streaming is not supported in this version.');
      }

      execution = createActiveAgentExecution(options);
      throwIfAborted(execution.signal, execution.deadlineAt);

      this.#contextStore.appendStandalone(
        this.#llm.buildUserMessage(
          typeof input === 'string'
            ? {
                content: [{ type: 'text', text: input }],
              }
            : input,
        ),
        'user',
      );

      this.#changeStatus('running');

      for (
        let iteration = 0;
        this.#maxIterations === undefined || iteration < this.#maxIterations;
        iteration += 1
      ) {
        throwIfAborted(execution.signal, execution.deadlineAt);
        const initialRequest = await this.#runProactiveSummary(iteration, execution);
        const response = await this.#generateWithEmptyMessagesRetry(
          iteration,
          initialRequest,
          execution,
        );
        const records: ToolExecutionRecord<P>[] = [];
        let loopFinalized = false;

        this.#contextStore.openLoopSpan();
        this.#endRequested = false;
        this.#trackedToolListenerPromises = hasToolPayloadCompactor(this.#contextCompact)
          ? []
          : undefined;

        try {
          await this.#emitModelResponse(response.messages, execution.signal);

          // 模型消息可能带有提供方元数据，必须整批原样保存后再执行本地工具。
          for (const message of response.messages) {
            this.#contextStore.appendToOpenLoop(message);
          }

          const calls = [...this.#llm.parseToolCalls(response.messages)];
          for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
            records.push(
              await this.#executeToolCallWithRecord(
                calls[callIndex] as AgentToolCall<P>,
                execution,
                {
                  callIndex,
                  callCount: calls.length,
                  isStandalone: calls.length === 1,
                },
              ),
            );
          }

          if (records.length === 0 || !hasToolPayloadCompactor(this.#contextCompact)) {
            this.#contextStore.closeOpenLoopSpan();
          } else {
            await awaitWithAbort(
              Promise.all(this.#trackedToolListenerPromises ?? []),
              execution.signal,
            );
            throwIfAborted(execution.signal, execution.deadlineAt);
            const snapshot = this.#contextStore.snapshotOpenLoop();
            const rewritten = await rewriteOpenLoopToolPayloads({
              model: this.#llm,
              iteration,
              snapshot,
              records,
              compactors: this.#contextCompact,
              signal: execution.signal,
            });
            this.#contextStore.commitOpenLoopRewrite(snapshot, rewritten);
          }

          loopFinalized = true;
        } finally {
          this.#trackedToolListenerPromises = undefined;

          if (!loopFinalized) {
            this.#contextStore.abortOpenLoopSpan();
            this.#endRequested = false;
            records.length = 0;
          }
        }

        if (this.#endRequested) {
          this.#endRequested = false;
          this.#changeStatus('ended');
          return [...this.#contextStore.getActiveContext()];
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
    } finally {
      execution?.dispose();
    }
  }

  #assertUniqueToolNames(): void {
    // 显式 init 阶段统一做配置校验，运行时不在每轮请求重复扫描。
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
    // 子代理通过 static name 被模型选择，因此同一父代理内必须唯一。
    const seen = new Set<string>();

    for (const agent of this.subAgents) {
      if (seen.has(agent.name)) {
        throw new Error(`Duplicate sub-agent name: ${agent.name}`);
      }

      seen.add(agent.name);
    }
  }

  #assertInitialized(): void {
    // 直接调用 toolCall() 也需要初始化，因为运行时工具可能由外部数组追加。
    if (!this.#initialized) {
      throw new Error('Agent has not been initialized. Call init() before agent().');
    }
  }

  #buildContextForModel(): ContextOf<P>[] {
    // 框架协议提示词仅在请求模型时临时前置，不写入 context/history。
    const systemMessages = [
      internalEndAgentPrompt,
      this.#buildSkillPrompt(),
      ...this.#systemPrompts,
    ].map((content) => this.#llm.buildSystemMessage({ content }));

    return [...systemMessages, ...this.#contextStore.getActiveContext()];
  }

  #buildSkillPrompt(): string {
    const descriptors = this.#skillRegistry.getDescriptors();
    const skillList =
      descriptors.length === 0
        ? '当前没有可用 Skill，不要调用 skill 工具。'
        : renderSkillDiscoveryCatalog(descriptors);

    return [
      '框架 Skill 约束：首轮只披露 name 和 description。任务匹配时先调用 skill({ skill, args? })；省略 args 或使用 load 获取 instructions 和 manifest，再按 manifest 使用 read/run。不得猜测未登记的 resource 或 script id。',
      skillList,
    ].join('\n\n');
  }

  #buildToolsForModel(): ToolOf<P>[] {
    return this.tools.map((tool) => {
      // 动态 description 只能看到协议无关上下文，避免装饰器 API 绑定具体 Model。
      const toolContext: {
        name: string;
        parameters?: NonNullable<ToolRuntimeDefinition['parameters']>;
        strict?: boolean;
      } = {
        name: tool.name,
      };

      if (tool.parameters) {
        toolContext.parameters = tool.parameters;
      }

      if (tool.strict !== undefined) {
        toolContext.strict = tool.strict;
      }

      const description =
        typeof tool.description === 'function'
          ? tool.description({
              skills: this.#skillRegistry.getDescriptors(),
              subAgents: [
                ...this.subAgents,
              ] as unknown as readonly AgentConstructor<AgentProtocol>[],
              context: [...this.#contextStore.getActiveContext()],
              history: [...this.#contextStore.getRawHistory()],
              systemPrompts: [...this.#systemPrompts],
              tool: toolContext,
            })
          : tool.description;

      return this.#llm.buildToolMessage({
        name: tool.name,
        description,
        parameters: tool.parameters ?? getDefaultToolParametersSchema(),
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      });
    });
  }

  #buildAgentRequest(iteration: number, execution: ActiveAgentExecution): ModelGenerateRequest<P> {
    // 普通请求故意不写 purpose，保持旧自定义 Model 的 request 快照兼容。
    return {
      context: this.#buildContextForModel(),
      tools: this.#buildToolsForModel(),
      signal: execution.signal,
      ...(execution.deadlineAt === undefined ? {} : { deadlineAt: execution.deadlineAt }),
      runtime: Object.freeze({
        ...execution.runtime,
        iteration,
      }),
    };
  }

  async #runProactiveSummary(
    iteration: number,
    execution: ActiveAgentExecution,
  ): Promise<ModelGenerateRequest<P>> {
    const policy = this.#contextCompact.summary;
    const request = this.#buildAgentRequest(iteration, execution);

    if (!policy) {
      return request;
    }

    const storeSnapshot = this.#contextStore.getSummarySnapshot();
    const defaultSelection = this.#contextStore.getDefaultSummarySelection('trigger');
    const snapshot = createSummaryCompactSnapshot({
      storeSnapshot,
      cause: { type: 'trigger' },
      iteration,
      pendingRequest: request,
    });

    if (!(await awaitWithAbort(Promise.resolve(policy.trigger(snapshot)), execution.signal))) {
      return this.#contextStore.revision === storeSnapshot.revision
        ? request
        : this.#buildAgentRequest(iteration, execution);
    }

    const compacted = await this.#runSummaryTransaction(
      { type: 'trigger' },
      iteration,
      request,
      execution,
      storeSnapshot,
      defaultSelection,
      true,
    );

    return compacted || this.#contextStore.revision !== storeSnapshot.revision
      ? this.#buildAgentRequest(iteration, execution)
      : request;
  }

  async #runSummaryTransaction(
    cause: ContextCompactCause,
    iteration: number,
    pendingRequest: Readonly<ModelGenerateRequest<P>>,
    execution: ActiveAgentExecution,
    storeSnapshot?: ContextStoreSummarySnapshot<P>,
    defaultSelection?: ReturnType<ContextStore<P>['getDefaultSummarySelection']>,
    defaultSelectionCaptured = false,
  ): Promise<boolean> {
    const policy = this.#contextCompact.summary;

    if (!policy) {
      return false;
    }

    return runSummaryCompactTransaction({
      model: this.#llm,
      store: this.#contextStore,
      policy,
      cause,
      iteration,
      pendingRequest,
      ...(storeSnapshot === undefined ? {} : { storeSnapshot }),
      ...(defaultSelection === undefined ? {} : { defaultSelection }),
      defaultSelectionCaptured,
      generate: (summaryRequest) =>
        this.#generateWithRecovery('context-summary', () => summaryRequest, iteration, execution),
    });
  }

  async #generateWithEmptyMessagesRetry(
    iteration: number,
    initialRequest: ModelGenerateRequest<P>,
    execution: ActiveAgentExecution,
  ) {
    // “成功但 messages 为空”的 4 次尝试与模型异常 recovery ledger 相互独立。
    let lastResponseText = 'Model returned no messages.';

    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const response = await this.#generateWithRecovery(
        'agent',
        () => this.#buildAgentRequest(iteration, execution),
        iteration,
        execution,
        attempt === 0 ? initialRequest : undefined,
      );

      if (response.messages.length > 0) {
        return response;
      }

      lastResponseText = `Model returned no messages after ${attempt + 1} attempt(s).`;
    }

    throw new Error(lastResponseText);
  }

  async #generateWithRecovery(
    purpose: ModelGeneratePurpose,
    buildRequest: () => ModelGenerateRequest<P>,
    iteration: number,
    execution: ActiveAgentExecution,
    initialRequest?: ModelGenerateRequest<P>,
  ): Promise<ModelGenerateResult<P>> {
    let pendingInitialRequest = initialRequest;

    return generateWithModelErrorRecovery({
      model: this.#llm,
      purpose,
      buildRequest: () => {
        if (pendingInitialRequest !== undefined) {
          const request = pendingInitialRequest;
          pendingInitialRequest = undefined;
          return request;
        }

        return buildRequest();
      },
      limits: this.#modelErrorRecoveryLimits,
      getContextRevision: () => this.#contextStore.revision,
      beforeListeners: () => [...this.#beforeModelErrorRecoveryListeners],
      afterListeners: () => [...this.#afterModelErrorRecoveryListeners],
      matchHandler: (descriptor, requestPurpose) =>
        requestPurpose === 'agent' &&
        descriptor.kind === 'context_length_exceeded' &&
        this.#contextCompact.summary
          ? {
              id: 'core.context_compaction',
              kind: 'context_length_exceeded',
            }
          : undefined,
      runHandler: async (_match, handlerContext) => {
        const compacted = await this.#runSummaryTransaction(
          {
            type: 'context_length_exceeded',
            error: handlerContext.descriptor,
            cause: handlerContext.cause,
          },
          iteration,
          handlerContext.request,
          execution,
        );

        return { outcome: compacted ? 'succeeded' : 'unavailable' };
      },
    });
  }

  async #parseToolArguments(
    tool: ToolRuntimeDefinition,
    callInfo: AgentToolCall<P>,
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

    // 模型输出必须是 JSON 字符串；解析失败时把错误作为工具结果交回模型处理。
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

    // Zod 校验失败同样不终止 Agent，而是写入工具结果让模型自行修正参数。
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
    message: AgentToolCall<P>,
    signal?: AbortSignal,
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
        throwIfAborted(signal);
        const result = listener.callback(parameters, message);

        if (listener.options.await) {
          await awaitWithAbort(Promise.resolve(result), signal);
        } else {
          const tracked = Promise.resolve(result).catch(async (error: unknown) => {
            await this.#emitToolCallError(toolName, 'before', error, parameters, message);
          });

          this.#trackToolListener(tracked);
        }
      } catch (error) {
        if (isAbortError(error, signal)) {
          throwIfAborted(signal);
          throw error;
        }

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
    message: AgentToolCall<P>,
    result: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const listener of this.#afterToolListeners.filter((item) => item.toolName === toolName)) {
      try {
        throwIfAborted(signal);
        const callbackResult = listener.callback(parameters, message, result);

        if (listener.options.await) {
          await awaitWithAbort(Promise.resolve(callbackResult), signal);
        } else {
          const tracked = Promise.resolve(callbackResult).catch(async (error: unknown) => {
            await this.#emitToolCallError(toolName, 'after', error, parameters, message, result);
          });

          this.#trackToolListener(tracked);
        }
      } catch (error) {
        if (isAbortError(error, signal)) {
          throwIfAborted(signal);
          throw error;
        }

        // after listener 的失败可以被观察，但不能中断 Agent 主循环。
        await this.#emitToolCallError(toolName, 'after', error, parameters, message, result);
      }
    }
  }

  async #emitModelResponse(messages: readonly ContextOf<P>[], signal?: AbortSignal): Promise<void> {
    for (const listener of this.#modelResponseListeners) {
      try {
        await awaitWithAbort(Promise.resolve(listener(messages)), signal);
      } catch (error) {
        if (isAbortError(error, signal)) {
          throwIfAborted(signal);
          throw error;
        }

        // 模型响应 listener 仅用于观察，不应打断 Agent 主循环。
      }
    }
  }

  async #emitToolCallError(
    name: string,
    triggerType: 'before' | 'calling' | 'after',
    error: unknown,
    parameters: unknown,
    message: AgentToolCall<P>,
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

  #trackToolListener(listener: Promise<void>): void {
    if (this.#trackedToolListenerPromises) {
      this.#trackedToolListenerPromises.push(listener);
    } else {
      void listener;
    }
  }

  #appendToolMessage(message: ContextOf<P>): ContextOf<P> {
    if (this.#contextStore.hasOpenLoopSpan) {
      this.#contextStore.appendToOpenLoop(message);
    } else {
      this.#contextStore.appendStandalone(message, 'external');
    }

    return message;
  }

  #createToolExecutionRecord(
    call: AgentToolCall<P>,
    output: string,
    compactResult: boolean,
  ): ToolExecutionRecord<P> {
    const resultMessage = this.#appendToolMessage(this.#createToolMessage(call.id, output));

    return {
      call,
      resultMessage,
      originalInput: call.arguments,
      originalResult: output,
      compactResult,
    };
  }

  #createToolMessage(callId: string, output: string): ContextOf<P> {
    return this.#llm.buildToolCallOutputMessage({
      callId,
      output,
    });
  }

  #changeStatus(status: AgentStatus): void {
    if (this.#status === status) {
      return;
    }

    const previousStatus = this.#status;
    this.#status = status;

    if (previousStatus === 'running' && status !== 'running' && this.#skillConfigurationDirty) {
      this.#initialized = false;
    }

    for (const listener of this.#statusListeners.filter((item) => item.status === status)) {
      void Promise.resolve(
        listener.callback(
          [...this.#contextStore.getRawHistory()],
          [...this.#contextStore.getActiveContext()],
        ),
      ).catch(() => {
        // 状态 listener 仅用于观察，不应打断状态迁移。
      });
    }
  }
}

function addListener<TListener>(listeners: TListener[], listener: TListener): Unsubscribe {
  // 所有事件注册都返回轻量 unsubscribe，避免调用方持有内部数组引用。
  listeners.push(listener);

  return () => {
    const index = listeners.indexOf(listener);

    if (index >= 0) {
      listeners.splice(index, 1);
    }
  };
}

function normalizeAgentExecutionOptions(
  input: boolean | AgentExecutionOptions,
): ResolvedAgentExecutionOptions {
  if (typeof input === 'boolean') {
    return { stream: input };
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Agent execution options must be a non-null object or a stream boolean.');
  }

  if (input.stream !== undefined && typeof input.stream !== 'boolean') {
    throw new TypeError('Agent execution options.stream must be a boolean.');
  }

  return {
    stream: input.stream ?? false,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  };
}

function createActiveAgentExecution(
  options?: AgentExecutionOptions | ToolCallExecutionOptions,
): ActiveAgentExecution {
  if (
    options !== undefined &&
    (typeof options !== 'object' || options === null || Array.isArray(options))
  ) {
    throw new TypeError('Tool execution options must be a non-null object.');
  }

  if (options?.signal !== undefined && !isAbortSignal(options.signal)) {
    throw new TypeError('signal must be an AbortSignal.');
  }

  const runtime = normalizeRuntimeMetadata(options?.runtime);
  const abortScope = createAbortScope(options?.signal, options?.deadlineAt);

  return {
    signal: abortScope.signal,
    ...(options?.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
    ...(runtime === undefined ? {} : { runtime }),
    dispose: () => abortScope.dispose(),
  };
}

function normalizeRuntimeMetadata(
  input: AgentExecutionOptions['runtime'],
): AgentExecutionOptions['runtime'] {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('runtime metadata must be a non-null object.');
  }

  const normalized: { sessionId?: string; runId?: string; taskId?: string } = {};

  for (const key of ['sessionId', 'runId', 'taskId'] as const) {
    const value = input[key];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new TypeError(`runtime.${key} must be a non-empty string.`);
    }
    if (value !== undefined) normalized[key] = value;
  }

  return Object.freeze(normalized);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'aborted') === 'boolean' &&
    typeof Reflect.get(value, 'addEventListener') === 'function' &&
    typeof Reflect.get(value, 'removeEventListener') === 'function'
  );
}

function normalizeToolEventOptions(options?: ToolEventOptions): Required<ToolEventOptions> {
  // 默认 observer 不阻塞主流程，也不会因 before 异常取消真实工具调用。
  return {
    await: options?.await ?? false,
    errorCancel: options?.errorCancel ?? false,
  };
}

function serializeToolResult(result: unknown): string {
  // 工具 handler 可以返回对象；Agent 统一序列化为协议工具结果可传输的字符串。
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
  // 写入模型上下文的错误需要保持短文本，避免暴露多余堆栈。
  if (error instanceof Error) {
    return error.message;
  }

  return serializeToolResult(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getToolsStorage(agent: object): ToolRuntimeDefinition[] {
  // 若装饰器 initializer 尚未写入 symbol slot，则按需创建实例工具数组。
  const carrier = agent as ToolsStorageCarrier;

  carrier[toolsStorageKey] ??= [];

  return carrier[toolsStorageKey];
}

function setToolsStorage(agent: object, tools: ToolRuntimeDefinition[]): void {
  // 使用 symbol slot 避免用户声明同名 public 字段时覆盖装饰器注册结果。
  const carrier = agent as ToolsStorageCarrier;

  carrier[toolsStorageKey] = tools;
}

function formatSubAgentDescription(agent: AgentConstructor<AgentProtocol>, index: number): string {
  // 子代理描述只使用 static metadata，不需要实例化子代理读取工具定义。
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
  // 动态工具描述依赖运行时上下文，静态 toolsDefinition 中只能提示其为运行时生成。
  return [
    `    - 工具${index + 1}：${tool.name}`,
    `      描述：${typeof tool.description === 'function' ? '动态描述，运行时生成。' : tool.description}`,
  ].join('\n');
}

export {
  DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS,
  DEFAULT_MODEL_ERROR_RECOVERY_LIMITS,
  DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS,
  MODEL_ERROR_RECOVERY_TRACE_LIMIT,
  ModelErrorRecoveryError,
  Tool,
  detectSkillScriptExecutors,
};
export type * from './types';
