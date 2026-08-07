import { describe, expect, vi } from 'vitest';
import { z } from 'zod';

import { acceptanceIt, RecordingRuntimeStateStore } from '../../../testkit';
import { Agent } from '../src/agent';
import { OpenAIChatModel } from '../src/llm/chat';
import type { OpenAIChatProtocol } from '../src/llm/chat/types';
import type { SubAgentChildRunRequest } from '../src/subagent/child-runner';
import type { SubAgentChildCheckpoint } from '../src/subagent/checkpoint';
import type { SubAgentExecutionControl } from '../src/subagent/executor';
import { canonicalJsonSha256, type JsonValue } from '../src/subagent/json';
import { DEFAULT_SUBAGENT_LIMITS } from '../src/subagent/limits';
import type { SubAgentFailureInput, SubAgentUsageDelta } from '../src/subagent/result';
import { createSubAgentRuntime } from '../src/subagent/runtime-implementation';

const TASK_ID = 'usage-settlement-task';
const PROOF = 'usage-settlement-proof';

function chatToolResponse(
  callId: string,
  name: string,
  parameters: JsonValue,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
) {
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
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
}

function createChatModel(create: ReturnType<typeof vi.fn>): OpenAIChatModel {
  return new OpenAIChatModel({
    model: 'offline-usage-settlement',
    client: { chat: { completions: { create } } } as never,
  });
}

function createChildRequest(
  checkpoint?: SubAgentChildCheckpoint,
  attempt = 1,
): SubAgentChildRunRequest {
  return Object.freeze({
    ownerSessionId: 'usage-settlement-owner',
    runId: 'usage-settlement-run',
    taskId: TASK_ID,
    subagentSessionId: 'usage-settlement-child-session',
    path: Object.freeze([TASK_ID]),
    attempt,
    executionEpoch: `usage-settlement-epoch-${attempt}`,
    executionFencingToken: String(attempt),
    definition: Object.freeze({ name: 'usage-settlement-child', version: '2' }),
    input: Object.freeze({ prompt: 'settle provider usage' }),
    projectedContext: Object.freeze([]),
    delegation: Object.freeze({
      version: '1' as const,
      ownerSessionId: 'usage-settlement-owner',
      runId: 'usage-settlement-run',
      parentTaskId: TASK_ID,
      path: Object.freeze([TASK_ID]),
      depth: 1,
      catalogRevision: 1,
      definitions: Object.freeze([]),
    }),
    limits: DEFAULT_SUBAGENT_LIMITS,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 120_000,
  });
}

function createControl(options: { readonly replayResults?: boolean } = {}) {
  const checkpoints: SubAgentChildCheckpoint[] = [];
  const consumeBudget = vi.fn(async (operationId: string, delta: SubAgentUsageDelta) => {
    void operationId;
    void delta;
  });
  const submitResult = vi.fn(async (callId: string, candidate: JsonValue) => ({
    schemaVersion: '1' as const,
    receiptId: `result-receipt-${callId}`,
    taskId: TASK_ID,
    callId,
    revision: 10,
    outputHash: canonicalJsonSha256(candidate),
    submittedAt: 10,
    status: options.replayResults === true ? ('replayed' as const) : ('accepted' as const),
  }));
  const complete = vi.fn(async (callId: string) => ({
    schemaVersion: '1' as const,
    receiptId: `completion-receipt-${callId}`,
    taskId: TASK_ID,
    callId,
    revision: 11,
    completedAt: 11,
    status: options.replayResults === true ? ('replayed' as const) : ('completed' as const),
  }));
  const fail = vi.fn(async (_callId: string, failure: SubAgentFailureInput) => ({
    status: failure.status,
    task: {
      taskId: TASK_ID,
      subAgent: { name: 'usage-settlement-child', version: '2' },
    },
    executor: 'local-usage-settlement',
    error: failure.error,
    ...(failure.partialOutput === undefined ? {} : { partialOutput: failure.partialOutput }),
  }));
  const control = {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 120_000,
    delegation: {
      getCatalog: () => ({ revision: 1, capturedAt: 1, executors: [] }),
      getCatalogEntries: () => [],
    },
    artifacts: undefined,
    completion: { submitResult, complete, fail },
    commitBinding: vi.fn(async () => undefined),
    commitCheckpoint: vi.fn(async (_operationId: string, checkpoint: SubAgentChildCheckpoint) => {
      checkpoints.push(checkpoint);
    }),
    authorizeTool: vi.fn(async () => {
      throw new Error('No approval is expected.');
    }),
    pauseDelegation: vi.fn(async () => {
      throw new Error('No nested delegation pause is expected.');
    }),
    reportProgress: vi.fn(async () => undefined),
    consumeBudget,
    emit: vi.fn(async () => undefined),
  } as unknown as SubAgentExecutionControl;

  return { control, checkpoints, consumeBudget, submitResult, complete, fail };
}

