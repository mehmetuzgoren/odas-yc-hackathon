import { AgentRelay, type RelayMessage } from '@agent-relay/sdk';
import { readIdentities } from './provision';
import { relayEnvelopeSchema, roleSchema, type RelayEnvelope, type WorkerRole } from './protocol';

const role = roleSchema.parse(process.argv[process.argv.indexOf('--role') + 1]);
const other: WorkerRole = role === 'concierge' ? 'operations' : 'concierge';
const identities = readIdentities();
const apiUrl = process.env.API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const internalToken = process.env.ODAS_INTERNAL_TOKEN;
if (!internalToken || internalToken.length < 32) throw new Error('ODAS_INTERNAL_TOKEN must contain at least 32 characters.');
const relay = new AgentRelay({ workspaceKey: identities.workspaceKey, baseUrl: identities.baseUrl, onError: (error) => console.warn(`[${role}] Relay listener: ${safeError(error)}`) });
const agent = await relay.workspace.reconnect({ apiToken: identities.agents[role]!.token });
function safeError(error: unknown) {
  let text = error instanceof Error ? error.message : String(error);
  for (const value of [identities.workspaceKey, ...Object.values(identities.agents).map(v => v.token), internalToken]) if (value) text = text.replaceAll(value, '[redacted]');
  return text;
}
let stopping = false;
let lastError: string | null = null;
const inFlight = new Set<string>();
async function rpc<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}/api/internal/relay${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${internalToken}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(data.error ?? `Internal API returned ${response.status}`);
  return data as T;
}
async function send(envelope: RelayEnvelope, idempotencyKey: string) {
  return agent.sendMessage({ to: `@${identities.agents[other]!.name}`, text: JSON.stringify(envelope), idempotencyKey, metadata: { application: 'odas', version: 1, kind: envelope.kind } });
}
async function receive(message: RelayMessage) {
  if (message.from.name !== identities.agents[other]!.name) return;
  let envelope: RelayEnvelope;
  try { envelope = relayEnvelopeSchema.parse(JSON.parse(message.text)); } catch { return; }
  const key = envelope.kind === 'domain_event' ? envelope.outboxId : `result:${envelope.outboxId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    if (envelope.kind === 'domain_event') {
      if (envelope.target !== role) return;
      try {
        const outcome = await rpc<{ status: 'completed'; result: unknown }>('/process', { worker: role, event: envelope.event, outboxId: envelope.outboxId, relayMessageId: message.messageId });
        await send({ version: 1, kind: 'business_result', worker: role, outboxId: envelope.outboxId, eventId: envelope.event.id, status: 'completed', result: outcome.result }, `result:${envelope.outboxId}:completed:${message.messageId}`);
      } catch (error) {
        const errorText = safeError(error);
        await send({ version: 1, kind: 'business_result', worker: role, outboxId: envelope.outboxId, eventId: envelope.event.id, status: 'failed', error: errorText }, `result:${envelope.outboxId}:failed:${message.messageId}`);
      }
    } else {
      if (envelope.worker !== other) return;
      await rpc('/complete', envelope);
    }
    // Read state is transport receipt only. Business completion is the result DM above.
    await agent.messages.markRead(message.messageId);
    lastError = null;
  } catch (error) {
    lastError = safeError(error);
    console.warn(`[${role}] ${lastError}`);
  } finally { inFlight.delete(key); }
}
const unsubscribe = relay.addListener('message.created', ({ message }) => receive(message));
const unsubscribeDm = relay.addListener('dm.received', ({ message }) => receive(message));
await relay.events.connect();
console.log(`ODAS ${role} worker connected through actual Agent Relay as ${agent.name}.`);
async function cycle() {
  try {
    // A worker publishes to its peer, so a domain event always crosses process boundaries.
    const { events } = await rpc<{ events: { id: string; target: WorkerRole; event: any; attempts: number }[] }>(`/outbox?publisher=${role}`);
    for (const item of events) {
      const result = await send({ version: 1, kind: 'domain_event', outboxId: item.id, target: item.target, event: item.event }, `odas:${item.id}:attempt:${item.attempts}`);
      await rpc('/published', { id: item.id, publisher: role, relayMessageId: result.messageId });
    }
    // Re-read durable unread DMs after disconnects; processing is idempotent in SQLite.
    const inbox = await agent.inbox.get({ limit: 100 });
    for (const conversation of inbox.unreadDms) {
      const messages = await agent.messages.listDirect({ conversationId: conversation.conversationId, limit: 100 });
      for (const message of messages.reverse()) await receive(message);
    }
    await rpc('/heartbeat', { worker: role, agentId: agent.id, status: 'connected', lastError });
  } catch (error) {
    lastError = safeError(error);
    console.warn(`[${role}] ${lastError}`);
  }
}
function stop() { stopping = true; unsubscribe(); unsubscribeDm(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
while (!stopping) { await cycle(); await new Promise(resolve => setTimeout(resolve, 1500)); }
await relay.events.disconnect();
process.exit(0);
