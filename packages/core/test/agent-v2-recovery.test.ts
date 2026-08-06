import { describe, expect, vi } from 'vitest';
import { z } from 'zod';

import { Deferred, ManualClock, RecordingRuntimeStateStore, acceptanceIt } from '../../../testkit';
import { Agent } from '../src/agent';
import {
  beginCompactTransactionCheckpoint,
  completeCompactTransactionCheckpoint,
  completeSummaryCompactPlan,
  createCompactTransactionCheckpoint,
  prepareSummaryCompactPlan,
  type DurableCompactTransaction,
} from '../src/agent/context-compact';
import { ContextStore } from '../src/agent/context-store';
import { AgentRunCheckpointController } from '../src/agent/run-controller';
import { createToolBatchPlan } from '../src/agent/tool-batch';
import type {
  ContextCompactOptions,
  SummaryCompactPolicy,
  ToolPayloadCompactor,
} from '../src/agent/types';
import type { ModelGenerateRequest } from '../src/llm/base';
import { OpenAIChatModel } from '../src/llm/chat';
import type { OpenAIChatContext, OpenAIChatProtocol } from '../src/llm/chat/types';
import type { ToolRuntimeContext } from '../src/subagent/agent-run';
import type {
  ExecutorAvailabilityProbe,
  SubAgentExecutorDescriptor,
} from '../src/subagent/catalog';
import { OPENAI_CHAT_CHECKPOINT_CODEC } from '../src/subagent/checkpoint';
import { defineSubAgent } from '../src/subagent/definition';
import type {
  ExecutorTaskHandle,
  SubAgentExecutionControl,
  SubAgentExecutionRequest,
  SubAgentExecutor,
  SubAgentExecutorBinding,
} from '../src/subagent/executor';
import { canonicalJsonSha256, type JsonValue } from '../src/subagent/json';
import { DEFAULT_SUBAGENT_LIMITS } from '../src/subagent/limits';
import type { SubAgentExecutionOutcome } from '../src/subagent/result';
import { createSubAgentRuntime } from '../src/subagent/runtime-implementation';
import type { SubAgentRuntime } from '../src/subagent/runtime';
import type { SubAgentCatalogEntry } from '../src/subagent/catalog';
import type { StoredPendingToolBatch } from '../src/subagent/state-store';
import {
  MockModel,
  assistant,
  endResponse,
  response,
  toolCall,
  type TestProtocol,
} from './helpers/mock-models';

