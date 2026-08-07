import { describe, expect, vi } from 'vitest';
import { z } from 'zod';

import { acceptanceIt } from '../../../testkit';
import { Agent } from '../src/agent';
import type { AgentProtocol } from '../src/agent/types';
import { Model, type ModelGenerateRequest } from '../src/llm/base';
import { createOpenAIChatProtocolSurface, OpenAIChatModel } from '../src/llm/chat';
import type { OpenAIChatProtocol } from '../src/llm/chat/types';
import { createOpenAIResponsesProtocolSurface, OpenAIResponsesModel } from '../src/llm/responses';
import type { OpenAIResponsesProtocol } from '../src/llm/responses/types';
import type { SubAgentChildRunRequest } from '../src/subagent/child-runner';
import type {
  AgentProtocolCheckpointCodec,
  SubAgentChildCheckpoint,
} from '../src/subagent/checkpoint';
import type { SubAgentExecutionControl } from '../src/subagent/executor';
import { canonicalJsonSha256, type JsonValue } from '../src/subagent/json';
import { DEFAULT_SUBAGENT_LIMITS } from '../src/subagent/limits';
import {
  MemoryProviderOperationLedgerStore,
  ProviderOperationLedger,
} from '../src/subagent/provider-operation-ledger';
import {
  setProviderOperationFailpointForTest,
  type ProviderOperationFailpointPhase,
} from '../src/subagent/provider-operation-ledger-internals';
import { createSubAgentTransportModelExchange } from '../src/subagent/transport-bridge';
import {
  createSubAgentTransportModelProxy,
  SubAgentTransportModelGatewayHandler,
  SubAgentTransportModelGatewayRegistry,
  type SubAgentTransportModelExchangeRequest,
  type SubAgentTransportModelGatewayOperation,
  type SubAgentTransportModelProtocolSurface,
} from '../src/subagent/transport-model-gateway';
import {
  createSubAgentTransportPeerWriterAdmission,
  SubAgentTransportPeer,
  type SubAgentTransportPeerPacket,
} from '../src/subagent/transport-peer';

const OWNER_SESSION_ID = 'reply-loss-owner-session';
const RUN_ID = 'reply-loss-run';
const TASK_ID = 'reply-loss-task';
const EXECUTION_ATTEMPT = 1;
const EXECUTION_EPOCH = 'reply-loss-epoch-1';
const EXECUTION_FENCING_TOKEN = '17';
const RECOVERY_EXECUTION_ATTEMPT = 2;
const RECOVERY_EXECUTION_EPOCH = 'reply-loss-epoch-2';
const RECOVERY_EXECUTION_FENCING_TOKEN = '18';
const GATEWAY_ID = 'reply-loss-controller-model';
const RUNNER_ID = 'reply-loss-runner';
const RUNNER_VERSION = '2.0.0';
const EXECUTOR_NAME = 'process';
const PROOF = 'reply-loss-ledger-recovery-proof';

interface RecordedCheckpoint {
  readonly operationId: string;
  readonly digest: string;
  readonly revision: number;
  readonly checkpoint: SubAgentChildCheckpoint;
}

function chatToolResponse(callId: string, name: string, parameters: JsonValue) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: { name, arguments: JSON.stringify(parameters) },
            },
          ],
        },
      },
    ],
  };
}

function responsesToolResponse(callId: string, name: string, parameters: JsonValue) {
  return {
    output: [
      {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: JSON.stringify(parameters),
        status: 'completed',
      },
    ],
  };
}

interface ReplyLossProtocolScenario<P extends AgentProtocol> {
  readonly label: 'chat' | 'responses';
  readonly protocol: string;
  readonly surface: SubAgentTransportModelProtocolSurface<P>;
  readonly controllerModel: Model<P> & {
    readonly checkpointCodec: AgentProtocolCheckpointCodec<P>;
  };
  readonly sdkCreate: ReturnType<typeof vi.fn>;
}

function createChatScenario(): ReplyLossProtocolScenario<OpenAIChatProtocol> {
  const sdkCreate = vi
    .fn()
    .mockResolvedValueOnce(
      chatToolResponse('reply-loss-result-call', 'agent-result', {
        result: { proof: PROOF },
      }),
    )
    .mockResolvedValueOnce(chatToolResponse('reply-loss-end-call', 'end-agent', {}));
  return Object.freeze({
    label: 'chat' as const,
    protocol: 'openai-chat',
    surface: createOpenAIChatProtocolSurface(),
    controllerModel: new OpenAIChatModel({
      model: 'offline-reply-loss-controller-chat',
      client: { chat: { completions: { create: sdkCreate } } } as never,
    }),
    sdkCreate,
  });
}

