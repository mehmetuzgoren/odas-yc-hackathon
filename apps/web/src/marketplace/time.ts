import { Temporal } from '@js-temporal/polyfill';
import { TIMEZONE } from '@odas/contracts';

export function datedInstant(date: string, time: string): number {
  return Temporal.PlainDate.from(date).toPlainDateTime(Temporal.PlainTime.from(time))
    .toZonedDateTime(TIMEZONE, { disambiguation: 'reject' }).epochMilliseconds;
}

export const toMinutes = (time: string) => {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

export const toTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function zonedParts(instant: number, zone = TIMEZONE) {
  const value = Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(zone);
  return { date: value.toPlainDate().toString(), minutes: value.hour * 60 + value.minute };
}

export const zonedNow = (zone = TIMEZONE) => zonedParts(Date.now(), zone);
export const addDays = (date: string, days: number) => Temporal.PlainDate.from(date).add({ days }).toString();
export const dayOfWeek = (date: string) => Temporal.PlainDate.from(date).dayOfWeek;

export function defaultSelection(now = Date.now()) {
  const { date, minutes } = zonedParts(now);
  const next = 60 * Math.ceil((minutes + 1) / 60);
  if (next + 120 > 1200) return { date: addDays(date, 1), start: '10:00', end: '12:00' };
  const start = Math.max(next, 480);
  return { date, start: toTime(start), end: toTime(start + 120) };
}

export function intervalParams(params: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams(params);
  const startAt = Number(params.get('startAt'));
  const endAt = Number(params.get('endAt'));
  const startZoned = startAt > 0 ? Temporal.Instant.fromEpochMilliseconds(startAt).toZonedDateTimeISO(TIMEZONE) : undefined;
  const endZoned = endAt > 0 ? Temporal.Instant.fromEpochMilliseconds(endAt).toZonedDateTimeISO(TIMEZONE) : undefined;
  const fallback = defaultSelection();
  const date = params.get('date') || startZoned?.toPlainDate().toString() || fallback.date;
  const start = params.get('start') || startZoned?.toPlainTime().toString({ smallestUnit: 'minute' }) || fallback.start;
  const end = params.get('end') || endZoned?.toPlainTime().toString({ smallestUnit: 'minute' }) || fallback.end;
  result.set('date', date); result.set('start', start); result.set('end', end);
  result.set('startAt', String(datedInstant(date, start)));
  result.set('endAt', String(datedInstant(date, end)));
  if (Number(result.get('endAt')) <= Number(result.get('startAt'))) throw new Error('End time must follow start time on the selected date.');
  return result;
}

export const dateLabel = (date: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));

export function durationLabel(minutes: number) {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr${hours === 1 ? '' : 's'}`;
}

function clockParts(minutes: number, full = false) {
  const hour = Math.floor(minutes / 60) % 24;
  const rest = minutes % 60;
  const twelve = (hour + 11) % 12 + 1;
  return [full || rest ? `${twelve}:${String(rest).padStart(2, '0')}` : `${twelve}`, hour < 12 ? 'AM' : 'PM'] as const;
}

export const clockLabel = (minutes: number) => clockParts(minutes, true).join(' ');
export const shortClock = (minutes: number) => clockParts(minutes).join(' ');

export function rangeLabel(start: number, end: number, full = false) {
  const [from, fromSuffix] = clockParts(start, full);
  const [to, toSuffix] = clockParts(end, full);
  return fromSuffix === toSuffix && end - start < 720 ? `${from} – ${to} ${toSuffix}` : `${from} ${fromSuffix} – ${to} ${toSuffix}`;
}

export const instantDate = (instant: number, zone = TIMEZONE) => dateLabel(zonedParts(instant, zone).date);
export const instantClock = (instant: number, zone = TIMEZONE) => clockLabel(zonedParts(instant, zone).minutes);

export function instantRange(startAt: number, endAt: number, zone = TIMEZONE) {
  const start = zonedParts(startAt, zone);
  const end = zonedParts(endAt, zone);
  return rangeLabel(start.minutes, end.date > start.date && end.minutes === 0 ? 1440 : end.minutes);
}

export function relativeDay(instant: number, zone = TIMEZONE) {
  const { date } = zonedParts(instant, zone);
  const today = zonedNow(zone).date;
  return date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : dateLabel(date);
}
