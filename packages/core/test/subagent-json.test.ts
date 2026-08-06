import { describe, expect, it } from 'vitest';
import { acceptanceIt } from '../../../testkit';

import {
  JSON_PARSE_REJECTION_VECTORS,
  JSON_REJECTION_VECTORS,
  JCS_GOLDEN_VECTORS,
} from '../../../testkit/subagent/fixtures/jcs-vectors';
import {
  assertJsonByteLimit,
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonBytes,
  canonicalJsonSha256,
  canonicalizeJson,
  isJsonValue,
  JsonValueError,
  measureCanonicalJsonBytes,
  parseJsonValue,
  type JsonValue,
} from '../src/subagent/json';

describe('RFC 8785 canonical JSON', () => {
  for (const vector of JCS_GOLDEN_VECTORS) {
    it(`matches the ${vector.name} golden vector`, () => {
      const value = vector.value as JsonValue;

      expect(canonicalizeJson(value)).toBe(vector.canonical);
      expect(new TextDecoder().decode(canonicalJsonBytes(value))).toBe(vector.canonical);
      expect(measureCanonicalJsonBytes(value)).toBe(vector.utf8Bytes);
      expect(canonicalJsonByteLength(value)).toBe(vector.utf8Bytes);
      expect(canonicalJsonSha256(value)).toBe(vector.sha256);
    });
  }

  it('sorts member names by raw UTF-16 code units and retains array order', () => {
    const value = {
      '\ufffd': 4,
      '😀': 3,
      '\ud834\udd1e': 2,
      a: [3, 2, 1],
    };

    expect(canonicalizeJson(value)).toBe('{"a":[3,2,1],"𝄞":2,"😀":3,"�":4}');
  });

  it('uses the JSON escaping required by JCS without escaping slash or Unicode scalars', () => {
    expect(canonicalizeJson('"\\/\b\f\n\r\t\u0000€')).toBe('"\\"\\\\/\\b\\f\\n\\r\\t\\u0000€"');
  });
});

describe('strict JSON-safe validation', () => {
  for (const vector of JSON_REJECTION_VECTORS) {
    it(`rejects ${vector.name}`, () => {
      const value = vector.create();

      expect(isJsonValue(value)).toBe(false);
      expect(() => assertJsonValue(value)).toThrowError(
        expect.objectContaining({
          name: 'JsonValueError',
          code: 'INVALID_JSON_VALUE',
          reason: vector.reason,
        }),
      );
    });
  }

  it('does not execute accessors or toJSON while rejecting them', () => {
    let getterCalls = 0;
    let toJsonCalls = 0;
    const withAccessor = Object.defineProperty({}, 'value', {
      get: () => {
        getterCalls += 1;
        return true;
      },
      enumerable: true,
    });
    const withToJson = {
      toJSON: () => {
        toJsonCalls += 1;
        return {};
      },
    };

    expect(() => assertJsonValue(withAccessor)).toThrowError(JsonValueError);
    expect(() => assertJsonValue(withToJson)).toThrowError(JsonValueError);
    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
  });

  it('accepts duplicate references, null-prototype records, and frozen dense arrays', () => {
    const shared = { marker: true };
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.shared = shared;
    nullPrototype.items = Object.freeze([shared, shared]);

    expect(isJsonValue(nullPrototype)).toBe(true);
    expect(canonicalizeJson(nullPrototype as JsonValue)).toBe(
      '{"items":[{"marker":true},{"marker":true}],"shared":{"marker":true}}',
    );
  });

  it('enforces structural limits for in-memory JSON values without rejecting shared references', () => {
    const shared = { proof: true };
    const value = { items: [shared, shared] };

    expect(() => assertJsonValue(value, { maxDepth: 3, maxNodes: 6 })).not.toThrow();
    expect(() => assertJsonValue(value, { maxDepth: 2 })).toThrowError(
      expect.objectContaining({ reason: 'depth-limit-exceeded' }),
    );
    expect(() => assertJsonValue(value, { maxNodes: 5 })).toThrowError(
      expect.objectContaining({ reason: 'node-limit-exceeded' }),
    );
  });

  it('reports the precise nested path without reading the invalid value', () => {
    const candidate = { outer: [{ value: undefined }] };

    expect(() => assertJsonValue(candidate)).toThrowError(
      expect.objectContaining({
        reason: 'unsupported-type',
        path: '$["outer"][0]["value"]',
      }),
    );
  });
});

