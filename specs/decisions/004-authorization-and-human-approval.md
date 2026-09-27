# ADR 004 — Autorização no backend e aprovação humana em duas camadas

- Status: aceito
- Data: 2026-09-27

## Contexto

"LLM decides WHAT it wants to do. Application decides WHETHER it is allowed to do it."
A aprovação humana não pode depender só de um flag de UI ou de framework.

## Decisão

1. **Identidade vem do servidor.** A rota monta o `RequestContext` (`actor`, `channel`) a partir
   da sessão. O corpo da requisição de chat é filtrado por whitelist
   (`id`, `messages`, `trigger`): `requestContext`, `runId` e `resumeData` enviados pelo cliente
   são descartados. As tools leem o ator do contexto e falham fechado sem ele.
2. **Permissões por papel no domínio** (`src/domain/operators/operator.ts`): `viewer`, `support`,
   `manager`. Reembolso separa _pedir_ (`payments:refund:request`) de _aprovar_
   (`payments:refund:approve`).
3. **Aprovação — camada 1 (Mastra):** `refundPayment` tem `requireApproval: true`. O run é suspenso
   antes do `execute` (snapshot no storage) e a UI recebe `tool-approval-request` (AI SDK v7).
   Aprovar/Rejeitar usa `addToolApprovalResponse`; o `handleChatStream` retoma o run.
4. **Aprovação — camada 2 (domínio, evidência persistida):** ao receber Aprovar/Rejeitar, a rota
   grava em `action_approvals` a decisão: `tool_call_id`, `run_id`, capability, **argumentos exatos**
   exibidos, `approver_id` = operador da sessão. Para canais automatizados (`agent`, `mcp`,
   `workflow`), o caso de uso (`consumeApproval`) exige uma decisão aprovada para o mesmo
   toolCallId, mesma capability e mesmos argumentos (JSON canônico), dada por alguém com
   `payments:refund:approve`, e a **consome** na mesma transação da ação (uso único). Sem isso:
   `APPROVAL_REQUIRED` / `FORBIDDEN`, mesmo que o flag do Mastra seja removido por engano.
5. **Valores sensíveis não vêm do modelo:** o reembolso é do valor capturado; o cartão de aprovação
   mostra cliente e valor calculados pelo backend (`/api/orders/:id/refund-preview`).
6. **Auditoria:** a ação grava `actor_id`, `approval_required`, `approved_by`, `approved_at`,
   `tool_call_id`, `thread_id`; recusas de aprovação são auditadas pela rota.

## Histórico

A primeira versão passava a evidência de aprovação pelo `RequestContext` na retomada. O teste
manual na UI revelou que o Mastra restaura o `requestContext` salvo no snapshot do run suspenso, e o
valor do snapshot prevaleceu: a aprovação não chegava à tool. O domínio falhou fechado (nada foi
reembolsado), mas o fluxo quebrou. A evidência passou a ser persistida — mais robusto, auditável e
alinhado à recomendação do Mastra de vincular a aprovação aos argumentos exatos. Há teste de
regressão em `tests/integration/approval.test.ts`.

## Consequências

- Um operador `support` pode pedir reembolso ao agente, mas só um `manager` aprova.
- Self-approval de manager é permitido nesta POC (demo com um usuário). Four-eyes seria uma linha
  a mais na policy (`approver.id !== actor.id`).
- Aprovações sobrevivem a restart porque o snapshot do run está no Postgres
  (`agent.listSuspendedRuns` permite rediscovery).

## Adendo (2026-09-27) — aprovação do workflow e tentativas recusadas

- A decisão sobre o envio em lote segue o mesmo modelo: evidência persistida em `action_approvals`
  (chave `wf:<workflow>:<runId>`, primeira decisão vence), auditada **antes** da retomada e
  consumida uma única vez pelo passo de envio. Uma retomada que não passou pela decisão registrada
  falha sem enviar nada (`decideLateOrderNotifications`).
- O envio executa em nome do **solicitante**; o aprovador, a `approval_id` e o momento da decisão
  ficam na própria linha de auditoria de cada envio.
- Decisões recusadas (já decididas, concorrentes, sem permissão, run inexistente) e decisões
  repetidas no chat são auditadas como `denied`, com código e `correlation_id`.
