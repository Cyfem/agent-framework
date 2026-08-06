import assert from 'node:assert/strict';

import {
  DEFAULT_SUBAGENT_LIMITS,
  canonicalJsonSha256,
  canonicalizeJson,
  type AgentProtocolCheckpointCodec,
  type ApprovalDirective,
  type ApprovalRequestInput,
  type ExecutorTaskHandle,
  type JsonValue,
  type SubAgentChildCheckpoint,
  type SubAgentDefinitionRef,
  type SubAgentDelegationClient,
  type SubAgentExecutionControl,
  type SubAgentExecutionOutcome,
  type SubAgentExecutionRequest,
  type SubAgentExecutor,
  type SubAgentExecutorBinding,
  type SubAgentProgress,
  type SubAgentTaskEvent,
  type SubAgentUsageDelta,
  type ExecutorEventInput,
} from '../../packages/core/src';

export type ExecutorConformanceScenario = 'settle' | 'cancel' | 'approval-resume';

export interface SubAgentExecutorConformanceSubject {
  readonly executor: SubAgentExecutor;
  readonly definition: SubAgentDefinitionRef;
  readonly unsupportedDefinition: SubAgentDefinitionRef;
  /** Resolves only after the cancellation scenario has entered adapter execution. */
  readonly waitUntilStarted?: () => Promise<void>;
}

/**
 * Adapter-specific construction boundary for the reusable Executor contract harness.
 *
 * A package supplies a trusted deterministic runner/worker for each scenario. The harness owns
 * protocol-neutral requests, controls and assertions, so later Worker/Process/HTTP adapters can
 * reuse the same contract without sharing their transport fixtures.
 */
export interface SubAgentExecutorConformanceAdapter {
  readonly variant: string;
  createSubject(
    scenario: ExecutorConformanceScenario,
  ): SubAgentExecutorConformanceSubject | Promise<SubAgentExecutorConformanceSubject>;
}

export interface ExecutorConformanceControlSnapshot {
  readonly bindings: readonly SubAgentExecutorBinding[];
  readonly checkpoints: readonly SubAgentChildCheckpoint[];
  readonly approvalInputs: readonly ApprovalRequestInput[];
  readonly progress: readonly SubAgentProgress[];
  readonly usage: readonly SubAgentUsageDelta[];
  readonly events: readonly ExecutorEventInput[];
}

export interface ExecutorConformanceControlRecorder {
  readonly control: SubAgentExecutionControl;
  snapshot(): ExecutorConformanceControlSnapshot;
}

export interface ExecutorConformanceControlOptions {
  readonly ownerSessionId: string;
  readonly taskId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly approval: 'approved' | 'suspend';
}

export interface ExecutorConformanceRequestOptions {
  readonly executorName: string;
  readonly definition: SubAgentDefinitionRef;
  readonly taskId: string;
  readonly operation?: SubAgentExecutionRequest['operation'];
  readonly signal?: AbortSignal;
  readonly input?: JsonValue;
}

const OWNER_SESSION_ID = 'executor-conformance-owner';
const RUN_ID = 'executor-conformance-run';
const DEADLINE_AT = 4_102_444_800_000;

/**
 * Runs the minimum real adapter contract shared by all full-featured Subagent v2 Executors.
 *
 * It verifies descriptor/supports consistency, execute/spawn binding identity and codec roundtrip,
 * binding-addressed cancellation, an abortable events iterator, and checkpoint approval resume.
 * StateStore event retention/backpressure, transport reconnect and process-crash recovery remain
 * package-specific L2/L3/L6 conformance because they cannot be proven through this SPI alone.
 */
