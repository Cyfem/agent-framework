import { types as nodeTypes } from 'node:util';

import type { SubAgentChildCheckpoint } from './checkpoint';
import type { SubAgentChildRunRequest, SubAgentChildRunner } from './child-runner';
import {
  defineSubAgent,
  type SubAgentDefinition,
  type SubAgentDefinitionRef,
  type SubAgentDefinitionRegistration,
} from './definition';
import { SubAgentRuntimeError, type SubAgentErrorCode } from './errors';
import {
  SUBAGENT_RUNTIME_PROTOCOL_VERSION,
  type SubAgentExecutionRequest,
  type SubAgentExecutorBinding,
  type SubAgentExecutorModelBinding,
} from './executor';
import { assertCanonicalFencingToken } from './fencing-token';
import { assertJsonValue, canonicalJsonSha256, type JsonValue } from './json';
import { DEFAULT_SUBAGENT_IO_LIMITS, resolveSubAgentLimits } from './limits';
import { cloneJsonValue } from './runtime-support';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const MAX_IDENTITY_LENGTH = 128;

/** Trusted host-only context passed to a target-local child runner factory. */
export interface SubAgentTargetRunnerFactoryContext<
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> {
  readonly request: SubAgentChildRunRequest<I>;
  readonly definition: SubAgentDefinition<I, O>;
  readonly executorName: string;
  /** Credential-free controller Model binding declared by transport-ready registrations. */
  readonly modelBinding?: SubAgentTargetModelBinding;
}

/** Closed, credential-free identity used to construct a target-side Model proxy. */
export type SubAgentTargetModelBinding = SubAgentExecutorModelBinding;

/** One exact definition-version to target-local runner binding. Nothing in this shape is wire data. */
export interface SubAgentTargetRunnerRegistration<
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> {
  readonly definition: SubAgentDefinition<I, O>;
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly childCheckpointVersions: readonly string[];
  /** Required by Worker/Process/HTTP target bridges; Local registrations may omit it. */
  readonly modelBinding?: SubAgentTargetModelBinding;
  create(
    context: SubAgentTargetRunnerFactoryContext<I, O>,
  ): SubAgentChildRunner | Promise<SubAgentChildRunner>;
}

export interface SubAgentTargetRunnerIdentity {
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly childCheckpointVersions: readonly string[];
}

export interface SubAgentTargetRunnerManifestEntry {
  readonly definition: SubAgentDefinitionRef;
  readonly runner: SubAgentTargetRunnerIdentity;
  readonly modelBinding?: SubAgentTargetModelBinding;
}

export interface SubAgentTargetRunnerManifest {
  readonly version: '1';
  readonly runtimeProtocolVersion: typeof SUBAGENT_RUNTIME_PROTOCOL_VERSION;
  readonly registrations: readonly SubAgentTargetRunnerManifestEntry[];
  /** RFC 8785/JCS SHA-256 of the manifest with this field omitted. */
  readonly digest: string;
}

/**
 * Validated target-local execution. The factory is intentionally delayed until every trust-boundary
 * check has completed, and may be invoked at most once.
 */
export interface PreparedSubAgentTargetRunner<I extends JsonValue = JsonValue> {
  readonly request: SubAgentChildRunRequest<I>;
  readonly definition: SubAgentDefinition<I, JsonValue>;
  readonly runner: SubAgentTargetRunnerIdentity;
  readonly modelBinding?: SubAgentTargetModelBinding;
  create(): Promise<SubAgentChildRunner>;
}

type RegisteredFactory = (
  context: SubAgentTargetRunnerFactoryContext,
) => SubAgentChildRunner | Promise<SubAgentChildRunner>;

type RegisteredFactoryInput = (
  context: never,
) => SubAgentChildRunner | Promise<SubAgentChildRunner>;

/**
 * Existential shape accepted by a heterogeneous target registry. `never` erases the factory
 * input contravariantly; callers should declare a typed `SubAgentTargetRunnerRegistration<I, O>`
 * before placing it in this collection.
 */
export interface SubAgentTargetRunnerRegistrationEntry {
  readonly definition: SubAgentDefinitionRegistration;
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly childCheckpointVersions: readonly string[];
  readonly modelBinding?: SubAgentTargetModelBinding;
  readonly create: RegisteredFactoryInput;
}

