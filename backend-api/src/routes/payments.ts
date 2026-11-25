import { z } from 'zod';
import { strOrNull, type Db } from '../db';
import { badRequest, notFound } from '../http';
import type { AuthUser, DueStatus, Payment, UpcomingPayment } from '../../../shared/types';
import { visibleSql } from '../redact';
import { idParam, isoDate, localToday, money, pagingSchema, queryObject, searchText, TEXT_LIMITS, trimmedOrNull, type RouteModule } from './common';

const paymentInput = z.object({
  payeeIdx: z.number().int().positive(),
  transactionDate: isoDate,
  amount: money,
  confirmation: trimmedOrNull(TEXT_LIMITS.confirmation),
  payerAccountIdx: z.number().int().positive(),
});

const listQuery = pagingSchema.extend({
  payeeIdx: z.coerce.number().int().optional(),
  accountIdx: z.coerce.number().int().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: searchText.optional(),
  sort: z.enum(['transactionDate', 'amount', 'payeeName', 'payerAccountName']).default('transactionDate'),
});

/** Text sorts use visibleSql, so a READ_ONLY user's order never depends on masked digits. */
const sortColumn = (sort: string, u: AuthUser | null): string =>
  ({
    transactionDate: 'pmt.transaction_date',
    amount: 'pmt.amount',
    payeeName: visibleSql('p.payee', u),
    payerAccountName: visibleSql('a.name', u),
  })[sort]!;

const SELECT = `SELECT pmt.payment_idx, pmt.payee_idx, p.payee, p.payee_category, pmt.transaction_date, pmt.amount,
  pmt.confirmation, pmt.account_idx, a.name AS account_name
  FROM payment pmt JOIN payee p ON p.payee_idx = pmt.payee_idx LEFT JOIN account a ON a.account_idx = pmt.account_idx`;

function toPayment(r: Record<string, unknown>): Payment {
  return {
    paymentIdx: Number(r.payment_idx),
    payeeIdx: Number(r.payee_idx),
    payeeName: String(r.payee),
    payeeCategory: String(r.payee_category ?? ''),
    transactionDate: String(r.transaction_date),
    amount: Number(r.amount),
    confirmation: strOrNull(r.confirmation),
    payerAccountIdx: Number(r.account_idx),
    payerAccountName: String(r.account_name ?? `#${r.account_idx}`),
  };
}

function getPayment(db: Db, id: number): Payment {
  const row = db.get(`${SELECT} WHERE pmt.payment_idx = ?`, [id]);
  if (!row) throw notFound('Payment');
  return toPayment(row);
}

function checkRefs(db: Db, payeeIdx: number, accountIdx: number): void {
  if (!db.get('SELECT 1 FROM payee WHERE payee_idx = ?', [payeeIdx])) throw badRequest(`Unknown payee #${payeeIdx}`);
  if (!db.get('SELECT 1 FROM account WHERE account_idx = ?', [accountIdx])) throw badRequest(`Unknown account #${accountIdx}`);
}

/** Same logic as vw_last_payment / vw_upcoming_payments, with ids and a status added. */
export function upcomingPayments(db: Db, today = localToday()): UpcomingPayment[] {
  return db
    .all(
      `SELECT pmt.payment_idx, p.payee_idx, p.payee, p.payee_category, pmt.transaction_date AS last_date,
              date(pmt.transaction_date, '+' || p.payment_period || ' month') AS next_date,
              pmt.amount, pmt.confirmation, pmt.account_idx, a.name AS account_name, p.payment_period,
              CAST(julianday(date(pmt.transaction_date, '+' || p.payment_period || ' month')) - julianday(?) AS INTEGER) AS days
       FROM payee p
       JOIN payment pmt ON pmt.payment_idx = (
         SELECT payment_idx FROM payment p2 WHERE p2.payee_idx = p.payee_idx
         ORDER BY p2.transaction_date DESC, p2.payment_idx DESC LIMIT 1)
       LEFT JOIN account a ON a.account_idx = pmt.account_idx
       WHERE p.is_active <> 0
       ORDER BY next_date, p.payee`,
      [today],
    )
    .map((r) => {
      const period = Number(r.payment_period);
      const days = Number(r.days);
      const isUpcoming = days <= (period < 6 ? 15 : 30);
      const status: DueStatus = days < 0 ? 'overdue' : isUpcoming ? 'due-soon' : 'scheduled';
      return {
        paymentIdx: Number(r.payment_idx),
        payeeIdx: Number(r.payee_idx),
        payee: String(r.payee),
        payeeCategory: String(r.payee_category ?? ''),
        lastPaymentDate: String(r.last_date),
        nextPaymentDate: String(r.next_date),
        amount: Number(r.amount),
        confirmation: strOrNull(r.confirmation),
        payerAccountIdx: Number(r.account_idx),
        payerAccountName: String(r.account_name ?? ''),
        paymentPeriod: period,
        daysUntilDue: days,
        status,
        isUpcoming,
      };
    });
}

