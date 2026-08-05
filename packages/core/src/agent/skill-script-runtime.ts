import { stringify as stringifyYaml } from 'yaml';

import type {
  SkillRuntimeOptions,
  SkillScriptExecutionResult,
  SkillScriptExecutor,
  SkillScriptExecutorMap,
} from './types';
import { revalidateFileSkillEntry } from './skill-file-source';
import {
  getSkillNodeCapabilities,
  type SkillChildProcess,
  type SkillNodeCapabilities,
  type SkillProcessCapabilities,
  type SkillReadableOutput,
  type SkillTemporaryFileCapabilities,
} from './skill-node-runtime';
import {
  SkillRuntimeError,
  type ResolvedSkill,
  type ResolvedSkillScript,
  type SkillRuntimeErrorStage,
} from './skill-registry-types';

const extensionPattern = /^\.[a-z0-9]+$/i;
const nulCharacter = '\0';

/** File Skill source 缺省使用的文本资源后缀白名单。 */
export const DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS = Object.freeze([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.xml',
] as const);

/** Immutable runtime configuration produced during `Agent.init()`. */
export interface ResolvedSkillRuntimeOptions {
  readonly compactResult: boolean;
  readonly resourceExtensions: readonly string[];
  readonly scriptExecutors: ReadonlyMap<string, SkillScriptExecutor>;
}

/**
 * Validate Skill runtime configuration and resolve every executable once.
 *
 * A missing process capability does not make otherwise valid configuration fail;
 * it produces an empty executor map so inline/file load and read remain usable.
 */
export function resolveSkillRuntimeOptions(
  input?: SkillRuntimeOptions,
  capabilities: SkillNodeCapabilities = getSkillNodeCapabilities(),
): ResolvedSkillRuntimeOptions {
  if (input !== undefined && !isPlainObject(input)) {
    throw new TypeError('skillRuntime must be a non-null object.');
  }

  const configuration = input as SkillRuntimeOptions | undefined;
  const compactResult = configuration ? (readOwn(configuration, 'compactResult') ?? false) : false;

  if (typeof compactResult !== 'boolean') {
    throw new TypeError('skillRuntime.compactResult must be a boolean.');
  }

  const resourceExtensions = resolveResourceExtensions(
    configuration ? readOwn(configuration, 'resourceExtensions') : undefined,
  );
  const scriptExecutors = resolveConfiguredExecutors(
    configuration ? readOwn(configuration, 'scripts') : undefined,
    capabilities.processes,
  );

  return Object.freeze({
    compactResult,
    resourceExtensions,
    scriptExecutors: immutableMap(scriptExecutors),
  });
}

/** 检测宿主机支持的执行器；返回深度独立的可修改 map，不会改变 Agent 配置。 */
export function detectSkillScriptExecutors(): Record<string, SkillScriptExecutor> {
  const processes = getSkillNodeCapabilities().processes;

  if (!processes) {
    return {};
  }

  return executorMapToRecord(detectExecutors(processes));
}

/** Internal deterministic detector entry point used by injected-capability tests. */
export function detectSkillScriptExecutorsFromCapabilities(
  processes: SkillProcessCapabilities | undefined,
): Record<string, SkillScriptExecutor> {
  return processes ? executorMapToRecord(detectExecutors(processes)) : {};
}

/** Executes resolved file and inline scripts using one immutable capability snapshot. */
export class SkillScriptRuntime {
  readonly #options: ResolvedSkillRuntimeOptions;
  readonly #capabilities: SkillNodeCapabilities;

  constructor(
    options: ResolvedSkillRuntimeOptions,
    capabilities: SkillNodeCapabilities = getSkillNodeCapabilities(),
  ) {
    this.#options = options;
    this.#capabilities = capabilities;
  }

  isAvailable(_skill: ResolvedSkill, script: ResolvedSkillScript): boolean {
    if (!this.#options.scriptExecutors.has(script.extension.toLowerCase())) {
      return false;
    }

    if (!this.#capabilities.processes) {
      return false;
    }

    return script.source === 'inline'
      ? this.#capabilities.temporaryFiles !== undefined
      : this.#capabilities.files !== undefined;
  }

  async run(
    skill: ResolvedSkill,
    scriptId: string,
    script: ResolvedSkillScript,
    argv: readonly string[],
  ): Promise<SkillScriptExecutionResult> {
    const executor = this.#options.scriptExecutors.get(script.extension.toLowerCase());
    const processes = this.#capabilities.processes;

    if (!executor || !processes) {
      throw runtimeError('spawn', skill, scriptId, new Error('Script execution is unavailable.'));
    }

    if (script.source === 'file') {
      return this.#runFileScript(skill, scriptId, script, argv, executor, processes);
    }

    return this.#runInlineScript(skill, scriptId, script, argv, executor, processes);
  }

