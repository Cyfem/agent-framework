import { randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import { DEFAULT_ARTIFACT_LIMITS } from './artifact';
import { SUBAGENT_ERROR_CODES, type SubAgentErrorDescriptor } from './errors';
import {
  createSubAgentTransportRpcEnvelope,
  decodeSubAgentTransportRpcFrame,
  encodeSubAgentTransportRpcFrame,
} from './transport-rpc-codec';
import {
  type SubAgentTransportRpcEnvelope,
  type SubAgentTransportRpcPayloadMap,
  type SubAgentTransportRpcProtocolErrorEnvelope,
  type SubAgentTransportRpcReplyKind,
  type SubAgentTransportRpcRequestKind,
  type SubAgentTransportRpcValidationOptions,
  type SubAgentTransportSafeError,
} from './transport-rpc';
import {
  decodeSubAgentTransportArtifactSidecar,
  type SubAgentTransportArtifactSidecar,
} from './transport-sidecar';
import {
  DEFAULT_SUBAGENT_TRANSPORT_SEQUENCE_WINDOW,
  SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES,
  SUBAGENT_TRANSPORT_MAX_SEQUENCE_WINDOW,
} from './transport';

const textEncoder = new TextEncoder();
const REQUEST_KINDS = new Set<SubAgentTransportRpcRequestKind>([
  'executor.request',
  'control.request',
  'cancel.request',
  'snapshot.request',
  'events.request',
  'model.request',
]);
const ACTIVE_TASK_CONTINUATION_KINDS = new Set<SubAgentTransportRpcRequestKind>([
  'control.request',
  'cancel.request',
  'snapshot.request',
  'events.request',
  'model.request',
]);
const SAFE_ERROR_CODES = new Set<string>(SUBAGENT_ERROR_CODES);
const SAFE_ERROR_KEYS = new Set(['code', 'message', 'retryable', 'causeCode', 'outcomeUnknown']);

export const DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_PENDING = 256;
export const DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_TOMBSTONES = 256;
export const DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_CACHED_REQUESTS = 1_024;
/** Accommodates one maximum default frame plus one maximum default sidecar packet and receipts. */
export const DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_CACHED_BYTES = 160 * 1024 * 1024;
/** Maximum aggregate sidecar bytes in one packet. */
export const DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES =
  DEFAULT_ARTIFACT_LIMITS.maxTotalBytesPerTask;
/** Maximum bytes in one sidecar item. */
export const DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES =
  DEFAULT_ARTIFACT_LIMITS.maxItemBytes;
export const DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS = DEFAULT_ARTIFACT_LIMITS.maxItemsPerTask;
export const DEFAULT_SUBAGENT_TRANSPORT_PEER_SETTLEMENT_SEQUENCE_HEADROOM = 256;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export type SubAgentTransportPeerState = 'open' | 'draining' | 'closed';

export type SubAgentTransportPeerErrorReason =
  | 'closed'
  | 'draining'
  | 'rollover-required'
  | 'pending-limit-exceeded'
  | 'cache-limit-exceeded'
  | 'sidecar-limit-exceeded'
  | 'protocol-violation'
  | 'writer-failed'
  | 'aborted'
  | 'timed-out';

const CLOSED_ERROR = Object.freeze({
  code: 'INTERNAL_ERROR',
  message: 'The transport channel is closed.',
  retryable: true,
  causeCode: 'TRANSPORT_CHANNEL_CLOSED',
}) satisfies SubAgentTransportSafeError;
const ROLLOVER_ERROR = Object.freeze({
  code: 'INTERNAL_ERROR',
  message: 'The transport channel must be rolled over before sending more messages.',
  retryable: true,
  causeCode: 'TRANSPORT_ROLLOVER_REQUIRED',
}) satisfies SubAgentTransportSafeError;
const PROTOCOL_ERROR = Object.freeze({
  code: 'INTERNAL_ERROR',
  message: 'The transport channel was closed because its protocol contract was violated.',
  retryable: false,
  causeCode: 'TRANSPORT_PROTOCOL_VIOLATION',
}) satisfies SubAgentTransportSafeError;
const WRITER_ERROR = Object.freeze({
  code: 'INTERNAL_ERROR',
  message: 'The transport channel writer failed.',
  retryable: true,
  causeCode: 'TRANSPORT_WRITER_FAILED',
  outcomeUnknown: true,
}) satisfies SubAgentTransportSafeError;
const HANDLER_ERROR = Object.freeze({
  code: 'INTERNAL_ERROR',
  message: 'The remote transport handler could not complete the request.',
  retryable: false,
  causeCode: 'REMOTE_HANDLER_FAILED',
}) satisfies SubAgentTransportSafeError;
const ABORTED_ERROR = Object.freeze({
  code: 'CANCELLED',
  message: 'The transport request was aborted.',
  retryable: false,
  causeCode: 'TRANSPORT_REQUEST_ABORTED',
}) satisfies SubAgentTransportSafeError;
const TIMED_OUT_ERROR = Object.freeze({
  code: 'TIMED_OUT',
  message: 'The transport request timed out.',
  retryable: true,
  causeCode: 'TRANSPORT_REQUEST_TIMED_OUT',
  outcomeUnknown: true,
}) satisfies SubAgentTransportSafeError;

/** Local failure carrying only the descriptor that is safe to surface across a placement boundary. */
export class SubAgentTransportPeerError extends Error {
  readonly code = 'SUBAGENT_TRANSPORT_PEER_ERROR';
  readonly reason: SubAgentTransportPeerErrorReason;
  readonly descriptor: Readonly<SubAgentTransportSafeError>;

  constructor(reason: SubAgentTransportPeerErrorReason, descriptor: SubAgentTransportSafeError) {
    const safeDescriptor = cloneSafeError(descriptor, CLOSED_ERROR);
    super(safeDescriptor.message);
    this.name = 'SubAgentTransportPeerError';
    this.reason = reason;
    this.descriptor = safeDescriptor;
  }
}

/** One transport write: the semantic JSON frame plus validated, out-of-band artifact bytes. */
export interface SubAgentTransportPeerPacket {
  readonly frame: string | Uint8Array;
  readonly sidecars: readonly SubAgentTransportArtifactSidecar[];
}

/**
 * Synchronous proof that a writer admitted a packet into its ordered outbound queue. `settled`
 * reports later I/O completion only; it must never be awaited before admitting the next packet.
 */
export interface SubAgentTransportPeerWriterAdmission {
  readonly admitted: true;
  readonly settled?: PromiseLike<void>;
}

export type SubAgentTransportPeerWriter = (
  packet: SubAgentTransportPeerPacket,
) => SubAgentTransportPeerWriterAdmission;

/** Creates the only supported writer receipt shape. */
export function createSubAgentTransportPeerWriterAdmission(
  settled?: PromiseLike<void>,
): SubAgentTransportPeerWriterAdmission {
  if (settled !== undefined && !isPromiseLike(settled)) {
    throw new TypeError('Subagent transport writer settled receipt must be Promise-like.');
  }
  return Object.freeze({ admitted: true, ...(settled === undefined ? {} : { settled }) });
}

type RpcRequestEnvelope = Extract<
  SubAgentTransportRpcEnvelope,
  { readonly kind: SubAgentTransportRpcRequestKind }
>;
type RpcResponseEnvelope =
  | Extract<SubAgentTransportRpcEnvelope, { readonly kind: SubAgentTransportRpcReplyKind }>
  | SubAgentTransportRpcProtocolErrorEnvelope;
type RpcResponseKind = RpcResponseEnvelope['kind'];

type RequestInputByKind = {
  [K in SubAgentTransportRpcRequestKind]: {
    readonly kind: K;
    readonly taskId: string;
    readonly operationId: string;
    readonly payload: SubAgentTransportRpcPayloadMap[K];
    readonly sidecars?: readonly SubAgentTransportArtifactSidecar[];
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  };
};

/** A locally-originated request. Channel, sequence and message identity are peer-owned. */
export type SubAgentTransportPeerRequest = RequestInputByKind[SubAgentTransportRpcRequestKind];

type ReplyInputByKind = {
  [K in RpcResponseKind]: {
    readonly kind: K;
    readonly payload: SubAgentTransportRpcPayloadMap[K];
    readonly sidecars?: readonly SubAgentTransportArtifactSidecar[];
  };
};

/** A handler reply. Correlation and task/operation identity are copied from the request. */
export type SubAgentTransportPeerReply = ReplyInputByKind[RpcResponseKind];

export interface SubAgentTransportPeerResponse {
  readonly envelope: RpcResponseEnvelope;
  readonly sidecars: readonly SubAgentTransportArtifactSidecar[];
}

export interface SubAgentTransportPeerHandlerRequest {
  readonly envelope: RpcRequestEnvelope;
  readonly sidecars: readonly SubAgentTransportArtifactSidecar[];
  readonly receivedAt: number;
  reply(reply: SubAgentTransportPeerReply): Promise<void>;
}

export type SubAgentTransportPeerRequestHandler = (
  request: SubAgentTransportPeerHandlerRequest,
) => void | Promise<void>;

/**
 * Method-specific association hook. It must return the complete expected sidecar-ID set. The
 * default returns an empty set, so an RPC without an explicit schema can never smuggle bytes.
 */
export type SubAgentTransportPeerSidecarValidator = (
  envelope: SubAgentTransportRpcEnvelope,
  sidecars: readonly SubAgentTransportArtifactSidecar[],
) => readonly string[];

export interface SubAgentTransportPeerMessageIdContext {
  readonly channelId: string;
  readonly sequence: number;
  readonly kind: SubAgentTransportRpcEnvelope['kind'];
}

export interface SubAgentTransportPeerTimerApi {
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface SubAgentTransportPeerOptions {
  readonly channelId: string;
  readonly writer: SubAgentTransportPeerWriter;
  readonly handler?: SubAgentTransportPeerRequestHandler;
  readonly validateSidecars?: SubAgentTransportPeerSidecarValidator;
  readonly createMessageId?: (context: SubAgentTransportPeerMessageIdContext) => string;
  readonly now?: () => number;
  readonly timers?: SubAgentTransportPeerTimerApi;
  readonly maxPending?: number;
  /** Maximum admitted aborted/timed-out exchanges retained for safe late-reply correlation. */
  readonly maxTombstones?: number;
  readonly maxCachedRequests?: number;
  /** Includes exact inbound replay packets and cached outbound handler replies. */
  readonly maxCachedBytes?: number;
  /** Maximum sum of artifact bytes in one packet. Defaults to 128 MiB. */
  readonly maxSidecarBytes?: number;
  /** Maximum bytes in one artifact sidecar. Defaults to 32 MiB. */
  readonly maxSidecarItemBytes?: number;
  /** Maximum sidecar count in one packet. Defaults to the per-task artifact limit (8). */
  readonly maxSidecars?: number;
  readonly maxTrackedSequences?: number;
  /**
   * Sequences reserved after soft drain for replies and active-task continuations. Defaults to 256
   * and is capped to maxTrackedSequences - 1. Set zero to disable the soft reserve.
   */
  readonly settlementSequenceHeadroom?: number;
  readonly rpc?: SubAgentTransportRpcValidationOptions;
}

export interface SubAgentTransportPeerExchange extends AsyncIterableIterator<SubAgentTransportPeerResponse> {
  readonly messageId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly requestKind: SubAgentTransportRpcRequestKind;
  readonly openedAt: number;
  abort(): void;
}

type ExchangeStage = 'initial' | 'accepted' | 'terminal';

interface ExchangeProtocolState {
  readonly requestKind: SubAgentTransportRpcRequestKind;
  readonly requestMode?: 'execute' | 'spawn' | 'snapshot' | 'wait';
  readonly controlMethod?: SubAgentTransportRpcPayloadMap['control.request']['method'];
  readonly executor?: ExecutorExchangeCorrelation;
  readonly events?: EventsExchangeCorrelation;
  readonly model?: ModelExchangeCorrelation;
  stage: ExchangeStage;
}

interface ExecutorBindingCorrelation {
  readonly version: '1';
  readonly executorName: string;
  readonly ownerSessionId: string;
  readonly taskId: string;
  readonly subagentSessionId: string;
  readonly definitionName: string;
  readonly definitionVersion: string;
  readonly runnerId: string;
  readonly runnerVersion: string;
}

interface ExecutorExchangeCorrelation {
  readonly ownerSessionId: string;
  readonly taskId: string;
  readonly subagentSessionId: string;
  readonly definitionName: string;
  readonly definitionVersion: string;
  readonly operationBinding?: ExecutorBindingCorrelation;
  acceptedBinding?: ExecutorBindingCorrelation;
}

interface EventsExchangeCorrelation {
  readonly afterSequence: number;
  readonly limit: number;
}

interface ModelExchangeCorrelation {
  readonly providerOperationId: string;
  readonly gatewayId: string;
  readonly protocol: string;
  readonly codecVersion: string;
  readonly runId: string;
  readonly executionAttempt: number;
  readonly executionEpoch: string;
  readonly executionFencingToken: string;
  readonly checkpointOperationId: string;
  readonly checkpointDigest: string;
  readonly requestHash: string;
}

interface ExchangeWaiter {
  readonly resolve: (result: IteratorResult<SubAgentTransportPeerResponse>) => void;
  readonly reject: (error: SubAgentTransportPeerError) => void;
}

interface PendingExchangeRecord {
  readonly messageId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly openedAt: number;
  readonly protocol: ExchangeProtocolState;
  readonly queue: SubAgentTransportPeerResponse[];
  readonly waiters: ExchangeWaiter[];
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: unknown;
  terminal: boolean;
  admitted: boolean;
  executorTaskActive: boolean;
  failure?: SubAgentTransportPeerError;
}

interface AbortedExchangeTombstone {
  readonly taskId: string;
  readonly operationId: string;
  readonly protocol: ExchangeProtocolState;
  executorTaskActive: boolean;
}

interface NormalizedPacket {
  readonly frameBytes: Uint8Array;
  readonly envelope: SubAgentTransportRpcEnvelope;
  readonly sidecars: readonly SubAgentTransportArtifactSidecar[];
  readonly cacheBytes: number;
}

interface OutgoingPacket {
  readonly frame: string;
  readonly sidecars: readonly SubAgentTransportArtifactSidecar[];
  readonly cacheBytes: number;
}

interface InboundPacketRecord {
  readonly packet: NormalizedPacket;
  readonly isRequest: boolean;
  request?: InboundRequestRecord;
}

interface InboundRequestRecord {
  readonly envelope: RpcRequestEnvelope;
  readonly sidecars: readonly SubAgentTransportArtifactSidecar[];
  readonly protocol: ExchangeProtocolState;
  readonly replies: OutgoingPacket[];
  readonly writes: Promise<void>[];
  processing: Promise<void>;
  completed: boolean;
  executorTaskActive: boolean;
}

class CapacityError extends Error {
  readonly capacity: 'cache' | 'sidecar';

  constructor(capacity: 'cache' | 'sidecar') {
    super(capacity);
    this.capacity = capacity;
  }
}

/**
 * Placement-neutral, bidirectional RPC peer. Admission is synchronous and handlers run outside
 * admission, allowing a request handler to open reverse control exchanges without deadlocking.
 */
export class SubAgentTransportPeer {
  readonly channelId: string;

  readonly #writer: SubAgentTransportPeerWriter;
  readonly #handler: SubAgentTransportPeerRequestHandler | undefined;
  readonly #validateSidecars: SubAgentTransportPeerSidecarValidator;
  readonly #createMessageId: (context: SubAgentTransportPeerMessageIdContext) => string;
  readonly #now: () => number;
  readonly #timers: SubAgentTransportPeerTimerApi;
  readonly #maxPending: number;
  readonly #maxTombstones: number;
  readonly #maxCachedRequests: number;
  readonly #maxCachedBytes: number;
  readonly #maxSidecarBytes: number;
  readonly #maxSidecarItemBytes: number;
  readonly #maxSidecars: number;
  readonly #maxTrackedSequences: number;
  readonly #settlementSequenceHeadroom: number;
  readonly #rpc: SubAgentTransportRpcValidationOptions;

  #state: SubAgentTransportPeerState = 'open';
  #nextInboundSequence = 1;
  #nextOutboundSequence = 1;
  #cachedBytes = 0;
  #cachedRequests = 0;
  readonly #inbound = new Map<number, InboundPacketRecord>();
  readonly #inboundMessageIds = new Map<string, number>();
  readonly #outboundMessageIds = new Set<string>();
  readonly #pending = new Map<string, PendingExchangeRecord>();
  readonly #tombstones = new Map<string, AbortedExchangeTombstone>();
  readonly #activeExecutorTasks = new Map<string, number>();

  constructor(options: SubAgentTransportPeerOptions) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new TypeError('Subagent transport peer options must be an object.');
    }
    assertIdentifier(options.channelId, 'channelId');
    if (typeof options.writer !== 'function') {
      throw new TypeError('Subagent transport peer writer must be a function.');
    }
    if (options.handler !== undefined && typeof options.handler !== 'function') {
      throw new TypeError('Subagent transport peer handler must be a function.');
    }
    if (options.validateSidecars !== undefined && typeof options.validateSidecars !== 'function') {
      throw new TypeError('Subagent transport peer sidecar validator must be a function.');
    }
    if (options.createMessageId !== undefined && typeof options.createMessageId !== 'function') {
      throw new TypeError('Subagent transport peer message-ID factory must be a function.');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('Subagent transport peer clock must be a function.');
    }

    this.channelId = options.channelId;
    this.#writer = options.writer;
    this.#handler = options.handler;
    this.#validateSidecars = options.validateSidecars ?? (() => []);
    this.#createMessageId = options.createMessageId ?? (() => randomUUID());
    this.#now = options.now ?? Date.now;
    this.#timers = resolveTimers(options.timers);
    this.#maxPending = positiveLimit(
      options.maxPending,
      DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_PENDING,
      'maxPending',
    );
    this.#maxTombstones = positiveLimit(
      options.maxTombstones,
      DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_TOMBSTONES,
      'maxTombstones',
    );
    this.#maxCachedRequests = positiveLimit(
      options.maxCachedRequests,
      DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_CACHED_REQUESTS,
      'maxCachedRequests',
    );
    this.#maxCachedBytes = positiveLimit(
      options.maxCachedBytes,
      DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_CACHED_BYTES,
      'maxCachedBytes',
    );
    this.#maxSidecarBytes = positiveLimit(
      options.maxSidecarBytes,
      DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES,
      'maxSidecarBytes',
    );
    this.#maxSidecarItemBytes = positiveLimit(
      options.maxSidecarItemBytes,
      DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
      'maxSidecarItemBytes',
    );
    this.#maxSidecars = positiveLimit(
      options.maxSidecars,
      DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
      'maxSidecars',
    );
    this.#maxTrackedSequences = trackedSequenceLimit(options.maxTrackedSequences);
    this.#settlementSequenceHeadroom = settlementSequenceHeadroom(
      options.settlementSequenceHeadroom,
      this.#maxTrackedSequences,
    );
    this.#rpc = Object.freeze({ ...(options.rpc ?? {}) });
  }

  get state(): SubAgentTransportPeerState {
    return this.#state;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get tombstoneCount(): number {
    return this.#tombstones.size;
  }

  get cachedRequestCount(): number {
    return this.#cachedRequests;
  }

  /**
   * Refuses new executor work while allowing active-task continuations, replies and exact replays
   * to consume the settlement reserve.
   */
  beginDrain(): void {
    if (this.#state === 'open') this.#state = 'draining';
  }

  /** Alias useful to placement adapters that expose a drain lifecycle hook. */
  drain(): void {
    this.beginDrain();
  }

  /** Idempotently closes the channel and rejects every pending exchange with one safe descriptor. */
  close(descriptor: SubAgentTransportSafeError = CLOSED_ERROR): void {
    this.#closeInternal(new SubAgentTransportPeerError('closed', descriptor));
  }

  /**
   * Opens an exchange and synchronously admits its packet through the writer. Later I/O completion
   * belongs in the admission receipt's `settled` promise and never serializes subsequent admission.
   */
  openRequest(request: SubAgentTransportPeerRequest): SubAgentTransportPeerExchange {
    if (this.#state === 'closed') throw peerError('closed', CLOSED_ERROR);
    if (
      this.#state === 'draining' &&
      !this.#isActiveTaskContinuation(request.kind, request.taskId)
    ) {
      throw peerError('draining', ROLLOVER_ERROR);
    }
    if (this.#pending.size >= this.#maxPending) {
      this.beginDrain();
      throw peerError('pending-limit-exceeded', ROLLOVER_ERROR);
    }
    if (request.signal?.aborted === true) throw peerError('aborted', ABORTED_ERROR);
    if (
      request.timeoutMs !== undefined &&
      (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0)
    ) {
      throw new RangeError(
        'Subagent transport peer timeoutMs must be a non-negative safe integer.',
      );
    }

    let openedAt: number;
    try {
      openedAt = readNow(this.#now);
    } catch {
      throw peerError('protocol-violation', PROTOCOL_ERROR);
    }
    if (request.timeoutMs !== undefined && openedAt > Number.MAX_SAFE_INTEGER - request.timeoutMs) {
      throw new RangeError('Subagent transport peer timeout deadline exceeds safe integer range.');
    }

    let prepared: {
      readonly envelope: RpcRequestEnvelope;
      readonly packet: OutgoingPacket;
    };
    try {
      prepared = this.#prepareRequestPacket(request);
    } catch (error) {
      if (error instanceof CapacityError && error.capacity === 'sidecar') {
        this.beginDrain();
        throw peerError('sidecar-limit-exceeded', ROLLOVER_ERROR);
      }
      throw peerError('protocol-violation', PROTOCOL_ERROR);
    }

    const record: PendingExchangeRecord = {
      messageId: prepared.envelope.messageId,
      taskId: request.taskId,
      operationId: request.operationId,
      openedAt,
      protocol: createExchangeProtocol(prepared.envelope),
      queue: [],
      waiters: [],
      terminal: false,
      admitted: false,
      executorTaskActive: prepared.envelope.kind === 'executor.request',
    };
    this.#pending.set(record.messageId, record);
    if (record.executorTaskActive) this.#activateExecutorTask(record.taskId);
    try {
      this.#armExchange(record, request.signal, request.timeoutMs);
    } catch {
      if (record.failure !== undefined) throw record.failure;
      throw this.#failClose('protocol-violation', PROTOCOL_ERROR);
    }

    // User callbacks involved in message preparation or signal registration may abort after the
    // initial preflight check. Such a request was never admitted, so it must not reach the writer.
    if (record.failure !== undefined) throw record.failure;

    record.admitted = true;
    this.#commitOutbound(prepared.envelope.messageId);
    const write = this.#writePacket(prepared.packet);
    void write.catch(() => undefined);
    return this.#createExchange(record);
  }

  /** Short alias for adapters that model their writer as a request primitive. */
  request(request: SubAgentTransportPeerRequest): SubAgentTransportPeerExchange {
    return this.openRequest(request);
  }

  /** Validates, admits and dispatches one packet. No Executor/Core callback runs before validation. */
  async receive(packet: SubAgentTransportPeerPacket): Promise<void> {
    if (this.#state === 'closed') throw peerError('closed', CLOSED_ERROR);

    let normalized: NormalizedPacket;
    try {
      normalized = this.#normalizeIncomingPacket(packet);
    } catch (error) {
      if (error instanceof CapacityError && error.capacity === 'sidecar') {
        throw this.#failClose('sidecar-limit-exceeded', ROLLOVER_ERROR);
      }
      throw this.#failClose('protocol-violation', PROTOCOL_ERROR);
    }
    const envelope = normalized.envelope;
    if (envelope.channelId !== this.channelId) {
      throw this.#failClose('protocol-violation', PROTOCOL_ERROR);
    }

    if (envelope.sequence < this.#nextInboundSequence) {
      const previous = this.#inbound.get(envelope.sequence);
      if (previous === undefined || !sameNormalizedPacket(previous.packet, normalized)) {
        throw this.#failClose('protocol-violation', PROTOCOL_ERROR);
      }
      if (previous.isRequest) {
        const requestRecord = previous.request;
        if (requestRecord === undefined) {
          throw this.#failClose('protocol-violation', PROTOCOL_ERROR);
        }
        await requestRecord.processing;
        for (const reply of requestRecord.replies) await this.#writePacket(reply);
      }
      return;
    }
    if (envelope.sequence > this.#nextInboundSequence) {
      throw this.#failClose('protocol-violation', PROTOCOL_ERROR);
    }
    if (this.#inbound.size >= this.#maxTrackedSequences) {
      throw this.#failClose('rollover-required', ROLLOVER_ERROR);
    }
    if (this.#cachedBytes > this.#maxCachedBytes - normalized.cacheBytes) {
      throw this.#failClose('cache-limit-exceeded', ROLLOVER_ERROR);
    }
    if (this.#inboundMessageIds.has(envelope.messageId)) {
      throw this.#failClose('protocol-violation', PROTOCOL_ERROR);
    }

    if (this.#isReservedSequence(envelope.sequence)) this.beginDrain();
    const isRequest = isRequestEnvelope(envelope);
    if (
      isRequest &&
      this.#state === 'draining' &&
      !this.#isActiveTaskContinuation(envelope.kind, envelope.taskId)
    ) {
      throw this.#failClose('rollover-required', ROLLOVER_ERROR);
    }
    if (isRequest && this.#cachedRequests >= this.#maxCachedRequests) {
      throw this.#failClose('cache-limit-exceeded', ROLLOVER_ERROR);
    }

    const inboundRecord: InboundPacketRecord = { packet: normalized, isRequest };
    this.#inbound.set(envelope.sequence, inboundRecord);
    this.#inboundMessageIds.set(envelope.messageId, envelope.sequence);
    this.#nextInboundSequence += 1;
    this.#cachedBytes += normalized.cacheBytes;
    this.#drainAtCapacity();

    if (!isRequest) {
      this.#acceptResponse(envelope as RpcResponseEnvelope, normalized.sidecars);
      this.#drainAtCapacity();
      return;
    }

    this.#cachedRequests += 1;
    const requestRecord: InboundRequestRecord = {
      envelope,
      sidecars: normalized.sidecars,
      protocol: createExchangeProtocol(envelope),
      replies: [],
      writes: [],
      processing: Promise.resolve(),
      completed: false,
      executorTaskActive: envelope.kind === 'executor.request',
    };
    inboundRecord.request = requestRecord;
    if (requestRecord.executorTaskActive) this.#activateExecutorTask(envelope.taskId);
    requestRecord.processing = Promise.resolve().then(() => this.#dispatchRequest(requestRecord));
    await requestRecord.processing;
  }

  #createExchange(record: PendingExchangeRecord): SubAgentTransportPeerExchange {
    const exchange: SubAgentTransportPeerExchange = {
      messageId: record.messageId,
      taskId: record.taskId,
      operationId: record.operationId,
      requestKind: record.protocol.requestKind,
      openedAt: record.openedAt,
      next: () => this.#nextExchange(record),
      abort: () => this.#abortExchange(record, false),
      return: async () => {
        this.#abortExchange(record, false);
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]: () => exchange,
    };
    return Object.freeze(exchange);
  }

  #nextExchange(
    record: PendingExchangeRecord,
  ): Promise<IteratorResult<SubAgentTransportPeerResponse>> {
    const queued = record.queue.shift();
    if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
    if (record.failure !== undefined) return Promise.reject(record.failure);
    if (record.terminal) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => record.waiters.push({ resolve, reject }));
  }

  #abortExchange(record: PendingExchangeRecord, timedOut: boolean): void {
    if (record.terminal || record.failure !== undefined) return;
    if (this.#pending.get(record.messageId) !== record) return;
    const error = timedOut
      ? peerError('timed-out', TIMED_OUT_ERROR)
      : peerError('aborted', ABORTED_ERROR);
    record.failure = error;
    record.queue.length = 0;
    this.#pending.delete(record.messageId);
    if (record.admitted) {
      if (this.#tombstones.size >= this.#maxTombstones) {
        this.#failClose('rollover-required', ROLLOVER_ERROR);
        record.executorTaskActive = false;
        this.#releaseExchange(record);
        for (const waiter of record.waiters.splice(0)) waiter.reject(error);
        return;
      }
      this.#tombstones.set(record.messageId, {
        taskId: record.taskId,
        operationId: record.operationId,
        protocol: cloneProtocolState(record.protocol),
        executorTaskActive: record.executorTaskActive,
      });
      record.executorTaskActive = false;
      if (this.#tombstones.size >= this.#maxTombstones) this.beginDrain();
    } else if (record.executorTaskActive) {
      record.executorTaskActive = false;
      this.#deactivateExecutorTask(record.taskId);
    }
    this.#releaseExchange(record);
    for (const waiter of record.waiters.splice(0)) waiter.reject(error);
  }

  #prepareRequestPacket(request: SubAgentTransportPeerRequest): {
    readonly envelope: RpcRequestEnvelope;
    readonly packet: OutgoingPacket;
  } {
    if (!REQUEST_KINDS.has(request.kind)) throw new TypeError('Unsupported request kind.');
    assertIdentifier(request.taskId, 'taskId');
    assertIdentifier(request.operationId, 'operationId');
    const sequence = this.#requireOutboundSequence(request.kind, request.taskId);
    const messageId = this.#newMessageId(sequence, request.kind);
    const envelope = createSubAgentTransportRpcEnvelope(
      {
        channelId: this.channelId,
        sequence,
        messageId,
        taskId: request.taskId,
        operationId: request.operationId,
        kind: request.kind,
        payload: request.payload,
      } as Parameters<typeof createSubAgentTransportRpcEnvelope>[0],
      this.#rpc,
    ) as RpcRequestEnvelope;
    const packet = this.#createOutgoingPacket(envelope, request.sidecars ?? []);
    return { envelope, packet };
  }

  #prepareReplyPacket(
    request: InboundRequestRecord,
    reply: SubAgentTransportPeerReply,
  ): OutgoingPacket {
    if (this.#state === 'closed') throw peerError('closed', CLOSED_ERROR);
    const nextProtocol = cloneProtocolState(request.protocol);
    advanceExchange(nextProtocol, reply.kind, reply.payload);
    const sequence = this.#requireOutboundSequence();
    const messageId = this.#newMessageId(sequence, reply.kind);
    const envelope = createSubAgentTransportRpcEnvelope(
      {
        channelId: this.channelId,
        sequence,
        messageId,
        correlationId: request.envelope.messageId,
        taskId: request.envelope.taskId,
        operationId: request.envelope.operationId,
        kind: reply.kind,
        payload: reply.payload,
      } as Parameters<typeof createSubAgentTransportRpcEnvelope>[0],
      this.#rpc,
    ) as RpcResponseEnvelope;
    const packet = this.#createOutgoingPacket(envelope, reply.sidecars ?? []);
    if (this.#cachedBytes > this.#maxCachedBytes - packet.cacheBytes) {
      throw new CapacityError('cache');
    }

    this.#commitOutbound(envelope.messageId);
    request.protocol.stage = nextProtocol.stage;
    if (request.protocol.stage === 'terminal' && request.executorTaskActive) {
      request.executorTaskActive = false;
      this.#deactivateExecutorTask(request.envelope.taskId);
    }
    request.replies.push(packet);
    this.#cachedBytes += packet.cacheBytes;
    return packet;
  }

  #createOutgoingPacket(
    envelope: SubAgentTransportRpcEnvelope,
    offeredSidecars: readonly SubAgentTransportArtifactSidecar[],
  ): OutgoingPacket {
    const sidecars = this.#normalizeSidecars(offeredSidecars);
    this.#assertSidecarAssociation(envelope, sidecars);
    const frame = encodeSubAgentTransportRpcFrame(envelope, this.#rpc);
    return Object.freeze({
      frame,
      sidecars,
      cacheBytes: packetCacheBytes(textEncoder.encode(frame), sidecars),
    });
  }

  #normalizeIncomingPacket(packet: SubAgentTransportPeerPacket): NormalizedPacket {
    assertPacketShape(packet);
    const ownedFrameBytes =
      typeof packet.frame === 'string'
        ? textEncoder.encode(packet.frame)
        : new Uint8Array(packet.frame);
    const envelope = decodeSubAgentTransportRpcFrame(ownedFrameBytes, this.#rpc);
    const frameBytes = textEncoder.encode(encodeSubAgentTransportRpcFrame(envelope, this.#rpc));
    const sidecars = this.#normalizeSidecars(packet.sidecars);
    this.#assertSidecarAssociation(envelope, sidecars);
    return Object.freeze({
      frameBytes,
      envelope,
      sidecars,
      cacheBytes: packetCacheBytes(frameBytes, sidecars),
    });
  }

  #normalizeSidecars(
    sidecars: readonly SubAgentTransportArtifactSidecar[],
  ): readonly SubAgentTransportArtifactSidecar[] {
    if (!Array.isArray(sidecars) || nodeTypes.isProxy(sidecars)) {
      throw new TypeError('Packet sidecars must be a non-Proxy array.');
    }
    if (sidecars.length > this.#maxSidecars) throw new CapacityError('sidecar');
    const result: SubAgentTransportArtifactSidecar[] = [];
    const ids = new Set<string>();
    let totalBytes = 0;
    for (let index = 0; index < sidecars.length; index += 1) {
      const itemDescriptor = Object.getOwnPropertyDescriptor(sidecars, String(index));
      if (
        itemDescriptor === undefined ||
        !('value' in itemDescriptor) ||
        itemDescriptor.enumerable !== true
      ) {
        throw new TypeError('Packet sidecars must contain only enumerable data items.');
      }
      const sidecar = itemDescriptor.value;
      assertSidecarShape(sidecar);
      const rawBytes = sidecarByteLength(sidecar.data);
      if (rawBytes > this.#maxSidecarItemBytes) throw new CapacityError('sidecar');
      if (rawBytes > this.#maxSidecarBytes - totalBytes) throw new CapacityError('sidecar');
      const decoded = decodeSubAgentTransportArtifactSidecar(sidecar.descriptor, sidecar.data, {
        maxBytes: this.#maxSidecarItemBytes,
      });
      if (decoded.data.byteLength > this.#maxSidecarItemBytes) {
        throw new CapacityError('sidecar');
      }
      if (decoded.data.byteLength > this.#maxSidecarBytes - totalBytes) {
        throw new CapacityError('sidecar');
      }
      if (ids.has(decoded.descriptor.sidecarId)) {
        throw new TypeError('Packet sidecar IDs must be unique.');
      }
      ids.add(decoded.descriptor.sidecarId);
      totalBytes += decoded.data.byteLength;
      result.push(decoded);
    }
    return Object.freeze(result);
  }

  #assertSidecarAssociation(
    envelope: SubAgentTransportRpcEnvelope,
    sidecars: readonly SubAgentTransportArtifactSidecar[],
  ): void {
    const expected = this.#validateSidecars(envelope, cloneSidecars(sidecars));
    if (!Array.isArray(expected)) {
      throw new TypeError('Sidecar validator must return an array of expected IDs.');
    }
    const expectedIds = new Set<string>();
    for (const id of expected) {
      assertIdentifier(id, 'expected sidecar ID');
      if (expectedIds.has(id)) throw new TypeError('Expected sidecar IDs must be unique.');
      expectedIds.add(id);
    }
    const actualIds = new Set(sidecars.map(({ descriptor }) => descriptor.sidecarId));
    if (actualIds.size !== expectedIds.size || [...expectedIds].some((id) => !actualIds.has(id))) {
      throw new TypeError('Packet sidecars do not exactly match the method-specific expectation.');
    }
  }

  async #dispatchRequest(request: InboundRequestRecord): Promise<void> {
    const reply = (input: SubAgentTransportPeerReply): Promise<void> => {
      let packet: OutgoingPacket;
      try {
        packet = this.#prepareReplyPacket(request, input);
      } catch (error) {
        if (error instanceof CapacityError) {
          const failure = this.#failClose(
            error.capacity === 'sidecar' ? 'sidecar-limit-exceeded' : 'cache-limit-exceeded',
            ROLLOVER_ERROR,
          );
          return Promise.reject(failure);
        }
        const failure = this.#failClose('protocol-violation', PROTOCOL_ERROR);
        const rejected = Promise.reject(failure);
        void rejected.catch(() => undefined);
        return rejected;
      }
      const write = this.#writePacket(packet);
      request.writes.push(write);
      return write;
    };

    try {
      if (this.#handler === undefined) throw new Error('No handler.');
      await this.#handler(
        Object.freeze({
          envelope: request.envelope,
          sidecars: cloneSidecars(request.sidecars),
          receivedAt: readNow(this.#now),
          reply,
        }),
      );
      await Promise.all(request.writes);
    } catch (error) {
      await Promise.allSettled(request.writes);
      if (this.#state === 'closed') throw error;
    }

    if (this.#state !== 'closed' && request.protocol.stage !== 'terminal') {
      let failurePacket: OutgoingPacket;
      try {
        failurePacket = this.#prepareReplyPacket(request, {
          kind: 'protocol.error',
          payload: { error: HANDLER_ERROR },
        });
      } catch (error) {
        if (error instanceof CapacityError) {
          throw this.#failClose('cache-limit-exceeded', ROLLOVER_ERROR);
        }
        throw this.#failClose('protocol-violation', PROTOCOL_ERROR);
      }
      const write = this.#writePacket(failurePacket);
      request.writes.push(write);
      await write;
    }

    request.completed = true;
    this.#drainAtCapacity();
  }

  #acceptResponse(
    envelope: RpcResponseEnvelope,
    sidecars: readonly SubAgentTransportArtifactSidecar[],
  ): void {
    const correlationId = envelope.correlationId;
    const pending = this.#pending.get(correlationId);
    const tombstone = this.#tombstones.get(correlationId);
    const target = pending ?? tombstone;
    if (target === undefined) throw this.#failClose('protocol-violation', PROTOCOL_ERROR);
    if (envelope.taskId !== target.taskId || envelope.operationId !== target.operationId) {
      throw this.#failClose('protocol-violation', PROTOCOL_ERROR);
    }
    try {
      advanceExchange(target.protocol, envelope.kind, envelope.payload);
    } catch {
      throw this.#failClose('protocol-violation', PROTOCOL_ERROR);
    }
    if (target.protocol.stage === 'terminal' && target.executorTaskActive) {
      target.executorTaskActive = false;
      this.#deactivateExecutorTask(target.taskId);
    }
    if (pending === undefined) {
      if (target.protocol.stage === 'terminal') this.#tombstones.delete(correlationId);
      return;
    }

    const response = Object.freeze({
      envelope,
      sidecars: cloneSidecars(sidecars),
    }) satisfies SubAgentTransportPeerResponse;
    const waiter = pending.waiters.shift();
    if (waiter === undefined) pending.queue.push(response);
    else waiter.resolve({ done: false, value: response });

    if (pending.protocol.stage === 'terminal') {
      pending.terminal = true;
      this.#pending.delete(pending.messageId);
      this.#releaseExchange(pending);
      for (const remaining of pending.waiters.splice(0)) {
        remaining.resolve({ done: true, value: undefined });
      }
    }
  }

  #armExchange(
    record: PendingExchangeRecord,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): void {
    if (signal !== undefined) {
      const listener = (): void => this.#abortExchange(record, false);
      record.signal = signal;
      record.abortListener = listener;
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) this.#abortExchange(record, false);
    }
    if (timeoutMs !== undefined && record.failure === undefined) {
      this.#scheduleExchangeTimeout(record, timeoutMs);
    }
  }

  #scheduleExchangeTimeout(record: PendingExchangeRecord, remainingMs: number): void {
    const delay = Math.min(remainingMs, MAX_NODE_TIMER_DELAY_MS);
    const timerState: { handle?: unknown; handleAssigned: boolean } = { handleAssigned: false };
    let firedSynchronously = false;
    const onTimeout = (): void => {
      if (!timerState.handleAssigned) {
        firedSynchronously = true;
        return;
      }
      this.#continueExchangeTimeout(record, timerState.handle, remainingMs - delay);
    };

    const handle = this.#timers.set(onTimeout, delay);
    timerState.handle = handle;
    timerState.handleAssigned = true;
    if (
      record.failure !== undefined ||
      record.terminal ||
      this.#pending.get(record.messageId) !== record
    ) {
      try {
        this.#timers.clear(handle);
      } catch {
        // Cleanup errors never replace the stable transport outcome.
      }
      return;
    }
    if (firedSynchronously) {
      try {
        this.#timers.clear(handle);
      } catch {
        // Cleanup errors never replace the stable transport outcome.
      }
      this.#continueExchangeTimeout(record, handle, remainingMs - delay);
      return;
    }
    record.timer = handle;
  }

  #continueExchangeTimeout(
    record: PendingExchangeRecord,
    handle: unknown,
    remainingMs: number,
  ): void {
    if (record.timer === handle) delete record.timer;
    if (
      record.failure !== undefined ||
      record.terminal ||
      this.#pending.get(record.messageId) !== record
    ) {
      return;
    }
    if (remainingMs <= 0) {
      this.#abortExchange(record, true);
      return;
    }
    try {
      this.#scheduleExchangeTimeout(record, remainingMs);
    } catch {
      this.#failClose('protocol-violation', PROTOCOL_ERROR);
    }
  }

  #releaseExchange(record: PendingExchangeRecord): void {
    if (record.signal !== undefined && record.abortListener !== undefined) {
      record.signal.removeEventListener('abort', record.abortListener);
      delete record.signal;
      delete record.abortListener;
    }
    if ('timer' in record) {
      try {
        this.#timers.clear(record.timer);
      } catch {
        // Cleanup errors never replace the stable transport outcome.
      }
      delete record.timer;
    }
  }

  #writePacket(packet: OutgoingPacket): Promise<void> {
    if (this.#state === 'closed') throw peerError('closed', CLOSED_ERROR);
    let admission: SubAgentTransportPeerWriterAdmission;
    try {
      admission = this.#writer(cloneOutgoingPacket(packet));
      assertWriterAdmission(admission);
    } catch {
      throw this.#failClose('writer-failed', WRITER_ERROR);
    }
    if (admission.settled === undefined) return Promise.resolve();
    try {
      return Promise.resolve(admission.settled).then(
        () => undefined,
        () => {
          throw this.#failClose('writer-failed', WRITER_ERROR);
        },
      );
    } catch {
      throw this.#failClose('writer-failed', WRITER_ERROR);
    }
  }

  #requireOutboundSequence(requestKind?: SubAgentTransportRpcRequestKind, taskId?: string): number {
    const forNewRequest = requestKind !== undefined;
    if (this.#state === 'closed') throw peerError('closed', CLOSED_ERROR);
    if (this.#state === 'open' && this.#isReservedSequence(this.#nextOutboundSequence)) {
      this.beginDrain();
    }
    if (
      forNewRequest &&
      this.#state === 'draining' &&
      !this.#isActiveTaskContinuation(requestKind, taskId)
    ) {
      throw peerError('draining', ROLLOVER_ERROR);
    }
    if (this.#nextOutboundSequence > this.#maxTrackedSequences) {
      if (forNewRequest) {
        this.beginDrain();
        throw peerError('rollover-required', ROLLOVER_ERROR);
      }
      throw this.#failClose('rollover-required', ROLLOVER_ERROR);
    }
    return this.#nextOutboundSequence;
  }

  #newMessageId(sequence: number, kind: SubAgentTransportRpcEnvelope['kind']): string {
    const id = this.#createMessageId({ channelId: this.channelId, sequence, kind });
    assertIdentifier(id, 'generated messageId');
    if (this.#outboundMessageIds.has(id)) {
      throw new TypeError('Subagent transport peer message IDs must be unique.');
    }
    return id;
  }

  #commitOutbound(messageId: string): void {
    this.#outboundMessageIds.add(messageId);
    this.#nextOutboundSequence += 1;
    if (
      this.#nextOutboundSequence > this.#maxTrackedSequences ||
      this.#isReservedSequence(this.#nextOutboundSequence)
    ) {
      this.beginDrain();
    }
  }

  #isReservedSequence(sequence: number): boolean {
    return (
      this.#settlementSequenceHeadroom > 0 &&
      sequence > this.#maxTrackedSequences - this.#settlementSequenceHeadroom
    );
  }

  #isActiveTaskContinuation(
    kind: SubAgentTransportRpcRequestKind,
    taskId: string | undefined,
  ): boolean {
    return (
      ACTIVE_TASK_CONTINUATION_KINDS.has(kind) &&
      taskId !== undefined &&
      (this.#activeExecutorTasks.get(taskId) ?? 0) > 0
    );
  }

  #activateExecutorTask(taskId: string): void {
    this.#activeExecutorTasks.set(taskId, (this.#activeExecutorTasks.get(taskId) ?? 0) + 1);
  }

  #deactivateExecutorTask(taskId: string): void {
    const count = this.#activeExecutorTasks.get(taskId);
    if (count === undefined) return;
    if (count <= 1) this.#activeExecutorTasks.delete(taskId);
    else this.#activeExecutorTasks.set(taskId, count - 1);
  }

  #drainAtCapacity(): void {
    if (
      this.#cachedRequests >= this.#maxCachedRequests ||
      this.#cachedBytes >= this.#maxCachedBytes ||
      this.#inbound.size >= this.#maxTrackedSequences ||
      this.#nextOutboundSequence > this.#maxTrackedSequences ||
      this.#isReservedSequence(this.#nextInboundSequence) ||
      this.#isReservedSequence(this.#nextOutboundSequence)
    ) {
      this.beginDrain();
    }
  }

  #failClose(
    reason: SubAgentTransportPeerErrorReason,
    descriptor: SubAgentTransportSafeError,
  ): SubAgentTransportPeerError {
    const error = peerError(reason, descriptor);
    this.#closeInternal(error);
    return error;
  }

  #closeInternal(error: SubAgentTransportPeerError): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    for (const record of this.#pending.values()) {
      record.failure = error;
      record.queue.length = 0;
      this.#releaseExchange(record);
      for (const waiter of record.waiters.splice(0)) waiter.reject(error);
    }
    this.#pending.clear();
    this.#tombstones.clear();
    this.#inbound.clear();
    this.#inboundMessageIds.clear();
    this.#outboundMessageIds.clear();
    this.#activeExecutorTasks.clear();
    this.#cachedBytes = 0;
    this.#cachedRequests = 0;
  }
}

