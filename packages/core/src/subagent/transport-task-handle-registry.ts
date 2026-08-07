import type { ExecutorTaskHandle, ExecutorTaskSnapshot, SubAgentExecutorBinding } from './executor';
import { createResourceNotFoundError } from './errors';
import { assertJsonValue, canonicalizeJson, parseJsonValue, type JsonValue } from './json';
import type { SubAgentEventStreamOptions, SubAgentTaskHandle } from './runtime';
import type {
  SubAgentExecutionOutcome,
  SubAgentExecutorOperationResult,
  SubAgentTaskState,
} from './result';
import type { SubAgentTaskEvent } from './telemetry';
import {
  projectSubAgentTransportExecutionOutcome,
  projectSubAgentTransportExecutorOperationResult,
  projectSubAgentTransportTaskSnapshot,
} from './transport-wire';

/** Trusted, process-local lookup scope. Raw handles are never part of a wire or persisted record. */
export interface SubAgentTransportTaskHandleScope {
  readonly ownerSessionId: string;
  /** Parent execution scope for nested Core handles; omitted for raw Executor handles. */
  readonly parentTaskId?: string;
  readonly taskId: string;
}

export type SubAgentTransportTaskHandleResolver<H extends { readonly taskId: string }> = (
  scope: Readonly<SubAgentTransportTaskHandleScope>,
) => H | null | undefined | Promise<H | null | undefined>;

export type SubAgentTransportTaskHandleValidator<H extends { readonly taskId: string }> = (
  handle: H,
  scope: Readonly<SubAgentTransportTaskHandleScope>,
) => boolean;

export interface RememberSubAgentTransportTaskHandleOptions<
  H extends { readonly taskId: string },
> extends SubAgentTransportTaskHandleScope {
  readonly resolver: SubAgentTransportTaskHandleResolver<H>;
  /** Additional trusted identity checks, for example an Executor binding owner and task. */
  readonly validate?: SubAgentTransportTaskHandleValidator<H>;
}

export interface ResolveSubAgentTransportTaskHandleOptions<T> {
  /** Marks the entry terminal after the operation returns a matching result. */
  readonly isTerminal?: (result: T) => boolean;
}

export interface SubAgentTransportTaskHandleEventOptions<T> {
  readonly signal?: AbortSignal;
  /** Marks the entry terminal after the matching event has been observed. */
  readonly isTerminal?: (event: T) => boolean;
}

export interface SubAgentTransportTaskHandleRegistryDiagnostics {
  readonly entries: number;
  readonly resolvedHandles: number;
  readonly pendingResolutions: number;
  readonly activeOperations: number;
  readonly activeSubscribers: number;
}

export interface SubAgentTransportTaskHandleRegistryOptions<H extends { readonly taskId: string }> {
  readonly validate?: SubAgentTransportTaskHandleValidator<H>;
  /** Synchronous cleanup hook for adapter-owned indexes that mirror this registry. */
  readonly onEvict?: (scope: Readonly<SubAgentTransportTaskHandleScope>) => void;
}

interface HandleEntry<H extends { readonly taskId: string }> {
  readonly scope: Readonly<SubAgentTransportTaskHandleScope>;
  readonly resolver: SubAgentTransportTaskHandleResolver<H>;
  readonly validate?: SubAgentTransportTaskHandleValidator<H>;
  handle: H | undefined;
  pending: Promise<H> | undefined;
  activeOperations: number;
  activeSubscribers: number;
  evictWhenIdle: boolean;
}

/**
 * Session-scoped, lazy and single-flight registry for transport adapter task handles.
 *
 * The registry never serializes a handle and never exposes one directly. Public callers can only
 * obtain the operation-specific frozen facades below; there is deliberately no generic callback
 * that could return a raw handle, a wrapper around it, or an iterable that yields it. `forget()` and
 * `markTerminal()` defer eviction until every operation, resolver and event subscriber has settled.
 */
