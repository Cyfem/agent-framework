import type {
  ExecutorAvailability,
  ExecutorAvailabilityProbe,
  ExecutorCatalogPolicy,
  ExecutorCatalogSnapshot,
  SubAgentCatalogEntry,
  SubAgentCatalogExecutorEntry,
  SubAgentExecutorDescriptor,
} from './catalog';
import type { ExecutorCapabilityRequirement, SubAgentDefinition } from './definition';
import { definitionKey, SubAgentDefinitionRegistry } from './definition-registry';
import { SubAgentRuntimeError } from './errors';
import type { SubAgentExecutor } from './executor';
import type { SubAgentDefinitionRef } from './identity';
import type { ModelSubAgentRequest } from './runtime';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const MAX_IDENTITY_LENGTH = 64;
const MAX_DESCRIPTION_BYTES = 4_096;
const MAX_USE_CASE_BYTES = 1_024;

interface ExecutorRegistration {
  readonly executor: SubAgentExecutor;
  readonly descriptor: SubAgentExecutorDescriptor;
  supportedDefinitionKeys: ReadonlySet<string> | undefined;
}

interface EligibilityResult {
  readonly eligible: boolean;
  readonly reason:
    | 'eligible'
    | 'executor-disallowed'
    | 'unsupported-definition'
    | 'unsupported-capability'
    | 'unavailable';
}

export interface SubAgentExecutionTarget {
  readonly definition: SubAgentDefinition;
  readonly executor: SubAgentExecutor;
  readonly descriptor: SubAgentExecutorDescriptor;
  readonly snapshotRevision: number;
}

/**
 * Immutable Executor registration plus explicitly refreshed availability.
 * Catalog reads and model schema construction never call an Executor or the network.
 */
export class SubAgentExecutorRegistry {
  readonly #definitions: SubAgentDefinitionRegistry;
  readonly #registrations: readonly ExecutorRegistration[];
  readonly #byName = new Map<string, ExecutorRegistration>();
  readonly #policy: Readonly<ExecutorCatalogPolicy>;
  readonly #now: () => number;
  #snapshot?: ExecutorCatalogSnapshot;

  constructor(options: {
    readonly definitions: SubAgentDefinitionRegistry;
    readonly executors: readonly SubAgentExecutor[];
    readonly catalogPolicy?: ExecutorCatalogPolicy;
    readonly now?: () => number;
  }) {
    this.#definitions = options.definitions;
    this.#policy = cloneCatalogPolicy(options.catalogPolicy);
    this.#now = options.now ?? Date.now;

    const registrations: ExecutorRegistration[] = [];
    for (const executor of options.executors) {
      const descriptor = validateAndCloneDescriptor(executor);
      if (this.#byName.has(descriptor.name)) {
        throw new TypeError(`Subagent Executor "${descriptor.name}" is registered more than once.`);
      }
      const registration: ExecutorRegistration = {
        executor,
        descriptor,
        supportedDefinitionKeys: undefined,
      };
      registrations.push(registration);
      this.#byName.set(descriptor.name, registration);
    }

    registrations.sort((left, right) => compareText(left.descriptor.name, right.descriptor.name));
    this.#registrations = Object.freeze(registrations);
  }

  get ready(): boolean {
    return this.#snapshot !== undefined;
  }

