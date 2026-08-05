import { createRequire, syncBuiltinESMExports } from 'node:module';

type MutableModule = Record<PropertyKey, unknown>;

interface Patch {
  readonly target: MutableModule;
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor | undefined;
}

const requireModule = createRequire(import.meta.url);
const OWNER = Symbol.for('maneeagent.testkit.network-deny-owner.v1');

export class NetworkAccessDeniedError extends Error {
  readonly code = 'NETWORK_ACCESS_DENIED';
  readonly surface: string;

  constructor(surface: string) {
    super(`Network access through ${surface} is disabled for this test.`);
    this.name = 'NetworkAccessDeniedError';
    this.surface = surface;
  }
}

/** Installs a reversible process-wide deny guard. It is never enabled implicitly. */
export class NetworkDenyGuard {
  readonly #patches: Patch[] = [];
  #installed = false;

  get installed(): boolean {
    return this.#installed;
  }

  install(): this {
    if (this.#installed) {
      return this;
    }

    const globalRecord = globalThis as unknown as MutableModule;
    if (globalRecord[OWNER] !== undefined) {
      throw new Error('Another NetworkDenyGuard is already installed.');
    }
    globalRecord[OWNER] = this;
    this.#installed = true;

    try {
      this.#patch(globalRecord, 'fetch', 'fetch');
      this.#patchModule('node:http', ['request', 'get']);
      this.#patchModule('node:https', ['request', 'get']);
      this.#patchModule('node:net', ['connect', 'createConnection']);
      this.#patchModule('node:tls', ['connect']);
      this.#patchModule('node:dgram', ['createSocket']);
      this.#patchModule('node:dns', ['lookup', 'lookupService', 'resolve', 'reverse']);

      const dns = requireModule('node:dns') as MutableModule;
      const promises = dns.promises as MutableModule | undefined;
      if (promises) {
        for (const key of ['lookup', 'lookupService', 'resolve', 'reverse']) {
          this.#patch(promises, key, `dns.promises.${key}`);
        }
      }
      syncBuiltinESMExports();
      return this;
    } catch (error) {
      this.restore();
      throw error;
    }
  }

  restore(): boolean {
    if (!this.#installed) {
      return false;
    }

    for (const patch of this.#patches.reverse()) {
      if (patch.descriptor) {
        Object.defineProperty(patch.target, patch.key, patch.descriptor);
      } else {
        Reflect.deleteProperty(patch.target, patch.key);
      }
    }
    this.#patches.length = 0;

    const globalRecord = globalThis as unknown as MutableModule;
    if (globalRecord[OWNER] === this) {
      Reflect.deleteProperty(globalRecord, OWNER);
    }
    this.#installed = false;
    syncBuiltinESMExports();
    return true;
  }

  #patchModule(moduleName: string, keys: readonly string[]): void {
    const module = requireModule(moduleName) as MutableModule;
    for (const key of keys) {
      this.#patch(module, key, `${moduleName}.${key}`);
    }
  }

  #patch(target: MutableModule, key: PropertyKey, surface: string): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor && typeof descriptor.value !== 'function') {
      return;
    }

    this.#patches.push({ target, key, descriptor });
    Object.defineProperty(target, key, {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value: (): never => {
        throw new NetworkAccessDeniedError(surface);
      },
    });
  }
}
