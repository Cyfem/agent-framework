import type { ApprovalRequest } from '../subagent/approval';
import type { EncodedAgentProtocolCheckpoint } from '../subagent/checkpoint';
import { SubAgentRuntimeError, type SubAgentErrorDescriptor } from '../subagent/errors';
import {
  assertJsonValue,
  canonicalizeJson,
  parseJsonValue,
  type JsonValue,
} from '../subagent/json';
import {
  StateLeaseUnavailableError,
  type StoredPendingToolBatch,
  type StoredPendingToolCall,
  type StoredPendingToolCallKind,
  type StoredPendingToolCallStatus,
} from '../subagent/state-store';
import { isAbortError } from '../llm/base/abort';
import type { AgentProtocol, AgentToolCall, MaybePromise } from './types';

export const MODEL_SUBAGENT_TOOL_NAME = 'agent';
export const END_AGENT_TOOL_NAME = 'end-agent';

const END_AGENT_STANDALONE_ERROR: Readonly<SubAgentErrorDescriptor> = Object.freeze({
  code: 'END_AGENT_MUST_BE_STANDALONE',
  message: 'end-agent must be the only Tool call in its provider batch.',
  retryable: false,
});

const TOOL_EXECUTION_ERROR: Readonly<SubAgentErrorDescriptor> = Object.freeze({
  code: 'INTERNAL_ERROR',
  message: 'The Tool call failed.',
  retryable: false,
});

export interface PlannedToolBatchCall<P extends AgentProtocol> {
  readonly call: AgentToolCall<P>;
  readonly kind: StoredPendingToolCallKind;
  readonly order: number;
}

/** Immutable provider-order plan reconstructed from one assistant response. */
export interface ToolBatchPlan<P extends AgentProtocol> {
  readonly batchId: string;
  readonly iteration: number;
  readonly assistantMessage: EncodedAgentProtocolCheckpoint;
  readonly calls: readonly PlannedToolBatchCall<P>[];
  readonly initialCheckpoint: StoredPendingToolBatch;
}

export type ToolBatchAgentCallOutcome =
  | {
      readonly status: 'settled';
      readonly taskId?: string;
      readonly output: JsonValue;
      readonly error?: SubAgentErrorDescriptor;
    }
  | {
      readonly status: 'paused';
      readonly taskId: string;
      readonly approvals: readonly ApprovalRequest[];
      readonly checkpointRevision: number;
    }
  | {
      readonly status: 'running';
      readonly taskId: string;
    };

export interface ToolBatchExecutionCallbacks<P extends AgentProtocol> {
  /** Ordinary Tools are invoked serially in provider-relative order. */
  readonly executeTool: (call: AgentToolCall<P>) => MaybePromise<JsonValue>;
  /** All create submissions in the agent sub-batch are started together and should return a handle state promptly. */
  readonly submitAgent: (call: AgentToolCall<P>) => MaybePromise<ToolBatchAgentCallOutcome>;
  /** Required only when a recovered agent call is already running or paused. */
  readonly resumeAgent?: (
    call: AgentToolCall<P>,
    checkpoint: StoredPendingToolCall,
  ) => MaybePromise<ToolBatchAgentCallOutcome>;
  /** Observe a submitted/reconnected task until its next terminal or paused state. */
  readonly observeAgent?: (
    call: AgentToolCall<P>,
    checkpoint: StoredPendingToolCall,
    signal: AbortSignal,
  ) => MaybePromise<ToolBatchAgentCallOutcome>;
  /** A valid standalone end-agent call is executed through this callback. */
  readonly executeEndAgent: (call: AgentToolCall<P>) => MaybePromise<JsonValue>;
  /** Apply one settled provider result to active protocol context, strictly in provider order. */
  readonly applyResult: (
    call: AgentToolCall<P>,
    result: OrderedToolBatchResult,
  ) => MaybePromise<void>;
  /** Called after each durable phase transition; external work never runs inside it. */
  readonly checkpoint?: (
    batch: StoredPendingToolBatch,
    approvals: readonly ApprovalRequest[],
  ) => MaybePromise<void>;
}

