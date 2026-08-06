import type { ApprovalDirective, ApprovalRequest, ApprovalRequestInput } from './approval';
import type { ExecutorCatalogSnapshot, SubAgentCatalogEntry } from './catalog';
import type { SubAgentChildCheckpoint } from './checkpoint';
import {
  type SubAgentDelegationPauseInput,
  type SubAgentDelegationPauseReceipt,
  type SubAgentExecutionControl,
  type SubAgentExecutorBinding,
} from './executor';
import {
  RESOURCE_NOT_FOUND_ERROR,
  SUBAGENT_ERROR_CODES,
  SubAgentRuntimeError,
  type SubAgentErrorDescriptor,
} from './errors';
import type { SubAgentTaskSnapshot } from './identity';
import {
  assertJsonValue,
  canonicalizeJson,
  parseJsonValue,
  type JsonValue,
  type JsonValueBoundaryOptions,
} from './json';
import { DEFAULT_SUBAGENT_LIMITS } from './limits';
import type {
  CompletionReceipt,
  ResultReceipt,
  SubAgentExecutionOutcome,
  SubAgentFailureInput,
  SubAgentProgress,
  SubAgentTaskResult,
  SubAgentUsageDelta,
} from './result';
import type {
  ChildDelegationRequest,
  ModelSubAgentRequest,
  SubAgentDelegationClient,
  SubAgentDispatchContext,
  SubAgentEventStreamOptions,
  SubAgentTaskHandle,
} from './runtime';
import type { ExecutorEventInput, SubAgentTaskEvent } from './telemetry';
import { assertSubAgentExecutionRequestWire } from './transport-codec';
import {
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
  SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES,
} from './transport';
import type { SubAgentDelegationSnapshot } from './executor';
import {
  projectSubAgentTransportExecutionOutcome,
  projectSubAgentTransportFailureInput,
  projectSubAgentTransportTaskResult,
  projectSubAgentTransportTaskSnapshot,
  type SubAgentTransportExecutionOutcome,
  type SubAgentTransportFailureInput,
  type SubAgentTransportSafeError,
  type SubAgentTransportTaskResult,
  type SubAgentTransportTaskSnapshot,
} from './transport-wire';

export const SUBAGENT_TRANSPORT_CONTROL_METHODS = Object.freeze([
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
] as const);

export type SubAgentTransportControlMethod = (typeof SUBAGENT_TRANSPORT_CONTROL_METHODS)[number];

export interface SubAgentTransportControlArgsMap {
  readonly 'execution.commitBinding': { readonly binding: SubAgentExecutorBinding };
  readonly 'execution.commitCheckpoint': { readonly checkpoint: SubAgentChildCheckpoint };
  readonly 'execution.authorizeTool': {
    readonly request: ApprovalRequestInput;
    readonly checkpoint: SubAgentChildCheckpoint;
  };
  readonly 'execution.pauseDelegation': { readonly input: SubAgentDelegationPauseInput };
  readonly 'execution.reportProgress': { readonly update: SubAgentProgress };
  readonly 'execution.consumeBudget': { readonly delta: SubAgentUsageDelta };
  readonly 'execution.emit': { readonly event: ExecutorEventInput };
  readonly 'completion.submitResult': { readonly callId: string; readonly candidate: JsonValue };
  readonly 'completion.complete': {
    readonly callId: string;
    readonly proof: { readonly isStandalone: boolean };
  };
  readonly 'completion.fail': {
    readonly callId: string;
    readonly failure: SubAgentTransportFailureInput;
  };
  readonly 'delegation.execute': { readonly request: ChildDelegationRequest };
  readonly 'delegation.spawn': { readonly request: ChildDelegationRequest };
  readonly 'delegation.resumeTool': { readonly childTaskId: string };
  readonly 'task.snapshot': { readonly taskId: string };
  readonly 'task.wait': { readonly taskId: string };
  readonly 'task.cancel': { readonly taskId: string; readonly reason?: string };
}

export interface SubAgentTransportControlResultMap {
  readonly 'execution.commitBinding': null;
  readonly 'execution.commitCheckpoint': null;
  readonly 'execution.authorizeTool': ApprovalDirective;
  readonly 'execution.pauseDelegation': SubAgentDelegationPauseReceipt;
  readonly 'execution.reportProgress': null;
  readonly 'execution.consumeBudget': null;
  readonly 'execution.emit': null;
  readonly 'completion.submitResult': ResultReceipt;
  readonly 'completion.complete': CompletionReceipt;
  readonly 'completion.fail': SubAgentTransportTaskResult;
  readonly 'delegation.execute': SubAgentTransportExecutionOutcome;
  readonly 'delegation.spawn': { readonly taskId: string };
  readonly 'delegation.resumeTool': { readonly taskId: string };
  readonly 'task.snapshot': SubAgentTransportTaskSnapshot;
  readonly 'task.wait': SubAgentTransportExecutionOutcome;
  readonly 'task.cancel': SubAgentTransportTaskSnapshot;
}

export type SubAgentTransportControlRequest<
  M extends SubAgentTransportControlMethod = SubAgentTransportControlMethod,
> = M extends SubAgentTransportControlMethod
  ? {
      readonly taskId: string;
      readonly operationId: string;
      readonly method: M;
      readonly args: SubAgentTransportControlArgsMap[M];
    }
  : never;

export type SubAgentTransportControlReply<
  M extends SubAgentTransportControlMethod = SubAgentTransportControlMethod,
> = M extends SubAgentTransportControlMethod
  ?
      | {
          readonly method: M;
          readonly ok: true;
          readonly result: SubAgentTransportControlResultMap[M];
        }
      | {
          readonly method: M;
          readonly ok: false;
          readonly error: SubAgentTransportSafeError;
        }
  : never;

export type SubAgentTransportControlRequestPayload = {
  [M in SubAgentTransportControlMethod]: Pick<
    SubAgentTransportControlRequest<M>,
    'method' | 'args'
  >;
}[SubAgentTransportControlMethod];

export type SubAgentTransportControlReplyPayload = SubAgentTransportControlReply;

export interface SubAgentTransportControlExchangeContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

export type SubAgentTransportControlExchange = (
  request: SubAgentTransportControlRequest,
  context: SubAgentTransportControlExchangeContext,
) => Promise<SubAgentTransportControlReply>;

export interface SubAgentTransportControlDispatcher {
  readonly taskId: string;
  dispatch(request: SubAgentTransportControlRequest): Promise<SubAgentTransportControlReply>;
}

export interface CreateSubAgentTransportControlDispatcherOptions {
  readonly control: SubAgentExecutionControl;
  readonly taskId: string;
  readonly ownerSessionId: string;
  /** Frozen once when the dispatcher is created and reused for every request and reply. */
  readonly validation?: JsonValueBoundaryOptions;
}

export interface CreateRemoteSubAgentExecutionControlOptions {
  readonly taskId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly delegationSnapshot: SubAgentDelegationSnapshot;
  /** Trusted local registry metadata; it is never obtained through the remote exchange. */
  readonly catalog: ExecutorCatalogSnapshot;
  /** Trusted local definitions and schemas intersected with delegationSnapshot. */
  readonly catalogEntries: readonly SubAgentCatalogEntry[];
  readonly exchange: SubAgentTransportControlExchange;
  readonly createOperationId: (method: SubAgentTransportControlMethod, identity?: string) => string;
  /** Frozen once when the proxy is created and reused for every request and reply. */
  readonly validation?: JsonValueBoundaryOptions;
  /** Existing events transport; artifacts are intentionally absent until remote put is complete. */
  readonly events: (
    taskId: string,
    options?: SubAgentEventStreamOptions,
  ) => AsyncIterable<SubAgentTaskEvent>;
}

