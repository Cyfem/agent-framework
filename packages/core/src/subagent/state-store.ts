import type { ApprovalDecisionRecord, ApprovalRequest } from './approval';
import type {
  ContextStoreCheckpointV1,
  DurableContextCompactTransactionV1,
  EncodedAgentProtocolCheckpoint,
  SubAgentChildCheckpoint,
} from './checkpoint';
import type { SubAgentContextItem, SubAgentDefinitionRef } from './definition';
import type { SubAgentErrorDescriptor } from './errors';
import type { SubAgentExecutorBinding } from './executor';
import type { JsonValue } from './json';
import type { TreeBudgetSnapshot } from './limits';
import type {
  CompletionReceipt,
  ResultReceipt,
  SubAgentTaskResult,
  SubAgentTaskState,
  SubAgentUsage,
} from './result';
import type { SubAgentTaskEvent } from './telemetry';

export type StoredAgentRunStatus =
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'cancelled'
  | 'failed';

export type StoredPendingToolCallKind = 'tool' | 'agent' | 'end-agent';
export type StoredPendingToolCallStatus = 'pending' | 'running' | 'paused' | 'settled' | 'applied';

export interface StoredPendingToolCall {
  readonly callId: string;
  readonly name: string;
  readonly order: number;
  readonly kind: StoredPendingToolCallKind;
  readonly status: StoredPendingToolCallStatus;
  readonly taskId?: string;
  readonly output?: JsonValue;
  readonly error?: SubAgentErrorDescriptor;
}

export interface StoredPendingToolBatch {
  readonly batchId: string;
  readonly iteration: number;
  readonly assistantMessage: EncodedAgentProtocolCheckpoint;
  readonly calls: readonly StoredPendingToolCall[];
  readonly endRequested: boolean;
  readonly createdAt: number;
}

/** Durable root-run state required to resume the same open model loop. */
export interface StoredAgentRun {
  readonly recordVersion: '1';
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly status: StoredAgentRunStatus;
  readonly revision: number;
  readonly fencingToken: string;
  readonly agentCheckpointVersion: string;
  readonly protocolContext: EncodedAgentProtocolCheckpoint;
  readonly contextStore: ContextStoreCheckpointV1;
  readonly modelIteration: number;
  readonly maxIterations: number | null;
  readonly pendingBatch?: StoredPendingToolBatch;
  readonly compactTransaction?: DurableContextCompactTransactionV1;
  readonly budget: TreeBudgetSnapshot;
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly endRequested: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type StoredTaskControlOperationKind =
  | 'binding'
  | 'checkpoint'
  | 'approval'
  | 'progress'
  | 'budget'
  | 'event'
  | 'cancel';

/** Durable replay receipt for control-plane operations that can cross a transport boundary. */
export interface StoredTaskControlOperation {
  readonly operationId: string;
  readonly kind: StoredTaskControlOperationKind;
  readonly payloadHash: string;
  readonly result?: JsonValue;
  readonly completedAt: number;
}

export interface StoredExecutorOperationV1 {
  readonly version: '1';
  readonly operationId: string;
  readonly type: 'create' | 'resume_approval' | 'resume_checkpoint' | 'reconnect';
  readonly attempt: number;
  readonly executionEpoch: string;
  readonly status: 'prepared' | 'dispatched' | 'settled';
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Durable task record shared by every placement adapter. */
export interface StoredTask {
  readonly recordVersion: '1';
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly subagentSessionId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly definition: SubAgentDefinitionRef;
  readonly executor: string;
  readonly input: JsonValue;
  readonly inputHash: string;
  readonly projectedContext: readonly SubAgentContextItem[];
  readonly state: SubAgentTaskState;
  readonly revision: number;
  readonly fencingToken: string;
  readonly path: readonly string[];
  readonly depth: number;
  readonly attempt: number;
  readonly executionEpoch?: string;
  readonly executionFencingToken?: string;
  readonly executorOperation?: StoredExecutorOperationV1;
  readonly retryOf?: string;
  readonly binding?: SubAgentExecutorBinding;
  readonly childCheckpoint?: SubAgentChildCheckpoint;
  readonly controlOperations: readonly StoredTaskControlOperation[];
  readonly resultReceipt?: ResultReceipt;
  readonly completionReceipt?: CompletionReceipt;
  readonly result?: SubAgentTaskResult;
  readonly output?: JsonValue;
  readonly partialOutput?: JsonValue;
  readonly error?: SubAgentErrorDescriptor;
  readonly usage?: SubAgentUsage;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalDecisions: readonly ApprovalDecisionRecord[];
  readonly recoveryRequired: boolean;
  readonly activeElapsedMs: number;
  readonly activeStartedAt?: number;
  readonly remainingMs: number;
  readonly eventSequence: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt?: number;
}

export type CreateStoredTaskResult =
  | { readonly status: 'created'; readonly task: StoredTask }
  | { readonly status: 'existing'; readonly task: StoredTask };

/** Monotonic lease; a takeover increments fencingToken while renew does not. */
export interface StateLease {
  readonly key: string;
  readonly fencingToken: string;
  readonly expiresAt: number;
  renew(ttlMs: number): Promise<StateLease>;
  release(): Promise<void>;
}

/** Retryable contention signal emitted when a non-expired lease is already owned elsewhere. */
export class StateLeaseUnavailableError extends Error {
  readonly code = 'STATE_LEASE_UNAVAILABLE';

