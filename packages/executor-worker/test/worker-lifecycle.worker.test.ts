import { performance } from 'node:perf_hooks';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  acceptanceIt,
  createExecutorConformanceControl,
  createExecutorConformanceRequest,
} from '../../../testkit';

import {
  SubAgentRuntimeError,
  SubAgentTargetRunnerRegistry,
  type SubAgentChildCheckpoint,
  type SubAgentDefinitionRegistration,
  type SubAgentExecutionRequest,
  type SubAgentExecutionOutcome,
  type SubAgentExecutorBinding,
  type SubAgentTaskHandle,
  type SubAgentTargetRunnerManifest,
  type SubAgentTransportTaskHandleResolver,
  type SubAgentTransportModelRequestHandler,
} from '@ruixutong.manee/maneeagent-framework';

import { WorkerSubAgentExecutor } from '../src';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const TARGET_ENTRY = new URL('./fixtures/worker-conformance-target.mjs', import.meta.url);
const HANDSHAKE_TIMEOUT_ENTRY = new URL(
  './fixtures/worker-handshake-timeout-target.mjs',
  import.meta.url,
);
const DUPLICATE_READY_ENTRY = new URL(
  './fixtures/worker-duplicate-ready-target.mjs',
  import.meta.url,
);
const PRE_READY_PACKET_ENTRY = new URL(
  './fixtures/worker-pre-ready-packet-target.mjs',
  import.meta.url,
);
const FORGED_MANIFEST_ENTRY = new URL(
  './fixtures/worker-forged-manifest-target.mjs',
  import.meta.url,
);
const FORGED_DIGEST_ENTRY = new URL('./fixtures/worker-forged-digest-target.mjs', import.meta.url);
const PORT_CLOSE_ENTRY = new URL('./fixtures/worker-port-close-target.mjs', import.meta.url);
const FATAL_ENTRY = new URL('./fixtures/worker-fatal-target.mjs', import.meta.url);
const DEFINITION_REF = Object.freeze({ name: 'worker-conformance-child', version: '2' });
const manifestDefinition: SubAgentDefinitionRegistration = Object.freeze({
  ...DEFINITION_REF,
  description: 'Manifest-only Worker lifecycle fixture definition.',
  inputSchema: z.json(),
  outputSchema: z.json(),
});

function createExpectedManifest(): SubAgentTargetRunnerManifest {
  return new SubAgentTargetRunnerRegistry()
    .register({
      definition: manifestDefinition,
      runnerId: 'worker-conformance-runner',
      runnerVersion: '2.0.0',
      childCheckpointVersions: ['1'],
      modelBinding: {
        gatewayId: 'worker-conformance-model',
        protocol: 'openai-chat',
        codecVersion: '1',
      },
      create: () => ({
        run: async () => {
          throw new Error('The controller manifest factory must not run.');
        },
      }),
    })
    .seal()
    .manifest();
}

function createExecutor(
  overrides: Partial<ConstructorParameters<typeof WorkerSubAgentExecutor>[0]> = {},
) {
  const model = vi.fn<SubAgentTransportModelRequestHandler>(async () => {
    throw new Error('The deterministic lifecycle fixture must not call a Model.');
  });
  return {
    model,
    executor: new WorkerSubAgentExecutor({
      targetEntry: TARGET_ENTRY,
      expectedManifest: createExpectedManifest(),
      model,
      handshakeTimeoutMs: 5_000,
      terminateTimeoutMs: 25,
      ...overrides,
    }),
  };
}

function createRequest(
  taskId: string,
  scenario: string,
  overrides: Partial<SubAgentExecutionRequest> = {},
): SubAgentExecutionRequest {
  const base = createExecutorConformanceRequest({
    executorName: 'worker',
    taskId,
    definition: DEFINITION_REF,
    input: { scenario },
  });
  return Object.freeze({ ...base, ...overrides });
}

function createControl(request: SubAgentExecutionRequest) {
  return createExecutorConformanceControl({
    ownerSessionId: request.ownerSessionId,
    taskId: request.taskId,
    signal: request.signal,
    deadlineAt: request.deadlineAt,
    approval: 'approved',
  });
}

function nestedScopeKey(scope: {
  readonly ownerSessionId: string;
  readonly parentTaskId?: string;
  readonly taskId: string;
}): string {
  return `${scope.ownerSessionId}\0${scope.parentTaskId ?? ''}\0${scope.taskId}`;
}

function createNestedTaskHandle(
  parent: SubAgentExecutionRequest,
  taskId: string,
): SubAgentTaskHandle {
  const subAgent = Object.freeze({ name: DEFINITION_REF.name, version: DEFINITION_REF.version });
  const snapshot = Object.freeze({
    taskId,
    subAgent,
    ownerSessionId: parent.ownerSessionId,
    runId: parent.runId,
    subagentSessionId: `session:${taskId}`,
    parentTaskId: parent.taskId,
    path: Object.freeze([...parent.path, taskId]),
    executor: 'worker',
    state: 'succeeded' as const,
    revision: 2,
    attempt: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    startedAt: 1_100,
    completedAt: 2_000,
    recoveryRequired: false,
  });
  const outcome: SubAgentExecutionOutcome = Object.freeze({
    type: 'terminal',
    result: Object.freeze({
      status: 'succeeded',
      task: Object.freeze({ taskId, subAgent }),
      executor: 'worker',
      output: Object.freeze({ answer: `nested:${taskId}` }),
    }),
  });
  return Object.freeze({
    taskId,
    snapshot: vi.fn(async () => snapshot),
    wait: vi.fn(async () => outcome),
    cancel: vi.fn(async () => snapshot),
    events: () =>
      Object.freeze({
        async *[Symbol.asyncIterator]() {},
      }),
  });
}

