import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { JsonObject, ToolParametersSchema } from './types';

const emptyParametersSchema = z.object({});

/** 为没有声明参数的工具提供默认空对象 schema。 */
export function getDefaultToolParametersSchema(): ToolParametersSchema {
  return emptyParametersSchema;
}

/** 将兼容 Zod 的工具 schema 转换为 Responses 函数工具参数 JSON Schema。 */
export function toOpenAIToolParameters(schema: ToolParametersSchema): JsonObject {
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

function convertWithZodToJsonSchema(schema: ToolParametersSchema): unknown {
  try {
    return zodToJsonSchema(schema as never, {
      target: 'openAi',
    });
  } catch {
    return null;
  }
}

function convertWithNativeZod(schema: ToolParametersSchema): unknown {
  try {
    return z.toJSONSchema(schema as never);
  } catch {
    return null;
  }
}

function normalizeRootSchema(schema: unknown): JsonObject | null {
  if (!isJsonObject(schema)) {
    return null;
  }

  const root = stripSchemaKeyword(schema);
  const resolved = resolveLocalRootRef(root);
  const normalized = stripSchemaKeyword(resolved);

  // 函数工具的参数必须以对象为根；在发送请求前拦截原始值或数组 schema。
  if (normalized.type !== 'object') {
    return null;
  }

  return normalized;
}

function resolveLocalRootRef(schema: JsonObject): JsonObject {
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
  const next: JsonObject = {
    ...schema,
  };

  delete next.$schema;

  return next;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
