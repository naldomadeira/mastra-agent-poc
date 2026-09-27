import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools, getAppPool } from '../../src/infrastructure/database/pool';
import { createCommerceAgent } from '../../src/mastra/agents/commerce-agent';
import { COMMERCE_AGENT_ID, createCommerceContext } from '../../src/mastra/request-context';
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
  const run = await mastraWith().getWorkflow(LATE_ORDER_WORKFLOW_ID).createRun();
  const result = await run.start({
    inputData: { maxOrders: 50 },
    requestContext: createCommerceContext({ actor, channel: 'workflow' }),
  });
  return { run, result };
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

  it('após aprovação envia via caso de uso de domínio, em nome do aprovador', async () => {
    const { run } = await start();
    const resumed = await run.resume({ step: 'request-approval', resumeData: { approved: true, approverId: 'ana' } });
    expect(resumed.status).toBe('success');
    expect(resumed.status === 'success' && resumed.result).toMatchObject({
      status: 'sent',
      approverId: 'ana',
      failed: [],
    });
    expect(await notificationCount()).toBe(2);
    const audit = await getAppPool().query(
      `SELECT actor_id, channel, run_id FROM audit_log WHERE capability = 'sendCustomerNotification'`,
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]).toMatchObject({ actor_id: 'ana', channel: 'workflow', run_id: run.runId });
  });

  it('rejeição encerra sem enviar', async () => {
    const { run } = await start();
    const resumed = await run.resume({ step: 'request-approval', resumeData: { approved: false, approverId: 'ana' } });
    expect(resumed.status === 'success' && resumed.result).toMatchObject({ status: 'rejected', sent: [] });
    expect(await notificationCount()).toBe(0);
  });

  it('é idempotente por regra: pedidos avisados nas últimas 24h são ignorados', async () => {
    const first = await start();
    await first.run.resume({ step: 'request-approval', resumeData: { approved: true, approverId: 'ana' } });
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
