import { BroadcastChannel } from 'node:worker_threads';
import { clearTimeout, setTimeout } from 'node:timers';

import { describe, expect, vi } from 'vitest';
import { z } from 'zod';

import { acceptanceIt, Barrier, Deferred, RecordingRuntimeStateStore } from '../../../testkit';

import {
  canonicalJsonSha256,
  completeSubAgentTask,
  createSubAgentRuntime,
  DEFAULT_SUBAGENT_LIMITS,
  submitSubAgentResult,
  SubAgentTargetRunnerRegistry,
  type AgentRuntimeStateTransaction,
  type StateLease,
  type StoredAgentRun,
  type StoredTask,
  type SubAgentDefinitionRegistration,
  type SubAgentExecutionOutcome,
  type SubAgentRuntime,
  type SubAgentTargetRunnerManifest,
  type SubAgentTaskEvent,
  type SubAgentTaskHandle,
  type SubAgentTransportModelRequestHandler,
} from '@ruixutong.manee/maneeagent-framework';

import { decodeWorkerBinding, WorkerSubAgentExecutor } from '../src';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const TARGET_ENTRY = new URL('./fixtures/worker-completion-crash-target.mjs', import.meta.url);
const DEFINITION_REF = Object.freeze({ name: 'worker-completion-crash-child', version: '2' });
const RESULT_CALL_ID = 'worker-completion-crash-result';
const COMPLETION_CALL_ID = 'worker-completion-crash-end';
const PROOF = 'worker-authoritative-completion-proof';

type CrashScenario = 'result-receipt' | 'terminal-completion';
type BarrierState = 'result_submitted' | 'succeeded';

const definition: SubAgentDefinitionRegistration = Object.freeze({
  ...DEFINITION_REF,
  description: 'Exercise Worker completion control reply-loss windows.',
  inputSchema: z
    .object({
      scenario: z.enum(['result-receipt', 'terminal-completion']),
      proof: z.string().min(1),
      barrierId: z.string().min(1),
    })
    .strict(),
  outputSchema: z
    .object({
      proof: z.string().min(1),
      scenario: z.enum(['result-receipt', 'terminal-completion']),
      attempt: z.number().int().positive(),
      executionEpoch: z.string().min(1),
      executionFencingToken: z.string().regex(/^(0|[1-9][0-9]*)$/u),
    })
    .strict(),
});

interface CrashHarness {
  readonly sessionId: string;
  readonly runId: string;
  readonly barrierId: string;
  readonly store: CompletionCrashStateStore;
  readonly executor: WorkerSubAgentExecutor;
  readonly runtime: SubAgentRuntime;
  readonly model: ReturnType<typeof vi.fn>;
  readonly crashChannel: BroadcastChannel;
}

class CompletionCrashStateStore extends RecordingRuntimeStateStore {
  readonly reached = new Deferred<StoredTask>();
  readonly #release = new Barrier();
  readonly #barrierState: BarrierState;
  #triggered = false;

  constructor(barrierState: BarrierState, transactionDomainId: string) {
    super({ transactionDomainId });
    this.#barrierState = barrierState;
  }

  override async transaction<T>(
    ownerSessionId: string,
    lease: StateLease,
    work: (transaction: AgentRuntimeStateTransaction) => Promise<T>,
  ): Promise<T> {
    const result = await super.transaction(ownerSessionId, lease, work);
    if (!this.#triggered) {
      const task = this.snapshot(ownerSessionId).tasks.find(
        (candidate) => candidate.state === this.#barrierState,
      );
      if (task !== undefined) {
        this.#triggered = true;
        this.reached.resolve(task);
        await this.#release.wait();
      }
    }
    return result;
  }

  release(): void {
    this.#release.release();
  }
}

function createExpectedManifest(): SubAgentTargetRunnerManifest {
  return new SubAgentTargetRunnerRegistry()
    .register({
      definition,
      runnerId: 'worker-completion-crash-runner',
      runnerVersion: '2.0.0',
      childCheckpointVersions: ['1'],
      modelBinding: {
        gatewayId: 'worker-completion-crash-model',
        protocol: 'openai-chat',
        codecVersion: '1',
      },
      create: () => ({
        run: async () => {
          throw new Error('The controller completion crash factory must not run.');
        },
      }),
    })
    .seal()
    .manifest();
}

