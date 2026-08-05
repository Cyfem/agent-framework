import { posix as path } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  SkillChildProcess,
  SkillFileCapabilities,
  SkillNodeCapabilities,
  SkillProcessCapabilities,
  SkillReadableOutput,
  SkillSpawnOptions,
  SkillTemporaryFileCapabilities,
} from '../src/agent/skill-node-runtime';
import type {
  ResolvedFileSkillScript,
  ResolvedInlineSkillScript,
  ResolvedSkill,
} from '../src/agent/skill-registry-types';
import { SkillRuntimeError } from '../src/agent/skill-registry-types';
import {
  DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS,
  SkillScriptRuntime,
  detectSkillScriptExecutorsFromCapabilities,
  resolveSkillRuntimeOptions,
} from '../src/agent/skill-script-runtime';

const availableDiagnostic = Object.freeze({ available: true as const });
const unavailableDiagnostic = Object.freeze({
  available: false as const,
  reason: 'builtin_module_unavailable' as const,
});

describe('Skill script runtime configuration', () => {
  it('uses frozen defaults while keeping detector results independently mutable', () => {
    const processes = createProcessCapabilities({
      executables: {
        tsx: '/bin/tsx',
        python: '/bin/python',
        sh: '/bin/sh',
        pwsh: '/bin/pwsh',
        ruby: '/bin/ruby',
        php: '/bin/php',
      },
    });
    const options = resolveSkillRuntimeOptions(undefined, capabilitySnapshot({ processes }));
    const first = detectSkillScriptExecutorsFromCapabilities(processes);
    const second = detectSkillScriptExecutorsFromCapabilities(processes);

    expect(options.compactResult).toBe(false);
    expect(options.resourceExtensions).toBe(DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS);
    expect(Object.isFrozen(DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS)).toBe(true);
    expect(options.scriptExecutors.size).toBe(0);
    expect(first['.ts']).toEqual({ command: '/bin/tsx' });
    expect(first['.py']).toEqual({ command: '/bin/python' });
    expect(first['.ps1']).toEqual({ command: '/bin/pwsh', commandArgs: ['-File'] });

    first['.ts'] = { command: '/changed' };
    const firstPythonArgs = first['.ps1']?.commandArgs as string[] | undefined;
    firstPythonArgs?.push('changed');

    expect(second['.ts']).toEqual({ command: '/bin/tsx' });
    expect(second['.ps1']).toEqual({ command: '/bin/pwsh', commandArgs: ['-File'] });
  });

  it('applies manual overrides after auto detection and sorts normalized extensions', () => {
    const processes = createProcessCapabilities({
      executables: {
        tsx: '/auto/tsx',
        python3: '/auto/python3',
        bash: '/auto/bash',
        ruby: '/auto/ruby',
        php: '/auto/php',
        '/manual/python': '/manual/python',
      },
    });
    const resolved = resolveSkillRuntimeOptions(
      {
        compactResult: true,
        resourceExtensions: ['.TXT', '.md'],
        scripts: {
          autoDetect: true,
          executors: {
            '.PY': { command: '/manual/python', commandArgs: ['-I'] },
            '.rb': false,
          },
        },
      },
      capabilitySnapshot({ processes }),
    );

    expect(resolved.compactResult).toBe(true);
    expect(resolved.resourceExtensions).toEqual(['.txt', '.md']);
    expect([...resolved.scriptExecutors.keys()]).toEqual(
      [...resolved.scriptExecutors.keys()].sort(compareCodeUnits),
    );
    expect(resolved.scriptExecutors.get('.py')).toEqual({
      command: '/manual/python',
      commandArgs: ['-I'],
    });
    expect(resolved.scriptExecutors.has('.rb')).toBe(false);
  });

  it('validates every runtime field even when process capability is unavailable', () => {
    const unavailable = capabilitySnapshot({});

    expect(() =>
      resolveSkillRuntimeOptions(
        {
          scripts: {
            executors: {
              '.py': { command: 'python', commandArgs: [''] },
            },
          },
        },
        unavailable,
      ),
    ).not.toThrow();
    expect(
      resolveSkillRuntimeOptions(
        { scripts: { executors: { '.py': { command: 'python' } } } },
        unavailable,
      ).scriptExecutors.size,
    ).toBe(0);

    const invalidCases: unknown[] = [
      null,
      [],
      { compactResult: 1 },
      { resourceExtensions: ['md'] },
      { resourceExtensions: ['.MD', '.md'] },
      { scripts: true },
      { scripts: { autoDetect: 'yes' } },
      { scripts: { executors: [] } },
      { scripts: { executors: { py: { command: 'python' } } } },
      { scripts: { executors: { '.py': { command: '../python' } } } },
      { scripts: { executors: { '.py': { command: 'python\0' } } } },
      { scripts: { executors: { '.py': { command: 'python', commandArgs: [1] } } } },
    ];

    for (const invalid of invalidCases) {
      expect(() => resolveSkillRuntimeOptions(invalid as never, unavailable)).toThrow(TypeError);
    }
  });

  it('treats inaccessible auto candidates as absent and invalid manual commands as errors', () => {
    const denied = Object.assign(new Error('denied /secret/runtime'), { code: 'EACCES' });
    const processes = createProcessCapabilities({
      executables: { python: '/bin/python' },
      resolutionErrors: { python3: denied },
    });

    expect(detectSkillScriptExecutorsFromCapabilities(processes)['.py']).toEqual({
      command: '/bin/python',
    });
    expect(() =>
      resolveSkillRuntimeOptions(
        { scripts: { executors: { '.rb': { command: 'missing-ruby' } } } },
        capabilitySnapshot({ processes }),
      ),
    ).toThrow('unavailable for .rb');
  });

  it('uses bare deno run only after tsx and bun are unavailable', () => {
    const processes = createProcessCapabilities({ executables: { deno: '/bin/deno' } });
    const detected = detectSkillScriptExecutorsFromCapabilities(processes);

    expect(detected['.ts']).toEqual({ command: '/bin/deno', commandArgs: ['run'] });
    expect(detected['.tsx']).toEqual({ command: '/bin/deno', commandArgs: ['run'] });
  });
});

