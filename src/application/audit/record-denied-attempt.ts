import type { Actor } from '../../domain/operators/operator';
import type { UnitOfWork } from '../../domain/ports';
import type { Channel } from '../../domain/shared/action-context';

export type DeniedAttempt = {
  actor: Actor;
  channel: Channel;
  /** Ação tentada, ex.: "lateOrderNotificationWorkflow.approval" */
  capability: string;
  /** Código estável do motivo, ex.: ALREADY_DECIDED, FORBIDDEN, NOT_FOUND */
  code: string;
  reason: string;
  input?: unknown;
  runId?: string;
  approvalId?: string;
  threadId?: string;
  agentId?: string;
  toolCallId?: string;
  requestedBy?: string;
  correlationId?: string;
};

/**
 * Registra uma tentativa recusada pelo backend ANTES de qualquer efeito.
 * Só escreve em audit_log: não toca em aprovações, runs ou dados de negócio.
 */
export async function recordDeniedAttempt(uow: UnitOfWork, a: DeniedAttempt): Promise<void> {
  await uow.repos.audit.record({
    actorId: a.actor.id,
    actorRole: a.actor.role,
    channel: a.channel,
    agentId: a.agentId,
    threadId: a.threadId,
    runId: a.runId,
    toolCallId: a.toolCallId,
    capability: a.capability,
    kind: 'action',
    input: a.input ?? {},
    outcome: 'denied',
    error: `${a.code}: ${a.reason}`,
    approvalRequired: true,
    approvalId: a.approvalId,
    requestedBy: a.requestedBy,
    correlationId: a.correlationId,
  });
}
