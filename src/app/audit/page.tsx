import { getCurrentActor } from '@/app/_lib/session';
import { can } from '@/domain/operators/operator';
import { getAppPool } from '@/infrastructure/database/pool';
import { listAuditEntries } from '@/infrastructure/repositories/audit-queries';

export const dynamic = 'force-dynamic';

const OUTCOME_STYLE: Record<string, string> = {
  success: 'bg-emerald-50 text-emerald-700',
  rejected: 'bg-amber-50 text-amber-800',
  denied: 'bg-red-50 text-red-700',
  error: 'bg-red-100 text-red-800',
};

/**
 * Responde: quem pediu, qual agente, qual capability, com quais parâmetros, resultado,
 * se exigiu aprovação, quem aprovou, quando, e se houve erro.
 */
export default async function AuditPage({ searchParams }: PageProps<'/audit'>) {
  const actor = await getCurrentActor();
  if (!can(actor, 'audit:read')) {
    return (
      <p className="p-6 text-sm text-red-700">
        {actor.name} ({actor.role}) não tem permissão audit:read.
      </p>
    );
  }
  const { kind } = await searchParams;
  const entries = await listAuditEntries(getAppPool(), {
    kind: kind === 'read' || kind === 'action' ? kind : undefined,
    limit: 200,
  });

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-6">
      <div className="flex items-baseline gap-4">
        <h1 className="text-lg font-semibold">Auditoria de capabilities</h1>
        <nav className="flex gap-3 text-sm text-zinc-600">
          <a href="/audit">todas</a>
          <a href="/audit?kind=action">ações</a>
          <a href="/audit?kind=read">leituras</a>
        </nav>
        <span className="ml-auto text-xs text-zinc-500">
          Traces completos (LLM, tokens, latência) no Mastra Studio: <code>pnpm dev:mastra</code> → localhost:4466
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="bg-zinc-50 text-zinc-500">
            <tr>
              {['Quando', 'Quem', 'Canal', 'Agente / run', 'Capability', 'Parâmetros', 'Resultado', 'Aprovação'].map(
                (h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-zinc-100 align-top">
                <td className="px-3 py-2 whitespace-nowrap">{e.occurred_at.toLocaleString('pt-BR')}</td>
                <td className="px-3 py-2">
                  {e.actor_id} <span className="text-zinc-400">({e.actor_role})</span>
                </td>
                <td className="px-3 py-2">{e.channel}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-zinc-500">
                  {e.agent_id ?? '—'}
                  {e.thread_id && <div>thread {e.thread_id.slice(0, 8)}</div>}
                  {e.run_id && <div>run {e.run_id.slice(0, 8)}</div>}
                </td>
                <td className="px-3 py-2">
                  <span className="font-mono">{e.capability}</span>
                  <div className="text-zinc-400">{e.kind}</div>
                </td>
                <td className="max-w-xs px-3 py-2 font-mono text-[11px] break-words">{JSON.stringify(e.input)}</td>
                <td className="max-w-xs px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 ${OUTCOME_STYLE[e.outcome] ?? ''}`}>{e.outcome}</span>
                  {e.error && <div className="mt-1 text-red-700">{e.error}</div>}
                </td>
                <td className="px-3 py-2">
                  {e.approval_required ? (
                    e.approved_by ? (
                      <>
                        aprovado por <b>{e.approved_by}</b>
                        <div className="text-zinc-400">{e.approved_at?.toLocaleString('pt-BR')}</div>
                      </>
                    ) : (
                      'exigida — não concedida'
                    )
                  ) : (
                    <span className="text-zinc-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
