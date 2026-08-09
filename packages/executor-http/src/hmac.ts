import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  HTTP_SUBAGENT_AUTH_HEADER_NAMES,
  HTTP_SUBAGENT_AUTH_VERSION,
  HTTP_SUBAGENT_DEFAULT_CLOCK_SKEW_MS,
  HTTP_SUBAGENT_HMAC_SCHEME,
  HTTP_SUBAGENT_REPLAY_TTL_MS,
} from './http-constants';
import {
  copyHttpBytes,
  requireAllowedDataRecord,
  requireClosedDataRecord,
  requireDenseDataArray,
  type HttpBytes,
} from './http-internal';
import { HTTP_SUBAGENT_MAX_MULTIPART_BODY_BYTES } from './multipart';
import { parseHttpSubAgentRoute, type HttpSubAgentRoute } from './http-route';

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const LOWER_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const MAX_RAW_HEADERS = 256;
const MAX_RAW_HEADER_CHARACTERS = 32 * 1024;
const MAX_HMAC_KEY_BYTES = 4 * 1024;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const REQUIRED_HEADERS = Object.freeze(Object.values(HTTP_SUBAGENT_AUTH_HEADER_NAMES));
const REQUIRED_HEADER_BY_LOWER_NAME = new Map(
  REQUIRED_HEADERS.map((name) => [name.toLowerCase(), name] as const),
);

export type HttpSubAgentSecurityMode = 'production' | 'loopback-test';
export type HttpSubAgentReplayCacheMode = 'distributed' | 'loopback-test';

export interface HttpSubAgentSecurityPolicy {
  readonly mode: HttpSubAgentSecurityMode;
}

export interface HttpSubAgentTransportFacts {
  readonly tls: boolean;
  readonly loopback: boolean;
  readonly requestTargetPreserved: boolean;
  readonly redirectCount: number;
}

export interface HttpSubAgentRawRequest {
  readonly method: string;
  readonly requestTarget: string;
  readonly rawHeaders: readonly string[];
  readonly body: HttpBytes;
  readonly transport: HttpSubAgentTransportFacts;
}

export interface HttpSubAgentReplayInput {
  readonly keyId: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface HttpSubAgentReplayCache {
  readonly mode: HttpSubAgentReplayCacheMode;
  consume(input: HttpSubAgentReplayInput): boolean | Promise<boolean>;
}

export interface HttpSubAgentResolvedHmacKey {
  readonly principalId: string;
  readonly key: HttpBytes;
}

export type HttpSubAgentHmacKeyResolver = (
  keyId: string,
) =>
  | HttpSubAgentResolvedHmacKey
  | null
  | undefined
  | Promise<HttpSubAgentResolvedHmacKey | null | undefined>;

export interface HttpSubAgentAuthContext {
  readonly scheme: typeof HTTP_SUBAGENT_HMAC_SCHEME;
  readonly keyId: string;
  readonly principalId: string;
  readonly timestamp: number;
  readonly correlationDigest: string;
}

export interface HttpSubAgentAuthenticatedRequest {
  readonly authContext: HttpSubAgentAuthContext;
  readonly route: HttpSubAgentRoute;
  /** Owned, single parsed Content-Type value; null means the HTTP header was missing or ambiguous. */
  readonly contentType: string | null;
  /** One owned snapshot shared by digest verification and multipart admission. */
  readonly body: Uint8Array;
}

export interface HttpSubAgentHmacHeaders extends Readonly<Record<string, string>> {
  readonly 'Manee-Auth-Version': typeof HTTP_SUBAGENT_AUTH_VERSION;
  readonly 'Manee-Key-Id': string;
  readonly 'Manee-Timestamp': string;
  readonly 'Manee-Nonce': string;
  readonly 'Manee-Body-SHA256': string;
  readonly 'Manee-Signature': string;
}

export interface CreateHttpSubAgentHmacHeadersInput {
  readonly method: string;
  readonly requestTarget: string;
  readonly body: HttpBytes;
  readonly keyId: string;
  readonly key: HttpBytes;
  readonly timestamp?: number;
  readonly nonce?: string;
}

export interface CreateHttpSubAgentHmacVerifierOptions {
  readonly securityPolicy: HttpSubAgentSecurityPolicy;
  readonly keyResolver: HttpSubAgentHmacKeyResolver;
  readonly replayCache: HttpSubAgentReplayCache;
  readonly now?: () => number;
  /** May only tighten the fixed 60-second protocol window. */
  readonly clockSkewMs?: number;
}

export interface HttpSubAgentHmacVerifier {
  verify(request: HttpSubAgentRawRequest): Promise<HttpSubAgentAuthenticatedRequest>;
}

export type HttpSubAgentSecurityErrorCategory = 'request-rejected' | 'dependency-unavailable';

/** A fixed, cause-free failure safe for admission-layer classification. */
export class HttpSubAgentSecurityError extends Error {
  readonly code = 'HTTP_SUBAGENT_SECURITY_ERROR';
  readonly category: HttpSubAgentSecurityErrorCategory;
  readonly statusCode: 401 | 503;