function childOptions(
  request: SubAgentChildRunRequest,
  control: SubAgentExecutionControl,
  checkpointMode: 'same_process' | 'durable',
) {
  return {
    request,
    control,
    runnerId: 'usage-settlement-runner',
    runnerVersion: '2.0.0',
    executorName: 'local-usage-settlement',
    checkpointMode,
    input: 'settle provider usage',
    outputSchema: z.object({ proof: z.literal(PROOF) }).strict(),
  } as const;
}

function expectBudgetAndUsagePair(
  calls: readonly (readonly [string, SubAgentUsageDelta])[],
  offset: number,
  usage: Readonly<{ readonly inputTokens: number; readonly outputTokens: number }>,
): void {
  const [budgetOperationId, budget] = calls[offset]!;
  const providerOperationId = budgetOperationId.replace(/^provider-budget-/u, '');
  expect(providerOperationId).not.toBe(budgetOperationId);
  expect(budget).toEqual({ turns: 1, providerCalls: 1 });
  expect(calls[offset + 1]).toEqual([
    `provider-usage-${providerOperationId}`,
    { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  ]);
}

describe('Agent Model usage settlement', () => {
  acceptanceIt('BUD-02.l1.root-model-usage-settlement', 'root-result-ready-atomic', async () => {
    const sessionId = 'root-usage-settlement-session';
    const stateStore = new RecordingRuntimeStateStore();
    const runtime = createSubAgentRuntime({
      sessionId,
      activeDefinitions: [],
      executors: [],
      stateStore,
      limits: { maxProviderCalls: 2, maxInputTokens: 100, maxOutputTokens: 50 },
    });
    await runtime.init();
    const sdkCreate = vi.fn().mockResolvedValueOnce(
      chatToolResponse(
        'root-usage-end-call',
        'end-agent',
        {},
        {
          inputTokens: 19,
          outputTokens: 5,
        },
      ),
    );
    const root = new Agent<OpenAIChatProtocol>({
      llm: createChatModel(sdkCreate),
      subAgentRuntime: runtime,
      sessionId,
      maxIterations: 2,
    });
    root.init();

    const outcome = await root.agent('persist normalized root usage');

    expect(outcome).toMatchObject({ status: 'succeeded', sessionId });
    await expect(stateStore.loadRun(sessionId, outcome.runId)).resolves.toMatchObject({
      status: 'succeeded',
      budget: { providerCalls: 1, inputTokens: 19, outputTokens: 5 },
    });
  });

  acceptanceIt(
    'BUD-02.l1.root-model-usage-malformed',
    'root-malformed-no-token-mutation',
    async () => {
      const sessionId = 'root-malformed-usage-session';
      const stateStore = new RecordingRuntimeStateStore();
      const runtime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [],
        executors: [],
        stateStore,
      });
      await runtime.init();
      const sdkCreate = vi.fn().mockResolvedValueOnce(
        chatToolResponse(
          'root-malformed-end-call',
          'end-agent',
          {},
          {
            inputTokens: -1,
            outputTokens: 5,
          },
        ),
      );
      const root = new Agent<OpenAIChatProtocol>({
        llm: createChatModel(sdkCreate),
        subAgentRuntime: runtime,
        sessionId,
        maxIterations: 2,
      });
      root.init();

      const outcome = await root.agent('reject malformed root usage');

      expect(outcome).toMatchObject({ status: 'failed', sessionId });
      await expect(stateStore.loadRun(sessionId, outcome.runId)).resolves.toMatchObject({
        status: 'failed',
        budget: { providerCalls: 1, inputTokens: 0, outputTokens: 0 },
      });
    },
  );

  acceptanceIt(
    'BUD-02.l1.child-model-usage-settlement',
    'child-idempotent-result-ready-replay',
    async () => {
      const firstSdkCreate = vi
        .fn()
        .mockResolvedValueOnce(
          chatToolResponse(
            'usage-result-call',
            'agent-result',
            { result: { proof: PROOF } },
            { inputTokens: 11, outputTokens: 3 },
          ),
        )
        .mockResolvedValueOnce(
          chatToolResponse('usage-end-call', 'end-agent', {}, { inputTokens: 13, outputTokens: 2 }),
        );
      const firstControl = createControl();
      const firstAgent = new Agent<OpenAIChatProtocol>({
        llm: createChatModel(firstSdkCreate),
        maxIterations: 3,
      });

      await expect(
        firstAgent.runAsSubAgent(
          childOptions(createChildRequest(), firstControl.control, 'durable'),
        ),
      ).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'succeeded', output: { proof: PROOF } },
      });
      const firstBudgetCalls = firstControl.consumeBudget.mock.calls as Array<
        [string, SubAgentUsageDelta]
      >;
      expect(firstBudgetCalls).toHaveLength(4);
      expectBudgetAndUsagePair(firstBudgetCalls, 0, { inputTokens: 11, outputTokens: 3 });
      expectBudgetAndUsagePair(firstBudgetCalls, 2, { inputTokens: 13, outputTokens: 2 });

      const resultReady = firstControl.checkpoints.find(
        (checkpoint) =>
          checkpoint.modelOperation?.phase === 'result_ready' &&
          checkpoint.modelOperation.iteration === 0,
      );
      expect(resultReady).toBeDefined();

      const replaySdkCreate = vi
        .fn()
        .mockResolvedValueOnce(
          chatToolResponse(
            'usage-replay-end-call',
            'end-agent',
            {},
            { inputTokens: 17, outputTokens: 4 },
          ),
        );
      const replayControl = createControl({ replayResults: true });
      const replayAgent = new Agent<OpenAIChatProtocol>({
        llm: createChatModel(replaySdkCreate),
        maxIterations: 3,
      });

      await expect(
        replayAgent.runAsSubAgent(
          childOptions(createChildRequest(resultReady, 2), replayControl.control, 'durable'),
        ),
      ).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'succeeded', output: { proof: PROOF } },
      });
      expect(replaySdkCreate).toHaveBeenCalledOnce();
      const replayBudgetCalls = replayControl.consumeBudget.mock.calls as Array<
        [string, SubAgentUsageDelta]
      >;
      expect(replayBudgetCalls).toHaveLength(2);
      expectBudgetAndUsagePair(replayBudgetCalls, 0, { inputTokens: 17, outputTokens: 4 });
    },
  );

  acceptanceIt(
    'BUD-02.l1.child-model-usage-malformed',
    'child-malformed-no-token-settlement',
    async () => {
      const sdkCreate = vi
        .fn()
        .mockResolvedValueOnce(
          chatToolResponse(
            'malformed-usage-result-call',
            'agent-result',
            { result: { proof: PROOF } },
            { inputTokens: -1, outputTokens: 2 },
          ),
        );
      const fixture = createControl();
      const child = new Agent<OpenAIChatProtocol>({
        llm: createChatModel(sdkCreate),
        maxIterations: 2,
      });

      await expect(
        child.runAsSubAgent(childOptions(createChildRequest(), fixture.control, 'durable')),
      ).resolves.toMatchObject({
        type: 'terminal',
        result: { status: 'failed', error: { code: 'EXECUTOR_FAILED' } },
      });
      expect(fixture.consumeBudget).toHaveBeenCalledOnce();
      expect(fixture.consumeBudget.mock.calls[0]?.[0]).toMatch(/^provider-budget-/u);
      expect(fixture.fail).toHaveBeenCalledOnce();
      expect(
        fixture.checkpoints.some(
          (checkpoint) => checkpoint.modelOperation?.phase === 'result_ready',
        ),
      ).toBe(false);
    },
  );
});
