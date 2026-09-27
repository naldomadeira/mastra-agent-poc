import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/app/_lib/http';
import { getCurrentActor, OPERATOR_COOKIE } from '@/app/_lib/session';
import { permissionsOf } from '@/domain/operators/operator';
import { getDeps } from '@/infrastructure/app-services';

export async function GET() {
  try {
    const actor = await getCurrentActor();
    const operators = await getDeps().uow.repos.operators.list();
    return NextResponse.json({ actor, permissions: permissionsOf(actor.role), operators });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { operatorId } = z.object({ operatorId: z.string().min(1) }).parse(await req.json());
    const actor = await getDeps().uow.repos.operators.findById(operatorId);
    if (!actor)
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Operador não existe' } }, { status: 404 });
    (await cookies()).set(OPERATOR_COOKIE, actor.id, { httpOnly: true, sameSite: 'lax', path: '/' });
    return NextResponse.json({ actor });
  } catch (error) {
    return errorResponse(error);
  }
}