export function createSubAgentTransportPeer(
  options: SubAgentTransportPeerOptions,
): SubAgentTransportPeer {
  return new SubAgentTransportPeer(options);
}

function createExchangeProtocol(envelope: RpcRequestEnvelope): ExchangeProtocolState {
  if (envelope.kind === 'executor.request') {
    const request = envelope.payload.request;
    const operationBinding =
      request.operation.type === 'create'
        ? undefined
        : snapshotBindingCorrelation(request.operation.binding);
    return {
      requestKind: envelope.kind,
      requestMode: envelope.payload.mode,
      executor: {
        ownerSessionId: request.ownerSessionId,
        taskId: request.taskId,
        subagentSessionId: request.subagentSessionId,
        definitionName: request.definition.name,
        definitionVersion: request.definition.version,
        ...(operationBinding === undefined ? {} : { operationBinding }),
      },
      stage: 'initial',
    };
  }
  if (envelope.kind === 'snapshot.request') {
    return { requestKind: envelope.kind, requestMode: envelope.payload.mode, stage: 'initial' };
  }
  if (envelope.kind === 'control.request') {
    return {
      requestKind: envelope.kind,
      controlMethod: envelope.payload.method,
      stage: 'initial',
    };
  }
  if (envelope.kind === 'events.request') {
    return {
      requestKind: envelope.kind,
      events: {
        afterSequence: envelope.payload.afterSequence ?? 0,
        limit: envelope.payload.limit ?? 256,
      },
      stage: 'initial',
    };
  }
  if (envelope.kind === 'model.request') {
    return {
      requestKind: envelope.kind,
      model: {
        providerOperationId: envelope.payload.providerOperationId,
        gatewayId: envelope.payload.gatewayId,
        protocol: envelope.payload.protocol,
        codecVersion: envelope.payload.codecVersion,
        runId: envelope.payload.runId,
        executionAttempt: envelope.payload.executionAttempt,
        executionEpoch: envelope.payload.executionEpoch,
        executionFencingToken: envelope.payload.executionFencingToken,
        checkpointOperationId: envelope.payload.checkpointOperationId,
        checkpointDigest: envelope.payload.checkpointDigest,
        requestHash: envelope.payload.requestHash,
      },
      stage: 'initial',
    };
  }
  return { requestKind: envelope.kind, stage: 'initial' };
}

