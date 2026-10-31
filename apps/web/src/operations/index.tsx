import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Temporal } from '@js-temporal/polyfill';
import { Camera, ClipboardList, RefreshCw, Wrench, ShieldCheck } from 'lucide-react';
import { money, type RoomSnapshot } from '@odas/contracts';
import { api, useSession } from '../api';
import './operations.css';

type RoomRow = { id: string; name: string; groupId: string; workspaceName: string; rateCents: number; state: RoomSnapshot };
type Task = { id: string; room_id: string; room_name?: string; workspace_name?: string; reason: string; status: string; assignee?: string; resolution_evidence?: string; created_at: number };
type Detail = { office: { id: string; name: string; description: string; rateCents: number; rateOverrideCents: number | null; modeled: boolean; deviceBinding: unknown }; workspace: { name: string; timezone: string; accessInstructions?: string | null; hours: { open?: string; close?: string; days?: number[]; modeled?: boolean } }; state: RoomSnapshot; upcoming: { id: string; start_at: number; end_at: number; status: string; payment_status: string }[]; tasks: Task[]; audit: { id: string; actor: string; action: string; created_at: number }[]; deviceMode: string; now: number };
const time = (at: number | null | undefined, timezone = 'America/Los_Angeles') => at ? new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at) : 'Unknown';
const label = (value: string) => value.replaceAll('_', ' ');