export class SubAgentTransportTaskHandleRegistry<H extends { readonly taskId: string }> {
  readonly #entries = new Map<string, Map<string, HandleEntry<H>>>();
  readonly #validate: SubAgentTransportTaskHandleValidator<H> | undefined;
  readonly #onEvict: ((scope: Readonly<SubAgentTransportTaskHandleScope>) => void) | undefined;
  #entryCount = 0;

  constructor(options: SubAgentTransportTaskHandleRegistryOptions<H> = {}) {
    this.#validate = options.validate;
    if (options.onEvict !== undefined && typeof options.onEvict !== 'function') {
      throw new TypeError('Task handle registry onEvict must be a function.');
    }
    this.#onEvict = options.onEvict;
  }

  remember(
    options: RememberSubAgentTransportTaskHandleOptions<H>,
  ): Readonly<SubAgentTransportTaskHandleScope> {
    const scope = freezeScope(options, 'Task handle registration');
    if (typeof options.resolver !== 'function') {
      throw new TypeError('Task handle registration requires a lazy resolver.');
    }
    if (options.validate !== undefined && typeof options.validate !== 'function') {
      throw new TypeError('Task handle registration validate must be a function.');
    }

    let sessionEntries = this.#entries.get(scope.ownerSessionId);
    if (sessionEntries === undefined) {
      sessionEntries = new Map();
      this.#entries.set(scope.ownerSessionId, sessionEntries);
    }
    const key = taskHandleScopeKey(scope);
    const existing = sessionEntries.get(key);
    if (existing !== undefined) return existing.scope;

    sessionEntries.set(key, {
      scope,
      resolver: options.resolver,
      ...(options.validate === undefined ? {} : { validate: options.validate }),
      handle: undefined,
      pending: undefined,
      activeOperations: 0,
      activeSubscribers: 0,
      evictWhenIdle: false,
    });
    this.#entryCount += 1;
    return scope;
  }

  has(scope: SubAgentTransportTaskHandleScope): boolean {
    return this.#lookup(scope) !== undefined;
  }

