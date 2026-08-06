import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { ModelGeneratePurpose, ModelGenerateRequest, ModelGenerateResult } from '../llm/base';
import { toOpenAIToolParameters } from '../llm/openai-schema';
import {
  awaitWithAbort,
  createAbortScope,
  isAbortError,
  throwIfAborted,
  type AbortScope,
} from '../llm/base/abort';
import type {
  AgentResumeOptions,
  AgentRunError,
  AgentRunOptions,
  AgentRunOutcome,
  ToolRuntimeContext,
} from '../subagent/agent-run';
import { serializeAgentResultReceipt } from '../subagent/agent-result-receipt';
import type { ApprovalDecision, ApprovalRequest } from '../subagent/approval';
import type { SubAgentCatalogEntry } from '../subagent/catalog';
import type {
  AgentProtocolCheckpointCodec,
  DurableAgentModelOperationV1,
  EncodedAgentProtocolCheckpoint,
  SubAgentChildCheckpoint,
  SubAgentChildPendingBatchV1,
} from '../subagent/checkpoint';
import { SubAgentRuntimeError, type SubAgentErrorDescriptor } from '../subagent/errors';
import type { SubAgentDelegationPauseCall } from '../subagent/executor';
import {
  assertJsonValue,
  canonicalizeJson,
  parseJsonValue,
  type JsonValue,
} from '../subagent/json';
import { createModelSubAgentToolDefinition } from '../subagent/model-tool-schema';
import type {
  SubAgentExecutionOutcome,
  SubAgentFailureInput,
  SubAgentTaskResult,
} from '../subagent/result';
import type {
  ModelSubAgentRequest,
  SubAgentDelegationClient,
  SubAgentDispatcher,
  SubAgentRuntime,
  SubAgentTaskHandle,
} from '../subagent/runtime';
import type { StoredPendingToolBatch, StoredPendingToolCall } from '../subagent/state-store';
import type { RuntimeTaskCreateMutation } from '../subagent/state-controller';
import {
  beginCompactTransactionCheckpoint,
  completeCompactTransactionCheckpoint,
  completeSummaryCompactPlan,
  commitSummaryCompactCandidate,
  createSummaryCompactSnapshot,
  createCompactTransactionCheckpoint,
  hasToolPayloadCompactor,
  prepareSummaryCompactPlan,
  resolveContextCompactOptions,
  rewriteOpenLoopToolPayloads,
  runSummaryCompactTransaction,
  type DurableCompactTransaction,
  type PreparedSummaryCompactPlan,
  type ResolvedContextCompactOptions,
  type SummaryCompactCandidate,
  type ToolExecutionRecord,
} from './context-compact';
import { ContextStore } from './context-store';
import type { ContextStoreSummarySnapshot, OpenLoopSnapshot } from './context-store';
import { DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS } from './default-tool-payload-compactor';
import { getToolDefinitions, Tool } from './decorators';
import {
  DEFAULT_MODEL_ERROR_RECOVERY_LIMITS,
  generateWithModelErrorRecovery,
  MODEL_ERROR_RECOVERY_TRACE_LIMIT,
  ModelErrorRecoveryError,
  resolveModelErrorRecoveryLimits,
} from './model-error-recovery';
import { AgentRunCheckpointController, type AgentRunLease } from './run-controller';
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
import {
  createToolBatchPlan,
  executeToolBatchPlan,
  resumeToolBatchPlan,
  type OrderedToolBatchResult,
  type ToolBatchAgentCallOutcome,
  type ToolBatchToolAuthorizationOutcome,
} from './tool-batch';
import type {
  AfterModelErrorRecoveryCallback,
  AfterToolCallCallback,
  AgentErrorCallback,
  AgentOptions,
  AgentProtocol,
  AgentSubAgentRunOptions,
  AgentSubAgentRunOutcome,
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
  ToolParametersSchema,
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
  /** Host cancel/deadline signal that is not aborted merely because a root lease is released. */
  readonly placementSignal: AbortSignal;
  readonly runtime: Readonly<{
    sessionId: string;
    runId: string;
    taskId?: string;
  }>;
}

interface ResolvedAgentRunOptions extends AgentRunOptions {
  readonly stream: boolean;
}

interface AgentToolBatchLoopResult<P extends AgentProtocol> {
  readonly waitingApproval: boolean;
  readonly approvals: readonly ApprovalRequest[];
  readonly checkpoint: StoredPendingToolBatch;
  readonly records: readonly ToolExecutionRecord<P>[];
}

