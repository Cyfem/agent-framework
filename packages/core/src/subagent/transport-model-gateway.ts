import type {
  AgentBaseSystemMessage,
  AgentBaseToolCallOutputMessage,
  AgentBaseUserMessage,
  AgentParsedMessage,
  AgentProtocol,
  AgentToolCall,
  AgentToolDefinitionInput,
  AssistantMessageOf,
  ContextOf,
  ModelErrorClassificationContext,
  ModelErrorDescriptor,
  SystemMessageOf,
  ToolCallOutputMessageOf,
  ToolOf,
  ToolPayloadReplacements,
  UserMessageOf,
} from '../agent/types';
import {
  Model,
  type ModelGeneratePurpose,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type ModelGenerateUsage,
} from '../llm/base';
import {
  assertValidDeadline,
  awaitWithAbort,
  createAbortScope,
  createAbortError,
  createDeadlineExceededError,
  isAbortError,
  throwIfAborted,
} from '../llm/base/abort';
import type { AgentProtocolCheckpointCodec } from './checkpoint';
import {
  RESOURCE_NOT_FOUND_ERROR,
  SUBAGENT_ERROR_CODES,
  SubAgentRuntimeError,
  type SubAgentErrorDescriptor,
} from './errors';
import {
  assertJsonValue,
  canonicalJsonSha256,
  canonicalizeJson,
  parseJsonValue,
  type JsonValue,
} from './json';
import {
  ProviderOperationLedger,
  type ProviderOperationIdentity,
  type ProviderOperationRecordV1,
  type ProviderOperationRequestAdmissionRecordV1,
} from './provider-operation-ledger';
import { isAuditedSubAgentTransportModelProtocolSurface } from './transport-model-protocol-surface';
import type { SubAgentTransportRpcPayloadMap, SubAgentTransportSafeError } from './transport-rpc';

type ModelRequestPayload = SubAgentTransportRpcPayloadMap['model.request'];
type ModelReplyPayload = SubAgentTransportRpcPayloadMap['model.reply'];
type ModelSuccessReplyPayload = Extract<ModelReplyPayload, { readonly ok: true }>;
type ModelFailureReplyPayload = Extract<ModelReplyPayload, { readonly ok: false }>;

type StoredModelGatewayResult =
  | Readonly<{
      version: '1';
      ok: true;
      resultHash: string;
      messages: readonly JsonValue[];
      usage?: ModelSuccessReplyPayload['usage'];
    }>
  | Readonly<{
      version: '1';
      ok: false;
      error: SubAgentTransportSafeError;
      classification?: SafeModelErrorClassification;
    }>;

const MODEL_PROXY_BRAND = new WeakSet<object>();
const SAFE_ERROR_CODES = new Set<string>(SUBAGENT_ERROR_CODES);
const SHA256 = /^[\da-f]{64}$/u;
const textEncoder = new TextEncoder();

export const DEFAULT_SUBAGENT_TRANSPORT_MODEL_WATCH_TIMEOUT_MS = 120_000;
const MODEL_GATEWAY_WATCH_INITIAL_DELAY_MS = 10;
const MODEL_GATEWAY_WATCH_MAX_DELAY_MS = 1_000;

const PROVIDER_OUTCOME_UNKNOWN_ERROR = Object.freeze({
  code: 'EXECUTOR_FAILED',
  message: 'The provider model request has an unknown outcome.',
  retryable: false,
  causeCode: 'PROVIDER_REQUEST_OUTCOME_UNKNOWN',
  outcomeUnknown: true,
}) satisfies SubAgentTransportSafeError;

const PREPARED_OPERATION_ERROR = Object.freeze({
  code: 'INTERNAL_ERROR',
  message: 'The provider model request was prepared but not dispatched.',
  retryable: true,
  causeCode: 'PROVIDER_REQUEST_NOT_DISPATCHED',
}) satisfies SubAgentTransportSafeError;

type SafeModelErrorClassification = NonNullable<
  Extract<ModelReplyPayload, { readonly ok: false }>['classification']
>;

class SubAgentTransportModelError extends SubAgentRuntimeError {
  readonly classification: Readonly<ModelErrorDescriptor>;

  constructor(error: SubAgentTransportSafeError, classification: SafeModelErrorClassification) {
    super(error);
    this.name = 'SubAgentTransportModelError';
    this.classification = Object.freeze({
      kind: classification.kind,
      message: error.message,
      status: classification.status,
    });
  }
}

/**
 * The provider-semantic value whose RFC 8785/JCS digest is stable across legal execution
 * takeover. Current attempt/epoch/fencing remain mandatory on the wire and checkpoint ACK, but
 * are deliberately not part of this replay identity.
 */
export interface SubAgentTransportModelCanonicalRequest {
  readonly gatewayId: string;
  readonly protocol: string;
  readonly codecVersion: string;
  readonly runId: string;
  readonly checkpointOperationId: string;
  readonly checkpointDigest: string;
  readonly purpose: ModelGeneratePurpose;
  readonly iteration: number;
  readonly requestAttempt: number;
  readonly context: JsonValue;
  readonly tools: readonly JsonValue[];
}

/** Build the exact request value shared by the target proxy and authoritative controller. */
export function createSubAgentTransportModelCanonicalRequest(
  input: SubAgentTransportModelCanonicalRequest,
): Readonly<SubAgentTransportModelCanonicalRequest> {
  const value = ownJson({
    gatewayId: input.gatewayId,
    protocol: input.protocol,
    codecVersion: input.codecVersion,
    runId: input.runId,
    checkpointOperationId: input.checkpointOperationId,
    checkpointDigest: input.checkpointDigest,
    purpose: input.purpose,
    iteration: input.iteration,
    requestAttempt: input.requestAttempt,
    context: input.context,
    tools: input.tools,
  }) as unknown as SubAgentTransportModelCanonicalRequest;
  assertIdentifier(value.gatewayId, 'gatewayId');
  assertToken(value.protocol, 'protocol');
  assertToken(value.codecVersion, 'codecVersion');
  assertIdentifier(value.runId, 'runId');
  assertIdentifier(value.checkpointOperationId, 'checkpointOperationId');
  if (!SHA256.test(value.checkpointDigest)) {
    throw new TypeError('Model gateway checkpointDigest is invalid.');
  }
  if (value.purpose !== 'agent' && value.purpose !== 'context-summary') {
    throw new TypeError('Model gateway purpose is invalid.');
  }
  if (!Array.isArray(value.context)) {
    throw new TypeError('Model gateway context must be an encoded context array.');
  }
  if (!Array.isArray(value.tools)) {
    throw new TypeError('Model gateway tools must be an encoded tools array.');
  }
  requiredNonNegativeInteger(value.iteration, 'iteration');
  requiredPositiveInteger(value.requestAttempt, 'requestAttempt');
  return Object.freeze(value);
}

/** Hash the exact protocol/purpose/context/tools projection sent across placement. */
export function hashSubAgentTransportModelRequest(
  input: SubAgentTransportModelCanonicalRequest,
): string {
  return canonicalJsonSha256(
    createSubAgentTransportModelCanonicalRequest(input) as unknown as JsonValue,
  );
}

