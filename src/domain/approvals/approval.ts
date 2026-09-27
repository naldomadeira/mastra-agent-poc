import { can, type Actor, type Permission } from '../operators/operator';
import type { Repositories } from '../ports';
import { DomainError } from '../shared/errors';

/** Decisão humana registrada pelo servidor quando o operador clica Aprovar/Rejeitar. */
export type ApprovalDecision = {
  toolCallId: string;
  runId: string;
  threadId?: string;
  capability: string;
  input: unknown;
  approved: boolean;
  approverId: string;
  reason?: string;
};

export type StoredApproval = ApprovalDecision & { decidedAt: Date; consumedAt: Date | null };

/** JSON canônico (chaves ordenadas) para comparar os argumentos aprovados com os executados. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Exige e CONSOME a evidência de aprovação de uma tool call: existe, foi aprovada, é para esta
 * capability e exatamente estes argumentos, não foi usada antes, e o aprovador tem a permissão.
 * Deve rodar dentro da transação da ação (o consumo é desfeito se a ação falhar).
 */
export async function consumeApproval(
  repos: Repositories,
  spec: { toolCallId: string | undefined; capability: string; input: unknown; permission: Permission; now: Date },
): Promise<Actor> {
  const missing = new DomainError(
    'APPROVAL_REQUIRED',
    'Esta ação exige aprovação humana registrada para esta solicitação.',
  );
  if (!spec.toolCallId) throw missing;

  const approval = await repos.approvals.findByToolCallId(spec.toolCallId);
  if (!approval) throw missing;
  if (!approval.approved) throw new DomainError('APPROVAL_REQUIRED', 'A solicitação foi rejeitada pelo aprovador.');
  if (approval.capability !== spec.capability || canonicalJson(approval.input) !== canonicalJson(spec.input)) {
    throw new DomainError('APPROVAL_REQUIRED', 'A aprovação registrada não corresponde a esta ação e seus argumentos.');
  }

  const approver = await repos.operators.findById(approval.approverId);
  if (!approver || !can(approver, spec.permission)) {
    throw new DomainError('FORBIDDEN', `${approver?.name ?? approval.approverId} não pode aprovar esta ação.`);
  }
  if (!(await repos.approvals.markConsumed(spec.toolCallId, spec.now))) {
    throw new DomainError('APPROVAL_REQUIRED', 'Esta aprovação já foi utilizada.');
  }
  return approver;
}