const METHOD_SET = new Set<string>(SUBAGENT_TRANSPORT_CONTROL_METHODS);
const ERROR_CODE_SET = new Set<string>(SUBAGENT_ERROR_CODES);
const textEncoder = new TextEncoder();
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/u;
const FAILURE_STATES = new Set(['failed', 'cancelled', 'timed_out', 'budget_exceeded']);
const TASK_STATES = new Set([
  'queued',
  'running',
  'waiting_approval',
  'result_submitted',
  'succeeded',
  ...FAILURE_STATES,
]);
const EXECUTOR_EVENT_TYPES = new Set([
  'progress.reported',
  'recovery.started',
  'recovery.resumed',
  'recovery.reconnected',
  'recovery.failed',
]);
const SAFE_EVENT_DATA_KEYS = new Set([
  'status',
  'errorCode',
  'reasonCode',
  'approvalId',
  'toolName',
  'callId',
  'length',
  'durationMs',
  'checkpointRevision',
  'usage',
  'outcomeUnknown',
]);
const SAFE_ERROR_KEYS = new Set(['code', 'message', 'retryable', 'causeCode', 'outcomeUnknown']);
const VOID_METHODS = new Set<SubAgentTransportControlMethod>([
  'execution.commitBinding',
  'execution.commitCheckpoint',
  'execution.reportProgress',
  'execution.consumeBudget',
  'execution.emit',
]);

type UnknownRecord = Record<string, unknown>;

export function assertSubAgentTransportControlRequest(
  value: unknown,
  options: JsonValueBoundaryOptions = {},
): asserts value is SubAgentTransportControlRequest {
  assertControlRequest(value, resolveControlValidationOptions(options));
}

function assertControlRequest(
  value: unknown,
  options: ResolvedControlValidationOptions,
): asserts value is SubAgentTransportControlRequest {
  assertBoundedTransportJson(value, options);
  const record = closedRecord(value, 'Control request', [
    'taskId',
    'operationId',
    'method',
    'args',
  ]);
  assertIdentifier(record.taskId, 'Control request taskId');
  assertIdentifier(record.operationId, 'Control request operationId');
  const method = assertMethod(record.method);
  assertControlArgs(method, record.args);
}

export function assertSubAgentTransportControlReply(
  value: unknown,
  options: JsonValueBoundaryOptions = {},
): asserts value is SubAgentTransportControlReply {
  assertControlReply(value, resolveControlValidationOptions(options));
}

function assertControlReply(
  value: unknown,
  options: ResolvedControlValidationOptions,
): asserts value is SubAgentTransportControlReply {
  assertBoundedTransportJson(value, options);
  const record = recordValue(value, 'Control reply');
  const method = assertMethod(record.method);
  if (record.ok === true) {
    assertExactKeys(record, 'Control reply', ['method', 'ok', 'result']);
    assertControlResult(method, record.result);
  } else if (record.ok === false) {
    assertExactKeys(record, 'Control reply', ['method', 'ok', 'error']);
    assertSafeError(record.error, 'Control reply error');
  } else {
    fail('Control reply ok must be a boolean literal.');
  }
}

export function decodeSubAgentTransportControlRequest(
  value: unknown,
  options: JsonValueBoundaryOptions = {},
): SubAgentTransportControlRequest {
  const resolved = resolveControlValidationOptions(options);
  assertControlRequest(value, resolved);
  return freezeJsonClone(value, resolved) as unknown as SubAgentTransportControlRequest;
}

export function decodeSubAgentTransportControlReply(
  value: unknown,
  options: JsonValueBoundaryOptions = {},
): SubAgentTransportControlReply {
  const resolved = resolveControlValidationOptions(options);
  assertControlReply(value, resolved);
  return freezeJsonClone(value, resolved) as unknown as SubAgentTransportControlReply;
}

export function createSubAgentTransportControlDispatcher(
  options: CreateSubAgentTransportControlDispatcherOptions,
): SubAgentTransportControlDispatcher {
  assertIdentifier(options.taskId, 'Control dispatcher taskId');
  assertIdentifier(options.ownerSessionId, 'Control dispatcher ownerSessionId');
  if (options.control === null || typeof options.control !== 'object') {
    throw new TypeError('Control dispatcher requires a trusted SubAgentExecutionControl.');
  }
  const validation = resolveControlValidationOptions(options.validation);
  const handles = new Map<string, SubAgentTaskHandle>();

  return Object.freeze({
    taskId: options.taskId,
    async dispatch(rawRequest: SubAgentTransportControlRequest) {
      const request = decodeSubAgentTransportControlRequest(rawRequest, validation);
      if (request.taskId !== options.taskId) {
        return errorReply(request.method, resourceNotFoundError(), validation);
      }
      try {
        assertControlRequestScope(request, options.taskId, options.ownerSessionId);
        const result = projectControlResult(
          request.method,
          await dispatchControlRequest(options.control, handles, request),
        );
        assertControlResultScope(
          request.method,
          request.args,
          result,
          options.taskId,
          options.ownerSessionId,
        );
        const reply = { method: request.method, ok: true as const, result };
        assertControlReply(reply, validation);
        return decodeSubAgentTransportControlReply(reply, validation);
      } catch (error) {
        return errorReply(request.method, safeControlError(error), validation);
      }
    },
  });
}

