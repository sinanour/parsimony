// Finding 7: read-only users must never receive full card or bank numbers, wherever they are embedded
// (account names, payee account numbers, descriptions, confirmations), nor be able to confirm masked
// digits through searches. All numbers below are synthetic.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, startApp, type TestApp } from './helpers';
import { redactDigits } from '../src/redact';

let t: TestApp;
let admin = '';
let editor = '';
let reader = '';

const CARD = '4929 0001 2345 6781'; // spaces, in a personal card's name
const CORP_CARD = '5500987654321098'; // undelimited, corporate card
const BANK = '0812 3456-789'; // space and dash, 11 digits
const CORP_BANK = '123-456789-012'; // dashes, 12 digits
const OLD_BANK = '9876543210'; // 10 digits
const PAYEE_NUMS = ['7777123456789012', '31415926535', '2718281', '123456'];
const DESC_CARD = '6011000990139424';
const DEP_BANK = '0055 4433-221';
const CONF = '8888777766665555';
const SEEDED = [CARD, CORP_CARD, BANK, CORP_BANK, OLD_BANK, ...PAYEE_NUMS.slice(0, 3), DESC_CARD, DEP_BANK, CONF];

const digits = (s: string) => s.replace(/[ -]/g, '');

let expenseId = 0;
let depositId = 0;
let paymentId = 0;

async function createUser(email: string, role: string): Promise<string> {
  const password = `${role.toLowerCase()}-password-1`;
  const res = await t.api('POST', '/api/users', { email, password, role, displayName: null }, { token: admin });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return (await t.login(email, password)).token;
}

/** Fails if `body` reveals any seeded number beyond its last four digits, or any 11+ digit run. */
function assertNoNumbers(where: string, body: string): void {
  assert.doesNotMatch(body, /\d{11,}/, `${where} contains an 11+ digit run`);
  const flat = digits(body);
  for (const n of SEEDED) {
    const d = digits(n);
    for (let i = 0; i + 7 <= d.length; i++) {
      assert.ok(!flat.includes(d.slice(i, i + 7)), `${where} reveals digits of a seeded number (${d.length}-digit, window ${i})`);
    }
  }
}

before(async () => {
  t = await startApp();
  admin = (await t.login(ADMIN.email, ADMIN.password)).token;
  editor = await createUser('editor@example.test', 'EDITOR');
  reader = await createUser('reader@example.test', 'READ_ONLY');

  const db = t.app.db;
  const ids = t.ids!;
  const name = (id: number, n: string) => db.run('UPDATE account SET name = name || ? WHERE account_idx = ?', [` (${n})`, id]);
  const numbers = (id: number, n: string) => db.run('INSERT INTO account_num (account_idx, account_no) VALUES (?, ?)', [id, digits(n)]);
  for (const [id, n] of [
    [ids.personalVisa, CARD],
    [ids.businessVisa, CORP_CARD],
    [ids.chequing, BANK],
    [ids.businessChequing, CORP_BANK],
    [ids.oldCard, OLD_BANK],
  ] as const) {
    name(id, n);
    numbers(id, n);
  }
  const payees = db.all<{ payee_idx: number }>('SELECT payee_idx FROM payee ORDER BY payee_idx');
  PAYEE_NUMS.forEach((n, i) =>
    i < payees.length
      ? db.run('UPDATE payee SET account_num = ? WHERE payee_idx = ?', [n, payees[i].payee_idx])
      : db.run("INSERT INTO payee (payee, account_num, is_active, payee_category, payment_period) VALUES (?, ?, 1, 'Utilities', 1)", [`Payee ${i}`, n]),
  );
  // Statements embed numbers in descriptions too; the corporate one shows up in the corporate report.
  expenseId = db.run("INSERT INTO expense (transaction_date, description, amount, account_idx) VALUES (date('now', '-3 day'), ?, 12.5, ?)", [
    `Returned cheque Account Number ${DESC_CARD}`,
    ids.personalVisa,
  ]).lastInsertRowid;
  db.run("INSERT INTO expense (transaction_date, description, amount, account_idx, category) VALUES (date('now', '-3 day'), ?, 8642097, ?, 'Office')", [
    `Transfer to ${DESC_CARD}`,
    ids.businessVisa,
  ]);
  depositId = db.run(
    "INSERT INTO deposit (transaction_date, description, amount, income_amount, reviewed, account_idx) VALUES (date('now', '-2 day'), ?, 50, 0, 0, ?)",
    [`Credit Fr_${DEP_BANK}`, ids.chequing],
  ).lastInsertRowid;
  paymentId = db.run("INSERT INTO payment (payee_idx, transaction_date, amount, confirmation, account_idx) VALUES (?, date('now', '-1 day'), 80, ?, ?)", [
    ids.hydro,
    `CONF ${CONF}`,
    ids.chequing,
  ]).lastInsertRowid;
  for (const range of ['huquq', 'corporate']) {
    const res = await t.api('PUT', `/api/reports/${range}/range`, { startDate: '2000-01-01', endDate: '2100-01-01' }, { token: admin });
    assert.equal(res.status, 200);
  }
});
after(() => t.close());