function cloneProtocolState(state: ExchangeProtocolState): ExchangeProtocolState {
  return {
    requestKind: state.requestKind,
    ...(state.requestMode === undefined ? {} : { requestMode: state.requestMode }),
    ...(state.controlMethod === undefined ? {} : { controlMethod: state.controlMethod }),
    ...(state.executor === undefined
      ? {}
      : {
          executor: {
            ownerSessionId: state.executor.ownerSessionId,
            taskId: state.executor.taskId,
            subagentSessionId: state.executor.subagentSessionId,
            definitionName: state.executor.definitionName,
            definitionVersion: state.executor.definitionVersion,
            ...(state.executor.operationBinding === undefined
              ? {}
              : { operationBinding: { ...state.executor.operationBinding } }),
            ...(state.executor.acceptedBinding === undefined
              ? {}
              : { acceptedBinding: { ...state.executor.acceptedBinding } }),
          },
        }),
    ...(state.events === undefined ? {} : { events: { ...state.events } }),
    ...(state.model === undefined ? {} : { model: { ...state.model } }),
    stage: state.stage,
  };
}

function advanceExchange(
  state: ExchangeProtocolState,
  replyKind: RpcResponseKind,
  payload: SubAgentTransportRpcPayloadMap[RpcResponseKind],
): void {
  if (state.stage === 'terminal') throw new TypeError('Exchange already settled.');
  if (replyKind === 'protocol.error') {
    state.stage = 'terminal';
    return;
  }

  switch (state.requestKind) {
    case 'executor.request':
      if (state.requestMode === 'execute') {
        if (replyKind !== 'executor.settled' || readMode(payload) !== 'execute') {
          throw new TypeError('Execute requests require one execute settlement.');
        }
        assertExecutorSettlementCorrelation(state.executor, payload);
        state.stage = 'terminal';
        return;
      }
      if (state.stage === 'initial') {
        if (replyKind === 'executor.accepted' && readMode(payload) === 'spawn') {
          const binding = readAcceptedBinding(payload);
          assertAcceptedBindingCorrelation(state.executor, binding);
          if (state.executor === undefined) {
            throw new TypeError('Executor correlation state is missing.');
          }
          state.executor.acceptedBinding = snapshotBindingCorrelation(binding);
          state.stage = 'accepted';
          return;
        }
        if (
          replyKind === 'executor.settled' &&
          readMode(payload) === 'spawn' &&
          isUnboundCreateRecovery(payload)
        ) {
          assertExecutorSettlementCorrelation(state.executor, payload);
          state.stage = 'terminal';
          return;
        }
        throw new TypeError(
          'Spawn requests require acceptance or a direct unbound-create recovery settlement.',
        );
      }
      if (replyKind !== 'executor.settled' || readMode(payload) !== 'spawn') {
        throw new TypeError('Accepted spawn requests require a spawn settlement.');
      }
      if (isUnboundCreateRecovery(payload)) {
        throw new TypeError('An accepted spawn cannot settle as unbound-create recovery.');
      }
      assertExecutorSettlementCorrelation(state.executor, payload);
      state.stage = 'terminal';
      return;
    case 'control.request':
      assertSingleReply(replyKind, 'control.reply');
      if (readMethod(payload) !== state.controlMethod) {
        throw new TypeError('Control replies must preserve the requested control method.');
      }
      break;
    case 'cancel.request':
      assertSingleReply(replyKind, 'cancel.ack');
      break;
    case 'snapshot.request':
      if (state.requestMode === 'snapshot') {
        if (replyKind !== 'snapshot.reply' || readMode(payload) !== 'snapshot') {
          throw new TypeError('Snapshot requests require a snapshot reply.');
        }
      } else if (replyKind !== 'executor.settled' || readMode(payload) !== 'wait') {
        throw new TypeError('Wait requests require a wait settlement.');
      }
      break;
    case 'events.request':
      assertSingleReply(replyKind, 'events.page');
      assertEventsPageCorrelation(state.events, payload);
      break;
    case 'model.request':
      assertSingleReply(replyKind, 'model.reply');
      assertModelReplyCorrelation(state.model, payload);
      break;
  }
  state.stage = 'terminal';
}

