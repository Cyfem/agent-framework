import type { AgentProtocol, ContextOf, ToolOf } from '../../agent/types';

/** Model 执行一轮模型调用时接收的协议上下文与工具。 */
export interface ModelGenerateRequest<P extends AgentProtocol> {
  /** 已由 Model builder 构建好的协议上下文，包含临时 system prompt 与持久历史。 */
  context: readonly ContextOf<P>[];
  /** 已由 Model builder 构建好的协议工具声明。 */
  tools: readonly ToolOf<P>[];
}

/** Model 执行一轮模型调用后返回的协议消息与可选完整响应。 */
export interface ModelGenerateResult<P extends AgentProtocol> {
  /** 本轮模型生成的协议消息；Agent 会按顺序原样写入 context/history。 */
  messages: readonly ContextOf<P>[];
  /** SDK 或 provider 返回的完整原始响应，供调试和审计使用。 */
  raw?: P['rawResponse'];
}
