import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sendCustomerNotification } from '../../src/domain/notifications/send-customer-notification';
import { cancelOrder } from '../../src/domain/orders/cancel-order';
import { previewRefund, refundPayment } from '../../src/domain/payments/refund-payment';
import type { ActionContext } from '../../src/domain/shared/action-context';
import { getDeps } from '../../src/infrastructure/app-services';
import { closePools } from '../../src/infrastructure/database/pool';
import { ana, bruno, carla } from '../helpers/actors';
import { lastAudit, orderStatus, recordApproval, resetDatabase } from '../helpers/db';

const http = (actor = ana): ActionContext => ({ actor, channel: 'http' });

/** Desfaz o reembolso do #1003 para provar que o bloqueio vem do consumo da aprovação. */
async function resetOrder1003ToDelivered() {
  const { getAppPool } = await import('../../src/infrastructure/database/pool');
  await getAppPool().query(`UPDATE orders SET status = 'delivered' WHERE id = 1003`);
  await getAppPool().query(`UPDATE payments SET status = 'captured', refunded_at = NULL WHERE order_id = 1003`);
}

describe('Domain Actions (Postgres real)', () => {
  beforeEach(resetDatabase);
  afterAll(closePools);

  describe('cancelOrder', () => {
    it('cancela pedido pendente, anula pagamento e audita na mesma transação', async () => {
      const result = await cancelOrder(getDeps(), { orderId: 1001, reason: 'Cliente desistiu' }, http(bruno));
      expect(result).toMatchObject({ orderId: 1001, status: 'cancelled', paymentVoided: true });
      expect(await orderStatus(1001)).toEqual({ order: 'cancelled', payment: 'voided' });
      expect(await lastAudit('cancelOrder')).toMatchObject({ outcome: 'success', actor_id: 'bruno', channel: 'http' });
    });

    it('recusa pedido pago sem alterar estado e audita como rejected', async () => {
      await expect(cancelOrder(getDeps(), { orderId: 1002, reason: 'teste' }, http())).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
      expect(await orderStatus(1002)).toEqual({ order: 'paid', payment: 'captured' });
      expect(await lastAudit('cancelOrder')).toMatchObject({ outcome: 'rejected' });
    });

    it('nega viewer e audita como denied', async () => {
      await expect(cancelOrder(getDeps(), { orderId: 1001, reason: 'teste' }, http(carla))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(await orderStatus(1001)).toEqual({ order: 'pending_payment', payment: 'pending' });
      expect(await lastAudit('cancelOrder')).toMatchObject({ outcome: 'denied', actor_id: 'carla' });
    });

    it('recusa pedido inexistente', async () => {
      await expect(cancelOrder(getDeps(), { orderId: 999_999, reason: 'teste' }, http())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('refundPayment', () => {
    it('manager via HTTP reembolsa o valor capturado (não um valor informado)', async () => {
      const result = await refundPayment(getDeps(), { orderId: 1003, reason: 'Defeito' }, http(ana));
      expect(result.refundedAmountCents).toBe(749_900 + 219_900);
      expect(await orderStatus(1003)).toEqual({ order: 'refunded', payment: 'refunded' });
    });

    it('canal agent sem aprovação é negado (defesa em profundidade além do Mastra)', async () => {
      await expect(
        refundPayment(getDeps(), { orderId: 1002, reason: 'Atraso' }, { actor: ana, channel: 'agent' }),
      ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
      expect(await orderStatus(1002)).toEqual({ order: 'paid', payment: 'captured' });
      expect(await lastAudit('refundPayment')).toMatchObject({ outcome: 'denied', approval_required: true });
    });

    it('canal agent com aprovação de manager executa e registra quem aprovou', async () => {
      const input = { orderId: 1002, reason: 'Atraso' };
      await recordApproval({ toolCallId: 'tc-1', approverId: 'ana', input });
      await refundPayment(getDeps(), input, {
        actor: bruno,
        channel: 'agent',
        agentId: 'commerce-agent',
        toolCallId: 'tc-1',
      });
      expect(await lastAudit('refundPayment')).toMatchObject({
        outcome: 'success',
        actor_id: 'bruno',
        approved_by: 'ana',
        approval_required: true,
      });
    });

    it('aprovação dada por support não vale', async () => {
      const input = { orderId: 1002, reason: 'Atraso' };
      await recordApproval({ toolCallId: 'tc-2', approverId: 'bruno', input });
      await expect(
        refundPayment(getDeps(), input, { actor: bruno, channel: 'agent', toolCallId: 'tc-2' }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('aprovação vale só para os argumentos exibidos ao aprovador', async () => {
      await recordApproval({ toolCallId: 'tc-3', approverId: 'ana', input: { orderId: 1003, reason: 'Atraso' } });
      await expect(
        refundPayment(
          getDeps(),
          { orderId: 1002, reason: 'Atraso' },
          { actor: ana, channel: 'agent', toolCallId: 'tc-3' },
        ),
      ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    });

    it('aprovação é consumida uma única vez', async () => {
      const input = { orderId: 1003, reason: 'Defeito' };
      await recordApproval({ toolCallId: 'tc-4', approverId: 'ana', input });
      await refundPayment(getDeps(), input, { actor: ana, channel: 'agent', toolCallId: 'tc-4' });
      await resetOrder1003ToDelivered();
      await expect(
        refundPayment(getDeps(), input, { actor: ana, channel: 'agent', toolCallId: 'tc-4' }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });
    });

    it('rejeição registrada impede a execução', async () => {
      const input = { orderId: 1002, reason: 'Atraso' };
      await recordApproval({ toolCallId: 'tc-5', approverId: 'ana', input, approved: false });
      await expect(
        refundPayment(getDeps(), input, { actor: ana, channel: 'agent', toolCallId: 'tc-5' }),
      ).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });
      expect(await orderStatus(1002)).toEqual({ order: 'paid', payment: 'captured' });
    });

    it('recusa fora da janela de reembolso e pagamento já reembolsado', async () => {
      await expect(refundPayment(getDeps(), { orderId: 1011, reason: 'x'.repeat(5) }, http())).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
      await expect(refundPayment(getDeps(), { orderId: 1010, reason: 'x'.repeat(5) }, http())).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
    });

    it('preview mostra valor e elegibilidade calculados no servidor', async () => {
      expect(await previewRefund(getDeps(), 1002, carla)).toMatchObject({
        eligible: true,
        amountCents: 129_900,
        customerName: 'João Silva',
      });
      expect(await previewRefund(getDeps(), 1011, carla)).toMatchObject({ eligible: false });
    });
  });

  describe('sendCustomerNotification', () => {
    const msg = { subject: 'Seu pedido', message: 'Seu pedido está a caminho, obrigado!' };

    it('envia e grava a notificação', async () => {
      const r = await sendCustomerNotification(getDeps(), { customerId: 1, orderId: 1002, ...msg }, http(bruno));
      expect(r).toMatchObject({ customerId: 1, channel: 'email' });
    });

    it('respeita opt-out do cliente', async () => {
      await expect(sendCustomerNotification(getDeps(), { customerId: 10, ...msg }, http())).rejects.toMatchObject({
        code: 'RULE_VIOLATION',
      });
    });

    it('não aceita pedido de outro cliente (não confia em IDs do chamador)', async () => {
      await expect(
        sendCustomerNotification(getDeps(), { customerId: 2, orderId: 1002, ...msg }, http()),
      ).rejects.toMatchObject({ code: 'RULE_VIOLATION' });
    });

    it('aplica rate limit de 3 por 24h', async () => {
      for (let i = 0; i < 3; i++) await sendCustomerNotification(getDeps(), { customerId: 1, ...msg }, http());
      await expect(sendCustomerNotification(getDeps(), { customerId: 1, ...msg }, http())).rejects.toMatchObject({
        code: 'RULE_VIOLATION',
      });
    });
  });
});