function onlyBinding(bindings: readonly SubAgentExecutorBinding[]): SubAgentExecutorBinding {
  expect(bindings).toHaveLength(1);
  return bindings[0]!;
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

describe('WorkerSubAgentExecutor real worker_threads lifecycle', () => {
  acceptanceIt(
    'C7-WORKER-12.l3.strict-startup-handshake',
    'timeout-order-duplicate-closed-manifest',
    async () => {
      assertNetworkDenyGuardInstalled();
      const cases = [
        {
          name: 'timeout',
          targetEntry: HANDSHAKE_TIMEOUT_ENTRY,
          handshakeTimeoutMs: 20,
          expectedCrashes: 0,
        },
        {
          name: 'packet-before-ready',
          targetEntry: PRE_READY_PACKET_ENTRY,
          handshakeTimeoutMs: 5_000,
          expectedCrashes: 0,
        },
        {
          name: 'duplicate-ready',
          targetEntry: DUPLICATE_READY_ENTRY,
          handshakeTimeoutMs: 5_000,
          expectedCrashes: 0,
        },
        {
          name: 'manifest-extra-field',
          targetEntry: FORGED_MANIFEST_ENTRY,
          handshakeTimeoutMs: 5_000,
          expectedCrashes: 0,
        },
        {
          name: 'manifest-forged-digest',
          targetEntry: FORGED_DIGEST_ENTRY,
          handshakeTimeoutMs: 5_000,
          expectedCrashes: 0,
        },
        {
          name: 'target-fatal',
          targetEntry: FATAL_ENTRY,
          handshakeTimeoutMs: 5_000,
          expectedCrashes: 0,
        },
      ] as const;

      for (const testCase of cases) {
        const { executor, model } = createExecutor({
          targetEntry: testCase.targetEntry,
          handshakeTimeoutMs: testCase.handshakeTimeoutMs,
        });
        const request = createRequest(`worker-handshake-${testCase.name}`, 'settle');
        const recorder = createControl(request);
        try {
          await expect(executor.execute(request, recorder.control)).rejects.toMatchObject({
            code: 'EXECUTOR_FAILED',
          });
          expect(model).not.toHaveBeenCalled();
          expect(recorder.snapshot()).toMatchObject({ bindings: [], checkpoints: [] });
          await expectNoLiveResources(executor);
          expect(executor.diagnostics()).toMatchObject({
            terminations: 1,
            crashes: testCase.expectedCrashes,
          });
        } finally {
          await executor.dispose();
        }
      }
    },
  );

  acceptanceIt(
    'C7-WORKER-13.l3.post-admission-unbound-retry',
    'same-task-attempt-two',
    async () => {
      const { executor, model } = createExecutor();
      const first = createRequest('worker-post-admission-first', 'post-admission-crash');
      const firstControl = createControl(first);
      try {
        await expect(executor.execute(first, firstControl.control)).resolves.toMatchObject({
          type: 'recovery_required',
          reason: 'unbound_create',
          operationId: first.operation.operationId,
          causeCode: 'WORKER_EXIT',
        });
        expect(firstControl.snapshot()).toMatchObject({ bindings: [], checkpoints: [] });
        expect(executor.diagnostics().crashes).toBe(1);

        const second = Object.freeze({
          ...first,
          attempt: 2,
          executionEpoch: 'worker-post-admission-attempt-2',
          executionFencingToken: '2',
        });
        const secondControl = createControl(second);
        await expect(executor.execute(second, secondControl.control)).resolves.toMatchObject({
          type: 'terminal',
          result: {
            status: 'succeeded',
            output: { details: { factoryCreates: 1 } },
          },
        });
        expect(secondControl.snapshot().bindings).toHaveLength(1);
        expect(model).not.toHaveBeenCalled();
        await expectNoLiveResources(executor);
      } finally {
        await executor.dispose();
      }
    },
  );

  acceptanceIt('C7-WORKER-14.l3.checkpoint-crash-recovery', 'fresh-worker-resume', async () => {
    const { executor, model } = createExecutor();
    const initial = createRequest('worker-checkpoint-crash', 'checkpoint-crash');
    const initialControl = createControl(initial);
    try {
      await expect(executor.execute(initial, initialControl.control)).resolves.toMatchObject({
        type: 'recovery_required',
        reason: 'checkpoint',
        operationId: initial.operation.operationId,
        causeCode: 'WORKER_EXIT',
      });
      const initialSnapshot = initialControl.snapshot();
      const binding = onlyBinding(initialSnapshot.bindings);
      expect(initialSnapshot.checkpoints).toHaveLength(1);

      const resume = createExecutorConformanceRequest({
        executorName: 'worker',
        taskId: initial.taskId,
        definition: DEFINITION_REF,
        input: { scenario: 'checkpoint-crash' },
        operation: {
          type: 'resume',
          operationId: 'worker-checkpoint-crash-resume',
          reason: 'checkpoint',
          binding,
          checkpoint: initialSnapshot.checkpoints[0]!,
        },
      });
      const resumeControl = createControl(resume);
      await expect(executor.execute(resume, resumeControl.control)).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'succeeded' },
      });
      expect(executor.diagnostics().crashes).toBe(1);
      expect(model).not.toHaveBeenCalled();
      await expectNoLiveResources(executor);
    } finally {
      await executor.dispose();
    }
  });

  acceptanceIt(
    'C7-WORKER-15.l3.cancel-terminate-fallback',
    'request-signal-executor-handle',
    async () => {
      const modes = ['request-signal', 'executor-cancel', 'handle-cancel'] as const;
      for (const mode of modes) {
        const { executor, model } = createExecutor({ terminateTimeoutMs: 500 });
        const abort = new AbortController();
        const request = createRequest(`worker-cancel-${mode}`, 'terminate-fallback', {
          signal: abort.signal,
        });
        const recorder = createControl(request);
        try {
          let cancellationStartedAt = 0;
          if (mode === 'request-signal') {
            const cancelled = new SubAgentRuntimeError({
              code: 'CANCELLED',
              message: 'The Worker request signal was cancelled.',
              retryable: false,
            });
            const running = executor.execute(request, recorder.control);
            await vi.waitFor(() => expect(executor.diagnostics().activeWorkers).toBe(1));
            cancellationStartedAt = performance.now();
            abort.abort(cancelled);
            await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
          } else {
            const spawned = await executor.spawn(request, recorder.control);
            if ('type' in spawned) throw new Error('Expected a live Worker task handle.');
            await vi.waitFor(() => expect(executor.diagnostics().activeWorkers).toBe(1));
            cancellationStartedAt = performance.now();
            if (mode === 'executor-cancel') {
              await executor.cancel(spawned.binding, {
                operationId: 'worker-explicit-cancel',
                reason: 'test cancellation',
                signal: new AbortController().signal,
                deadlineAt: Date.now() + 1_000,
              });
            } else {
              await spawned.cancel('test raw handle cancellation');
            }
            await expect(spawned.wait()).rejects.toMatchObject({ code: 'CANCELLED' });
          }
          expect(performance.now() - cancellationStartedAt).toBeLessThan(850);
          await expectNoLiveResources(executor);
          expect(executor.diagnostics()).toMatchObject({ terminations: 1, crashes: 0 });
          expect(model).not.toHaveBeenCalled();
        } finally {
          await executor.dispose();
        }
      }
    },
  );

  acceptanceIt(
    'C7-WORKER-16.l3.active-scope-and-create-identity',
    'singleflight-before-capacity-mode-cross-session-stale-job',
    async () => {
      const saturated = createExecutor({ maxConcurrentWorkers: 1, terminateTimeoutMs: 100 });
      const saturatedAbort = new AbortController();
      const saturatedRequest = createRequest(
        'worker-saturated-create-singleflight',
        'terminate-fallback',
        { signal: saturatedAbort.signal },
      );
      const saturatedControl = createControl(saturatedRequest);
      const firstSaturated = saturated.executor.execute(saturatedRequest, saturatedControl.control);
      void firstSaturated.catch(() => undefined);
      let exactReplay: ReturnType<WorkerSubAgentExecutor['execute']> | undefined;
      try {
        await vi.waitFor(() =>
          expect(saturated.executor.diagnostics()).toMatchObject({ activeWorkers: 1 }),
        );
        await vi.waitFor(() => expect(saturatedControl.snapshot().bindings).toHaveLength(1));
        const retainedAtCapacity = saturated.executor.diagnostics().retainedTasks;
        exactReplay = saturated.executor.execute(saturatedRequest, saturatedControl.control);
        void exactReplay.catch(() => undefined);

        const conflicting = Object.freeze({
          ...saturatedRequest,
          input: Object.freeze({
            scenario: 'terminate-fallback',
            marker: 'conflicting-active-create',
          }),
        });
        await expect(
          saturated.executor.execute(conflicting, saturatedControl.control),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

        const unique = createRequest('worker-saturated-unique-overflow', 'settle');
        await expect(
          saturated.executor.execute(unique, createControl(unique).control),
        ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
        expect(saturated.executor.diagnostics().retainedTasks).toBe(retainedAtCapacity);

        const cancelled = new SubAgentRuntimeError({
          code: 'CANCELLED',
          message: 'End the saturated singleflight fixture.',
          retryable: false,
        });
        saturatedAbort.abort(cancelled);
        const settlements = await Promise.allSettled([firstSaturated, exactReplay]);
        expect(settlements).toEqual([
          { status: 'rejected', reason: cancelled },
          { status: 'rejected', reason: cancelled },
        ]);
        expect(saturatedControl.snapshot().bindings).toHaveLength(1);
        expect(saturated.model).not.toHaveBeenCalled();
        await expectNoLiveResources(saturated.executor);
      } finally {
        saturatedAbort.abort();
        await saturated.executor.dispose();
        await Promise.allSettled(
          exactReplay === undefined ? [firstSaturated] : [firstSaturated, exactReplay],
        );
      }

      const exact = createExecutor();
      const exactRequest = createRequest('worker-exact-create-singleflight', 'settle');
      const exactControl = createControl(exactRequest);
      try {
        const outcomes = await Promise.all([
          exact.executor.execute(exactRequest, exactControl.control),
          exact.executor.execute(exactRequest, exactControl.control),
        ]);
        expect(outcomes).toHaveLength(2);
        for (const outcome of outcomes) {
          expect(outcome).toMatchObject({
            type: 'terminal',
            result: {
              status: 'succeeded',
              output: { details: { factoryCreates: 1 } },
            },
          });
        }
        expect(exactControl.snapshot().bindings).toHaveLength(1);
        await expectNoLiveResources(exact.executor);
      } finally {
        await exact.executor.dispose();
      }

      const { executor, model } = createExecutor();
      const request = createRequest('worker-live-scope', 'terminate-fallback');
      const recorder = createControl(request);
      try {
        const spawned = await executor.spawn(request, recorder.control);
        if ('type' in spawned) throw new Error('Expected a live Worker task handle.');
        await vi.waitFor(() => expect(executor.diagnostics().activeWorkers).toBe(1));

        await expect(executor.execute(request, recorder.control)).rejects.toMatchObject({
          code: 'IDEMPOTENCY_CONFLICT',
        });

        const conflicting = Object.freeze({
          ...request,
          input: Object.freeze({ scenario: 'terminate-fallback', marker: 'different-create' }),
        });
        await expect(
          executor.execute(conflicting, createControl(conflicting).control),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

        const crossSession = Object.freeze({
          ...request,
          ownerSessionId: 'worker-other-owner',
          subagentSessionId: 'worker-other-subagent-session',
        });
        await expect(
          executor.execute(crossSession, createControl(crossSession).control),
        ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

        const staleBinding = Object.freeze({
          ...spawned.binding,
          recoveryData: Object.freeze({
            kind: 'maneeagent-worker/v1',
            jobId: 'stale-worker-job',
          }),
        });
        await expect(
          executor.cancel(staleBinding, {
            operationId: 'worker-stale-binding-cancel',
            signal: new AbortController().signal,
            deadlineAt: Date.now() + 1_000,
          }),
        ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
        expect(executor.diagnostics().activeWorkers).toBe(1);

        await spawned.cancel('scope test cleanup');
        await expect(spawned.wait()).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(model).not.toHaveBeenCalled();
        await expectNoLiveResources(executor);
      } finally {
        await executor.dispose();
      }
    },
  );

  acceptanceIt(
    'C7-WORKER-17.l3.max-concurrency-and-cleanup',
    'starting-plus-active-bounded',
    async () => {
      const starting = createExecutor({
        targetEntry: HANDSHAKE_TIMEOUT_ENTRY,
        handshakeTimeoutMs: 5_000,
        maxConcurrentWorkers: 2,
      });
      const startRequests = [
        createRequest('worker-starting-1', 'settle'),
        createRequest('worker-starting-2', 'settle'),
      ];
      const pending = startRequests.map((request) =>
        starting.executor.execute(request, createControl(request).control),
      );
      for (const operation of pending) void operation.catch(() => undefined);
      try {
        await vi.waitFor(() =>
          expect(starting.executor.diagnostics()).toMatchObject({ startingWorkers: 2 }),
        );
        const retainedAtStartingCapacity = starting.executor.diagnostics().retainedTasks;
        const overflow = createRequest('worker-starting-overflow', 'settle');
        await expect(
          starting.executor.execute(overflow, createControl(overflow).control),
        ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
        for (let index = 0; index < 3; index += 1) {
          const uniqueOverflow = createRequest(`worker-starting-overflow-${index}`, 'settle');
          await expect(
            starting.executor.execute(uniqueOverflow, createControl(uniqueOverflow).control),
          ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
        }
        const diagnostics = starting.executor.diagnostics();
        expect(diagnostics.startingWorkers + diagnostics.activeWorkers).toBeLessThanOrEqual(2);
        expect(diagnostics.retainedTasks).toBe(retainedAtStartingCapacity);
      } finally {
        await starting.executor.dispose();
        await Promise.allSettled(pending);
      }
      await expectNoLiveResources(starting.executor);

      const active = createExecutor({ maxConcurrentWorkers: 2 });
      const liveRequests = [
        createRequest('worker-active-1', 'terminate-fallback'),
        createRequest('worker-active-2', 'terminate-fallback'),
      ];
      try {
        const handles = await Promise.all(
          liveRequests.map(async (request) => {
            const handle = await active.executor.spawn(request, createControl(request).control);
            if ('type' in handle) throw new Error('Expected a live Worker task handle.');
            return handle;
          }),
        );
        await vi.waitFor(() =>
          expect(active.executor.diagnostics()).toMatchObject({ activeWorkers: 2 }),
        );
        const overflow = createRequest('worker-active-overflow', 'settle');
        const overflowControl = createControl(overflow);
        const retainedAtActiveCapacity = active.executor.diagnostics().retainedTasks;
        await expect(
          active.executor.execute(overflow, overflowControl.control),
        ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
        for (let index = 0; index < 3; index += 1) {
          const uniqueOverflow = createRequest(`worker-active-overflow-${index}`, 'settle');
          await expect(
            active.executor.execute(uniqueOverflow, createControl(uniqueOverflow).control),
          ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
        }
        expect(
          active.executor.diagnostics().activeWorkers +
            active.executor.diagnostics().startingWorkers,
        ).toBeLessThanOrEqual(2);
        expect(active.executor.diagnostics().retainedTasks).toBe(retainedAtActiveCapacity);

        await handles[0]!.cancel('capacity slot release');
        await expect(handles[0]!.wait()).rejects.toMatchObject({ code: 'CANCELLED' });
        await expect(
          active.executor.execute(overflow, overflowControl.control),
        ).resolves.toMatchObject({
          type: 'terminal',
          result: { status: 'succeeded' },
        });
        expect(overflowControl.snapshot().bindings).toHaveLength(1);

        await handles[1]!.cancel('capacity test cleanup');
        await expect(handles[1]!.wait()).rejects.toMatchObject({ code: 'CANCELLED' });
        await expectNoLiveResources(active.executor);
      } finally {
        await active.executor.dispose();
      }
    },
  );

  it('preserves terminal replay and cancel receipts when Worker capacity rejects a new task', async () => {
    const { executor, model } = createExecutor({
      maxRetainedTasks: 2,
      maxConcurrentWorkers: 1,
      terminateTimeoutMs: 50,
    });
    const terminalRequest = createRequest('worker-capacity-terminal-receipt', 'settle');
    const terminalControl = createControl(terminalRequest);
    const liveRequest = createRequest('worker-capacity-live-task', 'terminate-fallback');
    const liveControl = createControl(liveRequest);
    try {
      const terminalHandle = await executor.spawn(terminalRequest, terminalControl.control);
      if ('type' in terminalHandle) throw new Error('Expected a terminal Worker task handle.');
      const terminalOutcome = await terminalHandle.wait();
      await expectNoLiveResources(executor);

      const cancelOptions = {
        operationId: 'worker-preserved-terminal-cancel',
        reason: 'preserved terminal receipt',
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 1_000,
      } as const;
      await expect(executor.cancel(terminalHandle.binding, cancelOptions)).resolves.toBeUndefined();

      const liveHandle = await executor.spawn(liveRequest, liveControl.control);
      if ('type' in liveHandle) throw new Error('Expected a live Worker task handle.');
      await vi.waitFor(() => expect(executor.diagnostics().activeWorkers).toBe(1));
      expect(executor.diagnostics()).toMatchObject({ retainedTasks: 2, cancelReceipts: 1 });

      const overflow = createRequest('worker-capacity-preservation-overflow', 'settle');
      await expect(
        executor.execute(overflow, createControl(overflow).control),
      ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
      expect(executor.getAvailability()).toMatchObject({
        status: 'unavailable',
        reasonCode: 'WORKER_CAPACITY',
      });
      expect(executor.diagnostics()).toMatchObject({ retainedTasks: 2, cancelReceipts: 1 });

      const replay = await executor.spawn(terminalRequest, terminalControl.control);
      if ('type' in replay) throw new Error('Expected an exact terminal replay handle.');
      expect(replay.binding).toEqual(terminalHandle.binding);
      await expect(replay.wait()).resolves.toEqual(terminalOutcome);
      expect(terminalControl.snapshot()).toMatchObject({ bindings: [terminalHandle.binding] });

      const preAborted = new AbortController();
      preAborted.abort(new Error('Stored cancel receipt must win over caller cancellation.'));
      await expect(
        executor.cancel(terminalHandle.binding, { ...cancelOptions, signal: preAborted.signal }),
      ).resolves.toBeUndefined();
      await expect(
        executor.cancel(terminalHandle.binding, {
          ...cancelOptions,
          reason: 'conflicting terminal receipt',
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      await liveHandle.cancel('capacity preservation cleanup');
      await expect(liveHandle.wait()).rejects.toMatchObject({ code: 'CANCELLED' });
      await expectNoLiveResources(executor);
      expect(model).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });

  it('keeps compact terminal tombstones and fails closed at retained-task capacity', async () => {
    for (const mode of ['execute', 'spawn'] as const) {
      const { executor, model } = createExecutor({ maxRetainedTasks: 1 });
      const request = createRequest(`worker-retention-tombstone-${mode}`, 'settle');
      const recorder = createControl(request);
      try {
        const first =
          mode === 'execute'
            ? await executor.execute(request, recorder.control)
            : await (async () => {
                const handle = await executor.spawn(request, recorder.control);
                if ('type' in handle) throw new Error('Expected a Worker task handle.');
                return handle.wait();
              })();
        const binding = onlyBinding(recorder.snapshot().bindings);
        const cancelOptions = {
          operationId: `worker-retention-terminal-cancel-${mode}`,
          reason: 'retained terminal cancel',
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 1_000,
        } as const;
        await expect(executor.cancel(binding, cancelOptions)).resolves.toBeUndefined();
        await expectNoLiveResources(executor);
        const beforeReplay = executor.diagnostics();
        const beforeControl = recorder.snapshot();

        const overflow = createRequest(`worker-retention-overflow-${mode}`, 'settle');
        await expect(
          executor.execute(overflow, createControl(overflow).control),
        ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
        expect(executor.getAvailability()).toMatchObject({
          status: 'unavailable',
          reasonCode: 'WORKER_RETENTION_CAPACITY',
        });

        const replay =
          mode === 'execute'
            ? await executor.execute(request, recorder.control)
            : await (async () => {
                const handle = await executor.spawn(request, recorder.control);
                if ('type' in handle) throw new Error('Expected a terminal replay handle.');
                expect(handle.binding).toEqual(binding);
                return handle.wait();
              })();
        expect(replay).toEqual(first);
        expect(recorder.snapshot()).toEqual(beforeControl);
        expect(executor.diagnostics()).toEqual(beforeReplay);

        const preAborted = new AbortController();
        preAborted.abort(new Error('Stored terminal outcome must win over caller cancellation.'));
        const preAbortedRequest = Object.freeze({ ...request, signal: preAborted.signal });
        const preAbortedRecorder = createControl(preAbortedRequest);
        const preAbortedReplay =
          mode === 'execute'
            ? await executor.execute(preAbortedRequest, preAbortedRecorder.control)
            : await (async () => {
                const handle = await executor.spawn(preAbortedRequest, preAbortedRecorder.control);
                if ('type' in handle)
                  throw new Error('Expected a pre-aborted terminal replay handle.');
                expect(handle.binding).toEqual(binding);
                return handle.wait();
              })();
        expect(preAbortedReplay).toEqual(first);
        expect(preAbortedRecorder.snapshot()).toMatchObject({
          bindings: [],
          checkpoints: [],
          progress: [],
          usage: [],
          events: [],
        });

        const conflictingRequest = Object.freeze({
          ...preAbortedRequest,
          input: Object.freeze({ scenario: 'settle', marker: 'terminal-replay-conflict' }),
        });
        const conflictingRecorder = createControl(conflictingRequest);
        const conflictingReplay =
          mode === 'execute'
            ? executor.execute(conflictingRequest, conflictingRecorder.control)
            : executor.spawn(conflictingRequest, conflictingRecorder.control);
        await expect(conflictingReplay).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        expect(conflictingRecorder.snapshot()).toMatchObject({
          bindings: [],
          checkpoints: [],
          progress: [],
          usage: [],
          events: [],
        });

        const expiredRecorder = createControl(request);
        const now = vi.spyOn(Date, 'now').mockReturnValue(request.deadlineAt);
        try {
          const expiredReplay =
            mode === 'execute'
              ? await executor.execute(request, expiredRecorder.control)
              : await (async () => {
                  const handle = await executor.spawn(request, expiredRecorder.control);
                  if ('type' in handle)
                    throw new Error('Expected an expired terminal replay handle.');
                  expect(handle.binding).toEqual(binding);
                  return handle.wait();
                })();
          expect(expiredReplay).toEqual(first);
        } finally {
          now.mockRestore();
        }
        expect(expiredRecorder.snapshot()).toMatchObject({
          bindings: [],
          checkpoints: [],
          progress: [],
          usage: [],
          events: [],
        });
        expect(executor.diagnostics()).toEqual(beforeReplay);

        const preAbortedCancel = new AbortController();
        preAbortedCancel.abort(
          new Error('Exact terminal cancel replay must remain authoritative.'),
        );
        await expect(
          executor.cancel(binding, { ...cancelOptions, signal: preAbortedCancel.signal }),
        ).resolves.toBeUndefined();
        await expect(
          executor.cancel(binding, { ...cancelOptions, reason: 'retained cancel conflict' }),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        expect(recorder.snapshot().progress).toEqual([]);
        expect(model).not.toHaveBeenCalled();
      } finally {
        await executor.dispose();
      }
    }
  });

  it('keeps the original spawn facade read-only after terminal settlement', async () => {
    const { executor, model } = createExecutor();
    const request = createRequest('worker-terminal-original-handle', 'settle');
    const recorder = createControl(request);
    try {
      const handle = await executor.spawn(request, recorder.control);
      if ('type' in handle) throw new Error('Expected a Worker task handle.');
      const outcome = await handle.wait();
      await expectNoLiveResources(executor);
      const before = executor.diagnostics();
      const beforeControl = recorder.snapshot();

      await expect(handle.wait()).resolves.toEqual(outcome);
      await expect(handle.snapshot()).resolves.toMatchObject({
        taskId: request.taskId,
        state: 'succeeded',
        binding: handle.binding,
      });
      const events = handle.events()[Symbol.asyncIterator]();
      await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
      await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
      await expect(handle.cancel('terminal facade no-op')).resolves.toBeUndefined();

      expect(executor.diagnostics()).toEqual(before);
      expect(recorder.snapshot()).toEqual(beforeControl);
      expect(model).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });

  it('enforces runtime deadlines for execute and raw handle wait with bounded cleanup', async () => {
    for (const mode of ['execute', 'spawn-wait'] as const) {
      const { executor, model } = createExecutor({ terminateTimeoutMs: 50 });
      const request = createRequest(`worker-runtime-deadline-${mode}`, 'terminate-fallback', {
        deadlineAt: Date.now() + 1_000,
      });
      const recorder = createControl(request);
      try {
        if (mode === 'execute') {
          await expect(executor.execute(request, recorder.control)).rejects.toMatchObject({
            code: 'TIMED_OUT',
          });
        } else {
          const handle = await executor.spawn(request, recorder.control);
          if ('type' in handle) throw new Error('Expected a live Worker task handle.');
          await expect(handle.wait()).rejects.toMatchObject({ code: 'TIMED_OUT' });
        }
        await expectNoLiveResources(executor);
        expect(executor.diagnostics()).toMatchObject({ terminations: 1, crashes: 0 });
        expect(model).not.toHaveBeenCalled();
      } finally {
        await executor.dispose();
      }
    }
  });

  it('cleans an accepted spawn on abort or deadline without requiring handle.wait()', async () => {
    for (const mode of ['abort', 'deadline'] as const) {
      const { executor, model } = createExecutor({ terminateTimeoutMs: 50 });
      const abort = new AbortController();
      const request = createRequest(`worker-unobserved-scope-${mode}`, 'terminate-fallback', {
        signal: abort.signal,
        deadlineAt: Date.now() + (mode === 'deadline' ? 1_000 : 5_000),
      });
      const recorder = createControl(request);
      try {
        const handle = await executor.spawn(request, recorder.control);
        if ('type' in handle) throw new Error('Expected an accepted Worker task handle.');
        await vi.waitFor(() => expect(executor.diagnostics().activeWorkers).toBe(1));
        if (mode === 'abort') {
          abort.abort(
            new SubAgentRuntimeError({
              code: 'CANCELLED',
              message: 'Abort an unobserved accepted Worker spawn.',
              retryable: false,
            }),
          );
        }
        await expectNoLiveResources(executor);
        expect(executor.diagnostics()).toMatchObject({ terminations: 1, crashes: 0 });
        expect(model).not.toHaveBeenCalled();
      } finally {
        abort.abort();
        await executor.dispose();
      }
    }
  });

  it('releases unobserved spawn sessions while retaining compact crash classification', async () => {
    for (const scenario of ['checkpoint-crash', 'stdout-overflow-delayed'] as const) {
      const { executor, model } = createExecutor({ terminateTimeoutMs: 50 });
      const request = createRequest(`worker-unobserved-failure-${scenario}`, scenario, {
        deadlineAt: Date.now() + 5_000,
      });
      const recorder = createControl(request);
      try {
        const handle = await executor.spawn(request, recorder.control);
        if ('type' in handle) throw new Error('Expected an accepted Worker task handle.');

        await expectNoLiveResources(executor);
        expect(executor.diagnostics()).toMatchObject(
          scenario === 'checkpoint-crash'
            ? { crashes: 1, terminations: 0 }
            : { crashes: 0, terminations: 1 },
        );

        if (scenario === 'checkpoint-crash') {
          await expect(handle.wait()).resolves.toMatchObject({
            type: 'recovery_required',
            reason: 'checkpoint',
            causeCode: 'WORKER_EXIT',
          });
        } else {
          await expect(handle.wait()).rejects.toMatchObject({ code: 'EXECUTOR_FAILED' });
        }
        await expectNoLiveResources(executor);
        expect(model).not.toHaveBeenCalled();
      } finally {
        await executor.dispose();
      }
    }
  });

  it('accepts a later absolute deadline only after the external execution scope advances', async () => {
    const { executor, model } = createExecutor();
    const oldDeadlineAt = Date.now() + 500;
    const initial = createRequest('worker-approval-later-deadline', 'approval-resume', {
      deadlineAt: oldDeadlineAt,
    });
    const pauseControl = createExecutorConformanceControl({
      ownerSessionId: initial.ownerSessionId,
      taskId: initial.taskId,
      signal: initial.signal,
      deadlineAt: initial.deadlineAt,
      approval: 'suspend',
    });
    try {
      const paused = await executor.execute(initial, pauseControl.control);
      expect(paused).toMatchObject({ type: 'paused', reason: 'approval' });
      if (paused.type !== 'paused') throw new Error('Expected a paused Worker execution.');
      await expectNoLiveResources(executor);
      const snapshot = pauseControl.snapshot();
      const binding = onlyBinding(snapshot.bindings);
      const checkpoint = snapshot.checkpoints[0]!;
      const waitMs = Math.max(0, oldDeadlineAt - Date.now() + 20);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      const laterDeadlineAt = Date.now() + 1_000;
      expect(laterDeadlineAt).toBeGreaterThan(oldDeadlineAt);
      const resumeBase = createExecutorConformanceRequest({
        executorName: 'worker',
        taskId: initial.taskId,
        definition: DEFINITION_REF,
        input: initial.input,
        operation: {
          type: 'resume',
          operationId: 'worker-approval-later-deadline-resume',
          reason: 'approval',
          binding,
          checkpoint,
          approvals: [
            {
              approvalId: paused.approvals[0]!.approvalId,
              decision: 'approved',
              expectedRevision: paused.approvals[0]!.revision,
            },
          ],
        },
      });
      const refreshedDelegation = Object.freeze({
        ...resumeBase.delegation,
        catalogRevision: resumeBase.delegation.catalogRevision + 1,
        definitions: Object.freeze([
          Object.freeze({
            ...resumeBase.delegation.definitions[0]!,
            executors: Object.freeze(['worker', 'worker-secondary']),
          }),
        ]),
      });
      const resume = Object.freeze({
        ...resumeBase,
        deadlineAt: laterDeadlineAt,
        delegation: refreshedDelegation,
        limits: Object.freeze({
          ...resumeBase.limits,
          timeoutMs: Math.max(1, initial.limits.timeoutMs - 1),
        }),
      });
      const expandedTimeout = Object.freeze({
        ...resume,
        limits: Object.freeze({
          ...resume.limits,
          timeoutMs: initial.limits.timeoutMs + 1,
        }),
      });
      const expandedTimeoutControl = createControl(expandedTimeout);
      const beforeExpandedTimeout = executor.diagnostics();
      await expect(
        executor.execute(expandedTimeout, expandedTimeoutControl.control),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(expandedTimeoutControl.snapshot()).toMatchObject({
        bindings: [],
        checkpoints: [],
        approvalInputs: [],
        progress: [],
        usage: [],
        events: [],
      });
      expect(executor.diagnostics()).toEqual(beforeExpandedTimeout);
      const stableIdentityDrifts: readonly SubAgentExecutionRequest[] = [
        Object.freeze({ ...resume, runId: `${resume.runId}:drift` }),
        Object.freeze({ ...resume, parentTaskId: `${resume.parentTaskId}:drift` }),
        Object.freeze({ ...resume, path: Object.freeze([...resume.path, 'drift']) }),
        Object.freeze({
          ...resume,
          input: Object.freeze({ scenario: 'approval-resume', marker: 'input-drift' }),
        }),
        Object.freeze({
          ...resume,
          projectedContext: Object.freeze([
            Object.freeze({ kind: 'text' as const, name: 'brief', text: 'context drift' }),
          ]),
        }),
        Object.freeze({
          ...resume,
          limits: Object.freeze({ ...resume.limits, maxTurns: resume.limits.maxTurns + 1 }),
        }),
        Object.freeze({
          ...resume,
          delegation: Object.freeze({
            ...refreshedDelegation,
            ownerSessionId: `${refreshedDelegation.ownerSessionId}:drift`,
          }),
        }),
        Object.freeze({
          ...resume,
          delegation: Object.freeze({
            ...refreshedDelegation,
            path: Object.freeze([...refreshedDelegation.path, 'drift']),
          }),
        }),
        Object.freeze({
          ...resume,
          delegation: Object.freeze({
            ...refreshedDelegation,
            depth: refreshedDelegation.depth + 1,
          }),
        }),
      ];
      const beforeDrift = executor.diagnostics();
      for (const drift of stableIdentityDrifts) {
        const driftControl = createControl(drift);
        await expect(executor.execute(drift, driftControl.control)).rejects.toMatchObject({
          code: 'IDEMPOTENCY_CONFLICT',
        });
        expect(driftControl.snapshot()).toMatchObject({
          bindings: [],
          checkpoints: [],
          approvalInputs: [],
          progress: [],
          usage: [],
          events: [],
        });
        expect(executor.diagnostics()).toEqual(beforeDrift);
      }
      const stale = Object.freeze({
        ...resume,
        attempt: initial.attempt,
        executionEpoch: initial.executionEpoch,
        executionFencingToken: initial.executionFencingToken,
      });
      await expect(executor.execute(stale, createControl(stale).control)).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });

      const resumeControl = createControl(resume);
      await expect(executor.execute(resume, resumeControl.control)).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'succeeded' },
      });
      await expectNoLiveResources(executor);
      expect(model).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });

  it('prevents a stale paused handle from affecting a newer execution scope', async () => {
    const { executor, model } = createExecutor({ terminateTimeoutMs: 50 });
    const oldAbort = new AbortController();
    const initial = createRequest('worker-stale-paused-handle', 'approval-resume', {
      input: { scenario: 'approval-resume', marker: 'terminate-fallback-on-resume' },
      signal: oldAbort.signal,
      deadlineAt: Date.now() + 5_000,
    });
    const pauseControl = createExecutorConformanceControl({
      ownerSessionId: initial.ownerSessionId,
      taskId: initial.taskId,
      signal: initial.signal,
      deadlineAt: initial.deadlineAt,
      approval: 'suspend',
    });
    try {
      const staleHandle = await executor.spawn(initial, pauseControl.control);
      if ('type' in staleHandle) throw new Error('Expected a paused Worker task handle.');
      const paused = await staleHandle.wait();
      if (paused.type !== 'paused') throw new Error('Expected the first Worker scope to pause.');
      await expectNoLiveResources(executor);
      const pauseSnapshot = pauseControl.snapshot();
      const checkpoint = pauseSnapshot.checkpoints[0]!;
      const resume = createExecutorConformanceRequest({
        executorName: 'worker',
        taskId: initial.taskId,
        definition: DEFINITION_REF,
        input: initial.input,
        operation: {
          type: 'resume',
          operationId: 'worker-stale-paused-handle-resume',
          reason: 'approval',
          binding: staleHandle.binding,
          checkpoint,
          approvals: [
            {
              approvalId: paused.approvals[0]!.approvalId,
              decision: 'approved',
              expectedRevision: paused.approvals[0]!.revision,
            },
          ],
        },
      });
      const resumeControl = createControl(resume);
      const currentHandle = await executor.spawn(resume, resumeControl.control);
      if ('type' in currentHandle) throw new Error('Expected a current Worker task handle.');
      await vi.waitFor(() => expect(executor.diagnostics().activeWorkers).toBe(1));

      oldAbort.abort(
        new SubAgentRuntimeError({
          code: 'CANCELLED',
          message: 'Abort only the obsolete Worker execution scope.',
          retryable: false,
        }),
      );
      await expect(staleHandle.wait()).resolves.toMatchObject({
        type: 'paused',
        reason: 'approval',
      });
      expect(executor.diagnostics()).toMatchObject({ activeWorkers: 1, crashes: 0 });
      const terminationsBeforeCleanup = executor.diagnostics().terminations;

      await currentHandle.cancel('stale-handle test cleanup');
      await expect(currentHandle.wait()).rejects.toMatchObject({ code: 'CANCELLED' });
      await expectNoLiveResources(executor);
      expect(executor.diagnostics().terminations).toBe(terminationsBeforeCleanup + 1);
      expect(executor.diagnostics().crashes).toBe(0);
      expect(model).not.toHaveBeenCalled();
    } finally {
      oldAbort.abort();
      await executor.dispose();
    }
  });

  it('rejects delegation and definition drift before retrying an unbound create', async () => {
    const { executor, model } = createExecutor();
    const initial = createRequest('worker-unbound-create-identity', 'post-admission-crash');
    const initialControl = createControl(initial);
    try {
      await expect(executor.execute(initial, initialControl.control)).resolves.toMatchObject({
        type: 'recovery_required',
        reason: 'unbound_create',
      });
      const retryScope = {
        attempt: 2,
        executionEpoch: 'worker-unbound-create-identity-epoch-2',
        executionFencingToken: '2',
        deadlineAt: Date.now() + 5_000,
      } as const;
      const delegationDrifts = [
        Object.freeze({
          ...initial.delegation,
          catalogRevision: initial.delegation.catalogRevision + 1,
        }),
        Object.freeze({
          ...initial.delegation,
          definitions: Object.freeze([
            Object.freeze({
              ...initial.delegation.definitions[0]!,
              executors: Object.freeze(['another-worker']),
            }),
          ]),
        }),
      ];
      const conflicts = [
        ...delegationDrifts.map((delegation) =>
          Object.freeze({ ...initial, ...retryScope, delegation }),
        ),
        Object.freeze({
          ...initial,
          ...retryScope,
          definition: Object.freeze({ ...initial.definition, version: '999' }),
        }),
        Object.freeze({
          ...initial,
          ...retryScope,
          limits: Object.freeze({
            ...initial.limits,
            maxTurns: initial.limits.maxTurns + 1,
          }),
        }),
      ];
      for (const conflict of conflicts) {
        const recorder = createControl(conflict);
        await expect(executor.execute(conflict, recorder.control)).rejects.toMatchObject({
          code: 'IDEMPOTENCY_CONFLICT',
        });
        expect(recorder.snapshot()).toMatchObject({
          bindings: [],
          checkpoints: [],
          approvalInputs: [],
          progress: [],
          usage: [],
          events: [],
        });
      }
      expect(executor.diagnostics()).toMatchObject({
        retainedTasks: 1,
        activeWorkers: 0,
        startingWorkers: 0,
        crashes: 1,
      });

      const exactRetry = Object.freeze({
        ...initial,
        ...retryScope,
        limits: Object.freeze({
          ...initial.limits,
          timeoutMs: Math.max(1, initial.limits.timeoutMs - 1),
        }),
      });
      const exactControl = createControl(exactRetry);
      await expect(executor.execute(exactRetry, exactControl.control)).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'succeeded' },
      });
      expect(exactControl.snapshot().bindings).toHaveLength(1);
      await expectNoLiveResources(executor);
      expect(model).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });

  it('uses the current attempt failure after advancing beyond a recoverable crash', async () => {
    const { executor, model } = createExecutor();
    const initial = createRequest('worker-attempt-local-failure', 'checkpoint-crash', {
      input: { scenario: 'checkpoint-crash', marker: 'stdout-overflow-on-resume' },
    });
    const initialControl = createControl(initial);
    try {
      await expect(executor.execute(initial, initialControl.control)).resolves.toMatchObject({
        type: 'recovery_required',
        reason: 'checkpoint',
      });
      const snapshot = initialControl.snapshot();
      const binding = onlyBinding(snapshot.bindings);
      const checkpoint = snapshot.checkpoints[0]!;
      const resume = createExecutorConformanceRequest({
        executorName: 'worker',
        taskId: initial.taskId,
        definition: DEFINITION_REF,
        input: initial.input,
        operation: {
          type: 'resume',
          operationId: 'worker-attempt-local-failure-resume',
          reason: 'checkpoint',
          binding,
          checkpoint,
        },
      });
      const resumeControl = createControl(resume);
      await expect(executor.execute(resume, resumeControl.control)).rejects.toMatchObject({
        code: 'EXECUTOR_FAILED',
        message: 'The Worker output safety limit was exceeded.',
      });
      expect(executor.diagnostics()).toMatchObject({ crashes: 1, terminations: 1 });
      await expectNoLiveResources(executor);
      expect(model).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });

  it('rolls a failed startup back to the prior scope before retrying the same attempt', async () => {
    const { executor, model } = createExecutor();
    const initial = createRequest('worker-startup-scope-rollback', 'checkpoint-crash');
    const initialControl = createControl(initial);
    try {
      await expect(executor.execute(initial, initialControl.control)).resolves.toMatchObject({
        type: 'recovery_required',
        reason: 'checkpoint',
      });
      const snapshot = initialControl.snapshot();
      const binding = onlyBinding(snapshot.bindings);
      const checkpoint = snapshot.checkpoints[0]!;
      const resumeBase = createExecutorConformanceRequest({
        executorName: 'worker',
        taskId: initial.taskId,
        definition: DEFINITION_REF,
        input: initial.input,
        operation: {
          type: 'resume',
          operationId: 'worker-startup-scope-rollback-resume',
          reason: 'checkpoint',
          binding,
          checkpoint,
        },
      });
      const abort = new AbortController();
      const abortedResume = Object.freeze({
        ...resumeBase,
        signal: abort.signal,
        deadlineAt: Date.now() + 5_000,
      });
      const abortedControl = createControl(abortedResume);
      const starting = executor.execute(abortedResume, abortedControl.control);
      abort.abort(
        new SubAgentRuntimeError({
          code: 'CANCELLED',
          message: 'Cancel the attempt-two Worker during startup.',
          retryable: false,
        }),
      );
      await expect(starting).rejects.toMatchObject({ code: 'CANCELLED' });
      await expectNoLiveResources(executor);

      const retry = Object.freeze({
        ...resumeBase,
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 5_000,
      });
      const retryControl = createControl(retry);
      await expect(executor.execute(retry, retryControl.control)).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'succeeded' },
      });
      await expectNoLiveResources(executor);
      expect(model).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });

  acceptanceIt('C7-WORKER-18.l3.stdio-secret-discard', 'captured-not-forwarded', async () => {
    const marker = `WORKER_STDIO_SECRET_${Date.now()}_MUST_NOT_ESCAPE`;
    const { executor, model } = createExecutor();
    const request = createRequest('worker-stdio-secret', 'output-secret', {
      input: { scenario: 'output-secret', marker },
    });
    const recorder = createControl(request);
    try {
      const outcome = await executor.execute(request, recorder.control);
      expect(outcome).toMatchObject({ type: 'terminal', result: { status: 'succeeded' } });
      expect(JSON.stringify(outcome)).not.toContain(marker);
      expect(JSON.stringify(recorder.snapshot())).not.toContain(marker);
      expect(JSON.stringify(executor.diagnostics())).not.toContain(marker);
      expect(model).not.toHaveBeenCalled();
      await expectNoLiveResources(executor);
    } finally {
      await executor.dispose();
    }
  });

  acceptanceIt(
    'C7-WORKER-19.l3.fresh-executor-resume-scope',
    'binding-and-checkpoint-imported-before-crash',
    async () => {
      const first = createExecutor();
      const initial = createRequest('worker-fresh-executor-resume', 'checkpoint-crash', {
        input: { scenario: 'checkpoint-crash', marker: 'crash-on-resume' },
      });
      const initialControl = createControl(initial);
      let binding: SubAgentExecutorBinding | undefined;
      let checkpoint: SubAgentChildCheckpoint | undefined;
      try {
        await expect(
          first.executor.execute(initial, initialControl.control),
        ).resolves.toMatchObject({
          type: 'recovery_required',
          reason: 'checkpoint',
        });
        const snapshot = initialControl.snapshot();
        binding = onlyBinding(snapshot.bindings);
        expect(snapshot.checkpoints).toHaveLength(1);
        checkpoint = snapshot.checkpoints[0]!;
      } finally {
        await first.executor.dispose();
      }
      if (binding === undefined || checkpoint === undefined) {
        throw new Error('The first Worker must persist one binding and checkpoint.');
      }

      const second = createExecutor();
      const resumeBase = createExecutorConformanceRequest({
        executorName: 'worker',
        taskId: initial.taskId,
        definition: DEFINITION_REF,
        input: initial.input,
        operation: {
          type: 'resume',
          operationId: 'worker-fresh-executor-resume-operation',
          reason: 'checkpoint',
          binding,
          checkpoint,
        },
      });
      const resume = Object.freeze({
        ...resumeBase,
        attempt: 2,
        executionEpoch: 'worker-fresh-executor-epoch-2',
        executionFencingToken: '2',
      });
      const resumeControl = createControl(resume);
      try {
        await expect(second.executor.execute(resume, resumeControl.control)).resolves.toMatchObject(
          {
            type: 'recovery_required',
            reason: 'checkpoint',
            causeCode: 'WORKER_EXIT',
          },
        );
        expect(second.executor.diagnostics().crashes).toBe(1);
        expect(resumeControl.snapshot().progress).toContainEqual({
          message: 'worker-resume-scope',
          data: {
            attempt: 2,
            executionEpoch: 'worker-fresh-executor-epoch-2',
            executionFencingToken: '2',
          },
        });
        expect(second.model).not.toHaveBeenCalled();
        await expectNoLiveResources(second.executor);
      } finally {
        await second.executor.dispose();
      }
    },
  );

  acceptanceIt(
    'C7-WORKER-22.l3.cancel-idempotency',
    'concurrent-terminal-conflict-and-hidden-resource',
    async () => {
      const { executor, model } = createExecutor();
      const request = createRequest('worker-cancel-idempotency', 'cancel');
      const recorder = createControl(request);
      try {
        const spawned = await executor.spawn(request, recorder.control);
        if ('type' in spawned) throw new Error('Expected a live Worker task handle.');
        await vi.waitFor(() => expect(executor.diagnostics().activeWorkers).toBe(1));
        const options = Object.freeze({
          operationId: 'worker-idempotent-cancel-operation',
          reason: 'one stable reason',
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 1_000,
        });
        const first = executor.cancel(spawned.binding, options);
        const replay = executor.cancel(spawned.binding, options);

        await expect(
          executor.cancel(spawned.binding, { ...options, reason: 'conflicting reason' }),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        const conflictingBinding = Object.freeze({
          ...spawned.binding,
          runnerVersion: '9.9.9',
        });
        await expect(executor.cancel(conflictingBinding, options)).rejects.toMatchObject({
          code: 'BINDING_INVALID',
        });

        const unknownBinding = Object.freeze({
          ...spawned.binding,
          taskId: 'worker-cancel-unknown-task',
          subagentSessionId: 'session:worker-cancel-unknown-task',
        });
        await expect(executor.cancel(unknownBinding, options)).rejects.toMatchObject({
          code: 'RESOURCE_NOT_FOUND',
        });
        const crossOwnerBinding = Object.freeze({
          ...spawned.binding,
          ownerSessionId: 'worker-cancel-cross-owner',
        });
        await expect(executor.cancel(crossOwnerBinding, options)).rejects.toMatchObject({
          code: 'RESOURCE_NOT_FOUND',
        });

        await expect(Promise.all([first, replay])).resolves.toEqual([undefined, undefined]);
        await expect(spawned.wait()).resolves.toMatchObject({
          type: 'terminal',
          result: { status: 'cancelled' },
        });
        expect(recorder.snapshot().progress).toEqual([
          {
            message: 'worker-cancel-observed',
            data: { taskId: request.taskId },
          },
        ]);
        expect(executor.diagnostics().cancelReceipts).toBe(1);

        await expect(executor.cancel(spawned.binding, options)).resolves.toBeUndefined();
        await expect(
          executor.cancel(spawned.binding, { ...options, reason: 'terminal conflict' }),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        await expect(executor.cancel(conflictingBinding, options)).rejects.toMatchObject({
          code: 'BINDING_INVALID',
        });
        expect(recorder.snapshot().progress).toHaveLength(1);
        expect(model).not.toHaveBeenCalled();
        await expectNoLiveResources(executor);
      } finally {
        await executor.dispose();
      }
    },
  );

  acceptanceIt(
    'C7-WORKER-23.l3.channel-and-output-policy-fail-close',
    'unsolicited-port-close-and-stdio-overflow',
    async () => {
      for (const scenario of ['port-close', 'stdout-overflow'] as const) {
        const { executor, model } = createExecutor({
          ...(scenario === 'port-close' ? { targetEntry: PORT_CLOSE_ENTRY } : {}),
        });
        const request = createRequest(`worker-policy-${scenario}`, scenario);
        const recorder = createControl(request);
        try {
          await expect(executor.execute(request, recorder.control)).rejects.toMatchObject({
            code: 'EXECUTOR_FAILED',
          });
          expect(model).not.toHaveBeenCalled();
          expect(recorder.snapshot().checkpoints).toEqual([]);
          expect(executor.diagnostics()).toMatchObject({ crashes: 0, terminations: 1 });
          await expectNoLiveResources(executor);
        } finally {
          await executor.dispose();
        }
      }
    },
  );

  acceptanceIt(
    'C7-WORKER-27.l3.cancel-receipt-capacity',
    'closed-capacity-byte-boundary-and-aborted-replay',
    async () => {
      const { executor, model } = createExecutor();
      const request = createRequest('worker-cancel-receipt-capacity', 'settle');
      const recorder = createControl(request);
      try {
        const spawned = await executor.spawn(request, recorder.control);
        if ('type' in spawned) throw new Error('Expected a Worker task handle.');
        await expect(spawned.wait()).resolves.toMatchObject({
          type: 'terminal',
          result: { status: 'succeeded' },
        });
        await expectNoLiveResources(executor);

        const exactBoundaryOperationId = 'é'.repeat(128);
        const reason = 'terminal cancel receipt';
        const cancel = (operationId: string, signal = new AbortController().signal) =>
          executor.cancel(spawned.binding, {
            operationId,
            reason,
            signal,
            deadlineAt: Date.now() + 1_000,
          });

        await expect(cancel(exactBoundaryOperationId)).resolves.toBeUndefined();
        expect(executor.diagnostics().cancelReceipts).toBe(1);
        await expect(cancel(`${exactBoundaryOperationId}x`)).rejects.toThrow(TypeError);
        expect(executor.diagnostics().cancelReceipts).toBe(1);

        await expect(
          Promise.all(
            Array.from({ length: 63 }, (_, index) => cancel(`terminal-cancel-${index + 1}`)),
          ),
        ).resolves.toHaveLength(63);
        expect(executor.diagnostics().cancelReceipts).toBe(64);

        await expect(cancel('terminal-cancel-capacity-overflow')).rejects.toMatchObject({
          code: 'LIMIT_EXCEEDED',
        });
        expect(executor.diagnostics().cancelReceipts).toBe(64);

        const preAborted = new AbortController();
        preAborted.abort(new Error('A settled cancel receipt must win over caller cancellation.'));
        await expect(cancel(exactBoundaryOperationId, preAborted.signal)).resolves.toBeUndefined();
        await expect(
          executor.cancel(spawned.binding, {
            operationId: exactBoundaryOperationId,
            reason: 'conflicting terminal cancel receipt',
            signal: new AbortController().signal,
            deadlineAt: Date.now() + 1_000,
          }),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        expect(executor.diagnostics().cancelReceipts).toBe(64);
        expect(recorder.snapshot().progress).toEqual([]);
        expect(model).not.toHaveBeenCalled();
      } finally {
        await executor.dispose();
      }
    },
  );

  acceptanceIt(
    'C7-WORKER-24.l3.binding-integrity-before-target',
    'cancel-and-resume-closed-binding',
    async () => {
      const live = createExecutor();
      const liveRequest = createRequest('worker-binding-live', 'terminate-fallback');
      const liveControl = createControl(liveRequest);
      try {
        const spawned = await live.executor.spawn(liveRequest, liveControl.control);
        if ('type' in spawned) throw new Error('Expected a live Worker task handle.');
        await vi.waitFor(() => expect(live.executor.diagnostics().activeWorkers).toBe(1));
        const liveDiagnostics = live.executor.diagnostics();
        const liveControlSnapshot = liveControl.snapshot();
        for (const hostile of hostileFullBindings(spawned.binding)) {
          await expect(
            live.executor.cancel(hostile.binding, {
              operationId: `worker-hostile-cancel-${hostile.label}`,
              signal: new AbortController().signal,
              deadlineAt: Date.now() + 1_000,
            }),
          ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
          expect(hostile.getterCalls(), hostile.label).toBe(0);
          expect(live.executor.diagnostics(), hostile.label).toEqual(liveDiagnostics);
          expect(liveControl.snapshot(), hostile.label).toEqual(liveControlSnapshot);
        }
        for (const [index, binding] of tamperedBindings(spawned.binding).entries()) {
          await expect(
            live.executor.cancel(binding, {
              operationId: `worker-tampered-cancel-${index}`,
              signal: new AbortController().signal,
              deadlineAt: Date.now() + 1_000,
            }),
          ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
        }
        expect(live.executor.diagnostics().activeWorkers).toBe(1);
        expect(live.model).not.toHaveBeenCalled();
        await spawned.cancel('binding integrity cleanup');
        await Promise.allSettled([spawned.wait()]);
      } finally {
        await live.executor.dispose();
      }

      const recovering = createExecutor();
      const initial = createRequest('worker-binding-resume', 'checkpoint-crash');
      const initialControl = createControl(initial);
      try {
        await expect(
          recovering.executor.execute(initial, initialControl.control),
        ).resolves.toMatchObject({ type: 'recovery_required', reason: 'checkpoint' });
        const snapshot = initialControl.snapshot();
        const binding = onlyBinding(snapshot.bindings);
        const checkpoint = snapshot.checkpoints[0]!;
        expect(checkpoint).toBeDefined();
        const recoveryDiagnostics = recovering.executor.diagnostics();
        for (const hostile of hostileFullBindings(binding)) {
          for (const mode of ['execute', 'spawn'] as const) {
            const baseResume = createExecutorConformanceRequest({
              executorName: 'worker',
              taskId: initial.taskId,
              definition: DEFINITION_REF,
              input: initial.input,
              operation: {
                type: 'resume',
                operationId: `worker-hostile-${mode}-resume-${hostile.label}`,
                reason: 'checkpoint',
                binding,
                checkpoint,
              },
            });
            const resume = Object.freeze({
              ...baseResume,
              operation: Object.freeze({ ...baseResume.operation, binding: hostile.binding }),
            }) as SubAgentExecutionRequest;
            const recorder = createControl(resume);
            await expect(recovering.executor[mode](resume, recorder.control)).rejects.toMatchObject(
              {
                code: 'BINDING_INVALID',
              },
            );
            expect(hostile.getterCalls(), `${mode}:${hostile.label}`).toBe(0);
            expect(recorder.snapshot(), `${mode}:${hostile.label}`).toMatchObject({
              bindings: [],
              checkpoints: [],
              approvalInputs: [],
              progress: [],
              usage: [],
              events: [],
            });
            expect(recovering.executor.diagnostics(), `${mode}:${hostile.label}`).toEqual(
              recoveryDiagnostics,
            );
          }
        }
        for (const [index, tampered] of tamperedBindings(binding).entries()) {
          const resume = createExecutorConformanceRequest({
            executorName: 'worker',
            taskId: initial.taskId,
            definition: DEFINITION_REF,
            input: initial.input,
            operation: {
              type: 'resume',
              operationId: `worker-tampered-resume-${index}`,
              reason: 'checkpoint',
              binding: tampered,
              checkpoint,
            },
          });
          const recorder = createControl(resume);
          await expect(recovering.executor.execute(resume, recorder.control)).rejects.toMatchObject(
            { code: 'BINDING_INVALID' },
          );
          expect(recorder.snapshot()).toMatchObject({ bindings: [], checkpoints: [] });
        }
        expect(recovering.model).not.toHaveBeenCalled();
        expect(recovering.executor.diagnostics()).toMatchObject({
          activeWorkers: 0,
          startingWorkers: 0,
          crashes: 1,
        });
      } finally {
        await recovering.executor.dispose();
      }
    },
  );

  acceptanceIt(
    'C7-WORKER-26.l3.spawn-terminal-replay',
    'terminal-handle-without-new-worker-or-side-effect',
    async () => {
      const { executor, model } = createExecutor();
      const request = createRequest('worker-spawn-terminal-replay', 'settle');
      const recorder = createControl(request);
      try {
        const first = await executor.spawn(request, recorder.control);
        if ('type' in first) throw new Error('Expected the first Worker task handle.');
        await expect(first.wait()).resolves.toMatchObject({
          type: 'terminal',
          result: {
            status: 'succeeded',
            output: { details: { factoryCreates: 1 } },
          },
        });
        await expectNoLiveResources(executor);
        const beforeReplay = executor.diagnostics();

        const replay = await executor.spawn(request, recorder.control);
        if ('type' in replay) throw new Error('Expected a terminal replay handle.');
        expect(replay.binding).toEqual(first.binding);
        await expect(replay.wait()).resolves.toMatchObject({
          type: 'terminal',
          result: {
            status: 'succeeded',
            output: { details: { factoryCreates: 1 } },
          },
        });
        expect(recorder.snapshot().bindings).toHaveLength(1);
        expect(executor.diagnostics()).toEqual(beforeReplay);
        expect(model).not.toHaveBeenCalled();
      } finally {
        await executor.dispose();
      }
    },
  );

  it('evicts nested spawn handles after terminal waits across repeated real Worker runs', async () => {
    const nestedHandles = new Map<string, SubAgentTaskHandle>();
    const resolvedScopes: Array<{
      readonly ownerSessionId: string;
      readonly parentTaskId?: string;
      readonly taskId: string;
    }> = [];
    const resolveNestedTaskHandle: SubAgentTransportTaskHandleResolver<SubAgentTaskHandle> = vi.fn(
      async (scope) => {
        resolvedScopes.push(Object.freeze({ ...scope }));
        return nestedHandles.get(nestedScopeKey(scope));
      },
    );
    const { executor, model } = createExecutor({ resolveNestedTaskHandle });

    try {
      for (let round = 1; round <= 8; round += 1) {
        const request = createRequest(`worker-nested-lifecycle-${round}`, 'nested-spawn-wait');
        const nestedTaskId = `nested-worker-task-${round}`;
        const nested = createNestedTaskHandle(request, nestedTaskId);
        const nestedScope = Object.freeze({
          ownerSessionId: request.ownerSessionId,
          parentTaskId: request.taskId,
          taskId: nestedTaskId,
        });
        nestedHandles.set(nestedScopeKey(nestedScope), nested);
        const recorder = createControl(request);
        const spawn = vi.fn(async () => nested);
        const control = Object.freeze({
          ...recorder.control,
          delegation: Object.freeze({ ...recorder.control.delegation, spawn }),
        });

        await expect(executor.execute(request, control)).resolves.toMatchObject({
          type: 'terminal',
          result: {
            status: 'succeeded',
            output: {
              answer: 'worker:nested-spawn-wait',
              details: {
                nestedTaskId,
                statuses: ['succeeded', 'succeeded'],
              },
            },
          },
        });
        expect(spawn).toHaveBeenCalledOnce();
        expect(nested.wait).toHaveBeenCalledTimes(2);
        expect(resolvedScopes).toHaveLength(round);
        expect(resolvedScopes.at(-1)).toEqual(nestedScope);
        nestedHandles.delete(nestedScopeKey(nestedScope));

        await expectNoLiveResources(executor);
        expect(executor.diagnostics()).toMatchObject({
          activeWorkers: 0,
          startingWorkers: 0,
          ports: 0,
          timers: 0,
          crashes: 0,
        });
      }
      expect(model).not.toHaveBeenCalled();
      expect(nestedHandles.size).toBe(0);
    } finally {
      await executor.dispose();
    }

    expect(executor.diagnostics()).toMatchObject({
      activeWorkers: 0,
      startingWorkers: 0,
      retainedTasks: 0,
      cancelReceipts: 0,
      ports: 0,
      timers: 0,
      crashes: 0,
      disposed: true,
    });
  });
});

function tamperedBindings(binding: SubAgentExecutorBinding): readonly SubAgentExecutorBinding[] {
  const modelBinding = binding.modelBinding;
  if (modelBinding === undefined) throw new Error('Worker bindings require a Model binding.');
  return Object.freeze([
    Object.freeze({ ...binding, executorName: 'another-worker' }),
    Object.freeze({ ...binding, subagentSessionId: 'another-subagent-session' }),
    Object.freeze({ ...binding, definitionName: 'another-definition' }),
    Object.freeze({ ...binding, definitionVersion: '999' }),
    Object.freeze({ ...binding, runnerId: 'another-runner' }),
    Object.freeze({ ...binding, runnerVersion: '999' }),
    Object.freeze({ ...binding, adapterStateVersion: '999' }),
    Object.freeze({
      ...binding,
      modelBinding: Object.freeze({ ...modelBinding, gatewayId: 'another-gateway' }),
    }),
    Object.freeze({
      ...binding,
      modelBinding: Object.freeze({ ...modelBinding, protocol: 'another-protocol' }),
    }),
    Object.freeze({
      ...binding,
      modelBinding: Object.freeze({ ...modelBinding, codecVersion: '999' }),
    }),
    Object.freeze({
      ...binding,
      recoveryData: Object.freeze({
        kind: 'maneeagent-worker/v1',
        jobId: 'another-worker-job',
      }),
    }),
  ]);
}

function hostileFullBindings(binding: SubAgentExecutorBinding): readonly {
  readonly label: string;
  readonly binding: SubAgentExecutorBinding;
  readonly getterCalls: () => number;
}[] {
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
        throw new Error(`The Worker binding ${field} getter must never execute.`);
      },
    };
    return Object.freeze({
      label: `accessor-${field}`,
      binding: Object.defineProperties({}, descriptors) as SubAgentExecutorBinding,
      getterCalls: () => getterCalls,
    });
  });

  const symbolBinding = { ...binding } as Record<PropertyKey, unknown>;
  symbolBinding[Symbol('hostile-worker-binding')] = 'hidden';
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
