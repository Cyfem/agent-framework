import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';
import { expect } from 'vitest';

import { acceptanceIt } from '../../../testkit';
import type { JsonValue } from '@ruixutong.manee/maneeagent-framework';

import { AtomicFileAgentRuntimeStateStore } from '../src';

const SESSION_ID = 'local-root-batch-process-session';
const EXECUTOR_NAME = 'local-root-batch-process';
const ORDINARY_CALL_ID = 'parent-ordinary-call';
const APPROVAL_PARENT_CALL_ID = 'parent-approval-agent-call';
const FAST_PARENT_CALL_ID = 'parent-fast-agent-call';
const SECRET_SENTINEL = 'L3_ROOT_BATCH_PRIVATE_SENTINEL_3b8c1a7e';
const WORKER_CONFIG = fileURLToPath(
  new URL('../vite.agent-process-fixture.config.ts', import.meta.url),
);

type Lane = 'approval' | 'fast';

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

interface ReadyMessage {
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

interface CompletedMessage {
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

interface FailedMessage {
  readonly type: 'failed';
  readonly message: string;
}

type WorkerMessage = ReadyMessage | CompletedMessage | FailedMessage;

interface ManagedProcess {
  readonly child: ChildProcess;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly closed: Promise<readonly [number | null, NodeJS.Signals | null]>;
}

acceptanceIt('RUN-04.l3.root-batch-process-recovery', 'atomic-root-batch', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'manee-root-batch-process-'));
  const stateRoot = join(workRoot, 'state');
  const bundleRoot = join(workRoot, 'bundle');
  const processes: ManagedProcess[] = [];

  try {
    await build({
      configFile: WORKER_CONFIG,
      logLevel: 'silent',
      build: { outDir: bundleRoot, emptyOutDir: true },
    });
    const workerPath = join(bundleRoot, 'agent-batch-recovery-worker.mjs');

    const phaseA = spawnWorker(workerPath, ['phase-a', stateRoot]);
    processes.push(phaseA);
    const ready = await waitForMessage<ReadyMessage>(phaseA, 'ready');

    expect(ready.runId).toBeTruthy();
    expect(ready.approval).toMatchObject({
      taskId: ready.approvalTaskId,
      callId: 'child-approval-tool-call',
    });
    expect(ready.approval.revision).toBeGreaterThan(0);
    expect(ready.ordinaryCalls).toBe(1);
    expect(ready.parentProviderCalls).toBe(1);
    expect([...ready.childFactoryLanes].sort()).toEqual(['approval', 'fast']);
    expect(ready.childProviderCalls).toEqual({ approval: 1, fast: 2 });
    expect(ready.calls).toMatchObject([
      expect.objectContaining({
        callId: ORDINARY_CALL_ID,
        name: 'ordinary-proof',
        status: 'settled',
      }),
      expect.objectContaining({
        callId: APPROVAL_PARENT_CALL_ID,
        name: 'agent',
        status: 'paused',
        taskId: ready.approvalTaskId,
      }),
      expect.objectContaining({
        callId: FAST_PARENT_CALL_ID,
        name: 'agent',
        status: 'settled',
        taskId: ready.fastTaskId,
      }),
    ]);
    expect(parseStoredOutput(ready.calls[0]?.output)).toEqual({ proof: 'ordinary-proof' });
    expect(parseStoredOutput(ready.calls[2]?.output)).toMatchObject({
      status: 'succeeded',
      executor: EXECUTOR_NAME,
      output: { lane: 'fast', proof: 'fast-proof' },
    });

    expect(phaseA.child.kill('SIGKILL')).toBe(true);
    await phaseA.closed;
    scanProcessOutput(phaseA);

    const phaseB = spawnWorker(workerPath, [
      'phase-b',
      stateRoot,
      ready.runId,
      ready.approval.approvalId,
      String(ready.approval.revision),
      ready.approvalTaskId,
      ready.fastTaskId,
    ]);
    processes.push(phaseB);
    const completed = await waitForMessage<CompletedMessage>(phaseB, 'completed');
    await phaseB.closed;
    scanProcessOutput(phaseB);

    expect(completed).toMatchObject({
      runId: ready.runId,
      approvalTaskId: ready.approvalTaskId,
      fastTaskId: ready.fastTaskId,
      resultCallIds: [ORDINARY_CALL_ID, APPROVAL_PARENT_CALL_ID, FAST_PARENT_CALL_ID],
      ordinaryCalls: 0,
      approvalHandlerCalls: 1,
      parentProviderCalls: 1,
      childFactoryLanes: ['approval'],
      childProviderCalls: { approval: 2, fast: 0 },
      runStatus: 'succeeded',
      taskStates: ['succeeded', 'succeeded'],
    });
    expect(completed.resultPayloads).toEqual([
      { proof: 'ordinary-proof' },
      expect.objectContaining({
        status: 'succeeded',
        executor: EXECUTOR_NAME,
        task: expect.objectContaining({ taskId: ready.approvalTaskId }),
        output: { lane: 'approval', proof: 'approval-proof' },
      }),
      expect.objectContaining({
        status: 'succeeded',
        executor: EXECUTOR_NAME,
        task: expect.objectContaining({ taskId: ready.fastTaskId }),
        output: { lane: 'fast', proof: 'fast-proof' },
      }),
    ]);
    assertExactlyOnce(completed.approvalEventTypes, 'approval.requested');
    assertExactlyOnce(completed.approvalEventTypes, 'approval.decided');
    assertExactlyOnce(completed.approvalEventTypes, 'task.result_submitted');
    assertExactlyOnce(completed.approvalEventTypes, 'task.succeeded');
    assertExactlyOnce(completed.fastEventTypes, 'task.result_submitted');
    assertExactlyOnce(completed.fastEventTypes, 'task.succeeded');

    const verifier = new AtomicFileAgentRuntimeStateStore({ root: stateRoot });
    await verifier.init();
    const run = await verifier.loadRun(SESSION_ID, ready.runId);
    const tasks = await verifier.listTasksByRun(SESSION_ID, ready.runId);
    expect(run).toMatchObject({
      runId: ready.runId,
      status: 'succeeded',
      pendingApprovals: [],
    });
    expect(run).not.toHaveProperty('pendingBatch');
    expect(tasks).toHaveLength(2);
    expect(tasks.find(({ taskId }) => taskId === ready.approvalTaskId)).toMatchObject({
      state: 'succeeded',
      input: { lane: 'approval' },
      resultReceipt: { callId: 'approval-result-call' },
      result: { status: 'succeeded', output: { lane: 'approval', proof: 'approval-proof' } },
    });
    expect(tasks.find(({ taskId }) => taskId === ready.fastTaskId)).toMatchObject({
      state: 'succeeded',
      input: { lane: 'fast' },
      resultReceipt: { callId: 'fast-result-call' },
      result: { status: 'succeeded', output: { lane: 'fast', proof: 'fast-proof' } },
    });
  } finally {
    try {
      await Promise.all(processes.map((process) => terminateProcess(process)));
      for (const process of processes) scanProcessOutput(process);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  }
});

