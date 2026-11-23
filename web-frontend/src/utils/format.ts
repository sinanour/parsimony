// Locale and currency come from the server's configuration (LOCALE / CURRENCY).
let locale = 'en-CA';
let currency = new Intl.NumberFormat(locale, { style: 'currency', currency: 'CAD' });
let percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 });

export function configureFormatting(newLocale: string, currencyCode: string): void {
  try {
    currency = new Intl.NumberFormat(newLocale, { style: 'currency', currency: currencyCode });
    percent = new Intl.NumberFormat(newLocale, { style: 'percent', maximumFractionDigits: 2 });
    locale = newLocale;
  } catch {
    console.warn(`Unsupported LOCALE/CURRENCY (${newLocale}/${currencyCode}); using ${locale}.`);
  }
}

export const formatMoney = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : currency.format(n));

/** Exemption ≤ 1 is a fraction of the amount; > 1 is a fixed dollar amount (see vw_expense). */
export function formatExemption(e: number | null | undefined): string {
  if (e === null || e === undefined) return '—';
  return e <= 1 ? percent.format(e) : currency.format(e);
}

export const EXEMPTION_HELP = 'Between 0 and 1: fraction of the amount (1 = 100%). Above 1: a fixed amount.';

export function parseNumber(s: string): number | null {
  const t = s.replace(/[$,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function pluralize(n: number, word: string, plural = `${word}s`): string {
  return `${n.toLocaleString(locale)} ${n === 1 ? word : plural}`;
}

/** Last four characters, for masking account numbers. */
export function maskAccountNumber(s: string): string {
  return s.length <= 4 ? s : `•••• ${s.slice(-4)}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Derives a reasonable rule filter from a statement description, e.g. "Pizza Palace #1042 Anytown" → "pizza palace". */
export function suggestFilter(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[#*].*$/, '')
    .split(/\s+/)
    .filter((w) => w && !/\d/.test(w));
  return words.slice(0, 2).join(' ') || description.toLowerCase();
}
