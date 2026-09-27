# ADR 003 — Domain Actions como tools semânticas (não CRUD)

- Status: aceito
- Data: 2026-09-27

## Contexto

Expor métodos de repository (`updateOrder`, `deletePayment`…) como tools transfere regras de
negócio para o prompt e multiplica a superfície de ataque.

## Decisão

- Cada escrita é um **caso de uso** do domínio (`cancelOrder`, `refundPayment`,
  `sendCustomerNotification`) em `src/domain/*/`, que:
  valida entrada → autoriza o ator → carrega o agregado → aplica regras → persiste em transação
  → registra auditoria na mesma transação → retorna resultado tipado.
- A tool Mastra é um **adaptador fino** (`src/mastra/tools/*`): schema Zod para o modelo,
  extração do ator a partir do `requestContext` (nunca do modelo), chamada ao caso de uso,
  mapeamento de erro de domínio para saída previsível.
- Os mesmos casos de uso são chamados pela API HTTP (`/api/orders/[id]/cancel`), pelo workflow
  e poderiam ser chamados por CLI/jobs/webhooks sem duplicação.
- Inputs sensíveis são calculados no servidor: o reembolso não recebe valor do modelo; o valor
  é o capturado no pagamento.

## Consequências

- Poucas tools, cada uma com significado de negócio claro.
- Regras testáveis sem LLM.
