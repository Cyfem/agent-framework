import { assertNetworkDenyGuardInstalled } from '../network-deny.setup';

import { z } from 'zod';
import { readFileSync } from 'node:fs';

import {
  Agent,
  createSubAgentRuntime,
  defineSubAgent,
  type JsonValue,
  OpenAIChatModel,
  type OpenAIChatProtocol,
  SubAgentRuntimeError,
  type SubAgentRuntime,
} from '@ruixutong.manee/maneeagent-framework';

import {
  AtomicFileAgentRuntimeStateStore,
  createLocalAgentRunnerRegistration,
  LocalSubAgentRunnerRegistry,
  MemorySubAgentExecutor,
} from '../../src';

assertNetworkDenyGuardInstalled();

type Phase = 'phase-a' | 'phase-b';

const SESSION_ID = 'root-running-child-process-session';
const EXECUTOR_NAME = 'local-root-running-child-process';
const RUNNER_ID = 'root-running-child-process-runner';
const RUNNER_VERSION = '2.0.0';
const EXECUTION_LEASE_TTL_MS = 100;
const PARENT_CALL_ID = 'root-running-parent-agent-call';
const PARENT_END_CALL_ID = 'root-running-parent-end-call';
const CHILD_TOOL_NAME = 'durable-running-proof';
const CHILD_TOOL_CALL_ID = 'durable-running-tool-call';

const CHILD_RESULT_CALL_ID = 'durable-running-result-call';
const CHILD_END_CALL_ID = 'durable-running-end-call';
const input = Object.freeze({ marker: 'root-running-child-process' });
const output = Object.freeze({ proof: 'root-running-child-recovered' });
const inputSchema = z.object({ marker: z.literal(input.marker) }).strict();
const outputSchema = z.object({ proof: z.literal(output.proof) }).strict();
const definition = defineSubAgent({
  name: 'root-running-child-process-proof',
  version: '2',
  description: 'Recover a durable running Local child after its execution lease expires.',
  inputSchema,
  outputSchema,
});

interface Metrics {
  parentProviderCalls: number;
  childProviderCalls: number;
  childFactories: number;
  childToolCalls: number;
}

interface IdentityProjection {
  readonly runId: string;
  readonly taskId: string;
  readonly subagentSessionId: string;
  readonly parentCallId: string;
  readonly inputHash: string;
}

interface RunningProjection {
  readonly identity: IdentityProjection;
  readonly rootRevision: number;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly taskFencingToken: string;
  readonly executionFencingToken: string;
  readonly executionEpoch: string;
}

type WorkerMessage =
  | {
      readonly type: 'ready';
      readonly running: RunningProjection;
      readonly rootStatus: string;
      readonly parentCallStatus: string;
      readonly taskState: string;
      readonly childCheckpointProtocol: string;
      readonly childCheckpointCallStatus: string;
      readonly reconnectCapability: string;
      readonly executionLeaseTtlMs: number;
      readonly metrics: Readonly<Metrics>;
      readonly taskEventTypes: readonly string[];
    }
  | {
      readonly type: 'completed';
      readonly running: RunningProjection;
      readonly rootStatus: string;
      readonly taskState: string;
      readonly childCheckpointProtocol: string;
      readonly reconnectCapability: string;
      readonly reconnectErrorCode: string;
      readonly parentOutputCallIds: readonly string[];
      readonly metrics: Readonly<Metrics>;
      readonly taskEventTypes: readonly string[];
    }
  | { readonly type: 'failed'; readonly message: string };

