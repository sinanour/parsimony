import type { Db } from '../../db';
import { readCsv } from './csv';
import { formatForFile } from './formats';
import { parseRows, type ParsedRecord } from './parsers';
import { PDF_LAYOUTS } from './pdf-layouts';

export interface StatementParseResult {
  formatName: string | null;
  records: ParsedRecord[];
  warnings: string[];
}

export interface StatementParseOptions {
  /** The account chosen in the UI. */
  accountIdx?: number;
  /** For card statements when no account was chosen: the account whose statement file pattern matched. */
  defaultAccountIdx?: number;
}

/** Parses a CSV or PDF statement with the statement format its file name selects. Nothing is written. */
export async function parseStatementFile(db: Db, fileName: string, content: Buffer, opts: StatementParseOptions = {}): Promise<StatementParseResult> {
  const format = formatForFile(db, fileName);
  if (!format) {
    return {
      formatName: null,
      records: [],
      warnings: [`No statement format matches "${fileName}". Add one under Statement formats, or rename the file so its name contains a format's pattern.`],
    };
  }

  let rows: string[][];
  const warnings: string[] = [];
  let parser = format.parser;
  let settings = format.settings;
  if (format.fileType === 'pdf') {
    const layout = PDF_LAYOUTS[format.pdfLayout!];
    if (!layout) return { formatName: format.name, records: [], warnings: [`${format.name}: unknown PDF layout "${format.pdfLayout}".`] };
    let extracted;
    try {
      extracted = await layout.extract(new Uint8Array(content), fileName);
    } catch (e) {
      return { formatName: format.name, records: [], warnings: [`${fileName} could not be read as a PDF: ${e instanceof Error ? e.message : e}`] };
    }
    rows = extracted.rows;
    warnings.push(...extracted.warnings);
    parser = layout.parser;
    settings = layout.settings;
  } else {
    const text = new TextDecoder('utf-8').decode(content).replace(/^\uFEFF/, '');
    rows = readCsv(text);
  }

  const accountForNumber = (n: string) => db.get<{ account_idx: number }>('SELECT account_idx FROM account_num WHERE account_no = ? LIMIT 1', [n])?.account_idx;
  const result = parseRows(rows, parser!, settings!, { fileName, accountIdx: opts.accountIdx, defaultAccountIdx: opts.defaultAccountIdx, accountForNumber });
  warnings.push(...result.warnings);
  if (result.records.length === 0 && warnings.length === 0) {
    warnings.push(`No transactions were found in ${fileName}. Check that the file matches the "${format.name}" statement format.`);
  }
  return { formatName: format.name, records: result.records, warnings };
}
