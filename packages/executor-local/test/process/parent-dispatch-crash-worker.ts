import { assertNetworkDenyGuardInstalled } from '../network-deny.setup';

import { z } from 'zod';

import {
  createSubAgentRuntime,
  defineSubAgent,
  type ApprovalRequest,
  type AgentToolCall,
  type JsonValue,
  OPENAI_CHAT_CHECKPOINT_CODEC,
  type OpenAIChatProtocol,
  type StoredPendingToolBatch,
  type SubAgentExecutionOutcome,
  type SubAgentRuntime,
  type SubAgentTaskHandle,
} from '@ruixutong.manee/maneeagent-framework';

import { ContextStore } from '../../../core/src/agent/context-store';
import {
  AgentRunCheckpointController,
  type AgentRunLease,
} from '../../../core/src/agent/run-controller';
import {
  createToolBatchPlan,
  executeToolBatchPlan,
  resumeToolBatchPlan,
  type ToolBatchAgentCallOutcome,
} from '../../../core/src/agent/tool-batch';
import {
  AtomicFileAgentRuntimeStateStore,
  LocalSubAgentRunnerRegistry,
  MemorySubAgentExecutor,
} from '../../src';

assertNetworkDenyGuardInstalled();

type Phase = 'stage-uncommitted' | 'commit-undispatched' | 'recover';

const SESSION_ID = 'parent-dispatch-crash-session';
const RUN_ID = 'parent-dispatch-crash-run';
const CALL_ID = 'parent-dispatch-agent-call';
const BATCH_ID = 'parent-dispatch-batch';
const REQUEST_ID = `provider:0:${CALL_ID}`;
const EXECUTOR_NAME = 'local-parent-dispatch-crash';
const RUNNER_ID = 'parent-dispatch-crash-runner';
const RUNNER_VERSION = '2.0.0';
const ROOT_LEASE_TTL_MS = 1_000;
const input = Object.freeze({ marker: 'parent-dispatch-crash' });
const output = Object.freeze({ proof: 'dispatched-once-after-recovery' });
const inputSchema = z.object({ marker: z.literal(input.marker) }).strict();
const outputSchema = z.object({ proof: z.literal(output.proof) }).strict();
const definition = defineSubAgent({
  name: 'parent-dispatch-crash-proof',
  version: '2',
  description: 'Prove atomic parent/task visibility before Local dispatch.',
  inputSchema,
  outputSchema,
});

interface Metrics {
  runnerFactories: number;
  runnerRuns: number;
}

interface IdentityProjection {
  readonly runId: string;
  readonly taskId: string;
  readonly callId: string;
  readonly requestId: string;
}

type WorkerMessage =
  | {
      readonly type: 'staged';
      readonly identity: IdentityProjection;
      readonly runRevision: number;
      readonly parentCallStatus: string;
      readonly parentCallTaskId?: string;
      readonly taskVisible: boolean;
      readonly metrics: Readonly<Metrics>;
    }
  | {
      readonly type: 'committed';
      readonly identity: IdentityProjection;
      readonly runRevision: number;
      readonly taskRevision: number;
      readonly taskState: string;
      readonly parentCallStatus: string;
      readonly parentCallTaskId?: string;
      readonly metrics: Readonly<Metrics>;
    }
  | {
      readonly type: 'completed';
      readonly identity: IdentityProjection;
      readonly runStatus: string;
      readonly taskState: string;
      readonly taskAttempt: number;
      readonly taskRevision: number;
      readonly outputCallIds: readonly string[];
      readonly metrics: Readonly<Metrics>;
      readonly taskEventTypes: readonly string[];
    }
  | { readonly type: 'failed'; readonly message: string };

async function main(): Promise<void> {
  const phase = parsePhase(process.argv[2]);
  const stateRoot = requiredArgument(process.argv[3], 'state root');
  const expectedTaskId = process.argv[4];
  const store = new AtomicFileAgentRuntimeStateStore({ root: stateRoot });
  await store.init();
  const metrics = createMetrics();
  const runtime = await createRuntime(store, metrics);
  const controller = createController(store);

  if (phase === 'stage-uncommitted') {
    await stageUncommitted(store, runtime, controller, metrics);
    return;
  }
  if (!expectedTaskId) throw new Error(`${phase} requires the expected task identity.`);
  if (phase === 'commit-undispatched') {
    await commitUndispatched(store, runtime, controller, metrics, expectedTaskId);
    return;
  }
  await recoverCommitted(store, runtime, controller, metrics, expectedTaskId);
}

