import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { OpenAIResponsesModel } from '../src/llm/responses';
import type {
  OpenAIResponsesContext,
  OpenAIResponsesFunctionCall,
  OpenAIResponsesFunctionCallOutput,
  OpenAIResponsesModelOptions,
} from '../src/llm/responses/types';

describe('OpenAIResponsesModel.rewriteToolPayloads', () => {
  it('rewrites call/output items copy-on-write and preserves provider metadata', () => {
    const call = {
      type: 'function_call',
      call_id: 'call-1',
      name: 'lookup',
      arguments: '{"large":"input"}',
      id: 'item-1',
      namespace: 'provider-space',
      status: 'completed',
      created_by: 'provider',
      providerCall: { preserved: true },
    } as unknown as OpenAIResponsesFunctionCall;
    const output = {
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'large output',
      id: 'item-2',
      status: 'completed',
      created_by: 'framework',
      providerOutput: { preserved: true },
    } as unknown as OpenAIResponsesFunctionCallOutput;
    const reasoning = {
      type: 'reasoning',
      id: 'reasoning-1',
      summary: [],
      encrypted_content: 'opaque',
    } as const;
    const context: readonly OpenAIResponsesContext[] = [reasoning, call, output];
    const before = JSON.stringify(context);

    const rewritten = createModel().rewriteToolPayloads(context, {
      inputs: [{ sourceMessage: call, sourceCall: call, replacement: '{"short":true}' }],
      results: [{ sourceMessage: output, callId: 'call-1', replacement: 'short output' }],
    });

    expect(rewritten).not.toBe(context);
    expect(rewritten).toHaveLength(context.length);
    expect(rewritten[0]).toBe(reasoning);
    expect(rewritten[1]).not.toBe(call);
    expect(rewritten[2]).not.toBe(output);
    expect(rewritten[1]).toMatchObject({
      type: 'function_call',
      arguments: '{"short":true}',
      id: 'item-1',
      namespace: 'provider-space',
      status: 'completed',
      created_by: 'provider',
      providerCall: { preserved: true },
    });
    expect(rewritten[2]).toMatchObject({
      type: 'function_call_output',
      output: 'short output',
      id: 'item-2',
      status: 'completed',
      created_by: 'framework',
      providerOutput: { preserved: true },
    });
    expect(JSON.stringify(context)).toBe(before);
  });

  it('returns a shallow copy for an empty batch', () => {
    const message: OpenAIResponsesContext = { role: 'user', content: 'hello' };
    const context = [message] as const;

    const rewritten = createModel().rewriteToolPayloads(context, { inputs: [], results: [] });

    expect(rewritten).not.toBe(context);
    expect(rewritten[0]).toBe(message);
  });

  it('rejects zero, repeated context, mismatched identity, and duplicate targets', () => {
    const call: OpenAIResponsesFunctionCall = {
      type: 'function_call',
      call_id: 'call-1',
      name: 'lookup',
      arguments: '{}',
    };
    const detached = { ...call };
    const replacement = {
      sourceMessage: call,
      sourceCall: call,
      replacement: '{"short":true}',
    };
    const model = createModel();

    expect(() =>
      model.rewriteToolPayloads([detached], { inputs: [replacement], results: [] }),
    ).toThrow(/exactly once.*0/u);
    expect(() =>
      model.rewriteToolPayloads([call, call], { inputs: [replacement], results: [] }),
    ).toThrow(/exactly once.*2/u);
    expect(() =>
      model.rewriteToolPayloads([call], {
        inputs: [{ ...replacement, sourceCall: detached }],
        results: [],
      }),
    ).toThrow(/same function_call/u);
    expect(() =>
      model.rewriteToolPayloads([call], {
        inputs: [replacement, replacement],
        results: [],
      }),
    ).toThrow(/same call more than once/u);
  });
});

describe('OpenAIResponsesModel summary requests', () => {
  it('removes tool-only defaults without changing ordinary requests', async () => {
    const create = vi.fn().mockResolvedValue({ output: [] });
    const defaultParams = {
      tool_choice: 'required',
      parallel_tool_calls: true,
      // Some OpenAI-compatible providers accept this Responses extension even
      // when the installed SDK declaration does not expose it yet.
      max_tool_calls: 5,
    } as unknown as NonNullable<OpenAIResponsesModelOptions['defaultParams']>;
    const model = new OpenAIResponsesModel({
      model: 'test-model',
      client: { responses: { create } } as unknown as OpenAI,
      defaultParams,
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
    expect(sent).not.toHaveProperty('max_tool_calls');

    await model.generate({ context: [{ role: 'user', content: 'normal' }], tools: [] });
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      tool_choice: 'required',
      parallel_tool_calls: true,
      max_tool_calls: 5,
    });
  });
});

function createModel(): OpenAIResponsesModel {
  return new OpenAIResponsesModel({ model: 'test-model', apiKey: 'test-key' });
}
