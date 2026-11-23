import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db';

const dir = path.dirname(fileURLToPath(import.meta.url));

/** Migration files are `NNN_description.sql`, applied in name order. */
export function listMigrations(): { id: string; file: string }[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ id: f.replace(/\.sql$/, ''), file: path.join(dir, f) }));
}

/** Applies pending migrations, each atomically. Returns the ids that were applied. */
export function migrate(db: Db): string[] {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const done = new Set(db.all<{ id: string }>('SELECT id FROM schema_migrations').map((r) => r.id));
  const applied: string[] = [];
  for (const m of listMigrations()) {
    if (done.has(m.id)) continue;
    const sql = fs.readFileSync(m.file, 'utf8');
    db.tx(() => {
      db.raw.exec(sql);
      db.run('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
    });
    applied.push(m.id);
  }
  return applied;
}
