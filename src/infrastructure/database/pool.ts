import pg from 'pg';
import { getEnv } from '../../config/env';

// Converte NUMERIC (ex.: round(...)) e BIGINT (count) em number: valores da POC cabem em double.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

type Pools = { app?: pg.Pool; readonly?: pg.Pool };

// Sobrevive ao hot reload do Next (módulos são reavaliados, globalThis não).
const pools: Pools = ((globalThis as { __commercePools?: Pools }).__commercePools ??= {});

/** Pool da aplicação: dono do schema, usado pelo domínio (escritas via casos de uso). */
export function getAppPool(): pg.Pool {
  return (pools.app ??= new pg.Pool({ connectionString: getEnv().DATABASE_URL, max: 10 }));
}

/** Pool do agente: role agent_readonly, SELECT apenas. Ver ADR 002. */
export function getReadonlyPool(): pg.Pool {
  return (pools.readonly ??= new pg.Pool({ connectionString: getEnv().READONLY_DATABASE_URL, max: 5 }));
}

export async function closePools(): Promise<void> {
  await Promise.all([pools.app?.end(), pools.readonly?.end()]);
  pools.app = undefined;
  pools.readonly = undefined;
}

/** Executa `fn` numa transação; commit em sucesso, rollback em erro. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