export interface OrderedToolBatchResult {
  readonly callId: string;
  readonly name: string;
  readonly order: number;
  readonly output: JsonValue;
  readonly error?: SubAgentErrorDescriptor;
}

export interface ToolBatchExecutionResult {
  readonly checkpoint: StoredPendingToolBatch;
  readonly complete: boolean;
  readonly waitingApproval: boolean;
  readonly approvals: readonly ApprovalRequest[];
  /**
   * Result-ready (`settled` or `applied`) calls in provider order. Presence here does not mean
   * the result was applied; inspect `complete` or the durable call status for that distinction.
   */
  readonly orderedResults: readonly OrderedToolBatchResult[];
}

interface PlannedAgentOutcome<P extends AgentProtocol> {
  readonly planned: PlannedToolBatchCall<P>;
  readonly outcome: ToolBatchAgentCallOutcome;
}

/** A local Tool/end call was in-flight at the last checkpoint and is never replayed implicitly. */
export class ToolBatchOutcomeUnknownError extends Error {
  readonly code = 'TOOL_OUTCOME_UNKNOWN';
  readonly outcomeUnknown = true;

  constructor(readonly call: StoredPendingToolCall) {
    super(`The outcome of Tool call ${call.callId} could not be confirmed.`);
    this.name = 'ToolBatchOutcomeUnknownError';
  }
}

export function createToolBatchPlan<P extends AgentProtocol>(input: {
  readonly batchId: string;
  readonly iteration: number;
  readonly assistantMessage: EncodedAgentProtocolCheckpoint;
  readonly calls: readonly AgentToolCall<P>[];
  readonly createdAt: number;
}): ToolBatchPlan<P> {
  assertNonEmpty(input.batchId, 'batchId');
  assertNonNegativeInteger(input.iteration, 'iteration');
  assertNonNegativeInteger(input.createdAt, 'createdAt');
  assertEncodedAssistantMessage(input.assistantMessage);

  const ids = new Set<string>();
  const planned = input.calls.map((call, order): PlannedToolBatchCall<P> => {
    assertToolCall(call);
    if (ids.has(call.id)) {
      throw new TypeError(`Duplicate provider Tool call id: ${call.id}.`);
    }
    ids.add(call.id);
    return Object.freeze({ call, order, kind: classifyToolCall(call.name) });
  });
  const standaloneEnd = planned.length === 1 && planned[0]?.kind === 'end-agent';
  const calls = planned.map(({ call, kind, order }): StoredPendingToolCall => {
    if (kind === 'end-agent' && !standaloneEnd) {
      return freezeStoredCall({
        callId: call.id,
        name: call.name,
        order,
        kind,
        status: 'settled',
        error: END_AGENT_STANDALONE_ERROR,
        output: errorEnvelope(END_AGENT_STANDALONE_ERROR),
      });
    }
    return freezeStoredCall({
      callId: call.id,
      name: call.name,
      order,
      kind,
      status: 'pending',
    });
  });
  const initialCheckpoint: StoredPendingToolBatch = Object.freeze({
    batchId: input.batchId,
    iteration: input.iteration,
    assistantMessage: cloneEncodedCheckpoint(input.assistantMessage),
    calls: Object.freeze(calls),
    endRequested: false,
    createdAt: input.createdAt,
  });

  return Object.freeze({
    batchId: input.batchId,
    iteration: input.iteration,
    assistantMessage: cloneEncodedCheckpoint(input.assistantMessage),
    calls: Object.freeze(planned),
    initialCheckpoint,
  });
}

export function executeToolBatchPlan<P extends AgentProtocol>(
  plan: ToolBatchPlan<P>,
  callbacks: ToolBatchExecutionCallbacks<P>,
): Promise<ToolBatchExecutionResult> {
  return runToolBatch(plan, plan.initialCheckpoint, callbacks, false);
}

/**
 * Resume the exact provider batch. Settled siblings are reused; pending work
 * starts once; running/paused agent calls use the host recovery callback.
 */