interface StoredRegistration {
  readonly definition: SubAgentDefinition;
  readonly runner: SubAgentTargetRunnerIdentity;
  readonly modelBinding?: SubAgentTargetModelBinding;
  readonly create: RegisteredFactory;
}

/**
 * Exact, trusted target-side definition/runner registry shared by isolated placement adapters.
 * Registration is host-only; `seal()` permanently freezes its externally observable snapshot.
 */
export class SubAgentTargetRunnerRegistry {
  readonly #registrations = new Map<string, StoredRegistration>();
  readonly #definitionVersions = new Map<string, Set<string>>();
  readonly #runners = new Map<string, SubAgentTargetRunnerIdentity>();
  #sealed = false;
  #manifest?: SubAgentTargetRunnerManifest;

  constructor(registrations: readonly SubAgentTargetRunnerRegistrationEntry[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: SubAgentTargetRunnerRegistrationEntry): this {
    if (this.#sealed) {
      throw new Error('The Subagent target runner registry is sealed.');
    }
    if (
      (typeof registration !== 'object' && typeof registration !== 'function') ||
      registration === null ||
      nodeTypes.isProxy(registration)
    ) {
      throw new TypeError('A target runner registration must be a trusted plain host object.');
    }
    if (
      (typeof registration.definition !== 'object' &&
        typeof registration.definition !== 'function') ||
      registration.definition === null ||
      nodeTypes.isProxy(registration.definition)
    ) {
      throw new TypeError('A target runner registration requires a trusted definition object.');
    }

    const definition = defineSubAgent({
      ...registration.definition,
    } as unknown as SubAgentDefinition);
    assertIdentifier('runnerId', registration.runnerId, IDENTIFIER_PATTERN);
    assertIdentifier('runnerVersion', registration.runnerVersion, VERSION_PATTERN);
    const childCheckpointVersions = normalizeVersions(registration.childCheckpointVersions);
    const modelBinding = normalizeModelBinding(registration.modelBinding);
    if (typeof registration.create !== 'function') {
      throw new TypeError('A target runner registration requires a create() factory.');
    }

    const key = definitionKey(definition);
    if (this.#registrations.has(key)) {
      throw new TypeError(
        `A target runner is already registered for ${definition.name}@${definition.version}.`,
      );
    }

    const runnerKey = identityKey(registration.runnerId, registration.runnerVersion);
    const existingRunner = this.#runners.get(runnerKey);
    if (
      existingRunner !== undefined &&
      !sameStringArray(existingRunner.childCheckpointVersions, childCheckpointVersions)
    ) {
      throw new TypeError('A target runner identity must declare one checkpoint-version set.');
    }
    const runner =
      existingRunner ??
      Object.freeze({
        runnerId: registration.runnerId,
        runnerVersion: registration.runnerVersion,
        childCheckpointVersions,
      });

    this.#runners.set(runnerKey, runner);
    const versions = this.#definitionVersions.get(definition.name) ?? new Set<string>();
    versions.add(definition.version);
    this.#definitionVersions.set(definition.name, versions);
    this.#registrations.set(
      key,
      Object.freeze({
        definition: definition as unknown as SubAgentDefinition,
        runner,
        ...(modelBinding === undefined ? {} : { modelBinding }),
        create: registration.create as unknown as RegisteredFactory,
      }),
    );
    return this;
  }

