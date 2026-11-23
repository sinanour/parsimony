import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ADMIN, startApp, type TestApp } from './helpers';
import { Db } from '../src/db';
import { migrate, listMigrations } from '../src/migrations';
import { runRules } from '../src/services/rules';

// Optional parity check against the original Python categorizer:
//   LEGACY_CATEGORIZER=/path/to/expense_categorizer.py PARITY_DB=/path/to/a/real.sqlite npm test
const LEGACY_CATEGORIZER = process.env.LEGACY_CATEGORIZER;
const PARITY_DB = process.env.PARITY_DB;
const PYTHON = process.env.PYTHON ?? 'python3';

let t: TestApp;
let token = '';
const api = <T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => t.api<T>(method, url, body, { token, headers });

before(async () => {
  t = await startApp();
  token = (await t.login(ADMIN.email, ADMIN.password)).token;
});
after(() => t.close());

function rawDb(): DatabaseSync {
  return new DatabaseSync(t.config.dbPath);
}

describe('migrations', () => {
  test('are recorded and idempotent', () => {
    const db = new Db(t.config.dbPath);
    assert.deepEqual(migrate(db), []);
    const applied = db.all<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id').map((r) => r.id);
    assert.deepEqual(applied, listMigrations().map((m) => m.id));
    db.close();
  });
  test('the baseline leaves an existing database untouched', () => {
    const file = path.join(t.dir, 'legacy.sqlite');
    const legacy = new Db(file);
    legacy.raw.exec(fs.readFileSync(listMigrations()[0].file, 'utf8'));
    legacy.raw.exec(`DELETE FROM huquq_date_range; INSERT INTO huquq_date_range VALUES ('2020-01-01', '2021-01-01');
      INSERT INTO account (name) VALUES ('Legacy');`);
    assert.deepEqual(migrate(legacy), listMigrations().map((m) => m.id));
    assert.equal(legacy.scalar('SELECT start_date FROM huquq_date_range'), '2020-01-01');
    assert.equal(legacy.scalar('SELECT COUNT(*) FROM account'), 1);
    legacy.close();
  });
});

