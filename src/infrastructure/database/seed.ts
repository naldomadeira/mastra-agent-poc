import type pg from 'pg';

/**
 * Seed determinístico. Datas são relativas ao momento da execução para que perguntas como
 * "pedidos de hoje", "este mês" e "atrasados" sempre tenham resposta.
 *
 * Os primeiros pedidos (#1001…#1011) são cenários fixos usados na demo e nos testes;
 * o restante é gerado por um PRNG com semente fixa.
 */

export const OPERATORS = [
  { id: 'ana', name: 'Ana Lima', role: 'manager' },
  { id: 'bruno', name: 'Bruno Costa', role: 'support' },
  { id: 'carla', name: 'Carla Mendes', role: 'viewer' },
] as const;

const CUSTOMERS = [
  ['João Silva', 'joao.silva@example.com', 'São Paulo', false],
  ['Maria Souza', 'maria.souza@example.com', 'Rio de Janeiro', false],
  ['Pedro Santos', 'pedro.santos@example.com', 'Belo Horizonte', false],
  ['Ana Oliveira', 'ana.oliveira@example.com', 'Curitiba', false],
  ['Lucas Pereira', 'lucas.pereira@example.com', 'Porto Alegre', false],
  ['Juliana Costa', 'juliana.costa@example.com', 'Salvador', false],
  ['Rafael Almeida', 'rafael.almeida@example.com', 'Recife', false],
  ['Fernanda Lima', 'fernanda.lima@example.com', 'Fortaleza', false],
  ['Gabriel Rocha', 'gabriel.rocha@example.com', 'Brasília', false],
  ['Camila Ribeiro', 'camila.ribeiro@example.com', 'Campinas', true],
  ['Thiago Martins', 'thiago.martins@example.com', 'Florianópolis', false],
  ['Beatriz Carvalho', 'beatriz.carvalho@example.com', 'Manaus', false],
] as const;

const PRODUCTS = [
  ['NB-001', 'Notebook Pro 14', 'Informática', 749_900],
  ['MN-002', 'Monitor 27" 4K', 'Informática', 219_900],
  ['KB-003', 'Teclado Mecânico', 'Periféricos', 49_990],
  ['MS-004', 'Mouse sem fio', 'Periféricos', 12_990],
  ['HP-005', 'Headphone ANC', 'Áudio', 129_900],
  ['SP-006', 'Caixa de som Bluetooth', 'Áudio', 39_990],
  ['PH-007', 'Smartphone X', 'Celulares', 399_900],
  ['CS-008', 'Capa para Smartphone', 'Acessórios', 5_990],
  ['CH-009', 'Carregador USB-C 65W', 'Acessórios', 17_990],
  ['WC-010', 'Webcam Full HD', 'Periféricos', 29_990],
] as const;

type OrderStatus = 'pending_payment' | 'paid' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';

type OrderSpec = {
  customer: number; // índice 1-based em CUSTOMERS
  status: OrderStatus;
  daysAgo: number;
  items: Array<[product: number, quantity: number]>; // produto 1-based
  shipWithinDays?: number;
  method?: 'pix' | 'credit_card' | 'boleto';
};

const SCENARIOS: OrderSpec[] = [
  {
    customer: 1,
    status: 'pending_payment',
    daysAgo: 0,
    items: [
      [3, 1],
      [4, 1],
    ],
    method: 'boleto',
  }, // #1001 cancelável
  { customer: 1, status: 'paid', daysAgo: 6, items: [[5, 1]] }, // #1002 atrasado, reembolsável
  {
    customer: 1,
    status: 'delivered',
    daysAgo: 20,
    items: [
      [1, 1],
      [2, 1],
    ],
  }, // #1003 o mais caro do João
  {
    customer: 2,
    status: 'paid',
    daysAgo: 0,
    items: [
      [7, 1],
      [8, 2],
    ],
  }, // #1004 pago hoje, no prazo
  { customer: 2, status: 'paid', daysAgo: 5, items: [[6, 2]] }, // #1005 atrasado
  { customer: 3, status: 'pending_payment', daysAgo: 2, items: [[10, 1]], method: 'pix' }, // #1006 cancelável
  { customer: 3, status: 'shipped', daysAgo: 4, items: [[9, 2]] }, // #1007 enviado: não cancelável
  { customer: 10, status: 'paid', daysAgo: 7, items: [[4, 3]] }, // #1008 atrasado, cliente opt-out
  { customer: 5, status: 'cancelled', daysAgo: 12, items: [[2, 1]] }, // #1009
  { customer: 6, status: 'refunded', daysAgo: 15, items: [[5, 1]] }, // #1010
  { customer: 7, status: 'delivered', daysAgo: 120, items: [[7, 1]] }, // #1011 fora da janela de reembolso
];

