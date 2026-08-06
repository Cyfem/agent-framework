import type { ApprovalDecision, ApprovalDecisionRecord, ApprovalRequest } from './approval';
import {
  SubAgentRuntimeError,
  type SubAgentErrorCode,
  type SubAgentErrorDescriptor,
} from './errors';
import {
  assertJsonValue,
  canonicalJsonSha256,
  canonicalizeJson,
  JsonValueError,
  parseJsonValue,
  type JsonValue,
} from './json';
import { DEFAULT_SUBAGENT_IO_LIMITS, type SubAgentLimits, type TreeBudgetSnapshot } from './limits';
import type {
  CompletionReceipt,
  ResultReceipt,
  SubAgentTaskResult,
  SubAgentTaskState,
} from './result';
import type { StoredTask } from './state-store';
import type {
  ExecutorEventInput,
  SafeEventData,
  SubAgentTaskEvent,
  SubAgentTaskEventType,
} from './telemetry';

export const TERMINAL_SUBAGENT_TASK_STATES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'budget_exceeded',
] as const satisfies readonly SubAgentTaskState[]);

type TerminalSubAgentTaskState = (typeof TERMINAL_SUBAGENT_TASK_STATES)[number];
type FailureSubAgentTaskState = Exclude<TerminalSubAgentTaskState, 'succeeded'>;

const TERMINAL_STATE_SET = new Set<SubAgentTaskState>(TERMINAL_SUBAGENT_TASK_STATES);

const LEGAL_TRANSITIONS: Readonly<Record<SubAgentTaskState, ReadonlySet<SubAgentTaskState>>> =
  Object.freeze({
    queued: new Set<SubAgentTaskState>([
      'running',
      'failed',
      'cancelled',
      'timed_out',
      'budget_exceeded',
    ]),
    running: new Set<SubAgentTaskState>([
      'waiting_approval',
      'result_submitted',
      'failed',
      'cancelled',
      'timed_out',
      'budget_exceeded',
    ]),
    waiting_approval: new Set<SubAgentTaskState>(['running', 'failed', 'cancelled']),
    result_submitted: new Set<SubAgentTaskState>([
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
      'budget_exceeded',
    ]),
    succeeded: new Set<SubAgentTaskState>(),
    failed: new Set<SubAgentTaskState>(),
    cancelled: new Set<SubAgentTaskState>(),
    timed_out: new Set<SubAgentTaskState>(),
    budget_exceeded: new Set<SubAgentTaskState>(),
  });

const FAILURE_DEFAULTS: Readonly<
  Record<FailureSubAgentTaskState, Readonly<SubAgentErrorDescriptor>>
> = Object.freeze({
  failed: Object.freeze({
    code: 'EXECUTOR_FAILED',
    message: 'The subagent execution failed.',
    retryable: false,
  }),
  cancelled: Object.freeze({
    code: 'CANCELLED',
    message: 'The subagent execution was cancelled.',
    retryable: false,
  }),
  timed_out: Object.freeze({
    code: 'TIMED_OUT',
    message: 'The subagent execution timed out.',
    retryable: true,
  }),
  budget_exceeded: Object.freeze({
    code: 'BUDGET_EXCEEDED',
    message: 'The subagent execution budget was exceeded.',
    retryable: false,
  }),
});

function runtimeError(
  code: SubAgentErrorCode,
  message: string,
  retryable = false,
): SubAgentRuntimeError {
  return new SubAgentRuntimeError({ code, message, retryable });
}

function assertFiniteTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
}

function assertNonEmptyId(value: string | undefined, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function nextRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Task revision cannot be incremented safely.');
  }
  return revision + 1;
}

function mutableTaskCopy(task: StoredTask): Record<string, unknown> {
  return { ...task };
}

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeJson(item))) as readonly JsonValue[];
  }
  if (value !== null && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, freezeJson(item as JsonValue)]),
      ),
    );
  }
  return value;
}

