import type { PdfLayoutId, StatementFormatSettings, StatementParserKind } from '../../../../shared/types';
import { readCsv } from './csv';
import { extractTabbedText, type TabStops } from './pdf-text';
import { isoDate, pyFloat, splitlines, strptime, type PyDate } from './python-compat';

/**
 * A built-in PDF layout: bank-specific code that turns a statement into rows, plus the CSV settings
 * those rows are then read with. Layouts need code (they find statement periods and totals), so they
 * can't be defined in the database; statement formats pick one by id.
 */
export interface PdfLayout {
  id: PdfLayoutId;
  label: string;
  description: string;
  parser: StatementParserKind;
  settings: StatementFormatSettings;
  extract(data: Uint8Array, fileName: string): Promise<{ rows: string[][]; warnings: string[] }>;
}

const LONG_US = '%B %d %Y';
const SHORT_US = '%b %d %Y';

const money = (n: number) => n.toFixed(2);
const cmp = (a: PyDate, b: PyDate) => isoDate(a).localeCompare(isoDate(b));
const round2 = (n: number) => Math.round(n * 100) / 100;
/** The statement text with commas and dollar signs removed, as tab-separated rows. */
const tabRows = (text: string) => splitlines(text.replaceAll(',', '').replaceAll('$', '')).map((l) => readCsv(l, '\t')[0] ?? []);
const reread = (lines: string[][]) => lines.map((cells) => readCsv(cells.join('\t'), '\t')[0] ?? []);

function totalsWarnings(fileName: string, rowCount: number, withdrawals: [number | null, number], deposits: [number | null, number]): string[] {
  const out: string[] = [];
  if (rowCount === 0) out.push(`${fileName}: no transactions were found in this statement.`);
  for (const [label, [expected, found]] of [
    ['withdrawals', withdrawals],
    ['deposits', deposits],
  ] as const) {
    const total = round2(found);
    if (expected === null) out.push(`${fileName}: couldn't find the statement's total ${label}; found $${money(total)} in transactions.`);
    else if (total !== expected) out.push(`${fileName}: the statement lists $${money(expected)} in ${label}, but the transactions found add up to $${money(total)}.`);
  }
  return out;
}

const RBC_BANK_STOPS: TabStops = { oddPages: [80, 300, 370, 500], evenPages: [60, 280, 370, 480], rowSnap: 8 };

/** RBC chequing/savings statements: account number, "From … to …" period, then date / description / withdrawals / deposits / balance. */
const rbcBankStatement: PdfLayout = {
  id: 'rbc-bank-statement',
  label: 'RBC bank account statement',
  description: 'RBC chequing and savings PDF statements. The account number is read from the statement.',
  parser: 'bank',
  settings: {
    headerRows: 0,
    columnCount: 5,
    columns: { account: 0, date: 1, description: 2, cheque: null, debit: 3, credit: 4 },
    headerNames: null,
    dateFormats: ['%Y-%m-%d'],
  },
  async extract(data, fileName) {
    const text = await extractTabbedText(data, RBC_BANK_STOPS);
    const out: string[][] = [];
    let start: PyDate | null = null;
    let end: PyDate | null = null;
    let txDate: PyDate | null = null;
    let accountNum: string | null = null;
    let expectedDeposits: number | null = null;
    let expectedWithdrawals: number | null = null;
    let deposits = 0;
    let withdrawals = 0;

    for (const row of tabRows(text)) {
      const values = row.filter(Boolean);
      if (values.length >= 2) {
        const first = values.slice(0, -1).join('').toLowerCase();
        const last = values.at(-1)!;
        if (accountNum === null && first.endsWith('account number:')) accountNum = last;
        if (expectedDeposits === null && first.startsWith('total deposits ')) expectedDeposits = pyFloat(last.replaceAll('+', ''));
        if (expectedWithdrawals === null && (first.startsWith('total withdrawals from your account') || first.startsWith('total cheques & debits'))) {
          expectedWithdrawals = pyFloat(last.replaceAll('-', ''));
        }
      }
      if (start === null || end === null) {
        // The tab stops sometimes split the period mid-word, so try the cells joined both ways.
        for (const sep of ['', ' ']) {
          const s = values.join(sep);
          if (s.startsWith('From ') && s.includes(' to ')) {
            const rest = s.slice(5);
            const at = rest.indexOf(' to ');
            start = strptime(rest.slice(0, at), LONG_US);
            end = strptime(rest.slice(at + 4), LONG_US);
            if (start && end) break;
          }
        }
      }
      if (start && end && accountNum) {
        for (const year of [end.year, start.year]) {
          const dt = strptime(`${row[0] ?? ''} ${year}`, '%d %b %Y');
          if (!dt) break;
          if (cmp(start, dt) <= 0 && cmp(dt, end) <= 0) {
            txDate = dt;
            break;
          }
        }
      }
      if (txDate && row.length > 2 && row[1]) {
        const w = pyFloat(row[2]) ?? 0;
        const d = row.length > 3 ? (pyFloat(row[3]) ?? 0) : 0;
        if (w || d) {
          out.push([accountNum!, isoDate(txDate), ...row.slice(1), ''].slice(0, 5));
          withdrawals += w;
          deposits += d;
        }
      }
    }
    return { rows: reread(out), warnings: totalsWarnings(fileName, out.length, [expectedWithdrawals, withdrawals], [expectedDeposits, deposits]) };
  },
};