  async #runFileScript(
    skill: ResolvedSkill,
    scriptId: string,
    script: Extract<ResolvedSkillScript, { source: 'file' }>,
    argv: readonly string[],
    executor: SkillScriptExecutor,
    processes: SkillProcessCapabilities,
  ): Promise<SkillScriptExecutionResult> {
    const files = this.#capabilities.files;
    if (!files) {
      throw runtimeError(
        'file-validation',
        skill,
        scriptId,
        new Error('File execution capability is unavailable.'),
      );
    }

    let scriptPath: string;

    try {
      scriptPath = revalidateFileSkillEntry(
        files,
        script,
        'script',
        skill.descriptor.name,
        scriptId,
      );
    } catch (error) {
      if (error instanceof SkillRuntimeError) {
        throw error;
      }

      throw runtimeError('file-validation', skill, scriptId, error);
    }

    return spawnScript({
      executor,
      processes,
      scriptPath,
      argv,
      cwd: script.rootRealPath,
      skill,
      scriptId,
    });
  }

  async #runInlineScript(
    skill: ResolvedSkill,
    scriptId: string,
    script: Extract<ResolvedSkillScript, { source: 'inline' }>,
    argv: readonly string[],
    executor: SkillScriptExecutor,
    processes: SkillProcessCapabilities,
  ): Promise<SkillScriptExecutionResult> {
    const temporaryFiles = this.#capabilities.temporaryFiles;

    if (!temporaryFiles) {
      throw runtimeError(
        'materialization',
        skill,
        scriptId,
        new Error('Temporary-file capability is unavailable.'),
      );
    }

    let temporaryDirectory: string | undefined;

    try {
      temporaryDirectory = temporaryFiles.makeTempDirectory('manee-skill-');
      const materialized = materializeInlineSkill(skill, temporaryDirectory, temporaryFiles);
      const scriptPath = materialized.scriptPaths.get(scriptId);

      if (!scriptPath) {
        throw new Error('The selected inline script was not materialized.');
      }

      return await spawnScript({
        executor,
        processes,
        scriptPath,
        argv,
        cwd: materialized.skillRoot,
        skill,
        scriptId,
      });
    } catch (error) {
      if (error instanceof SkillRuntimeError) {
        throw error;
      }

      throw runtimeError('materialization', skill, scriptId, error);
    } finally {
      if (temporaryDirectory !== undefined) {
        try {
          temporaryFiles.removeTree(temporaryDirectory);
        } catch {
          // Cleanup is deliberately best-effort and must not replace a script result/error.
        }
      }
    }
  }
}

function resolveResourceExtensions(input: unknown): readonly string[] {
  if (input === undefined) {
    return DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS;
  }

  if (!Array.isArray(input)) {
    throw new TypeError('skillRuntime.resourceExtensions must be an array.');
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const extension of input) {
    if (typeof extension !== 'string' || !extensionPattern.test(extension)) {
      throw new TypeError(
        'skillRuntime.resourceExtensions entries must be single file extensions.',
      );
    }

    const key = extension.toLowerCase();

    if (seen.has(key)) {
      throw new TypeError(`Duplicate Skill resource extension: ${key}`);
    }

    seen.add(key);
    normalized.push(key);
  }

  return Object.freeze(normalized);
}

function resolveConfiguredExecutors(
  input: unknown,
  processes: SkillProcessCapabilities | undefined,
): Map<string, SkillScriptExecutor> {
  if (input === undefined || input === false) {
    return new Map();
  }

  if (!isPlainObject(input)) {
    throw new TypeError('skillRuntime.scripts must be false or a non-null object.');
  }

  const autoDetect = readOwn(input, 'autoDetect') ?? false;

  if (typeof autoDetect !== 'boolean') {
    throw new TypeError('skillRuntime.scripts.autoDetect must be a boolean.');
  }

  const configuredExecutors = readOwn(input, 'executors');

  if (configuredExecutors !== undefined && !isPlainObject(configuredExecutors)) {
    throw new TypeError('skillRuntime.scripts.executors must be a non-null object.');
  }

  const manual = validateManualExecutors(configuredExecutors as SkillScriptExecutorMap | undefined);

  if (!processes) {
    return new Map();
  }

  const resolved = autoDetect ? detectExecutors(processes) : new Map<string, SkillScriptExecutor>();

  for (const [extension, value] of manual) {
    if (value === false) {
      resolved.delete(extension);
      continue;
    }

    let command: string | undefined;

    try {
      command = processes.resolveExecutable(value.command);
    } catch (error) {
      throw new TypeError(`Unable to resolve configured Skill script executor for ${extension}.`, {
        cause: error,
      });
    }

    if (!command) {
      throw new TypeError(`Configured Skill script executor is unavailable for ${extension}.`);
    }

    resolved.set(
      extension,
      freezeExecutor({
        command,
        ...(value.commandArgs === undefined ? {} : { commandArgs: value.commandArgs }),
      }),
    );
  }

  return sortExecutorMap(resolved);
}

