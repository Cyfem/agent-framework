import { assertNetworkDenyGuardInstalled } from '../network-deny.setup';

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import {
  canonicalJsonSha256,
  createSubAgentRuntime,
  DEFAULT_SUBAGENT_LIMITS,
  defineSubAgent,
  type JsonValue,
  type StoredAgentRun,
  type SubAgentChildCheckpoint,
  type SubAgentChildRunner,
  type SubAgentDefinitionRegistration,
  type SubAgentExecutionOutcome,
} from '@ruixutong.manee/maneeagent-framework';

import {
  AtomicFileAgentRuntimeStateStore,
  LocalSubAgentRunnerRegistry,
  MemorySubAgentExecutor,
} from '../../src';

assertNetworkDenyGuardInstalled();

const SESSION_ID = 'local-process-session';
const RUN_ID = 'local-process-run';
const REQUEST_ID = 'local-process-request';
const LEASE_TTL_MS = 1_000;
const RUNNER_ID = 'local-process-runner';
const RUNNER_VERSION = '1';
const APPROVAL_CALL_ID = 'local-process-approval-call';
const APPROVAL_TOOL_NAME = 'local-process-sensitive-tool';

const definition = defineSubAgent({
  name: 'local-process-researcher',
  version: '2',
  description: 'Exercise Atomic File checkpoint recovery in another Node process.',
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ answer: z.string() }),
});

type WorkerMessage =
  | {
      readonly type: 'ready';
      readonly identity: Readonly<{
        ownerSessionId: string;
        runId: string;
        taskId: string;
        subagentSessionId: string;
        requestId: string;
      }>;
      readonly bindingHash: string;
      readonly checkpointHash: string;
      readonly approvalId: string;
      readonly approvalRevision: number;
      readonly leaseFencingToken: string;
      readonly leaseExpiresAt: number;
      readonly eventIds: readonly string[];
    }
  | {
      readonly type: 'completed';
      readonly taskId: string;
      readonly staleCasRejected: boolean;
      readonly takeoverFencingToken: string;
      readonly finalFencingToken: string;
      readonly resultReceiptId: string;
      readonly replayReceiptId: string;
      readonly eventIds: readonly string[];
    }
  | { readonly type: 'failed'; readonly message: string };

async function main(): Promise<void> {
  const phase = process.argv[2];
  const root = process.argv[3];
  const clockPath = process.argv[4];
  if ((phase !== 'phase-a' && phase !== 'phase-b') || !root || !clockPath) {
    throw new Error('Invalid process recovery worker arguments.');
  }

  const store = new AtomicFileAgentRuntimeStateStore({
    root,
    now: () => readClock(clockPath),
  });
  await store.init();
  if (phase === 'phase-a') await runPhaseA(store);
  else {
    const staleFencingToken = process.argv[5];
    if (!staleFencingToken || !/^\d+$/u.test(staleFencingToken)) {
      throw new Error('Phase B requires the fencing token held by the terminated process.');
    }
    await runPhaseB(store, staleFencingToken);
  }
}

async function runPhaseA(store: AtomicFileAgentRuntimeStateStore): Promise<void> {
  await store.createRun(createRun(readClockFromStoreFixture()));
  const runtime = await createRuntime(store, () => createPausingRunner());
  const outcome = await runtime.execute({
    runId: RUN_ID,
    requestId: REQUEST_ID,
    subAgent: definition.name,
    executor: 'local',
    input: { value: 'process-proof' },
  });
  if (outcome.type !== 'paused' || outcome.reason !== 'approval') {
    throw new Error('Phase A did not persist the approval checkpoint.');
  }

  const task = await store.loadTask(SESSION_ID, outcome.task.taskId);
  if (task?.binding === undefined || task.childCheckpoint === undefined) {
    throw new Error('Phase A task is missing its binding or child checkpoint.');
  }
  const approval = outcome.approvals[0];
  if (approval === undefined) throw new Error('Phase A task is missing its approval request.');
  const events = await store.readEvents(SESSION_ID, task.taskId);
  const lease = await store.acquireLease(`subagent-session:${SESSION_ID}`, LEASE_TTL_MS);

  await send({
    type: 'ready',
    identity: {
      ownerSessionId: task.ownerSessionId,
      runId: task.runId,
      taskId: task.taskId,
      subagentSessionId: task.subagentSessionId,
      requestId: task.requestId,
    },
    bindingHash: hashJson(task.binding),
    checkpointHash: hashJson(task.childCheckpoint),
    approvalId: approval.approvalId,
    approvalRevision: approval.revision,
    leaseFencingToken: lease.fencingToken,
    leaseExpiresAt: lease.expiresAt,
    eventIds: events.map(({ eventId }) => eventId),
  });

  await new Promise<void>((resolve) => process.once('disconnect', resolve));
}

