const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A scoped signal that combines an optional caller signal with an absolute deadline. */
export interface AbortScope {
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Build an AbortError without depending on a browser-only DOMException implementation. */
export function createAbortError(message = 'The operation was aborted.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Build the stable timeout reason used when an absolute deadline is reached. */
export function createDeadlineExceededError(): Error {
  const error = new Error('The operation deadline was exceeded.');
  error.name = 'TimeoutError';
  return error;
}

/** Validate an absolute Unix-epoch deadline in milliseconds. */
export function assertValidDeadline(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || deadlineAt < 0)) {
    throw new TypeError('deadlineAt must be a finite non-negative number.');
  }
}

/** Throw the caller's abort reason, or a stable fallback when the platform omitted one. */
export function throwIfAborted(signal?: AbortSignal, deadlineAt?: number): void {
  assertValidDeadline(deadlineAt);

  if (signal?.aborted) {
    throw signal.reason ?? createAbortError();
  }

  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw createDeadlineExceededError();
  }
}

/** Whether an exception represents cancellation rather than a recoverable provider failure. */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }

  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Race cooperative asynchronous work with a signal.
 *
 * The source promise keeps a rejection handler after cancellation, so an implementation that
 * ignores its signal cannot create an unhandled rejection after the caller has already stopped.
 */
export function awaitWithAbort<T>(value: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const source = Promise.resolve(value);

  if (!signal) {
    return source;
  }

  if (signal.aborted) {
    void source.catch(() => undefined);
    return Promise.reject(signal.reason ?? createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? createAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    source.then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Create one reusable signal for an Agent run or a standalone Tool execution. */
export function createAbortScope(parentSignal?: AbortSignal, deadlineAt?: number): AbortScope {
  assertValidDeadline(deadlineAt);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason ?? createAbortError());
    }
  };

  const armDeadline = () => {
    if (disposed || deadlineAt === undefined || controller.signal.aborted) {
      return;
    }

    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      controller.abort(createDeadlineExceededError());
      return;
    }

    timer = setTimeout(armDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS));
    const unref = (timer as unknown as { unref?: () => void }).unref;
    unref?.call(timer);
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }
  armDeadline();

  return {
    signal: controller.signal,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}