function createResponsesScenario(): ReplyLossProtocolScenario<OpenAIResponsesProtocol> {
  const sdkCreate = vi
    .fn()
    .mockResolvedValueOnce(
      responsesToolResponse('reply-loss-result-call', 'agent-result', {
        result: { proof: PROOF },
      }),
    )
    .mockResolvedValueOnce(responsesToolResponse('reply-loss-end-call', 'end-agent', {}));
  return Object.freeze({
    label: 'responses' as const,
    protocol: 'openai-responses',
    surface: createOpenAIResponsesProtocolSurface(),
    controllerModel: new OpenAIResponsesModel({
      model: 'offline-reply-loss-controller-responses',
      client: { responses: { create: sdkCreate } } as never,
    }),
    sdkCreate,
  });
}

function createChildRequest(
  checkpoint: SubAgentChildCheckpoint | undefined,
  execution: Readonly<{
    attempt: number;
    epoch: string;
    fencingToken: string;
  }> = {
    attempt: EXECUTION_ATTEMPT,
    epoch: EXECUTION_EPOCH,
    fencingToken: EXECUTION_FENCING_TOKEN,
  },
): SubAgentChildRunRequest {
  const signal = new AbortController().signal;
  return Object.freeze({
    ownerSessionId: OWNER_SESSION_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    subagentSessionId: 'reply-loss-child-session',
    path: Object.freeze([TASK_ID]),
    attempt: execution.attempt,
    executionEpoch: execution.epoch,
    executionFencingToken: execution.fencingToken,
    definition: Object.freeze({ name: 'reply-loss-child', version: '2' }),
    input: Object.freeze({ prompt: 'prove cached provider reply recovery' }),
    projectedContext: Object.freeze([]),
    delegation: Object.freeze({
      version: '1' as const,
      ownerSessionId: OWNER_SESSION_ID,
      runId: RUN_ID,
      parentTaskId: TASK_ID,
      path: Object.freeze([TASK_ID]),
      depth: 1,
      catalogRevision: 1,
      definitions: Object.freeze([]),
    }),
    limits: DEFAULT_SUBAGENT_LIMITS,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    signal,
    deadlineAt: Date.now() + 120_000,
  });
}

function createCheckpointRecorder() {
  const checkpoints: RecordedCheckpoint[] = [];
  const byOperationId = new Map<string, RecordedCheckpoint>();

  const commitCheckpoint = vi.fn(
    async (operationId: string, checkpoint: SubAgentChildCheckpoint): Promise<void> => {
      const digest = canonicalJsonSha256(checkpoint as unknown as JsonValue);
      expect(operationId).toBe(`child-checkpoint-${digest}`);
      const existing = byOperationId.get(operationId);
      if (existing !== undefined) {
        expect(existing.checkpoint).toEqual(checkpoint);
        return;
      }
      const recorded = Object.freeze({
        operationId,
        digest,
        revision: checkpoints.length + 1,
        checkpoint,
      });
      checkpoints.push(recorded);
      byOperationId.set(operationId, recorded);
    },
  );

  return { checkpoints, byOperationId, commitCheckpoint };
}

function createControl(
  recorder: ReturnType<typeof createCheckpointRecorder>,
  options: { readonly rejectTerminalFailure: boolean },
) {
  const submitResult = vi.fn(async (callId: string, candidate: JsonValue) => ({
    schemaVersion: '1' as const,
    receiptId: `result-receipt-${callId}`,
    taskId: TASK_ID,
    callId,
    revision: 40,
    outputHash: canonicalJsonSha256(candidate),
    submittedAt: Date.now(),
    status: 'accepted' as const,
  }));
  const complete = vi.fn(async (callId: string) => ({
    schemaVersion: '1' as const,
    receiptId: `completion-receipt-${callId}`,
    taskId: TASK_ID,
    callId,
    revision: 41,
    completedAt: Date.now(),
    status: 'completed' as const,
  }));
  const fail = vi.fn(async () => {
    if (options.rejectTerminalFailure) {
      throw new Error('The simulated target crashed before authoritative failure settlement.');
    }
    throw new Error('The recovered child must not fail.');
  });
  const consumeBudget = vi.fn(async () => undefined);
  const signal = new AbortController().signal;
  const control = {
    signal,
    deadlineAt: Date.now() + 120_000,
    delegation: {
      getCatalog: () => ({ revision: 1, capturedAt: 1, executors: [] }),
      getCatalogEntries: () => [],
    },
    completion: { submitResult, complete, fail },
    commitBinding: vi.fn(async () => undefined),
    commitCheckpoint: recorder.commitCheckpoint,
    authorizeTool: vi.fn(async () => {
      throw new Error('No approval is expected.');
    }),
    pauseDelegation: vi.fn(async () => {
      throw new Error('No delegation pause is expected.');
    }),
    reportProgress: vi.fn(async () => undefined),
    consumeBudget,
    emit: vi.fn(async () => undefined),
  } as unknown as SubAgentExecutionControl;

  return { control, submitResult, complete, fail, consumeBudget };
}

