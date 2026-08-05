import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { Agent } from '../src';
import type { ToolCallErrorTrigger, ToolRuntimeDefinition } from '../src';
import {
  assistant,
  endResponse,
  MockModel,
  parsedCall,
  readToolOutput,
  response,
  toolCall,
  type TestContext,
  type TestProtocol,
} from './helpers/mock-models';

function runtimeTool(
  name: string,
  handler: ToolRuntimeDefinition['handler'],
  parameters: ToolRuntimeDefinition['parameters'] = z.object({}),
): ToolRuntimeDefinition {
  return {
    name,
    description: `${name} fixture`,
    parameters,
    handler,
  };
}

describe('Agent context and event regressions', () => {
  it('keeps independent raw/active seeds and returns shallow array copies', () => {
    const activeMessage = { kind: 'user', content: 'active' } as const;
    const rawMessage = { kind: 'user', content: 'raw' } as const;
    const initContext: TestContext[] = [activeMessage];
    const initRawContext: TestContext[] = [rawMessage];
    const agent = new Agent<TestProtocol>({
      llm: new MockModel(),
      initContext,
      initRawContext,
    });

    initContext.push({ kind: 'user', content: 'late active mutation' });
    initRawContext.push({ kind: 'user', content: 'late raw mutation' });

    const activeView = agent.getContext();
    const rawView = agent.getHistory();
    expect(activeView).toEqual([activeMessage]);
    expect(rawView).toEqual([rawMessage]);
    expect(activeView[0]).toBe(activeMessage);
    expect(rawView[0]).toBe(rawMessage);

    (activeView as TestContext[]).push({ kind: 'user', content: 'view only' });
    (rawView as TestContext[]).pop();
    expect(agent.getContext()).toEqual([activeMessage]);
    expect(agent.getHistory()).toEqual([rawMessage]);
  });

  it.each([
    ['initContext', { initContext: [{ kind: 'user', content: 'active seed' }] }],
    ['initRawContext', { initRawContext: [{ kind: 'user', content: 'raw seed' }] }],
  ] as const)(
    'uses %s as the fallback projection when only one seed is supplied',
    (_name, seed) => {
      const agent = new Agent<TestProtocol>({ llm: new MockModel(), ...seed });

      expect(agent.getContext()).toEqual(agent.getHistory());
      expect(agent.getContext()).not.toBe(agent.getHistory());
      expect(agent.getContext()[0]).toBe(agent.getHistory()[0]);
    },
  );

  it('emits model, before, handler, result, and after stages in order', async () => {
    const model = new MockModel([
      response(assistant('calling', [toolCall('echo-1', 'echo', '{"value":"hello"}')])),
      endResponse(),
    ]);
    const agent = new Agent<TestProtocol>({ llm: model });
    const events: string[] = [];

    agent.tools.push(
      runtimeTool(
        'echo',
        (parameters) => {
          events.push('handler');
          return (parameters as { value: string }).value;
        },
        z.object({ value: z.string() }),
      ),
    );
    agent.onModelResponse((messages) => {
      const first = messages[0];
      events.push(
        first?.kind === 'assistant' && first.calls?.[0]?.function.name === 'echo'
          ? 'model'
          : 'end-model',
      );
      expect(agent.getContext()).not.toContain(first);
    });
    agent.onBeforeToolCall(
      'echo',
      () => {
        events.push('before');
      },
      { await: true },
    );
    agent.onAfterToolCall(
      'echo',
      () => {
        const latest = agent.getContext().at(-1);
        expect(latest?.kind).toBe('tool');
        events.push('after');
      },
      { await: true },
    );
    agent.init();

    await agent.agent('start');

    expect(events).toEqual(['model', 'before', 'handler', 'after', 'end-model']);
  });
});

