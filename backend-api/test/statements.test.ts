import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db';
import { migrate } from '../src/migrations';
import { seedDemoData, type DemoIds } from '../src/services/demo-data';
import { readCsv } from '../src/services/statements/csv';
import { formatForFile } from '../src/services/statements/formats';
import { parseStatementFile } from '../src/services/statements';
import { parseRows, type RowParseContext } from '../src/services/statements/parsers';
import { capwords, pyFloat, strptime } from '../src/services/statements/python-compat';
import type { StatementFormatInput, StatementFormatSettings } from '../../shared/types';
import { ADMIN, startApp, type TestApp } from './helpers';
import { buildPdf, type PdfText } from './pdf-fixture';

describe('python compatibility', () => {
  test('strptime accepts what Python accepts', () => {
    assert.deepEqual(strptime('20260105', '%Y%m%d'), { year: 2026, month: 1, day: 5 });
    assert.deepEqual(strptime('2026-2-5', '%Y-%m-%d'), { year: 2026, month: 2, day: 5 });
    assert.deepEqual(strptime('05-JAN-2026', '%d-%b-%Y'), { year: 2026, month: 1, day: 5 });
    assert.deepEqual(strptime('Sep-30-2026', '%b-%d-%Y'), { year: 2026, month: 9, day: 30 });
    assert.deepEqual(strptime('January 31   2026', '%B %d %Y'), { year: 2026, month: 1, day: 31 });
    assert.deepEqual(strptime('12/31/99', '%m/%d/%y'), { year: 1999, month: 12, day: 31 });
    assert.deepEqual(strptime('2026-01-05 13:45:00', '%Y-%m-%d %H:%M:%S'), { year: 2026, month: 1, day: 5 });
  });
  test('strptime rejects what Python rejects', () => {
    for (const [v, f] of [
      ['2026-02-30', '%Y-%m-%d'],
      ['2026-01-05x', '%Y-%m-%d'],
      [' 2026-01-05', '%Y-%m-%d'],
      ['13/01/2026', '%m/%d/%Y'],
      ['Sept 5 2026', '%b %d %Y'],
      ['', '%Y'],
    ]) {
      assert.equal(strptime(v, f), null, `${v} / ${f}`);
    }
    assert.throws(() => strptime('2026', '%Q'), /not a supported date directive/);
  });
  test('float and capwords', () => {
    assert.equal(pyFloat(' 1_000.5 '), 1000.5);
    assert.equal(pyFloat('1e2'), 100);
    assert.equal(pyFloat('-.5'), -0.5);
    for (const bad of ['', ' ', '1,000', '$5', 'abc', '1.2.3', 'nan', undefined]) assert.equal(pyFloat(bad), null, String(bad));
    assert.equal(capwords('  PIZZA   palace #1042\tANYTOWN '), 'Pizza Palace #1042 Anytown');
  });
});

describe('csv reader', () => {
  test('matches Python csv quoting rules', () => {
    assert.deepEqual(readCsv('a,"b, c","say ""hi""",d"e\r\n\nx,\n"multi\nline",y'), [['a', 'b, c', 'say "hi"', 'd"e'], [], ['x', ''], ['multi\nline', 'y']]);
    assert.deepEqual(readCsv('"ab"cd,e'), [['abcd', 'e']]);
    assert.deepEqual(readCsv('a\tb\t\t', '\t'), [['a', 'b', '', '']]);
    assert.deepEqual(readCsv(''), []);
  });
});

const card: StatementFormatSettings = {
  headerRows: 0,
  columnCount: 4,
  columns: { date: 0, description: 1, debit: 2, credit: 3, account: null, cheque: null },
  headerNames: null,
  dateFormats: ['%Y-%m-%d'],
};
const ctx = (extra: Partial<RowParseContext> = {}): RowParseContext => ({
  fileName: 'test.csv',
  accountForNumber: (n) => ({ '00011-1234567': 1, '00022-7654321': 2 })[n],
  ...extra,
});

