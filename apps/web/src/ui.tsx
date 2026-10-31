import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Temporal } from '@js-temporal/polyfill';
import { Building2, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, X } from 'lucide-react';
import { zonedNow } from './marketplace/time';

export function Photo({ src, alt = '', className = '', compact = false }: { src?: string; alt?: string; className?: string; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className={`object-cover ${className}`} />;
  return <div className={`flex flex-col items-center justify-center gap-2 bg-linen text-stone-400 ${className}`}>
    <Building2 className={compact ? 'h-5 w-5' : 'h-8 w-8'} aria-hidden="true" />{!compact && <span className="text-xs">Photos coming soon</span>}
  </div>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div role="status" className="flex items-center justify-center gap-2 py-20 text-sm text-stone-500"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> {label}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div role="alert" className="mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 p-6 text-center">
    <CircleAlert className="mx-auto h-6 w-6 text-red-700" aria-hidden="true" />
    <p className="mt-2 text-sm text-red-800">{message}</p>
    {onRetry && <button onClick={onRetry} className="mt-4 text-sm font-semibold text-red-800 underline">Try again</button>}
  </div>;
}

export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 px-6 py-14 text-center">
    <p className="font-serif text-xl text-stone-900">{title}</p>
    {text && <p className="mx-auto mt-2 max-w-sm text-sm text-stone-500">{text}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>;
}

export function Notice({ tone, children }: { tone: 'error' | 'success'; children: ReactNode }) {
  return <p role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg p-3 text-sm ${tone === 'error' ? 'bg-red-50 text-red-800' : 'bg-mist text-forest'}`}>{children}</p>;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-xs transition-colors disabled:opacity-50 ${checked ? 'bg-forest' : 'bg-field'}`}>
    <span className={`pointer-events-none block h-4 w-4 rounded-full bg-ivory shadow-lg transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
  </button>;
}

export function Tabs<T extends string>({ value, onChange, items, className = '' }: { value: T; onChange: (value: T) => void; items: { value: T; label: ReactNode }[]; className?: string }) {
  return <div role="tablist" className={`inline-flex h-9 items-center justify-center rounded-lg bg-parchment p-1 text-quiet ${className}`}>
    {items.map(item => <button key={item.value} type="button" role="tab" aria-selected={value === item.value} onClick={() => onChange(item.value)} className={`inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all ${value === item.value ? 'bg-ivory text-stone-900 shadow-sm' : ''}`}>{item.label}</button>)}
  </div>;
}

interface PopoverProps { button: ReactNode; buttonClassName?: string; label: string; align?: 'start' | 'end'; sideOffset?: number; className?: string; open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode }

export function Popover({ button, buttonClassName = '', label, align = 'start', sideOffset = 4, className = '', open: controlled, onOpenChange, children }: PopoverProps) {
  const [internal, setInternal] = useState(false);
  const open = controlled ?? internal;
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const setOpen = (value: boolean) => { setInternal(value); onOpenChange?.(value); };
  useLayoutEffect(() => {
    if (!open) { setStyle({ visibility: 'hidden' }); return; }
    const place = () => {
      if (!anchor.current || !panel.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const width = panel.current.offsetWidth;
      const left = Math.max(0, Math.min(align === 'end' ? rect.right - width : rect.left, window.innerWidth - width));
      const top = rect.bottom + sideOffset;
      setStyle({ left, top, maxHeight: window.innerHeight - top });
    };
    place();
    panel.current?.querySelector<HTMLElement>('input, button, a')?.focus({ preventScroll: true });
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, align, sideOffset]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!panel.current?.contains(target) && !anchor.current?.contains(target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); anchor.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  });
  return <>
    <button ref={anchor} type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)} className={buttonClassName}>{button}</button>
    {open && createPortal(<div ref={panel} role="dialog" aria-label={label} style={{ position: 'fixed', ...style }} className={`pop-in overflow-y-auto rounded-md border bg-ivory shadow-md ${className}`}>{children}</div>, anchor.current?.closest('dialog') ?? document.body)}
  </>;
}

export function Calendar({ selected, isDisabled, onSelect }: { selected: string; isDisabled?: (date: string) => boolean; onSelect: (date: string) => void }) {
  const [month, setMonth] = useState(() => Temporal.PlainDate.from(selected).with({ day: 1 }));
  const leading = month.dayOfWeek % 7;
  const today = zonedNow().date;
  const cells = Array.from({ length: Math.ceil((leading + month.daysInMonth) / 7) * 7 }, (_, index) => month.add({ days: index - leading }));
  const nav = 'absolute top-0 flex h-7 w-7 items-center justify-center rounded-md border border-field opacity-50 shadow-xs hover:opacity-100';
  return <div className="p-3">
    <div className="relative flex items-center justify-center pt-1">
      <button type="button" aria-label="Previous month" onClick={() => setMonth(month.subtract({ months: 1 }))} className={`${nav} left-1`}><ChevronLeft className="h-4 w-4" /></button>
      <p className="text-sm font-medium" aria-live="polite">{new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${month.toString()}T12:00:00Z`))}</p>
      <button type="button" aria-label="Next month" onClick={() => setMonth(month.add({ months: 1 }))} className={`${nav} right-1`}><ChevronRight className="h-4 w-4" /></button>
    </div>
    <div className="mt-4 grid grid-cols-7">
      {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => <span key={day} className="w-8 text-center text-[0.8rem] font-normal text-quiet">{day}</span>)}
      {cells.map(cell => {
        const value = cell.toString();
        const outside = cell.month !== month.month;
        const disabled = isDisabled?.(value) ?? false;
        const active = value === selected;
        return <button key={value} type="button" disabled={disabled} aria-pressed={active} onClick={() => onSelect(value)} className={`mt-2 h-8 w-8 rounded-md text-sm transition-colors ${active ? 'bg-forest text-ivory hover:bg-forest' : value === today ? 'bg-mist text-forest' : 'hover:bg-mist hover:text-forest'} ${outside && !active ? 'text-quiet' : ''} ${disabled ? 'text-quiet opacity-50 hover:bg-transparent hover:text-quiet' : ''}`}>{cell.day}</button>;
      })}
    </div>
  </div>;
}

