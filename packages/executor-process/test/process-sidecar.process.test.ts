import { fork, type ChildProcess, type Serializable } from 'node:child_process';
import { createHash } from 'node:crypto';

import { describe, expect } from 'vitest';

import { acceptanceIt } from '../../../testkit';

import {
  createSubAgentTransportArtifactSidecar,
  type ArtifactReference,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

import { encodeProcessPacket } from '../src/process-protocol';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const TARGET_ENTRY = new URL('./fixtures/process-sidecar-target.mjs', import.meta.url);

describe('Process real advanced-serialization sidecar boundary', () => {
  acceptanceIt(
    'C7-PROCESS-11.l3.target-sidecar-roundtrip',
    'owned-clone-digest-length',
    async () => {
      assertNetworkDenyGuardInstalled();
      const frame = new TextEncoder().encode('{"process":"real-clone"}');
      const data = new TextEncoder().encode('real-process-advanced-sidecar-proof');
      const artifact: ArtifactReference = Object.freeze({
        version: '1',
        id: 'process-real-artifact',
        mediaType: 'application/octet-stream',
        size: data.byteLength,
        sha256: sha256(data),
      });
      const packet: SubAgentTransportPeerPacket = Object.freeze({
        frame,
        sidecars: Object.freeze([
          createSubAgentTransportArtifactSidecar({
            sidecarId: 'process-real-sidecar',
            artifact,
            data,
          }),
        ]),
      });
      const encoded = encodeProcessPacket(packet);
      const sourceFrame = [...frame];
      const sourceData = [...data];
      const child = fork(TARGET_ENTRY, [], {
        execPath: process.execPath,
        execArgv: [],
        serialization: 'advanced',
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: createRawFixtureEnvironment(),
      });
      child.stdout?.resume();
      child.stderr?.resume();
      const closed = onceClose(child, 5_000);
      try {
        await sendSettled(child, {
          version: '1',
          type: 'bootstrap',
          jobId: 'process-sidecar-job',
          ownerSessionId: 'process-sidecar-owner',
          executorName: 'process',
          channelId: 'process-sidecar-channel',
        });
        const evidence = onceMessage(child);
        await sendSettled(child, { version: '1', type: 'packet', packet: encoded });

        expect([...frame]).toEqual(sourceFrame);
        expect([...data]).toEqual(sourceData);
        await expect(evidence).resolves.toEqual({
          version: 'test-only',
          networkDenyInstalled: true,
          frame: { length: frame.byteLength, digest: sha256(frame) },
          sidecars: [
            {
              sidecarId: 'process-real-sidecar',
              length: data.byteLength,
              digest: sha256(data),
            },
          ],
        });
        await closed;
      } finally {
        if (child.connected) child.disconnect();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed.catch(() => undefined);
      }
    },
  );
});

function sendSettled(child: ChildProcess, message: Serializable): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

function onceMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
  });
}

function onceClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Process sidecar fixture did not close.')),
      timeoutMs,
    );
    timer.unref();
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function createRawFixtureEnvironment(): NodeJS.ProcessEnv {
  const read = (name: string): string | undefined => process.env[name];
  const env: NodeJS.ProcessEnv = { PATH: '' };
  const allow =
    process.platform === 'win32'
      ? [
          'HOMEDRIVE',
          'HOMEPATH',
          'SYSTEMDRIVE',
          'SYSTEMROOT',
          'TEMP',
          'USERNAME',
          'USERPROFILE',
          'WINDIR',
        ]
      : ['HOME', 'LANG', 'TEMP', 'TMP', 'TMPDIR', 'USER'];
  for (const name of allow) {
    const value = read(name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
