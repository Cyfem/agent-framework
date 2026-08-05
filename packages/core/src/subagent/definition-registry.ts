import { defineSubAgent, type SubAgentDefinition } from './definition';
import type { SubAgentDefinitionRef } from './identity';

/** Exact immutable split between definitions available to create and definitions kept for recovery. */
export class SubAgentDefinitionRegistry {
  readonly #activeByName = new Map<string, SubAgentDefinition>();
  readonly #exactByKey = new Map<string, SubAgentDefinition>();
  readonly #recoveryByKey = new Map<string, SubAgentDefinition>();
  readonly #active: readonly SubAgentDefinition[];
  readonly #recovery: readonly SubAgentDefinition[];

  constructor(options: {
    readonly activeDefinitions: readonly SubAgentDefinition[];
    readonly recoveryDefinitions?: readonly SubAgentDefinition[];
  }) {
    for (const candidate of options.activeDefinitions) {
      const definition = normalizeDefinition(candidate);
      if (definition.executorPolicy?.allowedNames?.length === 0) {
        throw new TypeError(
          `Active subagent definition "${definition.name}" has an empty Executor allowlist.`,
        );
      }
      const previous = this.#activeByName.get(definition.name);
      if (previous !== undefined) {
        throw new TypeError(
          `Active subagent definition "${definition.name}" is registered more than once (${previous.version}, ${definition.version}).`,
        );
      }

      const key = definitionKey(definition);
      this.#activeByName.set(definition.name, definition);
      this.#exactByKey.set(key, definition);
    }

    for (const candidate of options.recoveryDefinitions ?? []) {
      const definition = normalizeDefinition(candidate);
      const key = definitionKey(definition);
      if (this.#exactByKey.has(key)) {
        throw new TypeError(
          `Subagent definition "${definition.name}@${definition.version}" is registered as both active and recovery-only.`,
        );
      }
      if (this.#recoveryByKey.has(key)) {
        throw new TypeError(
          `Recovery-only subagent definition "${definition.name}@${definition.version}" is registered more than once.`,
        );
      }
      this.#recoveryByKey.set(key, definition);
      this.#exactByKey.set(key, definition);
    }

    this.#active = freezeSortedDefinitions(this.#activeByName.values());
    this.#recovery = freezeSortedDefinitions(this.#recoveryByKey.values());
  }

  getActive(name: string): SubAgentDefinition | undefined {
    return this.#activeByName.get(name);
  }

  /** Resolves either the active version or an explicitly retained recovery-only version. */
  getExact(reference: SubAgentDefinitionRef): SubAgentDefinition | undefined {
    return this.#exactByKey.get(definitionKey(reference));
  }

  getRecovery(reference: SubAgentDefinitionRef): SubAgentDefinition | undefined {
    return this.#recoveryByKey.get(definitionKey(reference));
  }

  listActive(): readonly SubAgentDefinition[] {
    return this.#active;
  }

  listRecovery(): readonly SubAgentDefinition[] {
    return this.#recovery;
  }

  listExact(): readonly SubAgentDefinition[] {
    return Object.freeze([...this.#active, ...this.#recovery]);
  }
}

export function definitionKey(reference: SubAgentDefinitionRef): string {
  return `${reference.name}\u0000${reference.version}`;
}

function freezeSortedDefinitions(
  definitions: Iterable<SubAgentDefinition>,
): readonly SubAgentDefinition[] {
  return Object.freeze(
    [...definitions].sort(
      (left, right) =>
        compareText(left.name, right.name) || compareText(left.version, right.version),
    ),
  );
}

function normalizeDefinition(definition: SubAgentDefinition): SubAgentDefinition {
  const validated = defineSubAgent(definition);
  return Object.isFrozen(definition) ? definition : validated;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
