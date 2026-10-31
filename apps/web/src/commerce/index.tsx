import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CalendarDays, Clock3, CreditCard, DoorOpen, MapPin, MessageCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { CANCELLATION_POLICY, TIMEZONE, money, type Reservation, type ReplacementOffer } from '@odas/contracts';
import { api, useSession } from '../api';
import './commerce.css';

const time = (instant: number, zone = TIMEZONE) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(instant));
const date = (instant: number, zone = TIMEZONE) => new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(instant));
const label = (text: string) => text.replaceAll('_', ' ').replace(/^\w/, c => c.toUpperCase());
const message = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';

function SignInPrompt() {
  const location = useLocation();
  return <div className="commerce-empty card"><DoorOpen aria-hidden="true" size={32} /><h2>Your reservations are here</h2><p>Sign in to see your offices and arrival details.</p><Link className="button" to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}>Sign in <ArrowRight size={16} aria-hidden="true" /></Link></div>;
}

export function AuthPage() {
  const location = useLocation();
  const signup = location.pathname === '/signup';
  const [params] = useSearchParams();
  const proposed = params.get('returnTo') || '/reservations';
  const returnTo = proposed.startsWith('/') && !proposed.startsWith('//') && !proposed.includes('\\') ? proposed : '/reservations';
  const { user, refresh } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (user) void navigate(returnTo, { replace: true }); }, [user, navigate, returnTo]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(`/auth/${signup ? 'signup' : 'login'}`, { method: 'POST', body: JSON.stringify({ email, password, ...(signup ? { name } : {}) }) });
      await refresh();
      void navigate(returnTo, { replace: true });
    } catch (err) { setError(message(err)); requestAnimationFrame(() => errorRef.current?.focus()); }
    finally { setBusy(false); }
  }
  const alternate = `/${signup ? 'login' : 'signup'}?returnTo=${encodeURIComponent(returnTo)}`;
  return <main className="page container commerce-auth">
    <Link to="/" className="back-link"><ArrowLeft size={16} aria-hidden="true" /> Browse workspaces</Link>
    <div className="commerce-auth-layout">
      <section className="commerce-auth-intro"><p className="eyebrow">A place for your next hour</p><h1>{signup ? 'Make room for your work.' : 'Welcome back.'}</h1><p>{signup ? 'Create an account to reserve an office and keep your plans in one place.' : 'Your office, arrival details, and concierge are waiting here.'}</p><div className="commerce-auth-note"><ShieldCheck size={20} aria-hidden="true" /><span>Your reservations and conversations stay private to your account.</span></div></section>
      <form onSubmit={submit} className="card commerce-auth-form" aria-labelledby="auth-title">
        <h2 id="auth-title">{signup ? 'Create your account' : 'Sign in to ODAS'}</h2>
        {error && <div className="error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
        {signup && <label className="field">Your name<input name="name" autoComplete="name" required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>}
        <label className="field">Email address<input name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label className="field">Password<input name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 12 : undefined} maxLength={200} required value={password} onChange={e => setPassword(e.target.value)} aria-describedby={signup ? 'password-guidance' : undefined} />{signup && <small id="password-guidance">Use at least 12 characters.</small>}</label>
        <button className="button" type="submit" disabled={busy}>{busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'} {!busy && <ArrowRight size={16} aria-hidden="true" />}</button>
        <p className="commerce-auth-switch">{signup ? 'Already have an account?' : 'New to ODAS?'} <Link to={alternate}>{signup ? 'Sign in' : 'Create an account'}</Link></p>
      </form>
    </div>
  </main>;
}

