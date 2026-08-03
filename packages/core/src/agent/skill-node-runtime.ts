/** Node capability 缺失的内部诊断原因。 */
export type SkillNodeCapabilityUnavailableReason =
  | 'node_unavailable'
  | 'builtin_module_unavailable'
  | 'permission_denied';

/** 单层 Node capability 的只读诊断。 */
export type SkillNodeCapabilityDiagnostic =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: SkillNodeCapabilityUnavailableReason;
    };

/** 文件状态的最小、运行时无关表示。 */
export interface SkillFileStatus {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/** 目录项的最小、运行时无关表示。 */
export interface SkillDirectoryEntry extends SkillFileStatus {
  readonly name: string;
}

/** File Skill 初始化、lazy read 和 file run 共同使用的同步能力。 */
export interface SkillFileCapabilities {
  readonly separator: string;
  cwd(): string;
  resolve(...parts: readonly string[]): string;
  join(...parts: readonly string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  extname(path: string): string;
  hasReadPermission(path: string): boolean | undefined;
  accessRead(path: string): void;
  lstat(path: string): SkillFileStatus;
  stat(path: string): SkillFileStatus;
  realpath(path: string): string;
  readFile(path: string): Uint8Array;
  readdir(path: string): readonly SkillDirectoryEntry[];
}

/** 子进程 stdout/stderr 的最小事件接口。 */
export interface SkillReadableOutput {
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

/** 脚本子进程的最小事件接口。 */
export interface SkillChildProcess {
  readonly stdout?: SkillReadableOutput | null;
  readonly stderr?: SkillReadableOutput | null;
  once(event: 'error', listener: (error: unknown) => void): unknown;
  once(event: 'close', listener: (exitCode: number | null, signal: string | null) => void): unknown;
}

/** Skill 脚本启动时固定使用的选项。 */
export interface SkillSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly shell: false;
  readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
}

/** PATH/executable 解析与无 Shell 子进程启动能力。 */
export interface SkillProcessCapabilities {
  readonly platform: string;
  readonly execPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  resolveExecutable(command: string): string | undefined;
  isExecutable(path: string): boolean;
  spawn(command: string, args: readonly string[], options: SkillSpawnOptions): SkillChildProcess;
}

/** Inline Skill 临时物化所需的最小写能力。 */
export interface SkillTemporaryFileCapabilities {
  readonly tempRoot: string;
  join(...parts: readonly string[]): string;
  dirname(path: string): string;
  makeTempDirectory(prefix: string): string;
  /** 单层、独占创建目录；已存在（包括 Unicode/case alias）时必须失败。 */
  makeDirectory(path: string): void;
  /** 使用 exclusive-create（`wx`）写入，绝不覆盖已有文件。 */
  writeFileExclusive(path: string, data: string | Uint8Array): void;
  /** best-effort cleanup 的底层精确删除操作；是否吞错由调用方决定。 */
  removeTree(path: string): void;
}

/** Skill 子系统一次性捕获的 Node 能力快照。 */
export interface SkillNodeCapabilities {
  readonly files?: SkillFileCapabilities;
  readonly processes?: SkillProcessCapabilities;
  readonly temporaryFiles?: SkillTemporaryFileCapabilities;
  readonly diagnostics: {
    readonly files: SkillNodeCapabilityDiagnostic;
    readonly processes: SkillNodeCapabilityDiagnostic;
    readonly temporaryFiles: SkillNodeCapabilityDiagnostic;
  };
}

/** 测试可注入的唯一宿主入口；生产代码省略它并读取 `globalThis.process`。 */
export interface SkillNodeRuntimeAdapter {
  readonly process: unknown;
}

interface ProcessLike {
  readonly release: { readonly name: string };
  readonly versions: { readonly node: string };
  readonly getBuiltinModule: (id: string) => unknown;
  readonly cwd: () => string;
  readonly execPath: string;
  readonly env: Record<string, string | undefined>;
  readonly platform: string;
  readonly permission?: {
    readonly has: (scope: string, reference?: string) => boolean;
  };
}

interface FileSystemLike {
  readonly constants?: { readonly R_OK?: number; readonly X_OK?: number };
  readonly accessSync: (path: string, mode?: number) => void;
  readonly lstatSync: (path: string) => unknown;
  readonly statSync: (path: string) => unknown;
  readonly realpathSync: (path: string) => unknown;
  readonly readFileSync: (path: string) => unknown;
  readonly readdirSync: (path: string, options: { readonly withFileTypes: true }) => unknown;
  readonly mkdtempSync?: (prefix: string) => unknown;
  readonly mkdirSync?: (path: string) => unknown;
  readonly writeFileSync?: (
    path: string,
    data: string | Uint8Array,
    options: { readonly flag: 'wx' },
  ) => unknown;
  readonly rmSync?: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => unknown;
}

interface PathLike {
  readonly sep: string;
  readonly delimiter: string;
  readonly resolve: (...parts: readonly string[]) => string;
  readonly join: (...parts: readonly string[]) => string;
  readonly dirname: (path: string) => string;
  readonly basename: (path: string) => string;
  readonly relative: (from: string, to: string) => string;
  readonly isAbsolute: (path: string) => boolean;
  readonly extname: (path: string) => string;
}

interface OsLike {
  readonly tmpdir: () => string;
}

interface ChildProcessLike {
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string | undefined>>;
      readonly shell: false;
      readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
    },
  ) => unknown;
}

