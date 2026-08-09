import {
  canonicalJsonSha256,
  canonicalizeJson,
  type JsonValue,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

import { requireAllowedDataRecord, requireClosedDataRecord } from './http-internal';
import { decodeHttpSubAgentRoutedPacket, type HttpSubAgentRoutedPacket } from './http-route-policy';
import type { HttpSubAgentRoute } from './http-route';
import {
  createHttpSubAgentRoutedPacketSemanticReceipt,
  sortedHttpSubAgentSidecarDescriptors,
} from './http-semantic-receipt-internal';

export const HTTP_SUBAGENT_JOB_RECORD_VERSION = '1' as const;
export const HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION = '0' as const;
export const DEFAULT_MEMORY_HTTP_SUBAGENT_JOB_CAPACITY = 10_000;
export const DEFAULT_MEMORY_HTTP_SUBAGENT_JOB_MAX_RETAINED_BYTES = 268_435_456 as const;

const INITIAL_JOB_REVISION = '0' as const;
const CREATE_ROUTE = Object.freeze({
  id: 'jobs.create',
  requestTarget: '/v1/jobs/create',
}) satisfies HttpSubAgentRoute;
const CREATE_IDENTITY_INPUT_KEYS = Object.freeze(['route', 'packet'] as const);
const CREATE_INPUT_KEYS = Object.freeze([
  'principalId',
  'ownerSessionId',
  'idempotencyKey',
  'jobId',
  'route',
  'packet',
] as const);
const JOB_SCOPE_KEYS = Object.freeze(['principalId', 'ownerSessionId', 'jobId'] as const);
const AUTHORIZATION_LOOKUP_KEYS = Object.freeze(['principalId', 'jobId'] as const);
const JOB_RECORD_KEYS = Object.freeze([
  'recordVersion',
  'state',
  'principalId',
  'ownerSessionId',
  'runId',
  'taskId',
  'jobId',
  'operationId',
  'idempotencyKey',
  'mode',
  'createIdentity',
  'createReceipt',
  'revision',
  'channelId',
  'channelGeneration',
  'remainingMsCeiling',
  'createdAt',
  'updatedAt',
  'createPacket',
] as const);
const OPAQUE_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const LOWER_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TEXT_ENCODER = new TextEncoder();
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;

export type HttpSubAgentJobStoreMode = 'durable' | 'loopback-test';

export interface HttpSubAgentJobCreateIdentityInput {
  readonly route: HttpSubAgentRoute;
  readonly packet: SubAgentTransportPeerPacket;
}

/** Stable create semantics plus the single owned packet snapshot from which they were derived. */
export interface HttpSubAgentJobCreateIdentity {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly mode: 'execute' | 'spawn';
  readonly channelId: string;
  readonly remainingMs: number;
  /** Lowercase SHA-256 of the canonical create request with transport-relative time removed. */
  readonly createIdentity: string;
  /** Full C7c-5b semantic receipt retained for first-write audit evidence. */
  readonly createReceipt: string;
  readonly packet: SubAgentTransportPeerPacket;
}

export interface HttpSubAgentJobCreateInput extends HttpSubAgentJobCreateIdentityInput {
  readonly principalId: string;
  readonly ownerSessionId: string;
  readonly idempotencyKey: string;
  /** First-writer candidate. An exact create replay returns the original winning job instead. */
  readonly jobId: string;
}

export interface HttpSubAgentJobScope {
  readonly principalId: string;
  readonly ownerSessionId: string;
  readonly jobId: string;
}

/** Trusted lookup used only to recover owner scope before the separate authorization callback. */
export interface HttpSubAgentJobAuthorizationLookup {
  readonly principalId: string;
  readonly jobId: string;
}

export interface HttpSubAgentJobAuthorizationResolution {
  readonly ownerSessionId: string;
}

/** Closed initial job record. Delivery state and mutable cursor fencing belong to C7c-5d. */
export interface HttpSubAgentJobRecordV1 {
  readonly recordVersion: typeof HTTP_SUBAGENT_JOB_RECORD_VERSION;
  readonly state: 'created';
  readonly principalId: string;
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly jobId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly mode: 'execute' | 'spawn';
  readonly createIdentity: string;
  readonly createReceipt: string;
  readonly revision: '0';
  readonly channelId: string;
  readonly channelGeneration: typeof HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION;
  readonly remainingMsCeiling: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly createPacket: SubAgentTransportPeerPacket;
}

export type HttpSubAgentJobCreateResult =
  | Readonly<{ status: 'created'; record: HttpSubAgentJobRecordV1 }>
  | Readonly<{ status: 'replayed'; record: HttpSubAgentJobRecordV1 }>;

/**
 * Atomic job persistence boundary.
 *
 * Durable implementations must atomically maintain the create-key, principal-scoped jobId and
 * principal/owner/task indexes. Their `dispose()` closes local resources but must not delete
 * durable records. Only the explicit Memory implementation below clears retained records.
 */
export interface HttpSubAgentJobStore {
  readonly mode: HttpSubAgentJobStoreMode;
  createOrReplay(input: HttpSubAgentJobCreateInput): Promise<HttpSubAgentJobCreateResult>;
  load(scope: HttpSubAgentJobScope): Promise<HttpSubAgentJobRecordV1 | undefined>;
  /**
   * Resolves trusted owner state after authentication. A handler must immediately invoke the
   * independent authorizer and must not expose found/missing/owner distinctions in its response.
   */
  resolveForAuthorization(
    lookup: HttpSubAgentJobAuthorizationLookup,
  ): Promise<HttpSubAgentJobAuthorizationResolution | undefined>;
  dispose(): Promise<void>;
}

export type HttpSubAgentJobStoreErrorCategory =
  | 'idempotency_conflict'
  | 'capacity_exhausted'
  | 'disposed';

/** Fixed, cause-free Store failure suitable for later safe HTTP error mapping. */
export class HttpSubAgentJobStoreError extends Error {
  readonly code = 'HTTP_SUBAGENT_JOB_STORE_ERROR' as const;
  readonly category: HttpSubAgentJobStoreErrorCategory;

  constructor(category: HttpSubAgentJobStoreErrorCategory) {
    super(jobStoreErrorMessage(category));
    this.name = 'HttpSubAgentJobStoreError';
    this.category = category;
  }
}

export interface MemoryHttpSubAgentJobStoreOptions {
  /** Process-local storage is deliberately ineligible for a production HTTP deployment. */
  readonly mode: 'loopback-test';
  readonly capacity?: number;
  /** Canonical frame + canonical sidecar descriptors + raw sidecar bytes retained by the Store. */
  readonly maxRetainedBytes?: number;
  readonly now?: () => number;
}

export interface MemoryHttpSubAgentJobStoreDiagnostics {
  readonly retainedJobs: number;
  readonly capacity: number;
  /** Protocol-retained bytes, not an estimate of the JavaScript engine's total heap overhead. */
  readonly retainedBytes: number;
  readonly maxRetainedBytes: number;
  readonly disposed: boolean;
}

/**
 * Strictly decodes one jobs.create packet and derives stable create identity without copying its
 * maximum-size sidecars a second time. `remainingMs` and Peer/HTTP delivery identity are excluded
 * from `createIdentity`; the returned `packet` is the owned snapshot used for both hashes.
 */
export function createHttpSubAgentJobCreateIdentity(
  input: HttpSubAgentJobCreateIdentityInput,
): HttpSubAgentJobCreateIdentity {
  const record = requireClosedDataRecord(
    input,
    CREATE_IDENTITY_INPUT_KEYS,
    'HTTP Subagent job create identity input',
  );
  const routed = decodeHttpSubAgentRoutedPacket(
    record.route as HttpSubAgentRoute,
    record.packet as SubAgentTransportPeerPacket,
  );
  return createIdentityFromRoutedPacket(routed);
}

/** Validates, cross-checks and owns one complete initial job record. */
export function normalizeHttpSubAgentJobRecord(value: unknown): HttpSubAgentJobRecordV1 {
  const record = requireClosedDataRecord(value, JOB_RECORD_KEYS, 'HTTP Subagent job record');
  if (
    record.recordVersion !== HTTP_SUBAGENT_JOB_RECORD_VERSION ||
    record.state !== 'created' ||
    record.revision !== INITIAL_JOB_REVISION ||
    record.channelGeneration !== HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION
  ) {
    throw new TypeError('HTTP Subagent job record version or initial state is invalid.');
  }
  const principalId = requireBoundedIdentifier(record.principalId, 'HTTP job principalId');
  const jobId = requireOpaqueJobId(record.jobId, 'HTTP job jobId');
  const createdAt = requireTimestamp(record.createdAt, 'HTTP job createdAt');
  const updatedAt = requireTimestamp(record.updatedAt, 'HTTP job updatedAt');
  if (updatedAt !== createdAt) {
    throw new TypeError('An initial HTTP Subagent job record must not advance updatedAt.');
  }
  const identity = createHttpSubAgentJobCreateIdentity({
    route: CREATE_ROUTE,
    packet: record.createPacket as SubAgentTransportPeerPacket,
  });
  if (
    record.ownerSessionId !== identity.ownerSessionId ||
    record.runId !== identity.runId ||
    record.taskId !== identity.taskId ||
    record.operationId !== identity.operationId ||
    record.idempotencyKey !== identity.idempotencyKey ||
    record.mode !== identity.mode ||
    record.channelId !== identity.channelId ||
    record.remainingMsCeiling !== identity.remainingMs ||
    record.createIdentity !== identity.createIdentity ||
    record.createReceipt !== identity.createReceipt
  ) {
    throw new TypeError('HTTP Subagent job record metadata does not match its create packet.');
  }
  if (
    typeof record.createIdentity !== 'string' ||
    !LOWER_SHA256_PATTERN.test(record.createIdentity) ||
    typeof record.createReceipt !== 'string' ||
    !LOWER_SHA256_PATTERN.test(record.createReceipt)
  ) {
    throw new TypeError('HTTP Subagent job record receipts are invalid.');
  }
  return freezeJobRecord({
    recordVersion: HTTP_SUBAGENT_JOB_RECORD_VERSION,
    state: 'created',
    principalId,
    ownerSessionId: identity.ownerSessionId,
    runId: identity.runId,
    taskId: identity.taskId,
    jobId,
    operationId: identity.operationId,
    idempotencyKey: identity.idempotencyKey,
    mode: identity.mode,
    createIdentity: identity.createIdentity,
    createReceipt: identity.createReceipt,
    revision: INITIAL_JOB_REVISION,
    channelId: identity.channelId,
    channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
    remainingMsCeiling: identity.remainingMs,
    createdAt,
    updatedAt,
    createPacket: identity.packet,
  });
}

/** Bounded, process-local job Store for explicit loopback tests only. */
export class MemoryHttpSubAgentJobStore implements HttpSubAgentJobStore {
  readonly mode = 'loopback-test' as const;
  readonly #capacity: number;
  readonly #maxRetainedBytes: number;
  readonly #now: () => number;
  readonly #jobsByCreateKey = new Map<string, HttpSubAgentJobRecordV1>();
  readonly #jobsByPrincipalJobId = new Map<string, HttpSubAgentJobRecordV1>();
  readonly #jobsByPrincipalOwnerTaskId = new Map<string, HttpSubAgentJobRecordV1>();
  #retainedBytes = 0;
  #disposed = false;

  constructor(options: MemoryHttpSubAgentJobStoreOptions) {
    const record = requireAllowedDataRecord(
      options,
      ['mode', 'capacity', 'maxRetainedBytes', 'now'],
      'Memory HTTP job Store options',
    );
    if (record.mode !== 'loopback-test') {
      throw new TypeError('Memory HTTP job Store requires explicit loopback-test mode.');
    }
    this.#capacity = requirePositiveSafeInteger(
      record.capacity ?? DEFAULT_MEMORY_HTTP_SUBAGENT_JOB_CAPACITY,
      'Memory HTTP job Store capacity',
    );
    this.#maxRetainedBytes = requirePositiveSafeInteger(
      record.maxRetainedBytes ?? DEFAULT_MEMORY_HTTP_SUBAGENT_JOB_MAX_RETAINED_BYTES,
      'Memory HTTP job Store maxRetainedBytes',
    );
    const now = record.now ?? Date.now;
    if (typeof now !== 'function') {
      throw new TypeError('Memory HTTP job Store now must be a function.');
    }
    this.#now = now as () => number;
    Object.freeze(this);
  }

  async createOrReplay(input: HttpSubAgentJobCreateInput): Promise<HttpSubAgentJobCreateResult> {
    this.#assertActive();
    const normalized = normalizeCreateInput(input);
    const createKey = jobCreateKey(normalized);
    const existing = this.#jobsByCreateKey.get(createKey);
    if (existing !== undefined) return replayExisting(existing, normalized);

    const now = readClock(this.#now);
    this.#assertActive();
    const raced = this.#jobsByCreateKey.get(createKey);
    if (raced !== undefined) return replayExisting(raced, normalized);

    const principalJobId = principalJobKey(normalized);
    const principalOwnerTaskId = principalOwnerTaskKey(normalized);
    if (
      this.#jobsByPrincipalJobId.has(principalJobId) ||
      this.#jobsByPrincipalOwnerTaskId.has(principalOwnerTaskId)
    ) {
      throw new HttpSubAgentJobStoreError('idempotency_conflict');
    }
    const retainedBytes = packetRetainedBytes(normalized.identity.packet);
    if (
      this.#jobsByCreateKey.size >= this.#capacity ||
      retainedBytes > this.#maxRetainedBytes - this.#retainedBytes
    ) {
      throw new HttpSubAgentJobStoreError('capacity_exhausted');
    }

    const stored = freezeJobRecord({
      recordVersion: HTTP_SUBAGENT_JOB_RECORD_VERSION,
      state: 'created',
      principalId: normalized.principalId,
      ownerSessionId: normalized.identity.ownerSessionId,
      runId: normalized.identity.runId,
      taskId: normalized.identity.taskId,
      jobId: normalized.jobId,
      operationId: normalized.identity.operationId,
      idempotencyKey: normalized.identity.idempotencyKey,
      mode: normalized.identity.mode,
      createIdentity: normalized.identity.createIdentity,
      createReceipt: normalized.identity.createReceipt,
      revision: INITIAL_JOB_REVISION,
      channelId: normalized.identity.channelId,
      channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
      remainingMsCeiling: normalized.identity.remainingMs,
      createdAt: now,
      updatedAt: now,
      createPacket: normalized.identity.packet,
    });
    this.#jobsByCreateKey.set(createKey, stored);
    this.#jobsByPrincipalJobId.set(principalJobId, stored);
    this.#jobsByPrincipalOwnerTaskId.set(principalOwnerTaskId, stored);
    this.#retainedBytes += retainedBytes;
    return freezeCreateResult('created', cloneJobRecord(stored));
  }

  async load(scopeInput: HttpSubAgentJobScope): Promise<HttpSubAgentJobRecordV1 | undefined> {
    this.#assertActive();
    const scope = normalizeJobScope(scopeInput);
    const record = this.#jobsByPrincipalJobId.get(principalJobKey(scope));
    if (record === undefined || record.ownerSessionId !== scope.ownerSessionId) return undefined;
    return cloneJobRecord(record);
  }

  async resolveForAuthorization(
    lookupInput: HttpSubAgentJobAuthorizationLookup,
  ): Promise<HttpSubAgentJobAuthorizationResolution | undefined> {
    this.#assertActive();
    const lookup = normalizeAuthorizationLookup(lookupInput);
    const record = this.#jobsByPrincipalJobId.get(principalJobKey(lookup));
    return record === undefined
      ? undefined
      : Object.freeze({ ownerSessionId: record.ownerSessionId });
  }

  get diagnostics(): MemoryHttpSubAgentJobStoreDiagnostics {
    return Object.freeze({
      retainedJobs: this.#jobsByCreateKey.size,
      capacity: this.#capacity,
      retainedBytes: this.#retainedBytes,
      maxRetainedBytes: this.#maxRetainedBytes,
      disposed: this.#disposed,
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const record of this.#jobsByPrincipalJobId.values()) {
      for (const sidecar of record.createPacket.sidecars) {
        Reflect.apply(UINT8_ARRAY_FILL, sidecar.data, [0]);
      }
    }
    this.#jobsByCreateKey.clear();
    this.#jobsByPrincipalJobId.clear();
    this.#jobsByPrincipalOwnerTaskId.clear();
    this.#retainedBytes = 0;
  }

  #assertActive(): void {
    if (this.#disposed) throw new HttpSubAgentJobStoreError('disposed');
  }
}

interface NormalizedCreateInput {
  readonly principalId: string;
  readonly jobId: string;
  readonly identity: HttpSubAgentJobCreateIdentity;
}

function normalizeCreateInput(input: HttpSubAgentJobCreateInput): NormalizedCreateInput {
  const record = requireClosedDataRecord(
    input,
    CREATE_INPUT_KEYS,
    'HTTP Subagent job create input',
  );
  const principalId = requireBoundedIdentifier(record.principalId, 'HTTP job principalId');
  const ownerSessionId = requireBoundedIdentifier(record.ownerSessionId, 'HTTP job ownerSessionId');
  const idempotencyKey = requireBoundedIdentifier(record.idempotencyKey, 'HTTP job idempotencyKey');
  const jobId = requireOpaqueJobId(record.jobId, 'HTTP job jobId');
  const identity = createHttpSubAgentJobCreateIdentity({
    route: record.route as HttpSubAgentRoute,
    packet: record.packet as SubAgentTransportPeerPacket,
  });
  if (identity.ownerSessionId !== ownerSessionId || identity.idempotencyKey !== idempotencyKey) {
    throw new TypeError('HTTP job create scope does not match its strict executor request.');
  }
  return Object.freeze({ principalId, jobId, identity });
}

function normalizeJobScope(input: HttpSubAgentJobScope): HttpSubAgentJobScope {
  const record = requireClosedDataRecord(input, JOB_SCOPE_KEYS, 'HTTP Subagent job scope');
  return Object.freeze({
    principalId: requireBoundedIdentifier(record.principalId, 'HTTP job principalId'),
    ownerSessionId: requireBoundedIdentifier(record.ownerSessionId, 'HTTP job ownerSessionId'),
    jobId: requireOpaqueJobId(record.jobId, 'HTTP job jobId'),
  });
}

function normalizeAuthorizationLookup(
  input: HttpSubAgentJobAuthorizationLookup,
): HttpSubAgentJobAuthorizationLookup {
  const record = requireClosedDataRecord(
    input,
    AUTHORIZATION_LOOKUP_KEYS,
    'HTTP Subagent job authorization lookup',
  );
  return Object.freeze({
    principalId: requireBoundedIdentifier(record.principalId, 'HTTP job principalId'),
    jobId: requireOpaqueJobId(record.jobId, 'HTTP job jobId'),
  });
}

function createIdentityFromRoutedPacket(
  routed: HttpSubAgentRoutedPacket,
): HttpSubAgentJobCreateIdentity {
  if (routed.route.id !== 'jobs.create' || routed.envelope.kind !== 'executor.request') {
    throw new TypeError('HTTP job create identity requires the jobs.create route.');
  }
  const payload = routed.envelope.payload;
  if (payload.request.operation.type !== 'create') {
    throw new TypeError('HTTP job create identity requires a strict create operation.');
  }
  const stableRequest: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(payload.request)) {
    if (key !== 'remainingMs') stableRequest[key] = value as JsonValue;
  }
  const createIdentity = canonicalJsonSha256({
    version: HTTP_SUBAGENT_JOB_RECORD_VERSION,
    mode: payload.mode,
    requestWithoutRemainingMs: stableRequest,
    sidecarDescriptorsSortedBySidecarId: sortedHttpSubAgentSidecarDescriptors(routed),
  } as unknown as JsonValue);

  return Object.freeze({
    ownerSessionId: payload.request.ownerSessionId,
    runId: payload.request.runId,
    taskId: payload.request.taskId,
    operationId: payload.request.operation.operationId,
    idempotencyKey: payload.request.operation.idempotencyKey,
    mode: payload.mode,
    channelId: routed.envelope.channelId,
    remainingMs: payload.request.remainingMs,
    createIdentity,
    createReceipt: createHttpSubAgentRoutedPacketSemanticReceipt(routed),
    packet: routed.packet,
  });
}

