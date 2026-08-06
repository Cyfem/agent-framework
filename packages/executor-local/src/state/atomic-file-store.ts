import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

import {
  StateLeaseUnavailableError,
  type AgentRuntimeStateStore,
  type AgentRuntimeStateTransaction,
  type StateLease,
  type StoredAgentRun,
  type StoredTask,
  type SubAgentTaskEvent,
} from '@ruixutong.manee/maneeagent-framework';

import {
  assertEventCursor,
  assertSessionLeaseScope,
  assertTtl,
  createSessionState,
  createStateTransaction,
  deserializeSessionState,
  findIdempotentTask,
  findSubagentSessionTask,
  insertRun,
  listTasksByRun,
  readRun,
  readTask,
  readTaskEvents,
  serializeSessionState,
  type SerializedSessionState,
  type SessionState,
} from './state-domain';
import {
  defaultLocalFilesystemVerifier,
  type LocalFilesystemVerifier,
} from './local-filesystem-verifier';

const ROOT_MODE = 0o700;
const FILE_MODE = 0o600;
const WAL_SCHEMA = 'maneeagent-local-wal/v2';
const COMMIT_SCHEMA = 'maneeagent-local-commit/v2';
const HEAD_SCHEMA = 'maneeagent-local-head/v1';
const LEASE_SCHEMA = 'maneeagent-local-lease/v1';
const LOCK_SCHEMA = 'maneeagent-local-lock/v1';
const LOCK_RELEASE_SCHEMA = 'maneeagent-local-lock-release/v1';

interface WalPayload {
  readonly schema: typeof WAL_SCHEMA;
  readonly sequence: number;
  readonly sessionHash: string;
  readonly previousHeadChecksum: string | null;
  readonly state: SerializedSessionState;
}

interface CommitMarkerBody {
  readonly schema: typeof COMMIT_SCHEMA;
  readonly sequence: number;
  readonly base: string;
  readonly walChecksum: string;
  readonly previousHeadChecksum: string | null;
}

interface CommitMarker extends CommitMarkerBody {
  readonly headChecksum: string;
}

interface HeadRecord {
  readonly schema: typeof HEAD_SCHEMA;
  readonly sequence: number;
  readonly base: string;
  readonly headChecksum: string;
}

interface LockOwnerRecord {
  readonly schema: typeof LOCK_SCHEMA;
  readonly generation: number;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: number;
}

interface LockReleaseRecord {
  readonly schema: typeof LOCK_RELEASE_SCHEMA;
  readonly token: string;
  readonly releasedAt: number;
}

interface LockGeneration {
  readonly generation: number;
  readonly path: string;
  readonly owner: LockOwnerRecord;
  readonly released: boolean;
}

interface LockOwnership extends LockGeneration {
  readonly released: false;
}

interface PersistentLeaseRecord {
  readonly schema: typeof LEASE_SCHEMA;
  readonly keyHash: string;
  readonly fencingToken: string;
  readonly ownerId: string;
  readonly expiresAt: number;
  readonly released: boolean;
}

export interface AtomicFileAgentRuntimeStateStoreOptions {
  readonly root: string;
  readonly transactionDomainId?: string;
  readonly now?: () => number;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly transactionTimeoutMs?: number;
  readonly filesystemVerifier?: LocalFilesystemVerifier;
}

class AtomicFileStateLease implements StateLease {
  constructor(
    readonly key: string,
    readonly fencingToken: string,
    readonly expiresAt: number,
    readonly ownerId: string,
    readonly store: AtomicFileAgentRuntimeStateStore,
  ) {}

  renew(ttlMs: number): Promise<StateLease> {
    return this.store.renewLease(this, ttlMs);
  }

  release(): Promise<void> {
    return this.store.releaseLease(this);
  }
}

/**
 * Single-host crash-recoverable StateStore. Immutable checksummed WAL + commit markers are
 * authoritative; snapshots are rebuildable caches. It is deliberately not a network-FS store.
 */