function spawnWorker(workerPath: string, args: readonly string[]): ManagedProcess {
  const child = fork(workerPath, [...args], {
    cwd: dirname(workerPath),
    env: childEnvironment(),
    silent: true,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
  const closed = once(child, 'close').then(
    ([code, signal]) => [code as number | null, signal as NodeJS.Signals | null] as const,
  );
  return { child, stdout, stderr, closed };
}

function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'ComSpec'] as const;
  const env: NodeJS.ProcessEnv = { NODE_DISABLE_COLORS: '1' };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function waitForMessage<T extends WorkerMessage>(
  process: ManagedProcess,
  expectedType: T['type'],
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for process IPC message ${expectedType}.`));
    }, 45_000);
    const onMessage = (value: unknown): void => {
      if (!isWorkerMessage(value)) return;
      cleanup();
      if (value.type === 'failed') reject(new Error(value.message));
      else if (value.type !== expectedType) {
        reject(new Error(`Unexpected IPC message ${value.type}.`));
      } else resolve(value as T);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Process exited before IPC readiness (${String(code)}/${String(signal)}).`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      process.child.off('message', onMessage);
      process.child.off('error', onError);
      process.child.off('exit', onExit);
    };
    process.child.on('message', onMessage);
    process.child.once('error', onError);
    process.child.once('exit', onExit);
  });
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    ['ready', 'completed', 'failed'].includes(String((value as { type?: unknown }).type))
  );
}

async function terminateProcess(process: ManagedProcess): Promise<void> {
  if (process.child.exitCode === null && process.child.signalCode === null) {
    process.child.kill('SIGKILL');
  }
  await process.closed;
}

function scanProcessOutput(process: ManagedProcess): void {
  const output = `${process.stdout.join('')}\n${process.stderr.join('')}`;
  expect(output).not.toContain(SECRET_SENTINEL);
  expect(output).not.toMatch(/authorization|api[_-]?key|bearer\s|secret/iu);
}

function assertExactlyOnce(values: readonly string[], expected: string): void {
  expect(values.filter((value) => value === expected)).toHaveLength(1);
}

function parseStoredOutput(value: JsonValue | undefined): JsonValue | undefined {
  return typeof value === 'string' ? (JSON.parse(value) as JsonValue) : value;
}
