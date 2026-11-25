// Small, exact ports of the Python behaviours the statement parsers were written against, so the
// TypeScript parsers accept and reject the same input as the original statement_parser.py.

export interface PyDate {
  year: number;
  month: number;
  day: number;
}

export const isoDate = (d: PyDate) => `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const alternation = (names: string[]) => [...names].sort((a, b) => b.length - a.length).join('|');

/** Python's `_strptime` regex for each supported directive. Time and weekday fields are matched but ignored. */
const DIRECTIVES: Record<string, string> = {
  d: '(?<d>3[01]|[12]\\d|0[1-9]|[1-9]| [1-9])',
  m: '(?<m>1[0-2]|0[1-9]|[1-9])',
  Y: '(?<Y>\\d\\d\\d\\d)',
  y: '(?<y>\\d\\d)',
  b: `(?<b>${alternation(MONTHS.map((m) => m.slice(0, 3)))})`,
  B: `(?<B>${alternation(MONTHS)})`,
  a: `(?:${alternation(DAYS.map((d) => d.slice(0, 3)))})`,
  A: `(?:${alternation(DAYS)})`,
  H: '(?:2[0-3]|[0-1]\\d|\\d)',
  I: '(?:1[0-2]|0[1-9]|[1-9])',
  M: '(?:[0-5]\\d|\\d)',
  S: '(?:6[0-1]|[0-5]\\d|\\d)',
  p: '(?:am|pm)',
  '%': '%',
};

/** The directives a date format may use, for validation messages. */
export const DATE_DIRECTIVES = Object.keys(DIRECTIVES).filter((k) => k !== '%');

/**
 * Longest date cell matched. Real dates (even "Wed, September 30, 2026 23:59:59 pm", 34) are shorter;
 * longer cells are rejected before any regex runs, which bounds the work a single cell can cause.
 */
export const MAX_DATE_LENGTH = 40;

const compiled = new Map<string, RegExp>();
const MAX_COMPILED = 256;

/**
 * Compiles a strptime format the way CPython does; throws on an unknown or repeated directive.
 *
 * Every directive (except `%%`) may appear at most once, as in Python, where each one is a named group.
 * That is also what keeps matching cheap: the pattern is anchored, each field has at most a handful of
 * alternatives (all of bounded width), and `\s+` runs are never adjacent, so the number of ways a cell can
 * be split is bounded by a small constant whatever the cell holds — no format can backtrack exponentially
 * (e.g. `%Y` followed by 29 `%H`, which alone would take seconds on a 62-character cell).
 */
export function compileDateFormat(format: string): RegExp {
  let re = compiled.get(format);
  if (re) return re;
  let src = '';
  const seen = new Set<string>();
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === '%') {
      const directive = format[++i];
      const part = directive === undefined ? undefined : DIRECTIVES[directive];
      if (part === undefined) throw new Error(`"%${directive ?? ''}" is not a supported date directive`);
      // A directive may appear once (Python raises on redefined groups).
      if (directive !== '%') {
        if (seen.has(directive)) throw new Error(`"%${directive}" appears twice`);
        seen.add(directive);
      }
      src += part;
    } else if (/\s/.test(c)) {
      while (i + 1 < format.length && /\s/.test(format[i + 1])) i++;
      src += '\\s+';
    } else {
      src += c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
    }
  }
  re = new RegExp(`^(?:${src})`, 'i');
  if (compiled.size >= MAX_COMPILED) compiled.clear();
  compiled.set(format, re);
  return re;
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** `datetime.strptime(value, format).date()`, or null where Python would raise. */
export function strptime(value: string, format: string): PyDate | null {
  if (value.length > MAX_DATE_LENGTH) return null;
  const m = compileDateFormat(format).exec(value);
  if (!m || m[0].length !== value.length) return null;
  const g = m.groups ?? {};
  let year = 1900;
  if (g.Y !== undefined) year = Number(g.Y);
  else if (g.y !== undefined) year = Number(g.y) < 69 ? 2000 + Number(g.y) : 1900 + Number(g.y);
  let month = 1;
  if (g.m !== undefined) month = Number(g.m);
  else if (g.B !== undefined) month = MONTHS.indexOf(g.B.toLowerCase()) + 1;
  else if (g.b !== undefined) month = MONTHS.findIndex((n) => n.startsWith(g.b.toLowerCase())) + 1;
  const day = g.d !== undefined ? Number(g.d.trim()) : 1;
  if (year < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

const PY_FLOAT = /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:e[+-]?\d+(?:_\d+)*)?$/i;

/** `float(value)` for decimal input, or null where Python would raise. (inf/nan are rejected.) */
export function pyFloat(value: string | undefined): number | null {
  if (value === undefined) return null;
  const s = value.trim();
  return PY_FLOAT.test(s) ? Number(s.replace(/_/g, '')) : null;
}

/** `string.capwords(s)`: collapse whitespace and capitalize each word. */
export function capwords(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const [first, ...rest] = [...w];
      return first.toUpperCase() + rest.join('').toLowerCase();
    })
    .join(' ');
}

/** `str.splitlines()` (without the trailing empty line a final newline would leave). */
export function splitlines(s: string): string[] {
  const lines = s.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
