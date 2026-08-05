import { parseDocument } from 'yaml';

import type { AgentSkillFileSource, AgentSkillSourceDiagnosticReason } from './types';
import type {
  SkillDirectoryEntry,
  SkillFileCapabilities,
  SkillNodeCapabilities,
} from './skill-node-runtime';
import { isSkillAccessDeniedError, isSkillPathRaceError } from './skill-node-runtime';
import {
  SkillRuntimeError,
  type ResolvedFileSkillResource,
  type ResolvedFileSkillScript,
  type ResolvedSkillCandidate,
  type SkillFileSourceLoadResult,
  type SkillRegistryFileSourceAdapter,
} from './skill-registry-types';

/** File adapter 初始化时需要的 immutable runtime snapshot。 */
export interface SkillFileSourceOptions {
  readonly capabilities: SkillNodeCapabilities;
  readonly resourceExtensions: readonly string[];
}

interface ParsedSkillDocument {
  readonly descriptor: ResolvedSkillCandidate['descriptor'];
  readonly sourceMetadata: ResolvedSkillCandidate['sourceMetadata'];
  readonly instructions: string;
}

interface LocatedSkillRoot {
  readonly rootRealPath: string;
  readonly skillDocumentPath: string;
}

interface PathTrieNode {
  readonly children: Map<string, PathTrieEdge>;
  file: boolean;
}

