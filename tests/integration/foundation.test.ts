import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHealth } from '../../src/infrastructure/database/health';
import { closePools, getAppPool } from '../../src/infrastructure/database/pool';
import { resetDatabase } from '../helpers/db';

describe('foundation', () => {
  beforeAll(resetDatabase);
  afterAll(closePools);

  it('health check reporta banco e role readonly saudáveis', async () => {
    const report = await checkHealth();
    expect(report, JSON.stringify(report)).toMatchObject({ status: 'ok' });
    expect(report.checks.readonlyRole.ok).toBe(true);
  });

  it('seed cria os cenários fixos da demo', async () => {
    const { rows } = await getAppPool().query(
      'SELECT order_id, status, is_late FROM order_overview WHERE order_id IN (1001, 1002, 1007) ORDER BY order_id',
    );
    expect(rows).toEqual([
      { order_id: 1001, status: 'pending_payment', is_late: false },
      { order_id: 1002, status: 'paid', is_late: true },
      { order_id: 1007, status: 'shipped', is_late: false },
    ]);
  });
});
