import { types as nodeTypes } from 'node:util';

const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get as (this: ArrayBuffer) => number;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer')
  ?.get as (this: Uint8Array) => ArrayBufferLike;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteOffset',
)?.get as (this: Uint8Array) => number;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get as (this: Uint8Array) => number;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

export type HttpBytes = Uint8Array | ArrayBuffer;

export function observedHttpByteLength(value: unknown, label: string): number {
  if (nodeTypes.isProxy(value)) throw new TypeError(`${label} must not be a Proxy.`);
  if (value instanceof Uint8Array) {
    return Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
  }
  if (value instanceof ArrayBuffer) {
    return Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, value, []);
  }
  throw new TypeError(`${label} must be a Uint8Array or ArrayBuffer.`);
}

export function copyHttpBytes(value: HttpBytes, label: string, maxBytes: number): Uint8Array {
  const observed = observedHttpByteLength(value, label);
  if (observed > maxBytes) throw new RangeError(`${label} exceeds the configured byte limit.`);

  let source: Uint8Array;
  if (value instanceof Uint8Array) {
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
    const offset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, value, []);
    source = new Uint8Array(buffer, offset, observed);
  } else {
    source = new Uint8Array(value, 0, observed);
  }
  const owned = new Uint8Array(observed);
  Reflect.apply(UINT8_ARRAY_SET, owned, [source]);
  return owned;
}

export function requireClosedDataRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError(`${label} contains unsupported or missing fields.`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must contain only enumerable data properties.`);
    }
  }
  return value as Record<string, unknown>;
}

export function requireAllowedDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    throw new TypeError(`${label} contains unsupported fields.`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must contain only enumerable data properties.`);
    }
  }
  return value as Record<string, unknown>;
}

export function requireDenseDataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new TypeError(`${label} must be an array.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array.`);
  }
  const length = value.length;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must be a dense array of data properties.`);
    }
  }
  const allowedKeys = new Set<PropertyKey>([
    'length',
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (Reflect.ownKeys(value).some((key) => !allowedKeys.has(key))) {
    throw new TypeError(`${label} contains unsupported properties.`);
  }
  return value;
}

export function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

export function assertNonNegativeSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function concatHttpBytes(chunks: readonly Uint8Array[], maxBytes: number): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
    if (!Number.isSafeInteger(total) || total > maxBytes) {
      throw new RangeError('HTTP multipart body exceeds the configured byte limit.');
    }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    Reflect.apply(UINT8_ARRAY_SET, result, [chunk, offset]);
    offset += chunk.byteLength;
  }
  return result;
}
