import { describe, expect, it, vi } from 'vitest';

import { SkillRegistry } from '../src/agent/skill-registry';
import {
  SkillRuntimeError,
  type ResolvedFileSkillResource,
  type ResolvedFileSkillScript,
  type ResolvedSkillCandidate,
  type SkillDispatchErrorResult,
  type SkillRegistryScriptRuntime,
} from '../src/agent/skill-registry-types';
import type {
  AgentSkill,
  AgentSkillFileSource,
  AgentSkillSource,
  SkillScriptExecutionResult,
} from '../src/agent/types';

function inlineSkill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    name: 'invoice-review',
    description: 'Review invoices.',
    instructions: 'Follow the invoice workflow.',
    ...overrides,
  };
}

function readDispatchError(value: unknown): SkillDispatchErrorResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('ok' in value) ||
    value.ok !== false ||
    !('error' in value)
  ) {
    throw new Error('Expected a SkillDispatchErrorResult.');
  }
  return value as SkillDispatchErrorResult;
}

describe('SkillRegistry inline normalization', () => {
  it('builds a frozen descriptor-only catalog and stable resource/script maps', async () => {
    const source = inlineSkill({
      license: 'MIT',
      compatibility: 'Node 22+',
      metadata: { owner: 'billing' },
      references: {
        'z-last.md': 'last',
        'a-first.md': 'first',
      },
      assets: { 'template.md': 'template' },
      scripts: {
        check: {
          extension: '.PY',
          content: 'print("ok")',
          description: 'Validate the invoice.',
        },
      },
    });
    const { registry, diagnostics } = SkillRegistry.build({ sources: [source] });
    const descriptors = registry.getDescriptors();

    expect(diagnostics).toEqual([]);
    expect(registry.size).toBe(1);
    expect(descriptors).toEqual([{ name: 'invoice-review', description: 'Review invoices.' }]);
    expect(Object.keys(descriptors[0] ?? {})).toEqual(['name', 'description']);
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(Object.isFrozen(descriptors[0])).toBe(true);

    // Mutating the configured source after build cannot change the effective snapshot.
    (source.references as Record<string, string>)['a-first.md'] = 'mutated';
    expect(
      await registry.dispatch({ skill: 'invoice-review', args: 'read references/a-first.md' }),
    ).toBe('first');

    const loaded = await registry.dispatch({ skill: 'invoice-review' });
    expect(loaded).toBeTypeOf('string');
    expect(loaded).toContain(
      '## Resources\n- assets/template.md\n- references/a-first.md\n- references/z-last.md',
    );
    expect(loaded).toContain('- scripts/check.py [unavailable] — "Validate the invoice."');
  });

  it('passes immutable resolved data and argv to an injected script runtime', async () => {
    const runResult: SkillScriptExecutionResult = {
      exitCode: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
    };
    const seenSkills: ResolvedSkillCandidate[] = [];
    const run = vi.fn<SkillRegistryScriptRuntime['run']>(async () => runResult);
    const scriptRuntime: SkillRegistryScriptRuntime = {
      isAvailable(skill, script) {
        seenSkills.push(skill);
        return script.extension === '.js';
      },
      run,
    };
    const { registry } = SkillRegistry.build({
      sources: [
        inlineSkill({
          metadata: { owner: 'billing' },
          scripts: {
            check: { extension: '.JS', content: 'console.log("ok")' },
          },
        }),
      ],
      scriptRuntime,
    });

    expect(
      await registry.dispatch({ skill: 'invoice-review', args: `run scripts/check.js '' a\\ b` }),
    ).toEqual(runResult);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).toBe('scripts/check.js');
    expect(run.mock.calls[0]?.[3]).toEqual(['', 'a b']);
    expect(seenSkills[0]?.sourceMetadata.metadata).toEqual({ owner: 'billing' });
    expect(Object.getPrototypeOf(seenSkills[0]?.sourceMetadata.metadata)).toBeNull();
  });

  it('validates ordinary-object shapes, code-point limits, metadata, and scripts', () => {
    class ClassSkill {
      name = 'class-skill';
      description = 'invalid object prototype';
      instructions = '';
    }

    expect(() => SkillRegistry.build({ sources: [new ClassSkill() as AgentSkill] })).toThrow(
      /plain object/iu,
    );
    expect(() =>
      SkillRegistry.build({
        sources: [inlineSkill({ name: 'UPPER' })],
      }),
    ).toThrow(/name/iu);
    expect(() =>
      SkillRegistry.build({
        sources: [inlineSkill({ description: '😀'.repeat(1_025) })],
      }),
    ).toThrow(/description/iu);
    expect(() =>
      SkillRegistry.build({
        sources: [inlineSkill({ compatibility: '😀'.repeat(501) })],
      }),
    ).toThrow(/compatibility/iu);
    expect(() =>
      SkillRegistry.build({
        sources: [inlineSkill({ metadata: { invalid: 1 } as unknown as Record<string, string> })],
      }),
    ).toThrow(/metadata/iu);
    expect(() =>
      SkillRegistry.build({
        sources: [inlineSkill({ scripts: { check: { extension: '.foo.py', content: '' } } })],
      }),
    ).toThrow(/extension/iu);
    expect(() =>
      SkillRegistry.build({
        sources: [inlineSkill({ scripts: { '': { extension: '.py', content: '' } } })],
      }),
    ).toThrow(/script key/iu);

    expect(() =>
      SkillRegistry.build({
        sources: [inlineSkill({ license: 'x'.repeat(20_000), description: '😀'.repeat(1_024) })],
      }),
    ).not.toThrow();
  });

  it('rejects duplicate names and portable layout collisions transactionally', () => {
    expect(() =>
      SkillRegistry.build({
        sources: [inlineSkill(), inlineSkill()],
      }),
    ).toThrow(/Duplicate Skill name/u);
    expect(() =>
      SkillRegistry.build({
        sources: [
          inlineSkill({
            references: {
              'A/x.md': 'x',
              'a/y.md': 'y',
            },
          }),
        ],
      }),
    ).toThrow(/collision/iu);
    expect(() =>
      SkillRegistry.build({
        sources: [
          inlineSkill({
            references: {
              foo: 'file',
              'foo/bar.md': 'nested',
            },
          }),
        ],
      }),
    ).toThrow(/prefix/iu);
  });
});