  constructor(category: HttpSubAgentSecurityErrorCategory) {
    const unavailable = category === 'dependency-unavailable';
    super(
      unavailable
        ? 'The HTTP Subagent security service is unavailable.'
        : 'The HTTP Subagent request was rejected.',
    );
    this.name = 'HttpSubAgentSecurityError';
    this.category = category;
    this.statusCode = unavailable ? 503 : 401;
  }
}

export interface StaticHttpSubAgentHmacKey {
  readonly keyId: string;
  readonly principalId: string;
  readonly key: HttpBytes;
}

/** Creates all six signed headers from one owned body snapshot. */
export function createHttpSubAgentHmacHeaders(
  input: CreateHttpSubAgentHmacHeadersInput,
): HttpSubAgentHmacHeaders {
  const record = requireAllowedDataRecord(
    input,
    ['method', 'requestTarget', 'body', 'keyId', 'key', 'timestamp', 'nonce'],
    'HTTP HMAC header input',
  );
  const route = parseHttpSubAgentRoute(record.method, record.requestTarget);
  const keyId = requireKeyId(record.keyId);
  const body = copyHttpBytes(
    record.body as HttpBytes,
    'HTTP HMAC body',
    HTTP_SUBAGENT_MAX_MULTIPART_BODY_BYTES,
  );
  const timestamp = record.timestamp ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0) {
    throw new RangeError('HTTP HMAC timestamp must be a non-negative safe integer.');
  }
  const nonceValue = record.nonce ?? randomBytes(32).toString('base64url');
  if (typeof nonceValue !== 'string') {
    throw new TypeError('HTTP HMAC nonce must be a string.');
  }
  const nonce = nonceValue;
  parseCanonicalBase64Url(nonce, 16, 64);
  const bodyDigest = sha256Hex(body);
  const canonical = canonicalSigningString({
    keyId,
    timestamp: String(timestamp),
    nonce,
    method: 'POST',
    requestTarget: route.requestTarget,
    bodyDigest,
  });
  const key = copyAndValidateKey(record.key, 'HTTP HMAC key');
  let signature: string;
  try {
    signature = createHmac('sha256', key).update(canonical, 'utf8').digest('base64url');
  } finally {
    Reflect.apply(UINT8_ARRAY_FILL, key, [0]);
  }
  return Object.freeze({
    [HTTP_SUBAGENT_AUTH_HEADER_NAMES.version]: HTTP_SUBAGENT_AUTH_VERSION,
    [HTTP_SUBAGENT_AUTH_HEADER_NAMES.keyId]: keyId,
    [HTTP_SUBAGENT_AUTH_HEADER_NAMES.timestamp]: String(timestamp),
    [HTTP_SUBAGENT_AUTH_HEADER_NAMES.nonce]: nonce,
    [HTTP_SUBAGENT_AUTH_HEADER_NAMES.bodySha256]: bodyDigest,
    [HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature]: signature,
  }) as HttpSubAgentHmacHeaders;
}