function cloneJsonWithinLimit(value: unknown, maxBytes: number, label: string): JsonValue {
  try {
    assertJsonValue(value, { maxBytes, label });
  } catch (error) {
    const byteLimit = error instanceof JsonValueError && error.reason === 'byte-limit-exceeded';
    throw runtimeError(
      byteLimit ? 'INVALID_OUTPUT' : 'OUTPUT_NOT_JSON_SAFE',
      byteLimit
        ? `${label} exceeds the configured canonical JSON byte limit.`
        : `${label} must be a JSON-safe value.`,
    );
  }
  return freezeJson(parseJsonValue(canonicalizeJson(value)));
}

function taskIdentity(task: StoredTask) {
  return Object.freeze({
    taskId: task.taskId,
    subAgent: Object.freeze({ ...task.definition }),
  });
}

function elapsedAt(task: StoredTask, now: number): number {
  const startedAt =
    task.activeStartedAt ??
    (task.state === 'running' && task.recoveryRequired ? task.updatedAt : undefined);
  if (startedAt === undefined) return 0;
  return Math.max(0, now - startedAt);
}

function applyStoppedClock(draft: Record<string, unknown>, task: StoredTask, now: number): void {
  const elapsed = elapsedAt(task, now);
  draft.activeElapsedMs = task.activeElapsedMs + elapsed;
  draft.remainingMs = Math.max(0, task.remainingMs - elapsed);
  delete draft.activeStartedAt;
}

export function isTerminalSubAgentTaskState(
  state: SubAgentTaskState,
): state is TerminalSubAgentTaskState {
  return TERMINAL_STATE_SET.has(state);
}

export function assertSubAgentTaskTransition(
  current: SubAgentTaskState,
  next: SubAgentTaskState,
): void {
  if (!LEGAL_TRANSITIONS[current].has(next)) {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      `Subagent task cannot transition from ${current} to ${next}.`,
    );
  }
}

export interface TransitionSubAgentTaskOptions {
  readonly now: number;
  readonly approvals?: readonly ApprovalRequest[];
  readonly error?: SubAgentErrorDescriptor;
  readonly output?: JsonValue;
  readonly resultReceipt?: ResultReceipt;
  readonly partialOutput?: JsonValue;
  readonly maxOutputBytes?: number;
}

/**
 * Apply one legal task transition without mutating the input record.
 * Persistence still owns revision/fencing CAS; this helper only constructs its candidate record.
 */