  /** Register an Executor handle and expose only its closed, owned operation projections. */
  rememberExecutorTaskHandle(
    this: SubAgentTransportTaskHandleRegistry<ExecutorTaskHandle>,
    options: RememberExecutorTaskHandleOptions,
  ): ExecutorTaskHandle {
    const scope = freezeScope(options, 'Executor task handle');
    const binding = cloneExecutorBinding(options.binding);
    if (binding.ownerSessionId !== scope.ownerSessionId || binding.taskId !== scope.taskId) {
      throw new TypeError('Executor task handle binding does not match its registration scope.');
    }
    const registration = {
      ...scope,
      resolver: options.resolver,
      validate: (handle, expectedScope) => executorHandleMatches(handle, expectedScope, binding),
    } satisfies RememberSubAgentTransportTaskHandleOptions<ExecutorTaskHandle>;
    const ensureRegistered = (): void => {
      this.remember(registration);
    };
    ensureRegistered();

    const validate = (handle: ExecutorTaskHandle): void => {
      if (!executorHandleMatches(handle, scope, binding)) throw createResourceNotFoundError();
    };
    return Object.freeze({
      taskId: scope.taskId,
      binding,
      snapshot: () => {
        ensureRegistered();
        return this.#resolveOperation(
          scope,
          async (handle) => {
            validate(handle);
            const snapshot = await handle.snapshot();
            assertExecutorSnapshotScope(snapshot, scope, binding);
            return projectExecutorSnapshot(snapshot, binding);
          },
          { isTerminal: (snapshot) => isTerminalState(snapshot.state) },
        );
      },
      wait: () => {
        ensureRegistered();
        return this.#resolveOperation(
          scope,
          async (handle) => {
            validate(handle);
            const outcome = await handle.wait();
            assertOutcomeTaskScope(outcome, scope.taskId);
            return cloneOwnedJson(
              projectSubAgentTransportExecutorOperationResult(outcome),
              'Executor task outcome',
            ) as unknown as SubAgentExecutorOperationResult;
          },
          { isTerminal: (outcome) => outcome.type === 'terminal' },
        );
      },
      cancel: (reason?: string) => {
        ensureRegistered();
        return this.#resolveOperation(scope, async (handle) => {
          validate(handle);
          await handle.cancel(reason);
        });
      },
      events: (eventOptions: Parameters<ExecutorTaskHandle['events']>[0]) =>
        this.#eventStream(
          scope,
          (handle) => {
            validate(handle);
            return projectEventStream(handle.events(eventOptions));
          },
          {
            ...(eventOptions?.signal === undefined ? {} : { signal: eventOptions.signal }),
            isTerminal: (event) => {
              assertEventScope(event, scope);
              return isTerminalEvent(event);
            },
          },
          ensureRegistered,
        ),
    });
  }

  /** Register a Core host handle and expose only its session-guarded owned facade. */
  rememberSubAgentTaskHandle(
    this: SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>,
    options: RememberSubAgentTaskHandleOptions,
  ): SubAgentTaskHandle {
    const scope = this.remember(options);
    return this.subAgentTaskHandle(scope, { resolver: options.resolver });
  }

  /** Resolve a previously registered Core host handle without exposing the resident raw handle. */
  subAgentTaskHandle(
    this: SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>,
    input: SubAgentTransportTaskHandleScope,
    options: {
      readonly evictTerminal?: boolean;
      /** Optional authoritative reconstruction source retained by a previously returned facade. */
      readonly resolver?: SubAgentTransportTaskHandleResolver<SubAgentTaskHandle>;
    } = {},
  ): SubAgentTaskHandle {
    const scope = freezeScope(input, 'Core task handle');
    const evictTerminal = options.evictTerminal ?? true;
    const ensureRegistered = (): void => {
      if (options.resolver !== undefined) this.remember({ ...scope, resolver: options.resolver });
    };
    return Object.freeze({
      taskId: scope.taskId,
      snapshot: () => {
        ensureRegistered();
        return this.#resolveOperation(
          scope,
          async (handle) => {
            const snapshot = await handle.snapshot();
            assertHostSnapshotScope(snapshot, scope);
            return cloneOwnedJson(
              projectSubAgentTransportTaskSnapshot(snapshot),
              'Core task snapshot',
            ) as unknown as Awaited<ReturnType<SubAgentTaskHandle['snapshot']>>;
          },
          evictTerminal ? { isTerminal: (snapshot) => isTerminalState(snapshot.state) } : {},
        );
      },
      wait: () => {
        ensureRegistered();
        return this.#resolveOperation(
          scope,
          async (handle) => {
            const outcome = await handle.wait();
            assertOutcomeTaskScope(outcome, scope.taskId);
            return cloneOwnedJson(
              projectSubAgentTransportExecutionOutcome(outcome),
              'Core task outcome',
            ) as unknown as SubAgentExecutionOutcome;
          },
          evictTerminal ? { isTerminal: (outcome) => outcome.type === 'terminal' } : {},
        );
      },
      cancel: (reason?: string) => {
        ensureRegistered();
        return this.#resolveOperation(
          scope,
          async (handle) => {
            const snapshot = await handle.cancel(reason);
            assertHostSnapshotScope(snapshot, scope);
            return cloneOwnedJson(
              projectSubAgentTransportTaskSnapshot(snapshot),
              'Core task cancellation snapshot',
            ) as unknown as Awaited<ReturnType<SubAgentTaskHandle['cancel']>>;
          },
          evictTerminal ? { isTerminal: (snapshot) => isTerminalState(snapshot.state) } : {},
        );
      },
      events: (eventOptions?: SubAgentEventStreamOptions) =>
        this.#eventStream(
          scope,
          (handle) => projectEventStream(handle.events(eventOptions)),
          {
            ...(eventOptions?.signal === undefined ? {} : { signal: eventOptions.signal }),
            isTerminal: (event) => {
              assertEventScope(event, scope);
              return evictTerminal && isTerminalEvent(event);
            },
          },
          ensureRegistered,
        ),
    });
  }

  async #resolveOperation<T>(
    scope: SubAgentTransportTaskHandleScope,
    operation: (handle: H) => T | Promise<T>,
    options: ResolveSubAgentTransportTaskHandleOptions<T> = {},
  ): Promise<T> {
    if (typeof operation !== 'function') {
      throw new TypeError('Task handle operation must be a function.');
    }
    const entry = this.#require(scope);
    entry.activeOperations += 1;
    try {
      const handle = await this.#resolveHandle(entry);
      const result = await operation(handle);
      if (options.isTerminal?.(result) === true) entry.evictWhenIdle = true;
      return result;
    } finally {
      entry.activeOperations -= 1;
      this.#evictIfIdle(entry);
    }
  }

  #eventStream<T>(
    scope: SubAgentTransportTaskHandleScope,
    open: (handle: H) => AsyncIterable<T>,
    options: SubAgentTransportTaskHandleEventOptions<T> = {},
    ensureRegistered?: () => void,
  ): AsyncIterable<T> {
    if (typeof open !== 'function') {
      throw new TypeError('Task handle event adapter must be a function.');
    }
    return Object.freeze({
      [Symbol.asyncIterator]: () =>
        this.#createEventIterator(scope, open, options, ensureRegistered),
    });
  }

  /** Schedules process-local state for eviction, immediately when no operation is using it. */
  forget(scope: SubAgentTransportTaskHandleScope): boolean {
    const entry = this.#lookup(scope);
    if (entry === undefined) return false;
    entry.evictWhenIdle = true;
    this.#evictIfIdle(entry);
    return true;
  }

  /** Terminal entries obey the same deferred eviction rule as explicit forget. */
  markTerminal(scope: SubAgentTransportTaskHandleScope): boolean {
    return this.forget(scope);
  }

  diagnostics(): Readonly<SubAgentTransportTaskHandleRegistryDiagnostics> {
    let resolvedHandles = 0;
    let pendingResolutions = 0;
    let activeOperations = 0;
    let activeSubscribers = 0;
    for (const sessionEntries of this.#entries.values()) {
      for (const entry of sessionEntries.values()) {
        if (entry.handle !== undefined) resolvedHandles += 1;
        if (entry.pending !== undefined) pendingResolutions += 1;
        activeOperations += entry.activeOperations;
        activeSubscribers += entry.activeSubscribers;
      }
    }
    return Object.freeze({
      entries: this.#entryCount,
      resolvedHandles,
      pendingResolutions,
      activeOperations,
      activeSubscribers,
    });
  }

  #lookup(scope: SubAgentTransportTaskHandleScope): HandleEntry<H> | undefined {
    if (!isScope(scope)) return undefined;
    return this.#entries.get(scope.ownerSessionId)?.get(taskHandleScopeKey(scope));
  }

  #require(scope: SubAgentTransportTaskHandleScope): HandleEntry<H> {
    const entry = this.#lookup(scope);
    if (entry === undefined) throw createResourceNotFoundError();
    return entry;
  }

  async #resolveHandle(entry: HandleEntry<H>): Promise<H> {
    if (entry.handle !== undefined) {
      this.#assertHandle(entry, entry.handle);
      return entry.handle;
    }
    if (entry.pending !== undefined) return entry.pending;

    const pending = Promise.resolve()
      .then(() => entry.resolver(entry.scope))
      .then((handle) => {
        this.#assertHandle(entry, handle);
        entry.handle = handle;
        return handle;
      });
    entry.pending = pending;
    try {
      return await pending;
    } finally {
      if (entry.pending === pending) entry.pending = undefined;
    }
  }

  #assertHandle(entry: HandleEntry<H>, handle: H | null | undefined): asserts handle is H {
    if (
      handle === null ||
      typeof handle !== 'object' ||
      handle.taskId !== entry.scope.taskId ||
      this.#validate?.(handle, entry.scope) === false ||
      entry.validate?.(handle, entry.scope) === false
    ) {
      if (entry.handle === handle) entry.handle = undefined;
      throw createResourceNotFoundError();
    }
  }

  #evictIfIdle(entry: HandleEntry<H>): void {
    if (
      !entry.evictWhenIdle ||
      entry.pending !== undefined ||
      entry.activeOperations !== 0 ||
      entry.activeSubscribers !== 0
    ) {
      return;
    }
    const sessionEntries = this.#entries.get(entry.scope.ownerSessionId);
    const key = taskHandleScopeKey(entry.scope);
    if (sessionEntries?.get(key) !== entry) return;
    sessionEntries.delete(key);
    if (sessionEntries.size === 0) this.#entries.delete(entry.scope.ownerSessionId);
    entry.handle = undefined;
    this.#entryCount -= 1;
    try {
      this.#onEvict?.(entry.scope);
    } catch {
      // Registry cleanup is authoritative; an adapter mirror cannot resurrect an evicted handle.
    }
  }

  #createEventIterator<T>(
    scope: SubAgentTransportTaskHandleScope,
    open: (handle: H) => AsyncIterable<T>,
    options: SubAgentTransportTaskHandleEventOptions<T>,
    ensureRegistered?: () => void,
  ): AsyncIterator<T, void, undefined> & AsyncIterable<T> {
    let entry: HandleEntry<H> | undefined;
    let source: AsyncIterator<T> | undefined;
    let startPromise: Promise<void> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    let closed = false;
    let subscriberRegistered = false;
    let abortFailure: unknown;
    let onAbort: (() => void) | undefined;

    const releaseSubscriber = (): void => {
      if (!subscriberRegistered || entry === undefined) return;
      subscriberRegistered = false;
      entry.activeSubscribers -= 1;
      this.#evictIfIdle(entry);
    };
    const close = (): Promise<void> => {
      if (cleanupPromise !== undefined) return cleanupPromise;
      closed = true;
      if (onAbort !== undefined && options.signal !== undefined) {
        options.signal.removeEventListener('abort', onAbort);
        onAbort = undefined;
      }
      const activeSource = source;
      source = undefined;
      releaseSubscriber();
      cleanupPromise = Promise.resolve().then(async () => {
        if (activeSource?.return !== undefined) await activeSource.return();
      });
      return cleanupPromise;
    };
    const start = (): Promise<void> => {
      if (startPromise !== undefined) return startPromise;
      startPromise = Promise.resolve().then(async () => {
        if (closed) return;
        ensureRegistered?.();
        entry = this.#require(scope);
        throwIfAborted(options.signal);
        entry.activeSubscribers += 1;
        subscriberRegistered = true;
        if (options.signal !== undefined) {
          onAbort = () => {
            abortFailure = abortReason(options.signal as AbortSignal);
            void close().catch(() => undefined);
          };
          options.signal.addEventListener('abort', onAbort, { once: true });
          if (options.signal.aborted) onAbort();
        }
        try {
          const handle = await waitForAbort(this.#resolveHandle(entry), options.signal);
          if (closed) return;
          const iterable = open(handle);
          if (iterable === null || typeof iterable !== 'object') {
            throw new TypeError('Task handle events must return an AsyncIterable.');
          }
          source = iterable[Symbol.asyncIterator]();
        } catch (error) {
          await close().catch(() => undefined);
          throw error;
        }
      });
      return startPromise;
    };
    const iterator: AsyncIterator<T, void, undefined> & AsyncIterable<T> = Object.freeze({
      next: async (): Promise<IteratorResult<T, void>> => {
        if (closed) {
          if (abortFailure !== undefined) throw abortFailure;
          return { done: true, value: undefined };
        }
        await start();
        if (closed) {
          if (abortFailure !== undefined) throw abortFailure;
          return { done: true, value: undefined };
        }
        const activeSource = source;
        if (activeSource === undefined) {
          await close();
          return { done: true, value: undefined };
        }
        try {
          const step = await waitForAbort(activeSource.next(), options.signal);
          if (step.done === true) {
            await close();
            return { done: true, value: undefined };
          }
          if (options.isTerminal?.(step.value) === true) {
            if (entry !== undefined) entry.evictWhenIdle = true;
            await close();
          }
          return { done: false, value: step.value };
        } catch (error) {
          await close().catch(() => undefined);
          throw error;
        }
      },
      return: async (): Promise<IteratorResult<T, void>> => {
        await close();
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown): Promise<IteratorResult<T, void>> => {
        await close().catch(() => undefined);
        throw error;
      },
      [Symbol.asyncIterator]: () => iterator,
    });
    return iterator;
  }
}

