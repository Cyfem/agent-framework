import { describe, expect, it } from 'vitest';

import {
  ContextStore,
  ContextStoreError,
  type ContextStoreSummaryTransaction,
} from '../src/agent/context-store';
import type { AgentProtocol } from '../src/agent/types';

interface TestMessage {
  readonly id: string;
  readonly body?: string;
}

interface TestProtocol extends AgentProtocol {
  context: TestMessage;
  tool: unknown;
  userMessage: unknown;
  systemMessage: unknown;
  assistantMessage: unknown;
  toolCallOutputMessage: unknown;
  rawToolCall: unknown;
  rawResponse: unknown;
}

function message(id: string, body?: string): TestMessage {
  return body === undefined ? { id } : { id, body };
}

function summaryTransaction(
  store: ContextStore<TestProtocol>,
  summaryMessage: TestMessage,
  preservedContext: readonly TestMessage[],
  summaryText = summaryMessage.body ?? summaryMessage.id,
): ContextStoreSummaryTransaction<TestProtocol> {
  return {
    revision: store.revision,
    summaryText,
    summaryMessage,
    preservedContext,
  };
}

describe('ContextStore seed and append semantics', () => {
  it('keeps unequal seed projections opaque and returns shallow array copies', () => {
    const activeSeed = [message('active-a')];
    const rawSeed = [message('raw-a'), message('raw-b')];
    const store = new ContextStore<TestProtocol>(activeSeed, rawSeed);

    const active = store.getActiveContext();
    const raw = store.getRawHistory();

    expect(active).toEqual(activeSeed);
    expect(raw).toEqual(rawSeed);
    expect(active).not.toBe(activeSeed);
    expect(raw).not.toBe(rawSeed);
    expect(store.revision).toBe(0);

    (active as TestMessage[]).push(message('local-only'));
    (raw as TestMessage[]).pop();

    expect(store.getActiveContext()).toEqual(activeSeed);
    expect(store.getRawHistory()).toEqual(rawSeed);
    expect(store.getSummarySnapshot()).toMatchObject({
      boundaryActiveContext: activeSeed,
      boundaryOriginalContext: rawSeed,
    });
  });

  it('creates separate user/external spans and increments revision for every mutation', () => {
    const store = new ContextStore<TestProtocol>();
    const user = message('user');
    const external = message('external');

    store.appendStandalone(user, 'user');
    expect(store.revision).toBe(1);
    store.appendStandalone(external);
    expect(store.revision).toBe(2);

    expect(store.getRawHistory()).toEqual([user, external]);
    expect(store.getActiveContext()).toEqual([user, external]);
    expect(store.getDefaultSummarySelection('trigger')).toEqual({
      contextToSummarize: [user],
      preservedContext: [external],
    });
  });
});