describe('Skill script execution', () => {
  it('spawns file scripts without a shell and returns nonzero output structurally', async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn(() => child);
    const processes = createProcessCapabilities({
      executables: { python: '/bin/python' },
      spawn,
    });
    const files = createFileCapabilities();
    const script: ResolvedFileSkillScript = {
      source: 'file',
      extension: '.py',
      absolutePath: '/skills/invoice/scripts/check.py',
      realPath: '/skills/invoice/scripts/check.py',
      rootRealPath: '/skills/invoice',
    };
    const skill = fileSkill(script);
    const runtime = new SkillScriptRuntime(
      resolveSkillRuntimeOptions(
        { scripts: { executors: { '.py': { command: 'python', commandArgs: ['-I'] } } } },
        capabilitySnapshot({ processes, files }),
      ),
      capabilitySnapshot({ processes, files }),
    );

    queueMicrotask(() => {
      const emoji = new TextEncoder().encode('A😀B');
      child.stdout.emitData(emoji.slice(0, 3));
      child.stdout.emitData(emoji.slice(3));
      child.stderr.emitData(new Uint8Array([0xff]));
      child.emitClose(7, null);
    });

    await expect(
      runtime.run(skill, 'scripts/check.py', script, ['--json', 'a;b']),
    ).resolves.toEqual({
      exitCode: 7,
      signal: null,
      stdout: 'A😀B',
      stderr: '�',
    });
    expect(spawn).toHaveBeenCalledWith(
      '/bin/python',
      ['-I', '/skills/invoice/scripts/check.py', '--json', 'a;b'],
      {
        cwd: '/skills/invoice',
        env: { TEST_ENV: 'inherited' },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  });

  it('materializes a complete inline Skill in an isolated directory and cleans it', async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn(() => child);
    const processes = createProcessCapabilities({
      executables: { python: '/bin/python' },
      spawn,
    });
    const temporary = createTemporaryFiles();
    const mainScript: ResolvedInlineSkillScript = {
      source: 'inline',
      extension: '.py',
      content: 'print("ok")\n',
      description: 'Run the check.',
    };
    const skill = inlineSkill(mainScript);
    const capabilities = capabilitySnapshot({ processes, temporaryFiles: temporary.capability });
    const runtime = new SkillScriptRuntime(
      resolveSkillRuntimeOptions(
        { scripts: { executors: { '.py': { command: 'python' } } } },
        capabilities,
      ),
      capabilities,
    );

    queueMicrotask(() => child.emitClose(0, null));
    await expect(
      runtime.run(skill, 'scripts/check.py', mainScript, ['invoice.json']),
    ).resolves.toEqual({ exitCode: 0, signal: null, stdout: '', stderr: '' });

    const root = '/tmp/manee-skill-1/invoice-review';
    expect(temporary.files.get(`${root}/references/policy.md`)).toBe('# Policy');
    expect(temporary.files.get(`${root}/assets/template.txt`)).toBe('Template');
    expect(temporary.files.get(`${root}/scripts/check.py`)).toBe('print("ok")\n');
    expect(temporary.files.get(`${root}/scripts/helper.py`)).toBe('print("helper")\n');
    expect(temporary.files.get(`${root}/SKILL.md`)).toBe(
      [
        '---',
        'name: invoice-review',
        'description: Review invoices.',
        'license: MIT',
        'compatibility: Requires Python.',
        'metadata:',
        '  a: first',
        '  z: last',
        '---',
        'Use references/policy.md. $ARGUMENTS',
      ].join('\n'),
    );
    expect(spawn).toHaveBeenCalledWith(
      '/bin/python',
      [`${root}/scripts/check.py`, 'invoice.json'],
      expect.objectContaining({ cwd: root, shell: false }),
    );
    expect(temporary.removed).toEqual(['/tmp/manee-skill-1']);
  });

  it('keeps a completed inline result when best-effort cleanup fails', async () => {
    const child = new FakeChildProcess();
    const processes = createProcessCapabilities({
      executables: { python: '/bin/python' },
      spawn: () => child,
    });
    const temporary = createTemporaryFiles({ cleanupError: new Error('cleanup /tmp/secret') });
    const script: ResolvedInlineSkillScript = {
      source: 'inline',
      extension: '.py',
      content: 'print(1)',
    };
    const skill = inlineSkill(script);
    const capabilities = capabilitySnapshot({ processes, temporaryFiles: temporary.capability });
    const runtime = new SkillScriptRuntime(
      resolveSkillRuntimeOptions(
        { scripts: { executors: { '.py': { command: 'python' } } } },
        capabilities,
      ),
      capabilities,
    );

    queueMicrotask(() => child.emitClose(null, 'SIGTERM'));

    await expect(runtime.run(skill, 'scripts/check.py', script, [])).resolves.toEqual({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
    });
  });

  it('wraps spawn and stream failures without exposing paths while preserving cause', async () => {
    const spawnCause = new Error('spawn /secret/python ENOENT');
    const spawnProcesses = createProcessCapabilities({
      executables: { python: '/bin/python' },
      spawn: () => {
        throw spawnCause;
      },
    });
    const script: ResolvedFileSkillScript = {
      source: 'file',
      extension: '.py',
      absolutePath: '/skills/invoice/scripts/check.py',
      realPath: '/skills/invoice/scripts/check.py',
      rootRealPath: '/skills/invoice',
    };
    const skill = fileSkill(script);
    const spawnCapabilities = capabilitySnapshot({
      processes: spawnProcesses,
      files: createFileCapabilities(),
    });
    const spawnRuntime = new SkillScriptRuntime(
      resolveSkillRuntimeOptions(
        { scripts: { executors: { '.py': { command: 'python' } } } },
        spawnCapabilities,
      ),
      spawnCapabilities,
    );

    const spawnError = await captureError(spawnRuntime.run(skill, 'scripts/check.py', script, []));
    expect(spawnError).toBeInstanceOf(SkillRuntimeError);
    expect((spawnError as SkillRuntimeError).stage).toBe('spawn');
    expect(spawnError.cause).toBe(spawnCause);
    expect(spawnError.message).not.toContain('/secret');
    expect(spawnError.message).not.toContain('/bin/python');

    const child = new FakeChildProcess();
    const communicationCause = new Error('pipe /secret/output failed');
    const streamProcesses = createProcessCapabilities({
      executables: { python: '/bin/python' },
      spawn: () => child,
    });
    const streamCapabilities = capabilitySnapshot({
      processes: streamProcesses,
      files: createFileCapabilities(),
    });
    const streamRuntime = new SkillScriptRuntime(
      resolveSkillRuntimeOptions(
        { scripts: { executors: { '.py': { command: 'python' } } } },
        streamCapabilities,
      ),
      streamCapabilities,
    );

    queueMicrotask(() => {
      child.stdout.emitError(communicationCause);
      child.emitClose(0, null);
    });
    const streamError = await captureError(
      streamRuntime.run(skill, 'scripts/check.py', script, []),
    );
    expect(streamError).toBeInstanceOf(SkillRuntimeError);
    expect((streamError as SkillRuntimeError).stage).toBe('communication');
    expect(streamError.cause).toBe(communicationCause);
    expect(streamError.message).not.toContain('/secret');
  });

  it('treats a child process error event as a sanitized spawn failure', async () => {
    const child = new FakeChildProcess();
    const cause = new Error('exec /private/runtime failed');
    const processes = createProcessCapabilities({
      executables: { python: '/bin/python' },
      spawn: () => child,
    });
    const script: ResolvedFileSkillScript = {
      source: 'file',
      extension: '.py',
      absolutePath: '/skills/invoice/scripts/check.py',
      realPath: '/skills/invoice/scripts/check.py',
      rootRealPath: '/skills/invoice',
    };
    const skill = fileSkill(script);
    const capabilities = capabilitySnapshot({
      processes,
      files: createFileCapabilities(),
    });
    const runtime = new SkillScriptRuntime(
      resolveSkillRuntimeOptions(
        { scripts: { executors: { '.py': { command: 'python' } } } },
        capabilities,
      ),
      capabilities,
    );

    queueMicrotask(() => child.emitError(cause));
    const error = await captureError(runtime.run(skill, 'scripts/check.py', script, []));

    expect(error).toBeInstanceOf(SkillRuntimeError);
    expect((error as SkillRuntimeError).stage).toBe('spawn');
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain('/private');
    expect(error.message).not.toContain('/bin/python');
  });

  it('revalidates file scripts before spawning and preserves the hidden filesystem cause', async () => {
    const cause = Object.assign(new Error('lstat /private/replaced-script failed'), {
      code: 'EACCES',
    });
    const spawn = vi.fn(() => new FakeChildProcess());
    const processes = createProcessCapabilities({
      executables: { python: '/bin/python' },
      spawn,
    });
    const script: ResolvedFileSkillScript = {
      source: 'file',
      extension: '.py',
      absolutePath: '/skills/invoice/scripts/check.py',
      realPath: '/skills/invoice/scripts/check.py',
      rootRealPath: '/skills/invoice',
    };
    const skill = fileSkill(script);
    const capabilities = capabilitySnapshot({
      processes,
      files: createFileCapabilities({ lstatError: cause }),
    });
    const runtime = new SkillScriptRuntime(
      resolveSkillRuntimeOptions(
        { scripts: { executors: { '.py': { command: 'python' } } } },
        capabilities,
      ),
      capabilities,
    );

    const error = await captureError(runtime.run(skill, 'scripts/check.py', script, []));

    expect(error).toBeInstanceOf(SkillRuntimeError);
    expect((error as SkillRuntimeError).stage).toBe('file-validation');
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain('/private');
    expect(error.message).not.toContain('/skills');
    expect(spawn).not.toHaveBeenCalled();
  });
});

