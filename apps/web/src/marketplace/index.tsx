import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowRight, Building2, CalendarDays, Check, Clock3, ImageIcon, List, Map, MapPin, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { CANCELLATION_POLICY, money, type Office, type Quote, type Reservation, type SearchResult, type Workspace } from '@odas/contracts';
import { api, useSession } from '../api';
import { defaultDate, intervalLabel, intervalParams } from './time';
import './marketplace.css';

const MapView = lazy(() => import('./MapView'));

function useRemote<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setData(null);
    if (!path) { setLoading(false); return; }
    api<T>(path).then(value => { if (active) setData(value); }).catch(error => { if (active) setError(error.message || 'Something went wrong. Please try again.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, retry]);
  return { data, loading, error, retry: () => setRetry(value => value + 1) };
}

function useInterval() {
  const [params] = useSearchParams();
  let query = new URLSearchParams(params); let error = '';
  try { query = intervalParams(params); } catch (cause) { error = cause instanceof Error ? cause.message : 'Choose valid date and times.'; }
  return { query, error, startAt: Number(query.get('startAt')), endAt: Number(query.get('endAt')) };
}

function RemoteError({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="market-feedback error" role="alert"><p>{message}</p>{retry && <button className="button secondary" onClick={retry}>Try again</button>}</div>;
}

function Placeholder({ name, compact = false, photos = [] }: { name: string; compact?: boolean; photos?: string[] }) {
  const [failed, setFailed] = useState(false);
  if (photos.length && !failed) return <div className={`market-photo ${compact ? 'compact' : ''}`}><img src={photos[0]} alt={name} onError={() => setFailed(true)} loading="lazy" /></div>;
  return <div className={`market-photo market-placeholder ${compact ? 'compact' : ''}`} aria-label={`Photography for ${name} is not yet available`}>
    <div className="market-floorplan" aria-hidden="true"><div /><span /><i /></div>
    <span className="market-photo-caption"><ImageIcon size={14} /> Photography pending</span>
  </div>;
}

function IntervalSummary({ startAt, endAt, query }: { startAt: number; endAt: number; query: string }) {
  return <div className="market-interval-summary"><CalendarDays size={18} /><span>{Number.isFinite(startAt) && startAt > 0 ? intervalLabel(startAt, endAt) : 'Choose your date and time'}</span><Link to={`/?${query}`}>Change time</Link></div>;
}

function SearchFilters({ query }: { query: URLSearchParams }) {
  const [, setParams] = useSearchParams();
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams(query);
    for (const name of ['date', 'start', 'end', 'location']) next.set(name, String(data.get(name) || ''));
    const max = String(data.get('maxPrice') || '');
    if (max) next.set('maxRateCents', String(Math.round(Number(max) * 100))); else next.delete('maxRateCents');
    const capacity = String(data.get('capacity') || '');
    next.delete('capacityKnown'); next.delete('minCapacity');
    if (capacity === 'known') next.set('capacityKnown', 'true');
    else if (capacity) next.set('minCapacity', capacity);
    next.delete('startAt'); next.delete('endAt');
    try { setParams(intervalParams(next)); setError(''); } catch { setError('Choose an end time after your start time. Times that fall in a daylight saving gap or repeated hour need a different selection.'); }
  }
  return <div className="market-search-area">
    <form className="market-search-form" onSubmit={submit} key={query.toString()}>
      <div className="market-search-field market-location-field"><label htmlFor="search-location"><MapPin size={15} /> Location</label><input id="search-location" name="location" placeholder="San Francisco" defaultValue={query.get('location') || ''} /></div>
      <div className="market-search-field"><label htmlFor="search-date"><CalendarDays size={15} /> Date</label><input id="search-date" name="date" type="date" required defaultValue={query.get('date') || defaultDate()} /></div>
      <div className="market-search-field"><label htmlFor="search-start"><Clock3 size={15} /> Start</label><input id="search-start" name="start" type="time" required step="900" defaultValue={query.get('start') || '10:00'} /></div>
      <div className="market-search-field"><label htmlFor="search-end">End</label><input id="search-end" name="end" type="time" required step="900" defaultValue={query.get('end') || '12:00'} /></div>
      <button className="button market-search-submit" type="submit"><Search size={19} /><span>Find an office</span></button>
      <div className="market-extra-filters"><span className="market-filter-label"><SlidersHorizontal size={15} /> Refine</span><label htmlFor="search-price">Max hourly price <span className="market-price-input"><span>$</span><input id="search-price" name="maxPrice" type="number" min="0" max="10000" step="0.01" placeholder="Any" defaultValue={query.get('maxRateCents') ? String(Number(query.get('maxRateCents')) / 100) : ''} /></span></label><label htmlFor="search-capacity">Known capacity<select id="search-capacity" name="capacity" defaultValue={query.get('minCapacity') || (query.get('capacityKnown') ? 'known' : '')}><option value="">Any / unknown</option><option value="known">Known capacity only</option><option value="1">At least 1 person</option><option value="2">At least 2 people</option><option value="4">At least 4 people</option></select></label><span className="market-timezone">Times in America/Los_Angeles</span></div>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}

function WorkspaceCard({ group, query, index }: { group: Workspace; query: string; index: number }) {
  return <article className={`market-workspace-card ${!group.availableCount ? 'market-unavailable' : ''}`}>
    <Link className="market-image-link" to={`/workspaces/${group.id}?${query}`} aria-label={`View ${group.name}`}><Placeholder name={group.name} compact photos={group.photos} /><span className="market-card-number" aria-hidden="true">0{index + 1}</span></Link>
    <div className="market-card-body"><span className="market-eyebrow">Workspace · modeled inventory</span><h3><Link to={`/workspaces/${group.id}?${query}`}>{group.name}</Link></h3><p className="market-card-address"><MapPin size={14} />{group.address}</p><div className="market-card-meta"><span><Building2 size={15} />{group.officeCount} individual {group.officeCount === 1 ? 'office' : 'offices'}</span><span>{group.availableCount || 0} available</span></div><div className="market-card-bottom">{group.availableCount ? <span className="market-rate">From <strong>{money(group.lowestRateCents!)}</strong><span> / hr</span></span> : <span className="market-no-availability">No matching availability</span>}<Link className="market-text-link" to={`/workspaces/${group.id}?${query}`}>View offices<ArrowRight size={16} /></Link></div></div>
  </article>;
}

export function MarketplacePage() {
  const { query, error: intervalError } = useInterval();
  const [view, setView] = useState<'split' | 'list'>('split');
  const result = useRemote<SearchResult>(intervalError ? null : `/catalog/search?${query}`);
  const groups = result.data?.groups || [];
  return <main className="market-page">
    <section className="market-hero container"><div><p className="market-eyebrow">YOUR OWN SPACE, BY THE HOUR</p><h1>Make room<br />for good work.</h1><p className="market-hero-copy">Find an individual office in San Francisco.<br />Choose your workspace, pick a room, and settle in.</p></div><div className="market-hero-aside" aria-hidden="true"><span>San Francisco, CA</span><div className="market-hero-mark"><Building2 strokeWidth={0.8} /></div><span>Room to focus.</span></div></section>
    <div className="container"><SearchFilters query={query} /><p className="market-inventory-note"><span className="market-small-dot" />6 workspaces · 31 modeled offices. Property details and access are not verified live supply.</p></div>
    <section className="container market-results-section" aria-labelledby="market-results-title"><div className="market-results-heading"><div><p className="market-eyebrow">FIND YOUR WORKSPACE</p><h2 id="market-results-title">A place for your next few hours.</h2><p className="muted" aria-live="polite">{result.loading ? 'Checking individual office availability…' : `${groups.length} ${groups.length === 1 ? 'workspace' : 'workspaces'} · ${result.data?.offices.filter(office => office.available).length || 0} matching offices`}</p></div><div className="market-view-toggle" aria-label="Results view"><button type="button" aria-pressed={view === 'split'} onClick={() => setView('split')}><Map size={17} />Map + list</button><button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={17} />List</button></div></div>
      {intervalError && <RemoteError message={intervalError} />}
      {result.error && <RemoteError message={result.error} retry={result.retry} />}
      {result.loading && <div className="market-loading" role="status"><span className="market-loading-dot" />Checking offices for your selected time…</div>}
      {!result.loading && !result.error && !intervalError && !groups.length && <div className="market-empty"><Search size={30} /><h3>No workspaces match that location.</h3><p>Try a street name or search San Francisco.</p><Link className="button secondary" to={`/?${new URLSearchParams([...query].filter(([key]) => key !== 'location')).toString()}`}>Clear location</Link></div>}
      {!result.loading && !result.error && !intervalError && groups.length > 0 && <div className={`market-results-layout ${view === 'list' ? 'list-only' : ''}`}><div className="market-card-grid">{groups.map((group, index) => <WorkspaceCard key={group.id} group={group} query={query.toString()} index={index} />)}</div>{view === 'split' && <aside className="market-map-column"><Suspense fallback={<div className="market-loading">Loading map…</div>}><MapView groups={groups} query={query.toString()} /></Suspense></aside>}</div>}
      {!result.loading && groups.length > 0 && !groups.some(group => group.availableCount) && <div className="market-feedback"><h3>No offices match your selected interval and filters.</h3><p>Try a different date, time, budget, or capacity. Unknown attributes cannot satisfy a required attribute filter.</p></div>}
    </section>
    <section className="container market-how"><div><p className="market-eyebrow">A SIMPLE WAY TO RESERVE</p><h2>Your office.<br />Your hours.</h2></div><ol><li><span>01</span><div><h3>Find your workspace</h3><p>Compare workspace groups and the individual offices inside.</p></div></li><li><span>02</span><div><h3>Reserve your time</h3><p>Review the full price and cancellation terms before secure Checkout.</p></div></li><li><span>03</span><div><h3>Arrive with the details</h3><p>Your reservation keeps access instructions, room readiness, and concierge together.</p></div></li></ol></section>
  </main>;
}

export function WorkspacePage() {
  const { id } = useParams();
  const { query, error: intervalError, startAt, endAt } = useInterval();
  const { data, loading, error, retry } = useRemote<{ group: Workspace; offices: Office[] }>(intervalError ? null : `/catalog/groups/${encodeURIComponent(id || '')}?${query}`);
  return <main className="container market-detail-page"><Link className="market-back" to={`/?${query}`}><ArrowLeft size={16} />All workspaces</Link><IntervalSummary startAt={startAt} endAt={endAt} query={query.toString()} />
    {(error || intervalError) && <RemoteError message={error || intervalError} retry={retry} />}{loading && <div className="market-loading" role="status">Loading workspace and individual availability…</div>}
    {data && !loading && !error && !intervalError && <><div className="market-workspace-intro"><div><p className="market-eyebrow">WORKSPACE · MODELED INVENTORY</p><h1>{data.group.name}</h1><p className="market-address"><MapPin size={18} />{data.group.address}</p><p className="market-description">{data.group.description || 'An explicitly grouped workspace with separately bookable offices.'}</p></div><div className="market-group-rate">{data.group.availableCount ? <><span>Offices from</span><strong>{money(data.group.lowestRateCents!)}</strong><span>per hour · before 10% service fee</span></> : <strong>No matching availability</strong>}</div></div>
      <div className="market-workspace-facts"><span><Building2 size={18} />{data.group.officeCount} individual offices</span><span><Clock3 size={18} />Configured hours {data.group.hours.open} to {data.group.hours.close}{data.group.hours.modeled ? ' (modeled)' : ''}</span><span>America/Los_Angeles</span></div>
      <div className="market-section-title"><div><p className="market-eyebrow">CHOOSE YOUR OFFICE</p><h2>One workspace. Your own room.</h2></div><span>{data.group.availableCount || 0} available for your time</span></div>
      <div className="market-office-grid">{data.offices.map(office => <article className="market-office-card" key={office.id}><Link to={`/offices/${office.id}?${query}`} aria-label={`View ${office.name}`}><Placeholder name={office.name} compact photos={office.photos} /></Link><div className="market-office-body"><div className="market-office-card-heading"><h3><Link to={`/offices/${office.id}?${query}`}>{office.name}</Link></h3><span className={`badge ${office.available ? 'market-badge-available' : ''}`}>{office.available ? 'Available' : 'Unavailable'}</span></div><p>{office.description}</p><p className="market-unknown">Capacity and amenities {Object.keys(office.attributes).length ? 'shown in office details' : 'not verified'}.</p>{!office.available && <p className="market-availability-reason">{office.availabilityReason}</p>}<div className="market-card-bottom"><span className="market-rate"><strong>{money(office.rateCents)}</strong> / hr</span><Link className="market-text-link" to={`/offices/${office.id}?${query}`}>View office<ArrowRight size={16} /></Link></div></div></article>)}</div>
      <div className="market-feedback"><h3>About this modeled inventory</h3><p>These offices are seed inventory for this application. Bookable hours are configurable test hours. Photos, capacity, amenities, dimensions, and building access stay unknown until verified.</p></div></>}
  </main>;
}

export function OfficePage() {
  const { id } = useParams(); const location = useLocation();
  const { user, loading: sessionLoading } = useSession();
  const { query, error: intervalError, startAt, endAt } = useInterval();
  const remote = useRemote<Office>(intervalError ? null : `/catalog/offices/${encodeURIComponent(id || '')}?${query}`);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const holdKey = useRef(crypto.randomUUID());
  const quoteRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setQuote(null); setReservation(null); setError(''); holdKey.current = crypto.randomUUID(); }, [id, startAt, endAt, user?.id]);
  async function run(action: string, task: () => Promise<void>) { setBusy(action); setError(''); try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Please try again.'); } finally { setBusy(''); } }
  const office = remote.data;
  const returnTo = `${location.pathname}?${query}`;
  return <main className="container market-detail-page"><Link className="market-back" to={office ? `/workspaces/${office.groupId}?${query}` : `/?${query}`}><ArrowLeft size={16} />{office?.workspace?.name || 'Back to workspaces'}</Link><IntervalSummary startAt={startAt} endAt={endAt} query={query.toString()} />
    {(remote.error || intervalError) && <RemoteError message={remote.error || intervalError} retry={remote.retry} />}{remote.loading && <div className="market-loading" role="status">Loading office…</div>}
    {office && !remote.loading && !remote.error && !intervalError && <><div className="market-office-title"><div><p className="market-eyebrow">INDIVIDUAL OFFICE · MODELED INVENTORY</p><h1>{office.name}</h1><p className="market-address"><MapPin size={18} />{office.workspace?.name}</p></div><span className={`badge ${office.available ? 'market-badge-available' : ''}`}>{office.available ? 'Available for your time' : 'Unavailable for your time'}</span></div>
      <div className="market-office-detail-layout"><section><Placeholder name={office.name} photos={office.photos} /><h2>A space for your hours.</h2><p className="market-description">{office.description}</p><dl className="market-office-facts"><div><dt>Workspace</dt><dd>{office.workspace?.name}</dd></div><div><dt>Capacity</dt><dd>{typeof office.attributes.capacity === 'number' ? `${office.attributes.capacity} people${office.attributes.synthetic ? ' (synthetic test attribute)' : ''}` : 'Not verified'}</dd></div><div><dt>Amenities</dt><dd>{Array.isArray(office.attributes.amenities) ? office.attributes.amenities.map(String).join(', ') : 'Not verified'}</dd></div><div><dt>Dimensions</dt><dd>{typeof office.attributes.dimensions === 'string' ? office.attributes.dimensions : 'Not verified'}</dd></div><div><dt>Bookable hours</dt><dd>{office.workspace?.hours.open} to {office.workspace?.hours.close} {office.workspace?.hours.modeled ? '(modeled test hours)' : ''}</dd></div><div><dt>Access instructions</dt><dd>Shown with your eligible confirmed reservation when configured.</dd></div></dl><div className="market-policy"><ShieldCheck size={22} /><div><h3>Cancellation policy</h3><p>{quote?.cancellationPolicy || CANCELLATION_POLICY}</p></div></div><p className="market-unknown">This is modeled inventory. The building, office conditions, hours, and access have not been verified as live supply.</p></section>
        <aside className="market-booking-panel" aria-label="Reservation and payment"><p className="market-eyebrow">YOUR TIME, YOUR OFFICE</p><p className="market-booking-rate"><strong>{money(office.rateCents)}</strong><span> / hour</span></p><div className="market-booking-time"><CalendarDays size={18} /><p>{intervalLabel(startAt, endAt)}</p></div><p className="market-booking-note">A 10% service fee is added. Review your exact total before holding this office.</p>
          {!office.available && <div className="market-feedback"><p>{office.availabilityReason || 'This office is unavailable for your selected time.'}</p><Link to={`/workspaces/${office.groupId}?${query}`}>See other offices</Link></div>}
          {sessionLoading && <p role="status" className="market-booking-note">Checking your sign-in…</p>}
          {!sessionLoading && !user && office.available && <Link className="button market-full-button" to={`/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in to get a quote<ArrowRight size={17} /></Link>}
          {!sessionLoading && user && office.available && !quote && <button className="button market-full-button" disabled={!!busy} onClick={() => run('quote', async () => { const value = await api<Quote>('/quotes', { method: 'POST', body: JSON.stringify({ roomId: office.id, startAt, endAt }) }); setQuote(value); setTimeout(() => quoteRef.current?.focus(), 0); })}>{busy === 'quote' ? 'Calculating…' : 'Get your exact quote'}<ArrowRight size={17} /></button>}
          {quote && <div className="market-quote" ref={quoteRef} tabIndex={-1}><h3>Your quote</h3><dl><div><dt>Office · {((endAt - startAt) / 3_600_000).toLocaleString()} hours</dt><dd>{money(quote.subtotalCents)}</dd></div><div><dt>Service fee (10%)</dt><dd>{money(quote.feeCents)}</dd></div><div className="market-quote-total"><dt>Total (USD)</dt><dd>{money(quote.totalCents)}</dd></div></dl><p className="market-unknown">Quote valid until {new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(quote.expiresAt)}.</p><details><summary>Review cancellation policy</summary><p>{quote.cancellationPolicy}</p></details>{!reservation && <button className="button market-full-button" disabled={!!busy} onClick={() => run('hold', async () => setReservation(await api<Reservation>('/reservations', { method: 'POST', body: JSON.stringify({ quoteId: quote.id, idempotencyKey: holdKey.current }) })))}>{busy === 'hold' ? 'Holding your office…' : 'Hold this office'}<ArrowDown size={17} /></button>}</div>}
          {reservation && <div className="market-held" role="status"><p><Check size={17} /><strong>Your office is held.</strong></p><p>Complete Checkout before the hold expires{reservation.holdExpiresAt ? ` at ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(reservation.holdExpiresAt)}` : ''}. Payment is confirmed by Stripe, then reflected in your reservation.</p><button className="button market-full-button" disabled={!!busy} onClick={() => run('checkout', async () => { const result = await api<{ url: string; reservation: Reservation }>(`/reservations/${reservation.id}/checkout`, { method: 'POST', body: JSON.stringify({}) }); window.location.assign(result.url); })}>{busy === 'checkout' ? 'Opening Checkout…' : 'Continue to secure Checkout'}<ArrowRight size={17} /></button><Link className="market-reservation-link" to={`/reservations/${reservation.id}`}>View reservation {reservation.id.slice(-8)}</Link></div>}
          {error && <><RemoteError message={error} />{quote && !reservation && <button className="button secondary market-full-button" disabled={!!busy} onClick={() => { setQuote(null); setError(''); }}>Get a fresh quote</button>}</>}
          <div className="market-secure"><ShieldCheck size={16} /><span>Stripe sandbox Checkout · no live charges</span></div>
        </aside>
      </div></>}
  </main>;
}
