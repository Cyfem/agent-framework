import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { assertArtifactReference } from './artifact';
import type { SubAgentContextItem } from './definition';
import {
  createResourceNotFoundError,
  SubAgentRuntimeError,
  type SubAgentErrorCode,
  type SubAgentErrorDescriptor,
} from './errors';
import {
  assertJsonValue,
  canonicalizeJson,
  measureCanonicalJsonBytes,
  parseJsonValue,
  type JsonValue,
} from './json';
import { DEFAULT_SUBAGENT_PROJECTION_LIMITS, type SubAgentProjectionLimits } from './limits';
import type { SubAgentExecutionOutcome, SubAgentTaskResult } from './result';
import {
  StateLeaseUnavailableError,
  type AgentRuntimeStateStore,
  type StateLease,
  type StoredTask,
} from './state-store';

export const DEFAULT_RUNTIME_LEASE_TTL_MS = 30_000;
export const DEFAULT_RUNTIME_LEASE_RETRY_MS = 25;
export const DEFAULT_RUNTIME_EVENT_POLL_MS = 25;

export interface RenewingRuntimeLease {
  readonly lease: StateLease;
  /** Host-monotonic boundary for the latest successfully confirmed acquire/renew request. */
  readonly confirmedUntil: number;
  readonly signal: AbortSignal;
  stop(): Promise<void>;
}

export interface RuntimeLeaseScheduler {
  readonly set: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clear: (timer: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_RUNTIME_LEASE_SCHEDULER: RuntimeLeaseScheduler = Object.freeze({
  set: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
});

const DEFAULT_RUNTIME_LEASE_CLOCK = (): number => performance.now();
const MAX_RUNTIME_TIMER_DELAY_MS = 2_147_483_647;

export type RuntimeIdKind =
  | 'task'
  | 'session'
  | 'event'
  | 'receipt'
  | 'approval'
  | 'batch'
  | 'operation'
  | 'epoch';

export function createRuntimeId(kind: RuntimeIdKind): string {
  return `${kind}-${randomUUID()}`;
}

export function createSubAgentError(
  code: SubAgentErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly causeCode?: string;
    readonly outcomeUnknown?: boolean;
  } = {},
): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.causeCode === undefined ? {} : { causeCode: options.causeCode }),
    ...(options.outcomeUnknown === undefined ? {} : { outcomeUnknown: options.outcomeUnknown }),
  });
}

export function cloneJsonValue(value: JsonValue): JsonValue {
  return parseJsonValue(canonicalizeJson(value));
}

export function assertRuntimeReady(ready: boolean): void {
  if (!ready) {
    throw new Error('SubAgentRuntime has not completed init().');
  }
}

export function assertRuntimeSession(actual: string, expected: string): void {
  if (actual !== expected) throw createResourceNotFoundError();
}

export function createOperationSignal(options: {
  readonly signal?: AbortSignal;
  readonly deadlineAt: number;
  readonly now?: () => number;
  readonly controller?: AbortController;
}): AbortSignal {
  const now = options.now ?? Date.now;
  const remaining = options.deadlineAt - now();
  if (!Number.isFinite(options.deadlineAt) || remaining <= 0) {
    const expired = new AbortController();
    expired.abort(createSubAgentError('TIMED_OUT', 'The subagent operation timed out.'));
    return expired.signal;
  }

  const signals: AbortSignal[] = [AbortSignal.timeout(Math.ceil(remaining))];
  if (options.signal !== undefined) signals.push(options.signal);
  if (options.controller !== undefined) signals.push(options.controller.signal);
  return signals.length === 1 ? (signals[0] as AbortSignal) : AbortSignal.any(signals);
}

export function abortError(
  signal: AbortSignal,
  deadlineAt: number,
  now = Date.now,
): SubAgentRuntimeError {
  const reason = signal.reason;
  if (reason instanceof SubAgentRuntimeError) return reason;
  return now() >= deadlineAt
    ? createSubAgentError('TIMED_OUT', 'The subagent operation timed out.')
    : createSubAgentError('CANCELLED', 'The subagent operation was cancelled.');
}

export function throwIfOperationAborted(
  signal: AbortSignal,
  deadlineAt: number,
  now = Date.now,
): void {
  if (signal.aborted || now() >= deadlineAt) throw abortError(signal, deadlineAt, now);
}

export async function waitForRuntimeRetry(
  signal: AbortSignal,
  deadlineAt: number,
  milliseconds = DEFAULT_RUNTIME_LEASE_RETRY_MS,
): Promise<void> {
  throwIfOperationAborted(signal, deadlineAt);
  try {
    await delay(milliseconds, undefined, { signal });
  } catch {
    throw abortError(signal, deadlineAt);
  }
  throwIfOperationAborted(signal, deadlineAt);
}