export function transitionSubAgentTask(
  task: StoredTask,
  next: SubAgentTaskState,
  options: TransitionSubAgentTaskOptions,
): Readonly<StoredTask> {
  assertSubAgentTaskTransition(task.state, next);
  assertFiniteTimestamp(options.now, 'Transition time');
  if (options.now < task.updatedAt) {
    throw new RangeError('Transition time cannot be earlier than task.updatedAt.');
  }

  const revision = nextRevision(task.revision);
  const draft = mutableTaskCopy(task);
  draft.state = next;
  draft.revision = revision;
  draft.updatedAt = options.now;

  if (next === 'running') {
    // A queued task already represents create operation attempt 1. Resuming a
    // paused task starts a new Executor operation and therefore increments it.
    draft.attempt = task.state === 'queued' ? task.attempt : task.attempt + 1;
    draft.activeStartedAt = options.now;
    draft.recoveryRequired = false;
    draft.approvals = Object.freeze([...(options.approvals ?? [])]);
    delete draft.error;
  } else if (next === 'waiting_approval') {
    const approvals = options.approvals ?? [];
    if (approvals.length === 0) {
      throw runtimeError(
        'APPROVAL_REQUIRED',
        'A waiting_approval transition requires at least one approval request.',
      );
    }
    applyStoppedClock(draft, task, options.now);
    draft.approvals = Object.freeze([...approvals]);
  } else if (next === 'result_submitted') {
    if (options.output === undefined || options.resultReceipt === undefined) {
      throw runtimeError(
        'RESULT_REQUIRED',
        'The result_submitted state requires a durable output and result receipt.',
      );
    }
    const output = cloneJsonWithinLimit(
      options.output,
      options.maxOutputBytes ?? DEFAULT_SUBAGENT_IO_LIMITS.maxOutputBytes,
      'Subagent output',
    );
    draft.output = output;
    draft.resultReceipt = Object.freeze({ ...options.resultReceipt });
    draft.approvals = Object.freeze([]);
    delete draft.partialOutput;
    delete draft.error;
    delete draft.result;
  } else if (isTerminalSubAgentTaskState(next)) {
    applyStoppedClock(draft, task, options.now);
    draft.terminalAt = options.now;
    draft.approvals = Object.freeze([]);
    draft.recoveryRequired = false;

    if (next === 'succeeded') {
      if (task.state !== 'result_submitted' || task.output === undefined || !task.resultReceipt) {
        throw runtimeError(
          'RESULT_REQUIRED',
          'A subagent task can succeed only after a durable result receipt exists.',
        );
      }
      const result: SubAgentTaskResult = Object.freeze({
        status: 'succeeded',
        task: taskIdentity(task),
        executor: task.executor,
        output: task.output,
        ...(task.usage === undefined ? {} : { usage: task.usage }),
      });
      draft.result = result;
      draft.output = task.output;
      delete draft.partialOutput;
      delete draft.error;
    } else {
      const error = Object.freeze({ ...(options.error ?? FAILURE_DEFAULTS[next]) });
      const sourcePartial =
        options.partialOutput ??
        (task.state === 'result_submitted' ? task.output : task.partialOutput);
      const partialOutput =
        sourcePartial === undefined
          ? undefined
          : cloneJsonWithinLimit(
              sourcePartial,
              options.maxOutputBytes ?? DEFAULT_SUBAGENT_IO_LIMITS.maxOutputBytes,
              'Subagent partial output',
            );
      const result: SubAgentTaskResult = Object.freeze({
        status: next,
        task: taskIdentity(task),
        executor: task.executor,
        error,
        ...(partialOutput === undefined ? {} : { partialOutput }),
        ...(task.usage === undefined ? {} : { usage: task.usage }),
      });
      draft.error = error;
      draft.result = result;
      if (partialOutput === undefined) delete draft.partialOutput;
      else draft.partialOutput = partialOutput;
      delete draft.output;
    }
  }

  return Object.freeze(draft) as unknown as Readonly<StoredTask>;
}

export interface SubmitSubAgentResultInput {
  readonly callId: string;
  readonly output: unknown;
  /** Required for a first submission; ignored for a replay. */
  readonly receiptId?: string;
  readonly submittedAt: number;
  readonly maxOutputBytes?: number;
}

export interface SubmitSubAgentResultOutcome {
  readonly task: Readonly<StoredTask>;
  readonly receipt: Readonly<ResultReceipt>;
  readonly replayed: boolean;
}

