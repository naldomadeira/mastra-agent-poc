import { describe, expect, it } from 'vitest';
import { guardReadOnlySql } from '../../src/application/knowledge/sql-guard';

const ok = (sql: string) => expect(guardReadOnlySql(sql), sql).toMatchObject({ ok: true });
const blocked = (sql: string) => expect(guardReadOnlySql(sql), sql).toMatchObject({ ok: false });

describe('guardReadOnlySql', () => {
  it('aceita SELECT, WITH, subconsultas e ; final', () => {
    ok('SELECT count(*) FROM orders');
    ok('select * from order_overview where status = $$paid$$;');
    ok('WITH t AS (SELECT 1 AS x) SELECT x FROM t');
    ok('(SELECT 1)');
    ok("SELECT 'DROP TABLE orders; DELETE' AS texto_inofensivo");
    ok('SELECT 1 -- delete from orders');
    ok('SELECT "update" FROM (SELECT 1 AS "update") q');
  });

  it.each([
    'DELETE FROM orders',
    'UPDATE orders SET status = $$paid$$',
    'INSERT INTO orders DEFAULT VALUES',
    'DROP TABLE orders',
    'ALTER TABLE orders ADD COLUMN x int',
    'TRUNCATE orders',
    'SELECT 1; DELETE FROM orders',
    'SELECT 1; SELECT 2',
    'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d',
    'SELECT * INTO copia FROM orders',
    'SELECT * FROM orders FOR UPDATE',
    'SELECT pg_sleep(10)',
    "SELECT set_config('role', 'commerce', false)",
    "SELECT pg_read_file('/etc/passwd')",
    'SELECT * FROM pg_catalog.pg_roles',
    'SELECT * FROM information_schema.tables',
    'EXPLAIN ANALYZE DELETE FROM orders',
    'SET ROLE commerce',
    '/* x */ COPY orders TO STDOUT',
    'SELECT 1 /* não fechado',
    "SELECT 'não fechada",
    '',
  ])('bloqueia: %s', (sql) => blocked(sql));

  it('mensagem de erro é útil para o modelo se corrigir', () => {
    expect(guardReadOnlySql('DELETE FROM orders')).toEqual({
      ok: false,
      reason: 'Somente consultas SELECT (ou WITH ... SELECT) são permitidas.',
    });
  });
});
