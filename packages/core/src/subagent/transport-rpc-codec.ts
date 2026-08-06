import { DEFAULT_EXECUTOR_MAX_BINDING_BYTES } from './executor';
import { SUBAGENT_ERROR_CODES } from './errors';
import { assertJsonValue, measureCanonicalJsonBytes, type JsonValue } from './json';
import {
  assertSubAgentTransportControlReply,
  assertSubAgentTransportControlRequest,
} from './transport-control';
import {
  assertSubAgentExecutionRequestWire,
  assertSubAgentTransportEnvelope,
  decodeSubAgentTransportFrame,
  encodeSubAgentTransportFrame,
} from './transport-codec';
import {
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
  SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES,
  SUBAGENT_TRANSPORT_VERSION,
  type SubAgentTransportEnvelope,
} from './transport';
import {
  SUBAGENT_TRANSPORT_RPC_KINDS,
  SubAgentTransportRpcError,
  type CreateSubAgentTransportRpcEnvelopeInput,
  type SubAgentTransportRpcEnvelope,
  type SubAgentTransportRpcKind,
  type SubAgentTransportRpcValidationOptions,
} from './transport-rpc';

const textEncoder = new TextEncoder();
const RPC_KIND_SET = new Set<string>(SUBAGENT_TRANSPORT_RPC_KINDS);
const REQUEST_KINDS = new Set<string>([
  'executor.request',
  'control.request',
  'cancel.request',
  'snapshot.request',
  'events.request',
]);
const REPLY_KINDS = new Set<string>([
  'executor.accepted',
  'executor.settled',
  'control.reply',
  'cancel.ack',
  'snapshot.reply',
  'events.page',
]);
const TASK_STATES = new Set<string>([
  'queued',
  'running',
  'waiting_approval',
  'result_submitted',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'budget_exceeded',
]);
const FAILURE_STATES = new Set<string>(['failed', 'cancelled', 'timed_out', 'budget_exceeded']);
const EVENT_TYPES = new Set<string>([
  'task.queued',
  'task.started',
  'task.paused',
  'task.resumed',
  'task.result_submitted',
  'task.succeeded',
  'task.failed',
  'task.cancelled',
  'task.timed_out',
  'task.budget_exceeded',
  'approval.requested',
  'approval.decided',
  'recovery.started',
  'recovery.resumed',
  'recovery.reconnected',
  'recovery.failed',
  'progress.reported',
  'usage.updated',
  'budget.rejected',
]);
const SAFE_EVENT_DATA_KEYS = new Set([
  'status',
  'errorCode',
  'reasonCode',
  'approvalId',
  'toolName',
  'callId',
  'length',
  'durationMs',
  'checkpointRevision',
  'usage',
  'outcomeUnknown',
]);
const SUBAGENT_ERROR_CODE_SET = new Set<string>(SUBAGENT_ERROR_CODES);
const PROTOCOL_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const MAX_SAFE_MESSAGE_BYTES = 4_096;
const MAX_EVENTS_PER_PAGE = 256;

type UnknownRecord = Record<string, unknown>;

interface ResolvedRpcOptions {
  readonly maxFrameBytes: number;
  readonly maxCanonicalBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
}

/** Builds an owned, recursively frozen RPC envelope and rejects aliases or extra fields. */
export function createSubAgentTransportRpcEnvelope(
  input: CreateSubAgentTransportRpcEnvelopeInput,
  options: SubAgentTransportRpcValidationOptions = {},
): SubAgentTransportRpcEnvelope {
  const candidate = { ...input, version: SUBAGENT_TRANSPORT_VERSION };
  return decodeSubAgentTransportRpcFrame(
    encodeSubAgentTransportRpcFrame(candidate, options),
    options,
  );
}

