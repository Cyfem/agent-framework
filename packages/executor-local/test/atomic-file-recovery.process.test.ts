import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';
import { expect } from 'vitest';

import { acceptanceIt, ManualClock } from '../../../testkit';
import { canonicalJsonSha256, type JsonValue } from '@ruixutong.manee/maneeagent-framework';

import { AtomicFileAgentRuntimeStateStore } from '../src';

const SESSION_ID = 'local-process-session';
const RUN_ID = 'local-process-run';
const SECRET_SENTINEL = 'L3_PRIVATE_SENTINEL_8f19e6b5';
const WORKER_CONFIG = fileURLToPath(new URL('../vite.process-fixture.config.ts', import.meta.url));

interface ReadyMessage {
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

interface CompletedMessage {
  readonly type: 'completed';
  readonly taskId: string;
  readonly staleCasRejected: boolean;
  readonly takeoverFencingToken: string;
  readonly finalFencingToken: string;
  readonly resultReceiptId: string;
  readonly replayReceiptId: string;
  readonly eventIds: readonly string[];
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

acceptanceIt('STORE-LOCAL-04.l3.process-recovery', 'atomic-process', async () => {
  const clock = new ManualClock(10_000);
  const workRoot = await mkdtemp(join(tmpdir(), 'manee-local-process-recovery-'));
  const stateRoot = join(workRoot, 'state');
  const bundleRoot = join(workRoot, 'bundle');
  const clockPath = join(workRoot, 'clock.txt');
  const processes: ManagedProcess[] = [];

  try {
    await writeClock(clockPath, clock.now());
    await build({
      configFile: WORKER_CONFIG,
      logLevel: 'silent',
      build: { outDir: bundleRoot, emptyOutDir: true },
    });
    const workerPath = join(bundleRoot, 'atomic-file-recovery-worker.mjs');

    const phaseA = spawnWorker(workerPath, 'phase-a', stateRoot, clockPath);
    processes.push(phaseA);
    const ready = await waitForMessage<ReadyMessage>(phaseA, 'ready');
    expect(ready.identity).toMatchObject({
      ownerSessionId: SESSION_ID,
      runId: RUN_ID,
      requestId: 'local-process-request',
    });
    expect(ready.approvalId).toBeTruthy();
    expect(ready.approvalRevision).toBeGreaterThan(0);
    expect(BigInt(ready.leaseFencingToken)).toBeGreaterThan(0n);
    expect(ready.leaseExpiresAt).toBeGreaterThan(clock.now());

    const phaseAClosed = phaseA.closed;
    expect(phaseA.child.kill('SIGKILL')).toBe(true);
    await phaseAClosed;
    scanProcessOutput(phaseA);

    clock.advanceTo(ready.leaseExpiresAt);
    await writeClock(clockPath, clock.now());

    const phaseB = spawnWorker(
      workerPath,
      'phase-b',
      stateRoot,
      clockPath,
      ready.leaseFencingToken,
    );
    processes.push(phaseB);
    const completed = await waitForMessage<CompletedMessage>(phaseB, 'completed');
    await phaseB.closed;
    scanProcessOutput(phaseB);

    expect(completed.taskId).toBe(ready.identity.taskId);
    expect(completed.staleCasRejected).toBe(true);
    expect(BigInt(completed.takeoverFencingToken)).toBeGreaterThan(BigInt(ready.leaseFencingToken));
    expect(BigInt(completed.finalFencingToken)).toBeGreaterThan(
      BigInt(completed.takeoverFencingToken),
    );
    expect(completed.replayReceiptId).toBe(completed.resultReceiptId);
    expect(new Set(completed.eventIds).size).toBe(completed.eventIds.length);
    expect(completed.eventIds.slice(0, ready.eventIds.length)).toEqual(ready.eventIds);

    const verifier = new AtomicFileAgentRuntimeStateStore({ root: stateRoot, now: clock.now });
    await verifier.init();
    const finalTask = await verifier.loadTask(SESSION_ID, ready.identity.taskId);
    if (
      finalTask?.binding === undefined ||
      finalTask.childCheckpoint === undefined ||
      finalTask.resultReceipt === undefined
    ) {
      throw new Error('The final Atomic File task is incomplete.');
    }
    expect(finalTask).toMatchObject({
      ownerSessionId: ready.identity.ownerSessionId,
      runId: ready.identity.runId,
      taskId: ready.identity.taskId,
      subagentSessionId: ready.identity.subagentSessionId,
      requestId: ready.identity.requestId,
      state: 'succeeded',
      attempt: 2,
      output: { answer: 'process-recovered' },
      resultReceipt: { receiptId: completed.resultReceiptId },
      result: {
        status: 'succeeded',
        executor: 'local',
        output: { answer: 'process-recovered' },
      },
    });
    expect(hashJson(finalTask.binding)).toBe(ready.bindingHash);
    expect(hashJson(finalTask.childCheckpoint)).toBe(ready.checkpointHash);
    expect(BigInt(finalTask.fencingToken)).toBeGreaterThan(BigInt(ready.leaseFencingToken));

    const events = await verifier.readEvents(SESSION_ID, finalTask.taskId);
    expect(events.map(({ eventId }) => eventId)).toEqual(completed.eventIds);
    expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter(({ type }) => type === 'task.result_submitted')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'task.succeeded')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'approval.requested')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'approval.decided')).toHaveLength(1);
  } finally {
    try {
      await Promise.all(processes.map((process) => terminateProcess(process)));
      for (const process of processes) scanProcessOutput(process);
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  }
});

function spawnWorker(
  workerPath: string,
  phase: 'phase-a' | 'phase-b',
  stateRoot: string,
  clockPath: string,
  staleFencingToken?: string,
): ManagedProcess {
  const child = fork(
    workerPath,
    [phase, stateRoot, clockPath, ...(staleFencingToken ? [staleFencingToken] : [])],
    {
      cwd: dirname(workerPath),
      env: childEnvironment(),
      silent: true,
    },
  );
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
    }, 30_000);
    const onMessage = (value: unknown): void => {
      if (!isWorkerMessage(value)) return;
      cleanup();
      if (value.type === 'failed') reject(new Error(value.message));
      else if (value.type !== expectedType)
        reject(new Error(`Unexpected IPC message ${value.type}.`));
      else resolve(value as T);
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

async function writeClock(path: string, value: number): Promise<void> {
  const candidate = `${path}.next`;
  await writeFile(candidate, String(value), { encoding: 'utf8', mode: 0o600 });
  await rename(candidate, path);
}

function hashJson(value: unknown): string {
  return canonicalJsonSha256(value as JsonValue);
}
