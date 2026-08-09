import { Buffer } from 'node:buffer';

import { describe, expect, vi } from 'vitest';

import { ManualClock, acceptanceIt } from '../../../testkit';

import {
  HTTP_SUBAGENT_AUTH_HEADER_NAMES,
  HTTP_SUBAGENT_DEFAULT_CLOCK_SKEW_MS,
  HTTP_SUBAGENT_REPLAY_TTL_MS,
  MemoryHttpSubAgentReplayCache,
  admitHttpSubAgentPacket,
  createHttpSubAgentHmacHeaders,
  createHttpSubAgentHmacVerifier,
  createStaticHttpSubAgentHmacKeyResolver,
  encodeHttpSubAgentMultipartPacket,
  type AdmitHttpSubAgentPacketOptions,
  type HttpSubAgentAdmissionDiagnostic,
  type HttpSubAgentAdmissionResult,
  type HttpSubAgentAuthorize,
  type HttpSubAgentHmacKeyResolver,
  type HttpSubAgentOwnerSessionResolver,
  type HttpSubAgentPacketAdmissionContext,
  type HttpSubAgentRawRequest,
  type HttpSubAgentReplayCache,
  type HttpSubAgentReplayInput,
  type HttpSubAgentSecurityPolicy,
  type HttpSubAgentTransportFacts,
} from '../src/index';
import {
  HTTP_TEST_KEY,
  HTTP_TEST_KEY_ID,
  HTTP_TEST_NOW,
  HTTP_TEST_OWNER_SESSION_ID,
  HTTP_TEST_REQUEST_TARGET,
  appendRawHeader,
  bytes,
  createPacket,
  findRawHeader,
  hmacSignature,
  nonce,
  rawHeadersFromRecord,
  removeRawHeader,
  replaceRawHeader,
} from './http-security-fixture';

interface HarnessCounters {
  keyResolver: number;
  replay: number;
  ownerResolver: number;
  authorize: number;
  onPacket: number;
}

interface HarnessOverrides {
  readonly now?: () => number;
  readonly replayCache?: HttpSubAgentReplayCache;
  readonly keyResolver?: HttpSubAgentHmacKeyResolver;
  readonly resolveOwnerSessionId?: HttpSubAgentOwnerSessionResolver;
  readonly authorize?: HttpSubAgentAuthorize;
  readonly onPacket?: (context: HttpSubAgentPacketAdmissionContext) => unknown | Promise<unknown>;
  readonly securityPolicy?: HttpSubAgentSecurityPolicy;
  readonly diagnostics?: (event: HttpSubAgentAdmissionDiagnostic) => unknown;
}

interface AdmissionHarness {
  readonly counters: HarnessCounters;
  readonly diagnostics: HttpSubAgentAdmissionDiagnostic[];
  readonly trace: string[];
  readonly options: AdmitHttpSubAgentPacketOptions<unknown>;
}

interface SignedRequestFixture {
  readonly request: HttpSubAgentRawRequest;
  readonly contentType: string;
}

class AtomicTestReplayCache implements HttpSubAgentReplayCache {
  readonly mode = 'distributed' as const;
  readonly #now: () => number;
  readonly #entries = new Map<string, number>();
  readonly consumed: HttpSubAgentReplayInput[] = [];

  constructor(now: () => number) {
    this.#now = now;
  }