const AVAILABLE_DIAGNOSTIC: SkillNodeCapabilityDiagnostic = Object.freeze({ available: true });

/** 读取真实宿主并生成一次能力快照。 */
export function getSkillNodeCapabilities(): SkillNodeCapabilities {
  return createSkillNodeCapabilities();
}

/**
 * 生成一次能力快照。测试通过 adapter 注入 fake process/builtin modules，避免修改全局。
 */
export function createSkillNodeCapabilities(
  adapter?: SkillNodeRuntimeAdapter,
): SkillNodeCapabilities {
  const processValue = adapter === undefined ? Reflect.get(globalThis, 'process') : adapter.process;

  if (!isNodeRuntimeIdentity(processValue)) {
    return unavailableSnapshot('node_unavailable');
  }

  const processLike = asNodeProcess(processValue);

  if (!processLike) return unavailableSnapshot('builtin_module_unavailable');

  const fs = asFileSystem(safeGetBuiltin(processLike, 'fs'));
  const path = asPath(safeGetBuiltin(processLike, 'path'));
  const os = asOs(safeGetBuiltin(processLike, 'os'));
  const childProcess = asChildProcess(safeGetBuiltin(processLike, 'child_process'));
  const files = fs && path ? createFileCapabilities(processLike, fs, path) : undefined;
  const childPermission = queryPermission(processLike, 'child');
  const processes =
    fs && path && childProcess && childPermission !== false
      ? createProcessCapabilities(processLike, fs, path, childProcess)
      : undefined;
  let temporaryFiles: SkillTemporaryFileCapabilities | undefined;
  let temporaryReason: SkillNodeCapabilityUnavailableReason = 'builtin_module_unavailable';

  if (fs && path && os && hasTemporaryMethods(fs)) {
    try {
      const tempRoot = os.tmpdir();

      if (typeof tempRoot === 'string' && tempRoot.length > 0) {
        if (queryPermission(processLike, 'fs.write', tempRoot) === false) {
          temporaryReason = 'permission_denied';
        } else {
          temporaryFiles = createTemporaryFileCapabilities(fs, path, tempRoot);
        }
      }
    } catch {
      // tmpdir 本身不可用时按缺少 temporary-file capability 安全降级。
    }
  }

  return freezeSnapshot({
    ...(files ? { files } : {}),
    ...(processes ? { processes } : {}),
    ...(temporaryFiles ? { temporaryFiles } : {}),
    diagnostics: {
      files: files ? AVAILABLE_DIAGNOSTIC : unavailableDiagnostic('builtin_module_unavailable'),
      processes: processes
        ? AVAILABLE_DIAGNOSTIC
        : unavailableDiagnostic(
            childPermission === false ? 'permission_denied' : 'builtin_module_unavailable',
          ),
      temporaryFiles: temporaryFiles
        ? AVAILABLE_DIAGNOSTIC
        : unavailableDiagnostic(temporaryReason),
    },
  });
}

/** Node/文件权限错误的共享、跨平台判定。 */
export function isSkillAccessDeniedError(error: unknown): boolean {
  const code = readErrorCode(error);

  return code === 'EACCES' || code === 'EPERM' || code === 'ERR_ACCESS_DENIED';
}