/** Creates a verifier that authenticates all seven exact routes and atomically consumes replay. */
export function createHttpSubAgentHmacVerifier(
  options: CreateHttpSubAgentHmacVerifierOptions,
): HttpSubAgentHmacVerifier {
  const record = requireAllowedDataRecord(
    options,
    ['securityPolicy', 'keyResolver', 'replayCache', 'now', 'clockSkewMs'],
    'HTTP HMAC verifier options',
  );
  const securityPolicy = normalizeSecurityPolicy(record.securityPolicy);
  if (typeof record.keyResolver !== 'function') {
    throw new TypeError('HTTP HMAC keyResolver must be a function.');
  }
  const replayCache = normalizeReplayCache(record.replayCache);
  if (securityPolicy.mode === 'production' && replayCache.mode !== 'distributed') {
    throw new TypeError('Production HTTP HMAC verification requires a distributed replay cache.');
  }
  const now = record.now ?? Date.now;
  if (typeof now !== 'function') throw new TypeError('HTTP HMAC now must be a function.');
  const clockSkewValue = record.clockSkewMs ?? HTTP_SUBAGENT_DEFAULT_CLOCK_SKEW_MS;
  if (
    !Number.isSafeInteger(clockSkewValue) ||
    (clockSkewValue as number) < 0 ||
    (clockSkewValue as number) > HTTP_SUBAGENT_DEFAULT_CLOCK_SKEW_MS
  ) {
    throw new RangeError('HTTP HMAC clockSkewMs must be within the protocol maximum.');
  }
  const clockSkewMs = clockSkewValue as number;
  const keyResolver = record.keyResolver as HttpSubAgentHmacKeyResolver;
  const dummyHmacKey = randomBytes(32);

  return Object.freeze({
    verify: async (request: HttpSubAgentRawRequest): Promise<HttpSubAgentAuthenticatedRequest> => {
      let normalized: NormalizedRawRequest;
      let headers: ParsedAuthenticationHeaders;
      try {
        normalized = normalizeRawRequest(request, securityPolicy);
        headers = parseAuthenticationHeaders(normalized.rawHeaders);
        if (headers.version !== HTTP_SUBAGENT_AUTH_VERSION) throw requestRejected();
        if (sha256Hex(normalized.body) !== headers.bodyDigest) throw requestRejected();
        assertTimestamp(headers.timestamp);
        const timestamp = Number(headers.timestamp);
        parseCanonicalBase64Url(headers.nonce, 16, 64);
        const receivedSignature = parseCanonicalBase64Url(headers.signature, 32, 32);
        let verificationNow: number;
        try {
          verificationNow = now();
        } catch {
          throw dependencyUnavailable();
        }
        if (!Number.isSafeInteger(verificationNow) || verificationNow < 0) {
          throw dependencyUnavailable();
        }
        if (Math.abs(verificationNow - timestamp) > clockSkewMs) throw requestRejected();

        let resolved: HttpSubAgentResolvedHmacKey | null | undefined;
        try {
          resolved = await keyResolver(headers.keyId);
        } catch {
          throw dependencyUnavailable();
        }
        let principalId = 'unknown';
        let resolvedKey: Uint8Array | undefined;
        if (resolved !== null && resolved !== undefined) {
          try {
            const keyRecord = requireClosedDataRecord(
              resolved,
              ['principalId', 'key'],
              'HTTP resolved HMAC key',
            );
            principalId = requirePrincipalId(keyRecord.principalId);
            resolvedKey = copyAndValidateKey(keyRecord.key, 'HTTP resolved HMAC key');
          } catch {
            throw dependencyUnavailable();
          }
        }
        const canonical = canonicalSigningString({
          keyId: headers.keyId,
          timestamp: headers.timestamp,
          nonce: headers.nonce,
          method: normalized.method,
          requestTarget: normalized.route.requestTarget,
          bodyDigest: headers.bodyDigest,
        });
        const verificationKey = resolvedKey ?? dummyHmacKey;
        let expectedSignature: Uint8Array;
        try {
          expectedSignature = createHmac('sha256', verificationKey)
            .update(canonical, 'utf8')
            .digest();
        } finally {
          if (resolvedKey !== undefined) Reflect.apply(UINT8_ARRAY_FILL, resolvedKey, [0]);
        }
        const signatureMatches = timingSafeEqual(
          Buffer.from(
            receivedSignature.buffer,
            receivedSignature.byteOffset,
            receivedSignature.byteLength,
          ),
          Buffer.from(
            expectedSignature.buffer,
            expectedSignature.byteOffset,
            expectedSignature.byteLength,
          ),
        );
        if (resolved === null || resolved === undefined || !signatureMatches)
          throw requestRejected();

        const expiresAt = verificationNow + HTTP_SUBAGENT_REPLAY_TTL_MS;
        if (!Number.isSafeInteger(expiresAt)) throw dependencyUnavailable();
        let consumed: boolean;
        try {
          consumed = await replayCache.consume({
            keyId: headers.keyId,
            nonce: headers.nonce,
            expiresAt,
          });
        } catch {
          throw dependencyUnavailable();
        }
        if (typeof consumed !== 'boolean') throw dependencyUnavailable();
        if (!consumed) throw requestRejected();

        const authContext = Object.freeze({
          scheme: HTTP_SUBAGENT_HMAC_SCHEME,
          keyId: headers.keyId,
          principalId,
          timestamp,
          correlationDigest: sha256Hex(
            new TextEncoder().encode(`${canonical}\n${headers.signature}`),
          ),
        }) satisfies HttpSubAgentAuthContext;
        return Object.freeze({
          authContext,
          route: normalized.route,
          contentType: normalized.contentType,
          body: normalized.body,
        });
      } catch (error) {
        if (error instanceof HttpSubAgentSecurityError) throw error;
        throw requestRejected();
      }
    },
  });
}