export class AtomicFileAgentRuntimeStateStore implements AgentRuntimeStateStore {
  readonly transactionDomainId: string;
  readonly root: string;
  readonly #now: () => number;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  readonly #transactionTimeoutMs: number;
  readonly #filesystemVerifier: LocalFilesystemVerifier;
  readonly #ready: Promise<void>;
  #rootReal = '';

  constructor(options: AtomicFileAgentRuntimeStateStoreOptions) {
    if (typeof options?.root !== 'string' || options.root.trim().length === 0) {
      throw new TypeError('Atomic File StateStore requires a non-empty root path.');
    }
    assertLocalRootSyntax(options.root);
    this.root = resolve(options.root);
    this.transactionDomainId =
      options.transactionDomainId ?? `maneeagent-atomic-file:${sha256(this.root)}`;
    this.#now = options.now ?? Date.now;
    this.#lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? 5_000, 'lockTimeoutMs');
    this.#staleLockMs = positiveInteger(options.staleLockMs ?? 1_000, 'staleLockMs');
    this.#transactionTimeoutMs = positiveInteger(
      options.transactionTimeoutMs ?? 5_000,
      'transactionTimeoutMs',
    );
    this.#filesystemVerifier = options.filesystemVerifier ?? defaultLocalFilesystemVerifier;
    this.#ready = this.#initialize();
  }

  /** Completes root creation and security checks before a host begins runtime initialization. */
  async init(): Promise<void> {
    await this.#ready;
  }

  async createRun(record: StoredAgentRun): Promise<void> {
    await this.#withSessionLock(record.ownerSessionId, async (paths, assertSessionLock) => {
      const { state, sequence, headChecksum } = await this.#loadCommittedState(paths);
      insertRun(state, record);
      await this.#commitState(paths, state, sequence + 1, headChecksum, assertSessionLock);
    });
  }

  async loadRun(ownerSessionId: string, runId: string): Promise<StoredAgentRun | undefined> {
    return readRun((await this.#readSession(ownerSessionId)).state, runId);
  }

  async loadTask(ownerSessionId: string, taskId: string): Promise<StoredTask | undefined> {
    return readTask((await this.#readSession(ownerSessionId)).state, taskId);
  }

  async listTasksByRun(ownerSessionId: string, runId: string): Promise<readonly StoredTask[]> {
    return listTasksByRun((await this.#readSession(ownerSessionId)).state, runId);
  }

  async findTaskByIdempotencyKey(
    ownerSessionId: string,
    runId: string,
    requestId: string,
  ): Promise<StoredTask | undefined> {
    return findIdempotentTask((await this.#readSession(ownerSessionId)).state, runId, requestId);
  }

  async findTaskBySubAgentSession(
    ownerSessionId: string,
    subagentSessionId: string,
  ): Promise<StoredTask | undefined> {
    return findSubagentSessionTask(
      (await this.#readSession(ownerSessionId)).state,
      subagentSessionId,
    );
  }

  async transaction<T>(
    ownerSessionId: string,
    lease: StateLease,
    work: (transaction: AgentRuntimeStateTransaction) => Promise<T>,
  ): Promise<T> {
    const owned = this.#assertLeaseInstance(lease);
    assertSessionLeaseScope(ownerSessionId, owned.key);
    return this.#withSessionLock(ownerSessionId, async (paths, assertSessionLock) => {
      const leaseLock = resolve(this.#rootReal, 'locks', `lease-${sha256(owned.key)}.lock`);
      return this.#withFileLock(leaseLock, async (assertLeaseLock) => {
        await this.#assertActiveLease(owned);
        const current = await this.#loadCommittedState(paths);
        const staged = createSessionState(current.state);
        let active = true;
        const transaction = createStateTransaction({
          ownerSessionId,
          lease: owned,
          staged,
          assertLease: () => this.#assertActiveLease(owned),
          isActive: () => active,
        });
        try {
          const result = await withTimeout(
            work(transaction),
            this.#transactionTimeoutMs,
            'Atomic File StateStore transaction timed out.',
          );
          await this.#assertActiveLease(owned);
          await this.#commitState(
            paths,
            staged,
            current.sequence + 1,
            current.headChecksum,
            async () => {
              await assertSessionLock();
              await assertLeaseLock();
              await this.#assertActiveLease(owned);
            },
          );
          return result;
        } finally {
          active = false;
        }
      });
    });
  }

  async readEvents(
    ownerSessionId: string,
    taskId: string,
    afterSequence = 0,
  ): Promise<readonly SubAgentTaskEvent[]> {
    assertEventCursor(afterSequence);
    return readTaskEvents((await this.#readSession(ownerSessionId)).state, taskId, afterSequence);
  }

  async acquireLease(key: string, ttlMs: number): Promise<StateLease> {
    await this.#ready;
    assertTtl(ttlMs);
    if (key.length === 0) throw new TypeError('Lease key must be non-empty.');
    const keyHash = sha256(key);
    const recordPath = resolve(this.#rootReal, 'leases', `${keyHash}.json`);
    const lockPath = resolve(this.#rootReal, 'locks', `lease-${keyHash}.lock`);
    return this.#withFileLock(lockPath, async (assertLock) => {
      const now = this.#readNow();
      const current = await readJsonIfExists<PersistentLeaseRecord>(recordPath);
      if (current !== undefined) validateLeaseRecord(current, keyHash);
      if (current !== undefined && !current.released && now < current.expiresAt) {
        throw new StateLeaseUnavailableError(key);
      }
      const fencingToken = (BigInt(current?.fencingToken ?? '0') + 1n).toString(10);
      const next: PersistentLeaseRecord = {
        schema: LEASE_SCHEMA,
        keyHash,
        fencingToken,
        ownerId: randomUUID(),
        expiresAt: now + ttlMs,
        released: false,
      };
      await atomicWriteJson(recordPath, next, assertLock);
      return new AtomicFileStateLease(key, fencingToken, next.expiresAt, next.ownerId, this);
    });
  }

  async renewLease(lease: AtomicFileStateLease, ttlMs: number): Promise<StateLease> {
    await this.#ready;
    assertTtl(ttlMs);
    const owned = this.#assertLeaseInstance(lease);
    const keyHash = sha256(owned.key);
    const recordPath = resolve(this.#rootReal, 'leases', `${keyHash}.json`);
    const lockPath = resolve(this.#rootReal, 'locks', `lease-${keyHash}.lock`);
    return this.#withFileLock(lockPath, async (assertLock) => {
      const current = await this.#readOwnedActiveLease(owned, recordPath, keyHash);
      const next: PersistentLeaseRecord = {
        ...current,
        expiresAt: this.#readNow() + ttlMs,
      };
      await atomicWriteJson(recordPath, next, assertLock);
      return new AtomicFileStateLease(
        owned.key,
        owned.fencingToken,
        next.expiresAt,
        owned.ownerId,
        this,
      );
    });
  }

  async releaseLease(lease: AtomicFileStateLease): Promise<void> {
    await this.#ready;
    const owned = this.#assertLeaseInstance(lease);
    const keyHash = sha256(owned.key);
    const recordPath = resolve(this.#rootReal, 'leases', `${keyHash}.json`);
    const lockPath = resolve(this.#rootReal, 'locks', `lease-${keyHash}.lock`);
    await this.#withFileLock(lockPath, async (assertLock) => {
      const current = await readJsonIfExists<PersistentLeaseRecord>(recordPath);
      if (
        current === undefined ||
        current.ownerId !== owned.ownerId ||
        current.fencingToken !== owned.fencingToken
      ) {
        return;
      }
      validateLeaseRecord(current, keyHash);
      await atomicWriteJson(recordPath, { ...current, released: true }, assertLock);
    });
  }

  async #initialize(): Promise<void> {
    if (!isAbsolute(this.root))
      throw new TypeError('Atomic File StateStore root must be absolute.');
    await mkdir(this.root, { recursive: true, mode: ROOT_MODE });
    await assertNoSymlinkComponents(this.root);
    await assertSecureDirectory(this.root, undefined);
    this.#rootReal = await realpath(this.root);
    await assertVerifiedLocalFilesystem(this.#filesystemVerifier, this.#rootReal);
    for (const name of ['sessions', 'leases', 'locks']) {
      const directory = resolve(this.#rootReal, name);
      await mkdir(directory, { recursive: true, mode: ROOT_MODE });
      await assertSecureDirectory(directory, this.#rootReal);
    }
  }

  async #readSession(ownerSessionId: string): Promise<{
    readonly state: SessionState;
    readonly sequence: number;
    readonly headChecksum: string | null;
  }> {
    const paths = await this.#sessionPaths(ownerSessionId);
    return this.#loadCommittedState(paths);
  }

  async #withSessionLock<T>(
    ownerSessionId: string,
    work: (paths: SessionPaths, assertOwnership: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const paths = await this.#sessionPaths(ownerSessionId);
    return this.#withFileLock(paths.lock, (assertOwnership) => work(paths, assertOwnership));
  }

  async #sessionPaths(ownerSessionId: string): Promise<SessionPaths> {
    await this.#ready;
    if (ownerSessionId.length === 0) throw new TypeError('ownerSessionId must be non-empty.');
    const sessionHash = sha256(ownerSessionId);
    const directory = resolve(this.#rootReal, 'sessions', sessionHash);
    await mkdir(directory, { recursive: true, mode: ROOT_MODE });
    await assertSecureDirectory(directory, resolve(this.#rootReal, 'sessions'));
    const wal = resolve(directory, 'wal');
    const commits = resolve(directory, 'commits');
    await mkdir(wal, { recursive: true, mode: ROOT_MODE });
    await mkdir(commits, { recursive: true, mode: ROOT_MODE });
    await assertSecureDirectory(wal, directory);
    await assertSecureDirectory(commits, directory);
    return {
      sessionHash,
      directory,
      wal,
      commits,
      snapshot: resolve(directory, 'snapshot.json'),
      head: resolve(directory, 'head.json'),
      lock: resolve(directory, 'transaction.lock'),
    };
  }

  async #loadCommittedState(paths: SessionPaths): Promise<{
    readonly state: SessionState;
    readonly sequence: number;
    readonly headChecksum: string | null;
  }> {
    const commitEntries = await readdir(paths.commits);
    const markers: CommitFile[] = [];
    for (const filename of commitEntries) {
      if (filename.endsWith('.tmp')) continue;
      const marker = parseCommitFilename(filename);
      if (marker === undefined) {
        throw new Error('Atomic File StateStore commit directory contains an invalid entry.');
      }
      markers.push(marker);
    }
    markers.sort((left, right) => left.sequence - right.sequence);

    const durableHead = await readJsonIfExists<HeadRecord>(paths.head);
    if (markers.length === 0) {
      if (durableHead !== undefined) {
        throw new Error('Atomic File StateStore detected committed WAL rollback.');
      }
      return { state: createSessionState(), sequence: 0, headChecksum: null };
    }

    let latest: WalPayload | undefined;
    let previousHeadChecksum: string | null = null;
    let expectedSequence = 1;
    const markerBySequence = new Map<number, CommitMarker>();
    for (const markerFile of markers) {
      if (markerFile.sequence !== expectedSequence) {
        throw new Error('Atomic File StateStore WAL sequence has a duplicate or gap.');
      }
      const marker = await readJson<CommitMarker>(resolve(paths.commits, markerFile.filename));
      validateCommitMarker(marker, markerFile, previousHeadChecksum);
      const walPath = resolve(paths.wal, `${markerFile.base}.wal.json`);
      const walText = await readFile(walPath, 'utf8');
      if (sha256(walText) !== marker.walChecksum) {
        throw new Error('Atomic File StateStore WAL checksum mismatch.');
      }
      const payload = JSON.parse(walText) as WalPayload;
      validateWalPayload(payload, marker.sequence, paths.sessionHash, previousHeadChecksum);
      latest = payload;
      previousHeadChecksum = marker.headChecksum;
      markerBySequence.set(marker.sequence, marker);
      expectedSequence += 1;
    }

    if (durableHead !== undefined) {
      validateHeadRecord(durableHead);
      const referenced = markerBySequence.get(durableHead.sequence);
      if (
        referenced === undefined ||
        referenced.base !== durableHead.base ||
        referenced.headChecksum !== durableHead.headChecksum
      ) {
        throw new Error('Atomic File StateStore detected committed WAL rollback.');
      }
    }
    return {
      state: deserializeSessionState(latest!.state),
      sequence: latest!.sequence,
      headChecksum: previousHeadChecksum,
    };
  }

  async #commitState(
    paths: SessionPaths,
    state: SessionState,
    sequence: number,
    previousHeadChecksum: string | null,
    beforeMarkerPublish?: () => void | Promise<void>,
  ): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error('Atomic File StateStore WAL sequence is invalid.');
    }
    const transactionId = randomUUID();
    const base = `${sequence.toString().padStart(20, '0')}-${transactionId}`;
    const payload: WalPayload = {
      schema: WAL_SCHEMA,
      sequence,
      sessionHash: paths.sessionHash,
      previousHeadChecksum,
      state: serializeSessionState(state),
    };
    const walText = JSON.stringify(payload);
    const walChecksum = sha256(walText);
    const walPath = resolve(paths.wal, `${base}.wal.json`);
    const markerPath = resolve(paths.commits, `${base}.commit`);
    const markerBody: CommitMarkerBody = {
      schema: COMMIT_SCHEMA,
      sequence,
      base,
      walChecksum,
      previousHeadChecksum,
    };
    const marker: CommitMarker = {
      ...markerBody,
      headChecksum: sha256(JSON.stringify(markerBody)),
    };

    await immutableWrite(walPath, walText);
    await immutableWrite(markerPath, JSON.stringify(marker), beforeMarkerPublish);

    // The marker is authoritative. A failed cache refresh is recovered from WAL on the next read.
    try {
      await atomicWriteJson(paths.head, {
        schema: HEAD_SCHEMA,
        sequence,
        base,
        headChecksum: marker.headChecksum,
      } satisfies HeadRecord);
      await atomicWriteJson(paths.snapshot, payload);
    } catch {
      // Intentionally ignored: never turn a committed transaction into an ambiguous failure.
    }
  }

  async #assertActiveLease(lease: AtomicFileStateLease): Promise<void> {
    const keyHash = sha256(lease.key);
    const recordPath = resolve(this.#rootReal, 'leases', `${keyHash}.json`);
    await this.#readOwnedActiveLease(lease, recordPath, keyHash);
  }

  async #readOwnedActiveLease(
    lease: AtomicFileStateLease,
    recordPath: string,
    keyHash: string,
  ): Promise<PersistentLeaseRecord> {
    const current = await readJsonIfExists<PersistentLeaseRecord>(recordPath);
    if (current !== undefined) validateLeaseRecord(current, keyHash);
    if (
      current === undefined ||
      current.released ||
      current.ownerId !== lease.ownerId ||
      current.fencingToken !== lease.fencingToken ||
      this.#readNow() >= current.expiresAt
    ) {
      throw new Error(`Lease ${lease.key} is expired or fenced.`);
    }
    return current;
  }

  #assertLeaseInstance(lease: StateLease): AtomicFileStateLease {
    if (!(lease instanceof AtomicFileStateLease) || lease.store !== this) {
      throw new Error('Lease was not issued by this Atomic File StateStore instance.');
    }
    return lease;
  }

  async #withFileLock<T>(
    path: string,
    work: (assertOwnership: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    await this.#ensureLockRoot(path);
    const deadline = Date.now() + this.#lockTimeoutMs;
    let ownership: LockOwnership | undefined;

    while (ownership === undefined) {
      const latest = await this.#readLatestLockGeneration(path);
      if (latest !== undefined && !latest.released) {
        const info = await lstat(latest.path);
        const stale = Date.now() - info.mtimeMs >= this.#staleLockMs;
        if (!stale || isProcessAlive(latest.owner.pid)) {
          if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for the Atomic File StateStore process lock.');
          }
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
          continue;
        }
      }

      const nextGeneration = (latest?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(nextGeneration)) {
        throw new Error('Atomic File StateStore process lock generation overflowed.');
      }
      ownership = await this.#tryCreateLockGeneration(path, nextGeneration);
      if (ownership === undefined) {
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for the Atomic File StateStore process lock.');
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
      }
    }

    const assertOwnership = () => this.#assertLatestLockOwnership(path, ownership!);
    try {
      await assertOwnership();
      return await work(assertOwnership);
    } finally {
      await this.#releaseLockGeneration(path, ownership);
    }
  }

  async #ensureLockRoot(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: ROOT_MODE });
    await assertSecureDirectory(path, dirname(path));
  }

  async #readLatestLockGeneration(path: string): Promise<LockGeneration | undefined> {
    let latestName: string | undefined;
    let latestGeneration = 0;
    for (const entry of await readdir(path)) {
      if (entry.startsWith('.candidate-')) continue;
      const generation = parseLockGeneration(entry);
      if (generation === undefined) {
        throw new Error('Atomic File StateStore process lock contains an invalid entry.');
      }
      if (generation > latestGeneration) {
        latestGeneration = generation;
        latestName = entry;
      }
    }
    if (latestName === undefined) return undefined;

    const generationPath = resolve(path, latestName);
    await assertSecureDirectory(generationPath, path);
    const owner = await readJson<LockOwnerRecord>(resolve(generationPath, 'owner.json'));
    validateLockOwnerRecord(owner, latestGeneration);
    const release = await readJsonIfExists<LockReleaseRecord>(
      resolve(generationPath, 'released.json'),
    );
    if (release !== undefined) validateLockReleaseRecord(release, owner.token);
    return {
      generation: latestGeneration,
      path: generationPath,
      owner,
      released: release !== undefined,
    };
  }

  async #tryCreateLockGeneration(
    path: string,
    generation: number,
  ): Promise<LockOwnership | undefined> {
    const token = randomUUID();
    const owner: LockOwnerRecord = {
      schema: LOCK_SCHEMA,
      generation,
      token,
      pid: process.pid,
      createdAt: Date.now(),
    };
    const generationPath = resolve(path, formatLockGeneration(generation));
    const candidatePath = resolve(path, `.candidate-${generation}-${process.pid}-${token}`);
    try {
      await createLockCandidate(candidatePath, owner);
      await rename(candidatePath, generationPath);
      await syncDirectory(path).catch(async (error: unknown) => {
        if (!(await lockPathIsOwnedBy(generationPath, token))) throw error;
      });
    } catch (error) {
      await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
      if (await lockGenerationExists(generationPath)) return undefined;
      throw error;
    }

    const ownership: LockOwnership = {
      generation,
      path: generationPath,
      owner,
      released: false,
    };
    try {
      await this.#assertLatestLockOwnership(path, ownership);
      return ownership;
    } catch {
      await this.#releaseLockGeneration(path, ownership);
      return undefined;
    }
  }

  async #assertLatestLockOwnership(path: string, ownership: LockOwnership): Promise<void> {
    const latest = await this.#readLatestLockGeneration(path);
    if (
      latest === undefined ||
      latest.generation !== ownership.generation ||
      latest.owner.token !== ownership.owner.token ||
      latest.released
    ) {
      throw new Error('Atomic File StateStore process lock ownership was superseded.');
    }
  }

  async #releaseLockGeneration(path: string, ownership: LockOwnership): Promise<void> {
    const releasePath = resolve(ownership.path, 'released.json');
    await immutableWrite(
      releasePath,
      JSON.stringify({
        schema: LOCK_RELEASE_SCHEMA,
        token: ownership.owner.token,
        releasedAt: Date.now(),
      } satisfies LockReleaseRecord),
    ).catch(async (error: unknown) => {
      const release = await readJsonIfExists<LockReleaseRecord>(releasePath);
      if (release === undefined || release.token !== ownership.owner.token) throw error;
    });
    await syncDirectory(path).catch(() => undefined);
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('StateStore clock must return a non-negative safe integer.');
    }
    return now;
  }
}

