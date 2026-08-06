import { assertNetworkDenyGuardInstalled } from '../network-deny.setup';

import { z } from 'zod';

import {
  Agent,
  createSubAgentRuntime,
  defineSubAgent,
  type AgentProtocol,
  type JsonValue,
  type Model,
  OpenAIChatModel,
  type OpenAIChatProtocol,
  OpenAIResponsesModel,
  type OpenAIResponsesProtocol,
  SubAgentRuntimeError,
  type StoredPendingToolCall,
  type SubAgentRuntime,
} from '@ruixutong.manee/maneeagent-framework';

import {
  AtomicFileAgentRuntimeStateStore,
  createLocalAgentRunnerRegistration,
  LocalSubAgentRunnerRegistry,
  MemorySubAgentExecutor,
} from '../../src';

assertNetworkDenyGuardInstalled();

type ProtocolKind = 'chat' | 'responses';
type Phase = 'phase-a' | 'phase-b';

const EXECUTOR_NAME = 'local-cross-protocol-process';
const RUNNER_VERSION = '2.0.0';

const inputSchema = z
  .object({
    parentProtocol: z.enum(['chat', 'responses']),
    childProtocol: z.enum(['chat', 'responses']),
    marker: z.literal('cross-protocol-process-proof'),
  })
  .strict();
const outputSchema = z
  .object({
    parentProtocol: z.enum(['chat', 'responses']),
    childProtocol: z.enum(['chat', 'responses']),
    proof: z.literal('cross-protocol-process-recovered'),
  })
  .strict();
type ProofInput = z.infer<typeof inputSchema>;
type ProofOutput = z.infer<typeof outputSchema>;

const definition = defineSubAgent({
  name: 'cross-protocol-process-proof',
  version: '2',
  description: 'Resume an approval-paused cross-protocol child from an Atomic File checkpoint.',
  inputSchema,
  outputSchema,
});

interface ProviderToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
}

interface ProviderToolOutput {
  readonly callId: string;
  readonly output: JsonValue;
}

interface ProtocolSpec<P extends AgentProtocol> {
  readonly kind: ProtocolKind;
  readonly checkpointProtocol: string;
  createModel(responder: (round: number, payload: unknown) => unknown | Promise<unknown>): Model<P>;
  toolResponse(calls: readonly ProviderToolCall[]): unknown;
  extractToolOutputs(payload: unknown): readonly ProviderToolOutput[];
  assertRequest(payload: unknown): void;
}

interface Metrics {
  ordinaryToolCalls: number;
  approvalToolCalls: number;
  parentProviderCalls: number;
  childProviderCalls: number;
  childFactories: number;
}

interface IdentityProjection {
  readonly sessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly subagentSessionId: string;
  readonly parentCallId: string;
  readonly approvalId: string;
  readonly approvalRevision: number;
  readonly approvalCallId: string;
  readonly inputHash: string;
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
      readonly parentProtocol: ProtocolKind;
      readonly childProtocol: ProtocolKind;
      readonly identity: IdentityProjection;
      readonly parentCheckpointProtocol: string;
      readonly childCheckpointProtocol: string;
      readonly calls: readonly CallProjection[];
      readonly reconnectCapability: string;
      readonly metrics: Readonly<Metrics>;
      readonly taskAttempt: number;
      readonly taskEventTypes: readonly string[];
    }
  | {
      readonly type: 'completed';
      readonly parentProtocol: ProtocolKind;
      readonly childProtocol: ProtocolKind;
      readonly identity: IdentityProjection;
      readonly parentCheckpointProtocol: string;
      readonly childCheckpointProtocol: string;
      readonly outputCallIds: readonly string[];
      readonly outputPayloads: readonly JsonValue[];
      readonly reconnectCapability: string;
      readonly reconnectErrorCode: string;
      readonly metrics: Readonly<Metrics>;
      readonly runStatus: string;
      readonly taskState: string;
      readonly taskAttempt: number;
      readonly taskEventTypes: readonly string[];
    }
  | { readonly type: 'failed'; readonly message: string };

