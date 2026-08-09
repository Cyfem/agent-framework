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

import { ProcessSubAgentExecutor } from '../src';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const TARGET_ENTRY = new URL('./fixtures/process-conformance-target.mjs', import.meta.url);
const HANDSHAKE_TIMEOUT_ENTRY = new URL(
  './fixtures/process-handshake-timeout-target.mjs',
  import.meta.url,
);
const DUPLICATE_READY_ENTRY = new URL(
  './fixtures/process-duplicate-ready-target.mjs',
  import.meta.url,
);
const PRE_READY_PACKET_ENTRY = new URL(
  './fixtures/process-pre-ready-packet-target.mjs',
  import.meta.url,
);
const FORGED_MANIFEST_ENTRY = new URL(
  './fixtures/process-forged-manifest-target.mjs',
  import.meta.url,
);
const FORGED_DIGEST_ENTRY = new URL('./fixtures/process-forged-digest-target.mjs', import.meta.url);
const CHANNEL_CLOSE_ENTRY = new URL('./fixtures/process-channel-close-target.mjs', import.meta.url);
const FATAL_ENTRY = new URL('./fixtures/process-fatal-target.mjs', import.meta.url);
const DEFINITION_REF = Object.freeze({ name: 'process-conformance-child', version: '2' });
const manifestDefinition: SubAgentDefinitionRegistration = Object.freeze({
  ...DEFINITION_REF,
  description: 'Manifest-only Process lifecycle fixture definition.',
  inputSchema: z.json(),
  outputSchema: z.json(),
});