interface ActiveChildExecution<P extends AgentProtocol> {
  options: AgentSubAgentRunOptions<P>;
  modelIteration: number;
  modelOperation: DurableAgentModelOperationV1 | undefined;
  compactTransaction: DurableCompactTransaction | undefined;
  pendingBatch: StoredPendingToolBatch | undefined;
  result: JsonValue | undefined;
  resultCallId: string | undefined;
  resultOutputHash: string | undefined;
  resultSubmitted: boolean;
  endCallId: string | undefined;
  completed: boolean;
  pauseCheckpointRevision: number | undefined;
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
  #subAgentRuntime: SubAgentRuntime | undefined;
  #sessionId: string;
  #sameProcessCheckpointCodec = createSameProcessCheckpointCodec<P>();
  #runController: AgentRunCheckpointController<P> | undefined;
  #activeRunLease: AgentRunLease | undefined;
  #pendingRunId: string | undefined;
  #activePendingApprovals: readonly ApprovalRequest[] = Object.freeze([]);
  #activeModelOperation:
    | Readonly<{ operationId: string; iteration: number; purpose: ModelGeneratePurpose }>
    | undefined;
  #activeCompactTransaction: DurableCompactTransaction | undefined;
  #activeChildExecution: ActiveChildExecution<P> | undefined;
  #modelSubAgentRuntimeDefinition: ToolRuntimeDefinition<P> | undefined;
  #modelSubAgentCatalogRevision: number | undefined;
  #configurationHash: string | undefined;
  #contextCompactConfig: ContextCompactOptions<P> | undefined;
  #contextCompact: ResolvedContextCompactOptions<P> = {
    toolInput: { source: 'disabled' },
    toolResult: { source: 'disabled' },
  };
  #modelErrorRecoveryConfig: ModelErrorRecoveryOptions | undefined;
  #modelErrorRecoveryLimits: Readonly<ResolvedModelErrorRecoveryLimits> =
    resolveModelErrorRecoveryLimits();
  #initialized = false;
  #executionStarted = false;
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
  /** 当前类及其父类通过装饰器声明的静态工具定义。 */
  static get toolsDefinition(): readonly ToolDefinition[] {
    return getToolDefinitions(this);
  }

  /** 使用模型适配器及可选运行配置创建 Agent 实例。 */
  constructor(options: AgentOptions<P>) {
    this.#llm = options.llm;
    this.#subAgentRuntime = options.subAgentRuntime;
    this.#sessionId =
      options.sessionId ?? options.subAgentRuntime?.sessionId ?? createEphemeralId('session');
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
   * 修改 `tools` 或 Skills 后应重新调用本方法；重复调用只重新校验配置，
   * 不会清空历史或事件监听。
   */
  init(): this {
    if (this.#status === 'running') {
      throw new Error('Cannot initialize an Agent while it is running.');
    }

    this.#initialized = false;
    this.#assertUniqueToolNames();
    this.#assertToolApprovalConfiguration();
    assertNonEmptyIdentifier(this.#sessionId, 'sessionId');

    const childExecution = this.#activeChildExecution;
    if (childExecution !== undefined) {
      if (this.#subAgentRuntime !== undefined) {
        throw new Error('A child Agent must use its task-scoped delegation client only.');
      }
      if (
        childExecution.options.checkpointMode === 'durable' &&
        this.#llm.checkpointCodec === undefined
      ) {
        throw new Error('A durable child Agent requires Model.checkpointCodec.');
      }
      this.#refreshModelSubAgentRuntimeDefinition(true);
      this.#runController = undefined;
    } else if (this.#subAgentRuntime !== undefined) {
      if (!this.#subAgentRuntime.ready) {
        throw new Error('Agent requires a ready SubAgentRuntime. Await runtime.init() first.');
      }
      if (this.#subAgentRuntime.sessionId !== this.#sessionId) {
        throw new Error('Agent sessionId must match SubAgentRuntime.sessionId.');
      }
      this.#refreshModelSubAgentRuntimeDefinition(true);
      this.#runController = new AgentRunCheckpointController<P>({
        ownerSessionId: this.#sessionId,
        stateStore: this.#subAgentRuntime.stateStore,
        checkpointCodec: this.#llm.checkpointCodec ?? this.#sameProcessCheckpointCodec,
      });
    } else {
      this.#modelSubAgentRuntimeDefinition = undefined;
      this.#modelSubAgentCatalogRevision = undefined;
      this.#runController = undefined;
    }
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
    const configurationHash = this.#computeConfigurationHash();
    if (
      this.#pendingRunId !== undefined &&
      this.#configurationHash !== undefined &&
      configurationHash !== this.#configurationHash
    ) {
      throw checkpointMismatchError(
        'Agent configuration cannot change while a durable run is waiting for approval.',
      );
    }
    this.#configurationHash = configurationHash;
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
  async #endAgent(_parameters: unknown, runtime?: ToolRuntimeContext<P>): Promise<string> {
    const child = this.#activeChildExecution;
    if (child !== undefined) {
      if (!child.resultSubmitted || child.result === undefined) {
        throw new SubAgentRuntimeError({
          code: 'RESULT_REQUIRED',
          message: 'A child Agent must submit a typed agent-result before end-agent.',
          retryable: false,
        });
      }
      if (runtime === undefined || !runtime.batch.isStandalone) {
        throw new SubAgentRuntimeError({
          code: 'END_AGENT_MUST_BE_STANDALONE',
          message: 'end-agent must be the only Tool call in its provider batch.',
          retryable: false,
        });
      }
      if (child.endCallId !== undefined && child.endCallId !== runtime.call.id) {
        throw checkpointMismatchError('The child end-agent call identity changed before commit.');
      }
      child.endCallId = runtime.call.id;
    }
    // loop 内先记录结束请求；只有 result/listener/compact 均成功后才提交 ended。
    this.#endRequested = true;
    return 'Agent 已结束。';
  }

  #installChildResultTool(options: AgentSubAgentRunOptions<P>): void {
    if (this.tools.some(({ name }) => name === 'agent-result')) {
      throw new Error('The Tool name "agent-result" is reserved for child Agent execution.');
    }
    this.tools.push({
      name: 'agent-result',
      description:
        '提交符合当前子代理输出 schema 的最终结果。成功提交后只能在后续单独一轮调用 end-agent。',
      parameters: z.object({ result: options.outputSchema }),
      handler: async (parameters, runtime) => {
        const child = this.#activeChildExecution;
        if (child === undefined) {
          throw new Error('agent-result is available only inside a child Agent execution.');
        }
        if (child.resultSubmitted) {
          throw new SubAgentRuntimeError({
            code: 'RESULT_PHASE_CLOSED',
            message: 'The child result has already been submitted.',
            retryable: false,
          });
        }
        const candidate = (parameters as { readonly result: JsonValue }).result;
        assertJsonValue(candidate);
        const output = cloneJson(candidate);
        const receipt = await child.options.control.completion.submitResult(
          runtime.call.id,
          output,
        );
        child.result = output;
        child.resultCallId = runtime.call.id;
        child.resultOutputHash = receipt.outputHash;
        child.resultSubmitted = true;
        return Object.freeze({ ok: true, status: receipt.status, outputHash: receipt.outputHash });
      },
    });
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
    this.#executionStarted = true;
    const execution = createActiveAgentExecution(options, {
      sessionId: this.#sessionId,
      runId: createEphemeralId('tool-run'),
    });
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
    appendResult = true,
    deferredAfter?: Map<string, () => Promise<void>>,
  ): Promise<ToolExecutionRecord<P>> {
    throwIfAborted(execution.signal, execution.deadlineAt);
    const child = this.#activeChildExecution;
    if (child?.resultSubmitted === true && callInfo.name !== 'end-agent') {
      const error = new SubAgentRuntimeError({
        code: 'RESULT_PHASE_CLOSED',
        message: 'The child result phase is closed; only standalone end-agent is allowed.',
        retryable: false,
      });
      await this.#emitToolCallError(callInfo.name, 'calling', error, {}, callInfo);
      return this.#createToolExecutionRecord(
        callInfo,
        serializeToolResult(stableErrorEnvelope(error.descriptor)),
        true,
        appendResult,
      );
    }
    const tool = this.tools.find((candidate) => candidate.name === callInfo.name);
    const fallbackParameters: unknown = {};

    if (!tool) {
      const error = new Error(`Unknown tool: ${callInfo.name}`);
      await this.#emitToolCallError(callInfo.name, 'calling', error, fallbackParameters, callInfo);
      throwIfAborted(execution.signal, execution.deadlineAt);
      return this.#createToolExecutionRecord(
        callInfo,
        normalizeErrorMessage(error),
        true,
        appendResult,
      );
    }

    const compactResult =
      tool === this.#builtinSkillRuntimeDefinition ? this.#skillRuntime.compactResult : true;

    const parsedArguments = await this.#parseToolArguments(tool, callInfo);
    throwIfAborted(execution.signal, execution.deadlineAt);

    if (!parsedArguments.ok) {
      return this.#createToolExecutionRecord(
        callInfo,
        parsedArguments.message,
        compactResult,
        appendResult,
      );
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
        appendResult,
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
      return this.#createToolExecutionRecord(
        callInfo,
        normalizeErrorMessage(error),
        compactResult,
        appendResult,
      );
    }

    throwIfAborted(execution.signal, execution.deadlineAt);

    const record = this.#createToolExecutionRecord(
      callInfo,
      serializeToolResult(result),
      compactResult,
      appendResult,
    );

    const after = async (): Promise<void> => {
      await this.#runAfterToolListeners(tool.name, parameters, callInfo, result, execution.signal);
      throwIfAborted(execution.signal, execution.deadlineAt);
    };
    if (deferredAfter === undefined) await after();
    else deferredAfter.set(callInfo.id, after);

    return record;
  }

  async #executeProviderToolBatch(
    response: ModelGenerateResult<P>,
    iteration: number,
    execution: ActiveAgentExecution,
    batchId = createEphemeralId('batch'),
    recoveredCheckpoint?: StoredPendingToolBatch,
    decisions: readonly ApprovalDecision[] = [],
  ): Promise<AgentToolBatchLoopResult<P>> {
    const calls = [...this.#llm.parseToolCalls(response.messages)];
    const assistantMessage = this.#encodeAssistantBatch(response.messages);
    const plan = createToolBatchPlan({
      batchId,
      iteration,
      assistantMessage,
      calls,
      createdAt: recoveredCheckpoint?.createdAt ?? Date.now(),
    });
    if (recoveredCheckpoint === undefined) {
      await this.#applyPendingModelOperation(iteration, plan.initialCheckpoint);
    }
    const records: ToolExecutionRecord<P>[] = [];
    const recordsByCallId = new Map<string, ToolExecutionRecord<P>>();
    const deferredAfter = new Map<string, () => Promise<void>>();
    const handles = new Map<string, SubAgentTaskHandle>();
    const agentParameters = new Map<string, ModelSubAgentRequest>();
    const agentOutcomes = new Map<string, SubAgentExecutionOutcome>();
    const runtime = this.#subAgentRuntime;
    const dispatcher = this.#getSubAgentDispatcher();
    const childExecution = this.#activeChildExecution;
    const runController = this.#runController;
    const lease = this.#activeRunLease;
    const runId = execution.runtime.runId;

    const callbacks = {
      authorizeTool: async (
        call: AgentToolCall<P>,
        callCheckpoint: StoredPendingToolCall,
      ): Promise<ToolBatchToolAuthorizationOutcome> => {
        const tool = this.tools.find(({ name }) => name === call.name);
        if (tool?.approval === undefined) return { status: 'not_required' };
        if (childExecution === undefined) {
          throw new Error('An approval Tool cannot execute outside a child Agent.');
        }
        const expiresAt = createApprovalExpiry(tool.approval.expiresInMs);
        const checkpoint = this.#buildChildCheckpoint();
        const directive = await childExecution.options.control.authorizeTool(
          `${callCheckpoint.operationId}:approval:attempt:${childExecution.options.request.attempt}`,
          {
            callId: call.id,
            toolName: call.name,
            summary: tool.approval.summary,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          },
          checkpoint,
        );
        if (directive.type === 'approved') return { status: 'approved' };
        childExecution.pendingBatch = pendingBatchWithApproval(
          childExecution.pendingBatch!,
          callCheckpoint.order,
          directive.request.approvalId,
        );
        childExecution.pauseCheckpointRevision = directive.checkpointRevision;
        return {
          status: 'paused',
          approval: directive.request,
          checkpointRevision: directive.checkpointRevision,
        };
      },
      executeTool: async (call: AgentToolCall<P>): Promise<JsonValue> => {
        const record = await this.#executeToolCallWithRecord(
          call,
          execution,
          trustedBatchPosition(calls, call),
          false,
          deferredAfter,
        );
        recordsByCallId.set(call.id, record);
        return record.originalResult;
      },
      submitAgent: async (call: AgentToolCall<P>): Promise<ToolBatchAgentCallOutcome> => {
        if (childExecution?.resultSubmitted === true) {
          return stableAgentToolFailure({
            code: 'RESULT_PHASE_CLOSED',
            message: 'The child result phase is closed; further delegation is not allowed.',
            retryable: false,
          });
        }
        if (dispatcher === undefined || this.#modelSubAgentRuntimeDefinition === undefined) {
          return stableAgentToolFailure({
            code: 'EXECUTOR_UNAVAILABLE',
            message: 'The subagent runtime is unavailable.',
            retryable: true,
          });
        }
        const parsed = await this.#parseToolArguments(this.#modelSubAgentRuntimeDefinition, call);
        if (!parsed.ok) {
          return stableAgentToolFailure(
            { code: 'INVALID_INPUT', message: parsed.message, retryable: false },
            dispatcher,
          );
        }
        const request = parsed.parameters as ModelSubAgentRequest;
        assertJsonValue(request.input);
        agentParameters.set(call.id, request);
        const before = await this.#runBeforeToolListeners('agent', request, call, execution.signal);
        if (before.canceled) {
          return stableAgentToolFailure(
            {
              code: 'INTERNAL_ERROR',
              message: `${beforeToolErrorPrefix}${normalizeErrorMessage(before.error)}`,
              retryable: false,
            },
            dispatcher,
            request.subAgent,
          );
        }
        try {
          this.#assertModelProtocolCatalogCompatibility(dispatcher.getCatalogEntries());
          const dispatchContext = {
            ownerSessionId: execution.runtime.sessionId,
            runId,
            requestId: `provider:${iteration}:${call.id}`,
            ...(execution.runtime.taskId === undefined
              ? {}
              : { parentTaskId: execution.runtime.taskId }),
            parentContext: [...this.#contextStore.getActiveContext()],
            parentRawHistory: [...this.#contextStore.getRawHistory()],
            signal: execution.placementSignal,
            ...(execution.deadlineAt === undefined ? {} : { deadlineAt: execution.deadlineAt }),
          };
          if (
            runtime !== undefined &&
            runController !== undefined &&
            lease !== undefined &&
            childExecution === undefined
          ) {
            const staged = await runtime.stageTool(request, {
              ...dispatchContext,
              runOwnership: lease,
            });
            return {
              status: 'running',
              taskId: staged.taskId,
              ...(staged.taskMutation === undefined ? {} : { taskMutation: staged.taskMutation }),
              dispatch: async () => {
                const handle = await staged.dispatch();
                handles.set(handle.taskId, handle);
              },
            };
          }
          const handle = await dispatcher.submitTool(request, dispatchContext);
          handles.set(handle.taskId, handle);
          return { status: 'running', taskId: handle.taskId };
        } catch (error) {
          await this.#emitToolCallError('agent', 'calling', error, request, call);
          if (isStablePreCreateDispatchError(error)) {
            return stableAgentToolFailure(error.descriptor, dispatcher, request.subAgent);
          }
          throw error;
        }
      },
      resumeAgent: async (
        call: AgentToolCall<P>,
        callCheckpoint: StoredPendingToolCall,
      ): Promise<ToolBatchAgentCallOutcome> => {
        if (dispatcher === undefined || callCheckpoint.taskId === undefined) {
          throw new Error('A recovered agent Tool call requires its durable runtime task.');
        }
        // The original request was validated against the exact catalog snapshot used for that
        // provider turn. Recovery follows the persisted call/task identity; a later catalog
        // revision must not reinterpret or orphan the already-created child.
        const request = storedModelSubAgentRequest(callCheckpoint.input);
        agentParameters.set(call.id, request);
        const taskId = callCheckpoint.taskId;
        if (runtime !== undefined) {
          const taskDecisions = decisions.filter((decision) =>
            this.#pendingApprovalBelongsToCall(decision.approvalId, callCheckpoint),
          );
          const handle = await runtime.recover(this.#sessionId, taskId, {
            decisions: taskDecisions,
          });
          handles.set(handle.taskId, handle);
          return { status: 'running', taskId: handle.taskId };
        }
        if (callCheckpoint.status === 'paused') {
          if (!isSubAgentDelegationClient(dispatcher)) {
            throw recoveryUnsupportedError(
              'The child delegation client cannot resume a durable nested approval.',
            );
          }
          const handle = await dispatcher.resumeTool(taskId);
          handles.set(handle.taskId, handle);
          return { status: 'running', taskId: handle.taskId };
        }
        const handle = await dispatcher.submitTool(request, {
          ownerSessionId: execution.runtime.sessionId,
          runId,
          requestId: `provider:${iteration}:${call.id}`,
          parentTaskId: execution.runtime.taskId!,
          parentContext: [...this.#contextStore.getActiveContext()],
          parentRawHistory: [...this.#contextStore.getRawHistory()],
          signal: execution.placementSignal,
          ...(execution.deadlineAt === undefined ? {} : { deadlineAt: execution.deadlineAt }),
        });
        handles.set(handle.taskId, handle);
        return { status: 'running', taskId: handle.taskId };
      },
      observeAgent: async (
        call: AgentToolCall<P>,
        callCheckpoint: StoredPendingToolCall,
      ): Promise<ToolBatchAgentCallOutcome> => {
        if (dispatcher === undefined || callCheckpoint.taskId === undefined) {
          throw new Error('An active agent Tool call requires its runtime task handle.');
        }
        try {
          const handle =
            handles.get(callCheckpoint.taskId) ??
            (runtime === undefined
              ? undefined
              : await runtime.recover(this.#sessionId, callCheckpoint.taskId));
          if (handle === undefined) {
            throw recoveryUnsupportedError('The nested child task handle is no longer available.');
          }
          handles.set(handle.taskId, handle);
          const outcome = await handle.wait();
          agentOutcomes.set(call.id, outcome);
          return subAgentOutcomeToBatchOutcome(outcome);
        } catch (error) {
          await this.#emitToolCallError(
            'agent',
            'calling',
            error,
            agentParameters.get(call.id) ?? {},
            call,
          );
          throw error;
        }
      },
      reconcileAgent: async (
        _call: AgentToolCall<P>,
        callCheckpoint: StoredPendingToolCall,
      ): Promise<ToolBatchAgentCallOutcome> => {
        if (callCheckpoint.taskId === undefined) {
          throw new Error('An active agent Tool call requires its runtime task identity.');
        }
        const handle = handles.get(callCheckpoint.taskId);
        const snapshot =
          handle === undefined
            ? runtime === undefined
              ? undefined
              : await runtime.getTask(this.#sessionId, callCheckpoint.taskId)
            : await handle.snapshot();
        if (snapshot === undefined) {
          throw recoveryUnsupportedError('The nested child task is no longer available.');
        }
        if (
          snapshot.state === 'queued' ||
          snapshot.state === 'running' ||
          snapshot.state === 'result_submitted'
        ) {
          return { status: 'running', taskId: callCheckpoint.taskId };
        }
        const outcome =
          handle === undefined
            ? await runtime!.wait(this.#sessionId, callCheckpoint.taskId)
            : await handle.wait();
        agentOutcomes.set(callCheckpoint.callId, outcome);
        return subAgentOutcomeToBatchOutcome(outcome);
      },
      executeEndAgent: async (call: AgentToolCall<P>): Promise<JsonValue> => {
        const record = await this.#executeToolCallWithRecord(
          call,
          execution,
          trustedBatchPosition(calls, call),
          false,
          deferredAfter,
        );
        recordsByCallId.set(call.id, record);
        return record.originalResult;
      },
      applyResult: async (
        call: AgentToolCall<P>,
        result: OrderedToolBatchResult,
      ): Promise<void> => {
        const existing = recordsByCallId.get(call.id);
        const record =
          existing ??
          this.#createToolExecutionRecord(call, serializeJsonValue(result.output), true, false);
        this.#appendToolMessage(record.resultMessage);
        await deferredAfter.get(call.id)?.();
        const agentOutcome = agentOutcomes.get(call.id);
        const parameters = agentParameters.get(call.id);
        if (agentOutcome !== undefined && parameters !== undefined) {
          await this.#runAfterToolListeners(
            'agent',
            parameters,
            call,
            result.output,
            execution.signal,
          );
        }
        records.push(record);
      },
      checkpoint: async (
        checkpoint: StoredPendingToolBatch,
        approvals: readonly ApprovalRequest[],
        taskCreates: readonly RuntimeTaskCreateMutation[],
      ): Promise<void> => {
        if (childExecution !== undefined) {
          childExecution.pendingBatch = checkpoint;
          if (!childExecution.completed) await this.#commitChildCheckpoint();
          return;
        }
        if (runController === undefined || lease === undefined) return;
        const approvalOrder = new Map(
          checkpoint.calls.flatMap((pendingCall) =>
            (pendingCall.approvalIds ?? []).map(
              (approvalId) => [approvalId, pendingCall.order] as const,
            ),
          ),
        );
        const referencedApprovalIds = new Set(approvalOrder.keys());
        const effectiveApprovalById = new Map<string, ApprovalRequest>();
        for (const approval of [...this.#activePendingApprovals, ...approvals]) {
          if (referencedApprovalIds.has(approval.approvalId)) {
            effectiveApprovalById.set(approval.approvalId, approval);
          }
        }
        const effectiveApprovals = Object.freeze(
          [...effectiveApprovalById.values()].sort(
            (left, right) =>
              (approvalOrder.get(left.approvalId) ?? Number.MAX_SAFE_INTEGER) -
              (approvalOrder.get(right.approvalId) ?? Number.MAX_SAFE_INTEGER),
          ),
        );
        const update = {
          runId,
          contextStore: this.#contextStore,
          status:
            effectiveApprovals.length === 0 ? ('running' as const) : ('waiting_approval' as const),
          modelIteration: iteration,
          pendingBatch: checkpoint,
          pendingApprovals: effectiveApprovals,
          endRequested: checkpoint.endRequested,
        };
        if (taskCreates.length > 0) {
          await runController.commitWithTasks(update, lease, taskCreates);
        } else {
          await runController.checkpoint(update, lease);
        }
        this.#activePendingApprovals = effectiveApprovals;
      },
    } as const;

    const result =
      recoveredCheckpoint === undefined
        ? await executeToolBatchPlan(plan, callbacks)
        : await resumeToolBatchPlan(plan, recoveredCheckpoint, callbacks);
    return Object.freeze({
      waitingApproval: result.waitingApproval,
      approvals: result.approvals,
      checkpoint: result.checkpoint,
      records: Object.freeze(records),
    });
  }

  #encodeAssistantBatch(messages: readonly ContextOf<P>[]): EncodedAgentProtocolCheckpoint {
    const codec = this.#llm.checkpointCodec ?? this.#sameProcessCheckpointCodec;
    return Object.freeze({
      protocol: codec.protocol,
      codecVersion: codec.version,
      value: codec.encode(messages),
    });
  }

  #decodeAssistantBatch(checkpoint: EncodedAgentProtocolCheckpoint): readonly ContextOf<P>[] {
    const codec = this.#llm.checkpointCodec ?? this.#sameProcessCheckpointCodec;
    if (checkpoint.protocol !== codec.protocol || checkpoint.codecVersion !== codec.version) {
      throw new SubAgentRuntimeError({
        code: 'CHECKPOINT_VERSION_MISMATCH',
        message: 'The pending Tool batch protocol checkpoint is incompatible.',
        retryable: false,
      });
    }
    return Object.freeze([...codec.decode(checkpoint.value)]);
  }

  #releaseSameProcessCheckpointCodec(): void {
    if (this.#llm.checkpointCodec === undefined) {
      this.#sameProcessCheckpointCodec.release();
    }
  }

  #pendingApprovalBelongsToCall(approvalId: string, call: StoredPendingToolCall): boolean {
    return (
      call.approvalIds?.includes(approvalId) === true &&
      this.#activePendingApprovals.some((approval) => approval.approvalId === approvalId)
    );
  }

  async #readRunRevision(runId: string): Promise<number> {
    const stateStore = this.#subAgentRuntime?.stateStore;
    if (stateStore === undefined) return 0;
    return (await stateStore.loadRun(this.#sessionId, runId))?.revision ?? 0;
  }

  async #applyPendingModelOperation(
    modelIteration: number,
    pendingBatch?: StoredPendingToolBatch,
    compactTransaction?: DurableCompactTransaction,
  ): Promise<void> {
    const child = this.#activeChildExecution;
    if (child?.modelOperation !== undefined) {
      if (child.modelOperation.phase !== 'result_ready') {
        throw new Error('A child Model operation can be applied only after its result is durable.');
      }
      child.modelOperation = undefined;
      child.modelIteration = modelIteration;
      child.pendingBatch = pendingBatch;
      child.compactTransaction = compactTransaction;
      this.#activeCompactTransaction = compactTransaction;
      this.#activeModelOperation = undefined;
      await this.#commitChildCheckpoint();
      return;
    }
    const operation = this.#activeModelOperation;
    const controller = this.#runController;
    const lease = this.#activeRunLease;
    if (operation === undefined || controller === undefined || lease === undefined) return;
    const restored = await controller.applyModelOperation(
      {
        runId: lease.runId,
        operationId: operation.operationId,
        contextStore: this.#contextStore,
        status: 'running',
        modelIteration,
        ...(pendingBatch === undefined ? {} : { pendingBatch }),
        ...(compactTransaction === undefined ? {} : { compactTransaction }),
        pendingApprovals: [],
        endRequested: false,
      },
      lease,
    );
    this.#contextStore = restored.contextStore;
    this.#activeModelOperation = undefined;
    this.#activeCompactTransaction = compactTransaction;
  }

  #buildChildCheckpoint(): SubAgentChildCheckpoint {
    const child = this.#activeChildExecution;
    const codec = this.#llm.checkpointCodec;
    if (child === undefined || codec === undefined) {
      throw new Error('A durable child checkpoint requires an active child and protocol codec.');
    }
    const activeContext = this.#contextStore.getActiveContext();
    return Object.freeze({
      version: '1' as const,
      runnerId: child.options.runnerId,
      runnerVersion: child.options.runnerVersion,
      protocolContext: Object.freeze({
        protocol: codec.protocol,
        codecVersion: codec.version,
        value: codec.encode(activeContext),
      }),
      contextStore: this.#contextStore.exportCheckpoint(codec),
      modelIteration: child.modelIteration,
      maxIterations: this.#maxIterations ?? null,
      ...(child.modelOperation === undefined ? {} : { modelOperation: child.modelOperation }),
      ...(child.compactTransaction === undefined
        ? {}
        : { compactTransaction: child.compactTransaction }),
      ...(child.pendingBatch === undefined
        ? {}
        : { pendingBatch: childPendingBatchFromStored(child.pendingBatch) }),
      ...(child.resultSubmitted &&
      child.result !== undefined &&
      child.resultCallId !== undefined &&
      child.resultOutputHash !== undefined
        ? {
            resultSubmission: Object.freeze({
              version: '1' as const,
              callId: child.resultCallId,
              output: cloneJson(child.result),
              outputHash: child.resultOutputHash,
            }),
          }
        : {}),
    });
  }

  async #commitChildCheckpoint(): Promise<void> {
    const child = this.#activeChildExecution;
    if (child === undefined || child.options.checkpointMode === 'same_process' || child.completed) {
      return;
    }
    const checkpoint = this.#buildChildCheckpoint();
    const value = checkpoint as unknown as JsonValue;
    assertJsonValue(value);
    await child.options.control.commitCheckpoint(
      `child-checkpoint-${createHash('sha256')
        .update(canonicalizeJson(value), 'utf8')
        .digest('hex')}`,
      checkpoint,
    );
  }

  async #persistCompactTransaction(
    transaction: DurableCompactTransaction | undefined,
  ): Promise<void> {
    const child = this.#activeChildExecution;
    if (child !== undefined) {
      child.compactTransaction = transaction;
      await this.#commitChildCheckpoint();
      return;
    }
    const controller = this.#runController;
    const lease = this.#activeRunLease;
    if (controller === undefined || lease === undefined) {
      this.#activeCompactTransaction = transaction;
      return;
    }
    const restored = await controller.checkpoint(
      {
        runId: lease.runId,
        contextStore: this.#contextStore,
        status: 'running',
        pendingApprovals: [],
        compactTransaction: transaction ?? null,
      },
      lease,
    );
    this.#contextStore = restored.contextStore;
    this.#activeCompactTransaction = transaction;
  }

  async #consumeChildProviderBudget(
    operationId: string,
    purpose: ModelGeneratePurpose,
  ): Promise<void> {
    const child = this.#activeChildExecution;
    if (child === undefined) return;
    await child.options.control.consumeBudget(`provider-budget-${operationId}`, {
      turns: purpose === 'agent' ? 1 : 0,
      providerCalls: 1,
    });
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
    optionsInput?: AgentRunOptions,
  ): Promise<AgentRunOutcome<P>> {
    this.#assertInitialized();
    const configurationHash = this.#assertConfigurationIdentity();
    let options: ResolvedAgentRunOptions;
    try {
      options = normalizeAgentRunOptions(optionsInput);
    } catch (error) {
      this.#emitAgentError(toError(error));
      throw error;
    }

    if (this.#status === 'running') {
      const error = new Error('Agent is already running.');
      this.#emitAgentError(error);
      throw error;
    }
    if (this.#pendingRunId !== undefined) {
      const error = new Error(
        `Agent run ${this.#pendingRunId} is waiting for approval; call resumeRun() with that runId before starting a new run.`,
      );
      this.#emitAgentError(error);
      throw error;
    }
    if (options.stream) {
      const error = streamingUnsupportedError();
      this.#emitAgentError(error);
      throw error;
    }
    this.#executionStarted = true;

    const runId = createEphemeralId('run');
    let execution = createActiveAgentExecution(options, {
      sessionId: this.#sessionId,
      runId,
    });
    let lease: Awaited<ReturnType<AgentRunCheckpointController<P>['acquire']>> | undefined;

    try {
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

      if (this.#runController !== undefined) {
        const active = await this.#runController.beginCreate(
          {
            contextStore: this.#contextStore,
            runId,
            configurationHash,
            limits: this.#subAgentRuntime!.limits,
            ...(this.#maxIterations === undefined ? {} : { maxIterations: this.#maxIterations }),
          },
          { signal: execution.signal },
        );
        lease = active.lease;
        this.#contextStore = active.checkpoint.contextStore;
        this.#activeRunLease = lease;
        execution = Object.freeze({
          ...execution,
          signal: AbortSignal.any([execution.signal, lease.signal]),
        });
      }

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

          const batch = await this.#executeProviderToolBatch(response, iteration, execution);
          records.push(...batch.records);

          if (batch.waitingApproval) {
            loopFinalized = true;
            this.#activePendingApprovals = Object.freeze([...batch.approvals]);
            this.#pendingRunId = runId;
            this.#changeStatus('idle');
            return Object.freeze({
              status: 'waiting_approval',
              sessionId: this.#sessionId,
              runId,
              checkpointRevision: await this.#readRunRevision(runId),
              approvals: Object.freeze([...batch.approvals]),
            });
          }

          await this.#finalizeOpenLoop(
            iteration,
            execution,
            this.#selectToolCompactRecords(batch.checkpoint, iteration, records),
          );

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
          if (this.#runController !== undefined && lease !== undefined) {
            await this.#runController.checkpoint(
              {
                runId,
                contextStore: this.#contextStore,
                status: 'succeeded',
                modelIteration: iteration + 1,
                pendingBatch: null,
                pendingApprovals: [],
                endRequested: true,
              },
              lease,
            );
          }
          this.#changeStatus('ended');
          this.#releaseSameProcessCheckpointCodec();
          return Object.freeze({
            status: 'succeeded',
            sessionId: this.#sessionId,
            runId,
            context: Object.freeze([...this.#contextStore.getActiveContext()]),
          });
        }

        if (this.#runController !== undefined && lease !== undefined) {
          await this.#runController.checkpoint(
            {
              runId,
              contextStore: this.#contextStore,
              status: 'running',
              modelIteration: iteration + 1,
              pendingBatch: null,
              pendingApprovals: [],
              endRequested: false,
            },
            lease,
          );
        }
      }

      throw new Error(`Agent exceeded maxIterations: ${this.#maxIterations}.`);
    } catch (error) {
      return await this.#settleRootRunFailure(runId, error, execution, lease);
    } finally {
      await lease?.release();
      this.#activeRunLease = undefined;
      this.#activeCompactTransaction = undefined;
      execution.dispose();
    }
  }

  async #settleRootRunFailure(
    runId: string,
    error: unknown,
    execution: ActiveAgentExecution,
    lease: AgentRunLease | undefined,
  ): Promise<AgentRunOutcome<P>> {
    // Lease loss always wins over a concurrent caller abort. The stale owner may neither
    // terminalize the run nor propagate cancellation to descendants.
    if (lease?.signal.aborted === true) {
      return this.#rootRunLeaseLostOutcome(runId, lease);
    }

    const outcomeUnknown = isOutcomeUnknownError(error);
    const cancelled = !outcomeUnknown && execution.placementSignal.aborted;
    const safeError = toAgentRunError(error, cancelled);
    this.#emitAgentError(toError(error));

    const controller = this.#runController;
    if (controller !== undefined && lease !== undefined) {
      let terminal;
      try {
        terminal =
          cancelled && this.#subAgentRuntime !== undefined
            ? await controller.terminalizeWithTasks(
                {
                  runId,
                  contextStore: this.#contextStore,
                  status: 'cancelled',
                  error: safeError,
                  reason: 'The root Agent run was cancelled.',
                },
                lease,
              )
            : await controller.terminalize(
                {
                  runId,
                  contextStore: this.#contextStore,
                  status: cancelled ? 'cancelled' : 'failed',
                  error: safeError,
                },
                lease,
              );
      } catch (settlementError) {
        if (isRootRunLeaseLoss(settlementError, lease)) {
          return this.#rootRunLeaseLostOutcome(runId, lease, settlementError);
        }
        throw settlementError;
      }
      if (
        cancelled &&
        this.#subAgentRuntime !== undefined &&
        'cancellationOperationId' in terminal &&
        typeof terminal.cancellationOperationId === 'string'
      ) {
        try {
          await this.#subAgentRuntime.cancelRunDescendants(
            this.#sessionId,
            runId,
            lease,
            'The root Agent run was cancelled.',
            { operationId: terminal.cancellationOperationId },
          );
        } catch {
          // The root/task transaction is authoritative; adapter cancellation is best-effort.
        }
      }
      this.#contextStore = terminal.contextStore;
      this.#activeModelOperation = undefined;
      this.#activeCompactTransaction = undefined;
      this.#activePendingApprovals = Object.freeze([]);
      this.#pendingRunId = undefined;
      if (terminal.record.status === 'succeeded') {
        this.#changeStatus('ended');
        this.#releaseSameProcessCheckpointCodec();
        return succeededRunOutcome(this.#sessionId, runId, this.#contextStore.getActiveContext());
      }
      if (terminal.record.status !== 'cancelled' && terminal.record.status !== 'failed') {
        throw checkpointMismatchError('Root terminalization did not persist a terminal status.');
      }
      this.#changeStatus('failed');
      this.#releaseSameProcessCheckpointCodec();
      return Object.freeze({
        status: terminal.record.status,
        sessionId: this.#sessionId,
        runId,
        error: Object.freeze({ ...(terminal.record.error ?? safeError) }),
        context: Object.freeze([...this.#contextStore.getActiveContext()]),
      });
    }

    this.#changeStatus('failed');
    this.#releaseSameProcessCheckpointCodec();
    return Object.freeze({
      status: cancelled ? 'cancelled' : 'failed',
      sessionId: this.#sessionId,
      runId,
      error: safeError,
      context: Object.freeze([...this.#contextStore.getActiveContext()]),
    });
  }

  #rootRunLeaseLostOutcome(
    runId: string,
    lease: AgentRunLease,
    cause?: unknown,
  ): AgentRunOutcome<P> {
    const ownershipError = rootRunLeaseLostError(lease, cause);
    this.#changeStatus('failed');
    this.#emitAgentError(ownershipError);
    return Object.freeze({
      status: 'failed',
      sessionId: this.#sessionId,
      runId,
      error: toAgentRunError(ownershipError, false),
      context: Object.freeze([...this.#contextStore.getActiveContext()]),
    });
  }

  /** Trusted Executor bridge for one isolated child task execution or approval resume. */
  async runAsSubAgent(optionsInput: AgentSubAgentRunOptions<P>): Promise<AgentSubAgentRunOutcome> {
    const options = normalizeAgentSubAgentRunOptions(optionsInput);
    if (this.#status === 'running') throw new Error('Agent is already running.');
    if (this.#subAgentRuntime !== undefined) {
      throw new Error('A child Agent cannot be configured with a root SubAgentRuntime.');
    }
    if (
      options.checkpointMode === 'same_process' &&
      (options.request.checkpoint !== undefined ||
        !isSameProcessOnlyDispatcher(options.control.delegation))
    ) {
      throw recoveryUnsupportedError(
        'A no-codec child is limited to non-durable same-process execution without approval.',
      );
    }

    const existing = this.#activeChildExecution;
    if (existing === undefined) {
      if (this.#initialized || this.#executionStarted || this.#status !== 'idle') {
        throw new Error('runAsSubAgent() requires a fresh, not-yet-initialized Agent instance.');
      }
      this.#executionStarted = true;
      this.#activeChildExecution = {
        options,
        modelIteration: 0,
        modelOperation: undefined,
        compactTransaction: undefined,
        pendingBatch: undefined,
        result: undefined,
        resultCallId: undefined,
        resultOutputHash: undefined,
        resultSubmitted: false,
        endCallId: undefined,
        completed: false,
        pauseCheckpointRevision: undefined,
      };
      this.#installChildResultTool(options);
    } else {
      assertChildRebind(existing.options, options);
      if (existing.completed) {
        throw new SubAgentRuntimeError({
          code: 'INVALID_STATE_TRANSITION',
          message: 'A completed child Agent cannot be run again.',
          retryable: false,
        });
      }
      existing.options = options;
      existing.pauseCheckpointRevision = undefined;
    }

    this.#sessionId = options.request.ownerSessionId;
    this.init();
    const execution = createActiveAgentExecution(
      {
        signal: AbortSignal.any([options.request.signal, options.control.signal]),
        deadlineAt: Math.min(options.request.deadlineAt, options.control.deadlineAt),
      },
      {
        sessionId: options.request.ownerSessionId,
        runId: options.request.runId,
        taskId: options.request.taskId,
      },
    );

    try {
      throwIfAborted(execution.signal, execution.deadlineAt);
      await this.#prepareChildExecution(options);
      this.#changeStatus('running');
      const child = this.#activeChildExecution!;
      let iteration = child.modelIteration;
      const response = await this.#recoverChildModelOperation(iteration, execution);
      if (response === undefined && child.compactTransaction !== undefined) {
        const compactRecovery = await this.#recoverChildCompactTransaction(iteration, execution);
        if (compactRecovery.outcome !== undefined) return compactRecovery.outcome;
        iteration = compactRecovery.iteration;
      }

      if (response !== undefined) {
        this.#contextStore.openLoopSpan();
        this.#trackedToolListenerPromises = hasToolPayloadCompactor(this.#contextCompact)
          ? []
          : undefined;
        await this.#emitModelResponse(response.messages, execution.signal);
        for (const message of response.messages) this.#contextStore.appendToOpenLoop(message);
        const batch = await this.#executeProviderToolBatch(response, iteration, execution);
        const outcome = await this.#finishChildBatch(iteration, execution, batch);
        if (outcome !== undefined) return outcome;
        iteration += 1;
      } else if (child.pendingBatch !== undefined) {
        const messages = this.#decodeAssistantBatch(child.pendingBatch.assistantMessage);
        const batch = await this.#executeProviderToolBatch(
          { messages },
          iteration,
          execution,
          child.pendingBatch.batchId,
          child.pendingBatch,
        );
        const outcome = await this.#finishChildBatch(iteration, execution, batch);
        if (outcome !== undefined) return outcome;
        iteration += 1;
      }

      return await this.#continueChildIterations(iteration, execution);
    } catch (error) {
      this.#changeStatus('failed');
      this.#emitAgentError(toError(error));
      const normalized = normalizeChildExecutionError(error, execution.signal);
      const child = this.#activeChildExecution!;
      try {
        const result = await child.options.control.completion.fail(
          childFailureCallId(child),
          childFailureInput(normalized, child),
        );
        child.completed = true;
        return Object.freeze({ type: 'terminal' as const, result });
      } catch {
        // The runtime's Executor error finalizer remains the fallback when this execution no
        // longer owns the task or its cancellation signal prevents the authoritative failure CAS.
        throw normalized;
      }
    } finally {
      this.#trackedToolListenerPromises = undefined;
      this.#activeModelOperation = undefined;
      if (this.#activeChildExecution?.completed === true) {
        this.#releaseSameProcessCheckpointCodec();
      }
      execution.dispose();
    }
  }

  async #recoverChildCompactTransaction(
    iteration: number,
    execution: ActiveAgentExecution,
  ): Promise<{
    readonly iteration: number;
    readonly outcome?: AgentSubAgentRunOutcome;
  }> {
    const child = this.#activeChildExecution!;
    const transaction = child.compactTransaction!;
    if (transaction.phase === 'in_flight') {
      throw new SubAgentRuntimeError({
        code: 'EXECUTOR_FAILED',
        message: 'The child compact operation outcome could not be confirmed.',
        retryable: false,
        causeCode: 'COMPACT_OUTCOME_UNKNOWN',
        outcomeUnknown: true,
      });
    }
    if (transaction.phase === 'applied') {
      await this.#persistCompactTransaction(undefined);
    } else if (transaction.kind === 'summary') {
      if (transaction.phase === 'prepared') {
        const summary = await this.#rebuildDurableSummaryPlan(transaction, iteration, execution);
        await this.#executeDurableSummaryPlan(
          summary.cause,
          iteration,
          summary.plan,
          execution,
          requireCompactTransaction(transaction, 'summary', 'prepared'),
        );
      } else {
        await this.#applyDurableSummaryResult(
          requireCompactTransaction(transaction, 'summary', 'result_ready'),
        );
      }
      return Object.freeze({ iteration });
    } else if (transaction.phase === 'prepared') {
      const rebuilt = this.#rebuildDurableToolPayloadCompact(
        transaction,
        child.pendingBatch,
        iteration,
      );
      await this.#executeDurableToolPayloadCompact(
        iteration,
        rebuilt.snapshot,
        rebuilt.records,
        execution,
        requireCompactTransaction(transaction, 'tool_payload', 'prepared'),
      );
    } else {
      await this.#applyDurableToolPayloadResult(
        requireCompactTransaction(transaction, 'tool_payload', 'result_ready'),
      );
    }

    if (transaction.kind === 'summary') return Object.freeze({ iteration });
    const endRequested = child.pendingBatch?.endRequested === true;
    child.modelIteration = iteration + 1;
    if (endRequested) {
      if (!child.resultSubmitted || child.result === undefined) {
        throw new SubAgentRuntimeError({
          code: 'RESULT_REQUIRED',
          message: 'The recovered child completed without an authoritative typed result.',
          retryable: false,
        });
      }
      await this.#commitChildCompletion();
      child.pendingBatch = undefined;
      this.#changeStatus('ended');
      return Object.freeze({
        iteration: iteration + 1,
        outcome: childSucceededOutcome(child.options, child.result),
      });
    }
    child.pendingBatch = undefined;
    await this.#commitChildCheckpoint();
    return Object.freeze({ iteration: iteration + 1 });
  }

  async #prepareChildExecution(options: AgentSubAgentRunOptions<P>): Promise<void> {
    const child = this.#activeChildExecution!;
    const checkpoint = options.request.checkpoint;
    if (checkpoint === undefined) {
      if (options.request.attempt !== 1) {
        throw new SubAgentRuntimeError({
          code: 'CHECKPOINT_VERSION_MISMATCH',
          message: 'A resumed child attempt requires its durable checkpoint.',
          retryable: false,
        });
      }
      this.#contextStore.appendStandalone(
        this.#llm.buildUserMessage(
          typeof options.input === 'string'
            ? { content: [{ type: 'text', text: options.input }] }
            : options.input,
        ),
        'user',
      );
      child.modelIteration = 0;
      await this.#commitChildCheckpoint();
      return;
    }
    await this.#restoreChildCheckpoint(checkpoint);
  }

  async #restoreChildCheckpoint(checkpoint: SubAgentChildCheckpoint): Promise<void> {
    const child = this.#activeChildExecution!;
    const { options } = child;
    const codec = this.#llm.checkpointCodec;
    if (
      checkpoint.version !== '1' ||
      checkpoint.runnerId !== options.runnerId ||
      checkpoint.runnerVersion !== options.runnerVersion
    ) {
      throw checkpointMismatchError('The child checkpoint runner identity is incompatible.');
    }
    if (
      codec === undefined ||
      checkpoint.protocolContext.protocol !== codec.protocol ||
      checkpoint.protocolContext.codecVersion !== codec.version ||
      checkpoint.contextStore.protocol !== codec.protocol ||
      checkpoint.contextStore.codecVersion !== codec.version
    ) {
      throw checkpointMismatchError('The child checkpoint protocol codec is incompatible.');
    }
    const configuredMaxIterations = this.#maxIterations ?? null;
    if (checkpoint.maxIterations !== configuredMaxIterations) {
      throw checkpointMismatchError('The child checkpoint maxIterations value is incompatible.');
    }
    const restored = ContextStore.restoreCheckpoint(checkpoint.contextStore, codec);
    if (
      canonicalizeJson(codec.encode(restored.getActiveContext())) !==
      canonicalizeJson(checkpoint.protocolContext.value)
    ) {
      throw checkpointMismatchError(
        'The child protocol context does not match ContextStore state.',
      );
    }
    this.#contextStore = restored;
    child.modelIteration = checkpoint.modelIteration;
    child.modelOperation = checkpoint.modelOperation;
    child.compactTransaction = checkpoint.compactTransaction;
    child.pendingBatch =
      checkpoint.pendingBatch === undefined
        ? undefined
        : storedPendingBatchFromChild(checkpoint.pendingBatch, checkpoint.modelIteration);
    child.result = undefined;
    child.resultCallId = undefined;
    child.resultOutputHash = undefined;
    child.resultSubmitted = false;
    child.endCallId = child.pendingBatch?.endRequested
      ? requireStandaloneChildEndCall(child.pendingBatch).callId
      : undefined;
    child.completed = false;

    const submission = checkpoint.resultSubmission;
    if (submission !== undefined) {
      const parsed = options.outputSchema.safeParse(submission.output);
      if (
        submission.version !== '1' ||
        typeof submission.callId !== 'string' ||
        submission.callId.length === 0 ||
        !/^[0-9a-f]{64}$/u.test(submission.outputHash) ||
        !parsed.success
      ) {
        throw checkpointMismatchError('The child result submission checkpoint is invalid.');
      }
      assertJsonValue(parsed.data);
      const output = cloneJson(parsed.data as JsonValue);
      if (hashJson(output) !== submission.outputHash) {
        throw checkpointMismatchError('The child result submission hash is invalid.');
      }
      const replay = await options.control.completion.submitResult(submission.callId, output);
      if (replay.status !== 'replayed' || replay.outputHash !== submission.outputHash) {
        throw checkpointMismatchError('The child result checkpoint does not match task state.');
      }
      if (child.pendingBatch !== undefined) {
        child.pendingBatch = projectAuthoritativeResultSubmission(
          child.pendingBatch,
          submission,
          replay.status,
        );
      }
      child.result = output;
      child.resultCallId = submission.callId;
      child.resultOutputHash = submission.outputHash;
      child.resultSubmitted = true;
    }
  }

  async #recoverChildModelOperation(
    iteration: number,
    execution: ActiveAgentExecution,
  ): Promise<ModelGenerateResult<P> | undefined> {
    const child = this.#activeChildExecution!;
    const operation = child.modelOperation;
    if (operation === undefined) return undefined;
    if (operation.phase === 'in_flight') {
      throw new SubAgentRuntimeError({
        code: 'EXECUTOR_FAILED',
        message: 'The child provider request outcome could not be confirmed.',
        retryable: false,
        causeCode: 'MODEL_OUTCOME_UNKNOWN',
        outcomeUnknown: true,
      });
    }
    const codec = this.#llm.checkpointCodec!;
    const summary =
      operation.purpose === 'context-summary'
        ? await this.#rebuildDurableSummaryPlan(
            requireCompactTransaction(child.compactTransaction, 'summary', 'in_flight'),
            iteration,
            execution,
          )
        : undefined;
    if (operation.phase === 'result_ready') {
      const response = { messages: codec.decode(operation.result!.value) };
      if (summary === undefined) return response;
      this.#activeModelOperation = Object.freeze({
        operationId: operation.operationId,
        iteration,
        purpose: operation.purpose,
      });
      const transaction = requireCompactTransaction(
        child.compactTransaction,
        'summary',
        'in_flight',
      );
      const candidate = await completeSummaryCompactPlan({
        model: this.#llm,
        policy: this.#contextCompact.summary!,
        plan: summary.plan,
        response,
      });
      await this.#completeDurableSummaryCandidate(transaction, candidate, iteration);
      return undefined;
    }

    const request = summary?.plan.request ?? this.#buildAgentRequest(iteration, execution);
    const response = await this.#generateWithRecovery(
      operation.purpose,
      () => request,
      iteration,
      execution,
      request,
      operation,
    );
    if (summary !== undefined) {
      const transaction = requireCompactTransaction(
        child.compactTransaction,
        'summary',
        'in_flight',
      );
      const candidate = await completeSummaryCompactPlan({
        model: this.#llm,
        policy: this.#contextCompact.summary!,
        plan: summary.plan,
        response,
      });
      await this.#completeDurableSummaryCandidate(transaction, candidate, iteration);
      return undefined;
    }
    return response;
  }

  async #continueChildIterations(
    startIteration: number,
    execution: ActiveAgentExecution,
  ): Promise<AgentSubAgentRunOutcome> {
    for (
      let iteration = startIteration;
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
      let preserveOpenLoop = false;
      this.#contextStore.openLoopSpan();
      this.#endRequested = false;
      this.#trackedToolListenerPromises = hasToolPayloadCompactor(this.#contextCompact)
        ? []
        : undefined;
      try {
        await this.#emitModelResponse(response.messages, execution.signal);
        for (const message of response.messages) this.#contextStore.appendToOpenLoop(message);
        const batch = await this.#executeProviderToolBatch(response, iteration, execution);
        const outcome = await this.#finishChildBatch(iteration, execution, batch);
        preserveOpenLoop = outcome?.type === 'paused';
        if (outcome !== undefined) return outcome;
      } finally {
        this.#trackedToolListenerPromises = undefined;
        if (!preserveOpenLoop && this.#contextStore.hasOpenLoopSpan) {
          this.#contextStore.abortOpenLoopSpan();
          this.#endRequested = false;
        }
      }
    }
    throw new SubAgentRuntimeError({
      code: 'LIMIT_EXCEEDED',
      message: `Child Agent exceeded maxIterations: ${this.#maxIterations}.`,
      retryable: false,
    });
  }

  async #finishChildBatch(
    iteration: number,
    execution: ActiveAgentExecution,
    batch: AgentToolBatchLoopResult<P>,
  ): Promise<AgentSubAgentRunOutcome | undefined> {
    const child = this.#activeChildExecution!;
    child.pendingBatch = batch.checkpoint;
    if (batch.waitingApproval) {
      if (child.pauseCheckpointRevision === undefined) {
        const calls = delegationPauseCalls(batch.checkpoint, batch.approvals);
        const checkpoint = this.#buildChildCheckpoint();
        const operationIdentity: JsonValue = Object.freeze({
          version: '1',
          batchId: batch.checkpoint.batchId,
          calls: Object.freeze(
            calls.map((call) =>
              Object.freeze({
                callId: call.callId,
                childTaskId: call.childTaskId,
                approvalIds: Object.freeze(call.approvals.map(({ approvalId }) => approvalId)),
              }),
            ),
          ),
        });
        const receipt = await child.options.control.pauseDelegation(
          `delegation-pause-${hashJson(operationIdentity)}`,
          { checkpoint, calls },
        );
        child.pauseCheckpointRevision = receipt.checkpointRevision;
        this.#changeStatus('idle');
        return Object.freeze({
          type: 'paused' as const,
          reason: 'approval' as const,
          task: childTaskIdentity(child.options),
          approvals: Object.freeze([...receipt.approvals]),
          checkpointRevision: receipt.checkpointRevision,
        });
      }
      this.#changeStatus('idle');
      return Object.freeze({
        type: 'paused' as const,
        reason: 'approval' as const,
        task: childTaskIdentity(child.options),
        approvals: Object.freeze([...batch.approvals]),
        checkpointRevision: child.pauseCheckpointRevision,
      });
    }
    const compactRecords = this.#selectToolCompactRecords(
      batch.checkpoint,
      iteration,
      batch.records,
    );
    await this.#finalizeOpenLoop(iteration, execution, compactRecords);
    this.#endRequested = batch.checkpoint.endRequested;
    child.modelIteration = iteration + 1;
    if (this.#endRequested) {
      if (!child.resultSubmitted || child.result === undefined) {
        throw new SubAgentRuntimeError({
          code: 'RESULT_REQUIRED',
          message: 'The child completed without an authoritative typed result.',
          retryable: false,
        });
      }
      await this.#commitChildCompletion();
      child.pendingBatch = undefined;
      this.#endRequested = false;
      this.#changeStatus('ended');
      return childSucceededOutcome(child.options, child.result);
    }
    child.pendingBatch = undefined;
    await this.#commitChildCheckpoint();
    return undefined;
  }

  async #commitChildCompletion(): Promise<void> {
    const child = this.#activeChildExecution!;
    const call = requireStandaloneChildEndCall(child.pendingBatch);
    if (child.endCallId !== undefined && child.endCallId !== call.callId) {
      throw checkpointMismatchError('The durable child end-agent call identity is incompatible.');
    }
    child.endCallId = call.callId;
    await child.options.control.completion.complete(call.callId, { isStandalone: true });
    child.completed = true;
  }

  async resumeRun(optionsInput: AgentResumeOptions): Promise<AgentRunOutcome<P>> {
    this.#assertInitialized();
    const configurationHash = this.#assertConfigurationIdentity();
    const options = normalizeAgentResumeOptions(optionsInput);
    if (this.#status === 'running') throw new Error('Agent is already running.');
    if (this.#pendingRunId !== undefined && this.#pendingRunId !== options.runId) {
      throw new Error(
        `Agent run ${this.#pendingRunId} is waiting for approval; resumeRun() must use that runId.`,
      );
    }
    const controller = this.#runController;
    if (controller === undefined || this.#subAgentRuntime === undefined) {
      throw new Error('resumeRun() requires a durable SubAgentRuntime.');
    }
    if (this.#llm.checkpointCodec === undefined) {
      const stored = await this.#subAgentRuntime.stateStore.loadRun(this.#sessionId, options.runId);
      if (
        stored?.status === 'succeeded' ||
        stored?.status === 'cancelled' ||
        stored?.status === 'failed'
      ) {
        throw new SubAgentRuntimeError({
          code: 'INVALID_STATE_TRANSITION',
          message: 'A terminal Agent run cannot be resumed.',
          retryable: false,
        });
      }
    }

    let execution = createActiveAgentExecution(options, {
      sessionId: this.#sessionId,
      runId: options.runId,
    });
    let lease: AgentRunLease | undefined;
    let started = false;

    try {
      const active = await controller.beginResume(options.runId, { signal: execution.signal });
      lease = active.lease;
      const { record, recovery } = active.checkpoint;
      if (
        record.maxIterations !== (this.#maxIterations ?? null) ||
        record.configurationHash !== configurationHash ||
        canonicalizeJson(record.limits) !== canonicalizeJson(this.#subAgentRuntime.limits)
      ) {
        throw checkpointMismatchError(
          'The persisted Agent run configuration does not match this Agent instance.',
        );
      }
      this.#activeRunLease = lease;
      this.#contextStore = active.checkpoint.contextStore;
      this.#activePendingApprovals = active.checkpoint.record.pendingApprovals;
      execution = Object.freeze({
        ...execution,
        signal: AbortSignal.any([execution.signal, lease.signal]),
      });
      this.#activeCompactTransaction = record.compactTransaction;
      if (recovery.action === 'fail_model_outcome_unknown') {
        this.#pendingRunId = undefined;
        this.#changeStatus('failed');
        this.#releaseSameProcessCheckpointCodec();
        return failedRunOutcome(
          this.#sessionId,
          options.runId,
          record.error ?? recovery.error,
          this.#contextStore.getActiveContext(),
        );
      }
      if (
        record.status === 'succeeded' ||
        record.status === 'cancelled' ||
        record.status === 'failed'
      ) {
        throw new SubAgentRuntimeError({
          code: 'INVALID_STATE_TRANSITION',
          message: 'A terminal Agent run cannot be resumed.',
          retryable: false,
        });
      }

      this.#changeStatus('running');
      started = true;
      let response: ModelGenerateResult<P> | undefined;
      let iteration = record.modelIteration;
      let compactedRecoveredBatch = false;

      if (recovery.action === 'execute_model') {
        const summary =
          recovery.operation.purpose === 'context-summary'
            ? await this.#rebuildDurableSummaryPlan(
                requireCompactTransaction(record.compactTransaction, 'summary', 'in_flight'),
                iteration,
                execution,
              )
            : undefined;
        const request = summary?.plan.request ?? this.#buildAgentRequest(iteration, execution);
        response = await this.#generateWithRecovery(
          recovery.operation.purpose,
          () => request,
          iteration,
          execution,
          request,
          recovery.operation,
        );
        if (summary !== undefined) {
          const transaction = requireCompactTransaction(
            record.compactTransaction,
            'summary',
            'in_flight',
          );
          const candidate = await completeSummaryCompactPlan({
            model: this.#llm,
            policy: this.#contextCompact.summary!,
            plan: summary.plan,
            response,
          });
          await this.#completeDurableSummaryCandidate(transaction, candidate, iteration);
          response = undefined;
        }
      } else if (recovery.action === 'apply_model') {
        response = { messages: recovery.messages };
        this.#activeModelOperation = Object.freeze({
          operationId: recovery.operation.operationId,
          iteration,
          purpose: recovery.operation.purpose,
        });
        if (recovery.operation.purpose === 'context-summary') {
          const transaction = requireCompactTransaction(
            record.compactTransaction,
            'summary',
            'in_flight',
          );
          const summary = await this.#rebuildDurableSummaryPlan(transaction, iteration, execution);
          const candidate = await completeSummaryCompactPlan({
            model: this.#llm,
            policy: this.#contextCompact.summary!,
            plan: summary.plan,
            response,
          });
          await this.#completeDurableSummaryCandidate(transaction, candidate, iteration);
          response = undefined;
        }
      } else if (recovery.action === 'execute_compact') {
        if (recovery.transaction.kind === 'summary') {
          const summary = await this.#rebuildDurableSummaryPlan(
            recovery.transaction,
            iteration,
            execution,
          );
          await this.#executeDurableSummaryPlan(
            summary.cause,
            iteration,
            summary.plan,
            execution,
            recovery.transaction,
          );
        } else {
          const rebuilt = this.#rebuildDurableToolPayloadCompact(
            recovery.transaction,
            record.pendingBatch,
            iteration,
          );
          await this.#executeDurableToolPayloadCompact(
            iteration,
            rebuilt.snapshot,
            rebuilt.records,
            execution,
            recovery.transaction,
          );
          iteration += 1;
          compactedRecoveredBatch = true;
        }
      } else if (recovery.action === 'apply_compact') {
        if (recovery.transaction.kind === 'summary') {
          await this.#applyDurableSummaryResult(
            requireCompactTransaction(recovery.transaction, 'summary', 'result_ready'),
          );
        } else {
          await this.#applyDurableToolPayloadResult(
            requireCompactTransaction(recovery.transaction, 'tool_payload', 'result_ready'),
          );
          iteration += 1;
          compactedRecoveredBatch = true;
        }
      } else if (recovery.action === 'fail_outcome_unknown') {
        throw new SubAgentRuntimeError(recovery.error);
      }

      if (compactedRecoveredBatch) {
        const endRequested = record.pendingBatch?.endRequested === true;
        const compacted = await controller.checkpoint(
          {
            runId: options.runId,
            contextStore: this.#contextStore,
            status: endRequested ? 'succeeded' : 'running',
            modelIteration: iteration,
            pendingBatch: null,
            pendingApprovals: [],
            endRequested,
            compactTransaction: null,
          },
          lease,
        );
        this.#contextStore = compacted.contextStore;
        if (endRequested) {
          this.#pendingRunId = undefined;
          this.#changeStatus('ended');
          this.#releaseSameProcessCheckpointCodec();
          return succeededRunOutcome(
            this.#sessionId,
            options.runId,
            this.#contextStore.getActiveContext(),
          );
        }
      }

      if (response !== undefined) {
        this.#contextStore.openLoopSpan();
        this.#trackedToolListenerPromises = hasToolPayloadCompactor(this.#contextCompact)
          ? []
          : undefined;
        await this.#emitModelResponse(response.messages, execution.signal);
        for (const message of response.messages) this.#contextStore.appendToOpenLoop(message);
        const batch = await this.#executeProviderToolBatch(response, iteration, execution);
        const outcome = await this.#finishResumedBatch(
          options.runId,
          iteration,
          execution,
          batch,
          lease,
        );
        if (outcome !== undefined) return outcome;
        iteration += 1;
      } else if (!compactedRecoveredBatch && record.pendingBatch !== undefined) {
        const messages = this.#decodeAssistantBatch(record.pendingBatch.assistantMessage);
        const batch = await this.#executeProviderToolBatch(
          { messages },
          iteration,
          execution,
          record.pendingBatch.batchId,
          record.pendingBatch,
          options.decisions,
        );
        const outcome = await this.#finishResumedBatch(
          options.runId,
          iteration,
          execution,
          batch,
          lease,
        );
        if (outcome !== undefined) return outcome;
        iteration += 1;
      }

      return await this.#continueResumedIterations(options.runId, iteration, execution, lease);
    } catch (error) {
      if (!started) throw error;
      return await this.#settleRootRunFailure(options.runId, error, execution, lease);
    } finally {
      await lease?.release();
      this.#activeRunLease = undefined;
      this.#activePendingApprovals = Object.freeze([]);
      this.#activeModelOperation = undefined;
      this.#activeCompactTransaction = undefined;
      execution.dispose();
    }
  }

  async #finishResumedBatch(
    runId: string,
    iteration: number,
    execution: ActiveAgentExecution,
    batch: AgentToolBatchLoopResult<P>,
    lease: AgentRunLease,
  ): Promise<AgentRunOutcome<P> | undefined> {
    if (batch.waitingApproval) {
      this.#activePendingApprovals = Object.freeze([...batch.approvals]);
      this.#pendingRunId = runId;
      this.#changeStatus('idle');
      return Object.freeze({
        status: 'waiting_approval',
        sessionId: this.#sessionId,
        runId,
        checkpointRevision: await this.#readRunRevision(runId),
        approvals: Object.freeze([...batch.approvals]),
      });
    }
    await this.#finalizeOpenLoop(
      iteration,
      execution,
      this.#selectToolCompactRecords(batch.checkpoint, iteration, batch.records),
    );
    this.#trackedToolListenerPromises = undefined;
    this.#endRequested = batch.checkpoint.endRequested;
    if (this.#endRequested) {
      this.#endRequested = false;
      await this.#runController!.checkpoint(
        {
          runId,
          contextStore: this.#contextStore,
          status: 'succeeded',
          modelIteration: iteration + 1,
          pendingBatch: null,
          pendingApprovals: [],
          endRequested: true,
        },
        lease,
      );
      this.#changeStatus('ended');
      this.#pendingRunId = undefined;
      this.#releaseSameProcessCheckpointCodec();
      return succeededRunOutcome(this.#sessionId, runId, this.#contextStore.getActiveContext());
    }
    await this.#runController!.checkpoint(
      {
        runId,
        contextStore: this.#contextStore,
        status: 'running',
        modelIteration: iteration + 1,
        pendingBatch: null,
        pendingApprovals: [],
        endRequested: false,
      },
      lease,
    );
    return undefined;
  }

  async #continueResumedIterations(
    runId: string,
    startIteration: number,
    execution: ActiveAgentExecution,
    lease: AgentRunLease,
  ): Promise<AgentRunOutcome<P>> {
    for (
      let iteration = startIteration;
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
      let preserveOpenLoop = false;
      this.#contextStore.openLoopSpan();
      this.#endRequested = false;
      this.#trackedToolListenerPromises = hasToolPayloadCompactor(this.#contextCompact)
        ? []
        : undefined;
      try {
        await this.#emitModelResponse(response.messages, execution.signal);
        for (const message of response.messages) this.#contextStore.appendToOpenLoop(message);
        const batch = await this.#executeProviderToolBatch(response, iteration, execution);
        const outcome = await this.#finishResumedBatch(runId, iteration, execution, batch, lease);
        preserveOpenLoop = outcome?.status === 'waiting_approval';
        if (outcome !== undefined) return outcome;
      } finally {
        this.#trackedToolListenerPromises = undefined;
        if (!preserveOpenLoop && this.#contextStore.hasOpenLoopSpan) {
          this.#contextStore.abortOpenLoopSpan();
          this.#endRequested = false;
        }
      }
    }
    throw new Error(`Agent exceeded maxIterations: ${this.#maxIterations}.`);
  }

  async #finalizeOpenLoop(
    iteration: number,
    execution: ActiveAgentExecution,
    records: readonly ToolExecutionRecord<P>[],
  ): Promise<void> {
    if (records.length === 0 || !hasToolPayloadCompactor(this.#contextCompact)) {
      if (this.#contextStore.hasOpenLoopSpan) this.#contextStore.closeOpenLoopSpan();
      return;
    }
    await awaitWithAbort(Promise.all(this.#trackedToolListenerPromises ?? []), execution.signal);
    throwIfAborted(execution.signal, execution.deadlineAt);
    const snapshot = this.#contextStore.snapshotOpenLoop();
    if (
      (this.#runController !== undefined && this.#llm.checkpointCodec !== undefined) ||
      this.#activeChildExecution?.options.checkpointMode === 'durable'
    ) {
      await this.#executeDurableToolPayloadCompact(iteration, snapshot, records, execution);
      return;
    }
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

  #selectToolCompactRecords(
    batch: StoredPendingToolBatch,
    iteration: number,
    records: readonly ToolExecutionRecord<P>[],
  ): readonly ToolExecutionRecord<P>[] {
    if (
      !hasToolPayloadCompactor(this.#contextCompact) ||
      !this.#contextStore.hasOpenLoopSpan ||
      ((this.#runController === undefined || this.#llm.checkpointCodec === undefined) &&
        this.#activeChildExecution?.options.checkpointMode !== 'durable')
    ) {
      return records;
    }
    return this.#rebuildToolPayloadCompactSource(batch, iteration).records;
  }

  async #executeDurableToolPayloadCompact(
    iteration: number,
    snapshot: OpenLoopSnapshot<P>,
    records: readonly ToolExecutionRecord<P>[],
    execution: ActiveAgentExecution,
    preparedInput?: DurableCompactTransaction & { readonly phase: 'prepared' },
  ): Promise<void> {
    const codec = this.#llm.checkpointCodec;
    if (codec === undefined) {
      throw recoveryUnsupportedError('Durable tool payload compact requires a protocol codec.');
    }
    const metadata = buildToolPayloadCompactMetadata(codec, iteration, snapshot, records);
    const prepared =
      preparedInput ??
      createCompactTransactionCheckpoint({
        transactionId: `compact-tool-payload-${hashJson(metadata)}`,
        kind: 'tool_payload',
        contextRevision: snapshot.revision,
        preparedAt: Date.now(),
        metadata,
      });
    assertToolPayloadTransactionIdentity(prepared, metadata, snapshot.revision);
    if (preparedInput === undefined) await this.#persistCompactTransaction(prepared);
    const inFlight = beginCompactTransactionCheckpoint(prepared, Date.now());
    await this.#persistCompactTransaction(inFlight);
    const rewritten = await rewriteOpenLoopToolPayloads({
      model: this.#llm,
      iteration,
      snapshot,
      records,
      compactors: this.#contextCompact,
      signal: execution.signal,
    });
    const result: JsonValue = Object.freeze({
      version: '1',
      kind: 'tool_payload',
      candidate: Object.freeze({
        protocol: codec.protocol,
        codecVersion: codec.version,
        value: codec.encode(rewritten),
      }),
    });
    const resultReady = completeCompactTransactionCheckpoint(inFlight, result, Date.now());
    await this.#persistCompactTransaction(resultReady);
    this.#contextStore.commitOpenLoopRewrite(snapshot, rewritten);
    await this.#persistCompactTransaction(undefined);
  }

  #rebuildToolPayloadCompactSource(
    batch: StoredPendingToolBatch | undefined,
    iteration: number,
  ): {
    readonly snapshot: OpenLoopSnapshot<P>;
    readonly records: readonly ToolExecutionRecord<P>[];
  } {
    const codec = this.#llm.checkpointCodec;
    if (
      codec === undefined ||
      batch === undefined ||
      batch.iteration !== iteration ||
      !this.#contextStore.hasOpenLoopSpan
    ) {
      throw checkpointMismatchError(
        'The durable tool payload compact source batch is unavailable.',
      );
    }
    const snapshot = this.#contextStore.snapshotOpenLoop();
    const parsedCalls = this.#llm.parseToolCalls(snapshot.activeContext);
    const records = [...batch.calls]
      .sort((left, right) => left.order - right.order)
      .map((stored): ToolExecutionRecord<P> => {
        const matches = parsedCalls.filter(({ id }) => id === stored.callId);
        const call = matches[0];
        if (
          matches.length !== 1 ||
          call === undefined ||
          call.name !== stored.name ||
          stored.output === undefined ||
          (stored.status !== 'settled' &&
            stored.status !== 'result_submitted' &&
            stored.status !== 'applied') ||
          canonicalizeJson(decodeCallInputForRecovery(call.arguments)) !==
            canonicalizeJson(stored.input) ||
          hashJson(stored.input) !== stored.inputHash
        ) {
          throw checkpointMismatchError(
            'The durable tool payload call cannot be rebuilt from its source batch.',
          );
        }
        const originalResult = serializeJsonValue(stored.output);
        const expectedResult = this.#createToolMessage(call.id, originalResult);
        const expectedEncoding = canonicalizeJson(codec.encode([expectedResult]));
        const resultMatches = snapshot.activeContext.filter(
          (message) => canonicalizeJson(codec.encode([message])) === expectedEncoding,
        );
        const resultMessage = resultMatches[0];
        if (resultMatches.length !== 1 || resultMessage === undefined) {
          throw checkpointMismatchError(
            'The durable tool payload result message cannot be located uniquely.',
          );
        }
        const tool = this.tools.find(({ name }) => name === call.name);
        return Object.freeze({
          call,
          resultMessage,
          originalInput: call.arguments,
          originalResult,
          compactResult:
            tool === this.#builtinSkillRuntimeDefinition ? this.#skillRuntime.compactResult : true,
        });
      });
    return Object.freeze({ snapshot, records: Object.freeze(records) });
  }

  #rebuildDurableToolPayloadCompact(
    transaction: DurableCompactTransaction,
    batch: StoredPendingToolBatch | undefined,
    iteration: number,
  ): {
    readonly snapshot: OpenLoopSnapshot<P>;
    readonly records: readonly ToolExecutionRecord<P>[];
  } {
    const source = this.#rebuildToolPayloadCompactSource(batch, iteration);
    const codec = this.#llm.checkpointCodec!;
    const metadata = buildToolPayloadCompactMetadata(
      codec,
      iteration,
      source.snapshot,
      source.records,
    );
    assertToolPayloadTransactionIdentity(transaction, metadata, source.snapshot.revision);
    return source;
  }

  async #applyDurableToolPayloadResult(
    transaction: DurableCompactTransaction & {
      readonly kind: 'tool_payload';
      readonly phase: 'result_ready';
      readonly result: JsonValue;
    },
  ): Promise<void> {
    const codec = this.#llm.checkpointCodec;
    if (
      codec === undefined ||
      this.#contextStore.revision !== transaction.contextRevision ||
      !this.#contextStore.hasOpenLoopSpan
    ) {
      throw checkpointMismatchError('The durable tool payload candidate context is stale.');
    }
    const encoded = parseDurableToolPayloadResult(transaction.result);
    if (encoded.protocol !== codec.protocol || encoded.codecVersion !== codec.version) {
      throw checkpointMismatchError('The durable tool payload candidate codec is incompatible.');
    }
    const rewritten = Object.freeze([...codec.decode(encoded.value)]);
    const snapshot = this.#contextStore.snapshotOpenLoop();
    this.#contextStore.commitOpenLoopRewrite(snapshot, rewritten);
    await this.#persistCompactTransaction(undefined);
  }

  #assertUniqueToolNames(): void {
    // 显式 init 阶段统一做配置校验，运行时不在每轮请求重复扫描。
    this.tools ??= [];
    const seen = new Set<string>();

    for (const tool of this.tools) {
      if (tool.name === 'agent') {
        throw new Error('The Tool name "agent" is reserved for the Subagent v2 runtime.');
      }
      if (seen.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }

      seen.add(tool.name);
    }
  }

  #assertToolApprovalConfiguration(): void {
    for (const tool of this.tools) {
      const approval = tool.approval;
      if (approval === undefined) continue;
      if (typeof approval !== 'object' || approval === null || Array.isArray(approval)) {
        throw new TypeError(`Tool ${tool.name} approval must be a non-null object.`);
      }
      if (
        typeof approval.summary !== 'string' ||
        approval.summary.trim().length === 0 ||
        approval.summary !== approval.summary.trim()
      ) {
        throw new TypeError(
          `Tool ${tool.name} approval.summary must be a non-empty trimmed string.`,
        );
      }
      if (
        approval.expiresInMs !== undefined &&
        (!Number.isSafeInteger(approval.expiresInMs) || approval.expiresInMs <= 0)
      ) {
        throw new RangeError(
          `Tool ${tool.name} approval.expiresInMs must be a positive safe integer.`,
        );
      }
      if (this.#activeChildExecution === undefined) {
        throw new Error(
          `Tool ${tool.name} approval is supported only for a child Agent execution.`,
        );
      }
      if (this.#activeChildExecution.options.checkpointMode !== 'durable') {
        throw recoveryUnsupportedError('Tool approval requires a durable child checkpoint.');
      }
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
    this.#refreshModelSubAgentRuntimeDefinition();
    const effectiveTools =
      this.#modelSubAgentRuntimeDefinition === undefined
        ? this.tools
        : [...this.tools, this.#modelSubAgentRuntimeDefinition];

    return effectiveTools.map((tool) => {
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
              subAgentCatalog: this.#getSubAgentDispatcher()?.getCatalogEntries() ?? [],
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

  #getSubAgentDispatcher(): SubAgentDispatcher | undefined {
    return this.#activeChildExecution?.options.control.delegation ?? this.#subAgentRuntime;
  }

  /** Refresh the model-visible agent Tool at a request boundary, never mid-response. */
  #refreshModelSubAgentRuntimeDefinition(force = false): void {
    const dispatcher = this.#getSubAgentDispatcher();
    if (dispatcher === undefined) {
      this.#modelSubAgentRuntimeDefinition = undefined;
      this.#modelSubAgentCatalogRevision = undefined;
      return;
    }

    const catalog = dispatcher.getCatalog();
    const catalogEntries = dispatcher.getCatalogEntries();
    this.#assertModelProtocolCatalogCompatibility(catalogEntries);
    if (!force && catalog.revision === this.#modelSubAgentCatalogRevision) return;
    const modelDefinition = createModelSubAgentToolDefinition(catalogEntries);
    const childExecution = this.#activeChildExecution;
    this.#modelSubAgentRuntimeDefinition =
      modelDefinition === null
        ? undefined
        : {
            ...modelDefinition,
            handler: () => {
              throw new Error(
                childExecution === undefined
                  ? 'The built-in agent Tool can only run inside Agent.agent().'
                  : 'The built-in agent Tool can only run inside the child loop.',
              );
            },
          };
    this.#modelSubAgentCatalogRevision = catalog.revision;
  }

  #assertModelProtocolCatalogCompatibility(entries: readonly SubAgentCatalogEntry[]): void {
    if (this.#llm.checkpointCodec === undefined && !isSameProcessOnlyCatalogEntries(entries)) {
      throw recoveryUnsupportedError(
        'A Model without checkpointCodec can use only same-process Subagent Executors.',
      );
    }
  }

  #computeConfigurationHash(): string {
    const codec = this.#llm.checkpointCodec;
    const projection: JsonValue = {
      version: '1',
      maxIterations: this.#maxIterations ?? null,
      protocol:
        codec === undefined
          ? null
          : {
              protocol: codec.protocol,
              codecVersion: codec.version,
            },
      systemPrompts: [...this.#systemPrompts],
      tools: this.tools.map(configurationToolProjection),
      skillSources: configurationValue(this.#skillSources),
      skillRuntime: {
        compactResult: this.#skillRuntime.compactResult,
        resourceExtensions: [...this.#skillRuntime.resourceExtensions],
        scriptExecutors: [...this.#skillRuntime.scriptExecutors.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([extension, executor]) => ({
            extension,
            command: executor.command,
            commandArgs: [...(executor.commandArgs ?? [])],
          })),
      },
      contextCompact: configurationValue(this.#contextCompactConfig ?? null),
      modelErrorRecovery: {
        unhandledRetryLimit: this.#modelErrorRecoveryLimits.unhandledRetryLimit,
        contextLengthRecoveryLimit: this.#modelErrorRecoveryLimits.contextLengthRecoveryLimit,
      },
      limits: this.#subAgentRuntime?.limits ?? null,
    };
    return hashJson(projection);
  }

  #assertConfigurationIdentity(): string {
    const initializedHash = this.#configurationHash;
    if (initializedHash === undefined) {
      throw new Error('Agent configuration identity is unavailable; call init() again.');
    }
    const currentHash = this.#computeConfigurationHash();
    if (currentHash !== initializedHash) {
      throw checkpointMismatchError(
        'Agent configuration changed after init(); reinitialize before starting a run.',
      );
    }
    return currentHash;
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

    if (
      (this.#runController !== undefined && this.#llm.checkpointCodec !== undefined) ||
      this.#activeChildExecution?.options.checkpointMode === 'durable'
    ) {
      const plan = await prepareSummaryCompactPlan({
        model: this.#llm,
        store: this.#contextStore,
        policy,
        cause,
        iteration,
        pendingRequest,
        ...(storeSnapshot === undefined ? {} : { storeSnapshot }),
        ...(defaultSelection === undefined ? {} : { defaultSelection }),
        defaultSelectionCaptured,
      });
      if (plan === undefined) return false;
      return await this.#executeDurableSummaryPlan(cause, iteration, plan, execution);
    }

    try {
      return await runSummaryCompactTransaction({
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
    } finally {
      if (this.#activeModelOperation?.purpose === 'context-summary') {
        await this.#applyPendingModelOperation(iteration);
      }
    }
  }

  async #executeDurableSummaryPlan(
    cause: ContextCompactCause,
    iteration: number,
    plan: PreparedSummaryCompactPlan<P>,
    execution: ActiveAgentExecution,
    preparedInput?: DurableCompactTransaction & { readonly phase: 'prepared' },
  ): Promise<boolean> {
    const codec = this.#llm.checkpointCodec;
    if (codec === undefined) {
      throw recoveryUnsupportedError('A durable summary transaction requires a protocol codec.');
    }
    const requestHash = hashDurableModelRequest(codec, 'context-summary', plan.request);
    const metadata: JsonValue = Object.freeze({
      version: '1',
      cause: cause.type,
      iteration,
      requestHash,
    });
    const prepared =
      preparedInput ??
      createCompactTransactionCheckpoint({
        transactionId: `compact-summary-${hashJson(metadata)}`,
        kind: 'summary',
        contextRevision: plan.storeSnapshot.revision,
        preparedAt: Date.now(),
        metadata,
      });
    assertSummaryTransactionIdentity(prepared, metadata, plan.storeSnapshot.revision);
    if (preparedInput === undefined) await this.#persistCompactTransaction(prepared);
    const inFlight = beginCompactTransactionCheckpoint(prepared, Date.now());
    await this.#persistCompactTransaction(inFlight);

    const response = await this.#generateWithRecovery(
      'context-summary',
      () => plan.request as ModelGenerateRequest<P>,
      iteration,
      execution,
    );
    const candidate = await completeSummaryCompactPlan({
      model: this.#llm,
      policy: this.#contextCompact.summary!,
      plan,
      response,
    });
    await this.#completeDurableSummaryCandidate(inFlight, candidate, iteration);
    return true;
  }

  async #completeDurableSummaryCandidate(
    inFlight: DurableCompactTransaction & { readonly phase: 'in_flight' },
    candidate: SummaryCompactCandidate<P>,
    iteration: number,
  ): Promise<void> {
    const codec = this.#llm.checkpointCodec!;
    const result: JsonValue = Object.freeze({
      version: '1',
      kind: 'summary',
      summary: candidate.summary,
      candidate: Object.freeze({
        protocol: codec.protocol,
        codecVersion: codec.version,
        value: codec.encode(candidate.candidateActiveContext),
      }),
    });
    const resultReady = completeCompactTransactionCheckpoint(inFlight, result, Date.now());
    await this.#applyPendingModelOperation(iteration, undefined, resultReady);
    commitSummaryCompactCandidate(this.#contextStore, candidate);
    await this.#persistCompactTransaction(undefined);
  }

  async #rebuildDurableSummaryPlan(
    transaction: DurableCompactTransaction,
    iteration: number,
    execution: ActiveAgentExecution,
  ): Promise<{
    readonly cause: ContextCompactCause;
    readonly plan: PreparedSummaryCompactPlan<P>;
  }> {
    const policy = this.#contextCompact.summary;
    const codec = this.#llm.checkpointCodec;
    if (policy === undefined || codec === undefined || transaction.kind !== 'summary') {
      throw checkpointMismatchError('The durable summary configuration is unavailable.');
    }
    const metadata = parseSummaryTransactionMetadata(transaction.metadata);
    if (
      metadata.iteration !== iteration ||
      transaction.contextRevision !== this.#contextStore.revision
    ) {
      throw checkpointMismatchError('The durable summary context revision is stale.');
    }
    const cause: ContextCompactCause =
      metadata.cause === 'trigger'
        ? { type: 'trigger' }
        : {
            type: 'context_length_exceeded',
            error: {
              kind: 'context_length_exceeded',
              message: 'Context length exceeded.',
            },
            cause: undefined,
          };
    const pendingRequest = this.#buildAgentRequest(iteration, execution);
    const plan = await prepareSummaryCompactPlan({
      model: this.#llm,
      store: this.#contextStore,
      policy,
      cause,
      iteration,
      pendingRequest,
    });
    if (plan === undefined) {
      throw checkpointMismatchError('The durable summary selection can no longer be rebuilt.');
    }
    const rebuiltHash = hashDurableModelRequest(codec, 'context-summary', plan.request);
    const expectedMetadata: JsonValue = Object.freeze({
      version: '1',
      cause: metadata.cause,
      iteration,
      requestHash: rebuiltHash,
    });
    assertSummaryTransactionIdentity(transaction, expectedMetadata, plan.storeSnapshot.revision);
    if (rebuiltHash !== metadata.requestHash) {
      throw checkpointMismatchError('The rebuilt summary request does not match its durable hash.');
    }
    return Object.freeze({ cause, plan });
  }

  async #applyDurableSummaryResult(
    transaction: DurableCompactTransaction & {
      readonly kind: 'summary';
      readonly phase: 'result_ready';
      readonly result: JsonValue;
    },
  ): Promise<void> {
    const codec = this.#llm.checkpointCodec;
    if (codec === undefined || this.#contextStore.revision !== transaction.contextRevision) {
      throw checkpointMismatchError('The durable summary candidate context revision is stale.');
    }
    const parsed = parseDurableSummaryResult(transaction.result);
    if (
      parsed.candidate.protocol !== codec.protocol ||
      parsed.candidate.codecVersion !== codec.version
    ) {
      throw checkpointMismatchError('The durable summary candidate codec is incompatible.');
    }
    const candidate = Object.freeze([...codec.decode(parsed.candidate.value)]);
    const summaryMessage = candidate[0];
    if (summaryMessage === undefined) {
      throw checkpointMismatchError('The durable summary candidate is empty.');
    }
    this.#contextStore.commitSummary({
      revision: transaction.contextRevision,
      summaryText: parsed.summary,
      summaryMessage,
      preservedContext: Object.freeze(candidate.slice(1)),
    });
    await this.#persistCompactTransaction(undefined);
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

      await this.#applyPendingModelOperation(iteration);

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
    preparedOperation?: DurableAgentModelOperationV1,
  ): Promise<ModelGenerateResult<P>> {
    let pendingInitialRequest = initialRequest;
    let pendingPreparedOperation = preparedOperation;

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
      ...(this.#activeChildExecution !== undefined
        ? {
            generate: async (request: ModelGenerateRequest<P>) => {
              const operation = pendingPreparedOperation;
              pendingPreparedOperation = undefined;
              return this.#generateChildOnce(purpose, request, iteration, operation);
            },
          }
        : this.#runController !== undefined && this.#activeRunLease !== undefined
          ? {
              generate: async (request: ModelGenerateRequest<P>) => {
                const operation = pendingPreparedOperation;
                pendingPreparedOperation = undefined;
                return this.#generateDurableOnce(purpose, request, iteration, operation);
              },
            }
          : {}),
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

  async #generateChildOnce(
    purpose: ModelGeneratePurpose,
    requestInput: ModelGenerateRequest<P>,
    iteration: number,
    preparedOperation?: DurableAgentModelOperationV1,
  ): Promise<ModelGenerateResult<P>> {
    const child = this.#activeChildExecution!;
    if (
      child.modelOperation !== undefined &&
      (preparedOperation === undefined ||
        child.modelOperation.operationId !== preparedOperation.operationId)
    ) {
      throw new Error('A child Model operation is already open.');
    }
    const operationId =
      preparedOperation?.operationId ?? createEphemeralId('child-model-operation');
    const request: ModelGenerateRequest<P> = Object.freeze({ ...requestInput });
    throwIfAborted(request.signal, request.deadlineAt);

    if (child.options.checkpointMode === 'same_process') {
      await this.#consumeChildProviderBudget(operationId, purpose);
      throwIfAborted(request.signal, request.deadlineAt);
      try {
        return await awaitWithAbort(this.#llm.generate(request), request.signal);
      } catch (error) {
        if (this.#isExplicitProviderRejection(error, purpose, request)) throw error;
        throw modelOutcomeUnknownRuntimeError('child');
      }
    }

    const codec = this.#llm.checkpointCodec!;
    const requestHash = hashDurableModelRequest(codec, purpose, request);
    if (preparedOperation === undefined) {
      const now = Date.now();
      child.modelIteration = iteration;
      child.modelOperation = Object.freeze({
        version: '1' as const,
        operationId,
        iteration,
        purpose,
        requestHash,
        phase: 'prepared' as const,
        preparedAt: now,
        updatedAt: now,
      });
      await this.#commitChildCheckpoint();
    } else if (
      preparedOperation.phase !== 'prepared' ||
      preparedOperation.iteration !== iteration ||
      preparedOperation.purpose !== purpose ||
      preparedOperation.requestHash !== requestHash ||
      child.modelOperation?.operationId !== preparedOperation.operationId
    ) {
      throw checkpointMismatchError('The prepared child Model operation is incompatible.');
    }
    await this.#consumeChildProviderBudget(operationId, purpose);
    child.modelOperation = Object.freeze({
      ...child.modelOperation!,
      phase: 'in_flight' as const,
      updatedAt: Date.now(),
    });
    await this.#commitChildCheckpoint();

    let response: ModelGenerateResult<P>;
    try {
      response = await awaitWithAbort(this.#llm.generate(request), request.signal);
    } catch (error) {
      if (this.#isExplicitProviderRejection(error, purpose, request)) {
        child.modelOperation = undefined;
        await this.#commitChildCheckpoint();
        throw error;
      }
      throw modelOutcomeUnknownRuntimeError('child');
    }
    child.modelOperation = resultReadyChildModelOperation(
      child.modelOperation,
      response.messages,
      codec,
    );
    this.#activeModelOperation = Object.freeze({ operationId, iteration, purpose });
    await this.#commitChildCheckpoint();
    return response;
  }

  async #generateDurableOnce(
    purpose: ModelGeneratePurpose,
    requestInput: ModelGenerateRequest<P>,
    iteration: number,
    preparedOperation?: DurableAgentModelOperationV1,
  ): Promise<ModelGenerateResult<P>> {
    const controller = this.#runController;
    const lease = this.#activeRunLease;
    const codec = this.#llm.checkpointCodec ?? this.#sameProcessCheckpointCodec;
    if (controller === undefined || lease === undefined) {
      throw new Error('A durable Model operation requires its controller, lease, and codec.');
    }
    if (this.#activeModelOperation !== undefined) {
      throw new Error('A durable Model operation is already open.');
    }

    const operationId = preparedOperation?.operationId ?? createEphemeralId('model-operation');
    const request: ModelGenerateRequest<P> = Object.freeze({ ...requestInput });
    const requestHash =
      this.#llm.checkpointCodec === undefined
        ? hashSameProcessModelRequest(codec, purpose, request)
        : hashDurableModelRequest(codec, purpose, request);
    if (preparedOperation === undefined) {
      await controller.prepareModelOperation(
        {
          runId: lease.runId,
          operationId,
          iteration,
          purpose,
          requestHash,
        },
        lease,
      );
    } else if (
      preparedOperation.phase !== 'prepared' ||
      preparedOperation.iteration !== iteration ||
      preparedOperation.purpose !== purpose ||
      preparedOperation.requestHash !== requestHash
    ) {
      throw checkpointMismatchError('The prepared root Model operation is incompatible.');
    }
    await controller.markModelOperationInFlight(lease.runId, operationId, lease);

    let response: ModelGenerateResult<P>;
    try {
      response = await awaitWithAbort(this.#llm.generate(request), request.signal);
    } catch (error) {
      if (this.#isExplicitProviderRejection(error, purpose, request)) {
        await controller.rejectModelOperation(lease.runId, operationId, lease);
        throw error;
      }
      const failed = await controller.failModelOperationOutcomeUnknown(
        lease.runId,
        operationId,
        lease,
      );
      this.#activeModelOperation = undefined;
      throw new SubAgentRuntimeError(
        failed.record.error ?? {
          code: 'INTERNAL_ERROR',
          message: 'The provider request outcome could not be confirmed.',
          retryable: false,
          causeCode: 'MODEL_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        },
      );
    }

    await controller.commitModelOperationResult(
      { runId: lease.runId, operationId, messages: response.messages },
      lease,
    );
    this.#activeModelOperation = Object.freeze({ operationId, iteration, purpose });
    return response;
  }

  #isExplicitProviderRejection(
    error: unknown,
    purpose: ModelGeneratePurpose,
    request: ModelGenerateRequest<P>,
  ): boolean {
    if (isAbortError(error, request.signal)) return false;
    try {
      const status = this.#llm.classifyError(error, { purpose, request }).status;
      return Number.isSafeInteger(status) && status! >= 400 && status! <= 599;
    } catch {
      return false;
    }
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
    appendResult = true,
  ): ToolExecutionRecord<P> {
    const resultMessage = this.#createToolMessage(call.id, output);
    if (appendResult) this.#appendToolMessage(resultMessage);

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

function normalizeAgentRunOptions(input: AgentRunOptions | undefined): ResolvedAgentRunOptions {
  if (
    input !== undefined &&
    (typeof input !== 'object' || input === null || Array.isArray(input))
  ) {
    throw new TypeError('Agent run options must be a non-null object.');
  }

  if (input?.stream !== undefined && typeof input.stream !== 'boolean') {
    throw new TypeError('Agent execution options.stream must be a boolean.');
  }

  return {
    stream: input?.stream ?? false,
    ...(input?.signal === undefined ? {} : { signal: input.signal }),
    ...(input?.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
  };
}

function normalizeAgentResumeOptions(input: AgentResumeOptions): AgentResumeOptions {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Agent resume options must be a non-null object.');
  }
  assertNonEmptyIdentifier(input.runId, 'runId');
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    throw new TypeError('signal must be an AbortSignal.');
  }
  if (input.decisions !== undefined && !Array.isArray(input.decisions)) {
    throw new TypeError('resume decisions must be an array.');
  }
  return Object.freeze({
    runId: input.runId,
    ...(input.decisions === undefined ? {} : { decisions: Object.freeze([...input.decisions]) }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
  });
}

function createActiveAgentExecution(
  options: AgentRunOptions | ToolCallExecutionOptions | undefined,
  runtime: ActiveAgentExecution['runtime'],
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

  const abortScope = createAbortScope(options?.signal, options?.deadlineAt);

  return {
    signal: abortScope.signal,
    placementSignal: abortScope.signal,
    ...(options?.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
    runtime: Object.freeze({ ...runtime }),
    dispose: () => abortScope.dispose(),
  };
}

/**
 * Same-process-only protocol checkpoint. Values are opaque process-local identities; a new
 * Agent instance cannot decode them, which deliberately prevents durable/cross-process resume.
 */
interface SameProcessCheckpointCodec<
  P extends AgentProtocol,
> extends AgentProtocolCheckpointCodec<P> {
  /** Drop every process-local identity after a terminal outcome; approval pauses retain them. */
  release(): void;
}

function createSameProcessCheckpointCodec<
  P extends AgentProtocol,
>(): SameProcessCheckpointCodec<P> {
  let nextId = 1;
  const valueIds = new Map<ContextOf<P>, string>();
  const values = new Map<string, ContextOf<P>>();
  const idFor = (value: ContextOf<P>): string => {
    const existing = valueIds.get(value);
    if (existing !== undefined) return existing;
    const id = `context-${nextId++}`;
    valueIds.set(value, id);
    values.set(id, value);
    return id;
  };
  return Object.freeze({
    protocol: 'memory',
    version: 'same-process',
    encode(context: readonly ContextOf<P>[]): JsonValue {
      return { ids: context.map(idFor) };
    },
    decode(value: JsonValue): readonly ContextOf<P>[] {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw recoveryUnsupportedError(
          'The same-process protocol checkpoint is unavailable in this Agent instance.',
        );
      }
      const object = value as Readonly<Record<string, JsonValue>>;
      if (
        !Array.isArray(object.ids) ||
        object.ids.some((id: JsonValue) => typeof id !== 'string' || !values.has(id))
      ) {
        throw recoveryUnsupportedError(
          'The same-process protocol checkpoint is unavailable in this Agent instance.',
        );
      }
      return Object.freeze(object.ids.map((id: JsonValue) => values.get(id as string)!));
    },
    release(): void {
      valueIds.clear();
      values.clear();
      nextId = 1;
    },
  });
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

function trustedBatchPosition<P extends AgentProtocol>(
  calls: readonly AgentToolCall<P>[],
  call: AgentToolCall<P>,
): ToolRuntimeContext<P>['batch'] {
  const callIndex = calls.indexOf(call);
  if (callIndex < 0) throw new Error('The Tool call is not part of the trusted provider batch.');
  return Object.freeze({
    callIndex,
    callCount: calls.length,
    isStandalone: calls.length === 1,
  });
}

function stableAgentToolFailure(
  error: SubAgentErrorDescriptor,
  dispatcher?: SubAgentDispatcher,
  subAgent?: string,
): ToolBatchAgentCallOutcome {
  const availableExecutors =
    dispatcher === undefined
      ? []
      : dispatcher
          .getCatalogEntries()
          .filter(({ definition }) => subAgent === undefined || definition.name === subAgent)
          .flatMap(({ executors }) =>
            executors.map(({ name, description, capabilities }) =>
              Object.freeze({
                name,
                description,
                capabilities: Object.freeze([
                  'execute',
                  ...(capabilities.spawn ? ['spawn'] : []),
                  ...(capabilities.approval ? ['approval'] : []),
                  `usage:${capabilities.usage}`,
                  `resume:${capabilities.recovery.resume}`,
                  `reconnect:${capabilities.recovery.reconnect}`,
                ]),
              }),
            ),
          );
  return Object.freeze({
    status: 'settled',
    output: Object.freeze({
      ok: false,
      error: Object.freeze({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      }),
      availableExecutors: Object.freeze(availableExecutors),
    }),
  });
}

const STABLE_PRE_CREATE_DISPATCH_CODES = Object.freeze(
  new Set<SubAgentErrorDescriptor['code']>([
    'DEFINITION_NOT_FOUND',
    'DEFINITION_VERSION_MISMATCH',
    'INVALID_INPUT',
    'CONTEXT_PROJECTION_FAILED',
    'EXECUTOR_NOT_FOUND',
    'EXECUTOR_DISALLOWED',
    'EXECUTOR_UNAVAILABLE',
    'UNSUPPORTED_CAPABILITY',
    'CHILD_DEFINITION_DISALLOWED',
    'LIMIT_EXCEEDED',
    'BUDGET_EXCEEDED',
  ]),
);

function isStablePreCreateDispatchError(error: unknown): error is SubAgentRuntimeError {
  return error instanceof SubAgentRuntimeError && STABLE_PRE_CREATE_DISPATCH_CODES.has(error.code);
}

function stableErrorEnvelope(error: SubAgentErrorDescriptor): JsonValue {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    }),
  });
}

function normalizeAgentSubAgentRunOptions<P extends AgentProtocol>(
  input: AgentSubAgentRunOptions<P>,
): AgentSubAgentRunOptions<P> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Child Agent run options must be a non-null object.');
  }
  assertNonEmptyIdentifier(input.runnerId, 'runnerId');
  assertNonEmptyIdentifier(input.runnerVersion, 'runnerVersion');
  assertNonEmptyIdentifier(input.executorName, 'executorName');
  if (input.checkpointMode !== 'same_process' && input.checkpointMode !== 'durable') {
    throw new TypeError('checkpointMode must be same_process or durable.');
  }
  if (typeof input.outputSchema?.safeParse !== 'function') {
    throw new TypeError('A child Agent requires an output Zod schema.');
  }
  const request = input.request;
  const control = input.control;
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof control !== 'object' ||
    control === null
  ) {
    throw new TypeError('A child Agent requires a request and execution control.');
  }
  assertNonEmptyIdentifier(request.ownerSessionId, 'ownerSessionId');
  assertNonEmptyIdentifier(request.runId, 'runId');
  assertNonEmptyIdentifier(request.taskId, 'taskId');
  assertNonEmptyIdentifier(request.subagentSessionId, 'subagentSessionId');
  assertNonEmptyIdentifier(request.executionEpoch, 'executionEpoch');
  assertNonEmptyIdentifier(request.executionFencingToken, 'executionFencingToken');
  assertNonEmptyIdentifier(request.definition.name, 'definition.name');
  assertNonEmptyIdentifier(request.definition.version, 'definition.version');
  if (!Number.isSafeInteger(request.attempt) || request.attempt < 1) {
    throw new RangeError('Child request attempt must be a positive safe integer.');
  }
  if (!Number.isFinite(request.deadlineAt) || !Number.isFinite(control.deadlineAt)) {
    throw new RangeError('Child request deadlines must be finite timestamps.');
  }
  if (!isAbortSignal(request.signal) || !isAbortSignal(control.signal)) {
    throw new TypeError('Child request and control signals must be AbortSignals.');
  }
  assertJsonValue(request.input);
  assertJsonValue(request.projectedContext as unknown);
  assertJsonValue(request.delegation as unknown);
  assertJsonValue(request.limits as unknown);
  return input;
}

