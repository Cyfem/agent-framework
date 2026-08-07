const CANONICAL_DECIMAL_FENCING_TOKEN = /^(?:0|[1-9][0-9]*)$/u;

export function isCanonicalFencingToken(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_DECIMAL_FENCING_TOKEN.test(value);
}

/** Validate the canonical unsigned base-10 representation shared by StateStore and placement. */
export function assertCanonicalFencingToken(
  value: unknown,
  label = 'fencingToken',
): asserts value is string {
  if (!isCanonicalFencingToken(value)) {
    throw new TypeError(`${label} must be a canonical unsigned decimal string.`);
  }
}

/** Compare two already-canonical fencing tokens without a Store-specific comparator. */
export function compareCanonicalFencingTokens(left: string, right: string): number {
  assertCanonicalFencingToken(left, 'left fencing token');
  assertCanonicalFencingToken(right, 'right fencing token');
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
