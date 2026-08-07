import { describe, expect, it, vi } from 'vitest';

import { acceptanceIt, Deferred, ManualClock } from '../../../testkit';
import {
  MemoryProviderOperationLedgerStore,
  ProviderOperationLedger,
  type ProviderOperationAdmission,
  type ProviderOperationIdentity,
  type ProviderOperationLedgerStore,
  type ProviderOperationRecordV1,
} from '../src/subagent/provider-operation-ledger';
import { setProviderOperationFailpointForTest } from '../src/subagent/provider-operation-ledger-internals';

const IDENTITY = Object.freeze({
  ownerSessionId: 'owner-1',
  taskId: 'task-1',
  providerOperationId: 'provider-1',
}) satisfies ProviderOperationIdentity;
const REQUEST = Object.freeze({ context: ['safe'], tools: [{ name: 'proof' }] });

function createFixture(now = 1_000): {
  readonly clock: ManualClock;
  readonly store: MemoryProviderOperationLedgerStore;
  readonly ledger: ProviderOperationLedger;
} {
  const clock = new ManualClock(now);
  const store = new MemoryProviderOperationLedgerStore();
  const ledger = new ProviderOperationLedger({ store, now: clock.now });
  return { clock, store, ledger };
}

async function admit(
  ledger: ProviderOperationLedger,
  identity = IDENTITY,
): Promise<Readonly<ProviderOperationAdmission>> {
  const result = await ledger.admit(identity, REQUEST);
  expect(result.status).toBe('admitted');
  if (result.status !== 'admitted') throw new Error('Expected provider operation admission.');
  return result.admission;
}

function providerCasStore(
  memory: MemoryProviderOperationLedgerStore,
  compareAndSet: ProviderOperationLedgerStore['compareAndSet'],
): ProviderOperationLedgerStore {
  return {
    load: (identity) => memory.load(identity),
    create: (record) => memory.create(record),
    compareAndSet,
    loadRequestAdmission: (identity) => memory.loadRequestAdmission(identity),
    createRequestAdmission: (record) => memory.createRequestAdmission(record),
    compareAndSetRequestAdmission: (identity, revision, next) =>
      memory.compareAndSetRequestAdmission(identity, revision, next),
  };
}

