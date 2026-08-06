import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { acceptanceIt } from '../../../testkit';

import type {
  ApprovalDirective,
  ApprovalRequest,
  CompletionReceipt,
  ExecutorCatalogSnapshot,
  ExecutorEventInput,
  JsonValue,
  ResultReceipt,
  SubAgentCatalogEntry,
  SubAgentChildCheckpoint,
  SubAgentDelegationPauseInput,
  SubAgentDelegationPauseReceipt,
  SubAgentDelegationSnapshot,
  SubAgentDispatchContext,
  SubAgentExecutionControl,
  SubAgentExecutorBinding,
  SubAgentFailureInput,
  SubAgentTaskEvent,
  SubAgentTaskHandle,
  SubAgentTaskResult,
  SubAgentTaskSnapshot,
  SubAgentTransportExecutionOutcome,
  SubAgentTransportFailureInput,
  SubAgentTransportTaskResult,
  SubAgentTransportTaskSnapshot,
} from '../src';
import { createResourceNotFoundError, SubAgentRuntimeError } from '../src/subagent/errors';
import { canonicalJsonSha256 } from '../src/subagent/json';
import {
  SUBAGENT_TRANSPORT_CONTROL_METHODS,
  assertSubAgentTransportControlReply,
  assertSubAgentTransportControlRequest,
  createRemoteSubAgentExecutionControl,
  createSubAgentTransportControlDispatcher,
  decodeSubAgentTransportControlReply,
  decodeSubAgentTransportControlRequest,
  type SubAgentTransportControlArgsMap,
  type SubAgentTransportControlExchangeContext,
  type SubAgentTransportControlMethod,
  type SubAgentTransportControlReply,
  type SubAgentTransportControlRequest,
  type SubAgentTransportControlResultMap,
} from '../src/subagent/transport-control';

const TASK_ID = 'task-parent';
const CHILD_TASK_ID = 'task-child';

function createBinding(): SubAgentExecutorBinding {
  return {
    version: '1',
    executorName: 'process',
    ownerSessionId: 'owner-session-1',
    taskId: TASK_ID,
    subagentSessionId: 'subagent-session-1',
    definitionName: 'researcher',
    definitionVersion: '2',
    runnerId: 'builtin-child-runner',
    runnerVersion: '1',
    adapterStateVersion: '1',
    recoveryData: { kind: 'process/v1', jobId: 'job-1' },
  };
}

function createCheckpoint(): SubAgentChildCheckpoint {
  return {
    version: '1',
    runnerId: 'builtin-child-runner',
    runnerVersion: '1',
    protocolContext: {
      protocol: 'openai-responses',
      codecVersion: '1',
      value: [],
    },
    contextStore: {
      version: '1',
      protocol: 'openai-responses',
      codecVersion: '1',
      revision: 0,
      rawHistory: [],
      activeSpans: [
        {
          spanId: 'context-span-1',
          kind: 'seed',
          closed: true,
          originalContext: [],
          entries: [],
        },
      ],
      nextRawItemId: 1,
      nextSpanId: 2,
      nextEntryId: 1,
    },
    modelIteration: 0,
    maxIterations: 8,
  };
}

function createApproval(taskId = TASK_ID): ApprovalRequest {
  return {
    callId: 'call-tool-1',
    toolName: 'write-report',
    summary: 'Write the reviewed report.',
    approvalId: 'approval-1',
    ownerSessionId: 'owner-session-1',
    taskId,
    createdAt: 1_000,
    revision: 1,
    expiresAt: 10_000,
  };
}

function createTaskResult(): Exclude<
  SubAgentTransportTaskResult,
  { readonly status: 'succeeded' }
> {
  return {
    status: 'failed',
    task: {
      taskId: TASK_ID,
      subAgent: { name: 'researcher', version: '2' },
    },
    executor: 'process',
    error: {
      code: 'EXECUTOR_FAILED',
      message: 'The child runner failed.',
      retryable: false,
      causeCode: 'CHILD_EXITED',
    },
    partialOutput: { phase: 'review' },
    usage: { turns: 2, providerCalls: 1 },
  };
}

function createOutcome(taskId = CHILD_TASK_ID): SubAgentTransportExecutionOutcome {
  return {
    type: 'terminal',
    result: {
      status: 'succeeded',
      task: {
        taskId,
        subAgent: { name: 'reviewer', version: '1' },
      },
      executor: 'process',
      output: { proof: 'reviewed' },
    },
  };
}

function createTaskSnapshot(taskId = CHILD_TASK_ID): SubAgentTransportTaskSnapshot {
  return {
    taskId,
    subAgent: { name: 'reviewer', version: '1' },
    ownerSessionId: 'owner-session-1',
    runId: 'run-1',
    subagentSessionId: `session-${taskId}`,
    parentTaskId: TASK_ID,
    path: [TASK_ID, taskId],
    executor: 'process',
    state: 'running',
    revision: 2,
    attempt: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    startedAt: 1_500,
    recoveryRequired: false,
  };
}

function createTaskEvent(taskId = CHILD_TASK_ID): SubAgentTaskEvent {
  return {
    eventId: 'event-1',
    sequence: 1,
    type: 'progress.reported',
    sessionId: 'owner-session-1',
    runId: 'run-1',
    taskId,
    parentTaskId: TASK_ID,
    path: [TASK_ID, taskId],
    definition: { name: 'reviewer', version: '1' },
    executor: 'process',
    attempt: 1,
    timestamp: 2_000,
    data: { status: 'running', length: 12 },
  };
}

function createCatalogFixtures(): {
  catalog: ExecutorCatalogSnapshot;
  entries: readonly SubAgentCatalogEntry[];
  delegation: SubAgentDelegationSnapshot;
} {
  const processDescriptor = {
    runtimeProtocolVersion: '1' as const,
    taskRecordVersions: ['1'],
    childCheckpointVersions: ['1'],
    runnerCompatibility: [
      {
        runnerId: 'builtin-child-runner',
        runnerVersion: '1',
        childCheckpointVersions: ['1'],
      },
    ],
    name: 'process',
    description: 'Trusted process placement.',
    useCases: ['isolated execution'],
    capabilities: {
      execute: true as const,
      spawn: true,
      cancel: true,
      events: true,
      approval: true,
      usage: 'provider' as const,
      recovery: {
        resume: 'checkpoint' as const,
        reconnect: 'none' as const,
      },
    },
    adapterStateVersion: '1',
    maxBindingBytes: 64 * 1024,
    maxEventPageSize: 256,
  };
  const workerDescriptor = {
    ...processDescriptor,
    name: 'worker',
    description: 'Trusted worker placement.',
  };
  const processEntry = { ...processDescriptor, status: 'available' as const };
  const workerEntry = { ...workerDescriptor, status: 'available' as const };

  return {
    catalog: {
      revision: 7,
      capturedAt: 2_000,
      executors: [
        { descriptor: processDescriptor, status: 'available' },
        { descriptor: workerDescriptor, status: 'available' },
      ],
    },
    entries: [
      {
        definition: { name: 'reviewer', version: '1' },
        description: 'Reviews one result.',
        inputSchema: z.object({ query: z.string() }),
        executors: [processEntry, workerEntry],
      },
      {
        definition: { name: 'unrelated', version: '1' },
        description: 'Must not enter the delegated catalog.',
        inputSchema: z.object({ value: z.string() }),
        executors: [processEntry],
      },
    ],
    delegation: {
      version: '1',
      ownerSessionId: 'owner-session-1',
      runId: 'run-1',
      parentTaskId: TASK_ID,
      path: [TASK_ID],
      depth: 1,
      catalogRevision: 7,
      definitions: [
        {
          name: 'reviewer',
          version: '1',
          executors: ['process', 'not-in-registry'],
        },
      ],
    },
  };
}

