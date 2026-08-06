import { isDeepStrictEqual, types as nodeTypes } from 'node:util';

import { parseAgentResultReceipt } from './agent-result-receipt';
import { assertArtifactReference } from './artifact';
import { DEFAULT_EXECUTOR_MAX_BINDING_BYTES, type SubAgentExecutionRequest } from './executor';
import {
  assertJsonValue,
  canonicalJsonSha256,
  canonicalizeJson,
  measureCanonicalJsonBytes,
  parseJsonValue,
  type JsonValue,
} from './json';
import { DEFAULT_SUBAGENT_IO_LIMITS, DEFAULT_SUBAGENT_PROJECTION_LIMITS } from './limits';
import { assertPendingBatchInvariants } from './pending-batch-invariants';
import {
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
  DEFAULT_SUBAGENT_TRANSPORT_SEQUENCE_WINDOW,
  SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES,
  SUBAGENT_TRANSPORT_MAX_KIND_BYTES,
  SUBAGENT_TRANSPORT_MAX_SEQUENCE_WINDOW,
  SUBAGENT_TRANSPORT_VERSION,
  SubAgentTransportError,
  type CreateSubAgentExecutionRequestWireOptions,
  type ReconstructSubAgentExecutionRequestOptions,
  type SubAgentExecutionRequestWire,
  type SubAgentExecutionRequestWireValidationOptions,
  type SubAgentTransportEnvelope,
  type SubAgentTransportErrorReason,
  type SubAgentTransportFrameOptions,
  type SubAgentTransportSequenceObservation,
  type SubAgentTransportSequenceTrackerOptions,
} from './transport';

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });
const TRANSPORT_KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_PROTOCOL_TOKEN_CHARACTERS = 64;
const MAX_REASON_BYTES = 4_096;
// Node timers overflow above 2^31 - 1 milliseconds. Longer transport deadlines are split into
// exact, non-overflowing chunks instead of being silently shortened by the host timer runtime.
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

const ENVELOPE_REQUIRED_KEYS = Object.freeze([
  'version',
  'channelId',
  'sequence',
  'messageId',
  'kind',
  'payload',
] as const);
const ENVELOPE_OPTIONAL_KEYS = Object.freeze(['correlationId', 'taskId', 'operationId'] as const);

type UnknownRecord = Record<string, unknown>;

interface ResolvedExecutionWireValidationOptions {
  readonly maxCanonicalBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly expectedExecutorName?: string;
  readonly maxBindingBytes: number;
}

/** Validates an in-memory transport envelope without serializing or invoking an Executor. */
export function assertSubAgentTransportEnvelope(
  value: unknown,
): asserts value is SubAgentTransportEnvelope {
  try {
    assertJsonValue(value);
  } catch (error) {
    throw transportError(
      'invalid-envelope',
      'Subagent transport envelope must be an RFC 8785-compatible JSON value.',
      error,
    );
  }

  const record = assertClosedRecord(
    value,
    'Subagent transport envelope',
    ENVELOPE_REQUIRED_KEYS,
    ENVELOPE_OPTIONAL_KEYS,
    'invalid-envelope',
  );
  if (record.version !== SUBAGENT_TRANSPORT_VERSION) {
    throw transportError(
      'unsupported-version',
      `Subagent transport envelope version must be ${JSON.stringify(SUBAGENT_TRANSPORT_VERSION)}.`,
    );
  }
  assertTransportIdentifier(record.channelId, 'channelId', 'invalid-identifier');
  assertPositiveSafeInteger(record.sequence, 'sequence', 'invalid-sequence');
  assertTransportIdentifier(record.messageId, 'messageId', 'invalid-identifier');
  for (const key of ['correlationId', 'taskId', 'operationId'] as const) {
    if (record[key] !== undefined) {
      assertTransportIdentifier(record[key], key, 'invalid-identifier');
    }
  }
  assertTransportKind(record.kind);
}

/** Serializes an envelope as canonical RFC 8785 JSON and enforces the UTF-8 frame limit. */
export function encodeSubAgentTransportFrame(
  envelope: unknown,
  options: SubAgentTransportFrameOptions = {},
): string {
  assertSubAgentTransportEnvelope(envelope);
  const frame = canonicalizeJson(envelope as unknown as JsonValue);
  assertFrameByteLimit(textEncoder.encode(frame).byteLength, resolveFrameLimit(options));
  return frame;
}

/** Byte-oriented counterpart used by transports that do not exchange JavaScript strings. */
export function encodeSubAgentTransportFrameBytes(
  envelope: unknown,
  options: SubAgentTransportFrameOptions = {},
): Uint8Array {
  return textEncoder.encode(encodeSubAgentTransportFrame(envelope, options));
}

/**
 * Decodes one UTF-8 JSON frame. The raw frame is bounded before parsing, duplicate keys and invalid
 * Unicode are rejected by the strict JSON parser, and the envelope is then closed-shape validated.
 */
export function decodeSubAgentTransportFrame(
  frame: string | Uint8Array,
  options: SubAgentTransportFrameOptions = {},
): SubAgentTransportEnvelope {
  const maxFrameBytes = resolveFrameLimit(options);
  let source: string;

  if (typeof frame === 'string') {
    assertFrameByteLimit(textEncoder.encode(frame).byteLength, maxFrameBytes);
    source = frame;
  } else if (frame instanceof Uint8Array) {
    assertFrameByteLimit(frame.byteLength, maxFrameBytes);
    try {
      source = fatalTextDecoder.decode(frame);
    } catch (error) {
      throw transportError('invalid-frame', 'Subagent transport frame is not valid UTF-8.', error);
    }
  } else {
    throw transportError(
      'invalid-frame',
      'Subagent transport frame must be a string or Uint8Array.',
    );
  }

  let value: JsonValue;
  try {
    value = parseJsonValue(source);
  } catch (error) {
    throw transportError(
      'invalid-frame',
      'Subagent transport frame must contain strict RFC 8785-compatible JSON.',
      error,
    );
  }
  assertSubAgentTransportEnvelope(value);
  return deepFreezeJson(value) as unknown as SubAgentTransportEnvelope;
}

/** Canonical SHA-256 of the payload only, used for message replay identity. */
export function subAgentTransportPayloadSha256(payload: unknown): string {
  try {
    assertJsonValue(payload);
  } catch (error) {
    throw transportError(
      'invalid-envelope',
      'Subagent transport payload must be an RFC 8785-compatible JSON value.',
      error,
    );
  }
  return canonicalJsonSha256(payload);
}

/** Canonical SHA-256 of the complete closed envelope. */
export function subAgentTransportEnvelopeSha256(envelope: unknown): string {
  assertSubAgentTransportEnvelope(envelope);
  return canonicalJsonSha256(envelope as unknown as JsonValue);
}

/**
 * Creates the explicit transport form without spreading the source request. This is the security
 * boundary that strips AbortSignal, absolute time and any accidental host-only properties.
 */
export function createSubAgentExecutionRequestWire<I extends JsonValue>(
  request: SubAgentExecutionRequest<I>,
  options: CreateSubAgentExecutionRequestWireOptions = {},
): SubAgentExecutionRequestWire<I> {
  const now = readLocalNow(options.now);
  if (!Number.isSafeInteger(request.deadlineAt)) {
    throw transportError(
      'invalid-execution-request',
      'Subagent execution request deadlineAt must be a safe integer.',
    );
  }
  const remainingMs = Math.floor(request.deadlineAt - now);
  if (remainingMs < 1) {
    throw transportError('deadline-expired', 'Subagent execution request deadline has expired.');
  }

  const wire = {
    operation: request.operation,
    ownerSessionId: request.ownerSessionId,
    runId: request.runId,
    taskId: request.taskId,
    ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
    subagentSessionId: request.subagentSessionId,
    path: request.path,
    attempt: request.attempt,
    executionEpoch: request.executionEpoch,
    executionFencingToken: request.executionFencingToken,
    ...(request.retryOf === undefined ? {} : { retryOf: request.retryOf }),
    definition: request.definition,
    input: request.input,
    projectedContext: request.projectedContext,
    delegation: request.delegation,
    limits: request.limits,
    remainingMs,
  } satisfies SubAgentExecutionRequestWire<I>;

  return decodeSubAgentExecutionRequestWire(wire, options) as SubAgentExecutionRequestWire<I>;
}

/** Strictly validates the complete protocol-defined execution request wire. */
export function assertSubAgentExecutionRequestWire(
  value: unknown,
  options: SubAgentExecutionRequestWireValidationOptions = {},
): asserts value is SubAgentExecutionRequestWire {
  const resolved = resolveExecutionWireValidationOptions(options);
  try {
    assertJsonComplexity(value, resolved.maxJsonDepth, resolved.maxJsonNodes);
    assertJsonValue(value, {
      maxBytes: resolved.maxCanonicalBytes,
      label: 'Subagent execution request wire',
    });
    assertExecutionRequestWireShape(value, resolved);
  } catch (error) {
    if (error instanceof SubAgentTransportError) throw error;
    throw transportError(
      'invalid-execution-request',
      'Subagent execution request wire is invalid.',
      error,
    );
  }
}

