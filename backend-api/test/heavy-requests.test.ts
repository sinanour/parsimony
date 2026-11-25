// Finding 5: a single cheap request must not be able to block the (single-threaded) server. Covers the
// date-format compiler (ReDoS), import parse/commit record caps, set-based duplicate detection, and the
// bounded, rate-limited rule run.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, startApp, type TestApp } from './helpers';
import { loadConfig } from '../src/config';
import { compileDateFormat, MAX_DATE_LENGTH, strptime } from '../src/services/statements/python-compat';
import { PDF_LAYOUTS } from '../src/services/statements/pdf-layouts';
import { flagDuplicates } from '../src/services/importer';
import type { ImportRecord, StatementFormatInput } from '../../shared/types';

/** The pentest's pattern: %Y, then 29 × %H, then a literal Z (61 characters). */
const REDOS_FORMAT = '%Y' + '%H'.repeat(29) + 'Z';
/** 62 digits: matches the prefix greedily, then fails on the missing Z. */
const REDOS_CELL = '2026' + '1'.repeat(58);

const limits = (patch: Partial<ReturnType<typeof loadConfig>['limits']>) => ({ ...loadConfig().limits, ...patch });

async function createUser(t: TestApp, token: string, email: string, role: string): Promise<string> {
  const password = `${role.toLowerCase()}-password-1`;
  const res = await t.api('POST', '/api/users', { email, password, role, displayName: null }, { token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return (await t.login(email, password)).token;
}

const upload = (t: TestApp, token: string, body: string | Buffer, name: string) =>
  t.api('POST', '/api/import/parse', Buffer.from(body), {
    token,
    headers: { 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' },
  });

describe('date-format compiler', () => {
  test('rejects any directive used twice, including the pentest ReDoS pattern', () => {
    assert.equal(REDOS_FORMAT.length, 61);
    assert.throws(() => compileDateFormat(REDOS_FORMAT), /"%H" appears twice/);
    for (const f of ['%d%d', '%H:%M:%H', '%Y %I%I', '%S%S%m', '%M %M', '%a %a', '%p%p']) {
      assert.throws(() => compileDateFormat(f), /appears twice/, f);
    }
    assert.ok(compileDateFormat('%Y%%%m%%%d'), '%% is a literal and may repeat');
  });

  test('every built-in format still compiles and parses', () => {
    for (const layout of Object.values(PDF_LAYOUTS)) for (const f of layout.settings.dateFormats) assert.ok(compileDateFormat(f));
    assert.deepEqual(strptime('20260105', '%Y%m%d'), { year: 2026, month: 1, day: 5 });
    assert.deepEqual(strptime('05-JAN-2026', '%d-%b-%Y'), { year: 2026, month: 1, day: 5 });
    assert.deepEqual(strptime('Wednesday, September 30, 2026 11:59:59 PM', '%A, %B %d, %Y %I:%M:%S %p'), null, '41 chars');
    assert.deepEqual(strptime('Wed, September 30, 2026 11:59:59 PM', '%a, %B %d, %Y %I:%M:%S %p'), { year: 2026, month: 9, day: 30 });
  });

  test('date cells longer than 40 characters are rejected before matching', () => {
    const f = '%d%m%H%I%M%S%y%Y';
    const long = '1'.repeat(MAX_DATE_LENGTH + 1);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) assert.equal(strptime(long, f), null);
    assert.ok(performance.now() - t0 < 100, 'a thousand oversized cells take well under 100 ms');
    assert.equal(strptime(`2026-01-05${' '.repeat(31)}`, '%Y-%m-%d'), null);
  });

  test('the worst legal format on a hostile 40-character cell stays fast', () => {
    const formats = ['%d%m%H%I%M%S%y%Y', '%Y%d%m%H%I%M%S%y%p', '%d %m %H %I %M %S %y %Y', '%a%A%b%B%d%m%H%M%S%Y'];
    const cells = ['1'.repeat(39) + 'Z', '1 '.repeat(19) + '1Z', ' 1'.repeat(19) + 'Z', 'mon'.repeat(13) + 'Z'];
    let worst = 0;
    for (const f of formats) {
      for (const c of cells) {
        const t0 = performance.now();
        strptime(c, f);
        worst = Math.max(worst, performance.now() - t0);
      }
    }
    assert.ok(worst < 20, `worst single match took ${worst.toFixed(2)} ms`);
  });
});

describe('statement formats and imports', () => {
  let t: TestApp;
  let admin = '';
  before(async () => {
    t = await startApp({ overrides: { limits: limits({ importMaxRecords: 5 }) } });
    admin = (await t.login(ADMIN.email, ADMIN.password)).token;
  });
  after(() => t.close());

  const format: StatementFormatInput = {
    name: 'ReDoS Bank',
    fileNamePattern: 'redos bank',
    fileType: 'csv',
    parser: 'card',
    settings: {
      headerRows: 0,
      columnCount: 3,
      columns: { date: 0, description: 1, debit: 2, credit: 2, account: null, cheque: null },
      headerNames: null,
      dateFormats: [REDOS_FORMAT],
    },
    pdfLayout: null,
    isActive: true,
  };

  test('every seeded statement format compiles', () => {
    const rows = t.app.db.all<{ settings: string | null }>('SELECT settings FROM statement_format WHERE settings IS NOT NULL');
    assert.ok(rows.length > 5);
    for (const r of rows) for (const f of JSON.parse(r.settings!).dateFormats as string[]) assert.ok(compileDateFormat(f), f);
  });

  test('the pentest date format is rejected when saved', async () => {
    const res = await t.api('POST', '/api/statement-formats', format, { token: admin });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /appears twice/);
  });

  test('a dangerous format stored directly in the database is skipped, quickly, with a warning', async () => {
    const settings = { ...format.settings!, dateFormats: [REDOS_FORMAT, '%Y-%m-%d'] };
    t.app.db.run(
      `INSERT INTO statement_format (name, file_name_pattern, file_type, parser, settings) VALUES ('ReDoS Bank', 'redos bank', 'csv', 'card', ?)`,
      [JSON.stringify(settings)],
    );
    // ~60 bytes, like the pentest's file, plus one ordinary row.
    const csv = `${REDOS_CELL},X,1\n2026-01-05,Coffee,4.50\n`;
    const t0 = performance.now();
    const res = await upload(t, admin, csv, `redos bank.csv`);
    const ms = performance.now() - t0;
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(ms < 1000, `parse took ${ms.toFixed(0)} ms`);
    assert.equal(res.data.records.length, 0, 'no account for this file name, but nothing hung');

    // The same thing with an account chosen: the ReDoS row never matches, the good row does.
    const chosen = await t.api('POST', `/api/import/parse?accountIdx=${t.ids!.personalVisa}`, Buffer.from(csv), {
      token: admin,
      headers: { 'X-File-Name': 'redos bank.csv', 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(chosen.status, 200);
    assert.ok(chosen.data.warnings.some((w: string) => /date format .* is ignored: "%H" appears twice/.test(w)), JSON.stringify(chosen.data.warnings));
    assert.deepEqual(
      chosen.data.records.map((r: any) => r.transactionDate),
      ['2026-01-05'],
    );

    // The 62-character cell is also over the date-length cap, so no format is even tried on it.
    const t1 = performance.now();
    assert.equal(strptime(REDOS_CELL, '%Y%H%M%S%d%m'), null);
    assert.ok(performance.now() - t1 < 100);
  });

  test('parse refuses a statement with more records than IMPORT_MAX_RECORDS', async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `2026-02-${String(i + 1).padStart(2, '0')},Shop ${i},${i + 1}.00`).join('\n');
    const ok = await upload(t, admin, rows(5), 'RBC Personal Visa Feb.csv');
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.records.length, 5);
    const big = await upload(t, admin, rows(6), 'RBC Personal Visa Feb.csv');
    assert.equal(big.status, 413);
    assert.equal(big.data.code, 'TOO_MANY_RECORDS');
  });

  test('commit refuses more records than IMPORT_MAX_RECORDS, before validating them', async () => {
    const record = { type: 'expense', transactionDate: '2026-03-01', description: 'Cap test', amount: 1, accountIdx: t.ids!.cash, category: null, exemption: null, incomeAmount: null };
    const big = await t.api('POST', '/api/import/commit', { records: Array.from({ length: 6 }, () => record) }, { token: admin });
    assert.equal(big.status, 413);
    assert.equal(big.data.code, 'TOO_MANY_RECORDS');
    // Even invalid records aren't looked at once the batch is too big.
    const junk = await t.api('POST', '/api/import/commit', { records: Array.from({ length: 6 }, () => ({})) }, { token: admin });
    assert.equal(junk.status, 413);
    const before = t.app.db.scalar<number>(`SELECT COUNT(*) FROM expense WHERE description = 'Cap test'`);
    assert.equal(before, 0);
    const ok = await t.api('POST', '/api/import/commit', { records: Array.from({ length: 5 }, () => record) }, { token: admin });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.expensesInserted, 5);
  });

  test('set-based duplicate detection keeps multiplicity, case-insensitivity and deposit rules', () => {
    const db = t.app.db;
    const acct = t.ids!.cash;
    db.run(`INSERT INTO expense (transaction_date, description, amount, account_idx) VALUES ('2020-05-01', 'Dup Shop', 10.5, ?)`, [acct]);
    db.run(`INSERT INTO expense (transaction_date, description, amount, account_idx) VALUES ('2020-05-01', 'Twice Shop', 7, ?)`, [acct]);
    db.run(`INSERT INTO expense (transaction_date, description, amount, account_idx) VALUES ('2020-05-01', 'Twice Shop', 7, ?)`, [acct]);
    db.run(`INSERT INTO deposit (transaction_date, description, amount, income_amount, account_idx) VALUES ('2020-05-02', 'Old text', 99.99, 0, ?)`, [acct]);
    let n = 0;
    const rec = (type: 'expense' | 'deposit', date: string, description: string, amount: number, accountIdx = acct): ImportRecord => ({
      key: String(n++), type, transactionDate: date, description, amount, accountIdx, accountName: 'Cash',
      category: null, exemption: null, incomeAmount: type === 'deposit' ? 0 : null, isDuplicate: false,
    });
    const records = [
      rec('expense', '2020-05-01', 'DUP SHOP', 10.5), // duplicate (case-insensitive)
      rec('expense', '2020-05-01', 'Dup Shop', 10.5), // only one row exists → not a duplicate
      rec('expense', '2020-05-01', 'Twice Shop', 7), // two exist → both flagged
      rec('expense', '2020-05-01', 'Twice Shop', 7),
      rec('expense', '2020-05-01', 'Twice Shop', 7), // third copy is new
      rec('expense', '2020-05-01', 'Dup Shop', 10.51), // different amount
      rec('expense', '2020-05-02', 'Dup Shop', 10.5), // different date
      rec('expense', '2020-05-01', 'Dup Shop', 10.5, t.ids!.chequing), // different account
      rec('deposit', '2020-05-02', 'New text', 99.99), // deposits ignore the description
      rec('deposit', '2020-05-02', 'New text', 99.99), // but count multiplicity
      rec('deposit', '2020-05-02', 'Old text', 10), // different amount
    ];
    flagDuplicates(db, records);
    assert.deepEqual(
      records.map((r) => r.isDuplicate),
      [true, false, true, true, false, false, false, false, true, false, false],
    );
  });
});

