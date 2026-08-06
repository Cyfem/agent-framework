import type { SubAgentExecutionRequest, SubAgentExecutorOperation } from './executor';
import type { JsonValue } from './json';

/** Shared wire version used by every Subagent v2 placement transport. */
export const SUBAGENT_TRANSPORT_VERSION = '1' as const;

/** Default maximum size of one UTF-8 JSON transport frame. */
export const DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Protocol identifiers are opaque, trimmed UTF-8 strings bounded independently of frame size. */
export const SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES = 256;

/** Transport message kinds are compact protocol tokens rather than user-controlled text. */
export const SUBAGENT_TRANSPORT_MAX_KIND_BYTES = 128;

/** A channel must roll over before replay state grows without bound. */
export const DEFAULT_SUBAGENT_TRANSPORT_SEQUENCE_WINDOW = 4_096;

/** Hard configuration ceiling for one channel's replay window. */
export const SUBAGENT_TRANSPORT_MAX_SEQUENCE_WINDOW = 1_000_000;

/** Conservative structural limits applied before canonical execution-wire decoding. */
export const DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH = 128;
export const DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES = 1_000_000;

export type SubAgentTransportErrorReason =
  | 'invalid-frame'
  | 'frame-too-large'
  | 'invalid-envelope'
  | 'unsupported-version'
  | 'invalid-identifier'
  | 'invalid-sequence'
  | 'invalid-kind'
  | 'invalid-execution-request'
  | 'deadline-expired'
  | 'sequence-gap'
  | 'sequence-replay-unknown'
  | 'sequence-window-exhausted'
  | 'message-replay-conflict';

/** Stable validation error thrown before a frame reaches an Executor or Core callback. */
export class SubAgentTransportError extends TypeError {
  readonly code = 'SUBAGENT_TRANSPORT_ERROR';
  readonly reason: SubAgentTransportErrorReason;

  constructor(reason: SubAgentTransportErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SubAgentTransportError';
    this.reason = reason;
  }
}

/** Protocol-neutral, closed JSON envelope shared by Worker, Process, HTTP and future adapters. */
export interface SubAgentTransportEnvelope<
  K extends string = string,
  P extends JsonValue = JsonValue,
> {
  readonly version: typeof SUBAGENT_TRANSPORT_VERSION;
  readonly channelId: string;
  readonly sequence: number;
  readonly messageId: string;
  readonly correlationId?: string;
  readonly taskId?: string;
  readonly operationId?: string;
  readonly kind: K;
  readonly payload: P;
}

export interface SubAgentTransportFrameOptions {
  /** Defaults to 16 MiB and is measured against the actual UTF-8 frame, not canonical payload size. */
  readonly maxFrameBytes?: number;
  /** Defaults to 128, where the envelope root has depth zero. */
  readonly maxJsonDepth?: number;
  /** Defaults to 1,000,000 expanded JSON values. */
  readonly maxJsonNodes?: number;
}

export interface SubAgentExecutionRequestWireValidationOptions {
  /** Defaults to the transport frame limit and measures canonical RFC 8785 bytes. */
  readonly maxCanonicalBytes?: number;
  /** Defaults to 128, where the root value has depth zero. */
  readonly maxJsonDepth?: number;
  /** Defaults to 1,000,000 expanded JSON values. */
  readonly maxJsonNodes?: number;
  /** Receiver-known Executor identity used to cross-check resume/reconnect bindings. */
  readonly expectedExecutorName?: string;
  /** Defaults to Core's 64 KiB Executor binding ceiling. */
  readonly maxBindingBytes?: number;
}

/** JSON-only form of the Executor operation union. The union remains closed at runtime. */
export type SubAgentExecutorOperationWire = SubAgentExecutorOperation;

/**
 * Cross-transport execution request. AbortSignal and absolute host time never cross the boundary;
 * the receiver reconstructs them from local control state and `remainingMs`.
 */
export type SubAgentExecutionRequestWire<I extends JsonValue = JsonValue> = Omit<
  SubAgentExecutionRequest<I>,
  'signal' | 'deadlineAt' | 'operation'
> & {
  readonly operation: SubAgentExecutorOperationWire;
  readonly remainingMs: number;
};

export interface CreateSubAgentExecutionRequestWireOptions extends SubAgentExecutionRequestWireValidationOptions {
  /** Local sender clock. Defaults to Date.now. */
  readonly now?: () => number;
}

export interface ReconstructSubAgentExecutionRequestOptions extends SubAgentExecutionRequestWireValidationOptions {
  /** Trusted receiver-local cancellation signal; it is never decoded from the wire. */
  readonly signal: AbortSignal;
  /** Local receiver clock. Defaults to Date.now. */
  readonly now?: () => number;
  /** Defaults to a chunked, overflow-safe Node timer and is injectable for deterministic tests/hosts. */
  readonly timeoutSignalFactory?: (remainingMs: number) => AbortSignal;
}

/** Receiver-local request plus deterministic timeout/listener cleanup after execution settles. */
export interface SubAgentExecutionRequestReconstruction<I extends JsonValue = JsonValue> {
  readonly request: SubAgentExecutionRequest<I>;
  /** Idempotent; releases receiver-local timers/listeners without changing the request outcome. */
  dispose(): void;
}

export interface SubAgentTransportSequenceTrackerOptions {
  /** Exact receipt window retained for replay detection before channel rollover is required. */
  readonly maxTrackedSequences?: number;
}

export type SubAgentTransportSequenceObservation =
  | {
      readonly status: 'accepted';
      readonly sequence: number;
      readonly payloadSha256: string;
    }
  | {
      readonly status: 'replay';
      readonly sequence: number;
      readonly originalSequence: number;
      readonly payloadSha256: string;
    };
