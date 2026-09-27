import { NextResponse } from 'next/server';
import { z } from 'zod';
import { correlationIdOf } from '@/app/_lib/correlation';
import { errorResponse } from '@/app/_lib/http';
import { getCurrentActor } from '@/app/_lib/session';
import { getDeps } from '@/infrastructure/app-services';
import { mastra } from '@/mastra';
import { decideLateOrderNotifications, runView } from '@/mastra/workflows/late-order-decision';
import { LATE_ORDER_WORKFLOW_ID } from '@/mastra/workflows/late-order-notifications';

/**
 * Decisão humana sobre o envio em lote. O aprovador é o operador da sessão (servidor),
 * nunca um campo do corpo. Regras, ordem causal e auditoria em decideLateOrderNotifications.
 */
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const correlationId = correlationIdOf(req);
  const headers = { 'x-request-id': correlationId };
  try {
    const actor = await getCurrentActor();
    const { runId } = await params;
    const { approved } = z.object({ approved: z.boolean() }).parse(await req.json());

    const outcome = await decideLateOrderNotifications(mastra, getDeps(), { runId, approved, actor, correlationId });
    if (outcome.kind === 'denied') {
      return NextResponse.json(
        { error: { code: outcome.code, message: outcome.message }, ...outcome.run },
        { status: outcome.httpStatus, headers },
      );
    }
    return NextResponse.json(outcome.run, { headers });
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