async function main(): Promise<void> {
  const phase = parsePhase(process.argv[2]);
  const stateRoot = requiredArgument(process.argv[3], 'state root');
  const clockPath = requiredArgument(process.argv[4], 'clock path');
  const store = new AtomicFileAgentRuntimeStateStore({
    root: stateRoot,
    now: () => readClock(clockPath),
  });
  await store.init();
  const metrics = createMetrics();
  const { runtime, reconnectCapability } = await createRuntime(store, phase, metrics);

  if (phase === 'phase-a') {
    const parent = createParent(runtime, 'phase-a', metrics);
    await parent.agent('start the durable running child');
    throw new Error(
      `Phase A unexpectedly completed after ${metrics.parentProviderCalls} parent provider call(s), ${metrics.childProviderCalls} child provider call(s), and ${metrics.childToolCalls} child Tool call(s).`,
    );
  }

  const expected = parseExpectedIdentity(process.argv.slice(5));
  const beforeRun = await store.loadRun(SESSION_ID, expected.runId);
  const beforeTask = await store.loadTask(SESSION_ID, expected.taskId);
  if (
    beforeRun?.status !== 'running' ||
    beforeTask?.state !== 'running' ||
    beforeTask.subagentSessionId !== expected.subagentSessionId ||
    beforeTask.inputHash !== expected.inputHash
  ) {
    throw new Error('Phase B did not find the exact durable running task.');
  }
  const reconnectErrorCode = await rejectedReconnectCode(runtime, expected.taskId);
  let parentResultRequest: unknown;
  const parent = createParent(runtime, 'phase-b', metrics, (request) => {
    parentResultRequest = request;
  });
  const outcome = await parent.resumeRun({ runId: expected.runId });
  if (outcome.status !== 'succeeded' || outcome.runId !== expected.runId) {
    throw new Error(`Phase B did not recover the original root run: ${outcome.status}.`);
  }
  const finalRun = await store.loadRun(SESSION_ID, expected.runId);
  const finalTask = await store.loadTask(SESSION_ID, expected.taskId);
  if (
    finalRun?.status !== 'succeeded' ||
    finalTask?.state !== 'succeeded' ||
    finalTask.childCheckpoint === undefined ||
    finalTask.executionFencingToken === undefined ||
    finalTask.executionEpoch === undefined
  ) {
    throw new Error('Phase B final durable state is incomplete.');
  }
  const finalProjection = projectRunning(finalRun, finalTask);
  const events = (await store.readEvents(SESSION_ID, finalTask.taskId)).map(({ type }) => type);
  if (!events.includes('recovery.resumed') || events.includes('recovery.reconnected')) {
    throw new Error('The running Local child did not use checkpoint orphan adoption.');
  }
  if (
    metrics.parentProviderCalls !== 1 ||
    metrics.childProviderCalls !== 2 ||
    metrics.childFactories !== 1 ||
    metrics.childToolCalls !== 0
  ) {
    throw new Error(`Phase B replay oracle failed: ${JSON.stringify(metrics)}.`);
  }

  await send({
    type: 'completed',
    running: finalProjection,
    rootStatus: finalRun.status,
    taskState: finalTask.state,
    childCheckpointProtocol: finalTask.childCheckpoint.protocolContext.protocol,
    reconnectCapability,
    reconnectErrorCode,
    parentOutputCallIds: extractChatToolOutputs(parentResultRequest).map(({ callId }) => callId),
    metrics: { ...metrics },
    taskEventTypes: events,
  });
}

