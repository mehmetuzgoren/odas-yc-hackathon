import { AgentRelay } from '@agent-relay/sdk';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { workerName, type WorkerRole } from './protocol';

export interface RelayIdentities { version: 1; baseUrl: string; namespace: string; workspaceKey: string; agents: Record<string, { id: string; name: string; token: string }> }
export const identityPath = () => join(resolve(process.env.DATA_DIR ?? '.data'), 'relay-identities.json');
export function readIdentities(): RelayIdentities {
  if (!existsSync(identityPath())) throw new Error('Relay identities are missing. Start Relaycast and run bun packages/concierge/src/provision.ts first.');
  return JSON.parse(readFileSync(identityPath(), 'utf8'));
}
export async function provisionRelay(): Promise<RelayIdentities> {
  const path = identityPath();
  const baseUrl = process.env.RELAY_BASE_URL ?? 'http://127.0.0.1:8787';
  const namespace = process.env.ODAS_NAMESPACE ?? 'development';
  mkdirSync(resolve(process.env.DATA_DIR ?? '.data'), { recursive: true });
  let state: RelayIdentities | undefined = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  if (state && (state.baseUrl !== baseUrl || state.namespace !== namespace)) throw new Error('Relay identity namespace/base URL differs from this DATA_DIR. Use a separate DATA_DIR for isolated environments.');
  const relay = state
    ? new AgentRelay({ workspaceKey: state.workspaceKey, baseUrl })
    : process.env.RELAY_WORKSPACE_KEY
      ? new AgentRelay({ workspaceKey: process.env.RELAY_WORKSPACE_KEY, baseUrl })
      : await AgentRelay.createWorkspace({ name: `odas-${namespace}`, baseUrl });
  state ??= { version: 1, baseUrl, namespace, workspaceKey: relay.workspaceKey!, agents: {} };
  function save() {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  }
  save();
  for (const role of ['operations', 'concierge'] as WorkerRole[]) {
    const name = workerName(role, namespace);
    const previous = state.agents[role];
    const agent = previous
      ? await relay.workspace.reconnect({ apiToken: previous.token })
      : await relay.workspace.register({ name, type: 'agent', metadata: { application: 'odas', role, namespace } });
    if (!agent.token) throw new Error(`Relay did not return a token for ${name}`);
    state.agents[role] = { id: agent.id, name: agent.name, token: agent.token };
    save();
  }
  await relay.events.disconnect();
  return state;
}
if (import.meta.main) {
  await provisionRelay();
  console.log('Relay workspace and operations/concierge identities are ready. Credentials stored privately in DATA_DIR.');
  process.exit(0);
}