interface SessionPaths {
  readonly sessionHash: string;
  readonly directory: string;
  readonly wal: string;
  readonly commits: string;
  readonly snapshot: string;
  readonly head: string;
  readonly lock: string;
}

interface CommitFile {
  readonly filename: string;
  readonly base: string;
  readonly sequence: number;
}

function parseCommitFilename(filename: string): CommitFile | undefined {
  const match = /^(\d{20})-([0-9a-f-]+)\.commit$/u.exec(filename);
  if (match === null) return undefined;
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined;
  return { filename, base: filename.slice(0, -'.commit'.length), sequence };
}

function parseLockGeneration(entry: string): number | undefined {
  const match = /^gen-(\d{20})$/u.exec(entry);
  if (match === null) return undefined;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) && generation >= 1 ? generation : undefined;
}

function formatLockGeneration(generation: number): string {
  return `gen-${generation.toString().padStart(20, '0')}`;
}

function validateWalPayload(
  payload: WalPayload,
  sequence: number,
  sessionHash: string,
  previousHeadChecksum: string | null,
): void {
  if (
    payload.schema !== WAL_SCHEMA ||
    payload.sequence !== sequence ||
    payload.sessionHash !== sessionHash ||
    payload.previousHeadChecksum !== previousHeadChecksum ||
    typeof payload.state !== 'object' ||
    payload.state === null
  ) {
    throw new Error('Atomic File StateStore WAL envelope is invalid.');
  }
}