async function createRuntime(
  store: AtomicFileAgentRuntimeStateStore,
  phase: Phase,
  metrics: Metrics,
): Promise<{ readonly runtime: SubAgentRuntime; readonly reconnectCapability: string }> {
  const registration = createLocalAgentRunnerRegistration({
    definition,
    runnerId: RUNNER_ID,
    runnerVersion: RUNNER_VERSION,
    createAgent({ request }) {
      metrics.childFactories += 1;
      inputSchema.parse(request.input);
      const child = new Agent<OpenAIChatProtocol>({
        llm: createChatModel((round, payload) => {
          metrics.childProviderCalls += 1;
          assertChatRequest(payload);
          if (phase === 'phase-a' && round === 0) {
            return chatToolResponse(CHILD_TOOL_CALL_ID, CHILD_TOOL_NAME, {
              marker: 'persist-before-crash',
            });
          }
          if (phase === 'phase-b' && round === 0) {
            return chatToolResponse(CHILD_RESULT_CALL_ID, 'agent-result', { result: output });
          }
          if (phase === 'phase-b' && round === 1) {
            return chatToolResponse(CHILD_END_CALL_ID, 'end-agent', {});
          }
          throw new Error(`Unexpected ${phase} child provider round ${round}.`);
        }),
        maxIterations: 4,
        systemPrompts: ['Persist the proof Tool, submit agent-result, then call end-agent alone.'],
      });
      child.tools.push({
        name: CHILD_TOOL_NAME,
        description: 'A Tool whose settled checkpoint becomes the process crash failpoint.',
        parameters: z.object({ marker: z.literal('persist-before-crash') }).strict(),
        handler: () => {
          metrics.childToolCalls += 1;
          return { persisted: true };
        },
      });
      if (phase === 'phase-a') {
        child.onAfterToolCall(
          CHILD_TOOL_NAME,
          async () => {
            const run = await store.loadRun(SESSION_ID, request.runId);
            const task = await store.loadTask(SESSION_ID, request.taskId);
            const parentCall = run?.pendingBatch?.calls.find(
              ({ callId }) => callId === PARENT_CALL_ID,
            );
            const childCall = task?.childCheckpoint?.pendingBatch?.calls.find(
              ({ callId }) => callId === CHILD_TOOL_CALL_ID,
            );
            if (
              run?.status !== 'running' ||
              task?.state !== 'running' ||
              parentCall?.status !== 'running' ||
              parentCall.taskId !== request.taskId ||
              childCall?.status !== 'result_ready' ||
              task.executionFencingToken === undefined ||
              task.executionEpoch === undefined
            ) {
              await send({
                type: 'failed',
                message: `The child failpoint was not durably settled while running: ${JSON.stringify(
                  {
                    runStatus: run?.status,
                    taskState: task?.state,
                    parentCallStatus: parentCall?.status,
                    parentCallTaskId: parentCall?.taskId,
                    expectedTaskId: request.taskId,
                    childCallStatus: childCall?.status,
                    executionFencingToken: task?.executionFencingToken,
                    executionEpoch: task?.executionEpoch,
                  },
                )}.`,
              });
              await waitForDisconnect();
              return;
            }
            await send({
              type: 'ready',
              running: projectRunning(run, task),
              rootStatus: run.status,
              parentCallStatus: parentCall.status,
              taskState: task.state,
              childCheckpointProtocol: task.childCheckpoint!.protocolContext.protocol,
              childCheckpointCallStatus: childCall.status,
              reconnectCapability: 'none',
              executionLeaseTtlMs: EXECUTION_LEASE_TTL_MS,
              metrics: { ...metrics },
              taskEventTypes: (await store.readEvents(SESSION_ID, request.taskId)).map(
                ({ type }) => type,
              ),
            });
            await waitForDisconnect();
          },
          { await: true },
        );
      }
      return child;
    },
    buildInput: () => 'child:root-running-process-recovery',
  });
  const executor = new MemorySubAgentExecutor({
    name: EXECUTOR_NAME,
    registry: new LocalSubAgentRunnerRegistry([registration]),
  });
  const runtime = createSubAgentRuntime({
    sessionId: SESSION_ID,
    activeDefinitions: [definition],
    executors: [executor],
    stateStore: store,
    executionLeaseTtlMs: EXECUTION_LEASE_TTL_MS,
  });
  await runtime.init();
  return {
    runtime,
    reconnectCapability: executor.descriptor.capabilities.recovery.reconnect,
  };
}

function createParent(
  runtime: SubAgentRuntime,
  phase: Phase,
  metrics: Metrics,
  captureResultRequest?: (request: unknown) => void,
): Agent<OpenAIChatProtocol> {
  const parent = new Agent<OpenAIChatProtocol>({
    llm: createChatModel((round, payload) => {
      metrics.parentProviderCalls += 1;
      assertChatRequest(payload);
      if (phase === 'phase-a' && round === 0) {
        return chatToolResponse(PARENT_CALL_ID, 'agent', {
          subAgent: definition.name,
          executor: EXECUTOR_NAME,
          input,
        });
      }
      if (phase === 'phase-b' && round === 0) {
        captureResultRequest?.(payload);
        return chatToolResponse(PARENT_END_CALL_ID, 'end-agent', {});
      }
      throw new Error(`Unexpected ${phase} parent provider round ${round}.`);
    }),
    subAgentRuntime: runtime,
    sessionId: SESSION_ID,
    maxIterations: 4,
    systemPrompts: ['Run the child proof and then call end-agent alone.'],
  });
  return parent.init();
}

