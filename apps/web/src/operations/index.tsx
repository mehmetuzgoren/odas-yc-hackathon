import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams, useSearchParams, Navigate } from 'react-router-dom';
import { Temporal } from '@js-temporal/polyfill';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { TIMEZONE, TURNOVER_MS, money, type RoomSnapshot, type SearchResult } from '@odas/contracts';
import { api, useSession } from '../api';
import { RequireAuth } from '../auth';
import { building, roomName, roomPhotos, roomTitle, ROOM_TYPES } from '../marketplace/listing';
import { addDays, clockLabel, dateLabel, instantClock, instantDate, instantRange, toMinutes, toTime, zonedNow, zonedParts } from '../marketplace/time';
import { EmptyState, ErrorState, Loading, Notice, Photo, Switch, Tabs, toast } from '../ui';

const PinnedMap = lazy(() => import('../marketplace/MapView').then(module => ({ default: module.PinnedMap })));

type RoomRow = { id: string; name: string; groupId: string; workspaceName: string; rateCents: number; state: RoomSnapshot };
type Task = { id: string; room_id: string; room_name?: string; workspace_name?: string; reason: string; status: string; assignee?: string; resolution_evidence?: string; created_at: number };
type Detail = { office: { id: string; groupId: string; name: string; description: string; rateCents: number; rateOverrideCents: number | null; modeled: boolean; deviceBinding: unknown; photos: string[] }; workspace: { id: string; name: string; address: string; timezone: string; accessInstructions?: string | null; hours: { open?: string; close?: string; days?: number[]; modeled?: boolean } }; state: RoomSnapshot; upcoming: { id: string; start_at: number; end_at: number; status: string; payment_status: string }[]; tasks: Task[]; audit: { id: string; actor: string; action: string; created_at: number }[]; deviceMode: string; now: number };
type DemoStatus = { mode: string; captureFps: number; jevEnabled: boolean; roboEnabled: boolean; camera: { connected: boolean; capturedAt: number | null; framesCaptured: number }; vision: { completed: number; failed: number; dropped: number; inFlight: number; lastLatencyMs: number | null; lastError: string | null; retryAfterMs: number }; inspection: RoomSnapshot['inspection']; state: RoomSnapshot; dockResult?: { accepted?: boolean; uncertain?: boolean; message?: string } };
type Status = 'in_use' | 'free' | 'cleaning' | 'unpublished';
type Picked = { bookingId: string; startAt: number; endAt: number; status: string; room: RoomRow };

const words = (value: string) => value.replaceAll('_', ' ');
const message = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
const clock = (at: number | null | undefined, zone = TIMEZONE) => at ? `${instantDate(at, zone)}, ${instantClock(at, zone)}` : 'Unknown';
const field = 'h-11 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm outline-none focus:border-forest disabled:bg-stone-50 disabled:text-stone-500';
const textarea = 'w-full rounded-lg border border-stone-200 p-3 text-sm outline-none focus:border-forest';
const primary = 'rounded-lg bg-forest px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-forest-dark disabled:opacity-50';
const secondary = 'rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-800 transition-colors hover:border-stone-500 disabled:opacity-50';
const STATUS_LABEL: Record<Status | 'live', string> = { in_use: 'In use', free: 'Free now', cleaning: 'Cleaning', unpublished: 'Unpublished', live: 'Live' };
const STATUS_DOT: Record<Status | 'live', string> = { in_use: 'bg-forest', free: 'bg-moss', cleaning: 'bg-amber-400', unpublished: 'bg-stone-300', live: 'bg-moss' };
const STRIP: Record<Status, string> = { in_use: 'bg-forest', free: 'bg-fern', cleaning: 'bg-amber-400', unpublished: 'border border-dashed border-stone-400 bg-transparent' };

function roomStatus(room: RoomRow): Status {
  const { state } = room;
  if (state.operational !== 'available') return 'unpublished';
  if (state.occupancy === 'occupied' || state.intervals.some(interval => interval.status === 'checked_in')) return 'in_use';
  if (state.job && ['requested', 'dispatching', 'started'].includes(state.job.status)) return 'cleaning';
  return 'free';
}

function useHostRooms() {
  const [rooms, setRooms] = useState<RoomRow[] | null>(null);
  const [openTasks, setOpenTasks] = useState(0);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    const [inventory, attention] = await Promise.all([api<{ rooms: RoomRow[] }>('/operator/rooms'), api<{ tasks: Task[] }>('/operator/tasks')]);
    setRooms(inventory.rooms); setOpenTasks(attention.tasks.filter(task => task.status !== 'resolved').length); setError('');
  }, []);
  useEffect(() => {
    let active = true;
    let timer: number;
    // Wait for each read to finish: it can outlast the interval, and overlapping reads only slow each other down.
    const poll = () => reload().catch(cause => { if (active) setError(message(cause)); }).finally(() => { if (active) timer = window.setTimeout(() => void poll(), 10_000); });
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [reload]);
  return { rooms, openTasks, error, reload };
}

const buildingsOf = (rooms: RoomRow[]) => [...rooms.reduce((map, room) => map.set(room.groupId, [...(map.get(room.groupId) || []), room]), new Map<string, RoomRow[]>()).values()];
const isLive = (rooms: RoomRow[]) => rooms.some(room => room.state.operational === 'available');

function BuildingItem({ rooms, selected, onSelect }: { rooms: RoomRow[]; selected: boolean; onSelect: () => void }) {
  const first = rooms[0]!;
  const place = building({ id: first.groupId, name: first.workspaceName });
  const inUse = rooms.filter(room => roomStatus(room) === 'in_use').length;
  return <button type="button" onClick={onSelect} aria-pressed={selected} className={`w-60 shrink-0 rounded-xl border p-3 text-left transition-colors lg:w-full ${selected ? 'border-forest bg-mist' : 'border-stone-200 bg-white hover:border-stone-400'}`}>
    <p className="truncate font-semibold text-stone-900">{place.street}</p>
    <p className="truncate text-xs text-stone-500">{place.suite} · {place.neighborhood}</p>
    <p className="mt-1 flex justify-between text-xs text-stone-600"><span>{rooms.length} room{rooms.length === 1 ? '' : 's'}</span><span>{isLive(rooms) ? `${inUse} in use` : 'Not live'}</span></p>
    <div className="mt-2 flex h-1.5 gap-px">{rooms.map(room => <span key={room.id} title={`${roomName(room.name)}: ${words(roomStatus(room))}`} className={`flex-1 rounded-[2px] ${STRIP[roomStatus(room)]}`} />)}</div>
  </button>;
}