describe('rule runs', () => {
  let t: TestApp;
  let admin = '';
  let reader = '';
  let editor = '';
  before(async () => {
    t = await startApp({ overrides: { auth: { heavyRateLimit: 3 }, limits: limits({ maxRulesPerScope: 4 }) } });
    admin = (await t.login(ADMIN.email, ADMIN.password)).token;
    reader = await createUser(t, admin, 'reader@example.test', 'READ_ONLY');
    editor = await createUser(t, admin, 'editor@example.test', 'EDITOR');
  });
  after(() => t.close());

  test('read-only users may dry-run (Preview rules) but not apply', async () => {
    const dry = await t.api('POST', '/api/rules/run', { scope: 'personal', dryRun: true }, { token: reader });
    assert.equal(dry.status, 200);
    assert.equal(dry.data.dryRun, true);
    assert.ok(dry.data.totalRows > 0);
    const real = await t.api('POST', '/api/rules/run', { scope: 'personal', dryRun: false }, { token: reader });
    assert.equal(real.status, 403);
  });

  test('a dry run reports exactly what applying does', async () => {
    const dry = await t.api('POST', '/api/rules/run', { scope: 'personal', dryRun: true }, { token: editor });
    const uncategorized = t.app.db.scalar<number>('SELECT COUNT(*) FROM expense WHERE category IS NULL');
    const real = await t.api('POST', '/api/rules/run', { scope: 'personal', dryRun: false }, { token: editor });
    assert.equal(real.status, 200);
    const strip = (r: any) => r.results.map(({ ruleIdx, rowCount, matches }: any) => ({ ruleIdx, rowCount, ids: matches.map((m: any) => m.expenseIdx).sort() }));
    assert.deepEqual(strip(real.data), strip(dry.data));
    assert.equal(t.app.db.scalar<number>('SELECT COUNT(*) FROM expense WHERE category IS NULL'), uncategorized - real.data.totalRows);
    for (const r of real.data.results) {
      const categorized = t.app.db.all<{ category: string }>(
        `SELECT category FROM expense WHERE expense_idx IN (${r.matches.map((m: any) => m.expenseIdx).join(',')})`,
      );
      assert.ok(categorized.every((c) => c.category === r.category));
    }
  });

  test('runs and dry runs share a small per-user budget', async () => {
    // The editor has spent 2 of 3 above (dry run + apply); one more is allowed, then 429.
    for (let i = 0; i < 1; i++) assert.equal((await t.api('POST', '/api/rules/run', { scope: 'personal', dryRun: true }, { token: editor })).status, 200);
    const limited = await t.api('POST', '/api/rules/run', { scope: 'personal', dryRun: true }, { token: editor });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    // Import parse and commit draw on the same budget…
    assert.equal((await upload(t, editor, '2026-01-01,X,1\n', 'RBC Personal Visa Jan.csv')).status, 429);
    // …but other users keep theirs, and cheap requests are unaffected.
    assert.equal((await t.api('POST', '/api/rules/run', { scope: 'personal', dryRun: true }, { token: admin })).status, 200);
    assert.equal((await t.api('GET', '/api/rules', undefined, { token: editor })).status, 200);
  });

  test('the number of rules per scope is capped', async () => {
    const rule = { descriptionFilter: 'cap-test', minimumAmount: null, maximumAmount: null, category: 'Misc', exemption: null, isCorporate: false };
    const existing = t.app.db.scalar<number>('SELECT COUNT(*) FROM expense_categorization_rule WHERE is_corporate = 0');
    assert.ok(existing < 4);
    for (let i = existing; i < 4; i++) assert.equal((await t.api('POST', '/api/rules', rule, { token: admin })).status, 200);
    const over = await t.api('POST', '/api/rules', rule, { token: admin });
    assert.equal(over.status, 400);
    assert.match(over.data.error, /at most 4 rules/);
    // A scope that already holds more (e.g. from before the cap) is refused, not half-run.
    t.app.db.run(`INSERT INTO expense_categorization_rule (description_filter, category, is_corporate) VALUES ('legacy', 'Misc', 0)`);
    const run = await t.api('POST', '/api/rules/run', { scope: 'personal', dryRun: true }, { token: admin });
    assert.equal(run.status, 400);
    assert.match(run.data.error, /more than 4 rules/);
    // An import that asks for a rule run is refused before anything is inserted.
    const record = { type: 'expense', transactionDate: '2026-03-02', description: 'Rule cap import', amount: 1, accountIdx: t.ids!.cash, category: null, exemption: null, incomeAmount: null };
    const commit = await t.api('POST', '/api/import/commit', { records: [record], runRules: true }, { token: admin });
    assert.equal(commit.status, 400);
    assert.equal(t.app.db.scalar<number>(`SELECT COUNT(*) FROM expense WHERE description = 'Rule cap import'`), 0);
  });

  test('rule queries use the uncategorized-expense index', () => {
    const plan = t.app.db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM expense WHERE category IS NULL AND description LIKE ? AND amount >= ? AND amount <= ?
       AND account_idx IN (SELECT account_idx FROM account WHERE is_corporate = ?)`,
      ['%x%', 0, 1, 0],
    );
    assert.ok(plan.some((p) => p.detail.includes('expense_uncategorized_IDX')), JSON.stringify(plan));
  });
});
