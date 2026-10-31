import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CalendarPlus, Check, LoaderCircle, MapPin, MessageCircle, RefreshCw } from 'lucide-react';
import { CANCELLATION_POLICY, TIMEZONE, money, type Reservation, type ReplacementOffer } from '@odas/contracts';
import { api } from '../api';
import { RequireAuth } from '../auth';
import { building, roomName, roomPhotos, roomTitle } from '../marketplace/listing';
import { dateLabel, durationLabel, instantClock, instantDate, instantRange, relativeDay, zonedParts, zonedNow } from '../marketplace/time';
import { EmptyState, ErrorState, Loading, Modal, Notice, Photo, Tabs, toast } from '../ui';

const ACTIVE = ['held', 'checkout_pending', 'payment_pending', 'confirmed', 'checked_in'];
const STATUS: Record<string, string> = { held: 'On hold', checkout_pending: 'Checkout started', payment_pending: 'Payment pending', confirmed: 'Confirmed', checked_in: 'Checked in', checked_out: 'Completed', canceled: 'Cancelled', expired: 'Expired', unfulfillable: 'Unable to fulfill' };
const STATUS_STYLE: Record<string, string> = { confirmed: 'border-forest/20 bg-mist text-forest', checked_in: 'border-forest bg-forest text-white', checked_out: 'border-stone-200 bg-stone-100 text-stone-700', canceled: 'border-red-200 bg-red-50 text-red-800', unfulfillable: 'border-red-200 bg-red-50 text-red-800' };
const PAYMENT: Record<string, string> = { paid: 'Paid', unpaid: 'Not paid', refunded: 'Refunded' };
const action = 'inline-flex h-9 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors disabled:opacity-50';
const message = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
const label = (text: string) => text.replaceAll('_', ' ').replace(/^\w/, c => c.toUpperCase());
const code = (r: Reservation) => r.id.slice(-8).toUpperCase();
const title = (r: Reservation) => r.workspace && r.office ? roomTitle(r.workspace, r.office.name) : r.office?.name || r.roomId;
const photoOf = (r: Reservation) => r.office ? roomPhotos(r.office)[0] : undefined;
const zoneOf = (r: Reservation) => r.workspace?.timezone || TIMEZONE;

function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status] || 'border-stone-200 bg-stone-100 text-stone-600'}`}>{STATUS[status] || label(status)}</span>;
}

function ReservationActions({ r, onChange, compact = false }: { r: Reservation; onChange: (next: Reservation) => void; compact?: boolean }) {
  const [busy, setBusy] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  async function run(path: string, done: string, body?: unknown) {
    setBusy(path);
    try { onChange(await api<Reservation>(`/reservations/${r.id}/${path}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })); toast(done); setConfirming(false); }
    catch (error) { toast(message(error), 'error'); }
    finally { setBusy(''); }
  }
  const opensAt = r.startAt - (r.checkInWindowMinutes ?? 15) * 60_000;
  const canCheckIn = r.status === 'confirmed' && now >= opensAt && now < r.endAt;
  const ready = r.roomState?.readiness === 'ready';
  const canCancel = !['canceled', 'expired', 'unfulfillable', 'checked_out'].includes(r.status);
  return <div className="flex flex-wrap items-center gap-2">
    {!compact && canCheckIn && <button disabled={!!busy || !ready} onClick={() => void run('check-in', 'Checked in — enjoy the room')} className={`${action} bg-forest text-white hover:bg-forest-dark`}>{busy === 'check-in' && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />} Check in</button>}
    {!compact && r.status === 'checked_in' && <button disabled={!!busy} onClick={() => void run('check-out', 'Checked out — thank you')} className={`${action} bg-stone-900 text-white hover:bg-stone-800`}>{busy === 'check-out' && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />} Check out</button>}
    {canCancel && <>
      <button disabled={!!busy} onClick={() => setConfirming(true)} className={compact ? 'text-sm font-medium text-stone-600 underline underline-offset-4 hover:text-red-700' : `${action} border border-stone-300 bg-white text-stone-800 hover:border-red-400 hover:text-red-700`}>Cancel</button>
      <Modal open={confirming} onClose={() => setConfirming(false)} title={`Cancel booking ${code(r)}?`} description={r.cancellationPolicy || CANCELLATION_POLICY}>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button disabled={!!busy} onClick={() => setConfirming(false)} className="h-9 rounded-lg border border-field px-4 text-sm font-medium shadow-xs hover:bg-mist hover:text-forest">Keep booking</button>
          <button disabled={!!busy} onClick={() => void run('cancel', 'Booking cancelled', { reason: 'Guest requested cancellation' })} className="h-9 rounded-lg bg-red-700 px-4 text-sm font-medium text-white shadow-sm hover:bg-red-800 disabled:opacity-50">Cancel booking</button>
        </div>
      </Modal>
    </>}
    {!compact && r.status === 'confirmed' && !canCheckIn && now < r.endAt && <span className="text-xs text-stone-500">Check-in opens at {instantClock(opensAt, zoneOf(r))}</span>}
    {!compact && canCheckIn && !ready && <span className="text-xs text-stone-500">Check-in opens once the room is ready.</span>}
  </div>;
}

