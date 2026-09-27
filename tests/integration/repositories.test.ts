import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDeps } from '../../src/infrastructure/app-services';
import { closePools } from '../../src/infrastructure/database/pool';
import { resetDatabase } from '../helpers/db';

const repos = () => getDeps().uow.repos;

describe('Repositories (Postgres)', () => {
  beforeEach(resetDatabase);
  afterAll(closePools);

  it('orders.findById carrega itens e cliente', async () => {
    const order = await repos().orders.findById(1003);
    expect(order).toMatchObject({ id: 1003, customerName: 'João Silva', status: 'delivered' });
    expect(order?.items.map((i) => i.productName)).toEqual(['Notebook Pro 14', 'Monitor 27" 4K']);
  });

  it('orders.list filtra por status e cliente', async () => {
    const pending = await repos().orders.list({ status: 'pending_payment', limit: 50 });
    expect(pending.every((o) => o.status === 'pending_payment')).toBe(true);
    const joao = await repos().orders.list({ customerId: 1, limit: 50 });
    expect(joao.every((o) => o.customerId === 1)).toBe(true);
  });

  it('orders.listLate retorna candidatos pagos com prazo vencido', async () => {
    const late = await repos().orders.listLate(new Date(), 50);
    expect(late.map((o) => o.id)).toEqual([1008, 1002, 1005]);
  });

  it('transição de estado tem guarda de concorrência', async () => {
    await expect(repos().orders.markCancelled(1002, 'x', new Date())).rejects.toThrow(/mudou de estado/);
  });

  it('transação faz rollback em erro', async () => {
    await expect(
      getDeps().uow.transaction(async (r) => {
        await r.orders.markCancelled(1001, 'teste', new Date());
        throw new Error('falha no meio');
      }),
    ).rejects.toThrow('falha no meio');
    expect((await repos().orders.findById(1001))?.status).toBe('pending_payment');
  });

  it('approvals: primeira decisão prevalece e consumo é único', async () => {
    const base = {
      toolCallId: 't1',
      runId: 'r1',
      capability: 'refundPayment',
      input: { orderId: 1 },
      approverId: 'ana',
    };
    await repos().approvals.record({ ...base, approved: true }, new Date());
    await repos().approvals.record({ ...base, approved: false, approverId: 'bruno' }, new Date());
    expect(await repos().approvals.findByToolCallId('t1')).toMatchObject({ approved: true, approverId: 'ana' });
    expect(await repos().approvals.markConsumed('t1', new Date())).toBe(true);
    expect(await repos().approvals.markConsumed('t1', new Date())).toBe(false);
  });
});
