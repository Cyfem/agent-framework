import { isMainThread, workerData } from 'node:worker_threads';

import {
  createSubAgentTransportPeer,
  createSubAgentTransportPeerWriterAdmission,
  createSubAgentTransportTargetBridge,
  SubAgentRuntimeError,
  type SubAgentTargetRunnerRegistry,
  type SubAgentTransportModelExchange,
  type SubAgentTransportTargetCatalog,
  type SubAgentTransportTargetEventsContext,
  type SubAgentTaskEvent,
} from '@ruixutong.manee/maneeagent-framework';

import { decodeWorkerBinding, workerSubAgentBindingCodec } from './worker-binding';
import {
  decodeWorkerBootstrapData,
  decodeWorkerMessage,
  decodeWorkerPacket,
  encodeWorkerPacket,
  WORKER_SUBAGENT_CHANNEL_VERSION,
} from './worker-protocol';

const MAX_PENDING_WORKER_MESSAGES = 64;

type WorkerTargetState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface WorkerSubAgentTargetRegistryContext {
  /** Deferred, credential-free route to the controller Model gateway through the Core Peer. */
  readonly modelExchange: SubAgentTransportModelExchange;
}

export interface ServeWorkerSubAgentTargetOptions {
  /** Builds the trusted registry inside this statically selected Worker entrypoint. */
  readonly createRegistry: (
    context: WorkerSubAgentTargetRegistryContext,
  ) => SubAgentTargetRunnerRegistry | Promise<SubAgentTargetRunnerRegistry>;
  readonly resolveCatalog?: Parameters<
    typeof createSubAgentTransportTargetBridge
  >[0]['resolveCatalog'];
  readonly events?: (
    context: SubAgentTransportTargetEventsContext,
  ) => AsyncIterable<SubAgentTaskEvent>;
}

/**
 * Serve exactly one task-scoped Worker channel. The trusted target entrypoint imports this helper
 * statically; executable paths, registries and provider credentials never cross the RPC wire.
 */
