import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools, getAppPool } from '../../src/infrastructure/database/pool';
import { createCommerceAgent } from '../../src/mastra/agents/commerce-agent';
import { COMMERCE_AGENT_ID, createCommerceContext } from '../../src/mastra/request-context';
import { getDeps } from '../../src/infrastructure/app-services';
import { decideLateOrderNotifications } from '../../src/mastra/workflows/late-order-decision';
import {
  LATE_ORDER_WORKFLOW_ID,
  lateOrderNotificationWorkflow,
} from '../../src/mastra/workflows/late-order-notifications';
import { ana, bruno, carla } from '../helpers/actors';
import { resetDatabase } from '../helpers/db';
import { scriptedModel } from '../helpers/scripted-model';

function mastraWith(turns: Parameters<typeof scriptedModel>[0] = []) {
  return new Mastra({
    agents: { commerceAgent: createCommerceAgent({ model: scriptedModel(turns).model }) },
    workflows: { lateOrderNotificationWorkflow },
    storage: new InMemoryStore(),
    logger: false,
  });
}

async function start(actor = bruno) {
  const mastra = mastraWith();
  const run = await mastra.getWorkflow(LATE_ORDER_WORKFLOW_ID).createRun();
  const result = await run.start({
    inputData: { maxOrders: 50 },
    requestContext: createCommerceContext({ actor, channel: 'workflow' }),
  });
  const decide = (approved: boolean, approver = ana) =>
    decideLateOrderNotifications(mastra, getDeps(), { runId: run.runId, approved, actor: approver });
  return { run, result, decide };
}

const notificationCount = async () =>
  (await getAppPool().query<{ n: number }>('SELECT count(*)::int AS n FROM notifications')).rows[0].n;

describe('lateOrderNotificationWorkflow', () => {
  beforeEach(resetDatabase);
  afterAll(closePools);

  it('prepara notificações e suspende para aprovação sem enviar nada', async () => {
    const { result } = await start();
    expect(result.status).toBe('suspended');
    const preview = (result.status === 'suspended' ? result.steps['request-approval'].suspendPayload : undefined) as {
      notifications: Array<{ customerName: string }>;
      skipped: unknown[];
    };
    expect(preview.notifications.map((n) => n.customerName)).toEqual(['João Silva', 'Maria Souza']);
    expect(preview.skipped).toEqual([
      { orderId: 1008, customerId: 10, reason: 'cliente optou por não receber notificações' },
    ]);
    expect(await notificationCount()).toBe(0);
  });

  it('após aprovação envia via caso de uso de domínio, em nome do solicitante', async () => {
    const { run, decide } = await start();
    const outcome = await decide(true);
    expect(outcome).toMatchObject({ kind: 'decided', run: { status: 'success' } });
    expect(outcome.kind === 'decided' && outcome.run.result).toMatchObject({
      status: 'sent',
      approverId: 'ana',
      requestedBy: 'bruno',
      failed: [],
    });
    expect(await notificationCount()).toBe(2);
    const audit = await getAppPool().query(
      `SELECT actor_id, channel, run_id FROM audit_log WHERE capability = 'sendCustomerNotification'`,
    );
    expect(audit.rows).toHaveLength(2);
    // Executa em nome de quem solicitou; o aprovador fica na própria linha.
    expect(audit.rows[0]).toMatchObject({ actor_id: 'bruno', channel: 'workflow', run_id: run.runId });
  });

  it('rejeição encerra sem enviar', async () => {
    const { decide } = await start();
    const outcome = await decide(false);
    expect(outcome.kind === 'decided' && outcome.run.result).toMatchObject({ status: 'rejected', sent: [] });
    expect(await notificationCount()).toBe(0);
  });

  it('é idempotente por regra: pedidos avisados nas últimas 24h são ignorados', async () => {
    const first = await start();
    await first.decide(true);
    const { result } = await start();
    expect(result.status).toBe('success');
    expect(result.status === 'success' && result.result).toMatchObject({ status: 'nothing-to-send' });
  });

  it('viewer não pode iniciar a campanha', async () => {
    const { result } = await start(carla);
    expect(result.status).toBe('failed');
  });

  it('agente delega ao workflow pela tool startLateOrderNotifications', async () => {
    const mastra = mastraWith([
      { tool: 'startLateOrderNotifications', input: { maxOrders: 50 } },
      { text: 'Preparei 2 notificações; aguardam sua aprovação.' },
    ]);
    const stream = await mastra.getAgentById(COMMERCE_AGENT_ID).stream('Avise os clientes com pedido atrasado', {
      requestContext: createCommerceContext({ actor: ana, channel: 'agent' }),
    });
    await stream.consumeStream();
    const output = (await stream.toolResults)[0].payload.result as { status: string; runId: string };
    expect(output.status).toBe('suspended');
    expect(output.runId).toBeTruthy();
    expect(await notificationCount()).toBe(0);
  });
});
