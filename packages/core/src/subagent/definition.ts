import type { z } from 'zod';

import type { ArtifactReference } from './artifact';
import type { SubAgentDefinitionRef } from './identity';
import type { JsonValue } from './json';

export type { SubAgentDefinitionRef } from './identity';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const MAX_IDENTITY_LENGTH = 64;
const MAX_DESCRIPTION_BYTES = 4_096;

export interface ExecutorCapabilityRequirement {
  readonly spawn?: boolean;
  readonly cancel?: boolean;
  readonly events?: boolean;
  readonly approval?: boolean;
  readonly usage?: 'estimated' | 'provider';
  readonly resumeRecovery?: 'same_process' | 'checkpoint';
  readonly externalReconnect?: boolean;
}

export interface SubAgentExecutorPolicy {
  /** Omitted means unrestricted; an empty array intentionally makes the definition unavailable. */
  readonly allowedNames?: readonly string[];
  readonly requiredCapabilities?: ExecutorCapabilityRequirement;
}

export interface SubAgentContextProjectionInput<I extends JsonValue = JsonValue> {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly parentTaskId?: string;
  readonly definition: SubAgentDefinition<I, JsonValue>;
  readonly input: I;
  readonly parentContext: readonly unknown[];
  readonly parentRawHistory: readonly unknown[];
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

export type SubAgentContextItem =
  | { readonly kind: 'text'; readonly name: string; readonly text: string }
  | { readonly kind: 'data'; readonly name: string; readonly value: JsonValue }
  | { readonly kind: 'artifact'; readonly artifact: ArtifactReference };

export type SubAgentContextProjector<I extends JsonValue = JsonValue> = (
  input: SubAgentContextProjectionInput<I>,
) => readonly SubAgentContextItem[] | Promise<readonly SubAgentContextItem[]>;

type RegisteredContextProjector = {
  bivarianceHack(
    input: SubAgentContextProjectionInput<JsonValue>,
  ): readonly SubAgentContextItem[] | Promise<readonly SubAgentContextItem[]>;
}['bivarianceHack'];

export interface SubAgentDefinition<
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> extends SubAgentDefinitionRef {
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly executorPolicy?: SubAgentExecutorPolicy;
  readonly contextProjector?: SubAgentContextProjector<I>;
  readonly delegation?:
    | { readonly mode: 'none' }
    | {
        readonly mode: 'allowlist';
        readonly definitions: readonly string[];
        readonly allowSelf?: boolean;
      };
}

/**
 * Existential registration shape accepted by a Runtime. It preserves typed definitions at their
 * declaration site while intentionally erasing schema parameters inside the heterogeneous catalog.
 */
export interface SubAgentDefinitionRegistration extends SubAgentDefinitionRef {
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly outputSchema: z.ZodTypeAny;
  readonly executorPolicy?: SubAgentExecutorPolicy;
  readonly contextProjector?: RegisteredContextProjector;
  readonly delegation?: SubAgentDefinition['delegation'];
}

/** Validates and snapshots host-owned definition policy without mutating or freezing Zod schemas. */
export function defineSubAgent<I extends JsonValue, O extends JsonValue>(
  definition: SubAgentDefinition<I, O>,
): SubAgentDefinition<I, O> {
  assertIdentity('name', definition.name, NAME_PATTERN);
  assertIdentity('version', definition.version, VERSION_PATTERN);

  const description = definition.description.trim();
  const descriptionBytes = new TextEncoder().encode(description).byteLength;
  if (descriptionBytes < 1 || descriptionBytes > MAX_DESCRIPTION_BYTES) {
    throw new RangeError(
      `Subagent description must be 1-${MAX_DESCRIPTION_BYTES} UTF-8 bytes after trimming.`,
    );
  }
  assertSchema('inputSchema', definition.inputSchema);
  assertSchema('outputSchema', definition.outputSchema);

  const executorPolicy = cloneExecutorPolicy(definition.executorPolicy);
  const delegation = cloneDelegation(definition.name, definition.delegation);

  return Object.freeze({
    name: definition.name,
    version: definition.version,
    description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    ...(executorPolicy === undefined ? {} : { executorPolicy }),
    ...(definition.contextProjector === undefined
      ? {}
      : { contextProjector: definition.contextProjector }),
    ...(delegation === undefined ? {} : { delegation }),
  });
}

function assertIdentity(label: string, value: string, pattern: RegExp): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_IDENTITY_LENGTH ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    throw new TypeError(
      `Subagent ${label} must be a trimmed 1-${MAX_IDENTITY_LENGTH} character identifier.`,
    );
  }
}