describe('duplicate-aware JSON parsing', () => {
  it('parses every JSON value shape and preserves dangerous keys as data properties', () => {
    const parsed = parseJsonValue(
      ' { "__proto__": {"safe":true}, "constructor": null, "items": [1,-0,"😀"] } ',
    );

    expect(parsed).toEqual({
      ['__proto__']: { safe: true },
      constructor: null,
      items: [1, -0, '😀'],
    });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(canonicalizeJson(parsed)).toBe(
      '{"__proto__":{"safe":true},"constructor":null,"items":[1,0,"😀"]}',
    );
  });

  for (const vector of JSON_PARSE_REJECTION_VECTORS) {
    it(`rejects ${vector.name}`, () => {
      expect(() => parseJsonValue(vector.source)).toThrowError(
        expect.objectContaining({ reason: vector.reason }),
      );
    });
  }

  it('compares duplicate names after JSON escape decoding without Unicode normalization', () => {
    expect(() => parseJsonValue('{"\\u0061":1,"a":2}')).toThrowError(
      expect.objectContaining({ reason: 'duplicate-key' }),
    );
    expect(parseJsonValue('{"é":1,"e\\u0301":2}')).toEqual({ é: 1, é: 2 });
  });

  it('rejects trailing data, empty input, malformed escapes, and raw controls', () => {
    for (const source of ['', 'true false', '"\\x20"', '"\u0000"', '{"a" 1}']) {
      expect(() => parseJsonValue(source)).toThrowError(
        expect.objectContaining({ reason: 'invalid-syntax' }),
      );
    }
  });

  it('enforces parser depth before recursively expanding hostile JSON', () => {
    expect(parseJsonValue('{"items":[1]}', { maxDepth: 2 })).toEqual({ items: [1] });
    expect(() => parseJsonValue('{"items":[1]}', { maxDepth: 1 })).toThrowError(
      expect.objectContaining({
        reason: 'depth-limit-exceeded',
        path: '$["items"][0]',
      }),
    );

    const hostile = `${'['.repeat(10_000)}0${']'.repeat(10_000)}`;
    expect(() => parseJsonValue(hostile, { maxDepth: 128 })).toThrowError(
      expect.objectContaining({ reason: 'depth-limit-exceeded' }),
    );
  });

  it('counts every parsed JSON value against the configured node limit', () => {
    expect(parseJsonValue('{"items":[1]}', { maxNodes: 3 })).toEqual({ items: [1] });
    expect(() => parseJsonValue('{"items":[1]}', { maxNodes: 2 })).toThrowError(
      expect.objectContaining({
        reason: 'node-limit-exceeded',
        path: '$["items"][0]',
      }),
    );
  });

  it('rejects invalid parser structural limits before reading input', () => {
    for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseJsonValue('null', { maxDepth: value })).toThrowError(TypeError);
      expect(() => parseJsonValue('null', { maxNodes: value })).toThrowError(TypeError);
    }
  });
});

describe('canonical JSON byte boundaries', () => {
  it('allows an exact UTF-8 byte limit and rejects one byte over it', () => {
    const value = '€';
    expect(measureCanonicalJsonBytes(value)).toBe(5);

    expect(() => assertJsonValue(value, { maxBytes: 5, label: 'input' })).not.toThrow();
    expect(() => assertJsonByteLimit(value, 5, 'input')).not.toThrow();
    expect(parseJsonValue('"€"', 5)).toBe(value);

    for (const action of [
      () => assertJsonValue(value, { maxBytes: 4, label: 'input' }),
      () => assertJsonByteLimit(value, 4, 'input'),
      () => parseJsonValue('"€"', 4),
    ]) {
      expect(action).toThrowError(
        expect.objectContaining({
          reason: 'byte-limit-exceeded',
          actualBytes: 5,
          maxBytes: 4,
        }),
      );
    }
  });

  it('measures canonical content instead of source whitespace', () => {
    expect(parseJsonValue('  { "a" : 1 }  ', 7)).toEqual({ a: 1 });
    expect(() => parseJsonValue('  { "a" : 1 }  ', 6)).toThrowError(
      expect.objectContaining({ reason: 'byte-limit-exceeded' }),
    );
  });

  it('rejects invalid byte limit configuration', () => {
    for (const maxBytes of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertJsonValue(null, maxBytes)).toThrowError(TypeError);
    }
  });
});

acceptanceIt('JSON-01.l1.jcs', 'jcs', () => {
  const value = { z: -0, a: ['e\u0301', '\u00e9'] } as const;
  expect(canonicalizeJson(value)).toBe('{"a":["é","é"],"z":0}');
  expect(parseJsonValue(canonicalizeJson(value))).toEqual({ a: ['é', 'é'], z: 0 });
});