async function createHarness(scenario: CrashScenario): Promise<CrashHarness> {
  const suffix = `${scenario}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `worker-completion-session-${suffix}`;
  const runId = `worker-completion-run-${suffix}`;
  const barrierId = `worker-completion-${suffix}`;
  const store = new CompletionCrashStateStore(
    scenario === 'result-receipt' ? 'result_submitted' : 'succeeded',
    `worker-completion-store-${suffix}`,
  );
  await store.createRun(createRun(sessionId, runId));

  const model = vi.fn<SubAgentTransportModelRequestHandler>(async () => {
    throw new Error('The completion crash fixture must not call a provider Model.');
  });
  const executor = new WorkerSubAgentExecutor({
    targetEntry: TARGET_ENTRY,
    expectedManifest: createExpectedManifest(),
    model,
    handshakeTimeoutMs: 5_000,
    terminateTimeoutMs: 50,
  });
  const runtime = createSubAgentRuntime({
    sessionId,
    activeDefinitions: [definition],
    executors: [executor],
    stateStore: store,
  });
  await runtime.init();

  return {
    sessionId,
    runId,
    barrierId,
    store,
    executor,
    runtime,
    model,
    crashChannel: new BroadcastChannel(`maneeagent-worker-completion-crash-${barrierId}`),
  };
}

function createRun(ownerSessionId: string, runId: string): StoredAgentRun {
  const now = Date.now();
  return {
    recordVersion: '1',
    ownerSessionId,
    runId,
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
    maxIterations: 1,
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
  };
}

async function spawnCrashTask(
  harness: CrashHarness,
  scenario: CrashScenario,
): Promise<SubAgentTaskHandle> {
  return harness.runtime.spawn({
    runId: harness.runId,
    requestId: `worker-completion-request-${scenario}`,
    subAgent: DEFINITION_REF.name,
    executor: 'worker',
    input: { scenario, proof: PROOF, barrierId: harness.barrierId },
  });
}

function expectedOutput(task: StoredTask, scenario: CrashScenario) {
  if (task.executionEpoch === undefined || task.executionFencingToken === undefined) {
    throw new Error('The authoritative Worker execution scope is missing.');
  }
  return {
    proof: PROOF,
    scenario,
    attempt: 1,
    executionEpoch: task.executionEpoch,
    executionFencingToken: task.executionFencingToken,
  };
}

function crashAfterBarrier(harness: CrashHarness): void {
  harness.crashChannel.postMessage('crash-after-authoritative-cas');
}

async function readAllEvents(
  runtime: SubAgentRuntime,
  sessionId: string,
  taskId: string,
): Promise<readonly SubAgentTaskEvent[]> {
  const events: SubAgentTaskEvent[] = [];
  for await (const event of runtime.events(sessionId, taskId)) events.push(event);
  return events;
}

async function expectTerminalReadOnly(
  harness: CrashHarness,
  handle: SubAgentTaskHandle,
  expected: SubAgentExecutionOutcome,
): Promise<void> {
  const beforeSnapshot = await handle.snapshot();
  const beforeEvents = await readAllEvents(harness.runtime, harness.sessionId, handle.taskId);
  const session = await harness.runtime.getSubAgentSession(
    harness.sessionId,
    beforeSnapshot.subagentSessionId,
  );
  expect(session).toMatchObject({
    ownerSessionId: harness.sessionId,
    runId: harness.runId,
    taskId: handle.taskId,
    subagentSessionId: beforeSnapshot.subagentSessionId,
    subAgent: DEFINITION_REF,
  });

  await expect(harness.runtime.wait(harness.sessionId, handle.taskId)).resolves.toEqual(expected);
  await expect(handle.wait()).resolves.toEqual(expected);
  await expect(handle.cancel('terminal-read-only')).resolves.toEqual(beforeSnapshot);
  await expect(
    harness.runtime.cancel(harness.sessionId, handle.taskId, 'terminal-read-only', {
      operationId: 'worker-terminal-read-only-cancel',
    }),
  ).resolves.toEqual(beforeSnapshot);
  await expect(harness.runtime.resume(harness.sessionId, handle.taskId, {})).rejects.toMatchObject({
    code: 'INVALID_STATE_TRANSITION',
  });
  await expect(harness.runtime.reconnect(harness.sessionId, handle.taskId)).rejects.toMatchObject({
    code: 'UNSUPPORTED_CAPABILITY',
  });
  const recovered = await harness.runtime.recover(harness.sessionId, handle.taskId);
  await expect(recovered.wait()).resolves.toEqual(expected);

  expect(await handle.snapshot()).toEqual(beforeSnapshot);
  expect(await harness.runtime.getTask(harness.sessionId, handle.taskId)).toEqual(beforeSnapshot);
  expect(await readAllEvents(harness.runtime, harness.sessionId, handle.taskId)).toEqual(
    beforeEvents,
  );
}

async function expectOneLogicalJob(
  harness: CrashHarness,
  taskId: string,
  originalBinding: StoredTask['binding'],
): Promise<StoredTask> {
  const snapshot = harness.store.snapshot(harness.sessionId);
  expect(snapshot.tasks).toHaveLength(1);
  const task = snapshot.tasks[0]!;
  expect(task.taskId).toBe(taskId);
  expect(task.binding).toEqual(originalBinding);
  expect(task.attempt).toBe(1);
  expect(task.retryOf).toBeUndefined();
  expect(task.executorOperation?.attempt).toBe(1);
  expect(snapshot.events.filter(({ type }) => type === 'progress.reported')).toHaveLength(1);
  expect(snapshot.events.filter(({ type }) => type === 'recovery.started')).toHaveLength(0);
  expect(snapshot.events.filter(({ type }) => type === 'recovery.resumed')).toHaveLength(0);
  expect(harness.model).not.toHaveBeenCalled();

  if (task.binding === undefined) throw new Error('The Worker task binding is missing.');
  if (originalBinding === undefined) throw new Error('The original Worker binding is missing.');
  const decoded = decodeWorkerBinding(task.binding.recoveryData);
  expect(decoded.jobId).toBe(decodeWorkerBinding(originalBinding.recoveryData).jobId);
  return task;
}

async function expectNoLiveResources(executor: WorkerSubAgentExecutor): Promise<void> {
  await vi.waitFor(() => {
    expect(executor.diagnostics()).toMatchObject({
      activeWorkers: 0,
      startingWorkers: 0,
      ports: 0,
      timers: 0,
    });
  });
}

describe('Worker authoritative completion crash windows', () => {
  acceptanceIt(
    'C7-WORKER-28.l3.result-receipt-cas-reply-loss',
    'authoritative-partial-no-replacement-job',
    async () => {
      assertNetworkDenyGuardInstalled();
      const harness = await createHarness('result-receipt');
      let handle: SubAgentTaskHandle | undefined;
      try {
        handle = await withPhaseDeadline(
          spawnCrashTask(harness, 'result-receipt'),
          'result-receipt:spawn',
        );
        const atBarrier = await withPhaseDeadline(
          harness.store.reached.promise,
          'result-receipt:authoritative-cas',
        );
        const output = expectedOutput(atBarrier, 'result-receipt');
        expect(atBarrier).toMatchObject({
          taskId: handle.taskId,
          state: 'result_submitted',
          attempt: 1,
          output,
          resultReceipt: {
            callId: RESULT_CALL_ID,
            outputHash: canonicalJsonSha256(output),
            status: 'accepted',
          },
        });
        expect(atBarrier.completionReceipt).toBeUndefined();
        if (atBarrier.resultReceipt === undefined || atBarrier.binding === undefined) {
          throw new Error('The F08 authoritative receipt or binding is missing.');
        }
        expect(await harness.runtime.getTask(harness.sessionId, handle.taskId)).toMatchObject({
          state: 'result_submitted',
          attempt: 1,
        });

        crashAfterBarrier(harness);
        await vi.waitFor(() => expect(harness.executor.diagnostics().crashes).toBe(1));
        harness.store.release();

        const terminal = await withPhaseDeadline(handle.wait(), 'result-receipt:terminal');
        expect(terminal).toMatchObject({
          type: 'terminal',
          result: {
            status: 'failed',
            task: { taskId: handle.taskId, subAgent: DEFINITION_REF },
            executor: 'worker',
            error: {
              code: 'EXECUTOR_FAILED',
              causeCode: 'WORKER_EXIT',
              retryable: false,
            },
            partialOutput: output,
          },
        });

        const stored = await expectOneLogicalJob(harness, handle.taskId, atBarrier.binding);
        expect(stored).toMatchObject({
          state: 'failed',
          partialOutput: output,
          result: {
            status: 'failed',
            partialOutput: output,
          },
          resultReceipt: atBarrier.resultReceipt,
        });
        expect(stored.output).toBeUndefined();
        expect(stored.completionReceipt).toBeUndefined();
        const replay = submitSubAgentResult(stored, {
          callId: RESULT_CALL_ID,
          output,
          submittedAt: stored.updatedAt + 1,
        });
        expect(replay).toMatchObject({
          replayed: true,
          receipt: {
            ...atBarrier.resultReceipt,
            status: 'replayed',
          },
        });
        expect(replay.task).toEqual(stored);
        expect(
          harness.store
            .snapshot(harness.sessionId)
            .events.filter(({ type }) => type === 'recovery.failed'),
        ).toHaveLength(1);

        await expectTerminalReadOnly(harness, handle, terminal);
        expect(harness.executor.diagnostics()).toMatchObject({ crashes: 1, terminations: 0 });
        await expectNoLiveResources(harness.executor);
      } finally {
        harness.store.release();
        harness.crashChannel.close();
        await harness.executor.dispose();
      }
    },
  );

  acceptanceIt(
    'C7-WORKER-29.l3.terminal-cas-completion-reply-loss',
    'authoritative-success-no-replacement-job',
    async () => {
      assertNetworkDenyGuardInstalled();
      const harness = await createHarness('terminal-completion');
      let handle: SubAgentTaskHandle | undefined;
      try {
        handle = await withPhaseDeadline(
          spawnCrashTask(harness, 'terminal-completion'),
          'terminal-completion:spawn',
        );
        const atBarrier = await withPhaseDeadline(
          harness.store.reached.promise,
          'terminal-completion:authoritative-cas',
        );
        const output = expectedOutput(atBarrier, 'terminal-completion');
        expect(atBarrier).toMatchObject({
          taskId: handle.taskId,
          state: 'succeeded',
          attempt: 1,
          output,
          result: {
            status: 'succeeded',
            output,
          },
          resultReceipt: {
            callId: RESULT_CALL_ID,
            outputHash: canonicalJsonSha256(output),
            status: 'accepted',
          },
          completionReceipt: {
            callId: COMPLETION_CALL_ID,
            status: 'completed',
          },
        });
        if (
          atBarrier.resultReceipt === undefined ||
          atBarrier.completionReceipt === undefined ||
          atBarrier.binding === undefined
        ) {
          throw new Error('The F09 authoritative receipts or binding are missing.');
        }

        crashAfterBarrier(harness);
        await vi.waitFor(() => expect(harness.executor.diagnostics().crashes).toBe(1));
        harness.store.release();

        const terminal = await withPhaseDeadline(handle.wait(), 'terminal-completion:terminal');
        expect(terminal).toEqual({
          type: 'terminal',
          result: {
            status: 'succeeded',
            task: { taskId: handle.taskId, subAgent: DEFINITION_REF },
            executor: 'worker',
            output,
          },
        });
        if (terminal.type !== 'terminal') {
          throw new Error('The F09 Worker task did not preserve its terminal outcome.');
        }

        const stored = await expectOneLogicalJob(harness, handle.taskId, atBarrier.binding);
        expect(stored).toMatchObject({
          state: 'succeeded',
          output,
          result: terminal.result,
          resultReceipt: atBarrier.resultReceipt,
          completionReceipt: atBarrier.completionReceipt,
        });
        const resultReplay = submitSubAgentResult(stored, {
          callId: RESULT_CALL_ID,
          output,
          submittedAt: stored.updatedAt + 1,
        });
        expect(resultReplay.replayed).toBe(true);
        expect(resultReplay.task).toEqual(stored);
        const completionReplay = completeSubAgentTask(stored, {
          callId: COMPLETION_CALL_ID,
          completedAt: stored.updatedAt + 1,
          isStandalone: true,
          outputDecodable: true,
        });
        expect(completionReplay).toMatchObject({
          replayed: true,
          receipt: {
            ...atBarrier.completionReceipt,
            status: 'replayed',
          },
        });
        expect(completionReplay.task).toEqual(stored);
        expect(
          harness.store
            .snapshot(harness.sessionId)
            .events.filter(({ type }) => type.startsWith('recovery.')),
        ).toHaveLength(0);

        await expectTerminalReadOnly(harness, handle, terminal);
        expect(harness.executor.diagnostics()).toMatchObject({ crashes: 1, terminations: 0 });
        await expectNoLiveResources(harness.executor);
      } finally {
        harness.store.release();
        harness.crashChannel.close();
        await harness.executor.dispose();
      }
    },
  );
});

async function withPhaseDeadline<T>(promise: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The deterministic completion crash phase timed out: ${phase}.`)),
      5_000,
    );
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