export function createRemoteSubAgentExecutionControl(
  options: CreateRemoteSubAgentExecutionControlOptions,
): SubAgentExecutionControl {
  assertIdentifier(options.taskId, 'Remote control taskId');
  if (!(options.signal instanceof AbortSignal)) {
    throw new TypeError('Remote control signal must be an AbortSignal.');
  }
  if (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt < 0) {
    throw new TypeError('Remote control deadlineAt must be a non-negative safe integer.');
  }
  if (options.delegationSnapshot.parentTaskId !== options.taskId) {
    throw new TypeError('Remote control delegation snapshot belongs to another task.');
  }
  if (
    typeof options.exchange !== 'function' ||
    typeof options.createOperationId !== 'function' ||
    typeof options.events !== 'function'
  ) {
    throw new TypeError('Remote control requires exchange, operation ID and events adapters.');
  }
  const validation = resolveControlValidationOptions(options.validation);

  const effective = createEffectiveDelegationCatalog(
    options.delegationSnapshot,
    options.catalog,
    options.catalogEntries,
  );
  const exchangeContext: SubAgentTransportControlExchangeContext = Object.freeze({
    signal: options.signal,
    deadlineAt: options.deadlineAt,
  });

  const exchange = async <M extends SubAgentTransportControlMethod>(
    method: M,
    args: SubAgentTransportControlArgsMap[M],
    operationId: string,
  ): Promise<SubAgentTransportControlResultMap[M]> => {
    const request = decodeSubAgentTransportControlRequest(
      {
        taskId: options.taskId,
        operationId,
        method,
        args,
      },
      validation,
    ) as SubAgentTransportControlRequest<M>;
    const reply = decodeSubAgentTransportControlReply(
      await options.exchange(request, exchangeContext),
      validation,
    );
    if (reply.method !== method) {
      throw new SubAgentRuntimeError({
        code: 'INTERNAL_ERROR',
        message: 'The remote control reply did not match its request.',
        retryable: false,
      });
    }
    if (!reply.ok) throw new SubAgentRuntimeError(reply.error);
    assertControlResultScope(
      method,
      request.args,
      reply.result,
      options.taskId,
      options.delegationSnapshot.ownerSessionId,
    );
    return reply.result as SubAgentTransportControlResultMap[M];
  };

  const nextOperation = (method: SubAgentTransportControlMethod, identity?: string): string => {
    const operationId = options.createOperationId(method, identity);
    assertIdentifier(operationId, `${method} operationId`);
    return operationId;
  };

  const createHandle = (taskId: string): SubAgentTaskHandle => {
    assertIdentifier(taskId, 'Remote delegated taskId');
    return Object.freeze({
      taskId,
      snapshot: () => exchange('task.snapshot', { taskId }, nextOperation('task.snapshot', taskId)),
      wait: () => exchange('task.wait', { taskId }, nextOperation('task.wait', taskId)),
      cancel: (reason?: string) =>
        exchange(
          'task.cancel',
          { taskId, ...(reason === undefined ? {} : { reason }) },
          nextOperation('task.cancel', taskId),
        ),
      events: (eventOptions?: SubAgentEventStreamOptions) => options.events(taskId, eventOptions),
    });
  };

  const assertDelegationAllowed = (request: ChildDelegationRequest): void => {
    assertChildDelegationRequest(request, 'Delegation request');
    const entry = effective.entries.find(({ definition }) => definition.name === request.subAgent);
    if (entry === undefined || !entry.executors.some(({ name }) => name === request.executor)) {
      throw new SubAgentRuntimeError({
        code: 'CHILD_DEFINITION_DISALLOWED',
        message: 'The requested child placement is not allowed.',
        retryable: false,
      });
    }
  };

  const delegation: SubAgentDelegationClient = Object.freeze({
    getCatalog: () => effective.catalog,
    getCatalogEntries: () => effective.entries,
    submitTool: async (request: ModelSubAgentRequest, context: SubAgentDispatchContext) => {
      assertDispatchContextScope(context, options.delegationSnapshot);
      const childRequest = { ...request, requestId: context.requestId };
      assertDelegationAllowed(childRequest);
      const result = await exchange(
        'delegation.spawn',
        { request: childRequest },
        nextOperation('delegation.spawn', childRequest.requestId),
      );
      return createHandle(result.taskId);
    },
    dispatchTool: async (request: ModelSubAgentRequest, context: SubAgentDispatchContext) => {
      assertDispatchContextScope(context, options.delegationSnapshot);
      const childRequest = { ...request, requestId: context.requestId };
      assertDelegationAllowed(childRequest);
      return exchange(
        'delegation.execute',
        { request: childRequest },
        nextOperation('delegation.execute', childRequest.requestId),
      );
    },
    execute: async (request: ChildDelegationRequest) => {
      assertDelegationAllowed(request);
      return exchange(
        'delegation.execute',
        { request },
        nextOperation('delegation.execute', request.requestId),
      );
    },
    spawn: async (request: ChildDelegationRequest) => {
      assertDelegationAllowed(request);
      const result = await exchange(
        'delegation.spawn',
        { request },
        nextOperation('delegation.spawn', request.requestId),
      );
      return createHandle(result.taskId);
    },
    resumeTool: async (childTaskId: string) => {
      const result = await exchange(
        'delegation.resumeTool',
        { childTaskId },
        nextOperation('delegation.resumeTool', childTaskId),
      );
      return createHandle(result.taskId);
    },
  });

  return Object.freeze({
    signal: options.signal,
    deadlineAt: options.deadlineAt,
    delegation,
    completion: Object.freeze({
      submitResult: (callId: string, candidate: JsonValue) =>
        exchange(
          'completion.submitResult',
          { callId, candidate },
          nextOperation('completion.submitResult', callId),
        ),
      complete: (callId: string, proof: { readonly isStandalone: boolean }) =>
        exchange(
          'completion.complete',
          { callId, proof },
          nextOperation('completion.complete', callId),
        ),
      fail: (callId: string, failure: SubAgentFailureInput) =>
        exchange(
          'completion.fail',
          { callId, failure: projectSubAgentTransportFailureInput(failure) },
          nextOperation('completion.fail', callId),
        ),
    }),
    commitBinding: (operationId: string, binding: SubAgentExecutorBinding) => {
      if (
        binding.taskId !== options.taskId ||
        binding.ownerSessionId !== options.delegationSnapshot.ownerSessionId
      ) {
        return Promise.reject(new SubAgentRuntimeError(RESOURCE_NOT_FOUND_ERROR));
      }
      return exchange('execution.commitBinding', { binding }, operationId).then(() => undefined);
    },
    commitCheckpoint: (operationId: string, checkpoint: SubAgentChildCheckpoint) =>
      exchange('execution.commitCheckpoint', { checkpoint }, operationId).then(() => undefined),
    authorizeTool: (
      operationId: string,
      request: ApprovalRequestInput,
      checkpoint: SubAgentChildCheckpoint,
    ) => exchange('execution.authorizeTool', { request, checkpoint }, operationId),
    pauseDelegation: (operationId: string, input: SubAgentDelegationPauseInput) =>
      exchange('execution.pauseDelegation', { input }, operationId),
    reportProgress: (operationId: string, update: SubAgentProgress) =>
      exchange('execution.reportProgress', { update }, operationId).then(() => undefined),
    consumeBudget: (operationId: string, delta: SubAgentUsageDelta) =>
      exchange('execution.consumeBudget', { delta }, operationId).then(() => undefined),
    emit: (operationId: string, event: ExecutorEventInput) =>
      exchange('execution.emit', { event }, operationId).then(() => undefined),
  });
}

async function dispatchControlRequest(
  control: SubAgentExecutionControl,
  handles: Map<string, SubAgentTaskHandle>,
  request: SubAgentTransportControlRequest,
): Promise<unknown> {
  switch (request.method) {
    case 'execution.commitBinding':
      await control.commitBinding(request.operationId, request.args.binding);
      return null;
    case 'execution.commitCheckpoint':
      await control.commitCheckpoint(request.operationId, request.args.checkpoint);
      return null;
    case 'execution.authorizeTool':
      return control.authorizeTool(
        request.operationId,
        request.args.request,
        request.args.checkpoint,
      );
    case 'execution.pauseDelegation':
      return control.pauseDelegation(request.operationId, request.args.input);
    case 'execution.reportProgress':
      await control.reportProgress(request.operationId, request.args.update);
      return null;
    case 'execution.consumeBudget':
      await control.consumeBudget(request.operationId, request.args.delta);
      return null;
    case 'execution.emit':
      await control.emit(request.operationId, request.args.event);
      return null;
    case 'completion.submitResult':
      return control.completion.submitResult(request.args.callId, request.args.candidate);
    case 'completion.complete':
      return control.completion.complete(request.args.callId, request.args.proof);
    case 'completion.fail':
      return control.completion.fail(request.args.callId, request.args.failure);
    case 'delegation.execute':
      return control.delegation.execute(request.args.request);
    case 'delegation.spawn': {
      const handle = await control.delegation.spawn(request.args.request);
      handles.set(handle.taskId, handle);
      return { taskId: handle.taskId };
    }
    case 'delegation.resumeTool': {
      const handle = await control.delegation.resumeTool(request.args.childTaskId);
      handles.set(handle.taskId, handle);
      return { taskId: handle.taskId };
    }
    case 'task.snapshot':
      return requireHandle(handles, request.args.taskId).snapshot();
    case 'task.wait':
      return requireHandle(handles, request.args.taskId).wait();
    case 'task.cancel':
      return requireHandle(handles, request.args.taskId).cancel(request.args.reason);
  }
}

