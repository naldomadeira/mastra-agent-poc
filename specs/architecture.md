# Arquitetura — Agent Operating Layer

> Pergunta central: **como permitir que um agente conheça e opere uma aplicação sem transformar
> cada método do banco ou service em uma tool?**
>
> Resposta desta POC: o agente usa **6 capabilities**, não dezenas de tools CRUD:
> 2 de conhecimento (leitura genérica e controlada), 3 de ação (casos de uso do domínio) e
> 1 de processo (workflow). Autorização, regras e aprovação vivem no backend.

## 1. Visão geral

```text
                        ┌────────────────────────────┐
                        │  Next.js UI (chat, cards)  │  src/app/_components
                        └─────────────┬──────────────┘
                                      │ AI SDK v7 (stream, tool parts, approvals)
                        ┌─────────────▼──────────────┐
                        │ Rotas do servidor           │  src/app/api/*
                        │ sessão → ator, whitelist,   │  (identidade e aprovação
                        │ decisões de aprovação       │   decididas AQUI)
                        └─────────────┬──────────────┘
                                      │ RequestContext { actor, channel }
                        ┌─────────────▼──────────────┐
                        │ Agent Layer — Mastra        │  src/mastra
                        │ commerceAgent + memória     │
                        └──┬──────────┬───────────┬──┘
             KNOWLEDGE     │   ACTIONS│           │ PROCESSES
     ┌─────────────────────▼┐ ┌───────▼────────┐ ┌▼─────────────────────────┐
     │ inspectSchema        │ │ cancelOrder    │ │ startLateOrder-          │
     │ queryDatabase        │ │ refundPayment ⏸│ │ Notifications → workflow │
     │ (read-only)          │ │ sendCustomer-  │ │ identificar→…→aprovar ⏸  │
     │                      │ │ Notification   │ │ →enviar                  │
     └──────────┬───────────┘ └───────┬────────┘ └────────────┬─────────────┘
                │ src/application     │ src/domain (use cases) │ src/application
                │ /knowledge          │                        │ /notifications
     ┌──────────▼───────────┐ ┌───────▼────────────────────────▼─────────────┐
     │ role agent_readonly  │ │ Domínio: validação → autorização → regras →   │
     │ READ ONLY + timeout  │ │ transação → auditoria (mesmo commit)          │
     │ + cursor/limite      │ │ repositories: src/infrastructure/repositories │
     └──────────┬───────────┘ └───────┬───────────────────────────────────────┘
                └──────────────┬──────┘
                        ┌──────▼──────┐     ┌──────────────────────────────┐
                        │ PostgreSQL  │◄────│ MCP stdio (read-only)        │
                        │ :5466       │     │ mesma camada de aplicação    │
                        └─────────────┘     └──────────────────────────────┘
⏸ = suspende para aprovação humana
```

### Camadas e dependências

| Camada                                              | Pasta                | Depende de         | Não pode depender de                        |
| --------------------------------------------------- | -------------------- | ------------------ | ------------------------------------------- |
| Domínio (regras, casos de uso, portas)              | `src/domain`         | zod                | Mastra, Next, pg, infraestrutura (há teste) |
| Aplicação (capabilities reutilizáveis)              | `src/application`    | domínio, pools     | Mastra, Next                                |
| Infraestrutura (Postgres, repositórios, migrations) | `src/infrastructure` | domínio            | Mastra, Next                                |
| Agent layer (agente, tools, workflow, memória, MCP) | `src/mastra`         | aplicação, domínio | SQL direto nas tools (há teste)             |
| Borda HTTP/UI                                       | `src/app`            | todas              | —                                           |

O mesmo caso de uso (`cancelOrder`, por exemplo) é chamado por HTTP (`/api/orders/:id/cancel`),
pela tool do agente, pelo workflow e poderia ser chamado por CLI, job ou webhook. A tool é um
adaptador de ~20 linhas.

## 2. Fluxos

### Leitura (conhecimento)

```text
"Qual cliente gastou mais?"
 → inspectSchema (schema visível para a role + COMMENT ON + views semânticas)
 → queryDatabase("SELECT … FROM customer_spend ORDER BY total_spent_brl DESC LIMIT 1")
     guard léxico → role agent_readonly → BEGIN READ ONLY → statement_timeout
     → SET LOCAL TIME ZONE → DECLARE CURSOR / FETCH n+1 → ROLLBACK → audit_log
 → resposta
```

Definições de negócio ("atrasado", "receita") estão em **views** (`order_overview.is_late`,
`customer_spend`, `product_sales`), não no prompt. O modelo lê a definição e não a inventa.

### Ação

```text
"Cancele o pedido #1001" → cancelOrder({orderId, reason})
 → ator do RequestContext (sessão)  → assertCan(orders:cancel)
 → carrega pedido → cancellationDecision() → UPDATE … WHERE status='pending_payment'
 → anula pagamento pendente → audit_log (mesma transação) → { ok: true, result }
Regra violada → { ok: false, code, error } → o modelo explica. Nada muda no banco.
```

