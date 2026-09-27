import type { Actor } from '../operators/operator';

export type Channel = 'agent' | 'http' | 'mcp' | 'workflow' | 'system';

/**
 * Contexto de execução de qualquer capability. Montado pela borda (rota HTTP, tool, MCP,
 * workflow) a partir de dados confiáveis do servidor — nunca a partir do texto do modelo.
 */
export type ActionContext = {
  actor: Actor;
  channel: Channel;
  agentId?: string;
  threadId?: string;
  runId?: string;
  /** Identifica a solicitação do agente; é a chave da evidência de aprovação (action_approvals). */
  toolCallId?: string;
};