/** Validates semantic kind, routing and payload rules without invoking an Executor or Core callback. */
export function assertSubAgentTransportRpcEnvelope(
  value: unknown,
  options: SubAgentTransportRpcValidationOptions = {},
): asserts value is SubAgentTransportRpcEnvelope {
  const resolved = resolveRpcOptions(options);
  try {
    assertSubAgentTransportEnvelope(value, {
      maxFrameBytes: resolved.maxFrameBytes,
      maxJsonDepth: resolved.maxJsonDepth,
      maxJsonNodes: resolved.maxJsonNodes,
    });
  } catch (error) {
    throw rpcError(
      'invalid-rpc-payload',
      'Subagent RPC envelope must be a closed RFC 8785-compatible transport envelope.',
      error,
    );
  }
  assertStructuralLimits(value as unknown as JsonValue, resolved);
  if (measureCanonicalJsonBytes(value as unknown as JsonValue) > resolved.maxCanonicalBytes) {
    throw rpcError(
      'rpc-limit-exceeded',
      `Subagent RPC envelope exceeds ${resolved.maxCanonicalBytes} canonical UTF-8 bytes.`,
    );
  }

  if (!RPC_KIND_SET.has(value.kind)) {
    throw rpcError(
      'invalid-rpc-kind',
      `Unsupported Subagent RPC kind ${JSON.stringify(value.kind)}.`,
    );
  }

  const kind = value.kind as SubAgentTransportRpcKind;
  assertRpcRouting(value, kind);
  try {
    assertRpcPayload(kind, value.payload, value, resolved);
  } catch (error) {
    if (error instanceof SubAgentTransportRpcError) throw error;
    throw rpcError('invalid-rpc-payload', `Subagent RPC ${kind} payload is invalid.`, error);
  }
}

/** Canonical JCS encoder for one strict semantic RPC envelope. */
export function encodeSubAgentTransportRpcFrame(
  envelope: unknown,
  options: SubAgentTransportRpcValidationOptions = {},
): string {
  const resolved = resolveRpcOptions(options);
  assertSubAgentTransportRpcEnvelope(envelope, resolved);
  return encodeSubAgentTransportFrame(envelope, {
    maxFrameBytes: resolved.maxFrameBytes,
    maxJsonDepth: resolved.maxJsonDepth,
    maxJsonNodes: resolved.maxJsonNodes,
  });
}

/** Strict frame decoder returning an owned, recursively frozen semantic envelope. */
export function decodeSubAgentTransportRpcFrame(
  frame: string | Uint8Array,
  options: SubAgentTransportRpcValidationOptions = {},
): SubAgentTransportRpcEnvelope {
  const resolved = resolveRpcOptions(options);
  const envelope = decodeSubAgentTransportFrame(frame, {
    maxFrameBytes: resolved.maxFrameBytes,
    maxJsonDepth: resolved.maxJsonDepth,
    maxJsonNodes: resolved.maxJsonNodes,
  });
  assertSubAgentTransportRpcEnvelope(envelope, resolved);
  return envelope as unknown as SubAgentTransportRpcEnvelope;
}

function assertRpcRouting(
  envelope: SubAgentTransportEnvelope,
  kind: SubAgentTransportRpcKind,
): void {
  if (REQUEST_KINDS.has(kind)) {
    if (envelope.correlationId !== undefined) {
      throw rpcError('invalid-rpc-routing', `${kind} must not contain correlationId.`);
    }
    assertTaskOperationRoute(envelope, kind);
    return;
  }

  if (REPLY_KINDS.has(kind)) {
    assertIdentifier(envelope.correlationId, `${kind}.correlationId`);
    assertTaskOperationRoute(envelope, kind);
    return;
  }

  assertIdentifier(envelope.correlationId, 'protocol.error.correlationId');
  if ((envelope.taskId === undefined) !== (envelope.operationId === undefined)) {
    throw rpcError(
      'invalid-rpc-routing',
      'protocol.error taskId and operationId must either both be present or both be absent.',
    );
  }
}

function assertTaskOperationRoute(envelope: SubAgentTransportEnvelope, kind: string): void {
  assertIdentifier(envelope.taskId, `${kind}.taskId`);
  assertIdentifier(envelope.operationId, `${kind}.operationId`);
}

