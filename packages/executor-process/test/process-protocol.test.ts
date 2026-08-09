import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import {
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_CACHED_BYTES,
  createSubAgentTransportArtifactSidecar,
  type ArtifactReference,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

import {
  decodeProcessBootstrapData,
  decodeProcessMessage,
  decodeProcessPacket,
  encodeProcessPacket,
  createProcessSubAgentIpcWriter,
  type ProcessSubAgentChannelMessage,
} from '../src/process-protocol';

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function createPacket(): SubAgentTransportPeerPacket {
  const frame = new TextEncoder().encode('{"process":"frame"}');
  const data = new TextEncoder().encode('process-advanced-clone-sidecar-proof');
  const artifact: ArtifactReference = {
    version: '1',
    id: 'process-artifact-1',
    mediaType: 'application/octet-stream',
    size: data.byteLength,
    sha256: sha256(data),
  };
  return Object.freeze({
    frame,
    sidecars: Object.freeze([
      createSubAgentTransportArtifactSidecar({
        sidecarId: 'process-sidecar-1',
        artifact,
        data,
      }),
    ]),
  });
}

describe('Process packet, message and bootstrap closed boundaries', () => {
  acceptanceIt(
    'C7-PROCESS-11.l2.advanced-clone-owned-sidecar',
    'typed-array-clone-and-owned-copy',
    () => {
      const source = createPacket();
      const sourceFrame = [...(source.frame as Uint8Array)];
      const sourceSidecar = [...source.sidecars[0]!.data];
      const encoded = encodeProcessPacket(source);

      expect(encoded.frame).toBeInstanceOf(Uint8Array);
      expect(encoded.sidecars[0]?.bytes).toBeInstanceOf(Uint8Array);
      expect(encoded.frame).not.toBe(source.frame);
      expect(encoded.sidecars[0]?.bytes).not.toBe(source.sidecars[0]!.data);

      // child_process `serialization: "advanced"` clones typed arrays; it has no transfer list.
      const received = structuredClone(encoded);
      expect([...(source.frame as Uint8Array)]).toEqual(sourceFrame);
      expect([...source.sidecars[0]!.data]).toEqual(sourceSidecar);

      const decoded = decodeProcessPacket(received);
      expect([...(decoded.frame as Uint8Array)]).toEqual(sourceFrame);
      expect([...decoded.sidecars[0]!.data]).toEqual(sourceSidecar);
      expect(decoded.sidecars[0]!.descriptor).toEqual(source.sidecars[0]!.descriptor);

      (received.frame as Uint8Array)[0] = 0;
      received.sidecars[0]!.bytes[0] = 0;
      expect([...(source.frame as Uint8Array)]).toEqual(sourceFrame);
      expect([...source.sidecars[0]!.data]).toEqual(sourceSidecar);
      expect([...(decoded.frame as Uint8Array)]).toEqual(sourceFrame);
      expect([...decoded.sidecars[0]!.data]).toEqual(sourceSidecar);
    },
  );

  it('rejects hostile packet, message and bootstrap objects without invoking accessors', () => {
    expect(() => decodeProcessPacket(new Proxy({ frame: 'x', sidecars: [] }, {}))).toThrow();
    expect(() =>
      decodeProcessMessage(new Proxy({ version: '1', type: 'shutdown' }, {}), 'inbound'),
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
            throw new Error('Process packet decoder must not run a frame getter.');
          },
        },
        sidecars: { configurable: true, enumerable: true, value: [] },
      },
    );
    expect(() => decodeProcessPacket(packetAccessor)).toThrow();
    expect(getterCalls).toBe(0);

    const valid = {
      version: '1',
      jobId: 'process-job-1',
      ownerSessionId: 'process-session-1',
      executorName: 'process',
      channelId: 'process-channel-1',
    };
    expect(decodeProcessBootstrapData(valid)).toEqual(valid);
    expect(() => decodeProcessBootstrapData(new Proxy(valid, {}))).toThrow();
    expect(() =>
      decodeProcessBootstrapData(
        Object.assign(Object.create({ inherited: true }) as object, valid),
      ),
    ).toThrow();

    const hidden = { ...valid } as Record<PropertyKey, unknown>;
    Object.defineProperty(hidden, 'extra', {
      configurable: true,
      enumerable: false,
      value: 'not-closed',
    });
    expect(() => decodeProcessBootstrapData(hidden)).toThrow();

    const symbolic = { ...valid } as Record<PropertyKey, unknown>;
    symbolic[Symbol('extra')] = 'not-closed';
    expect(() => decodeProcessBootstrapData(symbolic)).toThrow();
  });

  it('rejects extra fields, invalid directions and invalid identifiers', () => {
    expect(() =>
      decodeProcessMessage({ version: '1', type: 'shutdown', extra: true }, 'inbound'),
    ).toThrow(/unknown|missing/u);
    expect(() => decodeProcessMessage({ version: '1', type: 'ready' }, 'inbound')).toThrow(
      /direction/u,
    );
    expect(() => decodeProcessMessage({ version: '1', type: 'shutdown' }, 'outbound')).toThrow(
      /direction/u,
    );

    const base = {
      version: '1',
      ownerSessionId: 'process-session-1',
      executorName: 'process',
      channelId: 'process-channel-1',
    };
    for (const jobId of ['', '../process', `a${'b'.repeat(128)}`, 'contains space']) {
      expect(() => decodeProcessBootstrapData({ ...base, jobId })).toThrow(/jobId/u);
    }
    for (const ownerSessionId of ['', ' leading', 'line\nbreak', 'a'.repeat(257)]) {
      expect(() =>
        decodeProcessBootstrapData({ ...base, jobId: 'process-job', ownerSessionId }),
      ).toThrow(/ownerSessionId/u);
    }
  });
});

