import { fork, type ChildProcess, type Serializable } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { describe, expect } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const TARGET_ENTRY = new URL('./fixtures/process-parent-disconnect-target.mjs', import.meta.url);
const ORPHAN_BOUND_MS = 5_000;
const OBSERVATION_TIMEOUT_MS = 5_500;

type DisconnectScenario =
  | 'ready-then-disconnect'
  | 'waiting-bootstrap-disconnect'
  | 'disconnected-before-serve';

describe('Process direct-child orphan boundary', () => {
  acceptanceIt(
    'C7-PROCESS-32.l3.parent-disconnect-watchdog',
    'ready-bootstrap-wait-and-pre-serve-disconnect',
    async () => {
      assertNetworkDenyGuardInstalled();
      for (const scenario of [
        'ready-then-disconnect',
        'waiting-bootstrap-disconnect',
        'disconnected-before-serve',
      ] as const) {
        await expectBoundedOrphanExit(scenario);
      }
    },
  );
});

async function expectBoundedOrphanExit(scenario: DisconnectScenario): Promise<void> {
  const child = fork(TARGET_ENTRY, scenario === 'ready-then-disconnect' ? [] : [scenario], {
    execPath: process.execPath,
    execArgv: [],
    serialization: 'advanced',
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: createRawFixtureEnvironment(),
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('Process orphan fixture did not expose its direct PID.');

  // Register every observer before spawn/disconnect/exit. On Node 22.23.2 for Windows an
  // explicitly disconnected IPC child can emit exit and close both piped stdio streams while
  // omitting ChildProcess "close". This direct-child orphan oracle therefore uses exit + both
  // stdio closes + PID absence. The production adapter has a stricter ownership boundary and
  // must continue retaining its raw handle until ChildProcess "close".
  const termination = observeExternalTermination(child, OBSERVATION_TIMEOUT_MS);
  child.stdout!.resume();
  child.stderr!.resume();

  try {
    await onceSpawn(child);
    if (scenario === 'ready-then-disconnect') {
      const ready = onceMatchingMessage(child, isReadyMessage);
      await sendSettled(child, {
        version: '1',
        type: 'bootstrap',
        jobId: 'process-parent-disconnect-job',
        ownerSessionId: 'process-parent-disconnect-owner',
        executorName: 'process',
        channelId: 'process-parent-disconnect-channel',
      });
      await ready;
    } else {
      await onceMatchingMessage(
        child,
        (message) =>
          isRecord(message) &&
          message.type === 'fixture-state' &&
          message.state ===
            (scenario === 'waiting-bootstrap-disconnect' ? 'waiting-bootstrap' : 'before-serve'),
      );
    }

    const disconnected = onceDisconnect(child);
    const disconnectedAt = performance.now();
    child.disconnect();
    await disconnected;
    expect(child.connected, `${scenario}: controller IPC must be disconnected`).toBe(false);

    const observed = await termination.complete;
    expect(performance.now() - disconnectedAt, scenario).toBeLessThan(ORPHAN_BOUND_MS);
    expect(observed).toMatchObject({ exited: true, stdoutClosed: true, stderrClosed: true });
    await expectProcessGone(pid);
  } finally {
    if (child.connected) child.disconnect();
    if (isProcessAlive(pid)) child.kill('SIGKILL');
    await termination.settled.catch(() => undefined);
  }
}

function sendSettled(child: ChildProcess, message: Serializable): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

function onceSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function onceDisconnect(child: ChildProcess): Promise<void> {
  if (!child.connected) return Promise.resolve();
  return new Promise((resolve) => child.once('disconnect', resolve));
}

function onceMatchingMessage(
  child: ChildProcess,
  predicate: (message: unknown) => boolean,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('error', onError);
    };
    child.on('message', onMessage);
    child.once('error', onError);
  });
}

function isReadyMessage(message: unknown): boolean {
  return isRecord(message) && message.version === '1' && message.type === 'ready';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function observeExternalTermination(
  child: ChildProcess,
  timeoutMs: number,
): {
  readonly complete: Promise<{
    readonly exited: true;
    readonly stdoutClosed: true;
    readonly stderrClosed: true;
  }>;
  readonly settled: Promise<unknown>;
} {
  if (child.stdout === null || child.stderr === null) {
    throw new Error('Process orphan fixture must expose piped stdout and stderr.');
  }
  const exit = new Promise<true>((resolve, reject) => {
    child.once('exit', () => resolve(true));
    child.once('error', reject);
  });
  const stdoutClosed = new Promise<true>((resolve, reject) => {
    child.stdout!.once('close', () => resolve(true));
    child.stdout!.once('error', reject);
  });
  const stderrClosed = new Promise<true>((resolve, reject) => {
    child.stderr!.once('close', () => resolve(true));
    child.stderr!.once('error', reject);
  });
  const settled = Promise.all([exit, stdoutClosed, stderrClosed]).then(
    ([exited, stdoutWasClosed, stderrWasClosed]) => ({
      exited,
      stdoutClosed: stdoutWasClosed,
      stderrClosed: stderrWasClosed,
    }),
  );
  const complete = withTimeout(
    settled,
    timeoutMs,
    'Process fixture did not externally terminate in time.',
  );
  return { complete, settled };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (isProcessAlive(pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(isProcessAlive(pid)).toBe(false);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

function createRawFixtureEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '' };
  const allow =
    process.platform === 'win32'
      ? ['SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE', 'WINDIR']
      : ['HOME', 'LANG', 'TEMP', 'TMP', 'TMPDIR', 'USER'];
  for (const name of allow) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
