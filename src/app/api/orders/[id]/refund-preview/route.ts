import { NextResponse } from 'next/server';
import { errorResponse, parseId } from '@/app/_lib/http';
import { getCurrentActor } from '@/app/_lib/session';
import { previewRefund } from '@/domain/payments/refund-payment';
import { getDeps } from '@/infrastructure/app-services';

/** Usado pelo cartão de aprovação: o valor exibido é calculado no servidor, não pelo modelo. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const preview = await previewRefund(getDeps(), parseId((await params).id), await getCurrentActor());
    return NextResponse.json(preview);
  } catch (error) {
    return errorResponse(error);
  }
}
