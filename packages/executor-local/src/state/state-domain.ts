import { isDeepStrictEqual } from 'node:util';

import {
  SubAgentRuntimeError,
  isTerminalSubAgentTaskState,
  type AgentRuntimeStateTransaction,
  type CreateStoredTaskResult,
  type StateLease,
  type StoredAgentRun,
  type StoredTask,
  type SubAgentTaskEvent,
} from '@ruixutong.manee/maneeagent-framework';

export interface SessionState {
  readonly runs: Map<string, StoredAgentRun>;
  readonly tasks: Map<string, StoredTask>;
  readonly idempotency: Map<string, string>;
  readonly subagentSessions: Map<string, string>;
  readonly events: Map<string, SubAgentTaskEvent[]>;
}

export interface SerializedSessionState {
  readonly schema: 'maneeagent-local-state/v1';
  readonly runs: readonly (readonly [string, StoredAgentRun])[];
  readonly tasks: readonly (readonly [string, StoredTask])[];
  readonly idempotency: readonly (readonly [string, string])[];
  readonly subagentSessions: readonly (readonly [string, string])[];
  readonly events: readonly (readonly [string, readonly SubAgentTaskEvent[]])[];
}

export function createSessionState(source?: SessionState): SessionState {
  return {
    runs: new Map([...(source?.runs ?? [])].map(([key, value]) => [key, clone(value)] as const)),
    tasks: new Map([...(source?.tasks ?? [])].map(([key, value]) => [key, clone(value)] as const)),
    idempotency: new Map(source?.idempotency ?? []),
    subagentSessions: new Map(source?.subagentSessions ?? []),
    events: new Map(
      [...(source?.events ?? [])].map(([key, value]) => [key, clone(value)] as const),
    ),
  };
}

export function serializeSessionState(state: SessionState): SerializedSessionState {
  return {
    schema: 'maneeagent-local-state/v1',
    runs: [...state.runs].map(([key, value]) => [key, clone(value)] as const),
    tasks: [...state.tasks].map(([key, value]) => [key, clone(value)] as const),
    idempotency: [...state.idempotency],
    subagentSessions: [...state.subagentSessions],
    events: [...state.events].map(([key, value]) => [key, clone(value)] as const),
  };
}

export function deserializeSessionState(value: SerializedSessionState): SessionState {
  if (value.schema !== 'maneeagent-local-state/v1') {
    throw new Error('Unsupported local StateStore record version.');
  }
  assertPairs(value.runs, 'runs');
  assertPairs(value.tasks, 'tasks');
  assertPairs(value.idempotency, 'idempotency');
  assertPairs(value.subagentSessions, 'subagentSessions');
  assertPairs(value.events, 'events');
  return {
    runs: new Map(value.runs.map(([key, record]) => [key, clone(record)])),
    tasks: new Map(value.tasks.map(([key, record]) => [key, clone(record)])),
    idempotency: new Map(value.idempotency),
    subagentSessions: new Map(value.subagentSessions),
    events: new Map(value.events.map(([key, events]) => [key, [...clone(events)]])),
  };
}

