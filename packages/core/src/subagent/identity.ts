import type { JsonValue } from './json';
import type { SubAgentErrorDescriptor } from './errors';
import type { SubAgentTaskState, SubAgentUsage } from './result';

/** Stable identity of one immutable definition version. */
export interface SubAgentDefinitionRef {
  readonly name: string;
  readonly version: string;
}

/** Minimal task identity safe to return from protocol-neutral runtime APIs. */
export interface SubAgentTaskIdentity {
  readonly taskId: string;
  readonly subAgent: SubAgentDefinitionRef;
}

/** Session-scoped host view. It is never used as the model-visible `agent` Tool input. */
export interface SubAgentTaskSnapshot extends SubAgentTaskIdentity {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly subagentSessionId: string;
  readonly parentTaskId?: string;
  readonly path: readonly string[];
  readonly executor: string;
  readonly state: SubAgentTaskState;
  readonly revision: number;
  readonly attempt: number;
  readonly retryOf?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly recoveryRequired: boolean;
  readonly outcomeUnknown?: boolean;
  readonly usage?: SubAgentUsage;
  readonly error?: SubAgentErrorDescriptor;
}

/** Versioned child-session checkpoint metadata resolved only inside its owner session. */
export interface SubAgentSessionSnapshot {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly subagentSessionId: string;
  readonly subAgent: SubAgentDefinitionRef;
  readonly revision: number;
  readonly checkpointVersion?: string;
  readonly checkpoint?: JsonValue;
  readonly createdAt: number;
  readonly updatedAt: number;
}
