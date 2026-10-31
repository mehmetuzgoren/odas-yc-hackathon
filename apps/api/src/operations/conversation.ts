import type { RoomSnapshot } from '@odas/contracts';
import type { Runtime } from '../core';

type Message = { source: string; target: string; body: string };
type Context = Pick<Runtime, 'db' | 'clock' | 'rooms'>;

/** Store semantic transitions atomically, ignoring repeated frames and older actor snapshots. */
export function recordChange(rt: Context, roomId: string, channel: string, signature: string, revision: number, messages: Message[]) {
  return rt.db.transaction(() => {
    const previous = rt.db.query('SELECT signature,revision FROM room_conversation_state WHERE room_id=? AND channel=?').get(roomId, channel) as { signature: string; revision: number } | null;
    if (previous?.revision !== undefined && previous.revision > revision) return false;
    if (previous?.signature === signature) {
      rt.db.query('UPDATE room_conversation_state SET revision=? WHERE room_id=? AND channel=?').run(revision, roomId, channel);
      return false;
    }
    rt.db.query('INSERT INTO room_conversation_state(room_id,channel,signature,revision) VALUES(?,?,?,?) ON CONFLICT(room_id,channel) DO UPDATE SET signature=excluded.signature,revision=excluded.revision').run(roomId, channel, signature, revision);
    for (const message of messages) rt.db.query('INSERT INTO room_conversation(room_id,source,target,body,occurred_at) VALUES(?,?,?,?,?)').run(roomId, message.source, message.target, message.body, rt.clock.now());
    return true;
  })();
}

function fresh(state: RoomSnapshot, now: number) {
  const i = state.inspection;
  return !!i && i.connection === 'connected' && i.confidence >= 0.9 && i.capturedAt <= now + 1000 && now - i.capturedAt <= 30_000;
}

export function recordRoomConversation(rt: Context, state: RoomSnapshot) {
  const i = state.inspection;
  if (i) {
    const confident = fresh(state, rt.clock.now());
    const signature = JSON.stringify([i.source, i.connection, i.occupancy, i.floor, i.surfaces, confident]);
    const body = i.error === 'Jev analysis is disabled.' ? 'Monitoring is off. I do not have a current room assessment.'
      : !confident ? 'I cannot verify the room conditions. Keep cleaning on hold.'
      : i.occupancy === 'occupied' ? 'Someone is in the room. Keep the vacuum stopped.'
      : i.occupancy === 'unknown' ? 'I cannot tell whether the room is vacant. Keep cleaning on hold.'
      : `The room is vacant. The floor is ${i.floor}; surfaces are ${i.surfaces}.`;
    recordChange(rt, state.roomId, 'inspection', signature, state.revision, [{ source: i.source === 'camera' ? 'Jev' : 'Inspection (simulator)', target: 'Room agent', body }]);
  }
  const job = state.job;
  if (job) {
    const replies = {
      requested: { source: 'Room agent', target: 'Robo', body: 'Vacancy is confirmed. Please clean the room after the final safety check.' },
      dispatching: { source: 'Room agent', target: 'Robo', body: 'The safety checks passed. Sending the vacuum command.' },
      started: { source: 'Robo', target: 'Room agent', body: 'I have started cleaning. Keep the room unavailable.' },
      completed: { source: 'Robo', target: 'Jev', body: 'I am back at the dock. Check the room again before allowing a guest in.' },
      interrupted: { source: 'Robo', target: 'Room agent', body: `Cleaning was interrupted. ${job.reason || 'Fresh room evidence is required.'}` },
      uncertain: { source: 'Robo', target: 'Room agent', body: `I cannot confirm the cleaning command. ${job.reason || 'Check the robot connection.'}` },
      failed: { source: 'Robo', target: 'Room agent', body: `I could not clean the room. ${job.reason || 'Check the robot before retrying.'}` },
    };
    recordChange(rt, state.roomId, 'job', JSON.stringify([job.id, job.status]), state.revision, [replies[job.status]]);
  }
  const device = state.device;
  if (device) {
    const current = device.observedAt <= rt.clock.now() + 1000 && rt.clock.now() - device.observedAt <= 60_000;
    const body = !current ? 'My telemetry is stale. My current position is unverified.'
      : device.connection !== 'connected' ? 'My connection is unavailable. Do not assume I can clean.'
      : `I am ${device.state}.${device.source === 'simulator' ? ' This is a simulated robot observation.' : ''}`;
    const covered = current && device.connection === 'connected' && (device.state === 'cleaning' && job?.status === 'started' || device.state === 'docked' && job?.status === 'completed');
    recordChange(rt, state.roomId, 'robot', JSON.stringify([device.source, device.connection, device.state, current]), state.revision, covered ? [] : [{ source: 'Robo', target: 'Room agent', body }]);
  }
}

/** This runs in the real concierge event handler, using the room actor's inventory decision. */
export async function recordConciergeConversation(rt: Context, state: RoomSnapshot) {
  const now = rt.clock.now();
  const busy = state.job && ['requested', 'dispatching', 'started', 'uncertain'].includes(state.job.status);
  const reason = state.operational !== 'available' ? `the room is ${state.operational}`
    : state.occupancy === 'occupied' ? 'someone is in the room'
    : busy ? 'cleaning is still in progress or awaiting confirmation'
    : !fresh(state, now) ? 'fresh, confident room evidence is missing'
    : state.inspection?.floor !== 'clean' ? 'the floor is not confirmed clean'
    : state.inspection?.surfaces !== 'clear' ? 'the surfaces are not confirmed clear'
    : state.readiness !== 'ready' ? 'the room and robot checks have not confirmed readiness'
    : '';
  const inventory = JSON.stringify([state.blocks.filter(b => b.startAt < now + 900_000 && b.endAt > now), state.intervals.filter(i => i.status !== 'canceled' && i.startAt < now + 1_800_000 && i.endAt + 900_000 > now).map(i => i.bookingId)]);
  const candidate = JSON.stringify([reason, inventory]);
  const previous = rt.db.query("SELECT signature,revision FROM room_conversation_state WHERE room_id=? AND channel='concierge-input'").get(state.roomId) as { signature: string; revision: number } | null;
  if (previous && (previous.signature === candidate || previous.revision > state.revision)) {
    if (previous.signature === candidate) recordChange(rt, state.roomId, 'concierge-input', candidate, state.revision, []);
    return;
  }
  const available = await rt.rooms.available(state.roomId, now, now + 15 * 60_000);
  const answer = reason ? `Not yet: ${reason}.` : !available ? 'Not now: the room is reserved, blocked, or still within its turnover buffer.' : 'Yes. The room is clean, vacant, ready, and available for the next 15 minutes.';
  rt.db.transaction(() => {
    if (!recordChange(rt, state.roomId, 'concierge-input', candidate, state.revision, [])) return;
    recordChange(rt, state.roomId, 'concierge', answer, state.revision, [
      { source: 'Concierge', target: 'Room agent', body: 'Can a guest use the room now?' },
      { source: 'Room agent', target: 'Concierge', body: answer },
    ]);
  })();
}

export function roomConversation(rt: Pick<Runtime, 'db'>, roomId: string) {
  return rt.db.query('SELECT id,source,target,body,occurred_at AS at FROM (SELECT * FROM room_conversation WHERE room_id=? ORDER BY id DESC LIMIT 100) ORDER BY id').all(roomId);
}
