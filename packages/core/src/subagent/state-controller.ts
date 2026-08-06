import { isDeepStrictEqual } from 'node:util';

import {
  createResourceNotFoundError,
  SubAgentRuntimeError,
  type SubAgentErrorCode,
} from './errors';
import { isTerminalSubAgentTaskState, assertSubAgentTaskTransition } from './state-machine';
import { resolveSubAgentLimits } from './limits';
import type {
  AgentRuntimeStateStore,
  CreateStoredTaskResult,
  StateLease,
  StoredAgentRun,
  StoredAgentRunStatus,
  StoredModelOperationV1,
  StoredTask,
} from './state-store';
import type { SubAgentTaskEvent } from './telemetry';

export const STATE_CAS_CONFLICT_CAUSE_CODE = 'STATE_CAS_CONFLICT';
export const STATE_FENCING_MISMATCH_CAUSE_CODE = 'STATE_FENCING_MISMATCH';

export interface RuntimeRunMutation {
  readonly previous: StoredAgentRun;
  readonly next: StoredAgentRun;
}

export interface RuntimeTaskUpdateMutation {
  readonly previous: StoredTask;
  readonly next: StoredTask;
  readonly events?: readonly SubAgentTaskEvent[];
}

/**
 * A task identity staged outside persistence and created in the same transaction as its parent's
 * pending-call checkpoint. `create` is the clean revision-zero record; `next` is the first queued
 * revision including its durable `task.queued` event.
 */
export interface RuntimeTaskCreateMutation {
  readonly create: StoredTask;
  readonly next: StoredTask;
  readonly events?: readonly SubAgentTaskEvent[];
}

export type RuntimeTaskMutation = RuntimeTaskUpdateMutation | RuntimeTaskCreateMutation;

/**
 * A declarative state transaction. Callers provide records, never a transaction callback, so the
 * only awaited operations inside the persistence transaction are methods on that transaction.
 */
export interface RuntimeStateMutation {
  readonly run?: RuntimeRunMutation;
  readonly tasks?: readonly RuntimeTaskMutation[];
}

export interface CommittedRuntimeStateMutation {
  readonly run?: StoredAgentRun;
  readonly tasks: readonly StoredTask[];
}

const TERMINAL_RUN_STATUSES = new Set<StoredAgentRunStatus>(['succeeded', 'cancelled', 'failed']);

function runtimeError(
  code: SubAgentErrorCode,
  message: string,
  options: { readonly retryable?: boolean; readonly causeCode?: string } = {},
): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.causeCode === undefined ? {} : { causeCode: options.causeCode }),
  });
}

function createCasConflictError(resource: 'run' | 'task'): SubAgentRuntimeError {
  return runtimeError(
    'INVALID_STATE_TRANSITION',
    `The persisted ${resource} changed before the runtime state mutation could commit.`,
    { retryable: true, causeCode: STATE_CAS_CONFLICT_CAUSE_CODE },
  );
}

function assertOwnerSession(actual: string, expected: string): void {
  if (actual !== expected) {
    throw runtimeError(
      'SESSION_MISMATCH',
      'The runtime state mutation does not belong to the active owner session.',
    );
  }
}

function assertRevisionStep(previous: number, next: number, resource: string): void {
  if (
    !Number.isSafeInteger(previous) ||
    previous < 0 ||
    previous === Number.MAX_SAFE_INTEGER ||
    next !== previous + 1
  ) {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      `${resource} revision must advance by exactly one.`,
    );
  }
}

function assertActiveFence(nextFence: string, lease: StateLease, resource: string): void {
  if (nextFence !== lease.fencingToken) {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      `${resource} must persist the active lease fencing token.`,
      { retryable: true, causeCode: STATE_FENCING_MISMATCH_CAUSE_CODE },
    );
  }
}

