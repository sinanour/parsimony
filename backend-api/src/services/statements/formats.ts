import { z } from 'zod';
import { bool, type Db } from '../../db';
import { conflict, notFound } from '../../http';
import type { PdfLayoutInfo, StatementColumns, StatementFormat, StatementFormatInput } from '../../../../shared/types';
import { PDF_LAYOUT_IDS, PDF_LAYOUTS } from './pdf-layouts';
import { compileDateFormat } from './python-compat';

const column = z.number().int().min(0).max(199).nullable();
const COLUMN_KEYS = ['date', 'description', 'debit', 'credit', 'account', 'cheque'] as const satisfies readonly (keyof StatementColumns)[];

const settingsSchema = z.object({
  headerRows: z.number().int().min(0).max(100),
  columnCount: z.number().int().min(1).max(200).nullable(),
  columns: z.object({ date: column, description: column, debit: column, credit: column, account: column, cheque: column }),
  headerNames: z
    .object(Object.fromEntries(COLUMN_KEYS.map((k) => [k, z.string().trim().max(200).optional()])) as Record<(typeof COLUMN_KEYS)[number], z.ZodOptional<z.ZodString>>)
    .nullable(),
  dateFormats: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(100)
        .superRefine((f, ctx) => {
          try {
            compileDateFormat(f);
          } catch (e) {
            ctx.addIssue({ code: 'custom', message: (e as Error).message });
          }
          if (!/%[dbBmYy]/.test(f)) ctx.addIssue({ code: 'custom', message: 'needs at least a day, month or year directive' });
        }),
    )
    .min(1, 'Add at least one date format')
    .max(10),
});

export const statementFormatInput = z
  .object({
    name: z.string().trim().min(1, 'is required').max(200),
    fileNamePattern: z.string().trim().min(2, 'needs at least 2 characters').max(200),
    fileType: z.enum(['csv', 'pdf']),
    parser: z.enum(['card', 'bank']).nullable(),
    settings: settingsSchema.nullable(),
    pdfLayout: z.enum(PDF_LAYOUT_IDS).nullable(),
    isActive: z.boolean(),
  })
  .superRefine((f, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (f.fileType === 'pdf') {
      if (!f.pdfLayout) issue(['pdfLayout'], 'Choose a PDF layout');
      return;
    }
    if (!f.parser) issue(['parser'], 'Choose how rows are read');
    const s = f.settings;
    if (!s) return issue(['settings'], 'is required');
    const needed: (keyof StatementColumns)[] = ['date', 'description', ...(f.parser === 'bank' ? (['account'] as const) : [])];
    if (s.columnCount === null) {
      const names = s.headerNames ?? {};
      for (const k of needed) if (!names[k] && s.columns[k] === null) issue(['settings', 'headerNames', k], 'Enter the column title');
      if (!names.debit && !names.credit && s.columns.debit === null && s.columns.credit === null) {
        issue(['settings', 'headerNames', 'debit'], 'Enter the amount column title');
      }
      return;
    }
    for (const k of needed) if (s.columns[k] === null) issue(['settings', 'columns', k], 'Choose a column');
    if (s.columns.debit === null && s.columns.credit === null) issue(['settings', 'columns', 'debit'], 'Choose an amount column');
    for (const k of COLUMN_KEYS) {
      const c = s.columns[k];
      if (c !== null && c >= s.columnCount) issue(['settings', 'columns', k], `is past the last column (the format has ${s.columnCount})`);
    }
  })
  .transform((f): StatementFormatInput =>
    f.fileType === 'pdf'
      ? { ...f, parser: null, settings: null }
      : { ...f, pdfLayout: null, settings: { ...f.settings!, headerNames: f.settings!.columnCount === null ? f.settings!.headerNames : null } },
  );

export const pdfLayoutInfo = (): PdfLayoutInfo[] => Object.values(PDF_LAYOUTS).map(({ id, label, description }) => ({ id, label, description }));

function fromRow(r: Record<string, unknown>): StatementFormat {
  return {
    statementFormatIdx: Number(r.statement_format_idx),
    name: String(r.name),
    fileNamePattern: String(r.file_name_pattern),
    fileType: r.file_type as StatementFormat['fileType'],
    parser: (r.parser ?? null) as StatementFormat['parser'],
    settings: r.settings ? JSON.parse(String(r.settings)) : null,
    pdfLayout: (r.pdf_layout ?? null) as StatementFormat['pdfLayout'],
    isActive: bool(r.is_active),
  };
}

export function listFormats(db: Db): StatementFormat[] {
  return db.all('SELECT * FROM statement_format ORDER BY file_type, lower(name)').map(fromRow);
}

export function getFormat(db: Db, id: number): StatementFormat {
  const r = db.get('SELECT * FROM statement_format WHERE statement_format_idx = ?', [id]);
  if (!r) throw notFound('Statement format');
  return fromRow(r);
}

function assertPatternFree(db: Db, f: StatementFormatInput, id?: number) {
  const clash = db.get<{ name: string }>(
    `SELECT name FROM statement_format WHERE file_type = ? AND lower(trim(file_name_pattern)) = lower(?) AND statement_format_idx IS NOT ?`,
    [f.fileType, f.fileNamePattern, id ?? null],
  );
  if (clash) throw conflict(`"${clash.name}" already uses the ${f.fileType.toUpperCase()} file name pattern "${f.fileNamePattern}".`);
}

const columnsOf = (f: StatementFormatInput) => [f.name, f.fileNamePattern, f.fileType, f.parser, f.settings ? JSON.stringify(f.settings) : null, f.pdfLayout, f.isActive];

export function createFormat(db: Db, f: StatementFormatInput): StatementFormat {
  assertPatternFree(db, f);
  const { lastInsertRowid } = db.run(
    'INSERT INTO statement_format (name, file_name_pattern, file_type, parser, settings, pdf_layout, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
    columnsOf(f),
  );
  return getFormat(db, lastInsertRowid);
}

export function updateFormat(db: Db, id: number, f: StatementFormatInput): StatementFormat {
  getFormat(db, id);
  assertPatternFree(db, f, id);
  db.run(
    'UPDATE statement_format SET name = ?, file_name_pattern = ?, file_type = ?, parser = ?, settings = ?, pdf_layout = ?, is_active = ? WHERE statement_format_idx = ?',
    [...columnsOf(f), id],
  );
  return getFormat(db, id);
}

export function deleteFormat(db: Db, id: number): void {
  getFormat(db, id);
  db.run('DELETE FROM statement_format WHERE statement_format_idx = ?', [id]);
}

/** The active format for a file: same file type, pattern contained in the name (ignoring case); the longest pattern wins. */
export function formatForFile(db: Db, fileName: string): StatementFormat | undefined {
  const ext = fileName.toLowerCase().endsWith('.pdf') ? 'pdf' : 'csv';
  const name = fileName.toLowerCase();
  return db
    .all(
      `SELECT * FROM statement_format WHERE is_active = 1 AND file_type = ?
       ORDER BY length(trim(file_name_pattern)) DESC, statement_format_idx`,
      [ext],
    )
    .map(fromRow)
    .find((f) => name.includes(f.fileNamePattern.trim().toLowerCase()));
}
