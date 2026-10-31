import type { DeviceAdapter, DeviceTelemetry, DomainEvent, Inspection, RoomSnapshot } from '@odas/contracts';
import type { Runtime, OperationsService } from '../core';
import { existsSync, readFileSync } from 'node:fs';
import { audit, enqueue, fail, uid } from '../core';

const VACANCY_AGE = 30_000;
export function createDeviceAdapter(rt: Runtime): DeviceAdapter {
  const base = String(rt.config.deviceUrl || process.env.DEVICE_URL || `http://127.0.0.1:${process.env.DEVICE_PORT || 7300}`);
  async function call<T>(roomId: string, kind: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}/v1/rooms/${encodeURIComponent(roomId)}/${kind}?now=${rt.clock.now()}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${rt.config.internalToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(kind === 'inspection' ? 20_000 : 15_000),
    });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(result.error || `Device worker returned ${response.status}`);
    return result;
  }
  return {
    inspect: id => call(id, 'inspection'), telemetry: id => call(id, 'telemetry'),
    start: (id, commandId) => call(id, 'start', { commandId, now: rt.clock.now() }),
    dock: (id, commandId) => call(id, 'dock', { commandId, now: rt.clock.now() }),
  };
}

export function createOperationsService(rt: Runtime): OperationsService {
  const device = createDeviceAdapter(rt);
  const now = () => rt.clock.now();
  const explicitBindings = new Set<string>();
  const bindingsFile = process.env.DEVICE_BINDINGS_FILE;
  if (bindingsFile && existsSync(bindingsFile)) {
    const bindings = JSON.parse(readFileSync(bindingsFile, 'utf8')).bindings || [];
    for (const binding of bindings) if ((binding.mode || rt.config.deviceMode) === rt.config.deviceMode) explicitBindings.add(binding.roomId);
  }
  async function command(roomId: string, fields: any) {
    const result = await rt.rooms.command(roomId, { id: uid('ops'), now: now(), ...fields });
    if (!result.ok) fail(409, result.message || 'Room action was rejected.', result.code);
    await drainRoom(roomId, result.snapshot);
    return result.snapshot;
  }
  function recordObservation(roomId: string, kind: string, id: string, at: number, data: unknown) {
    rt.db.query('INSERT OR IGNORE INTO device_observations(id,room_id,kind,observed_at,data) VALUES(?,?,?,?,?)').run(id, roomId, kind, at, JSON.stringify(data));
  }
  async function demoStatus(roomId: string, changes?: { jevEnabled?: boolean; roboEnabled?: boolean }) {
    const base = String(rt.config.deviceUrl || process.env.DEVICE_URL || `http://127.0.0.1:${process.env.DEVICE_PORT || 7300}`);
    const response = await fetch(`${base}/v1/rooms/${encodeURIComponent(roomId)}/demo`, {
      method: changes ? 'PATCH' : 'GET', headers: { authorization: `Bearer ${rt.config.internalToken}`, 'content-type': 'application/json' },
      ...(changes ? { body: JSON.stringify(changes) } : {}), signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json() as any;
    if (!response.ok) fail(response.status === 404 ? 404 : 503, data.error || 'Device controls are unavailable.');
    return data;
  }
  async function roboEnabled(roomId: string) {
    try { return (await demoStatus(roomId)).roboEnabled === true; } catch { return false; }
  }
  async function requireRobo(roomId: string) {
    if (!await roboEnabled(roomId)) fail(409, 'Robo cleaning is disabled. Enable Robo on /demo first.', 'robo_disabled');
  }
  async function recordInspection(observation: Inspection) {
    recordObservation(observation.roomId, 'inspection', observation.id, observation.capturedAt, observation);
    const result = await rt.rooms.command(observation.roomId, { id: `inspection:${observation.id}`, type: 'inspect', now: now(), inspection: observation });
    await drainRoom(observation.roomId, result.snapshot);
    return result;
  }
  async function observeInspection(observation: Inspection) {
    if (rt.config.deviceMode !== 'physical' || observation.source !== 'camera' || !explicitBindings.has(observation.roomId)) fail(403, 'This office has no configured physical camera binding.');
    return recordInspection(observation);
  }
  async function inspect(roomId: string) {
    let observation: Inspection;
    try { observation = await device.inspect(roomId); }
    catch {
      const previous = await rt.rooms.snapshot(roomId);
      observation = { id: uid('inspection'), roomId, source: rt.config.deviceMode === 'simulator' ? 'simulator' : 'camera', capturedAt: now(), inferredAt: now(), sequence: Math.max(Date.now() * 1000, (previous.inspection?.sequence || 0) + 1), occupancy: 'unknown', confidence: 0, floor: 'unknown', surfaces: 'unknown', connection: 'disconnected', error: 'Camera or inspection provider is unavailable; connection requires verification.' };
    }
    return recordInspection(observation);
  }
  async function telemetry(roomId: string) {
    let observation: DeviceTelemetry;
    try { observation = await device.telemetry(roomId); }
    catch { observation = { roomId, source: rt.config.deviceMode === 'simulator' ? 'simulator' : 'roborock', observedAt: now(), connection: 'disconnected', state: 'unknown', error: 'The backend device worker or robot cloud connection is unavailable.' }; }
    recordObservation(roomId, 'telemetry', `${roomId}:telemetry:${observation.observedAt}`, observation.observedAt, observation);
    const result = await rt.rooms.command(roomId, { id: uid('telemetry'), type: 'telemetry', now: now(), telemetry: observation });
    await drainRoom(roomId, result.snapshot);
    return result.snapshot;
  }
  async function attention(roomId: string, snapshot: RoomSnapshot) {
    for (const reason of snapshot.attentionReasons) {
      const existing = rt.db.query("SELECT id FROM attention_tasks WHERE room_id=? AND reason=? AND status!='resolved'").get(roomId, reason);
      if (!existing) rt.db.query("INSERT INTO attention_tasks(id,room_id,reason,status,created_at,data) VALUES(?,?,?,'open',?,?)").run(uid('task'), roomId, reason, now(), JSON.stringify({ roomRevision: snapshot.revision, source: snapshot.inspection?.source || 'unverified' }));
    }
  }
  async function drainRoom(roomId: string, snapshot?: RoomSnapshot) {
    const state = snapshot || await rt.rooms.snapshot(roomId);
    if (state.events.length) {
      rt.db.transaction(() => { for (const event of state.events) { enqueue(rt, event, 'operations'); enqueue(rt, event, 'concierge'); } })();
      await rt.rooms.command(roomId, { id: `ack:${state.events.map(e => e.id).join('|')}`, now: now(), type: 'ack_events', eventIds: state.events.map(e => e.id) });
    }
    await attention(roomId, state);
  }
  async function drain() {
    const rooms = rt.db.query('SELECT id FROM offices').all() as { id: string }[];
    for (const { id } of rooms) await drainRoom(id);
  }
  async function dispatch(roomId: string, event: DomainEvent) {
    let snapshot = await rt.rooms.snapshot(roomId);
    const job = snapshot.job;
    if (!job || job.id !== event.payload.jobId) return { skipped: 'job_changed' };
    if (!await roboEnabled(roomId)) {
      if (job.status === 'requested') await command(roomId, { type: 'job_result', jobId: job.id, status: 'interrupted', reason: 'Robo cleaning is disabled.' });
      return { skipped: 'robo_disabled' };
    }
    // A prior dispatch may have reached the vendor. Telemetry resolves it, never automatic replay.
    if (job.status !== 'requested') { await telemetry(roomId); return { reconciled: true }; }
    await inspect(roomId); await telemetry(roomId);
    const claimId = `${event.id}:claim`;
    const claim = await rt.rooms.command(roomId, { id: `${event.id}:claim`, now: now(), type: 'claim_clean', jobId: job.id, claimId, claimExpiresAt: now() + 20_000 });
    if (!claim.ok) return { rejected: claim.code };
    const auth = await rt.rooms.command(roomId, { id: `${event.id}:authorize`, now: now(), type: 'authorize_dispatch', jobId: job.id, claimId });
    await drainRoom(roomId, auth.snapshot);
    if (!auth.ok) return { rejected: auth.code };
    const commandId = auth.snapshot.job!.commandId;
    const inserted = rt.db.query("INSERT OR IGNORE INTO device_commands(id,room_id,kind,status,job_id,created_at,updated_at,data) VALUES(?,?,?,'dispatching',?,?,?,'{}')").run(commandId, roomId, 'start', job.id, now(), now());
    if (!inserted.changes) return { reconciled: true, commandId };
    // Intent committed both in the actor and durable database before the external effect.
    try {
      const result = await device.start(roomId, commandId);
      rt.db.query('UPDATE device_commands SET status=?,updated_at=?,data=? WHERE id=?').run(result.uncertain ? 'uncertain' : result.accepted ? 'accepted' : 'rejected', now(), JSON.stringify(result), commandId);
      if (!result.accepted || result.uncertain) await command(roomId, { type: 'job_result', jobId: job.id, status: result.uncertain ? 'uncertain' : 'failed', reason: result.message || 'Robot command was not confirmed.' });
      // Vendor acceptance is not observed motion. Only telemetry may transition started.
      await telemetry(roomId);
      return result;
    } catch {
      rt.db.query("UPDATE device_commands SET status='uncertain',updated_at=? WHERE id=?").run(now(), commandId);
      await command(roomId, { type: 'job_result', jobId: job.id, status: 'uncertain', reason: 'Command delivery is uncertain. Reconcile robot telemetry before another start.' });
      return { uncertain: true };
    }
  }
  async function dock(roomId: string, cause = 'Operator requested docking', commandId = uid('dock')) {
    rt.db.query("INSERT OR IGNORE INTO device_commands(id,room_id,kind,status,created_at,updated_at,data) VALUES(?,?,?,'dispatching',?,?,?)").run(commandId, roomId, 'dock', now(), now(), JSON.stringify({ cause }));
    try {
      const result = await device.dock(roomId, commandId);
      rt.db.query('UPDATE device_commands SET status=?,updated_at=?,data=? WHERE id=?').run(result.uncertain ? 'uncertain' : result.accepted ? 'accepted' : 'rejected', now(), JSON.stringify(result), commandId);
      const state = await rt.rooms.snapshot(roomId);
      if (state.job && ['started', 'dispatching', 'uncertain'].includes(state.job.status)) await command(roomId, { type: 'job_result', jobId: state.job.id, status: result.uncertain ? 'uncertain' : 'interrupted', reason: cause });
      audit(rt, 'operations', 'robot.dock', roomId, { commandId, cause, result });
      return result;
    } catch {
      rt.db.query("UPDATE device_commands SET status='uncertain',updated_at=? WHERE id=?").run(now(), commandId);
      return { accepted: false, uncertain: true, message: 'Dock delivery is uncertain. The Q10 cloud connection is required.' };
    }
  }
  async function processEvent(event: DomainEvent) {
    const state = await rt.rooms.snapshot(event.roomId);
    if (event.type === 'room.inspection_requested') return inspect(event.roomId);
    if (event.type === 'cleaning.requested') return dispatch(event.roomId, event);
    if (event.type === 'cleaning.interrupt_required') return dock(event.roomId, String(event.payload.reason || 'Vacancy evidence is unavailable'), `${event.id}:dock`);
    if (event.type === 'room.inspected' && state.inspection && state.inspection.id === event.payload.inspectionId) {
      if (state.inspection.floor === 'dirty' && state.inspection.occupancy === 'vacant' && state.inspection.surfaces === 'clear' && state.inspection.confidence >= 0.9 && (!state.job || !['requested', 'dispatching', 'started', 'uncertain'].includes(state.job.status)) && await roboEnabled(event.roomId)) {
        const result = await rt.rooms.command(event.roomId, { id: `${event.id}:clean`, type: 'request_clean', now: now(), jobId: `clean:${event.id}`, expectedReadyAt: now() + Number(rt.config.cleaningEstimateMs || 10 * 60_000) });
        await drainRoom(event.roomId, result.snapshot);
        return { requested: result.ok, code: result.code };
      }
    }
    await attention(event.roomId, state);
    return { observed: event.type };
  }
  async function tick() {
    const rooms = rt.db.query('SELECT id,device_binding_json FROM offices').all() as { id: string; device_binding_json: string | null }[];
    for (const { id, device_binding_json } of rooms) {
      const binding = device_binding_json ? JSON.parse(device_binding_json) : null;
      const bound = explicitBindings.has(id) || binding && binding.mode === rt.config.deviceMode;
      let state = await rt.rooms.snapshot(id);
      if (bound) {
        if (!state.device || now() - state.device.observedAt > 15_000 || state.job && ['dispatching', 'started', 'uncertain'].includes(state.job.status)) state = await telemetry(id);
        const jevOff = rt.config.deviceMode === 'physical' && !(await demoStatus(id)).jevEnabled;
        if (!state.inspection || now() - state.inspection.capturedAt > 15_000 || jevOff && state.inspection.error !== 'Jev analysis is disabled.') await inspect(id);
      } else {
        // Initialize truthful unknown state once, without polling or publishing repeated unbound observations.
        if (!state.device) await telemetry(id);
        if (!state.inspection) await inspect(id);
      }
      await drainRoom(id);
    }
  }
  async function authorizePhysical(roomId: string, commandId: string) {
    let controls;
    try { controls = await demoStatus(roomId); } catch { return false; }
    if (!controls.roboEnabled || rt.config.deviceMode === 'physical' && !controls.jevEnabled) return false;
    const state = await rt.rooms.snapshot(roomId);
    const i = state.inspection;
    if (!state.job || state.job.commandId !== commandId || state.job.status !== 'dispatching' || (state.job.claimExpiresAt || 0) <= now()) return false;
    return state.operational === 'available' && !!i && i.occupancy === 'vacant' && i.confidence >= 0.9 && i.connection === 'connected' && i.surfaces === 'clear' && now() - i.capturedAt <= VACANCY_AGE && i.capturedAt <= now() + 1000;
  }
  async function configureDemo(roomId: string, changes: { jevEnabled?: boolean; roboEnabled?: boolean }) {
    const status = await demoStatus(roomId, changes);
    if (changes.jevEnabled === false && rt.config.deviceMode === 'physical') await inspect(roomId);
    if (changes.roboEnabled === false) {
      const state = await rt.rooms.snapshot(roomId);
      if (state.job?.status === 'requested') await command(roomId, { type: 'job_result', jobId: state.job.id, status: 'interrupted', reason: 'Robo disabled on /demo.' });
      else if (state.job && ['dispatching', 'started', 'uncertain'].includes(state.job.status)) {
        const result = await dock(roomId, 'Robo disabled on /demo.', `demo:robo-off:${state.job.id}`);
        return { ...status, dockResult: result };
      }
    }
    return status;
  }
  return { device, inspect, telemetry, processEvent, drain, tick, dock, command, authorizePhysical, drainRoom, demoStatus, configureDemo, requireRobo, observeInspection };
}
