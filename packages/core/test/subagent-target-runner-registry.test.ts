import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { acceptanceIt } from '../../../testkit';

import type { SubAgentChildCheckpoint } from '../src/subagent/checkpoint';
import type { SubAgentChildRunner } from '../src/subagent/child-runner';
import { defineSubAgent, type SubAgentDefinition } from '../src/subagent/definition';
import { SubAgentRuntimeError, type SubAgentErrorCode } from '../src/subagent/errors';
import type { SubAgentExecutionRequest, SubAgentExecutorBinding } from '../src/subagent/executor';
import { canonicalJsonSha256, type JsonValue } from '../src/subagent/json';
import { DEFAULT_SUBAGENT_LIMITS } from '../src/subagent/limits';
import {
  SubAgentTargetRunnerRegistry,
  type SubAgentTargetRunnerRegistration,
} from '../src/subagent/target-runner-registry';

const inertRunner: SubAgentChildRunner = {
  run: async () => {
    throw new Error('The runner is not executed by registry tests.');
  },
};

function createDefinition(
  name = 'reviewer',
  version = '2',
  inputSchema: SubAgentDefinition['inputSchema'] = z.object({ query: z.string() }),
): SubAgentDefinition {
  return defineSubAgent({
    name,
    version,
    description: `Run ${name}.`,
    inputSchema,
    outputSchema: z.object({ answer: z.string() }),
  });
}

function createRegistration(
  definition = createDefinition(),
  overrides: Partial<SubAgentTargetRunnerRegistration> = {},
  includeModelBinding = true,
): SubAgentTargetRunnerRegistration {
  return {
    definition,
    runnerId: 'builtin-child-runner',
    runnerVersion: '1',
    childCheckpointVersions: ['1'],
    ...(includeModelBinding
      ? {
          modelBinding: {
            gatewayId: 'controller-model',
            protocol: 'test-protocol',
            codecVersion: '1',
          },
        }
      : {}),
    create: () => inertRunner,
    ...overrides,
  };
}

function createExecutionRequest(
  input: JsonValue = { query: 'hello' },
  overrides: Partial<SubAgentExecutionRequest> = {},
): SubAgentExecutionRequest {
  return {
    operation: {
      type: 'create',
      operationId: 'operation-1',
      idempotencyKey: 'request-1',
    },
    ownerSessionId: 'owner-session-1',
    runId: 'run-1',
    taskId: 'task-1',
    subagentSessionId: 'subagent-session-1',
    path: ['task-1'],
    attempt: 1,
    executionEpoch: 'epoch-1',
    executionFencingToken: '1',
    definition: { name: 'reviewer', version: '2' },
    input,
    projectedContext: [{ kind: 'text', name: 'brief', text: 'Be concise.' }],
    delegation: {
      version: '1',
      ownerSessionId: 'owner-session-1',
      runId: 'run-1',
      parentTaskId: 'task-1',
      path: ['task-1'],
      depth: 1,
      catalogRevision: 1,
      definitions: [{ name: 'writer', version: '1', executors: ['local'] }],
    },
    limits: DEFAULT_SUBAGENT_LIMITS,
    signal: new AbortController().signal,
    deadlineAt: 121_000,
    ...overrides,
  };
}

function createBinding(
  overrides: Partial<SubAgentExecutorBinding> = {},
  includeModelBinding = true,
): SubAgentExecutorBinding {
  return {
    version: '1',
    executorName: 'process',
    ownerSessionId: 'owner-session-1',
    taskId: 'task-1',
    subagentSessionId: 'subagent-session-1',
    definitionName: 'reviewer',
    definitionVersion: '2',
    runnerId: 'builtin-child-runner',
    runnerVersion: '1',
    adapterStateVersion: '1',
    ...(includeModelBinding
      ? {
          modelBinding: {
            gatewayId: 'controller-model',
            protocol: 'test-protocol',
            codecVersion: '1',
          },
        }
      : {}),
    recoveryData: { kind: 'process/v1', jobId: 'job-1' },
    ...overrides,
  };
}

