/** A text item drawn in Helvetica: x, y (baseline, points from the bottom-left), font size, text, and an optional rotation matrix [a, b, c, d]. */
export type PdfText = [x: number, y: number, size: number, text: string, matrix?: [number, number, number, number]];

/** Builds a minimal PDF with one page (612×792 pt) per entry, for statement-parser tests. */
export function buildPdf(pages: PdfText[][]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((items, i) => {
    const content = items
      .map(([x, y, size, text, m]) => `BT /F1 ${size} Tf ${m ? `${m.join(' ')} ${x} ${y} Tm` : `${x} ${y} Td`} (${esc(text)}) Tj ET\n`)
      .join('');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`);
    objs.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