/** 初始化后目录项并发消失或类型路径失效的稳定判定。 */
export function isSkillPathRaceError(error: unknown): boolean {
  const code = readErrorCode(error);

  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP';
}

function asNodeProcess(value: unknown): ProcessLike | undefined {
  if (!isRecord(value)) return undefined;
  const release = Reflect.get(value, 'release');
  const versions = Reflect.get(value, 'versions');
  const getBuiltinModule = Reflect.get(value, 'getBuiltinModule');
  const cwd = Reflect.get(value, 'cwd');
  const execPath = Reflect.get(value, 'execPath');
  const env = Reflect.get(value, 'env');
  const platform = Reflect.get(value, 'platform');

  if (
    !isRecord(release) ||
    Reflect.get(release, 'name') !== 'node' ||
    !isRecord(versions) ||
    typeof Reflect.get(versions, 'node') !== 'string' ||
    typeof getBuiltinModule !== 'function' ||
    typeof cwd !== 'function' ||
    typeof execPath !== 'string' ||
    !isRecord(env) ||
    typeof platform !== 'string'
  ) {
    return undefined;
  }

  const permissionValue = Reflect.get(value, 'permission');
  const permission =
    isRecord(permissionValue) && typeof Reflect.get(permissionValue, 'has') === 'function'
      ? {
          has: (
            Reflect.get(permissionValue, 'has') as (...args: readonly unknown[]) => unknown
          ).bind(permissionValue) as (scope: string, reference?: string) => boolean,
        }
      : undefined;

  return {
    release: { name: 'node' },
    versions: { node: Reflect.get(versions, 'node') as string },
    getBuiltinModule: (getBuiltinModule as (id: string) => unknown).bind(value),
    cwd: (cwd as () => string).bind(value),
    execPath,
    env: env as Record<string, string | undefined>,
    platform,
    ...(permission ? { permission } : {}),
  };
}

function isNodeRuntimeIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const release = Reflect.get(value, 'release');
  const versions = Reflect.get(value, 'versions');

  return (
    isRecord(release) &&
    Reflect.get(release, 'name') === 'node' &&
    isRecord(versions) &&
    typeof Reflect.get(versions, 'node') === 'string'
  );
}

function safeGetBuiltin(processLike: ProcessLike, id: string): unknown {
  try {
    return processLike.getBuiltinModule(id);
  } catch {
    return undefined;
  }
}

function asFileSystem(value: unknown): FileSystemLike | undefined {
  if (!isRecord(value)) return undefined;
  const required = [
    'accessSync',
    'lstatSync',
    'statSync',
    'realpathSync',
    'readFileSync',
    'readdirSync',
  ] as const;

  if (required.some((name) => typeof Reflect.get(value, name) !== 'function')) return undefined;

  return value as unknown as FileSystemLike;
}

function asPath(value: unknown): PathLike | undefined {
  if (!isRecord(value)) return undefined;
  const required = [
    'resolve',
    'join',
    'dirname',
    'basename',
    'relative',
    'isAbsolute',
    'extname',
  ] as const;

  if (
    required.some((name) => typeof Reflect.get(value, name) !== 'function') ||
    typeof Reflect.get(value, 'sep') !== 'string' ||
    typeof Reflect.get(value, 'delimiter') !== 'string'
  ) {
    return undefined;
  }

  return value as unknown as PathLike;
}

function asOs(value: unknown): OsLike | undefined {
  return isRecord(value) && typeof Reflect.get(value, 'tmpdir') === 'function'
    ? (value as unknown as OsLike)
    : undefined;
}

function asChildProcess(value: unknown): ChildProcessLike | undefined {
  return isRecord(value) && typeof Reflect.get(value, 'spawn') === 'function'
    ? (value as unknown as ChildProcessLike)
    : undefined;
}

function hasTemporaryMethods(fs: FileSystemLike): boolean {
  return (
    typeof fs.mkdtempSync === 'function' &&
    typeof fs.mkdirSync === 'function' &&
    typeof fs.writeFileSync === 'function' &&
    typeof fs.rmSync === 'function'
  );
}

