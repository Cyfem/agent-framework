import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  createSubAgentRuntime,
  defineSubAgent,
  OpenAIChatModel,
  type JsonValue,
  type OpenAIChatProtocol,
} from '@ruixutong.manee/maneeagent-framework';

import {
  createLocalAgentRunnerRegistration,
  LocalSubAgentRunnerRegistry,
  MemoryAgentRuntimeStateStore,
  MemorySubAgentExecutor,
} from '../src';
import { createRun, RUN_ID, SESSION_ID } from './fixtures';

const definition = defineSubAgent({
  name: 'terminal-ordering-proof',
  version: '2',
  description: 'Prove that child success is committed only after loop finalization.',
  inputSchema: z.object({ prompt: z.string() }).strict(),
  outputSchema: z.object({ answer: z.string() }).strict(),
});

describe('Local child terminal commit ordering', () => {
  it('keeps the typed result as partial output when end-agent compaction fails', async () => {
    const stateStore = new MemoryAgentRuntimeStateStore();
    await stateStore.createRun(createRun());
    const provider = vi
      .fn()
      .mockResolvedValueOnce(
        chatToolResponse('typed-result-call', 'agent-result', {
          result: { answer: 'durable-partial-proof' },
        }),
      )
      .mockResolvedValueOnce(chatToolResponse('child-end-call', 'end-agent', {}));
    const endCompactor = vi.fn((value: string, info: { call: { name: string } }) => {
      if (info.call.name === 'end-agent') throw new Error('end compact failpoint');
      return value;
    });
    const registration = createLocalAgentRunnerRegistration({
      definition,
      runnerId: 'terminal-ordering-runner',
      runnerVersion: '2.0.0',
      createAgent() {
        return new Agent<OpenAIChatProtocol>({
          llm: new OpenAIChatModel({
            model: 'offline-terminal-ordering',
            client: { chat: { completions: { create: provider } } } as never,
          }),
          maxIterations: 3,
          contextCompact: {
            toolInput: false,
            toolResult: endCompactor,
          },
        });
      },
      buildInput: ({ input }) => `prove:${input.prompt}`,
    });
    const runtime = createSubAgentRuntime({
      sessionId: SESSION_ID,
      activeDefinitions: [definition],
      executors: [
        new MemorySubAgentExecutor({
          registry: new LocalSubAgentRunnerRegistry([registration]),
        }),
      ],
      stateStore,
    });
    await runtime.init();

    const outcome = await runtime.execute({
      runId: RUN_ID,
      requestId: 'terminal-ordering-request',
      subAgent: definition.name,
      executor: 'local',
      input: { prompt: 'terminal ordering' },
    });

    expect(outcome).toMatchObject({
      type: 'terminal',
      result: {
        status: 'failed',
        error: { code: 'EXECUTOR_FAILED' },
        partialOutput: { answer: 'durable-partial-proof' },
      },
    });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(endCompactor).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ call: expect.objectContaining({ name: 'end-agent' }) }),
    );
    if (outcome.type !== 'terminal') throw new Error('expected a terminal child outcome');
    const taskId = outcome.result.task.taskId;
    await expect(stateStore.loadTask(SESSION_ID, taskId)).resolves.toMatchObject({
      state: 'failed',
      resultReceipt: {
        callId: 'typed-result-call',
      },
      result: {
        status: 'failed',
        partialOutput: { answer: 'durable-partial-proof' },
      },
    });
    const events = await stateStore.readEvents(SESSION_ID, taskId);
    expect(events.map(({ type }) => type)).toEqual(
      expect.arrayContaining(['task.result_submitted', 'task.failed']),
    );
    expect(events.map(({ type }) => type)).not.toContain('task.succeeded');
  });
});

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