/** Prevalidates and owns a static key catalog; useful for loopback and simple deployments. */
export function createStaticHttpSubAgentHmacKeyResolver(
  entries: readonly StaticHttpSubAgentHmacKey[],
): HttpSubAgentHmacKeyResolver {
  const values = requireDenseDataArray(entries, 'HTTP static HMAC keys');
  const catalog = new Map<string, Readonly<{ principalId: string; key: Uint8Array }>>();
  try {
    for (let index = 0; index < values.length; index += 1) {
      const record = requireClosedDataRecord(
        values[index],
        ['keyId', 'principalId', 'key'],
        `HTTP static HMAC key ${index}`,
      );
      const keyId = requireKeyId(record.keyId);
      if (catalog.has(keyId)) throw new TypeError('HTTP static HMAC key IDs must be unique.');
      const principalId = requirePrincipalId(record.principalId);
      const key = copyAndValidateKey(record.key, `HTTP static HMAC key ${index}`);
      try {
        catalog.set(keyId, Object.freeze({ principalId, key }));
      } catch (error) {
        Reflect.apply(UINT8_ARRAY_FILL, key, [0]);
        throw error;
      }
    }
  } catch (error) {
    for (const entry of catalog.values()) Reflect.apply(UINT8_ARRAY_FILL, entry.key, [0]);
    catalog.clear();
    throw error;
  }
  return (keyId) => {
    const found = catalog.get(keyId);
    return found === undefined
      ? undefined
      : Object.freeze({
          principalId: found.principalId,
          key: copyHttpBytes(found.key, 'HTTP static HMAC resolver key', MAX_HMAC_KEY_BYTES),
        });
  };
}

