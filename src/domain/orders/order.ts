export type OrderStatus = 'pending_payment' | 'paid' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';

export type OrderItem = {
  productId: number;
  productName: string;
  quantity: number;
  unitPriceCents: number;
};

export type Order = {
  id: number;
  customerId: number;
  customerName: string;
  status: OrderStatus;
  totalCents: number;
  placedAt: Date;
  expectedShipBy: Date;
  shippedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  items: OrderItem[];
};

export type Decision = { allowed: true } | { allowed: false; reason: string };

/** Regra de cancelamento: só pedidos ainda não pagos. Pedidos pagos seguem pelo reembolso. */
export function cancellationDecision(order: Pick<Order, 'id' | 'status'>): Decision {
  switch (order.status) {
    case 'pending_payment':
      return { allowed: true };
    case 'paid':
      return {
        allowed: false,
        reason: `Pedido #${order.id} já foi pago: o cancelamento é feito via reembolso (refundPayment).`,
      };
    case 'shipped':
    case 'delivered':
      return {
        allowed: false,
        reason: `Pedido #${order.id} já foi enviado (${order.status}) e não pode ser cancelado.`,
      };
    case 'cancelled':
    case 'refunded':
      return { allowed: false, reason: `Pedido #${order.id} já está encerrado (${order.status}).` };
  }
}

/** Pedido atrasado = pago, ainda não enviado e além do prazo prometido. */
export const isLate = (order: Pick<Order, 'status' | 'expectedShipBy'>, now: Date): boolean =>
  order.status === 'paid' && order.expectedShipBy.getTime() < now.getTime();
