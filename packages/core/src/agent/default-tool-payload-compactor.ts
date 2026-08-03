import type {
  DefaultToolPayloadCompactOptions,
  ToolPayloadCompactor,
  ToolPayloadKind,
} from './types';

/** 已解析、可直接执行的缺省工具 payload 字符限制。 */
export interface DefaultToolPayloadCompactLimits {
  readonly thresholdChars: number;
  readonly targetChars: number;
}

/** 为避免对超大字符串执行结构化转换，JSON 探测使用固定字符上限。 */
export const DEFAULT_TOOL_PAYLOAD_JSON_INSPECTION_LIMIT = 1_048_576;

/** 框架内置的 input/result 字符阈值；常量及其成员均不可变。 */
export const DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS = Object.freeze({
  toolInput: Object.freeze({ thresholdChars: 8_192, targetChars: 4_096 }),
  toolResult: Object.freeze({ thresholdChars: 16_384, targetChars: 8_192 }),
});

const MIN_TARGET_CHARS = 512;
const MAX_CONTAINER_DEPTH = 8;
const INPUT_STRING_RETAINED_CHARS = 1_024;
const RESULT_STRING_RETAINED_CHARS = 2_048;
const ARRAY_HEAD_ITEMS = 24;
const ARRAY_TAIL_ITEMS = 8;
const ARRAY_RETAINED_ITEMS = ARRAY_HEAD_ITEMS + ARRAY_TAIL_ITEMS;
const OBJECT_HEAD_PROPERTIES = 48;
const OBJECT_TAIL_PROPERTIES = 16;
const OBJECT_RETAINED_PROPERTIES = OBJECT_HEAD_PROPERTIES + OBJECT_TAIL_PROPERTIES;
const COMPACT_MARKER_KEY = '__context_compact__';

type JsonFormat = 'json' | 'invalid-json' | 'not-inspected';
type JsonRecord = Record<string, unknown>;

interface Preview {
  head: string;
  tail: string;
  omittedChars: number;
}

function isToolPayloadKind(value: unknown): value is ToolPayloadKind {
  return value === 'tool_input' || value === 'tool_result';
}

function assertToolPayloadKind(kind: unknown): asserts kind is ToolPayloadKind {
  if (!isToolPayloadKind(kind)) {
    throw new TypeError(`Unknown tool payload kind: ${String(kind)}`);
  }
}

function defaultLimitsFor(kind: ToolPayloadKind): DefaultToolPayloadCompactLimits {
  const defaults =
    kind === 'tool_input'
      ? DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolInput
      : DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolResult;

  // Copy values rather than retaining an externally visible object reference.
  return {
    thresholdChars: defaults.thresholdChars,
    targetChars: defaults.targetChars,
  };
}

function assertSafeInteger(name: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
}

function validateLimits(limits: DefaultToolPayloadCompactLimits): DefaultToolPayloadCompactLimits {
  assertSafeInteger('thresholdChars', limits.thresholdChars);
  assertSafeInteger('targetChars', limits.targetChars);

  if (limits.targetChars < MIN_TARGET_CHARS) {
    throw new RangeError(`targetChars must be at least ${MIN_TARGET_CHARS}`);
  }
  if (limits.thresholdChars <= limits.targetChars) {
    throw new RangeError('thresholdChars must be greater than targetChars');
  }

  return Object.freeze({
    thresholdChars: limits.thresholdChars,
    targetChars: limits.targetChars,
  });
}

function isResolvedLimits(value: unknown): value is DefaultToolPayloadCompactLimits {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !('strategy' in value)
  );
}

/**
 * 把缺省策略配置合并为实例私有的、已校验字符限制。
 *
 * 额外字段会被忽略；非法 discriminant 或长度在初始化阶段直接失败。
 */
export function resolveDefaultToolPayloadCompactLimits(
  kind: ToolPayloadKind,
  options?: DefaultToolPayloadCompactOptions,
): DefaultToolPayloadCompactLimits {
  assertToolPayloadKind(kind);
  const defaults = defaultLimitsFor(kind);

  if (options === undefined) {
    return validateLimits(defaults);
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('Default tool payload compact options must be a non-null object');
  }
  if (options.strategy !== 'default') {
    throw new TypeError('Default tool payload compact strategy must be "default"');
  }

  return validateLimits({
    thresholdChars:
      options.thresholdChars === undefined ? defaults.thresholdChars : options.thresholdChars,
    targetChars: options.targetChars === undefined ? defaults.targetChars : options.targetChars,
  });
}

