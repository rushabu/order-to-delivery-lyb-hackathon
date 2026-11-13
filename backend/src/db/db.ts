// SQLite access through better-sqlite3 (synchronous, one file, one writer).
// Migrations are plain .sql files in /migrations, applied in name order once each.
import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../database/migrations');

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    })();
  }
}

/** Every data table, children before parents, so rows can be deleted in this order. */
export const DATA_TABLES = [
  'documents',
  'checkins',
  'stops',
  'driver_checks',
  'audit_events',
  'notifications',
  'invoices',
  'shipment_orders',
  'decisions',
  'option_sets',
  'alerts',
  'eta_snapshots',
  'disruptions',
  'shipment_events',
  'shipment_delay_causes',
  'shipments',
  'standby_vehicles',
  'orders',
  'route_alternatives',
  'route_segments',
  'routes',
  'users',
  'customers',
  'transporters',
  'id_counters',
];

export function clearAll(db: Db): void {
  db.pragma('foreign_keys = OFF');
  try {
    for (const t of DATA_TABLES) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'audit_events'`).run();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** Next readable id, e.g. nextId(db, 'ALT', 4) -> 'ALT-0001'. Must run inside the caller's transaction. */
export function nextSeq(db: Db, name: string): number {
  const row = db.prepare('SELECT value FROM id_counters WHERE name = ?').get(name) as { value: number } | undefined;
  const value = (row?.value ?? 0) + 1;
  db.prepare('INSERT INTO id_counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(
    name,
    value,
  );
  return value;
}

export function nextId(db: Db, prefix: string, width: number): string {
  return `${prefix}-${String(nextSeq(db, prefix)).padStart(width, '0')}`;
}
