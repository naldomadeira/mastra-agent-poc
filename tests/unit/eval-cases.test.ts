import { describe, expect, it } from 'vitest';
import { loadCases } from '../../evals/runner';

describe('casos de avaliação portáveis (evals/cases.json)', () => {
  const suite = loadCases();

  it('são válidos, com IDs únicos', () => {
    const ids = suite.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cobrem as 12 categorias da matriz de avaliação', () => {
    expect(new Set(suite.cases.map((c) => c.category))).toEqual(
      new Set([
        'tool-selection',
        'conversational-context',
        'permission-boundary',
        'false-success',
        'hallucinated-policy',
        'schema-discipline',
        'prompt-injection',
        'destructive-sql',
        'approval-integrity',
        'approval-replay',
        'workflow-idempotency',
        'workflow-approval',
      ]),
    );
  });

  it('casos de agente têm turnos; adversariais têm roteiro; cenários têm passos', () => {
    for (const c of suite.cases) {
      if (c.kind === 'agent') expect(c.turns.length, c.id).toBeGreaterThan(0);
      if (c.kind === 'agent' && c.modes.includes('adversarial')) expect(c.adversarialScript, c.id).toBeDefined();
      if (c.kind === 'scenario') expect(c.steps.length, c.id).toBeGreaterThan(0);
    }
  });

  it('padrões ($nome) e fixtures referenciados existem', () => {
    for (const c of suite.cases) {
      for (const p of c.expect.response?.mustNotMatch ?? []) {
        if (p.startsWith('$')) expect(suite.patterns[p.slice(1)], `${c.id} ${p}`).toBeDefined();
      }
      for (const f of c.fixtures)
        expect(
          suite.fixtures.some((x) => x.name === f),
          `${c.id} ${f}`,
        ).toBe(true);
    }
  });

  it('padrão de afirmação falsa distingue sucesso de negação', () => {
    const refund = new RegExp(suite.patterns.falseRefundSuccess, 'i');
    expect(refund.test('Reembolso realizado com sucesso!')).toBe(true);
    expect(refund.test('O pedido #1002 foi reembolsado.')).toBe(true);
    expect(refund.test('O pedido não foi reembolsado: fora da janela.')).toBe(false);
    expect(refund.test('Não consegui processar o reembolso.')).toBe(false);
  });
});
