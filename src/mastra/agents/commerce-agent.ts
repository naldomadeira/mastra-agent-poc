import { Agent } from '@mastra/core/agent';
import type { MastraMemory } from '@mastra/core/memory';
import type { RequestContext } from '@mastra/core/request-context';
import { getEnv } from '../../config/env';
import type { Actor } from '../../domain/operators/operator';
import { createCommerceMemory } from '../memory/commerce-memory';
import { COMMERCE_AGENT_ID } from '../request-context';
import { actionTools, readTools, workflowTools } from '../tools';

type AgentModel = ConstructorParameters<typeof Agent>[0]['model'];

/**
 * Instruções curtas e comportamentais. Regras de negócio e permissões NÃO estão aqui:
 * vivem no domínio e são verificadas pela aplicação a cada chamada.
 */
export function commerceInstructions(requestContext: Pick<RequestContext, 'get'>, timezone: string, now = new Date()) {
  const actor = requestContext.get('actor') as Actor | undefined;
  const localNow = now.toLocaleString('pt-BR', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' });
  return `Você é o assistente operacional de uma loja online. Atende operadores internos, não clientes.

Contexto:
- Operador: ${actor ? `${actor.name} (papel: ${actor.role})` : 'desconhecido'}
- Agora: ${localNow} (${timezone}). Moeda: BRL.

Como trabalhar:
- Perguntas sobre dados: use inspectSchema para conhecer tabelas/views (uma vez por conversa costuma bastar) e depois queryDatabase com um SELECT. Prefira as views, que já trazem as definições de negócio. Nunca invente números: todo dado citado vem de uma consulta.
- Para mudar algo, chame diretamente a tool de ação correspondente. Você não escreve no banco por SQL.
- Não peça confirmação em texto antes de uma ação: a interface coleta a aprovação humana quando necessária.
- Só afirme que uma ação foi executada se a tool de ação retornou ok: true nesta conversa. Consultas não executam ações.
- A aplicação decide se uma ação é permitida. Se uma ação for recusada, explique o motivo retornado e não tente contornar.
- Processos em lote e repetíveis devem usar o workflow correspondente, não uma sequência improvisada de ações.
- Responda em português, de forma objetiva. Valores em R$; pedidos como #1234.`;
}

export function createCommerceAgent(options: { model?: AgentModel; memory?: MastraMemory } = {}): Agent {
  return new Agent({
    id: COMMERCE_AGENT_ID,
    name: 'Commerce Agent',
    description:
      'Assistente operacional da loja: responde perguntas sobre pedidos, clientes, produtos e pagamentos (leitura controlada) e executa ações de domínio permitidas.',
    instructions: ({ requestContext }) => commerceInstructions(requestContext, getEnv().APP_TIMEZONE),
    model: options.model ?? getEnv().MASTRA_MODEL,
    tools: { ...readTools, ...actionTools, ...workflowTools },
    memory: options.memory ?? createCommerceMemory(),
    defaultOptions: { maxSteps: 12 },
  });
}