  /** Captures static supports() decisions and the first explicit availability snapshot. */
  async init(): Promise<ExecutorCatalogSnapshot> {
    if (this.#snapshot !== undefined) {
      return this.#snapshot;
    }

    const definitions = this.#definitions.listExact();
    const supportSets = await Promise.all(
      this.#registrations.map(async ({ executor }) => {
        const supported = new Set<string>();
        for (const definition of definitions) {
          const result = await executor.supports({
            name: definition.name,
            version: definition.version,
          });
          if (typeof result !== 'boolean') {
            throw new TypeError('Subagent Executor supports() must return a boolean.');
          }
          if (result) {
            supported.add(definitionKey(definition));
          }
        }
        return supported;
      }),
    );
    const availability = await this.#probeAvailability();

    for (let index = 0; index < this.#registrations.length; index += 1) {
      this.#registrations[index]!.supportedDefinitionKeys = supportSets[index]!;
    }
    this.#snapshot = freezeSnapshot(1, this.#readNow(), availability);
    return this.#snapshot;
  }

  /** The only operation that updates availability; it never reruns static supports(). */
  async refreshCatalog(): Promise<ExecutorCatalogSnapshot> {
    const current = this.#requireSnapshot();
    const availability = await this.#probeAvailability();
    this.#snapshot = freezeSnapshot(current.revision + 1, this.#readNow(), availability);
    return this.#snapshot;
  }

  getCatalog(): ExecutorCatalogSnapshot {
    return this.#requireSnapshot();
  }

  /** Exact registered adapter lookup for trusted recovery paths; it does not apply active catalog policy. */
  getExecutor(name: string): SubAgentExecutor | undefined {
    return this.#byName.get(name)?.executor;
  }

  /** Returns the current captured availability without probing the adapter. */
  getAvailability(name: string): ExecutorAvailability | undefined {
    return this.#requireSnapshot().executors.find((entry) => entry.descriptor.name === name);
  }

  getCatalogEntries(): readonly SubAgentCatalogEntry[] {
    const snapshot = this.#requireSnapshot();
    const availabilityByName = new Map(
      snapshot.executors.map((availability) => [availability.descriptor.name, availability]),
    );
    const entries: SubAgentCatalogEntry[] = [];

    for (const definition of this.#definitions.listActive()) {
      const executors: SubAgentCatalogExecutorEntry[] = [];
      for (const registration of this.#registrations) {
        const availability = availabilityByName.get(registration.descriptor.name)!;
        if (!this.#eligibility(definition, registration, availability).eligible) {
          continue;
        }
        executors.push(
          Object.freeze({
            ...registration.descriptor,
            status: availability.status as 'available' | 'degraded',
            ...(availability.reasonCode === undefined
              ? {}
              : { reasonCode: availability.reasonCode }),
          }),
        );
      }
      if (executors.length === 0) {
        continue;
      }
      entries.push(
        Object.freeze({
          definition: Object.freeze({ name: definition.name, version: definition.version }),
          description: definition.description,
          inputSchema: definition.inputSchema,
          executors: Object.freeze(executors),
        }),
      );
    }

    return Object.freeze(entries);
  }

  /** Revalidates an explicit model choice against the latest snapshot and never substitutes a target. */
  select(request: Pick<ModelSubAgentRequest, 'subAgent' | 'executor'>): SubAgentExecutionTarget {
    const snapshot = this.#requireSnapshot();
    const definition = this.#definitions.getActive(request.subAgent);
    if (definition === undefined) {
      throw runtimeError('DEFINITION_NOT_FOUND', 'The selected subagent definition was not found.');
    }

    const registration = this.#byName.get(request.executor);
    if (registration === undefined) {
      throw runtimeError('EXECUTOR_NOT_FOUND', 'The selected Executor was not found.');
    }

    const availability = snapshot.executors.find(
      (entry) => entry.descriptor.name === registration.descriptor.name,
    )!;
    const eligibility = this.#eligibility(definition, registration, availability);
    switch (eligibility.reason) {
      case 'eligible':
        return Object.freeze({
          definition,
          executor: registration.executor,
          descriptor: registration.descriptor,
          snapshotRevision: snapshot.revision,
        });
      case 'executor-disallowed':
        throw runtimeError('EXECUTOR_DISALLOWED', 'The selected Executor is disallowed.');
      case 'unavailable':
        throw runtimeError('EXECUTOR_UNAVAILABLE', 'The selected Executor is unavailable.');
      case 'unsupported-capability':
      case 'unsupported-definition':
        throw runtimeError(
          'UNSUPPORTED_CAPABILITY',
          'The selected Executor does not support this subagent definition.',
        );
    }
  }

  /** Resolves an exact active or recovery-only definition without changing placement. */
  selectRecovery(
    definitionRef: SubAgentDefinitionRef,
    executorName: string,
  ): SubAgentExecutionTarget {
    const snapshot = this.#requireSnapshot();
    const definition = this.#definitions.getExact(definitionRef);
    if (definition === undefined) {
      throw runtimeError(
        'DEFINITION_NOT_FOUND',
        'The persisted subagent definition version is unavailable for recovery.',
      );
    }
    const registration = this.#byName.get(executorName);
    if (registration === undefined) {
      throw runtimeError('EXECUTOR_NOT_FOUND', 'The persisted Executor was not found.');
    }
    const availability = snapshot.executors.find(
      (entry) => entry.descriptor.name === registration.descriptor.name,
    )!;
    const eligibility = this.#eligibility(definition, registration, availability);
    if (!eligibility.eligible) {
      const code =
        eligibility.reason === 'unavailable'
          ? 'EXECUTOR_UNAVAILABLE'
          : eligibility.reason === 'executor-disallowed'
            ? 'EXECUTOR_DISALLOWED'
            : 'UNSUPPORTED_CAPABILITY';
      throw runtimeError(code, 'The exact persisted recovery target is unavailable.');
    }
    return Object.freeze({
      definition,
      executor: registration.executor,
      descriptor: registration.descriptor,
      snapshotRevision: snapshot.revision,
    });
  }

  #eligibility(
    definition: SubAgentDefinition,
    registration: ExecutorRegistration,
    availability: ExecutorAvailability,
  ): EligibilityResult {
    const allowedNames = definition.executorPolicy?.allowedNames;
    if (allowedNames !== undefined && !allowedNames.includes(registration.descriptor.name)) {
      return { eligible: false, reason: 'executor-disallowed' };
    }

    if (!registration.supportedDefinitionKeys?.has(definitionKey(definition))) {
      return { eligible: false, reason: 'unsupported-definition' };
    }
    if (!availabilitySupportsDefinition(availability, definition)) {
      return { eligible: false, reason: 'unsupported-definition' };
    }
    if (
      !executorSatisfiesCapabilities(registration.descriptor, this.#policy.requiredCapabilities) ||
      !executorSatisfiesCapabilities(
        registration.descriptor,
        definition.executorPolicy?.requiredCapabilities,
      )
    ) {
      return { eligible: false, reason: 'unsupported-capability' };
    }

    if (
      availability.status === 'unavailable' ||
      (availability.status === 'degraded' && this.#policy.allowDegraded === false)
    ) {
      return { eligible: false, reason: 'unavailable' };
    }

    return { eligible: true, reason: 'eligible' };
  }

  async #probeAvailability(): Promise<readonly ExecutorAvailability[]> {
    return Promise.all(
      this.#registrations.map(async ({ executor, descriptor }) => {
        const probe = await executor.getAvailability();
        return validateAndCloneAvailability(probe, descriptor);
      }),
    );
  }

  #requireSnapshot(): ExecutorCatalogSnapshot {
    if (this.#snapshot === undefined) {
      throw new TypeError('Subagent Executor registry must be initialized before catalog access.');
    }
    return this.#snapshot;
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Subagent catalog clock must return a non-negative safe integer.');
    }
    return value;
  }
}

