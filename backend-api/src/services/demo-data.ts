import type { Db } from '../db';

/** Shifts today's date by whole months/days and returns YYYY-MM-DD. */
function dateFrom(base: Date, months: number, days = 0): string {
  const d = new Date(base.getFullYear(), base.getMonth() + months, base.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface DemoIds {
  chequing: number;
  personalVisa: number;
  businessVisa: number;
  businessChequing: number;
  cash: number;
  oldCard: number;
  hydro: number;
  internet: number;
  insurance: number;
  /** Expense with a fixed $20 exemption. */
  dollarExemptExpense: number;
  /** Expense with a 50% exemption. */
  fractionExemptExpense: number;
}

/**
 * Fills an empty database with a small, entirely fictional dataset: accounts, payees, bill payments,
 * about 14 months of expenses and deposits, and a few categorization rules. Dates are relative to
 * `today`, so dashboards and "due soon" lists always have something to show.
 */
export function seedDemoData(db: Db, today = new Date()): DemoIds {
  return db.tx(() => {
    const account = (name: string, cc: boolean, corp: boolean, active: boolean, numbers: string[], pattern: string | null = null) => {
      const id = db.run('INSERT INTO account (name, is_credit_card, is_corporate, is_active, statement_file_pattern) VALUES (?, ?, ?, ?, ?)', [
        name,
        cc,
        corp,
        active,
        pattern,
      ]).lastInsertRowid;
      for (const n of numbers) db.run('INSERT INTO account_num (account_idx, account_no) VALUES (?, ?)', [id, n]);
      return id;
    };
    const chequing = account('Everyday Chequing', false, false, true, ['00011-1234567'], 'demo bank chequing');
    const personalVisa = account('Personal Visa', true, false, true, ['4500000000001111'], 'rbc personal visa');
    const businessVisa = account('Business Visa', true, true, true, ['4500000000002222'], 'rbc corporate visa');
    const businessChequing = account('Business Chequing', false, true, true, ['00022-7654321']);
    const cash = account('Cash', false, false, true, []);
    const oldCard = account('Old Mastercard', true, false, false, ['5100000000003333']);

    const payee = (name: string, acct: string, category: string, period: number) =>
      db.run('INSERT INTO payee (payee, account_num, is_active, payee_category, payment_period) VALUES (?, ?, 1, ?, ?)', [name, acct, category, period])
        .lastInsertRowid;
    const hydro = payee('City Hydro', 'H-100200', 'Utilities', 2);
    const internet = payee('FastNet Internet', 'FN-55501', 'Utilities', 1);
    const insurance = payee('Home Insurance Co', 'POL-778899', 'Insurance', 12);

    const pay = (payeeIdx: number, date: string, amount: number, from: number, conf: string | null = null) =>
      db.run('INSERT INTO payment (payee_idx, transaction_date, amount, confirmation, account_idx) VALUES (?, ?, ?, ?, ?)', [payeeIdx, date, amount, conf, from]);
    // Hydro every two months, last paid ~2 months ago → due about now.
    for (const m of [-8, -6, -4, -2]) pay(hydro, dateFrom(today, m, 3), 140 + m, chequing, `HY${100 - m}`);
    // Internet monthly, last paid last month → due within days.
    for (let m = -6; m <= -1; m++) pay(internet, dateFrom(today, m, 5), 75, personalVisa);
    // Insurance yearly, paid 3 months ago → scheduled.
    pay(insurance, dateFrom(today, -3), 1200, chequing, 'INS-2026');

    const expense = (acct: number, date: string, description: string, amount: number, category: string | null = null, exemption: number | null = null, comment: string | null = null) =>
      db.run('INSERT INTO expense (transaction_date, category, exemption, description, amount, account_idx, comment) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        date,
        category,
        exemption,
        description,
        amount,
        acct,
        comment,
      ]).lastInsertRowid;
    const deposit = (acct: number, date: string, description: string, amount: number, income: number, reviewed: boolean, comment: string | null = null) =>
      db.run('INSERT INTO deposit (transaction_date, description, amount, income_amount, reviewed, comment, account_idx) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        date,
        description,
        amount,
        income,
        reviewed,
        comment,
        acct,
      ]);

    for (let m = -13; m <= 0; m++) {
      expense(personalVisa, dateFrom(today, m, -20), 'Fresh Market Groceries', 180 + ((m * 7) % 40), 'Groceries', 1);
      expense(personalVisa, dateFrom(today, m, -15), 'Corner Bistro', 62.5, 'Restaurant', 0);
      expense(chequing, dateFrom(today, m, -12), 'Transfer To Savings', 500, 'Transfer', 0);
      expense(businessVisa, dateFrom(today, m, -10), 'Office Depot Supplies', 45.99, 'Office Supplies', 1);
      deposit(chequing, dateFrom(today, m, -25), 'Payroll Deposit Acme Corp', 4200, 4200, true);
      deposit(businessChequing, dateFrom(today, m, -18), 'Client Payment Invoice', 2500, 2500, true);
    }
    // Uncategorized items that the rules below will pick up, plus some they won't.
    expense(personalVisa, dateFrom(today, -1, 2), 'Pizza Palace #1042 Anytown', 90.25);
    expense(personalVisa, dateFrom(today, -1, 4), 'Bean There Coffee', 4.35);
    expense(personalVisa, dateFrom(today, -1, 4), 'Bean There Coffee', 4.35);
    expense(personalVisa, dateFrom(today, -1, 8), 'Mystery Merchant', 33.1);
    expense(businessVisa, dateFrom(today, -1, 6), 'Office Depot Supplies', 12.0);
    expense(cash, dateFrom(today, -1, 9), 'Farmers Market', 25);
    const dollarExemptExpense = expense(personalVisa, dateFrom(today, -2, 1), 'Pharmacy', 48.0, 'Health', 20);
    const fractionExemptExpense = expense(personalVisa, dateFrom(today, -2, 2), 'Hardware Store', 80.0, 'Home', 0.5);
    deposit(chequing, dateFrom(today, -1, 1), 'E-Transfer Received', 150, 0, false);
    deposit(chequing, dateFrom(today, -1, 3), 'Refund Online Store', 39.99, 0, false);
    deposit(chequing, dateFrom(today, -1, 10), 'Interest', 1.23, 1.23, true);

    const rule = (filter: string, min: number | null, max: number | null, category: string, exemption: number, corp: boolean) =>
      db.run(
        'INSERT INTO expense_categorization_rule (description_filter, minimum_amount, maximum_amount, category, exemption, is_corporate) VALUES (?, ?, ?, ?, ?, ?)',
        [filter, min, max, category, exemption, corp],
      );
    rule('pizza palace', null, null, 'Restaurant', 0, false);
    rule('coffee', null, 10, 'Treat', 0, false);
    rule('groceries', null, null, 'Groceries', 1, false);
    rule('office depot', null, null, 'Office Supplies', 1, true);

    // Report periods: the twelve months up to the end of this month.
    const start = `${dateFrom(today, -11).slice(0, 7)}-01`;
    const end = `${dateFrom(today, 1).slice(0, 7)}-01`;
    for (const t of ['huquq_date_range', 'corporate_date_range']) {
      db.run(`DELETE FROM ${t}`);
      db.run(`INSERT INTO ${t} (start_date, end_date) VALUES (?, ?)`, [start, end]);
    }

    return { chequing, personalVisa, businessVisa, businessChequing, cash, oldCard, hydro, internet, insurance, dollarExemptExpense, fractionExemptExpense };
  });
}