function validateManualExecutors(
  input: SkillScriptExecutorMap | undefined,
): Map<string, SkillScriptExecutor | false> {
  const result = new Map<string, SkillScriptExecutor | false>();

  if (input === undefined) {
    return result;
  }

  for (const rawExtension of Object.keys(input)) {
    if (!extensionPattern.test(rawExtension)) {
      throw new TypeError(`Invalid Skill script executor extension: ${rawExtension}`);
    }

    const extension = rawExtension.toLowerCase();

    if (result.has(extension)) {
      throw new TypeError(`Duplicate Skill script executor extension: ${extension}`);
    }

    const value = input[rawExtension];

    if (value === false) {
      result.set(extension, false);
      continue;
    }

    if (!isPlainObject(value)) {
      throw new TypeError(`Skill script executor ${rawExtension} must be false or an object.`);
    }

    const command = readOwn(value, 'command');

    if (
      typeof command !== 'string' ||
      command.trim().length === 0 ||
      command.includes(nulCharacter)
    ) {
      throw new TypeError(`Skill script executor ${rawExtension}.command is invalid.`);
    }

    if (!isAbsoluteCommand(command) && (command.includes('/') || command.includes('\\'))) {
      throw new TypeError(
        `Skill script executor ${rawExtension}.command must be absolute or a PATH command name.`,
      );
    }

    const rawCommandArgs = readOwn(value, 'commandArgs');

    if (rawCommandArgs !== undefined && !Array.isArray(rawCommandArgs)) {
      throw new TypeError(`Skill script executor ${rawExtension}.commandArgs must be an array.`);
    }

    const commandArgs = rawCommandArgs?.map((argument) => {
      if (typeof argument !== 'string' || argument.includes(nulCharacter)) {
        throw new TypeError(
          `Skill script executor ${rawExtension}.commandArgs entries must be strings without NUL.`,
        );
      }

      return argument;
    });

    result.set(
      extension,
      freezeExecutor({
        command,
        ...(commandArgs === undefined ? {} : { commandArgs }),
      }),
    );
  }

  return result;
}

function detectExecutors(processes: SkillProcessCapabilities): Map<string, SkillScriptExecutor> {
  const detected = new Map<string, SkillScriptExecutor>();
  const nodeExecutor = freezeExecutor({ command: processes.execPath });

  addExtensions(detected, ['.js', '.mjs', '.cjs'], nodeExecutor);

  const typescript = resolveFirstCandidate(processes, [
    { command: 'tsx' },
    { command: 'bun' },
    { command: 'deno', commandArgs: ['run'] },
  ]);

  if (typescript) {
    addExtensions(detected, ['.ts', '.mts', '.cts', '.tsx', '.jsx'], typescript);
  }

  const python = resolveFirstCandidate(processes, [{ command: 'python3' }, { command: 'python' }]);

  if (python) {
    detected.set('.py', python);
  }

  const shell = resolveFirstCandidate(processes, [{ command: 'bash' }, { command: 'sh' }]);

  if (shell) {
    detected.set('.sh', shell);
  }

  const powershell = resolveFirstCandidate(processes, [
    { command: 'pwsh', commandArgs: ['-File'] },
    { command: 'powershell', commandArgs: ['-File'] },
  ]);

  if (powershell) {
    detected.set('.ps1', powershell);
  }

  for (const [extension, command] of [
    ['.rb', 'ruby'],
    ['.php', 'php'],
  ] as const) {
    const executor = resolveFirstCandidate(processes, [{ command }]);

    if (executor) {
      detected.set(extension, executor);
    }
  }

  return sortExecutorMap(detected);
}