/** Placement-neutral exchange input. A Peer adapter can map this directly to `open()`. */
export interface SubAgentTransportModelExchangeRequest {
  readonly taskId: string;
  readonly operationId: string;
  readonly payload: ModelRequestPayload;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** The target does not depend on a concrete Peer or transport package. */
export type SubAgentTransportModelExchange = (
  request: SubAgentTransportModelExchangeRequest,
) => Promise<ModelReplyPayload>;

/** Credential-free protocol behavior allowed inside an execution target. */
export interface SubAgentTransportModelProtocolSurface<P extends AgentProtocol> {
  readonly checkpointCodec: AgentProtocolCheckpointCodec<P>;
  buildUserMessage(input: AgentBaseUserMessage | UserMessageOf<P>): ContextOf<P>;
  buildSystemMessage(input: AgentBaseSystemMessage | SystemMessageOf<P>): ContextOf<P>;
  buildToolCallOutputMessage(
    input: AgentBaseToolCallOutputMessage | ToolCallOutputMessageOf<P>,
  ): ContextOf<P>;
  buildToolMessage(input: AgentToolDefinitionInput): ToolOf<P>;
  parseUserMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<UserMessageOf<P>, ContextOf<P>>[];
  parseSystemMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<SystemMessageOf<P>, ContextOf<P>>[];
  parseAssistantMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<AssistantMessageOf<P>, ContextOf<P>>[];
  parseToolCalls(context: readonly ContextOf<P>[]): readonly AgentToolCall<P>[];
  parseToolCallOutputMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<ToolCallOutputMessageOf<P>, ContextOf<P>>[];
  rewriteToolPayloads(
    context: readonly ContextOf<P>[],
    replacements: ToolPayloadReplacements<P>,
  ): readonly ContextOf<P>[];
  extractAssistantText(context: readonly ContextOf<P>[]): readonly string[];
  classifyError(error: unknown, context: ModelErrorClassificationContext<P>): ModelErrorDescriptor;
}

export interface SubAgentTransportModelProxyOptions<P extends AgentProtocol> {
  /** Trusted protocol-only surface. Objects exposing `generate` are rejected fail-closed. */
  readonly protocol: SubAgentTransportModelProtocolSurface<P>;
  readonly gatewayId: string;
  readonly exchange: SubAgentTransportModelExchange;
  readonly now?: () => number;
}

/**
 * Build a target-side Model that retains protocol behavior but replaces provider access with one
 * controller exchange. Credentials, provider bodies and raw SDK responses are not representable.
 */
export function createSubAgentTransportModelProxy<P extends AgentProtocol>(
  options: SubAgentTransportModelProxyOptions<P>,
): Model<P> {
  return new TransportModelProxy(options);
}

/** Unforgeable process-local brand used to suppress target-side provider budget consumption. */
export function isSubAgentTransportModelProxy(model: unknown): model is Model<AgentProtocol> {
  return (
    ((typeof model === 'object' && model !== null) || typeof model === 'function') &&
    MODEL_PROXY_BRAND.has(model as object)
  );
}

class TransportModelProxy<P extends AgentProtocol> extends Model<P> {
  readonly #protocol: SubAgentTransportModelProtocolSurface<P>;
  readonly #gatewayId: string;
  readonly #exchange: SubAgentTransportModelExchange;
  readonly #now: () => number;

  override readonly checkpointCodec: AgentProtocolCheckpointCodec<P>;

  constructor(options: SubAgentTransportModelProxyOptions<P>) {
    super();
    assertIdentifier(options.gatewayId, 'gatewayId');
    if (typeof options.exchange !== 'function') {
      throw new TypeError('Model gateway exchange must be a function.');
    }
    assertProtocolSurface(options.protocol);
    if ('generate' in options.protocol) {
      throw new TypeError('A transport Model proxy rejects provider-capable protocol objects.');
    }
    if (!isAuditedSubAgentTransportModelProtocolSurface(options.protocol)) {
      throw new TypeError(
        'A transport Model proxy requires a Core-audited credential-free protocol surface.',
      );
    }
    const codec = options.protocol.checkpointCodec;
    assertCodec(codec);
    this.#protocol = options.protocol;
    this.#gatewayId = options.gatewayId;
    this.#exchange = options.exchange;
    this.#now = options.now ?? Date.now;
    this.checkpointCodec = codec;
    MODEL_PROXY_BRAND.add(this);
  }

  override async generate(request: ModelGenerateRequest<P>): Promise<ModelGenerateResult<P>> {
    const codec = this.checkpointCodec;
    const runtime = request.runtime;
    const taskId = requiredIdentifier(runtime?.taskId, 'runtime.taskId');
    const runId = requiredIdentifier(runtime?.runId, 'runtime.runId');
    const executionAttempt = requiredPositiveInteger(
      runtime?.executionAttempt,
      'runtime.executionAttempt',
    );
    const executionEpoch = requiredIdentifier(runtime?.executionEpoch, 'runtime.executionEpoch');
    const executionFencingToken = requiredFencingToken(
      runtime?.executionFencingToken,
      'runtime.executionFencingToken',
    );
    const providerOperationId = requiredIdentifier(
      runtime?.providerOperationId,
      'runtime.providerOperationId',
    );
    const checkpointOperationId = requiredIdentifier(
      runtime?.checkpointOperationId,
      'runtime.checkpointOperationId',
    );
    const checkpointDigest = requiredSha256(runtime?.checkpointDigest, 'runtime.checkpointDigest');
    const iteration = requiredNonNegativeInteger(runtime?.iteration, 'runtime.iteration');
    const requestAttempt = requiredPositiveInteger(
      runtime?.requestAttempt,
      'runtime.requestAttempt',
    );
    const purpose = request.purpose ?? 'agent';
    if (request.signal?.aborted) {
      throw request.signal.reason ?? createAbortError();
    }

    const context = ownJson(codec.encode(request.context));
    if (!Array.isArray(context)) {
      throw new TypeError('The Model checkpoint codec must encode context as an array.');
    }
    const tools = ownJson(request.tools as unknown as JsonValue);
    if (!Array.isArray(tools)) {
      throw new TypeError('Model tools must be JSON-safe protocol values.');
    }
    const canonical = createSubAgentTransportModelCanonicalRequest({
      gatewayId: this.#gatewayId,
      protocol: codec.protocol,
      codecVersion: codec.version,
      runId,
      checkpointOperationId,
      checkpointDigest,
      purpose,
      iteration,
      requestAttempt,
      context,
      tools,
    });
    const requestHash = canonicalJsonSha256(canonical as unknown as JsonValue);
    const remainingMs = remainingDeadline(request.deadlineAt, this.#now);
    const payload = Object.freeze({
      providerOperationId,
      gatewayId: this.#gatewayId,
      protocol: codec.protocol,
      codecVersion: codec.version,
      runId,
      executionAttempt,
      executionEpoch,
      executionFencingToken,
      checkpointOperationId,
      checkpointDigest,
      purpose,
      iteration,
      requestAttempt,
      requestHash,
      context,
      tools,
      ...(remainingMs === undefined ? {} : { remainingMs }),
    }) satisfies ModelRequestPayload;

    const scope = createAbortScope(request.signal, request.deadlineAt);
    let reply: ModelReplyPayload;
    try {
      reply = await awaitWithAbort(
        this.#exchange({
          taskId,
          operationId: providerOperationId,
          payload,
          signal: scope.signal,
          ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
        }),
        scope.signal,
      );
    } finally {
      scope.dispose();
    }
    assertModelReply(reply, payload);
    if (!reply.ok) {
      if (reply.classification !== undefined) {
        throw new SubAgentTransportModelError(reply.error, reply.classification);
      }
      throw new SubAgentRuntimeError(reply.error);
    }