function assertChildRebind<P extends AgentProtocol>(
  previous: AgentSubAgentRunOptions<P>,
  next: AgentSubAgentRunOptions<P>,
): void {
  const left = previous.request;
  const right = next.request;
  const stableIdentity =
    previous.runnerId === next.runnerId &&
    previous.runnerVersion === next.runnerVersion &&
    previous.executorName === next.executorName &&
    previous.checkpointMode === next.checkpointMode &&
    left.ownerSessionId === right.ownerSessionId &&
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.parentTaskId === right.parentTaskId &&
    left.subagentSessionId === right.subagentSessionId &&
    left.definition.name === right.definition.name &&
    left.definition.version === right.definition.version &&
    canonicalizeJson(left.input) === canonicalizeJson(right.input) &&
    canonicalizeJson(left.projectedContext as unknown as JsonValue) ===
      canonicalizeJson(right.projectedContext as unknown as JsonValue) &&
    sameChildDelegationScope(left.delegation, right.delegation) &&
    sameChildStableLimits(left.limits, right.limits) &&
    left.path.length === right.path.length &&
    left.path.every((part, index) => part === right.path[index]);
  const forward =
    stableIdentity &&
    right.attempt > left.attempt &&
    right.executionEpoch !== left.executionEpoch &&
    parseChildFencingToken(right.executionFencingToken) >
      parseChildFencingToken(left.executionFencingToken) &&
    Number.isSafeInteger(right.limits.timeoutMs) &&
    right.limits.timeoutMs > 0 &&
    right.limits.timeoutMs <= left.limits.timeoutMs;
  if (!forward) {
    throw new SubAgentRuntimeError({
      code: 'RECOVERY_TARGET_LOST',
      message: 'A child Agent can resume only the same task with a newer attempt.',
      retryable: false,
    });
  }
}

