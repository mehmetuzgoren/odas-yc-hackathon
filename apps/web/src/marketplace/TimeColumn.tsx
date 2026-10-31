import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { durationLabel, rangeLabel } from './time';

const HOUR = 48;
const LAST_END = 1410;
const MIN_LENGTH = 60;
const MAX_LENGTH = 720;
const toY = (minutes: number) => minutes / 60 * HOUR;
const floor30 = (minutes: number) => 30 * Math.floor(minutes / 30);
const ceil30 = (minutes: number) => 30 * Math.ceil(minutes / 30);
const round30 = (minutes: number) => 30 * Math.round(minutes / 30);
const hatch = { backgroundImage: 'repeating-linear-gradient(135deg, rgba(120,113,108,0.22) 0 2px, transparent 2px 7px)' };
const BOOKED = 'That time is booked. Pick an open time.';
const coarsePointer = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

export interface BusyBlock { from: number; to: number; kind: 'closed' | 'booked' | 'blocked' }
export interface TimeBoard { date: string; start: number; end: number; conflict: boolean; closed: boolean; nowMinutes: number; busy: BusyBlock[]; setRange: (start: number, end: number) => void }
type Drag = { mode: 'create'; anchor: number } | { mode: 'move'; offset: number } | { mode: 'resize' } | { mode: 'tap'; y: number };

function limits(busy: BusyBlock[], nowMinutes: number) {
  const minStart = Math.max(0, ceil30(nowMinutes));
  const nextLimit = (from: number) => { let limit = LAST_END; busy.forEach(block => { if (block.from >= from) limit = Math.min(limit, block.from); }); return floor30(limit); };
  const prevLimit = (to: number) => { let limit = minStart; busy.forEach(block => { if (block.to <= to) limit = Math.max(limit, block.to); }); return ceil30(limit); };
  const startFor = (minute: number): { start?: number; error?: string } => {
    if (minute < nowMinutes) return { error: 'That time has already passed.' };
    if (busy.some(block => block.from <= minute && block.to > minute)) return { error: BOOKED };
    const start = Math.max(floor30(minute), prevLimit(minute));
    return nextLimit(start) - start < MIN_LENGTH ? { error: BOOKED } : { start };
  };
  return { minStart, nextLimit, prevLimit, startFor };
}

