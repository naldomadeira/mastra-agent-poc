# Roadmap

Execução sequencial. Cada fase: ler o roadmap → verificar estado → implementar só o necessário →
rodar testes → corrigir → atualizar docs → marcar concluída.

Legenda: `[x]` concluída · `[~]` parcial (ver notas) · `[ ]` pendente

---

## Fase 0 — Discovery `[x]`

Estado encontrado em 2026-09-27:

| Item                         | Resultado                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diretório `mastra-app/`      | **Vazio.** Nenhum código, `package.json`, Mastra ou infra a preservar.                                                                               |
| Diretório irmão `../ai-sdk/` | Vazio. Nada reutilizável.                                                                                                                            |
| Node.js                      | v22.23.2 (Mastra exige ≥ 22.13)                                                                                                                      |
| Package manager              | pnpm 12.4.1 disponível → adotado (projeto novo)                                                                                                      |
| Docker                       | 29.8.0                                                                                                                                               |
| Portas ocupadas              | 5432, 6379 (worker-manager), 7101-7103, 3333, 5000, 7000                                                                                             |
| Portas escolhidas            | **5466** Postgres (exigido) · **3466** Next.js · **4466** Mastra Studio (`mastra dev`)                                                               |
| Chaves de LLM no ambiente    | Nenhuma (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`… ausentes)                                                                                            |
| Versões atuais (npm)         | `@mastra/core` 1.71 · `mastra` 1.31 · `@mastra/pg` 1.27 · `@mastra/memory` 1.32 · `@mastra/mcp` 2.1 · `@mastra/ai-sdk` 1.10 · `next` 16.3 · `ai` 7.0 |

Consequências:

- Scaffold via `create-next-app` (Next 16, App Router, Tailwind 4, TS strict) + Mastra embutido
  em `src/mastra` — padrão oficial de integração Next.js do Mastra. Ver ADR 001.
- Sem chave de LLM, regras de negócio e fluxo de aprovação são validados com **modelo mock
  determinístico**; conversa real exige preencher a chave em `.env`.
- Atualização: o usuário forneceu uma chave de um gateway compatível com a API da Anthropic
  (`ANTHROPIC_BASE_URL`), com cota limitada. Modelo padrão da POC: `claude-haiku-4-5`. Chamadas
  reais ficam restritas a smoke tests manuais; a suíte automatizada nunca chama LLM.

## Fase 1 — Foundation `[x]`

- `docker-compose.yml`: `postgres:17-alpine`, porta `5466:5432`, healthcheck, init que cria o
  banco `commerce_test`.
- Migrations SQL versionadas em `src/infrastructure/database/migrations/` aplicadas por
  `migrator.ts` (tabela `schema_migrations`, uma transação por arquivo). O migrator também
  cria/atualiza a role `agent_readonly` com a senha vinda do `.env` (nada de segredo no SQL).
- Schema: `customers`, `products`, `orders`, `order_items`, `payments` + operacionais
  (`operators`, `notifications`, `audit_log`) + views semânticas (`order_overview`,
  `customer_spend`, `product_sales`).
- Seed determinístico com datas relativas a "agora" (63 pedidos; cenários fixos #1001–#1011).
- `src/config/env.ts` valida o ambiente com Zod.
- `GET /api/health` verifica banco, migrations e que a conexão do agente é read-only.
- Verificado manualmente: `agent_readonly` recebe erro em `DELETE`, `customers.email` e
  `audit_log`.
- Testes: `tests/integration/foundation.test.ts` (2 ✓).

## Fase 2 — Domain `[x]`

- `src/domain/`: tipos (Order, OrderItem, Payment, Customer, Actor), policies puras
  (`cancellationDecision`, `refundDecision`, `isLate`, permissões por papel), portas
  (`ports.ts`) e casos de uso `cancelOrder`, `refundPayment` (+ `previewRefund`),
  `sendCustomerNotification`.
- `auditedAction`: sucesso grava estado + auditoria na mesma transação; falha faz rollback e
  audita a tentativa (`rejected` / `denied` / `error`).
- `src/infrastructure/repositories/`: implementações Postgres + `UnitOfWork`; composition root em
  `src/infrastructure/app-services.ts`.
- Canal HTTP sem IA: `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/cancel`,
  `GET /api/orders/:id/refund-preview`, `GET|POST /api/session` (operador de demonstração).
- Smoke test manual (curl) OK: cancelamento, recusa de pedido pago, preview de reembolso, 403 para
  viewer.
- Testes: `tests/unit/domain-policies.test.ts`, `tests/integration/domain-actions.test.ts`.

## Fase 3 — Database Agent Access `[x]`

- `src/application/knowledge/` (independente do Mastra):
  - `sql-guard.ts`: tokenizador que ignora strings/comentários; um statement; só
    `SELECT`/`WITH`; bloqueia palavras de escrita/DDL/controle, `INTO`, `FOR UPDATE/SHARE`,
    funções de sistema (`pg_*`, `set_config`, `dblink`, `lo_*`…) e catálogos.
  - `query-database.ts`: role `agent_readonly` + `BEGIN READ ONLY` + `statement_timeout` +
    fuso da aplicação + cursor com `FETCH n+1` (limite sem reescrever o SQL); erros do Postgres
    viram mensagens úteis ao modelo; toda execução auditada (sem copiar as linhas no log).
  - `inspect-schema.ts`: schema visível para a role (via `information_schema`, que filtra por
    privilégio) + `COMMENT ON` + FKs + convenções.
- Tools finas: `src/mastra/tools/database/{inspect-schema,query-database}.ts`.
- Ator vem do `RequestContext` (`src/mastra/request-context.ts`); sem ator a tool falha fechado.
- Perguntas do roadmap validadas em teste (total de pedidos, pendentes, maior cliente, vendas do
  mês, atrasados).
- Testes: `tests/unit/sql-guard.test.ts`, `tests/integration/read-access.test.ts`.

## Fase 4 — Agent `[x]`

- `commerceAgent` (`src/mastra/agents/commerce-agent.ts`): factory com modelo injetável; instruções
  curtas e dinâmicas (operador, data/hora local, moeda) via `requestContext` — sem regras de negócio.
- Modelo via model router do Mastra (`MASTRA_MODEL`, padrão local `anthropic/claude-haiku-4-5-20251001`
  através de `ANTHROPIC_BASE_URL`).
- Memória nativa (`@mastra/memory`, `lastMessages: 20`) sobre `PostgresStore` no schema `mastra`;
  thread = conversa, resource = operador.
- `POST /api/chat` (`handleChatStream`, AI SDK v7): corpo com whitelist (`id`, `messages`, `trigger`);
  ator, canal e aprovações montados no servidor; thread de outro operador é recusada.
  `GET /api/chat?threadId=` reidrata o histórico.
- UI (`src/app/_components/chat.tsx`): streaming, tool calls visíveis com estado e SQL, estados de
  carregamento/erro, troca de operador, nova conversa.
- Smoke test real (Haiku via gateway): "Quantos pedidos estão atrasados?" → `inspectSchema` →
  `queryDatabase` sobre `order_overview.is_late` → "3 pedidos"; follow-up "E de quais clientes são?"
  respondido pelo contexto da memória (#1002 João, #1005 Maria, #1008 Camila).
- Testes determinísticos com `MockLanguageModelV3` roteirizado (`tests/helpers/scripted-model.ts`):
  `tests/integration/agent.test.ts`.

## Fase 5 — Domain Actions `[x]`

- Tools finas em `src/mastra/tools/{orders,payments,notifications}/` chamando os casos de uso
  da Fase 2 (Agent → Tool → Use Case → Repository → DB). Cada uma ~20 linhas.
- Saída previsível (`tools/_shared/tool-result.ts`): `{ ok: true, result }` ou
  `{ ok: false, code, error }` para regras de negócio; erros inesperados propagam.
- `readTools` vs `actionTools` separados em `src/mastra/tools/index.ts`.
- Mesmo sem o mecanismo de aprovação do Mastra, `refundPayment` pelo agente é negado pelo domínio
  (`APPROVAL_REQUIRED`) — defesa em profundidade.
- Testes: `tests/integration/action-tools.test.ts`.

## Fase 6 — Human Approval `[x]`

- `refundPayment` com `requireApproval: true` (Mastra suspende antes do `execute`; snapshot no
  Postgres). AI SDK v7 nativo: `tool-approval-request` → cartão Aprovar/Rejeitar →
  `addToolApprovalResponse` → `sendAutomaticallyWhen` reenvia → `handleChatStream` retoma o run.
- Cartão de aprovação mostra ação, pedido, cliente, **valor calculado no backend**
  (`/refund-preview`), motivo e status.
- Evidência persistida em `action_approvals` (migration 0004), vinculada a toolCallId + argumentos,
  consumida uma vez pelo domínio (`src/domain/approvals/approval.ts`). Ver ADR 004.
- Validado na UI real (Haiku): pedido → cartão → Aprovar → reembolso executado → auditoria com
  `approved_by` e evidência consumida.
- Achados empíricos durante o teste manual:
  1. **Alucinação de ação:** com as instruções iniciais, o modelo pediu confirmação em texto e depois
     afirmou "Reembolso processado com sucesso" sem chamar a tool. Nada mudou no banco (a arquitetura
     segurou). Mitigação: instruções comportamentais ("chame a tool; não peça confirmação em texto;
     só afirme execução com `ok: true`") + a UI mostra cada tool call, e a auditoria é a fonte da
     verdade.
  2. **Evidência via RequestContext se perdia na retomada** (snapshot prevalece). Corrigido com
     evidência persistida + teste de regressão.
- Testes: `tests/integration/approval.test.ts` (+ casos em `domain-actions.test.ts`: argumentos
  divergentes, uso único, rejeição, aprovador sem permissão).

## Fase 7 — Workflows `[x]`

- `lateOrderNotificationWorkflow`: identificar → validar → selecionar clientes → preparar
  (template) → aprovação humana (`suspend`/`resume`) → enviar via caso de uso de domínio.
- Regras em funções puras (`src/application/notifications/late-order-campaign.ts`).
- Agente → Workflow pela tool `startLateOrderNotifications`; cartão na UI com prévia, ignorados e
  Aprovar/Rejeitar; retomada em `POST /api/workflows/late-order-notifications/:runId` com aprovador
  da sessão e auditoria da decisão.
- Validado na UI real: agente consultou `order_overview`, delegou ao workflow; prévia com João e
  Maria (Camila ignorada por opt-out); aprovação → "Enviadas: 2. Falhas: 0."
- Critério Agent vs Workflow em ADR 005.
- Testes: `tests/unit/late-order-campaign.test.ts`, `tests/integration/workflow.test.ts`.

## Fase 8 — MCP `[x]`

- `MCPServer` stdio (`pnpm mcp`) expondo `inspectSchema` e `queryDatabase` sobre a mesma camada de
  aplicação; identidade por `MCP_OPERATOR_ID`; auditoria com canal `mcp`.
- Escopo somente leitura e não exposto via HTTP sem auth — decisão e próximos passos no ADR 006.
- Teste de protocolo real (`MCPClient` → subprocesso stdio → Postgres): `tests/integration/mcp.test.ts`.

## Fase 9 — Observability `[x]`

- **Tracing Mastra** (`@mastra/observability`, `MastraStorageExporter` + `SensitiveDataFilter`):
  spans de agente, inferência, tool calls, memória e workflows no Postgres (`mastra.mastra_ai_spans`),
  com `actor.id`, `actor.role` e `channel` como metadados. Verificado após chamada real.
- **Logs**: `PinoLogger` estruturado.
- **Histórico/auditoria de capabilities**: `audit_log` (leituras e ações, qualquer canal) +
  página `/audit` (permissão `audit:read`, só manager) respondendo quem pediu, qual agente/run,
  capability, parâmetros, resultado, erro, se exigiu aprovação, quem aprovou e quando.
- **Mastra Studio**: `pnpm dev:mastra` → http://localhost:4466 (traces, testar agente/tools/workflow).
  `PORT=4466` no script alinha o banner e a retomada de runs com `server.port`.
- Limitação: o dashboard de métricas do Studio exige um store OLAP (ex.: DuckDB/ClickHouse);
  Postgres não é suportado para métricas. Traces funcionam.

## Fase 10 — Tests `[x]`

112 testes (Vitest), nenhum chama LLM real. Integração contra Postgres real (`commerce_test`).

| Área                                                               | Arquivo                                    |
| ------------------------------------------------------------------ | ------------------------------------------ |
| Policies de domínio e permissões                                   | `tests/unit/domain-policies.test.ts`       |
| Guard SQL                                                          | `tests/unit/sql-guard.test.ts`             |
| Regras da campanha (workflow)                                      | `tests/unit/late-order-campaign.test.ts`   |
| Regras de arquitetura (sem CRUD, Tool → Use Case, domínio isolado) | `tests/unit/architecture.test.ts`          |
| Fundação / health                                                  | `tests/integration/foundation.test.ts`     |
| Repositórios, transação, concorrência, approvals                   | `tests/integration/repositories.test.ts`   |
| Casos de uso + autorização + auditoria                             | `tests/integration/domain-actions.test.ts` |
| Capability de leitura (limites, PII, role)                         | `tests/integration/read-access.test.ts`    |
| Action tools                                                       | `tests/integration/action-tools.test.ts`   |
| Aprovação humana (suspend/approve/decline/regressão)               | `tests/integration/approval.test.ts`       |
| Agente com modelo mock roteirizado (tools, memória, instruções)    | `tests/integration/agent.test.ts`          |
| Workflow                                                           | `tests/integration/workflow.test.ts`       |
| MCP (protocolo real via stdio)                                     | `tests/integration/mcp.test.ts`            |

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` passando.

## Fase 11 — Documentation `[x]`

- `README.md`: instalar, `.env`, Docker, migrations, seed, Mastra Studio, Next.js, testes, como
  testar o agente, como adicionar domain action / tool / agente / MCP, fluxo de aprovação.
- `specs/architecture.md`: arquitetura, fluxos, segurança, observabilidade, conclusão
  generic vs semantic, achados empíricos, limitações, uso como boilerplate.
- `specs/README.md` + ADRs 001–006.

## Fase 12 — Agent Evaluation & Security Benchmark `[x]`

- Suíte portável em `evals/`: casos (`cases.json`), schema de casos/resultados, avaliador e runner
  independentes de framework; adaptador `targets/mastra.ts`. A POC AI SDK roda os mesmos casos
  implementando `EvalTarget`.
- 13 casos cobrindo as 12 categorias da matriz (tool selection, contexto, permissão, sucesso falso,
  política inventada, disciplina de schema, prompt injection, SQL destrutivo via agente e direto no
  banco, integridade e replay de aprovação, idempotência e aprovação de workflow).
- Modos `live` (LLM real: behavior + safety) e `adversarial` (modelo roteirizado que se comporta
  mal: só safety, sem LLM, também no `pnpm test`).
- Resultado normalizado por caso (`EvalResult`) com tool calls, diff do banco por linha,
  aprovação e auditoria; baselines em `evals/baseline/`.
- Resultados: adversarial 9/10 (safety 63/65); live Haiku 7/8 (safety 35/35, behavior 29/30).
  Findings: risco residual de ação permitida sem aprovação (EV-01), política inventada (EV-05),
  read-only garantido pelos grants e não pelo padrão de sessão (EV-08b). Detalhes em
  [evaluation.md](evaluation.md).
- Nenhuma funcionalidade de produto alterada; findings registrados, não corrigidos.
- Pós-avaliação:
  - convenção de busca de nomes (`ILIKE`) em `inspectSchema` após a falha do EV-02 numa segunda
    amostra; EV-02 passou em 5/5 execuções depois do ajuste;
  - correção de bug encontrado no teste manual: reabrir uma conversa antiga mostrava de novo os
    botões de aprovação de um workflow já decidido, e aprovar gerava erro 500. A rota agora
    responde 409 (`ALREADY_DECIDED`) e o cartão consulta o estado real do run (`GET`) ao abrir.
- Testes: 118 (`tests/unit/eval-cases.test.ts`, `tests/integration/eval-adversarial.test.ts`).

---

## Balanço final

Estado publicado como experimento técnico público no GitHub (repositório `mastra-agent-poc`). Uma POC
equivalente com AI SDK será comparada depois, rodando os mesmos cenários nas duas implementações;
nenhuma comparação foi feita ainda.

### Implementado e verificado

| Entregável                         | Evidência                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Docker Compose, Postgres em `5466` | `pnpm db:up`; `GET /api/health` ok                                                       |
| Schema/migrations versionadas      | 4 migrations, `schema_migrations`                                                        |
| Seed                               | 63 pedidos, cenários fixos #1001–#1011                                                   |
| Agent (`commerceAgent`)            | smoke tests reais (Haiku via gateway) + testes com modelo mock                           |
| Database read capability           | role read-only + guard + timeout + limite + auditoria; testes                            |
| Domain action tools                | `cancelOrder`, `refundPayment`, `sendCustomerNotification`; testes                       |
| Human approval                     | fluxo completo validado na UI real; testes de approve/decline/regressão                  |
| Memory                             | follow-up resolvido pelo contexto em chamada real; teste determinístico                  |
| Workflow                           | executado na UI real (2 enviadas, 1 ignorada por opt-out); testes                        |
| MCP básico                         | servidor stdio; teste de protocolo real com `MCPClient`                                  |
| Observabilidade/auditoria          | spans no Postgres com ator/canal; `/audit`                                               |
| Testes                             | 118 passando (112 até a Fase 11 + 6 da Fase 12); lint, typecheck e build ok              |
| Avaliação (Fase 12)                | adversarial 9/10 (safety 63/65); live Haiku 7/8 (behavior 29/30) — `specs/evaluation.md` |

### Não implementado (e por quê)

| Item                                  | Motivo                                                                | Próximo passo                                                           |
| ------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Autenticação real                     | fora do escopo da POC; sessão de demonstração por cookie              | NextAuth/Clerk/SSO resolvendo o mesmo `Actor`                           |
| Ações via MCP e MCP via HTTP          | exigem canal de aprovação no protocolo e auth                         | ADR 006                                                                 |
| Métricas no Studio                    | Mastra exige store OLAP para métricas                                 | `MastraCompositeStore` com DuckDB/ClickHouse no domínio `observability` |
| Envio real de notificações            | fora do escopo; o canal é simulado                                    | adapter de e-mail atrás de uma porta do domínio                         |
| Guardrail contra "alucinação de ação" | mitigado por instruções + UI + auditoria                              | output processor que valide afirmações de execução contra tool results  |
| shadcn/ui / AI Elements               | UI simples com Tailwind foi suficiente; evitou dezenas de componentes | adotar se a UI crescer                                                  |
| Teste E2E automatizado de UI          | fluxo validado manualmente no navegador                               | Playwright cobrindo aprovação e workflow                                |
| Four-eyes (aprovador ≠ solicitante)   | self-approval de manager mantido para demo com um usuário             | `approver.id !== actor.id` em `consumeApproval`                         |
| RLS para cenários customer-facing     | a POC atende operadores internos                                      | policies RLS por cliente + role por sessão                              |
| OpenTelemetry                         | tracing nativo do Mastra foi suficiente                               | exporter OTel (`@mastra/observability` bridges)                         |

## Fase 13 — Agent Core Extraction `[x]`

A Fase 13 extraiu o contrato arquitetural comum demonstrado pelas duas POCs, sem introduzir uma terceira implementação de runtime.

- [x] Fronteira Agent Core/runtime documentada em `specs/phase-13-agent-core-extraction.md`.
- [x] Contrato conceitual v0.1 em `specs/agent-core-contract.md`.
- [x] Capability, Registry e Executor identificados como abstrações comuns.
- [x] Actor/context, autorização, aprovação e auditoria definidos como infraestrutura independente do runtime.
- [x] Read, domain action e workflow capabilities diferenciadas.
- [x] Responsabilidades específicas do Mastra mantidas no adapter/runtime.
- [x] Regras de segurança documentadas como invariantes da aplicação, não do prompt.
- [x] Nenhuma mudança funcional na POC.

A extração deliberadamente permanece como contrato/documentação. Um pacote compartilhado só deve ser criado depois de validar o contrato em uma terceira aplicação real, evitando abstração prematura.