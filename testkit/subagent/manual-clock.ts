import { Deferred } from './deferred';

interface ClockWaiter {
  readonly deadline: number;
  readonly deferred: Deferred<void>;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

export class ManualClockWaitAbortedError extends Error {
  readonly code = 'MANUAL_CLOCK_WAIT_ABORTED';

  constructor(cause?: unknown) {
    super('The manual clock wait was aborted.', cause === undefined ? undefined : { cause });
    this.name = 'ManualClockWaitAbortedError';
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

/** Logical millisecond clock. Advancing it never waits on wall-clock time. */
export class ManualClock {
  #current: number;
  readonly #waiters = new Set<ClockWaiter>();

  constructor(initialTimestamp = 0) {
    assertTimestamp(initialTimestamp, 'initialTimestamp');
    this.#current = initialTimestamp;
  }

  /** Arrow form is intentional so it can be passed directly as a Clock dependency. */
  readonly now = (): number => this.#current;

  get pendingWaitCount(): number {
    return this.#waiters.size;
  }

  date(): Date {
    return new Date(this.#current);
  }

  advanceBy(milliseconds: number): number {
    assertTimestamp(milliseconds, 'milliseconds');
    return this.advanceTo(this.#current + milliseconds);
  }

  advanceTo(timestamp: number): number {
    assertTimestamp(timestamp, 'timestamp');
    if (timestamp < this.#current) {
      throw new RangeError('ManualClock cannot move backwards.');
    }

    this.#current = timestamp;
    this.#releaseDueWaiters();
    return this.#current;
  }

  waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
    assertTimestamp(milliseconds, 'milliseconds');
    return this.waitUntil(this.#current + milliseconds, signal);
  }

  waitUntil(timestamp: number, signal?: AbortSignal): Promise<void> {
    assertTimestamp(timestamp, 'timestamp');
    if (signal?.aborted) {
      return Promise.reject(new ManualClockWaitAbortedError(signal.reason));
    }
    if (timestamp <= this.#current) {
      return Promise.resolve();
    }

    const deferred = new Deferred<void>();
    const waiter: ClockWaiter = {
      deadline: timestamp,
      deferred,
      ...(signal ? { signal } : {}),
      ...(signal
        ? {
            onAbort: () => {
              this.#removeWaiter(waiter);
              deferred.reject(new ManualClockWaitAbortedError(signal.reason));
            },
          }
        : {}),
    };

    if (signal && waiter.onAbort) {
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    this.#waiters.add(waiter);
    return deferred.promise;
  }

  #releaseDueWaiters(): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.deadline <= this.#current) {
        this.#removeWaiter(waiter);
        waiter.deferred.resolve(undefined);
      }
    }
  }

  #removeWaiter(waiter: ClockWaiter): void {
    this.#waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }
}
