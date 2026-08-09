import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  acceptanceIt,
  createExecutorConformanceControl,
  createExecutorConformanceRequest,
  runSubAgentExecutorConformance,
  type ExecutorConformanceScenario,
  type SubAgentExecutorConformanceSubject,
} from '../../../testkit';

import {
  SubAgentTargetRunnerRegistry,
  type JsonValue,
  type SubAgentDefinitionRegistration,
  type SubAgentExecutionOutcome,
  type SubAgentExecutionRequest,
  type SubAgentExecutorBinding,
  type SubAgentTargetRunnerManifest,
  type SubAgentTransportModelRequestHandler,
} from '@ruixutong.manee/maneeagent-framework';

import { ProcessSubAgentExecutor } from '../src';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const TARGET_ENTRY = new URL('./fixtures/process-conformance-target.mjs', import.meta.url);
const MISMATCHED_TARGET_ENTRY = new URL(
  './fixtures/process-mismatched-target.mjs',
  import.meta.url,
);
const DEFINITION_REF = Object.freeze({ name: 'process-conformance-child', version: '2' });

const manifestDefinition: SubAgentDefinitionRegistration = Object.freeze({
  name: DEFINITION_REF.name,
  version: DEFINITION_REF.version,
  description: 'Manifest-only erased Process conformance definition.',
  inputSchema: z.json(),
  outputSchema: z.json(),
});

function createExpectedManifest(): SubAgentTargetRunnerManifest {
  return new SubAgentTargetRunnerRegistry()
    .register({
      definition: manifestDefinition,
      runnerId: 'process-conformance-runner',
      runnerVersion: '2.0.0',
      childCheckpointVersions: ['1'],
      modelBinding: {
        gatewayId: 'process-conformance-model',
        protocol: 'openai-chat',
        codecVersion: '1',
      },
      create: () => ({
        run: async () => {
          throw new Error('The controller manifest registry must never create a runner.');
        },
      }),
    })
    .seal()
    .manifest();
}

function createExecutor(
  overrides: Partial<ConstructorParameters<typeof ProcessSubAgentExecutor>[0]> = {},
) {
  const model = vi.fn<SubAgentTransportModelRequestHandler>(async () => {
    throw new Error('The deterministic conformance target must not call the controller Model.');
  });
  const executor = new ProcessSubAgentExecutor({
    targetEntry: TARGET_ENTRY,
    expectedManifest: createExpectedManifest(),
    model,
    handshakeTimeoutMs: 5_000,
    terminateTimeoutMs: 100,
    ...overrides,
  });
  return { executor, model };
}

function createSubject(
  scenario: ExecutorConformanceScenario,
  executors: ProcessSubAgentExecutor[],
): SubAgentExecutorConformanceSubject {
  const { executor } = createExecutor();
  executors.push(executor);
  return {
    executor,
    definition: DEFINITION_REF,
    unsupportedDefinition: { name: 'process-unsupported', version: '1' },
    ...(scenario === 'cancel'
      ? {
          waitUntilStarted: async () => {
            await vi.waitFor(() => expect(executor.diagnostics().activeProcesses).toBe(1));
          },
        }
      : {}),
  };
}

function createRequest(
  taskId: string,
  scenario: string,
  overrides: Partial<SubAgentExecutionRequest> = {},
): SubAgentExecutionRequest {
  const base = createExecutorConformanceRequest({
    executorName: 'process',
    taskId,
    definition: DEFINITION_REF,
    input: { scenario },
  });
  return Object.freeze({ ...base, ...overrides });
}

function readSucceededOutput(result: Awaited<ReturnType<ProcessSubAgentExecutor['execute']>>) {
  expect(result).toMatchObject({ type: 'terminal', result: { status: 'succeeded' } });
  if (result.type !== 'terminal' || result.result.status !== 'succeeded') {
    throw new Error('Expected a successful Process execution.');
  }
  return result.result.output as {
    readonly answer: string;
    readonly details: Readonly<Record<string, JsonValue>>;
  };
}

