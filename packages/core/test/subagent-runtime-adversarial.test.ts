import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Deferred, RecordingRuntimeStateStore, acceptanceIt } from '../../../testkit';
import {
  appendSafeTaskEvents,
  canonicalJsonSha256,
  createSubAgentRuntime,
  defineSubAgent,
  SubAgentRuntimeError,
  transitionSubAgentTask,
  type ApprovalRequest,
  type ExecutorAvailabilityProbe,
  type ExecutorTaskHandle,
  type JsonValue,
  type StoredAgentRun,
  type StoredTask,
  type SubAgentDefinition,
  type SubAgentExecutionControl,
  type SubAgentExecutionOutcome,
  type SubAgentExecutionRequest,
  type SubAgentExecutor,
  type SubAgentExecutorBinding,
  type SubAgentExecutorDescriptor,
  type SubAgentTaskState,
} from '../src';

const SESSION_ID = 'runtime-adversarial-session';
const RUN_ID = 'runtime-adversarial-run';
const TASK_ID = 'runtime-adversarial-task';
const SUBAGENT_SESSION_ID = 'runtime-adversarial-child-session';

type ExecuteHandler = (
  request: SubAgentExecutionRequest,
  control: SubAgentExecutionControl,
) => Promise<SubAgentExecutionOutcome>;

type SpawnHandler = (
  request: SubAgentExecutionRequest,
  control: SubAgentExecutionControl,
) => Promise<ExecutorTaskHandle>;

const CAPABILITIES: SubAgentExecutorDescriptor['capabilities'] = {
  execute: true,
  spawn: true,
  cancel: true,
  events: true,
  approval: true,
  usage: 'provider',
  recovery: { resume: 'checkpoint', reconnect: 'external_binding' },
};

function createRun(overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  const now = Date.now();
  return {
    recordVersion: '1',
    ownerSessionId: SESSION_ID,
    runId: RUN_ID,
    status: 'running',
    revision: 0,
    fencingToken: '0',
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
      descendantsCreated: 0,
      activeExecutions: 0,
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    pendingApprovals: [],
    endRequested: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createDefinition(): SubAgentDefinition {
  return defineSubAgent({
    name: 'researcher',
    version: '2',
    description: 'Exercise adversarial Subagent Runtime boundaries.',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ answer: z.string() }),
  } as unknown as SubAgentDefinition);
}

function request(requestId = 'request-1') {
  return {
    runId: RUN_ID,
    requestId,
    subAgent: 'researcher',
    executor: 'local',
    input: { value: 'alpha' },
  };
}

function bindingForRequest(
  execution: SubAgentExecutionRequest,
  overrides: Partial<SubAgentExecutorBinding> = {},
): SubAgentExecutorBinding {
  return {
    executorName: 'local',
    ownerSessionId: execution.ownerSessionId,
    taskId: execution.taskId,
    subagentSessionId: execution.subagentSessionId,
    definitionName: execution.definition.name,
    definitionVersion: execution.definition.version,
    adapterStateVersion: '1',
    recoveryData: { placement: 'local' },
    ...overrides,
  };
}

function bindingForTask(
  task: Pick<StoredTask, 'taskId' | 'subagentSessionId' | 'definition'>,
  overrides: Partial<SubAgentExecutorBinding> = {},
): SubAgentExecutorBinding {
  return {
    executorName: 'local',
    ownerSessionId: SESSION_ID,
    taskId: task.taskId,
    subagentSessionId: task.subagentSessionId,
    definitionName: task.definition.name,
    definitionVersion: task.definition.version,
    adapterStateVersion: '1',
    recoveryData: { placement: 'local' },
    ...overrides,
  };
}

function candidateOutcome(
  execution: SubAgentExecutionRequest,
  output: JsonValue,
): SubAgentExecutionOutcome {
  return {
    type: 'terminal',
    result: {
      status: 'succeeded',
      task: { taskId: execution.taskId, subAgent: execution.definition },
      executor: 'local',
      output,
    },
  };
}