describe('Agent v2 durable recovery', () => {
  acceptanceIt('RUN-07.l1.root-model-outcome-unknown', 'chat-resume-status', async () => {
    const sessionId = 'root-model-outcome-unknown';
    const runId = 'root-in-flight-run';
    const stateStore = new RecordingRuntimeStateStore();
    const runtime = createSubAgentRuntime({
      sessionId,
      activeDefinitions: [],
      executors: [],
      stateStore,
    });
    await runtime.init();
    const identityAgent = new Agent<OpenAIChatProtocol>({
      llm: createChatModel(
        'offline-outcome-unknown-identity',
        vi.fn().mockResolvedValueOnce(chatToolResponse('identity-end', 'end-agent', {})),
      ),
      subAgentRuntime: runtime,
      sessionId,
      maxIterations: 2,
    });
    identityAgent.init();
    const identityOutcome = await identityAgent.agent('capture configuration identity');
    const configurationHash = stateStore
      .snapshot(sessionId)
      .runs.find(({ runId: candidate }) => candidate === identityOutcome.runId)!.configurationHash;
    const controller = new AgentRunCheckpointController<OpenAIChatProtocol>({
      ownerSessionId: sessionId,
      stateStore,
      checkpointCodec: OPENAI_CHAT_CHECKPOINT_CODEC,
    });
    const contextStore = new ContextStore<OpenAIChatProtocol>([
      { role: 'user', content: 'durable seed' },
    ]);
    const active = await controller.beginCreate({
      runId,
      contextStore,
      limits: DEFAULT_SUBAGENT_LIMITS,
      maxIterations: 2,
      configurationHash,
    });
    await controller.prepareModelOperation(
      {
        runId,
        operationId: 'root-provider-in-flight',
        iteration: 0,
        purpose: 'agent',
        requestHash: 'a'.repeat(64),
      },
      active.lease,
    );
    await controller.markModelOperationInFlight(runId, 'root-provider-in-flight', active.lease);
    await active.lease.release();

    const provider = vi.fn();
    const agent = new Agent<OpenAIChatProtocol>({
      llm: new OpenAIChatModel({
        model: 'offline-outcome-unknown',
        client: { chat: { completions: { create: provider } } } as never,
      }),
      subAgentRuntime: runtime,
      sessionId,
      maxIterations: 2,
    });
    const failedStatus = vi.fn();
    agent.onAgentStatusChanged('failed', failedStatus);
    agent.init();

    const outcome = await agent.resumeRun({ runId });

    expect(outcome).toMatchObject({
      status: 'failed',
      sessionId,
      runId,
      error: {
        code: 'INTERNAL_ERROR',
        causeCode: 'MODEL_OUTCOME_UNKNOWN',
        outcomeUnknown: true,
      },
    });
    expect(provider).not.toHaveBeenCalled();
    expect(failedStatus).toHaveBeenCalledOnce();
    await expect(stateStore.loadRun(sessionId, runId)).resolves.toMatchObject({
      status: 'failed',
      modelOperation: { operationId: 'root-provider-in-flight', phase: 'in_flight' },
      error: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
    });
  });

  acceptanceIt('RUN-06.l1.summary-compact-crash-windows', 'prepared-result-ready', async () => {
    const preparedFixture = await createSummaryFixture('prepared-summary');
    const preparedProvider = vi
      .fn()
      .mockResolvedValueOnce(chatTextResponse('summary recovered exactly once'))
      .mockResolvedValueOnce(chatToolResponse('prepared-root-end', 'end-agent', {}));
    const preparedAgent = await createSeededAgent({
      sessionId: 'summary-prepared-session',
      runId: 'summary-prepared-run',
      stateStore: preparedFixture.stateStore,
      contextStore: preparedFixture.contextStore,
      transaction: preparedFixture.prepared,
      contextCompact: { summary: preparedFixture.policy },
      provider: preparedProvider,
    });

    const preparedOutcome = await preparedAgent.resumeRun({ runId: 'summary-prepared-run' });

    expect(preparedOutcome).toMatchObject({ status: 'succeeded' });
    expect(preparedProvider).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(preparedAgent.getContext())).toContain('summary recovered exactly once');
    expect(JSON.stringify(preparedAgent.getHistory())).not.toContain(
      'summary recovered exactly once',
    );
    await expect(
      preparedFixture.stateStore.loadRun('summary-prepared-session', 'summary-prepared-run'),
    ).resolves.not.toHaveProperty('compactTransaction');

    const readyFixture = await createSummaryFixture('result-ready-summary');
    const readyCandidate = await completeSummaryCompactPlan({
      model: readyFixture.model,
      policy: readyFixture.policy,
      plan: readyFixture.plan,
      response: {
        messages: [{ role: 'assistant', content: 'summary applied without replay' }],
      },
    });
    const ready = completeCompactTransactionCheckpoint(
      beginCompactTransactionCheckpoint(readyFixture.prepared, 2),
      {
        version: '1',
        kind: 'summary',
        summary: readyCandidate.summary,
        candidate: {
          protocol: OPENAI_CHAT_CHECKPOINT_CODEC.protocol,
          codecVersion: OPENAI_CHAT_CHECKPOINT_CODEC.version,
          value: OPENAI_CHAT_CHECKPOINT_CODEC.encode(readyCandidate.candidateActiveContext),
        },
      },
      3,
    );
    const readyProvider = vi
      .fn()
      .mockResolvedValueOnce(chatToolResponse('ready-root-end', 'end-agent', {}));
    const readyAgent = await createSeededAgent({
      sessionId: 'summary-ready-session',
      runId: 'summary-ready-run',
      stateStore: readyFixture.stateStore,
      contextStore: readyFixture.contextStore,
      transaction: ready,
      contextCompact: { summary: readyFixture.policy },
      provider: readyProvider,
    });

    const readyOutcome = await readyAgent.resumeRun({ runId: 'summary-ready-run' });

    expect(readyOutcome).toMatchObject({ status: 'succeeded' });
    expect(readyProvider).toHaveBeenCalledOnce();
    expect(JSON.stringify(readyAgent.getContext())).toContain('summary applied without replay');
    expect(JSON.stringify(readyAgent.getHistory())).not.toContain('summary applied without replay');
  });

  acceptanceIt(
    'RUN-06.l1.tool-payload-compact-crash-windows',
    'prepared-result-ready-in-flight',
    async () => {
      const preparedFixture = createToolCompactFixture('tool-prepared');
      const preparedCompactor = vi.fn<ToolPayloadCompactor>(() => '[tool-input-compacted]');
      const preparedProvider = vi
        .fn()
        .mockResolvedValueOnce(chatToolResponse('tool-prepared-end', 'end-agent', {}));
      const preparedAgent = await createSeededAgent({
        sessionId: 'tool-prepared-session',
        runId: 'tool-prepared-run',
        stateStore: preparedFixture.stateStore,
        contextStore: preparedFixture.contextStore,
        transaction: preparedFixture.prepared,
        pendingBatch: preparedFixture.pendingBatch,
        contextCompact: { toolInput: preparedCompactor, toolResult: false },
        provider: preparedProvider,
        installEchoTool: true,
      });
      const preparedOutcome = await preparedAgent.resumeRun({ runId: 'tool-prepared-run' });
      expect(preparedOutcome).toMatchObject({ status: 'succeeded' });
      expect(preparedCompactor).toHaveBeenCalledTimes(2);
      expect(preparedCompactor.mock.calls.map(([, info]) => info.call.name)).toEqual([
        'echo',
        'end-agent',
      ]);
      expect(preparedProvider).toHaveBeenCalledOnce();
      expect(findChatToolArguments(preparedAgent.getContext(), 'tool-prepared-call')).toBe(
        '[tool-input-compacted]',
      );
      expect(findChatToolArguments(preparedAgent.getHistory(), 'tool-prepared-call')).toBe(
        preparedFixture.argumentsText,
      );

      const readyFixture = createToolCompactFixture('tool-ready');
      const ready = createToolCompactResultReady(readyFixture, '[ready-input-compacted]');
      const readyCompactor = vi.fn<ToolPayloadCompactor>((_value, info) => {
        if (info.call.name === 'echo') {
          throw new Error('result-ready compact must not be replayed');
        }
        return undefined;
      });
      const readyProvider = vi
        .fn()
        .mockResolvedValueOnce(chatToolResponse('tool-ready-end', 'end-agent', {}));
      const readyAgent = await createSeededAgent({
        sessionId: 'tool-ready-session',
        runId: 'tool-ready-run',
        stateStore: readyFixture.stateStore,
        contextStore: readyFixture.contextStore,
        transaction: ready,
        pendingBatch: readyFixture.pendingBatch,
        contextCompact: { toolInput: readyCompactor, toolResult: false },
        provider: readyProvider,
        installEchoTool: true,
      });

      const readyOutcome = await readyAgent.resumeRun({ runId: 'tool-ready-run' });

      expect(readyOutcome).toMatchObject({ status: 'succeeded' });
      expect(readyCompactor.mock.calls.map(([, info]) => info.call.name)).toEqual(['end-agent']);
      expect(readyProvider).toHaveBeenCalledOnce();
      expect(findChatToolArguments(readyAgent.getContext(), 'tool-ready-call')).toBe(
        '[ready-input-compacted]',
      );
      expect(findChatToolArguments(readyAgent.getHistory(), 'tool-ready-call')).toBe(
        readyFixture.argumentsText,
      );

      const inFlightFixture = createToolCompactFixture('tool-in-flight');
      const inFlight = beginCompactTransactionCheckpoint(inFlightFixture.prepared, 2);
      const inFlightProvider = vi.fn();
      const inFlightCompactor = vi.fn<ToolPayloadCompactor>(() => '[must-not-run]');
      const inFlightAgent = await createSeededAgent({
        sessionId: 'tool-in-flight-session',
        runId: 'tool-in-flight-run',
        stateStore: inFlightFixture.stateStore,
        contextStore: inFlightFixture.contextStore,
        transaction: inFlight,
        pendingBatch: inFlightFixture.pendingBatch,
        contextCompact: { toolInput: inFlightCompactor, toolResult: false },
        provider: inFlightProvider,
        installEchoTool: true,
      });

      const failed = await inFlightAgent.resumeRun({ runId: 'tool-in-flight-run' });

      expect(failed).toMatchObject({
        status: 'failed',
        error: {
          code: 'INTERNAL_ERROR',
          causeCode: 'COMPACT_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        },
      });
      expect(inFlightProvider).not.toHaveBeenCalled();
      expect(inFlightCompactor).not.toHaveBeenCalled();
      expect(findChatToolArguments(inFlightAgent.getContext(), 'tool-in-flight-call')).toBe(
        inFlightFixture.argumentsText,
      );
      expect(findChatToolArguments(inFlightAgent.getHistory(), 'tool-in-flight-call')).toBe(
        inFlightFixture.argumentsText,
      );
    },
  );

  acceptanceIt(
    'RUN-07.l1.root-provider-abort-outcome-unknown',
    'abort-after-provider-dispatch',
    async () => {
      const sessionId = 'provider-abort-session';
      const stateStore = new RecordingRuntimeStateStore();
      const runtime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [],
        executors: [],
        stateStore,
      });
      await runtime.init();
      const cancelDescendants = vi.spyOn(runtime, 'cancelRunDescendants');
      const entered = new Deferred<void>();
      const provider = vi.fn(async () => {
        entered.resolve(undefined);
        return await new Promise<never>(() => undefined);
      });
      const agent = new Agent<OpenAIChatProtocol>({
        llm: createChatModel('offline-provider-abort', provider),
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 2,
      });
      agent.init();
      const abort = new AbortController();
      const pending = agent.agent('dispatch exactly once', { signal: abort.signal });
      await entered.promise;
      abort.abort(new Error('caller stopped after dispatch'));

      const outcome = await pending;
      expect(outcome).toMatchObject({
        status: 'failed',
        error: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
      });
      expect(provider).toHaveBeenCalledOnce();
      expect(cancelDescendants).not.toHaveBeenCalled();
      const stored = await stateStore.loadRun(sessionId, outcome.runId);
      expect(stored).toMatchObject({
        status: 'failed',
        pendingApprovals: [],
        error: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
        modelOperation: { phase: 'in_flight' },
      });
      expect(stored).not.toHaveProperty('pendingBatch');
      expect(stored).not.toHaveProperty('compactTransaction');
      const terminalRevision = stored!.revision;

      const replay = await agent.resumeRun({ runId: outcome.runId });
      expect(replay).toMatchObject({
        status: 'failed',
        error: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
      });
      expect(provider).toHaveBeenCalledOnce();
      expect(cancelDescendants).not.toHaveBeenCalled();
      expect((await stateStore.loadRun(sessionId, outcome.runId))?.revision).toBe(terminalRevision);
    },
  );

  acceptanceIt(
    'RUN-07.l1.root-caller-cancel-outcome',
    'atomic-root-task-before-adapter-cleanup',
    async () => {
      const sessionId = 'root-caller-cancel-session';
      const executorName = 'root-cancel-background';
      const stateStore = new RecordingRuntimeStateStore();
      const definition = defineSubAgent({
        name: 'root-cancel-child',
        version: '2',
        description: 'Holds a background descendant open until the root caller cancels.',
        inputSchema: z.object({ prompt: z.string() }).strict(),
        outputSchema: z.object({ proof: z.string() }).strict(),
        executorPolicy: { requiredCapabilities: { resumeRecovery: 'same_process' } },
      });
      const rawWait = new Deferred<SubAgentExecutionOutcome>();
      const rawHandleCancel = vi.fn(async () => undefined);
      let adapterObservedAtomicTerminal = false;
      const adapterCancel = vi.fn(async () => {
        const snapshot = stateStore.snapshot(sessionId);
        adapterObservedAtomicTerminal =
          snapshot.runs.length === 1 &&
          snapshot.runs[0]?.status === 'cancelled' &&
          snapshot.tasks.length === 1 &&
          snapshot.tasks[0]?.state === 'cancelled' &&
          snapshot.tasks[0]?.controlOperations.at(-1)?.kind === 'cancel';
      });
      const baseExecutor = sameProcessExecutor(executorName, async () => {
        throw new Error('The root cancellation fixture only uses spawn().');
      });
      const executor: SubAgentExecutor = {
        ...baseExecutor,
        async spawn(request): Promise<ExecutorTaskHandle> {
          const binding = sameProcessBinding(request, executorName);
          return {
            taskId: request.taskId,
            binding,
            snapshot: async () => ({
              taskId: request.taskId,
              state: 'running',
              binding,
              updatedAt: Date.now(),
            }),
            wait: () => rawWait.promise,
            cancel: rawHandleCancel,
            async *events() {},
          };
        },
        cancel: adapterCancel,
      };
      const runtime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [definition],
        executors: [executor],
        stateStore,
      });
      await runtime.init();
      const model = new MockModel([
        response(assistant('', [toolCall('root-slow-tool-call', 'root-slow-tool')])),
      ]);
      const toolEntered = new Deferred<ToolRuntimeContext<TestProtocol>>();
      const agent = new Agent<TestProtocol>({
        llm: model,
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 2,
      });
      agent.tools.push({
        name: 'root-slow-tool',
        description: 'Wait until the root caller aborts.',
        handler(_parameters, toolRuntime: ToolRuntimeContext<TestProtocol>) {
          toolEntered.resolve(toolRuntime);
          return new Promise<never>((_resolve, reject) => {
            const rejectWithAbort = () => reject(toolRuntime.signal.reason);
            if (toolRuntime.signal.aborted) rejectWithAbort();
            else toolRuntime.signal.addEventListener('abort', rejectWithAbort, { once: true });
          });
        },
      });
      agent.init();
      const caller = new AbortController();
      const pending = agent.agent('hold a root Tool while one descendant runs', {
        signal: caller.signal,
      });
      const toolRuntime = await toolEntered.promise;
      if (toolRuntime.runId === undefined) throw new Error('Expected a durable root run ID.');
      const child = await runtime.spawn({
        runId: toolRuntime.runId,
        requestId: 'root-cancel-background-request',
        subAgent: definition.name,
        executor: executorName,
        input: { prompt: 'remain active until root cancellation' },
      });
      await vi.waitFor(() =>
        expect(stateStore.snapshot(sessionId).tasks).toMatchObject([
          { taskId: child.taskId, state: 'running', binding: { executorName } },
        ]),
      );

      caller.abort(new Error('caller cancelled while a normal Tool was running'));
      const outcome = await pending;

      expect(outcome).toMatchObject({
        status: 'cancelled',
        sessionId,
        runId: toolRuntime.runId,
        error: { code: 'CANCELLED' },
      });
      expect(adapterCancel).toHaveBeenCalledOnce();
      expect(adapterObservedAtomicTerminal).toBe(true);
      expect(rawHandleCancel).not.toHaveBeenCalled();
      expect(stateStore.snapshot(sessionId)).toMatchObject({
        runs: [
          {
            status: 'cancelled',
            budget: { descendantsCreated: 1, activeExecutions: 0, providerCalls: 1 },
            error: { code: 'CANCELLED' },
          },
        ],
        tasks: [
          {
            state: 'cancelled',
            error: { code: 'CANCELLED' },
          },
        ],
      });
      expect(stateStore.snapshot(sessionId).tasks[0]?.controlOperations.at(-1)).toMatchObject({
        operationId: expect.stringMatching(/^cancel-run-.+:task-/u),
        kind: 'cancel',
      });
      await expect(child.wait()).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'cancelled' },
      });
    },
  );

  acceptanceIt(
    'REC-01.l1.root-agent-lease-takeover',
    'stale-agent-cannot-cancel-or-terminalize',
    async () => {
      vi.useFakeTimers();
      try {
        const clock = new ManualClock(100);
        const sessionId = 'agent-lease-takeover-session';
        const stateStore = new RecordingRuntimeStateStore({ now: clock.now });
        const runtime = createSubAgentRuntime({
          sessionId,
          activeDefinitions: [],
          executors: [],
          stateStore,
        });
        await runtime.init();
        const cancelDescendants = vi.spyOn(runtime, 'cancelRunDescendants');
        const providerEntered = new Deferred<void>();
        const staleProvider = vi.fn(async () => {
          providerEntered.resolve(undefined);
          return await new Promise<never>(() => undefined);
        });
        const staleAgent = new Agent<OpenAIChatProtocol>({
          llm: createChatModel('lease-takeover-stale-owner', staleProvider),
          subAgentRuntime: runtime,
          sessionId,
          maxIterations: 2,
        });
        staleAgent.init();

        const staleRun = staleAgent.agent('hold one provider operation open');
        await providerEntered.promise;
        const inFlight = stateStore.snapshot(sessionId).runs[0]!;
        expect(inFlight).toMatchObject({
          status: 'running',
          modelOperation: { phase: 'in_flight' },
          budget: { providerCalls: 1 },
        });
        const revisionBeforeTakeover = inFlight.revision;

        clock.advanceBy(30_001);
        const takeover = await stateStore.acquireLease(
          `agent-run:${JSON.stringify([sessionId, inFlight.runId])}`,
          30_000,
        );
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(staleRun).resolves.toMatchObject({
          status: 'failed',
          error: {
            code: 'RECOVERY_TARGET_LOST',
            causeCode: 'ROOT_EXECUTION_LEASE_LOST',
          },
        });
        expect(staleProvider).toHaveBeenCalledOnce();
        expect(cancelDescendants).not.toHaveBeenCalled();
        await expect(stateStore.loadRun(sessionId, inFlight.runId)).resolves.toMatchObject({
          status: 'running',
          revision: revisionBeforeTakeover,
          modelOperation: { phase: 'in_flight' },
        });

        await takeover.release();
        const replacementProvider = vi.fn();
        const replacement = new Agent<OpenAIChatProtocol>({
          llm: createChatModel('lease-takeover-replacement-owner', replacementProvider),
          subAgentRuntime: runtime,
          sessionId,
          maxIterations: 2,
        });
        replacement.init();
        const recovered = await replacement.resumeRun({ runId: inFlight.runId });
        expect(recovered).toMatchObject({
          status: 'failed',
          error: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
        });
        expect(replacementProvider).not.toHaveBeenCalled();
        expect(cancelDescendants).not.toHaveBeenCalled();
        const recoveredRecord = (await stateStore.loadRun(sessionId, inFlight.runId))!;
        expect(recoveredRecord).toMatchObject({
          status: 'failed',
          revision: revisionBeforeTakeover + 1,
          modelOperation: { phase: 'in_flight' },
          error: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
        });

        await expect(replacement.resumeRun({ runId: inFlight.runId })).resolves.toMatchObject({
          status: 'failed',
          error: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
        });
        expect(replacementProvider).not.toHaveBeenCalled();
        expect((await stateStore.loadRun(sessionId, inFlight.runId))?.revision).toBe(
          recoveredRecord.revision,
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  acceptanceIt(
    'ARK-12A.l1.shared-provider-budget',
    'root-child-exact-limit-and-idempotent-ledger',
    async () => {
      const sessionId = 'shared-provider-budget-session';
      const executorName = 'shared-budget-same-process';
      const definition = defineSubAgent({
        name: 'shared-budget-child',
        version: '2',
        description: 'Consumes child provider budget from the root run ledger.',
        inputSchema: z.object({ prompt: z.string() }).strict(),
        outputSchema: z.object({ proof: z.string() }).strict(),
        executorPolicy: { requiredCapabilities: { resumeRecovery: 'same_process' } },
      });
      let childProviderCalls = 0;
      let blockedChildAttempt: unknown;
      const execute = vi.fn(
        async (
          _request: SubAgentExecutionRequest,
          control: SubAgentExecutionControl,
        ): Promise<SubAgentExecutionOutcome> => {
          await control.consumeBudget('child-provider-attempt-1', {
            turns: 1,
            providerCalls: 1,
          });
          // The same operation ID is an idempotent receipt replay, not another reservation.
          await control.consumeBudget('child-provider-attempt-1', {
            turns: 1,
            providerCalls: 1,
          });
          childProviderCalls += 1;
          try {
            await control.consumeBudget('child-provider-attempt-2', {
              turns: 1,
              providerCalls: 1,
            });
          } catch (error) {
            blockedChildAttempt = error;
            throw error;
          }
          throw new Error('The child provider budget limit was not enforced.');
        },
      );
      const stateStore = new RecordingRuntimeStateStore();
      const runtime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [definition],
        executors: [sameProcessExecutor(executorName, execute)],
        stateStore,
        limits: { maxProviderCalls: 2 },
      });
      await runtime.init();
      const rootProvider = vi.fn().mockResolvedValueOnce(
        chatToolResponse('shared-budget-agent-call', 'agent', {
          subAgent: definition.name,
          executor: executorName,
          input: { prompt: 'consume the shared budget' },
        }),
      );
      const agent = new Agent<OpenAIChatProtocol>({
        llm: createChatModel('offline-shared-provider-budget', rootProvider),
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 3,
      });
      agent.init();

      const outcome = await agent.agent('prove the root and child share provider calls');
      expect(outcome).toMatchObject({
        status: 'failed',
        error: { code: 'BUDGET_EXCEEDED' },
      });
      expect(rootProvider).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(childProviderCalls).toBe(1);
      expect(blockedChildAttempt).toMatchObject({ code: 'BUDGET_EXCEEDED' });

      const stored = stateStore.snapshot(sessionId);
      expect(stored.runs).toMatchObject([
        {
          runId: outcome.runId,
          status: 'failed',
          budget: { providerCalls: 2, descendantsCreated: 1, activeExecutions: 0 },
          error: { code: 'BUDGET_EXCEEDED' },
        },
      ]);
      expect(stored.tasks).toMatchObject([
        {
          state: 'budget_exceeded',
          usage: { turns: 1, providerCalls: 1 },
          error: { code: 'BUDGET_EXCEEDED' },
        },
      ]);
      const terminalRevision = stored.runs[0]!.revision;
      await expect(agent.resumeRun({ runId: outcome.runId })).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      expect(rootProvider).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect((await stateStore.loadRun(sessionId, outcome.runId))?.revision).toBe(terminalRevision);
    },
  );

  acceptanceIt(
    'RUN-05.l1.root-configuration-identity',
    'same-config-provider-excluded-and-drift-rejected',
    async () => {
      const sessionId = 'configuration-identity-session';
      const stateStore = new RecordingRuntimeStateStore();
      const runtime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [],
        executors: [],
        stateStore,
      });
      await runtime.init();
      const identityAgent = new Agent<OpenAIChatProtocol>({
        llm: createChatModel(
          'offline-configuration-identity',
          vi.fn().mockResolvedValueOnce(chatToolResponse('identity-end', 'end-agent', {})),
        ),
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 2,
      });
      identityAgent.init();
      const identityOutcome = await identityAgent.agent('capture identity');
      const configurationHash = (await stateStore.loadRun(sessionId, identityOutcome.runId))!
        .configurationHash;
      const controller = new AgentRunCheckpointController<OpenAIChatProtocol>({
        ownerSessionId: sessionId,
        stateStore,
        checkpointCodec: OPENAI_CHAT_CHECKPOINT_CODEC,
      });
      const seedRun = async (runId: string): Promise<number> => {
        const seeded = await controller.beginCreate({
          runId,
          contextStore: new ContextStore<OpenAIChatProtocol>([
            { role: 'user', content: `configuration target ${runId}` },
          ]),
          limits: DEFAULT_SUBAGENT_LIMITS,
          maxIterations: 2,
          configurationHash,
        });
        await seeded.lease.release();
        return seeded.checkpoint.record.revision;
      };
      const stageTool = vi.spyOn(runtime, 'stageTool');

      const compatibleRunId = 'configuration-compatible-run';
      await seedRun(compatibleRunId);
      const compatibleProvider = vi
        .fn()
        .mockResolvedValueOnce(chatToolResponse('compatible-end', 'end-agent', {}));
      const compatible = new Agent<OpenAIChatProtocol>({
        // Model deployment/client identity is intentionally outside replay configuration.
        llm: createChatModel('different-provider-deployment-name', compatibleProvider),
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 2,
      });
      compatible.init();
      await expect(compatible.resumeRun({ runId: compatibleRunId })).resolves.toMatchObject({
        status: 'succeeded',
      });
      expect(compatibleProvider).toHaveBeenCalledOnce();

      const maxRunId = 'configuration-max-iterations-drift';
      const maxRevision = await seedRun(maxRunId);
      const maxProvider = vi.fn();
      const maxDrift = new Agent<OpenAIChatProtocol>({
        llm: createChatModel('max-drift-provider', maxProvider),
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 3,
      });
      maxDrift.init();
      await expect(maxDrift.resumeRun({ runId: maxRunId })).rejects.toMatchObject({
        code: 'CHECKPOINT_VERSION_MISMATCH',
      });
      await expect(maxDrift.resumeRun({ runId: maxRunId })).rejects.toMatchObject({
        code: 'CHECKPOINT_VERSION_MISMATCH',
      });
      expect(maxProvider).not.toHaveBeenCalled();
      expect((await stateStore.loadRun(sessionId, maxRunId))?.revision).toBe(maxRevision);

      const limitsRunId = 'configuration-runtime-limits-drift';
      const limitsRevision = await seedRun(limitsRunId);
      const limitsRuntime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [],
        executors: [],
        stateStore,
        limits: { maxProviderCalls: 1 },
      });
      await limitsRuntime.init();
      const limitsStageTool = vi.spyOn(limitsRuntime, 'stageTool');
      const limitsProvider = vi.fn();
      const limitsDrift = new Agent<OpenAIChatProtocol>({
        llm: createChatModel('limits-drift-provider', limitsProvider),
        subAgentRuntime: limitsRuntime,
        sessionId,
        maxIterations: 2,
      });
      limitsDrift.init();
      await expect(limitsDrift.resumeRun({ runId: limitsRunId })).rejects.toMatchObject({
        code: 'CHECKPOINT_VERSION_MISMATCH',
      });
      expect(limitsProvider).not.toHaveBeenCalled();
      expect(limitsStageTool).not.toHaveBeenCalled();
      expect((await stateStore.loadRun(sessionId, limitsRunId))?.revision).toBe(limitsRevision);

      const toolRunId = 'configuration-tool-drift';
      const toolRevision = await seedRun(toolRunId);
      const toolProvider = vi.fn();
      const toolDrift = new Agent<OpenAIChatProtocol>({
        llm: createChatModel('tool-drift-provider', toolProvider),
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 2,
      });
      toolDrift.tools.push({
        name: 'configuration-only-tool',
        description: 'Changes the durable Tool surface.',
        parameters: z.object({ proof: z.string() }),
        handler: () => 'must not execute',
      });
      toolDrift.init();
      await expect(toolDrift.resumeRun({ runId: toolRunId })).rejects.toMatchObject({
        code: 'CHECKPOINT_VERSION_MISMATCH',
      });
      expect(toolProvider).not.toHaveBeenCalled();
      expect((await stateStore.loadRun(sessionId, toolRunId))?.revision).toBe(toolRevision);

      const skillRunId = 'configuration-skill-drift';
      const skillRevision = await seedRun(skillRunId);
      const skillProvider = vi.fn();
      const skillDrift = new Agent<OpenAIChatProtocol>({
        llm: createChatModel('skill-drift-provider', skillProvider),
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 2,
        skills: [
          {
            name: 'configuration-only-skill',
            description: 'Changes the durable Skill catalog.',
            instructions: 'Never reached during a mismatched resume.',
          },
        ],
      });
      skillDrift.init();
      await expect(skillDrift.resumeRun({ runId: skillRunId })).rejects.toMatchObject({
        code: 'CHECKPOINT_VERSION_MISMATCH',
      });
      expect(skillProvider).not.toHaveBeenCalled();
      expect((await stateStore.loadRun(sessionId, skillRunId))?.revision).toBe(skillRevision);

      const targetRunId = 'configuration-post-init-drift';
      const initialRevision = await seedRun(targetRunId);
      const provider = vi.fn();
      const target = new Agent<OpenAIChatProtocol>({
        llm: createChatModel('post-init-drift-provider', provider),
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 2,
      });
      target.init();
      target.addSystemPrompts('configuration drift after init');

      await expect(target.resumeRun({ runId: targetRunId })).rejects.toMatchObject({
        code: 'CHECKPOINT_VERSION_MISMATCH',
      });
      target.init();
      await expect(target.resumeRun({ runId: targetRunId })).rejects.toMatchObject({
        code: 'CHECKPOINT_VERSION_MISMATCH',
      });
      expect(provider).not.toHaveBeenCalled();
      expect((await stateStore.loadRun(sessionId, targetRunId))?.revision).toBe(initialRevision);
      expect(stageTool).not.toHaveBeenCalled();
    },
  );

  acceptanceIt('API-02.l1.dynamic-wire-refresh', 'catalog-revision-request-snapshot', async () => {
    const sessionId = 'dynamic-wire-session';
    const stateStore = new RecordingRuntimeStateStore();
    let revision = 1;
    let entries: readonly SubAgentCatalogEntry[] = [];
    const runtime = {
      sessionId,
      stateStore,
      limits: DEFAULT_SUBAGENT_LIMITS,
      ready: true,
      init: async () => undefined,
      refreshCatalog: async () => ({ revision, capturedAt: Date.now(), executors: [] }),
      getCatalog: () => ({ revision, capturedAt: Date.now(), executors: [] }),
      getCatalogEntries: () => entries,
    } as unknown as SubAgentRuntime;
    const parsedAgainstRequestSnapshot = vi.fn((_parameters: unknown) => {
      void _parameters;
      throw new Error('stop after request-snapshot parse');
    });
    const model = new MockModel([
      (request) => {
        expect(modelHasAgentTool(request.tools)).toBe(false);
        revision = 2;
        entries = [sameProcessCatalogEntry('research-two')];
        return response(assistant('catalog becomes non-empty for the next request'));
      },
      (request) => {
        expect(modelVisibleAgentDescription(request.tools)).toContain('research-two');
        revision = 3;
        entries = [];
        return response(
          assistant('', [
            toolCall(
              'snapshot-agent-call',
              'agent',
              JSON.stringify({
                subAgent: 'research-two',
                executor: 'memory',
                input: { query: 'validated by revision two' },
              }),
            ),
          ]),
        );
      },
      (request) => {
        expect(modelHasAgentTool(request.tools)).toBe(false);
        return endResponse('dynamic-wire-end');
      },
    ]);
    const agent = new Agent({
      llm: model,
      subAgentRuntime: runtime,
      sessionId,
      maxIterations: 3,
    });
    agent.onBeforeToolCall('agent', parsedAgainstRequestSnapshot, {
      await: true,
      errorCancel: true,
    });
    agent.init();

    const outcome = await agent.agent('observe catalog refresh');
    expect(outcome).toMatchObject({ status: 'succeeded' });
    expect(model.requests).toHaveLength(3);
    expect(parsedAgainstRequestSnapshot).toHaveBeenCalledOnce();
    expect(parsedAgainstRequestSnapshot.mock.calls[0]?.[0]).toEqual({
      subAgent: 'research-two',
      executor: 'memory',
      input: { query: 'validated by revision two' },
    });
    const stored = await stateStore.loadRun(sessionId, outcome.runId);
    expect(stored).toMatchObject({ status: 'succeeded' });
    const terminalRevision = stored!.revision;
    await expect(agent.resumeRun({ runId: outcome.runId })).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
    expect(model.requests).toHaveLength(3);
    expect((await stateStore.loadRun(sessionId, outcome.runId))?.revision).toBe(terminalRevision);

    const boundarySessionId = 'dynamic-wire-no-codec-request-boundary';
    const boundaryStore = new RecordingRuntimeStateStore();
    const boundaryStage = vi.fn();
    let boundaryRevision = 1;
    let boundaryEntries: readonly SubAgentCatalogEntry[] = [
      sameProcessCatalogEntry('boundary-research'),
    ];
    const boundaryRuntime = mutableCatalogRuntime({
      sessionId: boundarySessionId,
      stateStore: boundaryStore,
      getRevision: () => boundaryRevision,
      getEntries: () => boundaryEntries,
      stageTool: boundaryStage,
    });
    const boundaryModel = new MockModel([
      (request) => {
        expect(modelVisibleAgentDescription(request.tools)).toContain('boundary-research');
        boundaryRevision = 2;
        boundaryEntries = [
          catalogEntryWithRecovery('boundary-research', {
            resume: 'checkpoint',
            reconnect: 'none',
          }),
        ];
        return response(assistant('The catalog changed before the next request boundary.'));
      },
    ]);
    const boundaryAgent = new Agent({
      llm: boundaryModel,
      subAgentRuntime: boundaryRuntime,
      sessionId: boundarySessionId,
      maxIterations: 2,
    });
    boundaryAgent.init();

    const boundaryOutcome = await boundaryAgent.agent('reject a later durable placement');
    expect(boundaryOutcome).toMatchObject({
      status: 'failed',
      error: { code: 'RECOVERY_UNSUPPORTED', retryable: false },
    });
    expect(boundaryModel.requests).toHaveLength(1);
    expect(boundaryStage).not.toHaveBeenCalled();
    expect(boundaryStore.snapshot(boundarySessionId).tasks).toEqual([]);

    const pendingSessionId = 'dynamic-wire-no-codec-pending-snapshot';
    const pendingStore = new RecordingRuntimeStateStore();
    const pendingStage = vi.fn();
    const parsedPendingSnapshot = vi.fn();
    let pendingRevision = 1;
    let pendingEntries: readonly SubAgentCatalogEntry[] = [
      sameProcessCatalogEntry('pending-research'),
    ];
    const pendingRuntime = mutableCatalogRuntime({
      sessionId: pendingSessionId,
      stateStore: pendingStore,
      getRevision: () => pendingRevision,
      getEntries: () => pendingEntries,
      stageTool: pendingStage,
    });
    const pendingModel = new MockModel([
      (request) => {
        expect(modelVisibleAgentDescription(request.tools)).toContain('pending-research');
        pendingRevision = 2;
        pendingEntries = [
          catalogEntryWithRecovery('pending-research', {
            resume: 'checkpoint',
            reconnect: 'external_binding',
          }),
        ];
        return response(
          assistant('', [
            toolCall(
              'pending-snapshot-agent-call',
              'agent',
              JSON.stringify({
                subAgent: 'pending-research',
                executor: 'memory',
                input: { query: 'parse against revision one but do not stage' },
              }),
            ),
          ]),
        );
      },
    ]);
    const pendingAgent = new Agent({
      llm: pendingModel,
      subAgentRuntime: pendingRuntime,
      sessionId: pendingSessionId,
      maxIterations: 2,
    });
    pendingAgent.onBeforeToolCall('agent', parsedPendingSnapshot, { await: true });
    pendingAgent.init();

    const pendingOutcome = await pendingAgent.agent('preserve the provider request snapshot');
    expect(pendingOutcome).toMatchObject({
      status: 'failed',
      error: { code: 'RECOVERY_UNSUPPORTED', retryable: false },
    });
    expect(pendingModel.requests).toHaveLength(1);
    expect(parsedPendingSnapshot).toHaveBeenCalledOnce();
    expect(parsedPendingSnapshot.mock.calls[0]?.[0]).toEqual({
      subAgent: 'pending-research',
      executor: 'memory',
      input: { query: 'parse against revision one but do not stage' },
    });
    expect(pendingStage).not.toHaveBeenCalled();
    expect(pendingStore.snapshot(pendingSessionId).tasks).toEqual([]);
  });

  acceptanceIt(
    'PRO-05.l1.no-codec-durable-rejected',
    'custom-no-codec-checkpoint-external-rejected',
    async () => {
      const placements = [
        {
          id: 'checkpoint',
          recovery: { resume: 'checkpoint', reconnect: 'none' },
        },
        {
          id: 'external',
          recovery: { resume: 'checkpoint', reconnect: 'external_binding' },
        },
      ] as const;

      for (const placement of placements) {
        const sessionId = `no-codec-${placement.id}-init-rejected`;
        const stateStore = new RecordingRuntimeStateStore();
        const stageTool = vi.fn();
        const runtime = mutableCatalogRuntime({
          sessionId,
          stateStore,
          getRevision: () => 1,
          getEntries: () => [catalogEntryWithRecovery('durable-research', placement.recovery)],
          stageTool,
        });
        const model = new MockModel();
        const agent = new Agent({ llm: model, subAgentRuntime: runtime, sessionId });
        let initError: unknown;

        try {
          agent.init();
        } catch (error) {
          initError = error;
        }

        expect(initError).toMatchObject({
          code: 'RECOVERY_UNSUPPORTED',
          retryable: false,
        });
        expect(model.requests).toHaveLength(0);
        expect(stageTool).not.toHaveBeenCalled();
        expect(stateStore.snapshot(sessionId)).toMatchObject({ runs: [], tasks: [] });
      }
    },
  );

  acceptanceIt(
    'API-02.l1.no-codec-same-process-root',
    'memory-root-approval-resume-and-instance-boundary',
    async () => {
      const sessionId = 'no-codec-same-process-root';
      const executorName = 'same-process-only';
      const definition = defineSubAgent({
        name: 'same-process-proof',
        version: '2',
        description: 'Prove that a custom protocol can resume only in its originating process.',
        inputSchema: z.object({ prompt: z.string() }).strict(),
        outputSchema: z.object({ answer: z.string() }).strict(),
        executorPolicy: { requiredCapabilities: { resumeRecovery: 'same_process' } },
      });
      const stateStore = new RecordingRuntimeStateStore();
      const operations: string[] = [];
      const execute = vi.fn(
        async (
          request: SubAgentExecutionRequest,
          control: SubAgentExecutionControl,
        ): Promise<SubAgentExecutionOutcome> => {
          operations.push(
            request.operation.type === 'resume'
              ? `${request.operation.type}:${request.operation.reason}`
              : request.operation.type,
          );
          if (request.operation.type === 'create') {
            await control.commitBinding(
              'same-process-binding',
              sameProcessBinding(request, executorName),
            );
            const directive = await control.authorizeTool(
              'same-process-approval',
              {
                callId: 'same-process-sensitive-call',
                toolName: 'same-process-sensitive-tool',
                summary: 'Approve the same-process continuation.',
              },
              sameProcessApprovalCheckpoint(),
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
          if (request.operation.type !== 'resume' || request.operation.reason !== 'approval') {
            throw new Error('expected same-process approval resume');
          }
          const directive = await control.authorizeTool(
            'same-process-approval-resume',
            {
              callId: 'same-process-sensitive-call',
              toolName: 'same-process-sensitive-tool',
              summary: 'Approve the same-process continuation.',
            },
            request.operation.checkpoint,
          );
          if (directive.type !== 'approved') throw new Error('expected committed approval');
          const output = { answer: 'same-process-approved-proof' };
          await control.completion.submitResult('same-process-result', output);
          await control.completion.complete('same-process-end', { isStandalone: true });
          return {
            type: 'terminal',
            result: {
              status: 'succeeded',
              task: { taskId: request.taskId, subAgent: request.definition },
              executor: executorName,
              output,
            },
          };
        },
      );
      const executor = sameProcessExecutor(executorName, execute);
      const runtime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [definition],
        executors: [executor],
        stateStore,
      });
      await runtime.init();
      const model = new MockModel([
        response(
          assistant('', [
            toolCall(
              'same-process-agent-call',
              'agent',
              JSON.stringify({
                subAgent: definition.name,
                executor: executorName,
                input: { prompt: 'prove same-process resume' },
              }),
            ),
          ]),
        ),
        (request) => {
          expect(JSON.stringify(request.context)).toContain('same-process-approved-proof');
          return endResponse('same-process-root-end');
        },
      ]);
      const agent = new Agent({
        llm: model,
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 3,
      });
      agent.init();

      const waiting = await agent.agent('delegate with a custom protocol and no codec');
      expect(waiting).toMatchObject({ status: 'waiting_approval', sessionId });
      if (waiting.status !== 'waiting_approval') throw new Error('expected root approval pause');
      expect(waiting.approvals).toHaveLength(1);
      expect(model.requests).toHaveLength(1);
      expect(operations).toEqual(['create']);
      const approval = waiting.approvals[0]!;
      const pausedRecord = (await stateStore.loadRun(sessionId, waiting.runId))!;
      const pausedRevision = pausedRecord.revision;
      expect(pausedRecord).toMatchObject({
        status: 'waiting_approval',
        budget: { providerCalls: 1, descendantsCreated: 1, activeExecutions: 0 },
      });

      const replacementModel = new MockModel();
      const replacement = new Agent({
        llm: replacementModel,
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 3,
      });
      replacement.init();
      await expect(
        replacement.resumeRun({
          runId: waiting.runId,
          decisions: [
            {
              approvalId: approval.approvalId,
              decision: 'approved',
              expectedRevision: approval.revision,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'RECOVERY_UNSUPPORTED' });
      expect(replacementModel.requests).toHaveLength(0);
      expect(operations).toEqual(['create']);
      expect((await stateStore.loadRun(sessionId, waiting.runId))!.revision).toBe(pausedRevision);

      const completed = await agent.resumeRun({
        runId: waiting.runId,
        decisions: [
          {
            approvalId: approval.approvalId,
            decision: 'approved',
            expectedRevision: approval.revision,
          },
        ],
      });
      expect(completed).toMatchObject({ status: 'succeeded', sessionId, runId: waiting.runId });
      expect(model.requests).toHaveLength(2);
      expect(operations).toEqual(['create', 'resume:approval']);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(await stateStore.loadRun(sessionId, waiting.runId)).toMatchObject({
        status: 'succeeded',
        budget: { providerCalls: 2, descendantsCreated: 1, activeExecutions: 0 },
      });
      expect(stateStore.snapshot(sessionId).tasks).toMatchObject([
        { state: 'succeeded', attempt: 2, approvals: [] },
      ]);
      const terminalRevision = (await stateStore.loadRun(sessionId, waiting.runId))!.revision;
      await expect(agent.resumeRun({ runId: waiting.runId })).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      expect(model.requests).toHaveLength(2);
      expect(execute).toHaveBeenCalledTimes(2);
      expect((await stateStore.loadRun(sessionId, waiting.runId))?.revision).toBe(terminalRevision);
    },
  );

  acceptanceIt(
    'REC-01.l1.root-settlement-lease-takeover',
    'mid-settlement-takeover-no-drift',
    async () => {
      const clock = new ManualClock(100);
      const sessionId = 'agent-settlement-takeover-session';
      const executorName = 'settlement-takeover-background';
      const stateStore = new RecordingRuntimeStateStore({ now: clock.now });
      const definition = defineSubAgent({
        name: 'settlement-takeover-child',
        version: '2',
        description: 'Remain active while the root settlement lease is taken over.',
        inputSchema: z.object({ prompt: z.string() }).strict(),
        outputSchema: z.object({ proof: z.string() }).strict(),
        executorPolicy: { requiredCapabilities: { resumeRecovery: 'same_process' } },
      });
      const rawWait = new Deferred<SubAgentExecutionOutcome>();
      const rawHandleCancel = vi.fn(async () => undefined);
      const adapterCancel = vi.fn(async () => undefined);
      const baseExecutor = sameProcessExecutor(executorName, async () => {
        throw new Error('The settlement takeover fixture only uses spawn().');
      });
      const executor: SubAgentExecutor = {
        ...baseExecutor,
        async spawn(request): Promise<ExecutorTaskHandle> {
          const binding = sameProcessBinding(request, executorName);
          return {
            taskId: request.taskId,
            binding,
            snapshot: async () => ({
              taskId: request.taskId,
              state: 'running',
              binding,
              updatedAt: Date.now(),
            }),
            wait: () => rawWait.promise,
            cancel: rawHandleCancel,
            async *events() {},
          };
        },
        cancel: adapterCancel,
      };
      const runtime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [definition],
        executors: [executor],
        stateStore,
      });
      await runtime.init();
      const cancelDescendants = vi.spyOn(runtime, 'cancelRunDescendants');
      const model = new MockModel([
        response(assistant('', [toolCall('settlement-slow-tool-call', 'settlement-slow-tool')])),
      ]);
      const toolEntered = new Deferred<ToolRuntimeContext<TestProtocol>>();
      const agent = new Agent<TestProtocol>({
        llm: model,
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 2,
      });
      agent.tools.push({
        name: 'settlement-slow-tool',
        description: 'Wait for caller cancellation before durable settlement.',
        handler(_parameters, toolRuntime: ToolRuntimeContext<TestProtocol>) {
          toolEntered.resolve(toolRuntime);
          return new Promise<never>((_resolve, reject) => {
            const rejectWithAbort = () => reject(toolRuntime.signal.reason);
            if (toolRuntime.signal.aborted) rejectWithAbort();
            else toolRuntime.signal.addEventListener('abort', rejectWithAbort, { once: true });
          });
        },
      });
      agent.init();
      const caller = new AbortController();
      const pending = agent.agent('lose ownership only after settlement begins', {
        signal: caller.signal,
      });
      const toolRuntime = await toolEntered.promise;
      if (toolRuntime.runId === undefined) throw new Error('Expected a durable root run ID.');
      const child = await runtime.spawn({
        runId: toolRuntime.runId,
        requestId: 'settlement-takeover-background-request',
        subAgent: definition.name,
        executor: executorName,
        input: { prompt: 'stay active across takeover' },
      });
      await vi.waitFor(() =>
        expect(stateStore.snapshot(sessionId).tasks).toMatchObject([
          { taskId: child.taskId, state: 'running', binding: { executorName } },
        ]),
      );

      const listTasks = stateStore.listTasksByRun.bind(stateStore);
      const settlementEntered = new Deferred<void>();
      const releaseSettlement = new Deferred<void>();
      let blocked = false;
      const listTasksSpy = vi
        .spyOn(stateStore, 'listTasksByRun')
        .mockImplementation(async (ownerSessionId, runId) => {
          const tasks = await listTasks(ownerSessionId, runId);
          if (!blocked && ownerSessionId === sessionId && runId === toolRuntime.runId) {
            blocked = true;
            settlementEntered.resolve(undefined);
            await releaseSettlement.promise;
          }
          return tasks;
        });

      caller.abort(new Error('caller cancellation enters terminal settlement'));
      await settlementEntered.promise;
      const beforeTakeover = stateStore.snapshot(sessionId);
      expect(beforeTakeover).toMatchObject({
        runs: [{ status: 'running' }],
        tasks: [{ state: 'running' }],
      });

      clock.advanceBy(30_001);
      const takeover = await stateStore.acquireLease(
        `agent-run:${JSON.stringify([sessionId, toolRuntime.runId])}`,
        30_000,
      );
      releaseSettlement.resolve(undefined);
      try {
        const outcome = await pending;
        expect(outcome).toMatchObject({
          status: 'failed',
          sessionId,
          runId: toolRuntime.runId,
          error: {
            code: 'RECOVERY_TARGET_LOST',
            causeCode: 'ROOT_EXECUTION_LEASE_LOST',
          },
        });
        expect(cancelDescendants).not.toHaveBeenCalled();
        expect(adapterCancel).not.toHaveBeenCalled();
        expect(rawHandleCancel).not.toHaveBeenCalled();
        expect(stateStore.snapshot(sessionId)).toEqual(beforeTakeover);
      } finally {
        listTasksSpy.mockRestore();
        const cleanupController = new AbortController();
        await runtime.cancelRunDescendants(
          sessionId,
          toolRuntime.runId,
          {
            ownerSessionId: sessionId,
            runId: toolRuntime.runId,
            fencingToken: takeover.fencingToken,
            signal: cleanupController.signal,
            useStateLease: (operation) => operation(takeover),
          },
          'settlement takeover test cleanup',
        );
        cleanupController.abort();
        await takeover.release();
      }
    },
  );

  acceptanceIt(
    'RUN-07.l1.no-codec-root-provider-abort',
    'same-process-intent-budget-and-no-replay',
    async () => {
      const sessionId = 'no-codec-root-provider-abort';
      const stateStore = new RecordingRuntimeStateStore();
      const runtime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [],
        executors: [],
        stateStore,
      });
      await runtime.init();
      const cancelDescendants = vi.spyOn(runtime, 'cancelRunDescendants');
      const entered = new Deferred<void>();
      const model = new MockModel([
        async () => {
          entered.resolve(undefined);
          return await new Promise<never>(() => undefined);
        },
      ]);
      const agent = new Agent({
        llm: model,
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 2,
      });
      agent.init();
      const abort = new AbortController();
      const pending = agent.agent('abort one no-codec provider attempt', {
        signal: abort.signal,
      });
      await entered.promise;
      abort.abort(new Error('caller stopped the same-process provider'));

      const outcome = await pending;
      expect(outcome).toMatchObject({
        status: 'failed',
        error: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
      });
      expect(model.requests).toHaveLength(1);
      expect(cancelDescendants).not.toHaveBeenCalled();
      const stored = (await stateStore.loadRun(sessionId, outcome.runId))!;
      expect(stored).toMatchObject({
        status: 'failed',
        budget: { providerCalls: 1 },
        modelOperation: { phase: 'in_flight' },
        error: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
      });
      expect(stored).not.toHaveProperty('pendingBatch');
      const terminalRevision = stored.revision;

      await expect(agent.resumeRun({ runId: outcome.runId })).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      expect(model.requests).toHaveLength(1);
      expect(cancelDescendants).not.toHaveBeenCalled();
      expect((await stateStore.loadRun(sessionId, outcome.runId))?.revision).toBe(terminalRevision);
    },
  );

  acceptanceIt(
    'RUN-03.l1.durable-context-length-recovery',
    'explicit-rejection-summary-and-retry',
    async () => {
      const sessionId = 'durable-context-recovery-session';
      const stateStore = new RecordingRuntimeStateStore();
      const runtime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [],
        executors: [],
        stateStore,
      });
      await runtime.init();
      const providerError = Object.assign(new Error('context length exceeded'), {
        status: 400,
        code: 'context_length_exceeded',
      });
      const provider = vi
        .fn()
        .mockRejectedValueOnce(providerError)
        .mockResolvedValueOnce(chatTextResponse('durable compact memory'))
        .mockResolvedValueOnce(chatToolResponse('durable-recovery-end', 'end-agent', {}));
      const policy: SummaryCompactPolicy<OpenAIChatProtocol> = {
        trigger: () => false,
        prompt: () => 'Summarize the old context.',
        validate: () => ({ ok: true }),
      };
      const agent = new Agent<OpenAIChatProtocol>({
        llm: createChatModel('offline-durable-context-recovery', provider),
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 3,
        contextCompact: { summary: policy },
      });
      const beforeRecovery = vi.fn();
      agent.onBeforeModelErrorRecovery(beforeRecovery);
      agent.appendContext({ role: 'user', content: 'old context to summarize' });
      agent.init();

      const outcome = await agent.agent('current request must be preserved');
      expect(outcome).toMatchObject({ status: 'succeeded' });
      expect(provider).toHaveBeenCalledTimes(3);
      expect(beforeRecovery).toHaveBeenCalledOnce();
      expect(beforeRecovery.mock.calls[0]?.[0]).toMatchObject({
        descriptor: { kind: 'context_length_exceeded', status: 400 },
        requestAttempt: 1,
      });
      expect(JSON.stringify(agent.getContext())).toContain('durable compact memory');
      const stored = await stateStore.loadRun(sessionId, outcome.runId);
      expect(stored).toMatchObject({
        status: 'succeeded',
        budget: { providerCalls: 3 },
      });
      expect(stored).not.toHaveProperty('modelOperation');
      expect(stored).not.toHaveProperty('compactTransaction');
      const terminalRevision = stored!.revision;
      await expect(agent.resumeRun({ runId: outcome.runId })).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      expect(provider).toHaveBeenCalledTimes(3);
      expect((await stateStore.loadRun(sessionId, outcome.runId))?.revision).toBe(terminalRevision);
    },
  );

  acceptanceIt('API-01.l1.agent-static-description-removed', 'public-class-shape', () => {
    expect(Object.hasOwn(Agent, 'description')).toBe(false);
  });
});

