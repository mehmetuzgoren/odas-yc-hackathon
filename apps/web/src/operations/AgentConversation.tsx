import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

type Message = { id: number; source: string; target: string; body: string; at: number; generation?: 'model' | 'rules' | 'model_error'; model?: string | null; verifiedStatus?: string };

export function AgentConversation({ roomId }: { roomId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<{ mode: string; model: string | null } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setMessages([]); setError(''); setStatus(null); following.current = true;
    async function poll() {
      if (!document.hidden) try {
        const data = await api<{ messages: Message[]; mode: string; model: string | null }>(`/operator/rooms/${roomId}/conversation`, { signal: controller.signal });
        if (!controller.signal.aborted) { setMessages(data.messages); setStatus({ mode: data.mode, model: data.model }); setError(''); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Conversation unavailable.'); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [roomId]);
  const latest = messages.at(-1)?.id;
  useEffect(() => { if (following.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [latest]);
  return <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white" aria-label="Agent conversation">
    <div className="border-b border-stone-100 px-5 py-4">
      <h2 className="font-serif text-xl font-semibold">Agent conversation</h2>
      <p className="mt-1 text-xs text-stone-600">{status ? status.mode === 'model' ? `OpenAI · ${status.model}` : 'Development rules mode' : 'Loading conversation…'} · Updates on room changes.</p>
    </div>
    <div ref={list} role="log" aria-label="Room agent messages" aria-live="polite" aria-relevant="additions" onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }} className="h-[460px] overflow-y-auto overscroll-contain p-4">
      {messages.length ? <ol className="space-y-4">{messages.map(item => <li key={item.id} className={`flex ${item.source === 'Room agent' ? 'justify-end' : 'justify-start'}`}>
        <div className={`max-w-[92%] rounded-2xl px-4 py-3 ${item.source === 'Room agent' ? 'rounded-br-sm bg-mist' : 'rounded-bl-sm bg-stone-50'}`}>
          <p className="text-xs font-semibold text-forest">{item.source} <span className="px-1 font-normal text-stone-400" aria-label="to">→</span> {item.target}</p>
          <p className="mt-1.5 text-sm leading-relaxed text-stone-800">{item.body}</p>
          {item.verifiedStatus && <p className="mt-2 border-t border-forest/15 pt-2 text-xs leading-relaxed text-stone-700">Verified status: {item.verifiedStatus}</p>}
          <p className="mt-2 text-xs text-stone-600"><time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time> · {item.generation === 'model' ? `OpenAI · ${item.model}` : item.generation === 'model_error' ? 'Model unavailable · rules fallback' : item.generation === 'rules' ? 'Rules' : 'Verified event'}</p>
        </div>
      </li>)}</ol> : <p className="flex h-full items-center justify-center px-6 text-center text-sm text-stone-500">Waiting for a room state change.</p>}
    </div>
    {error && <p role="status" className="border-t border-stone-100 px-5 py-3 text-sm text-red-700">{error}</p>}
  </section>;
}
