import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools } from '../../src/infrastructure/database/pool';
import { createCommerceAgent } from '../../src/mastra/agents/commerce-agent';
import { COMMERCE_AGENT_ID, createCommerceContext } from '../../src/mastra/request-context';
import { sendCustomerNotificationTool } from '../../src/mastra/tools/notifications/send-notification';
import { cancelOrderTool } from '../../src/mastra/tools/orders/cancel-order';
import { ana, bruno, carla } from '../helpers/actors';
import { lastAudit, orderStatus, resetDatabase } from '../helpers/db';
import { scriptedModel, type Turn } from '../helpers/scripted-model';
import { toolContext } from '../helpers/tool-context';

const asAgent = (actor = bruno) => createCommerceContext({ actor, channel: 'agent' });

function agentWith(turns: Turn[]) {
  const { model } = scriptedModel(turns);
  const mastra = new Mastra({
    agents: { commerceAgent: createCommerceAgent({ model }) },
    storage: new InMemoryStore(),
    logger: false,
  });
  return mastra.getAgentById(COMMERCE_AGENT_ID);
}

describe('Action tools', () => {
  beforeEach(resetDatabase);
  afterAll(closePools);

  it('cancelOrder: Tool → Use Case → Repository → DB', async () => {
    const out = await cancelOrderTool.execute!(
      { orderId: 1001, reason: 'Cliente desistiu' },
      toolContext(asAgent(), { toolCallId: 'c1' }),
    );
    expect(out).toMatchObject({ ok: true, result: { orderId: 1001, status: 'cancelled' } });
    expect(await orderStatus(1001)).toEqual({ order: 'cancelled', payment: 'voided' });
    expect(await lastAudit('cancelOrder')).toMatchObject({ channel: 'agent', tool_call_id: 'c1', outcome: 'success' });
  });

  it('regra de negócio violada vira saída previsível (não exceção)', async () => {
    const out = await cancelOrderTool.execute!({ orderId: 1007, reason: 'Teste' }, toolContext(asAgent()));
    expect(out).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });

  it('autorização é do backend: viewer não cancela, mesmo que o modelo tente', async () => {
    const out = await cancelOrderTool.execute!({ orderId: 1001, reason: 'Teste' }, toolContext(asAgent(carla)));
    expect(out).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await orderStatus(1001)).toEqual({ order: 'pending_payment', payment: 'pending' });
  });

  it('input inválido é rejeitado pelo schema', async () => {
    const out = await cancelOrderTool.execute!({ orderId: -1, reason: '' }, toolContext(asAgent()));
    expect(out).toMatchObject({ error: true });
    expect(await orderStatus(1001)).toEqual({ order: 'pending_payment', payment: 'pending' });
  });

  it('sendCustomerNotification respeita opt-out', async () => {
    const out = await sendCustomerNotificationTool.execute!(
      { customerId: 10, subject: 'Atraso', message: 'Seu pedido está atrasado, desculpe.' },
      toolContext(asAgent()),
    );
    expect(out).toMatchObject({ ok: false, code: 'RULE_VIOLATION' });
  });

  it('agente cancela pedido via tool e explica o resultado', async () => {
    const agent = agentWith([
      { tool: 'cancelOrder', input: { orderId: 1006, reason: 'Pedido duplicado' } },
      { text: 'Pedido #1006 cancelado.' },
    ]);
    const stream = await agent.stream('Cancele o pedido #1006, duplicado.', { requestContext: asAgent() });
    expect(await stream.text).toBe('Pedido #1006 cancelado.');
    expect(await orderStatus(1006)).toEqual({ order: 'cancelled', payment: 'voided' });
  });

  it('sem aprovação, o domínio nega reembolso pedido pelo agente (defesa em profundidade)', async () => {
    const out = await import('../../src/mastra/tools/payments/refund-payment').then(({ refundPaymentTool }) =>
      refundPaymentTool.execute!({ orderId: 1002, reason: 'Atraso' }, toolContext(asAgent(ana), { toolCallId: 'r1' })),
    );
    expect(out).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    expect(await orderStatus(1002)).toEqual({ order: 'paid', payment: 'captured' });
  });
});