const RBC_VISA_STOPS: TabStops = { oddPages: [88, 124, 300, 370, 500], evenPages: [88, 124, 300, 370, 500], rowSnap: 4 };
/** "STATEMENT FROM NOV 17 TO DEC 18 2023" (commas already removed); the start may carry its own year. */
const TX_LEAD = /^([A-Z]{3} \d{1,2}) +([A-Z]{3} \d{1,2}) +(\S.*)$/;
const PERIOD = /STATE ?MENT FROM ([A-Z]{3} \d{1,2}(?: \d{4})?) TO ([A-Z]{3} \d{1,2} \d{4})/;

/** RBC Visa statements: "STATEMENT FROM … TO …" period, then transaction date / posting date / description / amount. */
const rbcVisaStatement: PdfLayout = {
  id: 'rbc-visa-statement',
  label: 'RBC Visa statement',
  description: 'RBC personal and business Visa PDF statements. Choose the card account when importing, or set its statement file pattern.',
  parser: 'card',
  settings: {
    headerRows: 0,
    columnCount: 3,
    columns: { account: null, date: 0, description: 1, cheque: null, debit: 2, credit: 2 },
    headerNames: null,
    dateFormats: ['%Y-%m-%d'],
  },
  async extract(data, fileName) {
    const text = await extractTabbedText(data, RBC_VISA_STOPS);
    const out: string[][] = [];
    const warnings: string[] = [];
    let start: PyDate | null = null;
    let end: PyDate | null = null;
    let txDate: PyDate | null = null;
    let description: string | null = null;
    let expectedDeposits: number | null = null;
    let expectedWithdrawals: number | null = null;
    let deposits = 0;
    let withdrawals = 0;

    for (const row of tabRows(text)) {
      // The dates and description are sometimes one text run (often the bold payment line), landing in one cell:
      // "MAR 18 MAR 19 PAYMENT - THANK YOU" in the first, or "MAR 02 DOLLARAMA …" in the second. Split them back out.
      const merged = TX_LEAD.exec(row.slice(0, 3).filter(Boolean).join(' '));
      if (merged) row.splice(0, 3, merged[1], merged[2], merged[3]);
      const values = row.filter(Boolean);
      if (values.length >= 2) {
        const label = values.at(-2)!;
        const value = values.at(-1)!;
        if (expectedDeposits === null && label.startsWith('Payments & credits')) expectedDeposits = pyFloat(value.replaceAll('-', ''));
        if (expectedWithdrawals === null) {
          if (label.startsWith('Purchases & debits')) expectedWithdrawals = pyFloat(value);
        } else if (['Cash advances', 'Interest', 'Fees'].includes(label.trim())) {
          const extra = pyFloat(value);
          if (extra === null) warnings.push(`${fileName}: couldn't read the statement's ${label.trim().toLowerCase()} total ("${value.trim()}").`);
          else expectedWithdrawals = round2(expectedWithdrawals + extra);
        }
      }
      if (start === null) {
        // The period may be one cell or split across several, and text from the side panel can share its row.
        const period = PERIOD.exec(values.join(' ').replace(/\s+/g, ' '));
        if (period) {
          const [, from, to] = period;
          end = strptime(to, SHORT_US);
          if (from.length < 7 && end) {
            // "DEC 15 TO JAN 14, 2026": the start has no year, and may be in the previous one.
            start = strptime(`${from} ${end.year}`, SHORT_US);
            if (start && cmp(start, end) > 0) start = strptime(`${from} ${end.year - 1}`, SHORT_US);
          } else {
            start = strptime(from, SHORT_US);
          }
          // The period line's "JAN 15" cell would otherwise read as a posting date.
          continue;
        }
      }
      if (start && end && row.length > 3) {
        for (const year of [end.year, start.year]) {
          const dt = strptime(`${row[1]} ${year}`, SHORT_US);
          if (!dt) break;
          if (cmp(start, dt) <= 0 && cmp(dt, end) <= 0) {
            txDate = dt;
            description = row[2];
            break;
          }
        }
      }
      if (txDate && description && row.length >= 4) {
        const amount = pyFloat(row[3]) ?? 0;
        if (amount) {
          out.push([isoDate(txDate), description, row[3]]);
          txDate = null;
          description = null;
          if (amount > 0) withdrawals += amount;
          else deposits -= amount;
        }
      }
    }
    warnings.push(...totalsWarnings(fileName, out.length, [expectedWithdrawals, withdrawals], [expectedDeposits, deposits]));
    return { rows: reread(out), warnings };
  },
};

export const PDF_LAYOUTS: Record<PdfLayoutId, PdfLayout> = {
  'rbc-bank-statement': rbcBankStatement,
  'rbc-visa-statement': rbcVisaStatement,
};

export const PDF_LAYOUT_IDS = Object.keys(PDF_LAYOUTS) as [PdfLayoutId, ...PdfLayoutId[]];