function freezeJobRecord(record: HttpSubAgentJobRecordV1): HttpSubAgentJobRecordV1 {
  return Object.freeze(record);
}

function cloneJobRecord(record: HttpSubAgentJobRecordV1): HttpSubAgentJobRecordV1 {
  const packet = decodeHttpSubAgentRoutedPacket(CREATE_ROUTE, record.createPacket).packet;
  return freezeJobRecord({
    recordVersion: record.recordVersion,
    state: record.state,
    principalId: record.principalId,
    ownerSessionId: record.ownerSessionId,
    runId: record.runId,
    taskId: record.taskId,
    jobId: record.jobId,
    operationId: record.operationId,
    idempotencyKey: record.idempotencyKey,
    mode: record.mode,
    createIdentity: record.createIdentity,
    createReceipt: record.createReceipt,
    revision: record.revision,
    channelId: record.channelId,
    channelGeneration: record.channelGeneration,
    remainingMsCeiling: record.remainingMsCeiling,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createPacket: packet,
  });
}

function freezeCreateResult(
  status: 'created' | 'replayed',
  record: HttpSubAgentJobRecordV1,
): HttpSubAgentJobCreateResult {
  return status === 'created'
    ? Object.freeze({ status: 'created', record })
    : Object.freeze({ status: 'replayed', record });
}

