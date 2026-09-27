# ADR 002 — Separação READ vs WRITE

- Status: aceito
- Data: 2026-09-27

## Contexto

Queremos que o agente responda perguntas arbitrárias sobre os dados sem criar uma tool por
consulta, mas sem nunca permitir `AI → SQL WRITE → Database`.

## Decisão

**READ** — uma capability genérica `queryDatabase` (Text-to-SQL controlado), com defesa em
profundidade:

1. Guard léxico: um único statement, começa com `SELECT`/`WITH`, sem palavras-chave de
   escrita/DDL/controle (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`,
   `GRANT`, `COPY`, `SET`, `CALL`, `DO`, `LOCK`…) e sem funções perigosas (`pg_sleep`,
   `set_config`, `pg_read_file`, `dblink`, `lo_*`…).
2. Conexão com role Postgres dedicada `agent_readonly`: `SELECT` apenas nas tabelas de negócio e
   views semânticas; sem acesso a `audit_log`, `operators`, `notifications` nem ao schema do
   Mastra; `default_transaction_read_only = on`.
3. Transação `READ ONLY` + `statement_timeout` por execução.
4. Limite de linhas (envelopa a query em `SELECT * FROM (...) LIMIT n+1` e sinaliza truncamento).
5. Toda execução (aceita ou rejeitada) vai para `audit_log`.

O conhecimento do schema vem do próprio banco (`COMMENT ON` + `information_schema` visto pela
role readonly) e de **views semânticas** (`order_overview`, `customer_spend`) que codificam
definições de negócio como "pedido atrasado" — o modelo não inventa a regra.

**WRITE** — somente por Domain Actions (ADR 003). Não existe tool de escrita genérica.

## Consequências

- Perguntas novas não exigem código novo.
- A garantia de "somente leitura" não depende do guard: mesmo que ele falhe, a role não tem
  permissão de escrita e a transação é read-only.
