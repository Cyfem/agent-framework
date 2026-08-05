export interface SubAgentLimits {
  readonly maxDepth: number;
  readonly maxDescendants: number;
  readonly maxConcurrent: number;
  readonly maxTurns: number;
  readonly timeoutMs: number;
  readonly maxProviderCalls?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxCost?: number;
}

export interface ResolvedSubAgentLimits extends SubAgentLimits {
  readonly maxDepth: number;
  readonly maxDescendants: number;
  readonly maxConcurrent: number;
  readonly maxTurns: number;
  readonly timeoutMs: number;
}

export interface SubAgentIoLimits {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
}

export interface SubAgentProjectionLimits {
  readonly maxItems: number;
  readonly maxItemBytes: number;
  readonly maxTotalBytes: number;
}

export interface TreeBudgetSnapshot {
  readonly descendantsCreated: number;
  readonly activeExecutions: number;
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost?: number;
}

export const DEFAULT_SUBAGENT_LIMITS: Readonly<ResolvedSubAgentLimits> = Object.freeze({
  maxDepth: 3,
  maxDescendants: 32,
  maxConcurrent: 4,
  maxTurns: 16,
  timeoutMs: 120_000,
});

export const DEFAULT_SUBAGENT_IO_LIMITS: Readonly<SubAgentIoLimits> = Object.freeze({
  maxInputBytes: 256 * 1024,
  maxOutputBytes: 256 * 1024,
});

export const DEFAULT_SUBAGENT_PROJECTION_LIMITS: Readonly<SubAgentProjectionLimits> = Object.freeze(
  {
    maxItems: 32,
    maxItemBytes: 64 * 1024,
    maxTotalBytes: 128 * 1024,
  },
);

export function resolveSubAgentLimits(
  limits: Partial<SubAgentLimits> = {},
): Readonly<ResolvedSubAgentLimits> {
  const resolved: ResolvedSubAgentLimits = {
    maxDepth: limits.maxDepth ?? DEFAULT_SUBAGENT_LIMITS.maxDepth,
    maxDescendants: limits.maxDescendants ?? DEFAULT_SUBAGENT_LIMITS.maxDescendants,
    maxConcurrent: limits.maxConcurrent ?? DEFAULT_SUBAGENT_LIMITS.maxConcurrent,
    maxTurns: limits.maxTurns ?? DEFAULT_SUBAGENT_LIMITS.maxTurns,
    timeoutMs: limits.timeoutMs ?? DEFAULT_SUBAGENT_LIMITS.timeoutMs,
    ...(limits.maxProviderCalls === undefined ? {} : { maxProviderCalls: limits.maxProviderCalls }),
    ...(limits.maxInputTokens === undefined ? {} : { maxInputTokens: limits.maxInputTokens }),
    ...(limits.maxOutputTokens === undefined ? {} : { maxOutputTokens: limits.maxOutputTokens }),
    ...(limits.maxCost === undefined ? {} : { maxCost: limits.maxCost }),
  };

  for (const key of [
    'maxDepth',
    'maxDescendants',
    'maxConcurrent',
    'maxTurns',
    'timeoutMs',
    'maxProviderCalls',
    'maxInputTokens',
    'maxOutputTokens',
  ] as const) {
    const value = resolved[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError(`Subagent limit ${key} must be a positive safe integer.`);
    }
  }
  if (
    resolved.maxCost !== undefined &&
    (!Number.isFinite(resolved.maxCost) || resolved.maxCost < 0)
  ) {
    throw new RangeError('Subagent limit maxCost must be a finite non-negative number.');
  }

  return Object.freeze(resolved);
}
