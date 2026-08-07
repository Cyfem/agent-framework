import type { ModelGenerateResult, ModelGenerateUsage } from '../llm/base';
import type { AgentProtocol } from './types';

const MODEL_USAGE_KEYS = new Set(['inputTokens', 'outputTokens', 'totalTokens']);

/**
 * Copy and validate provider usage at the Model boundary. Custom Models are runtime values, so
 * their TypeScript declaration is not sufficient protection for durable budget state.
 */
export function normalizeModelGenerateUsage(
  value: unknown,
): Readonly<ModelGenerateUsage> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Model result usage must be an object.');
  }

  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.some((key) => !MODEL_USAGE_KEYS.has(key))) {
    throw new TypeError(
      'Model result usage must contain only inputTokens, outputTokens, or totalTokens.',
    );
  }

  const normalized: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const count = record[key];
    if (count === undefined) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`Model result usage.${key} must be a non-negative safe integer.`);
    }
    normalized[key] = count;
  }

  if (Object.keys(normalized).length === 0) {
    throw new TypeError('Model result usage must include at least one token count.');
  }
  return Object.freeze(normalized);
}

/** Return a detached result whose optional usage has passed the closed runtime validator. */
export function normalizeModelGenerateResultUsage<P extends AgentProtocol>(
  result: ModelGenerateResult<P>,
): ModelGenerateResult<P> {
  const usage = normalizeModelGenerateUsage(result.usage);
  return Object.freeze({
    ...result,
    ...(usage === undefined ? {} : { usage }),
  });
}