function createGatewayHandler(
  registry: SubAgentTransportModelGatewayRegistry,
  store: MemoryProviderOperationLedgerStore,
  recorder: ReturnType<typeof createCheckpointRecorder>,
  execution: Readonly<{
    attempt: number;
    epoch: string;
    fencingToken: string;
  }> = {
    attempt: EXECUTION_ATTEMPT,
    epoch: EXECUTION_EPOCH,
    fencingToken: EXECUTION_FENCING_TOKEN,
  },
  failpoint?: (phase: ProviderOperationFailpointPhase) => void | Promise<void>,
) {
  const acknowledged: SubAgentTransportModelGatewayOperation[] = [];
  const reserved: SubAgentTransportModelGatewayOperation[] = [];
  const ledger = new ProviderOperationLedger({ store });
  if (failpoint !== undefined) setProviderOperationFailpointForTest(ledger, failpoint);
  const handler = new SubAgentTransportModelGatewayHandler({
    registry,
    ledger,
    acknowledgeCheckpoint: (operation) => {
      const stored = recorder.byOperationId.get(operation.checkpointOperationId);
      if (stored === undefined) throw new Error('The controller did not persist this checkpoint.');
      expect(stored.digest).toBe(operation.checkpointDigest);
      expect(stored.checkpoint.modelOperation).toMatchObject({
        operationId: operation.providerOperationId,
        phase: 'in_flight',
      });
      expect(operation).toMatchObject({
        ownerSessionId: OWNER_SESSION_ID,
        runId: RUN_ID,
        taskId: TASK_ID,
        executionAttempt: execution.attempt,
        executionEpoch: execution.epoch,
        executionFencingToken: execution.fencingToken,
      });
      const acknowledgedOperation = Object.freeze({
        ...operation,
        checkpointRevision: stored.revision,
      });
      acknowledged.push(acknowledgedOperation);
      return {
        checkpointRevision: stored.revision,
        checkpointDigest: stored.digest,
      };
    },
    reserveBudget: (operation) => {
      reserved.push(operation);
    },
  });
  return { handler, acknowledged, reserved };
}

function createChildAgent<P extends AgentProtocol>(
  scenario: ReplyLossProtocolScenario<P>,
  exchange: (
    request: SubAgentTransportModelExchangeRequest,
  ) => ReturnType<SubAgentTransportModelGatewayHandler['handle']>,
  unhandledRetryLimit = 0,
) {
  return new Agent<P>({
    llm: createSubAgentTransportModelProxy({
      protocol: scenario.surface,
      gatewayId: GATEWAY_ID,
      exchange,
    }),
    maxIterations: 3,
    modelErrorRecovery: { unhandledRetryLimit, contextLengthRecoveryLimit: 0 },
  });
}

function createPeerModelBridge(
  handler: SubAgentTransportModelGatewayHandler,
  channelId: string,
  options: { readonly dropFirstControllerReply?: boolean } = {},
) {
  const peers: { target?: SubAgentTransportPeer } = {};
  const targetPeer = (): SubAgentTransportPeer => {
    if (peers.target === undefined) throw new Error('Target peer is not initialized.');
    return peers.target;
  };
  let dropControllerReply = options.dropFirstControllerReply === true;
  let targetMessageSequence = 1;
  let controllerMessageSequence = 1;
  const deliver = (receiver: () => SubAgentTransportPeer, packet: SubAgentTransportPeerPacket) => {
    const settled = Promise.resolve().then(() => receiver().receive(packet));
    return createSubAgentTransportPeerWriterAdmission(settled);
  };

  const controller = new SubAgentTransportPeer({
    channelId,
    createMessageId: () => `${channelId}-controller-${controllerMessageSequence++}`,
    writer: (packet) => {
      if (dropControllerReply) {
        dropControllerReply = false;
        targetPeer().close({
          code: 'INTERNAL_ERROR',
          message: 'The Model reply channel was lost after provider completion.',
          retryable: false,
          causeCode: 'MODEL_REPLY_CHANNEL_LOST',
          outcomeUnknown: true,
        });
        return createSubAgentTransportPeerWriterAdmission();
      }
      return deliver(targetPeer, packet);
    },
    handler: async (request) => {
      if (request.envelope.kind !== 'model.request') {
        await request.reply({
          kind: 'protocol.error',
          payload: {
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'The requested resource was not found.',
              retryable: false,
            },
          },
        });
        return;
      }
      const reply = await handler.handle({
        ownerSessionId: OWNER_SESSION_ID,
        taskId: request.envelope.taskId,
        operationId: request.envelope.operationId,
        payload: request.envelope.payload,
      });
      await request.reply({ kind: 'model.reply', payload: reply });
    },
  });
  const target = new SubAgentTransportPeer({
    channelId,
    createMessageId: () => `${channelId}-target-${targetMessageSequence++}`,
    writer: (packet) => deliver(() => controller, packet),
  });
  peers.target = target;

  return Object.freeze({
    exchange: createSubAgentTransportModelExchange(target),
    close: (): void => {
      target.close();
      controller.close();
    },
  });
}

