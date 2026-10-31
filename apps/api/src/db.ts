import { SQL, type TransactionSQL } from 'bun';
import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, join } from 'node:path';
import { openSqliteDatabase } from './sqlite';

/** The application uses asynchronous queries on both Postgres and isolated SQLite fixtures. */
export class Database {
  private context = new AsyncLocalStorage<TransactionSQL>();
  constructor(private sql: SQL, readonly dialect: 'postgres' | 'sqlite', readonly schema?: string) {}
  private get connection() { return this.context.getStore() ?? this.sql; }

  query(statement: string) {
    const text = this.dialect === 'postgres' ? postgresStatement(statement) : statement;
    const execute = (values: unknown[]) => this.connection.unsafe(text, values as never[]);
    return {
      get: async (...values: unknown[]): Promise<any> => normalizeRow((await execute(values))[0]) ?? null,
      all: async (...values: unknown[]): Promise<any[]> => Array.from(await execute(values), normalizeRow),
      run: async (...values: unknown[]) => { const result = await execute(values); return { changes: result.count }; },
    };
  }

  transaction<T>(work: () => T | Promise<T>) {
    return async (): Promise<T> => {
      const current = this.context.getStore();
      if (current) return current.savepoint(tx => this.context.run(tx, work)) as Promise<T>;
      return this.sql.begin(async tx => {
        // SQLite serialized these read-then-write transactions. Keep that guarantee across API instances.
        if (this.dialect === 'postgres') await tx.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [`odas:transaction:${this.schema}`]);
        return this.context.run(tx, work);
      }) as Promise<T>;
    };
  }

  async exec(statement: string) { await this.connection.unsafe(statement).simple(); }
  async close() { await this.sql.close({ timeout: 5 }); }
}

function normalizeRow(row: any) {
  if (!row) return row;
  for (const [column, value] of Object.entries(row)) if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error(`Database integer ${column} exceeds the supported range.`);
    row[column] = number;
  }
  return row;
}

/** Translate the small SQLite dialect used by the app; values remain bound parameters. */
function postgresStatement(statement: string) {
  let text = statement.trim().replace(/;$/, '');
  if (/^INSERT OR IGNORE\b/i.test(text)) text = text.replace(/^INSERT OR IGNORE/i, 'INSERT') + ' ON CONFLICT DO NOTHING';
  text = text.replace(/\browid\s+AS\s+sequence\s*,\s*\*/gi, '*');
  text = text.replace(/\browid\s+AS\s+sequence\b/gi, 'sequence').replace(/\browid\b/gi, 'sequence');
  text = text.replace(/\bemail\s*=\s*\?/gi, 'lower(email)=lower(?)');
  text = text.replace(/\bIS\s+\?/gi, 'IS NOT DISTINCT FROM ?');
  text = text.replace(/json_extract\((\w+),'\$\.([\w]+)'\)/gi, "($1::jsonb ->> '$2')");
  // JSON updates are used by the existing synthetic booking fixtures.
  text = text.replace(/json_set\((\w+),((?:'[^']*'|[^)])*)\)/gi, (_match, column: string, args: string) => {
    const parts = args.match(/'(?:''|[^'])*'|[^,]+/g)!.map(v => v.trim());
    let value = `${column}::jsonb`;
    for (let i = 0; i < parts.length; i += 2) {
      const path = parts[i].slice(3, -1).replaceAll('.', ',');
      const json = parts[i + 1].startsWith("'") ? `to_jsonb(${parts[i + 1]}::text)` : `to_jsonb(${parts[i + 1]}::int)`;
      value = `jsonb_set(${value},'{${path}}',${json})`;
    }
    return `(${value})::text`;
  });
  let parameter = 0;
  // Only replace placeholders outside SQL string literals.
  return text.replace(/'(?:''|[^'])*'|\?/g, token => token === '?' ? `$${++parameter}` : token);
}

export async function openDatabase(dataDir: string, options: { url?: string; schema?: string } = {}) {
  const fixture = basename(dataDir).startsWith('test-') || process.env.ODAS_TEST_MODE === '1';
  const url = options.url ?? (fixture ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL);
  if (!url) {
    if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production.');
    const legacy = openSqliteDatabase(dataDir); legacy.close();
    const sql = new SQL({ adapter: 'sqlite', filename: join(dataDir, 'odas.sqlite') });
    await sql.unsafe('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;').simple();
    return new Database(sql, 'sqlite');
  }
  if (!/^postgres(?:ql)?:\/\//.test(url)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  const schema = options.schema ?? (fixture ? basename(dataDir).replaceAll('-', '_') : process.env.DATABASE_SCHEMA || 'odas');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema) || ['public', 'auth', 'storage', 'extensions'].includes(schema)) throw new Error('Use a dedicated private DATABASE_SCHEMA.');
  const sql = new SQL(url, {
    max: 5, idleTimeout: 30, connectionTimeout: 15, bigint: true,
    connection: { search_path: `"${schema}",pg_catalog`, application_name: 'odas', statement_timeout: '30000' },
    ...(process.env.DATABASE_CA_FILE ? { tls: { ca: await Bun.file(process.env.DATABASE_CA_FILE).text(), rejectUnauthorized: true } } : {}),
  });
  const db = new Database(sql, 'postgres', schema);
  try {
    await db.transaction(async () => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext(?))').get(`odas:migrations:${schema}`);
      await db.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await db.exec(await Bun.file(new URL('./schema.sql', import.meta.url)).text());
    })();
    return db;
  } catch (error) { await db.close(); throw error; }
}