function validateCommitMarker(
  marker: CommitMarker,
  file: CommitFile,
  previousHeadChecksum: string | null,
): void {
  if (
    marker.schema !== COMMIT_SCHEMA ||
    marker.sequence !== file.sequence ||
    marker.base !== file.base ||
    marker.previousHeadChecksum !== previousHeadChecksum ||
    !isChecksum(marker.walChecksum) ||
    !isChecksum(marker.headChecksum)
  ) {
    throw new Error('Atomic File StateStore commit marker is invalid.');
  }
  const markerBody: CommitMarkerBody = {
    schema: marker.schema,
    sequence: marker.sequence,
    base: marker.base,
    walChecksum: marker.walChecksum,
    previousHeadChecksum: marker.previousHeadChecksum,
  };
  if (sha256(JSON.stringify(markerBody)) !== marker.headChecksum) {
    throw new Error('Atomic File StateStore commit head checksum mismatch.');
  }
}

function validateHeadRecord(record: HeadRecord): void {
  if (
    record.schema !== HEAD_SCHEMA ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    typeof record.base !== 'string' ||
    parseCommitFilename(`${record.base}.commit`)?.sequence !== record.sequence ||
    !isChecksum(record.headChecksum)
  ) {
    throw new Error('Atomic File StateStore head record is invalid.');
  }
}