    if (canonicalJsonSha256(reply.messages) !== reply.resultHash) {
      throw new TypeError('Model gateway reply result hash is invalid.');
    }
    const messages = codec.decode(ownJson(reply.messages));
    if (!Array.isArray(messages)) {
      throw new TypeError('The Model checkpoint codec must decode messages as an array.');
    }
    const usage = normalizeModelUsage(reply.usage);
    return Object.freeze({
      messages: Object.freeze([...messages]),
      ...(usage === undefined ? {} : { usage }),
      raw: undefined,
    });
  }

  override buildUserMessage(input: AgentBaseUserMessage | UserMessageOf<P>): ContextOf<P> {
    return this.#protocol.buildUserMessage(input);
  }

  override buildSystemMessage(input: AgentBaseSystemMessage | SystemMessageOf<P>): ContextOf<P> {
    return this.#protocol.buildSystemMessage(input);
  }

  override buildToolCallOutputMessage(
    input: AgentBaseToolCallOutputMessage | ToolCallOutputMessageOf<P>,
  ): ContextOf<P> {
    return this.#protocol.buildToolCallOutputMessage(input);
  }

  override buildToolMessage(input: AgentToolDefinitionInput): ToolOf<P> {
    return this.#protocol.buildToolMessage(input);
  }

  override parseUserMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<UserMessageOf<P>, ContextOf<P>>[] {
    return this.#protocol.parseUserMessages(context);
  }

  override parseSystemMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<SystemMessageOf<P>, ContextOf<P>>[] {
    return this.#protocol.parseSystemMessages(context);
  }

  override parseAssistantMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<AssistantMessageOf<P>, ContextOf<P>>[] {
    return this.#protocol.parseAssistantMessages(context);
  }

  override parseToolCalls(context: readonly ContextOf<P>[]): readonly AgentToolCall<P>[] {
    return this.#protocol.parseToolCalls(context);
  }

  override parseToolCallOutputMessages(
    context: readonly ContextOf<P>[],
  ): readonly AgentParsedMessage<ToolCallOutputMessageOf<P>, ContextOf<P>>[] {
    return this.#protocol.parseToolCallOutputMessages(context);
  }

  override rewriteToolPayloads(
    context: readonly ContextOf<P>[],
    replacements: ToolPayloadReplacements<P>,
  ): readonly ContextOf<P>[] {
    return this.#protocol.rewriteToolPayloads(context, replacements);
  }

  override extractAssistantText(context: readonly ContextOf<P>[]): readonly string[] {
    return this.#protocol.extractAssistantText(context);
  }

  override classifyError(
    error: unknown,
    context: ModelErrorClassificationContext<P>,
  ): ModelErrorDescriptor {
    if (error instanceof SubAgentTransportModelError) return error.classification;
    return this.#protocol.classifyError(error, context);
  }
}

export interface SubAgentTransportModelGatewayRegistration<P extends AgentProtocol> {
  readonly gatewayId: string;
  readonly protocol: string;
  readonly codec: AgentProtocolCheckpointCodec<P>;
  readonly model: Model<P>;
}

interface ErasedGatewayRegistration {
  readonly gatewayId: string;
  readonly protocol: string;
  readonly codec: AgentProtocolCheckpointCodec<AgentProtocol>;
  readonly model: Model<AgentProtocol>;
}

const GATEWAY_REGISTRATIONS = new WeakMap<
  SubAgentTransportModelGatewayRegistry,
  Map<string, Readonly<ErasedGatewayRegistration>>
>();

function gatewayRegistrations(
  registry: SubAgentTransportModelGatewayRegistry,
): Map<string, Readonly<ErasedGatewayRegistration>> {
  const registrations = GATEWAY_REGISTRATIONS.get(registry);
  if (registrations === undefined) {
    throw new TypeError('The Model gateway registry instance is invalid.');
  }
  return registrations;
}

/** Trusted controller-only registry. Registration objects are never sent to a placement target. */
export class SubAgentTransportModelGatewayRegistry {
  #sealed = false;

  constructor() {
    GATEWAY_REGISTRATIONS.set(this, new Map());
  }

  register<P extends AgentProtocol>(input: SubAgentTransportModelGatewayRegistration<P>): void {
    if (this.#sealed) throw new TypeError('The Model gateway registry is sealed.');
    assertIdentifier(input.gatewayId, 'gatewayId');
    assertToken(input.protocol, 'protocol');
    assertCodec(input.codec);
    if (input.protocol !== input.codec.protocol) {
      throw new TypeError('A Model gateway protocol must match its checkpoint codec.');
    }
    if (input.model.providerMaxRetries !== 0) {
      throw new TypeError('A Model gateway Model must explicitly disable provider retries.');
    }
    const modelCodec = input.model.checkpointCodec;
    if (
      modelCodec === undefined ||
      modelCodec.protocol !== input.codec.protocol ||
      modelCodec.version !== input.codec.version
    ) {
      throw new TypeError('A Model gateway Model must expose the registered checkpoint codec.');
    }
    const registrations = gatewayRegistrations(this);
    if (registrations.has(input.gatewayId)) {
      throw new TypeError(`Duplicate Model gateway ${input.gatewayId}.`);
    }
    registrations.set(
      input.gatewayId,
      Object.freeze({
        gatewayId: input.gatewayId,
        protocol: input.protocol,
        codec: input.codec as unknown as AgentProtocolCheckpointCodec<AgentProtocol>,
        model: input.model as unknown as Model<AgentProtocol>,
      }),
    );
  }

  seal(): void {
    this.#sealed = true;
  }

  get sealed(): boolean {
    return this.#sealed;
  }
}

export interface SubAgentTransportModelGatewayOperation {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly executionAttempt: number;
  readonly executionEpoch: string;
  readonly executionFencingToken: string;
  readonly providerOperationId: string;
  readonly checkpointOperationId: string;
  readonly checkpointDigest: string;
  readonly checkpointRevision: number;
  readonly gatewayId: string;
  readonly protocol: string;
  readonly codecVersion: string;
  readonly purpose: ModelGeneratePurpose;
  readonly iteration: number;
  readonly requestAttempt: number;
  readonly requestHash: string;
}

export interface SubAgentTransportModelGatewayHandleRequest {
  readonly ownerSessionId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly payload: ModelRequestPayload;
  readonly signal?: AbortSignal;
  /** Trusted controller-side ceiling; target-provided remainingMs may only shorten it. */
  readonly deadlineAt?: number;
}

export interface SubAgentTransportModelGatewayHandlerOptions {
  readonly registry: SubAgentTransportModelGatewayRegistry;
  readonly ledger: ProviderOperationLedger;
  /** Must durably prove that the exact child checkpoint is in-flight before budget admission. */
  readonly acknowledgeCheckpoint: (
    operation: Readonly<Omit<SubAgentTransportModelGatewayOperation, 'checkpointRevision'>>,
  ) =>
    | Readonly<{ readonly checkpointRevision: number; readonly checkpointDigest: string }>
    | Promise<Readonly<{ readonly checkpointRevision: number; readonly checkpointDigest: string }>>;
  /** Must be idempotent for the operation identity. */
  readonly reserveBudget: (
    operation: Readonly<SubAgentTransportModelGatewayOperation>,
  ) => void | Promise<void>;
  readonly now?: () => number;
  /** Bounds cross-handler admission/in-flight joins when the caller omitted a deadline. */
  readonly watchTimeoutMs?: number;
}

/** Controller-side gateway preserving checkpoint -> budget -> provider-ledger ordering. */
export class SubAgentTransportModelGatewayHandler {
  readonly #registry: SubAgentTransportModelGatewayRegistry;
  readonly #ledger: ProviderOperationLedger;
  readonly #acknowledgeCheckpoint: SubAgentTransportModelGatewayHandlerOptions['acknowledgeCheckpoint'];
  readonly #reserveBudget: SubAgentTransportModelGatewayHandlerOptions['reserveBudget'];
  readonly #now: () => number;
  readonly #watchTimeoutMs: number;
  readonly #pending = new Map<
    string,
    Readonly<{ requestHash: string; scopeHash: string; promise: Promise<ModelReplyPayload> }>
  >();

