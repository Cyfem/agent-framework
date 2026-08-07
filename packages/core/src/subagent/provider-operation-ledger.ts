import { canonicalJsonSha256, canonicalizeJson, parseJsonValue, type JsonValue } from './json';
import { createResourceNotFoundError, SUBAGENT_ERROR_CODES, SubAgentRuntimeError } from './errors';
import { providerOperationFailpointForTest } from './provider-operation-ledger-internals';
import {
  assertValidDeadline,
  awaitWithAbort,
  createAbortScope,
  throwIfAborted,
} from '../llm/base/abort';

export const PROVIDER_OPERATION_RECORD_VERSION = '1' as const;
export const PROVIDER_OPERATION_REQUEST_ADMISSION_RECORD_VERSION = '1' as const;
export const DEFAULT_PROVIDER_OPERATION_CAS_RETRIES = 64;
export const DEFAULT_MEMORY_PROVIDER_OPERATION_LEDGER_CAPACITY = 10_000;

export type ProviderOperationPhase = 'prepared' | 'in_flight' | 'completed' | 'outcome_unknown';

/** Trusted host identity. None of these values belongs in a provider request body. */
export interface ProviderOperationIdentity {
  readonly ownerSessionId: string;
  readonly taskId: string;
  readonly providerOperationId: string;
}

/**
 * Persistable authoritative record for one provider operation.
 *
 * The request itself, credentials, provider response metadata, raw SDK errors and provider error
 * bodies are deliberately absent. `reply` must already be a normalized, JSON-safe controller
 * reply; raw SDK responses do not belong in this ledger.
 */
export interface ProviderOperationRecordV1 extends ProviderOperationIdentity {
  readonly recordVersion: typeof PROVIDER_OPERATION_RECORD_VERSION;
  readonly requestHash: string;
  readonly phase: ProviderOperationPhase;
  readonly revision: number;
  readonly reply?: JsonValue;
  readonly preparedAt: number;
  readonly updatedAt: number;
  readonly terminalAt?: number;
}

export type ProviderOperationRequestAdmissionPhase =
  | 'admitted'
  | 'budget_reserved'
  | 'budget_rejected';

/**
 * Durable request-admission state which is intentionally separate from provider state.
 *
 * `admitted` is written after the child checkpoint ACK and before the budget callback. The
 * provider record is not created until this record reaches `budget_reserved`, preserving the
 * required ACK -> request admission -> budget -> provider prepared/in_flight ordering.
 */
export interface ProviderOperationRequestAdmissionRecordV1 extends ProviderOperationIdentity {
  readonly recordVersion: typeof PROVIDER_OPERATION_REQUEST_ADMISSION_RECORD_VERSION;
  readonly requestHash: string;
  readonly phase: ProviderOperationRequestAdmissionPhase;
  readonly revision: number;
  readonly admittedAt: number;
  readonly updatedAt: number;
  /** Sanitized JSON-safe failure persisted only when the budget reservation is rejected. */
  readonly failure?: JsonValue;
}

