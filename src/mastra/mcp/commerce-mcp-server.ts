import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { InspectSchemaInput, inspectSchema } from '../../application/knowledge/inspect-schema';
import { QueryDatabaseInput, queryDatabase } from '../../application/knowledge/query-database';
import { getReadDeps } from '../../application/knowledge/read-deps';
import type { Actor } from '../../domain/operators/operator';
import type { ActionContext } from '../../domain/shared/action-context';
import { getReadonlyPool } from '../../infrastructure/database/pool';

/**
 * Application capabilities → MCP. Os adaptadores chamam a MESMA camada de aplicação que as
 * tools do agente e a API HTTP; só o canal (`mcp`) e a origem da identidade mudam.
 *
 * Escopo deliberado: somente LEITURA. Ações com efeito exigem um canal de aprovação humana
 * no protocolo (elicitation/input_required) — próximo passo registrado no ADR 006.
 */
export function createCommerceMcpServer(actor: Actor): MCPServer {
  const ctx: ActionContext = { actor, channel: 'mcp' };

  return new MCPServer({
    id: 'commerce-capabilities',
    name: 'Commerce capabilities (read-only)',
    version: '0.1.0',
    description: 'Consulta controlada ao banco da loja: schema semântico e SELECT somente-leitura, auditados.',
    instructions:
      'Chame inspectSchema antes de escrever SQL. queryDatabase aceita um único SELECT, com limite de linhas e tempo. Não há tools de escrita.',
    tools: {
      inspectSchema: createTool({
        id: 'inspectSchema',
        description: 'Tabelas/views legíveis, colunas, descrições de negócio, FKs e convenções.',
        inputSchema: InspectSchemaInput,
        execute: async (input) => inspectSchema(getReadonlyPool(), input, ctx),
      }),
      queryDatabase: createTool({
        id: 'queryDatabase',
        description: 'Executa um único SELECT somente-leitura (PostgreSQL) com limite de linhas e timeout.',
        inputSchema: QueryDatabaseInput,
        execute: async (input) => queryDatabase(getReadDeps(), input, ctx),
      }),
    },
  });
}
