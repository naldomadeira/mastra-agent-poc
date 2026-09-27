import { NextResponse } from 'next/server';
import { errorResponse, parseId } from '@/app/_lib/http';
import { getCurrentActor } from '@/app/_lib/session';
import { assertCan } from '@/domain/operators/operator';
import { DomainError } from '@/domain/shared/errors';
import { getDeps } from '@/infrastructure/app-services';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertCan(await getCurrentActor(), 'data:read');
    const id = parseId((await params).id);
    const order = await getDeps().uow.repos.orders.findById(id);
    if (!order) throw new DomainError('NOT_FOUND', `Pedido #${id} não existe.`);
    return NextResponse.json({ order });
  } catch (error) {
    return errorResponse(error);
  }
}