  constructor(options: SubAgentTransportModelGatewayHandlerOptions) {
    if (
      typeof options.acknowledgeCheckpoint !== 'function' ||
      typeof options.reserveBudget !== 'function'
    ) {
      throw new TypeError('Model gateway callbacks must be functions.');
    }
    if (!options.registry.sealed) {
      throw new TypeError('The Model gateway registry must be sealed before use.');
    }
    this.#registry = options.registry;
    this.#ledger = options.ledger;
    this.#acknowledgeCheckpoint = options.acknowledgeCheckpoint;
    this.#reserveBudget = options.reserveBudget;
    this.#now = options.now ?? Date.now;
    this.#watchTimeoutMs =
      options.watchTimeoutMs ?? DEFAULT_SUBAGENT_TRANSPORT_MODEL_WATCH_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#watchTimeoutMs) || this.#watchTimeoutMs < 1) {
      throw new TypeError('Model gateway watchTimeoutMs must be a positive safe integer.');
    }
  }

  async handle(input: SubAgentTransportModelGatewayHandleRequest): Promise<ModelReplyPayload> {
    return this.#handle(input, false);
  }

  /**
   * Host-only recovery entrypoint for a request admission whose original handler is known to be
   * gone. Normal transport replay must call `handle()` and can only observe, never steal, an
   * unsettled admission.
   */
  async recoverRequestAdmission(
    input: SubAgentTransportModelGatewayHandleRequest,
  ): Promise<ModelReplyPayload> {
    return this.#handle(input, true);
  }

