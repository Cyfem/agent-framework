import type { AgentProtocol, AgentToolCall, ContextOf } from '../agent/types';
import type { ApprovalDecision, ApprovalRequest } from './approval';

/** Runtime identity, cancellation and deadline available to ordinary Tool handlers. */
export interface ToolRuntimeContext<P extends AgentProtocol = AgentProtocol> {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly call: AgentToolCall<P>;
  readonly signal: AbortSignal;
  readonly deadlineAt?: number;
}

export interface AgentRunOptions {
  readonly stream?: boolean;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

export interface AgentResumeOptions {
  readonly runId: string;
  readonly decisions?: readonly ApprovalDecision[];
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

export interface AgentRunError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly causeCode?: string;
}

/** Durable root Agent outcome. Pauses and runtime failures do not throw. */
export type AgentRunOutcome<P extends AgentProtocol> =
  | {
      readonly status: 'succeeded';
      readonly sessionId: string;
      readonly runId: string;
      readonly context: readonly ContextOf<P>[];
    }
  | {
      readonly status: 'waiting_approval';
      readonly sessionId: string;
      readonly runId: string;
      readonly checkpointRevision: number;
      readonly approvals: readonly ApprovalRequest[];
    }
  | {
      readonly status: 'cancelled' | 'failed';
      readonly sessionId: string;
      readonly runId: string;
      readonly error: AgentRunError;
      readonly context: readonly ContextOf<P>[];
    };
