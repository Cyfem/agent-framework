import { describe, expect, it } from 'vitest';

import type { StoredTask } from '@ruixutong.manee/maneeagent-framework';

import { MemoryAgentRuntimeStateStore } from '../src';
import { RUN_ID, SESSION_ID, createRun, createTask } from './fixtures';

describe('MemoryAgentRuntimeStateStore', () => {
  it('provides transaction-local indexes, revision CAS and event replay', async () => {
    const store = new MemoryAgentRuntimeStateStore({ transactionDomainId: 'memory-test' });
    await store.createRun(createRun());
    const lease = await store.acquireLease(`subagent-session:${SESSION_ID}`, 10_000);
    const task = createTask(lease);

    await store.transaction(SESSION_ID, lease, async (transaction) => {
      await expect(transaction.createTask(task)).resolves.toMatchObject({ status: 'created' });
      await expect(
        transaction.findTaskByIdempotencyKey(RUN_ID, task.requestId),
      ).resolves.toMatchObject({ taskId: task.taskId });
      await expect(
        transaction.findTaskBySubAgentSession(task.subagentSessionId),
      ).resolves.toMatchObject({ taskId: task.taskId });
    });

    const event = {
      eventId: 'event-1',
      sequence: 1,
      type: 'task.started' as const,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      taskId: task.taskId,
      path: task.path,
      definition: task.definition,
      executor: task.executor,
      attempt: task.attempt,
      timestamp: 1_001,
      data: { status: 'running' },
    };
    const running = {
      ...task,
      state: 'running' as const,
      revision: 1,
      eventSequence: 1,
      activeStartedAt: 1_001,
      updatedAt: 1_001,
    } satisfies StoredTask;
    await store.transaction(SESSION_ID, lease, async (transaction) => {
      await expect(
        transaction.compareAndSetTask(task.taskId, 0, lease.fencingToken, running),
      ).resolves.toBe(true);
      await transaction.appendEvents(task.taskId, [event]);
    });

    await expect(store.loadTask(SESSION_ID, task.taskId)).resolves.toEqual(running);
    await expect(store.readEvents(SESSION_ID, task.taskId, 0)).resolves.toEqual([event]);
  });

  it('increments fencing on takeover and rejects the old owner', async () => {
    let now = 1_000;
    const store = new MemoryAgentRuntimeStateStore({ now: () => now });
    await store.createRun(createRun());
    const leaseKey = `subagent-session:${SESSION_ID}`;
    const first = await store.acquireLease(leaseKey, 10);
    now = 1_010;
    const second = await store.acquireLease(leaseKey, 10);

    expect(first.fencingToken).toBe('1');
    expect(second.fencingToken).toBe('2');
    await expect(store.transaction(SESSION_ID, first, async () => undefined)).rejects.toThrow(
      /expired or fenced/iu,
    );
    await expect(store.transaction(SESSION_ID, second, async () => 'current')).resolves.toBe(
      'current',
    );
  });

  it('rejects a lease that belongs to a different session scope', async () => {
    const store = new MemoryAgentRuntimeStateStore();
    await store.createRun(createRun());
    const wrongScope = await store.acquireLease('subagent-session:another-session', 10_000);

    await expect(store.transaction(SESSION_ID, wrongScope, async () => undefined)).rejects.toThrow(
      /lease scope/iu,
    );

    const wrongRun = await store.acquireLease(
      `agent-run:${JSON.stringify(['another-session', RUN_ID])}`,
      10_000,
    );
    await expect(store.transaction(SESSION_ID, wrongRun, async () => undefined)).rejects.toThrow(
      /lease scope/iu,
    );
  });

  it('accepts the root run-controller lease only for its exact owner session', async () => {
    const store = new MemoryAgentRuntimeStateStore();
    await store.createRun(createRun());
    const lease = await store.acquireLease(
      `agent-run:${JSON.stringify([SESSION_ID, RUN_ID])}`,
      10_000,
    );

    await expect(store.transaction(SESSION_ID, lease, async () => 'owned-run')).resolves.toBe(
      'owned-run',
    );
  });
});