async function runCompletedReplyLossScenario<P extends AgentProtocol>(
  scenario: ReplyLossProtocolScenario<P>,
): Promise<void> {
  const { controllerModel, sdkCreate } = scenario;
  const controllerGenerate = vi.spyOn(controllerModel, 'generate');
  const registry = new SubAgentTransportModelGatewayRegistry();
  registry.register({
    gatewayId: GATEWAY_ID,
    protocol: scenario.protocol,
    codec: controllerModel.checkpointCodec,
    model: controllerModel,
  });
  registry.seal();

  const recorder = createCheckpointRecorder();
  const store = new MemoryProviderOperationLedgerStore();
  const firstGateway = createGatewayHandler(registry, store, recorder);
  const firstExchangeRequests: SubAgentTransportModelExchangeRequest[] = [];
  const firstBridge = createPeerModelBridge(
    firstGateway.handler,
    `reply-loss-${scenario.label}-first`,
    { dropFirstControllerReply: true },
  );
  const firstAgent = createChildAgent(scenario, async (request) => {
    firstExchangeRequests.push(request);
    return await firstBridge.exchange(request);
  });
  const firstControl = createControl(recorder, { rejectTerminalFailure: true });

  await expect(
    firstAgent.runAsSubAgent({
      request: createChildRequest(undefined),
      control: firstControl.control,
      runnerId: RUNNER_ID,
      runnerVersion: RUNNER_VERSION,
      executorName: EXECUTOR_NAME,
      checkpointMode: 'durable',
      input: 'recover the typed proof after a lost reply',
      outputSchema: z.object({ proof: z.literal(PROOF) }).strict(),
    }),
  ).rejects.toMatchObject({
    descriptor: {
      causeCode: 'MODEL_OUTCOME_UNKNOWN',
      outcomeUnknown: true,
    },
  });

  expect(firstExchangeRequests).toHaveLength(1);
  expect(sdkCreate).toHaveBeenCalledOnce();
  expect(controllerGenerate).toHaveBeenCalledOnce();
  expect(firstControl.fail).toHaveBeenCalledOnce();
  expect(firstControl.consumeBudget).not.toHaveBeenCalled();
  expect(firstGateway.reserved).toHaveLength(1);

  const lostRequest = firstExchangeRequests[0]!;
  const inFlightCheckpoint = [...recorder.checkpoints]
    .reverse()
    .find(
      ({ checkpoint }) =>
        checkpoint.modelOperation?.operationId === lostRequest.operationId &&
        checkpoint.modelOperation.phase === 'in_flight',
    );
  expect(inFlightCheckpoint).toBeDefined();
  expect(lostRequest.payload).toMatchObject({
    providerOperationId: inFlightCheckpoint!.checkpoint.modelOperation!.operationId,
    runId: RUN_ID,
    executionAttempt: EXECUTION_ATTEMPT,
    executionEpoch: EXECUTION_EPOCH,
    executionFencingToken: EXECUTION_FENCING_TOKEN,
    checkpointOperationId: inFlightCheckpoint!.operationId,
    checkpointDigest: inFlightCheckpoint!.digest,
    iteration: 0,
    requestAttempt: 1,
  });

  const ledgerBeforeRecovery = await new ProviderOperationLedger({ store }).load({
    ownerSessionId: OWNER_SESSION_ID,
    taskId: TASK_ID,
    providerOperationId: lostRequest.operationId,
  });
  expect(ledgerBeforeRecovery).toMatchObject({
    phase: 'completed',
    providerOperationId: lostRequest.operationId,
    reply: {
      version: '1',
      ok: true,
    },
  });
  expect(ledgerBeforeRecovery?.reply).not.toHaveProperty('executionAttempt');
  expect(ledgerBeforeRecovery?.reply).not.toHaveProperty('executionEpoch');
  expect(ledgerBeforeRecovery?.reply).not.toHaveProperty('executionFencingToken');

  // A fresh controller handler and exchange channel emulate process/channel reconstruction.
  const recoveryExecution = Object.freeze({
    attempt: RECOVERY_EXECUTION_ATTEMPT,
    epoch: RECOVERY_EXECUTION_EPOCH,
    fencingToken: RECOVERY_EXECUTION_FENCING_TOKEN,
  });
  const recoveryGateway = createGatewayHandler(registry, store, recorder, recoveryExecution);
  const recoveryExchangeRequests: SubAgentTransportModelExchangeRequest[] = [];
  const recoveryBridge = createPeerModelBridge(
    recoveryGateway.handler,
    `reply-loss-${scenario.label}-recovery`,
  );
  const recoveryAgent = createChildAgent(scenario, async (request) => {
    recoveryExchangeRequests.push(request);
    return await recoveryBridge.exchange(request);
  });
  const recoveryControl = createControl(recorder, { rejectTerminalFailure: false });

  const outcome = await recoveryAgent.runAsSubAgent({
    request: createChildRequest(inFlightCheckpoint!.checkpoint, recoveryExecution),
    control: recoveryControl.control,
    runnerId: RUNNER_ID,
    runnerVersion: RUNNER_VERSION,
    executorName: EXECUTOR_NAME,
    checkpointMode: 'durable',
    input: 'recover the typed proof after a lost reply',
    outputSchema: z.object({ proof: z.literal(PROOF) }).strict(),
  });

  expect(outcome).toMatchObject({
    type: 'terminal',
    result: {
      status: 'succeeded',
      task: {
        taskId: TASK_ID,
        subAgent: { name: 'reply-loss-child', version: '2' },
      },
      executor: EXECUTOR_NAME,
      output: { proof: PROOF },
    },
  });
  expect(recoveryControl.submitResult).toHaveBeenCalledOnce();
  expect(recoveryControl.submitResult).toHaveBeenCalledWith('reply-loss-result-call', {
    proof: PROOF,
  });
  expect(recoveryControl.complete).toHaveBeenCalledOnce();
  expect(recoveryControl.complete).toHaveBeenCalledWith('reply-loss-end-call', {
    isStandalone: true,
  });
  expect(recoveryControl.fail).not.toHaveBeenCalled();
  expect(recoveryControl.consumeBudget).not.toHaveBeenCalled();

  expect(recoveryExchangeRequests).toHaveLength(2);
  const replayRequest = recoveryExchangeRequests[0]!;
  const nextIterationRequest = recoveryExchangeRequests[1]!;
  expect(replayRequest.operationId).toBe(lostRequest.operationId);
  expect(replayRequest.payload).toMatchObject({
    providerOperationId: lostRequest.payload.providerOperationId,
    runId: lostRequest.payload.runId,
    executionAttempt: RECOVERY_EXECUTION_ATTEMPT,
    executionEpoch: RECOVERY_EXECUTION_EPOCH,
    executionFencingToken: RECOVERY_EXECUTION_FENCING_TOKEN,
    checkpointOperationId: lostRequest.payload.checkpointOperationId,
    checkpointDigest: lostRequest.payload.checkpointDigest,
    requestHash: lostRequest.payload.requestHash,
    iteration: 0,
    requestAttempt: 1,
  });
  expect(nextIterationRequest.operationId).not.toBe(lostRequest.operationId);
  expect(nextIterationRequest.payload).toMatchObject({
    providerOperationId: nextIterationRequest.operationId,
    runId: RUN_ID,
    executionAttempt: RECOVERY_EXECUTION_ATTEMPT,
    executionEpoch: RECOVERY_EXECUTION_EPOCH,
    executionFencingToken: RECOVERY_EXECUTION_FENCING_TOKEN,
    iteration: 1,
    requestAttempt: 1,
  });

  // The cached operation was acknowledged again, but only the new iteration reserved budget.
  expect(
    recoveryGateway.acknowledged.map(({ providerOperationId }) => providerOperationId),
  ).toEqual([lostRequest.operationId, nextIterationRequest.operationId]);
  expect(recoveryGateway.reserved.map(({ providerOperationId }) => providerOperationId)).toEqual([
    nextIterationRequest.operationId,
  ]);

  expect(sdkCreate).toHaveBeenCalledTimes(2);
  expect(controllerGenerate).toHaveBeenCalledTimes(2);
  const providerRuntimes = controllerGenerate.mock.calls.map(
    ([request]) => (request as ModelGenerateRequest<P>).runtime,
  );
  expect(providerRuntimes[0]).toMatchObject({
    runId: RUN_ID,
    taskId: TASK_ID,
    executionAttempt: EXECUTION_ATTEMPT,
    executionEpoch: EXECUTION_EPOCH,
    executionFencingToken: EXECUTION_FENCING_TOKEN,
    providerOperationId: lostRequest.operationId,
    checkpointOperationId: lostRequest.payload.checkpointOperationId,
    checkpointDigest: lostRequest.payload.checkpointDigest,
    iteration: 0,
    requestAttempt: 1,
  });
  expect(providerRuntimes[1]).toMatchObject({
    executionAttempt: RECOVERY_EXECUTION_ATTEMPT,
    executionEpoch: RECOVERY_EXECUTION_EPOCH,
    executionFencingToken: RECOVERY_EXECUTION_FENCING_TOKEN,
    providerOperationId: nextIterationRequest.operationId,
    iteration: 1,
    requestAttempt: 1,
  });

  const ledgerAfterRecovery = await new ProviderOperationLedger({ store }).load({
    ownerSessionId: OWNER_SESSION_ID,
    taskId: TASK_ID,
    providerOperationId: lostRequest.operationId,
  });
  expect(ledgerAfterRecovery).toEqual(ledgerBeforeRecovery);
  await expect(
    new ProviderOperationLedger({ store }).load({
      ownerSessionId: OWNER_SESSION_ID,
      taskId: TASK_ID,
      providerOperationId: nextIterationRequest.operationId,
    }),
  ).resolves.toMatchObject({ phase: 'completed' });
  firstBridge.close();
  recoveryBridge.close();
}