const DAY_START = 360;
const HOUR = 56;
const HOURS = 18;
const TRACK = HOUR * HOURS;
const hatch = { backgroundImage: 'repeating-linear-gradient(135deg, rgba(120,113,108,0.25) 0 2px, transparent 2px 6px)' };
const toX = (minutes: number) => (Math.max(minutes, DAY_START) - DAY_START) / 60 * HOUR;

function minutesOn(instant: number, date: string, zone: string) {
  const value = zonedParts(instant, zone);
  return value.date < date ? 0 : value.date > date ? 1440 : value.minutes;
}

function barTime(start: number, end: number) {
  return [start, end].map(value => `${(Math.floor(value / 60) % 24 + 11) % 12 + 1}${value % 60 ? `:${String(value % 60).padStart(2, '0')}` : ''}`).join('–');
}

function Bars({ room, date, today, nowMinutes, selected, onPick }: { room: RoomRow; date: string; today: boolean; nowMinutes: number; selected?: string; onPick: (picked: Picked) => void }) {
  return <>
    {room.state.intervals.filter(interval => interval.status !== 'canceled').map(interval => {
      const start = minutesOn(interval.startAt, date, TIMEZONE);
      const end = minutesOn(interval.endAt, date, TIMEZONE);
      const clean = minutesOn(interval.endAt + TURNOVER_MS, date, TIMEZONE);
      if ((end <= DAY_START && clean <= DAY_START) || start >= 1440 || end <= 0) return null;
      const now = today && start <= nowMinutes && nowMinutes < end;
      const tone = (today && end <= nowMinutes) || interval.status === 'checked_out' ? 'bg-sage text-stone-600' : 'bg-forest text-white';
      const text = `${interval.status === 'held' ? 'Held' : 'Guest'} · ${barTime(start, end)}`;
      return <span key={interval.bookingId}>
        {clean > end && <div className="absolute inset-y-2 rounded-r-[4px]" style={{ left: toX(end), width: toX(clean) - toX(end), ...hatch }} />}
        <button type="button" title={text} onClick={() => onPick({ ...interval, room })} style={{ left: toX(start), width: Math.max(toX(end) - toX(start), 6) }} className={`absolute inset-y-2 truncate overflow-hidden rounded-md px-2 text-left text-xs font-medium transition-shadow ${tone} ${now ? 'ring-2 ring-now ring-offset-1' : ''} ${selected === interval.bookingId ? 'outline-2 outline-offset-2 outline-stone-900' : ''}`}>{text}</button>
      </span>;
    })}
    {room.state.blocks.map(block => {
      const start = minutesOn(block.startAt, date, TIMEZONE);
      const end = minutesOn(block.endAt, date, TIMEZONE);
      if (end <= DAY_START || start >= 1440) return null;
      return <div key={block.id} title={block.reason} style={{ left: toX(start), width: Math.max(toX(end) - toX(start), 6) }} className="absolute inset-y-2 truncate rounded-md bg-stone-300/80 px-2 py-2 text-xs font-medium text-stone-700">Maintenance</div>;
    })}
  </>;
}

