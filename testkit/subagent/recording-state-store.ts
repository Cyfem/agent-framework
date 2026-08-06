import {
  isTerminalSubAgentTaskState,
  StateLeaseUnavailableError,
  SubAgentRuntimeError,
  type AgentRuntimeStateStore,
  type AgentRuntimeStateTransaction,
  type CreateStoredTaskResult,
  type StateLease,
  type StoredAgentRun,
  type StoredTask,
  type SubAgentTaskEvent,
} from '../../packages/core/src';

interface SessionState {
  readonly runs: Map<string, StoredAgentRun>;
  readonly tasks: Map<string, StoredTask>;
  readonly idempotency: Map<string, string>;
  readonly subagentSessions: Map<string, string>;
  readonly events: Map<string, SubAgentTaskEvent[]>;
}

interface LeaseState {
  fencingToken: bigint;
  expiresAt: number;
  owner: symbol;
  released: boolean;
}

export interface RecordingStateStoreOptions {
  readonly transactionDomainId?: string;
  readonly now?: () => number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createSessionState(source?: SessionState): SessionState {
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
    current.definition.version === next.definition.version;
  if (!same) throw new Error('A task CAS cannot change immutable task identity.');
}

class RecordingStateLease implements StateLease {
  constructor(
    readonly key: string,
    readonly fencingToken: string,
    readonly expiresAt: number,
    readonly owner: symbol,
    readonly store: RecordingRuntimeStateStore,
  ) {}

  renew(ttlMs: number): Promise<StateLease> {
    return this.store.renewLease(this, ttlMs);
  }

  release(): Promise<void> {
    return this.store.releaseLease(this);
  }
}

/**
 * Private deterministic StateStore used by Core conformance tests.
 *
 * It exposes only production SPI mutations; tests may inspect immutable digests but cannot mutate
 * internal maps. It is not exported by the npm package.
 */
export class RecordingRuntimeStateStore implements AgentRuntimeStateStore {
  readonly transactionDomainId: string;
  readonly #now: () => number;
  readonly #sessions = new Map<string, SessionState>();
  readonly #leases = new Map<string, LeaseState>();
  readonly #transactionTails = new Map<string, Promise<void>>();

  constructor(options: RecordingStateStoreOptions = {}) {
    this.transactionDomainId = options.transactionDomainId ?? 'recording-state-store';
    this.#now = options.now ?? Date.now;
  }

  async createRun(record: StoredAgentRun): Promise<void> {
    const state = this.#getOrCreateSession(record.ownerSessionId);
    if (state.runs.has(record.runId)) {
      throw new Error(`Run ${record.runId} already exists.`);
    }
    state.runs.set(record.runId, clone(record));
  }

  async loadRun(ownerSessionId: string, runId: string): Promise<StoredAgentRun | undefined> {
    const value = this.#sessions.get(ownerSessionId)?.runs.get(runId);
    return value ? clone(value) : undefined;
  }

  async loadTask(ownerSessionId: string, taskId: string): Promise<StoredTask | undefined> {
    const value = this.#sessions.get(ownerSessionId)?.tasks.get(taskId);
    return value ? clone(value) : undefined;
  }

