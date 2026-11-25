import { z } from 'zod';
import { bool, numOrNull, strOrNull, type Db } from '../db';
import { conflict, notFound } from '../http';
import type { Account, AuthUser } from '../../../shared/types';
import { visibleSql } from '../redact';
import { idParam, requiredText, TEXT_LIMITS, type RouteModule } from './common';

const accountInput = z.object({
  name: requiredText(TEXT_LIMITS.accountName),
  isCreditCard: z.boolean(),
  isCorporate: z.boolean(),
  isActive: z.boolean(),
  accountNumbers: z
    .array(
      z
        .string()
        .transform((s) => s.replace(/\s+/g, ''))
        .pipe(z.string().max(TEXT_LIMITS.accountNumber, `must be at most ${TEXT_LIMITS.accountNumber} characters`)),
    )
    .max(TEXT_LIMITS.accountNumbersPerAccount, `can have at most ${TEXT_LIMITS.accountNumbersPerAccount} entries`)
    .transform((a) => [...new Set(a.filter((s) => s.length > 0))]),
  statementFilePattern: z
    .string()
    .trim()
    .max(TEXT_LIMITS.statementFilePattern)
    .nullable()
    .optional()
    .transform((s) => (s ? s.toLowerCase() : null)),
});

// Account numbers, and long digit runs in names, are masked for READ_ONLY users by the router (redact.ts).

function listAccounts(db: Db, id?: number, user: AuthUser | null = null): Account[] {
  const rows = db.all(
    `SELECT a.account_idx, a.name, a.is_credit_card, a.is_corporate, a.is_active, a.statement_file_pattern,
            r.first_transaction_month, r.last_transaction_month, r.missing_month_count,
            (SELECT COUNT(*) FROM expense x WHERE x.account_idx = a.account_idx)
              + (SELECT COUNT(*) FROM deposit x WHERE x.account_idx = a.account_idx) AS transaction_count,
            (SELECT COUNT(*) FROM payment x WHERE x.account_idx = a.account_idx) AS payment_count
     FROM account a LEFT JOIN vw_transaction_date_ranges r USING (account_idx)
     ${id === undefined ? '' : 'WHERE a.account_idx = ?'}
     ORDER BY a.is_active DESC, ${visibleSql('a.name', user)}`,
    id === undefined ? [] : [id],
  );
  const numbers = new Map<number, string[]>();
  for (const n of db.all<{ account_idx: number; account_no: string }>('SELECT account_idx, account_no FROM account_num ORDER BY rowid')) {
    const list = numbers.get(n.account_idx) ?? [];
    list.push(n.account_no);
    numbers.set(n.account_idx, list);
  }
  return rows.map((r) => ({
    accountIdx: Number(r.account_idx),
    name: String(r.name),
    isCreditCard: bool(r.is_credit_card),
    isCorporate: bool(r.is_corporate),
    isActive: bool(r.is_active),
    accountNumbers: numbers.get(Number(r.account_idx)) ?? [],
    statementFilePattern: strOrNull(r.statement_file_pattern),
    firstTransactionMonth: strOrNull(r.first_transaction_month),
    lastTransactionMonth: strOrNull(r.last_transaction_month),
    missingMonthCount: numOrNull(r.missing_month_count),
    transactionCount: Number(r.transaction_count),
    paymentCount: Number(r.payment_count),
  }));
}

function getAccount(db: Db, id: number): Account {
  const a = listAccounts(db, id)[0];
  if (!a) throw notFound('Account');
  return a;
}

function writeNumbers(db: Db, id: number, numbers: string[]): void {
  db.run('DELETE FROM account_num WHERE account_idx = ?', [id]);
  for (const n of numbers) db.run('INSERT INTO account_num (account_idx, account_no) VALUES (?, ?)', [id, n]);
}

export const accountRoutes: RouteModule = (r, { db }) => {
  r.get('/api/accounts', ({ user }) => listAccounts(db, undefined, user));

  r.get('/api/accounts/:id', ({ params }) => getAccount(db, idParam.parse(params.id)));

  r.post('/api/accounts', ({ body }) => {
    const input = accountInput.parse(body);
    const id = db.tx(() => {
      const { lastInsertRowid } = db.run(
        'INSERT INTO account (name, is_credit_card, is_corporate, is_active, statement_file_pattern) VALUES (?, ?, ?, ?, ?)',
        [input.name, input.isCreditCard, input.isCorporate, input.isActive, input.statementFilePattern],
      );
      writeNumbers(db, lastInsertRowid, input.accountNumbers);
      return lastInsertRowid;
    });
    return getAccount(db, id);
  });

  r.put('/api/accounts/:id', ({ params, body }) => {
    const id = idParam.parse(params.id);
    const input = accountInput.parse(body);
    getAccount(db, id);
    db.tx(() => {
      db.run(
        'UPDATE account SET name = ?, is_credit_card = ?, is_corporate = ?, is_active = ?, statement_file_pattern = ? WHERE account_idx = ?',
        [input.name, input.isCreditCard, input.isCorporate, input.isActive, input.statementFilePattern, id],
      );
      writeNumbers(db, id, input.accountNumbers);
    });
    return getAccount(db, id);
  });

  r.delete('/api/accounts/:id', ({ params }) => {
    const id = idParam.parse(params.id);
    const a = getAccount(db, id);
    if (a.transactionCount > 0 || a.paymentCount > 0) {
      throw conflict(
        `"${a.name}" has ${a.transactionCount} transaction(s) and ${a.paymentCount} payment(s). Deactivate it instead of deleting.`,
      );
    }
    db.tx(() => {
      db.run('DELETE FROM account_num WHERE account_idx = ?', [id]);
      db.run('DELETE FROM account WHERE account_idx = ?', [id]);
    });
  });
};
