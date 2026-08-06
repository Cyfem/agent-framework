import * as dns from 'node:dns';
import * as http from 'node:http';
import * as net from 'node:net';
import { describe, expect, it } from 'vitest';

import {
  AcceptanceReporter,
  Barrier,
  Deferred,
  DeterministicIdFactory,
  FaultInjector,
  InjectedFaultError,
  ManualClock,
  NetworkAccessDeniedError,
  NetworkDenyGuard,
  ScriptedOperationQueue,
  UnexpectedScriptedOperationError,
  acceptanceIt,
} from '../../../testkit';

acceptanceIt('TST-GROUND-01', 'deferred-barrier', async () => {
  const deferred = new Deferred<string>();
  expect(deferred.state).toBe('pending');
  expect(deferred.resolve('ready')).toBe(true);
  expect(deferred.reject(new Error('late'))).toBe(false);
  await expect(deferred.promise).resolves.toBe('ready');

  const barrier = new Barrier();
  const first = barrier.wait();
  const second = barrier.wait();
  expect(barrier.release()).toBe(true);
  expect(barrier.release()).toBe(false);
  await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  await expect(barrier.wait()).resolves.toBeUndefined();
});

describe('Subagent v2 testkit groundwork', () => {
  it('controls logical time and deterministic ID sequences', async () => {
    const clock = new ManualClock(1_000);
    const wait = clock.waitUntil(1_010);
    expect(clock.advanceBy(9)).toBe(1_009);
    expect(clock.pendingWaitCount).toBe(1);
    clock.advanceBy(1);
    await expect(wait).resolves.toBeUndefined();
    expect(clock.pendingWaitCount).toBe(0);
    expect(() => clock.advanceTo(999)).toThrow(/backwards/iu);

    const ids = new DeterministicIdFactory({ prefix: 'case', width: 2 });
    expect(ids.nextSessionId()).toBe('case-session-01');
    expect(ids.nextSessionId()).toBe('case-session-02');
    expect(ids.nextTaskId()).toBe('case-task-01');
    expect(ids.snapshot()).toEqual({ session: 3, task: 2 });
  });

  it('consumes one-shot faults and strict scripted operations', async () => {
    const faults = new FaultInjector();
    let callbackCount = 0;
    faults.arm('after.commit', () => {
      callbackCount += 1;
    });
    await expect(faults.hit('after.commit')).resolves.toBe(true);
    await expect(faults.hit('after.commit')).resolves.toBe(false);
    expect(callbackCount).toBe(1);

    faults.arm('before.receipt');
    await expect(faults.hit('before.receipt')).rejects.toBeInstanceOf(InjectedFaultError);

    type Operations = {
      create: { input: { readonly id: string }; output: string };
      resume: { input: number; output: number };
    };
    const queue = new ScriptedOperationQueue<Operations>();
    const gate = new Barrier();
    queue.enqueue('create', async ({ id }) => {
      await gate.wait();
      return `created:${id}`;
    });
    queue.enqueueResult('resume', 42);

    const create = queue.execute('create', { id: 'task-1' });
    expect(queue.observations[0]?.status).toBe('running');
    gate.release();
    await expect(create).resolves.toBe('created:task-1');
    await expect(queue.execute('resume', 1)).resolves.toBe(42);
    expect(queue.observations.map(({ status }) => status)).toEqual(['succeeded', 'succeeded']);
    expect(() => queue.assertDrained()).not.toThrow();
    await expect(queue.execute('resume', 2)).rejects.toBeInstanceOf(
      UnexpectedScriptedOperationError,
    );
  });

  it('records explicit case identity as one safe JSONL record', () => {
    let now = 10;
    const lines: string[] = [];
    const reporter = new AcceptanceReporter({
      clock: () => now,
      sink: (line) => lines.push(line),
    });
    const handle = reporter.startCase('STA-01.l1', 'memory');
    now = 17;
    const evidence = reporter.passCase(handle);

    expect(evidence).toMatchObject({
      caseId: 'STA-01.l1',
      variant: 'memory',
      status: 'passed',
      durationMs: 7,
    });
    expect(JSON.parse(lines[0] ?? '')).toEqual(evidence);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(Object.isFrozen(reporter.snapshot())).toBe(true);
    expect(() => reporter.startCase('STA-01.l1', 'file')).toThrow(/already registered/iu);
  });

  it('blocks and restores fetch, HTTP, DNS, and raw sockets without making requests', () => {
    const suiteGuard = Reflect.get(
      globalThis,
      Symbol.for('maneeagent.testkit.network-deny-owner.v1'),
    ) as NetworkDenyGuard | undefined;
    suiteGuard?.restore();
    try {
      const originalFetch = globalThis.fetch;
      const originalHttpGet = http.get;
      const originalLookup = dns.lookup;
      const originalConnect = net.connect;
      const guard = new NetworkDenyGuard();

      guard.install();
      try {
        expect(() => globalThis.fetch('http://example.invalid')).toThrow(NetworkAccessDeniedError);
        expect(() => http.get('http://example.invalid')).toThrow(NetworkAccessDeniedError);
        expect(() => dns.lookup('example.invalid', () => undefined)).toThrow(
          NetworkAccessDeniedError,
        );
        expect(() => net.connect(80, '127.0.0.1')).toThrow(NetworkAccessDeniedError);
      } finally {
        guard.restore();
      }

      expect(globalThis.fetch).toBe(originalFetch);
      expect(http.get).toBe(originalHttpGet);
      expect(dns.lookup).toBe(originalLookup);
      expect(net.connect).toBe(originalConnect);
      expect(guard.restore()).toBe(false);
    } finally {
      suiteGuard?.install();
    }
  });
});
