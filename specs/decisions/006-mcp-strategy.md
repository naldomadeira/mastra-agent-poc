# ADR 006 — Estratégia MCP: expor capabilities, começando pela leitura

- Status: aceito
- Data: 2026-09-27

## Contexto

Queremos que Claude, ChatGPT, Cursor etc. possam usar as capabilities da aplicação, sem duplicar
lógica e sem transformar a aplicação inteira em MCP.

## Decisão

- `src/mastra/mcp/commerce-mcp-server.ts` cria um `MCPServer` (`@mastra/mcp`) cujos tools são
  adaptadores de ~5 linhas sobre a **camada de aplicação** (`src/application/knowledge/*`) — a mesma
  usada pelas tools do agente. Canal de auditoria: `mcp`.
- Transporte **stdio** (`pnpm mcp`). A identidade vem do processo (`MCP_OPERATOR_ID`, validado
  contra `operators`); padrão `carla` (viewer). As permissões continuam no domínio.
- Escopo inicial **somente leitura**: `inspectSchema`, `queryDatabase`.
- **Não** registramos o servidor MCP na instância `Mastra` (o que o exporia via HTTP no
  `mastra dev`): sem autenticação configurada, isso daria leitura a qualquer processo local na porta.

## Por que não expor ações ainda

Ações sensíveis exigem aprovação humana vinculada à solicitação (ADR 004). Via MCP, isso deve usar
o mecanismo do protocolo (`input_required`/elicitation, suportado pelo `MCPServer`) ou uma fila de
aprovação na aplicação. O domínio já protege: um `refundPayment` com canal `mcp` sem evidência de
aprovação é negado (`APPROVAL_REQUIRED`).

## Próximos passos

1. Transporte HTTP (`startHTTP`/`@mastra/next`) com OAuth e `mapAuthInfoToUser` → ator real.
2. Expor `cancelOrder`/`sendCustomerNotification` (não sensíveis) e o workflow
   (`run_lateOrderNotificationWorkflow`).
3. `refundPayment` via MCP com `input_required` para aprovação.

## Exemplo de configuração de cliente (Claude Code, `.mcp.json`)

```json
{
  "mcpServers": {
    "commerce": {
      "command": "pnpm",
      "args": ["--dir", "/caminho/para/mastra-app", "mcp"],
      "env": { "MCP_OPERATOR_ID": "carla" }
    }
  }
}
```