export function resumeToolBatchPlan<P extends AgentProtocol>(
  plan: ToolBatchPlan<P>,
  checkpoint: StoredPendingToolBatch,
  callbacks: ToolBatchExecutionCallbacks<P>,
): Promise<ToolBatchExecutionResult> {
  assertCheckpointMatchesPlan(plan, checkpoint);
  return runToolBatch(plan, freezeBatch(checkpoint), callbacks, true);
}

/** All results required by the provider, or a deterministic error while the batch remains open. */
export function finalizeToolBatchResults(
  checkpoint: StoredPendingToolBatch,
): readonly OrderedToolBatchResult[] {
  const unresolved = checkpoint.calls.find(({ status }) => !isResultReadyStatus(status));
  if (unresolved !== undefined) {
    throw new Error(`Tool batch ${checkpoint.batchId} still has unresolved calls.`);
  }
  return collectOrderedResults(checkpoint);
}

async function runToolBatch<P extends AgentProtocol>(
  plan: ToolBatchPlan<P>,
  startingCheckpoint: StoredPendingToolBatch,
  callbacks: ToolBatchExecutionCallbacks<P>,
  recovering: boolean,
): Promise<ToolBatchExecutionResult> {
  assertCheckpointMatchesPlan(plan, startingCheckpoint);
  let checkpoint = startingCheckpoint;
  const approvals: ApprovalRequest[] = [];

  // The prevalidated mixed end-agent errors are durable before any real handler runs.
  await persist(callbacks, checkpoint, approvals);

  for (const planned of plan.calls.filter(({ kind }) => kind === 'tool')) {
    const current = callAt(checkpoint, planned.order);
    if (isResultReadyStatus(current.status)) continue;
    if (current.status === 'running' || current.status === 'paused') {
      throw new ToolBatchOutcomeUnknownError(current);
    }

    checkpoint = replaceCall(checkpoint, runningCall(current));
    await persist(callbacks, checkpoint, approvals);
    const settled = await settleOrdinaryCall(planned.call, callbacks.executeTool);
    checkpoint = replaceCall(checkpoint, settledCall(current, settled));
    await persist(callbacks, checkpoint, approvals);
  }

  const agentCalls = plan.calls.filter(({ kind }) => kind === 'agent');
  const pendingAgents = agentCalls.filter(({ order }) => {
    const status = callAt(checkpoint, order).status;
    return !isResultReadyStatus(status);
  });

  if (pendingAgents.length > 0) {
    if (
      recovering &&
      callbacks.resumeAgent === undefined &&
      pendingAgents.some(({ order }) => callAt(startingCheckpoint, order).status !== 'pending')
    ) {
      throw new TypeError('resumeAgent is required for a recovered active agent call.');
    }

    const submissions = new Map<number, Promise<PlannedAgentOutcome<P>>>();
    for (const planned of pendingAgents) {
      const durableCall = callAt(startingCheckpoint, planned.order);
      const submission = Promise.resolve()
        .then(async (): Promise<ToolBatchAgentCallOutcome> => {
          if (recovering && durableCall.status !== 'pending') {
            return callbacks.resumeAgent!(planned.call, durableCall);
          }
          return callbacks.submitAgent(planned.call);
        })
        .then((outcome) => ({ planned, outcome }));
      submissions.set(planned.order, submission);
    }

    // Every submission is already started. Persist each returned taskId before
    // waiting for slower siblings or beginning the observation sub-batch.
    while (submissions.size > 0) {
      let submitted: PlannedAgentOutcome<P>;
      try {
        submitted = await Promise.race(submissions.values());
      } catch (error) {
        for (const pending of submissions.values()) void pending.catch(() => undefined);
        throw error;
      }
      submissions.delete(submitted.planned.order);
      const current = callAt(checkpoint, submitted.planned.order);
      const { outcome } = submitted;
      if (outcome.status === 'paused') {
        approvals.push(...outcome.approvals.map((approval) => Object.freeze({ ...approval })));
      }
      checkpoint = replaceCall(checkpoint, agentOutcomeCall(current, outcome));
      await persist(callbacks, checkpoint, approvals);
    }

    const initiallyPaused = checkpoint.calls.some(({ status }) => status === 'paused');
    if (!initiallyPaused && callbacks.observeAgent !== undefined) {
      checkpoint = await observeAgentSubBatch(plan, checkpoint, callbacks, approvals);
    }
  }

  const end = plan.calls.find(({ kind }) => kind === 'end-agent');
  if (end !== undefined && plan.calls.length === 1) {
    const current = callAt(checkpoint, end.order);
    if (!isResultReadyStatus(current.status)) {
      if (current.status !== 'pending') {
        throw new ToolBatchOutcomeUnknownError(current);
      }
      checkpoint = replaceCall(checkpoint, runningCall(current));
      await persist(callbacks, checkpoint, approvals);
      const settled = {
        output: cloneJson(await Promise.resolve(callbacks.executeEndAgent(end.call))),
      };
      checkpoint = replaceCall(
        { ...checkpoint, endRequested: true },
        settledCall(current, settled),
      );
      await persist(callbacks, checkpoint, approvals);
    }
  }

  if (
    approvals.length === 0 &&
    checkpoint.calls.every(({ status }) => isResultReadyStatus(status))
  ) {
    for (const planned of plan.calls) {
      const current = callAt(checkpoint, planned.order);
      if (current.status === 'applied') continue;
      const result = resultFromStoredCall(current);
      await Promise.resolve(callbacks.applyResult(planned.call, result));
      checkpoint = replaceCall(checkpoint, appliedCall(current));
      await persist(callbacks, checkpoint, approvals);
    }
  }

  return buildExecutionResult(checkpoint, approvals);
}

