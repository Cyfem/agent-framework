import { setImmediate as waitImmediate } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import type { AgentRuntimeStateStore, StateLease } from '../src';
import {
  acquireRenewingRuntimeLease,
  type RuntimeLeaseScheduler,
} from '../src/subagent/runtime-support';

describe('subagent execution lease support', () => {
  it('keeps one fencing token and aborts immediately when renewal is lost', async () => {
    let renewalAttempts = 0;
    let releases = 0;
    const stateLease: StateLease = {
      key: 'subagent-task:session-1:task-1',
      fencingToken: '41',
      expiresAt: Date.now() + 30,
      renew: async () => {
        renewalAttempts += 1;
        throw new Error('simulated lease loss');
      },
      release: async () => {
        releases += 1;
      },
    };
    const store = {
      acquireLease: async () => stateLease,
    } as unknown as AgentRuntimeStateStore;
    let renewalTick: (() => void) | undefined;
    let cleared = false;
    const fakeTimer = {} as ReturnType<typeof setTimeout>;
    const scheduler: RuntimeLeaseScheduler = {
      set: (callback, delayMs) => {
        expect(delayMs).toBe(10);
        renewalTick = callback;
        return fakeTimer;
      },
      clear: (timer) => {
        expect(timer).toBe(fakeTimer);
        cleared = true;
      },
    };

    const lease = await acquireRenewingRuntimeLease(
      store,
      stateLease.key,
      new AbortController().signal,
      Date.now() + 1_000,
      30,
      scheduler,
    );

    expect(lease.lease.fencingToken).toBe('41');
    expect(lease.signal.aborted).toBe(false);
    expect(renewalTick).toBeTypeOf('function');
    renewalTick!();
    await waitImmediate();
    expect(renewalAttempts).toBe(1);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({
      code: 'RECOVERY_TARGET_LOST',
      descriptor: { causeCode: 'EXECUTION_LEASE_LOST' },
    });

    await lease.stop();
    expect(cleared).toBe(true);
    expect(releases).toBe(1);
  });
});