function snapshotBindingCorrelation(
  binding: SubAgentTransportRpcPayloadMap['executor.accepted']['binding'],
): ExecutorBindingCorrelation {
  return {
    version: binding.version,
    executorName: binding.executorName,
    ownerSessionId: binding.ownerSessionId,
    taskId: binding.taskId,
    subagentSessionId: binding.subagentSessionId,
    definitionName: binding.definitionName,
    definitionVersion: binding.definitionVersion,
    runnerId: binding.runnerId,
    runnerVersion: binding.runnerVersion,
  };
}

function readAcceptedBinding(
  value: unknown,
): SubAgentTransportRpcPayloadMap['executor.accepted']['binding'] {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Executor acceptance payload is missing.');
  }
  const binding = Reflect.get(value, 'binding');
  if (typeof binding !== 'object' || binding === null) {
    throw new TypeError('Executor acceptance binding is missing.');
  }
  return binding as SubAgentTransportRpcPayloadMap['executor.accepted']['binding'];
}

function assertAcceptedBindingCorrelation(
  expected: ExecutorExchangeCorrelation | undefined,
  actual: SubAgentTransportRpcPayloadMap['executor.accepted']['binding'],
): void {
  if (
    expected === undefined ||
    actual.ownerSessionId !== expected.ownerSessionId ||
    actual.taskId !== expected.taskId ||
    actual.subagentSessionId !== expected.subagentSessionId ||
    actual.definitionName !== expected.definitionName ||
    actual.definitionVersion !== expected.definitionVersion
  ) {
    throw new TypeError('Executor acceptance binding does not match the execution request.');
  }
  const operationBinding = expected.operationBinding;
  if (
    operationBinding !== undefined &&
    (actual.version !== operationBinding.version ||
      actual.executorName !== operationBinding.executorName ||
      actual.ownerSessionId !== operationBinding.ownerSessionId ||
      actual.taskId !== operationBinding.taskId ||
      actual.subagentSessionId !== operationBinding.subagentSessionId ||
      actual.definitionName !== operationBinding.definitionName ||
      actual.definitionVersion !== operationBinding.definitionVersion ||
      actual.runnerId !== operationBinding.runnerId ||
      actual.runnerVersion !== operationBinding.runnerVersion)
  ) {
    throw new TypeError('Executor acceptance binding does not match the requested binding route.');
  }
}