/** Validate, hash and publish the typed child result exactly once. */
export function submitSubAgentResult(
  task: StoredTask,
  input: SubmitSubAgentResultInput,
): Readonly<SubmitSubAgentResultOutcome> {
  assertNonEmptyId(input.callId, 'Result callId');
  assertFiniteTimestamp(input.submittedAt, 'Result submission time');
  const output = cloneJsonWithinLimit(
    input.output,
    input.maxOutputBytes ?? DEFAULT_SUBAGENT_IO_LIMITS.maxOutputBytes,
    'Subagent output',
  );
  const outputHash = canonicalJsonSha256(output);

  if (task.resultReceipt !== undefined) {
    if (task.resultReceipt.callId !== input.callId) {
      throw runtimeError(
        'RESULT_ALREADY_SUBMITTED',
        'A result was already submitted by a different Tool call.',
      );
    }
    if (task.resultReceipt.outputHash !== outputHash) {
      throw runtimeError(
        'RESULT_REPLAY_CONFLICT',
        'The replayed result payload does not match the durable result receipt.',
      );
    }
    const replayReceipt = Object.freeze({ ...task.resultReceipt, status: 'replayed' as const });
    return Object.freeze({ task, receipt: replayReceipt, replayed: true });
  }

  if (task.state !== 'running') {
    throw runtimeError(
      'RESULT_PHASE_CLOSED',
      `The result phase is closed while the task is ${task.state}.`,
    );
  }

  assertNonEmptyId(input.receiptId, 'Result receiptId');
  const receipt = Object.freeze({
    schemaVersion: '1' as const,
    receiptId: input.receiptId,
    taskId: task.taskId,
    callId: input.callId,
    revision: nextRevision(task.revision),
    outputHash,
    submittedAt: input.submittedAt,
    status: 'accepted' as const,
  });
  const nextTask = transitionSubAgentTask(task, 'result_submitted', {
    now: input.submittedAt,
    output,
    resultReceipt: receipt,
    ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
  });
  return Object.freeze({ task: nextTask, receipt, replayed: false });
}

export interface CompleteSubAgentTaskInput {
  readonly callId: string;
  /** Required for a first completion; ignored for a replay. */
  readonly receiptId?: string;
  readonly completedAt: number;
  readonly isStandalone: boolean;
  readonly outputDecodable: boolean;
}

export interface CompleteSubAgentTaskOutcome {
  readonly task: Readonly<StoredTask>;
  readonly receipt: Readonly<CompletionReceipt>;
  readonly replayed: boolean;
}

/** Enforce the standalone end-agent gate and construct its terminal CAS candidate. */
export function completeSubAgentTask(
  task: StoredTask,
  input: CompleteSubAgentTaskInput,
): Readonly<CompleteSubAgentTaskOutcome> {
  assertNonEmptyId(input.callId, 'Completion callId');
  assertFiniteTimestamp(input.completedAt, 'Completion time');
  if (!input.isStandalone) {
    throw runtimeError(
      'END_AGENT_MUST_BE_STANDALONE',
      'end-agent must be the only Tool call in its provider response.',
    );
  }

  if (task.completionReceipt !== undefined) {
    if (task.state !== 'succeeded' || task.completionReceipt.callId !== input.callId) {
      throw runtimeError(
        'INVALID_STATE_TRANSITION',
        'The completion replay does not match the durable terminal receipt.',
      );
    }
    const replayReceipt = Object.freeze({
      ...task.completionReceipt,
      status: 'replayed' as const,
    });
    return Object.freeze({ task, receipt: replayReceipt, replayed: true });
  }

  if (task.state !== 'result_submitted') {
    if (task.resultReceipt === undefined) {
      throw runtimeError('RESULT_REQUIRED', 'end-agent requires a submitted typed result.');
    }
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      `end-agent cannot complete a task in state ${task.state}.`,
    );
  }
  if (task.resultReceipt === undefined || task.output === undefined || !input.outputDecodable) {
    throw runtimeError(
      'RESULT_REQUIRED',
      'end-agent requires a durable and schema-decodable typed result.',
    );
  }

  assertNonEmptyId(input.receiptId, 'Completion receiptId');
  const receipt = Object.freeze({
    schemaVersion: '1' as const,
    receiptId: input.receiptId,
    taskId: task.taskId,
    callId: input.callId,
    revision: nextRevision(task.revision),
    completedAt: input.completedAt,
    status: 'completed' as const,
  });
  const transitioned = transitionSubAgentTask(task, 'succeeded', { now: input.completedAt });
  const nextTask = Object.freeze({ ...transitioned, completionReceipt: receipt });
  return Object.freeze({ task: nextTask, receipt, replayed: false });
}

export interface DecideApprovalInput {
  readonly decision: ApprovalDecision;
  readonly now: number;
}

