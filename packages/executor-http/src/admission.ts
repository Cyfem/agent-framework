import type { SubAgentTransportPeerPacket } from '@ruixutong.manee/maneeagent-framework';

import {
  HttpSubAgentSecurityError,
  createHttpSubAgentHmacVerifier,
  type HttpSubAgentAuthContext,
  type HttpSubAgentHmacKeyResolver,
  type HttpSubAgentRawRequest,
  type HttpSubAgentReplayCache,
  type HttpSubAgentSecurityPolicy,
} from './hmac';
import { requireAllowedDataRecord } from './http-internal';
import {
  decodeOwnedHttpSubAgentMultipartPacket,
  normalizeHttpSubAgentMultipartLimits,
  type HttpSubAgentMultipartLimits,
} from './multipart';
import type { HttpSubAgentRoute, HttpSubAgentRouteId } from './http-route';

export interface HttpSubAgentOwnerResolutionContext {
  readonly authContext: HttpSubAgentAuthContext;
  readonly route: HttpSubAgentRoute;
  readonly packet: SubAgentTransportPeerPacket;
}

export interface HttpSubAgentAuthorizationScope {
  readonly ownerSessionId: string;
  readonly method: 'POST';
  readonly routeId: Exclude<HttpSubAgentRouteId, 'heartbeat'>;
}

export interface HttpSubAgentPacketAdmissionContext extends HttpSubAgentOwnerResolutionContext {
  readonly ownerSessionId: string;
}

export type HttpSubAgentOwnerSessionResolver = (
  context: HttpSubAgentOwnerResolutionContext,
) => string | null | undefined | Promise<string | null | undefined>;

export type HttpSubAgentAuthorize = (
  authContext: HttpSubAgentAuthContext,
  scope: HttpSubAgentAuthorizationScope,
) => boolean | Promise<boolean>;

export interface HttpSubAgentAdmissionDiagnostic {
  readonly category:
    | 'request_rejected'
    | 'protocol_rejected'
    | 'dependency_unavailable'
    | 'internal_failure';
  readonly correlationDigest?: string;
  readonly status: 400 | 401 | 500 | 503;
}

export interface HttpSubAgentAdmissionResponse {
  readonly status: 204 | 400 | 401 | 500 | 503;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type HttpSubAgentAdmissionResult<T = void> =
  | Readonly<{
      status: 'accepted';
      response: HttpSubAgentAdmissionResponse;
      value: T;
    }>
  | Readonly<{
      status: 'rejected';
      response: HttpSubAgentAdmissionResponse;
    }>;

export interface AdmitHttpSubAgentPacketOptions<T = void> {
  readonly securityPolicy: HttpSubAgentSecurityPolicy;
  readonly now?: () => number;
  readonly keyResolver: HttpSubAgentHmacKeyResolver;
  readonly replayCache: HttpSubAgentReplayCache;
  readonly multipartLimits?: HttpSubAgentMultipartLimits;
  readonly resolveOwnerSessionId: HttpSubAgentOwnerSessionResolver;
  readonly authorize: HttpSubAgentAuthorize;
  readonly onPacket: (context: HttpSubAgentPacketAdmissionContext) => T | Promise<T>;
  readonly diagnostics?: (event: HttpSubAgentAdmissionDiagnostic) => void;
}

const RESPONSE_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'cache-control': 'no-store',
});
const ACCEPTED_RESPONSE = Object.freeze({
  status: 204,
  headers: Object.freeze({ 'cache-control': 'no-store' }),
  body: '',
}) satisfies HttpSubAgentAdmissionResponse;
const REJECTED_RESPONSES = Object.freeze({
  400: Object.freeze({
    status: 400,
    headers: RESPONSE_HEADERS,
    body: '{"error":"protocol_rejected"}',
  }),
  401: Object.freeze({
    status: 401,
    headers: RESPONSE_HEADERS,
    body: '{"error":"request_rejected"}',
  }),
  500: Object.freeze({
    status: 500,
    headers: RESPONSE_HEADERS,
    body: '{"error":"internal_failure"}',
  }),
  503: Object.freeze({
    status: 503,
    headers: RESPONSE_HEADERS,
    body: '{"error":"service_unavailable"}',
  }),
} satisfies Record<400 | 401 | 500 | 503, HttpSubAgentAdmissionResponse>);

