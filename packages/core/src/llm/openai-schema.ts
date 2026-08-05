import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { JsonObject, ToolParametersSchema } from '../agent/types';

/** Internal extension point for schemas whose exact JSON Schema cannot be reconstructed from safeParse(). */
export const OPENAI_TOOL_PARAMETERS_JSON_SCHEMA = Symbol.for(
  '@ruixutong.manee/maneeagent-framework/openai-tool-parameters-json-schema',
);

export interface OpenAIToolParametersJsonSchemaProvider {
  [OPENAI_TOOL_PARAMETERS_JSON_SCHEMA](): JsonObject;
}

/** 将框架工具 schema 转换为 OpenAI-compatible function tool 参数定义。 */
export function toOpenAIToolParameters(schema: ToolParametersSchema): JsonObject {
  const custom = readCustomJsonSchema(schema);
  if (custom !== null) {
    return custom;
  }

  const converted = normalizeRootSchema(convertWithZodToJsonSchema(schema));

  if (converted) {
    return converted;
  }

  const native = normalizeRootSchema(convertWithNativeZod(schema));

  if (native) {
    return native;
  }

  throw new Error('Tool parameters must resolve to a JSON object schema.');
}

function readCustomJsonSchema(schema: ToolParametersSchema): JsonObject | null {
  const provider = schema as ToolParametersSchema & Partial<OpenAIToolParametersJsonSchemaProvider>;
  const build = provider[OPENAI_TOOL_PARAMETERS_JSON_SCHEMA];
  if (build === undefined) {
    return null;
  }
  if (typeof build !== 'function') {
    throw new TypeError('Custom OpenAI Tool JSON Schema provider must be a function.');
  }

  const cloned = cloneJsonSchema(build.call(provider));
  const normalized = normalizeRootSchema(cloned);
  if (normalized === null) {
    throw new TypeError('Custom OpenAI Tool JSON Schema must have an object root.');
  }
  return normalized;
}

function convertWithZodToJsonSchema(schema: ToolParametersSchema): unknown {
  // zod-to-json-schema 对 Zod v3/v4 兼容路径更成熟，优先尝试 OpenAI target。
  try {
    return zodToJsonSchema(schema as never, {
      target: 'openAi',
    });
  } catch {
    return null;
  }
}

function convertWithNativeZod(schema: ToolParametersSchema): unknown {
  // 若 zod-to-json-schema 无法处理当前 schema，再回退到 Zod 自带 JSON Schema 输出。
  try {
    return z.toJSONSchema(schema as never);
  } catch {
    return null;
  }
}

function normalizeRootSchema(schema: unknown): JsonObject | null {
  // OpenAI tool parameters 必须是 object；所有 ref/$schema 清理都限制在 wire 层。
  if (!isJsonObject(schema)) {
    return null;
  }

  const root = stripSchemaKeyword(schema);
  const resolved = resolveLocalRootRef(root);
  const normalized = stripSchemaKeyword(resolved);

  // OpenAI function tool 的参数必须以 object 为根；此处隔离 wire 层限制。
  if (normalized.type !== 'object') {
    return null;
  }

  return normalized;
}

function resolveLocalRootRef(schema: JsonObject): JsonObject {
  // zod-to-json-schema 可能把根对象写成本地 $ref，这里只解析根级本地引用。
  const ref = schema.$ref;

  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    return schema;
  }

  const resolved = findLocalRef(schema, ref);

  if (!resolved) {
    return schema;
  }

  const next: JsonObject = {
    ...resolved,
  };

  if (isJsonObject(schema.definitions) && !('definitions' in next)) {
    next.definitions = schema.definitions;
  }

  if (isJsonObject(schema.$defs) && !('$defs' in next)) {
    next.$defs = schema.$defs;
  }

  return next;
}

function findLocalRef(schema: JsonObject, ref: string): JsonObject | null {
  // JSON Pointer 中的 ~1 和 ~0 需要按规范反转义。
  const path = ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current: unknown = schema;

  for (const part of path) {
    if (!isJsonObject(current)) {
      return null;
    }

    current = current[part];
  }

  return isJsonObject(current) ? current : null;
}

function stripSchemaKeyword(schema: JsonObject): JsonObject {
  // OpenAI tool schema 不需要顶层 $schema，保留会增加 provider 兼容风险。
  const next: JsonObject = {
    ...schema,
  };

  delete next.$schema;

  return next;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJsonSchema(value: unknown): JsonObject {
  const cloned = cloneJsonValue(value, new Set<object>());
  if (!isJsonObject(cloned)) {
    throw new TypeError('Custom OpenAI Tool JSON Schema must be a JSON object.');
  }
  return cloned;
}

function cloneJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Custom OpenAI Tool JSON Schema contains a non-finite number.');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Custom OpenAI Tool JSON Schema must be JSON-safe.');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Custom OpenAI Tool JSON Schema must not contain cycles.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => cloneJsonValue(item, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Custom OpenAI Tool JSON Schema must contain only plain objects.');
    }
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = cloneJsonValue(item, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
