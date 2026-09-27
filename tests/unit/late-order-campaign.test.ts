import { describe, expect, it } from 'vitest';
import {
  prepareNotification,
  selectCustomers,
  validateLateOrders,
  type LateOrder,
} from '../../src/application/notifications/late-order-campaign';

const now = new Date('2026-09-27T12:00:00Z');
const order = (id: number, customerId: number, over: Partial<LateOrder> = {}): LateOrder => ({
  id,
  customerId,
  status: 'paid',
  totalCents: 10_000,
  expectedShipBy: '2026-09-20T00:00:00Z',
  ...over,
});

describe('campanha de pedidos atrasados', () => {
  it('valida atraso pela regra de domínio e remove já notificados', () => {
    const { eligible, skipped } = validateLateOrders(
      [order(1, 1), order(2, 1, { expectedShipBy: '2026-10-01T00:00:00Z' }), order(3, 2)],
      now,
      new Set([3]),
    );
    expect(eligible.map((o) => o.id)).toEqual([1]);
    expect(skipped.map((s) => [s.orderId, s.reason])).toEqual([
      [2, 'não está mais atrasado'],
      [3, 'cliente já avisado nas últimas 24h'],
    ]);
  });

  it('agrupa por cliente e respeita opt-out', () => {
    const customers = new Map([
      [1, { id: 1, name: 'João Silva', notificationsOptOut: false }],
      [2, { id: 2, name: 'Camila Ribeiro', notificationsOptOut: true }],
    ]);
    const { groups, skipped } = selectCustomers([order(1, 1), order(2, 1), order(3, 2)], customers);
    expect(groups).toHaveLength(1);
    expect(groups[0].orders.map((o) => o.id)).toEqual([1, 2]);
    expect(skipped).toEqual([{ orderId: 3, customerId: 2, reason: 'cliente optou por não receber notificações' }]);
  });

  it('mensagem é template determinístico', () => {
    const n = prepareNotification({
      customer: { id: 1, name: 'João Silva', notificationsOptOut: false },
      orders: [order(7, 1)],
    });
    expect(n.subject).toBe('Seu pedido #7 está atrasado');
    expect(n.message).toContain('Olá, João.');
    expect(n.message).toContain('Pedido #7 (R$');
  });
});