  async listTasksByRun(ownerSessionId: string, runId: string): Promise<readonly StoredTask[]> {
    const tasks = [...(this.#sessions.get(ownerSessionId)?.tasks.values() ?? [])]
      .filter((task) => task.runId === runId)
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.taskId.localeCompare(right.taskId)
          : left.createdAt - right.createdAt,
      );
    return Object.freeze(clone(tasks));
  }

  async findTaskByIdempotencyKey(
    ownerSessionId: string,
    runId: string,
    requestId: string,
  ): Promise<StoredTask | undefined> {
    const state = this.#sessions.get(ownerSessionId);
    const taskId = state?.idempotency.get(idempotencyIndexKey(runId, requestId));
    const task = taskId ? state?.tasks.get(taskId) : undefined;
    return task ? clone(task) : undefined;
  }

  async findTaskBySubAgentSession(
    ownerSessionId: string,
    subagentSessionId: string,
  ): Promise<StoredTask | undefined> {
    const state = this.#sessions.get(ownerSessionId);
    const taskId = state?.subagentSessions.get(subagentSessionId);
    const task = taskId ? state?.tasks.get(taskId) : undefined;
    return task ? clone(task) : undefined;
  }

  async transaction<T>(
    ownerSessionId: string,
    lease: StateLease,
    work: (transaction: AgentRuntimeStateTransaction) => Promise<T>,
  ): Promise<T> {
    const ownedLease = this.#assertLease(lease);
    const previous = this.#transactionTails.get(ownerSessionId) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const tail = previous.then(() => turn);
    this.#transactionTails.set(ownerSessionId, tail);
    await previous;

    try {
      this.#assertActiveLease(ownedLease);
      const staged = createSessionState(this.#sessions.get(ownerSessionId));
      const transaction = this.#createTransaction(ownerSessionId, ownedLease, staged);
      const result = await work(transaction);
      this.#assertActiveLease(ownedLease);
      this.#sessions.set(ownerSessionId, staged);
      return result;
    } finally {
      releaseTurn();
      if (this.#transactionTails.get(ownerSessionId) === tail) {
        this.#transactionTails.delete(ownerSessionId);
      }
    }
  }

  async readEvents(
    ownerSessionId: string,
    taskId: string,
    afterSequence = 0,
  ): Promise<readonly SubAgentTaskEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError('afterSequence must be a non-negative safe integer.');
    }
    const events = this.#sessions.get(ownerSessionId)?.events.get(taskId) ?? [];
    return clone(events.filter((event) => event.sequence > afterSequence));
  }

  async acquireLease(key: string, ttlMs: number): Promise<StateLease> {
    this.#assertTtl(ttlMs);
    const now = this.#now();
    const current = this.#leases.get(key);
    if (current && !current.released && now < current.expiresAt) {
      throw new StateLeaseUnavailableError(key);
    }

    const fencingToken = (current?.fencingToken ?? 0n) + 1n;
    const owner = Symbol(key);
    const state: LeaseState = {
      fencingToken,
      expiresAt: now + ttlMs,
      owner,
      released: false,
    };
    this.#leases.set(key, state);
    return new RecordingStateLease(key, fencingToken.toString(10), state.expiresAt, owner, this);
  }

  async renewLease(lease: RecordingStateLease, ttlMs: number): Promise<StateLease> {
    this.#assertTtl(ttlMs);
    const state = this.#assertActiveLease(lease);
    state.expiresAt = this.#now() + ttlMs;
    return new RecordingStateLease(
      lease.key,
      lease.fencingToken,
      state.expiresAt,
      lease.owner,
      this,
    );
  }

  async releaseLease(lease: RecordingStateLease): Promise<void> {
    const state = this.#leases.get(lease.key);
    if (
      !state ||
      state.owner !== lease.owner ||
      state.fencingToken.toString(10) !== lease.fencingToken
    ) {
      return;
    }
    state.released = true;
  }

  /** Immutable white-box snapshot for assertions only. */
  snapshot(ownerSessionId: string): Readonly<{
    runs: readonly StoredAgentRun[];
    tasks: readonly StoredTask[];
    events: readonly SubAgentTaskEvent[];
  }> {
    const state = this.#sessions.get(ownerSessionId);
    return Object.freeze({
      runs: Object.freeze(clone([...(state?.runs.values() ?? [])])),
      tasks: Object.freeze(clone([...(state?.tasks.values() ?? [])])),
      events: Object.freeze(clone([...(state?.events.values() ?? [])].flat())),
    });
  }