function createCheckpoint(
  overrides: Partial<SubAgentChildCheckpoint> = {},
): SubAgentChildCheckpoint {
  return {
    version: '1',
    runnerId: 'builtin-child-runner',
    runnerVersion: '1',
    protocolContext: { protocol: 'openai-chat', codecVersion: '1', value: [] },
    contextStore: {
      version: '1',
      protocol: 'openai-chat',
      codecVersion: '1',
      revision: 0,
      rawHistory: [],
      activeSpans: [],
      nextRawItemId: 1,
      nextSpanId: 1,
      nextEntryId: 1,
    },
    modelIteration: 0,
    maxIterations: 6,
    ...overrides,
  };
}

function createResumeRequest(
  binding = createBinding(),
  checkpoint = createCheckpoint(),
): SubAgentExecutionRequest {
  return createExecutionRequest(undefined, {
    operation: {
      type: 'resume',
      operationId: 'resume-1',
      reason: 'checkpoint',
      binding,
      checkpoint,
    },
  });
}

function expectRuntimeCode(action: () => unknown, code: SubAgentErrorCode): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(SubAgentRuntimeError);
  expect((failure as SubAgentRuntimeError).code).toBe(code);
}

describe('SubAgentTargetRunnerRegistry registration and manifest', () => {
  it('snapshots full definitions and compatibility before becoming immutable', () => {
    const schema = z.object({ query: z.string() });
    const definition = {
      name: 'reviewer',
      version: '2',
      description: 'Original description.',
      inputSchema: schema,
      outputSchema: z.object({ answer: z.string() }),
    } satisfies SubAgentDefinition<{ query: string }, { answer: string }>;
    const checkpointVersions = ['2', '1'];
    const registration = {
      definition,
      runnerId: 'runner-a',
      runnerVersion: '3',
      childCheckpointVersions: checkpointVersions,
      create: () => inertRunner,
    } satisfies SubAgentTargetRunnerRegistration<{ query: string }, { answer: string }>;

    const registry = new SubAgentTargetRunnerRegistry().register(registration).seal();
    definition.name = 'mutated';
    definition.description = 'Mutated description.';
    checkpointVersions.push('9');

    expect(registry.sealed).toBe(true);
    expect(registry.list()).toEqual([{ name: 'reviewer', version: '2' }]);
    expect(registry.definitionFor({ name: 'reviewer', version: '2' })).toMatchObject({
      name: 'reviewer',
      version: '2',
      description: 'Original description.',
      inputSchema: schema,
    });
    expect(registry.runnerFor({ name: 'reviewer', version: '2' })).toEqual({
      runnerId: 'runner-a',
      runnerVersion: '3',
      childCheckpointVersions: ['1', '2'],
    });
    expect(Object.isFrozen(registry.definitionFor({ name: 'reviewer', version: '2' }))).toBe(true);
    expect(() => registry.register(createRegistration())).toThrow(/sealed/u);
  });

  acceptanceIt('C7-GATEWAY-02.l1.target-registry', 'target-registry', () => {
    const alpha = createRegistration(createDefinition('alpha', '1'), {
      runnerId: 'runner-alpha',
      runnerVersion: '2',
      childCheckpointVersions: ['2', '1'],
    });
    const omega = createRegistration(createDefinition('omega', '3'), {
      runnerId: 'runner-omega',
      runnerVersion: '1',
    });
    const forwardRegistry = new SubAgentTargetRunnerRegistry([alpha, omega]).seal();
    const reverseRegistry = new SubAgentTargetRunnerRegistry([omega, alpha]).seal();
    expect(() => forwardRegistry.assertTransportReady()).not.toThrow();
    expect(() => reverseRegistry.assertTransportReady()).not.toThrow();
    const forward = forwardRegistry.manifest();
    const reverse = reverseRegistry.manifest();
    const { digest, ...body } = forward;

    expect(forward).toEqual(reverse);
    expect(digest).toBe(canonicalJsonSha256(body as unknown as JsonValue));
    expect(forward.registrations.map(({ definition }) => definition.name)).toEqual([
      'alpha',
      'omega',
    ]);
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.registrations)).toBe(true);
    expect(Object.isFrozen(forward.registrations[0]?.runner.childCheckpointVersions)).toBe(true);
    expect(forward.registrations[0]?.modelBinding).toEqual({
      gatewayId: 'controller-model',
      protocol: 'test-protocol',
      codecVersion: '1',
    });
    expect(Object.isFrozen(forward.registrations[0]?.modelBinding)).toBe(true);

    const localOnly = new SubAgentTargetRunnerRegistry([
      createRegistration(createDefinition('local-only', '1'), {}, false),
    ]).seal();
    expect(() => localOnly.assertTransportReady()).toThrow(/protocol\/codec\/Model gateway/u);
  });

  it('rejects duplicate, incomplete and conflicting runner identities during registration', () => {
    const definition = createDefinition();
    const duplicate = new SubAgentTargetRunnerRegistry([createRegistration(definition)]);
    expect(() => duplicate.register(createRegistration(definition))).toThrow(/already registered/u);

    expect(
      () =>
        new SubAgentTargetRunnerRegistry([
          createRegistration(createDefinition('a', '1'), {
            runnerId: 'shared',
            childCheckpointVersions: ['1'],
          }),
          createRegistration(createDefinition('b', '1'), {
            runnerId: 'shared',
            childCheckpointVersions: ['2'],
          }),
        ]),
    ).toThrow(/checkpoint-version set/u);
    expect(
      () =>
        new SubAgentTargetRunnerRegistry([
          createRegistration(definition, { childCheckpointVersions: [] }),
        ]),
    ).toThrow(/non-empty/u);
    expect(
      () =>
        new SubAgentTargetRunnerRegistry([
          createRegistration(definition, {
            modelBinding: {
              gatewayId: 'controller-model',
              protocol: 'test-protocol',
              codecVersion: '01 invalid',
            },
          }),
        ]),
    ).toThrow(/codecVersion/u);
  });
});