/** Validates and canonical-clones an untrusted execution request payload. */
export function decodeSubAgentExecutionRequestWire(
  value: unknown,
  options: SubAgentExecutionRequestWireValidationOptions = {},
): SubAgentExecutionRequestWire {
  assertSubAgentExecutionRequestWire(value, options);
  const cloned = parseJsonValue(canonicalizeJson(value as unknown as JsonValue));
  assertSubAgentExecutionRequestWire(cloned, options);
  return deepFreezeJson(cloned) as unknown as SubAgentExecutionRequestWire;
}

/** Reconstructs host-only control fields from receiver-local state and time. */
export function reconstructSubAgentExecutionRequest<I extends JsonValue = JsonValue>(
  value: SubAgentExecutionRequestWire<I> | unknown,
  options: ReconstructSubAgentExecutionRequestOptions,
): SubAgentExecutionRequest<I> {
  const wire = decodeSubAgentExecutionRequestWire(
    value,
    options,
  ) as SubAgentExecutionRequestWire<I>;
  if (!(options.signal instanceof AbortSignal)) {
    throw transportError(
      'invalid-execution-request',
      'Subagent execution reconstruction requires a receiver-local AbortSignal.',
    );
  }
  const now = readLocalNow(options.now);
  const deadlineAt = now + wire.remainingMs;
  if (!Number.isSafeInteger(deadlineAt)) {
    throw transportError(
      'invalid-execution-request',
      'Subagent execution request local deadline exceeds the safe integer range.',
    );
  }

  let timeoutSignal: AbortSignal;
  let disposeTimeout: (() => void) | undefined;
  try {
    if (options.timeoutSignalFactory === undefined) {
      const timeout = createChunkedTimeoutSignal(wire.remainingMs);
      timeoutSignal = timeout.signal;
      disposeTimeout = timeout.dispose;
    } else {
      timeoutSignal = options.timeoutSignalFactory(wire.remainingMs);
    }
  } catch (error) {
    throw transportError(
      'invalid-execution-request',
      'Subagent execution timeout signal factory failed.',
      error,
    );
  }
  if (!(timeoutSignal instanceof AbortSignal)) {
    disposeTimeout?.();
    throw transportError(
      'invalid-execution-request',
      'Subagent execution timeout signal factory must return an AbortSignal.',
    );
  }
  let signal: AbortSignal;
  try {
    signal = AbortSignal.any([options.signal, timeoutSignal]);
  } catch (error) {
    disposeTimeout?.();
    throw transportError(
      'invalid-execution-request',
      'Subagent execution cancellation signals could not be combined.',
      error,
    );
  }
  if (disposeTimeout !== undefined) {
    if (signal.aborted) {
      disposeTimeout();
    } else {
      signal.addEventListener('abort', disposeTimeout, { once: true });
    }
  }

  return Object.freeze({
    operation: wire.operation,
    ownerSessionId: wire.ownerSessionId,
    runId: wire.runId,
    taskId: wire.taskId,
    ...(wire.parentTaskId === undefined ? {} : { parentTaskId: wire.parentTaskId }),
    subagentSessionId: wire.subagentSessionId,
    path: wire.path,
    attempt: wire.attempt,
    executionEpoch: wire.executionEpoch,
    executionFencingToken: wire.executionFencingToken,
    ...(wire.retryOf === undefined ? {} : { retryOf: wire.retryOf }),
    definition: wire.definition,
    input: wire.input,
    projectedContext: wire.projectedContext,
    delegation: wire.delegation,
    limits: wire.limits,
    signal,
    deadlineAt,
  });
}

/**
 * Per-channel, per-direction sequence and replay validator. Callers retain cached replies; this
 * class only determines whether a frame is new, an exact replay, a gap or a conflict.
 */
export class SubAgentTransportSequenceTracker {
  readonly #channelId: string;
  readonly #maxTrackedSequences: number;
  readonly #messages = new Map<
    string,
    {
      readonly sequence: number;
      readonly payloadSha256: string;
      readonly replayIdentitySha256: string;
    }
  >();
  readonly #sequences = new Map<
    number,
    { readonly messageId: string; readonly replayIdentitySha256: string }
  >();
  #nextSequence = 1;

  constructor(channelId: string, options: SubAgentTransportSequenceTrackerOptions = {}) {
    assertTransportIdentifier(channelId, 'channelId', 'invalid-identifier');
    this.#channelId = channelId;
    this.#maxTrackedSequences = resolveSequenceWindow(options.maxTrackedSequences);
  }

  get nextSequence(): number {
    return this.#nextSequence;
  }

  observe(envelope: unknown): SubAgentTransportSequenceObservation {
    assertSubAgentTransportEnvelope(envelope);
    if (envelope.channelId !== this.#channelId) {
      throw transportError(
        'invalid-identifier',
        'Subagent transport sequence tracker cannot mix channel identifiers.',
      );
    }

    const payloadSha256 = subAgentTransportPayloadSha256(envelope.payload);
    const replayIdentitySha256 = transportReplayIdentitySha256(envelope);
    const previous = this.#messages.get(envelope.messageId);
    if (previous !== undefined) {
      if (
        previous.payloadSha256 !== payloadSha256 ||
        previous.replayIdentitySha256 !== replayIdentitySha256
      ) {
        throw transportError(
          'message-replay-conflict',
          'Subagent transport messageId was replayed with a different canonical payload or routing identity.',
        );
      }
      if (envelope.sequence > this.#nextSequence) {
        throwSequenceGap(this.#nextSequence, envelope.sequence);
      }
      const sequenceRecord = this.#sequences.get(envelope.sequence);
      if (
        sequenceRecord !== undefined &&
        (sequenceRecord.messageId !== envelope.messageId ||
          sequenceRecord.replayIdentitySha256 !== replayIdentitySha256)
      ) {
        throw transportError(
          'message-replay-conflict',
          'Subagent transport sequence was already assigned to a different message identity.',
        );
      }
      if (envelope.sequence === this.#nextSequence) {
        this.#assertWindowAvailable();
        this.#sequences.set(
          envelope.sequence,
          Object.freeze({ messageId: envelope.messageId, replayIdentitySha256 }),
        );
        this.#nextSequence += 1;
      }
      return Object.freeze({
        status: 'replay' as const,
        sequence: envelope.sequence,
        originalSequence: previous.sequence,
        payloadSha256,
      });
    }

    if (envelope.sequence > this.#nextSequence) {
      throwSequenceGap(this.#nextSequence, envelope.sequence);
    }
    if (envelope.sequence < this.#nextSequence) {
      throw transportError(
        'sequence-replay-unknown',
        `Subagent transport sequence ${envelope.sequence} cannot be replayed with an unknown messageId.`,
      );
    }

    this.#assertWindowAvailable();

    this.#messages.set(
      envelope.messageId,
      Object.freeze({ sequence: envelope.sequence, payloadSha256, replayIdentitySha256 }),
    );
    this.#sequences.set(
      envelope.sequence,
      Object.freeze({ messageId: envelope.messageId, replayIdentitySha256 }),
    );
    this.#nextSequence += 1;
    return Object.freeze({
      status: 'accepted' as const,
      sequence: envelope.sequence,
      payloadSha256,
    });
  }

  #assertWindowAvailable(): void {
    if (this.#sequences.size < this.#maxTrackedSequences) return;
    throw transportError(
      'sequence-window-exhausted',
      `Subagent transport channel reached its ${this.#maxTrackedSequences}-sequence replay window; channel rollover is required.`,
    );
  }
}

function transportReplayIdentitySha256(envelope: SubAgentTransportEnvelope): string {
  const identity = {
    channelId: envelope.channelId,
    messageId: envelope.messageId,
    ...(envelope.correlationId === undefined ? {} : { correlationId: envelope.correlationId }),
    ...(envelope.taskId === undefined ? {} : { taskId: envelope.taskId }),
    ...(envelope.operationId === undefined ? {} : { operationId: envelope.operationId }),
    kind: envelope.kind,
    payload: envelope.payload,
  };
  return canonicalJsonSha256(identity);
}