function assertResolvedLimitsSnapshot(
  limits: StoredAgentRun['limits'] | StoredTask['limits'],
  resource: string,
): void {
  let resolvedLimits: ReturnType<typeof resolveSubAgentLimits>;
  try {
    resolvedLimits = resolveSubAgentLimits(limits);
  } catch {
    throw runtimeError('INVALID_STATE_TRANSITION', `${resource} has invalid limits.`);
  }
  if (!isDeepStrictEqual(resolvedLimits, limits)) {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      `${resource} must persist a complete resolved limits snapshot.`,
    );
  }
}

function assertRunMutation(
  ownerSessionId: string,
  lease: StateLease,
  mutation: RuntimeRunMutation,
): void {
  const { previous, next } = mutation;
  assertOwnerSession(previous.ownerSessionId, ownerSessionId);
  assertOwnerSession(next.ownerSessionId, ownerSessionId);
  if (
    previous.recordVersion !== next.recordVersion ||
    previous.runId !== next.runId ||
    previous.createdAt !== next.createdAt ||
    !isDeepStrictEqual(previous.limits, next.limits)
  ) {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      'A runtime run mutation cannot change immutable run identity.',
    );
  }
  assertResolvedLimitsSnapshot(previous.limits, 'Runtime run');
  assertRevisionStep(previous.revision, next.revision, 'Runtime run');
  assertActiveFence(next.fencingToken, lease, 'Runtime run');
  if (next.updatedAt < previous.updatedAt) {
    throw runtimeError('INVALID_STATE_TRANSITION', 'Runtime run updatedAt cannot move backwards.');
  }
  if (TERMINAL_RUN_STATUSES.has(previous.status)) {
    throw runtimeError('INVALID_STATE_TRANSITION', 'A terminal runtime run is immutable.');
  }
  assertModelOperationTransition(previous.modelOperation, next.modelOperation, next.status);
}

function assertModelOperationTransition(
  previous: StoredModelOperationV1 | undefined,
  next: StoredModelOperationV1 | undefined,
  nextRunStatus: StoredAgentRunStatus,
): void {
  if (isDeepStrictEqual(previous, next)) return;
  const validPhaseStep =
    (previous === undefined && next?.phase === 'prepared') ||
    (previous?.phase === 'prepared' && next?.phase === 'in_flight') ||
    (previous?.phase === 'in_flight' && next?.phase === 'result_ready') ||
    (previous?.phase === 'result_ready' && next === undefined) ||
    // The Model adapter may clear an in-flight operation only after classifying an explicit
    // provider rejection; the AgentRun controller owns that oracle before this generic CAS.
    (previous?.phase === 'in_flight' && next === undefined) ||
    // Any non-success terminalization clears resumable work atomically.
    (previous !== undefined &&
      next === undefined &&
      (nextRunStatus === 'failed' || nextRunStatus === 'cancelled'));
  if (!validPhaseStep) {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      'A Model operation must advance through its durable phases or an explicit terminal/rejection settle.',
    );
  }
  if (
    previous !== undefined &&
    next !== undefined &&
    (previous.version !== next.version ||
      previous.operationId !== next.operationId ||
      previous.iteration !== next.iteration ||
      previous.purpose !== next.purpose ||
      previous.requestHash !== next.requestHash ||
      previous.preparedAt !== next.preparedAt ||
      next.updatedAt < previous.updatedAt)
  ) {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      'A Model operation transition cannot change its durable identity or request hash.',
    );
  }
}

function equalOptional(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function assertTaskImmutableIdentity(previous: StoredTask, next: StoredTask): void {
  const same =
    previous.recordVersion === next.recordVersion &&
    previous.ownerSessionId === next.ownerSessionId &&
    previous.runId === next.runId &&
    previous.taskId === next.taskId &&
    previous.parentTaskId === next.parentTaskId &&
    previous.subagentSessionId === next.subagentSessionId &&
    previous.requestId === next.requestId &&
    previous.idempotencyKey === next.idempotencyKey &&
    previous.definition.name === next.definition.name &&
    previous.definition.version === next.definition.version &&
    previous.executor === next.executor &&
    previous.inputHash === next.inputHash &&
    equalOptional(previous.input, next.input) &&
    equalOptional(previous.projectedContext, next.projectedContext) &&
    equalOptional(previous.limits, next.limits) &&
    equalOptional(previous.path, next.path) &&
    previous.depth === next.depth &&
    previous.retryOf === next.retryOf &&
    previous.createdAt === next.createdAt;
  if (!same) {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      'A runtime task mutation cannot change immutable task identity or dispatch input.',
    );
  }
}

