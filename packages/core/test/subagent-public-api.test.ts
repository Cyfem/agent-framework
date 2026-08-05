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
  SubAgentRuntimeError,
  assertArtifactReference,
  assertJsonValue,
  canonicalJsonSha256,
  canonicalizeJson,
  createResourceNotFoundError,
  defineSubAgent,
  isJsonValue,
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
  type ExecutorTaskHandle,
  type JsonValue,
  type ModelSubAgentRequest,
  type StateLease,
  type SubAgentChildRunner,
  type SubAgentDefinition,
  type SubAgentExecutionControl,
  type SubAgentExecutor,
  type SubAgentRuntime,
  type SubAgentTaskHandle,
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
  SubAgentRuntimeError,
  assertArtifactReference,
  assertJsonValue,
  canonicalJsonSha256,
  canonicalizeJson,
  createResourceNotFoundError,
  defineSubAgent,
  isJsonValue,
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
  | ExecutorTaskHandle
  | JsonValue
  | ModelSubAgentRequest
  | StateLease
  | SubAgentChildRunner
  | SubAgentDefinition
  | SubAgentExecutionControl
  | SubAgentExecutor
  | SubAgentRuntime
  | SubAgentTaskHandle
  | ToolRuntimeContext;

void (undefined as PublicContractTypes | undefined);

describe('Subagent v2 package root', () => {
  it('exports all C2 runtime values from the public root', () => {
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
