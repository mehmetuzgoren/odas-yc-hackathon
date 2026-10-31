import { forwardRef, lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { LatLngBounds } from 'leaflet';
import { Accessibility, ArrowLeft, ChevronLeft, ChevronRight, Clock, Coffee, DoorClosed, List, LoaderCircle, Map as MapIcon, Monitor, PenLine, Wifi, X } from 'lucide-react';
import { CANCELLATION_POLICY, money, type Office, type Quote, type Reservation, type SearchResult, type Workspace } from '@odas/contracts';
import { api, useSession } from '../api';
import { Calendar, EmptyState, ErrorState, Loading, Modal, Notice, Photo, Popover, Sheet } from '../ui';
import { FiltersPopover, NO_FILTERS, SearchBar, type SearchValue } from './SearchBar';
import { AMENITIES, ROOM_TYPES, bestOffice, building, filtersFrom, matchesFilters, matchesLocation, quoteTotal, roomName, roomPhotos, roomTitle, writeFilters, type Filters } from './listing';
import { TimeColumn, type BusyBlock, type TimeBoard } from './TimeColumn';
import { addDays, clockLabel, datedInstant, dateLabel, dayOfWeek, defaultSelection, durationLabel, intervalParams, rangeLabel, shortClock, toMinutes, toTime, zonedNow } from './time';

const ExploreMap = lazy(() => import('./MapView'));
const NeighborhoodMap = lazy(() => import('./MapView').then(module => ({ default: module.NeighborhoodMap })));
const LAST_END = 1410;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function useRemote<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    if (!path) { setData(null); setLoading(false); return; }
    api<T>(path).then(value => { if (active) setData(value); }).catch(error => { if (active) { setData(null); setError(error.message || 'Something went wrong. Please try again.'); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, retry]);
  return { data, loading, error, retry: () => setRetry(value => value + 1) };
}

function useInterval() {
  const [params] = useSearchParams();
  let query = new URLSearchParams(params); let error = '';
  try { query = intervalParams(params); } catch (cause) { error = cause instanceof Error ? cause.message : 'Choose valid date and times.'; }
  const fallback = defaultSelection();
  return { query, error, selection: { date: query.get('date') || fallback.date, start: query.get('start') || fallback.start, end: query.get('end') || fallback.end } };
}

const intervalOnly = (query: URLSearchParams) => new URLSearchParams(['date', 'start', 'end', 'startAt', 'endAt'].flatMap(key => query.has(key) ? [[key, query.get(key)!]] : [])).toString();

function Availability({ office, start, end }: { office: Office; start: number; end: number }) {
  const open = !!office.available;
  return <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${open ? 'text-forest' : 'text-stone-400'}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${open ? 'bg-forest' : 'bg-stone-300'}`} />
    {open ? `Available ${clockLabel(start)}–${clockLabel(end)}` : `Unavailable · ${office.availabilityReason || 'not available'}`}
  </span>;
}

interface CardProps { group: Workspace; office: Office; href: string; selected: boolean; index: number; start: number; end: number; onHover: (id: string) => void }

const ListingCard = forwardRef<HTMLAnchorElement, CardProps>(({ group, office, href, selected, index, start, end, onHover }, ref) => {
  const title = roomTitle(group, office.name);
  return <Link ref={ref} to={href} onMouseEnter={() => onHover(office.id)} onFocus={() => onHover(office.id)} style={{ animationDelay: `${50 * index}ms` }} className={`fade-up group block rounded-2xl p-2 transition-colors ${selected ? 'bg-mist ring-1 ring-forest/40' : 'hover:bg-white'}`}>
    <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-stone-200"><Photo src={roomPhotos(office)[0]} alt={title} className="h-full w-full transition-transform duration-500 group-hover:scale-[1.03]" /></div>
    <div className="space-y-1 px-1 pt-3 pb-1">
      <div className="flex items-start justify-between gap-3">
        <h3 className="leading-snug font-semibold text-stone-900">{title}</h3>
        <p className="text-sm whitespace-nowrap text-stone-900"><span className="font-semibold">{money(office.rateCents)}</span><span className="text-stone-500"> / hr</span></p>
      </div>
      <p className="text-sm text-stone-500">{building(group).neighborhood} · {ROOM_TYPES.private_office}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5">
        <span className="inline-flex items-center gap-1 text-xs text-stone-600"><DoorClosed className="h-3.5 w-3.5" aria-hidden="true" /> Individual office</span>
        <Availability office={office} start={start} end={end} />
      </div>
    </div>
  </Link>;
});
ListingCard.displayName = 'ListingCard';

function ListingsLoading() {
  return <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">{[0, 1, 2, 3].map(index => <div key={index} className="animate-pulse p-2"><div className="aspect-[4/3] rounded-xl bg-stone-200" /><div className="mt-3 h-4 w-2/3 rounded-[4px] bg-stone-200" /><div className="mt-2 h-3 w-1/2 rounded-[4px] bg-stone-200" /></div>)}</div>;
}

function MobilePreview({ group, office, href, onClose }: { group: Workspace; office: Office; href: string; onClose: () => void }) {
  return <div className="absolute inset-x-3 bottom-20 z-[600] flex gap-3 rounded-2xl bg-white p-2 shadow-xl lg:hidden">
    <Photo src={roomPhotos(office)[0]} className="h-20 w-24 rounded-xl" />
    <Link to={href} className="min-w-0 flex-1 py-1">
      <p className="truncate text-sm font-semibold">{roomTitle(group, office.name)}</p>
      <p className="text-xs text-stone-500">{building(group).neighborhood}</p>
      <p className="mt-1 text-sm"><b>{money(office.rateCents)}</b> / hr</p>
    </Link>
    <button onClick={onClose} aria-label="Close" className="self-start p-1 text-stone-400"><X className="h-4 w-4" /></button>
  </div>;
}

export function ExplorePage() {
  const { query, error: intervalError, selection } = useInterval();
  const [params, setParams] = useSearchParams();
  const applied: SearchValue = { location: params.get('location') || '', ...selection };
  const [draft, setDraft] = useState(applied);
  const [area, setArea] = useState<LatLngBounds | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'map'>('list');
  const [fitKey, setFitKey] = useState(0);
  const cards = useRef<Record<string, HTMLAnchorElement | null>>({});
  const result = useRemote<SearchResult>(intervalError ? null : `/catalog/search?${intervalOnly(query)}`);
  const filters = filtersFrom(params);
  const filterKey = params.toString();
  const listings = useMemo(() => {
    if (!result.data) return [];
    const { groups, offices } = result.data;
    return groups.flatMap(group => {
      if (!matchesLocation(group, applied.location)) return [];
      if (area && !area.contains([group.latitude, group.longitude])) return [];
      const office = bestOffice(offices.filter(value => value.groupId === group.id && matchesFilters(value, filters)));
      return office ? [{ group, office }] : [];
    });
  }, [result.data, filterKey, area]);
  const ids = listings.map(listing => listing.office.id).join();
  useEffect(() => { if (!area) setFitKey(key => key + 1); }, [ids, area]);
  useEffect(() => setDraft(applied), [selection.date, selection.start, selection.end, applied.location]);
  const start = toMinutes(selection.start);
  const end = toMinutes(selection.end);
  const href = (office: Office) => `/rooms/${office.id}?${query}`;
  const mapListings = useMemo(() => listings.map(({ group, office }) => ({ id: office.id, latitude: group.latitude, longitude: group.longitude, rateCents: office.rateCents, unavailable: !office.available, street: building(group).street, suite: building(group).suite, photo: roomPhotos(office)[0], href: href(office) })), [listings, query.toString()]);
  const active = listings.find(listing => listing.office.id === selected);
  function search() {
    const next = new URLSearchParams(params);
    next.set('date', draft.date); next.set('start', draft.start); next.set('end', draft.end);
    next.delete('startAt'); next.delete('endAt');
    if (draft.location) next.set('location', draft.location); else next.delete('location');
    setArea(null);
    setParams(next);
  }
  const setFilters = (value: Filters) => setParams(writeFilters(params, value), { replace: true });
  function toggleView() {
    const next = view === 'list' ? 'map' : 'list';
    setView(next);
    if (next === 'map') setTimeout(() => document.getElementById('explore-map-anchor')?.scrollIntoView({ block: 'start' }), 50);
  }
  return <main>
    <section className="border-b border-stone-200 bg-sand/60 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-[1600px]">
        <h1 className="mb-5 font-serif text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl">Rooms by the hour in San Francisco</h1>
        <SearchBar value={draft} onChange={setDraft} onSubmit={search} />
      </div>
    </section>
    <div className="mx-auto flex max-w-[1600px]">
      <section aria-label="Spaces" className={`w-full px-4 py-6 sm:px-6 lg:block lg:w-[56%] ${view === 'map' ? 'hidden' : 'block'}`}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-stone-600" aria-live="polite">
            {result.loading ? 'Searching…' : `${listings.length} space${listings.length === 1 ? '' : 's'}`} · {dateLabel(selection.date)}, {clockLabel(start)}–{clockLabel(end)}
            {area && <button onClick={() => setArea(null)} className="ml-2 font-medium text-forest underline underline-offset-4">Clear map area</button>}
          </p>
          <FiltersPopover value={filters} onChange={setFilters} />
        </div>
        {intervalError || result.error ? <ErrorState message={intervalError || result.error} onRetry={intervalError ? undefined : result.retry} />
          : result.loading && !listings.length ? <ListingsLoading />
          : listings.length ? <div className={`grid grid-cols-1 gap-6 sm:grid-cols-2 ${result.loading ? 'opacity-60' : ''}`}>
            {listings.map(({ group, office }, index) => <ListingCard key={office.id} ref={element => { cards.current[office.id] = element; }} group={group} office={office} href={href(office)} selected={office.id === selected} index={index} start={start} end={end} onHover={setSelected} />)}
          </div>
          : <EmptyState title="No spaces match" text="Try another time, fewer filters or a wider map area." action={<button onClick={() => { setFilters(NO_FILTERS); setArea(null); }} className="rounded-full border border-stone-300 px-4 py-2 text-sm font-medium">Reset filters</button>} />}
        <p className="mt-10 text-xs text-stone-400">Modeled inventory. Property details and access are not verified as live supply.</p>
      </section>
      <aside id="explore-map-anchor" className={`relative scroll-mt-28 lg:sticky lg:top-16 lg:block lg:h-[calc(100vh-64px)] lg:w-[44%] ${view === 'map' ? 'block h-[calc(100vh-112px)] w-full' : 'hidden'}`}>
        <Suspense fallback={<Loading label="Loading map…" />}>
          <ExploreMap listings={mapListings} selectedId={selected} fitKey={fitKey} view={view} onSearchArea={setArea} onSelect={id => { setSelected(id); cards.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }} />
        </Suspense>
        {view === 'map' && active && <MobilePreview group={active.group} office={active.office} href={href(active.office)} onClose={() => setSelected(null)} />}
      </aside>
    </div>
    <button onClick={toggleView} className="fixed bottom-6 left-1/2 z-[700] flex -translate-x-1/2 items-center gap-2 rounded-full bg-stone-900 px-5 py-3 text-sm font-semibold text-white shadow-xl lg:hidden">
      {view === 'list' ? <><MapIcon className="h-4 w-4" aria-hidden="true" /> Map</> : <><List className="h-4 w-4" aria-hidden="true" /> List</>}
    </button>
  </main>;
}

function GalleryArrow({ side, show, onClick }: { side: 'left' | 'right'; show: boolean; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return <div className={`pointer-events-none absolute inset-y-0 ${side === 'left' ? 'left-0 justify-start pl-3' : 'right-0 justify-end pr-3'} z-10 flex items-center`}>
    <button type="button" onClick={onClick} aria-label={side === 'left' ? 'Previous photo' : 'Next photo'} className={`pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-white/50 bg-black/25 text-white shadow-lg backdrop-blur-md transition-[opacity,transform,background-color] duration-200 hover:scale-105 hover:bg-black/40 focus-visible:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100 ${show ? 'opacity-100' : 'opacity-0'}`}><Icon className="h-5 w-5 drop-shadow" /></button>
  </div>;
}

function Gallery({ photos, title }: { photos: string[]; title: string }) {
  const [dialog, setDialog] = useState(false);
  const [index, setIndex] = useState(0);
  const [edge, setEdge] = useState<'left' | 'right' | null>(null);
  if (!photos.length) return <Photo className="h-[300px] w-full rounded-2xl sm:h-[460px]" />;
  const count = photos.length;
  const current = index % count;
  const others = photos.filter((_, position) => position !== current);
  const step = (delta: number) => setIndex(value => (value + delta + count) % count);
  return <>
    <div className="relative" onMouseLeave={() => setEdge(null)} onMouseMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      const margin = Math.max(64, 0.12 * rect.width);
      const x = event.clientX - rect.left;
      setEdge(x < margin ? 'left' : x > rect.width - margin ? 'right' : null);
    }} onKeyDown={event => { if (count > 1 && event.key === 'ArrowLeft') step(-1); if (count > 1 && event.key === 'ArrowRight') step(1); }}>
      <div className={`grid h-[300px] grid-cols-1 gap-2 overflow-hidden rounded-2xl sm:h-[460px] ${others.length ? 'sm:grid-cols-3' : ''}`}>
        <div className={`relative overflow-hidden ${others.length ? 'sm:col-span-2' : ''}`}>
          <button className="h-full w-full" onClick={() => setDialog(true)}><Photo key={photos[current]} src={photos[current]} alt={title} className="h-full w-full transition-opacity hover:opacity-95" /></button>
          {count > 1 && <span className="pointer-events-none absolute right-3 bottom-3 rounded-full bg-stone-900/60 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">{current + 1} / {count}</span>}
        </div>
        <div className={`hidden gap-2 sm:grid ${others.length > 1 ? 'grid-rows-2' : 'grid-rows-1'}`}>
          {others.slice(0, 2).map(photo => <button key={photo} onClick={() => setIndex(photos.indexOf(photo))} className="overflow-hidden"><Photo src={photo} className="h-full w-full transition-opacity hover:opacity-95" /></button>)}
        </div>
      </div>
      {count > 1 && <><GalleryArrow side="left" show={edge === 'left'} onClick={() => step(-1)} /><GalleryArrow side="right" show={edge === 'right'} onClick={() => step(1)} /></>}
    </div>
    <button onClick={() => setDialog(true)} className="mt-3 text-sm font-medium text-stone-700 underline underline-offset-4">{count > 1 ? `Show all ${count} photos` : 'View photo'}</button>
    <Modal open={dialog} onClose={() => setDialog(false)} title={title} className="max-h-[90vh] max-w-4xl overflow-y-auto">
      <div className="space-y-3">{photos.map(photo => <Photo key={photo} src={photo} alt={title} className="w-full rounded-xl" />)}</div>
    </Modal>
  </>;
}

interface Selection { date: string; start: string; end: string }

function useBooking(office: Office, initial: Selection, synced: (selection: Selection) => boolean, onSelection: (selection: Selection) => void) {
  const hours = office.workspace!.hours;
  const open = toMinutes(hours.open);
  const closing = toMinutes(hours.close);
  const close = closing > open ? closing : LAST_END;
  const now = zonedNow();
  const today = now.date;
  const [date, setDateValue] = useState(initial.date);
  const [start, setStart] = useState(Math.max(open, Math.min(toMinutes(initial.start), close - 60)));
  const [length, setLength] = useState(Math.max(60, toMinutes(initial.end) - toMinutes(initial.start)));
  const end = Math.min(start + length, close);
  const nowMinutes = date === today ? now.minutes : date < today ? 1440 : 0;
  const isClosed = (value: string) => !hours.days.includes(dayOfWeek(value));
  const closed = isClosed(date);
  const busy = useMemo<BusyBlock[]>(() => [...(open > 0 ? [{ from: 0, to: open, kind: 'closed' as const }] : []), ...(close < 1440 ? [{ from: close, to: 1440, kind: 'closed' as const }] : [])], [open, close]);
  const selection = { date, start: toTime(start), end: toTime(end) };
  const checked = synced(selection);
  const written = useRef(`${initial.date}|${initial.start}|${initial.end}`);
  useEffect(() => {
    const timer = setTimeout(() => { written.current = `${selection.date}|${selection.start}|${selection.end}`; onSelection(selection); }, 200);
    return () => clearTimeout(timer);
  }, [date, start, end]);
  // A link can change the URL without remounting this room, so follow any selection this page did not write.
  useEffect(() => {
    const incoming = `${initial.date}|${initial.start}|${initial.end}`;
    if (incoming === written.current) return;
    written.current = incoming;
    setDateValue(initial.date);
    setStart(Math.max(open, Math.min(toMinutes(initial.start), close - 60)));
    setLength(Math.max(60, toMinutes(initial.end) - toMinutes(initial.start)));
  }, [initial.date, initial.start, initial.end]);
  const reason = closed ? 'The room is closed on this day.' : start < nowMinutes ? 'That start time has already passed.' : checked && office.available === false ? office.availabilityReason || 'This office is unavailable for your selected time.' : null;
  function setDate(value: string) {
    const earliest = Math.max(open, value === today ? 30 * Math.ceil(now.minutes / 30) : 0);
    setDateValue(value);
    setStart(Math.max(earliest, Math.min(start, close - length)) > close - 60 ? Math.max(open, close - 60) : Math.max(earliest, Math.min(start, close - length)));
  }
  const board: TimeBoard = { date, start, end, conflict: !!reason, closed, nowMinutes, busy, setRange: (from, to) => { setStart(from); setLength(to - from); } };
  return { board, selection, date, setDate, today, isClosed, start, end, reason, checked };
}

type Booking = ReturnType<typeof useBooking>;

function DateStrip({ booking }: { booking: Booking }) {
  const [open, setOpen] = useState(false);
  const week = Array.from({ length: 7 }, (_, index) => addDays(booking.today, index));
  const inWeek = week.includes(booking.date);
  return <div>
    <span className="mb-1 block text-[13px] font-medium text-stone-700">Date</span>
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Choose a date">
      {week.map((day, index) => {
        const active = booking.date === day;
        return <button key={day} type="button" aria-pressed={active} aria-label={dateLabel(day)} disabled={booking.isClosed(day)} onClick={() => booking.setDate(day)} className={`flex h-14 min-w-12 shrink-0 flex-col items-center justify-center rounded-xl border px-2 text-xs transition-colors disabled:opacity-30 ${active ? 'border-forest bg-forest text-white' : 'border-stone-200 bg-white text-stone-700 hover:border-stone-400'}`}>
          <span>{index === 0 ? 'Today' : dateLabel(day).slice(0, 3)}</span>
          <span className="text-sm font-semibold">{Number(day.slice(-2))}</span>
        </button>;
      })}
      <Popover label="More dates" align="end" open={open} onOpenChange={setOpen} className="z-[1300] w-auto p-0" buttonClassName={`h-14 shrink-0 rounded-xl border px-3 text-xs font-medium ${inWeek ? 'border-stone-200 bg-white text-stone-700' : 'border-forest bg-forest text-white'}`} button={inWeek ? 'More dates' : dateLabel(booking.date)}>
        <Calendar selected={booking.date} isDisabled={day => day < booking.today || booking.isClosed(day)} onSelect={day => { booking.setDate(day); setOpen(false); }} />
      </Popover>
    </div>
  </div>;
}

function Summary({ booking, office, busy, error, onReserve }: { booking: Booking; office: Office; busy: boolean; error: string; onReserve: () => void }) {
  const minutes = booking.end - booking.start;
  const price = quoteTotal(office.rateCents, minutes);
  const blocked = !!booking.reason || !booking.checked;
  return <div className="space-y-2.5">
    <div>
      <p className="text-[11px] font-semibold tracking-[0.14em] text-stone-500 uppercase">Your booking</p>
      <p className="font-serif text-xl font-semibold text-stone-900">{dateLabel(booking.date)} · {rangeLabel(booking.start, booking.end)}</p>
      <p className="text-sm text-stone-600">{durationLabel(minutes)} · Free cancellation until {shortClock(booking.start)}</p>
    </div>
    {booking.reason && <Notice tone="error">{booking.reason}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <dl className="space-y-1.5 text-sm">
      <div className="flex justify-between text-stone-600"><dt>{money(office.rateCents)} × {durationLabel(minutes)}</dt><dd key={`s${price.subtotal}`} className="price-fade">{money(price.subtotal)}</dd></div>
      <div className="flex justify-between text-stone-600"><dt>Service fee (10%)</dt><dd key={`f${price.fee}`} className="price-fade">{money(price.fee)}</dd></div>
      <div className="flex items-baseline justify-between border-t border-stone-200 pt-2"><dt className="font-semibold text-stone-900">Total</dt><dd key={`t${price.total}`} className="price-fade font-serif text-2xl font-semibold text-stone-900">{money(price.total)}</dd></div>
    </dl>
    <button type="button" onClick={onReserve} disabled={busy || blocked} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-forest text-sm font-semibold text-white transition-colors hover:bg-forest-dark disabled:cursor-not-allowed disabled:opacity-40">
      {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />} {busy ? 'Opening secure checkout…' : `Reserve${blocked ? '' : ` · ${money(price.total)}`}`}
    </button>
    <p className="text-center text-xs text-stone-500">Stripe sandbox Checkout · no live charges</p>
  </div>;
}

function BookingPanel({ office, booking }: { office: Office; booking: Booking }) {
  const { user, signInOpen, setSignInOpen } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(false);
  const wanted = useRef(false);
  const holdKey = useRef(crypto.randomUUID());
  const key = `${booking.date}|${booking.start}|${booking.end}`;
  useEffect(() => { holdKey.current = crypto.randomUUID(); setError(''); }, [key, user?.id]);
  useEffect(() => { if (signInOpen) setSheet(false); else if (!user) wanted.current = false; }, [signInOpen]);
  useEffect(() => { if (user && wanted.current && booking.checked && !booking.reason) { wanted.current = false; void reserve(); } }, [user, booking.checked, booking.reason]);
  async function reserve() {
    if (!user) { wanted.current = true; setSignInOpen(true); return; }
    setBusy(true); setError('');
    try {
      const startAt = datedInstant(booking.date, booking.selection.start);
      const endAt = datedInstant(booking.date, booking.selection.end);
      const quote = await api<Quote>('/quotes', { method: 'POST', body: JSON.stringify({ roomId: office.id, startAt, endAt }) });
      if (quote.totalCents !== quoteTotal(office.rateCents, booking.end - booking.start).total) throw new Error(`The total for this time is now ${money(quote.totalCents)}. Please review it and reserve again.`);
      const reservation = await api<Reservation>('/reservations', { method: 'POST', body: JSON.stringify({ quoteId: quote.id, idempotencyKey: holdKey.current }) });
      try {
        const checkout = await api<{ url: string }>(`/reservations/${reservation.id}/checkout`, { method: 'POST', body: JSON.stringify({}) });
        window.location.assign(checkout.url);
      } catch (cause) {
        void navigate(`/bookings/${reservation.id}`, { state: { error: cause instanceof Error ? cause.message : 'Checkout could not open. Your office is held.' } });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Please try again.'); setBusy(false); }
  }
  const price = quoteTotal(office.rateCents, booking.end - booking.start);
  const heading = roomTitle(office.workspace!, office.name);
  const picker = (height?: string) => <div className="space-y-4"><DateStrip booking={booking} /><TimeColumn board={booking.board} height={height} /></div>;
  return <>
    <div className="hidden rounded-2xl border border-stone-200 bg-white p-5 shadow-[0_8px_30px_rgba(28,25,23,0.06)] lg:block">
      <p className="mb-3 text-stone-900"><span className="font-serif text-2xl font-semibold">{money(office.rateCents)}</span> <span className="text-sm text-stone-500">/ hour</span></p>
      {picker('min(480px, max(220px, calc(100vh - 590px)))')}
      <div className="mt-4"><Summary booking={booking} office={office} busy={busy} error={error} onReserve={() => void reserve()} /></div>
    </div>
    <div className="fixed inset-x-0 bottom-0 z-[900] flex items-center justify-between gap-3 border-t border-stone-200 bg-ivory/95 px-4 py-3 backdrop-blur lg:hidden">
      <button type="button" onClick={() => setSheet(true)} className="min-w-0 text-left">
        <p className="font-serif text-lg font-semibold text-stone-900">{money(price.total)} total</p>
        <p className="truncate text-xs text-stone-600 underline underline-offset-2">{dateLabel(booking.date)} · {rangeLabel(booking.start, booking.end)} · {durationLabel(booking.end - booking.start)}</p>
      </button>
      <button type="button" onClick={() => setSheet(true)} className="h-11 shrink-0 rounded-xl bg-forest px-5 text-sm font-semibold text-white">Reserve</button>
    </div>
    <Sheet open={sheet} onClose={() => setSheet(false)} title={`Book ${heading}`} description={`${money(office.rateCents)} / hour`}>
      {sheet && <>{picker()}<div className="mt-5"><Summary booking={booking} office={office} busy={busy} error={error} onReserve={() => void reserve()} /></div></>}
    </Sheet>
  </>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="border-t border-stone-200 py-8"><h2 className="mb-4 font-serif text-2xl font-semibold text-stone-900">{title}</h2>{children}</section>;
}

const AMENITY_ICONS: Record<string, ComponentType<{ className?: string }>> = { wifi: Wifi, monitor: Monitor, whiteboard: PenLine, coffee: Coffee, accessible: Accessibility };

function MoreOffices({ office, query }: { office: Office; query: string }) {
  const { data } = useRemote<{ group: Workspace; offices: Office[] }>(`/catalog/groups/${encodeURIComponent(office.groupId)}?${query}`);
  const others = data?.offices.filter(value => value.id !== office.id) ?? [];
  if (!others.length) return null;
  return <Section title="More offices here">
    <ul className="divide-y divide-stone-100">
      {others.map(other => <li key={other.id}><Link to={`/rooms/${other.id}?${query}`} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:underline">
        <span className="font-medium text-stone-800">{roomName(other.name)}</span>
        <span className="flex items-center gap-4 text-stone-600">{money(other.rateCents)} / hr<span className={`h-1.5 w-1.5 rounded-full ${other.available ? 'bg-forest' : 'bg-stone-300'}`} title={other.available ? 'Available' : 'Unavailable'} /></span>
      </Link></li>)}
    </ul>
  </Section>;
}

function RoomDetail({ id }: { id: string }) {
  const { query, error: intervalError, selection } = useInterval();
  const [, setParams] = useSearchParams();
  const remote = useRemote<Office>(intervalError ? null : `/catalog/offices/${encodeURIComponent(id)}?${query}`);
  const office = remote.data;
  const apply = (next: Selection) => setParams(current => {
    const value = new URLSearchParams(current);
    value.set('date', next.date); value.set('start', next.start); value.set('end', next.end);
    value.delete('startAt'); value.delete('endAt');
    return value;
  }, { replace: true });
  const synced = (next: Selection) => !remote.loading && selection.date === next.date && selection.start === next.start && selection.end === next.end;
  if (intervalError || remote.error) return <div className="px-4 py-16"><ErrorState message={intervalError || remote.error} onRetry={intervalError ? undefined : remote.retry} /></div>;
  if (!office) return <Loading label="Loading room…" />;
  return <Loaded office={office} query={query.toString()} initial={selection} synced={synced} apply={apply} />;
}

function Loaded({ office, query, initial, synced, apply }: { office: Office; query: string; initial: Selection; synced: (selection: Selection) => boolean; apply: (selection: Selection) => void }) {
  const booking = useBooking(office, initial, synced, apply);
  const workspace = office.workspace!;
  const place = building(workspace);
  const hours = workspace.hours;
  const days = hours.days.length === 7 ? 'Every day' : hours.days.map(day => DAYS[day - 1]).join(', ');
  const amenities = Array.isArray(office.attributes.amenities) ? office.attributes.amenities.map(String).filter(value => value in AMENITIES) : [];
  const interval = intervalOnly(new URLSearchParams(query));
  const backQuery = new URLSearchParams(query);
  backQuery.delete('startAt'); backQuery.delete('endAt');
  return <main className="mx-auto max-w-[1240px] px-4 pt-6 pb-24 sm:px-6">
    <Link to={`/?${backQuery}`} className="mb-4 inline-flex items-center gap-1 text-sm text-stone-600 hover:text-stone-900"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> All spaces</Link>
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 lg:mb-4">
      <div>
        <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl">{roomTitle(workspace, office.name)}</h1>
        <p className="mt-2 text-stone-600">{place.neighborhood}, San Francisco · {ROOM_TYPES.private_office}</p>
      </div>
    </div>
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_400px]">
      <div className="min-w-0">
        <Gallery photos={roomPhotos(office)} title={roomTitle(workspace, office.name)} />
        <div className="mt-8 flex flex-wrap gap-6 pb-8 text-sm text-stone-700">
          <span className="flex items-center gap-2"><Clock className="h-4 w-4" aria-hidden="true" /> {clockLabel(toMinutes(hours.open))}–{clockLabel(toMinutes(hours.close))} · {days}{hours.modeled ? ' (modeled hours)' : ''}</span>
        </div>
        <Section title="About this space"><p className="max-w-2xl leading-relaxed text-stone-600">{office.description}</p></Section>
        {amenities.length > 0 && <Section title="Amenities"><ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">{amenities.map(amenity => {
          const Icon = AMENITY_ICONS[amenity];
          return <li key={amenity} className="flex items-center gap-3 text-sm text-stone-700">{Icon && <Icon className="h-5 w-5 text-stone-500" aria-hidden="true" />} {AMENITIES[amenity]}</li>;
        })}</ul></Section>}
        <Section title="Cancellation policy">
          <ul className="space-y-2 text-stone-600">{CANCELLATION_POLICY.split(/(?<=\.)\s+/).map(line => <li key={line} className="flex gap-3"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-stone-400" />{line}</li>)}</ul>
        </Section>
        <MoreOffices office={office} query={interval} />
        <Section title="Neighborhood">
          <p className="mb-4 text-sm text-stone-600">{workspace.address}, San Francisco, CA — approximate area shown.</p>
          <Suspense fallback={<Loading label="Loading map…" />}><NeighborhoodMap latitude={workspace.latitude} longitude={workspace.longitude} /></Suspense>
        </Section>
      </div>
      <aside className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:self-start lg:overflow-y-auto"><BookingPanel office={office} booking={booking} /></aside>
    </div>
  </main>;
}

export function RoomPage() {
  const { id = '' } = useParams();
  return <RoomDetail key={id} id={id} />;
}
