/** Integration coverage for financial/inventory authority, using a real separately running Terse runtime. */
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import Stripe from 'stripe';
import { Temporal } from '@js-temporal/polyfill';
import { openDatabase } from '../db';
import { loadConfig } from '../config';
import { HttpError, type Runtime } from '../core';
import { createRoomGateway } from '../operations/gateway';
import { createOperationsService } from '../operations/service';
import { createOperationsRoutes } from '../operations';
import { createCatalogService } from '../catalog/service';
import { createCommerceService } from './service';
import { createCommerceRoutes } from './index';
import type { Reservation, User } from '@odas/contracts';

export async function runCommerceIntegration() {
  if (!process.env.TERSE_ACTOR_URL?.includes(':7111/')) throw new Error('Run commerce checks with the isolated native actor runtime on port 7111.');
  const run = crypto.randomUUID().slice(0, 8);
  const config = loadConfig();
  config.dataDir = resolve(`.data/test-commerce-${run}`);
  config.namespace = `test-commerce-${run}`;
  config.testMode = true;
  config.deviceMode = 'simulator';
  const db = openDatabase(config.dataDir);
  let now = Date.now();
  const rt: Runtime = { config, db, clock: { now: () => now }, rooms: createRoomGateway(), services: {} as any };
  rt.services.catalog = createCatalogService(rt);
  const commerce = createCommerceService(rt);
  rt.services.commerce = commerce;
  rt.services.concierge = { notify: () => ({}), processEvent: async () => ({}) } as any;
  const group = `commerce-${run}`;
  const roomA = `${group}-a`;
  const roomB = `${group}-b`;
  db.query('INSERT INTO workspace_groups(id,name,address,latitude,longitude,base_rate_cents,timezone,modeled,description,hours_json) VALUES(?,?,?,0,0,500,\'America/Los_Angeles\',1,?,?)').run(group, 'Commerce integration fixture', 'Synthetic inventory', 'Synthetic test fixture, not live supply.', JSON.stringify({ open: '08:00', close: '20:00', days: [1, 2, 3, 4, 5, 6, 7], modeled: true }));
  for (const id of [roomA, roomB]) db.query('INSERT INTO offices(id,group_id,name,description,attributes_json) VALUES(?,?,?,?,?)').run(id, group, id === roomA ? 'Office A' : 'Office B', 'Synthetic equivalent fixture.', JSON.stringify({ synthetic: true, equivalenceClass: 'commerce-fixture', capacity: 1, desk: true }));
  const app = new Hono();
  app.route('/api', createCommerceRoutes(rt));
  rt.services.operations = createOperationsService(rt);
  app.route('/api', createOperationsRoutes(rt));
  app.onError((e, c) => c.json({ error: e.message, ...(e instanceof HttpError && e.code ? { code: e.code } : {}) }, (e instanceof HttpError ? e.status : 500) as any));
  const checks: string[] = [];
  const pass = (text: string) => { checks.push(text); console.log(`PASS ${text}`); };
  const tomorrow = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO('America/Los_Angeles').toPlainDate().add({ days: 1 }).toString();
  const start = Temporal.ZonedDateTime.from(`${tomorrow}T10:00[America/Los_Angeles]`).epochMilliseconds;
  const end = start + 2 * 3_600_000;
  const password = `Fixture!${crypto.randomUUID()}`;
  const response = await app.request('http://localhost/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Commerce fixture', email: `${run}@example.test`, password }) });
  assert.equal(response.status, 201);
  const auth = await response.json() as { user: User; csrfToken: string };
  assert.equal(auth.user.role, 'guest');
  const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(response.headers.getSetCookie().some(value => value.startsWith('odas_session=') && value.includes('HttpOnly')));
  const stored = db.query('SELECT password_hash FROM users WHERE id=?').get(auth.user.id) as any;
  assert.ok(stored.password_hash.startsWith('$argon2id$'));
  const session = await app.request('http://localhost/api/auth/session', { headers: { Cookie: cookies } });
  assert.equal((await session.json() as any).user.id, auth.user.id);
  const escalation = await app.request('http://localhost/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Not an operator', email: `operator-${run}@example.test`, password, role: 'operator' }) });
  assert.equal(escalation.status, 400);
  pass('ordinary signup, Argon2id, durable HttpOnly session, and public operator provisioning denial');

  const q1 = await commerce.quote(auth.user, { roomId: roomA, startAt: start, endAt: end });
  const q2 = await commerce.quote(auth.user, { roomId: roomA, startAt: start, endAt: end });
  assert.equal(q1.subtotalCents, 1000); assert.equal(q1.feeCents, 100); assert.equal(q1.totalCents, 1100);
  assert.ok(q1.cancellationPolicy.includes('Full refund'));
  const raced = await Promise.allSettled([commerce.hold(auth.user, q1.id), commerce.hold(auth.user, q2.id)]);
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
  const winner = (raced.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Reservation>).value;
  const retry = await commerce.hold(auth.user, winner.quoteId);
  assert.equal(retry.id, winner.id);
  assert.equal(retry.roomState?.events.length, 0);
  assert.ok(retry.roomState?.intervals.every(i => i.bookingId === winner.id));
  assert.equal((await rt.rooms.snapshot(roomA)).intervals.filter(i => i.status === 'held').length, 1);
  const stranger: User = { ...auth.user, id: 'stranger' };
  await assert.rejects(commerce.get(stranger, winner.id), (e: any) => e.status === 404);
  pass('integer quote amounts, 10% fee, competing native actor holds, idempotent retries, ownership');

  if (config.stripeSecretKey) {
    const checkout = await commerce.checkout(auth.user, winner.id);
    assert.match(checkout.url, /^https:\/\/checkout\.stripe\.com\//);
    const repeated = await commerce.checkout(auth.user, winner.id);
    assert.equal(repeated.reservation.checkoutSessionId, checkout.reservation.checkoutSessionId);
    assert.equal(repeated.url, checkout.url);
    const paid = await commerce.reconcile(auth.user, winner.id);
    assert.notEqual(paid.paymentStatus, 'paid');
    const stripe = new Stripe(config.stripeSecretKey);
    await stripe.checkout.sessions.expire(checkout.reservation.checkoutSessionId!);
    const expired = await commerce.reconcile(auth.user, winner.id);
    assert.equal(expired.status, 'expired');
    assert.equal((await rt.rooms.snapshot(roomA)).intervals.find(i => i.bookingId === winner.id)?.status, 'canceled');
    pass('actual Stripe sandbox hosted Checkout creation, idempotent session retry, unpaid reconciliation, expiration, inventory release');
    // Signed webhook exercises raw-body verification and the same provider-backed fulfillment operation.
    const secret = 'whsec_commerce_integration_fixture_only';
    config.stripeWebhookSecret = secret;
    const payload = JSON.stringify({ id: `evt_${run}`, object: 'event', type: 'checkout.session.expired', livemode: false, data: { object: { id: checkout.reservation.checkoutSessionId, object: 'checkout.session' } } });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
    await commerce.handleWebhook(payload, signature);
    await commerce.handleWebhook(payload, signature);
    await assert.rejects(commerce.handleWebhook(payload + ' ', signature), (e: any) => e.status === 400);
    assert.equal((db.query('SELECT count(*) AS n FROM payment_events WHERE id=?').get(`evt_${run}`) as any).n, 1);
    pass('signed raw-body webhook, duplicate event replay, invalid-signature rejection (actual sandbox session retrieval)');
  } else {
    await assert.rejects(commerce.checkout(auth.user, winner.id), (e: any) => e.code === 'stripe_not_configured');
    await commerce.cancel(auth.user, winner.id);
    pass('unconfigured payments fail explicitly without payment success');
  }

  // Isolated service-recovery fixtures are explicitly synthetic and never pretend to be Stripe payments.
  const quote = await commerce.quote(auth.user, { roomId: roomA, startAt: start, endAt: end });
  const booking = await commerce.hold(auth.user, quote.id);
  assert.equal((await rt.rooms.command(roomA, { id: `${booking.id}:fixture-confirm`, type: 'confirm', bookingId: booking.id, now })).ok, true);
  db.query('UPDATE reservations SET status=\'confirmed\',payment_status=\'paid\',data=json_set(data,\'$.syntheticPaymentFixture\',1),revision=revision+1 WHERE id=?').run(booking.id);
  const inspect = await rt.rooms.command(roomA, { id: `${booking.id}:vacancy`, type: 'inspect', now, inspection: { id: `inspection-${run}`, roomId: roomA, source: 'simulator', capturedAt: now, inferredAt: now, sequence: 1, occupancy: 'vacant', confidence: 0.99, floor: 'dirty', surfaces: 'clear', connection: 'connected' } });
  assert.equal(inspect.ok, true);
  await rt.rooms.command(roomA, { id: `${booking.id}:clean-request`, type: 'request_clean', jobId: `job-${run}`, expectedReadyAt: start + 5 * 60_000, now });
  const event = (await rt.rooms.snapshot(roomA)).events.find(e => e.type === 'room.readiness_delayed');
  const offer = await commerce.offerReplacement(booking.id, event);
  assert.ok(offer); assert.equal(offer.roomId, roomB); assert.match(offer.equivalence, /Synthetic/);
  await commerce.declineOffer(auth.user, offer.id);
  assert.equal((await commerce.get(auth.user, booking.id)).roomId, roomA);
  const second = await commerce.offerReplacement(booking.id);
  assert.ok(second);
  const swapped = await commerce.acceptOffer(auth.user, second.id);
  assert.equal(swapped.id, booking.id); assert.equal(swapped.roomId, roomB);
  assert.equal(swapped.startAt, booking.startAt); assert.equal(swapped.endAt, booking.endAt); assert.equal(swapped.totalCents, booking.totalCents);
  assert.equal((await rt.rooms.snapshot(roomB)).intervals.find(i => i.bookingId === booking.id)?.status, 'confirmed');
  assert.equal((await rt.rooms.snapshot(roomA)).intervals.find(i => i.bookingId === booking.id)?.status, 'canceled');
  const retrySwap = await commerce.acceptOffer(auth.user, second.id);
  assert.equal(retrySwap.roomId, roomB);
  assert.equal((db.query('SELECT count(*) AS n FROM swaps WHERE booking_id=?').get(booking.id) as any).n, 1);
  pass('synthetic equivalent recovery through real booking services/native inventory; decline, accept, stable ID/time/price, replay');

  const recoveryRoom = `${group}-recovery`;
  db.query('INSERT INTO offices(id,group_id,name,description,attributes_json) VALUES(?,?,?,?,?)').run(recoveryRoom, group, 'Recovery fixture', 'Synthetic equivalent fixture.', JSON.stringify({ synthetic: true, equivalenceClass: 'commerce-fixture', capacity: 1, desk: true }));
  await rt.rooms.command(roomB, { id: `${booking.id}:replacement-dirty`, type: 'inspect', now, inspection: { id: `replacement-inspection-${run}`, roomId: roomB, source: 'simulator', capturedAt: now, inferredAt: now, sequence: 1, occupancy: 'vacant', confidence: 0.99, floor: 'dirty', surfaces: 'clear', connection: 'connected' } });
  await rt.rooms.command(roomB, { id: `${booking.id}:replacement-clean`, type: 'request_clean', jobId: `replacement-job-${run}`, expectedReadyAt: start + 5 * 60_000, now });
  const expiredOffer = await commerce.offerReplacement(booking.id);
  assert.ok(expiredOffer);
  db.query('UPDATE offers SET expires_at=? WHERE id=?').run(now - 1, expiredOffer.id);
  await assert.rejects(commerce.acceptOffer(auth.user, expiredOffer.id), (e: any) => e.code === 'offer_expired');
  assert.equal((await commerce.get(auth.user, booking.id)).roomId, roomB);
  const recoveryOffer = await commerce.offerReplacement(booking.id);
  assert.ok(recoveryOffer);
  const actualGateway = rt.rooms;
  let interrupted = false;
  rt.rooms = { ...actualGateway, command: async (id, cmd) => {
    const result = await actualGateway.command(id, cmd);
    if (id === recoveryRoom && cmd.type === 'confirm' && result.ok && !interrupted) {
      interrupted = true;
      throw new Error('Integration fault: RPC response lost after native actor confirmation committed');
    }
    return result;
  } };
  await assert.rejects(commerce.acceptOffer(auth.user, recoveryOffer.id), /RPC response lost/);
  assert.equal((await commerce.get(auth.user, booking.id)).roomId, roomB);
  assert.equal((await actualGateway.snapshot(recoveryRoom)).intervals.find(i => i.bookingId === booking.id)?.status, 'confirmed');
  rt.rooms = actualGateway;
  const restartedCommerce = createCommerceService(rt);
  rt.services.commerce = restartedCommerce;
  await restartedCommerce.recover();
  const recovered = await restartedCommerce.get(auth.user, booking.id);
  assert.equal(recovered.roomId, recoveryRoom); assert.equal(recovered.id, booking.id); assert.equal(recovered.totalCents, booking.totalCents);
  assert.equal((await actualGateway.snapshot(roomB)).intervals.find(i => i.bookingId === booking.id)?.status, 'canceled');
  assert.equal((db.query('SELECT count(*) AS n FROM swaps WHERE booking_id=? AND stage=\'complete\'').get(booking.id) as any).n, 2);
  pass('expired offer preserves assignment; interrupted confirmed replacement recovers after service restart without another payment');

  const thirdRoom = `${group}-c`;
  db.query('INSERT INTO offices(id,group_id,name,description) VALUES(?,?,?,?)').run(thirdRoom, group, 'Expiry fixture', 'Synthetic expiry fixture.');
  const expiryQuote = await commerce.quote(auth.user, { roomId: thirdRoom, startAt: start + 4 * 3_600_000, endAt: end + 4 * 3_600_000 });
  const expiryHold = await commerce.hold(auth.user, expiryQuote.id);
  now += 46 * 60_000;
  await rt.rooms.command(thirdRoom, { id: `${expiryHold.id}:advance`, type: 'tick', now });
  await commerce.recover();
  assert.equal((await commerce.get(auth.user, expiryHold.id)).status, 'expired');
  assert.equal((await rt.rooms.snapshot(thirdRoom)).intervals.find(i => i.bookingId === expiryHold.id)?.status, 'canceled');
  pass('controlled-clock hold expiry and persisted workflow recovery in isolated actor namespace');
  const hostId = `host-view-${run}`;
  const hostEmail = `host-view-${run}@example.test`;
  db.query("INSERT INTO users(id,email,password_hash,name,role,test_account,created_at) VALUES(?,?,?,?,'operator',1,?)").run(hostId, hostEmail, stored.password_hash, 'Host viewing fixture', now);
  const hostLogin = await app.request('http://localhost/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: hostEmail, password }) });
  assert.equal(hostLogin.status, 200);
  const hostCookies = hostLogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const originalMode = config.deviceMode;
  const originalDeviceUrl = config.deviceUrl;
  let deviceMutations = 0;
  const deviceFixture = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    if (request.method !== 'GET') deviceMutations++;
    return new URL(request.url).pathname.endsWith('/frame')
      ? new Response('private-camera-fixture')
      : Response.json({ jevEnabled: false, roboEnabled: false, mode: 'physical' });
  } });
  config.deviceMode = 'physical'; config.deviceUrl = `http://127.0.0.1:${deviceFixture.port}`;
  try {
    const view = (path: string, cookie = hostCookies) => app.request(`http://localhost/api/operator/rooms/${roomA}${path}`, { headers: { Cookie: cookie } });
    assert.equal((await view('')).status, 403);
    db.query('INSERT INTO operator_scopes(user_id,group_id) VALUES(?,?)').run(hostId, group);
    for (const path of ['', '/demo', '/frame']) assert.equal((await view(path)).status, 200);
    assert.equal((await view('/frame', '')).status, 401);
    assert.equal((await view('/frame', cookies)).status, 403);
    for (const [path, method] of [['/demo', 'PATCH'], ['/clean', 'POST'], ['/inspect', 'POST'], ['/dock', 'POST']]) {
      const response = await app.request(`http://localhost/api/operator/rooms/${roomA}${path}`, { method, headers: { Cookie: hostCookies, 'Content-Type': 'application/json' }, body: JSON.stringify({ jevEnabled: true }) });
      assert.equal(response.status, 403);
      assert.equal((await response.json() as any).code, 'test_account');
    }
    assert.equal(deviceMutations, 0);
    pass('assigned test hosts can view physical room details, demo status and camera frames; guests and device-control mutations remain blocked');
  } finally {
    config.deviceMode = originalMode; config.deviceUrl = originalDeviceUrl; deviceFixture.stop(true);
  }
  db.close();
  console.log(JSON.stringify({ checks: checks.length, dataDir: config.dataDir, actorUrl: process.env.TERSE_ACTOR_URL, paymentEvidence: config.stripeSecretKey ? 'real sandbox Checkout and expiration; successful payment/refund not exercised here' : 'not configured' }));
  return checks;
}

if (import.meta.main) await runCommerceIntegration();