export interface RememberExecutorTaskHandleOptions extends SubAgentTransportTaskHandleScope {
  readonly binding: SubAgentExecutorBinding;
  readonly resolver: SubAgentTransportTaskHandleResolver<ExecutorTaskHandle>;
}

/** Registers a raw Executor handle and returns a frozen, identity-checking lazy facade. */
export function rememberExecutorTaskHandle(
  registry: SubAgentTransportTaskHandleRegistry<ExecutorTaskHandle>,
  options: RememberExecutorTaskHandleOptions,
): ExecutorTaskHandle {
  return registry.rememberExecutorTaskHandle(options);
}

export interface RememberSubAgentTaskHandleOptions extends SubAgentTransportTaskHandleScope {
  readonly resolver: SubAgentTransportTaskHandleResolver<SubAgentTaskHandle>;
}

/** Registers a Core host handle and returns a session-checking facade for reverse control RPC. */
export function rememberSubAgentTaskHandle(
  registry: SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>,
  options: RememberSubAgentTaskHandleOptions,
): SubAgentTaskHandle {
  return registry.rememberSubAgentTaskHandle(options);
}

/** Return the safe facade for a previously registered host handle. */
export function resolveSubAgentTaskHandle(
  registry: SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>,
  scope: SubAgentTransportTaskHandleScope,
): SubAgentTaskHandle {
  return registry.subAgentTaskHandle(scope, { evictTerminal: false });
}

