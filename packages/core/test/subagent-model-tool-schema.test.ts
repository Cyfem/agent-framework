import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { acceptanceIt } from '../../../testkit';
import { toOpenAIToolParameters } from '../src/llm/openai-schema';
import type { SubAgentCatalogEntry, SubAgentCatalogExecutorEntry } from '../src/subagent/catalog';
import {
  createModelSubAgentRouterSchema,
  createModelSubAgentToolDefinition,
} from '../src/subagent/model-tool-schema';
import type { JsonValue } from '../src/subagent/json';

const executor = (name: string, status: 'available' | 'degraded' = 'available') =>
  ({
    runtimeProtocolVersion: '1',
    taskRecordVersions: ['1'],
    childCheckpointVersions: ['1'],
    runnerCompatibility: [
      { runnerId: 'test-runner', runnerVersion: '1', childCheckpointVersions: ['1'] },
    ],
    name,
    description: `${name} placement.`,
    useCases: [`Use ${name}.`],
    capabilities: {
      execute: true,
      spawn: true,
      cancel: true,
      events: true,
      approval: true,
      usage: 'provider',
      recovery: { resume: 'checkpoint', reconnect: 'external_binding' },
    },
    adapterStateVersion: '1',
    maxBindingBytes: 64 * 1024,
    maxEventPageSize: 256,
    status,
  }) satisfies SubAgentCatalogExecutorEntry;

const entries = [
  {
    definition: { name: 'research', version: '2' },
    description: 'Research a query.',
    inputSchema: z.object({ query: z.string().min(1) }).strict(),
    executors: [executor('local', 'degraded')],
  },
  {
    definition: { name: 'writer', version: '1' },
    description: 'Write a bounded draft.',
    inputSchema: z.object({ paragraphs: z.number().int().positive() }).strict(),
    executors: [executor('process')],
  },
] satisfies readonly SubAgentCatalogEntry[];

describe('model subagent Tool schema', () => {
  it('returns null for an empty catalog so no placeholder agent Tool is emitted', () => {
    expect(createModelSubAgentRouterSchema([])).toBeNull();
    expect(createModelSubAgentToolDefinition([])).toBeNull();

    const one = createModelSubAgentRouterSchema([entries[0]!]);
    expect(
      one?.safeParse({ subAgent: 'research', executor: 'local', input: { query: 'topic' } })
        .success,
    ).toBe(true);
  });

  it('uses a strict Zod discriminated union with the exact three-field wire', () => {
    const schema = createModelSubAgentRouterSchema(entries)!;
    expect(
      schema.safeParse({ subAgent: 'research', executor: 'local', input: { query: 'topic' } })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ subAgent: 'research', executor: 'process', input: { query: 'topic' } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ subAgent: 'research', executor: 'local', input: { paragraphs: 2 } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        subAgent: 'research',
        executor: 'local',
        input: { query: 'topic' },
        taskId: 'must-not-be-visible',
      }).success,
    ).toBe(false);
  });

  it('preserves a root object plus oneOf through the OpenAI converter', () => {
    const tool = createModelSubAgentToolDefinition(entries)!;
    const jsonSchema = toOpenAIToolParameters(tool.parameters);

    expect(tool).toMatchObject({ name: 'agent', strict: true });
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.oneOf).toHaveLength(2);
    expect(jsonSchema.required).toEqual(['subAgent', 'executor', 'input']);
    expect(JSON.stringify(jsonSchema)).not.toMatch(
      /taskId|retryOf|binding|recoveryData|approval|permission/iu,
    );
    expect(tool.description).toContain('local (degraded)');

    const branches = jsonSchema.oneOf as Array<{ properties: Record<string, unknown> }>;
    expect(branches[0]?.properties).toMatchObject({
      subAgent: { enum: ['research'] },
      executor: { enum: ['local'] },
      input: { type: 'object' },
    });
  });

  it('rejects duplicate active names instead of silently degrading the union', () => {
    expect(() => createModelSubAgentToolDefinition([...entries, entries[0]!])).toThrow(
      /duplicate active name/iu,
    );
  });

  it('rebases recursive input refs so they cannot target the outer Tool root', () => {
    interface TreeInput {
      readonly name: string;
      readonly children: readonly TreeInput[];
    }
    const treeSchema: z.ZodType<TreeInput> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(treeSchema) }).strict(),
    );
    const tool = createModelSubAgentToolDefinition([
      {
        definition: { name: 'tree', version: '1' },
        description: 'Walk a recursive tree.',
        inputSchema: treeSchema as unknown as z.ZodType<JsonValue>,
        executors: [executor('local')],
      },
    ])!;
    const wire = toOpenAIToolParameters(tool.parameters);
    const serialized = JSON.stringify(wire);

    expect(wire.$defs).toBeDefined();
    expect(serialized).not.toContain('"$ref":"#"');
    expect(serialized).toContain('"$ref":"#/$defs/subagent_0_root"');
  });
});

acceptanceIt('API-02.l1.dynamic-wire', 'oneof-zod', () => {
  const tool = createModelSubAgentToolDefinition(entries)!;
  const wire = toOpenAIToolParameters(tool.parameters);
  expect(wire).toMatchObject({ type: 'object', additionalProperties: false });
  expect(wire.oneOf).toHaveLength(2);
  expect(
    tool.parameters.safeParse({
      subAgent: 'writer',
      executor: 'process',
      input: { paragraphs: 2 },
    }).success,
  ).toBe(true);
});
