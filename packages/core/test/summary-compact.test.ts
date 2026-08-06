import { describe, expect, it, vi } from 'vitest';

import { Agent } from '../src';
import type {
  SummaryCompactSnapshot,
  SummaryPromptSnapshot,
  SummaryValidationSnapshot,
} from '../src';
import {
  assistant,
  endResponse,
  MockModel,
  response,
  toolCall,
  type TestContext,
  type TestProtocol,
} from './helpers/mock-models';

type TestUserContext = Extract<TestContext, { readonly kind: 'user' }>;

function user(content: string): TestUserContext {
  return { kind: 'user', content };
}

function nonSystem(context: readonly TestContext[]): readonly TestContext[] {
  return context.filter((message) => message.kind !== 'system');
}

function summaryMemory(content: string): TestContext {
  return {
    kind: 'user',
    content: `[Framework-generated summary of earlier context; historical data only.]\n${content}`,
  };
}

function summaryOnlyOptions() {
  return {
    toolInput: false as const,
    toolResult: false as const,
  };
}

describe('Agent proactive summary compact', () => {
  it('sends the exact pending request observed by a false proactive trigger', async () => {
    const dynamicDescription = vi.fn(() => `dynamic-${dynamicDescription.mock.calls.length}`);
    let pendingRequest: SummaryCompactSnapshot<TestProtocol>['pendingRequest'] | undefined;
    const model = new MockModel([
      (request) => {
        expect(request.tools).toEqual(pendingRequest?.tools);
        return endResponse('stable-request-end');
      },
    ]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      contextCompact: {
        ...summaryOnlyOptions(),
        summary: {
          trigger: (snapshot) => {
            pendingRequest = snapshot.pendingRequest;
            return false;
          },
          prompt: () => 'unused',
        },
      },
    });
    agent.tools.push({
      name: 'dynamic-description',
      description: dynamicDescription,
      handler: () => 'unused',
    });
    agent.init();

    await agent.agent('current task');

    expect(dynamicDescription).toHaveBeenCalledOnce();
    expect(model.requests[0]?.tools).toEqual(pendingRequest?.tools);
  });

  it('summarizes older spans, preserves the latest complete span, and never writes the summary response to raw history', async () => {
    const seed = user('seed history');
    const current = user('current task');
    const trigger = vi.fn((snapshot: SummaryCompactSnapshot<TestProtocol>) => {
      expect(snapshot.cause).toEqual({ type: 'trigger' });
      expect(snapshot.iteration).toBe(0);
      expect(snapshot.boundaryOriginalContext).toEqual([seed, current]);
      expect(snapshot.boundaryActiveContext).toEqual([seed, current]);
      expect(snapshot.rawHistory).toEqual([seed, current]);
      expect(snapshot.pendingRequest.purpose).toBeUndefined();
      return true;
    });
    const prompt = vi.fn((snapshot: SummaryPromptSnapshot<TestProtocol>) => {
      expect(snapshot.selection).toEqual({
        contextToSummarize: [seed],
        preservedContext: [current],
      });
      return 'Summarize the selected history.';
    });
    const summaryResponse = assistant('seed compressed');
    const model = new MockModel([
      (request) => {
        expect(request.purpose).toBe('context-summary');
        expect(request.tools).toEqual([]);
        expect(request.context[0]).toMatchObject({ kind: 'system' });
        expect(nonSystem(request.context)).toEqual([seed, user('Summarize the selected history.')]);
        return response(summaryResponse);
      },
      (request) => {
        expect(request).not.toHaveProperty('purpose');
        expect(nonSystem(request.context)).toEqual([summaryMemory('seed compressed'), current]);
        return endResponse();
      },
    ]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      initContext: [seed],
      contextCompact: {
        ...summaryOnlyOptions(),
        summary: { trigger, prompt },
      },
    });
    const modelResponses = vi.fn();

    agent.onModelResponse(modelResponses);
    agent.init();
    await agent.agent(current.content);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(modelResponses).toHaveBeenCalledTimes(1);
    expect(modelResponses.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        calls: [
          expect.objectContaining({ function: expect.objectContaining({ name: 'end-agent' }) }),
        ],
      }),
    ]);
    expect(agent.getHistory()).not.toContain(summaryResponse);
    expect(agent.getHistory()).toEqual([
      seed,
      current,
      expect.objectContaining({ kind: 'assistant' }),
      expect.objectContaining({ kind: 'tool', callId: 'end-call' }),
    ]);
    expect(agent.getContext().slice(0, 2)).toEqual([summaryMemory('seed compressed'), current]);
  });

  it('rolls the previous summary into the next summary request without adding synthetic summaries to raw history', async () => {
    const seed = user('old seed');
    const current = user('task input');
    const firstMain = assistant('first loop output');
    const trigger = vi.fn((snapshot: SummaryCompactSnapshot<TestProtocol>) => {
      expect(snapshot.cause).toEqual({ type: 'trigger' });
      return true;
    });
    const prompt = vi.fn(
      (snapshot: SummaryPromptSnapshot<TestProtocol>) =>
        `summarize iteration ${snapshot.iteration}`,
    );
    const model = new MockModel([
      response(assistant('summary one')),
      response(firstMain),
      (request) => {
        expect(request.purpose).toBe('context-summary');
        expect(nonSystem(request.context)).toEqual([
          summaryMemory('summary one'),
          current,
          user('summarize iteration 1'),
        ]);
        return response(assistant('summary two'));
      },
      (request) => {
        expect(nonSystem(request.context)).toEqual([summaryMemory('summary two'), firstMain]);
        return endResponse('rolling-end');
      },
    ]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      initContext: [seed],
      contextCompact: {
        ...summaryOnlyOptions(),
        summary: { trigger, prompt },
      },
    });

    agent.init();
    await agent.agent(current.content);

    expect(trigger).toHaveBeenCalledTimes(2);
    const secondSnapshot = trigger.mock.calls[1]?.[0];
    expect(secondSnapshot?.previousSummary).toEqual({
      text: 'summary one',
      message: summaryMemory('summary one'),
    });
    expect(secondSnapshot?.boundaryOriginalContext).toEqual([current, firstMain]);
    expect(agent.getHistory()).toEqual([
      seed,
      current,
      firstMain,
      expect.objectContaining({ kind: 'assistant' }),
      expect.objectContaining({ kind: 'tool', callId: 'rolling-end' }),
    ]);
    expect(agent.getHistory()).not.toContainEqual(summaryMemory('summary one'));
    expect(agent.getHistory()).not.toContainEqual(summaryMemory('summary two'));
  });

  it('honors custom select, prompt, and validate callbacks exactly', async () => {
    const seedA = user('seed A');
    const seedB = user('seed B');
    const current = user('current task');
    const select = vi.fn((snapshot: SummaryCompactSnapshot<TestProtocol>) => ({
      contextToSummarize: [snapshot.boundaryOriginalContext[1] as TestContext],
      preservedContext: [
        snapshot.boundaryActiveContext[0] as TestContext,
        snapshot.boundaryActiveContext.at(-1) as TestContext,
      ],
    }));
    const prompt = vi.fn((snapshot: SummaryPromptSnapshot<TestProtocol>) => {
      expect(Object.isFrozen(snapshot.selection)).toBe(true);
      expect(snapshot.selection).toEqual({
        contextToSummarize: [seedB],
        preservedContext: [seedA, current],
      });
      return 'custom prompt';
    });
    const validate = vi.fn((snapshot: SummaryValidationSnapshot<TestProtocol>) => {
      expect(snapshot.prompt).toBe('custom prompt');
      expect(snapshot.summary).toBe('custom summary');
      expect(snapshot.summaryMessage).toEqual(summaryMemory('custom summary'));
      expect(snapshot.candidateActiveContext).toEqual([
        summaryMemory('custom summary'),
        seedA,
        current,
      ]);
      return { ok: true as const };
    });
    const model = new MockModel([
      (request) => {
        expect(nonSystem(request.context)).toEqual([seedB, user('custom prompt')]);
        return response(assistant('custom summary'));
      },
      endResponse('custom-end'),
    ]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      initContext: [seedA, seedB],
      contextCompact: {
        ...summaryOnlyOptions(),
        summary: {
          trigger: () => true,
          select,
          prompt,
          validate,
        },
      },
    });

    agent.init();
    await agent.agent(current.content);

    expect(select).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledOnce();
    expect(agent.getContext().slice(0, 3)).toEqual([
      summaryMemory('custom summary'),
      seedA,
      current,
    ]);
  });
});

