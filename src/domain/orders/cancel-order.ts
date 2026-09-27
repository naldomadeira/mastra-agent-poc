import { z } from 'zod';
import { assertCan } from '../operators/operator';
import type { Deps } from '../ports';
import type { ActionContext } from '../shared/action-context';
import { auditedAction } from '../shared/audited-action';
import { DomainError } from '../shared/errors';
import { cancellationDecision } from './order';

export const CancelOrderInput = z.object({
  orderId: z.number().int().positive().describe('Número do pedido, ex.: 1001'),
  reason: z.string().trim().min(3).max(500).describe('Motivo do cancelamento informado pelo usuário'),
});
export type CancelOrderInput = z.infer<typeof CancelOrderInput>;

export type CancelOrderResult = { orderId: number; status: 'cancelled'; cancelledAt: string; paymentVoided: boolean };

/**
 * Caso de uso: cancelar pedido.
 * existência → autorização → estado permite? → cancela pedido e anula pagamento pendente → audita.
 */
export async function cancelOrder(
  deps: Deps,
  rawInput: CancelOrderInput,
  ctx: ActionContext,
): Promise<CancelOrderResult> {
  const input = CancelOrderInput.parse(rawInput);

  return auditedAction(deps.uow, {
    capability: 'cancelOrder',
    input,
    ctx,
    run: async (repos) => {
      assertCan(ctx.actor, 'orders:cancel');

      const order = await repos.orders.findById(input.orderId);
      if (!order) throw new DomainError('NOT_FOUND', `Pedido #${input.orderId} não existe.`);

      const decision = cancellationDecision(order);
      if (!decision.allowed) throw new DomainError('INVALID_STATE', decision.reason);

      const now = deps.now();
      await repos.orders.markCancelled(order.id, input.reason, now);
      const payment = await repos.payments.findByOrderId(order.id);
      const voidable = payment?.status === 'pending';
      if (voidable) await repos.payments.markVoided(payment.id);

      return { orderId: order.id, status: 'cancelled', cancelledAt: now.toISOString(), paymentVoided: voidable };
    },
  });
}
