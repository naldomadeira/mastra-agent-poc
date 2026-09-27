import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { InspectSchemaInput, inspectSchema } from '../../../application/knowledge/inspect-schema';
import { getReadonlyPool } from '../../../infrastructure/database/pool';
import { actionContextFrom } from '../../request-context';

const Column = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  description: z.string().nullable(),
});

export const inspectSchemaTool = createTool({
  id: 'inspectSchema',
  description:
    'Descreve as tabelas e views que você pode consultar (colunas, tipos, descrições de negócio, chaves estrangeiras e convenções). Chame antes de escrever SQL para queryDatabase.',
  inputSchema: InspectSchemaInput,
  outputSchema: z.object({
    relations: z.array(
      z.object({
        name: z.string(),
        kind: z.enum(['table', 'view']),
        description: z.string().nullable(),
        columns: z.array(Column),
      }),
    ),
    foreignKeys: z.array(z.object({ from: z.string(), to: z.string() })),
    conventions: z.array(z.string()),
  }),
  execute: async (input, context) => inspectSchema(getReadonlyPool(), input, actionContextFrom(context)),
});
