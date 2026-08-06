import { setImmediate as waitImmediate } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Deferred, ManualClock, RecordingRuntimeStateStore, acceptanceIt } from '../../../testkit';
import {
  createSubAgentRuntime,
  canonicalJsonSha256,
  commitRuntimeStateMutation,
  DEFAULT_SUBAGENT_LIMITS,
  defineSubAgent,
  resolveSubAgentLimits,
  SubAgentRuntimeError,
  measureCanonicalJsonBytes,
  type ExecutorAvailabilityProbe,
  type ExecutorTaskHandle,
  type JsonValue,
  type ArtifactStore,
  type AgentCheckpointMigrator,
  type AgentRunStateOwnership,
  type StoredAgentRun,
  type SubAgentChildCheckpoint,
  type SubAgentDefinition,
  type SubAgentExecutionControl,
  type SubAgentExecutionOutcome,
  type SubAgentErrorDescriptor,
  type SubAgentExecutionRequest,
  type SubAgentExecutor,
  type SubAgentExecutorBinding,
  type SubAgentExecutorDescriptor,
  type SubAgentRuntimeOptions,
} from '../src';

const SESSION_ID = 'runtime-test-session';
const RUN_ID = 'runtime-test-run';

async function withRunOwnership<T>(
  store: RecordingRuntimeStateStore,
  runId: string,
  work: (ownership: AgentRunStateOwnership) => Promise<T>,
): Promise<T> {
  const lease = await store.acquireLease(
    `agent-run:${JSON.stringify([SESSION_ID, runId])}`,
    30_000,
  );
  const controller = new AbortController();
  const ownership: AgentRunStateOwnership = {
    ownerSessionId: SESSION_ID,
    runId,
    fencingToken: lease.fencingToken,
    signal: controller.signal,
    useStateLease: (operation) => operation(lease),
  };
  try {
    return await work(ownership);
  } finally {
    controller.abort();
    await lease.release();
  }
}

type ExecuteHandler = (
  request: SubAgentExecutionRequest,
  control: SubAgentExecutionControl,
) => Promise<SubAgentExecutionOutcome>;

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

function createDefinition(overrides: Partial<SubAgentDefinition> = {}): SubAgentDefinition {
  return defineSubAgent({
    name: 'researcher',
    version: '2',
    description: 'Return a deterministic research proof.',
    inputSchema: z.object({
      value: z.string(),
      mode: z.enum(['ok', 'fail']).optional(),
    }),
    outputSchema: z.object({ answer: z.string() }),
    ...overrides,
  } as SubAgentDefinition);
}

const COMPLETE_CAPABILITIES: SubAgentExecutorDescriptor['capabilities'] = {
  execute: true,
  spawn: true,
  cancel: true,
  events: true,
  approval: true,
  usage: 'provider',
  recovery: { resume: 'checkpoint', reconnect: 'external_binding' },
};

class RuntimeTestExecutor implements SubAgentExecutor {
  readonly descriptor: SubAgentExecutorDescriptor;
  readonly bindingCodec: SubAgentExecutor['bindingCodec'];
  availability: ExecutorAvailabilityProbe = { status: 'available' };
  executeCalls: SubAgentExecutionRequest[] = [];
  spawnCalls: SubAgentExecutionRequest[] = [];
  rawCancelCalls = 0;
  cancelledBindings: SubAgentExecutorBinding[] = [];
  handler: ExecuteHandler;

  constructor(
    readonly name = 'local',
    handler: ExecuteHandler = successfulExecution,
    capabilities: SubAgentExecutorDescriptor['capabilities'] = COMPLETE_CAPABILITIES,
    maxBindingBytes = 64 * 1024,
    runnerVersion = '1',
    adapterStateVersion = '1',
  ) {
    this.bindingCodec = {
      adapterStateVersion,
      encode: (state: JsonValue): JsonValue => state,
      decode: (value: JsonValue): JsonValue => value,
    };
    this.descriptor = {
      runtimeProtocolVersion: '1',
      taskRecordVersions: ['1'],
      childCheckpointVersions: ['1'],
      runnerCompatibility: [
        { runnerId: 'test-runner', runnerVersion, childCheckpointVersions: ['1'] },
      ],
      name,
      description: `${name} runtime test placement.`,
      useCases: [`Run deterministic tests on ${name}.`],
      capabilities,
      adapterStateVersion,
      maxBindingBytes,
      maxEventPageSize: 256,
    };
    this.handler = handler;
  }

  getAvailability(): ExecutorAvailabilityProbe {
    return this.availability;
  }

  supports(): boolean {
    return true;
  }