interface PathTrieEdge {
  readonly spelling: string;
  readonly node: PathTrieNode;
}

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const invalidPortablePunctuationPattern = /[<>:"|?*\\]/u;
const windowsReservedBasenamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * 创建 Registry 可直接消费的 file adapter；所有回调共享同一次 capability snapshot。
 */
export function createSkillFileSourceAdapter(
  options: SkillFileSourceOptions,
): SkillRegistryFileSourceAdapter {
  const frozenExtensions = Object.freeze([...options.resourceExtensions]);
  const snapshot: SkillFileSourceOptions = Object.freeze({
    capabilities: options.capabilities,
    resourceExtensions: frozenExtensions,
  });

  return Object.freeze({
    load: (source: AgentSkillFileSource) => loadFileSkillSource(source, snapshot),
    read: (resource: ResolvedFileSkillResource, skillName: string, logicalId: string) =>
      readFileSkillResource(snapshot.capabilities.files, resource, skillName, logicalId),
  });
}

/**
 * 将一个显式 file source 解析成统一 candidate，或以稳定原因安全忽略。
 *
 * files capability 缺失时故意不读取 `source.path`，支持 non-Node 安全降级。
 */
export function loadFileSkillSource(
  source: AgentSkillFileSource,
  options: SkillFileSourceOptions,
): SkillFileSourceLoadResult {
  const files = options.capabilities.files;

  if (!files) {
    return {
      status: 'ignored',
      reason: unavailableFileReason(options.capabilities),
    };
  }

  // 必须位于 capability gate 之后；测试使用 throwing getter 验证这一点。
  const configuredPath = source.path;

  if (
    typeof configuredPath !== 'string' ||
    configuredPath.trim().length === 0 ||
    configuredPath.includes('\0')
  ) {
    throw new TypeError('File Skill source.path must be a non-empty string without NUL.');
  }

  try {
    const resolvedPath = files.resolve(files.cwd(), configuredPath);

    if (files.hasReadPermission(resolvedPath) === false) {
      return { status: 'ignored', reason: 'read_permission_denied' };
    }

    files.accessRead(resolvedPath);
    const located = locateSkillRoot(files, resolvedPath);
    files.accessRead(located.skillDocumentPath);
    const document = parseSkillDocument(files.readFile(located.skillDocumentPath));
    const canonicalName = files.basename(located.rootRealPath);

    validateSkillName(document.descriptor.name);

    if (document.descriptor.name !== canonicalName) {
      throw new TypeError(
        `File Skill name must match its canonical root basename: ${canonicalName}`,
      );
    }

    const discovered = discoverSkillEntries(
      files,
      located.rootRealPath,
      new Set(options.resourceExtensions.map((extension) => extension.toLowerCase())),
    );
    const skill: ResolvedSkillCandidate = Object.freeze({
      descriptor: document.descriptor,
      sourceMetadata: document.sourceMetadata,
      instructions: document.instructions,
      resources: discovered.resources,
      scripts: discovered.scripts,
      source: 'file',
      rootDirectory: located.rootRealPath,
    });

    return { status: 'loaded', skill };
  } catch (error) {
    if (isSkillAccessDeniedError(error)) {
      return { status: 'ignored', reason: 'source_access_denied' };
    }

    throw error;
  }
}

/** Lazy read：重新验证已登记文件后执行 fatal UTF-8 解码。 */
export function readFileSkillResource(
  files: SkillFileCapabilities | undefined,
  resource: ResolvedFileSkillResource,
  skillName: string,
  logicalId: string,
): string {
  if (!files) {
    throw new SkillRuntimeError(
      'resource-read',
      skillName,
      logicalId,
      new Error('File capability is unavailable.'),
    );
  }

  try {
    const currentRealPath = revalidateFileSkillEntry(
      files,
      resource,
      'resource',
      skillName,
      logicalId,
    );

    return decodeUtf8(files.readFile(currentRealPath), 'resource');
  } catch (error) {
    if (error instanceof SkillRuntimeError) throw error;
    throw new SkillRuntimeError('resource-read', skillName, logicalId, error);
  }
}

/**
 * Lazy read/run 共用的路径复核。成功返回本次验证得到的 real path。
 */
export function revalidateFileSkillEntry(
  files: SkillFileCapabilities,
  entry: ResolvedFileSkillResource | ResolvedFileSkillScript,
  kind: 'resource' | 'script',
  skillName: string,
  logicalId: string,
): string {
  const stage = kind === 'resource' ? 'resource-read' : 'file-validation';

  try {
    const status = files.lstat(entry.absolutePath);

    if (!status.isFile || status.isSymbolicLink) {
      throw new Error('The registered Skill entry is no longer a regular file.');
    }

    const currentRealPath = files.realpath(entry.absolutePath);

    if (
      currentRealPath !== entry.realPath ||
      !isWithinRoot(files, entry.rootRealPath, currentRealPath)
    ) {
      throw new Error('The registered Skill entry no longer resolves inside its Skill root.');
    }

    return currentRealPath;
  } catch (error) {
    if (error instanceof SkillRuntimeError) throw error;
    throw new SkillRuntimeError(stage, skillName, logicalId, error);
  }
}

function unavailableFileReason(
  capabilities: SkillNodeCapabilities,
): AgentSkillSourceDiagnosticReason {
  const diagnostic = capabilities.diagnostics.files;

  return !diagnostic.available && diagnostic.reason === 'node_unavailable'
    ? 'node_unavailable'
    : 'file_capability_unavailable';
}

function locateSkillRoot(files: SkillFileCapabilities, configuredPath: string): LocatedSkillRoot {
  const configuredStatus = files.lstat(configuredPath);
  let rootRealPath: string;
  let skillDocumentPath: string;

  if (configuredStatus.isDirectory) {
    rootRealPath = files.realpath(configuredPath);
    assertDirectory(files.stat(rootRealPath), 'File Skill root');
    skillDocumentPath = files.join(rootRealPath, 'SKILL.md');
  } else if (configuredStatus.isSymbolicLink) {
    const resolvedTarget = files.realpath(configuredPath);
    const targetStatus = files.stat(resolvedTarget);

    if (!targetStatus.isDirectory) {
      throw new TypeError('A symlink File Skill source must resolve to a directory.');
    }

    rootRealPath = resolvedTarget;
    skillDocumentPath = files.join(rootRealPath, 'SKILL.md');
  } else if (configuredStatus.isFile) {
    if (files.basename(configuredPath) !== 'SKILL.md') {
      throw new TypeError('A File Skill file source must have basename SKILL.md.');
    }

    const documentRealPath = files.realpath(configuredPath);
    const documentStatus = files.stat(documentRealPath);

    if (!documentStatus.isFile) {
      throw new TypeError('File Skill SKILL.md must be a regular file.');
    }

    rootRealPath = files.realpath(files.dirname(documentRealPath));
    assertDirectory(files.stat(rootRealPath), 'File Skill root');
    skillDocumentPath = documentRealPath;
  } else {
    throw new TypeError('File Skill source must be a directory or SKILL.md file.');
  }

  const documentStatus = files.lstat(skillDocumentPath);

  if (!documentStatus.isFile || documentStatus.isSymbolicLink) {
    throw new TypeError('File Skill SKILL.md must be a non-symlink regular file.');
  }

  const documentRealPath = files.realpath(skillDocumentPath);

  if (!isWithinRoot(files, rootRealPath, documentRealPath)) {
    throw new TypeError('File Skill SKILL.md resolves outside its canonical root.');
  }

  return {
    rootRealPath,
    skillDocumentPath: documentRealPath,
  };
}

function parseSkillDocument(bytes: Uint8Array): ParsedSkillDocument {
  const text = decodeUtf8(bytes, 'SKILL.md');
  const frontmatter = splitFrontmatter(text);
  const document = parseDocument(frontmatter.yaml, {
    prettyErrors: false,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    throw new TypeError(
      `Invalid SKILL.md frontmatter: ${document.errors[0]?.message ?? 'YAML error'}`,
    );
  }

  // Preserve YAML key types while converting so non-string metadata keys are
  // rejected instead of being stringified (which may also emit a process warning).
  const value: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 100 });

  if (!(value instanceof Map)) {
    throw new TypeError('SKILL.md frontmatter root must be a mapping.');
  }

  const name = value.get('name');
  const description = value.get('description');

  if (typeof name !== 'string') throw new TypeError('SKILL.md name must be a string.');
  if (typeof description !== 'string') {
    throw new TypeError('SKILL.md description must be a string.');
  }

  validateSkillName(name);
  validateNonEmptyCodePointString(description, 1_024, 'SKILL.md description');
  const license = optionalString(value.get('license'), 'SKILL.md license');
  const compatibility = optionalString(value.get('compatibility'), 'SKILL.md compatibility', 500);
  const metadata = optionalMetadata(value.get('metadata'));

  return {
    descriptor: Object.freeze({ name, description }),
    sourceMetadata: Object.freeze({
      ...(license === undefined ? {} : { license }),
      ...(compatibility === undefined ? {} : { compatibility }),
      ...(metadata === undefined ? {} : { metadata }),
    }),
    instructions: frontmatter.body,
  };
}

