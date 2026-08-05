import {
  assertPortableSkillLayout,
  compareSkillStrings,
  countCodePoints,
  isPlainSkillRecord,
  isPortableSkillLogicalId,
  isValidSkillName,
  normalizeSkillExtension,
  parseSkillCommand,
  renderSkillLoad,
  type SkillLogicalPathEntry,
  type SkillManifestScript,
} from './skill-command';
import {
  SkillRuntimeError,
  type ResolvedFileSkillResource,
  type ResolvedFileSkillScript,
  type ResolvedInlineSkillResource,
  type ResolvedInlineSkillScript,
  type ResolvedSkill,
  type ResolvedSkillCandidate,
  type ResolvedSkillResource,
  type ResolvedSkillScript,
  type ResolvedSkillSourceMetadata,
  type SkillDispatchErrorCode,
  type SkillDispatchErrorResult,
  type SkillRegistryBuildOptions,
  type SkillRegistryBuildResult,
  type SkillRegistryFileSourceAdapter,
  type SkillRegistryScriptRuntime,
} from './skill-registry-types';
import type {
  AgentSkill,
  AgentSkillDescriptor,
  AgentSkillScript,
  AgentSkillSourceDiagnostic,
  AgentSkillSourceDiagnosticReason,
  SkillToolInput,
} from './types';

const diagnosticReasons = new Set<AgentSkillSourceDiagnosticReason>([
  'node_unavailable',
  'file_capability_unavailable',
  'read_permission_denied',
  'source_access_denied',
]);

/** Immutable effective Skill snapshot used by prompt construction and tool dispatch. */
export class SkillRegistry {
  readonly #skillsByName: ReadonlyMap<string, ResolvedSkill>;
  readonly #descriptors: readonly AgentSkillDescriptor[];
  readonly #fileSource: SkillRegistryFileSourceAdapter | undefined;
  readonly #scriptRuntime: SkillRegistryScriptRuntime | undefined;

  private constructor(
    skills: readonly ResolvedSkill[],
    fileSource: SkillRegistryFileSourceAdapter | undefined,
    scriptRuntime: SkillRegistryScriptRuntime | undefined,
  ) {
    this.#skillsByName = new Map(skills.map((skill) => [skill.descriptor.name, skill]));
    this.#descriptors = Object.freeze(skills.map((skill) => skill.descriptor));
    this.#fileSource = fileSource;
    this.#scriptRuntime = scriptRuntime;
  }

  /** 创建尚未包含任何 configured source 的初始快照。 */
  static empty(): SkillRegistry {
    return new SkillRegistry([], undefined, undefined);
  }

  /**
   * 事务性构建 Registry 与 ignored-source diagnostics。
   *
   * 调用方只有在其余 Agent 配置也校验成功后才应原子提交这两个值。
   */
  static build(options: SkillRegistryBuildOptions): SkillRegistryBuildResult {
    if (!isPlainSkillRecord(options)) {
      throw new TypeError('Skill registry build options must be a plain object.');
    }

    if (!Array.isArray(options.sources)) {
      throw new TypeError('Agent skills must be an array.');
    }

    const skills: ResolvedSkill[] = [];
    const diagnostics: AgentSkillSourceDiagnostic[] = [];
    const names = new Set<string>();

    for (const [sourceIndex, source] of options.sources.entries()) {
      if (!isPlainSkillRecord(source)) {
        throw new TypeError(`Skill source at index ${sourceIndex} must be a plain object.`);
      }

      let skill: ResolvedSkill | undefined;

      if (source.source === 'file') {
        if (options.fileSource === undefined) {
          diagnostics.push(freezeDiagnostic(sourceIndex, 'file_capability_unavailable'));
          continue;
        }

        const result = options.fileSource.load(
          source as unknown as { readonly source: 'file'; readonly path: string },
          sourceIndex,
        );

        if (result.status === 'ignored') {
          if (!diagnosticReasons.has(result.reason)) {
            throw new TypeError(`Invalid ignored Skill source reason at index ${sourceIndex}.`);
          }
          diagnostics.push(freezeDiagnostic(sourceIndex, result.reason));
          continue;
        }

        skill = normalizeResolvedCandidate(result.skill, sourceIndex);
      } else {
        skill = normalizeInlineSkill(source as unknown as AgentSkill, sourceIndex);
      }

      if (names.has(skill.descriptor.name)) {
        throw new TypeError(`Duplicate Skill name: ${skill.descriptor.name}`);
      }

      names.add(skill.descriptor.name);
      skills.push(skill);
    }

    const registry = new SkillRegistry(skills, options.fileSource, options.scriptRuntime);

    return Object.freeze({
      registry,
      diagnostics: Object.freeze(diagnostics),
    });
  }

  get size(): number {
    return this.#descriptors.length;
  }

