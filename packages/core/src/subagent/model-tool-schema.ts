import { z } from 'zod';

import type { AgentToolDefinitionInput, JsonObject, ToolParametersSchema } from '../agent/types';
import {
  OPENAI_TOOL_PARAMETERS_JSON_SCHEMA,
  type OpenAIToolParametersJsonSchemaProvider,
} from '../llm/openai-schema';
import type { SubAgentCatalogEntry } from './catalog';
import type { JsonValue } from './json';
import type { ModelSubAgentRequest } from './runtime';

export interface ModelSubAgentToolParametersSchema
  extends ToolParametersSchema, OpenAIToolParametersJsonSchemaProvider {
  readonly routerSchema: z.ZodType<ModelSubAgentRequest>;
  readonly jsonSchema: JsonObject;
}

export interface ModelSubAgentToolDefinition extends AgentToolDefinitionInput {
  readonly name: 'agent';
  readonly parameters: ModelSubAgentToolParametersSchema;
  readonly strict: true;
}

/** Creates the Router's exact Zod discriminated union without touching an Executor or the network. */
export function createModelSubAgentRouterSchema(
  entries: readonly SubAgentCatalogEntry[],
): z.ZodType<ModelSubAgentRequest> | null {
  const normalized = normalizeCatalogEntries(entries);
  if (normalized.length === 0) {
    return null;
  }

  const branches = normalized.map((entry) =>
    z
      .object({
        subAgent: z.literal(entry.definition.name),
        executor: z.enum(entry.executors.map((executor) => executor.name) as [string, ...string[]]),
        input: entry.inputSchema,
      })
      .strict(),
  );

  return z.discriminatedUnion('subAgent', branches as never) as z.ZodType<ModelSubAgentRequest>;
}

/** Returns null for an empty filtered catalog so the Agent can remove the built-in Tool entirely. */
export function createModelSubAgentToolDefinition(
  entries: readonly SubAgentCatalogEntry[],
): ModelSubAgentToolDefinition | null {
  const normalized = normalizeCatalogEntries(entries);
  const routerSchema = createModelSubAgentRouterSchema(normalized);
  if (routerSchema === null) {
    return null;
  }

  const jsonSchema = buildModelSubAgentJsonSchema(normalized);
  const parameters: ModelSubAgentToolParametersSchema = Object.freeze({
    routerSchema,
    jsonSchema,
    safeParse: (value: unknown) => routerSchema.safeParse(value),
    [OPENAI_TOOL_PARAMETERS_JSON_SCHEMA]: () => jsonSchema,
  });

  return Object.freeze({
    name: 'agent' as const,
    description: buildToolDescription(normalized),
    parameters,
    strict: true as const,
  });
}

function buildModelSubAgentJsonSchema(entries: readonly SubAgentCatalogEntry[]): JsonObject {
  const definitions: JsonObject = {};
  const branches = entries.map((entry, index) => {
    const inputSchema = convertInputSchema(entry.inputSchema, `subagent_${index}_`, definitions);
    return {
      type: 'object',
      properties: {
        subAgent: { type: 'string', enum: [entry.definition.name] },
        executor: {
          type: 'string',
          enum: entry.executors.map((executor) => executor.name),
        },
        input: inputSchema,
      },
      required: ['subAgent', 'executor', 'input'],
      additionalProperties: false,
    };
  });

  return deepFreezeJsonObject({
    type: 'object',
    properties: {
      subAgent: { type: 'string', enum: entries.map((entry) => entry.definition.name) },
      executor: {
        type: 'string',
        enum: [...new Set(entries.flatMap((entry) => entry.executors.map(({ name }) => name)))],
      },
      input: {},
    },
    required: ['subAgent', 'executor', 'input'],
    additionalProperties: false,
    oneOf: branches,
    ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
  });
}

