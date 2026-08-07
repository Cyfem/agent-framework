import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acceptanceIt } from '../../../testkit';

import {
  BUILTIN_AGENT_PROTOCOL_CHECKPOINT_CODECS,
  DEFAULT_PROVIDER_OPERATION_CAS_RETRIES,
  DEFAULT_ARTIFACT_LIMITS,
  DEFAULT_SUBAGENT_IO_LIMITS,
  DEFAULT_SUBAGENT_LIMITS,
  DEFAULT_SUBAGENT_PROJECTION_LIMITS,
  JsonValueError,
  MemoryProviderOperationLedgerStore,
  NOOP_AGENT_TELEMETRY_SINK,
  OPENAI_CHAT_CHECKPOINT_CODEC,
  OPENAI_RESPONSES_CHECKPOINT_CODEC,
  PROVIDER_OPERATION_RECORD_VERSION,
  RESOURCE_NOT_FOUND_ERROR,
  SUBAGENT_ERROR_CODES,
  SUBAGENT_TRANSPORT_CONTROL_METHODS,
  SUBAGENT_TRANSPORT_RPC_KINDS,
  ProviderOperationLedger,
  SubAgentTargetRunnerRegistry,
  SubAgentTransportExecutorBridge,
  SubAgentTransportModelGatewayHandler,
  SubAgentTransportModelGatewayRegistry,
  SubAgentTransportPeer,
  SubAgentTransportTargetBridge,
  SubAgentTransportTaskHandleRegistry,
  SubAgentRuntimeError,
  TERMINAL_SUBAGENT_TASK_STATES,
  assertArtifactReference,
  assertJsonValue,
  assertSubAgentTaskTransition,
  canonicalJsonSha256,
  canonicalizeJson,
  createOpenAIChatProtocolSurface,
  createOpenAIResponsesProtocolSurface,
  createResourceNotFoundError,
  createSubAgentTransportArtifactSidecar,
  createSubAgentTransportControlDispatcher,
  createSubAgentTransportExecutorBridge,
  createSubAgentTransportModelCanonicalRequest,
  createSubAgentTransportModelProxy,
  createSubAgentTransportPeerWriterAdmission,
  createSubAgentTransportRpcEnvelope,
  createSubAgentTransportTargetBridge,
  createStoredTaskIdempotently,
  commitRuntimeStateMutation,
  defineSubAgent,
  hashSubAgentTransportModelRequest,
  isJsonValue,
  isSubAgentTransportModelProxy,
  isTerminalSubAgentTaskState,
  measureCanonicalJsonBytes,
  normalizeProviderOperationRecord,
  parseJsonValue,
  resolveSubAgentLimits,
  resolveSubAgentTaskHandle,
  rememberExecutorTaskHandle,
  rememberSubAgentTaskHandle,
  type AgentCheckpointMigrator,
  type AgentProtocolCheckpointCodec,
  type AgentRunOutcome,
  type AgentRuntimeStateStore,
  type AgentTelemetrySink,
  type ArtifactReference,
  type ArtifactStore,
  type ApprovalDecisionRecord,
  type CreateSubAgentTransportExecutorBridgeOptions,
  type CreateSubAgentTransportTargetBridgeOptions,
  type ExecutorTaskHandle,
  type JsonValue,
  type ModelSubAgentRequest,
  type ProviderOperationIdentity,
  type ProviderOperationLedgerStore,
  type StateLease,
  type RuntimeStateMutation,
  type SubAgentChildRunner,
  type SubAgentDefinition,
  type SubAgentErrorDescriptor,
  type SubAgentExecutionControl,
  type SubAgentExecutor,
  type SubAgentRuntime,
  type SubAgentTargetRunnerRegistration,
  type SubAgentTaskHandle,
  type SubAgentTransportArtifactSidecar,
  type SubAgentTransportControlExchangeContext,
  type SubAgentTransportControlReply,
  type SubAgentTransportControlRequest,
  type SubAgentTransportExecutionOutcome,
  type SubAgentTransportExecutorOperationResult,
  type SubAgentTransportFailureInput,
  type SubAgentTransportModelGatewayOperation,
  type SubAgentTransportModelProtocolSurface,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportPeerWriterAdmission,
  type SubAgentTransportRpcEnvelope,
  type SubAgentTransportRpcReplyEnvelope,
  type SubAgentTransportRpcRequestEnvelope,
  type SubAgentTransportSafeError,
  type SubAgentTransportTaskResult,
  type SubAgentTransportTaskSnapshot,
  type SubAgentTransportTaskHandleRegistryOptions,
  type ToolRuntimeContext,
} from '../src';

