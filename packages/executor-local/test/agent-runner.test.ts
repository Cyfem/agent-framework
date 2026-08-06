import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  createSubAgentRuntime,
  canonicalJsonSha256,
  defineSubAgent,
  OpenAIChatModel,
  type AgentSubAgentRunOptions,
  type JsonValue,
  type OpenAIChatProtocol,
  type SubAgentDefinitionRegistration,
  type SubAgentExecutionOutcome,
  type UserMessageOf,
} from '@ruixutong.manee/maneeagent-framework';

import {
  createLocalAgentRunnerRegistration,
  type LocalSubAgentAgent,
  LocalSubAgentRunnerRegistry,
  MemoryAgentRuntimeStateStore,
  MemorySubAgentExecutor,
} from '../src';
import { RUN_ID, SESSION_ID, createRun } from './fixtures';

const definition = defineSubAgent({
  name: 'agent-reviewer',
  version: '2',
  description: 'Exercise the trusted Local Agent bridge.',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ answer: z.string() }),
});

describe('Local Core Agent runner registration', () => {
  it('creates an isolated Agent per task and passes only the trusted child bridge options', async () => {
    const stateStore = new MemoryAgentRuntimeStateStore();
    await stateStore.createRun(createRun());
    const invocations: {
      readonly instance: number;
      readonly options: AgentSubAgentRunOptions<OpenAIChatProtocol>;
    }[] = [];
    let instances = 0;
    const registration = createLocalAgentRunnerRegistration({
      definition,
      runnerId: 'agent-reviewer-runner',
      runnerVersion: '2.0.0',
      createAgent: (): LocalSubAgentAgent<OpenAIChatProtocol> => {
        const instance = ++instances;
        return {
          async runAsSubAgent(options) {
            invocations.push({ instance, options });
            const output = { answer: `proof-${instance}` };
            await options.control.completion.submitResult(`result-${instance}`, output);
            await options.control.completion.complete(`end-${instance}`, { isStandalone: true });
            return terminalOutcome(options, output);
          },
        };
      },
      buildInput: (request): UserMessageOf<OpenAIChatProtocol> => ({
        content: [{ type: 'text', text: `review:${request.input.prompt}` }],
      }),
    });
    const registry = new LocalSubAgentRunnerRegistry([registration]);
    const executor = new MemorySubAgentExecutor({
      registry,
      name: 'local-trusted',
    });
    const runtime = createSubAgentRuntime({
      sessionId: SESSION_ID,
      activeDefinitions: [definition as unknown as SubAgentDefinitionRegistration],
      executors: [executor],
      stateStore,
    });
    await runtime.init();

    const first = await runtime.execute({
      runId: RUN_ID,
      requestId: 'agent-runner-first',
      subAgent: definition.name,
      executor: 'local-trusted',
      input: { prompt: 'alpha' },
    });
    const second = await runtime.execute({
      runId: RUN_ID,
      requestId: 'agent-runner-second',
      subAgent: definition.name,
      executor: 'local-trusted',
      input: { prompt: 'beta' },
    });

    expect(first).toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'proof-1' } },
    });
    expect(second).toMatchObject({
      type: 'terminal',
      result: { status: 'succeeded', output: { answer: 'proof-2' } },
    });
    expect(invocations.map(({ instance }) => instance)).toEqual([1, 2]);
    expect(invocations[0]?.options).toMatchObject({
      runnerId: 'agent-reviewer-runner',
      runnerVersion: '2.0.0',
      executorName: 'local-trusted',
      checkpointMode: 'durable',
      input: { content: [{ type: 'text', text: 'review:alpha' }] },
    });
    expect(invocations[0]?.options.outputSchema).toBe(definition.outputSchema);
    expect(invocations[0]?.options.request.taskId).not.toBe(invocations[1]?.options.request.taskId);
    if (first.type !== 'terminal') throw new Error('expected first terminal child outcome');
    await expect(stateStore.loadTask(SESSION_ID, first.result.task.taskId)).resolves.toMatchObject({
      binding: {
        executorName: 'local-trusted',
        runnerId: 'agent-reviewer-runner',
        runnerVersion: '2.0.0',
        definitionName: definition.name,
        definitionVersion: definition.version,
      },
    });
  });

  it('requires an explicit protocol input mapper and a valid Agent bridge', async () => {
    expect(() =>
      createLocalAgentRunnerRegistration({
        definition,
        runnerId: 'invalid-runner',
        runnerVersion: '1',
        createAgent: () => ({ runAsSubAgent: undefined }) as never,
      } as never),
    ).toThrow('incomplete');

    const registry = new LocalSubAgentRunnerRegistry([
      createLocalAgentRunnerRegistration({
        definition,
        runnerId: 'broken-agent-runner',
        runnerVersion: '1',
        createAgent: () => ({}) as never,
        buildInput: () => 'input',
      }),
    ]);
    const request = childRequest();
    await expect(registry.create(request, 'local')).rejects.toThrow('fresh Agent run bridge');

    const sharedAgent: LocalSubAgentAgent<OpenAIChatProtocol> = {
      async runAsSubAgent(options) {
        return terminalOutcome(options, { answer: 'shared' });
      },
    };
    const sharedRegistry = new LocalSubAgentRunnerRegistry([
      createLocalAgentRunnerRegistration({
        definition,
        runnerId: 'shared-agent-runner',
        runnerVersion: '1',
        createAgent: () => sharedAgent,
        buildInput: () => 'input',
      }),
    ]);
    await sharedRegistry.create(request, 'local');
    await expect(
      sharedRegistry.create(
        {
          ...request,
          taskId: 'task-agent-runner-second',
          subagentSessionId: 'subagent-session-agent-runner-second',
          path: Object.freeze(['task-agent-runner-second']),
        },
        'local',
      ),
    ).rejects.toThrow('fresh Agent');
  });

  it('keeps task identity fixed while accepting a new attempt and epoch on approval resume', async () => {
    let seenEpoch = '';
    const registry = new LocalSubAgentRunnerRegistry([
      createLocalAgentRunnerRegistration({
        definition,
        runnerId: 'resume-agent-runner',
        runnerVersion: '1',
        createAgent: (): LocalSubAgentAgent<OpenAIChatProtocol> => ({
          async runAsSubAgent(options) {
            seenEpoch = options.request.executionEpoch;
            return terminalOutcome(options, { answer: 'resumed' });
          },
        }),
        buildInput: () => 'resume',
      }),
    ]);
    const original = childRequest();
    const runner = await registry.create(original, 'local');
    const resumedRequest = {
      ...original,
      attempt: 2,
      executionEpoch: 'epoch-agent-runner-resumed',
      executionFencingToken: '2',
      delegation: {
        ...original.delegation,
        catalogRevision: 2,
        definitions: Object.freeze([
          {
            name: 'nested-reviewer',
            version: '1',
            executors: Object.freeze(['local']),
          },
        ]),
      },
      limits: { ...original.limits, timeoutMs: original.limits.timeoutMs - 1_000 },
    };
    await runner.run(resumedRequest, {} as never);

    expect(seenEpoch).toBe('epoch-agent-runner-resumed');
    await expect(
      runner.run(
        {
          ...resumedRequest,
          attempt: 3,
          executionEpoch: 'epoch-agent-runner-rebound',
          executionFencingToken: '3',
          limits: { ...resumedRequest.limits, timeoutMs: resumedRequest.limits.timeoutMs - 1_000 },
          input: { prompt: 'changed input' },
        },
        {} as never,
      ),
    ).rejects.toThrow('cannot be rebound');
    await expect(
      runner.run(
        {
          ...resumedRequest,
          attempt: 3,
          limits: { ...resumedRequest.limits, timeoutMs: resumedRequest.limits.timeoutMs - 1_000 },
        },
        {} as never,
      ),
    ).rejects.toThrow('stale or rebound');
    await expect(
      runner.run(
        {
          ...resumedRequest,
          attempt: 3,
          executionEpoch: 'epoch-agent-runner-limits-rebound',
          executionFencingToken: '3',
          limits: {
            ...resumedRequest.limits,
            timeoutMs: resumedRequest.limits.timeoutMs - 1_000,
            maxProviderCalls: resumedRequest.limits.maxProviderCalls + 1,
          },
        },
        {} as never,
      ),
    ).rejects.toThrow('cannot be rebound');
    await expect(
      runner.run(
        {
          ...resumedRequest,
          attempt: 3,
          executionEpoch: 'epoch-agent-runner-timeout-rebound',
          executionFencingToken: '3',
          limits: { ...resumedRequest.limits, timeoutMs: original.limits.timeoutMs },
        },
        {} as never,
      ),
    ).rejects.toThrow('stale or rebound');
  });

  it('recreates a fresh Agent and forwards the complete checkpoint after Executor loss', async () => {
    const stateStore = new MemoryAgentRuntimeStateStore();
    await stateStore.createRun(createRun());
    let instances = 0;
    const restored: unknown[] = [];
    const registration = createLocalAgentRunnerRegistration({
      definition,
      runnerId: 'recoverable-agent-runner',
      runnerVersion: '1',
      createAgent: (): LocalSubAgentAgent<OpenAIChatProtocol> => {
        const instance = ++instances;
        return {
          async runAsSubAgent(options) {
            restored.push(options.request.checkpoint);
            const directive = await options.control.authorizeTool(
              `agent-bridge-approval-${instance}`,
              {
                callId: 'agent-bridge-sensitive-call',
                toolName: 'agent-bridge-sensitive-tool',
                summary: 'Approve the reconstructed Agent bridge.',
              },
              options.request.checkpoint ?? childCheckpoint(),
            );
            if (directive.type === 'suspend') {
              return {
                type: 'paused' as const,
                reason: 'approval' as const,
                task: {
                  taskId: options.request.taskId,
                  subAgent: options.request.definition,
                },
                approvals: [directive.request],
                checkpointRevision: directive.checkpointRevision,
              };
            }
            const output = { answer: 'checkpoint-restored' };
            await options.control.completion.submitResult('agent-bridge-result', output);
            await options.control.completion.complete('agent-bridge-end', {
              isStandalone: true,
            });
            return terminalOutcome(options, output);
          },
        };
      },
      buildInput: ({ input }) => `recover:${input.prompt}`,
    });
    const first = await createRuntimeWithRegistration(stateStore, registration);
    const paused = await first.execute({
      runId: RUN_ID,
      requestId: 'agent-bridge-recovery',
      subAgent: definition.name,
      executor: 'local',
      input: { prompt: 'recover me' },
    });
    if (paused.type !== 'paused') throw new Error('expected approval pause');
    const replacement = await createRuntimeWithRegistration(stateStore, registration);
    const approval = paused.approvals[0]!;

    const resumed = await replacement.resume(SESSION_ID, paused.task.taskId, {
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
      result: { status: 'succeeded', output: { answer: 'checkpoint-restored' } },
    });
    expect(instances).toBe(2);
    expect(restored).toEqual([
      undefined,
      {
        ...childCheckpoint(),
        pendingBatch: {
          ...childCheckpoint().pendingBatch,
          calls: [
            {
              ...childCheckpoint().pendingBatch.calls[0],
              status: 'waiting_approval',
              approvals: [approval.approvalId],
            },
          ],
        },
      },
    ]);
  });

  it('runs the real child Agent approval and typed result lifecycle across reconstruction', async () => {
    const stateStore = new MemoryAgentRuntimeStateStore();
    await stateStore.createRun(createRun());
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        chatToolResponse('sensitive-call', 'sensitive-proof', { value: 'alpha' }),
      )
      .mockResolvedValueOnce(
        chatToolResponse('typed-result-call', 'agent-result', {
          result: { answer: 'approved-proof' },
        }),
      )
      .mockResolvedValueOnce(chatToolResponse('child-end-call', 'end-agent', {}));
    const handler = vi.fn((parameters: unknown, runtime: unknown) => {
      void parameters;
      void runtime;
      return 'approved-handler-proof';
    });
    let instances = 0;
    const registration = createLocalAgentRunnerRegistration({
      definition,
      runnerId: 'real-agent-runner',
      runnerVersion: '1',
      createAgent: (): LocalSubAgentAgent<OpenAIChatProtocol> => {
        instances += 1;
        const child = new Agent<OpenAIChatProtocol>({
          llm: new OpenAIChatModel({
            model: 'local-agent-fixture',
            client: { chat: { completions: { create: generate } } } as never,
          }),
          maxIterations: 4,
        });
        child.tools.push({
          name: 'sensitive-proof',
          description: 'Execute one deterministic approval-gated proof.',
          parameters: z.object({ value: z.string() }),
          approval: {
            summary: 'Approve the deterministic child proof.',
            expiresInMs: 60_000,
          },
          handler,
        });
        return child;
      },
      buildInput: ({ input }) => `prove:${input.prompt}`,
    });
    const first = await createRuntimeWithRegistration(stateStore, registration);
    const paused = await first.execute({
      runId: RUN_ID,
      requestId: 'real-agent-approval',
      subAgent: definition.name,
      executor: 'local',
      input: { prompt: 'approval lifecycle' },
    });

    expect(paused).toMatchObject({
      type: 'paused',
      reason: 'approval',
      approvals: [
        {
          callId: 'sensitive-call',
          toolName: 'sensitive-proof',
          summary: 'Approve the deterministic child proof.',
        },
      ],
    });
    expect(handler).not.toHaveBeenCalled();
    expect(instances).toBe(1);
    expect(requestToolNames(generate.mock.calls[0]?.[0])).toEqual(
      expect.arrayContaining(['sensitive-proof', 'agent-result', 'end-agent']),
    );
    if (paused.type !== 'paused') throw new Error('expected approval pause');
    const approval = paused.approvals[0]!;
    await expect(stateStore.loadTask(SESSION_ID, paused.task.taskId)).resolves.toMatchObject({
      state: 'waiting_approval',
      childCheckpoint: {
        runnerId: 'real-agent-runner',
        runnerVersion: '1',
        pendingBatch: {
          calls: [
            {
              callId: 'sensitive-call',
              name: 'sensitive-proof',
              status: 'waiting_approval',
              approvals: [approval.approvalId],
            },
          ],
        },
      },
    });

    const replacement = await createRuntimeWithRegistration(stateStore, registration);
    const resumed = await replacement.resume(SESSION_ID, paused.task.taskId, {
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
      result: {
        status: 'succeeded',
        executor: 'local',
        output: { answer: 'approved-proof' },
      },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      { value: 'alpha' },
      expect.objectContaining({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        taskId: paused.task.taskId,
        call: expect.objectContaining({ id: 'sensitive-call', name: 'sensitive-proof' }),
      }),
    );
    expect(instances).toBe(2);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls[1]?.[0]).toMatchObject({
      messages: expect.arrayContaining([
        {
          role: 'tool',
          tool_call_id: 'sensitive-call',
          content: 'approved-handler-proof',
        },
      ]),
    });
    await expect(stateStore.loadTask(SESSION_ID, paused.task.taskId)).resolves.toMatchObject({
      state: 'succeeded',
      binding: {
        executorName: 'local',
        runnerId: 'real-agent-runner',
        runnerVersion: '1',
      },
      result: {
        status: 'succeeded',
        executor: 'local',
        output: { answer: 'approved-proof' },
      },
    });
  });
});

