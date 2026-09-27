import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { actionTools, readTools, workflowTools } from '../../src/mastra/tools';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('regras de arquitetura', () => {
  it('o agente conhece a aplicação por poucas capabilities semânticas, não por CRUD', () => {
    expect(Object.keys(readTools)).toEqual(['inspectSchema', 'queryDatabase']);
    expect(Object.keys(actionTools)).toEqual(['cancelOrder', 'refundPayment', 'sendCustomerNotification']);
    expect(Object.keys(workflowTools)).toEqual(['startLateOrderNotifications']);
    const all = [...Object.keys(readTools), ...Object.keys(actionTools), ...Object.keys(workflowTools)];
    expect(all.filter((name) => /^(get|create|update|delete|insert|upsert)[A-Z]/.test(name))).toEqual([]);
  });

  it('tools não acessam repositórios nem SQL diretamente (Tool → Use Case)', () => {
    for (const file of filesUnder('src/mastra/tools')) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from '[^']*infrastructure\/repositories|getAppPool|\.query\(/);
    }
  });

  it('domínio não depende de Mastra, Next ou infraestrutura', () => {
    for (const file of filesUnder('src/domain')) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from '(@mastra\/|next|pg'|[^']*infrastructure\/)/);
    }
  });

  it('a única escrita exposta ao modelo passa por Domain Actions com schema do domínio', async () => {
    const { CancelOrderInput } = await import('../../src/domain/orders/cancel-order');
    const { RefundPaymentInput } = await import('../../src/domain/payments/refund-payment');
    expect(actionTools.cancelOrder.inputSchema).toBe(CancelOrderInput);
    expect(actionTools.refundPayment.inputSchema).toBe(RefundPaymentInput);
    expect(actionTools.refundPayment.requireApproval).toBe(true);
  });
});
