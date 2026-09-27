'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Markdown } from './markdown';
import { ToolPart, type ToolPartView } from './tool-part';
import { WorkflowRunCard } from './workflow-run-card';

const THREAD_KEY = 'commerce-agent-thread';

const SUGGESTIONS = [
  'Quais são os 5 clientes que mais gastaram este mês?',
  'Mostre os pedidos do João.',
  'Quais pedidos estão atrasados?',
  'Cancele o pedido #1001, o cliente desistiu.',
  'Reembolse o pagamento do pedido #1002 por atraso na entrega.',
  'Encontre pedidos atrasados e prepare uma notificação para os clientes.',
];

/** Id da conversa atual, persistido no navegador (store externo lido via useSyncExternalStore). */
const threadStore = {
  subscribe(onChange: () => void) {
    window.addEventListener('thread-changed', onChange);
    return () => window.removeEventListener('thread-changed', onChange);
  },
  get(): string {
    let id = localStorage.getItem(THREAD_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(THREAD_KEY, id);
    }
    return id;
  },
  reset() {
    localStorage.setItem(THREAD_KEY, crypto.randomUUID());
    window.dispatchEvent(new Event('thread-changed'));
  },
};

/** Uma conversa = um thread de memória do Mastra. O dono é o operador da sessão (validado no servidor). */
export function Chat() {
  const threadId = useSyncExternalStore(threadStore.subscribe, threadStore.get, () => null);

  useEffect(() => {
    // Conversas pertencem ao operador: trocar de operador inicia outra conversa.
    window.addEventListener('operator-changed', threadStore.reset);
    return () => window.removeEventListener('operator-changed', threadStore.reset);
  }, []);

  if (!threadId) return null;
  return <ChatThread key={threadId} threadId={threadId} onNewThread={threadStore.reset} />;
}

function ChatThread({ threadId, onNewThread }: { threadId: string; onNewThread: () => void }) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        // Com memória, o servidor é a fonte da verdade: enviamos só a última mensagem.
        prepareSendMessagesRequest: ({ id, messages, trigger }) => ({
          body: { id, messages: messages.slice(-1), trigger },
        }),
      }),
  );

  const { messages, setMessages, sendMessage, status, error, addToolApprovalResponse, stop } = useChat({
    id: threadId,
    transport,
    // Após Aprovar/Rejeitar, reenvia automaticamente para o servidor retomar o run suspenso.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  useEffect(() => {
    fetch(`/api/chat?threadId=${threadId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((history: UIMessage[]) => {
        if (history.length) setMessages(history);
      })
      .catch(() => undefined);
  }, [threadId, setMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  const busy = status === 'submitted' || status === 'streaming';

  function submit(text: string) {
    if (!text.trim() || busy) return;
    sendMessage({ text });
    setInput('');
  }

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-4">
      <div className="flex items-center justify-between py-3 text-xs text-zinc-500">
        <span>
          conversa <span className="font-mono">{threadId.slice(0, 8)}</span>
        </span>
        <button onClick={onNewThread} className="rounded border border-zinc-300 bg-white px-2 py-1 hover:bg-zinc-50">
          Nova conversa
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4">
        {messages.length === 0 && (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-4">
            <p className="mb-3 text-sm text-zinc-600">
              O agente consulta o banco em modo somente leitura e age apenas por Domain Actions. Experimente:
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  className="rounded-full border border-zinc-300 bg-zinc-50 px-3 py-1 text-left text-sm hover:bg-zinc-100"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <MessageView key={message.id} message={message} onApprovalResponse={addToolApprovalResponse} />
        ))}

        {status === 'submitted' && <p className="animate-pulse text-sm text-zinc-500">Agente pensando…</p>}
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            Erro: {error.message || 'falha na comunicação com o agente'}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="flex gap-2 border-t border-zinc-200 py-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Pergunte ou peça uma ação…"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500"
        />
        {busy ? (
          <button type="button" onClick={stop} className="rounded-md border border-zinc-300 bg-white px-4 text-sm">
            Parar
          </button>
        ) : (
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Enviar
          </button>
        )}
      </form>
    </div>
  );
}

function MessageView({
  message,
  onApprovalResponse,
}: {
  message: UIMessage;
  onApprovalResponse: (r: { id: string; approved: boolean; reason?: string }) => void;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : 'space-y-2'}>
      {message.parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        if (part.type === 'text') {
          if (!part.text.trim()) return null;
          return isUser ? (
            <div key={key} className="max-w-[80%] rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white">
              {part.text}
            </div>
          ) : (
            <div key={key} className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm ring-1 ring-zinc-200">
              <Markdown>{part.text}</Markdown>
            </div>
          );
        }
        if (part.type.startsWith('tool-')) {
          return (
            <ToolPart
              key={key}
              part={part as unknown as ToolPartView}
              onApprovalResponse={onApprovalResponse}
              renderOutput={(toolName, output) =>
                toolName === 'startLateOrderNotifications' ? <WorkflowRunCard output={output} /> : undefined
              }
            />
          );
        }
        return null;
      })}
    </div>
  );
}
