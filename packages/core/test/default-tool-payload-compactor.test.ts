import { describe, expect, it } from 'vitest';
import {
  compactDefaultToolPayload,
  createDefaultToolPayloadCompactor,
  DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS,
  DEFAULT_TOOL_PAYLOAD_JSON_INSPECTION_LIMIT,
  resolveDefaultToolPayloadCompactLimits,
  type DefaultToolPayloadCompactLimits,
} from '../src/agent/default-tool-payload-compactor';

const compactLimits = (targetChars = 512, thresholdChars = targetChars + 1) => ({
  thresholdChars,
  targetChars,
});

function compactRequired(
  original: string,
  kind: 'tool_input' | 'tool_result',
  limits: DefaultToolPayloadCompactLimits,
): string {
  const replacement = compactDefaultToolPayload(original, kind, limits);
  expect(replacement).toBeTypeOf('string');
  return replacement as string;
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('default tool payload limits', () => {
  it('publishes deeply frozen, category-specific defaults', () => {
    expect(DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS).toEqual({
      toolInput: { thresholdChars: 8_192, targetChars: 4_096 },
      toolResult: { thresholdChars: 16_384, targetChars: 8_192 },
    });
    expect(Object.isFrozen(DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolInput)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolResult)).toBe(true);
    expect(() => {
      (DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolInput as { targetChars: number }).targetChars = 999;
    }).toThrow();
    expect(resolveDefaultToolPayloadCompactLimits('tool_input')).toEqual({
      thresholdChars: 8_192,
      targetChars: 4_096,
    });
  });

  it('merges overrides into a frozen copied snapshot and ignores future fields', () => {
    const resolved = resolveDefaultToolPayloadCompactLimits('tool_result', {
      strategy: 'default',
      targetChars: 2_000,
      thresholdChars: 3_000,
      futureOption: true,
    } as never);

    expect(resolved).toEqual({ thresholdChars: 3_000, targetChars: 2_000 });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolved).not.toBe(DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolResult);
  });

  it.each([
    [null, /non-null object/],
    [true, /non-null object/],
    [[], /non-null object/],
    [{ strategy: 'other' }, /strategy/],
    [{ strategy: 'default', targetChars: 511 }, /at least 512/],
    [{ strategy: 'default', targetChars: 512.5 }, /safe integer/],
    [{ strategy: 'default', targetChars: Number.NaN }, /safe integer/],
    [{ strategy: 'default', thresholdChars: Number.MAX_SAFE_INTEGER + 1 }, /safe integer/],
    [{ strategy: 'default', targetChars: 1_000, thresholdChars: 1_000 }, /greater than/],
  ])('rejects invalid runtime option %j', (options, message) => {
    expect(() => resolveDefaultToolPayloadCompactLimits('tool_input', options as never)).toThrow(
      message,
    );
  });

  it('does not compact at the threshold and does compact one code unit above it', () => {
    const limits = compactLimits(512, 600);
    expect(compactDefaultToolPayload('x'.repeat(600), 'tool_input', limits)).toBeUndefined();

    const replacement = compactRequired('x'.repeat(601), 'tool_input', limits);
    expect(replacement.length).toBeLessThanOrEqual(512);
    expect(JSON.parse(replacement)).toMatchObject({
      __context_compact__: { kind: 'tool_input', format: 'invalid-json' },
    });
  });

  it('creates a callback with an immutable resolved limits snapshot', () => {
    const options = {
      strategy: 'default' as const,
      thresholdChars: 600,
      targetChars: 512,
    };
    const compact = createDefaultToolPayloadCompactor('tool_result', options);
    options.thresholdChars = 10_000;

    expect(compact('plain'.repeat(200), {} as never)).toBeTypeOf('string');
  });
});

