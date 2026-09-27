import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { LATE_ORDER_WORKFLOW_ID } from '../../workflows/late-order-notifications';

/**
 * Ponte Agente → Workflow: o agente reconhece a intenção ("avisar clientes com pedido atrasado")
 * e delega ao processo determinístico. O workflow para na etapa de aprovação humana; a UI mostra
 * a prévia e os botões Aprovar/Rejeitar.
 */
export const startLateOrderNotificationsTool = createTool({
  id: 'startLateOrderNotifications',
  description:
    'Inicia o processo padronizado de aviso a clientes com pedidos atrasados: identifica, valida, prepara mensagens e pede aprovação humana antes de enviar. Use para avisos em lote.',
  inputSchema: z.object({ maxOrders: z.number().int().min(1).max(200).default(50) }),
  outputSchema: z.object({
    runId: z.string(),
    status: z.string(),
    preview: z.unknown(),
  }),
  execute: async (input, context) => {
    const workflow = context.mastra?.getWorkflow(LATE_ORDER_WORKFLOW_ID);
    if (!workflow) throw new Error('Workflow de notificação não registrado');
    const run = await workflow.createRun();
    const result = await run.start({ inputData: input, requestContext: context.requestContext });
    const preview =
      result.status === 'suspended'
        ? result.steps['request-approval']?.suspendPayload
        : result.status === 'success'
          ? result.result
          : undefined;
    return { runId: run.runId, status: result.status, preview };
  },
});
