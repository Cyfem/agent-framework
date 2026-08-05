import { describe, expect, it } from 'vitest';
import { acceptanceIt } from '../../../testkit';

import { ContextStore, ContextStoreError } from '../src/agent/context-store';
import type { AgentProtocol } from '../src/agent/types';
import {
  OPENAI_CHAT_CHECKPOINT_CODEC,
  OPENAI_RESPONSES_CHECKPOINT_CODEC,
  type AgentProtocolCheckpointCodec,
  type ContextStoreCheckpointV1,
} from '../src/subagent/checkpoint';
import type { JsonValue } from '../src/subagent/json';
import type { OpenAIChatProtocol } from '../src/llm/chat/types';
import type { OpenAIResponsesProtocol } from '../src/llm/responses/types';

describe('ContextStore protocol checkpoints', () => {
  acceptanceIt('CHECKPOINT-01', 'chat-context-store', () => {
    const seed = { role: 'system', content: 'seed' } as const;
    const user = { role: 'user', content: 'question' } as const;
    const originalAssistant = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'large-tool', arguments: '{"payload":"original"}' },
        },
      ],
    } as const;
    const originalResult = {
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'large original result',
    } as const;
    const compactAssistant = {
      ...originalAssistant,
      tool_calls: [
        {
          ...originalAssistant.tool_calls[0],
          function: { name: 'large-tool', arguments: '{"payload":"compact"}' },
        },
      ],
    } as const;
    const compactResult = { ...originalResult, content: 'compact result' } as const;
    const futureUser = { role: 'user', content: 'future' } as const;
    const pendingAssistant = { role: 'assistant', content: 'pending' } as const;
    const summary = { role: 'system', content: 'rolling summary' } as const;
    const store = new ContextStore<OpenAIChatProtocol>([seed]);

    store.appendStandalone(user, 'user');
    store.openLoopSpan();
    store.appendToOpenLoop(originalAssistant);
    store.appendToOpenLoop(originalResult);
    store.commitOpenLoopRewrite(store.snapshotOpenLoop(), [compactAssistant, compactResult]);
    store.commitSummary({
      revision: store.revision,
      summaryText: 'rolling summary text',
      summaryMessage: summary,
      preservedContext: [compactAssistant, compactResult],
    });
    store.appendStandalone(futureUser, 'user');
    store.openLoopSpan();
    store.appendToOpenLoop(pendingAssistant);

    const checkpoint = store.exportCheckpoint(OPENAI_CHAT_CHECKPOINT_CODEC);
    const restored = ContextStore.restoreCheckpoint(checkpoint, OPENAI_CHAT_CHECKPOINT_CODEC);

    expect(checkpoint).toMatchObject({
      version: '1',
      protocol: 'openai-chat',
      codecVersion: '1',
      revision: store.revision,
      openLoopSpanId: 'context-span-7',
      summaryBoundarySpanId: 'context-span-4',
      previousSummary: {
        entryId: 'context-entry-5',
        text: 'rolling summary text',
      },
      nextRawItemId: 7,
      nextSpanId: 8,
      nextEntryId: 10,
    });
    expect(checkpoint.rawHistory.map(({ itemId }) => itemId)).toEqual([
      'context-raw-item-1',
      'context-raw-item-2',
      'context-raw-item-3',
      'context-raw-item-4',
      'context-raw-item-5',
      'context-raw-item-6',
    ]);
    expect(restored.revision).toBe(store.revision);
    expect(restored.hasOpenLoopSpan).toBe(true);
    expect(restored.getActiveContext()).toEqual(store.getActiveContext());
    expect(restored.getRawHistory()).toEqual(store.getRawHistory());
    expect(restored.getSummarySnapshot()).toEqual(store.getSummarySnapshot());

    const openSnapshot = restored.snapshotOpenLoop();
    expect(openSnapshot).toMatchObject({
      spanId: 'context-span-7',
      revision: checkpoint.revision,
    });
    restored.commitOpenLoopRewrite(openSnapshot, [
      { role: 'assistant', content: 'pending compacted' },
    ]);
    restored.appendStandalone({ role: 'user', content: 'after restore' }, 'user');

    const continuedCheckpoint = restored.exportCheckpoint(OPENAI_CHAT_CHECKPOINT_CODEC);
    expect(continuedCheckpoint.rawHistory.at(-1)?.itemId).toBe('context-raw-item-7');
    expect(continuedCheckpoint.activeSpans.at(-1)?.spanId).toBe('context-span-8');
    expect(continuedCheckpoint.activeSpans.at(-1)?.entries[0]?.entryId).toBe('context-entry-10');
    expect(continuedCheckpoint.nextRawItemId).toBe(8);
    expect(continuedCheckpoint.nextSpanId).toBe(9);
    expect(continuedCheckpoint.nextEntryId).toBe(11);
  });

  it('round-trips Responses context with the built-in versioned codec', () => {
    const input = { role: 'user', content: 'hello', type: 'message' } as const;
    const output = {
      type: 'message',
      id: 'response-message-1',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'world',
          annotations: [],
        },
      ],
      status: 'completed',
    } as const;
    const store = new ContextStore<OpenAIResponsesProtocol>([input]);

    store.openLoopSpan();
    store.appendToOpenLoop(output);
    store.closeOpenLoopSpan();

    const checkpoint = store.exportCheckpoint(OPENAI_RESPONSES_CHECKPOINT_CODEC);
    const restored = ContextStore.restoreCheckpoint(checkpoint, OPENAI_RESPONSES_CHECKPOINT_CODEC);

    expect(checkpoint).toMatchObject({ protocol: 'openai-responses', codecVersion: '1' });
    expect(restored.getActiveContext()).toEqual([input, output]);
    expect(restored.getRawHistory()).toEqual([input, output]);
    expect(restored.exportCheckpoint(OPENAI_RESPONSES_CHECKPOINT_CODEC)).toEqual(checkpoint);
  });

  it('uses detached codec values so a custom decoder cannot mutate the source checkpoint', () => {
    const codec = createMutatingCustomCodec();
    const store = new ContextStore<CustomProtocol>([{ id: 'seed', payload: 'one' }]);
    store.appendStandalone({ id: 'external', payload: 'two' });
    const checkpoint = store.exportCheckpoint(codec);
    const checkpointBeforeRestore = structuredClone(checkpoint);

    const restored = ContextStore.restoreCheckpoint(checkpoint, codec);

    expect(checkpoint).toEqual(checkpointBeforeRestore);
    expect(restored.getActiveContext()).toEqual([
      { id: 'seed', payload: 'one' },
      { id: 'external', payload: 'two' },
    ]);
    expect(codec.decodeCalls()).toBeGreaterThan(0);
  });

  it('rejects version, codec, and corrupt provenance before calling decode', () => {
    const codec = createMutatingCustomCodec();
    const store = new ContextStore<CustomProtocol>([{ id: 'seed', payload: 'one' }]);
    const checkpoint = store.exportCheckpoint(codec);

    expect(() =>
      ContextStore.restoreCheckpoint(
        { ...checkpoint, version: '2' } as unknown as ContextStoreCheckpointV1,
        codec,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ContextStoreError>>({
        code: 'context_checkpoint_version_mismatch',
      }),
    );
    expect(codec.decodeCalls()).toBe(0);

    const otherCodec: AgentProtocolCheckpointCodec<CustomProtocol> = {
      ...codec,
      protocol: 'custom-other',
    };
    expect(() => ContextStore.restoreCheckpoint(checkpoint, otherCodec)).toThrowError(
      expect.objectContaining<Partial<ContextStoreError>>({
        code: 'context_checkpoint_codec_mismatch',
      }),
    );
    expect(codec.decodeCalls()).toBe(0);

    const corruptCheckpoint: ContextStoreCheckpointV1 = {
      ...checkpoint,
      activeSpans: checkpoint.activeSpans.map((span, spanIndex) => ({
        ...span,
        entries: span.entries.map((entry, entryIndex) =>
          spanIndex === 0 && entryIndex === 0
            ? { ...entry, rawItemId: 'context-raw-item-999' }
            : entry,
        ),
      })),
    };
    expect(() => ContextStore.restoreCheckpoint(corruptCheckpoint, codec)).toThrowError(
      expect.objectContaining<Partial<ContextStoreError>>({
        code: 'invalid_context_checkpoint',
      }),
    );
    expect(codec.decodeCalls()).toBe(0);
  });
});

interface CustomMessage {
  readonly id: string;
  readonly payload: string;
}

interface CustomProtocol extends AgentProtocol {
  context: CustomMessage;
  tool: unknown;
  userMessage: unknown;
  systemMessage: unknown;
  assistantMessage: unknown;
  toolCallOutputMessage: unknown;
  rawToolCall: unknown;
  rawResponse: unknown;
}

interface ObservableCustomCodec extends AgentProtocolCheckpointCodec<CustomProtocol> {
  decodeCalls(): number;
}

function createMutatingCustomCodec(): ObservableCustomCodec {
  let decodeCallCount = 0;

  return {
    protocol: 'custom-test',
    version: 'custom-v1',
    encode(context): JsonValue {
      return {
        envelope: context.map((item) => ({ id: item.id, payload: item.payload })),
      };
    },
    decode(value): readonly CustomMessage[] {
      decodeCallCount += 1;
      const record = value as unknown as { envelope: CustomMessage[] };
      const decoded = [...record.envelope];
      // Deliberately mutate decoder input. ContextStore must pass a detached
      // copy rather than a value reachable from the caller's checkpoint.
      record.envelope.length = 0;
      return decoded;
    },
    decodeCalls: () => decodeCallCount,
  };
}