async function successfulExecution(
  execution: SubAgentExecutionRequest,
  control: SubAgentExecutionControl,
): Promise<SubAgentExecutionOutcome> {
  await control.commitBinding(bindingForRequest(execution));
  const output = { answer: 'proof' };
  await control.completion.submitResult('result-call', output);
  await control.completion.complete('end-call', { isStandalone: true });
  return candidateOutcome(execution, output);
}

class AdversarialExecutor implements SubAgentExecutor {
  readonly descriptor: SubAgentExecutorDescriptor;
  readonly bindingCodec = {
    adapterStateVersion: '1',
    encode: (state: JsonValue): JsonValue => state,
    decode: (value: JsonValue): JsonValue => value,
  };
  readonly executeCalls: SubAgentExecutionRequest[] = [];
  readonly spawnCalls: SubAgentExecutionRequest[] = [];

  constructor(
    readonly executeHandler: ExecuteHandler = successfulExecution,
    readonly spawnHandler: SpawnHandler = async () => {
      throw new SubAgentRuntimeError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'The scripted Executor has no spawn handler.',
        retryable: false,
      });
    },
    capabilities: SubAgentExecutorDescriptor['capabilities'] = CAPABILITIES,
  ) {
    this.descriptor = {
      name: 'local',
      description: 'Adversarial Runtime test placement.',
      useCases: ['Exercise deterministic hostile execution timing.'],
      capabilities,
      adapterStateVersion: '1',
    };
  }

  getAvailability(): ExecutorAvailabilityProbe {
    return { status: 'available' };
  }

  supports(): boolean {
    return true;
  }

  async execute(
    execution: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<SubAgentExecutionOutcome> {
    this.executeCalls.push(execution);
    return this.executeHandler(execution, control);
  }

  async spawn(
    execution: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<ExecutorTaskHandle> {
    this.spawnCalls.push(execution);
    return this.spawnHandler(execution, control);
  }
}

async function createFixture(
  executor: AdversarialExecutor,
  options: {
    readonly store?: RecordingRuntimeStateStore;
    readonly createRun?: boolean;
  } = {},
) {
  const store = options.store ?? new RecordingRuntimeStateStore();
  if (options.createRun !== false) await store.createRun(createRun());
  const runtime = createSubAgentRuntime({
    sessionId: SESSION_ID,
    activeDefinitions: [createDefinition()],
    executors: [executor],
    stateStore: store,
  });
  await runtime.init();
  return { runtime, store };
}

async function runtimeCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    const value = await promise;
    if (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      value.type === 'terminal' &&
      'result' in value
    ) {
      const result = value.result as { error?: { code?: string } };
      return result.error?.code;
    }
    return undefined;
  } catch (error) {
    if (error instanceof SubAgentRuntimeError) return error.code;
    throw error;
  }
}

async function createPausedFixture() {
  const executor = new AdversarialExecutor(async (execution, control) => {
    if (execution.operation.type !== 'create') {
      throw new Error('An incomplete approval decision must not reach the Executor.');
    }
    await control.commitBinding(bindingForRequest(execution));
    const directive = await control.authorizeTool({
      callId: 'approval-call-1',
      toolName: 'dangerous-tool',
      summary: 'Approve the first guarded operation.',
    });
    if (directive.type !== 'suspend') throw new Error('expected an approval suspension');
    return {
      type: 'paused',
      reason: 'approval',
      task: { taskId: execution.taskId, subAgent: execution.definition },
      approvals: [directive.request],
      checkpointRevision: directive.checkpointRevision,
    };
  });
  const fixture = await createFixture(executor);
  const paused = await fixture.runtime.execute(request());
  if (paused.type !== 'paused') throw new Error('expected a paused task');
  return { ...fixture, executor, paused };
}