  /** Discovery 和动态工具描述唯一允许读取的冻结视图。 */
  getDescriptors(): readonly AgentSkillDescriptor[] {
    return this.#descriptors;
  }

  /** 执行经过 Zod wire 校验后的 SkillToolInput。 */
  async dispatch(input: SkillToolInput): Promise<unknown> {
    if (
      !isPlainSkillRecord(input) ||
      !isValidSkillName(input.skill) ||
      (input.args !== undefined && typeof input.args !== 'string') ||
      input.args?.includes('\0') === true
    ) {
      return dispatchError(
        'invalid_arguments',
        'Invalid skill arguments. Usage: skill({ skill, args? }).',
      );
    }

    const skill = this.#skillsByName.get(input.skill);
    if (!skill) {
      return dispatchError('skill_not_found', `Skill ${input.skill} was not found.`);
    }

    const parsed = parseSkillCommand(input.args);
    if (!parsed.ok) {
      return parsed.code === 'invalid_command'
        ? dispatchError(
            'invalid_command',
            'Invalid skill command. Usage: load [arguments] | read <resource-id> | run <script-id> [args...].',
          )
        : dispatchError('invalid_arguments', commandUsage(parsed.command));
    }

    const command = parsed.command;

    if (command.kind === 'load') {
      const scripts: SkillManifestScript[] = [...skill.scripts].map(([id, script]) => {
        const description = script.description;
        return Object.freeze({
          id,
          available: this.#scriptRuntime?.isAvailable(skill, script) ?? false,
          ...(description === undefined ? {} : { description }),
        });
      });

      return renderSkillLoad({
        name: skill.descriptor.name,
        instructions: skill.instructions,
        arguments: command.arguments,
        resourceIds: [...skill.resources.keys()],
        scripts,
      });
    }

    if (command.kind === 'read') {
      if (!isPortableSkillLogicalId(command.resourceId)) {
        return dispatchError('invalid_arguments', commandUsage('read'));
      }

      const resource = skill.resources.get(command.resourceId);
      if (!resource) {
        return dispatchError(
          'resource_not_found',
          `Resource ${command.resourceId} was not found in Skill ${skill.descriptor.name}.`,
        );
      }

      if (resource.source === 'inline') {
        return resource.content;
      }

      if (!this.#fileSource) {
        throw new SkillRuntimeError(
          'resource-read',
          skill.descriptor.name,
          command.resourceId,
          new Error('File source adapter is unavailable.'),
        );
      }

      try {
        return await this.#fileSource.read(resource, skill.descriptor.name, command.resourceId);
      } catch (error) {
        if (error instanceof SkillRuntimeError) {
          throw error;
        }
        throw new SkillRuntimeError(
          'resource-read',
          skill.descriptor.name,
          command.resourceId,
          error,
        );
      }
    }

    if (!isPortableSkillLogicalId(command.scriptId)) {
      return dispatchError('invalid_arguments', commandUsage('run'));
    }

    const script = skill.scripts.get(command.scriptId);
    if (!script) {
      return dispatchError(
        'script_not_found',
        `Script ${command.scriptId} was not found in Skill ${skill.descriptor.name}.`,
      );
    }

    if (!this.#scriptRuntime?.isAvailable(skill, script)) {
      return dispatchError(
        'script_execution_unavailable',
        `Script execution is unavailable for ${command.scriptId} in Skill ${skill.descriptor.name}.`,
      );
    }

    return this.#scriptRuntime.run(skill, command.scriptId, script, command.argv);
  }
}

/** 函数式别名，便于 Agent.init() 在局部变量中构建候选事务。 */
export function buildSkillRegistry(options: SkillRegistryBuildOptions): SkillRegistryBuildResult {
  return SkillRegistry.build(options);
}

function normalizeInlineSkill(source: AgentSkill, sourceIndex: number): ResolvedSkill {
  const descriptor = normalizeDescriptor(source, sourceIndex);
  const sourceMetadata = normalizeSourceMetadata(source, sourceIndex);

  if (typeof source.instructions !== 'string') {
    throw new TypeError(`Skill instructions at index ${sourceIndex} must be a string.`);
  }

  const resources = new Map<string, ResolvedSkillResource>();
  normalizeInlineResourceMap(source.references, 'references', sourceIndex, resources);
  normalizeInlineResourceMap(source.assets, 'assets', sourceIndex, resources);

  const scripts = normalizeInlineScripts(source.scripts, sourceIndex);
  assertPortableSkillLayout([
    ...[...resources.keys()].map((id): SkillLogicalPathEntry => ({ id, kind: 'resource' })),
    ...[...scripts.keys()].map((id): SkillLogicalPathEntry => ({ id, kind: 'script' })),
  ]);

  return Object.freeze({
    descriptor,
    sourceMetadata,
    instructions: source.instructions,
    resources: sortedMap(resources),
    scripts: sortedMap(scripts),
    source: 'inline' as const,
  });
}

