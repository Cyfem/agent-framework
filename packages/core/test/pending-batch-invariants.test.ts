import { describe, expect, it } from 'vitest';

import {
  assertPendingBatchInvariants,
  type PendingBatchInvariantCall,
  type PendingBatchInvariantInput,
} from '../src/subagent/pending-batch-invariants';

const REJECTED_MIXED_END_ERROR = Object.freeze({
  code: 'END_AGENT_MUST_BE_STANDALONE',
  message: 'end-agent must be the only Tool call in its provider batch.',
  retryable: false,
});
const REJECTED_MIXED_END_RESULT = Object.freeze({
  ok: false,
  error: REJECTED_MIXED_END_ERROR,
});

function pendingCall(
  overrides: Partial<PendingBatchInvariantCall> = {},
): PendingBatchInvariantCall {
  return Object.freeze({
    kind: 'tool' as const,
    name: 'lookup',
    status: 'prepared' as const,
    order: 0,
    approvalIds: Object.freeze([]),
    ...overrides,
  });
}

function validate(input: PendingBatchInvariantInput): void {
  assertPendingBatchInvariants(input, (message): never => {
    throw new Error(message);
  });
}

describe('pending Tool-batch production invariants', () => {
  it('accepts every reachable per-kind phase with exact task and approval ownership', () => {
    const fixtures: readonly PendingBatchInvariantInput[] = [
      { calls: [], endRequested: false },
      ...(['prepared', 'in_flight', 'result_submitted', 'applied'] as const).map((status) => ({
        calls: [
          pendingCall({
            name: 'agent-result',
            status,
          }),
        ],
        endRequested: false,
      })),
      ...(['prepared', 'in_flight', 'result_ready', 'applied'] as const).map((status) => ({
        calls: [pendingCall({ status })],
        endRequested: false,
      })),
      {
        calls: [pendingCall({ status: 'waiting_approval', approvalIds: ['approval-tool'] })],
        endRequested: false,
      },
      {
        calls: [pendingCall({ kind: 'agent', name: 'agent' })],
        endRequested: false,
      },
      {
        calls: [
          pendingCall({ kind: 'agent', name: 'agent', status: 'in_flight', taskId: 'task-1' }),
        ],
        endRequested: false,
      },
      {
        calls: [
          pendingCall({
            kind: 'agent',
            name: 'agent',
            status: 'waiting_approval',
            taskId: 'task-1',
            approvalIds: ['approval-1', 'approval-2'],
          }),
        ],
        endRequested: false,
      },
      ...(['result_ready', 'applied'] as const).map((status) => ({
        calls: [pendingCall({ kind: 'agent' as const, name: 'agent', status })],
        endRequested: false,
      })),
      ...(['prepared', 'in_flight'] as const).map((status) => ({
        calls: [pendingCall({ kind: 'end-agent' as const, name: 'end-agent', status })],
        endRequested: false,
      })),
      ...(['result_ready', 'applied'] as const).map((status) => ({
        calls: [pendingCall({ kind: 'end-agent' as const, name: 'end-agent', status })],
        endRequested: true,
        requireResultSubmissionForEnd: true,
        resultSubmissionPresent: true,
      })),
    ];

    for (const fixture of fixtures) expect(() => validate(fixture)).not.toThrow();
  });

  it('rejects unreachable per-kind phases, task ownership and approval cardinality', () => {
    const invalid: readonly PendingBatchInvariantInput[] = [
      {
        calls: [pendingCall({ name: 'agent-result', status: 'result_ready' })],
        endRequested: false,
      },
      {
        calls: [
          pendingCall({
            name: 'agent-result',
            status: 'waiting_approval',
            approvalIds: ['approval-1'],
          }),
        ],
        endRequested: false,
      },
      {
        calls: [pendingCall({ status: 'result_submitted' })],
        endRequested: false,
      },
      {
        calls: [pendingCall({ kind: 'agent', name: 'agent', status: 'result_submitted' })],
        endRequested: false,
      },
      {
        calls: [pendingCall({ taskId: 'foreign-task' })],
        endRequested: false,
      },
      {
        calls: [pendingCall({ kind: 'agent', name: 'agent', taskId: 'too-early' })],
        endRequested: false,
      },
      {
        calls: [pendingCall({ kind: 'agent', name: 'agent', status: 'in_flight' })],
        endRequested: false,
      },
      {
        calls: [
          pendingCall({
            status: 'waiting_approval',
            approvalIds: ['approval-1', 'approval-2'],
          }),
        ],
        endRequested: false,
      },
      {
        calls: [
          pendingCall({
            kind: 'agent',
            name: 'agent',
            status: 'waiting_approval',
            taskId: 'task-1',
          }),
        ],
        endRequested: false,
      },
    ];

    for (const fixture of invalid) expect(() => validate(fixture)).toThrow();
  });

  it('enforces serial Tool, delayed agent-sub-batch and provider-order apply progression', () => {
    const legal: readonly PendingBatchInvariantInput[] = [
      {
        calls: [
          pendingCall({ status: 'result_ready' }),
          pendingCall({ status: 'in_flight', order: 1, name: 'second-tool' }),
          pendingCall({ kind: 'agent', name: 'agent', order: 2 }),
        ],
        endRequested: false,
      },
      {
        calls: [
          pendingCall(),
          pendingCall({
            kind: 'end-agent',
            name: 'end-agent',
            status: 'result_ready',
            order: 1,
            result: REJECTED_MIXED_END_RESULT,
          }),
        ],
        endRequested: false,
      },
      {
        calls: [
          pendingCall({ status: 'result_ready' }),
          pendingCall({
            kind: 'agent',
            name: 'agent',
            status: 'in_flight',
            order: 1,
            taskId: 'task-1',
          }),
          pendingCall({ kind: 'agent', name: 'agent', order: 2 }),
        ],
        endRequested: false,
      },
      {
        calls: [
          pendingCall({ status: 'applied' }),
          pendingCall({ kind: 'agent', name: 'agent', status: 'result_ready', order: 1 }),
        ],
        endRequested: false,
      },
    ];
    for (const fixture of legal) expect(() => validate(fixture)).not.toThrow();

    const invalid: readonly PendingBatchInvariantInput[] = [
      {
        calls: [
          pendingCall(),
          pendingCall({ status: 'result_ready', order: 1, name: 'second-tool' }),
        ],
        endRequested: false,
      },
      {
        calls: [
          pendingCall({ status: 'in_flight' }),
          pendingCall({ status: 'in_flight', order: 1, name: 'second-tool' }),
        ],
        endRequested: false,
      },
      {
        calls: [
          pendingCall(),
          pendingCall({
            kind: 'agent',
            name: 'agent',
            status: 'in_flight',
            order: 1,
            taskId: 'task-1',
          }),
        ],
        endRequested: false,
      },
      {
        calls: [
          pendingCall({ status: 'result_ready' }),
          pendingCall({ kind: 'agent', name: 'agent', status: 'applied', order: 1 }),
        ],
        endRequested: false,
      },
      {
        calls: [
          pendingCall({ status: 'applied' }),
          pendingCall({ kind: 'agent', name: 'agent', order: 1 }),
        ],
        endRequested: false,
      },
    ];
    for (const fixture of invalid) expect(() => validate(fixture)).toThrow();

    expect(() =>
      validate({
        calls: [
          pendingCall(),
          pendingCall({
            kind: 'end-agent',
            name: 'end-agent',
            status: 'result_ready',
            order: 1,
            result: 'tampered',
          }),
        ],
        endRequested: false,
      }),
    ).toThrow(/non-requested end-agent/u);
  });

  it('requires batch-global approval/task identities and validates partial approval subsets', () => {
    const pausedCalls = [
      pendingCall({
        kind: 'agent',
        name: 'agent',
        status: 'waiting_approval',
        taskId: 'task-1',
        approvalIds: ['approval-1', 'approval-2'],
      }),
      pendingCall({
        kind: 'agent',
        name: 'agent',
        status: 'waiting_approval',
        order: 1,
        taskId: 'task-2',
        approvalIds: ['approval-3'],
      }),
    ] as const;
    expect(() =>
      validate({
        calls: pausedCalls,
        endRequested: false,
        approvalDecisionIds: ['approval-2'],
      }),
    ).not.toThrow();
    expect(() =>
      validate({
        calls: pausedCalls,
        endRequested: false,
        approvalDecisionIds: ['unknown-approval'],
      }),
    ).toThrow(/belong to a pending paused Tool call/u);

    expect(() =>
      validate({
        calls: [pausedCalls[0], pendingCall({ ...pausedCalls[1], taskId: 'task-1' })],
        endRequested: false,
      }),
    ).toThrow(/share a taskId/u);
    expect(() =>
      validate({
        calls: [pausedCalls[0], pendingCall({ ...pausedCalls[1], approvalIds: ['approval-2'] })],
        endRequested: false,
      }),
    ).toThrow(/share an approval ID/u);
  });

  it('requires authoritative typed result projections only for completed child phases', () => {
    const completedEnd = pendingCall({
      kind: 'end-agent',
      name: 'end-agent',
      status: 'result_ready',
    });
    expect(() => validate({ calls: [completedEnd], endRequested: true })).not.toThrow();
    expect(() =>
      validate({
        calls: [completedEnd],
        endRequested: true,
        requireResultSubmissionForEnd: true,
      }),
    ).toThrow(/typed result submission/u);

    const submittedResult = pendingCall({ name: 'agent-result', status: 'result_submitted' });
    expect(() =>
      validate({
        calls: [submittedResult],
        endRequested: false,
        requireResultSubmissionForCompletedAgentResult: true,
      }),
    ).toThrow(/typed result submission/u);
    expect(() =>
      validate({
        calls: [pendingCall({ name: 'agent-result', status: 'in_flight' })],
        endRequested: false,
        requireResultSubmissionForCompletedAgentResult: true,
        resultSubmissionPresent: true,
      }),
    ).not.toThrow();
  });
});
