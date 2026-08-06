import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acceptanceIt } from '../../../testkit';

import {
  BUILTIN_AGENT_PROTOCOL_CHECKPOINT_CODECS,
  DEFAULT_ARTIFACT_LIMITS,
  DEFAULT_SUBAGENT_IO_LIMITS,
  DEFAULT_SUBAGENT_LIMITS,
  DEFAULT_SUBAGENT_PROJECTION_LIMITS,
  JsonValueError,
  NOOP_AGENT_TELEMETRY_SINK,
  OPENAI_CHAT_CHECKPOINT_CODEC,
  OPENAI_RESPONSES_CHECKPOINT_CODEC,
  RESOURCE_NOT_FOUND_ERROR,
  SUBAGENT_ERROR_CODES,
  SUBAGENT_TRANSPORT_CONTROL_METHODS,
  SUBAGENT_TRANSPORT_RPC_KINDS,
  SubAgentTransportPeer,
  SubAgentRuntimeError,
  TERMINAL_SUBAGENT_TASK_STATES,
  assertArtifactReference,
  assertJsonValue,
  assertSubAgentTaskTransition,
  canonicalJsonSha256,
  canonicalizeJson,
  createResourceNotFoundError,
  createSubAgentTransportArtifactSidecar,
  createSubAgentTransportControlDispatcher,
  createSubAgentTransportPeerWriterAdmission,
  createSubAgentTransportRpcEnvelope,
  createStoredTaskIdempotently,
  commitRuntimeStateMutation,
  defineSubAgent,
  isJsonValue,
  isTerminalSubAgentTaskState,
  measureCanonicalJsonBytes,
  parseJsonValue,
  resolveSubAgentLimits,
  type AgentCheckpointMigrator,
  type AgentProtocolCheckpointCodec,
  type AgentRunOutcome,
  type AgentRuntimeStateStore,
  type AgentTelemetrySink,
  type ArtifactReference,
  type ArtifactStore,
  type ApprovalDecisionRecord,
  type ExecutorTaskHandle,
  type JsonValue,
  type ModelSubAgentRequest,
  type StateLease,
  type RuntimeStateMutation,
  type SubAgentChildRunner,
  type SubAgentDefinition,
  type SubAgentErrorDescriptor,
  type SubAgentExecutionControl,
  type SubAgentExecutor,
  type SubAgentRuntime,
  type SubAgentTaskHandle,
  type SubAgentTransportArtifactSidecar,
  type SubAgentTransportControlExchangeContext,
  type SubAgentTransportControlReply,
  type SubAgentTransportControlRequest,
  type SubAgentTransportExecutionOutcome,
  type SubAgentTransportExecutorOperationResult,
  type SubAgentTransportFailureInput,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportPeerWriterAdmission,
  type SubAgentTransportRpcEnvelope,
  type SubAgentTransportRpcReplyEnvelope,
  type SubAgentTransportRpcRequestEnvelope,
  type SubAgentTransportSafeError,
  type SubAgentTransportTaskResult,
  type SubAgentTransportTaskSnapshot,
  type ToolRuntimeContext,
} from '../src';

const publicValues = [
  BUILTIN_AGENT_PROTOCOL_CHECKPOINT_CODECS,
  DEFAULT_ARTIFACT_LIMITS,
  DEFAULT_SUBAGENT_IO_LIMITS,
  DEFAULT_SUBAGENT_LIMITS,
  DEFAULT_SUBAGENT_PROJECTION_LIMITS,
  JsonValueError,
  NOOP_AGENT_TELEMETRY_SINK,
  OPENAI_CHAT_CHECKPOINT_CODEC,
  OPENAI_RESPONSES_CHECKPOINT_CODEC,
  RESOURCE_NOT_FOUND_ERROR,
  SUBAGENT_ERROR_CODES,
  SUBAGENT_TRANSPORT_CONTROL_METHODS,
  SUBAGENT_TRANSPORT_RPC_KINDS,
  SubAgentTransportPeer,
  SubAgentRuntimeError,
  TERMINAL_SUBAGENT_TASK_STATES,
  assertArtifactReference,
  assertJsonValue,
  assertSubAgentTaskTransition,
  canonicalJsonSha256,
  canonicalizeJson,
  createResourceNotFoundError,
  createSubAgentTransportArtifactSidecar,
  createSubAgentTransportControlDispatcher,
  createSubAgentTransportPeerWriterAdmission,
  createSubAgentTransportRpcEnvelope,
  createStoredTaskIdempotently,
  commitRuntimeStateMutation,
  defineSubAgent,
  isJsonValue,
  isTerminalSubAgentTaskState,
  measureCanonicalJsonBytes,
  parseJsonValue,
  resolveSubAgentLimits,
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
  | ExecutorTaskHandle
  | JsonValue
  | ModelSubAgentRequest
  | RuntimeStateMutation
  | StateLease
  | SubAgentChildRunner
  | SubAgentDefinition
  | SubAgentExecutionControl
  | SubAgentExecutor
  | SubAgentRuntime
  | SubAgentTaskHandle
  | SubAgentTransportArtifactSidecar
  | SubAgentTransportControlExchangeContext
  | SubAgentTransportControlReply
  | SubAgentTransportControlRequest
  | SubAgentTransportExecutionOutcome
  | SubAgentTransportExecutorOperationResult
  | SubAgentTransportFailureInput
  | SubAgentTransportPeerPacket
  | SubAgentTransportPeerWriterAdmission
  | SubAgentTransportRpcEnvelope
  | SubAgentTransportRpcReplyEnvelope
  | SubAgentTransportRpcRequestEnvelope
  | SubAgentTransportSafeError
  | SubAgentTransportTaskResult
  | SubAgentTransportTaskSnapshot
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
