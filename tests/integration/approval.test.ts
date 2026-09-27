import type { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/operators/operator';
import { closePools } from '../../src/infrastructure/database/pool';
import { createCommerceAgent } from '../../src/mastra/agents/commerce-agent';
import { extractApprovalDecisions } from '../../src/mastra/approvals';
import { COMMERCE_AGENT_ID, createCommerceContext } from '../../src/mastra/request-context';
import { ana, bruno } from '../helpers/actors';
import { lastAudit, orderStatus, recordApproval, resetDatabase } from '../helpers/db';
import { scriptedModel } from '../helpers/scripted-model';

function setup() {
  const { model } = scriptedModel([
    { tool: 'refundPayment', input: { orderId: 1002, reason: 'Atraso na entrega' } },
    { text: 'Reembolso concluído.' },
  ]);
  const mastra = new Mastra({
    agents: { commerceAgent: createCommerceAgent({ model }) },
    storage: new InMemoryStore(), // snapshots do run suspenso
    logger: false,
  });
  return mastra.getAgentById(COMMERCE_AGENT_ID);
}

/** Inicia a conversa e devolve o pedido de aprovação emitido pelo stream. */
async function requestRefund(agent: Agent, requester: Actor) {
  const stream = await agent.stream('Reembolse o pedido #1002 por atraso', {
    requestContext: createCommerceContext({ actor: requester, channel: 'agent' }),
    memory: { thread: 't-approval', resource: requester.id },
  });
  let approval: { toolCallId: string; toolName: string; args: unknown } | undefined;
  for await (const chunk of stream.fullStream) {
    if (chunk.type === 'tool-call-approval') approval = chunk.payload;
  }
  return { runId: stream.runId, approval };
}

const REFUND_ARGS = { orderId: 1002, reason: 'Atraso na entrega' };

/** O que a rota /api/chat faz ao receber Aprovar/Rejeitar: persiste a decisão com o aprovador da sessão. */
const decide = (toolCallId: string, approver: Actor, approved = true, input: unknown = REFUND_ARGS) =>
  recordApproval({ toolCallId, approverId: approver.id, input, approved });

/** Na retomada o contexto é o do solicitante; a evidência de aprovação vem do banco. */
const requesterContext = (requester: Actor) => createCommerceContext({ actor: requester, channel: 'agent' });

describe('Human-in-the-loop: refundPayment', () => {
  beforeEach(resetDatabase);
  afterAll(closePools);

  it('suspende antes de executar: nada muda no banco enquanto aguarda aprovação', async () => {
    const { approval } = await requestRefund(setup(), ana);
    expect(approval).toMatchObject({ toolName: 'refundPayment', args: { orderId: 1002 } });
    expect(await orderStatus(1002)).toEqual({ order: 'paid', payment: 'captured' });
  });

  it('aprovado por manager: executa e audita quem pediu e quem aprovou', async () => {
    const agent = setup();
    const { runId, approval } = await requestRefund(agent, bruno);
    await decide(approval!.toolCallId, ana);
    const resumed = await agent.approveToolCall({
      runId,
      toolCallId: approval!.toolCallId,
      requestContext: requesterContext(bruno),
    });
    expect(await resumed.text).toBe('Reembolso concluído.');
    expect(await orderStatus(1002)).toEqual({ order: 'refunded', payment: 'refunded' });
    expect(await lastAudit('refundPayment')).toMatchObject({
      outcome: 'success',
      actor_id: 'bruno',
      approved_by: 'ana',
      approval_required: true,
      tool_call_id: approval!.toolCallId,
    });
  });

  it('caminho do handleChatStream (resumeStream com approved) também entrega a evidência', async () => {
    const agent = setup();
    const { runId, approval } = await requestRefund(agent, ana);
    await decide(approval!.toolCallId, ana);
    const resumed = await agent.resumeStream(
      { approved: true },
      { runId, toolCallId: approval!.toolCallId, requestContext: requesterContext(ana) },
    );
    await resumed.consumeStream();
    expect((await resumed.toolResults)[0]?.payload.result).toMatchObject({ ok: true });
    expect(await orderStatus(1002)).toEqual({ order: 'refunded', payment: 'refunded' });
  });

  it('regressão: evidência não depende do requestContext restaurado do snapshot', async () => {
    // Bug encontrado no teste manual: o Mastra restaura o requestContext salvo no snapshot do run
    // suspenso, então dados injetados só na retomada podiam se perder. A evidência agora é persistida.
    const agent = setup();
    const { runId, approval } = await requestRefund(agent, ana);
    await decide(approval!.toolCallId, ana);
    const resumed = await agent.approveToolCall({ runId, toolCallId: approval!.toolCallId });
    await resumed.consumeStream();
    expect((await resumed.toolResults)[0]?.payload.result).toMatchObject({ ok: true });
  });

  it('rejeitado: a tool nunca executa', async () => {
    const agent = setup();
    const { runId, approval } = await requestRefund(agent, ana);
    const declined = await agent.declineToolCall({ runId, toolCallId: approval!.toolCallId, reason: 'Não autorizado' });
    await declined.consumeStream();
    expect(await orderStatus(1002)).toEqual({ order: 'paid', payment: 'captured' });
  });

  it('aprovação clicada por support é recusada pelo domínio', async () => {
    const agent = setup();
    const { runId, approval } = await requestRefund(agent, bruno);
    await decide(approval!.toolCallId, bruno);
    const resumed = await agent.approveToolCall({
      runId,
      toolCallId: approval!.toolCallId,
      requestContext: requesterContext(bruno),
    });
    await resumed.consumeStream();
    expect((await resumed.toolResults)[0]?.payload.result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await orderStatus(1002)).toEqual({ order: 'paid', payment: 'captured' });
  });

  it('aprovação de outro toolCallId não vale para esta chamada', async () => {
    const agent = setup();
    const { runId, approval } = await requestRefund(agent, ana);
    await decide('outra-chamada', ana);
    const resumed = await agent.approveToolCall({
      runId,
      toolCallId: approval!.toolCallId,
      requestContext: requesterContext(ana),
    });
    await resumed.consumeStream();
    expect((await resumed.toolResults)[0]?.payload.result).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
  });
});

describe('extractApprovalDecisions (decisões vindas da UI)', () => {
  it('lê approval-responded e decodifica runId::toolCallId', () => {
    const decisions = extractApprovalDecisions({
      role: 'assistant',
      parts: [
        { type: 'text', text: 'ok' },
        {
          type: 'tool-refundPayment',
          state: 'approval-responded',
          toolCallId: 'call-1',
          input: { orderId: 1002 },
          approval: { id: 'run-9::call-1', approved: false, reason: 'não' },
        },
        { type: 'tool-queryDatabase', state: 'output-available', toolCallId: 'call-0' },
      ],
    });
    expect(decisions).toEqual([
      {
        runId: 'run-9',
        toolCallId: 'call-1',
        toolName: 'refundPayment',
        input: { orderId: 1002 },
        approved: false,
        reason: 'não',
      },
    ]);
  });

  it('ignora mensagens de usuário', () => {
    expect(extractApprovalDecisions({ role: 'user', parts: [] })).toEqual([]);
  });
});