### Ação sensível com aprovação humana

```text
"Reembolse o #1002" → refundPayment (requireApproval: true)
 → Mastra suspende ANTES do execute (snapshot no Postgres) → tool-approval-request
 → UI: cartão com valor/cliente calculados pelo backend → [Aprovar] [Rejeitar]
 → /api/chat grava decisão em action_approvals (aprovador = operador da sessão,
   vinculada a toolCallId + argumentos) → handleChatStream retoma o run
 → domínio: consumeApproval() exige decisão aprovada, mesma capability, mesmos argumentos,
   não usada, aprovador com payments:refund:approve → executa → audita approved_by
```

### Workflow

```text
"Avise os clientes com pedido atrasado" → startLateOrderNotifications
 → identificar → validar (isLate + dedupe 24h) → selecionar clientes (opt-out)
 → preparar (template, sem LLM) → ⏸ aprovação (UI) → enviar via sendCustomerNotification
```

## 3. Segurança

**"LLM decides WHAT it wants to do. Application decides WHETHER it is allowed to do it."**

| Ameaça                             | Controle                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Modelo escrever no banco           | Não existe tool de escrita genérica; a role `agent_readonly` só tem `SELECT`; transação `READ ONLY`; guard léxico. Teste: mesmo sem guard, `DELETE` falha.                                       |
| SQL caro / exfiltração             | timeout, limite de linhas, sem catálogos do sistema, sem `pg_*`/`dblink`/`lo_*`, colunas de PII sem grant (`customers.email`).                                                                   |
| Modelo se passar por outro usuário | Ator vem da sessão, no servidor. O corpo do chat é whitelist (`id`, `messages`, `trigger`): `requestContext`, `runId` e `resumeData` do cliente são descartados. Sem ator, a tool falha fechado. |
| IDs manipulados pelo modelo        | O domínio carrega e valida tudo: pedido existe, pertence ao cliente (notificação), estado permite a ação.                                                                                        |
| Valor inventado no reembolso       | O valor não é input: é o capturado, lido do banco.                                                                                                                                               |
| Aprovação burlada                  | Duas camadas: flag do Mastra e evidência persistida exigida pelo domínio (ADR 004).                                                                                                              |
| Thread de outro operador           | A rota recusa thread cujo `resourceId` é outro operador.                                                                                                                                         |
| Segredos                           | `.env` fora do git; o modelo nunca vê credenciais; `SensitiveDataFilter` nos traces.                                                                                                             |

## 4. Observabilidade e auditoria

- **Trilha de negócio** (`audit_log`): toda capability, em qualquer canal. Responde quem pediu,
  qual agente/thread/run/toolCall, capability, parâmetros, resultado, erro, se exigiu aprovação,
  quem aprovou e quando. UI em `/audit`.
- **Tracing técnico** (Mastra): spans de inferência, tool, memória e workflow no schema `mastra`,
  com `actor`/`channel` como metadados, visíveis no Studio (`pnpm dev:mastra`).
- Regra prática: **a auditoria é a fonte da verdade sobre o que aconteceu, não o texto do
  modelo** (ver achado 1 abaixo).

## 5. Generic tools vs Semantic domain tools — conclusão

|                      | Generic (`queryDatabase`)                                                      | Semantic (`refundPayment`)                        |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| Cobertura            | Qualquer pergunta nova sem código novo                                         | Só o caso de uso modelado                         |
| Superfície de risco  | Alta se for escrita; **aceitável para leitura** com role + read-only + limites | Baixa: regras, autorização e transação no domínio |
| Onde vive a regra    | Views semânticas + comentários no schema                                       | Código do domínio, testado sem LLM                |
| Previsibilidade      | Depende do SQL gerado (o modelo pode errar a consulta)                         | Determinística                                    |
| Aprovação humana     | Desnecessária (sem efeito colateral)                                           | Natural e vinculável aos argumentos               |
| Reuso fora do agente | Médio (MCP de leitura)                                                         | Alto (HTTP, workflow, MCP, jobs)                  |
| Custo de manutenção  | Baixo; o schema e as views são o contrato                                      | Um caso de uso por intenção de negócio            |

**Conclusão:**

1. **Leitura → genérica, mas controlada.** Uma capability de consulta sobre um schema curado
   (views semânticas, comentários, grants por coluna) cobre dezenas de perguntas que exigiriam
   dezenas de tools `getXByY`. A segurança vem do banco (role, read-only, limites), não do prompt.
2. **Escrita → semântica, sempre.** Cada efeito colateral é um caso de uso de negócio com nome,
   schema, regras, autorização, transação e auditoria. O número de tools cresce com o **número
   de intenções de negócio**, não com o número de tabelas × operações CRUD.
3. **Processos → workflow.** Quando o caminho é conhecido e o efeito é em lote, o agente delega a
   um workflow determinístico em vez de improvisar uma sequência de ações.