function normalizeResolvedCandidate(
  candidate: ResolvedSkillCandidate,
  sourceIndex: number,
): ResolvedSkill {
  if (!isPlainSkillRecord(candidate)) {
    throw new TypeError(`Resolved Skill candidate at index ${sourceIndex} must be a plain object.`);
  }

  if (candidate.source !== 'file') {
    throw new TypeError(`File source at index ${sourceIndex} returned a non-file Skill.`);
  }

  const descriptor = normalizeDescriptor(candidate.descriptor, sourceIndex);
  const sourceMetadata = normalizeSourceMetadata(candidate.sourceMetadata, sourceIndex);

  if (typeof candidate.instructions !== 'string') {
    throw new TypeError(`Skill instructions at index ${sourceIndex} must be a string.`);
  }
  if (typeof candidate.rootDirectory !== 'string' || candidate.rootDirectory.length === 0) {
    throw new TypeError(`File Skill root at index ${sourceIndex} must be a non-empty string.`);
  }
  if (!(candidate.resources instanceof Map) || !(candidate.scripts instanceof Map)) {
    throw new TypeError(`Resolved Skill maps at index ${sourceIndex} must be Map instances.`);
  }

  const resources = new Map<string, ResolvedSkillResource>();
  for (const [id, resource] of candidate.resources) {
    if (
      !isPortableSkillLogicalId(id) ||
      (!id.startsWith('references/') && !id.startsWith('assets/'))
    ) {
      throw new TypeError(`Invalid file Skill resource id: ${id}`);
    }
    resources.set(id, normalizeFileResource(resource, sourceIndex, id));
  }

  const scripts = new Map<string, ResolvedSkillScript>();
  for (const [id, script] of candidate.scripts) {
    if (!isPortableSkillLogicalId(id) || !id.startsWith('scripts/')) {
      throw new TypeError(`Invalid file Skill script id: ${id}`);
    }
    scripts.set(id, normalizeFileScript(script, sourceIndex, id));
  }

  assertPortableSkillLayout([
    ...[...resources.keys()].map((id): SkillLogicalPathEntry => ({ id, kind: 'resource' })),
    ...[...scripts.keys()].map((id): SkillLogicalPathEntry => ({ id, kind: 'script' })),
  ]);

  return Object.freeze({
    descriptor,
    sourceMetadata,
    instructions: candidate.instructions,
    resources: sortedMap(resources),
    scripts: sortedMap(scripts),
    source: 'file' as const,
    rootDirectory: candidate.rootDirectory,
  });
}

function normalizeDescriptor(
  value: { readonly name?: unknown; readonly description?: unknown },
  sourceIndex: number,
): AgentSkillDescriptor {
  if (!isValidSkillName(value.name)) {
    throw new TypeError(`Invalid Skill name at source index ${sourceIndex}.`);
  }
  if (
    typeof value.description !== 'string' ||
    value.description.trim().length === 0 ||
    countCodePoints(value.description) > 1_024
  ) {
    throw new TypeError(`Invalid Skill description at source index ${sourceIndex}.`);
  }

  return Object.freeze({ name: value.name, description: value.description });
}