describe('structured JSON compaction', () => {
  it('uses the input string-leaf budget and the exact 3:1 split', () => {
    const sourceValue = 'a'.repeat(3_000);
    const original = JSON.stringify(sourceValue);
    const replacement = compactRequired(original, 'tool_input', compactLimits(2_048, 2_050));
    const compacted = JSON.parse(replacement) as string;

    expect(compacted).toBe(
      `${'a'.repeat(768)}...[context compacted: omittedChars=1976]...${'a'.repeat(256)}`,
    );
  });

  it('uses the larger result string-leaf budget', () => {
    const sourceValue = 'z'.repeat(5_000);
    const original = JSON.stringify(sourceValue);
    const replacement = compactRequired(original, 'tool_result', compactLimits(4_096, 4_100));
    const compacted = JSON.parse(replacement) as string;

    expect(compacted.startsWith('z'.repeat(1_536))).toBe(true);
    expect(compacted.endsWith('z'.repeat(512))).toBe(true);
    expect(compacted).toContain('omittedChars=2952');
  });

  it('keeps 24 array head items and 8 tail items around a fixed marker', () => {
    const source = Array.from({ length: 40 }, (_, index) => index);
    const original = `${JSON.stringify(source)}${' '.repeat(600)}`;
    const replacement = compactRequired(original, 'tool_input', compactLimits(512, 600));
    const compacted = JSON.parse(replacement) as unknown[];

    expect(compacted).toHaveLength(33);
    expect(compacted.slice(0, 24)).toEqual(source.slice(0, 24));
    expect(compacted[24]).toEqual({
      __context_compact__: { kind: 'array', omittedItems: 8 },
    });
    expect(compacted.slice(25)).toEqual(source.slice(-8));
  });

  it('does not add an array marker at the exact container limit', () => {
    const source = Array.from({ length: 32 }, (_, index) => index);
    const original = `${JSON.stringify(source)}${' '.repeat(600)}`;
    const replacement = compactRequired(original, 'tool_input', compactLimits(512, 600));

    expect(JSON.parse(replacement)).toEqual(source);
  });

  it('keeps 48 object head properties and 16 tail properties with collision-safe marker key', () => {
    const source = Object.create(null) as Record<string, unknown>;
    source.__context_compact__ = 'source-marker';
    source.__context_compact__2 = 'source-marker-2';
    for (let index = 2; index < 70; index += 1) {
      source[`key-${index.toString().padStart(2, '0')}`] = index;
    }
    const original = `${JSON.stringify(source)}${' '.repeat(2_100)}`;
    const replacement = compactRequired(original, 'tool_input', compactLimits(2_048, 2_050));
    const compacted = JSON.parse(replacement) as Record<string, unknown>;

    expect(compacted.__context_compact__).toBe('source-marker');
    expect(compacted.__context_compact__2).toBe('source-marker-2');
    expect(compacted.__context_compact__3).toEqual({
      kind: 'object',
      omittedProperties: 6,
    });
    expect(compacted['key-47']).toBe(47);
    expect(compacted['key-48']).toBeUndefined();
    expect(compacted['key-54']).toBe(54);
  });

  it('uses null-prototype clones for dangerous own keys without prototype pollution', () => {
    const source = Object.create(null) as Record<string, unknown>;
    source.__proto__ = { polluted: true };
    source['constructor'] = { prototype: { polluted: true } };
    source.safe = 'value';
    const original = `${JSON.stringify(source)}${' '.repeat(700)}`;
    const replacement = compactRequired(original, 'tool_input', compactLimits(512, 600));
    const compacted = JSON.parse(replacement) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(compacted, '__proto__')).toBe(true);
    expect(compacted.__proto__).toEqual({ polluted: true });
    expect(compacted.constructor).toEqual({ prototype: { polluted: true } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('replaces containers entered at depth eight with a max-depth marker', () => {
    let source: unknown = ['leaf'];
    for (let depth = 0; depth < 8; depth += 1) {
      source = [source];
    }
    const original = `${JSON.stringify(source)}${' '.repeat(700)}`;
    const replacement = compactRequired(original, 'tool_input', compactLimits(512, 600));

    expect(replacement).toContain(
      '"__context_compact__":{"kind":"max-depth","originalType":"array"}',
    );
  });

  it('compacts whitespace-heavy JSON scalar values deterministically', () => {
    const original = `true${' '.repeat(700)}`;
    const limits = compactLimits(512, 600);

    expect(compactDefaultToolPayload(original, 'tool_input', limits)).toBe('true');
    expect(compactDefaultToolPayload(original, 'tool_input', limits)).toBe('true');
  });
});

describe('bounded fallbacks', () => {
  it.each(['9007199254740993', '-0', '1e400'])(
    'falls back from non-faithful JSON number %s',
    (numberSource) => {
      const original = `{"number":${numberSource}}${' '.repeat(700)}`;
      const replacement = compactRequired(original, 'tool_input', compactLimits(512, 600));

      expect(JSON.parse(replacement)).toMatchObject({
        __context_compact__: { kind: 'tool_input', format: 'json' },
      });
    },
  );

  it('always wraps invalid tool input in a valid JSON envelope', () => {
    const original = `{"broken":${'x'.repeat(1_000)}`;
    const replacement = compactRequired(original, 'tool_input', compactLimits());
    const envelope = JSON.parse(replacement) as {
      __context_compact__: Record<string, unknown>;
    };

    expect(replacement.length).toBeLessThanOrEqual(512);
    expect(envelope.__context_compact__).toMatchObject({
      version: 1,
      kind: 'tool_input',
      format: 'invalid-json',
      originalChars: original.length,
    });
  });

  it('uses a text marker for non-JSON tool results', () => {
    const original = `head-${'x'.repeat(900)}-tail`;
    const replacement = compactRequired(original, 'tool_result', compactLimits());

    expect(replacement.length).toBeLessThanOrEqual(512);
    expect(replacement).toContain(
      `...[context compacted: kind=tool_result, originalChars=${original.length}, omittedChars=`,
    );
    expect(() => JSON.parse(replacement)).toThrow();
  });

  it('uses a JSON envelope for a confirmed JSON tool result that cannot fit structurally', () => {
    const original = JSON.stringify('\\'.repeat(2_000));
    const replacement = compactRequired(original, 'tool_result', compactLimits());

    expect(replacement.length).toBeLessThanOrEqual(512);
    expect(JSON.parse(replacement)).toMatchObject({
      __context_compact__: { kind: 'tool_result', format: 'json' },
    });
  });

  it('does not inspect payloads beyond the fixed JSON cap', () => {
    const original = `{"value":"${'x'.repeat(DEFAULT_TOOL_PAYLOAD_JSON_INSPECTION_LIMIT)}"}`;
    expect(original.length).toBeGreaterThan(DEFAULT_TOOL_PAYLOAD_JSON_INSPECTION_LIMIT);

    const inputReplacement = compactRequired(
      original,
      'tool_input',
      DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolInput,
    );
    expect(JSON.parse(inputReplacement)).toMatchObject({
      __context_compact__: { format: 'not-inspected' },
    });

    const resultReplacement = compactRequired(
      original,
      'tool_result',
      DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolResult,
    );
    expect(resultReplacement).toContain('kind=tool_result');
    expect(() => JSON.parse(resultReplacement)).toThrow();
  });

  it('iteratively shrinks escape-heavy envelope previews to the strict target', () => {
    const original = JSON.stringify('\\"'.repeat(1_000));
    const replacement = compactRequired(original, 'tool_input', compactLimits());
    const envelope = JSON.parse(replacement) as {
      __context_compact__: { head: string; tail: string; omittedChars: number };
    };

    expect(replacement.length).toBeLessThanOrEqual(512);
    expect(envelope.__context_compact__.omittedChars).toBeGreaterThan(0);
    expect(
      envelope.__context_compact__.head.length + envelope.__context_compact__.tail.length,
    ).toBeLessThan(original.length);
  });

  it('does not split valid surrogate pairs at preview boundaries', () => {
    const original = `prefix-${'😀'.repeat(1_000)}-tail`;
    const inputReplacement = compactRequired(original, 'tool_input', compactLimits());
    const inputEnvelope = JSON.parse(inputReplacement) as {
      __context_compact__: { head: string; tail: string };
    };
    const resultReplacement = compactRequired(original, 'tool_result', compactLimits());
    const [resultHead = '', resultTail = ''] = resultReplacement.split(
      /\n\.\.\.\[context compacted:.*\n/s,
    );

    expect(containsLoneSurrogate(inputEnvelope.__context_compact__.head)).toBe(false);
    expect(containsLoneSurrogate(inputEnvelope.__context_compact__.tail)).toBe(false);
    expect(containsLoneSurrogate(resultHead)).toBe(false);
    expect(containsLoneSurrogate(resultTail)).toBe(false);
  });

  it('is idempotent because every replacement is below its trigger threshold', () => {
    const original = 'not-json:'.repeat(200);
    const limits = compactLimits();
    const replacement = compactRequired(original, 'tool_result', limits);

    expect(replacement.length).toBeLessThanOrEqual(limits.targetChars);
    expect(compactDefaultToolPayload(replacement, 'tool_result', limits)).toBeUndefined();
  });
});
