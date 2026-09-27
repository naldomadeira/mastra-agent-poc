import { z } from 'zod';
import { isDomainError } from '../../../domain/shared/errors';

/**
 * Saída previsível de toda Domain Action exposta como tool:
 * sucesso → `{ ok: true, result }`; regra de negócio violada → `{ ok: false, code, error }`
 * (o modelo explica ao usuário). Erros inesperados propagam e aparecem como erro de tool.
 */
export const actionOutput = <T extends z.ZodType>(result: T) =>
  z.union([
    z.object({ ok: z.literal(true), result }),
    z.object({ ok: z.literal(false), code: z.string(), error: z.string() }),
  ]);

export async function runAction<T>(fn: () => Promise<T>) {
  try {
    return { ok: true as const, result: await fn() };
  } catch (error) {
    if (isDomainError(error)) return { ok: false as const, code: error.code, error: error.message };
    throw error;
  }
}
