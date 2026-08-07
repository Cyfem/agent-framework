import { createReadStream } from 'node:fs';

import OpenAI from 'openai';
import type { FileCreateParams } from 'openai/resources/files';
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInput,
  Tool as ResponseTool,
} from 'openai/resources/responses/responses';

import { getDefaultToolParametersSchema } from '../../agent/schema';
import type {
  AgentBaseSystemMessage,
  AgentBaseToolCallOutputMessage,
  AgentBaseUserMessage,
  AgentParsedMessage,
  AgentTextPart,
  AgentToolCall,
  AgentToolDefinitionInput,
  ModelErrorDescriptor,
  ToolPayloadReplacements,
} from '../../agent/types';
import { OPENAI_RESPONSES_CHECKPOINT_CODEC } from '../../subagent/checkpoint';
import type { SubAgentTransportModelProtocolSurface } from '../../subagent/transport-model-gateway';
import { markAuditedSubAgentTransportModelProtocolSurface } from '../../subagent/transport-model-protocol-surface';
import { createAbortScope, throwIfAborted } from '../base/abort';
import { Model, type ModelGenerateRequest, type ModelGenerateResult } from '../base';
import { classifyOpenAICompatibleError } from '../openai-error';
import { toOpenAIToolParameters } from '../openai-schema';
import type {
  OpenAIFileObject,
  OpenAIFileUploadOptions,
  OpenAIResponsesAssistantMessage,
  OpenAIResponsesContext,
  OpenAIResponsesFunctionCallOutput,
  OpenAIResponsesInputMessage,
  OpenAIResponsesModelOptions,
  OpenAIResponsesProtocol,
  OpenAIResponsesSystemMessage,
  OpenAIResponsesTool,
  OpenAIResponsesToolCallOutputMessage,
  OpenAIResponsesUserExtensionPart,
  OpenAIResponsesUserMessage,
} from './types';

export type * from './types';

/**
 * OpenAI-compatible Responses 模型适配器，提供标准 Files 上传能力。
 *
 * 该适配器把 Agent 基础消息构建为 Responses `input` 项，并把服务端返回的
 * `output` item 原样交给 Agent 保存和回传；只有 `function_call` 会被解析为
 * 本地工具调用。
 */
export class OpenAIResponsesModel extends Model<OpenAIResponsesProtocol> {
  override readonly checkpointCodec = OPENAI_RESPONSES_CHECKPOINT_CODEC;
  override readonly providerMaxRetries = 0;

  #openai: OpenAI;
  #model: string;
  #defaultParams: OpenAIResponsesModelOptions['defaultParams'];

  /**
   * 创建 Responses 适配器。
   *
   * `baseURL`、`apiKey` 等 OpenAI SDK 配置可直接透传；方舟 `api/v3` 兼容
   * endpoint 也通过这里配置。`defaultParams` 会合入每次非流式 Responses 请求。
   */
  constructor(options: OpenAIResponsesModelOptions) {
    super();

    const { client, model, defaultParams, ...clientOptions } = options;

    this.#model = model;
    this.#defaultParams = defaultParams;
    this.#openai = client ?? new OpenAI(clientOptions);
  }

  /**
   * 调用 Responses API，并将完整 `response.output` 作为协议 context 返回。
   *
   * Agent 不会裁剪这些 output item；如服务端返回空 output，则由 Agent 处理重试。
   */
  async generate(
    request: ModelGenerateRequest<OpenAIResponsesProtocol>,
  ): Promise<ModelGenerateResult<OpenAIResponsesProtocol>> {
    const params: ResponseCreateParamsNonStreaming = {
      ...this.#defaultParams,
      model: this.#model,
      input: request.context as unknown as ResponseInput,
    };

    if (request.purpose === 'context-summary') {
      deleteToolOnlyResponsesParams(params);
    } else if (request.tools.length > 0) {
      params.tools = request.tools as unknown as ResponseTool[];
    }

    throwIfAborted(request.signal, request.deadlineAt);
    const deadlineScope =
      request.signal === undefined && request.deadlineAt !== undefined
        ? createAbortScope(undefined, request.deadlineAt)
        : undefined;
    const signal = request.signal ?? deadlineScope?.signal;

    try {
      const response = await this.#openai.responses.create(params, {
        maxRetries: 0,
        ...(signal === undefined ? {} : { signal }),
      });