/** Project Core-owned values into the strictly smaller transport-safe result surface. */
function projectControlResult(method: SubAgentTransportControlMethod, result: unknown): unknown {
  switch (method) {
    case 'completion.fail':
      return projectSubAgentTransportTaskResult(result as SubAgentTaskResult);
    case 'delegation.execute':
    case 'task.wait':
      return projectSubAgentTransportExecutionOutcome(result as SubAgentExecutionOutcome);
    case 'task.snapshot':
    case 'task.cancel':
      return projectSubAgentTransportTaskSnapshot(result as SubAgentTaskSnapshot);
    default:
      return result;
  }
}

function assertControlRequestScope(
  request: SubAgentTransportControlRequest,
  taskId: string,
  ownerSessionId: string,
): void {
  if (request.method !== 'execution.commitBinding') return;
  if (
    request.args.binding.taskId !== taskId ||
    request.args.binding.ownerSessionId !== ownerSessionId
  ) {
    throw new SubAgentRuntimeError(RESOURCE_NOT_FOUND_ERROR);
  }
}

function assertControlResultScope(
  method: SubAgentTransportControlMethod,
  args: SubAgentTransportControlArgsMap[SubAgentTransportControlMethod],
  result: unknown,
  parentTaskId: string,
  ownerSessionId: string,
): void {
  assertControlResult(method, result);
  switch (method) {
    case 'execution.authorizeTool': {
      const directive = result as ApprovalDirective;
      const request = args as SubAgentTransportControlArgsMap['execution.authorizeTool'];
      if (
        directive.type === 'suspend' &&
        (directive.request.taskId !== parentTaskId ||
          directive.request.ownerSessionId !== ownerSessionId ||
          directive.request.callId !== request.request.callId ||
          directive.request.toolName !== request.request.toolName ||
          directive.request.summary !== request.request.summary ||
          directive.request.expiresAt !== request.request.expiresAt)
      ) {
        fail('Approval directive does not match its request scope.');
      }
      return;
    }
    case 'execution.pauseDelegation': {
      const receipt = result as SubAgentDelegationPauseReceipt;
      const request = args as SubAgentTransportControlArgsMap['execution.pauseDelegation'];
      const expected = request.input.calls.flatMap((call) =>
        call.approvals.map((approval) => {
          if (approval.taskId !== call.childTaskId) {
            fail('Delegation pause input approval belongs to another child task.');
          }
          return approval;
        }),
      );
      if (
        expected.length !== receipt.approvals.length ||
        hasDuplicateApproval(expected) ||
        hasDuplicateApproval(receipt.approvals) ||
        expected.some(
          (approval, index) =>
            approval.ownerSessionId !== ownerSessionId ||
            receipt.approvals[index]?.ownerSessionId !== ownerSessionId ||
            !approvalRequestsEqual(approval, receipt.approvals[index]),
        )
      ) {
        fail('Delegation pause receipt does not exactly match its nested approvals.');
      }
      return;
    }
    case 'completion.submitResult': {
      const receipt = result as ResultReceipt;
      const request = args as SubAgentTransportControlArgsMap['completion.submitResult'];
      if (receipt.taskId !== parentTaskId || receipt.callId !== request.callId) {
        fail('Result receipt does not match its task and call.');
      }
      return;
    }
    case 'completion.complete': {
      const receipt = result as CompletionReceipt;
      const request = args as SubAgentTransportControlArgsMap['completion.complete'];
      if (receipt.taskId !== parentTaskId || receipt.callId !== request.callId) {
        fail('Completion receipt does not match its task and call.');
      }
      return;
    }
    case 'completion.fail': {
      const taskResult = result as SubAgentTransportTaskResult;
      const request = args as SubAgentTransportControlArgsMap['completion.fail'];
      if (
        taskResult.status === 'succeeded' ||
        taskResult.task.taskId !== parentTaskId ||
        taskResult.status !== request.failure.status ||
        taskResult.error.code !== request.failure.error.code ||
        taskResult.error.retryable !== request.failure.error.retryable ||
        taskResult.error.outcomeUnknown !== request.failure.error.outcomeUnknown ||
        (taskResult.partialOutput === undefined) !== (request.failure.partialOutput === undefined)
      ) {
        fail('Failure result does not match its authoritative failure request.');
      }
      return;
    }
    case 'delegation.execute': {
      const outcome = result as SubAgentTransportExecutionOutcome;
      const request = args as SubAgentTransportControlArgsMap['delegation.execute'];
      const task = outcome.type === 'paused' ? outcome.task : outcome.result.task;
      if (
        task.subAgent.name !== request.request.subAgent ||
        (outcome.type === 'terminal' && outcome.result.executor !== request.request.executor)
      ) {
        fail('Delegation outcome does not match its requested definition and executor.');
      }
      return;
    }
    case 'delegation.resumeTool': {
      const handle = result as { readonly taskId: string };
      const request = args as SubAgentTransportControlArgsMap['delegation.resumeTool'];
      if (handle.taskId !== request.childTaskId) fail('Resumed task identity changed.');
      return;
    }
    case 'task.snapshot':
    case 'task.cancel': {
      const snapshot = result as SubAgentTaskSnapshot;
      const request = args as
        | SubAgentTransportControlArgsMap['task.snapshot']
        | SubAgentTransportControlArgsMap['task.cancel'];
      if (snapshot.taskId !== request.taskId) fail('Task snapshot identity changed.');
      return;
    }
    case 'task.wait': {
      const request = args as SubAgentTransportControlArgsMap['task.wait'];
      if (executionOutcomeTaskId(result as SubAgentExecutionOutcome) !== request.taskId) {
        fail('Task wait outcome identity changed.');
      }
    }
  }
}

function hasDuplicateApproval(approvals: readonly ApprovalRequest[]): boolean {
  const identities = new Set<string>();
  for (const approval of approvals) {
    const identity = `${approval.taskId}\u0000${approval.callId}\u0000${approval.approvalId}`;
    if (identities.has(identity)) return true;
    identities.add(identity);
  }
  return false;
}

function approvalRequestsEqual(
  expected: ApprovalRequest,
  actual: ApprovalRequest | undefined,
): boolean {
  return (
    actual !== undefined &&
    actual.callId === expected.callId &&
    actual.toolName === expected.toolName &&
    actual.summary === expected.summary &&
    actual.approvalId === expected.approvalId &&
    actual.ownerSessionId === expected.ownerSessionId &&
    actual.taskId === expected.taskId &&
    actual.createdAt === expected.createdAt &&
    actual.revision === expected.revision &&
    actual.expiresAt === expected.expiresAt
  );
}