describe('Process IPC writer admission and settlement', () => {
  acceptanceIt(
    'C7-PROCESS-31.l2.ipc-backpressure-callback-settlement',
    'false-is-backpressure-fifo-callback-is-authoritative',
    async () => {
      const callbacks: Array<(error: Error | null) => void> = [];
      const sent: ProcessSubAgentChannelMessage[] = [];
      const failures: string[] = [];
      const writer = createProcessSubAgentIpcWriter({
        connected: () => true,
        send: (message, callback) => {
          sent.push(message);
          callbacks.push(callback);
          return false;
        },
        onFailure: () => failures.push('failed'),
      });
      const first = writer.write({ version: '1', type: 'shutdown' });
      const second = writer.write({ version: '1', type: 'shutdown' });
      let firstSettled = false;
      let secondSettled = false;
      void Promise.resolve(first.settled).then(() => {
        firstSettled = true;
      });
      void Promise.resolve(second.settled).then(() => {
        secondSettled = true;
      });

      expect(first.admitted).toBe(true);
      expect(second.admitted).toBe(true);
      expect(sent).toHaveLength(1);
      expect(writer.pendingMessages).toBe(2);
      await Promise.resolve();
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      callbacks[0]!(null);
      await Promise.resolve();
      expect(firstSettled).toBe(true);
      expect(secondSettled).toBe(false);
      expect(sent).toHaveLength(2);
      callbacks[1]!(null);
      await expect(Promise.all([first.settled, second.settled])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(writer).toMatchObject({ pendingMessages: 0, pendingBytes: 0 });
      expect(failures).toEqual([]);
    },
  );

  it('fails the active and queued receipts exactly once when the send callback fails', async () => {
    const callbacks: Array<(error: Error | null) => void> = [];
    let failureCalls = 0;
    const writer = createProcessSubAgentIpcWriter({
      connected: () => true,
      send: (_message, callback) => {
        callbacks.push(callback);
      },
      onFailure: () => {
        failureCalls += 1;
      },
    });
    const first = writer.write({ version: '1', type: 'shutdown' });
    const second = writer.write({ version: '1', type: 'shutdown' });
    const firstSettled = Promise.resolve(first.settled);
    const secondSettled = Promise.resolve(second.settled);
    void firstSettled.catch(() => undefined);
    void secondSettled.catch(() => undefined);

    callbacks[0]!(new Error('deterministic send callback failure'));
    await expect(firstSettled).rejects.toThrow(/write failed/u);
    await expect(secondSettled).rejects.toThrow(/writer failed/u);
    expect(writer).toMatchObject({ pendingMessages: 0, pendingBytes: 0 });
    expect(failureCalls).toBe(1);
    expect(() => writer.write({ version: '1', type: 'shutdown' })).toThrow(/closed|failed/u);
  });

  it('rolls back synchronous send failures and exposes the bounded FIFO byte oracle', () => {
    let failures = 0;
    const writer = createProcessSubAgentIpcWriter({
      connected: () => true,
      send: () => {
        throw new Error('deterministic pre-admission send failure');
      },
      onFailure: () => {
        failures += 1;
      },
    });
    expect(() => writer.write({ version: '1', type: 'shutdown' })).toThrow(/writer failed/u);
    expect(writer).toMatchObject({ pendingMessages: 0, pendingBytes: 0 });
    expect(failures).toBe(1);

    const capacity = createProcessSubAgentIpcWriter({
      connected: () => true,
      send: () => undefined,
    });
    expect(() =>
      capacity.assertCapacity(DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_CACHED_BYTES),
    ).not.toThrow();
    expect(() =>
      capacity.assertCapacity(DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_CACHED_BYTES + 1),
    ).toThrow(/capacity/u);
  });

  it('rejects an already exposed queued receipt when its later send throws synchronously', async () => {
    const callbacks: Array<(error: Error | null) => void> = [];
    let sends = 0;
    let failures = 0;
    const writer = createProcessSubAgentIpcWriter({
      connected: () => true,
      send: (_message, callback) => {
        sends += 1;
        if (sends === 2) throw new Error('deterministic queued send failure');
        callbacks.push(callback);
      },
      onFailure: () => {
        failures += 1;
      },
    });
    const first = writer.write({ version: '1', type: 'shutdown' });
    const second = writer.write({ version: '1', type: 'shutdown' });
    const firstSettled = Promise.resolve(first.settled);
    const secondSettled = Promise.resolve(second.settled);
    void secondSettled.catch(() => undefined);

    callbacks[0]!(null);
    await expect(firstSettled).resolves.toBeUndefined();
    await expect(secondSettled).rejects.toThrow(/writer failed/u);
    expect(writer).toMatchObject({ pendingMessages: 0, pendingBytes: 0 });
    expect(failures).toBe(1);
  });
});
