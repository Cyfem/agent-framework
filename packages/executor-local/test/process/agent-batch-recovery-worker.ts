import { assertNetworkDenyGuardInstalled } from '../network-deny.setup';

import { z } from 'zod';

import {
  Agent,
  createSubAgentRuntime,
  defineSubAgent,
  OpenAIChatModel,
  type AgentSubAgentRunOutcome,
  type JsonValue,
  type OpenAIChatProtocol,
  type StoredPendingToolCall,
} from '@ruixutong.manee/maneeagent-framework';

import {
  AtomicFileAgentRuntimeStateStore,
  createLocalAgentRunnerRegistration,
  LocalSubAgentRunnerRegistry,
  MemorySubAgentExecutor,
} from '../../src';

assertNetworkDenyGuardInstalled();

const SESSION_ID = 'local-root-batch-process-session';
const EXECUTOR_NAME = 'local-root-batch-process';
const RUNNER_ID = 'local-root-batch-runner';
const RUNNER_VERSION = '2.0.0';
const ORDINARY_CALL_ID = 'parent-ordinary-call';
const APPROVAL_PARENT_CALL_ID = 'parent-approval-agent-call';
const FAST_PARENT_CALL_ID = 'parent-fast-agent-call';
const APPROVAL_TOOL_CALL_ID = 'child-approval-tool-call';
const APPROVAL_TOOL_NAME = 'approval-proof';

const inputSchema = z.object({ lane: z.enum(['approval', 'fast']) }).strict();
const outputSchema = z.object({ lane: z.enum(['approval', 'fast']), proof: z.string() }).strict();

const definition = defineSubAgent({
  name: 'root-batch-proof',
  version: '2',
  description: 'Exercise durable parent Tool-batch recovery in another process.',
  inputSchema,
  outputSchema,
});

type Lane = z.infer<typeof inputSchema>['lane'];

interface Metrics {
  ordinaryCalls: number;
  ordinarySettled: boolean;
  approvalHandlerCalls: number;
  parentProviderCalls: number;
  readonly childFactoryLanes: Lane[];
  readonly childProviderCalls: Record<Lane, number>;
}

interface ApprovalProjection {
  readonly approvalId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly callId: string;
}

interface CallProjection {
  readonly callId: string;
  readonly name: string;
  readonly status: string;
  readonly taskId?: string;
  readonly output?: JsonValue;
}

type WorkerMessage =
  | {
      readonly type: 'ready';
      readonly runId: string;
      readonly approval: ApprovalProjection;
      readonly approvalTaskId: string;
      readonly fastTaskId: string;
      readonly calls: readonly CallProjection[];
      readonly ordinaryCalls: number;
      readonly parentProviderCalls: number;
      readonly childFactoryLanes: readonly Lane[];
      readonly childProviderCalls: Readonly<Record<Lane, number>>;
    }
  | {
      readonly type: 'completed';
      readonly runId: string;
      readonly approvalTaskId: string;
      readonly fastTaskId: string;
      readonly resultCallIds: readonly string[];
      readonly resultPayloads: readonly JsonValue[];
      readonly ordinaryCalls: number;
      readonly approvalHandlerCalls: number;
      readonly parentProviderCalls: number;
      readonly childFactoryLanes: readonly Lane[];
      readonly childProviderCalls: Readonly<Record<Lane, number>>;
      readonly runStatus: string;
      readonly taskStates: readonly string[];
      readonly approvalEventTypes: readonly string[];
      readonly fastEventTypes: readonly string[];
    }
  | { readonly type: 'failed'; readonly message: string };

async function main(): Promise<void> {
  const phase = process.argv[2];
  const stateRoot = process.argv[3];
  if ((phase !== 'phase-a' && phase !== 'phase-b') || !stateRoot) {
    throw new Error('Invalid root Agent process-recovery worker arguments.');
  }

  const store = new AtomicFileAgentRuntimeStateStore({ root: stateRoot });
  await store.init();
  if (phase === 'phase-a') await runPhaseA(store);
  else {
    const runId = process.argv[4];
    const approvalId = process.argv[5];
    const approvalRevision = Number(process.argv[6]);
    const approvalTaskId = process.argv[7];
    const fastTaskId = process.argv[8];
    if (
      !runId ||
      !approvalId ||
      !Number.isSafeInteger(approvalRevision) ||
      approvalRevision < 0 ||
      !approvalTaskId ||
      !fastTaskId
    ) {
      throw new Error('Phase B requires the durable run, approval, and task identities.');
    }
    await runPhaseB(store, {
      runId,
      approvalId,
      approvalRevision,
      approvalTaskId,
      fastTaskId,
    });
  }
}

