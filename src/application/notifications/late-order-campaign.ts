import { isLate, type Order } from '../../domain/orders/order';
import { formatBRL } from '../../domain/shared/money';

/**
 * Regras determinísticas da campanha "avisar clientes com pedido atrasado".
 * Funções puras: o workflow só orquestra I/O e chama estas funções.
 */

/** Recorte serializável de um pedido (atravessa o snapshot do workflow). */
export type LateOrder = Pick<Order, 'id' | 'customerId' | 'status' | 'totalCents'> & { expectedShipBy: string };
export type CampaignCustomer = { id: number; name: string; notificationsOptOut: boolean };
export type CustomerGroup = { customer: CampaignCustomer; orders: LateOrder[] };

export const toLateOrder = (o: Order): LateOrder => ({
  id: o.id,
  customerId: o.customerId,
  status: o.status,
  totalCents: o.totalCents,
  expectedShipBy: o.expectedShipBy.toISOString(),
});

export type Skipped = { orderId: number; customerId: number; reason: string };

export type PreparedNotification = {
  customerId: number;
  customerName: string;
  orderIds: number[];
  subject: string;
  message: string;
};

/** Revalida com a regra de domínio e remove pedidos já avisados recentemente. */
export function validateLateOrders(orders: LateOrder[], now: Date, recentlyNotified: ReadonlySet<number>) {
  const eligible: LateOrder[] = [];
  const skipped: Skipped[] = [];
  for (const order of orders) {
    if (!isLate({ status: order.status, expectedShipBy: new Date(order.expectedShipBy) }, now))
      skipped.push({ orderId: order.id, customerId: order.customerId, reason: 'não está mais atrasado' });
    else if (recentlyNotified.has(order.id))
      skipped.push({ orderId: order.id, customerId: order.customerId, reason: 'cliente já avisado nas últimas 24h' });
    else eligible.push(order);
  }
  return { eligible, skipped };
}

/** Agrupa por cliente e exclui quem pediu para não receber notificações. */
export function selectCustomers(orders: LateOrder[], customers: ReadonlyMap<number, CampaignCustomer>) {
  const groups = new Map<number, CustomerGroup>();
  const skipped: Skipped[] = [];
  for (const order of orders) {
    const customer = customers.get(order.customerId);
    if (!customer) {
      skipped.push({ orderId: order.id, customerId: order.customerId, reason: 'cliente não encontrado' });
    } else if (customer.notificationsOptOut) {
      skipped.push({
        orderId: order.id,
        customerId: customer.id,
        reason: 'cliente optou por não receber notificações',
      });
    } else {
      const group = groups.get(customer.id) ?? { customer, orders: [] };
      group.orders.push(order);
      groups.set(customer.id, group);
    }
  }
  return { groups: [...groups.values()], skipped };
}

/** Mensagem padronizada (template), não gerada por LLM: previsível e revisável. */
export function prepareNotification(group: CustomerGroup): PreparedNotification {
  const firstName = group.customer.name.split(' ')[0];
  const lines = group.orders.map((o) => `- Pedido #${o.id} (${formatBRL(o.totalCents)})`);
  const plural = group.orders.length > 1;
  return {
    customerId: group.customer.id,
    customerName: group.customer.name,
    orderIds: group.orders.map((o) => o.id),
    subject: plural ? 'Seus pedidos estão atrasados' : `Seu pedido #${group.orders[0].id} está atrasado`,
    message: [
      `Olá, ${firstName}.`,
      `${plural ? 'Os pedidos abaixo estão' : 'O pedido abaixo está'} com o envio atrasado:`,
      ...lines,
      'Já estamos priorizando o despacho e avisaremos assim que sair para entrega. Pedimos desculpas pelo transtorno.',
    ].join('\n'),
  };
}