async function appendSecondApproval(
  store: RecordingRuntimeStateStore,
  taskId: string,
): Promise<ApprovalRequest> {
  const lease = await store.acquireLease(`subagent-session:${SESSION_ID}`, 30_000);
  try {
    return await store.transaction(SESSION_ID, lease, async (transaction) => {
      const task = await transaction.loadTask(taskId);
      if (task === undefined) throw new Error('missing approval task');
      const approval: ApprovalRequest = {
        approvalId: 'approval-2',
        ownerSessionId: SESSION_ID,
        taskId,
        callId: 'approval-call-2',
        toolName: 'second-dangerous-tool',
        summary: 'Approve the second guarded operation.',
        createdAt: task.updatedAt,
        revision: task.revision + 1,
      };
      const next: StoredTask = {
        ...task,
        revision: task.revision + 1,
        fencingToken: lease.fencingToken,
        approvals: [...task.approvals, approval],
      };
      const committed = await transaction.compareAndSetTask(
        task.taskId,
        task.revision,
        lease.fencingToken,
        next,
      );
      if (!committed) throw new Error('failed to append the second approval');
      return approval;
    });
  } finally {
    await lease.release();
  }
}

async function seedCrashWindowTask(
  store: RecordingRuntimeStateStore,
  state: Extract<SubAgentTaskState, 'queued' | 'running'>,
  includeBinding = false,
): Promise<StoredTask> {
  const lease = await store.acquireLease(`subagent-session:${SESSION_ID}`, 30_000);
  try {
    return await store.transaction(SESSION_ID, lease, async (transaction) => {
      const now = Date.now();
      const initial: StoredTask = {
        recordVersion: '1',
        ownerSessionId: SESSION_ID,
        runId: RUN_ID,
        taskId: TASK_ID,
        subagentSessionId: SUBAGENT_SESSION_ID,
        requestId: 'request-1',
        idempotencyKey: 'request-1',
        definition: { name: 'researcher', version: '2' },
        executor: 'local',
        input: { value: 'alpha' },
        inputHash: canonicalJsonSha256({ value: 'alpha' }),
        projectedContext: [],
        state: 'queued',
        revision: 0,
        fencingToken: lease.fencingToken,
        path: [TASK_ID],
        depth: 1,
        attempt: 1,
        approvals: [],
        approvalDecisions: [],
        recoveryRequired: false,
        activeElapsedMs: 0,
        remainingMs: 120_000,
        eventSequence: 0,
        createdAt: now,
        updatedAt: now,
      };
      const created = await transaction.createTask(initial);
      if (created.status !== 'created') throw new Error('failed to seed task');

      const queued = appendSafeTaskEvents(
        initial,
        [{ type: 'task.queued', timestamp: now, data: { status: 'queued' } }],
        { eventIds: ['seed-event-queued'], defaultTimestamp: now },
      );
      let current = { ...queued.task, fencingToken: lease.fencingToken } as StoredTask;
      if (
        !(await transaction.compareAndSetTask(
          initial.taskId,
          initial.revision,
          lease.fencingToken,
          current,
        ))
      ) {
        throw new Error('failed to seed queued task');
      }
      await transaction.appendEvents(initial.taskId, queued.events);

      if (state === 'running') {
        const startedAt = now;
        const running = transitionSubAgentTask(current, 'running', { now: startedAt });
        const started = appendSafeTaskEvents(
          { ...running, fencingToken: lease.fencingToken } as StoredTask,
          [{ type: 'task.started', timestamp: startedAt, data: { status: 'running' } }],
          {
            eventIds: ['seed-event-started'],
            defaultTimestamp: startedAt,
            revisionMode: 'preserve',
          },
        );
        if (
          !(await transaction.compareAndSetTask(
            current.taskId,
            current.revision,
            lease.fencingToken,
            started.task,
          ))
        ) {
          throw new Error('failed to seed running task');
        }
        await transaction.appendEvents(current.taskId, started.events);
        current = started.task;
      }

      if (includeBinding) {
        const next: StoredTask = {
          ...current,
          revision: current.revision + 1,
          fencingToken: lease.fencingToken,
          binding: bindingForTask(current),
          updatedAt: current.updatedAt,
        };
        if (
          !(await transaction.compareAndSetTask(
            current.taskId,
            current.revision,
            lease.fencingToken,
            next,
          ))
        ) {
          throw new Error('failed to seed task binding');
        }
        current = next;
      }
      return current;
    });
  } finally {
    await lease.release();
  }
}

