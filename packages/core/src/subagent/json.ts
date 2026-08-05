import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonValueErrorReason =
  | 'unsupported-type'
  | 'non-finite-number'
  | 'lone-surrogate'
  | 'non-plain-object'
  | 'proxy-object'
  | 'to-json'
  | 'accessor-property'
  | 'symbol-key'
  | 'non-enumerable-property'
  | 'sparse-array'
  | 'extra-array-property'
  | 'cyclic-reference'
  | 'invalid-syntax'
  | 'duplicate-key'
  | 'byte-limit-exceeded';

export interface JsonValueBoundaryOptions {
  readonly maxBytes?: number;
  readonly label?: string;
}

export interface JsonValueErrorOptions {
  readonly path?: string;
  readonly position?: number;
  readonly maxBytes?: number;
  readonly actualBytes?: number;
}

export type JsonBoundaryOptions = JsonValueBoundaryOptions;

/** A stable validation error for the Subagent JSON boundary. */
export class JsonValueError extends TypeError {
  readonly code = 'INVALID_JSON_VALUE';
  readonly reason: JsonValueErrorReason;
  readonly path: string;
  readonly position?: number;
  readonly maxBytes?: number;
  readonly actualBytes?: number;

  constructor(reason: JsonValueErrorReason, message: string, options: JsonValueErrorOptions = {}) {
    super(message);
    this.name = 'JsonValueError';
    this.reason = reason;
    this.path = options.path ?? '$';
    if (options.position !== undefined) this.position = options.position;
    if (options.maxBytes !== undefined) this.maxBytes = options.maxBytes;
    if (options.actualBytes !== undefined) this.actualBytes = options.actualBytes;
  }
}

export { JsonValueError as JsonValidationError };

const textEncoder = new TextEncoder();
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/u;

function valueError(reason: JsonValueErrorReason, message: string, path: string): never {
  throw new JsonValueError(reason, `${message} (at ${path})`, { path });
}

function propertyPath(parent: string, key: string): string {
  return `${parent}[${JSON.stringify(key)}]`;
}

function arrayPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);

    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        valueError('lone-surrogate', 'JSON strings must not contain a lone high surrogate', path);
      }
      index += 1;
      continue;
    }

    if (current >= 0xdc00 && current <= 0xdfff) {
      valueError('lone-surrogate', 'JSON strings must not contain a lone low surrogate', path);
    }
  }
}

function assertDataDescriptor(
  descriptor: PropertyDescriptor,
  path: string,
): asserts descriptor is PropertyDescriptor & { value: unknown } {
  if (!('value' in descriptor)) {
    valueError('accessor-property', 'JSON values must not contain accessor properties', path);
  }

  if (descriptor.enumerable !== true) {
    valueError('non-enumerable-property', 'JSON object properties must be enumerable', path);
  }
}

function assertArray(value: readonly unknown[], path: string, ancestors: Set<object>): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    valueError('non-plain-object', 'JSON arrays must use Array.prototype', path);
  }

  const ownKeys = Reflect.ownKeys(value);

  if (ownKeys.some((key) => typeof key === 'symbol')) {
    valueError('symbol-key', 'JSON arrays must not contain symbol-keyed properties', path);
  }

  if (ownKeys.includes('toJSON')) {
    valueError(
      'to-json',
      'JSON values must not define a toJSON property',
      propertyPath(path, 'toJSON'),
    );
  }

  for (const key of ownKeys) {
    if (typeof key !== 'string' || key === 'length') continue;
    const numericIndex = ARRAY_INDEX.test(key) ? Number(key) : -1;
    if (!Number.isSafeInteger(numericIndex) || numericIndex < 0 || numericIndex >= value.length) {
      valueError(
        'extra-array-property',
        `JSON arrays must not contain the extra property ${JSON.stringify(key)}`,
        propertyPath(path, key),
      );
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    const itemPath = arrayPath(path, index);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      valueError('sparse-array', 'JSON arrays must not contain holes', itemPath);
    }
    assertDataDescriptor(descriptor, itemPath);
    validateJsonValue(descriptor.value, itemPath, ancestors);
  }
}

function assertRecord(
  value: Record<PropertyKey, unknown>,
  path: string,
  ancestors: Set<object>,
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    valueError(
      'non-plain-object',
      'JSON objects must use Object.prototype or a null prototype',
      path,
    );
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    valueError('symbol-key', 'JSON objects must not contain symbol-keyed properties', path);
  }

  if (ownKeys.includes('toJSON')) {
    valueError(
      'to-json',
      'JSON values must not define a toJSON property',
      propertyPath(path, 'toJSON'),
    );
  }

  for (const key of ownKeys) {
    if (typeof key !== 'string') continue;
    const childPath = propertyPath(path, key);
    assertUnicodeScalarString(key, childPath);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      valueError('unsupported-type', 'JSON property disappeared during validation', childPath);
    }
    assertDataDescriptor(descriptor, childPath);
    validateJsonValue(descriptor.value, childPath, ancestors);
  }
}

function validateJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'boolean') return;

  if (typeof value === 'string') {
    assertUnicodeScalarString(value, path);
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      valueError('non-finite-number', 'JSON numbers must be finite', path);
    }
    return;
  }

  if (typeof value !== 'object') {
    valueError('unsupported-type', `Unsupported JSON value type: ${typeof value}`, path);
  }

  if (nodeTypes.isProxy(value)) {
    valueError('proxy-object', 'Proxy objects are not accepted at the JSON boundary', path);
  }

  if (ancestors.has(value)) {
    valueError('cyclic-reference', 'JSON values must not contain cycles', path);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertArray(value, path, ancestors);
    } else {
      assertRecord(value as Record<PropertyKey, unknown>, path, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function normalizeBoundaryOptions(
  options: number | JsonValueBoundaryOptions | undefined,
): JsonValueBoundaryOptions {
  const normalized = typeof options === 'number' ? { maxBytes: options } : (options ?? {});
  if (
    normalized.maxBytes !== undefined &&
    (!Number.isSafeInteger(normalized.maxBytes) || normalized.maxBytes < 0)
  ) {
    throw new TypeError('maxBytes must be a non-negative safe integer.');
  }
  return normalized;
}

function serializeValidated(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }

  if (typeof value === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeValidated(item)).join(',')}]`;
  }

  const object = value as { readonly [key: string]: JsonValue };
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeValidated(object[key] as JsonValue)}`);
  return `{${entries.join(',')}}`;
}

function assertByteCount(actualBytes: number, maxBytes: number, label: string): void {
  if (actualBytes <= maxBytes) return;

  throw new JsonValueError(
    'byte-limit-exceeded',
    `${label} is ${actualBytes} canonical UTF-8 bytes; maximum is ${maxBytes}`,
    { actualBytes, maxBytes },
  );
}

export function isJsonValue(
  value: unknown,
  options?: number | JsonValueBoundaryOptions,
): value is JsonValue {
  try {
    assertJsonValue(value, options);
    return true;
  } catch {
    return false;
  }
}

export function assertJsonValue(
  value: unknown,
  options?: number | JsonValueBoundaryOptions,
): asserts value is JsonValue {
  const normalized = normalizeBoundaryOptions(options);
  validateJsonValue(value, '$', new Set());

  if (normalized.maxBytes !== undefined) {
    const canonical = serializeValidated(value as JsonValue);
    assertByteCount(
      textEncoder.encode(canonical).byteLength,
      normalized.maxBytes,
      normalized.label ?? 'JSON value',
    );
  }
}

export function canonicalizeJson(value: JsonValue): string {
  assertJsonValue(value);
  return serializeValidated(value);
}

export function canonicalJsonBytes(value: JsonValue): Uint8Array {
  return textEncoder.encode(canonicalizeJson(value));
}

export function measureCanonicalJsonBytes(value: JsonValue): number {
  return canonicalJsonBytes(value).byteLength;
}

export const canonicalJsonByteLength = measureCanonicalJsonBytes;

export function canonicalJsonSha256(value: JsonValue): string {
  return createHash('sha256').update(canonicalJsonBytes(value)).digest('hex');
}

export function assertJsonByteLimit(
  value: JsonValue,
  maxBytes: number,
  label = 'JSON value',
): void {
  const normalized = normalizeBoundaryOptions({ maxBytes, label });
  assertJsonValue(value);
  assertByteCount(measureCanonicalJsonBytes(value), normalized.maxBytes as number, label);
}

