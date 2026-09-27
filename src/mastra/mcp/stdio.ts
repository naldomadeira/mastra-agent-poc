/**
 * Servidor MCP via stdio para clientes locais (Claude Desktop/Code, Cursor...).
 *
 *   pnpm mcp                       # operador: MCP_OPERATOR_ID (padrão: carla, viewer)
 *
 * stdout é o canal do protocolo: nada de console.log aqui.
 */
import { getDeps } from '../../infrastructure/app-services';
import { createCommerceMcpServer } from './commerce-mcp-server';

try {
  process.loadEnvFile('.env');
} catch {
  // ambiente já fornecido pelo cliente MCP
}

const operatorId = process.env.MCP_OPERATOR_ID ?? 'carla';
const actor = await getDeps().uow.repos.operators.findById(operatorId);
if (!actor) {
  console.error(`[mcp] operador desconhecido: ${operatorId}`);
  process.exit(1);
}

console.error(`[mcp] commerce-capabilities iniciado como ${actor.name} (${actor.role})`);
await createCommerceMcpServer(actor).startStdio();
