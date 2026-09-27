import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools } from '../../src/infrastructure/database/pool';
import { commerceInstructions, createCommerceAgent } from '../../src/mastra/agents/commerce-agent';
import { COMMERCE_AGENT_ID, createCommerceContext } from '../../src/mastra/request-context';
import { ana, carla } from '../helpers/actors';
import { lastAudit, resetDatabase } from '../helpers/db';
import { scriptedModel, type Turn } from '../helpers/scripted-model';

function setup(turns: Turn[]) {
  const scripted = scriptedModel(turns);
  const mastra = new Mastra({
    agents: { commerceAgent: createCommerceAgent({ model: scripted.model }) },
    storage: new InMemoryStore(),
    logger: false,
  });
  return { agent: mastra.getAgentById(COMMERCE_AGENT_ID), scripted };
}

describe('commerceAgent (modelo determinístico)', () => {
  beforeEach(resetDatabase);
  afterAll(closePools);

  it('consulta o banco pela tool de leitura com o ator do contexto e audita', async () => {
    const { agent } = setup([
      { tool: 'queryDatabase', input: { sql: 'SELECT count(*)::int AS n FROM order_overview WHERE is_late' } },
      { text: 'Há 3 pedidos atrasados.' },
    ]);
    const stream = await agent.stream('Quantos pedidos atrasados?', {
      requestContext: createCommerceContext({ actor: carla, channel: 'agent' }),
      memory: { thread: 't-read', resource: 'carla' },
    });
    const text = await stream.text;
    const toolResults = await stream.toolResults;

    expect(text).toBe('Há 3 pedidos atrasados.');
    expect(toolResults[0].payload.result).toMatchObject({ ok: true, rows: [{ n: 3 }] });
    expect(await lastAudit('queryDatabase')).toMatchObject({
      actor_id: 'carla',
      channel: 'agent',
      agent_id: COMMERCE_AGENT_ID,
      thread_id: 't-read',
      outcome: 'success',
    });
  });

  it('SQL destrutivo sugerido pelo modelo é recusado pela capability', async () => {
    const { agent } = setup([{ tool: 'queryDatabase', input: { sql: 'DELETE FROM orders' } }, { text: 'Não posso.' }]);
    const stream = await agent.stream('Apague todos os pedidos', {
      requestContext: createCommerceContext({ actor: ana, channel: 'agent' }),
    });
    await stream.consumeStream();
    expect((await stream.toolResults)[0].payload.result).toMatchObject({ ok: false });
    expect(await lastAudit('queryDatabase')).toMatchObject({ outcome: 'rejected' });
  });

  it('mantém contexto entre mensagens do mesmo thread (memória Mastra)', async () => {
    const { agent, scripted } = setup([{ text: 'Olá, João!' }, { text: 'Você é o João.' }]);
    const opts = {
      requestContext: createCommerceContext({ actor: ana, channel: 'agent' }),
      memory: { thread: 't-mem', resource: 'ana' },
    };
    await (await agent.stream('Meu nome é João.', opts)).consumeStream();
    await (await agent.stream('Qual é o meu nome?', opts)).consumeStream();

    const secondPrompt = JSON.stringify(scripted.prompts[1]);
    expect(secondPrompt).toContain('Meu nome é João.');
    expect(secondPrompt).toContain('Olá, João!');
  });

  it('instruções trazem contexto de aplicação (operador, data local) e não regras de negócio', () => {
    const ctx = createCommerceContext({ actor: ana, channel: 'agent' });
    const text = commerceInstructions(ctx, 'America/Sao_Paulo', new Date('2026-09-27T15:00:00Z'));
    expect(text).toContain('Ana Lima (papel: manager)');
    expect(text).toContain('27 de setembro de 2026');
    expect(text).not.toMatch(/90 dias|pending_payment/);
  });
});