async function runPhaseA(store: AtomicFileAgentRuntimeStateStore): Promise<void> {
  const metrics = createMetrics();
  let releaseFastTerminal = (): void => undefined;
  const fastTerminal = new Promise<void>((resolve) => {
    releaseFastTerminal = resolve;
  });
  const runtime = await createRuntime(store, 'phase-a', metrics, fastTerminal, releaseFastTerminal);
  const parent = createParent(runtime, metrics, 'phase-a');
  const outcome = await parent.agent('start the durable parent batch');
  if (outcome.status !== 'waiting_approval') {
    throw new Error(`Phase A expected waiting_approval, received ${outcome.status}.`);
  }
  if (metrics.approvalHandlerCalls !== 0) {
    throw new Error('The approval handler ran before a host decision.');
  }

  const approval = outcome.approvals[0];
  if (approval === undefined) throw new Error('Phase A did not expose the child approval.');
  const tasks = await store.listTasksByRun(SESSION_ID, outcome.runId);
  const approvalTask = tasks.find(({ input }) => readLane(input) === 'approval');
  const fastTask = tasks.find(({ input }) => readLane(input) === 'fast');
  if (approvalTask === undefined || fastTask === undefined) {
    throw new Error('Phase A did not persist both child tasks.');
  }
  if (approvalTask.state !== 'waiting_approval' || fastTask.state !== 'succeeded') {
    throw new Error('Phase A did not persist one paused and one completed child.');
  }
  const run = await store.loadRun(SESSION_ID, outcome.runId);
  if (run?.pendingBatch === undefined) throw new Error('Phase A root pending batch is missing.');

  await send({
    type: 'ready',
    runId: outcome.runId,
    approval: {
      approvalId: approval.approvalId,
      revision: approval.revision,
      taskId: approval.taskId,
      callId: approval.callId,
    },
    approvalTaskId: approvalTask.taskId,
    fastTaskId: fastTask.taskId,
    calls: run.pendingBatch.calls.map(projectCall),
    ordinaryCalls: metrics.ordinaryCalls,
    parentProviderCalls: metrics.parentProviderCalls,
    childFactoryLanes: [...metrics.childFactoryLanes],
    childProviderCalls: { ...metrics.childProviderCalls },
  });

  await new Promise<void>((resolve) => process.once('disconnect', resolve));
}

async function runPhaseB(
  store: AtomicFileAgentRuntimeStateStore,
  identity: Readonly<{
    runId: string;
    approvalId: string;
    approvalRevision: number;
    approvalTaskId: string;
    fastTaskId: string;
  }>,
): Promise<void> {
  const waiting = await store.loadRun(SESSION_ID, identity.runId);
  if (
    waiting?.status !== 'waiting_approval' ||
    waiting.pendingApprovals.length !== 1 ||
    waiting.pendingApprovals[0]?.approvalId !== identity.approvalId ||
    waiting.pendingApprovals[0]?.revision !== identity.approvalRevision ||
    waiting.pendingApprovals[0]?.taskId !== identity.approvalTaskId
  ) {
    throw new Error('Phase B could not reconstruct the waiting root run.');
  }
  const approval = waiting.pendingApprovals[0]!;
  const beforeTasks = await store.listTasksByRun(SESSION_ID, waiting.runId);
  const approvalTask = beforeTasks.find(({ taskId }) => taskId === identity.approvalTaskId);
  const fastTask = beforeTasks.find(({ taskId }) => taskId === identity.fastTaskId);
  if (approvalTask === undefined || fastTask === undefined || fastTask.state !== 'succeeded') {
    throw new Error('Phase B root checkpoint is missing its paused/completed siblings.');
  }

  const metrics = createMetrics();
  const runtime = await createRuntime(
    store,
    'phase-b',
    metrics,
    Promise.resolve(),
    () => undefined,
  );
  let parentResultRequest: unknown;
  const parent = createParent(runtime, metrics, 'phase-b', (request) => {
    parentResultRequest = request;
  });
  const outcome = await parent.resumeRun({
    runId: waiting.runId,
    decisions: [
      {
        approvalId: approval.approvalId,
        decision: 'approved',
        expectedRevision: approval.revision,
      },
    ],
  });
  if (outcome.status !== 'succeeded' || outcome.runId !== waiting.runId) {
    throw new Error(`Phase B failed to resume the original run: ${outcome.status}.`);
  }

  const results = extractChatToolOutputs(parentResultRequest);
  const finalRun = await store.loadRun(SESSION_ID, waiting.runId);
  const finalTasks = await store.listTasksByRun(SESSION_ID, waiting.runId);
  const finalApproval = finalTasks.find(({ taskId }) => taskId === approvalTask.taskId);
  const finalFast = finalTasks.find(({ taskId }) => taskId === fastTask.taskId);
  if (finalRun === undefined || finalApproval === undefined || finalFast === undefined) {
    throw new Error('Phase B final durable state is incomplete.');
  }

  await send({
    type: 'completed',
    runId: outcome.runId,
    approvalTaskId: approvalTask.taskId,
    fastTaskId: fastTask.taskId,
    resultCallIds: results.map(({ callId }) => callId),
    resultPayloads: results.map(({ output }) => output),
    ordinaryCalls: metrics.ordinaryCalls,
    approvalHandlerCalls: metrics.approvalHandlerCalls,
    parentProviderCalls: metrics.parentProviderCalls,
    childFactoryLanes: [...metrics.childFactoryLanes],
    childProviderCalls: { ...metrics.childProviderCalls },
    runStatus: finalRun.status,
    taskStates: finalTasks.map(({ state }) => state).sort(),
    approvalEventTypes: (await store.readEvents(SESSION_ID, approvalTask.taskId)).map(
      ({ type }) => type,
    ),
    fastEventTypes: (await store.readEvents(SESSION_ID, fastTask.taskId)).map(({ type }) => type),
  });
}

