import { useState } from 'react';

type Notification = { customerId: number; customerName: string; orderIds: number[]; subject: string; message: string };
type Skipped = { orderId: number; customerId: number; reason: string };
type Preview = { notifications?: Notification[]; skipped?: Skipped[] };
type Outcome = {
  status: string;
  result: { status: string; sent: { customerId: number }[]; failed: { customerId: number; error: string }[] } | null;
  error: string | null;
};

type Props = { output: unknown };

/** Mostra o workflow suspenso na etapa de aprovação e retoma com a decisão do operador. */
export function WorkflowRunCard({ output }: Props) {
  const { runId, status, preview } = (output ?? {}) as { runId?: string; status?: string; preview?: Preview };
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (!runId) return null;
  const notifications = preview?.notifications ?? [];
  const skipped = preview?.skipped ?? [];

  async function decide(approved: boolean) {
    setSending(true);
    setError(null);
    const res = await fetch(`/api/workflows/late-order-notifications/${runId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved }),
    });
    const body = await res.json();
    setSending(false);
    if (res.ok) setOutcome(body);
    else setError(body.error?.message ?? 'Falha ao retomar o workflow');
  }

  return (
    <div className="space-y-3 rounded-md border border-violet-200 bg-violet-50 p-3">
      <p className="text-xs text-violet-800">
        Workflow determinístico <span className="font-mono">lateOrderNotificationWorkflow</span> · run{' '}
        <span className="font-mono">{runId.slice(0, 8)}</span> · {status}
      </p>

      {notifications.length === 0 && status !== 'suspended' && <p>Nenhuma notificação a enviar.</p>}

      {notifications.map((n) => (
        <div key={n.customerId} className="rounded border border-violet-100 bg-white p-2">
          <p className="font-medium">
            {n.customerName} · pedidos {n.orderIds.map((id) => `#${id}`).join(', ')}
          </p>
          <p className="text-xs text-zinc-500">{n.subject}</p>
          <pre className="mt-1 font-sans text-xs whitespace-pre-wrap text-zinc-700">{n.message}</pre>
        </div>
      ))}

      {skipped.length > 0 && (
        <div className="text-xs text-zinc-600">
          <p className="font-medium">Ignorados pelas regras:</p>
          <ul className="list-disc pl-5">
            {skipped.map((s) => (
              <li key={s.orderId}>
                #{s.orderId}: {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {status === 'suspended' && !outcome && (
        <div className="flex gap-2">
          <button
            disabled={sending}
            onClick={() => decide(true)}
            className="rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Aprovar envio
          </button>
          <button
            disabled={sending}
            onClick={() => decide(false)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-medium hover:bg-zinc-50 disabled:opacity-50"
          >
            Rejeitar
          </button>
        </div>
      )}

      {outcome?.result && (
        <p className="font-medium text-emerald-800">
          {outcome.result.status === 'sent'
            ? `Enviadas: ${outcome.result.sent.length}. Falhas: ${outcome.result.failed.length}.`
            : `Resultado: ${outcome.result.status}.`}
          {outcome.result.failed.map((f) => (
            <span key={f.customerId} className="block font-normal text-red-700">
              Cliente {f.customerId}: {f.error}
            </span>
          ))}
        </p>
      )}
      {outcome?.error && <p className="text-red-700">{outcome.error}</p>}
      {error && <p className="text-red-700">{error}</p>}
    </div>
  );
}
