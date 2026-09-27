# ADR 005 — Quando usar Agent e quando usar Workflow

- Status: aceito
- Data: 2026-09-27

## Contexto

"Descubra quais pedidos estão atrasados e me diga quem avisar" e "encontre os atrasados e envie
notificações" parecem iguais, mas têm naturezas diferentes.

## Decisão

| Use **Agent** quando…                                                                        | Use **Workflow** quando…                                       |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| o caminho depende de interpretação (qual consulta? qual filtro? o que o usuário quis dizer?) | o caminho é conhecido e deve ser sempre o mesmo                |
| a saída é uma resposta/explicação                                                            | a saída é um efeito em lote (enviar, processar, conciliar)     |
| erros podem ser corrigidos conversando                                                       | cada etapa precisa ser auditável, retomável e testável sem LLM |

- `lateOrderNotificationWorkflow` (`src/mastra/workflows/late-order-notifications.ts`):
  identificar → validar → selecionar clientes → preparar (template, sem LLM) → **aprovação
  (suspend)** → enviar (via `sendCustomerNotification`, em nome do aprovador).
- As regras (atraso, opt-out, dedupe de 24h, texto da mensagem) são funções puras em
  `src/application/notifications/late-order-campaign.ts`; os passos só fazem I/O e orquestração.
- **Ponte:** o agente tem a tool `startLateOrderNotifications`. Ele reconhece a intenção e delega;
  não improvisa uma sequência de `sendCustomerNotification`. A retomada vem da UI por
  `POST /api/workflows/late-order-notifications/:runId`, com aprovador = operador da sessão.
- O workflow também é exposto via MCP como `run_lateOrderNotificationWorkflow` (ADR 006).

## Consequências

- O mesmo processo pode ser disparado por agente, cron, HTTP ou MCP sem mudar.
- Rodar duas vezes não reenvia: pedidos avisados nas últimas 24h são ignorados.
- Limitação conhecida: uma notificação por cliente registra apenas o primeiro pedido em
  `notifications.order_id`; o dedupe de pedidos agrupados é, portanto, parcial.