  constructor(readonly key: string) {
    super(`State lease ${key} is currently unavailable.`);
    this.name = 'StateLeaseUnavailableError';
  }
}

/** Transaction-local API. Callbacks must not wait on Model, Tool, Executor or network I/O. */
export interface AgentRuntimeStateTransaction {
  loadRun(runId: string): Promise<StoredAgentRun | undefined>;
  loadTask(taskId: string): Promise<StoredTask | undefined>;
  findTaskByIdempotencyKey(runId: string, requestId: string): Promise<StoredTask | undefined>;
  findTaskBySubAgentSession(subagentSessionId: string): Promise<StoredTask | undefined>;
  createTask(record: StoredTask): Promise<CreateStoredTaskResult>;
  compareAndSetTask(
    taskId: string,
    expectedRevision: number,
    fencingToken: string,
    next: StoredTask,
  ): Promise<boolean>;
  compareAndSetRun(
    runId: string,
    expectedRevision: number,
    fencingToken: string,
    next: StoredAgentRun,
  ): Promise<boolean>;
  appendEvents(taskId: string, events: readonly SubAgentTaskEvent[]): Promise<void>;
}

/** Authoritative persistence SPI for root runs, tasks, approvals, events and fencing. */
export interface AgentRuntimeStateStore {
  readonly transactionDomainId: string;
  createRun(record: StoredAgentRun): Promise<void>;
  loadRun(ownerSessionId: string, runId: string): Promise<StoredAgentRun | undefined>;
  loadTask(ownerSessionId: string, taskId: string): Promise<StoredTask | undefined>;
  findTaskByIdempotencyKey(
    ownerSessionId: string,
    runId: string,
    requestId: string,
  ): Promise<StoredTask | undefined>;
  findTaskBySubAgentSession(
    ownerSessionId: string,
    subagentSessionId: string,
  ): Promise<StoredTask | undefined>;
  transaction<T>(
    ownerSessionId: string,
    lease: StateLease,
    work: (transaction: AgentRuntimeStateTransaction) => Promise<T>,
  ): Promise<T>;
  readEvents(
    ownerSessionId: string,
    taskId: string,
    afterSequence?: number,
    options?: { readonly limit?: number; readonly signal?: AbortSignal },
  ): Promise<readonly SubAgentTaskEvent[]>;
  acquireLease(key: string, ttlMs: number): Promise<StateLease>;
}