describe('row parsers', () => {
  test('card: charges, refunds and skipped card payments', () => {
    const rows = readCsv('2026-01-01,coffee,4.50,\n2026-01-02,REFUND,,10\n2026-01-03,PAYMENT THANK YOU,,500\n2026-01-04,short row\n2026-01-05,bad amount,x,\n2026-02-30,bad date,1,');
    const { records, warnings } = parseRows(rows, 'card', card, ctx({ defaultAccountIdx: 7 }));
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      records.map((r) => [r.transactionDate, r.description, r.amount, r.accountIdx, r.type]),
      [
        ['2026-01-01', 'Coffee', 4.5, 7, 'expense'],
        ['2026-01-02', 'Refund', -10, 7, 'expense'],
      ],
    );
  });
  test('card: a chosen account wins, and no account is a warning', () => {
    const rows = readCsv('2026-01-01,coffee,4.50,');
    assert.equal(parseRows(rows, 'card', card, ctx({ accountIdx: 3, defaultAccountIdx: 7 })).records[0].accountIdx, 3);
    const none = parseRows(rows, 'card', card, ctx());
    assert.equal(none.records.length, 0);
    assert.match(none.warnings[0], /No account for test\.csv/);
  });
  test('card: header rows that the file does not have', () => {
    const r = parseRows(readCsv('only one row'), 'card', { ...card, headerRows: 2 }, ctx({ defaultAccountIdx: 1 }));
    assert.match(r.warnings[0], /empty or has fewer rows/);
  });

  const bank: StatementFormatSettings = {
    headerRows: 0,
    columnCount: 6,
    columns: { account: 0, date: 1, description: 2, cheque: 3, debit: 4, credit: 5 },
    headerNames: null,
    dateFormats: ['%d-%b-%Y', '%Y-%m-%d'],
  };
  test('bank: deposits, withdrawals, cheques, income and unknown accounts', () => {
    const rows = readCsv(
      'Account,Date,Description,Cheque,Debit,Credit\n' +
        '00011-1234567,05-Jan-2026,CHEQUE,123,250.00,\n' +
        '000 11-1234567,2026-01-06,PAYROLL DEPOSIT ACME,,,4200\n' +
        '00022-7654321,2026-01-07,INTEREST PAID,,,1.23\n' +
        '00022-7654321,2026-01-08,E-TRANSFER,,,50\n' +
        '99999-0001111,2026-01-08,SOMEONE ELSE,,10,\n',
    );
    const { records, warnings } = parseRows(rows, 'bank', bank, ctx());
    assert.deepEqual(
      records.map((r) => [r.type, r.description, r.amount, r.accountIdx, r.incomeAmount]),
      [
        ['expense', 'Cheque #123', 250, 1, null],
        ['deposit', 'Payroll Deposit Acme', 4200, 1, 4200],
        ['deposit', 'Interest', 1.23, 2, 1.23],
        ['deposit', 'E-transfer', 50, 2, 0],
      ],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /…1111 were skipped/);
    assert.ok(!warnings[0].includes('Account'), 'the header row is not reported as an account number');
  });
  test('bank: header detection and a signed amount column', () => {
    const settings: StatementFormatSettings = {
      ...bank,
      columnCount: null,
      columns: { account: null, date: null, description: null, cheque: null, debit: null, credit: null },
      headerNames: { account: 'unique id', date: 'Date', description: 'Description', debit: 'Amount' },
    };
    const rows = readCsv('Balance, Unique ID ,Date,Description,Amount\n1,00011-1234567,05-Jan-2026,GROCER,-45\n1,00011-1234567,06-Jan-2026,REFUND,5\n');
    const { records } = parseRows(rows, 'bank', settings, ctx());
    assert.deepEqual(records.map((r) => [r.type, r.amount]), [['expense', 45], ['deposit', 5]]);
    const missing = parseRows(readCsv('Date,Description\n'), 'bank', settings, ctx());
    assert.match(missing.warnings[0], /no "unique id" \(account number\), "Amount" \(debit\) column/);
  });
});

