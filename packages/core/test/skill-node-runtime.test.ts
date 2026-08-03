import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createSkillNodeCapabilities,
  getSkillNodeCapabilities,
  isSkillAccessDeniedError,
  isSkillPathRaceError,
} from '../src/agent/skill-node-runtime';

describe('Skill Node capability detection', () => {
  it('distinguishes a non-Node host from a Node host without builtin access', () => {
    const nonNode = createSkillNodeCapabilities({ process: undefined });
    const noBuiltinAccess = createSkillNodeCapabilities({
      process: {
        release: { name: 'node' },
        versions: { node: '22.0.0' },
      },
    });

    expect(nonNode.files).toBeUndefined();
    expect(nonNode.diagnostics.files).toEqual({
      available: false,
      reason: 'node_unavailable',
    });
    expect(noBuiltinAccess.diagnostics.files).toEqual({
      available: false,
      reason: 'builtin_module_unavailable',
    });
    expect(Object.isFrozen(nonNode)).toBe(true);
    expect(Object.isFrozen(nonNode.diagnostics)).toBe(true);
  });

  it('layers file, process, and temporary-file capabilities independently', () => {
    const withoutChildProcess = createSkillNodeCapabilities({
      process: fakeNodeProcess({ child_process: undefined }),
    });
    const restricted = createSkillNodeCapabilities({
      process: fakeNodeProcess(undefined, (scope) => scope !== 'child' && scope !== 'fs.write'),
    });

    expect(withoutChildProcess.files).toBeDefined();
    expect(withoutChildProcess.processes).toBeUndefined();
    expect(withoutChildProcess.temporaryFiles).toBeDefined();
    expect(withoutChildProcess.diagnostics.processes).toEqual({
      available: false,
      reason: 'builtin_module_unavailable',
    });

    expect(restricted.files).toBeDefined();
    expect(restricted.processes).toBeUndefined();
    expect(restricted.temporaryFiles).toBeUndefined();
    expect(restricted.diagnostics.processes).toEqual({
      available: false,
      reason: 'permission_denied',
    });
    expect(restricted.diagnostics.temporaryFiles).toEqual({
      available: false,
      reason: 'permission_denied',
    });
  });

  it('keeps path-specific read permission as a file operation result', () => {
    const snapshot = createSkillNodeCapabilities({
      process: fakeNodeProcess(undefined, (scope, reference) => {
        if (scope !== 'fs.read') return true;
        return reference !== '/private/skill';
      }),
    });

    expect(snapshot.files).toBeDefined();
    expect(snapshot.files?.hasReadPermission('/public/skill')).toBe(true);
    expect(snapshot.files?.hasReadPermission('/private/skill')).toBe(false);
  });

  it('copies and freezes the process environment in the capability snapshot', () => {
    const env: Record<string, string | undefined> = { PATH: '/first' };
    const snapshot = createSkillNodeCapabilities({
      process: fakeNodeProcess(undefined, undefined, { env }),
    });

    env.PATH = '/changed';
    expect(snapshot.processes?.env.PATH).toBe('/first');
    expect(Object.isFrozen(snapshot.processes?.env)).toBe(true);
  });
});

describe('Skill Node filesystem and process adapters', () => {
  it('uses single-level exclusive directory creation and exclusive file writes', () => {
    const temporaryFiles = getSkillNodeCapabilities().temporaryFiles;

    expect(temporaryFiles).toBeDefined();
    if (!temporaryFiles) return;

    const temporaryRoot = temporaryFiles.makeTempDirectory('manee-skill-node-test-');
    const child = temporaryFiles.join(temporaryRoot, 'child');
    const file = temporaryFiles.join(child, 'data.txt');

    try {
      temporaryFiles.makeDirectory(child);
      expect(() => temporaryFiles.makeDirectory(child)).toThrow(
        expect.objectContaining({ code: 'EEXIST' }),
      );
      temporaryFiles.writeFileExclusive(file, 'first');
      expect(() => temporaryFiles.writeFileExclusive(file, 'second')).toThrow(
        expect.objectContaining({ code: 'EEXIST' }),
      );
    } finally {
      temporaryFiles.removeTree(temporaryRoot);
    }
  });

  it('resolves only executable regular files and never invokes a shell', () => {
    const processes = getSkillNodeCapabilities().processes;

    expect(processes).toBeDefined();
    if (!processes) return;

    expect(processes.isExecutable(process.execPath)).toBe(true);
    expect(processes.resolveExecutable(process.execPath)).toBe(path.resolve(process.execPath));
    expect(processes.resolveExecutable('../not-a-basename')).toBeUndefined();
  });

  it('filters Windows PATHEXT to exe/com and rejects cmd executables', () => {
    const checked: string[] = [];
    const windowsFs = {
      constants: { R_OK: 4, X_OK: 1 },
      accessSync: () => undefined,
      lstatSync: () => status('file'),
      statSync(candidate: string) {
        checked.push(candidate);
        if (candidate.toLowerCase().endsWith('.exe')) return status('file');
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      realpathSync: (candidate: string) => candidate,
      readFileSync: () => new Uint8Array(),
      readdirSync: () => [],
    };
    const snapshot = createSkillNodeCapabilities({
      process: fakeNodeProcess({ fs: windowsFs, path: path.win32, os: undefined }, undefined, {
        platform: 'win32',
        env: { Path: 'C:\\tools', PATHEXT: '.CMD;.EXE;.COM;.BAT' },
      }),
    });

    expect(snapshot.processes?.resolveExecutable('runner')).toBe(
      path.win32.resolve('C:\\tools', 'runner.exe'),
    );
    expect(snapshot.processes?.isExecutable('C:\\tools\\runner.cmd')).toBe(false);
    expect(checked.some((candidate) => candidate.toLowerCase().endsWith('.cmd'))).toBe(false);
  });

  it('classifies stable permission and path-race error codes', () => {
    expect(isSkillAccessDeniedError(Object.assign(new Error(), { code: 'EACCES' }))).toBe(true);
    expect(
      isSkillAccessDeniedError(Object.assign(new Error(), { code: 'ERR_ACCESS_DENIED' })),
    ).toBe(true);
    expect(isSkillPathRaceError(Object.assign(new Error(), { code: 'ELOOP' }))).toBe(true);
    expect(isSkillPathRaceError(Object.assign(new Error(), { code: 'EACCES' }))).toBe(false);
  });
});

function fakeNodeProcess(
  moduleOverrides: Readonly<Record<string, unknown>> = {},
  permission?: (scope: string, reference?: string) => boolean,
  processOverrides: {
    readonly platform?: string;
    readonly env?: Record<string, string | undefined>;
  } = {},
): unknown {
  const modules: Record<string, unknown> = {
    fs,
    path,
    os,
    child_process: childProcess,
    ...moduleOverrides,
  };

  return {
    release: { name: 'node' },
    versions: { node: '22.0.0' },
    getBuiltinModule: (id: string) => modules[id],
    cwd: () => process.cwd(),
    execPath: process.execPath,
    env: processOverrides.env ?? { ...process.env },
    platform: processOverrides.platform ?? process.platform,
    ...(permission ? { permission: { has: permission } } : {}),
  };
}

function status(kind: 'file' | 'directory' | 'symlink'): {
  readonly isFile: () => boolean;
  readonly isDirectory: () => boolean;
  readonly isSymbolicLink: () => boolean;
} {
  return {
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
  };
}
