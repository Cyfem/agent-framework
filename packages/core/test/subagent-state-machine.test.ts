import { describe, expect, it } from 'vitest';
import { acceptanceIt } from '../../../testkit';

import { SubAgentRuntimeError } from '../src/subagent/errors';
import { DEFAULT_SUBAGENT_IO_LIMITS } from '../src/subagent/limits';
import {
  appendSafeTaskEvents,
  assertSubAgentTaskTransition,
  completeSubAgentTask,
  decideApproval,
  isTerminalSubAgentTaskState,
  reserveTreeBudget,
  selectFirstValidSubAgentTaskCasCandidate,
  settleTreeBudget,
  submitSubAgentResult,
  TERMINAL_SUBAGENT_TASK_STATES,
  transitionSubAgentTask,
} from '../src/subagent/state-machine';
import type { StoredTask } from '../src/subagent/state-store';

function task(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    recordVersion: '1',
    ownerSessionId: 'session-1',
    runId: 'run-1',
    taskId: 'task-1',
    subagentSessionId: 'child-session-1',
    requestId: 'request-1',
    idempotencyKey: 'idempotency-1',
    definition: { name: 'researcher', version: '2.0.0' },
    executor: 'local',
    input: { topic: 'state machines' },
    inputHash: 'input-hash',
    projectedContext: [],
    state: 'running',
    revision: 3,
    fencingToken: 'fence-7',
    path: ['task-1'],
    depth: 1,
    attempt: 1,
    approvals: [],
    approvalDecisions: [],
    recoveryRequired: false,
    activeElapsedMs: 10,
    activeStartedAt: 100,
    remainingMs: 1_000,
    eventSequence: 0,
    createdAt: 50,
    updatedAt: 100,
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(SubAgentRuntimeError);
    expect((error as SubAgentRuntimeError).code).toBe(code);
  }
}