export async function runSubAgentExecutorConformance(
  adapter: SubAgentExecutorConformanceAdapter,
): Promise<void> {
  assert.match(adapter.variant, /^[a-z0-9][a-z0-9._-]*$/u);

  const settle = await adapter.createSubject('settle');
  const { executor, definition, unsupportedDefinition } = settle;
  assertDescriptor(executor);
  const descriptor = executor.descriptor;

  const availability = await executor.getAvailability();
  assert.notEqual(availability.status, 'unavailable');
  assert.equal(await executor.supports(definition), true);
  assert.equal(await executor.supports(unsupportedDefinition), false);
  if (availability.supportedDefinitions !== undefined) {
    assert.equal(containsDefinition(availability.supportedDefinitions, definition), true);
    assert.equal(
      containsDefinition(availability.supportedDefinitions, unsupportedDefinition),
      false,
    );
  }

  const executeRequest = createExecutorConformanceRequest({
    executorName: descriptor.name,
    definition,
    taskId: 'executor-conformance-execute',
  });
  const executeControl = createExecutorConformanceControl({
    ownerSessionId: executeRequest.ownerSessionId,
    taskId: executeRequest.taskId,
    signal: executeRequest.signal,
    deadlineAt: executeRequest.deadlineAt,
    approval: 'approved',
  });
  const executeOutcome = await executor.execute(executeRequest, executeControl.control);
  assertSuccessfulOutcome(executeOutcome, executeRequest, descriptor.name);
  const executeBinding = onlyBinding(executeControl.snapshot());
  assertBinding(executor, executeRequest, executeBinding);

  assert.equal(descriptor.capabilities.spawn, true, 'full conformance requires spawn=true');
  const spawnRequest = createExecutorConformanceRequest({
    executorName: descriptor.name,
    definition,
    taskId: 'executor-conformance-spawn',
  });
  const spawnControl = createExecutorConformanceControl({
    ownerSessionId: spawnRequest.ownerSessionId,
    taskId: spawnRequest.taskId,
    signal: spawnRequest.signal,
    deadlineAt: spawnRequest.deadlineAt,
    approval: 'approved',
  });
  const handle = await executor.spawn(spawnRequest, spawnControl.control);
  const spawnBinding = onlyBinding(spawnControl.snapshot());
  assertBinding(executor, spawnRequest, spawnBinding);
  assert.deepEqual(handle.binding, spawnBinding);
  assert.equal(handle.taskId, spawnRequest.taskId);
  assertSuccessfulOutcome(await handle.wait(), spawnRequest, descriptor.name);
  const snapshot = await handle.snapshot();
  assert.equal(snapshot.taskId, spawnRequest.taskId);
  assert.deepEqual(snapshot.binding, spawnBinding);

  assert.equal(descriptor.capabilities.events, true, 'full conformance requires events=true');
  await assertAbortableEventIterator(handle);

  assert.equal(descriptor.capabilities.cancel, true, 'full conformance requires cancel=true');
  const cancellable = await adapter.createSubject('cancel');
  assert.equal(cancellable.executor.descriptor.name, descriptor.name);
  const cancelRequest = createExecutorConformanceRequest({
    executorName: descriptor.name,
    definition: cancellable.definition,
    taskId: 'executor-conformance-cancel',
  });
  const cancelControl = createExecutorConformanceControl({
    ownerSessionId: cancelRequest.ownerSessionId,
    taskId: cancelRequest.taskId,
    signal: cancelRequest.signal,
    deadlineAt: cancelRequest.deadlineAt,
    approval: 'approved',
  });
  const cancelHandle = await cancellable.executor.spawn(cancelRequest, cancelControl.control);
  await cancellable.waitUntilStarted?.();
  await cancellable.executor.cancel(cancelHandle.binding, {
    operationId: 'executor-conformance-cancel-operation',
    reason: 'conformance cancellation',
    signal: new AbortController().signal,
    deadlineAt: DEADLINE_AT,
  });
  await assertCancelled(cancelHandle);

  assert.equal(descriptor.capabilities.approval, true, 'full conformance requires approval=true');
  assert.equal(
    descriptor.capabilities.recovery.resume,
    'checkpoint',
    'full conformance requires checkpoint resume',
  );
  const approval = await adapter.createSubject('approval-resume');
  assert.equal(approval.executor.descriptor.name, descriptor.name);
  const approvalRequest = createExecutorConformanceRequest({
    executorName: descriptor.name,
    definition: approval.definition,
    taskId: 'executor-conformance-approval',
  });
  const pauseControl = createExecutorConformanceControl({
    ownerSessionId: approvalRequest.ownerSessionId,
    taskId: approvalRequest.taskId,
    signal: approvalRequest.signal,
    deadlineAt: approvalRequest.deadlineAt,
    approval: 'suspend',
  });
  const paused = await approval.executor.execute(approvalRequest, pauseControl.control);
  assert.equal(paused.type, 'paused');
  if (paused.type !== 'paused') throw new Error('Expected approval pause.');
  assert.equal(paused.reason, 'approval');
  assert.equal(paused.task.taskId, approvalRequest.taskId);
  assert.equal(paused.approvals.length, 1);
  const pauseSnapshot = pauseControl.snapshot();
  const approvalBinding = onlyBinding(pauseSnapshot);
  const checkpoint = onlyCheckpoint(pauseSnapshot);
  assertBinding(approval.executor, approvalRequest, approvalBinding);

  const decision = {
    approvalId: paused.approvals[0]!.approvalId,
    decision: 'approved' as const,
    expectedRevision: paused.approvals[0]!.revision,
  };
  const resumeRequest = createExecutorConformanceRequest({
    executorName: descriptor.name,
    definition: approval.definition,
    taskId: approvalRequest.taskId,
    operation: {
      type: 'resume',
      operationId: 'executor-conformance-resume-operation',
      reason: 'approval',
      binding: approvalBinding,
      checkpoint,
      approvals: [decision],
    },
  });
  const resumeControl = createExecutorConformanceControl({
    ownerSessionId: resumeRequest.ownerSessionId,
    taskId: resumeRequest.taskId,
    signal: resumeRequest.signal,
    deadlineAt: resumeRequest.deadlineAt,
    approval: 'approved',
  });
  const resumed = await approval.executor.execute(resumeRequest, resumeControl.control);
  assertSuccessfulOutcome(resumed, resumeRequest, descriptor.name);
}