async function createRuntime(
  store: AtomicFileAgentRuntimeStateStore,
  phase: 'phase-a' | 'phase-b',
  metrics: Metrics,
  fastTerminal: Promise<void>,
  releaseFastTerminal: () => void,
) {
  const registration = createLocalAgentRunnerRegistration({
    definition,
    runnerId: RUNNER_ID,
    runnerVersion: RUNNER_VERSION,
    createAgent({ request }) {
      const { lane } = inputSchema.parse(request.input);
      if (phase === 'phase-b' && lane === 'fast') {
        throw new Error('A completed sibling must not be reconstructed or replayed.');
      }
      if (phase === 'phase-a' && !metrics.ordinarySettled) {
        throw new Error('A child factory started before the ordinary Tool settled.');
      }
      metrics.childFactoryLanes.push(lane);
      const child = new Agent<OpenAIChatProtocol>({
        llm: createChatModel(`offline-child-${phase}-${lane}`, async () => {
          const round = metrics.childProviderCalls[lane]++;
          if (phase === 'phase-a' && lane === 'fast') {
            if (round === 0) {
              return chatToolResponse('fast-result-call', 'agent-result', {
                result: { lane, proof: 'fast-proof' },
              });
            }
            if (round === 1) return chatToolResponse('fast-end-call', 'end-agent', {});
          }
          if (phase === 'phase-a' && lane === 'approval' && round === 0) {
            await fastTerminal;
            return chatToolResponse(APPROVAL_TOOL_CALL_ID, APPROVAL_TOOL_NAME, {
              marker: 'approval-safe',
            });
          }
          if (phase === 'phase-b' && lane === 'approval') {
            if (round === 0) {
              return chatToolResponse('approval-result-call', 'agent-result', {
                result: { lane, proof: 'approval-proof' },
              });
            }
            if (round === 1) return chatToolResponse('approval-end-call', 'end-agent', {});
          }
          throw new Error(`Unexpected ${phase}/${lane} child provider round ${round}.`);
        }),
        maxIterations: 4,
      });
      if (lane === 'approval') {
        child.tools.push({
          name: APPROVAL_TOOL_NAME,
          description: 'A deterministic approval-gated proof Tool.',
          parameters: z.object({ marker: z.literal('approval-safe') }).strict(),
          approval: { summary: 'Approve the process recovery proof.' },
          handler: () => {
            metrics.approvalHandlerCalls += 1;
            return 'approved';
          },
        });
      }
      return {
        async runAsSubAgent(
          options: Parameters<Agent<OpenAIChatProtocol>['runAsSubAgent']>[0],
        ): Promise<AgentSubAgentRunOutcome> {
          const outcome = await child.runAsSubAgent(options);
          if (phase === 'phase-a' && lane === 'fast' && outcome.type === 'terminal') {
            releaseFastTerminal();
          }
          return outcome;
        },
      };
    },
    buildInput: ({ input }) => {
      const { lane } = inputSchema.parse(input);
      return `child:${lane}`;
    },
  });
  const runtime = createSubAgentRuntime({
    sessionId: SESSION_ID,
    activeDefinitions: [definition],
    executors: [
      new MemorySubAgentExecutor({
        name: EXECUTOR_NAME,
        registry: new LocalSubAgentRunnerRegistry([registration]),
      }),
    ],
    stateStore: store,
  });
  await runtime.init();
  return runtime;
}

