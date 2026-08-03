import type { AgentProtocol, ContextOf, ToolOf } from '../../agent/types';

/** 区分普通 Agent 调用与框架内部摘要调用。 */
export type ModelGeneratePurpose = 'agent' | 'context-summary';

/** Model 执行一轮模型调用时接收的协议上下文与工具。 */
export interface ModelGenerateRequest<P extends AgentProtocol> {
  /** 已由 Model builder 构建好的协议上下文，包含临时 system prompt 与持久历史。 */
  context: readonly ContextOf<P>[];
  /** 已由 Model builder 构建好的协议工具声明。 */
  tools: readonly ToolOf<P>[];
  /**
   * 请求用途。普通 Agent 请求为了旧 Model 源码兼容而省略；摘要请求固定为
   * `context-summary`。
   */
  purpose?: ModelGeneratePurpose;
}

/** Model 执行一轮模型调用后返回的协议消息与可选完整响应。 */
export interface ModelGenerateResult<P extends AgentProtocol> {
  /** 本轮模型生成的协议消息；Agent 会按顺序原样写入 context/history。 */
  messages: readonly ContextOf<P>[];
  /** SDK 或 provider 返回的完整原始响应，供调试和审计使用。 */
  raw?: P['rawResponse'];
}