function replayExisting(
  existing: HttpSubAgentJobRecordV1,
  candidate: NormalizedCreateInput,
): HttpSubAgentJobCreateResult {
  if (
    existing.createIdentity !== candidate.identity.createIdentity ||
    candidate.identity.remainingMs > existing.remainingMsCeiling
  ) {
    throw new HttpSubAgentJobStoreError('idempotency_conflict');
  }
  return freezeCreateResult('replayed', cloneJobRecord(existing));
}

function jobCreateKey(input: {
  readonly principalId: string;
  readonly identity: Pick<HttpSubAgentJobCreateIdentity, 'ownerSessionId' | 'idempotencyKey'>;
}): string {
  return canonicalizeJson({
    principalId: input.principalId,
    ownerSessionId: input.identity.ownerSessionId,
    idempotencyKey: input.identity.idempotencyKey,
  });
}

function principalJobKey(input: { readonly principalId: string; readonly jobId: string }): string {
  return canonicalizeJson({ principalId: input.principalId, jobId: input.jobId });
}

function principalOwnerTaskKey(input: {
  readonly principalId: string;
  readonly identity: Pick<HttpSubAgentJobCreateIdentity, 'ownerSessionId' | 'taskId'>;
}): string {
  return canonicalizeJson({
    principalId: input.principalId,
    ownerSessionId: input.identity.ownerSessionId,
    taskId: input.identity.taskId,
  });
}

