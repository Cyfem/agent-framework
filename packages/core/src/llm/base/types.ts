import type { AgentProtocol, ContextOf, ToolOf } from '../../agent/types';

/** 区分普通 Agent 调用与框架内部摘要调用。 */
export type ModelGeneratePurpose = 'agent' | 'context-summary';

/** Framework-owned identity and attempt metadata; adapters must not copy it into provider bodies. */
export interface ModelRuntimeMetadata {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  /** One-based child execution attempt. Root Agent requests omit this placement identity. */
  readonly executionAttempt?: number;
  /** Opaque child execution epoch fixed by the authoritative Runtime. */
  readonly executionEpoch?: string;
  /** Decimal fencing token fixed for the child execution epoch. */
  readonly executionFencingToken?: string;
  /**
   * Host-only durable provider operation identity. Protocol adapters must never copy it into a
   * provider request body, header, query parameter or provider-visible idempotency field.
   */
  readonly providerOperationId?: string;
  /** Durable checkpoint control operation acknowledged immediately before provider dispatch. */
  readonly checkpointOperationId?: string;
  /** Lowercase SHA-256 of the exact acknowledged child checkpoint. */
  readonly checkpointDigest?: string;
  /** Zero-based logical Agent loop iteration. */
  readonly iteration?: number;
  /** One-based request attempt within model error recovery. */
  readonly requestAttempt?: number;
}

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
  /** Cooperative cancellation shared by Model, Tool, summary and recovery work. */
  signal?: AbortSignal;
  /** Absolute Unix-epoch deadline in milliseconds. */
  deadlineAt?: number;
  /** Host-only runtime metadata. Protocol adapters must not serialize it into provider payloads. */
  runtime?: Readonly<ModelRuntimeMetadata>;
}

/** Model 执行一轮模型调用后返回的协议消息与可选完整响应。 */
/** Provider-reported token usage normalized without retaining raw billing or credential data. */
export interface ModelGenerateUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ModelGenerateResult<P extends AgentProtocol> {
  /** 本轮模型生成的协议消息；Agent 会按顺序原样写入 context/history。 */
  messages: readonly ContextOf<P>[];
  /** Normalized usage used by durable Subagent budget settlement. */
  usage?: ModelGenerateUsage;
  /** SDK 或 provider 返回的完整原始响应，供调试和审计使用。 */
  raw?: P['rawResponse'];
}
