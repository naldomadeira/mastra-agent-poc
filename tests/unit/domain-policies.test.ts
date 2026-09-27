import { describe, expect, it } from 'vitest';
import { can } from '../../src/domain/operators/operator';
import { cancellationDecision, isLate } from '../../src/domain/orders/order';
import { refundDecision, type Payment } from '../../src/domain/payments/payment';
import { ana, bruno, carla } from '../helpers/actors';

const now = new Date('2026-09-27T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const payment = (over: Partial<Payment> = {}): Payment => ({
  id: 1,
  orderId: 1,
  method: 'pix',
  status: 'captured',
  amountCents: 10_000,
  capturedAt: daysAgo(5),
  refundedAt: null,
  ...over,
});

describe('cancellationDecision', () => {
  it('permite cancelar pedido aguardando pagamento', () => {
    expect(cancellationDecision({ id: 1, status: 'pending_payment' })).toEqual({ allowed: true });
  });
  it.each(['paid', 'shipped', 'delivered', 'cancelled', 'refunded'] as const)('recusa pedido %s', (status) => {
    expect(cancellationDecision({ id: 1, status }).allowed).toBe(false);
  });
  it('orienta pedido pago para o reembolso', () => {
    const d = cancellationDecision({ id: 7, status: 'paid' });
    expect(d.allowed === false && d.reason).toContain('refundPayment');
  });
});

describe('refundDecision', () => {
  const order = { id: 1, status: 'delivered' as const };
  it('permite pagamento capturado dentro da janela', () => {
    expect(refundDecision(order, payment(), now)).toEqual({ allowed: true });
  });
  it('recusa fora da janela de 90 dias', () => {
    expect(refundDecision(order, payment({ capturedAt: daysAgo(120) }), now).allowed).toBe(false);
  });
  it('recusa pagamento já reembolsado ou não capturado', () => {
    expect(refundDecision(order, payment({ status: 'refunded' }), now).allowed).toBe(false);
    expect(refundDecision(order, payment({ status: 'pending', capturedAt: null }), now).allowed).toBe(false);
  });
  it('recusa pedido cancelado mesmo com pagamento capturado', () => {
    expect(refundDecision({ id: 1, status: 'cancelled' }, payment(), now).allowed).toBe(false);
  });
});

describe('isLate', () => {
  it('só pedidos pagos além do prazo estão atrasados', () => {
    expect(isLate({ status: 'paid', expectedShipBy: daysAgo(1) }, now)).toBe(true);
    expect(isLate({ status: 'paid', expectedShipBy: daysAgo(-1) }, now)).toBe(false);
    expect(isLate({ status: 'shipped', expectedShipBy: daysAgo(1) }, now)).toBe(false);
  });
});

describe('permissões', () => {
  it('viewer só lê; support pede reembolso; só manager aprova', () => {
    expect(can(carla, 'data:read')).toBe(true);
    expect(can(carla, 'orders:cancel')).toBe(false);
    expect(can(bruno, 'payments:refund:request')).toBe(true);
    expect(can(bruno, 'payments:refund:approve')).toBe(false);
    expect(can(ana, 'payments:refund:approve')).toBe(true);
  });
});
