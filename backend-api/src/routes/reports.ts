import { z } from 'zod';
import type { Db } from '../db';
import { badRequest, Reply } from '../http';
import { SPENDING_MAX_PERIODS, TEXT_LIMITS } from '../../../shared/types';
import type { CorporateReport, CorporateRow, CoverageRow, DashboardData, DateRange, HuquqReport, Meta, PaymentTotalRow, SpendingGrouping, SpendingReport } from '../../../shared/types';
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

/** Categories that move money around rather than spend it; '' stands for uncategorized. */
const NON_SPENDING_CATEGORIES = ['', 'Transfer', '3rd Party', 'Huquq'];

const spendingQuery = z
  .object({
    scope: z.enum(['personal', 'corporate']).default('personal'),
    grouping: z.enum(['month', 'quarter', 'year']).default('month'),
    months: z.coerce.number().int().min(1).max(SPENDING_MAX_PERIODS).optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
  })
  .refine((q) => (q.startDate === undefined) === (q.endDate === undefined), { message: 'Give both startDate and endDate, or neither', path: ['endDate'] })
  .refine((q) => q.months === undefined || q.startDate === undefined, { message: 'Give either months or a date range, not both', path: ['months'] })
  .refine((q) => !q.startDate || !q.endDate || q.startDate <= q.endDate, { message: 'End date must not be before start date', path: ['endDate'] });

/** `YYYY-MM-DD` plus `n` calendar months (the day must be valid in every month, e.g. the 1st). */
function addMonths(iso: string, n: number): string {
  const total = Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}${iso.slice(7)}`;
}

/** The period label of a `YYYY-MM-DD` date: `2026-03`, `2026 Q1` or `2026`. */
function periodOf(iso: string, g: SpendingGrouping): string {
  if (g === 'month') return iso.slice(0, 7);
  if (g === 'year') return iso.slice(0, 4);
  return `${iso.slice(0, 4)} Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;
}

/** SQL for the same label as periodOf(). */
function periodSql(g: SpendingGrouping, col: string): string {
  if (g === 'month') return `strftime('%Y-%m', ${col})`;
  if (g === 'year') return `strftime('%Y', ${col})`;
  return `strftime('%Y', ${col}) || ' Q' || ((CAST(strftime('%m', ${col}) AS INTEGER) + 2) / 3)`;
}

/** Every period label from the one holding `start` to the one holding `end`, in order. */
function periodsBetween(start: string, end: string, g: SpendingGrouping): string[] {
  const step = g === 'month' ? 1 : g === 'quarter' ? 3 : 12;
  const out: string[] = [];
  const last = periodOf(end, g);
  // Walk month starts; stop early past the cap so a huge range can't allocate a huge array.
  for (let m = `${start.slice(0, 7)}-01`; out.length <= SPENDING_MAX_PERIODS; m = addMonths(m, step)) {
    const p = periodOf(m, g);
    if (out[out.length - 1] !== p) out.push(p);
    if (p === last) break;
  }
  return out;
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

  r.get('/api/reports/spending', ({ query }): SpendingReport => {
    const q = spendingQuery.parse(queryObject(query));
    let { startDate, endDate } = q;
    if (!startDate || !endDate) {
      // Relative ranges anchor on the latest expense in the scope, so the chart stays useful when
      // statements lag behind.
      endDate =
        db.scalar<string>(`SELECT MAX(e.transaction_date) FROM expense e JOIN account a USING (account_idx) WHERE ${scopeClause(q.scope)}`) ??
        localToday();
      startDate = addMonths(`${endDate.slice(0, 7)}-01`, -((q.months ?? 12) - 1));
    }
    const periods = periodsBetween(startDate, endDate, q.grouping);
    if (periods.length > SPENDING_MAX_PERIODS) {
      throw badRequest(`That range has ${periods.length} periods; choose a shorter range or a coarser grouping (at most ${SPENDING_MAX_PERIODS}).`);
    }
    const rows = db
      .all<{ period: string; category: string; total: number }>(
        `SELECT ${periodSql(q.grouping, 'e.transaction_date')} AS period, e.category, ROUND(SUM(e.amount), 2) AS total
         FROM expense e JOIN account a USING (account_idx)
         WHERE ${scopeClause(q.scope)}
           AND COALESCE(e.category, '') NOT IN (${NON_SPENDING_CATEGORIES.map(() => '?').join(', ')})
           AND e.transaction_date >= ? AND e.transaction_date <= ?
         GROUP BY 1, 2 ORDER BY 1, 2`,
        [...NON_SPENDING_CATEGORIES, startDate, endDate],
      )
      .map((x) => ({ period: x.period, category: x.category, total: x.total }));
    return { startDate, endDate, grouping: q.grouping, periods, rows };
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

  // Same grouping as vw_payment_totals, restricted by the paying account's scope.
  r.get('/api/reports/payment-totals', ({ query }): PaymentTotalRow[] => {
    const q = z.object({ scope: scopeSchema }).parse(queryObject(query));
    return db
      .all(
        `SELECT strftime('%Y', p.transaction_date) AS payment_year, pe.payee AS recipient, SUM(p.amount) AS total
         FROM payment p JOIN payee pe USING (payee_idx) JOIN account a USING (account_idx)
         WHERE ${scopeClause(q.scope)}
         GROUP BY 1, 2 ORDER BY 1, 2`,
      )
      .map((x) => ({ year: String(x.payment_year), recipient: String(x.recipient), total: Math.round(Number(x.total) * 100) / 100 }));
  });

  r.get('/api/reports/coverage', () => coverage(db));
};
