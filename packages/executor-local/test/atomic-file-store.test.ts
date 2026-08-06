import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { acceptanceIt } from '../../../testkit';
import { AtomicFileAgentRuntimeStateStore } from '../src';
import { RUN_ID, SESSION_ID, createRun, createTask } from './fixtures';

const temporaryRoots: string[] = [];

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `manee-${name}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('AtomicFileAgentRuntimeStateStore', () => {
  acceptanceIt('STORE-LOCAL-01.l2.atomic-recovery', 'atomic-recovery', async () => {
    const root = await temporaryRoot('atomic-restart');
    const first = new AtomicFileAgentRuntimeStateStore({ root });
    await first.init();
    await first.createRun(createRun());
    const firstLease = await first.acquireLease(`subagent-session:${SESSION_ID}`, 30_000);
    const task = createTask(firstLease);
    await first.transaction(SESSION_ID, firstLease, async (transaction) => {
      await transaction.createTask(task);
    });
    await firstLease.release();

    const sessionDirectory = join(root, 'sessions', await onlyEntry(join(root, 'sessions')));
    await writeFile(join(sessionDirectory, 'wal', 'ignored-uncommitted.wal.json.tmp'), 'partial');
    await writeFile(
      join(sessionDirectory, 'wal', '00000000000000000003-orphan.wal.json'),
      'orphan-final-wal',
    );

    const restarted = new AtomicFileAgentRuntimeStateStore({ root });
    await restarted.init();
    await expect(restarted.loadRun(SESSION_ID, RUN_ID)).resolves.toEqual(createRun());
    await expect(
      restarted.findTaskByIdempotencyKey(SESSION_ID, RUN_ID, task.requestId),
    ).resolves.toMatchObject({ taskId: task.taskId });
    await expect(
      restarted.findTaskBySubAgentSession(SESSION_ID, task.subagentSessionId),
    ).resolves.toMatchObject({ taskId: task.taskId });

    const nextLease = await restarted.acquireLease(`subagent-session:${SESSION_ID}`, 30_000);
    expect(nextLease.fencingToken).toBe('2');
  });

  it('fails closed when a committed WAL checksum no longer matches', async () => {
    const root = await temporaryRoot('atomic-checksum');
    const store = new AtomicFileAgentRuntimeStateStore({ root });
    await store.init();
    await store.createRun(createRun());

    const sessionDirectory = join(root, 'sessions', await onlyEntry(join(root, 'sessions')));
    const walDirectory = join(sessionDirectory, 'wal');
    const walName = (await readdir(walDirectory)).find((name) => name.endsWith('.wal.json'))!;
    const walPath = join(walDirectory, walName);
    await writeFile(walPath, `${await readFile(walPath, 'utf8')} `);

    const restarted = new AtomicFileAgentRuntimeStateStore({ root });
    await expect(restarted.loadRun(SESSION_ID, RUN_ID)).rejects.toThrow(/checksum mismatch/iu);
  });

  it('fences an expired owner before it can append another transaction', async () => {
    let now = 10_000;
    const root = await temporaryRoot('atomic-fencing');
    const firstStore = new AtomicFileAgentRuntimeStateStore({ root, now: () => now });
    await firstStore.init();
    await firstStore.createRun(createRun());
    const leaseKey = `subagent-session:${SESSION_ID}`;
    const first = await firstStore.acquireLease(leaseKey, 10);

    now = 10_010;
    const takeoverStore = new AtomicFileAgentRuntimeStateStore({ root, now: () => now });
    await takeoverStore.init();
    const takeover = await takeoverStore.acquireLease(leaseKey, 10);
    expect(takeover.fencingToken).toBe('2');
    await expect(firstStore.transaction(SESSION_ID, first, async () => undefined)).rejects.toThrow(
      /expired or fenced/iu,
    );
    await expect(
      takeoverStore.transaction(SESSION_ID, takeover, async () => 'current-owner'),
    ).resolves.toBe('current-owner');
  });

  it('does not let a second store steal a live lock after the stale grace period', async () => {
    const root = await temporaryRoot('atomic-concurrency');
    const options = { root, staleLockMs: 5, lockTimeoutMs: 1_000 };
    const first = new AtomicFileAgentRuntimeStateStore(options);
    const second = new AtomicFileAgentRuntimeStateStore(options);
    await Promise.all([first.init(), second.init()]);
    await first.createRun(createRun());
    const lease = await first.acquireLease(`subagent-session:${SESSION_ID}`, 30_000);

    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = first.transaction(SESSION_ID, lease, async () => {
      enter();
      await blocked;
    });
    await entered;

    let competitorSettled = false;
    const competitor = second
      .createRun(createRun({ runId: 'local-store-run-second' }))
      .finally(() => {
        competitorSettled = true;
      });
    await delay(30);
    expect(competitorSettled).toBe(false);

    release();
    await Promise.all([holding, competitor]);
    await expect(second.loadRun(SESSION_ID, RUN_ID)).resolves.toBeDefined();
    await expect(second.loadRun(SESSION_ID, 'local-store-run-second')).resolves.toBeDefined();
  });

  it('recovers a stale lock only after its recorded process has exited', async () => {
    const root = await temporaryRoot('atomic-dead-lock');
    const store = new AtomicFileAgentRuntimeStateStore({
      root,
      staleLockMs: 5,
      lockTimeoutMs: 1_000,
    });
    await store.init();
    await store.createRun(createRun());
    const sessionDirectory = join(root, 'sessions', await onlyEntry(join(root, 'sessions')));
    const lockRoot = join(sessionDirectory, 'transaction.lock');

    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const deadPid = child.pid;
    if (deadPid === undefined) throw new Error('failed to create dead lock owner fixture');
    await once(child, 'exit');
    const existingGenerations = (await readdir(lockRoot)).filter((entry) =>
      entry.startsWith('gen-'),
    );
    const deadGeneration = existingGenerations.length + 1;
    const lockPath = join(lockRoot, `gen-${deadGeneration.toString().padStart(20, '0')}`);
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({
        schema: 'maneeagent-local-lock/v1',
        generation: deadGeneration,
        token: 'dead-owner-token',
        pid: deadPid,
        createdAt: Date.now(),
      }),
    );
    await delay(10);

    await expect(
      store.createRun(createRun({ runId: 'local-store-run-after-crash' })),
    ).resolves.toBeUndefined();
    await expect(store.loadRun(SESSION_ID, 'local-store-run-after-crash')).resolves.toBeDefined();
  });

  it('fails closed on duplicate and missing WAL sequences', async () => {
    const duplicateRoot = await temporaryRoot('atomic-duplicate');
    const duplicateStore = new AtomicFileAgentRuntimeStateStore({ root: duplicateRoot });
    await duplicateStore.init();
    await duplicateStore.createRun(createRun());
    const duplicateSession = join(
      duplicateRoot,
      'sessions',
      await onlyEntry(join(duplicateRoot, 'sessions')),
    );
    const commits = join(duplicateSession, 'commits');
    const wal = join(duplicateSession, 'wal');
    const sourceCommitName = (await readdir(commits)).find((name) => name.endsWith('.commit'))!;
    const sourceBase = sourceCommitName.slice(0, -'.commit'.length);
    const duplicateBase = '00000000000000000001-00000000-0000-4000-8000-000000000000';
    const sourceMarker = JSON.parse(
      await readFile(join(commits, sourceCommitName), 'utf8'),
    ) as Record<string, unknown>;
    const markerBody = {
      schema: sourceMarker.schema,
      sequence: sourceMarker.sequence,
      base: duplicateBase,
      walChecksum: sourceMarker.walChecksum,
      previousHeadChecksum: sourceMarker.previousHeadChecksum,
    };
    await copyFile(join(wal, `${sourceBase}.wal.json`), join(wal, `${duplicateBase}.wal.json`));
    await writeFile(
      join(commits, `${duplicateBase}.commit`),
      JSON.stringify({ ...markerBody, headChecksum: sha256(JSON.stringify(markerBody)) }),
    );
    const duplicateRestart = new AtomicFileAgentRuntimeStateStore({ root: duplicateRoot });
    await expect(duplicateRestart.loadRun(SESSION_ID, RUN_ID)).rejects.toThrow(
      /duplicate or gap/iu,
    );

    const gapRoot = await temporaryRoot('atomic-gap');
    const gapStore = new AtomicFileAgentRuntimeStateStore({ root: gapRoot });
    await gapStore.init();
    await gapStore.createRun(createRun());
    await gapStore.createRun(createRun({ runId: 'local-store-run-gap' }));
    const gapSession = join(gapRoot, 'sessions', await onlyEntry(join(gapRoot, 'sessions')));
    const gapCommits = join(gapSession, 'commits');
    const firstMarker = (await readdir(gapCommits)).find((name) =>
      name.startsWith('00000000000000000001-'),
    )!;
    await unlink(join(gapCommits, firstMarker));
    const gapRestart = new AtomicFileAgentRuntimeStateStore({ root: gapRoot });
    await expect(gapRestart.loadRun(SESSION_ID, RUN_ID)).rejects.toThrow(/duplicate or gap/iu);
  });

  it('detects rollback relative to the durable head but accepts marker-before-head recovery', async () => {
    const rollbackRoot = await temporaryRoot('atomic-rollback');
    const rollbackStore = new AtomicFileAgentRuntimeStateStore({ root: rollbackRoot });
    await rollbackStore.init();
    await rollbackStore.createRun(createRun());
    await rollbackStore.createRun(createRun({ runId: 'local-store-run-rollback' }));
    const rollbackSession = join(
      rollbackRoot,
      'sessions',
      await onlyEntry(join(rollbackRoot, 'sessions')),
    );
    const secondMarker = (await readdir(join(rollbackSession, 'commits'))).find((name) =>
      name.startsWith('00000000000000000002-'),
    )!;
    await unlink(join(rollbackSession, 'commits', secondMarker));
    const rollbackRestart = new AtomicFileAgentRuntimeStateStore({ root: rollbackRoot });
    await expect(rollbackRestart.loadRun(SESSION_ID, RUN_ID)).rejects.toThrow(/rollback/iu);

    const crashRoot = await temporaryRoot('atomic-marker-head');
    const crashStore = new AtomicFileAgentRuntimeStateStore({ root: crashRoot });
    await crashStore.init();
    await crashStore.createRun(createRun());
    const crashSession = join(crashRoot, 'sessions', await onlyEntry(join(crashRoot, 'sessions')));
    await unlink(join(crashSession, 'head.json'));
    const crashRestart = new AtomicFileAgentRuntimeStateStore({ root: crashRoot });
    await expect(crashRestart.loadRun(SESSION_ID, RUN_ID)).resolves.toEqual(createRun());
  });

  it('binds transactions to the owner-session lease and revalidates expiry at commit', async () => {
    let now = 20_000;
    const root = await temporaryRoot('atomic-lease-scope');
    const store = new AtomicFileAgentRuntimeStateStore({ root, now: () => now });
    await store.init();
    await store.createRun(createRun());
    const wrongScope = await store.acquireLease('subagent-session:another-session', 30_000);
    await expect(store.transaction(SESSION_ID, wrongScope, async () => undefined)).rejects.toThrow(
      /lease scope/iu,
    );

    const lease = await store.acquireLease(`subagent-session:${SESSION_ID}`, 10);
    const task = createTask(lease);
    await expect(
      store.transaction(SESSION_ID, lease, async (transaction) => {
        await transaction.createTask(task);
        now = 20_010;
      }),
    ).rejects.toThrow(/expired or fenced/iu);
    await expect(store.loadTask(SESSION_ID, task.taskId)).resolves.toBeUndefined();
  });

  it('rejects UNC roots and symbolic-link roots', async () => {
    expect(
      () => new AtomicFileAgentRuntimeStateStore({ root: '\\\\server\\share\\runtime' }),
    ).toThrow(/UNC or network/iu);

    const target = await temporaryRoot('atomic-target');
    const parent = await temporaryRoot('atomic-link-parent');
    const link = join(parent, 'linked-root');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = new AtomicFileAgentRuntimeStateStore({ root: link });
    await expect(linked.init()).rejects.toThrow(/symbolic link/iu);
  });

  acceptanceIt('STORE-LOCAL-03.l2.filesystem-boundary', 'filesystem-boundary', async () => {
    for (const filesystemType of ['windows-drive-type-4', 'nfs4']) {
      const root = await temporaryRoot(`atomic-network-${filesystemType}`);
      const store = new AtomicFileAgentRuntimeStateStore({
        root,
        filesystemVerifier: {
          verify: vi.fn().mockResolvedValue({
            status: 'network',
            filesystemType,
            reason: 'injected network filesystem fixture',
          }),
        },
      });
      await expect(store.init()).rejects.toThrow(/network filesystem/iu);
    }

    const root = await temporaryRoot('atomic-unknown-filesystem');
    const store = new AtomicFileAgentRuntimeStateStore({
      root,
      filesystemVerifier: {
        verify: vi.fn().mockResolvedValue({
          status: 'unknown',
          reason: 'injected unknown filesystem fixture',
        }),
      },
    });
    await expect(store.init()).rejects.toThrow(/could not confirm/iu);
  });

  it('accepts an injected verifier only after it confirms the resolved root is local', async () => {
    const root = await temporaryRoot('atomic-local-verifier');
    const verify = vi.fn().mockResolvedValue({
      status: 'local' as const,
      filesystemType: 'fixture-local',
    });
    const store = new AtomicFileAgentRuntimeStateStore({
      root,
      filesystemVerifier: { verify },
    });

    await expect(store.init()).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith(await realpath(root));
  });
});

async function onlyEntry(directory: string): Promise<string> {
  const entries = await readdir(directory);
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