export async function acquireRuntimeLease(
  store: AgentRuntimeStateStore,
  key: string,
  signal: AbortSignal,
  deadlineAt: number,
  ttlMs = DEFAULT_RUNTIME_LEASE_TTL_MS,
): Promise<StateLease> {
  for (;;) {
    throwIfOperationAborted(signal, deadlineAt);
    try {
      return await acquireLeaseWithinOperation(store, key, ttlMs, signal, deadlineAt);
    } catch (error) {
      if (!(error instanceof StateLeaseUnavailableError)) throw error;
      await waitForRuntimeRetry(signal, deadlineAt);
    }
  }
}

export async function withRuntimeLease<T>(
  store: AgentRuntimeStateStore,
  ownerSessionId: string,
  signal: AbortSignal,
  deadlineAt: number,
  work: (lease: StateLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireRuntimeLease(
    store,
    `subagent-session:${ownerSessionId}`,
    signal,
    deadlineAt,
  );
  try {
    return await work(lease);
  } finally {
    await lease.release();
  }
}

/**
 * Acquire one task execution lease and keep its fencing token fixed for the whole epoch. Renewal
 * failure aborts the operation before another owner can legally publish control-plane mutations.
 */
export async function acquireRenewingRuntimeLease(
  store: AgentRuntimeStateStore,
  key: string,
  parentSignal: AbortSignal,
  deadlineAt: number,
  ttlMs = DEFAULT_RUNTIME_LEASE_TTL_MS,
  scheduler: RuntimeLeaseScheduler = DEFAULT_RUNTIME_LEASE_SCHEDULER,
  monotonicNow: () => number = DEFAULT_RUNTIME_LEASE_CLOCK,
): Promise<RenewingRuntimeLease> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 30) {
    throw new RangeError('Execution lease TTL must be a safe integer of at least 30ms.');
  }
  const acquired = await acquireRuntimeLeaseWithProofStart(
    store,
    key,
    parentSignal,
    deadlineAt,
    ttlMs,
    monotonicNow,
  );
  let current = acquired.lease;
  const fixedFencingToken = current.fencingToken;
  let confirmedUntil = leaseProofDeadline(acquired.proofStartedAt, ttlMs);
  let renewAt = leaseRenewalDeadline(acquired.proofStartedAt, ttlMs);
  const lost = new AbortController();
  const signal = AbortSignal.any([parentSignal, lost.signal]);
  let stopped = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const readMonotonicNow = (): number => {
    const value = monotonicNow();
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(
        'Execution lease monotonic clock must return a non-negative finite value.',
      );
    }
    return value;
  };

  const clearRenewalTimer = (): void => {
    if (renewalTimer === undefined) return;
    scheduler.clear(renewalTimer);
    renewalTimer = undefined;
  };

  const clearExpiryTimer = (): void => {
    if (expiryTimer === undefined) return;
    scheduler.clear(expiryTimer);
    expiryTimer = undefined;
  };

  const abortLost = (): void => {
    if (lost.signal.aborted) return;
    clearRenewalTimer();
    clearExpiryTimer();
    lost.abort(
      createSubAgentError('RECOVERY_TARGET_LOST', 'The subagent execution lease was lost.', {
        retryable: true,
        causeCode: 'EXECUTION_LEASE_LOST',
      }),
    );
  };

  const scheduleExpiryBarrier = (): void => {
    clearExpiryTimer();
    const schedule = (): void => {
      if (stopped || signal.aborted) return;
      const remaining = confirmedUntil - readMonotonicNow();
      if (remaining <= 0) {
        abortLost();
        return;
      }
      expiryTimer = scheduler.set(
        () => {
          expiryTimer = undefined;
          schedule();
        },
        Math.min(MAX_RUNTIME_TIMER_DELAY_MS, Math.ceil(remaining)),
      );
    };
    schedule();
  };

  const scheduleRenewal = (): void => {
    if (stopped || signal.aborted) return;
    const remaining = renewAt - readMonotonicNow();
    renewalTimer = scheduler.set(
      () => {
        renewalTimer = undefined;
        if (readMonotonicNow() < renewAt) {
          scheduleRenewal();
          return;
        }
        void renew();
      },
      Math.min(MAX_RUNTIME_TIMER_DELAY_MS, Math.max(0, Math.ceil(remaining))),
    );
  };

  const renew = async (): Promise<void> => {
    if (stopped || signal.aborted) return;
    const proofStartedAt = readMonotonicNow();
    if (proofStartedAt >= confirmedUntil) {
      abortLost();
      return;
    }
    const previousConfirmedUntil = confirmedUntil;
    const candidateConfirmedUntil = leaseProofDeadline(proofStartedAt, ttlMs);
    const candidateRenewAt = leaseRenewalDeadline(proofStartedAt, ttlMs);
    scheduleExpiryBarrier();
    try {
      const renewed = await current.renew(ttlMs);
      if (renewed.key !== key || renewed.fencingToken !== fixedFencingToken) {
        try {
          await renewed.release();
        } catch {
          // The adapter already violated the renewal contract; cleanup remains best-effort.
        }
        throw new Error('Execution lease renewal changed its key or fencing token.');
      }
      if (stopped || signal.aborted) return;
      const confirmedAt = readMonotonicNow();
      if (confirmedAt >= previousConfirmedUntil || confirmedAt >= candidateConfirmedUntil) {
        abortLost();
        return;
      }
      current = renewed;
      confirmedUntil = candidateConfirmedUntil;
      renewAt = candidateRenewAt;
      clearExpiryTimer();
      scheduleRenewal();
    } catch {
      abortLost();
    }
  };

  if (readMonotonicNow() >= confirmedUntil) abortLost();
  else scheduleRenewal();

  return Object.freeze({
    get lease(): StateLease {
      return current;
    },
    get confirmedUntil(): number {
      return confirmedUntil;
    },
    signal,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearRenewalTimer();
      clearExpiryTimer();
      try {
        await current.release();
      } catch {
        // A lost lease is already fenced. Cleanup cannot restore ownership.
      }
    },
  });
}

