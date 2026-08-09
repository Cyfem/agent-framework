import { fork, type ChildProcess, type Serializable } from 'node:child_process';
import { createServer, type Server } from 'node:net';

import { describe, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  acceptanceIt,
  createExecutorConformanceControl,
  createExecutorConformanceRequest,
} from '../../../testkit';

import {
  SubAgentTargetRunnerRegistry,
  type SubAgentDefinitionRegistration,
  type SubAgentTargetRunnerManifest,
  type SubAgentTransportModelRequestHandler,
} from '@ruixutong.manee/maneeagent-framework';

import { ProcessSubAgentExecutor } from '../src';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

const FORGED_TARGET_ENTRY = new URL(
  './fixtures/process-forged-send-handle-target.mjs',
  import.meta.url,
);
const RECEIVER_TARGET_ENTRY = new URL(
  './fixtures/process-send-handle-receiver-target.mjs',
  import.meta.url,
);
const DEFINITION_REF = Object.freeze({ name: 'process-conformance-child', version: '2' });
const definition: SubAgentDefinitionRegistration = Object.freeze({
  ...DEFINITION_REF,
  description: 'Manifest-only Process sendHandle definition.',
  inputSchema: z.json(),
  outputSchema: z.json(),
});

describe('Process IPC sendHandle rejection', () => {
  acceptanceIt(
    'C7-PROCESS-23.l3.bidirectional-send-handle-rejection',
    'controller-and-target-fail-close-before-handler',
    async () => {
      assertNetworkDenyGuardInstalled();

      const model = vi.fn<SubAgentTransportModelRequestHandler>(async () => {
        throw new Error('A forged target sendHandle must fail before Model traffic.');
      });
      const executor = new ProcessSubAgentExecutor({
        targetEntry: FORGED_TARGET_ENTRY,
        expectedManifest: expectedManifest(),
        model,
        handshakeTimeoutMs: 5_000,
        terminateTimeoutMs: 50,
      });
      const request = createExecutorConformanceRequest({
        executorName: 'process',
        taskId: 'process-forged-target-send-handle',
        definition: DEFINITION_REF,
        input: { scenario: 'settle' },
      });
      const recorder = createExecutorConformanceControl({
        ownerSessionId: request.ownerSessionId,
        taskId: request.taskId,
        signal: request.signal,
        deadlineAt: request.deadlineAt,
        approval: 'approved',
      });
      try {
        await expect(executor.execute(request, recorder.control)).rejects.toMatchObject({
          code: 'EXECUTOR_FAILED',
        });
        expect(model).not.toHaveBeenCalled();
        expect(recorder.snapshot()).toMatchObject({ bindings: [], checkpoints: [] });
        await vi.waitFor(() =>
          expect(executor.diagnostics()).toMatchObject({
            activeProcesses: 0,
            startingProcesses: 0,
            channels: 0,
            timers: 0,
          }),
        );
      } finally {
        await executor.dispose();
      }

      const child = fork(RECEIVER_TARGET_ENTRY, [], {
        execPath: process.execPath,
        execArgv: [],
        serialization: 'advanced',
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: createRawFixtureEnvironment(),
      });
      child.stdout?.resume();
      child.stderr?.resume();
      const close = onceClose(child, 5_000);
      const messages: unknown[] = [];
      child.on('message', (message) => messages.push(message));
      const server = await listenLocalServer();
      try {
        await sendHandleSettled(
          child,
          {
            version: '1',
            type: 'bootstrap',
            jobId: 'process-parent-send-handle-job',
            ownerSessionId: 'process-parent-send-handle-owner',
            executorName: 'process',
            channelId: 'process-parent-send-handle-channel',
          },
          server,
        );
        await close;
        expect(messages).toEqual([]);
      } finally {
        await closeServer(server);
        if (child.connected) child.disconnect();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await close.catch(() => undefined);
      }
    },
  );
});

function expectedManifest(): SubAgentTargetRunnerManifest {
  return new SubAgentTargetRunnerRegistry()
    .register({
      definition,
      runnerId: 'process-conformance-runner',
      runnerVersion: '2.0.0',
      childCheckpointVersions: ['1'],
      modelBinding: {
        gatewayId: 'process-conformance-model',
        protocol: 'openai-chat',
        codecVersion: '1',
      },
      create: () => ({ run: async () => await new Promise(() => undefined) }),
    })
    .seal()
    .manifest();
}

function listenLocalServer(): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, exclusive: true }, () => resolve(server));
  });
}

function sendHandleSettled(
  child: ChildProcess,
  message: Serializable,
  server: Server,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(message, server, (error) => (error === null ? resolve() : reject(error)));
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function onceClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Process sendHandle fixture did not close.')),
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
  const env: NodeJS.ProcessEnv = { PATH: '' };
  const allow =
    process.platform === 'win32'
      ? ['SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE', 'WINDIR']
      : ['HOME', 'LANG', 'TEMP', 'TMP', 'TMPDIR', 'USER'];
  for (const name of allow) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
