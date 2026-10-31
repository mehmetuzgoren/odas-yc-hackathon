import { Temporal } from '@js-temporal/polyfill';
import type { CatalogService, Runtime } from '../core';
import { fail, parseJSON } from '../core';
import { TIMEZONE, type Hours, type Office, type SearchInput, type Workspace } from '@odas/contracts';

type Row = Record<string, any>;

export function mapWorkspace(row: Row): Workspace {
  return {
    id: row.id, name: row.name, address: row.address,
    latitude: row.latitude, longitude: row.longitude,
    baseRateCents: row.base_rate_cents, timezone: row.timezone || TIMEZONE,
    modeled: Boolean(row.modeled), description: row.description || '',
    hours: parseJSON<Hours>(row.hours_json, { open: '08:00', close: '20:00', days: [1, 2, 3, 4, 5, 6, 7], modeled: true }),
    photos: parseJSON<string[]>(row.photos_json, []),
    attributes: parseJSON<Record<string, unknown>>(row.attributes_json, {}),
  };
}

export function mapOffice(row: Row, workspace: Workspace): Office {
  return {
    id: row.id, groupId: row.group_id, name: row.name,
    description: row.description || 'A separately bookable office in this workspace.',
    rateCents: row.rate_cents ?? workspace.baseRateCents,
    photos: parseJSON<string[]>(row.photos_json, []),
    attributes: parseJSON<Record<string, unknown>>(row.attributes_json, {}),
    modeled: row.modeled === undefined ? workspace.modeled : Boolean(row.modeled),
    workspace,
  };
}

/** Uses a dated IANA zone, never the browser/server's current UTC offset. */
export function localInstant(date: string, time: string, timezone = TIMEZONE): number {
  try {
    return Temporal.PlainDate.from(date).toPlainDateTime(Temporal.PlainTime.from(time))
      .toZonedDateTime(timezone, { disambiguation: 'reject' }).epochMilliseconds;
  } catch {
    return fail(400, 'Choose a valid, unambiguous local date and time. The selected time may fall in a daylight saving transition.', 'invalid_local_time');
  }
}

export function resolveSearchInterval(input: SearchInput, now: number): { startAt: number; endAt: number } {
  const tomorrow = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(TIMEZONE).toPlainDate().add({ days: 1 }).toString();
  const startAt = input.startAt ?? localInstant(tomorrow, '10:00');
  const endAt = input.endAt ?? startAt + 2 * 3_600_000;
  if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || endAt <= startAt || endAt - startAt > 24 * 3_600_000) {
    fail(400, 'Choose an interval between 15 minutes and 24 hours.', 'invalid_interval');
  }
  if (endAt - startAt < 15 * 60_000) fail(400, 'Reservations must be at least 15 minutes.', 'invalid_interval');
  return { startAt, endAt };
}

export function isWithinHours(workspace: Workspace, startAt: number, endAt: number): boolean {
  const start = Temporal.Instant.fromEpochMilliseconds(startAt).toZonedDateTimeISO(workspace.timezone);
  const end = Temporal.Instant.fromEpochMilliseconds(endAt).toZonedDateTimeISO(workspace.timezone);
  const hours = workspace.hours;
  if (!hours || !Array.isArray(hours.days) || !hours.open || !hours.close) return false;
  if (!hours.days.includes(start.dayOfWeek)) return false;
  const date = start.toPlainDate().toString();
  const opening = localInstant(date, hours.open, workspace.timezone);
  let closing = localInstant(date, hours.close, workspace.timezone);
  if (closing <= opening) closing = localInstant(start.toPlainDate().add({ days: 1 }).toString(), hours.close, workspace.timezone);
  return startAt >= opening && endAt <= closing && end.epochMilliseconds > start.epochMilliseconds;
}

function matchesAttributes(office: Office, wanted: SearchInput['attributes']): boolean {
  if (!wanted) return true;
  return Object.entries(wanted).every(([key, value]) => {
    if (value === undefined || value === null || value === '' || value === false) return true;
    const known = office.attributes[key];
    if (key === 'minCapacity') return typeof office.attributes.capacity === 'number' && office.attributes.capacity >= Number(value);
    if (key === 'capacityKnown') return typeof office.attributes.capacity === 'number';
    return known !== undefined && known === value;
  });
}

export function createCatalogService(rt: Runtime): CatalogService {
  const rows = () => rt.db.query('SELECT * FROM workspace_groups ORDER BY base_rate_cents,id').all() as Row[];
  const officeRows = (groupId: string) => rt.db.query('SELECT * FROM offices WHERE group_id=? ORDER BY id').all(groupId) as Row[];

  async function withAvailability(office: Office, input: SearchInput, startAt: number, endAt: number): Promise<Office> {
    let reason: string | undefined;
    if (startAt < rt.clock.now()) reason = 'The selected start time has passed.';
    else if (!isWithinHours(office.workspace!, startAt, endAt)) reason = 'Outside configured bookable hours.';
    else if (input.maxRateCents !== undefined && office.rateCents > input.maxRateCents) reason = 'Above your hourly budget.';
    else if (!matchesAttributes(office, input.attributes)) reason = 'Required attributes are not known to match.';
    else if (!(await rt.rooms.available(office.id, startAt, endAt))) reason = 'Unavailable for this interval.';
    return { ...office, available: !reason, availabilityReason: reason };
  }

  async function group(id: string, input: SearchInput = {}) {
    const row = rt.db.query('SELECT * FROM workspace_groups WHERE id=?').get(id) as Row | null;
    if (!row) fail(404, 'Workspace not found.', 'not_found');
    const workspace = mapWorkspace(row);
    const { startAt, endAt } = resolveSearchInterval(input, rt.clock.now());
    const offices = await Promise.all(officeRows(id).map(row => withAvailability(mapOffice(row, workspace), input, startAt, endAt)));
    const matching = offices.filter(office => office.available);
    return { group: { ...workspace, officeCount: offices.length, availableCount: matching.length, lowestRateCents: matching.length ? Math.min(...matching.map(office => office.rateCents)) : null }, offices };
  }

  async function office(id: string, input: SearchInput = {}) {
    const row = rt.db.query('SELECT * FROM offices WHERE id=?').get(id) as Row | null;
    if (!row) fail(404, 'Office not found.', 'not_found');
    const workspace = rt.db.query('SELECT * FROM workspace_groups WHERE id=?').get(row.group_id) as Row;
    const interval = resolveSearchInterval(input, rt.clock.now());
    return withAvailability(mapOffice(row, mapWorkspace(workspace)), input, interval.startAt, interval.endAt);
  }

  return {
    group, office,
    async search(input) {
      const interval = resolveSearchInterval(input, rt.clock.now());
      if (input.maxRateCents !== undefined && (!Number.isSafeInteger(input.maxRateCents) || input.maxRateCents < 0)) fail(400, 'Enter a valid maximum hourly price.', 'invalid_price');
      const query = (input.location || '').trim().toLocaleLowerCase();
      const matchingRows = rows().filter(row => !query || `${row.name} ${row.address} San Francisco SF`.toLocaleLowerCase().includes(query));
      const groups = await Promise.all(matchingRows.map(row => group(row.id, { ...input, ...interval })));
      return { groups: groups.map(result => result.group), offices: groups.flatMap(result => result.offices), ...interval, timezone: TIMEZONE, modeled: groups.some(result => result.group.modeled) };
    },
  };
}