export function TimeColumn({ board, height = 480 }: { board: TimeBoard; height?: number | string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { busy, nowMinutes } = board;
  const bounds = limits(busy, nowMinutes);
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = toY(board.start) + 12 > 384 + element.clientHeight ? toY(board.start) - 60 : 384;
    setMessage(null);
  }, [board.date]);
  const minuteAt = (event: PointerEvent) => Math.max(0, Math.min(1439, (event.clientY - track.current!.getBoundingClientRect().top) / HOUR * 60));
  function apply(minute: number) {
    const current = drag.current;
    if (!current || current.mode === 'tap') return;
    if (current.mode === 'create') {
      if (minute >= current.anchor) {
        const start = current.anchor;
        board.setRange(start, Math.min(Math.max(ceil30(minute), start + MIN_LENGTH), start + MAX_LENGTH, bounds.nextLimit(start), LAST_END));
      } else {
        const end = current.anchor + 30;
        const start = Math.max(floor30(minute), bounds.prevLimit(current.anchor), end - MAX_LENGTH);
        board.setRange(start, Math.min(Math.max(end, start + MIN_LENGTH), bounds.nextLimit(start)));
      }
    } else if (current.mode === 'move') {
      const length = board.end - board.start;
      const start = Math.min(Math.max(round30(minute - current.offset), bounds.minStart), LAST_END - length);
      board.setRange(start, start + length);
    } else {
      const limit = Math.min(board.start + MAX_LENGTH, LAST_END, Math.max(board.start + MIN_LENGTH, bounds.nextLimit(board.start)));
      board.setRange(board.start, Math.min(Math.max(round30(minute), board.start + MIN_LENGTH), limit));
    }
  }
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (board.closed) return;
    const role = (event.target as HTMLElement).closest<HTMLElement>('[data-role]')?.dataset.role;
    const minute = minuteAt(event);
    if (role === 'edge') drag.current = { mode: 'resize' };
    else if (role === 'sel') drag.current = { mode: 'move', offset: minute - board.start };
    else {
      if (event.pointerType === 'touch') { drag.current = { mode: 'tap', y: event.clientY }; return; }
      const found = bounds.startFor(minute);
      if (found.error || found.start === undefined) { setMessage(found.error ?? BOOKED); return; }
      drag.current = { mode: 'create', anchor: found.start };
      apply(minute);
    }
    setMessage(null);
    event.preventDefault();
    track.current?.setPointerCapture?.(event.pointerId);
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    drag.current = null;
    if (current?.mode !== 'tap' || Math.abs(event.clientY - current.y) > 6) return;
    const found = bounds.startFor(minuteAt(event));
    if (found.error || found.start === undefined) setMessage(found.error ?? BOOKED);
    else { setMessage(null); board.setRange(found.start, found.start + MIN_LENGTH); }
  }
  function onSelectionKey(event: KeyboardEvent) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const step = event.key === 'ArrowUp' ? -30 : 30;
    if (event.shiftKey) {
      const end = board.end + step;
      if (end - board.start >= MIN_LENGTH && end <= Math.min(board.start + MAX_LENGTH, bounds.nextLimit(board.start))) board.setRange(board.start, end);
    } else {
      const start = board.start + step;
      if (start >= bounds.minStart && board.end + step <= LAST_END) board.setRange(start, board.end + step);
    }
  }
  const passed = Math.min(nowMinutes, 1440);
  const length = board.end - board.start;
  return <div>
    <p className="mb-2 text-xs text-stone-500">{coarsePointer() ? 'Tap a time, then drag to adjust' : 'Click and drag to choose a time'}</p>
    <div ref={scroller} style={{ height }} className="overflow-y-auto overscroll-contain rounded-xl border border-stone-200 bg-white">
      <div className="relative flex" style={{ height: 1152 }}>
        <div className="relative w-14 shrink-0 border-r border-stone-100">
          {Array.from({ length: 24 }, (_, hour) => <span key={hour} className="absolute right-2 -translate-y-1/2 text-[11px] text-stone-400" style={{ top: Math.max(hour * HOUR, 7) }}>{(hour + 11) % 12 + 1} {hour < 12 ? 'AM' : 'PM'}</span>)}
        </div>
        <div ref={track} onPointerDown={onPointerDown} onPointerMove={event => { if (drag.current && drag.current.mode !== 'tap') apply(minuteAt(event)); }} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; }} className="relative flex-1 select-none" style={{ touchAction: 'pan-y' }}>
          {Array.from({ length: 24 }, (_, hour) => <div key={hour}>
            <div className="absolute inset-x-0 border-t border-stone-200" style={{ top: hour * HOUR }} />
            <div className="absolute inset-x-0 border-t border-dashed border-stone-200/70" style={{ top: hour * HOUR + 24 }} />
          </div>)}
          {passed > 0 && <div className="absolute inset-x-0 top-0" style={{ height: toY(passed), ...hatch }} />}
          {busy.map(block => block.kind === 'closed'
            ? <div key={`closed-${block.from}`} className="absolute inset-x-0" style={{ top: toY(block.from), height: toY(block.to - block.from), ...hatch }} />
            : <div key={`${block.kind}-${block.from}`} className="absolute inset-x-1 overflow-hidden rounded-md bg-stone-300/80 px-2 py-1 text-[11px] font-medium text-stone-700" style={{ top: toY(block.from), height: Math.max(toY(block.to - block.from), 12) }}>{block.kind === 'blocked' ? 'Unavailable' : `Booked · ${rangeLabel(block.from, block.to)}`}</div>)}
          {nowMinutes > 0 && nowMinutes < 1440 && <div className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-now" style={{ top: toY(nowMinutes) }}><span className="absolute -top-[3px] -left-1 h-2 w-2 rounded-full bg-now" /></div>}
          {!board.closed && <div data-role="sel" role="slider" tabIndex={0} aria-label="Selected time. Arrow keys move it, Shift and arrow keys change its length." aria-valuemin={0} aria-valuemax={LAST_END} aria-valuenow={board.start} aria-valuetext={rangeLabel(board.start, board.end)} onKeyDown={onSelectionKey} style={{ top: toY(board.start), height: toY(length), touchAction: 'none' }} className={`absolute inset-x-1 z-10 cursor-grab select-none rounded-lg px-2.5 py-1.5 text-white shadow-md transition-colors active:cursor-grabbing ${board.conflict ? 'bg-red-600' : 'bg-forest'}`}>
            <p className="text-sm leading-tight font-semibold">{rangeLabel(board.start, board.end)}</p>
            {board.conflict ? <p className="text-xs opacity-90">{board.start < nowMinutes ? 'already passed' : 'not available'}</p> : length >= 90 && <p className="text-xs opacity-80">{durationLabel(length)}</p>}
            <div data-role="edge" className="absolute inset-x-0 bottom-0 h-3 cursor-ns-resize [@media(pointer:coarse)]:h-[22px]" style={{ touchAction: 'none' }} />
          </div>}
        </div>
      </div>
    </div>
    {message && <p role="status" className="mt-2 text-sm text-red-700">{message}</p>}
    {board.closed && <p className="mt-2 text-sm text-stone-600">The room is closed on this day.</p>}
  </div>;
}
