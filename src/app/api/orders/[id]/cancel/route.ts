import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, parseId } from '@/app/_lib/http';
import { getCurrentActor } from '@/app/_lib/session';
import { cancelOrder } from '@/domain/orders/cancel-order';
import { getDeps } from '@/infrastructure/app-services';

/** Mesmo caso de uso que a tool do agente usa — canal diferente, zero duplicação. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const orderId = parseId((await params).id);
    const { reason } = z.object({ reason: z.string() }).parse(await req.json());
    const result = await cancelOrder(
      getDeps(),
      { orderId, reason },
      { actor: await getCurrentActor(), channel: 'http' },
    );
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