function sameChildDelegationScope(
  left: AgentSubAgentRunOptions<AgentProtocol>['request']['delegation'],
  right: AgentSubAgentRunOptions<AgentProtocol>['request']['delegation'],
): boolean {
  return (
    left.version === right.version &&
    left.ownerSessionId === right.ownerSessionId &&
    left.runId === right.runId &&
    left.parentTaskId === right.parentTaskId &&
    left.depth === right.depth &&
    left.path.length === right.path.length &&
    left.path.every((part, index) => part === right.path[index])
  );
}

function sameChildStableLimits(
  left: AgentSubAgentRunOptions<AgentProtocol>['request']['limits'],
  right: AgentSubAgentRunOptions<AgentProtocol>['request']['limits'],
): boolean {
  return (
    left.maxDepth === right.maxDepth &&
    left.maxDescendants === right.maxDescendants &&
    left.maxConcurrent === right.maxConcurrent &&
    left.maxTurns === right.maxTurns &&
    left.maxProviderCalls === right.maxProviderCalls &&
    left.maxInputTokens === right.maxInputTokens &&
    left.maxOutputTokens === right.maxOutputTokens &&
    left.maxCost === right.maxCost
  );
}

function parseChildFencingToken(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new SubAgentRuntimeError({
      code: 'RECOVERY_TARGET_LOST',
      message: 'A child Agent execution requires a decimal fencing token.',
      retryable: false,
    });
  }
  return BigInt(value);
}