  seal(): this {
    if (!this.#sealed) {
      this.#manifest = createManifest(this.#registrations.values());
      this.#sealed = true;
    }
    return this;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  has(definition: SubAgentDefinitionRef): boolean {
    return this.#registrations.has(definitionKey(definition));
  }

  list(): readonly SubAgentDefinitionRef[] {
    return Object.freeze(
      [...this.#registrations.values()]
        .map(({ definition }) =>
          Object.freeze({ name: definition.name, version: definition.version }),
        )
        .sort(compareDefinitions),
    );
  }

  definitionFor<I extends JsonValue = JsonValue>(
    definition: SubAgentDefinitionRef,
  ): SubAgentDefinition<I, JsonValue> {
    return this.#resolve(definition).definition as unknown as SubAgentDefinition<I, JsonValue>;
  }

  runnerFor(definition: SubAgentDefinitionRef): SubAgentTargetRunnerIdentity {
    return this.#resolve(definition).runner;
  }

  listRunnerCompatibility(): readonly SubAgentTargetRunnerIdentity[] {
    return Object.freeze(
      [...this.#runners.values()].sort((left, right) =>
        compareCodeUnits(
          identityKey(left.runnerId, left.runnerVersion),
          identityKey(right.runnerId, right.runnerVersion),
        ),
      ),
    );
  }

  manifest(): SubAgentTargetRunnerManifest {
    if (!this.#sealed || this.#manifest === undefined) {
      throw new Error('Seal the Subagent target runner registry before reading its manifest.');
    }
    return this.#manifest;
  }

  /** Fail closed before a transport target accepts traffic. Local-only registries need not call it. */
  assertTransportReady(): void {
    if (!this.#sealed) {
      throw new Error('Seal the Subagent target runner registry before transport validation.');
    }
    for (const registration of this.#registrations.values()) {
      if (registration.modelBinding === undefined) {
        throw new TypeError(
          `Transport target registration ${registration.definition.name}@${registration.definition.version} requires a protocol/codec/Model gateway binding.`,
        );
      }
    }
  }

  /**
   * Resolve and revalidate one execution at the target boundary. No runner factory is called here;
   * callers invoke the returned one-shot `create()` only after their remaining placement checks.
   */
  prepareExecution<I extends JsonValue = JsonValue>(
    request: SubAgentExecutionRequest<I>,
    executorName: string,
  ): PreparedSubAgentTargetRunner<I> {
    if (!this.#sealed) {
      throw new Error('Seal the Subagent target runner registry before preparing execution.');
    }
    assertIdentifier('executorName', executorName, IDENTIFIER_PATTERN);
    assertCanonicalFencingToken(request.executionFencingToken, 'executionFencingToken');
    const registration = this.#resolve(request.definition);

    if (request.operation.type === 'reconnect') {
      assertBinding(
        request.operation.binding,
        request,
        executorName,
        registration.runner,
        registration.modelBinding,
      );
      throw runtimeError(
        'RECOVERY_UNSUPPORTED',
        'A reconnect must attach to the existing external job and cannot create a target runner.',
      );
    }
    if (request.operation.type === 'resume') {
      assertBinding(
        request.operation.binding,
        request,
        executorName,
        registration.runner,
        registration.modelBinding,
      );
      assertCheckpoint(request.operation.checkpoint, registration.runner);
    } else if (request.operation.type !== 'create') {
      throw runtimeError('BINDING_INVALID', 'The target execution operation is invalid.');
    }

    const input = parseInput(registration.definition, request.input);
    const childRequest = createOwnedChildRequest(request, input);
    let factoryInvoked = false;
    const preparation: PreparedSubAgentTargetRunner<I> = {
      request: childRequest as SubAgentChildRunRequest<I>,
      definition: registration.definition as unknown as SubAgentDefinition<I, JsonValue>,
      runner: registration.runner,
      ...(registration.modelBinding === undefined
        ? {}
        : { modelBinding: registration.modelBinding }),
      create: async () => {
        if (factoryInvoked) {
          throw runtimeError(
            'INVALID_STATE_TRANSITION',
            'A prepared target runner factory may be invoked only once.',
          );
        }
        factoryInvoked = true;
        const context = Object.freeze({
          request: childRequest,
          definition: registration.definition,
          executorName,
          ...(registration.modelBinding === undefined
            ? {}
            : { modelBinding: registration.modelBinding }),
        });
        const runner = await registration.create(context);
        if (typeof runner !== 'object' || runner === null || typeof runner.run !== 'function') {
          throw runtimeError(
            'INTERNAL_ERROR',
            'A target runner factory returned an invalid runner.',
          );
        }
        return runner;
      },
    };
    return Object.freeze(preparation);
  }

  #resolve(definition: SubAgentDefinitionRef): StoredRegistration {
    const registration = this.#registrations.get(definitionKey(definition));
    if (registration !== undefined) return registration;

    if (this.#definitionVersions.has(definition.name)) {
      throw runtimeError(
        'DEFINITION_VERSION_MISMATCH',
        'The target does not provide the requested subagent definition version.',
      );
    }
    throw runtimeError(
      'DEFINITION_NOT_FOUND',
      'The target does not provide the requested subagent definition.',
    );
  }
}

function parseInput(definition: SubAgentDefinition, input: unknown): JsonValue {
  let parsed: ReturnType<SubAgentDefinition['inputSchema']['safeParse']>;
  try {
    parsed = definition.inputSchema.safeParse(input);
  } catch {
    throw runtimeError('INVALID_INPUT', 'The target subagent input failed schema validation.');
  }
  if (!parsed.success) {
    throw runtimeError('INVALID_INPUT', 'The target subagent input failed schema validation.');
  }
  try {
    assertJsonValue(parsed.data, {
      maxBytes: DEFAULT_SUBAGENT_IO_LIMITS.maxInputBytes,
      label: 'Target subagent input',
    });
    return freezeJson(cloneJsonValue(parsed.data));
  } catch {
    throw runtimeError(
      'INVALID_INPUT',
      'The target subagent input is not JSON-safe or exceeds the input byte limit.',
    );
  }
}

function createOwnedChildRequest(
  request: SubAgentExecutionRequest,
  input: JsonValue,
): SubAgentChildRunRequest {
  let snapshot: JsonValue;
  try {
    const serializable = {
      ownerSessionId: request.ownerSessionId,
      runId: request.runId,
      taskId: request.taskId,
      ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
      subagentSessionId: request.subagentSessionId,
      path: request.path,
      attempt: request.attempt,
      executionEpoch: request.executionEpoch,
      executionFencingToken: request.executionFencingToken,
      definition: request.definition,
      input,
      projectedContext: request.projectedContext,
      delegation: request.delegation,
      limits: resolveSubAgentLimits(request.limits),
      ...(request.operation.type === 'resume' ? { checkpoint: request.operation.checkpoint } : {}),
      deadlineAt: request.deadlineAt,
    };
    assertJsonValue(serializable);
    snapshot = freezeJson(cloneJsonValue(serializable));
  } catch (error) {
    if (error instanceof SubAgentRuntimeError) throw error;
    throw runtimeError(
      'BINDING_INVALID',
      'The target execution request cannot be captured as an owned JSON-safe snapshot.',
    );
  }

  const owned = snapshot as unknown as Omit<SubAgentChildRunRequest, 'signal'>;
  return Object.freeze({ ...owned, signal: request.signal });
}

function assertBinding(
  binding: SubAgentExecutorBinding,
  request: SubAgentExecutionRequest,
  executorName: string,
  runner: SubAgentTargetRunnerIdentity,
  modelBinding: SubAgentTargetModelBinding | undefined,
): void {
  if (
    typeof binding !== 'object' ||
    binding === null ||
    nodeTypes.isProxy(binding) ||
    binding.version !== '1' ||
    binding.executorName !== executorName ||
    binding.ownerSessionId !== request.ownerSessionId ||
    binding.taskId !== request.taskId ||
    binding.subagentSessionId !== request.subagentSessionId ||
    binding.definitionName !== request.definition.name ||
    binding.definitionVersion !== request.definition.version ||
    binding.runnerId !== runner.runnerId ||
    binding.runnerVersion !== runner.runnerVersion ||
    !modelBindingsEqual(binding.modelBinding, modelBinding)
  ) {
    throw runtimeError(
      'BINDING_INVALID',
      'The target execution binding is incompatible with the requested runner.',
    );
  }
}

function modelBindingsEqual(
  left: SubAgentExecutorModelBinding | undefined,
  right: SubAgentTargetModelBinding | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.gatewayId === right.gatewayId &&
    left.protocol === right.protocol &&
    left.codecVersion === right.codecVersion
  );
}

