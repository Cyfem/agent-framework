import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { OpenAIChatModel } from '../src/llm/chat';
import type {
  OpenAIChatAssistantContextMessage,
  OpenAIChatContext,
  OpenAIChatRawToolCall,
  OpenAIChatToolContextMessage,
} from '../src/llm/chat/types';

describe('OpenAIChatModel.rewriteToolPayloads', () => {
  it('rewrites shared assistant calls once and preserves provider metadata', () => {
    const firstCall = {
      id: 'call-1',
      type: 'function',
      function: { name: 'first', arguments: '{"large":"first"}', providerFunction: 1 },
      providerCall: 'first-metadata',
    } as unknown as OpenAIChatRawToolCall;
    const secondCall = {
      id: 'call-2',
      type: 'function',
      function: { name: 'second', arguments: '{"large":"second"}' },
      providerCall: 'second-metadata',
    } as unknown as OpenAIChatRawToolCall;
    const customCall = {
      id: 'custom-1',
      type: 'custom',
      custom: { name: 'code', input: 'unchanged' },
      providerCustom: true,
    } as const;
    const assistant = {
      role: 'assistant',
      content: 'working',
      refusal: null,
      audio: { id: 'audio-1' },
      annotations: [],
      tool_calls: [firstCall, secondCall, customCall],
      providerMessage: { preserved: true },
    } as unknown as OpenAIChatAssistantContextMessage;
    const firstResult = {
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'large result',
      providerResult: 'preserved',
    } as unknown as OpenAIChatToolContextMessage;
    const untouchedResult: OpenAIChatToolContextMessage = {
      role: 'tool',
      tool_call_id: 'call-2',
      content: 'unchanged result',
    };
    const system: OpenAIChatContext = { role: 'system', content: 'system' };
    const context = [system, assistant, firstResult, untouchedResult] as const;
    const before = JSON.stringify(context);

    const rewritten = createModel().rewriteToolPayloads(context, {
      inputs: [
        { sourceMessage: assistant, sourceCall: firstCall, replacement: '{"short":1}' },
        { sourceMessage: assistant, sourceCall: secondCall, replacement: '{"short":2}' },
      ],
      results: [{ sourceMessage: firstResult, callId: 'call-1', replacement: 'short result' }],
    });

    expect(rewritten).not.toBe(context);
    expect(rewritten).toHaveLength(context.length);
    expect(rewritten[0]).toBe(system);
    expect(rewritten[1]).not.toBe(assistant);
    expect(rewritten[2]).not.toBe(firstResult);
    expect(rewritten[3]).toBe(untouchedResult);
    expect(JSON.stringify(context)).toBe(before);

    const rewrittenAssistant = rewritten[1] as OpenAIChatAssistantContextMessage;
    expect(rewrittenAssistant.tool_calls?.[0]).not.toBe(firstCall);
    expect(rewrittenAssistant.tool_calls?.[1]).not.toBe(secondCall);
    expect(rewrittenAssistant.tool_calls?.[2]).toBe(customCall);
    expect(rewrittenAssistant.tool_calls?.[0]).toMatchObject({
      function: { arguments: '{"short":1}', providerFunction: 1 },
      providerCall: 'first-metadata',
    });
    expect(rewrittenAssistant.tool_calls?.[1]).toMatchObject({
      function: { arguments: '{"short":2}' },
      providerCall: 'second-metadata',
    });
    expect(rewrittenAssistant).toMatchObject({
      content: 'working',
      audio: { id: 'audio-1' },
      providerMessage: { preserved: true },
    });
    expect(rewritten[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'short result',
      providerResult: 'preserved',
    });
  });

  it('returns a shallow copy for an empty batch', () => {
    const message: OpenAIChatContext = { role: 'user', content: 'hello' };
    const context = [message] as const;

    const rewritten = createModel().rewriteToolPayloads(context, { inputs: [], results: [] });

    expect(rewritten).not.toBe(context);
    expect(rewritten).toEqual(context);
    expect(rewritten[0]).toBe(message);
  });

  it('rejects zero, repeated context, and duplicate target matches', () => {
    const call: OpenAIChatRawToolCall = {
      id: 'call-1',
      type: 'function',
      function: { name: 'tool', arguments: '{}' },
    };
    const assistant: OpenAIChatAssistantContextMessage = {
      role: 'assistant',
      tool_calls: [call],
    };
    const detached = { ...assistant };
    const replacement = {
      sourceMessage: assistant,
      sourceCall: call,
      replacement: '{"compact":true}',
    };
    const model = createModel();

    expect(() =>
      model.rewriteToolPayloads([detached], { inputs: [replacement], results: [] }),
    ).toThrow(/exactly once.*0/u);
    expect(() =>
      model.rewriteToolPayloads([assistant, assistant], { inputs: [replacement], results: [] }),
    ).toThrow(/exactly once.*2/u);
    expect(() =>
      model.rewriteToolPayloads([assistant], {
        inputs: [replacement, replacement],
        results: [],
      }),
    ).toThrow(/same call more than once/u);
  });
});

describe('OpenAIChatModel summary requests', () => {
  it('removes tool-only defaults without mutating ordinary defaults', async () => {
    const create = vi.fn().mockResolvedValue({ choices: [] });
    const model = new OpenAIChatModel({
      model: 'test-model',
      client: { chat: { completions: { create } } } as unknown as OpenAI,
      defaultParams: {
        tool_choice: 'required',
        parallel_tool_calls: true,
        function_call: 'auto',
      },
    });

    await model.generate({
      purpose: 'context-summary',
      context: [{ role: 'user', content: 'summarize' }],
      tools: [],
    });

    const sent = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('tools');
    expect(sent).not.toHaveProperty('tool_choice');
    expect(sent).not.toHaveProperty('parallel_tool_calls');
    expect(sent).not.toHaveProperty('function_call');

    await model.generate({ context: [{ role: 'user', content: 'normal' }], tools: [] });
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      tool_choice: 'required',
      parallel_tool_calls: true,
      function_call: 'auto',
    });
  });
});

function createModel(): OpenAIChatModel {
  return new OpenAIChatModel({ model: 'test-model', apiKey: 'test-key' });
}