/** Authenticates, atomically consumes replay, decodes, authorizes, then admits one Peer packet. */
export async function admitHttpSubAgentPacket<T = void>(
  request: HttpSubAgentRawRequest,
  options: AdmitHttpSubAgentPacketOptions<T>,
): Promise<HttpSubAgentAdmissionResult<T>> {
  // Configuration and programming errors are intentionally synchronous failures. They must
  // never consume replay state or masquerade as a transient request/backend failure.
  const normalized = normalizeAdmissionOptions(options);

  let authenticated: Awaited<
    ReturnType<ReturnType<typeof createHttpSubAgentHmacVerifier>['verify']>
  >;
  try {
    authenticated = await normalized.verifier.verify(request);
  } catch (error) {
    const status = error instanceof HttpSubAgentSecurityError ? error.statusCode : 503;
    return reject(
      status,
      status === 401 ? 'request_rejected' : 'dependency_unavailable',
      undefined,
      normalized.diagnostics,
    );
  }

  const correlationDigest = authenticated.authContext.correlationDigest;
  if (authenticated.route.id === 'heartbeat' || authenticated.contentType === null) {
    return reject(400, 'protocol_rejected', correlationDigest, normalized.diagnostics);
  }

  let packet: SubAgentTransportPeerPacket;
  try {
    packet = decodeOwnedHttpSubAgentMultipartPacket(
      { contentType: authenticated.contentType, body: authenticated.body },
      normalized.multipartLimits,
    );
  } catch {
    return reject(400, 'protocol_rejected', correlationDigest, normalized.diagnostics);
  }

  const ownerContext = Object.freeze({
    authContext: authenticated.authContext,
    route: authenticated.route,
    packet,
  }) satisfies HttpSubAgentOwnerResolutionContext;
  let ownerSessionId: string | null | undefined;
  try {
    ownerSessionId = await normalized.resolveOwnerSessionId(ownerContext);
  } catch {
    return reject(503, 'dependency_unavailable', correlationDigest, normalized.diagnostics);
  }
  if (!isOwnerSessionId(ownerSessionId)) {
    return reject(400, 'protocol_rejected', correlationDigest, normalized.diagnostics);
  }
  const scope = Object.freeze({
    ownerSessionId,
    method: 'POST',
    routeId: authenticated.route.id,
  }) satisfies HttpSubAgentAuthorizationScope;

  let authorized: boolean;
  try {
    authorized = await normalized.authorize(authenticated.authContext, scope);
  } catch {
    return reject(503, 'dependency_unavailable', correlationDigest, normalized.diagnostics);
  }
  if (authorized !== true) {
    return reject(401, 'request_rejected', correlationDigest, normalized.diagnostics);
  }

  const packetContext = Object.freeze({ ...ownerContext, ownerSessionId });
  try {
    const value = await normalized.onPacket(packetContext);
    return Object.freeze({ status: 'accepted', response: ACCEPTED_RESPONSE, value });
  } catch {
    return reject(500, 'internal_failure', correlationDigest, normalized.diagnostics);
  }
}

interface NormalizedAdmissionOptions<T> {
  readonly verifier: ReturnType<typeof createHttpSubAgentHmacVerifier>;
  readonly multipartLimits: HttpSubAgentMultipartLimits;
  readonly resolveOwnerSessionId: HttpSubAgentOwnerSessionResolver;
  readonly authorize: HttpSubAgentAuthorize;
  readonly onPacket: (context: HttpSubAgentPacketAdmissionContext) => T | Promise<T>;
  readonly diagnostics?: (event: HttpSubAgentAdmissionDiagnostic) => void;
}

function normalizeAdmissionOptions<T>(
  options: AdmitHttpSubAgentPacketOptions<T>,
): NormalizedAdmissionOptions<T> {
  const record = requireAllowedDataRecord(
    options,
    [
      'securityPolicy',
      'now',
      'keyResolver',
      'replayCache',
      'multipartLimits',
      'resolveOwnerSessionId',
      'authorize',
      'onPacket',
      'diagnostics',
    ],
    'HTTP packet admission options',
  );
  if (
    typeof record.keyResolver !== 'function' ||
    typeof record.resolveOwnerSessionId !== 'function' ||
    typeof record.authorize !== 'function' ||
    typeof record.onPacket !== 'function' ||
    (record.now !== undefined && typeof record.now !== 'function') ||
    (record.diagnostics !== undefined && typeof record.diagnostics !== 'function')
  ) {
    throw new TypeError('HTTP packet admission callbacks are invalid.');
  }
  const multipartLimits = normalizeHttpSubAgentMultipartLimits(
    (record.multipartLimits ?? {}) as HttpSubAgentMultipartLimits,
  );
  const verifier = createHttpSubAgentHmacVerifier({
    securityPolicy: record.securityPolicy as HttpSubAgentSecurityPolicy,
    keyResolver: record.keyResolver as HttpSubAgentHmacKeyResolver,
    replayCache: record.replayCache as HttpSubAgentReplayCache,
    ...(record.now ? { now: record.now as () => number } : {}),
  });
  return Object.freeze({
    verifier,
    multipartLimits,
    resolveOwnerSessionId: record.resolveOwnerSessionId as HttpSubAgentOwnerSessionResolver,
    authorize: record.authorize as HttpSubAgentAuthorize,
    onPacket: record.onPacket as (context: HttpSubAgentPacketAdmissionContext) => T | Promise<T>,
    ...(record.diagnostics
      ? { diagnostics: record.diagnostics as (event: HttpSubAgentAdmissionDiagnostic) => void }
      : {}),
  });
}

function isOwnerSessionId(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    hasC0OrDel(value)
  ) {
    return false;
  }
  return new TextEncoder().encode(value).byteLength <= 256;
}

function hasC0OrDel(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) return true;
  }
  return false;
}

function reject<T>(
  status: 400 | 401 | 500 | 503,
  category: HttpSubAgentAdmissionDiagnostic['category'],
  correlationDigest?: string,
  diagnostics?: (event: HttpSubAgentAdmissionDiagnostic) => void,
): HttpSubAgentAdmissionResult<T> {
  const event = Object.freeze({
    category,
    ...(correlationDigest ? { correlationDigest } : {}),
    status,
  }) satisfies HttpSubAgentAdmissionDiagnostic;
  try {
    const result = diagnostics?.(event) as unknown;
    if (result !== undefined) {
      // A TypeScript callback returning Promise<void> is assignable to a void callback. Observe
      // that promise without delaying or changing the fixed safe response.
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Diagnostics are intentionally best-effort and can never change the safe HTTP result.
  }
  return Object.freeze({ status: 'rejected', response: REJECTED_RESPONSES[status] });
}