class DuplicateAwareJsonParser {
  #index = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    this.#skipWhitespace();
    const value = this.#parseValue('$');
    this.#skipWhitespace();
    if (this.#index !== this.source.length) {
      this.#fail('invalid-syntax', 'Unexpected trailing JSON input');
    }
    return value;
  }

  #parseValue(path: string): JsonValue {
    const current = this.source[this.#index];
    if (current === '"') return this.#parseString(path);
    if (current === '{') return this.#parseObject(path);
    if (current === '[') return this.#parseArray(path);
    if (current === 't') return this.#parseLiteral('true', true);
    if (current === 'f') return this.#parseLiteral('false', false);
    if (current === 'n') return this.#parseLiteral('null', null);
    if (current === '-' || (current !== undefined && current >= '0' && current <= '9')) {
      return this.#parseNumber(path);
    }
    this.#fail('invalid-syntax', 'Expected a JSON value', path);
  }

  #parseLiteral<T extends JsonPrimitive>(literal: string, value: T): T {
    if (this.source.slice(this.#index, this.#index + literal.length) !== literal) {
      this.#fail('invalid-syntax', `Expected ${literal}`);
    }
    this.#index += literal.length;
    return value;
  }

  #parseNumber(path: string): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.source.slice(this.#index),
    );
    if (match === null) this.#fail('invalid-syntax', 'Invalid JSON number', path);
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      this.#fail('non-finite-number', 'JSON number is outside the finite IEEE-754 range', path);
    }
    return value;
  }

  #parseString(path: string): string {
    const start = this.#index;
    this.#index += 1;
    let result = '';

    while (this.#index < this.source.length) {
      const current = this.source[this.#index] as string;
      this.#index += 1;

      if (current === '"') {
        assertUnicodeScalarString(result, path);
        return result;
      }

      if (current === '\\') {
        const escaped = this.source[this.#index];
        this.#index += 1;
        switch (escaped) {
          case '"':
          case '\\':
          case '/':
            result += escaped;
            break;
          case 'b':
            result += '\b';
            break;
          case 'f':
            result += '\f';
            break;
          case 'n':
            result += '\n';
            break;
          case 'r':
            result += '\r';
            break;
          case 't':
            result += '\t';
            break;
          case 'u': {
            const hexadecimal = this.source.slice(this.#index, this.#index + 4);
            if (!/^[\da-fA-F]{4}$/u.test(hexadecimal)) {
              this.#fail('invalid-syntax', 'Invalid JSON Unicode escape', path);
            }
            result += String.fromCharCode(Number.parseInt(hexadecimal, 16));
            this.#index += 4;
            break;
          }
          default:
            this.#fail('invalid-syntax', 'Invalid JSON string escape', path);
        }
        continue;
      }

      if (current.charCodeAt(0) <= 0x1f) {
        this.#fail('invalid-syntax', 'Unescaped control character in JSON string', path);
      }
      result += current;
    }

    this.#index = start;
    this.#fail('invalid-syntax', 'Unterminated JSON string', path);
  }

  #parseArray(path: string): JsonValue[] {
    this.#index += 1;
    this.#skipWhitespace();
    const result: JsonValue[] = [];
    if (this.source[this.#index] === ']') {
      this.#index += 1;
      return result;
    }

    while (true) {
      result.push(this.#parseValue(arrayPath(path, result.length)));
      this.#skipWhitespace();
      const separator = this.source[this.#index];
      this.#index += 1;
      if (separator === ']') return result;
      if (separator !== ',')
        this.#fail('invalid-syntax', 'Expected a comma or closing bracket', path);
      this.#skipWhitespace();
    }
  }

  #parseObject(path: string): { [key: string]: JsonValue } {
    this.#index += 1;
    this.#skipWhitespace();
    const result: { [key: string]: JsonValue } = {};
    const keys = new Set<string>();
    if (this.source[this.#index] === '}') {
      this.#index += 1;
      return result;
    }

    while (true) {
      if (this.source[this.#index] !== '"') {
        this.#fail('invalid-syntax', 'Expected a JSON object member name', path);
      }
      const key = this.#parseString(path);
      const childPath = propertyPath(path, key);
      if (keys.has(key)) {
        this.#fail(
          'duplicate-key',
          `Duplicate JSON object member ${JSON.stringify(key)}`,
          childPath,
        );
      }
      keys.add(key);
      this.#skipWhitespace();
      if (this.source[this.#index] !== ':') {
        this.#fail('invalid-syntax', 'Expected a colon after JSON object member name', childPath);
      }
      this.#index += 1;
      this.#skipWhitespace();
      const value = this.#parseValue(childPath);
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.#skipWhitespace();
      const separator = this.source[this.#index];
      this.#index += 1;
      if (separator === '}') return result;
      if (separator !== ',')
        this.#fail('invalid-syntax', 'Expected a comma or closing brace', path);
      this.#skipWhitespace();
    }
  }

  #skipWhitespace(): void {
    while (true) {
      const codeUnit = this.source.charCodeAt(this.#index);
      if (codeUnit !== 0x09 && codeUnit !== 0x0a && codeUnit !== 0x0d && codeUnit !== 0x20) {
        return;
      }
      this.#index += 1;
    }
  }

  #fail(reason: JsonValueErrorReason, message: string, path = '$'): never {
    throw new JsonValueError(reason, `${message} at character ${this.#index} (at ${path})`, {
      path,
      position: this.#index,
    });
  }
}

export function parseJsonValue(
  source: string,
  options?: number | JsonValueBoundaryOptions,
): JsonValue {
  if (typeof source !== 'string') {
    throw new TypeError('parseJsonValue source must be a string.');
  }
  const value = new DuplicateAwareJsonParser(source).parse();
  assertJsonValue(value, options);
  return value;
}
