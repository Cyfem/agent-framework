import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSkillFileSourceAdapter,
  loadFileSkillSource,
  readFileSkillResource,
  type SkillFileSourceOptions,
} from '../src/agent/skill-file-source';
import {
  getSkillNodeCapabilities,
  type SkillFileCapabilities,
  type SkillNodeCapabilities,
} from '../src/agent/skill-node-runtime';
import { SkillRuntimeError } from '../src/agent/skill-registry-types';
import type { AgentSkillFileSource } from '../src/agent/types';

const resourceExtensions = Object.freeze(['.md', '.txt', '.json', '.yaml', '.yml', '.csv']);
const runtimeCapabilities = getSkillNodeCapabilities();
const runtimeFiles = runtimeCapabilities.files;

if (!runtimeFiles) throw new Error('These Node tests require the file capability.');

let temporaryParent = '';
let skillRoot = '';

beforeEach(() => {
  temporaryParent = mkdtempSync(join(tmpdir(), 'manee-skill-file-test-'));
  skillRoot = join(temporaryParent, 'demo-skill');
  mkdirSync(skillRoot);
});

afterEach(() => {
  rmSync(temporaryParent, { recursive: true, force: true });
});

describe('File Skill capability gates and diagnostics', () => {
  it('does not touch source.path before checking file capability availability', () => {
    let touched = false;
    const source = {
      source: 'file' as const,
      get path(): string {
        touched = true;
        throw new Error('path getter must not run');
      },
    };
    const nonNode = unavailableCapabilities('node_unavailable');
    const noFiles = unavailableCapabilities('builtin_module_unavailable');

    expect(loadFileSkillSource(source, options(nonNode))).toEqual({
      status: 'ignored',
      reason: 'node_unavailable',
    });
    expect(loadFileSkillSource(source, options(noFiles))).toEqual({
      status: 'ignored',
      reason: 'file_capability_unavailable',
    });
    expect(touched).toBe(false);
  });

  it('reports explicit read permission denial separately from access failure', () => {
    const deniedPermission = capabilitiesWithFiles({
      ...runtimeFiles,
      hasReadPermission: () => false,
    });
    const deniedAccess = capabilitiesWithFiles({
      ...runtimeFiles,
      accessRead: () => {
        throw Object.assign(new Error('private path'), { code: 'EACCES' });
      },
    });

    expect(loadFileSkillSource(fileSource(skillRoot), options(deniedPermission))).toEqual({
      status: 'ignored',
      reason: 'read_permission_denied',
    });
    expect(loadFileSkillSource(fileSource(skillRoot), options(deniedAccess))).toEqual({
      status: 'ignored',
      reason: 'source_access_denied',
    });
  });

  it('turns a traversal-time access denial into one source-level diagnostic', () => {
    writeSkillDocument();
    mkdirSync(join(skillRoot, 'references'));
    writeFileSync(join(skillRoot, 'references', 'guide.md'), 'guide');
    const files: SkillFileCapabilities = {
      ...runtimeFiles,
      readdir(path) {
        if (path.endsWith(`${runtimeFiles.separator}references`)) {
          throw Object.assign(new Error('denied nested path'), { code: 'ERR_ACCESS_DENIED' });
        }
        return runtimeFiles.readdir(path);
      },
    };

    expect(
      loadFileSkillSource(fileSource(skillRoot), options(capabilitiesWithFiles(files))),
    ).toEqual({ status: 'ignored', reason: 'source_access_denied' });
  });
});

