import { describe, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  createSubAgentRuntime,
  defineSubAgent,
  OpenAIChatModel,
  type JsonValue,
  type OpenAIChatProtocol,
  type StoredAgentRun,
} from '@ruixutong.manee/maneeagent-framework';

import { Deferred, acceptanceIt } from '../../../testkit';
import {
  createLocalAgentRunnerRegistration,
  LocalSubAgentRunnerRegistry,
  MemoryAgentRuntimeStateStore,
  MemorySubAgentExecutor,
} from '../src';
import { createRun } from './fixtures';

const budgetDefinition = defineSubAgent({
  name: 'shared-budget-child',
  version: '2',
  description: 'Consume exactly one child provider call before the shared limit rejects the next.',
  inputSchema: z.object({ prompt: z.string() }).strict(),
  outputSchema: z.object({ answer: z.string() }).strict(),
});

const recoveryDefinition = defineSubAgent({
  name: 'provider-recovery-child',
  version: '2',
  description: 'Exercise durable child provider recovery and outcome-unknown handling.',
  inputSchema: z.object({ prompt: z.string() }).strict(),
  outputSchema: z.object({ answer: z.string() }).strict(),
});

describe('Local Agent provider control plane', () => {
  acceptanceIt(
    'ARK-12A.l4.shared-provider-budget.local',
    'local-agent-child-exact-limit',
    async () => {
      const sessionId = 'local-shared-provider-budget';
      const executorName = 'local-shared-budget';
      const stateStore = new MemoryAgentRuntimeStateStore();
      const childTool = vi.fn(() => 'child-first-round-proof');
      const childGenerate = vi.fn(async () => {
        if (childGenerate.mock.calls.length !== 1) {
          throw new Error('The child provider must not receive an over-limit request.');
        }
        return chatToolResponse('child-budget-tool-call', 'child-budget-proof', {
          marker: 'safe',
        });
      });
      const parentGenerate = vi.fn(async () => {
        if (parentGenerate.mock.calls.length !== 1) {
          throw new Error('The root provider must not receive an over-limit request.');
        }
        return chatToolResponse('parent-budget-agent-call', 'agent', {
          subAgent: budgetDefinition.name,
          executor: executorName,
          input: { prompt: 'consume the remaining provider slot' },
        });
      });
      const registration = createLocalAgentRunnerRegistration({
        definition: budgetDefinition,
        runnerId: 'shared-budget-child-runner',
        runnerVersion: '2.0.0',
        createAgent() {
          const child = new Agent<OpenAIChatProtocol>({
            llm: createChatModel('offline-shared-budget-child', childGenerate),
            maxIterations: 4,
          });
          child.tools.push({
            name: 'child-budget-proof',
            description: 'A deterministic first-round child Tool.',
            parameters: z.object({ marker: z.literal('safe') }).strict(),
            handler: childTool,
          });
          return child;
        },
        buildInput: ({ input }) => input.prompt,
      });
      const createRuntime = async () => {
        const runtime = createSubAgentRuntime({
          sessionId,
          activeDefinitions: [budgetDefinition],
          executors: [
            new MemorySubAgentExecutor({
              name: executorName,
              registry: new LocalSubAgentRunnerRegistry([registration]),
            }),
          ],
          stateStore,
          limits: { maxProviderCalls: 2 },
        });
        await runtime.init();
        return runtime;
      };
      const createParent = async () =>
        new Agent<OpenAIChatProtocol>({
          llm: createChatModel('offline-shared-budget-parent', parentGenerate),
          subAgentRuntime: await createRuntime(),
          sessionId,
          maxIterations: 3,
        }).init();

      const outcome = await (await createParent()).agent('prove the shared provider budget');
      expect(outcome).toMatchObject({
        status: 'failed',
        sessionId,
        error: { code: 'BUDGET_EXCEEDED' },
      });
      expect(parentGenerate).toHaveBeenCalledOnce();
      expect(childGenerate).toHaveBeenCalledOnce();
      expect(childTool).toHaveBeenCalledOnce();

      const run = await stateStore.loadRun(sessionId, outcome.runId);
      const tasks = await stateStore.listTasksByRun(sessionId, outcome.runId);
      expect(run).toMatchObject({
        status: 'failed',
        limits: { maxProviderCalls: 2 },
        budget: { providerCalls: 2, descendantsCreated: 1, activeExecutions: 0 },
        error: { code: 'BUDGET_EXCEEDED' },
      });
      expect(run).not.toHaveProperty('pendingBatch');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        state: 'budget_exceeded',
        usage: { providerCalls: 1, turns: 1 },
        error: { code: 'BUDGET_EXCEEDED' },
        result: {
          status: 'budget_exceeded',
          error: { code: 'BUDGET_EXCEEDED' },
          usage: { providerCalls: 1, turns: 1 },
        },
      });

      const terminalRun = structuredClone(run!);
      const terminalTask = structuredClone(tasks[0]!);
      const replacementRuntime = await createRuntime();
      const replay = await replacementRuntime.recover(sessionId, tasks[0]!.taskId);
      await expect(replay.wait()).resolves.toEqual({ type: 'terminal', result: tasks[0]!.result });
      await expect(
        (await createParent()).resumeRun({ runId: outcome.runId, decisions: [] }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(parentGenerate).toHaveBeenCalledOnce();
      expect(childGenerate).toHaveBeenCalledOnce();
      expect(await stateStore.loadRun(sessionId, outcome.runId)).toEqual(terminalRun);
      expect(await stateStore.loadTask(sessionId, tasks[0]!.taskId)).toEqual(terminalTask);
    },
  );

  acceptanceIt(
    'RUN-03.l4.child-context-length-recovery.local',
    'explicit-400-summary-hook-safe-retry',
    async () => {
      const sessionId = 'local-child-context-length-recovery';
      const runId = 'local-child-context-length-run';
      const stateStore = new MemoryAgentRuntimeStateStore();
      const overflow = Object.assign(new Error('context_length_exceeded fixture'), {
        status: 400,
        code: 'context_length_exceeded',
        requestId: 'context-length-fixture-request',
      });
      const beforeRecovery = vi.fn();
      const afterRecovery = vi.fn();
      const summaryPrompt = vi.fn(() => 'Summarize the child context for a safe retry.');
      const generate = vi
        .fn()
        .mockRejectedValueOnce(overflow)
        .mockImplementationOnce(async (request: unknown) => {
          expect(request).not.toHaveProperty('tools');
          return chatTextResponse('durable child emergency summary');
        })
        .mockImplementationOnce(async (request: unknown) => {
          expect(JSON.stringify(request)).toContain('durable child emergency summary');
          return chatToolResponse('recovered-child-result', 'agent-result', {
            result: { answer: 'context-recovered-proof' },
          });
        })
        .mockResolvedValueOnce(chatToolResponse('recovered-child-end', 'end-agent', {}));
      const registration = createLocalAgentRunnerRegistration({
        definition: recoveryDefinition,
        runnerId: 'context-recovery-child-runner',
        runnerVersion: '2.0.0',
        createAgent() {
          const child = new Agent<OpenAIChatProtocol>({
            llm: createChatModel('offline-context-recovery-child', generate),
            maxIterations: 3,
            contextCompact: {
              toolInput: false,
              toolResult: false,
              summary: {
                trigger: () => false,
                prompt: summaryPrompt,
              },
            },
            modelErrorRecovery: { unhandledRetryLimit: 0, contextLengthRecoveryLimit: 1 },
          });
          child.onBeforeModelErrorRecovery(beforeRecovery);
          child.onAfterModelErrorRecovery(afterRecovery);
          return child;
        },
        buildInput: ({ input }) => input.prompt,
      });
      const runtime = await createHostRuntime({
        sessionId,
        runId,
        stateStore,
        registration,
      });

      const outcome = await runtime.execute({
        runId,
        requestId: 'context-recovery-child-request',
        subAgent: recoveryDefinition.name,
        executor: 'local',
        input: { prompt: 'recover an explicit context overflow' },
      });
      expect(outcome).toMatchObject({
        type: 'terminal',
        result: { status: 'succeeded', output: { answer: 'context-recovered-proof' } },
      });
      expect(generate).toHaveBeenCalledTimes(4);
      expect(summaryPrompt).toHaveBeenCalledOnce();
      expect(beforeRecovery).toHaveBeenCalledOnce();
      expect(beforeRecovery.mock.calls[0]?.[0]).toMatchObject({
        cause: overflow,
        descriptor: {
          kind: 'context_length_exceeded',
          providerCode: 'context_length_exceeded',
          status: 400,
          requestId: 'context-length-fixture-request',
        },
        purpose: 'agent',
        requestAttempt: 1,
        matchedHandler: { id: 'core.context_compaction' },
      });
      expect(afterRecovery).toHaveBeenCalledOnce();
      expect(afterRecovery.mock.calls[0]?.[0]).toMatchObject({
        handlerOutcome: 'succeeded',
        proposedAction: 'retry',
        ledger: { contextRecoveryAttempts: 1 },
      });
      if (outcome.type !== 'terminal') throw new Error('expected terminal child recovery outcome');
      const task = await stateStore.loadTask(sessionId, outcome.result.task.taskId);
      expect(task).toMatchObject({
        state: 'succeeded',
        usage: { providerCalls: 4, turns: 3 },
        result: {
          status: 'succeeded',
          output: { answer: 'context-recovered-proof' },
          usage: { providerCalls: 4, turns: 3 },
        },
      });
      await expect(stateStore.loadRun(sessionId, runId)).resolves.toMatchObject({
        budget: { providerCalls: 4, activeExecutions: 0 },
      });
    },
  );

  acceptanceIt(
    'RUN-07.l4.child-provider-abort-outcome-unknown.local',
    'in-flight-abort-fails-without-recovery-progress',
    async () => {
      const sessionId = 'local-child-provider-abort';
      const runId = 'local-child-provider-abort-run';
      const stateStore = new MemoryAgentRuntimeStateStore();
      const providerEntered = new Deferred<void>();
      const generate = vi.fn((_request: unknown, options?: { readonly signal?: AbortSignal }) => {
        providerEntered.resolve(undefined);
        return new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      const registration = createLocalAgentRunnerRegistration({
        definition: recoveryDefinition,
        runnerId: 'provider-abort-child-runner',
        runnerVersion: '2.0.0',
        createAgent() {
          return new Agent<OpenAIChatProtocol>({
            llm: createChatModel('offline-provider-abort-child', generate),
            maxIterations: 3,
            modelErrorRecovery: { unhandledRetryLimit: 0 },
          });
        },
        buildInput: ({ input }) => input.prompt,
      });
      const runtime = await createHostRuntime({
        sessionId,
        runId,
        stateStore,
        registration,
      });
      const abort = new AbortController();
      const pending = runtime.execute({
        runId,
        requestId: 'provider-abort-child-request',
        subAgent: recoveryDefinition.name,
        executor: 'local',
        input: { prompt: 'abort only after provider dispatch' },
        signal: abort.signal,
      });
      await providerEntered.promise;
      let taskId = '';
      await vi.waitFor(async () => {
        const tasks = await stateStore.listTasksByRun(sessionId, runId);
        expect(tasks).toHaveLength(1);
        taskId = tasks[0]!.taskId;
        expect(tasks[0]).toMatchObject({
          state: 'running',
          usage: { providerCalls: 1, turns: 1 },
          childCheckpoint: { modelOperation: { phase: 'in_flight' } },
        });
      });
      abort.abort(new Error('host aborted after provider dispatch'));

      const outcome = await pending;
      expect(outcome).toMatchObject({
        type: 'terminal',
        result: {
          status: 'failed',
          error: {
            code: 'EXECUTOR_FAILED',
            causeCode: 'MODEL_OUTCOME_UNKNOWN',
            outcomeUnknown: true,
          },
          usage: { providerCalls: 1, turns: 1 },
        },
      });
      expect(generate).toHaveBeenCalledOnce();
      const task = await stateStore.loadTask(sessionId, taskId);
      expect(task).toMatchObject({
        state: 'failed',
        error: {
          code: 'EXECUTOR_FAILED',
          causeCode: 'MODEL_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        },
        result: {
          status: 'failed',
          error: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
        },
        usage: { providerCalls: 1, turns: 1 },
      });
      if (outcome.type !== 'terminal') throw new Error('expected terminal abort outcome');
      expect(task?.result).toEqual(outcome.result);
      expect(task?.controlOperations.some(({ kind }) => kind === 'binding')).toBe(true);
      expect(task?.controlOperations.some(({ kind }) => kind === 'budget')).toBe(true);
      expect(task?.controlOperations.filter(({ kind }) => kind === 'checkpoint')).toHaveLength(3);
      expect(task).not.toHaveProperty('completionReceipt');
      const events = await stateStore.readEvents(sessionId, taskId);
      expect(events.some(({ type }) => type === 'task.cancelled')).toBe(false);
      expect(events.at(-1)).toMatchObject({
        type: 'task.failed',
        data: { status: 'failed', errorCode: 'EXECUTOR_FAILED', outcomeUnknown: true },
      });
      await expect(stateStore.loadRun(sessionId, runId)).resolves.toMatchObject({
        status: 'running',
        budget: { providerCalls: 1, activeExecutions: 0 },
      });

      const terminalTask = structuredClone(task!);
      const terminalRun = structuredClone((await stateStore.loadRun(sessionId, runId))!);
      const recovered = await runtime.recover(sessionId, taskId);
      await expect(recovered.wait()).resolves.toEqual({ type: 'terminal', result: task!.result });
      expect(generate).toHaveBeenCalledOnce();
      expect(await stateStore.loadTask(sessionId, taskId)).toEqual(terminalTask);
      expect(await stateStore.loadRun(sessionId, runId)).toEqual(terminalRun);
    },
  );
});

function createChatModel(model: string, create: ReturnType<typeof vi.fn>): OpenAIChatModel {
  return new OpenAIChatModel({
    model,
    client: { chat: { completions: { create } } } as never,
  });
}

async function createHostRuntime(input: {
  readonly sessionId: string;
  readonly runId: string;
  readonly stateStore: MemoryAgentRuntimeStateStore;
  readonly registration: ReturnType<typeof createLocalAgentRunnerRegistration>;
}) {
  const runtime = createSubAgentRuntime({
    sessionId: input.sessionId,
    activeDefinitions: [recoveryDefinition],
    executors: [
      new MemorySubAgentExecutor({
        registry: new LocalSubAgentRunnerRegistry([input.registration]),
      }),
    ],
    stateStore: input.stateStore,
  });
  await runtime.init();
  await input.stateStore.createRun(
    createRun({
      ownerSessionId: input.sessionId,
      runId: input.runId,
      limits: runtime.limits,
    }) as StoredAgentRun,
  );
  return runtime;
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

function chatTextResponse(content: string) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content,
        },
      },
    ],
  };
}
