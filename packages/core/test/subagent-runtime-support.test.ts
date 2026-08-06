import { setImmediate as waitImmediate } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { Deferred } from '../../../testkit';
import type { AgentRuntimeStateStore, StateLease } from '../src';
import {
  acquireRuntimeLease,
  acquireRenewingRuntimeLease,
  assertExecutionLeaseOwnership,
  type RuntimeLeaseScheduler,
} from '../src/subagent/runtime-support';

describe('subagent execution lease support', () => {
  it('uses a host-monotonic proof boundary instead of the StateStore clock domain', async () => {
    const scheduler = new ManualLeaseScheduler(100);
    const signal = new AbortController().signal;
    const stateLease: StateLease = {
      key: 'subagent-task:session-1:task-expired',
      fencingToken: '42',
      expiresAt: 11_000,
      renew: async () => stateLease,
      release: async () => undefined,
    };
    const store = {
      acquireLease: async () => stateLease,
    } as unknown as AgentRuntimeStateStore;
    const lease = await acquireRenewingRuntimeLease(
      store,
      stateLease.key,
      signal,
      Date.now() + 1_000,
      30,
      scheduler,
      scheduler.now,
    );

    expect(lease.confirmedUntil).toBe(130);
    expect(() =>
      assertExecutionLeaseOwnership(lease, signal, Date.now() + 1_000, () => 129),
    ).not.toThrow();
    expect(() =>
      assertExecutionLeaseOwnership(lease, signal, Date.now() + 1_000, () => 130),
    ).toThrowError(
      expect.objectContaining({
        code: 'RECOVERY_TARGET_LOST',
        descriptor: expect.objectContaining({ causeCode: 'EXECUTION_LEASE_LOST' }),
      }),
    );
    await lease.stop();
  });

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
    const scheduler = new ManualLeaseScheduler(100);

    const lease = await acquireRenewingRuntimeLease(
      store,
      stateLease.key,
      new AbortController().signal,
      Date.now() + 1_000,
      30,
      scheduler,
      scheduler.now,
    );

    expect(lease.lease.fencingToken).toBe('41');
    expect(lease.signal.aborted).toBe(false);
    scheduler.advanceTo(110);
    await waitImmediate();
    expect(renewalAttempts).toBe(1);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({
      code: 'RECOVERY_TARGET_LOST',
      descriptor: { causeCode: 'EXECUTION_LEASE_LOST' },
    });

    await lease.stop();
    expect(releases).toBe(1);
  });

  it('aborts at the exact local proof boundary while a renewal is still pending', async () => {
    const scheduler = new ManualLeaseScheduler(1_000);
    let resolveRenewal!: (lease: StateLease) => void;
    const renewal = new Promise<StateLease>((resolve) => {
      resolveRenewal = resolve;
    });
    const stateLease: StateLease = {
      key: 'subagent-task:session-1:task-pending-renewal',
      fencingToken: '43',
      expiresAt: 12_000,
      renew: async () => renewal,
      release: async () => undefined,
    };
    const store = {
      acquireLease: async () => stateLease,
    } as unknown as AgentRuntimeStateStore;
    const lease = await acquireRenewingRuntimeLease(
      store,
      stateLease.key,
      new AbortController().signal,
      Date.now() + 1_000,
      30,
      scheduler,
      scheduler.now,
    );

    scheduler.advanceTo(1_010);
    expect(lease.signal.aborted).toBe(false);
    scheduler.advanceTo(1_029);
    expect(lease.signal.aborted).toBe(false);
    scheduler.advanceTo(1_030);
    expect(lease.signal.reason).toMatchObject({
      code: 'RECOVERY_TARGET_LOST',
      descriptor: { causeCode: 'EXECUTION_LEASE_LOST' },
    });

    resolveRenewal(stateLease);
    await waitImmediate();
    await lease.stop();
  });

  it('rejects a renewal first confirmed at the old proof boundary before its timer runs', async () => {
    const scheduler = new ManualLeaseScheduler(2_000);
    let resolveRenewal!: (lease: StateLease) => void;
    const renewal = new Promise<StateLease>((resolve) => {
      resolveRenewal = resolve;
    });
    const stateLease: StateLease = {
      key: 'subagent-task:session-1:task-boundary-renewal',
      fencingToken: '44',
      expiresAt: 13_000,
      renew: async () => renewal,
      release: async () => undefined,
    };
    const store = {
      acquireLease: async () => stateLease,
    } as unknown as AgentRuntimeStateStore;
    const lease = await acquireRenewingRuntimeLease(
      store,
      stateLease.key,
      new AbortController().signal,
      Date.now() + 1_000,
      30,
      scheduler,
      scheduler.now,
    );

    scheduler.advanceTo(2_010);
    scheduler.moveClockTo(2_030);
    resolveRenewal(stateLease);
    await waitImmediate();
    expect(lease.signal.reason).toMatchObject({
      code: 'RECOVERY_TARGET_LOST',
      descriptor: { causeCode: 'EXECUTION_LEASE_LOST' },
    });
    await lease.stop();
  });

  it('aborts a hung lease acquire and releases a lease granted after cancellation', async () => {
    const entered = new Deferred<void>();
    const acquisition = new Deferred<StateLease>();
    const controller = new AbortController();
    let releases = 0;
    const stateLease: StateLease = {
      key: 'subagent-task:session-1:task-late-acquire',
      fencingToken: '45',
      expiresAt: 14_000,
      renew: async () => stateLease,
      release: async () => {
        releases += 1;
      },
    };
    const store = {
      acquireLease: async () => {
        entered.resolve(undefined);
        return acquisition.promise;
      },
    } as unknown as AgentRuntimeStateStore;
    const pending = acquireRenewingRuntimeLease(
      store,
      stateLease.key,
      controller.signal,
      Date.now() + 1_000,
      30,
    );

    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });

    acquisition.resolve(stateLease);
    await waitImmediate();
    expect(releases).toBe(1);
  });

  it('times out a hung session lease acquire and releases a late success', async () => {
    const entered = new Deferred<void>();
    const acquisition = new Deferred<StateLease>();
    let releases = 0;
    const stateLease: StateLease = {
      key: 'subagent-session:session-1',
      fencingToken: '46',
      expiresAt: 15_000,
      renew: async () => stateLease,
      release: async () => {
        releases += 1;
      },
    };
    const store = {
      acquireLease: async () => {
        entered.resolve(undefined);
        return acquisition.promise;
      },
    } as unknown as AgentRuntimeStateStore;
    const pending = acquireRuntimeLease(
      store,
      stateLease.key,
      new AbortController().signal,
      Date.now() + 20,
      30,
    );

    await entered.promise;
    await expect(pending).rejects.toMatchObject({ code: 'TIMED_OUT' });

    acquisition.resolve(stateLease);
    await waitImmediate();
    expect(releases).toBe(1);
  });

  it('rejects a renewal that changes the lease key', async () => {
    const scheduler = new ManualLeaseScheduler(3_000);
    let invalidRenewalReleases = 0;
    const original: StateLease = {
      key: 'subagent-task:session-1:task-key-change',
      fencingToken: '47',
      expiresAt: 16_000,
      renew: async () => changed,
      release: async () => undefined,
    };
    const changed: StateLease = {
      ...original,
      key: 'subagent-task:session-1:different-task',
      release: async () => {
        invalidRenewalReleases += 1;
      },
    };
    const store = {
      acquireLease: async () => original,
    } as unknown as AgentRuntimeStateStore;
    const lease = await acquireRenewingRuntimeLease(
      store,
      original.key,
      new AbortController().signal,
      Date.now() + 1_000,
      30,
      scheduler,
      scheduler.now,
    );

    scheduler.advanceTo(3_010);
    await waitImmediate();
    expect(lease.signal.reason).toMatchObject({
      code: 'RECOVERY_TARGET_LOST',
      descriptor: { causeCode: 'EXECUTION_LEASE_LOST' },
    });
    expect(invalidRenewalReleases).toBe(1);
    await lease.stop();
  });
});

class ManualLeaseScheduler implements RuntimeLeaseScheduler {
  readonly #scheduled = new Map<
    ReturnType<typeof setTimeout>,
    { readonly at: number; readonly callback: () => void }
  >();
  #nextId = 0;
  #now: number;

  constructor(now: number) {
    this.#now = now;
  }

  readonly now = (): number => this.#now;

  set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const timer = { id: ++this.#nextId } as unknown as ReturnType<typeof setTimeout>;
    this.#scheduled.set(timer, { at: this.#now + delayMs, callback });
    return timer;
  }

  clear(timer: ReturnType<typeof setTimeout>): void {
    this.#scheduled.delete(timer);
  }

  moveClockTo(now: number): void {
    if (now < this.#now) throw new RangeError('Manual lease scheduler cannot move backwards.');
    this.#now = now;
  }

  advanceTo(now: number): void {
    this.moveClockTo(now);
    for (;;) {
      const due = [...this.#scheduled.entries()]
        .filter(([, scheduled]) => scheduled.at <= now)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) return;
      this.#scheduled.delete(due[0]);
      due[1].callback();
    }
  }
}
