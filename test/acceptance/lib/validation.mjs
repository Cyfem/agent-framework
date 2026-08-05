import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function assert(condition, message) {
  if (!condition) {
    throw new ValidationError(message);
  }
}

export function assertObject(value, field) {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${field} must be an object`,
  );
}

export function assertExactKeys(value, allowed, field) {
  assertObject(value, field);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    assert(allowedSet.has(key), `${field}.${key} is not supported`);
  }
}

export function assertString(value, field, pattern) {
  assert(typeof value === 'string' && value.length > 0, `${field} must be a non-empty string`);
  if (pattern) {
    assert(pattern.test(value), `${field} has an invalid format`);
  }
}

export function assertEnum(value, allowed, field) {
  assert(allowed.includes(value), `${field} must be one of: ${allowed.join(', ')}`);
}

export function assertInteger(value, field) {
  assert(Number.isSafeInteger(value) && value >= 0, `${field} must be a non-negative safe integer`);
}

export function assertArray(value, field) {
  assert(Array.isArray(value), `${field} must be an array`);
}

export function assertUnique(values, field) {
  const seen = new Set();
  for (const value of values) {
    assert(!seen.has(value), `${field} contains duplicate value ${JSON.stringify(value)}`);
    seen.add(value);
  }
}

export function assertDigest(value, field) {
  assertString(value, field, /^sha256:[a-f0-9]{64}$/u);
}

export function assertSafeRelativePath(value, field) {
  assertString(value, field);
  assert(!value.includes('\\'), `${field} must use portable forward slashes`);
  assert(!value.includes('\0'), `${field} contains a NUL byte`);
  assert(!path.posix.isAbsolute(value), `${field} must be relative`);
  assert(!/^[a-zA-Z]:/u.test(value), `${field} must not contain a drive prefix`);
  assert(!/^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(value), `${field} must not be a URL`);
  const segments = value.split('/');
  assert(
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    `${field} contains an unsafe path segment`,
  );
}

export async function resolveExistingRepoPath(repoRoot, relativePath, field) {
  assertSafeRelativePath(relativePath, field);
  const root = await realpath(repoRoot);
  const candidate = path.resolve(root, ...relativePath.split('/'));
  const resolved = await realpath(candidate).catch(() => null);
  assert(resolved !== null, `${field} does not exist: ${relativePath}`);
  const prefix = `${root}${path.sep}`;
  assert(
    resolved === root || resolved.startsWith(prefix),
    `${field} resolves outside the repository`,
  );
  const metadata = await stat(resolved);
  assert(metadata.isFile(), `${field} must reference a file`);
  return resolved;
}

export function rejectCostFields(value, field = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectCostFields(item, `${field}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const accountingKey = key.replace(/[^a-z]/giu, '').toLowerCase();
    assert(
      !accountingKey.includes('cost') &&
        !accountingKey.includes('currency') &&
        accountingKey !== 'cny' &&
        accountingKey !== 'afp',
      `${field}.${key} is forbidden; provider accounting is call/token based`,
    );
    rejectCostFields(nested, `${field}.${key}`);
  }
}

export async function readJson(filePath) {
  const source = await readFile(filePath, 'utf8');
  assert(
    Buffer.byteLength(source, 'utf8') <= 16 * 1024 * 1024,
    `${filePath} exceeds the 16 MiB validation limit`,
  );
  try {
    return JSON.parse(source.replace(/^\uFEFF/u, ''));
  } catch (error) {
    throw new ValidationError(
      `${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function parseCliArgs(argv) {
  const options = new Map();
  for (const arg of argv) {
    assert(arg.startsWith('--'), `unexpected positional argument: ${arg}`);
    const separator = arg.indexOf('=');
    const key = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    const value = separator === -1 ? true : arg.slice(separator + 1);
    assert(key.length > 0 && !options.has(key), `duplicate or empty option: ${arg}`);
    options.set(key, value);
  }
  return options;
}

export function printFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[subagent-v2 validation] ${message}\n`);
}