      return {
        messages: response.output as unknown as readonly OpenAIResponsesContext[],
        ...(response.usage === undefined
          ? {}
          : {
              usage: {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                totalTokens: response.usage.total_tokens,
              },
            }),
        raw: response,
      };
    } finally {
      deadlineScope?.dispose();
    }
  }

  /**
   * 构建 Responses user input message。
   *
   * 基础 `{ type: "text" }` 会转换为 `input_text`；已声明的图片、文件、视频、
   * 音频扩展 part 会按 Responses/方舟兼容字段原样保留。
   */
  buildUserMessage(
    input: AgentBaseUserMessage | OpenAIResponsesUserMessage,
  ): OpenAIResponsesInputMessage {
    return {
      role: 'user',
      content: input.content.map((part) =>
        part.type === 'text'
          ? {
              type: 'input_text',
              text: part.text,
            }
          : part,
      ),
    };
  }

  /** 构建 Responses system input message，用于框架内部提示词和调用方 system prompt。 */
  buildSystemMessage(
    input: AgentBaseSystemMessage | OpenAIResponsesSystemMessage,
  ): OpenAIResponsesInputMessage {
    return {
      role: 'system',
      content: [{ type: 'input_text', text: input.content }],
    };
  }

  /** 构建 Responses `function_call_output` item，用于把本地工具结果回传给模型。 */
  buildToolCallOutputMessage(
    input: AgentBaseToolCallOutputMessage | OpenAIResponsesToolCallOutputMessage,
  ): OpenAIResponsesFunctionCallOutput {
    return {
      type: 'function_call_output',
      call_id: input.callId,
      output: input.output,
    };
  }

  /**
   * 构建 Responses function tool 声明。
   *
   * 参数 schema 在此处转换为 OpenAI-compatible JSON Schema；`strict` 只在工具
   * 显式声明时出现在请求中。
   */
  buildToolMessage(input: AgentToolDefinitionInput): OpenAIResponsesTool {
    return {
      type: 'function',
      name: input.name,
      description: input.description,
      parameters: toOpenAIToolParameters(input.parameters ?? getDefaultToolParametersSchema()),
      ...(input.strict === undefined ? {} : { strict: input.strict }),
    };
  }

  /** 从混合 Responses context 中筛选 user input message，并反解析多模态内容块。 */
  parseUserMessages(
    context: readonly OpenAIResponsesContext[],
  ): readonly AgentParsedMessage<OpenAIResponsesUserMessage, OpenAIResponsesContext>[] {
    return context.flatMap((message) =>
      isInputMessage(message, 'user')
        ? [
            {
              message: { content: parseInputParts(message.content) },
              sourceMessage: message,
            },
          ]
        : [],
    );
  }

  /** 从混合 Responses context 中筛选 system input message，并读取文本提示词。 */
  parseSystemMessages(
    context: readonly OpenAIResponsesContext[],
  ): readonly AgentParsedMessage<OpenAIResponsesSystemMessage, OpenAIResponsesContext>[] {
    return context.flatMap((message) =>
      isInputMessage(message, 'system')
        ? [
            {
              message: { content: readInputText(message.content) },
              sourceMessage: message,
            },
          ]
        : [],
    );
  }

  /**
   * 从 Responses assistant output message 中解析文本和 refusal。
   *
   * `reasoning` 等 provider 专属 item 保留在原始 context 中，不映射为 assistant 文本。
   */
  parseAssistantMessages(
    context: readonly OpenAIResponsesContext[],
  ): readonly AgentParsedMessage<OpenAIResponsesAssistantMessage, OpenAIResponsesContext>[] {
    return context.flatMap((message) => {
      if (message.type !== 'message' || message.role !== 'assistant' || !('id' in message)) {
        return [];
      }

      return [
        {
          message: {
            content: message.content.flatMap((part) =>
              part.type === 'output_text' ? [{ type: 'text' as const, text: part.text }] : [],
            ),
            refusals: message.content.flatMap((part) =>
              part.type === 'refusal' ? [part.refusal] : [],
            ),
          },
          sourceMessage: message,
        },
      ];
    });
  }

  /** 从 Responses `function_call` item 中提取本地工具调用。 */
  parseToolCalls(
    context: readonly OpenAIResponsesContext[],
  ): readonly AgentToolCall<OpenAIResponsesProtocol>[] {
    return context.flatMap((message) =>
      message.type === 'function_call'
        ? [
            {
              id: message.call_id,
              name: message.name,
              arguments: message.arguments,
              sourceMessage: message,
              sourceCall: message,
            },
          ]
        : [],
    );
  }

  /** 从 Responses `function_call_output` item 中解析工具结果，保留字符串或内容数组 output。 */
  parseToolCallOutputMessages(
    context: readonly OpenAIResponsesContext[],
  ): readonly AgentParsedMessage<OpenAIResponsesToolCallOutputMessage, OpenAIResponsesContext>[] {
    return context.flatMap((message) =>
      message.type === 'function_call_output'
        ? [
            {
              message: {
                callId: message.call_id,
                output: message.output,
              },
              sourceMessage: message,
            },
          ]
        : [],
    );
  }

  /** Copy-on-write 改写 Responses function_call 与 function_call_output。 */
  rewriteToolPayloads(
    context: readonly OpenAIResponsesContext[],
    replacements: ToolPayloadReplacements<OpenAIResponsesProtocol>,
  ): readonly OpenAIResponsesContext[] {
    const rewritten = [...context];
    const inputTargets = new Map<number, string>();
    const resultTargets = new Map<number, string>();

    for (const replacement of replacements.inputs) {
      const messageIndex = findUniqueMessageIndex(
        context,
        replacement.sourceMessage,
        'Responses tool input replacement',
      );
      const message = context[messageIndex];

      if (message?.type !== 'function_call' || message !== replacement.sourceCall) {
        throw new Error(
          'Responses tool input replacement must identify the same function_call as sourceMessage and sourceCall.',
        );
      }
      if (inputTargets.has(messageIndex)) {
        throw new Error('Responses tool input replacement targets the same call more than once.');
      }
      inputTargets.set(messageIndex, replacement.replacement);
    }

    for (const replacement of replacements.results) {
      const messageIndex = findUniqueMessageIndex(
        context,
        replacement.sourceMessage,
        'Responses tool result replacement',
      );
      const message = context[messageIndex];

      if (message?.type !== 'function_call_output' || message.call_id !== replacement.callId) {
        throw new Error(
          'Responses tool result replacement sourceMessage must be a function_call_output with the same call id.',
        );
      }
      if (resultTargets.has(messageIndex)) {
        throw new Error(
          'Responses tool result replacement targets the same message more than once.',
        );
      }
      resultTargets.set(messageIndex, replacement.replacement);
    }

    for (const [messageIndex, replacement] of inputTargets) {
      const message = context[messageIndex];
      if (message?.type !== 'function_call') {
        throw new Error('Responses tool input replacement target changed during rewrite.');
      }
      rewritten[messageIndex] = {
        ...message,
        arguments: replacement,
      };
    }

    for (const [messageIndex, replacement] of resultTargets) {
      const message = context[messageIndex];
      if (message?.type !== 'function_call_output') {
        throw new Error('Responses tool result replacement target changed during rewrite.');
      }
      rewritten[messageIndex] = {
        ...message,
        output: replacement,
      };
    }

    return rewritten;
  }

  /** 使用共享 OpenAI-compatible 规则识别 context-length 等 provider 错误。 */
  classifyError(error: unknown): ModelErrorDescriptor {
    return classifyOpenAICompatibleError(error);
  }

  /**
   * 上传本地文件，供后续 Responses 输入内容块通过 `file_id` 引用。
   *
   * 默认 `purpose` 为 `user_data`，适合截图、文档等用户输入材料；返回值为
   * OpenAI SDK 的标准 FileObject。
   */
  async uploadFile(
    filePath: string,
    options: OpenAIFileUploadOptions = {},
  ): Promise<OpenAIFileObject> {
    return this.#openai.files.create({
      file: createReadStream(filePath),
      purpose: options.purpose ?? 'user_data',
    } as FileCreateParams);
  }
}

