import type {
  AgentProtocol,
  AgentSubAgentRunOptions,
  AgentSubAgentRunOutcome,
  JsonValue,
  SubAgentChildRunRequest,
  SubAgentChildRunner,
  SubAgentDefinition,
  SubAgentExecutionControl,
  UserMessageOf,
} from '@ruixutong.manee/maneeagent-framework';
import { canonicalJsonSha256 } from '@ruixutong.manee/maneeagent-framework';

import type {
  LocalSubAgentRunnerFactoryContext,
  LocalSubAgentRunnerRegistration,
} from './local-runner-registry';

/** Minimal public Agent bridge consumed by Local without accessing Agent internals. */
export interface LocalSubAgentAgent<P extends AgentProtocol> {
  runAsSubAgent(options: AgentSubAgentRunOptions<P>): Promise<AgentSubAgentRunOutcome>;
}

export interface LocalSubAgentAgentFactoryContext<I extends JsonValue, O extends JsonValue> {
  readonly request: SubAgentChildRunRequest<I>;
  readonly definition: SubAgentDefinition<I, O>;
}

/** Trusted definition-version registration for an isolated Core Agent child. */
export interface LocalSubAgentAgentRegistration<
  P extends AgentProtocol,
  I extends JsonValue,
  O extends JsonValue,
> {
  readonly definition: SubAgentDefinition<I, O>;
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly childCheckpointVersions?: readonly string[];
  /** Must return a fresh, not-yet-run Agent for every task execution or checkpoint reconstruction. */
  createAgent(
    context: LocalSubAgentAgentFactoryContext<I, O>,
  ): LocalSubAgentAgent<P> | Promise<LocalSubAgentAgent<P>>;
  /** Explicit protocol input mapping. Local never guesses by stringifying definition input. */
  buildInput(
    request: SubAgentChildRunRequest<I>,
    definition: SubAgentDefinition<I, O>,
  ): string | UserMessageOf<P>;
}

/**
 * Adapt a trusted Core Agent factory to Local's protocol-neutral child-runner registry. The
 * definition and output schema stay in the host registry and never cross the model-visible wire.
 */
export function createLocalAgentRunnerRegistration<
  P extends AgentProtocol,
  I extends JsonValue,
  O extends JsonValue,
>(registration: LocalSubAgentAgentRegistration<P, I, O>): LocalSubAgentRunnerRegistration {
  assertAgentRegistration(registration);
  const childCheckpointVersions = Object.freeze([
    ...(registration.childCheckpointVersions ?? ['1']),
  ]);
  const issuedAgents = new WeakSet<object>();

  return Object.freeze({
    definition: Object.freeze({
      name: registration.definition.name,
      version: registration.definition.version,
    }),
    runnerId: registration.runnerId,
    runnerVersion: registration.runnerVersion,
    childCheckpointVersions,
    create: async (context: LocalSubAgentRunnerFactoryContext): Promise<SubAgentChildRunner> => {
      const { request, executorName } = context;
      const capturedRequest = request as SubAgentChildRunRequest<I>;
      const agent = await registration.createAgent(
        Object.freeze({
          request: capturedRequest,
          definition: registration.definition,
        }),
      );
      assertAgentBridge(agent);
      if (issuedAgents.has(agent)) {
        throw new TypeError('A Local Agent factory must return a fresh Agent for every task.');
      }
      issuedAgents.add(agent);
      const input = registration.buildInput(capturedRequest, registration.definition);
      let previousRequest = capturedRequest;

      return Object.freeze({
        run: async (activeRequest: SubAgentChildRunRequest, control: SubAgentExecutionControl) => {
          assertSameExecution(capturedRequest, activeRequest);
          assertForwardExecution(previousRequest, activeRequest);
          previousRequest = activeRequest as SubAgentChildRunRequest<I>;
          const typedRequest = activeRequest as SubAgentChildRunRequest<I>;
          return agent.runAsSubAgent({
            request: typedRequest,
            control,
            runnerId: registration.runnerId,
            runnerVersion: registration.runnerVersion,
            executorName,
            checkpointMode: 'durable',
            input,
            outputSchema: registration.definition.outputSchema,
          });
        },
      });
    },
  });
}

