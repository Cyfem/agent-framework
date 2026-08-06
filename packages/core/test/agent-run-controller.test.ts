import { describe, expect, it, vi } from 'vitest';

import { RecordingRuntimeStateStore, acceptanceIt } from '../../../testkit';
import {
  applyCompactTransactionCheckpoint,
  beginCompactTransactionCheckpoint,
  completeCompactTransactionCheckpoint,
  createCompactTransactionCheckpoint,
} from '../src/agent/context-compact';
import { ContextStore } from '../src/agent/context-store';
import { AgentRunCheckpointController } from '../src/agent/run-controller';
import { createToolBatchPlan } from '../src/agent/tool-batch';
import { OpenAIChatModel } from '../src/llm/chat';
import { OpenAIResponsesModel } from '../src/llm/responses';
import {
  OPENAI_CHAT_CHECKPOINT_CODEC,
  OPENAI_RESPONSES_CHECKPOINT_CODEC,
  type AgentCheckpointMigrator,
  type AgentProtocolCheckpointCodec,
} from '../src/subagent/checkpoint';
import type { JsonValue } from '../src/subagent/json';
import { createStoredTaskIdempotently } from '../src/subagent/state-controller';
import type {
  StoredAgentRun,
  StoredPendingToolBatch,
  StoredTask,
} from '../src/subagent/state-store';
import { parsedCall, type TestContext, type TestProtocol } from './helpers/mock-models';

const TEST_CODEC: AgentProtocolCheckpointCodec<TestProtocol> = Object.freeze({
  protocol: 'test-protocol',
  version: '1',
  encode(context: readonly TestContext[]): JsonValue {
    return structuredClone(context) as JsonValue;
  },
  decode(value: JsonValue): readonly TestContext[] {
    if (!Array.isArray(value)) throw new TypeError('Expected a context array.');
    return structuredClone(value) as unknown as readonly TestContext[];
  },
});

function createController(
  store: RecordingRuntimeStateStore,
  options: {
    readonly ownerSessionId?: string;
    readonly codec?: AgentProtocolCheckpointCodec<TestProtocol>;
    readonly checkpointMigrators?: readonly AgentCheckpointMigrator[];
  } = {},
) {
  let now = 1_000;
  return new AgentRunCheckpointController<TestProtocol>({
    ownerSessionId: options.ownerSessionId ?? 'owner-1',
    stateStore: store,
    checkpointCodec: options.codec ?? TEST_CODEC,
    ...(options.checkpointMigrators === undefined
      ? {}
      : { checkpointMigrators: options.checkpointMigrators }),
    now: () => now++,
    createRunId: () => 'run-1',
  });
}

function createPendingBatch(iteration = 0) {
  return createToolBatchPlan<TestProtocol>({
    batchId: 'batch-1',
    iteration,
    assistantMessage: {
      protocol: TEST_CODEC.protocol,
      codecVersion: TEST_CODEC.version,
      value: [{ kind: 'assistant', content: 'pending', calls: [] }],
    },
    calls: [parsedCall('agent-call-1', 'agent')],
    createdAt: 1_050,
  }).initialCheckpoint;
}

function createStoredChildTask(fencingToken: string): StoredTask {
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
  };
}

