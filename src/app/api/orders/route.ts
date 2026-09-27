import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/app/_lib/http';
import { getCurrentActor } from '@/app/_lib/session';
import { assertCan } from '@/domain/operators/operator';
import { getDeps } from '@/infrastructure/app-services';

const Query = z.object({
  status: z.enum(['pending_payment', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']).optional(),
  customerId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const dynamic = 'force-dynamic';

/** API HTTP convencional (sem IA) sobre o mesmo domínio. */
export async function GET(req: Request) {
  try {
    assertCan(await getCurrentActor(), 'data:read');
    const query = Query.parse(Object.fromEntries(new URL(req.url).searchParams));
    return NextResponse.json({ orders: await getDeps().uow.repos.orders.list(query) });
  } catch (error) {
    return errorResponse(error);
  }
}
