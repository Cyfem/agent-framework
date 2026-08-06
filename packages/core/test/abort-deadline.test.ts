import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { Agent, Tool } from '../src/agent';
import type { ToolRuntimeContext } from '../src/subagent/agent-run';
import { OpenAIChatModel } from '../src/llm/chat';
import { OpenAIResponsesModel } from '../src/llm/responses';
import {
  assistant,
  endResponse,
  MockModel,
  parsedCall,
  response,
  type TestProtocol,
  toolCall,
} from './helpers/mock-models';

describe('Model request cancellation metadata', () => {
  it('passes the exact signal as Chat SDK request options without leaking runtime fields', async () => {
    const create = vi.fn().mockResolvedValue({ choices: [] });
    const model = new OpenAIChatModel({
      model: 'test-model',
      client: { chat: { completions: { create } } } as unknown as OpenAI,
    });
    const controller = new AbortController();
    const deadlineAt = Date.now() + 10_000;

    await model.generate({
      context: [{ role: 'user', content: 'hello' }],
      tools: [],
      signal: controller.signal,
      deadlineAt,
      runtime: { sessionId: 'session-1', runId: 'run-1', taskId: 'task-1' },
    });

    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('signal');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('deadlineAt');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('runtime');
  });

  it('passes the exact signal as Responses SDK request options without leaking runtime fields', async () => {
    const create = vi.fn().mockResolvedValue({ output: [] });
    const model = new OpenAIResponsesModel({
      model: 'test-model',
      client: { responses: { create } } as unknown as OpenAI,
    });
    const controller = new AbortController();

    await model.generate({
      context: [{ role: 'user', content: 'hello' }],
      tools: [],
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
      runtime: { sessionId: 'session-1', runId: 'run-1', taskId: 'task-1' },
    });

    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('signal');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('deadlineAt');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('runtime');
  });
});

