import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { eventSchema, type DomainEvent } from '@odas/contracts';
import { audit, currentUser, fail, parseJSON, requireUser, type Runtime } from '../core';
import { roleSchema } from '../../../../packages/concierge/src/protocol';
import { modelStatus } from '../ai';
import { messageDto, notificationDto, type ConciergeFeatureService } from './service';

const mutationSchema = z.object({ content: z.string().trim().min(1).max(4000), idempotencyKey: z.string().min(8).max(160) });
function internalAuth(actual: string | undefined, expected: string) {
  if (expected.length < 32) fail(503, 'Private worker authentication is not configured.');
  const value = actual?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(value); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) fail(401, 'Private worker authorization is required.');
}
export function createConciergeRoutes(rt: Runtime) {
  const app = new Hono();
  const svc = () => rt.services.concierge as unknown as ConciergeFeatureService;
  app.get('/concierge/status', async c => {
    await requireUser(c, rt);
    const workers = await Promise.all(['operations', 'concierge'].map(async worker => {
      const row = await rt.db.query('SELECT value FROM settings WHERE key=?').get(`relay_health:${worker}`) as any;
      const data = parseJSON<Record<string, unknown>>(row?.value, {});
      return { worker, connected: typeof data.at === 'number' && Date.now() - data.at < 15_000 && data.status === 'connected', lastSeenAt: data.at ?? null };
    }));
    return c.json({ ...modelStatus(), workers });
  });
  app.get('/conversations', async c => c.json({ conversations: await svc().listConversations(await requireUser(c, rt)), ...modelStatus() }));
  app.post('/conversations', async c => {
    const user = await requireUser(c, rt);
    const body = z.object({ bookingId: z.string().min(1).optional() }).parse(await c.req.json());
    return c.json({ conversation: await svc().createConversation(user, body.bookingId) }, 201);
  });
  app.get('/conversations/:id/messages', async c => c.json({ messages: await svc().messages(await requireUser(c, rt), c.req.param('id')), ...modelStatus() }));
  app.post('/conversations/:id/messages', async c => {
    const user = await requireUser(c, rt); const body = mutationSchema.parse(await c.req.json());
    return c.json({ message: await svc().queueMessage(user, c.req.param('id'), body.content, body.idempotencyKey), status: 'queued' }, 202);
  });
  app.post('/conversations/:id/actions', async c => {
    const user = await requireUser(c, rt);
    const body = z.object({ name: z.enum(['start_checkout', 'accept_replacement', 'decline_replacement', 'cancel_reservation']), input: z.unknown(), idempotencyKey: z.string().min(8).max(160), confirmed: z.literal(true) }).parse(await c.req.json());
    return c.json(await svc().action(user, c.req.param('id'), body.name, body.input, body.idempotencyKey));
  });
  app.get('/notifications', async c => c.json({ notifications: await svc().notifications(await requireUser(c, rt)) }));
  app.post('/notifications/:id/read', async c => c.json({ notification: await svc().markRead(await requireUser(c, rt), c.req.param('id')) }));
  app.get('/events', async c => {
    const user = await requireUser(c, rt);
    const incoming = c.req.header('Last-Event-ID') ?? c.req.query('since') ?? '0:0';
    const match = incoming.match(/^(\d{1,16}):(\d{1,16})$/);
    let notificationCursor = match ? Number(match[1]) : 0;
    let messageCursor = match ? Number(match[2]) : 0;
    c.header('Cache-Control', 'no-cache, no-transform'); c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async stream => {
      let active = true; stream.onAbort(() => { active = false; });
      let lastHeartbeat = 0;
      while (active) {
        const activeUser = await currentUser(c, rt);
        if (!activeUser || activeUser.id !== user.id) break;
        const notifications = await rt.db.query('SELECT rowid AS sequence,* FROM notifications WHERE user_id=? AND rowid>? ORDER BY rowid LIMIT 100').all(user.id, notificationCursor) as any[];
        for (const row of notifications) { notificationCursor = row.sequence; await stream.writeSSE({ event: 'notification', id: `${notificationCursor}:${messageCursor}`, data: JSON.stringify(notificationDto(row)), retry: 3000 }); }
        const messages = await rt.db.query('SELECT m.rowid AS sequence,m.* FROM chat_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? AND m.rowid>? ORDER BY m.rowid LIMIT 100').all(user.id, messageCursor) as any[];
        for (const row of messages) { messageCursor = row.sequence; await stream.writeSSE({ event: 'chat', id: `${notificationCursor}:${messageCursor}`, data: JSON.stringify(messageDto(row)), retry: 3000 }); }
        if (Date.now() - lastHeartbeat >= 15_000) { await stream.writeSSE({ event: 'heartbeat', id: `${notificationCursor}:${messageCursor}`, data: JSON.stringify({ connected: true }), retry: 3000 }); lastHeartbeat = Date.now(); }
        await stream.sleep(1000);
      }
    });
  });
  app.use('/internal/relay/*', async (c, next) => { internalAuth(c.req.header('Authorization'), rt.config.internalToken); await next(); });
  app.get('/internal/relay/outbox', async c => {
    const publisher = roleSchema.parse(c.req.query('publisher'));
    const target = publisher === 'operations' ? 'concierge' : 'operations';
    // Retry uses wall time: test business clocks never alter worker lease/deadline scheduling.
    const rows = await rt.db.query("SELECT * FROM outbox WHERE target=? AND status IN ('pending','sent') AND (attempts=0 OR next_attempt_at<=?) ORDER BY created_at LIMIT 40").all(target, Date.now()) as any[];
    return c.json({ events: rows.map(row => ({ id: row.id, target: row.target, event: parseJSON(row.event_json, {}), attempts: row.attempts })) });
  });
  app.post('/internal/relay/published', async c => {
    const body = z.object({ id: z.string(), publisher: roleSchema, relayMessageId: z.string() }).parse(await c.req.json());
    const target = body.publisher === 'operations' ? 'concierge' : 'operations';
    await rt.db.query("UPDATE outbox SET status='sent',attempts=attempts+1,next_attempt_at=?,relay_message_id=?,last_error=NULL WHERE id=? AND target=? AND status!='completed'").run(Date.now() + 15_000, body.relayMessageId, body.id, target);
    return c.json({ ok: true });
  });
  app.post('/internal/relay/process', async c => {
    const body = z.object({ worker: roleSchema, event: eventSchema, outboxId: z.string(), relayMessageId: z.string() }).parse(await c.req.json());
    const outbox = await rt.db.query('SELECT * FROM outbox WHERE id=? AND target=?').get(body.outboxId, body.worker) as any;
    if (!outbox) fail(404, 'Application outbox event not found.');
    const event = eventSchema.parse(JSON.parse(outbox.event_json)) as DomainEvent;
    await rt.db.query('UPDATE outbox SET relay_message_id=COALESCE(relay_message_id,?) WHERE id=?').run(body.relayMessageId, body.outboxId);
    if (event.id !== body.event.id || event.type !== body.event.type) fail(409, 'Relay event does not match the persisted event.');
    const key = `${body.worker}:${event.id}`; const now = Date.now();
    const claim = await rt.db.transaction(async () => {
      const existing = await rt.db.query('SELECT * FROM processed_messages WHERE worker=? AND event_id=?').get(body.worker, event.id) as any;
      if (existing?.status === 'completed') return { duplicate: true, result: parseJSON(existing.result_json, {}) };
      if (existing?.status === 'processing' && existing.updated_at > now - 300_000) fail(409, 'This event is already being processed.');
      await rt.db.query("INSERT INTO processed_messages(id,worker,event_id,status,created_at,updated_at) VALUES(?,?,?,'processing',?,?) ON CONFLICT(worker,event_id) DO UPDATE SET status='processing',error=NULL,updated_at=excluded.updated_at").run(key, body.worker, event.id, now, now);
      return { duplicate: false };
    }, `relay:${body.worker}:${event.id}`)();
    if (claim.duplicate) return c.json({ status: 'completed', result: claim.result, duplicate: true });
    try {
      const result = body.worker === 'operations' ? await rt.services.operations.processEvent(event) : await svc().processEvent(event);
      await rt.db.query("UPDATE processed_messages SET status='completed',result_json=?,error=NULL,updated_at=? WHERE worker=? AND event_id=?").run(JSON.stringify(result ?? {}), Date.now(), body.worker, event.id);
      await audit(rt, `${body.worker}-worker`, 'relay.business_completed', event.id, { outboxId: body.outboxId, relayMessageId: body.relayMessageId });
      return c.json({ status: 'completed', result: result ?? {} });
    } catch (error) {
      await rt.db.query("UPDATE processed_messages SET status='failed',error=?,updated_at=? WHERE worker=? AND event_id=?").run(error instanceof Error ? error.message : 'Domain action failed', Date.now(), body.worker, event.id);
      throw error;
    }
  });
  app.post('/internal/relay/complete', async c => {
    const body = z.object({ version: z.literal(1), kind: z.literal('business_result'), outboxId: z.string(), worker: roleSchema, eventId: z.string(), status: z.enum(['completed', 'failed']), result: z.unknown().optional(), error: z.string().optional() }).parse(await c.req.json());
    const outbox = await rt.db.query('SELECT * FROM outbox WHERE id=? AND target=?').get(body.outboxId, body.worker) as any;
    if (!outbox || JSON.parse(outbox.event_json).id !== body.eventId) fail(409, 'Business result does not match an application event.');
    if (outbox.status === 'completed') return c.json({ ok: true, duplicate: true });
    if (body.status === 'completed') {
      const processed = await rt.db.query("SELECT * FROM processed_messages WHERE worker=? AND event_id=? AND status='completed'").get(body.worker, body.eventId) as any;
      if (!processed) fail(409, 'The domain action has not completed.');
      await rt.db.query("UPDATE outbox SET status='completed',completed_at=?,delivered_at=?,result_json=?,last_error=NULL,error=NULL WHERE id=?").run(Date.now(), Date.now(), processed.result_json, body.outboxId);
    } else await rt.db.query("UPDATE outbox SET status='pending',next_attempt_at=?,last_error=?,error=? WHERE id=? AND status!='completed'").run(Date.now() + 5000, body.error ?? 'Worker failed', body.error ?? 'Worker failed', body.outboxId);
    return c.json({ ok: true });
  });
  app.post('/internal/relay/heartbeat', async c => {
    const body = z.object({ worker: roleSchema, agentId: z.string(), status: z.literal('connected'), lastError: z.string().nullable().optional() }).parse(await c.req.json());
    await rt.db.query('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`relay_health:${body.worker}`, JSON.stringify({ ...body, at: Date.now() }));
    return c.json({ ok: true });
  });
  return app;
}
export { createConciergeService } from './service';