async function acquireRuntimeLeaseWithProofStart(
  store: AgentRuntimeStateStore,
  key: string,
  signal: AbortSignal,
  deadlineAt: number,
  ttlMs: number,
  monotonicNow: () => number,
): Promise<{ readonly lease: StateLease; readonly proofStartedAt: number }> {
  for (;;) {
    throwIfOperationAborted(signal, deadlineAt);
    const proofStartedAt = monotonicNow();
    if (!Number.isFinite(proofStartedAt) || proofStartedAt < 0) {
      throw new TypeError(
        'Execution lease monotonic clock must return a non-negative finite value.',
      );
    }
    try {
      const lease = await acquireLeaseWithinOperation(store, key, ttlMs, signal, deadlineAt);
      return Object.freeze({ lease, proofStartedAt });
    } catch (error) {
      if (!(error instanceof StateLeaseUnavailableError)) throw error;
      await waitForRuntimeRetry(signal, deadlineAt);
    }
  }
}

async function acquireLeaseWithinOperation(
  store: AgentRuntimeStateStore,
  key: string,
  ttlMs: number,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<StateLease> {
  const pending = Promise.resolve().then(() => store.acquireLease(key, ttlMs));
  try {
    return await raceWithOperationSignal(pending, signal, deadlineAt);
  } catch (error) {
    // A StateStore may not support cancelling an in-flight acquire. If it grants the lease after
    // the caller has already stopped waiting, release that late success so it cannot strand the
    // key until TTL expiry. The rejection branch also observes a late Store failure.
    void pending.then(
      async (lease) => {
        try {
          await lease.release();
        } catch {
          // Best-effort cleanup cannot change the already-returned cancellation/deadline result.
        }
      },
      () => undefined,
    );
    throw error;
  }
}

function leaseProofDeadline(proofStartedAt: number, ttlMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, proofStartedAt + ttlMs);
}

function leaseRenewalDeadline(proofStartedAt: number, ttlMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, proofStartedAt + Math.max(10, Math.floor(ttlMs / 3)));
}

