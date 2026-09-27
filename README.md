# Mastra Agent Architecture POC

> **Status: experimento técnico / POC arquitetural.** Não é uma biblioteca nem um produto pronto
> para produção. O objetivo é investigar e documentar um desenho, com seus limites.

Uma aplicação fictícia de e-commerce (Next.js + PostgreSQL) com um agente de IA construído com
[Mastra](https://mastra.ai). O agente consulta dados, executa ações, respeita autorização, pede
aprovação humana, mantém contexto e dispara workflows, **sem uma tool para cada método CRUD**.

## O que é

Uma POC de arquitetura de _Agent Operating Layer_: uma camada de **capabilities** entre o agente e
a aplicação. O agente conhece a aplicação por 6 capabilities bem definidas, e as regras de negócio,
a autorização e a aprovação ficam no código e no banco, não no prompt.

Documentação completa, decisões (ADRs) e roadmap estão em [`specs/`](specs/README.md).

## Problema

Como permitir que um agente:

- consulte dados;
- execute ações;
- respeite autorização;
- solicite aprovação humana;
- mantenha contexto entre mensagens;
- execute workflows;

**sem transformar cada método de repository/service em uma tool** (`getOrder`, `updateOrder`,
`deleteOrder`, … × cada entidade)?

## Arquitetura

```text
User (Next.js UI)
        │  sessão → ator (servidor); corpo do chat filtrado por whitelist
        ▼
Mastra Agent (commerceAgent + memória)
        │  RequestContext { actor, channel }
        ▼
Capability Layer
├── Read capabilities   inspectSchema, queryDatabase      → role Postgres read-only
├── Domain actions      cancelOrder, refundPayment ⏸,     → casos de uso do domínio
│                       sendCustomerNotification
└── Workflows           startLateOrderNotifications ⏸     → processo determinístico
        │
        ▼
Application Domain  (validação → autorização → regras → transação → auditoria)
        │
        ▼
PostgreSQL          (dados de negócio · audit_log · action_approvals · schema `mastra`)

⏸ = pausa para aprovação humana
```

O mesmo caso de uso é chamado pela tool do agente, pela API HTTP, pelo workflow e pelo servidor
MCP. A tool é só um adaptador (~20 linhas). Detalhes em
[`specs/architecture.md`](specs/architecture.md).

**Stack:** Next.js 16 · React 19 · Mastra 1.x (`@mastra/core`, `memory`, `pg`, `mcp`, `ai-sdk`,
`observability`) · AI SDK v7 · Zod 4 · PostgreSQL 17 · Docker Compose · pnpm · Vitest.

## Capabilities atuais

| Tipo                   | Capability                    | O que faz                                                                                                            |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Leitura genérica       | `inspectSchema`               | descreve tabelas/views **que a role do agente pode ler**, com descrições de negócio (`COMMENT ON`), FKs e convenções |
| Leitura genérica       | `queryDatabase`               | executa **um** `SELECT` somente leitura, com timeout e limite de linhas                                              |
| Domain action          | `cancelOrder`                 | cancela pedido aguardando pagamento e anula o pagamento pendente                                                     |
| Domain action          | `sendCustomerNotification`    | notifica um cliente (opt-out, pedido pertence ao cliente, rate limit)                                                |
| Domain action sensível | `refundPayment`               | reembolso integral do valor capturado; **exige aprovação humana**                                                    |
| Workflow               | `startLateOrderNotifications` | identificar atrasados → validar → selecionar clientes → preparar mensagens → aprovação → enviar                      |

- **Leitura genérica:** uma capability cobre perguntas arbitrárias ("qual cliente gastou mais
  este mês?") sem código novo. É segura porque é leitura e porque as garantias vêm do banco.
  Definições de negócio ("atrasado", "receita") estão em views (`order_overview`,
  `customer_spend`, `product_sales`), e o modelo não precisa inventá-las.
- **Domain actions:** cada efeito colateral é um caso de uso com nome de negócio, schema,
  regras, autorização, transação e auditoria. As tools crescem com as _intenções de negócio_, não
  com tabelas × CRUD.
- **Workflows:** quando o caminho é conhecido e o efeito é em lote, o agente delega a um processo
  determinístico, retomável e testável sem LLM, em vez de improvisar uma sequência de ações.

## Segurança

A segurança está **no código e no banco**, não apenas no prompt.

| Controle                              | Implementação                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filtragem por permissão               | O schema exposto ao agente é o visível para a role `agent_readonly` (`information_schema` filtra por privilégio): tabelas operacionais e `customers.email` não aparecem nem são consultáveis. As tools **não** são filtradas por papel na POC; toda ação é autorizada na execução. |
| Autorização no domínio                | Papéis `viewer` / `support` / `manager` com permissões verificadas em cada caso de uso (`assertCan`). O ator vem da sessão no servidor, nunca do modelo; sem ator, a tool falha fechado.                                                                                           |
| PostgreSQL read-only                  | Role dedicada só com `SELECT`, `default_transaction_read_only = on`. Mesmo se o guard SQL falhar, o banco recusa escrita (há teste).                                                                                                                                               |
| Transação, timeout e limite de linhas | `BEGIN READ ONLY` + `statement_timeout` + cursor com `FETCH n+1` e sinalização de truncamento; bloqueio de múltiplos statements, DDL/DML, `INTO`, `FOR UPDATE`, funções `pg_*`/`dblink`/`lo_*` e catálogos.                                                                        |
| Aprovação                             | `refundPayment` tem `requireApproval: true`: o Mastra pausa **antes** de executar.                                                                                                                                                                                                 |
| Aprovação persistida                  | A decisão (Aprovar/Rejeitar) é gravada em `action_approvals`, com o aprovador sendo o operador da sessão.                                                                                                                                                                          |
| Vinculada aos argumentos              | A aprovação vale para o mesmo `toolCallId`, a mesma capability e **os mesmos argumentos** exibidos (comparação por JSON canônico).                                                                                                                                                 |
| Uso único                             | O domínio consome a aprovação na mesma transação da ação; reutilizar falha.                                                                                                                                                                                                        |
| Valores sensíveis fora do modelo      | O valor do reembolso não é input: é o capturado, lido do banco; o cartão de aprovação mostra dados calculados pelo backend.                                                                                                                                                        |
| Audit log                             | `audit_log` registra toda leitura e ação, em qualquer canal: quem pediu, agente/thread/run/toolCall, parâmetros, resultado, erro, se exigiu aprovação, quem aprovou e quando. Página `/audit`.                                                                                     |

## Testes e resultados

Resultados reais no estado publicado:

| Check            | Resultado                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `pnpm lint`      | ✅ sem erros                                                                                  |
| `pnpm typecheck` | ✅ sem erros                                                                                  |
| `pnpm test`      | ✅ **112 testes** em 13 arquivos (unitários + integração com Postgres real; nenhum chama LLM) |
| `pnpm build`     | ✅ build de produção do Next.js                                                               |

O agente é testado de forma determinística com um modelo mock roteirizado
(`tests/helpers/scripted-model.ts`): tools com ator do contexto, SQL destrutivo recusado,
memória, suspensão/aprovação/rejeição, delegação ao workflow. O MCP é testado com um cliente real
via stdio. Há testes de arquitetura que falham se uma tool acessar SQL/repositórios diretamente
ou se aparecerem tools CRUD.

**Testes manuais com LLM real** (Claude Haiku 4.5), pela UI e/ou pela rota `/api/chat`:

| Cenário                                                      | Resultado observado                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| "Quantos pedidos estão atrasados?"                           | `inspectSchema` → `queryDatabase` sobre `order_overview.is_late` → "3 pedidos" (correto)               |
| Follow-up "E de quais clientes são?"                         | resolvido pela memória: #1002 João, #1005 Maria, #1008 Camila                                          |
| "Qual cliente gastou mais?"                                  | Juliana Costa, R$ 60.172,60 (correto pelo seed); spans com ator/canal persistidos                      |
| "Mostre os pedidos do João." → "Qual deles foi o mais caro?" | 6 pedidos listados; "#1003, R$ 9.698,00" (correto)                                                     |
| "Reembolse o pagamento do pedido #1002" (UI)                 | cartão de aprovação → Aprovar → reembolso executado; auditoria com `approved_by` e aprovação consumida |
| "Encontre pedidos atrasados e prepare uma notificação" (UI)  | agente delegou ao workflow → prévia → aprovar → 2 enviadas, 1 ignorada por opt-out                     |

## Findings com LLM real

**1. O modelo afirmou ter feito um reembolso sem chamar a tool.** Com as instruções iniciais
("diga o que será feito e aguarde a decisão"), o modelo pediu confirmação em texto e, após o "sim",
respondeu "Reembolso processado com sucesso" **sem executar `refundPayment`**. Nada mudou no
banco: o modelo não tem nenhum caminho de escrita além das Domain Actions.

**2. A aprovação não chegava ao domínio ao retomar a execução pausada.** A primeira versão
passava a evidência de aprovação pelo `RequestContext` na retomada, mas o Mastra restaura o
contexto salvo no snapshot do run suspenso, e o valor salvo prevaleceu. O domínio recusou o
reembolso (`APPROVAL_REQUIRED`): falhou fechado, sem efeito indevido.

**Correções implementadas:**

- instruções do agente exigem chamar a tool de ação e proíbem afirmar execução sem `ok: true`
  vindo da tool (não pedir confirmação em texto; a interface coleta a aprovação);
- aprovação **persistida** no banco (`action_approvals`);
- aprovação **vinculada aos argumentos exatos** aprovados;
- aprovação de **uso único**;
- validação no **domínio** (`consumeApproval`), independente do framework;
- **testes de regressão** para ambos os casos de aprovação.

> **O texto do modelo não é prova de execução.** A fonte da verdade é o resultado da aplicação:
> o retorno da tool, o estado do banco e o `audit_log`.

## Limitações atuais

- **Não é production-ready.**
- Autenticação simplificada: o operador é escolhido num seletor de demonstração (cookie). Em
  produção, a sessão real deve resolver o mesmo `Actor`.
- Requester e approver podem ser a mesma pessoa: um `manager` pode aprovar o próprio pedido
  (sem _four-eyes_).
- Tools não são filtradas por papel antes de chegar ao modelo; a autorização acontece na execução.
- MCP expõe só leitura, via stdio. Actions que exigem aprovação ainda não têm um fluxo de
  aprovação pelo protocolo.
- RLS (Row-Level Security) para cenários _customer-facing_ (cliente consultando só os próprios
  dados) não está implementado; a POC atende operadores internos.
- OpenTelemetry e observabilidade avançada não estão implementados; há tracing nativo do Mastra
  no Postgres. Métricas do Studio exigem store OLAP.
- O guard SQL é léxico (defesa em profundidade); a garantia forte é a role e a transação
  read-only. Text-to-SQL depende da qualidade do modelo.
- Notificações são simuladas (gravadas em tabela).

Mais em [`specs/architecture.md`](specs/architecture.md#7-limitações-conhecidas) e no balanço
final de [`specs/roadmap.md`](specs/roadmap.md).

## Comparação futura

Existe uma POC equivalente implementada com **AI SDK**. A ideia é executar os mesmos cenários
nas duas implementações e comparar os resultados. Nenhuma comparação ou conclusão é feita aqui.

## Como rodar

### Portas

| Serviço                      | Porta                        |
| ---------------------------- | ---------------------------- |
| PostgreSQL (Docker)          | **5466** → 5432 no container |
| Next.js (UI + API)           | **3466**                     |
| Mastra Studio (`mastra dev`) | **4466**                     |

### Instalar

Requisitos: Node ≥ 22.13, pnpm, Docker.

```bash
pnpm install
```

### Configurar `.env`

```bash
cp .env.example .env
```

| Variável                                               | Para quê                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`, `DATABASE_URL`                    | Postgres da aplicação (dono do schema)                                                               |
| `READONLY_DATABASE_URL`                                | conexão do agente; o usuário **precisa** ser `agent_readonly` (a senha é aplicada pelo `db:migrate`) |
| `TEST_DATABASE_URL`, `TEST_READONLY_DATABASE_URL`      | banco `commerce_test` para testes de integração                                                      |
| `MASTRA_MODEL`                                         | `provider/model` do model router do Mastra, ex.: `anthropic/claude-haiku-4-5-20251001`               |
| `ANTHROPIC_API_KEY` (ou a chave do provider escolhido) | lida pelo Mastra; nunca exposta ao modelo                                                            |
| `ANTHROPIC_BASE_URL`                                   | opcional: gateway compatível com a API da Anthropic                                                  |
| `QUERY_TIMEOUT_MS`, `QUERY_MAX_ROWS`, `APP_TIMEZONE`   | limites e fuso da capability de leitura                                                              |

### Subir o Docker

```bash
pnpm db:up          # docker compose up -d --wait (cria também o banco commerce_test)
```

### Migrations

```bash
pnpm db:migrate           # banco de desenvolvimento
pnpm db:migrate --test    # banco de testes
```

SQL versionado em `src/infrastructure/database/migrations/NNNN_*.sql`, aplicado em ordem e
registrado em `schema_migrations`. O migrator cria/atualiza a role `agent_readonly`.

### Seed

```bash
pnpm db:seed        # apaga e recria os dados de demonstração (proibido em produção)
pnpm db:setup       # atalho: migrate + seed (dev) + migrate (test)
```

O seed é determinístico, com datas relativas a "agora". Cenários fixos:

| Pedido       | Cenário                                                    |
| ------------ | ---------------------------------------------------------- |
| #1001        | João, aguardando pagamento hoje: **cancelável**            |
| #1002        | João, pago e **atrasado**: reembolsável                    |
| #1003        | João, entregue: o mais caro dele                           |
| #1005, #1008 | atrasados (#1008 é de cliente com opt-out de notificações) |
| #1006        | aguardando pagamento: cancelável                           |
| #1007        | enviado: não cancelável                                    |
| #1011        | entregue há 120 dias: fora da janela de reembolso          |

Operadores de demonstração: **ana** (manager), **bruno** (support), **carla** (viewer).

### Iniciar o Mastra (Studio)

```bash
pnpm dev:mastra     # http://localhost:4466 — agente, tools, workflow, traces
```

### Iniciar o Next.js

```bash
pnpm dev            # http://localhost:3466
```

- `/`: chat com o agente (troque o operador no canto superior direito)
- `/orders`: tela sem IA sobre o mesmo domínio
- `/audit`: trilha de auditoria (somente manager)
- `GET /api/health`: banco, migrations e conexão read-only do agente

### Testes e checks

```bash
pnpm test           # 112 testes (Vitest); integração usa Postgres real, nenhum chama LLM
pnpm lint
pnpm typecheck
pnpm build
pnpm check          # todos acima
```

O agente é testado com um modelo mock roteirizado (`tests/helpers/scripted-model.ts`): cada
turno é uma tool call ou um texto, o que torna determinísticos os testes de tools, memória e
aprovação.

### Testar o agente

Com o `.env` preenchido e `pnpm dev` rodando, experimente (há atalhos na tela):

| Pedido                                                                   | O que demonstra                               |
| ------------------------------------------------------------------------ | --------------------------------------------- |
| "Quais são os 5 clientes que mais gastaram este mês?"                    | text-to-SQL controlado sobre views semânticas |
| "Mostre os pedidos do João." → "Qual deles foi o mais caro?"             | memória da conversa                           |
| "Cancele o pedido #1001, o cliente desistiu."                            | domain action                                 |
| "Cancele o pedido #1007."                                                | regra de negócio recusando                    |
| "Reembolse o pagamento do pedido #1002."                                 | aprovação humana                              |
| "Encontre pedidos atrasados e prepare uma notificação para os clientes." | workflow com aprovação                        |
| Troque para **carla** (viewer) e peça um cancelamento                    | autorização no backend                        |
| Troque para **bruno** (support), peça um reembolso e clique Aprovar      | support pede, mas só manager aprova           |

Depois confira `/audit`. Sem chave de LLM, a UI abre, mas o chat retorna erro. Os testes
automatizados não dependem da chave.

## Como estender

### Nova Domain Action

1. Caso de uso em `src/domain/<contexto>/<acao>.ts`: exporte o schema Zod de entrada e a função
   `(deps, input, ctx) => resultado`, envolvendo o corpo em `auditedAction(...)`. Dentro:
   `assertCan(ctx.actor, '<permissão>')` → carregar → policy pura → persistir.
2. Se precisar de uma nova permissão, adicione em `src/domain/operators/operator.ts`.
3. Novas operações de persistência: porta em `src/domain/ports.ts` e implementação em
   `src/infrastructure/repositories/`.
4. Testes: policy em `tests/unit`, caso de uso em `tests/integration`.
5. Opcional: rota HTTP em `src/app/api/...` chamando o **mesmo** caso de uso com `channel: 'http'`.

### Nova tool

Uma tool é um adaptador fino (veja `src/mastra/tools/orders/cancel-order.ts`):

```ts
export const myActionTool = createTool({
  id: 'myAction',
  description: 'O que faz, quando usar e o que a aplicação valida.',
  inputSchema: MyActionInput, // reusa o schema do domínio
  outputSchema: actionOutput(ResultSchema), // { ok: true, result } | { ok: false, code, error }
  // requireApproval: true,                   // se for sensível (e exija evidência no domínio)
  execute: async (input, context) => runAction(() => myAction(getDeps(), input, actionContextFrom(context))),
});
```

Registre em `src/mastra/tools/index.ts`. `tests/unit/architecture.test.ts` impede SQL e
repositórios dentro de tools e lista as capabilities expostas: atualize a lista de forma
consciente.

### Novo agente

1. Crie `src/mastra/agents/<nome>.ts` com uma factory (modelo injetável para testes) e instruções
   curtas via função de `requestContext`.
2. Escolha o subconjunto de tools (`readTools`, `actionTools`, `workflowTools`). Um agente só de
   leitura, por exemplo, recebe apenas `readTools`.
3. Registre em `src/mastra/index.ts` e crie uma rota com `handleChatStream({ agentId, ... })`,
   montando o `RequestContext` no servidor (veja `src/app/api/chat/route.ts`).
4. Teste com `scriptedModel` (veja `tests/integration/agent.test.ts`).

### MCP

```bash
pnpm mcp            # servidor stdio; identidade = MCP_OPERATOR_ID (padrão carla/viewer)
```

Para expor outra capability, adicione um adaptador em `src/mastra/mcp/commerce-mcp-server.ts`
chamando a camada de aplicação com `{ actor, channel: 'mcp' }`. Exemplo de configuração de cliente
e próximos passos (HTTP + OAuth, ações com `input_required`) no
[ADR 006](specs/decisions/006-mcp-strategy.md).

### Fluxo de aprovação (detalhado)

1. A tool tem `requireApproval: true`. O Mastra suspende **antes** do `execute` e salva o snapshot
   no Postgres.
2. A UI recebe `tool-approval-request` (AI SDK v7) e mostra o cartão com dados calculados pelo
   backend (`/api/orders/:id/refund-preview`).
3. Aprovar/Rejeitar → `addToolApprovalResponse` → `sendAutomaticallyWhen` reenvia a mensagem.
4. `/api/chat` grava a decisão em `action_approvals` (aprovador = operador da **sessão**, vinculada
   ao `toolCallId` e aos argumentos) e o `handleChatStream` retoma o run.
5. O caso de uso executa `consumeApproval`: decisão aprovada, mesma capability, mesmos argumentos,
   não utilizada e aprovador com permissão. Caso contrário, `APPROVAL_REQUIRED`/`FORBIDDEN`.
6. `audit_log` registra solicitante, `approved_by` e `approved_at`. Rejeições também são auditadas.

Workflows usam `suspend()`/`resume()`. A decisão chega por
`POST /api/workflows/late-order-notifications/:runId`, com o aprovador vindo da sessão.

Detalhes e histórico da decisão: [ADR 004](specs/decisions/004-authorization-and-human-approval.md).

## Estrutura

```text
src/
├── app/                      # Next.js: UI, rotas HTTP (borda: sessão, whitelist, aprovações)
├── application/
│   ├── knowledge/            # capability de leitura: sql-guard, query-database, inspect-schema
│   └── notifications/        # regras puras da campanha de pedidos atrasados
├── config/env.ts             # ambiente validado com Zod
├── domain/                   # regras, casos de uso, portas, permissões, aprovação, auditoria
├── infrastructure/
│   ├── database/             # pools, migrations, migrator, seed, health
│   └── repositories/         # Postgres + UnitOfWork
└── mastra/
    ├── agents/               # commerceAgent
    ├── tools/                # database / orders / payments / notifications / workflows
    ├── workflows/            # lateOrderNotificationWorkflow
    ├── memory/               # Memory nativa do Mastra
    ├── mcp/                  # MCPServer (stdio)
    ├── request-context.ts    # contexto confiável: ator e canal
    └── index.ts              # instância Mastra (storage, logger, observabilidade)
specs/                        # README, roadmap, architecture, decisions/
tests/                        # unit/, integration/, helpers/
```

## Licença

[MIT](LICENSE)
