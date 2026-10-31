import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { money, type BuildingDay, type Office } from '@odas/contracts';
import { Photo } from '../ui';
import { closingOf, isRoomFree, openingOf, roomDay, type DayRange } from './availability';
import { quoteTotal, roomName, roomPhotos } from './listing';
import { durationLabel, rangeLabel, shortClock } from './time';

const MIN_LENGTH = 60;
const MAX_LENGTH = 720;
const DRAG_DISTANCE = 4;
const floor30 = (minutes: number) => 30 * Math.floor(minutes / 30);
const ceil30 = (minutes: number) => 30 * Math.ceil(minutes / 30);
const round30 = (minutes: number) => 30 * Math.round(minutes / 30);
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const hatch = { backgroundImage: 'repeating-linear-gradient(135deg, rgba(120,113,108,0.22) 0 2px, transparent 2px 7px)' };

type Drag = { x: number; y: number; moved: boolean } & ({ mode: 'create'; anchor: number } | { mode: 'move'; offset: number } | { mode: 'start' | 'end' | 'tap' });

// Dragging only begins once the pointer travels, so a plain press on a Book block still opens the room.
function useEventDrag(day: BuildingDay, range: DayRange, earliest: number, onChange: (range: DayRange) => void, minuteAt: (event: PointerEvent) => number) {
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);
  const [preview, setPreview] = useState<DayRange | null>(null);
  const close = closingOf(day);
  const length = range.end - range.start;
  const locked = day.closed || earliest + MIN_LENGTH > close;
  const moveTo = (start: number, size = length) => { const value = clamp(start, earliest, close - size); return { start: value, end: value + size }; };
  const resizeEnd = (end: number) => ({ start: range.start, end: clamp(end, range.start + MIN_LENGTH, Math.min(range.start + MAX_LENGTH, close)) });
  const resizeStart = (start: number) => ({ start: clamp(start, Math.max(earliest, range.end - MAX_LENGTH), range.end - MIN_LENGTH), end: range.end });
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    dragged.current = false;
    const target = event.target as HTMLElement;
    if (locked || event.button !== 0 || !target.closest('[data-track]')) return;
    const role = target.closest<HTMLElement>('[data-role]')?.dataset.role;
    const minute = minuteAt(event);
    const pressed = { x: event.clientX, y: event.clientY, moved: false };
    if (role === 'start' || role === 'end') drag.current = { ...pressed, mode: role };
    else if (role === 'sel') drag.current = { ...pressed, mode: 'move', offset: minute - range.start };
    else if (event.pointerType === 'touch') drag.current = { ...pressed, mode: 'tap' };
    else drag.current = { ...pressed, mode: 'create', anchor: floor30(minute) };
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.mode === 'tap') return;
    if (!current.moved) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_DISTANCE) return;
      current.moved = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const minute = minuteAt(event);
    if (current.mode === 'move') setPreview(moveTo(round30(minute - current.offset)));
    else if (current.mode === 'start') setPreview(resizeStart(round30(minute)));
    else if (current.mode === 'end') setPreview(resizeEnd(round30(minute)));
    else if (current.mode === 'create' && minute >= current.anchor) {
      const start = Math.max(earliest, current.anchor);
      setPreview({ start, end: Math.min(Math.max(ceil30(minute), start + MIN_LENGTH), start + MAX_LENGTH, close) });
    } else if (current.mode === 'create') {
      const end = Math.min(close, current.anchor + 30);
      const start = Math.max(floor30(minute), earliest, end - MAX_LENGTH);
      setPreview({ start: Math.min(start, end - MIN_LENGTH), end });
    }
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    dragged.current = current.moved;
    if (current.moved) { if (preview) onChange(preview); }
    else if (current.mode === 'create') onChange(moveTo(current.anchor));
    else if (current.mode === 'tap' && Math.hypot(event.clientX - current.x, event.clientY - current.y) <= 6) onChange(moveTo(floor30(minuteAt(event))));
    setPreview(null);
  }
  function onKeyDown(event: KeyboardEvent) {
    if (locked || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -30 : 30;
    onChange(event.shiftKey ? resizeEnd(range.end + step) : moveTo(range.start + step));
  }
  const handlers = {
    onPointerDown, onPointerMove, onPointerUp,
    onPointerCancel: () => { drag.current = null; setPreview(null); },
    onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => { if (dragged.current) { event.preventDefault(); event.stopPropagation(); dragged.current = false; } },
  };
  return { preview, locked, handlers, onKeyDown };
}