describe('ProviderOperationLedger', () => {
  it('keys by the trusted identity and reuses canonical JCS-equivalent requests', async () => {
    const { ledger, store } = createFixture();
    const first = await ledger.prepare(IDENTITY, { z: 1, a: { y: 2, x: 3 } });
    const replay = await ledger.prepare(IDENTITY, { a: { x: 3, y: 2 }, z: 1 });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.record.requestHash).toBe(first.record.requestHash);
    expect(replay.record).not.toHaveProperty('request');
    expect(Object.keys(replay.record).sort()).toEqual([
      'ownerSessionId',
      'phase',
      'preparedAt',
      'providerOperationId',
      'recordVersion',
      'requestHash',
      'revision',
      'taskId',
      'updatedAt',
    ]);

    await expect(ledger.prepare(IDENTITY, { a: { x: 4, y: 2 }, z: 1 })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });

    await ledger.prepare({ ...IDENTITY, ownerSessionId: 'owner-2' }, { z: 1 });
    await ledger.prepare({ ...IDENTITY, taskId: 'task-2' }, { z: 1 });
    await ledger.prepare({ ...IDENTITY, providerOperationId: 'provider-2' }, { z: 1 });
    expect(store.snapshot()).toHaveLength(4);
  });

  acceptanceIt('C7-GATEWAY-03.l1.provider-ledger', 'provider-ledger', async () => {
    const { clock, ledger } = createFixture();
    const prepared = await ledger.prepare(IDENTITY, REQUEST);
    expect(prepared.record).toMatchObject({ phase: 'prepared', revision: 0, preparedAt: 1_000 });

    clock.advanceBy(1);
    const admission = await admit(ledger);
    const mutableReply = { messages: [{ role: 'assistant', content: 'proof' }] };
    clock.advanceBy(1);
    const completionPromise = ledger.complete(admission, mutableReply);
    mutableReply.messages[0]!.content = 'mutated-after-call';
    const completed = await completionPromise;

    expect(completed).toMatchObject({ status: 'completed', replayed: false });
    if (completed.status !== 'completed') throw new Error('Expected completion.');
    expect(completed.reply).toEqual({ messages: [{ role: 'assistant', content: 'proof' }] });
    expect(Object.isFrozen(completed.record)).toBe(true);
    expect(Object.isFrozen(completed.reply)).toBe(true);
    expect(Object.isFrozen((completed.reply as { messages: unknown[] }).messages)).toBe(true);
    expect(completed.record).toMatchObject({
      phase: 'completed',
      revision: 2,
      preparedAt: 1_000,
      updatedAt: 1_002,
      terminalAt: 1_002,
    });

    const replay = await ledger.execute({
      identity: IDENTITY,
      request: structuredClone(REQUEST),
      invoke: async () => {
        throw new Error('must not be called');
      },
    });
    expect(replay).toMatchObject({ status: 'completed', replayed: true });
    if (replay.status === 'completed') expect(replay.reply).toEqual(completed.reply);

    const recovered = await ledger.recoverInFlight(IDENTITY);
    expect(recovered).toMatchObject({ status: 'completed', record: completed.record });
  });

  it('allows exactly one concurrent admission and never treats observation as resend authority', async () => {
    const { ledger } = createFixture();
    await ledger.prepare(IDENTITY, REQUEST);

    const results = await Promise.all([
      ledger.admit(IDENTITY, REQUEST),
      ledger.admit(IDENTITY, structuredClone(REQUEST)),
    ]);
    expect(results.filter(({ status }) => status === 'admitted')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'in_flight')).toHaveLength(1);

    const providerStarted = new Deferred<void>();
    const providerRelease = new Deferred<void>();
    const otherIdentity = { ...IDENTITY, providerOperationId: 'provider-concurrent' };
    let calls = 0;
    const first = ledger.execute({
      identity: otherIdentity,
      request: REQUEST,
      invoke: async () => {
        calls += 1;
        providerStarted.resolve(undefined);
        await providerRelease.promise;
        return { ok: true };
      },
    });
    await providerStarted.promise;
    const observer = await ledger.execute({
      identity: otherIdentity,
      request: REQUEST,
      invoke: async () => {
        calls += 1;
        return { impossible: true };
      },
    });
    expect(observer.status).toBe('in_flight');
    expect(calls).toBe(1);
    providerRelease.resolve(undefined);
    await expect(first).resolves.toMatchObject({ status: 'completed' });
    expect(calls).toBe(1);
  });

  it('durably admits one request owner before budget and rejects conflicting canonical input', async () => {
    const { store, ledger } = createFixture();
    const sibling = new ProviderOperationLedger({ store, now: () => 1_000 });

    const [left, right] = await Promise.all([
      ledger.admitRequest(IDENTITY, REQUEST),
      sibling.admitRequest(IDENTITY, structuredClone(REQUEST)),
    ]);
    const winner = left.status === 'admitted' ? left : right;
    const observer = left.status === 'observed' ? left : right;
    expect(winner.status).toBe('admitted');
    expect(observer.status).toBe('observed');
    if (winner.status !== 'admitted') throw new Error('Expected request admission winner.');

    await expect(sibling.admitRequest(IDENTITY, { context: ['different'] })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const reserved = await ledger.confirmBudgetReservation(winner.admission);
    expect(reserved).toMatchObject({
      status: 'budget_reserved',
      record: { phase: 'budget_reserved', revision: 1 },
    });
    await expect(sibling.admitRequest(IDENTITY, REQUEST)).resolves.toMatchObject({
      status: 'budget_reserved',
    });
    expect(store.requestAdmissionSnapshot()).toHaveLength(1);
    expect(store.snapshot()).toHaveLength(0);
  });

  it('requires explicit host recovery to take over a stranded request admission', async () => {
    const { store, ledger } = createFixture();
    const sibling = new ProviderOperationLedger({ store, now: () => 1_000 });
    const original = await ledger.admitRequest(IDENTITY, REQUEST);
    expect(original.status).toBe('admitted');
    if (original.status !== 'admitted') throw new Error('Expected request admission winner.');

    await expect(sibling.admitRequest(IDENTITY, structuredClone(REQUEST))).resolves.toMatchObject({
      status: 'observed',
      record: { revision: 0 },
    });
    expect(store.requestAdmissionSnapshot()[0]).toMatchObject({ phase: 'admitted', revision: 0 });

    const recovered = await sibling.recoverRequestAdmission(IDENTITY, REQUEST);
    expect(recovered).toMatchObject({
      status: 'recovered',
      record: { phase: 'admitted', revision: 1 },
      admission: { revision: 1 },
    });
    if (recovered.status !== 'recovered') throw new Error('Expected explicit recovery winner.');

    await expect(ledger.confirmBudgetReservation(original.admission)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
    await expect(sibling.confirmBudgetReservation(recovered.admission)).resolves.toMatchObject({
      status: 'budget_reserved',
      record: { revision: 2 },
    });
    await expect(ledger.recoverRequestAdmission(IDENTITY, REQUEST)).resolves.toMatchObject({
      status: 'budget_reserved',
      record: { revision: 2 },
    });
  });

  it('projects the first request-admission CAS winner under settlement/recovery contention', async () => {
    const memory = new MemoryProviderOperationLedgerStore();
    const entered = new Deferred<void>();
    const release = new Deferred<void>();
    let contenders = 0;
    const store: ProviderOperationLedgerStore = {
      load: (identity, context) => memory.load(identity, context),
      create: (record, context) => memory.create(record, context),
      compareAndSet: (identity, revision, next, context) =>
        memory.compareAndSet(identity, revision, next, context),
      loadRequestAdmission: (identity, context) => memory.loadRequestAdmission(identity, context),
      createRequestAdmission: (record, context) => memory.createRequestAdmission(record, context),
      compareAndSetRequestAdmission: async (identity, revision, next, context) => {
        if (revision === 0) {
          contenders += 1;
          if (contenders === 2) entered.resolve(undefined);
          await release.promise;
        }
        return memory.compareAndSetRequestAdmission(identity, revision, next, context);
      },
    };
    const creator = new ProviderOperationLedger({ store, now: () => 1_000 });
    const recoveryHost = new ProviderOperationLedger({ store, now: () => 1_000 });
    const original = await creator.admitRequest(IDENTITY, REQUEST);
    if (original.status !== 'admitted') throw new Error('Expected request admission winner.');

    const settlement = creator
      .confirmBudgetReservation(original.admission)
      .catch((error: unknown) => error);
    const recovery = recoveryHost.recoverRequestAdmission(IDENTITY, REQUEST);
    await entered.promise;
    release.resolve(undefined);
    const [settlementResult, recoveryResult] = await Promise.all([settlement, recovery]);

    if (recoveryResult.status === 'recovered') {
      expect(settlementResult).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      await expect(
        recoveryHost.confirmBudgetReservation(recoveryResult.admission),
      ).resolves.toMatchObject({ status: 'budget_reserved', record: { revision: 2 } });
    } else {
      expect(recoveryResult).toMatchObject({
        status: 'budget_reserved',
        record: { revision: 1 },
      });
      expect(settlementResult).toMatchObject({ status: 'budget_reserved' });
    }
    expect(memory.requestAdmissionSnapshot()).toHaveLength(1);
    expect(memory.requestAdmissionSnapshot()[0]?.phase).toBe('budget_reserved');
  });

  it('bounds every hanging Store I/O by caller abort or deadline and propagates its context', async () => {
    const contexts: unknown[] = [];
    const never = new Promise<never>(() => undefined);
    const hanging: ProviderOperationLedgerStore = {
      load: (_identity, context) => {
        contexts.push(context);
        return never;
      },
      create: () => never,
      compareAndSet: () => never,
      loadRequestAdmission: () => never,
      createRequestAdmission: () => never,
      compareAndSetRequestAdmission: () => never,
    };
    const ledger = new ProviderOperationLedger({ store: hanging });
    const controller = new AbortController();
    const aborted = ledger.load(IDENTITY, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect((contexts[0] as { signal: AbortSignal }).signal.aborted).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const deadlineAt = Date.now() + 50;
      const timedOut = ledger.load(IDENTITY, { deadlineAt });
      const timedOutAssertion = expect(timedOut).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(50);
      await timedOutAssertion;
      expect(contexts[1]).toMatchObject({ deadlineAt, signal: expect.any(AbortSignal) });
      expect((contexts[1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists a sanitized budget rejection and projects the durable winner', async () => {
    const { store, ledger } = createFixture();
    const admitted = await ledger.admitRequest(IDENTITY, REQUEST);
    expect(admitted.status).toBe('admitted');
    if (admitted.status !== 'admitted') throw new Error('Expected request admission winner.');

    const failure = {
      code: 'BUDGET_EXCEEDED',
      message: 'The provider budget is exhausted.',
      retryable: false,
    };
    const rejected = await ledger.rejectBudgetReservation(admitted.admission, failure);
    expect(rejected).toMatchObject({ status: 'budget_rejected', failure });
    expect(await ledger.confirmBudgetReservation(admitted.admission)).toMatchObject({
      status: 'budget_rejected',
      failure,
    });
    expect(store.snapshot()).toHaveLength(0);
  });

  it('turns restored in-flight work into an irreversible unknown outcome', async () => {
    const { clock, ledger } = createFixture();
    const admission = await admit(ledger);
    clock.advanceBy(10);
    const unknown = await ledger.recoverInFlight(IDENTITY);
    expect(unknown).toMatchObject({
      status: 'outcome_unknown',
      record: {
        phase: 'outcome_unknown',
        revision: 2,
        updatedAt: 1_010,
        terminalAt: 1_010,
      },
    });

    const lateCompletion = await ledger.complete(admission, { tooLate: true });
    expect(lateCompletion.status).toBe('outcome_unknown');
    let calls = 0;
    const retry = await ledger.execute({
      identity: IDENTITY,
      request: REQUEST,
      invoke: async () => {
        calls += 1;
        return { impossible: true };
      },
    });
    expect(retry.status).toBe('outcome_unknown');
    expect(calls).toBe(0);
    expect((await ledger.recoverInFlight(IDENTITY)).record.revision).toBe(2);
  });

  it('keeps prepared work retryable when a crash happens before the in-flight CAS', async () => {
    const { ledger } = createFixture();
    let calls = 0;
    setProviderOperationFailpointForTest(ledger, (phase) => {
      if (phase === 'after_prepare_before_in_flight') throw new Error('crash-before-cas');
    });
    await expect(
      ledger.execute({
        identity: IDENTITY,
        request: REQUEST,
        invoke: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    ).rejects.toThrow('crash-before-cas');
    expect((await ledger.load(IDENTITY))?.phase).toBe('prepared');
    expect((await ledger.recoverInFlight(IDENTITY)).status).toBe('prepared');
    expect(calls).toBe(0);
    setProviderOperationFailpointForTest(ledger, undefined);

    await expect(
      ledger.execute({
        identity: IDENTITY,
        request: REQUEST,
        invoke: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(calls).toBe(1);
  });

  it('uses the in-flight CAS as the conservative boundary before the SDK call', async () => {
    const { ledger } = createFixture();
    let calls = 0;
    setProviderOperationFailpointForTest(ledger, (phase) => {
      if (phase === 'after_in_flight_before_provider') throw new Error('crash-after-cas');
    });
    await expect(
      ledger.execute({
        identity: IDENTITY,
        request: REQUEST,
        invoke: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    ).rejects.toThrow('crash-after-cas');
    expect(calls).toBe(0);
    expect((await ledger.load(IDENTITY))?.phase).toBe('in_flight');
    expect((await ledger.recoverInFlight(IDENTITY)).status).toBe('outcome_unknown');
  });

  it('does not persist provider errors or response bodies when invocation rejects', async () => {
    const { ledger, store } = createFixture();
    const secret = 'ark-secret-key';
    const rawBody = '<html>raw provider failure</html>';
    const result = await ledger.execute({
      identity: IDENTITY,
      request: REQUEST,
      invoke: async () => {
        throw Object.assign(new Error('provider rejected'), {
          authorization: secret,
          response: { body: rawBody },
        });
      },
    });

    expect(result.status).toBe('outcome_unknown');
    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(rawBody);
    expect(persisted).not.toContain('provider rejected');
    expect(store.snapshot()[0]).not.toHaveProperty('reply');
  });

  it('leaves post-SDK crashes in-flight but replays a crash after the completion CAS', async () => {
    const beforeComplete = createFixture();
    let beforeCalls = 0;
    setProviderOperationFailpointForTest(beforeComplete.ledger, (phase) => {
      if (phase === 'after_provider_before_complete') throw new Error('crash-after-sdk');
    });
    await expect(
      beforeComplete.ledger.execute({
        identity: IDENTITY,
        request: REQUEST,
        invoke: async () => {
          beforeCalls += 1;
          return { proof: 'provider-ran' };
        },
      }),
    ).rejects.toThrow('crash-after-sdk');
    expect(beforeCalls).toBe(1);
    expect((await beforeComplete.ledger.load(IDENTITY))?.phase).toBe('in_flight');
    expect((await beforeComplete.ledger.recoverInFlight(IDENTITY)).status).toBe('outcome_unknown');

    const afterComplete = createFixture();
    let afterCalls = 0;
    setProviderOperationFailpointForTest(afterComplete.ledger, (phase) => {
      if (phase === 'after_complete') throw new Error('crash-after-complete');
    });
    await expect(
      afterComplete.ledger.execute({
        identity: IDENTITY,
        request: REQUEST,
        invoke: async () => {
          afterCalls += 1;
          return { proof: 'durable' };
        },
      }),
    ).rejects.toThrow('crash-after-complete');
    expect((await afterComplete.ledger.load(IDENTITY))?.phase).toBe('completed');
    setProviderOperationFailpointForTest(afterComplete.ledger, undefined);
    const replay = await afterComplete.ledger.execute({
      identity: IDENTITY,
      request: REQUEST,
      invoke: async () => {
        afterCalls += 1;
        return { impossible: true };
      },
    });
    expect(replay).toMatchObject({
      status: 'completed',
      replayed: true,
      reply: { proof: 'durable' },
    });
    expect(afterCalls).toBe(1);
  });

  it('projects a completed CAS winner when invocation failure races terminalization', async () => {
    const memory = new MemoryProviderOperationLedgerStore();
    const store = providerCasStore(memory, async (identity, revision, next) => {
      if (revision === 1 && next.phase === 'outcome_unknown') {
        const completed = {
          ...next,
          phase: 'completed' as const,
          reply: { winner: 'completion' },
        };
        expect(await memory.compareAndSet(identity, revision, completed)).toBe(true);
        return false;
      }
      return memory.compareAndSet(identity, revision, next);
    });
    const ledger = new ProviderOperationLedger({ store, now: () => 1_000 });

    const result = await ledger.execute({
      identity: IDENTITY,
      request: REQUEST,
      invoke: async () => {
        throw new Error('provider result was completed by the authoritative recovery path');
      },
    });

    expect(result).toMatchObject({
      status: 'completed',
      replayed: true,
      reply: { winner: 'completion' },
      record: { phase: 'completed' },
    });
  });

  it('projects an outcome-unknown CAS winner when completion loses recovery', async () => {
    const memory = new MemoryProviderOperationLedgerStore();
    const store = providerCasStore(memory, async (identity, revision, next) => {
      if (revision === 1 && next.phase === 'completed') {
        const unknown = {
          recordVersion: next.recordVersion,
          ownerSessionId: next.ownerSessionId,
          taskId: next.taskId,
          providerOperationId: next.providerOperationId,
          requestHash: next.requestHash,
          phase: 'outcome_unknown' as const,
          revision: next.revision,
          preparedAt: next.preparedAt,
          updatedAt: next.updatedAt,
          terminalAt: next.terminalAt as number,
        };
        expect(await memory.compareAndSet(identity, revision, unknown)).toBe(true);
        return false;
      }
      return memory.compareAndSet(identity, revision, next);
    });
    const ledger = new ProviderOperationLedger({ store, now: () => 1_000 });
    const admission = await admit(ledger);

    const completion = await ledger.complete(admission, { loser: 'completion' });

    expect(completion).toMatchObject({
      status: 'outcome_unknown',
      record: { phase: 'outcome_unknown' },
    });
  });

  acceptanceIt(
    'C7-GATEWAY-13.l1.explicit-inflight-recovery',
    'explicit-inflight-recovery',
    async () => {
      const memory = new MemoryProviderOperationLedgerStore();
      const entered = new Deferred<void>();
      const release = new Deferred<void>();
      let terminalCasWaiters = 0;
      const gated: ProviderOperationLedgerStore = {
        load: (identity) => memory.load(identity),
        create: (record) => memory.create(record),
        compareAndSet: async (identity, revision, next) => {
          if (revision === 1) {
            terminalCasWaiters += 1;
            if (terminalCasWaiters === 2) entered.resolve(undefined);
            await release.promise;
          }
          return memory.compareAndSet(identity, revision, next);
        },
        loadRequestAdmission: (identity) => memory.loadRequestAdmission(identity),
        createRequestAdmission: (record) => memory.createRequestAdmission(record),
        compareAndSetRequestAdmission: (identity, revision, next) =>
          memory.compareAndSetRequestAdmission(identity, revision, next),
      };
      const ledger = new ProviderOperationLedger({ store: gated, now: () => 1_000 });
      const admission = await admit(ledger);
      const completion = ledger.complete(admission, { winner: 'completion' });
      const recovery = ledger.recoverInFlight(IDENTITY);
      await entered.promise;
      release.resolve(undefined);
      await Promise.all([completion, recovery]);

      const terminal = await ledger.load(IDENTITY);
      expect(['completed', 'outcome_unknown']).toContain(terminal?.phase);
      expect(terminal?.revision).toBe(2);
      expect((await ledger.recoverInFlight(IDENTITY)).record.phase).toBe(terminal?.phase);
      expect((await ledger.complete(admission, { loser: true })).record.phase).toBe(
        terminal?.phase,
      );
    },
  );

  it('bounds Memory terminal histories and exposes frozen capacity diagnostics', async () => {
    const store = new MemoryProviderOperationLedgerStore({
      operationCapacity: 1,
      requestAdmissionCapacity: 1,
    });
    const ledger = new ProviderOperationLedger({ store, now: () => 1_000 });
    const requestAdmission = await ledger.admitRequest(IDENTITY, REQUEST);
    if (requestAdmission.status !== 'admitted') throw new Error('Expected request admission.');
    await ledger.confirmBudgetReservation(requestAdmission.admission);
    const providerAdmission = await admit(ledger);
    await ledger.complete(providerAdmission, { proof: 'terminal-history' });

    const diagnostics = store.diagnostics();
    expect(diagnostics).toEqual({
      operationRecords: 1,
      requestAdmissionRecords: 1,
      operationCapacity: 1,
      requestAdmissionCapacity: 1,
    });
    expect(Object.isFrozen(diagnostics)).toBe(true);

    const second = { ...IDENTITY, providerOperationId: 'provider-capacity-2' };
    await expect(ledger.admitRequest(second, REQUEST)).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      descriptor: { causeCode: 'PROVIDER_REQUEST_ADMISSION_MEMORY_CAPACITY_EXHAUSTED' },
    });
    await expect(ledger.prepare(second, REQUEST)).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      descriptor: { causeCode: 'PROVIDER_OPERATION_MEMORY_CAPACITY_EXHAUSTED' },
    });
    expect(store.diagnostics()).toEqual(diagnostics);

    await expect(ledger.admitRequest(IDENTITY, REQUEST)).resolves.toMatchObject({
      status: 'budget_reserved',
    });
    await expect(ledger.prepare(IDENTITY, REQUEST)).resolves.toMatchObject({
      created: false,
      record: { phase: 'completed' },
    });
    expect(() => new MemoryProviderOperationLedgerStore({ operationCapacity: 0 })).toThrow(
      'positive safe integer',
    );
  });

  it('rejects persistence records with undeclared raw fields', () => {
    const invalid = {
      recordVersion: '1',
      ...IDENTITY,
      requestHash: '0'.repeat(64),
      phase: 'outcome_unknown',
      revision: 2,
      preparedAt: 1,
      updatedAt: 2,
      terminalAt: 2,
      rawErrorBody: 'must-not-be-stored',
    } as unknown as ProviderOperationRecordV1;
    expect(() => new MemoryProviderOperationLedgerStore([invalid])).toThrow(
      /unsupported or missing fields/iu,
    );
  });
});
