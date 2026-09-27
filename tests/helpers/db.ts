import { getAppPool } from '../../src/infrastructure/database/pool';
import { seed } from '../../src/infrastructure/database/seed';

/** Recria o dataset determinístico no banco de teste. */
export async function resetDatabase(): Promise<void> {
  const client = await getAppPool().connect();
  try {
    await seed(client);
  } finally {
    client.release();
  }
}

export async function lastAudit(capability: string) {
  const { rows } = await getAppPool().query('SELECT * FROM audit_log WHERE capability = $1 ORDER BY id DESC LIMIT 1', [
    capability,
  ]);
  return rows[0];
}

export async function orderStatus(id: number): Promise<{ order: string; payment: string }> {
  const { rows } = await getAppPool().query(
    'SELECT o.status AS order, p.status AS payment FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.id = $1',
    [id],
  );
  return rows[0];
}

/** Simula o que /api/chat faz quando o operador clica Aprovar/Rejeitar. */
export async function recordApproval(opts: {
  toolCallId: string;
  approverId: string;
  input: unknown;
  approved?: boolean;
  capability?: string;
}): Promise<void> {
  const { getDeps } = await import('../../src/infrastructure/app-services');
  await getDeps().uow.repos.approvals.record(
    {
      toolCallId: opts.toolCallId,
      runId: 'run-test',
      capability: opts.capability ?? 'refundPayment',
      input: opts.input,
      approved: opts.approved ?? true,
      approverId: opts.approverId,
    },
    new Date(),
  );
}