function terminalOutcome(
  options: AgentSubAgentRunOptions<OpenAIChatProtocol>,
  output: JsonValue,
): SubAgentExecutionOutcome {
  return {
    type: 'terminal',
    result: {
      status: 'succeeded',
      task: {
        taskId: options.request.taskId,
        subAgent: options.request.definition,
      },
      executor: options.executorName,
      output,
    },
  };
}

function childRequest() {
  const controller = new AbortController();
  return {
    ownerSessionId: SESSION_ID,
    runId: RUN_ID,
    taskId: 'task-agent-runner',
    subagentSessionId: 'subagent-session-agent-runner',
    path: Object.freeze(['task-agent-runner']),
    attempt: 1,
    executionEpoch: 'epoch-agent-runner',
    executionFencingToken: '1',
    definition: { name: definition.name, version: definition.version },
    input: { prompt: 'alpha' },
    projectedContext: Object.freeze([]),
    delegation: {
      version: '1' as const,
      ownerSessionId: SESSION_ID,
      runId: RUN_ID,
      parentTaskId: 'task-agent-runner',
      path: Object.freeze(['task-agent-runner']),
      depth: 1,
      catalogRevision: 1,
      definitions: Object.freeze([]),
    },
    limits: {
      maxDepth: 3,
      maxDescendants: 32,
      maxConcurrent: 4,
      maxTurns: 16,
      timeoutMs: 120_000,
      maxProviderCalls: 24,
      maxInputTokens: 64_000,
      maxOutputTokens: 8_000,
      maxCost: 10,
    },
    signal: controller.signal,
    deadlineAt: Date.now() + 120_000,
  };
}

