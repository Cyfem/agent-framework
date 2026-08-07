import {
  SubAgentRuntimeError,
  SubAgentTargetRunnerRegistry,
  type JsonValue,
  type SubAgentChildRunRequest,
  type SubAgentChildRunner,
  type SubAgentExecutionRequest,
  type SubAgentTargetRunnerFactoryContext,
  type SubAgentTargetRunnerRegistration,
  type SubAgentTargetRunnerRegistrationEntry,
} from '@ruixutong.manee/maneeagent-framework';

/** @deprecated Prefer the protocol-neutral Core target-runner factory context. */
export type LocalSubAgentRunnerFactoryContext<
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> = SubAgentTargetRunnerFactoryContext<I, O>;

/** Local compatibility name for a full trusted Core definition/runner registration. */
export type LocalSubAgentRunnerRegistration<
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> = JsonValue extends I
  ? SubAgentTargetRunnerRegistrationEntry
  : SubAgentTargetRunnerRegistration<I, O>;

/**
 * Compatibility facade over Core's exact target-side registry. New Executor code should call
 * `prepareExecution()` so schema transforms, binding/checkpoint checks and owned snapshots all
 * happen before a runner factory is invoked.
 */
export class LocalSubAgentRunnerRegistry extends SubAgentTargetRunnerRegistry {
  constructor(registrations: readonly SubAgentTargetRunnerRegistrationEntry[] = []) {
    super(registrations);
  }

  /**
   * Legacy direct child-runner creation retained for Local consumers. MemorySubAgentExecutor does
   * not use this shortcut; it always supplies the complete execution operation to
   * `prepareExecution()`.
   */
  async create(
    request: SubAgentChildRunRequest,
    executorName: string,
  ): Promise<SubAgentChildRunner> {
    if (request.checkpoint !== undefined) {
      throw new SubAgentRuntimeError({
        code: 'RECOVERY_UNSUPPORTED',
        message:
          'Direct Local runner creation cannot restore checkpoints; use a complete Executor resume request.',
        retryable: false,
      });
    }
    this.seal();
    const prepared = this.prepareExecution(toCreateExecutionRequest(request), executorName);
    return prepared.create();
  }
}

function toCreateExecutionRequest(request: SubAgentChildRunRequest): SubAgentExecutionRequest {
  return {
    operation: {
      type: 'create',
      operationId: `local-direct-create:${request.taskId}`,
      idempotencyKey: request.taskId,
    },
    ownerSessionId: request.ownerSessionId,
    runId: request.runId,
    taskId: request.taskId,
    ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
    subagentSessionId: request.subagentSessionId,
    path: request.path,
    attempt: request.attempt,
    executionEpoch: request.executionEpoch,
    executionFencingToken: request.executionFencingToken,
    definition: request.definition,
    input: request.input,
    projectedContext: request.projectedContext,
    delegation: request.delegation,
    limits: request.limits,
    signal: request.signal,
    deadlineAt: request.deadlineAt,
  };
}