describe('ProcessSubAgentExecutor unit and conformance', () => {
  acceptanceIt('C7-PROCESS-01.l2.conformance', 'child-process', async () => {
    const executors: ProcessSubAgentExecutor[] = [];
    try {
      await runSubAgentExecutorConformance({
        variant: 'child-process',
        createSubject: (scenario) => createSubject(scenario, executors),
      });
    } finally {
      await Promise.all(executors.map((executor) => executor.dispose()));
    }
  });

  acceptanceIt(
    'C7-PROCESS-02.l2.bootstrap-manifest-mismatch',
    'manifest-digest-and-canonical-body',
    async () => {
      const { executor, model } = createExecutor({ targetEntry: MISMATCHED_TARGET_ENTRY });
      const request = createRequest('process-manifest-mismatch', 'settle');
      const recorder = createExecutorConformanceControl({
        ownerSessionId: request.ownerSessionId,
        taskId: request.taskId,
        signal: request.signal,
        deadlineAt: request.deadlineAt,
        approval: 'approved',
      });
      try {
        await expect(executor.execute(request, recorder.control)).rejects.toMatchObject({
          code: 'BINDING_INVALID',
        });
        expect(model).not.toHaveBeenCalled();
        expect(recorder.snapshot()).toMatchObject({
          bindings: [],
          checkpoints: [],
          approvalInputs: [],
          progress: [],
          usage: [],
          events: [],
        });
        await vi.waitFor(() => {
          expect(executor.diagnostics()).toMatchObject({
            activeProcesses: 0,
            startingProcesses: 0,
            channels: 0,
            timers: 0,
          });
        });
      } finally {
        await executor.dispose();
      }
    },
  );

  acceptanceIt(
    'C7-PROCESS-03.l2.environment-secret-boundary',
    'env-argv-execargv-execpath',
    async () => {
      assertNetworkDenyGuardInstalled();
      const marker = `PROCESS_SECRET_${Date.now()}_MUST_NOT_CROSS`;
      const secretEnvironment = [
        'Ark_Api_Key',
        'Node_Options',
        'Node_Path',
        'Node_Extra_Ca_Certs',
        ...(process.platform === 'win32' ? [] : ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']),
        'ACCESS_TOKEN',
        'DATABASE_PASSWORD',
        'AUTH_COOKIE',
        'MANEE_PARENT_SECRET',
      ] as const;
      const previous = new Map(secretEnvironment.map((key) => [key, process.env[key]]));
      for (const key of secretEnvironment) process.env[key] = `${key}_${marker}`;
      const { executor, model } = createExecutor();
      const request = createRequest('process-environment', 'environment');
      const recorder = createExecutorConformanceControl({
        ownerSessionId: request.ownerSessionId,
        taskId: request.taskId,
        signal: request.signal,
        deadlineAt: request.deadlineAt,
        approval: 'approved',
      });
      try {
        const output = readSucceededOutput(await executor.execute(request, recorder.control));
        const evidence = JSON.stringify(output.details);
        expect(evidence).not.toContain(marker);
        expect(output.details.networkDenyInstalled).toBe(true);
        expect(output.details.execArgv).toEqual([]);
        expect(output.details.execPath).toBe(process.execPath);
        expect(output.details.connected).toBe(true);
        expect(output.details.argv).toEqual([process.execPath, fileURLToPath(TARGET_ENTRY)]);
        const envKeys = output.details.envKeys as readonly string[];
        const envValues = output.details.envValues as readonly string[];
        expect(envKeys.some((key) => key.toUpperCase() === 'PATH')).toBe(true);
        expect(output.details.path).toBe('');
        expect(
          envKeys.every(
            (key) =>
              !/(?:ARK_|NODE_|TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH|COOKIE|LD_|DYLD_)/iu.test(
                key,
              ),
          ),
        ).toBe(true);
        expect(envValues).not.toEqual(expect.arrayContaining([expect.stringContaining(marker)]));
        expect(model).not.toHaveBeenCalled();
      } finally {
        await executor.dispose();
        for (const key of secretEnvironment) restoreEnvironment(key, previous.get(key));
      }
    },
  );

  it('rejects environment injection and other unknown constructor options', () => {
    const base = {
      targetEntry: TARGET_ENTRY,
      expectedManifest: createExpectedManifest(),
      model: vi.fn<SubAgentTransportModelRequestHandler>(),
    };
    expect(
      () =>
        new ProcessSubAgentExecutor({
          ...base,
          environment: { MANEE_TEST: 'must-not-cross' },
        } as ConstructorParameters<typeof ProcessSubAgentExecutor>[0]),
    ).toThrow(/unknown|option|environment/u);
    expect(
      () =>
        new ProcessSubAgentExecutor({
          ...base,
          execPath: 'C:\\untrusted\\node.exe',
        } as ConstructorParameters<typeof ProcessSubAgentExecutor>[0]),
    ).toThrow(/unknown|option|execPath/u);
  });

  acceptanceIt(
    'C7-PROCESS-04.l2.static-entry-wire-boundary',
    'forged-entry-path-not-routable',
    async () => {
      const { executor, model } = createExecutor();
      const request = Object.freeze({
        ...createRequest('process-static-entry', 'settle'),
        targetEntry: 'file:///untrusted/runner.mjs',
        modulePath: '..\\untrusted\\runner.mjs',
      }) as SubAgentExecutionRequest & {
        readonly targetEntry: string;
        readonly modulePath: string;
      };
      const recorder = createExecutorConformanceControl({
        ownerSessionId: request.ownerSessionId,
        taskId: request.taskId,
        signal: request.signal,
        deadlineAt: request.deadlineAt,
        approval: 'approved',
      });
      try {
        const output = readSucceededOutput(await executor.execute(request, recorder.control));
        expect(output.answer).toBe('process:settle');
        expect(model).not.toHaveBeenCalled();
      } finally {
        await executor.dispose();
      }
    },
  );

  acceptanceIt(
    'C7-PROCESS-30.l2.fixed-fork-contract',
    'execpath-execargv-argv-ipc-parent',
    async () => {
      const { executor, model } = createExecutor();
      const request = createRequest('process-fixed-fork-contract', 'environment');
      const recorder = createExecutorConformanceControl({
        ownerSessionId: request.ownerSessionId,
        taskId: request.taskId,
        signal: request.signal,
        deadlineAt: request.deadlineAt,
        approval: 'approved',
      });
      try {
        const output = readSucceededOutput(await executor.execute(request, recorder.control));
        expect(output.details).toMatchObject({
          execPath: process.execPath,
          execArgv: [],
          argv: [process.execPath, fileURLToPath(TARGET_ENTRY)],
          connected: true,
          ppid: process.pid,
        });
        expect(model).not.toHaveBeenCalled();
      } finally {
        await executor.dispose();
      }
    },
  );

  it('rejects non-static, query, hash and UNC target entries during construction', () => {
    const options = {
      expectedManifest: createExpectedManifest(),
      model: vi.fn<SubAgentTransportModelRequestHandler>(),
    };
    expect(
      () =>
        new ProcessSubAgentExecutor({
          ...options,
          targetEntry: new URL(`${TARGET_ENTRY.href}?runner=other`),
        }),
    ).toThrow(/query|search/u);
    expect(
      () =>
        new ProcessSubAgentExecutor({
          ...options,
          targetEntry: new URL(`${TARGET_ENTRY.href}#runner`),
        }),
    ).toThrow(/hash|fragment/u);
    expect(
      () =>
        new ProcessSubAgentExecutor({
          ...options,
          targetEntry: new URL('https://example.invalid/process.mjs'),
        }),
    ).toThrow(/file/u);
    expect(
      () =>
        new ProcessSubAgentExecutor({
          ...options,
          targetEntry: new URL('file://server/share/process.mjs'),
        }),
    ).toThrow(/UNC|host/u);
  });

  acceptanceIt(
    'C7-PROCESS-05.l2.session-task-isolation',
    'owner-session-and-job-scope',
    async () => {
      const { executor } = createExecutor();
      const first = createScopedRequest('process-session-a', 'process-task-a');
      const second = createScopedRequest('process-session-b', 'process-task-b');
      const firstControl = createExecutorConformanceControl({
        ownerSessionId: first.ownerSessionId,
        taskId: first.taskId,
        signal: first.signal,
        deadlineAt: first.deadlineAt,
        approval: 'approved',
      });
      const secondControl = createExecutorConformanceControl({
        ownerSessionId: second.ownerSessionId,
        taskId: second.taskId,
        signal: second.signal,
        deadlineAt: second.deadlineAt,
        approval: 'approved',
      });
      try {
        const [firstResult, secondResult] = await Promise.all([
          executor.execute(first, firstControl.control),
          executor.execute(second, secondControl.control),
        ]);
        const firstOutput = readSucceededOutput(firstResult);
        const secondOutput = readSucceededOutput(secondResult);
        expect(firstOutput.details).toMatchObject({
          ownerSessionId: 'process-session-a',
          taskId: 'process-task-a',
        });
        expect(secondOutput.details).toMatchObject({
          ownerSessionId: 'process-session-b',
          taskId: 'process-task-b',
        });
        expect(firstOutput.details.processPid).not.toBe(secondOutput.details.processPid);

        const firstBinding = onlyBinding(firstControl.snapshot().bindings);
        const forgedBinding = Object.freeze({
          ...firstBinding,
          ownerSessionId: second.ownerSessionId,
        });
        await expect(
          executor.cancel(forgedBinding, {
            operationId: 'cross-session-cancel',
            signal: new AbortController().signal,
            deadlineAt: Date.now() + 1_000,
          }),
        ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      } finally {
        await executor.dispose();
      }
    },
  );

  acceptanceIt('C7-PROCESS-06.l2.reconnect-none', 'checkpoint-only', async () => {
    const { executor } = createExecutor();
    const request = createRequest('process-reconnect-none', 'settle');
    const recorder = createExecutorConformanceControl({
      ownerSessionId: request.ownerSessionId,
      taskId: request.taskId,
      signal: request.signal,
      deadlineAt: request.deadlineAt,
      approval: 'approved',
    });
    try {
      await executor.execute(request, recorder.control);
      const binding = onlyBinding(recorder.snapshot().bindings);
      const reconnect = createRequest(request.taskId, 'settle', {
        operation: {
          type: 'reconnect',
          operationId: 'process-reconnect-operation',
          binding,
        },
        attempt: 2,
        executionEpoch: 'process-reconnect-epoch-2',
        executionFencingToken: '2',
      });
      await expect(executor.execute(reconnect, recorder.control)).rejects.toMatchObject({
        code: 'RECOVERY_UNSUPPORTED',
      });
      expect(executor.descriptor.capabilities.recovery).toEqual({
        resume: 'checkpoint',
        reconnect: 'none',
      });
    } finally {
      await executor.dispose();
    }
  });

  acceptanceIt('C7-PROCESS-07.l2.resource-cleanup', 'bounded-terminal-retention', async () => {
    const { executor } = createExecutor({ maxRetainedTasks: 2 });
    try {
      const retained: Array<{
        readonly request: SubAgentExecutionRequest;
        readonly recorder: ReturnType<typeof createExecutorConformanceControl>;
        readonly outcome: SubAgentExecutionOutcome;
      }> = [];
      for (let index = 0; index < 2; index += 1) {
        const request = createRequest(`process-cleanup-${index}`, 'settle');
        const recorder = createExecutorConformanceControl({
          ownerSessionId: request.ownerSessionId,
          taskId: request.taskId,
          signal: request.signal,
          deadlineAt: request.deadlineAt,
          approval: 'approved',
        });
        const outcome = await executor.execute(request, recorder.control);
        readSucceededOutput(outcome);
        if (outcome.type === 'recovery_required') throw new Error('Expected a terminal outcome.');
        retained.push({ request, recorder, outcome });
        await vi.waitFor(() => {
          expect(executor.diagnostics()).toMatchObject({
            activeProcesses: 0,
            startingProcesses: 0,
            channels: 0,
            timers: 0,
          });
        });
      }
      expect(executor.diagnostics().retainedTasks).toBe(2);
      expect(executor.getAvailability()).toMatchObject({
        status: 'unavailable',
        reasonCode: 'PROCESS_RETENTION_CAPACITY',
      });

      const overflow = createRequest('process-cleanup-overflow', 'settle');
      const overflowRecorder = createExecutorConformanceControl({
        ownerSessionId: overflow.ownerSessionId,
        taskId: overflow.taskId,
        signal: overflow.signal,
        deadlineAt: overflow.deadlineAt,
        approval: 'approved',
      });
      await expect(executor.execute(overflow, overflowRecorder.control)).rejects.toMatchObject({
        code: 'EXECUTOR_UNAVAILABLE',
      });
      expect(executor.diagnostics().retainedTasks).toBe(2);

      const first = retained[0]!;
      await expect(executor.execute(first.request, first.recorder.control)).resolves.toEqual(
        first.outcome,
      );
      expect(first.recorder.snapshot().bindings).toHaveLength(1);

      await executor.drain();
      expect(executor.diagnostics().draining).toBe(true);
      const rejected = createRequest('process-after-drain', 'settle');
      const recorder = createExecutorConformanceControl({
        ownerSessionId: rejected.ownerSessionId,
        taskId: rejected.taskId,
        signal: rejected.signal,
        deadlineAt: rejected.deadlineAt,
        approval: 'approved',
      });
      await expect(executor.execute(rejected, recorder.control)).rejects.toMatchObject({
        code: 'EXECUTOR_UNAVAILABLE',
      });
    } finally {
      await executor.dispose();
      await executor.dispose();
    }
    expect(executor.diagnostics()).toMatchObject({
      activeProcesses: 0,
      startingProcesses: 0,
      retainedTasks: 0,
      channels: 0,
      timers: 0,
      disposed: true,
    });
  });
});

function createScopedRequest(ownerSessionId: string, taskId: string): SubAgentExecutionRequest {
  const base = createRequest(taskId, 'isolation');
  const parentTaskId = `parent-${taskId}`;
  return Object.freeze({
    ...base,
    ownerSessionId,
    runId: `run-${taskId}`,
    taskId,
    subagentSessionId: `subagent-session-${taskId}`,
    parentTaskId,
    path: Object.freeze([parentTaskId, taskId]),
    operation: Object.freeze({
      type: 'create' as const,
      operationId: `create-${taskId}`,
      idempotencyKey: `idempotency-${taskId}`,
    }),
    executionEpoch: `epoch-${taskId}`,
    delegation: Object.freeze({
      ...base.delegation,
      ownerSessionId,
      runId: `run-${taskId}`,
      parentTaskId: taskId,
      path: Object.freeze([parentTaskId, taskId]),
      depth: 2,
    }),
  });
}

function onlyBinding(bindings: readonly SubAgentExecutorBinding[]): SubAgentExecutorBinding {
  expect(bindings).toHaveLength(1);
  return bindings[0]!;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
