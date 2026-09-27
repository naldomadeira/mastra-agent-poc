'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Operator = { id: string; name: string; role: string };
type Session = { actor: Operator; operators: Operator[] };

/** Troca o operador da sessão de demonstração (o backend autoriza com base nele). */
export function OperatorSwitcher() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    fetch('/api/session')
      .then((r) => (r.ok ? r.json() : null))
      .then(setSession)
      .catch(() => setSession(null));
  }, []);

  if (!session) return <span className="text-xs text-zinc-400">sessão…</span>;

  async function change(operatorId: string) {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorId }),
    });
    if (res.ok) {
      const { actor } = await res.json();
      setSession((s) => (s ? { ...s, actor } : s));
      window.dispatchEvent(new Event('operator-changed'));
      router.refresh();
    }
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-zinc-500">Operador</span>
      <select
        className="rounded-md border border-zinc-300 bg-white px-2 py-1"
        value={session.actor.id}
        onChange={(e) => change(e.target.value)}
      >
        {session.operators.map((op) => (
          <option key={op.id} value={op.id}>
            {op.name} — {op.role}
          </option>
        ))}
      </select>
    </label>
  );
}