/** Cancellation/deadline propagated to every persistence operation. */
export interface ProviderOperationLedgerIoContext {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

/** Atomic persistence SPI. Implementations must make `create` and `compareAndSet` authoritative. */
export interface ProviderOperationLedgerStore {
  load(
    identity: ProviderOperationIdentity,
    context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<ProviderOperationRecordV1 | undefined>;
  create(
    record: ProviderOperationRecordV1,
    context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<boolean>;
  compareAndSet(
    identity: ProviderOperationIdentity,
    expectedRevision: number,
    next: ProviderOperationRecordV1,
    context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<boolean>;
  loadRequestAdmission(
    identity: ProviderOperationIdentity,
    context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<ProviderOperationRequestAdmissionRecordV1 | undefined>;
  createRequestAdmission(
    record: ProviderOperationRequestAdmissionRecordV1,
    context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<boolean>;
  compareAndSetRequestAdmission(
    identity: ProviderOperationIdentity,
    expectedRevision: number,
    next: ProviderOperationRequestAdmissionRecordV1,
    context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<boolean>;
}

export interface ProviderOperationPreparation {
  readonly created: boolean;
  readonly record: Readonly<ProviderOperationRecordV1>;
}

/** Capability returned only to the caller that won the prepared -> in_flight CAS. */
export interface ProviderOperationAdmission extends ProviderOperationIdentity {
  readonly requestHash: string;
  readonly revision: number;
}

/** Capability returned only to the handler that durably created model.request admission. */
export interface ProviderOperationRequestAdmission extends ProviderOperationIdentity {
  readonly requestHash: string;
  readonly revision: number;
}

export type ProviderOperationRequestAdmissionResult =
  | {
      readonly status: 'admitted';
      readonly admission: Readonly<ProviderOperationRequestAdmission>;
      readonly record: Readonly<ProviderOperationRequestAdmissionRecordV1>;
    }
  | {
      readonly status: 'observed';
      readonly record: Readonly<ProviderOperationRequestAdmissionRecordV1>;
    }
  | ProviderOperationBudgetReservationResult;

/** Result of an explicit host-authorized takeover of a stranded request admission. */
export type ProviderOperationRequestAdmissionRecoveryResult =
  | {
      readonly status: 'recovered';
      readonly admission: Readonly<ProviderOperationRequestAdmission>;
      readonly record: Readonly<ProviderOperationRequestAdmissionRecordV1>;
    }
  | {
      readonly status: 'observed';
      readonly record: Readonly<ProviderOperationRequestAdmissionRecordV1>;
    }
  | ProviderOperationBudgetReservationResult;

export type ProviderOperationBudgetReservationResult =
  | {
      readonly status: 'budget_reserved';
      readonly record: Readonly<ProviderOperationRequestAdmissionRecordV1>;
    }
  | {
      readonly status: 'budget_rejected';
      readonly failure: JsonValue;
      readonly record: Readonly<ProviderOperationRequestAdmissionRecordV1>;
    };

export type ProviderOperationAdmissionResult =
  | {
      readonly status: 'admitted';
      readonly admission: Readonly<ProviderOperationAdmission>;
      readonly record: Readonly<ProviderOperationRecordV1>;
    }
  | {
      readonly status: 'in_flight';
      readonly record: Readonly<ProviderOperationRecordV1>;
    }
  | {
      readonly status: 'completed';
      readonly reply: JsonValue;
      readonly record: Readonly<ProviderOperationRecordV1>;
    }
  | {
      readonly status: 'outcome_unknown';
      readonly record: Readonly<ProviderOperationRecordV1>;
    };

export type ProviderOperationTerminalResult =
  | {
      readonly status: 'completed';
      readonly replayed: boolean;
      readonly reply: JsonValue;
      readonly record: Readonly<ProviderOperationRecordV1>;
    }
  | {
      readonly status: 'outcome_unknown';
      readonly record: Readonly<ProviderOperationRecordV1>;
    };

export type ProviderOperationRecoveryResult =
  | ProviderOperationTerminalResult
  | {
      readonly status: 'prepared';
      readonly record: Readonly<ProviderOperationRecordV1>;
    };

export type ProviderOperationExecutionResult =
  | ProviderOperationTerminalResult
  | {
      readonly status: 'in_flight';
      readonly record: Readonly<ProviderOperationRecordV1>;
    };

export interface ExecuteProviderOperationOptions {
  readonly identity: ProviderOperationIdentity;
  readonly request: JsonValue;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  /**
   * Must resolve to an already-sanitized reply. A rejection is conservatively terminalized as
   * outcome_unknown without persisting the rejection or any raw provider data.
   */
  readonly invoke: (admission: Readonly<ProviderOperationAdmission>) => Promise<JsonValue>;
}

export interface ProviderOperationLedgerOptions {
  readonly store: ProviderOperationLedgerStore;
  readonly now?: () => number;
  readonly maxCasRetries?: number;
}

export interface MemoryProviderOperationLedgerStoreOptions {
  readonly initialRecords?: Iterable<ProviderOperationRecordV1>;
  readonly initialRequestAdmissions?: Iterable<ProviderOperationRequestAdmissionRecordV1>;
  readonly operationCapacity?: number;
  readonly requestAdmissionCapacity?: number;
}

export interface MemoryProviderOperationLedgerStoreDiagnostics {
  readonly operationRecords: number;
  readonly requestAdmissionRecords: number;
  readonly operationCapacity: number;
  readonly requestAdmissionCapacity: number;
}

const BASE_RECORD_KEYS = Object.freeze([
  'recordVersion',
  'ownerSessionId',
  'taskId',
  'providerOperationId',
  'requestHash',
  'phase',
  'revision',
  'preparedAt',
  'updatedAt',
] as const);
const BASE_REQUEST_ADMISSION_RECORD_KEYS = Object.freeze([
  'recordVersion',
  'ownerSessionId',
  'taskId',
  'providerOperationId',
  'requestHash',
  'phase',
  'revision',
  'admittedAt',
  'updatedAt',
] as const);
const SHA256 = /^[0-9a-f]{64}$/u;
const textEncoder = new TextEncoder();
const SAFE_ERROR_CODES = new Set<string>(SUBAGENT_ERROR_CODES);

function providerLedgerError(
  code: 'IDEMPOTENCY_CONFLICT' | 'INVALID_STATE_TRANSITION' | 'LIMIT_EXCEEDED' | 'INTERNAL_ERROR',
  message: string,
  options: { readonly retryable?: boolean; readonly causeCode?: string } = {},
): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.causeCode === undefined ? {} : { causeCode: options.causeCode }),
  });
}

function resolveMemoryCapacity(value: number | undefined, label: string): number {
  const capacity = value ?? DEFAULT_MEMORY_PROVIDER_OPERATION_LEDGER_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return capacity;
}

function memoryCapacityError(kind: 'operation' | 'request-admission'): SubAgentRuntimeError {
  return providerLedgerError(
    'LIMIT_EXCEEDED',
    `The Memory provider ${kind} ledger capacity is exhausted.`,
    {
      causeCode:
        kind === 'operation'
          ? 'PROVIDER_OPERATION_MEMORY_CAPACITY_EXHAUSTED'
          : 'PROVIDER_REQUEST_ADMISSION_MEMORY_CAPACITY_EXHAUSTED',
    },
  );
}

function assertIdentifier(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value !== value.trim() ||
    textEncoder.encode(value).byteLength > 256 ||
    containsControlCharacter(value)
  ) {
    throw new TypeError(`${label} must be a trimmed, bounded identifier without controls.`);
  }
  // Reuse the strict JSON boundary to reject lone surrogates without retaining the identifier.
  canonicalizeJson(value);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function normalizeIdentity(
  identity: ProviderOperationIdentity,
): Readonly<ProviderOperationIdentity> {
  assertIdentifier(identity.ownerSessionId, 'ownerSessionId');
  assertIdentifier(identity.taskId, 'taskId');
  assertIdentifier(identity.providerOperationId, 'providerOperationId');
  return Object.freeze({
    ownerSessionId: identity.ownerSessionId,
    taskId: identity.taskId,
    providerOperationId: identity.providerOperationId,
  });
}

function identityEquals(
  left: ProviderOperationIdentity,
  right: ProviderOperationIdentity,
): boolean {
  return (
    left.ownerSessionId === right.ownerSessionId &&
    left.taskId === right.taskId &&
    left.providerOperationId === right.providerOperationId
  );
}

function identityKey(identity: ProviderOperationIdentity): string {
  return canonicalizeJson({
    ownerSessionId: identity.ownerSessionId,
    providerOperationId: identity.providerOperationId,
    taskId: identity.taskId,
  });
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreezeJson(item);
  }
  return Object.freeze(value);
}

function ownedJson(value: JsonValue): JsonValue {
  return deepFreezeJson(parseJsonValue(canonicalizeJson(value)));
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

function assertClosedBudgetFailure(value: JsonValue | undefined): void {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('A rejected budget reservation requires a safe error descriptor.');
  }
  const descriptor = value as Readonly<Record<string, JsonValue>>;
  const required = ['code', 'message', 'retryable'];
  const allowed = new Set([...required, 'causeCode', 'outcomeUnknown']);
  const keys = Object.keys(descriptor);
  if (
    required.some((key) => !Object.hasOwn(descriptor, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    !SAFE_ERROR_CODES.has(descriptor.code as string) ||
    typeof descriptor.message !== 'string' ||
    descriptor.message.length < 1 ||
    descriptor.message !== descriptor.message.trim() ||
    textEncoder.encode(descriptor.message).byteLength > 4_096 ||
    typeof descriptor.retryable !== 'boolean' ||
    (descriptor.causeCode !== undefined &&
      (typeof descriptor.causeCode !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,127}$/u.test(descriptor.causeCode))) ||
    (descriptor.outcomeUnknown !== undefined && typeof descriptor.outcomeUnknown !== 'boolean')
  ) {
    throw new TypeError('A rejected budget reservation contains an unsafe error descriptor.');
  }
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Provider operation revision must be a non-negative safe integer.');
  }
}

function assertClosedRecordKeys(record: ProviderOperationRecordV1): void {
  const expected = new Set<string>(BASE_RECORD_KEYS);
  if (record.phase === 'completed') expected.add('reply');
  if (record.phase === 'completed' || record.phase === 'outcome_unknown') {
    expected.add('terminalAt');
  }
  const actual = Reflect.ownKeys(record);
  if (
    actual.some((key) => typeof key !== 'string' || !expected.has(key)) ||
    actual.length !== expected.size
  ) {
    throw new TypeError('Provider operation record contains unsupported or missing fields.');
  }
}

/** Validates, clones and deeply freezes a record returned by any persistence implementation. */
export function normalizeProviderOperationRecord(
  value: ProviderOperationRecordV1,
): Readonly<ProviderOperationRecordV1> {
  const cloned = ownedJson(value as unknown as JsonValue) as unknown as ProviderOperationRecordV1;
  assertClosedRecordKeys(cloned);
  normalizeIdentity(cloned);
  if (cloned.recordVersion !== PROVIDER_OPERATION_RECORD_VERSION) {
    throw new TypeError('Unsupported provider operation record version.');
  }
  if (!SHA256.test(cloned.requestHash)) {
    throw new TypeError('Provider operation requestHash must be a lowercase SHA-256 digest.');
  }
  if (
    cloned.phase !== 'prepared' &&
    cloned.phase !== 'in_flight' &&
    cloned.phase !== 'completed' &&
    cloned.phase !== 'outcome_unknown'
  ) {
    throw new TypeError('Provider operation phase is invalid.');
  }
  assertRevision(cloned.revision);
  assertTimestamp(cloned.preparedAt, 'preparedAt');
  assertTimestamp(cloned.updatedAt, 'updatedAt');
  if (cloned.updatedAt < cloned.preparedAt) {
    throw new TypeError('Provider operation updatedAt cannot precede preparedAt.');
  }
  if (cloned.phase === 'prepared' && cloned.revision !== 0) {
    throw new TypeError('A prepared provider operation must use revision zero.');
  }
  if (cloned.phase === 'in_flight' && cloned.revision !== 1) {
    throw new TypeError('An in-flight provider operation must use revision one.');
  }
  if (cloned.phase === 'completed' || cloned.phase === 'outcome_unknown') {
    if (cloned.revision !== 2 || cloned.terminalAt === undefined) {
      throw new TypeError('A terminal provider operation must have a terminal revision and time.');
    }
    assertTimestamp(cloned.terminalAt, 'terminalAt');
    if (cloned.terminalAt !== cloned.updatedAt) {
      throw new TypeError('Provider operation terminal timestamps are invalid.');
    }
  }
  return cloned;
}

function assertClosedRequestAdmissionRecordKeys(
  record: ProviderOperationRequestAdmissionRecordV1,
): void {
  const expected = new Set<string>(BASE_REQUEST_ADMISSION_RECORD_KEYS);
  if (record.phase === 'budget_rejected') expected.add('failure');
  const actual = Reflect.ownKeys(record);
  if (
    actual.some((key) => typeof key !== 'string' || !expected.has(key)) ||
    actual.length !== expected.size
  ) {
    throw new TypeError(
      'Provider operation request admission contains unsupported or missing fields.',
    );
  }
}

/** Validates, clones and deeply freezes a request-admission record from persistence. */
export function normalizeProviderOperationRequestAdmissionRecord(
  value: ProviderOperationRequestAdmissionRecordV1,
): Readonly<ProviderOperationRequestAdmissionRecordV1> {
  const cloned = ownedJson(
    value as unknown as JsonValue,
  ) as unknown as ProviderOperationRequestAdmissionRecordV1;
  assertClosedRequestAdmissionRecordKeys(cloned);
  normalizeIdentity(cloned);
  if (cloned.recordVersion !== PROVIDER_OPERATION_REQUEST_ADMISSION_RECORD_VERSION) {
    throw new TypeError('Unsupported provider operation request-admission record version.');
  }
  if (!SHA256.test(cloned.requestHash)) {
    throw new TypeError('Provider operation request-admission hash must be a SHA-256 digest.');
  }
  if (
    cloned.phase !== 'admitted' &&
    cloned.phase !== 'budget_reserved' &&
    cloned.phase !== 'budget_rejected'
  ) {
    throw new TypeError('Provider operation request-admission phase is invalid.');
  }
  assertRevision(cloned.revision);
  assertTimestamp(cloned.admittedAt, 'request admission admittedAt');
  assertTimestamp(cloned.updatedAt, 'request admission updatedAt');
  if (cloned.updatedAt < cloned.admittedAt) {
    throw new TypeError('Provider operation request-admission time cannot move backwards.');
  }
  if (
    (cloned.phase === 'budget_reserved' || cloned.phase === 'budget_rejected') &&
    cloned.revision < 1
  ) {
    throw new TypeError('A settled budget reservation must use a positive revision.');
  }
  if (cloned.phase === 'budget_rejected') assertClosedBudgetFailure(cloned.failure);
  return cloned;
}

function assertSameRequest(record: ProviderOperationRecordV1, requestHash: string): void {
  if (record.requestHash !== requestHash) {
    throw providerLedgerError(
      'IDEMPOTENCY_CONFLICT',
      'The provider operation ID was reused with a different canonical request.',
    );
  }
}

function assertSameAdmissionRequest(
  record: ProviderOperationRequestAdmissionRecordV1,
  requestHash: string,
): void {
  if (record.requestHash !== requestHash) {
    throw providerLedgerError(
      'IDEMPOTENCY_CONFLICT',
      'The provider operation ID was admitted with a different canonical request.',
    );
  }
}

function assertStoreIdentity(
  record: ProviderOperationRecordV1,
  identity: ProviderOperationIdentity,
): void {
  if (!identityEquals(record, identity)) {
    throw providerLedgerError(
      'INTERNAL_ERROR',
      'The provider operation store returned a record for a different identity.',
    );
  }
}

function assertAdmissionStoreIdentity(
  record: ProviderOperationRequestAdmissionRecordV1,
  identity: ProviderOperationIdentity,
): void {
  if (!identityEquals(record, identity)) {
    throw providerLedgerError(
      'INTERNAL_ERROR',
      'The provider operation store returned request admission for a different identity.',
    );
  }
}

function assertTransition(
  previous: ProviderOperationRecordV1,
  next: ProviderOperationRecordV1,
): void {
  if (
    !identityEquals(previous, next) ||
    previous.recordVersion !== next.recordVersion ||
    previous.requestHash !== next.requestHash ||
    previous.preparedAt !== next.preparedAt ||
    next.revision !== previous.revision + 1 ||
    next.updatedAt < previous.updatedAt
  ) {
    throw providerLedgerError(
      'INVALID_STATE_TRANSITION',
      'A provider operation transition cannot change immutable identity or skip a revision.',
    );
  }
  const valid =
    (previous.phase === 'prepared' && next.phase === 'in_flight') ||
    (previous.phase === 'in_flight' &&
      (next.phase === 'completed' || next.phase === 'outcome_unknown'));
  if (!valid) {
    throw providerLedgerError(
      'INVALID_STATE_TRANSITION',
      'Provider operation phases must advance prepared -> in_flight -> terminal.',
    );
  }
}

function assertRequestAdmissionTransition(
  previous: ProviderOperationRequestAdmissionRecordV1,
  next: ProviderOperationRequestAdmissionRecordV1,
): void {
  if (
    !identityEquals(previous, next) ||
    previous.recordVersion !== next.recordVersion ||
    previous.requestHash !== next.requestHash ||
    previous.admittedAt !== next.admittedAt ||
    previous.phase !== 'admitted' ||
    (next.phase !== 'admitted' &&
      next.phase !== 'budget_reserved' &&
      next.phase !== 'budget_rejected') ||
    next.revision !== previous.revision + 1 ||
    next.updatedAt < previous.updatedAt
  ) {
    throw providerLedgerError(
      'INVALID_STATE_TRANSITION',
      'A request admission may only be taken over or settle once as budget reserved or rejected.',
    );
  }
}

function terminalAdmissionResult(
  record: Readonly<ProviderOperationRecordV1>,
): Exclude<ProviderOperationAdmissionResult, { readonly status: 'admitted' | 'in_flight' }> {
  if (record.phase === 'completed') {
    return Object.freeze({
      status: 'completed',
      reply: record.reply as JsonValue,
      record,
    });
  }
  return Object.freeze({ status: 'outcome_unknown', record });
}

function budgetReservationResult(
  record: Readonly<ProviderOperationRequestAdmissionRecordV1>,
): ProviderOperationBudgetReservationResult {
  if (record.phase === 'budget_reserved') {
    return Object.freeze({ status: 'budget_reserved', record });
  }
  if (record.phase === 'budget_rejected') {
    return Object.freeze({
      status: 'budget_rejected',
      failure: record.failure as JsonValue,
      record,
    });
  }
  throw providerLedgerError(
    'INVALID_STATE_TRANSITION',
    'An unsettled request admission cannot be projected as a budget reservation.',
  );
}

function terminalResultFromRecord(
  record: Readonly<ProviderOperationRecordV1>,
  replayed: boolean,
): ProviderOperationTerminalResult {
  if (record.phase === 'completed') {
    return Object.freeze({
      status: 'completed',
      replayed,
      reply: record.reply as JsonValue,
      record,
    });
  }
  if (record.phase === 'outcome_unknown') {
    return Object.freeze({ status: 'outcome_unknown', record });
  }
  throw providerLedgerError(
    'INVALID_STATE_TRANSITION',
    'A non-terminal provider operation cannot be projected as terminal.',
  );
}

function executionFromAdmission(
  result: Exclude<ProviderOperationAdmissionResult, { readonly status: 'admitted' }>,
): ProviderOperationExecutionResult {
  if (result.status === 'completed') {
    return Object.freeze({
      status: 'completed',
      replayed: true,
      reply: result.reply,
      record: result.record,
    });
  }
  return result;
}

/**
 * Authoritative provider-operation controller. The provider must only be invoked after `admit`
 * returns `status: 'admitted'`; observing `in_flight` never authorizes a resend.
 */
export class ProviderOperationLedger {
  readonly #store: ProviderOperationLedgerStore;
  readonly #now: () => number;
  readonly #maxCasRetries: number;

