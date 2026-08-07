import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Deferred, ManualClock, RecordingRuntimeStateStore, acceptanceIt } from '../../../testkit';
import {
  appendSafeTaskEvents,
  canonicalJsonSha256,
  createSubAgentRuntime,
  DEFAULT_SUBAGENT_LIMITS,
  defineSubAgent,
  StateLeaseUnavailableError,
  SubAgentRuntimeError,
  submitSubAgentResult,
  transitionSubAgentTask,
  type ApprovalRequest,
  type AgentRuntimeStateTransaction,
  type ExecutorAvailabilityProbe,
  type ExecutorTaskHandle,
  type JsonValue,
  type StateLease,
  type StoredAgentRun,
  type StoredTask,
  type SubAgentDefinition,
  type SubAgentExecutionControl,
  type SubAgentExecutionOutcome,
  type SubAgentExecutionRequest,
  type SubAgentExecutor,
  type SubAgentExecutorBinding,
  type SubAgentExecutorDescriptor,
  type SubAgentExecutorOperationResult,
  type SubAgentExecutorRecoveryRequired,
  type SubAgentTaskState,
} from '../src';

const SESSION_ID = 'runtime-adversarial-session';
const RUN_ID = 'runtime-adversarial-run';
const TASK_ID = 'runtime-adversarial-task';
const SUBAGENT_SESSION_ID = 'runtime-adversarial-child-session';

type ExecuteHandler = (
  request: SubAgentExecutionRequest,
  control: SubAgentExecutionControl,
) => Promise<SubAgentExecutorOperationResult>;

type SpawnHandler = (
  request: SubAgentExecutionRequest,
  control: SubAgentExecutionControl,
) => Promise<ExecutorTaskHandle | SubAgentExecutorRecoveryRequired>;

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
    configurationHash: '0'.repeat(64),
    limits: DEFAULT_SUBAGENT_LIMITS,
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
    version: '1',
    executorName: 'local',
    ownerSessionId: execution.ownerSessionId,
    taskId: execution.taskId,
    subagentSessionId: execution.subagentSessionId,
    definitionName: execution.definition.name,
    definitionVersion: execution.definition.version,
    runnerId: 'test-runner',
    runnerVersion: '1',
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
    version: '1',
    executorName: 'local',
    ownerSessionId: SESSION_ID,
    taskId: task.taskId,
    subagentSessionId: task.subagentSessionId,
    definitionName: task.definition.name,
    definitionVersion: task.definition.version,
    runnerId: 'test-runner',
    runnerVersion: '1',
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

function recoveryMarker(
  execution: SubAgentExecutionRequest,
  reason: SubAgentExecutorRecoveryRequired['reason'],
  causeCode = 'EXECUTOR_PROCESS_LOST',
): SubAgentExecutorRecoveryRequired {
  return {
    type: 'recovery_required',
    reason,
    operationId: execution.operation.operationId,
    causeCode,
  };
}

function childCheckpoint() {
  return {
    version: '1' as const,
    runnerId: 'test-runner',
    runnerVersion: '1',
    protocolContext: { protocol: 'openai-chat', codecVersion: '1', value: [] },
    contextStore: {
      version: '1' as const,
      protocol: 'openai-chat',
      codecVersion: '1',
      revision: 0,
      rawHistory: [],
      activeSpans: [],
      nextRawItemId: 1,
      nextSpanId: 1,
      nextEntryId: 1,
    },
    modelIteration: 1,
    maxIterations: 10,
  };
}

function appliedPendingCheckpoint() {
  const input = { query: 'durable-rich-checkpoint' } as const;
  return {
    ...childCheckpoint(),
    pendingBatch: {
      version: '1' as const,
      batchId: 'marker-pending-batch',
      assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
      calls: [
        {
          version: '1' as const,
          operationId: 'marker-tool-operation',
          kind: 'tool' as const,
          callId: 'marker-tool-call',
          name: 'lookup',
          input,
          inputHash: canonicalJsonSha256(input),
          status: 'applied' as const,
          order: 0,
          result: { proof: 'applied-sibling' },
        },
      ],
      endRequested: false,
      createdAt: 1_002,
    },
  };
}

function childModelCheckpoint(phase: 'prepared' | 'in_flight' | 'result_ready') {
  const updatedAt = phase === 'prepared' ? 1_001 : phase === 'in_flight' ? 1_002 : 1_003;
  return {
    ...childCheckpoint(),
    modelOperation: {
      version: '1' as const,
      operationId: 'adversarial-provider-operation',
      iteration: 1,
      purpose: 'agent' as const,
      requestAttempt: 1,
      requestHash: 'a'.repeat(64),
      phase,
      ...(phase === 'result_ready'
        ? {
            result: {
              protocol: 'openai-chat',
              codecVersion: '1',
              value: [],
            },
          }
        : {}),
      preparedAt: 1_001,
      updatedAt,
    },
  };
}

function rawExecutorHandle(
  execution: SubAgentExecutionRequest,
  binding: SubAgentExecutorBinding,
  wait: ExecutorTaskHandle['wait'],
): ExecutorTaskHandle {
  return {
    taskId: execution.taskId,
    binding,
    snapshot: async () => ({
      taskId: execution.taskId,
      state: 'running',
      binding,
      updatedAt: Date.now(),
    }),
    wait,
    cancel: async () => undefined,
    events: async function* () {
      yield* [];
    },
  };
}

function approvalCheckpoint(callId: string, toolName: string) {
  const input = {};
  return {
    ...childCheckpoint(),
    pendingBatch: {
      version: '1' as const,
      batchId: `approval-batch-${callId}`,
      assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
      calls: [
        {
          version: '1' as const,
          operationId: `approval-operation-${callId}`,
          kind: 'tool' as const,
          callId,
          name: toolName,
          input,
          inputHash: canonicalJsonSha256(input),
          status: 'in_flight' as const,
          order: 0,
        },
      ],
      endRequested: false,
      createdAt: 1_001,
    },
  };
}