export interface DecideApprovalOutcome {
  readonly task: Readonly<StoredTask>;
  readonly decision: Readonly<ApprovalDecisionRecord>;
  readonly replayed: boolean;
}

/** Apply the trusted host approval decision with the exact now < expiresAt boundary. */
export function decideApproval(
  task: StoredTask,
  input: DecideApprovalInput,
): Readonly<DecideApprovalOutcome> {
  assertFiniteTimestamp(input.now, 'Approval decision time');
  const requested = input.decision;
  assertNonEmptyId(requested.approvalId, 'Approval ID');

  const previous = task.approvalDecisions.find(
    ({ approvalId }) => approvalId === requested.approvalId,
  );
  if (previous !== undefined) {
    const sameDecision =
      previous.approvalId === requested.approvalId &&
      previous.expectedRevision === requested.expectedRevision &&
      (previous.decision === requested.decision || previous.decision === 'expired');
    if (!sameDecision) {
      throw runtimeError(
        'APPROVAL_CONFLICT',
        'The approval decision conflicts with a previously committed decision.',
      );
    }
    return Object.freeze({ task, decision: previous, replayed: true });
  }

  if (task.state === 'result_submitted') {
    throw runtimeError('RESULT_PHASE_CLOSED', 'Approval is closed after a result is submitted.');
  }
  if (task.state !== 'waiting_approval') {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      `Approval cannot be decided while the task is ${task.state}.`,
    );
  }

  const request = task.approvals.find(({ approvalId }) => approvalId === requested.approvalId);
  if (request === undefined) {
    throw runtimeError('RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  }
  if (requested.expectedRevision !== request.revision) {
    throw runtimeError('APPROVAL_CONFLICT', 'The approval revision is stale or conflicting.');
  }

  const expired = request.expiresAt !== undefined && input.now >= request.expiresAt;
  const committedDecision: ApprovalDecisionRecord['decision'] = expired
    ? 'expired'
    : requested.decision;
  const remainingApprovals = task.approvals.filter(
    ({ approvalId }) => approvalId !== request.approvalId,
  );

  let nextTask: Readonly<StoredTask>;
  if (committedDecision === 'expired') {
    nextTask = transitionSubAgentTask(task, 'failed', {
      now: input.now,
      error: {
        code: 'APPROVAL_EXPIRED',
        message: 'The approval request expired before it was approved.',
        retryable: false,
      },
    });
  } else if (committedDecision === 'rejected') {
    nextTask = transitionSubAgentTask(task, 'failed', {
      now: input.now,
      error: {
        code: 'APPROVAL_REJECTED',
        message: 'The approval request was rejected by the host.',
        retryable: false,
      },
    });
  } else if (remainingApprovals.length === 0) {
    nextTask = transitionSubAgentTask(task, 'running', {
      now: input.now,
      approvals: remainingApprovals,
    });
  } else {
    const draft = mutableTaskCopy(task);
    draft.revision = nextRevision(task.revision);
    draft.updatedAt = input.now;
    draft.approvals = Object.freeze(remainingApprovals);
    nextTask = Object.freeze(draft) as unknown as Readonly<StoredTask>;
  }

  const record: Readonly<ApprovalDecisionRecord> = Object.freeze({
    approvalId: requested.approvalId,
    callId: request.callId,
    expectedRevision: requested.expectedRevision,
    decision: committedDecision,
    ...(requested.reason === undefined ? {} : { reason: requested.reason }),
    decidedAt: input.now,
    taskRevision: nextTask.revision,
  });
  nextTask = Object.freeze({
    ...nextTask,
    approvalDecisions: Object.freeze([...task.approvalDecisions, record]),
  });
  return Object.freeze({ task: nextTask, decision: record, replayed: false });
}

export interface TreeBudgetAmount {
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost?: number;
}

export type TreeBudgetLimits = Pick<
  SubAgentLimits,
  'maxProviderCalls' | 'maxInputTokens' | 'maxOutputTokens' | 'maxCost'
>;

function assertBudgetCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

function assertBudgetAmount(amount: TreeBudgetAmount, label: string): void {
  assertBudgetCount(amount.providerCalls, `${label}.providerCalls`);
  assertBudgetCount(amount.inputTokens, `${label}.inputTokens`);
  assertBudgetCount(amount.outputTokens, `${label}.outputTokens`);
  if (amount.cost !== undefined && (!Number.isFinite(amount.cost) || amount.cost < 0)) {
    throw new RangeError(`${label}.cost must be a finite non-negative number.`);
  }
}

function assertBudgetSnapshot(snapshot: TreeBudgetSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === 'cost') {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError('Tree budget cost must be a finite non-negative number.');
      }
    } else {
      assertBudgetCount(value, `Tree budget ${key}`);
    }
  }
}

