import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { RefundPaymentInput, refundPayment } from '../../../domain/payments/refund-payment';
import { getDeps } from '../../../infrastructure/app-services';
import { actionContextFrom } from '../../request-context';
import { actionOutput, runAction } from '../_shared/tool-result';

export const refundPaymentTool = createTool({
  id: 'refundPayment',
  description:
    'Reembolsa integralmente o pagamento de um pedido (o valor é o capturado; não é informado por você). Também encerra o pedido. Exige aprovação humana.',
  inputSchema: RefundPaymentInput,
  // Mastra pausa a tool call ANTES de executar e emite `tool-call-approval`. A evidência da
  // decisão humana volta pelo requestContext e o domínio a exige (ADR 004).
  requireApproval: true,
  outputSchema: actionOutput(
    z.object({
      orderId: z.number(),
      paymentId: z.number(),
      refundedAmountCents: z.number(),
      refundedAmount: z.string(),
      approvedBy: z.string().nullable(),
    }),
  ),
  execute: async (input, context) => runAction(() => refundPayment(getDeps(), input, actionContextFrom(context))),
});