function resolveFirstCandidate(
  processes: SkillProcessCapabilities,
  candidates: readonly SkillScriptExecutor[],
): SkillScriptExecutor | undefined {
  for (const candidate of candidates) {
    try {
      const command = processes.resolveExecutable(candidate.command);

      if (command) {
        return freezeExecutor({
          command,
          ...(candidate.commandArgs === undefined ? {} : { commandArgs: candidate.commandArgs }),
        });
      }
    } catch {
      // Auto detection is best-effort; inaccessible candidates are simply absent.
    }
  }

  return undefined;
}

function addExtensions(
  target: Map<string, SkillScriptExecutor>,
  extensions: readonly string[],
  executor: SkillScriptExecutor,
): void {
  for (const extension of extensions) {
    target.set(extension, executor);
  }
}

function materializeInlineSkill(
  skill: ResolvedSkill,
  temporaryDirectory: string,
  temporaryFiles: SkillTemporaryFileCapabilities,
): { readonly skillRoot: string; readonly scriptPaths: ReadonlyMap<string, string> } {
  const skillRoot = temporaryFiles.join(temporaryDirectory, skill.descriptor.name);
  temporaryFiles.makeDirectory(skillRoot);
  temporaryFiles.writeFileExclusive(
    temporaryFiles.join(skillRoot, 'SKILL.md'),
    renderInlineSkillMarkdown(skill),
  );

  const entries: Array<{
    readonly id: string;
    readonly content: string;
    readonly script: boolean;
  }> = [];

  for (const [id, resource] of skill.resources) {
    if (resource.source !== 'inline') {
      throw new Error('An inline Skill cannot materialize a file-backed resource.');
    }

    entries.push({ id, content: resource.content, script: false });
  }

  for (const [id, script] of skill.scripts) {
    if (script.source !== 'inline') {
      throw new Error('An inline Skill cannot materialize a file-backed script.');
    }

    entries.push({ id, content: script.content, script: true });
  }

  entries.sort((left, right) => compareCodeUnits(left.id, right.id));
  const createdDirectories = new Set<string>([skillRoot]);
  const scriptPaths = new Map<string, string>();

  for (const entry of entries) {
    const path = temporaryFiles.join(skillRoot, ...entry.id.split('/'));
    ensureMaterializedDirectory(temporaryFiles.dirname(path), temporaryFiles, createdDirectories);
    temporaryFiles.writeFileExclusive(path, entry.content);

    if (entry.script) {
      scriptPaths.set(entry.id, path);
    }
  }

  return {
    skillRoot,
    scriptPaths: immutableMap(scriptPaths),
  };
}

function ensureMaterializedDirectory(
  path: string,
  temporaryFiles: SkillTemporaryFileCapabilities,
  created: Set<string>,
): void {
  if (created.has(path)) {
    return;
  }

  const parent = temporaryFiles.dirname(path);

  if (parent !== path && !created.has(parent)) {
    ensureMaterializedDirectory(parent, temporaryFiles, created);
  }

  temporaryFiles.makeDirectory(path);
  created.add(path);
}

function renderInlineSkillMarkdown(skill: ResolvedSkill): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.descriptor.name,
    description: skill.descriptor.description,
  };

  if (skill.sourceMetadata.license !== undefined) {
    frontmatter.license = skill.sourceMetadata.license;
  }

  if (skill.sourceMetadata.compatibility !== undefined) {
    frontmatter.compatibility = skill.sourceMetadata.compatibility;
  }

  if (skill.sourceMetadata.metadata !== undefined) {
    frontmatter.metadata = Object.fromEntries(
      Object.entries(skill.sourceMetadata.metadata).sort(([left], [right]) =>
        compareCodeUnits(left, right),
      ),
    );
  }

  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 });
  const normalizedYaml = yaml.endsWith('\n') ? yaml : `${yaml}\n`;

  return `---\n${normalizedYaml}---\n${skill.instructions}`;
}