  async #handle(
    input: SubAgentTransportModelGatewayHandleRequest,
    recoverAdmission: boolean,
  ): Promise<ModelReplyPayload> {
    const payload = input.payload;
    const common = replyIdentity(payload);
    try {
      validateGatewayHandleRequest(input);
      const registration = gatewayRegistrations(this.#registry).get(payload.gatewayId);
      if (
        registration === undefined ||
        registration.protocol !== payload.protocol ||
        registration.codec.protocol !== payload.protocol ||
        registration.codec.version !== payload.codecVersion
      ) {
        return failureReply(common, RESOURCE_NOT_FOUND_ERROR);
      }
      const canonical = createSubAgentTransportModelCanonicalRequest({
        gatewayId: payload.gatewayId,
        protocol: payload.protocol,
        codecVersion: payload.codecVersion,
        runId: payload.runId,
        checkpointOperationId: payload.checkpointOperationId,
        checkpointDigest: payload.checkpointDigest,
        purpose: payload.purpose,
        iteration: payload.iteration,
        requestAttempt: payload.requestAttempt,
        context: payload.context,
        tools: payload.tools,
      });
      const requestHash = canonicalJsonSha256(canonical as unknown as JsonValue);
      if (requestHash !== payload.requestHash) {
        return failureReply(common, {
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The Model gateway request hash does not match its canonical request.',
          retryable: false,
          causeCode: 'MODEL_REQUEST_HASH_MISMATCH',
        });
      }

      const operation = Object.freeze({
        ownerSessionId: input.ownerSessionId,
        runId: payload.runId,
        taskId: input.taskId,
        executionAttempt: payload.executionAttempt,
        executionEpoch: payload.executionEpoch,
        executionFencingToken: payload.executionFencingToken,
        providerOperationId: payload.providerOperationId,
        checkpointOperationId: payload.checkpointOperationId,
        checkpointDigest: payload.checkpointDigest,
        gatewayId: payload.gatewayId,
        protocol: payload.protocol,
        codecVersion: payload.codecVersion,
        purpose: payload.purpose,
        iteration: payload.iteration,
        requestAttempt: payload.requestAttempt,
        requestHash,
      }) satisfies Omit<SubAgentTransportModelGatewayOperation, 'checkpointRevision'>;
      const pendingKey = providerOperationKey(operation);
      const scopeHash = canonicalJsonSha256(common as unknown as JsonValue);
      const existing = this.#pending.get(pendingKey);
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) {
          return failureReply(common, {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'The Model gateway operation conflicts with an active request.',
            retryable: false,
            causeCode: 'MODEL_REQUEST_IDEMPOTENCY_CONFLICT',
          });
        }
        if (existing.scopeHash === scopeHash) {
          return await awaitWithGatewayDeadline(existing.promise, input.signal, input.deadlineAt);
        }
        await awaitWithGatewayDeadline(existing.promise, input.signal, input.deadlineAt);
        return await this.#run(
          registration,
          operation,
          payload,
          canonical,
          input.signal,
          input.deadlineAt,
          recoverAdmission,
        );
      }
      const deferred = createDeferred<ModelReplyPayload>();
      const promise = deferred.promise;
      this.#pending.set(pendingKey, Object.freeze({ requestHash, scopeHash, promise }));
      // Install local single-flight before checkpoint ACK because trusted host callbacks may
      // synchronously re-enter handle() for the same provider operation.
      void this.#run(
        registration,
        operation,
        payload,
        canonical,
        input.signal,
        input.deadlineAt,
        recoverAdmission,
      ).then(deferred.resolve, deferred.reject);
      try {
        return await promise;
      } finally {
        if (this.#pending.get(pendingKey)?.promise === promise) this.#pending.delete(pendingKey);
      }
    } catch (error) {
      return failureReply(common, safeBoundaryError(error, input.signal));
    }
  }

  async #run(
    registration: Readonly<ErasedGatewayRegistration>,
    operationInput: Readonly<Omit<SubAgentTransportModelGatewayOperation, 'checkpointRevision'>>,
    payload: ModelRequestPayload,
    canonical: Readonly<SubAgentTransportModelCanonicalRequest>,
    signal: AbortSignal | undefined,
    hostDeadlineAt: number | undefined,
    recoverAdmission: boolean,
  ): Promise<ModelReplyPayload> {
    const deadlineAt = earliestDeadline(
      hostDeadlineAt,
      controllerDeadline(payload.remainingMs, this.#now),
    );
    const scope = createAbortScope(signal, deadlineAt);
    const ledgerDeadlineAt = this.#boundedWatchDeadline(deadlineAt);
    const ledgerIo = Object.freeze({ signal: scope.signal, deadlineAt: ledgerDeadlineAt });
    try {
      throwIfAborted(scope.signal, deadlineAt);
      const acknowledgement = await awaitWithAbort(
        Promise.resolve(this.#acknowledgeCheckpoint(operationInput)),
        scope.signal,
      );
      assertCheckpointAcknowledgement(acknowledgement, operationInput.checkpointDigest);
      const operation = Object.freeze({
        ...operationInput,
        checkpointRevision: acknowledgement.checkpointRevision,
      }) satisfies SubAgentTransportModelGatewayOperation;
      const ledgerRequest = ownJson(canonical as unknown as JsonValue);
      const identity = providerOperationIdentity(operation);
      throwIfAborted(scope.signal, deadlineAt);
      const requestAdmission = recoverAdmission
        ? await this.#ledger.recoverRequestAdmission(identity, ledgerRequest, ledgerIo)
        : await this.#ledger.admitRequest(identity, ledgerRequest, ledgerIo);
      let reservation = requestAdmission;
      if (requestAdmission.status === 'admitted' || requestAdmission.status === 'recovered') {
        let budgetReservation: Promise<void> | undefined;
        try {
          budgetReservation = Promise.resolve(this.#reserveBudget(operation));
          await awaitWithAbort(budgetReservation, scope.signal);
        } catch (error) {
          if (isAbortError(error, scope.signal) && budgetReservation !== undefined) {
            // Cancellation cannot prove whether an already-started durable reservation committed.
            // Settle only from the callback's authoritative result; never guess or run the SDK.
            void budgetReservation
              .then(
                () =>
                  this.#ledger.confirmBudgetReservation(
                    requestAdmission.admission,
                    this.#backgroundLedgerIo(),
                  ),
                (reservationError: unknown) =>
                  this.#ledger.rejectBudgetReservation(
                    requestAdmission.admission,
                    safeBoundaryError(reservationError, scope.signal) as unknown as JsonValue,
                    this.#backgroundLedgerIo(),
                  ),
              )
              .catch(() => undefined);
            throw error;
          }
          reservation = await this.#ledger.rejectBudgetReservation(
            requestAdmission.admission,
            safeBoundaryError(error, scope.signal) as unknown as JsonValue,
            ledgerIo,
          );
        }
        if (reservation.status === 'admitted' || reservation.status === 'recovered') {
          reservation = await this.#ledger.confirmBudgetReservation(
            requestAdmission.admission,
            ledgerIo,
          );
        }
      } else if (requestAdmission.status === 'observed') {
        reservation = await this.#waitForBudgetReservation(
          identity,
          requestAdmission.record.requestHash,
          requestAdmission.record,
          scope.signal,
          deadlineAt,
        );
      }
      if (reservation.status === 'budget_rejected') {
        assertSafeError(reservation.failure as unknown as SubAgentTransportSafeError);
        return failureReply(payload, reservation.failure as unknown as SubAgentTransportSafeError);
      }
      if (reservation.status !== 'budget_reserved') {
        throw new SubAgentRuntimeError({
          code: 'INTERNAL_ERROR',
          message: 'The Model request admission did not settle its budget reservation.',
          retryable: false,
          causeCode: 'MODEL_REQUEST_ADMISSION_UNSETTLED',
        });
      }
      throwIfAborted(scope.signal, deadlineAt);
      return await this.#execute(
        registration,
        operation,
        payload,
        ledgerRequest,
        scope.signal,
        deadlineAt,
        ledgerDeadlineAt,
      );
    } finally {
      scope.dispose();
    }
  }

  async #waitForBudgetReservation(
    identity: Readonly<ProviderOperationIdentity>,
    requestHash: string,
    initialRecord: Readonly<ProviderOperationRequestAdmissionRecordV1>,
    signal: AbortSignal,
    deadlineAt: number | undefined,
  ) {
    const watchDeadlineAt = this.#boundedWatchDeadline(deadlineAt);
    let delayMs = MODEL_GATEWAY_WATCH_INITIAL_DELAY_MS;
    let current = initialRecord;
    for (;;) {
      throwIfAborted(signal, watchDeadlineAt);
      if (current.requestHash !== requestHash) {
        throw new SubAgentRuntimeError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The provider operation ID conflicts with an admitted canonical request.',
          retryable: false,
          causeCode: 'MODEL_REQUEST_IDEMPOTENCY_CONFLICT',
        });
      }
      if (current.phase === 'budget_reserved') {
        return Object.freeze({ status: 'budget_reserved' as const, record: current });
      }
      if (current.phase === 'budget_rejected') {
        return Object.freeze({
          status: 'budget_rejected' as const,
          failure: current.failure as JsonValue,
          record: current,
        });
      }
      await waitForGatewayProgress(signal, watchDeadlineAt, delayMs);
      delayMs = nextGatewayWatchDelay(delayMs);
      const loaded = await this.#ledger.loadRequestAdmission(identity, {
        signal,
        deadlineAt: watchDeadlineAt,
      });
      if (loaded === undefined) {
        throw new SubAgentRuntimeError({
          code: 'INTERNAL_ERROR',
          message: 'The admitted Model request disappeared from durable storage.',
          retryable: false,
          causeCode: 'MODEL_REQUEST_ADMISSION_LOST',
        });
      }
      current = loaded;
    }
  }

  async #execute(
    registration: Readonly<ErasedGatewayRegistration>,
    operation: Readonly<SubAgentTransportModelGatewayOperation>,
    payload: ModelRequestPayload,
    canonical: JsonValue,
    signal: AbortSignal,
    deadlineAt: number | undefined,
    ledgerDeadlineAt: number,
  ): Promise<ModelReplyPayload> {
    const identity = providerOperationIdentity(operation);
    let providerError: Readonly<SubAgentTransportSafeError> | undefined;
    try {
      const result = await this.#ledger.execute({
        identity,
        request: canonical,
        signal,
        deadlineAt: ledgerDeadlineAt,
        invoke: async () => {
          const context = registration.codec.decode(ownJson(payload.context));
          if (!Array.isArray(context)) {
            throw new TypeError('The registered checkpoint codec did not decode a context array.');
          }
          const request = Object.freeze({
            context,
            tools: payload.tools as unknown as readonly ToolOf<AgentProtocol>[],
            ...(payload.purpose === 'agent' ? {} : { purpose: payload.purpose }),
            signal,
            ...(deadlineAt === undefined ? {} : { deadlineAt }),
            runtime: Object.freeze({
              sessionId: operation.ownerSessionId,
              runId: operation.runId,
              taskId: operation.taskId,
              executionAttempt: operation.executionAttempt,
              executionEpoch: operation.executionEpoch,
              executionFencingToken: operation.executionFencingToken,
              providerOperationId: operation.providerOperationId,
              checkpointOperationId: operation.checkpointOperationId,
              checkpointDigest: operation.checkpointDigest,
              iteration: operation.iteration,
              requestAttempt: operation.requestAttempt,
            }),
          }) satisfies ModelGenerateRequest<AgentProtocol>;
          try {
            const generated = await awaitWithAbort(registration.model.generate(request), signal);
            const messages = ownJson(registration.codec.encode(generated.messages));
            if (!Array.isArray(messages)) {
              throw new TypeError(
                'The registered checkpoint codec did not encode a message array.',
              );
            }
            const usage = normalizeModelUsage(generated.usage);
            const stored = Object.freeze({
              version: '1' as const,
              ok: true,
              resultHash: canonicalJsonSha256(messages),
              messages,
              ...(usage === undefined ? {} : { usage }),
            }) satisfies StoredModelGatewayResult;
            return stored as unknown as JsonValue;
          } catch (error) {
            const failure = classifyProviderFailure(registration.model, error, request, signal);
            providerError = failure.error;
            if (failure.classification !== undefined) {
              const stored = Object.freeze({
                version: '1' as const,
                ok: false as const,
                error: failure.error,
                classification: failure.classification,
              }) satisfies StoredModelGatewayResult;
              return stored as unknown as JsonValue;
            }
            throw error;
          }
        },
      });
      if (result.status === 'completed') return decodeStoredResult(result.reply, payload);
      if (result.status === 'outcome_unknown') {
        return failureReply(payload, providerError ?? PROVIDER_OUTCOME_UNKNOWN_ERROR);
      }
      return this.#waitForProviderTerminal(
        identity,
        operation.requestHash,
        result.record,
        payload,
        signal,
        deadlineAt,
      );
    } catch (error) {
      if (error instanceof SubAgentRuntimeError && error.code === 'IDEMPOTENCY_CONFLICT') {
        throw error;
      }
      if (isAbortError(error, signal)) throw error;
      const record = await this.#ledger.load(identity, {
        signal,
        deadlineAt: ledgerDeadlineAt,
      });
      if (record?.phase === 'completed' && record.reply !== undefined) {
        return decodeStoredResult(record.reply, payload);
      }
      if (record?.phase === 'in_flight') {
        return failureReply(payload, providerError ?? PROVIDER_OUTCOME_UNKNOWN_ERROR);
      }
      if (record?.phase === 'outcome_unknown') {
        return failureReply(payload, providerError ?? PROVIDER_OUTCOME_UNKNOWN_ERROR);
      }
      if (record?.phase === 'prepared') return failureReply(payload, PREPARED_OPERATION_ERROR);
      throw error;
    }
  }

  async #waitForProviderTerminal(
    identity: Readonly<ProviderOperationIdentity>,
    requestHash: string,
    initialRecord: Readonly<ProviderOperationRecordV1>,
    payload: ModelRequestPayload,
    signal: AbortSignal,
    deadlineAt: number | undefined,
  ): Promise<ModelReplyPayload> {
    const watchDeadlineAt = this.#boundedWatchDeadline(deadlineAt);
    let delayMs = MODEL_GATEWAY_WATCH_INITIAL_DELAY_MS;
    let record = initialRecord;
    for (;;) {
      throwIfAborted(signal, watchDeadlineAt);
      if (record.requestHash !== requestHash) {
        throw new SubAgentRuntimeError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The provider operation conflicts with the admitted canonical request.',
          retryable: false,
          causeCode: 'MODEL_REQUEST_IDEMPOTENCY_CONFLICT',
        });
      }
      if (record.phase === 'completed') {
        return decodeStoredResult(record.reply as JsonValue, payload);
      }
      if (record.phase === 'outcome_unknown') {
        return failureReply(payload, PROVIDER_OUTCOME_UNKNOWN_ERROR);
      }
      await waitForGatewayProgress(signal, watchDeadlineAt, delayMs);
      delayMs = nextGatewayWatchDelay(delayMs);
      const loaded = await this.#ledger.load(identity, {
        signal,
        deadlineAt: watchDeadlineAt,
      });
      if (loaded === undefined) {
        throw new SubAgentRuntimeError({
          code: 'INTERNAL_ERROR',
          message: 'The in-flight provider operation disappeared from durable storage.',
          retryable: false,
          causeCode: 'PROVIDER_OPERATION_LOST',
        });
      }
      record = loaded;
    }
  }

  #boundedWatchDeadline(deadlineAt: number | undefined): number {
    const current = readNow(this.#now);
    const bounded = Math.min(current + this.#watchTimeoutMs, Number.MAX_SAFE_INTEGER);
    return deadlineAt === undefined ? bounded : Math.min(deadlineAt, bounded);
  }

  #backgroundLedgerIo(): Readonly<{ signal?: AbortSignal; deadlineAt: number }> {
    return Object.freeze({ deadlineAt: this.#boundedWatchDeadline(undefined) });
  }
}

function validateGatewayHandleRequest(input: SubAgentTransportModelGatewayHandleRequest): void {
  assertIdentifier(input.ownerSessionId, 'ownerSessionId');
  assertIdentifier(input.taskId, 'taskId');
  assertIdentifier(input.operationId, 'operationId');
  assertValidDeadline(input.deadlineAt);
  const payload = input.payload;
  assertIdentifier(payload.providerOperationId, 'providerOperationId');
  if (payload.providerOperationId !== input.operationId) {
    throw new TypeError('Model gateway operationId must match providerOperationId.');
  }
  assertIdentifier(payload.gatewayId, 'gatewayId');
  assertToken(payload.protocol, 'protocol');
  assertToken(payload.codecVersion, 'codecVersion');
  assertIdentifier(payload.runId, 'runId');
  requiredPositiveInteger(payload.executionAttempt, 'executionAttempt');
  assertIdentifier(payload.executionEpoch, 'executionEpoch');
  assertFencingToken(payload.executionFencingToken, 'executionFencingToken');
  assertIdentifier(payload.checkpointOperationId, 'checkpointOperationId');
  if (!SHA256.test(payload.checkpointDigest)) {
    throw new TypeError('Model checkpointDigest is invalid.');
  }
  requiredNonNegativeInteger(payload.iteration, 'iteration');
  requiredPositiveInteger(payload.requestAttempt, 'requestAttempt');
  if (!SHA256.test(payload.requestHash)) throw new TypeError('Model requestHash is invalid.');
  if (payload.remainingMs !== undefined) {
    requiredNonNegativeInteger(payload.remainingMs, 'remainingMs');
  }
  assertJsonValue(payload.context);
  assertJsonValue(payload.tools);
}

function assertModelReply(reply: ModelReplyPayload, request: ModelRequestPayload): void {
  assertJsonValue(reply as unknown as JsonValue);
  const commonKeys = [
    'providerOperationId',
    'gatewayId',
    'protocol',
    'codecVersion',
    'runId',
    'executionAttempt',
    'executionEpoch',
    'executionFencingToken',
    'checkpointOperationId',
    'checkpointDigest',
    'requestHash',
    'ok',
  ];
  if (reply.ok) {
    assertExactKeys(
      reply as unknown as Record<string, unknown>,
      [...commonKeys, 'resultHash', 'messages'],
      ['usage'],
    );
    if (!SHA256.test(reply.resultHash) || !Array.isArray(reply.messages)) {
      throw new TypeError('Model gateway success reply is invalid.');
    }
    if (reply.usage !== undefined) assertUsage(reply.usage);
  } else {
    assertExactKeys(
      reply as unknown as Record<string, unknown>,
      [...commonKeys, 'error'],
      ['classification'],
    );
  }
  if (
    reply.providerOperationId !== request.providerOperationId ||
    reply.gatewayId !== request.gatewayId ||
    reply.protocol !== request.protocol ||
    reply.codecVersion !== request.codecVersion ||
    reply.runId !== request.runId ||
    reply.executionAttempt !== request.executionAttempt ||
    reply.executionEpoch !== request.executionEpoch ||
    reply.executionFencingToken !== request.executionFencingToken ||
    reply.checkpointOperationId !== request.checkpointOperationId ||
    reply.checkpointDigest !== request.checkpointDigest ||
    reply.requestHash !== request.requestHash
  ) {
    throw new TypeError('Model gateway reply does not match its request identity.');
  }
  if (!reply.ok) assertSafeError(reply.error);
  if (!reply.ok && reply.classification !== undefined) {
    assertModelErrorClassification(reply.classification);
  }
}

function decodeStoredResult(result: JsonValue, request: ModelRequestPayload): ModelReplyPayload {
  const owned = ownJson(result) as unknown as StoredModelGatewayResult;
  if (typeof owned !== 'object' || owned === null || Array.isArray(owned)) {
    throw new TypeError('Stored Model gateway result is invalid.');
  }
  if (owned.ok) {
    assertExactKeys(
      owned as unknown as Record<string, unknown>,
      ['version', 'ok', 'resultHash', 'messages'],
      ['usage'],
    );
    if (
      owned.version !== '1' ||
      !SHA256.test(owned.resultHash) ||
      !Array.isArray(owned.messages) ||
      canonicalJsonSha256(owned.messages) !== owned.resultHash
    ) {
      throw new TypeError('Stored Model gateway success result is invalid.');
    }
    if (owned.usage !== undefined) assertUsage(owned.usage);
    return Object.freeze({
      ...replyIdentity(request),
      ok: true,
      resultHash: owned.resultHash,
      messages: owned.messages,
      ...(owned.usage === undefined ? {} : { usage: owned.usage }),
    });
  }

  assertExactKeys(
    owned as unknown as Record<string, unknown>,
    ['version', 'ok', 'error'],
    ['classification'],
  );
  if (owned.version !== '1') throw new TypeError('Stored Model gateway result version is invalid.');
  assertSafeError(owned.error);
  if (owned.classification !== undefined) {
    assertModelErrorClassification(owned.classification);
  }
  return Object.freeze({
    ...replyIdentity(request),
    ok: false,
    error: owned.error,
    ...(owned.classification === undefined ? {} : { classification: owned.classification }),
  }) satisfies ModelFailureReplyPayload;
}

function replyIdentity(
  input: ModelRequestPayload,
): Pick<
  ModelReplyPayload,
  | 'providerOperationId'
  | 'gatewayId'
  | 'protocol'
  | 'codecVersion'
  | 'runId'
  | 'executionAttempt'
  | 'executionEpoch'
  | 'executionFencingToken'
  | 'checkpointOperationId'
  | 'checkpointDigest'
  | 'requestHash'
> {
  return Object.freeze({
    providerOperationId: input.providerOperationId,
    gatewayId: input.gatewayId,
    protocol: input.protocol,
    codecVersion: input.codecVersion,
    runId: input.runId,
    executionAttempt: input.executionAttempt,
    executionEpoch: input.executionEpoch,
    executionFencingToken: input.executionFencingToken,
    checkpointOperationId: input.checkpointOperationId,
    checkpointDigest: input.checkpointDigest,
    requestHash: input.requestHash,
  });
}

function failureReply(
  input:
    | ModelRequestPayload
    | Pick<
        ModelReplyPayload,
        | 'providerOperationId'
        | 'gatewayId'
        | 'protocol'
        | 'codecVersion'
        | 'runId'
        | 'executionAttempt'
        | 'executionEpoch'
        | 'executionFencingToken'
        | 'checkpointOperationId'
        | 'checkpointDigest'
        | 'requestHash'
      >,
  error: SubAgentErrorDescriptor | SubAgentTransportSafeError,
  classification?: SafeModelErrorClassification,
): ModelReplyPayload {
  return Object.freeze({
    ...replyIdentity(input as ModelRequestPayload),
    ok: false,
    error: safeError(error),
    ...(classification === undefined
      ? {}
      : {
          classification: Object.freeze({
            kind: classification.kind,
            status: classification.status,
          }),
        }),
  });
}

function classifyProviderFailure(
  model: Model<AgentProtocol>,
  error: unknown,
  request: Readonly<ModelGenerateRequest<AgentProtocol>>,
  signal: AbortSignal,
): Readonly<{
  error: SubAgentTransportSafeError;
  classification?: SafeModelErrorClassification;
}> {
  if (isAbortError(error, signal)) {
    return Object.freeze({ error: PROVIDER_OUTCOME_UNKNOWN_ERROR });
  }
  let classification: ModelErrorDescriptor | undefined;
  try {
    classification = model.classifyError(error, {
      purpose: request.purpose ?? 'agent',
      request,
    });
  } catch {
    return Object.freeze({ error: PROVIDER_OUTCOME_UNKNOWN_ERROR });
  }
  if (
    Number.isSafeInteger(classification.status) &&
    classification.status! >= 400 &&
    classification.status! <= 599
  ) {
    const safeClassification = Object.freeze({
      kind: safeClassificationKind(classification.kind),
      status: classification.status!,
    });
    return Object.freeze({
      error: Object.freeze({
        code: 'INTERNAL_ERROR',
        message: 'The provider rejected the Model request.',
        retryable: false,
        causeCode:
          safeClassification.kind === 'context_length_exceeded'
            ? 'MODEL_CONTEXT_LENGTH_EXCEEDED'
            : 'MODEL_PROVIDER_REJECTED',
      }),
      classification: safeClassification,
    });
  }
  return Object.freeze({
    error: Object.freeze({
      ...PROVIDER_OUTCOME_UNKNOWN_ERROR,
      causeCode:
        classification.kind === 'context_length_exceeded'
          ? 'MODEL_CONTEXT_LENGTH_EXCEEDED_OUTCOME_UNKNOWN'
          : 'PROVIDER_REQUEST_OUTCOME_UNKNOWN',
    }),
  });
}

function safeBoundaryError(
  error: unknown,
  signal?: AbortSignal,
): Readonly<SubAgentTransportSafeError> {
  if (isAbortError(error, signal)) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return Object.freeze({
      code: timedOut ? 'TIMED_OUT' : 'CANCELLED',
      message: timedOut
        ? 'The Model gateway deadline was exceeded.'
        : 'The Model gateway was cancelled.',
      retryable: timedOut,
      causeCode: timedOut ? 'MODEL_GATEWAY_TIMED_OUT' : 'MODEL_GATEWAY_CANCELLED',
    });
  }
  if (error instanceof SubAgentRuntimeError) return safeError(error.descriptor);
  return Object.freeze({
    code: 'INTERNAL_ERROR',
    message: 'The Model gateway could not complete the request.',
    retryable: false,
    causeCode: 'MODEL_GATEWAY_FAILED',
  });
}

