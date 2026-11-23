import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

/**
 * Column boundaries (x positions in points) for turning a statement page into tab-separated text.
 * Odd and even pages can differ because statements often alternate margins.
 */
export interface TabStops {
  oddPages: number[];
  evenPages: number[];
  /** Text whose bottoms fall in the same band of this many points is treated as one row. */
  rowSnap: number;
}

type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

/** pdfminer's page transform: origin at the media box's lower-left corner, honouring /Rotate. */
function pageMatrix(view: number[], rotate: number): Matrix {
  const [x0, y0, x1, y1] = view;
  switch (((rotate % 360) + 360) % 360) {
    case 90:
      return [0, -1, 1, 0, -y0, x1];
    case 180:
      return [-1, 0, 0, -1, x1, y1];
    case 270:
      return [0, 1, -1, 0, y1, -x0];
    default:
      return [1, 0, 0, 1, -x0, -y0];
  }
}

/** A run of text as drawn, with the bounding box pdfminer would give its characters. */
interface Run {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Average character width, standing in for pdfminer's per-character widths. */
  charWidth: number;
  /** Character height (the font size in page units). */
  size: number;
}

interface Line {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  last: Run;
}

// pdfminer's default layout parameters.
const LINE_OVERLAP = 0.5;
const CHAR_MARGIN = 2.0;
const WORD_MARGIN = 0.1;

/** pdfminer's test for whether the next character continues the current text line. */
function continuesLine(a: Run, b: Run): boolean {
  const overlapsVertically = b.y0 <= a.y1 && a.y0 <= b.y1;
  if (!overlapsVertically) return false;
  const vOverlap = Math.abs(Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  if (!(Math.min(a.size, b.size) * LINE_OVERLAP < vOverlap)) return false;
  // Compare the last character of `a` with the first character of `b`.
  const aLeft = a.x1 - a.charWidth;
  const bRight = b.x0 + b.charWidth;
  const hDistance = b.x0 <= a.x1 && aLeft <= bRight ? 0 : Math.min(Math.abs(aLeft - bRight), Math.abs(a.x1 - b.x0));
  return hDistance < Math.max(a.charWidth, b.charWidth) * CHAR_MARGIN;
}

/** Groups runs into text lines the way pdfminer's layout analysis does (consecutive, aligned characters). */
function groupLines(runs: Run[]): Line[] {
  const lines: Line[] = [];
  let line: Line | null = null;
  for (const run of runs) {
    if (line && continuesLine(line.last, run)) {
      // pdfminer inserts a space where the gap is wider than a tenth of a character.
      if (line.x1 < run.x0 - WORD_MARGIN * Math.max(run.charWidth, run.size)) line.text += ' ';
      line.text += run.text;
      line.x0 = Math.min(line.x0, run.x0);
      line.x1 = Math.max(line.x1, run.x1);
      line.y0 = Math.min(line.y0, run.y0);
      line.last = run;
    } else {
      line = { text: run.text, x0: run.x0, x1: run.x1, y0: run.y0, last: run };
      lines.push(line);
    }
  }
  return lines;
}

const tabStopFor = (x: number, stops: number[]) => {
  let lower = 0;
  for (const [i, upper] of stops.entries()) {
    if (lower <= x && x < upper) return i;
    lower = upper;
  }
  return stops.length;
};

/**
 * Extracts a PDF statement as text: one line per visual row (top to bottom), with the text of each
 * column (between tab stops) separated by tabs. Text that isn't upright (e.g. rotated margin notes) is
 * ignored. This is the same grid the original pdfminer-based parser built.
 */
export async function extractTabbedText(data: Uint8Array, stops: TabStops): Promise<string> {
  const task = getDocument({ data, disableFontFace: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const ctm = pageMatrix(page.view, page.rotate);
      const content = await page.getTextContent();
      const runs: Run[] = [];
      for (const item of content.items) {
        const t = item as TextItem;
        // pdfjs adds zero-height spacer items between runs; pdfminer has no such characters.
        if (typeof t.str !== 'string' || t.str === '' || !t.height) continue;
        const [a, b, c, d, e, f] = multiply(t.transform as Matrix, ctm);
        if (!(a * d > 0 && b * c <= 0)) continue;
        const size = Math.abs(d);
        const descent = (content.styles[t.fontName]?.descent ?? 0) * size;
        const chars = [...t.str].length;
        runs.push({ text: t.str, x0: e, x1: e + t.width, y0: f + descent, y1: f + descent + size, charWidth: t.width / chars, size });
      }
      page.cleanup();

      const tabStops = pageNo % 2 === 0 ? stops.evenPages : stops.oddPages;
      const rows = new Map<number, { cells: string[]; rightEdges: (number | null)[] }>();
      for (const line of groupLines(runs)) {
        const text = line.text.trim();
        if (!text) continue;
        const y = line.y0 - (((line.y0 % stops.rowSnap) + stops.rowSnap) % stops.rowSnap);
        let row = rows.get(y);
        if (!row) {
          row = { cells: Array(tabStops.length + 1).fill(''), rightEdges: Array(tabStops.length + 1).fill(null) };
          rows.set(y, row);
        }
        const col = tabStopFor(line.x0, tabStops);
        const right = row.rightEdges[col];
        if (right !== null && line.x0 - right >= 0.5) row.cells[col] += ' ';
        row.cells[col] += text;
        row.rightEdges[col] = line.x1;
      }
      pages.push(
        [...rows.keys()]
          .sort((p, q) => q - p)
          .map((y) => rows.get(y)!.cells.join('\t'))
          .join('\n'),
      );
    }
    return pages.join('\n');
  } finally {
    await task.destroy();
  }
}