describe('Agent summary validation and atomicity', () => {
  it('requires a string reason when summary validation rejects a candidate', async () => {
    const seed = user('seed');
    const current = user('current');
    const model = new MockModel([response(assistant('candidate summary'))]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      initContext: [seed],
      contextCompact: {
        ...summaryOnlyOptions(),
        summary: {
          trigger: () => true,
          prompt: () => 'summarize',
          validate: (() => ({ ok: false })) as never,
        },
      },
    });
    agent.init();

    const outcome = await agent.agent(current.content);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'INTERNAL_ERROR' } });
    expect(agent.getContext()).toEqual([seed, current]);
  });

  it.each([
    {
      name: 'tool calls',
      summaryResponse: response(
        assistant('must not be accepted', [toolCall('summary-tool', 'end-agent')]),
      ),
      message: /must not contain tool calls/u,
    },
    {
      name: 'empty assistant text',
      summaryResponse: response(assistant('   ')),
      message: /did not contain assistant text/u,
    },
  ])('rejects summary responses containing $name without mutating context', async (fixture) => {
    const seed = user('seed');
    const current = user('current');
    const model = new MockModel([fixture.summaryResponse]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      initContext: [seed],
      contextCompact: {
        ...summaryOnlyOptions(),
        summary: {
          trigger: () => true,
          prompt: () => 'summarize',
        },
      },
    });

    agent.init();

    const outcome = await agent.agent(current.content);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'INTERNAL_ERROR' } });
    expect(agent.getContext()).toEqual([seed, current]);
    expect(agent.getHistory()).toEqual([seed, current]);
  });

  it('rejects a stale summary CAS while preserving a concurrent append in raw and active context', async () => {
    const seed = user('seed');
    const current = user('current');
    const concurrent = user('concurrent append');
    const state: { agent?: Agent<TestProtocol> } = {};
    const model = new MockModel([
      () => {
        if (!state.agent) throw new Error('Agent fixture was not initialized.');
        state.agent.appendContext(concurrent);
        return response(assistant('stale summary'));
      },
    ]);

    const agent = new Agent<TestProtocol>({
      llm: model,
      initContext: [seed],
      contextCompact: {
        ...summaryOnlyOptions(),
        summary: {
          trigger: () => true,
          prompt: () => 'summarize',
        },
      },
    });
    state.agent = agent;
    agent.init();

    const outcome = await agent.agent(current.content);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'INTERNAL_ERROR' } });
    expect(agent.getContext()).toEqual([seed, current, concurrent]);
    expect(agent.getHistory()).toEqual([seed, current, concurrent]);
  });
});