function safeError(
  error: SubAgentErrorDescriptor | SubAgentTransportSafeError,
): Readonly<SubAgentTransportSafeError> {
  const code = SAFE_ERROR_CODES.has(error.code) ? error.code : 'INTERNAL_ERROR';
  const causeCode = safeCauseCode(error.causeCode);
  return Object.freeze({
    code,
    message: stableErrorMessage(code),
    retryable: error.retryable === true,
    ...(causeCode === undefined ? {} : { causeCode }),
    ...(error.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
  });
}

function stableErrorMessage(code: SubAgentErrorDescriptor['code']): string {
  switch (code) {
    case 'RESOURCE_NOT_FOUND':
      return RESOURCE_NOT_FOUND_ERROR.message;
    case 'BUDGET_EXCEEDED':
      return 'The Model gateway budget was exceeded.';
    case 'CANCELLED':
      return 'The Model gateway was cancelled.';
    case 'TIMED_OUT':
      return 'The Model gateway deadline was exceeded.';
    case 'IDEMPOTENCY_CONFLICT':
      return 'The Model gateway operation conflicts with an existing request.';
    case 'EXECUTOR_FAILED':
      return 'The provider model request has an unknown outcome.';
    default:
      return 'The Model gateway could not complete the request.';
  }
}

function safeCauseCode(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value) ? value : undefined;
}

