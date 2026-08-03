import type { AgentSkillDescriptor } from './types';

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const singleExtensionPattern = /^\.[a-z0-9]+$/iu;
const forbiddenPortableSegmentPattern = /[<>:"|?*\\]/u;
const windowsReservedBasenamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/** Skill DSL 中唯一作为 separator 的 ASCII whitespace。 */
export const SKILL_COMMAND_WHITESPACE = Object.freeze(['\t', '\n', '\r', ' '] as const);

export type ParsedSkillCommand =
  | { readonly kind: 'load'; readonly arguments: string }
  | { readonly kind: 'read'; readonly resourceId: string }
  | { readonly kind: 'run'; readonly scriptId: string; readonly argv: readonly string[] };

export type SkillCommandParseResult =
  | { readonly ok: true; readonly command: ParsedSkillCommand }
  | {
      readonly ok: false;
      readonly code: 'invalid_command' | 'invalid_arguments';
      readonly command?: 'read' | 'run';
    };

export interface SkillLogicalPathEntry {
  readonly id: string;
  readonly kind: 'resource' | 'script';
}

export interface SkillManifestScript {
  readonly id: string;
  readonly available: boolean;
  readonly description?: string;
}

export interface SkillLoadRenderInput {
  readonly name: string;
  readonly instructions: string;
  readonly arguments: string;
  readonly resourceIds: readonly string[];
  readonly scripts: readonly SkillManifestScript[];
}

/** 解析 load/read/run；不会执行 Shell 展开或重组 load 的 raw arguments。 */
export function parseSkillCommand(args: string | undefined): SkillCommandParseResult {
  if (args === undefined || args.length === 0) {
    return { ok: true, command: { kind: 'load', arguments: '' } };
  }

  if (args.includes('\0')) {
    return { ok: false, code: 'invalid_arguments' };
  }

  let cursor = skipCommandWhitespace(args, 0);

  if (cursor === args.length) {
    return { ok: true, command: { kind: 'load', arguments: '' } };
  }

  const commandStart = cursor;
  while (cursor < args.length && !isCommandWhitespace(args[cursor] ?? '')) {
    cursor += 1;
  }

  const commandName = args.slice(commandStart, cursor);

  if (commandName === 'load') {
    cursor = skipCommandWhitespace(args, cursor);
    return {
      ok: true,
      command: { kind: 'load', arguments: args.slice(cursor) },
    };
  }

  if (commandName !== 'read' && commandName !== 'run') {
    return { ok: false, code: 'invalid_command' };
  }

  const tokens = lexCommandTokens(args, cursor);
  if (!tokens.ok) {
    return { ok: false, code: 'invalid_arguments', command: commandName };
  }

  if (commandName === 'read') {
    if (tokens.values.length !== 1) {
      return { ok: false, code: 'invalid_arguments', command: 'read' };
    }

    return {
      ok: true,
      command: { kind: 'read', resourceId: tokens.values[0] ?? '' },
    };
  }

  if (tokens.values.length === 0) {
    return { ok: false, code: 'invalid_arguments', command: 'run' };
  }

  return {
    ok: true,
    command: {
      kind: 'run',
      scriptId: tokens.values[0] ?? '',
      argv: Object.freeze(tokens.values.slice(1)),
    },
  };
}

/** 有效 Skill 名是 1–64 个 code point 的小写 ASCII slug。 */
export function isValidSkillName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    countCodePoints(value) >= 1 &&
    countCodePoints(value) <= 64 &&
    skillNamePattern.test(value)
  );
}

/** 校验 Agent Skills portable text subset 的 `/` 分隔逻辑 id。 */
export function isPortableSkillLogicalId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  const segments = value.split('/');

  return segments.every((segment) => {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith(' ') ||
      segment.endsWith('.') ||
      hasPortableControlCharacter(segment) ||
      forbiddenPortableSegmentPattern.test(segment)
    ) {
      return false;
    }

    return !windowsReservedBasenamePattern.test(segment);
  });
}

/** 单后缀统一转为小写；非法值返回 undefined。 */
export function normalizeSkillExtension(value: unknown): string | undefined {
  return typeof value === 'string' && singleExtensionPattern.test(value)
    ? value.toLowerCase()
    : undefined;
}

/** 固定的 UTF-16 code-unit lexicographic comparator。 */
export function compareSkillStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 复制并按固定 UTF-16 code-unit 顺序排序。 */
export function sortSkillStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareSkillStrings);
}

/**
 * 拒绝逐目录 NFC/lowercase alias、重复文件和 file/directory 前缀冲突。
 */
export function assertPortableSkillLayout(entries: readonly SkillLogicalPathEntry[]): void {
  interface TrieNode {
    readonly children: Map<string, { readonly segment: string; readonly node: TrieNode }>;
    file?: SkillLogicalPathEntry;
  }

  const root: TrieNode = { children: new Map() };

  for (const entry of entries) {
    if (!isPortableSkillLogicalId(entry.id)) {
      throw new TypeError(`Invalid portable Skill logical id: ${entry.id}`);
    }

    const segments = entry.id.split('/');
    let current = root;

    for (const [index, segment] of segments.entries()) {
      if (current.file) {
        throw new TypeError(
          `Skill logical path conflicts with file prefix: ${current.file.id} and ${entry.id}`,
        );
      }

      const collisionKey = segment.normalize('NFC').toLowerCase();
      const existing = current.children.get(collisionKey);

      if (existing && existing.segment !== segment) {
        throw new TypeError(
          `Skill logical path has a case or Unicode normalization collision: ${existing.segment} and ${segment}`,
        );
      }

      const child = existing ?? { segment, node: { children: new Map() } };
      if (!existing) {
        current.children.set(collisionKey, child);
      }
      current = child.node;

      if (index === segments.length - 1) {
        if (current.file) {
          throw new TypeError(`Duplicate Skill logical path: ${entry.id}`);
        }

        if (current.children.size > 0) {
          throw new TypeError(`Skill logical path is a prefix of another file: ${entry.id}`);
        }

        current.file = entry;
      }
    }
  }
}