async function runPhaseB(
  store: AtomicFileAgentRuntimeStateStore,
  staleFencingToken: string,
): Promise<void> {
  const paused = (await store.listTasksByRun(SESSION_ID, RUN_ID))[0];
  if (
    paused === undefined ||
    paused.state !== 'waiting_approval' ||
    paused.binding === undefined ||
    paused.childCheckpoint === undefined
  ) {
    throw new Error('Phase B could not reconstruct the paused task.');
  }
  const approval = paused.approvals[0];
  if (approval === undefined) throw new Error('Phase B could not reconstruct the approval.');

  const takeover = await store.acquireLease(`subagent-session:${SESSION_ID}`, LEASE_TTL_MS);
  const staleCas = await store.transaction(SESSION_ID, takeover, async (transaction) => {
    const current = await transaction.loadTask(paused.taskId);
    if (current === undefined) throw new Error('The paused task disappeared during takeover.');
    return transaction.compareAndSetTask(current.taskId, current.revision, staleFencingToken, {
      ...current,
      revision: current.revision + 1,
      fencingToken: staleFencingToken,
      updatedAt: readClockFromStoreFixture(),
    });
  });
  const takeoverFencingToken = takeover.fencingToken;
  await takeover.release();
  if (staleCas) throw new Error('The old fencing token unexpectedly won a CAS.');

  let acceptedReceiptId = '';
  let replayReceiptId = '';
  const runtime = await createRuntime(store, () =>
    createResumingRunner((accepted, replayed) => {
      acceptedReceiptId = accepted;
      replayReceiptId = replayed;
    }),
  );
  const outcome = await runtime.resume(SESSION_ID, paused.taskId, {
    decisions: [
      {
        approvalId: approval.approvalId,
        decision: 'approved',
        expectedRevision: approval.revision,
      },
    ],
  });
  if (outcome.type !== 'terminal' || outcome.result.status !== 'succeeded') {
    throw new Error('Phase B did not complete the reconstructed task.');
  }
  const task = await store.loadTask(SESSION_ID, paused.taskId);
  if (task?.resultReceipt === undefined) throw new Error('Phase B result receipt is missing.');
  const events = await store.readEvents(SESSION_ID, paused.taskId);

  await send({
    type: 'completed',
    taskId: paused.taskId,
    staleCasRejected: true,
    takeoverFencingToken,
    finalFencingToken: task.fencingToken,
    resultReceiptId: acceptedReceiptId || task.resultReceipt.receiptId,
    replayReceiptId: replayReceiptId || task.resultReceipt.receiptId,
    eventIds: events.map(({ eventId }) => eventId),
  });
}

async function createRuntime(
  store: AtomicFileAgentRuntimeStateStore,
  runnerFactory: () => SubAgentChildRunner,
) {
  const registry = new LocalSubAgentRunnerRegistry([
    {
      definition,
      runnerId: RUNNER_ID,
      runnerVersion: RUNNER_VERSION,
      childCheckpointVersions: ['1'],
      create: runnerFactory,
    },
  ]);
  const runtime = createSubAgentRuntime({
    sessionId: SESSION_ID,
    activeDefinitions: [definition as unknown as SubAgentDefinitionRegistration],
    executors: [new MemorySubAgentExecutor({ registry })],
    stateStore: store,
  });
  await runtime.init();
  return runtime;
}

