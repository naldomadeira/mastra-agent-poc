// Mesmo separador que @mastra/ai-sdk usa para codificar o approvalId (não exportado publicamente).
const APPROVAL_ID_SEPARATOR = '::';

/** Decisão humana sobre uma tool call pausada, extraída da mensagem enviada pela UI. */
export type ApprovalDecision = {
  runId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  approved: boolean;
  reason?: string;
};

type UIPartLike = {
  type?: string;
  state?: string;
  toolCallId?: string;
  input?: unknown;
  approval?: { id?: string; approved?: boolean; reason?: string };
};

/**
 * Lê as respostas de aprovação (AI SDK v7, estado `approval-responded`) da última mensagem.
 * O approvalId gerado pelo @mastra/ai-sdk codifica `runId::toolCallId`.
 */
export function extractApprovalDecisions(
  message: { role?: string; parts?: unknown[] } | undefined,
): ApprovalDecision[] {
  if (message?.role !== 'assistant' || !Array.isArray(message.parts)) return [];
  return (message.parts as UIPartLike[]).flatMap((part) => {
    if (!part.type?.startsWith('tool-') || part.state !== 'approval-responded') return [];
    const { id, approved, reason } = part.approval ?? {};
    if (!id || typeof approved !== 'boolean') return [];
    const [runId, toolCallId] = id.split(APPROVAL_ID_SEPARATOR);
    if (!runId || !toolCallId) return [];
    return [{ runId, toolCallId, toolName: part.type.slice('tool-'.length), input: part.input, approved, reason }];
  });
}
