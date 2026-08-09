import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  acceptanceIt,
  createExecutorConformanceControl,
  createExecutorConformanceChildCheckpoint,
  createExecutorConformanceRequest,
  runSubAgentExecutorConformance,
  type ExecutorConformanceScenario,
  type SubAgentExecutorConformanceSubject,
} from '../../../testkit';

import {
  createSubAgentRuntime,
  canonicalJsonSha256,
  DEFAULT_SUBAGENT_LIMITS,
  defineSubAgent,
  type JsonValue,
  type SubAgentChildRunner,
  type SubAgentExecutorBinding,
  type SubAgentExecutionOutcome,
  type SubAgentDefinitionRegistration,
  type SubAgentExecutionRequest,
} from '@ruixutong.manee/maneeagent-framework';

import {
  LocalSubAgentRunnerRegistry,
  MemoryAgentRuntimeStateStore,
  MemorySubAgentExecutor,
} from '../src';
import { RUN_ID, SESSION_ID, createRun } from './fixtures';

const definition = defineSubAgent({
  name: 'researcher',
  version: '2',
  description: 'Produce a deterministic local child proof.',
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ answer: z.string() }),
});

const conformanceDefinition = defineSubAgent({
  name: 'executor-conformance-researcher',
  version: '2',
  description: 'Accept the shared Executor conformance scenario input.',
  inputSchema: z.object({ scenario: z.string() }),
  outputSchema: z.object({ answer: z.string() }),
});

function candidate(
  taskId: string,
  output: JsonValue,
  subAgent = { name: definition.name, version: definition.version },
): SubAgentExecutionOutcome {
  return {
    type: 'terminal',
    result: {
      status: 'succeeded',
      task: { taskId, subAgent },
      executor: 'local',
      output,
    },
  };
}

async function createRuntime(
  runnerFactory: () => SubAgentChildRunner,
  store?: MemoryAgentRuntimeStateStore,
  runnerVersion = '1',
) {
  const stateStore = store ?? new MemoryAgentRuntimeStateStore();
  if ((await stateStore.loadRun(SESSION_ID, RUN_ID)) === undefined) {
    await stateStore.createRun(createRun());
  }
  const registry = new LocalSubAgentRunnerRegistry([
    {
      definition,
      runnerId: 'researcher-runner',
      runnerVersion,
      childCheckpointVersions: ['1'],
      create: runnerFactory,
    },
  ]);
  const executor = new MemorySubAgentExecutor({ registry });
  const runtime = createSubAgentRuntime({
    sessionId: SESSION_ID,
    activeDefinitions: [definition as unknown as SubAgentDefinitionRegistration],
    executors: [executor],
    stateStore,
  });
  await runtime.init();
  return { runtime, executor, store: stateStore };
}

function request(requestId = 'local-executor-request') {
  return {
    runId: RUN_ID,
    requestId,
    subAgent: definition.name,
    executor: 'local',
    input: { value: 'alpha' },
  };
}