/** Capability ordering is conservative: provider > estimated > none and checkpoint > same_process. */
export function executorSatisfiesCapabilities(
  descriptor: SubAgentExecutorDescriptor,
  requirement: ExecutorCapabilityRequirement | undefined,
): boolean {
  if (requirement === undefined) {
    return true;
  }
  for (const capability of ['spawn', 'cancel', 'events', 'approval'] as const) {
    if (requirement[capability] === true && descriptor.capabilities[capability] !== true) {
      return false;
    }
  }
  if (
    requirement.usage !== undefined &&
    usageRank(descriptor.capabilities.usage) < usageRank(requirement.usage)
  ) {
    return false;
  }
  if (
    requirement.resumeRecovery !== undefined &&
    recoveryRank(descriptor.capabilities.recovery.resume) < recoveryRank(requirement.resumeRecovery)
  ) {
    return false;
  }
  if (
    requirement.externalReconnect === true &&
    descriptor.capabilities.recovery.reconnect !== 'external_binding'
  ) {
    return false;
  }
  return true;
}

function availabilitySupportsDefinition(
  availability: ExecutorAvailability,
  definition: SubAgentDefinitionRef,
): boolean {
  return (
    availability.supportedDefinitions === undefined ||
    availability.supportedDefinitions.some(
      (candidate) => candidate.name === definition.name && candidate.version === definition.version,
    )
  );
}

