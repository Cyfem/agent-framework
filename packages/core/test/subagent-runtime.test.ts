import { setImmediate as waitImmediate } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Deferred, RecordingRuntimeStateStore, acceptanceIt } from '../../../testkit';
import {
  createSubAgentRuntime,
  defineSubAgent,
  SubAgentRuntimeError,
  type ExecutorAvailabilityProbe,
  type ExecutorTaskHandle,
  type JsonValue,
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
  readonly bindingCodec = {
    adapterStateVersion: '1',
    encode: (state: JsonValue): JsonValue => state,
    decode: (value: JsonValue): JsonValue => value,
  };
  availability: ExecutorAvailabilityProbe = { status: 'available' };
  executeCalls: SubAgentExecutionRequest[] = [];
  spawnCalls: SubAgentExecutionRequest[] = [];
  rawCancelCalls = 0;
  handler: ExecuteHandler;

  constructor(
    readonly name = 'local',
    handler: ExecuteHandler = successfulExecution,
  ) {
    this.descriptor = {
      name,
      description: `${name} runtime test placement.`,
      useCases: [`Run deterministic tests on ${name}.`],
      capabilities: COMPLETE_CAPABILITIES,
      adapterStateVersion: '1',
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
    await control.commitBinding(binding);
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
}

function createBinding(
  request: SubAgentExecutionRequest,
  executorName = 'local',
): SubAgentExecutorBinding {
  return {
    executorName,
    ownerSessionId: request.ownerSessionId,
    taskId: request.taskId,
    subagentSessionId: request.subagentSessionId,
    definitionName: request.definition.name,
    definitionVersion: request.definition.version,
    adapterStateVersion: '1',
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

async function successfulExecution(
  request: SubAgentExecutionRequest,
  control: SubAgentExecutionControl,
): Promise<SubAgentExecutionOutcome> {
  await control.commitBinding(createBinding(request));
  const output = { answer: `proof:${String((request.input as { value?: unknown }).value)}` };
  await control.completion.submitResult('agent-result-1', output);
  await control.completion.complete('end-agent-1', { isStandalone: true });
  return candidateOutcome(request, output);
}

async function createFixture(options: {
  readonly definition?: SubAgentDefinition;
  readonly executors?: readonly RuntimeTestExecutor[];
  readonly store?: RecordingRuntimeStateStore;
}) {
  const store = options.store ?? new RecordingRuntimeStateStore();
  await store.createRun(createRun());
  const executors = options.executors ?? [new RuntimeTestExecutor()];
  const runtime = createSubAgentRuntime({
    sessionId: SESSION_ID,
    activeDefinitions: [options.definition ?? createDefinition()],
    executors,
    stateStore: store,
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
    expect(store.snapshot(SESSION_ID).runs[0]?.budget.activeExecutions).toBe(0);
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
        await control.commitBinding(createBinding(request));
        const directive = await control.authorizeTool({
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

      const directive = await control.authorizeTool({
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