4. **Context engineering > prompt engineering.** O que o agente precisa saber (schema, definições,
   data local, quem é o operador) chega por views, comentários e `requestContext`. As instruções
   ficam curtas e comportamentais.

Regra de bolso para outra aplicação: **exponha 1 capability de leitura por fonte de dados e 1
action por intenção de negócio que o usuário realmente pede ao agente.**

## 6. Achados empíricos (testes manuais com LLM real)

1. **O modelo alucinou a execução de uma ação.** Com instruções iniciais que diziam "aguarde a
   decisão", o Haiku pediu confirmação em texto e, após o "sim", respondeu "Reembolso processado
   com sucesso" **sem chamar a tool**. Nada mudou no banco: a arquitetura segurou.
   Mitigações aplicadas: instruções comportamentais ("chame a tool; não peça confirmação em texto;
   só afirme execução com `ok: true`"), a UI exibe cada tool call e a auditoria é a fonte da verdade.
   Próximo passo possível: um output processor que bloqueie afirmações de execução sem tool result.
2. **Evidência de aprovação via `RequestContext` se perdia na retomada.** O Mastra restaura o
   `requestContext` do snapshot do run suspenso. O domínio falhou fechado (`APPROVAL_REQUIRED`).
   Correção: evidência persistida em `action_approvals`, vinculada aos argumentos e de uso único.
   Lição: **dados de autorização não devem depender de detalhes de serialização do framework**;
   persista e deixe o domínio verificar.
3. **Memória funcionou sem código próprio**: "E de quais clientes são?" foi resolvido pelo contexto
   do turno anterior usando só o histórico nativo do Mastra.

4. **Avaliação sistemática (Fase 12, [evaluation.md](evaluation.md)).** Com um modelo roteirizado
   que se comporta mal, nenhum efeito indevido ocorreu em reembolso, permissão, prompt injection,
   SQL destrutivo, aprovação e workflow, **exceto** uma ação não solicitada, permitida ao ator e
   sem exigência de aprovação (`cancelOrder` por support): **risco residual** do desenho
   "aprovação só para ações sensíveis".
5. **Read-only é um padrão de sessão; a garantia são os grants.** `SET TRANSACTION READ WRITE`
   reverte `default_transaction_read_only`. A escrita falhou por falta de privilégio. A tabela de
   segurança acima continua válida porque a role não tem grants de escrita.
6. **Política inventada (live).** O Haiku reconheceu que a aplicação não tem prazo de reembolso e
   mesmo assim citou "5-7 dias úteis".

## 7. Limitações conhecidas

- Autenticação é de demonstração (cookie de operador). Em produção: sessão real → mesmo `Actor`.
- Métricas agregadas do Studio exigem store OLAP; os traces funcionam em Postgres. O aviso `This storage provider does not support batch creating metrics`
  no log do servidor é essa limitação (inofensivo).
- MCP expõe só leitura e só via stdio (ADR 006).
- Notificação é simulada (grava em `notifications`).
- O guard SQL é léxico (defesa em profundidade). A garantia forte é a role + transação read-only.
- Workflow: uma notificação por cliente registra apenas o primeiro pedido (dedupe parcial).
- O text-to-SQL depende da qualidade do modelo. Com Haiku, as consultas testadas foram corretas,
  mas perguntas ambíguas podem gerar SQL plausível e errado. As views reduzem esse risco.
- Requester e approver podem ser a mesma pessoa (um manager aprova o próprio pedido); não há
  _four-eyes_.
- As tools não são filtradas por papel antes de chegar ao modelo; a autorização acontece na
  execução de cada capability.
- RLS (Row-Level Security) para cenários _customer-facing_ não está implementado; a POC atende
  operadores internos.
- OpenTelemetry/observabilidade avançada não está implementada (há tracing nativo do Mastra).
- Ações não sensíveis permitidas ao ator não exigem aprovação: um modelo malcomportado pode
  executá-las sem pedido explícito do usuário (EV-01 adversarial).
- Não é production-ready: é um experimento arquitetural.

## 8. Usando como boilerplate

1. Troque o domínio (`src/domain`, migrations, seed) mantendo portas, `auditedAction` e
   `consumeApproval`.
2. Curadoria do schema: views semânticas + `COMMENT ON` + grants da role readonly.
3. Para cada intenção de negócio: caso de uso → teste → tool fina → (opcional) `requireApproval`.
4. Processos em lote: workflow com funções puras + passo de aprovação.
5. Mantenha as regras de arquitetura em `tests/unit/architecture.test.ts`.

Guias passo a passo no [README](../README.md#como-estender).

## 9. Avaliação

A Fase 12 adiciona uma suíte portável (`evals/`) que roda os mesmos casos em modo `live` (LLM real)
e `adversarial` (modelo roteirizado que se comporta mal), medindo _behavior_ e _safety_ com a
auditoria e o diff do banco como fonte da verdade. Método, resultados e findings em
[evaluation.md](evaluation.md); catálogo de casos em [evaluation-cases.md](evaluation-cases.md).