function projectExecutorSnapshot(
  snapshot: ExecutorTaskSnapshot,
  binding: SubAgentExecutorBinding,
): ExecutorTaskSnapshot {
  return cloneOwnedJson(
    {
      taskId: snapshot.taskId,
      state: snapshot.state,
      binding,
      updatedAt: snapshot.updatedAt,
    },
    'Executor task snapshot',
  ) as unknown as ExecutorTaskSnapshot;
}

function projectEventStream(
  source: AsyncIterable<SubAgentTaskEvent>,
): AsyncIterable<SubAgentTaskEvent> {
  if (source === null || typeof source !== 'object') {
    throw new TypeError('Task handle events must return an AsyncIterable.');
  }
  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<SubAgentTaskEvent, void, undefined> &
      AsyncIterable<SubAgentTaskEvent> {
      const iterator = source[Symbol.asyncIterator]();
      const projected: AsyncIterator<SubAgentTaskEvent, void, undefined> &
        AsyncIterable<SubAgentTaskEvent> = Object.freeze({
        next: async () => {
          const step = await iterator.next();
          return step.done === true
            ? { done: true as const, value: undefined }
            : { done: false as const, value: projectTaskEvent(step.value) };
        },
        return: async () => {
          await iterator.return?.();
          return { done: true as const, value: undefined };
        },
        throw: async (error?: unknown) => {
          if (iterator.throw !== undefined) await iterator.throw(error);
          else await iterator.return?.();
          throw error;
        },
        [Symbol.asyncIterator]: () => projected,
      });
      return projected;
    },
  });
}

