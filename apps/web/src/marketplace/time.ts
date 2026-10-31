import { Temporal } from '@js-temporal/polyfill';
import { TIMEZONE } from '@odas/contracts';

export function datedInstant(date: string, time: string): number {
  return Temporal.PlainDate.from(date).toPlainDateTime(Temporal.PlainTime.from(time))
    .toZonedDateTime(TIMEZONE, { disambiguation: 'reject' }).epochMilliseconds;
}

export function defaultDate(now = Date.now()): string {
  return Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(TIMEZONE)
    .toPlainDate().add({ days: 1 }).toString();
}

export function intervalParams(params: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams(params);
  const startAt = Number(params.get('startAt'));
  const endAt = Number(params.get('endAt'));
  const startZoned = startAt > 0 ? Temporal.Instant.fromEpochMilliseconds(startAt).toZonedDateTimeISO(TIMEZONE) : undefined;
  const endZoned = endAt > 0 ? Temporal.Instant.fromEpochMilliseconds(endAt).toZonedDateTimeISO(TIMEZONE) : undefined;
  const date = params.get('date') || startZoned?.toPlainDate().toString() || defaultDate();
  const start = params.get('start') || startZoned?.toPlainTime().toString({ smallestUnit: 'minute' }) || '10:00';
  const end = params.get('end') || endZoned?.toPlainTime().toString({ smallestUnit: 'minute' }) || '12:00';
  result.set('date', date); result.set('start', start); result.set('end', end);
  result.set('startAt', String(datedInstant(date, start)));
  result.set('endAt', String(datedInstant(date, end)));
  if (Number(result.get('endAt')) <= Number(result.get('startAt'))) throw new Error('End time must follow start time on the selected date.');
  return result;
}

export function intervalLabel(startAt: number, endAt: number): string {
  const date = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(startAt);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `${date} · ${time.format(startAt)} to ${time.format(endAt)}`;
}
