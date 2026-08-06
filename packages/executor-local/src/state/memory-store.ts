import { randomUUID } from 'node:crypto';

import {
  StateLeaseUnavailableError,
  type AgentRuntimeStateStore,
  type AgentRuntimeStateTransaction,
  type StateLease,
  type StoredAgentRun,
  type StoredTask,
  type SubAgentTaskEvent,
} from '@ruixutong.manee/maneeagent-framework';

import {
  assertEventCursor,
  assertSessionLeaseScope,
  assertTtl,
  createSessionState,
  createStateTransaction,
  findIdempotentTask,
  findSubagentSessionTask,
  insertRun,
  listTasksByRun,
  readRun,
  readTask,
  readTaskEvents,
  type SessionState,
} from './state-domain';

interface MemoryLeaseState {
  fencingToken: bigint;
  expiresAt: number;
  owner: symbol;
  released: boolean;
}

export interface MemoryAgentRuntimeStateStoreOptions {
  readonly transactionDomainId?: string;
  readonly now?: () => number;
}

class MemoryStateLease implements StateLease {
  constructor(
    readonly key: string,
    readonly fencingToken: string,
    readonly expiresAt: number,
    readonly owner: symbol,
    readonly store: MemoryAgentRuntimeStateStore,
  ) {}

  renew(ttlMs: number): Promise<StateLease> {
    return this.store.renewLease(this, ttlMs);
  }

  release(): Promise<void> {
    return this.store.releaseLease(this);
  }
}

/** Production in-process StateStore. Its durability and leases end with the current process. */
export class MemoryAgentRuntimeStateStore implements AgentRuntimeStateStore {
  readonly transactionDomainId: string;
  readonly #now: () => number;
  readonly #sessions = new Map<string, SessionState>();
  readonly #leases = new Map<string, MemoryLeaseState>();
  readonly #transactionTails = new Map<string, Promise<void>>();

  constructor(options: MemoryAgentRuntimeStateStoreOptions = {}) {
    this.transactionDomainId = options.transactionDomainId ?? `maneeagent-memory:${randomUUID()}`;
    this.#now = options.now ?? Date.now;
  }

  async createRun(record: StoredAgentRun): Promise<void> {
    await this.#serialize(record.ownerSessionId, async () => {
      insertRun(this.#getOrCreateSession(record.ownerSessionId), record);
    });
  }

  async loadRun(ownerSessionId: string, runId: string): Promise<StoredAgentRun | undefined> {
    return readRun(this.#getSession(ownerSessionId), runId);
  }

  async loadTask(ownerSessionId: string, taskId: string): Promise<StoredTask | undefined> {
    return readTask(this.#getSession(ownerSessionId), taskId);
  }

  async listTasksByRun(ownerSessionId: string, runId: string): Promise<readonly StoredTask[]> {
    return listTasksByRun(this.#getSession(ownerSessionId), runId);
  }

  async findTaskByIdempotencyKey(
    ownerSessionId: string,
    runId: string,
    requestId: string,
  ): Promise<StoredTask | undefined> {
    return findIdempotentTask(this.#getSession(ownerSessionId), runId, requestId);
  }

  async findTaskBySubAgentSession(
    ownerSessionId: string,
    subagentSessionId: string,
  ): Promise<StoredTask | undefined> {
    return findSubagentSessionTask(this.#getSession(ownerSessionId), subagentSessionId);
  }

  async transaction<T>(
    ownerSessionId: string,
    lease: StateLease,
    work: (transaction: AgentRuntimeStateTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#serialize(ownerSessionId, async () => {
      const ownedLease = this.#assertLease(lease);
      assertSessionLeaseScope(ownerSessionId, ownedLease.key);
      this.#assertActiveLease(ownedLease);
      const staged = createSessionState(this.#getSession(ownerSessionId));
      let active = true;
      const transaction = createStateTransaction({
        ownerSessionId,
        lease,
        staged,
        assertLease: () => {
          this.#assertActiveLease(ownedLease);
        },
        isActive: () => active,
      });
      try {
        const result = await work(transaction);
        this.#assertActiveLease(ownedLease);
        this.#sessions.set(ownerSessionId, staged);
        return result;
      } finally {
        active = false;
      }
    });
  }

  async readEvents(
    ownerSessionId: string,
    taskId: string,
    afterSequence = 0,
  ): Promise<readonly SubAgentTaskEvent[]> {
    assertEventCursor(afterSequence);
    return readTaskEvents(this.#getSession(ownerSessionId), taskId, afterSequence);
  }

  async acquireLease(key: string, ttlMs: number): Promise<StateLease> {
    assertTtl(ttlMs);
    if (key.length === 0) throw new TypeError('Lease key must be non-empty.');
    const now = this.#readNow();
    const current = this.#leases.get(key);
    if (current !== undefined && !current.released && now < current.expiresAt) {
      throw new StateLeaseUnavailableError(key);
    }
    const fencingToken = (current?.fencingToken ?? 0n) + 1n;
    const owner = Symbol(key);
    const state: MemoryLeaseState = {
      fencingToken,
      expiresAt: now + ttlMs,
      owner,
      released: false,
    };
    this.#leases.set(key, state);
    return new MemoryStateLease(key, fencingToken.toString(10), state.expiresAt, owner, this);
  }

  async renewLease(lease: MemoryStateLease, ttlMs: number): Promise<StateLease> {
    assertTtl(ttlMs);
    const state = this.#assertActiveLease(lease);
    state.expiresAt = this.#readNow() + ttlMs;
    return new MemoryStateLease(lease.key, lease.fencingToken, state.expiresAt, lease.owner, this);
  }

  async releaseLease(lease: MemoryStateLease): Promise<void> {
    const state = this.#leases.get(lease.key);
    if (
      state !== undefined &&
      state.owner === lease.owner &&
      state.fencingToken.toString(10) === lease.fencingToken
    ) {
      state.released = true;
    }
  }

  #getSession(ownerSessionId: string): SessionState {
    return this.#sessions.get(ownerSessionId) ?? createSessionState();
  }

  #getOrCreateSession(ownerSessionId: string): SessionState {
    let state = this.#sessions.get(ownerSessionId);
    if (state === undefined) {
      state = createSessionState();
      this.#sessions.set(ownerSessionId, state);
    }
    return state;
  }

  async #serialize<T>(ownerSessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#transactionTails.get(ownerSessionId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.#transactionTails.set(ownerSessionId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#transactionTails.get(ownerSessionId) === tail) {
        this.#transactionTails.delete(ownerSessionId);
      }
    }
  }

  #assertLease(lease: StateLease): MemoryStateLease {
    if (!(lease instanceof MemoryStateLease) || lease.store !== this) {
      throw new Error('Lease was not issued by this Memory StateStore.');
    }
    return lease;
  }

  #assertActiveLease(lease: MemoryStateLease): MemoryLeaseState {
    const state = this.#leases.get(lease.key);
    if (
      state === undefined ||
      state.owner !== lease.owner ||
      state.released ||
      state.fencingToken.toString(10) !== lease.fencingToken ||
      this.#readNow() >= state.expiresAt
    ) {
      throw new Error(`Lease ${lease.key} is expired or fenced.`);
    }
    return state;
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('StateStore clock must return a non-negative safe integer.');
    }
    return now;
  }
}
