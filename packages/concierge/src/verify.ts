/** Focused integration proof: normal signup -> saved chat -> actual cross-process Relay -> domain tool -> saved reply, privacy, reconnect SSE. */
import { Database } from 'bun:sqlite';
import { Temporal } from '@js-temporal/polyfill';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${process.env.WEB_PORT ?? 5173}`;
const apiOrigin = process.env.API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
class Guest {
  cookies = new Map<string, string>(); csrf = '';
  async request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(`${apiOrigin}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, Cookie: [...this.cookies].map(([k,v]) => `${k}=${v}`).join('; '), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const raw of response.headers.getSetCookie()) { const [name, ...value] = raw.split(';')[0]!.split('='); this.cookies.set(name!, value.join('=')); }
    const data = await response.json() as any;
    if (data.csrfToken) this.csrf = data.csrfToken;
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
    return data;
  }
  async signup(suffix: string) {
    await this.request('/auth/session');
    const data = await this.request('/auth/signup', { email: `relay-${suffix}-${crypto.randomUUID()}@example.test`, name: `Relay verification ${suffix}`, password: `ODAS-${crypto.randomUUID()}!` }, 201);
    return data.user;
  }
}
const first = new Guest(); const second = new Guest();
const user = await first.signup('guest'); await second.signup('other');
const { conversation } = await first.request('/conversations', {}, 201);
const date = Temporal.Now.zonedDateTimeISO('America/Los_Angeles').toPlainDate().add({ days: 2 }).toString();
const request = { content: `San Francisco on ${date} from 10:00 to 12:00 under $8/hour`, idempotencyKey: crypto.randomUUID() };
const { message } = await first.request(`/conversations/${conversation.id}/messages`, request, 202);
const duplicate = await first.request(`/conversations/${conversation.id}/messages`, request, 202);
assert.equal(duplicate.message.id, message.id, 'Repeated guest request created another message');
let reply: any; const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const data = await first.request(`/conversations/${conversation.id}/messages`);
  reply = data.messages.find((v: any) => v.role === 'assistant' && v.toolResults?.some((t: any) => t.tool === 'search_offices'));
  if (reply) break;
  await new Promise(resolve => setTimeout(resolve, 750));
}
assert(reply, 'Concierge did not return an actual search tool reply through Relay within 60 seconds');
assert(reply.cards?.length, 'Search reply did not contain available office cards');
await second.request(`/conversations/${conversation.id}/messages`, undefined, 404);
const db = new Database(join(resolve(process.env.DATA_DIR ?? '.data'), 'odas.sqlite'), { readonly: true });
let proof: any;
for (let attempt = 0; attempt < 20; attempt++) {
  proof = db.query("SELECT * FROM outbox WHERE id=? AND status='completed'").get(`chat:${message.id}:concierge`);
  if (proof) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert(proof?.relay_message_id, 'Completed business action lacks an actual Relay message ID');
const processed = db.query("SELECT * FROM processed_messages WHERE worker='concierge' AND event_id=? AND status='completed'").get(`chat:${message.id}`);
assert(processed, 'Durable processed-message result is missing');
assert.equal((db.query('SELECT COUNT(*) AS count FROM chat_messages WHERE idempotency_key=?').get(`reply:${message.id}`) as any).count, 1, 'Duplicate event created another reply');
const response = await fetch(`${apiOrigin}/api/events`, { headers: { Cookie: [...first.cookies].map(([k,v]) => `${k}=${v}`).join('; '), 'Last-Event-ID': '0:0' }, signal: AbortSignal.timeout(10_000) });
assert.equal(response.status, 200); const reader = response.body!.getReader(); let chunk = '';
while (!chunk.includes('event: chat')) { const value = await reader.read(); if (value.done) break; chunk += new TextDecoder().decode(value.value); }
assert(chunk.includes(conversation.id), 'Reconnect SSE did not replay the owned conversation');
await reader.cancel();
console.log(JSON.stringify({ ok: true, guestId: user.id, conversationId: conversation.id, userMessageId: message.id, replyId: reply.id, relayMessageId: proof.relay_message_id, cards: reply.cards.length, checked: ['actual cross-process Relay delivery', 'business result persisted', 'duplicate message/reply suppressed', 'real catalog search tool', 'cross-user conversation denied', 'SSE reconnect replay'] }, null, 2));