const publicValues = [
  BUILTIN_AGENT_PROTOCOL_CHECKPOINT_CODECS,
  DEFAULT_PROVIDER_OPERATION_CAS_RETRIES,
  DEFAULT_ARTIFACT_LIMITS,
  DEFAULT_SUBAGENT_IO_LIMITS,
  DEFAULT_SUBAGENT_LIMITS,
  DEFAULT_SUBAGENT_PROJECTION_LIMITS,
  JsonValueError,
  MemoryProviderOperationLedgerStore,
  NOOP_AGENT_TELEMETRY_SINK,
  OPENAI_CHAT_CHECKPOINT_CODEC,
  OPENAI_RESPONSES_CHECKPOINT_CODEC,
  PROVIDER_OPERATION_RECORD_VERSION,
  RESOURCE_NOT_FOUND_ERROR,
  SUBAGENT_ERROR_CODES,
  SUBAGENT_TRANSPORT_CONTROL_METHODS,
  SUBAGENT_TRANSPORT_RPC_KINDS,
  ProviderOperationLedger,
  SubAgentTargetRunnerRegistry,
  SubAgentTransportExecutorBridge,
  SubAgentTransportModelGatewayHandler,
  SubAgentTransportModelGatewayRegistry,
  SubAgentTransportPeer,
  SubAgentTransportTargetBridge,
  SubAgentTransportTaskHandleRegistry,
  SubAgentRuntimeError,
  TERMINAL_SUBAGENT_TASK_STATES,
  assertArtifactReference,
  assertJsonValue,
  assertSubAgentTaskTransition,
  canonicalJsonSha256,
  canonicalizeJson,
  createOpenAIChatProtocolSurface,
  createOpenAIResponsesProtocolSurface,
  createResourceNotFoundError,
  createSubAgentTransportArtifactSidecar,
  createSubAgentTransportControlDispatcher,
  createSubAgentTransportExecutorBridge,
  createSubAgentTransportModelCanonicalRequest,
  createSubAgentTransportModelProxy,
  createSubAgentTransportPeerWriterAdmission,
  createSubAgentTransportRpcEnvelope,
  createSubAgentTransportTargetBridge,
  createStoredTaskIdempotently,
  commitRuntimeStateMutation,
  defineSubAgent,
  hashSubAgentTransportModelRequest,
  isJsonValue,
  isSubAgentTransportModelProxy,
  isTerminalSubAgentTaskState,
  measureCanonicalJsonBytes,
  normalizeProviderOperationRecord,
  parseJsonValue,
  resolveSubAgentLimits,
  resolveSubAgentTaskHandle,
  rememberExecutorTaskHandle,
  rememberSubAgentTaskHandle,
];

type PublicContractTypes =
  | AgentCheckpointMigrator
  | AgentProtocolCheckpointCodec
  | AgentRunOutcome<never>
  | AgentRuntimeStateStore
  | AgentTelemetrySink
  | ArtifactReference
  | ArtifactStore
  | ApprovalDecisionRecord
  | CreateSubAgentTransportExecutorBridgeOptions
  | CreateSubAgentTransportTargetBridgeOptions
  | ExecutorTaskHandle
  | JsonValue
  | ModelSubAgentRequest
  | ProviderOperationIdentity
  | ProviderOperationLedgerStore
  | RuntimeStateMutation
  | StateLease
  | SubAgentChildRunner
  | SubAgentDefinition
  | SubAgentExecutionControl
  | SubAgentExecutor
  | SubAgentRuntime
  | SubAgentTargetRunnerRegistration
  | SubAgentTaskHandle
  | SubAgentTransportArtifactSidecar
  | SubAgentTransportControlExchangeContext
  | SubAgentTransportControlReply
  | SubAgentTransportControlRequest
  | SubAgentTransportExecutionOutcome
  | SubAgentTransportExecutorOperationResult
  | SubAgentTransportFailureInput
  | SubAgentTransportModelGatewayOperation
  | SubAgentTransportModelProtocolSurface<never>
  | SubAgentTransportPeerPacket
  | SubAgentTransportPeerWriterAdmission
  | SubAgentTransportRpcEnvelope
  | SubAgentTransportRpcReplyEnvelope
  | SubAgentTransportRpcRequestEnvelope
  | SubAgentTransportSafeError
  | SubAgentTransportTaskResult
  | SubAgentTransportTaskSnapshot
  | SubAgentTransportTaskHandleRegistryOptions<{ readonly taskId: string }>
  | ToolRuntimeContext;