function assertRpcPayload(
  kind: SubAgentTransportRpcKind,
  payload: JsonValue,
  envelope: SubAgentTransportEnvelope,
  options: ResolvedRpcOptions,
): void {
  switch (kind) {
    case 'executor.request': {
      const record = closedRecord(payload, kind, ['mode', 'request']);
      if (record.mode !== 'execute' && record.mode !== 'spawn') {
        throw rpcError('invalid-rpc-payload', 'executor.request.mode must be execute or spawn.');
      }
      assertSubAgentExecutionRequestWire(record.request, {
        maxCanonicalBytes: options.maxCanonicalBytes,
        maxJsonDepth: options.maxJsonDepth,
        maxJsonNodes: options.maxJsonNodes,
      });
      const request = record.request;
      if (
        request.taskId !== envelope.taskId ||
        request.operation.operationId !== envelope.operationId
      ) {
        throw rpcError(
          'invalid-rpc-routing',
          'executor.request payload identity must match envelope taskId and operationId.',
        );
      }
      return;
    }
    case 'executor.accepted': {
      const record = closedRecord(payload, kind, ['mode', 'binding']);
      if (record.mode !== 'spawn') {
        throw rpcError('invalid-rpc-payload', 'executor.accepted.mode must be spawn.');
      }
      const binding = assertBinding(record.binding, `${kind}.binding`);
      if (binding.taskId !== envelope.taskId) {
        throw rpcError(
          'invalid-rpc-routing',
          'executor.accepted binding taskId must match routing.',
        );
      }
      return;
    }
    case 'executor.settled': {
      const record = closedRecord(payload, kind, ['mode', 'outcome']);
      if (record.mode !== 'execute' && record.mode !== 'spawn' && record.mode !== 'wait') {
        throw rpcError(
          'invalid-rpc-payload',
          'executor.settled.mode must be execute, spawn or wait.',
        );
      }
      assertExecutionOutcome(record.outcome, envelope);
      return;
    }
    case 'control.request': {
      const record = closedRecord(payload, kind, ['method', 'args']);
      try {
        assertSubAgentTransportControlRequest(
          {
            taskId: envelope.taskId,
            operationId: envelope.operationId,
            method: record.method,
            args: record.args,
          },
          {
            maxBytes: options.maxFrameBytes,
            maxDepth: options.maxJsonDepth,
            maxNodes: options.maxJsonNodes,
          },
        );
      } catch (error) {
        throw rpcError('invalid-rpc-payload', 'control.request payload is invalid.', error);
      }
      return;
    }
    case 'control.reply': {
      try {
        assertSubAgentTransportControlReply(payload, {
          maxBytes: options.maxFrameBytes,
          maxDepth: options.maxJsonDepth,
          maxNodes: options.maxJsonNodes,
        });
      } catch (error) {
        throw rpcError('invalid-rpc-payload', 'control.reply payload is invalid.', error);
      }
      return;
    }
    case 'cancel.request': {
      const record = closedRecord(payload, kind, ['binding'], ['reason']);
      const binding = assertBinding(record.binding, `${kind}.binding`);
      if (binding.taskId !== envelope.taskId) {
        throw rpcError('invalid-rpc-routing', 'cancel.request binding taskId must match routing.');
      }
      if (record.reason !== undefined) assertSafeMessage(record.reason, `${kind}.reason`);
      return;
    }
    case 'cancel.ack': {
      const record = closedRecord(payload, kind, ['cancelled']);
      if (record.cancelled !== true) {
        throw rpcError('invalid-rpc-payload', 'cancel.ack.cancelled must be true.');
      }
      return;
    }
    case 'snapshot.request': {
      const record = closedRecord(payload, kind, ['mode']);
      if (record.mode !== 'snapshot' && record.mode !== 'wait') {
        throw rpcError('invalid-rpc-payload', 'snapshot.request.mode must be snapshot or wait.');
      }
      return;
    }
    case 'snapshot.reply': {
      const record = closedRecord(payload, kind, ['mode', 'snapshot']);
      if (record.mode !== 'snapshot') {
        throw rpcError('invalid-rpc-payload', 'snapshot.reply.mode must be snapshot.');
      }
      const snapshot = assertExecutorSnapshot(record.snapshot, `${kind}.snapshot`);
      if (snapshot.taskId !== envelope.taskId) {
        throw rpcError('invalid-rpc-routing', 'snapshot.reply taskId must match routing.');
      }
      return;
    }
    case 'events.request': {
      const record = closedRecord(payload, kind, [], ['afterSequence', 'limit']);
      if (record.afterSequence !== undefined) {
        assertNonNegativeSafeInteger(record.afterSequence, `${kind}.afterSequence`);
      }
      if (record.limit !== undefined) {
        assertPositiveSafeInteger(record.limit, `${kind}.limit`);
        if ((record.limit as number) > MAX_EVENTS_PER_PAGE) {
          throw rpcError(
            'invalid-rpc-payload',
            `${kind}.limit must not exceed ${MAX_EVENTS_PER_PAGE}.`,
          );
        }
      }
      return;
    }
    case 'events.page': {
      const record = closedRecord(payload, kind, ['events', 'nextSequence', 'done']);
      if (!Array.isArray(record.events) || record.events.length > MAX_EVENTS_PER_PAGE) {
        throw rpcError(
          'invalid-rpc-payload',
          `${kind}.events must be an array of at most ${MAX_EVENTS_PER_PAGE} events.`,
        );
      }
      let previousSequence = 0;
      for (const event of record.events) {
        const validated = assertTaskEvent(event, `${kind}.events`);
        if (validated.taskId !== envelope.taskId) {
          throw rpcError('invalid-rpc-routing', 'events.page event taskId must match routing.');
        }
        if (validated.sequence <= previousSequence) {
          throw rpcError(
            'invalid-rpc-payload',
            'events.page event sequences must strictly increase.',
          );
        }
        previousSequence = validated.sequence;
      }
      assertNonNegativeSafeInteger(record.nextSequence, `${kind}.nextSequence`);
      if (previousSequence > (record.nextSequence as number)) {
        throw rpcError(
          'invalid-rpc-payload',
          'events.page nextSequence must not precede a returned event sequence.',
        );
      }
      if (typeof record.done !== 'boolean') {
        throw rpcError('invalid-rpc-payload', `${kind}.done must be a boolean.`);
      }
      return;
    }
    case 'protocol.error': {
      const record = closedRecord(payload, kind, ['error']);
      assertSafeError(record.error, `${kind}.error`);
    }
  }
}