function assertTaskEvents(
  ownerSessionId: string,
  previous: StoredTask,
  next: StoredTask,
  events: readonly SubAgentTaskEvent[],
): void {
  if (next.eventSequence !== previous.eventSequence + events.length) {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      'Task eventSequence must advance by the exact committed event count.',
    );
  }
  const eventIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as SubAgentTaskEvent;
    const identityMatches =
      event.sessionId === ownerSessionId &&
      event.runId === next.runId &&
      event.taskId === next.taskId &&
      event.parentTaskId === next.parentTaskId &&
      event.definition.name === next.definition.name &&
      event.definition.version === next.definition.version &&
      event.executor === next.executor &&
      event.attempt === next.attempt &&
      equalOptional(event.path, next.path);
    if (!identityMatches) {
      throw runtimeError(
        'INVALID_STATE_TRANSITION',
        'A task event does not match the task mutation identity.',
      );
    }
    if (event.sequence !== previous.eventSequence + index + 1) {
      throw runtimeError(
        'INVALID_STATE_TRANSITION',
        'Task events must use a contiguous task-local sequence.',
      );
    }
    if (eventIds.has(event.eventId)) {
      throw runtimeError(
        'INVALID_STATE_TRANSITION',
        'Task event IDs must be unique within a mutation.',
      );
    }
    eventIds.add(event.eventId);
  }
}

function assertTaskMutation(
  ownerSessionId: string,
  lease: StateLease,
  mutation: RuntimeTaskUpdateMutation,
): void {
  const { previous, next } = mutation;
  const events = mutation.events ?? [];
  assertOwnerSession(previous.ownerSessionId, ownerSessionId);
  assertOwnerSession(next.ownerSessionId, ownerSessionId);
  assertTaskImmutableIdentity(previous, next);
  assertRevisionStep(previous.revision, next.revision, 'Runtime task');
  assertActiveFence(next.fencingToken, lease, 'Runtime task');
  if (next.updatedAt < previous.updatedAt) {
    throw runtimeError('INVALID_STATE_TRANSITION', 'Runtime task updatedAt cannot move backwards.');
  }
  if (isTerminalSubAgentTaskState(previous.state)) {
    throw runtimeError('INVALID_STATE_TRANSITION', 'A terminal runtime task is immutable.');
  }
  if (previous.state !== next.state) {
    assertSubAgentTaskTransition(previous.state, next.state);
  }
  assertTaskEvents(ownerSessionId, previous, next, events);
}

function assertTaskCreateMutation(
  ownerSessionId: string,
  lease: StateLease,
  mutation: RuntimeTaskCreateMutation,
): void {
  const { create, next } = mutation;
  const events = mutation.events ?? [];
  assertInitialTaskRecord(ownerSessionId, lease, create);
  assertOwnerSession(next.ownerSessionId, ownerSessionId);
  assertTaskImmutableIdentity(create, next);
  assertRevisionStep(create.revision, next.revision, 'New runtime task');
  assertActiveFence(next.fencingToken, lease, 'New runtime task');
  if (next.updatedAt < create.updatedAt) {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      'New runtime task updatedAt cannot move backwards.',
    );
  }
  if (create.state !== next.state) assertSubAgentTaskTransition(create.state, next.state);
  assertTaskEvents(ownerSessionId, create, next, events);
}

function isTaskCreateMutation(
  mutation: RuntimeTaskMutation,
): mutation is RuntimeTaskCreateMutation {
  return 'create' in mutation;
}

