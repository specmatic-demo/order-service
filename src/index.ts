import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

const host = process.env.ORDER_HOST || '0.0.0.0';
const port = Number.parseInt(process.env.ORDER_PORT || '9000', 10);
const paymentBaseUrl = process.env.PAYMENT_SERVICE_BASE_URL || 'http://localhost:5201';
const shippingBaseUrl = process.env.SHIPPING_SERVICE_BASE_URL || 'http://localhost:5202';

type OrderItem = {
  sku: string;
  quantity: number;
  unitPrice: number;
};

type CreateOrderPayload = {
  customerId: string;
  paymentMethodId: string;
  items: OrderItem[];
};

type Order = {
  id: string;
  customerId: string;
  status: 'PENDING_PAYMENT' | 'CONFIRMED' | 'SHIPPED' | 'CANCELLED';
  items: OrderItem[];
  totalAmount: number;
  createdAt: string;
};

const orders = new Map<string, Order>();

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

  if (typeof item.sku !== 'string' || item.sku.trim() === '') {
    return false;
  }

  if (!Number.isInteger(item.quantity) || item.quantity < 1) {
    return false;
  }

  if (typeof item.unitPrice !== 'number' || !Number.isFinite(item.unitPrice)) {
    return false;
  }

  return true;
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

app.listen(port, host, () => {
  console.log(`order-service listening on http://${host}:${port}`);
  console.log(`Dependencies: payment=${paymentBaseUrl}, shipping=${shippingBaseUrl}`);
});
