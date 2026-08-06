import { describe, expect, it } from 'vitest';
import { acceptanceIt } from '../../../testkit';

import {
  BUILTIN_AGENT_PROTOCOL_CHECKPOINT_CODECS,
  DEFAULT_ARTIFACT_LIMITS,
  DEFAULT_EXECUTOR_MAX_BINDING_BYTES,
  DEFAULT_SUBAGENT_IO_LIMITS,
  DEFAULT_SUBAGENT_LIMITS,
  DEFAULT_SUBAGENT_PROJECTION_LIMITS,
  OPENAI_CHAT_CHECKPOINT_CODEC,
  OPENAI_RESPONSES_CHECKPOINT_CODEC,
  type AgentRuntimeStateStore,
  type ArtifactReference,
  type ExecutorTaskHandle,
  type ModelSubAgentRequest,
  type StoredAgentRun,
  type StoredTask,
  type SubAgentChildCheckpoint,
  type SubAgentCompletionController,
  type SubAgentDelegationClient,
  type SubAgentExecutionControl,
  type SubAgentExecutionOutcome,
  type SubAgentExecutorOperation,
  type SubAgentRuntime,
  type SubAgentTaskHandle,
  type SubAgentTaskResult,
  type SubAgentTaskSnapshot,
} from '../src';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type _ModelWireKeys = Assert<Equal<keyof ModelSubAgentRequest, 'subAgent' | 'executor' | 'input'>>;
type _StateLookupScope = Assert<
  Equal<
    Parameters<AgentRuntimeStateStore['findTaskByIdempotencyKey']>,
    [ownerSessionId: string, runId: string, requestId: string]
  >
>;
type _RuntimeCancelResult = Assert<
  Equal<Awaited<ReturnType<SubAgentRuntime['cancel']>>, SubAgentTaskSnapshot>
>;
type _HostCancelResult = Assert<
  Equal<Awaited<ReturnType<SubAgentTaskHandle['cancel']>>, SubAgentTaskSnapshot>
>;
type _HostHandleHidesBinding = Assert<
  Equal<'binding' extends keyof SubAgentTaskHandle ? true : false, false>
>;
type _RawHandleHasBinding = Assert<
  Equal<'binding' extends keyof ExecutorTaskHandle ? true : false, true>
>;
type _ArtifactKeys = Assert<
  Equal<keyof ArtifactReference, 'version' | 'id' | 'mediaType' | 'size' | 'sha256'>
>;
type _RunMaxIterations = Assert<Equal<StoredAgentRun['maxIterations'], number | null>>;
type _RunConfigurationHash = Assert<Equal<StoredAgentRun['configurationHash'], string>>;
type _ChildResultSubmissionKeys = Assert<
  Equal<
    keyof NonNullable<SubAgentChildCheckpoint['resultSubmission']>,
    'version' | 'callId' | 'output' | 'outputHash'
  >
>;
type _StoredTaskHasFrozenLimits = Assert<
  Equal<StoredTask['limits'], Readonly<StoredTask['limits']>>
>;
type _AuthoritativeFailureResult = Assert<
  Equal<Awaited<ReturnType<SubAgentCompletionController['fail']>>, SubAgentTaskResult>
>;
type _DelegationPauseReceiptHasApprovals = Assert<
  Equal<
    keyof Awaited<ReturnType<SubAgentExecutionControl['pauseDelegation']>>,
    'checkpointRevision' | 'approvals'
  >
>;
type _DelegationResumeReturnsHostHandle = Assert<
  Equal<Awaited<ReturnType<SubAgentDelegationClient['resumeTool']>>, SubAgentTaskHandle>
>;
type ContractAssertions = [
  _ModelWireKeys,
  _StateLookupScope,
  _RuntimeCancelResult,
  _HostCancelResult,
  _HostHandleHidesBinding,
  _RawHandleHasBinding,
  _ArtifactKeys,
  _RunMaxIterations,
  _RunConfigurationHash,
  _ChildResultSubmissionKeys,
  _StoredTaskHasFrozenLimits,
  _AuthoritativeFailureResult,
  _DelegationPauseReceiptHasApprovals,
  _DelegationResumeReturnsHostHandle,
];

void (undefined as ContractAssertions | undefined);

