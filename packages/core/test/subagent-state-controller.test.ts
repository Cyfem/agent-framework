import { describe, expect, it } from 'vitest';

import { ManualClock, RecordingRuntimeStateStore, acceptanceIt } from '../../../testkit';
import type { StateLease, StoredAgentRun, StoredTask, SubAgentTaskEvent } from '../src';
import {
  STATE_CAS_CONFLICT_CAUSE_CODE,
  STATE_FENCING_MISMATCH_CAUSE_CODE,
  commitRuntimeStateMutation,
  createStoredTaskIdempotently,
} from '../src/subagent/state-controller';

function createRun(fencingToken: string, overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    recordVersion: '1',
    ownerSessionId: 'owner-1',
    runId: 'run-1',
    status: 'running',
    revision: 0,
    fencingToken,
    agentCheckpointVersion: '1',
    protocolContext: { protocol: 'openai-chat', codecVersion: '1', value: [] },
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
      descendantsCreated: 1,
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
    recoveryRequired: false,
    activeElapsedMs: 0,
    remainingMs: 120_000,
    eventSequence: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function createEvent(sequence = 1): SubAgentTaskEvent {
  return {
    eventId: `event-${sequence}`,
    sequence,
    type: 'task.started',
    sessionId: 'owner-1',
    runId: 'run-1',
    taskId: 'task-1',
    path: ['task-1'],
    definition: { name: 'researcher', version: '2' },
    executor: 'local',
    attempt: 1,
    timestamp: 1_001,
    data: { status: 'running' },
  };
}

async function createFixture(options: { readonly clock?: ManualClock } = {}): Promise<{
  store: RecordingRuntimeStateStore;
  lease: StateLease;
  run: StoredAgentRun;
  task: StoredTask;
}> {
  const store = new RecordingRuntimeStateStore(
    options.clock === undefined ? {} : { now: options.clock.now },
  );
  const lease = await store.acquireLease('owner-1', 10_000);
  const run = createRun(lease.fencingToken);
  const task = createTask(lease.fencingToken);
  await store.createRun(run);
  await createStoredTaskIdempotently(store, 'owner-1', lease, task);
  return { store, lease, run, task };
}

acceptanceIt('STATE-03', 'declarative-atomic-runtime-commit', async () => {
  const { store, lease, run, task } = await createFixture();
  const nextRun = {
    ...run,
    revision: 1,
    updatedAt: 1_001,
    budget: { ...run.budget, activeExecutions: 1 },
  } satisfies StoredAgentRun;
  const nextTask = {
    ...task,
    state: 'running',
    revision: 1,
    eventSequence: 1,
    updatedAt: 1_001,
    activeStartedAt: 1_001,
  } satisfies StoredTask;

  const committed = await commitRuntimeStateMutation(store, 'owner-1', lease, {
    run: { previous: run, next: nextRun },
    tasks: [{ previous: task, next: nextTask, events: [createEvent()] }],
  });

  expect(committed.run?.revision).toBe(1);
  expect(committed.tasks).toEqual([nextTask]);
  expect(await store.loadRun('owner-1', 'run-1')).toEqual(nextRun);
  expect(await store.loadTask('owner-1', 'task-1')).toEqual(nextTask);
  expect(await store.readEvents('owner-1', 'task-1')).toEqual([createEvent()]);
});

acceptanceIt('STATE-04', 'cas-conflict-rolls-back-whole-mutation', async () => {
  const { store, lease, run, task } = await createFixture();
  const nextRun = { ...run, revision: 1, updatedAt: 1_001 } satisfies StoredAgentRun;
  const forgedPreviousTask = { ...task, remainingMs: 1 } satisfies StoredTask;
  const nextTask = {
    ...forgedPreviousTask,
    state: 'running',
    revision: 1,
    updatedAt: 1_001,
  } satisfies StoredTask;

  await expect(
    commitRuntimeStateMutation(store, 'owner-1', lease, {
      run: { previous: run, next: nextRun },
      tasks: [{ previous: forgedPreviousTask, next: nextTask }],
    }),
  ).rejects.toMatchObject({
    code: 'INVALID_STATE_TRANSITION',
    descriptor: { causeCode: STATE_CAS_CONFLICT_CAUSE_CODE, retryable: true },
  });

  expect((await store.loadRun('owner-1', 'run-1'))?.revision).toBe(0);
  expect((await store.loadTask('owner-1', 'task-1'))?.revision).toBe(0);
});

describe('runtime state controller validation', () => {
  it('closes the final task-create race with transaction-local idempotency', async () => {
    const { store, lease, task } = await createFixture();
    const replay = createTask(lease.fencingToken, {
      taskId: 'unused-replay-id',
      subagentSessionId: 'unused-replay-session',
    });

    await expect(
      createStoredTaskIdempotently(store, 'owner-1', lease, replay),
    ).resolves.toMatchObject({ status: 'existing', task: { taskId: task.taskId } });
    await expect(
      createStoredTaskIdempotently(
        store,
        'owner-1',
        lease,
        createTask(lease.fencingToken, {
          taskId: 'conflicting-id',
          subagentSessionId: 'conflicting-session',
          inputHash: 'sha256:different',
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    expect(store.snapshot('owner-1').tasks).toHaveLength(1);
  });

  it('rejects cross-session records and the wrong next fencing token before persistence', async () => {
    const { store, lease, run } = await createFixture();
    await expect(
      commitRuntimeStateMutation(store, 'owner-1', lease, {
        run: {
          previous: run,
          next: { ...run, ownerSessionId: 'owner-2', revision: 1 },
        },
      }),
    ).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });

    await expect(
      commitRuntimeStateMutation(store, 'owner-1', lease, {
        run: {
          previous: run,
          next: { ...run, fencingToken: '999', revision: 1 },
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      descriptor: { causeCode: STATE_FENCING_MISMATCH_CAUSE_CODE },
    });
    expect((await store.loadRun('owner-1', 'run-1'))?.revision).toBe(0);
  });

  it('allows takeover with the new fence and rejects the fenced previous lease', async () => {
    const clock = new ManualClock(1_000);
    const { store, lease: firstLease, run } = await createFixture({ clock });
    clock.advanceTo(11_000);
    const secondLease = await store.acquireLease('owner-1', 10_000);
    const nextRun = {
      ...run,
      revision: 1,
      fencingToken: secondLease.fencingToken,
      updatedAt: 11_000,
    } satisfies StoredAgentRun;

    await commitRuntimeStateMutation(store, 'owner-1', secondLease, {
      run: { previous: run, next: nextRun },
    });
    await expect(store.transaction('owner-1', firstLease, async () => undefined)).rejects.toThrow(
      /expired or fenced/iu,
    );
    expect((await store.loadRun('owner-1', 'run-1'))?.fencingToken).toBe('2');
  });

  it('rejects immutable identity changes, terminal writes and event gaps', async () => {
    const { store, lease, task } = await createFixture();
    await expect(
      commitRuntimeStateMutation(store, 'owner-1', lease, {
        tasks: [
          {
            previous: task,
            next: { ...task, taskId: 'changed', revision: 1 },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    await expect(
      commitRuntimeStateMutation(store, 'owner-1', lease, {
        tasks: [
          {
            previous: task,
            next: { ...task, revision: 1, eventSequence: 1 },
            events: [{ ...createEvent(), attempt: 2 }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    await expect(
      commitRuntimeStateMutation(store, 'owner-1', lease, {
        tasks: [
          {
            previous: task,
            next: { ...task, revision: 1, eventSequence: 2 },
            events: [{ ...createEvent(), sequence: 2 }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    const terminal = createTask(lease.fencingToken, {
      taskId: 'terminal-task',
      subagentSessionId: 'terminal-session',
      requestId: 'terminal-request',
      idempotencyKey: 'terminal-request',
      state: 'cancelled',
      terminalAt: 1_000,
    });
    await store.transaction('owner-1', lease, async (transaction) => {
      await transaction.createTask(terminal);
    });
    await expect(
      commitRuntimeStateMutation(store, 'owner-1', lease, {
        tasks: [
          {
            previous: terminal,
            next: { ...terminal, revision: 1, updatedAt: 1_001 },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('rejects queued create records polluted with execution or completion state', async () => {
    const store = new RecordingRuntimeStateStore();
    const lease = await store.acquireLease('owner-1', 10_000);
    await store.createRun(createRun(lease.fencingToken));

    await expect(
      createStoredTaskIdempotently(
        store,
        'owner-1',
        lease,
        createTask(lease.fencingToken, {
          binding: {
            executorName: 'local',
            ownerSessionId: 'owner-1',
            taskId: 'task-1',
            subagentSessionId: 'child-session-1',
            definitionName: 'researcher',
            definitionVersion: '2',
            adapterStateVersion: '1',
            recoveryData: {},
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    await expect(
      createStoredTaskIdempotently(
        store,
        'owner-1',
        lease,
        createTask(lease.fencingToken, { recoveryRequired: true }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    await expect(
      createStoredTaskIdempotently(
        store,
        'owner-1',
        lease,
        createTask(lease.fencingToken, { attempt: 2 }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    expect(store.snapshot('owner-1').tasks).toEqual([]);
  });
});