function isSubAgentDelegationClient(
  dispatcher: SubAgentDispatcher,
): dispatcher is SubAgentDelegationClient {
  return typeof (dispatcher as Partial<SubAgentDelegationClient>).resumeTool === 'function';
}

function isSameProcessOnlyDispatcher(dispatcher: SubAgentDispatcher): boolean {
  return isSameProcessOnlyCatalogEntries(dispatcher.getCatalogEntries());
}

function isSameProcessOnlyCatalogEntries(entries: readonly SubAgentCatalogEntry[]): boolean {
  const executors = entries.flatMap((entry) => entry.executors);
  return executors.every(
    ({ capabilities }) =>
      capabilities.recovery.resume === 'same_process' && capabilities.recovery.reconnect === 'none',
  );
}

function childPendingBatchFromStored(batch: StoredPendingToolBatch): SubAgentChildPendingBatchV1 {
  return Object.freeze({
    version: '1' as const,
    batchId: batch.batchId,
    assistantMessage: batch.assistantMessage,
    calls: Object.freeze(
      batch.calls.map((call) =>
        Object.freeze({
          version: '1' as const,
          operationId: call.operationId,
          kind: call.kind,
          callId: call.callId,
          name: call.name,
          input: cloneJson(call.input),
          inputHash: call.inputHash,
          status: storedStatusToChild(call.status),
          order: call.order,
          ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
          ...(call.approvalIds === undefined
            ? {}
            : { approvals: Object.freeze([...call.approvalIds]) }),
          ...(call.output === undefined ? {} : { result: cloneJson(call.output) }),
        }),
      ),
    ),
    endRequested: batch.endRequested,
    createdAt: batch.createdAt,
  });
}