function assertExecutorSettlementCorrelation(
  expected: ExecutorExchangeCorrelation | undefined,
  value: unknown,
): void {
  if (expected === undefined || typeof value !== 'object' || value === null) {
    throw new TypeError('Executor settlement correlation state is missing.');
  }
  const outcome = Reflect.get(value, 'outcome');
  if (typeof outcome !== 'object' || outcome === null) {
    throw new TypeError('Executor settlement outcome is missing.');
  }
  const outcomeType = Reflect.get(outcome, 'type');
  if (outcomeType === 'recovery_required') return;

  const result = outcomeType === 'terminal' ? Reflect.get(outcome, 'result') : outcome;
  if (typeof result !== 'object' || result === null) {
    throw new TypeError('Executor settlement task identity is missing.');
  }
  const task = Reflect.get(result, 'task');
  if (typeof task !== 'object' || task === null) {
    throw new TypeError('Executor settlement task identity is missing.');
  }
  const subAgent = Reflect.get(task, 'subAgent');
  if (
    Reflect.get(task, 'taskId') !== expected.taskId ||
    typeof subAgent !== 'object' ||
    subAgent === null ||
    Reflect.get(subAgent, 'name') !== expected.definitionName ||
    Reflect.get(subAgent, 'version') !== expected.definitionVersion
  ) {
    throw new TypeError('Executor settlement task does not match the execution request.');
  }

  if (outcomeType === 'terminal') {
    const expectedExecutor =
      expected.acceptedBinding?.executorName ?? expected.operationBinding?.executorName;
    if (expectedExecutor !== undefined && Reflect.get(result, 'executor') !== expectedExecutor) {
      throw new TypeError('Executor settlement executor does not match the accepted binding.');
    }
  }
}