const chatSpec: ProtocolSpec<OpenAIChatProtocol> = {
  kind: 'chat',
  checkpointProtocol: 'openai-chat',
  createModel(responder) {
    let round = 0;
    return new OpenAIChatModel({
      model: 'offline-cross-protocol-process-chat',
      client: {
        chat: {
          completions: {
            create: (payload: unknown) => responder(round++, payload),
          },
        },
      } as never,
    });
  },
  toolResponse: chatToolResponse,
  extractToolOutputs: extractChatToolOutputs,
  assertRequest(payload) {
    const record = readRecord(payload);
    if (!Array.isArray(record.messages) || 'input' in record) {
      throw new Error('Chat provider request used the wrong wire shape.');
    }
  },
};

const responsesSpec: ProtocolSpec<OpenAIResponsesProtocol> = {
  kind: 'responses',
  checkpointProtocol: 'openai-responses',
  createModel(responder) {
    let round = 0;
    return new OpenAIResponsesModel({
      model: 'offline-cross-protocol-process-responses',
      client: {
        responses: {
          create: (payload: unknown) => responder(round++, payload),
        },
      } as never,
    });
  },
  toolResponse: responsesToolResponse,
  extractToolOutputs: extractResponsesToolOutputs,
  assertRequest(payload) {
    const record = readRecord(payload);
    if (!Array.isArray(record.input) || 'messages' in record) {
      throw new Error('Responses provider request used the wrong wire shape.');
    }
  },
};

async function main(): Promise<void> {
  const phase = parsePhase(process.argv[2]);
  const stateRoot = requiredArgument(process.argv[3], 'state root');
  const parentKind = parseProtocol(process.argv[4]);
  const childKind = parseProtocol(process.argv[5]);
  const store = new AtomicFileAgentRuntimeStateStore({ root: stateRoot });
  await store.init();

  if (phase === 'phase-a') {
    await runPhaseA(store, parentKind, childKind);
    return;
  }

  await runPhaseB(store, parentKind, childKind, {
    sessionId: requiredArgument(process.argv[6], 'session id'),
    runId: requiredArgument(process.argv[7], 'run id'),
    taskId: requiredArgument(process.argv[8], 'task id'),
    subagentSessionId: requiredArgument(process.argv[9], 'subagent session id'),
    parentCallId: requiredArgument(process.argv[10], 'parent call id'),
    approvalId: requiredArgument(process.argv[11], 'approval id'),
    approvalRevision: parseRevision(process.argv[12]),
    approvalCallId: requiredArgument(process.argv[13], 'approval call id'),
    inputHash: requiredArgument(process.argv[14], 'input hash'),
  });
}

async function runPhaseA(
  store: AtomicFileAgentRuntimeStateStore,
  parentKind: ProtocolKind,
  childKind: ProtocolKind,
): Promise<void> {
  if (parentKind === 'chat') {
    if (childKind === 'chat') await runPhaseAWithSpecs(store, chatSpec, chatSpec);
    else await runPhaseAWithSpecs(store, chatSpec, responsesSpec);
    return;
  }
  if (childKind === 'chat') await runPhaseAWithSpecs(store, responsesSpec, chatSpec);
  else await runPhaseAWithSpecs(store, responsesSpec, responsesSpec);
}