function storedPendingBatchFromChild(
  batch: SubAgentChildPendingBatchV1,
  iteration: number,
): StoredPendingToolBatch {
  return Object.freeze({
    batchId: batch.batchId,
    iteration,
    assistantMessage: batch.assistantMessage,
    calls: Object.freeze(
      batch.calls.map((call) =>
        Object.freeze({
          operationId: call.operationId,
          callId: call.callId,
          name: call.name,
          order: call.order,
          kind: call.kind,
          input: cloneJson(call.input),
          inputHash: call.inputHash,
          status: childStatusToStored(call.status),
          ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
          ...(call.approvals === undefined
            ? {}
            : { approvalIds: Object.freeze([...call.approvals]) }),
          ...(call.result === undefined ? {} : { output: cloneJson(call.result) }),
        }),
      ),
    ),
    endRequested: batch.endRequested,
    createdAt: batch.createdAt,
  });
}

function storedStatusToChild(
  status: StoredPendingToolCall['status'],
): SubAgentChildPendingBatchV1['calls'][number]['status'] {
  switch (status) {
    case 'pending':
      return 'prepared';
    case 'running':
      return 'in_flight';
    case 'paused':
      return 'waiting_approval';
    case 'settled':
      return 'result_ready';
    case 'result_submitted':
      return 'result_submitted';
    case 'applied':
      return 'applied';
  }
}

