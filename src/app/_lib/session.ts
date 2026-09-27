import { cookies } from 'next/headers';
import type { Actor } from '@/domain/operators/operator';
import { getDeps } from '@/infrastructure/app-services';

export const OPERATOR_COOKIE = 'poc_operator';
const DEFAULT_OPERATOR = 'ana';

/**
 * Sessão de DEMONSTRAÇÃO: o operador vem de um cookie escolhido na UI.
 * Em produção isto seria a sessão autenticada (NextAuth, Clerk, SSO...). O ponto arquitetural
 * se mantém: o ator é resolvido no servidor e validado contra o banco — nunca vem do modelo.
 */
export async function getCurrentActor(): Promise<Actor> {
  const id = (await cookies()).get(OPERATOR_COOKIE)?.value ?? DEFAULT_OPERATOR;
  const actor = await getDeps().uow.repos.operators.findById(id);
  if (!actor) throw new Error(`Operador de sessão inválido: ${id}`);
  return actor;
}
