import { Database as SQLite } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../apps/api/src/config';
import { openDatabase } from '../apps/api/src/db';

/** Run with the API stopped so no writes can arrive after this consistent snapshot. */
export async function migrateSqlite(source: string) {
  const config = loadConfig();
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the destination Supabase database.');
  const sourcePath = resolve(source);
  const snapshotPath = resolve('.data/private', `odas-before-supabase-${Date.now()}.sqlite`);
  mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  const original = new SQLite(sourcePath, { readonly: true });
  try { await Bun.write(snapshotPath, original.serialize()); } finally { original.close(); }
  const sqlite = new SQLite(snapshotPath, { readonly: true });
  const db = await openDatabase(config.dataDir);
  if (db.dialect !== 'postgres') throw new Error('Migration requires a PostgreSQL destination.');
  const counts: Record<string, number> = {};
  const fingerprint = new Bun.CryptoHasher('sha256').update(await Bun.file(snapshotPath).arrayBuffer()).digest('hex');
  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
  try {
    // Read in dependency order from the destination schema, whose foreign keys match SQLite.
    const tables = (await db.query('SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_type=\'BASE TABLE\' ORDER BY table_name').all(db.schema)) as { table_name: string }[];
    const sourceTables = sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of sourceTables) if (!tables.some(t => t.table_name === name)) throw new Error(`Destination is missing table ${name}.`);
    await db.transaction(async () => {
      for (const { table_name: table } of tables) {
        if (table === 'schema_migrations') continue;
        const existing = await db.query(`SELECT count(*) AS count FROM ${quote(table)}`).get();
        if (existing.count !== 0) throw new Error(`Destination ${table} contains data; migration refused to overwrite it.`);
      }
      const order = ['users', 'workspace_groups', 'offices', 'sessions', 'operator_scopes', 'operator_device_grants', 'quotes', 'reservations', 'conversations'];
      const names = sourceTables.map(t => t.name).filter(name => name !== 'schema_migrations').sort((a, b) => (order.indexOf(a) < 0 ? 100 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 100 : order.indexOf(b)));
      for (const table of names) {
        const rows = sqlite.query(`SELECT ${['chat_messages', 'notifications'].includes(table) ? 'rowid AS sequence,' : ''}* FROM ${quote(table)} ORDER BY rowid`).all() as Record<string, unknown>[];
        counts[table] = rows.length;
        if (rows.length) {
          const columns = Object.keys(rows[0]);
          for (let offset = 0; offset < rows.length; offset += 200) {
            const batch = rows.slice(offset, offset + 200);
            const placeholders = batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
            await db.query(`INSERT INTO ${quote(table)}(${columns.map(quote).join(',')}) VALUES${placeholders}`).run(...batch.flatMap(row => columns.map(column => row[column])));
          }
        }
        const target = await db.query(`SELECT count(*) AS count FROM ${quote(table)}`).get();
        if (target.count !== rows.length) throw new Error(`Row count mismatch in ${table}.`);
        // Compare every field so missing values or type coercion cannot silently lose data.
        if (rows.length) {
          const columns = Object.keys(rows[0]);
          const key = ['chat_messages', 'notifications'].includes(table) ? 'sequence' : table === 'room_conversation' ? 'id' : null;
          const imported = await db.query(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}${key ? ` ORDER BY ${quote(key)}` : ''}`).all();
          const canonical = (row: Record<string, unknown>) => JSON.stringify(columns.map(column => row[column]));
          const expected = rows.map(canonical).sort(); const actual = imported.map(canonical).sort();
          if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`Content mismatch in ${table}.`);
        }
        console.log(`Verified ${table}: ${rows.length} rows`);
      }
      for (const [table, column] of [['chat_messages', 'sequence'], ['notifications', 'sequence'], ['room_conversation', 'id']]) {
        await db.query(`SELECT setval(pg_get_serial_sequence(?,?),GREATEST(COALESCE((SELECT max(${quote(column)}) FROM ${quote(table)}),0),1),EXISTS(SELECT 1 FROM ${quote(table)}))`).get(`${db.schema}.${table}`, column);
      }
      await db.query('INSERT INTO settings(key,value) VALUES(?,?)').run('migration:sqlite', JSON.stringify({ fingerprint, counts, migratedAt: new Date().toISOString() }));
    })();
    console.log(JSON.stringify({ schema: db.schema, counts, snapshotPath, fingerprint, verified: 'all rows and fields' }));
    return { counts, snapshotPath };
  } finally { sqlite.close(); await db.close(); }
}

if (import.meta.main) {
  const source = process.argv[2];
  if (!source) throw new Error('Usage: bun run db:migrate-sqlite -- /path/to/odas.sqlite');
  await migrateSqlite(source);
}
