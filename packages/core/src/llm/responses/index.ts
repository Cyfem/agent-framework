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
} from '../../agent/types';
import { Model, type ModelGenerateRequest, type ModelGenerateResult } from '../base';
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

    if (request.tools.length > 0) {
      params.tools = request.tools as unknown as ResponseTool[];
    }

    const response = await this.#openai.responses.create(params);

    return {
      messages: response.output as unknown as readonly OpenAIResponsesContext[],
      raw: response,
    };
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