/** Credential-free Responses protocol surface for Worker/Process/remote Model proxies. */
export function createOpenAIResponsesProtocolSurface(): SubAgentTransportModelProtocolSurface<OpenAIResponsesProtocol> {
  const prototype = OpenAIResponsesModel.prototype;
  const protocolSurface: SubAgentTransportModelProtocolSurface<OpenAIResponsesProtocol> = {
    checkpointCodec: OPENAI_RESPONSES_CHECKPOINT_CODEC,
    buildUserMessage: (input) => prototype.buildUserMessage(input),
    buildSystemMessage: (input) => prototype.buildSystemMessage(input),
    buildToolCallOutputMessage: (input) => prototype.buildToolCallOutputMessage(input),
    buildToolMessage: (input) => prototype.buildToolMessage(input),
    parseUserMessages: (context) => prototype.parseUserMessages(context),
    parseSystemMessages: (context) => prototype.parseSystemMessages(context),
    parseAssistantMessages: (context) => prototype.parseAssistantMessages(context),
    parseToolCalls: (context) => prototype.parseToolCalls(context),
    parseToolCallOutputMessages: (context) => prototype.parseToolCallOutputMessages(context),
    rewriteToolPayloads: (context, replacements) =>
      prototype.rewriteToolPayloads(context, replacements),
    extractAssistantText: (context) =>
      prototype.parseAssistantMessages(context).flatMap(({ message }) => {
        const text = message.content.map((part) => part.text).join('');
        return text.length === 0 ? [] : [text];
      }),
    classifyError: (error) => prototype.classifyError(error),
  };
  return markAuditedSubAgentTransportModelProtocolSurface(Object.freeze(protocolSurface));
}

