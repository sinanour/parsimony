import { z } from 'zod';
import type { Db } from '../db';
import { badRequest, Reply } from '../http';
import { TEXT_LIMITS } from '../../../shared/types';
import type { CorporateReport, CorporateRow, CoverageRow, DashboardData, DateRange, HuquqReport, Meta, MonthlySpendingRow, PaymentTotalRow } from '../../../shared/types';
import { upcomingPayments } from './payments';
import { redactForRole, visibleSql } from '../redact';
import { isoDate, localToday, queryObject, scopeClause, scopeSchema, type RouteModule } from './common';

const rangeInput = z
  .object({ startDate: isoDate, endDate: isoDate })
  .refine((r) => r.startDate < r.endDate, { message: 'End date must be after start date', path: ['endDate'] });

function getRange(db: Db, table: 'huquq_date_range' | 'corporate_date_range'): DateRange {
  const row = db.get<{ start_date: string; end_date: string }>(`SELECT start_date, end_date FROM ${table} LIMIT 1`);
  if (!row) throw badRequest(`${table} has no rows`);
  return { startDate: row.start_date, endDate: row.end_date };
}

function setRange(db: Db, table: 'huquq_date_range' | 'corporate_date_range', body: unknown): DateRange {
  const r = rangeInput.parse(body);
  db.tx(() => {
    // These tables hold one row by convention.
    db.run(`DELETE FROM ${table}`);
    db.run(`INSERT INTO ${table} (start_date, end_date) VALUES (?, ?)`, [r.startDate, r.endDate]);
  });
  return r;
}