function validateLeaseRecord(record: PersistentLeaseRecord, keyHash: string): void {
  if (
    record.schema !== LEASE_SCHEMA ||
    record.keyHash !== keyHash ||
    !/^(?:0|[1-9]\d*)$/u.test(record.fencingToken) ||
    typeof record.ownerId !== 'string' ||
    record.ownerId.length === 0 ||
    !Number.isSafeInteger(record.expiresAt) ||
    typeof record.released !== 'boolean'
  ) {
    throw new Error('Atomic File StateStore lease record is invalid.');
  }
}

function validateLockOwnerRecord(record: LockOwnerRecord, generation: number): void {
  if (
    record.schema !== LOCK_SCHEMA ||
    record.generation !== generation ||
    typeof record.token !== 'string' ||
    record.token.length === 0 ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0
  ) {
    throw new Error('Atomic File StateStore process lock metadata is invalid.');
  }
}

function validateLockReleaseRecord(record: LockReleaseRecord, token: string): void {
  if (
    record.schema !== LOCK_RELEASE_SCHEMA ||
    record.token !== token ||
    !Number.isSafeInteger(record.releasedAt) ||
    record.releasedAt < 0
  ) {
    throw new Error('Atomic File StateStore process lock release metadata is invalid.');
  }
}

async function immutableWrite(
  path: string,
  text: string,
  beforePublish?: () => void | Promise<void>,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', FILE_MODE);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await beforePublish?.();
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if ((await readFile(path, 'utf8').catch(() => undefined)) === text) return;
    throw error;
  }
}