/** 创建一个捕获已校验长度快照的同步缺省压缩器。 */
export function createDefaultToolPayloadCompactor(
  kind: ToolPayloadKind,
  options?: DefaultToolPayloadCompactOptions | DefaultToolPayloadCompactLimits,
): ToolPayloadCompactor {
  assertToolPayloadKind(kind);
  const limits = isResolvedLimits(options)
    ? validateLimits(options)
    : resolveDefaultToolPayloadCompactLimits(kind, options);

  return (original) => compactDefaultToolPayload(original, kind, limits);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * 以确定的 3:1 比例保留源字符串头尾，并避免在边界切开有效 surrogate pair。
 */
function createPreview(source: string, retainedBudget: number): Preview {
  const boundedBudget = Math.max(0, Math.min(source.length, Math.floor(retainedBudget)));
  const desiredHeadChars = Math.floor((3 * boundedBudget) / 4);
  const desiredTailChars = boundedBudget - desiredHeadChars;
  let headEnd = desiredHeadChars;
  let tailStart = source.length - desiredTailChars;

  if (
    headEnd > 0 &&
    headEnd < source.length &&
    isHighSurrogate(source.charCodeAt(headEnd - 1)) &&
    isLowSurrogate(source.charCodeAt(headEnd))
  ) {
    headEnd -= 1;
  }

  if (
    tailStart > 0 &&
    tailStart < source.length &&
    isHighSurrogate(source.charCodeAt(tailStart - 1)) &&
    isLowSurrogate(source.charCodeAt(tailStart))
  ) {
    tailStart += 1;
  }

  const head = source.slice(0, headEnd);
  const tail = source.slice(tailStart);
  return {
    head,
    tail,
    omittedChars: source.length - head.length - tail.length,
  };
}

function createRecord(): JsonRecord {
  return Object.create(null) as JsonRecord;
}

function createMarkerRecord(details: JsonRecord): JsonRecord {
  const marker = createRecord();
  marker[COMPACT_MARKER_KEY] = details;
  return marker;
}

function createDetails(entries: ReadonlyArray<readonly [string, unknown]>): JsonRecord {
  const details = createRecord();
  for (const [key, value] of entries) {
    details[key] = value;
  }
  return details;
}

function createMaxDepthMarker(originalType: 'array' | 'object'): JsonRecord {
  return createMarkerRecord(
    createDetails([
      ['kind', 'max-depth'],
      ['originalType', originalType],
    ]),
  );
}

function compactStringLeaf(value: string, retainedChars: number): string {
  if (value.length <= retainedChars) {
    return value;
  }

  const preview = createPreview(value, retainedChars);
  return `${preview.head}...[context compacted: omittedChars=${preview.omittedChars}]...${preview.tail}`;
}

function findObjectMarkerKey(source: object): string {
  let suffix = 1;
  let candidate = COMPACT_MARKER_KEY;
  while (Object.prototype.hasOwnProperty.call(source, candidate)) {
    suffix += 1;
    candidate = `${COMPACT_MARKER_KEY}${suffix}`;
  }
  return candidate;
}

/** JSON.parse 可能产生无法保真 JSON.stringify 的数值，先做完整有界检查。 */
function hasOnlyFaithfulJsonNumbers(root: unknown): boolean {
  const pending: unknown[] = [root];

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'number') {
      if (
        !Number.isFinite(value) ||
        Object.is(value, -0) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      ) {
        return false;
      }
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        pending.push(item);
      }
      continue;
    }

    if (typeof value === 'object' && value !== null) {
      for (const key of Object.keys(value)) {
        pending.push((value as JsonRecord)[key]);
      }
    }
  }

  return true;
}