function ScheduleGrid({ rooms, date, today, nowMinutes, selected, onPick }: { rooms: RoomRow[]; date: string; today: boolean; nowMinutes: number; selected?: string; onPick: (picked: Picked) => void }) {
  return <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white">
    <div style={{ width: 150 + TRACK }}>
      <div className="flex border-b border-stone-200 bg-sand py-2">
        <div className="sticky left-0 z-20 w-[150px] shrink-0 bg-sand px-3 text-[11px] font-semibold tracking-wider text-stone-500 uppercase">Room</div>
        <div className="flex" style={{ width: TRACK }}>{Array.from({ length: HOURS }, (_, index) => { const hour = 6 + index; return <span key={hour} className="shrink-0 border-l border-stone-200 pl-1 text-[11px] text-stone-400" style={{ width: HOUR }}>{(hour + 11) % 12 + 1} {hour < 12 ? 'AM' : 'PM'}</span>; })}</div>
      </div>
      {rooms.map(room => {
        const live = room.state.operational === 'available';
        const status = today ? roomStatus(room) : live ? 'live' : 'unpublished';
        return <div key={room.id} className="flex border-b border-stone-100 last:border-0">
          <div className="sticky left-0 z-20 w-[150px] shrink-0 border-r border-stone-100 bg-white px-3 py-2">
            <Link to={`/host/rooms/${room.id}/monitor`} className="text-sm font-semibold text-stone-900 hover:underline">{roomName(room.name)}</Link>
            <p className="flex items-center gap-1.5 text-xs text-stone-500"><span className={`h-2 w-2 rounded-full ${STATUS_DOT[status]}`} />{STATUS_LABEL[status]}</p>
          </div>
          <div className={`relative h-14 ${live ? '' : 'bg-[#EFE6D2]'}`} style={{ width: TRACK }}>
            {Array.from({ length: HOURS }, (_, index) => <span key={index} className="absolute inset-y-0 border-l border-stone-100" style={{ left: HOUR * index }} />)}
            <Bars room={room} date={date} today={today} nowMinutes={nowMinutes} selected={selected} onPick={onPick} />
            {today && nowMinutes >= DAY_START && <span className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-now" style={{ left: toX(nowMinutes) }} />}
          </div>
        </div>;
      })}
    </div>
  </div>;
}

function BookingDetailStrip({ picked, street }: { picked: Picked | null; street: string }) {
  const [payment, setPayment] = useState('');
  useEffect(() => {
    setPayment('');
    if (!picked) return;
    let active = true;
    api<Detail>(`/operator/rooms/${picked.room.id}`).then(detail => { if (active) setPayment(detail.upcoming.find(booking => booking.id === picked.bookingId)?.payment_status || ''); }).catch(() => {});
    return () => { active = false; };
  }, [picked?.bookingId]);
  if (!picked) return <p className="rounded-2xl border border-dashed border-stone-300 p-4 text-sm text-stone-500">Select a booking to see its details.</p>;
  return <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-2xl border border-stone-200 bg-white p-4 text-sm">
    <p className="font-semibold text-stone-900">{street} · {roomName(picked.room.name)}</p>
    <p className="text-stone-700">{instantDate(picked.startAt)} · {instantRange(picked.startAt, picked.endAt)}</p>
    <p className="font-mono text-stone-700">{picked.bookingId.slice(-8).toUpperCase()}</p>
    <p className="text-stone-700 capitalize">{words(picked.status)}{payment ? ` · ${words(payment)}` : ''}</p>
    <p className="text-stone-500">cleaning until {instantClock(picked.endAt + TURNOVER_MS)}</p>
    <Link to={`/host/rooms/${picked.room.id}/monitor`} className="ml-auto text-sm font-medium text-forest hover:underline">Open monitor</Link>
  </div>;
}

function Schedule({ rooms }: { rooms: RoomRow[] }) {
  const today = zonedNow().date;
  const [groupId, setGroupId] = useState<string | null>(null);
  const [date, setDate] = useState(today);
  const [picked, setPicked] = useState<Picked | null>(null);
  const buildings = useMemo(() => buildingsOf(rooms), [rooms]);
  useEffect(() => setPicked(null), [groupId, date]);
  if (!buildings.length) return <p className="text-sm text-stone-600">No buildings yet.</p>;
  const current = buildings.find(list => list[0]!.groupId === groupId) || buildings[0]!;
  const first = current[0]!;
  const place = building({ id: first.groupId, name: first.workspaceName });
  const isToday = date === today;
  const days = [0, 1, 2, 3].map(offset => addDays(today, offset));
  const live = current.filter(room => room.state.operational === 'available');
  let booked = 0;
  for (const room of live) for (const interval of room.state.intervals) { if (interval.status !== 'canceled') booked += Math.max(0, Math.min(minutesOn(interval.endAt, date, TIMEZONE), 1440) - Math.max(minutesOn(interval.startAt, date, TIMEZONE), DAY_START)); }
  const total = HOURS * live.length;
  const hours = booked / 60;
  const groups: [string, RoomRow[][]][] = [['Live', buildings.filter(isLive)], ['Not live yet', buildings.filter(list => !isLive(list))]];
  return <div className="flex flex-col gap-6 lg:flex-row">
    <aside className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 lg:mx-0 lg:w-[236px] lg:shrink-0 lg:flex-col lg:overflow-visible lg:px-0">
      {groups.map(([name, list]) => list.length > 0 && <div key={name} className="flex gap-2 lg:flex-col">
        <p className="hidden pt-2 text-[11px] font-semibold tracking-[0.14em] text-stone-500 uppercase lg:block">{name}</p>
        {list.map(item => <BuildingItem key={item[0]!.groupId} rooms={item} selected={item === current} onSelect={() => setGroupId(item[0]!.groupId)} />)}
      </div>)}
    </aside>
    <div className="min-w-0 flex-1 space-y-4">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.14em] text-stone-500 uppercase">{place.neighborhood} · {money(first.rateCents)}/hr per room</p>
        <h2 className="font-serif text-3xl font-semibold text-stone-900">{place.street} <span className="text-stone-400">· {place.suite}</span></h2>
      </div>
      <div className="flex flex-wrap gap-1.5" role="tablist">{days.map((day, index) => <button key={day} role="tab" aria-selected={day === date} onClick={() => setDate(day)} className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${day === date ? 'bg-forest text-white' : 'border border-stone-200 bg-white text-stone-700 hover:border-stone-400'}`}>{index === 0 ? 'Today' : dateLabel(day)}</button>)}</div>
      <ScheduleGrid rooms={current} date={date} today={isToday} nowMinutes={zonedNow().minutes} selected={picked?.bookingId} onPick={setPicked} />
      <BookingDetailStrip picked={picked} street={place.street} />
      <div className="flex flex-wrap gap-4 text-xs text-stone-600">
        <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-[4px] bg-forest" />Booked</span>
        <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-[4px] bg-sage" />Finished</span>
        <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-[4px]" style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgba(120,113,108,0.35) 0 2px, transparent 2px 6px)' }} />Cleaning</span>
        <span className="flex items-center gap-1.5"><i className="h-3 w-0.5 bg-now" />Now</span>
      </div>
      <p className="text-sm text-stone-600">{isToday ? 'Today' : dateLabel(date)}: {Number.isInteger(hours) ? hours : hours.toFixed(1)} of {total} room-hours booked between 6 AM and midnight ({total ? Math.round(hours / total * 100) : 0}%)</p>
    </div>
  </div>;
}

function publish(room: RoomRow, published: boolean) {
  return api(`/operator/rooms/${room.id}`, { method: 'PATCH', body: JSON.stringify({ operational: published ? 'available' : 'blocked', reason: published ? 'Host published this room' : 'Host unpublished this room' }) });
}

function ListingCard({ room, catalog, onChanged }: { room: RoomRow; catalog: SearchResult | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const office = catalog?.offices.find(value => value.id === room.id);
  const hours = office?.workspace?.hours;
  const place = building({ id: room.groupId, name: room.workspaceName });
  const published = room.state.operational === 'available';
  async function toggle(next: boolean) {
    setBusy(true);
    try { await publish(room, next); toast(next ? 'Listing published' : 'Listing unpublished'); onChanged(); }
    catch (error) { toast(message(error), 'error'); }
    finally { setBusy(false); }
  }
  return <article className="flex flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white">
    <Photo src={office ? roomPhotos(office)[0] : undefined} className="h-40 w-full" />
    <div className="flex flex-1 flex-col gap-3 p-4">
      <div>
        <p className="font-semibold text-stone-900">{roomName(room.name)}</p>
        <p className="text-sm text-stone-500">{place.neighborhood} · {ROOM_TYPES.private_office}</p>
        <p className="mt-1 text-sm text-stone-600">{money(room.rateCents)}/hr{hours ? ` · ${clockLabel(toMinutes(hours.open))}–${clockLabel(toMinutes(hours.close))}` : ''} · {TURNOVER_MS / 60_000}-min buffer</p>
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-stone-100 pt-3">
        <label className="flex items-center gap-2 text-sm"><Switch label={`Publish ${roomName(room.name)}`} checked={published} disabled={busy} onChange={next => void toggle(next)} />{published ? 'Published' : 'Unpublished'}</label>
        <div className="flex gap-3 text-sm font-medium">
          <Link to={`/rooms/${room.id}`} className="text-stone-600 hover:text-stone-900">View</Link>
          <Link to={`/host/rooms/${room.id}/monitor`} className="text-stone-600 hover:text-stone-900">Monitor</Link>
          <Link to={`/host/listings/${room.id}`} className="text-forest hover:underline">Edit</Link>
        </div>
      </div>
    </div>
  </article>;
}

function Listings({ rooms, onChanged }: { rooms: RoomRow[]; onChanged: () => void }) {
  const [catalog, setCatalog] = useState<SearchResult | null>(null);
  useEffect(() => { api<SearchResult>('/catalog/search').then(setCatalog).catch(() => {}); }, []);
  const buildings = buildingsOf(rooms);
  return <div>
    <p className="mb-6 text-sm text-stone-600">{rooms.length} rooms in {buildings.length} building{buildings.length === 1 ? '' : 's'}</p>
    {buildings.length ? <div className="space-y-10">{buildings.map(list => {
      const first = list[0]!;
      const place = building({ id: first.groupId, name: first.workspaceName });
      return <section key={first.groupId}>
        <h3 className="font-serif text-2xl font-semibold text-stone-900">{place.street} · {place.suite}</h3>
        <p className="mb-4 text-sm text-stone-500">{place.neighborhood} · {list.length} room{list.length === 1 ? '' : 's'}</p>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">{list.map(room => <ListingCard key={room.id} room={room} catalog={catalog} onChanged={onChanged} />)}</div>
      </section>;
    })}</div> : <EmptyState title="No listings yet" text="No workspaces are assigned to this account." />}
  </div>;
}

function TaskList({ tasks, onChanged }: { tasks: Task[]; onChanged: () => void }) {
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [assignees, setAssignees] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function run(path: string, body: unknown, method: string, done: string) {
    setBusy(true);
    try { await api(path, { method, body: JSON.stringify(body) }); toast(done); onChanged(); }
    catch (error) { toast(message(error), 'error'); }
    finally { setBusy(false); }
  }
  if (!tasks.length) return <EmptyState title="Nothing needs attention" text="Rooms that need a person will show up here." />;
  return <div className="space-y-3">{tasks.map(task => <article key={task.id} className="rounded-xl border border-stone-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="font-semibold text-stone-900">{task.reason}</p>
        <p className="text-sm text-stone-500">{task.room_name ? roomName(task.room_name) : task.room_id}{task.workspace_name ? ` · ${task.workspace_name}` : ''} · {clock(task.created_at)}{task.assignee ? ` · Assigned to ${task.assignee}` : ''}</p>
      </div>
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${task.status === 'resolved' ? 'bg-mist text-forest' : 'bg-amber-50 text-amber-800'}`}>{words(task.status)}</span>
    </div>
    {task.status === 'resolved' ? <p className="mt-2 text-sm text-stone-600">{task.resolution_evidence}</p> : <div className="mt-3 grid gap-3 md:grid-cols-[1fr_2fr]">
      <div className="space-y-2">
        <label className="flex flex-col gap-1.5"><span className="eyebrow">Assignee</span><input value={assignees[task.id] ?? task.assignee ?? ''} onChange={event => setAssignees({ ...assignees, [task.id]: event.target.value })} className={field} /></label>
        <button disabled={busy || !(assignees[task.id] || task.assignee)} onClick={() => void run(`/operator/tasks/${task.id}`, { assignee: assignees[task.id] || task.assignee }, 'PATCH', 'Task assigned.')} className={secondary}>Assign</button>
      </div>
      <div className="space-y-2">
        <label className="flex flex-col gap-1.5"><span className="eyebrow">Resolution evidence</span><textarea rows={2} placeholder="Describe the work completed and what you observed." minLength={10} value={resolution[task.id] || ''} onChange={event => setResolution({ ...resolution, [task.id]: event.target.value })} className={textarea} /></label>
        <button disabled={busy || (resolution[task.id] || '').length < 10} onClick={() => void run(`/operator/tasks/${task.id}/resolve`, { evidence: resolution[task.id] }, 'POST', 'Task resolved. A fresh successful inspection is still required for readiness.')} className={secondary}>Resolve task</button>
      </div>
    </div>}
  </article>)}</div>;
}

