import { describe, expect } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import {
  DEFAULT_SUBAGENT_LIMITS,
  canonicalizeJson,
  createSubAgentExecutionRequestWire,
  createSubAgentTransportRpcEnvelope,
  encodeSubAgentTransportRpcFrame,
  type SubAgentExecutionRequest,
  type SubAgentTransportArtifactSidecar,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

import {
  HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
  HTTP_SUBAGENT_JOB_RECORD_VERSION,
  MemoryHttpSubAgentJobStore,
  createHttpSubAgentJobCreateIdentity,
  decodeHttpSubAgentMultipartPacket,
  encodeHttpSubAgentMultipartPacket,
  normalizeHttpSubAgentJobRecord,
  parseHttpSubAgentRoute,
  type HttpSubAgentJobCreateInput,
  type HttpSubAgentJobCreateResult,
  type HttpSubAgentJobScope,
  type HttpSubAgentJobStoreErrorCategory,
} from '../src/index';
import { bytes, createSidecar } from './http-security-fixture';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const PRINCIPAL_ID = 'http-principal-1';
const OWNER_SESSION_ID = 'http-owner-session-1';
const RUN_ID = 'http-run-1';
const TASK_ID = 'http-task-1';
const PARENT_TASK_ID = 'http-parent-task-1';
const OPERATION_ID = 'http-operation-1';
const IDEMPOTENCY_KEY = 'http-idempotency-1';
const JOB_ID = 'http-job-1';
const NOW = 1_800_000_000_000;
const DEFAULT_REMAINING_MS = 120_000;
const CREATE_ROUTE = parseHttpSubAgentRoute('POST', '/v1/jobs/create');
const TEXT_ENCODER = new TextEncoder();
const FIXTURE_LIMITS = Object.freeze({
  ...DEFAULT_SUBAGENT_LIMITS,
  timeoutMs: 180_000,
});

interface CreateFixtureOptions {
  readonly principalId?: string;
  readonly ownerSessionId?: string;
  readonly declaredOwnerSessionId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly operationId?: string;
  readonly idempotencyKey?: string;
  readonly declaredIdempotencyKey?: string;
  readonly jobId?: string;
  readonly mode?: 'execute' | 'spawn';
  readonly remainingMs?: number;
  readonly channelId?: string;
  readonly sequence?: number;
  readonly messageId?: string;
  readonly query?: string;
  readonly sidecars?: readonly SubAgentTransportArtifactSidecar[];
}

function createJobInput(options: CreateFixtureOptions = {}): HttpSubAgentJobCreateInput {
  const ownerSessionId = options.ownerSessionId ?? OWNER_SESSION_ID;
  const taskId = options.taskId ?? TASK_ID;
  const operationId = options.operationId ?? OPERATION_ID;
  const idempotencyKey = options.idempotencyKey ?? IDEMPOTENCY_KEY;
  const remainingMs = options.remainingMs ?? DEFAULT_REMAINING_MS;
  const operation = Object.freeze({
    type: 'create' as const,
    operationId,
    idempotencyKey,
  });
  const request = Object.freeze({
    operation,
    ownerSessionId,
    runId: options.runId ?? RUN_ID,
    taskId,
    parentTaskId: PARENT_TASK_ID,
    subagentSessionId: `http-subagent-session:${taskId}`,
    path: Object.freeze([PARENT_TASK_ID, taskId]),
    attempt: 1,
    executionEpoch: 'http-execution-epoch-1',
    executionFencingToken: '1',
    definition: Object.freeze({ name: 'researcher', version: '2' }),
    input: Object.freeze({ query: options.query ?? 'verify the durable HTTP job contract' }),
    projectedContext: Object.freeze([
      Object.freeze({ kind: 'text' as const, name: 'brief', text: 'Use verified evidence.' }),
    ]),
    delegation: Object.freeze({
      version: '1' as const,
      ownerSessionId,
      runId: options.runId ?? RUN_ID,
      parentTaskId: taskId,
      path: Object.freeze([PARENT_TASK_ID, taskId]),
      depth: 2,
      catalogRevision: 1,
      definitions: Object.freeze([
        Object.freeze({ name: 'researcher', version: '2', executors: Object.freeze(['http']) }),
      ]),
    }),
    limits: FIXTURE_LIMITS,
    signal: new AbortController().signal,
    deadlineAt: NOW + remainingMs,
  }) satisfies SubAgentExecutionRequest;
  const wire = createSubAgentExecutionRequestWire(request, { now: () => NOW });
  const packet = Object.freeze({
    frame: encodeSubAgentTransportRpcFrame(
      createSubAgentTransportRpcEnvelope({
        channelId: options.channelId ?? 'http-peer-channel-1',
        sequence: options.sequence ?? 1,
        messageId: options.messageId ?? 'http-create-message-1',
        taskId,
        operationId,
        kind: 'executor.request',
        payload: Object.freeze({ mode: options.mode ?? 'execute', request: wire }),
      }),
    ),
    sidecars: Object.freeze([...(options.sidecars ?? [])]),
  }) satisfies SubAgentTransportPeerPacket;

  return Object.freeze({
    principalId: options.principalId ?? PRINCIPAL_ID,
    ownerSessionId: options.declaredOwnerSessionId ?? ownerSessionId,
    idempotencyKey: options.declaredIdempotencyKey ?? idempotencyKey,
    jobId: options.jobId ?? JOB_ID,
    route: CREATE_ROUTE,
    packet,
  }) satisfies HttpSubAgentJobCreateInput;
}

function scopeFor(input: HttpSubAgentJobCreateInput): HttpSubAgentJobScope {
  return Object.freeze({
    principalId: input.principalId,
    ownerSessionId: input.ownerSessionId,
    jobId: input.jobId,
  });
}

function packetRetainedBytes(packet: SubAgentTransportPeerPacket): number {
  let total =
    typeof packet.frame === 'string'
      ? TEXT_ENCODER.encode(packet.frame).byteLength
      : packet.frame.byteLength;
  for (const sidecar of packet.sidecars) {
    const descriptor = Reflect.apply(canonicalizeJson, undefined, [sidecar.descriptor]);
    if (typeof descriptor !== 'string') {
      throw new TypeError('Canonical sidecar descriptor must be a string.');
    }
    total += TEXT_ENCODER.encode(descriptor).byteLength + sidecar.data.byteLength;
  }
  return total;
}

async function expectStoreError(
  promise: Promise<unknown>,
  category: HttpSubAgentJobStoreErrorCategory,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'HttpSubAgentJobStoreError',
    code: 'HTTP_SUBAGENT_JOB_STORE_ERROR',
    category,
  });
}

