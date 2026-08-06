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
import type { ResolvedSubAgentLimits, SubAgentLimits } from './limits';
import type { SubAgentExecutionOutcome } from './result';
import type { RuntimeTaskCreateMutation } from './state-controller';
import type { AgentRuntimeStateStore, StateLease } from './state-store';
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
  /** Live root-run ownership required only by `SubAgentRuntime.stageTool()`. */
  readonly runOwnership?: AgentRunStateOwnership;
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
  /** Submit a model Tool call and expose its durable task identity before waiting. */
  submitTool(
    request: ModelSubAgentRequest,
    context: SubAgentDispatchContext,
  ): Promise<SubAgentTaskHandle>;
  dispatchTool(
    request: ModelSubAgentRequest,
    context: SubAgentDispatchContext,
  ): Promise<SubAgentExecutionOutcome>;
}

/** Host-only staged create token. None of these fields enter the model-visible Tool schema. */
export interface StagedSubAgentTask {
  readonly taskId: string;
  /** Present only when this stage owns a new, not-yet-persisted identity. */
  readonly taskMutation?: RuntimeTaskCreateMutation;
  dispatch(): Promise<SubAgentTaskHandle>;
}

/**
 * Structural proof backed by the live root Agent lease. `useStateLease()` must reject after
 * release, loss or takeover and serialize with renewal of the exact fencing token.
 */
export interface AgentRunStateOwnership {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly fencingToken: string;
  readonly signal: AbortSignal;
  useStateLease<T>(work: (lease: StateLease) => Promise<T>): Promise<T>;
}

/** Delegation client with immutable task ancestry, session and shared budget. */
export interface SubAgentDelegationClient extends SubAgentDispatcher {
  execute(request: ChildDelegationRequest): Promise<SubAgentExecutionOutcome>;
  spawn(request: ChildDelegationRequest): Promise<SubAgentTaskHandle>;
  /** Resume or read the exact existing leaf task linked by the parent's durable pause record. */
  resumeTool(childTaskId: string): Promise<SubAgentTaskHandle>;
}

/** Session-guarded host handle; binding and recoveryData are intentionally absent. */
export interface SubAgentTaskHandle {
  readonly taskId: string;
  snapshot(): Promise<SubAgentTaskSnapshot>;
  wait(): Promise<SubAgentExecutionOutcome>;
  cancel(reason?: string): Promise<SubAgentTaskSnapshot>;
  events(options?: SubAgentEventStreamOptions): AsyncIterable<SubAgentTaskEvent>;
}

export interface SubAgentEventStreamOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
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
  /** Lease held for one Executor execution epoch and renewed until settle. */
  readonly executionLeaseTtlMs?: number;
}

/** Session-bound Core runtime. `init()` is the only asynchronous configuration phase. */
export interface SubAgentRuntime extends SubAgentDispatcher {
  readonly sessionId: string;
  readonly stateStore: AgentRuntimeStateStore;
  /** Immutable limits persisted with a root run and inherited by every descendant task. */
  readonly limits: Readonly<ResolvedSubAgentLimits>;
  readonly ready: boolean;
  init(): Promise<void>;
  refreshCatalog(): Promise<ExecutorCatalogSnapshot>;
  /** Stage a root child create for atomic parent-checkpoint association before dispatch. */
  stageTool(
    request: ModelSubAgentRequest,
    context: SubAgentDispatchContext,
  ): Promise<StagedSubAgentTask>;
  execute(request: SubAgentExecuteRequest): Promise<SubAgentExecutionOutcome>;
  spawn(request: SubAgentExecuteRequest): Promise<SubAgentTaskHandle>;
  getTask(sessionId: string, taskId: string): Promise<SubAgentTaskSnapshot>;
  getSubAgentSession(
    sessionId: string,
    subagentSessionId: string,
  ): Promise<SubAgentSessionSnapshot>;
  wait(sessionId: string, taskId: string): Promise<SubAgentExecutionOutcome>;
  cancel(
    sessionId: string,
    taskId: string,
    reason?: string,
    options?: { readonly operationId?: string },
  ): Promise<SubAgentTaskSnapshot>;
  /** Cancel the authoritative task snapshot attached to one root run, including nested children. */
  cancelRunDescendants(
    sessionId: string,
    runId: string,
    ownership: AgentRunStateOwnership,
    reason?: string,
    options?: { readonly operationId?: string },
  ): Promise<readonly SubAgentTaskSnapshot[]>;
  /**
   * Reconcile one persisted parent call against the authoritative task snapshot. This reuses a
   * terminal, waits a resident execution, resumes approvals, adopts an expired checkpoint lease,
   * or reconnects an external binding; it never creates a replacement task.
   */
  recover(
    sessionId: string,
    taskId: string,
    options?: { readonly decisions?: readonly ApprovalDecision[] },
  ): Promise<SubAgentTaskHandle>;
  resume(
    sessionId: string,
    taskId: string,
    options: { readonly decisions?: readonly ApprovalDecision[] },
  ): Promise<SubAgentExecutionOutcome>;
  reconnect(sessionId: string, taskId: string): Promise<SubAgentTaskHandle>;
  events(
    sessionId: string,
    taskId: string,
    options?: SubAgentEventStreamOptions,
  ): AsyncIterable<SubAgentTaskEvent>;
}