function assertEventsPageCorrelation(
  expected: EventsExchangeCorrelation | undefined,
  value: unknown,
): void {
  if (expected === undefined || typeof value !== 'object' || value === null) {
    throw new TypeError('Events page correlation state is missing.');
  }
  const events = Reflect.get(value, 'events');
  const nextSequence = Reflect.get(value, 'nextSequence');
  const expectedNextSequence =
    Array.isArray(events) && events.length > 0
      ? Reflect.get(events[events.length - 1] as object, 'sequence')
      : expected.afterSequence;
  if (
    !Array.isArray(events) ||
    events.length > expected.limit ||
    events.some(
      (event) =>
        typeof event !== 'object' ||
        event === null ||
        (Reflect.get(event, 'sequence') as number) <= expected.afterSequence,
    ) ||
    nextSequence !== expectedNextSequence
  ) {
    throw new TypeError('Events page does not satisfy the requested cursor and limit.');
  }
}

function assertModelReplyCorrelation(
  expected: ModelExchangeCorrelation | undefined,
  value: unknown,
): void {
  if (expected === undefined || typeof value !== 'object' || value === null) {
    throw new TypeError('Model reply correlation state is missing.');
  }
  if (
    Reflect.get(value, 'providerOperationId') !== expected.providerOperationId ||
    Reflect.get(value, 'gatewayId') !== expected.gatewayId ||
    Reflect.get(value, 'protocol') !== expected.protocol ||
    Reflect.get(value, 'codecVersion') !== expected.codecVersion ||
    Reflect.get(value, 'runId') !== expected.runId ||
    Reflect.get(value, 'executionAttempt') !== expected.executionAttempt ||
    Reflect.get(value, 'executionEpoch') !== expected.executionEpoch ||
    Reflect.get(value, 'executionFencingToken') !== expected.executionFencingToken ||
    Reflect.get(value, 'checkpointOperationId') !== expected.checkpointOperationId ||
    Reflect.get(value, 'checkpointDigest') !== expected.checkpointDigest ||
    Reflect.get(value, 'requestHash') !== expected.requestHash
  ) {
    throw new TypeError('Model reply does not match its request identity.');
  }
}

