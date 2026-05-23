import { createReadStream } from 'node:fs';

import OpenAI, { type ClientOptions } from 'openai';
import type { FileCreateParams } from 'openai/resources/files';
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInput,
  Tool as ResponseTool,
} from 'openai/resources/responses/responses';

import type {
  AgentResponseOutputItem,
  ModelResponsesRequest,
  ModelResponsesResponse,
} from '../agent/types';
import { Model } from './base';

/** 方舟 Files API 接受的附加上传选项。 */
export interface ArkFileUploadOptions {
  /** 方舟通用上传用途，默认值为 `user_data`。 */
  purpose?: 'user_data';
  /** 方舟媒体预处理选项，例如视频抽帧配置。 */
  preprocess_configs?: Record<string, unknown>;
}

/** 方舟 Files API 返回的文件元数据。 */
export interface ArkFileObject {
  id: string;
  object?: string;
  purpose?: string;
  filename?: string;
  bytes?: number;
  mime_type?: string;
  created_at?: number;
  expire_at?: number;
  status?: string;
  preprocess_configs?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 基于 OpenAI SDK 的 Responses 适配器配置。 */
export interface OpenAIModelOptions extends ClientOptions {
  /** 传给 `responses.create` 的模型名称。 */
  model: string;
  /** 可选的已配置 OpenAI client；省略时使用其余 ClientOptions 创建实例。 */
  client?: OpenAI;
  /** 合并到每次请求中的非流式 Responses 默认参数。 */
  defaultParams?: Omit<ResponseCreateParamsNonStreaming, 'input' | 'model' | 'stream' | 'tools'>;
}

/** 基于 OpenAI SDK Responses 与 Files API 的模型适配器。 */
export class OpenAIModel extends Model {
  #openai: OpenAI;
  #model: string;
  #defaultParams: OpenAIModelOptions['defaultParams'];

  /** 创建 OpenAI 或方舟等 Responses 兼容服务的适配器。 */
  constructor(options: OpenAIModelOptions) {
    super();

    const { client, model, defaultParams, ...clientOptions } = options;

    this.#model = model;
    this.#defaultParams = defaultParams;
    this.#openai = client ?? new OpenAI(clientOptions);
  }

  /**
   * 发送一次非流式 Responses 请求。
   *
   * 输出 item 不做投影转换，以便 Agent 在后续轮次原样保存并回传提供方的响应元数据。
   */
  async responses(request: ModelResponsesRequest): Promise<ModelResponsesResponse> {
    const params: ResponseCreateParamsNonStreaming = {
      ...this.#defaultParams,
      model: this.#model,
      input: request.input as unknown as ResponseInput,
    };

    if (request.tools.length > 0) {
      params.tools = request.tools as unknown as ResponseTool[];
    }

    const response = await this.#openai.responses.create(params);

    return {
      output: response.output as unknown as readonly AgentResponseOutputItem[],
      raw: response,
    };
  }

  /**
   * 上传本地文件，供后续方舟 Responses 输入内容块通过 `file_id` 引用。
   *
   * `preprocess_configs` 是方舟扩展字段，只在此 SDK 适配边界处理。
   */
  async uploadFile(filePath: string, options: ArkFileUploadOptions = {}): Promise<ArkFileObject> {
    const body = {
      file: createReadStream(filePath),
      purpose: options.purpose ?? 'user_data',
      ...(options.preprocess_configs
        ? {
            preprocess_configs: options.preprocess_configs,
          }
        : {}),
    };

    const file = await this.#openai.files.create(body as unknown as FileCreateParams);

    return file as unknown as ArkFileObject;
  }
}
