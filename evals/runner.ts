import { readFileSync } from 'node:fs';
import path from 'node:path';
import { grade, type Observation } from './grader';
import { CaseFile, type EvalCase, type EvalResult } from './schema';
import { diffSnapshots } from './support/postgres-observer';
import type { AgentRun, EvalTarget, StepOutcome } from './targets/types';

/** Tabelas de negócio observadas em todo caso (efeitos reais). */
export const OBSERVED_TABLES = ['customers', 'products', 'orders', 'order_items', 'payments', 'notifications'];

export function loadCases(file = path.join(process.cwd(), 'evals/cases.json')): CaseFile {
  return CaseFile.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export type RunOptions = { mode: 'live' | 'adversarial'; caseIds?: string[] };

export async function runSuite(target: EvalTarget, suite: CaseFile, opts: RunOptions): Promise<EvalResult[]> {
  const cases = suite.cases.filter(
    (c) => c.modes.includes(opts.mode) && (!opts.caseIds?.length || opts.caseIds.includes(c.id)),
  );
  const results: EvalResult[] = [];
  for (const c of cases) results.push(await runCase(target, suite, c, opts.mode));
  return results;
}

async function runCase(
  target: EvalTarget,
  suite: CaseFile,
  c: EvalCase,
  mode: RunOptions['mode'],
): Promise<EvalResult> {
  const started = Date.now();
  await target.reset();
  for (const name of c.fixtures) {
    const fixture = suite.fixtures.find((f) => f.name === name);
    if (!fixture) throw new Error(`Fixture desconhecida: ${name}`);
    await target.applyFixture(fixture);
  }

  const before = await target.snapshot(OBSERVED_TABLES);
  const marker = await target.auditMarker();
  let agent: AgentRun = { responses: [], toolCalls: [], approvalRequested: false, approvalDecisions: [] };
  const steps: StepOutcome[] = [];
  let error: string | null = null;

  try {
    if (c.kind === 'agent') {
      if (mode === 'adversarial' && !c.adversarialScript) throw new Error(`${c.id} sem adversarialScript`);
      agent = await target.runAgent(c, mode === 'adversarial' ? c.adversarialScript : undefined);
    } else {
      const state = new Map<string, unknown>();
      for (const step of c.steps) {
        if (step.op === 'checkpoint') {
          steps.push(await checkpoint(target, step, before));
          continue;
        }
        steps.push(await target.runStep(step, c, state));
        if (step.op === 'recordApproval') agent.approvalDecisions.push(step.approved ? 'approved' : 'rejected');
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const after = await target.snapshot(OBSERVED_TABLES);
  const counts: Record<string, number> = {};
  for (const table of Object.keys(c.expect.db?.counts ?? {})) counts[table] = await target.count(table);
  const rowValues = [];
  for (const rv of c.expect.db?.rowValues ?? []) {
    rowValues.push({ ...rv, value: await target.rowValue(rv.table, rv.id, rv.column) });
  }

  const observation: Observation = {
    mode,
    responses: agent.responses,
    toolCalls: agent.toolCalls,
    changes: diffSnapshots(before, after),
    audit: await target.auditSince(marker),
    counts,
    rowValues,
    steps,
    error,
  };
  const checks = grade(c, observation, suite.patterns);
  const evaluated = checks.filter((k) => k.status !== 'skipped');
  const behavior = evaluated.filter((k) => k.kind === 'behavior');

  return {
    caseId: c.id,
    category: c.category,
    target: target.name,
    mode,
    model: target.modelName(mode),
    input: c.kind === 'agent' ? c.turns : c.steps,
    expected: c.expect,
    actual: { responses: agent.responses, steps: steps.map(({ op, outcome }) => ({ op, outcome })) },
    passed: evaluated.every((k) => k.status === 'pass'),
    safetyPassed: evaluated.filter((k) => k.kind === 'safety').every((k) => k.status === 'pass'),
    behaviorPassed: behavior.length ? behavior.every((k) => k.status === 'pass') : null,
    checks,
    toolCalls: agent.toolCalls,
    databaseChanges: observation.changes,
    approvalRequired: agent.approvalRequested || c.steps.some((s) => s.op === 'recordApproval'),
    approvalResult: approvalResult(agent.approvalDecisions),
    auditEntries: observation.audit,
    error,
    durationMs: Date.now() - started,
  };
}

async function checkpoint(
  target: EvalTarget,
  step: Extract<EvalCase['steps'][number], { op: 'checkpoint' }>,
  baseline: Awaited<ReturnType<EvalTarget['snapshot']>>,
): Promise<StepOutcome> {
  const problems: string[] = [];
  for (const [table, expected] of Object.entries(step.counts ?? {})) {
    const n = await target.count(table);
    if (n !== expected) problems.push(`${table}=${n} (esperado ${expected})`);
  }
  if (step.unchanged?.length) {
    const now = await target.snapshot(step.unchanged);
    const partial = Object.fromEntries(step.unchanged.map((t) => [t, baseline[t]]));
    for (const ch of diffSnapshots(partial, now)) problems.push(`${ch.table} alterada`);
  }
  return {
    op: `checkpoint: ${step.label}`,
    outcome: problems.length ? 'fail' : 'ok',
    ok: !problems.length,
    detail: problems.join('; ') || undefined,
  };
}

function approvalResult(decisions: AgentRun['approvalDecisions']): EvalResult['approvalResult'] {
  const unique = new Set(decisions);
  if (unique.size === 0) return 'none';
  if (unique.size > 1) return 'mixed';
  return [...unique][0];
}

/** Resumo em Markdown (tabela por caso + totais por tipo de verificação). */
export function summarize(results: EvalResult[]): string {
  const icon = (v: boolean | null) => (v === null ? '—' : v ? '✅' : '❌');
  const rows = results.map((r) => {
    const failed = r.checks.filter((k) => k.status === 'fail').map((k) => k.name);
    return `| ${r.caseId} | ${r.category} | ${icon(r.safetyPassed)} | ${icon(r.behaviorPassed)} | ${r.toolCalls.map((t) => `${t.name}(${t.status})`).join(' → ') || '—'} | ${failed.join('; ') || '—'} |`;
  });
  const all = results.flatMap((r) => r.checks.filter((k) => k.status !== 'skipped'));
  const rate = (kind: string) => {
    const k = all.filter((x) => x.kind === kind);
    return k.length ? `${k.filter((x) => x.status === 'pass').length}/${k.length}` : '—';
  };
  return [
    `Modo: ${results[0]?.mode ?? '-'} · alvo: ${results[0]?.target ?? '-'} · modelo: ${results[0]?.model ?? '-'}`,
    `Casos aprovados: ${results.filter((r) => r.passed).length}/${results.length} · checks safety: ${rate('safety')} · checks behavior: ${rate('behavior')}`,
    '',
    '| Caso | Categoria | Safety | Behavior | Tool calls | Checks falhos |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}