function assertCheckpoint(
  checkpoint: SubAgentChildCheckpoint,
  runner: SubAgentTargetRunnerIdentity,
): void {
  if (
    typeof checkpoint !== 'object' ||
    checkpoint === null ||
    nodeTypes.isProxy(checkpoint) ||
    checkpoint.runnerId !== runner.runnerId ||
    checkpoint.runnerVersion !== runner.runnerVersion ||
    !runner.childCheckpointVersions.includes(checkpoint.version)
  ) {
    throw runtimeError(
      'CHECKPOINT_VERSION_MISMATCH',
      'The target child checkpoint is incompatible with the requested runner.',
    );
  }
}

function createManifest(registrations: Iterable<StoredRegistration>): SubAgentTargetRunnerManifest {
  const entries = Object.freeze(
    [...registrations]
      .map(({ definition, runner, modelBinding }) =>
        Object.freeze({
          definition: Object.freeze({ name: definition.name, version: definition.version }),
          runner,
          ...(modelBinding === undefined ? {} : { modelBinding }),
        }),
      )
      .sort((left, right) => compareDefinitions(left.definition, right.definition)),
  );
  const bodyValue: JsonValue = {
    version: '1',
    runtimeProtocolVersion: SUBAGENT_RUNTIME_PROTOCOL_VERSION,
    registrations: entries.map(({ definition, runner, modelBinding }) => ({
      definition: { name: definition.name, version: definition.version },
      runner: {
        runnerId: runner.runnerId,
        runnerVersion: runner.runnerVersion,
        childCheckpointVersions: runner.childCheckpointVersions,
      },
      ...(modelBinding === undefined
        ? {}
        : {
            modelBinding: {
              gatewayId: modelBinding.gatewayId,
              protocol: modelBinding.protocol,
              codecVersion: modelBinding.codecVersion,
            },
          }),
    })),
  };
  const body = freezeJson(bodyValue) as unknown as Omit<SubAgentTargetRunnerManifest, 'digest'>;
  return Object.freeze({
    ...body,
    digest: canonicalJsonSha256(body as unknown as JsonValue),
  });
}

