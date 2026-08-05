import type { EncodedAgentProtocolCheckpoint } from './checkpoint';
import type { SubAgentDefinitionRef } from './definition';
import type { SubAgentExecutionControl } from './executor';
import type { JsonValue } from './json';
import type { ResolvedSubAgentLimits } from './limits';
import type { SubAgentExecutionOutcome } from './result';

/** Protocol-neutral input from an Executor into a newly isolated child Agent. */
export interface SubAgentChildRunRequest<I extends JsonValue = JsonValue> {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly subagentSessionId: string;
  readonly path: readonly string[];
  readonly attempt: number;
  readonly definition: SubAgentDefinitionRef;
  readonly input: I;
  readonly projectedContext: readonly JsonValue[];
  readonly limits: ResolvedSubAgentLimits;
  readonly checkpoint?: EncodedAgentProtocolCheckpoint;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

/** Core-owned completion and control SPI consumed by concrete child runners. */
export interface SubAgentChildRunner {
  run(
    request: SubAgentChildRunRequest,
    control: SubAgentExecutionControl,
  ): Promise<SubAgentExecutionOutcome>;
}