function dataCloneWithAccessor(value: object, field: string, onRead: () => void): object {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  descriptors[field] = {
    configurable: true,
    enumerable: true,
    get() {
      onRead();
      return Reflect.get(value, field);
    },
  };
  return Object.defineProperties({}, descriptors);
}

function fulfilledResults<T>(results: readonly PromiseSettledResult<T>[]): readonly T[] {
  const values: T[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') values.push(result.value);
  }
  return values;
}

describe('HTTP durable job Store foundation', () => {
  acceptanceIt(
    'C7C-HTTP-STORE01.l1.atomic-create-replay',
    'first-write-deadline-ceiling-conflict',
    async () => {
      assertNetworkDenyGuardInstalled();
      const store = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 8,
        maxRetainedBytes: 4 * 1024 * 1024,
        now: () => NOW,
      });
      const initial = createJobInput();
      const created = await store.createOrReplay(initial);
      expect(created.status).toBe('created');
      expect(created.record).toMatchObject({
        recordVersion: HTTP_SUBAGENT_JOB_RECORD_VERSION,
        state: 'created',
        principalId: PRINCIPAL_ID,
        ownerSessionId: OWNER_SESSION_ID,
        runId: RUN_ID,
        taskId: TASK_ID,
        jobId: JOB_ID,
        operationId: OPERATION_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        revision: '0',
        channelGeneration: HTTP_SUBAGENT_INITIAL_CHANNEL_GENERATION,
        remainingMsCeiling: DEFAULT_REMAINING_MS,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const agedReplay = createJobInput({
        jobId: 'ignored-replay-candidate',
        remainingMs: DEFAULT_REMAINING_MS - 1,
        channelId: 'http-peer-channel-retry',
        sequence: 91,
        messageId: 'http-create-message-retry',
      });
      const replayed = await store.createOrReplay(agedReplay);
      expect(replayed.status).toBe('replayed');
      expect(replayed.record.jobId).toBe(JOB_ID);
      expect(replayed.record.remainingMsCeiling).toBe(DEFAULT_REMAINING_MS);
      expect(replayed.record.createPacket.frame).toBe(created.record.createPacket.frame);
      expect(replayed.record.createPacket.frame).not.toBe(agedReplay.packet.frame);
      expect(await store.load(scopeFor(agedReplay))).toBeUndefined();

      await expectStoreError(
        store.createOrReplay(
          createJobInput({ remainingMs: DEFAULT_REMAINING_MS + 1, jobId: 'expanded-deadline' }),
        ),
        'idempotency_conflict',
      );
      await expectStoreError(
        store.createOrReplay(createJobInput({ query: 'changed business input' })),
        'idempotency_conflict',
      );
      await expectStoreError(
        store.createOrReplay(createJobInput({ operationId: 'changed-operation-same-create-key' })),
        'idempotency_conflict',
      );
      await expectStoreError(
        store.createOrReplay(
          createJobInput({
            sidecars: [createSidecar('changed-create-sidecar', bytes('changed-sidecar-bytes'))],
          }),
        ),
        'idempotency_conflict',
      );
      await expectStoreError(
        store.createOrReplay(
          createJobInput({
            taskId: TASK_ID,
            operationId: 'http-operation-second',
            idempotencyKey: 'http-idempotency-second',
            jobId: 'http-job-second',
          }),
        ),
        'idempotency_conflict',
      );
      await expect(
        store.createOrReplay(
          createJobInput({ declaredIdempotencyKey: 'scope-does-not-match-packet' }),
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        store.createOrReplay(createJobInput({ declaredOwnerSessionId: 'wrong-owner-session' })),
      ).rejects.toThrow(TypeError);
      expect(store.diagnostics.retainedJobs).toBe(1);
      expect(await store.load(scopeFor(initial))).toEqual(created.record);
      await store.dispose();
    },
  );

  acceptanceIt(
    'C7C-HTTP-STORE02.l2.concurrent-create-linearization',
    'hundred-way-single-winner',
    async () => {
      assertNetworkDenyGuardInstalled();
      const replayStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 128,
        maxRetainedBytes: 16 * 1024 * 1024,
        now: () => NOW,
      });
      const replayInputs = Array.from({ length: 100 }, (_value, index) =>
        createJobInput({
          jobId: `http-replay-candidate-${index}`,
          remainingMs: DEFAULT_REMAINING_MS - index,
          channelId: `http-replay-channel-${index}`,
          sequence: index + 1,
          messageId: `http-replay-message-${index}`,
        }),
      );
      const replayResults = await Promise.all(
        replayInputs.map((input) => replayStore.createOrReplay(input)),
      );
      expect(replayResults.filter((result) => result.status === 'created')).toHaveLength(1);
      expect(replayResults.filter((result) => result.status === 'replayed')).toHaveLength(99);
      expect(new Set(replayResults.map((result) => result.record.jobId))).toEqual(
        new Set(['http-replay-candidate-0']),
      );
      expect(replayStore.diagnostics.retainedJobs).toBe(1);

      const taskFenceStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 128,
        maxRetainedBytes: 16 * 1024 * 1024,
        now: () => NOW,
      });
      const taskFenceInputs = Array.from({ length: 100 }, (_value, index) =>
        createJobInput({
          operationId: `http-task-fence-operation-${index}`,
          idempotencyKey: `http-task-fence-key-${index}`,
          jobId: `http-task-fence-job-${index}`,
          channelId: `http-task-fence-channel-${index}`,
          sequence: index + 1,
          messageId: `http-task-fence-message-${index}`,
        }),
      );
      const taskFenceResults = await Promise.allSettled(
        taskFenceInputs.map((input) => taskFenceStore.createOrReplay(input)),
      );
      const winners = fulfilledResults(taskFenceResults);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.status).toBe('created');
      for (const result of taskFenceResults) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({
            code: 'HTTP_SUBAGENT_JOB_STORE_ERROR',
            category: 'idempotency_conflict',
          });
        }
      }
      expect(taskFenceStore.diagnostics.retainedJobs).toBe(1);
      const loadedCandidates = await Promise.all(
        taskFenceInputs.map((input) => taskFenceStore.load(scopeFor(input))),
      );
      expect(loadedCandidates.filter((record) => record !== undefined)).toHaveLength(1);

      let sameKeyInner: Promise<HttpSubAgentJobCreateResult> | undefined;
      let sameKeyReentered = false;
      const sameKeyOuterInput = createJobInput({ jobId: 'reentrant-same-key-outer' });
      const sameKeyInnerInput = createJobInput({ jobId: 'reentrant-same-key-inner' });
      const sameKeyStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 4,
        maxRetainedBytes: 4 * 1024 * 1024,
        now: () => {
          if (!sameKeyReentered) {
            sameKeyReentered = true;
            sameKeyInner = sameKeyStore.createOrReplay(sameKeyInnerInput);
          }
          return NOW;
        },
      });
      const sameKeyOuter = await sameKeyStore.createOrReplay(sameKeyOuterInput);
      if (sameKeyInner === undefined) throw new Error('The reentrant create was not invoked.');
      const sameKeyWinner = await sameKeyInner;
      expect([sameKeyOuter.status, sameKeyWinner.status].sort()).toEqual(['created', 'replayed']);
      expect(sameKeyOuter.record.jobId).toBe('reentrant-same-key-inner');
      expect(sameKeyStore.diagnostics).toMatchObject({
        retainedJobs: 1,
        retainedBytes: packetRetainedBytes(sameKeyInnerInput.packet),
      });

      await Promise.all([replayStore.dispose(), taskFenceStore.dispose(), sameKeyStore.dispose()]);
    },
  );

  acceptanceIt(
    'C7C-HTTP-STORE05.l1.owned-frozen-scope',
    'full-scope-and-authorization-resolution',
    async () => {
      assertNetworkDenyGuardInstalled();
      const sourceBytes = bytes('owned-sidecar-payload');
      const input = createJobInput({ sidecars: [createSidecar('owned-sidecar', sourceBytes)] });
      const expectedBytes = Uint8Array.from(input.packet.sidecars[0]!.data);
      const store = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 4,
        maxRetainedBytes: 4 * 1024 * 1024,
        now: () => NOW,
      });
      const created = await store.createOrReplay(input);
      input.packet.sidecars[0]!.data.fill(0);
      expect(created.record.createPacket.sidecars[0]!.data).toEqual(expectedBytes);
      expect(Object.isFrozen(created)).toBe(true);
      expect(Object.isFrozen(created.record)).toBe(true);
      expect(Object.isFrozen(created.record.createPacket)).toBe(true);
      expect(Object.isFrozen(created.record.createPacket.sidecars)).toBe(true);
      expect(Object.isFrozen(created.record.createPacket.sidecars[0]!.descriptor)).toBe(true);

      created.record.createPacket.sidecars[0]!.data.fill(0xff);
      const loaded = await store.load(scopeFor(input));
      if (loaded === undefined) throw new Error('Expected the full-scope job lookup to succeed.');
      expect(loaded).not.toBe(created.record);
      expect(loaded.createPacket.sidecars[0]!.data).toEqual(expectedBytes);
      const normalized = normalizeHttpSubAgentJobRecord(loaded);
      expect(normalized).toEqual(loaded);
      expect(normalized).not.toBe(loaded);
      expect(normalized.createPacket).not.toBe(loaded.createPacket);
      expect(() =>
        normalizeHttpSubAgentJobRecord({
          ...loaded,
          createIdentity: '0'.repeat(64),
        }),
      ).toThrow(TypeError);
      expect(() =>
        normalizeHttpSubAgentJobRecord({
          ...loaded,
          remainingMsCeiling: loaded.remainingMsCeiling + 1,
        }),
      ).toThrow(TypeError);
      expect(() => normalizeHttpSubAgentJobRecord({ ...loaded, unexpected: true })).toThrow(
        TypeError,
      );
      const normalizedData = normalized.createPacket.sidecars[0]!.data;
      normalizedData[0] = normalizedData[0]! ^ 1;
      expect(() => normalizeHttpSubAgentJobRecord(normalized)).toThrow();
      expect((await store.load(scopeFor(input)))?.createPacket.sidecars[0]!.data).toEqual(
        expectedBytes,
      );
      expect(
        await store.load({ ...scopeFor(input), ownerSessionId: 'wrong-owner-session' }),
      ).toBeUndefined();
      expect(
        await store.load({ ...scopeFor(input), principalId: 'wrong-principal' }),
      ).toBeUndefined();
      expect(await store.load({ ...scopeFor(input), jobId: 'unknown-job' })).toBeUndefined();

      const authorizationResolution = await store.resolveForAuthorization({
        principalId: PRINCIPAL_ID,
        jobId: JOB_ID,
      });
      if (authorizationResolution === undefined) {
        throw new Error('Expected the trusted authorization lookup to resolve owner scope.');
      }
      expect(authorizationResolution).toEqual({ ownerSessionId: OWNER_SESSION_ID });
      expect(Object.keys(authorizationResolution)).toEqual(['ownerSessionId']);
      expect(Object.isFrozen(authorizationResolution)).toBe(true);
      expect(
        await store.resolveForAuthorization({ principalId: 'wrong-principal', jobId: JOB_ID }),
      ).toBeUndefined();
      expect(
        await store.resolveForAuthorization({ principalId: PRINCIPAL_ID, jobId: 'unknown-job' }),
      ).toBeUndefined();

      await expectStoreError(
        store.createOrReplay(
          createJobInput({
            ownerSessionId: 'other-owner',
            runId: 'other-run',
            taskId: 'other-task',
            operationId: 'other-operation',
            idempotencyKey: 'other-key',
            jobId: JOB_ID,
          }),
        ),
        'idempotency_conflict',
      );
      const otherPrincipal = createJobInput({
        principalId: 'http-principal-2',
        ownerSessionId: 'other-owner',
        runId: 'other-run',
        taskId: 'other-task',
        operationId: 'other-operation',
        idempotencyKey: 'other-key',
        jobId: JOB_ID,
      });
      await expect(store.createOrReplay(otherPrincipal)).resolves.toMatchObject({
        status: 'created',
        record: { principalId: 'http-principal-2', jobId: JOB_ID },
      });
      expect(store.diagnostics.retainedJobs).toBe(2);
      await store.dispose();
    },
  );

  acceptanceIt(
    'C7C-HTTP-STORE06.l2.bounded-memory-retention',
    'count-bytes-no-lru-and-dispose',
    async () => {
      assertNetworkDenyGuardInstalled();
      const first = createJobInput({
        taskId: 'capacity-task-a',
        operationId: 'capacity-operation-a',
        idempotencyKey: 'capacity-key-a',
        jobId: 'capacity-job-a',
      });
      const second = createJobInput({
        taskId: 'capacity-task-b',
        operationId: 'capacity-operation-b',
        idempotencyKey: 'capacity-key-b',
        jobId: 'capacity-job-b',
      });
      const overflow = createJobInput({
        taskId: 'capacity-task-c',
        operationId: 'capacity-operation-c',
        idempotencyKey: 'capacity-key-c',
        jobId: 'capacity-job-c',
      });
      const countStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 2,
        maxRetainedBytes: 16 * 1024 * 1024,
        now: () => NOW,
      });
      await countStore.createOrReplay(first);
      await countStore.createOrReplay(second);
      await countStore.load(scopeFor(first));
      await expectStoreError(countStore.createOrReplay(overflow), 'capacity_exhausted');
      await expect(
        countStore.createOrReplay(
          createJobInput({
            taskId: 'capacity-task-a',
            operationId: 'capacity-operation-a',
            idempotencyKey: 'capacity-key-a',
            jobId: 'ignored',
          }),
        ),
      ).resolves.toMatchObject({ status: 'replayed', record: { jobId: first.jobId } });
      expect(await countStore.load(scopeFor(first))).toBeDefined();
      expect(await countStore.load(scopeFor(second))).toBeDefined();
      expect(countStore.diagnostics).toMatchObject({ retainedJobs: 2, capacity: 2 });

      const byteInput = createJobInput({
        taskId: 'byte-task-a',
        operationId: 'byte-operation-a',
        idempotencyKey: 'byte-key-a',
        jobId: 'byte-job-a',
        sidecars: [createSidecar('byte-sidecar', bytes('byte-capacity-payload'))],
      });
      const exactRetainedBytes = packetRetainedBytes(byteInput.packet);
      const belowByteStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 2,
        maxRetainedBytes: exactRetainedBytes - 1,
        now: () => NOW,
      });
      await expectStoreError(belowByteStore.createOrReplay(byteInput), 'capacity_exhausted');
      expect(belowByteStore.diagnostics.retainedBytes).toBe(0);

      let clockCalls = 0;
      const exactByteStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 2,
        maxRetainedBytes: exactRetainedBytes,
        now: () => {
          clockCalls += 1;
          if (clockCalls > 1) throw new Error('A retained replay must not consult the clock.');
          return NOW;
        },
      });
      await exactByteStore.createOrReplay(byteInput);
      await expect(
        exactByteStore.createOrReplay(
          createJobInput({
            taskId: 'byte-task-a',
            operationId: 'byte-operation-a',
            idempotencyKey: 'byte-key-a',
            jobId: 'ignored-byte-replay',
            remainingMs: DEFAULT_REMAINING_MS - 1,
            sidecars: [createSidecar('byte-sidecar', bytes('byte-capacity-payload'))],
          }),
        ),
      ).resolves.toMatchObject({ status: 'replayed', record: { jobId: byteInput.jobId } });
      expect(clockCalls).toBe(1);
      expect(exactByteStore.diagnostics).toMatchObject({
        retainedJobs: 1,
        retainedBytes: exactRetainedBytes,
        maxRetainedBytes: exactRetainedBytes,
      });

      await Promise.all([countStore.dispose(), belowByteStore.dispose(), exactByteStore.dispose()]);
      await Promise.all([countStore.dispose(), belowByteStore.dispose(), exactByteStore.dispose()]);
      expect(exactByteStore.diagnostics).toMatchObject({
        retainedJobs: 0,
        retainedBytes: 0,
        disposed: true,
      });
      await expectStoreError(exactByteStore.createOrReplay(byteInput), 'disposed');
      await expectStoreError(exactByteStore.load(scopeFor(byteInput)), 'disposed');
      await expectStoreError(
        exactByteStore.resolveForAuthorization({
          principalId: byteInput.principalId,
          jobId: byteInput.jobId,
        }),
        'disposed',
      );
    },
  );

  acceptanceIt(
    'C7C-HTTP-STORE08.l1.hostile-store-input',
    'proxy-accessor-zero-side-effect',
    async () => {
      assertNetworkDenyGuardInstalled();
      let optionReads = 0;
      const hostileOptions = new Proxy(
        { mode: 'loopback-test' },
        {
          get() {
            optionReads += 1;
            throw new Error('A hostile options Proxy trap must not run.');
          },
        },
      );
      expect(() => Reflect.construct(MemoryHttpSubAgentJobStore, [hostileOptions])).toThrow();
      expect(optionReads).toBe(0);

      const store = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 2,
        maxRetainedBytes: 4 * 1024 * 1024,
        now: () => NOW,
      });
      const valid = createJobInput();
      let proxyReads = 0;
      const hostileCreate = new Proxy(valid, {
        get() {
          proxyReads += 1;
          throw new Error('A hostile create Proxy trap must not run.');
        },
      });
      await expect(
        Promise.resolve().then(() => Reflect.apply(store.createOrReplay, store, [hostileCreate])),
      ).rejects.toThrow();
      expect(proxyReads).toBe(0);

      let accessorReads = 0;
      const accessorCreate = dataCloneWithAccessor(valid, 'principalId', () => {
        accessorReads += 1;
      });
      await expect(
        Promise.resolve().then(() => Reflect.apply(store.createOrReplay, store, [accessorCreate])),
      ).rejects.toThrow();
      expect(accessorReads).toBe(0);
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(store.createOrReplay, store, [{ ...valid, unexpected: true }]),
        ),
      ).rejects.toThrow();
      const customPrototype = Object.defineProperties(
        Object.create({ inherited: true }),
        Object.getOwnPropertyDescriptors(valid),
      );
      await expect(
        Promise.resolve().then(() => Reflect.apply(store.createOrReplay, store, [customPrototype])),
      ).rejects.toThrow();

      let scopeProxyReads = 0;
      const hostileScope = new Proxy(scopeFor(valid), {
        get() {
          scopeProxyReads += 1;
          throw new Error('A hostile scope Proxy trap must not run.');
        },
      });
      await expect(
        Promise.resolve().then(() => Reflect.apply(store.load, store, [hostileScope])),
      ).rejects.toThrow();
      expect(scopeProxyReads).toBe(0);
      let scopeAccessorReads = 0;
      const accessorScope = dataCloneWithAccessor(scopeFor(valid), 'jobId', () => {
        scopeAccessorReads += 1;
      });
      await expect(
        Promise.resolve().then(() => Reflect.apply(store.load, store, [accessorScope])),
      ).rejects.toThrow();
      expect(scopeAccessorReads).toBe(0);
      expect(store.diagnostics).toMatchObject({ retainedJobs: 0, retainedBytes: 0 });

      await store.createOrReplay(valid);
      const storedRecord = await store.load(scopeFor(valid));
      if (storedRecord === undefined) throw new Error('Expected the hostile test record to exist.');
      let recordAccessorReads = 0;
      const accessorRecord = dataCloneWithAccessor(storedRecord, 'createIdentity', () => {
        recordAccessorReads += 1;
      });
      expect(() => normalizeHttpSubAgentJobRecord(accessorRecord)).toThrow();
      expect(recordAccessorReads).toBe(0);
      let recordProxyReads = 0;
      const proxyRecord = new Proxy(storedRecord, {
        get() {
          recordProxyReads += 1;
          throw new Error('A hostile job record Proxy trap must not run.');
        },
      });
      expect(() => normalizeHttpSubAgentJobRecord(proxyRecord)).toThrow();
      expect(recordProxyReads).toBe(0);
      let lookupReads = 0;
      const hostileLookup = dataCloneWithAccessor(
        { principalId: PRINCIPAL_ID, jobId: JOB_ID },
        'jobId',
        () => {
          lookupReads += 1;
        },
      );
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(store.resolveForAuthorization, store, [hostileLookup]),
        ),
      ).rejects.toThrow();
      expect(lookupReads).toBe(0);

      const innerDifferent = createJobInput({
        operationId: 'reentrant-different-operation',
        idempotencyKey: 'reentrant-different-key',
        jobId: 'reentrant-different-inner',
      });
      const outerDifferent = createJobInput({ jobId: 'reentrant-different-outer' });
      let differentInner: Promise<HttpSubAgentJobCreateResult> | undefined;
      let differentReentered = false;
      const differentStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 4,
        maxRetainedBytes: 4 * 1024 * 1024,
        now: () => {
          if (!differentReentered) {
            differentReentered = true;
            differentInner = differentStore.createOrReplay(innerDifferent);
          }
          return NOW;
        },
      });
      await expectStoreError(differentStore.createOrReplay(outerDifferent), 'idempotency_conflict');
      if (differentInner === undefined) throw new Error('The reentrant create was not invoked.');
      await expect(differentInner).resolves.toMatchObject({
        status: 'created',
        record: { jobId: innerDifferent.jobId },
      });
      expect(differentStore.diagnostics).toMatchObject({
        retainedJobs: 1,
        retainedBytes: packetRetainedBytes(innerDifferent.packet),
      });

      const sharedJobId = 'reentrant-shared-job';
      const innerJobCollision = createJobInput({
        taskId: 'reentrant-job-inner-task',
        operationId: 'reentrant-job-inner-operation',
        idempotencyKey: 'reentrant-job-inner-key',
        jobId: sharedJobId,
      });
      const outerJobCollision = createJobInput({
        taskId: 'reentrant-job-outer-task',
        operationId: 'reentrant-job-outer-operation',
        idempotencyKey: 'reentrant-job-outer-key',
        jobId: sharedJobId,
      });
      let jobCollisionInner: Promise<HttpSubAgentJobCreateResult> | undefined;
      let jobCollisionReentered = false;
      const jobCollisionStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 4,
        maxRetainedBytes: 4 * 1024 * 1024,
        now: () => {
          if (!jobCollisionReentered) {
            jobCollisionReentered = true;
            jobCollisionInner = jobCollisionStore.createOrReplay(innerJobCollision);
          }
          return NOW;
        },
      });
      await expectStoreError(
        jobCollisionStore.createOrReplay(outerJobCollision),
        'idempotency_conflict',
      );
      if (jobCollisionInner === undefined) {
        throw new Error('The reentrant job collision create was not invoked.');
      }
      await expect(jobCollisionInner).resolves.toMatchObject({
        status: 'created',
        record: { jobId: sharedJobId, taskId: 'reentrant-job-inner-task' },
      });
      expect(jobCollisionStore.diagnostics).toMatchObject({
        retainedJobs: 1,
        retainedBytes: packetRetainedBytes(innerJobCollision.packet),
      });

      const innerCapacity = createJobInput({
        taskId: 'reentrant-capacity-inner-task',
        operationId: 'reentrant-capacity-inner-operation',
        idempotencyKey: 'reentrant-capacity-inner-key',
        jobId: 'reentrant-capacity-inner-job',
      });
      const outerCapacity = createJobInput({
        taskId: 'reentrant-capacity-outer-task',
        operationId: 'reentrant-capacity-outer-operation',
        idempotencyKey: 'reentrant-capacity-outer-key',
        jobId: 'reentrant-capacity-outer-job',
      });
      let capacityInner: Promise<HttpSubAgentJobCreateResult> | undefined;
      let capacityReentered = false;
      const capacityStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 1,
        maxRetainedBytes: 4 * 1024 * 1024,
        now: () => {
          if (!capacityReentered) {
            capacityReentered = true;
            capacityInner = capacityStore.createOrReplay(innerCapacity);
          }
          return NOW;
        },
      });
      await expectStoreError(capacityStore.createOrReplay(outerCapacity), 'capacity_exhausted');
      if (capacityInner === undefined) {
        throw new Error('The reentrant capacity create was not invoked.');
      }
      await expect(capacityInner).resolves.toMatchObject({
        status: 'created',
        record: { jobId: innerCapacity.jobId },
      });
      expect(capacityStore.diagnostics).toMatchObject({
        retainedJobs: 1,
        retainedBytes: packetRetainedBytes(innerCapacity.packet),
      });

      const disposeInput = createJobInput({ jobId: 'dispose-during-clock' });
      let disposePromise: Promise<void> | undefined;
      const disposeStore = new MemoryHttpSubAgentJobStore({
        mode: 'loopback-test',
        capacity: 1,
        maxRetainedBytes: 4 * 1024 * 1024,
        now: () => {
          disposePromise = disposeStore.dispose();
          return NOW;
        },
      });
      await expectStoreError(disposeStore.createOrReplay(disposeInput), 'disposed');
      if (disposePromise === undefined) throw new Error('The reentrant dispose was not invoked.');
      await disposePromise;
      expect(disposeStore.diagnostics).toMatchObject({
        retainedJobs: 0,
        retainedBytes: 0,
        disposed: true,
      });

      await Promise.all([
        store.dispose(),
        differentStore.dispose(),
        jobCollisionStore.dispose(),
        capacityStore.dispose(),
        disposeStore.dispose(),
      ]);
    },
  );

  acceptanceIt(
    'C7C-HTTP-STORE09.l1.create-semantic-identity',
    'transport-deadline-invariant-business-sensitive',
    () => {
      assertNetworkDenyGuardInstalled();
      const sidecarA = createSidecar('semantic-a', bytes('semantic-sidecar-a'));
      const sidecarB = createSidecar('semantic-b', bytes('semantic-sidecar-b'));
      const base = createJobInput({ sidecars: [sidecarA, sidecarB] });
      const equivalent = createJobInput({
        sidecars: [sidecarB, sidecarA],
        remainingMs: DEFAULT_REMAINING_MS - 5_000,
        channelId: 'semantic-peer-retry',
        sequence: 77,
        messageId: 'semantic-message-retry',
      });
      const identityA = createHttpSubAgentJobCreateIdentity({
        route: base.route,
        packet: base.packet,
      });
      const identityB = createHttpSubAgentJobCreateIdentity({
        route: equivalent.route,
        packet: equivalent.packet,
      });
      expect(identityA.createIdentity).toBe(
        'd18569414fabdcbb7b5b52d0f464eabaa169801ca479dcfcb2aba48e3dc97f69',
      );
      expect(identityB.createIdentity).toBe(identityA.createIdentity);
      expect(identityB.createReceipt).not.toBe(identityA.createReceipt);
      expect(identityB.remainingMs).toBe(DEFAULT_REMAINING_MS - 5_000);
      expect(identityB.channelId).toBe('semantic-peer-retry');

      const boundaryA = decodeHttpSubAgentMultipartPacket(
        encodeHttpSubAgentMultipartPacket(base.packet, { boundary: 'semantic-boundary-a' }),
      );
      const boundaryB = decodeHttpSubAgentMultipartPacket(
        encodeHttpSubAgentMultipartPacket(base.packet, { boundary: 'semantic-boundary-b' }),
      );
      expect(
        createHttpSubAgentJobCreateIdentity({ route: base.route, packet: boundaryA })
          .createIdentity,
      ).toBe(
        createHttpSubAgentJobCreateIdentity({ route: base.route, packet: boundaryB })
          .createIdentity,
      );

      const changedBusiness = createHttpSubAgentJobCreateIdentity({
        route: base.route,
        packet: createJobInput({
          query: 'changed semantic business input',
          sidecars: [sidecarA, sidecarB],
        }).packet,
      });
      const changedMode = createHttpSubAgentJobCreateIdentity({
        route: base.route,
        packet: createJobInput({ mode: 'spawn', sidecars: [sidecarA, sidecarB] }).packet,
      });
      const changedSidecar = createHttpSubAgentJobCreateIdentity({
        route: base.route,
        packet: createJobInput({
          sidecars: [createSidecar('semantic-a', bytes('changed-semantic-sidecar-a')), sidecarB],
        }).packet,
      });
      const changedTask = createHttpSubAgentJobCreateIdentity({
        route: base.route,
        packet: createJobInput({ taskId: 'changed-semantic-task', sidecars: [sidecarA, sidecarB] })
          .packet,
      });
      const changedOperation = createHttpSubAgentJobCreateIdentity({
        route: base.route,
        packet: createJobInput({
          operationId: 'changed-semantic-operation',
          sidecars: [sidecarA, sidecarB],
        }).packet,
      });
      const changedIdempotencyKey = createHttpSubAgentJobCreateIdentity({
        route: base.route,
        packet: createJobInput({
          idempotencyKey: 'changed-semantic-idempotency',
          sidecars: [sidecarA, sidecarB],
        }).packet,
      });
      const changedOwnerAndRun = createHttpSubAgentJobCreateIdentity({
        route: base.route,
        packet: createJobInput({
          ownerSessionId: 'changed-semantic-owner',
          runId: 'changed-semantic-run',
          sidecars: [sidecarA, sidecarB],
        }).packet,
      });
      const changedIdentities = [
        changedBusiness,
        changedMode,
        changedSidecar,
        changedTask,
        changedOperation,
        changedIdempotencyKey,
        changedOwnerAndRun,
      ];
      for (const changed of changedIdentities) {
        expect(changed.createIdentity).not.toBe(identityA.createIdentity);
      }
      expect(new Set(changedIdentities.map((item) => item.createIdentity)).size).toBe(
        changedIdentities.length,
      );
      expect(Object.isFrozen(identityA)).toBe(true);
      expect(Object.isFrozen(identityA.packet)).toBe(true);
      expect(Object.isFrozen(identityA.packet.sidecars)).toBe(true);
    },
  );
});