function assertWithinBudgetLimits(
  snapshot: TreeBudgetSnapshot,
  limits: Partial<TreeBudgetLimits>,
): void {
  const violations = [
    ['providerCalls', snapshot.providerCalls, limits.maxProviderCalls],
    ['inputTokens', snapshot.inputTokens, limits.maxInputTokens],
    ['outputTokens', snapshot.outputTokens, limits.maxOutputTokens],
    ['cost', snapshot.cost ?? 0, limits.maxCost],
  ] as const;
  const violation = violations.find(
    ([, actual, maximum]) => maximum !== undefined && actual > maximum,
  );
  if (violation !== undefined) {
    throw runtimeError(
      'BUDGET_EXCEEDED',
      `Tree budget ${violation[0]} would exceed its configured limit.`,
    );
  }
}

function budgetWithUsage(
  snapshot: TreeBudgetSnapshot,
  amount: TreeBudgetAmount,
  multiplier: 1 | -1,
): Readonly<TreeBudgetSnapshot> {
  const currentCost = snapshot.cost ?? 0;
  const amountCost = amount.cost ?? 0;
  const nextCost = currentCost + multiplier * amountCost;
  const includeCost = snapshot.cost !== undefined || amount.cost !== undefined;
  const next = {
    ...snapshot,
    providerCalls: snapshot.providerCalls + multiplier * amount.providerCalls,
    inputTokens: snapshot.inputTokens + multiplier * amount.inputTokens,
    outputTokens: snapshot.outputTokens + multiplier * amount.outputTokens,
    ...(includeCost ? { cost: nextCost } : {}),
  };
  assertBudgetSnapshot(next);
  return Object.freeze(next);
}

/** Atomically reservable provider usage candidate. No counter is changed on failure. */
export function reserveTreeBudget(
  snapshot: TreeBudgetSnapshot,
  reservation: TreeBudgetAmount,
  limits: Partial<TreeBudgetLimits> = {},
): Readonly<TreeBudgetSnapshot> {
  assertBudgetSnapshot(snapshot);
  assertBudgetAmount(reservation, 'Budget reservation');
  const next = budgetWithUsage(snapshot, reservation, 1);
  assertWithinBudgetLimits(next, limits);
  return next;
}

export interface SettleTreeBudgetOptions {
  /** An uncertain provider attempt conservatively keeps the full reservation. */
  readonly outcomeUnknown?: boolean;
}

/** Replace one reservation with actual usage, or retain it for an unknown outcome. */
export function settleTreeBudget(
  snapshot: TreeBudgetSnapshot,
  reservation: TreeBudgetAmount,
  actual: TreeBudgetAmount,
  limits: Partial<TreeBudgetLimits> = {},
  options: SettleTreeBudgetOptions = {},
): Readonly<TreeBudgetSnapshot> {
  assertBudgetSnapshot(snapshot);
  assertBudgetAmount(reservation, 'Budget reservation');
  assertBudgetAmount(actual, 'Actual budget usage');
  if (options.outcomeUnknown === true) return Object.freeze({ ...snapshot });

  for (const key of ['providerCalls', 'inputTokens', 'outputTokens'] as const) {
    if (actual[key] > reservation[key]) {
      throw runtimeError('BUDGET_EXCEEDED', `Actual ${key} exceeded its provider reservation.`);
    }
  }
  if ((actual.cost ?? 0) > (reservation.cost ?? 0)) {
    throw runtimeError('BUDGET_EXCEEDED', 'Actual cost exceeded its provider reservation.');
  }

  const released = budgetWithUsage(snapshot, reservation, -1);
  const settled = budgetWithUsage(released, actual, 1);
  assertWithinBudgetLimits(settled, limits);
  return settled;
}