describe('SubAgentRuntime adversarial Oracles', () => {
  acceptanceIt('REC-01.l1.attempt-fencing', 'attempt-fencing', async () => {
    let oldControl: SubAgentExecutionControl | undefined;
    const resumed = new Deferred<void>();
    const releaseResume = new Deferred<void>();
    const executor = new AdversarialExecutor(async (execution, control) => {
      if (execution.operation.type === 'create') {
        oldControl = control;
        await control.commitBinding(bindingForRequest(execution));
        const directive = await control.authorizeTool({
          callId: 'guarded-call',
          toolName: 'guarded-tool',
          summary: 'Pause before the guarded operation.',
        });
        if (directive.type !== 'suspend') throw new Error('expected approval suspension');
        return {
          type: 'paused',
          reason: 'approval',
          task: { taskId: execution.taskId, subAgent: execution.definition },
          approvals: [directive.request],
          checkpointRevision: directive.checkpointRevision,
        };
      }

      resumed.resolve();
      await releaseResume.promise;
      const output = { answer: 'new-attempt' };
      await control.completion.submitResult('new-result', output);
      await control.completion.complete('new-end', { isStandalone: true });
      return candidateOutcome(execution, output);
    });
    const { runtime } = await createFixture(executor);
    const paused = await runtime.execute(request());
    if (paused.type !== 'paused') throw new Error('expected paused outcome');
    const approval = paused.approvals[0]!;
    const resumePromise = runtime.resume(SESSION_ID, paused.task.taskId, {
      decisions: [
        {
          approvalId: approval.approvalId,
          decision: 'approved',
          expectedRevision: approval.revision,
        },
      ],
    });
    await resumed.promise;

    try {
      await expect(
        oldControl!.completion.submitResult('late-old-result', { answer: 'stale-attempt' }),
      ).rejects.toMatchObject({ code: 'RECOVERY_TARGET_LOST' });
    } finally {
      releaseResume.resolve();
      await resumePromise.catch(() => undefined);
    }
  });

  it('rejects terminal resume and terminal reconnect without external reconnect capability', async () => {
    const capabilities: SubAgentExecutorDescriptor['capabilities'] = {
      ...CAPABILITIES,
      recovery: { resume: 'checkpoint', reconnect: 'none' },
    };
    const executor = new AdversarialExecutor(successfulExecution, undefined, capabilities);
    const { runtime, store } = await createFixture(executor);
    await runtime.execute(request());
    const taskId = store.snapshot(SESSION_ID).tasks[0]!.taskId;

    expect
      .soft(await runtimeCode(runtime.resume(SESSION_ID, taskId, {})))
      .toBe('INVALID_STATE_TRANSITION');
    expect
      .soft(
        await runtimeCode(runtime.reconnect(SESSION_ID, taskId).then((handle) => handle.wait())),
      )
      .toBe('INVALID_STATE_TRANSITION');
  });

  it('does not commit anything when approval decisions are missing', async () => {
    const { runtime, store, paused } = await createPausedFixture();
    const before = store.snapshot(SESSION_ID).tasks[0]!;
    const code = await runtimeCode(runtime.resume(SESSION_ID, paused.task.taskId, {}));
    const after = store.snapshot(SESSION_ID).tasks[0]!;

    expect.soft(code).toBe('APPROVAL_REQUIRED');
    expect({
      revision: after.revision,
      approvals: after.approvals,
      approvalDecisions: after.approvalDecisions,
    }).toEqual({
      revision: before.revision,
      approvals: before.approvals,
      approvalDecisions: before.approvalDecisions,
    });
  });

  it('atomically rejects a partial approval decision set without committing the subset', async () => {
    const { runtime, store, paused } = await createPausedFixture();
    await appendSecondApproval(store, paused.task.taskId);
    const before = store.snapshot(SESSION_ID).tasks[0]!;
    const first = before.approvals[0]!;
    const code = await runtimeCode(
      runtime.resume(SESSION_ID, paused.task.taskId, {
        decisions: [
          {
            approvalId: first.approvalId,
            decision: 'approved',
            expectedRevision: first.revision,
          },
        ],
      }),
    );
    const after = store.snapshot(SESSION_ID).tasks[0]!;

    expect.soft(code).toBe('APPROVAL_REQUIRED');
    expect({
      revision: after.revision,
      approvals: after.approvals,
      approvalDecisions: after.approvalDecisions,
    }).toEqual({
      revision: before.revision,
      approvals: before.approvals,
      approvalDecisions: before.approvalDecisions,
    });
  });

  acceptanceIt('ERR-01.l1.outcome-unknown', 'outcome-unknown', async () => {
    const executor = new AdversarialExecutor(async () => {
      throw new SubAgentRuntimeError({
        code: 'INTERNAL_ERROR',
        message: 'A provider request may or may not have completed.',
        retryable: false,
        outcomeUnknown: true,
      });
    });
    const { runtime, store } = await createFixture(executor);

    await expect(runtime.execute(request())).resolves.toMatchObject({
      type: 'terminal',
      result: {
        status: 'failed',
        error: { code: 'EXECUTOR_FAILED', outcomeUnknown: true },
      },
    });
    const task = store.snapshot(SESSION_ID).tasks[0]!;
    expect(task).toMatchObject({
      state: 'failed',
      error: { code: 'EXECUTOR_FAILED', outcomeUnknown: true },
    });
  });

  it.each(['queued', 'running'] as const)(
    'replays a crash-window %s unbound task without creating a replacement task',
    async (state) => {
      const store = new RecordingRuntimeStateStore();
      await store.createRun(
        createRun({
          budget: {
            descendantsCreated: 1,
            activeExecutions: state === 'running' ? 1 : 0,
            providerCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
          },
        }),
      );
      const seeded = await seedCrashWindowTask(store, state);
      const executor = new AdversarialExecutor();
      const { runtime } = await createFixture(executor, { store, createRun: false });

      await expect(runtime.execute(request())).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'succeeded', task: { taskId: seeded.taskId } },
      });
      expect(store.snapshot(SESSION_ID).tasks).toHaveLength(1);
      expect(executor.executeCalls).toHaveLength(1);
      expect(executor.executeCalls[0]).toMatchObject({
        taskId: seeded.taskId,
        operation: { type: 'create', idempotencyKey: seeded.idempotencyKey },
      });
    },
  );

  it('rejects a recovered raw handle whose binding does not match the persisted task', async () => {
    const store = new RecordingRuntimeStateStore();
    await store.createRun(
      createRun({
        budget: {
          descendantsCreated: 1,
          activeExecutions: 1,
          providerCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      }),
    );
    const seeded = await seedCrashWindowTask(store, 'running', true);
    const executor = new AdversarialExecutor(successfulExecution, async (execution) => {
      const mismatched = bindingForRequest(execution, {
        subagentSessionId: 'wrong-subagent-session',
      });
      return {
        taskId: execution.taskId,
        binding: mismatched,
        snapshot: async () => ({
          taskId: execution.taskId,
          state: 'running',
          binding: mismatched,
          updatedAt: Date.now(),
        }),
        wait: async () => {
          throw new Error('A mismatched recovered binding must be rejected before wait().');
        },
        cancel: async () => undefined,
        events: async function* () {
          yield* [];
        },
      };
    });
    const { runtime } = await createFixture(executor, { store, createRun: false });

    const code = await runtimeCode(
      runtime.reconnect(SESSION_ID, seeded.taskId).then((handle) => handle.wait()),
    );
    expect(code).toBe('BINDING_INVALID');
  });
});