function Attention({ onChanged }: { onChanged: () => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { api<{ tasks: Task[] }>('/operator/tasks').then(data => setTasks(data.tasks)).catch(cause => setError(message(cause))); }, []);
  useEffect(load, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!tasks) return <Loading />;
  return <div className="max-w-4xl space-y-4"><p className="text-sm text-stone-600">Resolving a task records evidence. Room readiness comes from fresh inspections and device observations.</p><TaskList tasks={tasks} onChanged={() => { load(); onChanged(); }} /></div>;
}

function HostTabs() {
  const [params, setParams] = useSearchParams();
  const { rooms, openTasks, error, reload } = useHostRooms();
  const tab = (params.get('tab') || 'overview') as 'overview' | 'listings' | 'attention';
  return <>
    <Tabs className="mb-8" value={tab} onChange={value => setParams({ tab: value })} items={[{ value: 'overview', label: 'Schedule' }, { value: 'listings', label: 'Listings' }, { value: 'attention', label: openTasks ? `Attention (${openTasks})` : 'Attention' }]} />
    <div className="mt-2">{tab === 'attention' ? <Attention onChanged={() => void reload()} /> : error && !rooms ? <ErrorState message={error} onRetry={() => void reload()} /> : !rooms ? <Loading /> : tab === 'listings' ? <Listings rooms={rooms} onChanged={() => void reload()} /> : <Schedule rooms={rooms} />}</div>
  </>;
}

// Signed-out visitors can still sign in here; anyone else without listings has no dashboard to see.
function HostGate({ title, children }: { title: string; children: ReactNode }) {
  const { user, isHost, loading } = useSession();
  if (!loading && user && !isHost) return <Navigate replace to="/" />;
  return <RequireAuth title={title}>{children}</RequireAuth>;
}

export function HostPage() {
  return <main className="mx-auto max-w-[1400px] px-4 py-10 sm:px-6">
    <p className="eyebrow mb-2">Host dashboard</p>
    <h1 className="mb-8 font-serif text-4xl font-semibold tracking-tight text-stone-900">Your spaces</h1>
    <HostGate title="Sign in to manage your spaces"><HostTabs /></HostGate>
  </main>;
}

