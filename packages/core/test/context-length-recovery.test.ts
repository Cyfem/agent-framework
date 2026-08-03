import { describe, expect, it, vi } from 'vitest';

import { Agent, ModelErrorRecoveryError } from '../src';
import type {
  AfterModelErrorRecoveryEvent,
  BeforeModelErrorRecoveryEvent,
  ModelErrorDescriptor,
  SummaryCompactSnapshot,
  SummaryPromptSnapshot,
} from '../src';
import {
  assistant,
  endResponse,
  MockModel,
  response,
  type MockGenerateEntry,
  type TestContext,
  type TestProtocol,
} from './helpers/mock-models';

class ContextLengthFixtureError extends Error {}

class ClassifiedMockModel extends MockModel {
  constructor(entries: MockGenerateEntry[] = []) {
    super(entries);
  }

  override classifyError(error: unknown): ModelErrorDescriptor {
    if (error instanceof ContextLengthFixtureError) {
      return {
        kind: 'context_length_exceeded',
        message: error.message,
        provider: 'fixture',
        providerCode: 'context_length_exceeded',
        status: 400,
        requestId: `request-${error.message}`,
      };
    }

    return {
      kind: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      provider: 'fixture',
    };
  }
}

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

function summaryPolicy(overrides?: {
  trigger?: (snapshot: SummaryCompactSnapshot<TestProtocol>) => boolean;
  select?: (snapshot: SummaryCompactSnapshot<TestProtocol>) => {
    contextToSummarize: readonly TestContext[];
    preservedContext: readonly TestContext[];
  };
  prompt?: (snapshot: SummaryPromptSnapshot<TestProtocol>) => string;
}) {
  return {
    trigger: overrides?.trigger ?? (() => false),
    ...(overrides?.select === undefined ? {} : { select: overrides.select }),
    prompt: overrides?.prompt ?? (() => 'Summarize context after the provider overflow.'),
  };
}

async function captureRecoveryError(promise: Promise<unknown>): Promise<ModelErrorRecoveryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelErrorRecoveryError);
    return error as ModelErrorRecoveryError;
  }

  throw new Error('Expected ModelErrorRecoveryError.');
}