function assertExecutionRequestWireShape(
  value: unknown,
  options: ResolvedExecutionWireValidationOptions,
): void {
  const record = assertClosedRecord(
    value,
    'Subagent execution request wire',
    [
      'operation',
      'ownerSessionId',
      'runId',
      'taskId',
      'subagentSessionId',
      'path',
      'attempt',
      'executionEpoch',
      'executionFencingToken',
      'definition',
      'input',
      'projectedContext',
      'delegation',
      'limits',
      'remainingMs',
    ],
    ['parentTaskId', 'retryOf'],
    'invalid-execution-request',
  );

  for (const key of [
    'ownerSessionId',
    'runId',
    'taskId',
    'subagentSessionId',
    'executionEpoch',
    'executionFencingToken',
  ] as const) {
    assertTransportIdentifier(record[key], key, 'invalid-execution-request');
  }
  for (const key of ['parentTaskId', 'retryOf'] as const) {
    if (record[key] !== undefined) {
      assertTransportIdentifier(record[key], key, 'invalid-execution-request');
    }
  }

  const path = assertIdentifierArray(record.path, 'path');
  assertPositiveSafeInteger(record.attempt, 'attempt', 'invalid-execution-request');
  const definition = assertDefinitionRef(record.definition, 'definition');
  assertJsonValue(record.input, {
    maxBytes: DEFAULT_SUBAGENT_IO_LIMITS.maxInputBytes,
    label: 'Subagent execution input',
  });
  assertProjectedContext(record.projectedContext);
  const delegation = assertDelegationSnapshot(record.delegation);
  const limits = assertResolvedLimits(record.limits);
  assertPositiveSafeInteger(record.remainingMs, 'remainingMs', 'invalid-execution-request');
  if ((record.remainingMs as number) > limits.timeoutMs) {
    throw transportError(
      'invalid-execution-request',
      'Subagent execution remainingMs exceeds the resolved timeoutMs limit.',
    );
  }

  if (path.length !== delegation.depth || !sameStringArray(path, delegation.path)) {
    throw transportError(
      'invalid-execution-request',
      'Subagent execution path must match the delegation snapshot depth and path.',
    );
  }
  if (delegation.depth > limits.maxDepth) {
    throw transportError(
      'invalid-execution-request',
      'Subagent execution delegation depth exceeds the resolved maxDepth limit.',
    );
  }
  if (path.at(-1) !== record.taskId) {
    throw transportError(
      'invalid-execution-request',
      'Subagent execution path must end with its taskId.',
    );
  }
  if (
    (record.parentTaskId === undefined && path.length !== 1) ||
    (record.parentTaskId !== undefined && (path.length < 2 || path.at(-2) !== record.parentTaskId))
  ) {
    throw transportError(
      'invalid-execution-request',
      'Subagent execution parentTaskId must identify the immediately preceding path task.',
    );
  }
  if (
    delegation.ownerSessionId !== record.ownerSessionId ||
    delegation.runId !== record.runId ||
    delegation.parentTaskId !== record.taskId
  ) {
    throw transportError(
      'invalid-execution-request',
      'Subagent execution delegation ownership does not match the request.',
    );
  }

  const operation = assertExecutorOperation(record.operation, options);
  if (operation.type !== 'create') {
    const binding = operation.binding;
    if (
      binding.ownerSessionId !== record.ownerSessionId ||
      binding.taskId !== record.taskId ||
      binding.subagentSessionId !== record.subagentSessionId ||
      binding.definitionName !== definition.name ||
      binding.definitionVersion !== definition.version
    ) {
      throw transportError(
        'invalid-execution-request',
        'Subagent Executor binding identity does not match the execution request.',
      );
    }
    if (
      operation.type === 'resume' &&
      (operation.checkpoint.runnerId !== binding.runnerId ||
        operation.checkpoint.runnerVersion !== binding.runnerVersion)
    ) {
      throw transportError(
        'invalid-execution-request',
        'Subagent child checkpoint runner identity does not match the Executor binding.',
      );
    }
  }
}

function assertExecutorOperation(
  value: unknown,
  options: ResolvedExecutionWireValidationOptions,
):
  | { readonly type: 'create' }
  | {
      readonly type: 'resume';
      readonly binding: ReturnType<typeof assertExecutorBinding>;
      readonly checkpoint: ReturnType<typeof assertChildCheckpoint>;
    }
  | { readonly type: 'reconnect'; readonly binding: ReturnType<typeof assertExecutorBinding> } {
  const base = assertObject(value, 'operation', 'invalid-execution-request');
  const type = base.type;

  if (type === 'create') {
    const record = assertClosedRecord(
      value,
      'Subagent create operation',
      ['type', 'operationId', 'idempotencyKey'],
      [],
      'invalid-execution-request',
    );
    assertTransportIdentifier(
      record.operationId,
      'operation.operationId',
      'invalid-execution-request',
    );
    assertTransportIdentifier(
      record.idempotencyKey,
      'operation.idempotencyKey',
      'invalid-execution-request',
    );
    return { type };
  }

  if (type === 'resume') {
    if (base.reason === 'approval') {
      const record = assertClosedRecord(
        value,
        'Subagent approval resume operation',
        ['type', 'operationId', 'reason', 'binding', 'checkpoint', 'approvals'],
        [],
        'invalid-execution-request',
      );
      assertTransportIdentifier(
        record.operationId,
        'operation.operationId',
        'invalid-execution-request',
      );
      const binding = assertExecutorBinding(record.binding, options);
      const checkpoint = assertChildCheckpoint(record.checkpoint);
      const approvalDecisionIds = assertApprovalDecisions(record.approvals);
      if (approvalDecisionIds.length === 0) {
        invalidExecution('An approval resume requires at least one current approval decision.');
      }
      assertValidatedPendingBatchInvariants(checkpoint.pendingBatch, {
        approvalDecisionIds,
      });
      return { type, binding, checkpoint };
    }
    if (base.reason === 'checkpoint') {
      const record = assertClosedRecord(
        value,
        'Subagent checkpoint resume operation',
        ['type', 'operationId', 'reason', 'binding', 'checkpoint'],
        [],
        'invalid-execution-request',
      );
      assertTransportIdentifier(
        record.operationId,
        'operation.operationId',
        'invalid-execution-request',
      );
      const binding = assertExecutorBinding(record.binding, options);
      const checkpoint = assertChildCheckpoint(record.checkpoint);
      return { type, binding, checkpoint };
    }
    throw transportError(
      'invalid-execution-request',
      'Subagent resume operation reason must be "approval" or "checkpoint".',
    );
  }

  if (type === 'reconnect') {
    const record = assertClosedRecord(
      value,
      'Subagent reconnect operation',
      ['type', 'operationId', 'binding'],
      [],
      'invalid-execution-request',
    );
    assertTransportIdentifier(
      record.operationId,
      'operation.operationId',
      'invalid-execution-request',
    );
    return { type, binding: assertExecutorBinding(record.binding, options) };
  }

  throw transportError(
    'invalid-execution-request',
    'Subagent Executor operation type must be "create", "resume" or "reconnect".',
  );
}

function assertExecutorBinding(value: unknown, options: ResolvedExecutionWireValidationOptions) {
  const record = assertClosedRecord(
    value,
    'Subagent Executor binding',
    [
      'version',
      'executorName',
      'ownerSessionId',
      'taskId',
      'subagentSessionId',
      'definitionName',
      'definitionVersion',
      'runnerId',
      'runnerVersion',
      'adapterStateVersion',
      'recoveryData',
    ],
    [],
    'invalid-execution-request',
  );
  assertVersionOne(record.version, 'Executor binding');
  assertProtocolName(record.executorName, 'binding.executorName', NAME_PATTERN);
  for (const key of ['ownerSessionId', 'taskId', 'subagentSessionId'] as const) {
    assertTransportIdentifier(record[key], `binding.${key}`, 'invalid-execution-request');
  }
  assertProtocolName(record.definitionName, 'binding.definitionName', NAME_PATTERN);
  assertProtocolName(record.definitionVersion, 'binding.definitionVersion', VERSION_PATTERN);
  assertProtocolName(record.runnerId, 'binding.runnerId', NAME_PATTERN);
  assertProtocolName(record.runnerVersion, 'binding.runnerVersion', VERSION_PATTERN);
  assertProtocolName(record.adapterStateVersion, 'binding.adapterStateVersion', VERSION_PATTERN);
  if (measureCanonicalJsonBytes(record as JsonValue) > options.maxBindingBytes) {
    invalidExecution('Subagent Executor binding exceeds the configured binding byte limit.');
  }
  if (
    options.expectedExecutorName !== undefined &&
    record.executorName !== options.expectedExecutorName
  ) {
    invalidExecution('Subagent Executor binding does not match the receiver Executor identity.');
  }
  return record as unknown as {
    readonly executorName: string;
    readonly ownerSessionId: string;
    readonly taskId: string;
    readonly subagentSessionId: string;
    readonly definitionName: string;
    readonly definitionVersion: string;
    readonly runnerId: string;
    readonly runnerVersion: string;
  };
}

