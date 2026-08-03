import { describe, expect, it } from 'vitest';

import { classifyOpenAICompatibleError } from '../src/llm/openai-error';

describe('classifyOpenAICompatibleError', () => {
  it('prefers recognized structured codes and extracts stable fields', () => {
    const descriptor = classifyOpenAICompatibleError({
      message: 'request failed',
      code: 'context_length_exceeded',
      status: 400,
      requestID: 'req-direct',
      error: {
        code: 'nested-code',
        message: 'nested message',
      },
      secretProviderPayload: { mustNotLeak: true },
    });

    expect(descriptor).toEqual({
      kind: 'context_length_exceeded',
      message: 'request failed',
      provider: 'openai-compatible',
      providerCode: 'context_length_exceeded',
      status: 400,
      requestId: 'req-direct',
    });
    expect(descriptor).not.toHaveProperty('metadata');
  });

  it('recognizes nested codes and types', () => {
    expect(
      classifyOpenAICompatibleError({
        error: { code: 'maximum_context_length_exceeded', message: 'nested' },
      }),
    ).toMatchObject({
      kind: 'context_length_exceeded',
      providerCode: 'maximum_context_length_exceeded',
      message: 'nested',
    });
    expect(
      classifyOpenAICompatibleError({ type: 'context_window_exceeded', message: 'typed' }),
    ).toMatchObject({
      kind: 'context_length_exceeded',
      providerCode: 'context_window_exceeded',
    });
  });

  it('uses explicit message patterns only for absent or constrained statuses', () => {
    const message = "This model's maximum context length is 8,192 tokens.";

    expect(classifyOpenAICompatibleError({ message })).toMatchObject({
      kind: 'context_length_exceeded',
    });
    expect(classifyOpenAICompatibleError({ message, statusCode: 413 })).toMatchObject({
      kind: 'context_length_exceeded',
      status: 413,
    });
    expect(
      classifyOpenAICompatibleError({
        message: 'The input exceeds the context window of this model.',
        type: 'invalid_request_error',
        status: 400,
      }),
    ).toMatchObject({
      kind: 'context_length_exceeded',
      providerCode: 'invalid_request_error',
    });
    expect(classifyOpenAICompatibleError({ message, status: 500 })).toMatchObject({
      kind: 'unknown',
      status: 500,
    });
    expect(classifyOpenAICompatibleError({ message: 'bad request', status: 400 })).toMatchObject({
      kind: 'unknown',
      status: 400,
    });
  });

  it('retains an unknown provider code while allowing a constrained message fallback', () => {
    const descriptor = classifyOpenAICompatibleError({
      message: 'maximum context length exceeded',
      code: 'billing_limit_exceeded',
      status: 400,
    });

    expect(descriptor).toMatchObject({
      kind: 'context_length_exceeded',
      providerCode: 'billing_limit_exceeded',
    });
  });

  it('reads request ids from Headers-like and plain objects', () => {
    expect(
      classifyOpenAICompatibleError({
        message: 'failed',
        headers: new Headers({ 'x-request-id': 'req-headers' }),
      }),
    ).toMatchObject({ requestId: 'req-headers' });
    expect(
      classifyOpenAICompatibleError({
        message: 'failed',
        headers: { 'X-Request-ID': 'req-plain' },
      }),
    ).toMatchObject({ requestId: 'req-plain' });
  });

  it('tolerates hostile getters without throwing', () => {
    const error = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('getter failed');
      },
    });
    Object.defineProperty(error, 'code', {
      get() {
        throw new Error('getter failed');
      },
    });

    expect(classifyOpenAICompatibleError(error)).toEqual({
      kind: 'unknown',
      message: 'Unknown model error',
      provider: 'openai-compatible',
    });
  });
});
