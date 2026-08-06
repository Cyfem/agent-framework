import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';
import { expect } from 'vitest';

import { acceptanceIt } from '../../../testkit';
import { AtomicFileAgentRuntimeStateStore } from '../src';

const SESSION_ID = 'parent-dispatch-crash-session';
const RUN_ID = 'parent-dispatch-crash-run';
const CALL_ID = 'parent-dispatch-agent-call';
const ROOT_LEASE_TTL_MS = 1_000;
const WORKER_CONFIG = fileURLToPath(
  new URL('../vite.parent-dispatch-crash-fixture.config.ts', import.meta.url),
);

interface IdentityProjection {
  readonly runId: string;
  readonly taskId: string;
  readonly callId: string;
  readonly requestId: string;
}

interface Metrics {
  readonly runnerFactories: number;
  readonly runnerRuns: number;
}

interface StagedMessage {
  readonly type: 'staged';
  readonly identity: IdentityProjection;
  readonly runRevision: number;
  readonly parentCallStatus: string;
  readonly parentCallTaskId?: string;
  readonly taskVisible: boolean;
  readonly metrics: Metrics;
}

interface CommittedMessage {
  readonly type: 'committed';
  readonly identity: IdentityProjection;
  readonly runRevision: number;
  readonly taskRevision: number;
  readonly taskState: string;
  readonly parentCallStatus: string;
  readonly parentCallTaskId?: string;
  readonly metrics: Metrics;
}

interface CompletedMessage {
  readonly type: 'completed';
  readonly identity: IdentityProjection;
  readonly runStatus: string;
  readonly taskState: string;
  readonly taskAttempt: number;
  readonly taskRevision: number;
  readonly outputCallIds: readonly string[];
  readonly metrics: Metrics;
  readonly taskEventTypes: readonly string[];
}

interface FailedMessage {
  readonly type: 'failed';
  readonly message: string;
}

type WorkerMessage = StagedMessage | CommittedMessage | CompletedMessage | FailedMessage;

interface ManagedProcess {
  readonly child: ChildProcess;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly closed: Promise<readonly [number | null, NodeJS.Signals | null]>;
}

