import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { CancelOrderInput, cancelOrder } from '../../../domain/orders/cancel-order';
import { getDeps } from '../../../infrastructure/app-services';
import { actionContextFrom } from '../../request-context';
import { actionOutput, runAction } from '../_shared/tool-result';

export const cancelOrderTool = createTool({
  id: 'cancelOrder',
  description:
    'Cancela um pedido que ainda aguarda pagamento. Pedidos pagos não são cancelados aqui (use refundPayment). A aplicação valida estado e permissão.',
  inputSchema: CancelOrderInput,
  outputSchema: actionOutput(
    z.object({
      orderId: z.number(),
      status: z.literal('cancelled'),
      cancelledAt: z.string(),
      paymentVoided: z.boolean(),
    }),
  ),
  execute: async (input, context) => runAction(() => cancelOrder(getDeps(), input, actionContextFrom(context))),
});
