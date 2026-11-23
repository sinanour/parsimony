import fs from 'node:fs';
import nodePath from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Param = string | number | bigint | boolean | null | undefined;
export type Row = Record<string, unknown>;

/** Converts JS values into values node:sqlite can bind (booleans → 0/1, undefined → NULL). */
function bindable(v: Param): SQLInputValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') fs.mkdirSync(nodePath.dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    // Same behaviour as the legacy Python scripts: FK enforcement off. The schema declares
    // ON DELETE CASCADE, so enabling it would let an account delete wipe its transactions.
    // Referential checks are performed explicitly in the route handlers instead.
    this.raw.exec('PRAGMA foreign_keys = OFF');
    this.raw.exec('PRAGMA busy_timeout = 5000');
  }

  all<T = Row>(sql: string, params: Param[] = []): T[] {
    return this.raw.prepare(sql).all(...params.map(bindable)) as T[];
  }

  get<T = Row>(sql: string, params: Param[] = []): T | undefined {
    return this.raw.prepare(sql).get(...params.map(bindable)) as T | undefined;
  }

  run(sql: string, params: Param[] = []): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params.map(bindable));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  scalar<T = number>(sql: string, params: Param[] = []): T {
    const row = this.raw.prepare(sql).get(...params.map(bindable)) as Row | undefined;
    return (row ? Object.values(row)[0] : null) as T;
  }

  /** Runs fn atomically. Nested calls use savepoints. Throwing rolls back. */
  tx<T>(fn: () => T): T {
    const sp = `sp_${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (e) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export const bool = (v: unknown): boolean => Number(v) !== 0 && v !== null && v !== undefined;
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
