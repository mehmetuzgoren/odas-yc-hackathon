import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import type { DomainEvent, Reservation, User } from '@odas/contracts';

/**
 * Isolated acceptance fixture. Funding is explicitly synthetic; no Stripe payment is claimed.
 * Device observations, native inventory, Relay delivery, guest actions and restarts are real.
 * Run from the repository root: bun run test:scenario [--date YYYY-MM-DD]
 */
export async function runScenario() {
  const root = resolve('.');
  const run = crypto.randomUUID().slice(0, 8);
  const namespace = `test-scenario-${run}`;
  const dataDir = join(root, '.data', namespace);
  const ports = { api: 3012, actors: 7112, relay: 8792, device: 8092, web: 5182 };
  async function portOpen(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(350);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
  }
  for (const port of Object.values(ports)) if (await portOpen(port)) throw new Error(`Scenario port ${port} is already occupied. Stop its owner or use the isolated runner after it finishes. No existing process was stopped.`);
  const dateIndex = process.argv.indexOf('--date');
  const selectedDate = dateIndex >= 0 ? process.argv[dateIndex + 1] : process.env.SCENARIO_DATE || Temporal.Now.plainDateISO('America/Los_Angeles').add({ days: 1 }).toString();
  const at = (time: string) => Temporal.PlainDate.from(selectedDate).toPlainDateTime(Temporal.PlainTime.from(time)).toZonedDateTime('America/Los_Angeles', { disambiguation: 'reject' }).epochMilliseconds;
  let logicalNow = at('07:50');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const fixtureGroup = `scenario-${run}`;
  const roomA = `${fixtureGroup}-office-a`;
  const roomB = `${fixtureGroup}-office-b`;
  const bindingFile = join(dataDir, 'simulator-bindings.json');
  writeFileSync(bindingFile, JSON.stringify({ bindings: [roomA, roomB].map(roomId => ({ workspaceId: fixtureGroup, roomId, mode: 'simulator', note: 'Synthetic acceptance fixture, no physical hardware.' })), cameras: {} }, null, 2));
  const actorSecret = crypto.randomUUID() + crypto.randomUUID();
  const internalToken = crypto.randomUUID() + crypto.randomUUID();
  const origin = `http://127.0.0.1:${ports.web}`;
  const base = `http://127.0.0.1:${ports.api}`;
  const actorProject = `odas-${namespace}`;
  // Override inherited development endpoints and credentials before importing application modules.
  Object.assign(process.env, {
    DATA_DIR: dataDir, ODAS_NAMESPACE: namespace, ODAS_TEST_MODE: '1', ODAS_TEST_NOW: String(logicalNow),
    APP_ORIGIN: origin, API_PORT: String(ports.api), API_HOST: '127.0.0.1', API_BASE_URL: base, API_INTERNAL_URL: base,
    WEB_PORT: String(ports.web), WEB_HOST: '127.0.0.1',
    ACTOR_PORT: String(ports.actors), ACTOR_PROJECT_ID: actorProject,
    TERSE_ACTOR_URL: `http://127.0.0.1:${ports.actors}/v1/projects/${actorProject}/actors`, TERSE_ACTOR_SECRET: actorSecret, TERSE_API_KEY: actorSecret,
    RELAY_PORT: String(ports.relay), RELAY_BASE_URL: `http://127.0.0.1:${ports.relay}`, RELAYCAST_BASE_URL: `http://127.0.0.1:${ports.relay}`,
    RELAY_EXTERNAL: '', RELAY_WORKSPACE_KEY: '',
    DEVICE_PORT: String(ports.device), DEVICE_HOST: '127.0.0.1', DEVICE_URL: `http://127.0.0.1:${ports.device}`, DEVICE_MODE: 'simulator', DEVICE_BINDINGS_FILE: bindingFile,
    INTERNAL_TOKEN: internalToken, ODAS_INTERNAL_TOKEN: internalToken, CONCIERGE_MODE: 'rules',
    CLEANING_ESTIMATE_MINUTES: '10', REPLACEMENT_OFFER_MINUTES: '1', CHECK_IN_WINDOW_MINUTES: '15', TURNOVER_BUFFER_MINUTES: '15',
  });
  function clock(value: number) {
    assert.ok(value >= logicalNow, 'Fixture time must move forward.');
    logicalNow = value;
    const temporary = join(dataDir, 'clock.json.tmp');
    writeFileSync(temporary, JSON.stringify({ now: value }));
    renameSync(temporary, join(dataDir, 'clock.json'));
  }
  clock(logicalNow);
  const { openDatabase } = await import('../apps/api/src/db');
  const db = await openDatabase(dataDir);
  await db.query('INSERT INTO workspace_groups(id,name,address,latitude,longitude,base_rate_cents,timezone,modeled,description,hours_json,attributes_json,access_instructions) VALUES(?,?,?,37.78157,-122.41898,500,\'America/Los_Angeles\',1,?,?,?,?)')
    .run(fixtureGroup, 'Synthetic recovery fixture', 'Isolated test inventory, not a live property', 'Synthetic equivalent Office A/B acceptance inventory.', JSON.stringify({ open: '08:00', close: '20:00', days: [1, 2, 3, 4, 5, 6, 7], modeled: true }), JSON.stringify({ synthetic: true }), 'Synthetic test access instructions. No real door or property access is provided.');
  for (const [id, name] of [[roomA, 'Office A'], [roomB, 'Office B']]) await db.query('INSERT INTO offices(id,group_id,name,description,attributes_json,device_binding_json) VALUES(?,?,?,?,?,?)').run(id, fixtureGroup, name, 'Synthetic equivalent fixture: one desk, one-person capacity, same modeled rate.', JSON.stringify({ synthetic: true, equivalenceClass: '10am-recovery', capacity: 1, desk: true }), JSON.stringify({ mode: 'simulator' }));
  const operatorEmail = `operator-${run}@example.test`;
  const operatorPassword = `Fixture!${crypto.randomUUID()}`;
  const operatorId = `scenario-operator-${run}`;
  const operatorHash = await Bun.password.hash(operatorPassword, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
  await db.query('INSERT INTO users(id,email,password_hash,name,role,test_account,created_at) VALUES(?,?,?,?,\'operator\',1,?)').run(operatorId, operatorEmail, operatorHash, 'Scoped scenario operator', logicalNow);
  await db.query('INSERT INTO operator_scopes(user_id,group_id) VALUES(?,?)').run(operatorId, fixtureGroup);
  writeFileSync(join(dataDir, 'fixture-accounts.json'), JSON.stringify({ operator: { email: operatorEmail, password: operatorPassword, scope: fixtureGroup } }, null, 2), { mode: 0o600 });
  const checks: string[] = [];
  const pass = (s: string) => { checks.push(s); console.log(`PASS ${s}`); };
  const logPath = join(dataDir, 'stack.log');
  let stack: ReturnType<typeof Bun.spawn> | null = null;
  let stackFailure: string | null = null;
  let stopping = false;
  const stackPids: number[] = [];
  async function log(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader(); const decoder = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; appendFileSync(logPath, decoder.decode(value, { stream: true }), { mode: 0o600 }); }
  }
  async function waitFor<T>(name: string, fn: () => Promise<T | false> | T | false, timeout = 90_000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (stackFailure) throw new Error(stackFailure);
      const value = await fn();
      if (value !== false) return value as T;
      await Bun.sleep(250);
    }
    throw new Error(`Timed out waiting for ${name}. Stack log: ${logPath}`);
  }
  async function startStack() {
    stopping = false; stackFailure = null;
    stack = Bun.spawn(['bun', 'scripts/dev.ts'], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', detached: true });
    stackPids.push(stack.pid);
    void log(stack.stdout as ReadableStream<Uint8Array>); void log(stack.stderr as ReadableStream<Uint8Array>);
    const child = stack;
    void child.exited.then(code => { if (!stopping) stackFailure = `Scenario supervisor exited (${code}). Inspect ${logPath}`; });
    await waitFor('isolated full stack health', async () => {
      try { const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) }); return response.ok && (await response.json() as any).namespace === namespace || false; }
      catch { return false; }
    }, 120_000);
  }
  async function stopStack() {
    if (!stack) return;
    stopping = true;
    const child = stack;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    for (const port of Object.values(ports)) await waitFor(`owned port ${port} to close`, async () => !(await portOpen(port)), 15_000);
    stack = null;
  }
  const signal = () => { void stopStack().finally(() => process.exit(130)); };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);

  class Guest {
    cookies = new Map<string, string>(); csrf = ''; user: User | null = null;
    headers() { return { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), Origin: origin, 'X-CSRF-Token': this.csrf, 'Content-Type': 'application/json' }; }
    async request<T = any>(path: string, input?: unknown, method = input === undefined ? 'GET' : 'POST'): Promise<T> {
      if (method !== 'GET' && !this.csrf) await this.request('/auth/session');
      const response = await fetch(`${base}/api${path}`, { method, headers: this.headers(), ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(30_000) });
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const i = pair.indexOf('='); this.cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
      const value = await response.json() as any;
      if (value.csrfToken) this.csrf = value.csrfToken;
      if ('user' in value) this.user = value.user;
      if (!response.ok) throw Object.assign(new Error(`${response.status} ${value.error || path}`), { status: response.status, code: value.code });
      return value;
    }
  }
  const guest = new Guest(); const previous = new Guest(); const operator = new Guest();
  const privateRequest = async (path: string, value: unknown) => {
    const response = await fetch(`${base}/api/internal${path}`, { method: 'POST', headers: { Authorization: `Bearer ${internalToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(30_000) });
    const data = await response.json() as any; if (!response.ok) throw new Error(`${response.status} ${data.error || path}`); return data;
  };
  let guestStreamAbort: AbortController | null = null;
  let runtime: Awaited<ReturnType<typeof import('../apps/api/src/index')['createApp']>>['runtime'] | null = null;
  try {
    console.log(`Running ${selectedDate} 10am to 12pm America/Los_Angeles acceptance fixture in ${namespace}.`);
    console.log('Funding bootstrap is synthetic and labeled in fixture records. This command never charges or claims a Stripe payment.');
    await startStack();
    await guest.request('/auth/signup', { name: 'Arriving fixture guest', email: `arriving-${run}@example.test`, password: `Fixture!${crypto.randomUUID()}` });
    await previous.request('/auth/signup', { name: 'Previous fixture guest', email: `previous-${run}@example.test`, password: `Fixture!${crypto.randomUUID()}` });
    await operator.request('/auth/login', { email: operatorEmail, password: operatorPassword });
    for (const roomId of [roomA, roomB]) {
      const initialControls = await operator.request(`/operator/rooms/${roomId}/demo`);
      assert.equal(initialControls.jevEnabled, false); assert.equal(initialControls.roboEnabled, false);
      await assert.rejects(operator.request(`/operator/rooms/${roomId}/clean`, {}), (e: any) => e.status === 409 && e.code === 'robo_disabled');
      await operator.request(`/operator/rooms/${roomId}/demo`, { roboEnabled: true }, 'PATCH');
    }
    await waitFor('both independently running Relay workers', async () => {
      const status = await guest.request('/concierge/status'); return status.workers.every((w: any) => w.connected) || false;
    });
    const { createApp } = await import('../apps/api/src/index');
    runtime = (await createApp()).runtime;
    async function bootstrap(user: User, startAt: number, endAt: number) {
      const quote = await runtime!.services.commerce.quote(user, { roomId: roomA, startAt, endAt });
      const booking = await runtime!.services.commerce.hold(user, quote.id);
      const confirmed = await runtime!.rooms.command(roomA, { id: `${booking.id}:synthetic-fixture-confirm`, type: 'confirm', bookingId: booking.id, now: logicalNow });
      assert.ok(confirmed.ok, confirmed.message);
      await db.query('UPDATE reservations SET status=\'confirmed\',payment_status=\'paid\',revision=revision+1,data=json_set(data,\'$.syntheticPaymentFixture\',1,\'$.fundingSource\',\'isolated acceptance bootstrap; no Stripe charge\') WHERE id=?').run(booking.id);
      return runtime!.services.commerce.get(user, booking.id);
    }
    const previousBooking = await bootstrap(previous.user!, at('08:00'), at('09:45'));
    const booking = await bootstrap(guest.user!, at('10:00'), at('12:00'));
    assert.equal(booking.startAt - previousBooking.endAt, 15 * 60_000);
    const missingCsrfHeaders = guest.headers(); delete (missingCsrfHeaders as Partial<ReturnType<Guest['headers']>>)['X-CSRF-Token'];
    const missingCsrf = await fetch(`${base}/api/reservations/${booking.id}/check-in`, { method: 'POST', headers: missingCsrfHeaders, body: '{}' });
    assert.equal(missingCsrf.status, 403); assert.equal((await missingCsrf.json() as any).code, 'invalid_csrf');
    const wrongOrigin = await fetch(`${base}/api/reservations/${booking.id}/check-in`, { method: 'POST', headers: { ...guest.headers(), Origin: 'https://another-origin.example.test' }, body: '{}' });
    assert.equal(wrongOrigin.status, 403); assert.equal((await wrongOrigin.json() as any).code, 'invalid_origin');
    await assert.rejects(guest.request('/operator/rooms'), (e: any) => e.status === 403);
    await assert.rejects(guest.request(`/operator/rooms/${roomA}/frame`), (e: any) => e.status === 403);
    await assert.rejects(previous.request(`/reservations/${booking.id}`), (e: any) => e.status === 404);
    await assert.rejects(operator.request('/operator/rooms/polk-310-office-01'), (e: any) => e.status === 403);
    pass('real HTTP origin/CSRF gates, guest/operator separation, private camera access, cross-guest ownership and operator workspace scope');
    await operator.request(`/operator/rooms/${roomA}/inspect`, {});
    await waitFor('initial room readiness', async () => (await guest.request<Reservation>(`/reservations/${booking.id}`)).roomState?.readiness === 'ready' || false);
    await previous.request(`/reservations/${previousBooking.id}/check-in`, {});
    pass('normal accounts and quote/hold/native confirmation produce the 9:45 end and 10am to 12pm reservations; funding is explicitly synthetic');

    clock(at('09:45'));
    await privateRequest(`/simulator/${roomA}`, { occupancy: 'occupied', floor: 'dirty', surfaces: 'clear', state: 'docked' });
    await operator.request(`/operator/rooms/${roomA}/inspect`, {});
    assert.equal((await operator.request(`/operator/rooms/${roomA}`)).state.occupancy, 'occupied');
    assert.equal((await previous.request(`/reservations/${previousBooking.id}`)).status, 'checked_in');
    assert.equal((await operator.request(`/operator/rooms/${roomA}`)).state.job, null);
    pass('previous guest remains present at 9:45; scheduled end does not authorize a clean');

    guestStreamAbort = new AbortController();
    const streamAbort = guestStreamAbort;
    const sse = (async () => {
      const deadline = Date.now() + 90_000;
      let cursor = '0:0';
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${base}/api/events`, { headers: { ...guest.headers(), 'Last-Event-ID': cursor }, signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) });
          assert.equal(response.status, 200); const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            buffer += decoder.decode(value, { stream: true }); let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              cursor = event.split('\n').find(l => l.startsWith('id: '))?.slice(4) || cursor;
              if (!event.includes('event: notification')) continue;
              const data = event.split('\n').find(l => l.startsWith('data: ')); if (!data) continue;
              const notification = JSON.parse(data.slice(6));
              if (notification.bookingId === booking.id && notification.type === 'readiness_disruption') return { notification, cursor };
            }
          }
        } catch (error) { if (streamAbort.signal.aborted) throw error; }
        await Bun.sleep(300);
      }
      throw new Error('Disruption SSE timed out after reconnect attempts.');
    })();
    void sse.catch(() => {}); // Awaited below; prevent a transient rejection becoming unhandled while turnover runs.
    clock(at('09:55'));
    await privateRequest(`/simulator/${roomA}`, { occupancy: 'vacant', floor: 'dirty', surfaces: 'clear', confidence: 0.99, cleaningDurationMs: 10 * 60_000 });
    await previous.request(`/reservations/${previousBooking.id}/check-out`, {});
    await waitFor('observed robot motion through Relay operations', async () => (await operator.request(`/operator/rooms/${roomA}`)).state.job?.status === 'started' || false);
    const notification = await sse;
    streamAbort.abort();
    assert.equal(notification.notification.openConcierge, true);
    let detail = await guest.request<Reservation>(`/reservations/${booking.id}`);
    const firstOffer = detail.offers?.find(o => o.status === 'offered'); assert.ok(firstOffer);
    assert.equal(firstOffer.roomId, roomB); assert.match(firstOffer.equivalence, /Synthetic/);
    const stateAtDeparture = (await operator.request(`/operator/rooms/${roomA}`)).state;
    assert.equal(stateAtDeparture.expectedReadyAt, at('10:05'));
    const notificationRow = await db.query('SELECT * FROM notifications WHERE id=? AND user_id=?').get(notification.notification.id, guest.user!.id) as any;
    assert.ok(notificationRow);
    const conversationId = JSON.parse(notificationRow.data).conversationId;
    const conversationMessages = await guest.request(`/conversations/${conversationId}/messages`);
    assert.ok(conversationMessages.messages.some((m: any) => m.offer?.id === firstOffer.id));
    const relayRows = await db.query('SELECT * FROM outbox WHERE event_json LIKE ? AND relay_message_id IS NOT NULL').all(`%${roomA}%`) as any[];
    assert.ok(relayRows.some(o => JSON.parse(o.event_json).type === 'cleaning.requested'));
    assert.ok(await db.query('SELECT 1 FROM processed_messages WHERE worker=\'operations\' AND event_id IN (SELECT json_extract(event_json,\'$.id\') FROM outbox WHERE json_extract(event_json,\'$.type\')=\'cleaning.requested\') AND status=\'completed\'').get());
    pass('9:55 fresh vacancy → native actor/outbox → actual Relay workers → observed clean with 10:05 configured ETA → persisted guest notification and concierge offer over SSE');
    const agentMessages = await waitFor('state-change conversation through real Relay handlers', async () => {
      const { messages } = await operator.request(`/operator/rooms/${roomA}/conversation`);
      return messages.some((item: any) => item.source === 'Robo' && item.body.includes('I have started cleaning')) && messages.some((item: any) => item.source === 'Room agent' && item.target === 'Concierge' && item.body.startsWith('Not yet:')) ? messages : false;
    });
    assert.ok(agentMessages.some((item: any) => item.source === 'Room agent' && item.target === 'Robo'));
    pass('actual observations, actor cleaning requests, robot motion and concierge readiness decisions appear as scoped conversation messages');

    await guest.request(`/offers/${firstOffer.id}/decline`, {});
    assert.equal((await guest.request<Reservation>(`/reservations/${booking.id}`)).roomId, roomA);
    async function askForOffer(key: string) {
      await guest.request(`/conversations/${conversationId}/messages`, { content: 'Please find another replacement office for this reservation.', idempotencyKey: `scenario-${run}-${key}` });
      return waitFor('concierge replacement through the ordinary chat tool', async () => {
        const value = await guest.request<Reservation>(`/reservations/${booking.id}`); return value.offers?.find(o => o.status === 'offered') || false;
      });
    }
    const expiredOffer = await askForOffer('expires');
    // Expire naturally with a controlled clock, while maintaining fresh camera observations during the clean.
    const expireAt = expiredOffer.expiresAt + 1;
    while (logicalNow < expireAt) {
      clock(Math.min(logicalNow + 10_000, expireAt));
      await operator.request(`/operator/rooms/${roomA}/inspect`, {});
      await operator.request(`/operator/rooms/${roomB}/inspect`, {});
    }
    await assert.rejects(guest.request(`/offers/${expiredOffer.id}/accept`, {}), (e: any) => e.status === 409 && e.code === 'offer_expired');
    assert.equal((await guest.request<Reservation>(`/reservations/${booking.id}`)).roomId, roomA);
    const acceptedOffer = await askForOffer('accept');
    const accepted = await guest.request<Reservation>(`/offers/${acceptedOffer.id}/accept`, {});
    assert.equal(accepted.roomId, roomB); assert.equal(accepted.id, booking.id); assert.equal(accepted.startAt, booking.startAt); assert.equal(accepted.endAt, booking.endAt); assert.equal(accepted.totalCents, booking.totalCents);
    const actorA = (await operator.request(`/operator/rooms/${roomA}`)).state;
    const actorB = (await operator.request(`/operator/rooms/${roomB}`)).state;
    assert.equal(actorA.intervals.find((i: any) => i.bookingId === booking.id).status, 'canceled');
    assert.equal(actorB.intervals.find((i: any) => i.bookingId === booking.id).status, 'confirmed');
    pass('decline and natural offer expiry preserve Office A; explicit acceptance assigns real Office B inventory with unchanged public ID, interval, and amount');

    await waitFor('readiness event business acknowledgments', async () => {
      const pending = await db.query('SELECT count(*) AS n FROM outbox WHERE event_json LIKE ? AND status!=\'completed\'').get(`%${roomA}%`) as any; return pending.n === 0 || false;
    });
    const duplicate = await db.query('SELECT * FROM outbox WHERE target=\'concierge\' AND json_extract(event_json,\'$.type\')=\'room.readiness_delayed\' AND event_json LIKE ? ORDER BY created_at LIMIT 1').get(`%${roomA}%`) as any;
    assert.ok(duplicate);
    const beforeNotifications = (await db.query('SELECT count(*) AS n FROM notifications WHERE user_id=? AND type=\'readiness_disruption\'').get(guest.user!.id) as any).n;
    const beforePayments = (await db.query('SELECT count(*) AS n FROM reservations WHERE checkout_session_id IS NOT NULL').get() as any).n;
    const attempts = duplicate.attempts;
    await db.query('UPDATE outbox SET status=\'pending\',next_attempt_at=0 WHERE id=?').run(duplicate.id);
    await waitFor('real Relay duplicate redelivery and business result', async () => { const value = await db.query('SELECT status,attempts FROM outbox WHERE id=?').get(duplicate.id) as any; return value.status === 'completed' && value.attempts > attempts || false; });
    await guest.request(`/offers/${acceptedOffer.id}/accept`, {});
    assert.equal((await db.query('SELECT count(*) AS n FROM notifications WHERE user_id=? AND type=\'readiness_disruption\'').get(guest.user!.id) as any).n, beforeNotifications);
    assert.equal((await db.query('SELECT count(*) AS n FROM reservations WHERE checkout_session_id IS NOT NULL').get() as any).n, beforePayments);
    pass('actual Relay duplicate redelivery and repeated acceptance do not duplicate guest disruption, swap, or payment');

    const savedIdentities = JSON.parse(readFileSync(join(dataDir, 'relay-identities.json'), 'utf8'));
    const savedJob = (await operator.request(`/operator/rooms/${roomA}`)).state.job;
    const savedAgentMessages = (await operator.request(`/operator/rooms/${roomA}/conversation`)).messages;
    assert.equal(savedJob.status, 'started');
    await stopStack();
    const restartStartedAt = Date.now();
    await startStack();
    const reconnectedWorkers = await waitFor('fresh post-restart worker heartbeats', async () => {
      const health = await guest.request('/concierge/status');
      return health.workers.every((w: any) => w.connected && w.lastSeenAt >= restartStartedAt) ? health.workers : false;
    });
    const nextIdentities = JSON.parse(readFileSync(join(dataDir, 'relay-identities.json'), 'utf8'));
    assert.deepEqual(nextIdentities.agents, savedIdentities.agents);
    assert.notEqual(stackPids[0], stackPids[1]);
    // HTTP health can precede native storage lease handoff. Read retries do not replay a booking or physical command.
    const afterRestart = await waitFor('native actor storage ownership recovery', async () => {
      try { return await guest.request<Reservation>(`/reservations/${booking.id}`); }
      catch (error) { if ((error as any).status >= 500) return false; throw error; }
    });
    const restartedActor = await waitFor('persisted cleaning actor recovery', async () => {
      try { return (await operator.request(`/operator/rooms/${roomA}`)).state; }
      catch (error) { if ((error as any).status >= 500) return false; throw error; }
    });
    const actorRecoveredAt = Date.now();
    const resetControls = await operator.request(`/operator/rooms/${roomA}/demo`);
    assert.equal(resetControls.jevEnabled, false); assert.equal(resetControls.roboEnabled, false);
    assert.equal(afterRestart.id, booking.id); assert.equal(afterRestart.roomId, roomB); assert.equal(afterRestart.totalCents, booking.totalCents);
    assert.equal(restartedActor.job.id, savedJob.id); assert.equal(restartedActor.job.status, 'started'); assert.equal(restartedActor.expectedReadyAt, at('10:05'));
    const restoredAgentMessages = (await operator.request(`/operator/rooms/${roomA}/conversation`)).messages;
    assert.ok(savedAgentMessages.every((saved: any) => restoredAgentMessages.some((item: any) => item.id === saved.id && item.body === saved.body)));
    assert.equal((await db.query('SELECT count(*) AS n FROM notifications WHERE user_id=? AND type=\'readiness_disruption\'').get(guest.user!.id) as any).n, beforeNotifications);
    assert.equal((await db.query('SELECT count(*) AS n FROM reservations WHERE checkout_session_id IS NOT NULL').get() as any).n, beforePayments);
    pass('actual actor/API/device/Relay engine/workers restart preserves room job, real assignment, amount, durable sessions and Relay identities');

    const stoppedDemo = await operator.request(`/operator/rooms/${roomA}/demo`, { roboEnabled: false }, 'PATCH');
    assert.equal(stoppedDemo.roboEnabled, false);
    assert.equal(stoppedDemo.dockResult.accepted, true);
    assert.equal(stoppedDemo.state.job.status, 'interrupted');
    await assert.rejects(operator.request(`/operator/rooms/${roomA}/clean`, {}), (e: any) => e.status === 409 && e.code === 'robo_disabled');
    pass('Robo off interrupts the recovered cleaning job through the actual device adapter and rejects another cleaning start');

    const evidence = { namespace, dataDir, selectedDate, timezone: 'America/Los_Angeles', ports, bookingId: booking.id, previousBookingId: previousBooking.id, roomA, roomB, previousScheduledEnd: at('09:45'), actualDeparture: at('09:55'), expectedReady: at('10:05'), interval: { startAt: booking.startAt, endAt: booking.endAt }, amountCents: booking.totalCents, funding: 'syntheticPaymentFixture; no Stripe charge or real payment claimed', deviceEvidence: 'simulator through the real Python adapter/native actor/Agent Relay path', mode: 'development rules using real tools', checks, stackPids, restartStartedAt, actorRecoveredAt, reconnectedWorkers, status: 'passed' };
    writeFileSync(join(dataDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(`Acceptance scenario passed (${checks.length} checks). Evidence: ${join(dataDir, 'evidence.json')}`);
    return evidence;
  } catch (error) {
    console.error(`Scenario failed. Evidence and supervised stack log remain at ${dataDir}.`);
    throw error;
  } finally {
    guestStreamAbort?.abort();
    await stopStack();
    await runtime?.db.close(); await db.close();
    process.off('SIGINT', signal); process.off('SIGTERM', signal);
  }
}

if (import.meta.main) await runScenario();
