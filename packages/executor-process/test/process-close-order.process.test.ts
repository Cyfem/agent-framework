import { fork, type ChildProcess } from 'node:child_process';

import { describe, expect } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const TARGET_ENTRY = new URL('./fixtures/process-exit-close-target.mjs', import.meta.url);

describe('Node child_process exit/stdio close ordering oracle', () => {
  acceptanceIt(
    'C7-PROCESS-15.l3.exit-before-close-stdio-drain',
    'exit-does-not-release-until-close',
    async () => {
      assertNetworkDenyGuardInstalled();
      const child = fork(TARGET_ENTRY, [], {
        execPath: process.execPath,
        execArgv: [],
        serialization: 'advanced',
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: createRawFixtureEnvironment(),
      });
      const events: string[] = [];
      let bytes = 0;
      let stdoutEnded = false;
      let closeObservedAtExit = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
      });
      child.stdout?.once('end', () => {
        stdoutEnded = true;
      });
      child.stderr?.resume();
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => {
          closeObservedAtExit = events.includes('close');
          events.push('exit');
          resolve();
        });
      });
      const closed = onceClose(child, 5_000, events);
      try {
        await exited;
        await closed;
        expect(closeObservedAtExit).toBe(false);
        expect(events).toEqual(['exit', 'close']);
        expect(stdoutEnded).toBe(true);
        expect(bytes).toBe(64 * 1024);
        expect(child.exitCode).toBe(81);
      } finally {
        if (child.connected) child.disconnect();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed.catch(() => undefined);
      }
    },
  );
});

function onceClose(child: ChildProcess, timeoutMs: number, events: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Process exit/close fixture did not close.')),
      timeoutMs,
    );
    timer.unref();
    child.once('close', () => {
      clearTimeout(timer);
      events.push('close');
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
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