describe('statement formats', () => {
  let db: Db;
  let ids: DemoIds;
  before(() => {
    db = new Db(':memory:');
    migrate(db);
    ids = seedDemoData(db);
  });
  after(() => db.close());

  test('the migration seeds the built-in formats', () => {
    assert.ok(db.scalar<number>('SELECT COUNT(*) FROM statement_format') >= 15);
    assert.equal(db.scalar<number>("SELECT COUNT(*) FROM statement_format WHERE file_type = 'pdf'"), 3);
  });
  test('the longest active pattern for the file type wins', () => {
    assert.equal(formatForFile(db, 'BMO Mastercard Jan.csv')?.name, 'BMO Mastercard');
    assert.equal(formatForFile(db, 'bmo chequing.csv')?.name, 'BMO bank account');
    assert.equal(formatForFile(db, 'Coast Capital Savings (All Accounts).csv')?.name, 'Coast Capital (all accounts)');
    assert.equal(formatForFile(db, 'RBC Banking 2026.pdf')?.name, 'RBC bank account (PDF)');
    assert.equal(formatForFile(db, 'RBC Banking 2026.csv')?.name, 'RBC bank account');
    assert.equal(formatForFile(db, 'notes.csv'), undefined);
    db.run("UPDATE statement_format SET is_active = 0 WHERE name = 'BMO Mastercard'");
    assert.equal(formatForFile(db, 'BMO Mastercard Jan.csv')?.name, 'BMO bank account');
    db.run("UPDATE statement_format SET is_active = 1 WHERE name = 'BMO Mastercard'");
  });

  const H = 9;
  test('RBC bank statement PDFs (both page layouts, periods spanning a year end)', async () => {
    const row = (y: number, cells: string[], even = false): PdfText[] =>
      cells.flatMap((t, i) => (t ? [[(even ? [30, 90, 300, 390, 500] : [40, 100, 320, 400, 520])[i], y, H, t] as PdfText] : []));
    const pdf = buildPdf([
      [
        [40, 760, H, 'Your account number:'],
        [320, 760, H, '00011-1234567'],
        [40, 740, H, 'From December 15, 2025 to January 14, 2026'],
        [40, 720, H, 'Total deposits into your account'],
        [400, 720, H, '+ 4,201.23'],
        [40, 705, H, 'Total withdrawals from your account'],
        [320, 705, H, '- 1,165.00'],
        [600, 400, 7, 'ROTATED MARGIN NOTE', [0, 1, -1, 0]],
        ...row(680, ['20 Dec', 'Payroll Deposit ACME', '', '4,200.00', '5,000.00']),
        ...row(665, ['', 'Bill payment', '140.00']),
        ...row(652, ['', 'CITY HYDRO']),
        ...row(640, ['02 Jan', 'Cheque', '1,000.00']),
      ],
      [...row(700, ['10 Jan', 'Interest paid', '', '1.23'], true), ...row(690, ['', 'Service fee', '25.00'], true)],
    ]);
    const r = await parseStatementFile(db, 'RBC Banking Jan.pdf', pdf);
    assert.equal(r.formatName, 'RBC bank account (PDF)');
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(
      r.records.map((x) => [x.type, x.transactionDate, x.description, x.amount, x.accountIdx]),
      [
        ['deposit', '2025-12-20', 'Payroll Deposit Acme', 4200, ids.chequing],
        ['expense', '2025-12-20', 'Bill Payment', 140, ids.chequing],
        ['expense', '2026-01-02', 'Cheque', 1000, ids.chequing],
        ['deposit', '2026-01-10', 'Interest', 1.23, ids.chequing],
        ['expense', '2026-01-10', 'Service Fee', 25, ids.chequing],
      ],
    );
  });

  test('RBC Visa statement PDFs, with totals that do not reconcile', async () => {
    const row = (y: number, cells: string[]): PdfText[] => cells.flatMap((t, i) => (t ? [[[40, 95, 140, 320][i], y, H, t] as PdfText] : []));
    const pdf = buildPdf([
      [
        [10, 770, 6, 'STATEMENT FROM'],
        [95, 770, H, 'DEC 15'],
        [150, 770, H, 'TO JAN 14, 2026'],
        ...row(760, ['', '', 'Purchases & debits', '$1,054.50']),
        ...row(750, ['', '', 'Interest', '$12.34']),
        ...row(680, ['DEC 16', 'DEC 17', 'COFFEE SHOP', '4.50']),
        ...row(668, ['DEC 18', 'DEC 19', 'PAYMENT - THANK YOU', '-500.00']),
        ...row(656, ['JAN 05', 'JAN 06', 'AIRLINE TICKET', '']),
        ...row(645, ['', '', 'FLIGHT 123', '1,000.00']),
      ],
      [...row(700, ['JAN 10', 'JAN 11', 'GROCER', '50.00'])],
    ]);
    const r = await parseStatementFile(db, 'RBC Personal Visa Jan.pdf', pdf, { defaultAccountIdx: ids.personalVisa });
    assert.deepEqual(
      r.records.map((x) => [x.transactionDate, x.description, x.amount]),
      [
        ['2025-12-17', 'Coffee Shop', 4.5],
        ['2026-01-06', 'Airline Ticket', 1000],
        ['2026-01-11', 'Grocer', 50],
      ],
    );
    assert.ok(r.warnings.some((w) => /lists \$1066\.84 in withdrawals, but the transactions found add up to \$1054\.50/.test(w)), r.warnings.join('\n'));
    assert.ok(r.warnings.some((w) => /couldn't find the statement's total deposits/.test(w)));
  });

  test('RBC Visa statement PDFs with the period in one cell and dates run into descriptions', async () => {
    const pdf = buildPdf([
      [
        // The period as one run, with side-panel text on the same row.
        [10, 770, H, 'STATEMENT FROM FEB 17 TO MAR 16, 2026'],
        [400, 770, H, 'rbc.com/creditcardhelp.'],
        [400, 760, H, 'Payments & credits'],
        [520, 760, H, '-$500.00'],
        [400, 750, H, 'Purchases & debits'],
        [520, 750, H, '$40.00'],
        [40, 680, H, 'FEB 17'],
        [95, 680, H, 'FEB 20'],
        [140, 680, H, 'SAFEWAY'],
        [320, 680, H, '$3.98'],
        // Both dates and the description in the first cell, as the bold payment line comes out.
        [40, 668, H, 'FEB 17 FEB 18 PAYMENT - THANK YOU'],
        [320, 668, H, '-$500.00'],
        // The posting date and description in the second cell.
        [40, 656, H, 'FEB 27'],
        [95, 656, H, 'MAR 02 DOLLARAMA # 705'],
        [320, 656, H, '$36.02'],
      ],
    ]);
    const r = await parseStatementFile(db, 'RBC Personal Visa Mar.pdf', pdf, { defaultAccountIdx: ids.personalVisa });
    assert.deepEqual(
      r.records.map((x) => [x.transactionDate, x.description, x.amount]),
      [
        ['2026-02-20', 'Safeway', 3.98],
        ['2026-03-02', 'Dollarama # 705', 36.02],
      ],
    );
    assert.deepEqual(r.warnings, []);
  });

  test('unreadable PDFs and unknown file names are warnings, not errors', async () => {
    const bad = await parseStatementFile(db, 'RBC Banking broken.pdf', Buffer.from('not a pdf'));
    assert.match(bad.warnings[0], /could not be read as a PDF/);
    const unknown = await parseStatementFile(db, 'mystery.csv', Buffer.from('a,b'));
    assert.equal(unknown.formatName, null);
    assert.match(unknown.warnings[0], /No statement format matches "mystery\.csv"/);
  });
});