  consume(input: HttpSubAgentReplayInput): boolean {
    this.consumed.push(Object.freeze({ ...input }));
    const now = this.#now();
    for (const [identity, expiresAt] of this.#entries) {
      if (expiresAt <= now) this.#entries.delete(identity);
    }
    const identity = `${input.keyId}\u0000${input.nonce}`;
    if (input.expiresAt <= now || this.#entries.has(identity)) return false;
    this.#entries.set(identity, input.expiresAt);
    return true;
  }
}

function invokeAdmission(
  request: HttpSubAgentRawRequest,
  options: AdmitHttpSubAgentPacketOptions<unknown>,
): Promise<HttpSubAgentAdmissionResult<unknown>> {
  return admitHttpSubAgentPacket(request, options);
}

const AUTH_HEADER_NAMES = Object.freeze(Object.values(HTTP_SUBAGENT_AUTH_HEADER_NAMES));
const LOOPBACK_TRANSPORT = Object.freeze({
  tls: false,
  loopback: true,
  requestTargetPreserved: true,
  redirectCount: 0,
}) satisfies HttpSubAgentTransportFacts;

function createSignedRequest(
  options: {
    readonly requestTarget?: string;
    readonly method?: 'POST';
    readonly timestamp?: number;
    readonly nonce?: string;
    readonly keyId?: string;
    readonly key?: Uint8Array;
    readonly body?: Uint8Array;
    readonly transport?: HttpSubAgentTransportFacts;
  } = {},
): SignedRequestFixture {
  const encoded = encodeHttpSubAgentMultipartPacket(createPacket(), {
    boundary: 'manee-auth-test-boundary',
  });
  const body = options.body ?? encoded.body;
  const method = options.method ?? 'POST';
  const requestTarget = options.requestTarget ?? HTTP_TEST_REQUEST_TARGET;
  const headers = createHttpSubAgentHmacHeaders({
    method,
    requestTarget,
    body,
    keyId: options.keyId ?? HTTP_TEST_KEY_ID,
    key: options.key ?? HTTP_TEST_KEY,
    timestamp: options.timestamp ?? HTTP_TEST_NOW,
    nonce: options.nonce ?? nonce(1),
  });
  return {
    contentType: encoded.contentType,
    request: {
      method,
      requestTarget,
      rawHeaders: ['Content-Type', encoded.contentType, ...rawHeadersFromRecord(headers)],
      body,
      transport: options.transport ?? LOOPBACK_TRANSPORT,
    },
  };
}

function createHarness(clock: ManualClock, overrides: HarnessOverrides = {}): AdmissionHarness {
  const counters: HarnessCounters = {
    keyResolver: 0,
    replay: 0,
    ownerResolver: 0,
    authorize: 0,
    onPacket: 0,
  };
  const diagnostics: HttpSubAgentAdmissionDiagnostic[] = [];
  const trace: string[] = [];
  const memory = new MemoryHttpSubAgentReplayCache({
    mode: 'loopback-test',
    now: overrides.now ?? clock.now,
  });
  const delegateReplay = overrides.replayCache ?? memory;
  const replayCache: HttpSubAgentReplayCache = {
    mode: delegateReplay.mode,
    consume: async (input) => {
      counters.replay += 1;
      trace.push('replay');
      return delegateReplay.consume(input);
    },
  };
  const options = {
    securityPolicy: overrides.securityPolicy ?? { mode: 'loopback-test' },
    now: clock.now,
    keyResolver: async (keyId: string) => {
      counters.keyResolver += 1;
      trace.push('key');
      if (overrides.keyResolver) return overrides.keyResolver(keyId);
      return keyId === HTTP_TEST_KEY_ID
        ? { principalId: 'http-test-principal', key: HTTP_TEST_KEY }
        : undefined;
    },
    replayCache,
    resolveOwnerSessionId: async (context) => {
      counters.ownerResolver += 1;
      trace.push('owner');
      if (overrides.resolveOwnerSessionId) {
        return overrides.resolveOwnerSessionId(context);
      }
      return HTTP_TEST_OWNER_SESSION_ID;
    },
    authorize: async (authContext, scope) => {
      counters.authorize += 1;
      trace.push('authorize');
      if (overrides.authorize) return overrides.authorize(authContext, scope);
      return true;
    },
    onPacket: async (context) => {
      counters.onPacket += 1;
      trace.push('packet');
      if (overrides.onPacket) return overrides.onPacket(context);
      return undefined;
    },
    diagnostics: (event: HttpSubAgentAdmissionDiagnostic) => {
      diagnostics.push(event);
      return overrides.diagnostics?.(event);
    },
  } satisfies AdmitHttpSubAgentPacketOptions<unknown>;
  return { counters, diagnostics, trace, options };
}

function responseStatus(result: HttpSubAgentAdmissionResult<unknown>): number {
  if (result.status !== 'rejected') return 0;
  const status = result.response.status;
  if (typeof status !== 'number') {
    throw new Error('Rejected HTTP admission result is missing its safe response status.');
  }
  return status;
}

async function expectRejected(
  request: HttpSubAgentRawRequest,
  harness: AdmissionHarness,
  status: 400 | 401 | 500 | 503,
): Promise<HttpSubAgentAdmissionResult<unknown>> {
  const result = await invokeAdmission(request, harness.options);
  expect(result.status).toBe('rejected');
  expect(responseStatus(result)).toBe(status);
  return result;
}

async function expectAccepted(
  request: HttpSubAgentRawRequest,
  harness: AdmissionHarness,
): Promise<HttpSubAgentAdmissionResult<unknown>> {
  const result = await invokeAdmission(request, harness.options);
  expect(result.status).toBe('accepted');
  expect(result.response.status).toBe(204);
  expect(harness.counters.onPacket).toBe(1);
  return result;
}

function replaceRequestHeaders(
  fixture: SignedRequestFixture,
  rawHeaders: readonly string[],
): HttpSubAgentRawRequest {
  return { ...fixture.request, rawHeaders };
}

function resignRequest(
  request: HttpSubAgentRawRequest,
  options: {
    readonly method?: string;
    readonly requestTarget?: string;
    readonly timestamp?: string;
    readonly nonce?: string;
    readonly bodyDigest?: string;
    readonly canonicalOverride?: string;
    readonly canonicalSuffix?: string;
  } = {},
): HttpSubAgentRawRequest {
  const keyId = findRawHeader(request.rawHeaders, HTTP_SUBAGENT_AUTH_HEADER_NAMES.keyId);
  const timestamp =
    options.timestamp ??
    findRawHeader(request.rawHeaders, HTTP_SUBAGENT_AUTH_HEADER_NAMES.timestamp);
  const nonceValue =
    options.nonce ?? findRawHeader(request.rawHeaders, HTTP_SUBAGENT_AUTH_HEADER_NAMES.nonce);
  const bodyDigest =
    options.bodyDigest ??
    findRawHeader(request.rawHeaders, HTTP_SUBAGENT_AUTH_HEADER_NAMES.bodySha256);
  const signature = hmacSignature({
    keyId,
    timestamp,
    nonce: nonceValue,
    method: options.method ?? request.method,
    requestTarget: options.requestTarget ?? request.requestTarget,
    bodyDigest,
    ...(options.canonicalOverride ? { canonicalOverride: options.canonicalOverride } : {}),
    ...(options.canonicalSuffix ? { canonicalSuffix: options.canonicalSuffix } : {}),
  });
  let rawHeaders = replaceRawHeader(
    request.rawHeaders,
    HTTP_SUBAGENT_AUTH_HEADER_NAMES.timestamp,
    timestamp,
  );
  rawHeaders = replaceRawHeader(rawHeaders, HTTP_SUBAGENT_AUTH_HEADER_NAMES.nonce, nonceValue);
  rawHeaders = replaceRawHeader(rawHeaders, HTTP_SUBAGENT_AUTH_HEADER_NAMES.bodySha256, bodyDigest);
  rawHeaders = replaceRawHeader(rawHeaders, HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature, signature);
  return {
    ...request,
    method: options.method ?? request.method,
    requestTarget: options.requestTarget ?? request.requestTarget,
    rawHeaders,
  };
}

function corruptedSignature(signature: string, byteIndex: number): string {
  const decoded = Buffer.from(signature, 'base64url');
  decoded[byteIndex] = decoded[byteIndex]! ^ 1;
  return decoded.toString('base64url');
}

function responseFingerprint(result: HttpSubAgentAdmissionResult<unknown>): string {
  return JSON.stringify(result.response);
}

function expectNoForbiddenSecurityFields(value: unknown): void {
  const forbidden = new Set([
    'key',
    'keybytes',
    'keymaterial',
    'nonce',
    'signature',
    'canonical',
    'canonicalstring',
    'rawheaders',
    'rawbody',
    'body',
    'providerpayload',
    'stack',
  ]);
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (typeof candidate !== 'object' || candidate === null) return;
    for (const [key, nested] of Object.entries(candidate)) {
      expect(forbidden.has(key.toLowerCase())).toBe(false);
      visit(nested);
    }
  };
  visit(value);
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectDeepFrozen(nested);
}

