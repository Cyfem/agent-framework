import { randomUUID } from 'node:crypto';
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

export type RuntimeIdKind = 'task' | 'session' | 'event' | 'receipt' | 'approval' | 'batch';

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
      return await store.acquireLease(key, ttlMs);
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

export function raceWithOperationSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal, deadlineAt));

  let cleanup = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal, deadlineAt));
    signal.addEventListener('abort', onAbort, { once: true });
    cleanup = () => signal.removeEventListener('abort', onAbort);
  });
  return Promise.race([operation, aborted]).finally(cleanup);
}