function assertMutationPlan(
  ownerSessionId: string,
  lease: StateLease,
  mutation: RuntimeStateMutation,
): readonly RuntimeTaskMutation[] {
  if (ownerSessionId.length === 0) {
    throw new TypeError('ownerSessionId must be a non-empty string.');
  }
  const tasks = mutation.tasks ?? [];
  if (mutation.run === undefined && tasks.length === 0) {
    throw new TypeError('A runtime state mutation must contain a run or task mutation.');
  }
  if (mutation.run !== undefined) assertRunMutation(ownerSessionId, lease, mutation.run);

  const taskIds = new Set<string>();
  let runId = mutation.run?.next.runId;
  let createdTaskCount = 0;
  for (const task of tasks) {
    if (isTaskCreateMutation(task)) {
      assertTaskCreateMutation(ownerSessionId, lease, task);
      createdTaskCount += 1;
    } else assertTaskMutation(ownerSessionId, lease, task);
    if (taskIds.has(task.next.taskId)) {
      throw new TypeError('A runtime state mutation cannot update the same task twice.');
    }
    taskIds.add(task.next.taskId);
    runId ??= task.next.runId;
    if (task.next.runId !== runId) {
      throw runtimeError(
        'INVALID_STATE_TRANSITION',
        'One runtime state mutation cannot span multiple root runs.',
      );
    }
    if (
      mutation.run !== undefined &&
      !isDeepStrictEqual(task.next.limits, mutation.run.next.limits)
    ) {
      throw runtimeError(
        'CHECKPOINT_VERSION_MISMATCH',
        'A runtime task and its root run must share the same resolved limits snapshot.',
      );
    }
  }
  if (createdTaskCount > 0) {
    const runMutation = mutation.run;
    if (runMutation === undefined) {
      throw runtimeError(
        'INVALID_STATE_TRANSITION',
        'A staged task create must commit with its root run checkpoint and budget.',
      );
    }
    if (
      runMutation.next.budget.descendantsCreated !==
        runMutation.previous.budget.descendantsCreated + createdTaskCount ||
      runMutation.next.budget.activeExecutions !== runMutation.previous.budget.activeExecutions
    ) {
      throw runtimeError(
        'INVALID_STATE_TRANSITION',
        'A staged task create must reserve exactly one descendant and no execution slot.',
      );
    }
    for (const task of tasks) {
      if (
        isTaskCreateMutation(task) &&
        runMutation.next.budget.descendantsCreated > task.next.limits.maxDescendants
      ) {
        throw runtimeError('LIMIT_EXCEEDED', 'The staged task exceeds maxDescendants.');
      }
    }
  }
  return tasks;
}

/**
 * Atomically commit a root checkpoint, child task updates and their events. The internal
 * transaction callback is closed over declarative data and only awaits transaction-local Store
 * methods; Model, Tool, Executor, projector and network work cannot be injected into it.
 */