function assertSafeError(value: SubAgentTransportSafeError): void {
  assertExactKeys(
    value as unknown as Record<string, unknown>,
    ['code', 'message', 'retryable'],
    ['causeCode', 'outcomeUnknown'],
  );
  if (
    !SAFE_ERROR_CODES.has(value.code) ||
    typeof value.message !== 'string' ||
    value.message.length < 1 ||
    value.message !== value.message.trim() ||
    textEncoder.encode(value.message).byteLength > 4_096 ||
    typeof value.retryable !== 'boolean' ||
    (value.causeCode !== undefined && safeCauseCode(value.causeCode) === undefined) ||
    (value.outcomeUnknown !== undefined && typeof value.outcomeUnknown !== 'boolean')
  ) {
    throw new TypeError('Model gateway reply contains an unsafe error descriptor.');
  }
}

function normalizeModelUsage(
  value: ModelGenerateUsage | undefined,
): Readonly<ModelGenerateUsage> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Model gateway usage must be an object.');
  }
  assertExactKeys(
    value as Record<string, unknown>,
    [],
    ['inputTokens', 'outputTokens', 'totalTokens'],
  );
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  const totalTokens = value.totalTokens;
  const normalized = Object.freeze({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  });
  assertUsage(normalized);
  return normalized;
}

