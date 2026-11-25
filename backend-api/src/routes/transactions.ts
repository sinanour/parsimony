import { z } from 'zod';
import { bool, numOrNull, strOrNull, type Db, type Param } from '../db';
import { badRequest, notFound } from '../http';
import { UNCATEGORIZED, type Deposit, type Expense } from '../../../shared/types';
import {
  EXEMPT_AMOUNT_SQL,
  idParam,
  isoDate,
  money,
  pagingSchema,
  queryObject,
  scopeClause,
  scopeSchema,
  searchText,
  requiredText,
  TEXT_LIMITS,
  trimmedOrNull,
  type RouteModule,
} from './common';

// ---------- shared ----------

const baseQuery = pagingSchema.extend({
  scope: scopeSchema,
  accountIdx: z.coerce.number().int().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: searchText.optional(),
});

function checkAccount(db: Db, accountIdx: number): void {
  if (!db.get('SELECT 1 FROM account WHERE account_idx = ?', [accountIdx])) throw badRequest(`Unknown account #${accountIdx}`);
}

/** Exemption ≤ 1 is a fraction of the amount; > 1 is a dollar amount. Negative values make no sense. */
const exemptionSchema = z.number().finite().min(0, 'cannot be negative').nullable();

const ids = z.array(z.number().int().positive()).min(1).max(5000);