function useRoomDetail(id: string) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const reload = useCallback(() => api<Detail>(`/operator/rooms/${id}`).then(data => { setDetail(data); setError(''); setLive(true); }), [id]);
  useEffect(() => {
    reload().catch(cause => setError(message(cause)));
    const timer = window.setInterval(() => { reload().catch(() => setLive(false)); }, 10_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return { detail, error, live, reload };
}

const HALF_HOURS = Array.from({ length: 48 }, (_, index) => toTime(index * 30));
const timeOptions = (current?: string) => [...new Set([...HALF_HOURS, ...(current ? [current] : [])])].sort().map(value => <option key={value} value={value}>{clockLabel(toMinutes(value))}</option>);

// Rooms without a camera binding have no live status, so a failed poll means "no controls" rather than an error.
function useDemoStatus(id: string) {
  const [demo, setDemo] = useState<DemoStatus | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 250;
      if (!document.hidden) {
        try { const next = await api<DemoStatus>(`/operator/rooms/${id}/demo`); if (active) setDemo(next); }
        catch { if (active) setDemo(null); delay = 5000; }
      }
      if (active) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [id]);
  return [demo, setDemo] as const;
}

function Label({ text, className = '', children }: { text: string; className?: string; children: ReactNode }) {
  return <label className={`flex flex-col gap-1.5 ${className}`}><span className="eyebrow">{text}</span>{children}</label>;
}

function Blocks({ detail, onChanged }: { detail: Detail; onChanged: () => Promise<void> }) {
  const [date, setDate] = useState(zonedNow().date);
  const [start, setStart] = useState('12:00');
  const [end, setEnd] = useState('14:00');
  const [reason, setReason] = useState('Maintenance');
  const [busy, setBusy] = useState(false);
  const zone = detail.workspace.timezone;
  const input = 'h-10 rounded-lg border border-stone-200 bg-white px-3 text-sm';
  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const instant = (value: string) => Temporal.PlainDateTime.from(`${date}T${value}`).toZonedDateTime(zone, { disambiguation: 'reject' }).epochMilliseconds;
      await api(`/operator/rooms/${detail.office.id}/blocks`, { method: 'POST', body: JSON.stringify({ startAt: instant(start), endAt: instant(end), reason }) });
      toast('Maintenance block added'); await onChanged();
    } catch (error) { toast(error instanceof RangeError ? 'Select a valid date and time. Ambiguous daylight saving times require a different interval.' : message(error), 'error'); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    try { await api(`/operator/rooms/${detail.office.id}/blocks/${id}`, { method: 'DELETE', body: JSON.stringify({}) }); toast('Block removed'); await onChanged(); }
    catch (error) { toast(message(error), 'error'); }
  }
  return <section className="rounded-2xl border border-stone-200 bg-white p-6">
    <h2 className="font-serif text-xl font-semibold">Maintenance blocks</h2>
    <p className="mb-4 text-sm text-stone-500">Blocked periods can't be booked. Pacific time.</p>
    <form onSubmit={add} className="flex flex-wrap items-end gap-3">
      <input aria-label="Block date" type="date" required value={date} onChange={event => setDate(event.target.value)} className={input} />
      <select aria-label="Block start" value={start} onChange={event => setStart(event.target.value)} className={input}>{timeOptions(start)}</select>
      <select aria-label="Block end" value={end} onChange={event => setEnd(event.target.value)} className={input}>{timeOptions(end)}</select>
      <input aria-label="Reason" required value={reason} onChange={event => setReason(event.target.value)} placeholder="Reason" className={`${input} min-w-[160px] flex-1`} />
      <button disabled={busy} className="h-10 rounded-lg bg-stone-900 px-4 text-sm font-medium text-white disabled:opacity-50">Add block</button>
    </form>
    <ul className="mt-5 divide-y divide-stone-100">
      {!detail.state.blocks.length && <li className="py-3 text-sm text-stone-500">No upcoming blocks.</li>}
      {detail.state.blocks.map(block => <li key={block.id} className="flex items-center justify-between py-3 text-sm">
        <span>{instantDate(block.startAt, zone)} · {instantRange(block.startAt, block.endAt, zone)} · <span className="text-stone-500">{block.reason}</span></span>
        <button onClick={() => void remove(block.id)} aria-label="Remove block" className="p-1 text-stone-400 hover:text-red-700"><Trash2 className="h-4 w-4" /></button>
      </li>)}
    </ul>
  </section>;
}

function ListingForm({ detail, onChanged }: { detail: Detail; onChanged: () => Promise<void> }) {
  const { office, workspace, state } = detail;
  const [description, setDescription] = useState(office.description);
  const [rate, setRate] = useState(office.rateOverrideCents === null ? '' : String(office.rateOverrideCents / 100));
  const [access, setAccess] = useState(workspace.accessInstructions || '');
  const [open, setOpen] = useState(workspace.hours.open || '');
  const [close, setClose] = useState(workspace.hours.close || '');
  const [days, setDays] = useState<number[]>(workspace.hours.days || []);
  const [modeled, setModeled] = useState(workspace.hours.modeled ?? true);
  const [published, setPublished] = useState(state.operational === 'available');
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ group: { latitude: number; longitude: number } }>(`/catalog/groups/${encodeURIComponent(office.groupId)}`).then(data => setLocation(data.group)).catch(() => {}); }, [office.groupId]);
  async function save(event: FormEvent) {
    event.preventDefault();
    const amount = rate === '' ? null : Math.round(Number(rate) * 100);
    if (amount !== null && (!Number.isFinite(amount) || amount < 1)) { toast('Enter a positive hourly rate, or leave it blank to use the workspace rate.', 'error'); return; }
    setBusy(true);
    try {
      const operational = published ? 'available' : state.operational === 'available' ? 'blocked' : state.operational;
      await api(`/operator/rooms/${office.id}`, { method: 'PATCH', body: JSON.stringify({ description, rateCents: amount, accessInstructions: access.trim() || null, ...(open && close ? { hours: { open, close, days, modeled } } : {}), operational, reason: 'Host listing update' }) });
      toast('Listing saved'); await onChanged();
    } catch (error) { toast(message(error), 'error'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={save} className="space-y-8 rounded-2xl border border-stone-200 bg-white p-6">
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <Label text="Title" className="md:col-span-2"><input disabled value={roomTitle({ id: office.groupId, name: workspace.name }, office.name)} className={field} /></Label>
      <Label text="Room type"><input disabled value={ROOM_TYPES.private_office} className={field} /></Label>
      <Label text="Neighborhood"><input disabled value={building({ id: office.groupId, name: workspace.name }).neighborhood} className={field} /></Label>
      <Label text="Hourly rate (USD)"><input type="number" min={0.01} step="0.01" value={rate} placeholder={`${(office.rateCents / 100).toFixed(2)} (workspace rate)`} onChange={event => setRate(event.target.value)} className={field} /></Label>
      <Label text="Description" className="md:col-span-2"><textarea rows={4} maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} className={textarea} /></Label>
      <Label text="Access instructions (private, shown only to guests with a confirmed booking)" className="md:col-span-2"><textarea rows={3} maxLength={6000} value={access} placeholder="Unknown. Enter only confirmed access instructions." onChange={event => setAccess(event.target.value)} className={textarea} /></Label>
    </div>
    <div>
      <p className="eyebrow mb-2">Photos ({office.photos.length}/8) — the first photo is the cover</p>
      {office.photos.length ? <div className="flex flex-wrap gap-3">{office.photos.map((photo, index) => <div key={photo} className="relative h-24 w-32 overflow-hidden rounded-lg border border-stone-200"><img src={photo} alt="" className="h-full w-full object-cover" />{index === 0 && <span className="absolute top-1 left-1 rounded-[4px] bg-white/90 px-1.5 text-[10px] font-medium">Cover</span>}</div>)}</div> : <p className="text-sm text-stone-500">No verified photos for this room yet.</p>}
    </div>
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <Label text="Address (shown approximately)" className="md:col-span-2"><input disabled value={workspace.address} className={field} /></Label>
      {location && <div className="md:col-span-2"><Suspense fallback={<Loading label="Loading map…" />}><PinnedMap latitude={location.latitude} longitude={location.longitude} /></Suspense></div>}
    </div>
    <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
      <Label text="Opens"><select value={open} onChange={event => setOpen(event.target.value)} className={field}>{timeOptions(open)}</select></Label>
      <Label text="Closes"><select value={close} onChange={event => setClose(event.target.value)} className={field}>{timeOptions(close)}</select></Label>
      <Label text="Turnover buffer (minutes)"><input disabled value={TURNOVER_MS / 60_000} className={field} /></Label>
      <div className="md:col-span-3">
        <p className="eyebrow mb-2">Open on</p>
        <div className="flex flex-wrap gap-2">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => {
          const active = days.includes(index + 1);
          return <button key={day} type="button" aria-pressed={active} onClick={() => setDays(active ? days.filter(value => value !== index + 1) : [...days, index + 1].sort())} className={`w-12 rounded-lg border py-1.5 text-xs font-medium ${active ? 'border-forest bg-mist text-forest' : 'border-stone-200 text-stone-400'}`}>{day}</button>;
        })}</div>
      </div>
      <label className="flex items-center gap-2 text-sm text-stone-600 md:col-span-3"><input type="checkbox" checked={modeled} onChange={event => setModeled(event.target.checked)} /> Hours are modeled for testing and have not been verified as property access hours</label>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-stone-100 pt-6">
      <label className="flex items-center gap-2 text-sm"><Switch label="Published in Explore" checked={published} onChange={setPublished} /> Published in Explore</label>
      <button disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-forest px-6 py-2.5 text-sm font-medium text-white disabled:opacity-50">Save changes</button>
    </div>
  </form>;
}