function createFileCapabilities(
  processLike: ProcessLike,
  fs: FileSystemLike,
  path: PathLike,
): SkillFileCapabilities {
  return Object.freeze({
    separator: path.sep,
    cwd: () => requireString(processLike.cwd(), 'process.cwd'),
    resolve: (...parts: readonly string[]) => path.resolve(...parts),
    join: (...parts: readonly string[]) => path.join(...parts),
    dirname: (value: string) => path.dirname(value),
    basename: (value: string) => path.basename(value),
    relative: (from: string, to: string) => path.relative(from, to),
    isAbsolute: (value: string) => path.isAbsolute(value),
    extname: (value: string) => path.extname(value),
    hasReadPermission: (value: string) => queryPermission(processLike, 'fs.read', value),
    accessRead: (value: string) => fs.accessSync(value, fs.constants?.R_OK ?? 4),
    lstat: (value: string) => normalizeFileStatus(fs.lstatSync(value)),
    stat: (value: string) => normalizeFileStatus(fs.statSync(value)),
    realpath: (value: string) => requireString(fs.realpathSync(value), 'realpathSync'),
    readFile: (value: string) => normalizeBytes(fs.readFileSync(value)),
    readdir: (value: string) =>
      normalizeDirectoryEntries(fs.readdirSync(value, { withFileTypes: true })),
  });
}

function createProcessCapabilities(
  processLike: ProcessLike,
  fs: FileSystemLike,
  path: PathLike,
  childProcess: ChildProcessLike,
): SkillProcessCapabilities {
  const isWindows = processLike.platform === 'win32';
  const environment = Object.freeze({ ...processLike.env });
  const capabilities: SkillProcessCapabilities = {
    platform: processLike.platform,
    execPath: processLike.execPath,
    env: environment,
    resolveExecutable(command: string): string | undefined {
      if (path.isAbsolute(command)) {
        return capabilities.isExecutable(command) ? path.resolve(command) : undefined;
      }

      if (command.length === 0 || path.basename(command) !== command) return undefined;
      const pathValue = readEnvironmentValue(environment, 'PATH', isWindows);

      if (!pathValue) return undefined;
      const suffixes = executableSuffixes(command, environment, path, isWindows);

      for (const directory of pathValue.split(path.delimiter)) {
        if (directory.length === 0) continue;

        for (const suffix of suffixes) {
          const candidate = path.resolve(directory, `${command}${suffix}`);

          try {
            if (capabilities.isExecutable(candidate)) return candidate;
          } catch (error) {
            if (isSkillAccessDeniedError(error)) throw error;
            if (!isMissingExecutableError(error)) throw error;
          }
        }
      }

      return undefined;
    },
    isExecutable(value: string): boolean {
      const extension = path.extname(value).toLowerCase();

      // Windows capability is intentionally narrower than shell semantics: .cmd/.bat are scripts.
      if (isWindows && extension !== '.exe' && extension !== '.com') return false;

      let status: SkillFileStatus;

      try {
        status = normalizeFileStatus(fs.statSync(value));
      } catch (error) {
        if (isMissingExecutableError(error)) return false;
        throw error;
      }

      if (!status.isFile) return false;

      if (isWindows) return true;

      try {
        fs.accessSync(value, fs.constants?.X_OK ?? 1);
        return true;
      } catch (error) {
        if (isMissingExecutableError(error)) return false;
        throw error;
      }
    },
    spawn(command, args, options): SkillChildProcess {
      const child = childProcess.spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (!isRecord(child) || typeof Reflect.get(child, 'once') !== 'function') {
        throw new TypeError('child_process.spawn() did not return a child process.');
      }

      return child as unknown as SkillChildProcess;
    },
  };

  return Object.freeze(capabilities);
}

function createTemporaryFileCapabilities(
  fs: FileSystemLike,
  path: PathLike,
  tempRoot: string,
): SkillTemporaryFileCapabilities {
  const mkdtempSync = fs.mkdtempSync as NonNullable<FileSystemLike['mkdtempSync']>;
  const mkdirSync = fs.mkdirSync as NonNullable<FileSystemLike['mkdirSync']>;
  const writeFileSync = fs.writeFileSync as NonNullable<FileSystemLike['writeFileSync']>;
  const rmSync = fs.rmSync as NonNullable<FileSystemLike['rmSync']>;

  return Object.freeze({
    tempRoot,
    join: (...parts: readonly string[]) => path.join(...parts),
    dirname: (value: string) => path.dirname(value),
    makeTempDirectory: (prefix: string) =>
      requireString(mkdtempSync(path.join(tempRoot, prefix)), 'mkdtempSync'),
    makeDirectory: (value: string) => {
      mkdirSync(value);
    },
    writeFileExclusive: (value: string, data: string | Uint8Array) => {
      writeFileSync(value, data, { flag: 'wx' });
    },
    removeTree: (value: string) => {
      rmSync(value, { recursive: true, force: true });
    },
  });
}

