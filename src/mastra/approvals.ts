import { recordDeniedAttempt } from '../application/audit/record-denied-attempt';
import type { Actor } from '../domain/operators/operator';
import type { Deps } from '../domain/ports';
import { COMMERCE_AGENT_ID } from './request-context';

// Mesmo separador que @mastra/ai-sdk usa para codificar o approvalId (não exportado publicamente).
const APPROVAL_ID_SEPARATOR = '::';

/** Decisão humana sobre uma tool call pausada, extraída da mensagem enviada pela UI. */
export type ApprovalDecision = {
  runId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  approved: boolean;
  reason?: string;
};

type UIPartLike = {
  type?: string;
  state?: string;
  toolCallId?: string;
  input?: unknown;
  approval?: { id?: string; approved?: boolean; reason?: string };
};

/**
 * Lê as respostas de aprovação (AI SDK v7, estado `approval-responded`) da última mensagem.
 * O approvalId gerado pelo @mastra/ai-sdk codifica `runId::toolCallId`.
 */
export function extractApprovalDecisions(
  message: { role?: string; parts?: unknown[] } | undefined,
): ApprovalDecision[] {
  if (message?.role !== 'assistant' || !Array.isArray(message.parts)) return [];
  return (message.parts as UIPartLike[]).flatMap((part) => {
    if (!part.type?.startsWith('tool-') || part.state !== 'approval-responded') return [];
    const { id, approved, reason } = part.approval ?? {};
    if (!id || typeof approved !== 'boolean') return [];
    const [runId, toolCallId] = id.split(APPROVAL_ID_SEPARATOR);
    if (!runId || !toolCallId) return [];
    return [{ runId, toolCallId, toolName: part.type.slice('tool-'.length), input: part.input, approved, reason }];
  });
}

/**
 * Persiste as decisões de Aprovar/Rejeitar vindas da UI, com o operador da sessão como aprovador.
 * - primeira decisão por tool call vence; repetição → auditoria `denied` (ALREADY_DECIDED),
 *   sem alterar a decisão existente nem o estado de consumo;
 * - rejeição → auditoria `rejected`;
 * - aprovação → auditada pela própria Domain Action quando executar (com approval_id).
 */
export async function recordAgentApprovalDecisions(
  deps: Deps,
  decisions: ApprovalDecision[],
  ctx: { actor: Actor; threadId: string; correlationId?: string },
): Promise<void> {
  const { actor, threadId, correlationId } = ctx;
  for (const d of decisions) {
    const inserted = await deps.uow.repos.approvals.record(
      {
        toolCallId: d.toolCallId,
        runId: d.runId,
        threadId,
        capability: d.toolName,
        input: d.input,
        approved: d.approved,
        approverId: actor.id,
        reason: d.reason,
      },
      deps.now(),
    );
    const common = {
      actor,
      channel: 'agent' as const,
      agentId: COMMERCE_AGENT_ID,
      threadId,
      runId: d.runId,
      toolCallId: d.toolCallId,
      approvalId: d.toolCallId,
      correlationId,
    };
    if (!inserted) {
      await recordDeniedAttempt(deps.uow, {
        ...common,
        capability: `${d.toolName}.approval`,
        code: 'ALREADY_DECIDED',
        reason: 'Já existe uma decisão registrada para esta solicitação.',
        input: { approved: d.approved },
      });
      continue;
    }
    if (d.approved) continue;
    await deps.uow.repos.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      channel: 'agent',
      agentId: COMMERCE_AGENT_ID,
      threadId,
      runId: d.runId,
      toolCallId: d.toolCallId,
      capability: d.toolName,
      kind: 'action',
      input: d.input ?? {},
      outcome: 'rejected',
      error: `Aprovação recusada por ${actor.name}${d.reason ? `: ${d.reason}` : ''}`,
      approvalRequired: true,
      approvalId: d.toolCallId,
      correlationId,
    });
  }
}