export function OperatorPage() {
  const { user, loading } = useSession();
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [mode, setMode] = useState('unverified');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'rooms' | 'tasks'>('rooms');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [description, setDescription] = useState('');
  const [rate, setRate] = useState('');
  const [access, setAccess] = useState('');
  const [open, setOpen] = useState('');
  const [close, setClose] = useState('');
  const [days, setDays] = useState<number[]>([]);
  const [modeledHours, setModeledHours] = useState(true);
  const [operational, setOperational] = useState('available');
  const [reason, setReason] = useState('');
  const [blockStart, setBlockStart] = useState('');
  const [blockEnd, setBlockEnd] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [assignees, setAssignees] = useState<Record<string, string>>({});

  async function reload(id = selected) {
    const [inventory, attention] = await Promise.all([api<{ rooms: RoomRow[]; deviceMode: string }>('/operator/rooms'), api<{ tasks: Task[] }>('/operator/tasks')]);
    setRooms(inventory.rooms); setMode(inventory.deviceMode); setTasks(attention.tasks);
    const next = id || inventory.rooms[0]?.id;
    if (next) { setSelected(next); setDetail(await api<Detail>(`/operator/rooms/${next}`)); }
  }
  useEffect(() => {
    if (user?.role !== 'operator') return;
    let active = true;
    reload().catch(e => active && setError(e.message));
    const timer = window.setInterval(() => { reload().catch(() => {}); }, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [user?.id, selected]);
  useEffect(() => {
    if (!detail) return;
    setDescription(detail.office.description); setRate(detail.office.rateOverrideCents === null ? '' : String(detail.office.rateOverrideCents / 100));
    setAccess(detail.workspace.accessInstructions || ''); setOpen(detail.workspace.hours.open || ''); setClose(detail.workspace.hours.close || '');
    setDays(detail.workspace.hours.days || []); setModeledHours(detail.workspace.hours.modeled ?? true); setOperational(detail.state.operational); setCameraOpen(false); setCameraError(false);
  }, [detail?.office.id]);
  async function action(path: string, body: unknown = {}, method = 'POST', message = 'Action saved.') {
    setBusy(true); setError(''); setSuccess('');
    try { await api(path, { method, body: JSON.stringify(body) }); await reload(); setSuccess(message); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const amount = rate === '' ? null : Math.round(Number(rate) * 100);
    if (amount !== null && (!Number.isFinite(amount) || amount < 1)) { setError('Enter a positive hourly rate, or leave it blank to use the workspace rate.'); return; }
    await action(`/operator/rooms/${selected}`, { description, rateCents: amount, accessInstructions: access.trim() || null, ...(open && close ? { hours: { open, close, days, modeled: modeledHours } } : {}), operational, reason: reason || 'Operator configuration update' }, 'PATCH', 'Office configuration saved.');
  }
  async function addBlock(event: FormEvent) {
    event.preventDefault();
    try {
      const zone = detail?.workspace.timezone || 'America/Los_Angeles';
      const startAt = Temporal.PlainDateTime.from(blockStart).toZonedDateTime(zone, { disambiguation: 'reject' }).epochMilliseconds;
      const endAt = Temporal.PlainDateTime.from(blockEnd).toZonedDateTime(zone, { disambiguation: 'reject' }).epochMilliseconds;
      await action(`/operator/rooms/${selected}/blocks`, { startAt, endAt, reason: blockReason }, 'POST', 'Availability block saved.');
    } catch { setError('Select a valid date and time. Ambiguous daylight saving times require a different interval.'); }
  }
  if (loading) return <main className="container page"><p role="status">Loading your session…</p></main>;
  if (!user) return <main className="container page"><h1>Operations</h1><p>Sign in with a separately provisioned operator account.</p><Link className="button" to="/login?next=/operator">Sign in</Link></main>;
  if (user.role !== 'operator') return <main className="container page"><h1>Operator access required</h1><p>This account is a guest account. Your reservations are available in your account.</p><Link to="/reservations">My reservations</Link></main>;
  function taskList(items: Task[]) {
    return items.length ? <div className="ops-task-list">{items.map(task => <article className="ops-task" key={task.id}>
      <div><span className={`badge ${task.status === 'resolved' ? 'success' : ''}`}>{label(task.status)}</span><h3>{task.reason}</h3><p className="muted">{task.room_name || detail?.office.name || task.room_id} · {time(task.created_at)}{task.assignee ? ` · Assigned to ${task.assignee}` : ''}</p></div>
      {task.status === 'resolved' ? <p>{task.resolution_evidence}</p> : <div className="ops-task-actions"><label className="field">Assignee<input value={assignees[task.id] ?? task.assignee ?? ''} onChange={e => setAssignees({ ...assignees, [task.id]: e.target.value })} /></label><button className="button secondary" disabled={busy || !(assignees[task.id] || task.assignee)} onClick={() => action(`/operator/tasks/${task.id}`, { assignee: assignees[task.id] || task.assignee }, 'PATCH', 'Task assigned.')}>Assign</button><label className="field ops-resolution">Resolution evidence<textarea placeholder="Describe the work completed and what you observed." minLength={10} value={resolution[task.id] || ''} onChange={e => setResolution({ ...resolution, [task.id]: e.target.value })} /></label><button className="button secondary" disabled={busy || (resolution[task.id] || '').length < 10} onClick={() => action(`/operator/tasks/${task.id}/resolve`, { evidence: resolution[task.id] }, 'POST', 'Task resolved. A fresh successful inspection is still required for readiness.')}>Resolve task</button></div>}
    </article>)}</div> : <p className="muted">No attention tasks.</p>;
  }
  const state = detail?.state;
  return <main className="container page ops-page">
    <div className="ops-heading"><div><p className="eyebrow">ODAS operations</p><h1>Room control</h1><p className="muted">Inventory and turnover for your assigned workspaces.</p></div><button className="button secondary" disabled={busy} onClick={() => { setError(''); reload().catch(e => setError(e.message)); }}><RefreshCw size={17} /> Refresh</button></div>
    <div className="ops-mode" role="note"><ShieldCheck size={20} /><div><strong>{mode === 'simulator' ? 'Simulator mode' : 'Physical adapter mode'}</strong><p>{mode === 'simulator' ? 'Device observations are simulated and explicitly bound to configured offices. Other offices remain unverified.' : 'Connection status reflects configured adapters. Commissioning must verify the private camera route and Q10 cloud commands.'}</p></div></div>
    {error && <p role="alert" className="error">{error}</p>}{success && <p role="status" className="success">{success}</p>}
    <nav className="ops-tabs" aria-label="Operations views"><button aria-pressed={tab === 'rooms'} className={tab === 'rooms' ? 'active' : ''} onClick={() => setTab('rooms')}><Wrench size={17} /> Offices ({rooms.length})</button><button aria-pressed={tab === 'tasks'} className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}><ClipboardList size={17} /> Attention ({tasks.filter(t => t.status !== 'resolved').length})</button></nav>
    {tab === 'tasks' ? <section><h2>Attention tasks</h2><p className="muted">Resolving a task records evidence. Room readiness comes from fresh inspections and device observations.</p>{taskList(tasks)}</section> : <div className="ops-layout">
      <aside className="ops-inventory" aria-label="Assigned offices">{rooms.length ? rooms.map(room => <button key={room.id} className={`ops-room-row ${selected === room.id ? 'selected' : ''}`} aria-current={selected === room.id ? 'true' : undefined} onClick={() => setSelected(room.id)}><span><strong>{room.name}</strong><small>{room.workspaceName}</small></span><span className={`ops-status ${room.state.readiness === 'ready' ? 'ready' : ''}`}>{label(room.state.readiness)}</span><small>{money(room.rateCents)}/hr</small></button>) : <p>{error ? 'Inventory could not be loaded.' : 'No workspaces are assigned to this account.'}</p>}</aside>
      <section className="ops-detail" aria-live="polite">{detail && state ? <>
        <div className="ops-room-title"><div><p className="muted">{detail.workspace.name}</p><h2>{detail.office.name}</h2></div><span className="badge">{detail.office.modeled ? 'Modeled inventory' : 'Configured inventory'}</span></div>
        <div className="ops-signals"><div><span>Readiness</span><strong>{label(state.readiness)}</strong></div><div><span>Occupancy</span><strong>{state.occupancy}</strong></div><div><span>Floor</span><strong>{state.cleanliness}</strong></div><div><span>Robot connection</span><strong>{state.device?.connection || 'unverified'}</strong></div><div><span>Robot state</span><strong>{state.device?.state || 'unknown'}</strong></div><div><span>Operational availability</span><strong>{state.operational}</strong></div></div>
        <p className="muted">Evidence captured {time(state.inspection?.capturedAt)} · Inference returned {time(state.inspection?.inferredAt)} · Revision {state.revision}</p>
        {state.attentionReasons.length > 0 && <div className="ops-attention-note"><strong>Needs attention</strong><ul>{state.attentionReasons.map(r => <li key={r}>{r}</li>)}</ul></div>}
        <div className="ops-controls"><button className="button" disabled={busy} onClick={() => action(`/operator/rooms/${selected}/inspect`, {}, 'POST', 'Inspection requested and recorded.')}>Inspect room</button><button className="button secondary" disabled={busy || state.operational !== 'available'} onClick={() => action(`/operator/rooms/${selected}/clean`, {}, 'POST', 'Cleaning request recorded. Dispatch still requires actor authorization and observed vacancy.')}>Request vacuum clean</button><button className="button secondary" disabled={busy} onClick={() => action(`/operator/rooms/${selected}/dock`, {}, 'POST', 'Dock request recorded. Check observed robot state for completion.')}>Return to dock</button><button className="button secondary" onClick={() => { setCameraOpen(!cameraOpen); setCameraError(false); }}><Camera size={17} /> {cameraOpen ? 'Hide camera' : 'View camera'}</button></div>
        {cameraOpen && <div className="ops-camera">{cameraError ? <p role="status">No verified camera frame is available. Simulated observations do not contain camera photos.</p> : <img src={`/api/operator/rooms/${selected}/frame`} alt={`Latest restricted camera frame for ${detail.office.name}`} onError={() => setCameraError(true)} />}</div>}
        <section className="ops-section"><h3>Cleaning job</h3>{state.job ? <div className="ops-job"><span className="badge">{label(state.job.status)}</span><p>Expected readiness: <strong>{time(state.expectedReadyAt || state.job.expectedReadyAt)}</strong> ({state.job.estimateSource === 'configured' ? 'configured estimate; no measured history yet' : 'estimate from cleaning history'}{(state.expectedReadyAt || state.job.expectedReadyAt || Infinity) < detail.now && state.readiness !== 'ready' ? '; estimate has passed, readiness is uncertain' : ''})</p><p className="muted">{state.job.reason || 'Vendor acceptance and observed motion are separate stages.'}</p><small>Job {state.job.id}</small></div> : <p className="muted">No cleaning job has been requested.</p>}</section>
        <section className="ops-section"><h3>Upcoming reservations</h3>{detail.upcoming.length ? <div className="ops-table-wrap"><table><thead><tr><th>Reservation</th><th>Interval ({detail.workspace.timezone})</th><th>Status</th><th>Payment</th></tr></thead><tbody>{detail.upcoming.map(b => <tr key={b.id}><td>{b.id}</td><td>{time(b.start_at)} to {time(b.end_at)}</td><td>{label(b.status)}</td><td>{label(b.payment_status)}</td></tr>)}</tbody></table></div> : <p className="muted">No upcoming reservations.</p>}</section>
        <section className="ops-section"><h3>Office configuration</h3><form onSubmit={save} className="ops-form"><label className="field ops-wide">Office description<textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} /></label><label className="field">Hourly rate override (USD)<input type="number" min="0.01" step="0.01" value={rate} placeholder="Use workspace rate" onChange={e => setRate(e.target.value)} /></label><label className="field">Operational availability<select value={operational} onChange={e => setOperational(e.target.value)}><option value="available">Available</option><option value="maintenance">Maintenance</option><option value="blocked">Blocked</option></select></label><label className="field ops-wide">Reason for change<input value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} /></label><label className="field ops-wide">Workspace access instructions<textarea value={access} placeholder="Unknown. Enter only confirmed access instructions." onChange={e => setAccess(e.target.value)} maxLength={6000} /></label><p className="ops-wide muted">Access and hours apply to this workspace and are shown only to authorized guests. Empty access instructions remain unknown.</p><label className="field">Workspace opens<input type="time" value={open} onChange={e => setOpen(e.target.value)} /></label><label className="field">Workspace closes<input type="time" value={close} onChange={e => setClose(e.target.value)} /></label><fieldset className="ops-wide ops-days"><legend>Bookable days ({detail.workspace.timezone})</legend>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => <label key={day}><input type="checkbox" checked={days.includes(index + 1)} onChange={e => setDays(e.target.checked ? [...days, index + 1] : days.filter(d => d !== index + 1))} />{day}</label>)}</fieldset><label className="ops-wide ops-checkbox"><input type="checkbox" checked={modeledHours} onChange={e => setModeledHours(e.target.checked)} /> Hours are modeled for testing and have not been verified as property access hours</label><div className="ops-wide"><button className="button" disabled={busy}>Save configuration</button></div></form></section>
        <section className="ops-section"><h3>Availability blocks</h3>{state.blocks.map(b => <div key={b.id} className="ops-block"><div><strong>{b.reason}</strong><p>{time(b.startAt)} to {time(b.endAt)}</p></div><button className="button secondary" disabled={busy} onClick={() => action(`/operator/rooms/${selected}/blocks/${b.id}`, {}, 'DELETE', 'Availability block removed.')}>Remove block</button></div>)}<form className="ops-form" onSubmit={addBlock}><label className="field">Starts ({detail.workspace.timezone})<input type="datetime-local" required value={blockStart} onChange={e => setBlockStart(e.target.value)} /></label><label className="field">Ends<input type="datetime-local" required value={blockEnd} onChange={e => setBlockEnd(e.target.value)} /></label><label className="field ops-wide">Reason<input required value={blockReason} onChange={e => setBlockReason(e.target.value)} /></label><div className="ops-wide"><button className="button secondary" disabled={busy}>Add block</button></div></form></section>
        <section className="ops-section"><h3>Office attention tasks</h3>{taskList(detail.tasks)}</section><section className="ops-section"><h3>Audit history</h3>{detail.audit.length ? <ol className="ops-audit">{detail.audit.map(a => <li key={a.id}><strong>{label(a.action.replaceAll('.', ' '))}</strong><span>{time(a.created_at)} · {a.actor}</span></li>)}</ol> : <p className="muted">No operator actions recorded yet.</p>}</section>
      </> : <p role="status">Select an office to inspect its operations.</p>}</section>
    </div>}
  </main>;
}
