import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import type { createCommerceAgent } from '../../src/mastra/agents/commerce-agent';

type AgentModel = NonNullable<NonNullable<Parameters<typeof createCommerceAgent>[0]>['model']>;

type StreamResult = Awaited<ReturnType<MockLanguageModelV3['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

/** Um turno do modelo: chamar uma tool ou responder com texto. */
export type Turn = { tool: string; input: unknown } | { text: string };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/**
 * Modelo determinístico: a cada chamada devolve o próximo turno do roteiro.
 * Permite testar o fluxo do agente (tools, memória, aprovação) sem LLM real.
 */
export function scriptedModel(turns: Turn[]) {
  let index = 0;
  const prompts: unknown[] = [];

  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(options.prompt);
      const turn = turns[index++] ?? { text: 'Fim do roteiro.' };
      const parts: StreamPart[] =
        'tool' in turn
          ? [
              { type: 'stream-start' as const, warnings: [] },
              {
                type: 'tool-call' as const,
                toolCallId: `call-${index}`,
                toolName: turn.tool,
                input: JSON.stringify(turn.input),
              },
              { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
            ]
          : [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: `t-${index}` },
              { type: 'text-delta' as const, id: `t-${index}`, delta: turn.text },
              { type: 'text-end' as const, id: `t-${index}` },
              { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
            ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });

  return {
    // O tipo interno de modelo V3 do Mastra diverge do mock do AI SDK apenas na tipagem de
    // doGenerate (não usado: o agente chama doStream). Em runtime o mock é aceito.
    model: model as unknown as AgentModel,
    prompts,
  };
}