function nextStatus(r: Reservation) {
  if (r.status === 'checked_in') return ['In use', 'bg-forest text-white'];
  if (!ACTIVE.slice(3).includes(r.status)) return ['On hold', 'bg-amber-100 text-amber-900'];
  return zonedParts(r.startAt, zoneOf(r)).date === zonedNow(zoneOf(r)).date ? ['Today', 'bg-amber-100 text-amber-900'] : ['Confirmed', 'border border-forest/20 bg-white text-forest'];
}

function NextBooking({ r, onChange }: { r: Reservation; onChange: () => void }) {
  const zone = zoneOf(r);
  const [text, style] = nextStatus(r);
  return <div className="rounded-xl bg-mist p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Link to={`/bookings/${r.id}`} className="font-semibold text-stone-900 hover:underline">{relativeDay(r.startAt, zone)} · {instantRange(r.startAt, r.endAt, zone)}</Link>
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${style}`}>{text}</span>
    </div>
    <p className="mt-1 text-sm text-stone-600">{r.status === 'checked_in' ? `Your room is yours until ${instantClock(r.endAt, zone)}` : r.status === 'confirmed' ? `Free cancellation until ${instantClock(r.startAt, zone)} ${instantDate(r.startAt, zone)}` : `Hold expires ${r.holdExpiresAt ? instantClock(r.holdExpiresAt, zone) : 'soon'}. Payment is required for confirmation.`}</p>
    <div className="mt-3"><ReservationActions r={r} onChange={onChange} /></div>
  </div>;
}

function RoomGroup({ items, onChange }: { items: Reservation[]; onChange: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [first, ...later] = items as [Reservation, ...Reservation[]];
  return <article className="fade-up overflow-hidden rounded-2xl border border-stone-200 bg-white">
    <div className="flex flex-col gap-4 p-4 sm:flex-row">
      <Link to={`/rooms/${first.roomId}`} className="shrink-0" aria-label={title(first)}><Photo src={photoOf(first)} className="h-32 w-full rounded-xl sm:w-44" /></Link>
      <div className="min-w-0 flex-1 space-y-3">
        <div>
          <Link to={`/rooms/${first.roomId}`} className="font-serif text-xl font-semibold text-stone-900 hover:underline">{title(first)}</Link>
          <p className="text-sm text-stone-500">{first.workspace ? building(first.workspace).neighborhood : 'San Francisco'} · {first.office ? money(first.office.rateCents) : ''}/hr · {items.length} upcoming</p>
        </div>
        <NextBooking r={first} onChange={onChange} />
      </div>
    </div>
    {later.length > 0 && <div className="border-t border-stone-100 px-4 pb-3">
      {expanded && <ul className="divide-y divide-stone-100">{later.map(r => <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
        <Link to={`/bookings/${r.id}`} className="text-stone-800 hover:underline">{instantDate(r.startAt, zoneOf(r))} · {instantRange(r.startAt, r.endAt, zoneOf(r))}</Link>
        <span className="ml-auto text-stone-600">{money(r.totalCents)}</span>
        <ReservationActions r={r} onChange={onChange} compact />
      </li>)}</ul>}
      <button type="button" onClick={() => setExpanded(value => !value)} className="mt-2 text-sm font-semibold text-forest hover:underline">{expanded ? 'Hide later bookings' : `${later.length} more upcoming`}</button>
    </div>}
  </article>;
}

function BookingRow({ r, onChange }: { r: Reservation; onChange: () => void }) {
  const zone = zoneOf(r);
  return <article className="fade-up flex flex-col gap-4 rounded-2xl border border-stone-200 bg-white p-4 sm:flex-row">
    <Link to={`/bookings/${r.id}`} className="shrink-0" aria-label={title(r)}><Photo src={photoOf(r)} className="h-32 w-full rounded-xl sm:w-44" /></Link>
    <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={r.status} /><span className="font-mono text-xs text-stone-500">{code(r)}</span></div>
        <Link to={`/bookings/${r.id}`} className="mt-1 block font-semibold text-stone-900 hover:underline">{title(r)}</Link>
        <p className="text-sm text-stone-600">{instantDate(r.startAt, zone)} · {instantRange(r.startAt, r.endAt, zone)} · {money(r.totalCents)}</p>
      </div>
      <ReservationActions r={r} onChange={onChange} />
    </div>
  </article>;
}

function NothingYet() {
  return <EmptyState title="Nothing here yet" text="Find a room by the hour and it will show up here." action={<Link to="/" className="rounded-full bg-forest px-5 py-2 text-sm font-medium text-white">Explore spaces</Link>} />;
}

function BookingsList() {
  const [state, setState] = useState<{ loading?: boolean; error?: string; items: Reservation[] }>({ loading: true, items: [] });
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const load = useCallback(() => { api<{ reservations: Reservation[] }>('/reservations').then(data => setState({ items: data.reservations })).catch(error => setState({ error: message(error), items: [] })); }, []);
  useEffect(load, [load]);
  if (state.loading) return <Loading label="Loading your bookings…" />;
  if (state.error) return <ErrorState message={state.error} onRetry={load} />;
  const now = Date.now();
  const upcoming = state.items.filter(r => ACTIVE.includes(r.status) && r.endAt > now).sort((a, b) => a.startAt - b.startAt);
  const past = state.items.filter(r => !upcoming.includes(r));
  const rooms = [...upcoming.reduce((map, r) => map.set(r.roomId, [...(map.get(r.roomId) || []), r]), new Map<string, Reservation[]>()).values()];
  return <>
    <Tabs className="mb-6" value={tab} onChange={setTab} items={[{ value: 'upcoming', label: `Upcoming (${upcoming.length})` }, { value: 'past', label: `Past & cancelled (${past.length})` }]} />
    <div className="mt-2">
      {tab === 'upcoming'
        ? upcoming.length ? <div className="space-y-4">{rooms.map(items => <RoomGroup key={items[0]!.roomId} items={items} onChange={load} />)}</div> : <NothingYet />
        : past.length ? <div className="space-y-4">{past.map(r => <BookingRow key={r.id} r={r} onChange={load} />)}</div> : <NothingYet />}
    </div>
  </>;
}

export function BookingsPage() {
  return <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
    <h1 className="mb-8 font-serif text-4xl font-semibold tracking-tight text-stone-900">My bookings</h1>
    <RequireAuth title="Sign in to see your bookings"><BookingsList /></RequireAuth>
  </main>;
}

const calendarStamp = (instant: number) => new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (value = '') => value.replace(/[\\;,]/g, match => `\\${match}`).replace(/\n/g, '\\n');

function downloadIcs(r: Reservation) {
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Odas//Booking//EN', 'BEGIN:VEVENT', `UID:${r.id}@odas`, `DTSTAMP:${calendarStamp(Date.now())}`, `DTSTART:${calendarStamp(r.startAt)}`, `DTEND:${calendarStamp(r.endAt)}`, `SUMMARY:${icsText(`${title(r)} – Odas`)}`, `LOCATION:${icsText(r.workspace?.address)}`, `DESCRIPTION:${icsText(`Confirmation ${code(r)}`)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' }));
  link.download = `odas-${code(r)}.ics`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function CalendarButtons({ r }: { r: Reservation }) {
  const google = `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: 'TEMPLATE', text: `${title(r)} – Odas`, dates: `${calendarStamp(r.startAt)}/${calendarStamp(r.endAt)}`, location: r.workspace?.address || '', details: `Confirmation ${code(r)}` })}`;
  const button = 'inline-flex h-9 items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 text-sm font-medium hover:border-stone-500';
  return <div className="flex flex-wrap gap-2">
    <button type="button" onClick={() => downloadIcs(r)} className={button}><CalendarPlus className="h-4 w-4" aria-hidden="true" /> Add to calendar (.ics)</button>
    <a href={google} target="_blank" rel="noreferrer" className={button}>Google Calendar</a>
  </div>;
}

function BookedBanner({ r }: { r: Reservation }) {
  const zone = zoneOf(r);
  const day = relativeDay(r.startAt, zone);
  return <section className="fade-up space-y-5 rounded-2xl border border-stone-200 bg-white p-6">
    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-forest text-white"><Check className="h-6 w-6" aria-hidden="true" /></span>
    <div>
      <h2 className="font-serif text-3xl font-semibold text-stone-900">You're booked</h2>
      <p className="mt-1 text-stone-700">{title(r)} · {['Today', 'Tomorrow'].includes(day) ? `${day}, ` : ''}{instantDate(r.startAt, zone)} · {instantRange(r.startAt, r.endAt, zone)}</p>
    </div>
    <CalendarButtons r={r} />
    <p className="text-sm text-stone-500">Confirmation code <span className="font-mono font-semibold text-stone-900">{code(r)}</span></p>
  </section>;
}

function AtTheDoor({ r }: { r: Reservation }) {
  const zone = zoneOf(r);
  const state = r.roomState;
  const place = r.workspace ? building(r.workspace) : null;
  return <section className="fade-up space-y-5 rounded-2xl border border-stone-200 bg-white p-6">
    <h2 className="font-serif text-2xl font-semibold">At the door</h2>
    <div className="rounded-2xl bg-forest p-5 text-white shadow-lg">
      <div className="flex justify-between text-[11px] font-semibold tracking-[0.18em] text-white/70 uppercase"><span>Odas reservation</span><span>{STATUS[r.status]}</span></div>
      <p className="mt-6 font-serif text-3xl font-semibold">{r.office ? roomName(r.office.name) : r.roomId}</p>
      <p className="text-sm text-white/80">{place ? [place.street, place.suite].filter(Boolean).join(' · ') : r.workspace?.address}</p>
      <p className="mt-4 text-sm font-medium">{relativeDay(r.startAt, zone)} {instantRange(r.startAt, r.endAt, zone)}</p>
    </div>
    <ol className="space-y-2">
      <li className="flex gap-3 rounded-xl border border-stone-200 p-3 text-sm">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-forest text-xs font-semibold text-white">1</span>
        <div><p className="font-semibold text-stone-900">Access</p><p className="text-stone-600">{r.accessInstructions || 'Access instructions have not been provided. Please contact the concierge before arrival.'}</p></div>
      </li>
      <li className="flex gap-3 rounded-xl border border-stone-200 p-3 text-sm">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-forest text-xs font-semibold text-white">2</span>
        <div>
          <p className="font-semibold text-stone-900">{state?.readiness === 'ready' ? 'Ready for arrival' : state?.readiness === 'not_ready' ? 'The office is not ready yet' : 'Readiness is awaiting inspection'}</p>
          <p className="text-stone-600">
            {state?.expectedReadyAt ? `Expected ready at ${instantClock(state.expectedReadyAt, zone)}${state.job?.estimateSource === 'configured' ? ' (configured estimate)' : ''}. ` : ''}
            {state?.job ? `Turnover: ${label(state.job.status)}${state.job.reason ? `. ${state.job.reason}` : ''}. ` : ''}
            {state?.inspection?.source === 'simulator' ? 'Inspection evidence comes from the development simulator.' : state?.inspection ? `Last captured ${instantClock(state.inspection.capturedAt, zone)}. Inspection can be uncertain.` : 'No current inspection evidence is available.'}
          </p>
        </div>
      </li>
    </ol>
    <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('odas:open-concierge', { detail: { bookingId: r.id } }))} className="inline-flex h-9 items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 text-sm font-medium hover:border-stone-500"><MessageCircle className="h-4 w-4" aria-hidden="true" /> Ask the concierge</button>
  </section>;
}