function inList(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

// ---------- expenses ----------

const expenseQuery = baseQuery.extend({
  category: searchText.optional(),
  sort: z.enum(['transactionDate', 'amount', 'description', 'category', 'accountName']).default('transactionDate'),
});

const EXPENSE_SORT: Record<string, string> = {
  transactionDate: 'e.transaction_date',
  amount: 'e.amount',
  description: 'e.description COLLATE NOCASE',
  category: 'e.category COLLATE NOCASE',
  accountName: 'a.name',
};

const expenseInput = z.object({
  transactionDate: isoDate,
  category: trimmedOrNull(TEXT_LIMITS.category),
  exemption: exemptionSchema,
  description: requiredText(TEXT_LIMITS.description),
  amount: money,
  accountIdx: z.number().int().positive(),
  comment: trimmedOrNull(TEXT_LIMITS.comment),
});

const expensePatch = expenseInput.partial().strict();

const expenseBulk = z
  .object({
    ids,
    category: trimmedOrNull(TEXT_LIMITS.category),
    exemption: exemptionSchema.optional(),
    comment: trimmedOrNull(TEXT_LIMITS.comment),
  })
  .refine((b) => b.category !== undefined || b.exemption !== undefined || b.comment !== undefined, 'Nothing to update');

const EXPENSE_SELECT = `SELECT e.expense_idx, e.transaction_date, e.category, e.exemption, e.description, e.amount,
  e.account_idx, e.comment, a.name AS account_name, a.is_corporate, ${EXEMPT_AMOUNT_SQL} AS exempt_amount
  FROM expense e LEFT JOIN account a ON a.account_idx = e.account_idx`;

function toExpense(r: Record<string, unknown>): Expense {
  return {
    expenseIdx: Number(r.expense_idx),
    transactionDate: String(r.transaction_date),
    category: strOrNull(r.category) || null,
    exemption: numOrNull(r.exemption),
    exemptAmount: Math.round(Number(r.exempt_amount ?? 0) * 100) / 100,
    description: String(r.description),
    amount: Number(r.amount),
    accountIdx: Number(r.account_idx),
    accountName: String(r.account_name ?? ''),
    isCorporate: bool(r.is_corporate),
    comment: strOrNull(r.comment),
  };
}

function getExpense(db: Db, id: number): Expense {
  const row = db.get(`${EXPENSE_SELECT} WHERE e.expense_idx = ?`, [id]);
  if (!row) throw notFound('Expense');
  return toExpense(row);
}

const EXPENSE_COLUMNS: Record<string, string> = {
  transactionDate: 'transaction_date',
  category: 'category',
  exemption: 'exemption',
  description: 'description',
  amount: 'amount',
  accountIdx: 'account_idx',
  comment: 'comment',
};

// ---------- deposits ----------

const depositQuery = baseQuery.extend({
  reviewed: z.enum(['reviewed', 'unreviewed']).optional(),
  sort: z.enum(['transactionDate', 'amount', 'description', 'incomeAmount', 'accountName']).default('transactionDate'),
});

const DEPOSIT_SORT: Record<string, string> = {
  transactionDate: 'd.transaction_date',
  amount: 'd.amount',
  incomeAmount: 'd.income_amount',
  description: 'd.description COLLATE NOCASE',
  accountName: 'a.name',
};

const depositInput = z.object({
  transactionDate: isoDate,
  description: trimmedOrNull(TEXT_LIMITS.description),
  amount: money,
  incomeAmount: money,
  reviewed: z.boolean(),
  comment: trimmedOrNull(TEXT_LIMITS.comment),
  accountIdx: z.number().int().positive(),
});

const depositPatch = depositInput.partial().strict();

const depositBulk = z.object({ ids, action: z.enum(['income', 'transfer', 'unreviewed']) });

const DEPOSIT_SELECT = `SELECT d.deposit_idx, d.transaction_date, d.description, d.amount, d.income_amount, d.reviewed,
  d.comment, d.account_idx, a.name AS account_name, a.is_corporate
  FROM deposit d LEFT JOIN account a ON a.account_idx = d.account_idx`;

function toDeposit(r: Record<string, unknown>): Deposit {
  return {
    depositIdx: Number(r.deposit_idx),
    transactionDate: String(r.transaction_date),
    description: strOrNull(r.description),
    amount: Number(r.amount),
    incomeAmount: Number(r.income_amount),
    reviewed: bool(r.reviewed),
    comment: strOrNull(r.comment),
    accountIdx: Number(r.account_idx),
    accountName: String(r.account_name ?? ''),
    isCorporate: bool(r.is_corporate),
  };
}

function getDeposit(db: Db, id: number): Deposit {
  const row = db.get(`${DEPOSIT_SELECT} WHERE d.deposit_idx = ?`, [id]);
  if (!row) throw notFound('Deposit');
  return toDeposit(row);
}

const DEPOSIT_COLUMNS: Record<string, string> = {
  transactionDate: 'transaction_date',
  description: 'description',
  amount: 'amount',
  incomeAmount: 'income_amount',
  reviewed: 'reviewed',
  comment: 'comment',
  accountIdx: 'account_idx',
};

function patchRow(db: Db, table: string, idCol: string, id: number, columns: Record<string, string>, patch: Record<string, unknown>): void {
  const sets: string[] = [];
  const params: Param[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !(k in columns)) continue;
    sets.push(`${columns[k]} = ?`);
    params.push(v as Param);
  }
  if (sets.length === 0) throw badRequest('Nothing to update');
  db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${idCol} = ?`, [...params, id]);
}

// ---------- routes ----------

export const transactionRoutes: RouteModule = (r, { db }) => {
  r.get('/api/expenses', ({ query }) => {
    const q = expenseQuery.parse(queryObject(query));
    const where = [scopeClause(q.scope)];
    const params: Param[] = [];
    if (q.accountIdx) (where.push('e.account_idx = ?'), params.push(q.accountIdx));
    if (q.category === UNCATEGORIZED) where.push("COALESCE(e.category, '') = ''");
    else if (q.category) (where.push('e.category = ?'), params.push(q.category));
    if (q.from) (where.push('e.transaction_date >= ?'), params.push(q.from));
    if (q.to) (where.push('e.transaction_date <= ?'), params.push(q.to));
    if (q.q) {
      where.push('(e.description LIKE ? OR e.comment LIKE ?)');
      params.push(`%${q.q}%`, `%${q.q}%`);
    }
    const w = `WHERE ${where.join(' AND ')}`;
    const from = 'FROM expense e LEFT JOIN account a ON a.account_idx = e.account_idx';
    const totals = db.get<{ n: number; amount: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(e.amount), 0) AS amount ${from} ${w}`, params)!;
    const items = db
      .all(`${EXPENSE_SELECT} ${w} ORDER BY ${EXPENSE_SORT[q.sort]} ${q.dir}, e.expense_idx ${q.dir} LIMIT ? OFFSET ?`, [
        ...params,
        q.pageSize,
        (q.page - 1) * q.pageSize,
      ])
      .map(toExpense);
    return { items, total: totals.n, totalAmount: Math.round(totals.amount * 100) / 100 };
  });

  r.get('/api/expenses/:id', ({ params }) => getExpense(db, idParam.parse(params.id)));

  r.post('/api/expenses', ({ body }) => {
    const i = expenseInput.parse(body);
    checkAccount(db, i.accountIdx);
    const { lastInsertRowid } = db.run(
      'INSERT INTO expense (transaction_date, category, exemption, description, amount, account_idx, comment) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [i.transactionDate, i.category, i.exemption, i.description, i.amount, i.accountIdx, i.comment],
    );
    return getExpense(db, lastInsertRowid);
  });

  r.patch('/api/expenses/:id', ({ params, body }) => {
    const id = idParam.parse(params.id);
    const p = expensePatch.parse(body);
    getExpense(db, id);
    if (p.accountIdx) checkAccount(db, p.accountIdx);
    patchRow(db, 'expense', 'expense_idx', id, EXPENSE_COLUMNS, p);
    return getExpense(db, id);
  });

  r.post('/api/expenses/bulk', ({ body }) => {
    const b = expenseBulk.parse(body);
    const sets: string[] = [];
    const params: Param[] = [];
    if (b.category !== undefined) (sets.push('category = ?'), params.push(b.category));
    if (b.exemption !== undefined) (sets.push('exemption = ?'), params.push(b.exemption));
    if (b.comment !== undefined) (sets.push('comment = ?'), params.push(b.comment));
    const { changes } = db.tx(() =>
      db.run(`UPDATE expense SET ${sets.join(', ')} WHERE expense_idx IN (${inList(b.ids.length)})`, [...params, ...b.ids]),
    );
    return { updated: changes };
  });

  r.delete('/api/expenses/:id', ({ params }) => {
    const id = idParam.parse(params.id);
    getExpense(db, id);
    db.run('DELETE FROM expense WHERE expense_idx = ?', [id]);
  });

  r.get('/api/deposits', ({ query }) => {
    const q = depositQuery.parse(queryObject(query));
    const where = [scopeClause(q.scope)];
    const params: Param[] = [];
    if (q.accountIdx) (where.push('d.account_idx = ?'), params.push(q.accountIdx));
    if (q.reviewed) where.push(`d.reviewed = ${q.reviewed === 'reviewed' ? 1 : 0}`);
    if (q.from) (where.push('d.transaction_date >= ?'), params.push(q.from));
    if (q.to) (where.push('d.transaction_date <= ?'), params.push(q.to));
    if (q.q) {
      where.push('(d.description LIKE ? OR d.comment LIKE ?)');
      params.push(`%${q.q}%`, `%${q.q}%`);
    }
    const w = `WHERE ${where.join(' AND ')}`;
    const from = 'FROM deposit d LEFT JOIN account a ON a.account_idx = d.account_idx';
    const totals = db.get<{ n: number; amount: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(d.amount), 0) AS amount ${from} ${w}`, params)!;
    const items = db
      .all(`${DEPOSIT_SELECT} ${w} ORDER BY ${DEPOSIT_SORT[q.sort]} ${q.dir}, d.deposit_idx ${q.dir} LIMIT ? OFFSET ?`, [
        ...params,
        q.pageSize,
        (q.page - 1) * q.pageSize,
      ])
      .map(toDeposit);
    return { items, total: totals.n, totalAmount: Math.round(totals.amount * 100) / 100 };
  });

  r.get('/api/deposits/:id', ({ params }) => getDeposit(db, idParam.parse(params.id)));

  r.post('/api/deposits', ({ body }) => {
    const i = depositInput.parse(body);
    checkAccount(db, i.accountIdx);
    const { lastInsertRowid } = db.run(
      'INSERT INTO deposit (transaction_date, description, amount, income_amount, reviewed, comment, account_idx) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [i.transactionDate, i.description, i.amount, i.incomeAmount, i.reviewed, i.comment, i.accountIdx],
    );
    return getDeposit(db, lastInsertRowid);
  });

  r.patch('/api/deposits/:id', ({ params, body }) => {
    const id = idParam.parse(params.id);
    const p = depositPatch.parse(body);
    getDeposit(db, id);
    if (p.accountIdx) checkAccount(db, p.accountIdx);
    patchRow(db, 'deposit', 'deposit_idx', id, DEPOSIT_COLUMNS, p);
    return getDeposit(db, id);
  });

  r.post('/api/deposits/bulk', ({ body }) => {
    const b = depositBulk.parse(body);
    const set =
      b.action === 'income'
        ? 'income_amount = amount, reviewed = 1'
        : b.action === 'transfer'
          ? "income_amount = 0, reviewed = 1, comment = COALESCE(NULLIF(comment, ''), 'Transfer')"
          : 'reviewed = 0';
    const { changes } = db.tx(() => db.run(`UPDATE deposit SET ${set} WHERE deposit_idx IN (${inList(b.ids.length)})`, b.ids));
    return { updated: changes };
  });

  r.delete('/api/deposits/:id', ({ params }) => {
    const id = idParam.parse(params.id);
    getDeposit(db, id);
    db.run('DELETE FROM deposit WHERE deposit_idx = ?', [id]);
  });
};
