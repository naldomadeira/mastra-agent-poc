import { Memory } from '@mastra/memory';

/**
 * Memória nativa do Mastra: histórico por thread (conversa), com resource = operador.
 * Sem memória customizada: o storage vem da instância Mastra.
 */
export function createCommerceMemory(): Memory {
  return new Memory({
    options: {
      lastMessages: 20,
      generateTitle: false,
    },
  });
}
