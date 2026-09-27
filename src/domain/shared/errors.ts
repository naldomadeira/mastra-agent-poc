export type DomainErrorCode =
  'NOT_FOUND' | 'INVALID_STATE' | 'RULE_VIOLATION' | 'FORBIDDEN' | 'APPROVAL_REQUIRED' | 'VALIDATION';

/** Erro esperado de regra de negócio. A mensagem é segura para mostrar ao usuário e ao modelo. */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const isDomainError = (error: unknown): error is DomainError => error instanceof DomainError;
