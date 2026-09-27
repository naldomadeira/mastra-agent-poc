import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(process.cwd(), 'src/infrastructure/database/migrations');
export const READONLY_ROLE = 'agent_readonly';

export type MigrationResult = { applied: string[]; skipped: string[] };

/**
 * Aplica migrations SQL versionadas (NNNN_nome.sql) em ordem, cada uma numa transação,
 * registrando-as em schema_migrations. Antes disso garante a role readonly do agente,
 * com senha vinda de READONLY_DATABASE_URL (segredos não ficam nos arquivos SQL).
 */
export async function migrate(databaseUrl: string, readonlyDatabaseUrl: string): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await ensureReadonlyRole(client, readonlyDatabaseUrl);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    const result: MigrationResult = { applied: [], skipped: [] };

    for (const file of files) {
      if (done.has(file)) {
        result.skipped.push(file);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migration ${file}: ${(error as Error).message}`);
      }
    }
    return result;
  } finally {
    await client.end();
  }
}

async function ensureReadonlyRole(client: pg.Client, readonlyDatabaseUrl: string): Promise<void> {
  const url = new URL(readonlyDatabaseUrl);
  if (url.username !== READONLY_ROLE) {
    throw new Error(`READONLY_DATABASE_URL deve usar o usuário ${READONLY_ROLE} (recebido: ${url.username})`);
  }
  const password = decodeURIComponent(url.password);
  if (!password) throw new Error('READONLY_DATABASE_URL precisa de senha');

  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [READONLY_ROLE]);
  const verb = exists.rowCount ? 'ALTER' : 'CREATE';
  // Identificador fixo; senha escapada com format(%L) no servidor para evitar injeção.
  const { rows } = await client.query<{ stmt: string }>(
    `SELECT format('${verb} ROLE ${READONLY_ROLE} LOGIN PASSWORD %L', $1::text) AS stmt`,
    [password],
  );
  await client.query(rows[0].stmt);
  await client.query(`ALTER ROLE ${READONLY_ROLE} SET default_transaction_read_only = on`);
  await client.query(`ALTER ROLE ${READONLY_ROLE} SET statement_timeout = '10s'`);
}