  constructor(options: ProviderOperationLedgerOptions) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#maxCasRetries = options.maxCasRetries ?? DEFAULT_PROVIDER_OPERATION_CAS_RETRIES;
    if (!Number.isSafeInteger(this.#maxCasRetries) || this.#maxCasRetries < 1) {
      throw new TypeError('maxCasRetries must be a positive safe integer.');
    }
  }

  async load(
    identityInput: ProviderOperationIdentity,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<Readonly<ProviderOperationRecordV1> | undefined> {
    const identity = normalizeIdentity(identityInput);
    const loaded = await this.#storeIo((context) => this.#store.load(identity, context), io);
    if (loaded === undefined) return undefined;
    const record = normalizeProviderOperationRecord(loaded);
    assertStoreIdentity(record, identity);
    return record;
  }

  async loadRequestAdmission(
    identityInput: ProviderOperationIdentity,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<Readonly<ProviderOperationRequestAdmissionRecordV1> | undefined> {
    const identity = normalizeIdentity(identityInput);
    const loaded = await this.#storeIo(
      (context) => this.#store.loadRequestAdmission(identity, context),
      io,
    );
    if (loaded === undefined) return undefined;
    const record = normalizeProviderOperationRequestAdmissionRecord(loaded);
    assertAdmissionStoreIdentity(record, identity);
    return record;
  }

  /**
   * Durably admits the canonical model request before any budget callback is invoked. Only the
   * creator receives the capability that may settle the shared budget reservation.
   */
  async admitRequest(
    identityInput: ProviderOperationIdentity,
    request: JsonValue,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<ProviderOperationRequestAdmissionResult> {
    const identity = normalizeIdentity(identityInput);
    const requestHash = canonicalJsonSha256(request);
    const existing = await this.loadRequestAdmission(identity, io);
    if (existing !== undefined) {
      assertSameAdmissionRequest(existing, requestHash);
      if (existing.phase === 'admitted') {
        return Object.freeze({ status: 'observed', record: existing });
      }
      return budgetReservationResult(existing);
    }

    const now = this.#readClock();
    const admitted = normalizeProviderOperationRequestAdmissionRecord({
      recordVersion: PROVIDER_OPERATION_REQUEST_ADMISSION_RECORD_VERSION,
      ...identity,
      requestHash,
      phase: 'admitted',
      revision: 0,
      admittedAt: now,
      updatedAt: now,
    });
    if (
      await this.#storeIo((context) => this.#store.createRequestAdmission(admitted, context), io)
    ) {
      const admission = Object.freeze({
        ...identity,
        requestHash,
        revision: admitted.revision,
      });
      return Object.freeze({ status: 'admitted', admission, record: admitted });
    }

    const raced = await this.loadRequestAdmission(identity, io);
    if (raced === undefined) {
      throw providerLedgerError(
        'INTERNAL_ERROR',
        'The provider operation store lost a request-admission create race.',
      );
    }
    assertSameAdmissionRequest(raced, requestHash);
    if (raced.phase === 'admitted') {
      return Object.freeze({ status: 'observed', record: raced });
    }
    return budgetReservationResult(raced);
  }

  /**
   * Explicit host-only recovery for an admission whose creator is known to be gone. Ordinary
   * replay must keep using `admitRequest()`, which only observes an unsettled admission and cannot
   * steal it. A successful CAS advances the admission revision and invalidates the old capability;
   * concurrent recovery/settlement callers project the first durable CAS winner.
   */
  async recoverRequestAdmission(
    identityInput: ProviderOperationIdentity,
    request: JsonValue,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<ProviderOperationRequestAdmissionRecoveryResult> {
    const identity = normalizeIdentity(identityInput);
    const requestHash = canonicalJsonSha256(request);
    const current = await this.#loadRequiredRequestAdmission(identity, io);
    assertSameAdmissionRequest(current, requestHash);
    if (current.phase !== 'admitted') return budgetReservationResult(current);

    const now = this.#readClock(current.updatedAt);
    const next = normalizeProviderOperationRequestAdmissionRecord({
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
    });
    assertRequestAdmissionTransition(current, next);
    if (
      await this.#storeIo(
        (context) =>
          this.#store.compareAndSetRequestAdmission(identity, current.revision, next, context),
        io,
      )
    ) {
      const admission = Object.freeze({
        ...identity,
        requestHash,
        revision: next.revision,
      });
      return Object.freeze({ status: 'recovered', admission, record: next });
    }

    const winner = await this.#loadRequiredRequestAdmission(identity, io);
    assertSameAdmissionRequest(winner, requestHash);
    if (winner.phase === 'admitted') {
      return Object.freeze({ status: 'observed', record: winner });
    }
    return budgetReservationResult(winner);
  }

  async confirmBudgetReservation(
    admissionInput: ProviderOperationRequestAdmission,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<ProviderOperationBudgetReservationResult> {
    return this.#settleBudgetReservation(admissionInput, 'budget_reserved', undefined, io);
  }

  async rejectBudgetReservation(
    admissionInput: ProviderOperationRequestAdmission,
    failureInput: JsonValue,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<ProviderOperationBudgetReservationResult> {
    const failure = ownedJson(failureInput);
    return this.#settleBudgetReservation(admissionInput, 'budget_rejected', failure, io);
  }

  async prepare(
    identityInput: ProviderOperationIdentity,
    request: JsonValue,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<Readonly<ProviderOperationPreparation>> {
    const identity = normalizeIdentity(identityInput);
    // Hash synchronously before touching persistence so a caller cannot mutate the request mid-call.
    const requestHash = canonicalJsonSha256(request);
    const existing = await this.load(identity, io);
    if (existing !== undefined) {
      assertSameRequest(existing, requestHash);
      return Object.freeze({ created: false, record: existing });
    }

    const now = this.#readClock();
    const prepared = normalizeProviderOperationRecord({
      recordVersion: PROVIDER_OPERATION_RECORD_VERSION,
      ...identity,
      requestHash,
      phase: 'prepared',
      revision: 0,
      preparedAt: now,
      updatedAt: now,
    });
    if (await this.#storeIo((context) => this.#store.create(prepared, context), io)) {
      return Object.freeze({ created: true, record: prepared });
    }

    const raced = await this.load(identity, io);
    if (raced === undefined) {
      throw providerLedgerError(
        'INTERNAL_ERROR',
        'The provider operation store lost an authoritative create race.',
      );
    }
    assertSameRequest(raced, requestHash);
    return Object.freeze({ created: false, record: raced });
  }

  async admit(
    identityInput: ProviderOperationIdentity,
    request: JsonValue,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<ProviderOperationAdmissionResult> {
    const identity = normalizeIdentity(identityInput);
    const requestHash = canonicalJsonSha256(request);
    let current = (await this.prepare(identity, request, io)).record;

    for (let attempt = 0; attempt < this.#maxCasRetries; attempt += 1) {
      assertSameRequest(current, requestHash);
      if (current.phase === 'in_flight') {
        return Object.freeze({ status: 'in_flight', record: current });
      }
      if (current.phase === 'completed' || current.phase === 'outcome_unknown') {
        return terminalAdmissionResult(current);
      }

      const now = this.#readClock(current.updatedAt);
      const next = normalizeProviderOperationRecord({
        ...current,
        phase: 'in_flight',
        revision: current.revision + 1,
        updatedAt: now,
      });
      assertTransition(current, next);
      if (
        await this.#storeIo(
          (context) => this.#store.compareAndSet(identity, current.revision, next, context),
          io,
        )
      ) {
        const admission = Object.freeze({
          ...identity,
          requestHash,
          revision: next.revision,
        });
        return Object.freeze({ status: 'admitted', admission, record: next });
      }
      current = await this.#loadRequired(identity, io);
    }
    throw this.#casExhausted();
  }

  async complete(
    admissionInput: ProviderOperationAdmission,
    replyInput: JsonValue,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<ProviderOperationTerminalResult> {
    const admission = this.#normalizeAdmission(admissionInput);
    // Own the reply before the first await. Provider SDK objects and mutable caller aliases stop here.
    const reply = ownedJson(replyInput);
    let current = await this.#loadRequired(admission, io);

    for (let attempt = 0; attempt < this.#maxCasRetries; attempt += 1) {
      assertSameRequest(current, admission.requestHash);
      if (current.phase === 'completed') {
        return Object.freeze({
          status: 'completed',
          replayed: true,
          reply: current.reply as JsonValue,
          record: current,
        });
      }
      if (current.phase === 'outcome_unknown') {
        return Object.freeze({ status: 'outcome_unknown', record: current });
      }
      if (current.phase !== 'in_flight' || current.revision !== admission.revision) {
        throw providerLedgerError(
          'INVALID_STATE_TRANSITION',
          'Only the active provider-operation admission may complete the request.',
        );
      }

      const now = this.#readClock(current.updatedAt);
      const next = normalizeProviderOperationRecord({
        ...current,
        phase: 'completed',
        revision: current.revision + 1,
        reply,
        updatedAt: now,
        terminalAt: now,
      });
      assertTransition(current, next);
      if (
        await this.#storeIo(
          (context) => this.#store.compareAndSet(admission, current.revision, next, context),
          io,
        )
      ) {
        return Object.freeze({ status: 'completed', replayed: false, reply, record: next });
      }
      current = await this.#loadRequired(admission, io);
    }
    throw this.#casExhausted();
  }

  async markOutcomeUnknown(
    admissionInput: ProviderOperationAdmission,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<ProviderOperationTerminalResult> {
    const admission = this.#normalizeAdmission(admissionInput);
    let current = await this.#loadRequired(admission, io);

    for (let attempt = 0; attempt < this.#maxCasRetries; attempt += 1) {
      assertSameRequest(current, admission.requestHash);
      if (current.phase === 'completed' || current.phase === 'outcome_unknown') {
        return terminalResultFromRecord(current, current.phase === 'completed');
      }
      if (current.phase !== 'in_flight' || current.revision !== admission.revision) {
        throw providerLedgerError(
          'INVALID_STATE_TRANSITION',
          'Only the active provider-operation admission may mark an unknown outcome.',
        );
      }
      const next = this.#outcomeUnknownRecord(current);
      if (
        await this.#storeIo(
          (context) => this.#store.compareAndSet(admission, current.revision, next, context),
          io,
        )
      ) {
        return terminalResultFromRecord(next, false);
      }
      current = await this.#loadRequired(admission, io);
    }
    throw this.#casExhausted();
  }

  /**
   * Recovery oracle. A prepared operation remains retryable; an in-flight operation becomes an
   * irreversible unknown outcome because the restored host cannot prove whether the SDK ran.
   */
  async recoverInFlight(
    identityInput: ProviderOperationIdentity,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<ProviderOperationRecoveryResult> {
    const identity = normalizeIdentity(identityInput);
    let current = await this.#loadRequired(identity, io);
    for (let attempt = 0; attempt < this.#maxCasRetries; attempt += 1) {
      if (current.phase === 'prepared') {
        return Object.freeze({ status: 'prepared', record: current });
      }
      if (current.phase === 'completed' || current.phase === 'outcome_unknown') {
        return terminalResultFromRecord(current, current.phase === 'completed');
      }
      const next = this.#outcomeUnknownRecord(current);
      if (
        await this.#storeIo(
          (context) => this.#store.compareAndSet(identity, current.revision, next, context),
          io,
        )
      ) {
        return terminalResultFromRecord(next, false);
      }
      current = await this.#loadRequired(identity, io);
    }
    throw this.#casExhausted();
  }

  async execute(
    options: ExecuteProviderOperationOptions,
  ): Promise<ProviderOperationExecutionResult> {
    // Own the canonical request once so mutation while persistence or a failpoint is awaiting cannot
    // turn one execution attempt into two different request hashes.
    const request = ownedJson(options.request);
    const failpoint = providerOperationFailpointForTest(this);
    const io = Object.freeze({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
    });
    const preparation = await this.prepare(options.identity, request, io);
    if (preparation.record.phase === 'completed') {
      return Object.freeze({
        status: 'completed',
        replayed: true,
        reply: preparation.record.reply as JsonValue,
        record: preparation.record,
      });
    }
    if (preparation.record.phase === 'outcome_unknown') {
      return Object.freeze({ status: 'outcome_unknown', record: preparation.record });
    }
    if (preparation.record.phase === 'in_flight') {
      return Object.freeze({ status: 'in_flight', record: preparation.record });
    }
    await failpoint?.('after_prepare_before_in_flight', preparation.record);

    const admitted = await this.admit(options.identity, request, io);
    if (admitted.status !== 'admitted') return executionFromAdmission(admitted);
    await failpoint?.('after_in_flight_before_provider', admitted.record);

    let reply: JsonValue;
    try {
      reply = await options.invoke(admitted.admission);
    } catch {
      return this.markOutcomeUnknown(admitted.admission, io);
    }

    await failpoint?.('after_provider_before_complete', admitted.record);
    const completed = await this.complete(admitted.admission, reply, io);
    if (completed.status === 'completed') {
      await failpoint?.('after_complete', completed.record);
    }
    return completed;
  }

  #normalizeAdmission(admission: ProviderOperationAdmission): Readonly<ProviderOperationAdmission> {
    const identity = normalizeIdentity(admission);
    if (!SHA256.test(admission.requestHash)) {
      throw new TypeError('Provider operation admission requestHash is invalid.');
    }
    if (!Number.isSafeInteger(admission.revision) || admission.revision < 1) {
      throw new TypeError('Provider operation admission revision is invalid.');
    }
    return Object.freeze({
      ...identity,
      requestHash: admission.requestHash,
      revision: admission.revision,
    });
  }

  #normalizeRequestAdmission(
    admission: ProviderOperationRequestAdmission,
  ): Readonly<ProviderOperationRequestAdmission> {
    const identity = normalizeIdentity(admission);
    if (!SHA256.test(admission.requestHash)) {
      throw new TypeError('Provider operation request-admission hash is invalid.');
    }
    if (!Number.isSafeInteger(admission.revision) || admission.revision < 0) {
      throw new TypeError('Provider operation request-admission revision is invalid.');
    }
    return Object.freeze({
      ...identity,
      requestHash: admission.requestHash,
      revision: admission.revision,
    });
  }

  async #settleBudgetReservation(
    admissionInput: ProviderOperationRequestAdmission,
    phase: 'budget_reserved' | 'budget_rejected',
    failure?: JsonValue,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<ProviderOperationBudgetReservationResult> {
    const admission = this.#normalizeRequestAdmission(admissionInput);
    let current = await this.#loadRequiredRequestAdmission(admission, io);

    for (let attempt = 0; attempt < this.#maxCasRetries; attempt += 1) {
      assertSameAdmissionRequest(current, admission.requestHash);
      if (current.phase !== 'admitted') return budgetReservationResult(current);
      if (current.revision !== admission.revision) {
        throw providerLedgerError(
          'INVALID_STATE_TRANSITION',
          'Only the active request admission may settle the budget reservation.',
        );
      }
      const now = this.#readClock(current.updatedAt);
      const next = normalizeProviderOperationRequestAdmissionRecord({
        ...current,
        phase,
        revision: current.revision + 1,
        updatedAt: now,
        ...(phase === 'budget_rejected' ? { failure: failure as JsonValue } : {}),
      });
      assertRequestAdmissionTransition(current, next);
      if (
        await this.#storeIo(
          (context) =>
            this.#store.compareAndSetRequestAdmission(admission, current.revision, next, context),
          io,
        )
      ) {
        return budgetReservationResult(next);
      }
      current = await this.#loadRequiredRequestAdmission(admission, io);
    }
    throw this.#casExhausted();
  }

  #outcomeUnknownRecord(
    current: Readonly<ProviderOperationRecordV1>,
  ): Readonly<ProviderOperationRecordV1> {
    const now = this.#readClock(current.updatedAt);
    const next = normalizeProviderOperationRecord({
      ...current,
      phase: 'outcome_unknown',
      revision: current.revision + 1,
      updatedAt: now,
      terminalAt: now,
    });
    assertTransition(current, next);
    return next;
  }

  async #loadRequired(
    identity: ProviderOperationIdentity,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<Readonly<ProviderOperationRecordV1>> {
    const current = await this.load(identity, io);
    if (current === undefined) throw createResourceNotFoundError();
    return current;
  }

  async #loadRequiredRequestAdmission(
    identity: ProviderOperationIdentity,
    io: Readonly<ProviderOperationLedgerIoContext> = {},
  ): Promise<Readonly<ProviderOperationRequestAdmissionRecordV1>> {
    const current = await this.loadRequestAdmission(identity, io);
    if (current === undefined) throw createResourceNotFoundError();
    return current;
  }