export function createExecutorConformanceRequest(
  options: ExecutorConformanceRequestOptions,
): SubAgentExecutionRequest {
  const signal = options.signal ?? new AbortController().signal;
  const operation =
    options.operation ??
    ({
      type: 'create',
      operationId: `create:${options.taskId}`,
      idempotencyKey: `idempotency:${options.taskId}`,
    } as const);
  return Object.freeze({
    operation,
    ownerSessionId: OWNER_SESSION_ID,
    runId: RUN_ID,
    taskId: options.taskId,
    subagentSessionId: `session:${options.taskId}`,
    path: Object.freeze([options.taskId]),
    attempt: operation.type === 'create' ? 1 : 2,
    executionEpoch: `epoch:${options.taskId}:${operation.type}`,
    executionFencingToken: operation.type === 'create' ? '1' : '2',
    definition: options.definition,
    input: options.input ?? { scenario: options.taskId },
    projectedContext: Object.freeze([]),
    delegation: Object.freeze({
      version: '1',
      ownerSessionId: OWNER_SESSION_ID,
      runId: RUN_ID,
      parentTaskId: 'executor-conformance-parent',
      path: Object.freeze(['executor-conformance-parent']),
      depth: 1,
      catalogRevision: 1,
      definitions: Object.freeze([
        Object.freeze({
          name: options.definition.name,
          version: options.definition.version,
          executors: Object.freeze([options.executorName]),
        }),
      ]),
    }),
    limits: DEFAULT_SUBAGENT_LIMITS,
    signal,
    deadlineAt: DEADLINE_AT,
  });
}

