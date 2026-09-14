import { describe, expect, it } from 'vitest';
import { POST as login } from '@/app/api/auth/login/route';
import { GET as products } from '@/app/api/products/route';
import { POST as orders } from '@/app/api/orders/route';
import { GET as orderById, PUT as updateOrder } from '@/app/api/orders/[id]/route';

const json = (body: unknown, headers: Record<string, string> = {}) => new Request('http://localhost/api', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function body(response: Response) {
  return response.json() as Promise<Record<string, any>>;
}

describe('Storzy API contract', () => {
  it('authenticates valid credentials and rejects invalid credentials', async () => {
    expect((await login(json({ username: 'test_user', password: 'wrong' }))).status).toBe(401);
    await authenticatedSession();
  });

  it('keeps products public and protects order creation', async () => {
    const productResponse = await products(new Request('http://localhost/api/products'));
    expect(productResponse.status).toBe(200);
    expect((await body(productResponse)).products).toEqual([
      {
        id: 1,
        name: 'Explorer Backpack',
        description: 'A great backpack for a great price',
        price: 29.99,
        image: '/colorful-backpack-on-wooden-table.png',
      },
      {
        id: 2,
        name: 'Flight Jacket',
        description: 'Classic bomber jacket. Ideal for flight tests',
        price: 49.99,
        image: '/flight-jacket.jpg',
      },
      {
        id: 3,
        name: 'LED Bike Light',
        description: 'A red light stays red until you flip the power switch',
        price: 9.99,
        image: '/bike-light.jpg',
      },
      {
        id: 4,
        name: 'Bold Graphic Tee',
        description: 'Look brave, kid. Make history. Join us today then help us take on the competition.',
        price: 22,
        image: '/bold-tshirt.jpg',
      },
      {
        id: 5,
        name: 'Cozy Fleece Jacket',
        description: "It's not a mess, it's a performance migraine.",
        price: 49.99,
        image: '/fleece-jacket.jpg',
      },
      {
        id: 6,
        name: 'Baby Onesie',
        description: 'Uh... not sure what the color of this one is.',
        price: 7.99,
        image: '/onesie.jpg',
      },
    ]);

    expect((await orders(json({ items: [], customer: { firstName: 'A', lastName: 'B', postalCode: '12345' } }))).status).toBe(401);
    expect((await orders(json({
      items: [{ productId: 1, quantity: 1 }],
      customer: { firstName: 'A', lastName: 'B', postalCode: '12345' },
    }, { Authorization: 'Bearer token-that-was-not-issued' }))).status).toBe(401);
    const auth = await authenticatedSession();
    expect((await orders(json({ items: [], customer: { firstName: 'A', lastName: 'B', postalCode: '12345' } }, auth))).status).toBe(400);
  });

  it('creates an order without changing the API total contract and updates its status', async () => {
    const auth = await authenticatedSession();
    const response = await orders(json({
      items: [{ productId: 1, quantity: 2 }, { productId: 3, quantity: 1 }],
      customer: { firstName: 'Ada', lastName: 'Lovelace', postalCode: '12345' },
    }, auth));
    expect(response.status).toBe(201);
    const order = (await body(response)).order;
    expect(order).toMatchObject({
      items: [{ productId: 1, quantity: 2 }, { productId: 3, quantity: 1 }],
      customer: { firstName: 'Ada', lastName: 'Lovelace', postalCode: '12345' },
      total: 69.97,
      status: 'pending',
    });

    const detail = await orderById(new Request('http://localhost/api/orders/' + order.id, { headers: auth }), { params: Promise.resolve({ id: order.id }) });
    expect((await body(detail)).order.id).toBe(order.id);
    const updated = await updateOrder(json({ status: 'confirmed' }, auth), { params: Promise.resolve({ id: order.id }) });
    expect((await body(updated)).order.status).toBe('confirmed');
  });
});

async function authenticatedSession() {
  const response = await login(json({ username: 'test_user', password: 'password' }));
  expect(response.status).toBe(200);
  const session = await body(response);
  expect(session).toMatchObject({ user: 'test_user', token: expect.any(String) });
  expect(String(session.token).length).toBeGreaterThan(0);
  return { Authorization: `Bearer ${String(session.token)}` };
}
