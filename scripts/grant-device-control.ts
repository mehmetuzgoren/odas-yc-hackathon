import { parseArgs } from 'node:util';
import { loadConfig } from '../apps/api/src/config';
import { openDatabase } from '../apps/api/src/db';

const { values } = parseArgs({ args: process.argv.slice(2), options: { email: { type: 'string' }, rooms: { type: 'string' } }, strict: true });
if (!values.email || !values.rooms) throw new Error('Pass --email host@example.com --rooms polk-310-office-01.');
const config = loadConfig();
const db = openDatabase(config.dataDir);
try {
  const user = db.query("SELECT id FROM users WHERE email=? AND role='operator'").get(values.email) as { id: string } | null;
  if (!user) throw new Error('An existing host account is required.');
  const rooms = values.rooms.split(',').map(value => value.trim()).filter(Boolean);
  for (const room of rooms) if (!db.query('SELECT 1 FROM operator_scopes s JOIN offices o ON o.group_id=s.group_id WHERE s.user_id=? AND o.id=?').get(user.id, room)) throw new Error(`Room ${room} is outside this host's workspace scope.`);
  db.transaction(() => { for (const room of rooms) {
    db.query('INSERT OR IGNORE INTO operator_device_grants(user_id,room_id) VALUES(?,?)').run(user.id, room);
    db.query('INSERT INTO audit_log(id,actor,action,entity_id,data,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), 'operator-provisioning', 'device.control_granted', room, JSON.stringify({ userId: user.id }), Date.now());
  } })();
  console.log(`Enabled device controls for ${values.email} in ${rooms.join(', ')}.`);
} finally { db.close(); }
