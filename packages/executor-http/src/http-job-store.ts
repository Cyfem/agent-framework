import { types as nodeTypes } from 'node:util';

import {
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
  canonicalJsonSha256,
  canonicalizeJson,
  decodeSubAgentTransportArtifactSidecar,
  decodeSubAgentTransportRpcFrame,
  encodeSubAgentTransportRpcFrame,
  type JsonValue,
  type SubAgentTransportArtifactSidecar,
  type SubAgentTransportArtifactSidecarDescriptor,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportRpcEnvelope,
} from '@ruixutong.manee/maneeagent-framework';

import {
  copyHttpBytes,
  requireAllowedDataRecord,
  requireClosedDataRecord,
  requireDenseDataArray,
} from './http-internal';
import { HTTP_SUBAGENT_MAX_POLL_WAIT_MS } from './http-poll';
import { decodeHttpSubAgentRoutedPacket, type HttpSubAgentRoutedPacket } from './http-route-policy';
import type { HttpSubAgentRoute } from './http-route';
import {
  createHttpSubAgentRoutedPacketSemanticReceipt,
  sortedHttpSubAgentSidecarDescriptors,
} from './http-semantic-receipt-internal';

export const HTTP_SUBAGENT_JOB_RECORD_VERSION = '1' as const;
export const HTTP_SUBAGENT_JOB_DELIVERY_VERSION = '1' as const;
export const HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION = '0' as const;
export const DEFAULT_MEMORY_HTTP_SUBAGENT_JOB_CAPACITY = 10_000;
export const DEFAULT_MEMORY_HTTP_SUBAGENT_JOB_MAX_RETAINED_BYTES = 268_435_456 as const;
export const DEFAULT_MEMORY_HTTP_SUBAGENT_DELIVERY_CAPACITY = 10_000;
export const DEFAULT_MEMORY_HTTP_SUBAGENT_JOB_MAX_DELIVERY_RETAINED_BYTES = 268_435_456 as const;
export const DEFAULT_MEMORY_HTTP_SUBAGENT_DELIVERY_RECEIPT_CAPACITY = 100_000;
export const DEFAULT_MEMORY_HTTP_SUBAGENT_JOB_WAITER_CAPACITY = 1_000;

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
const IO_CONTEXT_KEYS = Object.freeze(['signal', 'deadlineAt'] as const);
const ENQUEUE_OUTBOUND_KEYS = Object.freeze([
  'principalId',
  'ownerSessionId',
  'jobId',
  'channelId',
  'channelGeneration',
  'packet',
] as const);
const POLL_OUTBOUND_KEYS = Object.freeze([
  'principalId',
  'ownerSessionId',
  'jobId',
  'channelId',
  'channelGeneration',
  'ackCursor',
] as const);
const WAIT_FOR_OUTBOUND_KEYS = Object.freeze([
  'principalId',
  'ownerSessionId',
  'jobId',
  'channelId',
  'channelGeneration',
  'observedRevision',
  'waitMs',
] as const);
const DELIVERY_STATE_KEYS = Object.freeze([
  'deliveryVersion',
  'revision',
  'channelId',
  'channelGeneration',
  'ackCursor',
  'offeredCursor',
  'outstandingDeliveries',
  'updatedAt',
] as const);
const PEER_PACKET_KEYS = Object.freeze(['frame', 'sidecars'] as const);
const SIDECAR_KEYS = Object.freeze(['descriptor', 'data'] as const);
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
const CHANNEL_ID_PATTERN = OPAQUE_JOB_ID_PATTERN;
const LOWER_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UINT64_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const UINT64_MAX_DECIMAL = '18446744073709551615';
const UINT64_MAX = 18_446_744_073_709_551_615n;
const TEXT_ENCODER = new TextEncoder();
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get as (this: AbortSignal) => boolean;
const EVENT_TARGET_ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const EVENT_TARGET_REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;

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

