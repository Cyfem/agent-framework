import { z } from 'zod';

import { getDecoratedTools, Tool } from './decorators';
import { getDefaultToolParametersSchema, toOpenAIToolParameters } from './schema';
import type {
  AfterToolCallCallback,
  AgentContext,
  AgentErrorCallback,
  AgentOptions,
  AgentSkill,
  AgentStatus,
  AgentStatusChangedCallback,
  AgentToolCall,
  AgentToolMessage,
  BeforeToolCallCallback,
  ModelResponseCallback,
  ModelToolDefinition,
  ToolCallErrorCallback,
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

export class Agent {
  #rawContext: AgentContext[] = [];
  #context: AgentContext[] = [];
  #skills: AgentSkill[] = [];
  #tools: ToolRuntimeDefinition[] = [];
  #toolsCollected = false;
  #systemPrompts: string[] = [];
  #status: AgentStatus = 'idle';
  #maxIterations: number | undefined;
  #llm: AgentOptions['llm'];

  #beforeToolListeners: ToolEventListener<BeforeToolCallCallback>[] = [];
  #afterToolListeners: ToolEventListener<AfterToolCallCallback>[] = [];
  #toolCallErrorListeners: ToolCallErrorCallback[] = [];
  #statusListeners: AgentStatusListener[] = [];
  #modelResponseListeners: ModelResponseCallback[] = [];

  #agentErrorListeners: AgentErrorCallback[] = [];

  constructor(options: AgentOptions) {
    this.#llm = options.llm;
    this.#maxIterations = options.maxIterations;

    if (
      this.#maxIterations !== undefined &&
      (this.#maxIterations < 1 || !Number.isInteger(this.#maxIterations))
    ) {
      throw new Error('maxIterations must be a positive integer.');
    }

    this.addSkill(...(options.skills ?? []));
    this.addSystemPrompts(...(options.systemPrompts ?? []));
  }

  getHistory(): readonly AgentContext[] {
    return [...this.#rawContext];
  }

  getContext(): readonly AgentContext[] {
    return [...this.#context];
  }

  addSystemPrompts(...prompts: string[]): this {
    for (const prompt of prompts) {
      if (prompt.trim().length > 0) {
        this.#systemPrompts.push(prompt);
      }
    }

    return this;
  }

  addSkill(...skills: AgentSkill[]): this {
    this.#skills.push(...skills);
    return this;
  }

  onModelResponse(callback: ModelResponseCallback): Unsubscribe {
    return addListener(this.#modelResponseListeners, callback);
  }

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

  onToolCallError(callback: ToolCallErrorCallback): Unsubscribe {
    return addListener(this.#toolCallErrorListeners, callback);
  }

  onAgentStatusChanged(status: AgentStatus, callback: AgentStatusChangedCallback): Unsubscribe {
    return addListener(this.#statusListeners, {
      status,
      callback,
    });
  }

  onAgentError(callback: AgentErrorCallback): Unsubscribe {
    return addListener(this.#agentErrorListeners, callback);
  }

  @Tool({
    name: 'get-skill',
    description: ({ skills }) => {
      const skillList =
        skills.length === 0
          ? '当前没有可查询的技能手册。'
          : skills
              .map(
                (skill, index) =>
                  `技能手册${index}：\n名称：${skill.name}\n描述：${skill.description}`,
              )
              .join('\n\n');

      return [
        '这是一个技能手册查询工具，当正在执行的任务匹配到如下的技能手册描述时，应当先使用该工具查询手册具体内容，然后看手册内有无具体解决该任务的工作流；如果匹配到具体工作流，则使用该工作流解决问题。',
        skillList,
      ].join('\n\n');
    },
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

  async toolCall(callInfo: AgentToolCall): Promise<AgentToolMessage> {
    this.#ensureToolsCollected();

    const tool = this.#tools.find((candidate) => candidate.name === callInfo.name);
    const fallbackParameters: unknown = {};

    if (!tool) {
      const error = new Error(`Unknown tool: ${callInfo.name}`);
      await this.#emitToolCallError(callInfo.name, 'calling', error, fallbackParameters, callInfo);
      return createToolMessage(callInfo.id, normalizeErrorMessage(error));
    }

    const parsedArguments = await this.#parseToolArguments(tool, callInfo);

    if (!parsedArguments.ok) {
      return createToolMessage(callInfo.id, parsedArguments.message);
    }

    const parameters = parsedArguments.parameters;
    const beforeResult = await this.#runBeforeToolListeners(tool.name, parameters, callInfo);

    if (beforeResult.canceled) {
      return createToolMessage(
        callInfo.id,
        `${beforeToolErrorPrefix}${normalizeErrorMessage(beforeResult.error)}`,
      );
    }

    let result: unknown;

    try {
      result = await tool.handler(parameters);
    } catch (error) {
      await this.#emitToolCallError(tool.name, 'calling', error, parameters, callInfo);
      return createToolMessage(callInfo.id, normalizeErrorMessage(error));
    }

    await this.#runAfterToolListeners(tool.name, parameters, callInfo, result);

    return createToolMessage(callInfo.id, serializeToolResult(result));
  }

  async agent(message: string, stream = false): Promise<AgentContext[]> {
    try {
      if (stream) {
        throw new Error('Agent streaming is not supported in this version.');
      }

      if (this.#status === 'running') {
        throw new Error('Agent is already running.');
      }

      this.#appendMessage({
        role: 'user',
        content: message,
      });

      this.#changeStatus('running');

      for (
        let iteration = 0;
        this.#maxIterations === undefined || iteration < this.#maxIterations;
        iteration += 1
      ) {
        const response = await this.#chatWithEmptyChoiceRetry();
        const choice = response.choices[0];

        if (!choice) {
          throw new Error('Model returned no choices.');
        }

        await this.#emitModelResponse(choice.message);
        this.#appendMessage(choice.message);

        const toolCalls = choice.message.toolCalls ?? [];

        for (const toolCall of toolCalls) {
          const resultMessage = await this.toolCall(toolCall);
          this.#appendMessage(resultMessage);
        }

        if (this.#status === 'ended') {
          return [...this.#context];
        }
      }

      throw new Error(`Agent exceeded maxIterations: ${this.#maxIterations}.`);
    } catch (error) {
      const agentError = toError(error);

      if (this.#status !== 'ended') {
        this.#changeStatus('failed');
      }

      this.#emitAgentError(agentError);

      throw error instanceof Error ? error : agentError;
    }
  }

  #collectTools(): ToolRuntimeDefinition[] {
    const tools = getDecoratedTools(this);
    const seen = new Set<string>();

    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }

      seen.add(tool.name);
    }

    return tools;
  }

  #ensureToolsCollected(): void {
    if (this.#toolsCollected) {
      return;
    }

    this.#tools = this.#collectTools();
    this.#toolsCollected = true;
  }

  #buildMessagesForModel(): AgentContext[] {
    const systemMessages: AgentContext[] = [internalEndAgentPrompt, ...this.#systemPrompts].map(
      (content) => ({
        role: 'system',
        content,
      }),
    );

    return [...systemMessages, ...this.#context];
  }

  #buildToolsForModel(): ModelToolDefinition[] {
    this.#ensureToolsCollected();

    return this.#tools.map((tool) => {
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
              context: [...this.#context],
              history: [...this.#rawContext],
              systemPrompts: [...this.#systemPrompts],
              tool: toolContext,
            })
          : tool.description;

      return {
        type: 'function',
        function: {
          name: tool.name,
          description,
          parameters: toOpenAIToolParameters(tool.parameters ?? getDefaultToolParametersSchema()),
        },
      };
    });
  }

  async #chatWithEmptyChoiceRetry() {
    let lastResponseText = 'Model returned no choices.';

    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const response = await this.#llm.chat({
        messages: this.#buildMessagesForModel(),
        tools: this.#buildToolsForModel(),
      });

      if (response.choices.length > 0) {
        return response;
      }

      lastResponseText = `Model returned no choices after ${attempt + 1} attempt(s).`;
    }

    throw new Error(lastResponseText);
  }

  async #parseToolArguments(
    tool: ToolRuntimeDefinition,
    callInfo: AgentToolCall,
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
    message: AgentToolCall,
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
    message: AgentToolCall,
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
        await this.#emitToolCallError(toolName, 'after', error, parameters, message, result);
      }
    }
  }

  async #emitModelResponse(message: AgentContext): Promise<void> {
    for (const listener of this.#modelResponseListeners) {
      try {
        await listener(message);
      } catch {
        // Model response listeners are observers and should not break the agent loop.
      }
    }
  }

  async #emitToolCallError(
    name: string,
    triggerType: 'before' | 'calling' | 'after',
    error: unknown,
    parameters: unknown,
    message: AgentToolCall,
    result?: unknown,
  ): Promise<void> {
    for (const listener of this.#toolCallErrorListeners) {
      try {
        await listener(name, triggerType, error, parameters, message, result);
      } catch {
        // Tool error listeners are observers and should not create new tool errors.
      }
    }
  }

  #emitAgentError(error: Error): void {
    for (const listener of this.#agentErrorListeners) {
      try {
        const result = listener(error);

        void Promise.resolve(result).catch((listenerError: unknown) => {
          void listenerError;
          // console.error('Error in agent error listener:', listenerError);
        });
      } catch (listenerError) {
        void listenerError;
        // Agent error listeners are observers and should not create new errors
        // console.error('Error in agent error listener:', listenerError);
      }
    }
  }

  #appendMessage(message: AgentContext): void {
    this.#rawContext.push(message);
    this.#context.push(message);
  }

  #changeStatus(status: AgentStatus): void {
    if (this.#status === status) {
      return;
    }

    this.#status = status;

    for (const listener of this.#statusListeners.filter((item) => item.status === status)) {
      void Promise.resolve(listener.callback([...this.#rawContext], [...this.#context])).catch(
        () => {
          // Status listeners are observers and should not break state transitions.
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

function createToolMessage(toolCallId: string, content: string): AgentToolMessage {
  return {
    role: 'tool',
    content,
    toolCallId,
  };
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

export { Tool };
export type * from './types';