function ListingEditor({ id }: { id: string }) {
  const { detail, error, reload } = useRoomDetail(id);
  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (!detail) return <Loading />;
  return <div className="space-y-8"><ListingForm key={detail.office.id} detail={detail} onChanged={reload} /><Blocks detail={detail} onChanged={reload} /></div>;
}

export function ListingEditorPage() {
  const { id = '' } = useParams();
  return <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
    <Link to="/host?tab=listings" className="mb-6 inline-flex items-center gap-1 text-sm text-stone-600 hover:text-stone-900"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Listings</Link>
    <h1 className="mb-8 font-serif text-4xl font-semibold tracking-tight">Edit listing</h1>
    <HostGate title="Sign in as a host"><ListingEditor id={id} /></HostGate>
  </main>;
}

function Chip({ tone = 'stone', children }: { tone?: 'green' | 'amber' | 'red' | 'stone'; children: ReactNode }) {
  const style = { green: 'bg-mist text-forest', amber: 'bg-amber-50 text-amber-800', red: 'bg-red-50 text-red-800', stone: 'bg-stone-100 text-stone-700' }[tone];
  return <span className={`rounded-full px-3 py-1 text-xs font-semibold ${style}`}>{children}</span>;
}

function phaseOf(state: RoomSnapshot) {
  if (state.attentionReasons.length) return { label: 'Needs attention', reason: `${state.attentionReasons.join('. ')}.`, tone: 'border-red-300 bg-red-50 text-red-900' };
  if (state.job && ['requested', 'dispatching', 'started'].includes(state.job.status)) return { label: 'Cleaning', reason: state.job.reason || 'Vendor acceptance and observed motion are separate stages.', tone: 'border-sky-300 bg-sky-50 text-sky-900' };
  if (state.occupancy === 'occupied') return { label: 'Occupied', reason: 'Someone is in the room. Cleaning waits until they leave.', tone: 'border-red-300 bg-red-50 text-red-900' };
  if (state.readiness === 'ready') return { label: 'Ready', reason: 'The room is ready for the next guest.', tone: 'border-forest/30 bg-mist text-forest' };
  if (state.readiness === 'not_ready') return { label: 'Needs cleaning', reason: 'Fresh evidence shows the room is not ready for arrival.', tone: 'border-amber-300 bg-amber-50 text-amber-900' };
  return { label: 'Awaiting inspection', reason: 'Readiness stays unknown until a fresh inspection completes.', tone: 'border-amber-300 bg-amber-50 text-amber-900' };
}

function Step({ number, title, on, children }: { number: number; title: string; on: boolean; children: ReactNode }) {
  return <li className={`rounded-xl border p-4 transition-colors ${on ? 'border-forest/40 bg-white' : 'border-stone-200 bg-white/60 opacity-70'}`}>
    <p className="mb-2 text-[11px] font-semibold tracking-[0.14em] text-stone-500 uppercase">{number} · {title}</p>
    {children}
  </li>;
}

const OCCUPANCY = { vacant: ['No one', 'bg-mist text-forest'], occupied: ['Someone is there', 'bg-red-50 text-red-800'], unknown: ["Can't tell", 'bg-amber-50 text-amber-800'] } as const;