function capabilitySnapshot(input: {
  readonly files?: SkillFileCapabilities;
  readonly processes?: SkillProcessCapabilities;
  readonly temporaryFiles?: SkillTemporaryFileCapabilities;
}): SkillNodeCapabilities {
  return Object.freeze({
    ...(input.files ? { files: input.files } : {}),
    ...(input.processes ? { processes: input.processes } : {}),
    ...(input.temporaryFiles ? { temporaryFiles: input.temporaryFiles } : {}),
    diagnostics: Object.freeze({
      files: input.files ? availableDiagnostic : unavailableDiagnostic,
      processes: input.processes ? availableDiagnostic : unavailableDiagnostic,
      temporaryFiles: input.temporaryFiles ? availableDiagnostic : unavailableDiagnostic,
    }),
  });
}

function createProcessCapabilities(options: {
  readonly executables?: Readonly<Record<string, string>>;
  readonly resolutionErrors?: Readonly<Record<string, unknown>>;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: SkillSpawnOptions,
  ) => SkillChildProcess;
}): SkillProcessCapabilities {
  return Object.freeze({
    platform: 'linux',
    execPath: '/usr/bin/node',
    env: Object.freeze({ TEST_ENV: 'inherited' }),
    resolveExecutable(command: string): string | undefined {
      const error = options.resolutionErrors?.[command];

      if (error !== undefined) throw error;
      return options.executables?.[command];
    },
    isExecutable: (candidate: string) =>
      Object.values(options.executables ?? {}).includes(candidate),
    spawn: options.spawn ?? (() => new FakeChildProcess()),
  });
}

