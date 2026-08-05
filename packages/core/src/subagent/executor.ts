import type { ApprovalDecision, ApprovalDirective, ApprovalRequestInput } from './approval';
import type { ExecutorAvailabilityProbe, SubAgentExecutorDescriptor } from './catalog';
import type { SubAgentContextItem, SubAgentDefinitionRef } from './definition';
import type { JsonValue } from './json';
import type { ResolvedSubAgentLimits } from './limits';
import type {
  CompletionReceipt,
  ResultReceipt,
  SubAgentExecutionOutcome,
  SubAgentProgress,
  SubAgentTaskState,
  SubAgentUsageDelta,
} from './result';
import type { SubAgentDelegationClient } from './runtime';
import type { ExecutorEventInput, SubAgentTaskEvent } from './telemetry';

/** Persisted opaque adapter state. It is never model-visible. */
export interface SubAgentExecutorBinding {
  readonly executorName: string;
  readonly ownerSessionId: string;
  readonly taskId: string;
  readonly subagentSessionId: string;
  readonly definitionName: string;
  readonly definitionVersion: string;
  readonly adapterStateVersion: string;
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
      readonly idempotencyKey: string;
    }
  | {
      readonly type: 'resume';
      readonly reason: 'approval';
      readonly binding: SubAgentExecutorBinding;
      readonly approvals: readonly ApprovalDecision[];
    }
  | {
      readonly type: 'resume';
      readonly reason: 'checkpoint';
      readonly binding: SubAgentExecutorBinding;
      readonly approvals?: never;
    }
  | {
      readonly type: 'reconnect';
      readonly binding: SubAgentExecutorBinding;
    };

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
  readonly retryOf?: string;
  /** Only the ref crosses this boundary; registries resolve schemas and factories. */
  readonly definition: SubAgentDefinitionRef;
  readonly input: I;
  readonly projectedContext: readonly SubAgentContextItem[];
  readonly limits: ResolvedSubAgentLimits;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

/** Exactly-once result publication and terminal completion controller. */
export interface SubAgentCompletionController {
  submitResult(callId: string, candidate: JsonValue): Promise<ResultReceipt>;
  complete(callId: string): Promise<CompletionReceipt>;
}

/** Task-scoped capabilities exposed to a trusted child runner. */
export interface SubAgentExecutionControl {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly delegation: SubAgentDelegationClient;
  readonly completion: SubAgentCompletionController;
  commitBinding(binding: SubAgentExecutorBinding): Promise<void>;
  authorizeTool(request: ApprovalRequestInput): Promise<ApprovalDirective>;
  reportProgress(update: SubAgentProgress): Promise<void>;
  consumeBudget(delta: SubAgentUsageDelta): Promise<void>;
  emit(event: ExecutorEventInput): Promise<void>;
}

/** Raw adapter handle. Core wraps it before exposing task control to a host. */
export interface ExecutorTaskHandle {
  readonly taskId: string;
  readonly binding: SubAgentExecutorBinding;
  snapshot(): Promise<ExecutorTaskSnapshot>;
  wait(): Promise<SubAgentExecutionOutcome>;
  cancel(reason?: string): Promise<void>;
  events(options?: { readonly afterSequence?: number }): AsyncIterable<SubAgentTaskEvent>;
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
  ): Promise<SubAgentExecutionOutcome>;
  spawn(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<ExecutorTaskHandle>;
}