function assertApprovalDecisions(value: unknown): readonly string[] {
  const decisions = assertArray(value, 'operation.approvals', 'invalid-execution-request');
  const approvalIds = new Set<string>();
  for (const [index, item] of decisions.entries()) {
    const record = assertClosedRecord(
      item,
      `operation.approvals[${index}]`,
      ['approvalId', 'decision', 'expectedRevision'],
      ['reason'],
      'invalid-execution-request',
    );
    assertTransportIdentifier(
      record.approvalId,
      `operation.approvals[${index}].approvalId`,
      'invalid-execution-request',
    );
    if (approvalIds.has(record.approvalId as string)) {
      throw transportError(
        'invalid-execution-request',
        'Subagent approval decisions must not repeat approvalId.',
      );
    }
    approvalIds.add(record.approvalId as string);
    if (record.decision !== 'approved' && record.decision !== 'rejected') {
      throw transportError(
        'invalid-execution-request',
        'Subagent approval decision must be "approved" or "rejected".',
      );
    }
    assertNonnegativeSafeInteger(
      record.expectedRevision,
      `operation.approvals[${index}].expectedRevision`,
    );
    if (record.reason !== undefined) {
      assertBoundedText(
        record.reason,
        `operation.approvals[${index}].reason`,
        MAX_REASON_BYTES,
        true,
      );
    }
  }
  return Object.freeze([...approvalIds]);
}

function assertChildCheckpoint(value: unknown) {
  const record = assertClosedRecord(
    value,
    'Subagent child checkpoint',
    [
      'version',
      'runnerId',
      'runnerVersion',
      'protocolContext',
      'contextStore',
      'modelIteration',
      'maxIterations',
    ],
    ['modelOperation', 'pendingBatch', 'compactTransaction', 'resultSubmission'],
    'invalid-execution-request',
  );
  assertVersionOne(record.version, 'child checkpoint');
  assertProtocolName(record.runnerId, 'checkpoint.runnerId', NAME_PATTERN);
  assertProtocolName(record.runnerVersion, 'checkpoint.runnerVersion', VERSION_PATTERN);
  const protocol = assertEncodedProtocolCheckpoint(
    record.protocolContext,
    'checkpoint.protocolContext',
  );
  const context = assertContextStoreCheckpoint(record.contextStore);
  if (context.protocol !== protocol.protocol || context.codecVersion !== protocol.codecVersion) {
    invalidExecution('Child checkpoint protocol and context identities must match exactly.');
  }
  assertNonnegativeSafeInteger(record.modelIteration, 'checkpoint.modelIteration');
  if (record.maxIterations !== null) {
    assertPositiveSafeInteger(
      record.maxIterations,
      'checkpoint.maxIterations',
      'invalid-execution-request',
    );
    if ((record.modelIteration as number) > (record.maxIterations as number)) {
      invalidExecution('checkpoint.modelIteration cannot exceed maxIterations.');
    }
  }
  if (record.modelOperation !== undefined) {
    assertDurableModelOperation(record.modelOperation, record.modelIteration as number, protocol);
    if (record.pendingBatch !== undefined) {
      invalidExecution(
        'A child checkpoint cannot retain a Model operation and pending batch together.',
      );
    }
  }
  const pending =
    record.pendingBatch === undefined
      ? undefined
      : assertPendingBatch(record.pendingBatch, protocol);
  if (record.compactTransaction !== undefined) {
    assertCompactTransaction(record.compactTransaction);
  }
  let submission: ValidatedResultSubmission | undefined;
  if (record.resultSubmission !== undefined) {
    const result = assertClosedRecord(
      record.resultSubmission,
      'checkpoint.resultSubmission',
      ['version', 'callId', 'output', 'outputHash'],
      [],
      'invalid-execution-request',
    );
    assertVersionOne(result.version, 'checkpoint result submission');
    assertTransportIdentifier(
      result.callId,
      'checkpoint.resultSubmission.callId',
      'invalid-execution-request',
    );
    assertSha256(result.outputHash, 'checkpoint.resultSubmission.outputHash');
    assertJsonValue(result.output, {
      maxBytes: DEFAULT_SUBAGENT_IO_LIMITS.maxOutputBytes,
      label: 'Child result submission output',
    });
    if (canonicalJsonSha256(result.output as JsonValue) !== result.outputHash) {
      invalidExecution('checkpoint.resultSubmission.outputHash does not match output.');
    }
    submission = result as unknown as ValidatedResultSubmission;
  }
  assertValidatedPendingBatchInvariants(pending, {
    requireResultSubmissionForEnd: true,
    requireResultSubmissionForCompletedAgentResult: true,
    resultSubmissionPresent: submission !== undefined,
  });
  if (submission !== undefined && pending !== undefined) {
    assertResultSubmissionPendingBatchLink(submission, pending);
  }
  return Object.freeze({
    runnerId: record.runnerId as string,
    runnerVersion: record.runnerVersion as string,
    ...(pending === undefined ? {} : { pendingBatch: pending }),
  });
}

interface ProtocolIdentity {
  readonly protocol: string;
  readonly codecVersion: string;
}

interface EncodedProtocolIdentity extends ProtocolIdentity {
  readonly value: JsonValue;
}

interface ValidatedPendingCall {
  readonly kind: 'tool' | 'agent' | 'end-agent';
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly inputHash: string;
  readonly order: number;
  readonly status:
    | 'prepared'
    | 'in_flight'
    | 'waiting_approval'
    | 'result_ready'
    | 'result_submitted'
    | 'applied';
  readonly result?: JsonValue;
  readonly taskId?: string;
  readonly approvals?: readonly string[];
}

interface ValidatedPendingBatch {
  readonly calls: readonly ValidatedPendingCall[];
  readonly endRequested: boolean;
}

interface ValidatedResultSubmission {
  readonly callId: string;
  readonly output: JsonValue;
  readonly outputHash: string;
}

function assertEncodedProtocolCheckpoint(value: unknown, label: string): EncodedProtocolIdentity {
  const record = assertClosedRecord(
    value,
    label,
    ['protocol', 'codecVersion', 'value'],
    [],
    'invalid-execution-request',
  );
  assertProtocolName(record.protocol, `${label}.protocol`, NAME_PATTERN);
  assertProtocolName(record.codecVersion, `${label}.codecVersion`, VERSION_PATTERN);
  return record as unknown as EncodedProtocolIdentity;
}

function assertDurableModelOperation(
  value: unknown,
  modelIteration: number,
  protocol: ProtocolIdentity,
): void {
  const record = assertClosedRecord(
    value,
    'checkpoint.modelOperation',
    [
      'version',
      'operationId',
      'iteration',
      'purpose',
      'requestHash',
      'phase',
      'preparedAt',
      'updatedAt',
    ],
    ['result'],
    'invalid-execution-request',
  );
  assertVersionOne(record.version, 'checkpoint model operation');
  assertTransportIdentifier(
    record.operationId,
    'checkpoint.modelOperation.operationId',
    'invalid-execution-request',
  );
  assertNonnegativeSafeInteger(record.iteration, 'checkpoint.modelOperation.iteration');
  if (record.iteration !== modelIteration) {
    invalidExecution('checkpoint.modelOperation.iteration must equal modelIteration.');
  }
  if (record.purpose !== 'agent' && record.purpose !== 'context-summary') {
    invalidExecution('checkpoint.modelOperation.purpose is invalid.');
  }
  if (!['prepared', 'in_flight', 'result_ready'].includes(record.phase as string)) {
    invalidExecution('checkpoint.modelOperation.phase is invalid.');
  }
  assertSha256(record.requestHash, 'checkpoint.modelOperation.requestHash');
  assertNonnegativeSafeInteger(record.preparedAt, 'checkpoint.modelOperation.preparedAt');
  assertNonnegativeSafeInteger(record.updatedAt, 'checkpoint.modelOperation.updatedAt');
  if ((record.updatedAt as number) < (record.preparedAt as number)) {
    invalidExecution('checkpoint.modelOperation.updatedAt cannot precede preparedAt.');
  }
  if (record.phase === 'result_ready') {
    if (record.result === undefined) {
      invalidExecution('A result-ready child Model operation requires a result checkpoint.');
    }
    const result = assertEncodedProtocolCheckpoint(
      record.result,
      'checkpoint.modelOperation.result',
    );
    if (result.protocol !== protocol.protocol || result.codecVersion !== protocol.codecVersion) {
      invalidExecution('Child Model result protocol identity must match the child checkpoint.');
    }
  } else if (record.result !== undefined) {
    invalidExecution('Only a result-ready child Model operation may retain a result checkpoint.');
  }
}