export function ReservationsPage() {
  const { user, loading } = useSession();
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!user) { setPending(false); return; }
    setError(''); setPending(true);
    try { const data = await api<{ reservations: Reservation[] }>('/reservations'); setReservations(data.reservations); }
    catch (err) { setError(message(err)); }
    finally { setPending(false); }
  }, [user]);
  useEffect(() => { void load(); }, [load]);
  return <main className="page container commerce-reservations"><div className="commerce-title-row"><div><p className="eyebrow">Your time, reserved</p><h1>My reservations</h1></div><Link to="/" className="button secondary">Find an office <ArrowRight size={16} aria-hidden="true" /></Link></div>
    {loading || pending ? <p role="status">Loading your reservations…</p> : !user ? <SignInPrompt /> : error ? <div className="error" role="alert">{error} <button className="button secondary" onClick={() => void load()}>Try again</button></div> : !reservations.length ? <div className="commerce-empty card"><CalendarDays size={32} aria-hidden="true" /><h2>No reservations yet</h2><p>Choose a workspace and an office for the hours you need.</p><Link to="/" className="button">Browse workspaces <ArrowRight size={16} aria-hidden="true" /></Link></div> : <div className="commerce-reservation-list">{reservations.map(r => <article className="card commerce-reservation-card" key={r.id}><div className="commerce-reservation-symbol"><DoorOpen size={30} aria-hidden="true" /></div><div className="commerce-reservation-summary"><div className="commerce-title-row"><h2><Link to={`/reservations/${r.id}`}>{r.office?.name || r.roomId}</Link></h2><span className={`badge status-${r.status}`}>{label(r.status)}</span></div><p><MapPin size={15} aria-hidden="true" /> {r.workspace?.name || r.groupId}</p><p><CalendarDays size={15} aria-hidden="true" /> {date(r.startAt, r.workspace?.timezone)}</p><p><Clock3 size={15} aria-hidden="true" /> {time(r.startAt, r.workspace?.timezone)} to {time(r.endAt, r.workspace?.timezone)}</p></div><div className="commerce-reservation-price"><strong>{money(r.totalCents)}</strong><span>{label(r.paymentStatus)}</span><Link to={`/reservations/${r.id}`}>View reservation <ArrowRight size={15} aria-hidden="true" /></Link></div></article>)}</div>}
  </main>;
}

function ReplacementCard({ offer, busy, act }: { offer: ReplacementOffer; busy: boolean; act: (path: string) => Promise<void> }) {
  return <article className="commerce-offer" aria-labelledby={`offer-${offer.id}`}><p className="eyebrow">An office alternative</p><h3 id={`offer-${offer.id}`}>{offer.office?.name || offer.roomId}</h3><p>{offer.office?.workspace?.name}</p><p>{offer.equivalence}</p>{offer.differences.length > 0 && <ul>{offer.differences.map(d => <li key={d}>{d}</li>)}</ul>}<p className="muted">Your reservation time and amount paid stay the same. Offer expires {time(offer.expiresAt)}.</p><div className="commerce-action-row"><button className="button" disabled={busy} onClick={() => void act(`/offers/${offer.id}/accept`)}>Accept this office</button><button className="button secondary" disabled={busy} onClick={() => void act(`/offers/${offer.id}/decline`)}>Keep my current office</button></div></article>;
}