function createPausingRunner(): SubAgentChildRunner {
  return {
    async run(child, control) {
      const directive = await control.authorizeTool(
        'local-process-approval-operation-1',
        {
          callId: APPROVAL_CALL_ID,
          toolName: APPROVAL_TOOL_NAME,
          summary: 'Approve the deterministic process recovery proof.',
        },
        createChildCheckpoint(),
      );
      if (directive.type !== 'suspend') throw new Error('Phase A approval did not suspend.');
      return {
        type: 'paused',
        reason: 'approval',
        task: { taskId: child.taskId, subAgent: child.definition },
        approvals: [directive.request],
        checkpointRevision: directive.checkpointRevision,
      };
    },
  };
}

function createResumingRunner(
  recordReceipts: (acceptedReceiptId: string, replayReceiptId: string) => void,
): SubAgentChildRunner {
  return {
    async run(child, control): Promise<SubAgentExecutionOutcome> {
      if (child.checkpoint === undefined) throw new Error('Phase B checkpoint is missing.');
      const directive = await control.authorizeTool(
        'local-process-approval-operation-2',
        {
          callId: APPROVAL_CALL_ID,
          toolName: APPROVAL_TOOL_NAME,
          summary: 'Approve the deterministic process recovery proof.',
        },
        child.checkpoint,
      );
      if (directive.type !== 'approved') throw new Error('Phase B approval was not restored.');

      const output = { answer: 'process-recovered' };
      const accepted = await control.completion.submitResult('local-process-result', output);
      const replayed = await control.completion.submitResult('local-process-result', output);
      if (accepted.status !== 'accepted' || replayed.status !== 'replayed') {
        throw new Error('Phase B result receipt replay was not idempotent.');
      }
      recordReceipts(accepted.receiptId, replayed.receiptId);
      await control.completion.complete('local-process-end', { isStandalone: true });
      return {
        type: 'terminal',
        result: {
          status: 'succeeded',
          task: { taskId: child.taskId, subAgent: child.definition },
          executor: 'local',
          output,
        },
      };
    },
  };
}

function createRun(now: number): StoredAgentRun {
  return {
    recordVersion: '1',
    ownerSessionId: SESSION_ID,
    runId: RUN_ID,
    status: 'running',
    revision: 0,
    fencingToken: '0',
    agentCheckpointVersion: '1',
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
    maxIterations: 4,
    configurationHash: '0'.repeat(64),
    limits: DEFAULT_SUBAGENT_LIMITS,
    budget: {
      descendantsCreated: 0,
      activeExecutions: 0,
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    pendingApprovals: [],
    endRequested: false,
    createdAt: now,
    updatedAt: now,
  };
}

function createChildCheckpoint(): SubAgentChildCheckpoint {
  const input = {};
  return {
    version: '1',
    runnerId: RUNNER_ID,
    runnerVersion: RUNNER_VERSION,
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
    modelIteration: 1,
    maxIterations: 4,
    pendingBatch: {
      version: '1',
      batchId: 'local-process-approval-batch',
      assistantMessage: { protocol: 'openai-chat', codecVersion: '1', value: [] },
      calls: [
        {
          version: '1',
          operationId: 'local-process-pending-operation',
          kind: 'tool',
          callId: APPROVAL_CALL_ID,
          name: APPROVAL_TOOL_NAME,
          input,
          inputHash: canonicalJsonSha256(input),
          status: 'in_flight',
          order: 0,
        },
      ],
      endRequested: false,
      createdAt: 10_000,
    },
  };
}

function readClock(path: string): number {
  const value = Number(readFileSync(path, 'utf8'));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid shared clock fixture.');
  return value;
}

function readClockFromStoreFixture(): number {
  const clockPath = process.argv[4];
  if (!clockPath) throw new Error('The shared clock fixture path is missing.');
  return readClock(clockPath);
}

function hashJson(value: unknown): string {
  return canonicalJsonSha256(value as JsonValue);
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