/** Every GET route the router knows, with its path parameters filled in from the seeded data. */
function readUrls(): string[] {
  const one = (sql: string) => t.app.db.scalar<number>(sql);
  const params: Record<string, () => number> = {
    '/api/accounts/:id': () => t.ids!.personalVisa,
    '/api/payees/:id': () => t.ids!.hydro,
    '/api/payments/:id': () => paymentId,
    '/api/payments/defaults/:payeeIdx': () => t.ids!.hydro,
    '/api/expenses/:id': () => expenseId,
    '/api/deposits/:id': () => depositId,
    '/api/rules/:id': () => one('SELECT MIN(expense_categorization_rule_idx) FROM expense_categorization_rule'),
    '/api/statement-formats/:id': () => one('SELECT MIN(statement_format_idx) FROM statement_format'),
  };
  const urls: string[] = [];
  for (const r of t.app.router.list()) {
    if (r.method !== 'GET' || r.access === 'admin') continue;
    if (r.keys.length === 0) urls.push(r.pattern);
    else {
      const id = params[r.pattern];
      assert.ok(id, `new GET route ${r.pattern}: add its parameters to readUrls() so it is crawled`);
      urls.push(r.pattern.replace(/:[a-zA-Z]+/, String(id())));
    }
  }
  return urls.concat([
    '/api/reports/corporate?format=csv',
    '/api/expenses?pageSize=500&sort=accountName',
    '/api/expenses?pageSize=500&scope=corporate',
    '/api/deposits?pageSize=500&sort=accountName',
    '/api/payments?pageSize=500&sort=payerAccountName',
    '/api/reports/spending?startDate=1900-01-01&endDate=2099-12-31&grouping=year',
    '/api/reports/spending?startDate=1900-01-01&endDate=2099-12-31&grouping=year&scope=corporate',
  ]);
}

describe('read-only users never receive full account numbers', () => {
  test('only auth routes opt out of redaction', () => {
    const optedOut = t.app.router.list().filter((r) => !r.redact && r.access !== 'admin');
    for (const r of optedOut) assert.match(r.pattern, /^\/api\/(auth\/|config$)/, `${r.method} ${r.pattern} skips read-only redaction`);
  });

  test('the whole GET surface (and the corporate CSV) is masked for READ_ONLY', async () => {
    const urls = readUrls();
    assert.ok(urls.length > 25, `only ${urls.length} URLs`);
    for (const url of urls) {
      const res = await t.api('GET', url, undefined, { token: reader });
      assert.equal(res.status, 200, `${url} returned ${res.status}`);
      assertNoNumbers(url, typeof res.data === 'string' ? res.data : JSON.stringify(res.data));
    }
  });

  test('read-only POSTs (rule preview and dry run) and errors are masked too', async () => {
    const calls: [string, unknown][] = [
      ['/api/rules/preview', { descriptionFilter: '%', minimumAmount: null, maximumAmount: null, isCorporate: false }],
      ['/api/rules/preview', { descriptionFilter: '%', minimumAmount: null, maximumAmount: null, isCorporate: true }],
      ['/api/rules/run', { scope: 'personal', dryRun: true }],
      ['/api/rules/run', { scope: 'corporate', dryRun: true }],
    ];
    for (const [url, body] of calls) {
      const res = await t.api('POST', url, body, { token: reader });
      assert.equal(res.status, 200, `${url} returned ${res.status}`);
      assertNoNumbers(url, JSON.stringify(res.data));
    }
  });

  test('names keep their last four digits and the rest of the text', async () => {
    const a = (await t.api('GET', `/api/accounts/${t.ids!.personalVisa}`, undefined, { token: reader })).data;
    assert.match(a.name, /\(••••6781\)$/);
    assert.ok(a.accountNumbers.includes('••••6781'));
    assert.ok(a.accountNumbers.every((n: string) => n.startsWith('••••')));
    const bank = (await t.api('GET', `/api/accounts/${t.ids!.chequing}`, undefined, { token: reader })).data;
    assert.match(bank.name, /\(••••6789\)$/);
    const payees = (await t.api('GET', '/api/payees', undefined, { token: reader })).data as { accountNum: string }[];
    for (const p of payees) assert.ok(p.accountNum.length <= 4 || p.accountNum.startsWith('••••'), 'payee accountNum is masked');
    assert.ok(payees.some((p) => p.accountNum === '••••3456'), 'even short payee account numbers are masked');
    const p = (await t.api('GET', `/api/payees/${t.ids!.hydro}`, undefined, { token: reader })).data;
    assert.ok(p.accountNum.startsWith('••••'));
  });

  test('the corporate CSV keeps amounts and dates for READ_ONLY', async () => {
    const csv = (await t.api('GET', '/api/reports/corporate?format=csv', undefined, { token: reader })).data as string;
    assert.match(csv, /,-?8642097,/, 'a seven-digit amount is not mistaken for an account number');
    assert.match(csv, /Transfer to ••••9424/);
    assert.match(csv, /\d{4}-\d{2}-\d{2}/);
  });

  test('editors and administrators still receive the full numbers', async () => {
    for (const token of [editor, admin]) {
      const a = (await t.api('GET', `/api/accounts/${t.ids!.personalVisa}`, undefined, { token })).data;
      assert.ok(a.name.endsWith(`(${CARD})`));
      assert.ok(a.accountNumbers.includes(digits(CARD)));
      const payees = JSON.stringify((await t.api('GET', '/api/payees', undefined, { token })).data);
      for (const n of PAYEE_NUMS) assert.ok(payees.includes(`"${n}"`));
      const meta = JSON.stringify((await t.api('GET', '/api/meta', undefined, { token })).data);
      assert.ok(meta.includes(BANK) && meta.includes(CORP_BANK));
      const csv = (await t.api('GET', '/api/reports/corporate?format=csv', undefined, { token })).data as string;
      assert.ok(csv.includes(DESC_CARD) && !csv.includes('••••'));
      const exp = JSON.stringify((await t.api('GET', `/api/expenses/${expenseId}`, undefined, { token })).data);
      assert.ok(exp.includes(DESC_CARD) && exp.includes(CARD));
      const pay = JSON.stringify((await t.api('GET', `/api/payments/${paymentId}`, undefined, { token })).data);
      assert.ok(pay.includes(CONF) && pay.includes(BANK));
    }
  });
});

