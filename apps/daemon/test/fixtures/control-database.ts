import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONTROL_TABLES } from '../../src/daemon/persistence.js';

type RowTable = Exclude<typeof CONTROL_TABLES[number], 'projections'>;
const TABLES = CONTROL_TABLES.filter((table): table is RowTable => table !== 'projections');
type Rows = { [Table in RowTable]: Record<string, unknown>[] };
export type PersistedControlState = { version: 1; namespace: string; agentDir: string; clock: number } & Rows;

export function controlDatabasePath(directory: string): string { return join(directory, 'control.sqlite'); }

function withDatabase<T>(path: string, use: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return use(db); } finally { db.close(); }
}

/** The persisted control state in the shape the store assembles on reopen, with projections inside their sessions. */
export function readControlDatabase(directory: string, path = controlDatabasePath(directory)): PersistedControlState {
  return withDatabase(path, db => {
    const meta = new Map((db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
    const rows = Object.fromEntries(TABLES.map(table => [table,
      (db.prepare(`SELECT data FROM ${table} ORDER BY ord`).all() as { data: string }[]).map(row => JSON.parse(row.data) as Record<string, unknown>)])) as Rows;
    const projections = new Map<string, unknown[]>();
    for (const row of db.prepare('SELECT id, data FROM projections ORDER BY ord').all() as { id: string; data: string }[]) {
      const [session] = JSON.parse(row.id) as [string, string];
      projections.set(session, [...projections.get(session) ?? [], JSON.parse(row.data)]);
    }
    rows.sessions = rows.sessions.map(session => ({ ...session, projections: projections.get(session.id as string) ?? [] }));
    return { version: 1, namespace: meta.get('namespace')!, agentDir: meta.get('agentDir')!, clock: Number(meta.get('clock')), ...rows };
  });
}

/** Replaces every persisted row and the state metadata, as an edited or damaged store would hold them. */
export function writeControlDatabase(directory: string, state: Partial<PersistedControlState>): void {
  withDatabase(controlDatabasePath(directory), db => {
    db.exec('BEGIN IMMEDIATE');
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const key of ['namespace', 'agentDir', 'clock'] as const) if (state[key] !== undefined) meta.run(key, String(state[key]));
    let ord = 0;
    for (const table of [...TABLES, 'projections'] as const) {
      db.exec(`DELETE FROM ${table}`);
      // A repeated ID keeps its first row, as the store's repair would.
      const insert = db.prepare(`INSERT OR IGNORE INTO ${table} (id, ord, data) VALUES (?, ?, ?)`);
      if (table === 'projections') {
        for (const session of state.sessions ?? []) for (const record of (session.projections ?? []) as { key: string }[]) insert.run(JSON.stringify([session.id, record.key]), ++ord, JSON.stringify(record));
      } else for (const row of state[table] ?? []) {
        const { projections: _projections, ...data } = row;
        insert.run(String(row.id), ++ord, JSON.stringify(table === 'sessions' ? data : row));
      }
    }
    db.exec('COMMIT');
  });
}

/** Runs a raw statement against the store database, for tests of foreign or damaged files. */
export function execControlDatabase(directory: string, sql: string): void {
  withDatabase(controlDatabasePath(directory), db => db.exec(sql));
}