  #readClock(minimum = 0): number {
    const now = this.#now();
    assertTimestamp(now, 'Provider operation clock');
    if (now < minimum) {
      throw providerLedgerError(
        'INVALID_STATE_TRANSITION',
        'Provider operation clock cannot move backwards.',
      );
    }
    return now;
  }

  async #storeIo<T>(
    operation: (context: Readonly<ProviderOperationLedgerIoContext>) => Promise<T>,
    io: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<T> {
    assertValidDeadline(io.deadlineAt);
    const scope = createAbortScope(io.signal, io.deadlineAt);
    const context = Object.freeze({
      signal: scope.signal,
      ...(io.deadlineAt === undefined ? {} : { deadlineAt: io.deadlineAt }),
    });
    try {
      throwIfAborted(scope.signal, io.deadlineAt);
      const pending = Promise.resolve().then(() => {
        throwIfAborted(scope.signal, io.deadlineAt);
        return operation(context);
      });
      return await awaitWithAbort(pending, scope.signal);
    } finally {
      scope.dispose();
    }
  }

  #casExhausted(): SubAgentRuntimeError {
    return providerLedgerError(
      'INVALID_STATE_TRANSITION',
      'Provider operation CAS contention exceeded the configured retry limit.',
      { retryable: true, causeCode: 'PROVIDER_OPERATION_CAS_CONFLICT' },
    );
  }
}