/** 普通 record 只接受 Object.prototype 或 null prototype。 */
export function isPlainSkillRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** 使用 code-point iterator 计数，而不是 UTF-16 `.length`。 */
export function countCodePoints(value: string): number {
  return [...value].length;
}

/** 生成不会打断单行 catalog/manifest 的 JSON string literal。 */
export function renderSkillJsonString(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

/** Discovery catalog 只消费严格 name + description descriptor。 */
export function renderSkillDiscoveryCatalog(descriptors: readonly AgentSkillDescriptor[]): string {
  return descriptors
    .map((descriptor) => `- ${descriptor.name}: ${renderSkillJsonString(descriptor.description)}`)
    .join('\n');
}

/** 用固定 Markdown envelope 渲染 load 结果。 */
export function renderSkillLoad(input: SkillLoadRenderInput): string {
  const hasArgumentsPlaceholder = input.instructions.includes('$ARGUMENTS');
  let instructions = hasArgumentsPlaceholder
    ? input.instructions.replaceAll('$ARGUMENTS', () => input.arguments)
    : input.instructions;

  if (!hasArgumentsPlaceholder && input.arguments.length > 0) {
    instructions = [instructions, `ARGUMENTS:\n${input.arguments}`]
      .filter((part) => part.length > 0)
      .join('\n\n');
  }

  const resources =
    input.resourceIds.length === 0
      ? '- none'
      : input.resourceIds.map((id) => `- ${renderManifestId(id)}`).join('\n');
  const scripts =
    input.scripts.length === 0
      ? '- none'
      : input.scripts
          .map((script) => {
            const description =
              script.description === undefined
                ? ''
                : ` — ${renderSkillJsonString(script.description)}`;
            return `- ${renderManifestId(script.id)} [${script.available ? 'available' : 'unavailable'}]${description}`;
          })
          .join('\n');

  return [
    `# Skill: ${input.name}`,
    '',
    '## Instructions',
    instructions,
    '',
    '## Resources',
    resources,
    '',
    '## Scripts',
    scripts,
    '',
    '## Commands',
    '- read <resource-id>',
    '- run <script-id> [args...]',
  ].join('\n');
}

function isCommandWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r';
}

function hasPortableControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function skipCommandWhitespace(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length && isCommandWhitespace(value[cursor] ?? '')) {
    cursor += 1;
  }
  return cursor;
}

function lexCommandTokens(
  value: string,
  start: number,
): { readonly ok: true; readonly values: string[] } | { readonly ok: false } {
  const values: string[] = [];
  let cursor = start;

  while (true) {
    cursor = skipCommandWhitespace(value, cursor);
    if (cursor >= value.length) {
      return { ok: true, values };
    }

    let token = '';
    const openingCharacter = value[cursor] ?? '';

    if (openingCharacter === "'" || openingCharacter === '"') {
      const quote = openingCharacter;
      cursor += 1;
      let closed = false;

      while (cursor < value.length) {
        const character = value[cursor] ?? '';

        if (character === quote) {
          cursor += 1;
          closed = true;
          break;
        }

        const consumed = consumeSkillTokenCharacter(value, cursor);
        if (!consumed.ok) {
          return { ok: false };
        }

        token += consumed.character;
        cursor = consumed.cursor;
      }

      if (!closed) {
        return { ok: false };
      }

      // Quoting is a complete token form rather than shell-style token concatenation.
      if (cursor < value.length && !isCommandWhitespace(value[cursor] ?? '')) {
        return { ok: false };
      }
    } else {
      while (cursor < value.length && !isCommandWhitespace(value[cursor] ?? '')) {
        const character = value[cursor] ?? '';

        // A quote may only open at the beginning of a token.
        if (character === "'" || character === '"') {
          return { ok: false };
        }

        const consumed = consumeSkillTokenCharacter(value, cursor);
        if (!consumed.ok) {
          return { ok: false };
        }

        token += consumed.character;
        cursor = consumed.cursor;
      }
    }

    values.push(token);
  }
}

function consumeSkillTokenCharacter(
  value: string,
  cursor: number,
):
  | { readonly ok: true; readonly character: string; readonly cursor: number }
  | { readonly ok: false } {
  const character = value[cursor] ?? '';

  if (character !== '\\') {
    const codePoint = value.codePointAt(cursor);
    if (codePoint === undefined) {
      return { ok: false };
    }

    const consumedCharacter = String.fromCodePoint(codePoint);
    return {
      ok: true,
      character: consumedCharacter,
      cursor: cursor + consumedCharacter.length,
    };
  }

  const escapedCursor = cursor + 1;
  const escapedCodePoint = value.codePointAt(escapedCursor);
  if (escapedCodePoint === undefined) {
    return { ok: false };
  }

  const escapedCharacter = String.fromCodePoint(escapedCodePoint);
  return {
    ok: true,
    character: escapedCharacter,
    cursor: escapedCursor + escapedCharacter.length,
  };
}

function renderManifestId(id: string): string {
  return /[\t\n\r ]/u.test(id) ? `"${id}"` : id;
}
