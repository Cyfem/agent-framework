import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import {
  DEFAULT_ARTIFACT_LIMITS,
  assertArtifactReference,
  type ArtifactLimits,
  type ArtifactReference,
} from './artifact';

/** Wire version for artifact byte sidecars shared by every Subagent transport. */
export const SUBAGENT_TRANSPORT_ARTIFACT_SIDECAR_VERSION = '1' as const;

/** Default maximum size of one artifact sidecar. */
export const DEFAULT_SUBAGENT_TRANSPORT_ARTIFACT_SIDECAR_BYTES = 32 * 1024 * 1024;

const SIDECAR_DESCRIPTOR_KEYS = Object.freeze([
  'version',
  'sidecarId',
  'artifact',
  'byteLength',
  'sha256',
] as const);
const ARTIFACT_REFERENCE_KEYS = Object.freeze([
  'version',
  'id',
  'mediaType',
  'size',
  'sha256',
] as const);
const OPAQUE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get as (this: ArrayBuffer) => number;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer')
  ?.get as (this: Uint8Array) => ArrayBufferLike;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteOffset',
)?.get as (this: Uint8Array) => number;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get as (this: Uint8Array) => number;

/** Closed JSON descriptor. Artifact bytes are always carried out of band. */
export interface SubAgentTransportArtifactSidecarDescriptor {
  readonly version: typeof SUBAGENT_TRANSPORT_ARTIFACT_SIDECAR_VERSION;
  readonly sidecarId: string;
  readonly artifact: ArtifactReference;
  readonly byteLength: number;
  readonly sha256: string;
}

/** Validated sidecar with an owned byte copy. */
export interface SubAgentTransportArtifactSidecar {
  readonly descriptor: SubAgentTransportArtifactSidecarDescriptor;
  readonly data: Uint8Array;
}

export interface SubAgentTransportArtifactSidecarOptions {
  /** Defaults to 32 MiB. Both the descriptor and actual byte payload are bounded. */
  readonly maxBytes?: number;
}

export interface CreateSubAgentTransportArtifactSidecarRequest {
  readonly sidecarId: string;
  readonly artifact: ArtifactReference;
  readonly data: Uint8Array | ArrayBuffer;
}

/** Strictly validates the JSON-only sidecar descriptor without accepting byte content in it. */
export function assertSubAgentTransportArtifactSidecarDescriptor(
  value: unknown,
  options: SubAgentTransportArtifactSidecarOptions = {},
): asserts value is SubAgentTransportArtifactSidecarDescriptor {
  const maxBytes = resolveMaxBytes(options);
  const record = assertClosedObject(value, SIDECAR_DESCRIPTOR_KEYS, 'Artifact sidecar descriptor');

  if (record.version !== SUBAGENT_TRANSPORT_ARTIFACT_SIDECAR_VERSION) {
    throw new TypeError('Artifact sidecar descriptor version must be "1".');
  }
  assertOpaqueIdentifier(record.sidecarId, 'Artifact sidecar descriptor sidecarId');

  const artifactLimits: ArtifactLimits = {
    ...DEFAULT_ARTIFACT_LIMITS,
    maxItemBytes: maxBytes,
  };
  assertClosedObject(record.artifact, ARTIFACT_REFERENCE_KEYS, 'Artifact sidecar reference');
  assertArtifactReference(record.artifact, artifactLimits);

  if (
    typeof record.byteLength !== 'number' ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength < 0 ||
    record.byteLength > maxBytes
  ) {
    throw new RangeError('Artifact sidecar descriptor byteLength exceeds the configured limit.');
  }
  if (typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)) {
    throw new TypeError(
      'Artifact sidecar descriptor sha256 must be 64 lowercase hexadecimal characters.',
    );
  }
  if (record.artifact.size !== record.byteLength) {
    throw new TypeError('Artifact sidecar descriptor byteLength does not match artifact size.');
  }
  if (record.artifact.sha256 !== record.sha256) {
    throw new TypeError('Artifact sidecar descriptor sha256 does not match artifact sha256.');
  }
}

/**
 * Creates a descriptor from a validated ArtifactReference and returns an owned copy of the bytes.
 * Raw bytes never enter the JSON descriptor.
 */