function isProviderOperationRecordIterable(
  value: unknown,
): value is Iterable<ProviderOperationRecordV1> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  );
}

/** In-process authoritative store used by Memory placement and deterministic tests. */
export class MemoryProviderOperationLedgerStore implements ProviderOperationLedgerStore {
  readonly #records = new Map<string, Readonly<ProviderOperationRecordV1>>();
  readonly #requestAdmissions = new Map<
    string,
    Readonly<ProviderOperationRequestAdmissionRecordV1>
  >();
  readonly #operationCapacity: number;
  readonly #requestAdmissionCapacity: number;

  constructor();
  constructor(initialRecords: Iterable<ProviderOperationRecordV1>);
  constructor(options: MemoryProviderOperationLedgerStoreOptions);
  constructor(
    input: Iterable<ProviderOperationRecordV1> | MemoryProviderOperationLedgerStoreOptions = [],
  ) {
    const options = isProviderOperationRecordIterable(input) ? { initialRecords: input } : input;
    this.#operationCapacity = resolveMemoryCapacity(options.operationCapacity, 'operationCapacity');
    this.#requestAdmissionCapacity = resolveMemoryCapacity(
      options.requestAdmissionCapacity,
      'requestAdmissionCapacity',
    );
    const initialRecords = [...(options.initialRecords ?? [])].map((record) =>
      normalizeProviderOperationRecord(record),
    );
    const initialRequestAdmissions = [...(options.initialRequestAdmissions ?? [])].map((record) =>
      normalizeProviderOperationRequestAdmissionRecord(record),
    );
    if (initialRecords.length > this.#operationCapacity) {
      throw new TypeError('Initial provider operation records exceed operationCapacity.');
    }
    if (initialRequestAdmissions.length > this.#requestAdmissionCapacity) {
      throw new TypeError(
        'Initial provider request-admission records exceed requestAdmissionCapacity.',
      );
    }
    for (const record of initialRecords) {
      const key = identityKey(record);
      if (this.#records.has(key)) {
        throw new TypeError('Duplicate initial provider operation identity.');
      }
      this.#records.set(key, record);
    }
    for (const record of initialRequestAdmissions) {
      const key = identityKey(record);
      if (this.#requestAdmissions.has(key)) {
        throw new TypeError('Duplicate initial provider request-admission identity.');
      }
      this.#requestAdmissions.set(key, record);
    }
  }

  async load(
    identityInput: ProviderOperationIdentity,
    _context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<ProviderOperationRecordV1 | undefined> {
    void _context;
    const identity = normalizeIdentity(identityInput);
    const record = this.#records.get(identityKey(identity));
    return record === undefined ? undefined : normalizeProviderOperationRecord(record);
  }

  async create(
    recordInput: ProviderOperationRecordV1,
    _context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<boolean> {
    void _context;
    const record = normalizeProviderOperationRecord(recordInput);
    const key = identityKey(record);
    if (this.#records.has(key)) return false;
    if (this.#records.size >= this.#operationCapacity) throw memoryCapacityError('operation');
    this.#records.set(key, record);
    return true;
  }

  async compareAndSet(
    identityInput: ProviderOperationIdentity,
    expectedRevision: number,
    nextInput: ProviderOperationRecordV1,
    _context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<boolean> {
    void _context;
    const identity = normalizeIdentity(identityInput);
    assertRevision(expectedRevision);
    const next = normalizeProviderOperationRecord(nextInput);
    assertStoreIdentity(next, identity);
    const key = identityKey(identity);
    const current = this.#records.get(key);
    if (current === undefined || current.revision !== expectedRevision) return false;
    assertTransition(current, next);
    this.#records.set(key, next);
    return true;
  }

  async loadRequestAdmission(
    identityInput: ProviderOperationIdentity,
    _context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<ProviderOperationRequestAdmissionRecordV1 | undefined> {
    void _context;
    const identity = normalizeIdentity(identityInput);
    const record = this.#requestAdmissions.get(identityKey(identity));
    return record === undefined
      ? undefined
      : normalizeProviderOperationRequestAdmissionRecord(record);
  }

  async createRequestAdmission(
    recordInput: ProviderOperationRequestAdmissionRecordV1,
    _context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<boolean> {
    void _context;
    const record = normalizeProviderOperationRequestAdmissionRecord(recordInput);
    if (record.phase !== 'admitted' || record.revision !== 0) {
      throw new TypeError('A new provider operation request admission must use revision zero.');
    }
    const key = identityKey(record);
    if (this.#requestAdmissions.has(key)) return false;
    if (this.#requestAdmissions.size >= this.#requestAdmissionCapacity) {
      throw memoryCapacityError('request-admission');
    }
    this.#requestAdmissions.set(key, record);
    return true;
  }

  async compareAndSetRequestAdmission(
    identityInput: ProviderOperationIdentity,
    expectedRevision: number,
    nextInput: ProviderOperationRequestAdmissionRecordV1,
    _context?: Readonly<ProviderOperationLedgerIoContext>,
  ): Promise<boolean> {
    void _context;
    const identity = normalizeIdentity(identityInput);
    assertRevision(expectedRevision);
    const next = normalizeProviderOperationRequestAdmissionRecord(nextInput);
    assertAdmissionStoreIdentity(next, identity);
    const key = identityKey(identity);
    const current = this.#requestAdmissions.get(key);
    if (current === undefined || current.revision !== expectedRevision) return false;
    assertRequestAdmissionTransition(current, next);
    this.#requestAdmissions.set(key, next);
    return true;
  }

  snapshot(): readonly Readonly<ProviderOperationRecordV1>[] {
    return Object.freeze(
      [...this.#records.values()]
        .sort((left, right) => identityKey(left).localeCompare(identityKey(right)))
        .map((record) => normalizeProviderOperationRecord(record)),
    );
  }

  requestAdmissionSnapshot(): readonly Readonly<ProviderOperationRequestAdmissionRecordV1>[] {
    return Object.freeze(
      [...this.#requestAdmissions.values()]
        .sort((left, right) => identityKey(left).localeCompare(identityKey(right)))
        .map((record) => normalizeProviderOperationRequestAdmissionRecord(record)),
    );
  }

  diagnostics(): Readonly<MemoryProviderOperationLedgerStoreDiagnostics> {
    return Object.freeze({
      operationRecords: this.#records.size,
      requestAdmissionRecords: this.#requestAdmissions.size,
      operationCapacity: this.#operationCapacity,
      requestAdmissionCapacity: this.#requestAdmissionCapacity,
    });
  }
}