async function runPhaseAWithSpecs<PParent extends AgentProtocol, PChild extends AgentProtocol>(
  store: AtomicFileAgentRuntimeStateStore,
  parentSpec: ProtocolSpec<PParent>,
  childSpec: ProtocolSpec<PChild>,
): Promise<void> {
  const metrics = createMetrics();
  const input = proofInput(parentSpec.kind, childSpec.kind);
  const sessionId = sessionIdFor(parentSpec.kind, childSpec.kind);
  const { runtime, reconnectCapability } = await createRuntime(
    store,
    sessionId,
    childSpec,
    'phase-a',
    metrics,
  );
  const parent = createParent(parentSpec, runtime, input, 'phase-a', metrics);
  const outcome = await parent.agent(`start:${parentSpec.kind}:${childSpec.kind}`);
  if (outcome.status !== 'waiting_approval' || outcome.approvals.length !== 1) {
    throw new Error(`Phase A expected one approval, received ${outcome.status}.`);
  }
  const approval = outcome.approvals[0]!;
  const run = await store.loadRun(sessionId, outcome.runId);
  const tasks = await store.listTasksByRun(sessionId, outcome.runId);
  const task = tasks[0];
  if (
    run === undefined ||
    task === undefined ||
    tasks.length !== 1 ||
    run.status !== 'waiting_approval' ||
    task.state !== 'waiting_approval' ||
    run.pendingBatch === undefined ||
    task.childCheckpoint === undefined
  ) {
    throw new Error('Phase A did not persist the waiting root and child checkpoints.');
  }
  const identity = projectIdentity(sessionId, run.runId, task, approval);
  if (approval.taskId !== task.taskId || approval.callId !== approvalCallId(input)) {
    throw new Error('Phase A approval identity does not match the child checkpoint.');
  }
  if (
    run.protocolContext.protocol !== parentSpec.checkpointProtocol ||
    task.childCheckpoint.protocolContext.protocol !== childSpec.checkpointProtocol
  ) {
    throw new Error('Phase A persisted a checkpoint with the wrong protocol codec.');
  }
  if (
    metrics.ordinaryToolCalls !== 1 ||
    metrics.approvalToolCalls !== 0 ||
    metrics.parentProviderCalls !== 1 ||
    metrics.childProviderCalls !== 1 ||
    metrics.childFactories !== 1
  ) {
    throw new Error(`Phase A call oracle failed: ${JSON.stringify(metrics)}.`);
  }

  await send({
    type: 'ready',
    parentProtocol: parentSpec.kind,
    childProtocol: childSpec.kind,
    identity,
    parentCheckpointProtocol: run.protocolContext.protocol,
    childCheckpointProtocol: task.childCheckpoint.protocolContext.protocol,
    calls: run.pendingBatch.calls.map(projectCall),
    reconnectCapability,
    metrics: { ...metrics },
    taskAttempt: task.attempt,
    taskEventTypes: (await store.readEvents(sessionId, task.taskId)).map(({ type }) => type),
  });

  await new Promise<void>((resolve) => process.once('disconnect', resolve));
}

async function runPhaseB(
  store: AtomicFileAgentRuntimeStateStore,
  parentKind: ProtocolKind,
  childKind: ProtocolKind,
  expectedIdentity: IdentityProjection,
): Promise<void> {
  if (parentKind === 'chat') {
    if (childKind === 'chat') {
      await runPhaseBWithSpecs(store, chatSpec, chatSpec, expectedIdentity);
    } else await runPhaseBWithSpecs(store, chatSpec, responsesSpec, expectedIdentity);
    return;
  }
  if (childKind === 'chat') {
    await runPhaseBWithSpecs(store, responsesSpec, chatSpec, expectedIdentity);
  } else await runPhaseBWithSpecs(store, responsesSpec, responsesSpec, expectedIdentity);
}