function validateAndCloneDescriptor(executor: SubAgentExecutor): SubAgentExecutorDescriptor {
  const descriptor = executor.descriptor;
  if (typeof descriptor !== 'object' || descriptor === null) {
    throw new TypeError('Subagent Executor descriptor must be an object.');
  }
  assertIdentity('Executor name', descriptor.name, NAME_PATTERN);
  assertIdentity('Executor adapterStateVersion', descriptor.adapterStateVersion, VERSION_PATTERN);
  assertBoundedText('Executor description', descriptor.description, MAX_DESCRIPTION_BYTES);
  if (!Array.isArray(descriptor.useCases) || descriptor.useCases.length === 0) {
    throw new TypeError('Subagent Executor useCases must contain at least one item.');
  }
  const useCases = descriptor.useCases.map((useCase) => {
    assertBoundedText('Executor use case', useCase, MAX_USE_CASE_BYTES);
    return useCase.trim();
  });
  if (new Set(useCases).size !== useCases.length) {
    throw new TypeError('Subagent Executor useCases must not contain duplicates.');
  }

  const capabilities = descriptor.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null || capabilities.execute !== true) {
    throw new TypeError('Subagent Executor capabilities.execute must be true.');
  }
  for (const capability of ['spawn', 'cancel', 'events', 'approval'] as const) {
    if (typeof capabilities[capability] !== 'boolean') {
      throw new TypeError(`Subagent Executor capabilities.${capability} must be boolean.`);
    }
  }
  if (!['none', 'estimated', 'provider'].includes(capabilities.usage)) {
    throw new TypeError('Subagent Executor capabilities.usage is invalid.');
  }
  if (
    typeof capabilities.recovery !== 'object' ||
    capabilities.recovery === null ||
    !['none', 'same_process', 'checkpoint'].includes(capabilities.recovery.resume) ||
    !['none', 'external_binding'].includes(capabilities.recovery.reconnect)
  ) {
    throw new TypeError('Subagent Executor recovery capabilities are invalid.');
  }
  if (!capabilities.spawn && (capabilities.cancel || capabilities.events)) {
    throw new TypeError('Subagent Executor cancel/events capabilities require spawn support.');
  }
  if (capabilities.approval && capabilities.recovery.resume === 'none') {
    throw new TypeError('Subagent Executor approval capability requires resume recovery.');
  }
  if (!capabilities.spawn && capabilities.recovery.reconnect === 'external_binding') {
    throw new TypeError('Subagent Executor external reconnect capability requires spawn support.');
  }

  if (
    typeof executor.bindingCodec !== 'object' ||
    executor.bindingCodec === null ||
    executor.bindingCodec.adapterStateVersion !== descriptor.adapterStateVersion ||
    typeof executor.bindingCodec.encode !== 'function' ||
    typeof executor.bindingCodec.decode !== 'function'
  ) {
    throw new TypeError('Subagent Executor binding codec must match adapterStateVersion.');
  }

  return Object.freeze({
    name: descriptor.name,
    description: descriptor.description.trim(),
    useCases: Object.freeze(useCases),
    capabilities: Object.freeze({
      execute: true as const,
      spawn: capabilities.spawn,
      cancel: capabilities.cancel,
      events: capabilities.events,
      approval: capabilities.approval,
      usage: capabilities.usage,
      recovery: Object.freeze({ ...capabilities.recovery }),
    }),
    adapterStateVersion: descriptor.adapterStateVersion,
  });
}

