import {
  createSubAgentTransportPeer,
  createSubAgentTransportTargetBridge,
  SubAgentRuntimeError,
  type SubAgentTargetRunnerRegistry,
  type SubAgentTransportModelExchange,
  type SubAgentTransportTargetCatalog,
  type SubAgentTransportTargetEventsContext,
  type SubAgentTaskEvent,
} from '@ruixutong.manee/maneeagent-framework';

import { decodeProcessBinding, processSubAgentBindingCodec } from './process-binding';
import {
  decodeProcessMessage,
  decodeProcessPacket,
  encodeProcessPacket,
  estimateProcessPacketBytes,
  createProcessSubAgentIpcWriter,
  PROCESS_SUBAGENT_CHANNEL_VERSION,
  type ProcessSubAgentBootstrapData,
} from './process-protocol';

const MAX_PENDING_PROCESS_MESSAGES = 64;
// Stay below the five-second Oracle so OS close notification has bounded scheduling headroom.
const ORPHAN_EXIT_TIMEOUT_MS = 4_000;
// Capture this before a controller can disconnect. A normal host import must never arm a
// process-exit watchdog, while a statically imported Process target remains branded after loss.
const PROCESS_TARGET_STARTED_WITH_IPC = typeof process.send === 'function';

type ProcessTargetState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface ProcessSubAgentTargetRegistryContext {
  /** Deferred, credential-free route to the controller Model gateway through the Core Peer. */
  readonly modelExchange: SubAgentTransportModelExchange;
}

export interface ServeProcessSubAgentTargetOptions {
  /** Builds the trusted registry inside this statically selected Process entrypoint. */
  readonly createRegistry: (
    context: ProcessSubAgentTargetRegistryContext,
  ) => SubAgentTargetRunnerRegistry | Promise<SubAgentTargetRunnerRegistry>;
  readonly resolveCatalog?: Parameters<
    typeof createSubAgentTransportTargetBridge
  >[0]['resolveCatalog'];
  readonly events?: (
    context: SubAgentTransportTargetEventsContext,
  ) => AsyncIterable<SubAgentTaskEvent>;
}

/**
 * Serve exactly one task-scoped Process channel. The trusted target entrypoint imports this helper
 * statically; executable paths, registries and provider credentials never cross the RPC wire.
 */