describe('Agent tool execution regressions', () => {
  it('clears a standalone pending end request when result message construction fails', async () => {
    class FailingToolOutputModel extends MockModel {
      failNextOutput = true;

      override buildToolCallOutputMessage(
        input: Parameters<MockModel['buildToolCallOutputMessage']>[0],
      ): TestContext {
        if (this.failNextOutput) {
          this.failNextOutput = false;
          throw new Error('tool output construction failed');
        }

        return super.buildToolCallOutputMessage(input);
      }
    }

    const model = new FailingToolOutputModel();
    const agent = new Agent<TestProtocol>({ llm: model });
    const ended = vi.fn();
    agent.tools.push(runtimeTool('ordinary', () => 'ordinary result'));
    agent.onAgentStatusChanged('ended', ended);
    agent.init();

    await expect(agent.toolCall(parsedCall('failed-end', 'end-agent'))).rejects.toThrow(
      'tool output construction failed',
    );
    await agent.toolCall(parsedCall('ordinary-call', 'ordinary'));
    expect(ended).not.toHaveBeenCalled();

    await agent.toolCall(parsedCall('successful-end', 'end-agent'));
    expect(ended).toHaveBeenCalledOnce();
  });

  it('turns every tool failure stage into observable error/result behavior', async () => {
    const model = new MockModel();
    const agent = new Agent<TestProtocol>({ llm: model });
    const canceledHandler = vi.fn();
    const errors: Array<{
      name: string;
      trigger: ToolCallErrorTrigger;
      parameters: unknown;
      result?: unknown;
    }> = [];

    agent.tools.push(
      runtimeTool(
        'validated',
        (parameters) => (parameters as { value: string }).value,
        z.object({ value: z.string() }),
      ),
      runtimeTool('canceled', canceledHandler),
      runtimeTool('throws', () => {
        throw new Error('handler exploded');
      }),
      runtimeTool('after-error', () => 'handler succeeded'),
    );
    agent.onBeforeToolCall(
      'canceled',
      () => {
        throw new Error('before rejected');
      },
      { await: true, errorCancel: true },
    );
    agent.onAfterToolCall(
      'after-error',
      () => {
        throw new Error('after rejected');
      },
      { await: true },
    );
    agent.onToolCallError((name, trigger, _error, parameters, _call, result) => {
      errors.push({ name, trigger, parameters, ...(result === undefined ? {} : { result }) });
    });
    agent.init();

    const unknown = await agent.toolCall(parsedCall('unknown-1', 'missing'));
    const invalidJson = await agent.toolCall(parsedCall('json-1', 'validated', '{'));
    const invalidSchema = await agent.toolCall(parsedCall('schema-1', 'validated', '{"value":1}'));
    const canceled = await agent.toolCall(parsedCall('cancel-1', 'canceled'));
    const thrown = await agent.toolCall(parsedCall('throw-1', 'throws'));
    const afterError = await agent.toolCall(parsedCall('after-1', 'after-error'));

    expect(readToolOutput(unknown)).toContain('Unknown tool: missing');
    expect(readToolOutput(invalidJson)).toMatch(/JSON|position|property name/iu);
    expect(readToolOutput(invalidSchema)).toContain('value');
    expect(readToolOutput(canceled)).toContain('before rejected');
    expect(readToolOutput(thrown)).toBe('handler exploded');
    expect(readToolOutput(afterError)).toBe('handler succeeded');
    expect(canceledHandler).not.toHaveBeenCalled();
    expect(errors.map(({ name, trigger }) => `${name}:${trigger}`)).toEqual([
      'missing:calling',
      'validated:calling',
      'validated:calling',
      'canceled:before',
      'throws:calling',
      'after-error:after',
    ]);
    expect(errors.at(-1)).toMatchObject({
      name: 'after-error',
      trigger: 'after',
      parameters: {},
      result: 'handler succeeded',
    });
  });

  it('executes multiple calls sequentially and preserves message ordering', async () => {
    const model = new MockModel([
      response(
        assistant('two calls', [
          toolCall('first-1', 'first', '{"order":1}'),
          toolCall('second-1', 'second', '{"order":2}'),
        ]),
      ),
      endResponse(),
    ]);
    const agent = new Agent<TestProtocol>({ llm: model });
    const executionOrder: string[] = [];

    agent.tools.push(
      runtimeTool(
        'first',
        (parameters) => {
          const { order } = parameters as { order: number };
          executionOrder.push(`first:${order}`);
          return 'first result';
        },
        z.object({ order: z.number() }),
      ),
      runtimeTool(
        'second',
        (parameters) => {
          const { order } = parameters as { order: number };
          executionOrder.push(`second:${order}`);
          return { result: 'second result' };
        },
        z.object({ order: z.number() }),
      ),
    );
    agent.init();

    const active = await agent.agent('start');

    expect(executionOrder).toEqual(['first:1', 'second:2']);
    expect(active.map((message) => message.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
      'tool',
    ]);
    expect(active.filter((message) => message.kind === 'tool').map(readToolOutput)).toEqual([
      'first result',
      '{"result":"second result"}',
      'Agent 已结束。',
    ]);
    expect(agent.getHistory()).toEqual(active);

    const secondRequestPersistentContext = model.requests[1]?.context.filter(
      (message) => message.kind !== 'system',
    );
    expect(secondRequestPersistentContext?.map((message) => message.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
  });

  it('does not invoke loop payload compactors for standalone toolCall()', async () => {
    const inputCompactor = vi.fn(() => 'compact input');
    const resultCompactor = vi.fn(() => 'compact result');
    const longValue = 'x'.repeat(20_000);
    const handler = vi.fn((parameters: unknown) => (parameters as { value: string }).value);
    const agent = new Agent<TestProtocol>({
      llm: new MockModel(),
      contextCompact: {
        toolInput: inputCompactor,
        toolResult: resultCompactor,
      },
    });
    agent.tools.push(runtimeTool('standalone', handler, z.object({ value: z.string() })));
    agent.init();

    const result = await agent.toolCall(
      parsedCall('standalone-1', 'standalone', JSON.stringify({ value: longValue })),
    );

    expect(handler).toHaveBeenCalledWith({ value: longValue });
    expect(readToolOutput(result)).toBe(longValue);
    expect(inputCompactor).not.toHaveBeenCalled();
    expect(resultCompactor).not.toHaveBeenCalled();
    expect(agent.getHistory()).toEqual([result]);
    expect(agent.getContext()).toEqual([result]);
  });
});

describe('Agent retry and concurrency regressions', () => {
  it('keeps empty successful responses on an independent four-attempt budget', async () => {
    const model = new MockModel([response(), response(), response(), response()]);
    const agent = new Agent<TestProtocol>({ llm: model });
    const failed = vi.fn();
    agent.onAgentStatusChanged('failed', failed);
    agent.init();

    await expect(agent.agent('empty')).rejects.toThrow('after 4 attempt(s)');

    expect(model.requests).toHaveLength(4);
    expect(model.requests.every((request) => !('purpose' in request))).toBe(true);
    expect(failed).toHaveBeenCalledOnce();
    expect(agent.getHistory()).toEqual([{ kind: 'user', content: 'empty' }]);
  });

  it('isolates concurrently running instances and rejects re-entry on one instance', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstModel = new MockModel([
      async () => {
        await firstGate;
        return endResponse('first-end');
      },
    ]);
    const secondModel = new MockModel([endResponse('second-end')]);
    const firstAgent = new Agent<TestProtocol>({ llm: firstModel }).init();
    const secondAgent = new Agent<TestProtocol>({ llm: secondModel }).init();

    const firstRun = firstAgent.agent('first input');
    const secondRun = secondAgent.agent('second input');

    await expect(firstAgent.agent('must not append')).rejects.toThrow('already running');
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);

    expect(firstResult[0]).toEqual({ kind: 'user', content: 'first input' });
    expect(secondResult[0]).toEqual({ kind: 'user', content: 'second input' });
    expect(firstAgent.getHistory()).not.toContainEqual({
      kind: 'user',
      content: 'must not append',
    });
    expect(firstModel.requests).toHaveLength(1);
    expect(secondModel.requests).toHaveLength(1);
  });
});
