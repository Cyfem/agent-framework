import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';
import { expect } from 'vitest';

import { acceptanceIt } from '../../../testkit';
import { AtomicFileAgentRuntimeStateStore } from '../src';

const SESSION_ID = 'root-running-child-process-session';
const ROOT_RUN_LEASE_TTL_MS = 30_000;
const WORKER_CONFIG = fileURLToPath(
  new URL('../vite.running-child-process-fixture.config.ts', import.meta.url),
);

interface Metrics {
  readonly parentProviderCalls: number;
  readonly childProviderCalls: number;
  readonly childFactories: number;
  readonly childToolCalls: number;
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

interface ReadyMessage {
  readonly type: 'ready';
  readonly running: RunningProjection;
  readonly rootStatus: string;
  readonly parentCallStatus: string;
  readonly taskState: string;
  readonly childCheckpointProtocol: string;
  readonly childCheckpointCallStatus: string;
  readonly reconnectCapability: string;
  readonly executionLeaseTtlMs: number;
  readonly metrics: Metrics;
  readonly taskEventTypes: readonly string[];
}

interface CompletedMessage {
  readonly type: 'completed';
  readonly running: RunningProjection;
  readonly rootStatus: string;
  readonly taskState: string;
  readonly childCheckpointProtocol: string;
  readonly reconnectCapability: string;
  readonly reconnectErrorCode: string;
  readonly parentOutputCallIds: readonly string[];
  readonly metrics: Metrics;
  readonly taskEventTypes: readonly string[];
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

acceptanceIt(
  'RUN-04.l3.root-running-child-process-recovery',
  'expired-execution-lease-checkpoint-adoption',
  async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'manee-running-child-process-'));
    const stateRoot = join(workRoot, 'state');
    const bundleRoot = join(workRoot, 'bundle');
    const clockPath = join(workRoot, 'clock.txt');
    const processes: ManagedProcess[] = [];

    try {
      await build({
        configFile: WORKER_CONFIG,
        logLevel: 'silent',
        build: { outDir: bundleRoot, emptyOutDir: true },
      });
      const workerPath = join(bundleRoot, 'running-child-process-recovery-worker.mjs');
      const initialClock = Date.now();
      await writeFile(clockPath, String(initialClock), 'utf8');

      const phaseA = spawnWorker(workerPath, ['phase-a', stateRoot, clockPath]);
      processes.push(phaseA);
      const ready = await waitForMessage<ReadyMessage>(phaseA, 'ready');
      expect(ready).toMatchObject({
        rootStatus: 'running',
        parentCallStatus: 'running',
        taskState: 'running',
        childCheckpointProtocol: 'openai-chat',
        childCheckpointCallStatus: 'result_ready',
        reconnectCapability: 'none',
        metrics: {
          parentProviderCalls: 1,
          childProviderCalls: 1,
          childFactories: 1,
          childToolCalls: 1,
        },
      });
      expect(ready.running.identity).toMatchObject({
        parentCallId: 'root-running-parent-agent-call',
      });
      expect(ready.running.identity.runId).toBeTruthy();
      expect(ready.running.identity.taskId).toBeTruthy();
      expect(ready.running.identity.subagentSessionId).toBeTruthy();
      expect(ready.running.identity.inputHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(ready.running.taskAttempt).toBeGreaterThanOrEqual(1);
      expect(ready.running.executionFencingToken).toMatch(/^(?:0|[1-9][0-9]*)$/u);
      assertExactlyOnce(ready.taskEventTypes, 'task.started');
      expect(ready.taskEventTypes).not.toContain('recovery.started');

      expect(phaseA.child.kill('SIGKILL')).toBe(true);
      await phaseA.closed;
      scanProcessOutput(phaseA);
      await writeFile(
        clockPath,
        String(initialClock + Math.max(ready.executionLeaseTtlMs, ROOT_RUN_LEASE_TTL_MS) + 1),
        'utf8',
      );

      const phaseB = spawnWorker(workerPath, [
        'phase-b',
        stateRoot,
        clockPath,
        ready.running.identity.runId,
        ready.running.identity.taskId,
        ready.running.identity.subagentSessionId,
        ready.running.identity.parentCallId,
        ready.running.identity.inputHash,
      ]);
      processes.push(phaseB);
      const completed = await waitForMessage<CompletedMessage>(phaseB, 'completed');
      await phaseB.closed;
      scanProcessOutput(phaseB);

      expect(completed).toMatchObject({
        running: { identity: ready.running.identity },
        rootStatus: 'succeeded',
        taskState: 'succeeded',
        childCheckpointProtocol: 'openai-chat',
        reconnectCapability: 'none',
        reconnectErrorCode: 'UNSUPPORTED_CAPABILITY',
        parentOutputCallIds: [ready.running.identity.parentCallId],
        metrics: {
          parentProviderCalls: 1,
          childProviderCalls: 2,
          childFactories: 1,
          childToolCalls: 0,
        },
      });
      expect(completed.running.rootRevision).toBeGreaterThan(ready.running.rootRevision);
      expect(completed.running.taskRevision).toBeGreaterThan(ready.running.taskRevision);
      expect(completed.running.taskAttempt).toBeGreaterThan(ready.running.taskAttempt);
      expect(completed.running.executionEpoch).not.toBe(ready.running.executionEpoch);
      expect(BigInt(completed.running.executionFencingToken)).toBeGreaterThan(
        BigInt(ready.running.executionFencingToken),
      );
      expect(BigInt(completed.running.taskFencingToken)).toBeGreaterThan(
        BigInt(ready.running.taskFencingToken),
      );
      assertExactlyOnce(completed.taskEventTypes, 'task.started');
      assertExactlyOnce(completed.taskEventTypes, 'recovery.started');
      assertExactlyOnce(completed.taskEventTypes, 'recovery.resumed');
      assertExactlyOnce(completed.taskEventTypes, 'task.result_submitted');
      assertExactlyOnce(completed.taskEventTypes, 'task.succeeded');
      expect(completed.taskEventTypes).not.toContain('recovery.reconnected');

      const verifier = new AtomicFileAgentRuntimeStateStore({ root: stateRoot });
      await verifier.init();
      const run = await verifier.loadRun(SESSION_ID, ready.running.identity.runId);
      const task = await verifier.loadTask(SESSION_ID, ready.running.identity.taskId);
      expect(run).toMatchObject({
        runId: ready.running.identity.runId,
        status: 'succeeded',
        protocolContext: { protocol: 'openai-chat', codecVersion: '1' },
      });
      expect(run).not.toHaveProperty('pendingBatch');
      expect(task).toMatchObject({
        taskId: ready.running.identity.taskId,
        runId: ready.running.identity.runId,
        subagentSessionId: ready.running.identity.subagentSessionId,
        inputHash: ready.running.identity.inputHash,
        state: 'succeeded',
        childCheckpoint: {
          protocolContext: { protocol: 'openai-chat', codecVersion: '1' },
        },
        result: {
          status: 'succeeded',
          output: { proof: 'root-running-child-recovered' },
        },
      });
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
      reject(
        new Error(
          `Process exited before IPC readiness (${String(code)}/${String(signal)}): ${process.stderr.join('')}`,
        ),
      );
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
  expect(output).not.toMatch(/authorization|api[_-]?key|bearer\s|secret/iu);
}

function assertExactlyOnce(values: readonly string[], expected: string): void {
  expect(values.filter((value) => value === expected)).toHaveLength(1);
}
