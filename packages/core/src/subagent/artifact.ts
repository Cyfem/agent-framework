const ARTIFACT_REFERENCE_KEYS = Object.freeze([
  'version',
  'id',
  'mediaType',
  'size',
  'sha256',
] as const);

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface ArtifactReference {
  readonly version: '1';
  readonly id: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
}

/** Every artifact operation is bound to the owning root session and logical task. */
export interface ArtifactScope {
  readonly ownerSessionId: string;
  readonly taskId: string;
}

export interface ArtifactWriteRequest {
  readonly scope: ArtifactScope;
  readonly mediaType: string;
  readonly data: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface ArtifactReadResult {
  readonly reference: ArtifactReference;
  readonly data: Uint8Array;
}

export interface ArtifactLimits {
  readonly maxItemBytes: number;
  readonly maxItemsPerTask: number;
  readonly maxTotalBytesPerTask: number;
}

export const DEFAULT_ARTIFACT_LIMITS: Readonly<ArtifactLimits> = Object.freeze({
  maxItemBytes: 32 * 1024 * 1024,
  maxItemsPerTask: 8,
  maxTotalBytesPerTask: 128 * 1024 * 1024,
});

/** Owner-scoped artifact SPI. Implementations must never expose paths, URLs or credentials. */
export interface ArtifactStore {
  put(request: ArtifactWriteRequest): Promise<ArtifactReference>;
  get(
    scope: ArtifactScope,
    reference: ArtifactReference,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ArtifactReadResult>;
  delete(scope: ArtifactScope, reference: ArtifactReference): Promise<void>;
  deleteTaskArtifacts(scope: ArtifactScope): Promise<void>;
}

/** Validates the closed, URL-free wire representation of an artifact reference. */
export function assertArtifactReference(
  value: unknown,
  limits: ArtifactLimits = DEFAULT_ARTIFACT_LIMITS,
): asserts value is ArtifactReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Artifact reference must be an object.');
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== ARTIFACT_REFERENCE_KEYS.length ||
    keys.some((key) => !(ARTIFACT_REFERENCE_KEYS as readonly string[]).includes(key))
  ) {
    throw new TypeError('Artifact reference contains unsupported fields.');
  }
  if (record.version !== '1') {
    throw new TypeError('Artifact reference version must be "1".');
  }
  if (typeof record.id !== 'string' || !ARTIFACT_ID_PATTERN.test(record.id)) {
    throw new TypeError('Artifact reference id must be an opaque identifier.');
  }
  if (
    typeof record.mediaType !== 'string' ||
    record.mediaType.length > 255 ||
    !MEDIA_TYPE_PATTERN.test(record.mediaType)
  ) {
    throw new TypeError('Artifact reference mediaType is invalid.');
  }
  if (
    typeof record.size !== 'number' ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0 ||
    record.size > limits.maxItemBytes
  ) {
    throw new RangeError('Artifact reference size exceeds the configured item limit.');
  }
  if (typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)) {
    throw new TypeError('Artifact reference sha256 must be 64 lowercase hexadecimal characters.');
  }
}
