import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectSchema } from '../../src/application/knowledge/inspect-schema';
import { queryDatabase, type ReadDeps } from '../../src/application/knowledge/query-database';
import { getReadDeps } from '../../src/application/knowledge/read-deps';
import { closePools, getReadonlyPool } from '../../src/infrastructure/database/pool';
import { queryDatabaseTool } from '../../src/mastra/tools/database/query-database';
import { createCommerceContext } from '../../src/mastra/request-context';
import { carla } from '../helpers/actors';
import { toolContext } from '../helpers/tool-context';
import { lastAudit, resetDatabase } from '../helpers/db';

const ctx = { actor: carla, channel: 'agent' as const };
const run = (sql: string, deps: ReadDeps = getReadDeps()) => queryDatabase(deps, { sql }, ctx);

describe('Database Agent Access (read-only)', () => {
  beforeAll(resetDatabase);
  afterAll(closePools);

  describe('perguntas de negócio', () => {
    it('quantos pedidos existem?', async () => {
      expect(await run('SELECT count(*)::int AS total FROM orders')).toMatchObject({ ok: true, rows: [{ total: 63 }] });
    });

    it('quais pedidos estão pendentes?', async () => {
      const r = await run(`SELECT order_id FROM order_overview WHERE status = 'pending_payment' ORDER BY order_id`);
      expect(r.ok && r.rows.map((x) => x.order_id)).toEqual(expect.arrayContaining([1001, 1006]));
    });

    it('qual cliente gastou mais?', async () => {
      const r = await run('SELECT customer_name FROM customer_spend ORDER BY total_spent_brl DESC LIMIT 1');
      expect(r).toMatchObject({ ok: true, rowCount: 1 });
    });

    it('quanto foi vendido este mês? (fuso da aplicação aplicado)', async () => {
      const r = await run(
        `SELECT round(sum(amount_cents)/100.0, 2) AS total_brl FROM payments
         WHERE status = 'captured' AND captured_at >= date_trunc('month', now())`,
      );
      expect(r.ok && typeof r.rows[0].total_brl).toBe('number');
    });

    it('quais pedidos estão atrasados? (definição vem da view)', async () => {
      const r = await run('SELECT order_id FROM order_overview WHERE is_late ORDER BY order_id');
      expect(r.ok && r.rows.map((x) => x.order_id)).toEqual([1002, 1005, 1008]);
    });
  });

  describe('limites e proteção', () => {
    it('trunca no limite de linhas e sinaliza', async () => {
      const deps = { ...getReadDeps(), limits: { ...getReadDeps().limits, maxRows: 5 } };
      expect(await run('SELECT id FROM orders ORDER BY id', deps)).toMatchObject({
        ok: true,
        rowCount: 5,
        truncated: true,
      });
    });

    it('aplica timeout', async () => {
      const deps = { ...getReadDeps(), limits: { ...getReadDeps().limits, timeoutMs: 100 } };
      const r = await run('SELECT count(*) FROM generate_series(1, 200000000)', deps);
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('tempo limite') });
    });

    it('SQL destrutivo é rejeitado e auditado', async () => {
      expect(await run('DELETE FROM orders')).toMatchObject({ ok: false });
      expect(await lastAudit('queryDatabase')).toMatchObject({ outcome: 'rejected', kind: 'read', actor_id: 'carla' });
    });

    it('PII e tabelas operacionais são negadas pelo banco', async () => {
      expect(await run('SELECT email FROM customers')).toMatchObject({
        ok: false,
        error: expect.stringContaining('Acesso negado'),
      });
      expect(await run('SELECT * FROM audit_log')).toMatchObject({ ok: false });
      expect(await lastAudit('queryDatabase')).toMatchObject({ outcome: 'denied' });
    });

    it('mesmo sem o guard, a role do agente não consegue escrever', async () => {
      await expect(getReadonlyPool().query('DELETE FROM orders')).rejects.toThrow(/read-only|permission denied/);
      await expect(getReadonlyPool().query('BEGIN; SET TRANSACTION READ WRITE; DELETE FROM orders')).rejects.toThrow();
    });

    it('erro de SQL volta como mensagem útil', async () => {
      expect(await run('SELECT coluna_inexistente FROM orders')).toMatchObject({
        ok: false,
        error: expect.stringContaining('coluna_inexistente'),
      });
    });
  });

  describe('inspectSchema', () => {
    it('mostra só o que a role pode ler, com descrições de negócio', async () => {
      const schema = await inspectSchema(getReadonlyPool(), {}, ctx);
      const names = schema.relations.map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(['orders', 'order_overview', 'customer_spend', 'product_sales']));
      expect(names).not.toContain('audit_log');
      expect(names).not.toContain('operators');
      const customers = schema.relations.find((r) => r.name === 'customers');
      expect(customers?.columns.map((c) => c.name)).not.toContain('email');
      expect(schema.relations.find((r) => r.name === 'order_overview')?.description).toContain('is_late');
      expect(schema.foreignKeys).toContainEqual({ from: 'orders.customer_id', to: 'customers.id' });
      // Convenção adicionada após o EV-02 live: busca de nomes por correspondência parcial.
      expect(schema.conventions.join(' ')).toContain('ILIKE');
    });
  });

  describe('tool Mastra', () => {
    it('usa o ator do requestContext', async () => {
      const requestContext = createCommerceContext({ actor: carla, channel: 'agent' });
      const r = await queryDatabaseTool.execute!({ sql: 'SELECT 1 AS um' }, toolContext(requestContext));
      expect(r).toMatchObject({ ok: true, rows: [{ um: 1 }] });
    });

    it('falha fechado sem ator autenticado', async () => {
      await expect(queryDatabaseTool.execute!({ sql: 'SELECT 1' }, toolContext(new RequestContext()))).rejects.toThrow(
        /sem ator/,
      );
    });
  });
});
