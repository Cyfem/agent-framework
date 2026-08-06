import type { Model } from '../llm/base';
import { awaitWithAbort, isAbortError, throwIfAborted } from '../llm/base/abort';
import type {
  ModelGeneratePurpose,
  ModelGenerateRequest,
  ModelGenerateResult,
} from '../llm/base/types';
import { SubAgentRuntimeError } from '../subagent/errors';
import type {
  AfterModelErrorRecoveryCallback,
  AfterModelErrorRecoveryDecision,
  AgentProtocol,
  BeforeModelErrorRecoveryCallback,
  BeforeModelErrorRecoveryDecision,
  ModelErrorDescriptor,
  ModelErrorRecoveryDecisionTrace,
  ModelErrorRecoveryHandlerMatch,
  ModelErrorRecoveryHandlerOutcome,
  ModelErrorRecoveryStageFailure,
  ModelErrorRecoveryTerminalReason,
  ModelRetryLedger,
  ResolvedModelErrorRecoveryLimits,
} from './types';

/** 恢复错误最多公开最近多少条控制轨迹。 */
export const MODEL_ERROR_RECOVERY_TRACE_LIMIT = 64;

/** 框架缺省的模型错误恢复额度。 */
export const DEFAULT_MODEL_ERROR_RECOVERY_LIMITS: Readonly<ResolvedModelErrorRecoveryLimits> =
  Object.freeze({
    unhandledRetryLimit: 3,
    contextLengthRecoveryLimit: 2,
  });

interface MutableModelRetryLedger {
  requestAttempts: number;
  totalRetries: number;
  forcedRetries: number;
  unhandledRetries: number;
  contextRecoveryAttempts: number;
}

interface RecoveryHandlerResult {
  readonly outcome: 'succeeded' | 'unavailable';
}

interface RecoveryHandlerContext<P extends AgentProtocol> {
  readonly cause: unknown;
  readonly descriptor: ModelErrorDescriptor;
  readonly request: Readonly<ModelGenerateRequest<P>>;
  readonly requestAttempt: number;
}

export interface GenerateWithModelErrorRecoveryOptions<P extends AgentProtocol> {
  readonly model: Model<P>;
  /**
   * Optional durable single-attempt transport. The recovery state machine still owns
   * requestAttempt and retry policy; callers can fence each provider dispatch around it.
   */
  readonly generate?: (request: ModelGenerateRequest<P>) => Promise<ModelGenerateResult<P>>;
  readonly purpose: ModelGeneratePurpose;
  readonly buildRequest: () => ModelGenerateRequest<P>;
  readonly limits: Readonly<ResolvedModelErrorRecoveryLimits>;
  readonly getContextRevision: () => number;
  readonly beforeListeners:
    | readonly BeforeModelErrorRecoveryCallback<P>[]
    | (() => readonly BeforeModelErrorRecoveryCallback<P>[]);
  readonly afterListeners:
    | readonly AfterModelErrorRecoveryCallback<P>[]
    | (() => readonly AfterModelErrorRecoveryCallback<P>[]);
  readonly matchHandler?: (
    descriptor: ModelErrorDescriptor,
    purpose: ModelGeneratePurpose,
  ) => ModelErrorRecoveryHandlerMatch | undefined;
  readonly runHandler?: (
    match: Readonly<ModelErrorRecoveryHandlerMatch>,
    context: Readonly<RecoveryHandlerContext<P>>,
  ) => Promise<RecoveryHandlerResult>;
}

interface ModelErrorRecoveryErrorOptions {
  readonly initialError: unknown;
  readonly terminalCause: unknown;
  readonly lastDescriptor: ModelErrorDescriptor;
  readonly terminalReason: ModelErrorRecoveryTerminalReason;
  readonly ledger: Readonly<ModelRetryLedger>;
  readonly stageFailures: readonly ModelErrorRecoveryStageFailure[];
  readonly decisionTrace: readonly ModelErrorRecoveryDecisionTrace[];
  readonly droppedDecisionTraceCount: number;
}

/**
 * 模型错误恢复最终无法继续时抛出的稳定错误。
 *
 * 为避免保留完整请求，decision trace 只记录最近 64 条控制决策。provider 原始
 * 异常分别保存在 `initialError` 与 `terminalCause`。
 */
export class ModelErrorRecoveryError extends Error {
  readonly initialError: unknown;
  readonly terminalCause: unknown;
  readonly lastDescriptor: ModelErrorDescriptor;
  readonly terminalReason: ModelErrorRecoveryTerminalReason;
  readonly ledger: Readonly<ModelRetryLedger>;
  readonly stageFailures: readonly ModelErrorRecoveryStageFailure[];
  readonly decisionTrace: readonly ModelErrorRecoveryDecisionTrace[];
  readonly droppedDecisionTraceCount: number;

