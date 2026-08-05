export type FaultAction = Error | (() => void | Promise<void>);

export class InjectedFaultError extends Error {
  readonly code = 'INJECTED_TEST_FAULT';
  readonly failpoint: string;

  constructor(failpoint: string) {
    super(`Injected test fault at failpoint "${failpoint}".`);
    this.name = 'InjectedFaultError';
    this.failpoint = failpoint;
  }
}

const FAILPOINT_NAME = /^[a-z][a-z0-9._:-]*$/iu;

function assertFailpointName(name: string): void {
  if (!FAILPOINT_NAME.test(name)) {
    throw new TypeError('Failpoint names must be non-empty portable identifiers.');
  }
}

/** Explicit, one-shot failpoints for crash and recovery tests. */
export class FaultInjector {
  readonly #actions = new Map<string, FaultAction>();

  arm(name: string, action?: FaultAction): this {
    assertFailpointName(name);
    if (this.#actions.has(name)) {
      throw new Error(`Failpoint "${name}" is already armed.`);
    }

    this.#actions.set(name, action ?? new InjectedFaultError(name));
    return this;
  }

  isArmed(name: string): boolean {
    assertFailpointName(name);
    return this.#actions.has(name);
  }

  disarm(name: string): boolean {
    assertFailpointName(name);
    return this.#actions.delete(name);
  }

  clear(): void {
    this.#actions.clear();
  }

  async hit(name: string): Promise<boolean> {
    assertFailpointName(name);
    const action = this.#actions.get(name);
    if (!action) {
      return false;
    }

    this.#actions.delete(name);
    if (action instanceof Error) {
      throw action;
    }

    await action();
    return true;
  }
}