function deleteToolOnlyResponsesParams(params: ResponseCreateParamsNonStreaming): void {
  const mutable = params as ResponseCreateParamsNonStreaming & Record<string, unknown>;

  delete mutable.tools;
  delete mutable.tool_choice;
  delete mutable.parallel_tool_calls;
  delete mutable.max_tool_calls;
}

function findUniqueMessageIndex(
  context: readonly OpenAIResponsesContext[],
  sourceMessage: OpenAIResponsesContext,
  label: string,
): number {
  const indexes = context.flatMap((message, index) => (message === sourceMessage ? [index] : []));
  if (indexes.length !== 1) {
    throw new Error(`${label} sourceMessage must match exactly once; matched ${indexes.length}.`);
  }

  return indexes[0]!;
}

function parseInputParts(
  content: OpenAIResponsesInputMessage['content'],
): Array<AgentTextPart | OpenAIResponsesUserExtensionPart> {
  // 兼容历史或外部手写 context 中仍以字符串保存的 input 内容。
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  return content.map((part) =>
    part.type === 'input_text' ? { type: 'text', text: part.text } : part,
  );
}

function readInputText(content: OpenAIResponsesInputMessage['content']): string {
  // system/developer/user input 中可能混有多模态 part；system parser 只提取文本。
  if (typeof content === 'string') {
    return content;
  }

  return content.flatMap((part) => (part.type === 'input_text' ? [part.text] : [])).join('\n');
}

function isInputMessage(
  message: OpenAIResponsesContext,
  role: 'system' | 'user',
): message is OpenAIResponsesInputMessage {
  // 模型 output message 也可能有 role 字段；带 id 的项视为响应，不作为 input 解析。
  return 'role' in message && message.role === role && !('id' in message);
}
