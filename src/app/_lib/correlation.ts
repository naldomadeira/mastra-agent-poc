const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Usa o x-request-id recebido (se bem formado) ou gera um novo. */
export function correlationIdOf(req: Request): string {
  const incoming = req.headers.get('x-request-id');
  return incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
}