function createChatModel(
  responder: (round: number, payload: unknown) => unknown | Promise<unknown>,
): OpenAIChatModel {
  let round = 0;
  return new OpenAIChatModel({
    model: 'offline-root-running-child-process',
    client: {
      chat: { completions: { create: (payload: unknown) => responder(round++, payload) } },
    } as never,
  });
}

async function rejectedReconnectCode(runtime: SubAgentRuntime, taskId: string): Promise<string> {
  try {
    await runtime.reconnect(SESSION_ID, taskId);
    throw new Error('Local reconnect unexpectedly succeeded.');
  } catch (error) {
    if (!(error instanceof SubAgentRuntimeError)) throw error;
    if (error.descriptor.code !== 'UNSUPPORTED_CAPABILITY') {
      throw new Error(`Local reconnect returned ${error.descriptor.code}.`, { cause: error });
    }
    return error.descriptor.code;
  }
}

function projectRunning(
  run: { readonly runId: string; readonly revision: number },
  task: {
    readonly taskId: string;
    readonly subagentSessionId: string;
    readonly inputHash: string;
    readonly revision: number;
    readonly attempt: number;
    readonly fencingToken: string;
    readonly executionFencingToken?: string;
    readonly executionEpoch?: string;
  },
): RunningProjection {
  if (task.executionFencingToken === undefined || task.executionEpoch === undefined) {
    throw new Error('The running task has no execution ownership.');
  }
  return {
    identity: {
      runId: run.runId,
      taskId: task.taskId,
      subagentSessionId: task.subagentSessionId,
      parentCallId: PARENT_CALL_ID,
      inputHash: task.inputHash,
    },
    rootRevision: run.revision,
    taskRevision: task.revision,
    taskAttempt: task.attempt,
    taskFencingToken: task.fencingToken,
    executionFencingToken: task.executionFencingToken,
    executionEpoch: task.executionEpoch,
  };
}

function parseExpectedIdentity(args: readonly string[]): IdentityProjection {
  return {
    runId: requiredArgument(args[0], 'run id'),
    taskId: requiredArgument(args[1], 'task id'),
    subagentSessionId: requiredArgument(args[2], 'subagent session id'),
    parentCallId: requiredArgument(args[3], 'parent call id'),
    inputHash: requiredArgument(args[4], 'input hash'),
  };
}

function chatToolResponse(callId: string, name: string, parameters: JsonValue): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: { name, arguments: JSON.stringify(parameters) },
            },
          ],
        },
      },
    ],
  };
}

function extractChatToolOutputs(
  payload: unknown,
): readonly { readonly callId: string; readonly output: JsonValue }[] {
  return readArray(readRecord(payload).messages).flatMap((message) => {
    const record = readRecord(message);
    if (
      record.role !== 'tool' ||
      typeof record.tool_call_id !== 'string' ||
      typeof record.content !== 'string'
    ) {
      return [];
    }
    return [{ callId: record.tool_call_id, output: JSON.parse(record.content) as JsonValue }];
  });
}

function assertChatRequest(payload: unknown): void {
  const record = readRecord(payload);
  if (!Array.isArray(record.messages) || 'input' in record) {
    throw new Error('The fixture received a non-Chat provider request.');
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function createMetrics(): Metrics {
  return {
    parentProviderCalls: 0,
    childProviderCalls: 0,
    childFactories: 0,
    childToolCalls: 0,
  };
}

function parsePhase(value: string | undefined): Phase {
  if (value === 'phase-a' || value === 'phase-b') return value;
  throw new Error('Invalid running-child process phase.');
}

function requiredArgument(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function readClock(path: string): number {
  const value = Number(readFileSync(path, 'utf8'));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid fixture clock.');
  return value;
}

async function waitForDisconnect(): Promise<void> {
  await new Promise<void>((resolve) => process.once('disconnect', resolve));
}

async function send(message: WorkerMessage): Promise<void> {
  if (process.send === undefined) throw new Error('The running-child worker requires IPC.');
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => (error ? reject(error) : resolve()));
  });
}

void main()
  .then(() => process.disconnect?.())
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown running-child failure.';
    try {
      await send({ type: 'failed', message });
    } finally {
      process.exitCode = 1;
      process.disconnect?.();
    }
  });
