import { useState, type ReactNode } from 'react';
import { CalendarDays, Search, SlidersHorizontal } from 'lucide-react';
import { Calendar, Popover, Switch } from '../ui';
import { AMENITIES, CAPACITIES, NEIGHBORHOODS, ROOM_TYPES, activeFilterCount, type Filters } from './listing';
import { TimeColumn } from './TimeColumn';
import { dateLabel, durationLabel, rangeLabel, toMinutes, toTime, zonedNow } from './time';

export interface SearchValue { location: string; date: string; start: string; end: string }

const LAST_END = 1410;
const EMPTY: Filters = { minPrice: '', maxPrice: '', types: [], amenities: [], capacity: '', availableOnly: false };
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(item => item !== value) : [...values, value];

function WhenField({ value, onChange, className }: { value: SearchValue; onChange: (value: SearchValue) => void; className: string }) {
  const [open, setOpen] = useState(false);
  const now = zonedNow();
  const start = toMinutes(value.start);
  const end = toMinutes(value.end);
  const nowMinutes = value.date === now.date ? now.minutes : 0;
  const setRange = (from: number, to: number) => onChange({ ...value, start: toTime(from), end: toTime(to) });
  function pickDate(date: string) {
    const length = end - start;
    const earliest = date === now.date ? 30 * Math.ceil(now.minutes / 30) : 0;
    const from = Math.max(Math.min(Math.max(start, earliest), LAST_END - length), 0);
    onChange({ ...value, date, start: toTime(from), end: toTime(from + length) });
  }
  return <div className={`flex flex-col gap-1 ${className}`}>
    <span className="eyebrow">When</span>
    <Popover label={`When: ${dateLabel(value.date)}, ${rangeLabel(start, end)}`} open={open} onOpenChange={setOpen} sideOffset={8} className="z-[1300] w-[min(640px,calc(100vw-2rem))] p-4" buttonClassName={`flex h-11 w-full items-center gap-2 rounded-lg border bg-white px-3 text-left text-sm text-stone-900 transition-colors hover:border-stone-400 ${open ? 'border-forest' : 'border-stone-200'}`} button={<>
      <CalendarDays className="h-4 w-4 shrink-0 text-stone-500" aria-hidden="true" />
      <span className="truncate">{dateLabel(value.date)} · {rangeLabel(start, end)}</span>
      <span className="ml-auto shrink-0 text-xs text-stone-500">{durationLabel(end - start)}</span>
    </>}>
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="shrink-0 self-start rounded-xl border border-stone-200 bg-white"><Calendar selected={value.date} isDisabled={date => date < now.date} onSelect={pickDate} /></div>
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-[13px] font-medium text-stone-700">{dateLabel(value.date)} · {rangeLabel(start, end)}</p>
          <TimeColumn height={260} board={{ date: value.date, start, end, conflict: start < nowMinutes, closed: false, nowMinutes, busy: [], setRange }} />
        </div>
      </div>
      <div className="mt-4 flex justify-end"><button type="button" onClick={() => setOpen(false)} className="h-10 rounded-lg bg-forest px-5 text-sm font-medium text-white transition-colors hover:bg-forest-dark">Done</button></div>
    </Popover>
  </div>;
}

export function SearchBar({ value, onChange, onSubmit }: { value: SearchValue; onChange: (value: SearchValue) => void; onSubmit: () => void }) {
  return <form onSubmit={event => { event.preventDefault(); onSubmit(); }} className="grid grid-cols-2 gap-3 sm:grid-cols-6 lg:flex lg:items-end">
    <label className="col-span-2 flex flex-col gap-1 sm:col-span-6 lg:min-w-[200px] lg:flex-[1.4]">
      <span className="eyebrow">Location</span>
      <input list="odas-neighborhoods" placeholder="Neighborhood or address" value={value.location} onChange={event => onChange({ ...value, location: event.target.value })} className="h-11 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm text-stone-900 outline-none transition-colors focus:border-forest" />
      <datalist id="odas-neighborhoods">{NEIGHBORHOODS.map(name => <option key={name} value={name} />)}</datalist>
    </label>
    <WhenField value={value} onChange={onChange} className="col-span-2 sm:col-span-4 lg:w-[320px]" />
    <button type="submit" className="flex h-11 items-center justify-center gap-2 rounded-lg bg-forest px-5 text-sm font-medium text-white transition-colors hover:bg-forest-dark sm:col-span-2"><Search className="h-4 w-4" aria-hidden="true" /> Search</button>
  </form>;
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${active ? 'border-forest bg-forest text-white' : 'border-stone-200 bg-white text-stone-700 hover:border-stone-400'}`}>{children}</button>;
}

export function FiltersPopover({ value, onChange }: { value: Filters; onChange: (value: Filters) => void }) {
  const patch = (next: Partial<Filters>) => onChange({ ...value, ...next });
  const count = activeFilterCount(value);
  return <Popover label="Filters" className="z-[1100] w-[340px] max-w-[calc(100vw-1rem)] space-y-5 p-5" buttonClassName="inline-flex h-9 items-center gap-2 rounded-full border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 hover:border-stone-500" button={<>
    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> Filters {count > 0 && <span className="rounded-full bg-forest px-1.5 text-[11px] text-white">{count}</span>}
  </>}>
    <div>
      <p className="eyebrow mb-2">Price per hour (USD)</p>
      <div className="flex items-center gap-2">
        <input type="number" min={0} aria-label="Minimum price" placeholder="Min" value={value.minPrice} onChange={event => patch({ minPrice: event.target.value })} className="h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm" />
        <span className="text-stone-400">–</span>
        <input type="number" min={0} aria-label="Maximum price" placeholder="Max" value={value.maxPrice} onChange={event => patch({ maxPrice: event.target.value })} className="h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm" />
      </div>
    </div>
    <div>
      <p className="eyebrow mb-2">Room type</p>
      <div className="flex flex-wrap gap-2">{Object.entries(ROOM_TYPES).map(([key, label]) => <Chip key={key} active={value.types.includes(key)} onClick={() => patch({ types: toggle(value.types, key) })}>{label}</Chip>)}</div>
    </div>
    <div>
      <p className="eyebrow mb-2">Amenities</p>
      <div className="flex flex-wrap gap-2">{Object.entries(AMENITIES).map(([key, label]) => <Chip key={key} active={value.amenities.includes(key)} onClick={() => patch({ amenities: toggle(value.amenities, key) })}>{label}</Chip>)}</div>
    </div>
    <div>
      <p className="eyebrow mb-2">Capacity</p>
      <div className="flex flex-wrap gap-2">{Object.entries(CAPACITIES).map(([key, label]) => <Chip key={key} active={value.capacity === key} onClick={() => patch({ capacity: value.capacity === key ? '' : key })}>{label}</Chip>)}</div>
    </div>
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm font-medium text-stone-800">Available for the selected time</span>
      <Switch label="Available for the selected time" checked={value.availableOnly} onChange={availableOnly => patch({ availableOnly })} />
    </label>
    <button type="button" onClick={() => onChange(EMPTY)} className="text-sm font-medium text-stone-600 underline underline-offset-4">Clear all filters</button>
  </Popover>;
}

export { EMPTY as NO_FILTERS };
