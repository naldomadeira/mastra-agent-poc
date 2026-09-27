import type { RequestContext } from '@mastra/core/request-context';
import type { ToolExecutionContext } from '@mastra/core/tools';

/** Contexto mínimo para executar uma tool diretamente em teste (sem agente). */
export function toolContext(requestContext: RequestContext, agent?: { toolCallId: string; threadId?: string }) {
  return { requestContext, agent } as unknown as ToolExecutionContext;
}