function compactJsonValue(value: unknown, kind: ToolPayloadKind, depth: number): unknown {
  if (typeof value === 'string') {
    return compactStringLeaf(
      value,
      kind === 'tool_input' ? INPUT_STRING_RETAINED_CHARS : RESULT_STRING_RETAINED_CHARS,
    );
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_CONTAINER_DEPTH) {
      return createMaxDepthMarker('array');
    }

    const compacted: unknown[] = [];
    if (value.length <= ARRAY_RETAINED_ITEMS) {
      for (const item of value) {
        compacted.push(compactJsonValue(item, kind, depth + 1));
      }
      return compacted;
    }

    for (const item of value.slice(0, ARRAY_HEAD_ITEMS)) {
      compacted.push(compactJsonValue(item, kind, depth + 1));
    }
    compacted.push(
      createMarkerRecord(
        createDetails([
          ['kind', 'array'],
          ['omittedItems', value.length - ARRAY_RETAINED_ITEMS],
        ]),
      ),
    );
    for (const item of value.slice(-ARRAY_TAIL_ITEMS)) {
      compacted.push(compactJsonValue(item, kind, depth + 1));
    }
    return compacted;
  }

  if (typeof value === 'object' && value !== null) {
    if (depth >= MAX_CONTAINER_DEPTH) {
      return createMaxDepthMarker('object');
    }

    const source = value as JsonRecord;
    const keys = Object.keys(source);
    const compacted = createRecord();
    if (keys.length <= OBJECT_RETAINED_PROPERTIES) {
      for (const key of keys) {
        compacted[key] = compactJsonValue(source[key], kind, depth + 1);
      }
      return compacted;
    }

    for (const key of keys.slice(0, OBJECT_HEAD_PROPERTIES)) {
      compacted[key] = compactJsonValue(source[key], kind, depth + 1);
    }
    compacted[findObjectMarkerKey(source)] = createDetails([
      ['kind', 'object'],
      ['omittedProperties', keys.length - OBJECT_RETAINED_PROPERTIES],
    ]);
    for (const key of keys.slice(-OBJECT_TAIL_PROPERTIES)) {
      compacted[key] = compactJsonValue(source[key], kind, depth + 1);
    }
    return compacted;
  }

  return value;
}

function createJsonEnvelope(
  original: string,
  kind: ToolPayloadKind,
  format: JsonFormat,
  retainedBudget: number,
): string {
  const preview = createPreview(original, retainedBudget);
  return JSON.stringify({
    [COMPACT_MARKER_KEY]: {
      version: 1,
      kind,
      format,
      originalChars: original.length,
      omittedChars: preview.omittedChars,
      head: preview.head,
      tail: preview.tail,
    },
  });
}

function createTextFallback(original: string, retainedBudget: number): string {
  const preview = createPreview(original, retainedBudget);
  return `${preview.head}\n...[context compacted: kind=tool_result, originalChars=${original.length}, omittedChars=${preview.omittedChars}]...\n${preview.tail}`;
}

function createBoundedFallback(
  original: string,
  kind: ToolPayloadKind,
  format: JsonFormat,
  targetChars: number,
): string {
  let retainedBudget = Math.min(original.length, targetChars);

  for (;;) {
    const candidate =
      kind === 'tool_input' || format === 'json'
        ? createJsonEnvelope(original, kind, format, retainedBudget)
        : createTextFallback(original, retainedBudget);
    const overflow = candidate.length - targetChars;
    if (overflow <= 0) {
      return candidate;
    }
    if (retainedBudget === 0) {
      throw new RangeError('targetChars cannot contain the minimum compact marker');
    }
    retainedBudget = Math.max(0, retainedBudget - Math.max(1, overflow));
  }
}

/**
 * 使用确定性的结构裁剪或 preview fallback 压缩单个工具字符串。
 *
 * 返回 `undefined` 表示未超过阈值；任何 replacement 都严格不超过 target。
 */
export function compactDefaultToolPayload(
  original: string,
  kind: ToolPayloadKind,
  limits: DefaultToolPayloadCompactLimits,
): string | undefined {
  if (typeof original !== 'string') {
    throw new TypeError('Tool payload must be a string');
  }
  assertToolPayloadKind(kind);
  const resolvedLimits = validateLimits(limits);
  if (original.length <= resolvedLimits.thresholdChars) {
    return undefined;
  }

  let format: JsonFormat;
  let parsed: unknown;
  if (original.length > DEFAULT_TOOL_PAYLOAD_JSON_INSPECTION_LIMIT) {
    format = 'not-inspected';
  } else {
    try {
      parsed = JSON.parse(original) as unknown;
      format = 'json';
    } catch {
      format = 'invalid-json';
    }
  }

  if (format === 'json') {
    try {
      if (hasOnlyFaithfulJsonNumbers(parsed)) {
        const structuredCandidate = JSON.stringify(compactJsonValue(parsed, kind, 0));
        if (structuredCandidate.length <= resolvedLimits.targetChars) {
          return structuredCandidate;
        }
      }
    } catch {
      // Structure probing is best-effort; the bounded fallback is the contract.
    }
  }

  return createBoundedFallback(original, kind, format, resolvedLimits.targetChars);
}