async function successfulExecution(
  execution: SubAgentExecutionRequest,
  control: SubAgentExecutionControl,
): Promise<SubAgentExecutionOutcome> {
  await control.commitBinding('success-binding', bindingForRequest(execution));
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
  availability: ExecutorAvailabilityProbe = { status: 'available' };

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
      runtimeProtocolVersion: '1',
      taskRecordVersions: ['1'],
      childCheckpointVersions: ['1'],
      runnerCompatibility: [
        { runnerId: 'test-runner', runnerVersion: '1', childCheckpointVersions: ['1'] },
      ],
      name: 'local',
      description: 'Adversarial Runtime test placement.',
      useCases: ['Exercise deterministic hostile execution timing.'],
      capabilities,
      adapterStateVersion: '1',
      maxBindingBytes: 64 * 1024,
      maxEventPageSize: 256,
    };
  }

  getAvailability(): ExecutorAvailabilityProbe {
    return this.availability;
  }

  supports(): boolean {
    return true;
  }

  async execute(
    execution: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<SubAgentExecutorOperationResult> {
    this.executeCalls.push(execution);
    return this.executeHandler(execution, control);
  }

  async spawn(
    execution: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<ExecutorTaskHandle | SubAgentExecutorRecoveryRequired> {
    this.spawnCalls.push(execution);
    return this.spawnHandler(execution, control);
  }

  async cancel(): Promise<void> {}
}

class RecoveryBarrierStateStore extends RecordingRuntimeStateStore {
  readonly taskLeaseRequested = new Deferred<void>();
  readonly releaseHeldTaskLease = new Deferred<void>();
  readonly recoveryLoadEntered = new Deferred<void>();
  readonly releaseRecoveryLoad = new Deferred<void>();
  blockedTaskLeaseKey: string | undefined;
  heldTaskLeaseKey: string | undefined;
  blockedRecoveryLoadTaskId: string | undefined;

  override async acquireLease(key: string, ttlMs: number): Promise<StateLease> {
    if (key === this.heldTaskLeaseKey) {
      this.taskLeaseRequested.resolve(undefined);
      await this.releaseHeldTaskLease.promise;
      return super.acquireLease(key, ttlMs);
    }
    if (key === this.blockedTaskLeaseKey) {
      this.taskLeaseRequested.resolve(undefined);
      throw new StateLeaseUnavailableError(key);
    }
    return super.acquireLease(key, ttlMs);
  }

  override async loadTask(ownerSessionId: string, taskId: string): Promise<StoredTask | undefined> {
    const task = await super.loadTask(ownerSessionId, taskId);
    if (taskId === this.blockedRecoveryLoadTaskId && task?.recoveryRequired === true) {
      this.recoveryLoadEntered.resolve(undefined);
      await this.releaseRecoveryLoad.promise;
    }
    return task;
  }
}

class FirstExecutionRenewalLossStateStore extends RecordingRuntimeStateStore {
  readonly renewalFailed = new Deferred<void>();
  readonly postResultLoadEntered = new Deferred<void>();
  readonly releasePostResultLoad = new Deferred<void>();
  #failNextTaskRenewal = true;
  #blockedPostResultTaskId: string | undefined;

  blockNextPostResultLoad(taskId: string): void {
    this.#blockedPostResultTaskId = taskId;
  }

  override async loadTask(ownerSessionId: string, taskId: string): Promise<StoredTask | undefined> {
    const task = await super.loadTask(ownerSessionId, taskId);
    if (taskId === this.#blockedPostResultTaskId) {
      this.#blockedPostResultTaskId = undefined;
      this.postResultLoadEntered.resolve(undefined);
      await this.releasePostResultLoad.promise;
    }
    return task;
  }

  override async renewLease(
    lease: Parameters<RecordingRuntimeStateStore['renewLease']>[0],
    ttlMs: number,
  ): Promise<StateLease> {
    if (this.#failNextTaskRenewal && lease.key.startsWith(`subagent-task:${SESSION_ID}:`)) {
      this.#failNextTaskRenewal = false;
      this.renewalFailed.resolve(undefined);
      throw new Error('deterministic task execution lease renewal loss');
    }
    return super.renewLease(lease, ttlMs);
  }
}

class OwnershipCommitRenewalLossStateStore extends FirstExecutionRenewalLossStateStore {
  readonly ownershipCommitEntered = new Deferred<void>();
  readonly releaseOwnershipCommit = new Deferred<void>();
  #blockNextTaskLeaseCommit = true;

  override async transaction<T>(
    ownerSessionId: string,
    lease: StateLease,
    work: (transaction: AgentRuntimeStateTransaction) => Promise<T>,
  ): Promise<T> {
    const result = await super.transaction(ownerSessionId, lease, work);
    if (this.#blockNextTaskLeaseCommit && lease.key.startsWith(`subagent-task:${SESSION_ID}:`)) {
      this.#blockNextTaskLeaseCommit = false;
      this.ownershipCommitEntered.resolve(undefined);
      await this.releaseOwnershipCommit.promise;
    }
    return result;
  }
}

class ArmedAdoptionRenewalLossStateStore extends RecordingRuntimeStateStore {
  readonly adoptionCommitEntered = new Deferred<void>();
  readonly renewalFailed = new Deferred<void>();
  readonly releaseAdoptionCommit = new Deferred<void>();
  #armed = false;
  #blockNextTaskLeaseCommit = true;
  #failNextTaskRenewal = true;

  arm(): void {
    this.#armed = true;
  }

  override async transaction<T>(
    ownerSessionId: string,
    lease: StateLease,
    work: (transaction: AgentRuntimeStateTransaction) => Promise<T>,
  ): Promise<T> {
    const result = await super.transaction(ownerSessionId, lease, work);
    if (
      this.#armed &&
      this.#blockNextTaskLeaseCommit &&
      lease.key.startsWith(`subagent-task:${SESSION_ID}:`)
    ) {
      this.#blockNextTaskLeaseCommit = false;
      this.adoptionCommitEntered.resolve(undefined);
      await this.releaseAdoptionCommit.promise;
    }
    return result;
  }

  override async renewLease(
    lease: Parameters<RecordingRuntimeStateStore['renewLease']>[0],
    ttlMs: number,
  ): Promise<StateLease> {
    if (
      this.#armed &&
      this.#failNextTaskRenewal &&
      lease.key.startsWith(`subagent-task:${SESSION_ID}:`)
    ) {
      this.#failNextTaskRenewal = false;
      this.renewalFailed.resolve(undefined);
      throw new Error('deterministic adoption lease renewal loss');
    }
    return super.renewLease(lease, ttlMs);
  }
}

async function createFixture(
  executor: AdversarialExecutor,
  options: {
    readonly store?: RecordingRuntimeStateStore;
    readonly createRun?: boolean;
    readonly limits?: { readonly maxConcurrent?: number; readonly timeoutMs?: number };
    readonly executionLeaseTtlMs?: number;
  } = {},
) {
  const store = options.store ?? new RecordingRuntimeStateStore();
  const limits = {
    ...DEFAULT_SUBAGENT_LIMITS,
    ...options.limits,
  };
  if (options.createRun !== false) await store.createRun(createRun({ limits }));
  const runtime = createSubAgentRuntime({
    sessionId: SESSION_ID,
    activeDefinitions: [createDefinition()],
    executors: [executor],
    stateStore: store,
    limits,
    ...(options.executionLeaseTtlMs === undefined
      ? {}
      : { executionLeaseTtlMs: options.executionLeaseTtlMs }),
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
    await control.commitBinding('paused-binding', bindingForRequest(execution));
    const directive = await control.authorizeTool(
      'paused-approval',
      {
        callId: 'approval-call-1',
        toolName: 'dangerous-tool',
        summary: 'Approve the first guarded operation.',
      },
      approvalCheckpoint('approval-call-1', 'dangerous-tool'),
    );
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
        limits: DEFAULT_SUBAGENT_LIMITS,
        state: 'queued',
        revision: 0,
        fencingToken: lease.fencingToken,
        path: [TASK_ID],
        depth: 1,
        attempt: 1,
        approvals: [],
        approvalDecisions: [],
        controlOperations: [],
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

async function seedResultSubmittedCrashTask(
  store: RecordingRuntimeStateStore,
): Promise<StoredTask> {
  const running = await seedCrashWindowTask(store, 'running', true);
  const lease = await store.acquireLease(`subagent-session:${SESSION_ID}`, 30_000);
  try {
    return await store.transaction(SESSION_ID, lease, async (transaction) => {
      const current = await transaction.loadTask(running.taskId);
      if (current === undefined) throw new Error('missing crash-window task');
      const output = { answer: 'result-cas-crash-proof' };
      const submitted = submitSubAgentResult(
        {
          ...current,
          childCheckpoint: childCheckpoint(),
          recoveryRequired: true,
        },
        {
          callId: 'result-cas-call',
          receiptId: 'result-cas-receipt',
          submittedAt: current.updatedAt,
          output,
        },
      );
      const next = { ...submitted.task, fencingToken: lease.fencingToken } as StoredTask;
      if (
        !(await transaction.compareAndSetTask(
          current.taskId,
          current.revision,
          lease.fencingToken,
          next,
        ))
      ) {
        throw new Error('failed to seed result-submitted crash window');
      }
      return next;
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
        await control.commitBinding('fencing-binding', bindingForRequest(execution));
        const directive = await control.authorizeTool(
          'fencing-approval',
          {
            callId: 'guarded-call',
            toolName: 'guarded-tool',
            summary: 'Pause before the guarded operation.',
          },
          approvalCheckpoint('guarded-call', 'guarded-tool'),
        );
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
      .toBe('UNSUPPORTED_CAPABILITY');
  });

  acceptanceIt('REC-05.l1.external-terminal-reconnect', 'external-binding-terminal', async () => {
    const executor = new AdversarialExecutor();
    const { runtime, store } = await createFixture(executor);
    const original = await runtime.execute(request());
    const before = store.snapshot(SESSION_ID);
    const taskId = before.tasks[0]!.taskId;

    const handle = await runtime.reconnect(SESSION_ID, taskId);

    await expect(handle.wait()).resolves.toEqual(original);
    await expect(handle.snapshot()).resolves.toMatchObject({
      taskId,
      state: 'succeeded',
    });
    expect(executor.spawnCalls).toHaveLength(0);
    expect(store.snapshot(SESSION_ID)).toEqual(before);
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

  acceptanceIt('RES-09.l1.result-then-failure-partial', 'authoritative-partial', async () => {
    const secretSentinel = 'provider-body-secret-must-not-persist';
    const executor = new AdversarialExecutor(async (execution, control) => {
      await control.commitBinding('failure-binding', bindingForRequest(execution));
      const partialOutput = { answer: 'durable-partial-proof' };
      await control.completion.submitResult('failure-result', partialOutput);
      const failure = {
        status: 'failed' as const,
        error: {
          code: 'EXECUTOR_FAILED' as const,
          message: secretSentinel,
          retryable: false,
          causeCode: secretSentinel,
        },
      };

      const accepted = await control.completion.fail('failure-terminal', failure);
      const replayed = await control.completion.fail('failure-terminal', failure);
      expect(replayed).toEqual(accepted);
      await expect(
        control.completion.fail('failure-terminal', {
          status: 'cancelled',
          error: { code: 'CANCELLED', message: 'Conflicting replay.', retryable: false },
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      // A raw Executor success candidate must never override the authoritative failure CAS.
      return candidateOutcome(execution, { answer: 'untrusted-raw-success' });
    });
    const { runtime, store } = await createFixture(executor);

    await expect(runtime.execute(request())).resolves.toMatchObject({
      type: 'terminal',
      result: {
        status: 'failed',
        partialOutput: { answer: 'durable-partial-proof' },
        error: {
          code: 'EXECUTOR_FAILED',
          message: 'The subagent execution failed.',
        },
      },
    });
    const task = store.snapshot(SESSION_ID).tasks[0]!;
    expect(task).toMatchObject({
      state: 'failed',
      partialOutput: { answer: 'durable-partial-proof' },
      result: {
        status: 'failed',
        partialOutput: { answer: 'durable-partial-proof' },
      },
    });
    expect(task).not.toHaveProperty('output');
    expect(task.controlOperations.filter(({ kind }) => kind === 'failure')).toHaveLength(1);
    expect(JSON.stringify(store.snapshot(SESSION_ID))).not.toContain(secretSentinel);
  });

  it('accepts an exact receipt-backed partial output for an authoritative control terminal', async () => {
    const executor = new AdversarialExecutor(async (execution, control) => {
      await control.commitBinding('timeout-binding', bindingForRequest(execution));
      await control.completion.submitResult('timeout-result', {
        answer: 'timeout-partial-proof',
      });
      await control.completion.fail('timeout-terminal', {
        status: 'timed_out',
        error: { code: 'TIMED_OUT', message: 'The trusted runner timed out.', retryable: false },
        partialOutput: { answer: 'timeout-partial-proof' },
      });
      return candidateOutcome(execution, { answer: 'untrusted-raw-success' });
    });
    const { runtime } = await createFixture(executor);

    await expect(runtime.execute(request())).resolves.toMatchObject({
      type: 'terminal',
      result: {
        status: 'timed_out',
        partialOutput: { answer: 'timeout-partial-proof' },
        error: { code: 'TIMED_OUT' },
      },
    });
  });

  it('keeps a task recoverable when the stale owner loses its execution lease renewal', async () => {
    const store = new FirstExecutionRenewalLossStateStore();
    const firstExecutionEntered = new Deferred<void>();
    let executeCount = 0;
    const executor = new AdversarialExecutor(async (execution, control) => {
      executeCount += 1;
      if (executeCount === 1) {
        firstExecutionEntered.resolve(undefined);
        return new Promise<SubAgentExecutorOperationResult>((_resolve, reject) => {
          const rejectForAbort = (): void => reject(execution.signal.reason);
          if (execution.signal.aborted) rejectForAbort();
          else execution.signal.addEventListener('abort', rejectForAbort, { once: true });
        });
      }
      return successfulExecution(execution, control);
    });
    const first = await createFixture(executor, {
      store,
      executionLeaseTtlMs: 30,
    });
    const stalePromise = first.runtime.execute(request());
    stalePromise.catch(() => undefined);
    await firstExecutionEntered.promise;

    await store.renewalFailed.promise;
    await expect(stalePromise).rejects.toMatchObject({
      code: 'RECOVERY_TARGET_LOST',
      descriptor: { causeCode: 'EXECUTION_LEASE_LOST' },
    });

    const orphaned = store.snapshot(SESSION_ID);
    const staleTask = orphaned.tasks[0]!;
    expect(staleTask).toMatchObject({
      state: 'running',
      attempt: 1,
      recoveryRequired: false,
      executorOperation: { status: 'dispatched', attempt: 1 },
    });
    expect(staleTask).not.toHaveProperty('result');
    expect(staleTask).not.toHaveProperty('terminalAt');
    expect(orphaned.runs[0]!.budget.activeExecutions).toBe(1);
    expect(orphaned.events.filter(({ type }) => type === 'task.failed')).toHaveLength(0);

    const replacement = await createFixture(executor, {
      store,
      createRun: false,
      executionLeaseTtlMs: 30,
    });
    await expect(replacement.runtime.execute(request())).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'proof' } },
    });

    const recovered = store.snapshot(SESSION_ID);
    expect(recovered.tasks).toHaveLength(1);
    expect(recovered.tasks[0]).toMatchObject({
      taskId: staleTask.taskId,
      state: 'succeeded',
      attempt: 2,
    });
    expect(recovered.tasks[0]!.executionEpoch).not.toBe(staleTask.executionEpoch);
    expect(recovered.tasks[0]!.executionFencingToken).not.toBe(staleTask.executionFencingToken);
    expect(recovered.runs[0]).toMatchObject({
      budget: { descendantsCreated: 1, activeExecutions: 0 },
    });
    expect(recovered.events.filter(({ type }) => type === 'task.failed')).toHaveLength(0);
    expect(recovered.events.filter(({ type }) => type === 'task.succeeded')).toHaveLength(1);
    expect(executor.executeCalls.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(executor.executeCalls[1]!.operation.operationId).toBe(
      executor.executeCalls[0]!.operation.operationId,
    );
  });

  it('does not dispatch after ownership proof is lost behind a successful claim commit', async () => {
    const store = new OwnershipCommitRenewalLossStateStore();
    const executor = new AdversarialExecutor();
    const first = await createFixture(executor, {
      store,
      executionLeaseTtlMs: 30,
    });
    const stalePromise = first.runtime.execute(request());
    stalePromise.catch(() => undefined);

    await store.ownershipCommitEntered.promise;
    await store.renewalFailed.promise;
    store.releaseOwnershipCommit.resolve(undefined);
    await expect(stalePromise).rejects.toMatchObject({
      code: 'RECOVERY_TARGET_LOST',
      descriptor: { causeCode: 'EXECUTION_LEASE_LOST' },
    });

    expect(executor.executeCalls).toHaveLength(0);
    const orphaned = store.snapshot(SESSION_ID);
    const staleTask = orphaned.tasks[0]!;
    expect(staleTask).toMatchObject({
      state: 'running',
      attempt: 1,
      recoveryRequired: false,
      executorOperation: { status: 'dispatched', attempt: 1 },
    });
    expect(staleTask).not.toHaveProperty('result');
    expect(staleTask).not.toHaveProperty('terminalAt');
    expect(orphaned.runs[0]!.budget.activeExecutions).toBe(1);
    expect(
      orphaned.events.filter(({ type }) =>
        ['task.failed', 'task.succeeded', 'task.timed_out', 'task.cancelled'].includes(type),
      ),
    ).toHaveLength(0);

    const replacement = await createFixture(executor, {
      store,
      createRun: false,
      executionLeaseTtlMs: 30,
    });
    await expect(replacement.runtime.execute(request())).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'proof' } },
    });

    const recovered = store.snapshot(SESSION_ID);
    expect(recovered.tasks).toHaveLength(1);
    expect(recovered.tasks[0]).toMatchObject({
      taskId: staleTask.taskId,
      state: 'succeeded',
      attempt: 2,
    });
    expect(recovered.runs[0]).toMatchObject({
      budget: { descendantsCreated: 1, activeExecutions: 0 },
    });
    expect(executor.executeCalls).toHaveLength(1);
    expect(executor.executeCalls[0]).toMatchObject({ attempt: 2 });
    expect(executor.executeCalls[0]!.operation.operationId).toBe(
      staleTask.executorOperation!.operationId,
    );
  });

  it('does not dispatch after ownership proof is lost behind a successful adoption commit', async () => {
    const store = new ArmedAdoptionRenewalLossStateStore();
    let call = 0;
    const executor = new AdversarialExecutor(async (execution, control) => {
      call += 1;
      if (call === 1) {
        await control.commitBinding('adoption-loss-binding', bindingForRequest(execution));
        await control.commitCheckpoint('adoption-loss-checkpoint', childCheckpoint());
        return recoveryMarker(execution, 'checkpoint', 'FIRST_ADOPTION_PROCESS_EXIT');
      }
      if (call === 2) {
        return recoveryMarker(execution, 'checkpoint', 'SECOND_ADOPTION_PROCESS_EXIT');
      }
      return successfulExecution(execution, control);
    });
    const first = await createFixture(executor, {
      store,
      executionLeaseTtlMs: 30_000,
    });
    await expect(first.runtime.execute(request())).rejects.toMatchObject({
      code: 'RECOVERY_UNSUPPORTED',
      descriptor: { causeCode: 'EXECUTOR_CHECKPOINT_RECOVERY_REQUIRED' },
    });
    const waiting = store.snapshot(SESSION_ID).tasks[0]!;
    expect(waiting).toMatchObject({
      state: 'running',
      attempt: 2,
      recoveryRequired: true,
      executorOperation: { type: 'resume_checkpoint', status: 'settled', attempt: 2 },
    });

    store.arm();
    const replacement = await createFixture(executor, {
      store,
      createRun: false,
      executionLeaseTtlMs: 30,
    });
    const handlePromise = replacement.runtime.recover(SESSION_ID, waiting.taskId);
    await store.adoptionCommitEntered.promise;
    await store.renewalFailed.promise;
    store.releaseAdoptionCommit.resolve(undefined);
    const staleHandle = await handlePromise;
    await expect(staleHandle.wait()).rejects.toMatchObject({
      code: 'RECOVERY_TARGET_LOST',
      descriptor: { causeCode: 'EXECUTION_LEASE_LOST' },
    });

    expect(executor.executeCalls).toHaveLength(2);
    const orphaned = store.snapshot(SESSION_ID);
    const staleAdoption = orphaned.tasks[0]!;
    expect(staleAdoption).toMatchObject({
      state: 'running',
      attempt: 3,
      recoveryRequired: false,
      executorOperation: { type: 'resume_checkpoint', status: 'dispatched', attempt: 3 },
    });
    expect(staleAdoption).not.toHaveProperty('result');
    expect(staleAdoption).not.toHaveProperty('terminalAt');
    expect(orphaned.runs[0]!.budget.activeExecutions).toBe(1);

    const recoveredHandle = await replacement.runtime.recover(SESSION_ID, waiting.taskId);
    await expect(recoveredHandle.wait()).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'proof' } },
    });
    const recovered = store.snapshot(SESSION_ID);
    expect(recovered.tasks[0]).toMatchObject({
      state: 'succeeded',
      attempt: 4,
    });
    expect(recovered.runs[0]).toMatchObject({
      budget: { descendantsCreated: 1, activeExecutions: 0 },
    });
    expect(executor.executeCalls).toHaveLength(3);
    expect(executor.executeCalls[2]).toMatchObject({
      attempt: 4,
      operation: { type: 'resume', reason: 'checkpoint' },
    });
  });

  it.each(['normalize', 'marker-settle'] as const)(
    'does not terminalize a resolved Executor result after lease loss during %s',
    async (stage) => {
      const store = new FirstExecutionRenewalLossStateStore();
      const executionLeaseLost = new Deferred<void>();
      let executeCount = 0;
      const executor = new AdversarialExecutor(async (execution, control) => {
        executeCount += 1;
        if (executeCount === 1) {
          execution.signal.addEventListener('abort', () => executionLeaseLost.resolve(undefined), {
            once: true,
          });
          store.blockNextPostResultLoad(execution.taskId);
          return stage === 'marker-settle'
            ? recoveryMarker(execution, 'unbound_create', 'LEASE_LOST_AFTER_RESULT')
            : candidateOutcome(execution, { answer: 'untrusted-raw-result' });
        }
        return successfulExecution(execution, control);
      });
      const first = await createFixture(executor, {
        store,
        executionLeaseTtlMs: 30,
      });
      const stalePromise = first.runtime.execute(request());
      stalePromise.catch(() => undefined);

      await store.postResultLoadEntered.promise;
      await store.renewalFailed.promise;
      await executionLeaseLost.promise;
      store.releasePostResultLoad.resolve(undefined);
      await expect(stalePromise).rejects.toMatchObject({
        code: 'RECOVERY_TARGET_LOST',
        descriptor: { causeCode: 'EXECUTION_LEASE_LOST' },
      });

      const orphaned = store.snapshot(SESSION_ID);
      const staleTask = orphaned.tasks[0]!;
      expect(staleTask).toMatchObject({
        state: 'running',
        attempt: 1,
        recoveryRequired: false,
        executorOperation: { status: 'dispatched', attempt: 1 },
      });
      expect(staleTask).not.toHaveProperty('result');
      expect(staleTask).not.toHaveProperty('terminalAt');
      expect(orphaned.runs[0]!.budget.activeExecutions).toBe(1);
      expect(
        orphaned.events.filter(({ type }) =>
          ['task.failed', 'task.succeeded', 'task.timed_out', 'task.cancelled'].includes(type),
        ),
      ).toHaveLength(0);
      expect(orphaned.events.filter(({ type }) => type === 'recovery.failed')).toHaveLength(0);

      const replacement = await createFixture(executor, {
        store,
        createRun: false,
        executionLeaseTtlMs: 30,
      });
      await expect(replacement.runtime.execute(request())).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'succeeded', output: { answer: 'proof' } },
      });

      const recovered = store.snapshot(SESSION_ID);
      expect(recovered.tasks).toHaveLength(1);
      expect(recovered.tasks[0]).toMatchObject({
        taskId: staleTask.taskId,
        state: 'succeeded',
        attempt: 2,
      });
      expect(recovered.tasks[0]!.executionEpoch).not.toBe(staleTask.executionEpoch);
      expect(recovered.tasks[0]!.executionFencingToken).not.toBe(staleTask.executionFencingToken);
      expect(recovered.runs[0]).toMatchObject({
        budget: { descendantsCreated: 1, activeExecutions: 0 },
      });
      expect(recovered.events.filter(({ type }) => type === 'task.failed')).toHaveLength(0);
      expect(recovered.events.filter(({ type }) => type === 'task.succeeded')).toHaveLength(1);
      expect(executor.executeCalls.map(({ attempt }) => attempt)).toEqual([1, 2]);
      expect(executor.executeCalls[1]!.operation.operationId).toBe(
        executor.executeCalls[0]!.operation.operationId,
      );
    },
  );

  it('rejects failure partial output before agent-result establishes an authoritative receipt', async () => {
    const executor = new AdversarialExecutor(async (execution, control) => {
      await control.commitBinding('unreceipted-partial-binding', bindingForRequest(execution));
      await expect(
        control.completion.fail('unreceipted-partial', {
          status: 'failed',
          error: { code: 'EXECUTOR_FAILED', message: 'unsafe partial', retryable: false },
          partialOutput: { answer: 'must-not-persist' },
        }),
      ).rejects.toMatchObject({ code: 'RESULT_REQUIRED' });
      await control.completion.fail('unreceipted-terminal', {
        status: 'failed',
        error: { code: 'EXECUTOR_FAILED', message: 'terminal', retryable: false },
      });
      return candidateOutcome(execution, { answer: 'untrusted-raw-success' });
    });
    const { runtime, store } = await createFixture(executor);

    await expect(runtime.execute(request())).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'failed' },
    });
    expect(store.snapshot(SESSION_ID).tasks[0]).not.toHaveProperty('partialOutput');
    expect(JSON.stringify(store.snapshot(SESSION_ID))).not.toContain('must-not-persist');
  });

  acceptanceIt('C7-TRANSPORT-04.l1.recovery-marker', 'recovery-marker', async () => {
    let staleControl: SubAgentExecutionControl | undefined;
    const checkpoint = appliedPendingCheckpoint();
    const executor = new AdversarialExecutor(async (execution, control) => {
      if (execution.operation.type === 'create') {
        staleControl = control;
        await control.commitBinding('marker-binding', bindingForRequest(execution));
        await control.commitCheckpoint('marker-checkpoint', checkpoint);
        return recoveryMarker(execution, 'checkpoint');
      }

      expect(execution.operation).toMatchObject({ type: 'resume', reason: 'checkpoint' });
      if (execution.operation.type !== 'resume') throw new Error('expected checkpoint resume');
      expect(execution.operation.checkpoint).toEqual(checkpoint);
      expect(execution.operation.checkpoint.pendingBatch).toEqual(checkpoint.pendingBatch);
      await expect(
        staleControl!.reportProgress('stale-progress', { message: 'obsolete attempt' }),
      ).rejects.toMatchObject({ code: 'RECOVERY_TARGET_LOST' });
      const output = { answer: 'checkpoint-recovered' };
      await control.completion.submitResult('recovered-result', output);
      await control.completion.complete('recovered-end', { isStandalone: true });
      return candidateOutcome(execution, output);
    });
    const { runtime, store } = await createFixture(executor);

    await expect(runtime.execute(request())).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'checkpoint-recovered' } },
    });

    const snapshot = store.snapshot(SESSION_ID);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      state: 'succeeded',
      attempt: 2,
      recoveryRequired: false,
      executorOperation: { type: 'resume_checkpoint', status: 'settled', attempt: 2 },
    });
    expect(snapshot.tasks[0]?.childCheckpoint?.pendingBatch).toEqual(checkpoint.pendingBatch);
    expect(snapshot.runs[0]).toMatchObject({
      budget: { descendantsCreated: 1, activeExecutions: 0 },
    });
    expect(executor.executeCalls).toHaveLength(2);
    expect(executor.executeCalls.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(executor.executeCalls[0]!.executionEpoch).not.toBe(
      executor.executeCalls[1]!.executionEpoch,
    );
    expect(executor.executeCalls[0]!.executionFencingToken).not.toBe(
      executor.executeCalls[1]!.executionFencingToken,
    );
    expect(executor.executeCalls[0]!.operation.operationId).not.toBe(
      executor.executeCalls[1]!.operation.operationId,
    );
    expect(snapshot.events.filter(({ type }) => type === 'recovery.failed')).toHaveLength(1);
    expect(snapshot.events.filter(({ type }) => type === 'recovery.started')).toHaveLength(1);
    expect(snapshot.events.filter(({ type }) => type === 'recovery.resumed')).toHaveLength(1);
    expect(snapshot.events.filter(({ type }) => type === 'task.succeeded')).toHaveLength(1);
  });

  it('replays a direct spawn unbound-create marker without replacing the logical task', async () => {
    const spawnAttempts: SubAgentExecutionRequest[] = [];
    const executor = new AdversarialExecutor(successfulExecution, async (execution, control) => {
      spawnAttempts.push(execution);
      if (spawnAttempts.length === 1) return recoveryMarker(execution, 'unbound_create');

      const binding = bindingForRequest(execution);
      return rawExecutorHandle(execution, binding, async () => {
        const output = { answer: 'spawn-create-replayed' };
        await control.completion.submitResult('spawn-result', output);
        await control.completion.complete('spawn-end', { isStandalone: true });
        return candidateOutcome(execution, output);
      });
    });
    const { runtime, store } = await createFixture(executor);

    const handle = await runtime.spawn(request());
    await expect(handle.wait()).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'spawn-create-replayed' } },
    });

    const snapshot = store.snapshot(SESSION_ID);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ state: 'succeeded', attempt: 2 });
    expect(snapshot.runs[0]).toMatchObject({
      budget: { descendantsCreated: 1, activeExecutions: 0 },
    });
    expect(executor.spawnCalls).toHaveLength(2);
    expect(executor.executeCalls).toHaveLength(0);
    expect(spawnAttempts.map(({ operation }) => operation.type)).toEqual(['create', 'create']);
    expect(spawnAttempts[0]!.operation).toMatchObject({
      type: 'create',
      idempotencyKey: 'request-1',
    });
    expect(spawnAttempts[1]!.operation).toMatchObject({
      type: 'create',
      idempotencyKey: 'request-1',
    });
    expect(spawnAttempts[0]!.operation.operationId).toBe(spawnAttempts[1]!.operation.operationId);
    expect(spawnAttempts[0]!.executionEpoch).not.toBe(spawnAttempts[1]!.executionEpoch);
    expect(spawnAttempts[0]!.executionFencingToken).not.toBe(
      spawnAttempts[1]!.executionFencingToken,
    );
  });

  it('accepts a spawn handle wait marker and resumes it through execute, not reconnect', async () => {
    const executor = new AdversarialExecutor(
      async (execution, control) => {
        expect(execution.operation).toMatchObject({ type: 'resume', reason: 'checkpoint' });
        const output = { answer: 'spawn-wait-recovered' };
        await control.completion.submitResult('spawn-wait-result', output);
        await control.completion.complete('spawn-wait-end', { isStandalone: true });
        return candidateOutcome(execution, output);
      },
      async (execution, control) => {
        const binding = bindingForRequest(execution);
        return rawExecutorHandle(execution, binding, async () => {
          await control.commitCheckpoint('spawn-wait-checkpoint', childCheckpoint());
          return recoveryMarker(execution, 'checkpoint', 'WORKER_EXITED');
        });
      },
    );
    const { runtime, store } = await createFixture(executor);

    const handle = await runtime.spawn(request());
    await expect(handle.wait()).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'spawn-wait-recovered' } },
    });

    expect(executor.spawnCalls).toHaveLength(1);
    expect(executor.executeCalls).toHaveLength(1);
    expect(executor.executeCalls[0]!.operation).toMatchObject({
      type: 'resume',
      reason: 'checkpoint',
    });
    expect(store.snapshot(SESSION_ID).tasks[0]).toMatchObject({
      state: 'succeeded',
      attempt: 2,
    });
  });

  it('fails outcome-unknown without replay when provider intent is in flight', async () => {
    const executor = new AdversarialExecutor(async (execution, control) => {
      await control.commitBinding('provider-binding', bindingForRequest(execution));
      await control.commitCheckpoint('provider-prepared', childModelCheckpoint('prepared'));
      await control.commitCheckpoint('provider-checkpoint', childModelCheckpoint('in_flight'));
      return recoveryMarker(execution, 'checkpoint', 'WORKER_EXITED');
    });
    const { runtime, store } = await createFixture(executor);

    await expect(runtime.execute(request())).resolves.toMatchObject({
      type: 'terminal',
      result: {
        status: 'failed',
        error: { code: 'EXECUTOR_FAILED', outcomeUnknown: true },
      },
    });

    const snapshot = store.snapshot(SESSION_ID);
    expect(executor.executeCalls).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      state: 'failed',
      attempt: 1,
      recoveryRequired: false,
      executorOperation: { status: 'settled' },
      error: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
    });
    expect(snapshot.runs[0]!.budget.activeExecutions).toBe(0);
    expect(snapshot.events.filter(({ type }) => type === 'recovery.failed')).toHaveLength(1);
    expect(snapshot.events.filter(({ type }) => type === 'task.failed')).toHaveLength(1);
  });

  it('preserves one receipt-backed partial result when a marker follows result submission', async () => {
    const output = { answer: 'marker-partial-proof' };
    const executor = new AdversarialExecutor(async (execution, control) => {
      await control.commitBinding('partial-binding', bindingForRequest(execution));
      await control.commitCheckpoint('partial-checkpoint', childCheckpoint());
      await control.completion.submitResult('partial-result', output);
      return recoveryMarker(execution, 'checkpoint', 'PROCESS_EXITED');
    });
    const { runtime, store } = await createFixture(executor);

    await expect(runtime.execute(request())).resolves.toMatchObject({
      type: 'terminal',
      result: {
        status: 'failed',
        partialOutput: output,
        error: { code: 'EXECUTOR_FAILED', causeCode: 'PROCESS_EXITED' },
      },
    });

    const snapshot = store.snapshot(SESSION_ID);
    expect(executor.executeCalls).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      state: 'failed',
      attempt: 1,
      partialOutput: output,
      resultReceipt: { callId: 'partial-result' },
      executorOperation: { status: 'settled' },
    });
    expect(snapshot.events.filter(({ type }) => type === 'task.result_submitted')).toHaveLength(1);
    expect(snapshot.events.filter(({ type }) => type === 'recovery.failed')).toHaveLength(1);
    expect(snapshot.events.filter(({ type }) => type === 'task.failed')).toHaveLength(1);
  });

  it('keeps an authoritative terminal immutable when an Executor returns a late marker', async () => {
    const output = { answer: 'terminal-wins' };
    const executor = new AdversarialExecutor(async (execution, control) => {
      await control.commitBinding('terminal-binding', bindingForRequest(execution));
      await control.completion.submitResult('terminal-result', output);
      await control.completion.complete('terminal-end', { isStandalone: true });
      return recoveryMarker(execution, 'checkpoint', 'LATE_PROCESS_EXIT');
    });
    const { runtime, store } = await createFixture(executor);

    await expect(runtime.execute(request())).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output },
    });

    const snapshot = store.snapshot(SESSION_ID);
    expect(snapshot.tasks[0]).toMatchObject({ state: 'succeeded', attempt: 1 });
    expect(snapshot.events.filter(({ type }) => type === 'recovery.failed')).toHaveLength(0);
    expect(snapshot.events.filter(({ type }) => type === 'task.succeeded')).toHaveLength(1);
  });

  it('leaves a second marker host-recoverable and resumes only on an explicit recovery', async () => {
    let call = 0;
    const executor = new AdversarialExecutor(async (execution, control) => {
      call += 1;
      if (call === 1) {
        await control.commitBinding('second-marker-binding', bindingForRequest(execution));
        await control.commitCheckpoint('second-marker-checkpoint', childCheckpoint());
        return recoveryMarker(execution, 'checkpoint', 'FIRST_PROCESS_EXIT');
      }
      if (call === 2) {
        return recoveryMarker(execution, 'checkpoint', 'SECOND_PROCESS_EXIT');
      }
      const output = { answer: 'host-recovered' };
      await control.completion.submitResult('host-result', output);
      await control.completion.complete('host-end', { isStandalone: true });
      return candidateOutcome(execution, output);
    });
    const { runtime, store } = await createFixture(executor);

    await expect(runtime.execute(request())).rejects.toMatchObject({
      code: 'RECOVERY_UNSUPPORTED',
      descriptor: { causeCode: 'EXECUTOR_CHECKPOINT_RECOVERY_REQUIRED' },
    });
    const stopped = store.snapshot(SESSION_ID);
    expect(stopped.tasks).toHaveLength(1);
    expect(stopped.tasks[0]).toMatchObject({
      state: 'running',
      attempt: 2,
      recoveryRequired: true,
      executorOperation: { type: 'resume_checkpoint', status: 'settled', attempt: 2 },
    });
    expect(stopped.runs[0]!.budget.activeExecutions).toBe(0);
    expect(stopped.events.filter(({ type }) => type === 'task.failed')).toHaveLength(0);
    expect(stopped.events.filter(({ type }) => type === 'recovery.failed')).toHaveLength(2);

    const recovered = await runtime.recover(SESSION_ID, stopped.tasks[0]!.taskId);
    await expect(recovered.wait()).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'host-recovered' } },
    });
    const completed = store.snapshot(SESSION_ID);
    expect(executor.executeCalls).toHaveLength(3);
    expect(completed.tasks).toHaveLength(1);
    expect(completed.tasks[0]).toMatchObject({ state: 'succeeded', attempt: 3 });
    expect(completed.runs[0]).toMatchObject({
      budget: { descendantsCreated: 1, activeExecutions: 0 },
    });
  });

  it('charges timeout while a recovery-required task waits without an active slot', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      let call = 0;
      const executor = new AdversarialExecutor(async (execution, control) => {
        call += 1;
        if (call === 1) {
          await control.commitBinding('timeout-gap-binding', bindingForRequest(execution));
          await control.commitCheckpoint('timeout-gap-checkpoint', childCheckpoint());
        }
        return recoveryMarker(execution, 'checkpoint', `RECOVERY_GAP_${call}`);
      });
      const { runtime, store } = await createFixture(executor, { limits: { timeoutMs: 100 } });

      await expect(runtime.execute(request())).rejects.toMatchObject({
        code: 'RECOVERY_UNSUPPORTED',
      });
      const waiting = store.snapshot(SESSION_ID).tasks[0]!;
      expect(waiting).toMatchObject({
        state: 'running',
        attempt: 2,
        recoveryRequired: true,
      });
      expect(store.snapshot(SESSION_ID).runs[0]!.budget.activeExecutions).toBe(0);

      vi.setSystemTime(10_101);
      const recovered = await runtime.recover(SESSION_ID, waiting.taskId);
      await expect(recovered.wait()).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'timed_out', error: { code: 'TIMED_OUT' } },
      });

      const terminal = store.snapshot(SESSION_ID);
      expect(executor.executeCalls).toHaveLength(2);
      expect(terminal.tasks[0]).toMatchObject({
        state: 'timed_out',
        attempt: 2,
        recoveryRequired: false,
        remainingMs: 0,
      });
      expect(terminal.tasks[0]!.activeElapsedMs).toBeGreaterThanOrEqual(100);
      expect(terminal.runs[0]!.budget.activeExecutions).toBe(0);
      expect(terminal.events.filter(({ type }) => type === 'task.timed_out')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['checkpoint', 'unbound_create'] as const)(
    'atomically times out %s adoption when its task lease arrives after the persisted deadline',
    async (reason) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const clock = new ManualClock(20_000);
        vi.setSystemTime(clock.date());
        const store = new RecoveryBarrierStateStore({ now: clock.now });
        const executor = new AdversarialExecutor(async (execution, control) => {
          if (reason === 'checkpoint') {
            await control.commitBinding('deadline-cross-binding', bindingForRequest(execution));
            await control.commitCheckpoint('deadline-cross-checkpoint', childCheckpoint());
          }
          store.heldTaskLeaseKey = `subagent-task:${SESSION_ID}:${execution.taskId}`;
          return recoveryMarker(execution, reason, 'LEASE_CROSSED_DEADLINE');
        });
        const { runtime } = await createFixture(executor, {
          store,
          limits: { timeoutMs: 100 },
        });

        const pending = runtime.execute(request());
        pending.catch(() => undefined);
        await store.taskLeaseRequested.promise;
        clock.advanceTo(20_101);
        vi.setSystemTime(clock.date());
        store.releaseHeldTaskLease.resolve(undefined);

        await expect(pending).resolves.toMatchObject({
          type: 'terminal',
          result: { status: 'timed_out', error: { code: 'TIMED_OUT' } },
        });
        const snapshot = store.snapshot(SESSION_ID);
        expect(executor.executeCalls).toHaveLength(1);
        expect(snapshot.tasks[0]).toMatchObject({
          state: 'timed_out',
          attempt: 1,
          recoveryRequired: false,
          remainingMs: 0,
        });
        expect(snapshot.runs[0]!.budget.activeExecutions).toBe(0);
        expect(snapshot.events.filter(({ type }) => type === 'recovery.started')).toHaveLength(0);
        expect(snapshot.events.filter(({ type }) => type === 'task.timed_out')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not persist a checkpoint recovery attempt after the parent aborts at task-lease acquisition', async () => {
    const store = new RecoveryBarrierStateStore();
    const abort = new AbortController();
    const executor = new AdversarialExecutor(async (execution, control) => {
      await control.commitBinding('abort-binding', bindingForRequest(execution));
      await control.commitCheckpoint('abort-checkpoint', childCheckpoint());
      store.blockedTaskLeaseKey = `subagent-task:${SESSION_ID}:${execution.taskId}`;
      return recoveryMarker(execution, 'checkpoint', 'PROCESS_EXITED');
    });
    const { runtime } = await createFixture(executor, { store });
    const pending = runtime.execute({ ...request(), signal: abort.signal });
    pending.catch(() => undefined);

    await store.taskLeaseRequested.promise;
    abort.abort(new Error('abort checkpoint adoption'));
    await expect(pending).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'cancelled', error: { code: 'CANCELLED' } },
    });

    const snapshot = store.snapshot(SESSION_ID);
    expect(executor.executeCalls).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      state: 'cancelled',
      attempt: 1,
      executorOperation: { status: 'settled', attempt: 1 },
    });
    expect(snapshot.events.filter(({ type }) => type === 'recovery.started')).toHaveLength(0);
    expect(snapshot.runs[0]!.budget.activeExecutions).toBe(0);
  });

  it('keeps an unbound marker and slot unchanged when idempotent adoption aborts before its task lease', async () => {
    const store = new RecoveryBarrierStateStore();
    const executor = new AdversarialExecutor(async (execution) =>
      recoveryMarker(execution, 'unbound_create', 'PROCESS_EXITED'),
    );
    const { runtime } = await createFixture(executor, { store });

    await expect(runtime.execute(request())).rejects.toMatchObject({
      code: 'RECOVERY_UNSUPPORTED',
    });
    const before = store.snapshot(SESSION_ID);
    const task = before.tasks[0]!;
    expect(task).toMatchObject({ state: 'running', attempt: 2, recoveryRequired: true });
    expect(before.runs[0]!.budget.activeExecutions).toBe(0);

    store.blockedTaskLeaseKey = `subagent-task:${SESSION_ID}:${task.taskId}`;
    const abort = new AbortController();
    const replay = runtime.execute({ ...request(), signal: abort.signal });
    replay.catch(() => undefined);
    await store.taskLeaseRequested.promise;
    abort.abort(new Error('abort unbound adoption'));
    await expect(replay).rejects.toMatchObject({ code: 'CANCELLED' });

    const after = store.snapshot(SESSION_ID);
    expect(executor.executeCalls).toHaveLength(2);
    expect(after.tasks).toHaveLength(1);
    expect(after.tasks[0]).toMatchObject({
      state: 'running',
      attempt: 2,
      recoveryRequired: true,
      executorOperation: { status: 'settled', attempt: 2 },
    });
    expect(after.runs[0]!.budget.activeExecutions).toBe(0);
  });

  it('preserves recovery-required when a sibling consumes the released slot before auto adoption', async () => {
    const store = new RecoveryBarrierStateStore();
    const siblingEntered = new Deferred<void>();
    const releaseSibling = new Deferred<void>();
    const executor = new AdversarialExecutor(async (execution, control) => {
      const value = (execution.input as { value: string }).value;
      if (value === 'alpha') {
        await control.commitBinding('capacity-binding', bindingForRequest(execution));
        await control.commitCheckpoint('capacity-checkpoint', childCheckpoint());
        store.blockedTaskLeaseKey = `subagent-task:${SESSION_ID}:${execution.taskId}`;
        return recoveryMarker(execution, 'checkpoint', 'PROCESS_EXITED');
      }

      await control.commitBinding('sibling-binding', bindingForRequest(execution));
      siblingEntered.resolve(undefined);
      await releaseSibling.promise;
      const output = { answer: 'sibling-complete' };
      await control.completion.submitResult('sibling-result', output);
      await control.completion.complete('sibling-end', { isStandalone: true });
      return candidateOutcome(execution, output);
    });
    const { runtime } = await createFixture(executor, {
      store,
      limits: { maxConcurrent: 1 },
    });

    const recovering = runtime.execute(request());
    recovering.catch(() => undefined);
    await store.taskLeaseRequested.promise;
    const sibling = runtime.execute({
      ...request('request-2'),
      input: { value: 'beta' },
    });
    await siblingEntered.promise;
    store.blockedTaskLeaseKey = undefined;

    await expect(recovering).rejects.toMatchObject({
      code: 'RECOVERY_UNSUPPORTED',
      descriptor: { causeCode: 'EXECUTOR_RECOVERY_CAPACITY_UNAVAILABLE' },
    });
    const blocked = store.snapshot(SESSION_ID);
    const original = blocked.tasks.find(({ requestId }) => requestId === 'request-1')!;
    expect(original).toMatchObject({
      state: 'running',
      attempt: 1,
      recoveryRequired: true,
      executorOperation: { status: 'settled' },
    });
    expect(blocked.runs[0]!.budget.activeExecutions).toBe(1);

    releaseSibling.resolve(undefined);
    await expect(sibling).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded' },
    });
    expect(store.snapshot(SESSION_ID).runs[0]!.budget.activeExecutions).toBe(0);
  });

  it('reselects the exact recovery target after a catalog refresh and never falls back', async () => {
    const store = new RecoveryBarrierStateStore();
    const executor = new AdversarialExecutor(async (execution, control) => {
      await control.commitBinding('catalog-binding', bindingForRequest(execution));
      await control.commitCheckpoint('catalog-checkpoint', childCheckpoint());
      store.blockedRecoveryLoadTaskId = execution.taskId;
      return recoveryMarker(execution, 'checkpoint', 'PROCESS_EXITED');
    });
    const { runtime } = await createFixture(executor, { store });
    const pending = runtime.execute(request());
    pending.catch(() => undefined);

    await store.recoveryLoadEntered.promise;
    executor.availability = { status: 'unavailable', reasonCode: 'MAINTENANCE' };
    await runtime.refreshCatalog();
    store.releaseRecoveryLoad.resolve(undefined);

    await expect(pending).rejects.toMatchObject({
      code: 'RECOVERY_UNSUPPORTED',
      descriptor: { causeCode: 'EXECUTOR_RECOVERY_TARGET_UNAVAILABLE' },
    });
    const snapshot = store.snapshot(SESSION_ID);
    expect(executor.executeCalls).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      state: 'running',
      attempt: 1,
      recoveryRequired: true,
      executorOperation: { status: 'settled' },
    });
    expect(snapshot.runs[0]!.budget.activeExecutions).toBe(0);
  });

  it('observes a background spawn rejection and preserves its cause after active cleanup', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const secondEntered = new Deferred<void>();
      const releaseSecond = new Deferred<void>();
      const executor = new AdversarialExecutor(
        async (execution) => {
          secondEntered.resolve(undefined);
          await releaseSecond.promise;
          return recoveryMarker(execution, 'checkpoint', 'SECOND_PROCESS_EXIT');
        },
        async (execution, control) => {
          const binding = bindingForRequest(execution);
          return rawExecutorHandle(execution, binding, async () => {
            await control.commitCheckpoint('background-checkpoint', childCheckpoint());
            return recoveryMarker(execution, 'checkpoint', 'FIRST_PROCESS_EXIT');
          });
        },
      );
      const { runtime } = await createFixture(executor);
      const handle = await runtime.spawn(request());

      await secondEntered.promise;
      const activeWait = handle.wait();
      activeWait.catch(() => undefined);
      releaseSecond.resolve(undefined);
      const activeError = await activeWait.catch((error: unknown) => error);
      expect(activeError).toBeInstanceOf(SubAgentRuntimeError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      const deferredError = await handle.wait().catch((error: unknown) => error);
      expect(deferredError).toBeInstanceOf(SubAgentRuntimeError);
      expect((deferredError as SubAgentRuntimeError).descriptor).toEqual(
        (activeError as SubAgentRuntimeError).descriptor,
      );
      expect((deferredError as SubAgentRuntimeError).descriptor).toMatchObject({
        code: 'RECOVERY_UNSUPPORTED',
        causeCode: 'EXECUTOR_CHECKPOINT_RECOVERY_REQUIRED',
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it.each([
    {
      name: 'wrong operation identity',
      arrange: async (execution: SubAgentExecutionRequest, control: SubAgentExecutionControl) => {
        await control.commitBinding('wrong-id-binding', bindingForRequest(execution));
        await control.commitCheckpoint('wrong-id-checkpoint', childCheckpoint());
        return { ...recoveryMarker(execution, 'checkpoint'), operationId: 'obsolete-operation' };
      },
    },
    {
      name: 'checkpoint without a persisted checkpoint',
      arrange: async (execution: SubAgentExecutionRequest, control: SubAgentExecutionControl) => {
        await control.commitBinding('missing-checkpoint-binding', bindingForRequest(execution));
        return recoveryMarker(execution, 'checkpoint');
      },
    },
    {
      name: 'unbound-create after binding',
      arrange: async (execution: SubAgentExecutionRequest, control: SubAgentExecutionControl) => {
        await control.commitBinding('bound-create-binding', bindingForRequest(execution));
        return recoveryMarker(execution, 'unbound_create');
      },
    },
  ])('rejects an invalid recovery marker: $name', async ({ arrange }) => {
    const executor = new AdversarialExecutor(arrange);
    const { runtime, store } = await createFixture(executor);

    await expect(runtime.execute(request())).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'failed', error: { code: 'EXECUTOR_FAILED' } },
    });
    const snapshot = store.snapshot(SESSION_ID);
    expect(executor.executeCalls).toHaveLength(1);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ state: 'failed', attempt: 1 });
    expect(snapshot.events.filter(({ type }) => type === 'recovery.started')).toHaveLength(0);
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

  it('recovers a crash after result CAS without replaying result production', async () => {
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
    const seeded = await seedResultSubmittedCrashTask(store);
    const executor = new AdversarialExecutor(async (execution, control) => {
      if (execution.operation.type !== 'resume') throw new Error('expected checkpoint resume');
      expect(execution.operation.reason).toBe('checkpoint');
      const proof = execution.operation.checkpoint.resultSubmission;
      expect(proof).toEqual({
        version: '1',
        callId: 'result-cas-call',
        output: { answer: 'result-cas-crash-proof' },
        outputHash: canonicalJsonSha256({ answer: 'result-cas-crash-proof' }),
      });
      const replay = await control.completion.submitResult(proof!.callId, proof!.output);
      expect(replay.status).toBe('replayed');
      await control.completion.complete('result-cas-end', { isStandalone: true });
      return candidateOutcome(execution, proof!.output);
    });
    const { runtime } = await createFixture(executor, { store, createRun: false });

    await expect(runtime.resume(SESSION_ID, seeded.taskId, {})).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'result-cas-crash-proof' } },
    });
    expect(executor.executeCalls).toHaveLength(1);
    expect(store.snapshot(SESSION_ID).tasks[0]).toMatchObject({
      state: 'succeeded',
      attempt: 2,
      childCheckpoint: {
        resultSubmission: {
          callId: 'result-cas-call',
          output: { answer: 'result-cas-crash-proof' },
        },
      },
    });
  });
});