describe('Agent context-length recovery integration', () => {
  it('summarizes the entire boundary in emergency mode, retries with compacted context, and exposes complete hook events', async () => {
    const seed = user('seed history');
    const current = user('current task');
    const overflow = new ContextLengthFixtureError('overflow-one');
    const trigger = vi.fn((snapshot: SummaryCompactSnapshot<TestProtocol>) => {
      expect(snapshot.cause).toEqual({ type: 'trigger' });
      return false;
    });
    const prompt = vi.fn((snapshot: SummaryPromptSnapshot<TestProtocol>) => {
      expect(snapshot.cause).toMatchObject({
        type: 'context_length_exceeded',
        cause: overflow,
        error: {
          kind: 'context_length_exceeded',
          providerCode: 'context_length_exceeded',
        },
      });
      expect(snapshot.selection).toEqual({
        contextToSummarize: [seed, current],
        preservedContext: [],
      });
      return 'emergency prompt';
    });
    const model = new ClassifiedMockModel([
      overflow,
      (request) => {
        expect(request.purpose).toBe('context-summary');
        expect(request.tools).toEqual([]);
        expect(nonSystem(request.context)).toEqual([seed, current, user('emergency prompt')]);
        return response(assistant('emergency summary'));
      },
      (request) => {
        expect(request).not.toHaveProperty('purpose');
        expect(nonSystem(request.context)).toEqual([summaryMemory('emergency summary')]);
        return endResponse('emergency-end');
      },
    ]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      initContext: [seed],
      contextCompact: {
        toolInput: false,
        toolResult: false,
        summary: summaryPolicy({ trigger, prompt }),
      },
    });
    const beforeEvents: BeforeModelErrorRecoveryEvent<TestProtocol>[] = [];
    const afterEvents: AfterModelErrorRecoveryEvent<TestProtocol>[] = [];

    agent.onBeforeModelErrorRecovery((event) => {
      beforeEvents.push(event);
    });
    agent.onAfterModelErrorRecovery((event) => {
      afterEvents.push(event);
    });
    agent.init();
    await agent.agent(current.content);

    expect(trigger).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledOnce();
    expect(beforeEvents).toHaveLength(1);
    expect(beforeEvents[0]).toMatchObject({
      cause: overflow,
      descriptor: {
        kind: 'context_length_exceeded',
        message: 'overflow-one',
        provider: 'fixture',
        providerCode: 'context_length_exceeded',
        status: 400,
        requestId: 'request-overflow-one',
      },
      purpose: 'agent',
      request: model.requests[0],
      requestAttempt: 1,
      ledger: {
        requestAttempts: 1,
        totalRetries: 0,
        forcedRetries: 0,
        unhandledRetries: 0,
        contextRecoveryAttempts: 0,
      },
      limits: {
        unhandledRetryLimit: 3,
        contextLengthRecoveryLimit: 2,
      },
      matchedHandler: {
        id: 'core.context_compaction',
        kind: 'context_length_exceeded',
      },
      defaultAction: 'retry',
    });
    expect(beforeEvents[0]?.contextRevision).toBeTypeOf('number');
    expect(afterEvents).toHaveLength(1);
    expect(afterEvents[0]).toMatchObject({
      cause: overflow,
      descriptor: beforeEvents[0]?.descriptor,
      purpose: 'agent',
      request: model.requests[0],
      requestAttempt: 1,
      ledger: {
        requestAttempts: 1,
        totalRetries: 0,
        forcedRetries: 0,
        unhandledRetries: 0,
        contextRecoveryAttempts: 1,
      },
      limits: beforeEvents[0]?.limits,
      matchedHandler: beforeEvents[0]?.matchedHandler,
      beforeDecision: 'default',
      handlerOutcome: 'succeeded',
      proposedAction: 'retry',
    });
    expect(afterEvents[0]?.contextRevision).toBeGreaterThan(
      beforeEvents[0]?.contextRevision ?? Number.MAX_SAFE_INTEGER,
    );
    expect(agent.getHistory()).toEqual([
      seed,
      current,
      expect.objectContaining({ kind: 'assistant' }),
      expect.objectContaining({ kind: 'tool', callId: 'emergency-end' }),
    ]);
    expect(agent.getHistory()).not.toContainEqual(summaryMemory('emergency summary'));
  });

  it('runs the context handler at most twice and reports limit-exceeded without starting a third summary', async () => {
    const seedA = user('seed A');
    const seedB = user('seed B');
    const current = user('current task');
    const select = vi.fn((snapshot: SummaryCompactSnapshot<TestProtocol>) => ({
      contextToSummarize: [snapshot.boundaryOriginalContext[0] as TestContext],
      preservedContext: snapshot.boundaryActiveContext.slice(1),
    }));
    const overflows = [
      new ContextLengthFixtureError('overflow-1'),
      new ContextLengthFixtureError('overflow-2'),
      new ContextLengthFixtureError('overflow-3'),
    ] as const;
    const model = new ClassifiedMockModel([
      overflows[0],
      response(assistant('summary one')),
      overflows[1],
      response(assistant('summary two')),
      overflows[2],
    ]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      initContext: [seedA, seedB],
      contextCompact: {
        toolInput: false,
        toolResult: false,
        summary: summaryPolicy({ select }),
      },
    });
    const beforeEvents: BeforeModelErrorRecoveryEvent<TestProtocol>[] = [];
    const afterEvents: AfterModelErrorRecoveryEvent<TestProtocol>[] = [];

    agent.onBeforeModelErrorRecovery((event) => {
      if (event.purpose === 'agent') beforeEvents.push(event);
    });
    agent.onAfterModelErrorRecovery((event) => {
      if (event.purpose === 'agent') afterEvents.push(event);
    });
    agent.init();

    const error = await captureRecoveryError(agent.agent(current.content));

    expect(model.requests.map((request) => request.purpose)).toEqual([
      undefined,
      'context-summary',
      undefined,
      'context-summary',
      undefined,
    ]);
    expect(select).toHaveBeenCalledTimes(2);
    expect(beforeEvents.map((event) => event.requestAttempt)).toEqual([1, 2, 3]);
    expect(afterEvents.map((event) => event.handlerOutcome)).toEqual([
      'succeeded',
      'succeeded',
      'limit-exceeded',
    ]);
    expect(afterEvents.map((event) => event.ledger.contextRecoveryAttempts)).toEqual([1, 2, 2]);
    expect(error.terminalReason).toBe('context-recovery-limit');
    expect(error.ledger).toEqual({
      requestAttempts: 3,
      totalRetries: 2,
      forcedRetries: 0,
      unhandledRetries: 0,
      contextRecoveryAttempts: 2,
    });
    expect(agent.getHistory()).toEqual([seedA, seedB, current]);
    expect(agent.getContext()).toEqual([summaryMemory('summary two'), current]);
  });

  it('does not recursively run context compaction when a summary request itself exceeds context length', async () => {
    const outerOverflow = new ContextLengthFixtureError('outer');
    const summaryOverflows = [
      new ContextLengthFixtureError('summary-1'),
      new ContextLengthFixtureError('summary-2'),
      new ContextLengthFixtureError('summary-3'),
    ] as const;
    const trigger = vi.fn((snapshot: SummaryCompactSnapshot<TestProtocol>) => {
      expect(snapshot.cause).toEqual({ type: 'trigger' });
      return false;
    });
    const model = new ClassifiedMockModel([
      outerOverflow,
      ...summaryOverflows,
      response(assistant('summary eventually succeeded')),
      endResponse('recursion-end'),
    ]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      initContext: [user('seed')],
      contextCompact: {
        toolInput: false,
        toolResult: false,
        summary: summaryPolicy({ trigger }),
      },
    });
    const beforeEvents: BeforeModelErrorRecoveryEvent<TestProtocol>[] = [];
    const afterEvents: AfterModelErrorRecoveryEvent<TestProtocol>[] = [];

    agent.onBeforeModelErrorRecovery((event) => {
      beforeEvents.push(event);
    });
    agent.onAfterModelErrorRecovery((event) => {
      afterEvents.push(event);
    });
    agent.init();
    await agent.agent('current');

    expect(trigger).toHaveBeenCalledOnce();
    expect(model.requests.map((request) => request.purpose)).toEqual([
      undefined,
      'context-summary',
      'context-summary',
      'context-summary',
      'context-summary',
      undefined,
    ]);
    const summaryBefore = beforeEvents.filter((event) => event.purpose === 'context-summary');
    const summaryAfter = afterEvents.filter((event) => event.purpose === 'context-summary');
    expect(summaryBefore).toHaveLength(3);
    expect(summaryBefore.map((event) => event.requestAttempt)).toEqual([1, 2, 3]);
    expect(summaryBefore.map((event) => event.ledger.unhandledRetries)).toEqual([0, 1, 2]);
    expect(summaryBefore.every((event) => event.matchedHandler === undefined)).toBe(true);
    expect(summaryAfter.map((event) => event.handlerOutcome)).toEqual([
      'not-run',
      'not-run',
      'not-run',
    ]);
    const outerAfter = afterEvents.find((event) => event.purpose === 'agent');
    expect(outerAfter).toMatchObject({
      cause: outerOverflow,
      handlerOutcome: 'succeeded',
      proposedAction: 'retry',
      ledger: { contextRecoveryAttempts: 1 },
    });
  });
});

