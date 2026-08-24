#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — import the three remaining Awesome Table datasets.

   The last vendor tables on the site (universities map, recent faculty, past
   job postings) read four Google Sheets. This importer turns them into the
   site's own committed data files, exactly as import-sheet.mjs once did for
   the jobs list:

     data/universities.json      the map — one row per school, with the
                                 latitude/longitude the sheet already carries
     data/recent-faculty.json    recently hired junior faculty, 2011-2025
     data/past-postings.json     the past job postings ARCHIVE — the
                                 "Past job postings" sheet (market 2015) plus
                                 every market ≤ ARCHIVE_MAX_YEAR from the
                                 "Job Postings" sheet, in the jobs.json row
                                 shape (rowsFromSheets is reused verbatim, so
                                 the two files cannot drift apart)

   Each also gets a small *-meta.json beside it. All three datasets are
   frozen archives — nothing writes them on a schedule — so this runs as a
   one-off (re-run it when the universities sheet gains a school).

   TWO WAYS IN:

     # from hand-exported CSVs (File > Download > CSV, the DISPLAY tab):
     node _scraper/import-legacy-tables.mjs \
          --universities u.csv --recent-faculty rf.csv --past-postings pp.csv \
          [--jobs-display jd.csv --jobs-raw jr.csv] [--out-dir data]

     # straight from the published sheets (needs network to docs.google.com,
     # which GitHub's runners have and the build sandbox does not — this is
     # what .github/workflows/oa-legacy-import.yml runs):
     node _scraper/import-legacy-tables.mjs --fetch [--out-dir data]

   --fetch discovers every tab of every sheet from the sheet's own HTML
   preview (name + gid), downloads each as CSV, and picks tabs by their
   HEADER SIGNATURE rather than by name — a renamed tab cannot break it, and
   a wrong tab cannot be imported by accident. The inventory it found is
   printed either way, so a failed run says what was actually there.

   PRIVACY, same rule as import-sheet.mjs: the raw tabs carry submitter
   e-mail addresses and this repository is public. Free text is redacted,
   only allowlisted fields are written, and the run REFUSES to write if an
   address reaches an output anyway.
   --------------------------------------------------------------------------- */

import { isMain } from './_main.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  parseCsv, redactEmails, anchor, normHeader, header, pick, arg,
} from './import-sheet.mjs';
import { rowsFromSheets, stampAddedAt } from './import-sheet.mjs';
import {
  text, url, day, slug, buildMeta, keyOf, healPlace, canonColumns, canonInstitution,
} from './jobs-model.mjs';

/* ------------------------------------------------------------- the sheets */

export const SHEETS = {
  universities: '1aW8z50zk98vmsrt6llJySvPH2ID0s0GtT_4Xh-J0rMw',   // List of Universities
  recentFaculty: '16j0bQulL7jWIpajmVRzlJZmz6rf8k_r7z_4enfXBAuk',  // Recent Faculty in Operations (Responses)
  pastPostings: '1d0_XxHBYKFEvYDQWEJzIipFmvAo5w9t4jd1hEHTgDzs',   // Past job postings
  jobs: '1YgTajXa5W1r4Ekm2zkFGQoQFNiE3C82l4_54aMYizok',           // Job Postings (the jobs.json sheet)
};

/* The archive's upper market year. Markets ≥ 2026 belong to data/jobs.json
   (the live pipeline); everything at or below this year is history and lives
   in past-postings.json. previous-markets.html ALSO folds in whatever
   jobs.json rows have fallen out of the jobs page's own market window, so
   when the season rolls each July the newly-past market appears there by
   itself — this constant never needs to move. */
export const ARCHIVE_MAX_YEAR = 2025;

/* ------------------------------------------------- tab discovery (--fetch) */

/** Tab names + gids out of a sheet's /htmlpreview page. Two patterns, because
    the markup has changed before: the sheet-button list items, and any
    #gid= anchor with visible text. */
export function parseHtmlPreviewTabs(html) {
  const s = String(html || '');
  const out = [];
  const seen = new Set();
  const push = (gid, name) => {
    if (!/^\d+$/.test(gid) || seen.has(gid)) return;
    seen.add(gid);
    out.push({ gid, name: text(name, 100) });
  };
  let m;
  const btn = /id="sheet-button-(\d+)"[^>]*>\s*<a[^>]*>([^<]*)</g;
  while ((m = btn.exec(s))) push(m[1], m[2]);
  const anchorRx = /href="[^"]*#gid=(\d+)"[^>]*>([^<]*)</g;
  while ((m = anchorRx.exec(s))) push(m[1], m[2]);
  return out;
}