function createHandle(taskId = CHILD_TASK_ID): SubAgentTaskHandle {
  const snapshot = createTaskSnapshot(taskId);
  return {
    taskId,
    snapshot: vi.fn(async () => snapshot),
    wait: vi.fn(async () => createOutcome(taskId)),
    cancel: vi.fn(async () => ({
      ...snapshot,
      state: 'cancelled' as const,
      completedAt: 2_500,
    })),
    events: vi.fn(() => createEventStream([createTaskEvent(taskId)])),
  };
}

async function* createEventStream(
  events: readonly SubAgentTaskEvent[],
): AsyncIterable<SubAgentTaskEvent> {
  for (const event of events) yield event;
}

interface TrustedControlFixture {
  readonly control: SubAgentExecutionControl;
  readonly childHandle: SubAgentTaskHandle;
  readonly calls: {
    readonly commitBinding: ReturnType<typeof vi.fn>;
    readonly commitCheckpoint: ReturnType<typeof vi.fn>;
    readonly authorizeTool: ReturnType<typeof vi.fn>;
    readonly pauseDelegation: ReturnType<typeof vi.fn>;
    readonly reportProgress: ReturnType<typeof vi.fn>;
    readonly consumeBudget: ReturnType<typeof vi.fn>;
    readonly emit: ReturnType<typeof vi.fn>;
    readonly submitResult: ReturnType<typeof vi.fn>;
    readonly complete: ReturnType<typeof vi.fn>;
    readonly fail: ReturnType<typeof vi.fn>;
    readonly execute: ReturnType<typeof vi.fn>;
    readonly spawn: ReturnType<typeof vi.fn>;
    readonly resumeTool: ReturnType<typeof vi.fn>;
  };
}

function createTrustedControl(): TrustedControlFixture {
  const childHandle = createHandle();
  const approvalDirective: ApprovalDirective = {
    type: 'suspend',
    request: createApproval(),
    checkpointRevision: 3,
  };
  const pauseReceipt: SubAgentDelegationPauseReceipt = {
    checkpointRevision: 4,
    approvals: [createApproval(CHILD_TASK_ID)],
  };
  const resultReceipt: ResultReceipt = {
    schemaVersion: '1',
    receiptId: 'result-receipt-1',
    taskId: TASK_ID,
    callId: 'call-result-1',
    revision: 5,
    outputHash: canonicalJsonSha256({ proof: 'done' }),
    submittedAt: 2_000,
    status: 'accepted',
  };
  const completionReceipt: CompletionReceipt = {
    schemaVersion: '1',
    receiptId: 'completion-receipt-1',
    taskId: TASK_ID,
    callId: 'call-end-1',
    revision: 6,
    completedAt: 2_100,
    status: 'completed',
  };
  const catalog = createCatalogFixtures();
  const calls = {
    commitBinding: vi.fn(async () => undefined),
    commitCheckpoint: vi.fn(async () => undefined),
    authorizeTool: vi.fn(async () => approvalDirective),
    pauseDelegation: vi.fn(async () => pauseReceipt),
    reportProgress: vi.fn(async () => undefined),
    consumeBudget: vi.fn(async () => undefined),
    emit: vi.fn(async () => undefined),
    submitResult: vi.fn(async () => resultReceipt),
    complete: vi.fn(async () => completionReceipt),
    fail: vi.fn(async () => createTaskResult()),
    execute: vi.fn(async () => createOutcome()),
    spawn: vi.fn(async () => childHandle),
    resumeTool: vi.fn(async () => childHandle),
  };
  const signal = new AbortController().signal;
  const control: SubAgentExecutionControl = {
    signal,
    deadlineAt: 120_000,
    delegation: {
      getCatalog: () => catalog.catalog,
      getCatalogEntries: () => catalog.entries,
      submitTool: vi.fn(async () => childHandle),
      dispatchTool: vi.fn(async () => createOutcome()),
      execute: calls.execute,
      spawn: calls.spawn,
      resumeTool: calls.resumeTool,
    },
    completion: {
      submitResult: calls.submitResult,
      complete: calls.complete,
      fail: calls.fail,
    },
    commitBinding: calls.commitBinding,
    commitCheckpoint: calls.commitCheckpoint,
    authorizeTool: calls.authorizeTool,
    pauseDelegation: calls.pauseDelegation,
    reportProgress: calls.reportProgress,
    consumeBudget: calls.consumeBudget,
    emit: calls.emit,
  };
  return { control, childHandle, calls };
}

function request<M extends SubAgentTransportControlMethod>(
  method: M,
  args: SubAgentTransportControlArgsMap[M],
  options: { readonly taskId?: string; readonly operationId?: string } = {},
): SubAgentTransportControlRequest<M> {
  return {
    taskId: options.taskId ?? TASK_ID,
    operationId: options.operationId ?? `operation-${method}`,
    method,
    args,
  } as SubAgentTransportControlRequest<M>;
}

function successfulReply<M extends SubAgentTransportControlMethod>(
  method: M,
  result: SubAgentTransportControlResultMap[M],
): SubAgentTransportControlReply<M> {
  return { method, ok: true, result } as SubAgentTransportControlReply<M>;
}