describe('SkillRegistry file sources and diagnostics', () => {
  it('does not read a file path getter when no file adapter is available', () => {
    const source = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(source, 'source', { enumerable: true, value: 'file' });
    Object.defineProperty(source, 'path', {
      enumerable: true,
      get() {
        throw new Error('path must not be read');
      },
    });

    const built = SkillRegistry.build({ sources: [source as unknown as AgentSkillFileSource] });

    expect(built.registry.size).toBe(0);
    expect(built.diagnostics).toEqual([{ sourceIndex: 0, reason: 'file_capability_unavailable' }]);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.diagnostics)).toBe(true);
    expect(Object.isFrozen(built.diagnostics[0])).toBe(true);
  });

  it('keeps configured indexes and freezes adapter-provided ignore reasons', () => {
    const fileSource = { source: 'file', path: '/denied/SKILL.md' } as const;
    const load = vi.fn(() => ({
      status: 'ignored' as const,
      reason: 'read_permission_denied' as const,
    }));
    const { registry, diagnostics } = SkillRegistry.build({
      sources: [inlineSkill(), fileSource],
      fileSource: { load, read: vi.fn() },
    });

    expect(registry.size).toBe(1);
    expect(load).toHaveBeenCalledWith(fileSource, 1);
    expect(diagnostics).toEqual([{ sourceIndex: 1, reason: 'read_permission_denied' }]);
  });

  it('dispatches loaded file resources and wraps raw read failures without leaking paths', async () => {
    const resource: ResolvedFileSkillResource = {
      source: 'file',
      absolutePath: '/secret/invoice/references/policy.md',
      realPath: '/secret/invoice/references/policy.md',
      rootRealPath: '/secret/invoice',
    };
    const candidate = fileCandidate({ resources: new Map([['references/policy.md', resource]]) });
    const cause = new Error('EACCES /secret/invoice/references/policy.md');
    const read = vi.fn(() => {
      throw cause;
    });
    const { registry } = SkillRegistry.build({
      sources: [{ source: 'file', path: '/secret/invoice' }],
      fileSource: {
        load: () => ({ status: 'loaded', skill: candidate }),
        read,
      },
    });

    await expect(
      registry.dispatch({ skill: 'file-skill', args: 'read references/policy.md' }),
    ).rejects.toMatchObject({
      name: 'SkillRuntimeError',
      stage: 'resource-read',
      skill: 'file-skill',
      target: 'references/policy.md',
      cause,
    });
    await registry
      .dispatch({ skill: 'file-skill', args: 'read references/policy.md' })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(SkillRuntimeError);
        expect((error as Error).message).not.toContain('/secret');
      });
  });
});