function executionOutcomeTaskId(outcome: SubAgentExecutionOutcome): string {
  return outcome.type === 'paused' ? outcome.task.taskId : outcome.result.task.taskId;
}

function requireHandle(
  handles: ReadonlyMap<string, SubAgentTaskHandle>,
  taskId: string,
): SubAgentTaskHandle {
  return (
    handles.get(taskId) ??
    (() => {
      throw new SubAgentRuntimeError(RESOURCE_NOT_FOUND_ERROR);
    })()
  );
}

function errorReply(
  method: SubAgentTransportControlMethod,
  error: SubAgentTransportSafeError,
  validation: ResolvedControlValidationOptions,
): SubAgentTransportControlReply {
  const reply = { method, ok: false as const, error };
  assertControlReply(reply, validation);
  return decodeSubAgentTransportControlReply(reply, validation);
}

function safeControlError(error: unknown): SubAgentTransportSafeError {
  if (error instanceof SubAgentRuntimeError) {
    return copySafeError(error.descriptor);
  }
  return Object.freeze({
    code: 'INTERNAL_ERROR',
    message: 'The control request failed.',
    retryable: false,
  });
}

function resourceNotFoundError(): SubAgentTransportSafeError {
  return copySafeError(RESOURCE_NOT_FOUND_ERROR);
}

function copySafeError(error: SubAgentErrorDescriptor): SubAgentTransportSafeError {
  return Object.freeze({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.causeCode === undefined ? {} : { causeCode: error.causeCode }),
    ...(error.outcomeUnknown === undefined ? {} : { outcomeUnknown: error.outcomeUnknown }),
  });
}

function createEffectiveDelegationCatalog(
  snapshot: SubAgentDelegationSnapshot,
  localCatalog: ExecutorCatalogSnapshot,
  localEntries: readonly SubAgentCatalogEntry[],
): {
  readonly catalog: ExecutorCatalogSnapshot;
  readonly entries: readonly SubAgentCatalogEntry[];
} {
  if (snapshot.version !== '1' || !Number.isSafeInteger(snapshot.catalogRevision)) {
    throw new TypeError('Delegation snapshot is invalid.');
  }
  const grants = new Map(
    snapshot.definitions.map((definition) => [
      `${definition.name}\u0000${definition.version}`,
      new Set(definition.executors),
    ]),
  );
  const trustedCatalog = freezeJsonClone(localCatalog) as unknown as ExecutorCatalogSnapshot;
  const locallyAvailable = new Set(
    trustedCatalog.executors
      .filter(({ status }) => status === 'available' || status === 'degraded')
      .map(({ descriptor }) => descriptor.name),
  );
  const entries = localEntries.flatMap((entry) => {
    const allowed = grants.get(`${entry.definition.name}\u0000${entry.definition.version}`);
    if (allowed === undefined) return [];
    const executors = entry.executors
      .filter(({ name }) => allowed.has(name) && locallyAvailable.has(name))
      .map(
        (executor) =>
          freezeJsonClone(executor) as unknown as SubAgentCatalogEntry['executors'][number],
      );
    if (executors.length === 0) return [];
    return [
      Object.freeze({
        definition: Object.freeze({ ...entry.definition }),
        description: entry.description,
        inputSchema: entry.inputSchema,
        executors: Object.freeze(executors),
      }),
    ];
  });
  const visibleExecutors = new Set(
    entries.flatMap(({ executors }) => executors.map(({ name }) => name)),
  );
  const catalog = Object.freeze({
    revision: snapshot.catalogRevision,
    capturedAt: trustedCatalog.capturedAt,
    executors: Object.freeze(
      trustedCatalog.executors.filter(({ descriptor }) => visibleExecutors.has(descriptor.name)),
    ),
  });
  return Object.freeze({ catalog, entries: Object.freeze(entries) });
}

function assertControlArgs(method: SubAgentTransportControlMethod, value: unknown): void {
  const record = recordValue(value, `${method} args`);
  if (Object.hasOwn(record, 'operationId')) fail(`${method} args must not repeat operationId.`);
  switch (method) {
    case 'execution.commitBinding':
      assertExactKeys(record, `${method} args`, ['binding']);
      assertBinding(record.binding);
      return;
    case 'execution.commitCheckpoint':
      assertExactKeys(record, `${method} args`, ['checkpoint']);
      assertCheckpoint(record.checkpoint);
      return;
    case 'execution.authorizeTool':
      assertExactKeys(record, `${method} args`, ['request', 'checkpoint']);
      assertApprovalRequestInput(record.request);
      assertCheckpoint(record.checkpoint);
      return;
    case 'execution.pauseDelegation':
      assertExactKeys(record, `${method} args`, ['input']);
      assertPauseInput(record.input);
      return;
    case 'execution.reportProgress':
      assertExactKeys(record, `${method} args`, ['update']);
      assertProgress(record.update);
      return;
    case 'execution.consumeBudget':
      assertExactKeys(record, `${method} args`, ['delta']);
      assertUsage(record.delta, true);
      return;
    case 'execution.emit':
      assertExactKeys(record, `${method} args`, ['event']);
      assertExecutorEvent(record.event);
      return;
    case 'completion.submitResult':
      assertExactKeys(record, `${method} args`, ['callId', 'candidate']);
      assertIdentifier(record.callId, `${method} callId`);
      assertJsonValue(record.candidate);
      return;
    case 'completion.complete': {
      assertExactKeys(record, `${method} args`, ['callId', 'proof']);
      assertIdentifier(record.callId, `${method} callId`);
      const proof = closedRecord(record.proof, `${method} proof`, ['isStandalone']);
      if (typeof proof.isStandalone !== 'boolean') fail(`${method} proof is invalid.`);
      return;
    }
    case 'completion.fail':
      assertExactKeys(record, `${method} args`, ['callId', 'failure']);
      assertIdentifier(record.callId, `${method} callId`);
      assertFailure(record.failure);
      return;
    case 'delegation.execute':
    case 'delegation.spawn':
      assertExactKeys(record, `${method} args`, ['request']);
      assertChildDelegationRequest(record.request, `${method} request`);
      return;
    case 'delegation.resumeTool':
      assertExactKeys(record, `${method} args`, ['childTaskId']);
      assertIdentifier(record.childTaskId, `${method} childTaskId`);
      return;
    case 'task.snapshot':
    case 'task.wait':
      assertExactKeys(record, `${method} args`, ['taskId']);
      assertIdentifier(record.taskId, `${method} taskId`);
      return;
    case 'task.cancel':
      assertKeys(record, `${method} args`, ['taskId'], ['reason']);
      assertIdentifier(record.taskId, `${method} taskId`);
      if (record.reason !== undefined) assertMessage(record.reason, `${method} reason`);
  }
}

function assertControlResult(method: SubAgentTransportControlMethod, value: unknown): void {
  if (VOID_METHODS.has(method)) {
    if (value !== null) fail(`${method} result must be null.`);
    return;
  }
  switch (method) {
    case 'execution.authorizeTool':
      assertApprovalDirective(value);
      return;
    case 'execution.pauseDelegation':
      assertPauseReceipt(value);
      return;
    case 'completion.submitResult':
      assertResultReceipt(value);
      return;
    case 'completion.complete':
      assertCompletionReceipt(value);
      return;
    case 'completion.fail':
      assertTaskResult(value);
      return;
    case 'delegation.execute':
    case 'task.wait':
      assertExecutionOutcome(value);
      return;
    case 'delegation.spawn':
    case 'delegation.resumeTool': {
      const result = closedRecord(value, `${method} result`, ['taskId']);
      assertIdentifier(result.taskId, `${method} taskId`);
      return;
    }
    case 'task.snapshot':
    case 'task.cancel':
      assertTaskSnapshot(value);
      return;
  }
}