export async function serveWorkerSubAgentTarget(
  options: ServeWorkerSubAgentTargetOptions,
): Promise<void> {
  if (isMainThread) {
    throw new TypeError('serveWorkerSubAgentTarget() can only run inside a worker thread.');
  }
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.createRegistry !== 'function'
  ) {
    throw new TypeError('Worker target options require a createRegistry() factory.');
  }

  const bootstrap = decodeWorkerBootstrapData(workerData);
  const port = bootstrap.port;
  let state: WorkerTargetState = 'starting';
  let portClosed = false;
  let terminalMessageSent = false;
  let pendingMessages = 0;
  let inbound: Promise<void> = Promise.resolve();
  const activeReceives = new Set<Promise<void>>();
  let targetBridge: ReturnType<typeof createSubAgentTransportTargetBridge> | undefined;
  let targetHandler: ReturnType<typeof createSubAgentTransportTargetBridge>['handler'] | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const peer = createSubAgentTransportPeer({
    channelId: bootstrap.channelId,
    writer: (packet) => {
      if (state !== 'ready' || portClosed) {
        throw targetUnavailable('The Worker target channel is not ready.');
      }
      const encoded = encodeWorkerPacket(packet);
      port.postMessage(
        {
          version: WORKER_SUBAGENT_CHANNEL_VERSION,
          type: 'packet',
          packet: encoded.packet,
        },
        [...encoded.transfer],
      );
      return createSubAgentTransportPeerWriterAdmission();
    },
    handler: async (request) => {
      if (state !== 'ready' || targetHandler === undefined) {
        throw targetUnavailable('The Worker target has not completed startup.');
      }
      await targetHandler(request);
    },
  });

  const modelExchange: SubAgentTransportModelExchange = (request) => {
    if (state !== 'ready' || targetBridge === undefined) {
      return Promise.reject(targetUnavailable('The Worker target Model gateway is not ready.'));
    }
    return targetBridge.modelExchange(request);
  };

  const dispose = async (reason: unknown, sendStopped: boolean): Promise<void> => {
    if (state === 'stopped') return;
    if (state !== 'failed') state = sendStopped ? 'stopping' : 'failed';
    peer.close();
    const bridge = targetBridge;
    targetBridge = undefined;
    targetHandler = undefined;
    if (bridge !== undefined) await bridge.dispose(reason).catch(() => undefined);
    if (sendStopped && !terminalMessageSent && !portClosed) {
      terminalMessageSent = true;
      try {
        port.postMessage({ version: WORKER_SUBAGENT_CHANNEL_VERSION, type: 'stopped' });
      } catch {
        // The controller may already have terminated the channel.
      }
    }
    state = 'stopped';
    if (!portClosed) {
      portClosed = true;
      port.close();
    }
    resolveStopped();
  };

  const fail = async (code: 'TARGET_START_FAILED' | 'TARGET_PROTOCOL_FAILED'): Promise<void> => {
    if (state === 'stopped' || state === 'failed') return;
    state = 'failed';
    if (!terminalMessageSent && !portClosed) {
      terminalMessageSent = true;
      try {
        port.postMessage({
          version: WORKER_SUBAGENT_CHANNEL_VERSION,
          type: 'fatal',
          code,
        });
      } catch {
        // A closed controller channel is already terminal.
      }
    }
    await dispose(targetUnavailable('The Worker target channel failed.'), false);
  };

  const handleMessage = async (value: unknown): Promise<void> => {
    const message = decodeWorkerMessage(value, 'inbound');
    if (message.type === 'shutdown') {
      if (state !== 'ready') throw new TypeError('Worker shutdown arrived out of order.');
      await dispose(new Error('Worker target shutdown requested.'), true);
      return;
    }
    if (message.type !== 'packet' || state !== 'ready') {
      throw new TypeError('Worker target packet arrived outside the ready state.');
    }
    if (activeReceives.size >= MAX_PENDING_WORKER_MESSAGES) {
      throw new TypeError('Worker target active packet capacity is exhausted.');
    }
    const receive = peer.receive(decodeWorkerPacket(message.packet));
    activeReceives.add(receive);
    void receive
      .catch(() => fail('TARGET_PROTOCOL_FAILED'))
      .finally(() => {
        activeReceives.delete(receive);
      });
  };

  port.on('message', (value: unknown) => {
    if (state === 'stopped' || state === 'failed') return;
    pendingMessages += 1;
    if (pendingMessages + activeReceives.size > MAX_PENDING_WORKER_MESSAGES) {
      pendingMessages -= 1;
      void fail('TARGET_PROTOCOL_FAILED');
      return;
    }
    inbound = inbound
      .then(() => handleMessage(value))
      .catch(() => fail('TARGET_PROTOCOL_FAILED'))
      .finally(() => {
        pendingMessages -= 1;
      });
    void inbound.catch(() => undefined);
  });
  port.on('messageerror', () => {
    void fail('TARGET_PROTOCOL_FAILED');
  });
  port.on('close', () => {
    portClosed = true;
    if (state !== 'stopped') {
      state = 'failed';
      void dispose(targetUnavailable('The Worker controller channel closed.'), false);
    }
  });
  port.start();

  try {
    const registry = await options.createRegistry(Object.freeze({ modelExchange }));
    registry.seal();
    registry.assertTransportReady();
    const manifest = registry.manifest();
    if (state !== 'starting') {
      await stopped;
      return;
    }
    targetBridge = createSubAgentTransportTargetBridge({
      ownerSessionId: bootstrap.ownerSessionId,
      executorName: bootstrap.executorName,
      registry,
      bindingCodec: workerSubAgentBindingCodec,
      peer,
      createBinding: ({ request, runner, modelBinding }) => ({
        version: '1',
        executorName: bootstrap.executorName,
        ownerSessionId: request.ownerSessionId,
        taskId: request.taskId,
        subagentSessionId: request.subagentSessionId,
        definitionName: request.definition.name,
        definitionVersion: request.definition.version,
        runnerId: runner.runnerId,
        runnerVersion: runner.runnerVersion,
        modelBinding,
        adapterStateVersion: workerSubAgentBindingCodec.adapterStateVersion,
        recoveryData: { kind: 'maneeagent-worker/v1', jobId: bootstrap.jobId },
      }),
      validateBinding: ({ binding }) => {
        const bindingState = decodeWorkerBinding(binding.recoveryData);
        if (bindingState.jobId !== bootstrap.jobId) {
          throw new SubAgentRuntimeError({
            code: 'BINDING_INVALID',
            message: 'The Worker binding does not belong to this logical job.',
            retryable: false,
          });
        }
      },
      ...(options.resolveCatalog === undefined
        ? {}
        : {
            resolveCatalog: options.resolveCatalog as (
              request: Parameters<NonNullable<typeof options.resolveCatalog>>[0],
            ) => SubAgentTransportTargetCatalog,
          }),
      ...(options.events === undefined ? {} : { events: options.events }),
    });
    targetHandler = targetBridge.handler;
    state = 'ready';
    port.postMessage({
      version: WORKER_SUBAGENT_CHANNEL_VERSION,
      type: 'ready',
      manifest,
    });
  } catch {
    await fail('TARGET_START_FAILED');
  }

  await stopped;
}

function targetUnavailable(message: string): SubAgentRuntimeError {
  return new SubAgentRuntimeError({ code: 'EXECUTOR_UNAVAILABLE', message, retryable: false });
}