describe('Subagent v2 pure state machine', () => {
  acceptanceIt('STATE-05', 'task-state-machine', () => {
    expect(TERMINAL_SUBAGENT_TASK_STATES).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
      'budget_exceeded',
    ]);
    expect(isTerminalSubAgentTaskState('failed')).toBe(true);
    expect(isTerminalSubAgentTaskState('running')).toBe(false);

    const queued = task({
      state: 'queued',
      attempt: 0,
    });
    const running = transitionSubAgentTask(queued, 'running', { now: 101 });
    const submitted = submitSubAgentResult(running, {
      callId: 'result-call',
      receiptId: 'result-receipt',
      submittedAt: 102,
      output: { answer: 42 },
    });
    const completed = completeSubAgentTask(submitted.task, {
      callId: 'end-call',
      receiptId: 'completion-receipt',
      completedAt: 103,
      isStandalone: true,
      outputDecodable: true,
    });

    expect(completed.task).toMatchObject({
      state: 'succeeded',
      revision: 6,
      terminalAt: 103,
      output: { answer: 42 },
      result: { status: 'succeeded', output: { answer: 42 } },
    });
    expect(queued).toMatchObject({ state: 'queued', revision: 3, attempt: 0 });
    expectCode(
      () => assertSubAgentTaskTransition(completed.task.state, 'cancelled'),
      'INVALID_STATE_TRANSITION',
    );
  });

  it('lets the first legal revision and fencing candidate win without hidden priority', () => {
    const current = task();
    const cancelled = transitionSubAgentTask(current, 'cancelled', { now: 101 });
    const timedOut = transitionSubAgentTask(current, 'timed_out', { now: 101 });
    const outcome = selectFirstValidSubAgentTaskCasCandidate(current, [
      { expectedRevision: 2, fencingToken: current.fencingToken, task: timedOut },
      { expectedRevision: 3, fencingToken: 'stale-fence', task: timedOut },
      { expectedRevision: 3, fencingToken: current.fencingToken, task: cancelled },
      { expectedRevision: 3, fencingToken: current.fencingToken, task: timedOut },
    ]);

    expect(outcome).toMatchObject({
      status: 'won',
      winnerIndex: 2,
      task: { state: 'cancelled', revision: 4 },
      rejected: [
        { index: 0, reason: 'revision_mismatch' },
        { index: 1, reason: 'fencing_mismatch' },
      ],
    });
    expect(current.state).toBe('running');
  });

  it('publishes one canonical result and rejects conflicting replays', () => {
    const first = submitSubAgentResult(task(), {
      callId: 'result-call',
      receiptId: 'receipt-1',
      submittedAt: 101,
      output: { z: 1, a: [1, 2] },
    });
    const replay = submitSubAgentResult(first.task, {
      callId: 'result-call',
      submittedAt: 102,
      output: { a: [1, 2], z: 1 },
    });

    expect(first.replayed).toBe(false);
    expect(first.task).toMatchObject({
      state: 'result_submitted',
      revision: 4,
      output: { a: [1, 2], z: 1 },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.status).toBe('replayed');
    expect(replay.receipt.receiptId).toBe('receipt-1');
    expect(replay.task).toBe(first.task);
    expectCode(
      () =>
        submitSubAgentResult(first.task, {
          callId: 'result-call',
          submittedAt: 102,
          output: { a: [2, 1], z: 1 },
        }),
      'RESULT_REPLAY_CONFLICT',
    );
    expectCode(
      () =>
        submitSubAgentResult(first.task, {
          callId: 'another-call',
          submittedAt: 102,
          output: { a: [1, 2], z: 1 },
        }),
      'RESULT_ALREADY_SUBMITTED',
    );
  });

  it('accepts the exact JSON byte limit and rejects one byte over', () => {
    const exact = 'x'.repeat(DEFAULT_SUBAGENT_IO_LIMITS.maxOutputBytes - 2);
    expect(
      submitSubAgentResult(task(), {
        callId: 'exact',
        receiptId: 'receipt-exact',
        submittedAt: 101,
        output: exact,
      }).task.output,
    ).toBe(exact);
    expectCode(
      () =>
        submitSubAgentResult(task(), {
          callId: 'over',
          receiptId: 'receipt-over',
          submittedAt: 101,
          output: `${exact}x`,
        }),
      'INVALID_OUTPUT',
    );
    expectCode(
      () =>
        submitSubAgentResult(task(), {
          callId: 'unsafe',
          receiptId: 'receipt-unsafe',
          submittedAt: 101,
          output: { missing: undefined },
        }),
      'OUTPUT_NOT_JSON_SAFE',
    );
  });

  it('enforces standalone completion and replays a durable completion receipt', () => {
    expectCode(
      () =>
        completeSubAgentTask(task(), {
          callId: 'end-call',
          receiptId: 'completion-receipt',
          completedAt: 101,
          isStandalone: false,
          outputDecodable: true,
        }),
      'END_AGENT_MUST_BE_STANDALONE',
    );
    expectCode(
      () =>
        completeSubAgentTask(task(), {
          callId: 'end-call',
          receiptId: 'completion-receipt',
          completedAt: 101,
          isStandalone: true,
          outputDecodable: true,
        }),
      'RESULT_REQUIRED',
    );

    const submitted = submitSubAgentResult(task(), {
      callId: 'result-call',
      receiptId: 'result-receipt',
      submittedAt: 101,
      output: { proof: true },
    });
    const completed = completeSubAgentTask(submitted.task, {
      callId: 'end-call',
      receiptId: 'completion-receipt',
      completedAt: 102,
      isStandalone: true,
      outputDecodable: true,
    });
    const replay = completeSubAgentTask(completed.task, {
      callId: 'end-call',
      completedAt: 103,
      isStandalone: true,
      outputDecodable: true,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.task).toBe(completed.task);
    expect(replay.receipt).toMatchObject({
      receiptId: 'completion-receipt',
      status: 'replayed',
    });
    expect(completed.task.completionReceipt).toEqual(completed.receipt);
  });

  it('uses the strict approval expiry boundary and keeps decision replay idempotent', () => {
    const approval = {
      approvalId: 'approval-1',
      ownerSessionId: 'session-1',
      taskId: 'task-1',
      callId: 'safe-tool',
      toolName: 'safe-tool',
      summary: 'safe action',
      createdAt: 100,
      expiresAt: 200,
      revision: 7,
    } as const;
    const waiting = task({
      state: 'waiting_approval',
      approvals: [approval],
    });
    const approved = decideApproval(waiting, {
      now: 199,
      decision: { approvalId: 'approval-1', decision: 'approved', expectedRevision: 7 },
    });
    expect(approved.task).toMatchObject({ state: 'running', attempt: 2, approvals: [] });
    const replay = decideApproval(approved.task, {
      now: 201,
      decision: { approvalId: 'approval-1', decision: 'approved', expectedRevision: 7 },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.task).toBe(approved.task);

    const expired = decideApproval(waiting, {
      now: 200,
      decision: { approvalId: 'approval-1', decision: 'approved', expectedRevision: 7 },
    });
    expect(expired.task).toMatchObject({
      state: 'failed',
      error: { code: 'APPROVAL_EXPIRED' },
    });
    expect(expired.decision.decision).toBe('expired');
    expect(expired.task.approvalDecisions).toEqual([expired.decision]);
    expectCode(
      () =>
        decideApproval(waiting, {
          now: 199,
          decision: { approvalId: 'approval-1', decision: 'approved', expectedRevision: 8 },
        }),
      'APPROVAL_CONFLICT',
    );
  });

  it('preserves a submitted result only as partial output on failure or unknown outcome', () => {
    const submitted = submitSubAgentResult(task(), {
      callId: 'result-call',
      receiptId: 'result-receipt',
      submittedAt: 101,
      output: { durable: 'partial' },
    }).task;
    const failed = transitionSubAgentTask(submitted, 'failed', {
      now: 102,
      error: {
        code: 'EXECUTOR_FAILED',
        message: 'Provider response was uncertain.',
        retryable: false,
        outcomeUnknown: true,
      },
    });
    expect(failed).toMatchObject({
      state: 'failed',
      partialOutput: { durable: 'partial' },
      error: { code: 'EXECUTOR_FAILED', outcomeUnknown: true },
      result: {
        status: 'failed',
        partialOutput: { durable: 'partial' },
        error: { outcomeUnknown: true },
      },
    });
    expect(failed.output).toBeUndefined();
    expect(submitted.output).toEqual({ durable: 'partial' });
  });

  it('reserves and settles budgets conservatively', () => {
    const initial = {
      descendantsCreated: 2,
      activeExecutions: 1,
      providerCalls: 3,
      inputTokens: 100,
      outputTokens: 20,
    } as const;
    const reservation = { providerCalls: 1, inputTokens: 50, outputTokens: 30 };
    const reserved = reserveTreeBudget(initial, reservation, {
      maxProviderCalls: 4,
      maxInputTokens: 150,
      maxOutputTokens: 50,
    });
    expect(reserved).toMatchObject({ providerCalls: 4, inputTokens: 150, outputTokens: 50 });
    const settled = settleTreeBudget(
      reserved,
      reservation,
      { providerCalls: 1, inputTokens: 40, outputTokens: 10 },
      { maxProviderCalls: 4, maxInputTokens: 150, maxOutputTokens: 50 },
    );
    expect(settled).toMatchObject({ providerCalls: 4, inputTokens: 140, outputTokens: 30 });
    expect(
      settleTreeBudget(
        reserved,
        reservation,
        { providerCalls: 0, inputTokens: 0, outputTokens: 0 },
        {},
        { outcomeUnknown: true },
      ),
    ).toEqual(reserved);
    expectCode(
      () =>
        reserveTreeBudget(initial, reservation, {
          maxProviderCalls: 3,
        }),
      'BUDGET_EXCEEDED',
    );
    expectCode(
      () =>
        settleTreeBudget(reserved, reservation, {
          providerCalls: 1,
          inputTokens: 51,
          outputTokens: 1,
        }),
      'BUDGET_EXCEEDED',
    );
    expect(initial.providerCalls).toBe(3);
  });

  it('appends only safe events with a gap-free sequence', () => {
    const source = task({ eventSequence: 8 });
    const appended = appendSafeTaskEvents(
      source,
      [
        { type: 'task.result_submitted', timestamp: 101, data: { callId: 'call-1' } },
        {
          type: 'usage.updated',
          data: { usage: { turns: 1, providerCalls: 1, inputTokens: 4, outputTokens: 2 } },
        },
      ],
      { eventIds: ['event-9', 'event-10'], defaultTimestamp: 102 },
    );
    expect(appended.events.map(({ sequence }) => sequence)).toEqual([9, 10]);
    expect(appended.task).toMatchObject({ eventSequence: 10, revision: 4, updatedAt: 102 });
    expect(source).toMatchObject({ eventSequence: 8, revision: 3 });
    expect(
      appendSafeTaskEvents(
        appended.task,
        [{ type: 'task.succeeded', data: { status: 'succeeded' } }],
        { eventIds: ['event-11'], defaultTimestamp: 103, revisionMode: 'preserve' },
      ).task,
    ).toMatchObject({ eventSequence: 11, revision: 4 });
    expect(() =>
      appendSafeTaskEvents(
        source,
        [{ type: 'progress.reported', data: { prompt: 'secret' } as never }],
        { eventIds: ['unsafe'], defaultTimestamp: 102 },
      ),
    ).toThrow('Unsafe task event data field');
    expect(() =>
      appendSafeTaskEvents(source, [{ type: 'progress.reported', data: {} }], {
        eventIds: ['same', 'same'],
        defaultTimestamp: 102,
      }),
    ).toThrow('exactly one supplied event ID');
  });
});
