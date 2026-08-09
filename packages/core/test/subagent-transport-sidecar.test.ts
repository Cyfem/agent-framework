import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { acceptanceIt } from '../../../testkit';

import type { ArtifactReference } from '../src/subagent/artifact';
import {
  DEFAULT_SUBAGENT_TRANSPORT_ARTIFACT_SIDECAR_BYTES,
  assertSubAgentTransportArtifactSidecarDescriptor,
  createSubAgentTransportArtifactSidecar,
  decodeSubAgentTransportArtifactSidecar,
  type SubAgentTransportArtifactSidecarDescriptor,
} from '../src/subagent/transport-sidecar';

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function createFixture(data = new TextEncoder().encode('artifact-sidecar-proof')): {
  artifact: ArtifactReference;
  data: Uint8Array;
  descriptor: SubAgentTransportArtifactSidecarDescriptor;
} {
  const digest = sha256(data);
  const artifact: ArtifactReference = {
    version: '1',
    id: 'artifact-1',
    mediaType: 'application/octet-stream',
    size: data.byteLength,
    sha256: digest,
  };
  return {
    artifact,
    data,
    descriptor: {
      version: '1',
      sidecarId: 'sidecar-1',
      artifact,
      byteLength: data.byteLength,
      sha256: digest,
    },
  };
}

