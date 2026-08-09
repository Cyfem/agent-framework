import { createHash } from 'node:crypto';
import { MessageChannel, Worker } from 'node:worker_threads';

import { describe, expect } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import {
  createSubAgentTransportArtifactSidecar,
  type ArtifactReference,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

import { encodeWorkerPacket } from '../src/worker-protocol';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const TARGET_ENTRY = new URL('./fixtures/worker-sidecar-target.mjs', import.meta.url);

describe('Worker real transferable sidecar boundary', () => {
  acceptanceIt(
    'C7-WORKER-11.l3.target-sidecar-roundtrip',
    'owned-transfer-digest-length',
    async () => {
      assertNetworkDenyGuardInstalled();
      const frame = new TextEncoder().encode('{"worker":"real-transfer"}');
      const data = new TextEncoder().encode('real-worker-transferable-sidecar-proof');
      const artifact: ArtifactReference = Object.freeze({
        version: '1',
        id: 'worker-real-artifact',
        mediaType: 'application/octet-stream',
        size: data.byteLength,
        sha256: sha256(data),
      });
      const packet: SubAgentTransportPeerPacket = Object.freeze({
        frame,
        sidecars: Object.freeze([
          createSubAgentTransportArtifactSidecar({
            sidecarId: 'worker-real-sidecar',
            artifact,
            data,
          }),
        ]),
      });
      const encoded = encodeWorkerPacket(packet);
      const sourceFrame = [...frame];
      const sourceData = [...data];
      const { port1, port2 } = new MessageChannel();
      const worker = new Worker(TARGET_ENTRY, {
        argv: [],
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
        workerData: {
          version: '1',
          jobId: 'worker-sidecar-job',
          ownerSessionId: 'worker-sidecar-owner',
          executorName: 'worker',
          channelId: 'worker-sidecar-channel',
          port: port2,
        },
        transferList: [port2],
      });
      worker.stdout?.resume();
      worker.stderr?.resume();
      try {
        const evidence = new Promise<{
          readonly networkDenyInstalled: true;
          readonly frame: { readonly length: number; readonly digest: string };
          readonly sidecars: readonly {
            readonly sidecarId: string;
            readonly length: number;
            readonly digest: string;
          }[];
        }>((resolve, reject) => {
          port1.once('message', resolve);
          worker.once('error', reject);
          worker.once('exit', (code) => {
            if (code !== 0) reject(new Error(`Sidecar fixture exited with ${code}.`));
          });
        });
        port1.postMessage({ version: '1', type: 'packet', packet: encoded.packet }, [
          ...encoded.transfer,
        ]);

        for (const transferred of encoded.transfer) expect(transferred.byteLength).toBe(0);
        expect([...frame]).toEqual(sourceFrame);
        expect([...data]).toEqual(sourceData);
        await expect(evidence).resolves.toEqual({
          version: 'test-only',
          networkDenyInstalled: true,
          frame: { length: frame.byteLength, digest: sha256(frame) },
          sidecars: [
            {
              sidecarId: 'worker-real-sidecar',
              length: data.byteLength,
              digest: sha256(data),
            },
          ],
        });
      } finally {
        port1.close();
        await worker.terminate();
      }
    },
  );
});

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
