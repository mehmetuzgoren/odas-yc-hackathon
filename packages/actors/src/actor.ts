import { Actor, Persisted } from 'terse-sdk/actor';
import type { DomainEvent, RoomCommand, RoomResult, RoomSnapshot, InventoryInterval } from './contracts';

const configuredMinutes = (name: string, fallback: number) => { const value = Number(process.env[name] ?? fallback); return Number.isFinite(value) && value >= 0 && value <= 120 ? value : fallback; };
const BUFFER_MS = configuredMinutes('TURNOVER_BUFFER_MINUTES', 15) * 60_000;
const CHECK_IN_MS = configuredMinutes('CHECK_IN_WINDOW_MINUTES', 15) * 60_000;
const EVIDENCE_MS = 30_000;
const TELEMETRY_MS = 60_000;
const CONFIDENCE = 0.9;
const ACTIVE_JOBS = new Set(['requested', 'dispatching', 'started', 'uncertain']);

/** Serialized inventory and room-safety authority. No external I/O runs in its mailbox. */
export class RoomActor extends Actor {
  @Persisted private state: RoomSnapshot = {
    roomId: this.id, revision: 0, intervals: [], occupancy: 'unknown', inspection: null,
    cleanliness: 'unknown', operational: 'available', readiness: 'unknown', expectedReadyAt: null,
    device: null, job: null, events: [], blocks: [], attentionReasons: [],
  };
  @Persisted private logicalNow = 0;
  @Persisted private lastInspectionSequence = 0;
  @Persisted private inspectionRequiredAfter = 0;

  async snapshot(): Promise<RoomSnapshot> {
    await this.#advance(this.#now());
    return structuredClone(this.state);
  }

  async available(startAt: number, endAt: number, excludeBookingId?: string): Promise<boolean> {
    await this.#advance(this.#now());
    return this.#available(this.state, startAt, endAt, excludeBookingId);
  }

  async command(command: RoomCommand): Promise<RoomResult> {
    if (!command || typeof command.id !== 'string' || !command.id || !Number.isFinite(command.now)) {
      return { ok: false, code: 'invalid_command', message: 'A durable command ID and timestamp are required.', snapshot: structuredClone(this.state) };
    }
    return this.db.transaction(async () => {
      this.db.exec('CREATE TABLE IF NOT EXISTS command_receipts (id TEXT PRIMARY KEY, result TEXT NOT NULL)');
      const receipt = this.db.exec('SELECT result FROM command_receipts WHERE id=?', command.id)[0] as { result: string } | undefined;
      if (receipt) return { ...JSON.parse(receipt.result), snapshot: structuredClone(this.state) };
      const next = structuredClone(this.state);
      const now = process.env.ODAS_TEST_MODE === '1' ? command.now : Date.now();
      this.logicalNow = Math.max(this.logicalNow, now);
      this.#expire(next, now, command);
      const result = this.#apply(next, command, now);
      this.#derive(next, now);
      this.state = next;
      this.#schedule(next, now);
      const compact = { ok: result.ok, code: result.code, message: result.message };
      this.db.exec('INSERT INTO command_receipts(id,result) VALUES(?,?)', command.id, JSON.stringify(compact));
      return { ...compact, snapshot: structuredClone(this.state) };
    });
  }

  async onAlarm(): Promise<void> { await this.#advance(this.#now()); }

  #now(): number { return process.env.ODAS_TEST_MODE === '1' ? this.logicalNow || Date.now() : Date.now(); }

  async #advance(now: number): Promise<void> {
    await this.db.transaction(async () => {
      const next = structuredClone(this.state);
      const previous = JSON.stringify(next);
      this.#expire(next, now, { id: `alarm:${now}`, now });
      this.#derive(next, now);
      if (JSON.stringify(next) !== previous) this.state = next;
      this.#schedule(next, now);
    });
  }