export function coverage(db: Db): CoverageRow[] {
  return db
    .all(`SELECT * FROM vw_transaction_date_ranges`)
    .map((r) => ({
      accountIdx: Number(r.account_idx),
      accountName: String(r.account_name),
      isActive: Number(r.is_account_active) !== 0,
      firstTransactionMonth: String(r.first_transaction_month),
      lastTransactionMonth: String(r.last_transaction_month),
      distinctMonthCount: Number(r.distinct_month_count),
      missingMonthCount: Number(r.missing_month_count),
    }));
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const reportRoutes: RouteModule = (r, { db }) => {
  r.get('/api/meta', ({ user }): Meta => {
    // Every user loads this on sign-in. Categories longer than the stored limit can only be legacy rows
    // written before the limit existed; leaving them out keeps one oversized value from bloating it.
    const maxCategory = TEXT_LIMITS.category;
    const cats = db.all<{ is_corporate: number; category: string }>(
      "SELECT is_corporate, category FROM vw_all_categories WHERE category <> '' AND length(category) <= ?",
      [maxCategory],
    );
    return {
      categories: {
        personal: cats.filter((c) => !c.is_corporate).map((c) => c.category),
        corporate: cats.filter((c) => c.is_corporate).map((c) => c.category),
      },
      payeeCategories: db
        .all<{ c: string }>("SELECT DISTINCT payee_category AS c FROM payee WHERE payee_category <> '' AND length(payee_category) <= ? ORDER BY 1", [
          maxCategory,
        ])
        .map((x) => x.c),
      accounts: db
        .all(
          `SELECT account_idx, substr(name, 1, ?) AS name, is_active, is_corporate, is_credit_card FROM account ORDER BY is_active DESC, ${visibleSql('name', user)}`,
          [TEXT_LIMITS.accountName],
        )
        .map((a) => ({
          accountIdx: Number(a.account_idx),
          name: String(a.name),
          isActive: Number(a.is_active) !== 0,
          isCorporate: Number(a.is_corporate) !== 0,
          isCreditCard: Number(a.is_credit_card) !== 0,
        })),
    };
  });

  r.get('/api/dashboard', (): DashboardData => {
    const count = (sql: string, corp: number) => db.scalar<number>(sql, [corp]);
    const unc = `SELECT COUNT(*) FROM expense e JOIN account a USING (account_idx) WHERE COALESCE(e.category, '') = '' AND a.is_corporate = ?`;
    const unr = `SELECT COUNT(*) FROM deposit d JOIN account a USING (account_idx) WHERE d.reviewed = 0 AND a.is_corporate = ?`;
    const today = localToday();
    const d = new Date(`${today}T00:00:00`);
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    const lastMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return {
      uncategorizedExpenses: { personal: count(unc, 0), corporate: count(unc, 1) },
      unreviewedDeposits: { personal: count(unr, 0), corporate: count(unr, 1) },
      upcoming: upcomingPayments(db, today).filter((p) => p.isUpcoming),
      coverage: coverage(db).filter((c) => c.isActive && (c.lastTransactionMonth < lastMonth || c.missingMonthCount > 0)),
      lastMonth,
    };
  });

  r.get('/api/reports/monthly-spending', ({ query }): MonthlySpendingRow[] => {
    const q = z
      .object({ months: z.coerce.number().int().min(1).max(120).default(12), scope: scopeSchema, end: isoDate.optional() })
      .parse(queryObject(query));
    // Anchor on the latest expense so the chart is useful even if statements lag behind.
    const end = q.end ?? db.scalar<string>('SELECT MAX(transaction_date) FROM expense') ?? localToday();
    return db
      .all<{ month: string; category: string; total: number }>(
        `SELECT strftime('%Y-%m', e.transaction_date) AS month, e.category, ROUND(SUM(e.amount), 2) AS total
         FROM expense e JOIN account a USING (account_idx)
         WHERE ${scopeClause(q.scope)}
           AND COALESCE(e.category, '') NOT IN ('', 'Transfer', '3rd Party', 'Huquq')
           AND e.transaction_date >= date(?, 'start of month', ?) AND e.transaction_date <= ?
         GROUP BY 1, 2 ORDER BY 1, 2`,
        [end, `-${q.months - 1} months`, end],
      )
      .map((x) => ({ month: x.month, category: x.category, total: x.total }));
  });

  r.get('/api/reports/huquq', (): HuquqReport => {
    const p = db.get('SELECT * FROM vw_huquq_payment_for_date_range');
    return {
      range: getRange(db, 'huquq_date_range'),
      payment: p
        ? {
            totalIncome: Number(p.total_income),
            totalExpenses: Number(p.total_expenses),
            totalExemptions: Number(p.total_exemptions),
            uncategorizedIncome: Number(p.uncategorized_income),
            uncategorizedExpenses: Number(p.uncategorized_expenses),
            minPayment: Number(p.min_payment),
            estimatedPayment: Number(p.estimated_payment),
            maxPayment: Number(p.max_payment),
          }
        : null,
      expenseSummary: db.all('SELECT * FROM vw_expense_summary_for_date_range').map((x) => ({
        exemptionClassification: String(x.exemption_classification),
        category: String(x.category ?? ''),
        total: Number(x.total),
      })),
      exemptionsByAccount: db
        .all('SELECT * FROM vw_huquq_exemptions_for_date_range WHERE is_corporate = 0')
        .map((x) => ({
          accountName: String(x.account_name),
          category: String(x.category ?? ''),
          totalAmount: Number(x.total_amount),
          totalExemption: Number(x.total_exemption),
        })),
      income: db.all('SELECT * FROM vw_huquq_income_for_date_range WHERE is_corporate = 0').map((x) => ({
        description: String(x.description ?? ''),
        totalIncome: Number(x.total_income),
      })),
    };
  });

  r.put('/api/reports/huquq/range', ({ body }) => setRange(db, 'huquq_date_range', body));

  r.get('/api/reports/corporate', ({ query, user }) => {
    const rows: CorporateRow[] = db.all('SELECT * FROM vw_corporate_transactions_for_date_range').map((x) => ({
      category: String(x.category),
      subcategory: x.subcategory === null ? null : String(x.subcategory),
      accountType: String(x.account_type),
      accountNum: x.account_num === null ? null : String(x.account_num),
      transactionDate: String(x.transaction_date),
      cheque: String(x.cheque ?? ''),
      description: x.description === null ? null : String(x.description),
      description2: x.description2 === null ? null : String(x.description2),
      amount: Number(x.amount),
      adjustment: x.adjustment === null ? null : Number(x.adjustment),
    }));
    const range = getRange(db, 'corporate_date_range');
    if (query.get('format') === 'csv') {
      // Redact the cells, not the finished text, so numeric cells (amounts) are never mistaken for
      // account numbers; the JSON form is redacted by the router.
      const cells = redactForRole(rows, user);
      const header = ['Category', 'Subcategory', 'Account Type', 'Account #', 'Has Receipt', 'Date', 'Cheque', 'Description', 'Description 2', 'Amount', 'Adjustment'];
      const lines = [header.join(',')].concat(
        cells.map((x) =>
          [x.category, x.subcategory, x.accountType, x.accountNum, '', x.transactionDate, x.cheque, x.description, x.description2, x.amount, x.adjustment]
            .map(csvCell)
            .join(','),
        ),
      );
      return new Reply(
        lines.join('\r\n') + '\r\n',
        {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="corporate-transactions-${range.startDate}-to-${range.endDate}.csv"`,
        },
        200,
        true,
      );
    }
    return { range, rows } satisfies CorporateReport;
  });

  r.put('/api/reports/corporate/range', ({ body }) => setRange(db, 'corporate_date_range', body));

  r.get('/api/reports/payment-totals', (): PaymentTotalRow[] =>
    db.all('SELECT * FROM vw_payment_totals').map((x) => ({ year: String(x.payment_year), recipient: String(x.recipient), total: Math.round(Number(x.total) * 100) / 100 })),
  );

  r.get('/api/reports/coverage', () => coverage(db));
};