function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

export function Modal({ open, onClose, title, description, className = 'max-w-lg', children }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; className?: string; children: ReactNode }) {
  const ref = useDialog(open);
  return <dialog ref={ref} onClose={onClose} onClick={event => { if (event.target === ref.current) onClose(); }} className={`pop-in m-auto w-full border bg-ivory text-stone-900 shadow-lg backdrop:bg-black/80 sm:rounded-lg ${className}`}>
    <div className="grid gap-4 p-6">
      <div className="flex flex-col space-y-1.5 text-center sm:text-left">
        <h2 className="font-serif text-2xl leading-none font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-quiet">{description}</p>}
      </div>
      {children}
    </div>
    <button type="button" aria-label="Close" onClick={onClose} className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100"><X className="h-4 w-4" /></button>
  </dialog>;
}

export function Sheet({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode }) {
  const ref = useDialog(open);
  return <dialog ref={ref} onClose={onClose} onClick={event => { if (event.target === ref.current) onClose(); }} className="sheet-in fixed inset-x-0 top-auto bottom-0 m-0 max-h-[92vh] w-full max-w-none overflow-y-auto rounded-t-2xl border-t bg-ivory px-5 pt-6 pb-6 text-stone-900 shadow-lg backdrop:bg-black/80 lg:hidden">
    <div className="mb-4 flex flex-col space-y-2 text-left">
      <h2 className="font-serif text-xl font-semibold">{title}</h2>
      {description && <p className="text-sm text-quiet">{description}</p>}
    </div>
    {children}
    <button type="button" aria-label="Close" onClick={onClose} className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100"><X className="h-4 w-4" /></button>
  </dialog>;
}

type Toast = { id: number; message: string; tone: 'success' | 'error' };
let notify: (toast: Toast) => void = () => {};
let toastId = 0;
export const toast = (message: string, tone: Toast['tone'] = 'success') => notify({ id: ++toastId, message, tone });

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    notify = item => {
      setToasts(current => [...current, item]);
      window.setTimeout(() => setToasts(current => current.filter(value => value.id !== item.id)), 4000);
    };
    return () => { notify = () => {}; };
  }, []);
  return <div className="pointer-events-none fixed inset-x-0 top-4 z-[1400] flex flex-col items-center gap-2 px-4" aria-live="polite">
    {toasts.map(item => <p key={item.id} role={item.tone === 'error' ? 'alert' : 'status'} className={`pop-in rounded-lg border px-4 py-3 text-sm font-medium shadow-lg ${item.tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-forest/20 bg-mist text-forest'}`}>{item.message}</p>)}
  </div>;
}