function assertExecutionOutcome(value: unknown, envelope: SubAgentTransportEnvelope): void {
  const record = recordValue(value, 'executor.settled.outcome');
  if (record.type === 'recovery_required') {
    assertExactKeys(record, 'executor.settled.outcome', [
      'type',
      'reason',
      'operationId',
      'causeCode',
    ]);
    if (record.reason !== 'checkpoint' && record.reason !== 'unbound_create') {
      throw rpcError('invalid-rpc-payload', 'Recovery reason is invalid.');
    }
    assertIdentifier(record.operationId, 'executor.settled.outcome.operationId');
    assertProtocolToken(record.causeCode, 'executor.settled.outcome.causeCode');
    if (record.operationId !== envelope.operationId) {
      throw rpcError('invalid-rpc-routing', 'Recovery operationId must match routing.');
    }
    return;
  }

  if (record.type === 'terminal') {
    assertExactKeys(record, 'executor.settled.outcome', ['type', 'result']);
    const taskId = assertTaskResult(record.result);
    if (taskId !== envelope.taskId) {
      throw rpcError('invalid-rpc-routing', 'Terminal outcome taskId must match routing.');
    }
    return;
  }

  if (record.type === 'paused') {
    assertExactKeys(record, 'executor.settled.outcome', [
      'type',
      'reason',
      'task',
      'approvals',
      'checkpointRevision',
    ]);
    if (record.reason !== 'approval') {
      throw rpcError('invalid-rpc-payload', 'Paused outcome reason must be approval.');
    }
    const task = assertTaskIdentity(record.task, 'executor.settled.outcome.task');
    if (task.taskId !== envelope.taskId) {
      throw rpcError('invalid-rpc-routing', 'Paused outcome taskId must match routing.');
    }
    if (!Array.isArray(record.approvals) || record.approvals.length < 1) {
      throw rpcError('invalid-rpc-payload', 'Paused outcome approvals must be a non-empty array.');
    }
    for (const approval of record.approvals) {
      if (assertApproval(approval) !== envelope.taskId) {
        throw rpcError('invalid-rpc-routing', 'Paused approval taskId must match routing.');
      }
    }
    assertPositiveSafeInteger(record.checkpointRevision, 'checkpointRevision');
    return;
  }

  throw rpcError('invalid-rpc-payload', 'executor.settled.outcome type is invalid.');
}