async function runInFlightOutcomeUnknownScenario<P extends AgentProtocol>(
  scenario: ReplyLossProtocolScenario<P>,
): Promise<void> {
  const controllerGenerate = vi.spyOn(scenario.controllerModel, 'generate');
  const registry = new SubAgentTransportModelGatewayRegistry();
  registry.register({
    gatewayId: GATEWAY_ID,
    protocol: scenario.protocol,
    codec: scenario.controllerModel.checkpointCodec,
    model: scenario.controllerModel,
  });
  registry.seal();

  const recorder = createCheckpointRecorder();
  const store = new MemoryProviderOperationLedgerStore();
  let injected = false;
  const firstGateway = createGatewayHandler(
    registry,
    store,
    recorder,
    {
      attempt: EXECUTION_ATTEMPT,
      epoch: EXECUTION_EPOCH,
      fencingToken: EXECUTION_FENCING_TOKEN,
    },
    (phase) => {
      if (!injected && phase === 'after_in_flight_before_provider') {
        injected = true;
        throw new Error('simulated controller crash after durable in_flight');
      }
    },
  );
  const firstBridge = createPeerModelBridge(
    firstGateway.handler,
    `in-flight-${scenario.label}-first`,
  );
  const firstRequests: SubAgentTransportModelExchangeRequest[] = [];
  const firstAgent = createChildAgent(scenario, async (request) => {
    firstRequests.push(request);
    return await firstBridge.exchange(request);
  });
  const firstControl = createControl(recorder, { rejectTerminalFailure: true });

  await expect(
    firstAgent.runAsSubAgent({
      request: createChildRequest(undefined),
      control: firstControl.control,
      runnerId: RUNNER_ID,
      runnerVersion: RUNNER_VERSION,
      executorName: EXECUTOR_NAME,
      checkpointMode: 'durable',
      input: 'fail closed after provider in-flight admission',
      outputSchema: z.object({ proof: z.literal(PROOF) }).strict(),
    }),
  ).rejects.toMatchObject({
    descriptor: {
      causeCode: 'MODEL_OUTCOME_UNKNOWN',
      outcomeUnknown: true,
    },
  });

  expect(injected).toBe(true);
  expect(firstRequests).toHaveLength(1);
  expect(scenario.sdkCreate).not.toHaveBeenCalled();
  expect(controllerGenerate).not.toHaveBeenCalled();
  expect(firstGateway.reserved).toHaveLength(1);
  const request = firstRequests[0]!;
  const checkpoint = [...recorder.checkpoints]
    .reverse()
    .find(
      (candidate) =>
        candidate.checkpoint.modelOperation?.operationId === request.operationId &&
        candidate.checkpoint.modelOperation.phase === 'in_flight',
    );
  expect(checkpoint).toBeDefined();
  const identity = {
    ownerSessionId: OWNER_SESSION_ID,
    taskId: TASK_ID,
    providerOperationId: request.operationId,
  } as const;
  const inFlightBeforeRecovery = await new ProviderOperationLedger({ store }).load(identity);
  expect(inFlightBeforeRecovery).toMatchObject({
    phase: 'in_flight',
    providerOperationId: request.operationId,
  });
  const recoveryOracle = await new ProviderOperationLedger({ store }).recoverInFlight(identity);
  expect(recoveryOracle).toMatchObject({
    status: 'outcome_unknown',
    record: {
      phase: 'outcome_unknown',
      providerOperationId: request.operationId,
    },
  });
  const explicitHostRecovery = await new ProviderOperationLedger({ store }).recoverInFlight(
    identity,
  );
  expect(explicitHostRecovery).toMatchObject({
    status: 'outcome_unknown',
    record: { phase: 'outcome_unknown' },
  });

  const recoveryExecution = Object.freeze({
    attempt: RECOVERY_EXECUTION_ATTEMPT,
    epoch: RECOVERY_EXECUTION_EPOCH,
    fencingToken: RECOVERY_EXECUTION_FENCING_TOKEN,
  });
  const recoveryGateway = createGatewayHandler(registry, store, recorder, recoveryExecution);
  const recoveryBridge = createPeerModelBridge(
    recoveryGateway.handler,
    `in-flight-${scenario.label}-recovery`,
  );
  const recoveryRequests: SubAgentTransportModelExchangeRequest[] = [];
  const recoveryAgent = createChildAgent(scenario, async (candidate) => {
    recoveryRequests.push(candidate);
    return await recoveryBridge.exchange(candidate);
  });
  const recoveryControl = createControl(recorder, { rejectTerminalFailure: true });

  await expect(
    recoveryAgent.runAsSubAgent({
      request: createChildRequest(checkpoint!.checkpoint, recoveryExecution),
      control: recoveryControl.control,
      runnerId: RUNNER_ID,
      runnerVersion: RUNNER_VERSION,
      executorName: EXECUTOR_NAME,
      checkpointMode: 'durable',
      input: 'fail closed without resending an uncertain provider operation',
      outputSchema: z.object({ proof: z.literal(PROOF) }).strict(),
    }),
  ).rejects.toMatchObject({
    descriptor: {
      causeCode: 'MODEL_OUTCOME_UNKNOWN',
      outcomeUnknown: true,
    },
  });

  expect(recoveryRequests).toHaveLength(1);
  expect(recoveryRequests[0]).toMatchObject({
    operationId: request.operationId,
    payload: {
      providerOperationId: request.operationId,
      executionAttempt: RECOVERY_EXECUTION_ATTEMPT,
      executionEpoch: RECOVERY_EXECUTION_EPOCH,
      executionFencingToken: RECOVERY_EXECUTION_FENCING_TOKEN,
      requestHash: request.payload.requestHash,
    },
  });
  expect(recoveryGateway.acknowledged).toHaveLength(1);
  expect(recoveryGateway.reserved).toHaveLength(0);
  expect(scenario.sdkCreate).not.toHaveBeenCalled();
  expect(controllerGenerate).not.toHaveBeenCalled();
  await expect(new ProviderOperationLedger({ store }).load(identity)).resolves.toMatchObject({
    phase: 'outcome_unknown',
    providerOperationId: request.operationId,
  });

  firstBridge.close();
  recoveryBridge.close();
}

