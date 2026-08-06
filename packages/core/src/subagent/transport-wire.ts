import type { SubAgentErrorDescriptor } from './errors';
import type { SubAgentTaskSnapshot } from './identity';
import type { JsonValue } from './json';
import type {
  SubAgentExecutionOutcome,
  SubAgentExecutorOperationResult,
  SubAgentExecutorRecoveryRequired,
  SubAgentFailureInput,
  SubAgentTaskResult,
} from './result';

/** Error fields safe to serialize across a placement boundary. Event cursors remain host-local. */
export type SubAgentTransportSafeError = Omit<SubAgentErrorDescriptor, 'eventCursor'> & {
  readonly eventCursor?: never;
};

/** Deep transport-safe counterpart of an authoritative child failure request. */
export type SubAgentTransportFailureInput<O extends JsonValue = JsonValue> = Omit<
  SubAgentFailureInput<O>,
  'error'
> & {
  readonly error: SubAgentTransportSafeError;
};

type SuccessfulTaskResult<O extends JsonValue> = Extract<
  SubAgentTaskResult<O>,
  { readonly status: 'succeeded' }
>;
type FailedTaskResult<O extends JsonValue> = Extract<
  SubAgentTaskResult<O>,
  { readonly status: 'failed' | 'cancelled' | 'timed_out' | 'budget_exceeded' }
>;

/** Deep transport-safe task result. */
export type SubAgentTransportTaskResult<O extends JsonValue = JsonValue> =
  | SuccessfulTaskResult<O>
  | (Omit<FailedTaskResult<O>, 'error'> & {
      readonly error: SubAgentTransportSafeError;
    });

/** Deep transport-safe host outcome. */
export type SubAgentTransportExecutionOutcome<O extends JsonValue = JsonValue> =
  | {
      readonly type: 'terminal';
      readonly result: SubAgentTransportTaskResult<O>;
    }
  | Extract<SubAgentExecutionOutcome<O>, { readonly type: 'paused' }>;

/** Deep transport-safe raw Executor settle result. */
export type SubAgentTransportExecutorOperationResult<O extends JsonValue = JsonValue> =
  | SubAgentTransportExecutionOutcome<O>
  | SubAgentExecutorRecoveryRequired;

/** Deep transport-safe host task snapshot. */
export type SubAgentTransportTaskSnapshot = Omit<SubAgentTaskSnapshot, 'error'> & {
  readonly error?: SubAgentTransportSafeError;
};

/** Closed projection used before any Core error descriptor crosses a placement boundary. */
export function projectSubAgentTransportSafeError(
  error: SubAgentErrorDescriptor,
): Readonly<SubAgentTransportSafeError> {
  return Object.freeze({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.causeCode === undefined ? {} : { causeCode: error.causeCode }),
    ...(error.outcomeUnknown === undefined ? {} : { outcomeUnknown: error.outcomeUnknown }),
  });
}

/** Removes host-local error fields from a failure request without changing its authoritative data. */
export function projectSubAgentTransportFailureInput<O extends JsonValue>(
  failure: SubAgentFailureInput<O>,
): Readonly<SubAgentTransportFailureInput<O>> {
  return Object.freeze({
    status: failure.status,
    error: projectSubAgentTransportSafeError(failure.error),
    ...(failure.partialOutput === undefined ? {} : { partialOutput: failure.partialOutput }),
  });
}

/** Removes host-local error fields from a task result. */
export function projectSubAgentTransportTaskResult<O extends JsonValue>(
  result: SubAgentTaskResult<O>,
): Readonly<SubAgentTransportTaskResult<O>> {
  if (result.status === 'succeeded') {
    return Object.freeze({
      status: result.status,
      task: result.task,
      executor: result.executor,
      output: result.output,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    });
  }
  return Object.freeze({
    status: result.status,
    task: result.task,
    executor: result.executor,
    error: projectSubAgentTransportSafeError(result.error),
    ...(result.partialOutput === undefined ? {} : { partialOutput: result.partialOutput }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  });
}

/** Removes host-local error fields from one reconciled execution outcome. */
export function projectSubAgentTransportExecutionOutcome<O extends JsonValue>(
  outcome: SubAgentExecutionOutcome<O>,
): Readonly<SubAgentTransportExecutionOutcome<O>> {
  if (outcome.type === 'terminal') {
    return Object.freeze({
      type: 'terminal',
      result: projectSubAgentTransportTaskResult(outcome.result),
    });
  }
  return Object.freeze({
    type: 'paused',
    reason: 'approval',
    task: outcome.task,
    approvals: outcome.approvals,
    checkpointRevision: outcome.checkpointRevision,
  });
}

/** Removes host-local error fields from a raw Executor settle result. */
export function projectSubAgentTransportExecutorOperationResult<O extends JsonValue>(
  outcome: SubAgentExecutorOperationResult<O>,
): Readonly<SubAgentTransportExecutorOperationResult<O>> {
  if (outcome.type === 'recovery_required') {
    return Object.freeze({
      type: 'recovery_required',
      reason: outcome.reason,
      operationId: outcome.operationId,
      causeCode: outcome.causeCode,
    });
  }
  return projectSubAgentTransportExecutionOutcome(outcome);
}

/** Removes host-local error fields from a session-guarded task snapshot. */
export function projectSubAgentTransportTaskSnapshot(
  snapshot: SubAgentTaskSnapshot,
): Readonly<SubAgentTransportTaskSnapshot> {
  return Object.freeze({
    taskId: snapshot.taskId,
    subAgent: snapshot.subAgent,
    ownerSessionId: snapshot.ownerSessionId,
    runId: snapshot.runId,
    subagentSessionId: snapshot.subagentSessionId,
    ...(snapshot.parentTaskId === undefined ? {} : { parentTaskId: snapshot.parentTaskId }),
    path: snapshot.path,
    executor: snapshot.executor,
    state: snapshot.state,
    revision: snapshot.revision,
    attempt: snapshot.attempt,
    ...(snapshot.retryOf === undefined ? {} : { retryOf: snapshot.retryOf }),
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    ...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
    ...(snapshot.completedAt === undefined ? {} : { completedAt: snapshot.completedAt }),
    recoveryRequired: snapshot.recoveryRequired,
    ...(snapshot.outcomeUnknown === undefined ? {} : { outcomeUnknown: snapshot.outcomeUnknown }),
    ...(snapshot.usage === undefined ? {} : { usage: snapshot.usage }),
    ...(snapshot.error === undefined
      ? {}
      : { error: projectSubAgentTransportSafeError(snapshot.error) }),
  });
}
