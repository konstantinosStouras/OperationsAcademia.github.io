#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — import the old Google Sheet into v2/data/jobs.json.

   The migration path. The existing postings live in the "Job Postings" Google
   Sheet (id 1YgTajXa5W1r4Ekm2zkFGQoQFNiE3C82l4_54aMYizok), which has three
   tabs:

     jobsData   the Awesome Table DISPLAY view — 28 columns, with a control row
                under the header holding StringFilter / CategoryFilter / etc.
     (template) the Awesome Table card template and CSS
     rawData    the raw Google Form responses — 19 columns, including the exact
                apply-by DATE that the display tab only keeps as prose

   This reads a CSV export of EITHER tab and emits rows in the shape defined by
   jobs-model.mjs. Giving it both is better: the display tab is the source of
   truth for what is currently shown (including which posting is Featured), and
   the raw tab supplies the exact deadline date.

       # in Google Sheets: File > Download > Comma-separated values, per tab
       node v2/_scraper/import-sheet.mjs \
            --display jobsData.csv --raw rawData.csv --out v2/data/jobs.json

   PRIVACY. The raw tab carries the submitter's e-mail address and the
   department chair's. This repository is public, so neither is ever written
   out — the model's PUBLIC_FIELDS list is the gate, and the check at the end
   fails the import if one slips through anyway.

   Why a CSV rather than the Sheets API: the export needs no credentials, no
   network from CI, and no continuing access to the account. The migration is a
   one-off; making it depend on a live API would be a standing liability.
   --------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  text, url, day, jobId, publicRow, serialise, displayOrder, buildMeta,
  LEVELS, CHARACTERISTICS, TYPES, longDate, pickList,
} from './jobs-model.mjs';

/* --------------------------------------------------------------- CSV parse */

/** RFC 4180: quoted fields, "" escapes, newlines inside quotes. */
export function parseCsv(input) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(input).replace(/^\ufeff/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** The <a href="..">label</a> the display tab stores in its link columns. */
export function anchor(cell) {
  const s = String(cell || '').trim();
  if (!s || /^(na|n\/a|-)$/i.test(s)) return { url: '', label: '' };
  const href = s.match(/href\s*=\s*"([^"]+)"/i);
  const label = s.match(/>([^<]*)<\/a>/i);
  if (href) return { url: url(href[1]), label: text(label ? label[1] : 'link', 60) };
  return { url: url(s), label: 'link' };
}

/** The form's long checkbox wording -> the short chips the site shows. */
const CHAR_MAP = [
  [/research seminars/i, 'Research seminars'],
  [/phd/i, 'PhD'],
  [/master/i, 'Masters'],
  [/mba/i, 'MBA'],
  [/undergrad/i, 'Undergrad'],
  [/exec/i, 'Exec Ed'],
];

export function shortCharacteristics(cell) {
  const s = String(cell || '');
  const out = [];
  for (const [re, short] of CHAR_MAP) if (re.test(s) && !out.includes(short)) out.push(short);
  return out;
}

export function splitLevels(cell) {
  return pickList(String(cell || '').split(',').map((x) => x.trim()), LEVELS);
}

/* ------------------------------------------------------------- the mapping */

function header(rows) {
  // The display tab has an Awesome Table control row directly under the
  // header ("Hidden", "CategoryFilter - Hidden", "CardsContent", …). Skip it,
  // or the first posting imported would be that row of filter keywords.
  const head = rows[0].map((h) => text(h, 120));
  const looksLikeControl = (r) => {
    const vals = r.filter(Boolean).map(String);
    return vals.length > 2 &&
      vals.every((v) => /Filter|Hidden|CardsContent|^$/i.test(v));
  };
  const body = looksLikeControl(rows[1] || []) ? rows.slice(2) : rows.slice(1);
  const index = {};
  head.forEach((h, i) => { if (h && !(h in index)) index[h] = i; });
  return { head, index, body, hadControlRow: looksLikeControl(rows[1] || []) };
}

function pick(row, index, names) {
  for (const n of names) if (n in index) return row[index[n]] ?? '';
  return '';
}

function tsDay(v) {
  // "7/15/2019 7:54:45" — the Forms timestamp
  return day(String(v || '').split(' ')[0]);
}