function projectTaskEvent(event: SubAgentTaskEvent): SubAgentTaskEvent {
  const data = event.data;
  return cloneOwnedJson(
    {
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      sessionId: event.sessionId,
      runId: event.runId,
      taskId: event.taskId,
      ...(event.parentTaskId === undefined ? {} : { parentTaskId: event.parentTaskId }),
      path: event.path,
      definition: { name: event.definition.name, version: event.definition.version },
      executor: event.executor,
      attempt: event.attempt,
      timestamp: event.timestamp,
      ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
      ...(event.spanId === undefined ? {} : { spanId: event.spanId }),
      data: {
        ...(data.status === undefined ? {} : { status: data.status }),
        ...(data.errorCode === undefined ? {} : { errorCode: data.errorCode }),
        ...(data.reasonCode === undefined ? {} : { reasonCode: data.reasonCode }),
        ...(data.approvalId === undefined ? {} : { approvalId: data.approvalId }),
        ...(data.toolName === undefined ? {} : { toolName: data.toolName }),
        ...(data.callId === undefined ? {} : { callId: data.callId }),
        ...(data.length === undefined ? {} : { length: data.length }),
        ...(data.durationMs === undefined ? {} : { durationMs: data.durationMs }),
        ...(data.checkpointRevision === undefined
          ? {}
          : { checkpointRevision: data.checkpointRevision }),
        ...(data.usage === undefined
          ? {}
          : {
              usage: {
                turns: data.usage.turns,
                providerCalls: data.usage.providerCalls,
                ...(data.usage.inputTokens === undefined
                  ? {}
                  : { inputTokens: data.usage.inputTokens }),
                ...(data.usage.outputTokens === undefined
                  ? {}
                  : { outputTokens: data.usage.outputTokens }),
                ...(data.usage.cost === undefined ? {} : { cost: data.usage.cost }),
              },
            }),
        ...(data.outcomeUnknown === undefined ? {} : { outcomeUnknown: data.outcomeUnknown }),
      },
    },
    'Task handle event',
  ) as unknown as SubAgentTaskEvent;
}

