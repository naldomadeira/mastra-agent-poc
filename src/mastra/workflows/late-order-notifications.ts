import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  prepareNotification,
  selectCustomers,
  toLateOrder,
  validateLateOrders,
  type CampaignCustomer,
} from '../../application/notifications/late-order-campaign';
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
  notifications: z.array(NotificationSchema),
  skipped: z.array(SkippedSchema),
});

const identifyLateOrders = createStep({
  id: 'identify-late-orders',
  description: 'Busca pedidos pagos com prazo de envio vencido',
  inputSchema: z.object({ maxOrders: z.number().int().min(1).max(200).default(50) }),
  outputSchema: z.object({ orders: z.array(LateOrderSchema) }),
  execute: async ({ inputData, requestContext }) => {
    // Quem inicia a campanha precisa poder enviar notificações.
    assertCan(actionContextFrom({ requestContext }).actor, 'notifications:send');
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
  suspendSchema: z.object({ notifications: z.array(NotificationSchema), skipped: z.array(SkippedSchema) }),
  // approverId é preenchido pela rota do servidor com o operador da sessão, nunca pelo cliente.
  resumeSchema: z.object({ approved: z.boolean(), approverId: z.string() }),
  outputSchema: DECIDED,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (inputData.notifications.length === 0) return { approved: false, approverId: null, ...inputData };
    if (!resumeData) return await suspend(inputData);
    return { approved: resumeData.approved, approverId: resumeData.approverId, ...inputData };
  },
});

const sendNotifications = createStep({
  id: 'send-notifications',
  description: 'Envia cada notificação pelo caso de uso de domínio, em nome do aprovador',
  inputSchema: DECIDED,
  outputSchema: z.object({
    status: z.enum(['sent', 'rejected', 'nothing-to-send']),
    approverId: z.string().nullable(),
    sent: z.array(z.object({ customerId: z.number(), notificationId: z.number() })),
    failed: z.array(z.object({ customerId: z.number(), error: z.string() })),
    skipped: z.array(SkippedSchema),
  }),
  execute: async ({ inputData, runId }) => {
    const { approved, approverId, notifications, skipped } = inputData;
    const base = { approverId, sent: [], failed: [], skipped };
    if (notifications.length === 0) return { ...base, status: 'nothing-to-send' as const };
    if (!approved || !approverId) return { ...base, status: 'rejected' as const };

    const deps = getDeps();
    const approver = await deps.uow.repos.operators.findById(approverId);
    if (!approver) throw new Error(`Aprovador desconhecido: ${approverId}`);

    const sent: Array<{ customerId: number; notificationId: number }> = [];
    const failed: Array<{ customerId: number; error: string }> = [];
    for (const n of notifications) {
      try {
        const r = await sendCustomerNotification(
          deps,
          { customerId: n.customerId, orderId: n.orderIds[0], subject: n.subject, message: n.message },
          { actor: approver, channel: 'workflow', runId },
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
})
  .then(identifyLateOrders)
  .then(validateOrders)
  .then(selectCustomersStep)
  .then(prepareNotifications)
  .then(requestApproval)
  .then(sendNotifications)
  .commit();
