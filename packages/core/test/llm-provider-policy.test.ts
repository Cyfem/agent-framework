import { describe, expect, it, vi } from 'vitest';

import { acceptanceIt } from '../../../testkit';
import { OpenAIChatModel } from '../src/llm/chat';
import { OpenAIResponsesModel } from '../src/llm/responses';

describe('OpenAI provider dispatch policy', () => {
  acceptanceIt(
    'C7-GATEWAY-23.l1.provider-zero-retry',
    'chat-responses-one-http-attempt',
    async () => {
      const scenarios = [
        (fetch: typeof globalThis.fetch) =>
          new OpenAIChatModel({
            apiKey: 'offline-test-key',
            baseURL: 'https://provider.invalid/v1',
            fetch,
            model: 'offline-chat',
          }),
        (fetch: typeof globalThis.fetch) =>
          new OpenAIResponsesModel({
            apiKey: 'offline-test-key',
            baseURL: 'https://provider.invalid/v1',
            fetch,
            model: 'offline-responses',
          }),
      ];

      for (const createModel of scenarios) {
        const fetch = vi.fn<typeof globalThis.fetch>(
          async () =>
            new Response(JSON.stringify({ error: { message: 'retryable offline failure' } }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            }),
        );
        const model = createModel(fetch);

        expect(model.providerMaxRetries).toBe(0);
        await expect(model.generate({ context: [], tools: [] })).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('normalizes Chat usage and passes an explicit zero-retry request option', async () => {
    const create = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));
    const model = new OpenAIChatModel({
      model: 'offline-chat',
      client: { chat: { completions: { create } } } as never,
    });

    const result = await model.generate({ context: [], tools: [] });

    expect(create).toHaveBeenCalledWith(expect.any(Object), { maxRetries: 0 });
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  });

  it('normalizes Responses usage and passes an explicit zero-retry request option', async () => {
    const create = vi.fn(async () => ({
      output: [],
      usage: { input_tokens: 13, output_tokens: 5, total_tokens: 18 },
    }));
    const model = new OpenAIResponsesModel({
      model: 'offline-responses',
      client: { responses: { create } } as never,
    });

    const result = await model.generate({ context: [], tools: [] });

    expect(create).toHaveBeenCalledWith(expect.any(Object), { maxRetries: 0 });
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 5, totalTokens: 18 });
  });
});