function normalizeSourceMetadata(
  value: {
    readonly license?: unknown;
    readonly compatibility?: unknown;
    readonly metadata?: unknown;
  },
  sourceIndex: number,
): ResolvedSkillSourceMetadata {
  const license = value.license;
  const compatibility = value.compatibility;

  if (license !== undefined && (typeof license !== 'string' || license.trim().length === 0)) {
    throw new TypeError(`Invalid Skill license at source index ${sourceIndex}.`);
  }
  if (
    compatibility !== undefined &&
    (typeof compatibility !== 'string' ||
      compatibility.trim().length === 0 ||
      countCodePoints(compatibility) > 500)
  ) {
    throw new TypeError(`Invalid Skill compatibility at source index ${sourceIndex}.`);
  }

  let metadata: Readonly<Record<string, string>> | undefined;
  if (value.metadata !== undefined) {
    if (!isPlainSkillRecord(value.metadata)) {
      throw new TypeError(`Invalid Skill metadata at source index ${sourceIndex}.`);
    }

    const copied = Object.create(null) as Record<string, string>;
    for (const key of Object.keys(value.metadata)) {
      const item = value.metadata[key];
      if (typeof item !== 'string') {
        throw new TypeError(
          `Skill metadata values at source index ${sourceIndex} must be strings.`,
        );
      }
      copied[key] = item;
    }
    metadata = Object.freeze(copied);
  }

  return Object.freeze({
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function normalizeInlineResourceMap(
  value: Readonly<Record<string, string>> | undefined,
  prefix: 'references' | 'assets',
  sourceIndex: number,
  target: Map<string, ResolvedSkillResource>,
): void {
  if (value === undefined) return;
  if (!isPlainSkillRecord(value)) {
    throw new TypeError(`Skill ${prefix} at source index ${sourceIndex} must be a plain object.`);
  }

  for (const key of Object.keys(value)) {
    const content = value[key];
    const id = `${prefix}/${key}`;
    if (typeof content !== 'string') {
      throw new TypeError(`Skill resource ${id} must be a string.`);
    }
    if (!isPortableSkillLogicalId(id)) {
      throw new TypeError(`Invalid portable Skill resource id: ${id}`);
    }
    const resource: ResolvedInlineSkillResource = Object.freeze({ source: 'inline', content });
    target.set(id, resource);
  }
}

function normalizeInlineScripts(
  value: Readonly<Record<string, AgentSkillScript>> | undefined,
  sourceIndex: number,
): Map<string, ResolvedSkillScript> {
  const target = new Map<string, ResolvedSkillScript>();
  if (value === undefined) return target;
  if (!isPlainSkillRecord(value)) {
    throw new TypeError(`Skill scripts at source index ${sourceIndex} must be a plain object.`);
  }

  for (const key of Object.keys(value)) {
    const script = value[key];
    if (!isPortableSkillLogicalId(key)) {
      throw new TypeError(`Invalid portable inline Skill script key: ${key}`);
    }
    if (!isPlainSkillRecord(script)) {
      throw new TypeError(`Inline Skill script ${key} must be a plain object.`);
    }

    const extension = normalizeSkillExtension(script.extension);
    if (!extension) {
      throw new TypeError(`Inline Skill script ${key} has an invalid extension.`);
    }
    if (typeof script.content !== 'string') {
      throw new TypeError(`Inline Skill script ${key} content must be a string.`);
    }
    if (
      script.description !== undefined &&
      (typeof script.description !== 'string' ||
        script.description.trim().length === 0 ||
        countCodePoints(script.description) > 1_024)
    ) {
      throw new TypeError(`Inline Skill script ${key} has an invalid description.`);
    }

    const id = `scripts/${key}${extension}`;
    if (!isPortableSkillLogicalId(id)) {
      throw new TypeError(`Invalid portable Skill script id: ${id}`);
    }

    const normalized: ResolvedInlineSkillScript = Object.freeze({
      source: 'inline',
      extension,
      content: script.content,
      ...(script.description === undefined ? {} : { description: script.description }),
    });
    target.set(id, normalized);
  }

  return target;
}

function normalizeFileResource(
  value: ResolvedSkillResource,
  sourceIndex: number,
  id: string,
): ResolvedFileSkillResource {
  if (!isPlainSkillRecord(value) || value.source !== 'file') {
    throw new TypeError(`File Skill resource ${id} at index ${sourceIndex} is invalid.`);
  }

  for (const field of ['absolutePath', 'realPath', 'rootRealPath'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new TypeError(`File Skill resource ${id} has an invalid ${field}.`);
    }
  }

  return Object.freeze({
    source: 'file',
    absolutePath: value.absolutePath,
    realPath: value.realPath,
    rootRealPath: value.rootRealPath,
  });
}

function normalizeFileScript(
  value: ResolvedSkillScript,
  sourceIndex: number,
  id: string,
): ResolvedFileSkillScript {
  const resource = normalizeFileResource(value, sourceIndex, id);
  const extension = normalizeSkillExtension(value.extension);

  if (!extension || !id.toLowerCase().endsWith(extension)) {
    throw new TypeError(`File Skill script ${id} has an invalid extension.`);
  }
  if (
    value.description !== undefined &&
    (typeof value.description !== 'string' ||
      value.description.trim().length === 0 ||
      countCodePoints(value.description) > 1_024)
  ) {
    throw new TypeError(`File Skill script ${id} has an invalid description.`);
  }

  return Object.freeze({
    ...resource,
    extension,
    ...(value.description === undefined ? {} : { description: value.description }),
  });
}

function sortedMap<T>(values: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  return new Map([...values].sort(([left], [right]) => compareSkillStrings(left, right)));
}

function freezeDiagnostic(
  sourceIndex: number,
  reason: AgentSkillSourceDiagnosticReason,
): AgentSkillSourceDiagnostic {
  return Object.freeze({ sourceIndex, reason });
}

function dispatchError(code: SkillDispatchErrorCode, message: string): SkillDispatchErrorResult {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code, message }),
  });
}

function commandUsage(command: 'read' | 'run' | undefined): string {
  if (command === 'read') return 'Invalid skill arguments. Usage: read <resource-id>.';
  if (command === 'run') {
    return 'Invalid skill arguments. Usage: run <script-id> [args...].';
  }
  return 'Invalid skill arguments. Usage: load [arguments] | read <resource-id> | run <script-id> [args...].';
}