describe('File Skill manifest and discovery', () => {
  it('loads the portable text subset and preserves the instruction body exactly', () => {
    const instructions = '  First line\r\nSecond 😀 line\n';
    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      `\ufeff---\r\nname: demo-skill\r\ndescription: Demonstrate file skills.\r\nlicense: MIT\r\ncompatibility: Node 22+\r\nmetadata:\r\n  owner: platform\r\nallowed-tools: ignored\r\n---\r\n${instructions}`,
    );
    mkdirSync(join(skillRoot, 'references', 'nested'), { recursive: true });
    mkdirSync(join(skillRoot, 'assets'));
    mkdirSync(join(skillRoot, 'scripts'));
    writeFileSync(join(skillRoot, 'references', 'nested', 'guide.md'), '# Guide');
    writeFileSync(join(skillRoot, 'assets', 'template.TXT'), 'template');
    writeFileSync(join(skillRoot, 'references', 'ignored.bin'), 'ignored');
    writeFileSync(join(skillRoot, 'scripts', 'check.PY'), 'print("ok")');
    writeFileSync(join(skillRoot, 'scripts', 'ignored'), 'ignored');
    writeFileSync(join(skillRoot, 'scripts', '.env'), 'ignored');
    const loaded = expectLoaded(loadFileSkillSource(fileSource(skillRoot), defaultOptions()));

    expect(loaded.descriptor).toEqual({
      name: 'demo-skill',
      description: 'Demonstrate file skills.',
    });
    expect(loaded.sourceMetadata).toEqual({
      license: 'MIT',
      compatibility: 'Node 22+',
      metadata: { owner: 'platform' },
    });
    expect(Object.getPrototypeOf(loaded.sourceMetadata.metadata)).toBeNull();
    expect(loaded.instructions).toBe(instructions);
    expect([...loaded.resources.keys()]).toEqual([
      'assets/template.TXT',
      'references/nested/guide.md',
    ]);
    expect([...loaded.scripts.keys()]).toEqual(['scripts/check.PY']);
    expect(loaded.scripts.get('scripts/check.PY')).toMatchObject({ extension: '.py' });

    const guide = loaded.resources.get('references/nested/guide.md');
    expect(guide?.source).toBe('file');
    if (guide?.source !== 'file') throw new Error('Expected a file resource.');
    expect(
      readFileSkillResource(runtimeFiles, guide, 'demo-skill', 'references/nested/guide.md'),
    ).toBe('# Guide');
  });

  it('accepts a direct SKILL.md path and a symlinked source directory', () => {
    writeSkillDocument();
    const direct = expectLoaded(
      loadFileSkillSource(fileSource(join(skillRoot, 'SKILL.md')), defaultOptions()),
    );

    expect(direct.rootDirectory).toBe(runtimeFiles.realpath(skillRoot));

    // Windows CI must not require Developer Mode / elevated symlink privileges.
    if (process.platform !== 'win32') {
      const alias = join(temporaryParent, 'alias');
      symlinkSync(skillRoot, alias, 'dir');
      const throughAlias = expectLoaded(loadFileSkillSource(fileSource(alias), defaultOptions()));

      expect(throughAlias.rootDirectory).toBe(runtimeFiles.realpath(skillRoot));
    }
  });

  it('supports LF, CRLF, a closing delimiter at EOF, and an empty first body line', () => {
    const cases = [
      {
        text: '---\nname: demo-skill\ndescription: Demo.\n---',
        body: '',
      },
      {
        text: '---\r\nname: demo-skill\r\ndescription: Demo.\r\n---\r\n\r\nBody',
        body: '\r\nBody',
      },
      {
        text: '---\nname: demo-skill\ndescription: Demo.\n---\n Body\n',
        body: ' Body\n',
      },
    ];

    for (const testCase of cases) {
      writeFileSync(join(skillRoot, 'SKILL.md'), testCase.text);
      const loaded = expectLoaded(loadFileSkillSource(fileSource(skillRoot), defaultOptions()));
      expect(loaded.instructions).toBe(testCase.body);
    }
  });

  it('rejects imprecise frontmatter boundaries, duplicate keys, and invalid UTF-8', () => {
    const invalidDocuments: Array<string | Uint8Array> = [
      ' ---\nname: demo-skill\ndescription: Demo.\n---\nbody',
      '---\nname: demo-skill\nname: demo-skill\ndescription: Demo.\n---\nbody',
      '---\nname: demo-skill\ndescription: Demo.\n--- \nbody',
      new Uint8Array([0xff, 0xfe, 0xfd]),
    ];

    for (const document of invalidDocuments) {
      writeFileSync(join(skillRoot, 'SKILL.md'), document);
      expect(() => loadFileSkillSource(fileSource(skillRoot), defaultOptions())).toThrow(TypeError);
    }
  });

  it('validates canonical name and frontmatter field limits', () => {
    writeSkillDocument({ name: 'other-skill' });
    expect(() => loadFileSkillSource(fileSource(skillRoot), defaultOptions())).toThrow(
      /canonical root basename/u,
    );

    writeSkillDocument({ description: '😀'.repeat(1_025) });
    expect(() => loadFileSkillSource(fileSource(skillRoot), defaultOptions())).toThrow(
      /description/u,
    );

    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo.\nmetadata:\n  count: 1\n---\nbody',
    );
    expect(() => loadFileSkillSource(fileSource(skillRoot), defaultOptions())).toThrow(/metadata/u);

    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo.\nmetadata:\n  1: value\n---\nbody',
    );
    expect(() => loadFileSkillSource(fileSource(skillRoot), defaultOptions())).toThrow(
      /metadata keys/u,
    );
  });
});