async function runPhaseBWithSpecs<PParent extends AgentProtocol, PChild extends AgentProtocol>(
  store: AtomicFileAgentRuntimeStateStore,
  parentSpec: ProtocolSpec<PParent>,
  childSpec: ProtocolSpec<PChild>,
  expectedIdentity: IdentityProjection,
): Promise<void> {
  const input = proofInput(parentSpec.kind, childSpec.kind);
  if (expectedIdentity.sessionId !== sessionIdFor(parentSpec.kind, childSpec.kind)) {
    throw new Error('Phase B received an identity for another protocol variant.');
  }
  const waitingRun = await store.loadRun(expectedIdentity.sessionId, expectedIdentity.runId);
  const waitingTask = await store.loadTask(expectedIdentity.sessionId, expectedIdentity.taskId);
  if (
    waitingRun?.status !== 'waiting_approval' ||
    waitingTask?.state !== 'waiting_approval' ||
    waitingRun.protocolContext.protocol !== parentSpec.checkpointProtocol ||
    waitingTask.childCheckpoint?.protocolContext.protocol !== childSpec.checkpointProtocol
  ) {
    throw new Error('Phase B could not restore the exact cross-protocol waiting state.');
  }
  const approval = waitingRun.pendingApprovals.find(
    ({ approvalId }) => approvalId === expectedIdentity.approvalId,
  );
  if (
    approval === undefined ||
    approval.revision !== expectedIdentity.approvalRevision ||
    projectIdentity(expectedIdentity.sessionId, waitingRun.runId, waitingTask, approval).runId !==
      expectedIdentity.runId ||
    waitingTask.subagentSessionId !== expectedIdentity.subagentSessionId ||
    waitingTask.inputHash !== expectedIdentity.inputHash
  ) {
    throw new Error('Phase B durable identities differ from the first process.');
  }

  const metrics = createMetrics();
  const { runtime, reconnectCapability } = await createRuntime(
    store,
    expectedIdentity.sessionId,
    childSpec,
    'phase-b',
    metrics,
  );
  const reconnectErrorCode = await rejectedReconnectCode(
    runtime,
    expectedIdentity.sessionId,
    expectedIdentity.taskId,
  );
  let parentResultRequest: unknown;
  const parent = createParent(parentSpec, runtime, input, 'phase-b', metrics, (request) => {
    parentResultRequest = request;
  });
  const outcome = await parent.resumeRun({
    runId: expectedIdentity.runId,
    decisions: [
      {
        approvalId: expectedIdentity.approvalId,
        decision: 'approved',
        expectedRevision: expectedIdentity.approvalRevision,
      },
    ],
  });
  if (outcome.status !== 'succeeded' || outcome.runId !== expectedIdentity.runId) {
    throw new Error(`Phase B did not succeed the original run: ${outcome.status}.`);
  }

  const finalRun = await store.loadRun(expectedIdentity.sessionId, expectedIdentity.runId);
  const finalTask = await store.loadTask(expectedIdentity.sessionId, expectedIdentity.taskId);
  if (
    finalRun?.status !== 'succeeded' ||
    finalTask?.state !== 'succeeded' ||
    finalRun.protocolContext.protocol !== parentSpec.checkpointProtocol ||
    finalTask.childCheckpoint?.protocolContext.protocol !== childSpec.checkpointProtocol ||
    finalTask.subagentSessionId !== expectedIdentity.subagentSessionId ||
    finalTask.inputHash !== expectedIdentity.inputHash
  ) {
    throw new Error('Phase B final state lost identity or protocol checkpoint fidelity.');
  }
  if (
    metrics.ordinaryToolCalls !== 0 ||
    metrics.approvalToolCalls !== 1 ||
    metrics.parentProviderCalls !== 1 ||
    metrics.childProviderCalls !== 2 ||
    metrics.childFactories !== 1
  ) {
    throw new Error(`Phase B replay oracle failed: ${JSON.stringify(metrics)}.`);
  }
  const outputs = parentSpec.extractToolOutputs(parentResultRequest);
  const events = (await store.readEvents(expectedIdentity.sessionId, expectedIdentity.taskId)).map(
    ({ type }) => type,
  );
  if (!events.includes('task.resumed') || events.includes('recovery.reconnected')) {
    throw new Error('Local recovery did not use the checkpoint-resume path exclusively.');
  }

  await send({
    type: 'completed',
    parentProtocol: parentSpec.kind,
    childProtocol: childSpec.kind,
    identity: projectIdentity(expectedIdentity.sessionId, finalRun.runId, finalTask, approval),
    parentCheckpointProtocol: finalRun.protocolContext.protocol,
    childCheckpointProtocol: finalTask.childCheckpoint.protocolContext.protocol,
    outputCallIds: outputs.map(({ callId }) => callId),
    outputPayloads: outputs.map(({ output }) => output),
    reconnectCapability,
    reconnectErrorCode,
    metrics: { ...metrics },
    runStatus: finalRun.status,
    taskState: finalTask.state,
    taskAttempt: finalTask.attempt,
    taskEventTypes: events,
  });
}

