import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const root = resolve(import.meta.dir, '..');
mkdirSync(join(root, '.data'), { recursive: true });
const dataDir = mkdtempSync(join(root, '.data/test-integration-'));
const secret = crypto.randomUUID() + crypto.randomUUID();
const running = new Set<ChildProcess>();
const sensitive = new Set([secret, ...Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value).filter((value): value is string => !!value && value.length > 5)]);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function redact(input: string) {
  let value = input;
  for (const item of sensitive) value = value.replaceAll(item, '[redacted]');
  return value.replace(/\b(?:sk|rk|rkcs)_(?:test|live)_[A-Za-z0-9]+/g, '[redacted-stripe-key]').replace(/\bwhsec_[A-Za-z0-9_]+/g, '[redacted-webhook-secret]').replace(/((?:TERSE_API_KEY|apiToken|workspaceKey)\s*[=:]\s*)\S+/gi, '$1[redacted]');
}
function child(command: string[], env: Record<string, string | undefined>, cwd = root, quiet = false) {
  const process = spawn(command[0], command.slice(1), { cwd, env: { ...Bun.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(process);
  let output = '';
  const write = (data: Buffer) => {
    const line = redact(data.toString());
    output = (output + line).slice(-16000);
    if (!quiet) globalThis.process.stdout.write(line);
  };
  process.stdout?.on('data', write); process.stderr?.on('data', write);
  const completion = new Promise<number>((resolve, reject) => { process.once('error', reject); process.once('exit', code => { running.delete(process); resolve(code ?? 1); }); });
  return { process, completion, output: () => output };
}
async function stop(process: ChildProcess) {
  if (!process.pid) return;
  try { globalThis.process.kill(-process.pid, 'SIGTERM'); } catch { try { process.kill('SIGTERM'); } catch {} }
  await Promise.race([new Promise(resolve => process.once('exit', resolve)), pause(1500)]);
  // Kill any grandchildren remaining in this task-owned process group.
  try { globalThis.process.kill(-process.pid, 'SIGKILL'); } catch {}
  running.delete(process);
}
async function assertFree(port: number) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Integration port ${port} is already in use. Stop its test runtime before running this command.`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}
async function waitReady(port: number, launched: ReturnType<typeof child>) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (launched.process.exitCode !== null) throw new Error(`Native runtime exited before ready: ${launched.output()}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); if (response.status < 500) return; } catch {}
    await pause(250);
  }
  throw new Error(`Native Terse runtime on ${port} did not become ready: ${launched.output()}`);
}
async function waitClosed(port: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await assertFree(port); return; } catch {}
    await pause(100);
  }
  throw new Error(`Owned native runtime port ${port} did not close.`);
}
function actorEnv(port: number, project: string, directory: string) {
  return { NODE_ENV: 'test', ODAS_TEST_MODE: '1', ODAS_NAMESPACE: 'test-integration', DEVICE_MODE: 'simulator', ACTOR_PORT: String(port), ACTOR_PROJECT_ID: project, TERSE_ACTOR_URL: `http://127.0.0.1:${port}/v1/projects/${project}/actors`, TERSE_ACTOR_SECRET: secret, TERSE_API_KEY: secret, INTERNAL_TOKEN: secret, DATA_DIR: directory, DURABLE_ACTORS_DATA_DIR: join(directory, 'actors') };
}
async function launchActor(port: number, project: string, directory: string) {
  await assertFree(port);
  const env = actorEnv(port, project, directory);
  const launched = child([Bun.main ? globalThis.process.execPath : 'bun', join(root, 'node_modules/terse-cli/dist/index.js'), 'actor', 'dev', '--port', String(port), '--project-id', project], env, join(root, 'packages/actors'), true);
  await waitReady(port, launched);
  return { ...launched, env };
}
async function run(command: string[], env: Record<string, string | undefined>) {
  const launched = child(command, env);
  const code = await launched.completion;
  if (code !== 0) throw new Error(`Integration phase failed (${code}).`);
}
async function shutdown() { await Promise.all([...running].map(stop)); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) globalThis.process.once(signal, () => { void shutdown().finally(() => globalThis.process.exit(1)); });

const phases: string[] = [];
try {
  console.log('Checking live capture cadence, concurrent inference, and demo control boundaries with isolated HTTP fixtures.');
  await run(['uv', 'run', '--project', 'workers/device', 'python', 'workers/device/verify_live.py'], { ...process.env, INTERNAL_TOKEN: secret });
  phases.push('four-FPS capture/inference, disabled defaults, cancellation and Robo command boundaries through HTTP fixtures');
  console.log('Checking serialized inventory and cleaning safety with a real isolated Terse runtime.');
  const nativeDir = join(dataDir, 'native');
  let native = await launchActor(7191, 'odas-ops-verification', nativeDir);
  await run([globalThis.process.execPath, 'packages/actors/verify.ts', 'before'], native.env);
  await stop(native.process); await waitClosed(7191);
  console.log('Native runtime stopped. Restarting the same actor project and persistent storage.');
  native = await launchActor(7191, 'odas-ops-verification', nativeDir);
  await run([globalThis.process.execPath, 'packages/actors/verify.ts', 'after'], native.env);
  phases.push('native actor inventory, safety, outbox and actual process restart persistence');
  await stop(native.process); await waitClosed(7191);

  console.log('Checking accounts, quotes, competing reservations, Checkout configuration, and resumable swaps.');
  const commerce = await launchActor(7111, 'odas-test-commerce', join(dataDir, 'commerce'));
  await run([globalThis.process.execPath, 'apps/api/src/commerce/integration.ts'], commerce.env);
  phases.push('commerce integration against native room actors; provider evidence is reported by that phase');
  await stop(commerce.process); await waitClosed(7111);
  const result = { ok: true, phases, dataDir, verifiedAt: new Date().toISOString(), note: 'Physical devices are not exercised. A successful sandbox charge/refund is a separate provider verification.' };
  writeFileSync(join(dataDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Integration checks passed. Evidence: ${join(dataDir, 'result.json')}`);
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  globalThis.process.exitCode = 1;
} finally { await shutdown(); }
