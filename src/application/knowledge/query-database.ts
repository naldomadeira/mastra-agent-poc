import type pg from 'pg';
import { z } from 'zod';
import type { AuditOutcome } from '../../domain/audit/audit-entry';
import { assertCan } from '../../domain/operators/operator';
import type { Deps } from '../../domain/ports';
import type { ActionContext } from '../../domain/shared/action-context';
import { isDomainError } from '../../domain/shared/errors';
import { guardReadOnlySql, MAX_SQL_LENGTH } from './sql-guard';

export const QueryDatabaseInput = z.object({
  sql: z
    .string()
    .min(1)
    .max(MAX_SQL_LENGTH)
    .describe('Uma única consulta SELECT (Postgres) sobre as tabelas/views do schema'),
  purpose: z
    .string()
    .max(300)
    .optional()
    .describe('Pergunta de negócio que a consulta responde (vai para a auditoria)'),
});
export type QueryDatabaseInput = z.infer<typeof QueryDatabaseInput>;

export type QueryDatabaseResult =
  | {
      ok: true;
      columns: string[];
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
      durationMs: number;
    }
  | { ok: false; error: string };

export type ReadLimits = { timeoutMs: number; maxRows: number; timezone: string };

export type ReadDeps = Deps & { readonlyPool: pg.Pool; limits: ReadLimits };

const TIMEZONE = /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/;

/**
 * Capability genérica de LEITURA. Nunca lança para erros esperados: devolve `{ ok: false, error }`
 * com mensagem que o modelo pode usar para corrigir a consulta. Toda execução é auditada.
 */
export async function queryDatabase(
  deps: ReadDeps,
  rawInput: QueryDatabaseInput,
  ctx: ActionContext,
): Promise<QueryDatabaseResult> {
  const input = QueryDatabaseInput.parse(rawInput);
  const started = Date.now();
  let outcome: AuditOutcome = 'success';
  let result: QueryDatabaseResult;

  try {
    assertCan(ctx.actor, 'data:read');
    const guard = guardReadOnlySql(input.sql);
    if (!guard.ok) {
      outcome = 'rejected';
      result = { ok: false, error: guard.reason };
    } else {
      result = await runReadOnly(deps, guard.sql, started);
    }
  } catch (error) {
    ({ outcome, result } = classify(error));
  }

  await deps.uow.repos.audit.record({
    actorId: ctx.actor.id,
    actorRole: ctx.actor.role,
    channel: ctx.channel,
    agentId: ctx.agentId,
    threadId: ctx.threadId,
    runId: ctx.runId,
    toolCallId: ctx.toolCallId,
    capability: 'queryDatabase',
    kind: 'read',
    input,
    outcome,
    // Auditoria guarda o formato do resultado, não os dados (evita duplicar informação sensível).
    result: result.ok
      ? { rowCount: result.rowCount, truncated: result.truncated, durationMs: result.durationMs }
      : undefined,
    error: result.ok ? undefined : result.error,
  });
  return result;
}

async function runReadOnly(deps: ReadDeps, sql: string, started: number): Promise<QueryDatabaseResult> {
  const { timeoutMs, maxRows, timezone } = deps.limits;
  if (!TIMEZONE.test(timezone)) throw new Error(`Timezone inválido: ${timezone}`);

  const client = await deps.readonlyPool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);
    await client.query(`SET LOCAL TIME ZONE '${timezone}'`);
    // Cursor preserva a ordenação da consulta e limita as linhas sem reescrever o SQL.
    await client.query(`DECLARE agent_query NO SCROLL CURSOR FOR ${sql}`);
    const res = await client.query(`FETCH ${maxRows + 1} FROM agent_query`);
    const truncated = res.rows.length > maxRows;
    const rows = res.rows.slice(0, maxRows).map(serializeRow);
    return {
      ok: true,
      columns: res.fields.map((f) => f.name),
      rows,
      rowCount: rows.length,
      truncated,
      durationMs: Date.now() - started,
    };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const serializeRow = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));

type PgError = Error & { code?: string };

/** Erros do Postgres viram mensagens úteis ao modelo; permissões negadas são auditadas como `denied`. */
function classify(error: unknown): { outcome: AuditOutcome; result: QueryDatabaseResult } {
  if (isDomainError(error)) return { outcome: 'denied', result: { ok: false, error: error.message } };
  const pgError = error as PgError;
  switch (pgError.code) {
    case '42501':
      return {
        outcome: 'denied',
        result: { ok: false, error: `Acesso negado: ${pgError.message}. Consulte inspectSchema.` },
      };
    case '57014':
      return {
        outcome: 'error',
        result: { ok: false, error: 'Consulta excedeu o tempo limite; simplifique ou agregue.' },
      };
    case '25006':
      return { outcome: 'denied', result: { ok: false, error: 'Somente leitura: a transação é READ ONLY.' } };
  }
  if (pgError.code?.startsWith('42') || pgError.code?.startsWith('22')) {
    // Erros de sintaxe/semântica/dados: a mensagem do Postgres ajuda o modelo a se corrigir.
    return { outcome: 'rejected', result: { ok: false, error: `Erro na consulta: ${pgError.message}` } };
  }
  console.error('[queryDatabase] erro inesperado', error);
  return { outcome: 'error', result: { ok: false, error: 'Erro inesperado ao executar a consulta.' } };
}
