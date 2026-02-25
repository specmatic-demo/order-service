export type OrderItem = {
  sku: string;
  quantity: number;
  unitPrice: number;
};

export type CreateOrderPayload = {
  customerId: string;
  paymentMethodId: string;
  items: OrderItem[];
};

export type Order = {
  id: string;
  customerId: string;
  status: 'PENDING_PAYMENT' | 'CONFIRMED' | 'SHIPPED' | 'CANCELLED';
  items: OrderItem[];
  totalAmount: number;
  createdAt: string;
  cancelledAt?: string;
};

export type AnalyticsNotificationEvent = {
  notificationId: string;
  requestId: string;
  title: string;
  body: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
};
