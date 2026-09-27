import { getCurrentActor } from '@/app/_lib/session';
import { can } from '@/domain/operators/operator';
import { formatBRL } from '@/domain/shared/money';
import { getDeps } from '@/infrastructure/app-services';

export const dynamic = 'force-dynamic';

/** Tela convencional, sem IA: prova que o domínio funciona sozinho e mostra o efeito das ações. */
export default async function OrdersPage() {
  const actor = await getCurrentActor();
  if (!can(actor, 'data:read')) return <p className="p-6 text-sm text-red-700">Sem permissão.</p>;
  const orders = await getDeps().uow.repos.orders.list({ limit: 100 });

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">Pedidos</h1>
      <p className="text-sm text-zinc-600">
        Mesmo domínio que o agente usa. Cancelamento via HTTP: <code>POST /api/orders/:id/cancel</code>.
      </p>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500">
            <tr>
              {['Pedido', 'Cliente', 'Status', 'Total', 'Data', 'Prazo de envio'].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-zinc-100">
                <td className="px-3 py-1.5 font-mono">#{o.id}</td>
                <td className="px-3 py-1.5">{o.customerName}</td>
                <td className="px-3 py-1.5">{o.status}</td>
                <td className="px-3 py-1.5">{formatBRL(o.totalCents)}</td>
                <td className="px-3 py-1.5">{o.placedAt.toLocaleDateString('pt-BR')}</td>
                <td className="px-3 py-1.5">{o.expectedShipBy.toLocaleDateString('pt-BR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