async function observeAgentSubBatch<P extends AgentProtocol>(
  plan: ToolBatchPlan<P>,
  startingCheckpoint: StoredPendingToolBatch,
  callbacks: ToolBatchExecutionCallbacks<P>,
  approvals: ApprovalRequest[],
): Promise<StoredPendingToolBatch> {
  let checkpoint = startingCheckpoint;
  const observationController = new AbortController();
  const active = new Map<number, Promise<PlannedAgentOutcome<P>>>();

  for (const planned of plan.calls.filter(({ kind, order }) => {
    return kind === 'agent' && callAt(checkpoint, order).status === 'running';
  })) {
    const durableCall = callAt(checkpoint, planned.order);
    const observation = Promise.resolve()
      .then(() => callbacks.observeAgent!(planned.call, durableCall, observationController.signal))
      .then((outcome) => ({ planned, outcome }));
    active.set(planned.order, observation);
  }

  while (active.size > 0) {
    let observed: PlannedAgentOutcome<P>;
    try {
      observed = await Promise.race(active.values());
    } catch (error) {
      observationController.abort(error);
      for (const pending of active.values()) void pending.catch(() => undefined);
      throw error;
    }
    active.delete(observed.planned.order);
    const current = callAt(checkpoint, observed.planned.order);
    if (observed.outcome.status === 'paused') {
      approvals.push(
        ...observed.outcome.approvals.map((approval) => Object.freeze({ ...approval })),
      );
    }
    checkpoint = replaceCall(checkpoint, agentOutcomeCall(current, observed.outcome));
    await persist(callbacks, checkpoint, approvals);

    if (observed.outcome.status === 'paused') {
      // Remaining tasks continue in their Executors. Their durable parent call
      // state intentionally stays running and recovery reconnects/query them.
      observationController.abort(
        new Error('Parent Tool batch paused; reconnect remaining agent tasks after approval.'),
      );
      for (const pending of active.values()) void pending.catch(() => undefined);
      break;
    }
  }

  return checkpoint;
}

async function settleOrdinaryCall<P extends AgentProtocol>(
  call: AgentToolCall<P>,
  execute: (call: AgentToolCall<P>) => MaybePromise<JsonValue>,
): Promise<{ readonly output: JsonValue; readonly error?: SubAgentErrorDescriptor }> {
  let output: JsonValue;
  try {
    output = await Promise.resolve(execute(call));
  } catch (error) {
    if (isStableControlError(error)) throw error;
    return {
      error: TOOL_EXECUTION_ERROR,
      output: errorEnvelope(TOOL_EXECUTION_ERROR),
    };
  }
  return { output: cloneJson(output) };
}

