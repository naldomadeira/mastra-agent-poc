import { MCPClient } from '@mastra/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/infrastructure/database/pool';
import { lastAudit, resetDatabase } from '../helpers/db';

/** Teste de protocolo real: cliente MCP → subprocesso stdio → Postgres de teste. */
const client = new MCPClient({
  id: 'commerce-mcp-test',
  servers: {
    commerce: {
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mastra/mcp/stdio.ts'],
      env: {
        DATABASE_URL: process.env.DATABASE_URL!,
        READONLY_DATABASE_URL: process.env.READONLY_DATABASE_URL!,
        MCP_OPERATOR_ID: 'carla',
      },
      timeout: 20_000,
    },
  },
});

/** Resultado MCP: o payload da capability vem como JSON em content[0].text. */
const payload = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

describe('MCP server (stdio)', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await client.disconnect();
    await closePools();
  });

  it('expõe apenas capabilities de leitura', async () => {
    const tools = await client.listTools();
    expect(Object.keys(tools).sort()).toEqual(['commerce_inspectSchema', 'commerce_queryDatabase']);
  });

  it('executa consulta pela mesma capability, auditada com canal mcp', async () => {
    const tools = await client.listTools();
    const result = await tools.commerce_queryDatabase.execute!(
      { sql: 'SELECT count(*)::int AS n FROM order_overview WHERE is_late' },
      {} as never,
    );
    expect(payload(result)).toMatchObject({ ok: true, rows: [{ n: 3 }] });
    expect(await lastAudit('queryDatabase')).toMatchObject({ channel: 'mcp', actor_id: 'carla', outcome: 'success' });
  });

  it('SQL destrutivo continua bloqueado via MCP', async () => {
    const tools = await client.listTools();
    const result = await tools.commerce_queryDatabase.execute!({ sql: 'DROP TABLE orders' }, {} as never);
    expect(payload(result)).toMatchObject({ ok: false, error: expect.stringContaining('SELECT') });
  });
});
