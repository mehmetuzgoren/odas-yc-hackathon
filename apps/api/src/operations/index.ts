import { Hono } from 'hono';
import { z } from 'zod';
import { audit, fail, parseJSON, requireOperator, uid, type Runtime } from '../core';
import { cameraInspectionSchema, demoPatchSchema } from './demo';
import { canControlDevices } from './permissions';
import { roomConversation } from './conversation';
import { modelStatus } from '../ai';

const roomPatch = z.object({ description: z.string().max(2000).optional(), rateCents: z.number().int().min(1).max(100000).nullable().optional(), accessInstructions: z.string().max(6000).nullable().optional(), hours: z.object({ open: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), close: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), days: z.array(z.number().int().min(1).max(7)), modeled: z.boolean() }).optional(), operational: z.enum(['available', 'maintenance', 'blocked']).optional(), reason: z.string().max(1000).optional() }).strict();

export function createOperationsRoutes(rt: Runtime) {
  const app = new Hono();
  const operations = () => rt.services.operations as any;
  const internal = (authorization: string | undefined) => { if (!authorization || authorization !== `Bearer ${rt.config.internalToken}`) fail(401, 'Internal authentication is required.'); };
  const deviceBase = () => String(rt.config.deviceUrl || process.env.DEVICE_URL || `http://127.0.0.1:${process.env.DEVICE_PORT || 7300}`);
  async function roomRecord(id: string) {
    return await rt.db.query('SELECT o.*,g.name AS workspace_name,g.address,g.access_instructions,g.hours_json,g.base_rate_cents,g.timezone FROM offices o JOIN workspace_groups g ON g.id=o.group_id WHERE o.id=?').get(id) as any;
  }
  async function detail(id: string) {
    const row = await roomRecord(id); if (!row) fail(404, 'Office not found.');
    const upcoming = await rt.db.query("SELECT id,room_id,start_at,end_at,status,payment_status,refund_status FROM reservations WHERE room_id=? AND end_at>? AND status NOT IN ('canceled','expired','unfulfillable') ORDER BY start_at LIMIT 25").all(id, rt.clock.now());
    const tasks = await rt.db.query('SELECT * FROM attention_tasks WHERE room_id=? ORDER BY created_at DESC LIMIT 50').all(id);
    const auditLog = await rt.db.query('SELECT id,actor,action,data,created_at FROM audit_log WHERE entity_id=? ORDER BY created_at DESC LIMIT 30').all(id);
    return { office: { id: row.id, groupId: row.group_id, name: row.name, description: row.description, rateCents: row.rate_cents ?? row.base_rate_cents, rateOverrideCents: row.rate_cents, modeled: !!row.modeled, attributes: parseJSON(row.attributes_json, {}), photos: parseJSON(row.photos_json, []), deviceBinding: parseJSON(row.device_binding_json, null) }, workspace: { id: row.group_id, name: row.workspace_name, address: row.address, hours: parseJSON(row.hours_json, {}), accessInstructions: row.access_instructions, timezone: row.timezone }, state: await rt.rooms.snapshot(id), upcoming, tasks, audit: auditLog, deviceMode: rt.config.deviceMode, now: rt.clock.now() };
  }
  app.get('/operator/rooms', async c => {
    const user = await requireOperator(c, rt);
    const rows = await rt.db.query('SELECT o.id,o.name,o.group_id,g.name AS workspace_name,COALESCE(o.rate_cents,g.base_rate_cents) AS rate_cents FROM offices o JOIN workspace_groups g ON o.group_id=g.id JOIN operator_scopes s ON s.group_id=o.group_id WHERE s.user_id=? ORDER BY g.name,o.id').all(user.id) as any[];
    const rooms = [];
    for (const row of rows) rooms.push({ id: row.id, name: row.name, groupId: row.group_id, workspaceName: row.workspace_name, rateCents: row.rate_cents, state: await rt.rooms.snapshot(row.id) });
    return c.json({ rooms, deviceMode: rt.config.deviceMode, now: rt.clock.now(), note: rt.config.deviceMode === 'simulator' ? 'Simulated device observations. No physical robot or camera connection is claimed.' : 'Physical adapters enabled. Unverified connections remain explicitly unverified.' });
  });
  app.get('/operator/rooms/:id', async c => { const user = await requireOperator(c, rt, c.req.param('id')); return c.json({ ...await detail(c.req.param('id')), canControlDevices: await canControlDevices(rt, user, c.req.param('id')) }); });
  app.get('/operator/rooms/:id/conversation', async c => { const id = c.req.param('id'); await requireOperator(c, rt, id); return c.json({ messages: await roomConversation(rt, id), ...modelStatus() }); });
  app.get('/operator/rooms/:id/demo', async c => {
    const id = c.req.param('id'); await requireOperator(c, rt, id);
    const [status, state] = await Promise.all([operations().demoStatus(id), rt.rooms.snapshot(id)]);
    return c.json({ ...status, state });
  });
  app.patch('/operator/rooms/:id/demo', async c => {
    const id = c.req.param('id'); const user = await requireOperator(c, rt, id);
    const changes = demoPatchSchema.parse(await c.req.json());
    const status = await operations().configureDemo(id, changes);
    await audit(rt, user.id, 'demo.controls_changed', id, changes);
    return c.json({ ...status, state: await rt.rooms.snapshot(id) });
  });
  app.patch('/operator/rooms/:id', async c => {
    const id = c.req.param('id'); const user = await requireOperator(c, rt, id); const patch = roomPatch.parse(await c.req.json());
    const row = await roomRecord(id); if (!row) fail(404, 'Office not found.');
    if (patch.operational) await operations().command(id, { type: 'set_operational', operational: patch.operational, reason: patch.reason || 'Operator configuration change' });
    await rt.db.transaction(async () => {
      if (patch.description !== undefined) await rt.db.query('UPDATE offices SET description=? WHERE id=?').run(patch.description, id);
      if (patch.rateCents !== undefined) await rt.db.query('UPDATE offices SET rate_cents=? WHERE id=?').run(patch.rateCents, id);
      if (patch.accessInstructions !== undefined) await rt.db.query('UPDATE workspace_groups SET access_instructions=? WHERE id=?').run(patch.accessInstructions, row.group_id);
      if (patch.hours !== undefined) await rt.db.query('UPDATE workspace_groups SET hours_json=? WHERE id=?').run(JSON.stringify(patch.hours), row.group_id);
      await audit(rt, user.id, 'room.configuration_updated', id, patch);
    })();
    return c.json(await detail(id));
  });
  app.post('/operator/rooms/:id/inspect', async c => { const id = c.req.param('id'); const user = await requireOperator(c, rt, id); await audit(rt, user.id, 'room.inspection_requested', id); const result = await operations().inspect(id); return c.json(result); });
  app.post('/operator/rooms/:id/clean', async c => {
    const id = c.req.param('id'); const user = await requireOperator(c, rt, id);
    await operations().requireRobo(id);
    // Inspection is a real observation; only the actor may authorize later dispatch.
    await operations().inspect(id); await operations().telemetry(id);
    const state = await operations().command(id, { type: 'request_clean', jobId: uid('clean'), expectedReadyAt: rt.clock.now() + Number(rt.config.cleaningEstimateMs || 10 * 60_000) });
    await audit(rt, user.id, 'cleaning.requested', id, { jobId: state.job?.id });
    return c.json({ state, message: 'Cleaning requested. Dispatch and observed motion are separate stages.' });
  });
  app.post('/operator/rooms/:id/dock', async c => { const id = c.req.param('id'); const user = await requireOperator(c, rt, id); await audit(rt, user.id, 'robot.dock_requested', id); return c.json(await operations().dock(id)); });
  app.post('/operator/rooms/:id/blocks', async c => {
    const id = c.req.param('id'); const user = await requireOperator(c, rt, id);
    const body = z.object({ startAt: z.number().int(), endAt: z.number().int(), reason: z.string().min(1).max(1000) }).parse(await c.req.json());
    const state = await operations().command(id, { type: 'block', blockId: uid('block'), ...body }); await audit(rt, user.id, 'room.blocked', id, body); return c.json({ state });
  });
  app.delete('/operator/rooms/:id/blocks/:blockId', async c => { const id = c.req.param('id'); const user = await requireOperator(c, rt, id); const state = await operations().command(id, { type: 'unblock', blockId: c.req.param('blockId') }); await audit(rt, user.id, 'room.unblocked', id, { blockId: c.req.param('blockId') }); return c.json({ state }); });
  app.get('/operator/tasks', async c => {
    const user = await requireOperator(c, rt);
    const tasks = await rt.db.query('SELECT t.*,o.name AS room_name,g.name AS workspace_name FROM attention_tasks t JOIN offices o ON t.room_id=o.id JOIN workspace_groups g ON o.group_id=g.id JOIN operator_scopes s ON s.group_id=o.group_id WHERE s.user_id=? ORDER BY CASE WHEN t.status=\'resolved\' THEN 1 ELSE 0 END,t.created_at DESC LIMIT 150').all(user.id);
    return c.json({ tasks });
  });
  app.patch('/operator/tasks/:id', async c => {
    const task = await rt.db.query('SELECT * FROM attention_tasks WHERE id=?').get(c.req.param('id')) as any; if (!task) fail(404, 'Attention task not found.');
    const user = await requireOperator(c, rt, task.room_id);
    const body = z.object({ assignee: z.string().min(1).max(200) }).parse(await c.req.json());
    await rt.db.query("UPDATE attention_tasks SET assignee=?,status='assigned' WHERE id=?").run(body.assignee, task.id); await audit(rt, user.id, 'attention.assigned', task.room_id, { taskId: task.id, assignee: body.assignee }); return c.json({ ok: true });
  });
  app.post('/operator/tasks/:id/resolve', async c => {
    const task = await rt.db.query('SELECT * FROM attention_tasks WHERE id=?').get(c.req.param('id')) as any; if (!task) fail(404, 'Attention task not found.');
    const user = await requireOperator(c, rt, task.room_id);
    const body = z.object({ evidence: z.string().min(10).max(6000) }).parse(await c.req.json());
    await rt.db.query("UPDATE attention_tasks SET status='resolved',assignee=COALESCE(assignee,?),resolution_evidence=?,resolved_at=? WHERE id=?").run(user.id, body.evidence, rt.clock.now(), task.id);
    await audit(rt, user.id, 'attention.resolved', task.room_id, { taskId: task.id, evidence: body.evidence });
    return c.json({ ok: true, message: 'Task resolved. Readiness still requires a fresh successful inspection.' });
  });
  app.get('/operator/rooms/:id/frame', async c => {
    const id = c.req.param('id'); await requireOperator(c, rt, id);
    const response = await fetch(`${deviceBase()}/v1/rooms/${encodeURIComponent(id)}/frame`, { headers: { authorization: `Bearer ${rt.config.internalToken}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) fail(503, 'No verified camera frame is available.');
    c.header('Cache-Control', 'no-store'); c.header('Content-Type', 'image/jpeg'); return c.body(await response.arrayBuffer());
  });
  app.get('/operator/rooms/:id/stream', async c => {
    const id = c.req.param('id'); await requireOperator(c, rt, id);
    const controller = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true });
    const response = await fetch(`${deviceBase()}/v1/rooms/${encodeURIComponent(id)}/stream`, { headers: { authorization: `Bearer ${rt.config.internalToken}` }, signal: controller.signal });
    if (!response.ok) fail(503, 'No camera stream is available.');
    return new Response(response.body, { headers: { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' } });
  });
  app.post('/internal/devices/inspection', async c => {
    internal(c.req.header('authorization'));
    const result = await operations().observeInspection(cameraInspectionSchema.parse(await c.req.json()));
    return c.json({ accepted: result.ok, ...(result.code ? { code: result.code } : {}) });
  });
  app.post('/internal/devices/authorize', async c => { internal(c.req.header('authorization')); const body = z.object({ roomId: z.string(), commandId: z.string() }).parse(await c.req.json()); return c.json({ authorized: await operations().authorizePhysical(body.roomId, body.commandId), now: rt.clock.now() }); });
  app.post('/internal/simulator/:id', async c => {
    internal(c.req.header('authorization'));
    if (!rt.config.testMode || rt.config.deviceMode !== 'simulator') fail(403, 'Simulator controls require an isolated test runtime.');
    const payload = await c.req.json();
    const response = await fetch(`${deviceBase()}/v1/rooms/${encodeURIComponent(c.req.param('id'))}/simulate`, { method: 'POST', headers: { authorization: `Bearer ${rt.config.internalToken}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return c.json(await response.json(), response.ok ? 200 : 400);
  });
  return app;
}
export { createOperationsService } from './service';
export { createRoomGateway } from './gateway';