function assertAgentRegistration<P extends AgentProtocol, I extends JsonValue, O extends JsonValue>(
  registration: LocalSubAgentAgentRegistration<P, I, O>,
): void {
  if (
    typeof registration !== 'object' ||
    registration === null ||
    typeof registration.definition?.name !== 'string' ||
    typeof registration.definition?.version !== 'string' ||
    typeof registration.definition?.outputSchema?.safeParse !== 'function' ||
    typeof registration.runnerId !== 'string' ||
    typeof registration.runnerVersion !== 'string' ||
    typeof registration.createAgent !== 'function' ||
    typeof registration.buildInput !== 'function'
  ) {
    throw new TypeError('A Local Agent registration is incomplete.');
  }
}

function assertAgentBridge<P extends AgentProtocol>(
  agent: LocalSubAgentAgent<P>,
): asserts agent is LocalSubAgentAgent<P> {
  if (typeof agent !== 'object' || agent === null || typeof agent.runAsSubAgent !== 'function') {
    throw new TypeError('A Local Agent factory must return a fresh Agent run bridge.');
  }
}

function assertSameExecution(
  captured: SubAgentChildRunRequest,
  active: SubAgentChildRunRequest,
): void {
  const matches =
    captured.ownerSessionId === active.ownerSessionId &&
    captured.runId === active.runId &&
    captured.taskId === active.taskId &&
    captured.parentTaskId === active.parentTaskId &&
    captured.subagentSessionId === active.subagentSessionId &&
    captured.definition.name === active.definition.name &&
    captured.definition.version === active.definition.version &&
    captured.path.length === active.path.length &&
    captured.path.every((part, index) => part === active.path[index]) &&
    sameJson(captured.input, active.input) &&
    sameJson(captured.projectedContext, active.projectedContext) &&
    sameDelegationScope(captured.delegation, active.delegation) &&
    sameStableLimits(captured.limits, active.limits);
  if (!matches) {
    throw new TypeError('A Local Agent runner cannot be rebound to another child execution.');
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonSha256(left as JsonValue) === canonicalJsonSha256(right as JsonValue);
}

function assertForwardExecution(
  previous: SubAgentChildRunRequest,
  active: SubAgentChildRunRequest,
): void {
  const previousFencing = parseFencingToken(previous.executionFencingToken);
  const activeFencing = parseFencingToken(active.executionFencingToken);
  const replay = active.attempt === previous.attempt;
  const forward =
    Number.isSafeInteger(active.attempt) &&
    active.attempt > previous.attempt &&
    active.executionEpoch !== previous.executionEpoch &&
    activeFencing > previousFencing &&
    Number.isSafeInteger(active.limits.timeoutMs) &&
    active.limits.timeoutMs > 0 &&
    active.limits.timeoutMs <= previous.limits.timeoutMs;
  if (
    !forward &&
    (!replay ||
      active.executionEpoch !== previous.executionEpoch ||
      active.executionFencingToken !== previous.executionFencingToken ||
      active.limits.timeoutMs !== previous.limits.timeoutMs)
  ) {
    throw new TypeError('A Local Agent runner rejected a stale or rebound execution operation.');
  }
}

function parseFencingToken(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError('A Local Agent execution requires a decimal fencing token.');
  }
  return BigInt(value);
}

function sameDelegationScope(
  captured: SubAgentChildRunRequest['delegation'],
  active: SubAgentChildRunRequest['delegation'],
): boolean {
  return (
    captured.version === active.version &&
    captured.ownerSessionId === active.ownerSessionId &&
    captured.runId === active.runId &&
    captured.parentTaskId === active.parentTaskId &&
    captured.depth === active.depth &&
    captured.path.length === active.path.length &&
    captured.path.every((part, index) => part === active.path[index])
  );
}

function sameStableLimits(
  captured: SubAgentChildRunRequest['limits'],
  active: SubAgentChildRunRequest['limits'],
): boolean {
  return (
    captured.maxDepth === active.maxDepth &&
    captured.maxDescendants === active.maxDescendants &&
    captured.maxConcurrent === active.maxConcurrent &&
    captured.maxTurns === active.maxTurns &&
    captured.maxProviderCalls === active.maxProviderCalls &&
    captured.maxInputTokens === active.maxInputTokens &&
    captured.maxOutputTokens === active.maxOutputTokens &&
    captured.maxCost === active.maxCost
  );
}
