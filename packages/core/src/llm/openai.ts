import OpenAI, { type ClientOptions } from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import type {
  AgentAssistantMessage,
  AgentContext,
  AgentToolCall,
  ModelChatRequest,
  ModelChatResponse,
} from '../agent/types';
import { Model } from './base';

export interface OpenAIModelOptions extends ClientOptions {
  model: string;
  client?: OpenAI;
  defaultParams?: Omit<
    ChatCompletionCreateParamsNonStreaming,
    'messages' | 'model' | 'stream' | 'tools'
  >;
}

export class OpenAIModel extends Model {
  #openai: OpenAI;
  #model: string;
  #defaultParams: OpenAIModelOptions['defaultParams'];

  constructor(options: OpenAIModelOptions) {
    super();

    const { client, model, defaultParams, ...clientOptions } = options;

    this.#model = model;
    this.#defaultParams = defaultParams;
    this.#openai = client ?? new OpenAI(clientOptions);
  }

  async chat(request: ModelChatRequest): Promise<ModelChatResponse> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      ...this.#defaultParams,
      model: this.#model,
      messages: request.messages.map(toOpenAIMessage),
    };

    if (request.tools.length > 0) {
      params.tools = request.tools as ChatCompletionTool[];
    }

    const completion = await this.#openai.chat.completions.create(params);

    return {
      choices: completion.choices.map((choice) => ({
        index: choice.index,
        message: fromOpenAIMessage(choice.message),
        finishReason: choice.finish_reason,
        raw: choice,
      })),
      raw: completion,
    };
  }
}

function toOpenAIMessage(message: AgentContext): ChatCompletionMessageParam {
  if (message.role === 'system' || message.role === 'user') {
    return {
      role: message.role,
      content: message.content,
    };
  }

  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }

  const assistantMessage: ChatCompletionAssistantMessageParam = {
    role: 'assistant',
  };

  if (message.content !== null || !message.toolCalls?.length) {
    assistantMessage.content = message.content;
  }

  if (message.toolCalls?.length) {
    assistantMessage.tool_calls = message.toolCalls.map(toOpenAIToolCall);
  }

  return assistantMessage;
}

function toOpenAIToolCall(toolCall: AgentToolCall): ChatCompletionMessageToolCall {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
  };
}

function fromOpenAIMessage(message: ChatCompletionMessage): AgentAssistantMessage {
  const assistantMessage: AgentAssistantMessage = {
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : null,
  };

  if (message.tool_calls?.length) {
    assistantMessage.toolCalls = message.tool_calls
      .filter(
        (toolCall): toolCall is ChatCompletionMessageFunctionToolCall =>
          toolCall.type === 'function',
      )
      .map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      }));
  }

  return assistantMessage;
}
