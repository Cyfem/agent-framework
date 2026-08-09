import { createRequire, syncBuiltinESMExports } from 'node:module';

const requireModule = createRequire(import.meta.url);
const ownerKey = Symbol.for('maneeagent.worker-acceptance.network-deny.v1');
const marker = Object.freeze({ kind: 'worker-acceptance-network-deny', version: '1' });

if (globalThis[ownerKey] !== undefined) {
  throw new Error('The Worker acceptance network deny guard was installed more than once.');
}
globalThis[ownerKey] = marker;

const deny = (surface) => () => {
  const error = new Error(`Worker acceptance denied network access through ${surface}.`);
  error.code = 'NETWORK_ACCESS_DENIED';
  throw error;
};

patch(globalThis, 'fetch', 'fetch');
patchModule('node:http', ['request', 'get']);
patchModule('node:https', ['request', 'get']);
patchModule('node:net', ['connect', 'createConnection']);
patchModule('node:tls', ['connect']);
patchModule('node:dgram', ['createSocket']);
patchModule('node:dns', ['lookup', 'lookupService', 'resolve', 'reverse']);
const dns = requireModule('node:dns');
if (dns.promises !== undefined) {
  for (const key of ['lookup', 'lookupService', 'resolve', 'reverse']) {
    patch(dns.promises, key, `dns.promises.${key}`);
  }
}
syncBuiltinESMExports();

export function assertWorkerNetworkDenyInstalled() {
  if (globalThis[ownerKey] !== marker) {
    throw new Error('The Worker-local acceptance network deny guard is missing.');
  }
}

function patchModule(name, keys) {
  const module = requireModule(name);
  for (const key of keys) patch(module, key, `${name}.${key}`);
}

function patch(target, key, surface) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor !== undefined && typeof descriptor.value !== 'function') return;
  Object.defineProperty(target, key, {
    configurable: descriptor?.configurable ?? true,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    value: deny(surface),
  });
}
