import { assertProcessNetworkDenyInstalled } from './process-network-deny.mjs';

import process from 'node:process';
import { z } from 'zod';

import {
  canonicalJsonSha256,
  defineSubAgent,
  SubAgentTargetRunnerRegistry,
} from '../../../core/dist/index.js';
import { serveProcessSubAgentTarget } from '../../dist/index.js';

assertProcessNetworkDenyInstalled();

const definition = defineSubAgent({
  name: 'process-conformance-child',
  version: '2',
  description: 'Run deterministic Process placement conformance scenarios.',
  inputSchema: z
    .object({
      scenario: z.string().min(1),
      marker: z.string().default(''),
    })
    .strict(),
  outputSchema: z
    .object({
      answer: z.string(),
      details: z.record(z.string(), z.json()),
    })
    .strict(),
});

const runnerVersion = '2.0.0';
let factoryCreates = 0;

const nestedExecutorDescriptor = Object.freeze({
  runtimeProtocolVersion: '1',
  taskRecordVersions: Object.freeze(['1']),
  childCheckpointVersions: Object.freeze(['1']),
  runnerCompatibility: Object.freeze([
    Object.freeze({
      runnerId: 'process-conformance-runner',
      runnerVersion,
      childCheckpointVersions: Object.freeze(['1']),
    }),
  ]),
  name: 'process',
  description: 'Process conformance nested placement.',
  useCases: Object.freeze(['nested lifecycle verification']),
  capabilities: Object.freeze({
    execute: true,
    spawn: true,
    cancel: true,
    events: true,
    approval: true,
    usage: 'provider',
    recovery: Object.freeze({ resume: 'checkpoint', reconnect: 'none' }),
  }),
  adapterStateVersion: '1',
  maxBindingBytes: 64 * 1024,
  maxEventPageSize: 256,
});

const nestedCatalog = Object.freeze({
  catalog: Object.freeze({
    revision: 1,
    capturedAt: 1_000,
    executors: Object.freeze([
      Object.freeze({
        descriptor: nestedExecutorDescriptor,
        status: 'available',
        supportedDefinitions: Object.freeze([
          Object.freeze({ name: definition.name, version: definition.version }),
        ]),
      }),
    ]),
  }),
  catalogEntries: Object.freeze([
    Object.freeze({
      definition: Object.freeze({ name: definition.name, version: definition.version }),
      description: definition.description,
      inputSchema: definition.inputSchema,
      executors: Object.freeze([
        Object.freeze({ ...nestedExecutorDescriptor, status: 'available' }),
      ]),
    }),
  ]),
});

const registry = new SubAgentTargetRunnerRegistry()
  .register({
    definition,
    runnerId: 'process-conformance-runner',
    runnerVersion,
    childCheckpointVersions: ['1'],
    modelBinding: {
      gatewayId: 'process-conformance-model',
      protocol: 'openai-chat',
      codecVersion: '1',
    },
    create: ({ executorName, request }) => {
      if (request.input.scenario === 'post-admission-crash' && request.attempt === 1) {
        process.exit(72);
      }
      factoryCreates += 1;
      return {
        async run(child, control) {
          const scenario = normalizeScenario(child.input.scenario);

          if (scenario === 'cancel' || scenario === 'terminate-fallback') {
            if (scenario === 'terminate-fallback') {
              // Prove the controller does not equate a successful SIGTERM send with exit/close.
              process.on('SIGTERM', () => undefined);
            }
            return await new Promise((resolve) => {
              if (scenario === 'cancel') {
                child.signal.addEventListener(
                  'abort',
                  async () => {
                    await control.reportProgress('process-cancel-observed', {
                      message: 'process-cancel-observed',
                      data: { taskId: child.taskId },
                    });
                    resolve({
                      type: 'terminal',
                      result: {
                        status: 'cancelled',
                        task: { taskId: child.taskId, subAgent: child.definition },
                        executor: executorName,
                        error: {
                          code: 'CANCELLED',
                          message: 'The Process child execution was cancelled.',
                          retryable: false,
                        },
                      },
                    });
                  },
                  { once: true },
                );
              }
              // terminate-fallback intentionally ignores the protocol signal so the
              // controller must use its bounded Process.terminate() fallback.
            });
          }

          if (scenario === 'approval-resume' && child.checkpoint === undefined) {
            const checkpoint = createApprovalCheckpoint();
            const directive = await control.authorizeTool(
              'process-conformance-approval',
              {
                callId: 'conformance-sensitive-call',
                toolName: 'conformance-sensitive-tool',
                summary: 'Approve the deterministic Process conformance action.',
              },
              checkpoint,
            );
            if (directive.type !== 'suspend') {
              throw new Error('The first Process approval conformance run must suspend.');
            }
            return {
              type: 'paused',
              reason: 'approval',
              task: { taskId: child.taskId, subAgent: child.definition },
              approvals: [directive.request],
              checkpointRevision: directive.checkpointRevision,
            };
          }

          if (
            scenario === 'approval-resume' &&
            child.checkpoint !== undefined &&
            child.input.marker === 'terminate-fallback-on-resume'
          ) {
            return await new Promise(() => undefined);
          }

          if (scenario === 'checkpoint-crash' && child.checkpoint === undefined) {
            await control.commitCheckpoint(
              'process-checkpoint-before-crash',
              createCrashCheckpoint(),
            );
            process.exit(73);
          }

          if (
            scenario === 'checkpoint-crash' &&
            child.checkpoint !== undefined &&
            child.input.marker === 'crash-on-resume'
          ) {
            await control.reportProgress('process-resume-scope-evidence', {
              message: 'process-resume-scope',
              data: {
                attempt: child.attempt,
                executionEpoch: child.executionEpoch,
                executionFencingToken: child.executionFencingToken,
              },
            });
            process.exit(74);
          }

          if (
            scenario === 'checkpoint-crash' &&
            child.checkpoint !== undefined &&
            child.input.marker === 'stdout-overflow-on-resume'
          ) {
            process.stdout.write('x'.repeat(65 * 1024));
            return await new Promise(() => undefined);
          }

          if (scenario === 'output-secret') {
            process.stdout.write(`stdout:${child.input.marker ?? ''}`);
            process.stderr.write(`stderr:${child.input.marker ?? ''}`);
          }

          if (scenario === 'stdout-overflow') {
            process.stdout.write('x'.repeat(65 * 1024));
            return await new Promise(() => undefined);
          }

          if (scenario === 'stdout-overflow-delayed') {
            await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
            process.stdout.write('x'.repeat(65 * 1024));
            return await new Promise(() => undefined);
          }

          if (scenario === 'nested-spawn-wait') {
            const nested = await control.delegation.spawn({
              requestId: `nested:${child.taskId}`,
              subAgent: definition.name,
              executor: nestedExecutorDescriptor.name,
              input: { scenario: 'settle', marker: `nested:${child.taskId}` },
            });
            const outcomes = [await nested.wait(), await nested.wait()];
            const statuses = outcomes.map((outcome) => {
              if (outcome.type !== 'terminal') {
                throw new Error('The nested lifecycle fixture requires a terminal child outcome.');
              }
              return outcome.result.status;
            });
            const output = {
              answer: 'process:nested-spawn-wait',
              details: { nestedTaskId: nested.taskId, statuses },
            };
            await control.completion.submitResult('process-result:nested-spawn-wait', output);
            await control.completion.complete('process-end:nested-spawn-wait', {
              isStandalone: true,
            });
            return {
              type: 'terminal',
              result: {
                status: 'succeeded',
                task: { taskId: child.taskId, subAgent: child.definition },
                executor: executorName,
                output,
              },
            };
          }

          const details =
            scenario === 'environment'
              ? readEnvironmentEvidence()
              : scenario === 'isolation'
                ? {
                    ownerSessionId: child.ownerSessionId,
                    taskId: child.taskId,
                    processPid: process.pid,
                  }
                : { factoryCreates };
          const output = {
            answer: `process:${scenario}`,
            details: details ?? {},
          };
          await control.completion.submitResult(`process-result:${scenario}`, output);
          await control.completion.complete(`process-end:${scenario}`, { isStandalone: true });
          return {
            type: 'terminal',
            result: {
              status: 'succeeded',
              task: { taskId: child.taskId, subAgent: child.definition },
              executor: executorName,
              output,
            },
          };
        },
      };
    },
  })
  .seal();