describe('read-only searches cannot confirm masked digits', () => {
  const total = async (token: string, url: string) => {
    const res = await t.api('GET', url, undefined, { token });
    assert.equal(res.status, 200);
    return res.data.total as number;
  };
  const preview = async (token: string, descriptionFilter: string) => {
    const res = await t.api('POST', '/api/rules/preview', { descriptionFilter, minimumAmount: null, maximumAmount: null, isCorporate: false }, { token });
    assert.equal(res.status, 200);
    return res.data.total as number;
  };
  const hidden = DESC_CARD.slice(0, 8);

  test('expense / deposit / payment q matches only the text a reader sees', async () => {
    assert.equal(await total(reader, `/api/expenses?q=${hidden}`), 0);
    assert.ok((await total(editor, `/api/expenses?q=${hidden}`)) >= 1);
    // What the reader is shown still matches.
    assert.ok((await total(reader, `/api/expenses?q=${encodeURIComponent('••••9424')}`)) >= 1);
    assert.ok((await total(reader, '/api/expenses?q=9424')) >= 1);

    assert.equal(await total(reader, '/api/deposits?q=00554'), 0);
    assert.equal(await total(reader, `/api/deposits?q=${encodeURIComponent('0055 4433')}`), 0);
    assert.ok((await total(editor, '/api/deposits?q=0055')) >= 1);

    assert.equal(await total(reader, `/api/payments?q=${CONF.slice(0, 6)}`), 0);
    assert.ok((await total(editor, `/api/payments?q=${CONF.slice(0, 6)}`)) >= 1);
    // LIKE wildcards don't help either: the masked run is always four bullets.
    assert.equal(await total(reader, `/api/payments?q=${encodeURIComponent('CONF 8%5555')}`), 0);
  });

  test('rule previews match a reader’s filter against redacted descriptions', async () => {
    assert.equal(await preview(reader, hidden), 0);
    assert.ok((await preview(editor, hidden)) >= 1);
    assert.equal(await preview(reader, `%Number 6011%`), 0);
    assert.ok((await preview(reader, 'Number ••••9424')) >= 1);
  });
});

describe('redactDigits', () => {
  test('masks card and bank numbers in their usual spellings', () => {
    assert.equal(redactDigits('Visa (4929 0001 2345 6781)'), 'Visa (••••6781)');
    assert.equal(redactDigits('BMO (0812 3456-789)'), 'BMO (••••6789)');
    assert.equal(redactDigits('HSBC (123-456789-012)'), 'HSBC (••••9012)');
    assert.equal(redactDigits('Air Can*1234567890123'), 'Air Can*••••0123');
    assert.equal(redactDigits('Store 1234567'), 'Store ••••4567');
    assert.equal(redactDigits('1234-56-789012'), '••••9012');
  });
  test('leaves dates, timestamps, amounts, short numbers and round bounds alone', () => {
    for (const s of ['2026-11-25', '2026-11-25 10:20:30 UTC', '2026-11-25T10:20:30.123Z', '1234.56', '123456', 'Pharmacy #12', 'amount >= -2000000000', '••••6781'])
      assert.equal(redactDigits(s), s);
    assert.equal(redactDigits('2026-11-25 1234567'), '2026-11-25 ••••4567');
  });
});