function assertMethod(value: unknown): SubAgentTransportControlMethod {
  if (typeof value !== 'string' || !METHOD_SET.has(value)) fail('Unknown control method.');
  return value as SubAgentTransportControlMethod;
}

function assertBinding(value: unknown): void {
  const binding = closedRecord(value, 'Executor binding', [
    'version',
    'executorName',
    'ownerSessionId',
    'taskId',
    'subagentSessionId',
    'definitionName',
    'definitionVersion',
    'runnerId',
    'runnerVersion',
    'adapterStateVersion',
    'recoveryData',
  ]);
  if (binding.version !== '1') fail('Executor binding version is invalid.');
  for (const key of [
    'executorName',
    'ownerSessionId',
    'taskId',
    'subagentSessionId',
    'definitionName',
    'definitionVersion',
    'runnerId',
    'runnerVersion',
    'adapterStateVersion',
  ] as const)
    assertIdentifier(binding[key], `Executor binding ${key}`);
  assertJsonValue(binding.recoveryData);
  assertSyntheticExecutionOperation({ type: 'reconnect', operationId: 'validation', binding });
}

function assertCheckpoint(value: unknown): void {
  const checkpoint = recordValue(value, 'Child checkpoint');
  const runnerId = checkpoint.runnerId;
  const runnerVersion = checkpoint.runnerVersion;
  assertIdentifier(runnerId, 'Child checkpoint runnerId');
  assertIdentifier(runnerVersion, 'Child checkpoint runnerVersion');
  const binding = {
    version: '1',
    executorName: 'validation',
    ownerSessionId: 'owner',
    taskId: 'task',
    subagentSessionId: 'child',
    definitionName: 'definition',
    definitionVersion: '1',
    runnerId,
    runnerVersion,
    adapterStateVersion: '1',
    recoveryData: null,
  };
  assertSyntheticExecutionOperation({
    type: 'resume',
    operationId: 'validation',
    reason: 'checkpoint',
    binding,
    checkpoint,
  });
}

function assertSyntheticExecutionOperation(operation: UnknownRecord): void {
  const binding = recordValue(operation.binding, 'Synthetic validation binding');
  const ownerSessionId = binding.ownerSessionId;
  const taskId = binding.taskId;
  const subagentSessionId = binding.subagentSessionId;
  const definitionName = binding.definitionName;
  const definitionVersion = binding.definitionVersion;
  assertIdentifier(ownerSessionId, 'Synthetic validation ownerSessionId');
  assertIdentifier(taskId, 'Synthetic validation taskId');
  assertIdentifier(subagentSessionId, 'Synthetic validation subagentSessionId');
  assertIdentifier(definitionName, 'Synthetic validation definitionName');
  assertIdentifier(definitionVersion, 'Synthetic validation definitionVersion');
  assertSubAgentExecutionRequestWire({
    operation,
    ownerSessionId,
    runId: 'run',
    taskId,
    subagentSessionId,
    path: [taskId],
    attempt: 1,
    executionEpoch: 'epoch',
    executionFencingToken: 'fencing',
    definition: { name: definitionName, version: definitionVersion },
    input: null,
    projectedContext: [],
    delegation: {
      version: '1',
      ownerSessionId,
      runId: 'run',
      parentTaskId: taskId,
      path: [taskId],
      depth: 1,
      catalogRevision: 1,
      definitions: [],
    },
    limits: DEFAULT_SUBAGENT_LIMITS,
    remainingMs: 1,
  });
}

function assertApprovalRequestInput(value: unknown): void {
  const request = closedRecord(
    value,
    'Approval request input',
    ['callId', 'toolName', 'summary'],
    ['expiresAt'],
  );
  assertIdentifier(request.callId, 'Approval callId');
  assertIdentifier(request.toolName, 'Approval toolName');
  assertMessage(request.summary, 'Approval summary');
  if (request.expiresAt !== undefined) assertNonNegativeInteger(request.expiresAt, 'expiresAt');
}

function assertPauseInput(value: unknown): void {
  const input = closedRecord(value, 'Delegation pause input', ['checkpoint', 'calls']);
  assertCheckpoint(input.checkpoint);
  if (!Array.isArray(input.calls) || input.calls.length < 1)
    fail('Delegation pause calls are invalid.');
  for (const item of input.calls) {
    const call = closedRecord(item, 'Delegation pause call', [
      'callId',
      'childTaskId',
      'approvals',
    ]);
    assertIdentifier(call.callId, 'Delegation pause callId');
    assertIdentifier(call.childTaskId, 'Delegation pause childTaskId');
    if (!Array.isArray(call.approvals) || call.approvals.length < 1)
      fail('Delegation pause approvals are invalid.');
    for (const approval of call.approvals) assertApprovalRequest(approval);
  }
}

function assertProgress(value: unknown): void {
  const progress = closedRecord(value, 'Progress', ['message'], ['percent', 'data']);
  assertMessage(progress.message, 'Progress message');
  if (
    progress.percent !== undefined &&
    (typeof progress.percent !== 'number' ||
      !Number.isFinite(progress.percent) ||
      progress.percent < 0 ||
      progress.percent > 100)
  ) {
    fail('Progress percent is invalid.');
  }
  if (progress.data !== undefined) assertJsonValue(progress.data);
}

function assertUsage(value: unknown, allowEmpty = false): void {
  const usage = recordValue(value, 'Usage');
  const allowed = ['turns', 'providerCalls', 'inputTokens', 'outputTokens', 'cost'];
  assertKeys(usage, 'Usage', allowEmpty ? [] : ['turns', 'providerCalls'], allowed);
  if (!allowEmpty && (!Object.hasOwn(usage, 'turns') || !Object.hasOwn(usage, 'providerCalls')))
    fail('Usage is incomplete.');
  if (allowEmpty && Object.keys(usage).length === 0) fail('Usage delta must not be empty.');
  for (const key of ['turns', 'providerCalls', 'inputTokens', 'outputTokens'] as const) {
    if (usage[key] !== undefined) assertNonNegativeInteger(usage[key], `Usage ${key}`);
  }
  if (
    usage.cost !== undefined &&
    (typeof usage.cost !== 'number' || !Number.isFinite(usage.cost) || usage.cost < 0)
  )
    fail('Usage cost is invalid.');
}

function assertExecutorEvent(value: unknown): void {
  const event = closedRecord(value, 'Executor event', ['type', 'data'], ['timestamp']);
  if (typeof event.type !== 'string' || !EXECUTOR_EVENT_TYPES.has(event.type)) {
    fail('Executor event type is not allowed.');
  }
  if (event.timestamp !== undefined)
    assertNonNegativeInteger(event.timestamp, 'Executor event timestamp');
  assertSafeEventData(event.data);
}