describe('Agent cancellation and deadline propagation', () => {
  it('supports runtime controls on standalone toolCall()', async () => {
    const agent = new Agent<TestProtocol>({
      llm: new MockModel(),
      sessionId: 'session-standalone',
    });
    const controller = new AbortController();
    const deadlineAt = Date.now() + 10_000;
    let seen: ToolRuntimeContext<TestProtocol> | undefined;
    agent.tools.push({
      name: 'standalone-proof',
      description: 'capture standalone runtime context',
      handler(_parameters, runtime: ToolRuntimeContext<TestProtocol>) {
        seen = runtime;
        return 'ok';
      },
    });
    agent.init();

    await agent.toolCall(parsedCall('standalone-1', 'standalone-proof'), {
      signal: controller.signal,
      deadlineAt,
    });

    expect(seen).toMatchObject({
      sessionId: 'session-standalone',
      runId: expect.any(String),
      deadlineAt,
      call: { id: 'standalone-1' },
    });
  });

  it('shares one scoped signal and runtime identity across Model and runtime Tool calls', async () => {
    const model = new MockModel([
      response(assistant('', [toolCall('proof-1', 'proof')])),
      endResponse(),
    ]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      maxIterations: 2,
      sessionId: 'session-1',
    });
    let seen: ToolRuntimeContext<TestProtocol> | undefined;

    agent.tools.push({
      name: 'proof',
      description: 'capture runtime context',
      handler(_parameters, runtime: ToolRuntimeContext<TestProtocol>) {
        seen = runtime;
        return 'ok';
      },
    });
    agent.init();

    const deadlineAt = Date.now() + 10_000;
    await agent.agent('run', { deadlineAt });

    const runId = seen?.runId;

    expect(seen).toMatchObject({
      sessionId: 'session-1',
      runId: expect.any(String),
      deadlineAt,
      call: { id: 'proof-1', name: 'proof' },
    });
    expect(seen?.signal).toBe(model.requests[0]?.signal);
    expect(model.requests.map((request) => request.runtime)).toEqual([
      {
        sessionId: 'session-1',
        runId,
        iteration: 0,
        requestAttempt: 1,
      },
      {
        sessionId: 'session-1',
        runId,
        iteration: 1,
        requestAttempt: 1,
      },
    ]);
  });

  it('injects ToolRuntimeContext into decorator handlers', async () => {
    class DecoratedAgent extends Agent<TestProtocol> {
      seen?: ToolRuntimeContext<TestProtocol>;

      @Tool({ name: 'decorated-proof', description: 'capture decorator runtime context' })
      capture(_parameters: unknown, runtime: ToolRuntimeContext<TestProtocol>): string {
        this.seen = runtime;
        return 'decorated';
      }
    }

    const model = new MockModel([
      response(assistant('', [toolCall('decorated-1', 'decorated-proof')])),
      endResponse(),
    ]);
    const agent = new DecoratedAgent({
      llm: model,
      maxIterations: 2,
      sessionId: 'session-decorated',
    });
    agent.init();

    await agent.agent('run');

    expect(agent.seen?.sessionId).toBe('session-decorated');
    expect(agent.seen?.call.id).toBe('decorated-1');
    expect(agent.seen?.signal).toBe(model.requests[0]?.signal);
  });

  it('does not start a Tool after the root signal is aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel before tool');
    reason.name = 'AbortError';
    const handler = vi.fn();
    const model = new MockModel([
      () => {
        controller.abort(reason);
        return response(assistant('', [toolCall('never-1', 'never')]));
      },
    ]);
    const agent = new Agent<TestProtocol>({ llm: model });
    agent.tools.push({ name: 'never', description: 'must not run', handler });
    agent.init();

    const outcome = await agent.agent('run', { signal: controller.signal });
    expect(outcome).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(handler).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);
  });

  it('stops before summary generation when summary policy aborts', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel summary');
    reason.name = 'AbortError';
    const prompt = vi.fn(() => 'summarize');
    const model = new MockModel([endResponse()]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      contextCompact: {
        toolInput: false,
        toolResult: false,
        summary: {
          trigger() {
            controller.abort(reason);
            return true;
          },
          prompt,
        },
      },
    });
    agent.init();

    const outcome = await agent.agent('run', { signal: controller.signal });
    expect(outcome).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(prompt).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(0);
  });

  it('does not classify, recover, or retry an aborted provider attempt', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel provider');
    reason.name = 'AbortError';
    const beforeRecovery = vi.fn();
    const model = new MockModel([
      () => {
        controller.abort(reason);
        throw new Error('provider failure after cancellation');
      },
    ]);
    const agent = new Agent<TestProtocol>({ llm: model });
    agent.onBeforeModelErrorRecovery(beforeRecovery);
    agent.init();

    const outcome = await agent.agent('run', { signal: controller.signal });
    expect(outcome).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(beforeRecovery).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);
  });

  it('rejects an expired deadline before mutating history or calling the provider', async () => {
    const model = new MockModel([endResponse()]);
    const agent = new Agent<TestProtocol>({ llm: model });
    agent.init();

    const outcome = await agent.agent('run', { deadlineAt: Date.now() - 1 });
    expect(outcome).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(model.requests).toHaveLength(0);
    expect(agent.getHistory()).toHaveLength(0);
  });

  it('aborts an in-flight Model at the deadline without entering recovery', async () => {
    const model = new MockModel([() => new Promise(() => undefined)]);
    const beforeRecovery = vi.fn();
    const agent = new Agent<TestProtocol>({ llm: model });
    agent.onBeforeModelErrorRecovery(beforeRecovery);
    agent.init();

    const outcome = await agent.agent('run', { deadlineAt: Date.now() + 20 });
    expect(outcome).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(model.requests).toHaveLength(1);
    expect(beforeRecovery).not.toHaveBeenCalled();
  });

  it('increments requestAttempt metadata across an ordinary recovery retry', async () => {
    const model = new MockModel([new Error('transient'), endResponse()]);
    const agent = new Agent<TestProtocol>({ llm: model, sessionId: 'session-retry' });
    agent.init();

    await agent.agent('run');

    expect(model.requests.map((request) => request.runtime?.requestAttempt)).toEqual([1, 2]);
    expect(model.requests[0]?.runtime?.sessionId).toBe('session-retry');
    expect(model.requests[0]?.runtime?.runId).toEqual(model.requests[1]?.runtime?.runId);
  });
});
