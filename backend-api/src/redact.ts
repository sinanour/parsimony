// Read-only users never receive full card or bank numbers (SPEC A3). They appear in account numbers and
// payee account numbers, but also inside free text: account names ("Visa - CIBC (4505 …)"), statement
// descriptions ("… Account Number 4505…"), confirmations. The router applies `redactForRole` to every
// response sent to a READ_ONLY user, so new endpoints are covered without opting in.
import type { AuthUser } from '../../shared/types';

export const MASK = '••••';

/** Runs of at least this many digits are treated as account / card numbers. Bank numbers can be 7 digits. */
export const MIN_SECRET_DIGITS = 7;

/** Fields that hold nothing but an account number: always masked to the last four characters. */
const ACCOUNT_NUMBER_KEYS = new Set(['accountNum', 'accountNumber', 'accountNumbers', 'accountNo']);

/**
 * An ISO date or timestamp (left as is), or a run of digits in which single spaces or dashes may separate
 * the groups ("4505 1234 5678 9012", "0812 3456-789", "123-456789-012"). Dates come first in the
 * alternation, so "2026-11-25 10:20" is never read as the number 20261125 10.
 */
const TOKEN =
  /(?<!\d)((?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?)(?!\d)|\d(?:[ -]?\d)*/g;

/** Whether a string could contain something `redactDigits` would change (cheap pre-check). */
const HAS_LONG_RUN = new RegExp(`\\d(?:[ -]?\\d){${MIN_SECRET_DIGITS - 1}}`);

/**
 * Replaces every run of ≥ MIN_SECRET_DIGITS digits (spaces / dashes between groups allowed) with
 * `••••` + its last four digits. Round numbers (one digit followed by zeros, e.g. the rule engine's
 * 2000000000 amount bounds) and dates are kept. Idempotent.
 */
export function redactDigits(s: string): string {
  if (!HAS_LONG_RUN.test(s)) return s;
  return s.replace(TOKEN, (m, date: string | undefined) => {
    if (date) return m;
    const digits = m.replace(/[ -]/g, '');
    if (digits.length < MIN_SECRET_DIGITS || /^\d0+$/.test(digits)) return m;
    return MASK + digits.slice(-4);
  });
}

/** An account number field: only its last four characters are shown. */
export function maskAccountNumber(n: string): string {
  return n.length > 4 ? `${MASK}${n.slice(-4)}` : n;
}

export const isReadOnly = (user: AuthUser | null | undefined): boolean => user?.role === 'READ_ONLY';

/** Read-only users only ever see the last four characters of account numbers. */
export function maskForRole(n: string, user: AuthUser | null): string {
  return isReadOnly(user) ? maskAccountNumber(n) : n;
}

/**
 * Deep copy of a response value with every string redacted (account-number fields fully masked, digit
 * runs in all other strings). Numbers, booleans and object keys are untouched.
 */
export function redactValue(v: unknown, numberField = false): unknown {
  if (typeof v === 'string') return numberField ? maskAccountNumber(redactDigits(v)) : redactDigits(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, numberField));
  if (v !== null && typeof v === 'object') {
    if (v instanceof Date) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactValue(x, ACCOUNT_NUMBER_KEYS.has(k));
    return out;
  }
  return v;
}

/** `redactValue` for READ_ONLY users; the value itself for everyone else. */
export function redactForRole<T>(v: T, user: AuthUser | null | undefined): T {
  return isReadOnly(user) ? (redactValue(v) as T) : v;
}

/**
 * SQL for a text column as `user` may see it: wrapped in redact_digits() (registered by Db) for
 * READ_ONLY users, so searches, filters and sorts only ever act on the redacted text and can't be used to
 * confirm masked digits.
 */
export function visibleSql(column: string, user: AuthUser | null | undefined): string {
  return isReadOnly(user) ? `redact_digits(${column})` : column;
}
