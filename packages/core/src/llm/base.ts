import type { ModelChatRequest, ModelChatResponse } from '../agent/types';

export abstract class Model {
  abstract chat(request: ModelChatRequest): Promise<ModelChatResponse>;
}

export type { ModelChatRequest, ModelChatResponse } from '../agent/types';