export async function commitRuntimeStateMutation(
  stateStore: AgentRuntimeStateStore,
  ownerSessionId: string,
  lease: StateLease,
  mutation: RuntimeStateMutation,
): Promise<Readonly<CommittedRuntimeStateMutation>> {
  const tasks = assertMutationPlan(ownerSessionId, lease, mutation);

  await stateStore.transaction(ownerSessionId, lease, async (transaction) => {
    if (mutation.run !== undefined) {
      const { previous, next } = mutation.run;
      const current = await transaction.loadRun(previous.runId);
      if (current === undefined) throw createResourceNotFoundError();
      if (!isDeepStrictEqual(current, previous)) throw createCasConflictError('run');
      const committed = await transaction.compareAndSetRun(
        previous.runId,
        previous.revision,
        lease.fencingToken,
        next,
      );
      if (!committed) throw createCasConflictError('run');
    }

    for (const task of tasks) {
      const previous = isTaskCreateMutation(task) ? task.create : task.previous;
      const { next } = task;
      if (isTaskCreateMutation(task)) {
        const existing = await transaction.findTaskByIdempotencyKey(
          task.create.runId,
          task.create.requestId,
        );
        if (existing !== undefined) throw createCasConflictError('task');
        const created = await transaction.createTask(task.create);
        if (created.status !== 'created' || !isDeepStrictEqual(created.task, task.create)) {
          throw createCasConflictError('task');
        }
      } else {
        const current = await transaction.loadTask(previous.taskId);
        if (current === undefined) throw createResourceNotFoundError();
        if (!isDeepStrictEqual(current, previous)) throw createCasConflictError('task');
      }
      const committed = await transaction.compareAndSetTask(
        previous.taskId,
        previous.revision,
        lease.fencingToken,
        next,
      );
      if (!committed) throw createCasConflictError('task');
      if ((task.events?.length ?? 0) > 0) {
        await transaction.appendEvents(previous.taskId, task.events ?? []);
      }
    }
  });

  return Object.freeze({
    ...(mutation.run === undefined ? {} : { run: mutation.run.next }),
    tasks: Object.freeze(tasks.map(({ next }) => next)),
  });
}

function sameIdempotentCreate(left: StoredTask, right: StoredTask): boolean {
  return (
    left.ownerSessionId === right.ownerSessionId &&
    left.runId === right.runId &&
    left.requestId === right.requestId &&
    left.definition.name === right.definition.name &&
    left.definition.version === right.definition.version &&
    left.executor === right.executor &&
    left.inputHash === right.inputHash
  );
}

function assertInitialTaskRecord(
  ownerSessionId: string,
  lease: StateLease,
  record: StoredTask,
): void {
  assertOwnerSession(record.ownerSessionId, ownerSessionId);
  assertActiveFence(record.fencingToken, lease, 'New runtime task');
  assertResolvedLimitsSnapshot(record.limits, 'A new runtime task');
  const hasIllegalInitialState =
    record.binding !== undefined ||
    record.resultReceipt !== undefined ||
    record.completionReceipt !== undefined ||
    record.result !== undefined ||
    record.output !== undefined ||
    record.partialOutput !== undefined ||
    record.error !== undefined ||
    record.usage !== undefined ||
    record.approvals.length > 0 ||
    record.approvalDecisions.length > 0 ||
    record.controlOperations.length > 0 ||
    record.executionEpoch !== undefined ||
    record.executionFencingToken !== undefined ||
    record.executorOperation !== undefined ||
    record.childCheckpoint !== undefined ||
    record.delegationPause !== undefined ||
    record.attempt !== 1 ||
    record.terminalAt !== undefined ||
    record.activeStartedAt !== undefined ||
    record.recoveryRequired;
  if (
    record.revision !== 0 ||
    record.state !== 'queued' ||
    record.eventSequence !== 0 ||
    hasIllegalInitialState
  ) {
    throw runtimeError(
      'INVALID_STATE_TRANSITION',
      'A newly persisted task must be a clean queued record at revision and event sequence zero.',
    );
  }
}

/**
 * Final transaction-local create gate for an already constructed task record. C4 Router performs
 * an earlier lookup before catalog/projector/limit work, then calls this helper to close the race.
 */
export async function createStoredTaskIdempotently(
  stateStore: AgentRuntimeStateStore,
  ownerSessionId: string,
  lease: StateLease,
  record: StoredTask,
): Promise<CreateStoredTaskResult> {
  assertInitialTaskRecord(ownerSessionId, lease, record);
  return stateStore.transaction(ownerSessionId, lease, async (transaction) => {
    const existing = await transaction.findTaskByIdempotencyKey(record.runId, record.requestId);
    if (existing !== undefined) {
      if (!sameIdempotentCreate(existing, record)) {
        throw runtimeError(
          'IDEMPOTENCY_CONFLICT',
          'The idempotency key is already bound to a different task request.',
        );
      }
      return { status: 'existing', task: existing };
    }
    return transaction.createTask(record);
  });
}