function childStatusToStored(
  status: SubAgentChildPendingBatchV1['calls'][number]['status'],
): StoredPendingToolCall['status'] {
  switch (status) {
    case 'prepared':
      return 'pending';
    case 'in_flight':
      return 'running';
    case 'waiting_approval':
      return 'paused';
    case 'result_ready':
      return 'settled';
    case 'result_submitted':
      return 'result_submitted';
    case 'applied':
      return 'applied';
  }
}

function pendingBatchWithApproval(
  batch: StoredPendingToolBatch,
  order: number,
  approvalId: string,
): StoredPendingToolBatch {
  return Object.freeze({
    ...batch,
    calls: Object.freeze(
      batch.calls.map((call) =>
        call.order === order
          ? Object.freeze({
              ...call,
              status: 'paused' as const,
              approvalIds: Object.freeze([approvalId]),
            })
          : call,
      ),
    ),
  });
}

function requireStandaloneChildEndCall(
  batch: StoredPendingToolBatch | undefined,
): StoredPendingToolCall {
  const call = batch?.calls[0];
  if (
    batch === undefined ||
    batch.endRequested !== true ||
    batch.calls.length !== 1 ||
    call === undefined ||
    call.kind !== 'end-agent' ||
    call.name !== 'end-agent' ||
    (call.status !== 'settled' && call.status !== 'applied')
  ) {
    throw checkpointMismatchError(
      'A child completion requires one durable standalone end-agent result.',
    );
  }
  return call;
}

function projectAuthoritativeResultSubmission(
  batch: StoredPendingToolBatch,
  submission: NonNullable<SubAgentChildCheckpoint['resultSubmission']>,
  replayStatus: 'replayed',
): StoredPendingToolBatch {
  const matching = batch.calls.filter(({ callId }) => callId === submission.callId);
  const call = matching[0];
  const expectedInput = Object.freeze({ result: cloneJson(submission.output) });
  if (
    matching.length === 0 &&
    batch.calls.length === 1 &&
    batch.calls[0]?.kind === 'end-agent' &&
    batch.calls[0].name === 'end-agent'
  ) {
    return batch;
  }
  if (
    matching.length !== 1 ||
    call === undefined ||
    call.name !== 'agent-result' ||
    call.kind !== 'tool' ||
    canonicalizeJson(call.input) !== canonicalizeJson(expectedInput) ||
    call.inputHash !== hashJson(call.input)
  ) {
    throw checkpointMismatchError(
      'The authoritative child result does not match its pending agent-result call.',
    );
  }
  if (call.status === 'result_submitted' || call.status === 'applied') return batch;
  if (call.status !== 'running') {
    throw checkpointMismatchError(
      'The authoritative child result cannot be projected from this pending call phase.',
    );
  }
  const output = serializeAgentResultReceipt({
    status: replayStatus,
    outputHash: submission.outputHash,
  });
  return Object.freeze({
    ...batch,
    calls: Object.freeze(
      batch.calls.map((candidate) =>
        candidate.callId === submission.callId
          ? Object.freeze({
              ...candidate,
              status: 'result_submitted' as const,
              output,
            })
          : candidate,
      ),
    ),
  });
}

function resultReadyChildModelOperation<P extends AgentProtocol>(
  operation: DurableAgentModelOperationV1,
  messages: readonly ContextOf<P>[],
  codec: AgentProtocolCheckpointCodec<P>,
): DurableAgentModelOperationV1 {
  return Object.freeze({
    ...operation,
    phase: 'result_ready' as const,
    result: Object.freeze({
      protocol: codec.protocol,
      codecVersion: codec.version,
      value: codec.encode(messages),
    }),
    updatedAt: Date.now(),
  });
}

function childTaskIdentity<P extends AgentProtocol>(options: AgentSubAgentRunOptions<P>) {
  return Object.freeze({
    taskId: options.request.taskId,
    subAgent: Object.freeze({ ...options.request.definition }),
  });
}

function childSucceededOutcome<P extends AgentProtocol>(
  options: AgentSubAgentRunOptions<P>,
  output: JsonValue,
): AgentSubAgentRunOutcome {
  return Object.freeze({
    type: 'terminal' as const,
    result: Object.freeze({
      status: 'succeeded' as const,
      task: childTaskIdentity(options),
      executor: options.executorName,
      output: cloneJson(output),
    }),
  });
}

function delegationPauseCalls(
  batch: StoredPendingToolBatch,
  approvals: readonly ApprovalRequest[],
): readonly SubAgentDelegationPauseCall[] {
  const approvalsById = new Map<string, ApprovalRequest>();
  for (const approval of approvals) {
    if (approvalsById.has(approval.approvalId)) {
      throw checkpointMismatchError('A nested approval appears more than once in the Tool batch.');
    }
    approvalsById.set(approval.approvalId, approval);
  }

  const consumed = new Set<string>();
  const calls = [...batch.calls]
    .filter(({ kind, status }) => kind === 'agent' && status === 'paused')
    .sort((left, right) => left.order - right.order)
    .map((call): SubAgentDelegationPauseCall => {
      if (
        call.taskId === undefined ||
        call.approvalIds === undefined ||
        call.approvalIds.length === 0
      ) {
        throw checkpointMismatchError(
          'A paused nested Agent call is missing its task or approval identity.',
        );
      }
      const callApprovals = call.approvalIds.map((approvalId) => {
        const approval = approvalsById.get(approvalId);
        if (approval === undefined || consumed.has(approvalId) || approval.taskId !== call.taskId) {
          throw checkpointMismatchError('A nested approval does not match its paused Agent task.');
        }
        consumed.add(approvalId);
        return Object.freeze({ ...approval });
      });
      return Object.freeze({
        callId: call.callId,
        childTaskId: call.taskId,
        approvals: Object.freeze(callApprovals),
      });
    });

  if (calls.length === 0 || consumed.size !== approvals.length) {
    throw checkpointMismatchError(
      'The nested delegation pause does not cover the complete approval set.',
    );
  }
  return Object.freeze(calls);
}

function childFailureCallId<P extends AgentProtocol>(child: ActiveChildExecution<P>): string {
  const identity: JsonValue = Object.freeze({
    version: '1',
    taskId: child.options.request.taskId,
    modelIteration: child.modelIteration,
    ...(child.modelOperation === undefined
      ? {}
      : { modelOperationId: child.modelOperation.operationId }),
    ...(child.compactTransaction === undefined
      ? {}
      : { compactTransactionId: child.compactTransaction.transactionId }),
    ...(child.pendingBatch === undefined ? {} : { batchId: child.pendingBatch.batchId }),
    ...(child.resultCallId === undefined ? {} : { resultCallId: child.resultCallId }),
    ...(child.endCallId === undefined ? {} : { endCallId: child.endCallId }),
  });
  return `child-failure-${hashJson(identity)}`;
}

function childFailureInput<P extends AgentProtocol>(
  error: SubAgentRuntimeError,
  child: ActiveChildExecution<P>,
): SubAgentFailureInput {
  const { descriptor } = error;
  const status =
    descriptor.code === 'CANCELLED'
      ? 'cancelled'
      : descriptor.code === 'TIMED_OUT'
        ? 'timed_out'
        : descriptor.code === 'BUDGET_EXCEEDED'
          ? 'budget_exceeded'
          : 'failed';
  return Object.freeze({
    status,
    error: Object.freeze({ ...descriptor }),
    ...(child.resultSubmitted && child.result !== undefined
      ? { partialOutput: cloneJson(child.result) }
      : {}),
  });
}