function packetRetainedBytes(packet: SubAgentTransportPeerPacket): number {
  let total =
    typeof packet.frame === 'string'
      ? TEXT_ENCODER.encode(packet.frame).byteLength
      : packet.frame.byteLength;
  for (const sidecar of packet.sidecars) {
    const descriptorBytes = TEXT_ENCODER.encode(
      canonicalizeJson(sidecar.descriptor as unknown as JsonValue),
    ).byteLength;
    total = addRetainedBytes(total, descriptorBytes);
    total = addRetainedBytes(total, sidecar.data.byteLength);
  }
  return total;
}

function addRetainedBytes(total: number, increment: number): number {
  if (
    !Number.isSafeInteger(increment) ||
    increment < 0 ||
    total > Number.MAX_SAFE_INTEGER - increment
  ) {
    throw new RangeError('HTTP job retained byte count exceeds safe integer range.');
  }
  return total + increment;
}

function requireBoundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    containsControlCharacter(value) ||
    TEXT_ENCODER.encode(value).byteLength > 256
  ) {
    throw new TypeError(`${label} must be a trimmed, bounded identifier without controls.`);
  }
  canonicalizeJson(value);
  return value;
}

function requireOpaqueJobId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_JOB_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical opaque route identifier.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function readClock(now: () => number): number {
  return requireTimestamp(now(), 'Memory HTTP job Store clock');
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function jobStoreErrorMessage(category: HttpSubAgentJobStoreErrorCategory): string {
  switch (category) {
    case 'idempotency_conflict':
      return 'The HTTP Subagent job create operation conflicts with retained state.';
    case 'capacity_exhausted':
      return 'The Memory HTTP Subagent job Store capacity is exhausted.';
    case 'disposed':
      return 'The HTTP Subagent job Store is disposed.';
  }
}
