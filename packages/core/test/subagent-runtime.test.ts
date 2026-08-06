import { setImmediate as waitImmediate } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Deferred, RecordingRuntimeStateStore, acceptanceIt } from '../../../testkit';
import {
  createSubAgentRuntime,
  defineSubAgent,
  SubAgentRuntimeError,
  measureCanonicalJsonBytes,
  type ExecutorAvailabilityProbe,
  type ExecutorTaskHandle,
  type JsonValue,
  type ArtifactStore,
  type AgentCheckpointMigrator,
  type StoredAgentRun,
  type SubAgentDefinition,
  type SubAgentExecutionControl,
  type SubAgentExecutionOutcome,
  type SubAgentExecutionRequest,
  type SubAgentExecutor,
  type SubAgentExecutorBinding,
  type SubAgentExecutorDescriptor,
} from '../src';

const SESSION_ID = 'runtime-test-session';
const RUN_ID = 'runtime-test-run';

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

  async cancel(binding: SubAgentExecutorBinding): Promise<void> {
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
  readonly executors?: readonly RuntimeTestExecutor[];
  readonly store?: RecordingRuntimeStateStore;
  readonly artifactStore?: ArtifactStore;
  readonly checkpointMigrators?: readonly AgentCheckpointMigrator[];
  readonly executionLeaseTtlMs?: number;
  readonly initializeRun?: boolean;
}) {
  const store = options.store ?? new RecordingRuntimeStateStore();
  if (options.initializeRun !== false) await store.createRun(createRun());
  const executors = options.executors ?? [new RuntimeTestExecutor()];
  const runtime = createSubAgentRuntime({
    sessionId: SESSION_ID,
    activeDefinitions: [options.definition ?? createDefinition()],
    executors,
    stateStore: store,
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
      await control.commitCheckpoint('checkpoint-v2', childCheckpoint());
      const directive = await control.authorizeTool('approval-v2', {
        callId: 'adapter-migration-call',
        toolName: 'adapter-migration-tool',
        summary: 'Pause so the persisted binding can be upgraded.',
      });
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
    expect(store.snapshot(SESSION_ID).tasks[0]?.childCheckpoint).toMatchObject({
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
        const approval = await control.authorizeTool('adapter-resume-approval', {
          callId: 'adapter-migration-call',
          toolName: 'adapter-migration-tool',
          summary: 'Pause so the persisted binding can be upgraded.',
        });
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
        await control.commitCheckpoint('approval-checkpoint', childCheckpoint());
        const directive = await control.authorizeTool('approval-request', {
          callId: 'dangerous-call',
          toolName: 'dangerous-tool',
          summary: 'Permit the deterministic test operation.',
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

      const directive = await control.authorizeTool('approval-resume', {
        callId: 'dangerous-call',
        toolName: 'dangerous-tool',
        summary: 'Permit the deterministic test operation.',
      });
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
});
