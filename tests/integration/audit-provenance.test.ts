import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { refundPayment } from '../../src/domain/payments/refund-payment';
import { getDeps } from '../../src/infrastructure/app-services';
import { closePools, getAppPool } from '../../src/infrastructure/database/pool';
import { createCommerceAgent } from '../../src/mastra/agents/commerce-agent';
import { recordAgentApprovalDecisions } from '../../src/mastra/approvals';
import { createCommerceContext } from '../../src/mastra/request-context';
import { decideLateOrderNotifications } from '../../src/mastra/workflows/late-order-decision';
import {
  LATE_ORDER_WORKFLOW_ID,
  lateOrderNotificationWorkflow,
  workflowApprovalId,
} from '../../src/mastra/workflows/late-order-notifications';
import { ana, bruno, carla } from '../helpers/actors';
import { resetDatabase } from '../helpers/db';
import { scriptedModel } from '../helpers/scripted-model';

async function startCampaign(requester = bruno) {
  const mastra = new Mastra({
    agents: { commerceAgent: createCommerceAgent({ model: scriptedModel([]).model }) },
    workflows: { lateOrderNotificationWorkflow },
    storage: new InMemoryStore(),
    logger: false,
  });
  const run = await mastra.getWorkflow(LATE_ORDER_WORKFLOW_ID).createRun();
  const started = await run.start({
    inputData: { maxOrders: 50 },
    requestContext: createCommerceContext({ actor: requester, channel: 'workflow' }),
  });
  expect(started.status).toBe('suspended');
  const decide = (approved: boolean, actor = ana, correlationId?: string) =>
    decideLateOrderNotifications(mastra, getDeps(), { runId: run.runId, approved, actor, correlationId });
  return { mastra, run, decide, approvalId: workflowApprovalId(run.runId) };
}