async function stageUncommitted(
  store: AtomicFileAgentRuntimeStateStore,
  runtime: SubAgentRuntime,
  controller: AgentRunCheckpointController<OpenAIChatProtocol>,
  metrics: Metrics,
): Promise<void> {
  const contextStore = createContextStore();
  const active = await controller.beginCreate(
    {
      runId: RUN_ID,
      contextStore,
      limits: runtime.limits,
      maxIterations: 4,
      configurationHash: '1'.repeat(64),
    },
    { leaseTtlMs: ROOT_LEASE_TTL_MS },
  );
  const plan = createPlan();
  await executeToolBatchPlan(plan, {
    executeTool: rejectUnexpectedOrdinaryTool,
    executeEndAgent: rejectUnexpectedOrdinaryTool,
    applyResult: () => undefined,
    submitAgent: async () => {
      const staged = await stage(runtime, active.lease, contextStore);
      const run = await requiredRun(store);
      const call = requiredParentCall(run.pendingBatch);
      await send({
        type: 'staged',
        identity: identity(staged.taskId),
        runRevision: run.revision,
        parentCallStatus: call.status,
        ...(call.taskId === undefined ? {} : { parentCallTaskId: call.taskId }),
        taskVisible: (await store.loadTask(SESSION_ID, staged.taskId)) !== undefined,
        metrics: { ...metrics },
      });
      await waitForDisconnect();
      return runningOutcome(staged);
    },
    checkpoint: (batch, approvals, taskCreates) =>
      persist(controller, active.lease, contextStore, batch, approvals, taskCreates),
  });
}

async function commitUndispatched(
  store: AtomicFileAgentRuntimeStateStore,
  runtime: SubAgentRuntime,
  controller: AgentRunCheckpointController<OpenAIChatProtocol>,
  metrics: Metrics,
  abortedTaskId: string,
): Promise<void> {
  const active = await controller.beginResume(RUN_ID, { leaseTtlMs: ROOT_LEASE_TTL_MS });
  const contextStore = active.checkpoint.contextStore;
  const pending = requirePendingBatch(active.checkpoint.record.pendingBatch);
  await resumeToolBatchPlan(createPlan(), pending, {
    executeTool: rejectUnexpectedOrdinaryTool,
    executeEndAgent: rejectUnexpectedOrdinaryTool,
    applyResult: () => undefined,
    submitAgent: async () => {
      const staged = await stage(runtime, active.lease, contextStore);
      if (staged.taskId === abortedTaskId) {
        throw new Error('An uncommitted staged task identity was incorrectly reused.');
      }
      return {
        ...runningOutcome(staged),
        dispatch: async () => {
          const run = await requiredRun(store);
          const task = await requiredTask(store, staged.taskId);
          const call = requiredParentCall(run.pendingBatch);
          await send({
            type: 'committed',
            identity: identity(staged.taskId),
            runRevision: run.revision,
            taskRevision: task.revision,
            taskState: task.state,
            parentCallStatus: call.status,
            ...(call.taskId === undefined ? {} : { parentCallTaskId: call.taskId }),
            metrics: { ...metrics },
          });
          await waitForDisconnect();
          await staged.dispatch();
        },
      };
    },
    checkpoint: (batch, approvals, taskCreates) =>
      persist(controller, active.lease, contextStore, batch, approvals, taskCreates),
  });
}

