import type { Order, OrderStatus } from '../../domain/orders/order';
import type { OrderRepository } from '../../domain/ports';
import type { Queryable } from '../database/pool';

type OrderRow = {
  id: number;
  customer_id: number;
  customer_name: string;
  status: OrderStatus;
  total_cents: number;
  placed_at: Date;
  expected_ship_by: Date;
  shipped_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  items: Array<{ productId: number; productName: string; quantity: number; unitPriceCents: number }>;
};

const SELECT_ORDER = `
  SELECT o.id, o.customer_id, c.name AS customer_name, o.status, o.total_cents, o.placed_at,
         o.expected_ship_by, o.shipped_at, o.cancelled_at, o.cancellation_reason,
         coalesce((SELECT json_agg(json_build_object(
                     'productId', i.product_id, 'productName', p.name,
                     'quantity', i.quantity, 'unitPriceCents', i.unit_price_cents) ORDER BY i.id)
                   FROM order_items i JOIN products p ON p.id = i.product_id
                   WHERE i.order_id = o.id), '[]'::json) AS items
  FROM orders o JOIN customers c ON c.id = o.customer_id`;

const toOrder = (r: OrderRow): Order => ({
  id: r.id,
  customerId: r.customer_id,
  customerName: r.customer_name,
  status: r.status,
  totalCents: r.total_cents,
  placedAt: r.placed_at,
  expectedShipBy: r.expected_ship_by,
  shippedAt: r.shipped_at,
  cancelledAt: r.cancelled_at,
  cancellationReason: r.cancellation_reason,
  items: r.items,
});

export function pgOrderRepository(db: Queryable): OrderRepository {
  return {
    async findById(id) {
      const { rows } = await db.query<OrderRow>(`${SELECT_ORDER} WHERE o.id = $1`, [id]);
      return rows[0] ? toOrder(rows[0]) : null;
    },
    async list({ status, customerId, limit }) {
      const { rows } = await db.query<OrderRow>(
        `${SELECT_ORDER}
         WHERE ($1::text IS NULL OR o.status = $1) AND ($2::int IS NULL OR o.customer_id = $2)
         ORDER BY o.placed_at DESC LIMIT $3`,
        [status ?? null, customerId ?? null, limit],
      );
      return rows.map(toOrder);
    },
    async listLate(now, limit) {
      const { rows } = await db.query<OrderRow>(
        `${SELECT_ORDER} WHERE o.status = 'paid' AND o.expected_ship_by < $1 ORDER BY o.expected_ship_by LIMIT $2`,
        [now, limit],
      );
      return rows.map(toOrder);
    },
    async markCancelled(id, reason, at) {
      // Guarda de concorrência: só transiciona a partir do estado validado pelo domínio.
      const res = await db.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = $2, cancellation_reason = $3
         WHERE id = $1 AND status = 'pending_payment'`,
        [id, at, reason],
      );
      if (res.rowCount !== 1) throw new Error(`Pedido ${id} mudou de estado durante o cancelamento`);
    },
    async markRefunded(id) {
      const res = await db.query(
        `UPDATE orders SET status = 'refunded' WHERE id = $1 AND status IN ('paid','shipped','delivered')`,
        [id],
      );
      if (res.rowCount !== 1) throw new Error(`Pedido ${id} mudou de estado durante o reembolso`);
    },
  };
}