export async function serveProcessSubAgentTarget(
  options: ServeProcessSubAgentTargetOptions,
): Promise<void> {
  if (!PROCESS_TARGET_STARTED_WITH_IPC) {
    throw new TypeError('serveProcessSubAgentTarget() requires a child-process IPC channel.');
  }
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.createRegistry !== 'function'
  ) {
    throw new TypeError('Process target options require a createRegistry() factory.');
  }

  let orphanExitTimer: ReturnType<typeof setTimeout> | undefined;
  const armOrphanExitWatchdog = (): void => {
    orphanExitTimer ??= setTimeout(() => process.exit(1), ORPHAN_EXIT_TIMEOUT_MS);
  };
  const onBootstrapDisconnect = (): void => armOrphanExitWatchdog();
  // Own the orphan boundary before awaiting the first IPC message. A controller can disappear
  // before this helper is called or while bootstrap is pending, and callers may catch the
  // resulting rejection while still holding unrelated referenced handles.
  process.on('disconnect', onBootstrapDisconnect);
  if (!process.connected) armOrphanExitWatchdog();

  const bootstrap = await receiveBootstrap();
  let state: ProcessTargetState = 'starting';
  let channelClosed = false;
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
  let reportWriterFailure = (): void => undefined;
  const ipcWriter = createProcessSubAgentIpcWriter({
    connected: () => process.connected && typeof process.send === 'function',
    send: (message, callback) => {
      if (typeof process.send !== 'function') {
        callback(new Error('The Process IPC channel is closed.'));
        return;
      }
      process.send(message, callback);
    },
    onFailure: () => queueMicrotask(reportWriterFailure),
  });

  const peer = createSubAgentTransportPeer({
    channelId: bootstrap.channelId,
    writer: (packet) => {
      if (state !== 'ready' || channelClosed) {
        throw targetUnavailable('The Process target channel is not ready.');
      }
      ipcWriter.assertCapacity(estimateProcessPacketBytes(packet));
      return ipcWriter.write(
        Object.freeze({
          version: PROCESS_SUBAGENT_CHANNEL_VERSION,
          type: 'packet',
          packet: encodeProcessPacket(packet),
        }),
      );
    },
    handler: async (request) => {
      if (state !== 'ready' || targetHandler === undefined) {
        throw targetUnavailable('The Process target has not completed startup.');
      }
      await targetHandler(request);
    },
  });

  const modelExchange: SubAgentTransportModelExchange = (request) => {
    if (state !== 'ready' || targetBridge === undefined) {
      return Promise.reject(targetUnavailable('The Process target Model gateway is not ready.'));
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
    if (sendStopped && !terminalMessageSent && !channelClosed) {
      terminalMessageSent = true;
      try {
        await ipcWriter.write({
          version: PROCESS_SUBAGENT_CHANNEL_VERSION,
          type: 'stopped',
        }).settled;
      } catch {
        // The controller may already have terminated the channel.
      }
    }
    state = 'stopped';
    ipcWriter.close();
    if (!channelClosed && process.connected) {
      channelClosed = true;
      try {
        process.disconnect?.();
      } catch {
        // The controller may have closed between the connected check and disconnect().
      }
    }
    resolveStopped();
  };

  const fail = async (code: 'TARGET_START_FAILED' | 'TARGET_PROTOCOL_FAILED'): Promise<void> => {
    if (state === 'stopped' || state === 'failed') return;
    state = 'failed';
    if (!terminalMessageSent && !channelClosed) {
      terminalMessageSent = true;
      try {
        await ipcWriter.write({
          version: PROCESS_SUBAGENT_CHANNEL_VERSION,
          type: 'fatal',
          code,
        }).settled;
      } catch {
        // A closed controller channel is already terminal.
      }
    }
    await dispose(targetUnavailable('The Process target channel failed.'), false);
  };
  reportWriterFailure = () => {
    void fail('TARGET_PROTOCOL_FAILED');
  };

  const handleMessage = async (value: unknown): Promise<void> => {
    const message = decodeProcessMessage(value, 'inbound');
    if (message.type === 'shutdown') {
      if (state !== 'ready') throw new TypeError('Process shutdown arrived out of order.');
      await dispose(new Error('Process target shutdown requested.'), true);
      return;
    }
    if (message.type !== 'packet' || state !== 'ready') {
      throw new TypeError('Process target packet arrived outside the ready state.');
    }
    if (activeReceives.size >= MAX_PENDING_PROCESS_MESSAGES) {
      throw new TypeError('Process target active packet capacity is exhausted.');
    }
    const receive = peer.receive(decodeProcessPacket(message.packet));
    activeReceives.add(receive);
    void receive
      .catch(() => fail('TARGET_PROTOCOL_FAILED'))
      .finally(() => {
        activeReceives.delete(receive);
      });
  };

  process.on('message', (value: unknown, sendHandle: unknown) => {
    if (state === 'stopped' || state === 'failed') return;
    if (sendHandle !== undefined) {
      void fail('TARGET_PROTOCOL_FAILED');
      return;
    }
    pendingMessages += 1;
    if (pendingMessages + activeReceives.size > MAX_PENDING_PROCESS_MESSAGES) {
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
  const onRuntimeDisconnect = (): void => {
    channelClosed = true;
    if (state === 'stopped') return;
    state = 'failed';
    ipcWriter.close(targetUnavailable('The Process controller channel closed.'));
    armOrphanExitWatchdog();
    void dispose(targetUnavailable('The Process controller channel closed.'), false).finally(() => {
      process.exit(1);
    });
  };
  process.on('disconnect', onRuntimeDisconnect);
  process.off('disconnect', onBootstrapDisconnect);
  // Closing can race the listener hand-off above. IPC cannot reconnect, so replay the terminal
  // observation synchronously when the channel is already gone.
  if (!process.connected) onRuntimeDisconnect();

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
      bindingCodec: processSubAgentBindingCodec,
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
        adapterStateVersion: processSubAgentBindingCodec.adapterStateVersion,
        recoveryData: { kind: 'maneeagent-process/v1', jobId: bootstrap.jobId },
      }),
      validateBinding: ({ binding }) => {
        const bindingState = decodeProcessBinding(binding.recoveryData);
        if (bindingState.jobId !== bootstrap.jobId) {
          throw new SubAgentRuntimeError({
            code: 'BINDING_INVALID',
            message: 'The Process binding does not belong to this logical job.',
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
    await ipcWriter.write({
      version: PROCESS_SUBAGENT_CHANNEL_VERSION,
      type: 'ready',
      manifest,
    }).settled;
  } catch {
    await fail('TARGET_START_FAILED');
  }

  await stopped;
}

function receiveBootstrap(): Promise<ProcessSubAgentBootstrapData> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    const onMessage = (value: unknown, sendHandle: unknown): void => {
      cleanup();
      try {
        if (sendHandle !== undefined) {
          throw new TypeError('Process bootstrap cannot transfer an IPC handle.');
        }
        const message = decodeProcessMessage(value, 'inbound');
        if (message.type !== 'bootstrap') {
          throw new TypeError('The first Process IPC message must be bootstrap.');
        }
        resolve(
          Object.freeze({
            version: message.version,
            jobId: message.jobId,
            ownerSessionId: message.ownerSessionId,
            executorName: message.executorName,
            channelId: message.channelId,
          }),
        );
      } catch (error) {
        reject(error);
      }
    };
    const onDisconnect = (): void => {
      cleanup();
      reject(targetUnavailable('The Process controller disconnected before bootstrap.'));
    };
    process.once('message', onMessage);
    process.once('disconnect', onDisconnect);
    // Cover a controller that disconnected before the listeners were installed, as well as the
    // narrow race between listener installation and this state observation.
    if (!process.connected) onDisconnect();
  });
}

function targetUnavailable(message: string): SubAgentRuntimeError {
  return new SubAgentRuntimeError({ code: 'EXECUTOR_UNAVAILABLE', message, retryable: false });
}
