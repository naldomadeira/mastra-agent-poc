import type pg from 'pg';
import type { AuditRecord, DbChange, Fixture } from '../schema';
import type { DbSnapshot } from '../targets/types';

/**
 * Observador do banco compartilhável entre POCs com o mesmo schema commerce.
 * Tudo aqui é SQL puro sobre o pool da aplicação (fora da role do agente).
 */

const TABLE = /^[a-z_]+$/;
const ident = (name: string) => {
  if (!TABLE.test(name)) throw new Error(`Nome de tabela inválido: ${name}`);
  return name;
};

export async function snapshotTables(db: pg.Pool, tables: string[]): Promise<DbSnapshot> {
  const snap: DbSnapshot = {};
  for (const table of tables) {
    const { rows } = await db.query<{ id: number; h: string }>(`SELECT id, md5(t::text) AS h FROM ${ident(table)} t`);
    snap[table] = new Map(rows.map((r) => [r.id, r.h]));
  }
  return snap;
}

export function diffSnapshots(before: DbSnapshot, after: DbSnapshot): DbChange[] {
  return Object.keys(before).flatMap((table) => {
    const a = before[table];
    const b = after[table] ?? new Map();
    const added = [...b.keys()].filter((id) => !a.has(id));
    const removed = [...a.keys()].filter((id) => !b.has(id));
    const changed = [...a.keys()].filter((id) => b.has(id) && a.get(id) !== b.get(id));
    return added.length || removed.length || changed.length ? [{ table, added, removed, changed }] : [];
  });
}

export async function rowValue(db: pg.Pool, table: string, id: number, column: string): Promise<unknown> {
  if (!TABLE.test(column)) throw new Error(`Coluna inválida: ${column}`);
  const { rows } = await db.query(`SELECT ${column} AS v FROM ${ident(table)} WHERE id = $1`, [id]);
  return rows[0]?.v;
}

export async function countRows(db: pg.Pool, table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${ident(table)}`);
  return rows[0].n;
}

export async function auditMarker(db: pg.Pool): Promise<number> {
  const { rows } = await db.query<{ m: number }>('SELECT coalesce(max(id), 0)::int AS m FROM audit_log');
  return rows[0].m;
}

export async function auditSince(db: pg.Pool, marker: number): Promise<AuditRecord[]> {
  const { rows } = await db.query(
    `SELECT capability, kind, outcome, actor_id AS "actorId", channel, approved_by AS "approvedBy", error
     FROM audit_log WHERE id > $1 ORDER BY id`,
    [marker],
  );
  return rows;
}

export async function applyFixture(db: pg.Pool, fixture: Fixture): Promise<void> {
  for (const sql of fixture.sql) await db.query(sql);
}
