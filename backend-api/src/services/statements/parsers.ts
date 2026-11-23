import type { StatementColumns, StatementFormatSettings, StatementParserKind } from '../../../../shared/types';
import { capwords, isoDate, pyFloat, strptime } from './python-compat';

export interface ParsedRecord {
  type: 'expense' | 'deposit';
  transactionDate: string;
  description: string;
  amount: number;
  accountIdx: number;
  /** Deposits: the part that counts as income. */
  incomeAmount: number | null;
}

export interface RowParseContext {
  fileName: string;
  /** The account chosen in the UI; used for every row. */
  accountIdx?: number;
  /** Card statements without a chosen account: the account whose file pattern matched. */
  defaultAccountIdx?: number;
  /** Looks up an account by one of its numbers (bank statements). */
  accountForNumber(accountNumber: string): number | undefined;
}

export interface RowParseResult {
  records: ParsedRecord[];
  warnings: string[];
}

/** `cast_currency_to_float`: drop thousands separators, spaces and dollar signs. */
const currency = (s: string | undefined) => (s === undefined ? null : pyFloat(s.replace(/[, $]/g, '')));

function parseDate(value: string | undefined, formats: string[]): string | null {
  if (value === undefined) return null;
  for (const f of formats) {
    const d = strptime(value.trim(), f);
    if (d) return isoDate(d);
  }
  return null;
}

/** Deposit income, as the original parser decided it: payroll and interest are income, everything else is left for review. */
function depositIncome(description: string, amount: number): { description: string; incomeAmount: number } {
  if (description.includes('Payroll Deposit')) return { description, incomeAmount: amount };
  if (description.includes('Interest Paid')) return { description: 'Interest', incomeAmount: amount };
  return { description, incomeAmount: 0 };
}

const COLUMN_LABELS: Record<keyof StatementColumns, string> = {
  date: 'date',
  description: 'description',
  debit: 'debit',
  credit: 'credit',
  account: 'account number',
  cheque: 'cheque number',
};

/** Columns found by header title when the format has no fixed column count. */
function columnsFromHeader(header: string[], settings: StatementFormatSettings): { columns: StatementColumns; missing: string[] } {
  const columns = { ...settings.columns };
  const titles = header.map((h) => h.trim().toLowerCase());
  const missing: string[] = [];
  for (const [key, title] of Object.entries(settings.headerNames ?? {}) as [keyof StatementColumns, string | undefined][]) {
    if (!title?.trim()) continue;
    const at = titles.indexOf(title.trim().toLowerCase());
    if (at >= 0) columns[key] = at;
    else missing.push(`"${title}" (${COLUMN_LABELS[key]})`);
  }
  return { columns, missing };
}

/**
 * Turns statement rows into expenses and deposits.
 *
 * - `card`: every row is an expense on one account. Amounts in the credit column (when it's a
 *   separate column) become negative expenses; credits that mention "payment" are card payments and
 *   are skipped.
 * - `bank`: the account comes from each row's account number (unless one was chosen). Positive
 *   amounts are deposits and negative ones expenses; with separate debit and credit columns, debits
 *   are withdrawals and credits deposits.
 */
export function parseRows(rows: string[][], parser: StatementParserKind, settings: StatementFormatSettings, ctx: RowParseContext): RowParseResult {
  const warnings: string[] = [];
  const records: ParsedRecord[] = [];

  if (rows.length < settings.headerRows + (settings.columnCount === null ? 1 : 0)) {
    return { records, warnings: [`${ctx.fileName} is empty or has fewer rows than the format's header.`] };
  }
  let body = rows.slice(settings.headerRows);
  let columns = settings.columns;
  let columnCount = settings.columnCount;
  if (columnCount === null) {
    const header = body[0];
    body = body.slice(1);
    const found = columnsFromHeader(header, settings);
    if (found.missing.length) {
      return { records, warnings: [`${ctx.fileName}: the header row has no ${found.missing.join(', ')} column.`] };
    }
    columns = found.columns;
    columnCount = header.length;
  }

  const cell = (row: string[], i: number | null) => (i === null ? undefined : row[i]);

  if (parser === 'card') {
    const accountIdx = ctx.accountIdx ?? ctx.defaultAccountIdx;
    if (accountIdx === undefined) {
      return { records, warnings: [`No account for ${ctx.fileName}: choose the account when importing, or set a statement file pattern on the account.`] };
    }
    for (const row of body) {
      if (row.length !== columnCount) continue;
      const date = parseDate(cell(row, columns.date), settings.dateFormats);
      const description = capwords(cell(row, columns.description) ?? '');
      let amount = currency(cell(row, columns.debit));
      if (amount === null && columns.credit !== columns.debit) {
        const credit = currency(cell(row, columns.credit));
        if (credit !== null) amount = -credit;
      }
      if (date === null || amount === null) continue;
      // Paying the card off isn't spending.
      if (amount < 0 && description.toLowerCase().includes('payment')) continue;
      records.push({ type: 'expense', transactionDate: date, description, amount, accountIdx, incomeAmount: null });
    }
    return { records, warnings };
  }

  const unknownNumbers = new Set<string>();
  for (const row of body) {
    if (row.length !== columnCount) continue;
    const date = parseDate(cell(row, columns.date), settings.dateFormats);
    if (date === null) continue;
    let accountIdx = ctx.accountIdx;
    if (accountIdx === undefined) {
      const number = cell(row, columns.account) ?? '';
      accountIdx = ctx.accountForNumber(number.replaceAll(' ', ''));
      if (accountIdx === undefined) {
        if (number.trim()) unknownNumbers.add(number.trim());
        continue;
      }
    }
    let description = capwords(cell(row, columns.description) ?? '');
    let amount = currency(cell(row, columns.debit));
    if (amount === null) {
      if (columns.credit !== null) amount = currency(cell(row, columns.credit));
    } else if (columns.credit !== null) {
      amount = -amount;
    }
    if (amount === null) continue;
    if (amount > 0) {
      const income = depositIncome(description, amount);
      records.push({ type: 'deposit', transactionDate: date, description: income.description, amount, accountIdx, incomeAmount: income.incomeAmount });
    } else {
      const cheque = cell(row, columns.cheque);
      if (description === 'Cheque' && cheque) description += ` #${cheque}`;
      records.push({ type: 'expense', transactionDate: date, description, amount: -amount, accountIdx, incomeAmount: null });
    }
  }
  if (unknownNumbers.size) {
    const masked = [...unknownNumbers].map((n) => (n.length > 4 ? `…${n.slice(-4)}` : n));
    warnings.push(
      `${ctx.fileName}: rows for account number${masked.length > 1 ? 's' : ''} ${masked.join(', ')} were skipped because no account has ` +
        `${masked.length > 1 ? 'those numbers' : 'that number'}. Add the number to an account, or choose the account when importing.`,
    );
  }
  return { records, warnings };
}
