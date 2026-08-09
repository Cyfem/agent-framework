import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

import { describe, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  acceptanceIt,
  createExecutorConformanceControl,
  createExecutorConformanceRequest,
} from '../../../testkit';

import {
  canonicalJsonSha256,
  MemoryProviderOperationLedgerStore,
  OpenAIChatModel,
  ProviderOperationLedger,
  SubAgentTargetRunnerRegistry,
  SubAgentTransportModelGatewayHandler,
  SubAgentTransportModelGatewayRegistry,
  type ExecutorTaskHandle,
  type JsonValue,
  type SubAgentChildCheckpoint,
  type SubAgentDefinitionRegistration,
  type SubAgentExecutionControl,
  type SubAgentExecutionOutcome,
  type SubAgentExecutionRequest,
  type SubAgentExecutorBinding,
  type SubAgentTargetRunnerManifest,
  type SubAgentTransportModelRequestHandler,
} from '@ruixutong.manee/maneeagent-framework';

import { ProcessSubAgentExecutor } from '../src';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const TARGET_ENTRY = new URL('./fixtures/process-f19-target.mjs', import.meta.url);
const DEFINITION_REF = Object.freeze({ name: 'process-f19-child', version: '2' });
const PROOF = 'process-f19-provider-proof';
const manifestDefinition: SubAgentDefinitionRegistration = Object.freeze({
  ...DEFINITION_REF,
  description: 'Manifest-only Process F19 definition.',
  inputSchema: z.json(),
  outputSchema: z.json(),
});

function createExpectedManifest(): SubAgentTargetRunnerManifest {
  return new SubAgentTargetRunnerRegistry()
    .register({
      definition: manifestDefinition,
      runnerId: 'process-f19-runner',
      runnerVersion: '2.0.0',
      childCheckpointVersions: ['1'],
      modelBinding: {
        gatewayId: 'process-f19-gateway',
        protocol: 'openai-chat',
        codecVersion: '1',
      },
      create: () => ({
        run: async () => {
          throw new Error('The controller F19 manifest factory must not run.');
        },
      }),
    })
    .seal()
    .manifest();
}

type F19Mode = 'result-ready' | 'outcome-unknown';
type PlacementMode = 'execute' | 'spawn-wait';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface F19Harness {
  readonly executor: ProcessSubAgentExecutor;
  readonly request: SubAgentExecutionRequest;
  readonly control: SubAgentExecutionControl;
  readonly sdkCreate: ReturnType<typeof vi.fn>;
  readonly sdkStarted: Promise<void>;
  readonly firstReplyPersisted: Promise<void>;
  readonly secondReplyPersisted: Promise<void>;
  releaseFirstReply(): void;
  releaseSecondReply(): void;
  crashTarget(): void;
  cleanupCrashSignal(): void;
  rejectProvider(error: unknown): void;
  terminalizeProviderOutcomeUnknown(): Promise<void>;
  modelHandlerCalls(): number;
  snapshot(): Readonly<{
    bindings: readonly SubAgentExecutorBinding[];
    checkpoints: readonly SubAgentChildCheckpoint[];
  }>;
}