const operations = [
  { type: 'create', operationId: 'operation-create', idempotencyKey: 'request-1' },
  {
    type: 'resume',
    operationId: 'operation-approval',
    reason: 'approval',
    binding: undefined as never,
    checkpoint: undefined as never,
    approvals: [],
  },
  {
    type: 'resume',
    operationId: 'operation-checkpoint',
    reason: 'checkpoint',
    binding: undefined as never,
    checkpoint: undefined as never,
  },
  { type: 'reconnect', operationId: 'operation-reconnect', binding: undefined as never },
] satisfies readonly SubAgentExecutorOperation[];

function terminalOutput(result: SubAgentTaskResult): unknown {
  return result.status === 'succeeded' ? result.output : result.partialOutput;
}

function pausedApprovals(outcome: SubAgentExecutionOutcome): number {
  return outcome.type === 'paused' ? outcome.approvals.length : 0;
}

describe('Subagent v2 contract surface', () => {
  it('freezes exact default limits', () => {
    expect(DEFAULT_SUBAGENT_LIMITS).toEqual({
      maxDepth: 3,
      maxDescendants: 32,
      maxConcurrent: 4,
      maxTurns: 16,
      timeoutMs: 120_000,
    });
    expect(DEFAULT_SUBAGENT_IO_LIMITS).toEqual({
      maxInputBytes: 256 * 1024,
      maxOutputBytes: 256 * 1024,
    });
    expect(DEFAULT_SUBAGENT_PROJECTION_LIMITS).toEqual({
      maxItems: 32,
      maxItemBytes: 64 * 1024,
      maxTotalBytes: 128 * 1024,
    });
    expect(DEFAULT_ARTIFACT_LIMITS).toEqual({
      maxItemBytes: 32 * 1024 * 1024,
      maxItemsPerTask: 8,
      maxTotalBytesPerTask: 128 * 1024 * 1024,
    });
    for (const value of [
      DEFAULT_SUBAGENT_LIMITS,
      DEFAULT_SUBAGENT_IO_LIMITS,
      DEFAULT_SUBAGENT_PROJECTION_LIMITS,
      DEFAULT_ARTIFACT_LIMITS,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('keeps operation, result and pause unions discriminated', () => {
    expect(operations.map(({ type }) => type)).toEqual(['create', 'resume', 'resume', 'reconnect']);
    expect(
      terminalOutput({
        status: 'succeeded',
        task: { taskId: 'task-1', subAgent: { name: 'worker', version: '2' } },
        executor: 'local',
        output: { ok: true },
      }),
    ).toEqual({ ok: true });
    expect(
      pausedApprovals({
        type: 'paused',
        reason: 'approval',
        task: { taskId: 'task-1', subAgent: { name: 'worker', version: '2' } },
        approvals: [],
        checkpointRevision: 1,
      }),
    ).toBe(0);
  });

  it('ships two strict versioned built-in protocol codecs', () => {
    expect(BUILTIN_AGENT_PROTOCOL_CHECKPOINT_CODECS).toEqual([
      OPENAI_CHAT_CHECKPOINT_CODEC,
      OPENAI_RESPONSES_CHECKPOINT_CODEC,
    ]);
    expect(Object.isFrozen(BUILTIN_AGENT_PROTOCOL_CHECKPOINT_CODECS)).toBe(true);
    expect(OPENAI_CHAT_CHECKPOINT_CODEC).toMatchObject({
      protocol: 'openai-chat',
      version: '1',
    });
    expect(OPENAI_RESPONSES_CHECKPOINT_CODEC).toMatchObject({
      protocol: 'openai-responses',
      version: '1',
    });

    const source = [{ role: 'user', content: 'hello' }] as const;
    const encoded = OPENAI_CHAT_CHECKPOINT_CODEC.encode(source);
    const decoded = OPENAI_CHAT_CHECKPOINT_CODEC.decode(encoded);
    expect(decoded).toEqual(source);
    expect(decoded).not.toBe(source);
    expect(() =>
      OPENAI_CHAT_CHECKPOINT_CODEC.encode([{ role: 'user', content: undefined }] as never),
    ).toThrow();
  });
});

acceptanceIt('CON-01.l1.runtime-contracts', 'contracts', () => {
  expect(operations).toHaveLength(4);
  expect(DEFAULT_SUBAGENT_IO_LIMITS.maxInputBytes).toBe(256 * 1024);
  expect(DEFAULT_EXECUTOR_MAX_BINDING_BYTES).toBe(64 * 1024);
  expect(BUILTIN_AGENT_PROTOCOL_CHECKPOINT_CODECS).toHaveLength(2);
});
