/** Stable, protocol-neutral failures emitted by the Subagent v2 runtime. */
export const SUBAGENT_ERROR_CODES = Object.freeze([
  'DEFINITION_NOT_FOUND',
  'DEFINITION_VERSION_MISMATCH',
  'INVALID_INPUT',
  'INVALID_OUTPUT',
  'OUTPUT_NOT_JSON_SAFE',
  'CONTEXT_PROJECTION_FAILED',
  'RESOURCE_NOT_FOUND',
  'STREAMING_UNSUPPORTED',
  'EXECUTOR_NOT_FOUND',
  'EXECUTOR_DISALLOWED',
  'EXECUTOR_UNAVAILABLE',
  'UNSUPPORTED_CAPABILITY',
  'BINDING_INVALID',
  'ADAPTER_STATE_VERSION_MISMATCH',
  'CHECKPOINT_VERSION_MISMATCH',
  'CHECKPOINT_MIGRATION_FAILED',
  'EVENT_BACKPRESSURE',
  'SESSION_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_STATE_TRANSITION',
  'RESULT_REQUIRED',
  'RESULT_ALREADY_SUBMITTED',
  'RESULT_REPLAY_CONFLICT',
  'RESULT_PHASE_CLOSED',
  'END_AGENT_MUST_BE_STANDALONE',
  'APPROVAL_REQUIRED',
  'APPROVAL_REJECTED',
  'APPROVAL_EXPIRED',
  'APPROVAL_CONFLICT',
  'CHILD_DEFINITION_DISALLOWED',
  'RECOVERY_UNSUPPORTED',
  'RECOVERY_TARGET_LOST',
  'LIMIT_EXCEEDED',
  'BUDGET_EXCEEDED',
  'TIMED_OUT',
  'CANCELLED',
  'EXECUTOR_FAILED',
  'INTERNAL_ERROR',
] as const);

export type SubAgentErrorCode = (typeof SUBAGENT_ERROR_CODES)[number];

/**
 * Deliberately small error envelope safe for persistence, events and provider Tool results.
 * Provider bodies, prompts, input/output, bindings, credentials and stack traces do not belong here.
 */
export interface SubAgentErrorDescriptor {
  readonly code: SubAgentErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly causeCode?: string;
  /** True when a provider request may have executed but its response could not be confirmed. */
  readonly outcomeUnknown?: boolean;
  /** Last durable task-local event sequence acknowledged by a failed subscriber. */
  readonly eventCursor?: number;
}

export const RESOURCE_NOT_FOUND_MESSAGE = 'The requested resource was not found.';

export const RESOURCE_NOT_FOUND_ERROR: Readonly<SubAgentErrorDescriptor> = Object.freeze({
  code: 'RESOURCE_NOT_FOUND',
  message: RESOURCE_NOT_FOUND_MESSAGE,
  retryable: false,
});

/** Runtime error for stable configuration, dispatch and control-plane failures. */
export class SubAgentRuntimeError extends Error {
  readonly descriptor: Readonly<SubAgentErrorDescriptor>;

  constructor(descriptor: SubAgentErrorDescriptor, options?: ErrorOptions) {
    super(descriptor.message, options);
    this.name = 'SubAgentRuntimeError';
    this.descriptor = Object.freeze({ ...descriptor });
  }

  get code(): SubAgentErrorCode {
    return this.descriptor.code;
  }

  get retryable(): boolean {
    return this.descriptor.retryable;
  }
}

/** Returns the non-enumerating public failure used for both unknown and cross-session resources. */
export function createResourceNotFoundError(): SubAgentRuntimeError {
  return new SubAgentRuntimeError(RESOURCE_NOT_FOUND_ERROR);
}
