import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AtomicFileAgentRuntimeStateStore } from '../src';
import { RUN_ID, SESSION_ID, createRun } from './fixtures';

const directorySyncFault = vi.hoisted(() => ({ enabled: false, injected: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (
      path: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2],
    ) => {
      const handle = await actual.open(path, flags, mode);
      if (directorySyncFault.enabled && /[\\/]commits$/u.test(String(path))) {
        const sync = handle.sync.bind(handle);
        Object.defineProperty(handle, 'sync', {
          configurable: true,
          value: async () => {
            if (!directorySyncFault.injected) {
              directorySyncFault.injected = true;
              throw new Error('injected commit-directory fsync failure');
            }
            await sync();
          },
        });
      }
      return handle;
    },
  };
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  directorySyncFault.enabled = false;
  directorySyncFault.injected = false;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Atomic File marker publication', () => {
  it('confirms a published marker by read-back when its directory fsync reports failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manee-marker-publish-'));
    temporaryRoots.push(root);
    const store = new AtomicFileAgentRuntimeStateStore({ root });
    await store.init();

    directorySyncFault.enabled = true;
    await expect(store.createRun(createRun())).resolves.toBeUndefined();
    expect(directorySyncFault.injected).toBe(true);

    const restarted = new AtomicFileAgentRuntimeStateStore({ root });
    await expect(restarted.loadRun(SESSION_ID, RUN_ID)).resolves.toEqual(createRun());
  });
});
