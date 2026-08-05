import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { acceptanceIt } from '../../../testkit';
import type {
  ExecutorAvailabilityProbe,
  SubAgentExecutorDescriptor,
} from '../src/subagent/catalog';
import { defineSubAgent, type SubAgentDefinition } from '../src/subagent/definition';
import { SubAgentDefinitionRegistry } from '../src/subagent/definition-registry';
import { SubAgentRuntimeError } from '../src/subagent/errors';
import type { ExecutorTaskHandle, SubAgentExecutor } from '../src/subagent/executor';
import { SubAgentExecutorRegistry } from '../src/subagent/executor-registry';
import type { JsonValue } from '../src/subagent/json';

function definition(
  name: string,
  version: string,
  options: Pick<SubAgentDefinition, 'executorPolicy'> = {},
): SubAgentDefinition {
  return defineSubAgent({
    name,
    version,
    description: `${name} definition.`,
    inputSchema: z.custom<JsonValue>(),
    outputSchema: z.custom<JsonValue>(),
    ...options,
  });
}

const completeCapabilities: SubAgentExecutorDescriptor['capabilities'] = {
  execute: true,
  spawn: true,
  cancel: true,
  events: true,
  approval: true,
  usage: 'provider',
  recovery: { resume: 'checkpoint', reconnect: 'external_binding' },
};

class FakeExecutor implements SubAgentExecutor {
  readonly bindingCodec;
  readonly descriptor: SubAgentExecutorDescriptor;
  availability: ExecutorAvailabilityProbe = { status: 'available' };
  supportsResult = true;
  availabilityCalls = 0;
  supportsCalls = 0;

  constructor(
    name: string,
    capabilities: SubAgentExecutorDescriptor['capabilities'] = completeCapabilities,
    adapterStateVersion = '1',
  ) {
    this.descriptor = {
      name,
      description: `${name} execution.`,
      useCases: [`Run on ${name}.`],
      capabilities,
      adapterStateVersion,
    };
    this.bindingCodec = {
      adapterStateVersion,
      encode: () => null,
      decode: () => null,
    };
  }

  getAvailability(): ExecutorAvailabilityProbe {
    this.availabilityCalls += 1;
    return this.availability;
  }

  supports(): boolean {
    this.supportsCalls += 1;
    return this.supportsResult;
  }

  async execute(): Promise<never> {
    throw new Error('not used');
  }

  async spawn(): Promise<ExecutorTaskHandle> {
    throw new Error('not used');
  }
}

describe('SubAgentDefinitionRegistry', () => {
  it('keeps one active version model-visible and resolves recovery versions exactly', () => {
    const active = definition('research', '2');
    const old = definition('research', '1');
    const registry = new SubAgentDefinitionRegistry({
      activeDefinitions: [active],
      recoveryDefinitions: [old],
    });

    expect(registry.listActive()).toEqual([active]);
    expect(registry.listRecovery()).toEqual([old]);
    expect(registry.getActive('research')).toBe(active);
    expect(registry.getExact({ name: 'research', version: '1' })).toBe(old);
    expect(registry.getActive('missing')).toBeUndefined();
  });

  it('rejects duplicate active names and duplicate exact versions', () => {
    expect(
      () =>
        new SubAgentDefinitionRegistry({
          activeDefinitions: [definition('research', '1'), definition('research', '2')],
        }),
    ).toThrow(/active.+registered more than once/iu);

    const same = definition('research', '1');
    expect(
      () =>
        new SubAgentDefinitionRegistry({
          activeDefinitions: [same],
          recoveryDefinitions: [same],
        }),
    ).toThrow(/both active and recovery-only/iu);

    expect(
      () =>
        new SubAgentDefinitionRegistry({
          activeDefinitions: [definition('blocked', '1', { executorPolicy: { allowedNames: [] } })],
        }),
    ).toThrow(/empty Executor allowlist/iu);
  });
});