function sameProcessCatalogEntry(name: string): SubAgentCatalogEntry {
  return {
    definition: { name, version: '2' },
    description: `${name} definition.`,
    inputSchema: z.object({ query: z.string() }),
    executors: [
      {
        runtimeProtocolVersion: '1',
        taskRecordVersions: ['1'],
        childCheckpointVersions: ['1'],
        runnerCompatibility: [
          {
            runnerId: 'same-process-runner',
            runnerVersion: '1',
            childCheckpointVersions: ['1'],
          },
        ],
        name: 'memory',
        description: 'Same-process memory placement.',
        useCases: ['Offline request-boundary test.'],
        capabilities: {
          execute: true,
          spawn: false,
          cancel: true,
          events: false,
          approval: false,
          usage: 'none',
          recovery: { resume: 'same_process', reconnect: 'none' },
        },
        adapterStateVersion: '1',
        maxBindingBytes: 64 * 1024,
        maxEventPageSize: 32,
        status: 'available',
      },
    ],
  };
}

function catalogEntryWithRecovery(
  name: string,
  recovery: SubAgentExecutorDescriptor['capabilities']['recovery'],
): SubAgentCatalogEntry {
  const entry = sameProcessCatalogEntry(name);
  return {
    ...entry,
    executors: entry.executors.map((executor) => ({
      ...executor,
      capabilities: {
        ...executor.capabilities,
        recovery: { ...recovery },
      },
    })),
  };
}