export const paymentRoutes: RouteModule = (r, { db }) => {
  r.get('/api/payments/upcoming', () => upcomingPayments(db));

  r.get('/api/payments/defaults/:payeeIdx', ({ params }) => {
    const payeeIdx = idParam.parse(params.payeeIdx);
    const last = db.get<{ amount: number; account_idx: number }>(
      'SELECT amount, account_idx FROM payment WHERE payee_idx = ? ORDER BY transaction_date DESC, payment_idx DESC LIMIT 1',
      [payeeIdx],
    );
    return { amount: last?.amount ?? null, payerAccountIdx: last?.account_idx ?? null };
  });

  r.get('/api/payments', ({ query, user }) => {
    const q = listQuery.parse(queryObject(query));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.payeeIdx) (where.push('pmt.payee_idx = ?'), params.push(q.payeeIdx));
    if (q.accountIdx) (where.push('pmt.account_idx = ?'), params.push(q.accountIdx));
    if (q.from) (where.push('pmt.transaction_date >= ?'), params.push(q.from));
    if (q.to) (where.push('pmt.transaction_date <= ?'), params.push(q.to));
    if (q.q) {
      // READ_ONLY users match against the redacted text they see, so a digit search can't confirm masked digits.
      where.push(`(${visibleSql('pmt.confirmation', user)} LIKE ? OR ${visibleSql('p.payee', user)} LIKE ?)`);
      params.push(`%${q.q}%`, `%${q.q}%`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.scalar<number>(
      `SELECT COUNT(*) FROM payment pmt JOIN payee p ON p.payee_idx = pmt.payee_idx LEFT JOIN account a ON a.account_idx = pmt.account_idx ${w}`,
      params,
    );
    const items = db
      .all(`${SELECT} ${w} ORDER BY ${sortColumn(q.sort, user)} ${q.dir}, pmt.payment_idx ${q.dir} LIMIT ? OFFSET ?`, [
        ...params,
        q.pageSize,
        (q.page - 1) * q.pageSize,
      ])
      .map(toPayment);
    return { items, total };
  });

  r.get('/api/payments/:id', ({ params }) => getPayment(db, idParam.parse(params.id)));

  r.post('/api/payments', ({ body }) => {
    const i = paymentInput.parse(body);
    checkRefs(db, i.payeeIdx, i.payerAccountIdx);
    const { lastInsertRowid } = db.run(
      'INSERT INTO payment (payee_idx, transaction_date, amount, confirmation, account_idx) VALUES (?, ?, ?, ?, ?)',
      [i.payeeIdx, i.transactionDate, i.amount, i.confirmation, i.payerAccountIdx],
    );
    return getPayment(db, lastInsertRowid);
  });

  r.put('/api/payments/:id', ({ params, body }) => {
    const id = idParam.parse(params.id);
    const i = paymentInput.parse(body);
    getPayment(db, id);
    checkRefs(db, i.payeeIdx, i.payerAccountIdx);
    db.run('UPDATE payment SET payee_idx = ?, transaction_date = ?, amount = ?, confirmation = ?, account_idx = ? WHERE payment_idx = ?', [
      i.payeeIdx,
      i.transactionDate,
      i.amount,
      i.confirmation,
      i.payerAccountIdx,
      id,
    ]);
    return getPayment(db, id);
  });

  r.delete('/api/payments/:id', ({ params }) => {
    const id = idParam.parse(params.id);
    getPayment(db, id);
    db.run('DELETE FROM payment WHERE payment_idx = ?', [id]);
  });
};
