import { describe, expect, it, vi } from 'vitest';

import { Deferred, acceptanceIt } from '../../../testkit';
import type { ApprovalRequest } from '../src/subagent/approval';
import { SubAgentRuntimeError } from '../src/subagent/errors';
import type { StoredPendingToolBatch } from '../src/subagent/state-store';
import {
  createToolBatchPlan,
  executeToolBatchPlan,
  finalizeToolBatchResults,
  resumeToolBatchPlan,
  ToolBatchOutcomeUnknownError,
  type ToolBatchExecutionCallbacks,
} from '../src/agent/tool-batch';
import { createAbortError } from '../src/llm/base/abort';
import { parsedCall, type TestProtocol } from './helpers/mock-models';

function createPlan(...names: string[]) {
  return createToolBatchPlan<TestProtocol>({
    batchId: 'batch-1',
    iteration: 2,
    assistantMessage: {
      protocol: 'test-protocol',
      codecVersion: '1',
      value: [{ kind: 'assistant', content: 'calls' }],
    },
    calls: names.map((name, index) => parsedCall(`call-${index}`, name)),
    createdAt: 1_000,
  });
}

function approval(taskId: string): ApprovalRequest {
  return {
    approvalId: `approval-${taskId}`,
    ownerSessionId: 'owner-1',
    taskId,
    callId: `risky-${taskId}`,
    toolName: 'risky-tool',
    summary: 'Host-safe approval summary.',
    createdAt: 1_100,
    revision: 3,
  };
}

function unreachableCallbacks(
  overrides: Partial<ToolBatchExecutionCallbacks<TestProtocol>> = {},
): ToolBatchExecutionCallbacks<TestProtocol> {
  return {
    executeTool: () => {
      throw new Error('ordinary Tool must not run');
    },
    submitAgent: () => {
      throw new Error('agent must not be submitted');
    },
    executeEndAgent: () => {
      throw new Error('end-agent must not run');
    },
    applyResult: () => undefined,
    ...overrides,
  };
}

