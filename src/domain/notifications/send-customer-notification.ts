import { z } from 'zod';
import { assertCan } from '../operators/operator';
import type { Deps } from '../ports';
import type { ActionContext } from '../shared/action-context';
import { auditedAction } from '../shared/audited-action';
import { DomainError } from '../shared/errors';
import { NOTIFICATION_RATE_LIMIT } from './notification';

export const SendCustomerNotificationInput = z.object({
  customerId: z.number().int().positive().describe('ID do cliente destinatário'),
  orderId: z.number().int().positive().optional().describe('Pedido relacionado, se houver'),
  subject: z.string().trim().min(3).max(120),
  message: z.string().trim().min(10).max(2000),
});
export type SendCustomerNotificationInput = z.infer<typeof SendCustomerNotificationInput>;

export type SendCustomerNotificationResult = {
  notificationId: number;
  customerId: number;
  channel: 'email';
  sentAt: string;
};

/**
 * Caso de uso: notificar cliente (canal simulado — grava em `notifications`).
 * Regras: cliente existe, não fez opt-out, pedido (se informado) pertence ao cliente, rate limit.
 */
export async function sendCustomerNotification(
  deps: Deps,
  rawInput: SendCustomerNotificationInput,
  ctx: ActionContext,
): Promise<SendCustomerNotificationResult> {
  const input = SendCustomerNotificationInput.parse(rawInput);

  return auditedAction(deps.uow, {
    capability: 'sendCustomerNotification',
    input,
    ctx,
    run: async (repos) => {
      assertCan(ctx.actor, 'notifications:send');

      const customer = await repos.customers.findById(input.customerId);
      if (!customer) throw new DomainError('NOT_FOUND', `Cliente ${input.customerId} não existe.`);
      if (customer.notificationsOptOut) {
        throw new DomainError('RULE_VIOLATION', `${customer.name} optou por não receber notificações.`);
      }

      if (input.orderId !== undefined) {
        // Não confiar em IDs vindos do modelo: o pedido precisa ser deste cliente.
        const order = await repos.orders.findById(input.orderId);
        if (!order || order.customerId !== customer.id) {
          throw new DomainError('RULE_VIOLATION', `Pedido #${input.orderId} não pertence a ${customer.name}.`);
        }
      }

      const now = deps.now();
      const since = new Date(now.getTime() - NOTIFICATION_RATE_LIMIT.windowHours * 3_600_000);
      if ((await repos.notifications.countSentSince(customer.id, since)) >= NOTIFICATION_RATE_LIMIT.max) {
        throw new DomainError(
          'RULE_VIOLATION',
          `Limite de ${NOTIFICATION_RATE_LIMIT.max} notificações em ${NOTIFICATION_RATE_LIMIT.windowHours}h atingido para ${customer.name}.`,
        );
      }

      const sent = await repos.notifications.create(
        {
          customerId: customer.id,
          orderId: input.orderId ?? null,
          subject: input.subject,
          body: input.message,
          sentBy: ctx.actor.id,
        },
        now,
      );
      return { notificationId: sent.id, customerId: customer.id, channel: 'email', sentAt: sent.sentAt.toISOString() };
    },
  });
}