export function createStateTransaction(options: {
  readonly ownerSessionId: string;
  readonly lease: StateLease;
  readonly staged: SessionState;
  readonly assertLease: () => void | Promise<void>;
  readonly isActive?: () => boolean;
}): AgentRuntimeStateTransaction {
  const { ownerSessionId, lease, staged } = options;
  const assertActive = async (): Promise<void> => {
    if (options.isActive?.() === false) {
      throw new Error('The local StateStore transaction is no longer active.');
    }
    await options.assertLease();
  };

  return {
    loadRun: async (runId) => cloneOptional(staged.runs.get(runId)),
    loadTask: async (taskId) => cloneOptional(staged.tasks.get(taskId)),
    findTaskByIdempotencyKey: async (runId, requestId) => {
      const taskId = staged.idempotency.get(idempotencyIndexKey(runId, requestId));
      return cloneOptional(taskId === undefined ? undefined : staged.tasks.get(taskId));
    },
    findTaskBySubAgentSession: async (subagentSessionId) => {
      const taskId = staged.subagentSessions.get(subagentSessionId);
      return cloneOptional(taskId === undefined ? undefined : staged.tasks.get(taskId));
    },
    createTask: async (record): Promise<CreateStoredTaskResult> => {
      await assertActive();
      if (record.ownerSessionId !== ownerSessionId) {
        throw new Error('A StateStore transaction cannot create a task for another session.');
      }
      if (record.fencingToken !== lease.fencingToken) {
        throw new Error('A StateStore transaction cannot create a task with a stale fence.');
      }
      const indexKey = idempotencyIndexKey(record.runId, record.requestId);
      const existingId = staged.idempotency.get(indexKey);
      const existing = existingId === undefined ? undefined : staged.tasks.get(existingId);
      if (existing !== undefined) {
        if (!sameCreateIdentity(existing, record)) {
          throw new SubAgentRuntimeError({
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'The idempotency key is already bound to a different task request.',
            retryable: false,
          });
        }
        return { status: 'existing', task: clone(existing) };
      }
      if (
        staged.tasks.has(record.taskId) ||
        staged.subagentSessions.has(record.subagentSessionId)
      ) {
        throw new Error('Task or subagent session identity already exists.');
      }
      const stored = clone(record);
      staged.tasks.set(record.taskId, stored);
      staged.idempotency.set(indexKey, record.taskId);
      staged.subagentSessions.set(record.subagentSessionId, record.taskId);
      staged.events.set(record.taskId, []);
      return { status: 'created', task: clone(stored) };
    },
    compareAndSetTask: async (taskId, expectedRevision, fencingToken, next) => {
      await assertActive();
      if (fencingToken !== lease.fencingToken) return false;
      const current = staged.tasks.get(taskId);
      if (current === undefined || current.revision !== expectedRevision) return false;
      assertTaskIdentity(current, next);
      if (next.revision !== current.revision + 1 || next.fencingToken !== fencingToken) {
        throw new Error('Task CAS must increment revision once and persist the active fence.');
      }
      if (isTerminalSubAgentTaskState(current.state) && !isDeepStrictEqual(current, next)) {
        throw new Error('A terminal task is immutable.');
      }
      staged.tasks.set(taskId, clone(next));
      return true;
    },
    compareAndSetRun: async (runId, expectedRevision, fencingToken, next) => {
      await assertActive();
      if (fencingToken !== lease.fencingToken) return false;
      const current = staged.runs.get(runId);
      if (current === undefined || current.revision !== expectedRevision) return false;
      if (
        current.ownerSessionId !== next.ownerSessionId ||
        current.runId !== next.runId ||
        current.recordVersion !== next.recordVersion ||
        current.createdAt !== next.createdAt ||
        next.revision !== current.revision + 1 ||
        next.fencingToken !== fencingToken
      ) {
        throw new Error('Run CAS cannot change identity and must increment revision once.');
      }
      if (['succeeded', 'cancelled', 'failed'].includes(current.status)) {
        throw new Error('A terminal root run is immutable.');
      }
      staged.runs.set(runId, clone(next));
      return true;
    },
    appendEvents: async (taskId, events) => {
      await assertActive();
      const task = staged.tasks.get(taskId);
      if (task === undefined) throw new Error('Cannot append events for an unknown task.');
      const current = staged.events.get(taskId) ?? [];
      let sequence = (current.at(-1)?.sequence ?? 0) + 1;
      const eventIds = new Set(current.map(({ eventId }) => eventId));
      for (const event of events) {
        if (
          event.sessionId !== ownerSessionId ||
          event.runId !== task.runId ||
          event.taskId !== taskId ||
          event.sequence !== sequence ||
          eventIds.has(event.eventId)
        ) {
          throw new Error('Task events must have matching identity and contiguous sequence.');
        }
        eventIds.add(event.eventId);
        sequence += 1;
      }
      if (events.length > 0 && task.eventSequence !== sequence - 1) {
        throw new Error('Task eventSequence must be committed with its event batch.');
      }
      staged.events.set(taskId, [...current, ...clone(events)]);
    },
  };
}

