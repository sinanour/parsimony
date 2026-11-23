import { z } from 'zod';
import type { Router } from '../http';
import type { Db } from '../db';
import type { Config } from '../config';
import type { AuthService } from '../auth/service';

export interface Deps {
  db: Db;
  config: Config;
  auth: AuthService;
  version: string;
}

export type RouteModule = (r: Router, deps: Deps) => void;

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'is not a valid date');

export const idParam = z.coerce.number().int().positive();

export const money = z.number().finite();

export const trimmedOrNull = z
  .string()
  .nullable()
  .optional()
  .transform((s) => (s === undefined ? undefined : s === null || s.trim() === '' ? null : s.trim()));

export const scopeSchema = z.enum(['personal', 'corporate', 'all']).default('all');

/** Returns the SQL fragment restricting to the scope (expects an `a` alias for account). */
export function scopeClause(scope: 'personal' | 'corporate' | 'all'): string {
  if (scope === 'personal') return 'a.is_corporate = 0';
  if (scope === 'corporate') return 'a.is_corporate = 1';
  return '1 = 1';
}

export function queryObject(q: URLSearchParams): Record<string, string> {
  const o: Record<string, string> = {};
  q.forEach((v, k) => {
    if (v !== '') o[k] = v;
  });
  return o;
}

export const pagingSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

export function localToday(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** SQL expression for the exempt dollar amount of an expense row aliased `e`. */
export const EXEMPT_AMOUNT_SQL =
  'CASE WHEN COALESCE(e.exemption, 0) <= 1 THEN COALESCE(e.exemption, 0) * e.amount ELSE e.exemption END';