async function fetchText(u, what) {
  const res = await fetch(u, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return res.text();
}

/** Every tab of a sheet, as parsed CSV. Anonymous read — the sheets are
    link-readable (the vendor's own embed read them the same way).

    Discovery tries the three HTML renderings Google has served over the
    years — /htmlview (the classic multi-tab "HTML view"), /pubhtml (the
    published-to-the-web variant) and /htmlpreview — and takes the first one
    that yields a tab list. A rendering that exists but parses to nothing is
    fine to fall through: gid 0 always exists, and classifyTab() decides by
    header signature whether a downloaded tab is used, so discovery can only
    ever MISS a tab, never import a wrong one. */
export async function fetchAllTabs(id, what) {
  let tabs = [];
  const tried = [];
  for (const view of ['htmlview', 'pubhtml', 'htmlpreview']) {
    let preview = '';
    try {
      preview = await fetchText(
        `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/${view}`,
        `${what} ${view}`);
    } catch (e) {
      tried.push(e.message);
      continue;
    }
    if (/accounts\.google\.com|type="password"/i.test(preview)) {
      throw new Error(`${what}: Google answered a sign-in page — the sheet is not link-readable`);
    }
    tabs = parseHtmlPreviewTabs(preview);
    if (tabs.length) break;
    tried.push(`${view}: no tab markup`);
  }
  if (!tabs.length) {
    console.log(`::warning::${what}: no tab list could be discovered ` +
      `(${tried.join('; ')}) — falling back to the first tab only`);
    tabs = [{ gid: '0', name: '(first tab)' }];
  }
  const out = [];
  for (const t of tabs) {
    let csv = '';
    try {
      csv = await fetchText(
        `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}` +
        `/export?format=csv&gid=${t.gid}`, `${what} gid ${t.gid}`);
    } catch (e) {
      // a tab that will not export (a chart sheet, say) must not kill the
      // run — the signature gates at the end catch a MISSING dataset loudly
      console.log(`::warning::${e.message} — tab "${t.name}" skipped`);
      continue;
    }
    if (/^\s*</.test(csv)) continue;                    // an HTML answer is not a tab
    out.push({ ...t, rows: parseCsv(csv) });
  }
  return out;
}

/** Which dataset a tab holds, from its header row alone. */
export function classifyTab(rows) {
  if (!rows || !rows.length) return '';
  const head = rows[0].map(normHeader);
  const has = (...names) => names.every((n) => head.includes(n));
  if (has('School Department', 'Latitude', 'Longitude')) return 'universities';
  if (has('isOK', 'Placement', 'Alma mater')) return 'recent-faculty';
  if (has('Job posted on (MM/ DD/ YY)', 'University/Institution')) return 'jobs-display';
  if (has('Timestamp', 'University Name/ Institution')) return 'jobs-raw';
  return '';
}

function inventory(what, tabs) {
  for (const t of tabs) {
    const head = (t.rows[0] || []).map(normHeader).filter(Boolean);
    console.log(`  ${what}: tab "${t.name}" (gid ${t.gid}) — ${t.rows.length} rows, ` +
      `${(t.rows[0] || []).length} cols, kind: ${classifyTab(t.rows) || '?'} ` +
      `[${head.slice(0, 5).join(' | ')}]`);
  }
}

/* -------------------------------------------------------------- sanitising */

/** Free text out of a sheet cell: tags stripped (the display tabs carry
    <b>…</b> runs the vendor rendered as HTML; our pages render text), then
    e-mail addresses redacted — the same rule the jobs import applies. */
export function cleanText(v, max = 400) {
  const noTags = String(v ?? '').replace(/<[^>]*>/g, ' ');
  return redactEmails(text(noTags, max));
}

/** A URL that will survive the no-address guard. One faculty directory link
    carries an e-mail as a query parameter (…?user=name@school.edu); encoding
    the @ keeps the link working while nothing in the served file reads as an
    address. An @ BEFORE the query is different — that is a userinfo URL, and
    those are dropped rather than repaired. */
export function safeLink(u) {
  const s = url(u);
  if (!s || s.indexOf('@') === -1) return s;
  const q = s.indexOf('?');
  if (q === -1 || s.slice(0, q).indexOf('@') !== -1) return '';
  return s.slice(0, q) + s.slice(q).replace(/@/g, '%40');
}

/* ------------------------------------------------------------ universities */

export function mapUniversities(rows) {
  const T = header(rows);
  const out = [];
  const dropped = [];
  const seen = new Set();
  for (const row of T.body) {
    const name = cleanText(pick(row, T.index, ['University']), 200);
    if (!name) continue;
    const lat = Number(text(pick(row, T.index, ['Latitude']), 40));
    const lng = Number(text(pick(row, T.index, ['Longitude']), 40));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
        Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      dropped.push(name);
      continue;
    }
    const school = cleanText(pick(row, T.index, ['School']), 160);
    const department = cleanText(pick(row, T.index, ['Department']), 220);
    const rec = {
      id: '',
      name,
      institution: cleanText(pick(row, T.index, ['University/ Institution', 'University/Institution']), 160),
      school,
      department,
      schoolDept: cleanText(pick(row, T.index, ['School Department']), 300) ||
        [school, department].filter(Boolean).join(', '),
      address: cleanText(pick(row, T.index, ['Address']), 300),
      lat,
      lng,
      mapUrl: safeLink(pick(row, T.index, ['Campus location link'])),
      facultyUrl: safeLink(pick(row, T.index, ['Faculty-link'])),
    };
    if (!rec.institution) rec.institution = name;
    let id = slug(name), n = 2;
    while (seen.has(id)) id = `${slug(name)}-${n++}`;
    seen.add(id);
    rec.id = id;
    out.push(rec);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { rows: out, dropped };
}

/* ---------------------------------------------------------- recent faculty */

/** "2015" but also the one hand-typed "2023-24" — an academic year is
    numbered by the year it ends, the same rule as marketYear(). */
export function facultyYear(v) {
  const s = text(v, 12);
  let m = s.match(/^(\d{2})(\d{2})\s*[-\/]\s*(\d{2})$/);   // 2023-24
  if (m) return Number(m[1] + m[3]);
  m = s.match(/^\d{4}$/);
  if (m) {
    const y = Number(s);
    return y >= 2000 && y <= 2100 ? y : 0;
  }
  return 0;
}

export function mapRecentFaculty(rows) {
  const T = header(rows);
  const out = [];
  const byKey = new Map();
  let deduped = 0;
  for (const row of T.body) {
    const name = cleanText(pick(row, T.index, ['Name']), 120);
    if (!name) continue;
    const last = cleanText(pick(row, T.index, ['Last Name']), 60) ||
      name.split(/\s+/).pop();
    const web = anchor(pick(row, T.index, ['Web page']));
    const rec = {
      id: '',
      year: facultyYear(pick(row, T.index, ['Job Market Year'])),
      posted: day(String(pick(row, T.index, ['Posted on (MM/ DD/ YY)'])).split(' ')[0]),
      name,
      last,
      placement: cleanText(pick(row, T.index, ['Placement']), 220),
      almaMater: cleanText(pick(row, T.index, ['Alma mater']), 220),
      undergrad: cleanText(pick(row, T.index, ['Undergrad institution']), 220),
      webUrl: safeLink(web.url),
    };
    if (!rec.year) delete rec.year;
    /* The sheet holds a handful of literal repeat submissions. The SAME person
       placing in the SAME year twice is one hire — keep the fuller row. A
       same-name person in another year is kept: a visiting year and a
       tenure-track year are two entries on the vendor page too. */
    const key = `${name.toLowerCase()}|${rec.year || ''}`;
    const prev = byKey.get(key);
    if (prev) {
      deduped++;
      const fuller = (r) => ['placement', 'almaMater', 'undergrad', 'webUrl']
        .filter((k) => r[k]).length;
      if (fuller(rec) <= fuller(prev)) continue;
      out[out.indexOf(prev)] = rec;
      byKey.set(key, rec);
      continue;
    }
    byKey.set(key, rec);
    out.push(rec);
  }
  const seen = new Set();
  for (const rec of out) {
    const base = `${slug(rec.name)}${rec.year ? '-' + rec.year : ''}`;
    let id = base, n = 2;
    while (seen.has(id)) id = `${base}-${n++}`;
    seen.add(id);
    rec.id = id;
  }
  // the vendor page's own order: alphabetical by last name
  out.sort((a, b) =>
    a.last.localeCompare(b.last, 'en', { sensitivity: 'base' }) ||
    a.name.localeCompare(b.name));
  return { rows: out, deduped };
}

/* ----------------------------------------------------------- past postings */

/** The archive: every jobs-shaped display tab given, mapped by the SAME
    rowsFromSheets the jobs sync used, capped at ARCHIVE_MAX_YEAR and made
    unique across sheets. `jobsPair` may carry the Job Postings sheet's
    display+raw tabs so the old markets that sheet holds join the archive. */
export function buildPastPostings(displayTabs, jobsPair, { maxYear = ARCHIVE_MAX_YEAR } = {}) {
  const all = [];
  for (const tab of displayTabs || []) {
    all.push(...rowsFromSheets(tab, null).rows);
  }
  if (jobsPair && jobsPair.display) {
    all.push(...rowsFromSheets(jobsPair.display, jobsPair.raw || null).rows);
  }
  const scoped = all.filter((r) => r.year && r.year <= maxYear);

  // the tabs carry HTML runs in their free text; jobs.json never does
  for (const r of scoped) {
    r.comments = cleanText(r.comments, 1200);
    r.applyBy = cleanText(r.applyBy, 400);
    r.adUrl = safeLink(r.adUrl);
    r.postedAtUrl = safeLink(r.postedAtUrl);
    r.furtherInfoUrl = safeLink(r.furtherInfoUrl);
    // the 2015 sheet's "Further info" links are scheme-less site links
    if (!r.furtherInfoUrl) {
      r.furtherInfoUrl =
        `https://www.operationsacademia.org/universities?filterA=${encodeURIComponent(r.institution)}`;
    }
  }

  // unique across sheets: the same posting can only collide on the id key
  // (year, institution, posting date), which is exactly what makes it the
  // same posting twice
  const seen = new Set();
  const rows = [];
  for (const r of scoped) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push(r);
  }
  const ids = new Set();
  for (const r of rows) {
    let id = r.id.replace(/-\d+$/, (s) => s), n = 2;   // keep as assigned
    while (ids.has(id)) id = `${r.id}-x${n++}`;
    ids.add(id);
    r.id = id;
  }
  // newest market first, newest posting first within it — the archive reads
  // backwards from the most recent past season
  rows.sort((a, b) => (b.year - a.year) || String(b.posted).localeCompare(String(a.posted)) ||
    a.institution.localeCompare(b.institution));
  return rows;
}

