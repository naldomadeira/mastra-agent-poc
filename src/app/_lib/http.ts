import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { isDomainError, type DomainErrorCode } from '@/domain/shared/errors';

const STATUS: Record<DomainErrorCode, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  APPROVAL_REQUIRED: 403,
  INVALID_STATE: 409,
  RULE_VIOLATION: 409,
  VALIDATION: 400,
};

/** Erros de domínio viram respostas previsíveis; erros inesperados não vazam detalhes. */
export function errorResponse(error: unknown): NextResponse {
  if (isDomainError(error)) {
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: STATUS[error.code] });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: { code: 'VALIDATION', message: 'Entrada inválida', issues: error.issues } },
      { status: 400 },
    );
  }
  console.error(error);
  return NextResponse.json({ error: { code: 'INTERNAL', message: 'Erro interno' } }, { status: 500 });
}

export function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0)
    throw new ZodError([{ code: 'custom', path: ['id'], message: 'id inválido', input: raw }]);
  return id;
}