export function createExecutorConformanceControl(
  options: ExecutorConformanceControlOptions,
): ExecutorConformanceControlRecorder {
  const bindings: SubAgentExecutorBinding[] = [];
  const checkpoints: SubAgentChildCheckpoint[] = [];
  const approvalInputs: ApprovalRequestInput[] = [];
  const progress: SubAgentProgress[] = [];
  const usage: SubAgentUsageDelta[] = [];
  const events: ExecutorEventInput[] = [];
  let receiptRevision = 0;

  const control: SubAgentExecutionControl = {
    signal: options.signal,
    deadlineAt: options.deadlineAt,
    delegation: createUnavailableDelegationClient(),
    completion: {
      submitResult: async (callId, candidate) => ({
        schemaVersion: '1',
        receiptId: `result:${options.taskId}:${callId}`,
        taskId: options.taskId,
        callId,
        revision: ++receiptRevision,
        outputHash: canonicalJsonSha256(candidate),
        submittedAt: 1_000 + receiptRevision,
        status: 'accepted',
      }),
      complete: async (callId) => ({
        schemaVersion: '1',
        receiptId: `completion:${options.taskId}:${callId}`,
        taskId: options.taskId,
        callId,
        revision: ++receiptRevision,
        completedAt: 1_000 + receiptRevision,
        status: 'completed',
      }),
      fail: async (_callId, failure) => ({
        status: failure.status,
        task: {
          taskId: options.taskId,
          subAgent: { name: 'executor-conformance', version: '1' },
        },
        executor: 'executor-conformance',
        error: failure.error,
        ...(failure.partialOutput === undefined ? {} : { partialOutput: failure.partialOutput }),
      }),
    },
    commitBinding: async (_operationId, binding) => {
      bindings.push(structuredClone(binding));
    },
    commitCheckpoint: async (_operationId, checkpoint) => {
      checkpoints.push(structuredClone(checkpoint));
    },
    authorizeTool: async (_operationId, input, checkpoint): Promise<ApprovalDirective> => {
      approvalInputs.push(structuredClone(input));
      const approvalId = `approval:${options.taskId}:${input.callId}`;
      if (options.approval === 'approved') {
        checkpoints.push(structuredClone(checkpoint));
        return { type: 'approved', approvalId };
      }
      checkpoints.push(
        structuredClone(
          createWaitingApprovalCheckpoint(checkpoint, input.callId, input.toolName, approvalId),
        ),
      );
      return {
        type: 'suspend',
        request: {
          ...input,
          approvalId,
          ownerSessionId: options.ownerSessionId,
          taskId: options.taskId,
          createdAt: 1_100,
          revision: 1,
        },
        checkpointRevision: 1,
      };
    },
    pauseDelegation: async () => {
      throw new Error('Delegation pause is outside the Executor conformance scenario.');
    },
    reportProgress: async (_operationId, update) => {
      progress.push(structuredClone(update));
    },
    consumeBudget: async (_operationId, delta) => {
      usage.push(structuredClone(delta));
    },
    emit: async (_operationId, event) => {
      events.push(structuredClone(event));
    },
  };

  return Object.freeze({
    control: Object.freeze(control),
    snapshot: () =>
      Object.freeze({
        bindings: Object.freeze(structuredClone(bindings)),
        checkpoints: Object.freeze(structuredClone(checkpoints)),
        approvalInputs: Object.freeze(structuredClone(approvalInputs)),
        progress: Object.freeze(structuredClone(progress)),
        usage: Object.freeze(structuredClone(usage)),
        events: Object.freeze(structuredClone(events)),
      }),
  });
}

function createWaitingApprovalCheckpoint(
  checkpoint: SubAgentChildCheckpoint,
  callId: string,
  toolName: string,
  approvalId: string,
): SubAgentChildCheckpoint {
  const pendingBatch = checkpoint.pendingBatch;
  assert.ok(pendingBatch, 'approval conformance requires a pending child Tool batch');
  const matches = pendingBatch.calls.filter(
    (call) => call.callId === callId && call.kind === 'tool' && call.name === toolName,
  );
  assert.equal(matches.length, 1, 'approval conformance requires one exact pending Tool call');
  assert.equal(
    matches[0]!.status,
    'in_flight',
    'the first approval request must suspend an in-flight Tool call',
  );
  return Object.freeze({
    ...structuredClone(checkpoint),
    pendingBatch: Object.freeze({
      ...structuredClone(pendingBatch),
      calls: Object.freeze(
        pendingBatch.calls.map((call) =>
          call.callId === callId
            ? Object.freeze({
                ...structuredClone(call),
                status: 'waiting_approval' as const,
                approvals: Object.freeze([approvalId]),
              })
            : Object.freeze(structuredClone(call)),
        ),
      ),
    }),
  });
}

