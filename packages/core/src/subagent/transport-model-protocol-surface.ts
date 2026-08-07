const AUDITED_PROTOCOL_SURFACES = new WeakSet<object>();

/** @internal Only credential-free protocol implementations shipped by Core may call this. */
export function markAuditedSubAgentTransportModelProtocolSurface<T extends object>(surface: T): T {
  if (!Object.isFrozen(surface)) {
    throw new TypeError('An audited transport Model protocol surface must be frozen.');
  }
  if ('generate' in surface) {
    throw new TypeError('An audited transport Model protocol surface cannot expose generate().');
  }
  AUDITED_PROTOCOL_SURFACES.add(surface);
  return surface;
}

/** @internal Runtime capability check used by the target-side Model proxy boundary. */
export function isAuditedSubAgentTransportModelProtocolSurface(value: unknown): value is object {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    AUDITED_PROTOCOL_SURFACES.has(value as object)
  );
}
