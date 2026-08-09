import { createHash } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import {
  createSubAgentTransportArtifactSidecar,
  type ArtifactReference,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

import {
  decodeWorkerBootstrapData,
  decodeWorkerMessage,
  decodeWorkerPacket,
  encodeWorkerPacket,
} from '../src/worker-protocol';

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function createPacket(): SubAgentTransportPeerPacket {
  const frame = new TextEncoder().encode('{"worker":"frame"}');
  const data = new TextEncoder().encode('worker-transferable-sidecar-proof');
  const artifact: ArtifactReference = {
    version: '1',
    id: 'worker-artifact-1',
    mediaType: 'application/octet-stream',
    size: data.byteLength,
    sha256: sha256(data),
  };
  return Object.freeze({
    frame,
    sidecars: Object.freeze([
      createSubAgentTransportArtifactSidecar({
        sidecarId: 'worker-sidecar-1',
        artifact,
        data,
      }),
    ]),
  });
}

describe('Worker packet and bootstrap closed boundaries', () => {
  acceptanceIt(
    'C7-WORKER-11.l2.transferable-owned-sidecar',
    'arraybuffer-transfer-and-owned-copy',
    () => {
      const source = createPacket();
      const sourceFrame = [...(source.frame as Uint8Array)];
      const sourceSidecar = [...source.sidecars[0]!.data];
      const encoded = encodeWorkerPacket(source);

      expect(encoded.transfer).toHaveLength(2);
      expect(encoded.packet.frame).toBeInstanceOf(ArrayBuffer);
      expect(encoded.packet.sidecars[0]?.bytes).toBeInstanceOf(ArrayBuffer);
      expect(encoded.packet.frame).not.toBe((source.frame as Uint8Array).buffer);
      expect(encoded.packet.sidecars[0]?.bytes).not.toBe(source.sidecars[0]!.data.buffer);

      const received = structuredClone(encoded.packet, {
        transfer: [...encoded.transfer],
      });
      for (const transferred of encoded.transfer) expect(transferred.byteLength).toBe(0);
      expect([...(source.frame as Uint8Array)]).toEqual(sourceFrame);
      expect([...source.sidecars[0]!.data]).toEqual(sourceSidecar);

      const decoded = decodeWorkerPacket(received);
      expect([...(decoded.frame as Uint8Array)]).toEqual(sourceFrame);
      expect([...decoded.sidecars[0]!.data]).toEqual(sourceSidecar);
      expect(decoded.sidecars[0]!.descriptor).toEqual(source.sidecars[0]!.descriptor);
    },
  );

  it('rejects hostile packet, message and bootstrap objects without invoking accessors', () => {
    expect(() => decodeWorkerPacket(new Proxy({ frame: 'x', sidecars: [] }, {}))).toThrow();
    expect(() =>
      decodeWorkerMessage(new Proxy({ version: '1', type: 'shutdown' }, {}), 'inbound'),
    ).toThrow();

    let getterCalls = 0;
    const packetAccessor = Object.defineProperties(
      {},
      {
        frame: {
          configurable: true,
          enumerable: true,
          get: () => {
            getterCalls += 1;
            throw new Error('Worker packet decoder must not run a frame getter.');
          },
        },
        sidecars: { configurable: true, enumerable: true, value: [] },
      },
    );
    expect(() => decodeWorkerPacket(packetAccessor)).toThrow();
    expect(getterCalls).toBe(0);

    const { port1, port2 } = new MessageChannel();
    try {
      const valid = {
        version: '1',
        jobId: 'worker-job-1',
        ownerSessionId: 'worker-session-1',
        executorName: 'worker',
        channelId: 'worker-channel-1',
        port: port1,
      };
      expect(decodeWorkerBootstrapData(valid)).toMatchObject({
        version: '1',
        jobId: 'worker-job-1',
      });
      expect(() => decodeWorkerBootstrapData(new Proxy(valid, {}))).toThrow();
      expect(() =>
        decodeWorkerBootstrapData(
          Object.assign(Object.create({ inherited: true }) as object, valid),
        ),
      ).toThrow();

      const hidden = { ...valid } as Record<PropertyKey, unknown>;
      Object.defineProperty(hidden, 'extra', {
        configurable: true,
        enumerable: false,
        value: 'not-closed',
      });
      expect(() => decodeWorkerBootstrapData(hidden)).toThrow();

      const symbolic = { ...valid } as Record<PropertyKey, unknown>;
      symbolic[Symbol('extra')] = 'not-closed';
      expect(() => decodeWorkerBootstrapData(symbolic)).toThrow();
    } finally {
      port1.close();
      port2.close();
    }
  });

  it('rejects extra fields, invalid directions and invalid job identifiers', () => {
    expect(() =>
      decodeWorkerMessage({ version: '1', type: 'shutdown', extra: true }, 'inbound'),
    ).toThrow(/unknown|missing/u);
    expect(() => decodeWorkerMessage({ version: '1', type: 'ready' }, 'inbound')).toThrow(
      /direction/u,
    );
    expect(() => decodeWorkerMessage({ version: '1', type: 'shutdown' }, 'outbound')).toThrow(
      /direction/u,
    );

    const { port1, port2 } = new MessageChannel();
    try {
      const base = {
        version: '1',
        ownerSessionId: 'worker-session-1',
        executorName: 'worker',
        channelId: 'worker-channel-1',
        port: port1,
      };
      for (const jobId of ['', '../worker', `a${'b'.repeat(128)}`, 'contains space']) {
        expect(() => decodeWorkerBootstrapData({ ...base, jobId })).toThrow(/jobId/u);
      }
    } finally {
      port1.close();
      port2.close();
    }
  });
});
