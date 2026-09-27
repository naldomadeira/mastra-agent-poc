import type pg from 'pg';
import { z } from 'zod';
import { assertCan } from '../../domain/operators/operator';
import type { ActionContext } from '../../domain/shared/action-context';

export const InspectSchemaInput = z.object({
  tables: z.array(z.string()).max(20).optional().describe('Filtra por nomes de tabela/view; omita para ver tudo'),
});
export type InspectSchemaInput = z.infer<typeof InspectSchemaInput>;

export type SchemaColumn = { name: string; type: string; nullable: boolean; description: string | null };
export type SchemaRelation = {
  name: string;
  kind: 'table' | 'view';
  description: string | null;
  columns: SchemaColumn[];
};
export type SchemaDescription = {
  relations: SchemaRelation[];
  foreignKeys: Array<{ from: string; to: string }>;
  conventions: string[];
};

/** Regras de leitura que não cabem em COMMENT ON: convenções transversais do modelo de dados. */
const CONVENTIONS = [
  'Valores monetários em colunas *_cents são centavos de BRL (divida por 100). Views já expõem *_brl.',
  'Datas são timestamptz; a sessão de consulta usa o fuso da aplicação, então ::date e date_trunc já respeitam o "hoje" local.',
  'Prefira as views order_overview, customer_spend e product_sales: elas codificam as definições de negócio (atraso, receita).',
  'O schema mostrado é exatamente o que a role do agente pode ler; colunas omitidas (ex.: e-mail) não são acessíveis.',
  'Nomes de pessoas são nomes completos (ex.: "João Silva"). Ao buscar por nome informado pelo usuário, use correspondência parcial e sem diferenciar maiúsculas: customer_name ILIKE \'%João%\'. Se houver mais de um cliente, liste-os.',
];

/**
 * Descreve o schema VISÍVEL para a role do agente: information_schema já filtra por privilégio,
 * então o agente só "conhece" o que pode consultar. Descrições vêm de COMMENT ON (migrations).
 */
export async function inspectSchema(
  readonlyPool: pg.Pool,
  rawInput: InspectSchemaInput,
  ctx: ActionContext,
): Promise<SchemaDescription> {
  assertCan(ctx.actor, 'data:read');
  const input = InspectSchemaInput.parse(rawInput);
  const filter = input.tables?.length ? input.tables : null;

  const { rows } = await readonlyPool.query<{
    relation: string;
    kind: 'table' | 'view';
    relation_description: string | null;
    column_name: string;
    data_type: string;
    is_nullable: 'YES' | 'NO';
    column_description: string | null;
  }>(
    `SELECT c.table_name AS relation,
            CASE t.table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END AS kind,
            obj_description(format('%I.%I', c.table_schema, c.table_name)::regclass) AS relation_description,
            c.column_name, c.data_type, c.is_nullable,
            col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) AS column_description
     FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND ($1::text[] IS NULL OR c.table_name = ANY($1))
     ORDER BY t.table_type, c.table_name, c.ordinal_position`,
    [filter],
  );

  const relations = new Map<string, SchemaRelation>();
  for (const r of rows) {
    const rel = relations.get(r.relation) ?? {
      name: r.relation,
      kind: r.kind,
      description: r.relation_description,
      columns: [],
    };
    rel.columns.push({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === 'YES',
      description: r.column_description,
    });
    relations.set(r.relation, rel);
  }

  const fks = await readonlyPool.query<{ from: string; to: string }>(
    `SELECT format('%s.%s', src.relname, a.attname) AS "from", format('%s.%s', dst.relname, b.attname) AS "to"
     FROM pg_constraint k
     JOIN pg_class src ON src.oid = k.conrelid
     JOIN pg_class dst ON dst.oid = k.confrelid
     JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
     JOIN pg_attribute b ON b.attrelid = k.confrelid AND b.attnum = k.confkey[1]
     WHERE k.contype = 'f' AND src.relname = ANY($1) AND dst.relname = ANY($1)`,
    [[...relations.keys()]],
  );

  return { relations: [...relations.values()], foreignKeys: fks.rows, conventions: CONVENTIONS };
}