async function recoverCommitted(
  store: AtomicFileAgentRuntimeStateStore,
  runtime: SubAgentRuntime,
  controller: AgentRunCheckpointController<OpenAIChatProtocol>,
  metrics: Metrics,
  taskId: string,
): Promise<void> {
  const active = await controller.beginResume(RUN_ID, { leaseTtlMs: ROOT_LEASE_TTL_MS });
  const contextStore = active.checkpoint.contextStore;
  const pending = requirePendingBatch(active.checkpoint.record.pendingBatch);
  const handles = new Map<string, SubAgentTaskHandle>();
  const applied: { callId: string; output: JsonValue }[] = [];
  const result = await resumeToolBatchPlan(createPlan(), pending, {
    executeTool: rejectUnexpectedOrdinaryTool,
    executeEndAgent: rejectUnexpectedOrdinaryTool,
    submitAgent: () => {
      throw new Error('A committed running parent call must recover rather than submit.');
    },
    resumeAgent: async (_call, checkpoint): Promise<ToolBatchAgentCallOutcome> => {
      if (checkpoint.taskId !== taskId) throw new Error('The parent call lost its task identity.');
      const handle = await runtime.recover(SESSION_ID, taskId);
      handles.set(taskId, handle);
      return { status: 'running', taskId };
    },
    observeAgent: async (_call, checkpoint) => {
      const handle = handles.get(checkpoint.taskId ?? '');
      if (handle === undefined) throw new Error('The recovered task handle is missing.');
      return settledOutcome(await handle.wait());
    },
    applyResult: (call, ordered) => {
      applied.push({ callId: call.id, output: ordered.output });
    },
    checkpoint: (batch, approvals, taskCreates) =>
      persist(controller, active.lease, contextStore, batch, approvals, taskCreates),
  });
  if (!result.complete || result.waitingApproval) {
    throw new Error('The recovered parent Tool batch did not complete.');
  }
  await controller.checkpoint(
    {
      runId: RUN_ID,
      contextStore,
      status: 'succeeded',
      modelIteration: 1,
      pendingBatch: null,
      pendingApprovals: [],
    },
    active.lease,
  );
  await active.lease.release();
  const run = await requiredRun(store);
  const task = await requiredTask(store, taskId);
  await send({
    type: 'completed',
    identity: identity(taskId),
    runStatus: run.status,
    taskState: task.state,
    taskAttempt: task.attempt,
    taskRevision: task.revision,
    outputCallIds: applied.map(({ callId }) => callId),
    metrics: { ...metrics },
    taskEventTypes: (await store.readEvents(SESSION_ID, taskId)).map(({ type }) => type),
  });
}

async function createRuntime(
  store: AtomicFileAgentRuntimeStateStore,
  metrics: Metrics,
): Promise<SubAgentRuntime> {
  const registry = new LocalSubAgentRunnerRegistry([
    {
      definition,
      runnerId: RUNNER_ID,
      runnerVersion: RUNNER_VERSION,
      childCheckpointVersions: ['1'],
      create: () => {
        metrics.runnerFactories += 1;
        return {
          async run(child, control): Promise<SubAgentExecutionOutcome> {
            metrics.runnerRuns += 1;
            const receipt = await control.completion.submitResult('dispatch-crash-result', output);
            if (receipt.status !== 'accepted')
              throw new Error('The result receipt was not accepted.');
            await control.completion.complete('dispatch-crash-end', { isStandalone: true });
            return {
              type: 'terminal',
              result: {
                status: 'succeeded',
                task: { taskId: child.taskId, subAgent: child.definition },
                executor: EXECUTOR_NAME,
                output,
              },
            };
          },
        };
      },
    },
  ]);
  const runtime = createSubAgentRuntime({
    sessionId: SESSION_ID,
    activeDefinitions: [definition],
    executors: [new MemorySubAgentExecutor({ name: EXECUTOR_NAME, registry })],
    stateStore: store,
  });
  await runtime.init();
  return runtime;
}

function createController(
  store: AtomicFileAgentRuntimeStateStore,
): AgentRunCheckpointController<OpenAIChatProtocol> {
  return new AgentRunCheckpointController({
    ownerSessionId: SESSION_ID,
    stateStore: store,
    checkpointCodec: OPENAI_CHAT_CHECKPOINT_CODEC,
    createRunId: () => RUN_ID,
  });
}

function createContextStore(): ContextStore<OpenAIChatProtocol> {
  return new ContextStore([{ role: 'user', content: 'parent dispatch crash proof' }]);
}

function createPlan() {
  const call = createAgentCall();
  return createToolBatchPlan<OpenAIChatProtocol>({
    batchId: BATCH_ID,
    iteration: 0,
    assistantMessage: {
      protocol: OPENAI_CHAT_CHECKPOINT_CODEC.protocol,
      codecVersion: OPENAI_CHAT_CHECKPOINT_CODEC.version,
      value: OPENAI_CHAT_CHECKPOINT_CODEC.encode([call.sourceMessage]),
    },
    calls: [call],
    createdAt: 1,
  });
}

function createAgentCall(): AgentToolCall<OpenAIChatProtocol> {
  const sourceCall = {
    id: CALL_ID,
    type: 'function' as const,
    function: {
      name: 'agent',
      arguments: JSON.stringify({ subAgent: definition.name, executor: EXECUTOR_NAME, input }),
    },
  };
  const sourceMessage = {
    role: 'assistant' as const,
    content: null,
    tool_calls: [sourceCall],
  };
  return {
    id: CALL_ID,
    name: 'agent',
    arguments: sourceCall.function.arguments,
    sourceMessage,
    sourceCall,
  };
}