async function createRuntime<PChild extends AgentProtocol>(
  store: AtomicFileAgentRuntimeStateStore,
  sessionId: string,
  childSpec: ProtocolSpec<PChild>,
  phase: Phase,
  metrics: Metrics,
): Promise<{ readonly runtime: SubAgentRuntime; readonly reconnectCapability: string }> {
  const registration = createLocalAgentRunnerRegistration({
    definition,
    runnerId: `cross-protocol-${childSpec.kind}-runner`,
    runnerVersion: RUNNER_VERSION,
    createAgent({ request }) {
      const input = inputSchema.parse(request.input);
      metrics.childFactories += 1;
      const child = new Agent<PChild>({
        llm: childSpec.createModel((round, payload) => {
          metrics.childProviderCalls += 1;
          childSpec.assertRequest(payload);
          if (phase === 'phase-a' && round === 0) {
            return childSpec.toolResponse([
              {
                callId: approvalCallId(input),
                name: approvalToolName(input),
                input: { marker: 'approval-required' },
              },
            ]);
          }
          if (phase === 'phase-b' && round === 0) {
            return childSpec.toolResponse([
              {
                callId: childResultCallId(input),
                name: 'agent-result',
                input: { result: expectedOutput(input) },
              },
            ]);
          }
          if (phase === 'phase-b' && round === 1) {
            return childSpec.toolResponse([
              { callId: childEndCallId(input), name: 'end-agent', input: {} },
            ]);
          }
          throw new Error(`Unexpected ${phase}/${childSpec.kind} child provider round ${round}.`);
        }),
        maxIterations: 4,
        systemPrompts: ['After approval, submit the typed proof and call end-agent alone.'],
      });
      child.tools.push({
        name: approvalToolName(input),
        description: 'Approval-gated proof that must execute exactly once after recovery.',
        parameters: z.object({ marker: z.literal('approval-required') }).strict(),
        approval: { summary: 'Approve cross-protocol process recovery.' },
        handler: () => {
          metrics.approvalToolCalls += 1;
          return { approved: true };
        },
      });
      return child;
    },
    buildInput: ({ input }) => {
      const parsed = inputSchema.parse(input);
      return `child:${parsed.parentProtocol}:${parsed.childProtocol}:${parsed.marker}`;
    },
  });
  const executor = new MemorySubAgentExecutor({
    name: EXECUTOR_NAME,
    registry: new LocalSubAgentRunnerRegistry([registration]),
  });
  const runtime = createSubAgentRuntime({
    sessionId,
    activeDefinitions: [definition],
    executors: [executor],
    stateStore: store,
  });
  await runtime.init();
  return {
    runtime,
    reconnectCapability: executor.descriptor.capabilities.recovery.reconnect,
  };
}

function createParent<PParent extends AgentProtocol>(
  parentSpec: ProtocolSpec<PParent>,
  runtime: SubAgentRuntime,
  input: ProofInput,
  phase: Phase,
  metrics: Metrics,
  captureResultRequest?: (request: unknown) => void,
): Agent<PParent> {
  const parent = new Agent<PParent>({
    llm: parentSpec.createModel((round, payload) => {
      metrics.parentProviderCalls += 1;
      parentSpec.assertRequest(payload);
      if (phase === 'phase-a' && round === 0) {
        return parentSpec.toolResponse([
          {
            callId: ordinaryCallId(input),
            name: ordinaryToolName(input),
            input: { marker: 'ordinary-once' },
          },
          {
            callId: parentCallId(input),
            name: 'agent',
            input: {
              subAgent: definition.name,
              executor: EXECUTOR_NAME,
              input,
            },
          },
        ]);
      }
      if (phase === 'phase-b' && round === 0) {
        captureResultRequest?.(payload);
        return parentSpec.toolResponse([
          { callId: parentEndCallId(input), name: 'end-agent', input: {} },
        ]);
      }
      throw new Error(`Unexpected ${phase}/${parentSpec.kind} parent provider round ${round}.`);
    }),
    subAgentRuntime: runtime,
    sessionId: sessionIdFor(input.parentProtocol, input.childProtocol),
    maxIterations: 4,
    systemPrompts: ['Run the ordinary proof and child, then call end-agent alone.'],
  });
  parent.tools.push({
    name: ordinaryToolName(input),
    description: 'A parent Tool persisted before child placement and never replayed on resume.',
    parameters: z.object({ marker: z.literal('ordinary-once') }).strict(),
    handler: () => {
      metrics.ordinaryToolCalls += 1;
      return { proof: 'ordinary-settled' };
    },
  });
  return parent.init();
}

async function rejectedReconnectCode(
  runtime: SubAgentRuntime,
  sessionId: string,
  taskId: string,
): Promise<string> {
  try {
    await runtime.reconnect(sessionId, taskId);
    throw new Error('Local reconnect unexpectedly succeeded.');
  } catch (error) {
    if (!(error instanceof SubAgentRuntimeError)) throw error;
    if (error.descriptor.code !== 'UNSUPPORTED_CAPABILITY') {
      throw new Error(`Local reconnect returned ${error.descriptor.code}.`, { cause: error });
    }
    return error.descriptor.code;
  }
}