describe('statement formats API', () => {
  let t: TestApp;
  let token = '';
  const api = <T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => t.api<T>(method, url, body, { token, headers });
  before(async () => {
    t = await startApp();
    token = (await t.login(ADMIN.email, ADMIN.password)).token;
  });
  after(() => t.close());

  const custom: StatementFormatInput = {
    name: 'Example Credit Union',
    fileNamePattern: 'example cu',
    fileType: 'csv',
    parser: 'bank',
    settings: {
      headerRows: 1,
      columnCount: 5,
      columns: { account: 0, date: 1, description: 2, debit: 3, credit: 4, cheque: null },
      headerNames: { date: 'ignored for fixed columns' },
      dateFormats: ['%m/%d/%Y'],
    },
    pdfLayout: null,
    isActive: true,
  };

  test('lists formats and PDF layouts', async () => {
    const list = await api('GET', '/api/statement-formats');
    assert.equal(list.status, 200);
    assert.ok(list.data.some((f: any) => f.name === 'RBC Personal Visa' && f.settings.columnCount === 3));
    const layouts = await api('GET', '/api/statement-formats/pdf-layouts');
    assert.deepEqual(layouts.data.map((l: any) => l.id).sort(), ['rbc-bank-statement', 'rbc-visa-statement']);
  });

  let id = 0;
  test('creates a format, which then drives imports', async () => {
    const res = await api('POST', '/api/statement-formats', custom);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    id = res.data.statementFormatIdx;
    assert.equal(res.data.settings.headerNames, null, 'header names are dropped for fixed columns');

    const csv = 'Acct,Date,Memo,Out,In\n00011-1234567,01/15/2026,PAYROLL DEPOSIT X,,99.00\n00011-1234567,01/16/2026,GROCER,12.00,\n';
    const parsed = await api('POST', '/api/import/parse', Buffer.from(csv), { 'X-File-Name': encodeURIComponent('Example CU Jan.csv'), 'Content-Type': 'application/octet-stream' });
    assert.equal(parsed.status, 200, JSON.stringify(parsed.data));
    assert.equal(parsed.data.formatName, 'Example Credit Union');
    assert.deepEqual(parsed.data.records.map((r: any) => [r.type, r.amount, r.incomeAmount]), [['deposit', 99, 99], ['expense', 12, null]]);
  });

  test('validates settings and rejects duplicate patterns', async () => {
    const bad = (patch: object) => api('POST', '/api/statement-formats', { ...custom, fileNamePattern: 'other', ...patch });
    assert.equal((await bad({ settings: { ...custom.settings!, columns: { ...custom.settings!.columns, account: null } } })).status, 400);
    assert.equal((await bad({ settings: { ...custom.settings!, columns: { ...custom.settings!.columns, credit: 5 } } })).status, 400);
    assert.equal((await bad({ settings: { ...custom.settings!, dateFormats: ['%Q'] } })).status, 400);
    assert.equal((await bad({ fileType: 'pdf', pdfLayout: null })).status, 400);
    assert.equal((await bad({ fileType: 'pdf', pdfLayout: 'no-such-layout' })).status, 400);
    assert.equal((await api('POST', '/api/statement-formats', { ...custom, fileNamePattern: ' EXAMPLE CU ' })).status, 409);
    // The same pattern is fine for the other file type; PDF formats keep no CSV settings.
    const pdf = await api('POST', '/api/statement-formats', { ...custom, fileType: 'pdf', pdfLayout: 'rbc-visa-statement' });
    assert.equal(pdf.status, 200, JSON.stringify(pdf.data));
    assert.equal(pdf.data.settings, null);
    assert.equal(pdf.data.parser, null);
  });

  test('updates and deletes', async () => {
    const upd = await api('PUT', `/api/statement-formats/${id}`, { ...custom, name: 'Renamed', isActive: false });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.isActive, false);
    assert.equal((await api('DELETE', `/api/statement-formats/${id}`)).status, 204);
    assert.equal((await api('GET', `/api/statement-formats/${id}`)).status, 404);
  });
});

