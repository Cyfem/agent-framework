import type {
  ApprovalDecision,
  ApprovalDirective,
  ApprovalRequest,
  ApprovalRequestInput,
} from './approval';
import type { SubAgentArtifactClient } from './artifact';
import type { ExecutorAvailabilityProbe, SubAgentExecutorDescriptor } from './catalog';
import type { SubAgentChildCheckpoint } from './checkpoint';
import type { SubAgentContextItem, SubAgentDefinitionRef } from './definition';
import type { JsonValue } from './json';
import type { ResolvedSubAgentLimits } from './limits';
import type {
  CompletionReceipt,
  ResultReceipt,
  SubAgentExecutorOperationResult,
  SubAgentExecutorRecoveryRequired,
  SubAgentFailureInput,
  SubAgentProgress,
  SubAgentTaskResult,
  SubAgentTaskState,
  SubAgentUsageDelta,
} from './result';
import type { SubAgentDelegationClient } from './runtime';
import type { ExecutorEventInput, SubAgentTaskEvent } from './telemetry';

export const SUBAGENT_RUNTIME_PROTOCOL_VERSION = '1' as const;
export const DEFAULT_EXECUTOR_MAX_BINDING_BYTES = 64 * 1024;
export const DEFAULT_EXECUTOR_MAX_EVENT_PAGE_SIZE = 256;

/** Credential-free protocol/gateway identity fixed for one transported child execution. */
export interface SubAgentExecutorModelBinding {
  readonly gatewayId: string;
  readonly protocol: string;
  readonly codecVersion: string;
}

/** Persisted opaque adapter state. It is never model-visible. */
export interface SubAgentExecutorBinding {
  readonly version: '1';
  readonly executorName: string;
  readonly ownerSessionId: string;
  readonly taskId: string;
  readonly subagentSessionId: string;
  readonly definitionName: string;
  readonly definitionVersion: string;
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly adapterStateVersion: string;
  /** Required by transported Executors and omitted by in-process Local bindings. */
  readonly modelBinding?: SubAgentExecutorModelBinding;
  readonly recoveryData: JsonValue;
}

/** Versioned serializer for an Executor's opaque recovery state. */
export interface SubAgentExecutorBindingCodec<TState = unknown> {
  readonly adapterStateVersion: string;
  encode(state: TState): JsonValue;
  decode(value: JsonValue): TState;
}

/** The only valid create, resume and reconnect operation shapes. */
export type SubAgentExecutorOperation =
  | {
      readonly type: 'create';
      readonly operationId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: 'resume';
      readonly operationId: string;
      readonly reason: 'approval';
      readonly binding: SubAgentExecutorBinding;
      readonly checkpoint: SubAgentChildCheckpoint;
      readonly approvals: readonly ApprovalDecision[];
    }
  | {
      readonly type: 'resume';
      readonly operationId: string;
      readonly reason: 'checkpoint';
      readonly binding: SubAgentExecutorBinding;
      readonly checkpoint: SubAgentChildCheckpoint;
      readonly approvals?: never;
    }
  | {
      readonly type: 'reconnect';
      readonly operationId: string;
      readonly binding: SubAgentExecutorBinding;
    };

/** JSON-safe child delegation capability snapshot fixed to one execution epoch. */
export interface SubAgentDelegationSnapshot {
  readonly version: '1';
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly parentTaskId: string;
  readonly path: readonly string[];
  readonly depth: number;
  readonly catalogRevision: number;
  readonly definitions: readonly {
    readonly name: string;
    readonly version: string;
    readonly executors: readonly string[];
  }[];
}