function assertPendingBatch(value: unknown, protocol: ProtocolIdentity): ValidatedPendingBatch {
  const record = assertClosedRecord(
    value,
    'checkpoint.pendingBatch',
    ['version', 'batchId', 'assistantMessage', 'calls', 'endRequested', 'createdAt'],
    [],
    'invalid-execution-request',
  );
  assertVersionOne(record.version, 'checkpoint pending batch');
  assertTransportIdentifier(
    record.batchId,
    'checkpoint.pendingBatch.batchId',
    'invalid-execution-request',
  );
  const assistantMessage = assertEncodedProtocolCheckpoint(
    record.assistantMessage,
    'checkpoint.pendingBatch.assistantMessage',
  );
  if (
    assistantMessage.protocol !== protocol.protocol ||
    assistantMessage.codecVersion !== protocol.codecVersion
  ) {
    invalidExecution('Child pending batch assistant protocol identity must match the checkpoint.');
  }
  assertBoolean(record.endRequested, 'checkpoint.pendingBatch.endRequested');
  assertNonnegativeSafeInteger(record.createdAt, 'checkpoint.pendingBatch.createdAt');
  const calls = assertArray(
    record.calls,
    'checkpoint.pendingBatch.calls',
    'invalid-execution-request',
  );
  const operationIds = new Set<string>();
  const callIds = new Set<string>();
  const validatedCalls: ValidatedPendingCall[] = [];
  for (const [index, item] of calls.entries()) {
    const call = assertClosedRecord(
      item,
      `checkpoint.pendingBatch.calls[${index}]`,
      ['version', 'operationId', 'kind', 'callId', 'name', 'input', 'inputHash', 'status', 'order'],
      ['taskId', 'approvals', 'result'],
      'invalid-execution-request',
    );
    assertVersionOne(call.version, 'checkpoint child operation');
    assertTransportIdentifier(
      call.operationId,
      `checkpoint.pendingBatch.calls[${index}].operationId`,
      'invalid-execution-request',
    );
    if (operationIds.has(call.operationId as string)) {
      invalidExecution('checkpoint.pendingBatch operationId values must be unique.');
    }
    operationIds.add(call.operationId as string);
    if (!['tool', 'agent', 'end-agent'].includes(call.kind as string)) {
      invalidExecution(`checkpoint.pendingBatch.calls[${index}].kind is invalid.`);
    }
    assertTransportIdentifier(
      call.callId,
      `checkpoint.pendingBatch.calls[${index}].callId`,
      'invalid-execution-request',
    );
    if (callIds.has(call.callId as string)) {
      invalidExecution('checkpoint.pendingBatch callId values must be unique.');
    }
    callIds.add(call.callId as string);
    assertProtocolName(call.name, `checkpoint.pendingBatch.calls[${index}].name`, NAME_PATTERN);
    assertSha256(call.inputHash, `checkpoint.pendingBatch.calls[${index}].inputHash`);
    if (canonicalJsonSha256(call.input as JsonValue) !== call.inputHash) {
      invalidExecution(`checkpoint.pendingBatch.calls[${index}].inputHash does not match input.`);
    }
    if (
      ![
        'prepared',
        'in_flight',
        'waiting_approval',
        'result_ready',
        'result_submitted',
        'applied',
      ].includes(call.status as string)
    ) {
      invalidExecution(`checkpoint.pendingBatch.calls[${index}].status is invalid.`);
    }
    assertNonnegativeSafeInteger(call.order, `checkpoint.pendingBatch.calls[${index}].order`);
    if (call.order !== index) {
      invalidExecution(`checkpoint.pendingBatch.calls[${index}].order must equal its array index.`);
    }
    if (call.taskId !== undefined) {
      assertTransportIdentifier(
        call.taskId,
        `checkpoint.pendingBatch.calls[${index}].taskId`,
        'invalid-execution-request',
      );
    }
    const approvals =
      call.approvals === undefined
        ? []
        : assertIdentifierArray(
            call.approvals,
            `checkpoint.pendingBatch.calls[${index}].approvals`,
          );
    if (new Set(approvals).size !== approvals.length) {
      invalidExecution(`checkpoint.pendingBatch.calls[${index}].approvals must be unique.`);
    }
    const status = call.status as ValidatedPendingCall['status'];
    const resultRequired = ['result_ready', 'result_submitted', 'applied'].includes(status);
    if (
      (status === 'waiting_approval' && approvals.length === 0) ||
      (status !== 'waiting_approval' && approvals.length > 0) ||
      (resultRequired && call.result === undefined) ||
      (!resultRequired && call.result !== undefined)
    ) {
      invalidExecution(
        `checkpoint.pendingBatch.calls[${index}] has inconsistent approval/result state.`,
      );
    }
    if (
      (call.kind === 'agent') !== (call.name === 'agent') ||
      (call.kind === 'end-agent') !== (call.name === 'end-agent')
    ) {
      invalidExecution(`checkpoint.pendingBatch.calls[${index}] kind/name identity is invalid.`);
    }
    if (
      call.kind === 'agent' &&
      (status === 'in_flight' || status === 'waiting_approval') &&
      call.taskId === undefined
    ) {
      invalidExecution(
        `checkpoint.pendingBatch.calls[${index}] active agent call requires taskId.`,
      );
    }
    validatedCalls.push(call as unknown as ValidatedPendingCall);
  }
  return Object.freeze({
    calls: Object.freeze(validatedCalls),
    endRequested: record.endRequested as boolean,
  });
}

function assertValidatedPendingBatchInvariants(
  pending: ValidatedPendingBatch | undefined,
  options: {
    readonly requireResultSubmissionForEnd?: boolean;
    readonly requireResultSubmissionForCompletedAgentResult?: boolean;
    readonly resultSubmissionPresent?: boolean;
    readonly approvalDecisionIds?: readonly string[];
  } = {},
): void {
  if (pending === undefined) {
    if ((options.approvalDecisionIds?.length ?? 0) > 0) {
      invalidExecution('An approval resume decision requires a pending paused Tool call.');
    }
    return;
  }
  assertPendingBatchInvariants(
    {
      calls: Object.freeze(
        pending.calls.map((call) =>
          Object.freeze({
            kind: call.kind,
            name: call.name,
            status: call.status,
            order: call.order,
            ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
            approvalIds: Object.freeze([...(call.approvals ?? [])]),
            ...(call.result === undefined ? {} : { result: call.result }),
          }),
        ),
      ),
      endRequested: pending.endRequested,
      ...options,
    },
    invalidExecution,
  );
}

function assertResultSubmissionPendingBatchLink(
  submission: ValidatedResultSubmission,
  pending: ValidatedPendingBatch,
): void {
  const resultCalls = pending.calls.filter((call) => call.name === 'agent-result');
  const call = resultCalls[0];
  if (resultCalls.length === 0) {
    const endCall = pending.calls[0];
    if (
      pending.calls.length === 1 &&
      endCall?.kind === 'end-agent' &&
      endCall.name === 'end-agent' &&
      ['prepared', 'in_flight', 'result_ready', 'applied'].includes(endCall.status)
    ) {
      return;
    }
    invalidExecution(
      'After result submission, only the matching agent-result or standalone end-agent batch is valid.',
    );
  }

  const input = call?.input;
  const inputRecord =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as { readonly [key: string]: JsonValue })
      : undefined;
  const expectedInput: JsonValue = { result: submission.output };
  if (
    resultCalls.length !== 1 ||
    call === undefined ||
    call.callId !== submission.callId ||
    call.kind !== 'tool' ||
    inputRecord === undefined ||
    Object.keys(inputRecord).length !== 1 ||
    !Object.hasOwn(inputRecord, 'result') ||
    !isDeepStrictEqual(inputRecord.result, submission.output) ||
    call.inputHash !== canonicalJsonSha256(expectedInput) ||
    !['in_flight', 'result_submitted', 'applied'].includes(call.status)
  ) {
    invalidExecution(
      'The child agent-result call does not match its authoritative result submission.',
    );
  }
  if (call.status === 'in_flight') return;
  try {
    parseAgentResultReceipt(call.result, submission.outputHash);
  } catch {
    invalidExecution(
      'The child agent-result Tool receipt is invalid or does not match the submitted output.',
    );
  }
}

function createChunkedTimeoutSignal(remainingMs: number): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let remaining = remainingMs;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    const delay = Math.min(remaining, MAX_NODE_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      timer = undefined;
      remaining -= delay;
      if (remaining > 0) {
        schedule();
        return;
      }
      controller.abort(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      );
    }, delay);
    timer.unref();
  };

  const dispose = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  schedule();
  return Object.freeze({ signal: controller.signal, dispose });
}