describe('ContextStore loop transactions', () => {
  it('rewrites active loop messages copy-on-write while retaining frozen raw messages', () => {
    const store = new ContextStore<TestProtocol>();
    const assistant = Object.freeze(message('assistant', 'original input'));
    const toolResult = Object.freeze(message('result', 'original result'));
    const rewrittenAssistant = message('assistant', 'compact input');
    const rewrittenResult = message('result', 'compact result');

    store.openLoopSpan();
    expect(store.revision).toBe(1);
    store.appendToOpenLoop(assistant);
    store.appendToOpenLoop(toolResult);
    expect(store.revision).toBe(3);

    const snapshot = store.snapshotOpenLoop();
    expect(snapshot.activeContext).toEqual([assistant, toolResult]);

    store.commitOpenLoopRewrite(snapshot, [rewrittenAssistant, rewrittenResult]);

    expect(store.revision).toBe(4);
    expect(store.hasOpenLoopSpan).toBe(false);
    expect(store.getRawHistory()).toEqual([assistant, toolResult]);
    expect(store.getActiveContext()).toEqual([rewrittenAssistant, rewrittenResult]);
    expect(store.getSummarySnapshot()).toMatchObject({
      boundaryOriginalContext: [assistant, toolResult],
      boundaryActiveContext: [rewrittenAssistant, rewrittenResult],
    });
  });

  it('rejects a revision conflict without applying a partial rewrite and remains reusable after abort', () => {
    const store = new ContextStore<TestProtocol>();
    const first = message('first');
    const concurrent = message('concurrent');

    store.openLoopSpan();
    store.appendToOpenLoop(first);
    const snapshot = store.snapshotOpenLoop();
    store.appendToOpenLoop(concurrent);

    expect(() => store.commitOpenLoopRewrite(snapshot, [message('rewritten')])).toThrowError(
      expect.objectContaining<Partial<ContextStoreError>>({
        code: 'concurrent_context_mutation',
      }),
    );
    expect(store.getRawHistory()).toEqual([first, concurrent]);
    expect(store.getActiveContext()).toEqual([first, concurrent]);
    expect(store.hasOpenLoopSpan).toBe(true);

    const revisionBeforeAbort = store.revision;
    store.abortOpenLoopSpan();
    expect(store.revision).toBe(revisionBeforeAbort + 1);
    expect(store.hasOpenLoopSpan).toBe(false);

    store.openLoopSpan();
    store.appendToOpenLoop(message('next-loop'));
    store.closeOpenLoopSpan();
    expect(store.getActiveContext().map(({ id }) => id)).toEqual([
      'first',
      'concurrent',
      'next-loop',
    ]);

    const closedRevision = store.revision;
    store.abortOpenLoopSpan();
    expect(store.revision).toBe(closedRevision);
  });

  it('validates snapshot identity and rewrite cardinality', () => {
    const store = new ContextStore<TestProtocol>();
    store.openLoopSpan();
    store.appendToOpenLoop(message('one'));
    const snapshot = store.snapshotOpenLoop();

    expect(() =>
      store.commitOpenLoopRewrite({ ...snapshot, spanId: 'other' }, [message('x')]),
    ).toThrowError(
      expect.objectContaining<Partial<ContextStoreError>>({
        code: 'invalid_open_loop_snapshot',
      }),
    );
    expect(() => store.commitOpenLoopRewrite(snapshot, [])).toThrowError(
      expect.objectContaining<Partial<ContextStoreError>>({
        code: 'invalid_open_loop_rewrite',
      }),
    );
    expect(store.getActiveContext()).toEqual([message('one')]);
  });
});