function checkpointMismatchError(message: string): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'CHECKPOINT_VERSION_MISMATCH',
    message,
    retryable: false,
  });
}

function modelOutcomeUnknownRuntimeError(scope: 'root' | 'child'): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'EXECUTOR_FAILED',
    message: `The ${scope} provider request outcome could not be confirmed.`,
    retryable: false,
    causeCode: 'MODEL_OUTCOME_UNKNOWN',
    outcomeUnknown: true,
  });
}

function isOutcomeUnknownError(error: unknown): boolean {
  return (
    (error instanceof SubAgentRuntimeError && error.descriptor.outcomeUnknown === true) ||
    (typeof error === 'object' &&
      error !== null &&
      'outcomeUnknown' in error &&
      error.outcomeUnknown === true)
  );
}

function isRootRunLeaseLoss(error: unknown, lease: AgentRunLease): boolean {
  return (
    lease.signal.aborted ||
    (error instanceof SubAgentRuntimeError &&
      error.code === 'RECOVERY_TARGET_LOST' &&
      error.descriptor.causeCode === 'ROOT_EXECUTION_LEASE_LOST')
  );
}

function rootRunLeaseLostError(lease: AgentRunLease, cause?: unknown): SubAgentRuntimeError {
  for (const candidate of [lease.signal.reason, cause]) {
    if (
      candidate instanceof SubAgentRuntimeError &&
      candidate.code === 'RECOVERY_TARGET_LOST' &&
      candidate.descriptor.causeCode === 'ROOT_EXECUTION_LEASE_LOST'
    ) {
      return candidate;
    }
  }
  return new SubAgentRuntimeError(
    {
      code: 'RECOVERY_TARGET_LOST',
      message: 'The root Agent execution lease was lost.',
      retryable: true,
      causeCode: 'ROOT_EXECUTION_LEASE_LOST',
    },
    cause instanceof Error ? { cause } : undefined,
  );
}

function normalizeChildExecutionError(error: unknown, signal: AbortSignal): SubAgentRuntimeError {
  if (error instanceof SubAgentRuntimeError) return error;
  if (signal.aborted) {
    if (signal.reason instanceof SubAgentRuntimeError) return signal.reason;
    return new SubAgentRuntimeError({
      code: 'CANCELLED',
      message: 'The child Agent execution was cancelled.',
      retryable: false,
    });
  }
  return new SubAgentRuntimeError(
    {
      code: 'EXECUTOR_FAILED',
      message: 'The child Agent execution failed.',
      retryable: false,
    },
    { cause: error },
  );
}

function cloneJson(value: JsonValue): JsonValue {
  assertJsonValue(value);
  return parseJsonValue(canonicalizeJson(value));
}

function hashJson(value: JsonValue): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}

function storedModelSubAgentRequest(value: JsonValue): ModelSubAgentRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw checkpointMismatchError('The persisted agent Tool input is invalid.');
  }
  const object = value as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(object).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'executor' ||
    keys[1] !== 'input' ||
    keys[2] !== 'subAgent' ||
    typeof object.subAgent !== 'string' ||
    object.subAgent.length === 0 ||
    typeof object.executor !== 'string' ||
    object.executor.length === 0 ||
    !Object.hasOwn(object, 'input')
  ) {
    throw checkpointMismatchError('The persisted agent Tool input is invalid.');
  }
  assertJsonValue(object.input);
  return Object.freeze({
    subAgent: object.subAgent,
    executor: object.executor,
    input: cloneJson(object.input),
  });
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function configurationToolProjection(tool: ToolRuntimeDefinition): JsonValue {
  return {
    name: tool.name,
    description:
      typeof tool.description === 'string'
        ? { kind: 'static', value: tool.description }
        : { kind: 'dynamic', implementationHash: hashText(tool.description.toString()) },
    parametersHash: configurationSchemaHash(tool.parameters ?? getDefaultToolParametersSchema()),
    strict: tool.strict ?? null,
    approval:
      tool.approval === undefined
        ? null
        : {
            summary: tool.approval.summary,
            expiresInMs: tool.approval.expiresInMs ?? null,
          },
    handlerHash: hashText(tool.handler.toString()),
  };
}

function configurationSchemaHash(schema: ToolParametersSchema): string {
  try {
    const jsonSchema = toOpenAIToolParameters(schema);
    return hashJson(parseJsonValue(JSON.stringify(jsonSchema)));
  } catch {
    const internal = schema as unknown as {
      readonly _zod?: { readonly def?: unknown };
      readonly _def?: unknown;
    };
    return hashJson(
      configurationValue(
        internal._zod?.def ??
          internal._def ?? {
            constructor: schema.constructor.name,
            safeParse: schema.safeParse,
          },
      ),
    );
  }
}

/** Convert declarative runtime configuration, including callbacks, into a stable JSON identity. */
function configurationValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'undefined') return { $configuration: 'undefined' };
  if (typeof value === 'function') {
    return { $functionHash: hashText(value.toString()) };
  }
  if (typeof value === 'bigint' || typeof value === 'symbol') {
    return { $configuration: typeof value, value: String(value) };
  }
  if (typeof value !== 'object') return { $configuration: typeof value };
  if (seen.has(value)) return { $configuration: 'cycle' };
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => configurationValue(entry, seen));
    if (value instanceof Map) {
      return [...value.entries()]
        .map(([key, entry]) => [String(key), configurationValue(entry, seen)] as const)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => ({ key, value: entry }));
    }
    const projection: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) {
        projection[key] = { $configuration: 'missing-property-descriptor' };
      } else if ('value' in descriptor) {
        projection[key] = configurationValue(descriptor.value, seen);
      } else {
        // Configuration identity must never invoke user getters. This also keeps capability-
        // gated Skill file sources behind their intended boundary while still identifying the
        // accessor implementation itself.
        projection[key] = {
          $configuration: 'accessor',
          get: configurationValue(descriptor.get, seen),
          set: configurationValue(descriptor.set, seen),
        };
      }
    }
    return projection;
  } finally {
    seen.delete(value);
  }
}

function createApprovalExpiry(expiresInMs: number | undefined): number | undefined {
  if (expiresInMs === undefined) return undefined;
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0) {
    throw new RangeError('approval.expiresInMs must be a positive safe integer.');
  }
  const expiresAt = Date.now() + expiresInMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RangeError('approval expiration must be a safe integer timestamp.');
  }
  return expiresAt;
}

function parseSummaryTransactionMetadata(metadata: JsonValue | undefined): {
  readonly cause: 'trigger' | 'context_length_exceeded';
  readonly iteration: number;
  readonly requestHash: string;
} {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw checkpointMismatchError('The durable summary transaction metadata is invalid.');
  }
  const record = metadata as { readonly [key: string]: JsonValue };
  if (
    record.version !== '1' ||
    (record.cause !== 'trigger' && record.cause !== 'context_length_exceeded') ||
    !Number.isSafeInteger(record.iteration) ||
    (record.iteration as number) < 0 ||
    typeof record.requestHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(record.requestHash)
  ) {
    throw checkpointMismatchError('The durable summary transaction metadata is invalid.');
  }
  return Object.freeze({
    cause: record.cause,
    iteration: record.iteration as number,
    requestHash: record.requestHash,
  });
}

function assertSummaryTransactionIdentity(
  transaction: DurableCompactTransaction,
  metadata: JsonValue,
  contextRevision: number,
): void {
  if (
    transaction.kind !== 'summary' ||
    transaction.contextRevision !== contextRevision ||
    transaction.metadata === undefined ||
    canonicalizeJson(transaction.metadata) !== canonicalizeJson(metadata) ||
    transaction.transactionId !== `compact-summary-${hashJson(metadata)}`
  ) {
    throw checkpointMismatchError('The durable summary transaction identity is incompatible.');
  }
}

function buildToolPayloadCompactMetadata<P extends AgentProtocol>(
  codec: AgentProtocolCheckpointCodec<P>,
  iteration: number,
  snapshot: OpenLoopSnapshot<P>,
  records: readonly ToolExecutionRecord<P>[],
): JsonValue {
  const projection: JsonValue = Object.freeze({
    version: '1',
    protocol: codec.protocol,
    codecVersion: codec.version,
    iteration,
    contextRevision: snapshot.revision,
    activeContext: codec.encode(snapshot.activeContext),
    calls: Object.freeze(
      records.map((record) =>
        Object.freeze({
          callId: record.call.id,
          name: record.call.name,
          arguments: record.originalInput,
          result: record.originalResult,
          compactResult: record.compactResult,
        }),
      ),
    ),
  });
  return Object.freeze({
    version: '1',
    iteration,
    inputHash: hashJson(projection),
  });
}

function assertToolPayloadTransactionIdentity(
  transaction: DurableCompactTransaction,
  metadata: JsonValue,
  contextRevision: number,
): void {
  if (
    transaction.kind !== 'tool_payload' ||
    transaction.contextRevision !== contextRevision ||
    transaction.metadata === undefined ||
    canonicalizeJson(transaction.metadata) !== canonicalizeJson(metadata) ||
    transaction.transactionId !== `compact-tool-payload-${hashJson(metadata)}`
  ) {
    throw checkpointMismatchError('The durable tool payload transaction identity is incompatible.');
  }
}

function requireCompactTransaction<
  K extends DurableCompactTransaction['kind'],
  F extends DurableCompactTransaction['phase'],
>(
  transaction: DurableCompactTransaction | undefined,
  kind: K,
  phase: F,
): DurableCompactTransaction & { readonly kind: K; readonly phase: F } & (F extends
    | 'result_ready'
    | 'applied'
    ? { readonly result: JsonValue }
    : object) {
  if (
    transaction === undefined ||
    transaction.kind !== kind ||
    transaction.phase !== phase ||
    ((phase === 'result_ready' || phase === 'applied') && transaction.result === undefined)
  ) {
    throw checkpointMismatchError(`The durable ${kind} transaction phase is incompatible.`);
  }
  return transaction as DurableCompactTransaction & {
    readonly kind: K;
    readonly phase: F;
  } & (F extends 'result_ready' | 'applied' ? { readonly result: JsonValue } : object);
}

function parseDurableSummaryResult(result: JsonValue): {
  readonly summary: string;
  readonly candidate: EncodedAgentProtocolCheckpoint;
} {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw checkpointMismatchError('The durable summary result is invalid.');
  }
  const record = result as { readonly [key: string]: JsonValue };
  const candidate = record.candidate;
  if (
    record.version !== '1' ||
    record.kind !== 'summary' ||
    typeof record.summary !== 'string' ||
    record.summary.length === 0 ||
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw checkpointMismatchError('The durable summary result is invalid.');
  }
  const encoded = candidate as { readonly [key: string]: JsonValue };
  if (
    typeof encoded.protocol !== 'string' ||
    typeof encoded.codecVersion !== 'string' ||
    encoded.value === undefined
  ) {
    throw checkpointMismatchError('The durable summary candidate is invalid.');
  }
  return Object.freeze({
    summary: record.summary,
    candidate: Object.freeze({
      protocol: encoded.protocol,
      codecVersion: encoded.codecVersion,
      value: encoded.value,
    }),
  });
}

function parseDurableToolPayloadResult(result: JsonValue): EncodedAgentProtocolCheckpoint {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw checkpointMismatchError('The durable tool payload result is invalid.');
  }
  const record = result as { readonly [key: string]: JsonValue };
  const candidate = record.candidate;
  if (
    record.version !== '1' ||
    record.kind !== 'tool_payload' ||
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw checkpointMismatchError('The durable tool payload result is invalid.');
  }
  const encoded = candidate as { readonly [key: string]: JsonValue };
  if (
    typeof encoded.protocol !== 'string' ||
    typeof encoded.codecVersion !== 'string' ||
    encoded.value === undefined
  ) {
    throw checkpointMismatchError('The durable tool payload candidate is invalid.');
  }
  return Object.freeze({
    protocol: encoded.protocol,
    codecVersion: encoded.codecVersion,
    value: encoded.value,
  });
}

function decodeCallInputForRecovery(argumentsText: string): JsonValue {
  try {
    const parsed: unknown = argumentsText.trim().length === 0 ? {} : JSON.parse(argumentsText);
    assertJsonValue(parsed);
    return parsed;
  } catch {
    return argumentsText;
  }
}

function subAgentOutcomeToBatchOutcome(
  outcome: SubAgentExecutionOutcome,
): ToolBatchAgentCallOutcome {
  if (outcome.type === 'paused') {
    return Object.freeze({
      status: 'paused',
      taskId: outcome.task.taskId,
      approvals: Object.freeze([...outcome.approvals]),
      checkpointRevision: outcome.checkpointRevision,
    });
  }
  const result = cloneSubAgentTaskResult(outcome.result);
  return Object.freeze({
    status: 'settled',
    taskId: outcome.result.task.taskId,
    output: result,
    ...(outcome.result.status === 'succeeded'
      ? {}
      : { error: Object.freeze({ ...outcome.result.error }) }),
  });
}

function cloneSubAgentTaskResult(result: SubAgentTaskResult): JsonValue {
  const value = result as unknown as JsonValue;
  assertJsonValue(value);
  return cloneJson(value);
}

function serializeJsonValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function createEphemeralId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function hashDurableModelRequest<P extends AgentProtocol>(
  codec: AgentProtocolCheckpointCodec<P>,
  purpose: ModelGeneratePurpose,
  request: ModelGenerateRequest<P>,
): string {
  const tools = request.tools as unknown;
  assertJsonValue(tools);
  const projection: JsonValue = {
    purpose,
    protocol: codec.protocol,
    codecVersion: codec.version,
    context: codec.encode(request.context),
    tools,
  };
  return createHash('sha256').update(canonicalizeJson(projection), 'utf8').digest('hex');
}

function hashSameProcessModelRequest<P extends AgentProtocol>(
  codec: AgentProtocolCheckpointCodec<P>,
  purpose: ModelGeneratePurpose,
  request: ModelGenerateRequest<P>,
): string {
  return hashJson({
    purpose,
    protocol: codec.protocol,
    codecVersion: codec.version,
    context: codec.encode(request.context),
    // Custom Model tool definitions are protocol-owned and need not themselves be JSON-safe.
    // The same-process boundary uses the configuration projection without invoking getters.
    tools: configurationValue(request.tools),
  });
}

function assertNonEmptyIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string.`);
  }
}

function streamingUnsupportedError(): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'STREAMING_UNSUPPORTED',
    message: 'Agent streaming is not supported in Subagent v2.',
    retryable: false,
  });
}

function recoveryUnsupportedError(message: string): SubAgentRuntimeError {
  return new SubAgentRuntimeError({ code: 'RECOVERY_UNSUPPORTED', message, retryable: false });
}

function succeededRunOutcome<P extends AgentProtocol>(
  sessionId: string,
  runId: string,
  context: readonly ContextOf<P>[],
): AgentRunOutcome<P> {
  return Object.freeze({
    status: 'succeeded',
    sessionId,
    runId,
    context: Object.freeze([...context]),
  });
}

function failedRunOutcome<P extends AgentProtocol>(
  sessionId: string,
  runId: string,
  error: AgentRunError,
  context: readonly ContextOf<P>[],
): AgentRunOutcome<P> {
  return Object.freeze({
    status: 'failed',
    sessionId,
    runId,
    error: Object.freeze({ ...error }),
    context: Object.freeze([...context]),
  });
}

function toAgentRunError(error: unknown, cancelled: boolean): Readonly<SubAgentErrorDescriptor> {
  if (error instanceof SubAgentRuntimeError) {
    return Object.freeze({ ...error.descriptor });
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'outcomeUnknown' in error &&
    error.outcomeUnknown === true
  ) {
    return Object.freeze({
      code: 'INTERNAL_ERROR',
      message: 'The operation outcome could not be confirmed.',
      retryable: false,
      causeCode: 'OPERATION_OUTCOME_UNKNOWN',
      outcomeUnknown: true,
    });
  }
  if (error instanceof ModelErrorRecoveryError) {
    return Object.freeze({
      code: 'INTERNAL_ERROR',
      message: 'Model error recovery could not complete the request.',
      retryable: false,
      causeCode: 'MODEL_ERROR_RECOVERY_FAILED',
    });
  }
  if (error instanceof Error && error.message.startsWith('Agent exceeded maxIterations:')) {
    return Object.freeze({
      code: 'LIMIT_EXCEEDED',
      message: 'The Agent exceeded its configured iteration limit.',
      retryable: false,
      causeCode: 'MAX_ITERATIONS_EXCEEDED',
    });
  }
  return Object.freeze({
    code: cancelled ? 'CANCELLED' : 'INTERNAL_ERROR',
    message: cancelled ? 'The Agent run was cancelled.' : 'The Agent run failed.',
    retryable: false,
    ...(cancelled ? {} : { causeCode: 'AGENT_RUNTIME_FAILED' }),
  });
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
