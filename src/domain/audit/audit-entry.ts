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
  /** Quem originou a solicitação (padrão: o próprio ator). */
  requestedBy?: string;
  /** Evidência em action_approvals que autorizou a execução. */
  approvalId?: string;
  /** Requisição de origem (x-request-id). */
  correlationId?: string;
};
