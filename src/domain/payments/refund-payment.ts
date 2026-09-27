import { z } from 'zod';
import { consumeApproval } from '../approvals/approval';
import { assertCan, type Actor } from '../operators/operator';
import type { Deps } from '../ports';
import type { ActionContext } from '../shared/action-context';
import { auditedAction } from '../shared/audited-action';
import { DomainError } from '../shared/errors';
import { formatBRL } from '../shared/money';
import { refundDecision } from './payment';

export const RefundPaymentInput = z.object({
  orderId: z.number().int().positive().describe('Número do pedido cujo pagamento será reembolsado'),
  reason: z.string().trim().min(3).max(500).describe('Motivo do reembolso informado pelo usuário'),
});
export type RefundPaymentInput = z.infer<typeof RefundPaymentInput>;

export type RefundPaymentResult = {
  orderId: number;
  paymentId: number;
  refundedAmountCents: number;
  refundedAmount: string;
  approvedBy: string | null;
};

/** Canais automatizados só reembolsam com evidência de aprovação humana. */
const CHANNELS_REQUIRING_APPROVAL = new Set(['agent', 'mcp', 'workflow']);

/**
 * Caso de uso: reembolso integral do pagamento de um pedido.
 * O valor NÃO vem do chamador: é o valor capturado, lido do banco.
 */
export async function refundPayment(
  deps: Deps,
  rawInput: RefundPaymentInput,
  ctx: ActionContext,
): Promise<RefundPaymentResult> {
  const input = RefundPaymentInput.parse(rawInput);
  const approvalRequired = CHANNELS_REQUIRING_APPROVAL.has(ctx.channel);

  return auditedAction(deps.uow, {
    capability: 'refundPayment',
    input,
    ctx,
    approvalRequired,
    run: async (repos, meta) => {
      assertCan(ctx.actor, 'payments:refund:request');
      const now = deps.now();
      // Canal humano direto (HTTP): o próprio ator precisa poder aprovar.
      // Canal automatizado: exige e consome a evidência persistida de aprovação desta tool call.
      let approver: Actor = ctx.actor;
      if (approvalRequired) {
        const consumed = await consumeApproval(repos, {
          toolCallId: ctx.toolCallId,
          capability: 'refundPayment',
          input,
          permission: 'payments:refund:approve',
          now,
        });
        approver = consumed.approver;
        Object.assign(meta, {
          approvedBy: approver.id,
          approvedAt: consumed.approval.decidedAt,
          approvalId: consumed.approval.toolCallId,
        });
      } else {
        assertCan(ctx.actor, 'payments:refund:approve');
      }

      const order = await repos.orders.findById(input.orderId);
      if (!order) throw new DomainError('NOT_FOUND', `Pedido #${input.orderId} não existe.`);
      const payment = await repos.payments.findByOrderId(order.id);

      const decision = refundDecision(order, payment, now);
      if (!decision.allowed || !payment)
        throw new DomainError('INVALID_STATE', decision.allowed ? 'Sem pagamento.' : decision.reason);

      await repos.payments.markRefunded(payment.id, input.reason, now);
      await repos.orders.markRefunded(order.id);

      return {
        orderId: order.id,
        paymentId: payment.id,
        refundedAmountCents: payment.amountCents,
        refundedAmount: formatBRL(payment.amountCents),
        approvedBy: approvalRequired ? approver.id : null,
      };
    },
  });
}

export type RefundPreview = {
  orderId: number;
  customerName: string;
  amountCents: number;
  amount: string;
  paymentMethod: string | null;
  eligible: boolean;
  ineligibleReason: string | null;
};

/** Leitura usada pela tela de aprovação: mostra o que será reembolsado, calculado no servidor. */
export async function previewRefund(deps: Deps, orderId: number, actor: Actor): Promise<RefundPreview> {
  assertCan(actor, 'data:read');
  const order = await deps.uow.repos.orders.findById(orderId);
  if (!order) throw new DomainError('NOT_FOUND', `Pedido #${orderId} não existe.`);
  const payment = await deps.uow.repos.payments.findByOrderId(orderId);
  const decision = refundDecision(order, payment, deps.now());
  const amountCents = payment?.amountCents ?? 0;
  return {
    orderId,
    customerName: order.customerName,
    amountCents,
    amount: formatBRL(amountCents),
    paymentMethod: payment?.method ?? null,
    eligible: decision.allowed,
    ineligibleReason: decision.allowed ? null : decision.reason,
  };
}
