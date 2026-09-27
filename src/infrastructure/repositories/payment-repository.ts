import type { Payment } from '../../domain/payments/payment';
import type { PaymentRepository } from '../../domain/ports';
import type { Queryable } from '../database/pool';

type PaymentRow = {
  id: number;
  order_id: number;
  method: Payment['method'];
  status: Payment['status'];
  amount_cents: number;
  captured_at: Date | null;
  refunded_at: Date | null;
};

export function pgPaymentRepository(db: Queryable): PaymentRepository {
  return {
    async findByOrderId(orderId) {
      const { rows } = await db.query<PaymentRow>(
        'SELECT id, order_id, method, status, amount_cents, captured_at, refunded_at FROM payments WHERE order_id = $1',
        [orderId],
      );
      const r = rows[0];
      return r
        ? {
            id: r.id,
            orderId: r.order_id,
            method: r.method,
            status: r.status,
            amountCents: r.amount_cents,
            capturedAt: r.captured_at,
            refundedAt: r.refunded_at,
          }
        : null;
    },
    async markVoided(id) {
      await db.query(`UPDATE payments SET status = 'voided' WHERE id = $1 AND status = 'pending'`, [id]);
    },
    async markRefunded(id, reason, at) {
      const res = await db.query(
        `UPDATE payments SET status = 'refunded', refunded_at = $2, refund_reason = $3
         WHERE id = $1 AND status = 'captured'`,
        [id, at, reason],
      );
      if (res.rowCount !== 1) throw new Error(`Pagamento ${id} mudou de estado durante o reembolso`);
    },
  };
}