describe('HTTP HMAC-SHA256 v1 and admission safety', () => {
  acceptanceIt('C7C-HTTP-AUTH01.l1.closed-auth-headers', 'six-single-value-headers', async () => {
    const base = createSignedRequest();
    await expectAccepted(base.request, createHarness(new ManualClock(HTTP_TEST_NOW)));

    const lowerCaseHeaders = base.request.rawHeaders.map((value, index) =>
      index % 2 === 0 ? value.toLowerCase() : value,
    );
    await expectAccepted(
      replaceRequestHeaders(base, lowerCaseHeaders),
      createHarness(new ManualClock(HTTP_TEST_NOW)),
    );

    const shuffledPairs: string[] = [];
    for (let index = base.request.rawHeaders.length - 2; index >= 0; index -= 2) {
      shuffledPairs.push(base.request.rawHeaders[index]!, base.request.rawHeaders[index + 1]!);
    }
    await expectAccepted(
      replaceRequestHeaders(base, shuffledPairs),
      createHarness(new ManualClock(HTTP_TEST_NOW)),
    );

    const outerOws = [...base.request.rawHeaders];
    for (let index = 0; index < outerOws.length; index += 2) {
      if (outerOws[index]!.toLowerCase().startsWith('manee-')) {
        outerOws[index + 1] = ` \t${outerOws[index + 1]}\t `;
      }
    }
    // Node 22 llhttp has already removed this OWS at the production boundary. This pure
    // verifier assertion locks the equivalent parsed-value behavior without claiming L6 wire proof.
    await expectAccepted(
      replaceRequestHeaders(base, outerOws),
      createHarness(new ManualClock(HTTP_TEST_NOW)),
    );

    for (const [index, keyId] of ['a', 'a'.repeat(128)].entries()) {
      const fixture = createSignedRequest({ keyId, nonce: nonce(2 + index) });
      await expectAccepted(
        fixture.request,
        createHarness(new ManualClock(HTTP_TEST_NOW), {
          keyResolver: () => ({ principalId: 'http-test-principal', key: HTTP_TEST_KEY }),
        }),
      );
    }

    const invalidHeaders: (readonly string[])[] = [];
    for (const name of AUTH_HEADER_NAMES) {
      invalidHeaders.push(removeRawHeader(base.request.rawHeaders, name));
      invalidHeaders.push(
        appendRawHeader(
          base.request.rawHeaders,
          name.toLowerCase(),
          findRawHeader(base.request.rawHeaders, name),
        ),
      );
      invalidHeaders.push(
        replaceRawHeader(
          base.request.rawHeaders,
          name,
          `${findRawHeader(base.request.rawHeaders, name)},duplicate`,
        ),
      );
      invalidHeaders.push(replaceRawHeader(base.request.rawHeaders, name, ''));
      invalidHeaders.push(replaceRawHeader(base.request.rawHeaders, name, 'inside value'));
      invalidHeaders.push(replaceRawHeader(base.request.rawHeaders, name, 'inside\tvalue'));
      invalidHeaders.push(replaceRawHeader(base.request.rawHeaders, name, 'control\u0001'));
      invalidHeaders.push(replaceRawHeader(base.request.rawHeaders, name, 'control\u007f'));
    }
    invalidHeaders.push(appendRawHeader(base.request.rawHeaders, 'Manee-Unrecognized', 'opaque'));
    invalidHeaders.push(
      replaceRawHeader(base.request.rawHeaders, HTTP_SUBAGENT_AUTH_HEADER_NAMES.version, '2'),
    );
    for (const timestamp of ['+1', '-1', '1.5', '1e3', '01']) {
      invalidHeaders.push(
        replaceRawHeader(
          base.request.rawHeaders,
          HTTP_SUBAGENT_AUTH_HEADER_NAMES.timestamp,
          timestamp,
        ),
      );
    }
    for (const digest of ['0'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
      invalidHeaders.push(
        replaceRawHeader(
          base.request.rawHeaders,
          HTTP_SUBAGENT_AUTH_HEADER_NAMES.bodySha256,
          digest,
        ),
      );
    }
    for (const keyId of [
      '_leading',
      '.leading',
      '-leading',
      'a'.repeat(129),
      'has space',
      '密钥',
    ]) {
      const invalidKey = replaceRawHeader(
        base.request.rawHeaders,
        HTTP_SUBAGENT_AUTH_HEADER_NAMES.keyId,
        keyId,
      );
      invalidHeaders.push(resignRequest({ ...base.request, rawHeaders: invalidKey }).rawHeaders);
    }
    invalidHeaders.push([...base.request.rawHeaders, 'dangling-name-without-value']);

    const sparse = [...base.request.rawHeaders];
    delete sparse[1];
    invalidHeaders.push(sparse);
    const accessor = [...base.request.rawHeaders];
    Object.defineProperty(accessor, '1', {
      enumerable: true,
      configurable: true,
      get: () => {
        throw new Error('secret-header-accessor-must-not-run');
      },
    });
    invalidHeaders.push(accessor);
    invalidHeaders.push(
      new Proxy([...base.request.rawHeaders], {
        get: () => {
          throw new Error('secret-raw-headers-proxy-must-not-run');
        },
      }),
    );

    let safe401: string | undefined;
    for (const rawHeaders of invalidHeaders) {
      const harness = createHarness(new ManualClock(HTTP_TEST_NOW));
      const result = await expectRejected(replaceRequestHeaders(base, rawHeaders), harness, 401);
      expect(harness.counters).toMatchObject({
        keyResolver: 0,
        replay: 0,
        ownerResolver: 0,
        authorize: 0,
        onPacket: 0,
      });
      const serialized = JSON.stringify(result.response);
      safe401 ??= serialized;
      expect(serialized).toBe(safe401);
    }

    const badAuthAndBadMultipart = replaceRequestHeaders(
      { ...base, request: { ...base.request, body: bytes('not-multipart') } },
      removeRawHeader(base.request.rawHeaders, HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature),
    );
    const preParser = createHarness(new ManualClock(HTTP_TEST_NOW));
    await expectRejected(badAuthAndBadMultipart, preParser, 401);
    expect(preParser.counters.ownerResolver).toBe(0);
  });

  acceptanceIt(
    'C7C-HTTP-AUTH02.l1.raw-request-canonicalization',
    'method-path-body-byte-exact',
    async () => {
      const clock = new ManualClock(HTTP_TEST_NOW);
      const base = createSignedRequest({ nonce: nonce(3) });
      await expectAccepted(base.request, createHarness(clock));

      for (const [method, requestTarget] of [
        ['post', HTTP_TEST_REQUEST_TARGET],
        ['POST', `${HTTP_TEST_REQUEST_TARGET}?`],
        ['POST', `${HTTP_TEST_REQUEST_TARGET}#fragment`],
        ['POST', '/v1/jobs/http-job-1/%70oll'],
        ['POST', '/v1\\jobs\\http-job-1\\poll'],
        ['POST', '/v1/jobs/./http-job-1/poll'],
        ['POST', '/v1/jobs/../http-job-1/poll'],
        ['POST', '/v1//jobs/http-job-1/poll'],
        ['POST', `${HTTP_TEST_REQUEST_TARGET}/`],
        ['POST', `https://http.example.invalid${HTTP_TEST_REQUEST_TARGET}`],
        ['POST', '/v1/jobs/http-作业/poll'],
      ] as const) {
        const request = resignRequest(createSignedRequest({ nonce: nonce(4) }).request, {
          method,
          requestTarget,
        });
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW));
        await expectRejected(request, harness, 401);
        expect(harness.counters).toMatchObject({
          keyResolver: 0,
          replay: 0,
          ownerResolver: 0,
          authorize: 0,
          onPacket: 0,
        });
      }

      const canonicalLines = [
        'MANEE-HMAC-SHA256-V1',
        HTTP_TEST_KEY_ID,
        String(HTTP_TEST_NOW),
        nonce(5),
        'POST',
        HTTP_TEST_REQUEST_TARGET,
        findRawHeader(base.request.rawHeaders, HTTP_SUBAGENT_AUTH_HEADER_NAMES.bodySha256),
      ];
      for (const canonicalOverride of [
        [canonicalLines[0], canonicalLines[2], canonicalLines[1], ...canonicalLines.slice(3)].join(
          '\n',
        ),
        `${canonicalLines.join('\n')}\n`,
      ]) {
        const fixture = createSignedRequest({ nonce: nonce(5) });
        const request = resignRequest(fixture.request, {
          nonce: nonce(5),
          canonicalOverride,
        });
        await expectRejected(request, createHarness(new ManualClock(HTTP_TEST_NOW)), 401);
      }

      const tamperedBody = Uint8Array.from(
        base.request.body instanceof Uint8Array
          ? base.request.body
          : new Uint8Array(base.request.body),
      );
      tamperedBody[tamperedBody.byteLength - 2] = tamperedBody[tamperedBody.byteLength - 2]! ^ 1;
      const tamperedRequest = {
        ...createSignedRequest({ nonce: nonce(6) }).request,
        body: tamperedBody,
      };
      const tamperedHarness = createHarness(new ManualClock(HTTP_TEST_NOW));
      await expectRejected(tamperedRequest, tamperedHarness, 401);
      expect(tamperedHarness.counters.ownerResolver).toBe(0);

      const wrongDigestFixture = createSignedRequest({ nonce: nonce(7) });
      const wrongDigestRequest = resignRequest(wrongDigestFixture.request, {
        bodyDigest: '0'.repeat(64),
      });
      const wrongDigestHarness = createHarness(new ManualClock(HTTP_TEST_NOW));
      await expectRejected(wrongDigestRequest, wrongDigestHarness, 401);
      expect(wrongDigestHarness.counters).toMatchObject({
        keyResolver: 0,
        replay: 0,
        ownerResolver: 0,
        authorize: 0,
        onPacket: 0,
      });

      let markResolverEntered!: () => void;
      let releaseResolver!: () => void;
      const resolverEntered = new Promise<void>((resolve) => {
        markResolverEntered = resolve;
      });
      const resolverGate = new Promise<void>((resolve) => {
        releaseResolver = resolve;
      });
      const mutableFixture = createSignedRequest({ nonce: nonce(8) });
      const mutableBody = mutableFixture.request.body as Uint8Array;
      const mutableHeaders = mutableFixture.request.rawHeaders as string[];
      const snapshotHarness = createHarness(new ManualClock(HTTP_TEST_NOW), {
        keyResolver: async () => {
          markResolverEntered();
          await resolverGate;
          return { principalId: 'http-test-principal', key: HTTP_TEST_KEY };
        },
      });
      const admission = invokeAdmission(mutableFixture.request, snapshotHarness.options);
      await resolverEntered;
      mutableBody.fill(0);
      mutableHeaders.fill('secret-mutated-after-verifier-snapshot');
      releaseResolver();
      const snapshotResult = await admission;
      expect(snapshotResult.status).toBe('accepted');
      expect(snapshotHarness.counters.onPacket).toBe(1);
    },
  );

  acceptanceIt(
    'C7C-HTTP-AUTH03.l1.timestamp-window',
    'manual-clock-inclusive-boundaries',
    async () => {
      for (const [index, timestamp] of [
        HTTP_TEST_NOW - HTTP_SUBAGENT_DEFAULT_CLOCK_SKEW_MS,
        HTTP_TEST_NOW + HTTP_SUBAGENT_DEFAULT_CLOCK_SKEW_MS,
      ].entries()) {
        const fixture = createSignedRequest({ timestamp, nonce: nonce(10 + index) });
        await expectAccepted(fixture.request, createHarness(new ManualClock(HTTP_TEST_NOW)));
      }

      const invalidTimestamps = [
        String(HTTP_TEST_NOW - HTTP_SUBAGENT_DEFAULT_CLOCK_SKEW_MS - 1),
        String(HTTP_TEST_NOW + HTTP_SUBAGENT_DEFAULT_CLOCK_SKEW_MS + 1),
        '1.5',
        String(Number.MAX_SAFE_INTEGER + 1),
        '999999999999999999999999999999',
      ];
      for (const [index, timestamp] of invalidTimestamps.entries()) {
        const fixture = createSignedRequest({ nonce: nonce(20 + index) });
        const request = resignRequest(fixture.request, {
          timestamp,
          nonce: nonce(20 + index),
        });
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW));
        await expectRejected(request, harness, 401);
        expect(harness.counters).toMatchObject({
          keyResolver: 0,
          replay: 0,
          ownerResolver: 0,
          authorize: 0,
          onPacket: 0,
        });
      }

      const invalidNonceFixture = createSignedRequest({ nonce: nonce(30) });
      const invalidNonceRequest = resignRequest(invalidNonceFixture.request, {
        nonce: `${nonce(30)}=`,
      });
      const invalidSignatureFixture = createSignedRequest({ nonce: nonce(31) });
      const invalidSignatureRequest = {
        ...invalidSignatureFixture.request,
        rawHeaders: replaceRawHeader(
          invalidSignatureFixture.request.rawHeaders,
          HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature,
          `${findRawHeader(
            invalidSignatureFixture.request.rawHeaders,
            HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature,
          )}=`,
        ),
      };
      let safeStaticHeader401: string | undefined;
      for (const request of [invalidNonceRequest, invalidSignatureRequest]) {
        let nowCalls = 0;
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW), {
          now: () => {
            nowCalls += 1;
            throw new Error('secret-clock-must-not-run-before-static-header-validation');
          },
        });
        const result = await expectRejected(request, harness, 401);
        expect(nowCalls).toBe(0);
        expect(harness.counters).toEqual({
          keyResolver: 0,
          replay: 0,
          ownerResolver: 0,
          authorize: 0,
          onPacket: 0,
        });
        safeStaticHeader401 ??= responseFingerprint(result);
        expect(responseFingerprint(result)).toBe(safeStaticHeader401);
      }

      const epoch = createSignedRequest({ timestamp: 0, nonce: nonce(32) });
      await expectAccepted(epoch.request, createHarness(new ManualClock(0)));
    },
  );

  acceptanceIt(
    'C7C-HTTP-AUTH04.l1.encoding-and-key-strength',
    'nonce-key-signature-validation',
    async () => {
      const body = createSignedRequest({ nonce: nonce(40) }).request.body;
      expect(() =>
        createHttpSubAgentHmacHeaders({
          method: 'POST',
          requestTarget: HTTP_TEST_REQUEST_TARGET,
          body,
          keyId: HTTP_TEST_KEY_ID,
          key: new Uint8Array(31),
          timestamp: HTTP_TEST_NOW,
          nonce: nonce(40),
        }),
      ).toThrow();
      expect(() =>
        createStaticHttpSubAgentHmacKeyResolver([
          {
            keyId: HTTP_TEST_KEY_ID,
            principalId: 'http-test-principal',
            key: new Uint8Array(31),
          },
        ]),
      ).toThrow();
      for (const principalId of [
        ' leading-space',
        'control\u0000',
        'control\u007f',
        'a'.repeat(257),
      ]) {
        expect(() =>
          createStaticHttpSubAgentHmacKeyResolver([
            { keyId: HTTP_TEST_KEY_ID, principalId, key: HTTP_TEST_KEY },
          ]),
        ).toThrow();
      }
      expect(() =>
        createStaticHttpSubAgentHmacKeyResolver([
          { keyId: HTTP_TEST_KEY_ID, principalId: 'a'.repeat(256), key: HTTP_TEST_KEY },
        ]),
      ).not.toThrow();
      expect(() =>
        createStaticHttpSubAgentHmacKeyResolver([
          { keyId: HTTP_TEST_KEY_ID, principalId: 'c1-\u0085', key: HTTP_TEST_KEY },
        ]),
      ).not.toThrow();

      const catalogInputKey = Uint8Array.from(HTTP_TEST_KEY);
      const staticResolver = createStaticHttpSubAgentHmacKeyResolver([
        {
          keyId: HTTP_TEST_KEY_ID,
          principalId: 'http-test-principal',
          key: catalogInputKey,
        },
      ]);
      catalogInputKey.fill(0);
      const firstResolved = await staticResolver(HTTP_TEST_KEY_ID);
      expect(firstResolved).toBeDefined();
      if (firstResolved === null || firstResolved === undefined) {
        throw new Error('Static test key unexpectedly disappeared.');
      }
      expect(firstResolved.key).toBeInstanceOf(Uint8Array);
      if (!(firstResolved.key instanceof Uint8Array)) {
        throw new Error('Static test key is not represented by owned bytes.');
      }
      firstResolved.key.fill(0);
      const secondResolved = await staticResolver(HTTP_TEST_KEY_ID);
      expect(secondResolved).toBeDefined();
      if (secondResolved === null || secondResolved === undefined) {
        throw new Error('Static test key unexpectedly disappeared after mutation.');
      }
      expect(
        secondResolved.key instanceof Uint8Array
          ? secondResolved.key
          : new Uint8Array(secondResolved.key),
      ).toEqual(HTTP_TEST_KEY);
      expect(secondResolved.key).not.toBe(firstResolved.key);

      const invalidNonces = [
        '',
        Buffer.alloc(15, 1).toString('base64url'),
        Buffer.alloc(65, 2).toString('base64url'),
        `${nonce(41)}=`,
        Buffer.alloc(16, 255).toString('base64').replace(/=+$/u, ''),
        'not+base64url/value',
      ];
      for (const [index, invalidNonce] of invalidNonces.entries()) {
        const fixture = createSignedRequest({ nonce: nonce(50 + index) });
        const request = resignRequest(fixture.request, { nonce: invalidNonce });
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW));
        await expectRejected(request, harness, 401);
        expect(harness.counters).toMatchObject({
          keyResolver: 0,
          replay: 0,
          ownerResolver: 0,
          authorize: 0,
          onPacket: 0,
        });
      }

      const signatureFixture = createSignedRequest({ nonce: nonce(60) });
      const validSignature = findRawHeader(
        signatureFixture.request.rawHeaders,
        HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature,
      );
      const invalidSignatures = [
        '',
        Buffer.alloc(31, 1).toString('base64url'),
        Buffer.alloc(33, 1).toString('base64url'),
        `${validSignature}=`,
        'not+base64url/value',
        corruptedSignature(validSignature, 0),
        corruptedSignature(validSignature, 31),
      ];
      let safeSignature401: string | undefined;
      for (const invalidSignature of invalidSignatures) {
        const request = {
          ...signatureFixture.request,
          rawHeaders: replaceRawHeader(
            signatureFixture.request.rawHeaders,
            HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature,
            invalidSignature,
          ),
        };
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW));
        const result = await expectRejected(request, harness, 401);
        expect(harness.counters.replay).toBe(0);
        expect(harness.counters.onPacket).toBe(0);
        safeSignature401 ??= responseFingerprint(result);
        expect(responseFingerprint(result)).toBe(safeSignature401);
      }

      const unknownKey = createSignedRequest({
        keyId: 'unknown-http-key',
        nonce: nonce(61),
      });
      const unknownHarness = createHarness(new ManualClock(HTTP_TEST_NOW));
      await expectRejected(unknownKey.request, unknownHarness, 401);
      expect(unknownHarness.counters).toMatchObject({
        keyResolver: 1,
        replay: 0,
        ownerResolver: 0,
        authorize: 0,
        onPacket: 0,
      });

      const malformedResolvedKeys: unknown[] = [
        { principalId: 'http-test-principal', key: new Uint8Array(31) },
        { principalId: 'http-test-principal', key: 'secret-not-bytes' },
        { principalId: ' leading-space', key: HTTP_TEST_KEY },
        { principalId: 'control\u0000', key: HTTP_TEST_KEY },
        { principalId: '界'.repeat(86), key: HTTP_TEST_KEY },
        { principalId: 'http-test-principal', key: HTTP_TEST_KEY, extra: true },
      ];
      let safe503: string | undefined;
      for (const [index, malformedKey] of malformedResolvedKeys.entries()) {
        const fixture = createSignedRequest({ nonce: nonce(70 + index) });
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW), {
          keyResolver: (() => malformedKey) as unknown as HttpSubAgentHmacKeyResolver,
        });
        const result = await expectRejected(fixture.request, harness, 503);
        expect(harness.counters).toMatchObject({
          keyResolver: 1,
          replay: 0,
          ownerResolver: 0,
          authorize: 0,
          onPacket: 0,
        });
        safe503 ??= responseFingerprint(result);
        expect(responseFingerprint(result)).toBe(safe503);
      }
    },
  );

  acceptanceIt(
    'C7C-HTTP-AUTH05.l2.atomic-replay-cache',
    'hundred-way-two-verifier-race',
    async () => {
      const raceClock = new ManualClock(HTTP_TEST_NOW);
      const sharedReplay = new AtomicTestReplayCache(raceClock.now);
      const left = createHarness(raceClock, { replayCache: sharedReplay });
      const right = createHarness(raceClock, { replayCache: sharedReplay });
      const request = createSignedRequest({ nonce: nonce(80) }).request;
      const raceResults = await Promise.all(
        Array.from({ length: 100 }, (_value, index) =>
          invokeAdmission(request, index % 2 === 0 ? left.options : right.options),
        ),
      );
      const winners = raceResults.filter((result) => result.status === 'accepted');
      const replayDenials = raceResults.filter((result) => result.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(replayDenials).toHaveLength(99);
      for (const denial of replayDenials) expect(responseStatus(denial)).toBe(401);
      expect(left.counters.onPacket + right.counters.onPacket).toBe(1);
      expect(sharedReplay.consumed).toHaveLength(100);
      expect(
        sharedReplay.consumed.every(
          (input) => input.expiresAt === HTTP_TEST_NOW + HTTP_SUBAGENT_REPLAY_TTL_MS,
        ),
      ).toBe(true);

      const tupleClock = new ManualClock(HTTP_TEST_NOW);
      const tupleReplay = new AtomicTestReplayCache(tupleClock.now);
      const sharedNonce = nonce(81);
      const firstHarness = createHarness(tupleClock, { replayCache: tupleReplay });
      await expectAccepted(createSignedRequest({ nonce: sharedNonce }).request, firstHarness);

      const changedBody = encodeHttpSubAgentMultipartPacket(
        createPacket([bytes('same-nonce-different-owned-body')]),
        { boundary: 'manee-auth-test-boundary' },
      );
      const replayVariants = [
        createSignedRequest({ nonce: sharedNonce, body: changedBody.body }).request,
        createSignedRequest({
          nonce: sharedNonce,
          requestTarget: '/v1/jobs/http-job-1/cancel',
        }).request,
        createSignedRequest({
          nonce: sharedNonce,
          timestamp: HTTP_TEST_NOW + 1,
        }).request,
      ];
      for (const replayRequest of replayVariants) {
        const harness = createHarness(tupleClock, { replayCache: tupleReplay });
        await expectRejected(replayRequest, harness, 401);
        expect(harness.counters).toMatchObject({
          keyResolver: 1,
          replay: 1,
          ownerResolver: 0,
          authorize: 0,
          onPacket: 0,
        });
      }

      const ttlClock = new ManualClock(HTTP_TEST_NOW);
      const ttlCache = new MemoryHttpSubAgentReplayCache({
        mode: 'loopback-test',
        now: ttlClock.now,
      });
      const replayInput = {
        keyId: HTTP_TEST_KEY_ID,
        nonce: nonce(82),
        expiresAt: HTTP_TEST_NOW + HTTP_SUBAGENT_REPLAY_TTL_MS,
      };
      expect(ttlCache.consume(replayInput)).toBe(true);
      ttlClock.advanceBy(HTTP_SUBAGENT_REPLAY_TTL_MS - 1);
      expect(
        ttlCache.consume({
          ...replayInput,
          expiresAt: ttlClock.now() + HTTP_SUBAGENT_REPLAY_TTL_MS,
        }),
      ).toBe(false);
      ttlClock.advanceBy(1);
      expect(
        ttlCache.consume({
          ...replayInput,
          expiresAt: ttlClock.now() + HTTP_SUBAGENT_REPLAY_TTL_MS,
        }),
      ).toBe(true);

      const capacityClock = new ManualClock(HTTP_TEST_NOW);
      const fullCache = new MemoryHttpSubAgentReplayCache({
        mode: 'loopback-test',
        now: capacityClock.now,
        maxEntries: 1,
      });
      expect(
        fullCache.consume({
          keyId: HTTP_TEST_KEY_ID,
          nonce: nonce(83),
          expiresAt: HTTP_TEST_NOW + HTTP_SUBAGENT_REPLAY_TTL_MS,
        }),
      ).toBe(true);
      const capacityHarness = createHarness(capacityClock, { replayCache: fullCache });
      await expectRejected(createSignedRequest({ nonce: nonce(84) }).request, capacityHarness, 503);
      expect(capacityHarness.counters.onPacket).toBe(0);

      for (const consume of [
        () => undefined,
        () => {
          throw new Error('secret-replay-backend-failure');
        },
      ]) {
        const invalidBackend: HttpSubAgentReplayCache = {
          mode: 'distributed',
          consume: consume as unknown as HttpSubAgentReplayCache['consume'],
        };
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW), {
          replayCache: invalidBackend,
        });
        await expectRejected(
          createSignedRequest({ nonce: nonce(85 + harness.counters.replay) }).request,
          harness,
          503,
        );
        expect(harness.counters.onPacket).toBe(0);
      }

      expect(() =>
        Reflect.construct(MemoryHttpSubAgentReplayCache, [{ mode: 'production' }]),
      ).toThrow();
      expect(() => Reflect.construct(MemoryHttpSubAgentReplayCache, [{}])).toThrow();

      const immutableModeCache = new MemoryHttpSubAgentReplayCache({
        mode: 'loopback-test',
        now: () => HTTP_TEST_NOW,
      });
      expect(Object.isFrozen(immutableModeCache)).toBe(true);
      expect(Reflect.set(immutableModeCache, 'mode', 'distributed')).toBe(false);
      expect(() =>
        Object.defineProperty(immutableModeCache, 'mode', { value: 'distributed' }),
      ).toThrow();
      expect(() => {
        (immutableModeCache as unknown as { mode: string }).mode = 'distributed';
      }).toThrow();
      expect(immutableModeCache.mode).toBe('loopback-test');
      expect(Reflect.set(immutableModeCache, 'consume', () => true)).toBe(false);
      expect(
        Reflect.defineProperty(immutableModeCache, 'consume', {
          configurable: true,
          value: () => true,
        }),
      ).toBe(false);
      expect(Object.hasOwn(immutableModeCache, 'consume')).toBe(false);
      let immutableCacheKeyResolverCalls = 0;
      expect(() =>
        createHttpSubAgentHmacVerifier({
          securityPolicy: { mode: 'production' },
          keyResolver: () => {
            immutableCacheKeyResolverCalls += 1;
            return { principalId: 'http-test-principal', key: HTTP_TEST_KEY };
          },
          replayCache: immutableModeCache,
          now: () => HTTP_TEST_NOW,
        }),
      ).toThrow();
      expect(immutableCacheKeyResolverCalls).toBe(0);
      expect(immutableModeCache.diagnostics.entries).toBe(0);
    },
  );

  acceptanceIt(
    'C7C-HTTP-AUTH06.l2.authorization-order',
    'authenticated-scope-before-peer',
    async () => {
      let ownerContext: unknown;
      let authorizeAuthContext: unknown;
      let authorizeScope: unknown;
      let packetContext: unknown;
      const successHarness = createHarness(new ManualClock(HTTP_TEST_NOW), {
        resolveOwnerSessionId: (context) => {
          ownerContext = context;
          return HTTP_TEST_OWNER_SESSION_ID;
        },
        authorize: (authContext, scope) => {
          authorizeAuthContext = authContext;
          authorizeScope = scope;
          return true;
        },
        onPacket: (context) => {
          packetContext = context;
        },
      });
      const success = await expectAccepted(
        createSignedRequest({ nonce: nonce(90) }).request,
        successHarness,
      );
      expect(success.response?.status).toBe(204);
      expect(successHarness.trace).toEqual(['key', 'replay', 'owner', 'authorize', 'packet']);
      expect(Object.keys(ownerContext as object).sort()).toEqual([
        'authContext',
        'packet',
        'route',
      ]);
      expect(authorizeScope).toEqual({
        ownerSessionId: HTTP_TEST_OWNER_SESSION_ID,
        method: 'POST',
        routeId: 'jobs.poll',
      });
      expect(authorizeAuthContext).toBe((ownerContext as { authContext: unknown }).authContext);
      expectNoForbiddenSecurityFields(ownerContext);
      expectNoForbiddenSecurityFields(authorizeAuthContext);
      expectNoForbiddenSecurityFields(authorizeScope);
      expectNoForbiddenSecurityFields(packetContext);

      const malformedBodies = [
        createSignedRequest({ nonce: nonce(91), body: bytes('not-a-multipart-packet') }).request,
        {
          ...createSignedRequest({ nonce: nonce(92) }).request,
          rawHeaders: removeRawHeader(
            createSignedRequest({ nonce: nonce(92) }).request.rawHeaders,
            'Content-Type',
          ),
        },
        (() => {
          const fixture = createSignedRequest({ nonce: nonce(93) });
          return {
            ...fixture.request,
            rawHeaders: appendRawHeader(
              fixture.request.rawHeaders,
              'content-type',
              fixture.contentType,
            ),
          };
        })(),
      ];
      for (const malformed of malformedBodies) {
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW));
        await expectRejected(malformed, harness, 400);
        expect(harness.trace).toEqual(['key', 'replay']);
        expect(harness.counters).toMatchObject({
          ownerResolver: 0,
          authorize: 0,
          onPacket: 0,
        });
      }

      for (const [index, ownerSessionId] of [
        null,
        '',
        ' leading-space',
        'control\u0000',
        'control\u007f',
        'a'.repeat(257),
      ].entries()) {
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW), {
          resolveOwnerSessionId: () => ownerSessionId,
        });
        await expectRejected(
          createSignedRequest({ nonce: nonce(94 + index) }).request,
          harness,
          400,
        );
        expect(harness.trace).toEqual(['key', 'replay', 'owner']);
        expect(harness.counters).toMatchObject({ authorize: 0, onPacket: 0 });
      }

      for (const [index, ownerSessionId] of ['a'.repeat(256), 'c1-\u0085'].entries()) {
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW), {
          resolveOwnerSessionId: () => ownerSessionId,
        });
        await expectAccepted(createSignedRequest({ nonce: nonce(120 + index) }).request, harness);
      }

      let authorization401: string | undefined;
      for (const [index, ownerSessionId] of [
        HTTP_TEST_OWNER_SESSION_ID,
        'guessed-other-owner-session',
      ].entries()) {
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW), {
          resolveOwnerSessionId: () => ownerSessionId,
          authorize: () => false,
        });
        const result = await expectRejected(
          createSignedRequest({ nonce: nonce(101 + index) }).request,
          harness,
          401,
        );
        authorization401 ??= responseFingerprint(result);
        expect(responseFingerprint(result)).toBe(authorization401);
        expect(harness.trace).toEqual(['key', 'replay', 'owner', 'authorize']);
        expect(harness.counters.onPacket).toBe(0);
      }

      const dependencyCases: readonly HarnessOverrides[] = [
        {
          resolveOwnerSessionId: () => {
            throw new Error('secret-owner-store-unavailable');
          },
        },
        {
          authorize: () => {
            throw new Error('secret-authorizer-unavailable');
          },
        },
      ];
      for (const [index, overrides] of dependencyCases.entries()) {
        const harness = createHarness(new ManualClock(HTTP_TEST_NOW), overrides);
        await expectRejected(
          createSignedRequest({ nonce: nonce(103 + index) }).request,
          harness,
          503,
        );
        expect(harness.counters.onPacket).toBe(0);
      }

      const callbackHarness = createHarness(new ManualClock(HTTP_TEST_NOW), {
        onPacket: () => {
          throw new Error('secret-core-callback-failure');
        },
      });
      await expectRejected(
        createSignedRequest({ nonce: nonce(105) }).request,
        callbackHarness,
        500,
      );
      expect(callbackHarness.counters.onPacket).toBe(1);

      const heartbeatHarness = createHarness(new ManualClock(HTTP_TEST_NOW));
      await expectRejected(
        createSignedRequest({ requestTarget: '/v1/heartbeat', nonce: nonce(106) }).request,
        heartbeatHarness,
        400,
      );
      expect(heartbeatHarness.trace).toEqual(['key', 'replay']);
      expect(heartbeatHarness.counters).toMatchObject({
        ownerResolver: 0,
        authorize: 0,
        onPacket: 0,
      });

      const distributedReplay = new AtomicTestReplayCache(() => HTTP_TEST_NOW);
      const productionTransport = {
        tls: true,
        loopback: false,
        requestTargetPreserved: true,
        redirectCount: 0,
      } satisfies HttpSubAgentTransportFacts;
      await expectAccepted(
        createSignedRequest({
          nonce: nonce(107),
          transport: productionTransport,
        }).request,
        createHarness(new ManualClock(HTTP_TEST_NOW), {
          replayCache: distributedReplay,
          securityPolicy: { mode: 'production' },
        }),
      );

      for (const [index, transport] of [
        { ...productionTransport, tls: false },
        { ...productionTransport, requestTargetPreserved: false },
        { ...productionTransport, redirectCount: 1 },
        {
          tls: false,
          loopback: false,
          requestTargetPreserved: true,
          redirectCount: 0,
        },
      ].entries()) {
        const production = index < 3;
        const harness = createHarness(
          new ManualClock(HTTP_TEST_NOW),
          production
            ? {
                replayCache: new AtomicTestReplayCache(() => HTTP_TEST_NOW),
                securityPolicy: { mode: 'production' },
              }
            : { securityPolicy: { mode: 'loopback-test' } },
        );
        await expectRejected(
          createSignedRequest({ nonce: nonce(108 + index), transport }).request,
          harness,
          401,
        );
        expect(harness.counters).toMatchObject({
          keyResolver: 0,
          replay: 0,
          ownerResolver: 0,
          authorize: 0,
          onPacket: 0,
        });
      }

      const loopbackCacheInProduction = createHarness(new ManualClock(HTTP_TEST_NOW), {
        securityPolicy: { mode: 'production' },
      });
      await expect(
        invokeAdmission(
          createSignedRequest({
            nonce: nonce(112),
            transport: productionTransport,
          }).request,
          loopbackCacheInProduction.options,
        ),
      ).rejects.toThrow();
      expect(loopbackCacheInProduction.counters).toEqual({
        keyResolver: 0,
        replay: 0,
        ownerResolver: 0,
        authorize: 0,
        onPacket: 0,
      });

      const configurationHarness = createHarness(new ManualClock(HTTP_TEST_NOW));
      const malformedOptions: unknown[] = [
        { ...configurationHarness.options, securityPolicy: { mode: 'permissive' } },
        {
          ...configurationHarness.options,
          replayCache: { mode: 'unknown', consume: () => true },
        },
        {
          ...configurationHarness.options,
          multipartLimits: { maxSidecarItemBytes: 0 },
        },
        { ...configurationHarness.options, authorize: 'not-a-function' },
        { ...configurationHarness.options, unsupported: true },
      ];
      for (const malformedOptionsValue of malformedOptions) {
        await expect(
          invokeAdmission(
            createSignedRequest({ nonce: nonce(122) }).request,
            malformedOptionsValue as unknown as AdmitHttpSubAgentPacketOptions<unknown>,
          ),
        ).rejects.toThrow();
      }
      expect(configurationHarness.counters).toEqual({
        keyResolver: 0,
        replay: 0,
        ownerResolver: 0,
        authorize: 0,
        onPacket: 0,
      });
    },
  );

  acceptanceIt(
    'C7C-HTTP-AUTH07.l2.safe-auth-diagnostics',
    'safe-status-and-diagnostics',
    async () => {
      const replayClock = new ManualClock(HTTP_TEST_NOW);
      const replayCache = new MemoryHttpSubAgentReplayCache({
        mode: 'loopback-test',
        now: replayClock.now,
      });
      const replayNonce = nonce(130);
      expect(
        replayCache.consume({
          keyId: HTTP_TEST_KEY_ID,
          nonce: replayNonce,
          expiresAt: HTTP_TEST_NOW + HTTP_SUBAGENT_REPLAY_TTL_MS,
        }),
      ).toBe(true);

      const wrongSignatureFixture = createSignedRequest({ nonce: nonce(131) });
      const originalSignature = findRawHeader(
        wrongSignatureFixture.request.rawHeaders,
        HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature,
      );
      const wrongSignature = corruptedSignature(originalSignature, 0);
      const wrongSignatureRequest = {
        ...wrongSignatureFixture.request,
        rawHeaders: replaceRawHeader(
          wrongSignatureFixture.request.rawHeaders,
          HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature,
          wrongSignature,
        ),
      };
      const bodyTamperMarker = 'secret-raw-body-must-never-be-observable';
      const bodyTamperFixture = createSignedRequest({ nonce: nonce(132) });
      const malformedBodyMarker = 'secret-signed-malformed-multipart';
      const ownerMarker = 'secret-owner-scope-must-not-leak';
      const failureMarkers = [
        'secret-key-backend-stack',
        'secret-replay-backend-stack',
        'secret-owner-backend-stack',
        'secret-authorization-backend-stack',
        'secret-provider-payload-internal-stack',
        'secret-clock-backend-stack',
        'secret-diagnostics-backend-stack',
        'secret-async-diagnostics-rejection',
      ];

      const scenarios: Array<{
        readonly label: string;
        readonly status: 400 | 401 | 500 | 503;
        readonly request: HttpSubAgentRawRequest;
        readonly harness: AdmissionHarness;
      }> = [
        {
          label: 'unknown key',
          status: 401,
          request: createSignedRequest({
            keyId: 'secret-key-id-must-not-leak',
            nonce: nonce(133),
          }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW)),
        },
        {
          label: 'wrong signature',
          status: 401,
          request: wrongSignatureRequest,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW)),
        },
        {
          label: 'expired timestamp',
          status: 401,
          request: createSignedRequest({
            timestamp: HTTP_TEST_NOW - HTTP_SUBAGENT_DEFAULT_CLOCK_SKEW_MS - 1,
            nonce: nonce(134),
          }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW)),
        },
        {
          label: 'future timestamp',
          status: 401,
          request: createSignedRequest({
            timestamp: HTTP_TEST_NOW + HTTP_SUBAGENT_DEFAULT_CLOCK_SKEW_MS + 1,
            nonce: nonce(135),
          }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW)),
        },
        {
          label: 'replayed nonce',
          status: 401,
          request: createSignedRequest({ nonce: replayNonce }).request,
          harness: createHarness(replayClock, { replayCache }),
        },
        {
          label: 'raw body tamper',
          status: 401,
          request: { ...bodyTamperFixture.request, body: bytes(bodyTamperMarker) },
          harness: createHarness(new ManualClock(HTTP_TEST_NOW)),
        },
        {
          label: 'authorization denial',
          status: 401,
          request: createSignedRequest({ nonce: nonce(136) }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW), {
            resolveOwnerSessionId: () => ownerMarker,
            authorize: () => false,
          }),
        },
        {
          label: 'signed malformed multipart',
          status: 400,
          request: createSignedRequest({
            nonce: nonce(137),
            body: bytes(malformedBodyMarker),
          }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW)),
        },
        {
          label: 'malformed owner scope',
          status: 400,
          request: createSignedRequest({ nonce: nonce(138) }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW), {
            resolveOwnerSessionId: () => ` ${ownerMarker}`,
          }),
        },
        {
          label: 'key backend unavailable',
          status: 503,
          request: createSignedRequest({ nonce: nonce(139) }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW), {
            keyResolver: () => {
              throw new Error(failureMarkers[0]);
            },
          }),
        },
        {
          label: 'clock backend unavailable',
          status: 503,
          request: createSignedRequest({ nonce: nonce(140) }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW), {
            now: () => {
              throw new Error(failureMarkers[5]);
            },
          }),
        },
        {
          label: 'replay backend unavailable',
          status: 503,
          request: createSignedRequest({ nonce: nonce(141) }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW), {
            replayCache: {
              mode: 'distributed',
              consume: () => {
                throw new Error(failureMarkers[1]);
              },
            },
          }),
        },
        {
          label: 'owner backend unavailable',
          status: 503,
          request: createSignedRequest({ nonce: nonce(142) }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW), {
            resolveOwnerSessionId: () => {
              throw new Error(failureMarkers[2]);
            },
          }),
        },
        {
          label: 'authorization backend unavailable',
          status: 503,
          request: createSignedRequest({ nonce: nonce(143) }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW), {
            authorize: () => {
              throw new Error(failureMarkers[3]);
            },
          }),
        },
        {
          label: 'peer callback failure',
          status: 500,
          request: createSignedRequest({ nonce: nonce(144) }).request,
          harness: createHarness(new ManualClock(HTTP_TEST_NOW), {
            onPacket: () => {
              throw new Error(failureMarkers[4]);
            },
          }),
        },
      ];

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const responseByStatus = new Map<number, string>();
      const observedDiagnostics: HttpSubAgentAdmissionDiagnostic[] = [];
      const serializedResults: string[] = [];
      try {
        for (const scenario of scenarios) {
          const result = await expectRejected(scenario.request, scenario.harness, scenario.status);
          expectDeepFrozen(result);
          expect(result.response.headers['cache-control']).toBe('no-store');
          expect(result.response.headers['content-type']).toBe('application/json');
          expect(() => JSON.parse(result.response.body)).not.toThrow();
          const fingerprint = responseFingerprint(result);
          const prior = responseByStatus.get(scenario.status);
          if (prior === undefined) responseByStatus.set(scenario.status, fingerprint);
          else expect(fingerprint, scenario.label).toBe(prior);
          expect(scenario.harness.diagnostics).toHaveLength(1);
          const [diagnostic] = scenario.harness.diagnostics;
          expectDeepFrozen(diagnostic);
          expect(Object.keys(diagnostic!).sort()).toEqual(
            diagnostic?.correlationDigest === undefined
              ? ['category', 'status']
              : ['category', 'correlationDigest', 'status'],
          );
          expect(diagnostic?.status).toBe(scenario.status);
          expect(diagnostic?.category).toBe(
            scenario.status === 400
              ? 'protocol_rejected'
              : scenario.status === 401
                ? 'request_rejected'
                : scenario.status === 500
                  ? 'internal_failure'
                  : 'dependency_unavailable',
          );
          if (diagnostic?.correlationDigest !== undefined) {
            expect(diagnostic.correlationDigest).toMatch(/^[a-f0-9]{64}$/u);
          }
          observedDiagnostics.push(diagnostic!);
          serializedResults.push(JSON.stringify(result));
        }

        const diagnosticFailureFixture = createSignedRequest({ nonce: nonce(145) });
        const diagnosticFailureSignature = findRawHeader(
          diagnosticFailureFixture.request.rawHeaders,
          HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature,
        );
        const diagnosticFailureHarness = createHarness(new ManualClock(HTTP_TEST_NOW), {
          diagnostics: () => {
            throw new Error(failureMarkers[6]);
          },
        });
        const diagnosticFailureResult = await expectRejected(
          {
            ...diagnosticFailureFixture.request,
            rawHeaders: replaceRawHeader(
              diagnosticFailureFixture.request.rawHeaders,
              HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature,
              corruptedSignature(diagnosticFailureSignature, 31),
            ),
          },
          diagnosticFailureHarness,
          401,
        );
        expect(responseFingerprint(diagnosticFailureResult)).toBe(responseByStatus.get(401));
        expectDeepFrozen(diagnosticFailureResult);
        observedDiagnostics.push(...diagnosticFailureHarness.diagnostics);
        serializedResults.push(JSON.stringify(diagnosticFailureResult));

        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
          unhandledRejections.push(reason);
        };
        process.on('unhandledRejection', onUnhandledRejection);
        let rejectAsyncDiagnostic!: (reason: unknown) => void;
        const asyncDiagnostic = new Promise<void>((_resolve, reject) => {
          rejectAsyncDiagnostic = reject;
        });
        try {
          const asyncDiagnosticFixture = createSignedRequest({ nonce: nonce(146) });
          const asyncDiagnosticSignature = findRawHeader(
            asyncDiagnosticFixture.request.rawHeaders,
            HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature,
          );
          const asyncDiagnosticHarness = createHarness(new ManualClock(HTTP_TEST_NOW), {
            diagnostics: async () => asyncDiagnostic,
          });
          const admissionOrDelay = await Promise.race([
            expectRejected(
              {
                ...asyncDiagnosticFixture.request,
                rawHeaders: replaceRawHeader(
                  asyncDiagnosticFixture.request.rawHeaders,
                  HTTP_SUBAGENT_AUTH_HEADER_NAMES.signature,
                  corruptedSignature(asyncDiagnosticSignature, 0),
                ),
              },
              asyncDiagnosticHarness,
              401,
            ).then((result) => ({ kind: 'result' as const, result })),
            new Promise<{ readonly kind: 'delayed' }>((resolve) => {
              setImmediate(() => resolve({ kind: 'delayed' }));
            }),
          ]);
          expect(admissionOrDelay.kind).toBe('result');
          if (admissionOrDelay.kind !== 'result') {
            throw new Error('HTTP admission awaited an asynchronous diagnostics callback.');
          }
          expect(responseFingerprint(admissionOrDelay.result)).toBe(responseByStatus.get(401));
          expectDeepFrozen(admissionOrDelay.result);
          rejectAsyncDiagnostic(new Error(failureMarkers[7]));
          await Promise.resolve();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(unhandledRejections).toEqual([]);
          observedDiagnostics.push(...asyncDiagnosticHarness.diagnostics);
          serializedResults.push(JSON.stringify(admissionOrDelay.result));
        } finally {
          process.off('unhandledRejection', onUnhandledRejection);
        }

        expect(stdoutSpy).not.toHaveBeenCalled();
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
      }

      const sensitiveValues = [
        HTTP_TEST_KEY_ID,
        Buffer.from(HTTP_TEST_KEY).toString('hex'),
        nonce(131),
        originalSignature,
        wrongSignature,
        [
          'MANEE-HMAC-SHA256-V1',
          HTTP_TEST_KEY_ID,
          String(HTTP_TEST_NOW),
          nonce(131),
          'POST',
          HTTP_TEST_REQUEST_TARGET,
          findRawHeader(
            wrongSignatureFixture.request.rawHeaders,
            HTTP_SUBAGENT_AUTH_HEADER_NAMES.bodySha256,
          ),
        ].join('\n'),
        'secret-key-id-must-not-leak',
        bodyTamperMarker,
        malformedBodyMarker,
        ownerMarker,
        ...failureMarkers,
      ];
      const observableText = JSON.stringify({
        diagnostics: observedDiagnostics,
        results: serializedResults,
      });
      for (const sensitiveValue of sensitiveValues) {
        expect(observableText).not.toContain(sensitiveValue);
      }
      for (const diagnostic of observedDiagnostics) expectNoForbiddenSecurityFields(diagnostic);
    },
  );
});