function createLegacyStoredRun(): StoredAgentRun {
  const contextStore = new ContextStore<TestProtocol>([
    { kind: 'user', content: 'legacy root context' },
  ]);
  const checkpoint = contextStore.exportCheckpoint(TEST_CODEC);
  return {
    recordVersion: '1',
    ownerSessionId: 'owner-1',
    runId: 'run-1',
    status: 'running',
    revision: 0,
    fencingToken: '0',
    agentCheckpointVersion: '0',
    protocolContext: {
      protocol: TEST_CODEC.protocol,
      codecVersion: '0',
      value: TEST_CODEC.encode(contextStore.getActiveContext()),
    },
    contextStore: {
      ...checkpoint,
      version: '0',
      codecVersion: '0',
    },
    modelIteration: 0,
    maxIterations: null,
    budget: {
      descendantsCreated: 0,
      activeExecutions: 0,
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    pendingApprovals: [],
    endRequested: false,
    createdAt: 900,
    updatedAt: 900,
  } as unknown as StoredAgentRun;
}

function migrateLegacyRun(value: JsonValue): JsonValue {
  const record = value as Readonly<Record<string, JsonValue>>;
  const protocolContext = record.protocolContext as Readonly<Record<string, JsonValue>>;
  return {
    ...record,
    agentCheckpointVersion: '1',
    protocolContext: { ...protocolContext, codecVersion: '1' },
  };
}

function migrateLegacyContext(value: JsonValue): JsonValue {
  const checkpoint = value as Readonly<Record<string, JsonValue>>;
  return { ...checkpoint, version: '1', codecVersion: '1' };
}

function createLegacyMigrators(
  contextMigrate: AgentCheckpointMigrator['migrate'] = migrateLegacyContext,
): readonly AgentCheckpointMigrator[] {
  return [
    {
      recordKind: 'agent-run',
      protocol: TEST_CODEC.protocol,
      fromVersion: '0',
      toVersion: '1',
      fromCodecVersion: '0',
      toCodecVersion: '1',
      migrate: migrateLegacyRun,
    },
    {
      recordKind: 'context',
      protocol: TEST_CODEC.protocol,
      fromVersion: '0',
      toVersion: '1',
      fromCodecVersion: '0',
      toCodecVersion: '1',
      migrate: contextMigrate,
    },
  ];
}

describe('AgentRunCheckpointController', () => {
  it('exposes the exact built-in checkpoint codec from each OpenAI protocol Model', () => {
    expect(new OpenAIChatModel({ apiKey: 'test-only', model: 'chat-model' }).checkpointCodec).toBe(
      OPENAI_CHAT_CHECKPOINT_CODEC,
    );
    expect(
      new OpenAIResponsesModel({ apiKey: 'test-only', model: 'responses-model' }).checkpointCodec,
    ).toBe(OPENAI_RESPONSES_CHECKPOINT_CODEC);
  });

  it('creates and restores a detached root checkpoint with omitted maxIterations as null', async () => {
    const store = new RecordingRuntimeStateStore();
    const controller = createController(store);
    const contextStore = new ContextStore<TestProtocol>([{ kind: 'user', content: 'seed' }]);

    const active = await controller.beginCreate({ contextStore });
    const created = active.checkpoint;
    contextStore.appendStandalone({ kind: 'user', content: 'mutated-after-create' }, 'user');
    const restored = await controller.load('run-1', active.lease);

    expect(created.record).toMatchObject({
      runId: 'run-1',
      status: 'running',
      maxIterations: null,
      modelIteration: 0,
    });
    expect(restored.contextStore.getActiveContext()).toEqual([{ kind: 'user', content: 'seed' }]);
    expect(restored.protocolContext).toEqual([{ kind: 'user', content: 'seed' }]);
    expect(restored.recovery).toEqual({ action: 'continue' });

    const otherSession = createController(store, { ownerSessionId: 'owner-2' });
    await expect(otherSession.beginResume('run-1')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await active.lease.release();
  });

  acceptanceIt('RUN-01.l1.approval-checkpoint', 'approval-checkpoint', async () => {
    const store = new RecordingRuntimeStateStore();
    const controller = createController(store);
    const contextStore = new ContextStore<TestProtocol>([{ kind: 'user', content: 'task' }]);
    const active = await controller.beginCreate({ contextStore, maxIterations: 8 });
    contextStore.openLoopSpan();
    contextStore.appendToOpenLoop({ kind: 'assistant', content: 'pending', calls: [] });
    const pendingBatch = createPendingBatch();
    const pendingApprovals = [
      {
        approvalId: 'approval-1',
        ownerSessionId: 'owner-1',
        taskId: 'task-1',
        callId: 'risky-1',
        toolName: 'risky-tool',
        summary: 'Host-safe summary.',
        createdAt: 1_060,
        revision: 2,
      },
    ];

    await controller.checkpoint(
      {
        runId: 'run-1',
        contextStore,
        status: 'waiting_approval',
        pendingBatch,
        pendingApprovals,
      },
      active.lease,
    );
    await active.lease.release();
    const replacement = createController(store);
    const resumed = await replacement.beginResume('run-1');
    const restored = await replacement.restoreWaitingApproval('run-1', resumed.lease);

    expect(restored.record.status).toBe('waiting_approval');
    expect(restored.record.pendingBatch).toEqual(pendingBatch);
    expect(restored.record.pendingApprovals).toEqual(pendingApprovals);
    expect(restored.contextStore.hasOpenLoopSpan).toBe(true);
    expect(restored.contextStore.getRawHistory()).toEqual([
      { kind: 'user', content: 'task' },
      { kind: 'assistant', content: 'pending', calls: [] },
    ]);
    await resumed.lease.release();
  });

  it('accepts applied Tool calls and rejects an applied phase without a durable result', async () => {
    const store = new RecordingRuntimeStateStore();
    const controller = createController(store);
    const contextStore = new ContextStore<TestProtocol>([{ kind: 'user', content: 'task' }]);
    const active = await controller.beginCreate({ contextStore });
    const pendingBatch = createPendingBatch();
    const appliedBatch = {
      ...pendingBatch,
      calls: pendingBatch.calls.map((call) => ({
        ...call,
        status: 'applied' as const,
        output: { ok: true },
      })),
    };

    await controller.checkpoint(
      { runId: 'run-1', contextStore, pendingBatch: appliedBatch },
      active.lease,
    );
    expect((await controller.load('run-1', active.lease)).record.pendingBatch).toEqual(
      appliedBatch,
    );

    const malformed = {
      ...appliedBatch,
      calls: appliedBatch.calls.map((call) => ({
        callId: call.callId,
        name: call.name,
        order: call.order,
        kind: call.kind,
        status: call.status,
        ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
        ...(call.error === undefined ? {} : { error: call.error }),
      })),
    } as StoredPendingToolBatch;
    await expect(
      controller.checkpoint(
        { runId: 'run-1', contextStore, pendingBatch: malformed },
        active.lease,
      ),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_VERSION_MISMATCH' });
    await active.lease.release();
  });

  it('rejects a mismatched protocol codec before restoring ContextStore', async () => {
    const store = new RecordingRuntimeStateStore();
    const controller = createController(store);
    const active = await controller.beginCreate({
      contextStore: new ContextStore<TestProtocol>([{ kind: 'user', content: 'seed' }]),
    });
    await active.lease.release();
    const decode = vi.fn(() => [] as readonly TestContext[]);
    const mismatched: AgentProtocolCheckpointCodec<TestProtocol> = {
      ...TEST_CODEC,
      protocol: 'other-protocol',
      decode,
    };

    await expect(
      createController(store, { codec: mismatched }).beginResume('run-1'),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_VERSION_MISMATCH' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('copy-on-write migrates agent-run and ContextStore checkpoints before decoding', async () => {
    const store = new RecordingRuntimeStateStore();
    const legacy = createLegacyStoredRun();
    await store.createRun(legacy);
    const migrators = createLegacyMigrators().map((migrator) => ({
      ...migrator,
      migrate: vi.fn(migrator.migrate),
    })) satisfies readonly AgentCheckpointMigrator[];
    const decode = vi.fn(TEST_CODEC.decode);
    const controller = createController(store, {
      codec: { ...TEST_CODEC, decode },
      checkpointMigrators: migrators,
    });

    const active = await controller.beginResume('run-1');
    const persisted = await store.loadRun('owner-1', 'run-1');

    expect(migrators[0]?.migrate).toHaveBeenCalledTimes(1);
    expect(migrators[1]?.migrate).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalled();
    expect(active.checkpoint.protocolContext).toEqual([
      { kind: 'user', content: 'legacy root context' },
    ]);
    expect(persisted).toMatchObject({
      revision: 1,
      agentCheckpointVersion: '1',
      protocolContext: { codecVersion: '1' },
      contextStore: { version: '1', codecVersion: '1' },
    });
    expect(legacy).toMatchObject({
      revision: 0,
      agentCheckpointVersion: '0',
      protocolContext: { codecVersion: '0' },
      contextStore: { version: '0', codecVersion: '0' },
    });
    await active.lease.release();
  });

  it('keeps the original record untouched when a detached migration fails', async () => {
    const store = new RecordingRuntimeStateStore();
    const legacy = createLegacyStoredRun();
    await store.createRun(legacy);
    const decode = vi.fn(TEST_CODEC.decode);
    const failingContextMigration = vi.fn((value: JsonValue): JsonValue => {
      const detached = value as Record<string, JsonValue>;
      detached.codecVersion = 'mutated-before-failure';
      throw new Error('migration fixture failure');
    });
    const controller = createController(store, {
      codec: { ...TEST_CODEC, decode },
      checkpointMigrators: createLegacyMigrators(failingContextMigration),
    });

    await expect(controller.beginResume('run-1')).rejects.toMatchObject({
      code: 'CHECKPOINT_MIGRATION_FAILED',
    });

    expect(failingContextMigration).toHaveBeenCalledTimes(1);
    expect(decode).not.toHaveBeenCalled();
    expect(await store.loadRun('owner-1', 'run-1')).toEqual(legacy);
  });

  it('maps compact phases to execute/apply and fails an in-flight outcome without replay', async () => {
    const store = new RecordingRuntimeStateStore();
    const controller = createController(store);
    const contextStore = new ContextStore<TestProtocol>([{ kind: 'user', content: 'seed' }]);
    const active = await controller.beginCreate({ contextStore, maxIterations: 4 });
    const prepared = createCompactTransactionCheckpoint({
      transactionId: 'compact-1',
      kind: 'summary',
      contextRevision: contextStore.revision,
      preparedAt: 1_100,
    });

    await controller.checkpoint(
      {
        runId: 'run-1',
        contextStore,
        compactTransaction: prepared,
      },
      active.lease,
    );
    expect((await controller.load('run-1', active.lease)).recovery.action).toBe('execute_compact');

    const inFlight = beginCompactTransactionCheckpoint(prepared, 1_101);
    await controller.checkpoint(
      {
        runId: 'run-1',
        contextStore,
        compactTransaction: inFlight,
      },
      active.lease,
    );
    const unknown = await controller.load('run-1', active.lease);
    expect(unknown.recovery).toMatchObject({
      action: 'fail_outcome_unknown',
      error: { causeCode: 'COMPACT_OUTCOME_UNKNOWN', outcomeUnknown: true, retryable: false },
    });

    const resultReady = completeCompactTransactionCheckpoint(
      inFlight,
      { summary: 'durable summary' },
      1_102,
    );
    await controller.checkpoint(
      {
        runId: 'run-1',
        contextStore,
        compactTransaction: resultReady,
      },
      active.lease,
    );
    const ready = await controller.load('run-1', active.lease);
    expect(ready.recovery.action).toBe('apply_compact');

    const apply = vi.fn(() => {
      contextStore.appendStandalone({ kind: 'user', content: 'summary applied' }, 'user');
    });
    const applied = await applyCompactTransactionCheckpoint(resultReady, 1_103, apply);
    await controller.checkpoint(
      {
        runId: 'run-1',
        contextStore,
        compactTransaction: applied,
      },
      active.lease,
    );
    const appliedAgain = vi.fn();
    await applyCompactTransactionCheckpoint(applied, 1_104, appliedAgain);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(appliedAgain).not.toHaveBeenCalled();
    expect((await controller.load('run-1', active.lease)).recovery).toEqual({
      action: 'continue',
    });
    await active.lease.release();
  });

  it('keeps terminal run state irreversible under fenced checkpoint CAS', async () => {
    const store = new RecordingRuntimeStateStore();
    const controller = createController(store);
    const contextStore = new ContextStore<TestProtocol>([{ kind: 'user', content: 'seed' }]);
    const active = await controller.beginCreate({ contextStore, maxIterations: 3 });
    await controller.checkpoint(
      {
        runId: 'run-1',
        contextStore,
        status: 'succeeded',
        pendingBatch: null,
      },
      active.lease,
    );

    await expect(
      controller.checkpoint({ runId: 'run-1', contextStore, status: 'running' }, active.lease),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    await active.lease.release();
  });

  it('holds one fixed fencing epoch across checkpoints and excludes a second controller', async () => {
    const store = new RecordingRuntimeStateStore();
    const first = createController(store);
    const contextStore = new ContextStore<TestProtocol>([
      { kind: 'user', content: 'exclusive root run' },
    ]);
    const active = await first.beginCreate({ contextStore });
    const second = createController(store);

    await expect(second.acquire('run-1')).rejects.toMatchObject({
      code: 'STATE_LEASE_UNAVAILABLE',
    });
    const firstFence = active.lease.fencingToken;
    const checkpoint = await first.checkpoint(
      { runId: 'run-1', contextStore, modelIteration: 1 },
      active.lease,
    );
    expect(checkpoint.record.fencingToken).toBe(firstFence);

    await active.lease.release();
    const replacement = await second.beginResume('run-1');
    expect(replacement.lease.fencingToken).not.toBe(firstFence);
    const takenOver = await second.checkpoint(
      { runId: 'run-1', contextStore: replacement.checkpoint.contextStore, modelIteration: 2 },
      replacement.lease,
    );
    expect(takenOver.record.fencingToken).toBe(replacement.lease.fencingToken);
    await replacement.lease.release();
  });

  acceptanceIt('RUN-02.l1.parent-child-cas', 'parent-child-cas', async () => {
    const store = new RecordingRuntimeStateStore();
    const taskLease = await store.acquireLease('subagent-session:owner-1', 10_000);
    const task = createStoredChildTask(taskLease.fencingToken);
    await createStoredTaskIdempotently(store, 'owner-1', taskLease, task);
    const taskLeaseKey = taskLease.key;
    await taskLease.release();

    const controller = createController(store);
    const contextStore = new ContextStore<TestProtocol>([
      { kind: 'user', content: 'parent plus child CAS' },
    ]);
    const active = await controller.beginCreate({ contextStore });
    expect(active.lease.key).not.toBe(taskLeaseKey);
    expect(controller.transactionDomainId).toBe(store.transactionDomainId);

    const forgedPrevious = { ...task, remainingMs: 1 } satisfies StoredTask;
    const forgedNext = {
      ...forgedPrevious,
      state: 'running',
      revision: 1,
      fencingToken: active.lease.fencingToken,
      activeStartedAt: 1_001,
      updatedAt: 1_001,
    } satisfies StoredTask;
    await expect(
      controller.commitWithTasks(
        { runId: 'run-1', contextStore, modelIteration: 1 },
        active.lease,
        [{ previous: forgedPrevious, next: forgedNext }],
      ),
    ).rejects.toMatchObject({
      descriptor: { causeCode: 'STATE_CAS_CONFLICT' },
    });
    expect((await store.loadRun('owner-1', 'run-1'))?.revision).toBe(0);
    expect((await store.loadTask('owner-1', 'task-1'))?.revision).toBe(0);

    const nextTask = {
      ...task,
      state: 'running',
      revision: 1,
      fencingToken: active.lease.fencingToken,
      activeStartedAt: 1_002,
      updatedAt: 1_002,
    } satisfies StoredTask;
    const committed = await controller.commitWithTasks(
      { runId: 'run-1', contextStore, modelIteration: 1 },
      active.lease,
      [{ previous: task, next: nextTask }],
    );

    expect(committed.record.revision).toBe(1);
    expect((await store.loadRun('owner-1', 'run-1'))?.revision).toBe(1);
    expect(await store.loadTask('owner-1', 'task-1')).toEqual(nextTask);
    await active.lease.release();
  });

  it('aborts the execution signal when renewal discovers a fencing takeover', async () => {
    vi.useFakeTimers();
    try {
      let leaseNow = 100;
      const store = new RecordingRuntimeStateStore({ now: () => leaseNow });
      const controller = createController(store);
      const contextStore = new ContextStore<TestProtocol>([
        { kind: 'user', content: 'lease loss' },
      ]);
      const active = await controller.beginCreate({ contextStore }, { leaseTtlMs: 30 });

      leaseNow = 131;
      const takeover = await store.acquireLease(active.lease.key, 30);
      await vi.advanceTimersByTimeAsync(10);

      expect(active.lease.signal.aborted).toBe(true);
      expect(active.lease.signal.reason).toMatchObject({
        code: 'RECOVERY_TARGET_LOST',
        descriptor: { causeCode: 'ROOT_EXECUTION_LEASE_LOST' },
      });
      await expect(
        controller.checkpoint({ runId: 'run-1', contextStore }, active.lease),
      ).rejects.toMatchObject({ code: 'RECOVERY_TARGET_LOST' });

      await takeover.release();
      await active.lease.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
