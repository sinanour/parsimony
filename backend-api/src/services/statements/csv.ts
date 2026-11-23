/**
 * Reads CSV the way Python's `csv.reader` does with the default (non-strict) "excel" dialect, or
 * "excel-tab" when `delimiter` is a tab: `"` quotes fields, `""` is a literal quote, a quote after the
 * start of an unquoted field is kept as text, and a blank line yields an empty row.
 */
export function readCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  type State = 'startRecord' | 'startField' | 'inField' | 'inQuoted' | 'quoteInQuoted';
  let state: State = 'startRecord';

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRecord = () => {
    rows.push(row);
    row = [];
    state = 'startRecord';
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const newline = c === '\n' || c === '\r';
    if (newline && c === '\r' && text[i + 1] === '\n' && state !== 'inQuoted') i++;
    switch (state) {
      case 'startRecord':
      case 'startField':
        if (state === 'startRecord' && newline) {
          endRecord();
          break;
        }
        if (c === '"') state = 'inQuoted';
        else if (c === delimiter) {
          endField();
          state = 'startField';
        } else if (newline) {
          endField();
          endRecord();
        } else {
          field += c;
          state = 'inField';
        }
        break;
      case 'inField':
        if (c === delimiter) {
          endField();
          state = 'startField';
        } else if (newline) {
          endField();
          endRecord();
        } else field += c;
        break;
      case 'inQuoted':
        if (c === '"') state = 'quoteInQuoted';
        else field += c;
        break;
      case 'quoteInQuoted':
        if (c === '"') {
          field += '"';
          state = 'inQuoted';
        } else if (c === delimiter) {
          endField();
          state = 'startField';
        } else if (newline) {
          endField();
          endRecord();
        } else {
          field += c;
          state = 'inField';
        }
        break;
    }
  }
  if (state !== 'startRecord') {
    endField();
    rows.push(row);
  }
  return rows;
}