export function rowsFromSheets(displayRows, rawRows) {
  const D = displayRows ? header(displayRows) : null;
  const R = rawRows ? header(rawRows) : null;

  // index the raw responses so a display row can borrow its exact deadline
  const rawBy = new Map();
  if (R) {
    for (const r of R.body) {
      const ts = tsDay(pick(r, R.index, ['Timestamp']));
      const inst = text(pick(r, R.index, ['University Name/ Institution', 'University/Institution']), 200);
      if (inst) rawBy.set(ts + '|' + inst.toLowerCase(), r);
    }
  }

  const source = D || R;
  if (!source) throw new Error('give at least one of --display or --raw');

  const out = [];
  const seen = new Set();
  let unmatched = 0;

  for (const row of source.body) {
    const idx = source.index;
    const institution = text(
      pick(row, idx, ['University/Institution', 'University Name/ Institution']), 160);
    if (!institution) continue;

    const posted = tsDay(pick(row, idx, ['Job posted on (MM/ DD/ YY)', 'Timestamp']));
    const raw = D ? rawBy.get(posted + '|' + institution.toLowerCase()) : row;
    if (D && !raw) unmatched++;

    const department = text(
      pick(row, idx, ['Department', 'School Name, Department/Area/Group Name']), 220);
    const typeRaw = text(pick(row, idx, ['Type', 'Type of Institution']), 40);
    const type = TYPES.includes(typeRaw) ? typeRaw : '';
    const country = text(
      pick(row, idx, ['Location', 'Country location of the University']), 60);
    const levels = splitLevels(pick(row, idx, ['Entry level', 'Job entry level']));

    // the display tab holds the deadline as prose; the raw tab as a date
    const applyProse = text(pick(row, idx, ['Apply by (month, DD, YYYY)', 'Apply by (comments)']), 400);
    let applyByDate = raw && R ? day(pick(raw, R.index, ['Apply by (exact date is required)'])) : '';
    if (!applyByDate) applyByDate = day(applyProse);

    const applyBy = applyProse ||
      (applyByDate ? longDate(applyByDate) : 'Until filled.');

    const ad = anchor(pick(row, idx, ['File link']));
    const on = anchor(pick(row, idx, ['Posted online at']));
    const fi = anchor(pick(row, idx, ['Further info']));

    // fall back to the raw tab's plain URLs where the display cell said "NA"
    const adUrl = ad.url ||
      (raw && R ? url(pick(raw, R.index, ['(optional) PDF upload'])) : '');
    const onUrl = on.url ||
      (raw && R ? url(pick(raw, R.index, ['(optional) Posted online at'])) : '');

    const characteristics = shortCharacteristics(
      (raw && R
        ? pick(raw, R.index, ['Does your Institution have any of the following? Please check all that apply.'])
        : '') || pick(row, idx, ['Characteristics']));

    let year = parseInt(text(pick(row, idx, ['Job Market Year']), 8), 10);
    if (!(year >= 2000 && year <= 2100)) {
      // the sheet holds one typo'd "200"; fall back to the posting date
      year = posted ? Number(posted.slice(0, 4)) + 1 : 0;
    }

    const rec = {
      id: '',
      year,
      posted,
      institution,
      department,
      type,
      levels,
      applyBy,
      applyByDate,
      comments: text(pick(row, idx, ['Comments on Job Posting']), 1200)
        .replace(/^(NA|N\/A)$/i, ''),
      country,
      adUrl,
      adLabel: ad.label || 'link to Job ad',
      postedAtUrl: onUrl,
      postedAtLabel: on.label || 'link',
      furtherInfoUrl: fi.url ||
        `https://www.operationsacademia.org/universities?filterA=${encodeURIComponent(institution)}`,
      characteristics,
      featured: String(pick(row, idx, ['Featured'])).trim() === '1',
      source: 'sheet-import',
      addedAt: posted ? posted + 'T00:00:00Z' : '',
    };

    rec.id = jobId(rec);
    let id = rec.id, n = 2;
    while (seen.has(id)) id = `${rec.id}-${n++}`;
    rec.id = id;
    seen.add(id);

    out.push(rec);
  }

  out.sort(displayOrder);
  return { rows: out, unmatched };
}