acceptanceIt(
  'RUN-02.l3.parent-child-dispatch-crash-windows',
  'atomic-stage-commit-dispatch-failpoints',
  async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'manee-parent-dispatch-crash-'));
    const stateRoot = join(workRoot, 'state');
    const bundleRoot = join(workRoot, 'bundle');
    const processes: ManagedProcess[] = [];

    try {
      await build({
        configFile: WORKER_CONFIG,
        logLevel: 'silent',
        build: { outDir: bundleRoot, emptyOutDir: true },
      });
      const workerPath = join(bundleRoot, 'parent-dispatch-crash-worker.mjs');

      const beforeCommit = spawnWorker(workerPath, ['stage-uncommitted', stateRoot]);
      processes.push(beforeCommit);
      const staged = await waitForMessage<StagedMessage>(beforeCommit, 'staged');
      expect(staged).toMatchObject({
        identity: { runId: RUN_ID, callId: CALL_ID },
        parentCallStatus: 'pending',
        taskVisible: false,
        metrics: { runnerFactories: 0, runnerRuns: 0 },
      });
      expect(staged.parentCallTaskId).toBeUndefined();
      expect(beforeCommit.child.kill('SIGKILL')).toBe(true);
      await beforeCommit.closed;
      scanProcessOutput(beforeCommit);
      await delay(ROOT_LEASE_TTL_MS + 150);

      const afterFirstCrash = new AtomicFileAgentRuntimeStateStore({ root: stateRoot });
      await afterFirstCrash.init();
      const unlinkedRun = await afterFirstCrash.loadRun(SESSION_ID, RUN_ID);
      expect(unlinkedRun?.pendingBatch?.calls).toMatchObject([
        { callId: CALL_ID, status: 'pending' },
      ]);
      expect(unlinkedRun?.pendingBatch?.calls[0]).not.toHaveProperty('taskId');
      expect(await afterFirstCrash.loadTask(SESSION_ID, staged.identity.taskId)).toBeUndefined();
      expect(await afterFirstCrash.listTasksByRun(SESSION_ID, RUN_ID)).toEqual([]);

      const afterCommit = spawnWorker(workerPath, [
        'commit-undispatched',
        stateRoot,
        staged.identity.taskId,
      ]);
      processes.push(afterCommit);
      const committed = await waitForMessage<CommittedMessage>(afterCommit, 'committed');
      expect(committed).toMatchObject({
        identity: { runId: RUN_ID, callId: CALL_ID },
        taskState: 'queued',
        parentCallStatus: 'running',
        parentCallTaskId: committed.identity.taskId,
        metrics: { runnerFactories: 0, runnerRuns: 0 },
      });
      expect(committed.identity.taskId).not.toBe(staged.identity.taskId);
      expect(afterCommit.child.kill('SIGKILL')).toBe(true);
      await afterCommit.closed;
      scanProcessOutput(afterCommit);
      await delay(ROOT_LEASE_TTL_MS + 150);

      const afterSecondCrash = new AtomicFileAgentRuntimeStateStore({ root: stateRoot });
      await afterSecondCrash.init();
      const linkedRun = await afterSecondCrash.loadRun(SESSION_ID, RUN_ID);
      const queuedTask = await afterSecondCrash.loadTask(SESSION_ID, committed.identity.taskId);
      expect(linkedRun?.pendingBatch?.calls).toMatchObject([
        {
          callId: CALL_ID,
          status: 'running',
          taskId: committed.identity.taskId,
        },
      ]);
      expect(queuedTask).toMatchObject({
        runId: RUN_ID,
        taskId: committed.identity.taskId,
        requestId: committed.identity.requestId,
        state: 'queued',
        revision: committed.taskRevision,
      });

      const recovery = spawnWorker(workerPath, ['recover', stateRoot, committed.identity.taskId]);
      processes.push(recovery);
      const completed = await waitForMessage<CompletedMessage>(recovery, 'completed');
      await recovery.closed;
      scanProcessOutput(recovery);

      expect(completed).toMatchObject({
        identity: committed.identity,
        runStatus: 'succeeded',
        taskState: 'succeeded',
        taskAttempt: 1,
        outputCallIds: [CALL_ID],
        metrics: { runnerFactories: 1, runnerRuns: 1 },
      });
      expect(completed.taskRevision).toBeGreaterThan(committed.taskRevision);
      assertExactlyOnce(completed.taskEventTypes, 'task.queued');
      assertExactlyOnce(completed.taskEventTypes, 'task.started');
      assertExactlyOnce(completed.taskEventTypes, 'task.result_submitted');
      assertExactlyOnce(completed.taskEventTypes, 'task.succeeded');

      const finalStore = new AtomicFileAgentRuntimeStateStore({ root: stateRoot });
      await finalStore.init();
      const finalRun = await finalStore.loadRun(SESSION_ID, RUN_ID);
      const finalTask = await finalStore.loadTask(SESSION_ID, committed.identity.taskId);
      expect(finalRun).toMatchObject({ runId: RUN_ID, status: 'succeeded' });
      expect(finalRun).not.toHaveProperty('pendingBatch');
      expect(finalTask).toMatchObject({
        taskId: committed.identity.taskId,
        runId: RUN_ID,
        state: 'succeeded',
        result: { status: 'succeeded', output: { proof: 'dispatched-once-after-recovery' } },
      });
      expect(await finalStore.loadTask(SESSION_ID, staged.identity.taskId)).toBeUndefined();
      expect(await finalStore.listTasksByRun(SESSION_ID, RUN_ID)).toHaveLength(1);
    } finally {
      try {
        await Promise.all(processes.map((process) => terminateProcess(process)));
        for (const process of processes) scanProcessOutput(process);
      } finally {
        await rm(workRoot, { recursive: true, force: true });
      }
    }
  },
);

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
    ['staged', 'committed', 'completed', 'failed'].includes(
      String((value as { type?: unknown }).type),
    )
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
  expect(output).not.toMatch(/authorization|api[_-]?key|bearer\s|secret/iu);
}

function assertExactlyOnce(values: readonly string[], expected: string): void {
  expect(values.filter((value) => value === expected)).toHaveLength(1);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
