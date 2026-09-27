import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import type { ActionContext, Channel } from '../domain/shared/action-context';
import type { Actor } from '../domain/operators/operator';

/**
 * Contexto confiável da requisição. Preenchido SOMENTE pelo servidor (rota HTTP, servidor MCP,
 * workflow) — é daqui que as tools tiram "quem está pedindo", nunca dos argumentos do modelo.
 */
export type CommerceContext = {
  actor: Actor;
  channel: Channel;
  /** x-request-id da requisição de origem */
  correlationId?: string;
};

const ActorSchema = z.object({ id: z.string(), name: z.string(), role: z.enum(['viewer', 'support', 'manager']) });

export function createCommerceContext(value: CommerceContext): RequestContext {
  const ctx = new RequestContext();
  ctx.set('actor', value.actor);
  ctx.set('channel', value.channel);
  if (value.correlationId) ctx.set('correlationId', value.correlationId);
  return ctx;
}

type ToolContextLike = {
  requestContext?: { get(key: string): unknown };
  agent?: { toolCallId?: string; threadId?: string };
  workflow?: { runId?: string };
};

export const COMMERCE_AGENT_ID = 'commerce-agent';

/** Converte o contexto de execução da tool no ActionContext do domínio. Falha fechado. */
export function actionContextFrom(context: ToolContextLike | undefined): ActionContext {
  const actor = ActorSchema.safeParse(context?.requestContext?.get('actor'));
  if (!actor.success) throw new Error('Tool executada sem ator autenticado no requestContext');
  const channel = (context?.requestContext?.get('channel') as Channel | undefined) ?? 'agent';
  const toolCallId = context?.agent?.toolCallId;

  return {
    actor: actor.data,
    channel,
    agentId: context?.agent ? COMMERCE_AGENT_ID : undefined,
    threadId: context?.agent?.threadId,
    runId: context?.workflow?.runId,
    toolCallId,
    correlationId: context?.requestContext?.get('correlationId') as string | undefined,
  };
}