function assertTaskResult(value: unknown): string {
  const record = recordValue(value, 'executor task result');
  const common = ['status', 'task', 'executor'] as const;
  if (record.status === 'succeeded') {
    assertKeys(record, 'executor task result', [...common, 'output'], ['usage']);
    assertJsonValue(record.output);
  } else if (typeof record.status === 'string' && FAILURE_STATES.has(record.status)) {
    assertKeys(record, 'executor task result', [...common, 'error'], ['partialOutput', 'usage']);
    assertSafeError(record.error, 'executor task result.error');
    if (record.partialOutput !== undefined) assertJsonValue(record.partialOutput);
  } else {
    throw rpcError('invalid-rpc-payload', 'Executor task result status is invalid.');
  }
  const task = assertTaskIdentity(record.task, 'executor task result.task');
  assertIdentifier(record.executor, 'executor task result.executor');
  if (record.usage !== undefined) assertUsage(record.usage, 'executor task result.usage');
  return task.taskId;
}

function assertTaskIdentity(value: unknown, label: string): { readonly taskId: string } {
  const record = closedRecord(value, label, ['taskId', 'subAgent']);
  assertIdentifier(record.taskId, `${label}.taskId`);
  assertDefinitionRef(record.subAgent, `${label}.subAgent`);
  return record as unknown as { readonly taskId: string };
}

function assertApproval(value: unknown): string {
  const record = closedRecord(
    value,
    'approval',
    [
      'callId',
      'toolName',
      'summary',
      'approvalId',
      'ownerSessionId',
      'taskId',
      'createdAt',
      'revision',
    ],
    ['expiresAt'],
  );
  for (const key of ['callId', 'toolName', 'approvalId', 'ownerSessionId', 'taskId'] as const) {
    assertIdentifier(record[key], `approval.${key}`);
  }
  assertSafeMessage(record.summary, 'approval.summary');
  assertNonNegativeSafeInteger(record.createdAt, 'approval.createdAt');
  assertPositiveSafeInteger(record.revision, 'approval.revision');
  if (record.expiresAt !== undefined) assertNonNegativeSafeInteger(record.expiresAt, 'expiresAt');
  return record.taskId as string;
}

function assertBinding(value: unknown, label: string): UnknownRecord {
  const record = closedRecord(value, label, [
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
  ]);
  if (record.version !== '1') throw rpcError('invalid-rpc-payload', `${label}.version must be 1.`);
  for (const key of ['ownerSessionId', 'taskId', 'subagentSessionId'] as const) {
    assertIdentifier(record[key], `${label}.${key}`);
  }
  for (const key of ['executorName', 'definitionName', 'runnerId'] as const) {
    assertPatternToken(record[key], `${label}.${key}`, NAME_PATTERN);
  }
  for (const key of ['definitionVersion', 'runnerVersion', 'adapterStateVersion'] as const) {
    assertPatternToken(record[key], `${label}.${key}`, VERSION_PATTERN);
  }
  assertJsonValue(record.recoveryData, {
    maxBytes: DEFAULT_EXECUTOR_MAX_BINDING_BYTES,
    label: `${label}.recoveryData`,
  });
  return record;
}

function assertExecutorSnapshot(value: unknown, label: string): UnknownRecord {
  const record = closedRecord(value, label, ['taskId', 'state', 'binding', 'updatedAt']);
  assertIdentifier(record.taskId, `${label}.taskId`);
  if (typeof record.state !== 'string' || !TASK_STATES.has(record.state)) {
    throw rpcError('invalid-rpc-payload', `${label}.state is invalid.`);
  }
  const binding = assertBinding(record.binding, `${label}.binding`);
  if (binding.taskId !== record.taskId) {
    throw rpcError('invalid-rpc-payload', `${label}.binding taskId must match snapshot taskId.`);
  }
  assertNonNegativeSafeInteger(record.updatedAt, `${label}.updatedAt`);
  return record;
}