/* ------------------------------------------------------------------ output */

function newestPosted(rows) {
  return rows.reduce((m, r) => (r.posted > m ? r.posted : m), '') || null;
}

/** Deterministic on purpose: a re-run over an unchanged sheet writes
    byte-identical files, so the import workflow commits nothing. */
export function uniMeta(rows) {
  return { count: rows.length };
}
export function rfMeta(rows) {
  const years = {};
  for (const r of rows) if (r.year) years[r.year] = (years[r.year] || 0) + 1;
  return { count: rows.length, years, newestPosted: newestPosted(rows) };
}

export function serialiseRows(rows) {
  return JSON.stringify(rows, null, 1) + '\n';
}

function guardNoEmail(name, rows) {
  const blob = JSON.stringify(rows);
  if (/@[a-z0-9-]+\.[a-z]{2,}/i.test(blob)) {
    console.error(`::error::an e-mail address reached ${name} — refusing to write`);
    process.exit(1);
  }
  if (/javascript:|data:text/i.test(blob)) {
    console.error(`::error::a script URL reached ${name} — refusing to write`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  if (process.argv.includes('--heal-names')) process.exit(await healNames(arg('--out-dir', 'data')) ? 0 : 1);

  const outDir = arg('--out-dir', 'data');
  const dry = process.argv.includes('--dry-run');
  const doFetch = process.argv.includes('--fetch');

  const files = {
    universities: arg('--universities'),
    recentFaculty: arg('--recent-faculty'),
    pastPostings: arg('--past-postings'),
    jobsDisplay: arg('--jobs-display'),
    jobsRaw: arg('--jobs-raw'),
  };

  if (!doFetch && !files.universities && !files.recentFaculty && !files.pastPostings) {
    console.log(`Usage:
  node _scraper/import-legacy-tables.mjs --fetch [--out-dir data] [--dry-run]
  node _scraper/import-legacy-tables.mjs --universities u.csv --recent-faculty rf.csv \\
       --past-postings pp.csv [--jobs-display jd.csv --jobs-raw jr.csv] [--out-dir data]

--fetch reads the published sheets directly (network needed — the legacy-import
workflow runs this on a GitHub runner). The file flags read hand-exported CSVs
of the DISPLAY tabs instead.`);
    process.exit(1);
  }

  let uniTab = null;
  let rfTab = null;
  const pastTabs = [];
  let jobsPair = { display: null, raw: null };

  if (doFetch) {
    for (const [what, id] of Object.entries(SHEETS)) {
      console.log(`reading ${what} sheet ${id}`);
      const tabs = await fetchAllTabs(id, what);
      inventory(what, tabs);
      for (const t of tabs) {
        const kind = classifyTab(t.rows);
        if (what === 'universities' && kind === 'universities' && !uniTab) uniTab = t.rows;
        if (what === 'recentFaculty' && kind === 'recent-faculty' && !rfTab) rfTab = t.rows;
        if (what === 'pastPostings' && kind === 'jobs-display') pastTabs.push(t.rows);
        if (what === 'jobs' && kind === 'jobs-display' && !jobsPair.display) jobsPair.display = t.rows;
        if (what === 'jobs' && kind === 'jobs-raw' && !jobsPair.raw) jobsPair.raw = t.rows;
      }
    }
  } else {
    const load = async (p) => (p ? parseCsv(await readFile(p, 'utf8')) : null);
    uniTab = await load(files.universities);
    rfTab = await load(files.recentFaculty);
    const past = await load(files.pastPostings);
    if (past) pastTabs.push(past);
    jobsPair = { display: await load(files.jobsDisplay), raw: await load(files.jobsRaw) };
  }

  await mkdir(outDir, { recursive: true });
  const write = async (name, rows, meta) => {
    guardNoEmail(name, rows);
    if (dry) { console.log(`--dry-run: not writing ${name} (${rows.length} rows)`); return; }
    await writeFile(path.join(outDir, name), serialiseRows(rows));
    await writeFile(path.join(outDir, name.replace(/\.json$/, '-meta.json')),
      JSON.stringify(meta, null, 1) + '\n');
    console.log(`wrote ${path.join(outDir, name)} (${rows.length} rows)`);
  };

  if (uniTab) {
    const { rows, dropped } = mapUniversities(uniTab);
    if (!rows.length) { console.error('::error::no university row could be read'); process.exit(1); }
    for (const d of dropped) console.log(`::warning::universities: no usable coordinates — dropped "${d}"`);
    /* HEALED ON WRITE, like the postings below. Without this a real --fetch
       re-imports the sheet's own spellings and silently undoes the naming —
       which is exactly what CI caught: the import job fetched, wrote 254 raw
       rows, and the selftest's "the map names every place the way the site
       does" guard went red on 213 of them. The importer never canonicalised
       at all, and a mode that only heals the committed file is not enough
       when the file is rewritten from the sheet. */
    const uni = rows.map(healUniversity);
    await write('universities.json', uni, uniMeta(uni));
  }

  if (rfTab) {
    const { rows, deduped } = mapRecentFaculty(rfTab);
    if (!rows.length) { console.error('::error::no recent-faculty row could be read'); process.exit(1); }
    if (deduped) console.log(`recent faculty: collapsed ${deduped} repeat submission(s)`);
    const placements = rows.map(healFaculty);
    await write('recent-faculty.json', placements, rfMeta(placements));
  }

  if (pastTabs.length || jobsPair.display) {
    const rows = buildPastPostings(pastTabs, jobsPair);
    if (!rows.length) { console.error('::error::no past posting could be read'); process.exit(1); }
    /* addedAt: carried forward from the committed file so a re-import keeps
       every row's original arrival stamp (same rule as the jobs sync). */
    const outPath = path.join(outDir, 'past-postings.json');
    const existing = existsSync(outPath) ? JSON.parse(await readFile(outPath, 'utf8')) : [];
    stampAddedAt(rows, existing, new Date());
    const years = {};
    for (const r of rows) years[r.year] = (years[r.year] || 0) + 1;
    console.log(`past postings: ${rows.length} rows, markets ${JSON.stringify(years)}`);
    const meta = buildMeta(rows, { generated: newestPosted(rows) });
    await write('past-postings.json', rows.map(healPlace), meta);
  }
}

/* ------------------------------------------------------- --heal-names

   THE ARCHIVE IS WRITTEN ONCE AND NEVER REBUILT, which is what makes it an
   archive and also what let its names fall behind: assets/oa-schools.js gains
   an alias whenever a new spelling turns up, data/jobs.json hears about it on
   the next daily build (build-jobs.mjs heals the rows it carries), and
   past-postings.json — with no daily build of its own — did not. So one
   school stood under two names across the two files, and the selftest's
   "every posting names its place the one way" guard went red over a file
   nothing could fix.

   This mode applies the SAME pure, idempotent healPlace to the committed
   archive, no network and no sheets: run it after adding an alias. The
   importer applies it on write too, so a re-import cannot undo it — which it
   silently would have, since the importer never canonicalised at all and the
   archive's canonical spellings had been applied out of band.             */
/** The map's rows. Its THREE name fields are canonicalised together, and the
    two derived ones rebuilt from the result — `name` is what the marker and
    the popup heading say, `schoolDept` the popup's "School, Department" line,
    and both are simply their parts joined (251 of 254 rows exactly, the other
    three with a stray space before the comma, which this also settles).

    A value somebody wrote by hand is NOT rebuilt: `schoolDept` is left alone
    where it says something the two parts do not ("TBC"). And `id` NEVER moves
    — the maintainer's read-time corrections are stored against it
    (`rowOverrides`, `<dataset>__<rowId>`), so a renamed id silently orphans
    every correction already made. The map deep-links on `institution`, not on
    the id, so nothing else wants it to follow the name. */
function healUniversity(r) {
  const p = canonColumns({ institution: r.institution, school: r.school, unit: r.department });
  const institution = p.institution || r.institution || '';
  const school = p.school || '';
  const department = p.unit || '';
  const join = (a, b) => [a, b].filter(Boolean).join(', ');
  const loose = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();

  const out = { ...r, institution, school, department };
  /* derived, so rebuilt — unless the sheet said something of its own */
  if (loose(r.name) === loose(join(r.institution, r.school)) || loose(r.name) === loose(r.institution)) {
    out.name = join(institution, school) || r.name;
  }
  if (loose(r.schoolDept) === loose(join(r.school, r.department))) {
    out.schoolDept = join(school, department);
  }
  const same = ['institution', 'school', 'department', 'name', 'schoolDept']
    .every((k) => out[k] === r[k]);
  return same ? r : out;
}

/** The faculty list names three institutions per row and nothing else. */
function healFaculty(r) {
  const out = { ...r };
  let moved = false;
  for (const field of ['placement', 'almaMater', 'undergrad']) {
    if (!r[field]) continue;
    const v = canonInstitution(r[field]);
    if (v && v !== r[field]) { out[field] = v; moved = true; }
  }
  return moved ? out : r;
}

async function healNames(outDir) {
  /* EVERY dataset this importer writes, not just the postings: the owner's
     rule is one spelling per place ACROSS THE SITE, and the map and the
     faculty list are two of the places it is read. Each has no daily build of
     its own, which is exactly why they drifted. */
  const JOBS = { file: 'past-postings.json', heal: healPlace, meta: true, what: 'posting' };
  const MAP = { file: 'universities.json', heal: healUniversity, meta: false, what: 'university' };
  const FAC = { file: 'recent-faculty.json', heal: healFaculty, meta: false, what: 'placement' };

  const dry = process.argv.includes('--dry-run');
  let ok = true;
  for (const spec of [JOBS, MAP, FAC]) {
    const file = path.join(outDir, spec.file);
    if (!existsSync(file)) {
      console.log(`::warning::${spec.file} is not there — skipped`);
      continue;
    }
    const rows = JSON.parse(await readFile(file, 'utf8'));
    const healed = rows.map(spec.heal);
    const changed = healed.filter((r, i) => r !== rows[i]);
    if (!changed.length) {
      console.log(`${spec.file}: every ${spec.what} already names its place the one way`);
      continue;
    }
    for (const r of changed.slice(0, 6)) {
      console.log(`  ${r.id}: ${r.name || r.institution}${r.department ? ' — ' + r.department : ''}`);
    }
    if (dry) {
      console.log(`--dry-run: ${changed.length} ${spec.what}(s) in ${spec.file} would be renamed`);
      continue;
    }
    guardNoEmail(spec.file, healed);
    await writeFile(file, serialiseRows(healed));
    if (spec.meta) {
      await writeFile(file.replace(/\.json$/, '-meta.json'),
        JSON.stringify(buildMeta(healed, { generated: newestPosted(healed) }), null, 1) + '\n');
    }
    console.log(`${spec.file}: renamed ${changed.length} ${spec.what}(s)`);
  }
  return ok;
}

/* --------------------------------------------------------------- selftest */

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, w) => { if (c) pass++; else fails.push(w); };

  // tab discovery: both htmlpreview markup shapes, duplicates collapsed
  const tabs = parseHtmlPreviewTabs(
    '<li id="sheet-button-0"><a href="#">jobsData</a></li>' +
    '<li id="sheet-button-1755">  <a class="x">rawData</a></li>' +
    '<a href="/x#gid=1755">rawData</a><a href="/y#gid=99">extras</a>');
  ok(JSON.stringify(tabs) === JSON.stringify([
    { gid: '0', name: 'jobsData' }, { gid: '1755', name: 'rawData' },
    { gid: '99', name: 'extras' }]), 'htmlpreview tabs parsed, both shapes, deduped');

  // classification is by header signature, control tokens stripped
  ok(classifyTab([['University', 'School Department', 'Latitude', 'Longitude']]) === 'universities',
    'a universities tab is recognised');
  ok(classifyTab([['Posted on (MM/ DD/ YY)', 'isOK', 'Name', 'Placement', 'Alma mater']]) === 'recent-faculty',
    'a recent-faculty display tab is recognised');
  ok(classifyTab([['Job posted on (MM/ DD/ YY) Hidden', 'University/Institution StringFilter']]) === 'jobs-display',
    'a gviz-fused jobs display header is recognised');
  ok(classifyTab([['Timestamp', 'University Name/ Institution', 'Your email']]) === 'jobs-raw',
    'a jobs raw tab is recognised');
  ok(classifyTab([['A', 'B']]) === '', 'an unknown tab is not guessed at');

  // free text: tags out, addresses out
  ok(cleanText('Contact <b>x@y.edu</b> soon') === 'Contact [e-mail address — see the advertisement link] soon',
    'cleanText strips markup and redacts addresses');

  // links survive the no-address guard without dying
  ok(safeLink('https://b.edu/dir?user=a@b.edu') === 'https://b.edu/dir?user=a%40b.edu',
    'an address in a query string is encoded, not lost');
  ok(safeLink('https://evil@real.com/x') === '', 'a userinfo URL is dropped');
  ok(safeLink('https://b.edu/plain') === 'https://b.edu/plain', 'ordinary URLs pass through');

  // the year field's one hand-typed range
  ok(facultyYear('2015') === 2015 && facultyYear('2023-24') === 2024 &&
     facultyYear('nope') === 0 && facultyYear('200') === 0,
    'facultyYear reads a year, a 2023-24 range, and refuses junk');

  // universities: coordinates gate the map
  const uni = mapUniversities([
    ['University', 'University/ Institution', 'School', 'Department', 'School Department',
      'Campus location link', 'Address', 'Latitude', 'Longitude', 'Faculty-link'],
    ['StringFilter', 'Hidden', 'Hidden', 'Hidden', 'Hidden', 'Hidden', 'Hidden',
      'MapsLat - Hidden - NoFilter', 'MapsLong - Hidden - NoFilter', 'Hidden'],
    ['INSEAD, TOM Area', 'INSEAD', '', 'Technology and Operations Management (TOM) Area',
      'Technology and Operations Management (TOM) Area', 'https://goo.gl/maps/x',
      'Boulevard de Constance, Fontainebleau', '48.4082604', '2.6923494',
      'https://www.insead.edu/faculty-research/faculty'],
    ['Lostville University', 'Lostville', '', '', '', '', '', '', '', ''],
  ]);
  ok(uni.rows.length === 1 && uni.dropped.length === 1 &&
     uni.rows[0].id === 'insead-tom-area' && uni.rows[0].lat === 48.4082604,
    'a university row maps; a coordinate-less one is dropped, not mis-plotted');
  ok(uni.rows[0].schoolDept === 'Technology and Operations Management (TOM) Area',
    'the popup line comes from the sheet');

  // recent faculty: the vendor page's own shape and order
  const rf = mapRecentFaculty([
    ['Posted on (MM/ DD/ YY)', 'isOK', 'Job Market Year', 'Name', 'Placement',
      'Alma mater', 'Undergrad institution', 'Web page', 'Last Name', 'View'],
    ['DateFilter - Hidden', 'Hidden', 'Hidden', 'StringFilter', 'StringFilter',
      'StringFilter', 'StringFilter', 'Hidden', 'Hidden', 'CardsContent'],
    ['2/8/2015 22:02:05', 'ok', '2015', 'Adam Elmachtoub', 'Columbia University',
      'MIT', 'Cornell University',
      '<a href="http://www.columbia.edu/~ae2516/" target="_blank">link</a>', 'Elmachtoub', ''],
    ['1/5/2015 21:12:07', 'ok', '2015', 'Wei Chen', 'University of Kansas',
      'University of Texas at Dallas', 'USTC', 'https://business.ku.edu/wei-chen', 'Chen', ''],
    ['1/6/2015 09:00:00', 'ok', '2015', 'Wei Chen', 'University of Kansas',
      '', '', '', 'Chen', ''],
  ]);
  ok(rf.rows.length === 2 && rf.deduped === 1, 'a same-person same-year repeat collapses');
  ok(rf.rows[0].name === 'Wei Chen' && rf.rows[1].name === 'Adam Elmachtoub',
    'ordered by last name, as the vendor page was');
  ok(rf.rows[0].webUrl === 'https://business.ku.edu/wei-chen' &&
     rf.rows[1].webUrl === 'http://www.columbia.edu/~ae2516/',
    'a bare URL and an anchor cell both yield the link');
  ok(rf.rows[0].id === 'wei-chen-2015' && rf.rows[0].posted === '2015-01-05',
    'ids and posted dates are stable');

  // past postings: the jobs row shape, the year cap, cross-sheet uniqueness
  const mkDisplay = (rows) => [
    ['Job posted on (MM/ DD/ YY)', 'Job Market Year', 'Type', 'University/Institution',
      'Department', 'Entry level', 'Apply by (month, DD, YYYY)', 'Comments on Job Posting',
      'Location', 'File link', 'Posted online at', 'Characteristics', 'Further info'],
    ['Hidden', 'CategoryFilter', 'CategoryFilter - Hidden', 'StringFilter', 'Hidden',
      'csvFilter - Hidden', 'Hidden', 'Hidden', 'CategoryFilter - Hidden', 'Hidden',
      'Hidden', 'csvFilter - Hidden', 'Hidden'],
    ...rows,
  ];
  const past = buildPastPostings(
    [mkDisplay([
      ['9/9/2014 21:51:15', '2015', 'Business School', 'The University of Alabama', '',
        'Other Ranks', 'December 1, 2014', 'Contact <b>chair@ua.edu</b> please', 'USA',
        '<a href="https://drive.google.com/file/d/x/edit" target="_blank">link to Job ad</a>',
        '<a href="https://facultyjobs.ua.edu/postings/35744" target="_blank">link</a>', '',
        '<a href="www.operationsacademia.org/universities?filterA=The University of Alabama">link</a>'],
    ])],
    { display: mkDisplay([
      ['9/9/2014 21:51:15', '2015', 'Business School', 'The University of Alabama', '',
        'Other Ranks', 'December 1, 2014', '', 'USA', 'NA', 'NA', '', ''],
      ['8/6/2025 8:42:07', '2026', 'Business School', 'CUHK Business School',
        'Dept of DOT', 'Assistant Professor', 'December 31, 2025', '', 'Hong Kong',
        'NA', 'NA', '', ''],
      ['7/15/2019 7:54:45', '2020', 'University', 'Old Place', '', 'Post-Doc',
        'Until filled.', '', 'USA', 'NA', 'NA', '', ''],
    ]), raw: null });
  ok(past.length === 2, 'the year cap keeps 2026 out and the same posting is not doubled');
  ok(past[0].year === 2020 && past[1].year === 2015, 'the archive reads newest market first');
  const alabama = past.find((r) => r.institution.includes('Alabama'));
  ok(alabama.comments.indexOf('@') === -1 && alabama.comments.indexOf('<b>') === -1,
    'archive comments carry no address and no markup');
  ok(alabama.adUrl === 'https://drive.google.com/file/d/x/edit',
    'the fuller sheet row won the collision');
  ok(!('Deadline' in alabama) && alabama.applyByDate === '2014-12-01',
    'the jobs row shape came through rowsFromSheets untouched');

  // the metas are deterministic — a re-run must commit nothing
  ok(JSON.stringify(uniMeta(uni.rows)) === JSON.stringify({ count: 1 }), 'universities meta');
  const m = rfMeta(rf.rows);
  ok(m.count === 2 && m.years['2015'] === 2 && m.newestPosted === '2015-02-08',
    'recent-faculty meta is derived from the rows alone');

  if (fails.length) {
    console.log(`\n${fails.length} FAILED, ${pass} passed`);
    for (const f of fails) console.log('  FAIL  ' + f);
    return false;
  }
  console.log(`import-legacy-tables selftest: ${pass} checks passed`);
  return true;
}

if (isMain(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
