import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { JsonObject, ToolParametersSchema } from '../agent/types';

/** 将框架工具 schema 转换为 OpenAI-compatible function tool 参数定义。 */
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