/* ------------------------------------------------------------------- main */

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }

  const displayPath = arg('--display');
  const rawPath = arg('--raw');
  const outPath = arg('--out', 'v2/data/jobs.json');
  const dry = process.argv.includes('--dry-run');

  if (!displayPath && !rawPath) {
    console.log(`Usage:
  node v2/_scraper/import-sheet.mjs --display jobsData.csv [--raw rawData.csv]
                                    [--out v2/data/jobs.json] [--dry-run]

Export each tab from Google Sheets with File > Download > Comma-separated
values. Giving both tabs is recommended: the display tab says what is shown
today (including which posting is Featured), the raw tab supplies the exact
apply-by date.`);
    process.exit(1);
  }

  for (const p of [displayPath, rawPath].filter(Boolean)) {
    if (!existsSync(p)) { console.error(`no such file: ${p}`); process.exit(1); }
  }

  const display = displayPath ? parseCsv(await readFile(displayPath, 'utf8')) : null;
  const raw = rawPath ? parseCsv(await readFile(rawPath, 'utf8')) : null;

  const { rows, unmatched } = rowsFromSheets(display, raw);
  const published = rows.map(publicRow);

  console.log(`imported ${published.length} postings`);
  if (unmatched) console.log(`  ${unmatched} display row(s) had no matching form response`);
  console.log(`  ${published.filter((r) => r.adUrl).length} with a job-ad link`);
  console.log(`  ${published.filter((r) => r.postedAtUrl).length} with an advertisement link`);
  console.log(`  ${published.filter((r) => r.applyByDate).length} with a parsed deadline`);
  console.log(`  ${published.filter((r) => r.featured).length} featured`);

  const blob = JSON.stringify(published);
  if (/@[a-z0-9-]+\.[a-z]{2,}/i.test(blob)) {
    console.error('::error::an e-mail address reached the output — refusing to write');
    process.exit(1);
  }

  if (dry) { console.log('--dry-run: not writing.'); return; }
  await writeFile(outPath, serialise(rows));
  await writeFile(outPath.replace(/jobs\.json$/, 'jobs-meta.json'),
    JSON.stringify(buildMeta(published, { generated: new Date().toISOString() }), null, 1) + '\n');
  console.log(`wrote ${outPath}`);
}

/* --------------------------------------------------------------- selftest */

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, w) => { if (c) pass++; else fails.push(w); };

  eqArr(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']], 'plain CSV');
  eqArr(parseCsv('a,b\n"x,y",2'), [['a', 'b'], ['x,y', '2']], 'a quoted comma');
  eqArr(parseCsv('a\n"he said ""hi"""'), [['a'], ['he said "hi"']], 'escaped quotes');
  eqArr(parseCsv('a,b\n"line\none",2'), [['a', 'b'], ['line\none', '2']], 'a newline inside quotes');
  eqArr(parseCsv('\ufeffa,b\n1,2'), [['a', 'b'], ['1', '2']], 'a byte-order mark is stripped');

  function eqArr(a, b, w) {
    ok(JSON.stringify(a) === JSON.stringify(b),
      `${w}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`);
  }

  const a = anchor('<a href="https://x.edu/ad" target="_blank">link to Job ad</a>');
  ok(a.url === 'https://x.edu/ad' && a.label === 'link to Job ad', 'anchor cell');
  ok(anchor('NA').url === '', '"NA" is not a link');
  ok(anchor('<a href="javascript:alert(1)">x</a>').url === '', 'a javascript: anchor is dropped');
  ok(anchor('https://x.edu/y').url === 'https://x.edu/y', 'a bare URL cell');

  eqArr(shortCharacteristics(
    'Research seminars, PhD Program in Operations, MBA Program with Operations related courses'),
    ['Research seminars', 'PhD', 'MBA'], 'the form wording maps to the short chips');
  eqArr(splitLevels('Assistant Professor, Other Ranks'),
    ['Assistant Professor', 'Other Ranks'], 'levels split');
  eqArr(splitLevels('Assistant Professor, Dean'), ['Assistant Professor'],
    'an unknown level is dropped');

  // the control row under the header must not become a posting
  const display = parseCsv([
    // the header carries a comma inside a name, so it must be quoted — exactly
    // as Google Sheets exports it
    '"Job posted on (MM/ DD/ YY)","Job Market Year","Type","University/Institution",' +
      '"Department","Entry level","Apply by (month, DD, YYYY)","Location","Featured"',
    'Hidden,Hidden,CategoryFilter - Hidden,StringFilter,Hidden,csvFilter - Hidden,Hidden,Hidden,Hidden',
    '8/6/2025 8:42:07,2026,Business School,CUHK Business School,Dept of DOT,' +
      '"Assistant Professor, Other Ranks","December 31, 2025",Hong Kong,1',
  ].join('\n'));
  const res = rowsFromSheets(display, null);
  ok(res.rows.length === 1, 'the Awesome Table control row is not imported as a posting');
  const r = res.rows[0];
  ok(r.institution === 'CUHK Business School', 'institution imported');
  ok(r.featured === true, 'the Featured flag is imported');
  ok(r.applyByDate === '2025-12-31', 'a prose deadline is parsed to a date');
  ok(r.id === '2026-cuhk-business-school-20250806', 'the id matches the live path');
  ok(!('email' in publicRow(r)), 'no private field is emitted');

  if (fails.length) {
    console.log(`\n${fails.length} FAILED, ${pass} passed`);
    for (const f of fails) console.log('  FAIL  ' + f);
    return false;
  }
  console.log(`import-sheet selftest: ${pass} checks passed`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