export function createExecutorConformanceChildCheckpoint(options: {
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly codec?: AgentProtocolCheckpointCodec;
  readonly approvalCallId?: string;
  readonly approvalToolName?: string;
}): SubAgentChildCheckpoint {
  const protocol = options.codec?.protocol ?? 'openai-chat';
  const codecVersion = options.codec?.version ?? '1';
  const callId = options.approvalCallId ?? 'conformance-sensitive-call';
  const toolName = options.approvalToolName ?? 'conformance-sensitive-tool';
  const input = Object.freeze({});
  return Object.freeze({
    version: '1',
    runnerId: options.runnerId,
    runnerVersion: options.runnerVersion,
    protocolContext: { protocol, codecVersion, value: [] },
    contextStore: {
      version: '1' as const,
      protocol,
      codecVersion,
      revision: 0,
      rawHistory: [],
      activeSpans: [],
      nextRawItemId: 1,
      nextSpanId: 1,
      nextEntryId: 1,
    },
    modelIteration: 1,
    maxIterations: 4,
    pendingBatch: {
      version: '1' as const,
      batchId: `conformance-approval:${callId}`,
      assistantMessage: { protocol, codecVersion, value: [] },
      calls: Object.freeze([
        {
          version: '1' as const,
          operationId: `conformance-approval-operation:${callId}`,
          kind: 'tool' as const,
          callId,
          name: toolName,
          input,
          inputHash: canonicalJsonSha256(input),
          status: 'in_flight' as const,
          order: 0,
        },
      ]),
      endRequested: false,
      createdAt: 1,
    },
  });
}

function assertDescriptor(executor: SubAgentExecutor): void {
  const { descriptor } = executor;
  assert.equal(descriptor.runtimeProtocolVersion, '1');
  assert.equal(descriptor.capabilities.execute, true);
  assert.equal(descriptor.adapterStateVersion, executor.bindingCodec.adapterStateVersion);
  assert.equal(descriptor.taskRecordVersions.includes('1'), true);
  assert.equal(descriptor.childCheckpointVersions.includes('1'), true);
  assert.equal(descriptor.runnerCompatibility.length > 0, true);
  assert.equal(Number.isSafeInteger(descriptor.maxBindingBytes), true);
  assert.equal(descriptor.maxBindingBytes > 0, true);
  assert.equal(Number.isSafeInteger(descriptor.maxEventPageSize), true);
  assert.equal(descriptor.maxEventPageSize > 0, true);
}

function assertBinding(
  executor: SubAgentExecutor,
  request: SubAgentExecutionRequest,
  binding: SubAgentExecutorBinding,
): void {
  assert.deepEqual(
    {
      executorName: binding.executorName,
      ownerSessionId: binding.ownerSessionId,
      taskId: binding.taskId,
      subagentSessionId: binding.subagentSessionId,
      definitionName: binding.definitionName,
      definitionVersion: binding.definitionVersion,
      adapterStateVersion: binding.adapterStateVersion,
    },
    {
      executorName: executor.descriptor.name,
      ownerSessionId: request.ownerSessionId,
      taskId: request.taskId,
      subagentSessionId: request.subagentSessionId,
      definitionName: request.definition.name,
      definitionVersion: request.definition.version,
      adapterStateVersion: executor.descriptor.adapterStateVersion,
    },
  );
  const compatibleRunner = executor.descriptor.runnerCompatibility.some(
    (runner) =>
      runner.runnerId === binding.runnerId &&
      runner.runnerVersion === binding.runnerVersion &&
      runner.childCheckpointVersions.some((version) =>
        executor.descriptor.childCheckpointVersions.includes(version),
      ),
  );
  assert.equal(compatibleRunner, true);
  const decoded = executor.bindingCodec.decode(binding.recoveryData);
  assert.deepEqual(executor.bindingCodec.encode(decoded), binding.recoveryData);
  assert.equal(
    new TextEncoder().encode(canonicalizeJson(bindingAsJson(binding))).byteLength <=
      executor.descriptor.maxBindingBytes,
    true,
  );
}

