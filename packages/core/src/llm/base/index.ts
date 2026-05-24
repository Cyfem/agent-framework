import type {
  AgentBaseSystemMessage,
  AgentBaseToolCallOutputMessage,
  AgentBaseUserMessage,
  AgentParsedMessage,
  AgentProtocol,
  AgentToolCall,
  AgentToolDefinitionInput,
  AssistantMessageOf,
  ContextOf,
  SystemMessageOf,
  ToolCallOutputMessageOf,
  ToolOf,
  UserMessageOf,
} from '../../agent/types';
import type { ModelGenerateRequest, ModelGenerateResult } from './types';

export type { ModelGenerateRequest, ModelGenerateResult } from './types';

/**
 * Agent 使用的协议适配器抽象基类。
 *
 * builder 将 Agent 基础结构转换为协议消息，parser 从混合上下文中筛选并反解析目标消息，
 * `generate()` 负责实际模型请求。
 */
export abstract class Model<P extends AgentProtocol> {
  /**
   * 执行一轮非流式模型调用。
   *
   * `context` 和 `tools` 已经由 Agent 通过本 Model 的 builder 转成目标协议结构；
   * 返回的 `messages` 会被 Agent 原样写入上下文，并继续交给 parser 提取工具调用。
   */
  abstract generate(request: ModelGenerateRequest<P>): Promise<ModelGenerateResult<P>>;

  /**
   * 将 Agent 的基础用户消息或协议专属用户消息构建为可持久保存的上下文项。
   *
   * 字符串任务会先被 Agent 包装为 `{ type: "text" }` 内容块，再进入本方法。
   */
  abstract buildUserMessage(input: AgentBaseUserMessage | UserMessageOf<P>): ContextOf<P>;

  /**
   * 将框架内部提示词或调用方 system prompt 构建为协议 system 上下文项。
   *
   * Agent 每轮请求都会临时构建这些消息，但不会把它们写入持久 context/history。
   */
  abstract buildSystemMessage(input: AgentBaseSystemMessage | SystemMessageOf<P>): ContextOf<P>;

  /**
   * 将本地工具执行结果构建为协议工具结果消息。
   *
   * Agent 只提供通用的 `callId + output` 语义；具体 wire 字段由协议适配器决定。
   */
  abstract buildToolCallOutputMessage(
    input: AgentBaseToolCallOutputMessage | ToolCallOutputMessageOf<P>,
  ): ContextOf<P>;

  /**
   * 将框架工具定义构建为模型 API 接收的工具声明。
   *
   * `strict` 仅在工具显式设置时出现；schema 的 OpenAI-compatible 转换也应在 Model 层完成。
   */
  abstract buildToolMessage(input: AgentToolDefinitionInput): ToolOf<P>;

  /**
   * 从混合上下文中筛选用户消息并反解析为协议用户消息结构。
   *
   * 不匹配的上下文项必须被跳过，解析结果需要保留原始 `sourceMessage`。
   */
  abstract parseUserMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<UserMessageOf<P>, ContextOf<P>>[];

  /**
   * 从混合上下文中筛选 system 消息并反解析。
   *
   * 主要供应用调试、恢复历史和自定义模型适配器测试使用。
   */
  abstract parseSystemMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<SystemMessageOf<P>, ContextOf<P>>[];

  /**
   * 从混合上下文中筛选 assistant 文本/拒绝等普通输出。
   *
   * provider 专属推理项可以保留在原始 context 中，不必强行映射到 assistant 消息。
   */
  abstract parseAssistantMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<AssistantMessageOf<P>, ContextOf<P>>[];

  /**
   * 从一批模型返回消息中按协议顺序提取本地可执行的工具调用。
   *
   * Chat 协议中一条 assistant message 可能展开多个调用；Responses 通常一条 item
   * 对应一个调用。返回项需要携带原始 `sourceCall`。
   */
  abstract parseToolCalls(context: readonly ContextOf<P>[]): readonly AgentToolCall<P>[];

  /**
   * 从混合上下文中筛选工具结果消息并反解析。
   *
   * 该方法不参与 Agent 主循环，但用于外部审计、测试和恢复上下文。
   */
  abstract parseToolCallOutputMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<ToolCallOutputMessageOf<P>, ContextOf<P>>[];
}