function assertSingleReply(actual: RpcResponseKind, expected: RpcResponseKind): void {
  if (actual !== expected) throw new TypeError(`Request requires ${expected}.`);
}

function readMode(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, 'mode') : undefined;
}

function readMethod(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, 'method') : undefined;
}

function isUnboundCreateRecovery(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const outcome = Reflect.get(value, 'outcome');
  return (
    typeof outcome === 'object' &&
    outcome !== null &&
    Reflect.get(outcome, 'type') === 'recovery_required' &&
    Reflect.get(outcome, 'reason') === 'unbound_create'
  );
}

function isRequestEnvelope(envelope: SubAgentTransportRpcEnvelope): envelope is RpcRequestEnvelope {
  return REQUEST_KINDS.has(envelope.kind as SubAgentTransportRpcRequestKind);
}

function assertPacketShape(value: unknown): asserts value is SubAgentTransportPeerPacket {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    throw new TypeError('Subagent transport peer packet must be a plain object.');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes('frame') ||
    !keys.includes('sidecars') ||
    keys.some((key) => typeof key !== 'string')
  ) {
    throw new TypeError('Subagent transport peer packet must contain only frame and sidecars.');
  }
  assertPlainDataObject(value, keys, 'Subagent transport peer packet');
  const packet = value as Record<string, unknown>;
  if (typeof packet.frame !== 'string' && !(packet.frame instanceof Uint8Array)) {
    throw new TypeError('Subagent transport peer packet frame must be a string or Uint8Array.');
  }
  if (nodeTypes.isProxy(packet.frame)) {
    throw new TypeError('Subagent transport peer packet frame must not be a Proxy.');
  }
  if (!Array.isArray(packet.sidecars) || nodeTypes.isProxy(packet.sidecars)) {
    throw new TypeError('Subagent transport peer packet sidecars must be an array.');
  }
}