describe('File Skill tree safety and lazy revalidation', () => {
  it('rejects non-directory or symlinked well-known roots', () => {
    writeSkillDocument();
    writeFileSync(join(skillRoot, 'references'), 'not a directory');
    expect(() => loadFileSkillSource(fileSource(skillRoot), defaultOptions())).toThrow(
      /references/u,
    );

    unlinkSync(join(skillRoot, 'references'));
    if (process.platform !== 'win32') {
      const external = join(temporaryParent, 'external');
      mkdirSync(external);
      symlinkSync(external, join(skillRoot, 'references'), 'dir');
      expect(() => loadFileSkillSource(fileSource(skillRoot), defaultOptions())).toThrow(
        /references/u,
      );
    }
  });

  it.skipIf(process.platform === 'win32')(
    'ignores inner symlinks but rejects portable candidate names after suffix filtering',
    () => {
      writeSkillDocument();
      mkdirSync(join(skillRoot, 'references'));
      mkdirSync(join(skillRoot, 'scripts'));
      const external = join(temporaryParent, 'external.md');
      writeFileSync(external, 'outside');
      symlinkSync(external, join(skillRoot, 'references', 'outside.md'));
      writeFileSync(join(skillRoot, 'references', 'bad?.bin'), 'ignored by suffix');
      writeFileSync(join(skillRoot, 'scripts', 'bad?'), 'ignored by missing suffix');

      const loaded = expectLoaded(loadFileSkillSource(fileSource(skillRoot), defaultOptions()));
      expect(loaded.resources.size).toBe(0);
      expect(loaded.scripts.size).toBe(0);

      writeFileSync(join(skillRoot, 'references', 'CON.md'), 'candidate');
      expect(() => loadFileSkillSource(fileSource(skillRoot), defaultOptions())).toThrow(
        /portable text subset/u,
      );
    },
  );

  it('revalidates registered paths before every lazy read and sanitizes failures', () => {
    writeSkillDocument();
    mkdirSync(join(skillRoot, 'references'));
    const resourcePath = join(skillRoot, 'references', 'guide.md');
    writeFileSync(resourcePath, 'original');
    const loaded = expectLoaded(loadFileSkillSource(fileSource(skillRoot), defaultOptions()));
    const resource = loaded.resources.get('references/guide.md');

    if (resource?.source !== 'file') throw new Error('Expected a file resource.');
    expect(readFileSkillResource(runtimeFiles, resource, 'demo-skill', 'references/guide.md')).toBe(
      'original',
    );

    unlinkSync(resourcePath);
    if (process.platform === 'win32') {
      mkdirSync(resourcePath);
    } else {
      const external = join(temporaryParent, 'secret.md');
      writeFileSync(external, 'secret');
      symlinkSync(external, resourcePath);
    }
    const error = captureError(() =>
      readFileSkillResource(runtimeFiles, resource, 'demo-skill', 'references/guide.md'),
    );

    expect(error).toBeInstanceOf(SkillRuntimeError);
    expect((error as SkillRuntimeError).stage).toBe('resource-read');
    expect(error.message).not.toContain(temporaryParent);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('wraps lazy invalid UTF-8 while preserving the original cause', () => {
    writeSkillDocument();
    mkdirSync(join(skillRoot, 'references'));
    const resourcePath = join(skillRoot, 'references', 'guide.md');
    writeFileSync(resourcePath, 'original');
    const loaded = expectLoaded(loadFileSkillSource(fileSource(skillRoot), defaultOptions()));
    const resource = loaded.resources.get('references/guide.md');

    if (resource?.source !== 'file') throw new Error('Expected a file resource.');
    writeFileSync(resourcePath, new Uint8Array([0xff]));
    const error = captureError(() =>
      readFileSkillResource(runtimeFiles, resource, 'demo-skill', 'references/guide.md'),
    );

    expect(error).toBeInstanceOf(SkillRuntimeError);
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.message).not.toContain(resourcePath);
  });

  it('exposes lazy reads through the frozen registry adapter', () => {
    writeSkillDocument();
    mkdirSync(join(skillRoot, 'assets'));
    writeFileSync(join(skillRoot, 'assets', 'note.txt'), 'note');
    const mutableOptions: SkillFileSourceOptions = {
      capabilities: runtimeCapabilities,
      resourceExtensions: [...resourceExtensions],
    };
    const adapter = createSkillFileSourceAdapter(mutableOptions);
    const loaded = expectLoaded(adapter.load(fileSource(skillRoot), 0));
    const resource = loaded.resources.get('assets/note.txt');

    if (resource?.source !== 'file') throw new Error('Expected a file resource.');
    (mutableOptions as { capabilities: SkillNodeCapabilities }).capabilities =
      unavailableCapabilities('node_unavailable');
    (mutableOptions.resourceExtensions as string[]).splice(0);
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(adapter.read(resource, 'demo-skill', 'assets/note.txt')).toBe('note');
    expect(readFileSync(resource.absolutePath, 'utf8')).toBe('note');
  });
});

function writeSkillDocument(
  overrides: { readonly name?: string; readonly description?: string } = {},
) {
  writeFileSync(
    join(skillRoot, 'SKILL.md'),
    [
      '---',
      `name: ${overrides.name ?? 'demo-skill'}`,
      `description: ${overrides.description ?? 'Demo.'}`,
      '---',
      'Follow the instructions.',
    ].join('\n'),
  );
}

function defaultOptions(): SkillFileSourceOptions {
  return options(runtimeCapabilities);
}

function options(capabilities: SkillNodeCapabilities): SkillFileSourceOptions {
  return { capabilities, resourceExtensions };
}

function fileSource(path: string): AgentSkillFileSource {
  return { source: 'file', path };
}

function unavailableCapabilities(
  reason: 'node_unavailable' | 'builtin_module_unavailable',
): SkillNodeCapabilities {
  const diagnostic = Object.freeze({ available: false as const, reason });

  return Object.freeze({
    diagnostics: Object.freeze({
      files: diagnostic,
      processes: diagnostic,
      temporaryFiles: diagnostic,
    }),
  });
}

function capabilitiesWithFiles(files: SkillFileCapabilities): SkillNodeCapabilities {
  const available = Object.freeze({ available: true as const });
  const unavailable = Object.freeze({
    available: false as const,
    reason: 'builtin_module_unavailable' as const,
  });

  return Object.freeze({
    files,
    diagnostics: Object.freeze({
      files: available,
      processes: unavailable,
      temporaryFiles: unavailable,
    }),
  });
}

function expectLoaded(
  result: ReturnType<typeof loadFileSkillSource>,
): Extract<ReturnType<typeof loadFileSkillSource>, { readonly status: 'loaded' }>['skill'] {
  expect(result.status).toBe('loaded');
  if (result.status !== 'loaded') throw new Error(`Expected loaded, received ${result.reason}.`);
  return result.skill;
}

function captureError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }

  throw new Error('Expected operation to throw.');
}