export function insertRun(state: SessionState, record: StoredAgentRun): void {
  if (state.runs.has(record.runId)) {
    throw new Error(`Run ${record.runId} already exists.`);
  }
  state.runs.set(record.runId, clone(record));
}

export function readRun(state: SessionState, runId: string): StoredAgentRun | undefined {
  return cloneOptional(state.runs.get(runId));
}

export function readTask(state: SessionState, taskId: string): StoredTask | undefined {
  return cloneOptional(state.tasks.get(taskId));
}

export function findIdempotentTask(
  state: SessionState,
  runId: string,
  requestId: string,
): StoredTask | undefined {
  const taskId = state.idempotency.get(idempotencyIndexKey(runId, requestId));
  return cloneOptional(taskId === undefined ? undefined : state.tasks.get(taskId));
}

export function findSubagentSessionTask(
  state: SessionState,
  subagentSessionId: string,
): StoredTask | undefined {
  const taskId = state.subagentSessions.get(subagentSessionId);
  return cloneOptional(taskId === undefined ? undefined : state.tasks.get(taskId));
}

export function readTaskEvents(
  state: SessionState,
  taskId: string,
  afterSequence: number,
): readonly SubAgentTaskEvent[] {
  return clone((state.events.get(taskId) ?? []).filter(({ sequence }) => sequence > afterSequence));
}

export function assertEventCursor(afterSequence: number): void {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new RangeError('afterSequence must be a non-negative safe integer.');
  }
}

export function assertTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError('Lease ttlMs must be a positive safe integer.');
  }
}

export function assertSessionLeaseScope(ownerSessionId: string, leaseKey: string): void {
  const sessionLease = `subagent-session:${ownerSessionId}`;
  const taskLeasePrefix = `subagent-task:${ownerSessionId}:`;
  if (leaseKey === sessionLease) return;
  if (leaseKey.startsWith(taskLeasePrefix) && leaseKey.length > taskLeasePrefix.length) return;
  if (matchesAgentRunLease(ownerSessionId, leaseKey)) return;
  throw new Error('StateStore transaction lease scope does not match its owner session.');
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}

function matchesAgentRunLease(ownerSessionId: string, leaseKey: string): boolean {
  const prefix = 'agent-run:';
  if (!leaseKey.startsWith(prefix)) return false;
  try {
    const scope = JSON.parse(leaseKey.slice(prefix.length)) as unknown;
    return (
      Array.isArray(scope) &&
      scope.length === 2 &&
      scope[0] === ownerSessionId &&
      typeof scope[1] === 'string' &&
      scope[1].length > 0 &&
      JSON.stringify(scope) === leaseKey.slice(prefix.length)
    );
  } catch {
    return false;
  }
}

function idempotencyIndexKey(runId: string, requestId: string): string {
  return `${runId}\0${requestId}`;
}

function sameCreateIdentity(left: StoredTask, right: StoredTask): boolean {
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

function assertTaskIdentity(current: StoredTask, next: StoredTask): void {
  const same =
    current.ownerSessionId === next.ownerSessionId &&
    current.runId === next.runId &&
    current.taskId === next.taskId &&
    current.subagentSessionId === next.subagentSessionId &&
    current.requestId === next.requestId &&
    current.definition.name === next.definition.name &&
    current.definition.version === next.definition.version &&
    current.executor === next.executor &&
    current.inputHash === next.inputHash &&
    isDeepStrictEqual(current.input, next.input) &&
    isDeepStrictEqual(current.projectedContext, next.projectedContext) &&
    isDeepStrictEqual(current.path, next.path) &&
    current.parentTaskId === next.parentTaskId &&
    current.retryOf === next.retryOf &&
    current.createdAt === next.createdAt;
  if (!same) throw new Error('A task CAS cannot change immutable task identity.');
}

function assertPairs(
  value: unknown,
  label: string,
): asserts value is readonly (readonly unknown[])[] {
  if (!Array.isArray(value) || value.some((entry) => !Array.isArray(entry) || entry.length !== 2)) {
    throw new Error(`Invalid local StateStore ${label} index.`);
  }
}
