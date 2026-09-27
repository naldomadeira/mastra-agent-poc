import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { QueryDatabaseInput, queryDatabase } from '../../../application/knowledge/query-database';
import { getReadDeps } from '../../../application/knowledge/read-deps';
import { actionContextFrom } from '../../request-context';

export const queryDatabaseTool = createTool({
  id: 'queryDatabase',
  description:
    'Executa UMA consulta SELECT somente-leitura (PostgreSQL) e retorna linhas. Use para qualquer pergunta sobre dados. Escritas são impossíveis aqui: para agir use as tools de ação. Resultado limitado em linhas e tempo; prefira agregações.',
  inputSchema: QueryDatabaseInput,
  outputSchema: z.union([
    z.object({
      ok: z.literal(true),
      columns: z.array(z.string()),
      rows: z.array(z.record(z.string(), z.unknown())),
      rowCount: z.number(),
      truncated: z.boolean(),
      durationMs: z.number(),
    }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
  execute: async (input, context) => queryDatabase(getReadDeps(), input, actionContextFrom(context)),
});
