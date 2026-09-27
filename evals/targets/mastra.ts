import type { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import type { ToolExecutionContext } from '@mastra/core/tools';
import { getEnv } from '../../src/config/env';
import { getDeps } from '../../src/infrastructure/app-services';
import { closePools, getAppPool, getReadonlyPool } from '../../src/infrastructure/database/pool';
import { seed } from '../../src/infrastructure/database/seed';
import { createCommerceAgent } from '../../src/mastra/agents/commerce-agent';
import { COMMERCE_AGENT_ID, createCommerceContext } from '../../src/mastra/request-context';
import { actionTools, readTools, workflowTools } from '../../src/mastra/tools';
import {
  LATE_ORDER_WORKFLOW_ID,
  lateOrderNotificationWorkflow,
} from '../../src/mastra/workflows/late-order-notifications';
import type { EvalCase, ModelTurn, Step, ToolCallRecord } from '../schema';
import * as observer from '../support/postgres-observer';
import { scriptedModel } from '../support/scripted-model';
import type { AgentRun, EvalTarget, StepOutcome } from './types';

const TOOLS: Record<string, { execute?: (input: never, ctx: ToolExecutionContext) => Promise<unknown> }> = {
  ...readTools,
  ...actionTools,
  ...workflowTools,
};

/** Nome semântico (casos portáveis) → workflow desta POC. */
const WORKFLOWS: Record<string, typeof LATE_ORDER_WORKFLOW_ID> = { lateOrderNotifications: LATE_ORDER_WORKFLOW_ID };

type WorkflowRun = Awaited<ReturnType<ReturnType<Mastra['getWorkflow']>['createRun']>>;

/**
 * Adaptador Mastra para a suíte portável. Usa os mesmos componentes da aplicação (agente,
 * tools, casos de uso, workflow). Diferenças conscientes em relação à rota /api/chat:
 * storage em memória para memória/snapshots (isolamento por caso) e a gravação da decisão de
 * aprovação feita aqui, exatamente como a rota faz ao receber Aprovar/Rejeitar.
 */
export class MastraTarget implements EvalTarget {
  readonly name = 'mastra';
  private mastra = this.createMastra();

  private createMastra(script?: ModelTurn[]) {
    const model = script ? scriptedModel(script as never).model : undefined;
    return new Mastra({
      agents: { commerceAgent: createCommerceAgent({ model }) },
      workflows: { lateOrderNotificationWorkflow },
      storage: new InMemoryStore(),
      logger: false,
    });
  }

  modelName(mode: 'live' | 'adversarial') {
    return mode === 'live' ? getEnv().MASTRA_MODEL : 'scripted-adversarial';
  }

  async reset() {
    const client = await getAppPool().connect();
    try {
      await seed(client);
    } finally {
      client.release();
    }
    this.mastra = this.createMastra();
  }

  applyFixture = (f: Parameters<EvalTarget['applyFixture']>[0]) => observer.applyFixture(getAppPool(), f);
  snapshot = (tables: string[]) => observer.snapshotTables(getAppPool(), tables);
  rowValue = (t: string, id: number, col: string) => observer.rowValue(getAppPool(), t, id, col);
  count = (t: string) => observer.countRows(getAppPool(), t);
  auditMarker = () => observer.auditMarker(getAppPool());
  auditSince = (m: number) => observer.auditSince(getAppPool(), m);

  async runAgent(c: EvalCase, script?: ModelTurn[]): Promise<AgentRun> {
    this.mastra = this.createMastra(script);
    const agent = this.mastra.getAgentById(COMMERCE_AGENT_ID);
    const actor = await this.actor(c.actor);
    const requestContext = createCommerceContext({ actor, channel: 'agent' });
    const memory = { thread: `eval-${c.id}-${Date.now()}`, resource: actor.id };

    const calls = new Map<string, ToolCallRecord>();
    const run: AgentRun = { responses: [], toolCalls: [], approvalRequested: false, approvalDecisions: [] };

    for (const turn of c.turns) {
      let text = '';
      let stream = await agent.stream(turn, { requestContext, memory });
      for (;;) {
        const { delta, pending } = await consume(stream, calls);
        text += delta;
        if (!pending) break;
        run.approvalRequested = true;
        if (c.approvalPolicy === 'none') {
          run.approvalDecisions.push('pending');
          break;
        }
        const approved = c.approvalPolicy === 'approve';
        // O que /api/chat faz ao receber a decisão: persistir a evidência com o aprovador.
        await getDeps().uow.repos.approvals.record(
          {
            toolCallId: pending.toolCallId,
            runId: stream.runId,
            threadId: memory.thread,
            capability: pending.toolName,
            input: pending.args,
            approved,
            approverId: c.approver ?? c.actor,
          },
          new Date(),
        );
        run.approvalDecisions.push(approved ? 'approved' : 'rejected');
        const record = calls.get(pending.toolCallId);
        if (record) record.status = approved ? 'approved-pending-result' : 'declined';
        stream = approved
          ? await agent.approveToolCall({ runId: stream.runId, toolCallId: pending.toolCallId, requestContext })
          : await agent.declineToolCall({ runId: stream.runId, toolCallId: pending.toolCallId, requestContext });
      }
      run.responses.push(text.trim());
    }

    run.toolCalls = [...calls.values()].map((t) => ({
      ...t,
      status: t.status === 'approved-pending-result' ? 'approved' : t.status,
    }));
    return run;
  }

  async runStep(step: Step, c: EvalCase, state: Map<string, unknown>): Promise<StepOutcome> {
    switch (step.op) {
      case 'recordApproval':
        await getDeps().uow.repos.approvals.record(
          {
            toolCallId: step.toolCallId,
            runId: 'eval',
            capability: step.capability,
            input: step.input,
            approved: step.approved,
            approverId: step.approver,
          },
          new Date(),
        );
        return { op: step.op, outcome: step.approved ? 'approved' : 'rejected', ok: true };

      case 'invoke': {
        const tool = TOOLS[step.capability];
        if (!tool?.execute) throw new Error(`Capability desconhecida: ${step.capability}`);
        const actor = await this.actor(step.actor ?? c.actor);
        const ctx = {
          requestContext: createCommerceContext({ actor, channel: step.channel }),
          agent: step.toolCallId ? { toolCallId: step.toolCallId } : undefined,
          mastra: this.mastra,
        } as unknown as ToolExecutionContext;
        const out = (await tool.execute(step.input as never, ctx)) as { ok?: boolean; code?: string; error?: unknown };
        const outcome = out?.ok === true ? 'ok' : out?.ok === false ? `error:${out.code}` : 'error:VALIDATION';
        return {
          op: step.op,
          outcome,
          ok: outcome === step.expect,
          detail: `esperado ${step.expect}, obtido ${outcome}`,
        };
      }

      case 'readonlySql': {
        // Contorna o guard da capability: prova a garantia do próprio banco.
        const client = await getReadonlyPool().connect();
        try {
          await client.query(step.sql);
          return { op: step.op, outcome: 'executed', ok: false, detail: `NÃO rejeitado: ${step.sql}` };
        } catch (error) {
          return { op: step.op, outcome: 'rejected', ok: true, detail: (error as Error).message };
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release();
        }
      }

      case 'startWorkflow': {
        const actor = await this.actor(step.actor ?? c.actor);
        const workflowId = WORKFLOWS[step.workflow];
        if (!workflowId) throw new Error(`Workflow desconhecido: ${step.workflow}`);
        const run = await this.mastra.getWorkflow(workflowId).createRun();
        const result = await run.start({
          inputData: { maxOrders: 50 },
          requestContext: createCommerceContext({ actor, channel: 'workflow' }),
        });
        state.set(step.ref, run);
        return workflowOutcome(step.op, result, step.expectStatus);
      }

      case 'resumeWorkflow': {
        const run = state.get(step.ref) as WorkflowRun | undefined;
        if (!run) throw new Error(`Workflow run não iniciado: ${step.ref}`);
        const result = await run.resume({
          step: 'request-approval',
          resumeData: { approved: step.approved, approverId: step.approver },
        });
        return workflowOutcome(step.op, result, step.expectStatus);
      }

      case 'checkpoint':
        throw new Error('checkpoint é tratado pelo runner');
    }
  }

  close = () => closePools();

  private async actor(id: string) {
    const actor = await getDeps().uow.repos.operators.findById(id);
    if (!actor) throw new Error(`Operador desconhecido: ${id}`);
    return actor;
  }
}

type Stream = Awaited<ReturnType<Agent['stream']>>;
type Pending = { toolCallId: string; toolName: string; args: unknown };

/** Lê o stream do Mastra e normaliza tool calls, resultados e pedidos de aprovação. */
async function consume(stream: Stream, calls: Map<string, ToolCallRecord>) {
  let delta = '';
  let pending: Pending | undefined;
  for await (const chunk of stream.fullStream) {
    const p = (chunk as { payload?: Record<string, unknown> }).payload ?? {};
    const id = String(p.toolCallId ?? '');
    switch (chunk.type) {
      case 'text-delta':
        delta += String(p.text ?? '');
        break;
      case 'tool-call':
        if (!calls.has(id)) calls.set(id, { name: String(p.toolName), input: p.args, status: 'called' });
        break;
      case 'tool-call-approval':
        calls.set(id, { name: String(p.toolName), input: p.args, status: 'approval-requested' });
        pending = { toolCallId: id, toolName: String(p.toolName), args: p.args };
        break;
      case 'tool-result': {
        const record = calls.get(id) ?? { name: String(p.toolName), input: p.args, status: 'called' };
        if (record.status !== 'declined') {
          record.status = record.status === 'approved-pending-result' ? 'approved' : 'executed';
          record.output = p.result;
        }
        calls.set(id, record);
        break;
      }
      case 'tool-error': {
        const record = calls.get(id) ?? { name: String(p.toolName), input: p.args, status: 'called' };
        record.status = 'error';
        record.output = String(p.error);
        calls.set(id, record);
        break;
      }
    }
  }
  return { delta, pending };
}

function workflowOutcome(op: string, result: { status: string; result?: unknown }, expected?: string): StepOutcome {
  const outcome =
    result.status === 'success' ? String((result.result as { status?: string } | undefined)?.status) : result.status;
  return {
    op,
    outcome,
    ok: !expected || outcome === expected,
    detail: expected ? `esperado ${expected}, obtido ${outcome}` : outcome,
  };
}
