import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions';

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
  OpenAIChatAssistantContextMessage,
  OpenAIChatAssistantMessage,
  OpenAIChatContext,
  OpenAIChatModelOptions,
  OpenAIChatProtocol,
  OpenAIChatSystemMessage,
  OpenAIChatTextPart,
  OpenAIChatTool,
  OpenAIChatToolCallOutputMessage,
  OpenAIChatUserContentPart,
  OpenAIChatUserContextMessage,
  OpenAIChatUserMessage,
} from './types';

export type * from './types';

/**
 * OpenAI-compatible Chat Completions 模型适配器。
 *
 * 该类把 Agent 的协议无关消息转换为 Chat `messages` / `tools`，并从
 * assistant `tool_calls[]` 中反解析本地工具调用。它只支持新版 tool calling
 * 闭环，不再暴露 deprecated `function_call` / `function` role。
 */
export class OpenAIChatModel extends Model<OpenAIChatProtocol> {
  #openai: OpenAI;
  #model: string;
  #defaultParams: OpenAIChatModelOptions['defaultParams'];

  /**
   * 创建 Chat Completions 适配器。
   *
   * 可以直接传入 OpenAI SDK `ClientOptions`，也可以通过 `client` 注入已配置好的
   * SDK 实例；`defaultParams` 会透传到每次非流式 Chat 请求。
   */
  constructor(options: OpenAIChatModelOptions) {
    super();

    const { client, model, defaultParams, ...clientOptions } = options;

    this.#model = model;
    this.#defaultParams = defaultParams;
    this.#openai = client ?? new OpenAI(clientOptions);
  }