function convertInputSchema(
  schema: z.ZodType<JsonValue>,
  prefix: string,
  sharedDefinitions: JsonObject,
): JsonObject {
  let converted: unknown;
  try {
    converted = z.toJSONSchema(schema, { reused: 'ref', cycles: 'ref' });
  } catch (cause) {
    throw new TypeError('Subagent input schema could not be converted to JSON Schema.', { cause });
  }
  if (!isJsonObject(converted)) {
    throw new TypeError('Subagent input schema must convert to a JSON Schema object.');
  }

  const root = cloneJsonObject(converted);
  delete root.$schema;
  const refMappings = new Map<string, string>();
  const extractedDefinitionKeys: string[] = [];
  const hasDocumentRootReference = containsRef(root, '#');

  for (const containerName of ['$defs', 'definitions'] as const) {
    const container = root[containerName];
    if (!isJsonObject(container)) {
      continue;
    }
    let sequence = 0;
    for (const [key, definition] of Object.entries(container)) {
      const newKey = `${prefix}${sequence}`;
      sequence += 1;
      refMappings.set(`#/${containerName}/${escapeJsonPointer(key)}`, `#/$defs/${newKey}`);
      sharedDefinitions[newKey] = definition;
      extractedDefinitionKeys.push(newKey);
    }
    delete root[containerName];
  }

  const rootKey = `${prefix}root`;
  if (hasDocumentRootReference) {
    refMappings.set('#', `#/$defs/${rootKey}`);
  }
  rewriteRefs(root, refMappings);
  for (const key of extractedDefinitionKeys) {
    rewriteRefs(sharedDefinitions[key], refMappings);
  }
  if (hasDocumentRootReference) {
    sharedDefinitions[rootKey] = root;
    return { $ref: `#/$defs/${rootKey}` };
  }
  return root;
}

function containsRef(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsRef(item, expected));
  }
  if (!isJsonObject(value)) {
    return false;
  }
  if (value.$ref === expected) {
    return true;
  }
  return Object.values(value).some((child) => containsRef(child, expected));
}

function rewriteRefs(value: unknown, mappings: ReadonlyMap<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      rewriteRefs(item, mappings);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }
  if (typeof value.$ref === 'string') {
    const replacement = mappings.get(value.$ref);
    if (replacement !== undefined) {
      value.$ref = replacement;
    }
  }
  for (const child of Object.values(value)) {
    rewriteRefs(child, mappings);
  }
}

function normalizeCatalogEntries(
  entries: readonly SubAgentCatalogEntry[],
): readonly SubAgentCatalogEntry[] {
  const seen = new Set<string>();
  const normalized = entries
    .filter((entry) => entry.executors.length > 0)
    .map((entry) => {
      if (seen.has(entry.definition.name)) {
        throw new TypeError(
          `Model subagent catalog contains duplicate active name "${entry.definition.name}".`,
        );
      }
      seen.add(entry.definition.name);
      const executorNames = entry.executors.map((executor) => executor.name);
      if (new Set(executorNames).size !== executorNames.length) {
        throw new TypeError(
          `Model subagent catalog contains duplicate Executor for "${entry.definition.name}".`,
        );
      }
      return entry;
    })
    .sort(
      (left, right) =>
        compareText(left.definition.name, right.definition.name) ||
        compareText(left.definition.version, right.definition.version),
    );
  return Object.freeze(normalized);
}

function buildToolDescription(entries: readonly SubAgentCatalogEntry[]): string {
  const lines = entries.map((entry) => {
    const executors = entry.executors
      .map((executor) => {
        const status = executor.status === 'degraded' ? 'degraded' : 'available';
        return `${executor.name} (${status}): ${executor.description}; use cases: ${executor.useCases.join(', ')}`;
      })
      .join(' | ');
    return `- ${entry.definition.name}@${entry.definition.version}: ${entry.description} Executors: ${executors}`;
  });
  return [
    'Delegate one typed task to exactly one listed subagent and Executor.',
    'Use only the three declared fields; the runtime will revalidate the selected target without fallback.',
    ...lines,
  ].join('\n');
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return cloneJsonValue(value) as JsonObject;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]),
    );
  }
  return value;
}

function deepFreezeJsonObject(value: JsonObject): JsonObject {
  for (const child of Object.values(value)) {
    deepFreezeJsonValue(child);
  }
  return Object.freeze(value);
}

function deepFreezeJsonValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      deepFreezeJsonValue(child);
    }
    Object.freeze(value);
  } else if (isJsonObject(value)) {
    deepFreezeJsonObject(value);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
