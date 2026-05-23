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

/** Extra file-upload options accepted by Ark's Files API. */
export interface ArkFileUploadOptions {
  /** Ark generic upload purpose. Defaults to `user_data`. */
  purpose?: 'user_data';
  /** Ark media preprocessing options, such as video frame sampling configuration. */
  preprocess_configs?: Record<string, unknown>;
}

/** File metadata returned by Ark's Files API. */
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

/** Options for the OpenAI SDK-backed Responses adapter. */
export interface OpenAIModelOptions extends ClientOptions {
  /** Model name passed to `responses.create`. */
  model: string;
  /** Optional preconfigured OpenAI client. When omitted, one is created from ClientOptions. */
  client?: OpenAI;
  /** Default non-streaming Responses parameters merged into every request. */
  defaultParams?: Omit<ResponseCreateParamsNonStreaming, 'input' | 'model' | 'stream' | 'tools'>;
}

/** Model adapter backed by the OpenAI SDK Responses and Files APIs. */
export class OpenAIModel extends Model {
  #openai: OpenAI;
  #model: string;
  #defaultParams: OpenAIModelOptions['defaultParams'];

  /** Create an adapter for OpenAI or a Responses-compatible provider such as Ark. */
  constructor(options: OpenAIModelOptions) {
    super();

    const { client, model, defaultParams, ...clientOptions } = options;

    this.#model = model;
    this.#defaultParams = defaultParams;
    this.#openai = client ?? new OpenAI(clientOptions);
  }

  /**
   * Send one non-streaming Responses request.
   *
   * Output items are intentionally returned without projection so an Agent can persist
   * and resend provider response metadata verbatim on later turns.
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
   * Upload a local file for subsequent use by Ark Responses input parts.
   *
   * `preprocess_configs` is an Ark extension and is adapted only at this SDK boundary.
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