export function ReservationPage() {
  const { id = '' } = useParams();
  const { user, loading } = useSession();
  const [params] = useSearchParams();
  const [r, setReservation] = useState<Reservation | null>(null);
  const [pending, setPending] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    if (!user) { setPending(false); return; }
    try { setReservation(await api<Reservation>(`/reservations/${id}`)); }
    catch (err) { setError(message(err)); }
    finally { setPending(false); }
  }, [user, id]);
  useEffect(() => {
    void load();
    if (!user) return;
    const timer = window.setInterval(() => void load(), 15_000);
    const update = () => void load();
    window.addEventListener('odas:notification', update);
    return () => { window.clearInterval(timer); window.removeEventListener('odas:notification', update); };
  }, [load, user]);
  useEffect(() => {
    if (!user || !params.has('checkout')) return;
    // The redirect only starts reconciliation. The server verifies Checkout with Stripe.
    let disposed = false;
    async function reconcile() {
      for (let attempt = 0; attempt < 5 && !disposed; attempt++) {
        try {
          const data = await api<Reservation>(`/reservations/${id}/reconcile`, { method: 'POST' });
          if (!disposed) { setReservation(data); setError(''); setSuccess(data.paymentStatus === 'paid' ? 'Stripe confirmed your payment.' : 'Payment has not been confirmed. You can check again below.'); }
          return;
        } catch (err) {
          if ((err as { code?: string }).code === 'workflow_busy') {
            if (attempt < 4) { await new Promise(resolve => setTimeout(resolve, 350)); continue; }
            if (!disposed) setSuccess('Stripe verification continues in the background. The latest payment status appears below.');
          } else if (!disposed) setError(message(err));
          return;
        }
      }
    }
    void reconcile();
    return () => { disposed = true; };
  }, [user, id, params]);
  async function act(path: string) {
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api<Reservation | { url: string; reservation: Reservation }>(path, { method: 'POST', ...(path.endsWith('/cancel') ? { body: JSON.stringify({ reason: 'Guest requested cancellation' }) } : {}) });
      if ('url' in result) { window.location.assign(result.url); return; }
      setReservation(result); setConfirmCancel(false); setSuccess('Your reservation has been updated.');
      requestAnimationFrame(() => statusRef.current?.focus());
    } catch (err) { setError(message(err)); requestAnimationFrame(() => statusRef.current?.focus()); }
    finally { setBusy(false); }
  }
  const zone = r?.workspace?.timezone || TIMEZONE;
  const bookingQuery = r ? `?startAt=${r.startAt}&endAt=${r.endAt}` : '';
  return <main className="page container commerce-detail"><Link to="/reservations" className="back-link"><ArrowLeft size={16} aria-hidden="true" /> My reservations</Link>
    {loading || pending ? <p role="status">Loading your reservation…</p> : !user ? <SignInPrompt /> : !r ? <div className="error" role="alert">{error || 'Reservation not found.'}<button className="button secondary" onClick={() => void load()}>Try again</button></div> : <>
      <div className="commerce-title-row"><div><p className="eyebrow">Your ODAS reservation</p><h1>{r.office?.name || r.roomId}</h1><p><Link to={`/workspaces/${r.groupId}${bookingQuery}`}>{r.workspace?.name || r.groupId}</Link></p></div><span className={`badge status-${r.status}`}>{label(r.status)}</span></div>
      <div ref={statusRef} tabIndex={-1} aria-live="polite">{error && <p className="error" role="alert">{error}</p>}{success && <p className="success" role="status">{success}</p>}</div>
      <div className="commerce-detail-grid"><div className="commerce-detail-main">
        <section className="card"><h2>Your visit</h2><dl className="commerce-facts"><div><dt>Date</dt><dd>{date(r.startAt, zone)}</dd></div><div><dt>Time</dt><dd>{time(r.startAt, zone)} to {time(r.endAt, zone)}</dd></div><div><dt>Address</dt><dd>{r.workspace?.address || 'Not provided'}</dd></div><div><dt>Reference</dt><dd className="commerce-booking-id">{r.id}</dd></div></dl>{r.workspace?.modeled && <p className="muted commerce-small">Modeled inventory. Property details and access have not been verified as live supply.</p>}
          <div className="commerce-action-row">{r.status === 'confirmed' && <button className="button" disabled={busy || r.roomState?.readiness !== 'ready'} onClick={() => void act(`/reservations/${id}/check-in`)}>Check in <DoorOpen size={16} aria-hidden="true" /></button>}{['confirmed', 'checked_in'].includes(r.status) && <button className="button secondary" disabled={busy} onClick={() => void act(`/reservations/${id}/check-out`)}>Check out</button>}</div>
        </section>
        <section className="card"><h2>Office readiness</h2><p className={`commerce-readiness readiness-${r.roomState?.readiness}`}><span aria-hidden="true" className="commerce-status-dot" />{r.roomState?.readiness === 'ready' ? 'Ready for arrival' : r.roomState?.readiness === 'not_ready' ? 'The office is not ready yet' : 'Readiness is awaiting inspection'}</p>{r.roomState?.expectedReadyAt && <p>Expected ready at {time(r.roomState.expectedReadyAt, zone)}{r.roomState.job?.estimateSource === 'configured' ? ' (configured estimate)' : ''}.</p>}{r.roomState?.job && <p>Turnover: {label(r.roomState.job.status)}{r.roomState.job.reason ? `. ${r.roomState.job.reason}` : ''}</p>}<p className="muted commerce-small">{r.roomState?.inspection?.source === 'simulator' ? 'Inspection evidence comes from the development simulator.' : r.roomState?.inspection ? `Last captured ${time(r.roomState.inspection.capturedAt, zone)}. Inspection can be uncertain.` : 'No current inspection evidence is available.'}</p>{r.status === 'confirmed' && <p className="commerce-small">Check-in opens {r.checkInWindowMinutes ?? 15} minutes before your reservation. The room must be ready.</p>}</section>
        {r.offers?.filter(o => o.status === 'offered').map(offer => <ReplacementCard key={offer.id} offer={offer} busy={busy} act={act} />)}
        <section className="card"><h2>Arrival and access</h2><p className="commerce-access">{r.accessInstructions || (['confirmed', 'checked_in'].includes(r.status) ? 'Access instructions have not been provided. Please contact the concierge before arrival.' : 'Access instructions appear here after payment and confirmation, when provided by the operator.')}</p><button className="button secondary" onClick={() => window.dispatchEvent(new CustomEvent('odas:open-concierge', { detail: { bookingId: r.id } }))}><MessageCircle size={16} aria-hidden="true" /> Ask the concierge</button></section>
      </div><aside className="commerce-detail-aside"><section className="card commerce-payment"><h2>Reservation total</h2><dl className="commerce-facts"><div><dt>Office</dt><dd>{money(r.subtotalCents)}</dd></div><div><dt>Service fee (10%)</dt><dd>{money(r.feeCents)}</dd></div><div className="commerce-total"><dt>Total</dt><dd>{money(r.totalCents)}</dd></div><div><dt>Payment</dt><dd>{label(r.paymentStatus)}</dd></div><div><dt>Refund</dt><dd>{label(r.refundStatus)}</dd></div></dl><p className="commerce-small muted"><CreditCard size={15} aria-hidden="true" /> Stripe sandbox payments</p>
          {['held', 'checkout_pending'].includes(r.status) && r.paymentStatus !== 'paid' && <><p className="commerce-small">Hold expires {r.holdExpiresAt ? time(r.holdExpiresAt, zone) : 'soon'}. Payment is required for confirmation.</p><button className="button" disabled={busy} onClick={() => void act(`/reservations/${id}/checkout`)}>{busy ? 'Please wait…' : 'Continue to Checkout'} <ArrowRight size={16} aria-hidden="true" /></button></>}
          {r.checkoutSessionId && <button className="button secondary" disabled={busy} onClick={() => void act(`/reservations/${id}/reconcile`)}><RefreshCw size={15} aria-hidden="true" /> Check payment status</button>}
        </section><section className="commerce-policy"><h2>Cancellation policy</h2><p>{r.cancellationPolicy || CANCELLATION_POLICY}</p>{!['canceled', 'expired', 'unfulfillable', 'checked_out'].includes(r.status) && (confirmCancel ? <div className="commerce-cancel-confirm" role="group" aria-label="Confirm cancellation"><p>Cancel this reservation under the policy above?</p><div className="commerce-action-row"><button className="button danger" disabled={busy} onClick={() => void act(`/reservations/${id}/cancel`)}>Confirm cancellation</button><button className="button secondary" disabled={busy} onClick={() => setConfirmCancel(false)}>Keep reservation</button></div></div> : <button className="commerce-text-button" onClick={() => setConfirmCancel(true)}>Cancel reservation</button>)}</section></aside></div>
    </>}
  </main>;
}
