import { describe, expect, it, vi } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import type {
  ExecutorTaskHandle,
  ExecutorTaskSnapshot,
  SubAgentExecutorBinding,
} from '../src/subagent/executor';
import { SubAgentRuntimeError } from '../src/subagent/errors';
import type { SubAgentTaskHandle } from '../src/subagent/runtime';
import type { SubAgentExecutionOutcome } from '../src/subagent/result';
import type { SubAgentTaskSnapshot } from '../src/subagent/identity';
import type { SubAgentTaskEvent } from '../src/subagent/telemetry';
import {
  SubAgentTransportTaskHandleRegistry,
  rememberExecutorTaskHandle,
  rememberSubAgentTaskHandle,
  resolveSubAgentTaskHandle,
  type SubAgentTransportTaskHandleScope,
} from '../src/subagent/transport-task-handle-registry';

const SCOPE = Object.freeze({ ownerSessionId: 'owner-session-1', taskId: 'task-1' });

describe('SubAgentTransportTaskHandleRegistry', () => {
  acceptanceIt('C7-GATEWAY-04.l1.handle-registry', 'handle-registry', async () => {
    const registry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    let release: ((handle: SubAgentTaskHandle) => void) | undefined;
    const resolver = vi.fn(
      () =>
        new Promise<SubAgentTaskHandle>((resolve) => {
          release = resolve;
        }),
    );
    const facade = rememberSubAgentTaskHandle(registry, { ...SCOPE, resolver });

    expect(resolver).not.toHaveBeenCalled();
    const first = facade.snapshot();
    const second = facade.snapshot();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    expect(registry.diagnostics()).toMatchObject({
      entries: 1,
      pendingResolutions: 1,
      activeOperations: 2,
    });

    release?.(createHostHandle());
    const snapshots = await Promise.all([first, second]);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ taskId: SCOPE.taskId });
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(registry.diagnostics()).toEqual({
      entries: 1,
      resolvedHandles: 1,
      pendingResolutions: 0,
      activeOperations: 0,
      activeSubscribers: 0,
    });
  });

  it('returns the same safe not-found error for unknown and cross-session lookup', async () => {
    const registry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const resolver = vi.fn(() => createHostHandle());
    rememberSubAgentTaskHandle(registry, { ...SCOPE, resolver });

    const readError = async (scope: SubAgentTransportTaskHandleScope) => {
      try {
        await resolveSubAgentTaskHandle(registry, scope).snapshot();
      } catch (error) {
        return error;
      }
      throw new Error('Expected lookup to fail.');
    };
    const unknown = await readError({ ...SCOPE, taskId: 'task-unknown' });
    const crossSession = await readError({ ...SCOPE, ownerSessionId: 'owner-session-2' });

    expect(unknown).toBeInstanceOf(SubAgentRuntimeError);
    expect(crossSession).toBeInstanceOf(SubAgentRuntimeError);
    expect((unknown as SubAgentRuntimeError).descriptor).toEqual(
      (crossSession as SubAgentRuntimeError).descriptor,
    );
    expect((unknown as SubAgentRuntimeError).descriptor).toEqual({
      code: 'RESOURCE_NOT_FOUND',
      message: 'The requested resource was not found.',
      retryable: false,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('clears a rejected or identity-invalid pending resolution so a later attempt can retry', async () => {
    const registry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const resolver = vi
      .fn<() => Promise<SubAgentTaskHandle>>()
      .mockRejectedValueOnce(new Error('temporary resolver failure'))
      .mockResolvedValueOnce({ ...createHostHandle(), taskId: 'wrong-task' })
      .mockResolvedValueOnce(createHostHandle());
    const facade = rememberSubAgentTaskHandle(registry, { ...SCOPE, resolver });

    await expect(facade.snapshot()).rejects.toThrow('temporary resolver failure');
    expect(registry.diagnostics().pendingResolutions).toBe(0);
    await expect(facade.snapshot()).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(registry.diagnostics().pendingResolutions).toBe(0);
    await expect(facade.snapshot()).resolves.toMatchObject({ taskId: SCOPE.taskId });
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it('has no public generic handle callback that can return a raw handle or iterable', () => {
    const registry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    expect(Reflect.get(registry, 'resolve')).toBeUndefined();
    expect(Reflect.get(registry, 'events')).toBeUndefined();
  });

  it('validates an Executor handle binding and exposes only a frozen lazy facade', async () => {
    const binding = createBinding();
    const snapshot = createExecutorSnapshot(binding, 'running');
    const raw = {
      taskId: SCOPE.taskId,
      binding,
      secretSocket: 'raw-socket-should-not-leak',
      snapshot: vi.fn(async () => snapshot),
      wait: vi.fn(async () => createTerminalOutcome()),
      cancel: vi.fn(async () => undefined),
      events: vi.fn(() => emptyEvents()),
    } as ExecutorTaskHandle & { readonly secretSocket: string };
    const registry = new SubAgentTransportTaskHandleRegistry<ExecutorTaskHandle>();
    const resolver = vi.fn(() => raw);
    const facade = rememberExecutorTaskHandle(registry, { ...SCOPE, binding, resolver });

    expect(resolver).not.toHaveBeenCalled();
    expect(Object.isFrozen(facade)).toBe(true);
    expect(JSON.stringify(facade)).not.toContain('raw-socket-should-not-leak');
    expect(JSON.stringify(registry)).toBe('{}');
    await expect(facade.snapshot()).resolves.toEqual(snapshot);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(raw.snapshot).toHaveBeenCalledTimes(1);
    registry.forget(SCOPE);
  });

  it('rejects a resolved Executor handle with a different binding before calling it', async () => {
    const binding = createBinding();
    const wrongBinding = createBinding({ ownerSessionId: 'owner-session-other' });
    const snapshot = vi.fn(async () => createExecutorSnapshot(wrongBinding, 'running'));
    const raw: ExecutorTaskHandle = {
      taskId: SCOPE.taskId,
      binding: wrongBinding,
      snapshot,
      wait: async () => createTerminalOutcome(),
      cancel: async () => undefined,
      events: () => emptyEvents(),
    };
    const registry = new SubAgentTransportTaskHandleRegistry<ExecutorTaskHandle>();
    const facade = rememberExecutorTaskHandle(registry, {
      ...SCOPE,
      binding,
      resolver: () => raw,
    });

    await expect(facade.snapshot()).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(snapshot).not.toHaveBeenCalled();
    expect(registry.diagnostics().pendingResolutions).toBe(0);
  });

  it('wraps a generic Core SubAgentTaskHandle and rechecks its session-scoped results', async () => {
    const raw = createHostHandle();
    const registry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const facade = rememberSubAgentTaskHandle(registry, { ...SCOPE, resolver: () => raw });

    expect(JSON.stringify(facade)).toBe(JSON.stringify({ taskId: SCOPE.taskId }));
    await expect(facade.snapshot()).resolves.toMatchObject({
      taskId: SCOPE.taskId,
      ownerSessionId: SCOPE.ownerSessionId,
    });

    const wrong = createHostHandle({ ownerSessionId: 'owner-session-other' });
    const wrongRegistry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const wrongFacade = rememberSubAgentTaskHandle(wrongRegistry, {
      ...SCOPE,
      resolver: () => wrong,
    });
    await expect(wrongFacade.snapshot()).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('requires exact parent scope for Core snapshots, cancellations, and events', async () => {
    const scope = { ...SCOPE, parentTaskId: 'parent-task-1' };
    const siblingSnapshot = createHostSnapshot({
      parentTaskId: 'parent-task-2',
      path: ['parent-task-2', SCOPE.taskId],
    });

    const snapshotRegistry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const snapshotFacade = rememberSubAgentTaskHandle(snapshotRegistry, {
      ...scope,
      resolver: () => createHostHandle({ snapshot: async () => siblingSnapshot }),
    });
    await expect(snapshotFacade.snapshot()).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const cancelRegistry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const cancelFacade = rememberSubAgentTaskHandle(cancelRegistry, {
      ...scope,
      resolver: () => createHostHandle({ cancel: async () => siblingSnapshot }),
    });
    await expect(cancelFacade.cancel()).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const eventRegistry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const eventFacade = rememberSubAgentTaskHandle(eventRegistry, {
      ...scope,
      resolver: () =>
        createHostHandle({
          events: () =>
            oneThenPending(async () => ({ done: true, value: undefined }), {
              ...createTaskEvent(),
              parentTaskId: 'parent-task-2',
            }),
        }),
    });
    await expect(eventFacade.events()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('returns closed owned projections when raw operations add handle wrappers', async () => {
    const snapshot = createHostSnapshot();
    const outcome = createTerminalOutcome();
    const event = createTaskEvent();
    const raw: SubAgentTaskHandle = createHostHandle({
      snapshot: async () => ({ ...snapshot, escaped: { raw } }) as typeof snapshot,
      wait: async () => ({ ...outcome, escaped: { raw } }) as unknown as typeof outcome,
      events: () =>
        oneThenPending(async () => ({ done: true, value: undefined }), event, {
          escaped: { raw },
        }),
    });
    const registry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const facade = rememberSubAgentTaskHandle(registry, { ...SCOPE, resolver: () => raw });

    const projectedSnapshot = await facade.snapshot();
    expect(Reflect.has(projectedSnapshot, 'escaped')).toBe(false);
    expect(Object.isFrozen(projectedSnapshot)).toBe(true);
    const projectedEvent = await facade.events()[Symbol.asyncIterator]().next();
    expect(projectedEvent.done).toBe(false);
    expect(Reflect.has(projectedEvent.value as object, 'escaped')).toBe(false);
    expect(Object.isFrozen(projectedEvent.value)).toBe(true);
    const projectedOutcome = await facade.wait();
    expect(Reflect.has(projectedOutcome, 'escaped')).toBe(false);
    expect(Object.isFrozen(projectedOutcome)).toBe(true);
    expect(
      JSON.stringify([projectedSnapshot, projectedOutcome, projectedEvent.value]),
    ).not.toContain('raw');
  });

  it('cleans an events iterator on consumer return, abort and source throw', async () => {
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const returnRegistry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const returnedFacade = rememberSubAgentTaskHandle(returnRegistry, {
      ...SCOPE,
      resolver: () => createHostHandle({ events: () => oneThenPending(returned) }),
    });
    const returnedStream = returnedFacade.events();
    const returnedIterator = returnedStream[Symbol.asyncIterator]();
    await expect(returnedIterator.next()).resolves.toEqual({
      done: false,
      value: createTaskEvent(),
    });
    expect(returnRegistry.diagnostics()).toMatchObject({ entries: 1, activeSubscribers: 1 });
    await returnedIterator.return?.();
    expect(returned.mock.calls.length, 'consumer return cleanup').toBe(1);
    expect(returnRegistry.diagnostics().activeSubscribers).toBe(0);
    returnRegistry.forget(SCOPE);
    expect(returnRegistry.diagnostics()).toEqual(zeroDiagnostics());

    const abortReturned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const abortNext = vi.fn(() => new Promise<IteratorResult<SubAgentTaskEvent>>(() => undefined));
    const abortRegistry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const abortFacade = rememberSubAgentTaskHandle(abortRegistry, {
      ...SCOPE,
      resolver: () => createHostHandle({ events: () => pendingEvents(abortNext, abortReturned) }),
    });
    const controller = new AbortController();
    const abortedIterator = abortFacade
      .events({ signal: controller.signal })
      [Symbol.asyncIterator]();
    const pending = abortedIterator.next();
    await vi.waitFor(() => expect(abortNext).toHaveBeenCalledTimes(1));
    controller.abort(new Error('stop-events'));
    await expect(pending).rejects.toThrow('stop-events');
    expect(abortReturned.mock.calls.length, 'abort cleanup').toBe(1);
    abortRegistry.forget(SCOPE);
    expect(abortRegistry.diagnostics()).toEqual(zeroDiagnostics());

    const throwReturned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const throwRegistry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const throwFacade = rememberSubAgentTaskHandle(throwRegistry, {
      ...SCOPE,
      resolver: () => createHostHandle({ events: () => throwingEvents(throwReturned) }),
    });
    const throwingIterator = throwFacade.events()[Symbol.asyncIterator]();
    await expect(throwingIterator.next()).rejects.toThrow('event-source-failed');
    expect(throwReturned.mock.calls.length, 'source throw cleanup').toBe(1);
    expect(throwRegistry.diagnostics().activeSubscribers).toBe(0);
    throwRegistry.forget(SCOPE);
    expect(throwRegistry.diagnostics()).toEqual(zeroDiagnostics());
  });

  it('evicts terminal entries only after their active operation has settled', async () => {
    const registry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const facade = rememberSubAgentTaskHandle(registry, {
      ...SCOPE,
      resolver: () =>
        createHostHandle({
          snapshot: async () => {
            expect(registry.markTerminal(SCOPE)).toBe(true);
            expect(registry.diagnostics()).toMatchObject({ entries: 1, activeOperations: 1 });
            return createHostSnapshot();
          },
        }),
    });
    await facade.snapshot();
    expect(registry.diagnostics()).toEqual(zeroDiagnostics());
  });

  it('evicts resolved Core handles after terminal wait, snapshot, and cancellation results', async () => {
    const operations = [
      {
        name: 'wait',
        invoke: (handle: SubAgentTaskHandle) => handle.wait(),
        raw: createHostHandle(),
      },
      {
        name: 'snapshot',
        invoke: (handle: SubAgentTaskHandle) => handle.snapshot(),
        raw: createHostHandle({
          snapshot: async () => createHostSnapshot({ state: 'succeeded', completedAt: 2 }),
        }),
      },
      {
        name: 'cancel',
        invoke: (handle: SubAgentTaskHandle) => handle.cancel('terminal cleanup'),
        raw: createHostHandle(),
      },
    ] as const;

    for (const operation of operations) {
      const registry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
      registry.remember({ ...SCOPE, resolver: () => operation.raw });
      await operation.invoke(resolveSubAgentTaskHandle(registry, SCOPE));
      expect(registry.diagnostics(), operation.name).toEqual(zeroDiagnostics());
    }
  });

  it('forgets only one owner and parent scope after active operations become idle', async () => {
    const registry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const parentScope = {
      ownerSessionId: SCOPE.ownerSessionId,
      parentTaskId: 'parent-task-1',
      taskId: 'child-task-1',
    };
    const siblingParentScope = { ...parentScope, parentTaskId: 'parent-task-2' };
    const foreignOwnerScope = { ...parentScope, ownerSessionId: 'owner-session-2' };
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = rememberSubAgentTaskHandle(registry, {
      ...parentScope,
      resolver: () =>
        createHostHandle({
          taskId: parentScope.taskId,
          snapshot: async () => {
            await barrier;
            return createHostSnapshot({
              taskId: parentScope.taskId,
              ownerSessionId: parentScope.ownerSessionId,
              parentTaskId: parentScope.parentTaskId,
              path: [parentScope.parentTaskId, parentScope.taskId],
            });
          },
        }),
    });
    registry.remember({
      ...siblingParentScope,
      resolver: () => createHostHandle({ taskId: siblingParentScope.taskId }),
    });
    registry.remember({
      ...foreignOwnerScope,
      resolver: () =>
        createHostHandle({
          taskId: foreignOwnerScope.taskId,
          ownerSessionId: foreignOwnerScope.ownerSessionId,
        }),
    });

    const pending = active.snapshot();
    await vi.waitFor(() => expect(registry.diagnostics().activeOperations).toBe(1));
    expect(registry.forgetParentScope(parentScope.ownerSessionId, parentScope.parentTaskId)).toBe(
      1,
    );
    expect(registry.diagnostics()).toMatchObject({ entries: 3, activeOperations: 1 });

    release();
    await pending;
    expect(registry.diagnostics()).toMatchObject({ entries: 2, activeOperations: 0 });
    expect(registry.has(siblingParentScope)).toBe(true);
    expect(registry.has(foreignOwnerScope)).toBe(true);
    expect(registry.forgetParentScope(parentScope.ownerSessionId, parentScope.parentTaskId)).toBe(
      0,
    );
    registry.forget(siblingParentScope);
    registry.forget(foreignOwnerScope);
    expect(registry.diagnostics()).toEqual(zeroDiagnostics());
  });

  it('returns every registry counter to baseline after 10,000 terminal tasks', async () => {
    const registry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>();
    const baseline = registry.diagnostics();

    for (let index = 0; index < 10_000; index += 1) {
      const scope = { ownerSessionId: `owner-${index % 7}`, taskId: `task-${index}` };
      const facade = rememberSubAgentTaskHandle(registry, {
        ...scope,
        resolver: () =>
          createHostHandle({
            taskId: scope.taskId,
            ownerSessionId: scope.ownerSessionId,
            snapshot: async () =>
              createHostSnapshot({
                taskId: scope.taskId,
                ownerSessionId: scope.ownerSessionId,
                state: 'succeeded',
              }),
          }),
      });
      await facade.snapshot();
    }

    expect(registry.diagnostics()).toEqual(baseline);
  });

  it('notifies an adapter mirror exactly once after deferred terminal eviction', async () => {
    const evicted: string[] = [];
    const registry = new SubAgentTransportTaskHandleRegistry<SubAgentTaskHandle>({
      onEvict: ({ ownerSessionId, taskId }) => evicted.push(`${ownerSessionId}/${taskId}`),
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const facade = rememberSubAgentTaskHandle(registry, {
      ...SCOPE,
      resolver: () =>
        createHostHandle({
          wait: async () => {
            await barrier;
            return createTerminalOutcome();
          },
        }),
    });

    const waiting = facade.wait();
    await vi.waitFor(() => expect(registry.diagnostics().activeOperations).toBe(1));
    registry.markTerminal(SCOPE);
    expect(evicted).toEqual([]);
    release();
    await waiting;

    expect(evicted).toEqual([`${SCOPE.ownerSessionId}/${SCOPE.taskId}`]);
    expect(registry.diagnostics().entries).toBe(0);
    registry.forget(SCOPE);
    expect(evicted).toHaveLength(1);
  });
});

function createBinding(overrides: Partial<SubAgentExecutorBinding> = {}): SubAgentExecutorBinding {
  return {
    version: '1',
    executorName: 'process',
    ownerSessionId: SCOPE.ownerSessionId,
    taskId: SCOPE.taskId,
    subagentSessionId: 'subagent-session-1',
    definitionName: 'researcher',
    definitionVersion: '2',
    runnerId: 'builtin-child-runner',
    runnerVersion: '1',
    adapterStateVersion: '1',
    recoveryData: { kind: 'process/v1', jobId: 'job-1' },
    ...overrides,
  };
}

function createExecutorSnapshot(
  binding: SubAgentExecutorBinding,
  state: ExecutorTaskSnapshot['state'],
): ExecutorTaskSnapshot {
  return { taskId: binding.taskId, state, binding, updatedAt: 10 };
}

function createTerminalOutcome(): SubAgentExecutionOutcome {
  return {
    type: 'terminal',
    result: {
      status: 'succeeded',
      task: { taskId: SCOPE.taskId, subAgent: { name: 'researcher', version: '2' } },
      executor: 'process',
      output: { proof: 'ok' },
    },
  };
}

interface HostHandleOptions {
  readonly taskId?: string;
  readonly ownerSessionId?: string;
  readonly snapshot?: SubAgentTaskHandle['snapshot'];
  readonly wait?: SubAgentTaskHandle['wait'];
  readonly cancel?: SubAgentTaskHandle['cancel'];
  readonly events?: SubAgentTaskHandle['events'];
}

function createHostSnapshot(overrides: Partial<SubAgentTaskSnapshot> = {}): SubAgentTaskSnapshot {
  return {
    taskId: overrides.taskId ?? SCOPE.taskId,
    subAgent: { name: 'researcher', version: '2' },
    ownerSessionId: overrides.ownerSessionId ?? SCOPE.ownerSessionId,
    runId: 'run-1',
    subagentSessionId: 'subagent-session-1',
    path: [overrides.taskId ?? SCOPE.taskId],
    executor: 'process',
    state: 'running' as const,
    revision: 1,
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    recoveryRequired: false,
    ...overrides,
  };
}

function createHostHandle(overrides: HostHandleOptions = {}): SubAgentTaskHandle {
  const snapshot = createHostSnapshot({
    ...(overrides.taskId === undefined ? {} : { taskId: overrides.taskId }),
    ...(overrides.ownerSessionId === undefined ? {} : { ownerSessionId: overrides.ownerSessionId }),
  });
  return {
    taskId: overrides.taskId ?? SCOPE.taskId,
    snapshot: overrides.snapshot ?? (async () => snapshot),
    wait: overrides.wait ?? (async () => createTerminalOutcome()),
    cancel:
      overrides.cancel ??
      (async () => ({ ...snapshot, state: 'cancelled', revision: 2, updatedAt: 2 })),
    events: overrides.events ?? (() => emptyEvents()),
  };
}

async function* emptyEvents(): AsyncGenerator<SubAgentTaskEvent> {}

function createTaskEvent(): SubAgentTaskEvent {
  return {
    eventId: 'event-1',
    sequence: 1,
    type: 'task.started',
    sessionId: SCOPE.ownerSessionId,
    runId: 'run-1',
    taskId: SCOPE.taskId,
    path: [SCOPE.taskId],
    definition: { name: 'researcher', version: '2' },
    executor: 'process',
    attempt: 1,
    timestamp: 1,
    data: { status: 'running' },
  };
}

function oneThenPending(
  returned: () => Promise<IteratorResult<SubAgentTaskEvent>>,
  event: SubAgentTaskEvent = createTaskEvent(),
  extras: object = {},
): AsyncIterable<SubAgentTaskEvent> {
  let first = true;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (first) {
            first = false;
            return Promise.resolve({
              done: false as const,
              value: { ...event, ...extras } as SubAgentTaskEvent,
            });
          }
          return new Promise<IteratorResult<SubAgentTaskEvent>>(() => undefined);
        },
        return: returned,
      };
    },
  };
}

function pendingEvents(
  next: () => Promise<IteratorResult<SubAgentTaskEvent>>,
  returned: () => Promise<IteratorResult<SubAgentTaskEvent>>,
): AsyncIterable<SubAgentTaskEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next,
        return: returned,
      };
    },
  };
}

function throwingEvents(
  returned: () => Promise<IteratorResult<SubAgentTaskEvent>>,
): AsyncIterable<SubAgentTaskEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(new Error('event-source-failed')),
        return: returned,
      };
    },
  };
}

function zeroDiagnostics() {
  return {
    entries: 0,
    resolvedHandles: 0,
    pendingResolutions: 0,
    activeOperations: 0,
    activeSubscribers: 0,
  };
}