function assertCompactTransaction(value: unknown): void {
  const record = assertClosedRecord(
    value,
    'checkpoint.compactTransaction',
    [
      'schemaVersion',
      'transactionId',
      'kind',
      'contextRevision',
      'phase',
      'preparedAt',
      'updatedAt',
    ],
    ['metadata', 'result', 'outcomeUnknown'],
    'invalid-execution-request',
  );
  if (record.schemaVersion !== '1')
    invalidExecution('checkpoint.compactTransaction schemaVersion must be "1".');
  assertTransportIdentifier(
    record.transactionId,
    'checkpoint.compactTransaction.transactionId',
    'invalid-execution-request',
  );
  if (record.kind !== 'summary' && record.kind !== 'tool_payload') {
    invalidExecution('checkpoint.compactTransaction.kind is invalid.');
  }
  if (!['prepared', 'in_flight', 'result_ready', 'applied'].includes(record.phase as string)) {
    invalidExecution('checkpoint.compactTransaction.phase is invalid.');
  }
  assertNonnegativeSafeInteger(
    record.contextRevision,
    'checkpoint.compactTransaction.contextRevision',
  );
  assertNonnegativeSafeInteger(record.preparedAt, 'checkpoint.compactTransaction.preparedAt');
  assertNonnegativeSafeInteger(record.updatedAt, 'checkpoint.compactTransaction.updatedAt');
  if ((record.updatedAt as number) < (record.preparedAt as number)) {
    invalidExecution('checkpoint.compactTransaction.updatedAt cannot precede preparedAt.');
  }
  const compactHasResult = record.result !== undefined;
  if (
    ((record.phase === 'result_ready' || record.phase === 'applied') && !compactHasResult) ||
    ((record.phase === 'prepared' || record.phase === 'in_flight') && compactHasResult)
  ) {
    invalidExecution('checkpoint.compactTransaction result does not match its phase.');
  }
  if (record.outcomeUnknown !== undefined) {
    assertBoolean(record.outcomeUnknown, 'checkpoint.compactTransaction.outcomeUnknown');
    if (record.outcomeUnknown === true && record.phase !== 'in_flight') {
      invalidExecution('checkpoint.compactTransaction outcomeUnknown is only valid in-flight.');
    }
  }
}

function assertContextStoreCheckpoint(value: unknown): ProtocolIdentity {
  const record = assertClosedRecord(
    value,
    'checkpoint.contextStore',
    [
      'version',
      'protocol',
      'codecVersion',
      'revision',
      'rawHistory',
      'activeSpans',
      'nextRawItemId',
      'nextSpanId',
      'nextEntryId',
    ],
    ['summaryBoundarySpanId', 'previousSummary', 'openLoopSpanId'],
    'invalid-execution-request',
  );
  assertVersionOne(record.version, 'context store checkpoint');
  assertProtocolName(record.protocol, 'checkpoint.contextStore.protocol', NAME_PATTERN);
  assertProtocolName(record.codecVersion, 'checkpoint.contextStore.codecVersion', VERSION_PATTERN);
  assertNonnegativeSafeInteger(record.revision, 'checkpoint.contextStore.revision');
  for (const key of ['summaryBoundarySpanId', 'openLoopSpanId'] as const) {
    if (record[key] !== undefined) {
      assertTransportIdentifier(
        record[key],
        `checkpoint.contextStore.${key}`,
        'invalid-execution-request',
      );
    }
  }
  if (record.previousSummary !== undefined) {
    const summary = assertClosedRecord(
      record.previousSummary,
      'checkpoint.contextStore.previousSummary',
      ['entryId', 'text'],
      [],
      'invalid-execution-request',
    );
    assertTransportIdentifier(
      summary.entryId,
      'checkpoint.contextStore.previousSummary.entryId',
      'invalid-execution-request',
    );
    if (typeof summary.text !== 'string')
      invalidExecution('checkpoint.contextStore.previousSummary.text must be a string.');
  }

  const rawHistory = assertArray(
    record.rawHistory,
    'checkpoint.contextStore.rawHistory',
    'invalid-execution-request',
  );
  const rawIds = new Set<string>();
  let maxRawItemId = 0;
  for (const [index, item] of rawHistory.entries()) {
    const raw = assertClosedRecord(
      item,
      `checkpoint.contextStore.rawHistory[${index}]`,
      ['itemId', 'value'],
      [],
      'invalid-execution-request',
    );
    assertTransportIdentifier(
      raw.itemId,
      `checkpoint.contextStore.rawHistory[${index}].itemId`,
      'invalid-execution-request',
    );
    if (rawIds.has(raw.itemId as string))
      invalidExecution('checkpoint.contextStore raw itemId values must be unique.');
    rawIds.add(raw.itemId as string);
    maxRawItemId = Math.max(
      maxRawItemId,
      parseGeneratedContextId(
        raw.itemId as string,
        'context-raw-item-',
        `checkpoint.contextStore.rawHistory[${index}].itemId`,
      ),
    );
  }

  const activeSpans = assertArray(
    record.activeSpans,
    'checkpoint.contextStore.activeSpans',
    'invalid-execution-request',
  );
  if (activeSpans.length === 0) {
    invalidExecution('checkpoint.contextStore.activeSpans must not be empty.');
  }
  const spanIds = new Set<string>();
  const entryIds = new Set<string>();
  const openSpanIds: string[] = [];
  let maxSpanId = 0;
  let maxEntryId = 0;
  for (const [spanIndex, item] of activeSpans.entries()) {
    const span = assertClosedRecord(
      item,
      `checkpoint.contextStore.activeSpans[${spanIndex}]`,
      ['spanId', 'kind', 'closed', 'originalContext', 'entries'],
      [],
      'invalid-execution-request',
    );
    assertTransportIdentifier(
      span.spanId,
      `checkpoint.contextStore.activeSpans[${spanIndex}].spanId`,
      'invalid-execution-request',
    );
    if (spanIds.has(span.spanId as string))
      invalidExecution('checkpoint.contextStore spanId values must be unique.');
    spanIds.add(span.spanId as string);
    maxSpanId = Math.max(
      maxSpanId,
      parseGeneratedContextId(
        span.spanId as string,
        'context-span-',
        `checkpoint.contextStore.activeSpans[${spanIndex}].spanId`,
      ),
    );
    assertContextEntryKind(span.kind, `checkpoint.contextStore.activeSpans[${spanIndex}].kind`);
    assertBoolean(span.closed, `checkpoint.contextStore.activeSpans[${spanIndex}].closed`);
    if (span.closed === false) openSpanIds.push(span.spanId as string);
    assertArray(
      span.originalContext,
      `checkpoint.contextStore.activeSpans[${spanIndex}].originalContext`,
      'invalid-execution-request',
    );
    const entries = assertArray(
      span.entries,
      `checkpoint.contextStore.activeSpans[${spanIndex}].entries`,
      'invalid-execution-request',
    );
    for (const [entryIndex, entryValue] of entries.entries()) {
      const entry = assertClosedRecord(
        entryValue,
        `checkpoint.contextStore.activeSpans[${spanIndex}].entries[${entryIndex}]`,
        ['entryId', 'spanId', 'kind', 'active'],
        ['rawItemId', 'original'],
        'invalid-execution-request',
      );
      assertTransportIdentifier(
        entry.entryId,
        'checkpoint context entry entryId',
        'invalid-execution-request',
      );
      assertTransportIdentifier(
        entry.spanId,
        'checkpoint context entry spanId',
        'invalid-execution-request',
      );
      if (entry.spanId !== span.spanId)
        invalidExecution('checkpoint context entry spanId must match its parent span.');
      if (entryIds.has(entry.entryId as string))
        invalidExecution('checkpoint.contextStore entryId values must be unique.');
      entryIds.add(entry.entryId as string);
      maxEntryId = Math.max(
        maxEntryId,
        parseGeneratedContextId(
          entry.entryId as string,
          'context-entry-',
          `checkpoint.contextStore.activeSpans[${spanIndex}].entries[${entryIndex}].entryId`,
        ),
      );
      assertContextEntryKind(entry.kind, 'checkpoint context entry kind');
      if (entry.kind !== span.kind) {
        invalidExecution('checkpoint context entry kind must match its parent span.');
      }
      if (entry.rawItemId !== undefined) {
        assertTransportIdentifier(
          entry.rawItemId,
          'checkpoint context entry rawItemId',
          'invalid-execution-request',
        );
        if (!rawIds.has(entry.rawItemId as string)) {
          invalidExecution('checkpoint context entry rawItemId must reference rawHistory.');
        }
      }
    }
  }
  for (const key of ['nextRawItemId', 'nextSpanId', 'nextEntryId'] as const) {
    assertPositiveSafeInteger(
      record[key],
      `checkpoint.contextStore.${key}`,
      'invalid-execution-request',
    );
  }
  if ((record.nextRawItemId as number) <= maxRawItemId) {
    invalidExecution('checkpoint.contextStore.nextRawItemId must exceed persisted raw item IDs.');
  }
  if ((record.nextSpanId as number) <= maxSpanId) {
    invalidExecution('checkpoint.contextStore.nextSpanId must exceed persisted span IDs.');
  }
  if ((record.nextEntryId as number) <= maxEntryId) {
    invalidExecution('checkpoint.contextStore.nextEntryId must exceed persisted entry IDs.');
  }

  if (record.openLoopSpanId === undefined) {
    if (openSpanIds.length !== 0) {
      invalidExecution('An open context span requires checkpoint.contextStore.openLoopSpanId.');
    }
  } else {
    const lastSpan = activeSpans.at(-1) as UnknownRecord | undefined;
    if (
      openSpanIds.length !== 1 ||
      openSpanIds[0] !== record.openLoopSpanId ||
      lastSpan?.spanId !== record.openLoopSpanId ||
      lastSpan.kind !== 'loop'
    ) {
      invalidExecution(
        'checkpoint.contextStore.openLoopSpanId must identify one trailing loop span.',
      );
    }
  }

  const hasSummaryBoundary = record.summaryBoundarySpanId !== undefined;
  const hasPreviousSummary = record.previousSummary !== undefined;
  if (hasSummaryBoundary !== hasPreviousSummary) {
    invalidExecution(
      'checkpoint.contextStore summaryBoundarySpanId and previousSummary must appear together.',
    );
  }
  if (hasSummaryBoundary && hasPreviousSummary) {
    const firstSpan = activeSpans[0] as UnknownRecord | undefined;
    const entries = firstSpan?.entries as readonly UnknownRecord[] | undefined;
    const previousSummary = record.previousSummary as UnknownRecord;
    if (
      firstSpan?.spanId !== record.summaryBoundarySpanId ||
      firstSpan?.kind !== 'summary' ||
      firstSpan?.closed !== true ||
      entries?.length !== 1 ||
      entries[0]?.entryId !== previousSummary.entryId
    ) {
      invalidExecution('checkpoint.contextStore rolling summary provenance is invalid.');
    }
  }
  return record as unknown as ProtocolIdentity;
}

