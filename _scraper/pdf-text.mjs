/* ---------------------------------------------------------------------------
   Operations Academia — the words in a PDF, as lines.

   Most of what the POMS job postings page links to is a PDF the school
   uploaded (347 of 381 postings on 2026-09-23), and a PDF is what the
   advert pipeline has always recorded as `unreadable`. This reads one with
   pdf.js (`pdfjs-dist`, the same engine Firefox renders PDFs with), which
   the crawler's workflow installs beside firebase-admin. The dependency is
   loaded LAZILY and its absence is an answer, not an error: a machine
   without it — this build environment, the PR check — gets `null` from
   `pdfjs()` and the crawler queues the posting with what the POMS table
   itself said. Nothing here may be a reason a run fails.

   THE TEXT COMES OUT IN READING ORDER, one line per baseline. pdf.js hands
   back positioned glyph runs, not lines, so runs are grouped by their
   baseline (the transform's y, within a couple of points) and sorted by x
   inside a line, with a space where two runs do not touch. A two-column
   advertisement interleaves its columns line by line; that is accepted, and
   the text parser (advert-text.mjs) reads labelled facts line by line, so a
   deadline still reads as a deadline.
   --------------------------------------------------------------------------- */

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Is this the start of a PDF? A byte order mark or a little whitespace
    before the magic is tolerated, as the readers tolerate it. */
export function looksLikePdf(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  return b.subarray(0, 16).toString('latin1').includes('%PDF');
}

/** Where pdfjs-dist keeps its standard fonts, or ''. Handed to the engine so
    a PDF that names Helvetica without embedding it is read without the
    engine warning on every page. */
export function standardFontDir() {
  try {
    return path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  } catch {
    return '';
  }
}

/** Is the engine installed here? Synchronous, so a run can say so up front. */
export function pdfjsInstalled() {
  try { require.resolve('pdfjs-dist/package.json'); return true; } catch { return false; }
}

let engine;   // undefined: not tried; null: absent; else the module
export async function pdfjs() {
  if (engine !== undefined) return engine;
  try {
    engine = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    engine = null;
  }
  return engine;
}

/**
 * The lines of one page from pdf.js's text items. Pure, so the selftest can
 * drive it on made-up items: runs on one baseline join into a line, lines
 * come out top to bottom, and two runs that touch are joined without a
 * space (a word pdf.js split at a kerning pair) while runs apart get one.
 */
export function linesFromItems(items) {
  const runs = [];
  for (const it of items || []) {
    if (!it || typeof it.str !== 'string') continue;
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    const str = it.str;
    if (!str.trim()) continue;
    runs.push({ str, x: +t[4] || 0, y: +t[5] || 0, w: +it.width || 0 });
  }
  runs.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  let cur = null;
  for (const r of runs) {
    if (cur && Math.abs(cur.y - r.y) <= 2.5) {
      cur.runs.push(r);
    } else {
      cur = { y: r.y, runs: [r] };
      lines.push(cur);
    }
  }
  return lines.map((l) => {
    l.runs.sort((a, b) => a.x - b.x);
    let out = '';
    let end = null;
    for (const r of l.runs) {
      if (end !== null && r.x - end > 1.5 && !/\s$/.test(out) && !/^\s/.test(r.str)) out += ' ';
      out += r.str;
      end = r.x + r.w;
    }
    return out.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
}

/**
 * The text of a PDF: `{ ok, text, pages, error }`. `ok` is false — and the
 * caller treats the advertisement as unreadable — when the engine is absent,
 * the bytes are not a PDF, or the document cannot be opened; a scanned PDF
 * (images of text, no text layer) opens fine and yields nothing, which is
 * reported as `ok: false` too, since there is nothing to read.
 */
export async function pdfText(bytes, { maxPages = 15 } = {}) {
  if (!looksLikePdf(bytes)) return { ok: false, text: '', pages: 0, error: 'not a PDF' };
  const lib = await pdfjs();
  if (!lib) return { ok: false, text: '', pages: 0, error: 'pdfjs-dist is not installed' };

  let doc = null;
  try {
    const data = new Uint8Array(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    const fonts = standardFontDir();
    doc = await lib.getDocument({
      data,
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
      ...(fonts ? { standardFontDataUrl: fonts } : {}),
    }).promise;
    const pages = [];
    const n = Math.min(doc.numPages, Math.max(1, maxPages));
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push(linesFromItems(tc.items).join('\n'));
    }
    const text = pages.filter(Boolean).join('\n\n');
    return { ok: !!text.trim(), text, pages: doc.numPages,
             error: text.trim() ? '' : 'the PDF has no text layer' };
  } catch (e) {
    return { ok: false, text: '', pages: 0, error: e && e.message ? e.message : String(e) };
  } finally {
    if (doc) await doc.destroy().catch(() => {});
  }
}
