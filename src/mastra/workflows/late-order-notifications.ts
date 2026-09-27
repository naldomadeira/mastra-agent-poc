import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  prepareNotification,
  selectCustomers,
  toLateOrder,
  validateLateOrders,
  type CampaignCustomer,
} from '../../application/notifications/late-order-campaign';
import { consumeApproval } from '../../domain/approvals/approval';
import { sendCustomerNotification } from '../../domain/notifications/send-customer-notification';
import { assertCan } from '../../domain/operators/operator';
import { isDomainError } from '../../domain/shared/errors';
import { getDeps } from '../../infrastructure/app-services';
import { actionContextFrom } from '../request-context';

/**
 * WORKFLOW (determinístico): o caminho é sempre o mesmo, cada passo é auditável e retomável.
 * Contraste com o AGENTE, que decide o caminho raciocinando. Ver specs/architecture.md.
 *
 * identificar → validar → selecionar clientes → preparar → aprovação humana (suspend) → enviar
 */

export const LATE_ORDER_WORKFLOW_ID = 'lateOrderNotificationWorkflow';

/** Chave da evidência de aprovação de um run (action_approvals.tool_call_id). */
export const workflowApprovalId = (runId: string) => `wf:${LATE_ORDER_WORKFLOW_ID}:${runId}`;

/** Estado compartilhado do run (persistido através de suspend/resume). */
const RunState = z.object({ requestedBy: z.string().optional() });