describe('ContextStore summary boundary and provenance', () => {
  it('reuses a complete opaque seed span even when raw and active lengths differ', () => {
    const activeSeed = [message('active-seed')];
    const rawSeed = [message('raw-seed-a'), message('raw-seed-b')];
    const store = new ContextStore<TestProtocol>(activeSeed, rawSeed);
    const summary = message('summary', 'first summary');

    store.commitSummary(summaryTransaction(store, summary, activeSeed));

    expect(store.getActiveContext()).toEqual([summary, ...activeSeed]);
    expect(store.getRawHistory()).toEqual(rawSeed);
    expect(store.getSummarySnapshot()).toMatchObject({
      activeContext: [summary, ...activeSeed],
      boundaryActiveContext: activeSeed,
      boundaryOriginalContext: rawSeed,
      rawHistory: rawSeed,
      previousSummary: {
        text: 'first summary',
        message: summary,
      },
    });
  });

  it('keeps preserved old entries in the next rolling boundary', () => {
    const seed = message('seed');
    const user = message('user');
    const originalAssistant = message('assistant-original');
    const originalResult = message('result-original');
    const compactAssistant = message('assistant-compact');
    const compactResult = message('result-compact');
    const store = new ContextStore<TestProtocol>([seed]);

    store.appendStandalone(user, 'user');
    store.openLoopSpan();
    store.appendToOpenLoop(originalAssistant);
    store.appendToOpenLoop(originalResult);
    const loopSnapshot = store.snapshotOpenLoop();
    store.commitOpenLoopRewrite(loopSnapshot, [compactAssistant, compactResult]);

    expect(store.getDefaultSummarySelection('trigger')).toEqual({
      contextToSummarize: [seed, user],
      preservedContext: [compactAssistant, compactResult],
    });

    const firstSummary = message('summary-one', 'summary one');
    store.commitSummary(summaryTransaction(store, firstSummary, [compactAssistant, compactResult]));
    store.appendStandalone(message('future-user'), 'user');

    const rollingSnapshot = store.getSummarySnapshot();
    expect(rollingSnapshot.boundaryOriginalContext).toEqual([
      originalAssistant,
      originalResult,
      message('future-user'),
    ]);
    expect(rollingSnapshot.boundaryActiveContext).toEqual([
      compactAssistant,
      compactResult,
      message('future-user'),
    ]);
    expect(store.getDefaultSummarySelection('context_length_exceeded')).toEqual({
      contextToSummarize: [originalAssistant, originalResult, message('future-user')],
      preservedContext: [],
    });

    const secondSummary = message('summary-two', 'summary two');
    store.commitSummary(summaryTransaction(store, secondSummary, []));
    expect(store.getActiveContext()).toEqual([secondSummary]);
    expect(store.getSummarySnapshot()).toMatchObject({
      boundaryOriginalContext: [],
      boundaryActiveContext: [],
      previousSummary: { text: 'summary two', message: secondSummary },
    });
    expect(store.getRawHistory()).toEqual([
      seed,
      user,
      originalAssistant,
      originalResult,
      message('future-user'),
    ]);
  });

  it('uses entry-level provenance for partial, reordered, duplicated, and new preserved items', () => {
    const originalA = message('original-a');
    const originalB = message('original-b');
    const compactA = message('compact-a');
    const compactB = message('compact-b');
    const constructed = message('constructed');

    const createRewrittenStore = (): ContextStore<TestProtocol> => {
      const store = new ContextStore<TestProtocol>();
      store.openLoopSpan();
      store.appendToOpenLoop(originalA);
      store.appendToOpenLoop(originalB);
      const snapshot = store.snapshotOpenLoop();
      store.commitOpenLoopRewrite(snapshot, [compactA, compactB]);
      return store;
    };

    const partial = createRewrittenStore();
    partial.commitSummary(summaryTransaction(partial, message('partial-summary'), [compactB]));
    expect(partial.getSummarySnapshot()).toMatchObject({
      boundaryActiveContext: [compactB],
      boundaryOriginalContext: [originalB],
    });

    const reordered = createRewrittenStore();
    reordered.commitSummary(
      summaryTransaction(reordered, message('reordered-summary'), [compactB, compactA]),
    );
    expect(reordered.getSummarySnapshot()).toMatchObject({
      boundaryActiveContext: [compactB, compactA],
      boundaryOriginalContext: [originalB, originalA],
    });

    const duplicated = createRewrittenStore();
    duplicated.commitSummary(
      summaryTransaction(duplicated, message('duplicated-summary'), [compactA, compactA]),
    );
    expect(duplicated.getSummarySnapshot()).toMatchObject({
      boundaryActiveContext: [compactA, compactA],
      // Only one selected occurrence can claim the source entry. The other is
      // an opaque custom value and therefore falls back to its active object.
      boundaryOriginalContext: [originalA, compactA],
    });

    const withConstructed = createRewrittenStore();
    withConstructed.commitSummary(
      summaryTransaction(withConstructed, message('constructed-summary'), [constructed]),
    );
    expect(withConstructed.getSummarySnapshot()).toMatchObject({
      boundaryActiveContext: [constructed],
      boundaryOriginalContext: [constructed],
    });
  });

  it('rejects a stale summary transaction without overwriting concurrent appends', () => {
    const seed = message('seed');
    const concurrent = message('concurrent');
    const store = new ContextStore<TestProtocol>([seed]);
    const snapshot = store.getSummarySnapshot();

    store.appendStandalone(concurrent, 'external');

    expect(() =>
      store.commitSummary({
        revision: snapshot.revision,
        summaryText: 'stale',
        summaryMessage: message('stale-summary'),
        preservedContext: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContextStoreError>>({
        code: 'concurrent_context_mutation',
      }),
    );
    expect(store.getActiveContext()).toEqual([seed, concurrent]);
    expect(store.getRawHistory()).toEqual([seed, concurrent]);
    expect(store.getSummarySnapshot().previousSummary).toBeUndefined();
  });
});
