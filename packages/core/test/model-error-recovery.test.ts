import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MODEL_ERROR_RECOVERY_LIMITS,
  MODEL_ERROR_RECOVERY_TRACE_LIMIT,
  ModelErrorRecoveryError,
  generateWithModelErrorRecovery,
  resolveModelErrorRecoveryLimits,
  type GenerateWithModelErrorRecoveryOptions,
} from '../src/agent/model-error-recovery';
import type {
  AgentProtocol,
  AfterModelErrorRecoveryEvent,
  BeforeModelErrorRecoveryCallback,
  BeforeModelErrorRecoveryEvent,
  ModelErrorDescriptor,
} from '../src/agent/types';
import type { Model } from '../src/llm/base';
import type { ModelGenerateRequest, ModelGenerateResult } from '../src/llm/base/types';

interface TestMessage {
  readonly type: string;
  readonly text?: string;
}

interface TestProtocol extends AgentProtocol {
  context: TestMessage;
  tool: { readonly name: string };
  userMessage: unknown;
  systemMessage: unknown;
  assistantMessage: unknown;
  toolCallOutputMessage: unknown;
  rawToolCall: unknown;
  rawResponse: unknown;
}

type RecoveryOptions = GenerateWithModelErrorRecoveryOptions<TestProtocol>;
type GenerateImplementation = (
  request: ModelGenerateRequest<TestProtocol>,
) => Promise<ModelGenerateResult<TestProtocol>>;
type ClassifyImplementation = (
  cause: unknown,
  context: Parameters<Model<TestProtocol>['classifyError']>[1],
) => ModelErrorDescriptor;

const successfulResult: ModelGenerateResult<TestProtocol> = {
  messages: [{ type: 'assistant', text: 'ok' }],
};