  async execute(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<SubAgentExecutionOutcome> {
    this.executeCalls.push(request);
    return this.handler(request, control);
  }

  async spawn(
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ): Promise<ExecutorTaskHandle> {
    this.spawnCalls.push(request);
    const binding = createBinding(request, this.name);
    await control.commitBinding('spawn-binding', binding);
    const pending = new Deferred<SubAgentExecutionOutcome>();
    return {
      taskId: request.taskId,
      binding,
      snapshot: async () => ({
        taskId: request.taskId,
        state: 'running',
        binding,
        updatedAt: Date.now(),
      }),
      wait: () => pending.promise,
      cancel: async () => {
        this.rawCancelCalls += 1;
      },
      events: async function* () {
        yield* [];
      },
    };
  }

  async cancel(
    binding: SubAgentExecutorBinding,
    _options: Parameters<SubAgentExecutor['cancel']>[1],
  ): Promise<void> {
    void _options;
    this.rawCancelCalls += 1;
    this.cancelledBindings.push(binding);
  }
}

function createBinding(
  request: SubAgentExecutionRequest,
  executorName = 'local',
  runnerVersion = '1',
  adapterStateVersion = '1',
): SubAgentExecutorBinding {
  return {
    version: '1',
    executorName,
    ownerSessionId: request.ownerSessionId,
    taskId: request.taskId,
    subagentSessionId: request.subagentSessionId,
    definitionName: request.definition.name,
    definitionVersion: request.definition.version,
    runnerId: 'test-runner',
    runnerVersion,
    adapterStateVersion,
    recoveryData: { placement: executorName },
  };
}

function candidateOutcome(
  request: SubAgentExecutionRequest,
  output: JsonValue,
): SubAgentExecutionOutcome {
  return {
    type: 'terminal',
    result: {
      status: 'succeeded',
      task: { taskId: request.taskId, subAgent: request.definition },
      executor: request.definition.name,
      output,
    },
  };
}

function childCheckpoint(runnerVersion = '1') {
  return {
    version: '1' as const,
    runnerId: 'test-runner',
    runnerVersion,
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

function approvalCheckpoint(callId: string, toolName: string, runnerVersion = '1') {
  const input = {};
  return {
    ...childCheckpoint(runnerVersion),
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

function childModelCheckpoint(
  phase: 'prepared' | 'in_flight' | 'result_ready',
): SubAgentChildCheckpoint {
  const updatedAt = phase === 'prepared' ? 1_001 : phase === 'in_flight' ? 1_002 : 1_003;
  return {
    ...childCheckpoint(),
    modelOperation: {
      version: '1',
      operationId: 'child-model-operation',
      iteration: 1,
      purpose: 'agent',
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

function childResultCheckpoint(callId: string, output: JsonValue): SubAgentChildCheckpoint {
  return {
    ...childCheckpoint(),
    resultSubmission: {
      version: '1',
      callId,
      output,
      outputHash: canonicalJsonSha256(output),
    },
  };
}

async function successfulExecution(
  request: SubAgentExecutionRequest,
  control: SubAgentExecutionControl,
): Promise<SubAgentExecutionOutcome> {
  await control.commitBinding('create-binding', createBinding(request));
  const output = { answer: `proof:${String((request.input as { value?: unknown }).value)}` };
  await control.completion.submitResult('agent-result-1', output);
  await control.completion.complete('end-agent-1', { isStandalone: true });
  return candidateOutcome(request, output);
}

async function createFixture(options: {
  readonly definition?: SubAgentDefinition;
  readonly activeDefinitions?: readonly SubAgentDefinition[];
  readonly recoveryDefinitions?: readonly SubAgentDefinition[];
  readonly executors?: readonly RuntimeTestExecutor[];
  readonly store?: RecordingRuntimeStateStore;
  readonly artifactStore?: ArtifactStore;
  readonly checkpointMigrators?: readonly AgentCheckpointMigrator[];
  readonly executionLeaseTtlMs?: number;
  readonly limits?: SubAgentRuntimeOptions['limits'];
  readonly initializeRun?: boolean;
}) {
  const store = options.store ?? new RecordingRuntimeStateStore();
  if (options.initializeRun !== false) {
    await store.createRun(
      createRun({
        limits: resolveSubAgentLimits(options.limits),
      }),
    );
  }
  const executors = options.executors ?? [new RuntimeTestExecutor()];
  const runtime = createSubAgentRuntime({
    sessionId: SESSION_ID,
    activeDefinitions: options.activeDefinitions ?? [options.definition ?? createDefinition()],
    ...(options.recoveryDefinitions === undefined
      ? {}
      : { recoveryDefinitions: options.recoveryDefinitions }),
    executors,
    stateStore: store,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
    ...(options.checkpointMigrators === undefined
      ? {}
      : { checkpointMigrators: options.checkpointMigrators }),
    ...(options.executionLeaseTtlMs === undefined
      ? {}
      : { executionLeaseTtlMs: options.executionLeaseTtlMs }),
  });
  await runtime.init();
  return { runtime, store, executors };
}

function executeRequest(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    requestId: 'request-1',
    subAgent: 'researcher',
    executor: 'local',
    input: { value: 'alpha' },
    ...overrides,
  };
}

async function replacePersistedBinding(
  store: RecordingRuntimeStateStore,
  taskId: string,
  binding: SubAgentExecutorBinding,
): Promise<void> {
  const lease = await store.acquireLease(`fixture-binding:${taskId}`, 10_000);
  try {
    await store.transaction(SESSION_ID, lease, async (transaction) => {
      const current = await transaction.loadTask(taskId);
      if (current === undefined) throw new Error('fixture task is missing');
      const next = {
        ...current,
        binding,
        revision: current.revision + 1,
        fencingToken: lease.fencingToken,
        updatedAt: Date.now(),
      };
      if (
        !(await transaction.compareAndSetTask(taskId, current.revision, lease.fencingToken, next))
      ) {
        throw new Error('fixture binding CAS failed');
      }
    });
  } finally {
    await lease.release();
  }
}

async function createPausedAdapterV2Fixture(): Promise<{
  readonly store: RecordingRuntimeStateStore;
  readonly taskId: string;
  readonly approvalId: string;
  readonly approvalRevision: number;
}> {
  const executor = new RuntimeTestExecutor(
    'local',
    async (execution, control) => {
      await control.commitBinding('binding-v2', createBinding(execution, 'local', '1', '2'));
      const directive = await control.authorizeTool(
        'approval-v2',
        {
          callId: 'adapter-migration-call',
          toolName: 'adapter-migration-tool',
          summary: 'Pause so the persisted binding can be upgraded.',
        },
        approvalCheckpoint('adapter-migration-call', 'adapter-migration-tool'),
      );
      if (directive.type !== 'suspend') throw new Error('expected approval suspension');
      return {
        type: 'paused',
        reason: 'approval',
        task: { taskId: execution.taskId, subAgent: execution.definition },
        approvals: [directive.request],
        checkpointRevision: directive.checkpointRevision,
      };
    },
    COMPLETE_CAPABILITIES,
    64 * 1024,
    '1',
    '2',
  );
  const { runtime, store } = await createFixture({ executors: [executor] });
  const outcome = await runtime.execute(executeRequest({ requestId: 'adapter-v2-paused' }));
  if (outcome.type !== 'paused') throw new Error('expected paused fixture task');
  const approval = outcome.approvals[0]!;
  return {
    store,
    taskId: outcome.task.taskId,
    approvalId: approval.approvalId,
    approvalRevision: approval.revision,
  };
}

async function captureRejectedRuntimeDescriptor(
  operation: () => Promise<unknown>,
): Promise<Readonly<SubAgentErrorDescriptor>> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof SubAgentRuntimeError) return error.descriptor;
    throw error;
  }
  throw new Error('expected a SubAgentRuntimeError rejection');
}

function terminalErrorDescriptor(
  outcome: SubAgentExecutionOutcome,
): Readonly<SubAgentErrorDescriptor> {
  if (outcome.type !== 'terminal' || outcome.result.status === 'succeeded') {
    throw new Error('expected a non-success terminal subagent outcome');
  }
  return outcome.result.error;
}

async function triggerDefinitionVersionMismatch(
  secret: string,
): Promise<Readonly<SubAgentErrorDescriptor>> {
  const parent = createDefinition({
    ...createDefinition(),
    name: 'stable-error-parent',
    delegation: { mode: 'allowlist', definitions: ['researcher'] },
  });
  const child = createDefinition();
  const executor = new RuntimeTestExecutor();
  const initial = await createFixture({
    activeDefinitions: [parent, child],
    executors: [executor],
  });
  const parentOutcome = await initial.runtime.execute(
    executeRequest({
      requestId: 'stable-error-parent-version',
      subAgent: parent.name,
      input: { value: 'parent' },
    }),
  );
  if (parentOutcome.type !== 'terminal') throw new Error('expected a terminal parent task');

  const replacement = await createFixture({
    activeDefinitions: [child],
    executors: [executor],
    store: initial.store,
    initializeRun: false,
  });
  return captureRejectedRuntimeDescriptor(() =>
    replacement.runtime.execute(
      executeRequest({
        requestId: 'stable-error-definition-version',
        parentTaskId: parentOutcome.result.task.taskId,
        input: { value: secret },
      }),
    ),
  );
}

async function triggerInvalidInput(secret: string): Promise<Readonly<SubAgentErrorDescriptor>> {
  const { runtime } = await createFixture({});
  return captureRejectedRuntimeDescriptor(() =>
    runtime.execute(
      executeRequest({
        requestId: 'stable-error-invalid-input',
        input: { value: secret, mode: 'not-an-allowed-mode' },
      }),
    ),
  );
}

async function triggerContextProjectionFailure(
  secret: string,
): Promise<Readonly<SubAgentErrorDescriptor>> {
  const definition = createDefinition({
    contextProjector: () => {
      throw new Error(secret);
    },
  });
  const { runtime } = await createFixture({ definition });
  return captureRejectedRuntimeDescriptor(() =>
    runtime.execute(
      executeRequest({
        requestId: 'stable-error-context-projector',
        input: { value: secret },
      }),
    ),
  );
}

async function triggerAdapterStateVersionMismatch(
  secret: string,
): Promise<Readonly<SubAgentErrorDescriptor>> {
  const fixture = await createPausedAdapterV2Fixture();
  const current = fixture.store.snapshot(SESSION_ID).tasks[0]!;
  await replacePersistedBinding(fixture.store, fixture.taskId, {
    ...current.binding!,
    adapterStateVersion: '1',
    recoveryData: { token: secret },
  });
  const executor = new RuntimeTestExecutor(
    'local',
    async () => {
      throw new Error('executor must not run without a binding migration path');
    },
    COMPLETE_CAPABILITIES,
    64 * 1024,
    '1',
    '2',
  );
  const { runtime } = await createFixture({
    store: fixture.store,
    executors: [executor],
    initializeRun: false,
  });
  return captureRejectedRuntimeDescriptor(() =>
    runtime.resume(SESSION_ID, fixture.taskId, {
      decisions: [
        {
          approvalId: fixture.approvalId,
          decision: 'approved',
          expectedRevision: fixture.approvalRevision,
        },
      ],
    }),
  );
}

async function triggerApprovalRejected(secret: string): Promise<Readonly<SubAgentErrorDescriptor>> {
  const fixture = await createPausedAdapterV2Fixture();
  const executor = new RuntimeTestExecutor(
    'local',
    async () => {
      throw new Error('executor must not run after a rejected approval');
    },
    COMPLETE_CAPABILITIES,
    64 * 1024,
    '1',
    '2',
  );
  const { runtime } = await createFixture({
    store: fixture.store,
    executors: [executor],
    initializeRun: false,
  });
  const outcome = await runtime.resume(SESSION_ID, fixture.taskId, {
    decisions: [
      {
        approvalId: fixture.approvalId,
        decision: 'rejected',
        reason: secret,
        expectedRevision: fixture.approvalRevision,
      },
    ],
  });
  return terminalErrorDescriptor(outcome);
}

async function triggerChildDefinitionDisallowed(
  secret: string,
): Promise<Readonly<SubAgentErrorDescriptor>> {
  const parent = createDefinition({
    ...createDefinition(),
    name: 'stable-error-nondelegating-parent',
    delegation: { mode: 'none' },
  });
  const child = createDefinition();
  const { runtime } = await createFixture({ activeDefinitions: [parent, child] });
  const parentOutcome = await runtime.execute(
    executeRequest({
      requestId: 'stable-error-nondelegating-parent',
      subAgent: parent.name,
      input: { value: 'parent' },
    }),
  );
  if (parentOutcome.type !== 'terminal') throw new Error('expected a terminal parent task');
  return captureRejectedRuntimeDescriptor(() =>
    runtime.execute(
      executeRequest({
        requestId: 'stable-error-child-disallowed',
        parentTaskId: parentOutcome.result.task.taskId,
        input: { value: secret },
      }),
    ),
  );
}

async function triggerRecoveryUnsupported(
  secret: string,
): Promise<Readonly<SubAgentErrorDescriptor>> {
  const fixture = await createPausedAdapterV2Fixture();
  const current = fixture.store.snapshot(SESSION_ID).tasks[0]!;
  await replacePersistedBinding(fixture.store, fixture.taskId, {
    ...current.binding!,
    recoveryData: { token: secret },
  });
  const executor = new RuntimeTestExecutor(
    'local',
    async () => {
      throw new Error('executor must not run when resume recovery is disabled');
    },
    {
      ...COMPLETE_CAPABILITIES,
      approval: false,
      recovery: { resume: 'none', reconnect: 'external_binding' },
    },
    64 * 1024,
    '1',
    '2',
  );
  const { runtime } = await createFixture({
    store: fixture.store,
    executors: [executor],
    initializeRun: false,
  });
  return captureRejectedRuntimeDescriptor(() =>
    runtime.resume(SESSION_ID, fixture.taskId, {
      decisions: [
        {
          approvalId: fixture.approvalId,
          decision: 'approved',
          expectedRevision: fixture.approvalRevision,
        },
      ],
    }),
  );
}

async function triggerTimedOut(secret: string): Promise<Readonly<SubAgentErrorDescriptor>> {
  const { runtime } = await createFixture({});
  return captureRejectedRuntimeDescriptor(() =>
    runtime.execute(
      executeRequest({
        requestId: 'stable-error-timed-out',
        input: { value: secret },
        deadlineAt: Date.now() - 1,
      }),
    ),
  );
}

describe('SubAgentRuntime execution contract', () => {
  acceptanceIt('RUNTIME-01.l1.execute', 'typed-result', async () => {
    const executor = new RuntimeTestExecutor();
    const { runtime, store } = await createFixture({ executors: [executor] });

    await expect(runtime.execute(executeRequest())).resolves.toMatchObject({
      type: 'terminal',
      result: {
        status: 'succeeded',
        executor: 'local',
        output: { answer: 'proof:alpha' },
      },
    });

    const task = store.snapshot(SESSION_ID).tasks[0];
    expect(task).toMatchObject({
      state: 'succeeded',
      output: { answer: 'proof:alpha' },
      resultReceipt: { callId: 'agent-result-1', status: 'accepted' },
      completionReceipt: { callId: 'end-agent-1', status: 'completed' },
    });
    expect(executor.executeCalls).toHaveLength(1);
    expect(executor.executeCalls[0]).toMatchObject({
      executionEpoch: expect.stringMatching(/^epoch-/u),
      executionFencingToken: expect.any(String),
      operation: { type: 'create', operationId: expect.stringMatching(/^operation-/u) },
      delegation: {
        version: '1',
        ownerSessionId: SESSION_ID,
        runId: RUN_ID,
        definitions: [],
      },
    });
    expect(() => JSON.stringify(executor.executeCalls[0]!.delegation)).not.toThrow();

    executor.handler = async (request, control) => {
      await control.completion.submitResult('agent-result-not-standalone', { answer: 'unsafe' });
      await control.completion.complete('end-agent-not-standalone', { isStandalone: false });
      return candidateOutcome(request, { answer: 'unsafe' });
    };
    const rejected = await runtime.execute(
      executeRequest({ requestId: 'request-not-standalone', input: { value: 'unsafe' } }),
    );
    expect(rejected).toMatchObject({
      type: 'terminal',
      result: { status: 'failed', error: { code: 'END_AGENT_MUST_BE_STANDALONE' } },
    });
  });

  acceptanceIt(
    'REC-02.l1.checkpoint-orphan-adoption',
    'expired-execution-lease-fenced-checkpoint-adoption',
    async () => {
      const clock = new ManualClock(Date.now());
      const store = new RecordingRuntimeStateStore({ now: clock.now });
      const firstEntered = new Deferred<void>();
      const firstExecutor = new RuntimeTestExecutor('local', async (request, control) => {
        await control.commitBinding('orphan-binding', createBinding(request));
        await control.commitCheckpoint('orphan-checkpoint', childCheckpoint());
        firstEntered.resolve(undefined);
        return new Promise<never>((_resolve, reject) => {
          if (control.signal.aborted) reject(control.signal.reason);
          else
            control.signal.addEventListener('abort', () => reject(control.signal.reason), {
              once: true,
            });
        });
      });
      const first = await createFixture({
        store,
        executors: [firstExecutor],
        executionLeaseTtlMs: 30,
      });
      const original = first.runtime.execute(
        executeRequest({ requestId: 'running-orphan-adoption' }),
      );
      original.catch(() => undefined);
      await firstEntered.promise;
      const before = store.snapshot(SESSION_ID).tasks[0]!;
      expect(before).toMatchObject({
        state: 'running',
        attempt: 1,
        recoveryRequired: false,
        childCheckpoint: { version: '1' },
      });
      const firstFence = before.executionFencingToken;

      const recoveredExecutor = new RuntimeTestExecutor('local', async (request, control) => {
        expect(request.operation).toMatchObject({ type: 'resume', reason: 'checkpoint' });
        const output = { answer: 'adopted-proof' };
        await control.completion.submitResult('adopted-result', output);
        await control.completion.complete('adopted-end', { isStandalone: true });
        return candidateOutcome(request, output);
      });
      const replacement = await createFixture({
        store,
        executors: [recoveredExecutor],
        executionLeaseTtlMs: 30,
        initializeRun: false,
      });
      clock.advanceBy(31);
      const recoveredHandle = await replacement.runtime.recover(SESSION_ID, before.taskId);
      await expect(recoveredHandle.wait()).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'succeeded', output: { answer: 'adopted-proof' } },
      });

      const terminal = store.snapshot(SESSION_ID).tasks[0]!;
      expect(terminal).toMatchObject({ state: 'succeeded', attempt: 2 });
      expect(terminal.executionFencingToken).not.toBe(firstFence);
      expect(firstExecutor.executeCalls).toHaveLength(1);
      expect(recoveredExecutor.executeCalls).toHaveLength(1);
      const terminalRevision = terminal.revision;

      const secondRecovery = await replacement.runtime.recover(SESSION_ID, before.taskId);
      await expect(secondRecovery.wait()).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'succeeded' },
      });
      expect(recoveredExecutor.executeCalls).toHaveLength(1);
      expect(store.snapshot(SESSION_ID).tasks[0]?.revision).toBe(terminalRevision);
    },
  );

  it('rejects nested delegation after the parent result phase closes', async () => {
    const parentDefinition = createDefinition({
      delegation: { mode: 'allowlist', definitions: ['worker'] },
    });
    const childDefinition = defineSubAgent({
      name: 'worker',
      version: '1',
      description: 'A deterministic nested delegation target.',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ answer: z.string() }),
    });
    const executor = new RuntimeTestExecutor('local', async (request, control) => {
      await control.commitBinding('parent-binding', createBinding(request));
      const output = { answer: 'parent-proof' };
      await control.completion.submitResult('parent-result', output);

      await expect(
        control.delegation.execute({
          requestId: 'nested-after-result',
          subAgent: 'worker',
          executor: 'local',
          input: { value: 'must-not-run' },
        }),
      ).rejects.toMatchObject({ code: 'RESULT_PHASE_CLOSED' });

      await control.completion.complete('parent-end', { isStandalone: true });
      return candidateOutcome(request, output);
    });
    const store = new RecordingRuntimeStateStore();
    await store.createRun(createRun());
    const runtime = createSubAgentRuntime({
      sessionId: SESSION_ID,
      activeDefinitions: [parentDefinition, childDefinition],
      executors: [executor],
      stateStore: store,
    });
    await runtime.init();

    await expect(runtime.execute(executeRequest())).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'parent-proof' } },
    });
    expect(executor.executeCalls).toHaveLength(1);
    expect(store.snapshot(SESSION_ID).tasks).toHaveLength(1);
  });

  it('submits model Tool calls durably even when the Executor does not support host spawn', async () => {
    const executor = new RuntimeTestExecutor('local', successfulExecution, {
      ...COMPLETE_CAPABILITIES,
      spawn: false,
      cancel: false,
      events: false,
      recovery: { resume: 'checkpoint', reconnect: 'none' },
    });
    const { runtime } = await createFixture({ executors: [executor] });
    const handle = await runtime.submitTool(
      { subAgent: 'researcher', executor: 'local', input: { value: 'submitted' } },
      {
        ownerSessionId: SESSION_ID,
        runId: RUN_ID,
        requestId: 'model-call-1',
        parentContext: [],
        parentRawHistory: [],
        signal: new AbortController().signal,
      },
    );

    expect(handle.taskId).toMatch(/^task-/u);
    await expect(handle.wait()).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'proof:submitted' } },
    });
    expect(executor.executeCalls).toHaveLength(1);
    expect(executor.spawnCalls).toEqual([]);
  });

  it('rejects stream=true before touching task persistence', async () => {
    const store = new RecordingRuntimeStateStore();
    const { runtime } = await createFixture({ store });
    const find = vi.spyOn(store, 'findTaskByIdempotencyKey');
    const load = vi.spyOn(store, 'loadTask');
    const acquire = vi.spyOn(store, 'acquireLease');

    await expect(runtime.execute(executeRequest({ stream: true }))).rejects.toMatchObject({
      code: 'STREAMING_UNSUPPORTED',
    });
    expect(find).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(store.snapshot(SESSION_ID).tasks).toEqual([]);
  });

  it('replays a terminal idempotency hit before projector, catalog selection or Executor work', async () => {
    let projectionCalls = 0;
    const definition = createDefinition({
      contextProjector: () => {
        projectionCalls += 1;
        return [{ kind: 'text', name: 'proof', text: 'projected' }];
      },
    });
    const executor = new RuntimeTestExecutor();
    const { runtime } = await createFixture({ definition, executors: [executor] });
    const request = executeRequest();

    const first = await runtime.execute(request);
    executor.availability = { status: 'unavailable', reasonCode: 'AFTER_FIRST_RUN' };
    executor.handler = async () => {
      throw new Error('idempotency replay must not execute');
    };
    const replay = await runtime.execute(request);

    expect(replay).toEqual(first);
    expect(projectionCalls).toBe(1);
    expect(executor.executeCalls).toHaveLength(1);
  });

  it('uses only the explicit Executor selected against an explicitly refreshed catalog', async () => {
    const selected = new RuntimeTestExecutor('selected');
    const fallback = new RuntimeTestExecutor('fallback');
    const { runtime, store } = await createFixture({ executors: [selected, fallback] });
    selected.availability = { status: 'unavailable', reasonCode: 'OFFLINE' };

    expect(runtime.getCatalog()).toMatchObject({ revision: 1 });
    await runtime.refreshCatalog();
    expect(runtime.getCatalog()).toMatchObject({ revision: 2 });
    expect(runtime.getCatalogEntries()[0]?.executors.map(({ name }) => name)).toEqual(['fallback']);
    await expect(runtime.execute(executeRequest({ executor: 'selected' }))).rejects.toMatchObject({
      code: 'EXECUTOR_UNAVAILABLE',
    });
    expect(selected.executeCalls).toEqual([]);
    expect(fallback.executeCalls).toEqual([]);
    expect(store.snapshot(SESSION_ID).tasks).toEqual([]);
  });

  it('returns the same non-enumerating error for unknown and cross-session lookups', async () => {
    const { runtime, store } = await createFixture({});
    await runtime.execute(executeRequest());
    const taskId = store.snapshot(SESSION_ID).tasks[0]!.taskId;

    for (const lookup of [
      runtime.getTask('another-session', taskId),
      runtime.getTask(SESSION_ID, 'unknown-task'),
    ]) {
      await expect(lookup).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        descriptor: { retryable: false },
      });
    }
  });

  it('cancels an active spawned task through the trusted host handle', async () => {
    const executor = new RuntimeTestExecutor();
    const { runtime, store } = await createFixture({ executors: [executor] });
    const handle = await runtime.spawn(executeRequest());

    await vi.waitFor(() => expect(executor.spawnCalls).toHaveLength(1));
    await waitImmediate();
    await expect(handle.cancel('operator request')).resolves.toMatchObject({
      state: 'cancelled',
      error: { code: 'CANCELLED' },
    });
    await expect(handle.wait()).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'cancelled', error: { code: 'CANCELLED' } },
    });
    expect(executor.rawCancelCalls).toBe(1);
    expect(executor.cancelledBindings[0]).toMatchObject({
      taskId: handle.taskId,
      runnerId: 'test-runner',
      runnerVersion: '1',
    });
    expect(store.snapshot(SESSION_ID).runs[0]?.budget.activeExecutions).toBe(0);
  });

  acceptanceIt('RUNTIME-02.l1.cancel-run-tree', 'cancel-run-tree', async () => {
    const executor = new RuntimeTestExecutor();
    const recursiveDefinition = createDefinition({
      delegation: { mode: 'allowlist', definitions: ['researcher'], allowSelf: true },
    });
    const store = new RecordingRuntimeStateStore();
    await store.createRun(createRun());
    await store.createRun(createRun({ runId: 'other-run' }));
    const { runtime } = await createFixture({
      definition: recursiveDefinition,
      executors: [executor],
      store,
      initializeRun: false,
    });

    const parent = await runtime.spawn(executeRequest({ requestId: 'tree-parent' }));
    await vi.waitFor(() => expect(executor.spawnCalls).toHaveLength(1));
    const child = await runtime.spawn(
      executeRequest({
        requestId: 'tree-child',
        parentTaskId: parent.taskId,
        input: { value: 'child' },
      }),
    );
    await vi.waitFor(() => expect(executor.spawnCalls).toHaveLength(2));
    const grandchild = await runtime.spawn(
      executeRequest({
        requestId: 'tree-grandchild',
        parentTaskId: child.taskId,
        input: { value: 'grandchild' },
      }),
    );
    const isolated = await runtime.spawn(
      executeRequest({
        runId: 'other-run',
        requestId: 'isolated-task',
        input: { value: 'isolated' },
      }),
    );
    await vi.waitFor(() => expect(executor.spawnCalls).toHaveLength(4));

    const cancelled = await withRunOwnership(store, RUN_ID, (ownership) =>
      runtime.cancelRunDescendants(SESSION_ID, RUN_ID, ownership, 'root run cancelled', {
        operationId: 'cancel-root-run-1',
      }),
    );
    expect(new Map(cancelled.map(({ taskId, state }) => [taskId, state]))).toEqual(
      new Map([
        [parent.taskId, 'cancelled'],
        [child.taskId, 'cancelled'],
        [grandchild.taskId, 'cancelled'],
      ]),
    );
    expect((await isolated.snapshot()).state).toBe('running');

    const persisted = store.snapshot(SESSION_ID).tasks;
    expect(
      persisted
        .filter(({ runId }) => runId === RUN_ID)
        .map(({ depth, state, controlOperations }) => ({
          depth,
          state,
          operationId: controlOperations.at(-1)?.operationId,
        }))
        .sort((left, right) => left.depth - right.depth),
    ).toEqual([
      { depth: 1, state: 'cancelled', operationId: `cancel-root-run-1:${parent.taskId}` },
      { depth: 2, state: 'cancelled', operationId: `cancel-root-run-1:${child.taskId}` },
      { depth: 3, state: 'cancelled', operationId: `cancel-root-run-1:${grandchild.taskId}` },
    ]);

    const rawCancelCalls = executor.rawCancelCalls;
    await expect(
      withRunOwnership(store, RUN_ID, (ownership) =>
        runtime.cancelRunDescendants(SESSION_ID, RUN_ID, ownership, 'root run cancelled', {
          operationId: 'cancel-root-run-1',
        }),
      ),
    ).resolves.toHaveLength(3);
    expect(executor.rawCancelCalls).toBe(rawCancelCalls);
    for (const lookup of [
      withRunOwnership(store, RUN_ID, (ownership) =>
        runtime.cancelRunDescendants('another-session', RUN_ID, ownership),
      ),
      withRunOwnership(store, 'unknown-run', (ownership) =>
        runtime.cancelRunDescendants(SESSION_ID, 'unknown-run', ownership),
      ),
    ]) {
      await expect(lookup).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    }

    await withRunOwnership(store, 'other-run', (ownership) =>
      runtime.cancelRunDescendants(SESSION_ID, 'other-run', ownership, 'test cleanup'),
    );
    await Promise.all([parent.wait(), child.wait(), grandchild.wait(), isolated.wait()]);
  });

  it('retries terminal-run adapter cancellation with the same stable operation', async () => {
    const executor = new RuntimeTestExecutor();
    const adapterCancel = vi
      .spyOn(executor, 'cancel')
      .mockRejectedValueOnce(new Error('adapter unavailable on first cleanup attempt'))
      .mockResolvedValueOnce(undefined);
    const { runtime, store } = await createFixture({ executors: [executor] });
    const handle = await runtime.spawn(executeRequest({ requestId: 'retry-adapter-cleanup' }));
    await vi.waitFor(() =>
      expect(store.snapshot(SESSION_ID).tasks).toMatchObject([
        { taskId: handle.taskId, state: 'running', binding: { executorName: 'local' } },
      ]),
    );

    await withRunOwnership(store, RUN_ID, async (ownership) => {
      await expect(
        runtime.cancelRunDescendants(SESSION_ID, RUN_ID, ownership, 'retry cleanup', {
          operationId: 'stable-root-cancel',
        }),
      ).resolves.toHaveLength(1);
      expect(adapterCancel).toHaveBeenCalledOnce();
      const taskAfterFirstAttempt = store.snapshot(SESSION_ID).tasks[0]!;

      await ownership.useStateLease(async (lease) => {
        const current = (await store.loadRun(SESSION_ID, RUN_ID))!;
        const terminal: StoredAgentRun = Object.freeze({
          ...current,
          status: 'cancelled',
          revision: current.revision + 1,
          fencingToken: lease.fencingToken,
          error: Object.freeze({
            code: 'CANCELLED',
            message: 'The root run was cancelled.',
            retryable: false,
          }),
          updatedAt: Math.max(Date.now(), current.updatedAt),
        });
        await commitRuntimeStateMutation(store, SESSION_ID, lease, {
          run: { previous: current, next: terminal },
        });
      });

      await expect(
        runtime.cancelRunDescendants(SESSION_ID, RUN_ID, ownership, 'retry cleanup', {
          operationId: 'stable-root-cancel',
        }),
      ).resolves.toHaveLength(1);
      expect(adapterCancel).toHaveBeenCalledTimes(2);
      expect(adapterCancel.mock.calls[0]?.[1].operationId).toBe(
        `stable-root-cancel:${handle.taskId}`,
      );
      expect(adapterCancel.mock.calls[1]?.[1].operationId).toBe(
        adapterCancel.mock.calls[0]?.[1].operationId,
      );
      expect(store.snapshot(SESSION_ID).tasks[0]).toEqual(taskAfterFirstAttempt);
    });

    await expect(handle.wait()).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'cancelled' },
    });
  });

  it('keeps a terminal task irreversible when completion races run-descendant cancellation', async () => {
    const finish = new Deferred<void>();
    const executor = new RuntimeTestExecutor('local', async (request, control) => {
      await finish.promise;
      const output = { answer: 'racing completion' };
      await control.completion.submitResult('race-result', output);
      await control.completion.complete('race-end', { isStandalone: true });
      return candidateOutcome(request, output);
    });
    const { runtime, store } = await createFixture({ executors: [executor] });
    const handle = await runtime.submitTool(
      { subAgent: 'researcher', executor: 'local', input: { value: 'race' } },
      {
        ownerSessionId: SESSION_ID,
        runId: RUN_ID,
        requestId: 'race-request',
        parentContext: [],
        parentRawHistory: [],
        signal: new AbortController().signal,
      },
    );
    await vi.waitFor(() => expect(executor.executeCalls).toHaveLength(1));

    const cancellation = withRunOwnership(store, RUN_ID, (ownership) =>
      runtime.cancelRunDescendants(SESSION_ID, RUN_ID, ownership, 'race cancellation', {
        operationId: 'race-cancel',
      }),
    );
    finish.resolve(undefined);
    const [cancelled, outcome] = await Promise.all([cancellation, handle.wait()]);
    expect(cancelled).toHaveLength(1);
    expect(outcome.type).toBe('terminal');
    const terminal = store.snapshot(SESSION_ID).tasks[0]!;
    expect(['succeeded', 'cancelled']).toContain(terminal.state);
    const revision = terminal.revision;

    await withRunOwnership(store, RUN_ID, (ownership) =>
      runtime.cancelRunDescendants(SESSION_ID, RUN_ID, ownership, 'race cancellation', {
        operationId: 'race-cancel',
      }),
    );
    expect(store.snapshot(SESSION_ID).tasks[0]).toMatchObject({
      state: terminal.state,
      revision,
    });
    expect(store.snapshot(SESSION_ID).runs[0]?.budget.activeExecutions).toBe(0);
  });

  it('deduplicates replayed control operations and scopes artifacts to the task', async () => {
    const artifactScopes: Array<{ ownerSessionId: string; taskId: string }> = [];
    const bytes = new Uint8Array([1, 2, 3]);
    const reference = {
      version: '1' as const,
      id: 'artifact-1',
      mediaType: 'application/octet-stream',
      size: bytes.byteLength,
      sha256: '0'.repeat(64),
    };
    const artifactStore: ArtifactStore = {
      put: async (request) => {
        artifactScopes.push(request.scope);
        return reference;
      },
      get: async (scope) => {
        artifactScopes.push(scope);
        return { reference, data: bytes };
      },
      delete: async (scope) => {
        artifactScopes.push(scope);
      },
      deleteTaskArtifacts: async () => undefined,
    };
    const executor = new RuntimeTestExecutor('local', async (execution, control) => {
      await control.commitBinding('dedupe-binding', createBinding(execution));
      expect(control.artifacts).toBeDefined();
      const stored = await control.artifacts!.put({
        mediaType: reference.mediaType,
        data: bytes,
      });
      await control.artifacts!.get(stored);
      await control.artifacts!.delete(stored);
      await control.reportProgress('progress-op', { message: 'halfway', percent: 50 });
      await control.reportProgress('progress-op', { message: 'halfway', percent: 50 });
      await control.consumeBudget('budget-op', { turns: 1, providerCalls: 1 });
      await control.consumeBudget('budget-op', { turns: 1, providerCalls: 1 });
      await expect(
        control.reportProgress('progress-op', { message: 'conflict', percent: 75 }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      const output = { answer: 'artifact-proof' };
      await control.completion.submitResult('artifact-result', output);
      await control.completion.complete('artifact-end', { isStandalone: true });
      return candidateOutcome(execution, output);
    });
    const { runtime, store } = await createFixture({
      executors: [executor],
      artifactStore,
    });

    const outcome = await runtime.execute(executeRequest({ requestId: 'dedupe-artifact' }));
    expect(outcome).toMatchObject({ type: 'terminal', result: { status: 'succeeded' } });
    const task = store.snapshot(SESSION_ID).tasks[0]!;
    expect(task.usage).toMatchObject({ turns: 1, providerCalls: 1 });
    expect(
      task.controlOperations.filter(({ operationId }) => operationId === 'progress-op'),
    ).toHaveLength(1);
    expect(
      task.controlOperations.filter(({ operationId }) => operationId === 'budget-op'),
    ).toHaveLength(1);
    expect(artifactScopes).toEqual([
      { ownerSessionId: SESSION_ID, taskId: task.taskId },
      { ownerSessionId: SESSION_ID, taskId: task.taskId },
      { ownerSessionId: SESSION_ID, taskId: task.taskId },
    ]);

    const events: string[] = [];
    for await (const event of runtime.events(SESSION_ID, task.taskId, { limit: 1 })) {
      events.push(event.type);
    }
    expect(events).toContain('progress.reported');
    expect(events.filter((type) => type === 'progress.reported')).toHaveLength(1);
    expect(events.filter((type) => type === 'usage.updated')).toHaveLength(1);
  });

  it('accepts a binding at the declared byte limit and rejects one byte over it', async () => {
    const bindingLimit = 2_048;
    const executor = new RuntimeTestExecutor(
      'local',
      async (execution, control) => {
        const base = {
          ...createBinding(execution),
          recoveryData: { padding: '' },
        } satisfies SubAgentExecutorBinding;
        const baseBytes = measureCanonicalJsonBytes(base as unknown as JsonValue);
        const extra = (execution.input as { value: string }).value === 'over' ? 1 : 0;
        const binding = {
          ...base,
          recoveryData: { padding: 'x'.repeat(bindingLimit - baseBytes + extra) },
        } satisfies SubAgentExecutorBinding;
        expect(measureCanonicalJsonBytes(binding as unknown as JsonValue)).toBe(
          bindingLimit + extra,
        );
        await control.commitBinding(`binding-${extra}`, binding);
        const output = { answer: 'binding-proof' };
        await control.completion.submitResult(`binding-result-${extra}`, output);
        await control.completion.complete(`binding-end-${extra}`, { isStandalone: true });
        return candidateOutcome(execution, output);
      },
      COMPLETE_CAPABILITIES,
      bindingLimit,
    );
    const { runtime } = await createFixture({ executors: [executor] });

    await expect(
      runtime.execute(executeRequest({ requestId: 'binding-exact', input: { value: 'exact' } })),
    ).resolves.toMatchObject({ type: 'terminal', result: { status: 'succeeded' } });
    await expect(
      runtime.execute(executeRequest({ requestId: 'binding-over', input: { value: 'over' } })),
    ).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'failed', error: { code: 'BINDING_INVALID' } },
    });
  });

  it('persists child Model crash-window phases and rejects a skipped transition', async () => {
    const store = new RecordingRuntimeStateStore();
    const persistedPhases: Array<string | undefined> = [];
    const executor = new RuntimeTestExecutor('local', async (execution, control) => {
      await control.commitBinding('child-model-binding', createBinding(execution));

      const prepared = childModelCheckpoint('prepared');
      await control.commitCheckpoint('child-model-prepared', prepared);
      persistedPhases.push(
        store.snapshot(SESSION_ID).tasks[0]?.childCheckpoint?.modelOperation?.phase,
      );

      await expect(
        control.commitCheckpoint('child-model-invalid-skip', childModelCheckpoint('result_ready')),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      persistedPhases.push(
        store.snapshot(SESSION_ID).tasks[0]?.childCheckpoint?.modelOperation?.phase,
      );

      await control.commitCheckpoint('child-model-in-flight', childModelCheckpoint('in_flight'));
      persistedPhases.push(
        store.snapshot(SESSION_ID).tasks[0]?.childCheckpoint?.modelOperation?.phase,
      );

      await control.commitCheckpoint(
        'child-model-result-ready',
        childModelCheckpoint('result_ready'),
      );
      persistedPhases.push(
        store.snapshot(SESSION_ID).tasks[0]?.childCheckpoint?.modelOperation?.phase,
      );

      await control.commitCheckpoint('child-model-applied', childCheckpoint());
      persistedPhases.push(
        store.snapshot(SESSION_ID).tasks[0]?.childCheckpoint?.modelOperation?.phase,
      );

      const output = { answer: 'durable-child-model' };
      await control.completion.submitResult('child-model-result', output);
      await control.completion.complete('child-model-end', { isStandalone: true });
      return candidateOutcome(execution, output);
    });
    const { runtime } = await createFixture({ executors: [executor], store });

    await expect(
      runtime.execute(executeRequest({ requestId: 'child-model-crash-windows' })),
    ).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'durable-child-model' } },
    });
    expect(persistedPhases).toEqual([
      'prepared',
      'prepared',
      'in_flight',
      'result_ready',
      undefined,
    ]);
    expect(store.snapshot(SESSION_ID).tasks[0]?.childCheckpoint).toEqual(childCheckpoint());
  });

  it('rejects unreachable child pending-batch states before they become authoritative', async () => {
    const executor = new RuntimeTestExecutor('local', async (execution, control) => {
      await control.commitBinding('pending-invariant-binding', createBinding(execution));
      const base = approvalCheckpoint('pending-call-1', 'lookup');
      const batch = base.pendingBatch;
      const first = batch.calls[0]!;
      const second = {
        ...first,
        operationId: 'pending-operation-2',
        callId: 'pending-call-2',
        name: 'second-tool',
        order: 1,
      } as const;
      const invalid: readonly SubAgentChildCheckpoint[] = [
        {
          ...base,
          pendingBatch: {
            ...batch,
            calls: [{ ...first, status: 'result_submitted', result: 'invalid-tool-phase' }],
          },
        },
        {
          ...base,
          pendingBatch: {
            ...batch,
            calls: [
              {
                ...first,
                name: 'agent-result',
                status: 'result_ready',
                result: 'invalid-agent-result-phase',
              },
            ],
          },
        },
        {
          ...base,
          pendingBatch: { ...batch, calls: [{ ...first, taskId: 'foreign-task' }] },
        },
        {
          ...base,
          pendingBatch: {
            ...batch,
            calls: [
              {
                ...first,
                status: 'waiting_approval',
                approvals: ['approval-1', 'approval-2'],
              },
            ],
          },
        },
        {
          ...base,
          pendingBatch: {
            ...batch,
            calls: [first, { ...second, status: 'result_ready', result: 'skipped' }],
          },
        },
        {
          ...base,
          pendingBatch: {
            ...batch,
            calls: [first, { ...second, operationId: first.operationId }],
          },
        },
        {
          ...base,
          pendingBatch: {
            ...batch,
            calls: [
              {
                ...first,
                kind: 'agent',
                name: 'agent',
                status: 'in_flight',
                taskId: 'shared-task',
              },
              {
                ...second,
                kind: 'agent',
                name: 'agent',
                status: 'in_flight',
                taskId: 'shared-task',
              },
            ],
          },
        },
        {
          ...base,
          pendingBatch: {
            ...batch,
            calls: [
              {
                ...first,
                kind: 'end-agent',
                name: 'end-agent',
                status: 'result_ready',
                result: 'Agent ended.',
              },
            ],
            endRequested: true,
          },
        },
        {
          ...base,
          pendingBatch: {
            ...batch,
            calls: [
              {
                ...first,
                name: 'agent-result',
                status: 'result_submitted',
                result: JSON.stringify({
                  ok: true,
                  status: 'accepted',
                  outputHash: 'a'.repeat(64),
                }),
              },
            ],
          },
        },
      ];

      for (const [index, checkpoint] of invalid.entries()) {
        await expect(
          control.commitCheckpoint(`pending-invariant-${index}`, checkpoint),
        ).rejects.toMatchObject({ code: 'CHECKPOINT_MIGRATION_FAILED' });
      }

      const output = { answer: 'invalid-checkpoints-rejected' };
      await control.completion.submitResult('pending-invariant-result', output);
      await control.completion.complete('pending-invariant-end', { isStandalone: true });
      return candidateOutcome(execution, output);
    });
    const { runtime, store } = await createFixture({ executors: [executor] });

    await expect(
      runtime.execute(executeRequest({ requestId: 'pending-invariant-validation' })),
    ).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'invalid-checkpoints-rejected' } },
    });
    expect(store.snapshot(SESSION_ID).tasks[0]?.childCheckpoint).toBeUndefined();
  });

  it('accepts only the size-bounded child result proof matching the authoritative result CAS', async () => {
    const output = { answer: 'authoritative-result-proof' };
    const executor = new RuntimeTestExecutor('local', async (execution, control) => {
      await control.commitBinding('result-proof-binding', createBinding(execution));
      const invalidCallInput = {};
      await expect(
        control.commitCheckpoint('result-proof-reserved-name', {
          ...childCheckpoint(),
          pendingBatch: {
            version: '1',
            batchId: 'result-proof-reserved-name-batch',
            assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
            calls: [
              {
                version: '1',
                operationId: 'result-proof-reserved-name-operation',
                kind: 'tool',
                callId: 'result-proof-reserved-name-call',
                name: 'agent',
                input: invalidCallInput,
                inputHash: canonicalJsonSha256(invalidCallInput),
                status: 'prepared',
                order: 0,
              },
            ],
            endRequested: false,
            createdAt: 1_000,
          },
        }),
      ).rejects.toMatchObject({ code: 'CHECKPOINT_MIGRATION_FAILED' });
      await expect(
        control.commitCheckpoint('result-proof-agent-without-task', {
          ...childCheckpoint(),
          pendingBatch: {
            version: '1',
            batchId: 'result-proof-agent-without-task-batch',
            assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
            calls: [
              {
                version: '1',
                operationId: 'result-proof-agent-without-task-operation',
                kind: 'agent',
                callId: 'result-proof-agent-without-task-call',
                name: 'agent',
                input: invalidCallInput,
                inputHash: canonicalJsonSha256(invalidCallInput),
                status: 'in_flight',
                order: 0,
              },
            ],
            endRequested: false,
            createdAt: 1_000,
          },
        }),
      ).rejects.toMatchObject({ code: 'CHECKPOINT_MIGRATION_FAILED' });
      await control.completion.submitResult('result-proof-call', output);

      await expect(
        control.commitCheckpoint('result-proof-missing', childCheckpoint()),
      ).rejects.toMatchObject({ code: 'RESULT_REQUIRED' });
      await expect(
        control.commitCheckpoint(
          'result-proof-conflict',
          childResultCheckpoint('result-proof-call', { answer: 'conflicting-result' }),
        ),
      ).rejects.toMatchObject({ code: 'RESULT_REPLAY_CONFLICT' });
      const staleInput = { result: output, extra: true };
      await expect(
        control.commitCheckpoint('result-proof-stale-call', {
          ...childResultCheckpoint('result-proof-call', output),
          pendingBatch: {
            version: '1',
            batchId: 'result-proof-stale-batch',
            assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
            calls: [
              {
                version: '1',
                operationId: 'result-proof-stale-operation',
                kind: 'tool',
                callId: 'result-proof-call',
                name: 'agent-result',
                input: staleInput,
                inputHash: canonicalJsonSha256(staleInput),
                status: 'in_flight',
                order: 0,
              },
            ],
            endRequested: false,
            createdAt: 1_001,
          },
        }),
      ).rejects.toMatchObject({ code: 'CHECKPOINT_MIGRATION_FAILED' });
      const linkedInput = { result: output };
      await expect(
        control.commitCheckpoint('result-proof-stale-tool-output', {
          ...childResultCheckpoint('result-proof-call', output),
          pendingBatch: {
            version: '1',
            batchId: 'result-proof-stale-output-batch',
            assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
            calls: [
              {
                version: '1',
                operationId: 'result-proof-stale-output-operation',
                kind: 'tool',
                callId: 'result-proof-call',
                name: 'agent-result',
                input: linkedInput,
                inputHash: canonicalJsonSha256(linkedInput),
                status: 'result_submitted',
                result: JSON.stringify({
                  ok: true,
                  status: 'accepted',
                  outputHash: 'b'.repeat(64),
                }),
                order: 0,
              },
            ],
            endRequested: false,
            createdAt: 1_001,
          },
        }),
      ).rejects.toMatchObject({ code: 'CHECKPOINT_MIGRATION_FAILED' });

      await control.commitCheckpoint('result-proof-valid-tool-output', {
        ...childResultCheckpoint('result-proof-call', output),
        pendingBatch: {
          version: '1',
          batchId: 'result-proof-valid-output-batch',
          assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
          calls: [
            {
              version: '1',
              operationId: 'result-proof-valid-output-operation',
              kind: 'tool',
              callId: 'result-proof-call',
              name: 'agent-result',
              input: linkedInput,
              inputHash: canonicalJsonSha256(linkedInput),
              status: 'result_submitted',
              // ToolExecutionRecord persists handler output as a JSON string in pending checkpoints.
              result: JSON.stringify({
                ok: true,
                status: 'accepted',
                outputHash: canonicalJsonSha256(output),
              }),
              order: 0,
            },
          ],
          endRequested: false,
          createdAt: 1_001,
        },
      });
      const unrelatedInput = {};
      await expect(
        control.commitCheckpoint('result-proof-unrelated-tool', {
          ...childResultCheckpoint('result-proof-call', output),
          pendingBatch: {
            version: '1',
            batchId: 'result-proof-unrelated-batch',
            assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
            calls: [
              {
                version: '1',
                operationId: 'result-proof-unrelated-operation',
                kind: 'tool',
                callId: 'unrelated-call',
                name: 'unrelated-tool',
                input: unrelatedInput,
                inputHash: canonicalJsonSha256(unrelatedInput),
                status: 'in_flight',
                order: 0,
              },
            ],
            endRequested: false,
            createdAt: 1_001,
          },
        }),
      ).rejects.toMatchObject({ code: 'CHECKPOINT_MIGRATION_FAILED' });
      const oversized = { answer: 'x'.repeat(256 * 1024) };
      await expect(
        control.commitCheckpoint(
          'result-proof-oversized',
          childResultCheckpoint('result-proof-call', oversized),
        ),
      ).rejects.toMatchObject({ code: 'CHECKPOINT_MIGRATION_FAILED' });

      const endInput = {};
      await control.commitCheckpoint('result-proof-valid', {
        ...childResultCheckpoint('result-proof-call', output),
        pendingBatch: {
          version: '1',
          batchId: 'result-proof-end-batch',
          assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
          calls: [
            {
              version: '1',
              operationId: 'result-proof-end-operation',
              kind: 'end-agent',
              callId: 'result-proof-end-call',
              name: 'end-agent',
              input: endInput,
              inputHash: canonicalJsonSha256(endInput),
              status: 'in_flight',
              order: 0,
            },
          ],
          endRequested: false,
          createdAt: 1_002,
        },
      });
      await control.completion.complete('result-proof-end', { isStandalone: true });
      return candidateOutcome(execution, output);
    });
    const { runtime, store } = await createFixture({ executors: [executor] });

    await expect(
      runtime.execute(executeRequest({ requestId: 'result-proof-validation' })),
    ).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output },
    });
    expect(store.snapshot(SESSION_ID).tasks[0]?.childCheckpoint?.resultSubmission).toEqual({
      version: '1',
      callId: 'result-proof-call',
      output,
      outputHash: canonicalJsonSha256(output),
    });
  });

  it('applies only a runner-scoped copy-on-write child checkpoint migrator', async () => {
    const legacy = {
      ...childCheckpoint(),
      version: '0',
      runnerVersion: '0',
    } as const;
    const original = structuredClone(legacy);
    const migrator: AgentCheckpointMigrator = {
      recordKind: 'child-checkpoint',
      fromVersion: '0',
      toVersion: '1',
      runnerId: 'test-runner',
      fromRunnerVersion: '0',
      toRunnerVersion: '1',
      migrate: (value) => ({
        ...(value as Record<string, JsonValue>),
        version: '1',
        runnerVersion: '1',
      }),
    };
    const executor = new RuntimeTestExecutor('local', async (execution, control) => {
      await control.commitBinding('migrator-binding', createBinding(execution));
      await control.commitCheckpoint('migrator-checkpoint', legacy as never);
      const output = { answer: 'migrated' };
      await control.completion.submitResult('migrator-result', output);
      await control.completion.complete('migrator-end', { isStandalone: true });
      return candidateOutcome(execution, output);
    });
    const { runtime, store } = await createFixture({
      executors: [executor],
      checkpointMigrators: [migrator],
    });

    await expect(
      runtime.execute(executeRequest({ requestId: 'checkpoint-migrator' })),
    ).resolves.toMatchObject({ type: 'terminal', result: { status: 'succeeded' } });
    expect(legacy).toEqual(original);
    const pausedTask = store.snapshot(SESSION_ID).tasks[0]!;
    expect(pausedTask.childCheckpoint).toMatchObject({
      version: '1',
      runnerId: 'test-runner',
      runnerVersion: '1',
    });
  });

  it('supports same-schema multi-hop runner migration without mutating the source checkpoint', async () => {
    const legacy = { ...childCheckpoint(), runnerVersion: '0' } as const;
    const original = structuredClone(legacy);
    const migrators: readonly AgentCheckpointMigrator[] = [
      {
        recordKind: 'child-checkpoint',
        fromVersion: '1',
        toVersion: '1',
        runnerId: 'test-runner',
        fromRunnerVersion: '0',
        toRunnerVersion: '1',
        migrate: (value) => ({ ...(value as Record<string, JsonValue>), runnerVersion: '1' }),
      },
      {
        recordKind: 'child-checkpoint',
        fromVersion: '1',
        toVersion: '1',
        runnerId: 'test-runner',
        fromRunnerVersion: '1',
        toRunnerVersion: '2',
        migrate: (value) => ({ ...(value as Record<string, JsonValue>), runnerVersion: '2' }),
      },
    ];
    const executor = new RuntimeTestExecutor(
      'local',
      async (execution, control) => {
        await control.commitBinding('multi-hop-binding', createBinding(execution, 'local', '2'));
        await control.commitCheckpoint('multi-hop-checkpoint', legacy as never);
        const output = { answer: 'multi-hop' };
        await control.completion.submitResult('multi-hop-result', output);
        await control.completion.complete('multi-hop-end', { isStandalone: true });
        return candidateOutcome(execution, output);
      },
      COMPLETE_CAPABILITIES,
      64 * 1024,
      '2',
    );
    const { runtime, store } = await createFixture({
      executors: [executor],
      checkpointMigrators: migrators,
    });

    await expect(
      runtime.execute(executeRequest({ requestId: 'checkpoint-multi-hop' })),
    ).resolves.toMatchObject({ type: 'terminal', result: { status: 'succeeded' } });
    expect(legacy).toEqual(original);
    expect(store.snapshot(SESSION_ID).tasks[0]?.childCheckpoint).toMatchObject({
      version: '1',
      runnerId: 'test-runner',
      runnerVersion: '2',
    });
  });

  it('does not persist a partial checkpoint when a later runner migration fails', async () => {
    const legacy = { ...childCheckpoint(), runnerVersion: '0' } as const;
    const original = structuredClone(legacy);
    const migrators: readonly AgentCheckpointMigrator[] = [
      {
        recordKind: 'child-checkpoint',
        fromVersion: '1',
        toVersion: '1',
        runnerId: 'test-runner',
        fromRunnerVersion: '0',
        toRunnerVersion: '1',
        migrate: (value) => ({ ...(value as Record<string, JsonValue>), runnerVersion: '1' }),
      },
      {
        recordKind: 'child-checkpoint',
        fromVersion: '1',
        toVersion: '1',
        runnerId: 'test-runner',
        fromRunnerVersion: '1',
        toRunnerVersion: '2',
        migrate: () => {
          throw new Error('simulated migration failure');
        },
      },
    ];
    const executor = new RuntimeTestExecutor(
      'local',
      async (execution, control) => {
        await control.commitBinding('failing-binding', createBinding(execution, 'local', '2'));
        await control.commitCheckpoint('failing-checkpoint', legacy as never);
        throw new Error('unreachable');
      },
      COMPLETE_CAPABILITIES,
      64 * 1024,
      '2',
    );
    const { runtime, store } = await createFixture({
      executors: [executor],
      checkpointMigrators: migrators,
    });

    await expect(
      runtime.execute(executeRequest({ requestId: 'checkpoint-failing-migration' })),
    ).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'failed', error: { code: 'CHECKPOINT_MIGRATION_FAILED' } },
    });
    expect(legacy).toEqual(original);
    expect(store.snapshot(SESSION_ID).tasks[0]?.childCheckpoint).toBeUndefined();
  });

  it('migrates a persisted binding through same-schema adapter hops before approval resume', async () => {
    const fixture = await createPausedAdapterV2Fixture();
    const current = fixture.store.snapshot(SESSION_ID).tasks[0]!;
    const legacy = {
      ...current.binding!,
      adapterStateVersion: '0',
      recoveryData: { adapter: '0' },
    };
    await replacePersistedBinding(fixture.store, fixture.taskId, legacy);
    const migrators: readonly AgentCheckpointMigrator[] = [
      {
        recordKind: 'executor-binding',
        fromVersion: '1',
        toVersion: '1',
        executorName: 'local',
        fromAdapterStateVersion: '0',
        toAdapterStateVersion: '1',
        migrate: (value) => ({
          ...(value as Record<string, JsonValue>),
          adapterStateVersion: '1',
          recoveryData: { adapter: '1' },
        }),
      },
      {
        recordKind: 'executor-binding',
        fromVersion: '1',
        toVersion: '1',
        executorName: 'local',
        fromAdapterStateVersion: '1',
        toAdapterStateVersion: '2',
        migrate: (value) => ({
          ...(value as Record<string, JsonValue>),
          adapterStateVersion: '2',
          recoveryData: { adapter: '2' },
        }),
      },
    ];
    const executor = new RuntimeTestExecutor(
      'local',
      async (execution, control) => {
        if (execution.operation.type !== 'resume') throw new Error('expected resume operation');
        const approval = await control.authorizeTool(
          'adapter-resume-approval',
          {
            callId: 'adapter-migration-call',
            toolName: 'adapter-migration-tool',
            summary: 'Pause so the persisted binding can be upgraded.',
          },
          execution.operation.checkpoint,
        );
        if (approval.type !== 'approved') throw new Error('expected approval decision');
        const output = { answer: 'adapter-v2' };
        await control.completion.submitResult('adapter-result', output);
        await control.completion.complete('adapter-end', { isStandalone: true });
        return candidateOutcome(execution, output);
      },
      COMPLETE_CAPABILITIES,
      64 * 1024,
      '1',
      '2',
    );
    const { runtime } = await createFixture({
      store: fixture.store,
      executors: [executor],
      checkpointMigrators: migrators,
      initializeRun: false,
    });

    await expect(
      runtime.resume(SESSION_ID, fixture.taskId, {
        decisions: [
          {
            approvalId: fixture.approvalId,
            decision: 'approved',
            expectedRevision: fixture.approvalRevision,
          },
        ],
      }),
    ).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'adapter-v2' } },
    });
    expect(fixture.store.snapshot(SESSION_ID).tasks[0]?.binding).toMatchObject({
      version: '1',
      adapterStateVersion: '2',
      recoveryData: { adapter: '2' },
      taskId: fixture.taskId,
    });
  });

  it.each([
    {
      name: 'migration failure',
      migrate: () => {
        throw new Error('simulated adapter migration failure');
      },
    },
    {
      name: 'identity tamper',
      migrate: (value: JsonValue) => ({
        ...(value as Record<string, JsonValue>),
        adapterStateVersion: '2',
        taskId: 'tampered-task',
      }),
    },
  ])('preserves the original persisted binding after $name', async ({ migrate }) => {
    const fixture = await createPausedAdapterV2Fixture();
    const current = fixture.store.snapshot(SESSION_ID).tasks[0]!;
    const legacy = {
      ...current.binding!,
      adapterStateVersion: '1',
      recoveryData: { adapter: 'original' },
    };
    await replacePersistedBinding(fixture.store, fixture.taskId, legacy);
    const executor = new RuntimeTestExecutor(
      'local',
      async () => {
        throw new Error('Executor must not run when binding migration fails.');
      },
      COMPLETE_CAPABILITIES,
      64 * 1024,
      '1',
      '2',
    );
    const { runtime } = await createFixture({
      store: fixture.store,
      executors: [executor],
      checkpointMigrators: [
        {
          recordKind: 'executor-binding',
          fromVersion: '1',
          toVersion: '1',
          executorName: 'local',
          fromAdapterStateVersion: '1',
          toAdapterStateVersion: '2',
          migrate,
        },
      ],
      initializeRun: false,
    });

    await expect(
      runtime.resume(SESSION_ID, fixture.taskId, {
        decisions: [
          {
            approvalId: fixture.approvalId,
            decision: 'approved',
            expectedRevision: fixture.approvalRevision,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_MIGRATION_FAILED' });
    expect(fixture.store.snapshot(SESSION_ID).tasks[0]?.binding).toEqual(legacy);
    expect(executor.executeCalls).toHaveLength(0);
  });

  acceptanceIt('APP-01.l1.resume', 'approval-resume', async () => {
    const operationTypes: string[] = [];
    const executor = new RuntimeTestExecutor('local', async (request, control) => {
      operationTypes.push(
        request.operation.type === 'resume'
          ? `${request.operation.type}:${request.operation.reason}`
          : request.operation.type,
      );
      if (request.operation.type === 'create') {
        await control.commitBinding('approval-binding', createBinding(request));
        const approvalInput = {
          callId: 'dangerous-call',
          toolName: 'dangerous-tool',
          summary: 'Permit the deterministic test operation.',
        };
        const checkpoint = approvalCheckpoint('dangerous-call', 'dangerous-tool');
        const conflictingCheckpoint = {
          ...structuredClone(checkpoint),
          pendingBatch: {
            ...structuredClone(checkpoint.pendingBatch),
            batchId: 'conflicting-approval-batch',
          },
        };
        const [first, second, conflicting] = await Promise.allSettled([
          control.authorizeTool('approval-request', approvalInput, checkpoint),
          control.authorizeTool('approval-request', approvalInput, structuredClone(checkpoint)),
          control.authorizeTool('approval-request', approvalInput, conflictingCheckpoint),
        ]);
        if (first.status !== 'fulfilled' || second.status !== 'fulfilled') {
          throw new Error('expected exact approval operation replay');
        }
        const directive = first.value;
        const replay = second.value;
        expect(replay).toEqual(directive);
        expect(conflicting).toMatchObject({
          status: 'rejected',
          reason: { code: 'IDEMPOTENCY_CONFLICT' },
        });
        if (directive.type !== 'suspend') throw new Error('expected approval suspension');
        return {
          type: 'paused',
          reason: 'approval',
          task: { taskId: request.taskId, subAgent: request.definition },
          approvals: [directive.request],
          checkpointRevision: directive.checkpointRevision,
        };
      }

      if (request.operation.type !== 'resume') throw new Error('expected resume operation');
      const directive = await control.authorizeTool(
        'approval-resume',
        {
          callId: 'dangerous-call',
          toolName: 'dangerous-tool',
          summary: 'Permit the deterministic test operation.',
        },
        request.operation.checkpoint,
      );
      if (directive.type !== 'approved') throw new Error('expected committed approval');
      const output = { answer: 'approved-proof' };
      await control.completion.submitResult('approved-result', output);
      await control.completion.complete('approved-end', { isStandalone: true });
      return candidateOutcome(request, output);
    });
    const { runtime, store } = await createFixture({ executors: [executor] });

    const paused = await runtime.execute(executeRequest());
    expect(paused).toMatchObject({ type: 'paused', reason: 'approval' });
    if (paused.type !== 'paused') throw new Error('expected paused outcome');
    const approval = paused.approvals[0]!;
    const pausedTask = store.snapshot(SESSION_ID).tasks[0]!;
    expect(pausedTask.childCheckpoint).toMatchObject({
      pendingBatch: {
        calls: [
          {
            callId: 'dangerous-call',
            status: 'waiting_approval',
            approvals: [approval.approvalId],
          },
        ],
      },
    });
    expect(pausedTask.approvals).toHaveLength(1);
    expect(pausedTask.controlOperations.filter(({ kind }) => kind === 'approval')).toHaveLength(1);
    const resumed = await runtime.resume(SESSION_ID, paused.task.taskId, {
      decisions: [
        {
          approvalId: approval.approvalId,
          decision: 'approved',
          expectedRevision: approval.revision,
        },
      ],
    });

    expect(resumed).toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'approved-proof' } },
    });
    expect(operationTypes).toEqual(['create', 'resume:approval']);
    expect(store.snapshot(SESSION_ID).tasks[0]).toMatchObject({
      state: 'succeeded',
      attempt: 2,
      approvals: [],
      approvalDecisions: [{ approvalId: approval.approvalId, decision: 'approved' }],
    });
  });

  acceptanceIt('APP-05.l1.nested-delegation-approval', 'multi-leaf-partial', async () => {
    const parentDefinition = createDefinition({
      name: 'coordinator',
      delegation: { mode: 'allowlist', definitions: ['approval-worker'] },
    });
    const workerDefinition = defineSubAgent({
      name: 'approval-worker',
      version: '1',
      description: 'Pause on one guarded operation before returning a typed proof.',
      inputSchema: z.object({ lane: z.enum(['first', 'second']) }),
      outputSchema: z.object({ answer: z.string() }),
    });
    const workerResumes: string[] = [];
    const parentTaskIds: string[] = [];
    const executor = new RuntimeTestExecutor('local', async (request, control) => {
      await control.commitBinding(`binding:${request.taskId}`, createBinding(request));
      if (request.definition.name === workerDefinition.name) {
        const lane = (request.input as { lane: 'first' | 'second' }).lane;
        const toolCallId = `guarded-${lane}`;
        if (request.operation.type === 'create') {
          const directive = await control.authorizeTool(
            `approval:${lane}`,
            {
              callId: toolCallId,
              toolName: 'guarded-worker-tool',
              summary: `Approve ${lane} worker operation.`,
            },
            approvalCheckpoint(toolCallId, 'guarded-worker-tool'),
          );
          if (directive.type !== 'suspend') throw new Error('expected leaf approval pause');
          return {
            type: 'paused',
            reason: 'approval',
            task: { taskId: request.taskId, subAgent: request.definition },
            approvals: [directive.request],
            checkpointRevision: directive.checkpointRevision,
          };
        }
        workerResumes.push(lane);
        if (request.operation.type !== 'resume') throw new Error('expected worker resume');
        const directive = await control.authorizeTool(
          `approval-resume:${lane}`,
          {
            callId: toolCallId,
            toolName: 'guarded-worker-tool',
            summary: `Approve ${lane} worker operation.`,
          },
          request.operation.checkpoint,
        );
        if (directive.type !== 'approved') throw new Error('expected durable approval decision');
        const output = { answer: `worker-proof:${lane}` };
        await control.completion.submitResult(`result:${lane}`, output);
        await control.completion.complete(`end:${lane}`, { isStandalone: true });
        return candidateOutcome(request, output);
      }

      parentTaskIds.push(request.taskId);
      if (request.operation.type === 'create') {
        const leafOutcomes = await Promise.all(
          (['first', 'second'] as const).map((lane) =>
            control.delegation.execute({
              requestId: `nested:${lane}`,
              subAgent: workerDefinition.name,
              executor: 'local',
              input: { lane },
            }),
          ),
        );
        if (leafOutcomes.some((outcome) => outcome.type !== 'paused')) {
          throw new Error('expected both delegated leaves to pause');
        }
        const pausedLeaves = leafOutcomes.map((outcome, index) => {
          if (outcome.type !== 'paused') throw new Error('expected paused leaf');
          return {
            lane: (['first', 'second'] as const)[index]!,
            taskId: outcome.task.taskId,
            approvals: outcome.approvals,
          };
        });
        const pendingCalls = pausedLeaves.map((leaf, order) => {
          const input = {
            subAgent: workerDefinition.name,
            executor: 'local',
            input: { lane: leaf.lane },
          };
          return {
            version: '1' as const,
            operationId: `delegate-operation:${leaf.lane}`,
            kind: 'agent' as const,
            callId: `delegate:${leaf.lane}`,
            name: 'agent',
            input,
            inputHash: canonicalJsonSha256(input),
            status: 'waiting_approval' as const,
            order,
            taskId: leaf.taskId,
            approvals: leaf.approvals.map(({ approvalId }) => approvalId),
          };
        });
        const checkpoint: SubAgentChildCheckpoint = {
          ...childCheckpoint(),
          pendingBatch: {
            version: '1',
            batchId: 'delegated-approval-batch',
            assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
            calls: pendingCalls,
            endRequested: false,
            createdAt: 1_002,
          },
        };
        const pauseInput = {
          checkpoint,
          calls: pausedLeaves.map((leaf) => ({
            callId: `delegate:${leaf.lane}`,
            childTaskId: leaf.taskId,
            approvals: leaf.approvals,
          })),
        };
        const receipt = await control.pauseDelegation('delegation-pause', pauseInput);
        expect(await control.pauseDelegation('delegation-pause', pauseInput)).toEqual(receipt);
        return {
          type: 'paused',
          reason: 'approval',
          task: { taskId: request.taskId, subAgent: request.definition },
          approvals: receipt.approvals,
          checkpointRevision: receipt.checkpointRevision,
        };
      }

      if (request.operation.type !== 'resume') throw new Error('expected parent resume');
      const calls = request.operation.checkpoint.pendingBatch?.calls ?? [];
      const handles = await Promise.all(
        calls.map((call) => control.delegation.resumeTool(call.taskId!)),
      );
      const outcomes = await Promise.all(handles.map((handle) => handle.wait()));
      expect(
        outcomes.map((outcome) => outcome.type === 'terminal' && outcome.result.status),
      ).toEqual(['succeeded', 'failed']);
      const output = { answer: 'parent-observed-approved-and-rejected-leaves' };
      await control.completion.submitResult('parent-result', output);
      await control.completion.complete('parent-end', { isStandalone: true });
      return candidateOutcome(request, output);
    });
    const { runtime, store } = await createFixture({
      activeDefinitions: [parentDefinition, workerDefinition as unknown as SubAgentDefinition],
      executors: [executor],
    });

    const paused = await runtime.execute(
      executeRequest({ subAgent: parentDefinition.name, requestId: 'nested-parent' }),
    );
    if (paused.type !== 'paused') throw new Error('expected parent delegation pause');
    expect(paused.approvals).toHaveLength(2);
    expect(new Set(paused.approvals.map(({ taskId }) => taskId)).size).toBe(2);
    const [firstApproval, secondApproval] = paused.approvals;

    const partial = await runtime.resume(SESSION_ID, paused.task.taskId, {
      decisions: [
        {
          approvalId: firstApproval!.approvalId,
          expectedRevision: firstApproval!.revision,
          decision: 'approved',
        },
      ],
    });
    expect(partial).toMatchObject({
      type: 'paused',
      approvals: [{ approvalId: secondApproval!.approvalId }],
    });
    await expect(runtime.wait(SESSION_ID, firstApproval!.taskId)).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded' },
    });
    expect(workerResumes).toEqual(['first']);
    expect(parentTaskIds).toHaveLength(1);

    const resumed = await runtime.resume(SESSION_ID, paused.task.taskId, {
      decisions: [
        {
          approvalId: secondApproval!.approvalId,
          expectedRevision: secondApproval!.revision,
          decision: 'rejected',
        },
      ],
    });
    expect(resumed).toMatchObject({
      type: 'terminal',
      result: {
        status: 'succeeded',
        output: { answer: 'parent-observed-approved-and-rejected-leaves' },
      },
    });
    expect(workerResumes).toEqual(['first']);
    expect(parentTaskIds).toHaveLength(2);
    const tasks = store.snapshot(SESSION_ID).tasks;
    expect(tasks).toHaveLength(3);
    expect(tasks.find(({ input }) => (input as { lane?: string }).lane === 'first')).toMatchObject({
      state: 'succeeded',
      attempt: 2,
    });
    expect(tasks.find(({ input }) => (input as { lane?: string }).lane === 'second')).toMatchObject(
      {
        state: 'failed',
        error: { code: 'APPROVAL_REJECTED' },
      },
    );
  });

  it('rejects a recovery runtime configured with different persisted limits before advancing state', async () => {
    const executor = new RuntimeTestExecutor('local', async (request, control) => {
      if (request.operation.type === 'create') {
        await control.commitBinding('frozen-limits-binding', createBinding(request));
        const directive = await control.authorizeTool(
          'frozen-limits-approval',
          {
            callId: 'frozen-limits-call',
            toolName: 'frozen-limits-tool',
            summary: 'Pause before testing the persisted task budget.',
          },
          approvalCheckpoint('frozen-limits-call', 'frozen-limits-tool'),
        );
        if (directive.type !== 'suspend') throw new Error('expected approval suspension');
        return {
          type: 'paused',
          reason: 'approval',
          task: { taskId: request.taskId, subAgent: request.definition },
          approvals: [directive.request],
          checkpointRevision: directive.checkpointRevision,
        };
      }

      throw new Error('A mismatched recovery runtime must not dispatch the Executor.');
    });
    const store = new RecordingRuntimeStateStore();
    const initial = await createFixture({
      store,
      executors: [executor],
      limits: { maxTurns: 1 },
    });
    const paused = await initial.runtime.execute(
      executeRequest({ requestId: 'frozen-limits-task' }),
    );
    if (paused.type !== 'paused') throw new Error('expected paused task');
    expect(store.snapshot(SESSION_ID).tasks[0]?.limits.maxTurns).toBe(1);
    const beforeRecovery = store.snapshot(SESSION_ID);
    expect(executor.executeCalls).toHaveLength(1);

    const replacement = await createFixture({
      store,
      executors: [executor],
      limits: { maxTurns: 99 },
      initializeRun: false,
    });
    await expect(
      replacement.runtime.resume(SESSION_ID, paused.task.taskId, {
        decisions: [
          {
            approvalId: paused.approvals[0]!.approvalId,
            decision: 'approved',
            expectedRevision: paused.approvals[0]!.revision,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_VERSION_MISMATCH' });
    expect(executor.executeCalls).toHaveLength(1);
    expect(store.snapshot(SESSION_ID)).toEqual(beforeRecovery);
  });

  it('allows only a host retry of a same-version non-success terminal task', async () => {
    const executor = new RuntimeTestExecutor('local', async (request, control) => {
      if ((request.input as { mode?: unknown }).mode === 'fail') {
        throw new SubAgentRuntimeError({
          code: 'EXECUTOR_FAILED',
          message: 'The scripted first attempt failed.',
          retryable: false,
        });
      }
      return successfulExecution(request, control);
    });
    const { runtime, store } = await createFixture({ executors: [executor] });
    const failed = await runtime.execute(
      executeRequest({ requestId: 'failed-request', input: { value: 'first', mode: 'fail' } }),
    );
    expect(failed).toMatchObject({ type: 'terminal', result: { status: 'failed' } });
    if (failed.type !== 'terminal') throw new Error('expected terminal failure');

    const retried = await runtime.execute(
      executeRequest({
        requestId: 'retry-request',
        retryOf: failed.result.task.taskId,
        input: { value: 'second', mode: 'ok' },
      }),
    );
    expect(retried).toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'proof:second' } },
    });
    const retryTask = store
      .snapshot(SESSION_ID)
      .tasks.find(({ requestId }) => requestId === 'retry-request');
    expect(retryTask).toMatchObject({ retryOf: failed.result.task.taskId, attempt: 1 });

    if (retried.type !== 'terminal') throw new Error('expected terminal success');
    await expect(
      runtime.execute(
        executeRequest({
          requestId: 'invalid-success-retry',
          retryOf: retried.result.task.taskId,
          input: { value: 'third' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  acceptanceIt('ERR-02.l1.stable-error-matrix', 'stable-error-matrix', async () => {
    const secret = 'provider-secret-body-must-not-enter-stable-errors';
    const scenarios: readonly {
      readonly code: SubAgentErrorDescriptor['code'];
      readonly message: string;
      readonly run: (secretValue: string) => Promise<Readonly<SubAgentErrorDescriptor>>;
    }[] = [
      {
        code: 'DEFINITION_VERSION_MISMATCH',
        message: 'The parent subagent definition version is unavailable.',
        run: triggerDefinitionVersionMismatch,
      },
      {
        code: 'INVALID_INPUT',
        message: 'The subagent input failed schema validation.',
        run: triggerInvalidInput,
      },
      {
        code: 'CONTEXT_PROJECTION_FAILED',
        message: 'The subagent context projector failed.',
        run: triggerContextProjectionFailure,
      },
      {
        code: 'ADAPTER_STATE_VERSION_MISMATCH',
        message: 'No Executor binding migration path is registered.',
        run: triggerAdapterStateVersionMismatch,
      },
      {
        code: 'APPROVAL_REJECTED',
        message: 'The approval request was rejected by the host.',
        run: triggerApprovalRejected,
      },
      {
        code: 'CHILD_DEFINITION_DISALLOWED',
        message: 'The parent task does not allow this child definition.',
        run: triggerChildDefinitionDisallowed,
      },
      {
        code: 'RECOVERY_UNSUPPORTED',
        message: 'The persisted Executor does not support resume.',
        run: triggerRecoveryUnsupported,
      },
      {
        code: 'TIMED_OUT',
        message: 'The subagent operation timed out.',
        run: triggerTimedOut,
      },
    ];

    for (const scenario of scenarios) {
      const descriptor = await scenario.run(secret);
      expect.soft(descriptor, scenario.code).toStrictEqual({
        code: scenario.code,
        message: scenario.message,
        retryable: false,
      });
      expect.soft(JSON.stringify(descriptor), `${scenario.code} redaction`).not.toContain(secret);
      expect.soft(Object.hasOwn(descriptor, 'causeCode'), `${scenario.code} causeCode`).toBe(false);
    }
  });
});