function assertSidecarShape(value: unknown): asserts value is SubAgentTransportArtifactSidecar {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    throw new TypeError('Subagent transport packet sidecar must be an object.');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes('descriptor') ||
    !keys.includes('data') ||
    keys.some((key) => typeof key !== 'string')
  ) {
    throw new TypeError('Subagent transport packet sidecar must contain descriptor and data.');
  }
  assertPlainDataObject(value, keys, 'Subagent transport packet sidecar');
}

function assertPlainDataObject(value: object, keys: readonly PropertyKey[], label: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must contain only enumerable data properties.`);
    }
  }
}

function sidecarByteLength(value: unknown): number {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value.byteLength;
  throw new TypeError('Subagent transport sidecar data must be bytes.');
}

function packetCacheBytes(
  frameBytes: Uint8Array,
  sidecars: readonly SubAgentTransportArtifactSidecar[],
): number {
  let bytes = frameBytes.byteLength;
  for (const sidecar of sidecars) {
    bytes += textEncoder.encode(JSON.stringify(sidecar.descriptor)).byteLength;
    bytes += sidecar.data.byteLength;
    if (!Number.isSafeInteger(bytes)) throw new CapacityError('cache');
  }
  return bytes;
}

function cloneSidecars(
  sidecars: readonly SubAgentTransportArtifactSidecar[],
): readonly SubAgentTransportArtifactSidecar[] {
  return Object.freeze(
    sidecars.map((sidecar) =>
      decodeSubAgentTransportArtifactSidecar(sidecar.descriptor, sidecar.data, {
        maxBytes: Math.max(1, sidecar.data.byteLength),
      }),
    ),
  );
}

function cloneOutgoingPacket(packet: OutgoingPacket): SubAgentTransportPeerPacket {
  return Object.freeze({ frame: packet.frame, sidecars: cloneSidecars(packet.sidecars) });
}

function sameNormalizedPacket(left: NormalizedPacket, right: NormalizedPacket): boolean {
  if (!sameBytes(left.frameBytes, right.frameBytes)) return false;
  if (left.sidecars.length !== right.sidecars.length) return false;
  const rightById = new Map(
    right.sidecars.map((sidecar) => [sidecar.descriptor.sidecarId, sidecar] as const),
  );
  return left.sidecars.every((sidecar) => {
    const other = rightById.get(sidecar.descriptor.sidecarId);
    return (
      other !== undefined &&
      sameSidecarDescriptor(sidecar.descriptor, other.descriptor) &&
      sameBytes(sidecar.data, other.data)
    );
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sameSidecarDescriptor(
  left: SubAgentTransportArtifactSidecar['descriptor'],
  right: SubAgentTransportArtifactSidecar['descriptor'],
): boolean {
  return (
    left.version === right.version &&
    left.sidecarId === right.sidecarId &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 &&
    left.artifact.version === right.artifact.version &&
    left.artifact.id === right.artifact.id &&
    left.artifact.mediaType === right.artifact.mediaType &&
    left.artifact.size === right.artifact.size &&
    left.artifact.sha256 === right.artifact.sha256
  );
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    containsControlCharacter(value) ||
    textEncoder.encode(value).byteLength < 1 ||
    textEncoder.encode(value).byteLength > SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES
  ) {
    throw new TypeError(`Subagent transport peer ${label} is not a bounded identifier.`);
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`Subagent transport peer ${label} must be a positive safe integer.`);
  }
  return resolved;
}

function trackedSequenceLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_SUBAGENT_TRANSPORT_SEQUENCE_WINDOW;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > SUBAGENT_TRANSPORT_MAX_SEQUENCE_WINDOW
  ) {
    throw new RangeError(
      `Subagent transport peer maxTrackedSequences must be a safe integer between 1 and ${SUBAGENT_TRANSPORT_MAX_SEQUENCE_WINDOW}.`,
    );
  }
  return resolved;
}

function settlementSequenceHeadroom(
  value: number | undefined,
  maxTrackedSequences: number,
): number {
  const requested = value ?? DEFAULT_SUBAGENT_TRANSPORT_PEER_SETTLEMENT_SEQUENCE_HEADROOM;
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new RangeError(
      'Subagent transport peer settlementSequenceHeadroom must be a non-negative safe integer.',
    );
  }
  return Math.min(requested, maxTrackedSequences - 1);
}

function assertWriterAdmission(
  value: unknown,
): asserts value is SubAgentTransportPeerWriterAdmission {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    throw new TypeError('Subagent transport writer must return a synchronous admission receipt.');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length < 1 ||
    keys.length > 2 ||
    !keys.includes('admitted') ||
    keys.some((key) => typeof key !== 'string' || (key !== 'admitted' && key !== 'settled'))
  ) {
    throw new TypeError('Subagent transport writer admission receipt has an invalid shape.');
  }
  assertPlainDataObject(value, keys, 'Subagent transport writer admission receipt');
  const record = value as Record<string, unknown>;
  if (record.admitted !== true) {
    throw new TypeError('Subagent transport writer must synchronously admit the packet.');
  }
  if (record.settled !== undefined && !isPromiseLike(record.settled)) {
    throw new TypeError('Subagent transport writer settled receipt must be Promise-like.');
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (typeof value === 'object' && value !== null && !nodeTypes.isProxy(value)) ||
    typeof value === 'function'
    ? typeof Reflect.get(value, 'then') === 'function'
    : false;
}

function resolveTimers(
  timers: SubAgentTransportPeerTimerApi | undefined,
): SubAgentTransportPeerTimerApi {
  if (timers === undefined) {
    return Object.freeze({
      set: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
  }
  if (typeof timers.set !== 'function' || typeof timers.clear !== 'function') {
    throw new TypeError('Subagent transport peer timers must provide set and clear functions.');
  }
  return timers;
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Subagent transport peer clock must return a non-negative safe integer.');
  }
  return value;
}

function cloneSafeError(
  value: unknown,
  fallback: SubAgentTransportSafeError,
): Readonly<SubAgentTransportSafeError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Object.freeze({ ...fallback });
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !SAFE_ERROR_KEYS.has(key)) ||
    !SAFE_ERROR_CODES.has(record.code as string) ||
    typeof record.message !== 'string' ||
    textEncoder.encode(record.message).byteLength > 4_096 ||
    typeof record.retryable !== 'boolean' ||
    (record.causeCode !== undefined &&
      (typeof record.causeCode !== 'string' || record.causeCode.length === 0)) ||
    (record.outcomeUnknown !== undefined && typeof record.outcomeUnknown !== 'boolean')
  ) {
    return Object.freeze({ ...fallback });
  }
  return Object.freeze({
    code: record.code as SubAgentErrorDescriptor['code'],
    message: record.message,
    retryable: record.retryable,
    ...(record.causeCode === undefined ? {} : { causeCode: record.causeCode as string }),
    ...(record.outcomeUnknown === undefined
      ? {}
      : { outcomeUnknown: record.outcomeUnknown as boolean }),
  });
}

function peerError(
  reason: SubAgentTransportPeerErrorReason,
  descriptor: SubAgentTransportSafeError,
): SubAgentTransportPeerError {
  return new SubAgentTransportPeerError(reason, descriptor);
}
