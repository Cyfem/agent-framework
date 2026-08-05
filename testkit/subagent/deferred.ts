export type DeferredState = 'pending' | 'resolved' | 'rejected';

/** A small, observable promise controller for deterministic test coordination. */
export class Deferred<T> {
  readonly promise: Promise<T>;

  #resolvePromise!: (value: T | PromiseLike<T>) => void;
  #rejectPromise!: (reason?: unknown) => void;
  #state: DeferredState = 'pending';

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolvePromise = resolve;
      this.#rejectPromise = reject;
    });
  }

  get state(): DeferredState {
    return this.#state;
  }

  get settled(): boolean {
    return this.#state !== 'pending';
  }

  resolve(value: T | PromiseLike<T>): boolean {
    if (this.#state !== 'pending') {
      return false;
    }

    this.#state = 'resolved';
    this.#resolvePromise(value);
    return true;
  }

  reject(reason?: unknown): boolean {
    if (this.#state !== 'pending') {
      return false;
    }

    this.#state = 'rejected';
    this.#rejectPromise(reason);
    return true;
  }
}