/** Optional cancellation/deadline scope for one durable Store I/O operation. */
export interface HttpSubAgentJobStoreIoContext {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

/** Closed observation snapshot. Revision and remote cursor never reuse Core Peer sequence. */
export interface HttpSubAgentJobDeliveryStateV1 {
  readonly deliveryVersion: typeof HTTP_SUBAGENT_JOB_DELIVERY_VERSION;
  readonly revision: string;
  readonly channelId: string;
  readonly channelGeneration: typeof HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION;
  readonly ackCursor: string;
  readonly offeredCursor: string | null;
  readonly outstandingDeliveries: number;
  readonly updatedAt: number;
}

export interface HttpSubAgentJobEnqueueOutboundInput extends HttpSubAgentJobScope {
  readonly channelId: string;
  readonly channelGeneration: string;
  readonly packet: SubAgentTransportPeerPacket;
}

export type HttpSubAgentJobEnqueueOutboundResult = Readonly<{
  status: 'enqueued' | 'replayed';
  revision: string;
  cursor: string;
  messageId: string;
  packetReceipt: string;
}>;

export interface HttpSubAgentJobPollOutboundInput extends HttpSubAgentJobScope {
  readonly channelId: string;
  readonly channelGeneration: string;
  readonly ackCursor: string;
}

export interface HttpSubAgentJobOutboundDeliveryV1 {
  readonly cursor: string;
  readonly packetReceipt: string;
  readonly packet: SubAgentTransportPeerPacket;
}

export interface HttpSubAgentJobPollOutboundResult {
  readonly deliveryVersion: typeof HTTP_SUBAGENT_JOB_DELIVERY_VERSION;
  readonly revision: string;
  readonly channelId: string;
  readonly channelGeneration: typeof HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION;
  readonly ackCursor: string;
  readonly delivery: HttpSubAgentJobOutboundDeliveryV1 | null;
}

export interface HttpSubAgentJobWaitForOutboundInput extends HttpSubAgentJobScope {
  readonly channelId: string;
  readonly channelGeneration: string;
  readonly observedRevision: string;
  readonly waitMs: number;
}

export type HttpSubAgentJobWaitForOutboundResult = Readonly<{
  status: 'changed' | 'timed_out';
  state: HttpSubAgentJobDeliveryStateV1;
}>;

/**
 * Atomic job persistence boundary.
 *
 * Durable implementations must atomically maintain the create-key, principal-scoped jobId and
 * principal/owner/task indexes. Their `dispose()` closes local resources but must not delete
 * durable records. Only the explicit Memory implementation below clears retained records.
 */
export interface HttpSubAgentJobStore {
  readonly mode: HttpSubAgentJobStoreMode;
  createOrReplay(
    input: HttpSubAgentJobCreateInput,
    context?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobCreateResult>;
  load(
    scope: HttpSubAgentJobScope,
    context?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobRecordV1 | undefined>;
  /**
   * Resolves trusted owner state after authentication. A handler must immediately invoke the
   * independent authorizer and must not expose found/missing/owner distinctions in its response.
   */
  resolveForAuthorization(
    lookup: HttpSubAgentJobAuthorizationLookup,
    context?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobAuthorizationResolution | undefined>;
  dispose(): Promise<void>;
}

/** Semantic delivery mutations required in addition to the immutable create/replay boundary. */
export interface HttpSubAgentJobDeliveryStore extends HttpSubAgentJobStore {
  loadDelivery(
    scope: HttpSubAgentJobScope,
    context?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobDeliveryStateV1 | undefined>;
  enqueueOutbound(
    input: HttpSubAgentJobEnqueueOutboundInput,
    context?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobEnqueueOutboundResult>;
  pollOutbound(
    input: HttpSubAgentJobPollOutboundInput,
    context?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobPollOutboundResult>;
  waitForOutbound(
    input: HttpSubAgentJobWaitForOutboundInput,
    context?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobWaitForOutboundResult>;
}

export type HttpSubAgentJobStoreErrorCategory =
  | 'resource_not_found'
  | 'idempotency_conflict'
  | 'attachment_fenced'
  | 'cursor_conflict'
  | 'capacity_exhausted'
  | 'counter_exhausted'
  | 'aborted'
  | 'deadline_exceeded'
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
  readonly deliveryCapacity?: number;
  /** Protocol-retained bytes for unacknowledged outbound packets. */
  readonly maxDeliveryRetainedBytes?: number;
  /** Compact enqueue receipts survive ACK so exact writer replay cannot redeliver. */
  readonly deliveryReceiptCapacity?: number;
  readonly waiterCapacity?: number;
  readonly now?: () => number;
}

export interface MemoryHttpSubAgentJobStoreDiagnostics {
  readonly retainedJobs: number;
  readonly capacity: number;
  /** Protocol-retained bytes, not an estimate of the JavaScript engine's total heap overhead. */
  readonly retainedBytes: number;
  readonly maxRetainedBytes: number;
  readonly outstandingDeliveries: number;
  readonly deliveryCapacity: number;
  readonly deliveryRetainedBytes: number;
  readonly maxDeliveryRetainedBytes: number;
  readonly retainedDeliveryReceipts: number;
  readonly deliveryReceiptCapacity: number;
  readonly activeWaiters: number;
  readonly waiterCapacity: number;
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

/** Validates and owns one closed delivery observation snapshot for durable adapter boundaries. */
export function normalizeHttpSubAgentJobDeliveryState(
  value: unknown,
): HttpSubAgentJobDeliveryStateV1 {
  const record = requireClosedDataRecord(
    value,
    DELIVERY_STATE_KEYS,
    'HTTP Subagent job delivery state',
  );
  if (
    record.deliveryVersion !== HTTP_SUBAGENT_JOB_DELIVERY_VERSION ||
    record.channelGeneration !== HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION
  ) {
    throw new TypeError('HTTP Subagent job delivery state version or generation is invalid.');
  }
  const revision = requireCanonicalUint64Decimal(record.revision, 'HTTP job delivery revision');
  const channelId = requireChannelId(record.channelId, 'HTTP job delivery channelId');
  const ackCursor = requireCanonicalUint64Decimal(record.ackCursor, 'HTTP job delivery ackCursor');
  const offeredCursor =
    record.offeredCursor === null
      ? null
      : requireCanonicalUint64Decimal(record.offeredCursor, 'HTTP job delivery offeredCursor');
  const outstandingDeliveries = requireNonNegativeSafeInteger(
    record.outstandingDeliveries,
    'HTTP job delivery outstandingDeliveries',
  );
  if (
    offeredCursor !== null &&
    (ackCursor === UINT64_MAX_DECIMAL || BigInt(offeredCursor) !== BigInt(ackCursor) + 1n)
  ) {
    throw new TypeError('HTTP job delivery offeredCursor must be the next remote cursor.');
  }
  if (offeredCursor !== null && outstandingDeliveries === 0) {
    throw new TypeError('HTTP job delivery cannot offer an absent outbound packet.');
  }
  if (ackCursor === UINT64_MAX_DECIMAL && outstandingDeliveries !== 0) {
    throw new TypeError('HTTP job delivery cannot retain packets after its cursor is exhausted.');
  }
  if (
    compareCanonicalUint64(ackCursor, revision) > 0 ||
    (offeredCursor !== null && compareCanonicalUint64(offeredCursor, revision) > 0)
  ) {
    throw new TypeError('HTTP job delivery cursors cannot exceed its revision.');
  }
  if (BigInt(ackCursor) + BigInt(outstandingDeliveries) > BigInt(revision)) {
    throw new TypeError('HTTP job delivery outstanding cursors cannot exceed its revision.');
  }
  return Object.freeze({
    deliveryVersion: HTTP_SUBAGENT_JOB_DELIVERY_VERSION,
    revision,
    channelId,
    channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
    ackCursor,
    offeredCursor,
    outstandingDeliveries,
    updatedAt: requireTimestamp(record.updatedAt, 'HTTP job delivery updatedAt'),
  });
}

interface MemoryHttpSubAgentDeliveryReceipt {
  readonly channelGeneration: typeof HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION;
  readonly messageId: string;
  readonly sequence: number;
  readonly packetReceipt: string;
  readonly cursor: string;
}

interface MemoryHttpSubAgentOutstandingDelivery extends MemoryHttpSubAgentDeliveryReceipt {
  readonly packet: SubAgentTransportPeerPacket;
  readonly retainedBytes: number;
}

interface MemoryHttpSubAgentJobEntry {
  readonly record: HttpSubAgentJobRecordV1;
  revision: string;
  ackCursor: string;
  offeredCursor: string | null;
  lastCursor: string;
  lastPeerSequence: number;
  updatedAt: number;
  readonly outbound: MemoryHttpSubAgentOutstandingDelivery[];
  readonly receiptsByMessage: Map<string, MemoryHttpSubAgentDeliveryReceipt>;
  readonly receiptsBySequence: Map<string, MemoryHttpSubAgentDeliveryReceipt>;
  readonly waiters: Set<MemoryHttpSubAgentWaiter>;
}

interface MemoryHttpSubAgentWaiter {
  readonly entry: MemoryHttpSubAgentJobEntry;
  readonly signal?: AbortSignal;
  readonly resolve: (result: HttpSubAgentJobWaitForOutboundResult) => void;
  readonly reject: (error: HttpSubAgentJobStoreError) => void;
  abortListener?: EventListener;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/** Bounded, process-local job Store for explicit loopback tests only. */
export class MemoryHttpSubAgentJobStore implements HttpSubAgentJobDeliveryStore {
  readonly mode = 'loopback-test' as const;
  readonly #capacity: number;
  readonly #maxRetainedBytes: number;
  readonly #deliveryCapacity: number;
  readonly #maxDeliveryRetainedBytes: number;
  readonly #deliveryReceiptCapacity: number;
  readonly #waiterCapacity: number;
  readonly #now: () => number;
  readonly #jobsByCreateKey = new Map<string, MemoryHttpSubAgentJobEntry>();
  readonly #jobsByPrincipalJobId = new Map<string, MemoryHttpSubAgentJobEntry>();
  readonly #jobsByPrincipalOwnerTaskId = new Map<string, MemoryHttpSubAgentJobEntry>();
  readonly #waiters = new Set<MemoryHttpSubAgentWaiter>();
  #retainedBytes = 0;
  #outstandingDeliveries = 0;
  #deliveryRetainedBytes = 0;
  #retainedDeliveryReceipts = 0;
  #lastObservedAt: number | undefined;
  #disposed = false;

  constructor(options: MemoryHttpSubAgentJobStoreOptions) {
    const record = requireAllowedDataRecord(
      options,
      [
        'mode',
        'capacity',
        'maxRetainedBytes',
        'deliveryCapacity',
        'maxDeliveryRetainedBytes',
        'deliveryReceiptCapacity',
        'waiterCapacity',
        'now',
      ],
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
    this.#deliveryCapacity = requirePositiveSafeInteger(
      record.deliveryCapacity ?? DEFAULT_MEMORY_HTTP_SUBAGENT_DELIVERY_CAPACITY,
      'Memory HTTP job Store deliveryCapacity',
    );
    this.#maxDeliveryRetainedBytes = requirePositiveSafeInteger(
      record.maxDeliveryRetainedBytes ??
        DEFAULT_MEMORY_HTTP_SUBAGENT_JOB_MAX_DELIVERY_RETAINED_BYTES,
      'Memory HTTP job Store maxDeliveryRetainedBytes',
    );
    this.#deliveryReceiptCapacity = requirePositiveSafeInteger(
      record.deliveryReceiptCapacity ?? DEFAULT_MEMORY_HTTP_SUBAGENT_DELIVERY_RECEIPT_CAPACITY,
      'Memory HTTP job Store deliveryReceiptCapacity',
    );
    this.#waiterCapacity = requirePositiveSafeInteger(
      record.waiterCapacity ?? DEFAULT_MEMORY_HTTP_SUBAGENT_JOB_WAITER_CAPACITY,
      'Memory HTTP job Store waiterCapacity',
    );
    const now = record.now ?? Date.now;
    if (typeof now !== 'function') {
      throw new TypeError('Memory HTTP job Store now must be a function.');
    }
    this.#now = now as () => number;
    Object.freeze(this);
  }

  async createOrReplay(
    input: HttpSubAgentJobCreateInput,
    contextInput?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobCreateResult> {
    this.#assertActive();
    const context = normalizeIoContext(contextInput);
    assertIoSignalActive(context);
    this.#assertIoDeadline(context);
    const normalized = normalizeCreateInput(input);
    this.#assertIoDeadline(context);
    const createKey = jobCreateKey(normalized);
    const existing = this.#jobsByCreateKey.get(createKey);
    if (existing !== undefined) return replayExisting(existing.record, normalized);

    const now = this.#readMutationClock(context);
    const raced = this.#jobsByCreateKey.get(createKey);
    if (raced !== undefined) return replayExisting(raced.record, normalized);

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
    const entry: MemoryHttpSubAgentJobEntry = {
      record: stored,
      revision: INITIAL_JOB_REVISION,
      ackCursor: '0',
      offeredCursor: null,
      lastCursor: '0',
      lastPeerSequence: 0,
      updatedAt: now,
      outbound: [],
      receiptsByMessage: new Map(),
      receiptsBySequence: new Map(),
      waiters: new Set(),
    };
    this.#jobsByCreateKey.set(createKey, entry);
    this.#jobsByPrincipalJobId.set(principalJobId, entry);
    this.#jobsByPrincipalOwnerTaskId.set(principalOwnerTaskId, entry);
    this.#retainedBytes += retainedBytes;
    return freezeCreateResult('created', cloneJobRecord(stored));
  }

  async load(
    scopeInput: HttpSubAgentJobScope,
    contextInput?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobRecordV1 | undefined> {
    this.#assertActive();
    const context = normalizeIoContext(contextInput);
    assertIoSignalActive(context);
    const scope = normalizeJobScope(scopeInput);
    this.#assertIoDeadline(context);
    const entry = this.#findEntry(scope);
    return entry === undefined ? undefined : cloneJobRecord(entry.record);
  }

  async resolveForAuthorization(
    lookupInput: HttpSubAgentJobAuthorizationLookup,
    contextInput?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobAuthorizationResolution | undefined> {
    this.#assertActive();
    const context = normalizeIoContext(contextInput);
    assertIoSignalActive(context);
    const lookup = normalizeAuthorizationLookup(lookupInput);
    this.#assertIoDeadline(context);
    const entry = this.#jobsByPrincipalJobId.get(principalJobKey(lookup));
    return entry === undefined
      ? undefined
      : Object.freeze({ ownerSessionId: entry.record.ownerSessionId });
  }

  async loadDelivery(
    scopeInput: HttpSubAgentJobScope,
    contextInput?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobDeliveryStateV1 | undefined> {
    this.#assertActive();
    const context = normalizeIoContext(contextInput);
    assertIoSignalActive(context);
    const scope = normalizeJobScope(scopeInput);
    this.#assertIoDeadline(context);
    const entry = this.#findEntry(scope);
    return entry === undefined ? undefined : deliveryState(entry);
  }

  async enqueueOutbound(
    input: HttpSubAgentJobEnqueueOutboundInput,
    contextInput?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobEnqueueOutboundResult> {
    this.#assertActive();
    const context = normalizeIoContext(contextInput);
    assertIoSignalActive(context);
    const header = normalizeEnqueueOutboundHeader(input);
    let entry = this.#requireEntry(header.scope);
    assertAttachment(entry, header.channelId, header.channelGeneration);
    this.#assertIoDeadline(context);
    const owned = ownOutboundPacket(header.packet, header.channelId);
    this.#assertIoDeadline(context);
    const normalized = Object.freeze({
      scope: header.scope,
      channelId: header.channelId,
      channelGeneration: header.channelGeneration,
      ...owned,
    }) satisfies NormalizedOutboundPacket;
    entry = this.#requireEntry(normalized.scope);
    assertAttachment(entry, normalized.channelId, normalized.channelGeneration);
    if (normalized.envelope.channelId !== normalized.channelId) {
      throw new HttpSubAgentJobStoreError('attachment_fenced');
    }
    const replay = findDeliveryReplay(entry, normalized);
    if (replay !== undefined) return enqueueResult('replayed', entry.revision, replay);
    assertNextPeerSequence(entry, normalized.envelope.sequence);
    this.#assertDeliveryCapacity(normalized.retainedBytes);
    incrementUint64(entry.lastCursor);
    incrementUint64(entry.revision);

    const now = this.#readMutationClock(context);
    entry = this.#requireEntry(normalized.scope);
    assertAttachment(entry, normalized.channelId, normalized.channelGeneration);
    if (normalized.envelope.channelId !== normalized.channelId) {
      throw new HttpSubAgentJobStoreError('attachment_fenced');
    }
    const raced = findDeliveryReplay(entry, normalized);
    if (raced !== undefined) return enqueueResult('replayed', entry.revision, raced);
    assertNextPeerSequence(entry, normalized.envelope.sequence);
    this.#assertDeliveryCapacity(normalized.retainedBytes);
    const committedCursor = incrementUint64(entry.lastCursor);
    const committedRevision = incrementUint64(entry.revision);
    assertClockDidNotRegress(now, entry.updatedAt);

    const receipt = Object.freeze({
      channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
      messageId: normalized.envelope.messageId,
      sequence: normalized.envelope.sequence,
      packetReceipt: normalized.packetReceipt,
      cursor: committedCursor,
    }) satisfies MemoryHttpSubAgentDeliveryReceipt;
    const delivery = Object.freeze({
      ...receipt,
      packet: normalized.packet,
      retainedBytes: normalized.retainedBytes,
    }) satisfies MemoryHttpSubAgentOutstandingDelivery;
    entry.receiptsByMessage.set(deliveryMessageKey(receipt), receipt);
    entry.receiptsBySequence.set(deliverySequenceKey(receipt), receipt);
    entry.outbound.push(delivery);
    entry.lastPeerSequence = receipt.sequence;
    entry.lastCursor = receipt.cursor;
    entry.revision = committedRevision;
    entry.updatedAt = now;
    this.#outstandingDeliveries += 1;
    this.#deliveryRetainedBytes += delivery.retainedBytes;
    this.#retainedDeliveryReceipts += 1;
    this.#wakeEntryWaiters(entry);
    return enqueueResult('enqueued', entry.revision, receipt);
  }

  async pollOutbound(
    input: HttpSubAgentJobPollOutboundInput,
    contextInput?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobPollOutboundResult> {
    this.#assertActive();
    const context = normalizeIoContext(contextInput);
    assertIoSignalActive(context);
    const normalized = normalizePollOutboundInput(input);
    this.#assertIoDeadline(context);

    let entry = this.#requireEntry(normalized.scope);
    assertAttachment(entry, normalized.channelId, normalized.channelGeneration);
    if (!pollRequiresMutation(entry, normalized.ackCursor)) return pollResult(entry);

    const now = this.#readMutationClock(context);
    entry = this.#requireEntry(normalized.scope);
    assertAttachment(entry, normalized.channelId, normalized.channelGeneration);
    if (!pollRequiresMutation(entry, normalized.ackCursor)) return pollResult(entry);
    const revision = incrementUint64(entry.revision);
    assertClockDidNotRegress(now, entry.updatedAt);

    if (normalized.ackCursor === entry.ackCursor) {
      const head = entry.outbound[0];
      if (head === undefined) {
        throw new Error('HTTP delivery offer mutation lost its outbound head.');
      }
      entry.offeredCursor = head.cursor;
    } else {
      const acknowledged = entry.outbound[0];
      if (acknowledged === undefined || acknowledged.cursor !== normalized.ackCursor) {
        throw new Error('HTTP delivery ACK mutation lost its offered packet.');
      }
      if (
        this.#outstandingDeliveries < 1 ||
        this.#deliveryRetainedBytes < acknowledged.retainedBytes
      ) {
        throw new Error('HTTP delivery Store diagnostics would underflow during ACK.');
      }
      if (entry.outbound.shift() !== acknowledged) {
        throw new Error('HTTP delivery ACK mutation changed its outbound head unexpectedly.');
      }
      zeroPacketSidecars(acknowledged.packet);
      this.#outstandingDeliveries -= 1;
      this.#deliveryRetainedBytes -= acknowledged.retainedBytes;
      entry.ackCursor = acknowledged.cursor;
      entry.offeredCursor = entry.outbound[0]?.cursor ?? null;
    }
    entry.revision = revision;
    entry.updatedAt = now;
    this.#wakeEntryWaiters(entry);
    return pollResult(entry);
  }

  async waitForOutbound(
    input: HttpSubAgentJobWaitForOutboundInput,
    contextInput?: HttpSubAgentJobStoreIoContext,
  ): Promise<HttpSubAgentJobWaitForOutboundResult> {
    this.#assertActive();
    const context = normalizeIoContext(contextInput);
    assertIoSignalActive(context);
    const normalized = normalizeWaitForOutboundInput(input);
    let entry = this.#requireEntry(normalized.scope);
    assertAttachment(entry, normalized.channelId, normalized.channelGeneration);
    if (entry.revision !== normalized.observedRevision) {
      this.#assertIoDeadline(context);
      return waitResult('changed', deliveryState(entry));
    }
    if (normalized.waitMs === 0) {
      this.#assertIoDeadline(context);
      entry = this.#requireEntry(normalized.scope);
      assertAttachment(entry, normalized.channelId, normalized.channelGeneration);
      return waitResult(
        entry.revision === normalized.observedRevision ? 'timed_out' : 'changed',
        deliveryState(entry),
      );
    }
    const observedAt = this.#readObservationClock(context);
    entry = this.#requireEntry(normalized.scope);
    assertAttachment(entry, normalized.channelId, normalized.channelGeneration);
    if (entry.revision !== normalized.observedRevision) {
      return waitResult('changed', deliveryState(entry));
    }
    if (this.#waiters.size >= this.#waiterCapacity) {
      throw new HttpSubAgentJobStoreError('capacity_exhausted');
    }

    return new Promise<HttpSubAgentJobWaitForOutboundResult>((resolve, reject) => {
      const waiter: MemoryHttpSubAgentWaiter = {
        entry,
        resolve,
        reject,
        settled: false,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      };
      entry.waiters.add(waiter);
      this.#waiters.add(waiter);

      const deadlineDelay =
        context.deadlineAt === undefined ? undefined : context.deadlineAt - observedAt;
      const deadlineWins = deadlineDelay !== undefined && deadlineDelay <= normalized.waitMs;
      const delay = deadlineWins ? deadlineDelay : normalized.waitMs;
      waiter.timer = setTimeout(() => {
        if (deadlineWins) {
          this.#rejectWaiter(waiter, new HttpSubAgentJobStoreError('deadline_exceeded'));
        } else {
          this.#resolveWaiter(waiter, 'timed_out');
        }
      }, delay);
      if (context.signal !== undefined) {
        const abortListener: EventListener = () => {
          this.#rejectWaiter(waiter, new HttpSubAgentJobStoreError('aborted'));
        };
        waiter.abortListener = abortListener;
        Reflect.apply(EVENT_TARGET_ADD_EVENT_LISTENER, context.signal, [
          'abort',
          abortListener,
          { once: true },
        ]);
        if (isAbortSignalAborted(context.signal)) {
          this.#rejectWaiter(waiter, new HttpSubAgentJobStoreError('aborted'));
        }
      }
    });
  }

  get diagnostics(): MemoryHttpSubAgentJobStoreDiagnostics {
    return Object.freeze({
      retainedJobs: this.#jobsByCreateKey.size,
      capacity: this.#capacity,
      retainedBytes: this.#retainedBytes,
      maxRetainedBytes: this.#maxRetainedBytes,
      outstandingDeliveries: this.#outstandingDeliveries,
      deliveryCapacity: this.#deliveryCapacity,
      deliveryRetainedBytes: this.#deliveryRetainedBytes,
      maxDeliveryRetainedBytes: this.#maxDeliveryRetainedBytes,
      retainedDeliveryReceipts: this.#retainedDeliveryReceipts,
      deliveryReceiptCapacity: this.#deliveryReceiptCapacity,
      activeWaiters: this.#waiters.size,
      waiterCapacity: this.#waiterCapacity,
      disposed: this.#disposed,
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const waiter of [...this.#waiters]) {
      this.#rejectWaiter(waiter, new HttpSubAgentJobStoreError('disposed'));
    }
    for (const entry of this.#jobsByPrincipalJobId.values()) {
      zeroPacketSidecars(entry.record.createPacket);
      for (const delivery of entry.outbound) zeroPacketSidecars(delivery.packet);
      entry.outbound.length = 0;
      entry.receiptsByMessage.clear();
      entry.receiptsBySequence.clear();
      entry.waiters.clear();
    }
    this.#jobsByCreateKey.clear();
    this.#jobsByPrincipalJobId.clear();
    this.#jobsByPrincipalOwnerTaskId.clear();
    this.#retainedBytes = 0;
    this.#outstandingDeliveries = 0;
    this.#deliveryRetainedBytes = 0;
    this.#retainedDeliveryReceipts = 0;
  }

  #findEntry(scope: HttpSubAgentJobScope): MemoryHttpSubAgentJobEntry | undefined {
    const entry = this.#jobsByPrincipalJobId.get(principalJobKey(scope));
    return entry === undefined || entry.record.ownerSessionId !== scope.ownerSessionId
      ? undefined
      : entry;
  }

  #requireEntry(scope: HttpSubAgentJobScope): MemoryHttpSubAgentJobEntry {
    const entry = this.#findEntry(scope);
    if (entry === undefined) throw new HttpSubAgentJobStoreError('resource_not_found');
    return entry;
  }

  #assertDeliveryCapacity(retainedBytes: number): void {
    if (
      this.#outstandingDeliveries >= this.#deliveryCapacity ||
      this.#retainedDeliveryReceipts >= this.#deliveryReceiptCapacity ||
      retainedBytes > this.#maxDeliveryRetainedBytes - this.#deliveryRetainedBytes
    ) {
      throw new HttpSubAgentJobStoreError('capacity_exhausted');
    }
  }

  #assertIoDeadline(context: NormalizedIoContext): void {
    assertIoSignalActive(context);
    if (context.deadlineAt === undefined) return;
    this.#readObservationClock(context);
  }

  #readObservationClock(context: NormalizedIoContext): number {
    assertIoSignalActive(context);
    const now = readClock(this.#now);
    this.#assertActive();
    assertIoSignalActive(context);
    if (this.#lastObservedAt !== undefined && now < this.#lastObservedAt) {
      throw new RangeError('Memory HTTP job Store clock must be monotonic.');
    }
    this.#lastObservedAt = now;
    if (context.deadlineAt !== undefined && now >= context.deadlineAt) {
      throw new HttpSubAgentJobStoreError('deadline_exceeded');
    }
    return now;
  }

  #readMutationClock(context: NormalizedIoContext): number {
    return this.#readObservationClock(context);
  }

  #wakeEntryWaiters(entry: MemoryHttpSubAgentJobEntry): void {
    for (const waiter of [...entry.waiters]) this.#resolveWaiter(waiter, 'changed');
  }

  #resolveWaiter(waiter: MemoryHttpSubAgentWaiter, status: 'changed' | 'timed_out'): void {
    if (waiter.settled) return;
    this.#releaseWaiter(waiter);
    waiter.resolve(waitResult(status, deliveryState(waiter.entry)));
  }

  #rejectWaiter(waiter: MemoryHttpSubAgentWaiter, error: HttpSubAgentJobStoreError): void {
    if (waiter.settled) return;
    this.#releaseWaiter(waiter);
    waiter.reject(error);
  }

  #releaseWaiter(waiter: MemoryHttpSubAgentWaiter): void {
    waiter.settled = true;
    waiter.entry.waiters.delete(waiter);
    this.#waiters.delete(waiter);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      Reflect.apply(EVENT_TARGET_REMOVE_EVENT_LISTENER, waiter.signal, [
        'abort',
        waiter.abortListener,
      ]);
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new HttpSubAgentJobStoreError('disposed');
  }
}

interface NormalizedIoContext {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

interface NormalizedEnqueueOutboundHeader {
  readonly scope: HttpSubAgentJobScope;
  readonly channelId: string;
  readonly channelGeneration: string;
  readonly packet: SubAgentTransportPeerPacket;
}

interface NormalizedOutboundPacket extends Omit<NormalizedEnqueueOutboundHeader, 'packet'> {
  readonly envelope: SubAgentTransportRpcEnvelope;
  readonly packet: SubAgentTransportPeerPacket;
  readonly packetReceipt: string;
  readonly retainedBytes: number;
}

interface NormalizedPollOutboundInput {
  readonly scope: HttpSubAgentJobScope;
  readonly channelId: string;
  readonly channelGeneration: string;
  readonly ackCursor: string;
}

interface NormalizedWaitForOutboundInput {
  readonly scope: HttpSubAgentJobScope;
  readonly channelId: string;
  readonly channelGeneration: string;
  readonly observedRevision: string;
  readonly waitMs: number;
}

interface OwnedOutboundPacket {
  readonly envelope: SubAgentTransportRpcEnvelope;
  readonly packet: SubAgentTransportPeerPacket;
  readonly packetReceipt: string;
  readonly retainedBytes: number;
}

interface NormalizedCreateInput {
  readonly principalId: string;
  readonly jobId: string;
  readonly identity: HttpSubAgentJobCreateIdentity;
}

function normalizeIoContext(input: HttpSubAgentJobStoreIoContext | undefined): NormalizedIoContext {
  if (input === undefined) return Object.freeze({});
  const record = requireAllowedDataRecord(
    input,
    IO_CONTEXT_KEYS,
    'HTTP Subagent job Store IO context',
  );
  let signal: AbortSignal | undefined;
  if (record.signal !== undefined) {
    if (nodeTypes.isProxy(record.signal)) {
      throw new TypeError('HTTP Subagent job Store IO signal must be an AbortSignal.');
    }
    try {
      Reflect.apply(ABORT_SIGNAL_ABORTED_GETTER, record.signal, []);
    } catch {
      throw new TypeError('HTTP Subagent job Store IO signal must be an AbortSignal.');
    }
    signal = record.signal as AbortSignal;
  }
  const deadlineAt =
    record.deadlineAt === undefined
      ? undefined
      : requireTimestamp(record.deadlineAt, 'HTTP Subagent job Store IO deadlineAt');
  return Object.freeze({
    ...(signal === undefined ? {} : { signal }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  });
}

function assertIoSignalActive(context: NormalizedIoContext): void {
  if (context.signal !== undefined && isAbortSignalAborted(context.signal)) {
    throw new HttpSubAgentJobStoreError('aborted');
  }
}

function isAbortSignalAborted(signal: AbortSignal): boolean {
  return Reflect.apply(ABORT_SIGNAL_ABORTED_GETTER, signal, []);
}

function normalizeEnqueueOutboundHeader(
  input: HttpSubAgentJobEnqueueOutboundInput,
): NormalizedEnqueueOutboundHeader {
  const record = requireClosedDataRecord(
    input,
    ENQUEUE_OUTBOUND_KEYS,
    'HTTP Subagent job enqueue outbound input',
  );
  const scope = normalizeScopeFields(record);
  const channelId = requireChannelId(record.channelId, 'HTTP job enqueue channelId');
  const channelGeneration = requireCanonicalUint64Decimal(
    record.channelGeneration,
    'HTTP job enqueue channelGeneration',
  );
  return Object.freeze({
    scope,
    channelId,
    channelGeneration,
    packet: record.packet as SubAgentTransportPeerPacket,
  });
}

function normalizePollOutboundInput(
  input: HttpSubAgentJobPollOutboundInput,
): NormalizedPollOutboundInput {
  const record = requireClosedDataRecord(
    input,
    POLL_OUTBOUND_KEYS,
    'HTTP Subagent job poll outbound input',
  );
  return Object.freeze({
    scope: normalizeScopeFields(record),
    channelId: requireChannelId(record.channelId, 'HTTP job poll channelId'),
    channelGeneration: requireCanonicalUint64Decimal(
      record.channelGeneration,
      'HTTP job poll channelGeneration',
    ),
    ackCursor: requireCanonicalUint64Decimal(record.ackCursor, 'HTTP job poll ackCursor'),
  });
}

function normalizeWaitForOutboundInput(
  input: HttpSubAgentJobWaitForOutboundInput,
): NormalizedWaitForOutboundInput {
  const record = requireClosedDataRecord(
    input,
    WAIT_FOR_OUTBOUND_KEYS,
    'HTTP Subagent job wait outbound input',
  );
  const waitMs = requireNonNegativeSafeInteger(record.waitMs, 'HTTP job wait waitMs');
  if (waitMs > HTTP_SUBAGENT_MAX_POLL_WAIT_MS) {
    throw new RangeError('HTTP job wait waitMs exceeds the protocol maximum.');
  }
  return Object.freeze({
    scope: normalizeScopeFields(record),
    channelId: requireChannelId(record.channelId, 'HTTP job wait channelId'),
    channelGeneration: requireCanonicalUint64Decimal(
      record.channelGeneration,
      'HTTP job wait channelGeneration',
    ),
    observedRevision: requireCanonicalUint64Decimal(
      record.observedRevision,
      'HTTP job wait observedRevision',
    ),
    waitMs,
  });
}

function normalizeScopeFields(record: Record<string, unknown>): HttpSubAgentJobScope {
  return Object.freeze({
    principalId: requireBoundedIdentifier(record.principalId, 'HTTP job principalId'),
    ownerSessionId: requireBoundedIdentifier(record.ownerSessionId, 'HTTP job ownerSessionId'),
    jobId: requireOpaqueJobId(record.jobId, 'HTTP job jobId'),
  });
}

function ownOutboundPacket(value: unknown, expectedChannelId: string): OwnedOutboundPacket {
  const record = requireClosedDataRecord(value, PEER_PACKET_KEYS, 'HTTP outbound Peer packet');
  const frame = ownOutboundFrame(record.frame);
  const envelope = decodeSubAgentTransportRpcFrame(frame, {
    maxFrameBytes: DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  });
  assertOutboundRpcKind(envelope);
  if (envelope.channelId !== expectedChannelId) {
    throw new HttpSubAgentJobStoreError('attachment_fenced');
  }
  const canonicalFrame = encodeSubAgentTransportRpcFrame(envelope, {
    maxFrameBytes: DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  });
  const sidecars = ownOutboundSidecars(record.sidecars);
  const packet = Object.freeze({
    frame: canonicalFrame,
    sidecars,
  }) satisfies SubAgentTransportPeerPacket;
  const descriptors = [...sidecars.map((sidecar) => sidecar.descriptor)].sort(
    compareDeliverySidecarDescriptors,
  );
  const packetReceipt = canonicalJsonSha256({
    version: HTTP_SUBAGENT_JOB_DELIVERY_VERSION,
    rpc: envelope,
    sidecarDescriptorsSortedBySidecarId: descriptors,
  } as unknown as JsonValue);
  return Object.freeze({
    envelope,
    packet,
    packetReceipt,
    retainedBytes: packetRetainedBytes(packet),
  });
}

function ownOutboundFrame(value: unknown): string | Uint8Array {
  if (typeof value === 'string') return value;
  if (nodeTypes.isProxy(value) || !nodeTypes.isUint8Array(value)) {
    throw new TypeError('HTTP outbound Peer packet frame must be a string or Uint8Array.');
  }
  return copyHttpBytes(
    value,
    'HTTP outbound Peer packet frame',
    DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  );
}

function ownOutboundSidecars(value: unknown): readonly SubAgentTransportArtifactSidecar[] {
  const candidates = requireDenseDataArray(value, 'HTTP outbound Peer packet sidecars');
  if (candidates.length > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS) {
    throw new RangeError('HTTP outbound Peer packet exceeds the default sidecar count.');
  }
  const sidecars: SubAgentTransportArtifactSidecar[] = [];
  const sidecarIds = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = requireClosedDataRecord(
      candidates[index],
      SIDECAR_KEYS,
      `HTTP outbound Peer packet sidecar ${index}`,
    );
    const sidecar = decodeSubAgentTransportArtifactSidecar(
      candidate.descriptor,
      candidate.data as Uint8Array | ArrayBuffer,
      { maxBytes: DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES },
    );
    if (sidecarIds.has(sidecar.descriptor.sidecarId)) {
      throw new TypeError('HTTP outbound Peer packet contains duplicate sidecar IDs.');
    }
    if (sidecar.data.byteLength > DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES - totalBytes) {
      throw new RangeError('HTTP outbound Peer packet exceeds the aggregate sidecar limit.');
    }
    sidecarIds.add(sidecar.descriptor.sidecarId);
    totalBytes += sidecar.data.byteLength;
    sidecars.push(sidecar);
  }
  return Object.freeze(sidecars);
}

function compareDeliverySidecarDescriptors(
  left: SubAgentTransportArtifactSidecarDescriptor,
  right: SubAgentTransportArtifactSidecarDescriptor,
): number {
  return left.sidecarId < right.sidecarId ? -1 : left.sidecarId > right.sidecarId ? 1 : 0;
}

function assertOutboundRpcKind(envelope: SubAgentTransportRpcEnvelope): void {
  switch (envelope.kind) {
    case 'executor.accepted':
    case 'executor.settled':
    case 'cancel.ack':
    case 'snapshot.reply':
    case 'events.page':
    case 'control.request':
    case 'model.request':
    case 'events.request':
    case 'protocol.error':
      return;
    default:
      throw new TypeError('HTTP outbound Peer packet RPC kind is not target-to-controller.');
  }
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

function assertAttachment(
  entry: MemoryHttpSubAgentJobEntry,
  channelId: string,
  channelGeneration: string,
): void {
  if (
    channelId !== entry.record.channelId ||
    channelGeneration !== HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION
  ) {
    throw new HttpSubAgentJobStoreError('attachment_fenced');
  }
}

function findDeliveryReplay(
  entry: MemoryHttpSubAgentJobEntry,
  candidate: NormalizedOutboundPacket,
): MemoryHttpSubAgentDeliveryReceipt | undefined {
  const lookup = {
    channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
    messageId: candidate.envelope.messageId,
    sequence: candidate.envelope.sequence,
  };
  const byMessage = entry.receiptsByMessage.get(deliveryMessageKey(lookup));
  const bySequence = entry.receiptsBySequence.get(deliverySequenceKey(lookup));
  if (byMessage === undefined && bySequence === undefined) return undefined;
  if (
    byMessage === undefined ||
    bySequence === undefined ||
    byMessage !== bySequence ||
    byMessage.messageId !== candidate.envelope.messageId ||
    byMessage.sequence !== candidate.envelope.sequence ||
    byMessage.packetReceipt !== candidate.packetReceipt
  ) {
    throw new HttpSubAgentJobStoreError('idempotency_conflict');
  }
  return byMessage;
}

function deliveryMessageKey(input: {
  readonly channelGeneration: string;
  readonly messageId: string;
}): string {
  return canonicalizeJson({
    channelGeneration: input.channelGeneration,
    messageId: input.messageId,
  });
}

function deliverySequenceKey(input: {
  readonly channelGeneration: string;
  readonly sequence: number;
}): string {
  return canonicalizeJson({
    channelGeneration: input.channelGeneration,
    sequence: input.sequence,
  });
}

function assertNextPeerSequence(entry: MemoryHttpSubAgentJobEntry, sequence: number): void {
  if (entry.lastPeerSequence === Number.MAX_SAFE_INTEGER) {
    throw new HttpSubAgentJobStoreError('counter_exhausted');
  }
  if (sequence !== entry.lastPeerSequence + 1) {
    throw new HttpSubAgentJobStoreError('idempotency_conflict');
  }
}

function pollRequiresMutation(entry: MemoryHttpSubAgentJobEntry, ackCursor: string): boolean {
  if (entry.offeredCursor !== null && entry.outbound[0]?.cursor !== entry.offeredCursor) {
    throw new Error('HTTP delivery Store offered cursor is inconsistent with its queue.');
  }
  if (ackCursor === entry.ackCursor) {
    return entry.offeredCursor === null && entry.outbound.length > 0;
  }
  if (entry.offeredCursor !== null && ackCursor === entry.offeredCursor) return true;
  throw new HttpSubAgentJobStoreError('cursor_conflict');
}

function deliveryState(entry: MemoryHttpSubAgentJobEntry): HttpSubAgentJobDeliveryStateV1 {
  return normalizeHttpSubAgentJobDeliveryState({
    deliveryVersion: HTTP_SUBAGENT_JOB_DELIVERY_VERSION,
    revision: entry.revision,
    channelId: entry.record.channelId,
    channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
    ackCursor: entry.ackCursor,
    offeredCursor: entry.offeredCursor,
    outstandingDeliveries: entry.outbound.length,
    updatedAt: entry.updatedAt,
  });
}

function pollResult(entry: MemoryHttpSubAgentJobEntry): HttpSubAgentJobPollOutboundResult {
  let delivery: HttpSubAgentJobOutboundDeliveryV1 | null = null;
  if (entry.offeredCursor !== null) {
    const offered = entry.outbound[0];
    if (offered === undefined || offered.cursor !== entry.offeredCursor) {
      throw new Error('HTTP delivery Store offered packet is inconsistent with its queue.');
    }
    delivery = Object.freeze({
      cursor: offered.cursor,
      packetReceipt: offered.packetReceipt,
      packet: cloneOutboundPacket(offered.packet),
    });
  }
  return Object.freeze({
    deliveryVersion: HTTP_SUBAGENT_JOB_DELIVERY_VERSION,
    revision: entry.revision,
    channelId: entry.record.channelId,
    channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
    ackCursor: entry.ackCursor,
    delivery,
  });
}

function cloneOutboundPacket(packet: SubAgentTransportPeerPacket): SubAgentTransportPeerPacket {
  const sidecars: SubAgentTransportArtifactSidecar[] = [];
  for (const sidecar of packet.sidecars) {
    sidecars.push(
      Object.freeze({
        descriptor: sidecar.descriptor,
        data: copyHttpBytes(
          sidecar.data,
          'retained HTTP outbound sidecar',
          DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
        ),
      }),
    );
  }
  return Object.freeze({
    frame:
      typeof packet.frame === 'string'
        ? packet.frame
        : copyHttpBytes(
            packet.frame,
            'retained HTTP outbound frame',
            DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
          ),
    sidecars: Object.freeze(sidecars),
  });
}

function enqueueResult(
  status: 'enqueued' | 'replayed',
  revision: string,
  receipt: MemoryHttpSubAgentDeliveryReceipt,
): HttpSubAgentJobEnqueueOutboundResult {
  return Object.freeze({
    status,
    revision,
    cursor: receipt.cursor,
    messageId: receipt.messageId,
    packetReceipt: receipt.packetReceipt,
  });
}

function waitResult(
  status: 'changed' | 'timed_out',
  state: HttpSubAgentJobDeliveryStateV1,
): HttpSubAgentJobWaitForOutboundResult {
  return Object.freeze({ status, state });
}

function zeroPacketSidecars(packet: SubAgentTransportPeerPacket): void {
  for (const sidecar of packet.sidecars) {
    Reflect.apply(UINT8_ARRAY_FILL, sidecar.data, [0]);
  }
}

function assertClockDidNotRegress(now: number, previous: number): void {
  if (now < previous) throw new RangeError('Memory HTTP job Store clock must not move backwards.');
}

function incrementUint64(value: string): string {
  const parsed = BigInt(value);
  if (parsed === UINT64_MAX) throw new HttpSubAgentJobStoreError('counter_exhausted');
  return String(parsed + 1n);
}

function compareCanonicalUint64(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
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
    channelId: requireChannelId(routed.envelope.channelId, 'HTTP job create channelId'),
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

function requireChannelId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CHANNEL_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical HTTP channel identifier.`);
  }
  return value;
}

function requireCanonicalUint64Decimal(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !UINT64_DECIMAL_PATTERN.test(value) ||
    (value.length === UINT64_MAX_DECIMAL.length && value > UINT64_MAX_DECIMAL)
  ) {
    throw new TypeError(`${label} must be a canonical uint64 decimal string.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
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
    case 'resource_not_found':
      return 'The HTTP Subagent job resource was not found.';
    case 'idempotency_conflict':
      return 'The HTTP Subagent job operation conflicts with retained state.';
    case 'attachment_fenced':
      return 'The HTTP Subagent job attachment is fenced.';
    case 'cursor_conflict':
      return 'The HTTP Subagent job delivery cursor conflicts with retained state.';
    case 'capacity_exhausted':
      return 'The Memory HTTP Subagent job Store capacity is exhausted.';
    case 'counter_exhausted':
      return 'The HTTP Subagent job Store counter is exhausted.';
    case 'aborted':
      return 'The HTTP Subagent job Store operation was aborted.';
    case 'deadline_exceeded':
      return 'The HTTP Subagent job Store operation deadline was exceeded.';
    case 'disposed':
      return 'The HTTP Subagent job Store is disposed.';
  }
}
