import type { SubAgentDefinitionRef } from './definition';
import type { SubAgentErrorCode } from './errors';
import type { SubAgentUsage } from './result';

export type SafeEventValue = string | number | boolean | null;

/** Explicit safe event fields; arbitrary provider metadata is intentionally impossible. */
export interface SafeEventData {
  readonly status?: string;
  readonly errorCode?: SubAgentErrorCode;
  readonly reasonCode?: string;
  readonly approvalId?: string;
  readonly toolName?: string;
  readonly callId?: string;
  readonly length?: number;
  readonly durationMs?: number;
  readonly checkpointRevision?: number;
  readonly usage?: SubAgentUsage;
  readonly outcomeUnknown?: boolean;
}

export type SubAgentTaskEventType =
  | 'task.queued'
  | 'task.started'
  | 'task.paused'
  | 'task.resumed'
  | 'task.result_submitted'
  | 'task.succeeded'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.timed_out'
  | 'task.budget_exceeded'
  | 'approval.requested'
  | 'approval.decided'
  | 'recovery.started'
  | 'recovery.resumed'
  | 'recovery.reconnected'
  | 'recovery.failed'
  | 'progress.reported'
  | 'usage.updated'
  | 'budget.rejected';

/** Durable, replayable, task-scoped event. */
export interface SubAgentTaskEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: SubAgentTaskEventType;
  readonly sessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly path: readonly string[];
  readonly definition: SubAgentDefinitionRef;
  readonly executor: string;
  readonly attempt: number;
  readonly timestamp: number;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly data: SafeEventData;
}

/** Whitelisted event fields accepted from an Executor before Core adds identity. */
export interface ExecutorEventInput {
  readonly type: SubAgentTaskEventType;
  readonly timestamp?: number;
  readonly data: SafeEventData;
}

export type AgentTelemetryEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'model.started'
  | 'model.completed'
  | 'model.failed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed';

export interface AgentTelemetryEvent {
  readonly type: AgentTelemetryEventType;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly callId?: string;
  readonly name?: string;
  readonly durationMs?: number;
  readonly length?: number;
  readonly errorCode?: string;
  readonly usage?: SubAgentUsage;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
}

/** Optional Core telemetry sink; OpenTelemetry bridging lives in another package. */
export interface AgentTelemetrySink {
  emit(event: AgentTelemetryEvent): void | Promise<void>;
}

export const NOOP_AGENT_TELEMETRY_SINK: AgentTelemetrySink = Object.freeze({
  emit(): void {},
});