function assertSafeEventData(value: unknown): void {
  const data = recordValue(value, 'Executor event data');
  for (const key of Object.keys(data)) {
    if (!SAFE_EVENT_DATA_KEYS.has(key)) {
      fail(`Executor event data contains unsupported field ${key}.`);
    }
  }
  for (const key of ['status', 'reasonCode', 'approvalId', 'toolName', 'callId'] as const) {
    if (data[key] !== undefined) assertMessage(data[key], `Executor event data ${key}`);
  }
  if (data.errorCode !== undefined) {
    assertToken(data.errorCode, 'Executor event data errorCode');
    if (!ERROR_CODE_SET.has(data.errorCode as string)) {
      fail('Executor event errorCode is not stable.');
    }
  }
  for (const key of ['length', 'durationMs', 'checkpointRevision'] as const) {
    if (data[key] !== undefined) {
      assertNonNegativeInteger(data[key], `Executor event data ${key}`);
    }
  }
  if (data.usage !== undefined) assertUsage(data.usage);
  if (data.outcomeUnknown !== undefined && typeof data.outcomeUnknown !== 'boolean') {
    fail('Executor event outcomeUnknown is invalid.');
  }
}

function assertDispatchContextScope(
  context: SubAgentDispatchContext,
  snapshot: SubAgentDelegationSnapshot,
): void {
  if (
    context.ownerSessionId !== snapshot.ownerSessionId ||
    context.runId !== snapshot.runId ||
    context.parentTaskId !== snapshot.parentTaskId
  ) {
    throw new SubAgentRuntimeError(RESOURCE_NOT_FOUND_ERROR);
  }
  if (context.stream === true) {
    throw new SubAgentRuntimeError({
      code: 'STREAMING_UNSUPPORTED',
      message: 'Streaming Subagent execution is not supported.',
      retryable: false,
    });
  }
}

function assertFailure(value: unknown): void {
  const failure = closedRecord(value, 'Failure', ['status', 'error'], ['partialOutput']);
  if (typeof failure.status !== 'string' || !FAILURE_STATES.has(failure.status))
    fail('Failure status is invalid.');
  assertSafeError(failure.error, 'Failure error');
  if (failure.partialOutput !== undefined) assertJsonValue(failure.partialOutput);
}

function assertChildDelegationRequest(value: unknown, label: string): void {
  const request = closedRecord(value, label, ['subAgent', 'executor', 'input', 'requestId']);
  assertIdentifier(request.subAgent, `${label} subAgent`);
  assertIdentifier(request.executor, `${label} executor`);
  assertIdentifier(request.requestId, `${label} requestId`);
  assertJsonValue(request.input);
}

function assertApprovalDirective(value: unknown): void {
  const directive = recordValue(value, 'Approval directive');
  if (directive.type === 'approved') {
    assertExactKeys(directive, 'Approval directive', ['type', 'approvalId']);
    assertIdentifier(directive.approvalId, 'Approval directive approvalId');
  } else if (directive.type === 'suspend') {
    assertExactKeys(directive, 'Approval directive', ['type', 'request', 'checkpointRevision']);
    assertApprovalRequest(directive.request);
    assertPositiveInteger(directive.checkpointRevision, 'Approval checkpointRevision');
  } else fail('Approval directive type is invalid.');
}

function assertPauseReceipt(value: unknown): void {
  const receipt = closedRecord(value, 'Pause receipt', ['checkpointRevision', 'approvals']);
  assertPositiveInteger(receipt.checkpointRevision, 'Pause checkpointRevision');
  if (!Array.isArray(receipt.approvals) || receipt.approvals.length < 1)
    fail('Pause approvals are invalid.');
  for (const approval of receipt.approvals) assertApprovalRequest(approval);
}

function assertApprovalRequest(value: unknown): void {
  const request = closedRecord(
    value,
    'Approval request',
    [
      'callId',
      'toolName',
      'summary',
      'approvalId',
      'ownerSessionId',
      'taskId',
      'createdAt',
      'revision',
    ],
    ['expiresAt'],
  );
  for (const key of ['callId', 'toolName', 'approvalId', 'ownerSessionId', 'taskId'] as const)
    assertIdentifier(request[key], `Approval ${key}`);
  assertMessage(request.summary, 'Approval summary');
  assertNonNegativeInteger(request.createdAt, 'Approval createdAt');
  assertPositiveInteger(request.revision, 'Approval revision');
  if (request.expiresAt !== undefined)
    assertNonNegativeInteger(request.expiresAt, 'Approval expiresAt');
}

function assertResultReceipt(value: unknown): void {
  const receipt = closedRecord(value, 'Result receipt', [
    'schemaVersion',
    'receiptId',
    'taskId',
    'callId',
    'revision',
    'outputHash',
    'submittedAt',
    'status',
  ]);
  if (
    receipt.schemaVersion !== '1' ||
    (receipt.status !== 'accepted' && receipt.status !== 'replayed')
  )
    fail('Result receipt discriminator is invalid.');
  for (const key of ['receiptId', 'taskId', 'callId'] as const)
    assertIdentifier(receipt[key], `Result receipt ${key}`);
  assertPositiveInteger(receipt.revision, 'Result receipt revision');
  assertSha256(receipt.outputHash, 'Result receipt outputHash');
  assertNonNegativeInteger(receipt.submittedAt, 'Result receipt submittedAt');
}

function assertCompletionReceipt(value: unknown): void {
  const receipt = closedRecord(value, 'Completion receipt', [
    'schemaVersion',
    'receiptId',
    'taskId',
    'callId',
    'revision',
    'completedAt',
    'status',
  ]);
  if (
    receipt.schemaVersion !== '1' ||
    (receipt.status !== 'completed' && receipt.status !== 'replayed')
  )
    fail('Completion receipt discriminator is invalid.');
  for (const key of ['receiptId', 'taskId', 'callId'] as const)
    assertIdentifier(receipt[key], `Completion receipt ${key}`);
  assertPositiveInteger(receipt.revision, 'Completion receipt revision');
  assertNonNegativeInteger(receipt.completedAt, 'Completion receipt completedAt');
}

function assertExecutionOutcome(value: unknown): void {
  const outcome = recordValue(value, 'Execution outcome');
  if (outcome.type === 'terminal') {
    assertExactKeys(outcome, 'Execution outcome', ['type', 'result']);
    assertTaskResult(outcome.result);
  } else if (outcome.type === 'paused') {
    assertExactKeys(outcome, 'Execution outcome', [
      'type',
      'reason',
      'task',
      'approvals',
      'checkpointRevision',
    ]);
    if (outcome.reason !== 'approval') fail('Paused outcome reason is invalid.');
    assertTaskIdentity(outcome.task);
    if (!Array.isArray(outcome.approvals) || outcome.approvals.length < 1)
      fail('Paused approvals are invalid.');
    for (const approval of outcome.approvals) assertApprovalRequest(approval);
    assertPositiveInteger(outcome.checkpointRevision, 'Paused checkpointRevision');
  } else fail('Execution outcome type is invalid.');
}

