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

    const run = await mastra.getWorkflow(LATE_ORDER_WORKFLOW_ID).createRun({ runId });
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
      error: result.status === 'failed' ? String(result.error) : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
