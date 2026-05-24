/**
 * 离线 Responses mock 的公共基类：复用真实适配器的 builder/parser，
 * 子类只需覆盖 `generate()` 生成确定性的模型输出。
 */
import {
  OpenAIResponsesModel,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type OpenAIResponsesProtocol,
} from '@manee/agent-framework';

export abstract class ResponsesMockModel extends OpenAIResponsesModel {
  /** 使用离线占位配置初始化真实 adapter，使子类可复用全部 Responses builder/parser。 */
  constructor() {
    super({
      apiKey: 'offline-mock-key',
      model: 'offline-mock-model',
    });
  }

  /** 子类只负责返回确定性 output，避免离线 demo 依赖网络或真实模型。 */
  abstract override generate(
    request: ModelGenerateRequest<OpenAIResponsesProtocol>,
  ): Promise<ModelGenerateResult<OpenAIResponsesProtocol>>;
}