async function atomicWriteJson(
  path: string,
  value: unknown,
  beforePublish?: () => void | Promise<void>,
): Promise<void> {
  const text = JSON.stringify(value);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', FILE_MODE);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await beforePublish?.();
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if ((await readFile(path, 'utf8').catch(() => undefined)) === text) return;
    throw error;
  }
}

async function createLockCandidate(path: string, owner: LockOwnerRecord): Promise<void> {
  await mkdir(path, { mode: ROOT_MODE });
  const ownerPath = resolve(path, 'owner.json');
  const handle = await open(ownerPath, 'wx', FILE_MODE);
  try {
    await handle.writeFile(JSON.stringify(owner), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path);
}

async function lockPathIsOwnedBy(path: string, token: string): Promise<boolean> {
  const owner = await readJsonIfExists<LockOwnerRecord>(resolve(path, 'owner.json')).catch(
    () => undefined,
  );
  return owner?.schema === LOCK_SCHEMA && owner.token === token;
}

async function lockGenerationExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Atomic File StateStore process lock generation is not a secure directory.');
    }
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (
      process.platform !== 'win32' ||
      !['EISDIR', 'EINVAL', 'EPERM', 'EACCES'].includes(code ?? '')
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function assertSecureDirectory(path: string, parent: string | undefined): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Atomic File StateStore directories cannot be symbolic links.');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('Atomic File StateStore directories must be owner-only on POSIX hosts.');
  }
  const actual = await realpath(path);
  if (parent !== undefined && !isWithin(actual, parent)) {
    throw new Error('Atomic File StateStore path escapes its configured root.');
  }
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error('Atomic File StateStore root cannot traverse a symbolic link.');
    }
  }
}

