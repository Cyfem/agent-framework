import { isDeepStrictEqual } from 'node:util';

export type PendingBatchInvariantKind = 'tool' | 'agent' | 'end-agent';

export type PendingBatchInvariantStatus =
  | 'prepared'
  | 'in_flight'
  | 'waiting_approval'
  | 'result_ready'
  | 'result_submitted'
  | 'applied';

export interface PendingBatchInvariantCall {
  readonly kind: PendingBatchInvariantKind;
  readonly name: string;
  readonly status: PendingBatchInvariantStatus;
  readonly order: number;
  readonly taskId?: string;
  readonly approvalIds: readonly string[];
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface PendingBatchInvariantInput {
  readonly calls: readonly PendingBatchInvariantCall[];
  readonly endRequested: boolean;
  /** Child checkpoints, unlike root runs, require a typed result before successful end-agent. */
  readonly requireResultSubmissionForEnd?: boolean;
  /** A child agent-result receipt is complete only after the authoritative typed result CAS. */
  readonly requireResultSubmissionForCompletedAgentResult?: boolean;
  readonly resultSubmissionPresent?: boolean;
  /** Stored root calls retain the descriptor separately; child transport checkpoints do not. */
  readonly requireRejectedEndErrorDescriptor?: boolean;
  /** Approval resumes may decide a partial subset of the currently paused calls. */
  readonly approvalDecisionIds?: readonly string[];
}

export type PendingBatchInvariantFailure = (message: string) => never;

const READY_STATUSES = new Set<PendingBatchInvariantStatus>([
  'result_ready',
  'result_submitted',
  'applied',
]);

const ALLOWED_STATUSES = Object.freeze({
  agentResult: new Set<PendingBatchInvariantStatus>([
    'prepared',
    'in_flight',
    'result_submitted',
    'applied',
  ]),
  ordinaryTool: new Set<PendingBatchInvariantStatus>([
    'prepared',
    'in_flight',
    'waiting_approval',
    'result_ready',
    'applied',
  ]),
  agent: new Set<PendingBatchInvariantStatus>([
    'prepared',
    'in_flight',
    'waiting_approval',
    'result_ready',
    'applied',
  ]),
  endAgent: new Set<PendingBatchInvariantStatus>([
    'prepared',
    'in_flight',
    'result_ready',
    'applied',
  ]),
});

export const MIXED_END_AGENT_REJECTION_ERROR = Object.freeze({
  code: 'END_AGENT_MUST_BE_STANDALONE',
  message: 'end-agent must be the only Tool call in its provider batch.',
  retryable: false,
});

export const MIXED_END_AGENT_REJECTION_RESULT = Object.freeze({
  ok: false,
  error: MIXED_END_AGENT_REJECTION_ERROR,
});

/**
 * Enforces the production Tool-batch state machine after representation-specific shape checks.
 * The callback keeps transport, child migration and root restore error domains independent.
 */
export function assertPendingBatchInvariants(
  input: PendingBatchInvariantInput,
  fail: PendingBatchInvariantFailure,
): void {
  const { calls } = input;
  const batchApprovalIds = new Set<string>();
  const agentTaskIds = new Set<string>();

  for (const [index, call] of calls.entries()) {
    if (call.order !== index) {
      fail(`Pending Tool call ${index} is not in provider order.`);
    }
    if (
      (call.kind === 'agent') !== (call.name === 'agent') ||
      (call.kind === 'end-agent') !== (call.name === 'end-agent')
    ) {
      fail(`Pending Tool call ${index} has an invalid kind/name identity.`);
    }

    const role =
      call.kind === 'agent'
        ? 'agent'
        : call.kind === 'end-agent'
          ? 'endAgent'
          : call.name === 'agent-result'
            ? 'agentResult'
            : 'ordinaryTool';
    if (!ALLOWED_STATUSES[role].has(call.status)) {
      fail(`Pending Tool call ${index} has an unreachable ${role} phase.`);
    }

    if (call.kind !== 'agent' && call.taskId !== undefined) {
      fail(`Pending Tool call ${index} cannot retain a subagent taskId.`);
    }
    if (call.kind === 'agent') {
      if (call.status === 'prepared' && call.taskId !== undefined) {
        fail(`Prepared agent Tool call ${index} cannot already have a taskId.`);
      }
      if (
        (call.status === 'in_flight' || call.status === 'waiting_approval') &&
        call.taskId === undefined
      ) {
        fail(`Active agent Tool call ${index} requires its durable taskId.`);
      }
      if (call.taskId !== undefined) {
        if (agentTaskIds.has(call.taskId)) {
          fail('Agent Tool calls in one provider batch cannot share a taskId.');
        }
        agentTaskIds.add(call.taskId);
      }
    }

    if (new Set(call.approvalIds).size !== call.approvalIds.length) {
      fail(`Pending Tool call ${index} contains duplicate approval IDs.`);
    }
    for (const approvalId of call.approvalIds) {
      if (batchApprovalIds.has(approvalId)) {
        fail('Pending Tool calls in one provider batch cannot share an approval ID.');
      }
      batchApprovalIds.add(approvalId);
    }
    if (call.status === 'waiting_approval') {
      if (call.kind === 'agent') {
        if (call.approvalIds.length === 0) {
          fail(`Paused agent Tool call ${index} requires at least one approval ID.`);
        }
      } else if (call.approvalIds.length !== 1) {
        fail(`Paused ordinary Tool call ${index} requires exactly one approval ID.`);
      }
    } else if (call.approvalIds.length > 0) {
      fail(`Non-paused Tool call ${index} cannot retain approval IDs.`);
    }
  }

  assertEndState(input, fail);
  if (
    input.requireResultSubmissionForCompletedAgentResult &&
    !input.resultSubmissionPresent &&
    calls.some(
      (call) =>
        call.kind === 'tool' &&
        call.name === 'agent-result' &&
        (call.status === 'result_submitted' || call.status === 'applied'),
    )
  ) {
    fail('A completed child agent-result call requires its typed result submission.');
  }
  assertBatchProgression(calls, fail);

  if (input.approvalDecisionIds !== undefined) {
    const pausedApprovalIds = new Set(
      calls.flatMap((call) => (call.status === 'waiting_approval' ? [...call.approvalIds] : [])),
    );
    const decisions = new Set<string>();
    for (const approvalId of input.approvalDecisionIds) {
      if (decisions.has(approvalId)) {
        fail('An approval resume cannot repeat an approval decision ID.');
      }
      decisions.add(approvalId);
      if (!pausedApprovalIds.has(approvalId)) {
        fail('An approval resume decision must belong to a pending paused Tool call.');
      }
    }
  }
}

function assertEndState(
  input: PendingBatchInvariantInput,
  fail: PendingBatchInvariantFailure,
): void {
  const endCalls = input.calls.filter((call) => call.kind === 'end-agent');
  if (input.endRequested) {
    if (
      input.calls.length !== 1 ||
      endCalls.length !== 1 ||
      (endCalls[0]!.status !== 'result_ready' && endCalls[0]!.status !== 'applied')
    ) {
      fail('A requested end-agent batch must be standalone and result-ready.');
    }
    if (input.requireResultSubmissionForEnd && !input.resultSubmissionPresent) {
      fail('A completed child end-agent batch requires its typed result submission.');
    }
    return;
  }

  if (endCalls.length === 0) return;
  const validStandalonePendingEnd =
    input.calls.length === 1 &&
    endCalls.length === 1 &&
    (endCalls[0]!.status === 'prepared' || endCalls[0]!.status === 'in_flight');
  const validRejectedMixedEnds =
    input.calls.length > 1 &&
    endCalls.every(
      (call) =>
        (call.status === 'result_ready' || call.status === 'applied') &&
        isDeepStrictEqual(call.result, MIXED_END_AGENT_REJECTION_RESULT) &&
        (!input.requireRejectedEndErrorDescriptor ||
          isDeepStrictEqual(call.error, MIXED_END_AGENT_REJECTION_ERROR)),
    );
  if (!validStandalonePendingEnd && !validRejectedMixedEnds) {
    fail(
      'A non-requested end-agent call must be standalone and pending, or a settled member of a rejected mixed batch.',
    );
  }
}

function assertBatchProgression(
  calls: readonly PendingBatchInvariantCall[],
  fail: PendingBatchInvariantFailure,
): void {
  if (calls.some((call) => call.status === 'applied')) {
    let reachedReadySuffix = false;
    for (const [index, call] of calls.entries()) {
      if (call.status === 'applied') {
        if (reachedReadySuffix) {
          fail(
            `Applied Tool calls must form a provider-order prefix; call ${index} is out of phase.`,
          );
        }
        continue;
      }
      reachedReadySuffix = true;
      if (!READY_STATUSES.has(call.status)) {
        fail('No Tool call may remain unresolved after provider-order result application begins.');
      }
    }
  } else {
    let activeToolSeen = false;
    let preparedToolSeen = false;
    for (const [index, call] of calls.entries()) {
      if (call.kind !== 'tool') continue;
      if (READY_STATUSES.has(call.status)) {
        if (activeToolSeen || preparedToolSeen) {
          fail(`Ordinary Tool call ${index} settled before an earlier serial Tool call.`);
        }
        continue;
      }
      if (call.status === 'prepared') {
        preparedToolSeen = true;
        continue;
      }
      if (activeToolSeen || preparedToolSeen) {
        fail(`Ordinary Tool call ${index} started before its serial predecessor settled.`);
      }
      activeToolSeen = true;
    }
  }

  const toolsReady = calls
    .filter((call) => call.kind === 'tool')
    .every((call) => READY_STATUSES.has(call.status));
  if (!toolsReady && calls.some((call) => call.kind === 'agent' && call.status !== 'prepared')) {
    fail('The agent sub-batch cannot start before every ordinary Tool result is ready.');
  }
}