async function spawnScript(input: {
  readonly executor: SkillScriptExecutor;
  readonly processes: SkillProcessCapabilities;
  readonly scriptPath: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly skill: ResolvedSkill;
  readonly scriptId: string;
}): Promise<SkillScriptExecutionResult> {
  let child: SkillChildProcess;

  try {
    child = input.processes.spawn(
      input.executor.command,
      [...(input.executor.commandArgs ?? []), input.scriptPath, ...input.argv],
      {
        cwd: input.cwd,
        env: input.processes.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    throw runtimeError('spawn', input.skill, input.scriptId, error);
  }

  try {
    return await collectProcessResult(child);
  } catch (error) {
    if (error instanceof ProcessCollectionError) {
      throw runtimeError(error.stage, input.skill, input.scriptId, error.cause);
    }

    throw runtimeError('communication', input.skill, input.scriptId, error);
  }
}

function collectProcessResult(child: SkillChildProcess): Promise<SkillScriptExecutionResult> {
  return new Promise((resolve, reject) => {
    const stdout = new IncrementalOutput();
    const stderr = new IncrementalOutput();
    let settled = false;

    const fail = (
      stage: Extract<SkillRuntimeErrorStage, 'spawn' | 'communication'>,
      error: unknown,
    ) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new ProcessCollectionError(stage, error));
    };

    attachOutput(child.stdout, stdout, (error) => fail('communication', error));
    attachOutput(child.stderr, stderr, (error) => fail('communication', error));
    child.once('error', (error) => fail('spawn', error));
    child.once('close', (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;

      try {
        resolve(
          Object.freeze({
            exitCode,
            signal,
            stdout: stdout.finish(),
            stderr: stderr.finish(),
          }),
        );
      } catch (error) {
        reject(new ProcessCollectionError('communication', error));
      }
    });
  });
}

function attachOutput(
  output: SkillReadableOutput | null | undefined,
  collector: IncrementalOutput,
  onError: (error: unknown) => void,
): void {
  if (!output) {
    return;
  }

  output.on('data', (chunk) => {
    try {
      collector.push(chunk);
    } catch (error) {
      onError(error);
    }
  });
  output.on('error', onError);
}

class IncrementalOutput {
  readonly #decoder = new TextDecoder();
  readonly #encoder = new TextEncoder();
  #value = '';

  push(chunk: unknown): void {
    const bytes =
      typeof chunk === 'string'
        ? this.#encoder.encode(chunk)
        : chunk instanceof Uint8Array
          ? chunk
          : chunk instanceof ArrayBuffer
            ? new Uint8Array(chunk)
            : this.#encoder.encode(String(chunk));

    this.#value += this.#decoder.decode(bytes, { stream: true });
  }

  finish(): string {
    this.#value += this.#decoder.decode();
    return this.#value;
  }
}

class ProcessCollectionError extends Error {
  readonly stage: Extract<SkillRuntimeErrorStage, 'spawn' | 'communication'>;
  override readonly cause: unknown;

  constructor(stage: Extract<SkillRuntimeErrorStage, 'spawn' | 'communication'>, cause: unknown) {
    super('Skill child process collection failed.', { cause });
    this.name = 'ProcessCollectionError';
    this.stage = stage;
    this.cause = cause;
  }
}

function runtimeError(
  stage: SkillRuntimeErrorStage,
  skill: ResolvedSkill,
  target: string,
  cause: unknown,
): SkillRuntimeError {
  return new SkillRuntimeError(stage, skill.descriptor.name, target, cause);
}

function freezeExecutor(executor: SkillScriptExecutor): SkillScriptExecutor {
  return Object.freeze({
    command: executor.command,
    ...(executor.commandArgs === undefined
      ? {}
      : { commandArgs: Object.freeze([...executor.commandArgs]) }),
  });
}

function executorMapToRecord(
  executors: ReadonlyMap<string, SkillScriptExecutor>,
): Record<string, SkillScriptExecutor> {
  const record: Record<string, SkillScriptExecutor> = {};

  for (const [extension, executor] of executors) {
    record[extension] = {
      command: executor.command,
      ...(executor.commandArgs === undefined ? {} : { commandArgs: [...executor.commandArgs] }),
    };
  }

  return record;
}

function sortExecutorMap(
  input: ReadonlyMap<string, SkillScriptExecutor>,
): Map<string, SkillScriptExecutor> {
  return new Map([...input].sort(([left], [right]) => compareCodeUnits(left, right)));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isAbsoluteCommand(command: string): boolean {
  return (
    command.startsWith('/') ||
    /^[a-z]:[\\/]/i.test(command) ||
    command.startsWith('\\\\') ||
    command.startsWith('//')
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwn(input: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(input, key) ? Reflect.get(input, key) : undefined;
}

function immutableMap<K, V>(input: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  return new ImmutableMap(input);
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(input: ReadonlyMap<K, V>) {
    this.#map = new Map(input);
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }

  keys(): MapIterator<K> {
    return this.#map.keys();
  }

  values(): MapIterator<V> {
    return this.#map.values();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#map) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#map[Symbol.iterator]();
  }
}