function assertTaskEvent(
  value: unknown,
  label: string,
): UnknownRecord & { readonly taskId: string; readonly sequence: number } {
  const record = closedRecord(
    value,
    label,
    [
      'eventId',
      'sequence',
      'type',
      'sessionId',
      'runId',
      'taskId',
      'path',
      'definition',
      'executor',
      'attempt',
      'timestamp',
      'data',
    ],
    ['parentTaskId', 'traceId', 'spanId'],
  );
  for (const key of ['eventId', 'sessionId', 'runId', 'taskId', 'executor'] as const) {
    assertIdentifier(record[key], `${label}.${key}`);
  }
  for (const key of ['parentTaskId', 'traceId', 'spanId'] as const) {
    if (record[key] !== undefined) assertIdentifier(record[key], `${label}.${key}`);
  }
  assertPositiveSafeInteger(record.sequence, `${label}.sequence`);
  assertPositiveSafeInteger(record.attempt, `${label}.attempt`);
  assertNonNegativeSafeInteger(record.timestamp, `${label}.timestamp`);
  if (typeof record.type !== 'string' || !EVENT_TYPES.has(record.type)) {
    throw rpcError('invalid-rpc-payload', `${label}.type is invalid.`);
  }
  if (!Array.isArray(record.path))
    throw rpcError('invalid-rpc-payload', `${label}.path is invalid.`);
  for (const segment of record.path) assertIdentifier(segment, `${label}.path segment`);
  assertDefinitionRef(record.definition, `${label}.definition`);
  assertSafeEventData(record.data, `${label}.data`);
  return record as UnknownRecord & { readonly taskId: string; readonly sequence: number };
}

function assertSafeEventData(value: unknown, label: string): void {
  const record = recordValue(value, label);
  for (const key of Object.keys(record)) {
    if (!SAFE_EVENT_DATA_KEYS.has(key)) {
      throw rpcError('invalid-rpc-payload', `${label} contains unsupported field ${key}.`);
    }
  }
  for (const key of ['status', 'reasonCode', 'approvalId', 'toolName', 'callId'] as const) {
    if (record[key] !== undefined) assertSafeMessage(record[key], `${label}.${key}`);
  }
  if (
    record.errorCode !== undefined &&
    (typeof record.errorCode !== 'string' || !SUBAGENT_ERROR_CODE_SET.has(record.errorCode))
  ) {
    throw rpcError('invalid-rpc-payload', `${label}.errorCode is invalid.`);
  }
  for (const key of ['length', 'durationMs', 'checkpointRevision'] as const) {
    if (record[key] !== undefined) assertNonNegativeSafeInteger(record[key], `${label}.${key}`);
  }
  if (record.usage !== undefined) assertUsage(record.usage, `${label}.usage`);
  if (record.outcomeUnknown !== undefined && typeof record.outcomeUnknown !== 'boolean') {
    throw rpcError('invalid-rpc-payload', `${label}.outcomeUnknown must be a boolean.`);
  }
}

function assertDefinitionRef(value: unknown, label: string): void {
  const record = closedRecord(value, label, ['name', 'version']);
  assertProtocolToken(record.name, `${label}.name`);
  assertProtocolToken(record.version, `${label}.version`);
}

function assertUsage(value: unknown, label: string): void {
  const record = closedRecord(
    value,
    label,
    ['turns', 'providerCalls'],
    ['inputTokens', 'outputTokens', 'cost'],
  );
  for (const key of ['turns', 'providerCalls', 'inputTokens', 'outputTokens'] as const) {
    if (record[key] !== undefined) assertNonNegativeSafeInteger(record[key], `${label}.${key}`);
  }
  if (
    record.cost !== undefined &&
    (typeof record.cost !== 'number' || !Number.isFinite(record.cost) || record.cost < 0)
  ) {
    throw rpcError('invalid-rpc-payload', `${label}.cost must be a non-negative finite number.`);
  }
}

function assertSafeError(value: unknown, label: string): void {
  const record = closedRecord(
    value,
    label,
    ['code', 'message', 'retryable'],
    ['causeCode', 'outcomeUnknown'],
  );
  assertProtocolToken(record.code, `${label}.code`);
  if (!SUBAGENT_ERROR_CODE_SET.has(record.code as string)) {
    throw rpcError('invalid-rpc-payload', `${label}.code is not a stable Subagent error code.`);
  }
  assertSafeMessage(record.message, `${label}.message`);
  if (typeof record.retryable !== 'boolean') {
    throw rpcError('invalid-rpc-payload', `${label}.retryable must be a boolean.`);
  }
  if (record.causeCode !== undefined) {
    assertProtocolToken(record.causeCode, `${label}.causeCode`);
  }
  if (record.outcomeUnknown !== undefined && typeof record.outcomeUnknown !== 'boolean') {
    throw rpcError('invalid-rpc-payload', `${label}.outcomeUnknown must be a boolean.`);
  }
}