function Steps({ detail, state, demo }: { detail: Detail; state: RoomSnapshot; demo: DemoStatus | null }) {
  const inspection = demo?.inspection ?? state.inspection;
  const job = state.job;
  const device = state.device;
  const ready = state.expectedReadyAt || job?.expectedReadyAt;
  const [occupancy, tone] = OCCUPANCY[inspection?.occupancy ?? 'unknown'];
  return <ol className="space-y-3">
    <Step number={1} title="Photo" on={!!inspection}>{inspection ? <p className="text-sm text-stone-600">Captured {clock(inspection.capturedAt)} · {inspection.source}</p> : <p className="text-sm text-stone-500">No check yet</p>}</Step>
    <Step number={2} title={demo ? 'Jev' : 'Inspection'} on={!!inspection}>{inspection ? <div className="space-y-2 text-sm">
      <p>Anyone in the room? <span className={`ml-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{occupancy} · {Math.round(100 * (inspection.confidence || 0))}%</span></p>
      <p>Floor <b className="capitalize">{inspection.floor}</b> · Surfaces <b className="capitalize">{inspection.surfaces}</b></p>
      <p className="text-xs text-stone-500">Inference returned {clock(inspection.inferredAt)}{demo?.vision.lastLatencyMs != null ? ` · ${demo.vision.lastLatencyMs} ms` : ''} · Revision {state.revision}</p>
    </div> : <p className="text-sm text-stone-500">{demo ? 'Waiting for Jev' : 'Waiting for an inspection'}</p>}</Step>
    <Step number={3} title="Decision" on={!!inspection}><p className="text-sm">{phaseOf(state).reason}</p><p className="mt-1 text-xs text-stone-500 capitalize">{words(state.readiness)} · {state.operational}</p>{ready && <p className="mt-1 text-xs text-stone-500">Expected readiness {clock(ready)} ({job?.estimateSource === 'configured' ? 'configured estimate; no measured history yet' : 'estimate from cleaning history'}{ready < detail.now && state.readiness !== 'ready' ? '; estimate has passed, readiness is uncertain' : ''})</p>}</Step>
    <Step number={4} title="Robot" on={['cleaning', 'returning'].includes(device?.state ?? '')}>
      <p className="text-sm"><b>{device?.state || 'unknown'}</b> · {device?.connection || 'unverified'}{device ? ` · ${device.source}` : ''}</p>
      {device?.battery != null && <div className="mt-2"><div className="relative h-2.5 rounded-full bg-stone-200"><div className="h-full rounded-full bg-forest transition-[width] duration-300" style={{ width: `${device.battery}%` }} /></div><p className="mt-1 text-xs text-stone-500">Battery {device.battery}%</p></div>}
    </Step>
    <Step number={5} title="Cleaning job" on={!!job}>{job ? <><p className="text-sm capitalize">{words(job.status)}</p><p className="mt-1 text-xs text-stone-500">{job.reason || 'Vendor acceptance and observed motion are separate stages.'} · Job {job.id}</p></> : <p className="text-sm">No cleaning job has been requested.</p>}</Step>
  </ol>;
}

function Monitor({ id }: { id: string }) {
  const { detail, error, live, reload } = useRoomDetail(id);
  const [demo, setDemo] = useDemoStatus(id);
  const [busy, setBusy] = useState(false);
  const [dockNote, setDockNote] = useState('');
  const [cameraFailed, setCameraFailed] = useState(false);
  const captured = detail?.state.inspection?.capturedAt;
  useEffect(() => setCameraFailed(false), [captured, demo?.camera.connected]);
  async function configure(changes: { jevEnabled?: boolean; roboEnabled?: boolean }) {
    setBusy(true);
    try {
      const next = await api<DemoStatus>(`/operator/rooms/${id}/demo`, { method: 'PATCH', body: JSON.stringify(changes) });
      setDemo(next);
      setDockNote(next.dockResult && (next.dockResult.uncertain || next.dockResult.accepted === false) ? next.dockResult.message || 'Dock delivery is uncertain. Check the observed robot state.' : '');
    } catch (cause) { toast(message(cause), 'error'); }
    finally { setBusy(false); }
  }
  async function run(path: string, done: string) {
    setBusy(true);
    try {
      const result = await api<any>(`/operator/rooms/${id}/${path}`, { method: 'POST', body: JSON.stringify({}) });
      if (result?.accepted === false || result?.ok === false) throw new Error(result.message || (result.uncertain ? 'Command delivery is uncertain. Reconcile observed device state before retrying.' : 'The device action was not accepted.'));
      await reload(); toast(done);
    } catch (cause) { toast(message(cause), 'error'); }
    finally { setBusy(false); }
  }
  if (error && !detail) return <p className="rounded-2xl border border-stone-200 bg-white p-6 text-stone-700">The Room Monitor is only available to this room's host. ({error})</p>;
  if (!detail) return <Loading label="Connecting to the room…" />;
  const { office, workspace } = detail;
  const state = demo?.state ?? detail.state;
  const phase = phaseOf(state);
  const simulated = detail.deviceMode === 'simulator';
  const stale = !!demo?.camera.capturedAt && Date.now() - demo.camera.capturedAt > 10_000;
  const camera = demo ? (!demo.camera.connected ? 'disconnected' : stale ? 'stale' : 'connected') : state.inspection?.connection;
  return <div className="space-y-6">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <Link to="/demo" className="text-sm text-stone-500 hover:underline">← All rooms</Link>
        <h1 className="font-serif text-3xl font-semibold text-stone-900 sm:text-4xl">{roomTitle({ id: office.groupId, name: workspace.name }, office.name)}</h1>
        <div className="mt-2 flex flex-wrap gap-2">
          <Chip tone={live ? 'green' : 'red'}>{live ? 'Live updates' : 'Reconnecting…'}</Chip>
          <Chip tone={camera === 'connected' ? 'green' : camera === 'disconnected' ? 'red' : 'amber'}>{camera === 'connected' ? 'Camera live' : camera === 'disconnected' ? 'Camera offline' : camera === 'stale' ? 'Camera stale' : 'Camera unverified'}</Chip>
          <Chip tone={simulated ? 'amber' : 'green'}>{simulated ? 'Simulated vacuum' : detail.deviceMode === 'physical' ? 'Physical adapter' : 'Adapter unavailable'}</Chip>
          <Chip>{office.modeled ? 'Modeled inventory' : 'Configured inventory'}</Chip>
        </div>
      </div>
      {demo && <div className="flex items-center gap-5">
        <label className="flex items-center gap-2 text-sm font-medium">Monitor on<Switch label="Monitor on (Jev)" checked={demo.jevEnabled} disabled={busy} onChange={jevEnabled => void configure({ jevEnabled })} /></label>
        <label className="flex items-center gap-2 text-sm font-medium">Auto clean<Switch label="Auto clean (Robo)" checked={demo.roboEnabled} disabled={busy} onChange={roboEnabled => void configure({ roboEnabled })} /></label>
      </div>}
    </header>
    <section className={`rounded-2xl border p-5 ${phase.tone}`}>
      <p className="font-serif text-3xl font-semibold">{phase.label}</p>
      <p className="mt-1 text-sm">{phase.reason}</p>
      {demo && <p className="mt-2 text-xs opacity-80">{demo.jevEnabled && demo.camera.connected ? `Live checks at ${demo.captureFps} frames per second` : `Checks paused (${demo.jevEnabled ? 'camera offline' : 'monitor off'})`} · {demo.vision.completed} so far{demo.vision.lastLatencyMs !== null ? ` · last took ${(demo.vision.lastLatencyMs / 1000).toFixed(1)} s` : ''}{demo.vision.dropped ? ` · ${demo.vision.dropped} skipped` : ''}</p>}
      <p className={`text-xs opacity-80 ${demo ? 'mt-0.5' : 'mt-2'}`}>Evidence captured {clock(state.inspection?.capturedAt)} · Revision {state.revision}</p>
      {demo?.vision.lastError && <p className="mt-1 text-sm font-medium text-red-700">{demo.vision.lastError}{demo.vision.retryAfterMs ? ` Retrying in ${Math.ceil(demo.vision.retryAfterMs / 1000)} s.` : ''}</p>}
      {dockNote && <p role="status" className="mt-1 text-sm font-medium text-red-700">{dockNote}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => void run('inspect', 'Inspection requested and recorded.')} className={primary}>Inspect room</button>
        <button disabled={busy || state.operational !== 'available' || demo?.roboEnabled === false} title={demo?.roboEnabled === false ? 'Turn on Auto clean first' : undefined} onClick={() => void run('clean', 'Cleaning request recorded. Dispatch still requires actor authorization and observed vacancy.')} className={secondary}>Request vacuum clean</button>
        <button disabled={busy} onClick={() => void run('dock', 'Dock request recorded. Check observed robot state for completion.')} className={secondary}>Return to dock</button>
      </div>
    </section>
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.25fr_1fr]">
      <section className="space-y-3">
        <div className={`relative overflow-hidden rounded-2xl border-4 bg-stone-900 transition-colors ${demo?.vision.inFlight ? 'border-sky-500' : 'border-transparent'}`}>
          {cameraFailed ? <div className="flex aspect-video items-center justify-center px-6 text-center text-sm text-stone-400">{simulated ? 'No verified camera frame is available. Simulated observations do not contain camera photos.' : 'No camera frames yet'}</div>
            : <img src={demo ? `/api/operator/rooms/${id}/stream` : `/api/operator/rooms/${id}/frame?at=${captured ?? 0}`} alt={`Latest restricted camera frame for ${roomName(office.name)}`} onError={() => setCameraFailed(true)} className="aspect-video w-full object-contain" />}
          {stale && <span className="absolute top-3 left-3 rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-white">Stale: no new frame for 10 s</span>}
        </div>
        <p className="text-xs text-stone-500">{simulated ? 'Device observations are simulated and explicitly bound to configured offices. Other offices remain unverified.' : 'Connection status reflects configured adapters. Commissioning must verify the private camera route and Q10 cloud commands.'}</p>
      </section>
      <Steps detail={detail} state={state} demo={demo} />
    </div>
    <section className="rounded-2xl border border-stone-200 bg-white p-5">
      <h2 className="mb-3 font-serif text-xl font-semibold">Upcoming reservations</h2>
      {detail.upcoming.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-stone-200 text-xs text-stone-500"><th className="py-2 pr-4 font-medium">Reservation</th><th className="py-2 pr-4 font-medium">Interval ({workspace.timezone})</th><th className="py-2 pr-4 font-medium">Status</th><th className="py-2 font-medium">Payment</th></tr></thead><tbody className="divide-y divide-stone-100">{detail.upcoming.map(booking => <tr key={booking.id}><td className="py-2 pr-4 font-mono text-xs">{booking.id.slice(-8).toUpperCase()}</td><td className="py-2 pr-4">{clock(booking.start_at, workspace.timezone)} to {instantClock(booking.end_at, workspace.timezone)}</td><td className="py-2 pr-4 capitalize">{words(booking.status)}</td><td className="py-2 capitalize">{words(booking.payment_status)}</td></tr>)}</tbody></table></div> : <p className="text-sm text-stone-500">No upcoming reservations.</p>}
    </section>
    <section className="space-y-3 rounded-2xl border border-stone-200 bg-white p-5">
      <h2 className="font-serif text-xl font-semibold">Attention tasks</h2>
      <TaskList tasks={detail.tasks} onChanged={() => void reload()} />
    </section>
    <section className="rounded-2xl border border-stone-200 bg-white p-5">
      <h2 className="mb-3 font-serif text-xl font-semibold">Timeline</h2>
      <ul className="max-h-72 space-y-1.5 overflow-y-auto text-sm">
        {detail.audit.map(entry => <li key={entry.id} className="flex gap-3"><span className="w-36 shrink-0 font-mono text-xs text-stone-400">{clock(entry.created_at)}</span><span className="text-stone-700 capitalize">{words(entry.action.replaceAll('.', ' '))}</span></li>)}
        {!detail.audit.length && <li className="text-stone-500">Nothing yet</li>}
      </ul>
    </section>
    {error && <Notice tone="error">{error}</Notice>}
  </div>;
}

function MonitorRooms() {
  const { rooms, error, reload } = useHostRooms();
  const [catalog, setCatalog] = useState<SearchResult | null>(null);
  const [monitored, setMonitored] = useState<string[]>([]);
  const shown = useMemo(() => rooms ? buildingsOf(rooms).map(list => list[0]!) : [], [rooms]);
  const ids = shown.map(room => room.id).join();
  useEffect(() => { api<SearchResult>('/catalog/search').then(setCatalog).catch(() => {}); }, []);
  useEffect(() => {
    let active = true;
    Promise.allSettled(shown.map(room => api<DemoStatus>(`/operator/rooms/${room.id}/demo`).then(status => status.jevEnabled ? room.id : ''))).then(results => {
      if (active) setMonitored(results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []));
    });
    return () => { active = false; };
  }, [ids]);
  if (error && !rooms) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (!rooms) return <Loading />;
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {shown.map(first => {
      const office = catalog?.offices.find(value => value.id === first.id);
      return <Link key={first.id} to={`/demo/rooms/${first.id}`} className="overflow-hidden rounded-2xl border border-stone-200 bg-white transition-shadow hover:shadow-md">
        <Photo src={office ? roomPhotos(office)[0] : undefined} className="h-36 w-full" />
        <div className="p-4">
          <p className="font-semibold text-stone-900">{roomTitle({ id: first.groupId, name: first.workspaceName }, first.name)}</p>
          <p className="text-sm text-stone-500">{monitored.includes(first.id) ? `Monitor on · ${phaseOf(first.state).label.toLowerCase()}` : 'Monitor off'}</p>
        </div>
      </Link>;
    })}
  </div>;
}

export function RoomMonitorPage() {
  const { id } = useParams();
  return <main className="mx-auto max-w-[1240px] px-4 py-8 sm:px-6">
    {!id && <><p className="eyebrow">Demo</p><h1 className="mb-6 font-serif text-4xl font-semibold">Room Monitor</h1></>}
    <HostGate title="Sign in as the host to open the Room Monitor">{id ? <Monitor id={id} /> : <MonitorRooms />}</HostGate>
    <p className="mt-10 text-xs text-stone-400">Times shown in Pacific time · {new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(Date.now())}</p>
  </main>;
}