function createParent(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  metrics: Metrics,
  phase: 'phase-a' | 'phase-b',
  observeResultRequest?: (request: unknown) => void,
): Agent<OpenAIChatProtocol> {
  const parent = new Agent<OpenAIChatProtocol>({
    llm: createChatModel(`offline-parent-${phase}`, async (request) => {
      const round = metrics.parentProviderCalls++;
      if (phase === 'phase-a' && round === 0) {
        return chatToolResponses([
          { callId: ORDINARY_CALL_ID, name: 'ordinary-proof', input: { marker: 'ordinary-safe' } },
          {
            callId: APPROVAL_PARENT_CALL_ID,
            name: 'agent',
            input: {
              subAgent: definition.name,
              executor: EXECUTOR_NAME,
              input: { lane: 'approval' },
            },
          },
          {
            callId: FAST_PARENT_CALL_ID,
            name: 'agent',
            input: {
              subAgent: definition.name,
              executor: EXECUTOR_NAME,
              input: { lane: 'fast' },
            },
          },
        ]);
      }
      if (phase === 'phase-b' && round === 0) {
        observeResultRequest?.(request);
        return chatToolResponse('parent-end-call', 'end-agent', {});
      }
      throw new Error(`Unexpected ${phase} parent provider round ${round}.`);
    }),
    subAgentRuntime: runtime,
    sessionId: SESSION_ID,
    maxIterations: 4,
  });
  parent.tools.push({
    name: 'ordinary-proof',
    description: 'Settle once before child placement.',
    parameters: z.object({ marker: z.literal('ordinary-safe') }).strict(),
    handler: () => {
      metrics.ordinaryCalls += 1;
      metrics.ordinarySettled = true;
      return { proof: 'ordinary-proof' };
    },
  });
  return parent.init();
}

function createMetrics(): Metrics {
  return {
    ordinaryCalls: 0,
    ordinarySettled: false,
    approvalHandlerCalls: 0,
    parentProviderCalls: 0,
    childFactoryLanes: [],
    childProviderCalls: { approval: 0, fast: 0 },
  };
}

function readLane(value: JsonValue): Lane | undefined {
  const parsed = inputSchema.safeParse(value);
  return parsed.success ? parsed.data.lane : undefined;
}

function createChatModel(
  model: string,
  create: (request: unknown) => unknown | Promise<unknown>,
): OpenAIChatModel {
  return new OpenAIChatModel({
    model,
    client: { chat: { completions: { create } } } as never,
  });
}

function chatToolResponse(callId: string, name: string, input: JsonValue): unknown {
  return chatToolResponses([{ callId, name, input }]);
}

function chatToolResponses(
  calls: readonly { readonly callId: string; readonly name: string; readonly input: JsonValue }[],
): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map(({ callId, name, input }) => ({
            id: callId,
            type: 'function',
            function: { name, arguments: JSON.stringify(input) },
          })),
        },
      },
    ],
  };
}

function extractChatToolOutputs(
  request: unknown,
): readonly { readonly callId: string; readonly output: JsonValue }[] {
  if (typeof request !== 'object' || request === null || !('messages' in request)) return [];
  const messages = (request as { readonly messages?: readonly unknown[] }).messages ?? [];
  return messages.flatMap((message) => {
    if (typeof message !== 'object' || message === null) return [];
    const record = message as {
      readonly role?: unknown;
      readonly tool_call_id?: unknown;
      readonly content?: unknown;
    };
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

function projectCall(call: StoredPendingToolCall): CallProjection {
  return {
    callId: call.callId,
    name: call.name,
    status: call.status,
    ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
    ...(call.output === undefined ? {} : { output: call.output }),
  };
}

async function send(message: WorkerMessage): Promise<void> {
  if (process.send === undefined) throw new Error('The process recovery worker requires IPC.');
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => (error ? reject(error) : resolve()));
  });
}

void main()
  .then(() => {
    process.disconnect?.();
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown process recovery failure.';
    try {
      await send({ type: 'failed', message });
    } finally {
      process.exitCode = 1;
      process.disconnect?.();
    }
  });
