import { getAppPool, getReadonlyPool } from './pool';

export type HealthReport = {
  status: 'ok' | 'degraded';
  checks: Record<string, { ok: boolean; detail?: string }>;
};

/** Verifica as duas conexões (app e readonly) e se as migrations foram aplicadas. */
export async function checkHealth(): Promise<HealthReport> {
  const checks: HealthReport['checks'] = {};

  await probe(checks, 'database', async () => {
    const { rows } = await getAppPool().query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
    return `${rows[0].n} migrations aplicadas`;
  });
  await probe(checks, 'readonlyRole', async () => {
    const { rows } = await getReadonlyPool().query<{ ro: string }>(
      "SELECT current_setting('transaction_read_only') AS ro",
    );
    if (rows[0].ro !== 'on') throw new Error('conexão do agente NÃO está em modo read-only');
    return 'agent_readonly em modo read-only';
  });

  const status = Object.values(checks).every((c) => c.ok) ? 'ok' : 'degraded';
  return { status, checks };
}

async function probe(checks: HealthReport['checks'], name: string, fn: () => Promise<string>) {
  try {
    checks[name] = { ok: true, detail: await fn() };
  } catch (error) {
    checks[name] = { ok: false, detail: (error as Error).message };
  }
}