  /**
   * 调用 Chat Completions，并将首个 choice 的 assistant message 原样返回给 Agent。
   *
   * 如果服务端成功响应但没有 choice，返回空数组，由 Agent 负责空响应重试。
   */
  async generate(
    request: ModelGenerateRequest<OpenAIChatProtocol>,
  ): Promise<ModelGenerateResult<OpenAIChatProtocol>> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      ...this.#defaultParams,
      model: this.#model,
      messages: request.context as unknown as ChatCompletionMessageParam[],
    };

    if (request.tools.length > 0) {
      params.tools = request.tools as unknown as ChatCompletionTool[];
    }

    const response = await this.#openai.chat.completions.create(params);
    const message = response.choices[0]?.message;

    return {
      messages: message ? [message as unknown as OpenAIChatContext] : [],
      raw: response,
    };
  }

  /**
   * 构建 Chat user message。
   *
   * Agent 基础文本 part 会转换为 Chat `text` part；协议专属的 `image_url`、
   * `input_audio`、`file` part 会被原样保留。
   */
  buildUserMessage(input: AgentBaseUserMessage | OpenAIChatUserMessage): OpenAIChatContext {
    return {
      role: 'user',
      content: input.content.map((part) =>
        part.type === 'text'
          ? {
              type: 'text',
              text: part.text,
            }
          : part,
      ),
      ...('name' in input && input.name ? { name: input.name } : {}),
    };
  }

  /** 构建 Chat system message，保留可选 `name` 字段。 */
  buildSystemMessage(input: AgentBaseSystemMessage | OpenAIChatSystemMessage): OpenAIChatContext {
    return {
      role: 'system',
      content: input.content,
      ...('name' in input && input.name ? { name: input.name } : {}),
    };
  }

  /** 构建 Chat `tool` role 消息，用于把本地工具结果回传给对应 `tool_call_id`。 */
  buildToolCallOutputMessage(
    input: AgentBaseToolCallOutputMessage | OpenAIChatToolCallOutputMessage,
  ): OpenAIChatContext {
    return {
      role: 'tool',
      tool_call_id: input.callId,
      content: input.output,
    };
  }

  /**
   * 构建 Chat function tool 声明。
   *
   * 参数 schema 在此处转换为 OpenAI-compatible JSON Schema；`strict` 只在调用方
   * 显式设置时透传。
   */
  buildToolMessage(input: AgentToolDefinitionInput): OpenAIChatTool {
    return {
      type: 'function',
      function: {
        name: input.name,
        description: input.description,
        parameters: toOpenAIToolParameters(input.parameters ?? getDefaultToolParametersSchema()),
        ...(input.strict === undefined ? {} : { strict: input.strict }),
      },
    };
  }

  /** 从混合 Chat context 中筛选 user 消息，并把字符串内容归一为 `text` part。 */
  parseUserMessages(
    context: readonly OpenAIChatContext[],
  ): readonly AgentParsedMessage<OpenAIChatUserMessage, OpenAIChatContext>[] {
    return context.flatMap((message) =>
      message.role === 'user'
        ? [
            {
              message: {
                content: parseUserContent(message.content),
                ...(message.name ? { name: message.name } : {}),
              },
              sourceMessage: message,
            },
          ]
        : [],
    );
  }

  /** 从混合 Chat context 中筛选 system 消息，并读取其中的文本内容。 */
  parseSystemMessages(
    context: readonly OpenAIChatContext[],
  ): readonly AgentParsedMessage<OpenAIChatSystemMessage, OpenAIChatContext>[] {
    return context.flatMap((message) =>
      message.role === 'system'
        ? [
            {
              message: {
                content: readTextContent(message.content),
                ...(message.name ? { name: message.name } : {}),
              },
              sourceMessage: message,
            },
          ]
        : [],
    );
  }

  /**
   * 从 Chat assistant 消息中解析文本输出和 refusal 内容。
   *
   * 该方法不解析工具调用；工具调用由 `parseToolCalls()` 单独按顺序展开。
   */
  parseAssistantMessages(
    context: readonly OpenAIChatContext[],
  ): readonly AgentParsedMessage<OpenAIChatAssistantMessage, OpenAIChatContext>[] {
    return context.flatMap((message) => {
      if (message.role !== 'assistant') {
        return [];
      }

      const parsed = parseAssistantContent(message.content);

      return [
        {
          message: {
            content: parsed.content,
            ...(parsed.refusals.length > 0 ? { refusals: parsed.refusals } : {}),
            ...(message.refusal !== undefined ? { refusal: message.refusal } : {}),
          },
          sourceMessage: message,
        },
      ];
    });
  }

  /**
   * 从 assistant `tool_calls[]` 中提取本地 function tool 调用。
   *
   * Chat custom tool call 会被保留在原始消息里，但不会映射为本地 `@Tool` 调用。
   */
  parseToolCalls(
    context: readonly OpenAIChatContext[],
  ): readonly AgentToolCall<OpenAIChatProtocol>[] {
    return context.flatMap((message) =>
      message.role === 'assistant'
        ? (message.tool_calls ?? []).flatMap((call) =>
            call.type === 'function'
              ? [
                  {
                    id: call.id,
                    name: call.function.name,
                    arguments: call.function.arguments,
                    sourceMessage: message,
                    sourceCall: call,
                  },
                ]
              : [],
          )
        : [],
    );
  }

  /** 从 Chat `tool` role message 中解析工具结果。 */
  parseToolCallOutputMessages(
    context: readonly OpenAIChatContext[],
  ): readonly AgentParsedMessage<OpenAIChatToolCallOutputMessage, OpenAIChatContext>[] {
    return context.flatMap((message) =>
      message.role === 'tool'
        ? [
            {
              message: {
                callId: message.tool_call_id,
                output: readTextContent(message.content),
              },
              sourceMessage: message,
            },
          ]
        : [],
    );
  }
}

function parseUserContent(
  content: OpenAIChatUserContextMessage['content'],
): OpenAIChatUserContentPart[] {
  // SDK 允许 user content 是字符串；框架解析结果统一暴露为内容块数组。
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  return content.map((part) => (part.type === 'text' ? { type: 'text', text: part.text } : part));
}

function readTextContent(content: string | readonly OpenAIChatTextPart[]): string {
  return typeof content === 'string' ? content : content.map((part) => part.text).join('');
}

function parseAssistantContent(content: OpenAIChatAssistantContextMessage['content']): {
  content: AgentTextPart[];
  refusals: string[];
} {
  // assistant content 可能为空，尤其是仅返回 tool_calls 的场景。
  if (typeof content === 'string') {
    return { content: [{ type: 'text', text: content }], refusals: [] };
  }

  if (!content) {
    return { content: [], refusals: [] };
  }

  return {
    content: content.flatMap((part) =>
      part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : [],
    ),
    refusals: content.flatMap((part) => (part.type === 'refusal' ? [part.refusal] : [])),
  };
}
