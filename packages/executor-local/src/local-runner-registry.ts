import type {
  SubAgentChildRunRequest,
  SubAgentChildRunner,
  SubAgentDefinitionRef,
} from '@ruixutong.manee/maneeagent-framework';

export interface LocalSubAgentRunnerFactoryContext {
  readonly request: SubAgentChildRunRequest;
  readonly executorName: string;
}

export interface LocalSubAgentRunnerRegistration {
  readonly definition: SubAgentDefinitionRef;
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly childCheckpointVersions: readonly string[];
  create(
    context: LocalSubAgentRunnerFactoryContext,
  ): SubAgentChildRunner | Promise<SubAgentChildRunner>;
}

/** Exact definition-version registry. A factory creates one isolated runner for each child task. */
export class LocalSubAgentRunnerRegistry {
  readonly #registrations = new Map<string, LocalSubAgentRunnerRegistration>();
  readonly #runners = new Map<
    string,
    Readonly<{
      runnerId: string;
      runnerVersion: string;
      childCheckpointVersions: readonly string[];
    }>
  >();
  #sealed = false;

  constructor(registrations: readonly LocalSubAgentRunnerRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: LocalSubAgentRunnerRegistration): this {
    if (this.#sealed) throw new Error('The Local Subagent runner registry is sealed.');
    assertDefinition(registration.definition);
    assertIdentifier('runnerId', registration.runnerId);
    assertVersion('runnerVersion', registration.runnerVersion);
    const childCheckpointVersions = validateVersions(registration.childCheckpointVersions);
    if (typeof registration.create !== 'function') {
      throw new TypeError('A Local Subagent registration requires a create() factory.');
    }
    const key = definitionKey(registration.definition);
    if (this.#registrations.has(key)) {
      throw new TypeError(
        `A Local Subagent runner is already registered for ${registration.definition.name}@${registration.definition.version}.`,
      );
    }
    const runnerKey = definitionKey({
      name: registration.runnerId,
      version: registration.runnerVersion,
    });
    const existingRunner = this.#runners.get(runnerKey);
    if (
      existingRunner !== undefined &&
      existingRunner.childCheckpointVersions.join('\0') !== childCheckpointVersions.join('\0')
    ) {
      throw new TypeError('A Local runner identity must declare one checkpoint-version set.');
    }
    const runner =
      existingRunner ??
      Object.freeze({
        runnerId: registration.runnerId,
        runnerVersion: registration.runnerVersion,
        childCheckpointVersions,
      });
    this.#runners.set(runnerKey, runner);
    this.#registrations.set(
      key,
      Object.freeze({
        definition: Object.freeze({
          name: registration.definition.name,
          version: registration.definition.version,
        }),
        runnerId: registration.runnerId,
        runnerVersion: registration.runnerVersion,
        childCheckpointVersions,
        create: registration.create,
      }),
    );
    return this;
  }

  seal(): this {
    this.#sealed = true;
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
        .sort((left, right) => definitionKey(left).localeCompare(definitionKey(right))),
    );
  }

  runnerFor(definition: SubAgentDefinitionRef): Readonly<{
    runnerId: string;
    runnerVersion: string;
    childCheckpointVersions: readonly string[];
  }> {
    const registration = this.#registrations.get(definitionKey(definition));
    if (registration === undefined) {
      throw new Error('No Local Subagent runner is registered for the exact definition version.');
    }
    return Object.freeze({
      runnerId: registration.runnerId,
      runnerVersion: registration.runnerVersion,
      childCheckpointVersions: Object.freeze([...registration.childCheckpointVersions]),
    });
  }

  listRunnerCompatibility(): readonly Readonly<{
    runnerId: string;
    runnerVersion: string;
    childCheckpointVersions: readonly string[];
  }>[] {
    return Object.freeze(
      [...this.#runners.values()].sort((left, right) =>
        definitionKey({ name: left.runnerId, version: left.runnerVersion }).localeCompare(
          definitionKey({ name: right.runnerId, version: right.runnerVersion }),
        ),
      ),
    );
  }

  async create(
    request: SubAgentChildRunRequest,
    executorName: string,
  ): Promise<SubAgentChildRunner> {
    assertIdentifier('executorName', executorName);
    const registration = this.#registrations.get(definitionKey(request.definition));
    if (registration === undefined) {
      throw new Error('No Local Subagent runner is registered for the exact definition version.');
    }
    const runner = await registration.create({ request, executorName });
    if (typeof runner !== 'object' || runner === null || typeof runner.run !== 'function') {
      throw new TypeError('A Local Subagent factory must return a SubAgentChildRunner.');
    }
    return runner;
  }
}

function definitionKey(definition: SubAgentDefinitionRef): string {
  return `${definition.name}\0${definition.version}`;
}

function assertDefinition(definition: SubAgentDefinitionRef): void {
  if (
    typeof definition !== 'object' ||
    definition === null ||
    typeof definition.name !== 'string' ||
    definition.name.length === 0 ||
    typeof definition.version !== 'string' ||
    definition.version.length === 0
  ) {
    throw new TypeError('A Local Subagent registration requires an exact definition reference.');
  }
}

function assertIdentifier(label: 'runnerId' | 'executorName', value: string): void {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new TypeError(`A Local Subagent registration requires a valid ${label}.`);
  }
}

function assertVersion(label: string, value: string): void {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value)
  ) {
    throw new TypeError(`A Local Subagent registration requires a valid ${label}.`);
  }
}

function validateVersions(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (version) =>
        typeof version !== 'string' ||
        version.length > 128 ||
        version !== version.trim() ||
        !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(version),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError('Local runner childCheckpointVersions must be unique valid versions.');
  }
  return Object.freeze([...value].sort());
}
