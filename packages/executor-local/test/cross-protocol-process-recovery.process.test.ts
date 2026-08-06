import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';
import { expect } from 'vitest';

import type { JsonValue } from '@ruixutong.manee/maneeagent-framework';

import { acceptanceIt } from '../../../testkit';
import { AtomicFileAgentRuntimeStateStore } from '../src';

type ProtocolKind = 'chat' | 'responses';

const EXECUTOR_NAME = 'local-cross-protocol-process';
const WORKER_CONFIG = fileURLToPath(
  new URL('../vite.cross-protocol-process-fixture.config.ts', import.meta.url),
);
const SECRET_SENTINEL = 'CROSS_PROTOCOL_PROCESS_PRIVATE_SENTINEL_7fc41a30';
const variants = Object.freeze([
  Object.freeze({ parent: 'responses' as const, child: 'chat' as const }),
  Object.freeze({ parent: 'chat' as const, child: 'responses' as const }),
]);

interface Metrics {
  readonly ordinaryToolCalls: number;
  readonly approvalToolCalls: number;
  readonly parentProviderCalls: number;
  readonly childProviderCalls: number;
  readonly childFactories: number;
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

interface ReadyMessage {
  readonly type: 'ready';
  readonly parentProtocol: ProtocolKind;
  readonly childProtocol: ProtocolKind;
  readonly identity: IdentityProjection;
  readonly parentCheckpointProtocol: string;
  readonly childCheckpointProtocol: string;
  readonly calls: readonly CallProjection[];
  readonly reconnectCapability: string;
  readonly metrics: Metrics;
  readonly taskAttempt: number;
  readonly taskEventTypes: readonly string[];
}

interface CompletedMessage {
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
  readonly metrics: Metrics;
  readonly runStatus: string;
  readonly taskState: string;
  readonly taskAttempt: number;
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
  'PRO-05.l3.cross-protocol-process-recovery',
  'bidirectional-approval-atomic-file',
  async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'manee-cross-protocol-process-'));
    const bundleRoot = join(workRoot, 'bundle');
    const processes: ManagedProcess[] = [];

    try {
      await build({
        configFile: WORKER_CONFIG,
        logLevel: 'silent',
        build: { outDir: bundleRoot, emptyOutDir: true },
      });
      const workerPath = join(bundleRoot, 'cross-protocol-process-recovery-worker.mjs');

      for (const variant of variants) {
        const stateRoot = join(workRoot, `state-${variant.parent}-${variant.child}`);
        await runVariant(workerPath, stateRoot, variant.parent, variant.child, processes);
      }
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

async function runVariant(
  workerPath: string,
  stateRoot: string,
  parent: ProtocolKind,
  child: ProtocolKind,
  processes: ManagedProcess[],
): Promise<void> {
  const phaseA = spawnWorker(workerPath, ['phase-a', stateRoot, parent, child]);
  processes.push(phaseA);
  const ready = await waitForMessage<ReadyMessage>(phaseA, 'ready');

  expect(ready).toMatchObject({
    parentProtocol: parent,
    childProtocol: child,
    parentCheckpointProtocol: checkpointProtocol(parent),
    childCheckpointProtocol: checkpointProtocol(child),
    reconnectCapability: 'none',
    metrics: {
      ordinaryToolCalls: 1,
      approvalToolCalls: 0,
      parentProviderCalls: 1,
      childProviderCalls: 1,
      childFactories: 1,
    },
  });
  expect(ready.identity).toMatchObject({
    sessionId: `cross-protocol-process-${parent}-parent-${child}-child`,
    parentCallId: `parent-agent-${parent}-${child}`,
    approvalCallId: `child-approval-${parent}-${child}`,
  });
  expect(ready.identity.runId).toBeTruthy();
  expect(ready.identity.taskId).toBeTruthy();
  expect(ready.identity.subagentSessionId).toBeTruthy();
  expect(ready.identity.inputHash).toMatch(/^[0-9a-f]{64}$/u);
  expect(ready.taskAttempt).toBeGreaterThanOrEqual(1);
  expect(ready.calls).toMatchObject([
    {
      callId: `parent-ordinary-${parent}-${child}`,
      name: `ordinary-${parent}-${child}`,
      status: 'settled',
    },
    {
      callId: ready.identity.parentCallId,
      name: 'agent',
      status: 'paused',
      taskId: ready.identity.taskId,
    },
  ]);
  expect(parseStoredOutput(ready.calls[0]?.output)).toEqual({ proof: 'ordinary-settled' });
  assertExactlyOnce(ready.taskEventTypes, 'approval.requested');
  expect(ready.taskEventTypes).not.toContain('approval.decided');

  expect(phaseA.child.kill('SIGKILL')).toBe(true);
  await phaseA.closed;
  scanProcessOutput(phaseA);

  const phaseB = spawnWorker(workerPath, [
    'phase-b',
    stateRoot,
    parent,
    child,
    ready.identity.sessionId,
    ready.identity.runId,
    ready.identity.taskId,
    ready.identity.subagentSessionId,
    ready.identity.parentCallId,
    ready.identity.approvalId,
    String(ready.identity.approvalRevision),
    ready.identity.approvalCallId,
    ready.identity.inputHash,
  ]);
  processes.push(phaseB);
  const completed = await waitForMessage<CompletedMessage>(phaseB, 'completed');
  await phaseB.closed;
  scanProcessOutput(phaseB);

  expect(completed).toMatchObject({
    parentProtocol: parent,
    childProtocol: child,
    identity: ready.identity,
    parentCheckpointProtocol: checkpointProtocol(parent),
    childCheckpointProtocol: checkpointProtocol(child),
    outputCallIds: [`parent-ordinary-${parent}-${child}`, `parent-agent-${parent}-${child}`],
    reconnectCapability: 'none',
    reconnectErrorCode: 'UNSUPPORTED_CAPABILITY',
    metrics: {
      ordinaryToolCalls: 0,
      approvalToolCalls: 1,
      parentProviderCalls: 1,
      childProviderCalls: 2,
      childFactories: 1,
    },
    runStatus: 'succeeded',
    taskState: 'succeeded',
  });
  expect(completed.taskAttempt).toBeGreaterThan(ready.taskAttempt);
  expect(completed.outputPayloads).toEqual([
    { proof: 'ordinary-settled' },
    expect.objectContaining({
      status: 'succeeded',
      executor: EXECUTOR_NAME,
      task: expect.objectContaining({ taskId: ready.identity.taskId }),
      output: {
        parentProtocol: parent,
        childProtocol: child,
        proof: 'cross-protocol-process-recovered',
      },
    }),
  ]);
  assertExactlyOnce(completed.taskEventTypes, 'approval.requested');
  assertExactlyOnce(completed.taskEventTypes, 'approval.decided');
  assertExactlyOnce(completed.taskEventTypes, 'task.resumed');
  assertExactlyOnce(completed.taskEventTypes, 'task.result_submitted');
  assertExactlyOnce(completed.taskEventTypes, 'task.succeeded');
  expect(completed.taskEventTypes).not.toContain('recovery.reconnected');

  const verifier = new AtomicFileAgentRuntimeStateStore({ root: stateRoot });
  await verifier.init();
  const run = await verifier.loadRun(ready.identity.sessionId, ready.identity.runId);
  const task = await verifier.loadTask(ready.identity.sessionId, ready.identity.taskId);
  expect(run).toMatchObject({
    runId: ready.identity.runId,
    ownerSessionId: ready.identity.sessionId,
    status: 'succeeded',
    protocolContext: { protocol: checkpointProtocol(parent), codecVersion: '1' },
  });
  expect(run).not.toHaveProperty('pendingBatch');
  expect(task).toMatchObject({
    taskId: ready.identity.taskId,
    runId: ready.identity.runId,
    subagentSessionId: ready.identity.subagentSessionId,
    inputHash: ready.identity.inputHash,
    state: 'succeeded',
    executor: EXECUTOR_NAME,
    childCheckpoint: {
      protocolContext: { protocol: checkpointProtocol(child), codecVersion: '1' },
    },
    result: {
      status: 'succeeded',
      output: {
        parentProtocol: parent,
        childProtocol: child,
        proof: 'cross-protocol-process-recovered',
      },
    },
  });
}

function checkpointProtocol(kind: ProtocolKind): string {
  return kind === 'chat' ? 'openai-chat' : 'openai-responses';
}

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
