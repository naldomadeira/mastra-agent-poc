-- Camada semântica: definições de negócio codificadas em views,
-- para que o agente não precise (nem possa) inventar regras como "atrasado" ou "receita".

CREATE VIEW order_overview AS
SELECT
  o.id                                  AS order_id,
  o.customer_id,
  c.name                                AS customer_name,
  o.status,
  o.placed_at,
  o.expected_ship_by,
  o.shipped_at,
  o.delivered_at,
  o.total_cents,
  round(o.total_cents / 100.0, 2)       AS total_brl,
  p.status                              AS payment_status,
  p.method                              AS payment_method,
  (o.status = 'paid' AND o.expected_ship_by < now()) AS is_late,
  (SELECT coalesce(sum(i.quantity), 0) FROM order_items i WHERE i.order_id = o.id) AS item_count
FROM orders o
JOIN customers c ON c.id = o.customer_id
LEFT JOIN payments p ON p.order_id = o.id;

COMMENT ON VIEW order_overview IS
  'Visão consolidada de pedidos. is_late = pago, não enviado e após expected_ship_by. Prefira esta view para perguntas sobre pedidos.';

CREATE VIEW customer_spend AS
SELECT
  c.id                                               AS customer_id,
  c.name                                             AS customer_name,
  c.city,
  count(p.id)                                        AS paid_orders,
  round(coalesce(sum(p.amount_cents), 0) / 100.0, 2) AS total_spent_brl,
  max(p.captured_at)                                 AS last_purchase_at
FROM customers c
LEFT JOIN orders o   ON o.customer_id = c.id
LEFT JOIN payments p ON p.order_id = o.id AND p.status = 'captured'
GROUP BY c.id, c.name, c.city;

COMMENT ON VIEW customer_spend IS
  'Gasto histórico por cliente = soma de pagamentos capturados (reembolsados não contam). Para períodos, use payments.captured_at.';

CREATE VIEW product_sales AS
SELECT
  pr.id        AS product_id,
  pr.name      AS product_name,
  pr.category,
  coalesce(sum(i.quantity) FILTER (WHERE o.status IN ('paid','shipped','delivered')), 0) AS units_sold,
  round(coalesce(sum(i.quantity * i.unit_price_cents)
        FILTER (WHERE o.status IN ('paid','shipped','delivered')), 0) / 100.0, 2)         AS revenue_brl
FROM products pr
LEFT JOIN order_items i ON i.product_id = pr.id
LEFT JOIN orders o      ON o.id = i.order_id
GROUP BY pr.id, pr.name, pr.category;

COMMENT ON VIEW product_sales IS
  'Vendas por produto, contando apenas pedidos efetivados (paid, shipped, delivered).';

-- Role do agente: existe antes desta migration (criada pelo migrator com senha do .env).
-- Somente SELECT, somente no que o agente precisa saber. Sem e-mail de cliente (PII),
-- sem tabelas operacionais, sem schema do Mastra.
GRANT USAGE ON SCHEMA public TO agent_readonly;
GRANT SELECT (id, name, city, notifications_opt_out, created_at) ON customers TO agent_readonly;
GRANT SELECT ON products, orders, order_items, payments TO agent_readonly;
GRANT SELECT ON order_overview, customer_spend, product_sales TO agent_readonly;