function executableSuffixes(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  path: PathLike,
  isWindows: boolean,
): readonly string[] {
  if (!isWindows) return [''];
  const extension = path.extname(command).toLowerCase();

  if (extension.length > 0) return extension === '.exe' || extension === '.com' ? [''] : [];
  const pathExtensions = readEnvironmentValue(env, 'PATHEXT', true)
    ?.split(';')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value === '.exe' || value === '.com');
  const unique = [...new Set(pathExtensions?.length ? pathExtensions : ['.exe', '.com'])];

  return unique;
}

function normalizeFileStatus(value: unknown): SkillFileStatus {
  if (!isRecord(value)) throw new TypeError('Node fs returned an invalid file status.');
  const isFile = Reflect.get(value, 'isFile');
  const isDirectory = Reflect.get(value, 'isDirectory');
  const isSymbolicLink = Reflect.get(value, 'isSymbolicLink');

  if (
    typeof isFile !== 'function' ||
    typeof isDirectory !== 'function' ||
    typeof isSymbolicLink !== 'function'
  ) {
    throw new TypeError('Node fs returned an invalid file status.');
  }

  return Object.freeze({
    isFile: Boolean(isFile.call(value)),
    isDirectory: Boolean(isDirectory.call(value)),
    isSymbolicLink: Boolean(isSymbolicLink.call(value)),
  });
}

function normalizeDirectoryEntries(value: unknown): readonly SkillDirectoryEntry[] {
  if (!Array.isArray(value)) throw new TypeError('Node fs returned an invalid directory listing.');

  return Object.freeze(
    value.map((entry) => {
      if (!isRecord(entry) || typeof Reflect.get(entry, 'name') !== 'string') {
        throw new TypeError('Node fs returned an invalid directory entry.');
      }

      return Object.freeze({
        name: Reflect.get(entry, 'name') as string,
        ...normalizeFileStatus(entry),
      });
    }),
  );
}

function normalizeBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError('Node fs.readFileSync() did not return bytes.');
}

function queryPermission(
  processLike: ProcessLike,
  scope: string,
  reference?: string,
): boolean | undefined {
  if (!processLike.permission) return undefined;

  try {
    return reference === undefined
      ? processLike.permission.has(scope)
      : processLike.permission.has(scope, reference);
  } catch {
    return undefined;
  }
}

function readEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  caseInsensitive: boolean,
): string | undefined {
  if (!caseInsensitive) return env[key];
  const matched = Object.keys(env).find((candidate) => candidate.toUpperCase() === key);

  return matched === undefined ? undefined : env[matched];
}

function readErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;
}

function isMissingExecutableError(error: unknown): boolean {
  const code = readErrorCode(error);

  return code === 'ENOENT' || code === 'ENOTDIR';
}

function requireString(value: unknown, operation: string): string {
  if (typeof value !== 'string') throw new TypeError(`${operation} did not return a string.`);
  return value;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function unavailableDiagnostic(
  reason: SkillNodeCapabilityUnavailableReason,
): SkillNodeCapabilityDiagnostic {
  return Object.freeze({ available: false, reason });
}

function unavailableSnapshot(reason: SkillNodeCapabilityUnavailableReason): SkillNodeCapabilities {
  const diagnostic = unavailableDiagnostic(reason);

  return Object.freeze({
    diagnostics: Object.freeze({
      files: diagnostic,
      processes: diagnostic,
      temporaryFiles: diagnostic,
    }),
  });
}

function freezeSnapshot(input: SkillNodeCapabilities): SkillNodeCapabilities {
  return Object.freeze({
    ...(input.files ? { files: input.files } : {}),
    ...(input.processes ? { processes: input.processes } : {}),
    ...(input.temporaryFiles ? { temporaryFiles: input.temporaryFiles } : {}),
    diagnostics: Object.freeze(input.diagnostics),
  });
}