function assertTaskResult(value: unknown): void {
  const result = recordValue(value, 'Task result');
  if (result.status === 'succeeded') {
    assertKeys(result, 'Task result', ['status', 'task', 'executor', 'output'], ['usage']);
    assertJsonValue(result.output);
  } else if (typeof result.status === 'string' && FAILURE_STATES.has(result.status)) {
    assertKeys(
      result,
      'Task result',
      ['status', 'task', 'executor', 'error'],
      ['partialOutput', 'usage'],
    );
    assertSafeError(result.error, 'Task result error');
    if (result.partialOutput !== undefined) assertJsonValue(result.partialOutput);
  } else fail('Task result status is invalid.');
  assertTaskIdentity(result.task);
  assertIdentifier(result.executor, 'Task result executor');
  if (result.usage !== undefined) assertUsage(result.usage);
}

function assertTaskSnapshot(value: unknown): void {
  const snapshot = closedRecord(
    value,
    'Task snapshot',
    [
      'taskId',
      'subAgent',
      'ownerSessionId',
      'runId',
      'subagentSessionId',
      'path',
      'executor',
      'state',
      'revision',
      'attempt',
      'createdAt',
      'updatedAt',
      'recoveryRequired',
    ],
    ['parentTaskId', 'retryOf', 'startedAt', 'completedAt', 'outcomeUnknown', 'usage', 'error'],
  );
  assertIdentifier(snapshot.taskId, 'Task snapshot taskId');
  assertDefinitionRef(snapshot.subAgent);
  for (const key of ['ownerSessionId', 'runId', 'subagentSessionId', 'executor'] as const)
    assertIdentifier(snapshot[key], `Task snapshot ${key}`);
  for (const key of ['parentTaskId', 'retryOf'] as const)
    if (snapshot[key] !== undefined) assertIdentifier(snapshot[key], `Task snapshot ${key}`);
  if (!Array.isArray(snapshot.path)) fail('Task snapshot path is invalid.');
  for (const segment of snapshot.path) assertIdentifier(segment, 'Task snapshot path segment');
  if (typeof snapshot.state !== 'string' || !TASK_STATES.has(snapshot.state))
    fail('Task snapshot state is invalid.');
  assertPositiveInteger(snapshot.revision, 'Task snapshot revision');
  assertPositiveInteger(snapshot.attempt, 'Task snapshot attempt');
  for (const key of ['createdAt', 'updatedAt', 'startedAt', 'completedAt'] as const)
    if (snapshot[key] !== undefined)
      assertNonNegativeInteger(snapshot[key], `Task snapshot ${key}`);
  if (typeof snapshot.recoveryRequired !== 'boolean')
    fail('Task snapshot recoveryRequired is invalid.');
  if (snapshot.outcomeUnknown !== undefined && typeof snapshot.outcomeUnknown !== 'boolean')
    fail('Task snapshot outcomeUnknown is invalid.');
  if (snapshot.usage !== undefined) assertUsage(snapshot.usage);
  if (snapshot.error !== undefined) assertSafeError(snapshot.error, 'Task snapshot error');
}

function assertTaskIdentity(value: unknown): void {
  const task = closedRecord(value, 'Task identity', ['taskId', 'subAgent']);
  assertIdentifier(task.taskId, 'Task identity taskId');
  assertDefinitionRef(task.subAgent);
}

function assertDefinitionRef(value: unknown): void {
  const definition = closedRecord(value, 'Definition ref', ['name', 'version']);
  assertToken(definition.name, 'Definition name');
  assertToken(definition.version, 'Definition version');
}

function assertSafeError(value: unknown, label: string): void {
  const error = recordValue(value, label);
  for (const key of Object.keys(error))
    if (!SAFE_ERROR_KEYS.has(key)) fail(`${label} contains unsupported field ${key}.`);
  for (const key of ['code', 'message', 'retryable'] as const)
    if (!Object.hasOwn(error, key)) fail(`${label} is missing ${key}.`);
  assertToken(error.code, `${label} code`);
  if (!ERROR_CODE_SET.has(error.code as string)) fail(`${label} code is not stable.`);
  assertMessage(error.message, `${label} message`);
  if (typeof error.retryable !== 'boolean') fail(`${label} retryable is invalid.`);
  if (error.causeCode !== undefined) assertToken(error.causeCode, `${label} causeCode`);
  if (error.outcomeUnknown !== undefined && typeof error.outcomeUnknown !== 'boolean')
    fail(`${label} outcomeUnknown is invalid.`);
}

function closedRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  const record = recordValue(value, label);
  assertKeys(record, label, required, optional);
  return record;
}

function recordValue(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object.`);
  return value as UnknownRecord;
}

function assertExactKeys(record: UnknownRecord, label: string, required: readonly string[]): void {
  assertKeys(record, label, required, []);
}

function assertKeys(
  record: UnknownRecord,
  label: string,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(record, key)) fail(`${label} is missing ${key}.`);
  for (const key of Object.keys(record))
    if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}.`);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value !== value.trim() ||
    containsControlCharacter(value) ||
    textEncoder.encode(value).byteLength > SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES
  )
    fail(`${label} is invalid.`);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function assertToken(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !TOKEN_PATTERN.test(value) ||
    textEncoder.encode(value).byteLength > SUBAGENT_TRANSPORT_MAX_IDENTIFIER_BYTES
  )
    fail(`${label} is invalid.`);
}

function assertMessage(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value !== value.trim() ||
    textEncoder.encode(value).byteLength > 4_096
  )
    fail(`${label} is invalid.`);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} is invalid.`);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} is invalid.`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(`${label} is invalid.`);
}

function cloneJson(value: unknown, options: ResolvedControlValidationOptions): JsonValue {
  assertBoundedTransportJson(value, options);
  return parseJsonValue(canonicalizeJson(value), {
    maxBytes: options.maxBytes,
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
  });
}

function assertBoundedTransportJson(
  value: unknown,
  options: JsonValueBoundaryOptions = {},
): asserts value is JsonValue {
  assertJsonValue(value, {
    maxBytes: options.maxBytes ?? DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
    maxDepth: options.maxDepth ?? DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
    maxNodes: options.maxNodes ?? DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
    ...(options.label === undefined ? {} : { label: options.label }),
  });
}

function freezeJsonClone(
  value: unknown,
  options: ResolvedControlValidationOptions = resolveControlValidationOptions(),
): JsonValue {
  const cloned = cloneJson(value, options);
  const stack: JsonValue[] = [cloned];
  const objects: object[] = [];
  while (stack.length > 0) {
    const current = stack.pop() as JsonValue;
    if (current === null || typeof current !== 'object') continue;
    objects.push(current);
    const children = Array.isArray(current)
      ? current
      : Object.values(current as { readonly [key: string]: JsonValue });
    stack.push(...children);
  }
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    Object.freeze(objects[index]);
  }
  return cloned;
}

interface ResolvedControlValidationOptions extends JsonValueBoundaryOptions {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

function resolveControlValidationOptions(
  options: JsonValueBoundaryOptions | undefined = {},
): Readonly<ResolvedControlValidationOptions> {
  return Object.freeze({
    maxBytes: resolveBoundaryLimit(
      options.maxBytes,
      DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
      'maxBytes',
    ),
    maxDepth: resolveBoundaryLimit(
      options.maxDepth,
      DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
      'maxDepth',
    ),
    maxNodes: resolveBoundaryLimit(
      options.maxNodes,
      DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
      'maxNodes',
    ),
    ...(options.label === undefined ? {} : { label: options.label }),
  });
}

function resolveBoundaryLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return resolved;
}

function fail(message: string): never {
  throw new TypeError(message);
}