describe('SubAgentExecutorRegistry', () => {
  it('rejects duplicate names, mismatched codecs and contradictory capabilities synchronously', () => {
    const definitions = new SubAgentDefinitionRegistry({
      activeDefinitions: [definition('research', '1')],
    });
    expect(
      () =>
        new SubAgentExecutorRegistry({
          definitions,
          executors: [new FakeExecutor('local'), new FakeExecutor('local')],
        }),
    ).toThrow(/registered more than once/iu);

    const contradictory = new FakeExecutor('broken', {
      ...completeCapabilities,
      spawn: false,
      cancel: true,
    });
    expect(() => new SubAgentExecutorRegistry({ definitions, executors: [contradictory] })).toThrow(
      /require spawn/iu,
    );

    const mismatched = new FakeExecutor('codec');
    Object.defineProperty(mismatched, 'bindingCodec', {
      value: { adapterStateVersion: '2', encode: () => null, decode: () => null },
    });
    expect(() => new SubAgentExecutorRegistry({ definitions, executors: [mismatched] })).toThrow(
      /adapterStateVersion/iu,
    );
  });

  it('takes supports, advertised definitions, policy, capabilities and availability as an intersection', async () => {
    const active = definition('research', '2', {
      executorPolicy: {
        allowedNames: ['local', 'cheap'],
        requiredCapabilities: { usage: 'provider', resumeRecovery: 'same_process' },
      },
    });
    const definitions = new SubAgentDefinitionRegistry({ activeDefinitions: [active] });
    const local = new FakeExecutor('local');
    local.availability = {
      status: 'degraded',
      reasonCode: 'HIGH_LOAD',
      supportedDefinitions: [{ name: 'research', version: '2' }],
    };
    const cheap = new FakeExecutor('cheap', {
      ...completeCapabilities,
      usage: 'estimated',
    });
    const other = new FakeExecutor('other');

    const registry = new SubAgentExecutorRegistry({
      definitions,
      executors: [other, cheap, local],
      now: () => 100,
    });
    await registry.init();

    expect(registry.getCatalog()).toMatchObject({ revision: 1, capturedAt: 100 });
    expect(registry.getCatalogEntries()).toHaveLength(1);
    expect(registry.getCatalogEntries()[0]?.executors).toMatchObject([
      { name: 'local', status: 'degraded', reasonCode: 'HIGH_LOAD' },
    ]);
    expect(registry.select({ subAgent: 'research', executor: 'local' }).executor).toBe(local);
    expect(() => registry.select({ subAgent: 'research', executor: 'cheap' })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }),
    );
    expect(() => registry.select({ subAgent: 'research', executor: 'other' })).toThrowError(
      expect.objectContaining({ code: 'EXECUTOR_DISALLOWED' }),
    );

    const strictRegistry = new SubAgentExecutorRegistry({
      definitions,
      executors: [local],
      catalogPolicy: { allowDegraded: false },
    });
    await strictRegistry.init();
    expect(strictRegistry.getCatalogEntries()).toEqual([]);
    expect(() => strictRegistry.select({ subAgent: 'research', executor: 'local' })).toThrowError(
      expect.objectContaining({ code: 'EXECUTOR_UNAVAILABLE' }),
    );
  });

  it('keeps catalog reads offline and rejects a stale explicit target after refresh without fallback', async () => {
    let now = 10;
    const active = definition('research', '1');
    const definitions = new SubAgentDefinitionRegistry({ activeDefinitions: [active] });
    const selected = new FakeExecutor('selected');
    const fallback = new FakeExecutor('fallback');
    const registry = new SubAgentExecutorRegistry({
      definitions,
      executors: [selected, fallback],
      now: () => now,
    });

    await registry.init();
    expect(registry.select({ subAgent: 'research', executor: 'selected' })).toMatchObject({
      executor: selected,
      snapshotRevision: 1,
    });
    registry.getCatalogEntries();
    registry.getCatalogEntries();
    expect(selected.availabilityCalls).toBe(1);
    expect(selected.supportsCalls).toBe(1);

    selected.availability = { status: 'unavailable', reasonCode: 'OFFLINE' };
    expect(registry.select({ subAgent: 'research', executor: 'selected' }).executor).toBe(selected);
    now = 11;
    await registry.refreshCatalog();

    expect(registry.getCatalog()).toMatchObject({ revision: 2, capturedAt: 11 });
    expect(() => registry.select({ subAgent: 'research', executor: 'selected' })).toThrowError(
      expect.objectContaining({ code: 'EXECUTOR_UNAVAILABLE' }),
    );
    expect(registry.select({ subAgent: 'research', executor: 'fallback' }).executor).toBe(fallback);
    expect(selected.supportsCalls).toBe(1);
    expect(registry.getExecutor('selected')).toBe(selected);
    expect(registry.getAvailability('selected')).toMatchObject({ status: 'unavailable' });
  });

  it('uses stable errors for absent definitions and Executors', async () => {
    const definitions = new SubAgentDefinitionRegistry({
      activeDefinitions: [definition('research', '1')],
    });
    const registry = new SubAgentExecutorRegistry({
      definitions,
      executors: [new FakeExecutor('local')],
    });
    await registry.init();

    for (const [request, code] of [
      [{ subAgent: 'missing', executor: 'local' }, 'DEFINITION_NOT_FOUND'],
      [{ subAgent: 'research', executor: 'missing' }, 'EXECUTOR_NOT_FOUND'],
    ] as const) {
      try {
        registry.select(request);
        throw new Error('expected select to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(SubAgentRuntimeError);
        expect((error as SubAgentRuntimeError).code).toBe(code);
      }
    }
  });
});

acceptanceIt('DEF-02.l1.catalog', 'active-recovery', () => {
  const active = definition('acceptance', '2');
  const recovery = definition('acceptance', '1');
  const registry = new SubAgentDefinitionRegistry({
    activeDefinitions: [active],
    recoveryDefinitions: [recovery],
  });
  expect(registry.listActive()).toEqual([active]);
  expect(registry.getExact({ name: 'acceptance', version: '1' })).toBe(recovery);
});

acceptanceIt('EXE-04.l1.no-fallback', 'catalog-refresh', async () => {
  const definitions = new SubAgentDefinitionRegistry({
    activeDefinitions: [definition('acceptance', '1')],
  });
  const selected = new FakeExecutor('selected');
  const alternate = new FakeExecutor('alternate');
  const registry = new SubAgentExecutorRegistry({
    definitions,
    executors: [selected, alternate],
  });
  await registry.init();
  selected.availability = { status: 'unavailable' };
  await registry.refreshCatalog();
  expect(() => registry.select({ subAgent: 'acceptance', executor: 'selected' })).toThrowError(
    expect.objectContaining({ code: 'EXECUTOR_UNAVAILABLE' }),
  );
});