function createMethodFixtures(): {
  readonly [M in SubAgentTransportControlMethod]: {
    readonly args: SubAgentTransportControlArgsMap[M];
    readonly result: SubAgentTransportControlResultMap[M];
  };
} {
  const checkpoint = createCheckpoint();
  const approval = createApproval();
  const childApproval = createApproval(CHILD_TASK_ID);
  const pauseInput: SubAgentDelegationPauseInput = {
    checkpoint,
    calls: [
      {
        callId: 'call-agent-1',
        childTaskId: CHILD_TASK_ID,
        approvals: [childApproval],
      },
    ],
  };
  const event: ExecutorEventInput = {
    type: 'progress.reported',
    timestamp: 2_000,
    data: { status: 'running', length: 12 },
  };
  const failure: SubAgentTransportFailureInput = {
    status: 'failed',
    error: {
      code: 'EXECUTOR_FAILED',
      message: 'The child runner failed.',
      retryable: false,
      causeCode: 'CHILD_EXITED',
    },
    partialOutput: { phase: 'review' },
  };
  const resultReceipt: ResultReceipt = {
    schemaVersion: '1',
    receiptId: 'result-receipt-1',
    taskId: TASK_ID,
    callId: 'call-result-1',
    revision: 5,
    outputHash: canonicalJsonSha256({ proof: 'done' }),
    submittedAt: 2_000,
    status: 'accepted',
  };
  const completionReceipt: CompletionReceipt = {
    schemaVersion: '1',
    receiptId: 'completion-receipt-1',
    taskId: TASK_ID,
    callId: 'call-end-1',
    revision: 6,
    completedAt: 2_100,
    status: 'completed',
  };
  const cancelledSnapshot = {
    ...createTaskSnapshot(),
    state: 'cancelled' as const,
    completedAt: 2_500,
  };
  return {
    'execution.commitBinding': {
      args: { binding: createBinding() },
      result: null,
    },
    'execution.commitCheckpoint': {
      args: { checkpoint },
      result: null,
    },
    'execution.authorizeTool': {
      args: {
        request: {
          callId: 'call-tool-1',
          toolName: 'write-report',
          summary: 'Write the reviewed report.',
          expiresAt: 10_000,
        },
        checkpoint,
      },
      result: {
        type: 'suspend',
        request: approval,
        checkpointRevision: 3,
      },
    },
    'execution.pauseDelegation': {
      args: { input: pauseInput },
      result: { checkpointRevision: 4, approvals: [childApproval] },
    },
    'execution.reportProgress': {
      args: { update: { message: 'halfway', percent: 50, data: { phase: 'review' } } },
      result: null,
    },
    'execution.consumeBudget': {
      args: { delta: { turns: 1, providerCalls: 1, inputTokens: 100, cost: 0.01 } },
      result: null,
    },
    'execution.emit': {
      args: { event },
      result: null,
    },
    'completion.submitResult': {
      args: { callId: 'call-result-1', candidate: { proof: 'done' } },
      result: resultReceipt,
    },
    'completion.complete': {
      args: { callId: 'call-end-1', proof: { isStandalone: true } },
      result: completionReceipt,
    },
    'completion.fail': {
      args: { callId: 'call-fail-1', failure },
      result: createTaskResult(),
    },
    'delegation.execute': {
      args: {
        request: {
          requestId: 'child-request-execute',
          subAgent: 'reviewer',
          executor: 'process',
          input: { query: 'review this' },
        },
      },
      result: createOutcome(),
    },
    'delegation.spawn': {
      args: {
        request: {
          requestId: 'child-request-spawn',
          subAgent: 'reviewer',
          executor: 'process',
          input: { query: 'review in background' },
        },
      },
      result: { taskId: CHILD_TASK_ID },
    },
    'delegation.resumeTool': {
      args: { childTaskId: CHILD_TASK_ID },
      result: { taskId: CHILD_TASK_ID },
    },
    'task.snapshot': { args: { taskId: CHILD_TASK_ID }, result: createTaskSnapshot() },
    'task.wait': { args: { taskId: CHILD_TASK_ID }, result: createOutcome() },
    'task.cancel': {
      args: { taskId: CHILD_TASK_ID, reason: 'host-cancelled' },
      result: cancelledSnapshot,
    },
  };
}

describe('Subagent strict transport control schema', () => {
  acceptanceIt('C7-TRANSPORT-05.l1.rpc-control', 'rpc-control', () => {
    expect(SUBAGENT_TRANSPORT_CONTROL_METHODS).toEqual([
      'execution.commitBinding',
      'execution.commitCheckpoint',
      'execution.authorizeTool',
      'execution.pauseDelegation',
      'execution.reportProgress',
      'execution.consumeBudget',
      'execution.emit',
      'completion.submitResult',
      'completion.complete',
      'completion.fail',
      'delegation.execute',
      'delegation.spawn',
      'delegation.resumeTool',
      'task.snapshot',
      'task.wait',
      'task.cancel',
    ]);

    const fixtures = createMethodFixtures();
    for (const method of SUBAGENT_TRANSPORT_CONTROL_METHODS) {
      const fixture = fixtures[method];
      const controlRequest = request(method, fixture.args);
      const controlReply = successfulReply(method, fixture.result);

      expect(() => assertSubAgentTransportControlRequest(controlRequest)).not.toThrow();
      expect(() => assertSubAgentTransportControlReply(controlReply)).not.toThrow();
      expect(decodeSubAgentTransportControlRequest(controlRequest)).toEqual(controlRequest);
      expect(decodeSubAgentTransportControlReply(controlReply)).toEqual(controlReply);

      expect(() =>
        assertSubAgentTransportControlRequest({
          ...controlRequest,
          args: { ...(fixture.args as object), unexpected: true },
        }),
      ).toThrow();
      expect(() =>
        assertSubAgentTransportControlRequest({
          ...controlRequest,
          args: {
            ...(fixture.args as object),
            operationId: 'must-live-only-in-outer-routing',
          },
        }),
      ).toThrow();
      expect(() =>
        assertSubAgentTransportControlReply({
          ...(controlReply as object),
          unexpected: true,
        }),
      ).toThrow();
    }
  });

  it('rejects unknown methods, swapped payloads, missing fields and non-JSON values', () => {
    const fixtures = createMethodFixtures();
    expect(() =>
      assertSubAgentTransportControlRequest({
        taskId: TASK_ID,
        operationId: 'operation-unknown',
        method: 'execution.future',
        args: {},
      }),
    ).toThrow();

    expect(() =>
      assertSubAgentTransportControlRequest({
        ...request('execution.commitBinding', fixtures['execution.commitBinding'].args),
        args: fixtures['execution.authorizeTool'].args,
      }),
    ).toThrow();
    expect(() =>
      assertSubAgentTransportControlRequest({
        ...request('completion.submitResult', fixtures['completion.submitResult'].args),
        args: fixtures['delegation.execute'].args,
      }),
    ).toThrow();
    expect(() =>
      assertSubAgentTransportControlRequest({
        ...request('task.cancel', fixtures['task.cancel'].args),
        args: fixtures['execution.reportProgress'].args,
      }),
    ).toThrow();
    expect(() =>
      assertSubAgentTransportControlReply({
        ...successfulReply('execution.authorizeTool', fixtures['execution.authorizeTool'].result),
        result: fixtures['completion.complete'].result,
      }),
    ).toThrow();
    expect(() =>
      assertSubAgentTransportControlReply({
        ...successfulReply('completion.submitResult', fixtures['completion.submitResult'].result),
        result: fixtures['delegation.execute'].result,
      }),
    ).toThrow();
    expect(() =>
      assertSubAgentTransportControlReply({
        ...successfulReply('task.snapshot', fixtures['task.snapshot'].result),
        result: fixtures['task.wait'].result,
      }),
    ).toThrow();

    const missingArgs = {
      ...request('task.snapshot', { taskId: CHILD_TASK_ID }),
    } as Record<string, unknown>;
    delete missingArgs.args;
    expect(() => assertSubAgentTransportControlRequest(missingArgs)).toThrow();
    expect(() =>
      assertSubAgentTransportControlRequest({
        ...request('completion.submitResult', {
          callId: 'call-result-1',
          candidate: null,
        }),
        args: { callId: 'call-result-1', candidate: undefined },
      }),
    ).toThrow();
    expect(() =>
      assertSubAgentTransportControlReply({
        method: 'task.snapshot',
        ok: false,
        error: new Error('raw errors must not cross the transport boundary'),
      }),
    ).toThrow();
    expect(() =>
      assertSubAgentTransportControlReply({
        method: 'task.snapshot',
        ok: false,
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'The requested resource was not found.',
          retryable: false,
          eventCursor: 4,
        },
      }),
    ).toThrow();
  });

  it('bounds direct decoder structure before recursive method validation', () => {
    let candidate: unknown = null;
    for (let depth = 0; depth < 10_000; depth += 1) candidate = { next: candidate };

    expect(() =>
      decodeSubAgentTransportControlRequest({
        taskId: TASK_ID,
        operationId: 'operation-deep',
        method: 'completion.submitResult',
        args: { callId: 'call-deep', candidate },
      }),
    ).toThrow();
  });

  it('decodes owned, recursively frozen messages', () => {
    const fixture = createMethodFixtures()['execution.reportProgress'];
    const expectedArgs = structuredClone(fixture.args);
    const mutable = request('execution.reportProgress', fixture.args) as unknown as {
      taskId: string;
      args: { update: { data: { phase: string } } };
    };
    const decoded = decodeSubAgentTransportControlRequest(mutable);
    mutable.taskId = 'mutated-task';
    mutable.args.update.data.phase = 'mutated';

    expect(decoded.taskId).toBe(TASK_ID);
    expect(decoded.args).toEqual(expectedArgs);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.args)).toBe(true);
    expect(Object.isFrozen((decoded.args as { update: object }).update)).toBe(true);
  });

  it('rejects C0 and DEL characters in direct control identifiers', () => {
    for (const taskId of ['task\u0000hidden', 'task\u001fhidden', 'task\u007fhidden']) {
      expect(() =>
        decodeSubAgentTransportControlRequest({
          ...request('task.snapshot', { taskId: CHILD_TASK_ID }),
          taskId,
        }),
      ).toThrow();
    }
  });
});