const auditRows = async (where = 'true', params: unknown[] = []) =>
  (await getAppPool().query(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`, params)).rows;
const approvalRow = async (key: string) =>
  (await getAppPool().query('SELECT * FROM action_approvals WHERE tool_call_id = $1', [key])).rows[0];
const count = async (table: string) =>
  (await getAppPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

describe('Auditoria de proveniência (lacuna 3)', () => {
  beforeEach(resetDatabase);
  afterAll(closePools);

  it('cada envio do workflow diz quem solicitou, quem aprovou, qual aprovação e qual run', async () => {
    const { run, decide, approvalId } = await startCampaign(bruno);
    await decide(true, ana, 'req-123');

    const [decision, ...sends] = await auditRows('run_id = $1', [run.runId]);
    expect(decision).toMatchObject({
      capability: `${LATE_ORDER_WORKFLOW_ID}.approval`,
      actor_id: 'ana',
      requested_by: 'bruno',
      approved_by: 'ana',
      approval_id: approvalId,
      outcome: 'success',
      correlation_id: 'req-123',
    });
    expect(sends).toHaveLength(2);
    for (const send of sends) {
      expect(send).toMatchObject({
        capability: 'sendCustomerNotification',
        channel: 'workflow',
        actor_id: 'bruno', // executou em nome do solicitante
        requested_by: 'bruno',
        approved_by: 'ana',
        approval_id: approvalId,
        approval_required: true,
        run_id: run.runId,
        outcome: 'success',
      });
      // quando a aprovação ocorreu (decisão) ≠ quando o envio ocorreu
      expect(send.approved_at).toEqual(decision.approved_at);
      expect(send.occurred_at.getTime()).toBeGreaterThanOrEqual(send.approved_at.getTime());
    }
  });

  it('preserva a ordem causal: decisão auditada antes dos envios', async () => {
    const { run, decide } = await startCampaign();
    await decide(true);
    const rows = await auditRows('run_id = $1', [run.runId]);
    expect(rows.map((r) => r.capability)).toEqual([
      `${LATE_ORDER_WORKFLOW_ID}.approval`,
      'sendCustomerNotification',
      'sendCustomerNotification',
    ]);
  });

  it('aprovação do workflow é consumida uma única vez', async () => {
    const { decide, approvalId } = await startCampaign();
    await decide(true);
    const approval = await approvalRow(approvalId);
    expect(approval).toMatchObject({ approved: true, approver_id: 'ana' });
    expect(approval.consumed_at).not.toBeNull();
  });

  it('retomada que não passa pela decisão registrada falha sem enviar nada', async () => {
    const { run } = await startCampaign();
    const forged = await run.resume({
      step: 'request-approval',
      resumeData: { approved: true, approverId: 'ana', approvalId: 'wf:forjada' },
    });
    expect(forged.status).toBe('failed');
    expect(await count('notifications')).toBe(0);
  });

  it('rejeição é auditada com a mesma approval_id e nada é enviado', async () => {
    const { run, decide, approvalId } = await startCampaign();
    await decide(false);
    const rows = await auditRows('run_id = $1', [run.runId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'rejected',
      approval_id: approvalId,
      requested_by: 'bruno',
      actor_id: 'ana',
    });
    expect(await approvalRow(approvalId)).toMatchObject({ approved: false });
    expect(await count('notifications')).toBe(0);
  });

  it('reembolso pelo agente registra approval_id e o momento da decisão (não do consumo)', async () => {
    const input = { orderId: 1002, reason: 'Atraso' };
    await recordAgentApprovalDecisions(
      getDeps(),
      [{ runId: 'r1', toolCallId: 'tc-prov', toolName: 'refundPayment', input, approved: true }],
      { actor: ana, threadId: 't1' },
    );
    const decidedAt = (await approvalRow('tc-prov')).decided_at;
    await refundPayment(getDeps(), input, {
      actor: bruno,
      channel: 'agent',
      toolCallId: 'tc-prov',
      correlationId: 'req-9',
    });
    const [row] = await auditRows(`capability = 'refundPayment' AND outcome = 'success'`);
    expect(row).toMatchObject({
      actor_id: 'bruno',
      requested_by: 'bruno',
      approved_by: 'ana',
      approval_id: 'tc-prov',
      correlation_id: 'req-9',
    });
    expect(row.approved_at).toEqual(decidedAt);
  });
});

describe('Tentativas recusadas (lacuna 4)', () => {
  beforeEach(resetDatabase);
  afterAll(closePools);

  it('decidir de novo um run já decidido → denied ALREADY_DECIDED, sem reexecutar nem alterar a aprovação', async () => {
    const { run, decide, approvalId } = await startCampaign();
    await decide(true);
    const approvalBefore = await approvalRow(approvalId);
    const notificationsBefore = await count('notifications');
    const sendsBefore = (await auditRows(`capability = 'sendCustomerNotification'`)).length;

    const second = await decide(true, ana, 'req-replay');
    expect(second).toMatchObject({ kind: 'denied', code: 'ALREADY_DECIDED', httpStatus: 409 });

    const denied = (await auditRows(`outcome = 'denied'`)).at(-1);
    expect(denied).toMatchObject({
      actor_id: 'ana',
      capability: `${LATE_ORDER_WORKFLOW_ID}.approval`,
      run_id: run.runId,
      approval_id: approvalId,
      correlation_id: 'req-replay',
      requested_by: 'bruno',
    });
    expect(denied.error).toMatch(/^ALREADY_DECIDED: /);
    expect(denied.occurred_at).toBeInstanceOf(Date);

    expect(await approvalRow(approvalId)).toEqual(approvalBefore);
    expect(await count('notifications')).toBe(notificationsBefore);
    expect(await auditRows(`capability = 'sendCustomerNotification'`)).toHaveLength(sendsBefore);
  });

  it('decisão concorrente já registrada → denied, run continua suspenso, decisão existente intacta', async () => {
    const { mastra, run, decide, approvalId } = await startCampaign();
    // Outra requisição registrou a decisão primeiro (ex.: duplo clique / outra aba).
    await getDeps().uow.repos.approvals.record(
      {
        toolCallId: approvalId,
        runId: run.runId,
        capability: LATE_ORDER_WORKFLOW_ID,
        input: { runId: run.runId },
        approved: false,
        approverId: 'bruno',
      },
      new Date(),
    );
    const outcome = await decide(true, ana);
    expect(outcome).toMatchObject({ kind: 'denied', code: 'ALREADY_DECIDED' });
    expect(await approvalRow(approvalId)).toMatchObject({ approved: false, approver_id: 'bruno', consumed_at: null });
    expect((await mastra.getWorkflow(LATE_ORDER_WORKFLOW_ID).getWorkflowRunById(run.runId))?.status).toBe('suspended');
    expect(await count('notifications')).toBe(0);
  });

  it('operador sem permissão → denied FORBIDDEN, nenhuma decisão registrada, run suspenso', async () => {
    const { mastra, run, decide, approvalId } = await startCampaign();
    const outcome = await decide(true, carla);
    expect(outcome).toMatchObject({ kind: 'denied', code: 'FORBIDDEN', httpStatus: 403 });
    expect((await auditRows(`outcome = 'denied'`)).at(-1)).toMatchObject({
      actor_id: 'carla',
      approval_id: approvalId,
    });
    expect(await approvalRow(approvalId)).toBeUndefined();
    expect((await mastra.getWorkflow(LATE_ORDER_WORKFLOW_ID).getWorkflowRunById(run.runId))?.status).toBe('suspended');
  });

  it('run inexistente → denied NOT_FOUND', async () => {
    const { mastra } = await startCampaign();
    const outcome = await decideLateOrderNotifications(mastra, getDeps(), {
      runId: 'nao-existe',
      approved: true,
      actor: ana,
    });
    expect(outcome).toMatchObject({ kind: 'denied', code: 'NOT_FOUND', httpStatus: 404 });
    expect((await auditRows(`outcome = 'denied'`)).at(-1)).toMatchObject({ run_id: 'nao-existe', actor_id: 'ana' });
  });

  it('solicitante desconhecido fica vazio em vez de assumir o ator', async () => {
    const { mastra } = await startCampaign();
    await decideLateOrderNotifications(mastra, getDeps(), { runId: 'sem-historico', approved: true, actor: ana });
    expect((await auditRows(`outcome = 'denied'`)).at(-1)).toMatchObject({ actor_id: 'ana', requested_by: null });
  });

  it('decisão repetida no chat → denied ALREADY_DECIDED, aprovação original intacta', async () => {
    const decision = {
      runId: 'r1',
      toolCallId: 'tc-dup',
      toolName: 'refundPayment',
      input: { orderId: 1002, reason: 'x' },
    };
    await recordAgentApprovalDecisions(getDeps(), [{ ...decision, approved: true }], { actor: ana, threadId: 't' });
    const before = await approvalRow('tc-dup');
    await recordAgentApprovalDecisions(getDeps(), [{ ...decision, approved: false }], {
      actor: bruno,
      threadId: 't',
      correlationId: 'req-dup',
    });
    expect(await approvalRow('tc-dup')).toEqual(before);
    expect((await auditRows(`outcome = 'denied'`)).at(-1)).toMatchObject({
      actor_id: 'bruno',
      capability: 'refundPayment.approval',
      approval_id: 'tc-dup',
      correlation_id: 'req-dup',
    });
  });
});