function cloneOwnedJson(value: unknown, label: string): JsonValue {
  assertJsonValue(value, { label });
  const cloned = parseJsonValue(canonicalizeJson(value as JsonValue));
  deepFreezeJson(cloned);
  return cloned;
}

function executorHandleMatches(
  handle: ExecutorTaskHandle,
  scope: SubAgentTransportTaskHandleScope,
  binding: SubAgentExecutorBinding,
): boolean {
  return (
    handle.taskId === scope.taskId &&
    handle.binding?.taskId === scope.taskId &&
    handle.binding.ownerSessionId === scope.ownerSessionId &&
    executorBindingsEqual(handle.binding, binding)
  );
}

function executorBindingsEqual(
  left: SubAgentExecutorBinding,
  right: SubAgentExecutorBinding,
): boolean {
  return (
    left.version === right.version &&
    left.executorName === right.executorName &&
    left.ownerSessionId === right.ownerSessionId &&
    left.taskId === right.taskId &&
    left.subagentSessionId === right.subagentSessionId &&
    left.definitionName === right.definitionName &&
    left.definitionVersion === right.definitionVersion &&
    left.runnerId === right.runnerId &&
    left.runnerVersion === right.runnerVersion &&
    left.adapterStateVersion === right.adapterStateVersion &&
    canonicalizeJson((left.modelBinding ?? null) as JsonValue) ===
      canonicalizeJson((right.modelBinding ?? null) as JsonValue) &&
    canonicalizeJson(left.recoveryData) === canonicalizeJson(right.recoveryData)
  );
}

