// Finding 6: every stored free-text field has a length cap (TEXT_LIMITS), import applies the same caps, and
// shared reads (/api/meta, rule match counts) are guarded against oversized legacy rows already in the DB.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, startApp, type TestApp } from './helpers';
import { TEXT_LIMITS } from '../../shared/types';

const over = (n: number) => 'x'.repeat(n + 1);
const exactly = (n: number) => 'y'.repeat(n);

describe('text length limits', () => {
  let t: TestApp;
  let admin: string;
  let expenseId: number;
  let depositId: number;

  const expense = (patch: Record<string, unknown> = {}) => ({
    transactionDate: '2026-03-01',
    category: 'Groceries',
    exemption: null,
    description: 'Corner store',
    amount: 12.5,
    accountIdx: t.ids!.cash,
    comment: null,
    ...patch,
  });
  const deposit = (patch: Record<string, unknown> = {}) => ({
    transactionDate: '2026-03-01',
    description: 'Payroll',
    amount: 100,
    incomeAmount: 100,
    reviewed: false,
    comment: null,
    accountIdx: t.ids!.chequing,
    ...patch,
  });
  const rule = (patch: Record<string, unknown> = {}) => ({
    descriptionFilter: 'Corner',
    minimumAmount: null,
    maximumAmount: null,
    category: 'Groceries',
    exemption: null,
    isCorporate: false,
    ...patch,
  });
  const account = (patch: Record<string, unknown> = {}) => ({
    name: 'Limits account',
    isCreditCard: false,
    isCorporate: false,
    isActive: true,
    accountNumbers: ['1234'],
    statementFilePattern: null,
    ...patch,
  });
  const payee = (patch: Record<string, unknown> = {}) => ({
    payee: 'Limits payee',
    accountNum: '5555',
    isActive: true,
    payeeCategory: 'Utilities',
    paymentPeriod: 1,
    ...patch,
  });
  const payment = (patch: Record<string, unknown> = {}) => ({
    payeeIdx: t.ids!.hydro,
    transactionDate: '2026-03-01',
    amount: 10,
    confirmation: null,
    payerAccountIdx: t.ids!.chequing,
    ...patch,
  });
  const importRecord = (patch: Record<string, unknown> = {}) => ({
    type: 'expense',
    transactionDate: '2026-03-02',
    description: 'Imported thing',
    amount: 3,
    accountIdx: t.ids!.cash,
    category: null,
    exemption: null,
    incomeAmount: null,
    ...patch,
  });

  async function expect400(method: string, url: string, body: unknown, field: string) {
    const res = await t.api(method, url, body, { token: admin });
    assert.equal(res.status, 400, `${method} ${url} ${field}: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
    assert.equal(res.data.code, 'VALIDATION_ERROR');
    assert.match(res.data.error, new RegExp(field.replace(/[.[\]]/g, '\\$&')), res.data.error);
    // The error doesn't echo the oversized value back.
    assert.ok(JSON.stringify(res.data).length < 2000);
  }

  async function expect200(method: string, url: string, body: unknown) {
    const res = await t.api(method, url, body, { token: admin });
    assert.equal(res.status, 200, `${method} ${url}: ${JSON.stringify(res.data).slice(0, 300)}`);
    return res.data;
  }

  before(async () => {
    t = await startApp();
    admin = (await t.login(ADMIN.email, ADMIN.password)).token;
    expenseId = (await expect200('POST', '/api/expenses', expense())).expenseIdx;
    depositId = (await expect200('POST', '/api/deposits', deposit())).depositIdx;
  });
  after(() => t.close());

  test('expenses: oversized description, category and comment are rejected on create, update and bulk', async () => {
    const L = TEXT_LIMITS;
    for (const [field, max] of [
      ['description', L.description],
      ['category', L.category],
      ['comment', L.comment],
    ] as const) {
      await expect400('POST', '/api/expenses', expense({ [field]: over(max) }), field);
      await expect400('PATCH', `/api/expenses/${expenseId}`, { [field]: over(max) }, field);
    }
    await expect400('POST', '/api/expenses/bulk', { ids: [expenseId], category: over(L.category) }, 'category');
    await expect400('POST', '/api/expenses/bulk', { ids: [expenseId], comment: over(L.comment) }, 'comment');
    // The pentest's 1,000,000-character values.
    await expect400('POST', '/api/expenses', expense({ description: 'd'.repeat(1_000_000) }), 'description');
    await expect400('POST', '/api/expenses', expense({ category: 'c'.repeat(1_000_000) }), 'category');

    // Exactly at the limit is fine, and the limit applies after trimming.
    const ok = await expect200(
      'POST',
      '/api/expenses',
      expense({ description: `  ${exactly(L.description)}  `, category: exactly(L.category), comment: exactly(L.comment) }),
    );
    assert.equal(ok.description.length, L.description);
    await expect200('PATCH', `/api/expenses/${ok.expenseIdx}`, { comment: exactly(L.comment) });
    await expect200('POST', '/api/expenses/bulk', { ids: [ok.expenseIdx], category: exactly(L.category), comment: exactly(L.comment) });
  });

  test('deposits: oversized description and comment are rejected on create and update', async () => {
    for (const [field, max] of [
      ['description', TEXT_LIMITS.description],
      ['comment', TEXT_LIMITS.comment],
    ] as const) {
      await expect400('POST', '/api/deposits', deposit({ [field]: over(max) }), field);
      await expect400('PATCH', `/api/deposits/${depositId}`, { [field]: over(max) }, field);
    }
    await expect200('PATCH', `/api/deposits/${depositId}`, { description: exactly(TEXT_LIMITS.description), comment: exactly(TEXT_LIMITS.comment) });
  });

  test('rules: oversized descriptionFilter and category are rejected on create, update and preview', async () => {
    const created = await expect200('POST', '/api/rules', rule());
    await expect400('POST', '/api/rules', rule({ descriptionFilter: over(TEXT_LIMITS.ruleFilter) }), 'descriptionFilter');
    await expect400('POST', '/api/rules', rule({ descriptionFilter: 'f'.repeat(49_001) }), 'descriptionFilter');
    await expect400('POST', '/api/rules', rule({ category: over(TEXT_LIMITS.category) }), 'category');
    await expect400('PUT', `/api/rules/${created.ruleIdx}`, rule({ descriptionFilter: over(TEXT_LIMITS.ruleFilter) }), 'descriptionFilter');
    await expect400('PUT', `/api/rules/${created.ruleIdx}`, rule({ category: over(TEXT_LIMITS.category) }), 'category');
    await expect400(
      'POST',
      '/api/rules/preview',
      { descriptionFilter: over(TEXT_LIMITS.ruleFilter), minimumAmount: null, maximumAmount: null, isCorporate: false },
      'descriptionFilter',
    );
    await expect200('PUT', `/api/rules/${created.ruleIdx}`, rule({ descriptionFilter: exactly(TEXT_LIMITS.ruleFilter), category: exactly(TEXT_LIMITS.category) }));
    await t.api('DELETE', `/api/rules/${created.ruleIdx}`, undefined, { token: admin });
  });

  test('accounts: oversized name, account numbers and file pattern are rejected on create and update', async () => {
    const created = await expect200('POST', '/api/accounts', account());
    const id = created.accountIdx;
    const bad: [Record<string, unknown>, string][] = [
      [{ name: over(TEXT_LIMITS.accountName) }, 'name'],
      [{ accountNumbers: ['1234', over(TEXT_LIMITS.accountNumber)] }, 'accountNumbers.1'],
      [{ accountNumbers: Array.from({ length: TEXT_LIMITS.accountNumbersPerAccount + 1 }, (_, i) => `${1000 + i}`) }, 'accountNumbers'],
      [{ statementFilePattern: over(TEXT_LIMITS.statementFilePattern) }, 'statementFilePattern'],
    ];
    for (const [patch, field] of bad) {
      await expect400('POST', '/api/accounts', account(patch), field);
      await expect400('PUT', `/api/accounts/${id}`, account(patch), field);
    }
    // The account-number cap counts characters after whitespace is removed.
    const spaced = `${'1234 '.repeat(TEXT_LIMITS.accountNumber / 4)}`;
    const ok = await expect200('PUT', `/api/accounts/${id}`, account({ name: exactly(TEXT_LIMITS.accountName), accountNumbers: [spaced] }));
    assert.equal(ok.accountNumbers[0].length, TEXT_LIMITS.accountNumber);
    await t.api('DELETE', `/api/accounts/${id}`, undefined, { token: admin });
  });

  test('payees and payments: oversized text fields are rejected on create and update', async () => {
    const created = await expect200('POST', '/api/payees', payee());
    for (const [field, max] of [
      ['payee', TEXT_LIMITS.payee],
      ['accountNum', TEXT_LIMITS.payeeAccountNum],
      ['payeeCategory', TEXT_LIMITS.category],
    ] as const) {
      await expect400('POST', '/api/payees', payee({ [field]: over(max) }), field);
      await expect400('PUT', `/api/payees/${created.payeeIdx}`, payee({ [field]: over(max) }), field);
    }
    const pmt = await expect200('POST', '/api/payments', payment({ confirmation: exactly(TEXT_LIMITS.confirmation) }));
    await expect400('POST', '/api/payments', payment({ confirmation: over(TEXT_LIMITS.confirmation) }), 'confirmation');
    await expect400('PUT', `/api/payments/${pmt.paymentIdx}`, payment({ confirmation: over(TEXT_LIMITS.confirmation) }), 'confirmation');
    await t.api('DELETE', `/api/payments/${pmt.paymentIdx}`, undefined, { token: admin });
    await t.api('DELETE', `/api/payees/${created.payeeIdx}`, undefined, { token: admin });
  });

  test('list search and filter parameters are capped', async () => {
    const q = encodeURIComponent(over(TEXT_LIMITS.search));
    for (const url of [`/api/expenses?q=${q}`, `/api/expenses?category=${q}`, `/api/deposits?q=${q}`, `/api/payments?q=${q}`]) {
      const res = await t.api('GET', url, undefined, { token: admin });
      assert.equal(res.status, 400, url);
    }
    assert.equal((await t.api('GET', `/api/expenses?q=${'a'.repeat(TEXT_LIMITS.search)}`, undefined, { token: admin })).status, 200);
  });

  test('import commit rejects oversized description and category with the same caps', async () => {
    await expect400('POST', '/api/import/commit', { records: [importRecord({ description: over(TEXT_LIMITS.description) })] }, 'records.0.description');
    await expect400('POST', '/api/import/commit', { records: [importRecord({ category: over(TEXT_LIMITS.category) })] }, 'records.0.category');
    const before = t.app.db.scalar<number>('SELECT COUNT(*) FROM expense');
    await expect400(
      'POST',
      '/api/import/commit',
      { records: [importRecord(), importRecord({ description: over(TEXT_LIMITS.description) })] },
      'records.1.description',
    );
    assert.equal(t.app.db.scalar<number>('SELECT COUNT(*) FROM expense'), before, 'nothing from a rejected batch is inserted');
    const ok = await expect200('POST', '/api/import/commit', { records: [importRecord({ description: exactly(TEXT_LIMITS.description) })] });
    assert.equal(ok.expensesInserted, 1);
  });

  test('import parse truncates over-long statement descriptions (with a warning) so commit accepts them', async () => {
    const long = 'Q'.repeat(TEXT_LIMITS.description + 300);
    const res = await t.api('POST', '/api/import/parse', Buffer.from(`2026-04-01,${long},9.99\n2026-04-02,Short one,1.00\n`), {
      token: admin,
      headers: { 'X-File-Name': encodeURIComponent('RBC Personal Visa Apr.csv'), 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data).slice(0, 300));
    const [first, second] = res.data.records;
    assert.equal(first.description.length, TEXT_LIMITS.description);
    assert.equal(second.description, 'Short One');
    assert.ok(res.data.warnings.some((w: string) => /1 description\(s\) were longer than 500 characters/.test(w)), res.data.warnings.join('|'));
    const commit = await expect200('POST', '/api/import/commit', { records: res.data.records });
    assert.equal(commit.expensesInserted, 2);
  });
});

describe('shared reads with oversized legacy rows', () => {
  let t: TestApp;
  let admin: string;

  before(async () => {
    t = await startApp();
    admin = (await t.login(ADMIN.email, ADMIN.password)).token;
  });
  after(() => t.close());

  test('a legacy oversized category, payee category or account name does not inflate /api/meta', async () => {
    const baseline = await t.api('GET', '/api/meta', undefined, { token: admin });
    assert.equal(baseline.status, 200);
    const baseSize = JSON.stringify(baseline.data).length;

    // Written directly, as rows stored before the limits existed would be.
    const big = 'C'.repeat(1_000_000);
    t.app.db.run('INSERT INTO expense (transaction_date, category, description, amount, account_idx) VALUES (?, ?, ?, ?, ?)', [
      '2026-01-01',
      big,
      'Legacy',
      1,
      t.ids!.cash,
    ]);
    t.app.db.run(
      "INSERT INTO expense (transaction_date, category, description, amount, account_idx) VALUES ('2026-01-01', ?, 'Legacy', 1, ?)",
      [exactly(TEXT_LIMITS.category), t.ids!.cash],
    );
    t.app.db.run("INSERT INTO payee (payee, account_num, is_active, payee_category, payment_period) VALUES ('Legacy', '1', 1, ?, 1)", [big]);
    t.app.db.run('UPDATE account SET name = ? WHERE account_idx = ?', ['A'.repeat(1_000_000), t.ids!.oldCard]);

    const res = await t.api('GET', '/api/meta', undefined, { token: admin });
    assert.equal(res.status, 200);
    const size = JSON.stringify(res.data).length;
    assert.ok(size < baseSize + 2 * TEXT_LIMITS.category + TEXT_LIMITS.accountName + 100, `meta grew from ${baseSize} to ${size}`);
    const all = [...res.data.categories.personal, ...res.data.categories.corporate];
    assert.ok(!all.includes(big), 'the oversized category is left out');
    assert.ok(all.includes(exactly(TEXT_LIMITS.category)), 'a category exactly at the limit is still listed');
    assert.ok(!res.data.payeeCategories.includes(big));
    const old = res.data.accounts.find((a: { accountIdx: number }) => a.accountIdx === t.ids!.oldCard);
    assert.equal(old.name.length, TEXT_LIMITS.accountName, 'an oversized legacy account name is shortened in meta');
  });

  test('a legacy oversized rule filter or description does not make GET /api/rules run the expensive LIKE', async () => {
    // The pentest's case: a 50,000-character uncategorized description and a 20,000-character filter.
    const filter = 'ab'.repeat(10_000);
    const description = `zzlegacy ${'ab'.repeat(25_000)}`;
    t.app.db.run('INSERT INTO expense (transaction_date, category, description, amount, account_idx) VALUES (?, NULL, ?, 5, ?)', [
      '2026-01-02',
      description,
      t.ids!.cash,
    ]);
    const { lastInsertRowid: legacyRule } = t.app.db.run(
      `INSERT INTO expense_categorization_rule (description_filter, minimum_amount, maximum_amount, category, exemption, is_corporate)
       VALUES (?, NULL, NULL, 'Legacy', NULL, 0)`,
      [filter],
    );
    // A normal rule that would match the oversized description.
    const normal = await t.api(
      'POST',
      '/api/rules',
      { descriptionFilter: 'zzlegacy', minimumAmount: null, maximumAmount: null, category: 'Legacy', exemption: null, isCorporate: false },
      { token: admin },
    );
    assert.equal(normal.status, 200);

    const t0 = performance.now();
    const list = await t.api('GET', '/api/rules', undefined, { token: admin });
    const one = await t.api('GET', `/api/rules/${legacyRule}`, undefined, { token: admin });
    const elapsed = performance.now() - t0;
    assert.equal(list.status, 200);
    assert.equal(one.status, 200);
    assert.ok(elapsed < 500, `GET /api/rules took ${elapsed.toFixed(0)} ms`);

    const byId = new Map(list.data.map((r: { ruleIdx: number; matchCount: number }) => [r.ruleIdx, r.matchCount]));
    assert.equal(byId.get(legacyRule), 0, 'an over-long legacy filter is not evaluated');
    assert.equal(one.data.matchCount, 0);
    assert.equal(byId.get(normal.data.ruleIdx), 0, 'an over-long legacy description is not counted');
    assert.equal(normal.data.matchCount, 0, 'GET /api/rules/:id agrees');
    const preview = await t.api(
      'POST',
      '/api/rules/preview',
      { descriptionFilter: 'zzlegacy', minimumAmount: null, maximumAmount: null, isCorporate: false },
      { token: admin },
    );
    assert.equal(preview.data.total, 0, 'previews skip over-long legacy descriptions too');

    // Normal-length rows are still counted as before.
    t.app.db.run("INSERT INTO expense (transaction_date, category, description, amount, account_idx) VALUES ('2026-01-03', NULL, 'zzlegacy ok', 5, ?)", [
      t.ids!.cash,
    ]);
    const again = await t.api('GET', `/api/rules/${normal.data.ruleIdx}`, undefined, { token: admin });
    assert.equal(again.data.matchCount, 1);
  });
});