function Edges({ start, end }: { start: number; end: number }) {
  const edge = 'absolute inset-y-0 z-20 w-2.5 -translate-x-1/2 cursor-ew-resize [@media(pointer:coarse)]:w-6';
  return <>
    <span data-role="start" className={edge} style={{ left: `${start}%`, touchAction: 'none' }} />
    <span data-role="end" className={edge} style={{ left: `${end}%`, touchAction: 'none' }} />
  </>;
}

function StatusDot({ free }: { free: boolean }) {
  return <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${free ? 'text-forest' : 'text-stone-400'}`}><span className={`h-1.5 w-1.5 rounded-full ${free ? 'bg-forest' : 'bg-stone-300'}`} />{free ? 'Free' : 'Not free'}</span>;
}

interface Props { day: BuildingDay; offices: Office[]; range: DayRange; nowMinutes: number; settled: boolean; href: (office: Office, range: DayRange) => string; onChange: (range: DayRange) => void }

export function RoomTimeline({ day, offices, range, nowMinutes, settled, href, onChange }: Props) {
  const ruler = useRef<HTMLDivElement>(null);
  const open = openingOf(day);
  const close = closingOf(day);
  const start = clamp(range.start, open, close - MIN_LENGTH);
  const fitted = { start, end: clamp(range.end, start + MIN_LENGTH, close) };
  const { preview, locked, handlers, onKeyDown } = useEventDrag(day, fitted, Math.max(open, ceil30(nowMinutes)), onChange, event => {
    const rect = ruler.current!.getBoundingClientRect();
    return open + clamp((event.clientX - rect.left) / rect.width, 0, 1) * (close - open);
  });
  const shown = preview ?? fitted;
  const length = shown.end - shown.start;
  const percent = (minutes: number) => (clamp(minutes, open, close) - open) / (close - open) * 100;
  const left = percent(shown.start);
  const right = percent(shown.end);
  const width = right - left;
  const hours = Array.from({ length: Math.floor((close - open) / 60) + 1 }, (_, index) => open + index * 60);
  const free = (office: Office) => isRoomFree(roomDay(day, office), day, shown, nowMinutes) && (preview !== null || !settled || office.available !== false);
  const anyFree = offices.some(free);
  return <div {...handlers} className="overflow-x-auto rounded-2xl border border-stone-200 bg-white lg:overflow-visible">
    <div className="min-w-[920px]">
      <div className="flex rounded-t-2xl border-b border-stone-200 bg-sand lg:sticky lg:top-16 lg:z-30">
        <div className="sticky left-0 z-20 flex w-[230px] shrink-0 items-center rounded-tl-2xl border-r border-stone-200 bg-sand px-3 text-[11px] font-semibold tracking-wider text-stone-500 uppercase">Room</div>
        <div ref={ruler} data-track className="relative h-12 flex-1 select-none">
          {hours.slice(0, -1).map(hour => <span key={hour} className="absolute top-2 pl-1 text-[11px] text-stone-400" style={{ left: `${percent(hour)}%` }}>{shortClock(hour)}</span>)}
          {!locked && <>
            <div data-role="sel" role="slider" tabIndex={0} aria-label="Selected time. Drag to move it, or drag its edges to change its length. Arrow keys move it, Shift and arrow keys change its length." aria-valuemin={open} aria-valuemax={close} aria-valuenow={shown.start} aria-valuetext={rangeLabel(shown.start, shown.end)} onKeyDown={onKeyDown} style={{ left: `${left}%`, width: `${width}%`, touchAction: 'none' }} className={`absolute inset-y-1 z-10 flex cursor-grab flex-col justify-center overflow-hidden rounded-lg px-2.5 text-white shadow-md transition-colors active:cursor-grabbing ${anyFree ? 'bg-forest' : 'bg-red-600'}`}>
              <span className="truncate text-sm leading-tight font-semibold">{rangeLabel(shown.start, shown.end)}</span>
              {anyFree ? length >= 90 && <span className="truncate text-xs leading-tight opacity-80">{durationLabel(length)}</span> : <span className="truncate text-xs leading-tight opacity-90">No rooms free</span>}
            </div>
            <Edges start={left} end={right} />
          </>}
        </div>
      </div>
      {offices.map(office => {
        const room = roomDay(day, office);
        const available = free(office);
        const total = quoteTotal(office.rateCents, length).total;
        return <div key={office.id} className="flex border-b border-stone-100 last:border-0">
          <Link to={href(office, shown)} className="sticky left-0 z-20 flex w-[230px] shrink-0 items-center gap-3 border-r border-stone-100 bg-white p-2 hover:bg-stone-50">
            <Photo compact src={roomPhotos(office)[0]} alt="" className="h-[72px] w-24 shrink-0 rounded-lg" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-stone-900">{roomName(office.name)}</span>
              <span className="block text-xs text-stone-600">{money(office.rateCents)} / hr</span>
              <StatusDot free={available} />
            </span>
          </Link>
          <div data-track className={`relative flex-1 select-none ${day.closed || room?.bookable === false ? 'bg-stone-50' : ''}`}>
            {hours.map(hour => <span key={hour} className="absolute inset-y-0 border-l border-stone-100" style={{ left: `${percent(hour)}%` }} />)}
            {day.closed || room?.bookable === false ? <div className="absolute inset-0" style={hatch} /> : nowMinutes > open && <div className="absolute inset-y-0 left-0" style={{ width: `${percent(nowMinutes)}%`, ...hatch }} />}
            {room?.busy.map(span => {
              const buffer = span.kind === 'booked' ? day.bufferMinutes : 0;
              return <div key={`${span.kind}-${span.from}`}>
                {buffer > 0 && <div className="absolute inset-y-3 rounded-sm" style={{ left: `${percent(span.from - buffer)}%`, width: `${percent(span.to + buffer) - percent(span.from - buffer)}%`, ...hatch }} />}
                <div className="absolute inset-y-3 flex items-center overflow-hidden rounded-md bg-stone-300/80 px-2 text-[11px] font-medium whitespace-nowrap text-stone-700" style={{ left: `${percent(span.from)}%`, width: `${percent(span.to) - percent(span.from)}%` }}>{span.kind === 'booked' ? rangeLabel(span.from, span.to) : 'Unavailable'}</div>
              </div>;
            })}
            {!locked && <>
              <div data-role="sel" className="absolute inset-y-0 z-[5] cursor-grab border-x border-forest/30 bg-forest/5 active:cursor-grabbing" style={{ left: `${left}%`, width: `${width}%`, touchAction: 'pan-y' }} />
              {available && <Link data-role="sel" to={href(office, shown)} draggable={false} aria-label={`Book ${roomName(office.name)}, ${rangeLabel(shown.start, shown.end)}, ${money(total)} total`} style={{ left: `${left}%`, width: `${width}%`, touchAction: 'pan-y' }} className="absolute inset-y-2.5 z-10 flex flex-col justify-center overflow-hidden rounded-md border border-forest/40 bg-mist px-2 whitespace-nowrap text-forest shadow-xs transition-colors hover:border-forest hover:bg-forest hover:text-white">
                <span className="text-xs leading-tight font-semibold">Book</span>
                <span className="text-[11px] leading-tight opacity-80">{money(total)} total</span>
              </Link>}
              <Edges start={left} end={right} />
            </>}
            {nowMinutes > open && nowMinutes < close && <span className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-now" style={{ left: `${percent(nowMinutes)}%` }} />}
          </div>
        </div>;
      })}
    </div>
  </div>;
}