  #event(s: RoomSnapshot, type: string, cmd: { id: string; now: number; correlationId?: string }, payload: Record<string, unknown> = {}, bookingId?: string): void {
    s.revision += 1;
    const id = `${this.id}:${cmd.id}:${type}:${s.revision}`;
    const event: DomainEvent = { version: 1, id, type, roomId: this.id, bookingId, correlationId: cmd.correlationId || cmd.id, revision: s.revision, idempotencyKey: id, occurredAt: cmd.now, payload };
    s.events = [...s.events, event];
  }

  #fresh(s: RoomSnapshot, now: number): boolean {
    const i = s.inspection;
    return !!i && i.connection === 'connected' && i.occupancy === 'vacant' && i.confidence >= CONFIDENCE && i.capturedAt <= now + 1000 && now - i.capturedAt <= EVIDENCE_MS;
  }

  #available(s: RoomSnapshot, start: number, end: number, exclude?: string): boolean {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || s.operational !== 'available') return false;
    if (s.blocks.some(b => start < b.endAt && end > b.startAt)) return false;
    if (s.expectedReadyAt !== null && s.expectedReadyAt > start) return false;
    return !s.intervals.some(i => i.bookingId !== exclude && i.status !== 'canceled' && start < i.endAt + BUFFER_MS && end + BUFFER_MS > i.startAt);
  }

  #expire(s: RoomSnapshot, now: number, cmd: { id: string; now: number; correlationId?: string }): void {
    s.intervals = s.intervals.map(i => {
      if (i.status === 'held' && (i.expiresAt ?? 0) <= now) {
        this.#event(s, 'inventory.hold_expired', cmd, {}, i.bookingId);
        return { ...i, status: 'canceled' as const, revision: i.revision + 1 };
      }
      return i;
    });
    if (s.job?.status === 'dispatching' && (s.job.claimExpiresAt ?? Infinity) < now) {
      s.job = { ...s.job, status: 'uncertain', reason: 'Dispatch claim expired; reconcile observed robot state before retrying.' };
      this.#event(s, 'cleaning.uncertain', cmd, { jobId: s.job.id });
    }
    const wasReady = s.readiness === 'ready';
    if (s.inspection && now - s.inspection.capturedAt > EVIDENCE_MS && s.occupancy !== 'unknown') {
      s.occupancy = 'unknown';
      s.readiness = 'unknown';
      if (wasReady) this.#event(s, 'room.evidence_stale', cmd, { capturedAt: s.inspection.capturedAt });
      if (s.job?.status === 'started') this.#event(s, 'cleaning.interrupt_required', cmd, { jobId: s.job.id, reason: 'Camera evidence expired while cleaning.' });
    }
  }

  #derive(s: RoomSnapshot, now: number): void {
    const inspection = s.inspection;
    const deviceFresh = !!s.device && s.device.connection === 'connected' && s.device.observedAt <= now + 1000 && now - s.device.observedAt <= TELEMETRY_MS;
    const moving = s.device?.state === 'cleaning' || s.device?.state === 'returning';
    const busy = !!s.job && ACTIVE_JOBS.has(s.job.status);
    s.readiness = s.operational === 'available' && this.#fresh(s, now) && inspection?.floor === 'clean' && inspection.surfaces === 'clear' && deviceFresh && !moving && !busy ? 'ready' : inspection ? 'not_ready' : 'unknown';
    const reasons: string[] = [];
    if (!inspection || !this.#fresh(s, now)) reasons.push(inspection?.occupancy === 'occupied' ? 'Occupancy detected' : 'Fresh confident vacancy inspection required');
    if (inspection?.surfaces === 'cluttered') reasons.push('Desk or surface clutter needs attention');
    if (inspection?.occupancy === 'unknown' || (inspection && inspection.confidence < CONFIDENCE)) reasons.push('Inspection is uncertain');
    if (!deviceFresh) reasons.push('Robot telemetry is disconnected, unverified, or stale');
    if (s.job?.status === 'failed' || s.job?.status === 'uncertain') reasons.push(s.job.reason || `Cleaning ${s.job.status}`);
    if (s.operational !== 'available') reasons.push(`Room is ${s.operational}`);
    s.attentionReasons = [...new Set(reasons)];
    if (s.readiness === 'ready') s.expectedReadyAt = null;
  }

  #schedule(s: RoomSnapshot, now: number): void {
    if (process.env.ODAS_TEST_MODE === '1') return; // Fixture ticks use their isolated logical clock.
    const deadlines = s.intervals.filter(i => i.status === 'held').map(i => i.expiresAt || 0);
    if (s.inspection && now - s.inspection.capturedAt <= EVIDENCE_MS) deadlines.push(s.inspection.capturedAt + EVIDENCE_MS + 1);
    if (s.job?.status === 'dispatching' && s.job.claimExpiresAt) deadlines.push(s.job.claimExpiresAt + 1);
    const next = deadlines.filter(t => t > now).sort((a, b) => a - b)[0];
    if (next) this.alarm.set(next);
  }

  #apply(s: RoomSnapshot, cmd: RoomCommand, now: number): { ok: boolean; code?: string; message?: string } {
    const reject = (code: string, message: string) => ({ ok: false, code, message });
    const event = (type: string, payload: Record<string, unknown> = {}, bookingId?: string) => this.#event(s, type, { ...cmd, now }, payload, bookingId);
    if (cmd.expectedRevision !== undefined && cmd.expectedRevision !== s.revision) return reject('revision_conflict', 'The room changed. Refresh and retry.');
    switch (cmd.type) {
      case 'hold': {
        const existing = s.intervals.find(i => i.bookingId === cmd.bookingId);
        if (existing && existing.status !== 'canceled') return existing.startAt === cmd.startAt && existing.endAt === cmd.endAt ? { ok: true } : reject('booking_conflict', 'Booking ID already owns another interval.');
        if (cmd.expiresAt <= now || cmd.endAt <= now || cmd.expiresAt > now + 24 * 60 * 60_000) return reject('invalid_hold', 'Hold deadlines must be in the future and within one day.');
        if (!this.#available(s, cmd.startAt, cmd.endAt, cmd.bookingId)) return reject('unavailable', 'The office is unavailable for this interval and turnover buffer.');
        if (existing?.status === 'canceled') return reject('expired_booking', 'An expired booking ID cannot reacquire inventory.');
        s.intervals = [...s.intervals, { bookingId: cmd.bookingId, startAt: cmd.startAt, endAt: cmd.endAt, status: 'held', expiresAt: cmd.expiresAt, revision: 1 }];
        event('inventory.held', { startAt: cmd.startAt, endAt: cmd.endAt, expiresAt: cmd.expiresAt }, cmd.bookingId);
        break;
      }
      case 'confirm': {
        const i = s.intervals.find(i => i.bookingId === cmd.bookingId);
        if (!i || i.status === 'canceled') return reject('hold_expired', 'Inventory hold has expired or is missing.');
        if (i.status === 'confirmed' || i.status === 'checked_in' || i.status === 'checked_out') return { ok: true };
        if ((i.expiresAt ?? 0) <= now) return reject('hold_expired', 'Inventory hold has expired.');
        s.intervals = s.intervals.map(x => x.bookingId === cmd.bookingId ? { ...x, status: 'confirmed', expiresAt: undefined, revision: x.revision + 1 } : x);
        event('inventory.confirmed', {}, cmd.bookingId);
        break;
      }
      case 'cancel': {
        const i = s.intervals.find(i => i.bookingId === cmd.bookingId);
        if (!i || i.status === 'canceled') return { ok: true };
        s.intervals = s.intervals.map(x => x.bookingId === cmd.bookingId ? { ...x, status: 'canceled', revision: x.revision + 1 } : x);
        event('inventory.canceled', {}, cmd.bookingId);
        break;
      }
      case 'check_in': {
        this.#derive(s, now);
        const i = s.intervals.find(i => i.bookingId === cmd.bookingId);
        if (i?.status === 'checked_in') return { ok: true };
        if (!i || i.status !== 'confirmed') return reject('not_confirmed', 'A confirmed reservation is required.');
        if (now < i.startAt - CHECK_IN_MS || now >= i.endAt) return reject('outside_checkin_window', `Check-in opens ${CHECK_IN_MS / 60_000} minutes before your reservation.`);
        if (s.readiness !== 'ready') return reject('not_ready', 'The office is not ready for check-in. Contact your concierge.');
        s.intervals = s.intervals.map(x => x.bookingId === cmd.bookingId ? { ...x, status: 'checked_in', revision: x.revision + 1 } : x);
        event('booking.checked_in', {}, cmd.bookingId);
        break;
      }
      case 'check_out': {
        const i = s.intervals.find(i => i.bookingId === cmd.bookingId);
        if (i?.status === 'checked_out') return { ok: true };
        if (!i || !['confirmed', 'checked_in'].includes(i.status)) return reject('not_confirmed', 'No active reservation was found.');
        s.intervals = s.intervals.map(x => x.bookingId === cmd.bookingId ? { ...x, status: 'checked_out', revision: x.revision + 1 } : x);
        s.occupancy = 'unknown'; s.cleanliness = 'unknown'; s.readiness = 'unknown'; s.inspection = null;
        this.inspectionRequiredAfter = now;
        event('room.inspection_requested', { reason: 'Guest checkout requires inspection; it does not prove vacancy.' }, cmd.bookingId);
        break;
      }
      case 'inspect': {
        const i = cmd.inspection;
        if (i.roomId !== this.id || !Number.isFinite(i.capturedAt) || !Number.isFinite(i.inferredAt) || i.capturedAt > now + 1000 || i.inferredAt < i.capturedAt || !Number.isFinite(i.confidence) || i.confidence < 0 || i.confidence > 1 || !Number.isSafeInteger(i.sequence) || i.sequence < 1 || !['vacant', 'occupied', 'unknown'].includes(i.occupancy) || !['clean', 'dirty', 'unknown'].includes(i.floor) || !['clear', 'cluttered', 'unknown'].includes(i.surfaces) || !['connected', 'disconnected', 'unverified'].includes(i.connection)) return reject('invalid_inspection', 'The inspection timestamp, room, or typed evidence is invalid.');
        if (i.sequence <= Math.max(this.lastInspectionSequence, s.inspection?.sequence || 0) || i.capturedAt < this.inspectionRequiredAfter || (s.inspection && i.capturedAt < s.inspection.capturedAt)) return reject('out_of_order', 'An older inspection cannot replace newer evidence.');
        this.lastInspectionSequence = i.sequence;
        s.inspection = i;
        s.occupancy = now - i.capturedAt <= EVIDENCE_MS && i.connection === 'connected' && i.confidence >= CONFIDENCE ? i.occupancy : 'unknown';
        s.cleanliness = i.floor;
        event('room.inspected', { inspectionId: i.id, occupancy: s.occupancy, floor: i.floor, surfaces: i.surfaces, capturedAt: i.capturedAt, confidence: i.confidence });
        if (s.job?.status === 'started' && (!this.#fresh(s, now) || i.occupancy === 'occupied')) event('cleaning.interrupt_required', { jobId: s.job.id, reason: i.occupancy === 'occupied' ? 'Person detected during cleaning.' : 'Vacancy evidence is unavailable.' });
        break;
      }
      case 'telemetry': {
        const t = cmd.telemetry;
        if (t.roomId !== this.id || !Number.isFinite(t.observedAt) || t.observedAt > now + 1000 || !['docked', 'cleaning', 'returning', 'idle', 'unknown', 'error'].includes(t.state) || !['connected', 'disconnected', 'unverified'].includes(t.connection) || (s.device && t.observedAt < s.device.observedAt)) return reject('out_of_order', 'Robot telemetry is stale, contradictory, or belongs to another room.');
        const previousDevice = s.device;
        s.device = t;
        if (s.job && ['dispatching', 'uncertain'].includes(s.job.status) && t.state === 'cleaning' && t.connection === 'connected' && t.observedAt >= s.job.requestedAt) {
          s.job = { ...s.job, status: 'started', startedAt: s.job.startedAt || t.observedAt };
          event('cleaning.started', { jobId: s.job.id, expectedReadyAt: s.expectedReadyAt });
        } else if (s.job?.status === 'started' && t.state === 'docked' && t.connection === 'connected' && t.observedAt > (s.job.startedAt || 0)) {
          s.job = { ...s.job, status: 'completed', completedAt: t.observedAt };
          s.inspection = null; s.occupancy = 'unknown'; s.cleanliness = 'unknown';
          this.inspectionRequiredAfter = t.observedAt;
          event('cleaning.completed', { jobId: s.job.id });
          event('room.inspection_requested', { reason: 'Fresh post-cleaning inspection is required.' });
        } else if (s.job?.status === 'interrupted' && t.state === 'docked' && t.connection === 'connected' && previousDevice?.state !== 'docked') {
          s.inspection = null; s.occupancy = 'unknown'; s.cleanliness = 'unknown';
          this.inspectionRequiredAfter = Math.max(this.inspectionRequiredAfter, t.observedAt);
          event('room.inspection_requested', { reason: 'Fresh inspection is required after interrupted cleaning reaches the dock.' });
        }
        if (t.connection !== 'connected' && s.job?.status === 'started') event('cleaning.interrupt_required', { jobId: s.job.id, reason: 'Robot connection lost; stop delivery is uncertain.' });
        break;
      }
      case 'request_clean': {
        if (s.job && ACTIVE_JOBS.has(s.job.status)) return s.job.id === cmd.jobId ? { ok: true } : reject('job_active', 'A cleaning job is already active.');
        if (s.operational !== 'available' || !this.#fresh(s, now)) return reject('vacancy_required', 'Fresh confident vacancy evidence is required before cleaning.');
        if (s.inspection?.surfaces !== 'clear') return reject('surface_attention', 'Desk or surface clutter requires attention before cleaning.');
        s.job = { id: cmd.jobId, status: 'requested', requestedAt: now, expectedReadyAt: cmd.expectedReadyAt || now + 10 * 60_000, estimateSource: 'configured', commandId: `${cmd.jobId}:start` };
        s.expectedReadyAt = s.job.expectedReadyAt || null;
        event('cleaning.requested', { jobId: cmd.jobId, expectedReadyAt: s.expectedReadyAt, estimateSource: 'configured' });
        this.#disruptions(s, cmd, now);
        break;
      }
      case 'claim_clean': {
        if (!s.job || s.job.id !== cmd.jobId || s.job.status !== 'requested') return reject('job_not_requested', 'The job cannot be claimed. Reconcile its existing state.');
        if (s.job.claimId && (s.job.claimExpiresAt || 0) > now && s.job.claimId !== cmd.claimId) return reject('claim_conflict', 'Another worker owns the cleaning claim.');
        s.job = { ...s.job, claimId: cmd.claimId, claimExpiresAt: cmd.claimExpiresAt };
        event('cleaning.claimed', { jobId: cmd.jobId, claimId: cmd.claimId });
        break;
      }
      case 'authorize_dispatch': {
        if (!s.job || s.job.id !== cmd.jobId || s.job.status !== 'requested' || s.job.claimId !== cmd.claimId || (s.job.claimExpiresAt || 0) <= now) return reject('invalid_claim', 'The cleaning claim is no longer valid.');
        if (!this.#fresh(s, now) || s.operational !== 'available' || s.inspection?.surfaces !== 'clear') return reject('vacancy_required', 'Fresh confident vacancy is required at dispatch.');
        if (!s.device || s.device.connection !== 'connected' || now - s.device.observedAt > TELEMETRY_MS || !['docked', 'idle'].includes(s.device.state)) return reject('device_unavailable', 'A fresh idle robot observation is required.');
        s.job = { ...s.job, status: 'dispatching' };
        event('cleaning.dispatching', { jobId: cmd.jobId, commandId: s.job.commandId });
        break;
      }
      case 'job_result': {
        if (!s.job || s.job.id !== cmd.jobId) return reject('job_not_found', 'The cleaning job does not exist.');
        // Motion and completion are accepted only through observed telemetry.
        if (cmd.status === 'started' || cmd.status === 'completed') return reject('telemetry_required', 'Observed robot telemetry is required for start and completion.');
        if (s.job.status === 'completed') return { ok: true };
        s.job = { ...s.job, status: cmd.status, reason: cmd.reason, expectedReadyAt: cmd.expectedReadyAt || s.job.expectedReadyAt };
        if (cmd.expectedReadyAt) s.expectedReadyAt = cmd.expectedReadyAt;
        event(`cleaning.${cmd.status}`, { jobId: cmd.jobId, reason: cmd.reason, expectedReadyAt: s.expectedReadyAt });
        if (cmd.status === 'interrupted') {
          s.inspection = null; s.occupancy = 'unknown'; s.cleanliness = 'unknown';
          this.inspectionRequiredAfter = Math.max(this.inspectionRequiredAfter, now);
          event('room.inspection_requested', { reason: 'Interrupted cleaning requires fresh inspection; earlier frames cannot establish readiness.' });
        }
        this.#disruptions(s, cmd, now);
        break;
      }
      case 'set_operational': s.operational = cmd.operational; event('room.operational_changed', { operational: cmd.operational, reason: cmd.reason }); break;
      case 'block': {
        if (cmd.endAt <= cmd.startAt || !Number.isFinite(cmd.startAt) || !Number.isFinite(cmd.endAt)) return reject('invalid_interval', 'A valid availability block interval is required.');
        s.blocks = [...s.blocks.filter(b => b.id !== cmd.blockId), { id: cmd.blockId, startAt: cmd.startAt, endAt: cmd.endAt, reason: cmd.reason }];
        event('room.blocked', { blockId: cmd.blockId, reason: cmd.reason }); break;
      }
      case 'unblock': s.blocks = s.blocks.filter(b => b.id !== cmd.blockId); event('room.unblocked', { blockId: cmd.blockId }); break;
      case 'ack_events': s.events = s.events.filter(e => !cmd.eventIds.includes(e.id)); break;
      case 'tick': break;
      default: return reject('invalid_command', 'Unknown room command.');
    }
    return { ok: true };
  }

  #disruptions(s: RoomSnapshot, cmd: RoomCommand, now: number): void {
    if (!s.expectedReadyAt) return;
    for (const i of s.intervals) if (['confirmed', 'checked_in'].includes(i.status) && i.endAt > now && s.expectedReadyAt > i.startAt) {
      this.#event(s, 'room.readiness_delayed', { ...cmd, now }, { expectedReadyAt: s.expectedReadyAt, startAt: i.startAt, jobId: s.job?.id, estimateSource: 'configured' }, i.bookingId);
    }
  }
}