describe('SkillRegistry dispatch error precedence', () => {
  it('applies invalid-input, lookup, command, id, lookup, and availability ordering', async () => {
    const { registry } = SkillRegistry.build({
      sources: [
        inlineSkill({
          references: { 'policy.md': 'policy' },
          scripts: { check: { extension: '.py', content: 'print(1)' } },
        }),
      ],
    });

    expect(
      readDispatchError(await registry.dispatch({ skill: 'BAD', args: 'unknown\0raw-secret' }))
        .error.code,
    ).toBe('invalid_arguments');
    expect(
      readDispatchError(await registry.dispatch({ skill: 'missing-skill', args: 'unknown' })).error
        .code,
    ).toBe('skill_not_found');
    expect(
      readDispatchError(await registry.dispatch({ skill: 'invoice-review', args: 'unknown' })).error
        .code,
    ).toBe('invalid_command');
    expect(
      readDispatchError(
        await registry.dispatch({ skill: 'invoice-review', args: `read "unterminated` }),
      ).error.code,
    ).toBe('invalid_arguments');
    expect(
      readDispatchError(
        await registry.dispatch({ skill: 'invoice-review', args: 'read references/missing.md' }),
      ).error.code,
    ).toBe('resource_not_found');
    expect(
      readDispatchError(
        await registry.dispatch({ skill: 'invoice-review', args: 'run scripts/missing.py' }),
      ).error.code,
    ).toBe('script_not_found');
    expect(
      readDispatchError(
        await registry.dispatch({ skill: 'invoice-review', args: 'run scripts/check.py' }),
      ).error.code,
    ).toBe('script_execution_unavailable');
  });

  it('never echoes an unvalidated command in a correctable error', async () => {
    const { registry } = SkillRegistry.build({ sources: [inlineSkill()] });
    const secret = 'unknown /Users/private/token';
    const error = readDispatchError(
      await registry.dispatch({ skill: 'invoice-review', args: secret }),
    );

    expect(error.error.code).toBe('invalid_command');
    expect(error.error.message).not.toContain(secret);
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isFrozen(error.error)).toBe(true);
  });
});

function fileCandidate(overrides: Partial<ResolvedSkillCandidate> = {}): ResolvedSkillCandidate {
  const script: ResolvedFileSkillScript = {
    source: 'file',
    extension: '.js',
    absolutePath: '/skill/scripts/check.js',
    realPath: '/skill/scripts/check.js',
    rootRealPath: '/skill',
  };

  return {
    descriptor: { name: 'file-skill', description: 'A file Skill.' },
    sourceMetadata: {},
    instructions: 'File instructions.',
    resources: new Map(),
    scripts: new Map([['scripts/check.js', script]]),
    source: 'file',
    rootDirectory: '/skill',
    ...overrides,
  };
}

// Compile-time check that configured source arrays accept both variants.
const configuredSources: readonly AgentSkillSource[] = [
  inlineSkill(),
  { source: 'file', path: '/skill' },
];
void configuredSources;