function assertUsage(value: NonNullable<ModelSuccessReplyPayload['usage']>): void {
  assertExactKeys(
    value as Record<string, unknown>,
    [],
    ['inputTokens', 'outputTokens', 'totalTokens'],
  );
  const counts = [value.inputTokens, value.outputTokens, value.totalTokens];
  if (counts.every((count) => count === undefined)) {
    throw new TypeError('Model gateway usage must include at least one token count.');
  }
  for (const count of counts) {
    if (count !== undefined) requiredNonNegativeInteger(count, 'usage token count');
  }
}

function assertModelErrorClassification(value: SafeModelErrorClassification): void {
  assertExactKeys(value as unknown as Record<string, unknown>, ['kind', 'status']);
  if (
    safeClassificationKind(value.kind) !== value.kind ||
    !Number.isSafeInteger(value.status) ||
    value.status < 400 ||
    value.status > 599
  ) {
    throw new TypeError('Model gateway classification is invalid.');
  }
}

function safeClassificationKind(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ? value : 'unknown';
}

function assertCheckpointAcknowledgement(
  value: Readonly<{ readonly checkpointRevision: number; readonly checkpointDigest: string }>,
  expectedDigest: string,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Model gateway checkpoint acknowledgement is invalid.');
  }
  assertExactKeys(value as unknown as Record<string, unknown>, [
    'checkpointRevision',
    'checkpointDigest',
  ]);
  requiredPositiveInteger(value.checkpointRevision, 'checkpointRevision');
  if (!SHA256.test(value.checkpointDigest) || value.checkpointDigest !== expectedDigest) {
    throw new SubAgentRuntimeError({
      code: 'CHECKPOINT_VERSION_MISMATCH',
      message: 'The acknowledged child checkpoint digest does not match the Model request.',
      retryable: false,
      causeCode: 'MODEL_CHECKPOINT_ACK_MISMATCH',
    });
  }
}

function providerOperationIdentity(
  operation: Pick<
    SubAgentTransportModelGatewayOperation,
    'ownerSessionId' | 'taskId' | 'providerOperationId'
  >,
): Readonly<ProviderOperationIdentity> {
  return Object.freeze({
    ownerSessionId: operation.ownerSessionId,
    taskId: operation.taskId,
    providerOperationId: operation.providerOperationId,
  });
}

function providerOperationKey(
  operation: Pick<
    SubAgentTransportModelGatewayOperation,
    'ownerSessionId' | 'taskId' | 'providerOperationId'
  >,
): string {
  return canonicalizeJson(providerOperationIdentity(operation));
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError('Model gateway value does not match its closed schema.');
  }
}

function ownJson(value: JsonValue): JsonValue {
  return deepFreezeJson(parseJsonValue(canonicalizeJson(value)));
}

function createDeferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function nextGatewayWatchDelay(delayMs: number): number {
  return Math.min(delayMs * 2, MODEL_GATEWAY_WATCH_MAX_DELAY_MS);
}

function waitForGatewayProgress(
  signal: AbortSignal,
  deadlineAt: number,
  delayMs: number,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? createAbortError());
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) return Promise.reject(createDeadlineExceededError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.min(delayMs, remainingMs),
    );
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
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

function remainingDeadline(deadlineAt: number | undefined, now: () => number): number | undefined {
  if (deadlineAt === undefined) return undefined;
  const current = readNow(now);
  const remaining = Math.floor(deadlineAt - current);
  if (remaining <= 0) throw createDeadlineExceededError();
  return Math.min(remaining, Number.MAX_SAFE_INTEGER);
}

function controllerDeadline(
  remainingMs: number | undefined,
  now: () => number,
): number | undefined {
  if (remainingMs === undefined) return undefined;
  if (remainingMs === 0) throw createDeadlineExceededError();
  const current = readNow(now);
  return Math.min(current + remainingMs, Number.MAX_SAFE_INTEGER);
}

function earliestDeadline(
  trustedDeadlineAt: number | undefined,
  targetDeadlineAt: number | undefined,
): number | undefined {
  assertValidDeadline(trustedDeadlineAt);
  assertValidDeadline(targetDeadlineAt);
  if (trustedDeadlineAt === undefined) return targetDeadlineAt;
  if (targetDeadlineAt === undefined) return trustedDeadlineAt;
  return Math.min(trustedDeadlineAt, targetDeadlineAt);
}

async function awaitWithGatewayDeadline<T>(
  value: PromiseLike<T>,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
): Promise<T> {
  const scope = createAbortScope(signal, deadlineAt);
  try {
    throwIfAborted(scope.signal, deadlineAt);
    return await awaitWithAbort(value, scope.signal);
  } finally {
    scope.dispose();
  }
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Model gateway clock must return a non-negative safe integer.');
  }
  return value;
}

function assertCodec<P extends AgentProtocol>(codec: AgentProtocolCheckpointCodec<P>): void {
  assertToken(codec.protocol, 'checkpoint codec protocol');
  assertToken(codec.version, 'checkpoint codec version');
  if (typeof codec.encode !== 'function' || typeof codec.decode !== 'function') {
    throw new TypeError('A Model gateway checkpoint codec requires encode and decode functions.');
  }
}

function assertProtocolSurface<P extends AgentProtocol>(
  value: SubAgentTransportModelProtocolSurface<P>,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('A transport Model proxy requires a protocol-only surface.');
  }
  for (const method of [
    'buildUserMessage',
    'buildSystemMessage',
    'buildToolCallOutputMessage',
    'buildToolMessage',
    'parseUserMessages',
    'parseSystemMessages',
    'parseAssistantMessages',
    'parseToolCalls',
    'parseToolCallOutputMessages',
    'rewriteToolPayloads',
    'extractAssistantText',
    'classifyError',
  ] as const) {
    if (typeof value[method] !== 'function') {
      throw new TypeError(`A transport Model protocol surface requires ${method}().`);
    }
  }
}

function requiredIdentifier(value: unknown, label: string): string {
  assertIdentifier(value, label);
  return value;
}

function requiredSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`Model gateway ${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requiredFencingToken(value: unknown, label: string): string {
  assertFencingToken(value, label);
  return value;
}

function assertFencingToken(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`Model gateway ${label} must be a canonical decimal token.`);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    textEncoder.encode(value).byteLength < 1 ||
    textEncoder.encode(value).byteLength > 256 ||
    containsControlCharacter(value)
  ) {
    throw new TypeError(`Model gateway ${label} is not a bounded identifier.`);
  }
  assertJsonValue(value);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function assertToken(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError(`Model gateway ${label} is invalid.`);
  }
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Model gateway ${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`Model gateway ${label} must be a positive safe integer.`);
  }
  return value as number;
}
