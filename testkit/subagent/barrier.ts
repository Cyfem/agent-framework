import { Deferred } from './deferred';

export type BarrierState = 'pending' | 'released' | 'failed';

export class BarrierWaitAbortedError extends Error {
  readonly code = 'BARRIER_WAIT_ABORTED';

  constructor(cause?: unknown) {
    super('The barrier wait was aborted.', cause === undefined ? undefined : { cause });
    this.name = 'BarrierWaitAbortedError';
  }
}

/** A one-shot async gate. All current and future waiters observe the same settlement. */
export class Barrier {
  readonly #settlement = new Deferred<void>();
  #state: BarrierState = 'pending';

  get state(): BarrierState {
    return this.#state;
  }

  get settled(): boolean {
    return this.#state !== 'pending';
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new BarrierWaitAbortedError(signal.reason));
    }

    if (!signal) {
      return this.#settlement.promise;
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        reject(new BarrierWaitAbortedError(signal.reason));
      };
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      void this.#settlement.promise.then(
        () => {
          cleanup();
          resolve();
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  release(): boolean {
    if (this.#state !== 'pending') {
      return false;
    }

    this.#state = 'released';
    return this.#settlement.resolve(undefined);
  }

  fail(reason: unknown): boolean {
    if (this.#state !== 'pending') {
      return false;
    }

    this.#state = 'failed';
    return this.#settlement.reject(reason);
  }
}
