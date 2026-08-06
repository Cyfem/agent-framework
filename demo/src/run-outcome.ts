import type { AgentProtocol, AgentRunOutcome, ContextOf } from '@manee/agent-framework';

/** Keep demo assertions explicit now that Agent.agent() returns a v2 lifecycle outcome. */
export function requireSucceededContext<P extends AgentProtocol>(
  outcome: AgentRunOutcome<P>,
  label = 'Agent',
): ContextOf<P>[] {
  if (outcome.status === 'succeeded') {
    return [...outcome.context];
  }

  if (outcome.status === 'waiting_approval') {
    throw new Error(
      `${label} paused for ${outcome.approvals.length} approval request(s); resumeRun() is required.`,
    );
  }

  throw new Error(`${label} ${outcome.status}: ${outcome.error.code}: ${outcome.error.message}`);
}