// Optional: compare with the original Python parser on real statements (nothing is written):
//   LEGACY_STATEMENT_PARSER=/path/to/statement_parser.py STATEMENT_SAMPLES=/dir/of/statements PARITY_DB=/path/to/real.sqlite npm test
// The database supplies the account numbers bank statements are matched against. Card statements use
// the account whose statement file pattern matches, as in the app. PYTHON selects the interpreter.
const LEGACY = process.env.LEGACY_STATEMENT_PARSER;
const SAMPLES = process.env.STATEMENT_SAMPLES;
const PARITY_DB = process.env.PARITY_DB;
describe('statement parser parity with statement_parser.py', { skip: !(LEGACY && SAMPLES && PARITY_DB) && 'set LEGACY_STATEMENT_PARSER, STATEMENT_SAMPLES and PARITY_DB' }, () => {
  test('every sample parses to the same records', async () => {
    const { accountForFileName } = await import('../src/services/importer');
    // Work on a migrated copy, so the real database is never touched.
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parsimony-parity-')), 'parity.sqlite');
    fs.copyFileSync(PARITY_DB!, copy);
    const db = new Db(copy);
    migrate(db);
    const key = (r: any) =>
      [r.type, r.transaction_date ?? r.transactionDate, r.description, Number(r.amount).toFixed(2), r.account_idx ?? r.accountIdx, Number(r.income_amount ?? r.incomeAmount ?? 0).toFixed(2)].join(' | ');
    const diffs: string[] = [];
    try {
      for (const name of fs.readdirSync(SAMPLES!).filter((f) => /\.(csv|pdf)$/i.test(f))) {
        const file = path.join(SAMPLES!, name);
        const fallback = accountForFileName(db, name);
        const args = ['-I', LEGACY!, '--db', copy, '--json', ...(fallback ? ['--default_account_idx', String(fallback)] : []), file];
        const legacy = JSON.parse(execFileSync(process.env.PYTHON ?? 'python3', args, { encoding: 'utf8' })).records.map(key);
        const ours = (await parseStatementFile(db, name, fs.readFileSync(file), { defaultAccountIdx: fallback })).records.map(key);
        if (legacy.join('\n') !== ours.join('\n')) {
          diffs.push(`${name}: ${legacy.length} vs ${ours.length} records`);
          diffs.push(...legacy.filter((x: string) => !ours.includes(x)).slice(0, 3).map((x: string) => `  only legacy: ${x}`));
          diffs.push(...ours.filter((x) => !legacy.includes(x)).slice(0, 3).map((x) => `  only ours:   ${x}`));
        }
      }
    } finally {
      db.close();
    }
    assert.equal(diffs.length, 0, diffs.join('\n'));
  });
});
