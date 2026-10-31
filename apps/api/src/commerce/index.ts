import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { CANCELLATION_POLICY, type User } from '@odas/contracts';
import { audit, currentUser, fail, requireUser, uid, type Runtime } from '../core';
import type { Commerce } from './service';
export { createCommerceService } from './service';

const email = z.string().trim().toLowerCase().email().max(254);
const credentials = z.object({ email, password: z.string().min(1).max(200) });
const signup = credentials.extend({ name: z.string().trim().min(1).max(100), password: z.string().min(12, 'Use at least 12 characters for your password.').max(200) }).strict();
const sha = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try { value = await c.req.json(); } catch { return fail(400, 'Send a valid JSON request.', 'invalid_json'); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(400, parsed.error.issues[0]?.message || 'Check the submitted information.', 'invalid_input');
  return parsed.data;
}

export function createCommerceRoutes(rt: Runtime) {
  const app = new Hono();
  const service = () => rt.services.commerce as Commerce;
  const dummyHash = Bun.password.hash('odas-dummy-password-verification-only', { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
  const secure = rt.config.origin.startsWith('https://');
  const cookieOptions = { path: '/', sameSite: 'Lax' as const, secure, maxAge: 30 * 86400 };

  function rateLimit(address: string, action: string) {
    const key = `auth:${action}:${sha(address)}`;
    const now = rt.clock.now();
    rt.db.query('INSERT INTO auth_attempts(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END')
      .run(key, now + 15 * 60_000, now, now, now + 15 * 60_000);
    const row = rt.db.query('SELECT count FROM auth_attempts WHERE key=?').get(key) as any;
    if (row.count > 12) fail(429, 'Too many sign-in attempts. Please try again in 15 minutes.', 'rate_limited');
  }

  function session(c: Context, user: User) {
    const prior = getCookie(c, 'odas_session');
    if (prior) rt.db.query('DELETE FROM sessions WHERE id_hash=?').run(sha(prior));
    const token = random();
    const csrfToken = random();
    const now = rt.clock.now();
    rt.db.query('INSERT INTO sessions(id_hash,user_id,expires_at,csrf_token,created_at) VALUES(?,?,?,?,?)').run(sha(token), user.id, now + 30 * 86400_000, csrfToken, now);
    setCookie(c, 'odas_session', token, { ...cookieOptions, httpOnly: true });
    setCookie(c, 'odas_csrf', csrfToken, { ...cookieOptions, httpOnly: false });
    return { user, csrfToken };
  }

  app.get('/auth/session', async c => {
    c.header('Cache-Control', 'no-store');
    const user = await currentUser(c, rt);
    let csrfToken: string;
    if (user) {
      const token = getCookie(c, 'odas_session')!;
      const record = rt.db.query('SELECT csrf_token FROM sessions WHERE id_hash=?').get(sha(token)) as any;
      csrfToken = record.csrf_token;
      setCookie(c, 'odas_csrf', csrfToken, { ...cookieOptions, httpOnly: false });
    } else {
      csrfToken = getCookie(c, 'odas_csrf') || random();
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(csrfToken)) csrfToken = random();
      setCookie(c, 'odas_csrf', csrfToken, { ...cookieOptions, httpOnly: false });
    }
    const hostListings = user?.role === 'operator' ? (rt.db.query('SELECT COUNT(*) AS count FROM offices o JOIN operator_scopes s ON s.group_id=o.group_id WHERE s.user_id=?').get(user.id) as { count: number }).count : 0;
    return c.json({ user, hostListings, csrfToken, cancellationPolicy: String(rt.config.cancellationPolicy || CANCELLATION_POLICY), paymentMode: 'sandbox', stripeConfigured: !!rt.config.stripeSecretKey });
  });

  app.post('/auth/signup', async c => {
    const input = await body(c, signup);
    rateLimit(input.email, 'signup');
    const existing = rt.db.query('SELECT 1 FROM users WHERE email=?').get(input.email);
    if (existing) fail(409, 'An account already uses this email. Try signing in.', 'email_registered');
    const passwordHash = await Bun.password.hash(input.password, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
    const user: User = { id: uid('user'), email: input.email, name: input.name, role: 'guest', testAccount: false };
    try {
      rt.db.query('INSERT INTO users(id,email,password_hash,name,role,test_account,created_at) VALUES(?,?,?,?,\'guest\',0,?)').run(user.id, user.email, passwordHash, user.name, rt.clock.now());
    } catch { fail(409, 'An account already uses this email. Try signing in.', 'email_registered'); }
    audit(rt, user.id, 'account.created', user.id);
    return c.json(session(c, user), 201);
  });

  app.post('/auth/login', async c => {
    const input = await body(c, credentials);
    rateLimit(input.email, 'login');
    const row = rt.db.query('SELECT * FROM users WHERE email=?').get(input.email) as any;
    const correct = await Bun.password.verify(input.password, row?.password_hash || await dummyHash);
    if (!row || !correct) fail(401, 'The email or password is incorrect.', 'invalid_credentials');
    const user: User = { id: row.id, email: row.email, name: row.name, role: row.role, testAccount: !!row.test_account };
    rt.db.query('DELETE FROM auth_attempts WHERE key=?').run(`auth:login:${sha(input.email)}`);
    audit(rt, user.id, 'account.signed_in', user.id);
    return c.json(session(c, user));
  });

  app.post('/auth/logout', async c => {
    const token = getCookie(c, 'odas_session');
    if (token) rt.db.query('DELETE FROM sessions WHERE id_hash=?').run(sha(token));
    deleteCookie(c, 'odas_session', { path: '/', secure });
    const csrfToken = random();
    setCookie(c, 'odas_csrf', csrfToken, { ...cookieOptions, httpOnly: false });
    return c.json({ user: null, csrfToken });
  });

  app.post('/quotes', async c => {
    const user = await requireUser(c, rt);
    const input = await body(c, z.object({ roomId: z.string().min(1), startAt: z.number().int().positive(), endAt: z.number().int().positive() }));
    return c.json(await service().quote(user, input), 201);
  });
  app.post('/reservations', async c => {
    const user = await requireUser(c, rt);
    const input = await body(c, z.object({ quoteId: z.string().min(1), idempotencyKey: z.string().min(1).max(180).optional() }));
    return c.json(await service().hold(user, input.quoteId, input.idempotencyKey || c.req.header('Idempotency-Key')), 201);
  });
  app.get('/reservations', async c => c.json({ reservations: await service().list(await requireUser(c, rt)) }));
  app.get('/reservations/:id', async c => c.json(await service().get(await requireUser(c, rt), c.req.param('id'))));
  app.post('/reservations/:id/checkout', async c => c.json(await service().checkout(await requireUser(c, rt), c.req.param('id'))));
  app.post('/reservations/:id/reconcile', async c => c.json(await service().reconcile(await requireUser(c, rt), c.req.param('id'))));
  app.post('/reservations/:id/cancel', async c => {
    const user = await requireUser(c, rt);
    let reason: string | undefined;
    if (c.req.header('Content-Type')?.includes('application/json')) reason = (await body(c, z.object({ reason: z.string().max(1000).optional() }))).reason;
    return c.json(await service().cancel(user, c.req.param('id'), reason));
  });
  app.post('/reservations/:id/check-in', async c => c.json(await service().checkIn(await requireUser(c, rt), c.req.param('id'))));
  app.post('/reservations/:id/check-out', async c => c.json(await service().checkOut(await requireUser(c, rt), c.req.param('id'))));
  app.post('/offers/:id/accept', async c => c.json(await service().acceptOffer(await requireUser(c, rt), c.req.param('id'))));
  app.post('/offers/:id/decline', async c => c.json(await service().declineOffer(await requireUser(c, rt), c.req.param('id'))));
  app.post('/payments/webhook', async c => {
    const signature = c.req.header('Stripe-Signature');
    if (!signature) fail(400, 'Missing Stripe signature.', 'invalid_signature');
    await service().handleWebhook(await c.req.text(), signature);
    return c.json({ received: true });
  });
  return app;
}
