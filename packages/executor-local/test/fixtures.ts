import {
  canonicalJsonSha256,
  type StateLease,
  type StoredAgentRun,
  type StoredTask,
} from '@ruixutong.manee/maneeagent-framework';

export const SESSION_ID = 'local-store-session';
export const RUN_ID = 'local-store-run';

export function createRun(overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    recordVersion: '1',
    ownerSessionId: SESSION_ID,
    runId: RUN_ID,
    status: 'running',
    revision: 0,
    fencingToken: '0',
    agentCheckpointVersion: '1',
    protocolContext: { protocol: 'openai-chat', codecVersion: '1', value: [] },
    contextStore: {
      version: '1',
      protocol: 'openai-chat',
      codecVersion: '1',
      revision: 0,
      rawHistory: [],
      activeSpans: [],
      nextRawItemId: 1,
      nextSpanId: 1,
      nextEntryId: 1,
    },
    modelIteration: 0,
    maxIterations: 10,
    budget: {
      descendantsCreated: 0,
      activeExecutions: 0,
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    pendingApprovals: [],
    endRequested: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

export function createTask(lease: StateLease, overrides: Partial<StoredTask> = {}): StoredTask {
  const input = { value: 'proof' };
  return {
    recordVersion: '1',
    ownerSessionId: SESSION_ID,
    runId: RUN_ID,
    taskId: 'local-task-1',
    subagentSessionId: 'local-child-session-1',
    requestId: 'local-request-1',
    idempotencyKey: 'local-request-1',
    definition: { name: 'researcher', version: '2' },
    executor: 'local',
    input,
    inputHash: canonicalJsonSha256(input),
    projectedContext: [],
    state: 'queued',
    revision: 0,
    fencingToken: lease.fencingToken,
    path: ['local-task-1'],
    depth: 1,
    attempt: 1,
    approvals: [],
    approvalDecisions: [],
    controlOperations: [],
    recoveryRequired: false,
    activeElapsedMs: 0,
    remainingMs: 120_000,
    eventSequence: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}
