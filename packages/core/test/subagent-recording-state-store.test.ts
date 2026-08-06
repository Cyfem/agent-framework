import { describe, expect, it } from 'vitest';

import { ManualClock, RecordingRuntimeStateStore, acceptanceIt } from '../../../testkit';
import type { StateLease, StoredAgentRun, StoredTask, SubAgentTaskEvent } from '../src';

function createRun(fencingToken: string, overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    recordVersion: '1',
    ownerSessionId: 'owner-1',
    runId: 'run-1',
    status: 'running',
    revision: 0,
    fencingToken,
    agentCheckpointVersion: '1',
    protocolContext: {
      protocol: 'openai-chat',
      codecVersion: '1',
      value: [],
    },
    contextStore: {
      version: '1',
      protocol: 'openai-chat',
      codecVersion: '1',
      revision: 0,
      rawHistory: [],
      activeSpans: [],
      nextRawItemId: 1,
      nextSpanId: 1,
      nextEntryId: 1,
    },
    modelIteration: 0,
    maxIterations: 10,
    budget: {
      descendantsCreated: 0,
      activeExecutions: 0,
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    pendingApprovals: [],
    endRequested: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function createTask(fencingToken: string, overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    recordVersion: '1',
    ownerSessionId: 'owner-1',
    runId: 'run-1',
    taskId: 'task-1',
    subagentSessionId: 'child-session-1',
    requestId: 'request-1',
    idempotencyKey: 'request-1',
    definition: { name: 'researcher', version: '2' },
    executor: 'local',
    input: { query: 'safe' },
    inputHash: 'sha256:input-1',
    projectedContext: [],
    state: 'queued',
    revision: 0,
    fencingToken,
    path: ['task-1'],
    depth: 1,
    attempt: 1,
    approvals: [],
    approvalDecisions: [],
    controlOperations: [],
    recoveryRequired: false,
    activeElapsedMs: 0,
    remainingMs: 120_000,
    eventSequence: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function createEvent(sequence: number, eventId = `event-${sequence}`): SubAgentTaskEvent {
  return {
    eventId,
    sequence,
    type: sequence === 1 ? 'task.queued' : 'task.started',
    sessionId: 'owner-1',
    runId: 'run-1',
    taskId: 'task-1',
    path: ['task-1'],
    definition: { name: 'researcher', version: '2' },
    executor: 'local',
    attempt: 1,
    timestamp: 1_000 + sequence,
    data: { status: sequence === 1 ? 'queued' : 'running' },
  };
}

async function createLeaseAndRecords(): Promise<{
  store: RecordingRuntimeStateStore;
  lease: StateLease;
  run: StoredAgentRun;
  task: StoredTask;
}> {
  const store = new RecordingRuntimeStateStore();
  const lease = await store.acquireLease('owner-1', 10_000);
  const run = createRun(lease.fencingToken);
  const task = createTask(lease.fencingToken);
  await store.createRun(run);
  await store.transaction('owner-1', lease, async (transaction) => {
    await transaction.createTask(task);
  });
  return { store, lease, run, task };
}

acceptanceIt('STATE-01', 'transaction-local-idempotency', async () => {
  const store = new RecordingRuntimeStateStore();
  const lease = await store.acquireLease('owner-1', 10_000);
  const task = createTask(lease.fencingToken);

  await store.transaction('owner-1', lease, async (transaction) => {
    const created = await transaction.createTask(task);
    const byRequest = await transaction.findTaskByIdempotencyKey('run-1', 'request-1');
    const bySession = await transaction.findTaskBySubAgentSession('child-session-1');
    const replay = await transaction.createTask(structuredClone(task));

    expect(created.status).toBe('created');
    expect(replay.status).toBe('existing');
    expect(byRequest?.taskId).toBe('task-1');
    expect(bySession?.taskId).toBe('task-1');
  });

  await expect(
    store.transaction('owner-1', lease, async (transaction) => {
      await transaction.createTask(
        createTask(lease.fencingToken, {
          taskId: 'task-conflict',
          subagentSessionId: 'child-session-conflict',
          inputHash: 'sha256:different',
        }),
      );
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

acceptanceIt('STATE-02', 'atomic-cas-events-rollback', async () => {
  const { store, lease, run, task } = await createLeaseAndRecords();
  const nextRun = { ...run, revision: 1, updatedAt: 1_001 } satisfies StoredAgentRun;
  const nextTask = {
    ...task,
    state: 'running',
    revision: 1,
    eventSequence: 2,
    activeStartedAt: 1_001,
    updatedAt: 1_001,
  } satisfies StoredTask;

  await expect(
    store.transaction('owner-1', lease, async (transaction) => {
      expect(await transaction.compareAndSetRun('run-1', 0, lease.fencingToken, nextRun)).toBe(
        true,
      );
      expect(await transaction.compareAndSetTask('task-1', 0, lease.fencingToken, nextTask)).toBe(
        true,
      );
      await transaction.appendEvents('task-1', [createEvent(1), createEvent(2)]);
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');

  expect((await store.loadRun('owner-1', 'run-1'))?.revision).toBe(0);
  expect((await store.loadTask('owner-1', 'task-1'))?.revision).toBe(0);
  expect(await store.readEvents('owner-1', 'task-1')).toEqual([]);

  await store.transaction('owner-1', lease, async (transaction) => {
    expect(await transaction.compareAndSetRun('run-1', 0, lease.fencingToken, nextRun)).toBe(true);
    expect(await transaction.compareAndSetTask('task-1', 0, lease.fencingToken, nextTask)).toBe(
      true,
    );
    await transaction.appendEvents('task-1', [createEvent(1), createEvent(2)]);
  });

  expect((await store.loadRun('owner-1', 'run-1'))?.revision).toBe(1);
  expect((await store.loadTask('owner-1', 'task-1'))?.revision).toBe(1);
  expect((await store.readEvents('owner-1', 'task-1', 1)).map(({ sequence }) => sequence)).toEqual([
    2,
  ]);

  await store.transaction('owner-1', lease, async (transaction) => {
    expect(await transaction.compareAndSetRun('run-1', 0, lease.fencingToken, nextRun)).toBe(false);
    expect(await transaction.compareAndSetTask('task-1', 0, lease.fencingToken, nextTask)).toBe(
      false,
    );
  });
});

describe('RecordingRuntimeStateStore', () => {
  it('isolates every lookup by owner session', async () => {
    const { store } = await createLeaseAndRecords();
    expect(await store.loadRun('other-owner', 'run-1')).toBeUndefined();
    expect(await store.loadTask('other-owner', 'task-1')).toBeUndefined();
    expect(
      await store.findTaskByIdempotencyKey('other-owner', 'run-1', 'request-1'),
    ).toBeUndefined();
    expect(await store.findTaskBySubAgentSession('other-owner', 'child-session-1')).toBeUndefined();
  });

  it('uses expiry boundary takeover and monotonically fenced leases', async () => {
    const clock = new ManualClock(5_000);
    const store = new RecordingRuntimeStateStore({ now: clock.now });
    const first = await store.acquireLease('owner-1', 100);
    expect(first.fencingToken).toBe('1');
    await expect(store.acquireLease('owner-1', 100)).rejects.toThrow(/currently unavailable/iu);

    clock.advanceTo(5_099);
    const renewed = await first.renew(100);
    expect(renewed.fencingToken).toBe('1');
    expect(renewed.expiresAt).toBe(5_199);

    clock.advanceTo(5_199);
    const second = await store.acquireLease('owner-1', 100);
    expect(second.fencingToken).toBe('2');
    await expect(store.transaction('owner-1', renewed, async () => undefined)).rejects.toThrow(
      /expired or fenced/iu,
    );

    await second.release();
    const third = await store.acquireLease('owner-1', 100);
    expect(third.fencingToken).toBe('3');
  });

  it('rejects invalid, non-contiguous and duplicate event batches atomically', async () => {
    const { store, lease, task } = await createLeaseAndRecords();
    const nextTask = {
      ...task,
      state: 'running',
      revision: 1,
      eventSequence: 2,
      updatedAt: 1_001,
    } satisfies StoredTask;

    await expect(
      store.transaction('owner-1', lease, async (transaction) => {
        await transaction.compareAndSetTask('task-1', 0, lease.fencingToken, nextTask);
        await transaction.appendEvents('task-1', [createEvent(1), createEvent(1)]);
      }),
    ).rejects.toThrow(/unique IDs and contiguous sequence/iu);

    expect((await store.loadTask('owner-1', 'task-1'))?.revision).toBe(0);
    expect(await store.readEvents('owner-1', 'task-1')).toEqual([]);
  });
});