describe('Subagent transport artifact sidecars', () => {
  acceptanceIt('C7-TRANSPORT-07.l1.artifact-sidecar', 'artifact-sidecar', () => {
    const fixture = createFixture();
    const accepted = createSubAgentTransportArtifactSidecar({
      sidecarId: fixture.descriptor.sidecarId,
      artifact: fixture.artifact,
      data: fixture.data,
    });

    expect(accepted.descriptor).toEqual(fixture.descriptor);
    expect(accepted.data).not.toBe(fixture.data);
    expect(Object.isFrozen(accepted.descriptor)).toBe(true);
    expect(() =>
      assertSubAgentTransportArtifactSidecarDescriptor({
        ...fixture.descriptor,
        bytes: 'must-remain-out-of-band',
      }),
    ).toThrow(/unsupported or missing fields/u);

    const corrupt = fixture.data.slice();
    corrupt[0] = corrupt[0]! ^ 0xff;
    expect(() => decodeSubAgentTransportArtifactSidecar(fixture.descriptor, corrupt)).toThrow(
      /sha256 does not match/u,
    );
    expect(() =>
      decodeSubAgentTransportArtifactSidecar(fixture.descriptor, fixture.data, {
        maxBytes: fixture.data.byteLength - 1,
      }),
    ).toThrow(/configured item limit/u);
  });

  it('creates a closed descriptor and owns independent artifact and byte copies', () => {
    const fixture = createFixture();
    const originalFirstByte = fixture.data[0]!;
    const sidecar = createSubAgentTransportArtifactSidecar({
      sidecarId: 'sidecar-1',
      artifact: fixture.artifact,
      data: fixture.data,
    });

    expect(DEFAULT_SUBAGENT_TRANSPORT_ARTIFACT_SIDECAR_BYTES).toBe(32 * 1024 * 1024);
    expect(sidecar.descriptor).toEqual(fixture.descriptor);
    expect(sidecar.descriptor).not.toBe(fixture.descriptor);
    expect(sidecar.descriptor.artifact).not.toBe(fixture.artifact);
    expect(sidecar.data).not.toBe(fixture.data);
    expect(sidecar.data).toEqual(fixture.data);
    expect(Object.isFrozen(sidecar)).toBe(true);
    expect(Object.isFrozen(sidecar.descriptor)).toBe(true);
    expect(Object.isFrozen(sidecar.descriptor.artifact)).toBe(true);

    fixture.data[0] = originalFirstByte ^ 0xff;
    (fixture.artifact as { id: string }).id = 'mutated-artifact';
    expect(sidecar.data[0]).toBe(originalFirstByte);
    expect(sidecar.descriptor.artifact.id).toBe('artifact-1');
    expect(Object.keys(sidecar.descriptor).sort()).toEqual(
      ['artifact', 'byteLength', 'sha256', 'sidecarId', 'version'].sort(),
    );
    expect('data' in sidecar.descriptor).toBe(false);
  });

  it('decodes Uint8Array views and ArrayBuffers without retaining aliases', () => {
    const fixture = createFixture();
    const backing = new Uint8Array(fixture.data.byteLength + 4);
    backing.set(fixture.data, 2);
    const view = backing.subarray(2, 2 + fixture.data.byteLength);
    const fromView = decodeSubAgentTransportArtifactSidecar(fixture.descriptor, view);
    const sourceBuffer = fixture.data.slice().buffer;
    const fromArrayBuffer = decodeSubAgentTransportArtifactSidecar(
      fixture.descriptor,
      sourceBuffer,
    );

    expect(fromView.data).toEqual(fixture.data);
    expect(fromArrayBuffer.data).toEqual(fixture.data);
    backing.fill(0);
    new Uint8Array(sourceBuffer).fill(0);
    expect(fromView.data).toEqual(fixture.data);
    expect(fromArrayBuffer.data).toEqual(fixture.data);

    class HostileView extends Uint8Array {
      override get byteLength(): number {
        throw new Error('shadowed byteLength must not run');
      }

      override get byteOffset(): number {
        throw new Error('shadowed byteOffset must not run');
      }

      override get buffer(): ArrayBuffer {
        throw new Error('shadowed buffer must not run');
      }

      override [Symbol.iterator](): ArrayIterator<number> {
        throw new Error('subclass iterator must not run');
      }
    }
    const hostileView = new HostileView(fixture.data);
    const fromHostileView = decodeSubAgentTransportArtifactSidecar(fixture.descriptor, hostileView);
    hostileView.fill(0);
    expect(fromHostileView.data).toEqual(fixture.data);
  });

  it('uses ArrayBuffer internal slots without slice/species hooks and rejects byte Proxies', () => {
    const fixture = createFixture();
    let speciesReads = 0;
    class HostileArrayBuffer extends ArrayBuffer {
      static get [Symbol.species](): ArrayBufferConstructor {
        speciesReads += 1;
        return ArrayBuffer;
      }
    }
    const source = new HostileArrayBuffer(fixture.data.byteLength);
    new Uint8Array(source).set(fixture.data);
    Object.defineProperties(source, {
      byteLength: {
        configurable: true,
        get: () => {
          throw new Error('shadowed byteLength must not run');
        },
      },
      slice: {
        configurable: true,
        value: () => {
          throw new Error('shadowed slice must not run');
        },
      },
    });

    const accepted = decodeSubAgentTransportArtifactSidecar(fixture.descriptor, source);
    new Uint8Array(source).fill(0);
    expect(accepted.data).toEqual(fixture.data);
    expect(speciesReads).toBe(0);

    expect(() =>
      decodeSubAgentTransportArtifactSidecar(
        fixture.descriptor,
        new Proxy(fixture.data.slice().buffer, {}),
      ),
    ).toThrow(/must not be a Proxy/u);
    expect(() =>
      decodeSubAgentTransportArtifactSidecar(
        fixture.descriptor,
        new Proxy(fixture.data.slice(), {}),
      ),
    ).toThrow(/must not be a Proxy/u);
  });

  it('uses intrinsic byte brands without consulting hostile prototype chains', () => {
    const fixture = createFixture();
    let prototypeTraps = 0;
    const hostilePrototype = (prototype: object): object =>
      new Proxy(prototype, {
        getPrototypeOf() {
          prototypeTraps += 1;
          throw new Error('byte prototype trap must not run');
        },
      });

    const view = fixture.data.slice();
    Object.setPrototypeOf(view, hostilePrototype(Uint8Array.prototype));
    expect(decodeSubAgentTransportArtifactSidecar(fixture.descriptor, view).data).toEqual(
      fixture.data,
    );

    const buffer = fixture.data.slice().buffer;
    Object.setPrototypeOf(buffer, hostilePrototype(ArrayBuffer.prototype));
    expect(decodeSubAgentTransportArtifactSidecar(fixture.descriptor, buffer).data).toEqual(
      fixture.data,
    );
    expect(prototypeTraps).toBe(0);
  });

  it('rejects non-closed descriptors, invalid opaque IDs, media types and hashes', () => {
    const fixture = createFixture();

    expect(() =>
      assertSubAgentTransportArtifactSidecarDescriptor({
        ...fixture.descriptor,
        bytes: 'base64-is-not-allowed',
      }),
    ).toThrow(/unsupported or missing fields/u);
    expect(() =>
      assertSubAgentTransportArtifactSidecarDescriptor({
        ...fixture.descriptor,
        sidecarId: '../sidecar',
      }),
    ).toThrow(/opaque identifier/u);
    expect(() =>
      assertSubAgentTransportArtifactSidecarDescriptor({
        ...fixture.descriptor,
        artifact: { ...fixture.artifact, mediaType: 'not-a-media-type' },
      }),
    ).toThrow(/mediaType/u);
    expect(() =>
      assertSubAgentTransportArtifactSidecarDescriptor({
        ...fixture.descriptor,
        sha256: fixture.descriptor.sha256.toUpperCase(),
      }),
    ).toThrow(/lowercase hexadecimal/u);
    expect(() =>
      assertSubAgentTransportArtifactSidecarDescriptor({
        ...fixture.descriptor,
        artifact: { ...fixture.artifact, extra: true },
      }),
    ).toThrow(/unsupported.*fields/u);

    const accessor = Object.defineProperty({ ...fixture.descriptor }, 'sha256', {
      get: () => fixture.descriptor.sha256,
      enumerable: true,
    });
    expect(() => assertSubAgentTransportArtifactSidecarDescriptor(accessor)).toThrow(
      /enumerable data properties/u,
    );
    expect(() =>
      assertSubAgentTransportArtifactSidecarDescriptor(new Proxy(fixture.descriptor, {})),
    ).toThrow(/must not be a Proxy/u);
  });

  it('rejects descriptor, artifact and actual byte length or digest mismatches', () => {
    const fixture = createFixture();
    const otherData = fixture.data.slice();
    otherData[0] = otherData[0]! ^ 0xff;

    expect(() =>
      decodeSubAgentTransportArtifactSidecar(
        { ...fixture.descriptor, byteLength: fixture.descriptor.byteLength - 1 },
        fixture.data,
      ),
    ).toThrow(/does not match artifact size/u);
    expect(() =>
      decodeSubAgentTransportArtifactSidecar(
        {
          ...fixture.descriptor,
          artifact: { ...fixture.artifact, size: fixture.artifact.size - 1 },
        },
        fixture.data,
      ),
    ).toThrow(/does not match artifact size/u);
    expect(() =>
      decodeSubAgentTransportArtifactSidecar(fixture.descriptor, fixture.data.subarray(1)),
    ).toThrow(/length does not match/u);
    expect(() => decodeSubAgentTransportArtifactSidecar(fixture.descriptor, otherData)).toThrow(
      /sha256 does not match/u,
    );
    expect(() =>
      decodeSubAgentTransportArtifactSidecar(
        {
          ...fixture.descriptor,
          sha256: '0'.repeat(64),
        },
        fixture.data,
      ),
    ).toThrow(/does not match artifact sha256/u);
  });

  it('enforces configured limits and accepts only Uint8Array or ArrayBuffer bytes', () => {
    const fixture = createFixture(new Uint8Array([1, 2, 3, 4]));

    expect(() =>
      createSubAgentTransportArtifactSidecar(
        { sidecarId: 'sidecar-limit', artifact: fixture.artifact, data: fixture.data },
        { maxBytes: 3 },
      ),
    ).toThrow(/configured item limit/u);
    expect(() =>
      decodeSubAgentTransportArtifactSidecar(
        fixture.descriptor,
        new DataView(fixture.data.buffer) as unknown as Uint8Array,
      ),
    ).toThrow(/Uint8Array or ArrayBuffer/u);
    expect(() =>
      decodeSubAgentTransportArtifactSidecar(fixture.descriptor, fixture.data, { maxBytes: 0 }),
    ).toThrow(/positive safe integer/u);
  });
});