interface NormalizedRawRequest {
  readonly method: 'POST';
  readonly route: HttpSubAgentRoute;
  readonly rawHeaders: readonly string[];
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

interface ParsedAuthenticationHeaders {
  readonly version: string;
  readonly keyId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly bodyDigest: string;
  readonly signature: string;
}

function normalizeRawRequest(
  request: HttpSubAgentRawRequest,
  policy: HttpSubAgentSecurityPolicy,
): NormalizedRawRequest {
  const record = requireClosedDataRecord(
    request,
    ['method', 'requestTarget', 'rawHeaders', 'body', 'transport'],
    'HTTP HMAC request',
  );
  const route = parseHttpSubAgentRoute(record.method, record.requestTarget);
  const transport = requireClosedDataRecord(
    record.transport,
    ['tls', 'loopback', 'requestTargetPreserved', 'redirectCount'],
    'HTTP transport facts',
  );
  if (
    typeof transport.tls !== 'boolean' ||
    typeof transport.loopback !== 'boolean' ||
    transport.requestTargetPreserved !== true ||
    transport.redirectCount !== 0
  ) {
    throw requestRejected();
  }
  if (policy.mode === 'production' && transport.tls !== true) throw requestRejected();
  if (policy.mode === 'loopback-test' && transport.tls !== true && transport.loopback !== true) {
    throw requestRejected();
  }
  const rawHeaderValues = requireDenseDataArray(record.rawHeaders, 'HTTP rawHeaders');
  if (rawHeaderValues.length > MAX_RAW_HEADERS || rawHeaderValues.length % 2 !== 0) {
    throw requestRejected();
  }
  let headerCharacters = 0;
  const rawHeaders: string[] = [];
  for (let index = 0; index < rawHeaderValues.length; index += 1) {
    const value = rawHeaderValues[index];
    if (typeof value !== 'string') throw requestRejected();
    headerCharacters += value.length;
    if (headerCharacters > MAX_RAW_HEADER_CHARACTERS) throw requestRejected();
    rawHeaders.push(value);
  }
  const contentType = extractSingleContentType(rawHeaders);
  return Object.freeze({
    method: 'POST',
    route,
    rawHeaders: Object.freeze(rawHeaders),
    contentType,
    body: copyHttpBytes(
      record.body as HttpBytes,
      'HTTP HMAC request body',
      HTTP_SUBAGENT_MAX_MULTIPART_BODY_BYTES,
    ),
  });
}

function extractSingleContentType(rawHeaders: readonly string[]): string | null {
  let found: string | null = null;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() !== 'content-type') continue;
    if (found !== null) return null;
    const value = rawHeaders[index + 1] as string;
    const normalized = value.replace(/^[\t ]+|[\t ]+$/gu, '');
    // Node's HTTP parser treats outer OWS as equivalent and removes it before exposing
    // rawHeaders. Internal SP is required by our exact multipart Content-Type grammar.
    if (normalized.length === 0 || hasC0OrDel(normalized) || normalized.includes(',')) {
      return null;
    }
    found = normalized;
  }
  return found;
}

function parseAuthenticationHeaders(rawHeaders: readonly string[]): ParsedAuthenticationHeaders {
  const values = new Map<string, string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] as string;
    const value = rawHeaders[index + 1] as string;
    if (!HEADER_NAME_PATTERN.test(name)) throw requestRejected();
    const lowerName = name.toLowerCase();
    const canonicalName = REQUIRED_HEADER_BY_LOWER_NAME.get(lowerName);
    if (canonicalName === undefined) {
      if (lowerName.startsWith('manee-')) throw requestRejected();
      continue;
    }
    if (values.has(canonicalName)) throw requestRejected();
    values.set(canonicalName, normalizeAuthenticationHeaderValue(value));
  }
  if (values.size !== REQUIRED_HEADERS.length) throw requestRejected();
  const keyId = requireKeyId(values.get(HTTP_SUBAGENT_AUTH_HEADER_NAMES.keyId));
  const bodyDigest = values.get(HTTP_SUBAGENT_AUTH_HEADER_NAMES.bodySha256) as string;
  if (!LOWER_SHA256_PATTERN.test(bodyDigest)) throw requestRejected();
  return Object.freeze({
    version: values.get(HTTP_SUBAGENT_AUTH_HEADER_NAMES.version) as string,
    keyId,
    timestamp: values.get(HTTP_SUBAGENT_AUTH_HEADER_NAMES.timestamp) as string,
    nonce: values.get(HTTP_SUBAGENT_AUTH_HEADER_NAMES.nonce) as string,
    bodyDigest,
    signature: values.get(HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature) as string,
  });
}

