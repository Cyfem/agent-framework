import { describe, expect, it } from 'vitest';
import { acceptanceIt } from '../../../testkit';
import { z } from 'zod';

import { assertArtifactReference, DEFAULT_ARTIFACT_LIMITS } from '../src/subagent/artifact';
import { defineSubAgent } from '../src/subagent/definition';
import {
  DEFAULT_SUBAGENT_IO_LIMITS,
  DEFAULT_SUBAGENT_LIMITS,
  DEFAULT_SUBAGENT_PROJECTION_LIMITS,
  resolveSubAgentLimits,
} from '../src/subagent/limits';

describe('defineSubAgent', () => {
  it('snapshots and freezes policy arrays without freezing caller schemas', () => {
    const inputSchema = z.object({ topic: z.string() });
    const outputSchema = z.object({ answer: z.string() });
    const allowedNames = ['local'];
    const delegatedDefinitions = ['reviewer'];

    const definition = defineSubAgent({
      name: 'research.agent',
      version: '2.0.0+ark',
      description: '  Research a topic.  ',
      inputSchema,
      outputSchema,
      executorPolicy: {
        allowedNames,
        requiredCapabilities: { approval: true, resumeRecovery: 'checkpoint' },
      },
      delegation: { mode: 'allowlist', definitions: delegatedDefinitions },
    });

    allowedNames.push('remote');
    delegatedDefinitions.push('writer');

    expect(definition.description).toBe('Research a topic.');
    expect(definition.executorPolicy?.allowedNames).toEqual(['local']);
    expect(definition.delegation).toMatchObject({
      mode: 'allowlist',
      definitions: ['reviewer'],
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.executorPolicy)).toBe(true);
    expect(Object.isFrozen(definition.executorPolicy?.allowedNames)).toBe(true);
    expect(Object.isFrozen(definition.executorPolicy?.requiredCapabilities)).toBe(true);
    expect(Object.isFrozen(inputSchema)).toBe(false);
    expect(Object.isFrozen(outputSchema)).toBe(false);
  });

  it.each([
    ['', '1', 'description'],
    [' leading', '1', 'description'],
    ['bad/name', '1', 'description'],
    ['valid', '', 'description'],
    ['valid', 'bad/version', 'description'],
    ['valid', '1', '   '],
  ])('rejects invalid identity or description: %s@%s', (name, version, description) => {
    expect(() =>
      defineSubAgent({
        name,
        version,
        description,
        inputSchema: z.null(),
        outputSchema: z.null(),
      }),
    ).toThrow();
  });

  it('enforces ASCII identity lengths and UTF-8 description bytes', () => {
    expect(() =>
      defineSubAgent({
        name: `a${'b'.repeat(64)}`,
        version: '1',
        description: 'description',
        inputSchema: z.null(),
        outputSchema: z.null(),
      }),
    ).toThrow(/1-64/u);

    expect(() =>
      defineSubAgent({
        name: 'valid',
        version: '1',
        description: '界'.repeat(1_366),
        inputSchema: z.null(),
        outputSchema: z.null(),
      }),
    ).toThrow(/UTF-8/u);
  });
});

acceptanceIt('DEF-01.l1.contract', 'definition', () => {
  const definition = defineSubAgent({
    name: 'acceptance-worker',
    version: '2',
    description: 'Acceptance definition.',
    inputSchema: z.object({ input: z.string() }),
    outputSchema: z.object({ output: z.string() }),
  });
  expect(Object.isFrozen(definition)).toBe(true);
  expect(definition).toMatchObject({ name: 'acceptance-worker', version: '2' });
});

describe('Subagent v2 frozen defaults', () => {
  it('uses the frozen limit Oracle', () => {
    expect(DEFAULT_SUBAGENT_LIMITS).toEqual({
      maxDepth: 3,
      maxDescendants: 32,
      maxConcurrent: 4,
      maxTurns: 16,
      timeoutMs: 120_000,
    });
    expect(DEFAULT_SUBAGENT_IO_LIMITS).toEqual({
      maxInputBytes: 256 * 1024,
      maxOutputBytes: 256 * 1024,
    });
    expect(DEFAULT_SUBAGENT_PROJECTION_LIMITS).toEqual({
      maxItems: 32,
      maxItemBytes: 64 * 1024,
      maxTotalBytes: 128 * 1024,
    });
    expect(DEFAULT_ARTIFACT_LIMITS).toEqual({
      maxItemBytes: 32 * 1024 * 1024,
      maxItemsPerTask: 8,
      maxTotalBytesPerTask: 128 * 1024 * 1024,
    });
    expect(Object.isFrozen(DEFAULT_SUBAGENT_LIMITS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SUBAGENT_IO_LIMITS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SUBAGENT_PROJECTION_LIMITS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ARTIFACT_LIMITS)).toBe(true);
  });

  it('resolves overrides without mutating defaults', () => {
    const resolved = resolveSubAgentLimits({ maxDepth: 5, maxProviderCalls: 10 });

    expect(resolved).toEqual({ ...DEFAULT_SUBAGENT_LIMITS, maxDepth: 5, maxProviderCalls: 10 });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(() => resolveSubAgentLimits({ maxConcurrent: 0 })).toThrow(/positive/u);
  });
});

describe('ArtifactReference', () => {
  const valid = {
    version: '1',
    id: 'artifact_q4P-7',
    mediaType: 'application/json',
    size: 512,
    sha256: 'a'.repeat(64),
  } as const;

  it('accepts only the opaque five-field representation', () => {
    expect(() => assertArtifactReference(valid)).not.toThrow();
    expect(() => assertArtifactReference({ ...valid, url: 'https://example.test/secret' })).toThrow(
      /unsupported fields/u,
    );
    expect(() => assertArtifactReference({ ...valid, id: 'C:\\secret\\file' })).toThrow(/opaque/u);
    expect(() => assertArtifactReference({ ...valid, sha256: 'A'.repeat(64) })).toThrow(
      /lowercase/u,
    );
  });

  it('allows the byte boundary and rejects one byte over it', () => {
    expect(() =>
      assertArtifactReference({ ...valid, size: DEFAULT_ARTIFACT_LIMITS.maxItemBytes }),
    ).not.toThrow();
    expect(() =>
      assertArtifactReference({ ...valid, size: DEFAULT_ARTIFACT_LIMITS.maxItemBytes + 1 }),
    ).toThrow(/item limit/u);
  });
});