function createExpectedManifest(): SubAgentTargetRunnerManifest {
  return new SubAgentTargetRunnerRegistry()
    .register({
      definition: manifestDefinition,
      runnerId: 'process-conformance-runner',
      runnerVersion: '2.0.0',
      childCheckpointVersions: ['1'],
      modelBinding: {
        gatewayId: 'process-conformance-model',
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
  overrides: Partial<ConstructorParameters<typeof ProcessSubAgentExecutor>[0]> = {},
) {
  const model = vi.fn<SubAgentTransportModelRequestHandler>(async () => {
    throw new Error('The deterministic lifecycle fixture must not call a Model.');
  });
  return {
    model,
    executor: new ProcessSubAgentExecutor({
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
    executorName: 'process',
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
    executor: 'process',
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
      executor: 'process',
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

async function expectNoLiveResources(executor: ProcessSubAgentExecutor): Promise<void> {
  await vi.waitFor(() => {
    expect(executor.diagnostics()).toMatchObject({
      activeProcesses: 0,
      startingProcesses: 0,
      channels: 0,
      timers: 0,
    });
  });
}

describe('ProcessSubAgentExecutor real child_process lifecycle', () => {
  acceptanceIt(
    'C7-PROCESS-12.l3.strict-startup-handshake',
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
        const request = createRequest(`process-handshake-${testCase.name}`, 'settle');
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
    'C7-PROCESS-13.l3.post-admission-unbound-retry',
    'same-task-attempt-two',
    async () => {
      const { executor, model } = createExecutor();
      const first = createRequest('process-post-admission-first', 'post-admission-crash');
      const firstControl = createControl(first);
      try {
        await expect(executor.execute(first, firstControl.control)).resolves.toMatchObject({
          type: 'recovery_required',
          reason: 'unbound_create',
          operationId: first.operation.operationId,
          causeCode: 'PROCESS_EXIT',
        });
        expect(firstControl.snapshot()).toMatchObject({ bindings: [], checkpoints: [] });
        expect(executor.diagnostics().crashes).toBe(1);

        const second = Object.freeze({
          ...first,
          attempt: 2,
          executionEpoch: 'process-post-admission-attempt-2',
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

  acceptanceIt('C7-PROCESS-14.l3.checkpoint-crash-recovery', 'fresh-process-resume', async () => {
    const { executor, model } = createExecutor();
    const initial = createRequest('process-checkpoint-crash', 'checkpoint-crash');
    const initialControl = createControl(initial);
    try {
      await expect(executor.execute(initial, initialControl.control)).resolves.toMatchObject({
        type: 'recovery_required',
        reason: 'checkpoint',
        operationId: initial.operation.operationId,
        causeCode: 'PROCESS_EXIT',
      });
      const initialSnapshot = initialControl.snapshot();
      const binding = onlyBinding(initialSnapshot.bindings);
      expect(initialSnapshot.checkpoints).toHaveLength(1);

      const resume = createExecutorConformanceRequest({
        executorName: 'process',
        taskId: initial.taskId,
        definition: DEFINITION_REF,
        input: { scenario: 'checkpoint-crash' },
        operation: {
          type: 'resume',
          operationId: 'process-checkpoint-crash-resume',
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
    'C7-PROCESS-15.l3.cancel-terminate-fallback',
    'request-signal-executor-handle',
    async () => {
      const modes = ['request-signal', 'executor-cancel', 'handle-cancel'] as const;
      for (const mode of modes) {
        const { executor, model } = createExecutor({ terminateTimeoutMs: 500 });
        const abort = new AbortController();
        const request = createRequest(`process-cancel-${mode}`, 'terminate-fallback', {
          signal: abort.signal,
        });
        const recorder = createControl(request);
        try {
          let cancellationStartedAt = 0;
          if (mode === 'request-signal') {
            const cancelled = new SubAgentRuntimeError({
              code: 'CANCELLED',
              message: 'The Process request signal was cancelled.',
              retryable: false,
            });
            const running = executor.execute(request, recorder.control);
            await vi.waitFor(() => expect(executor.diagnostics().activeProcesses).toBe(1));
            cancellationStartedAt = performance.now();
            abort.abort(cancelled);
            await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
          } else {
            const spawned = await executor.spawn(request, recorder.control);
            if ('type' in spawned) throw new Error('Expected a live Process task handle.');
            await vi.waitFor(() => expect(executor.diagnostics().activeProcesses).toBe(1));
            cancellationStartedAt = performance.now();
            if (mode === 'executor-cancel') {
              await executor.cancel(spawned.binding, {
                operationId: 'process-explicit-cancel',
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
    'C7-PROCESS-16.l3.active-scope-and-create-identity',
    'singleflight-before-capacity-mode-cross-session-stale-job',
    async () => {
      const saturated = createExecutor({ maxConcurrentProcesses: 1, terminateTimeoutMs: 100 });
      const saturatedAbort = new AbortController();
      const saturatedRequest = createRequest(
        'process-saturated-create-singleflight',
        'terminate-fallback',
        { signal: saturatedAbort.signal },
      );
      const saturatedControl = createControl(saturatedRequest);
      const firstSaturated = saturated.executor.execute(saturatedRequest, saturatedControl.control);
      void firstSaturated.catch(() => undefined);
      let exactReplay: ReturnType<ProcessSubAgentExecutor['execute']> | undefined;
      try {
        await vi.waitFor(() =>
          expect(saturated.executor.diagnostics()).toMatchObject({ activeProcesses: 1 }),
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

        const unique = createRequest('process-saturated-unique-overflow', 'settle');
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
      const exactRequest = createRequest('process-exact-create-singleflight', 'settle');
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
      const request = createRequest('process-live-scope', 'terminate-fallback');
      const recorder = createControl(request);
      try {
        const spawned = await executor.spawn(request, recorder.control);
        if ('type' in spawned) throw new Error('Expected a live Process task handle.');
        await vi.waitFor(() => expect(executor.diagnostics().activeProcesses).toBe(1));

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
          ownerSessionId: 'process-other-owner',
          subagentSessionId: 'process-other-subagent-session',
        });
        await expect(
          executor.execute(crossSession, createControl(crossSession).control),
        ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

        const staleBinding = Object.freeze({
          ...spawned.binding,
          recoveryData: Object.freeze({
            kind: 'maneeagent-process/v1',
            jobId: 'stale-process-job',
          }),
        });
        await expect(
          executor.cancel(staleBinding, {
            operationId: 'process-stale-binding-cancel',
            signal: new AbortController().signal,
            deadlineAt: Date.now() + 1_000,
          }),
        ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
        expect(executor.diagnostics().activeProcesses).toBe(1);

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
    'C7-PROCESS-17.l3.max-concurrency-and-cleanup',
    'starting-plus-active-bounded',
    async () => {
      const starting = createExecutor({
        targetEntry: HANDSHAKE_TIMEOUT_ENTRY,
        handshakeTimeoutMs: 5_000,
        maxConcurrentProcesses: 2,
      });
      const startRequests = [
        createRequest('process-starting-1', 'settle'),
        createRequest('process-starting-2', 'settle'),
      ];
      const pending = startRequests.map((request) =>
        starting.executor.execute(request, createControl(request).control),
      );
      for (const operation of pending) void operation.catch(() => undefined);
      try {
        await vi.waitFor(() =>
          expect(starting.executor.diagnostics()).toMatchObject({ startingProcesses: 2 }),
        );
        const retainedAtCapacity = starting.executor.diagnostics().retainedTasks;
        const overflow = createRequest('process-starting-overflow', 'settle');
        await expect(
          starting.executor.execute(overflow, createControl(overflow).control),
        ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
        expect(starting.executor.diagnostics()).toMatchObject({
          startingProcesses: 2,
          retainedTasks: retainedAtCapacity,
        });
      } finally {
        await starting.executor.dispose();
        await Promise.allSettled(pending);
      }
      await expectNoLiveResources(starting.executor);

      const active = createExecutor({ maxConcurrentProcesses: 2 });
      const requests = [
        createRequest('process-active-1', 'terminate-fallback'),
        createRequest('process-active-2', 'terminate-fallback'),
      ];
      try {
        const handles = await Promise.all(
          requests.map(async (request) => {
            const handle = await active.executor.spawn(request, createControl(request).control);
            if ('type' in handle) throw new Error('Expected a live Process task handle.');
            return handle;
          }),
        );
        await vi.waitFor(() =>
          expect(active.executor.diagnostics()).toMatchObject({ activeProcesses: 2 }),
        );
        const retainedAtCapacity = active.executor.diagnostics().retainedTasks;
        const overflow = createRequest('process-active-overflow', 'settle');
        const overflowControl = createControl(overflow);
        await expect(
          active.executor.execute(overflow, overflowControl.control),
        ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
        expect(active.executor.diagnostics()).toMatchObject({
          activeProcesses: 2,
          retainedTasks: retainedAtCapacity,
        });

        await handles[0]!.cancel('release one Process capacity slot');
        await expect(handles[0]!.wait()).rejects.toMatchObject({ code: 'CANCELLED' });
        await expect(
          active.executor.execute(overflow, overflowControl.control),
        ).resolves.toMatchObject({
          type: 'terminal',
          result: { status: 'succeeded' },
        });

        await handles[1]!.cancel('capacity test cleanup');
        await expect(handles[1]!.wait()).rejects.toMatchObject({ code: 'CANCELLED' });
        await expectNoLiveResources(active.executor);
      } finally {
        await active.executor.dispose();
      }
    },
  );
  acceptanceIt('C7-PROCESS-18.l3.stdio-secret-discard', 'captured-not-forwarded', async () => {
    const marker = `PROCESS_STDIO_SECRET_${Date.now()}_MUST_NOT_ESCAPE`;
    const { executor, model } = createExecutor();
    const request = createRequest('process-stdio-secret', 'output-secret', {
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
    'C7-PROCESS-19.l3.fresh-executor-resume-scope',
    'binding-and-checkpoint-imported-before-crash',
    async () => {
      const first = createExecutor();
      const initial = createRequest('process-fresh-executor-resume', 'checkpoint-crash', {
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
        throw new Error('The first Process must persist one binding and checkpoint.');
      }

      const second = createExecutor();
      const resumeBase = createExecutorConformanceRequest({
        executorName: 'process',
        taskId: initial.taskId,
        definition: DEFINITION_REF,
        input: initial.input,
        operation: {
          type: 'resume',
          operationId: 'process-fresh-executor-resume-operation',
          reason: 'checkpoint',
          binding,
          checkpoint,
        },
      });
      const resume = Object.freeze({
        ...resumeBase,
        attempt: 2,
        executionEpoch: 'process-fresh-executor-epoch-2',
        executionFencingToken: '2',
      });
      const resumeControl = createControl(resume);
      try {
        await expect(second.executor.execute(resume, resumeControl.control)).resolves.toMatchObject(
          {
            type: 'recovery_required',
            reason: 'checkpoint',
            causeCode: 'PROCESS_EXIT',
          },
        );
        expect(second.executor.diagnostics().crashes).toBe(1);
        expect(resumeControl.snapshot().progress).toContainEqual({
          message: 'process-resume-scope',
          data: {
            attempt: 2,
            executionEpoch: 'process-fresh-executor-epoch-2',
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
    'C7-PROCESS-22.l3.cancel-idempotency',
    'concurrent-terminal-conflict-and-hidden-resource',
    async () => {
      const { executor, model } = createExecutor();
      const request = createRequest('process-cancel-idempotency', 'cancel');
      const recorder = createControl(request);
      try {
        const spawned = await executor.spawn(request, recorder.control);
        if ('type' in spawned) throw new Error('Expected a live Process task handle.');
        await vi.waitFor(() => expect(executor.diagnostics().activeProcesses).toBe(1));
        const options = Object.freeze({
          operationId: 'process-idempotent-cancel-operation',
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
          taskId: 'process-cancel-unknown-task',
          subagentSessionId: 'session:process-cancel-unknown-task',
        });
        await expect(executor.cancel(unknownBinding, options)).rejects.toMatchObject({
          code: 'RESOURCE_NOT_FOUND',
        });
        const crossOwnerBinding = Object.freeze({
          ...spawned.binding,
          ownerSessionId: 'process-cancel-cross-owner',
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
            message: 'process-cancel-observed',
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
    'C7-PROCESS-23.l3.channel-and-output-policy-fail-close',
    'unsolicited-ipc-close-and-stdio-overflow',
    async () => {
      for (const scenario of ['channel-close', 'stdout-overflow'] as const) {
        const { executor, model } = createExecutor({
          ...(scenario === 'channel-close' ? { targetEntry: CHANNEL_CLOSE_ENTRY } : {}),
        });
        const request = createRequest(`process-policy-${scenario}`, scenario);
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
    'C7-PROCESS-27.l3.cancel-receipt-capacity',
    'closed-capacity-byte-boundary-and-aborted-replay',
    async () => {
      const { executor, model } = createExecutor();
      const request = createRequest('process-cancel-receipt-capacity', 'settle');
      const recorder = createControl(request);
      try {
        const spawned = await executor.spawn(request, recorder.control);
        if ('type' in spawned) throw new Error('Expected a Process task handle.');
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
    'C7-PROCESS-24.l3.binding-integrity-before-target',
    'cancel-and-resume-closed-binding',
    async () => {
      const live = createExecutor();
      const liveRequest = createRequest('process-binding-live', 'terminate-fallback');
      const liveControl = createControl(liveRequest);
      try {
        const spawned = await live.executor.spawn(liveRequest, liveControl.control);
        if ('type' in spawned) throw new Error('Expected a live Process task handle.');
        await vi.waitFor(() => expect(live.executor.diagnostics().activeProcesses).toBe(1));
        const liveDiagnostics = live.executor.diagnostics();
        const liveControlSnapshot = liveControl.snapshot();
        for (const hostile of hostileFullBindings(spawned.binding)) {
          await expect(
            live.executor.cancel(hostile.binding, {
              operationId: `process-hostile-cancel-${hostile.label}`,
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
              operationId: `process-tampered-cancel-${index}`,
              signal: new AbortController().signal,
              deadlineAt: Date.now() + 1_000,
            }),
          ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
        }
        expect(live.executor.diagnostics().activeProcesses).toBe(1);
        expect(live.model).not.toHaveBeenCalled();
        await spawned.cancel('binding integrity cleanup');
        await Promise.allSettled([spawned.wait()]);
      } finally {
        await live.executor.dispose();
      }

      const recovering = createExecutor();
      const initial = createRequest('process-binding-resume', 'checkpoint-crash');
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
          const baseResume = createExecutorConformanceRequest({
            executorName: 'process',
            taskId: initial.taskId,
            definition: DEFINITION_REF,
            input: initial.input,
            operation: {
              type: 'resume',
              operationId: `process-hostile-resume-${hostile.label}`,
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
          await expect(recovering.executor.execute(resume, recorder.control)).rejects.toMatchObject(
            { code: 'BINDING_INVALID' },
          );
          expect(hostile.getterCalls(), hostile.label).toBe(0);
          expect(recorder.snapshot(), hostile.label).toMatchObject({
            bindings: [],
            checkpoints: [],
            approvalInputs: [],
            progress: [],
            usage: [],
            events: [],
          });
          expect(recovering.executor.diagnostics(), hostile.label).toEqual(recoveryDiagnostics);
        }
        for (const [index, tampered] of tamperedBindings(binding).entries()) {
          const resume = createExecutorConformanceRequest({
            executorName: 'process',
            taskId: initial.taskId,
            definition: DEFINITION_REF,
            input: initial.input,
            operation: {
              type: 'resume',
              operationId: `process-tampered-resume-${index}`,
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
          activeProcesses: 0,
          startingProcesses: 0,
          crashes: 1,
        });
      } finally {
        await recovering.executor.dispose();
      }
    },
  );

  acceptanceIt(
    'C7-PROCESS-26.l3.spawn-terminal-replay',
    'terminal-handle-without-new-process-or-side-effect',
    async () => {
      const { executor, model } = createExecutor();
      const request = createRequest('process-spawn-terminal-replay', 'settle');
      const recorder = createControl(request);
      try {
        const first = await executor.spawn(request, recorder.control);
        if ('type' in first) throw new Error('Expected the first Process task handle.');
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

  it('evicts nested spawn handles after terminal waits across repeated real Process runs', async () => {
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
        const request = createRequest(`process-nested-lifecycle-${round}`, 'nested-spawn-wait');
        const nestedTaskId = `nested-process-task-${round}`;
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
              answer: 'process:nested-spawn-wait',
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
          activeProcesses: 0,
          startingProcesses: 0,
          channels: 0,
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
      activeProcesses: 0,
      startingProcesses: 0,
      retainedTasks: 0,
      cancelReceipts: 0,
      channels: 0,
      timers: 0,
      crashes: 0,
      disposed: true,
    });
  });
});

function tamperedBindings(binding: SubAgentExecutorBinding): readonly SubAgentExecutorBinding[] {
  const modelBinding = binding.modelBinding;
  if (modelBinding === undefined) throw new Error('Process bindings require a Model binding.');
  return Object.freeze([
    Object.freeze({ ...binding, executorName: 'another-process' }),
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
        kind: 'maneeagent-process/v1',
        jobId: 'another-process-job',
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
        throw new Error(`The Process binding ${field} getter must never execute.`);
      },
    };
    return Object.freeze({
      label: `accessor-${field}`,
      binding: Object.defineProperties({}, descriptors) as SubAgentExecutorBinding,
      getterCalls: () => getterCalls,
    });
  });

  const symbolBinding = { ...binding } as Record<PropertyKey, unknown>;
  symbolBinding[Symbol('hostile-process-binding')] = 'hidden';
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