function assertContextEntryKind(value: unknown, label: string): void {
  if (!['seed', 'user', 'external', 'loop', 'summary', 'preserved'].includes(value as string)) {
    invalidExecution(`${label} is invalid.`);
  }
}

function parseGeneratedContextId(value: string, prefix: string, label: string): number {
  if (!value.startsWith(prefix)) {
    invalidExecution(`${label} is not a valid generated context ID.`);
  }
  const suffix = value.slice(prefix.length);
  if (suffix.length === 0 || [...suffix].some((character) => character < '0' || character > '9')) {
    invalidExecution(`${label} is not a valid generated context ID.`);
  }
  const numericId = Number(suffix);
  if (!Number.isSafeInteger(numericId) || numericId < 1) {
    invalidExecution(`${label} is not a valid generated context ID.`);
  }
  return numericId;
}

function assertDefinitionRef(
  value: unknown,
  label: string,
): { readonly name: string; readonly version: string } {
  const record = assertClosedRecord(
    value,
    label,
    ['name', 'version'],
    [],
    'invalid-execution-request',
  );
  assertProtocolName(record.name, `${label}.name`, NAME_PATTERN);
  assertProtocolName(record.version, `${label}.version`, VERSION_PATTERN);
  return record as unknown as { readonly name: string; readonly version: string };
}

function assertProjectedContext(value: unknown): void {
  const items = assertArray(value, 'projectedContext', 'invalid-execution-request');
  if (items.length > DEFAULT_SUBAGENT_PROJECTION_LIMITS.maxItems) {
    invalidExecution('Subagent projectedContext contains too many items.');
  }
  let totalBytes = 0;
  for (const [index, item] of items.entries()) {
    const base = assertObject(item, `projectedContext[${index}]`, 'invalid-execution-request');
    if (base.kind === 'text') {
      const record = assertClosedRecord(
        item,
        `projectedContext[${index}]`,
        ['kind', 'name', 'text'],
        [],
        'invalid-execution-request',
      );
      assertBoundedText(
        record.name,
        `projectedContext[${index}].name`,
        DEFAULT_SUBAGENT_PROJECTION_LIMITS.maxItemBytes,
        false,
      );
      if (typeof record.text !== 'string')
        invalidExecution(`projectedContext[${index}].text must be a string.`);
    } else if (base.kind === 'data') {
      const record = assertClosedRecord(
        item,
        `projectedContext[${index}]`,
        ['kind', 'name', 'value'],
        [],
        'invalid-execution-request',
      );
      assertBoundedText(
        record.name,
        `projectedContext[${index}].name`,
        DEFAULT_SUBAGENT_PROJECTION_LIMITS.maxItemBytes,
        false,
      );
    } else if (base.kind === 'artifact') {
      const record = assertClosedRecord(
        item,
        `projectedContext[${index}]`,
        ['kind', 'artifact'],
        [],
        'invalid-execution-request',
      );
      try {
        assertArtifactReference(record.artifact);
      } catch (error) {
        throw transportError(
          'invalid-execution-request',
          `projectedContext[${index}].artifact is invalid.`,
          error,
        );
      }
    } else {
      invalidExecution(`projectedContext[${index}].kind is invalid.`);
    }

    const itemBytes = measureCanonicalJsonBytes(item as JsonValue);
    if (itemBytes > DEFAULT_SUBAGENT_PROJECTION_LIMITS.maxItemBytes) {
      invalidExecution(`projectedContext[${index}] exceeds the item byte limit.`);
    }
    totalBytes += itemBytes;
  }
  if (totalBytes > DEFAULT_SUBAGENT_PROJECTION_LIMITS.maxTotalBytes) {
    invalidExecution('Subagent projectedContext exceeds the total byte limit.');
  }
}

function assertDelegationSnapshot(value: unknown) {
  const record = assertClosedRecord(
    value,
    'delegation',
    [
      'version',
      'ownerSessionId',
      'runId',
      'parentTaskId',
      'path',
      'depth',
      'catalogRevision',
      'definitions',
    ],
    [],
    'invalid-execution-request',
  );
  assertVersionOne(record.version, 'delegation snapshot');
  for (const key of ['ownerSessionId', 'runId', 'parentTaskId'] as const) {
    assertTransportIdentifier(record[key], `delegation.${key}`, 'invalid-execution-request');
  }
  assertIdentifierArray(record.path, 'delegation.path');
  assertPositiveSafeInteger(record.depth, 'delegation.depth', 'invalid-execution-request');
  assertPositiveSafeInteger(
    record.catalogRevision,
    'delegation.catalogRevision',
    'invalid-execution-request',
  );
  const definitions = assertArray(
    record.definitions,
    'delegation.definitions',
    'invalid-execution-request',
  );
  const definitionKeys = new Set<string>();
  for (const [index, value] of definitions.entries()) {
    const entry = assertClosedRecord(
      value,
      `delegation.definitions[${index}]`,
      ['name', 'version', 'executors'],
      [],
      'invalid-execution-request',
    );
    assertProtocolName(entry.name, `delegation.definitions[${index}].name`, NAME_PATTERN);
    assertProtocolName(entry.version, `delegation.definitions[${index}].version`, VERSION_PATTERN);
    const definitionKey = `${entry.name as string}\u0000${entry.version as string}`;
    if (definitionKeys.has(definitionKey))
      invalidExecution('delegation.definitions must not contain duplicates.');
    definitionKeys.add(definitionKey);
    const executors = assertArray(
      entry.executors,
      `delegation.definitions[${index}].executors`,
      'invalid-execution-request',
    );
    if (executors.length === 0)
      invalidExecution('delegation definition executors must not be empty.');
    const executorNames = new Set<string>();
    for (const [executorIndex, executor] of executors.entries()) {
      assertProtocolName(
        executor,
        `delegation.definitions[${index}].executors[${executorIndex}]`,
        NAME_PATTERN,
      );
      if (executorNames.has(executor as string))
        invalidExecution('delegation definition executors must not contain duplicates.');
      executorNames.add(executor as string);
    }
  }
  return record as unknown as {
    readonly ownerSessionId: string;
    readonly runId: string;
    readonly parentTaskId: string;
    readonly path: readonly string[];
    readonly depth: number;
  };
}

function assertResolvedLimits(value: unknown): {
  readonly maxDepth: number;
  readonly timeoutMs: number;
} {
  const record = assertClosedRecord(
    value,
    'limits',
    ['maxDepth', 'maxDescendants', 'maxConcurrent', 'maxTurns', 'timeoutMs'],
    ['maxProviderCalls', 'maxInputTokens', 'maxOutputTokens', 'maxCost'],
    'invalid-execution-request',
  );
  for (const key of [
    'maxDepth',
    'maxDescendants',
    'maxConcurrent',
    'maxTurns',
    'timeoutMs',
    'maxProviderCalls',
    'maxInputTokens',
    'maxOutputTokens',
  ] as const) {
    if (record[key] !== undefined) {
      assertPositiveSafeInteger(record[key], `limits.${key}`, 'invalid-execution-request');
    }
  }
  if (
    record.maxCost !== undefined &&
    (typeof record.maxCost !== 'number' || !Number.isFinite(record.maxCost) || record.maxCost < 0)
  ) {
    invalidExecution('limits.maxCost must be a finite non-negative number.');
  }
  return record as unknown as { readonly maxDepth: number; readonly timeoutMs: number };
}