describe('Subagent transport control dispatcher', () => {
  it('injects the outer operationId and delegates every method to trusted controls', async () => {
    const trusted = createTrustedControl();
    const dispatcher = createSubAgentTransportControlDispatcher({
      control: trusted.control,
      taskId: TASK_ID,
      ownerSessionId: 'owner-session-1',
    });
    const fixtures = createMethodFixtures();
    const replies = new Map<SubAgentTransportControlMethod, SubAgentTransportControlReply>();

    for (const method of SUBAGENT_TRANSPORT_CONTROL_METHODS) {
      const reply = await dispatcher.dispatch(
        request(method, fixtures[method].args, {
          taskId: TASK_ID,
          operationId: `outer-${method}`,
        }),
      );
      replies.set(method, reply);
      expect(reply.method).toBe(method);
      expect(reply.ok).toBe(true);
      if (reply.ok) expect(reply.result).toEqual(fixtures[method].result);
    }

    const checkpoint = createCheckpoint();
    expect(trusted.calls.commitBinding).toHaveBeenCalledWith(
      'outer-execution.commitBinding',
      createBinding(),
    );
    expect(trusted.calls.commitCheckpoint).toHaveBeenCalledWith(
      'outer-execution.commitCheckpoint',
      checkpoint,
    );
    expect(trusted.calls.authorizeTool).toHaveBeenCalledWith(
      'outer-execution.authorizeTool',
      {
        callId: 'call-tool-1',
        toolName: 'write-report',
        summary: 'Write the reviewed report.',
        expiresAt: 10_000,
      },
      checkpoint,
    );
    expect(trusted.calls.pauseDelegation).toHaveBeenCalledWith(
      'outer-execution.pauseDelegation',
      createMethodFixtures()['execution.pauseDelegation'].args.input,
    );
    expect(trusted.calls.reportProgress).toHaveBeenCalledWith('outer-execution.reportProgress', {
      message: 'halfway',
      percent: 50,
      data: { phase: 'review' },
    });
    expect(trusted.calls.consumeBudget).toHaveBeenCalledWith('outer-execution.consumeBudget', {
      turns: 1,
      providerCalls: 1,
      inputTokens: 100,
      cost: 0.01,
    });
    expect(trusted.calls.emit).toHaveBeenCalledWith('outer-execution.emit', {
      type: 'progress.reported',
      timestamp: 2_000,
      data: { status: 'running', length: 12 },
    });

    expect(trusted.calls.submitResult).toHaveBeenCalledWith('call-result-1', { proof: 'done' });
    expect(trusted.calls.complete).toHaveBeenCalledWith('call-end-1', {
      isStandalone: true,
    });
    expect(trusted.calls.fail).toHaveBeenCalledWith(
      'call-fail-1',
      createMethodFixtures()['completion.fail'].args.failure,
    );
    expect(trusted.calls.execute).toHaveBeenCalledWith(
      createMethodFixtures()['delegation.execute'].args.request,
    );
    expect(trusted.calls.spawn).toHaveBeenCalledWith(
      createMethodFixtures()['delegation.spawn'].args.request,
    );
    expect(trusted.calls.resumeTool).toHaveBeenCalledWith(CHILD_TASK_ID);
    expect(trusted.childHandle.snapshot).toHaveBeenCalledTimes(1);
    expect(trusted.childHandle.wait).toHaveBeenCalledTimes(1);
    expect(trusted.childHandle.cancel).toHaveBeenCalledWith('host-cancelled');

    expect(replies.get('delegation.spawn')).toEqual(
      successfulReply('delegation.spawn', { taskId: CHILD_TASK_ID }),
    );
    expect(replies.get('delegation.resumeTool')).toEqual(
      successfulReply('delegation.resumeTool', { taskId: CHILD_TASK_ID }),
    );
  });

  it('returns the same non-enumerating error for unknown and cross-scope task identities', async () => {
    const trusted = createTrustedControl();
    const dispatcher = createSubAgentTransportControlDispatcher({
      control: trusted.control,
      taskId: TASK_ID,
      ownerSessionId: 'owner-session-1',
    });

    const crossScope = await dispatcher.dispatch(
      request(
        'execution.reportProgress',
        { update: { message: 'hidden' } },
        {
          taskId: 'task-from-another-session',
        },
      ),
    );
    const unknown = await dispatcher.dispatch(
      request('task.snapshot', { taskId: 'unknown-child-task' }),
    );

    expect(crossScope).toEqual({
      method: 'execution.reportProgress',
      ok: false,
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'The requested resource was not found.',
        retryable: false,
      },
    });
    expect(unknown).toEqual({
      method: 'task.snapshot',
      ok: false,
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'The requested resource was not found.',
        retryable: false,
      },
    });
    if (!crossScope.ok && !unknown.ok) expect(crossScope.error).toEqual(unknown.error);
    expect(trusted.calls.reportProgress).not.toHaveBeenCalled();
  });

  it('maps trusted exceptions to closed safe replies without raw error details', async () => {
    const trusted = createTrustedControl();
    trusted.calls.reportProgress.mockRejectedValueOnce(
      Object.assign(new Error('provider body contains secret-token'), {
        body: { apiKey: 'secret-token' },
        status: 502,
      }),
    );
    trusted.calls.execute.mockRejectedValueOnce(createResourceNotFoundError());
    const dispatcher = createSubAgentTransportControlDispatcher({
      control: trusted.control,
      taskId: TASK_ID,
      ownerSessionId: 'owner-session-1',
    });

    const internal = await dispatcher.dispatch(
      request('execution.reportProgress', { update: { message: 'halfway' } }),
    );
    const stable = await dispatcher.dispatch(
      request('delegation.execute', createMethodFixtures()['delegation.execute'].args),
    );

    expect(internal.method).toBe('execution.reportProgress');
    expect(internal.ok).toBe(false);
    if (!internal.ok) {
      expect(internal.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(internal.error)).not.toContain('secret-token');
      expect(Object.keys(internal.error).sort()).toEqual(['code', 'message', 'retryable']);
    }
    expect(stable).toEqual({
      method: 'delegation.execute',
      ok: false,
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'The requested resource was not found.',
        retryable: false,
      },
    });
    expect(() => assertSubAgentTransportControlReply(internal)).not.toThrow();
    expect(() => assertSubAgentTransportControlReply(stable)).not.toThrow();
  });

  it('rejects authoritative or malformed executor events before invoking trusted emit', async () => {
    const trusted = createTrustedControl();
    const dispatcher = createSubAgentTransportControlDispatcher({
      control: trusted.control,
      taskId: TASK_ID,
      ownerSessionId: 'owner-session-1',
    });
    const invalidEvents: readonly unknown[] = [
      { type: 'task.started', data: { status: 'running' } },
      { type: 'approval.requested', data: { approvalId: 'approval-1' } },
      { type: 'usage.updated', data: { usage: { turns: 1, providerCalls: 1 } } },
      { type: 'budget.rejected', data: { errorCode: 'BUDGET_EXCEEDED' } },
      { type: 'progress.reported', data: { providerBody: 'must-not-cross' } },
      { type: 'progress.reported', data: { length: 'not-a-number' } },
    ];

    for (const [index, event] of invalidEvents.entries()) {
      const invalidRequest = {
        taskId: TASK_ID,
        operationId: `invalid-event-${index}`,
        method: 'execution.emit',
        args: { event },
      } as unknown as SubAgentTransportControlRequest;
      await expect(dispatcher.dispatch(invalidRequest)).rejects.toThrow();
    }
    expect(trusted.calls.emit).not.toHaveBeenCalled();
  });

  it('maps mismatched receipt and task-handle result scope to safe failures', async () => {
    const trusted = createTrustedControl();
    const fixtures = createMethodFixtures();
    trusted.calls.submitResult.mockResolvedValueOnce({
      ...fixtures['completion.submitResult'].result,
      taskId: 'task-from-another-session',
    });
    (trusted.childHandle.snapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      createTaskSnapshot('task-from-another-session'),
    );
    const dispatcher = createSubAgentTransportControlDispatcher({
      control: trusted.control,
      taskId: TASK_ID,
      ownerSessionId: 'owner-session-1',
    });

    const receiptReply = await dispatcher.dispatch(
      request('completion.submitResult', fixtures['completion.submitResult'].args),
    );
    await dispatcher.dispatch(request('delegation.spawn', fixtures['delegation.spawn'].args));
    const snapshotReply = await dispatcher.dispatch(
      request('task.snapshot', fixtures['task.snapshot'].args),
    );

    expect(receiptReply).toMatchObject({
      method: 'completion.submitResult',
      ok: false,
      error: { code: 'INTERNAL_ERROR', retryable: false },
    });
    expect(snapshotReply).toMatchObject({
      method: 'task.snapshot',
      ok: false,
      error: { code: 'INTERNAL_ERROR', retryable: false },
    });
  });

  it('rejects control results that do not exactly correlate to their requests', async () => {
    const trusted = createTrustedControl();
    const dispatcher = createSubAgentTransportControlDispatcher({
      control: trusted.control,
      taskId: TASK_ID,
      ownerSessionId: 'owner-session-1',
    });
    const fixtures = createMethodFixtures();
    const authorize = fixtures['execution.authorizeTool'];
    const authorizeResult = authorize.result;
    if (authorizeResult.type !== 'suspend') throw new Error('Expected suspend fixture.');
    const mismatchedApprovalRequests: readonly ApprovalRequest[] = [
      { ...authorizeResult.request, callId: 'other-call' },
      { ...authorizeResult.request, toolName: 'other-tool' },
      { ...authorizeResult.request, summary: 'Changed summary.' },
      { ...authorizeResult.request, expiresAt: 9_999 },
      { ...authorizeResult.request, taskId: 'other-task' },
      { ...authorizeResult.request, ownerSessionId: 'other-owner' },
    ];
    for (const approvalRequest of mismatchedApprovalRequests) {
      trusted.calls.authorizeTool.mockResolvedValueOnce({
        ...authorizeResult,
        request: approvalRequest,
      });
      const reply = await dispatcher.dispatch(request('execution.authorizeTool', authorize.args));
      expect(reply).toMatchObject({
        method: 'execution.authorizeTool',
        ok: false,
        error: { code: 'INTERNAL_ERROR', retryable: false },
      });
    }

    const firstApproval: ApprovalRequest = {
      ...createApproval('task-child-a'),
      callId: 'call-a',
      approvalId: 'approval-a',
    };
    const secondApproval: ApprovalRequest = {
      ...createApproval('task-child-b'),
      callId: 'call-b',
      toolName: 'read-report',
      summary: 'Read the reviewed report.',
      approvalId: 'approval-b',
    };
    const pauseArgs: SubAgentTransportControlArgsMap['execution.pauseDelegation'] = {
      input: {
        checkpoint: createCheckpoint(),
        calls: [
          { callId: 'call-agent-a', childTaskId: 'task-child-a', approvals: [firstApproval] },
          { callId: 'call-agent-b', childTaskId: 'task-child-b', approvals: [secondApproval] },
        ],
      },
    };
    const pauseCases = [
      { args: pauseArgs, approvals: [secondApproval, firstApproval] },
      { args: pauseArgs, approvals: [firstApproval, firstApproval] },
      {
        args: pauseArgs,
        approvals: [{ ...firstApproval, summary: 'Changed summary.' }, secondApproval],
      },
      {
        args: pauseArgs,
        approvals: [{ ...firstApproval, ownerSessionId: 'other-owner' }, secondApproval],
      },
      {
        args: {
          input: {
            ...pauseArgs.input,
            calls: [
              {
                callId: 'call-agent-a',
                childTaskId: 'task-child-a',
                approvals: [firstApproval, firstApproval],
              },
            ],
          },
        },
        approvals: [firstApproval, firstApproval],
      },
    ] as const;
    for (const pauseCase of pauseCases) {
      trusted.calls.pauseDelegation.mockResolvedValueOnce({
        checkpointRevision: 4,
        approvals: pauseCase.approvals,
      });
      const reply = await dispatcher.dispatch(request('execution.pauseDelegation', pauseCase.args));
      expect(reply).toMatchObject({
        method: 'execution.pauseDelegation',
        ok: false,
        error: { code: 'INTERNAL_ERROR', retryable: false },
      });
    }

    trusted.calls.submitResult.mockResolvedValueOnce({
      ...fixtures['completion.submitResult'].result,
      outputHash: 'b'.repeat(64),
    });
    const hashReply = await dispatcher.dispatch(
      request('completion.submitResult', fixtures['completion.submitResult'].args),
    );
    expect(hashReply).toMatchObject({
      method: 'completion.submitResult',
      ok: true,
      result: { outputHash: 'b'.repeat(64) },
    });

    const failureArgs: SubAgentTransportControlArgsMap['completion.fail'] = {
      callId: 'call-correlated-failure',
      failure: {
        status: 'failed',
        error: {
          code: 'EXECUTOR_FAILED',
          message: 'The child runner failed.',
          retryable: false,
          outcomeUnknown: true,
        },
        partialOutput: { phase: 'review' },
      },
    };
    const matchingFailure = {
      ...createTaskResult(),
      error: { ...createTaskResult().error, outcomeUnknown: true },
    };
    const failureWithoutPartial: SubAgentTransportTaskResult = {
      status: matchingFailure.status,
      task: matchingFailure.task,
      executor: matchingFailure.executor,
      error: matchingFailure.error,
    };
    const mismatchedFailures: readonly SubAgentTransportTaskResult[] = [
      { ...matchingFailure, status: 'cancelled' },
      { ...matchingFailure, error: { ...matchingFailure.error, code: 'INTERNAL_ERROR' } },
      { ...matchingFailure, error: { ...matchingFailure.error, retryable: true } },
      { ...matchingFailure, error: { ...matchingFailure.error, outcomeUnknown: false } },
      failureWithoutPartial,
    ];
    for (const failureResult of mismatchedFailures) {
      trusted.calls.fail.mockResolvedValueOnce(failureResult);
      const reply = await dispatcher.dispatch(request('completion.fail', failureArgs));
      expect(reply).toMatchObject({
        method: 'completion.fail',
        ok: false,
        error: { code: 'INTERNAL_ERROR', retryable: false },
      });
    }
    trusted.calls.fail.mockResolvedValueOnce({
      ...matchingFailure,
      partialOutput: { phase: 'transformed' },
    });
    const transformedFailureReply = await dispatcher.dispatch(
      request('completion.fail', failureArgs),
    );
    expect(transformedFailureReply).toMatchObject({
      method: 'completion.fail',
      ok: true,
      result: { partialOutput: { phase: 'transformed' } },
    });

    const delegationArgs = fixtures['delegation.execute'].args;
    const delegationOutcome = createOutcome();
    if (delegationOutcome.type !== 'terminal') throw new Error('Expected terminal fixture.');
    const mismatchedDelegationOutcomes: readonly SubAgentTransportExecutionOutcome[] = [
      {
        ...delegationOutcome,
        result: {
          ...delegationOutcome.result,
          task: {
            ...delegationOutcome.result.task,
            subAgent: { name: 'other-subagent', version: '1' },
          },
        },
      },
      {
        ...delegationOutcome,
        result: { ...delegationOutcome.result, executor: 'worker' },
      },
    ];
    for (const outcome of mismatchedDelegationOutcomes) {
      trusted.calls.execute.mockResolvedValueOnce(outcome);
      const reply = await dispatcher.dispatch(request('delegation.execute', delegationArgs));
      expect(reply).toMatchObject({
        method: 'delegation.execute',
        ok: false,
        error: { code: 'INTERNAL_ERROR', retryable: false },
      });
    }
  });

  it('deep-projects host-local event cursors out of Core results before replying', async () => {
    const trusted = createTrustedControl();
    const failureWithCursor: SubAgentTaskResult = {
      status: 'failed',
      task: {
        taskId: TASK_ID,
        subAgent: { name: 'researcher', version: '2' },
      },
      executor: 'process',
      error: {
        code: 'EXECUTOR_FAILED',
        message: 'The child runner failed.',
        retryable: false,
        eventCursor: 7,
      },
      partialOutput: { phase: 'review' },
    };
    const snapshotWithCursor: SubAgentTaskSnapshot = {
      ...createTaskSnapshot(),
      state: 'failed',
      completedAt: 2_500,
      error: {
        code: 'EVENT_BACKPRESSURE',
        message: 'The event subscriber fell behind.',
        retryable: true,
        eventCursor: 11,
      },
    };
    trusted.calls.fail.mockResolvedValueOnce(failureWithCursor);
    (trusted.childHandle.snapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      snapshotWithCursor,
    );
    const dispatcher = createSubAgentTransportControlDispatcher({
      control: trusted.control,
      taskId: TASK_ID,
      ownerSessionId: 'owner-session-1',
    });
    const fixtures = createMethodFixtures();

    const failureReply = await dispatcher.dispatch(
      request('completion.fail', fixtures['completion.fail'].args),
    );
    await dispatcher.dispatch(request('delegation.spawn', fixtures['delegation.spawn'].args));
    const snapshotReply = await dispatcher.dispatch(
      request('task.snapshot', fixtures['task.snapshot'].args),
    );

    expect(failureReply).toMatchObject({
      method: 'completion.fail',
      ok: true,
      result: { status: 'failed', error: { code: 'EXECUTOR_FAILED' } },
    });
    expect(snapshotReply).toMatchObject({
      method: 'task.snapshot',
      ok: true,
      result: { state: 'failed', error: { code: 'EVENT_BACKPRESSURE' } },
    });
    expect(JSON.stringify(failureReply)).not.toContain('eventCursor');
    expect(JSON.stringify(snapshotReply)).not.toContain('eventCursor');
  });
});