describe('meta & dashboard', () => {
  test('meta lists categories and accounts', async () => {
    const { status, data } = await api('GET', '/api/meta');
    assert.equal(status, 200);
    assert.ok(data.categories.personal.includes('Restaurant'));
    assert.ok(data.categories.corporate.includes('Office Supplies'));
    assert.equal(data.accounts.length, 6);
  });
  test('dashboard counts match the views', async () => {
    const { data } = await api('GET', '/api/dashboard');
    const raw = rawDb();
    const n = raw.prepare('SELECT COUNT(*) AS n FROM vw_uncategorized_expenses WHERE is_corporate = 0').get() as { n: number };
    raw.close();
    assert.equal(data.uncategorizedExpenses.personal, n.n);
    assert.equal(data.uncategorizedExpenses.corporate, 1);
    assert.equal(data.unreviewedDeposits.personal, 2);
    assert.ok(data.upcoming.length >= 1);
  });
  test('public config', async () => {
    const { status, data } = await t.api('GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(data.setupRequired, false);
    assert.equal(data.currency, t.config.currency);
  });
});

describe('accounts', () => {
  test('create, update, delete an unused account', async () => {
    const created = await api('POST', '/api/accounts', {
      name: 'Test Account',
      isCreditCard: true,
      isCorporate: false,
      isActive: true,
      accountNumbers: ['1234 5678', ''],
      statementFilePattern: ' Test Bank Visa ',
    });
    assert.equal(created.status, 200);
    assert.deepEqual(created.data.accountNumbers, ['12345678']);
    assert.equal(created.data.statementFilePattern, 'test bank visa');
    const id = created.data.accountIdx;
    const updated = await api('PUT', `/api/accounts/${id}`, { ...created.data, name: 'Renamed', accountNumbers: ['999'] });
    assert.equal(updated.data.name, 'Renamed');
    assert.deepEqual(updated.data.accountNumbers, ['999']);
    assert.equal((await api('DELETE', `/api/accounts/${id}`)).status, 204);
    assert.equal((await api('GET', `/api/accounts/${id}`)).status, 404);
  });
  test('refuses to delete an account with transactions', async () => {
    const res = await api('DELETE', `/api/accounts/${t.ids!.personalVisa}`);
    assert.equal(res.status, 409);
    const raw = rawDb();
    assert.ok((raw.prepare('SELECT COUNT(*) AS n FROM expense WHERE account_idx = ?').get(t.ids!.personalVisa) as { n: number }).n > 0);
    raw.close();
  });
  test('validation errors are 400s', async () => {
    const res = await api('POST', '/api/accounts', { name: '', isCreditCard: 'yes' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /name/);
  });
});

describe('payees & payments', () => {
  let payeeIdx = 0;
  test('create payee', async () => {
    const res = await api('POST', '/api/payees', { payee: 'Test Water', accountNum: 'A-1', isActive: true, payeeCategory: 'Utilities', paymentPeriod: 2 });
    assert.equal(res.status, 200);
    payeeIdx = res.data.payeeIdx;
    assert.equal(res.data.lastPaymentDate, null);
  });
  test('record, list, edit and delete a payment', async () => {
    const from = t.ids!.chequing;
    const created = await api('POST', '/api/payments', { payeeIdx, transactionDate: '2026-11-01', amount: 123.45, confirmation: ' ABC ', payerAccountIdx: from });
    assert.equal(created.status, 200);
    assert.equal(created.data.confirmation, 'ABC');
    assert.equal((await api('GET', `/api/payees/${payeeIdx}`)).data.nextPaymentDate, '2027-01-01');
    assert.deepEqual((await api('GET', `/api/payments/defaults/${payeeIdx}`)).data, { amount: 123.45, payerAccountIdx: from });
    assert.equal((await api('GET', `/api/payments?payeeIdx=${payeeIdx}`)).data.total, 1);
    const edited = await api('PUT', `/api/payments/${created.data.paymentIdx}`, { payeeIdx, transactionDate: '2026-11-02', amount: 10, confirmation: null, payerAccountIdx: from });
    assert.equal(edited.data.amount, 10);
    assert.equal((await api('DELETE', `/api/payees/${payeeIdx}`)).status, 409);
    assert.equal((await api('DELETE', `/api/payments/${created.data.paymentIdx}`)).status, 204);
    assert.equal((await api('DELETE', `/api/payees/${payeeIdx}`)).status, 204);
  });
  test('rejects payments to unknown payees and bad dates', async () => {
    const from = t.ids!.chequing;
    assert.equal((await api('POST', '/api/payments', { payeeIdx: 99999, transactionDate: '2026-11-01', amount: 1, confirmation: null, payerAccountIdx: from })).status, 400);
    assert.equal((await api('POST', '/api/payments', { payeeIdx: t.ids!.hydro, transactionDate: '2026-02-30', amount: 1, confirmation: null, payerAccountIdx: from })).status, 400);
  });
  test('upcoming payments agree with vw_upcoming_payments', async () => {
    const { data } = await api('GET', '/api/payments/upcoming');
    const raw = rawDb();
    const legacy = raw.prepare('SELECT payment_idx FROM vw_upcoming_payments').all() as { payment_idx: number }[];
    raw.close();
    assert.ok(legacy.length > 0);
    const ours = new Set(data.filter((u: any) => u.isUpcoming).map((u: any) => u.paymentIdx));
    for (const l of legacy) assert.ok(ours.has(l.payment_idx), `payment ${l.payment_idx} missing`);
  });
});

describe('expenses & deposits', () => {
  test('filters and paginates', async () => {
    const all = await api('GET', '/api/expenses?pageSize=10');
    assert.equal(all.data.items.length, 10);
    assert.ok(all.data.total > 50);
    const unc = await api('GET', '/api/expenses?category=__uncategorized__&scope=personal&pageSize=500');
    assert.ok(unc.data.items.length > 0);
    assert.ok(unc.data.items.every((e: any) => e.category === null && !e.isCorporate));
    const q = await api('GET', '/api/expenses?q=coffee&sort=amount&dir=asc&pageSize=5');
    assert.equal(q.data.items.length, 2);
    assert.ok(q.data.items.every((e: any) => /coffee/i.test(e.description)));
    const first = all.data.items.at(-1).transactionDate;
    const range = await api('GET', `/api/expenses?from=${first}&to=${first}&pageSize=500`);
    assert.ok(range.data.items.length > 0 && range.data.items.every((e: any) => e.transactionDate === first));
  });
  test('computes exempt amount for fraction and dollar exemptions', async () => {
    const d = await api('GET', `/api/expenses/${t.ids!.dollarExemptExpense}`);
    assert.equal(d.data.exemption, 20);
    assert.equal(d.data.exemptAmount, 20);
    const f = await api('GET', `/api/expenses/${t.ids!.fractionExemptExpense}`);
    assert.equal(f.data.exemptAmount, 40);
  });
  test('patch and bulk update; empty category becomes NULL', async () => {
    const [a, b] = [t.ids!.dollarExemptExpense, t.ids!.fractionExemptExpense];
    const p = await api('PATCH', `/api/expenses/${a}`, { category: '  ', exemption: 0.5 });
    assert.equal(p.data.category, null);
    assert.equal(p.data.exemption, 0.5);
    const bulk = await api('POST', '/api/expenses/bulk', { ids: [a, b], category: 'Misc' });
    assert.equal(bulk.data.updated, 2);
    assert.equal((await api('GET', `/api/expenses/${a}`)).data.category, 'Misc');
    assert.equal((await api('PATCH', `/api/expenses/${a}`, { bogus: 1 })).status, 400);
  });
  test('deposit bulk actions', async () => {
    const unr = await api('GET', '/api/deposits?reviewed=unreviewed&pageSize=2');
    const ids = unr.data.items.map((d: any) => d.depositIdx);
    assert.equal(ids.length, 2);
    await api('POST', '/api/deposits/bulk', { ids, action: 'transfer' });
    for (const id of ids) {
      const d = (await api('GET', `/api/deposits/${id}`)).data;
      assert.equal(d.reviewed, true);
      assert.equal(d.incomeAmount, 0);
      assert.ok(d.comment);
    }
    await api('POST', '/api/deposits/bulk', { ids, action: 'income' });
    const d = (await api('GET', `/api/deposits/${ids[0]}`)).data;
    assert.equal(d.incomeAmount, d.amount);
  });
  test('manual expense create/delete', async () => {
    const c = await api('POST', '/api/expenses', { transactionDate: '2026-11-20', category: 'Treat', exemption: 0, description: 'Coffee', amount: 4.5, accountIdx: t.ids!.cash, comment: null });
    assert.equal(c.status, 200);
    assert.equal((await api('DELETE', `/api/expenses/${c.data.expenseIdx}`)).status, 204);
  });
});

describe('rules', () => {
  test('list includes match counts', async () => {
    const { data } = await api('GET', '/api/rules?scope=personal');
    assert.equal(data.length, 3);
    assert.ok(data.every((r: any) => !r.isCorporate && typeof r.matchCount === 'number'));
    assert.equal(data.find((r: any) => r.descriptionFilter === 'coffee').matchCount, 2);
  });
  test('preview an unsaved rule', async () => {
    const { data } = await api('POST', '/api/rules/preview', { descriptionFilter: 'mystery', minimumAmount: null, maximumAmount: null, isCorporate: false });
    assert.equal(data.total, 1);
  });
  test('dry run reports matches without modifying the database', async () => {
    const before = (await api('GET', '/api/dashboard')).data.uncategorizedExpenses.personal;
    const run = await api('POST', '/api/rules/run', { scope: 'personal', dryRun: true });
    assert.equal(run.status, 200);
    assert.ok(run.data.totalRows >= 3, JSON.stringify(run.data).slice(0, 300));
    assert.equal((await api('GET', '/api/dashboard')).data.uncategorizedExpenses.personal, before);
  });
  test('CRUD', async () => {
    const c = await api('POST', '/api/rules', { descriptionFilter: 'zzqq', minimumAmount: 1, maximumAmount: 2, category: 'Misc', exemption: 0, isCorporate: false });
    assert.equal(c.status, 200);
    assert.equal((await api('POST', '/api/rules', { descriptionFilter: 'x', minimumAmount: 5, maximumAmount: 2, category: 'Misc', exemption: 0, isCorporate: false })).status, 400);
    const u = await api('PUT', `/api/rules/${c.data.ruleIdx}`, { ...c.data, category: 'Gift' });
    assert.equal(u.data.category, 'Gift');
    assert.equal((await api('DELETE', `/api/rules/${c.data.ruleIdx}`)).status, 204);
  });
});

describe('rule engine parity with expense_categorizer.py', { skip: !(LEGACY_CATEGORIZER && PARITY_DB) && 'set LEGACY_CATEGORIZER and PARITY_DB' }, () => {
  test('produces identical categories, exemptions and comments', () => {
    const legacyDb = path.join(t.dir, 'parity-legacy.sqlite');
    const oursDb = path.join(t.dir, 'parity-ours.sqlite');
    const reset = `UPDATE expense SET category = NULL, exemption = NULL, comment = NULL WHERE transaction_date >= '2024-01-01' AND comment LIKE 'Automatic Rule%'`;
    for (const f of [legacyDb, oursDb]) {
      fs.copyFileSync(PARITY_DB!, f);
      const d = new DatabaseSync(f);
      d.exec(reset);
      d.close();
    }
    const py = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ec", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.CONN_STRING_SQLITE_BILLS_DB = sys.argv[2]
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    m.main(); m.main("-c")
`;
    execFileSync(PYTHON, ['-I', '-c', py, LEGACY_CATEGORIZER!, legacyDb]);
    const ours = new Db(oursDb);
    runRules(ours, false, false);
    runRules(ours, true, false);
    ours.close();
    const read = (f: string) => {
      const d = new DatabaseSync(f);
      const rows = d.prepare(`SELECT expense_idx, category, exemption, substr(comment, 40) AS c FROM expense ORDER BY expense_idx`).all();
      d.close();
      return rows.map((r: any) => `${r.expense_idx}|${r.category}|${r.exemption}|${r.c}`);
    };
    const a = read(legacyDb);
    const b = read(oursDb);
    const diffs = a.filter((x, i) => x !== b[i]);
    assert.equal(diffs.length, 0, `first differences:\n${diffs.slice(0, 5).join('\n')}`);
  });
});

describe('statement import', () => {
  let records: any[] = [];
  let csv: Buffer;
  before(() => {
    const raw = rawDb();
    const pizza = raw.prepare(`SELECT transaction_date AS d FROM expense WHERE description LIKE 'Pizza Palace%'`).get() as { d: string };
    raw.close();
    csv = Buffer.from(`${pizza.d},PIZZA PALACE #1042 ANYTOWN,90.25\n${pizza.d},NEW MERCHANT ANYTOWN,12.34\n${pizza.d},NEW MERCHANT ANYTOWN,12.34\n${pizza.d},PAYMENT - THANK YOU,-500.00\n`);
  });
  const upload = (body: Buffer, name: string, query = '') =>
    api('POST', `/api/import/parse${query}`, body, { 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' });

  test('picks the account by file-name pattern and flags duplicates', async () => {
    const res = await upload(csv, 'RBC Personal Visa Feb.csv');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    records = res.data.records;
    assert.equal(records.length, 3);
    assert.equal(records[0].isDuplicate, true);
    assert.equal(records[1].isDuplicate, false);
    assert.equal(records[0].accountName, 'Personal Visa');
    assert.ok(res.data.warnings.some((w: string) => /already exist/.test(w)));
  });
  test('an explicitly chosen account wins over the pattern', async () => {
    const res = await upload(csv, 'RBC Personal Visa Feb.csv', `?accountIdx=${t.ids!.oldCard}`);
    assert.ok(res.data.records.every((r: any) => r.accountIdx === t.ids!.oldCard));
  });
  test('asks for an account when nothing matches', async () => {
    const raw = rawDb();
    raw.prepare(`UPDATE account SET statement_file_pattern = NULL WHERE account_idx = ?`).run(t.ids!.personalVisa);
    raw.close();
    const res = await upload(csv, 'RBC Personal Visa Feb.csv');
    assert.equal(res.data.records.length, 0);
    assert.ok(res.data.warnings.some((w: string) => /No account for RBC Personal Visa Feb\.csv/.test(w)), JSON.stringify(res.data.warnings));
    const back = rawDb();
    back.prepare(`UPDATE account SET statement_file_pattern = 'rbc personal visa' WHERE account_idx = ?`).run(t.ids!.personalVisa);
    back.close();
  });
  test('rejects unsupported files', async () => {
    assert.equal((await upload(Buffer.from('x'), 'notes.txt')).status, 400);
  });
  test('reports unknown statement formats as warnings', async () => {
    const res = await upload(Buffer.from('a,b'), 'mystery.csv');
    assert.equal(res.status, 200);
    assert.equal(res.data.records.length, 0);
    assert.ok(res.data.warnings.some((w: string) => w.includes('mystery.csv') && !w.includes(os.tmpdir())));
  });
  test('commits selected records and runs rules', async () => {
    const fresh = records.filter((r) => !r.isDuplicate).map(({ key, isDuplicate, accountName, ...r }) => r);
    const res = await api('POST', '/api/import/commit', { records: fresh, runRules: true });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.expensesInserted, 2);
    assert.equal(res.data.rules.length, 2);
    const again = await upload(csv, 'RBC Personal Visa Feb.csv');
    assert.ok(again.data.records.every((r: any) => r.isDuplicate));
  });
});

describe('reports', () => {
  test('huquq report', async () => {
    const { data } = await api('GET', '/api/reports/huquq');
    assert.ok(data.range.startDate < data.range.endDate);
    assert.ok(data.payment.estimatedPayment > 0);
    assert.ok(data.expenseSummary.length > 0);
  });
  test('range update validates and persists', async () => {
    assert.equal((await api('PUT', '/api/reports/huquq/range', { startDate: '2026-01-01', endDate: '2025-01-01' })).status, 400);
    const raw = rawDb();
    const first = (raw.prepare('SELECT MIN(transaction_date) AS d FROM expense').get() as { d: string }).d;
    raw.close();
    assert.equal((await api('PUT', '/api/reports/corporate/range', { startDate: first, endDate: '2099-01-01' })).status, 200);
    const rep = await api('GET', '/api/reports/corporate');
    assert.equal(rep.data.range.startDate, first);
    assert.ok(rep.data.rows.length > 0);
  });
  test('corporate CSV export', async () => {
    const res = await fetch(`${t.base}/api/reports/corporate?format=csv`, { headers: { Authorization: `Bearer ${token}` } });
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment/);
    assert.ok((await res.text()).startsWith('Category,Subcategory'));
  });
  test('other reports', async () => {
    assert.ok((await api('GET', '/api/reports/payment-totals')).data.length > 0);
    assert.ok((await api('GET', '/api/reports/coverage')).data.length > 0);
    const m = await api('GET', '/api/reports/monthly-spending?months=12&scope=personal');
    assert.ok(m.data.length > 0 && new Set(m.data.map((r: any) => r.month)).size <= 12);
  });
  test('unknown API routes 404; wrong method 405', async () => {
    assert.equal((await api('GET', '/api/nope')).status, 404);
    assert.equal((await api('PATCH', '/api/accounts')).status, 405);
  });
});