function childCheckpoint() {
  const input = {};
  return {
    version: '1' as const,
    runnerId: 'recoverable-agent-runner',
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
    maxIterations: 8,
    pendingBatch: {
      version: '1' as const,
      batchId: 'batch-agent-bridge-sensitive-call',
      assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
      calls: [
        {
          version: '1' as const,
          operationId: 'operation-agent-bridge-sensitive-call',
          kind: 'tool' as const,
          callId: 'agent-bridge-sensitive-call',
          name: 'agent-bridge-sensitive-tool',
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

async function createRuntimeWithRegistration(
  stateStore: MemoryAgentRuntimeStateStore,
  registration: ReturnType<typeof createLocalAgentRunnerRegistration>,
) {
  const executor = new MemorySubAgentExecutor({
    registry: new LocalSubAgentRunnerRegistry([registration]),
  });
  const runtime = createSubAgentRuntime({
    sessionId: SESSION_ID,
    activeDefinitions: [definition as unknown as SubAgentDefinitionRegistration],
    executors: [executor],
    stateStore,
  });
  await runtime.init();
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

function requestToolNames(request: unknown): string[] {
  if (typeof request !== 'object' || request === null || !('tools' in request)) return [];
  const tools = (request as { readonly tools?: readonly unknown[] }).tools ?? [];
  return tools.flatMap((tool) => {
    if (typeof tool !== 'object' || tool === null || !('function' in tool)) return [];
    const fn = (tool as { readonly function?: { readonly name?: unknown } }).function;
    return typeof fn?.name === 'string' ? [fn.name] : [];
  });
}
