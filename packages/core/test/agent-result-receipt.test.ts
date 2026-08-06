import { describe, expect, it } from 'vitest';

import {
  AGENT_RESULT_RECEIPT_MAX_UTF8_BYTES,
  parseAgentResultReceipt,
  serializeAgentResultReceipt,
} from '../src/subagent/agent-result-receipt';

const OUTPUT_HASH = 'a'.repeat(64);

describe('internal agent-result Tool receipt', () => {
  it('serializes accepted and replayed receipts deterministically', () => {
    expect(serializeAgentResultReceipt({ status: 'accepted', outputHash: OUTPUT_HASH })).toBe(
      `{"ok":true,"status":"accepted","outputHash":"${OUTPUT_HASH}"}`,
    );
    const replay = serializeAgentResultReceipt({ status: 'replayed', outputHash: OUTPUT_HASH });
    expect(replay).toBe(`{"ok":true,"status":"replayed","outputHash":"${OUTPUT_HASH}"}`);
    expect(parseAgentResultReceipt(replay, OUTPUT_HASH)).toEqual({
      ok: true,
      status: 'replayed',
      outputHash: OUTPUT_HASH,
    });
    expect(Object.isFrozen(parseAgentResultReceipt(replay, OUTPUT_HASH))).toBe(true);
  });

  it.each([
    ['object form', { ok: true, status: 'accepted', outputHash: OUTPUT_HASH }],
    ['duplicate keys', `{"ok":true,"ok":true,"status":"accepted","outputHash":"${OUTPUT_HASH}"}`],
    [
      'oversized source',
      `${' '.repeat(AGENT_RESULT_RECEIPT_MAX_UTF8_BYTES + 1)}{"ok":true,"status":"accepted","outputHash":"${OUTPUT_HASH}"}`,
    ],
  ])('rejects %s', (_label, candidate) => {
    expect(() => parseAgentResultReceipt(candidate, OUTPUT_HASH)).toThrow();
  });

  it('rejects a receipt linked to a different authoritative hash', () => {
    const receipt = serializeAgentResultReceipt({ status: 'accepted', outputHash: OUTPUT_HASH });
    expect(() => parseAgentResultReceipt(receipt, 'b'.repeat(64))).toThrow(
      /does not match the authoritative output/u,
    );
  });
});
