import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, vi } from 'vitest';

import { acceptanceIt } from '../../../testkit';
import { AtomicFileAgentRuntimeStateStore } from '../src';
import { RUN_ID, SESSION_ID, createRun } from './fixtures';

const generationRace = vi.hoisted(() => ({
  enabled: false,
  attempts: 0,
  firstBlocked: undefined as (() => void) | undefined,
  releaseFirst: Promise.resolve() as Promise<void>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const target = String(args[1]).replaceAll('\\', '/');
      if (generationRace.enabled && target.endsWith('/transaction.lock/gen-00000000000000000002')) {
        generationRace.attempts += 1;
        if (generationRace.attempts === 1) {
          generationRace.firstBlocked?.();
          await generationRace.releaseFirst;
        }
      }
      return actual.rename(...args);
    },
  };
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  generationRace.enabled = false;
  generationRace.attempts = 0;
  generationRace.firstBlocked = undefined;
  generationRace.releaseFirst = Promise.resolve();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Atomic File generation lock', () => {
  acceptanceIt('STORE-LOCAL-02.l2.lock-race', 'lock-race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manee-lock-generation-race-'));
    temporaryRoots.push(root);
    const first = new AtomicFileAgentRuntimeStateStore({
      root,
      staleLockMs: 5,
      lockTimeoutMs: 1_000,
    });
    const second = new AtomicFileAgentRuntimeStateStore({
      root,
      staleLockMs: 5,
      lockTimeoutMs: 1_000,
    });
    await Promise.all([first.init(), second.init()]);
    await first.createRun(createRun());
    const lease = await second.acquireLease(`subagent-session:${SESSION_ID}`, 30_000);

    let reportFirstBlocked!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      reportFirstBlocked = resolve;
    });
    let releaseFirst!: () => void;
    generationRace.releaseFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    generationRace.firstBlocked = reportFirstBlocked;
    generationRace.enabled = true;

    let delayedSettled = false;
    const delayed = first
      .createRun(createRun({ runId: 'local-store-run-delayed-observer' }))
      .finally(() => {
        delayedSettled = true;
      });
    await firstBlocked;

    let reportNewOwnerEntered!: () => void;
    const newOwnerEntered = new Promise<void>((resolve) => {
      reportNewOwnerEntered = resolve;
    });
    let releaseNewOwner!: () => void;
    const holdNewOwner = new Promise<void>((resolve) => {
      releaseNewOwner = resolve;
    });
    const current = second.transaction(SESSION_ID, lease, async () => {
      reportNewOwnerEntered();
      await holdNewOwner;
    });
    await newOwnerEntered;

    releaseFirst();
    await delay(30);
    expect(delayedSettled).toBe(false);
    expect(generationRace.attempts).toBeGreaterThanOrEqual(2);

    releaseNewOwner();
    await Promise.all([current, delayed]);
    await expect(first.loadRun(SESSION_ID, RUN_ID)).resolves.toBeDefined();
    await expect(
      first.loadRun(SESSION_ID, 'local-store-run-delayed-observer'),
    ).resolves.toBeDefined();
  });
});