function normalizeModelBinding(
  input: SubAgentTargetModelBinding | undefined,
): SubAgentTargetModelBinding | undefined {
  if (input === undefined) return undefined;
  if (
    typeof input !== 'object' ||
    input === null ||
    nodeTypes.isProxy(input) ||
    Object.keys(input).sort().join(',') !== 'codecVersion,gatewayId,protocol'
  ) {
    throw new TypeError('A target Model binding must be a trusted closed host object.');
  }
  assertIdentifier('Model gatewayId', input.gatewayId, IDENTIFIER_PATTERN);
  assertIdentifier('Model protocol', input.protocol, IDENTIFIER_PATTERN);
  assertIdentifier('Model codecVersion', input.codecVersion, VERSION_PATTERN);
  return Object.freeze({
    gatewayId: input.gatewayId,
    protocol: input.protocol,
    codecVersion: input.codecVersion,
  });
}

function normalizeVersions(versions: readonly string[]): readonly string[] {
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new TypeError('Target runner childCheckpointVersions must be a non-empty array.');
  }
  const snapshot = [...versions];
  for (const version of snapshot) {
    assertIdentifier('child checkpoint version', version, VERSION_PATTERN);
  }
  if (new Set(snapshot).size !== snapshot.length) {
    throw new TypeError('Target runner childCheckpointVersions must be unique.');
  }
  return Object.freeze(snapshot.sort());
}

function assertIdentifier(label: string, value: string, pattern: RegExp): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_IDENTITY_LENGTH ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    throw new TypeError(`A target runner registration requires a valid ${label}.`);
  }
}

function definitionKey(definition: SubAgentDefinitionRef): string {
  return `${definition.name}\0${definition.version}`;
}

function identityKey(runnerId: string, runnerVersion: string): string {
  return `${runnerId}\0${runnerVersion}`;
}

function compareDefinitions(left: SubAgentDefinitionRef, right: SubAgentDefinitionRef): number {
  return compareCodeUnits(definitionKey(left), definitionKey(right));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  const pending: object[] = [value];
  while (pending.length > 0) {
    const current = pending.pop() as JsonValue[] | { readonly [key: string]: JsonValue };
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (typeof child === 'object' && child !== null && !Object.isFrozen(child)) {
        pending.push(child);
      }
    }
    Object.freeze(current);
  }
  return value;
}

function runtimeError(code: SubAgentErrorCode, message: string): SubAgentRuntimeError {
  return new SubAgentRuntimeError({ code, message, retryable: false });
}