function assertSchema(label: string, value: unknown): void {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    typeof (value as { safeParse?: unknown }).safeParse !== 'function'
  ) {
    throw new TypeError(`Subagent ${label} must be a Zod schema.`);
  }
}

function cloneExecutorPolicy(
  policy: SubAgentExecutorPolicy | undefined,
): SubAgentExecutorPolicy | undefined {
  if (policy === undefined) {
    return undefined;
  }

  let allowedNames: readonly string[] | undefined;
  if (policy.allowedNames !== undefined) {
    const names = [...policy.allowedNames];
    for (const name of names) {
      assertIdentity('executor name', name, NAME_PATTERN);
    }
    assertUnique('executorPolicy.allowedNames', names);
    allowedNames = Object.freeze(names);
  }

  let requiredCapabilities: ExecutorCapabilityRequirement | undefined;
  if (policy.requiredCapabilities !== undefined) {
    validateCapabilityRequirement(policy.requiredCapabilities);
    requiredCapabilities = Object.freeze({ ...policy.requiredCapabilities });
  }

  return Object.freeze({
    ...(allowedNames === undefined ? {} : { allowedNames }),
    ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
  });
}

function cloneDelegation(
  selfName: string,
  delegation: SubAgentDefinition['delegation'],
): SubAgentDefinition['delegation'] {
  if (delegation === undefined) {
    return undefined;
  }
  if (delegation.mode === 'none') {
    return Object.freeze({ mode: 'none' as const });
  }
  if (delegation.mode !== 'allowlist' || !Array.isArray(delegation.definitions)) {
    throw new TypeError('Subagent delegation must use mode "none" or "allowlist".');
  }

  const definitions = [...delegation.definitions];
  for (const definitionName of definitions) {
    assertIdentity('delegation definition', definitionName, NAME_PATTERN);
  }
  assertUnique('delegation.definitions', definitions);
  if (delegation.allowSelf === true && !definitions.includes(selfName)) {
    throw new TypeError('Subagent delegation with allowSelf=true must include its own name.');
  }

  return Object.freeze({
    mode: 'allowlist' as const,
    definitions: Object.freeze(definitions),
    ...(delegation.allowSelf === undefined ? {} : { allowSelf: delegation.allowSelf }),
  });
}

function assertUnique(label: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`Subagent ${label} must not contain duplicate values.`);
  }
}

function validateCapabilityRequirement(requirement: ExecutorCapabilityRequirement): void {
  for (const key of ['spawn', 'cancel', 'events', 'approval', 'externalReconnect'] as const) {
    const value = requirement[key];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new TypeError(`Subagent requiredCapabilities.${key} must be boolean.`);
    }
  }
  if (
    requirement.usage !== undefined &&
    requirement.usage !== 'estimated' &&
    requirement.usage !== 'provider'
  ) {
    throw new TypeError('Subagent requiredCapabilities.usage is invalid.');
  }
  if (
    requirement.resumeRecovery !== undefined &&
    requirement.resumeRecovery !== 'same_process' &&
    requirement.resumeRecovery !== 'checkpoint'
  ) {
    throw new TypeError('Subagent requiredCapabilities.resumeRecovery is invalid.');
  }
}