  constructor(options: ModelErrorRecoveryErrorOptions) {
    super(`Model error recovery stopped: ${options.terminalReason}.`, {
      cause: options.terminalCause,
    });
    this.name = 'ModelErrorRecoveryError';
    this.initialError = options.initialError;
    this.terminalCause = options.terminalCause;
    this.lastDescriptor = Object.freeze({ ...options.lastDescriptor });
    this.terminalReason = options.terminalReason;
    this.ledger = Object.freeze({ ...options.ledger });
    this.stageFailures = Object.freeze(
      options.stageFailures.map((failure) => Object.freeze({ ...failure })),
    );
    this.decisionTrace = Object.freeze(
      options.decisionTrace.map((entry) => Object.freeze({ ...entry })),
    );
    this.droppedDecisionTraceCount = options.droppedDecisionTraceCount;
  }
}

/** 解析并校验 Agent 的错误恢复额度。 */
export function resolveModelErrorRecoveryLimits(input?: {
  readonly unhandledRetryLimit?: number;
  readonly contextLengthRecoveryLimit?: number;
}): Readonly<ResolvedModelErrorRecoveryLimits> {
  if (
    input !== undefined &&
    (typeof input !== 'object' || input === null || Array.isArray(input))
  ) {
    throw new TypeError('modelErrorRecovery must be a non-null object.');
  }

  const limits = {
    unhandledRetryLimit:
      input?.unhandledRetryLimit === undefined
        ? DEFAULT_MODEL_ERROR_RECOVERY_LIMITS.unhandledRetryLimit
        : input.unhandledRetryLimit,
    contextLengthRecoveryLimit:
      input?.contextLengthRecoveryLimit === undefined
        ? DEFAULT_MODEL_ERROR_RECOVERY_LIMITS.contextLengthRecoveryLimit
        : input.contextLengthRecoveryLimit,
  };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer.`);
    }
  }

  return Object.freeze(limits);
}

/**
 * 以迭代状态机执行一个逻辑模型请求。
 *
 * forced retry 没有硬上限；控制 hook 永久返回 `retry/continue` 会产生无限请求。
 */
export async function generateWithModelErrorRecovery<P extends AgentProtocol>(
  options: GenerateWithModelErrorRecoveryOptions<P>,
): Promise<ModelGenerateResult<P>> {
  const ledger: MutableModelRetryLedger = {
    requestAttempts: 0,
    totalRetries: 0,
    forcedRetries: 0,
    unhandledRetries: 0,
    contextRecoveryAttempts: 0,
  };
  const trace = new BoundedTrace();
  const stageFailures: ModelErrorRecoveryStageFailure[] = [];
  let initialError: unknown;
  let hasInitialError = false;
  let lastDescriptor: ModelErrorDescriptor | undefined;
  let hadRecoveryActivity = false;

  while (true) {
    ledger.requestAttempts += 1;
    const request = withRequestAttempt(options.buildRequest(), ledger.requestAttempts);
    throwIfAborted(request.signal, request.deadlineAt);

    try {
      // A durable attempt owns its dispatch fence and must finish classifying/persisting an
      // aborted transport before this recovery layer observes the result. Racing it with a
      // second abort wrapper could surface caller cancellation while the durable callback has
      // already committed MODEL_OUTCOME_UNKNOWN.
      return options.generate === undefined
        ? await awaitWithAbort(options.model.generate(request), request.signal)
        : await options.generate(request);
    } catch (cause) {
      // A request which may already have reached the provider is never eligible for a
      // framework retry. Retrying here could duplicate an externally visible operation.
      if (
        cause instanceof SubAgentRuntimeError &&
        (cause.descriptor.outcomeUnknown === true ||
          cause.descriptor.code === 'BUDGET_EXCEEDED' ||
          cause.descriptor.code === 'RECOVERY_TARGET_LOST')
      ) {
        throw cause;
      }
      if (isAbortError(cause, request.signal)) {
        throwIfAborted(request.signal, request.deadlineAt);
        throw cause;
      }

      if (!hasInitialError) {
        initialError = cause;
        hasInitialError = true;
      }
      const requestAttempt = ledger.requestAttempts;
      let descriptor: ModelErrorDescriptor;

      try {
        descriptor = validateDescriptor(
          options.model.classifyError(cause, {
            purpose: options.purpose,
            request,
          }),
        );
        lastDescriptor = descriptor;
      } catch (classificationFailure) {
        const failure: ModelErrorRecoveryStageFailure = {
          stage: 'classify',
          cause: classificationFailure,
          requestAttempt,
        };
        stageFailures.push(failure);
        trace.push({ stage: 'terminal', requestAttempt, decision: 'classifier-failed' });
        throw createRecoveryError({
          initialError,
          terminalCause: classificationFailure,
          lastDescriptor: lastDescriptor ?? createUnknownDescriptor(cause),
          terminalReason: 'classifier-failed',
          ledger,
          stageFailures,
          trace,
        });
      }

      const matchedHandler = options.matchHandler?.(descriptor, options.purpose);
      const handlerWithinLimit =
        matchedHandler !== undefined &&
        ledger.contextRecoveryAttempts < options.limits.contextLengthRecoveryLimit;
      const unhandledWithinLimit =
        matchedHandler === undefined &&
        ledger.unhandledRetries < options.limits.unhandledRetryLimit;
      const defaultAction = handlerWithinLimit || unhandledWithinLimit ? 'retry' : 'stop';
      const eventBase = {
        cause,
        descriptor,
        purpose: options.purpose,
        request,
        requestAttempt,
        ledger: snapshotLedger(ledger),
        limits: options.limits,
        ...(matchedHandler === undefined
          ? {}
          : { matchedHandler: Object.freeze({ ...matchedHandler }) }),
        contextRevision: options.getContextRevision(),
      } as const;
      let beforeDecision: BeforeModelErrorRecoveryDecision;

      try {
        beforeDecision = await aggregateBeforeDecision(
          resolveListenerSnapshot(options.beforeListeners),
          {
            ...eventBase,
            defaultAction,
          },
          request.signal,
        );
      } catch (hookFailure) {
        if (isAbortError(hookFailure, request.signal)) {
          throwIfAborted(request.signal, request.deadlineAt);
          throw hookFailure;
        }

        stageFailures.push({
          stage: 'before-hook',
          cause: hookFailure,
          requestAttempt,
          ...(matchedHandler === undefined ? {} : { handlerId: matchedHandler.id }),
        });
        trace.push({ stage: 'terminal', requestAttempt, decision: 'before-hook-failed' });
        throw createRecoveryError({
          initialError,
          terminalCause: hookFailure,
          lastDescriptor: descriptor,
          terminalReason: 'before-hook-failed',
          ledger,
          stageFailures,
          trace,
        });
      }

      trace.push({ stage: 'before', requestAttempt, decision: beforeDecision });

      if (beforeDecision !== 'default') {
        hadRecoveryActivity = true;
      }

      if (beforeDecision === 'stop') {
        trace.push({ stage: 'terminal', requestAttempt, decision: 'stopped' });
        throw terminalErrorOrOriginal({
          original: cause,
          hadRecoveryActivity,
          initialError,
          lastDescriptor: descriptor,
          terminalReason: 'stopped',
          ledger,
          stageFailures,
          trace,
        });
      }

      let handlerOutcome: ModelErrorRecoveryHandlerOutcome = 'not-run';
      let handlerFailure: unknown;
      let proposedAction: 'retry' | 'stop';
      let proposedTerminalReason: ModelErrorRecoveryTerminalReason = 'stopped';

      if (beforeDecision === 'retry') {
        proposedAction = 'retry';
      } else if (matchedHandler !== undefined) {
        const forceHandler = beforeDecision === 'continue';

        if (!handlerWithinLimit && !forceHandler) {
          handlerOutcome = 'limit-exceeded';
          proposedAction = 'stop';
          proposedTerminalReason = 'context-recovery-limit';
        } else if (!options.runHandler) {
          handlerOutcome = 'unavailable';
          proposedAction = forceHandler ? 'retry' : 'stop';
          proposedTerminalReason = 'handler-unavailable';
        } else {
          ledger.contextRecoveryAttempts += 1;
          hadRecoveryActivity = true;

          try {
            const result = await awaitWithAbort(
              options.runHandler(matchedHandler, {
                cause,
                descriptor,
                request,
                requestAttempt,
              }),
              request.signal,
            );
            handlerOutcome = result.outcome;
            proposedAction = result.outcome === 'succeeded' || forceHandler ? 'retry' : 'stop';
            proposedTerminalReason =
              result.outcome === 'succeeded' ? 'stopped' : 'handler-unavailable';
          } catch (failure) {
            if (isAbortError(failure, request.signal)) {
              throwIfAborted(request.signal, request.deadlineAt);
              throw failure;
            }

            handlerOutcome = 'failed';
            handlerFailure = failure;
            proposedAction = forceHandler ? 'retry' : 'stop';
            proposedTerminalReason = 'handler-failed';
            stageFailures.push({
              stage: 'handler',
              cause: failure,
              requestAttempt,
              handlerId: matchedHandler.id,
            });
          }
        }
      } else if (beforeDecision === 'continue') {
        handlerOutcome = 'unavailable';
        proposedAction = 'retry';
        proposedTerminalReason = 'handler-unavailable';
      } else if (unhandledWithinLimit) {
        proposedAction = 'retry';
        proposedTerminalReason = 'unhandled-retry-limit';
      } else {
        proposedAction = 'stop';
        proposedTerminalReason = 'unhandled-retry-limit';
      }

      trace.push({
        stage: 'handler',
        requestAttempt,
        handlerOutcome,
        action: proposedAction,
      });

      const afterEvent = {
        ...eventBase,
        ledger: snapshotLedger(ledger),
        contextRevision: options.getContextRevision(),
        beforeDecision,
        handlerOutcome,
        proposedAction,
        ...(handlerFailure === undefined ? {} : { handlerFailure }),
      } as const;
      let afterDecision: AfterModelErrorRecoveryDecision;

      try {
        afterDecision = await aggregateAfterDecision(
          resolveListenerSnapshot(options.afterListeners),
          afterEvent,
          request.signal,
        );
      } catch (hookFailure) {
        if (isAbortError(hookFailure, request.signal)) {
          throwIfAborted(request.signal, request.deadlineAt);
          throw hookFailure;
        }

        stageFailures.push({
          stage: 'after-hook',
          cause: hookFailure,
          requestAttempt,
          ...(matchedHandler === undefined ? {} : { handlerId: matchedHandler.id }),
        });
        trace.push({ stage: 'terminal', requestAttempt, decision: 'after-hook-failed' });
        throw createRecoveryError({
          initialError,
          terminalCause: hookFailure,
          lastDescriptor: descriptor,
          terminalReason: 'after-hook-failed',
          ledger,
          stageFailures,
          trace,
        });
      }

      trace.push({ stage: 'after', requestAttempt, decision: afterDecision });

      if (afterDecision !== 'default') {
        hadRecoveryActivity = true;
      }

      const forcedRetry =
        afterDecision === 'retry' ||
        (afterDecision === 'default' &&
          (beforeDecision === 'retry' || beforeDecision === 'continue'));
      const finalAction =
        afterDecision === 'stop' ? 'stop' : afterDecision === 'retry' ? 'retry' : proposedAction;

      if (finalAction === 'retry') {
        ledger.totalRetries += 1;

        if (forcedRetry) {
          ledger.forcedRetries += 1;
        } else if (matchedHandler === undefined) {
          ledger.unhandledRetries += 1;
        }

        hadRecoveryActivity = true;
        trace.push({
          stage: 'retry',
          requestAttempt,
          decision: forcedRetry ? 'forced' : 'default',
          action: 'retry',
        });
        continue;
      }

      const terminalReason = afterDecision === 'stop' ? 'stopped' : proposedTerminalReason;
      trace.push({ stage: 'terminal', requestAttempt, decision: terminalReason, action: 'stop' });
      throw terminalErrorOrOriginal({
        original: cause,
        hadRecoveryActivity,
        initialError,
        lastDescriptor: descriptor,
        terminalReason,
        ledger,
        stageFailures,
        trace,
      });
    }
  }
}

function resolveListenerSnapshot<T>(source: readonly T[] | (() => readonly T[])): readonly T[] {
  return [...(typeof source === 'function' ? source() : source)];
}

async function aggregateBeforeDecision<P extends AgentProtocol>(
  listeners: readonly BeforeModelErrorRecoveryCallback<P>[],
  event: Parameters<BeforeModelErrorRecoveryCallback<P>>[0],
  signal?: AbortSignal,
): Promise<BeforeModelErrorRecoveryDecision> {
  let finalDecision: BeforeModelErrorRecoveryDecision = 'default';

  for (const listener of [...listeners]) {
    const decision = (await awaitWithAbort(Promise.resolve(listener(event)), signal)) ?? 'default';

    if (!isBeforeDecision(decision)) {
      throw new TypeError(`Invalid before model recovery decision: ${String(decision)}.`);
    }

    if (decision !== 'default') {
      finalDecision = decision;
    }
  }

  return finalDecision;
}

async function aggregateAfterDecision<P extends AgentProtocol>(
  listeners: readonly AfterModelErrorRecoveryCallback<P>[],
  event: Parameters<AfterModelErrorRecoveryCallback<P>>[0],
  signal?: AbortSignal,
): Promise<AfterModelErrorRecoveryDecision> {
  let finalDecision: AfterModelErrorRecoveryDecision = 'default';

  for (const listener of [...listeners]) {
    const decision = (await awaitWithAbort(Promise.resolve(listener(event)), signal)) ?? 'default';

    if (!isAfterDecision(decision)) {
      throw new TypeError(`Invalid after model recovery decision: ${String(decision)}.`);
    }

    if (decision !== 'default') {
      finalDecision = decision;
    }
  }

  return finalDecision;
}

function withRequestAttempt<P extends AgentProtocol>(
  request: ModelGenerateRequest<P>,
  requestAttempt: number,
): ModelGenerateRequest<P> {
  return {
    ...request,
    runtime: Object.freeze({
      ...request.runtime,
      requestAttempt,
    }),
  };
}

function isBeforeDecision(value: unknown): value is BeforeModelErrorRecoveryDecision {
  return value === 'default' || value === 'retry' || value === 'continue' || value === 'stop';
}

function isAfterDecision(value: unknown): value is AfterModelErrorRecoveryDecision {
  return value === 'default' || value === 'retry' || value === 'stop';
}

function snapshotLedger(ledger: MutableModelRetryLedger): Readonly<ModelRetryLedger> {
  return Object.freeze({ ...ledger });
}

function validateDescriptor(descriptor: ModelErrorDescriptor): ModelErrorDescriptor {
  if (
    typeof descriptor !== 'object' ||
    descriptor === null ||
    typeof descriptor.kind !== 'string' ||
    descriptor.kind.length === 0 ||
    typeof descriptor.message !== 'string'
  ) {
    throw new TypeError('Model.classifyError() must return a descriptor with string kind/message.');
  }

  return Object.freeze({ ...descriptor });
}

function createUnknownDescriptor(error: unknown): ModelErrorDescriptor {
  return {
    kind: 'unknown',
    message: error instanceof Error ? error.message : String(error),
  };
}

function terminalErrorOrOriginal(input: {
  readonly original: unknown;
  readonly hadRecoveryActivity: boolean;
  readonly initialError: unknown;
  readonly lastDescriptor: ModelErrorDescriptor;
  readonly terminalReason: ModelErrorRecoveryTerminalReason;
  readonly ledger: MutableModelRetryLedger;
  readonly stageFailures: readonly ModelErrorRecoveryStageFailure[];
  readonly trace: BoundedTrace;
}): unknown {
  if (!input.hadRecoveryActivity) {
    return input.original;
  }

  return createRecoveryError({
    initialError: input.initialError,
    terminalCause: input.original,
    lastDescriptor: input.lastDescriptor,
    terminalReason: input.terminalReason,
    ledger: input.ledger,
    stageFailures: input.stageFailures,
    trace: input.trace,
  });
}

function createRecoveryError(input: {
  readonly initialError: unknown;
  readonly terminalCause: unknown;
  readonly lastDescriptor: ModelErrorDescriptor;
  readonly terminalReason: ModelErrorRecoveryTerminalReason;
  readonly ledger: MutableModelRetryLedger;
  readonly stageFailures: readonly ModelErrorRecoveryStageFailure[];
  readonly trace: BoundedTrace;
}): ModelErrorRecoveryError {
  return new ModelErrorRecoveryError({
    initialError: input.initialError,
    terminalCause: input.terminalCause,
    lastDescriptor: input.lastDescriptor,
    terminalReason: input.terminalReason,
    ledger: snapshotLedger(input.ledger),
    stageFailures: input.stageFailures,
    decisionTrace: input.trace.entries,
    droppedDecisionTraceCount: input.trace.droppedCount,
  });
}

class BoundedTrace {
  readonly #entries: ModelErrorRecoveryDecisionTrace[] = [];
  #droppedCount = 0;

  get entries(): readonly ModelErrorRecoveryDecisionTrace[] {
    return [...this.#entries];
  }

  get droppedCount(): number {
    return this.#droppedCount;
  }

  push(entry: ModelErrorRecoveryDecisionTrace): void {
    if (this.#entries.length === MODEL_ERROR_RECOVERY_TRACE_LIMIT) {
      this.#entries.shift();
      this.#droppedCount += 1;
    }

    this.#entries.push(entry);
  }
}
