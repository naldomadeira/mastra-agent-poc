import type { Queryable } from '../database/pool';

export type AuditRow = {
  id: number;
  occurred_at: Date;
  actor_id: string;
  actor_role: string;
  channel: string;
  agent_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  tool_call_id: string | null;
  capability: string;
  kind: 'read' | 'action';
  input: unknown;
  outcome: string;
  result: unknown;
  error: string | null;
  approval_required: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  requested_by: string | null;
  approval_id: string | null;
  correlation_id: string | null;
};

/** Leitura operacional da trilha de auditoria (não exposta ao agente). */
export async function listAuditEntries(db: Queryable, filter: { kind?: 'read' | 'action'; limit: number }) {
  const { rows } = await db.query<AuditRow>(
    `SELECT * FROM audit_log WHERE ($1::text IS NULL OR kind = $1) ORDER BY id DESC LIMIT $2`,
    [filter.kind ?? null, filter.limit],
  );
  return rows;
}