async function runSecondAttemptCompletedReplyLossScenario(): Promise<void> {
  const scenario = createChatScenario();
  const explicitRejection = Object.assign(new Error('retryable provider rejection'), {
    status: 429,
  });
  scenario.sdkCreate
    .mockReset()
    .mockRejectedValueOnce(explicitRejection)
    .mockResolvedValueOnce(
      chatToolResponse('reply-loss-result-call', 'agent-result', {
        result: { proof: PROOF },
      }),
    )
    .mockResolvedValueOnce(chatToolResponse('reply-loss-end-call', 'end-agent', {}));
  const controllerGenerate = vi.spyOn(scenario.controllerModel, 'generate');
  const registry = new SubAgentTransportModelGatewayRegistry();
  registry.register({
    gatewayId: GATEWAY_ID,
    protocol: scenario.protocol,
    codec: scenario.controllerModel.checkpointCodec,
    model: scenario.controllerModel,
  });
  registry.seal();

  const recorder = createCheckpointRecorder();
  const store = new MemoryProviderOperationLedgerStore();
  const firstGateway = createGatewayHandler(registry, store, recorder);
  const firstRequests: SubAgentTransportModelExchangeRequest[] = [];
  const firstAgent = createChildAgent(
    scenario,
    async (request) => {
      firstRequests.push(request);
      const reply = await firstGateway.handler.handle({
        ownerSessionId: OWNER_SESSION_ID,
        taskId: request.taskId,
        operationId: request.operationId,
        payload: request.payload,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (firstRequests.length === 2) {
        throw new Error('The attempt-two reply was lost after durable provider completion.');
      }
      return reply;
    },
    1,
  );
  const firstControl = createControl(recorder, { rejectTerminalFailure: true });

  await expect(
    firstAgent.runAsSubAgent({
      request: createChildRequest(undefined),
      control: firstControl.control,
      runnerId: RUNNER_ID,
      runnerVersion: RUNNER_VERSION,
      executorName: EXECUTOR_NAME,
      checkpointMode: 'durable',
      input: 'recover the second provider attempt after a lost reply',
      outputSchema: z.object({ proof: z.literal(PROOF) }).strict(),
    }),
  ).rejects.toMatchObject({
    descriptor: { causeCode: 'MODEL_OUTCOME_UNKNOWN', outcomeUnknown: true },
  });

  expect(firstRequests.map(({ payload }) => payload.requestAttempt)).toEqual([1, 2]);
  expect(scenario.sdkCreate).toHaveBeenCalledTimes(2);
  const lostRequest = firstRequests[1]!;
  const inFlightCheckpoint = [...recorder.checkpoints]
    .reverse()
    .find(
      ({ checkpoint }) =>
        checkpoint.modelOperation?.operationId === lostRequest.operationId &&
        checkpoint.modelOperation.phase === 'in_flight',
    );
  expect(inFlightCheckpoint?.checkpoint.modelOperation).toMatchObject({
    operationId: lostRequest.operationId,
    requestAttempt: 2,
    phase: 'in_flight',
  });
  await expect(
    new ProviderOperationLedger({ store }).load({
      ownerSessionId: OWNER_SESSION_ID,
      taskId: TASK_ID,
      providerOperationId: lostRequest.operationId,
    }),
  ).resolves.toMatchObject({ phase: 'completed' });

  const recoveryExecution = Object.freeze({
    attempt: RECOVERY_EXECUTION_ATTEMPT,
    epoch: RECOVERY_EXECUTION_EPOCH,
    fencingToken: RECOVERY_EXECUTION_FENCING_TOKEN,
  });
  const recoveryGateway = createGatewayHandler(registry, store, recorder, recoveryExecution);
  const recoveryRequests: SubAgentTransportModelExchangeRequest[] = [];
  const recoveryAgent = createChildAgent(scenario, async (request) => {
    recoveryRequests.push(request);
    return await recoveryGateway.handler.handle({
      ownerSessionId: OWNER_SESSION_ID,
      taskId: request.taskId,
      operationId: request.operationId,
      payload: request.payload,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  });
  const recoveryControl = createControl(recorder, { rejectTerminalFailure: false });
  const outcome = await recoveryAgent.runAsSubAgent({
    request: createChildRequest(inFlightCheckpoint!.checkpoint, recoveryExecution),
    control: recoveryControl.control,
    runnerId: RUNNER_ID,
    runnerVersion: RUNNER_VERSION,
    executorName: EXECUTOR_NAME,
    checkpointMode: 'durable',
    input: 'recover the second provider attempt after a lost reply',
    outputSchema: z.object({ proof: z.literal(PROOF) }).strict(),
  });

  expect(outcome).toMatchObject({
    type: 'terminal',
    result: { status: 'succeeded', output: { proof: PROOF } },
  });
  expect(recoveryRequests).toHaveLength(2);
  expect(recoveryRequests[0]).toMatchObject({
    operationId: lostRequest.operationId,
    payload: {
      providerOperationId: lostRequest.operationId,
      requestHash: lostRequest.payload.requestHash,
      requestAttempt: 2,
    },
  });
  expect(recoveryRequests[1]!.payload.requestAttempt).toBe(1);
  expect(recoveryGateway.reserved.map(({ providerOperationId }) => providerOperationId)).toEqual([
    recoveryRequests[1]!.operationId,
  ]);
  expect(scenario.sdkCreate).toHaveBeenCalledTimes(3);
  expect(controllerGenerate).toHaveBeenCalledTimes(3);
}

describe('durable child transport Model reply-loss recovery', () => {
  acceptanceIt(
    'C7-GATEWAY-24.l4.attempt-two-replay',
    'attempt-two-completed-reply-loss',
    async () => {
      await runSecondAttemptCompletedReplyLossScenario();
    },
  );

  acceptanceIt(
    'C7-GATEWAY-09.l4.chat-completed-replay',
    'chat-peer-reply-loss-new-execution-scope',
    async () => {
      await runCompletedReplyLossScenario(createChatScenario());
    },
  );

  acceptanceIt(
    'C7-GATEWAY-10.l4.responses-completed-replay',
    'responses-peer-reply-loss-new-execution-scope',
    async () => {
      await runCompletedReplyLossScenario(createResponsesScenario());
    },
  );

  acceptanceIt(
    'C7-GATEWAY-11.l4.provider-in-flight-unknown',
    'chat-peer-recovery-oracle-no-provider-resend',
    async () => {
      await runInFlightOutcomeUnknownScenario(createChatScenario());
    },
  );
});