function ReplacementCard({ offer, busy, act }: { offer: ReplacementOffer; busy: boolean; act: (path: string) => Promise<void> }) {
  return <section aria-labelledby={`offer-${offer.id}`} className="fade-up space-y-3 rounded-2xl border border-forest/40 bg-white p-6">
    <p className="eyebrow">An office alternative</p>
    <h2 id={`offer-${offer.id}`} className="font-serif text-2xl font-semibold text-stone-900">{offer.office?.workspace ? roomTitle(offer.office.workspace, offer.office.name) : offer.office?.name || offer.roomId}</h2>
    <p className="text-sm text-stone-700">{offer.equivalence}</p>
    {offer.differences.length > 0 && <ul className="space-y-1 text-sm text-stone-600">{offer.differences.map(difference => <li key={difference} className="flex gap-3"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-stone-400" />{difference}</li>)}</ul>}
    <p className="text-sm text-stone-500">Your reservation time and amount paid stay the same. Offer expires {instantClock(offer.expiresAt)}.</p>
    <div className="flex flex-wrap gap-2">
      <button disabled={busy} onClick={() => void act(`/offers/${offer.id}/accept`)} className={`${action} bg-forest text-white hover:bg-forest-dark`}>Accept this office</button>
      <button disabled={busy} onClick={() => void act(`/offers/${offer.id}/decline`)} className={`${action} border border-stone-300 bg-white text-stone-800 hover:border-stone-500`}>Keep my current office</button>
    </div>
  </section>;
}

function Row({ name, children }: { name: string; children: ReactNode }) {
  return <div className="flex justify-between gap-4 py-2 text-sm"><dt className="text-stone-500">{name}</dt><dd className="text-right text-stone-900">{children}</dd></div>;
}

function BookingDetail() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { state: navigation } = useLocation();
  const [r, setReservation] = useState<Reservation | null>(null);
  const [pending, setPending] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>((navigation as { error?: string } | null)?.error || '');
  const [success, setSuccess] = useState('');
  const statusRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    try { setReservation(await api<Reservation>(`/reservations/${id}`)); }
    catch (err) { setError(message(err)); }
    finally { setPending(false); }
  }, [id]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    const update = () => void load();
    window.addEventListener('odas:notification', update);
    return () => { window.clearInterval(timer); window.removeEventListener('odas:notification', update); };
  }, [load]);
  useEffect(() => {
    if (!params.has('checkout')) return;
    // The redirect only starts reconciliation. The server verifies Checkout with Stripe.
    let disposed = false;
    async function reconcile() {
      for (let attempt = 0; attempt < 5 && !disposed; attempt++) {
        try {
          const data = await api<Reservation>(`/reservations/${id}/reconcile`, { method: 'POST' });
          if (!disposed) { setReservation(data); setError(''); setSuccess(data.paymentStatus === 'paid' ? '' : 'Payment has not been confirmed. You can check again below.'); }
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
  }, [id, params]);
  async function act(path: string) {
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api<Reservation | { url: string; reservation: Reservation }>(path, { method: 'POST' });
      if ('url' in result) { window.location.assign(result.url); return; }
      setReservation(result); setSuccess('Your reservation has been updated.');
      requestAnimationFrame(() => statusRef.current?.focus());
    } catch (err) { setError(message(err)); requestAnimationFrame(() => statusRef.current?.focus()); }
    finally { setBusy(false); }
  }
  if (pending) return <Loading />;
  if (!r) return <ErrorState message={error || 'Reservation not found.'} onRetry={() => void load()} />;
  const zone = zoneOf(r);
  const paid = r.paymentStatus === 'paid';
  const hours = (r.endAt - r.startAt) / 60_000;
  return <div className="space-y-6">
    <div ref={statusRef} tabIndex={-1} aria-live="polite" className="space-y-2 empty:hidden">{error && <Notice tone="error">{error}</Notice>}{success && <Notice tone="success">{success}</Notice>}</div>
    {params.has('checkout') && paid && r.status === 'confirmed' && <BookedBanner r={r} />}
    {r.offers?.filter(offer => offer.status === 'offered').map(offer => <ReplacementCard key={offer.id} offer={offer} busy={busy} act={act} />)}
    {['confirmed', 'checked_in'].includes(r.status) && <AtTheDoor r={r} />}
    <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
      <Photo src={photoOf(r)} className="h-56 w-full" />
      <div className="space-y-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="eyebrow">Confirmation number</p><p className="font-mono text-2xl font-semibold tracking-wider text-stone-900">{code(r)}</p></div>
          <StatusBadge status={r.status} />
        </div>
        <div>
          <Link to={`/rooms/${r.roomId}`} className="font-serif text-2xl font-semibold text-stone-900 hover:underline">{title(r)}</Link>
          <p className="text-sm text-stone-500">{r.workspace ? building(r.workspace).neighborhood : ''}, San Francisco</p>
        </div>
        <dl className="divide-y divide-stone-100 border-y border-stone-100">
          <Row name="Date">{dateLabel(zonedParts(r.startAt, zone).date)}</Row>
          <Row name="Time">{instantClock(r.startAt, zone)} – {instantClock(r.endAt, zone)} (Pacific)</Row>
          <Row name="Payment"><span className="capitalize">{PAYMENT[r.paymentStatus] || label(r.paymentStatus)}</span></Row>
          {r.refundStatus !== 'none' && <Row name="Refund">{label(r.refundStatus)}</Row>}
          {r.workspace?.address && <Row name="Address">{r.workspace.address} <a target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.workspace.address}, San Francisco, CA`)}`} className="ml-1 inline-flex items-center gap-1 font-medium text-forest underline underline-offset-4"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />Get directions</a></Row>}
          {r.status === 'confirmed' && <Row name="Check-in">Check-in opens at {instantClock(r.startAt - (r.checkInWindowMinutes ?? 15) * 60_000, zone)}</Row>}
        </dl>
        {['confirmed', 'checked_in'].includes(r.status) && !params.has('checkout') && <CalendarButtons r={r} />}
        {['held', 'checkout_pending'].includes(r.status) && !paid && <div className="space-y-2 rounded-xl bg-mist p-4">
          <p className="text-sm text-stone-700">Hold expires {r.holdExpiresAt ? instantClock(r.holdExpiresAt, zone) : 'soon'}. Payment is required for confirmation.</p>
          <button disabled={busy} onClick={() => void act(`/reservations/${id}/checkout`)} className={`${action} bg-forest text-white hover:bg-forest-dark`}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />} Continue to Checkout</button>
        </div>}
        {r.checkoutSessionId && !paid && <button disabled={busy} onClick={() => void act(`/reservations/${id}/reconcile`)} className="inline-flex h-9 items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 text-sm font-medium hover:border-stone-500"><RefreshCw className="h-4 w-4" aria-hidden="true" /> Check payment status</button>}
        <div>
          <p className="eyebrow mb-3">Price breakdown (saved at booking)</p>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between text-stone-600"><dt>{r.office ? `${money(r.office.rateCents)} × ` : 'Office · '}{durationLabel(hours)}</dt><dd>{money(r.subtotalCents)}</dd></div>
            <div className="flex justify-between text-stone-600"><dt>Service fee (10%)</dt><dd>{money(r.feeCents)}</dd></div>
            <div className="flex justify-between border-t border-stone-200 pt-2 text-base font-semibold text-stone-900"><dt>Total</dt><dd>{money(r.totalCents)}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-stone-500">Stripe sandbox payments</p>
        </div>
        <div><p className="eyebrow mb-2">Cancellation policy</p><p className="text-sm text-stone-600">{r.cancellationPolicy || CANCELLATION_POLICY}</p></div>
        <ReservationActions r={r} onChange={next => { setReservation(next); setSuccess('Your reservation has been updated.'); }} />
      </div>
    </div>
  </div>;
}

export function BookingPage() {
  return <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
    <Link to="/bookings" className="mb-6 inline-flex items-center gap-1 text-sm text-stone-600 hover:text-stone-900"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> My bookings</Link>
    <RequireAuth title="Sign in to view this reservation"><BookingDetail /></RequireAuth>
  </main>;
}