function mutableCatalogRuntime(options: {
  readonly sessionId: string;
  readonly stateStore: RecordingRuntimeStateStore;
  readonly getRevision: () => number;
  readonly getEntries: () => readonly SubAgentCatalogEntry[];
  readonly stageTool: ReturnType<typeof vi.fn>;
}): SubAgentRuntime {
  const snapshot = () => ({
    revision: options.getRevision(),
    capturedAt: Date.now(),
    executors: [],
  });
  return {
    sessionId: options.sessionId,
    stateStore: options.stateStore,
    limits: DEFAULT_SUBAGENT_LIMITS,
    ready: true,
    init: async () => undefined,
    refreshCatalog: async () => snapshot(),
    getCatalog: snapshot,
    getCatalogEntries: options.getEntries,
    stageTool: options.stageTool,
  } as unknown as SubAgentRuntime;
}

function sameProcessExecutor(
  name: string,
  execute: (
    request: SubAgentExecutionRequest,
    control: SubAgentExecutionControl,
  ) => Promise<SubAgentExecutionOutcome>,
): SubAgentExecutor {
  const descriptor: SubAgentExecutorDescriptor = {
    runtimeProtocolVersion: '1',
    taskRecordVersions: ['1'],
    childCheckpointVersions: ['1'],
    runnerCompatibility: [
      {
        runnerId: 'same-process-test-runner',
        runnerVersion: '1',
        childCheckpointVersions: ['1'],
      },
    ],
    name,
    description: 'In-memory same-process acceptance placement.',
    useCases: ['Custom protocol without a durable checkpoint codec.'],
    capabilities: {
      execute: true,
      spawn: true,
      cancel: true,
      events: false,
      approval: true,
      usage: 'none',
      recovery: { resume: 'same_process', reconnect: 'none' },
    },
    adapterStateVersion: '1',
    maxBindingBytes: 64 * 1024,
    maxEventPageSize: 32,
  };
  return {
    descriptor,
    bindingCodec: {
      adapterStateVersion: '1',
      encode: (value: JsonValue): JsonValue => value,
      decode: (value: JsonValue): JsonValue => value,
    },
    getAvailability(): ExecutorAvailabilityProbe {
      return { status: 'available' };
    },
    supports: () => true,
    execute,
    async spawn(): Promise<ExecutorTaskHandle> {
      throw new Error('same-process acceptance placement does not support spawn');
    },
    async cancel(): Promise<void> {},
  };
}

