import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
} from '@ruixutong.manee/maneeagent-framework';

describe('Process hostile packet preflight limits', () => {
  it('rejects frame, count, item, aggregate and packet estimates before any owned byte copy', async () => {
    vi.resetModules();
    const set = vi.spyOn(Uint8Array.prototype, 'set');
    const { decodeProcessPacket } = await import('../src/process-protocol');
    set.mockClear();
    try {
      expect(() =>
        decodeProcessPacket({
          frame: new Uint8Array(DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES + 1),
          sidecars: [],
        }),
      ).toThrow(/frame|limit/u);
      expect(set).not.toHaveBeenCalled();

      expect(() =>
        decodeProcessPacket({
          frame: new Uint8Array(0),
          sidecars: Array.from(
            { length: DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS + 1 },
            (_, index) => rawSidecar(`count-${index}`, new Uint8Array(0)),
          ),
        }),
      ).toThrow(/sidecar|many|limit/u);
      expect(set).not.toHaveBeenCalled();

      expect(() =>
        decodeProcessPacket({
          frame: new Uint8Array([1]),
          sidecars: [
            rawSidecar(
              'oversized-item',
              new Uint8Array(DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES + 1),
            ),
          ],
        }),
      ).toThrow(/sidecar|item|limit/u);
      expect(set).not.toHaveBeenCalled();

      const full = new Uint8Array(DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES);
      const trailing = new Uint8Array([1]);
      const fullSidecar = rawSidecar('aggregate-full', full);
      expect(() =>
        decodeProcessPacket({
          frame: new Uint8Array([1]),
          sidecars: [
            fullSidecar,
            fullSidecar,
            fullSidecar,
            fullSidecar,
            rawSidecar('aggregate-overflow', trailing),
          ],
        }),
      ).toThrow(/aggregate|sidecar|limit/u);
      expect(DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES).toBe(full.byteLength * 4);
      expect(set).not.toHaveBeenCalled();

      const descriptorOverflow = rawSidecar('descriptor-preflight', full);
      descriptorOverflow.descriptor.artifact.mediaType = `application/${'x'.repeat(5 * 1024 * 1024)}`;
      expect(() =>
        decodeProcessPacket({
          frame: new Uint8Array(DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES),
          sidecars: [
            descriptorOverflow,
            descriptorOverflow,
            descriptorOverflow,
            descriptorOverflow,
          ],
        }),
      ).toThrow(/mediaType|artifact|descriptor|invalid/u);
      expect(set).not.toHaveBeenCalled();
    } finally {
      set.mockRestore();
    }
  });
});

function rawSidecar(sidecarId: string, bytes: Uint8Array) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    descriptor: {
      version: '1',
      sidecarId,
      artifact: {
        version: '1',
        id: `artifact-${sidecarId}`,
        mediaType: 'application/octet-stream',
        size: bytes.byteLength,
        sha256,
      },
      byteLength: bytes.byteLength,
      sha256,
    },
    bytes,
  };
}