function assertLocalRootSyntax(path: string): void {
  if (/^(?:\\\\|\/\/|\\\\\?\\UNC\\)/iu.test(path)) {
    throw new TypeError('Atomic File StateStore does not support UNC or network roots.');
  }
}

async function assertVerifiedLocalFilesystem(
  verifier: LocalFilesystemVerifier,
  path: string,
): Promise<void> {
  if (typeof verifier !== 'object' || verifier === null || typeof verifier.verify !== 'function') {
    throw new TypeError('Atomic File StateStore filesystemVerifier must implement verify().');
  }
  let verification: Awaited<ReturnType<LocalFilesystemVerifier['verify']>>;
  try {
    verification = await verifier.verify(path);
  } catch (error) {
    throw new Error('Atomic File StateStore could not verify a local filesystem.', {
      cause: error,
    });
  }
  if (
    typeof verification !== 'object' ||
    verification === null ||
    !['local', 'network', 'unknown'].includes(verification.status) ||
    (verification.status === 'local' &&
      (typeof verification.filesystemType !== 'string' ||
        verification.filesystemType.length === 0)) ||
    (verification.status !== 'local' &&
      (typeof verification.reason !== 'string' || verification.reason.length === 0))
  ) {
    throw new Error('Atomic File StateStore filesystem verification result is invalid.');
  }
  if (verification.status !== 'local') {
    throw new Error(
      verification.status === 'network'
        ? 'Atomic File StateStore does not support network filesystems.'
        : 'Atomic File StateStore could not confirm that its root is on a local filesystem.',
    );
  }
}

function isWithin(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isChecksum(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH';
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