const LateOrderSchema = z.object({
  id: z.number(),
  customerId: z.number(),
  status: z.enum(['pending_payment', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']),
  totalCents: z.number(),
  expectedShipBy: z.string(),
});
const SkippedSchema = z.object({ orderId: z.number(), customerId: z.number(), reason: z.string() });
const CustomerSchema = z.object({ id: z.number(), name: z.string(), notificationsOptOut: z.boolean() });
const GroupSchema = z.object({ customer: CustomerSchema, orders: z.array(LateOrderSchema) });
const NotificationSchema = z.object({
  customerId: z.number(),
  customerName: z.string(),
  orderIds: z.array(z.number()),
  subject: z.string(),
  message: z.string(),
});
const DECIDED = z.object({
  approved: z.boolean(),
  approverId: z.string().nullable(),
  approvalId: z.string().nullable(),
  notifications: z.array(NotificationSchema),
  skipped: z.array(SkippedSchema),
});

const identifyLateOrders = createStep({
  id: 'identify-late-orders',
  description: 'Busca pedidos pagos com prazo de envio vencido',
  inputSchema: z.object({ maxOrders: z.number().int().min(1).max(200).default(50) }),
  outputSchema: z.object({ orders: z.array(LateOrderSchema) }),
  stateSchema: RunState,
  execute: async ({ inputData, requestContext, setState }) => {
    // Quem inicia a campanha precisa poder enviar notificações.
    const requester = actionContextFrom({ requestContext }).actor;
    assertCan(requester, 'notifications:send');
    await setState({ requestedBy: requester.id });
    const orders = await getDeps().uow.repos.orders.listLate(new Date(), inputData.maxOrders);
    return { orders: orders.map(toLateOrder) };
  },
});

const validateOrders = createStep({
  id: 'validate-orders',
  description: 'Revalida atraso pela regra de domínio e remove pedidos avisados nas últimas 24h',
  inputSchema: z.object({ orders: z.array(LateOrderSchema) }),
  outputSchema: z.object({ eligible: z.array(LateOrderSchema), skipped: z.array(SkippedSchema) }),
  execute: async ({ inputData }) => {
    const { uow, now } = getDeps();
    const since = new Date(now().getTime() - 24 * 3_600_000);
    const notified = await uow.repos.notifications.ordersNotifiedSince(
      inputData.orders.map((o) => o.id),
      since,
    );
    return validateLateOrders(inputData.orders, now(), new Set(notified));
  },
});

const selectCustomersStep = createStep({
  id: 'select-customers',
  description: 'Agrupa por cliente e exclui clientes com opt-out',
  inputSchema: z.object({ eligible: z.array(LateOrderSchema), skipped: z.array(SkippedSchema) }),
  outputSchema: z.object({ groups: z.array(GroupSchema), skipped: z.array(SkippedSchema) }),
  execute: async ({ inputData }) => {
    const repos = getDeps().uow.repos;
    const customers = new Map<number, CampaignCustomer>();
    for (const id of new Set(inputData.eligible.map((o) => o.customerId))) {
      const c = await repos.customers.findById(id);
      if (c) customers.set(id, { id: c.id, name: c.name, notificationsOptOut: c.notificationsOptOut });
    }
    const { groups, skipped } = selectCustomers(inputData.eligible, customers);
    return { groups, skipped: [...inputData.skipped, ...skipped] };
  },
});

const prepareNotifications = createStep({
  id: 'prepare-notifications',
  description: 'Monta as mensagens a partir de template (sem LLM)',
  inputSchema: z.object({ groups: z.array(GroupSchema), skipped: z.array(SkippedSchema) }),
  outputSchema: z.object({ notifications: z.array(NotificationSchema), skipped: z.array(SkippedSchema) }),
  execute: async ({ inputData }) => ({
    notifications: inputData.groups.map(prepareNotification),
    skipped: inputData.skipped,
  }),
});

const requestApproval = createStep({
  id: 'request-approval',
  description: 'Suspende até um humano aprovar ou rejeitar o envio em lote',
  inputSchema: z.object({ notifications: z.array(NotificationSchema), skipped: z.array(SkippedSchema) }),
  suspendSchema: z.object({
    notifications: z.array(NotificationSchema),
    skipped: z.array(SkippedSchema),
    requestedBy: z.string().optional(),
  }),
  // Preenchido pelo servidor (decideLateOrderNotifications) depois de persistir a decisão:
  // aprovador = operador da sessão; approvalId = chave da evidência em action_approvals.
  resumeSchema: z.object({ approved: z.boolean(), approverId: z.string(), approvalId: z.string() }),
  outputSchema: DECIDED,
  stateSchema: RunState,
  execute: async ({ inputData, resumeData, suspend, state }) => {
    if (inputData.notifications.length === 0)
      return { approved: false, approverId: null, approvalId: null, ...inputData };
    if (!resumeData) return await suspend({ ...inputData, requestedBy: state.requestedBy });
    return {
      approved: resumeData.approved,
      approverId: resumeData.approverId,
      approvalId: resumeData.approvalId,
      ...inputData,
    };
  },
});

const sendNotifications = createStep({
  id: 'send-notifications',
  description: 'Consome a aprovação persistida e envia cada notificação pelo caso de uso, em nome do solicitante',
  inputSchema: DECIDED,
  outputSchema: z.object({
    status: z.enum(['sent', 'rejected', 'nothing-to-send']),
    approverId: z.string().nullable(),
    approvalId: z.string().nullable(),
    requestedBy: z.string().nullable(),
    sent: z.array(z.object({ customerId: z.number(), notificationId: z.number() })),
    failed: z.array(z.object({ customerId: z.number(), error: z.string() })),
    skipped: z.array(SkippedSchema),
  }),
  stateSchema: RunState,
  execute: async ({ inputData, runId, state }) => {
    const { approved, approverId, approvalId, notifications, skipped } = inputData;
    const requestedBy = state.requestedBy ?? null;
    const base = { approverId, approvalId, requestedBy, sent: [], failed: [], skipped };
    if (notifications.length === 0) return { ...base, status: 'nothing-to-send' as const };
    if (!approved) return { ...base, status: 'rejected' as const };
    if (!approvalId || !approverId || !requestedBy) throw new Error('Retomada sem evidência de aprovação');

    const deps = getDeps();
    const now = deps.now();
    // A evidência persistida é exigida e consumida uma única vez: uma retomada que não passou
    // pela decisão registrada, ou a repetição deste passo, falha aqui sem enviar nada.
    const { approver, approval } = await deps.uow.transaction((repos) =>
      consumeApproval(repos, {
        toolCallId: approvalId,
        capability: LATE_ORDER_WORKFLOW_ID,
        input: { runId },
        permission: 'notifications:send',
        now,
      }),
    );
    if (approver.id !== approverId) throw new Error('Aprovador diverge da evidência registrada');
    const requester = await deps.uow.repos.operators.findById(requestedBy);
    if (!requester) throw new Error(`Solicitante desconhecido: ${requestedBy}`);

    const provenance = { requestedBy, approvalId, approvedBy: approver.id, approvedAt: approval.decidedAt };
    const sent: Array<{ customerId: number; notificationId: number }> = [];
    const failed: Array<{ customerId: number; error: string }> = [];
    for (const n of notifications) {
      try {
        const r = await sendCustomerNotification(
          deps,
          { customerId: n.customerId, orderId: n.orderIds[0], subject: n.subject, message: n.message },
          // Executa em nome de quem solicitou (permissões verificadas contra ele), com a
          // proveniência da aprovação gravada na própria linha de auditoria do envio.
          { actor: requester, channel: 'workflow', runId, provenance },
        );
        sent.push({ customerId: n.customerId, notificationId: r.notificationId });
      } catch (error) {
        if (!isDomainError(error)) throw error;
        failed.push({ customerId: n.customerId, error: error.message });
      }
    }
    return { ...base, status: 'sent' as const, sent, failed };
  },
});

export const lateOrderNotificationWorkflow = createWorkflow({
  id: LATE_ORDER_WORKFLOW_ID,
  description:
    'Identifica pedidos atrasados, seleciona clientes elegíveis, prepara notificações padronizadas e as envia após aprovação humana.',
  inputSchema: identifyLateOrders.inputSchema,
  outputSchema: sendNotifications.outputSchema,
  stateSchema: RunState,
})
  .then(identifyLateOrders)
  .then(validateOrders)
  .then(selectCustomersStep)
  .then(prepareNotifications)
  .then(requestApproval)
  .then(sendNotifications)
  .commit();