function createHarness(
  mode: F19Mode,
  suffix: string,
  options: {
    readonly crashOnResume?: boolean;
    readonly heldReplies?: number;
    readonly terminateTimeoutMs?: number;
  } = {},
): F19Harness {
  const provider = deferred<ReturnType<typeof chatTextResponse>>();
  void provider.promise.catch(() => undefined);
  const sdkStarted = deferred<void>();
  const firstReplyPersisted = deferred<void>();
  const secondReplyPersisted = deferred<void>();
  const releaseFirstReply = deferred<void>();
  const releaseSecondReply = deferred<void>();
  const crashPath = join(tmpdir(), `maneeagent-process-f19-${mode}-${suffix}.signal`);
  rmSync(crashPath, { force: true });
  const sdkCreate = vi.fn(() => {
    sdkStarted.resolve();
    return mode === 'result-ready' ? Promise.resolve(chatTextResponse(PROOF)) : provider.promise;
  });
  const model = new OpenAIChatModel({
    model: 'offline-process-f19',
    client: { chat: { completions: { create: sdkCreate } } } as never,
  });
  const gatewayRegistry = new SubAgentTransportModelGatewayRegistry();
  gatewayRegistry.register({
    gatewayId: 'process-f19-gateway',
    protocol: 'openai-chat',
    codec: model.checkpointCodec,
    model,
  });
  gatewayRegistry.seal();

  const request = createExecutorConformanceRequest({
    executorName: 'process',
    taskId: `process-f19-${mode}-${suffix}`,
    definition: DEFINITION_REF,
    input: { scenario: mode, proof: PROOF, crashOnResume: options.crashOnResume === true },
  });
  const recorder = createExecutorConformanceControl({
    ownerSessionId: request.ownerSessionId,
    taskId: request.taskId,
    signal: request.signal,
    deadlineAt: request.deadlineAt,
    approval: 'approved',
  });
  const checkpoints = new Map<
    string,
    Readonly<{ digest: string; revision: number; checkpoint: SubAgentChildCheckpoint }>
  >();
  const control = Object.freeze({
    ...recorder.control,
    commitCheckpoint: async (operationId: string, checkpoint: SubAgentChildCheckpoint) => {
      const digest = canonicalJsonSha256(checkpoint as unknown as JsonValue);
      const existing = checkpoints.get(operationId);
      if (existing !== undefined) {
        expect(existing.digest).toBe(digest);
        expect(existing.checkpoint).toEqual(checkpoint);
        return;
      }
      checkpoints.set(operationId, {
        digest,
        revision: checkpoints.size + 1,
        checkpoint: structuredClone(checkpoint),
      });
      await recorder.control.commitCheckpoint(operationId, checkpoint);
    },
  });
  const ledger = new ProviderOperationLedger({ store: new MemoryProviderOperationLedgerStore() });
  const gateway = new SubAgentTransportModelGatewayHandler({
    registry: gatewayRegistry,
    ledger,
    acknowledgeCheckpoint: (operation) => {
      const checkpoint = checkpoints.get(operation.checkpointOperationId);
      if (checkpoint === undefined || checkpoint.digest !== operation.checkpointDigest) {
        throw new Error('The F19 provider request did not reference an acknowledged checkpoint.');
      }
      return {
        checkpointRevision: checkpoint.revision,
        checkpointDigest: checkpoint.digest,
      };
    },
    reserveBudget: () => undefined,
  });
  let handlerCalls = 0;
  const modelHandler: SubAgentTransportModelRequestHandler = async (context) => {
    handlerCalls += 1;
    const invocation = handlerCalls;
    const reply = await gateway.handle({
      ownerSessionId: context.ownerSessionId,
      taskId: context.taskId,
      operationId: context.operationId,
      payload: context.payload,
      signal: context.signal,
      deadlineAt: context.deadlineAt,
    });
    if (mode === 'result-ready' && invocation <= (options.heldReplies ?? 1)) {
      const persisted = invocation === 1 ? firstReplyPersisted : secondReplyPersisted;
      const release = invocation === 1 ? releaseFirstReply : releaseSecondReply;
      persisted.resolve();
      await release.promise;
    }
    return reply;
  };

  return {
    executor: new ProcessSubAgentExecutor({
      targetEntry: TARGET_ENTRY,
      expectedManifest: createExpectedManifest(),
      model: modelHandler,
      handshakeTimeoutMs: 5_000,
      terminateTimeoutMs: options.terminateTimeoutMs ?? 50,
    }),
    request,
    control,
    sdkCreate,
    sdkStarted: sdkStarted.promise,
    firstReplyPersisted: firstReplyPersisted.promise,
    secondReplyPersisted: secondReplyPersisted.promise,
    releaseFirstReply: () => releaseFirstReply.resolve(),
    releaseSecondReply: () => releaseSecondReply.resolve(),
    crashTarget: () => {
      writeFileSync(crashPath, 'crash-after-controller-barrier', { flag: 'wx' });
    },
    cleanupCrashSignal: () => rmSync(crashPath, { force: true }),
    rejectProvider: (error) => provider.reject(error),
    terminalizeProviderOutcomeUnknown: async () => {
      const recovered = await ledger.recoverInFlight({
        ownerSessionId: request.ownerSessionId,
        taskId: request.taskId,
        providerOperationId: `process-f19-provider-${request.taskId}`,
      });
      expect(recovered.status).toBe('outcome_unknown');
    },
    modelHandlerCalls: () => handlerCalls,
    snapshot: () => recorder.snapshot(),
  };
}

