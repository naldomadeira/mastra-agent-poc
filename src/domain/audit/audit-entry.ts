import type { Channel } from '../shared/action-context';

export type AuditOutcome = 'success' | 'rejected' | 'denied' | 'error';

export type AuditEntry = {
  actorId: string;
  actorRole: string;
  channel: Channel;
  agentId?: string;
  threadId?: string;
  runId?: string;
  toolCallId?: string;
  capability: string;
  kind: 'read' | 'action';
  input: unknown;
  outcome: AuditOutcome;
  result?: unknown;
  error?: string;
  approvalRequired?: boolean;
  approvedBy?: string;
  approvedAt?: Date;
};
