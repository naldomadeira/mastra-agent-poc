import { useEffect, useState } from 'react';

type Preview = {
  orderId: number;
  customerName: string;
  amount: string;
  paymentMethod: string | null;
  eligible: boolean;
  ineligibleReason: string | null;
};

type Props = {
  toolName: string;
  input: unknown;
  approvalId: string;
  onRespond: (response: { id: string; approved: boolean; reason?: string }) => void;
};

/**
 * Cartão de aprovação humana. Os dados exibidos (cliente, valor) vêm do BACKEND
 * (`/refund-preview`), não do texto do modelo: o aprovador vê o que realmente será executado.
 */
export function ApprovalCard({ toolName, input, approvalId, onRespond }: Props) {
  const args = (input ?? {}) as { orderId?: number; reason?: string };
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (toolName !== 'refundPayment' || !args.orderId) return;
    fetch(`/api/orders/${args.orderId}/refund-preview`)
      .then(async (r) => {
        const body = await r.json();
        if (r.ok) setPreview(body);
        else setPreviewError(body.error?.message ?? 'Falha ao carregar prévia');
      })
      .catch(() => setPreviewError('Falha ao carregar prévia'));
  }, [toolName, args.orderId]);

  function respond(approved: boolean) {
    setSent(true);
    onRespond({ id: approvalId, approved, reason: approved ? undefined : 'Rejeitado pelo operador na interface' });
  }

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-zinc-500">Ação identificada</dt>
        <dd className="font-mono">{toolName}</dd>
        {args.orderId && (
          <>
            <dt className="text-zinc-500">Pedido</dt>
            <dd>#{args.orderId}</dd>
          </>
        )}
        {preview && (
          <>
            <dt className="text-zinc-500">Cliente</dt>
            <dd>{preview.customerName}</dd>
            <dt className="text-zinc-500">Valor</dt>
            <dd className="font-semibold">
              {preview.amount}{' '}
              {preview.paymentMethod && <span className="font-normal text-zinc-500">({preview.paymentMethod})</span>}
            </dd>
          </>
        )}
        {args.reason && (
          <>
            <dt className="text-zinc-500">Motivo</dt>
            <dd>{args.reason}</dd>
          </>
        )}
        <dt className="text-zinc-500">Status</dt>
        <dd className="font-medium text-amber-800">Aguardando aprovação</dd>
      </dl>

      {preview && !preview.eligible && (
        <p className="mt-2 text-red-700">Atenção: a aplicação vai recusar esta ação — {preview.ineligibleReason}</p>
      )}
      {previewError && <p className="mt-2 text-red-700">{previewError}</p>}

      <div className="mt-3 flex gap-2">
        <button
          disabled={sent}
          onClick={() => respond(true)}
          className="rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          Aprovar
        </button>
        <button
          disabled={sent}
          onClick={() => respond(false)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-medium hover:bg-zinc-50 disabled:opacity-50"
        >
          Rejeitar
        </button>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        A aprovação registra você como aprovador. A aplicação ainda verifica se seu papel pode aprovar.
      </p>
    </div>
  );
}