function splitFrontmatter(text: string): { readonly yaml: string; readonly body: string } {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const opening = readLine(normalized, 0);

  if (!opening || opening.content !== '---' || opening.nextOffset === undefined) {
    throw new TypeError('SKILL.md must begin with an exact --- frontmatter line.');
  }

  let offset = opening.nextOffset;

  while (offset <= normalized.length) {
    const line = readLine(normalized, offset);

    if (!line) break;

    if (line.content === '---') {
      return {
        yaml: normalized.slice(opening.nextOffset, offset),
        body: line.nextOffset === undefined ? '' : normalized.slice(line.nextOffset),
      };
    }

    if (line.nextOffset === undefined) break;
    offset = line.nextOffset;
  }

  throw new TypeError('SKILL.md frontmatter is missing its closing --- line.');
}

function readLine(
  text: string,
  offset: number,
): { readonly content: string; readonly nextOffset?: number } | undefined {
  if (offset > text.length) return undefined;
  const lineFeed = text.indexOf('\n', offset);

  if (lineFeed < 0) {
    return { content: text.slice(offset) };
  }

  const contentEnd =
    lineFeed > offset && text.charCodeAt(lineFeed - 1) === 0x0d ? lineFeed - 1 : lineFeed;

  return {
    content: text.slice(offset, contentEnd),
    nextOffset: lineFeed + 1,
  };
}

