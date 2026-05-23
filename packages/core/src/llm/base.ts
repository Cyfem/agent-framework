import type { ModelResponsesRequest, ModelResponsesResponse } from '../agent/types';

/** Agent 使用的、基于 Responses 协议的 LLM 适配器抽象基类。 */
export abstract class Model {
  /** 发起一次非流式 Responses 请求并返回模型输出。 */
  abstract responses(request: ModelResponsesRequest): Promise<ModelResponsesResponse>;
}

export type { ModelResponsesRequest, ModelResponsesResponse } from '../agent/types';