describe('Agent unknown model error retries', () => {
  it('allows three default extra attempts, runs proactive trigger once, and exposes stable before/after fields', async () => {
    const errors = [
      new Error('unknown-1'),
      new Error('unknown-2'),
      new Error('unknown-3'),
    ] as const;
    const trigger = vi.fn((snapshot: SummaryCompactSnapshot<TestProtocol>) => {
      expect(snapshot.cause).toEqual({ type: 'trigger' });
      return false;
    });
    const model = new ClassifiedMockModel([...errors, endResponse('unknown-end')]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      contextCompact: {
        toolInput: false,
        toolResult: false,
        summary: summaryPolicy({ trigger }),
      },
    });
    const beforeEvents: BeforeModelErrorRecoveryEvent<TestProtocol>[] = [];
    const afterEvents: AfterModelErrorRecoveryEvent<TestProtocol>[] = [];

    agent.onBeforeModelErrorRecovery((event) => {
      beforeEvents.push(event);
    });
    agent.onAfterModelErrorRecovery((event) => {
      afterEvents.push(event);
    });
    agent.init();
    await agent.agent('current');

    expect(trigger).toHaveBeenCalledOnce();
    expect(model.requests).toHaveLength(4);
    expect(model.requests.every((request) => request.purpose === undefined)).toBe(true);
    expect(beforeEvents).toHaveLength(3);
    expect(afterEvents).toHaveLength(3);

    for (const [index, event] of beforeEvents.entries()) {
      expect(event).toMatchObject({
        cause: errors[index],
        descriptor: {
          kind: 'unknown',
          message: `unknown-${index + 1}`,
          provider: 'fixture',
        },
        purpose: 'agent',
        request: model.requests[index],
        requestAttempt: index + 1,
        ledger: {
          requestAttempts: index + 1,
          totalRetries: index,
          forcedRetries: 0,
          unhandledRetries: index,
          contextRecoveryAttempts: 0,
        },
        limits: {
          unhandledRetryLimit: 3,
          contextLengthRecoveryLimit: 2,
        },
        defaultAction: 'retry',
      });
      expect(event).not.toHaveProperty('matchedHandler');
      expect(event.contextRevision).toBeTypeOf('number');
    }

    for (const [index, event] of afterEvents.entries()) {
      expect(event).toMatchObject({
        cause: errors[index],
        descriptor: beforeEvents[index]?.descriptor,
        purpose: 'agent',
        request: model.requests[index],
        requestAttempt: index + 1,
        ledger: beforeEvents[index]?.ledger,
        limits: beforeEvents[index]?.limits,
        beforeDecision: 'default',
        handlerOutcome: 'not-run',
        proposedAction: 'retry',
      });
      expect(event).not.toHaveProperty('handlerFailure');
      expect(event).not.toHaveProperty('matchedHandler');
    }
  });
});
