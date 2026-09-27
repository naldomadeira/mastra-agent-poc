import { PostgresStore } from '@mastra/pg';
import { getEnv } from '../config/env';

/**
 * Storage do Mastra (threads, mensagens, snapshots de runs suspensos, traces) no mesmo Postgres,
 * mas no schema `mastra` — separado das tabelas de negócio e invisível para a role do agente.
 */
export function createMastraStorage(): PostgresStore {
  return new PostgresStore({
    id: 'commerce-mastra-storage',
    connectionString: getEnv().DATABASE_URL,
    schemaName: 'mastra',
  });
}