function discoverSkillEntries(
  files: SkillFileCapabilities,
  rootRealPath: string,
  resourceExtensions: ReadonlySet<string>,
): {
  readonly resources: ReadonlyMap<string, ResolvedFileSkillResource>;
  readonly scripts: ReadonlyMap<string, ResolvedFileSkillScript>;
} {
  const resources = new Map<string, ResolvedFileSkillResource>();
  const scripts = new Map<string, ResolvedFileSkillScript>();
  const trie = createPathTrieNode();

  scanWellKnownDirectory('references', 'resource');
  scanWellKnownDirectory('assets', 'resource');
  scanWellKnownDirectory('scripts', 'script');

  return {
    resources: immutableSortedMap(resources),
    scripts: immutableSortedMap(scripts),
  };

  function scanWellKnownDirectory(
    directoryName: 'references' | 'assets' | 'scripts',
    kind: 'resource' | 'script',
  ): void {
    const absolutePath = files.join(rootRealPath, directoryName);
    let status;

    try {
      status = files.lstat(absolutePath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        const rootStatus = files.lstat(rootRealPath);

        if (!rootStatus.isDirectory || rootStatus.isSymbolicLink) {
          throw new TypeError('File Skill root changed while it was being scanned.', {
            cause: error,
          });
        }

        return;
      }
      throw error;
    }

    if (!status.isDirectory || status.isSymbolicLink) {
      throw new TypeError(`File Skill ${directoryName}/ must be a non-symlink directory.`);
    }

    const realPath = files.realpath(absolutePath);

    if (!isWithinRoot(files, rootRealPath, realPath)) {
      throw new TypeError(`File Skill ${directoryName}/ resolves outside its root.`);
    }

    scanDirectory(realPath, directoryName, [], kind);
  }

  function scanDirectory(
    directoryPath: string,
    logicalRoot: 'references' | 'assets' | 'scripts',
    relativeSegments: readonly string[],
    kind: 'resource' | 'script',
  ): void {
    requireStableEntry(files, directoryPath, 'directory');
    let entries: readonly SkillDirectoryEntry[];

    try {
      entries = [...files.readdir(directoryPath)].sort(compareDirectoryEntries);
    } catch (error) {
      if (isSkillPathRaceError(error)) {
        throw new TypeError('File Skill tree changed while it was being scanned.', {
          cause: error,
        });
      }
      throw error;
    }

    for (const entry of entries) {
      assertTraversableEntryName(entry.name, files.separator);
      const absolutePath = files.join(directoryPath, entry.name);

      if (entry.isSymbolicLink) continue;

      if (entry.isDirectory) {
        requireStableEntry(files, absolutePath, 'directory');
        const realDirectory = files.realpath(absolutePath);

        if (!isWithinRoot(files, rootRealPath, realDirectory)) {
          throw new TypeError('File Skill directory resolves outside its root.');
        }

        scanDirectory(realDirectory, logicalRoot, [...relativeSegments, entry.name], kind);
        continue;
      }

      if (!entry.isFile) continue;
      const extension = files.extname(entry.name);
      const normalizedExtension = extension.toLowerCase();

      // Filter precedence is intentional: ignored files never enter portable/trie/realpath checks.
      if (kind === 'resource' && !resourceExtensions.has(normalizedExtension)) continue;
      if (kind === 'script' && extension.length === 0) continue;

      const logicalSegments = [...relativeSegments, entry.name];

      validatePortableSegments(logicalSegments);
      const logicalId = `${logicalRoot}/${logicalSegments.join('/')}`;
      addMaterializedPath(trie, logicalId);
      requireStableEntry(files, absolutePath, 'file');
      const realPath = files.realpath(absolutePath);

      if (!isWithinRoot(files, rootRealPath, realPath)) {
        throw new TypeError('File Skill entry resolves outside its root.');
      }

      if (kind === 'resource') {
        resources.set(
          logicalId,
          Object.freeze({ source: 'file', absolutePath, realPath, rootRealPath }),
        );
      } else {
        scripts.set(
          logicalId,
          Object.freeze({
            source: 'file',
            absolutePath,
            realPath,
            rootRealPath,
            extension: normalizedExtension,
          }),
        );
      }
    }
  }
}

function requireStableEntry(
  files: SkillFileCapabilities,
  path: string,
  expected: 'file' | 'directory',
): void {
  let status;

  try {
    status = files.lstat(path);
  } catch (error) {
    if (isSkillPathRaceError(error)) {
      throw new TypeError('File Skill tree changed while it was being scanned.', { cause: error });
    }
    throw error;
  }

  if (status.isSymbolicLink) {
    throw new TypeError('File Skill entry changed into a symlink while being scanned.');
  }

  if (expected === 'file' ? !status.isFile : !status.isDirectory) {
    throw new TypeError('File Skill entry type changed while being scanned.');
  }
}

