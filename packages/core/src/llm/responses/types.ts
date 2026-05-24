import type OpenAI from 'openai';
import type { ClientOptions } from 'openai';
import type { FileObject } from 'openai/resources/files';
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';

import type {
  AgentBaseSystemMessage,
  AgentProtocol,
  AgentTextPart,
  JsonObject,
} from '../../agent/types';

/** 与 OpenAI Files 对齐的上传选项；当前视觉流程仅需要 `user_data`。 */
export interface OpenAIFileUploadOptions {
  purpose?: 'user_data';
}

/** Files API 返回的标准 OpenAI 文件对象。 */
export type OpenAIFileObject = FileObject;

/** Responses `input_text` 内容块，Agent 基础 text part 会被 builder 转成该结构。 */
export interface OpenAIResponsesInputTextPart {
  type: 'input_text';
  text: string;
}

/** 方舟兼容 endpoint 为图片输入提供的像素上下限控制。 */
export interface OpenAIResponsesImagePixelLimit {
  min_pixels?: number;
  max_pixels?: number;
}

/**
 * Responses 图片输入。
 *
 * `file_id` / `image_url` 来自标准 Responses 协议；`xhigh` 与
 * `image_pixel_limit` 是方舟 `api/v3` 明确声明的兼容能力。
 */
export interface OpenAIResponsesInputImagePart {
  type: 'input_image';
  file_id?: string | null;
  image_url?: string | null;
  detail?: 'auto' | 'low' | 'high' | 'original' | 'xhigh';
  image_pixel_limit?: OpenAIResponsesImagePixelLimit | null;
}

/** Responses 文件输入内容块，可通过 file id、文件 URL 或内联文件数据引用。 */
export interface OpenAIResponsesInputFilePart {
  type: 'input_file';
  detail?: 'low' | 'high';
  file_data?: string | null;
  file_id?: string | null;
  file_url?: string | null;
  filename?: string | null;
}

/** 方舟 `api/v3` 显式提供的视频输入内容块。 */
export interface OpenAIResponsesInputVideoPart {
  type: 'input_video';
  file_id?: string | null;
  video_url?: string | null;
  fps?: number;
}

/** 方舟 `api/v3` 显式提供的音频输入内容块。 */
export interface OpenAIResponsesInputAudioPart {
  type: 'input_audio';
  file_id?: string | null;
  audio_url?: string | null;
}

/** Responses user input 中除基础文本外允许的协议扩展内容块。 */
export type OpenAIResponsesUserExtensionPart =
  | OpenAIResponsesInputImagePart
  | OpenAIResponsesInputFilePart
  | OpenAIResponsesInputVideoPart
  | OpenAIResponsesInputAudioPart;

/** 应用交给 Responses builder 的用户消息结构。 */
export interface OpenAIResponsesUserMessage {
  content: readonly (AgentTextPart | OpenAIResponsesUserExtensionPart)[];
}

/** Responses system builder 使用的基础消息结构。 */
export type OpenAIResponsesSystemMessage = AgentBaseSystemMessage;

/** 从 Responses assistant output message 反解析出的文本和 refusal。 */
export interface OpenAIResponsesAssistantMessage {
  content: readonly AgentTextPart[];
  refusals?: readonly string[];
}

/** `function_call_output.output` 允许携带的非字符串内容块。 */
export type OpenAIResponsesFunctionCallOutputContentPart =
  | OpenAIResponsesInputTextPart
  | OpenAIResponsesInputImagePart
  | OpenAIResponsesInputFilePart;

/** Responses 工具结果 output，既可为字符串，也可为 OpenAI SDK 支持的内容数组。 */
export type OpenAIResponsesFunctionCallOutputValue =
  | string
  | readonly OpenAIResponsesFunctionCallOutputContentPart[];

/** 应用或 Agent 交给工具结果 builder 的结构。 */
export interface OpenAIResponsesToolCallOutputMessage {
  callId: string;
  output: OpenAIResponsesFunctionCallOutputValue;
}

/** Responses item 常见执行状态。 */
export type OpenAIResponsesItemStatus = 'in_progress' | 'completed' | 'incomplete';

/**
 * 持久上下文中的请求消息。`partial` 是方舟兼容 endpoint 明确支持的字段。
 */
export interface OpenAIResponsesInputMessage {
  role: 'system' | 'developer' | 'user';
  content: string | readonly (OpenAIResponsesInputTextPart | OpenAIResponsesUserExtensionPart)[];
  type?: 'message';
  partial?: boolean;
}

/** Responses 文件引用注解。 */
export interface OpenAIResponsesFileCitationAnnotation {
  type: 'file_citation';
  file_id: string;
  filename: string;
  index: number;
}