  #createTransaction(
    ownerSessionId: string,
    lease: RecordingStateLease,
    staged: SessionState,
  ): AgentRuntimeStateTransaction {
    return {
      loadRun: async (runId) => {
        const value = staged.runs.get(runId);
        return value ? clone(value) : undefined;
      },
      loadTask: async (taskId) => {
        const value = staged.tasks.get(taskId);
        return value ? clone(value) : undefined;
      },
      listTasksByRun: async (runId) =>
        Object.freeze(
          clone(
            [...staged.tasks.values()]
              .filter((task) => task.runId === runId)
              .sort((left, right) =>
                left.createdAt === right.createdAt
                  ? left.taskId.localeCompare(right.taskId)
                  : left.createdAt - right.createdAt,
              ),
          ),
        ),
      findTaskByIdempotencyKey: async (runId, requestId) => {
        const taskId = staged.idempotency.get(idempotencyIndexKey(runId, requestId));
        const task = taskId ? staged.tasks.get(taskId) : undefined;
        return task ? clone(task) : undefined;
      },
      findTaskBySubAgentSession: async (subagentSessionId) => {
        const taskId = staged.subagentSessions.get(subagentSessionId);
        const task = taskId ? staged.tasks.get(taskId) : undefined;
        return task ? clone(task) : undefined;
      },
      createTask: async (record): Promise<CreateStoredTaskResult> => {
        if (record.ownerSessionId !== ownerSessionId) {
          throw new Error('A transaction cannot create a task for another owner session.');
        }
        const indexKey = idempotencyIndexKey(record.runId, record.requestId);
        const existingId = staged.idempotency.get(indexKey);
        const existing = existingId ? staged.tasks.get(existingId) : undefined;
        if (existing) {
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
        this.#assertActiveLease(lease);
        if (fencingToken !== lease.fencingToken) return false;
        const current = staged.tasks.get(taskId);
        if (!current || current.revision !== expectedRevision) return false;
        assertTaskIdentity(current, next);
        if (next.revision !== current.revision + 1 || next.fencingToken !== fencingToken) {
          throw new Error('Task CAS must increment revision once and persist the active fence.');
        }
        if (isTerminalSubAgentTaskState(current.state) && next.state !== current.state) {
          throw new Error('A terminal task state is irreversible.');
        }
        staged.tasks.set(taskId, clone(next));
        return true;
      },
      compareAndSetRun: async (runId, expectedRevision, fencingToken, next) => {
        this.#assertActiveLease(lease);
        if (fencingToken !== lease.fencingToken) return false;
        const current = staged.runs.get(runId);
        if (!current || current.revision !== expectedRevision) return false;
        if (
          current.ownerSessionId !== next.ownerSessionId ||
          current.runId !== next.runId ||
          next.revision !== current.revision + 1 ||
          next.fencingToken !== fencingToken
        ) {
          throw new Error('Run CAS cannot change identity and must increment the revision once.');
        }
        staged.runs.set(runId, clone(next));
        return true;
      },
      appendEvents: async (taskId, events) => {
        const task = staged.tasks.get(taskId);
        if (!task) throw new Error(`Cannot append events for unknown task ${taskId}.`);
        const current = staged.events.get(taskId) ?? [];
        let expectedSequence = (current.at(-1)?.sequence ?? 0) + 1;
        const eventIds = new Set(current.map(({ eventId }) => eventId));
        for (const event of events) {
          if (
            event.sessionId !== ownerSessionId ||
            event.runId !== task.runId ||
            event.taskId !== taskId ||
            event.sequence !== expectedSequence ||
            eventIds.has(event.eventId)
          ) {
            throw new Error(
              'Task events must have matching identity, unique IDs and contiguous sequence.',
            );
          }
          eventIds.add(event.eventId);
          expectedSequence += 1;
        }
        if (events.length > 0 && task.eventSequence !== expectedSequence - 1) {
          throw new Error('Task eventSequence must be committed with its event batch.');
        }
        staged.events.set(taskId, [...current, ...clone(events)]);
      },
    };
  }

  #getOrCreateSession(ownerSessionId: string): SessionState {
    let state = this.#sessions.get(ownerSessionId);
    if (!state) {
      state = createSessionState();
      this.#sessions.set(ownerSessionId, state);
    }
    return state;
  }

  #assertLease(lease: StateLease): RecordingStateLease {
    if (!(lease instanceof RecordingStateLease) || lease.store !== this) {
      throw new Error('Lease was not issued by this StateStore.');
    }
    return lease;
  }

  #assertActiveLease(lease: RecordingStateLease): LeaseState {
    const state = this.#leases.get(lease.key);
    if (
      !state ||
      state.owner !== lease.owner ||
      state.released ||
      state.fencingToken.toString(10) !== lease.fencingToken ||
      this.#now() >= state.expiresAt
    ) {
      throw new Error(`Lease ${lease.key} is expired or fenced.`);
    }
    return state;
  }

  #assertTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new RangeError('Lease ttlMs must be a positive safe integer.');
    }
  }
}
