import { requireAllowedDataRecord, requireClosedDataRecord } from './http-internal';
import type { HttpSubAgentReplayCache, HttpSubAgentReplayInput } from './hmac';

const DEFAULT_MAX_ENTRIES = 10_000;
const HARD_MAX_ENTRIES = 100_000;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,86}$/u;

export interface MemoryHttpSubAgentReplayCacheOptions {
  /** This implementation is deliberately ineligible for production security mode. */
  readonly mode: 'loopback-test';
  readonly now?: () => number;
  readonly maxEntries?: number;
}

export interface MemoryHttpSubAgentReplayCacheDiagnostics {
  readonly entries: number;
  readonly capacity: number;
}

/** Bounded, process-local replay cache for explicit loopback tests only. */
export class MemoryHttpSubAgentReplayCache implements HttpSubAgentReplayCache {
  readonly mode = 'loopback-test' as const;
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, number>();

  constructor(options: MemoryHttpSubAgentReplayCacheOptions) {
    const record = requireAllowedDataRecord(
      options,
      ['mode', 'now', 'maxEntries'],
      'Memory HTTP replay cache options',
    );
    if (record.mode !== 'loopback-test') {
      throw new TypeError('Memory HTTP replay cache requires explicit loopback-test mode.');
    }
    const now = record.now ?? Date.now;
    if (typeof now !== 'function') {
      throw new TypeError('Memory HTTP replay cache now must be a function.');
    }
    const maxEntries = record.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (
      !Number.isSafeInteger(maxEntries) ||
      (maxEntries as number) < 1 ||
      (maxEntries as number) > HARD_MAX_ENTRIES
    ) {
      throw new RangeError('Memory HTTP replay cache capacity is invalid.');
    }
    this.#now = now as () => number;
    this.#maxEntries = maxEntries as number;
    Object.freeze(this);
  }

  consume(input: HttpSubAgentReplayInput): boolean {
    const record = requireClosedDataRecord(
      input,
      ['keyId', 'nonce', 'expiresAt'],
      'HTTP replay input',
    );
    if (typeof record.keyId !== 'string' || !KEY_ID_PATTERN.test(record.keyId)) {
      throw new TypeError('HTTP replay keyId is invalid.');
    }
    if (typeof record.nonce !== 'string' || !NONCE_PATTERN.test(record.nonce)) {
      throw new TypeError('HTTP replay nonce is invalid.');
    }
    if (!Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0) {
      throw new RangeError('HTTP replay expiresAt is invalid.');
    }
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('Memory HTTP replay cache clock is invalid.');
    }
    this.#purgeExpired(now);
    if ((record.expiresAt as number) <= now) return false;
    const identity = `${record.keyId}\u0000${record.nonce}`;
    if (this.#entries.has(identity)) return false;
    if (this.#entries.size >= this.#maxEntries) {
      throw new Error('Memory HTTP replay cache capacity is exhausted.');
    }
    this.#entries.set(identity, record.expiresAt as number);
    return true;
  }

  get diagnostics(): MemoryHttpSubAgentReplayCacheDiagnostics {
    return Object.freeze({ entries: this.#entries.size, capacity: this.#maxEntries });
  }

  #purgeExpired(now: number): void {
    for (const [identity, expiresAt] of this.#entries) {
      if (expiresAt <= now) this.#entries.delete(identity);
    }
  }
}
