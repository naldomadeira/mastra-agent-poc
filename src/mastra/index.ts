import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { createCommerceAgent } from './agents/commerce-agent';
import { createMastraStorage } from './storage';
import { lateOrderNotificationWorkflow } from './workflows/late-order-notifications';

// O storage (pool de conexões) é reaproveitado entre reavaliações do módulo no hot reload do
// Next; agentes/tools são recriados para refletir mudanças de código.
const globalForMastra = globalThis as { __mastraStorage?: ReturnType<typeof createMastraStorage> };
const storage = (globalForMastra.__mastraStorage ??= createMastraStorage());

function createMastra() {
  return new Mastra({
    agents: { commerceAgent: createCommerceAgent() },
    workflows: { lateOrderNotificationWorkflow },
    storage,
    logger: new PinoLogger({ name: 'commerce-agent-poc', level: 'info' }),
    // Tracing nativo: spans de agente, LLM, tools e workflows persistidos no Postgres (schema
    // `mastra`) e visíveis no Studio. Ator e canal viram metadados de cada trace.
    observability: new Observability({
      configs: {
        default: {
          serviceName: 'commerce-agent-poc',
          exporters: [new MastraStorageExporter()],
          spanOutputProcessors: [new SensitiveDataFilter()],
          requestContextKeys: ['actor.id', 'actor.role', 'channel'],
        },
      },
    }),
    server: { port: 4466 },
  });
}

export const mastra = createMastra();