describe('Remote Subagent execution control proxy', () => {
  it('rejects a negative absolute deadline before creating a remote control', () => {
    const catalog = createCatalogFixtures();
    expect(() =>
      createRemoteSubAgentExecutionControl({
        taskId: TASK_ID,
        signal: new AbortController().signal,
        deadlineAt: -1,
        delegationSnapshot: catalog.delegation,
        catalog: catalog.catalog,
        catalogEntries: catalog.entries,
        exchange: async () => {
          throw new Error('invalid options must not exchange');
        },
        createOperationId: (method, taskId = TASK_ID) => `generated-${method}-${taskId}`,
        events: () => createEventStream([]),
      }),
    ).toThrow('Remote control deadlineAt must be a non-negative safe integer.');
  });

  it('reuses one frozen custom JSON boundary across proxy and dispatcher', async () => {
    let deepData: JsonValue = null;
    for (let depth = 0; depth < 130; depth += 1) deepData = { next: deepData };

    const mutableValidation = { maxDepth: 160 };
    const trusted = createTrustedControl();
    const dispatcher = createSubAgentTransportControlDispatcher({
      control: trusted.control,
      taskId: TASK_ID,
      ownerSessionId: 'owner-session-1',
      validation: mutableValidation,
    });
    const catalog = createCatalogFixtures();
    const remote = createRemoteSubAgentExecutionControl({
      taskId: TASK_ID,
      signal: new AbortController().signal,
      deadlineAt: 120_000,
      delegationSnapshot: catalog.delegation,
      catalog: catalog.catalog,
      catalogEntries: catalog.entries,
      exchange: (controlRequest) => dispatcher.dispatch(controlRequest),
      createOperationId: (method, taskId = TASK_ID) => `generated-${method}-${taskId}`,
      validation: mutableValidation,
      events: () => createEventStream([]),
    });

    mutableValidation.maxDepth = 1;
    await expect(
      remote.reportProgress('operation-deep-progress', {
        message: 'deep progress remains valid',
        data: deepData,
      }),
    ).resolves.toBeUndefined();
    expect(trusted.calls.reportProgress).toHaveBeenCalledWith('operation-deep-progress', {
      message: 'deep progress remains valid',
      data: deepData,
    });

    expect(() =>
      decodeSubAgentTransportControlRequest(
        request('execution.reportProgress', {
          update: { message: 'deep progress remains valid', data: deepData },
        }),
      ),
    ).toThrow();
  });

  it('rejects dispatch-context scope and streaming before any exchange or fallback', async () => {
    const catalog = createCatalogFixtures();
    const exchange = vi.fn(async () => {
      throw new Error('invalid context must not exchange');
    });
    const createOperationId = vi.fn(
      (method: SubAgentTransportControlMethod, taskId = TASK_ID) => `generated-${method}-${taskId}`,
    );
    const remote = createRemoteSubAgentExecutionControl({
      taskId: TASK_ID,
      signal: new AbortController().signal,
      deadlineAt: 120_000,
      delegationSnapshot: catalog.delegation,
      catalog: catalog.catalog,
      catalogEntries: catalog.entries,
      exchange,
      createOperationId,
      events: () => createEventStream([]),
    });
    const modelRequest = {
      subAgent: 'reviewer',
      executor: 'process',
      input: { query: 'review this' },
    } as const;
    const context: SubAgentDispatchContext = {
      ownerSessionId: 'owner-session-1',
      runId: 'run-1',
      requestId: 'model-call-1',
      parentTaskId: TASK_ID,
      parentContext: [],
      parentRawHistory: [],
      signal: new AbortController().signal,
    };
    const invoke = [
      (value: SubAgentDispatchContext) => remote.delegation.submitTool(modelRequest, value),
      (value: SubAgentDispatchContext) => remote.delegation.dispatchTool(modelRequest, value),
    ];
    const mismatches: readonly SubAgentDispatchContext[] = [
      { ...context, ownerSessionId: 'other-owner' },
      { ...context, runId: 'other-run' },
      { ...context, parentTaskId: 'other-parent' },
    ];

    for (const call of invoke) {
      for (const mismatch of mismatches) {
        await expect(call(mismatch)).rejects.toMatchObject({
          descriptor: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'The requested resource was not found.',
            retryable: false,
          },
        });
      }
      await expect(call({ ...context, stream: true })).rejects.toMatchObject({
        descriptor: { code: 'STREAMING_UNSUPPORTED', retryable: false },
      });
    }
    expect(exchange).not.toHaveBeenCalled();
    expect(createOperationId).not.toHaveBeenCalled();
  });

  it('uses strict exchange for every control family and preserves outer execution operation IDs', async () => {
    const fixtures = createMethodFixtures();
    const exchange = vi.fn(
      async (
        controlRequest: SubAgentTransportControlRequest,
        context: SubAgentTransportControlExchangeContext,
      ): Promise<SubAgentTransportControlReply> => {
        void context;
        return successfulReply(controlRequest.method, fixtures[controlRequest.method].result);
      },
    );
    const createOperationId = vi.fn(
      (method: SubAgentTransportControlMethod, taskId = TASK_ID) => `generated-${method}-${taskId}`,
    );
    const events = vi.fn((taskId: string) => createEventStream([createTaskEvent(taskId)]));
    const catalog = createCatalogFixtures();
    const signal = new AbortController().signal;
    const remote = createRemoteSubAgentExecutionControl({
      taskId: TASK_ID,
      signal,
      deadlineAt: 120_000,
      delegationSnapshot: catalog.delegation,
      catalog: catalog.catalog,
      catalogEntries: catalog.entries,
      exchange,
      createOperationId,
      events,
    });

    await remote.commitBinding('outer-binding', createBinding());
    await remote.commitCheckpoint('outer-checkpoint', createCheckpoint());
    await remote.authorizeTool(
      'outer-authorize',
      {
        callId: 'call-tool-1',
        toolName: 'write-report',
        summary: 'Write the reviewed report.',
        expiresAt: 10_000,
      },
      createCheckpoint(),
    );
    await remote.pauseDelegation(
      'outer-pause',
      (fixtures['execution.pauseDelegation'].args as { input: SubAgentDelegationPauseInput }).input,
    );
    await remote.reportProgress('outer-progress', {
      message: 'halfway',
      percent: 50,
      data: { phase: 'review' },
    });
    await remote.consumeBudget('outer-budget', {
      turns: 1,
      providerCalls: 1,
      inputTokens: 100,
      cost: 0.01,
    });
    await remote.emit('outer-event', {
      type: 'progress.reported',
      timestamp: 2_000,
      data: { status: 'running', length: 12 },
    });

    await remote.completion.submitResult('call-result-1', { proof: 'done' });
    await remote.completion.complete('call-end-1', { isStandalone: true });
    await remote.completion.fail(
      'call-fail-1',
      (fixtures['completion.fail'].args as { failure: SubAgentFailureInput }).failure,
    );
    await remote.delegation.execute(
      (
        fixtures['delegation.execute'].args as {
          request: Parameters<SubAgentExecutionControl['delegation']['execute']>[0];
        }
      ).request,
    );
    const spawned = await remote.delegation.spawn(
      (
        fixtures['delegation.spawn'].args as {
          request: Parameters<SubAgentExecutionControl['delegation']['spawn']>[0];
        }
      ).request,
    );
    const resumed = await remote.delegation.resumeTool(CHILD_TASK_ID);
    await spawned.snapshot();
    await spawned.wait();
    await spawned.cancel('host-cancelled');
    expect(resumed.taskId).toBe(CHILD_TASK_ID);
    expect(await collectEvents(spawned.events({ afterSequence: 0, limit: 10 }))).toEqual([
      createTaskEvent(),
    ]);

    expect(remote.signal).toBe(signal);
    expect(remote.deadlineAt).toBe(120_000);
    expect(remote.artifacts).toBeUndefined();
    const sent = exchange.mock.calls.map(([controlRequest]) => controlRequest);
    const contexts = exchange.mock.calls.map(([, context]) => context);
    expect(sent).toHaveLength(16);
    expect(contexts).toHaveLength(16);
    expect(new Set(contexts).size).toBe(1);
    for (const context of contexts) {
      expect(Object.isFrozen(context)).toBe(true);
      expect(context.signal).toBe(signal);
      expect(context.deadlineAt).toBe(120_000);
    }
    expect(sent.slice(0, 7).map(({ operationId }) => operationId)).toEqual([
      'outer-binding',
      'outer-checkpoint',
      'outer-authorize',
      'outer-pause',
      'outer-progress',
      'outer-budget',
      'outer-event',
    ]);
    for (const controlRequest of sent) {
      expect('operationId' in (controlRequest.args as object)).toBe(false);
      expect(() => assertSubAgentTransportControlRequest(controlRequest)).not.toThrow();
    }
    expect(createOperationId).toHaveBeenCalledTimes(9);
    expect(events).toHaveBeenCalledWith(CHILD_TASK_ID, { afterSequence: 0, limit: 10 });
  });

  it('delivers an owned frozen request while preserving abort-signal identity', async () => {
    const catalog = createCatalogFixtures();
    const controller = new AbortController();
    const delivered: Array<SubAgentTransportControlRequest<'execution.reportProgress'>> = [];
    const contexts: SubAgentTransportControlExchangeContext[] = [];
    let releaseExchange: (() => void) | undefined;
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const exchange = vi.fn(
      async (
        controlRequest: SubAgentTransportControlRequest,
        context: SubAgentTransportControlExchangeContext,
      ): Promise<SubAgentTransportControlReply> => {
        if (controlRequest.method !== 'execution.reportProgress') {
          throw new Error('Unexpected control method.');
        }
        delivered.push(controlRequest);
        contexts.push(context);
        await exchangeGate;
        return successfulReply('execution.reportProgress', null);
      },
    );
    const remote = createRemoteSubAgentExecutionControl({
      taskId: TASK_ID,
      signal: controller.signal,
      deadlineAt: 120_000,
      delegationSnapshot: catalog.delegation,
      catalog: catalog.catalog,
      catalogEntries: catalog.entries,
      exchange,
      createOperationId: (method, taskId = TASK_ID) => `generated-${method}-${taskId}`,
      events: () => createEventStream([]),
    });
    const mutableUpdate = {
      message: 'before mutation',
      data: { phase: 'before' },
    };

    const pending = remote.reportProgress('operation-owned-request', mutableUpdate);
    expect(delivered).toHaveLength(1);
    mutableUpdate.message = 'after mutation';
    mutableUpdate.data.phase = 'after';

    expect(delivered[0]).toEqual({
      taskId: TASK_ID,
      operationId: 'operation-owned-request',
      method: 'execution.reportProgress',
      args: {
        update: {
          message: 'before mutation',
          data: { phase: 'before' },
        },
      },
    });
    expect(Object.isFrozen(delivered[0])).toBe(true);
    expect(Object.isFrozen(delivered[0]?.args)).toBe(true);
    expect(Object.isFrozen(delivered[0]?.args.update)).toBe(true);
    expect(Object.isFrozen(delivered[0]?.args.update.data)).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(Object.isFrozen(contexts[0])).toBe(true);
    expect(contexts[0]?.signal).toBe(controller.signal);
    expect(contexts[0]?.deadlineAt).toBe(120_000);

    releaseExchange?.();
    await pending;
  });

  it('captures a synchronous, recursively frozen registry/delegation intersection without exchange', async () => {
    const catalog = createCatalogFixtures();
    const exchange = vi.fn(async () => {
      throw new Error('catalog reads must not exchange');
    });
    const remote = createRemoteSubAgentExecutionControl({
      taskId: TASK_ID,
      signal: new AbortController().signal,
      deadlineAt: 120_000,
      delegationSnapshot: catalog.delegation,
      catalog: catalog.catalog,
      catalogEntries: catalog.entries,
      exchange,
      createOperationId: (method, taskId = TASK_ID) => `generated-${method}-${taskId}`,
      events: () => createEventStream([]),
    });

    const snapshot = remote.delegation.getCatalog();
    const entries = remote.delegation.getCatalogEntries();
    expect(snapshot).not.toBeInstanceOf(Promise);
    expect(entries).not.toBeInstanceOf(Promise);
    expect(exchange).not.toHaveBeenCalled();
    expect(snapshot.revision).toBe(7);
    expect(snapshot.executors.map(({ descriptor }) => descriptor.name)).toEqual(['process']);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.definition).toEqual({ name: 'reviewer', version: '1' });
    expect(entries[0]?.executors.map(({ name }) => name)).toEqual(['process']);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.executors)).toBe(true);
    expect(Object.isFrozen(snapshot.executors[0]?.descriptor)).toBe(true);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(Object.isFrozen(entries[0]?.definition)).toBe(true);
    expect(Object.isFrozen(entries[0]?.executors)).toBe(true);

    (catalog.catalog.executors as Array<unknown>).push({});
    (catalog.delegation.definitions as Array<unknown>).push({
      name: 'late-definition',
      version: '1',
      executors: ['worker'],
    });
    (catalog.entries as Array<unknown>).push({});
    expect(remote.delegation.getCatalog()).toBe(snapshot);
    expect(remote.delegation.getCatalogEntries()).toBe(entries);
    expect(snapshot.executors.map(({ descriptor }) => descriptor.name)).toEqual(['process']);
    expect(entries.map(({ definition }) => definition.name)).toEqual(['reviewer']);
    expect(exchange).not.toHaveBeenCalled();

    await expect(
      remote.delegation.execute({
        requestId: 'disallowed-placement',
        subAgent: 'reviewer',
        executor: 'worker',
        input: { query: 'do not fall back to process' },
      }),
    ).rejects.toMatchObject({
      descriptor: { code: 'CHILD_DEFINITION_DISALLOWED', retryable: false },
    });
    await expect(
      remote.delegation.execute({
        requestId: 'unknown-definition',
        subAgent: 'unrelated',
        executor: 'process',
        input: { query: 'do not use a local-only definition' },
      }),
    ).rejects.toMatchObject({
      descriptor: { code: 'CHILD_DEFINITION_DISALLOWED', retryable: false },
    });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('rejects a mismatched reply and rethrows only the stable safe error descriptor', async () => {
    const catalog = createCatalogFixtures();
    const exchange = vi
      .fn()
      .mockResolvedValueOnce(successfulReply('execution.consumeBudget', null))
      .mockResolvedValueOnce({
        method: 'execution.reportProgress',
        ok: false,
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'The requested resource was not found.',
          retryable: false,
        },
      });
    const remote = createRemoteSubAgentExecutionControl({
      taskId: TASK_ID,
      signal: new AbortController().signal,
      deadlineAt: 120_000,
      delegationSnapshot: catalog.delegation,
      catalog: catalog.catalog,
      catalogEntries: catalog.entries,
      exchange,
      createOperationId: (method, taskId = TASK_ID) => `generated-${method}-${taskId}`,
      events: () => createEventStream([]),
    });

    await expect(
      remote.reportProgress('operation-mismatch', { message: 'halfway' }),
    ).rejects.toThrow();
    const failure = await remote
      .reportProgress('operation-safe-error', { message: 'halfway' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubAgentRuntimeError);
    expect((failure as SubAgentRuntimeError).descriptor).toEqual({
      code: 'RESOURCE_NOT_FOUND',
      message: 'The requested resource was not found.',
      retryable: false,
    });
  });

  it('rejects a remote suspend approval from another owner session', async () => {
    const catalog = createCatalogFixtures();
    const fixture = createMethodFixtures()['execution.authorizeTool'];
    if (fixture.result.type !== 'suspend') throw new Error('Expected suspend fixture.');
    const suspendResult = fixture.result;
    const exchange = vi.fn(async () =>
      successfulReply('execution.authorizeTool', {
        ...suspendResult,
        request: { ...suspendResult.request, ownerSessionId: 'other-owner' },
      }),
    );
    const remote = createRemoteSubAgentExecutionControl({
      taskId: TASK_ID,
      signal: new AbortController().signal,
      deadlineAt: 120_000,
      delegationSnapshot: catalog.delegation,
      catalog: catalog.catalog,
      catalogEntries: catalog.entries,
      exchange,
      createOperationId: () => 'operation-authorize',
      events: () => createEventStream([]),
    });

    await expect(
      remote.authorizeTool('operation-authorize', fixture.args.request, fixture.args.checkpoint),
    ).rejects.toThrow();
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('deep-projects host-local event cursors out of outbound completion failures', async () => {
    const catalog = createCatalogFixtures();
    const sent: SubAgentTransportControlRequest[] = [];
    const exchange = vi.fn(async (controlRequest: SubAgentTransportControlRequest) => {
      sent.push(controlRequest);
      return successfulReply('completion.fail', {
        status: 'failed',
        task: {
          taskId: TASK_ID,
          subAgent: { name: 'researcher', version: '2' },
        },
        executor: 'process',
        error: {
          code: 'EXECUTOR_FAILED',
          message: 'The child execution failed.',
          retryable: false,
        },
      });
    });
    const remote = createRemoteSubAgentExecutionControl({
      taskId: TASK_ID,
      signal: new AbortController().signal,
      deadlineAt: 120_000,
      delegationSnapshot: catalog.delegation,
      catalog: catalog.catalog,
      catalogEntries: catalog.entries,
      exchange,
      createOperationId: () => 'operation-completion-fail',
      events: () => createEventStream([]),
    });

    await remote.completion.fail('call-fail-1', {
      status: 'failed',
      error: {
        code: 'EXECUTOR_FAILED',
        message: 'The child execution failed.',
        retryable: false,
        eventCursor: 19,
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'completion.fail' });
    expect(JSON.stringify(sent[0])).not.toContain('eventCursor');
  });
});

async function collectEvents(
  stream: AsyncIterable<SubAgentTaskEvent>,
): Promise<readonly SubAgentTaskEvent[]> {
  const events: SubAgentTaskEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