void (undefined as PublicContractTypes | undefined);

const transportFailureMustNotExposeEventCursor: SubAgentTransportFailureInput = {
  status: 'failed',
  error: {
    code: 'EXECUTOR_FAILED',
    message: 'The child execution failed.',
    retryable: false,
    // @ts-expect-error -- event cursors remain host-local and are not part of the public wire.
    eventCursor: 3,
  },
};
void transportFailureMustNotExposeEventCursor;

function assertHostErrorRequiresProjection(
  hostErrorWithOptionalEventCursor: SubAgentErrorDescriptor,
): void {
  // @ts-expect-error -- host descriptors cannot be assigned to the wire even when the cursor is absent at runtime.
  const transportErrorMustBeExplicitlyProjected: SubAgentTransportSafeError =
    hostErrorWithOptionalEventCursor;
  void transportErrorMustBeExplicitlyProjected;
}
void assertHostErrorRequiresProjection;

describe('Subagent v2 package root', () => {
  it('exports the implemented runtime and transport values from the public root', () => {
    expect(publicValues.every((value) => value !== undefined)).toBe(true);
  });

  it('sets the Core release line to 2.0.0', async () => {
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      version?: string;
    };
    expect(manifest.version).toBe('2.0.0');
  });
});

acceptanceIt('API-02.l0.public-contracts', 'public-api', () => {
  expect(publicValues.every((value) => value !== undefined)).toBe(true);
});

acceptanceIt('C7-GATEWAY-01.l0.public-contracts', 'gateway-public-api', () => {
  expect(publicValues.every((value) => value !== undefined)).toBe(true);

  const chat = createOpenAIChatProtocolSurface();
  const responses = createOpenAIResponsesProtocolSurface();
  expect(chat.checkpointCodec.protocol).toBe('openai-chat');
  expect(responses.checkpointCodec.protocol).toBe('openai-responses');
  expect('generate' in chat).toBe(false);
  expect('generate' in responses).toBe(false);
  expect(Object.isFrozen(chat)).toBe(true);
  expect(Object.isFrozen(responses)).toBe(true);
});

it('requires a sealed gateway registry before constructing the public handler', () => {
  const registry = new SubAgentTransportModelGatewayRegistry();
  const ledger = new ProviderOperationLedger({
    store: new MemoryProviderOperationLedgerStore(),
  });

  expect(
    () =>
      new SubAgentTransportModelGatewayHandler({
        registry,
        ledger,
        acknowledgeCheckpoint: () => ({
          checkpointRevision: 1,
          checkpointDigest: 'a'.repeat(64),
        }),
        reserveBudget: () => undefined,
      }),
  ).toThrow(/sealed/u);

  registry.seal();
  expect(
    new SubAgentTransportModelGatewayHandler({
      registry,
      ledger,
      acknowledgeCheckpoint: () => ({
        checkpointRevision: 1,
        checkpointDigest: 'a'.repeat(64),
      }),
      reserveBudget: () => undefined,
    }),
  ).toBeInstanceOf(SubAgentTransportModelGatewayHandler);
});

acceptanceIt('C7-GATEWAY-07.l1.rpc-14-kind', 'rpc-14-kind', () => {
  expect(SUBAGENT_TRANSPORT_RPC_KINDS).toEqual([
    'executor.request',
    'executor.accepted',
    'executor.settled',
    'control.request',
    'control.reply',
    'cancel.request',
    'cancel.ack',
    'snapshot.request',
    'snapshot.reply',
    'events.request',
    'events.page',
    'model.request',
    'model.reply',
    'protocol.error',
  ]);
  expect(SUBAGENT_TRANSPORT_RPC_KINDS).toHaveLength(14);
});