const SAFE_EVENT_TYPES = new Set<SubAgentTaskEventType>([
  'task.queued',
  'task.started',
  'task.paused',
  'task.resumed',
  'task.result_submitted',
  'task.succeeded',
  'task.failed',
  'task.cancelled',
  'task.timed_out',
  'task.budget_exceeded',
  'approval.requested',
  'approval.decided',
  'recovery.started',
  'recovery.resumed',
  'recovery.reconnected',
  'recovery.failed',
  'progress.reported',
  'usage.updated',
  'budget.rejected',
]);
const SAFE_EVENT_DATA_KEYS = new Set([
  'status',
  'errorCode',
  'reasonCode',
  'approvalId',
  'toolName',
  'callId',
  'length',
  'durationMs',
  'checkpointRevision',
  'usage',
  'outcomeUnknown',
]);
const SAFE_USAGE_KEYS = new Set(['turns', 'providerCalls', 'inputTokens', 'outputTokens', 'cost']);

function cloneSafeEventData(data: SafeEventData): Readonly<SafeEventData> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Safe event data must be a plain object.');
  }
  for (const key of Object.keys(data)) {
    if (!SAFE_EVENT_DATA_KEYS.has(key)) {
      throw new TypeError(`Unsafe task event data field: ${key}.`);
    }
  }
  assertJsonValue(data);
  if (data.usage !== undefined) {
    for (const key of Object.keys(data.usage)) {
      if (!SAFE_USAGE_KEYS.has(key)) throw new TypeError(`Unsafe usage field: ${key}.`);
    }
  }
  return freezeJson(parseJsonValue(canonicalizeJson(data))) as Readonly<SafeEventData>;
}

export interface AppendSafeTaskEventsOptions {
  readonly eventIds: readonly string[];
  /** Used only when an event omits its timestamp. */
  readonly defaultTimestamp: number;
  /** Preserve an already-incremented revision when events join the same CAS candidate. */
  readonly revisionMode?: 'increment' | 'preserve';
  readonly traceId?: string;
  readonly spanId?: string;
}

export interface AppendSafeTaskEventsOutcome {
  readonly task: Readonly<StoredTask>;
  readonly events: readonly Readonly<SubAgentTaskEvent>[];
}

