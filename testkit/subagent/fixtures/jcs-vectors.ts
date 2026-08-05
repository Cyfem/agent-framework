export interface JcsGoldenVector {
  readonly name: string;
  readonly value: unknown;
  readonly canonical: string;
  readonly utf8Bytes: number;
  readonly sha256: string;
}

export interface JsonRejectionVector {
  readonly name: string;
  readonly create: () => unknown;
  readonly reason: string;
}

export interface JsonParseRejectionVector {
  readonly name: string;
  readonly source: string;
  readonly reason: string;
}

export const JCS_GOLDEN_VECTORS = [
  {
    name: 'RFC 8785 section 3.2.2 example',
    value: {
      numbers: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 1e-27],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    },
    canonical:
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    utf8Bytes: 118,
    sha256: '2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb',
  },
  {
    name: 'RFC 8785 UTF-16 property sorting',
    value: {
      '\u20ac': 'Euro sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew letter Dalet with Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    },
    canonical:
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro sign","😀":"Emoji: Grinning Face","דּ":"Hebrew letter Dalet with Dagesh"}',
    utf8Bytes: 180,
    sha256: '15b78d1a6322aa82db97e7623abc0627cd0ee1782e693dc41e4e118de157dca9',
  },
  {
    name: 'ECMAScript number formatting and negative zero',
    value: [0, -0, 5e-324, 1.7976931348623157e308, 1e23, 1e21, 1e20, 1e-6, 1e-7],
    canonical:
      '[0,0,5e-324,1.7976931348623157e+308,1e+23,1e+21,100000000000000000000,0.000001,1e-7]',
    utf8Bytes: 84,
    sha256: '5c3480eaadd6e5ad759ae8743bbf2b58fc038d0e3aec21e14afb613761e77500',
  },
  {
    name: 'Unicode is preserved without normalization',
    value: { é: 'é', 'e\u0301': 'e\u0301' },
    canonical: '{"é":"é","é":"é"}',
    utf8Bytes: 23,
    sha256: '2b8599359615227d4bffe298511d6d9520d9cf98c59adf9541e6e023e41ffe7b',
  },
] as const satisfies readonly JcsGoldenVector[];

export const JSON_REJECTION_VECTORS = [
  { name: 'undefined', create: () => undefined, reason: 'unsupported-type' },
  { name: 'bigint', create: () => 1n, reason: 'unsupported-type' },
  { name: 'symbol', create: () => Symbol('value'), reason: 'unsupported-type' },
  { name: 'function', create: () => () => undefined, reason: 'unsupported-type' },
  { name: 'NaN', create: () => Number.NaN, reason: 'non-finite-number' },
  {
    name: 'positive infinity',
    create: () => Number.POSITIVE_INFINITY,
    reason: 'non-finite-number',
  },
  {
    name: 'class instance',
    create: () => new (class JsonFixture {})(),
    reason: 'non-plain-object',
  },
  { name: 'Date', create: () => new Date(0), reason: 'non-plain-object' },
  { name: 'Map', create: () => new Map(), reason: 'non-plain-object' },
  { name: 'Set', create: () => new Set(), reason: 'non-plain-object' },
  {
    name: 'toJSON property',
    create: () => ({ toJSON: () => ({}) }),
    reason: 'to-json',
  },
  {
    name: 'array toJSON property',
    create: () => Object.defineProperty([], 'toJSON', { value: () => [] }),
    reason: 'to-json',
  },
  {
    name: 'Array subclass',
    create: () => new (class JsonArrayFixture extends Array<unknown> {})(),
    reason: 'non-plain-object',
  },
  {
    name: 'accessor property',
    create: () =>
      Object.defineProperty({}, 'value', {
        get: () => 'must not run',
        enumerable: true,
      }),
    reason: 'accessor-property',
  },
  {
    name: 'symbol key',
    create: () => Object.defineProperty({}, Symbol('hidden'), { value: true }),
    reason: 'symbol-key',
  },
  {
    name: 'non-enumerable property',
    create: () => Object.defineProperty({}, 'hidden', { value: true }),
    reason: 'non-enumerable-property',
  },
  {
    name: 'sparse array',
    create: () => {
      const value: unknown[] = [];
      value.length = 2;
      value[1] = true;
      return value;
    },
    reason: 'sparse-array',
  },
  {
    name: 'array with extra property',
    create: () => Object.defineProperty([], 'extra', { value: true, enumerable: true }),
    reason: 'extra-array-property',
  },
  {
    name: 'cyclic object',
    create: () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    },
    reason: 'cyclic-reference',
  },
  { name: 'lone high surrogate value', create: () => '\ud800', reason: 'lone-surrogate' },
  { name: 'lone low surrogate value', create: () => '\udfff', reason: 'lone-surrogate' },
  {
    name: 'lone surrogate object key',
    create: () => ({ ['\ud800']: true }),
    reason: 'lone-surrogate',
  },
] as const satisfies readonly JsonRejectionVector[];

export const JSON_PARSE_REJECTION_VECTORS = [
  { name: 'literal duplicate key', source: '{"a":1,"a":2}', reason: 'duplicate-key' },
  { name: 'escaped duplicate key', source: '{"a":1,"\\u0061":2}', reason: 'duplicate-key' },
  {
    name: 'nested duplicate key',
    source: '{"outer":{"a":1,"a":2}}',
    reason: 'duplicate-key',
  },
  { name: 'non-finite number', source: '1e400', reason: 'non-finite-number' },
  { name: 'lone escaped surrogate', source: '"\\ud800"', reason: 'lone-surrogate' },
  {
    name: 'lone escaped surrogate key',
    source: '{"\\udfff":true}',
    reason: 'lone-surrogate',
  },
  { name: 'trailing comma', source: '[1,]', reason: 'invalid-syntax' },
  { name: 'leading zero', source: '01', reason: 'invalid-syntax' },
  { name: 'unquoted member', source: '{a:1}', reason: 'invalid-syntax' },
] as const satisfies readonly JsonParseRejectionVector[];
