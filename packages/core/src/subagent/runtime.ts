import type { ApprovalDecision } from './approval';
import type { ArtifactStore } from './artifact';
import type { AgentCheckpointMigrator, AgentProtocolCheckpointCodec } from './checkpoint';
import type {
  ExecutorCatalogPolicy,
  ExecutorCatalogSnapshot,
  SubAgentCatalogEntry,
} from './catalog';
import type { SubAgentDefinitionRegistration } from './definition';
import type { SubAgentExecutor } from './executor';
import type { SubAgentSessionSnapshot, SubAgentTaskSnapshot } from './identity';
import type { JsonValue } from './json';
import type { SubAgentLimits } from './limits';
import type { SubAgentExecutionOutcome } from './result';
import type { AgentRuntimeStateStore } from './state-store';
import type { AgentTelemetrySink, SubAgentTaskEvent } from './telemetry';

/** The complete and only model-visible agent Tool request. */
export interface ModelSubAgentRequest<I extends JsonValue = JsonValue> {
  readonly subAgent: string;
  readonly executor: string;
  readonly input: I;
}

/** Trusted host metadata paired with a model-visible request by the Tool adapter. */
export interface SubAgentDispatchContext {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly parentTaskId?: string;
  readonly parentContext: readonly unknown[];
  readonly parentRawHistory: readonly unknown[];
  readonly stream?: boolean;
  readonly signal: AbortSignal;
  readonly deadlineAt?: number;
}

/** Programmatic host create/retry request. Host-only fields never enter model schema. */
export interface SubAgentExecuteRequest<
  I extends JsonValue = JsonValue,
> extends ModelSubAgentRequest<I> {
  readonly runId: string;
  readonly requestId: string;
  readonly parentTaskId?: string;
  readonly retryOf?: string;
  readonly stream?: boolean;
  readonly parentContext?: readonly unknown[];
  readonly parentRawHistory?: readonly unknown[];
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

/** Task-scoped child delegation request; ancestry and budget come from its client. */
export interface ChildDelegationRequest<
  I extends JsonValue = JsonValue,
> extends ModelSubAgentRequest<I> {
  readonly requestId: string;
}

export interface SubAgentDispatcher {
  getCatalog(): ExecutorCatalogSnapshot;
  getCatalogEntries(): readonly SubAgentCatalogEntry[];
  dispatchTool(
    request: ModelSubAgentRequest,
    context: SubAgentDispatchContext,
  ): Promise<SubAgentExecutionOutcome>;
}

/** Delegation client with immutable task ancestry, session and shared budget. */
export interface SubAgentDelegationClient extends SubAgentDispatcher {
  execute(request: ChildDelegationRequest): Promise<SubAgentExecutionOutcome>;
  spawn(request: ChildDelegationRequest): Promise<SubAgentTaskHandle>;
}

/** Session-guarded host handle; binding and recoveryData are intentionally absent. */
export interface SubAgentTaskHandle {
  readonly taskId: string;
  snapshot(): Promise<SubAgentTaskSnapshot>;
  wait(): Promise<SubAgentExecutionOutcome>;
  cancel(reason?: string): Promise<SubAgentTaskSnapshot>;
  events(options?: { readonly afterSequence?: number }): AsyncIterable<SubAgentTaskEvent>;
}

export interface SubAgentRuntimeOptions {
  readonly sessionId: string;
  readonly activeDefinitions: readonly SubAgentDefinitionRegistration[];
  readonly recoveryDefinitions?: readonly SubAgentDefinitionRegistration[];
  readonly executors: readonly SubAgentExecutor[];
  readonly stateStore: AgentRuntimeStateStore;
  readonly artifactStore?: ArtifactStore;
  readonly telemetrySink?: AgentTelemetrySink;
  readonly limits?: Partial<SubAgentLimits>;
  readonly catalogPolicy?: ExecutorCatalogPolicy;
  readonly protocolCheckpointCodecs?: readonly AgentProtocolCheckpointCodec[];
  readonly checkpointMigrators?: readonly AgentCheckpointMigrator[];
}

/** Session-bound Core runtime. `init()` is the only asynchronous configuration phase. */
export interface SubAgentRuntime extends SubAgentDispatcher {
  readonly sessionId: string;
  readonly stateStore: AgentRuntimeStateStore;
  readonly ready: boolean;
  init(): Promise<void>;
  refreshCatalog(): Promise<ExecutorCatalogSnapshot>;
  execute(request: SubAgentExecuteRequest): Promise<SubAgentExecutionOutcome>;
  spawn(request: SubAgentExecuteRequest): Promise<SubAgentTaskHandle>;
  getTask(sessionId: string, taskId: string): Promise<SubAgentTaskSnapshot>;
  getSubAgentSession(
    sessionId: string,
    subagentSessionId: string,
  ): Promise<SubAgentSessionSnapshot>;
  wait(sessionId: string, taskId: string): Promise<SubAgentExecutionOutcome>;
  cancel(sessionId: string, taskId: string, reason?: string): Promise<SubAgentTaskSnapshot>;
  resume(
    sessionId: string,
    taskId: string,
    options: { readonly decisions?: readonly ApprovalDecision[] },
  ): Promise<SubAgentExecutionOutcome>;
  reconnect(sessionId: string, taskId: string): Promise<SubAgentTaskHandle>;
  events(
    sessionId: string,
    taskId: string,
    options?: { readonly afterSequence?: number },
  ): AsyncIterable<SubAgentTaskEvent>;
}