function proofInput(parentProtocol: ProtocolKind, childProtocol: ProtocolKind): ProofInput {
  return {
    parentProtocol,
    childProtocol,
    marker: 'cross-protocol-process-proof',
  };
}

function expectedOutput(input: ProofInput): ProofOutput {
  return {
    parentProtocol: input.parentProtocol,
    childProtocol: input.childProtocol,
    proof: 'cross-protocol-process-recovered',
  };
}

function sessionIdFor(parent: ProtocolKind, child: ProtocolKind): string {
  return `cross-protocol-process-${parent}-parent-${child}-child`;
}

function ordinaryToolName(input: ProofInput): string {
  return `ordinary-${input.parentProtocol}-${input.childProtocol}`;
}

function ordinaryCallId(input: ProofInput): string {
  return `parent-ordinary-${input.parentProtocol}-${input.childProtocol}`;
}

function parentCallId(input: ProofInput): string {
  return `parent-agent-${input.parentProtocol}-${input.childProtocol}`;
}

function parentEndCallId(input: ProofInput): string {
  return `parent-end-${input.parentProtocol}-${input.childProtocol}`;
}

function approvalToolName(input: ProofInput): string {
  return `approval-${input.parentProtocol}-${input.childProtocol}`;
}

function approvalCallId(input: ProofInput): string {
  return `child-approval-${input.parentProtocol}-${input.childProtocol}`;
}

function childResultCallId(input: ProofInput): string {
  return `child-result-${input.parentProtocol}-${input.childProtocol}`;
}

function childEndCallId(input: ProofInput): string {
  return `child-end-${input.parentProtocol}-${input.childProtocol}`;
}

function projectIdentity(
  sessionId: string,
  runId: string,
  task: {
    readonly taskId: string;
    readonly subagentSessionId: string;
    readonly inputHash: string;
    readonly input: JsonValue;
  },
  approval: {
    readonly approvalId: string;
    readonly revision: number;
    readonly callId: string;
  },
): IdentityProjection {
  const input = inputSchema.parse(task.input);
  return {
    sessionId,
    runId,
    taskId: task.taskId,
    subagentSessionId: task.subagentSessionId,
    parentCallId: parentCallId(input),
    approvalId: approval.approvalId,
    approvalRevision: approval.revision,
    approvalCallId: approval.callId,
    inputHash: task.inputHash,
  };
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

function createMetrics(): Metrics {
  return {
    ordinaryToolCalls: 0,
    approvalToolCalls: 0,
    parentProviderCalls: 0,
    childProviderCalls: 0,
    childFactories: 0,
  };
}

function chatToolResponse(calls: readonly ProviderToolCall[]): unknown {
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

function responsesToolResponse(calls: readonly ProviderToolCall[]): unknown {
  return {
    output: calls.map(({ callId, name, input }) => ({
      type: 'function_call',
      id: `item-${callId}`,
      call_id: callId,
      name,
      arguments: JSON.stringify(input),
      status: 'completed',
    })),
  };
}

function extractChatToolOutputs(payload: unknown): readonly ProviderToolOutput[] {
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

function extractResponsesToolOutputs(payload: unknown): readonly ProviderToolOutput[] {
  return readArray(readRecord(payload).input).flatMap((message) => {
    const record = readRecord(message);
    if (
      record.type !== 'function_call_output' ||
      typeof record.call_id !== 'string' ||
      typeof record.output !== 'string'
    ) {
      return [];
    }
    return [{ callId: record.call_id, output: JSON.parse(record.output) as JsonValue }];
  });
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function parsePhase(value: string | undefined): Phase {
  if (value === 'phase-a' || value === 'phase-b') return value;
  throw new Error('Invalid process-recovery phase.');
}

function parseProtocol(value: string | undefined): ProtocolKind {
  if (value === 'chat' || value === 'responses') return value;
  throw new Error('Invalid protocol kind.');
}

function parseRevision(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid approval revision.');
  return parsed;
}

function requiredArgument(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function send(message: WorkerMessage): Promise<void> {
  if (process.send === undefined) throw new Error('The process-recovery worker requires IPC.');
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => (error ? reject(error) : resolve()));
  });
}

void main()
  .then(() => {
    process.disconnect?.();
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown process-recovery failure.';
    try {
      await send({ type: 'failed', message });
    } finally {
      process.exitCode = 1;
      process.disconnect?.();
    }
  });