async function startPlacement(
  harness: F19Harness,
  mode: PlacementMode,
): Promise<{
  readonly settled: Promise<SubAgentExecutionOutcome>;
  readonly handle?: ExecutorTaskHandle;
}> {
  if (mode === 'execute') {
    const running = harness.executor.execute(harness.request, harness.control);
    void running.catch(() => undefined);
    return {
      settled: running.then((outcome) => {
        if (outcome.type === 'recovery_required') {
          throw new Error('F19 internal recovery must not escape as a host recovery marker.');
        }
        return outcome;
      }),
    };
  }
  const spawned = await harness.executor.spawn(harness.request, harness.control);
  if ('type' in spawned) throw new Error('Expected a raw Process task handle.');
  const settled = waitWithoutRecoveryMarker(spawned);
  void settled.catch(() => undefined);
  return { settled, handle: spawned };
}

async function waitWithoutRecoveryMarker(
  handle: ExecutorTaskHandle,
): Promise<SubAgentExecutionOutcome> {
  const outcome = await handle.wait();
  if (outcome.type === 'recovery_required') {
    throw new Error('F19 raw handle wait must perform internal recovery.');
  }
  return outcome;
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

describe('Process F19 provider recovery windows', () => {
  acceptanceIt(
    'C7-PROCESS-20.l3.result-ready-reply-loss',
    'execute-and-spawn-wait-same-provider-operation',
    async () => {
      assertNetworkDenyGuardInstalled();
      for (const placement of ['execute', 'spawn-wait'] as const) {
        const harness = createHarness('result-ready', placement, {
          terminateTimeoutMs: placement === 'execute' ? 0 : 50,
        });
        try {
          const { settled, handle } = await startPlacement(harness, placement);
          await harness.firstReplyPersisted;
          harness.crashTarget();
          await vi.waitFor(() => expect(harness.executor.diagnostics().crashes).toBe(1));
          harness.releaseFirstReply();
          const outcome = await settled;
          expect(outcome).toMatchObject({
            type: 'terminal',
            result: {
              status: 'succeeded',
              output: {
                proof: PROOF,
                attempt: harness.request.attempt,
                executionEpoch: harness.request.executionEpoch,
                executionFencingToken: harness.request.executionFencingToken,
                providerOperationId: `process-f19-provider-${harness.request.taskId}`,
              },
            },
          });
          if (handle !== undefined) {
            const beforeReplay = harness.snapshot();
            await expect(handle.wait()).resolves.toEqual(outcome);
            await expect(handle.snapshot()).resolves.toMatchObject({
              taskId: harness.request.taskId,
              state: 'succeeded',
              binding: handle.binding,
            });
            const events = handle.events()[Symbol.asyncIterator]();
            await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
            await expect(handle.cancel('terminal F19 facade no-op')).resolves.toBeUndefined();
            expect(harness.snapshot()).toEqual(beforeReplay);
          }
          expect(harness.sdkCreate).toHaveBeenCalledTimes(1);
          expect(harness.modelHandlerCalls()).toBeGreaterThanOrEqual(2);
          expect(harness.executor.diagnostics().crashes).toBe(1);
          harness.cleanupCrashSignal();
          await expectNoLiveResources(harness.executor);
        } finally {
          harness.releaseFirstReply();
          harness.releaseSecondReply();
          harness.cleanupCrashSignal();
          await harness.executor.dispose();
        }
      }
    },
  );

  acceptanceIt(
    'C7-PROCESS-21.l3.provider-in-flight-unknown',
    'execute-and-spawn-wait-no-provider-resend',
    async () => {
      assertNetworkDenyGuardInstalled();
      for (const placement of ['execute', 'spawn-wait'] as const) {
        const harness = createHarness('outcome-unknown', placement);
        try {
          const { settled } = await withPhaseDeadline(
            startPlacement(harness, placement),
            `${placement}:start`,
          );
          await withPhaseDeadline(harness.sdkStarted, `${placement}:sdk-started`);
          harness.crashTarget();
          await vi.waitFor(() => expect(harness.executor.diagnostics().crashes).toBe(1));
          await harness.terminalizeProviderOutcomeUnknown();
          harness.rejectProvider(new Error('Provider connection ended after dispatch.'));
          await expect(
            withPhaseDeadline(settled, `${placement}:unknown-settlement`),
          ).rejects.toMatchObject({
            code: 'EXECUTOR_FAILED',
            descriptor: {
              causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN',
              outcomeUnknown: true,
            },
          });
          expect(harness.sdkCreate).toHaveBeenCalledTimes(1);
          expect(harness.modelHandlerCalls()).toBeGreaterThanOrEqual(2);
          harness.cleanupCrashSignal();
          await expectNoLiveResources(harness.executor);
        } finally {
          harness.rejectProvider(new Error('F19 fixture disposed.'));
          harness.cleanupCrashSignal();
          await harness.executor.dispose();
        }
      }
    },
  );

  acceptanceIt(
    'C7-PROCESS-25.l3.internal-recovery-epoch-quota',
    'one-rebuild-per-core-execution-scope',
    async () => {
      const harness = createHarness('result-ready', 'epoch-quota', {
        crashOnResume: true,
        heldReplies: 2,
      });
      try {
        const running = harness.executor.execute(harness.request, harness.control);
        void running.catch(() => undefined);
        await harness.firstReplyPersisted;
        harness.crashTarget();
        await vi.waitFor(() => expect(harness.executor.diagnostics().crashes).toBe(1));
        harness.releaseFirstReply();
        await harness.secondReplyPersisted;
        harness.crashTarget();
        await vi.waitFor(() => expect(harness.executor.diagnostics().crashes).toBe(2));
        harness.releaseSecondReply();
        await expect(running).rejects.toMatchObject({
          code: 'EXECUTOR_FAILED',
          retryable: false,
        });
        expect(harness.sdkCreate).toHaveBeenCalledTimes(1);
        expect(harness.modelHandlerCalls()).toBe(2);
        expect(harness.executor.diagnostics()).toMatchObject({ crashes: 2, terminations: 0 });
        await expectNoLiveResources(harness.executor);

        const snapshot = harness.snapshot();
        expect(snapshot.bindings).toHaveLength(1);
        expect(snapshot.checkpoints).toHaveLength(1);
        const resumeBase = createExecutorConformanceRequest({
          executorName: 'process',
          taskId: harness.request.taskId,
          definition: DEFINITION_REF,
          input: harness.request.input,
          operation: {
            type: 'resume',
            operationId: 'process-f19-new-core-epoch-resume',
            reason: 'checkpoint',
            binding: snapshot.bindings[0]!,
            checkpoint: snapshot.checkpoints[0]!,
          },
        });
        const resume = Object.freeze({
          ...resumeBase,
          attempt: 2,
          executionEpoch: 'process-f19-new-core-epoch-2',
          executionFencingToken: '2',
        });
        const resumeRecorder = createExecutorConformanceControl({
          ownerSessionId: resume.ownerSessionId,
          taskId: resume.taskId,
          signal: resume.signal,
          deadlineAt: resume.deadlineAt,
          approval: 'approved',
        });
        await expect(
          harness.executor.execute(resume, resumeRecorder.control),
        ).resolves.toMatchObject({
          type: 'terminal',
          result: {
            status: 'succeeded',
            output: {
              proof: PROOF,
              attempt: 2,
              executionEpoch: 'process-f19-new-core-epoch-2',
              executionFencingToken: '2',
            },
          },
        });
        expect(harness.sdkCreate).toHaveBeenCalledTimes(1);
        expect(harness.modelHandlerCalls()).toBe(3);
        expect(harness.executor.diagnostics().crashes).toBe(2);
        harness.cleanupCrashSignal();
        await expectNoLiveResources(harness.executor);
      } finally {
        harness.releaseFirstReply();
        harness.releaseSecondReply();
        harness.cleanupCrashSignal();
        await harness.executor.dispose();
      }
    },
  );
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withPhaseDeadline<T>(promise: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The deterministic F19 phase timed out: ${phase}.`)),
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

function chatTextResponse(content: string) {
  return {
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}
