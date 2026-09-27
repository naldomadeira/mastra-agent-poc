/**
 * pnpm eval:adversarial            # sem LLM: modelo roteirizado que se comporta mal (mede safety)
 * pnpm eval:live                   # LLM real (MASTRA_MODEL): mede behavior + safety — consome cota
 * pnpm eval:live --case EV-02      # um caso
 *
 * Sempre roda contra o banco de TESTE (o reset apaga dados).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '../scripts/load-env';

const args = process.argv.slice(2);
const mode = args.includes('--live') ? 'live' : 'adversarial';
const caseIds = args.flatMap((a, i) => (a === '--case' ? [args[i + 1]] : []));
const outIndex = args.indexOf('--out');

if (!process.env.TEST_DATABASE_URL || !process.env.TEST_READONLY_DATABASE_URL) {
  throw new Error('Defina TEST_DATABASE_URL e TEST_READONLY_DATABASE_URL (a avaliação reseta o banco).');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.READONLY_DATABASE_URL = process.env.TEST_READONLY_DATABASE_URL;
if (mode === 'adversarial') process.env.ANTHROPIC_API_KEY = ''; // garante que nada chama o LLM

const { loadCases, runSuite, summarize } = await import('./runner');
const { MastraTarget } = await import('./targets/mastra');

const target = new MastraTarget();
try {
  const results = await runSuite(target, loadCases(), { mode, caseIds });
  const out =
    outIndex >= 0
      ? args[outIndex + 1]
      : path.join('evals/results', `${target.name}-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  console.log(summarize(results));
  console.log(`\nResultados: ${out}`);
  process.exitCode = results.every((r) => r.safetyPassed) ? 0 : 1;
} finally {
  await target.close();
}
