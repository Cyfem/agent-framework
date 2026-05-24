import type OpenAI from 'openai';
import type { ClientOptions } from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions/completions';

import type {
  AgentBaseToolCallOutputMessage,
  AgentProtocol,
  AgentTextPart,
  JsonObject,
} from '../../agent/types';

/** Chat 用户消息中的文本内容块。 */
export interface OpenAIChatTextPart {
  type: 'text';
  text: string;
}

/** Chat 用户消息中的图片内容块。 */
export interface OpenAIChatImagePart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

/** Chat 用户消息中的音频内容块。 */
export interface OpenAIChatInputAudioPart {
  type: 'input_audio';
  input_audio: {
    data: string;
    format: 'wav' | 'mp3';
  };
}

/** Chat 用户消息中的文件内容块。 */
export interface OpenAIChatFilePart {
  type: 'file';
  file: {
    file_data?: string;
    file_id?: string;
    filename?: string;
  };
}

/** Chat assistant 消息中的拒绝内容块。 */
export interface OpenAIChatRefusalPart {
  type: 'refusal';
  refusal: string;
}

/** 应用可通过 `buildUserMessage()` 写入 Chat user message 的内容块集合。 */
export type OpenAIChatUserContentPart =
  | AgentTextPart
  | OpenAIChatImagePart
  | OpenAIChatInputAudioPart
  | OpenAIChatFilePart;

/** 应用通过 builder 构建的 Chat 用户消息。 */
export interface OpenAIChatUserMessage {
  content: readonly OpenAIChatUserContentPart[];
  name?: string;
}

/** 应用通过 builder 构建的 Chat system 消息。 */
export interface OpenAIChatSystemMessage {
  content: string;
  name?: string;
}

/** 从 Chat assistant 消息解析出的标准文本及拒绝内容。 */
export interface OpenAIChatAssistantMessage {
  content: readonly AgentTextPart[];
  refusals?: readonly string[];
  refusal?: string | null;
}

/** Chat 工具结果 builder 使用的基础结构，对应请求中的 `tool` role message。 */
export type OpenAIChatToolCallOutputMessage = AgentBaseToolCallOutputMessage;

/** Agent 可以执行的 Chat function tool call。 */
export interface OpenAIChatRawToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Chat API 可能返回但不映射到本地 `@Tool` 的 custom tool call。 */
export interface OpenAIChatCustomToolCall {
  id: string;
  type: 'custom';
  custom: {
    name: string;
    input: string;
  };
}

/** Chat assistant message 中可能出现的工具调用类型集合。 */
export type OpenAIChatToolCall = OpenAIChatRawToolCall | OpenAIChatCustomToolCall;

/** Chat developer message；当前 parser 不单独抽象 developer，但 context 会原样保留。 */
export interface OpenAIChatDeveloperContextMessage {
  role: 'developer';
  content: string | readonly OpenAIChatTextPart[];
  name?: string;
}

/** Chat user message，可由 builder 创建，也可来自初始化上下文。 */
export interface OpenAIChatUserContextMessage {
  role: 'user';
  content: string | readonly OpenAIChatUserContentPart[];
  name?: string;
}

/** Chat system message，用于框架提示词和调用方 system prompt。 */
export interface OpenAIChatSystemContextMessage {
  role: 'system';
  content: string | readonly OpenAIChatTextPart[];
  name?: string;
}

/** Chat 音频输出引用；assistant message 可以仅携带引用而不内联音频。 */
export interface OpenAIChatAudioReference {
  id: string;
}

/** Chat 音频输出内容；保留 SDK 返回的音频数据、过期时间和转写文本。 */
export interface OpenAIChatResponseAudio extends OpenAIChatAudioReference {
  data: string;
  expires_at: number;
  transcript: string;
}

/** Chat 文本输出中的 URL citation 注解。 */
export interface OpenAIChatUrlCitationAnnotation {
  type: 'url_citation';
  url_citation: {
    start_index: number;
    end_index: number;
    title: string;
    url: string;
  };
}

/** Chat assistant message；工具调用由 `tool_calls` 承载。 */
export interface OpenAIChatAssistantContextMessage {
  role: 'assistant';
  content?: string | readonly (OpenAIChatTextPart | OpenAIChatRefusalPart)[] | null;
  audio?: OpenAIChatAudioReference | OpenAIChatResponseAudio | null;
  annotations?: readonly OpenAIChatUrlCitationAnnotation[];
  name?: string;
  refusal?: string | null;
  tool_calls?: readonly OpenAIChatToolCall[];
}

/** Chat 工具结果消息，对应某个 assistant `tool_calls[]` 项。 */
export interface OpenAIChatToolContextMessage {
  role: 'tool';
  tool_call_id: string;
  content: string | readonly OpenAIChatTextPart[];
}

/** Chat 协议上下文消息集合，只保留新版 tool_calls / tool role 工具闭环。 */
export type OpenAIChatContext =
  | OpenAIChatDeveloperContextMessage
  | OpenAIChatUserContextMessage
  | OpenAIChatSystemContextMessage
  | OpenAIChatAssistantContextMessage
  | OpenAIChatToolContextMessage;

/** Chat Completions function tool wire structure。 */
export interface OpenAIChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
    strict?: boolean;
  };
}

/** Chat 协议下 Agent 与 Model 共享的关联类型。 */
export interface OpenAIChatProtocol extends AgentProtocol {
  context: OpenAIChatContext;
  tool: OpenAIChatTool;
  userMessage: OpenAIChatUserMessage;
  systemMessage: OpenAIChatSystemMessage;
  assistantMessage: OpenAIChatAssistantMessage;
  toolCallOutputMessage: OpenAIChatToolCallOutputMessage;
  rawToolCall: OpenAIChatRawToolCall;
  rawResponse: ChatCompletion;
}

/** 基于 OpenAI SDK 的 Chat Completions 适配器配置。 */
export interface OpenAIChatModelOptions extends ClientOptions {
  model: string;
  client?: OpenAI;
  defaultParams?: Omit<
    ChatCompletionCreateParamsNonStreaming,
    'messages' | 'model' | 'stream' | 'tools'
  >;
}