/** PRNG determinístico (mulberry32). */
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generatedOrders(count: number): OrderSpec[] {
  const rand = prng(42);
  const pick = (n: number) => 1 + Math.floor(rand() * n);
  const methods = ['pix', 'credit_card', 'boleto'] as const;
  return Array.from({ length: count }, () => {
    const daysAgo = Math.floor(rand() * 75);
    const r = rand();
    let status: OrderStatus;
    if (daysAgo === 0) status = r < 0.5 ? 'pending_payment' : 'paid';
    else if (daysAgo <= 2) status = r < 0.25 ? 'pending_payment' : 'paid';
    else if (daysAgo <= 8) status = r < 0.6 ? 'shipped' : r < 0.9 ? 'delivered' : 'cancelled';
    else status = r < 0.82 ? 'delivered' : r < 0.92 ? 'cancelled' : 'refunded';
    const items: Array<[number, number]> = Array.from({ length: pick(3) }, () => [pick(PRODUCTS.length), pick(2)]);
    return { customer: pick(CUSTOMERS.length), status, daysAgo, items, method: methods[pick(3) - 1] };
  });
}

function paymentStatus(status: OrderStatus): 'pending' | 'captured' | 'voided' | 'refunded' {
  if (status === 'pending_payment') return 'pending';
  if (status === 'cancelled') return 'voided';
  if (status === 'refunded') return 'refunded';
  return 'captured';
}

export async function seed(client: pg.Client | pg.PoolClient): Promise<{ orders: number }> {
  await client.query('BEGIN');
  try {
    await client.query(`TRUNCATE action_approvals, audit_log, notifications, payments, order_items, orders, products, customers, operators
                        RESTART IDENTITY CASCADE`);

    for (const op of OPERATORS) {
      await client.query('INSERT INTO operators(id, name, role) VALUES ($1,$2,$3)', [op.id, op.name, op.role]);
    }
    for (const [name, email, city, optOut] of CUSTOMERS) {
      await client.query(
        `INSERT INTO customers(name, email, city, notifications_opt_out, created_at)
         VALUES ($1,$2,$3,$4, now() - interval '200 days')`,
        [name, email, city, optOut],
      );
    }
    for (const [sku, name, category, price] of PRODUCTS) {
      await client.query('INSERT INTO products(sku, name, category, price_cents) VALUES ($1,$2,$3,$4)', [
        sku,
        name,
        category,
        price,
      ]);
    }

    const specs = [...SCENARIOS, ...generatedOrders(52)];
    for (const [index, spec] of specs.entries()) {
      await insertOrder(client, spec, index);
    }

    await client.query('COMMIT');
    return { orders: specs.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function insertOrder(client: pg.Client | pg.PoolClient, spec: OrderSpec, index: number): Promise<void> {
  const total = spec.items.reduce((sum, [p, q]) => sum + PRODUCTS[p - 1][3] * q, 0);
  // Horário varia por pedido; pedidos de "hoje" ficam no início do dia para não cair no futuro.
  const minutesOffset = spec.daysAgo === 0 ? 5 + (index % 50) : (index * 37) % 600;
  const placedAt = `now() - interval '${spec.daysAgo} days' - interval '${minutesOffset} minutes'`;
  const shipWithin = spec.shipWithinDays ?? 3;
  const s = spec.status;

  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO orders(customer_id, status, total_cents, placed_at, expected_ship_by,
                        shipped_at, delivered_at, cancelled_at, cancellation_reason)
     VALUES ($1, $2, $3, ${placedAt}, ${placedAt} + interval '${shipWithin} days',
             CASE WHEN $2 IN ('shipped','delivered','refunded') THEN ${placedAt} + interval '1 day' END,
             CASE WHEN $2 IN ('delivered','refunded') THEN ${placedAt} + interval '3 days' END,
             CASE WHEN $2 = 'cancelled' THEN ${placedAt} + interval '2 hours' END,
             CASE WHEN $2 = 'cancelled' THEN 'Cliente desistiu da compra' END)
     RETURNING id`,
    [spec.customer, s, total],
  );
  const orderId = rows[0].id;

  for (const [p, q] of spec.items) {
    await client.query(
      'INSERT INTO order_items(order_id, product_id, quantity, unit_price_cents) VALUES ($1,$2,$3,$4)',
      [orderId, p, q, PRODUCTS[p - 1][3]],
    );
  }

  const ps = paymentStatus(s);
  await client.query(
    `INSERT INTO payments(order_id, method, status, amount_cents, created_at, captured_at, refunded_at, refund_reason)
     VALUES ($1, $2, $3, $4, ${placedAt},
             CASE WHEN $3 IN ('captured','refunded') THEN ${placedAt} + interval '10 minutes' END,
             CASE WHEN $3 = 'refunded' THEN ${placedAt} + interval '5 days' END,
             CASE WHEN $3 = 'refunded' THEN 'Produto com defeito' END)`,
    [orderId, spec.method ?? 'credit_card', ps, total],
  );
}
