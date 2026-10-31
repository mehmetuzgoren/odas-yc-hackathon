import Stripe from 'stripe';
import { CANCELLATION_POLICY, intervalSchema, type Office, type Quote, type Reservation, type ReplacementOffer, type User, type DomainEvent, type RoomCommand } from '@odas/contracts';
import { audit, fail, parseJSON, uid, userById, type Runtime, type CommerceService } from '../core';
import { isWithinHours } from '../catalog/service';

type Row = Record<string, any>;
const HOLD_MS = 45 * 60_000;
const QUOTE_MS = 10 * 60_000;
const configuredOfferMinutes = Number(process.env.REPLACEMENT_OFFER_MINUTES || 10);
const OFFER_MS = (Number.isFinite(configuredOfferMinutes) ? Math.max(1, Math.min(60, configuredOfferMinutes)) : 10) * 60_000;
const ACTIVE = ['confirmed', 'checked_in'];
const POLICY = (rt: Runtime) => String(rt.config.cancellationPolicy || CANCELLATION_POLICY);
const digest = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');

export function createCommerceService(rt: Runtime) {
  const db = rt.db;
  const key = rt.config.stripeSecretKey;
  if (key && !/^(sk|rk|rkcs)_test_/.test(key)) throw new Error('ODAS only accepts Stripe sandbox/test credentials.');
  // The SDK's bundled API version is deliberately used with the pinned SDK release.
  const stripe = key ? new Stripe(key, { maxNetworkRetries: 2, timeout: 15_000 }) : null;
  const provider = () => stripe ?? fail(503, 'Stripe sandbox is not configured. Your office has not been charged.', 'stripe_not_configured');
  const row = (id: string): Row => db.query('SELECT * FROM reservations WHERE id=?').get(id) as Row ?? fail(404, 'Reservation not found.', 'not_found');
  const owned = (user: User, id: string): Row => {
    const r = row(id);
    // Operators use their separately scoped operations API. Guest services never broaden access by role.
    if (r.user_id !== user.id) fail(404, 'Reservation not found.', 'not_found');
    return r;
  };
  const quoteRow = (id: string): Row => db.query('SELECT * FROM quotes WHERE id=?').get(id) as Row ?? fail(404, 'Quote not found.', 'not_found');

  function update(r: Row, patch: Row): Row {
    const allowed = new Set(['room_id', 'group_id', 'status', 'payment_status', 'refund_status', 'checkout_session_id', 'payment_intent_id', 'checkout_url', 'hold_expires_at', 'data']);
    const pairs = Object.entries(patch).filter(([k]) => allowed.has(k));
    if (!pairs.length) return r;
    const result = db.query(`UPDATE reservations SET ${pairs.map(([k]) => `${k}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=? AND revision=?`)
      .run(...pairs.map(([, v]) => v), rt.clock.now(), r.id, r.revision);
    if (!result.changes) fail(409, 'This reservation changed. Refresh to see its current status.', 'revision_conflict');
    return row(r.id);
  }

  async function withLease<T>(name: string, work: () => Promise<T>): Promise<T> {
    const owner = uid('lease');
    // Workflow leases measure process time, independently of isolated fixture clocks.
    const now = Date.now();
    db.query('INSERT INTO workflow_leases(key,owner,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE workflow_leases.expires_at<?')
      .run(name, owner, now + 120_000, now);
    const lease = db.query('SELECT owner FROM workflow_leases WHERE key=?').get(name) as Row;
    if (lease.owner !== owner) fail(409, 'An update is already in progress. Please try again shortly.', 'workflow_busy');
    try { return await work(); }
    finally { db.query('DELETE FROM workflow_leases WHERE key=? AND owner=?').run(name, owner); }
  }

  async function command(roomId: string, command: RoomCommand) {
    const result = await rt.rooms.command(roomId, command);
    if (!result.ok) fail(409, result.message || 'The office cannot accept this change.', result.code || 'room_conflict');
    return result.snapshot;
  }

  function asQuote(q: Row): Quote {
    return { id: q.id, userId: q.user_id, roomId: q.room_id, startAt: q.start_at, endAt: q.end_at, rateCents: q.rate_cents, subtotalCents: q.subtotal_cents, feeCents: q.fee_cents, totalCents: q.total_cents, currency: 'usd', expiresAt: q.expires_at, cancellationPolicy: parseJSON<Row>(q.data, {}).cancellationPolicy || POLICY(rt) };
  }
  function asOffer(o: Row): ReplacementOffer {
    const data = parseJSON<Row>(o.data, {});
    return { id: o.id, bookingId: o.booking_id, roomId: o.room_id, status: o.status, expiresAt: o.expires_at, roomRevision: o.room_revision, equivalence: data.equivalence || 'Review the known details before accepting.', differences: data.differences || [], createdAt: o.created_at };
  }
  async function asReservation(r: Row): Promise<Reservation> {
    const data = parseJSON<Row>(r.data, {});
    const office = await rt.services.catalog.office(r.room_id, { startAt: r.start_at, endAt: r.end_at });
    const workspace = office.workspace!;
    const snapshot = await rt.rooms.snapshot(r.room_id);
    // Guest reservation views expose readiness, never another guest's inventory or operational event payloads.
    const guestState = { ...snapshot, intervals: snapshot.intervals.filter(i => i.bookingId === r.id), events: [], blocks: [], attentionReasons: [],
      inspection: snapshot.inspection ? { ...snapshot.inspection, frameId: undefined, error: undefined } : null,
      device: snapshot.device ? { ...snapshot.device, error: undefined, commandId: undefined } : null,
    };
    const offers = (db.query('SELECT * FROM offers WHERE booking_id=? ORDER BY created_at DESC').all(r.id) as Row[]).map(asOffer);
    for (const offer of offers) {
      if (offer.status === 'offered' && offer.expiresAt <= rt.clock.now()) offer.status = 'expired';
      try { offer.office = await rt.services.catalog.office(offer.roomId, { startAt: r.start_at, endAt: r.end_at }); } catch { /* Deleted inventory remains visible as an unavailable offer. */ }
    }
    const groupRow = db.query('SELECT access_instructions FROM workspace_groups WHERE id=?').get(r.group_id) as Row | null;
    return {
      id: r.id, userId: r.user_id, roomId: r.room_id, originalRoomId: r.original_room_id, groupId: r.group_id, quoteId: r.quote_id,
      startAt: r.start_at, endAt: r.end_at, subtotalCents: r.subtotal_cents, feeCents: r.fee_cents, totalCents: r.total_cents,
      currency: r.currency, status: r.status, paymentStatus: r.payment_status, refundStatus: r.refund_status,
      checkoutUrl: r.checkout_url, checkoutSessionId: r.checkout_session_id, holdExpiresAt: r.hold_expires_at,
      createdAt: r.created_at, revision: r.revision, office, workspace, roomState: guestState, offers,
      accessInstructions: ACTIVE.includes(r.status) && r.payment_status === 'paid' ? groupRow?.access_instructions || null : null,
      cancellationPolicy: data.cancellationPolicy || POLICY(rt), checkInWindowMinutes: Number(rt.config.checkInWindowMinutes || 15),
    };
  }

  function notify(r: Row, type: string, title: string, body: string) {
    rt.services.concierge?.notify(r.user_id, { bookingId: r.id, type, title, body, openConcierge: false }, `${r.id}:${type}:${r.room_id}`);
  }

  async function quote(user: User, input: { roomId: string; startAt: number; endAt: number }): Promise<Quote> {
    const parsed = intervalSchema.safeParse(input);
    if (!parsed.success || !input.roomId) fail(400, 'Choose an office and a valid reservation interval.', 'invalid_quote');
    if (input.startAt < rt.clock.now()) fail(400, 'The selected start time has passed.', 'start_passed');
    const office = await rt.services.catalog.office(input.roomId, input);
    if (!office.available || !office.workspace || !isWithinHours(office.workspace, input.startAt, input.endAt)) fail(409, office.availabilityReason || 'This office is unavailable.', 'unavailable');
    if (!Number.isSafeInteger(office.rateCents) || office.rateCents <= 0) fail(409, 'This office does not have a configured price.', 'invalid_price');
    const subtotal = Math.round(office.rateCents * (input.endAt - input.startAt) / 3_600_000);
    const fee = Math.round(subtotal * 10 / 100);
    const id = uid('quote');
    const expiresAt = rt.clock.now() + QUOTE_MS;
    db.query('INSERT INTO quotes(id,user_id,room_id,start_at,end_at,rate_cents,subtotal_cents,fee_cents,total_cents,currency,expires_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, user.id, office.id, input.startAt, input.endAt, office.rateCents, subtotal, fee, subtotal + fee, 'usd', expiresAt, JSON.stringify({ cancellationPolicy: POLICY(rt) }));
    return asQuote(quoteRow(id));
  }

  async function resumeHold(r: Row): Promise<Row> {
    const data = parseJSON<Row>(r.data, {});
    if (data.workflow !== 'hold_pending') return r;
    if (r.hold_expires_at <= rt.clock.now()) return update(r, { status: 'expired', data: JSON.stringify({ ...data, workflow: 'expired' }) });
    const result = await rt.rooms.command(r.room_id, { id: `${r.id}:hold`, type: 'hold', bookingId: r.id, startAt: r.start_at, endAt: r.end_at, expiresAt: r.hold_expires_at, now: rt.clock.now() });
    if (!result.ok) {
      update(r, { status: 'expired', data: JSON.stringify({ ...data, workflow: 'hold_failed', failure: result.code }) });
      fail(409, result.message || 'Another guest reserved this office. Please choose another.', result.code || 'unavailable');
    }
    return update(r, { data: JSON.stringify({ ...data, workflow: 'held' }) });
  }

  async function hold(user: User, quoteId: string, idempotencyKey?: string): Promise<Reservation> {
    const key = idempotencyKey || quoteId;
    if (key.length > 180 || !key) fail(400, 'Use a valid reservation request identifier.', 'invalid_idempotency_key');
    const q = quoteRow(quoteId);
    if (q.user_id !== user.id) fail(404, 'Quote not found.', 'not_found');
    let existing = db.query('SELECT * FROM reservations WHERE quote_id=? OR (user_id=? AND idempotency_key=?)').get(quoteId, user.id, key) as Row | null;
    if (existing && existing.quote_id !== quoteId) fail(409, 'This request identifier belongs to another quote.', 'idempotency_conflict');
    if (!existing) {
      if (q.expires_at <= rt.clock.now()) fail(409, 'This quote expired. Request a fresh quote.', 'quote_expired');
      if (q.start_at < rt.clock.now()) fail(409, 'The start time has passed. Choose a new interval.', 'start_passed');
      const office = db.query('SELECT group_id FROM offices WHERE id=?').get(q.room_id) as Row;
      const id = uid('odas');
      const now = rt.clock.now();
      const data = { workflow: 'hold_pending', cancellationPolicy: asQuote(q).cancellationPolicy };
      // Persist intent first. Unique quote and user/idempotency constraints arbitrate API replicas.
      db.query(`INSERT OR IGNORE INTO reservations(id,user_id,room_id,original_room_id,group_id,quote_id,start_at,end_at,subtotal_cents,fee_cents,total_cents,currency,status,payment_status,refund_status,hold_expires_at,idempotency_key,revision,created_at,updated_at,data)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'held','unpaid','none',?,?,0,?,?,?)`).run(id, user.id, q.room_id, q.room_id, office.group_id, q.id, q.start_at, q.end_at, q.subtotal_cents, q.fee_cents, q.total_cents, q.currency, now + HOLD_MS, key, now, now, JSON.stringify(data));
      existing = db.query('SELECT * FROM reservations WHERE quote_id=? OR (user_id=? AND idempotency_key=?)').get(quoteId, user.id, key) as Row;
    }
    return withLease(`booking:${existing.id}`, async () => asReservation(await resumeHold(owned(user, existing!.id))));
  }

  async function checkout(user: User, id: string): Promise<{ url: string; reservation: Reservation }> {
    provider();
    return withLease(`booking:${id}`, async () => {
      let r = owned(user, id);
      if (r.checkout_session_id) {
        await fulfillUnlocked(r.checkout_session_id);
        r = row(id);
        if (r.payment_status === 'paid') return fail(409, 'This reservation has already been paid.', 'already_paid');
        if (r.status === 'checkout_pending' && r.checkout_url) return { url: r.checkout_url, reservation: await asReservation(r) };
        return fail(409, 'This Checkout is no longer available. Request a new quote.', 'checkout_expired');
      }
      r = await resumeHold(r);
      if (!['held', 'checkout_pending'].includes(r.status)) fail(409, 'This reservation cannot enter Checkout.', 'invalid_status');
      if (r.hold_expires_at - rt.clock.now() < 31 * 60_000) fail(409, 'Too little time remains on this hold for secure Checkout. Cancel it and request a new quote.', 'hold_too_short');
      const oldData = parseJSON<Row>(r.data, {});
      // Stripe requires >=30 minutes; leave a minute before the actor hold expires.
      const expires = oldData.checkoutExpiresAt || Math.floor((Date.now() + (r.hold_expires_at - rt.clock.now()) - 60_000) / 1000);
      const integration = oldData.integrationIdentifier || process.env.STRIPE_INTEGRATION_IDENTIFIER || `odas_mvp_${digest(id).slice(0, 8).replace(/[0-9]/g, n => String.fromCharCode(97 + Number(n)))}`;
      r = update(r, { status: 'checkout_pending', data: JSON.stringify({ ...oldData, workflow: 'checkout_creating', checkoutExpiresAt: expires, integrationIdentifier: integration }) });
      const metadata = { booking_id: id, user_id: user.id, quote_id: r.quote_id, room_id: r.original_room_id, start_at: String(r.start_at), end_at: String(r.end_at), namespace: rt.config.namespace };
      const office = await rt.services.catalog.office(r.room_id, { startAt: r.start_at, endAt: r.end_at });
      const session = await provider().checkout.sessions.create({
        mode: 'payment', ui_mode: 'hosted_page', submit_type: 'book',
        integration_identifier: integration,
        client_reference_id: id, customer_email: user.email, metadata,
        payment_intent_data: { metadata },
        line_items: [
          { price_data: { currency: r.currency, unit_amount: r.subtotal_cents, product_data: { name: `${office.name} reservation`, description: `${office.workspace?.name || 'ODAS office'} · ${(r.end_at - r.start_at) / 3_600_000} hours` } }, quantity: 1 },
          { price_data: { currency: r.currency, unit_amount: r.fee_cents, product_data: { name: 'ODAS service fee (10%)' } }, quantity: 1 },
        ],
        custom_text: { submit: { message: String(parseJSON<Row>(r.data, {}).cancellationPolicy || POLICY(rt)).slice(0, 1200) } },
        expires_at: expires,
        success_url: `${rt.config.origin}/reservations/${id}?checkout=returned`,
        cancel_url: `${rt.config.origin}/reservations/${id}?checkout=canceled`,
      }, { idempotencyKey: `${id}:checkout:v1` });
      if (session.livemode) fail(502, 'Live Checkout is disabled for this MVP.', 'live_mode_disabled');
      if (!session.url) fail(502, 'Stripe did not return a Checkout address.', 'checkout_unavailable');
      r = update(row(id), { checkout_session_id: session.id, checkout_url: session.url, data: JSON.stringify({ ...parseJSON<Row>(row(id).data, {}), workflow: 'checkout_open' }) });
      audit(rt, user.id, 'checkout.created', id, { sessionId: session.id });
      return { url: session.url, reservation: await asReservation(r) };
    });
  }

  async function releaseInventory(r: Row): Promise<Row> {
    const data = parseJSON<Row>(r.data, {});
    if (!data.cancelInventoryPending) return r;
    await command(r.room_id, { id: `${r.id}:release:${r.room_id}`, type: 'cancel', bookingId: r.id, now: rt.clock.now() });
    const swap = db.query('SELECT * FROM swaps WHERE booking_id=? AND stage NOT IN (\'complete\',\'failed\')').get(r.id) as Row | null;
    if (swap) {
      await command(swap.from_room_id, { id: `${r.id}:release:${swap.from_room_id}`, type: 'cancel', bookingId: r.id, now: rt.clock.now() });
      await command(swap.to_room_id, { id: `${r.id}:release:${swap.to_room_id}`, type: 'cancel', bookingId: r.id, now: rt.clock.now() });
      db.query('UPDATE swaps SET stage=\'failed\',error=\'Reservation canceled\',updated_at=? WHERE id=?').run(rt.clock.now(), swap.id);
    }
    return update(row(r.id), { data: JSON.stringify({ ...parseJSON<Row>(row(r.id).data, {}), cancelInventoryPending: false }) });
  }

  async function requestRefund(r: Row, reason: string, amountCents = r.total_cents): Promise<Row> {
    if (!r.payment_intent_id) return r;
    const now = rt.clock.now();
    const refundId = `refund_${r.id}`;
    db.query('INSERT OR IGNORE INTO refunds(id,booking_id,status,reason,amount_cents,data,created_at,updated_at) VALUES(?,?,\'requested\',?,?,\'{}\',?,?)')
      .run(refundId, r.id, reason, amountCents, now, now);
    let ref = db.query('SELECT * FROM refunds WHERE booking_id=?').get(r.id) as Row;
    if (ref.status === 'succeeded') return r.refund_status === 'succeeded' ? r : update(r, { refund_status: 'succeeded' });
    if (!stripe) return update(r, { refund_status: 'requested' });
    if (r.refund_status !== 'requested' && r.refund_status !== 'pending') r = update(r, { refund_status: 'requested' });
    try {
      const refund = ref.stripe_refund_id ? await stripe.refunds.retrieve(ref.stripe_refund_id) : await stripe.refunds.create({ payment_intent: r.payment_intent_id, amount: ref.amount_cents, metadata: { booking_id: r.id, namespace: rt.config.namespace }, reason: 'requested_by_customer' }, { idempotencyKey: `${r.id}:full-refund:v1` });
      if (refund.status === 'failed' || refund.status === 'canceled') ref.status = 'failed';
      else ref.status = refund.status === 'succeeded' ? 'succeeded' : 'pending';
      db.query('UPDATE refunds SET stripe_refund_id=?,status=?,data=?,error=?,updated_at=? WHERE id=?').run(refund.id, ref.status, JSON.stringify({ providerStatus: refund.status }), refund.failure_reason || null, rt.clock.now(), ref.id);
      r = update(row(r.id), { refund_status: ref.status });
      if (ref.status === 'succeeded') notify(r, 'refund.succeeded', 'Your refund is complete', 'Stripe confirmed a full refund to your original payment method.');
      return r;
    } catch {
      // The same idempotency key resolves an uncertain response on reconciliation.
      db.query('UPDATE refunds SET status=\'failed\',error=\'Stripe refund request needs reconciliation\',updated_at=? WHERE id=?').run(rt.clock.now(), ref.id);
      return update(row(r.id), { refund_status: 'failed' });
    }
  }

  function validateSession(r: Row, session: Stripe.Checkout.Session): string | null {
    const m = session.metadata || {};
    if (session.livemode || session.mode !== 'payment') return 'Unexpected payment mode';
    if (session.id !== r.checkout_session_id || session.client_reference_id !== r.id) return 'Checkout identity mismatch';
    if (m.booking_id !== r.id || m.user_id !== r.user_id || m.quote_id !== r.quote_id || m.room_id !== r.original_room_id || m.start_at !== String(r.start_at) || m.end_at !== String(r.end_at) || m.namespace !== rt.config.namespace) return 'Checkout metadata mismatch';
    if (session.currency !== r.currency || session.amount_total !== r.total_cents) return 'Checkout currency or amount mismatch';
    return null;
  }

  async function fulfillUnlocked(sessionId: string): Promise<Row> {
    const session = await provider().checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
    if (session.livemode) fail(400, 'Live payments are disabled.', 'live_mode_disabled');
    let r = db.query('SELECT * FROM reservations WHERE checkout_session_id=?').get(sessionId) as Row | null;
    // Recover a process crash after Stripe creation but before the local session ID was saved.
    if (!r && session.metadata?.booking_id) {
      const candidate = db.query('SELECT * FROM reservations WHERE id=?').get(session.metadata.booking_id) as Row | null;
      if (candidate && !candidate.checkout_session_id && parseJSON<Row>(candidate.data, {}).workflow === 'checkout_creating' && session.client_reference_id === candidate.id && session.metadata.user_id === candidate.user_id && session.metadata.namespace === rt.config.namespace) {
        r = update(candidate, { checkout_session_id: sessionId, checkout_url: session.url });
      }
    }
    if (!r) fail(404, 'Checkout is not bound to an ODAS reservation.', 'unknown_checkout');
    const mismatch = validateSession(r, session);
    const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null;
    if (session.payment_status !== 'paid' || session.status !== 'complete') {
      if (r.payment_status === 'paid') return r;
      const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
      if (session.status === 'complete' && intent && ['canceled', 'requires_payment_method'].includes(intent.status)) {
        r = update(r, { status: r.status === 'canceled' ? 'canceled' : 'expired', payment_status: 'failed', data: JSON.stringify({ ...parseJSON<Row>(r.data, {}), cancelInventoryPending: true, workflow: 'payment_failed' }) });
        return releaseInventory(r);
      }
      if (session.status === 'expired') {
        r = update(r, { status: 'expired', payment_status: 'unpaid', data: JSON.stringify({ ...parseJSON<Row>(r.data, {}), cancelInventoryPending: true, workflow: 'expired' }) });
        return releaseInventory(r);
      }
      if (session.status === 'complete') return update(r, { status: ['canceled', 'expired'].includes(r.status) ? r.status : 'payment_pending', payment_status: 'pending' });
      return r;
    }
    if (!paymentIntent) fail(502, 'Paid Checkout has no payment reference. Reconciliation is required.', 'missing_payment_reference');
    if (r.payment_status !== 'paid' || r.payment_intent_id !== paymentIntent) r = update(r, { payment_status: 'paid', payment_intent_id: paymentIntent });
    if (mismatch || ['canceled', 'expired', 'unfulfillable'].includes(r.status)) {
      if (r.status !== 'canceled') r = update(r, { status: 'unfulfillable', data: JSON.stringify({ ...parseJSON<Row>(r.data, {}), paymentFailure: mismatch || 'Inventory hold ended before payment', cancelInventoryPending: true }) });
      r = await releaseInventory(r);
      return requestRefund(r, mismatch || 'Payment arrived after cancellation or inventory expiry', session.amount_total ?? r.total_cents);
    }
    if (ACTIVE.includes(r.status) || r.status === 'checked_out') return r;
    const confirmed = await rt.rooms.command(r.room_id, { id: `${r.id}:confirm`, type: 'confirm', bookingId: r.id, now: rt.clock.now() });
    if (!confirmed.ok) {
      r = update(r, { status: 'unfulfillable', data: JSON.stringify({ ...parseJSON<Row>(r.data, {}), paymentFailure: confirmed.code || 'Inventory unavailable', cancelInventoryPending: true }) });
      r = await releaseInventory(r);
      notify(r, 'booking.unfulfillable', 'We could not confirm this office', 'Your payment arrived after the office hold ended. We requested a full refund.');
      return requestRefund(r, 'Paid inventory cannot be fulfilled');
    }
    r = update(r, { status: 'confirmed', data: JSON.stringify({ ...parseJSON<Row>(r.data, {}), workflow: 'confirmed' }) });
    audit(rt, 'stripe', 'booking.fulfilled', r.id, { sessionId, paymentIntent });
    notify(r, 'booking.confirmed', 'Your office is reserved', 'Payment is confirmed. You can find arrival details in your reservation.');
    return r;
  }

  async function fulfillCheckout(sessionId: string): Promise<Reservation> {
    let r = db.query('SELECT * FROM reservations WHERE checkout_session_id=?').get(sessionId) as Row | null;
    if (!r) {
      const session = await provider().checkout.sessions.retrieve(sessionId);
      if (session.livemode || !session.metadata?.booking_id) fail(404, 'Unknown Checkout.', 'unknown_checkout');
      r = row(session.metadata.booking_id);
    }
    return withLease(`booking:${r.id}`, async () => asReservation(await fulfillUnlocked(sessionId)));
  }

  async function reconcile(user: User, id: string): Promise<Reservation> {
    const r = owned(user, id);
    if (!r.checkout_session_id) return asReservation(r);
    return fulfillCheckout(r.checkout_session_id);
  }

  async function cancel(user: User, id: string, reason?: string): Promise<Reservation> {
    return withLease(`booking:${id}`, async () => {
      let r = owned(user, id);
      const disruption = !!db.query('SELECT 1 FROM offers WHERE booking_id=?').get(id) || parseJSON<Row>(r.data, {}).serviceDisruption === true;
      if (r.status === 'checked_in' && !disruption || r.start_at <= rt.clock.now() && ACTIVE.includes(r.status) && !disruption) {
        r = update(r, { refund_status: 'review_required' });
        rt.db.query('INSERT OR IGNORE INTO attention_tasks(id,room_id,reason,status,created_at,data) VALUES(?,?,?,\'open\',?,?)').run(`cancellation-review:${id}`, r.room_id, 'Guest cancellation after reservation start requires operator review.', rt.clock.now(), JSON.stringify({ bookingId: id, guestReason: reason || null }));
        audit(rt, user.id, 'cancellation.review_requested', id, { reason });
        notify(r, 'cancellation.review', 'Cancellation needs review', 'An operator will review your request because the reservation has started.');
        return asReservation(r);
      }
      if (r.status === 'checked_out' && !disruption) fail(409, 'Completed reservations require operator review.', 'review_required');
      if (r.status !== 'canceled') r = update(r, { status: 'canceled', data: JSON.stringify({ ...parseJSON<Row>(r.data, {}), cancelInventoryPending: true, cancelReason: reason || 'Guest canceled', workflow: 'cancel_pending' }) });
      r = await releaseInventory(r);
      // Expiration and payment race safely: the local cancellation is already durable.
      if (r.checkout_session_id && stripe && r.payment_status !== 'paid') {
        try { await stripe.checkout.sessions.expire(r.checkout_session_id, {}, { idempotencyKey: `${r.id}:expire:v1` }); } catch { /* Completion may have won; retrieve authoritative status next. */ }
        r = await fulfillUnlocked(r.checkout_session_id);
      }
      if (r.payment_status === 'paid') r = await requestRefund(r, disruption ? 'Service disruption' : 'Guest canceled before start');
      audit(rt, user.id, 'booking.canceled', id, { reason, disruption });
      notify(r, 'booking.canceled', 'Reservation canceled', r.payment_status === 'paid' ? 'Your full refund has been requested. Its current status is shown with your reservation.' : 'Your office hold has been released.');
      return asReservation(r);
    });
  }

  async function checkIn(user: User, id: string): Promise<Reservation> {
    return withLease(`booking:${id}`, async () => {
      let r = owned(user, id);
      if (r.status === 'checked_in') return asReservation(r);
      if (r.status !== 'confirmed' || r.payment_status !== 'paid') fail(409, 'Only a paid, confirmed reservation can check in.', 'invalid_status');
      const windowMs = Number(rt.config.checkInWindowMinutes || 15) * 60_000;
      if (rt.clock.now() < r.start_at - windowMs || rt.clock.now() >= r.end_at) fail(409, `Check-in opens ${windowMs / 60_000} minutes before your reservation and closes when it ends.`, 'check_in_window');
      await command(r.room_id, { id: `${id}:check-in:${r.room_id}`, type: 'check_in', bookingId: id, now: rt.clock.now() });
      r = update(r, { status: 'checked_in' });
      audit(rt, user.id, 'booking.checked_in', id);
      return asReservation(r);
    });
  }

  async function checkOut(user: User, id: string): Promise<Reservation> {
    return withLease(`booking:${id}`, async () => {
      let r = owned(user, id);
      if (r.status === 'checked_out') return asReservation(r);
      if (!ACTIVE.includes(r.status)) fail(409, 'This reservation cannot check out.', 'invalid_status');
      if (r.status === 'confirmed' && rt.clock.now() < r.start_at) fail(409, 'Your visit has not started. Use cancellation to release an unused reservation.', 'visit_not_started');
      await command(r.room_id, { id: `${id}:check-out:${r.room_id}`, type: 'check_out', bookingId: id, now: rt.clock.now() });
      r = update(r, { status: 'checked_out' });
      audit(rt, user.id, 'booking.checked_out', id);
      // The actor's persisted inspection-requested event drives Relay and turnover. Checkout is never vacancy evidence.
      notify(r, 'booking.checked_out', 'You have checked out', 'We requested an office inspection. Thank you for leaving the room clear for the next guest.');
      return asReservation(r);
    });
  }

  function compatible(original: Office, candidate: Office): { match: boolean; equivalence: string; differences: string[] } {
    const ignored = new Set(['synthetic', 'syntheticFixture', 'source', 'verified', 'modeled', 'equivalenceClass']);
    const known = Object.entries(original.attributes).filter(([key, value]) => !ignored.has(key) && value !== null && value !== undefined && value !== 'unknown');
    const match = known.every(([key, value]) => JSON.stringify(candidate.attributes[key]) === JSON.stringify(value));
    const sameSynthetic = original.attributes.synthetic === true && candidate.attributes.synthetic === true && original.attributes.equivalenceClass && original.attributes.equivalenceClass === candidate.attributes.equivalenceClass;
    const syntheticFixture = original.attributes.syntheticFixture && original.attributes.syntheticFixture === candidate.attributes.syntheticFixture;
    const differences: string[] = [];
    if (original.groupId !== candidate.groupId) differences.push(`Different workspace: ${candidate.workspace?.name || candidate.groupId}.`);
    if (!known.length && !sameSynthetic && !syntheticFixture) differences.push('Capacity, amenities, dimensions, and room equivalence have not been verified.');
    if (original.rateCents !== candidate.rateCents) differences.push('The listed hourly rate differs; the amount you already paid stays the same.');
    const equivalence = sameSynthetic || syntheticFixture ? 'Synthetic test inventory with explicitly matching attributes.' : known.length && match ? 'The recorded room requirements match. Other property details may be unknown.' : 'Available alternative. Review the known details before accepting.';
    return { match, equivalence, differences };
  }

  async function replacementOffice(roomId: string, r: Row): Promise<Office> {
    // Recovery can happen after arrival. The original full interval remains the inventory obligation.
    const office = await rt.services.catalog.office(roomId, { startAt: r.start_at, endAt: r.end_at });
    const state = await rt.rooms.snapshot(roomId);
    const available = r.end_at > rt.clock.now() && !!office.workspace && isWithinHours(office.workspace, r.start_at, r.end_at)
      && await rt.rooms.available(roomId, r.start_at, r.end_at)
      && (rt.clock.now() < r.start_at || state.readiness === 'ready');
    return { ...office, available };
  }

  async function offerReplacement(bookingId: string, event?: DomainEvent): Promise<ReplacementOffer | null> {
    return withLease(`booking:${bookingId}`, async () => {
      let r = row(bookingId);
      if (!ACTIVE.includes(r.status)) return null;
      const state = await rt.rooms.snapshot(r.room_id);
      const blocked = state.blocks.some(block => block.startAt < r.end_at && block.endAt > r.start_at);
      const disrupted = state.operational !== 'available' || blocked || state.expectedReadyAt !== null && state.expectedReadyAt > r.start_at || state.readiness !== 'ready' && r.start_at <= rt.clock.now();
      if (!disrupted) return null;
      const existing = db.query('SELECT * FROM offers WHERE booking_id=? AND status=\'offered\' AND expires_at>? ORDER BY created_at DESC LIMIT 1').get(r.id, rt.clock.now()) as Row | null;
      if (existing) return asOffer(existing);
      r = update(r, { data: JSON.stringify({ ...parseJSON<Row>(r.data, {}), serviceDisruption: true, disruptionEventId: event?.id }) });
      const original = await rt.services.catalog.office(r.room_id, { startAt: r.start_at, endAt: r.end_at });
      const paidRate = quoteRow(r.quote_id).rate_cents;
      const officeIds = db.query('SELECT id FROM offices WHERE id<>?').all(r.room_id) as Row[];
      const candidates = (await Promise.all(officeIds.map(o => replacementOffice(o.id, r))))
        .filter(o => o.available && o.rateCents <= paidRate)
        .sort((a, b) => Number(b.groupId === r.group_id) - Number(a.groupId === r.group_id) || a.rateCents - b.rateCents || a.id.localeCompare(b.id));
      for (const office of candidates) {
        const comparison = compatible(original, office);
        if (!comparison.match) continue;
        const candidate = await rt.rooms.snapshot(office.id);
        if (candidate.operational !== 'available' || candidate.expectedReadyAt && candidate.expectedReadyAt > r.start_at) continue;
        const now = rt.clock.now();
        const id = event ? `offer_${digest(`${event.id}:${r.id}:${office.id}`).slice(0, 28)}` : uid('offer');
        const data = { ...comparison, fromRoomId: r.room_id, originalRateCents: original.rateCents, eventId: event?.id };
        db.query('INSERT OR IGNORE INTO offers(id,booking_id,room_id,status,expires_at,room_revision,data,created_at) VALUES(?,?,?,\'offered\',?,?,?,?)').run(id, r.id, office.id, now + OFFER_MS, candidate.revision, JSON.stringify(data), now);
        audit(rt, 'concierge', 'replacement.offered', r.id, { offerId: id, replacementRoomId: office.id });
        return { ...asOffer(db.query('SELECT * FROM offers WHERE id=?').get(id) as Row), office };
      }
      return null;
    });
  }

  async function resumeSwap(swap: Row): Promise<Row> {
    let r = row(swap.booking_id);
    if (swap.stage === 'complete') return r;
    if (['canceled', 'unfulfillable', 'expired'].includes(r.status)) return releaseInventory(r);
    const now = rt.clock.now();
    if (swap.stage === 'planned') {
      const offer = db.query('SELECT * FROM offers WHERE id=?').get(swap.offer_id) as Row;
      if (offer.expires_at <= now) fail(409, 'This replacement offer expired. Your original reservation is unchanged.', 'offer_expired');
      const replacement = await replacementOffice(swap.to_room_id, r);
      const original = await rt.services.catalog.office(swap.from_room_id, { startAt: r.start_at, endAt: r.end_at });
      if (!replacement.available || !compatible(original, replacement).match || replacement.rateCents > quoteRow(r.quote_id).rate_cents) fail(409, 'This replacement is no longer suitable or available. Your original reservation is unchanged.', 'offer_stale');
      const state = await rt.rooms.snapshot(swap.to_room_id);
      if (state.expectedReadyAt && state.expectedReadyAt > r.start_at) fail(409, 'The replacement is also delayed. Your original reservation is unchanged.', 'offer_stale');
      await command(swap.to_room_id, { id: `${swap.id}:hold`, type: 'hold', bookingId: r.id, startAt: r.start_at, endAt: r.end_at, expiresAt: now + HOLD_MS, now, expectedRevision: state.revision });
      db.query('UPDATE swaps SET stage=\'acquired\',revision=revision+1,updated_at=? WHERE id=? AND stage=\'planned\'').run(now, swap.id);
      swap = db.query('SELECT * FROM swaps WHERE id=?').get(swap.id) as Row;
    }
    if (swap.stage === 'acquired') {
      await command(swap.to_room_id, { id: `${swap.id}:confirm`, type: 'confirm', bookingId: r.id, now: rt.clock.now() });
      db.query('UPDATE swaps SET stage=\'replacement_confirmed\',revision=revision+1,updated_at=? WHERE id=? AND stage=\'acquired\'').run(rt.clock.now(), swap.id);
      swap = db.query('SELECT * FROM swaps WHERE id=?').get(swap.id) as Row;
    }
    if (swap.stage === 'replacement_confirmed') {
      r = row(r.id);
      if (r.room_id !== swap.from_room_id && r.room_id !== swap.to_room_id) fail(409, 'The reservation assignment changed. Operator recovery is required.', 'swap_conflict');
      const office = db.query('SELECT group_id FROM offices WHERE id=?').get(swap.to_room_id) as Row;
      db.transaction(() => {
        if (r.room_id !== swap.to_room_id) r = update(r, { room_id: swap.to_room_id, group_id: office.group_id });
        db.query('UPDATE swaps SET stage=\'assigned\',revision=revision+1,updated_at=? WHERE id=? AND stage=\'replacement_confirmed\'').run(rt.clock.now(), swap.id);
        db.query('UPDATE offers SET status=\'accepted\' WHERE id=?').run(swap.offer_id);
      })();
      swap = db.query('SELECT * FROM swaps WHERE id=?').get(swap.id) as Row;
    }
    if (swap.stage === 'assigned') {
      await command(swap.from_room_id, { id: `${swap.id}:release-original`, type: 'cancel', bookingId: r.id, now: rt.clock.now() });
      db.query('UPDATE swaps SET stage=\'complete\',revision=revision+1,error=NULL,updated_at=? WHERE id=? AND stage=\'assigned\'').run(rt.clock.now(), swap.id);
      r = row(r.id);
      audit(rt, r.user_id, 'replacement.accepted', r.id, { fromRoomId: swap.from_room_id, toRoomId: swap.to_room_id, publicBookingId: r.id, amountCents: r.total_cents });
      notify(r, 'booking.reassigned', 'Your replacement office is confirmed', 'Your booking reference, reservation time, and amount paid are unchanged. The new assignment appears in your reservation.');
    }
    return row(r.id);
  }

  async function acceptOffer(user: User, offerId: string): Promise<Reservation> {
    let offer = db.query('SELECT * FROM offers WHERE id=?').get(offerId) as Row | null;
    if (!offer) fail(404, 'Replacement offer not found.', 'not_found');
    owned(user, offer.booking_id);
    return withLease(`booking:${offer.booking_id}`, async () => {
      offer = db.query('SELECT * FROM offers WHERE id=?').get(offerId) as Row;
      let r = owned(user, offer.booking_id);
      let swap = db.query('SELECT * FROM swaps WHERE offer_id=?').get(offerId) as Row | null;
      if (swap?.offer_id === offerId && swap.stage === 'complete') return asReservation(r);
      if (!ACTIVE.includes(r.status)) fail(409, 'This reservation cannot change office.', 'invalid_status');
      if (offer.status !== 'offered' && !(swap?.offer_id === offerId && !['failed', 'complete'].includes(swap.stage))) fail(409, 'This offer is no longer open.', 'offer_closed');
      if (offer.expires_at <= rt.clock.now() && (!swap || swap.stage === 'planned')) {
        db.query('UPDATE offers SET status=\'expired\' WHERE id=? AND status=\'offered\'').run(offerId);
        fail(409, 'This replacement offer expired. Your original reservation is unchanged.', 'offer_expired');
      }
      const unfinished = db.query('SELECT id FROM swaps WHERE booking_id=? AND offer_id<>? AND stage NOT IN (\'complete\',\'failed\')').get(r.id, offerId);
      if (unfinished) fail(409, 'A room replacement is already in progress for this reservation.', 'swap_in_progress');
      if (!swap) {
        const fromRoom = parseJSON<Row>(offer.data, {}).fromRoomId;
        if (fromRoom && fromRoom !== r.room_id) fail(409, 'Your assignment changed after this offer was made.', 'offer_stale');
        const id = `swap_${offerId}`;
        const now = rt.clock.now();
        db.query('INSERT INTO swaps(id,booking_id,offer_id,from_room_id,to_room_id,stage,revision,data,created_at,updated_at) VALUES(?,?,?,?,?,\'planned\',0,\'{}\',?,?)').run(id, r.id, offerId, r.room_id, offer.room_id, now, now);
        swap = db.query('SELECT * FROM swaps WHERE id=?').get(id) as Row;
      }
      try { r = await resumeSwap(swap); }
      catch (error) {
        const current = db.query('SELECT * FROM swaps WHERE id=?').get(swap.id) as Row;
        // After a replacement is confirmed, keep the durable saga for retry rather than releasing either side speculatively.
        db.query('UPDATE swaps SET error=?,updated_at=? WHERE id=?').run(error instanceof Error ? error.message : 'Replacement needs recovery', rt.clock.now(), swap.id);
        if (current.stage === 'planned') {
          db.query('UPDATE offers SET status=\'failed\' WHERE id=?').run(offerId);
          db.query('UPDATE swaps SET stage=\'failed\' WHERE id=?').run(swap.id);
        }
        throw error;
      }
      return asReservation(r);
    });
  }

  async function declineOffer(user: User, offerId: string): Promise<Reservation> {
    const offer = db.query('SELECT * FROM offers WHERE id=?').get(offerId) as Row | null;
    if (!offer) fail(404, 'Replacement offer not found.', 'not_found');
    owned(user, offer.booking_id);
    return withLease(`booking:${offer.booking_id}`, async () => {
      const current = db.query('SELECT status FROM offers WHERE id=?').get(offerId) as Row;
      if (current.status === 'accepted' || db.query('SELECT 1 FROM swaps WHERE offer_id=? AND stage NOT IN (\'complete\',\'failed\')').get(offerId)) fail(409, 'The replacement has already been accepted.', 'offer_closed');
      db.query('UPDATE offers SET status=\'declined\' WHERE id=? AND status=\'offered\'').run(offerId);
      audit(rt, user.id, 'replacement.declined', offer.booking_id, { offerId });
      return asReservation(owned(user, offer.booking_id));
    });
  }

  async function handleWebhook(body: string, signature: string): Promise<void> {
    if (!rt.config.stripeWebhookSecret) fail(503, 'Stripe webhook signing is not configured.', 'webhook_not_configured');
    let event: Stripe.Event;
    try { event = await provider().webhooks.constructEventAsync(body, signature, rt.config.stripeWebhookSecret); }
    catch { fail(400, 'Invalid Stripe webhook signature.', 'invalid_signature'); }
    if (event.livemode) fail(400, 'Live events are disabled.', 'live_mode_disabled');
    const prior = db.query('SELECT status FROM payment_events WHERE id=?').get(event.id) as Row | null;
    if (prior?.status === 'processed') return;
    const now = rt.clock.now();
    const obj = event.data.object as any;
    db.query('INSERT OR IGNORE INTO payment_events(id,type,session_id,status,data,created_at,updated_at) VALUES(?,?,?,\'pending\',?,?,?)').run(event.id, event.type, obj.object === 'checkout.session' ? obj.id : null, JSON.stringify({ objectId: obj.id }), now, now);
    try {
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired', 'checkout.session.async_payment_failed'].includes(event.type)) {
        await fulfillCheckout(obj.id);
      } else if (['refund.created', 'refund.updated', 'refund.failed'].includes(event.type)) {
        const refund = await provider().refunds.retrieve(obj.id);
        const ref = db.query('SELECT * FROM refunds WHERE stripe_refund_id=?').get(refund.id) as Row | null;
        if (ref) {
          await withLease(`booking:${ref.booking_id}`, async () => {
            const status = refund.status === 'succeeded' ? 'succeeded' : ['failed', 'canceled'].includes(refund.status || '') ? 'failed' : 'pending';
            db.query('UPDATE refunds SET status=?,error=?,updated_at=? WHERE id=?').run(status, refund.failure_reason || null, rt.clock.now(), ref.id);
            update(row(ref.booking_id), { refund_status: status });
          });
        }
      }
      db.query('UPDATE payment_events SET status=\'processed\',error=NULL,updated_at=? WHERE id=?').run(rt.clock.now(), event.id);
    } catch (error) {
      db.query('UPDATE payment_events SET status=\'failed\',error=?,updated_at=? WHERE id=?').run(error instanceof Error ? error.message : 'Webhook needs retry', rt.clock.now(), event.id);
      throw error;
    }
  }

  async function recover(): Promise<void> {
    db.query('UPDATE offers SET status=\'expired\' WHERE status=\'offered\' AND expires_at<=?').run(rt.clock.now());
    const pending = db.query(`SELECT * FROM reservations WHERE status IN ('held','checkout_pending','payment_pending','unfulfillable','canceled') OR refund_status IN ('requested','pending','failed')`).all() as Row[];
    for (const item of pending) {
      try {
        await withLease(`booking:${item.id}`, async () => {
          let r = row(item.id);
          const data = parseJSON<Row>(r.data, {});
          if (data.workflow === 'hold_pending') r = await resumeHold(r);
          if (data.cancelInventoryPending) r = await releaseInventory(r);
          if (r.checkout_session_id && stripe && (!ACTIVE.includes(r.status) || r.refund_status !== 'none')) r = await fulfillUnlocked(r.checkout_session_id);
          if (!r.checkout_session_id && ['held', 'checkout_pending'].includes(r.status) && r.hold_expires_at <= rt.clock.now()) {
            r = update(r, { status: 'expired', data: JSON.stringify({ ...parseJSON<Row>(r.data, {}), workflow: 'expired', cancelInventoryPending: true }) });
            r = await releaseInventory(r);
          }
          if (r.payment_status === 'paid' && ['canceled', 'unfulfillable'].includes(r.status) && r.refund_status !== 'succeeded') await requestRefund(r, 'Recover persisted cancellation/refund');
        });
      } catch (error) { audit(rt, 'reconciler', 'booking.recovery_pending', item.id, { message: error instanceof Error ? error.message : 'Retry needed' }); }
    }
    const swaps = db.query('SELECT * FROM swaps WHERE stage NOT IN (\'complete\',\'failed\')').all() as Row[];
    for (const swap of swaps) {
      try { await withLease(`booking:${swap.booking_id}`, async () => { await resumeSwap(swap); }); }
      catch (error) { db.query('UPDATE swaps SET error=?,updated_at=? WHERE id=?').run(error instanceof Error ? error.message : 'Retry needed', rt.clock.now(), swap.id); }
    }
  }

  return { quote, hold, checkout, get: async (user: User, id: string) => asReservation(owned(user, id)), list: async (user: User) => Promise.all((db.query('SELECT * FROM reservations WHERE user_id=? ORDER BY created_at DESC').all(user.id) as Row[]).map(asReservation)), cancel, reconcile, checkIn, checkOut, offerReplacement, acceptOffer, declineOffer, recover, handleWebhook, fulfillCheckout, stripeConfigured: !!stripe } satisfies CommerceService;
}

export type Commerce = ReturnType<typeof createCommerceService>;
