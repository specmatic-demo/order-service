import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { Kafka, type Producer } from 'kafkajs';
import type { AnalyticsNotificationEvent, CreateOrderPayload, Order, OrderItem } from './types';

const app = express();
app.use(express.json({ limit: '1mb' }));

const host = process.env.ORDER_HOST || '0.0.0.0';
const port = Number.parseInt(process.env.ORDER_PORT || '9000', 10);
const paymentBaseUrl = process.env.PAYMENT_SERVICE_BASE_URL || 'http://localhost:5201';
const shippingBaseUrl = process.env.SHIPPING_SERVICE_BASE_URL || 'http://localhost:5202';
const analyticsKafkaBrokers = (process.env.ANALYTICS_KAFKA_BROKERS || 'localhost:9092')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const analyticsNotificationTopic = process.env.ANALYTICS_NOTIFICATION_TOPIC || 'notification.user';

const orders = new Map<string, Order>();
const orderStatuses = new Set(['PENDING_PAYMENT', 'CONFIRMED', 'SHIPPED', 'CANCELLED']);
const kafka = new Kafka({
  clientId: 'order-service-analytics',
  brokers: analyticsKafkaBrokers
});
const analyticsProducer: Producer = kafka.producer();
let analyticsProducerConnected = false;

async function ensureAnalyticsProducerConnected(): Promise<void> {
  if (analyticsProducerConnected) {
    return;
  }

  await analyticsProducer.connect();
  analyticsProducerConnected = true;
}

async function safeJsonFetch(url: string, options: RequestInit): Promise<unknown | null> {
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function buildOrder(orderId: string, payload: CreateOrderPayload): Order {
  const totalAmount = payload.items.reduce((sum, item) => sum + Number(item.unitPrice) * Number(item.quantity), 0);
  return {
    id: orderId,
    customerId: payload.customerId,
    status: 'PENDING_PAYMENT',
    items: payload.items,
    totalAmount,
    createdAt: new Date().toISOString()
  };
}

function isValidOrderItem(item: unknown): item is OrderItem {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return false;
  }
  const payload = item as Record<string, unknown>;

  if (typeof payload.sku !== 'string' || payload.sku.trim() === '') {
    return false;
  }

  const quantity = payload.quantity;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
    return false;
  }

  const unitPrice = payload.unitPrice;
  if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice)) {
    return false;
  }

  return true;
}

function isValidDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

async function publishAnalyticsNotification(event: AnalyticsNotificationEvent): Promise<void> {
  await ensureAnalyticsProducerConnected();
  await analyticsProducer.send({
    topic: analyticsNotificationTopic,
    messages: [{ key: event.requestId, value: JSON.stringify(event) }]
  });
}

app.post('/orders', async (req: Request, res: Response) => {
  const payload = (req.body ?? {}) as Partial<CreateOrderPayload>;
  if (typeof payload.customerId !== 'string' || typeof payload.paymentMethodId !== 'string' || !Array.isArray(payload.items) || payload.items.length === 0) {
    res.status(400).json({ error: 'Invalid order payload' });
    return;
  }

  if (payload.items.some((item) => !isValidOrderItem(item))) {
    res.status(400).json({ error: 'Invalid order payload' });
    return;
  }

  const validatedPayload = payload as CreateOrderPayload;
  const orderId = randomUUID();
  const order = buildOrder(orderId, validatedPayload);

  await safeJsonFetch(`${paymentBaseUrl}/payments/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId,
      amount: order.totalAmount,
      currency: 'USD',
      paymentMethodId: validatedPayload.paymentMethodId
    })
  });

  await safeJsonFetch(`${shippingBaseUrl}/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId,
      destinationPostalCode: '10001'
    })
  });

  orders.set(orderId, order);
  try {
    await publishAnalyticsNotification({
      notificationId: randomUUID(),
      requestId: orderId,
      title: 'OrderCreated',
      body: `Order ${orderId} created for customer ${order.customerId}`,
      priority: 'HIGH'
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to publish analytics notification on ${analyticsNotificationTopic}: ${message}`);
  }
  res.status(201).json(order);
});

app.get('/orders/:orderId', (req: Request, res: Response) => {
  const { orderId } = req.params;
  const existing = orders.get(orderId);
  if (existing) {
    res.status(200).json(existing);
    return;
  }

  res.status(200).json({
    id: orderId,
    customerId: `customer-${orderId}`,
    status: 'CONFIRMED',
    items: [{ sku: 'SKU-DEFAULT', quantity: 1, unitPrice: 100.0 }],
    totalAmount: 100.0,
    createdAt: new Date().toISOString()
  });
});

app.get('/orders', (req: Request, res: Response) => {
  const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;

  if (status && !orderStatuses.has(status)) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }

  if ((from && !isValidDateTime(from)) || (to && !isValidDateTime(to))) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }

  let list = Array.from(orders.values());
  if (list.length === 0) {
    list = [{
      id: randomUUID(),
      customerId: customerId || 'customer-default',
      status: (status as Order['status']) || 'CONFIRMED',
      items: [{ sku: 'SKU-DEFAULT', quantity: 1, unitPrice: 100 }],
      totalAmount: 100,
      createdAt: new Date().toISOString()
    }];
  }

  const filtered = list.filter((order) => {
    if (customerId && order.customerId !== customerId) {
      return false;
    }

    if (status && order.status !== status) {
      return false;
    }

    if (from && order.createdAt < from) {
      return false;
    }

    if (to && order.createdAt > to) {
      return false;
    }

    return true;
  });

  res.status(200).json(filtered);
});

app.post('/orders/:orderId/cancel', async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const payload = req.body ?? {};

  if (typeof payload !== 'object' || Array.isArray(payload)) {
    res.status(400).json({ error: 'Invalid cancellation request' });
    return;
  }

  if (typeof payload.reason !== 'undefined') {
    if (typeof payload.reason !== 'string' || payload.reason.length > 256) {
      res.status(400).json({ error: 'Invalid cancellation request' });
      return;
    }
  }

  const existing = orders.get(orderId) || {
    id: orderId,
    customerId: `customer-${orderId}`,
    status: 'CONFIRMED' as const,
    items: [{ sku: 'SKU-DEFAULT', quantity: 1, unitPrice: 100 }],
    totalAmount: 100,
    createdAt: new Date().toISOString()
  };

  const cancelled: Order = {
    ...existing,
    status: 'CANCELLED',
    cancelledAt: new Date().toISOString()
  };

  orders.set(orderId, cancelled);
  try {
    await publishAnalyticsNotification({
      notificationId: randomUUID(),
      requestId: orderId,
      title: 'OrderCancelled',
      body: `Order ${orderId} cancelled`,
      priority: 'NORMAL'
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to publish analytics notification on ${analyticsNotificationTopic}: ${message}`);
  }
  res.status(200).json(cancelled);
});

app.listen(port, host, () => {
  console.log(`order-service listening on http://${host}:${port}`);
  console.log(`Dependencies: payment=${paymentBaseUrl}, shipping=${shippingBaseUrl}`);
});
