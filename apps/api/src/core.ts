import type { Context } from 'hono';
import type { Database } from 'bun:sqlite';
import { getCookie } from 'hono/cookie';
import { canControlDevices } from './operations/permissions';
import type { User, RoomGateway, SearchInput, SearchResult, Office, Workspace, Quote, Reservation, DomainEvent, ReplacementOffer, Notification, DeviceAdapter } from '@odas/contracts';

export interface Config { dataDir: string; origin: string; apiPort: number; internalToken: string; testMode: boolean; namespace: string; deviceMode: 'simulator' | 'physical'; stripeSecretKey?: string; stripeWebhookSecret?: string; [key: string]: unknown }
export interface Clock { now(): number }
export interface CatalogService { search(input: SearchInput): Promise<SearchResult>; group(id: string, input?: SearchInput): Promise<{ group: Workspace; offices: Office[] }>; office(id: string, input?: SearchInput): Promise<Office> }
export interface CommerceService { quote(user: User, input: { roomId: string; startAt: number; endAt: number }): Promise<Quote>; hold(user: User, quoteId: string, idempotencyKey?: string): Promise<Reservation>; checkout(user: User, bookingId: string): Promise<{ url: string; reservation: Reservation }>; get(user: User, id: string): Promise<Reservation>; list(user: User): Promise<Reservation[]>; cancel(user: User, id: string, reason?: string): Promise<Reservation>; reconcile(user: User, id: string): Promise<Reservation>; checkIn(user: User, id: string): Promise<Reservation>; checkOut(user: User, id: string): Promise<Reservation>; offerReplacement(bookingId: string, event?: DomainEvent): Promise<ReplacementOffer | null>; acceptOffer(user: User, offerId: string): Promise<Reservation>; declineOffer(user: User, offerId: string): Promise<Reservation>; recover(): Promise<void>; [key: string]: unknown }
export interface OperationsService { device: DeviceAdapter; inspect(roomId: string): Promise<unknown>; processEvent(event: DomainEvent): Promise<unknown>; drain(): Promise<void>; tick(): Promise<void>; [key: string]: unknown }
export interface ConciergeService { notify(userId: string, input: Omit<Notification, 'id' | 'userId' | 'createdAt'>, idempotencyKey?: string): Notification; processEvent(event: DomainEvent): Promise<unknown>; [key: string]: unknown }
export interface Runtime { db: Database; clock: Clock; rooms: RoomGateway; config: Config; services: { catalog: CatalogService; commerce: CommerceService; operations: OperationsService; concierge: ConciergeService } }
export class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
export function fail(status: number, message: string, code?: string): never { throw new HttpError(status, message, code); }
export const uid = (prefix = 'id') => `${prefix}_${crypto.randomUUID()}`;
export const parseJSON = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
export async function currentUser(c: Context, rt: Runtime): Promise<User | null> {
  const token = getCookie(c, 'odas_session');
  if (!token) return null;
  const hash = new Bun.CryptoHasher('sha256').update(token).digest('hex');
  const row = rt.db.query('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id_hash=? AND s.expires_at>?').get(hash, rt.clock.now()) as any;
  return row ? { id: row.id, email: row.email, name: row.name, role: row.role, testAccount: !!row.test_account } : null;
}
export async function requireUser(c: Context, rt: Runtime): Promise<User> { return await currentUser(c, rt) ?? fail(401, 'Please sign in to continue.', 'unauthorized'); }
export async function requireOperator(c: Context, rt: Runtime, roomId?: string): Promise<User> {
  const user = await requireUser(c, rt);
  if (user.role !== 'operator') fail(403, 'Operator access is required.', 'forbidden');
  if (roomId) {
    const scope = rt.db.query('SELECT 1 FROM operator_scopes s JOIN offices o ON o.group_id=s.group_id WHERE s.user_id=? AND o.id=?').get(user.id, roomId);
    if (!scope) fail(403, 'This office is outside your assigned workspace.', 'forbidden');
    if (!['GET', 'HEAD'].includes(c.req.method) && !canControlDevices(rt, user, roomId)) fail(403, 'This account has no device-control permission for this room.', 'test_account');
  }
  return user;
}
export function enqueue(rt: Runtime, event: DomainEvent, target = 'operations') {
  rt.db.query('INSERT OR IGNORE INTO outbox(id,target,event_json,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,\'pending\',0,?,?)').run(`${event.id}:${target}`, target, JSON.stringify(event), rt.clock.now(), rt.clock.now());
}
export function audit(rt: Runtime, actor: string, action: string, entityId: string, data: unknown = {}) {
  rt.db.query('INSERT INTO audit_log(id,actor,action,entity_id,data,created_at) VALUES(?,?,?,?,?,?)').run(uid('audit'), actor, action, entityId, JSON.stringify(data), rt.clock.now());
}
export function userById(rt: Runtime, id: string): User { const row = rt.db.query('SELECT * FROM users WHERE id=?').get(id) as any; if (!row) fail(404, 'Account not found.'); return { id: row.id, email: row.email, name: row.name, role: row.role, testAccount: !!row.test_account }; }