function createFileCapabilities(options?: {
  readonly lstatError?: unknown;
}): SkillFileCapabilities {
  return Object.freeze({
    separator: '/',
    cwd: () => '/',
    resolve: (...parts: readonly string[]) => path.resolve(...parts),
    join: (...parts: readonly string[]) => path.join(...parts),
    dirname: (value: string) => path.dirname(value),
    basename: (value: string) => path.basename(value),
    relative: (from: string, to: string) => path.relative(from, to),
    isAbsolute: (value: string) => path.isAbsolute(value),
    extname: (value: string) => path.extname(value),
    hasReadPermission: () => true,
    accessRead: () => undefined,
    lstat: () => {
      if (options?.lstatError !== undefined) throw options.lstatError;
      return { isFile: true, isDirectory: false, isSymbolicLink: false };
    },
    stat: () => ({ isFile: true, isDirectory: false, isSymbolicLink: false }),
    realpath: (value: string) => value,
    readFile: () => new Uint8Array(),
    readdir: () => [],
  });
}

function createTemporaryFiles(options?: { readonly cleanupError?: Error }): {
  readonly capability: SkillTemporaryFileCapabilities;
  readonly files: Map<string, string>;
  readonly removed: string[];
} {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const removed: string[] = [];

  return {
    files,
    removed,
    capability: Object.freeze({
      tempRoot: '/tmp',
      join: (...parts: readonly string[]) => path.join(...parts),
      dirname: (value: string) => path.dirname(value),
      makeTempDirectory(prefix: string): string {
        const directory = path.join('/tmp', `${prefix}1`);
        directories.add(directory);
        return directory;
      },
      makeDirectory(value: string): void {
        directories.add(value);
      },
      writeFileExclusive(value: string, data: string | Uint8Array): void {
        if (files.has(value)) throw new Error(`duplicate write: ${value}`);
        files.set(value, typeof data === 'string' ? data : new TextDecoder().decode(data));
      },
      removeTree(value: string): void {
        removed.push(value);
        if (options?.cleanupError) throw options.cleanupError;
      },
    }),
  };
}