await serveProcessSubAgentTarget({
  createRegistry: () => registry,
  resolveCatalog: () => nestedCatalog,
});

function createApprovalCheckpoint() {
  const input = {};
  return {
    version: '1',
    runnerId: 'process-conformance-runner',
    runnerVersion,
    protocolContext: { protocol: 'openai-chat', codecVersion: '1', value: [] },
    contextStore: {
      version: '1',
      protocol: 'openai-chat',
      codecVersion: '1',
      revision: 0,
      rawHistory: [],
      activeSpans: [
        {
          spanId: 'context-span-1',
          kind: 'seed',
          closed: true,
          originalContext: [],
          entries: [],
        },
      ],
      nextRawItemId: 1,
      nextSpanId: 2,
      nextEntryId: 1,
    },
    modelIteration: 1,
    maxIterations: 4,
    pendingBatch: {
      version: '1',
      batchId: 'process-conformance-approval-batch',
      assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
      calls: [
        {
          version: '1',
          operationId: 'process-conformance-sensitive-operation',
          kind: 'tool',
          callId: 'conformance-sensitive-call',
          name: 'conformance-sensitive-tool',
          input,
          inputHash: canonicalJsonSha256(input),
          status: 'in_flight',
          order: 0,
        },
      ],
      endRequested: false,
      createdAt: 1,
    },
  };
}

function createCrashCheckpoint() {
  return {
    version: '1',
    runnerId: 'process-conformance-runner',
    runnerVersion,
    protocolContext: { protocol: 'openai-chat', codecVersion: '1', value: [] },
    contextStore: {
      version: '1',
      protocol: 'openai-chat',
      codecVersion: '1',
      revision: 0,
      rawHistory: [],
      activeSpans: [
        {
          spanId: 'context-span-1',
          kind: 'seed',
          closed: true,
          originalContext: [],
          entries: [],
        },
      ],
      nextRawItemId: 1,
      nextSpanId: 2,
      nextEntryId: 1,
    },
    modelIteration: 0,
    maxIterations: 4,
  };
}

function readEnvironmentEvidence() {
  return {
    networkDenyInstalled: true,
    envKeys: Object.keys(process.env).sort(),
    envValues: Object.values(process.env).filter((value) => typeof value === 'string'),
    path: process.env.PATH ?? null,
    argv: [...process.argv],
    execArgv: [...process.execArgv],
    execPath: process.execPath,
    connected: process.connected,
    pid: process.pid,
    ppid: process.ppid,
  };
}

function normalizeScenario(value) {
  if (value === 'executor-conformance-cancel') return 'cancel';
  if (value === 'executor-conformance-approval') return 'approval-resume';
  if (value === 'executor-conformance-execute' || value === 'executor-conformance-spawn') {
    return 'settle';
  }
  return value;
}
