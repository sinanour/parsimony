import path from 'node:path';
import type { Db } from '../db';
import { badRequest, payloadTooLarge } from '../http';
import { TEXT_LIMITS, type ImportCommitRequest, type ImportParseResponse, type ImportRecord } from '../../../shared/types';
import { parseStatementFile } from './statements';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The account whose statement file pattern occurs in the file name (case-insensitive).
 * The longest pattern wins, so "visa (business)" beats "visa".
 */
export function accountForFileName(db: Db, fileName: string): number | undefined {
  const name = fileName.toLowerCase();
  const match = db
    .all<{ account_idx: number; p: string }>(
      `SELECT account_idx, lower(trim(statement_file_pattern)) AS p FROM account
       WHERE COALESCE(trim(statement_file_pattern), '') <> '' ORDER BY length(p) DESC, is_active DESC`,
    )
    .find((a) => name.includes(a.p));
  return match?.account_idx;
}

/** Default for IMPORT_MAX_RECORDS: comfortably more than years of one account's transactions in one file. */
export const DEFAULT_IMPORT_MAX_RECORDS = 10_000;

export async function parseStatement(
  db: Db,
  fileName: string,
  content: Buffer,
  accountIdx?: number,
  maxRecords = DEFAULT_IMPORT_MAX_RECORDS,
): Promise<ImportParseResponse> {
  const base = path.basename(fileName);
  if (!/\.(csv|pdf)$/i.test(base)) throw badRequest('Only .csv and .pdf statements are supported');
  if (content.length === 0) throw badRequest('The uploaded file is empty');

  const parsed = await parseStatementFile(db, base, content, {
    accountIdx,
    defaultAccountIdx: accountIdx === undefined ? accountForFileName(db, base) : undefined,
    maxRecords,
  });
  if (parsed.records.length > maxRecords) {
    throw payloadTooLarge(
      `${base} has more than ${maxRecords} transactions, more than one import can take. Split the file and import the parts separately.`,
      'TOO_MANY_RECORDS',
    );
  }
  const accountNames = new Map(
    db.all<{ account_idx: number; name: string }>('SELECT account_idx, name FROM account').map((a) => [a.account_idx, a.name]),
  );
  // Statement text is the bank's, not the user's: an over-long description is cut to the stored limit
  // (with a warning) rather than failing the whole import. Commit rejects anything longer.
  const maxDescription = TEXT_LIMITS.description;
  let truncated = 0;
  const records: ImportRecord[] = parsed.records.map((r, i) => ({
    key: `${i}`,
    type: r.type,
    transactionDate: r.transactionDate,
    description: r.description.length > maxDescription ? (truncated++, r.description.slice(0, maxDescription)) : r.description,
    amount: round2(r.amount),
    accountIdx: r.accountIdx,
    accountName: accountNames.get(r.accountIdx) ?? `Unknown account #${r.accountIdx}`,
    category: null,
    exemption: null,
    incomeAmount: r.type === 'deposit' ? round2(r.incomeAmount ?? 0) : null,
    isDuplicate: false,
  }));

  flagDuplicates(db, records);
  const warnings = [
    ...parsed.warnings,
    ...(truncated > 0 ? [`${truncated} description(s) were longer than ${maxDescription} characters and were shortened.`] : []),
    ...overlapWarnings(db, records),
  ];
  return { fileName: base, formatName: parsed.formatName, records, warnings };
}

/**
 * Marks records that already exist. Expenses match on account, date, amount and description;
 * deposits on account, date and amount (deposit descriptions are often edited after import).
 * Multiplicity counts: with one matching row in the DB, only the first of two identical records is flagged.
 */
