export type NewNotification = {
  customerId: number;
  orderId: number | null;
  subject: string;
  body: string;
  sentBy: string;
};

export type SentNotification = NewNotification & { id: number; channel: 'email'; sentAt: Date };

export const NOTIFICATION_RATE_LIMIT = { max: 3, windowHours: 24 } as const;