function assertSafeMessage(value: unknown, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value !== value.trim() ||
    textEncoder.encode(value).byteLength > MAX_SAFE_MESSAGE_BYTES
  ) {
    throw rpcError(
      'invalid-rpc-payload',
      `${label} must be a trimmed 1-${MAX_SAFE_MESSAGE_BYTES} byte string.`,
    );
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value !== value.trim() ||
    containsControlCharacter(value) ||
    textEncoder.encode(value).byteLength > SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES
  ) {
    throw rpcError('invalid-rpc-routing', `${label} must be a bounded, trimmed identifier.`);
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function assertProtocolToken(
  value: unknown,
  label: string,
  maxBytes = SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !PROTOCOL_TOKEN_PATTERN.test(value) ||
    textEncoder.encode(value).byteLength > maxBytes
  ) {
    throw rpcError('invalid-rpc-payload', `${label} must be a bounded protocol token.`);
  }
}

function assertPatternToken(
  value: unknown,
  label: string,
  pattern: RegExp,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !pattern.test(value) ||
    textEncoder.encode(value).byteLength > SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES
  ) {
    throw rpcError('invalid-rpc-payload', `${label} must be a bounded protocol identity.`);
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw rpcError('invalid-rpc-payload', `${label} must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw rpcError('invalid-rpc-payload', `${label} must be a non-negative safe integer.`);
  }
}

function recordValue(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw rpcError('invalid-rpc-payload', `${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function closedRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  const record = recordValue(value, label);
  assertKeys(record, label, required, optional);
  return record;
}

function assertExactKeys(record: UnknownRecord, label: string, required: readonly string[]): void {
  assertKeys(record, label, required, []);
}

function assertKeys(
  record: UnknownRecord,
  label: string,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw rpcError('invalid-rpc-payload', `${label} is missing required field ${key}.`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw rpcError('invalid-rpc-payload', `${label} contains unsupported field ${key}.`);
    }
  }
}

function assertStructuralLimits(value: JsonValue, options: ResolvedRpcOptions): void {
  let nodes = 0;
  const stack: Array<{ readonly value: JsonValue; readonly depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop() as { readonly value: JsonValue; readonly depth: number };
    nodes += 1;
    if (nodes > options.maxJsonNodes || current.depth > options.maxJsonDepth) {
      throw rpcError(
        'rpc-limit-exceeded',
        'Subagent RPC payload exceeds the configured JSON structural limits.',
      );
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as { readonly [key: string]: JsonValue });
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
}

function resolveRpcOptions(options: SubAgentTransportRpcValidationOptions): ResolvedRpcOptions {
  const maxFrameBytes = positiveOption(
    options.maxFrameBytes,
    DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
    'maxFrameBytes',
  );
  const maxCanonicalBytes = positiveOption(
    options.maxCanonicalBytes,
    maxFrameBytes,
    'maxCanonicalBytes',
  );
  if (maxCanonicalBytes > maxFrameBytes) {
    throw new RangeError('maxCanonicalBytes must not exceed maxFrameBytes.');
  }
  return Object.freeze({
    maxFrameBytes,
    maxCanonicalBytes,
    maxJsonDepth: nonNegativeOption(
      options.maxJsonDepth,
      DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
      'maxJsonDepth',
    ),
    maxJsonNodes: positiveOption(
      options.maxJsonNodes,
      DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
      'maxJsonNodes',
    ),
  });
}

function positiveOption(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

function nonNegativeOption(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return resolved;
}

function rpcError(
  reason: ConstructorParameters<typeof SubAgentTransportRpcError>[0],
  message: string,
  cause?: unknown,
): SubAgentTransportRpcError {
  return new SubAgentTransportRpcError(
    reason,
    message,
    cause === undefined ? undefined : { cause },
  );
}
