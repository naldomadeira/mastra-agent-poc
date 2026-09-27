import { handleChatStream } from '@mastra/ai-sdk';
import { toAISdkMessages } from '@mastra/ai-sdk/ui';
import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { correlationIdOf } from '@/app/_lib/correlation';
import { errorResponse } from '@/app/_lib/http';
import { getCurrentActor } from '@/app/_lib/session';
import type { Actor } from '@/domain/operators/operator';
import { getDeps } from '@/infrastructure/app-services';
import { mastra } from '@/mastra';
import { extractApprovalDecisions, recordAgentApprovalDecisions } from '@/mastra/approvals';
import { COMMERCE_AGENT_ID, createCommerceContext } from '@/mastra/request-context';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Corpo aceito do cliente — e nada além disso. Em especial NÃO repassamos `requestContext`,
 * `runId` ou `resumeData` vindos do navegador: identidade e aprovação são decididas aqui.
 */
const ChatBody = z.object({
  id: z.uuid(), // thread (conversa)
  messages: z
    .array(z.custom<UIMessage>((m) => typeof m === 'object' && m !== null && 'role' in m))
    .min(1)
    .max(3),
  trigger: z.enum(['submit-message', 'regenerate-message']).optional(),
});

export async function POST(req: Request) {
  try {
    const actor = await getCurrentActor();
    const body = ChatBody.parse(await req.json());
    await assertThreadOwnership(body.id, actor);

    // Decisões de Aprovar/Rejeitar vindas da UI viram evidência persistida, com o operador da
    // sessão como aprovador. O domínio exige e consome essa evidência (ADR 004).
    const correlationId = correlationIdOf(req);
    await recordAgentApprovalDecisions(getDeps(), extractApprovalDecisions(body.messages.at(-1)), {
      actor,
      threadId: body.id,
      correlationId,
    });

    const stream = await handleChatStream({
      mastra,
      agentId: COMMERCE_AGENT_ID,
      version: 'v7',
      params: {
        messages: body.messages,
        trigger: body.trigger,
        memory: { thread: body.id, resource: actor.id },
        requestContext: createCommerceContext({ actor, channel: 'agent', correlationId }),
      },
      onError: (error) => {
        console.error('[chat] erro no stream do agente', error);
        return 'O agente falhou ao processar a solicitação. Veja os logs do servidor.';
      },
    });
    return createUIMessageStreamResponse({ stream, headers: { 'x-request-id': correlationId } });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Histórico da conversa (memória do Mastra) para reidratar a UI após reload. */
export async function GET(req: Request) {
  try {
    const actor = await getCurrentActor();
    const threadId = z.uuid().parse(new URL(req.url).searchParams.get('threadId'));
    const memory = await mastra.getAgentById(COMMERCE_AGENT_ID).getMemory();
    const thread = await memory?.getThreadById({ threadId });
    if (!memory || !thread) return NextResponse.json([]);
    if (thread.resourceId !== actor.id) return NextResponse.json([]);
    const { messages } = await memory.recall({ threadId, resourceId: actor.id });
    return NextResponse.json(toAISdkMessages(messages, { version: 'v7' }));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Uma conversa pertence ao operador que a criou; ninguém retoma a thread de outro. */
async function assertThreadOwnership(threadId: string, actor: Actor): Promise<void> {
  const memory = await mastra.getAgentById(COMMERCE_AGENT_ID).getMemory();
  const thread = await memory?.getThreadById({ threadId });
  if (thread && thread.resourceId !== actor.id) {
    throw new z.ZodError([
      { code: 'custom', path: ['id'], message: 'Conversa pertence a outro operador', input: threadId },
    ]);
  }
}
