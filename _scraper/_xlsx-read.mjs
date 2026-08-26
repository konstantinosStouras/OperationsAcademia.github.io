/* ---------------------------------------------------------------------------
   Read an .xlsx back out of its own bytes — for the CHECKS, not for the site.

   `assets/oa-xlsx.js` writes a workbook by hand, so the only honest way to
   assert that a deadline really is a DATE and an advertisement really is a
   clickable link is to open the file the reader receives and look. Both guards
   need that — `selftest.mjs` builds one from the served data, `page-test.mjs`
   downloads one from a real browser — and two copies of a zip reader is exactly
   the drift every shared module in this repository exists to prevent.

   It reads STORE entries only, which is all the writer produces (its header
   says why), so this needs no inflate and no dependency.
   --------------------------------------------------------------------------- */

/**
 * Every entry of a STORE-only zip, as `{ 'path/in/zip': '<xml…>' }`.
 *
 * Read through the CENTRAL DIRECTORY, because that is a zip's authority on
 * what it contains — the local headers are only what a reader skips to, so
 * trusting them alone would not prove the file is navigable.
 */
export function unzipStore(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;                                    // End Of Central Directory
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = Object.create(null);
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0) throw new Error(`${name} is not STOREd`);
    // the local header repeats its own lengths; the data follows them
    const at = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    out[name] = dec.decode(bytes.subarray(at, at + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * One worksheet's cells, as `{ A1: { v, t, s } }` — the value, the cell type
 * (`inlineStr` / `b` / `n`) and the style id, which is what says a number is
 * being drawn as a date.
 */
export function sheetCells(xml) {
  const cells = Object.create(null);
  const re = /<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>|<c r="([A-Z]+\d+)"([^>]*)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const ref = m[1] || m[4];
    const attrs = m[2] || m[5] || '';
    const body = m[3] || '';
    const t = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || 'n';
    const s = (/\bs="([^"]+)"/.exec(attrs) || [])[1] || '0';
    let v;
    if (t === 'inlineStr') {
      v = (/<t[^>]*>([\s\S]*?)<\/t>/.exec(body) || [])[1] || '';
      // the writer's own escapes, undone in the order that cannot double-decode
      v = v.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
           .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    } else {
      v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || '';
    }
    cells[ref] = { v, t, s };
  }
  return cells;
}

/** The last row number a sheet holds a cell in — its row count with the
    header, which is what a "did it write every posting" check compares. */
export function lastRow(cells) {
  const ns = Object.keys(cells).map((r) => Number(r.replace(/^[A-Z]+/, '')));
  return ns.length ? Math.max(...ns) : 0;
}