/** Build a gap-free, task-local event sequence from already-whitelisted inputs. */
export function appendSafeTaskEvents(
  task: StoredTask,
  inputs: readonly ExecutorEventInput[],
  options: AppendSafeTaskEventsOptions,
): Readonly<AppendSafeTaskEventsOutcome> {
  assertFiniteTimestamp(options.defaultTimestamp, 'Default event timestamp');
  if (inputs.length !== options.eventIds.length) {
    throw new RangeError('Each task event requires exactly one supplied event ID.');
  }
  if (inputs.length === 0) {
    return Object.freeze({ task, events: Object.freeze([]) });
  }
  if (task.eventSequence + inputs.length > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Task event sequence cannot be incremented safely.');
  }

  const uniqueEventIds = new Set<string>();
  const events = inputs.map((input, index) => {
    if (!SAFE_EVENT_TYPES.has(input.type))
      throw new TypeError(`Unsafe task event type: ${input.type}.`);
    const eventId = options.eventIds[index];
    assertNonEmptyId(eventId, 'Task event ID');
    if (uniqueEventIds.has(eventId))
      throw new TypeError('Task event IDs must be unique in a batch.');
    uniqueEventIds.add(eventId);
    const timestamp = input.timestamp ?? options.defaultTimestamp;
    assertFiniteTimestamp(timestamp, 'Task event timestamp');
    return Object.freeze({
      eventId,
      sequence: task.eventSequence + index + 1,
      type: input.type,
      sessionId: task.ownerSessionId,
      runId: task.runId,
      taskId: task.taskId,
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      path: Object.freeze([...task.path]),
      definition: Object.freeze({ ...task.definition }),
      executor: task.executor,
      attempt: task.attempt,
      timestamp,
      ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
      ...(options.spanId === undefined ? {} : { spanId: options.spanId }),
      data: cloneSafeEventData(input.data),
    });
  });
  const latestTimestamp = Math.max(task.updatedAt, ...events.map(({ timestamp }) => timestamp));
  const draft = mutableTaskCopy(task);
  draft.eventSequence = task.eventSequence + events.length;
  draft.revision =
    options.revisionMode === 'preserve' ? task.revision : nextRevision(task.revision);
  draft.updatedAt = latestTimestamp;
  return Object.freeze({
    task: Object.freeze(draft) as unknown as Readonly<StoredTask>,
    events: Object.freeze(events),
  });
}

export interface SubAgentTaskCasCandidate {
  readonly expectedRevision: number;
  readonly fencingToken: string;
  readonly task: StoredTask;
}

export type SubAgentTaskCasRejectionReason =
  | 'revision_mismatch'
  | 'fencing_mismatch'
  | 'identity_mismatch'
  | 'invalid_revision'
  | 'invalid_transition';

export interface SubAgentTaskCasRejection {
  readonly index: number;
  readonly reason: SubAgentTaskCasRejectionReason;
}

export type FirstValidSubAgentTaskCasOutcome =
  | {
      readonly status: 'won';
      readonly winnerIndex: number;
      readonly task: Readonly<StoredTask>;
      readonly rejected: readonly Readonly<SubAgentTaskCasRejection>[];
    }
  | {
      readonly status: 'none';
      readonly task: Readonly<StoredTask>;
      readonly rejected: readonly Readonly<SubAgentTaskCasRejection>[];
    };

/**
 * Deterministically select the first candidate that could win one revision/fencing CAS.
 * There is intentionally no state priority: list order models arrival order.
 */
export function selectFirstValidSubAgentTaskCasCandidate(
  current: StoredTask,
  candidates: readonly SubAgentTaskCasCandidate[],
): Readonly<FirstValidSubAgentTaskCasOutcome> {
  const rejected: SubAgentTaskCasRejection[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] as SubAgentTaskCasCandidate;
    let reason: SubAgentTaskCasRejectionReason | undefined;
    if (candidate.expectedRevision !== current.revision) reason = 'revision_mismatch';
    else if (candidate.fencingToken !== current.fencingToken) reason = 'fencing_mismatch';
    else if (
      candidate.task.taskId !== current.taskId ||
      candidate.task.ownerSessionId !== current.ownerSessionId ||
      candidate.task.runId !== current.runId
    ) {
      reason = 'identity_mismatch';
    } else if (candidate.task.revision !== current.revision + 1) reason = 'invalid_revision';
    else {
      try {
        assertSubAgentTaskTransition(current.state, candidate.task.state);
      } catch {
        reason = 'invalid_transition';
      }
    }

    if (reason === undefined) {
      return Object.freeze({
        status: 'won' as const,
        winnerIndex: index,
        task: candidate.task,
        rejected: Object.freeze(rejected.map((item) => Object.freeze(item))),
      });
    }
    rejected.push({ index, reason });
  }
  return Object.freeze({
    status: 'none' as const,
    task: current,
    rejected: Object.freeze(rejected.map((item) => Object.freeze(item))),
  });
}
