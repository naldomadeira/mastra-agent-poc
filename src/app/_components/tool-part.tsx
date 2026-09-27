import type { ReactNode } from 'react';
import { ApprovalCard } from './approval-card';

export type ToolPartView = {
  type: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
};

type Props = {
  part: ToolPartView;
  onApprovalResponse: (response: { id: string; approved: boolean; reason?: string }) => void;
  renderOutput?: (toolName: string, output: unknown) => ReactNode;
};

const STATE_LABEL: Record<string, { label: string; className: string }> = {
  'input-streaming': { label: 'preparando', className: 'bg-zinc-100 text-zinc-600' },
  'input-available': { label: 'executando', className: 'bg-blue-50 text-blue-700' },
  'approval-requested': { label: 'aguardando aprovação', className: 'bg-amber-50 text-amber-800' },
  'approval-responded': { label: 'decisão enviada', className: 'bg-zinc-100 text-zinc-700' },
  'output-available': { label: 'concluída', className: 'bg-emerald-50 text-emerald-700' },
  'output-error': { label: 'erro', className: 'bg-red-50 text-red-700' },
  'output-denied': { label: 'rejeitada', className: 'bg-red-50 text-red-700' },
};

const KIND: Record<string, string> = {
  inspectSchema: 'leitura',
  queryDatabase: 'leitura',
  cancelOrder: 'ação',
  refundPayment: 'ação sensível',
  sendCustomerNotification: 'ação',
  startLateOrderNotifications: 'workflow',
};

/** Mostra cada tool call como um passo visível: nome, tipo de capability, estado, entrada e saída. */
export function ToolPart({ part, onApprovalResponse, renderOutput }: Props) {
  const toolName = part.type.replace(/^tool-/, '');
  const state = STATE_LABEL[part.state] ?? { label: part.state, className: 'bg-zinc-100 text-zinc-600' };
  const businessError = isBusinessError(part.output);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white text-sm">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
        <span className="font-mono font-medium">{toolName}</span>
        {KIND[toolName] && <span className="text-xs text-zinc-500">{KIND[toolName]}</span>}
        <span
          className={`ml-auto rounded px-2 py-0.5 text-xs ${businessError ? STATE_LABEL['output-error'].className : state.className}`}
        >
          {businessError ? 'recusada pela aplicação' : state.label}
        </span>
      </div>

      <div className="space-y-2 px-3 py-2">
        <ToolInput toolName={toolName} input={part.input} />

        {part.state === 'approval-requested' && part.approval && (
          <ApprovalCard
            toolName={toolName}
            input={part.input}
            approvalId={part.approval.id}
            onRespond={onApprovalResponse}
          />
        )}
        {part.state === 'output-denied' && <p className="text-red-700">Execução rejeitada pelo aprovador.</p>}
        {part.state === 'output-error' && <p className="text-red-700">{part.errorText}</p>}
        {part.state === 'output-available' &&
          (renderOutput?.(toolName, part.output) ?? <DefaultOutput toolName={toolName} output={part.output} />)}
      </div>
    </div>
  );
}

function ToolInput({ toolName, input }: { toolName: string; input: unknown }) {
  if (!input) return null;
  if (toolName === 'queryDatabase' && typeof input === 'object' && input && 'sql' in input) {
    return (
      <pre className="overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-xs text-zinc-100">{String(input.sql)}</pre>
    );
  }
  return (
    <details>
      <summary className="cursor-pointer text-xs text-zinc-500">parâmetros</summary>
      <pre className="mt-1 overflow-x-auto rounded bg-zinc-50 p-2 font-mono text-xs">
        {JSON.stringify(input, null, 2)}
      </pre>
    </details>
  );
}

function DefaultOutput({ toolName, output }: { toolName: string; output: unknown }) {
  if (isBusinessError(output)) {
    return (
      <p className="text-red-700">
        <span className="font-mono text-xs">{output.code}</span> {output.error}
      </p>
    );
  }
  const summary =
    toolName === 'queryDatabase' && isQueryOk(output)
      ? `${output.rowCount} linha(s)${output.truncated ? ' (truncado)' : ''} em ${output.durationMs} ms`
      : toolName === 'inspectSchema'
        ? 'schema carregado'
        : 'resultado';
  return (
    <details>
      <summary className="cursor-pointer text-xs text-zinc-500">{summary}</summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded bg-zinc-50 p-2 font-mono text-xs">
        {JSON.stringify(output, null, 2)}
      </pre>
    </details>
  );
}

function isBusinessError(output: unknown): output is { ok: false; error: string; code?: string } {
  return typeof output === 'object' && output !== null && 'ok' in output && output.ok === false;
}

function isQueryOk(output: unknown): output is { rowCount: number; truncated: boolean; durationMs: number } {
  return typeof output === 'object' && output !== null && 'rowCount' in output;
}