function sameProcessBinding(
  request: SubAgentExecutionRequest,
  executorName: string,
): SubAgentExecutorBinding {
  return {
    version: '1',
    executorName,
    ownerSessionId: request.ownerSessionId,
    taskId: request.taskId,
    subagentSessionId: request.subagentSessionId,
    definitionName: request.definition.name,
    definitionVersion: request.definition.version,
    runnerId: 'same-process-test-runner',
    runnerVersion: '1',
    adapterStateVersion: '1',
    recoveryData: { kind: 'same-process-test/v1' },
  };
}

function sameProcessApprovalCheckpoint() {
  const input = {};
  return {
    version: '1' as const,
    runnerId: 'same-process-test-runner',
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
    modelIteration: 0,
    maxIterations: 2,
    pendingBatch: {
      version: '1' as const,
      batchId: 'same-process-approval-batch',
      assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
      calls: [
        {
          version: '1' as const,
          operationId: 'same-process-sensitive-operation',
          kind: 'tool' as const,
          callId: 'same-process-sensitive-call',
          name: 'same-process-sensitive-tool',
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

function modelVisibleAgentDescription(
  tools: readonly { readonly name: string; readonly description: unknown }[],
): string {
  const tool = tools.find(({ name }) => name === 'agent');
  if (tool === undefined || typeof tool.description !== 'string') {
    throw new Error('Expected a model-visible agent Tool.');
  }
  return tool.description;
}

function modelHasAgentTool(
  tools: readonly { readonly name: string; readonly description: unknown }[],
): boolean {
  return tools.some(({ name }) => name === 'agent');
}

async function createSummaryFixture(label: string) {
  const stateStore = new RecordingRuntimeStateStore();
  const model = createChatModel(`offline-${label}`, vi.fn());
  const contextStore = new ContextStore<OpenAIChatProtocol>([
    { role: 'user', content: `${label}:old-history` },
  ]);
  contextStore.appendStandalone({ role: 'user', content: `${label}:current-task` }, 'user');
  const policy: SummaryCompactPolicy<OpenAIChatProtocol> = {
    trigger: ({ activeContext }) =>
      !JSON.stringify(activeContext).includes('Framework-generated summary'),
    prompt: () => `${label}:summarize-old-history`,
  };
  const pendingRequest: ModelGenerateRequest<OpenAIChatProtocol> = {
    context: contextStore.getActiveContext(),
    tools: [],
  };
  const plan = await prepareSummaryCompactPlan({
    model,
    store: contextStore,
    policy,
    cause: { type: 'trigger' },
    iteration: 0,
    pendingRequest,
  });
  if (plan === undefined) throw new Error('expected a deterministic summary compact plan');
  const requestHash = durableRequestHash('context-summary', plan.request);
  const metadata: JsonValue = {
    version: '1',
    cause: 'trigger',
    iteration: 0,
    requestHash,
  };
  const prepared = createCompactTransactionCheckpoint({
    transactionId: `compact-summary-${canonicalJsonSha256(metadata)}`,
    kind: 'summary',
    contextRevision: plan.storeSnapshot.revision,
    preparedAt: 1,
    metadata,
  });
  return { stateStore, model, contextStore, policy, plan, prepared };
}

function createToolCompactFixture(label: string) {
  const stateStore = new RecordingRuntimeStateStore();
  const model = createChatModel(`offline-${label}`, vi.fn());
  const argumentsText = JSON.stringify({ value: `${label}-${'x'.repeat(9_000)}` });
  const callId = `${label}-call`;
  const assistantMessage: OpenAIChatContext = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: callId,
        type: 'function',
        function: { name: 'echo', arguments: argumentsText },
      },
    ],
  };
  const originalResult = `${label}-original-result`;
  const resultMessage = model.buildToolCallOutputMessage({ callId, output: originalResult });
  const contextStore = new ContextStore<OpenAIChatProtocol>([
    { role: 'user', content: `${label}:seed` },
  ]);
  contextStore.openLoopSpan();
  contextStore.appendToOpenLoop(assistantMessage);
  contextStore.appendToOpenLoop(resultMessage);
  const snapshot = contextStore.snapshotOpenLoop();
  const parsedCalls = model.parseToolCalls([assistantMessage]);
  const plan = createToolBatchPlan({
    batchId: `${label}-batch`,
    iteration: 0,
    assistantMessage: {
      protocol: OPENAI_CHAT_CHECKPOINT_CODEC.protocol,
      codecVersion: OPENAI_CHAT_CHECKPOINT_CODEC.version,
      value: OPENAI_CHAT_CHECKPOINT_CODEC.encode([assistantMessage]),
    },
    calls: parsedCalls,
    createdAt: 1,
  });
  const initialCall = plan.initialCheckpoint.calls[0]!;
  const pendingBatch: StoredPendingToolBatch = Object.freeze({
    ...plan.initialCheckpoint,
    calls: Object.freeze([
      Object.freeze({
        ...initialCall,
        status: 'applied' as const,
        output: originalResult,
      }),
    ]),
  });
  const projection: JsonValue = {
    version: '1',
    protocol: OPENAI_CHAT_CHECKPOINT_CODEC.protocol,
    codecVersion: OPENAI_CHAT_CHECKPOINT_CODEC.version,
    iteration: 0,
    contextRevision: snapshot.revision,
    activeContext: OPENAI_CHAT_CHECKPOINT_CODEC.encode(snapshot.activeContext),
    calls: [
      {
        callId,
        name: 'echo',
        arguments: argumentsText,
        result: originalResult,
        compactResult: true,
      },
    ],
  };
  const metadata: JsonValue = {
    version: '1',
    iteration: 0,
    inputHash: canonicalJsonSha256(projection),
  };
  const prepared = createCompactTransactionCheckpoint({
    transactionId: `compact-tool-payload-${canonicalJsonSha256(metadata)}`,
    kind: 'tool_payload',
    contextRevision: snapshot.revision,
    preparedAt: 1,
    metadata,
  });
  return {
    stateStore,
    model,
    contextStore,
    snapshot,
    pendingBatch,
    prepared,
    argumentsText,
    callId,
  };
}

function createToolCompactResultReady(
  fixture: ReturnType<typeof createToolCompactFixture>,
  replacement: string,
): DurableCompactTransaction & { readonly phase: 'result_ready'; readonly result: JsonValue } {
  const call = fixture.model
    .parseToolCalls(fixture.snapshot.activeContext)
    .find(({ id }) => id === fixture.callId);
  if (call === undefined) throw new Error('expected the persisted tool call');
  const candidate = fixture.model.rewriteToolPayloads(fixture.snapshot.activeContext, {
    inputs: [
      {
        sourceMessage: call.sourceMessage,
        sourceCall: call.sourceCall,
        replacement,
      },
    ],
    results: [],
  });
  return completeCompactTransactionCheckpoint(
    beginCompactTransactionCheckpoint(fixture.prepared, 2),
    {
      version: '1',
      kind: 'tool_payload',
      candidate: {
        protocol: OPENAI_CHAT_CHECKPOINT_CODEC.protocol,
        codecVersion: OPENAI_CHAT_CHECKPOINT_CODEC.version,
        value: OPENAI_CHAT_CHECKPOINT_CODEC.encode(candidate),
      },
    },
    3,
  );
}

async function createSeededAgent(input: {
  readonly sessionId: string;
  readonly runId: string;
  readonly stateStore: RecordingRuntimeStateStore;
  readonly contextStore: ContextStore<OpenAIChatProtocol>;
  readonly transaction: DurableCompactTransaction;
  readonly pendingBatch?: StoredPendingToolBatch;
  readonly contextCompact: ContextCompactOptions<OpenAIChatProtocol>;
  readonly provider: ReturnType<typeof vi.fn>;
  readonly installEchoTool?: boolean;
}): Promise<Agent<OpenAIChatProtocol>> {
  const runtime = createSubAgentRuntime({
    sessionId: input.sessionId,
    activeDefinitions: [],
    executors: [],
    stateStore: input.stateStore,
  });
  await runtime.init();
  const buildAgent = (provider: ReturnType<typeof vi.fn>): Agent<OpenAIChatProtocol> => {
    const agent = new Agent<OpenAIChatProtocol>({
      llm: createChatModel(`offline-${input.runId}`, provider),
      subAgentRuntime: runtime,
      sessionId: input.sessionId,
      maxIterations: 3,
      contextCompact: input.contextCompact,
    });
    if (input.installEchoTool) {
      agent.tools.push({
        name: 'echo',
        description: 'Recovery fixture Tool that must never be replayed.',
        handler: recoveredEchoMustNotReplay,
      });
    }
    agent.init();
    return agent;
  };
  const identityAgent = buildAgent(
    vi.fn().mockResolvedValueOnce(chatToolResponse('configuration-identity-end', 'end-agent', {})),
  );
  const identityOutcome = await identityAgent.agent('capture configuration identity');
  const configurationHash = input.stateStore
    .snapshot(input.sessionId)
    .runs.find(({ runId }) => runId === identityOutcome.runId)!.configurationHash;
  clearMockFunctions(input.contextCompact);

  const controller = new AgentRunCheckpointController<OpenAIChatProtocol>({
    ownerSessionId: input.sessionId,
    stateStore: input.stateStore,
    checkpointCodec: OPENAI_CHAT_CHECKPOINT_CODEC,
  });
  const active = await controller.beginCreate({
    runId: input.runId,
    contextStore: input.contextStore,
    limits: DEFAULT_SUBAGENT_LIMITS,
    maxIterations: 3,
    configurationHash,
  });
  await controller.checkpoint(
    {
      runId: input.runId,
      contextStore: input.contextStore,
      status: 'running',
      modelIteration: 0,
      compactTransaction: input.transaction,
      ...(input.pendingBatch === undefined ? {} : { pendingBatch: input.pendingBatch }),
    },
    active.lease,
  );
  await active.lease.release();

  return buildAgent(input.provider);
}

function recoveredEchoMustNotReplay(): never {
  throw new Error('A recovered applied Tool must not execute again.');
}

function clearMockFunctions(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === 'function') {
    const mockClear = (value as unknown as { mockClear?: () => void }).mockClear;
    mockClear?.call(value);
    return;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const entry of Object.values(value)) clearMockFunctions(entry, seen);
}

function durableRequestHash(
  purpose: 'agent' | 'context-summary',
  request: ModelGenerateRequest<OpenAIChatProtocol>,
): string {
  return canonicalJsonSha256({
    purpose,
    protocol: OPENAI_CHAT_CHECKPOINT_CODEC.protocol,
    codecVersion: OPENAI_CHAT_CHECKPOINT_CODEC.version,
    context: OPENAI_CHAT_CHECKPOINT_CODEC.encode(request.context),
    tools: request.tools as unknown as JsonValue,
  });
}

function createChatModel(model: string, create: ReturnType<typeof vi.fn>): OpenAIChatModel {
  return new OpenAIChatModel({
    model,
    client: { chat: { completions: { create } } } as never,
  });
}

function chatTextResponse(content: string) {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

function chatToolResponse(callId: string, name: string, parameters: JsonValue) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: { name, arguments: JSON.stringify(parameters) },
            },
          ],
        },
      },
    ],
  };
}

function findChatToolArguments(
  context: readonly OpenAIChatContext[],
  callId: string,
): string | undefined {
  for (const message of context) {
    if (message.role !== 'assistant' || !message.tool_calls) continue;
    const call = message.tool_calls.find(
      (candidate) => candidate.type === 'function' && candidate.id === callId,
    );
    if (call?.type === 'function') return call.function.arguments;
  }
  return undefined;
}
