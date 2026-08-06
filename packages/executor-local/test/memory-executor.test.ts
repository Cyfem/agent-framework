import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  acceptanceIt,
  createExecutorConformanceChildCheckpoint,
  runSubAgentExecutorConformance,
  type ExecutorConformanceScenario,
  type SubAgentExecutorConformanceSubject,
} from '../../../testkit';

import {
  createSubAgentRuntime,
  canonicalJsonSha256,
  defineSubAgent,
  type JsonValue,
  type SubAgentChildRunner,
  type SubAgentExecutionOutcome,
  type SubAgentDefinitionRegistration,
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

function candidate(taskId: string, output: JsonValue): SubAgentExecutionOutcome {
  return {
    type: 'terminal',
    result: {
      status: 'succeeded',
      task: { taskId, subAgent: { name: definition.name, version: definition.version } },
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
      definition,
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
          return candidate(child.taskId, output);
        },
      }),
    },
  ]);
  return {
    executor: new MemorySubAgentExecutor({ registry }),
    definition: { name: definition.name, version: definition.version },
    unsupportedDefinition: { name: 'unsupported', version: '1' },
    ...(scenario === 'cancel' ? { waitUntilStarted: () => started } : {}),
  };
}

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
