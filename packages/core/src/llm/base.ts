import type { ModelResponsesRequest, ModelResponsesResponse } from '../agent/types';

/** Base class for Responses-based LLM adapters used by Agent. */
export abstract class Model {
  /** Return one non-streaming Responses API result. */
  abstract responses(request: ModelResponsesRequest): Promise<ModelResponsesResponse>;
}

export type { ModelResponsesRequest, ModelResponsesResponse } from '../agent/types';