function normalizeAuthenticationHeaderValue(value: string): string {
  const normalized = value.replace(/^[\t ]+|[\t ]+$/gu, '');
  if (
    normalized.length === 0 ||
    hasC0OrDel(normalized) ||
    containsNonAscii(normalized) ||
    normalized.includes(' ') ||
    normalized.includes(',')
  ) {
    throw requestRejected();
  }
  return normalized;
}

function normalizeSecurityPolicy(value: unknown): HttpSubAgentSecurityPolicy {
  const record = requireClosedDataRecord(value, ['mode'], 'HTTP security policy');
  if (record.mode !== 'production' && record.mode !== 'loopback-test') {
    throw new TypeError('HTTP security policy mode is invalid.');
  }
  return Object.freeze({ mode: record.mode });
}

function normalizeReplayCache(value: unknown): HttpSubAgentReplayCache {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('HTTP replay cache must be an object.');
  }
  const candidate = value as Partial<HttpSubAgentReplayCache>;
  const mode = candidate.mode;
  const consume = candidate.consume;
  if ((mode !== 'distributed' && mode !== 'loopback-test') || typeof consume !== 'function') {
    throw new TypeError('HTTP replay cache contract is invalid.');
  }
  return Object.freeze({
    mode,
    consume: (input: HttpSubAgentReplayInput) => Reflect.apply(consume, value, [input]),
  });
}

function requireKeyId(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) throw requestRejected();
  return value;
}

function requirePrincipalId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError('HTTP principalId is invalid.');
  }
  if (hasC0OrDel(value)) {
    throw new TypeError('HTTP principalId is invalid.');
  }
  if (new TextEncoder().encode(value).byteLength > 256) {
    throw new TypeError('HTTP principalId exceeds 256 UTF-8 bytes.');
  }
  return value;
}

function hasC0OrDel(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) return true;
  }
  return false;
}

function containsNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7e) return true;
  }
  return false;
}

function copyAndValidateKey(value: unknown, label: string): Uint8Array {
  const key = copyHttpBytes(value as HttpBytes, label, MAX_HMAC_KEY_BYTES);
  if (key.byteLength < 32) {
    Reflect.apply(UINT8_ARRAY_FILL, key, [0]);
    throw new RangeError(`${label} must contain at least 32 bytes.`);
  }
  return key;
}

function assertTimestamp(value: string): void {
  if (!UNSIGNED_DECIMAL_PATTERN.test(value)) throw requestRejected();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw requestRejected();
  }
}

function parseCanonicalBase64Url(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): Uint8Array {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) throw requestRejected();
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength < minimumBytes ||
    decoded.byteLength > maximumBytes ||
    decoded.toString('base64url') !== value
  ) {
    throw requestRejected();
  }
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

function canonicalSigningString(input: {
  readonly keyId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly method: string;
  readonly requestTarget: string;
  readonly bodyDigest: string;
}): string {
  return [
    HTTP_SUBAGENT_HMAC_SCHEME,
    input.keyId,
    input.timestamp,
    input.nonce,
    input.method,
    input.requestTarget,
    input.bodyDigest,
  ].join('\n');
}

function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function requestRejected(): HttpSubAgentSecurityError {
  return new HttpSubAgentSecurityError('request-rejected');
}

function dependencyUnavailable(): HttpSubAgentSecurityError {
  return new HttpSubAgentSecurityError('dependency-unavailable');
}
