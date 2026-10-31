import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { money, type BuildingDay, type Office, type Workspace } from '@odas/contracts';
import { Calendar, EmptyState, ErrorState, Loading, Photo, Popover } from '../ui';
import { closingOf, isRoomFree, openingOf, roomDay, type DayRange } from './availability';
import { useInterval, useRemote, intervalOnly } from './hooks';
import { RoomTimeline } from './RoomTimeline';
import { building, buildingTitle, filtersFrom, matchesFilters, roomPhotos, writeFilters } from './listing';
import { NO_FILTERS } from './SearchBar';
import { addDays, rangeLabel, toMinutes, toTime, zonedNow } from './time';

const longDate = (date: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
const navButton = 'flex h-9 w-9 items-center justify-center rounded-full border border-stone-300 bg-white text-stone-700 hover:border-stone-500 disabled:opacity-40';

function Legend() {
  return <div className="mt-3 flex flex-wrap gap-4 text-xs text-stone-600">
    <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-[4px] border border-forest/40 bg-mist" />Free at your time</span>
    <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-[4px] bg-stone-300/80" />Booked</span>
    <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-[4px]" style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgba(120,113,108,0.35) 0 2px, transparent 2px 6px)' }} />Past or turnover</span>
    <span className="flex items-center gap-1.5"><i className="h-3 w-0.5 bg-now" />Now</span>
  </div>;
}

function Toolbar({ date, onDate, summary }: { date: string; onDate: (date: string) => void; summary: string }) {
  const [open, setOpen] = useState(false);
  const today = zonedNow().date;
  return <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
    <div className="flex items-center gap-2">
      <button type="button" disabled={date === today} onClick={() => onDate(today)} className="h-9 rounded-full border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 hover:border-stone-500 disabled:opacity-40">Today</button>
      <button type="button" aria-label="Previous day" disabled={date <= today} onClick={() => onDate(addDays(date, -1))} className={navButton}><ChevronLeft className="h-4 w-4" /></button>
      <button type="button" aria-label="Next day" onClick={() => onDate(addDays(date, 1))} className={navButton}><ChevronRight className="h-4 w-4" /></button>
      <Popover label={`Choose a date, ${longDate(date)}`} open={open} onOpenChange={setOpen} className="z-[1300] w-auto p-0" buttonClassName="rounded-lg px-2 py-1 text-left font-serif text-xl font-semibold text-stone-900 hover:bg-mist" button={longDate(date)}>
        <Calendar selected={date} isDisabled={value => value < today} onSelect={value => { onDate(value); setOpen(false); }} />
      </Popover>
    </div>
    <p className="text-xs text-stone-500">Drag the time block to move it, or drag its edges to change the length</p>
    <p className="text-sm font-medium text-stone-700 lg:ml-auto" aria-live="polite">{summary}</p>
  </div>;
}

function BuildingDetail({ id }: { id: string }) {
  const { query, error: intervalError, selection } = useInterval();
  const [params, setParams] = useSearchParams();
  const remote = useRemote<{ group: Workspace; offices: Office[] }>(intervalError ? null : `/catalog/groups/${encodeURIComponent(id)}?${intervalOnly(query)}`);
  const availability = useRemote<BuildingDay>(`/catalog/groups/${encodeURIComponent(id)}/availability?date=${selection.date}`);
  const apply = (next: Partial<typeof selection>) => setParams(current => {
    const value = new URLSearchParams(current);
    for (const [key, text] of Object.entries(next)) value.set(key, text);
    value.delete('startAt'); value.delete('endAt');
    return value;
  }, { replace: true });
  const error = intervalError || remote.error || availability.error;
  if (error) return <div className="px-4 py-16"><ErrorState message={error} onRetry={intervalError ? undefined : () => { remote.retry(); availability.retry(); }} /></div>;
  const data = remote.data;
  const day = availability.data;
  if (!data || !day) return <Loading label="Loading rooms…" />;
  const { group, offices } = data;
  const place = building(group);
  const filters = filtersFrom(params);
  const rooms = offices.filter(office => matchesFilters(office, { ...filters, availableOnly: false })).sort((a, b) => a.rateCents - b.rateCents || a.id.localeCompare(b.id));
  const range = { start: toMinutes(selection.start), end: toMinutes(selection.end) };
  const now = zonedNow();
  const nowMinutes = selection.date === now.date ? now.minutes : selection.date < now.date ? 1440 : 0;
  const current = day.date === selection.date;
  const freeCount = rooms.filter(office => isRoomFree(roomDay(day, office), day, range, nowMinutes)).length;
  const backQuery = new URLSearchParams(query);
  backQuery.delete('startAt'); backQuery.delete('endAt');
  const roomHref = (office: Office, value: DayRange) => {
    const next = new URLSearchParams(backQuery);
    next.set('start', toTime(value.start)); next.set('end', toTime(value.end));
    return `/rooms/${office.id}?${next}`;
  };
  function pickDate(date: string) {
    const length = range.end - range.start;
    const earliest = Math.max(openingOf(day!), date === now.date ? 30 * Math.ceil(now.minutes / 30) : 0);
    const start = Math.max(earliest, Math.min(range.start, closingOf(day!) - length));
    apply({ date, start: toTime(start), end: toTime(start + length) });
  }
  const summary = day.closed ? 'This building is closed on this day.' : `${freeCount} of ${rooms.length} room${rooms.length === 1 ? '' : 's'} free, ${rangeLabel(range.start, range.end)}`;
  return <main className="mx-auto max-w-[1240px] px-4 pt-6 pb-16 sm:px-6">
    <Link to={`/?${backQuery}`} className="mb-4 inline-flex items-center gap-1 text-sm text-stone-600 hover:text-stone-900"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> All spaces</Link>
    <div className="mb-5 flex items-center gap-4">
      <Photo compact src={group.photos[0] ?? (offices[0] && roomPhotos(offices[0])[0])} alt={buildingTitle(group)} className="hidden h-20 w-28 shrink-0 rounded-xl sm:flex" />
      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl">{buildingTitle(group)}</h1>
        <p className="mt-1 text-stone-600">{place.neighborhood}, San Francisco · {offices.length} room{offices.length === 1 ? '' : 's'}{rooms[0] ? ` · from ${money(rooms[0].rateCents)} / hr` : ''}</p>
      </div>
    </div>
    {rooms.length < offices.length && rooms.length > 0 && <p className="mb-3 text-sm text-stone-600">Showing {rooms.length} of {offices.length} rooms that match your filters. <button onClick={() => setParams(writeFilters(params, NO_FILTERS), { replace: true })} className="font-medium text-forest underline underline-offset-4">Show all</button></p>}
    {rooms.length ? <>
      <Toolbar date={selection.date} summary={summary} onDate={pickDate} />
      <div className={current ? '' : 'opacity-60'}><RoomTimeline day={day} offices={rooms} range={range} nowMinutes={nowMinutes} settled={!remote.loading && current} href={roomHref} onChange={value => apply({ start: toTime(value.start), end: toTime(value.end) })} /></div>
      <Legend />
      <p className="mt-6 text-xs text-stone-400">Times shown in Pacific time. Modeled inventory. Property details and access are not verified as live supply.</p>
    </> : <EmptyState title="No rooms match your filters" text="Clear your filters to see every room in this building." action={<button onClick={() => setParams(writeFilters(params, NO_FILTERS), { replace: true })} className="rounded-full border border-stone-300 px-4 py-2 text-sm font-medium">Reset filters</button>} />}
  </main>;
}

export function BuildingPage() {
  const { id = '' } = useParams();
  return <BuildingDetail key={id} id={id} />;
}