describe('SubAgentTargetRunnerRegistry execution preparation', () => {
  it('applies the target Zod transform and gives the factory an owned frozen request once', async () => {
    const definition = defineSubAgent({
      name: 'reviewer',
      version: '2',
      description: 'Normalize one query.',
      inputSchema: z.object({ query: z.string() }).transform(({ query }) => ({
        query: query.trim(),
        normalized: true as const,
      })),
      outputSchema: z.object({ answer: z.string() }),
    });
    const contexts: unknown[] = [];
    const factory = vi.fn((context) => {
      contexts.push(context);
      return inertRunner;
    });
    const registry = new SubAgentTargetRunnerRegistry([
      {
        definition,
        runnerId: 'builtin-child-runner',
        runnerVersion: '1',
        childCheckpointVersions: ['1'],
        create: factory,
      },
    ]).seal();
    const sourceInput = { query: '  original  ' };
    const sourcePath = ['task-1'];
    const sourceProjection = [{ kind: 'text' as const, name: 'brief', text: 'Original.' }];
    const sourceExecutors = ['local'];
    const request = createExecutionRequest(sourceInput, {
      path: sourcePath,
      projectedContext: sourceProjection,
      delegation: {
        version: '1',
        ownerSessionId: 'owner-session-1',
        runId: 'run-1',
        parentTaskId: 'task-1',
        path: sourcePath,
        depth: 1,
        catalogRevision: 1,
        definitions: [{ name: 'writer', version: '1', executors: sourceExecutors }],
      },
    });

    const prepared = registry.prepareExecution(request, 'process');
    sourceInput.query = 'mutated';
    sourcePath.push('mutated');
    sourceProjection[0]!.text = 'Mutated.';
    sourceExecutors.push('remote');

    expect(prepared.request.input).toEqual({ query: 'original', normalized: true });
    expect(prepared.request.path).toEqual(['task-1']);
    expect(prepared.request.projectedContext).toEqual([
      { kind: 'text', name: 'brief', text: 'Original.' },
    ]);
    expect(prepared.request.delegation.definitions[0]?.executors).toEqual(['local']);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.request)).toBe(true);
    expect(Object.isFrozen(prepared.request.input)).toBe(true);
    expect(Object.isFrozen(prepared.request.delegation.definitions)).toBe(true);
    expect(factory).not.toHaveBeenCalled();

    await expect(prepared.create()).resolves.toBe(inertRunner);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(contexts[0]).toMatchObject({
      request: prepared.request,
      definition: { name: 'reviewer', version: '2' },
      executorName: 'process',
    });
    expect(Object.isFrozen(contexts[0])).toBe(true);
    await expect(prepared.create()).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('fails closed on unknown and unavailable exact definition versions before the factory', () => {
    const factory = vi.fn(() => inertRunner);
    const registry = new SubAgentTargetRunnerRegistry([
      createRegistration(createDefinition(), { create: factory }),
    ]).seal();

    expectRuntimeCode(
      () =>
        registry.prepareExecution(
          createExecutionRequest(undefined, { definition: { name: 'missing', version: '2' } }),
          'process',
        ),
      'DEFINITION_NOT_FOUND',
    );
    expectRuntimeCode(
      () =>
        registry.prepareExecution(
          createExecutionRequest(undefined, { definition: { name: 'reviewer', version: '1' } }),
          'process',
        ),
      'DEFINITION_VERSION_MISMATCH',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects schema failures, Proxy/non-JSON outputs and the 256 KiB boundary before the factory', () => {
    const factory = vi.fn(() => inertRunner);
    const passthrough = z.custom<JsonValue>(() => true);
    const registry = new SubAgentTargetRunnerRegistry([
      createRegistration(createDefinition('reviewer', '2', passthrough), { create: factory }),
    ]).seal();
    const proxy = new Proxy({ query: 'hidden' }, {});

    for (const candidate of [
      new Date(0),
      proxy,
      { value: undefined },
      'x'.repeat(256 * 1024 + 1),
    ]) {
      expectRuntimeCode(
        () => registry.prepareExecution(createExecutionRequest(candidate as JsonValue), 'process'),
        'INVALID_INPUT',
      );
    }
    expect(factory).not.toHaveBeenCalled();

    const strict = new SubAgentTargetRunnerRegistry([
      createRegistration(createDefinition(), { create: factory }),
    ]).seal();
    expectRuntimeCode(
      () => strict.prepareExecution(createExecutionRequest({ query: 1 }), 'process'),
      'INVALID_INPUT',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('accepts only exact resume binding and child checkpoint compatibility', async () => {
    const factory = vi.fn(() => inertRunner);
    const registry = new SubAgentTargetRunnerRegistry([
      createRegistration(createDefinition(), {
        create: factory,
        childCheckpointVersions: ['2', '1'],
      }),
    ]).seal();
    const checkpoint = createCheckpoint();
    const prepared = registry.prepareExecution(
      createResumeRequest(createBinding(), checkpoint),
      'process',
    );

    expect(prepared.request.checkpoint).toEqual(checkpoint);
    expect(prepared.request.checkpoint).not.toBe(checkpoint);
    expect(Object.isFrozen(prepared.request.checkpoint)).toBe(true);
    await prepared.create();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  acceptanceIt('C7-GATEWAY-21.l1.durable-model-binding', 'gateway-binding-recovery-fence', () => {
    const factory = vi.fn(() => inertRunner);
    const registry = new SubAgentTargetRunnerRegistry([
      createRegistration(createDefinition(), { create: factory }),
    ]).seal();

    for (const binding of [
      createBinding({ executorName: 'worker' }),
      createBinding({ ownerSessionId: 'other-session' }),
      createBinding({ taskId: 'other-task' }),
      createBinding({ definitionVersion: '1' }),
      createBinding({ runnerId: 'other-runner' }),
      createBinding({ runnerVersion: '2' }),
      createBinding({}, false),
      createBinding({
        modelBinding: {
          gatewayId: 'replacement-controller-model',
          protocol: 'test-protocol',
          codecVersion: '1',
        },
      }),
    ]) {
      expectRuntimeCode(
        () => registry.prepareExecution(createResumeRequest(binding), 'process'),
        'BINDING_INVALID',
      );
    }
    for (const checkpoint of [
      createCheckpoint({ version: '2' as '1' }),
      createCheckpoint({ runnerId: 'other-runner' }),
      createCheckpoint({ runnerVersion: '2' }),
    ]) {
      expectRuntimeCode(
        () =>
          registry.prepareExecution(createResumeRequest(createBinding(), checkpoint), 'process'),
        'CHECKPOINT_VERSION_MISMATCH',
      );
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('validates reconnect binding but never creates a replacement runner', () => {
    const factory = vi.fn(() => inertRunner);
    const registry = new SubAgentTargetRunnerRegistry([
      createRegistration(createDefinition(), { create: factory }),
    ]).seal();
    const request = createExecutionRequest(undefined, {
      operation: {
        type: 'reconnect',
        operationId: 'reconnect-1',
        binding: createBinding(),
      },
    });

    expectRuntimeCode(() => registry.prepareExecution(request, 'process'), 'RECOVERY_UNSUPPORTED');
    expect(factory).not.toHaveBeenCalled();
  });
});