function bindingAsJson(binding: SubAgentExecutorBinding): JsonValue {
  return {
    version: binding.version,
    executorName: binding.executorName,
    ownerSessionId: binding.ownerSessionId,
    taskId: binding.taskId,
    subagentSessionId: binding.subagentSessionId,
    definitionName: binding.definitionName,
    definitionVersion: binding.definitionVersion,
    runnerId: binding.runnerId,
    runnerVersion: binding.runnerVersion,
    adapterStateVersion: binding.adapterStateVersion,
    recoveryData: binding.recoveryData,
  };
}

function assertSuccessfulOutcome(
  outcome: SubAgentExecutionOutcome,
  request: SubAgentExecutionRequest,
  executorName: string,
): void {
  assert.equal(outcome.type, 'terminal');
  if (outcome.type !== 'terminal') throw new Error('Expected a terminal outcome.');
  assert.equal(outcome.result.status, 'succeeded');
  assert.equal(outcome.result.task.taskId, request.taskId);
  assert.deepEqual(outcome.result.task.subAgent, request.definition);
  assert.equal(outcome.result.executor, executorName);
}

async function assertAbortableEventIterator(handle: ExecutorTaskHandle): Promise<void> {
  const abort = new AbortController();
  abort.abort(new Error('executor conformance event probe completed'));
  const iterator = handle
    .events({ afterSequence: 0, limit: 1, signal: abort.signal })
    [Symbol.asyncIterator]();
  try {
    const next = await iterator.next();
    if (!next.done) assertEvent(next.value, handle.taskId);
  } catch (error) {
    assert.equal(
      error === abort.signal.reason || errorCode(error) === 'CANCELLED',
      true,
      'an aborted event probe must settle with its abort reason or CANCELLED',
    );
  } finally {
    await iterator.return?.();
  }
}

function assertEvent(event: SubAgentTaskEvent, taskId: string): void {
  assert.equal(event.taskId, taskId);
  assert.equal(Number.isSafeInteger(event.sequence), true);
  assert.equal(event.sequence > 0, true);
}

async function assertCancelled(handle: ExecutorTaskHandle): Promise<void> {
  try {
    const outcome = await handle.wait();
    assert.equal(outcome.type, 'terminal');
    if (outcome.type !== 'terminal') throw new Error('Cancelled execution must be terminal.');
    assert.equal(outcome.result.status, 'cancelled');
  } catch (error) {
    assert.equal(errorCode(error), 'CANCELLED');
  }
}

function onlyBinding(snapshot: ExecutorConformanceControlSnapshot): SubAgentExecutorBinding {
  assert.equal(snapshot.bindings.length, 1);
  return snapshot.bindings[0]!;
}

function onlyCheckpoint(snapshot: ExecutorConformanceControlSnapshot): SubAgentChildCheckpoint {
  assert.equal(snapshot.checkpoints.length, 1);
  return snapshot.checkpoints[0]!;
}

function containsDefinition(
  definitions: readonly SubAgentDefinitionRef[],
  expected: SubAgentDefinitionRef,
): boolean {
  return definitions.some(
    (definition) => definition.name === expected.name && definition.version === expected.version,
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return Reflect.get(error, 'code') as string | undefined;
}

function createUnavailableDelegationClient(): SubAgentDelegationClient {
  const unavailable = (): never => {
    throw new Error('Delegation is outside the Executor conformance scenario.');
  };
  return Object.freeze({
    getCatalog: unavailable,
    getCatalogEntries: unavailable,
    submitTool: unavailable,
    dispatchTool: unavailable,
    execute: unavailable,
    spawn: unavailable,
    resumeTool: unavailable,
  });
}