export function createSubAgentTransportArtifactSidecar(
  request: CreateSubAgentTransportArtifactSidecarRequest,
  options: SubAgentTransportArtifactSidecarOptions = {},
): SubAgentTransportArtifactSidecar {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new TypeError('Artifact sidecar creation request must be an object.');
  }
  assertOpaqueIdentifier(request.sidecarId, 'Artifact sidecar sidecarId');

  const maxBytes = resolveMaxBytes(options);
  assertArtifactReference(request.artifact, {
    ...DEFAULT_ARTIFACT_LIMITS,
    maxItemBytes: maxBytes,
  });

  return decodeSubAgentTransportArtifactSidecar(
    {
      version: SUBAGENT_TRANSPORT_ARTIFACT_SIDECAR_VERSION,
      sidecarId: request.sidecarId,
      artifact: request.artifact,
      byteLength: request.artifact.size,
      sha256: request.artifact.sha256,
    },
    request.data,
    options,
  );
}

/**
 * Decodes an untrusted descriptor plus out-of-band bytes. Uint8Array views and ArrayBuffers are
 * copied before length and digest verification so callers cannot mutate the accepted payload.
 */
export function decodeSubAgentTransportArtifactSidecar(
  descriptor: unknown,
  data: Uint8Array | ArrayBuffer,
  options: SubAgentTransportArtifactSidecarOptions = {},
): SubAgentTransportArtifactSidecar {
  const maxBytes = resolveMaxBytes(options);
  assertSubAgentTransportArtifactSidecarDescriptor(descriptor, { maxBytes });

  const copiedData = copySidecarBytes(data);
  if (copiedData.byteLength > maxBytes) {
    throw new RangeError('Artifact sidecar byte payload exceeds the configured limit.');
  }
  if (copiedData.byteLength !== descriptor.byteLength) {
    throw new TypeError(
      'Artifact sidecar byte payload length does not match descriptor byteLength.',
    );
  }
  if (copiedData.byteLength !== descriptor.artifact.size) {
    throw new TypeError('Artifact sidecar byte payload length does not match artifact size.');
  }

  const actualSha256 = createHash('sha256').update(copiedData).digest('hex');
  if (actualSha256 !== descriptor.sha256 || actualSha256 !== descriptor.artifact.sha256) {
    throw new TypeError('Artifact sidecar byte payload sha256 does not match its descriptor.');
  }

  const artifact = Object.freeze({
    version: descriptor.artifact.version,
    id: descriptor.artifact.id,
    mediaType: descriptor.artifact.mediaType,
    size: descriptor.artifact.size,
    sha256: descriptor.artifact.sha256,
  }) satisfies ArtifactReference;
  const ownedDescriptor = Object.freeze({
    version: descriptor.version,
    sidecarId: descriptor.sidecarId,
    artifact,
    byteLength: descriptor.byteLength,
    sha256: descriptor.sha256,
  }) satisfies SubAgentTransportArtifactSidecarDescriptor;

  return Object.freeze({ descriptor: ownedDescriptor, data: copiedData });
}

function assertClosedObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  if (nodeTypes.isProxy(value)) {
    throw new TypeError(`${label} must not be a Proxy.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain JSON object.`);
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new TypeError(`${label} contains unsupported or missing fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must contain only enumerable data properties.`);
    }
  }
  return value as Record<string, unknown>;
}

function assertOpaqueIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !OPAQUE_IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${label} must be an opaque identifier.`);
  }
}

function resolveMaxBytes(options: SubAgentTransportArtifactSidecarOptions): number {
  const maxBytes = options.maxBytes ?? DEFAULT_SUBAGENT_TRANSPORT_ARTIFACT_SIDECAR_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('Artifact sidecar maxBytes must be a positive safe integer.');
  }
  return maxBytes;
}

function copySidecarBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  if (nodeTypes.isProxy(value)) {
    throw new TypeError('Artifact sidecar byte payload must not be a Proxy.');
  }
  if (value instanceof Uint8Array) {
    // A length-tracking view over a growable SharedArrayBuffer can change size while another
    // worker is running. Pin the first observed length before copying so descriptor validation and
    // packet accounting always refer to one owned snapshot rather than a later, larger view.
    const observedByteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
    const byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, value, []);
    const fixedLengthView = new Uint8Array(buffer, byteOffset, observedByteLength);
    const owned = new Uint8Array(observedByteLength);
    owned.set(fixedLengthView);
    return owned;
  }
  if (value instanceof ArrayBuffer) {
    // Avoid ArrayBuffer#slice because a subclass can redirect it through Symbol.species and retain
    // the alleged copy. A plain view plus a plain owned destination has no species or iterator hook.
    const observedByteLength = Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, value, []);
    const fixedLengthView = new Uint8Array(value, 0, observedByteLength);
    const owned = new Uint8Array(observedByteLength);
    owned.set(fixedLengthView);
    return owned;
  }
  throw new TypeError('Artifact sidecar byte payload must be a Uint8Array or ArrayBuffer.');
}