describe('durable Tool batch planning', () => {
  it('prevalidates mixed end-agent calls before executing ordinary and agent phases', async () => {
    const plan = createPlan('end-agent', 'ordinary', 'agent');
    const calls: string[] = [];
    const result = await executeToolBatchPlan(plan, {
      executeTool: (call) => {
        calls.push(`tool:${call.id}`);
        return { ok: true, value: 'ordinary' };
      },
      submitAgent: (call) => {
        calls.push(`agent:${call.id}`);
        return {
          status: 'settled',
          taskId: 'task-agent',
          output: { status: 'succeeded', value: 'child' },
        };
      },
      executeEndAgent: () => {
        calls.push('end');
        return { ok: true };
      },
      applyResult: () => undefined,
    });

    expect(calls).toEqual(['tool:call-1', 'agent:call-2']);
    expect(result.complete).toBe(true);
    expect(result.checkpoint.endRequested).toBe(false);
    expect(result.orderedResults.map(({ callId }) => callId)).toEqual([
      'call-0',
      'call-1',
      'call-2',
    ]);
    expect(result.orderedResults[0]?.error?.code).toBe('END_AGENT_MUST_BE_STANDALONE');
  });

  acceptanceIt('BATCH-01.l1.two-phase-approval', 'two-phase-approval', async () => {
    const plan = createPlan('agent', 'ordinary', 'agent');
    const log: string[] = [];
    const checkpoints: StoredPendingToolBatch[] = [];
    let longSiblingSignal: AbortSignal | undefined;
    let resolveLongSibling!: () => void;
    const applyResult = vi.fn();
    const longSibling = new Promise<void>((resolve) => {
      resolveLongSibling = resolve;
    });

    const result = await executeToolBatchPlan(plan, {
      executeTool: (call) => {
        log.push(`tool:${call.id}`);
        return { ordinary: true };
      },
      submitAgent: (call) => {
        log.push(`submit:${call.id}`);
        return {
          status: 'running',
          taskId: call.id === 'call-0' ? 'task-long' : 'task-approval',
        };
      },
      observeAgent: async (call, durableCall, signal) => {
        void durableCall;
        log.push(`observe:${call.id}`);
        if (call.id === 'call-0') {
          longSiblingSignal = signal;
          await longSibling;
          return {
            status: 'settled',
            taskId: 'task-long',
            output: { status: 'succeeded', value: 'late' },
          };
        }
        return {
          status: 'paused',
          taskId: 'task-approval',
          approvals: [approval('task-approval')],
          checkpointRevision: 4,
        };
      },
      executeEndAgent: () => ({ ok: true }),
      applyResult,
      checkpoint: (checkpoint) => {
        checkpoints.push(structuredClone(checkpoint));
      },
    });

    expect(log.slice(0, 3)).toEqual(['tool:call-1', 'submit:call-0', 'submit:call-2']);
    expect(log).toContain('observe:call-0');
    expect(log).toContain('observe:call-2');
    expect(
      checkpoints.some(({ calls }) => {
        const agents = calls.filter(({ kind }) => kind === 'agent');
        return agents.every(({ status, taskId }) => status === 'running' && taskId !== undefined);
      }),
    ).toBe(true);
    expect(result.waitingApproval).toBe(true);
    expect(result.approvals.map(({ approvalId }) => approvalId)).toEqual([
      'approval-task-approval',
    ]);
    expect(result.checkpoint.calls.map(({ status }) => status)).toEqual([
      'running',
      'settled',
      'paused',
    ]);
    expect(result.orderedResults.map(({ callId }) => callId)).toEqual(['call-1']);
    expect(applyResult).not.toHaveBeenCalled();
    expect(longSiblingSignal?.aborted).toBe(true);

    resolveLongSibling();
    await Promise.resolve();
  });

  acceptanceIt(
    'BATCH-01.l1.staggered-sibling-reconcile',
    'multi-round-authoritative-sibling-reconcile',
    async () => {
      const plan = createPlan('agent', 'agent');
      const checkpoints: StoredPendingToolBatch[] = [];
      const observationRelease = new Deferred<void>();
      let secondState: 'running' | 'paused' = 'running';
      const submitAgent = vi.fn((call: ReturnType<typeof parsedCall>) => ({
        status: 'running' as const,
        taskId: call.id === 'call-0' ? 'task-first' : 'task-second',
      }));
      const reconcileAgent = vi.fn((call: ReturnType<typeof parsedCall>) => {
        if (call.id === 'call-0') {
          return {
            status: 'paused' as const,
            taskId: 'task-first',
            approvals: [approval('task-first')],
            checkpointRevision: 4,
          };
        }
        return secondState === 'running'
          ? { status: 'running' as const, taskId: 'task-second' }
          : {
              status: 'paused' as const,
              taskId: 'task-second',
              approvals: [approval('task-second')],
              checkpointRevision: 5,
            };
      });

      const first = await executeToolBatchPlan(plan, {
        ...unreachableCallbacks({ submitAgent }),
        observeAgent: async (call) => {
          if (call.id === 'call-0') {
            return {
              status: 'paused' as const,
              taskId: 'task-first',
              approvals: [approval('task-first')],
              checkpointRevision: 4,
            };
          }
          await observationRelease.promise;
          return { status: 'running' as const, taskId: 'task-second' };
        },
        reconcileAgent,
        checkpoint: (checkpoint) => {
          checkpoints.push(structuredClone(checkpoint));
        },
      });
      expect(first.waitingApproval).toBe(true);
      expect(first.approvals.map(({ approvalId }) => approvalId)).toEqual(['approval-task-first']);
      expect(first.checkpoint.calls.map(({ status }) => status)).toEqual(['paused', 'running']);
      expect(submitAgent).toHaveBeenCalledTimes(2);
      expect(reconcileAgent).toHaveBeenCalledTimes(1);

      secondState = 'paused';
      const secondResume = vi.fn((call: ReturnType<typeof parsedCall>) =>
        call.id === 'call-0'
          ? {
              status: 'settled' as const,
              taskId: 'task-first',
              output: { status: 'succeeded', proof: 'first' },
            }
          : {
              status: 'paused' as const,
              taskId: 'task-second',
              approvals: [approval('task-second')],
              checkpointRevision: 5,
            },
      );
      const second = await resumeToolBatchPlan(
        plan,
        first.checkpoint,
        unreachableCallbacks({
          resumeAgent: secondResume,
          reconcileAgent,
          checkpoint: (checkpoint) => {
            checkpoints.push(structuredClone(checkpoint));
          },
        }),
      );
      expect(second.waitingApproval).toBe(true);
      expect(second.approvals.map(({ approvalId }) => approvalId)).toEqual([
        'approval-task-second',
      ]);
      expect(second.checkpoint.calls.map(({ status }) => status)).toEqual(['settled', 'paused']);
      expect(secondResume).toHaveBeenCalledTimes(2);

      const finalResume = vi.fn(() => ({
        status: 'settled' as const,
        taskId: 'task-second',
        output: { status: 'succeeded', proof: 'second' },
      }));
      const applied: string[] = [];
      const completed = await resumeToolBatchPlan(
        plan,
        second.checkpoint,
        unreachableCallbacks({
          resumeAgent: finalResume,
          applyResult: (call) => {
            applied.push(call.id);
          },
          checkpoint: (checkpoint) => {
            checkpoints.push(structuredClone(checkpoint));
          },
        }),
      );
      expect(completed.complete).toBe(true);
      expect(completed.waitingApproval).toBe(false);
      expect(finalResume).toHaveBeenCalledTimes(1);
      expect(applied).toEqual(['call-0', 'call-1']);
      expect(checkpoints.at(-1)?.calls.map(({ status }) => status)).toEqual(['applied', 'applied']);
      observationRelease.resolve(undefined);
    },
  );

  it('persists each returned taskId without waiting for a slower sibling submission', async () => {
    const plan = createPlan('agent', 'agent');
    const checkpoints: StoredPendingToolBatch[] = [];
    let resolveSlow!: (outcome: { readonly status: 'running'; readonly taskId: string }) => void;
    const slow = new Promise<{ readonly status: 'running'; readonly taskId: string }>((resolve) => {
      resolveSlow = resolve;
    });

    const execution = executeToolBatchPlan(plan, {
      executeTool: () => ({ ok: true }),
      submitAgent: (call) =>
        call.id === 'call-0' ? slow : { status: 'running', taskId: 'task-fast' },
      observeAgent: (call) => ({
        status: 'settled',
        taskId: call.id === 'call-0' ? 'task-slow' : 'task-fast',
        output: { child: call.id },
      }),
      executeEndAgent: () => ({ ok: true }),
      applyResult: () => undefined,
      checkpoint: (checkpoint) => {
        checkpoints.push(structuredClone(checkpoint));
      },
    });

    await vi.waitFor(() => {
      expect(checkpoints.some(({ calls }) => calls[1]?.taskId === 'task-fast')).toBe(true);
    });
    expect(checkpoints.every(({ calls }) => calls[0]?.taskId === undefined)).toBe(true);

    resolveSlow({ status: 'running', taskId: 'task-slow' });
    const result = await execution;
    expect(result.complete).toBe(true);
    expect(result.checkpoint.calls.map(({ taskId }) => taskId)).toEqual(['task-slow', 'task-fast']);
  });

  acceptanceIt('BATCH-02.l1.ordered-resume', 'ordered-resume', async () => {
    const plan = createPlan('ordinary', 'agent', 'agent');
    const first = await executeToolBatchPlan(plan, {
      executeTool: () => ({ value: 'ordinary' }),
      submitAgent: (call) =>
        call.id === 'call-1'
          ? {
              status: 'settled' as const,
              taskId: 'task-done',
              output: { value: 'first-agent' },
            }
          : {
              status: 'paused' as const,
              taskId: 'task-paused',
              approvals: [approval('task-paused')],
              checkpointRevision: 5,
            },
      executeEndAgent: () => ({ ok: true }),
      applyResult: () => undefined,
    });
    const resumeAgent = vi.fn((call: ReturnType<typeof parsedCall>) => {
      void call;
      return {
        status: 'settled' as const,
        taskId: 'task-paused',
        output: { value: 'resumed-agent' },
      };
    });

    const resumed = await resumeToolBatchPlan(
      plan,
      first.checkpoint,
      unreachableCallbacks({ resumeAgent }),
    );

    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(resumeAgent.mock.calls[0]?.[0].id).toBe('call-2');
    expect(resumed.complete).toBe(true);
    expect(finalizeToolBatchResults(resumed.checkpoint).map(({ callId }) => callId)).toEqual([
      'call-0',
      'call-1',
      'call-2',
    ]);
    expect(resumed.orderedResults.map(({ output }) => output)).toEqual([
      { value: 'ordinary' },
      { value: 'first-agent' },
      { value: 'resumed-agent' },
    ]);
  });

  it('never replays an ordinary Tool whose last durable phase is running', async () => {
    const plan = createPlan('ordinary');
    const running: StoredPendingToolBatch = {
      ...plan.initialCheckpoint,
      calls: plan.initialCheckpoint.calls.map((call) => ({ ...call, status: 'running' })),
    };
    const executeTool = vi.fn(() => ({ shouldNotRun: true }));

    await expect(
      resumeToolBatchPlan(plan, running, unreachableCallbacks({ executeTool })),
    ).rejects.toBeInstanceOf(ToolBatchOutcomeUnknownError);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('executes a standalone end-agent exactly once and records the end request', async () => {
    const plan = createPlan('end-agent');
    const executeEndAgent = vi.fn(() => ({ ok: true, receipt: 'end-1' }));

    const result = await executeToolBatchPlan(plan, unreachableCallbacks({ executeEndAgent }));

    expect(executeEndAgent).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(true);
    expect(result.checkpoint.endRequested).toBe(true);
    expect(result.orderedResults).toMatchObject([
      { callId: 'call-0', output: { ok: true, receipt: 'end-1' } },
    ]);
  });

  it('replays apply without re-executing after a crash between settle and apply', async () => {
    const plan = createPlan('ordinary');
    const executeTool = vi.fn(() => ({ value: 'settled-once' }));
    const applyResult = vi.fn();
    let durable = plan.initialCheckpoint;
    let crashBeforeApply = true;

    await expect(
      executeToolBatchPlan(plan, {
        ...unreachableCallbacks({ executeTool, applyResult }),
        checkpoint: (checkpoint) => {
          durable = structuredClone(checkpoint);
          if (crashBeforeApply && checkpoint.calls[0]?.status === 'settled') {
            crashBeforeApply = false;
            throw new Error('simulated crash before apply');
          }
        },
      }),
    ).rejects.toThrow('simulated crash before apply');

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(applyResult).not.toHaveBeenCalled();

    const resumed = await resumeToolBatchPlan(plan, durable, unreachableCallbacks({ applyResult }));
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(applyResult).toHaveBeenCalledTimes(1);
    expect(resumed.checkpoint.calls[0]?.status).toBe('applied');
  });

  it('skips already applied results when recovering after a partial ordered apply', async () => {
    const plan = createPlan('first-tool', 'second-tool');
    const executeTool = vi.fn((call: ReturnType<typeof parsedCall>) => ({ value: call.id }));
    const applied: string[] = [];
    let durable = plan.initialCheckpoint;
    let crashAfterFirstApply = true;
    const callbacks = unreachableCallbacks({
      executeTool,
      applyResult: (call) => {
        applied.push(call.id);
      },
    });

    await expect(
      executeToolBatchPlan(plan, {
        ...callbacks,
        checkpoint: (checkpoint) => {
          durable = structuredClone(checkpoint);
          if (
            crashAfterFirstApply &&
            checkpoint.calls[0]?.status === 'applied' &&
            checkpoint.calls[1]?.status === 'settled'
          ) {
            crashAfterFirstApply = false;
            throw new Error('simulated crash after partial apply');
          }
        },
      }),
    ).rejects.toThrow('simulated crash after partial apply');

    const resumed = await resumeToolBatchPlan(plan, durable, callbacks);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(applied).toEqual(['call-0', 'call-1']);
    expect(resumed.checkpoint.calls.map(({ status }) => status)).toEqual(['applied', 'applied']);
  });

  it('applies an agent-before-tool batch in provider order after both phases settle', async () => {
    const plan = createPlan('agent', 'ordinary');
    const executionOrder: string[] = [];
    const applyOrder: string[] = [];

    const result = await executeToolBatchPlan(plan, {
      executeTool: (call) => {
        executionOrder.push(`tool:${call.id}`);
        return { value: 'ordinary' };
      },
      submitAgent: (call) => {
        executionOrder.push(`agent:${call.id}`);
        return { status: 'settled', taskId: 'task-1', output: { value: 'child' } };
      },
      executeEndAgent: () => ({ ok: true }),
      applyResult: (call) => {
        applyOrder.push(call.id);
      },
    });

    expect(executionOrder).toEqual(['tool:call-1', 'agent:call-0']);
    expect(applyOrder).toEqual(['call-0', 'call-1']);
    expect(result.complete).toBe(true);
  });

  it.each([
    ['AbortError', createAbortError('cancelled by host')],
    [
      'SubAgentRuntimeError',
      new SubAgentRuntimeError({
        code: 'RECOVERY_TARGET_LOST',
        message: 'lease lost',
        retryable: true,
      }),
    ],
  ])('does not rewrite a stable %s from an ordinary Tool handler', async (_name, error) => {
    const plan = createPlan('ordinary');
    await expect(
      executeToolBatchPlan(
        plan,
        unreachableCallbacks({
          executeTool: () => {
            throw error;
          },
        }),
      ),
    ).rejects.toBe(error);
  });

  it('turns only an ordinary Tool business exception into the stable Tool result', async () => {
    const plan = createPlan('ordinary');
    const result = await executeToolBatchPlan(
      plan,
      unreachableCallbacks({
        executeTool: () => {
          throw new Error('private handler detail');
        },
      }),
    );

    expect(result.orderedResults[0]?.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'The Tool call failed.',
    });
    expect(result.complete).toBe(true);
  });

  it('propagates agent submission control failures instead of rewriting them', async () => {
    const plan = createPlan('agent');
    const error = new SubAgentRuntimeError({
      code: 'EXECUTOR_UNAVAILABLE',
      message: 'executor unavailable',
      retryable: true,
    });

    await expect(
      executeToolBatchPlan(
        plan,
        unreachableCallbacks({
          submitAgent: () => {
            throw error;
          },
        }),
      ),
    ).rejects.toBe(error);
  });
});
