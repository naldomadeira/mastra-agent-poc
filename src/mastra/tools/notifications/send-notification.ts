import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  SendCustomerNotificationInput,
  sendCustomerNotification,
} from '../../../domain/notifications/send-customer-notification';
import { getDeps } from '../../../infrastructure/app-services';
import { actionContextFrom } from '../../request-context';
import { actionOutput, runAction } from '../_shared/tool-result';

export const sendCustomerNotificationTool = createTool({
  id: 'sendCustomerNotification',
  description:
    'Envia uma notificação (e-mail) a UM cliente. Para avisos em lote, use o workflow. A aplicação respeita opt-out e limite de envio.',
  inputSchema: SendCustomerNotificationInput,
  outputSchema: actionOutput(
    z.object({ notificationId: z.number(), customerId: z.number(), channel: z.literal('email'), sentAt: z.string() }),
  ),
  execute: async (input, context) =>
    runAction(() => sendCustomerNotification(getDeps(), input, actionContextFrom(context))),
});