function agentOutcomeCall(
  current: StoredPendingToolCall,
  outcome: ToolBatchAgentCallOutcome,
): StoredPendingToolCall {
  if (outcome.status === 'running') {
    return freezeStoredCall({ ...current, status: 'running', taskId: outcome.taskId });
  }
  if (outcome.status === 'paused') {
    assertNonEmpty(outcome.taskId, 'taskId');
    assertNonNegativeInteger(outcome.checkpointRevision, 'checkpointRevision');
    return freezeStoredCall({ ...current, status: 'paused', taskId: outcome.taskId });
  }
  return freezeStoredCall({
    ...current,
    status: 'settled',
    ...(outcome.taskId === undefined ? {} : { taskId: outcome.taskId }),
    output: cloneJson(outcome.output),
    ...(outcome.error === undefined ? {} : { error: Object.freeze({ ...outcome.error }) }),
  });
}

function buildExecutionResult(
  checkpoint: StoredPendingToolBatch,
  approvals: readonly ApprovalRequest[],
): ToolBatchExecutionResult {
  const complete = checkpoint.calls.every(({ status }) => status === 'applied');
  return Object.freeze({
    checkpoint,
    complete,
    waitingApproval: checkpoint.calls.some(({ status }) => status === 'paused'),
    approvals: Object.freeze(approvals),
    orderedResults: collectOrderedResults(checkpoint),
  });
}

function collectOrderedResults(
  checkpoint: StoredPendingToolBatch,
): readonly OrderedToolBatchResult[] {
  return Object.freeze(
    [...checkpoint.calls]
      .sort((left, right) => left.order - right.order)
      .flatMap((call) => {
        if (!isResultReadyStatus(call.status) || call.output === undefined) return [];
        return [resultFromStoredCall(call)];
      }),
  );
}

function resultFromStoredCall(call: StoredPendingToolCall): OrderedToolBatchResult {
  if (!isResultReadyStatus(call.status) || call.output === undefined) {
    throw new Error(`Tool call ${call.callId} does not have a result ready to apply.`);
  }
  return Object.freeze({
    callId: call.callId,
    name: call.name,
    order: call.order,
    output: cloneJson(call.output),
    ...(call.error === undefined ? {} : { error: Object.freeze({ ...call.error }) }),
  });
}

function settledCall(
  current: StoredPendingToolCall,
  settled: { readonly output: JsonValue; readonly error?: SubAgentErrorDescriptor },
): StoredPendingToolCall {
  return freezeStoredCall({
    ...current,
    status: 'settled',
    output: cloneJson(settled.output),
    ...(settled.error === undefined ? {} : { error: Object.freeze({ ...settled.error }) }),
  });
}

function appliedCall(current: StoredPendingToolCall): StoredPendingToolCall {
  if (current.status !== 'settled' || current.output === undefined) {
    throw new Error(`Tool call ${current.callId} cannot transition to applied.`);
  }
  return freezeStoredCall({ ...current, status: 'applied' });
}

function isResultReadyStatus(status: StoredPendingToolCallStatus): boolean {
  return status === 'settled' || status === 'applied';
}

function isStableControlError(error: unknown): boolean {
  return (
    error instanceof SubAgentRuntimeError ||
    error instanceof ToolBatchOutcomeUnknownError ||
    error instanceof StateLeaseUnavailableError ||
    isAbortError(error) ||
    (typeof error === 'object' &&
      error !== null &&
      'outcomeUnknown' in error &&
      (error as { readonly outcomeUnknown?: unknown }).outcomeUnknown === true)
  );
}

function runningCall(current: StoredPendingToolCall): StoredPendingToolCall {
  return freezeStoredCall({
    callId: current.callId,
    name: current.name,
    order: current.order,
    kind: current.kind,
    status: 'running',
    ...(current.taskId === undefined ? {} : { taskId: current.taskId }),
  });
}