export function normalizeProjectedContext(
  candidate: readonly SubAgentContextItem[],
  limits: SubAgentProjectionLimits = DEFAULT_SUBAGENT_PROJECTION_LIMITS,
): readonly SubAgentContextItem[] {
  if (!Array.isArray(candidate)) {
    throw createSubAgentError(
      'CONTEXT_PROJECTION_FAILED',
      'The subagent context projector must return an array.',
    );
  }
  if (candidate.length > limits.maxItems) {
    throw createSubAgentError(
      'CONTEXT_PROJECTION_FAILED',
      'The projected subagent context contains too many items.',
    );
  }

  let totalBytes = 0;
  const normalized = candidate.map((item, index) => {
    try {
      assertJsonValue(item);
    } catch {
      throw createSubAgentError(
        'CONTEXT_PROJECTION_FAILED',
        `Projected context item ${index} is not JSON-safe.`,
      );
    }

    const contextItem = item as unknown as SubAgentContextItem;

    if (contextItem.kind === 'artifact') {
      try {
        assertArtifactReference(contextItem.artifact);
      } catch {
        throw createSubAgentError(
          'CONTEXT_PROJECTION_FAILED',
          `Projected artifact item ${index} is invalid.`,
        );
      }
    } else if (typeof contextItem.name !== 'string' || contextItem.name.trim().length === 0) {
      throw createSubAgentError(
        'CONTEXT_PROJECTION_FAILED',
        `Projected context item ${index} requires a non-empty name.`,
      );
    }

    const bytes = measureCanonicalJsonBytes(contextItem as JsonValue);
    if (bytes > limits.maxItemBytes) {
      throw createSubAgentError(
        'CONTEXT_PROJECTION_FAILED',
        `Projected context item ${index} exceeds the item byte limit.`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw createSubAgentError(
        'CONTEXT_PROJECTION_FAILED',
        'The projected subagent context exceeds the total byte limit.',
      );
    }
    return cloneJsonValue(contextItem as JsonValue) as unknown as SubAgentContextItem;
  });

  return Object.freeze(normalized);
}

export function taskResult(task: StoredTask): SubAgentTaskResult | undefined {
  return task.result;
}

export function taskOutcome(task: StoredTask): SubAgentExecutionOutcome | undefined {
  if (task.result !== undefined) return { type: 'terminal', result: task.result };
  if (task.state === 'waiting_approval') {
    return {
      type: 'paused',
      reason: 'approval',
      task: { taskId: task.taskId, subAgent: { ...task.definition } },
      approvals: task.approvals,
      checkpointRevision: task.revision,
    };
  }
  return undefined;
}

export function safeExecutorError(error: unknown): Readonly<SubAgentErrorDescriptor> {
  if (error instanceof SubAgentRuntimeError) {
    if (error.descriptor.outcomeUnknown === true) {
      return Object.freeze({
        code: 'EXECUTOR_FAILED' as const,
        message: 'The provider outcome could not be confirmed.',
        retryable: false,
        outcomeUnknown: true,
        ...(error.descriptor.causeCode === undefined
          ? {}
          : { causeCode: error.descriptor.causeCode }),
      });
    }
    return error.descriptor;
  }
  return Object.freeze({
    code: 'EXECUTOR_FAILED' as const,
    message: 'The subagent executor failed.',
    retryable: false,
  });
}

/**
 * A task execution ownership loss is control-plane fencing, not an Executor task failure.
 * The stale owner must surface the loss without publishing a terminal through a session lease.
 */
export function isExecutionOwnershipLossError(error: unknown): error is SubAgentRuntimeError {
  if (!(error instanceof SubAgentRuntimeError) || error.code !== 'RECOVERY_TARGET_LOST') {
    return false;
  }
  return (
    error.descriptor.causeCode === 'EXECUTION_LEASE_LOST' ||
    error.descriptor.causeCode === 'EXECUTION_OWNERSHIP_LOST'
  );
}

/**
 * Verify both the composed operation signal and the host-monotonic lease proof. A renewal that is
 * still pending at the proof boundary is not ownership proof, so the old owner must stop.
 */
export function assertExecutionLeaseOwnership(
  lease: RenewingRuntimeLease,
  signal: AbortSignal,
  deadlineAt: number,
  monotonicNow: () => number = DEFAULT_RUNTIME_LEASE_CLOCK,
): void {
  throwIfOperationAborted(signal, deadlineAt);
  if (monotonicNow() < lease.confirmedUntil) return;
  throw createSubAgentError('RECOVERY_TARGET_LOST', 'The subagent execution lease was lost.', {
    retryable: true,
    causeCode: 'EXECUTION_LEASE_LOST',
  });
}

export function raceWithOperationSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<T> {
  try {
    throwIfOperationAborted(signal, deadlineAt);
  } catch (error) {
    return Promise.reject(error);
  }

  // Executors commonly reject their own work in response to the same signal. If that rejection
  // wins Promise.race by a microtask, preserve the control-plane cancellation/lease-loss reason
  // instead of misclassifying the opaque Executor rejection as EXECUTOR_FAILED.
  const guardedOperation = operation.catch((error: unknown) => {
    if (signal.aborted) throw abortError(signal, deadlineAt);
    throw error;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupAbort = (): void => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    const cleanupTimer = (): void => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    };
    const rejectForInterruption = (): void => {
      cleanupTimer();
      reject(abortError(signal, deadlineAt));
    };
    const onAbort = (): void => rejectForInterruption();
    signal.addEventListener('abort', onAbort, { once: true });
    cleanupAbort = () => signal.removeEventListener('abort', onAbort);

    const scheduleDeadline = (): void => {
      if (!Number.isFinite(deadlineAt)) return;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        rejectForInterruption();
        return;
      }
      timer = setTimeout(
        () => {
          timer = undefined;
          scheduleDeadline();
        },
        Math.min(MAX_RUNTIME_TIMER_DELAY_MS, Math.ceil(remaining)),
      );
    };
    scheduleDeadline();
  });
  return Promise.race([guardedOperation, interrupted]).finally(() => {
    cleanupAbort();
    if (timer !== undefined) clearTimeout(timer);
  });
}