export function flagDuplicates(db: Db, records: ImportRecord[]): void {
  const groups = new Map<string, ImportRecord[]>();
  for (const r of records) {
    const k =
      r.type === 'expense'
        ? `e|${r.accountIdx}|${r.transactionDate}|${r.amount.toFixed(2)}|${r.description.toLowerCase()}`
        : `d|${r.accountIdx}|${r.transactionDate}|${r.amount.toFixed(2)}`;
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  // One query per record type for all groups at once (the statement's keys arrive as a JSON array), rather
  // than one query per group.
  const list = [...groups.values()];
  const keysOf = (type: 'expense' | 'deposit') =>
    JSON.stringify(
      list.flatMap((g, i) => (g[0].type === type ? [[i, g[0].accountIdx, g[0].transactionDate, g[0].amount, g[0].description]] : [])),
    );
  const KEYS = `k AS (SELECT json_extract(value, '$[0]') AS i, json_extract(value, '$[1]') AS account_idx,
      json_extract(value, '$[2]') AS transaction_date, json_extract(value, '$[3]') AS amount,
      json_extract(value, '$[4]') AS description FROM json_each(?))`;
  const counts = [
    ...db.all<{ i: number; n: number }>(
      `WITH ${KEYS} SELECT k.i, COUNT(x.expense_idx) AS n FROM k LEFT JOIN expense x
         ON x.account_idx = k.account_idx AND x.transaction_date = k.transaction_date
        AND ROUND(x.amount, 2) = k.amount AND lower(x.description) = lower(k.description)
       GROUP BY k.i`,
      [keysOf('expense')],
    ),
    ...db.all<{ i: number; n: number }>(
      `WITH ${KEYS} SELECT k.i, COUNT(x.deposit_idx) AS n FROM k LEFT JOIN deposit x
         ON x.account_idx = k.account_idx AND x.transaction_date = k.transaction_date AND ROUND(x.amount, 2) = k.amount
       GROUP BY k.i`,
      [keysOf('deposit')],
    ),
  ];
  for (const { i, n } of counts) list[i].slice(0, n).forEach((x) => (x.isDuplicate = true));
}

/** The legacy script's signal: rows already present in the statement's date range for the account. */
function overlapWarnings(db: Db, records: ImportRecord[]): string[] {
  const ranges = new Map<string, { type: 'expense' | 'deposit'; accountIdx: number; accountName: string; min: string; max: string; fresh: number }>();
  for (const r of records) {
    const k = `${r.type}|${r.accountIdx}`;
    const cur = ranges.get(k) ?? { type: r.type, accountIdx: r.accountIdx, accountName: r.accountName, min: r.transactionDate, max: r.transactionDate, fresh: 0 };
    if (r.transactionDate < cur.min) cur.min = r.transactionDate;
    if (r.transactionDate > cur.max) cur.max = r.transactionDate;
    if (!r.isDuplicate) cur.fresh++;
    ranges.set(k, cur);
  }
  const out: string[] = [];
  for (const g of ranges.values()) {
    const n = db.scalar<number>(
      `SELECT COUNT(*) FROM ${g.type} WHERE account_idx = ? AND transaction_date >= ? AND transaction_date <= ?`,
      [g.accountIdx, g.min, g.max],
    );
    if (n > 0 && g.fresh > 0) {
      out.push(
        `${g.accountName}: ${n} ${g.type === 'expense' ? 'expense' : 'deposit'}(s) already exist between ${g.min} and ${g.max}, ` +
          `but ${g.fresh} parsed record(s) did not match any of them. Review before importing.`,
      );
    }
  }
  return out;
}

export function commitRecords(db: Db, records: ImportCommitRequest['records']): { expensesInserted: number; depositsInserted: number } {
  let expensesInserted = 0;
  let depositsInserted = 0;
  db.tx(() => {
    const known = new Set(db.all<{ account_idx: number }>('SELECT account_idx FROM account').map((a) => a.account_idx));
    const insertExpense = db.raw.prepare(
      'INSERT INTO expense (transaction_date, category, exemption, description, amount, account_idx) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertDeposit = db.raw.prepare(
      'INSERT INTO deposit (transaction_date, description, amount, income_amount, account_idx) VALUES (?, ?, ?, ?, ?)',
    );
    for (const r of records) {
      if (!known.has(r.accountIdx)) throw badRequest(`Unknown account #${r.accountIdx}`);
      if (r.type === 'expense') {
        insertExpense.run(r.transactionDate, r.category || null, r.exemption, r.description, round2(r.amount), r.accountIdx);
        expensesInserted++;
      } else {
        insertDeposit.run(r.transactionDate, r.description, round2(r.amount), round2(r.incomeAmount ?? 0), r.accountIdx);
        depositsInserted++;
      }
    }
  });
  return { expensesInserted, depositsInserted };
}