function validateAndCloneAvailability(
  probe: ExecutorAvailabilityProbe,
  descriptor: SubAgentExecutorDescriptor,
): ExecutorAvailability {
  if (typeof probe !== 'object' || probe === null) {
    throw new TypeError('Subagent Executor availability must be an object.');
  }
  if (!['available', 'degraded', 'unavailable'].includes(probe.status)) {
    throw new TypeError('Subagent Executor availability status is invalid.');
  }
  if (probe.reasonCode !== undefined) {
    assertIdentity('Executor availability reasonCode', probe.reasonCode, VERSION_PATTERN);
  }

  let supportedDefinitions: readonly SubAgentDefinitionRef[] | undefined;
  if (probe.supportedDefinitions !== undefined) {
    if (!Array.isArray(probe.supportedDefinitions)) {
      throw new TypeError('Executor supportedDefinitions must be an array.');
    }
    const seen = new Set<string>();
    supportedDefinitions = Object.freeze(
      probe.supportedDefinitions
        .map((definition) => {
          assertIdentity('supported definition name', definition.name, NAME_PATTERN);
          assertIdentity('supported definition version', definition.version, VERSION_PATTERN);
          const key = definitionKey(definition);
          if (seen.has(key)) {
            throw new TypeError('Executor supportedDefinitions must not contain duplicates.');
          }
          seen.add(key);
          return Object.freeze({ name: definition.name, version: definition.version });
        })
        .sort(
          (left, right) =>
            compareText(left.name, right.name) || compareText(left.version, right.version),
        ),
    );
  }

  return Object.freeze({
    descriptor,
    status: probe.status,
    ...(probe.reasonCode === undefined ? {} : { reasonCode: probe.reasonCode }),
    ...(supportedDefinitions === undefined ? {} : { supportedDefinitions }),
  });
}

function cloneCatalogPolicy(
  policy: ExecutorCatalogPolicy | undefined,
): Readonly<ExecutorCatalogPolicy> {
  if (policy?.allowDegraded !== undefined && typeof policy.allowDegraded !== 'boolean') {
    throw new TypeError('Subagent catalog allowDegraded must be boolean.');
  }
  validateCapabilityRequirement(policy?.requiredCapabilities);
  return Object.freeze({
    ...(policy?.allowDegraded === undefined ? {} : { allowDegraded: policy.allowDegraded }),
    ...(policy?.requiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: Object.freeze({ ...policy.requiredCapabilities }) }),
  });
}

function validateCapabilityRequirement(
  requirement: ExecutorCapabilityRequirement | undefined,
): void {
  if (requirement === undefined) {
    return;
  }
  for (const key of ['spawn', 'cancel', 'events', 'approval', 'externalReconnect'] as const) {
    if (requirement[key] !== undefined && typeof requirement[key] !== 'boolean') {
      throw new TypeError(`Subagent catalog requiredCapabilities.${key} must be boolean.`);
    }
  }
  if (requirement.usage !== undefined && !['estimated', 'provider'].includes(requirement.usage)) {
    throw new TypeError('Subagent catalog requiredCapabilities.usage is invalid.');
  }
  if (
    requirement.resumeRecovery !== undefined &&
    !['same_process', 'checkpoint'].includes(requirement.resumeRecovery)
  ) {
    throw new TypeError('Subagent catalog requiredCapabilities.resumeRecovery is invalid.');
  }
}

function freezeSnapshot(
  revision: number,
  capturedAt: number,
  executors: readonly ExecutorAvailability[],
): ExecutorCatalogSnapshot {
  return Object.freeze({ revision, capturedAt, executors: Object.freeze([...executors]) });
}

function usageRank(value: 'none' | 'estimated' | 'provider'): number {
  return { none: 0, estimated: 1, provider: 2 }[value];
}

function recoveryRank(value: 'none' | 'same_process' | 'checkpoint'): number {
  return { none: 0, same_process: 1, checkpoint: 2 }[value];
}

function assertIdentity(label: string, value: unknown, pattern: RegExp): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_IDENTITY_LENGTH ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    throw new TypeError(
      `${label} must be a trimmed 1-${MAX_IDENTITY_LENGTH} character identifier.`,
    );
  }
}

function assertBoundedText(
  label: string,
  value: unknown,
  maxBytes: number,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string.`);
  }
  const trimmed = value.trim();
  const size = new TextEncoder().encode(trimmed).byteLength;
  if (size < 1 || size > maxBytes) {
    throw new TypeError(`${label} must be 1-${maxBytes} UTF-8 bytes after trimming.`);
  }
}

function runtimeError(
  code:
    | 'DEFINITION_NOT_FOUND'
    | 'DEFINITION_VERSION_MISMATCH'
    | 'EXECUTOR_NOT_FOUND'
    | 'EXECUTOR_DISALLOWED'
    | 'EXECUTOR_UNAVAILABLE'
    | 'UNSUPPORTED_CAPABILITY',
  message: string,
): SubAgentRuntimeError {
  return new SubAgentRuntimeError({ code, message, retryable: false });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
