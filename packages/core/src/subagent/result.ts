import type { ApprovalRequest } from './approval';
import type { SubAgentErrorDescriptor } from './errors';
import type { SubAgentTaskIdentity } from './identity';
import type { JsonValue } from './json';

export type SubAgentTaskState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'result_submitted'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'budget_exceeded';

export interface SubAgentUsage {
  readonly turns: number;
  readonly providerCalls: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cost?: number;
}

export interface SubAgentUsageDelta {
  readonly turns?: number;
  readonly providerCalls?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cost?: number;
}

export interface SubAgentProgress {
  readonly message: string;
  readonly percent?: number;
  readonly data?: JsonValue;
}

export type SubAgentFailureStatus = Extract<
  SubAgentTaskState,
  'failed' | 'cancelled' | 'timed_out' | 'budget_exceeded'
>;

/** Trusted runner request for an authoritative non-success terminal transition. */
export interface SubAgentFailureInput<O extends JsonValue = JsonValue> {
  readonly status: SubAgentFailureStatus;
  readonly error: SubAgentErrorDescriptor;
  readonly partialOutput?: O;
}

export type SubAgentTaskResult<O extends JsonValue = JsonValue> =
  | {
      readonly status: 'succeeded';
      readonly task: SubAgentTaskIdentity;
      readonly executor: string;
      readonly output: O;
      readonly usage?: SubAgentUsage;
    }
  | {
      readonly status: 'failed' | 'cancelled' | 'timed_out' | 'budget_exceeded';
      readonly task: SubAgentTaskIdentity;
      readonly executor: string;
      readonly error: SubAgentErrorDescriptor;
      readonly partialOutput?: O;
      readonly usage?: SubAgentUsage;
    };

export type SubAgentExecutionOutcome<O extends JsonValue = JsonValue> =
  | { readonly type: 'terminal'; readonly result: SubAgentTaskResult<O> }
  | {
      readonly type: 'paused';
      readonly reason: 'approval';
      readonly task: SubAgentTaskIdentity;
      readonly approvals: readonly ApprovalRequest[];
      readonly checkpointRevision: number;
    };

/** Exactly-once receipt for the typed `agent-result` phase. */
export interface ResultReceipt {
  readonly schemaVersion: '1';
  readonly receiptId: string;
  readonly taskId: string;
  readonly callId: string;
  readonly revision: number;
  readonly outputHash: string;
  readonly submittedAt: number;
  readonly status: 'accepted' | 'replayed';
}

/** Exactly-once receipt for the standalone `end-agent` completion phase. */
export interface CompletionReceipt {
  readonly schemaVersion: '1';
  readonly receiptId: string;
  readonly taskId: string;
  readonly callId: string;
  readonly revision: number;
  readonly completedAt: number;
  readonly status: 'completed' | 'replayed';
}