function replaceCall(
  checkpoint: StoredPendingToolBatch,
  replacement: StoredPendingToolCall,
): StoredPendingToolBatch {
  return freezeBatch({
    ...checkpoint,
    calls: checkpoint.calls.map((call) => (call.order === replacement.order ? replacement : call)),
  });
}

function callAt(checkpoint: StoredPendingToolBatch, order: number): StoredPendingToolCall {
  const call = checkpoint.calls.find((candidate) => candidate.order === order);
  if (call === undefined) {
    throw new Error(`Tool batch ${checkpoint.batchId} is missing provider call order ${order}.`);
  }
  return call;
}

async function persist<P extends AgentProtocol>(
  callbacks: ToolBatchExecutionCallbacks<P>,
  checkpoint: StoredPendingToolBatch,
  approvals: readonly ApprovalRequest[],
): Promise<void> {
  if (callbacks.checkpoint !== undefined) {
    await Promise.resolve(callbacks.checkpoint(checkpoint, Object.freeze([...approvals])));
  }
}

function assertCheckpointMatchesPlan<P extends AgentProtocol>(
  plan: ToolBatchPlan<P>,
  checkpoint: StoredPendingToolBatch,
): void {
  if (
    checkpoint.batchId !== plan.batchId ||
    checkpoint.iteration !== plan.iteration ||
    checkpoint.calls.length !== plan.calls.length
  ) {
    throw new Error('The pending Tool batch does not match the reconstructed provider batch.');
  }
  for (const planned of plan.calls) {
    const stored = callAt(checkpoint, planned.order);
    if (
      stored.callId !== planned.call.id ||
      stored.name !== planned.call.name ||
      stored.kind !== planned.kind
    ) {
      throw new Error('The pending Tool call identity or provider order does not match.');
    }
  }
}

function classifyToolCall(name: string): StoredPendingToolCallKind {
  if (name === MODEL_SUBAGENT_TOOL_NAME) return 'agent';
  if (name === END_AGENT_TOOL_NAME) return 'end-agent';
  return 'tool';
}

function errorEnvelope(error: SubAgentErrorDescriptor): JsonValue {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  };
}

function freezeBatch(checkpoint: StoredPendingToolBatch): StoredPendingToolBatch {
  return Object.freeze({
    ...checkpoint,
    assistantMessage: cloneEncodedCheckpoint(checkpoint.assistantMessage),
    calls: Object.freeze(checkpoint.calls.map(freezeStoredCall)),
  });
}

function freezeStoredCall(call: StoredPendingToolCall): StoredPendingToolCall {
  return Object.freeze({
    ...call,
    ...(call.output === undefined ? {} : { output: cloneJson(call.output) }),
    ...(call.error === undefined ? {} : { error: Object.freeze({ ...call.error }) }),
  });
}

function cloneEncodedCheckpoint(
  checkpoint: EncodedAgentProtocolCheckpoint,
): EncodedAgentProtocolCheckpoint {
  return Object.freeze({
    protocol: checkpoint.protocol,
    codecVersion: checkpoint.codecVersion,
    value: cloneJson(checkpoint.value),
  });
}

function cloneJson(value: JsonValue): JsonValue {
  assertJsonValue(value);
  return parseJsonValue(canonicalizeJson(value));
}

function assertEncodedAssistantMessage(checkpoint: EncodedAgentProtocolCheckpoint): void {
  if (typeof checkpoint !== 'object' || checkpoint === null) {
    throw new TypeError('assistantMessage checkpoint must be an object.');
  }
  assertNonEmpty(checkpoint.protocol, 'assistantMessage.protocol');
  assertNonEmpty(checkpoint.codecVersion, 'assistantMessage.codecVersion');
  assertJsonValue(checkpoint.value);
}

function assertToolCall<P extends AgentProtocol>(call: AgentToolCall<P>): void {
  if (typeof call !== 'object' || call === null) {
    throw new TypeError('A provider Tool call must be an object.');
  }
  assertNonEmpty(call.id, 'Tool call id');
  assertNonEmpty(call.name, 'Tool call name');
  if (typeof call.arguments !== 'string') {
    throw new TypeError('Tool call arguments must be a string.');
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string.`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}