/** Protocol-neutral request crossing the Core/Executor boundary. */
export interface SubAgentExecutionRequest<I extends JsonValue = JsonValue> {
  readonly operation: SubAgentExecutorOperation;
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly subagentSessionId: string;
  readonly path: readonly string[];
  readonly attempt: number;
  readonly executionEpoch: string;
  /** Canonical unsigned base-10 fencing token issued by the authoritative StateStore lease. */
  readonly executionFencingToken: string;
  readonly retryOf?: string;
  /** Only the ref crosses this boundary; registries resolve schemas and factories. */
  readonly definition: SubAgentDefinitionRef;
  readonly input: I;
  readonly projectedContext: readonly SubAgentContextItem[];
  readonly delegation: SubAgentDelegationSnapshot;
  readonly limits: ResolvedSubAgentLimits;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

/** Exactly-once result publication and terminal completion controller. */
export interface SubAgentCompletionController {
  submitResult(callId: string, candidate: JsonValue): Promise<ResultReceipt>;
  complete(callId: string, proof: { readonly isStandalone: boolean }): Promise<CompletionReceipt>;
  /** Persist an authoritative failure; raw Executor outcomes can never substitute for this CAS. */
  fail(callId: string, failure: SubAgentFailureInput): Promise<SubAgentTaskResult>;
}

export interface SubAgentDelegationPauseCall {
  readonly callId: string;
  readonly childTaskId: string;
  readonly approvals: readonly ApprovalRequest[];
}

export interface SubAgentDelegationPauseInput {
  readonly checkpoint: SubAgentChildCheckpoint;
  /** Every paused nested call in the provider batch, in provider order. */
  readonly calls: readonly SubAgentDelegationPauseCall[];
}

export interface SubAgentDelegationPauseReceipt {
  readonly checkpointRevision: number;
  readonly approvals: readonly ApprovalRequest[];
}

/** Task-scoped capabilities exposed to a trusted child runner. */
export interface SubAgentExecutionControl {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly delegation: SubAgentDelegationClient;
  readonly artifacts?: SubAgentArtifactClient;
  readonly completion: SubAgentCompletionController;
  commitBinding(operationId: string, binding: SubAgentExecutorBinding): Promise<void>;
  commitCheckpoint(operationId: string, checkpoint: SubAgentChildCheckpoint): Promise<void>;
  authorizeTool(
    operationId: string,
    request: ApprovalRequestInput,
    checkpoint: SubAgentChildCheckpoint,
  ): Promise<ApprovalDirective>;
  /** Atomically suspend this parent task on one or more durable leaf approvals. */
  pauseDelegation(
    operationId: string,
    input: SubAgentDelegationPauseInput,
  ): Promise<SubAgentDelegationPauseReceipt>;
  reportProgress(operationId: string, update: SubAgentProgress): Promise<void>;
  consumeBudget(operationId: string, delta: SubAgentUsageDelta): Promise<void>;
  emit(operationId: string, event: ExecutorEventInput): Promise<void>;
}

/** Raw adapter handle. Core wraps it before exposing task control to a host. */
export interface ExecutorTaskHandle {
  readonly taskId: string;
  readonly binding: SubAgentExecutorBinding;
  snapshot(): Promise<ExecutorTaskSnapshot>;
  wait(): Promise<SubAgentExecutorOperationResult>;
  cancel(reason?: string): Promise<void>;
  events(options?: {
    readonly afterSequence?: number;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): AsyncIterable<SubAgentTaskEvent>;
}

export interface ExecutorTaskSnapshot {
  readonly taskId: string;
  readonly state: SubAgentTaskState;
  readonly binding: SubAgentExecutorBinding;
  readonly updatedAt: number;
}

/** Placement SPI implemented by Local, Worker, Process, HTTP, Queue and Docker packages. */
export interface SubAgentExecutor {
  readonly descriptor: SubAgentExecutorDescriptor;
  readonly bindingCodec: SubAgentExecutorBindingCodec;
  getAvailability(): ExecutorAvailabilityProbe | Promise<ExecutorAvailabilityProbe>;
  supports(definition: SubAgentDefinitionRef): boolean | Promise<boolean>;
  execute(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<SubAgentExecutorOperationResult>;
  spawn(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<ExecutorTaskHandle | SubAgentExecutorRecoveryRequired>;
  /**
   * Binding-addressed cancellation remains available after the originating process loses a raw
   * handle. Implementations must make `operationId` idempotent: replaying the same operation and
   * payload has the same result, while a conflicting payload must use the adapter's stable
   * idempotency-conflict semantics. Core cleanup is best-effort and may replay an operation after
   * an unavailable adapter, a failure, or an ambiguous acknowledgement.
   */
  cancel(
    binding: SubAgentExecutorBinding,
    options: {
      readonly operationId: string;
      readonly reason?: string;
      readonly signal: AbortSignal;
      readonly deadlineAt: number;
    },
  ): Promise<void>;
}