async function stage(
  runtime: SubAgentRuntime,
  lease: AgentRunLease,
  contextStore: ContextStore<OpenAIChatProtocol>,
) {
  return runtime.stageTool(
    { subAgent: definition.name, executor: EXECUTOR_NAME, input },
    {
      ownerSessionId: SESSION_ID,
      runId: RUN_ID,
      requestId: REQUEST_ID,
      parentContext: contextStore.getActiveContext(),
      parentRawHistory: contextStore.getRawHistory(),
      signal: lease.signal,
      runOwnership: lease,
    },
  );
}

function runningOutcome(staged: Awaited<ReturnType<typeof stage>>): ToolBatchAgentCallOutcome {
  return {
    status: 'running',
    taskId: staged.taskId,
    ...(staged.taskMutation === undefined ? {} : { taskMutation: staged.taskMutation }),
    dispatch: async () => {
      await staged.dispatch();
    },
  };
}

async function persist(
  controller: AgentRunCheckpointController<OpenAIChatProtocol>,
  lease: AgentRunLease,
  contextStore: ContextStore<OpenAIChatProtocol>,
  pendingBatch: StoredPendingToolBatch,
  approvals: readonly ApprovalRequest[],
  taskCreates: Parameters<AgentRunCheckpointController<OpenAIChatProtocol>['commitWithTasks']>[2],
): Promise<void> {
  const checkpoint = {
    runId: RUN_ID,
    contextStore,
    modelIteration: 0,
    pendingBatch,
    pendingApprovals: approvals,
  };
  if (taskCreates.length === 0) await controller.checkpoint(checkpoint, lease);
  else await controller.commitWithTasks(checkpoint, lease, taskCreates);
}

function settledOutcome(outcome: SubAgentExecutionOutcome): ToolBatchAgentCallOutcome {
  if (outcome.type !== 'terminal')
    throw new Error('The queued recovered task unexpectedly paused.');
  return {
    status: 'settled',
    taskId: outcome.result.task.taskId,
    output: structuredClone(outcome.result as unknown as JsonValue),
    ...(outcome.result.status === 'succeeded' ? {} : { error: outcome.result.error }),
  };
}

function identity(taskId: string): IdentityProjection {
  return { runId: RUN_ID, taskId, callId: CALL_ID, requestId: REQUEST_ID };
}

async function requiredRun(store: AtomicFileAgentRuntimeStateStore) {
  const run = await store.loadRun(SESSION_ID, RUN_ID);
  if (run === undefined) throw new Error('The durable root run is missing.');
  return run;
}

async function requiredTask(store: AtomicFileAgentRuntimeStateStore, taskId: string) {
  const task = await store.loadTask(SESSION_ID, taskId);
  if (task === undefined) throw new Error('The durable child task is missing.');
  return task;
}

function requiredParentCall(batch: StoredPendingToolBatch | undefined) {
  const call = batch?.calls.find(({ callId }) => callId === CALL_ID);
  if (call === undefined) throw new Error('The durable parent call is missing.');
  return call;
}

function requirePendingBatch(batch: StoredPendingToolBatch | undefined): StoredPendingToolBatch {
  if (batch === undefined) throw new Error('The durable parent batch is missing.');
  return batch;
}

function rejectUnexpectedOrdinaryTool(): never {
  throw new Error('The dispatch crash fixture has no ordinary or end Tool call.');
}

function createMetrics(): Metrics {
  return { runnerFactories: 0, runnerRuns: 0 };
}

function parsePhase(value: string | undefined): Phase {
  if (value === 'stage-uncommitted' || value === 'commit-undispatched' || value === 'recover') {
    return value;
  }
  throw new Error('Invalid parent-dispatch crash phase.');
}

function requiredArgument(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function waitForDisconnect(): Promise<void> {
  await new Promise<void>((resolve) => process.once('disconnect', resolve));
}

async function send(message: WorkerMessage): Promise<void> {
  if (process.send === undefined) throw new Error('The parent-dispatch worker requires IPC.');
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => (error ? reject(error) : resolve()));
  });
}

void main()
  .then(() => process.disconnect?.())
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown parent-dispatch failure.';
    try {
      await send({ type: 'failed', message });
    } finally {
      process.exitCode = 1;
      process.disconnect?.();
    }
  });