/** Responses URL 引用注解。 */
export interface OpenAIResponsesUrlCitationAnnotation {
  type: 'url_citation';
  url: string;
  title: string;
  start_index: number;
  end_index: number;
}

/** Responses container file 引用注解。 */
export interface OpenAIResponsesContainerFileCitationAnnotation {
  type: 'container_file_citation';
  container_id: string;
  file_id: string;
  filename: string;
  start_index: number;
  end_index: number;
}

/** Responses 文件路径注解。 */
export interface OpenAIResponsesFilePathAnnotation {
  type: 'file_path';
  file_id: string;
  index: number;
}

/** Responses 文本输出中可能携带的注解集合。 */
export type OpenAIResponsesAnnotation =
  | OpenAIResponsesFileCitationAnnotation
  | OpenAIResponsesUrlCitationAnnotation
  | OpenAIResponsesContainerFileCitationAnnotation
  | OpenAIResponsesFilePathAnnotation;

/** Responses assistant 输出文本内容块。 */
export interface OpenAIResponsesOutputTextPart {
  type: 'output_text';
  text: string;
  annotations: readonly OpenAIResponsesAnnotation[];
  logprobs?: readonly OpenAIResponsesLogprob[];
}

/** Responses assistant refusal 内容块。 */
export interface OpenAIResponsesOutputRefusalPart {
  type: 'refusal';
  refusal: string;
}

/** Responses logprob 的候选 token 信息。 */
export interface OpenAIResponsesTopLogprob {
  token: string;
  bytes: readonly number[];
  logprob: number;
}

/** Responses 输出文本中单个 token 的 logprob 信息。 */
export interface OpenAIResponsesLogprob extends OpenAIResponsesTopLogprob {
  top_logprobs: readonly OpenAIResponsesTopLogprob[];
}

/** Responses assistant output message，作为 context 原样保存和回传。 */
export interface OpenAIResponsesOutputMessage {
  type: 'message';
  id: string;
  role: 'assistant';
  content: readonly (OpenAIResponsesOutputTextPart | OpenAIResponsesOutputRefusalPart)[];
  status: OpenAIResponsesItemStatus;
  phase?: 'commentary' | 'final_answer' | null;
}

/** reasoning item 的摘要内容块。 */
export interface OpenAIResponsesReasoningSummaryPart {
  type: 'summary_text';
  text: string;
}

/** reasoning item 的详细推理文本内容块。 */
export interface OpenAIResponsesReasoningContentPart {
  type: 'reasoning_text';
  text: string;
}

/** Responses reasoning item；Agent 保存但不会将其映射为普通 assistant 消息。 */
export interface OpenAIResponsesReasoningItem {
  type: 'reasoning';
  id: string;
  summary: readonly OpenAIResponsesReasoningSummaryPart[];
  content?: readonly OpenAIResponsesReasoningContentPart[];
  encrypted_content?: string | null;
  status?: OpenAIResponsesItemStatus;
}

/** Responses function_call item；Model parser 会把它提取为本地工具调用。 */
export interface OpenAIResponsesFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  id?: string;
  namespace?: string;
  status?: OpenAIResponsesItemStatus;
  created_by?: string;
}

/** Responses function_call_output item；由工具结果 builder 生成或由历史上下文恢复。 */
export interface OpenAIResponsesFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: OpenAIResponsesFunctionCallOutputValue;
  id?: string;
  status?: OpenAIResponsesItemStatus;
  created_by?: string;
}

/** Responses 协议下可以进入 Agent context/history 的封闭 item 集合。 */
export type OpenAIResponsesContext =
  | OpenAIResponsesInputMessage
  | OpenAIResponsesOutputMessage
  | OpenAIResponsesReasoningItem
  | OpenAIResponsesFunctionCall
  | OpenAIResponsesFunctionCallOutput;

/** Responses function tool wire structure。 */
export interface OpenAIResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonObject;
  strict?: boolean;
}

/** Responses 协议下 Agent 与 Model 共享的关联类型。 */
export interface OpenAIResponsesProtocol extends AgentProtocol {
  context: OpenAIResponsesContext;
  tool: OpenAIResponsesTool;
  userMessage: OpenAIResponsesUserMessage;
  systemMessage: OpenAIResponsesSystemMessage;
  assistantMessage: OpenAIResponsesAssistantMessage;
  toolCallOutputMessage: OpenAIResponsesToolCallOutputMessage;
  rawToolCall: OpenAIResponsesFunctionCall;
  rawResponse: OpenAIResponse;
}

/** 基于 OpenAI SDK 的 Responses 适配器配置。 */
export interface OpenAIResponsesModelOptions extends ClientOptions {
  model: string;
  client?: OpenAI;
  defaultParams?: Omit<ResponseCreateParamsNonStreaming, 'input' | 'model' | 'stream' | 'tools'>;
}