function childCheckpoint(callId = 'local-approval-call', toolName = 'local-sensitive-tool') {
  const input = {};
  return {
    version: '1' as const,
    runnerId: 'researcher-runner',
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
    pendingBatch: {
      version: '1' as const,
      batchId: `batch-${callId}`,
      assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
      calls: [
        {
          version: '1' as const,
          operationId: `operation-${callId}`,
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
      createdAt: 1,
    },
  };
}

function createConformanceSubject(
  scenario: ExecutorConformanceScenario,
): SubAgentExecutorConformanceSubject {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const checkpoint = createExecutorConformanceChildCheckpoint({
    runnerId: 'researcher-runner',
    runnerVersion: '1',
  });
  const registry = new LocalSubAgentRunnerRegistry([
    {
      definition: conformanceDefinition,
      runnerId: 'researcher-runner',
      runnerVersion: '1',
      childCheckpointVersions: ['1'],
      create: () => ({
        async run(child, control) {
          if (scenario === 'cancel') {
            markStarted();
            return new Promise<SubAgentExecutionOutcome>((_resolve, reject) => {
              child.signal.addEventListener('abort', () => reject(child.signal.reason), {
                once: true,
              });
            });
          }

          if (scenario === 'approval-resume' && child.checkpoint === undefined) {
            const directive = await control.authorizeTool(
              'conformance-approval',
              {
                callId: 'conformance-sensitive-call',
                toolName: 'conformance-sensitive-tool',
                summary: 'Approve the deterministic Executor conformance action.',
              },
              checkpoint,
            );
            if (directive.type !== 'suspend') {
              throw new Error('The first approval conformance run must suspend.');
            }
            return {
              type: 'paused',
              reason: 'approval',
              task: { taskId: child.taskId, subAgent: child.definition },
              approvals: [directive.request],
              checkpointRevision: directive.checkpointRevision,
            };
          }

          if (scenario === 'approval-resume') {
            expect(child.checkpoint).toEqual({
              ...checkpoint,
              pendingBatch: {
                ...checkpoint.pendingBatch,
                calls: [
                  {
                    ...checkpoint.pendingBatch?.calls[0],
                    status: 'waiting_approval',
                    approvals: [`approval:${child.taskId}:conformance-sensitive-call`],
                  },
                ],
              },
            });
          }
          const output = { answer: `conformance:${scenario}` };
          await control.completion.submitResult(`conformance-result:${scenario}`, output);
          await control.completion.complete(`conformance-end:${scenario}`, {
            isStandalone: true,
          });
          return candidate(child.taskId, output, child.definition);
        },
      }),
    },
  ]);
  return {
    executor: new MemorySubAgentExecutor({ registry }),
    definition: { name: conformanceDefinition.name, version: conformanceDefinition.version },
    unsupportedDefinition: { name: 'unsupported', version: '1' },
    ...(scenario === 'cancel' ? { waitUntilStarted: () => started } : {}),
  };
}

function createDirectCreateHarness(blockFactory = false) {
  let factories = 0;
  let runs = 0;
  let releaseFactory = (): void => undefined;
  const factoryGate = blockFactory
    ? new Promise<void>((resolve) => {
        releaseFactory = resolve;
      })
    : undefined;
  const registry = new LocalSubAgentRunnerRegistry([
    {
      definition,
      runnerId: 'researcher-runner',
      runnerVersion: '1',
      childCheckpointVersions: ['1'],
      create: async () => {
        factories += 1;
        if (factoryGate !== undefined) await factoryGate;
        return {
          async run(child) {
            runs += 1;
            return candidate(child.taskId, { answer: 'direct-idempotency-proof' });
          },
        };
      },
    },
  ]);
  const prepare = vi.spyOn(registry, 'prepareExecution');
  const executor = new MemorySubAgentExecutor({ registry });
  const baseRequest = createExecutorConformanceRequest({
    executorName: 'local',
    taskId: 'local-create-idempotency-task',
    definition: { name: definition.name, version: definition.version },
    input: { value: 'alpha' },
  });
  const control = createExecutorConformanceControl({
    ownerSessionId: baseRequest.ownerSessionId,
    taskId: baseRequest.taskId,
    signal: baseRequest.signal,
    deadlineAt: baseRequest.deadlineAt,
    approval: 'suspend',
  }).control;
  return {
    registry,
    executor,
    baseRequest,
    control,
    prepare,
    releaseFactory,
    factories: () => factories,
    runs: () => runs,
  };
}

type CreateMutation = (request: SubAgentExecutionRequest) => SubAgentExecutionRequest;

interface HostileBindingCase {
  readonly label: string;
  readonly binding: SubAgentExecutorBinding;
  readonly getterCalls: () => number;
}

function hostileFullBindings(binding: SubAgentExecutorBinding): readonly HostileBindingCase[] {
  let proxyGetterCalls = 0;
  const proxy = new Proxy(binding, {
    get(target, property, receiver) {
      proxyGetterCalls += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  const accessorCases = (['ownerSessionId', 'taskId', 'recoveryData'] as const).map((field) => {
    let getterCalls = 0;
    const descriptors: Record<PropertyKey, PropertyDescriptor> =
      Object.getOwnPropertyDescriptors(binding);
    descriptors[field] = {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error(`The Memory Local binding ${field} getter must never execute.`);
      },
    };
    return Object.freeze({
      label: `accessor-${field}`,
      binding: Object.defineProperties({}, descriptors) as SubAgentExecutorBinding,
      getterCalls: () => getterCalls,
    });
  });

  let nestedGetterCalls = 0;
  const nestedRecoveryData = Object.defineProperties(
    {},
    {
      kind: {
        configurable: true,
        enumerable: true,
        value: 'maneeagent-memory-local/v1',
      },
      handleId: {
        configurable: true,
        enumerable: true,
        get: () => {
          nestedGetterCalls += 1;
          throw new Error('The Memory Local handleId getter must never execute.');
        },
      },
    },
  );
  const symbolBinding = { ...binding } as Record<PropertyKey, unknown>;
  symbolBinding[Symbol('hostile-memory-binding')] = 'hidden';
  const oversizedBinding = {
    ...binding,
    oversizedPadding: 'x'.repeat(70 * 1024),
  } as unknown as SubAgentExecutorBinding;

  return Object.freeze([
    Object.freeze({
      label: 'proxy',
      binding: proxy,
      getterCalls: () => proxyGetterCalls,
    }),
    ...accessorCases,
    Object.freeze({
      label: 'nested-accessor',
      binding: { ...binding, recoveryData: nestedRecoveryData } as SubAgentExecutorBinding,
      getterCalls: () => nestedGetterCalls,
    }),
    Object.freeze({
      label: 'symbol',
      binding: symbolBinding as unknown as SubAgentExecutorBinding,
      getterCalls: () => 0,
    }),
    Object.freeze({
      label: 'oversized',
      binding: oversizedBinding,
      getterCalls: () => 0,
    }),
  ]);
}

const conflictingCreateMutations: readonly [string, CreateMutation][] = [
  [
    'operation ID',
    (request) => {
      if (request.operation.type !== 'create') throw new Error('expected create request');
      return {
        ...request,
        operation: {
          type: 'create',
          operationId: 'different-create-operation',
          idempotencyKey: request.operation.idempotencyKey,
        },
      };
    },
  ],
  ['input', (request) => ({ ...request, input: { value: 'beta' } })],
  ['path', (request) => ({ ...request, path: ['different-parent', request.taskId] })],
  [
    'projected context',
    (request) => ({
      ...request,
      projectedContext: [{ kind: 'text', name: 'brief', text: 'Different context.' }],
    }),
  ],
  [
    'delegation snapshot',
    (request) => ({
      ...request,
      delegation: {
        ...request.delegation,
        catalogRevision: request.delegation.catalogRevision + 1,
      },
    }),
  ],
  [
    'limits',
    (request) => ({
      ...request,
      limits: { ...DEFAULT_SUBAGENT_LIMITS, maxTurns: DEFAULT_SUBAGENT_LIMITS.maxTurns + 1 },
    }),
  ],
  [
    'idempotency key',
    (request) => ({
      ...request,
      operation: {
        type: 'create',
        operationId: request.operation.operationId,
        idempotencyKey: 'different-idempotency-key',
      },
    }),
  ],
  ['retry lineage', (request) => ({ ...request, retryOf: 'different-terminal-task' })],
];

describe('MemorySubAgentExecutor', () => {
  acceptanceIt('EXE-LOCAL-01.l2.conformance', 'memory-local', async () => {
    await runSubAgentExecutorConformance({
      variant: 'memory-local',
      createSubject: createConformanceSubject,
    });
  });

  it('creates an isolated child runner and completes through Core typed result control', async () => {
    let factories = 0;
    const { runtime, executor } = await createRuntime(() => {
      factories += 1;
      return {
        async run(child, control) {
          expect(child.ownerSessionId).toBe(SESSION_ID);
          expect(child.runId).toBe(RUN_ID);
          expect(child.path).toEqual([child.taskId]);
          const output = { answer: `local:${String((child.input as { value: string }).value)}` };
          await control.completion.submitResult('local-result', output);
          await control.completion.complete('local-end', { isStandalone: true });
          return candidate(child.taskId, output);
        },
      };
    });

    const outcome = await runtime.execute(request());
    expect(outcome).toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', executor: 'local', output: { answer: 'local:alpha' } },
    });
    if (outcome.type !== 'terminal') throw new Error('expected terminal outcome');
    expect(factories).toBe(1);
    expect(executor.getAvailability()).toMatchObject({
      status: 'available',
      supportedDefinitions: [{ name: 'researcher', version: '2' }],
    });
    expect(executor.disposeTask(outcome.result.task.taskId)).toBe(true);
    expect(executor.disposeTask(outcome.result.task.taskId)).toBe(false);
  });

  it('prepares every identical sequential create but starts one runner and execution', async () => {
    const harness = createDirectCreateHarness();

    const first = await harness.executor.spawn(harness.baseRequest, harness.control);
    const second = await harness.executor.spawn(
      { ...harness.baseRequest, signal: new AbortController().signal },
      harness.control,
    );
    await first.wait();

    expect(second.binding).toEqual(first.binding);
    expect(harness.prepare).toHaveBeenCalledTimes(2);
    expect(harness.factories()).toBe(1);
    expect(harness.runs()).toBe(1);
  });

  it('prepares concurrent identical creates before single-flight reuse and runs once', async () => {
    const harness = createDirectCreateHarness(true);

    const first = harness.executor.spawn(harness.baseRequest, harness.control);
    await vi.waitFor(() => expect(harness.factories()).toBe(1));
    const second = harness.executor.spawn(
      { ...harness.baseRequest, signal: new AbortController().signal },
      harness.control,
    );
    await vi.waitFor(() => expect(harness.prepare).toHaveBeenCalledTimes(2));
    harness.releaseFactory();
    const [firstHandle, secondHandle] = await Promise.all([first, second]);
    await firstHandle.wait();

    expect(secondHandle.binding).toEqual(firstHandle.binding);
    expect(harness.factories()).toBe(1);
    expect(harness.runs()).toBe(1);
  });

  it.each(conflictingCreateMutations)(
    'rejects a sequential duplicate create with different %s after target preparation',
    async (_label, mutate) => {
      const harness = createDirectCreateHarness();
      await harness.executor.spawn(harness.baseRequest, harness.control);

      await expect(
        harness.executor.spawn(mutate(harness.baseRequest), harness.control),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(harness.prepare).toHaveBeenCalledTimes(2);
      expect(harness.factories()).toBe(1);
      expect(harness.runs()).toBe(1);
    },
  );

  it.each(conflictingCreateMutations)(
    'rejects a concurrent duplicate create with different %s after target preparation',
    async (_label, mutate) => {
      const harness = createDirectCreateHarness(true);
      const first = harness.executor.spawn(harness.baseRequest, harness.control);
      await vi.waitFor(() => expect(harness.factories()).toBe(1));
      const conflicting = harness.executor.spawn(mutate(harness.baseRequest), harness.control);
      await vi.waitFor(() => expect(harness.prepare).toHaveBeenCalledTimes(2));
      harness.releaseFactory();
      await first;

      await expect(conflicting).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(harness.factories()).toBe(1);
      expect(harness.runs()).toBe(1);
    },
  );

  it('fails closed when the direct Local registry shortcut receives a checkpoint', async () => {
    const harness = createDirectCreateHarness();
    const prepared = harness.registry.prepareExecution(harness.baseRequest, 'local');

    await expect(
      harness.registry.create({ ...prepared.request, checkpoint: childCheckpoint() }, 'local'),
    ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED', retryable: false });
    expect(harness.factories()).toBe(0);
    expect(harness.runs()).toBe(0);
  });

  it('rejects a hostile create operation before target preparation or runner creation', async () => {
    const harness = createDirectCreateHarness();
    let getterCalls = 0;
    const operation = Object.defineProperties(
      {},
      {
        type: { configurable: true, enumerable: true, value: 'create' },
        operationId: {
          configurable: true,
          enumerable: true,
          value: 'hostile-local-create',
        },
        idempotencyKey: {
          configurable: true,
          enumerable: true,
          value: 'hostile-local-create-key',
        },
        binding: {
          configurable: true,
          enumerable: true,
          get: () => {
            getterCalls += 1;
            throw new Error('The Local create binding getter must never execute.');
          },
        },
      },
    );
    const hostileRequest = Object.freeze({
      ...harness.baseRequest,
      operation,
    }) as SubAgentExecutionRequest;
    const before = harness.control;

    await expect(harness.executor.spawn(hostileRequest, before)).rejects.toMatchObject({
      code: 'BINDING_INVALID',
      retryable: false,
    });
    expect(getterCalls).toBe(0);
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.factories()).toBe(0);
    expect(harness.runs()).toBe(0);
  });

  it('normalizes a full public binding before cancel lookup and preserves owner secrecy', async () => {
    const harness = createDirectCreateHarness();
    const handle = await harness.executor.spawn(harness.baseRequest, harness.control);
    await handle.wait();
    expect(Object.isFrozen(handle.binding)).toBe(true);
    expect(Object.isFrozen(handle.binding.recoveryData)).toBe(true);
    const baselinePrepareCalls = harness.prepare.mock.calls.length;
    const baselineFactories = harness.factories();
    const baselineRuns = harness.runs();

    for (const hostile of hostileFullBindings(handle.binding)) {
      await expect(
        harness.executor.cancel(hostile.binding, {
          operationId: `hostile-local-cancel-${hostile.label}`,
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 1_000,
        }),
        hostile.label,
      ).rejects.toMatchObject({ code: 'BINDING_INVALID', retryable: false });
      expect(hostile.getterCalls(), hostile.label).toBe(0);
      expect(harness.prepare.mock.calls.length, hostile.label).toBe(baselinePrepareCalls);
      expect(harness.factories(), hostile.label).toBe(baselineFactories);
      expect(harness.runs(), hostile.label).toBe(baselineRuns);
    }

    await expect(
      harness.executor.cancel(
        { ...handle.binding, ownerSessionId: 'another-owner-session' },
        {
          operationId: 'cross-owner-local-cancel',
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 1_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', retryable: false });
    expect(harness.prepare).toHaveBeenCalledTimes(baselinePrepareCalls);
    expect(harness.factories()).toBe(baselineFactories);
    expect(harness.runs()).toBe(baselineRuns);
  });

  it('normalizes a full public binding before resume preparation or recovery side effects', async () => {
    const harness = createDirectCreateHarness();
    const handle = await harness.executor.spawn(harness.baseRequest, harness.control);
    await handle.wait();
    const baselinePrepareCalls = harness.prepare.mock.calls.length;
    const baselineFactories = harness.factories();
    const baselineRuns = harness.runs();
    const checkpoint = createExecutorConformanceChildCheckpoint({
      runnerId: 'researcher-runner',
      runnerVersion: '1',
    });

    for (const hostile of hostileFullBindings(handle.binding)) {
      const resumeRequest = createExecutorConformanceRequest({
        executorName: 'local',
        taskId: harness.baseRequest.taskId,
        definition: { name: definition.name, version: definition.version },
        input: harness.baseRequest.input,
        operation: {
          type: 'resume',
          operationId: `hostile-local-resume-${hostile.label}`,
          reason: 'checkpoint',
          binding: hostile.binding,
          checkpoint,
        },
      });
      const recorder = createExecutorConformanceControl({
        ownerSessionId: resumeRequest.ownerSessionId,
        taskId: resumeRequest.taskId,
        signal: resumeRequest.signal,
        deadlineAt: resumeRequest.deadlineAt,
        approval: 'approved',
      });

      await expect(
        harness.executor.execute(resumeRequest, recorder.control),
        hostile.label,
      ).rejects.toMatchObject({ code: 'BINDING_INVALID', retryable: false });
      expect(hostile.getterCalls(), hostile.label).toBe(0);
      expect(harness.prepare.mock.calls.length, hostile.label).toBe(baselinePrepareCalls);
      expect(harness.factories(), hostile.label).toBe(baselineFactories);
      expect(harness.runs(), hostile.label).toBe(baselineRuns);
      expect(recorder.snapshot(), hostile.label).toMatchObject({
        bindings: [],
        checkpoints: [],
        approvalInputs: [],
        progress: [],
        usage: [],
        events: [],
      });
    }
  });

  it('keeps the public binding codec closed without invoking hostile accessors', () => {
    const harness = createDirectCreateHarness();
    const valid = {
      kind: 'maneeagent-memory-local/v1' as const,
      handleId: 'codec-handle',
    };
    let getterCalls = 0;
    const accessor = Object.defineProperties(
      {},
      {
        kind: {
          configurable: true,
          enumerable: true,
          value: 'maneeagent-memory-local/v1',
        },
        handleId: {
          configurable: true,
          enumerable: true,
          get: () => {
            getterCalls += 1;
            throw new Error('The Memory Local codec handleId getter must never execute.');
          },
        },
      },
    );
    const withSymbol = { ...valid } as Record<PropertyKey, unknown>;
    withSymbol[Symbol('hostile-memory-state')] = 'hidden';

    expect(harness.executor.bindingCodec.decode(valid)).toEqual(valid);
    expect(harness.executor.bindingCodec.encode(valid)).toEqual(valid);
    for (const value of [
      new Proxy(valid, {
        get() {
          getterCalls += 1;
          throw new Error('The Memory Local codec Proxy getter must never execute.');
        },
      }),
      accessor,
      withSymbol,
      { ...valid, handleId: 'x'.repeat(70 * 1024) },
    ]) {
      expect(() => harness.executor.bindingCodec.decode(value as JsonValue)).toThrow(
        expect.objectContaining({ code: 'BINDING_INVALID', retryable: false }),
      );
      expect(() => harness.executor.bindingCodec.encode(value as never)).toThrow(
        expect.objectContaining({ code: 'BINDING_INVALID', retryable: false }),
      );
    }
    expect(getterCalls).toBe(0);
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.factories()).toBe(0);
    expect(harness.runs()).toBe(0);
  });

  it('reuses the exact in-memory runner for approval resume', async () => {
    let runs = 0;
    const { runtime, executor, store } = await createRuntime(() => ({
      async run(child, control) {
        runs += 1;
        const directive = await control.authorizeTool(
          `local-approval-operation-${runs}`,
          {
            callId: 'local-approval-call',
            toolName: 'local-sensitive-tool',
            summary: 'Allow the local deterministic action.',
          },
          child.checkpoint ?? childCheckpoint(),
        );
        if (directive.type === 'suspend') {
          return {
            type: 'paused',
            reason: 'approval',
            task: { taskId: child.taskId, subAgent: child.definition },
            approvals: [directive.request],
            checkpointRevision: directive.checkpointRevision,
          };
        }
        const output = { answer: 'approved-local' };
        await control.completion.submitResult('approved-result', output);
        await control.completion.complete('approved-end', { isStandalone: true });
        return candidate(child.taskId, output);
      },
    }));

    const paused = await runtime.execute(request('approval-request'));
    if (paused.type !== 'paused') throw new Error('expected approval pause');
    expect(executor.disposeTask(paused.task.taskId)).toBe(false);
    const approval = paused.approvals[0]!;
    await expect(
      runtime.resume(SESSION_ID, paused.task.taskId, {
        decisions: [
          {
            approvalId: approval.approvalId,
            decision: 'approved',
            expectedRevision: approval.revision,
          },
        ],
      }),
    ).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'approved-local' } },
    });
    expect(runs).toBe(2);
    await expect(store.loadTask(SESSION_ID, paused.task.taskId)).resolves.toMatchObject({
      attempt: 2,
      state: 'succeeded',
    });
  });

  it('reconstructs a registered runner from checkpoint after Executor process loss', async () => {
    const store = new MemoryAgentRuntimeStateStore();
    let runs = 0;
    let reconstructedCheckpoint: unknown;
    const pausingRunner = (): SubAgentChildRunner => ({
      async run(child, control) {
        runs += 1;
        if (runs === 2) reconstructedCheckpoint = child.checkpoint;
        const directive = await control.authorizeTool(
          `lost-approval-operation-${runs}`,
          {
            callId: 'lost-call',
            toolName: 'lost-tool',
            summary: 'Pause before replacing the Executor instance.',
          },
          child.checkpoint ?? childCheckpoint('lost-call', 'lost-tool'),
        );
        if (directive.type === 'suspend') {
          return {
            type: 'paused',
            reason: 'approval',
            task: { taskId: child.taskId, subAgent: child.definition },
            approvals: [directive.request],
            checkpointRevision: directive.checkpointRevision,
          };
        }
        const output = { answer: 'resumed-from-checkpoint' };
        await control.completion.submitResult('lost-result', output);
        await control.completion.complete('lost-end', { isStandalone: true });
        return candidate(child.taskId, output);
      },
    });
    const first = await createRuntime(pausingRunner, store);
    const paused = await first.runtime.execute(request('lost-target-request'));
    if (paused.type !== 'paused') throw new Error('expected approval pause');

    const replacement = await createRuntime(pausingRunner, store);
    const approval = paused.approvals[0]!;
    await expect(
      replacement.runtime.resume(SESSION_ID, paused.task.taskId, {
        decisions: [
          {
            approvalId: approval.approvalId,
            decision: 'approved',
            expectedRevision: approval.revision,
          },
        ],
      }),
    ).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'resumed-from-checkpoint' } },
    });
    expect(runs).toBe(2);
    expect(reconstructedCheckpoint).toMatchObject({
      ...childCheckpoint('lost-call', 'lost-tool'),
      pendingBatch: {
        calls: [
          {
            callId: 'lost-call',
            name: 'lost-tool',
            status: 'waiting_approval',
            approvals: [paused.approvals[0]!.approvalId],
          },
        ],
      },
    });
    expect(replacement.executor.descriptor.capabilities.recovery).toEqual({
      resume: 'checkpoint',
      reconnect: 'none',
    });
  });

  it('rejects checkpoint recovery when the persisted runner version is unavailable', async () => {
    const store = new MemoryAgentRuntimeStateStore();
    const pausingRunner = (): SubAgentChildRunner => ({
      async run(child, control) {
        const directive = await control.authorizeTool(
          'runner-mismatch-approval',
          {
            callId: 'runner-mismatch-call',
            toolName: 'runner-mismatch-tool',
            summary: 'Pause before changing the trusted runner version.',
          },
          childCheckpoint('runner-mismatch-call', 'runner-mismatch-tool'),
        );
        if (directive.type !== 'suspend') throw new Error('expected approval suspension');
        return {
          type: 'paused',
          reason: 'approval',
          task: { taskId: child.taskId, subAgent: child.definition },
          approvals: [directive.request],
          checkpointRevision: directive.checkpointRevision,
        };
      },
    });
    const first = await createRuntime(pausingRunner, store);
    const paused = await first.runtime.execute(request('runner-mismatch-request'));
    if (paused.type !== 'paused') throw new Error('expected approval pause');
    const replacement = await createRuntime(pausingRunner, store, '2');
    const approval = paused.approvals[0]!;

    await expect(
      replacement.runtime.resume(SESSION_ID, paused.task.taskId, {
        decisions: [
          {
            approvalId: approval.approvalId,
            decision: 'approved',
            expectedRevision: approval.revision,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_VERSION_MISMATCH' });
  });

  it('propagates host cancellation to the child signal and releases the runtime slot', async () => {
    const childStarted = vi.fn();
    const { runtime, store } = await createRuntime(() => ({
      run(child) {
        childStarted();
        return new Promise<SubAgentExecutionOutcome>((_resolve, reject) => {
          child.signal.addEventListener('abort', () => reject(child.signal.reason), { once: true });
        });
      },
    }));
    const handle = await runtime.spawn(request('cancel-request'));
    await vi.waitFor(() => expect(childStarted).toHaveBeenCalledOnce());

    await expect(handle.cancel('test cancellation')).resolves.toMatchObject({
      state: 'cancelled',
      error: { code: 'CANCELLED' },
    });
    await expect(handle.wait()).resolves.toMatchObject({
      type: 'terminal',
      result: { status: 'cancelled', error: { code: 'CANCELLED' } },
    });
    await expect(store.loadRun(SESSION_ID, RUN_ID)).resolves.toMatchObject({
      budget: { activeExecutions: 0 },
    });
  });
});