function assertExecutorSnapshotScope(
  snapshot: ExecutorTaskSnapshot,
  scope: SubAgentTransportTaskHandleScope,
  binding: SubAgentExecutorBinding,
): void {
  if (snapshot.taskId !== scope.taskId || !executorBindingsEqual(snapshot.binding, binding)) {
    throw createResourceNotFoundError();
  }
}

function assertHostSnapshotScope(
  snapshot: Awaited<ReturnType<SubAgentTaskHandle['snapshot']>>,
  scope: SubAgentTransportTaskHandleScope,
): void {
  if (snapshot.taskId !== scope.taskId || snapshot.ownerSessionId !== scope.ownerSessionId) {
    throw createResourceNotFoundError();
  }
}

function assertOutcomeTaskScope(
  outcome: SubAgentExecutionOutcome | SubAgentExecutorOperationResult,
  taskId: string,
): void {
  if (outcome.type === 'recovery_required') return;
  const actualTaskId =
    outcome.type === 'terminal' ? outcome.result.task.taskId : outcome.task.taskId;
  if (actualTaskId !== taskId) throw createResourceNotFoundError();
}

function assertEventScope(event: SubAgentTaskEvent, scope: SubAgentTransportTaskHandleScope): void {
  if (event.taskId !== scope.taskId || event.sessionId !== scope.ownerSessionId) {
    throw createResourceNotFoundError();
  }
}

function isTerminalState(state: SubAgentTaskState): boolean {
  return (
    state === 'succeeded' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'timed_out' ||
    state === 'budget_exceeded'
  );
}

function isTerminalEvent(event: SubAgentTaskEvent): boolean {
  return (
    event.type === 'task.succeeded' ||
    event.type === 'task.failed' ||
    event.type === 'task.cancelled' ||
    event.type === 'task.timed_out' ||
    event.type === 'task.budget_exceeded'
  );
}

function cloneExecutorBinding(binding: SubAgentExecutorBinding): SubAgentExecutorBinding {
  const keys = Object.keys(binding).sort();
  const expected = [
    'adapterStateVersion',
    'definitionName',
    'definitionVersion',
    'executorName',
    ...(binding.modelBinding === undefined ? [] : ['modelBinding']),
    'ownerSessionId',
    'recoveryData',
    'runnerId',
    'runnerVersion',
    'subagentSessionId',
    'taskId',
    'version',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('Executor task handle binding must be a closed object.');
  }
  assertJsonValue(binding);
  const cloned = parseJsonValue(canonicalizeJson(binding as unknown as JsonValue));
  deepFreezeJson(cloned);
  return cloned as unknown as SubAgentExecutorBinding;
}

function deepFreezeJson(value: JsonValue): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Array.isArray(value) ? value : Object.values(value)) deepFreezeJson(child);
  Object.freeze(value);
}

function freezeScope(
  scope: SubAgentTransportTaskHandleScope,
  label: string,
): Readonly<SubAgentTransportTaskHandleScope> {
  if (!isScope(scope)) throw new TypeError(`${label} has an invalid owner session or task ID.`);
  return Object.freeze({
    ownerSessionId: scope.ownerSessionId,
    ...(scope.parentTaskId === undefined ? {} : { parentTaskId: scope.parentTaskId }),
    taskId: scope.taskId,
  });
}

function isScope(scope: SubAgentTransportTaskHandleScope): boolean {
  return (
    scope !== null &&
    typeof scope === 'object' &&
    isIdentifier(scope.ownerSessionId) &&
    (scope.parentTaskId === undefined || isIdentifier(scope.parentTaskId)) &&
    isIdentifier(scope.taskId)
  );
}

function taskHandleScopeKey(scope: SubAgentTransportTaskHandleScope): string {
  return `${scope.parentTaskId ?? ''}\0${scope.taskId}`;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

async function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}
