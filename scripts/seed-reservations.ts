import { Temporal } from '@js-temporal/polyfill';
import { parseArgs } from 'node:util';
import { TIMEZONE, type Workspace } from '@odas/contracts';
import type { Runtime } from '../apps/api/src/core';
import { isWithinHours, localInstant, mapWorkspace } from '../apps/api/src/catalog/service';
import { createClock, loadConfig } from '../apps/api/src/config';
import { openDatabase } from '../apps/api/src/db';
import { inventory, seed } from './seed';

const FIXTURE = 'host-dashboard-reservations-v1';
const GUEST = 'host-dashboard-demo-guest';
const HOLD_MS = 45 * 60_000;
const patterns = [
  [['08:00', '10:00'], ['11:00', '13:00'], ['14:00', '16:00'], ['17:00', '19:00']],
  [['09:00', '11:00'], ['12:00', '14:00'], ['15:00', '17:00'], ['18:00', '20:00']],
  [['08:30', '11:30'], ['12:30', '15:00'], ['16:00', '19:00']],
  [['08:00', '09:30'], ['10:30', '12:00'], ['13:00', '15:30'], ['16:30', '20:00']],
  [['09:30', '12:00'], ['13:00', '16:00'], ['17:00', '19:30']],
] as const;

/** Explicit demo data: uses native inventory, with no payment or device calls. */
export async function seedReservations(rt: Pick<Runtime, 'db' | 'rooms' | 'clock'>, options: { date?: string; days?: number } = {}) {
  const firstDate = Temporal.PlainDate.from(options.date ?? Temporal.Instant.fromEpochMilliseconds(rt.clock.now()).toZonedDateTimeISO(TIMEZONE).toPlainDate());
  const days = options.days ?? 4;
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new Error('Choose between 1 and 14 demo days.');
  const offices: { id: string; workspace: Workspace; rateCents: number }[] = [];
  for (const [groupId, , , count] of inventory) for (let number = 2; number <= count; number++) {
    const id = `${groupId}-office-${String(number).padStart(2, '0')}`;
    const row = await rt.db.query('SELECT g.*,COALESCE(o.rate_cents,g.base_rate_cents) AS rate FROM offices o JOIN workspace_groups g ON g.id=o.group_id WHERE o.id=? AND o.modeled=1 AND g.modeled=1').get(id) as Record<string, any> | null;
    if (row) offices.push({ id, workspace: mapWorkspace(row), rateCents: row.rate });
  }
  if (!(await rt.db.query('SELECT id FROM users WHERE id=?').get(GUEST))) {
    const hash = await Bun.password.hash(crypto.randomUUID(), { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 });
    await rt.db.query("INSERT INTO users(id,email,password_hash,name,role,test_account,created_at) VALUES(?,?,?,?,'guest',1,?)")
      .run(GUEST, 'host-dashboard-demo@odas.local', hash, 'Demo guest', rt.clock.now());
  }
  const result = { date: firstDate.toString(), days, rooms: offices.length, created: 0, existing: 0, elapsed: 0, outsideHours: 0, conflicts: [] as string[] };
  for (let day = 0; day < days; day++) {
    const date = firstDate.add({ days: day }).toString();
    for (const [index, office] of offices.entries()) for (const [start, end] of patterns[(index + day) % patterns.length]!) {
      const startAt = localInstant(date, start, office.workspace.timezone);
      const endAt = localInstant(date, end, office.workspace.timezone);
      if (endAt <= rt.clock.now()) { result.elapsed++; continue; }
      if (!isWithinHours(office.workspace, startAt, endAt)) { result.outsideHours++; continue; }
      const key = `${FIXTURE}:${office.id}:${date}:${start}`;
      const id = `demo_${new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 24)}`;
      const existing = await rt.db.query('SELECT status,data FROM reservations WHERE id=?').get(id) as { status: string; data: string } | null;
      if (existing && (JSON.parse(existing.data).fixture !== FIXTURE || !['held', 'confirmed'].includes(existing.status))) {
        result.conflicts.push(`${office.id} ${date} ${start}: existing reservation was changed; preserved`); continue;
      }
      const now = rt.clock.now();
      const subtotal = Math.round(office.rateCents * (endAt - startAt) / 3_600_000);
      const fee = Math.round(subtotal / 10);
      const data = JSON.stringify({ fixture: FIXTURE, synthetic: true, fundingSource: 'Demo reservation; no Stripe charge', workflow: 'demo_seed' });
      if (!existing) await rt.db.transaction(async () => {
        await rt.db.query('INSERT INTO quotes(id,user_id,room_id,start_at,end_at,rate_cents,subtotal_cents,fee_cents,total_cents,currency,expires_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(`quote_${id}`, GUEST, office.id, startAt, endAt, office.rateCents, subtotal, fee, subtotal + fee, 'usd', now + HOLD_MS, data);
        await rt.db.query("INSERT INTO reservations(id,user_id,room_id,original_room_id,group_id,quote_id,start_at,end_at,subtotal_cents,fee_cents,total_cents,currency,status,payment_status,refund_status,hold_expires_at,idempotency_key,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'held','demo','none',?,?,?,?,?)")
          .run(id, GUEST, office.id, office.id, office.workspace.id, `quote_${id}`, startAt, endAt, subtotal, fee, subtotal + fee, 'usd', now + HOLD_MS, key, now, now, data);
      })();
      const interval = (await rt.rooms.snapshot(office.id)).intervals.find(value => value.bookingId === id);
      if (interval?.status === 'confirmed') {
        if (existing?.status === 'confirmed') { result.existing++; continue; }
      } else {
        const held = await rt.rooms.command(office.id, { id: `${id}:seed-hold:${crypto.randomUUID()}`, type: 'hold', bookingId: id, startAt, endAt, expiresAt: rt.clock.now() + HOLD_MS, now: rt.clock.now() });
        if (!held.ok) {
          await rt.db.query("UPDATE reservations SET status='canceled',hold_expires_at=NULL,updated_at=? WHERE id=? AND status='held'").run(rt.clock.now(), id);
          result.conflicts.push(`${office.id} ${date} ${start}: ${held.message || held.code}`); continue;
        }
        const confirmed = await rt.rooms.command(office.id, { id: `${id}:seed-confirm:${crypto.randomUUID()}`, type: 'confirm', bookingId: id, now: rt.clock.now() });
        if (!confirmed.ok) throw new Error(`Could not confirm ${id}: ${confirmed.message || confirmed.code}. Rerun to resume.`);
      }
      await rt.db.query("UPDATE reservations SET status='confirmed',hold_expires_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND status='held'").run(rt.clock.now(), id);
      result.created++;
    }
  }
  return result;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { date: { type: 'string' }, days: { type: 'string' } }, strict: true });
  const config = loadConfig();
  if (process.env.NODE_ENV === 'production' || config.namespace !== 'development' && !config.testMode) throw new Error('Demo reservations require the development or an isolated test namespace.');
  const { createRoomGateway } = await import('../apps/api/src/operations/gateway');
  const db = await openDatabase(config.dataDir);
  try {
    await seed(db, config.dataDir);
    const result = await seedReservations({ db, clock: createClock(config), rooms: createRoomGateway() }, { date: values.date, days: values.days === undefined ? undefined : Number(values.days) });
    console.log(JSON.stringify(result, null, 2));
  } finally { await db.close(); }
}
