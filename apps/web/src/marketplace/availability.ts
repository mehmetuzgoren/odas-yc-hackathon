import type { BuildingDay, Office, RoomDay } from '@odas/contracts';
import { toMinutes } from './time';

const LAST_END = 1410;

export interface DayRange { start: number; end: number }

export const openingOf = (day: BuildingDay) => toMinutes(day.open);
export const closingOf = (day: BuildingDay) => toMinutes(day.close) > toMinutes(day.open) ? toMinutes(day.close) : LAST_END;
export const roomDay = (day: BuildingDay, office: Office) => day.rooms.find(room => room.roomId === office.id);

// Mirrors the room actor: bookings carry a turnover buffer on both sides, blocks do not.
export function isRoomFree(room: RoomDay | undefined, day: BuildingDay, range: DayRange, nowMinutes: number) {
  if (!room?.bookable || day.closed) return false;
  if (range.start < openingOf(day) || range.end > closingOf(day) || range.start < nowMinutes) return false;
  return !room.busy.some(span => {
    const buffer = span.kind === 'booked' ? day.bufferMinutes : 0;
    return range.start < span.to + buffer && range.end + buffer > span.from;
  });
}
