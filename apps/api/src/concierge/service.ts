import type { ChatMessage, DomainEvent, Notification, ReplacementOffer, User } from '@odas/contracts';
import { CANCELLATION_POLICY, TIMEZONE } from '@odas/contracts';
import { audit, enqueue, fail, parseJSON, uid, userById, type Runtime } from '../core';
import { answerWithModel, answerWithRules, conciergeMode, type ConciergeReply } from './model';
import { modelStatus } from '../ai';
import { createConciergeTools, type ToolName } from './tools';
import { recordConciergeConversation } from '../operations/conversation';

export interface Conversation { id: string; userId: string; bookingId: string | null; title: string; createdAt: number; updatedAt: number }
const conversationDto = (r: any): Conversation => ({ id: r.id, userId: r.user_id, bookingId: r.booking_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at });
export const messageDto = (r: any): ChatMessage & { actions?: ConciergeReply['actions']; sequence?: number } => ({ id: r.id, conversationId: r.conversation_id, role: r.role, content: r.content, createdAt: r.created_at, sequence: r.sequence, ...parseJSON(r.data, {}) });
export const notificationDto = (r: any): Notification => ({ id: r.id, userId: r.user_id, bookingId: r.booking_id ?? undefined, type: r.type, title: r.title, body: r.body, createdAt: r.created_at, readAt: r.read_at ?? undefined, openConcierge: !!r.open_concierge, data: parseJSON(r.data, {}) });
export function createConciergeService(rt: Runtime) {
  function ownConversation(user: User, id: string): Conversation {
    const row = rt.db.query('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, user.id);
    if (!row) fail(404, 'Conversation not found.');
    return conversationDto(row);
  }
  function listConversations(user: User): Conversation[] { return rt.db.query('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 100').all(user.id).map(conversationDto); }
  async function createConversation(user: User, bookingId?: string | null): Promise<Conversation> {
    if (bookingId) await rt.services.commerce.get(user, bookingId);
    return rt.db.transaction(() => {
      const existing = rt.db.query('SELECT * FROM conversations WHERE user_id=? AND booking_id IS ? ORDER BY created_at DESC LIMIT 1').get(user.id, bookingId ?? null);
      if (existing) return conversationDto(existing);
      const now = rt.clock.now(); const id = uid('conversation');
      rt.db.query('INSERT INTO conversations(id,user_id,booking_id,title,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)').run(id, user.id, bookingId ?? null, bookingId ? 'Your reservation' : 'Find an office', now, now, '{}');
      saveMessage(id, 'assistant', bookingId ? `I can help with your reservation, readiness, access instructions, or a replacement. ${CANCELLATION_POLICY}` : 'Tell me where and when you need an office, and your hourly budget. I can search inventory and prepare Checkout.', {}, `welcome:${id}`);
      return ownConversation(user, id);
    })();
  }
  function saveMessage(conversationId: string, role: ChatMessage['role'], content: string, data: Record<string, unknown> = {}, idempotencyKey?: string): ChatMessage {
    const id = uid('message'); const now = rt.clock.now();
    rt.db.query('INSERT OR IGNORE INTO chat_messages(id,conversation_id,role,content,created_at,data,idempotency_key) VALUES(?,?,?,?,?,?,?)').run(id, conversationId, role, content, now, JSON.stringify(data), idempotencyKey ?? null);
    rt.db.query('UPDATE conversations SET updated_at=? WHERE id=?').run(now, conversationId);
    const row = idempotencyKey ? rt.db.query('SELECT rowid AS sequence,* FROM chat_messages WHERE idempotency_key=?').get(idempotencyKey) : rt.db.query('SELECT rowid AS sequence,* FROM chat_messages WHERE id=?').get(id);
    return messageDto(row);
  }
  function messages(user: User, id: string): ChatMessage[] {
    ownConversation(user, id);
    return rt.db.query('SELECT * FROM (SELECT rowid AS sequence,* FROM chat_messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 300) ORDER BY sequence').all(id).map(messageDto);
  }
  function queueMessage(user: User, conversationId: string, content: string, idempotencyKey: string): ChatMessage {
    ownConversation(user, conversationId);
    const existing = rt.db.query('SELECT m.* FROM chat_messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.idempotency_key=? AND c.user_id=?').get(`user:${user.id}:${idempotencyKey}`, user.id);
    if (existing) { if ((existing as any).conversation_id !== conversationId) fail(409, 'This message request ID was already used in another conversation.'); return messageDto(existing); }
    return rt.db.transaction(() => {
      const message = saveMessage(conversationId, 'user', content, {}, `user:${user.id}:${idempotencyKey}`);
      const event: DomainEvent = { version: 1, id: `chat:${message.id}`, type: 'concierge.message_requested', roomId: '', correlationId: message.id, revision: 0, idempotencyKey: message.id, occurredAt: rt.clock.now(), payload: { conversationId, messageId: message.id } };
      enqueue(rt, event, 'concierge');
      return message;
    })();
  }
  function notify(userId: string, input: Omit<Notification, 'id' | 'userId' | 'createdAt'>, idempotencyKey?: string): Notification {
    const id = uid('notification'); const now = rt.clock.now();
    rt.db.query('INSERT OR IGNORE INTO notifications(id,user_id,booking_id,type,title,body,created_at,read_at,open_concierge,idempotency_key,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, userId, input.bookingId ?? null, input.type, input.title, input.body, now, input.readAt ?? null, input.openConcierge ? 1 : 0, idempotencyKey ?? null, JSON.stringify(input.data ?? {}));
    const row = idempotencyKey ? rt.db.query('SELECT * FROM notifications WHERE idempotency_key=? AND user_id=?').get(idempotencyKey, userId) : rt.db.query('SELECT * FROM notifications WHERE id=?').get(id);
    return notificationDto(row);
  }
  function notifications(user: User): Notification[] { return rt.db.query('SELECT * FROM notifications WHERE user_id=? ORDER BY rowid DESC LIMIT 100').all(user.id).map(notificationDto); }
  function markRead(user: User, id: string): Notification {
    const row = rt.db.query('SELECT * FROM notifications WHERE id=? AND user_id=?').get(id, user.id) as any;
    if (!row) fail(404, 'Notification not found.');
    rt.db.query('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?').run(rt.clock.now(), id);
    return notificationDto({ ...row, read_at: row.read_at ?? rt.clock.now() });
  }
  async function processChat(event: DomainEvent) {
    const conversationId = String(event.payload.conversationId ?? ''); const messageId = String(event.payload.messageId ?? '');
    const row = rt.db.query('SELECT m.*,c.user_id,c.booking_id FROM chat_messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.id=? AND m.role=\'user\'').get(messageId, conversationId) as any;
    if (!row) fail(404, 'Queued concierge message not found.');
    const existing = rt.db.query('SELECT rowid AS sequence,* FROM chat_messages WHERE idempotency_key=?').get(`reply:${messageId}`);
    if (existing) return { messageId: (existing as any).id, duplicate: true };
    const user = userById(rt, row.user_id); const message = messageDto(row);
    const history = messages(user, conversationId);
    let reply: ConciergeReply;
    try { reply = conciergeMode() === 'model' ? await answerWithModel(rt, user, message, history, row.booking_id) : await answerWithRules(rt, user, message, history, row.booking_id); }
    catch (error) {
      // Persist a usable failure state. Never fabricate a tool result or payment success.
      reply = { content: error instanceof Error ? `I could not complete this request: ${error.message}` : 'I could not complete this request. Please try again.' };
    }
    const { content, ...data } = reply;
    const saved = saveMessage(conversationId, 'assistant', content, { ...data, ...modelStatus() }, `reply:${messageId}`);
    return { messageId: saved.id, mode: conciergeMode() };
  }
  async function processDisruption(event: DomainEvent) {
    if (!event.roomId) return { ignored: true };
    const room = await rt.rooms.snapshot(event.roomId);
    const candidates = event.bookingId
      ? rt.db.query("SELECT * FROM reservations WHERE id=? AND room_id=? AND status IN ('confirmed','checked_in')").all(event.bookingId, event.roomId)
      : rt.db.query("SELECT * FROM reservations WHERE room_id=? AND status IN ('confirmed','checked_in') AND end_at>? AND start_at<?").all(event.roomId, rt.clock.now(), rt.clock.now() + 24 * 3600_000);
    let count = 0;
    for (const candidate of candidates as any[]) {
      const blocked = room.blocks.some(block => block.startAt < candidate.end_at && block.endAt > candidate.start_at);
      const disrupted = room.expectedReadyAt !== null && room.expectedReadyAt > candidate.start_at || room.operational !== 'available' || blocked || room.readiness !== 'ready' && candidate.start_at <= rt.clock.now();
      if (!disrupted) continue;
      const cycle = `${candidate.id}:${room.job?.id ?? event.correlationId}:${room.operational}:${blocked ? 'blocked' : 'open'}`;
      const existing = rt.db.query('SELECT id FROM notifications WHERE idempotency_key=?').get(`disruption:${cycle}`);
      if (existing) continue;
      const guest = userById(rt, candidate.user_id);
      const offer = await rt.services.commerce.offerReplacement(candidate.id, event);
      const conversation = await createConversation(guest, candidate.id);
      const eta = room.expectedReadyAt ? new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' }).format(room.expectedReadyAt) : null;
      const content = offer
        ? `Your reserved office is delayed${eta ? `, with expected readiness at ${eta} Pacific` : ''}. I found ${offer.office?.name ?? 'another available office'}${offer.office?.workspace ? ` at ${offer.office.workspace.name}` : ''}. ${offer.equivalence} ${offer.differences.length ? `Differences: ${offer.differences.join('; ')}.` : ''} Your time and amount paid stay the same if you accept. Choose Accept replacement to change your assignment, or Keep current office. You can also cancel under the service-disruption policy.`
        : `Your reserved office is delayed${eta ? `, with expected readiness at ${eta} Pacific` : ''}. I could not find an acceptable available replacement. You can keep your delayed booking or cancel under the service-disruption policy.`;
      rt.db.transaction(() => {
        saveMessage(conversation.id, 'assistant', content, { offer: offer ?? undefined, disruption: true, bookingId: candidate.id }, `disruption-message:${cycle}`);
        notify(guest.id, { bookingId: candidate.id, type: 'readiness_disruption', title: 'Your office needs more time', body: content, openConcierge: true, data: { conversationId: conversation.id, offerId: offer?.id, expectedReadyAt: room.expectedReadyAt, source: room.inspection?.source ?? 'unverified' } }, `disruption:${cycle}`);
      })();
      audit(rt, 'concierge-worker', 'disruption.offered', candidate.id, { eventId: event.id, offerId: offer?.id ?? null }); count++;
    }
    // Optional narration must not block Relay acknowledgements or worker heartbeats.
    const conversation = recordConciergeConversation(rt, room);
    if (modelStatus().mode === 'model') void conversation.catch(() => console.warn('[room-conversation] Could not save the room exchange; retry on the next room event.'));
    else await conversation;
    return { notified: count };
  }
  async function processEvent(event: DomainEvent): Promise<unknown> {
    if (event.type === 'concierge.message_requested') return processChat(event);
    if (/^room\.(readiness_delayed|evidence_stale|operational_changed|blocked|inspected)$/.test(event.type) || /^cleaning\.(failed|uncertain|interrupted)$/.test(event.type)) return processDisruption(event);
    return { ignored: true, eventType: event.type };
  }
  async function action(user: User, conversationId: string, name: ToolName, input: unknown, idempotencyKey: string) {
    ownConversation(user, conversationId);
    const key = `action:${user.id}:${idempotencyKey}`;
    const existing = rt.db.query('SELECT result_json FROM processed_messages WHERE worker=? AND event_id=? AND status=\'completed\'').get('concierge-action', key) as any;
    if (existing) return parseJSON(existing.result_json, {});
    const result = await createConciergeTools(rt).execute(name, input, { user, messageId: key, confirmedAction: name }) as any;
    const now = rt.clock.now();
    rt.db.query('INSERT INTO processed_messages(id,worker,event_id,status,result_json,created_at,updated_at) VALUES(?,?,?,\'completed\',?,?,?) ON CONFLICT(worker,event_id) DO UPDATE SET status=excluded.status,result_json=excluded.result_json,updated_at=excluded.updated_at').run(key, 'concierge-action', key, JSON.stringify(result), now, now);
    saveMessage(conversationId, 'assistant', result.url ? 'Your reservation hold is ready. Continue to secure Stripe Checkout. Payment is confirmed only after Stripe verifies it.' : name === 'cancel_reservation' ? 'Your cancellation request has been recorded. Check the reservation for its current refund status.' : name === 'accept_replacement' ? 'Your replacement request has been applied. Open your reservation for the current assignment.' : 'You kept your current office assignment.', { checkoutUrl: result.url, toolResults: [{ tool: name, result }] }, `action-message:${key}`);
    return result;
  }
  return { mode: conciergeMode(), notify, processEvent, ownConversation, createConversation, listConversations, messages, queueMessage, notifications, markRead, action };
}
export type ConciergeFeatureService = ReturnType<typeof createConciergeService>;