function unknownDescriptor(cause: unknown): ModelErrorDescriptor {
  return {
    kind: 'unknown',
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function contextLengthDescriptor(cause: unknown): ModelErrorDescriptor {
  return {
    kind: 'context_length_exceeded',
    message: cause instanceof Error ? cause.message : String(cause),
    provider: 'test',
    providerCode: 'context_length_exceeded',
    status: 400,
  };
}

function createModel(
  generate: GenerateImplementation,
  classifyError: ClassifyImplementation = unknownDescriptor,
): Model<TestProtocol> {
  return {
    generate: vi.fn(generate),
    classifyError: vi.fn(classifyError),
  } as unknown as Model<TestProtocol>;
}

function runRecovery(
  model: Model<TestProtocol>,
  overrides: Partial<Omit<RecoveryOptions, 'model'>> = {},
): Promise<ModelGenerateResult<TestProtocol>> {
  return generateWithModelErrorRecovery<TestProtocol>({
    model,
    purpose: 'agent',
    buildRequest: () => ({ context: [], tools: [] }),
    limits: resolveModelErrorRecoveryLimits(),
    getContextRevision: () => 7,
    beforeListeners: [],
    afterListeners: [],
    ...overrides,
  });
}

async function captureRecoveryError(promise: Promise<unknown>): Promise<ModelErrorRecoveryError> {
  let thrown: unknown;

  try {
    await promise;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ModelErrorRecoveryError);
  return thrown as ModelErrorRecoveryError;
}

describe('model error recovery limits', () => {
  it('exposes frozen defaults and validates resolved limits', () => {
    expect(DEFAULT_MODEL_ERROR_RECOVERY_LIMITS).toEqual({
      unhandledRetryLimit: 3,
      contextLengthRecoveryLimit: 2,
    });
    expect(Object.isFrozen(DEFAULT_MODEL_ERROR_RECOVERY_LIMITS)).toBe(true);
    expect(resolveModelErrorRecoveryLimits({ unhandledRetryLimit: 0 })).toEqual({
      unhandledRetryLimit: 0,
      contextLengthRecoveryLimit: 2,
    });
    expect(() => resolveModelErrorRecoveryLimits({ unhandledRetryLimit: -1 })).toThrow(TypeError);
    expect(() => resolveModelErrorRecoveryLimits({ contextLengthRecoveryLimit: 1.5 })).toThrow(
      TypeError,
    );
    expect(() => resolveModelErrorRecoveryLimits({ unhandledRetryLimit: null as never })).toThrow(
      TypeError,
    );
  });

  it('retries an unknown error three additional times by default', async () => {
    const causes = Array.from({ length: 4 }, (_, index) => new Error(`failure-${index + 1}`));
    let call = 0;
    const model = createModel(async () => {
      throw causes[call++]!;
    });

    const error = await captureRecoveryError(runRecovery(model));

    expect(model.generate).toHaveBeenCalledTimes(4);
    expect(error.initialError).toBe(causes[0]);
    expect(error.terminalCause).toBe(causes[3]);
    expect(error.lastDescriptor).toEqual({ kind: 'unknown', message: 'failure-4' });
    expect(error.terminalReason).toBe('unhandled-retry-limit');
    expect(error.ledger).toEqual({
      requestAttempts: 4,
      totalRetries: 3,
      forcedRetries: 0,
      unhandledRetries: 3,
      contextRecoveryAttempts: 0,
    });
  });

  it('throws the original provider error when the unknown retry limit is zero', async () => {
    const providerError = new Error('provider failed');
    const model = createModel(async () => {
      throw providerError;
    });

    await expect(
      runRecovery(model, {
        limits: resolveModelErrorRecoveryLimits({ unhandledRetryLimit: 0 }),
      }),
    ).rejects.toBe(providerError);
    expect(model.generate).toHaveBeenCalledTimes(1);
  });

  it('continues the durable request-attempt identity and recovery telemetry', async () => {
    const attempts: number[] = [];
    const recoveryAttempts: number[] = [];
    const model = createModel(async (request) => {
      attempts.push(request.runtime?.requestAttempt ?? -1);
      if (attempts.length === 1) throw new Error('cached attempt two rejection');
      return successfulResult;
    });

    await expect(
      runRecovery(model, {
        initialRequestAttempts: 1,
        limits: resolveModelErrorRecoveryLimits({ unhandledRetryLimit: 1 }),
        beforeListeners: [
          (event) => {
            recoveryAttempts.push(event.requestAttempt);
          },
        ],
      }),
    ).resolves.toEqual(successfulResult);

    expect(attempts).toEqual([2, 3]);
    expect(recoveryAttempts).toEqual([2]);
  });

  it('rejects an invalid durable request-attempt offset before dispatch', async () => {
    const model = createModel(async () => successfulResult);

    for (const initialRequestAttempts of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(runRecovery(model, { initialRequestAttempts })).rejects.toThrow(TypeError);
    }
    expect(model.generate).not.toHaveBeenCalled();
  });
});

describe('before and after decisions', () => {
  it('takes a fresh listener snapshot for each retry stage', async () => {
    const failures = [new Error('first'), new Error('second')];
    const model = createModel(async () => {
      const failure = failures.shift();
      if (failure) throw failure;
      return successfulResult;
    });
    const lateListener = vi.fn<BeforeModelErrorRecoveryCallback<TestProtocol>>(() => undefined);
    const listeners: BeforeModelErrorRecoveryCallback<TestProtocol>[] = [];
    const firstListener = vi.fn<BeforeModelErrorRecoveryCallback<TestProtocol>>(() => {
      listeners.push(lateListener);
      return undefined;
    });
    listeners.push(firstListener);

    await runRecovery(model, {
      beforeListeners: () => listeners,
    });

    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(lateListener).toHaveBeenCalledOnce();
  });

  it('uses the last non-default decision from each listener list', async () => {
    const providerError = new Error('retry me');
    let call = 0;
    const model = createModel(async () => {
      if (call++ === 0) {
        throw providerError;
      }

      return successfulResult;
    });
    const beforeEvents: BeforeModelErrorRecoveryEvent<TestProtocol>[] = [];
    const afterEvents: AfterModelErrorRecoveryEvent<TestProtocol>[] = [];

    await expect(
      runRecovery(model, {
        beforeListeners: [
          (event) => {
            beforeEvents.push(event);
            return 'stop';
          },
          () => undefined,
          () => 'retry',
          () => 'default',
        ],
        afterListeners: [
          (event) => {
            afterEvents.push(event);
            return 'stop';
          },
          () => undefined,
          () => 'retry',
          () => 'default',
        ],
      }),
    ).resolves.toBe(successfulResult);

    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(beforeEvents).toHaveLength(1);
    expect(beforeEvents[0]).toMatchObject({
      cause: providerError,
      purpose: 'agent',
      requestAttempt: 1,
      defaultAction: 'retry',
      contextRevision: 7,
    });
    expect(afterEvents).toHaveLength(1);
    expect(afterEvents[0]).toMatchObject({
      beforeDecision: 'retry',
      handlerOutcome: 'not-run',
      proposedAction: 'retry',
    });
  });

  it('lets before retry skip a matched handler while still running after hooks', async () => {
    let call = 0;
    const model = createModel(async () => {
      if (call++ === 0) {
        throw new Error('too long');
      }

      return successfulResult;
    }, contextLengthDescriptor);
    const runHandler = vi.fn(async () => ({ outcome: 'succeeded' as const }));
    const after = vi.fn<(event: Readonly<AfterModelErrorRecoveryEvent<TestProtocol>>) => undefined>(
      () => undefined,
    );

    await expect(
      runRecovery(model, {
        beforeListeners: [() => 'retry'],
        afterListeners: [after],
        matchHandler: () => ({ id: 'context-summary', kind: 'context_length_exceeded' }),
        runHandler,
      }),
    ).resolves.toBe(successfulResult);

    expect(runHandler).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledOnce();
    expect(after.mock.calls[0]![0]).toMatchObject({
      beforeDecision: 'retry',
      handlerOutcome: 'not-run',
      proposedAction: 'retry',
      ledger: { contextRecoveryAttempts: 0 },
    });
  });

  it('lets before continue run a matched handler beyond its configured budget', async () => {
    let call = 0;
    const model = createModel(async () => {
      if (call++ === 0) {
        throw new Error('too long');
      }

      return successfulResult;
    }, contextLengthDescriptor);
    const runHandler = vi.fn(async () => ({ outcome: 'unavailable' as const }));
    const afterEvents: AfterModelErrorRecoveryEvent<TestProtocol>[] = [];

    await expect(
      runRecovery(model, {
        limits: resolveModelErrorRecoveryLimits({ contextLengthRecoveryLimit: 0 }),
        beforeListeners: [() => 'continue'],
        afterListeners: [
          (event) => {
            afterEvents.push(event);
          },
        ],
        matchHandler: () => ({ id: 'context-summary', kind: 'context_length_exceeded' }),
        runHandler,
      }),
    ).resolves.toBe(successfulResult);

    expect(runHandler).toHaveBeenCalledOnce();
    expect(afterEvents[0]).toMatchObject({
      beforeDecision: 'continue',
      handlerOutcome: 'unavailable',
      proposedAction: 'retry',
      ledger: { contextRecoveryAttempts: 1 },
    });
  });

  it('lets before stop skip both the handler and after hooks', async () => {
    const providerError = new Error('stop now');
    const model = createModel(async () => {
      throw providerError;
    }, contextLengthDescriptor);
    const runHandler = vi.fn(async () => ({ outcome: 'succeeded' as const }));
    const after = vi.fn(() => 'retry' as const);

    const error = await captureRecoveryError(
      runRecovery(model, {
        beforeListeners: [() => 'stop'],
        afterListeners: [after],
        matchHandler: () => ({ id: 'context-summary', kind: 'context_length_exceeded' }),
        runHandler,
      }),
    );

    expect(runHandler).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(error.terminalReason).toBe('stopped');
    expect(error.terminalCause).toBe(providerError);
    expect(error.ledger.totalRetries).toBe(0);
  });
});

describe('context recovery handlers', () => {
  it('runs a successful context handler twice, then reports limit-exceeded', async () => {
    const causes = Array.from({ length: 3 }, (_, index) => new Error(`context-${index + 1}`));
    let call = 0;
    const model = createModel(async () => {
      throw causes[call++]!;
    }, contextLengthDescriptor);
    const runHandler = vi.fn(async () => ({ outcome: 'succeeded' as const }));
    const afterEvents: AfterModelErrorRecoveryEvent<TestProtocol>[] = [];

    const error = await captureRecoveryError(
      runRecovery(model, {
        matchHandler: () => ({ id: 'context-summary', kind: 'context_length_exceeded' }),
        runHandler,
        afterListeners: [
          (event) => {
            afterEvents.push(event);
          },
        ],
      }),
    );

    expect(model.generate).toHaveBeenCalledTimes(3);
    expect(runHandler).toHaveBeenCalledTimes(2);
    expect(afterEvents.map((event) => event.handlerOutcome)).toEqual([
      'succeeded',
      'succeeded',
      'limit-exceeded',
    ]);
    expect(afterEvents.map((event) => event.proposedAction)).toEqual(['retry', 'retry', 'stop']);
    expect(afterEvents[2]).toMatchObject({
      beforeDecision: 'default',
      ledger: { contextRecoveryAttempts: 2 },
    });
    expect(error.terminalReason).toBe('context-recovery-limit');
    expect(error.ledger).toEqual({
      requestAttempts: 3,
      totalRetries: 2,
      forcedRetries: 0,
      unhandledRetries: 0,
      contextRecoveryAttempts: 2,
    });
  });

  it('reports an unavailable handler without consuming a context recovery attempt', async () => {
    const providerError = new Error('no summary policy');
    const model = createModel(async () => {
      throw providerError;
    }, contextLengthDescriptor);
    const afterEvents: AfterModelErrorRecoveryEvent<TestProtocol>[] = [];

    await expect(
      runRecovery(model, {
        matchHandler: () => ({ id: 'context-summary', kind: 'context_length_exceeded' }),
        afterListeners: [
          (event) => {
            afterEvents.push(event);
          },
        ],
      }),
    ).rejects.toBe(providerError);

    expect(afterEvents).toHaveLength(1);
    expect(afterEvents[0]).toMatchObject({
      handlerOutcome: 'unavailable',
      proposedAction: 'stop',
      ledger: { contextRecoveryAttempts: 0 },
    });
  });

  it('allows an after hook to retry after a handler failure', async () => {
    const providerError = new Error('context overflow');
    const handlerFailure = new Error('summary failed');
    let call = 0;
    const model = createModel(async () => {
      if (call++ === 0) {
        throw providerError;
      }

      return successfulResult;
    }, contextLengthDescriptor);
    const afterEvents: AfterModelErrorRecoveryEvent<TestProtocol>[] = [];

    await expect(
      runRecovery(model, {
        matchHandler: () => ({ id: 'context-summary', kind: 'context_length_exceeded' }),
        runHandler: async () => {
          throw handlerFailure;
        },
        afterListeners: [
          (event) => {
            afterEvents.push(event);
            return 'retry';
          },
        ],
      }),
    ).resolves.toBe(successfulResult);

    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(afterEvents).toHaveLength(1);
    expect(afterEvents[0]).toMatchObject({
      cause: providerError,
      handlerOutcome: 'failed',
      handlerFailure,
      proposedAction: 'stop',
      ledger: { contextRecoveryAttempts: 1 },
    });
  });
});

describe('forced retries', () => {
  it('can retry beyond all configured budgets and records those retries separately', async () => {
    const causes = Array.from({ length: 4 }, (_, index) => new Error(`forced-${index + 1}`));
    let call = 0;
    const model = createModel(async () => {
      throw causes[call++]!;
    });

    const error = await captureRecoveryError(
      runRecovery(model, {
        limits: resolveModelErrorRecoveryLimits({ unhandledRetryLimit: 0 }),
        afterListeners: [(event) => (event.requestAttempt < 4 ? 'retry' : 'stop')],
      }),
    );

    expect(model.generate).toHaveBeenCalledTimes(4);
    expect(error.terminalReason).toBe('stopped');
    expect(error.ledger).toEqual({
      requestAttempts: 4,
      totalRetries: 3,
      forcedRetries: 3,
      unhandledRetries: 0,
      contextRecoveryAttempts: 0,
    });
  });
});

describe('stage failure wrapping', () => {
  it('wraps a classifier failure with the provider error retained as initialError', async () => {
    const providerError = new Error('provider failed');
    const classifierFailure = new Error('classifier failed');
    const model = createModel(
      async () => {
        throw providerError;
      },
      () => {
        throw classifierFailure;
      },
    );

    const error = await captureRecoveryError(runRecovery(model));

    expect(error.initialError).toBe(providerError);
    expect(error.terminalCause).toBe(classifierFailure);
    expect(error.cause).toBe(classifierFailure);
    expect(error.terminalReason).toBe('classifier-failed');
    expect(error.lastDescriptor).toEqual({ kind: 'unknown', message: 'provider failed' });
    expect(error.stageFailures).toEqual([
      { stage: 'classify', cause: classifierFailure, requestAttempt: 1 },
    ]);
  });

  it.each([
    ['before', 'before-hook-failed', 'before-hook'] as const,
    ['after', 'after-hook-failed', 'after-hook'] as const,
  ])('wraps a %s hook failure and records its stage', async (hook, reason, stage) => {
    const providerError = new Error('provider failed');
    const hookFailure = new Error(`${hook} failed`);
    const model = createModel(async () => {
      throw providerError;
    });

    const error = await captureRecoveryError(
      runRecovery(model, {
        beforeListeners:
          hook === 'before'
            ? [
                () => {
                  throw hookFailure;
                },
              ]
            : [],
        afterListeners:
          hook === 'after'
            ? [
                () => {
                  throw hookFailure;
                },
              ]
            : [],
      }),
    );

    expect(error.terminalCause).toBe(hookFailure);
    expect(error.terminalReason).toBe(reason);
    expect(error.stageFailures).toEqual([{ stage, cause: hookFailure, requestAttempt: 1 }]);
  });
});

describe('bounded decision trace and terminal error fields', () => {
  it('retains only the most recent 64 decisions and exposes immutable terminal state', async () => {
    const causes = Array.from({ length: 25 }, (_, index) => new Error(`trace-${index + 1}`));
    let call = 0;
    const model = createModel(async () => {
      throw causes[call++]!;
    });

    const error = await captureRecoveryError(
      runRecovery(model, {
        limits: resolveModelErrorRecoveryLimits({ unhandledRetryLimit: 0 }),
        afterListeners: [(event) => (event.requestAttempt < 25 ? 'retry' : 'stop')],
      }),
    );

    expect(error.name).toBe('ModelErrorRecoveryError');
    expect(error.message).toBe('Model error recovery stopped: stopped.');
    expect(error.initialError).toBe(causes[0]);
    expect(error.terminalCause).toBe(causes[24]);
    expect(error.cause).toBe(causes[24]);
    expect(error.lastDescriptor).toEqual({ kind: 'unknown', message: 'trace-25' });
    expect(error.terminalReason).toBe('stopped');
    expect(error.ledger).toEqual({
      requestAttempts: 25,
      totalRetries: 24,
      forcedRetries: 24,
      unhandledRetries: 0,
      contextRecoveryAttempts: 0,
    });
    expect(error.stageFailures).toEqual([]);
    expect(error.decisionTrace).toHaveLength(MODEL_ERROR_RECOVERY_TRACE_LIMIT);
    expect(error.droppedDecisionTraceCount).toBe(36);
    expect(error.decisionTrace[0]).toMatchObject({ stage: 'before', requestAttempt: 10 });
    expect(error.decisionTrace.at(-1)).toEqual({
      stage: 'terminal',
      requestAttempt: 25,
      decision: 'stopped',
      action: 'stop',
    });
    expect(Object.isFrozen(error.lastDescriptor)).toBe(true);
    expect(Object.isFrozen(error.ledger)).toBe(true);
    expect(Object.isFrozen(error.stageFailures)).toBe(true);
    expect(Object.isFrozen(error.decisionTrace)).toBe(true);
    expect(error.decisionTrace.every(Object.isFrozen)).toBe(true);
  });
});
