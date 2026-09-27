import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/app/_lib/http';
import { getCurrentActor } from '@/app/_lib/session';
import { assertCan } from '@/domain/operators/operator';
import { getDeps } from '@/infrastructure/app-services';
import { mastra } from '@/mastra';
import { LATE_ORDER_WORKFLOW_ID } from '@/mastra/workflows/late-order-notifications';

/**
 * Decisão humana sobre o envio em lote. O aprovador é o operador da sessão (servidor),
 * nunca um campo do corpo. A autorização é verificada antes de retomar o workflow.
 */
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const actor = await getCurrentActor();
    const { runId } = await params;
    const { approved } = z.object({ approved: z.boolean() }).parse(await req.json());
    if (approved) assertCan(actor, 'notifications:send');

    const workflow = mastra.getWorkflow(LATE_ORDER_WORKFLOW_ID);
    // Decisão só vale para run ainda suspenso. Um cartão antigo (conversa reaberta) não pode
    // retomar de novo: responde 409 com o estado atual em vez de erro 500.
    const current = await workflow.getWorkflowRunById(runId);
    if (!current) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Execução não encontrada.' } }, { status: 404 });
    }
    if (current.status !== 'suspended') {
      return NextResponse.json(
        {
          error: { code: 'ALREADY_DECIDED', message: `Esta execução já foi decidida (status: ${current.status}).` },
          ...runView(current),
        },
        { status: 409 },
      );
    }

    const run = await workflow.createRun({ runId });
    const result = await run.resume({ step: 'request-approval', resumeData: { approved, approverId: actor.id } });

    await getDeps().uow.repos.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      channel: 'workflow',
      runId,
      capability: `${LATE_ORDER_WORKFLOW_ID}.approval`,
      kind: 'action',
      input: { approved },
      outcome: approved ? 'success' : 'rejected',
      result: result.status === 'success' ? result.result : { status: result.status },
      approvalRequired: true,
      approvedBy: approved ? actor.id : undefined,
      approvedAt: approved ? new Date() : undefined,
    });

    return NextResponse.json({
      status: result.status,
      result: result.status === 'success' ? result.result : null,
      failure: result.status === 'failed' ? String(result.error) : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Estado atual do run, para o cartão da UI não oferecer decisão sobre um run já concluído. */
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    await getCurrentActor();
    const { runId } = await params;
    const current = await mastra.getWorkflow(LATE_ORDER_WORKFLOW_ID).getWorkflowRunById(runId);
    if (!current) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Execução não encontrada.' } }, { status: 404 });
    }
    return NextResponse.json(runView(current));
  } catch (error) {
    return errorResponse(error);
  }
}

function runView(state: { status: string; result?: unknown; error?: unknown }) {
  return {
    status: state.status,
    result: state.status === 'success' ? (state.result ?? null) : null,
    failure: state.status === 'failed' ? String(state.error) : null,
  };
}
