# ADR 001 — Mastra como framework de agentes, embutido no app Next.js

- Status: aceito
- Data: 2026-09-27

## Contexto

O diretório estava vazio. Precisamos de UI de chat com streaming, agente com tools, memória,
workflows, aprovação humana, MCP e observabilidade — sem criar microserviços.

## Decisão

- Um único pacote pnpm: Next.js 16 (App Router) + Mastra em `src/mastra`.
- As rotas do Next (`src/app/api/*`) importam a instância `mastra` e chamam o agente
  **in-process** via `handleChatStream` de `@mastra/ai-sdk` (padrão oficial da integração
  Next.js). A UI usa `useChat` do AI SDK v7.
- `mastra dev` (porta 4466) roda em paralelo apenas como **Studio** de desenvolvimento
  (inspecionar traces, testar tools/workflows), compartilhando o mesmo Postgres.
- Primitives do Mastra usadas em vez de infraestrutura própria: `Agent`, `createTool`,
  `Memory` + `PostgresStore`, `createWorkflow` com `suspend/resume`, aprovação
  `requireApproval`, `MCPServer`, `Observability` + `PinoLogger`.
- Código fora de `src/app` usa imports relativos (sem alias `@/`) para que o bundler do
  `mastra dev` e scripts `tsx` resolvam os mesmos arquivos que o Next.

## Consequências

- Uma única implantação e uma única fonte de verdade para domínio e capabilities.
- Se o agente precisar escalar separado, `src/mastra` já é isolado: basta servir via
  `mastra build` ou `@mastra/next` sem tocar em domínio.
