import type { AuditEntry, AuditOutcome } from '../audit/audit-entry';
import type { Repositories, UnitOfWork } from '../ports';
import type { ActionContext } from './action-context';
import { isDomainError } from './errors';

type Spec<I, R> = {
  capability: string;
  input: I;
  ctx: ActionContext;
  approvalRequired?: boolean;
  /** Executado dentro da transação. O registro de auditoria de sucesso entra no mesmo commit. */
  run: (repos: Repositories, meta: ApprovalMeta) => Promise<R>;
};

/** Preenchido pela ação quando ela valida uma aprovação, para constar na auditoria. */
export type ApprovalMeta = { approvedBy?: string; approvedAt?: Date };

/**
 * Executa uma Domain Action com trilha de auditoria:
 * - sucesso: mudança de estado e auditoria são atômicas (mesma transação);
 * - falha: a transação é desfeita e a tentativa é auditada separadamente com o motivo.
 */
export async function auditedAction<I, R>(uow: UnitOfWork, spec: Spec<I, R>): Promise<R> {
  const base = auditBase(spec);
  try {
    return await uow.transaction(async (repos) => {
      const meta: ApprovalMeta = {};
      const result = await spec.run(repos, meta);
      await repos.audit.record({ ...base, ...meta, outcome: 'success', result });
      return result;
    });
  } catch (error) {
    await uow.repos.audit.record({
      ...base,
      outcome: outcomeOf(error),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function auditBase<I, R>({ capability, input, ctx, approvalRequired }: Spec<I, R>): Omit<AuditEntry, 'outcome'> {
  return {
    actorId: ctx.actor.id,
    actorRole: ctx.actor.role,
    channel: ctx.channel,
    agentId: ctx.agentId,
    threadId: ctx.threadId,
    runId: ctx.runId,
    toolCallId: ctx.toolCallId,
    capability,
    kind: 'action',
    input,
    approvalRequired: approvalRequired ?? false,
  };
}

function outcomeOf(error: unknown): AuditOutcome {
  if (!isDomainError(error)) return 'error';
  return error.code === 'FORBIDDEN' || error.code === 'APPROVAL_REQUIRED' ? 'denied' : 'rejected';
}
