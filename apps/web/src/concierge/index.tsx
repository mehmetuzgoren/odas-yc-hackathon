import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Bell, MessageCircle, Send, X } from 'lucide-react';
import { money, TIMEZONE, type ChatMessage, type Notification, type Office, type ReplacementOffer } from '@odas/contracts';
import { api, useSession } from '../api';
import { roomName } from '../marketplace/listing';
import './styles.css';

type Action = { name: string; input: any; label: string };
type Message = ChatMessage & { actions?: Action[]; mode?: string; sequence?: number };
type Conversation = { id: string; bookingId: string | null; title: string; updatedAt: number };
function errorText(error: unknown) { return error instanceof Error ? error.message : 'Please try again.'; }
function time(value: number) { return new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' }).format(value); }

export function ConciergePanel({ bookingId }: { bookingId?: string } = {}) {
  const { user, setSignInOpen } = useSession(); const location = useLocation();
  const dialogRef = useRef<HTMLDialogElement>(null); const triggerRef = useRef<HTMLButtonElement>(null); const headingRef = useRef<HTMLHeadingElement>(null); const transcriptRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string | null>(null); const userRef = useRef(user); const autoSeen = useRef(new Set<string>());
  const [open, setOpen] = useState(false); const [tab, setTab] = useState<'chat' | 'updates'>('chat');
  const [conversations, setConversations] = useState<Conversation[]>([]); const [selected, setSelected] = useState<string | null>(null); const [messages, setMessages] = useState<Message[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]); const [content, setContent] = useState(''); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [mode, setMode] = useState('development_rules'); const [connected, setConnected] = useState(false); const [workersConnected, setWorkersConnected] = useState(true); const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const currentBookingId = bookingId ?? location.pathname.match(/^\/bookings\/([^/]+)$/)?.[1];
  const unread = notifications.filter(v => !v.readAt).length;
  const waiting = messages.length > 0 && messages.at(-1)?.role === 'user';
  const close = useCallback(() => { dialogRef.current?.close(); setOpen(false); triggerRef.current?.focus(); }, []);
  const show = useCallback(() => { setOpen(true); setTab('chat'); if (!dialogRef.current?.open) dialogRef.current?.showModal(); requestAnimationFrame(() => headingRef.current?.focus()); }, []);
  const loadMessages = useCallback(async (id: string) => {
    const data = await api<{ messages: Message[]; mode: string; model: string | null }>(`/conversations/${encodeURIComponent(id)}/messages`);
    if (selectedRef.current === id) { setMessages(data.messages); setMode(data.mode); setModel(data.model); }
  }, []);
  const chooseConversation = useCallback(async (id: string) => {
    selectedRef.current = id; setSelected(id); setLoading(true); setError('');
    try { await loadMessages(id); if (userRef.current) localStorage.setItem(`odas:conversation:${userRef.current.id}`, id); }
    catch (error) { setError(errorText(error)); }
    finally { setLoading(false); }
  }, [loadMessages]);
  const openForBooking = useCallback(async (targetBookingId?: string, conversationId?: string) => {
    show();
    if (!userRef.current) return;
    setLoading(true); setError('');
    try {
      if (conversationId) await chooseConversation(conversationId);
      else {
        const data = await api<{ conversation: Conversation }>('/conversations', { method: 'POST', body: JSON.stringify(targetBookingId ? { bookingId: targetBookingId } : {}) });
        setConversations(current => [data.conversation, ...current.filter(v => v.id !== data.conversation.id)]);
        await chooseConversation(data.conversation.id);
      }
    } catch (error) { setError(errorText(error)); }
    finally { setLoading(false); }
  }, [chooseConversation, show]);
  function rememberNotification(id: string) {
    autoSeen.current.add(id);
    if (userRef.current) localStorage.setItem(`odas:concierge-seen:${userRef.current.id}`, JSON.stringify([...autoSeen.current].slice(-150)));
  }
  const handleNotification = useCallback((notification: Notification, autoOpen = true) => {
    setNotifications(current => [notification, ...current.filter(v => v.id !== notification.id)].sort((a, b) => b.createdAt - a.createdAt));
    if (notification.openConcierge && !notification.readAt && !autoSeen.current.has(notification.id)) {
      rememberNotification(notification.id);
      if (autoOpen) void openForBooking(notification.bookingId, String(notification.data?.conversationId ?? '') || undefined);
    }
  }, [openForBooking]);
  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => {
    selectedRef.current = null; setSelected(null); setMessages([]); setNotifications([]); setConversations([]); setError('');
    if (!user) { dialogRef.current?.close(); setOpen(false); return; }
    let active = true; let source: EventSource | undefined;
    try { autoSeen.current = new Set(JSON.parse(localStorage.getItem(`odas:concierge-seen:${user.id}`) ?? '[]')); } catch { autoSeen.current = new Set(); }
    async function initialize() {
      try {
        const [chat, updates] = await Promise.all([api<{ conversations: Conversation[]; mode: string; model: string | null }>('/conversations'), api<{ notifications: Notification[] }>('/notifications')]);
        if (!active) return;
        setConversations(chat.conversations); setMode(chat.mode); setModel(chat.model); setNotifications(updates.notifications);
        const saved = localStorage.getItem(`odas:conversation:${user!.id}`);
        if (saved && chat.conversations.some(v => v.id === saved)) await chooseConversation(saved);
        const unseen = updates.notifications.filter(v => v.openConcierge && !v.readAt && !autoSeen.current.has(v.id));
        unseen.forEach(v => rememberNotification(v.id));
        if (unseen[0]) void openForBooking(unseen[0].bookingId, String(unseen[0].data?.conversationId ?? '') || undefined);
        if (!active) return;
        source = new EventSource('/api/events', { withCredentials: true });
        source.onopen = () => { if (active) setConnected(true); };
        source.onerror = () => { if (active) setConnected(false); };
        source.addEventListener('notification', event => { if (active) handleNotification(JSON.parse((event as MessageEvent).data)); });
        source.addEventListener('chat', event => {
          const message = JSON.parse((event as MessageEvent).data) as Message;
          if (!active || message.conversationId !== selectedRef.current) return;
          setMessages(current => [...current.filter(v => v.id !== message.id), message].sort((a, b) => a.sequence && b.sequence ? a.sequence - b.sequence : a.createdAt - b.createdAt));
        });
      } catch (error) { if (active) setError(errorText(error)); }
    }
    void initialize();
    const timer = window.setInterval(async () => {
      try {
        const status = await api<{ mode: string; model: string | null; workers: { connected: boolean }[] }>('/concierge/status');
        if (active) { setMode(status.mode); setModel(status.model); setWorkersConnected(status.workers.every(v => v.connected)); }
        if (selectedRef.current) await loadMessages(selectedRef.current);
      } catch { if (active) setWorkersConnected(false); }
    }, 10_000);
    return () => { active = false; source?.close(); window.clearInterval(timer); setConnected(false); };
  }, [user?.id, chooseConversation, openForBooking, handleNotification, loadMessages]);
  useEffect(() => {
    const listener = (event: Event) => { const detail = (event as CustomEvent<{ bookingId?: string }>).detail; void openForBooking(detail?.bookingId); };
    window.addEventListener('odas:open-concierge', listener);
    return () => window.removeEventListener('odas:open-concierge', listener);
  }, [openForBooking]);
  useEffect(() => { if (open && transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight; }, [messages, open]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!content.trim() || busy || !user) return;
    setBusy(true); setError(''); const text = content.trim();
    try {
      let id = selectedRef.current;
      if (!id) {
        const result = await api<{ conversation: Conversation }>('/conversations', { method: 'POST', body: JSON.stringify(currentBookingId ? { bookingId: currentBookingId } : {}) });
        id = result.conversation.id; await chooseConversation(id);
      }
      const result = await api<{ message: Message }>(`/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ content: text, idempotencyKey: crypto.randomUUID() }) });
      setMessages(current => [...current.filter(v => v.id !== result.message.id), result.message]); setContent('');
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  async function runAction(messageId: string, action: Action) {
    if (!selectedRef.current || actionBusy) return;
    setActionBusy(`${messageId}:${action.name}`); setError('');
    try {
      const result = await api<any>(`/conversations/${selectedRef.current}/actions`, { method: 'POST', body: JSON.stringify({ ...action, confirmed: true, idempotencyKey: `${messageId}:${action.name}:${action.input?.quoteId ?? action.input?.offerId ?? action.input?.bookingId ?? ''}` }) });
      await loadMessages(selectedRef.current);
      window.dispatchEvent(new Event('odas:reservation-updated'));
      if (result.url) window.location.assign(result.url);
    } catch (error) { setError(errorText(error)); }
    finally { setActionBusy(null); }
  }
  async function offerAction(message: Message, offer: ReplacementOffer, accept: boolean) {
    await runAction(message.id, { name: accept ? 'accept_replacement' : 'decline_replacement', input: { offerId: offer.id }, label: accept ? 'Accept replacement' : 'Keep current office' });
  }
  async function markRead(notification: Notification) {
    try { const result = await api<{ notification: Notification }>(`/notifications/${notification.id}/read`, { method: 'POST' }); handleNotification(result.notification, false); }
    catch (error) { setError(errorText(error)); }
  }
  return <>
    <button ref={triggerRef} type="button" className="concierge-launcher" title="Concierge" onClick={() => void openForBooking(currentBookingId)} aria-haspopup="dialog" aria-label={`Open Odas concierge${unread ? `, ${unread} unread updates` : ''}`}>
      <MessageCircle size={18} aria-hidden="true" />{unread > 0 && <span className="concierge-count">{unread}</span>}
    </button>
    <dialog ref={dialogRef} className="concierge-dialog" aria-labelledby="concierge-title" onCancel={() => { setOpen(false); triggerRef.current?.focus(); }} onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="concierge-shell">
        <header className="concierge-header"><div><p className="eyebrow">Odas · here to help</p><h2 ref={headingRef} tabIndex={-1} id="concierge-title">Your concierge</h2></div><button className="concierge-icon" aria-label="Close concierge" onClick={close}><X size={22} /></button></header>
        <div className="concierge-tabs" role="tablist" aria-label="Concierge sections" onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'updates' : tab === 'chat' ? 'updates' : 'chat'; setTab(next); (event.currentTarget.querySelector(`#concierge-${next}-tab`) as HTMLButtonElement | null)?.focus(); }}><button role="tab" tabIndex={tab === 'chat' ? 0 : -1} aria-selected={tab === 'chat'} aria-controls="concierge-chat" id="concierge-chat-tab" onClick={() => setTab('chat')}><MessageCircle size={16} />Conversation</button><button role="tab" tabIndex={tab === 'updates' ? 0 : -1} aria-selected={tab === 'updates'} aria-controls="concierge-updates" id="concierge-updates-tab" onClick={() => setTab('updates')}><Bell size={16} />Updates {unread ? `(${unread})` : ''}</button></div>
        {!user ? <div className="concierge-signin"><h3>Keep the conversation going.</h3><p>Sign in to save your messages and receive reservation updates.</p><button className="button" onClick={() => { close(); setSignInOpen(true); }}>Sign in</button></div> : <>
          <p className="concierge-status" aria-live="polite">{mode === 'development_rules' ? 'Development rules mode' : `OpenAI · ${model}`}<span>{connected ? 'Updates connected' : 'Reconnecting updates…'}</span></p>
          {!workersConnected && <p className="concierge-pipeline" role="status">The concierge worker is reconnecting. Your messages are saved and will resume when it returns.</p>}
          {error && <p className="error concierge-error" role="alert">{error}</p>}
          {tab === 'chat' ? <section id="concierge-chat" role="tabpanel" aria-labelledby="concierge-chat-tab" className="concierge-chat-panel">
            {conversations.length > 1 && <label className="concierge-conversation-picker">Conversation<select value={selected ?? ''} onChange={event => void chooseConversation(event.target.value)}><option value="" disabled>Choose conversation</option>{conversations.map(v => <option key={v.id} value={v.id}>{v.title}{v.bookingId ? ` · ${v.bookingId.slice(-8)}` : ''}</option>)}</select></label>}
            <div ref={transcriptRef} className="concierge-transcript" role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions">
              {loading && <p className="muted" role="status">Loading your conversation…</p>}
              {!loading && messages.length === 0 && <p className="concierge-empty">Tell me where and when you need an office, and your hourly budget.</p>}
              {messages.map(message => <article key={message.id} className={`concierge-message concierge-message-${message.role}`}><span className="concierge-message-label">{message.role === 'user' ? 'You' : 'Odas concierge'} · {time(message.createdAt)}</span><p>{message.content}</p>
                {message.cards?.map(office => <OfficeCard key={office.id} office={office} message={message} onNavigate={close} />)}
                {message.offer && <div className="concierge-offer"><span className="badge">Replacement offer</span><h4>{message.offer.office?.name ?? 'Available office'}</h4><p>{message.offer.equivalence}</p>{message.offer.differences.length > 0 && <p>Differences: {message.offer.differences.join('; ')}</p>}<p className="muted">Offer expires at {time(message.offer.expiresAt)} Pacific. Time and amount paid stay the same.</p><div className="concierge-actions"><button className="button" disabled={!!actionBusy || message.offer.status !== 'offered'} onClick={() => void offerAction(message, message.offer!, true)}>Accept replacement</button><button className="button secondary" disabled={!!actionBusy || message.offer.status !== 'offered'} onClick={() => void offerAction(message, message.offer!, false)}>Keep current office</button></div></div>}
                {message.actions?.map((action, index) => <div className="concierge-tool-action" key={`${action.name}:${index}`}><QuoteSummary message={message} action={action} /><button className={`button ${action.name === 'cancel_reservation' ? 'danger' : ''}`} disabled={!!actionBusy} onClick={() => void runAction(message.id, action)}>{actionBusy === `${message.id}:${action.name}` ? 'Working…' : action.label}</button></div>)}
                {message.checkoutUrl && <a className="button" href={message.checkoutUrl}>Continue to secure Checkout</a>}
              </article>)}
              {waiting && <p className="concierge-waiting" role="status">Your message is saved. The concierge is working on it…</p>}
            </div>
            <form className="concierge-compose" onSubmit={submit}><label className="sr-only" htmlFor="concierge-message">Message the concierge</label><textarea id="concierge-message" rows={2} maxLength={4000} value={content} onChange={event => setContent(event.target.value)} placeholder="Ask about offices or your reservation…" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button type="submit" className="button concierge-send" disabled={busy || !content.trim()} aria-label={busy ? 'Saving message' : 'Send message'}><Send size={18} /></button></form>
          </section> : <section id="concierge-updates" role="tabpanel" aria-labelledby="concierge-updates-tab" className="concierge-updates">{notifications.length === 0 ? <p className="muted">Reservation updates will appear here.</p> : notifications.map(notification => <article key={notification.id} className={notification.readAt ? 'concierge-update' : 'concierge-update unread'}><p className="concierge-message-label">{new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(notification.createdAt)}</p><h3>{notification.title}</h3><p>{notification.body}</p><div className="concierge-actions">{notification.bookingId && <Link to={`/bookings/${notification.bookingId}`} onClick={close}>View reservation</Link>}{notification.openConcierge && <button onClick={() => void openForBooking(notification.bookingId, String(notification.data?.conversationId ?? '') || undefined)}>Open conversation</button>}{!notification.readAt && <button onClick={() => void markRead(notification)}>Mark read</button>}</div></article>)}</section>}
        </>}
      </div>
    </dialog>
  </>;
}
function OfficeCard({ office, message, onNavigate }: { office: Office; message: Message; onNavigate(): void }) {
  const search = (message.toolResults as any[])?.find(v => v.tool === 'search_offices');
  const input = search?.input ?? search?.result ?? {};
  const params = new URLSearchParams(); if (input.startAt) params.set('startAt', String(input.startAt)); if (input.endAt) params.set('endAt', String(input.endAt));
  return <Link className="concierge-office-card" to={`/rooms/${office.id}?${params}`} onClick={onNavigate}><div><strong>{roomName(office.name)}</strong><span>{office.workspace?.name ?? office.groupId}</span><small>Modeled inventory</small></div><strong>{money(office.rateCents)}<small>/hour</small></strong></Link>;
}
function QuoteSummary({ message, action }: { message: Message; action: Action }) {
  const result = (message.toolResults as any[])?.find(v => v.tool === action.name && v.result?.quote)?.result;
  if (!result?.quote) return null;
  const quote = result.quote;
  return <div className="concierge-quote"><p>Office {money(quote.subtotalCents)} · 10% service fee {money(quote.feeCents)}</p><p><strong>Total {money(quote.totalCents)}</strong></p><p>{quote.cancellationPolicy}</p><p className="muted">Quote expires at {time(quote.expiresAt)} Pacific.</p></div>;
}