function inlineSkill(mainScript: ResolvedInlineSkillScript): ResolvedSkill {
  return {
    descriptor: { name: 'invoice-review', description: 'Review invoices.' },
    sourceMetadata: {
      license: 'MIT',
      compatibility: 'Requires Python.',
      metadata: { z: 'last', a: 'first' },
    },
    instructions: 'Use references/policy.md. $ARGUMENTS',
    resources: new Map([
      ['references/policy.md', { source: 'inline' as const, content: '# Policy' }],
      ['assets/template.txt', { source: 'inline' as const, content: 'Template' }],
    ]),
    scripts: new Map([
      ['scripts/check.py', mainScript],
      [
        'scripts/helper.py',
        { source: 'inline' as const, extension: '.py', content: 'print("helper")\n' },
      ],
    ]),
    source: 'inline',
  };
}

function fileSkill(script: ResolvedFileSkillScript): ResolvedSkill {
  return {
    descriptor: { name: 'invoice-review', description: 'Review invoices.' },
    sourceMetadata: {},
    instructions: 'Run the checker.',
    resources: new Map(),
    scripts: new Map([['scripts/check.py', script]]),
    source: 'file',
    rootDirectory: '/skills/invoice',
  };
}

class FakeReadableOutput implements SkillReadableOutput {
  readonly #dataListeners: Array<(chunk: string | Uint8Array) => void> = [];
  readonly #errorListeners: Array<(error: unknown) => void> = [];

  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(
    event: 'data' | 'error',
    listener: ((chunk: string | Uint8Array) => void) | ((error: unknown) => void),
  ): unknown {
    if (event === 'data') {
      this.#dataListeners.push(listener as (chunk: string | Uint8Array) => void);
    } else {
      this.#errorListeners.push(listener as (error: unknown) => void);
    }

    return this;
  }

  emitData(chunk: string | Uint8Array): void {
    for (const listener of this.#dataListeners) listener(chunk);
  }

  emitError(error: unknown): void {
    for (const listener of this.#errorListeners) listener(error);
  }
}

class FakeChildProcess implements SkillChildProcess {
  readonly stdout = new FakeReadableOutput();
  readonly stderr = new FakeReadableOutput();
  readonly #errorListeners: Array<(error: unknown) => void> = [];
  readonly #closeListeners: Array<(exitCode: number | null, signal: string | null) => void> = [];

  once(event: 'error', listener: (error: unknown) => void): unknown;
  once(event: 'close', listener: (exitCode: number | null, signal: string | null) => void): unknown;
  once(
    event: 'error' | 'close',
    listener:
      | ((error: unknown) => void)
      | ((exitCode: number | null, signal: string | null) => void),
  ): unknown {
    if (event === 'error') {
      this.#errorListeners.push(listener as (error: unknown) => void);
    } else {
      this.#closeListeners.push(
        listener as (exitCode: number | null, signal: string | null) => void,
      );
    }

    return this;
  }

  emitError(error: unknown): void {
    for (const listener of this.#errorListeners.splice(0)) listener(error);
  }

  emitClose(exitCode: number | null, signal: string | null): void {
    for (const listener of this.#closeListeners.splice(0)) listener(exitCode, signal);
  }
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }

  throw new Error('Expected promise to reject.');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
