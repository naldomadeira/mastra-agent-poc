import { inspectSchemaTool } from './database/inspect-schema';
import { queryDatabaseTool } from './database/query-database';
import { sendCustomerNotificationTool } from './notifications/send-notification';
import { cancelOrderTool } from './orders/cancel-order';
import { refundPaymentTool } from './payments/refund-payment';
import { startLateOrderNotificationsTool } from './workflows/start-late-order-notifications';

/** KNOWLEDGE: leitura genérica e controlada. */
export const readTools = { inspectSchema: inspectSchemaTool, queryDatabase: queryDatabaseTool };

/** ACTIONS: casos de uso do domínio — poucos, semânticos, nunca CRUD. */
export const actionTools = {
  cancelOrder: cancelOrderTool,
  refundPayment: refundPaymentTool,
  sendCustomerNotification: sendCustomerNotificationTool,
};

/** PROCESSOS: dispara workflows determinísticos. */
export const workflowTools = { startLateOrderNotifications: startLateOrderNotificationsTool };
