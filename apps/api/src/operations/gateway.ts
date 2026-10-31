import type { RoomGateway, RoomCommand, RoomResult, RoomSnapshot } from '@odas/contracts';
import { actors } from '../generated/index';

/** Only native generated Terse RPC clients are used. No in-process actor fallback. */
export function createRoomGateway(): RoomGateway {
  const room = (id: string) => actors.RoomActor.get(id);
  return {
    snapshot: (id) => room(id).snapshot() as Promise<RoomSnapshot>,
    command: (id: string, command: RoomCommand) => room(id).command(command) as Promise<RoomResult>,
    available: (id, startAt, endAt, excludeBookingId) => room(id).available(startAt, endAt, excludeBookingId),
  };
}