function validatePortableSegments(segments: readonly string[]): void {
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      hasAsciiControlCharacter(segment) ||
      invalidPortablePunctuationPattern.test(segment) ||
      segment.endsWith(' ') ||
      segment.endsWith('.') ||
      windowsReservedBasenamePattern.test(segment)
    ) {
      throw new TypeError(
        `File Skill candidate is outside the Agent Skills portable text subset: ${segment}`,
      );
    }
  }
}

function addMaterializedPath(root: PathTrieNode, logicalId: string): void {
  const segments = logicalId.split('/');
  let node = root;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    const key = segment.normalize('NFC').toLowerCase();
    const existing = node.children.get(key);

    if (existing && existing.spelling !== segment) {
      throw new TypeError(`File Skill paths collide after NFC/case normalization: ${logicalId}`);
    }

    const edge = existing ?? {
      spelling: segment,
      node: createPathTrieNode(),
    };

    if (!existing) node.children.set(key, edge);
    node = edge.node;

    if (index < segments.length - 1 && node.file) {
      throw new TypeError(`File Skill path has a file/directory prefix collision: ${logicalId}`);
    }
  }

  if (node.file || node.children.size > 0) {
    throw new TypeError(`File Skill path collides with another materialized path: ${logicalId}`);
  }

  node.file = true;
}

function createPathTrieNode(): PathTrieNode {
  return { children: new Map(), file: false };
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;

    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }

  return false;
}

function isWithinRoot(
  files: Pick<SkillFileCapabilities, 'relative' | 'isAbsolute' | 'separator'>,
  rootRealPath: string,
  targetRealPath: string,
): boolean {
  const relative = files.relative(rootRealPath, targetRealPath);

  return (
    !files.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${files.separator}`)
  );
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  } catch (error) {
    throw new TypeError(`${label} must contain valid UTF-8.`, { cause: error });
  }
}

function validateSkillName(value: string): void {
  if (countCodePoints(value) > 64 || !skillNamePattern.test(value)) {
    throw new TypeError('SKILL.md name must be a lowercase 1-64 character slug.');
  }
}

function validateNonEmptyCodePointString(value: string, maximum: number, label: string): void {
  const length = countCodePoints(value);

  if (value.trim().length === 0 || length > maximum) {
    throw new TypeError(`${label} must be non-empty and at most ${maximum} Unicode code points.`);
  }
}

function optionalString(value: unknown, label: string, maximum?: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (maximum !== undefined && countCodePoints(value) > maximum) {
    throw new TypeError(`${label} must be at most ${maximum} Unicode code points.`);
  }
  return value;
}

function optionalMetadata(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Map)) throw new TypeError('SKILL.md metadata must be a string mapping.');
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const entries = [...value.entries()];

  if (entries.some(([key]) => typeof key !== 'string')) {
    throw new TypeError('SKILL.md metadata keys must be strings.');
  }

  entries.sort(([left], [right]) => compareStrings(left as string, right as string));

  for (const [key, item] of entries) {
    if (typeof key !== 'string') {
      throw new TypeError('SKILL.md metadata keys must be strings.');
    }

    if (typeof item !== 'string') {
      throw new TypeError('SKILL.md metadata values must be strings.');
    }

    result[key] = item;
  }

  return Object.freeze(result);
}

function immutableSortedMap<T>(input: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  return new Map([...input.entries()].sort(([left], [right]) => compareStrings(left, right)));
}

function assertDirectory(status: { readonly isDirectory: boolean }, label: string): void {
  if (!status.isDirectory) throw new TypeError(`${label} must be a directory.`);
}

function assertTraversableEntryName(name: string, separator: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes(separator) ||
    name.includes('\0')
  ) {
    throw new TypeError('Node returned an invalid Skill directory entry name.');
  }
}

function countCodePoints(value: string): number {
  return [...value].length;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDirectoryEntries(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return compareStrings(left.name, right.name);
}

function hasErrorCode(error: unknown, expected: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === expected;
}