function assertClosedRecord(
  value: unknown,
  label: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  reason: SubAgentTransportErrorReason,
): UnknownRecord {
  const record = assertObject(value, label, reason);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(record);
  const unsupported = keys.find((key) => !allowed.has(key));
  if (unsupported !== undefined) {
    throw transportError(
      reason,
      `${label} contains unsupported field ${JSON.stringify(unsupported)}.`,
    );
  }
  const missing = requiredKeys.find((key) => !Object.hasOwn(record, key));
  if (missing !== undefined) {
    throw transportError(reason, `${label} is missing required field ${JSON.stringify(missing)}.`);
  }
  return record;
}

function assertObject(
  value: unknown,
  label: string,
  reason: SubAgentTransportErrorReason,
): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw transportError(reason, `${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function assertArray(
  value: unknown,
  label: string,
  reason: SubAgentTransportErrorReason,
): readonly unknown[] {
  if (!Array.isArray(value)) throw transportError(reason, `${label} must be an array.`);
  return value;
}

function assertIdentifierArray(value: unknown, label: string): readonly string[] {
  const items = assertArray(value, label, 'invalid-execution-request');
  const result: string[] = [];
  for (const [index, item] of items.entries()) {
    assertTransportIdentifier(item, `${label}[${index}]`, 'invalid-execution-request');
    result.push(item as string);
  }
  return result;
}

function assertTransportIdentifier(
  value: unknown,
  label: string,
  reason: SubAgentTransportErrorReason,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    containsControlCharacter(value) ||
    textEncoder.encode(value).byteLength < 1 ||
    textEncoder.encode(value).byteLength > SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES
  ) {
    throw transportError(
      reason,
      `Subagent transport ${label} must be a trimmed 1-${SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES} byte identifier without control characters.`,
    );
  }
}

function assertTransportKind(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    textEncoder.encode(value).byteLength > SUBAGENT_TRANSPORT_MAX_KIND_BYTES ||
    !TRANSPORT_KIND_PATTERN.test(value)
  ) {
    throw transportError(
      'invalid-kind',
      `Subagent transport kind must be a 1-${SUBAGENT_TRANSPORT_MAX_KIND_BYTES} byte protocol token.`,
    );
  }
}

function assertProtocolName(
  value: unknown,
  label: string,
  pattern: RegExp,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_PROTOCOL_TOKEN_CHARACTERS ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    invalidExecution(
      `${label} must be a valid 1-${MAX_PROTOCOL_TOKEN_CHARACTERS} character protocol identifier.`,
    );
  }
}

function assertBoundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty: boolean,
): asserts value is string {
  if (typeof value !== 'string') invalidExecution(`${label} must be a string.`);
  const bytes = textEncoder.encode(value).byteLength;
  if ((!allowEmpty && value.trim().length === 0) || bytes > maxBytes) {
    invalidExecution(`${label} must be ${allowEmpty ? '0' : '1'}-${maxBytes} UTF-8 bytes.`);
  }
}

function assertPositiveSafeInteger(
  value: unknown,
  label: string,
  reason: SubAgentTransportErrorReason,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw transportError(reason, `Subagent transport ${label} must be a positive safe integer.`);
  }
}

function assertNonnegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalidExecution(`${label} must be a non-negative safe integer.`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') invalidExecution(`${label} must be boolean.`);
}

function assertVersionOne(value: unknown, label: string): asserts value is '1' {
  if (value !== '1') invalidExecution(`${label} version must be "1".`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    invalidExecution(`${label} must be 64 lowercase hexadecimal characters.`);
  }
}

function readLocalNow(now: (() => number) | undefined): number {
  const value = (now ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw transportError(
      'invalid-execution-request',
      'Subagent transport local clock must return a non-negative safe integer.',
    );
  }
  return value;
}

function resolveExecutionWireValidationOptions(
  options: SubAgentExecutionRequestWireValidationOptions,
): ResolvedExecutionWireValidationOptions {
  const maxCanonicalBytes = options.maxCanonicalBytes ?? DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES;
  const maxJsonDepth = options.maxJsonDepth ?? DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH;
  const maxJsonNodes = options.maxJsonNodes ?? DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES;
  const maxBindingBytes = options.maxBindingBytes ?? DEFAULT_EXECUTOR_MAX_BINDING_BYTES;
  for (const [label, value] of [
    ['maxCanonicalBytes', maxCanonicalBytes],
    ['maxJsonDepth', maxJsonDepth],
    ['maxJsonNodes', maxJsonNodes],
    ['maxBindingBytes', maxBindingBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Subagent transport ${label} must be a positive safe integer.`);
    }
  }
  if (maxBindingBytes > DEFAULT_EXECUTOR_MAX_BINDING_BYTES) {
    throw new RangeError(
      `Subagent transport maxBindingBytes cannot exceed ${DEFAULT_EXECUTOR_MAX_BINDING_BYTES}.`,
    );
  }
  if (options.expectedExecutorName !== undefined) {
    assertProtocolName(options.expectedExecutorName, 'expectedExecutorName', NAME_PATTERN);
  }
  return Object.freeze({
    maxCanonicalBytes,
    maxJsonDepth,
    maxJsonNodes,
    ...(options.expectedExecutorName === undefined
      ? {}
      : { expectedExecutorName: options.expectedExecutorName }),
    maxBindingBytes,
  });
}

function assertJsonComplexity(value: unknown, maxDepth: number, maxNodes: number): void {
  type WorkItem =
    | { readonly type: 'value'; readonly value: unknown; readonly depth: number }
    | { readonly type: 'leave'; readonly value: object };

  const work: WorkItem[] = [{ type: 'value', value, depth: 0 }];
  const active = new WeakSet<object>();
  let nodes = 0;

  while (work.length > 0) {
    const item = work.pop() as WorkItem;
    if (item.type === 'leave') {
      active.delete(item.value);
      continue;
    }
    nodes += 1;
    if (nodes > maxNodes) {
      invalidExecution(`Subagent execution request exceeds the ${maxNodes}-node JSON limit.`);
    }
    if (item.depth > maxDepth) {
      invalidExecution(`Subagent execution request exceeds the JSON depth limit ${maxDepth}.`);
    }
    if (typeof item.value !== 'object' || item.value === null) continue;
    if (nodeTypes.isProxy(item.value)) {
      invalidExecution('Subagent execution request cannot contain Proxy objects.');
    }
    if (active.has(item.value)) {
      invalidExecution('Subagent execution request cannot contain cyclic JSON values.');
    }

    active.add(item.value);
    work.push({ type: 'leave', value: item.value });
    const keys = Reflect.ownKeys(item.value);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const descriptor = Object.getOwnPropertyDescriptor(item.value, keys[index] as PropertyKey);
      if (descriptor?.enumerable === true && 'value' in descriptor) {
        work.push({ type: 'value', value: descriptor.value, depth: item.depth + 1 });
      }
    }
  }
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  const work: object[] = [value];
  const seen = new WeakSet<object>();
  while (work.length > 0) {
    const current = work.pop() as object;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (
        descriptor !== undefined &&
        'value' in descriptor &&
        typeof descriptor.value === 'object' &&
        descriptor.value !== null
      ) {
        work.push(descriptor.value);
      }
    }
    Object.freeze(current);
  }
  return value;
}

function resolveSequenceWindow(value: number | undefined): number {
  const resolved = value ?? DEFAULT_SUBAGENT_TRANSPORT_SEQUENCE_WINDOW;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > SUBAGENT_TRANSPORT_MAX_SEQUENCE_WINDOW
  ) {
    throw new RangeError(
      `Subagent transport maxTrackedSequences must be a safe integer between 1 and ${SUBAGENT_TRANSPORT_MAX_SEQUENCE_WINDOW}.`,
    );
  }
  return resolved;
}

function resolveFrameLimit(options: SubAgentTransportFrameOptions): number {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new RangeError('Subagent transport maxFrameBytes must be a positive safe integer.');
  }
  return maxFrameBytes;
}

function assertFrameByteLimit(actualBytes: number, maxFrameBytes: number): void {
  if (actualBytes <= maxFrameBytes) return;
  throw transportError(
    'frame-too-large',
    `Subagent transport frame is ${actualBytes} UTF-8 bytes; maximum is ${maxFrameBytes}.`,
  );
}

function throwSequenceGap(expected: number, actual: number): never {
  throw transportError(
    'sequence-gap',
    `Subagent transport sequence gap: expected ${expected}, received ${actual}.`,
  );
}

function invalidExecution(message: string): never {
  throw transportError('invalid-execution-request', message);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function transportError(
  reason: SubAgentTransportErrorReason,
  message: string,
  cause?: unknown,
): SubAgentTransportError {
  return new SubAgentTransportError(reason, message, cause === undefined ? undefined : { cause });
}
