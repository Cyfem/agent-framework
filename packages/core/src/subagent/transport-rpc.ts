import type { ExecutorTaskSnapshot, SubAgentExecutorBinding } from './executor';
import type { SubAgentTaskEvent } from './telemetry';
import type {
  SubAgentTransportControlReplyPayload,
  SubAgentTransportControlRequestPayload,
} from './transport-control';
import type { SubAgentExecutionRequestWire, SubAgentTransportFrameOptions } from './transport';
import type {
  SubAgentTransportExecutorOperationResult,
  SubAgentTransportSafeError,
} from './transport-wire';

export type {
  SubAgentTransportExecutionOutcome,
  SubAgentTransportExecutorOperationResult,
  SubAgentTransportFailureInput,
  SubAgentTransportSafeError,
  SubAgentTransportTaskResult,
  SubAgentTransportTaskSnapshot,
} from './transport-wire';

/** Closed semantic message vocabulary shared by every C7 placement transport. */
export const SUBAGENT_TRANSPORT_RPC_KINDS = Object.freeze([
  'executor.request',
  'executor.accepted',
  'executor.settled',
  'control.request',
  'control.reply',
  'cancel.request',
  'cancel.ack',
  'snapshot.request',
  'snapshot.reply',
  'events.request',
  'events.page',
  'protocol.error',
] as const);

export type SubAgentTransportRpcKind = (typeof SUBAGENT_TRANSPORT_RPC_KINDS)[number];

/**
 * Small error descriptor safe to cross a placement boundary. Raw Error objects, stack traces,
 * provider response bodies, bindings and arbitrary metadata are deliberately not representable.
 */
export interface SubAgentTransportRpcPayloadMap {
  readonly 'executor.request': {
    readonly mode: 'execute' | 'spawn';
    readonly request: SubAgentExecutionRequestWire;
  };
  readonly 'executor.accepted': {
    readonly mode: 'spawn';
    readonly binding: SubAgentExecutorBinding;
  };
  readonly 'executor.settled': {
    readonly mode: 'execute' | 'spawn' | 'wait';
    readonly outcome: SubAgentTransportExecutorOperationResult;
  };
  readonly 'control.request': SubAgentTransportControlRequestPayload;
  readonly 'control.reply': SubAgentTransportControlReplyPayload;
  readonly 'cancel.request': {
    readonly binding: SubAgentExecutorBinding;
    readonly reason?: string;
  };
  readonly 'cancel.ack': {
    readonly cancelled: true;
  };
  readonly 'snapshot.request': {
    readonly mode: 'snapshot' | 'wait';
  };
  readonly 'snapshot.reply': {
    readonly mode: 'snapshot';
    readonly snapshot: ExecutorTaskSnapshot;
  };
  readonly 'events.request': {
    readonly afterSequence?: number;
    readonly limit?: number;
  };
  readonly 'events.page': {
    readonly events: readonly SubAgentTaskEvent[];
    readonly nextSequence: number;
    readonly done: boolean;
  };
  readonly 'protocol.error': {
    readonly error: SubAgentTransportSafeError;
  };
}

interface SubAgentTransportRpcBase<K extends SubAgentTransportRpcKind> {
  readonly version: '1';
  readonly channelId: string;
  readonly sequence: number;
  readonly messageId: string;
  readonly kind: K;
  readonly payload: SubAgentTransportRpcPayloadMap[K];
}

interface SubAgentTransportRpcRequestRoute {
  readonly correlationId?: never;
  readonly taskId: string;
  readonly operationId: string;
}

interface SubAgentTransportRpcReplyRoute {
  readonly correlationId: string;
  readonly taskId: string;
  readonly operationId: string;
}

/** A protocol error always identifies the rejected message; task and operation are all-or-none. */
interface SubAgentTransportRpcErrorRoute {
  readonly correlationId: string;
  readonly taskId?: string;
  readonly operationId?: string;
}

export type SubAgentTransportRpcRequestKind =
  | 'executor.request'
  | 'control.request'
  | 'cancel.request'
  | 'snapshot.request'
  | 'events.request';

export type SubAgentTransportRpcReplyKind = Exclude<
  SubAgentTransportRpcKind,
  SubAgentTransportRpcRequestKind | 'protocol.error'
>;

export type SubAgentTransportRpcRequestEnvelope = {
  [K in SubAgentTransportRpcRequestKind]: SubAgentTransportRpcBase<K> &
    SubAgentTransportRpcRequestRoute;
}[SubAgentTransportRpcRequestKind];

export type SubAgentTransportRpcReplyEnvelope = {
  [K in SubAgentTransportRpcReplyKind]: SubAgentTransportRpcBase<K> &
    SubAgentTransportRpcReplyRoute;
}[SubAgentTransportRpcReplyKind];

export type SubAgentTransportRpcProtocolErrorEnvelope = SubAgentTransportRpcBase<'protocol.error'> &
  SubAgentTransportRpcErrorRoute;

/** Strict semantic envelope layered on the protocol-neutral transport v1 frame. */
export type SubAgentTransportRpcEnvelope =
  | SubAgentTransportRpcRequestEnvelope
  | SubAgentTransportRpcReplyEnvelope
  | SubAgentTransportRpcProtocolErrorEnvelope;

/** Factory input; the codec owns and writes the transport version. */
export type CreateSubAgentTransportRpcEnvelopeInput = SubAgentTransportRpcEnvelope extends infer T
  ? T extends SubAgentTransportRpcEnvelope
    ? Omit<T, 'version'>
    : never
  : never;

export interface SubAgentTransportRpcValidationOptions extends SubAgentTransportFrameOptions {
  /** Canonical JCS byte limit for the complete semantic envelope. Defaults to maxFrameBytes. */
  readonly maxCanonicalBytes?: number;
  /** Maximum expanded JSON depth, with the envelope root at depth zero. Defaults to 128. */
  readonly maxJsonDepth?: number;
  /** Maximum number of expanded JSON values. Defaults to 1,000,000. */
  readonly maxJsonNodes?: number;
}

export type SubAgentTransportRpcErrorReason =
  | 'invalid-rpc-kind'
  | 'invalid-rpc-routing'
  | 'invalid-rpc-payload'
  | 'rpc-limit-exceeded';

/** Stable semantic validation error; framing errors continue to use SubAgentTransportError. */
export class SubAgentTransportRpcError extends TypeError {
  readonly code = 'SUBAGENT_TRANSPORT_RPC_ERROR';
  readonly reason: SubAgentTransportRpcErrorReason;

  constructor(reason: SubAgentTransportRpcErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SubAgentTransportRpcError';
    this.reason = reason;
  }
}
