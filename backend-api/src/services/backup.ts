import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db';

/** Writes a consistent snapshot with VACUUM INTO and keeps the newest `keep` backups. */
export function backupDatabase(db: Db, dir: string, keep: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const file = path.join(dir, `parsimony-${stamp}.sqlite`);
  db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

  const backups = fs
    .readdirSync(dir)
    .filter((f) => /^parsimony-\d{8}-\d{6}\.sqlite$/.test(f))
    .sort()
    .reverse();
  for (const old of backups.slice(Math.max(keep, 1))) fs.rmSync(path.join(dir, old));
  return file;
}
