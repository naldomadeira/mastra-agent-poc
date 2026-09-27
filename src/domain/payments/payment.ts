import type { Order } from '../orders/order';
import type { Decision } from '../orders/order';

export type PaymentStatus = 'pending' | 'captured' | 'failed' | 'voided' | 'refunded';

export type Payment = {
  id: number;
  orderId: number;
  method: 'pix' | 'credit_card' | 'boleto';
  status: PaymentStatus;
  amountCents: number;
  capturedAt: Date | null;
  refundedAt: Date | null;
};

export const REFUND_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Regras de elegibilidade de reembolso (independentes de quem pede). */
export function refundDecision(order: Pick<Order, 'id' | 'status'>, payment: Payment | null, now: Date): Decision {
  if (!payment) return { allowed: false, reason: `Pedido #${order.id} não tem pagamento.` };
  if (payment.status === 'refunded')
    return { allowed: false, reason: `Pagamento do pedido #${order.id} já foi reembolsado.` };
  if (payment.status !== 'captured' || !payment.capturedAt) {
    return {
      allowed: false,
      reason: `Pagamento do pedido #${order.id} não foi capturado (status: ${payment.status}).`,
    };
  }
  if (!['paid', 'shipped', 'delivered'].includes(order.status)) {
    return { allowed: false, reason: `Pedido #${order.id} está ${order.status}; não é reembolsável.` };
  }
  const ageDays = (now.getTime() - payment.capturedAt.getTime()) / DAY_MS;
  if (ageDays > REFUND_WINDOW_DAYS) {
    return {
      allowed: false,
      reason: `Pagamento do pedido #${order.id} foi capturado há ${Math.floor(ageDays)} dias; a janela de reembolso é de ${REFUND_WINDOW_DAYS} dias.`,
    };
  }
  return { allowed: true };
}
