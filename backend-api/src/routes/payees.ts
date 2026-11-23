import { z } from 'zod';
import { bool, numOrNull, strOrNull, type Db } from '../db';
import { conflict, notFound } from '../http';
import type { Payee } from '../../../shared/types';
import { idParam, type RouteModule } from './common';

const payeeInput = z.object({
  payee: z.string().trim().min(1, 'is required'),
  accountNum: z.string().trim(),
  isActive: z.boolean(),
  payeeCategory: z.string().trim(),
  paymentPeriod: z.number().int().min(1).max(120),
});

function listPayees(db: Db, id?: number): Payee[] {
  return db
    .all(
      `SELECT p.payee_idx, p.payee, p.account_num, p.is_active, p.payee_category, p.payment_period,
              lp.transaction_date AS last_date, lp.amount AS last_amount,
              date(lp.transaction_date, '+' || p.payment_period || ' month') AS next_date,
              (SELECT COUNT(*) FROM payment x WHERE x.payee_idx = p.payee_idx) AS payment_count
       FROM payee p
       LEFT JOIN payment lp ON lp.payment_idx = (
         SELECT payment_idx FROM payment p2 WHERE p2.payee_idx = p.payee_idx
         ORDER BY p2.transaction_date DESC, p2.payment_idx DESC LIMIT 1)
       ${id === undefined ? '' : 'WHERE p.payee_idx = ?'}
       ORDER BY p.is_active DESC, p.payee`,
      id === undefined ? [] : [id],
    )
    .map((r) => ({
      payeeIdx: Number(r.payee_idx),
      payee: String(r.payee),
      accountNum: String(r.account_num),
      isActive: bool(r.is_active),
      payeeCategory: String(r.payee_category ?? ''),
      paymentPeriod: Number(r.payment_period),
      lastPaymentDate: strOrNull(r.last_date),
      lastPaymentAmount: numOrNull(r.last_amount),
      nextPaymentDate: strOrNull(r.next_date),
      paymentCount: Number(r.payment_count),
    }));
}

function getPayee(db: Db, id: number): Payee {
  const p = listPayees(db, id)[0];
  if (!p) throw notFound('Payee');
  return p;
}

export const payeeRoutes: RouteModule = (r, { db }) => {
  r.get('/api/payees', () => listPayees(db));
  r.get('/api/payees/:id', ({ params }) => getPayee(db, idParam.parse(params.id)));

  r.post('/api/payees', ({ body }) => {
    const i = payeeInput.parse(body);
    const { lastInsertRowid } = db.run(
      'INSERT INTO payee (payee, account_num, is_active, payee_category, payment_period) VALUES (?, ?, ?, ?, ?)',
      [i.payee, i.accountNum, i.isActive, i.payeeCategory, i.paymentPeriod],
    );
    return getPayee(db, lastInsertRowid);
  });

  r.put('/api/payees/:id', ({ params, body }) => {
    const id = idParam.parse(params.id);
    const i = payeeInput.parse(body);
    getPayee(db, id);
    db.run('UPDATE payee SET payee = ?, account_num = ?, is_active = ?, payee_category = ?, payment_period = ? WHERE payee_idx = ?', [
      i.payee,
      i.accountNum,
      i.isActive,
      i.payeeCategory,
      i.paymentPeriod,
      id,
    ]);
    return getPayee(db, id);
  });

  r.delete('/api/payees/:id', ({ params }) => {
    const id = idParam.parse(params.id);
    const p = getPayee(db, id);
    if (p.paymentCount > 0) throw conflict(`"${p.payee}" has ${p.paymentCount} payment(s). Deactivate it instead of deleting.`);
    db.run('DELETE FROM payee WHERE payee_idx = ?', [id]);
  });
};
