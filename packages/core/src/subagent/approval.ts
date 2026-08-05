export interface ApprovalRequestInput {
  readonly callId: string;
  readonly toolName: string;
  /** Host-safe summary only; raw Tool arguments are intentionally excluded. */
  readonly summary: string;
  readonly expiresAt?: number;
}

export interface ApprovalRequest extends ApprovalRequestInput {
  readonly approvalId: string;
  readonly ownerSessionId: string;
  readonly taskId: string;
  readonly createdAt: number;
  readonly revision: number;
}

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reason?: string;
  readonly expectedRevision: number;
}

export type ApprovalDirective =
  | { readonly type: 'approved'; readonly approvalId: string }
  | {
      readonly type: 'suspend';
      readonly request: ApprovalRequest;
      readonly checkpointRevision: number;
    };
