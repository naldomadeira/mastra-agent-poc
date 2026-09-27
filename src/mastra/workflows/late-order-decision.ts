import type { Mastra } from '@mastra/core/mastra';
import { recordDeniedAttempt } from '../../application/audit/record-denied-attempt';
import { can, type Actor } from '../../domain/operators/operator';
import type { Deps } from '../../domain/ports';
import { LATE_ORDER_WORKFLOW_ID, workflowApprovalId } from './late-order-notifications';

export type RunView = { status: string; result: unknown; failure: string | null };

export type DecisionOutcome =
  | { kind: 'decided'; approvalId: string; run: RunView }
  | {
      kind: 'denied';
      code: 'NOT_FOUND' | 'ALREADY_DECIDED' | 'FORBIDDEN';
      message: string;
      httpStatus: 403 | 404 | 409;
      run?: RunView;
    };

type WorkflowState = NonNullable<Awaited<ReturnType<ReturnType<Mastra['getWorkflow']>['getWorkflowRunById']>>>;

const DECISION_CAPABILITY = `${LATE_ORDER_WORKFLOW_ID}.approval`;

/**
 * Decisão humana sobre o envio em lote. Ordem causal garantida:
 *
 *   verificar run → verificar permissão → persistir decisão (primeira vence)
 *   → auditar decisão → retomar workflow → (envios auditados com a mesma approval_id)
 *
 * Toda recusa é auditada como `denied` e não altera aprovação, run ou dados de negócio.
 */
export async function decideLateOrderNotifications(
  mastra: Mastra,
  deps: Deps,
  input: { runId: string; approved: boolean; actor: Actor; correlationId?: string },
): Promise<DecisionOutcome> {
  const { runId, approved, actor, correlationId } = input;
  const workflow = mastra.getWorkflow(LATE_ORDER_WORKFLOW_ID);
  const approvalId = workflowApprovalId(runId);
  const current = await workflow.getWorkflowRunById(runId);
  const requestedBy = current ? requesterOf(current) : undefined;

  const deny = async (
    code: 'NOT_FOUND' | 'ALREADY_DECIDED' | 'FORBIDDEN',
    message: string,
    httpStatus: 403 | 404 | 409,
  ): Promise<DecisionOutcome> => {
    await recordDeniedAttempt(deps.uow, {
      actor,
      channel: 'workflow',
      capability: DECISION_CAPABILITY,
      code,
      reason: message,
      input: { approved },
      runId,
      approvalId,
      requestedBy,
      correlationId,
    });
    return { kind: 'denied', code, message, httpStatus, run: current ? runView(current) : undefined };
  };

  if (!current) return deny('NOT_FOUND', 'Execução não encontrada.', 404);
  if (current.status !== 'suspended') {
    return deny('ALREADY_DECIDED', `Esta execução já foi decidida (status: ${current.status}).`, 409);
  }
  if (!can(actor, 'notifications:send')) {
    return deny('FORBIDDEN', `${actor.name} (${actor.role}) não pode decidir envios em lote.`, 403);
  }

  // A primeira decisão registrada vence (chave única). Duplo clique ou requisições
  // concorrentes chegam aqui e são recusadas sem alterar a decisão existente.
  const inserted = await deps.uow.repos.approvals.record(
    {
      toolCallId: approvalId,
      runId,
      capability: LATE_ORDER_WORKFLOW_ID,
      input: { runId },
      approved,
      approverId: actor.id,
    },
    deps.now(),
  );
  if (!inserted) return deny('ALREADY_DECIDED', 'Já existe uma decisão registrada para esta execução.', 409);
  const decision = await deps.uow.repos.approvals.findByToolCallId(approvalId);

  // Auditoria da decisão ANTES da retomada: precede causalmente os envios.
  await deps.uow.repos.audit.record({
    actorId: actor.id,
    actorRole: actor.role,
    channel: 'workflow',
    runId,
    capability: DECISION_CAPABILITY,
    kind: 'action',
    input: { approved },
    outcome: approved ? 'success' : 'rejected',
    error: approved ? undefined : `Envio rejeitado por ${actor.name}`,
    approvalRequired: true,
    approvedBy: approved ? actor.id : undefined,
    approvedAt: approved ? decision?.decidedAt : undefined,
    approvalId,
    requestedBy,
    correlationId,
  });

  const result = await workflow
    .createRun({ runId })
    .then((run) =>
      run.resume({ step: 'request-approval', resumeData: { approved, approverId: actor.id, approvalId } }),
    );

  if (result.status === 'failed') {
    await deps.uow.repos.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      channel: 'workflow',
      runId,
      capability: `${LATE_ORDER_WORKFLOW_ID}.run`,
      kind: 'action',
      input: { approved },
      outcome: 'error',
      error: String(result.error),
      approvalRequired: true,
      approvalId,
      requestedBy,
      correlationId,
    });
  }
  return { kind: 'decided', approvalId, run: runView(result) };
}

export function runView(state: { status: string; result?: unknown; error?: unknown }): RunView {
  return {
    status: state.status,
    result: state.status === 'success' ? (state.result ?? null) : null,
    failure: state.status === 'failed' ? String(state.error) : null,
  };
}

/**
 * Solicitante do run: enquanto suspenso vem do suspendPayload; depois de concluído, do estado
 * do workflow ou do resultado final (o Mastra não mantém o suspendPayload após a retomada).
 */
function requesterOf(state: WorkflowState): string | undefined {
  const s = state as {
    steps?: Record<string, { suspendPayload?: { requestedBy?: string } }>;
    state?: { requestedBy?: string };
    result?: { requestedBy?: string | null };
  };
  return (
    s.steps?.['request-approval']?.suspendPayload?.requestedBy ??
    s.state?.requestedBy ??
    s.result?.requestedBy ??
    undefined
  );
}
