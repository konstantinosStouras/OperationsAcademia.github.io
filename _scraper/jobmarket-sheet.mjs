#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — the JOB MARKET TRACKING SHEET, read as a dataset.

   WHAT THIS IS, AND WHY IT IS NOT THE RETIRED SYNC. `oa-jobs-sheet-sync.yml`
   read the old Google FORM's response sheet and was retired for a good reason:
   those postings had become documents people could edit, and re-reading the
   sheet every 20 minutes silently reverted their edits.

   This reads a DIFFERENT sheet and has the opposite ownership. It is the
   maintainer's own job-market tracking spreadsheet — one workbook per market
   cycle, a tab per kind of position ("2026 Jobs", "2026 NTT/PD") — and the
   sheet is where those rows are curated. Nobody edits them on the site, so
   following the sheet cannot undo anybody's work: the sheet IS the editorial
   home, and this file's job is to keep the site in step with it.

       the tracking sheet  ->  THIS  ->  data/jobmarket.json
                                              |
                       build-jobs.mjs merges it alongside the Firestore
                       postings  ->  data/jobs.json  ->  the jobs page

   Three things follow from "one workbook per cycle":

     1. TABS ARE DISCOVERED, never hard-coded. A cycle's tabs are named for
        the year it opens ("2026 Jobs"), so next year's names are not known
        today and a list typed here would go stale on 1 July.

     2. THE CHAIN IS FOLLOWED. At the end of a cycle the "intro" tab links to
        the next workbook, so the sync reads that link and rolls itself over
        (see sheetIdsFromHtml / rollRegistry). That link is a HYPERLINK on
        ordinary text, so the URL is not in the CSV export at all — it is read
        out of the sheet's HTML view, which is also where the tab names are.

     3. A SHEET THAT STOPS IS A FAILURE MODE, not a quiet state. Nothing on
        the site would look wrong; the postings would simply stop arriving.
        So `stalenessOf` turns "no new row for N days" — and "the sheet could
        not be read at all" — into something that sends the maintainer an
        e-mail (see sync-jobmarket-sheet.mjs).

   EVERYTHING HERE IS PURE. The network lives in the runner; this file is
   parsing, mapping and decisions, so selftest.mjs can check all of it with no
   credentials and no egress — which this build environment does not have
   (docs.google.com is blocked here), so the sync only does real work on the
   GitHub Actions runners.
   --------------------------------------------------------------------------- */

import { createRequire } from 'node:module';

import {
  text, url, jobId, canonCountry, canonPlace, longDate, marketYear, universitiesLink,
  displayOrder, collapseSameDay, isoStamp, publicRow, LEVELS, OPEN_ENDED_RX,
} from './jobs-model.mjs';
import { parseCsv, redactEmails } from './import-sheet.mjs';
import { splitDepartment, joinDepartment } from './vocab.mjs';

const require = createRequire(import.meta.url);
const COUNTRIES = require('../assets/oa-countries.js');

/* ------------------------------------------------------------- the workbook

   The cycle under way when this was written. It is a SEED, not a constant the
   pipeline depends on: data/jobmarket-sheets.json records which workbooks are
   known and which is current, and the intro-tab chain adds the next one by
   itself. This value only matters on the very first run, or if that registry
   is ever deleted. */
export const SEED_SHEET_ID = '1zJPoPCUm11AZ5B74pzmaZKGNSUqU7onIIRQSzIxDkq8';

/** Every row this pipeline publishes carries it, so a sheet-sourced posting is
    identifiable in the served file, in a diff, and in build-jobs.mjs — which
    treats these rows as the sheet's to add and to REMOVE. */
export const SOURCE = 'jobmarket-sheet';

/** A row first seen more than this many days after it was advertised is not
    "new" for the purposes of the e-mail digest. See stampAddedAt. */
export const BACKDATE_DAYS = 30;

/** No new row for this long means something needs looking at. Three weeks:
    the market has quiet fortnights (Christmas, mid-summer), and a warning that
    cries wolf every August is one nobody reads. */
export const STALE_DAYS = 21;

/** …and having said so once, do not say it again for a week. */
export const STALE_REPEAT_DAYS = 7;

/* ------------------------------------------------------------------- URLs */

/** One tab, as CSV. Needs no credentials — the workbook has to be readable by
    anyone with the link, which is also how the old importer read its sheet. */
export function sheetCsvUrl(id, tab) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}` +
    `/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

/** The whole workbook as one HTML page: every tab's NAME (which the CSV
    endpoint cannot list) and every HYPERLINK (which the CSV export drops,
    because it exports the visible text — and the intro tab's pointer at next
    year's workbook is a link on the words). */
export function sheetHtmlUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/htmlview`;
}

/** Where a human goes to look at it. */
export function sheetEditUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
}

/** A workbook id, or ''. Google's ids are 25+ URL-safe characters; anything
    shorter is a fragment of a URL we mis-parsed, and adopting it would point
    the whole pipeline at nothing. */
export function sheetId(v) {
  const s = String(v ?? '').trim();
  return /^[A-Za-z0-9_-]{25,}$/.test(s) ? s : '';
}

/* --------------------------------------------------------- reading the HTML

   Google's htmlview is machine-generated and its exact shape is not a
   contract, so both readers below are deliberately forgiving: they take the
   union of several patterns. A tab list that comes back empty is not fatal
   either — the runner falls back to the conventional tab names (see
   conventionalTabs).                                                          */

/** The workbook's tabs, in the order the sheet shows them. */
export function tabsFromHtml(html) {
  const s = String(html || '');
  const out = [];
  const seen = new Set();

  const add = (gid, name) => {
    const n = text(decodeEntities(stripTags(name)), 120);
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push({ gid: String(gid || ''), name: n });
  };

  // the tab strip: <li id="sheet-button-1514861818" ...>2026 NTT/PD</li>
  for (const m of s.matchAll(/id=["']sheet-button-(\d+)["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    add(m[1], m[2]);
  }
  // …and the anchor form some exports use: <a href="#gid=1514861818">2026 Jobs</a>
  for (const m of s.matchAll(
    /<a[^>]+href=["'][^"']*[#?&]gid=(\d+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    add(m[1], m[2]);
  }

  return out;
}

/**
 * Every OTHER workbook this one links to — the intro tab's pointer at next
 * year's sheet.
 *
 * Google rewrites an external link in htmlview as
 * `https://www.google.com/url?q=<percent-encoded>&sa=...`, so the id has to be
 * read through that wrapper as well as from a bare href.
 */
export function sheetIdsFromHtml(html, { exclude = [] } = {}) {
  const s = decodeEntities(String(html || ''));
  const skip = new Set(exclude.filter(Boolean));
  const out = [];
  const seen = new Set();

  const consider = (raw) => {
    const id = sheetId(raw);
    if (!id || skip.has(id) || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  const ID_IN = /spreadsheets\/(?:u\/\d+\/)?d\/(?:e\/)?([A-Za-z0-9_-]{25,})/;

  for (const m of s.matchAll(new RegExp(ID_IN.source, 'g'))) consider(m[1]);

  for (const m of s.matchAll(/[?&]q=([^"'&<\s]+)/g)) {
    let dec = m[1];
    for (let i = 0; i < 2; i++) {
      let next;
      try { next = decodeURIComponent(dec); } catch { break; }
      if (next === dec) break;
      dec = next;
    }
    const inner = ID_IN.exec(dec);
    if (inner) consider(inner[1]);
  }

  return out;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

/* ------------------------------------------------------------------- tabs */

/**
 * What a tab is, from its name: `{ year, kind }`, or null for a tab this
 * pipeline does not read.
 *
 * `year` is the year the cycle OPENS, which is how the maintainer names the
 * tabs ("2026 Jobs" holds postings advertised from July 2026). It is
 * deliberately NOT the row's market year — that is derived from each posting's
 * own date by the site's own roll rule, so the two can never drift. It decides
 * only which tabs are worth fetching.
 */
export function classifyTab(name) {
  const s = text(name, 120);
  if (!s) return null;

  const year = (s.match(/\b(20\d{2})\b/) || [])[1];
  if (!year) return null;

  // take the year out before reading the rest, so its digits cannot be read as
  // part of a word
  const rest = s.replace(/\b20\d{2}\b/g, ' ').replace(/[^A-Za-z/&+\- ]+/g, ' ').trim();

  // NTT/PD first: "2026 NTT/PD Jobs" is an NTT tab that happens to say Jobs
  if (/\bntt\b|\bpd\b|non.?tenure|post.?doc|teaching|visiting|lecturer/i.test(rest)) {
    return { year: Number(year), kind: 'ntt-pd' };
  }
  if (/\bjobs?\b|postings?|tenure.?track|\btt\b|faculty|positions?/i.test(rest)) {
    return { year: Number(year), kind: 'jobs' };
  }
  return null;
}

/** Is this the tab that carries the pointer at next year's workbook? */
export function isIntroTab(name) {
  return /^\s*(intro|introduction|read\s*me|readme|about|start|home)\b/i.test(String(name || ''));
}

/**
 * The tab names to try when the tab strip could not be read.
 *
 * Not a nicety: gviz addresses a tab BY NAME, so with no list of names there
 * is nothing to fetch, and one change to Google's HTML would take the whole
 * pipeline down silently. The names follow an obvious convention, so they can
 * be reconstructed — a name that does not exist simply fails and is skipped.
 */
export function conventionalTabs(years) {
  const out = [];
  for (const y of years) {
    out.push(`${y} Jobs`, `${y} NTT/PD`, `${y} NTT-PD`, `${y} NTT PD`);
  }
  return out;
}

/* ------------------------------------------------------------------- dates

   The sheet is typed by hand and its date column arrives in whatever shape the
   cell was formatted with. `day()` in jobs-model.mjs understands the three
   forms the FORM produced; this understands those plus the ones a person types
   into a spreadsheet — above all "20-Jul-26", which is what the tracking sheet
   actually holds.                                                             */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function sheetDay(v) {
  const s = text(v, 40);
  if (!s) return '';

  let m;

  // 2026-07-20
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\b/))) return iso(+m[1], +m[2], +m[3]);

  // 20-Jul-26, 20 Jul 2026, 20/Jul/2026
  if ((m = s.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,})[\s\-/.]+(\d{2,4})\b/))) {
    const mo = monthOf(m[2]);
    return mo ? iso(fullYear(+m[3]), mo, +m[1]) : '';
  }

  // Jul 20, 2026 / July 20 2026 / Jul-20-26
  if ((m = s.match(/^([A-Za-z]{3,})[\s\-/.]+(\d{1,2})(?:st|nd|rd|th)?[\s,\-/.]+(\d{2,4})\b/))) {
    const mo = monthOf(m[1]);
    return mo ? iso(fullYear(+m[3]), mo, +m[2]) : '';
  }

  /* All-numeric. US order (7/20/2026) is the default, because that is what
     Google writes for a date cell in this account's locale — but a first field
     over 12 can only be a day, so 20/07/2026 is read the way it was meant
     rather than thrown away. */
  if ((m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/))) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3]);
    if (a > 12 && b <= 12) return iso(y, b, a);
    return iso(y, a, b);
  }

  return '';
}

function monthOf(name) {
  const i = MONTHS.indexOf(String(name).toLowerCase().slice(0, 3));
  return i < 0 ? 0 : i + 1;
}

/** A two-digit year, pivoted. Nothing in this sheet is from the 1900s, but the
    pivot is spelled out rather than assumed. */
function fullYear(y) {
  if (y >= 1000) return y;
  return y <= 79 ? 2000 + y : 1900 + y;
}

function iso(y, mo, d) {
  if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return '';
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';   // 31 Feb
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Whole days between two ISO days, b - a. */
export function daysBetween(a, b) {
  const at = Date.parse(`${a}T00:00:00Z`), bt = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return null;
  return Math.round((bt - at) / 86400e3);
}

/* -------------------------------------------------------------- deadlines

   A DEADLINE THE PIPELINE IS UNSURE OF IS NOT A DEADLINE (owner, 2026-08-23:
   "if no submit by information or deadline is included in the posting, or if
   you are completely unsure of the deadline, say until filled"). `sheetDay`
   has to survive a hand-kept spreadsheet, so on an ambiguous all-numeric cell
   it guesses at US order — right for a date Google itself wrote, and wrong for
   a contributor typing day-first: "5/10/2026" meaning the fifth of October was
   published as the tenth of May, a deadline BEFORE the advertisement went up.
   Nothing checked the answer against the one fact every row carries — the day
   it was posted.

   So a deadline is only believed when it is PLAUSIBLE against the posting
   date: on or after it, and within DEADLINE_WINDOW_DAYS of it (no search on
   this market advertises a closing date two years out — a date past that is a
   mis-typed year, not a plan). An ambiguous day/month whose US reading fails
   that test is re-read the other way round FIRST — the one honest repair,
   because only one of the two readings can be a date the advertisement could
   have meant — and a cell neither reading can save publishes NO date, which
   the page already shows as "Until filled." The cell's own words are then
   carried into the comments (see rowsFromTab), so what the sheet said is on
   the card for the maintainer to settle rather than silently lost.           */

/** How far past the posting date a claimed deadline is still believable. */
export const DEADLINE_WINDOW_DAYS = 730;

/**
 * The deadline a sheet cell states, believed only when it is plausible
 * against the day the posting went up — or ''.
 */
export function deadlineDay(v, posted = '') {
  const s = text(v, 40);
  if (!s) return '';

  const plausible = (d) => {
    if (!d) return false;
    if (!posted) return true;             // nothing to test against
    const gap = daysBetween(posted, d);
    return gap != null && gap >= 0 && gap <= DEADLINE_WINDOW_DAYS;
  };

  const first = sheetDay(s);
  if (plausible(first)) return first;

  // an all-numeric day/month that could be read either way: try the other
  const m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/);
  if (m) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3]);
    if (a <= 12 && b <= 12 && a !== b) {
      const swapped = iso(y, b, a);
      if (plausible(swapped)) return swapped;
    }
  }
  return '';
}

/* ----------------------------------------------------------------- columns

   The sheet's header wording is the maintainer's, not a contract, so columns
   are found by ALIAS rather than by position — a column inserted in the middle
   must not shift every field by one. What could not be matched is REPORTED
   (see `unmapped`), because the alternative is a column quietly going missing
   for months.                                                                 */

export const COLUMNS = {
  institution: ['university', 'institution', 'university/institution', 'university name',
    'school', 'employer', 'organisation', 'organization', 'university / institution'],
  city:        ['city', 'city/state', 'city, state', 'city and state', 'location',
    'place', 'town', 'city/region', 'state', 'city/town'],
  country:     ['country', 'country location', 'nation'],
  posted:      ['date', 'date posted', 'posted', 'posted on', 'date added', 'added',
    'posting date', 'date of posting', 'job posted on'],
  area:        ['field', 'area', 'field/area', 'department', 'discipline', 'group',
    'area/field', 'department/area', 'subject', 'field of study', 'specialisation',
    'specialization'],
  rank:        ['position', 'rank', 'title', 'job title', 'position/rank', 'rank/position',
    'level', 'job type', 'type of position', 'appointment'],
  deadline:    ['deadline', 'apply by', 'application deadline', 'due', 'due date',
    'closing date', 'closes'],
  link:        ['link', 'url', 'ad', 'job ad', 'advert', 'advertisement', 'posting link',
    'job link', 'website', 'web link', 'apply', 'apply link', 'more info', 'ad link'],
  notes:       ['notes', 'note', 'comments', 'comment', 'remarks', 'other'],
};

/** A header cell, reduced to something an alias can be compared against. */
export function normHeader(h) {
  return text(h, 120)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')            // "date (mm/dd/yy)" -> "date"
    .replace(/[^a-z0-9/&, ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A numbering column's header ("#", "No", "S/N") — not a field anybody is
    missing, so it is never reported as unmapped. */
const COUNTER_HEADER = /^(#|no|nr|num|number|s\/n|sn|index|id|count|item)$/;

/**
 * Which column holds what: `{ index, unmapped, missing }`.
 *
 * `index` maps a field of COLUMNS to a column number. A column already claimed
 * is not claimed twice, and EXACT matches are taken before loose ones across
 * every field — otherwise a sheet with both "Location" and "Country" would
 * give "Location" (an alias of `city`) to whichever field asked first.
 *
 * `pinned` lets a caller settle a field itself — the one repair for a header
 * that names a column WRONGLY, which no reading of its words can undo.
 */
export function mapColumns(head, { pinned = null } = {}) {
  const cells = (head || []).map(normHeader);
  const index = {};
  const taken = new Set();

  /* A column the CALLER has already settled from the data (see repairColumns).
     It is claimed before the header is read, so the header's own words cannot
     take it, and the field is not looked for a second time. */
  for (const [field, at] of Object.entries(pinned || {})) {
    if (Number.isInteger(at) && at >= 0 && !taken.has(at)) { index[field] = at; taken.add(at); }
  }

  for (const pass of ['exact', 'loose']) {
    for (const [field, aliases] of Object.entries(COLUMNS)) {
      if (field in index) continue;
      for (let i = 0; i < cells.length; i++) {
        if (taken.has(i) || !cells[i]) continue;
        const hit = pass === 'exact'
          ? aliases.includes(cells[i])
          : aliases.some((a) => cells[i].startsWith(a + ' ') || cells[i].endsWith(' ' + a) ||
                                cells[i].includes(' ' + a + ' '));
        if (hit) { index[field] = i; taken.add(i); break; }
      }
    }
  }

  const unmapped = [];
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] || taken.has(i) || COUNTER_HEADER.test(cells[i])) continue;
    unmapped.push({ at: i, header: text(head[i], 120) });
  }

  const missing = ['institution', 'posted'].filter((f) => !(f in index));
  return { index, unmapped, missing };
}

/* ------------------------------------------------ when there is no header

   A tracking sheet is not a form: a tab can begin straight at the data, or
   carry headers only the maintainer would recognise. Refusing such a tab would
   mean the pipeline reads nothing and says nothing useful about why.

   So the columns are inferred from the DATA — but only from evidence, never
   from a remembered layout: the date column is the one whose cells parse as
   dates, the country column the one whose cells are country names, the link
   column the one holding URLs. Each is accepted only if it explains most of
   the rows, so a wrong guess fails loudly instead of silently mis-filing every
   posting.                                                                    */

const INFER_SHARE = 0.6;

export function inferColumns(rows, { sample = 40 } = {}) {
  const body = rows.slice(0, sample).filter((r) => r.some((c) => text(c, 200)));
  if (body.length < 2) return { index: {}, unmapped: [], missing: ['institution', 'posted'] };

  const width = body.reduce((w, r) => Math.max(w, r.length), 0);
  const col = (i) => body.map((r) => text(r[i], 300));
  const share = (i, pred) => {
    const vals = col(i).filter(Boolean);
    return vals.length ? vals.filter(pred).length / vals.length : 0;
  };
  const filled = (i) => col(i).filter(Boolean).length / body.length;

  const best = (pred, min = INFER_SHARE, skip = new Set()) => {
    let at = -1, top = min;
    for (let i = 0; i < width; i++) {
      if (skip.has(i)) continue;
      const s = share(i, pred);
      if (s > top) { top = s; at = i; }
    }
    return at;
  };

  const index = {};
  const taken = new Set();
  const claim = (field, at) => {
    if (at >= 0 && !taken.has(at)) { index[field] = at; taken.add(at); }
  };

  claim('posted', best((v) => !!sheetDay(v)));
  claim('country', best((v) => COUNTRIES.isCanonical(canonCountry(v)) &&
                               COUNTRIES.LIST.includes(canonCountry(v))));
  claim('link', best((v) => !!url(v), 0.4, taken));

  /* The institution is the leftmost column of ordinary prose — after any
     numbering column, and before the country. "Ordinary prose" is spelled out
     as: mostly filled, not mostly numeric, and not a date. */
  const prose = (i) =>
    !taken.has(i) && filled(i) >= 0.7 &&
    share(i, (v) => /^\d+([.,]\d+)?$/.test(v)) < 0.5 &&
    share(i, (v) => !!sheetDay(v)) < 0.5;

  const stop = index.country != null ? index.country
    : (index.posted != null ? index.posted : width);
  for (let i = 0; i < stop; i++) if (prose(i)) { claim('institution', i); break; }

  // whatever prose sits between the institution and the country is the town
  if (index.institution != null && index.country != null) {
    for (let i = index.institution + 1; i < index.country; i++) {
      if (prose(i)) { claim('city', i); break; }
    }
  }

  // and the two prose columns after the date are the area and the rank, in the
  // order the sheet shows them
  if (index.posted != null) {
    for (let i = index.posted + 1; i < width && !('rank' in index); i++) {
      if (!prose(i)) continue;
      claim('area' in index ? 'rank' : 'area', i);
    }
  }

  const missing = ['institution', 'posted'].filter((f) => !(f in index));
  return { index, unmapped: [], missing, inferred: true };
}

/* ------------------------------------------- a header that names one column
                                                wrongly

   THE FAILURE THIS ANSWERS, because it cost a season of postings. The
   crowdsourced workbook's "2026 Jobs" tab — the tab its own contributors
   created when the 2026-2027 market opened — heads its first column
   "Location" where every other tab heads it "School". `institution` is a
   REQUIRED field and no alias of it reads "location", so that row was not
   accepted as the header. The scan moved on to the next row, which was a
   posting, and took THAT as the header: "University of Hong Kong" begins with
   an alias of `institution`, and a comment reading "an expected start date of
   July 1, 2027" contains an alias of `posted`. Both required fields were
   satisfied by prose. The date was then read out of a comment column that is
   empty on almost every row, so every row lacked a date and all 89 postings
   were skipped. The tab reported "0 posting(s), 94 row(s) skipped" every
   morning for four months and the site simply never showed the market.

   Two rules come out of it, and they are separate on purpose:

     1. A ROW OF POSTINGS IS NEVER A HEADER, however many aliases its prose
        happens to contain (`looksLikeData`).
     2. A HEADER THAT NAMES MOST OF ITS COLUMNS IS REPAIRED, NOT DISCARDED:
        what it did name is kept, and the one field it named wrongly is
        settled from the DATA underneath it (`repairColumns`).

   The second is deliberately narrow. It runs only for a field without which
   nothing can be published at all, only when the header did not name it, and
   only on evidence from the rows themselves — and the alternative outcome, in
   every case where it fires, is the tab publishing nothing. It cannot change
   a tab whose header is right, because a header that names its required
   fields never reaches it. */

/** How much of a header must be recognisable before its remaining column is
    worth settling from the data. Three is enough to tell a header row from a
    line of prose that happens to contain an alias. */
const REPAIR_MIN_NAMED = 3;

/** The share of a column's values that must name an institution before that
    column is read as one. Measured over the tab above: 92% of the school
    column, 0% of the two beside it. */
const INSTITUTION_SHARE = 0.5;

/**
 * Does this row hold DATA rather than the names of columns?
 *
 * Refused outright: a link and a date. A column is never NAMED after one, and
 * a posting almost always carries both. Two long sentences are weaker
 * evidence and are counted rather than trusted alone, so a header keeping a
 * wordy label ("Comment (virtual or onsite)") is not thrown away.
 */
export function looksLikeData(row) {
  const cells = (row || []).map((c) => text(c, 300)).filter(Boolean);
  let sentences = 0;
  for (const c of cells) {
    if (/^(https?:\/\/|www\.)/i.test(c)) return true;
    if (sheetDay(c)) return true;
    if (c.length > 60) sentences++;
  }
  return sentences >= 2;
}

/** The values of one column of the sample, empties dropped. */
function columnValues(body, at, { sample = 40 } = {}) {
  return body.slice(0, sample).map((r) => text(r[at], 300)).filter(Boolean);
}

/** The share of a column's values for which `pred` holds, or 0 when the
    column is too empty to be evidence of anything. */
function columnShare(body, at, pred) {
  const vals = columnValues(body, at);
  if (vals.length < 3) return 0;
  return vals.filter(pred).length / vals.length;
}

/**
 * Which column names institutions, read off the rows themselves.
 *
 * The names state what they are — "University of Hong Kong", "Rutgers
 * Business School", "Air Force Institute of Technology" — which is the same
 * evidence `typeFromNames` reads to answer what KIND of institution a posting
 * is from, so the two cannot disagree about what an institution name looks
 * like. Not every school says so ("KU Leuven", "ESMT Berlin", "Stanford GSB"
 * — seven of the ninety rows measured), so it is a share of the column and
 * never a test of one cell.
 */
export function institutionColumn(body, { reserved = new Set() } = {}) {
  const width = body.reduce((w, r) => Math.max(w, (r || []).length), 0);
  let at = -1, top = INSTITUTION_SHARE;
  for (let i = 0; i < width; i++) {
    if (reserved.has(i)) continue;
    /* Both patterns are written for lower-cased text — that is how
       typeFromNames applies them — so a raw cell must be folded first or
       "University of Hong Kong" matches nothing. */
    const s = columnShare(body, i, (v) => {
      const t = v.toLowerCase();
      return UNIVERSITY.test(t) || BUSINESS_SCHOOL.test(t);
    });
    if (s > top) { top = s; at = i; }
  }
  return at;
}

/** Which column holds the dates — the same evidence inferColumns reads. */
export function dateColumn(body, { reserved = new Set() } = {}) {
  const width = body.reduce((w, r) => Math.max(w, (r || []).length), 0);
  let at = -1, top = INFER_SHARE;
  for (let i = 0; i < width; i++) {
    if (reserved.has(i)) continue;
    const s = columnShare(body, i, (v) => !!sheetDay(v));
    if (s > top) { top = s; at = i; }
  }
  return at;
}

/**
 * A header row that named its columns, one of them wrongly: settle the
 * required field it left unnamed from the data, then let the header map
 * everything else AROUND that column.
 *
 * Re-reading the header is what makes the repair minimal rather than a second
 * guess at the whole layout. Pinning the school column of the tab above frees
 * the word the header used for it, and the tab's SECOND "Location" — until
 * then an unclaimed duplicate — is then read as the town, which is what it
 * holds. Everything the header named already (the deadline, the link, the
 * notes) is untouched; whole-tab inference would have lost all three.
 */
export function repairColumns(head, body) {
  const first = mapColumns(head);
  if (!first.missing.length) return first;
  if (Object.keys(first.index).length < REPAIR_MIN_NAMED) return first;

  const pinned = {};
  const repaired = [];

  /* WHICH COLUMNS ARE OFF LIMITS. Only the OTHER required field, because the
     column being looked for is usually one the header has already given away:
     the tab that motivated this heads its school column "Location", so `city`
     holds it and reserving everything the header named would look everywhere
     except the one place the school names are. An optional field may
     therefore be displaced — and is put back by the header re-read below,
     which is how the tab's second "Location" ends up as the town.

     What makes that safe is the size of the gap rather than the rule: a
     column is only read as the institution when most of its values NAME an
     institution, and a column of towns, countries, ranks, dates, links or
     areas scores zero. */
  const required = new Set(['institution', 'posted']);
  const reservedFor = (field) => new Set(
    Object.entries(first.index)
      .filter(([f]) => required.has(f) && f !== field)
      .map(([, at]) => at));

  if (first.missing.includes('institution')) {
    const at = institutionColumn(body, { reserved: reservedFor('institution') });
    if (at >= 0) { pinned.institution = at; repaired.push({ field: 'institution', at }); }
  }
  if (first.missing.includes('posted')) {
    const reserved = reservedFor('posted');
    for (const at of Object.values(pinned)) reserved.add(at);
    const at = dateColumn(body, { reserved });
    if (at >= 0) { pinned.posted = at; repaired.push({ field: 'posted', at }); }
  }
  if (!repaired.length) return first;

  const out = mapColumns(head, { pinned });
  return { ...out, repaired: repaired.map((r) => ({ ...r, header: text(head[r.at], 120) })) };
}

/**
 * Where the data starts and what each column is.
 *
 * The header scan comes first and is trusted when it finds one; a header that
 * names a required column wrongly is repaired from the data; inference over
 * the whole tab is the last fallback, and reports itself so a run's log says
 * which was used.
 */
export function resolveColumns(grid, { limit = 8 } = {}) {
  let best = null;

  for (let i = 0; i < Math.min(limit, grid.length); i++) {
    if (looksLikeData(grid[i])) continue;

    const m = mapColumns(grid[i]);
    if (!m.missing.length) return { at: i, inferred: false, ...m };

    const named = Object.keys(m.index).length;
    if (!best || named > best.named) best = { at: i, named, ...m };
  }

  if (best) {
    const fixed = repairColumns(grid[best.at], grid.slice(best.at + 1));
    if (!fixed.missing.length) return { at: best.at, inferred: false, ...fixed };
  }

  const guess = inferColumns(grid);
  // no header row was recognised, so every row is data
  return { at: -1, ...guess };
}

function cell(row, index, field) {
  const i = index[field];
  return i == null ? '' : String(row[i] ?? '');
}

/* ------------------------------------------------------- rank -> entry level

   The site offers five entry levels; the sheet types a job title. The mapping
   is by PRECEDENCE, not by collecting every token, because the titles overlap:
   "Visiting Assistant Professor" is a visiting position, not an assistant
   professorship with a qualifier, and an alert for "Assistant Professor" that
   returned every visiting post would be worse than useless.                   */

export function levelsFromRank(rank, kind = '') {
  const s = text(rank, 160).toLowerCase();

  if (!s) {
    // Nothing but the tab to go on. An NTT/PD tab asserts non-tenure-track by
    // its own name; a jobs tab asserts nothing about the rank.
    return kind === 'ntt-pd' ? ['Non-tenure track (teaching) position'] : ['Other Ranks'];
  }

  if (/post.?doc|postdoctoral|\bpd\b|research fellow|research associate/.test(s)) {
    return ['Post-Doc'];
  }
  if (/visiting|\bvap\b/.test(s)) return ['Visiting Faculty (various levels)'];
  /* `non.?tt` before the tenure-track test below, and deliberately not a bare
     "ttap": the sheet writes "non TTAP" for a non-tenure-track assistant
     professorship and "TTAP" for a tenure-track one, so the two differ by that
     one word and reading it wrongly files a teaching post as tenure-track. */
  if (/lecturer|instructor|teaching|clinical|practice|professional in residence|adjunct|non.?tenure|non.?tt|\bntt\b|temporary|general faculty|educator/.test(s)) {
    return ['Non-tenure track (teaching) position'];
  }

  const out = [];
  if (/assistant professor|\bap\b|\bttap\b|tenure.?track|entry.?level/.test(s)) {
    out.push('Assistant Professor');
  }
  /* "Other Ranks" is tested against what is LEFT once the entry-level title is
     taken out. Without that, the bare `professor` alternative — which is there
     to catch a full professorship — matches the word inside "Assistant
     Professor", and every entry-level post is also filed under Other Ranks,
     which is precisely the noise the Entry level filter exists to remove. */
  const rest = s.replace(/assistant\s+professors?/g, ' ');
  if (/open.?rank|all ranks|any rank|associate professor|full professor|\bprofessor\b|chair|\bsenior\b|reader/.test(rest)) {
    out.push('Other Ranks');
  }
  return out.length ? out : ['Other Ranks'];
}

/* --------------------------------------------------- institution -> type

   The site's Type filter answers "what kind of institution is this?" — the old
   sheet's column was headed "Type of Institution" — and the tracking sheet has
   no such column. So it is read off the posting's own TEXT, which states it:
   "Rutgers Business School" is a business school and "Clarkson University" is
   a university. That is evidence, not a guess.

   THE EVIDENCE IS THE WHOLE POSTING, not the employer's name alone (owner,
   2026-08-23): a posting that says "business" ANYWHERE — the field column, the
   advertised title, the notes, the advertisement's own address — has to do
   with the university's business school and is flagged under Business School,
   so Berkeley advertising a business-flavoured post files under the school
   doing the hiring rather than under "University". Every crawled posting is
   held in the review queue before it publishes, and its card names the
   business school the site's directory knows (see businessCheck in
   jobreview.mjs), so the maintainer confirms the flag rather than discovering
   it. The residual imprecision runs the other way now: a business-school
   posting whose row never says so stays a University, and the maintainer's
   card is where that is corrected.

   Where the text says neither ("INSEAD", "CEIBS"), the type is left EMPTY
   rather than defaulted. An empty type is what the served-file check already
   allows (`!r.type || TYPES.includes(...)`); a made-up one would sit behind a
   filter a visitor trusts.                                                    */

const BUSINESS_SCHOOL =
  /business school|school of business|college of business|business college|school of management|management school|graduate school of business|school of commerce|business administration/;

/* The owner's own rule: the bare WORD is evidence enough. Word-bounded, so
   "agribusiness" is not read as it, and kept OUT of institutionColumn's
   patterns above — a column of departments saying "Business Analytics" names
   no institution. */
const BUSINESS_WORD = /\bbusiness\b/;

const UNIVERSITY = /universit|college|institute|polytechnic|\bacademy\b|\bschool\b/;

export function typeFromNames(institution, ...rest) {
  const inst = text(institution, 300);
  const all = [inst, ...rest.map((p) => text(p, 300))].join(' · ').toLowerCase();

  if (BUSINESS_SCHOOL.test(all) || BUSINESS_WORD.test(all)) return 'Business School';
  // only the EMPLOYER's own name answers "what kind of institution is this?" —
  // "Department of Industrial Engineering" says nothing about the employer
  return UNIVERSITY.test(inst.toLowerCase()) ? 'University' : '';
}

/* ------------------------------------------------------------- rows -> data */

/** An e-mail address must never reach data/, and a URL is text like any other
    — a link with an address in its query string would put one there. */
const HAS_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * One tab's CSV -> published rows.
 *
 * Returns `{ rows, skipped, unmapped, missing, unlinked, headerAt, inferred }`.
 * Rows are in the published shape (jobs-model.mjs's PUBLIC_FIELDS), so
 * build-jobs.mjs merges them beside a posting made through the site with no
 * special case.
 *
 * `minYear` drops rows from a season the site no longer carries: the tabs of a
 * closed cycle stay readable, and without this a roll-over run would republish
 * a whole retired season.
 */
export function rowsFromTab(csv, {
  tab = '', kind = '', sheetId: id = '', minYear = 0, cycleYear = 0,
} = {}) {
  const grid = parseCsv(csv);
  const head = resolveColumns(grid);
  if (head.missing.length) {
    return { rows: [], skipped: 0, unmapped: head.unmapped || [], missing: head.missing,
             unlinked: 0, headerAt: head.at, inferred: !!head.inferred,
             repaired: head.repaired || [] };
  }

  const { index } = head;
  const rows = [];
  let skipped = 0, unlinked = 0;

  for (const raw of grid.slice(head.at + 1)) {
    const institution = text(redactEmails(cell(raw, index, 'institution')), 160);
    const posted = sheetDay(cell(raw, index, 'posted'));

    /* A row needs a name and a date: the date is half its identity (jobId is
       year + institution + date), so without one this school's advertisement
       cannot be told from its next one. This is also what skips the legend and
       total lines a tracking sheet keeps under its data — and, when the
       columns were inferred, the header row itself. */
    if (!institution || !posted) {
      if (institution || posted) skipped++;
      continue;
    }

    /* WHICH SEASON A POSTING BELONGS TO. The site's own roll rule reads it off
       the posting's date — a job advertised from 1 July 2026 belongs to market
       year 2027 — and that is right for all but one case, which the tracking
       sheet produces every spring: a school advertising EARLY for the season
       after next. Twenty-four of the 2026 Jobs tab's eighty-nine postings are
       dated April to June 2026, the two oldest saying so in their own comment
       ("an expected start date of July 1, 2027"). By date alone all
       twenty-four file under the season that has just closed, which is the one
       page they are of no use on.

       The tab settles it, because naming the cycle is the whole reason it
       exists — this one was created, by the sheet's own contributors, when
       they agreed the 2026-2027 market had opened. So the tab's cycle is a
       FLOOR on the market year, never a ceiling: it can carry a posting
       forward into the season its tab was made for, and can never push one
       back into a season that has closed. A row added late to an old tab
       therefore keeps the later year its date gives it, and nothing already
       published moves. */
    const year = Math.max(marketYear(new Date(`${posted}T12:00:00Z`)), cycleYear || 0);
    if (minYear && year < minYear) { skipped++; continue; }

    const area = text(redactEmails(cell(raw, index, 'area')), 220);
    const rank = text(redactEmails(cell(raw, index, 'rank')), 160);
    const city = text(redactEmails(cell(raw, index, 'city')), 120);
    const notes = text(redactEmails(cell(raw, index, 'notes')), 600);

    const linkCell = text(cell(raw, index, 'link'), 500);
    const link = HAS_EMAIL.test(linkCell) ? '' : url(linkCell);
    if (!link && linkCell) unlinked++;

    const deadlineProse = text(redactEmails(cell(raw, index, 'deadline')), 200);
    /* Prose that says the search stays open beats a parsed date, exactly as at
       every other ingest — the page buckets "Until filled" on the date being
       EMPTY, so a row carrying both would read as dated. */
    const openEnded = OPEN_ENDED_RX.test(deadlineProse);
    /* …and a parsed date is only BELIEVED when it is plausible against the
       posting date (see deadlineDay): a deadline the pipeline is unsure of
       publishes as "Until filled.", never as a guess. */
    const deadline = openEnded ? '' : deadlineDay(deadlineProse, posted);

    /* One spelling per university, school and department — the same canon the
       form and the other importer apply, so a row this workbook contributes
       merges with the postings around it instead of adding a spelling. */
    const place = canonPlace({ institution, ...splitDepartment(area) });

    /* What the sheet knows that the site's own shape has no field for: the job
       title as advertised (five entry levels cannot carry "Professor of
       Practice — Decision & Information Sciences") and the town. Dropping
       either would lose the most useful thing on the row, so both are carried
       in the line the card already shows for prose — as is a deadline cell
       that could not be believed as a date, so the sheet's own words reach
       the review card instead of vanishing behind "Until filled." */
    const comments = [
      rank && !LEVELS.includes(rank) ? rank : '',
      city,
      notes,
      deadlineProse && !openEnded && !deadline ? `Deadline as listed: ${deadlineProse}` : '',
    ].filter(Boolean).join(' · ').slice(0, 1200);

    const row = {
      id: '',
      year,
      posted,
      institution: place.institution || institution,
      department: joinDepartment(place.school, place.unit) || area,
      school: place.school,
      unit: place.unit,
      /* judged over the WHOLE posting's text — the field column, the
         advertised title, the notes and the advertisement's own address, any
         of which saying "business" flags it under Business School (owner,
         2026-08-23; the review card then names the school the site knows) */
      type: typeFromNames(place.institution || institution, area, rank, notes, linkCell),
      levels: levelsFromRank(rank, kind),
      /* No deadline column, or an empty cell, reads as "Until filled." — the
         same rule import-sheet.mjs applies to the other spreadsheet, and not a
         new claim: the page ALREADY buckets a posting with no closing date
         under "Until filled" in its Deadline filter (assets/oa-list.js), so
         leaving the line empty would make the card silent about something the
         filter is already saying, and drop a row the card is expected to have.
         A date in the sheet is shown as a date; prose that says the search
         stays open is shown as the sheet wrote it. */
      applyBy: openEnded ? deadlineProse : (deadline ? longDate(deadline) : 'Until filled.'),
      applyByDate: openEnded ? '' : deadline,
      comments,
      country: canonCountry(text(cell(raw, index, 'country'), 60)),
      adUrl: link,
      adLabel: 'link to Job ad',
      postedAtUrl: '',
      postedAtLabel: 'link',
      /* from the CANONICAL name, like every other writer of this link: built
         from the sheet's own spelling it asks the Universities page for a
         university under a name the row itself no longer uses, and lands on
         nothing (jobs-model.universitiesLink) */
      furtherInfoUrl: universitiesLink(place.institution || institution),
      characteristics: [],
      featured: false,
      source: SOURCE,
      // stamped by stampAddedAt(), the only place that knows what the dataset
      // already held — see the note on PUBLIC_FIELDS.addedAt
      addedAt: '',
      owner: '',
      // provenance for the log; publicRow() keeps it out of the served file
      _tab: tab,
      _sheet: id,
    };
    row.id = jobId(row);
    rows.push(row);
  }

  return { rows, skipped, unmapped: head.unmapped || [], missing: [], unlinked,
           headerAt: head.at, inferred: !!head.inferred, repaired: head.repaired || [] };
}

/**
 * Every tab's rows, collapsed and given distinct ids.
 *
 * Two tabs of one workbook can hold the same school on the same day (a
 * department advertising a tenure-track and a teaching post together), and
 * jobId carries no department — so the same-day collapse runs first, keeping
 * the fuller row, and what still collides afterwards is a genuinely different
 * posting and takes a suffix, exactly as the other importers do it.
 */
export function collectRows(perTab) {
  const all = [].concat(...perTab.map((t) => t.rows || []));
  const { rows: kept, collapsed } = collapseSameDay(all);

  const seen = new Set();
  for (const r of kept) {
    let id = r.id, n = 2;
    while (seen.has(id)) id = `${r.id}-${n++}`;
    r.id = id;
    seen.add(id);
  }

  kept.sort(displayOrder);
  return { rows: kept, collapsed };
}

/**
 * When each row entered THIS dataset.
 *
 * It matters more than it looks: `addedAt` is the only cursor the e-mail
 * alerts have (oa-alert-match.js keeps a row when addedAt > lastSentAt), so
 * this decides who is told about what.
 *
 *   - a row already in the dataset keeps the stamp it has. Re-reading the
 *     sheet must never re-announce a posting.
 *   - the FIRST run is a backfill of a whole season and must announce nothing,
 *     so every row is dated from the day it was advertised.
 *   - after that a new row is genuinely new and is stamped `now` — unless it
 *     was advertised more than BACKDATE_DAYS ago, which means the maintainer
 *     has just added an OLD posting to the sheet. That is a catch-up, not
 *     news, and mailing a month-old advertisement as new is how a digest loses
 *     its readers.
 */
export function stampAddedAt(rows, existing = [], {
  now = new Date(), backdateDays = BACKDATE_DAYS,
} = {}) {
  const was = new Map();
  for (const r of existing) if (r && r.id) was.set(r.id, r.addedAt || '');

  const backfill = existing.length === 0;
  const cutoff = new Date(now.getTime() - backdateDays * 86400e3).toISOString().slice(0, 10);
  const stampNow = isoStamp(now);

  let fresh = 0;
  for (const r of rows) {
    const before = was.get(r.id);
    if (before) { r.addedAt = before; continue; }
    fresh++;
    r.addedAt = (backfill || (r.posted && r.posted < cutoff))
      ? `${r.posted}T00:00:00Z`
      : stampNow;
  }
  return { rows, fresh, backfill };
}

/* --------------------------------------------------------------- the file */

/** Only the published fields, in the published order — the same projection
    jobs.json uses, so the two files can be compared row for row. */
export function serialiseSheetRows(rows) {
  return JSON.stringify(rows.map(publicRow), null, 1) + '\n';
}

export function buildSheetMeta(rows, { generated, sheets = [], tabs = [] } = {}) {
  return {
    generated,
    count: rows.length,
    newestPosted: rows.reduce((m, r) => (r.posted > m ? r.posted : m), ''),
    oldestPosted: rows.reduce((m, r) => (!m || (r.posted && r.posted < m) ? r.posted : m), ''),
    years: tally(rows, (r) => String(r.year)),
    countries: tally(rows, (r) => r.country),
    levels: tally(rows, (r) => r.levels),
    sheets,
    tabs,
  };
}

function tally(rows, get) {
  const c = Object.create(null);
  for (const r of rows) for (const v of [].concat(get(r) ?? [])) if (v) c[v] = (c[v] || 0) + 1;
  return Object.fromEntries(
    Object.entries(c).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])));
}

/* --------------------------------------------------------- did it go quiet?

   The whole point of the e-mail. A sheet that stops being updated looks
   exactly like a quiet job market from the site, so the difference has to be
   made visible deliberately.                                                  */

/**
 * `{ stale, reason, detail, days, newestPosted }`.
 *
 * Four reasons, and the unreadable one is the most urgent: a sheet nobody can
 * read has usually had its sharing changed, and every day it stays that way is
 * a day of postings not arriving.
 */
export function stalenessOf({
  ok = true, error = '', rows = 0, newestPosted = '', deadTabs = [],
  now = new Date(), days = STALE_DAYS,
} = {}) {
  if (!ok) {
    return { stale: true, reason: 'unreadable', days: null, newestPosted,
             detail: String(error || 'the sheet could not be read') };
  }
  if (!rows) {
    return { stale: true, reason: 'empty', days: null, newestPosted,
             detail: 'the sheet was read but held no postings' };
  }
  if (!newestPosted) {
    return { stale: true, reason: 'undated', days: null, newestPosted,
             detail: 'no posting in the sheet carries a usable date' };
  }

  /* A tab that was read and gave nothing, while the rest of the workbook is
     healthy. Checked BEFORE the age test on purpose: this is the failure that
     looks most like a quiet market from the outside — postings are being
     added and none of them arrive — and it is the one a person has to fix. */
  if (deadTabs.length) {
    return { stale: true, reason: 'unread-tab', days: null, newestPosted,
             tabs: deadTabs.slice(),
             detail: `no posting could be taken from ${deadTabs.length === 1
               ? `the tab "${deadTabs[0]}"` : `the tabs ${deadTabs.map((t) => `"${t}"`).join(', ')}`}` };
  }

  const age = daysBetween(newestPosted, now.toISOString().slice(0, 10));
  if (age != null && age > days) {
    return { stale: true, reason: 'quiet', days: age, newestPosted,
             detail: `no new posting for ${age} days` };
  }
  return { stale: false, reason: '', detail: '', days: age, newestPosted };
}

/**
 * Should this run actually SEND the warning?
 *
 * Once, then not again for STALE_REPEAT_DAYS — a daily e-mail saying the same
 * thing is one nobody opens, which would defeat the feature. A warning of a
 * DIFFERENT kind (it was quiet; now it cannot be read at all) is new
 * information and goes out at once.
 */
export function shouldWarn(state = {}, check, {
  now = new Date(), repeatDays = STALE_REPEAT_DAYS,
} = {}) {
  if (!check || !check.stale) return false;
  const last = state.lastWarnedAt ? Date.parse(state.lastWarnedAt) : NaN;
  if (!Number.isFinite(last)) return true;
  if (state.lastReason && state.lastReason !== check.reason) return true;
  return now.getTime() - last >= repeatDays * 86400e3;
}

/* ------------------------------------------------------------ the registry

   Which workbooks are known, which are read, and which is current. Committed
   as data/jobmarket-sheets.json, so the chain survives a runner that keeps
   nothing between runs.                                                       */

export function emptyRegistry(seed = SEED_SHEET_ID) {
  return {
    generated: '',
    current: seed,
    sheets: [{ id: seed, from: 'seed', discoveredAt: '', lastReadAt: '',
               rows: 0, newestPosted: '', tabs: [] }],
    staleness: { lastCheckedAt: '', lastWarnedAt: '', lastReason: '', newestPosted: '' },
  };
}

/** Add a workbook the intro tab pointed at. Returns the entries actually added. */
export function adoptSheets(registry, ids, { from = '', now = new Date() } = {}) {
  registry.sheets = registry.sheets || [];
  const known = new Set(registry.sheets.map((s) => s.id));
  const added = [];
  for (const id of ids) {
    if (!id || known.has(id)) continue;
    known.add(id);
    const entry = { id, from: from ? `intro:${from}` : 'intro', discoveredAt: isoStamp(now),
                    lastReadAt: '', rows: 0, newestPosted: '', tabs: [] };
    registry.sheets.push(entry);
    added.push(entry);
  }
  return added;
}

/**
 * Which workbooks to read this run.
 *
 * The current one, plus anything discovered from it that has not proved itself
 * yet, plus any other that is still producing rows. Reading the PREDECESSOR
 * for a while is the point: the roll happens on a date, but the maintainer
 * keeps filing the last postings of the old cycle into the old workbook for
 * weeks afterwards, and a pipeline that switched over cleanly on 1 July would
 * drop them.
 *
 * Bounded, because every extra workbook is a fetch of its HTML and of every
 * one of its tabs.
 */
export function activeSheets(registry, { limit = 3 } = {}) {
  const all = registry.sheets || [];
  const out = [];
  const push = (s) => { if (s && !out.includes(s.id)) out.push(s.id); };

  push(all.find((s) => s.id === registry.current));
  for (const s of all) if (s.id !== registry.current && !s.lastReadAt) push(s);   // untried
  for (const s of all) if (s.id !== registry.current && s.rows > 0) push(s);      // still live

  return out.slice(0, Math.max(1, limit));
}

/**
 * Move `current` on when a successor has actually started carrying the market.
 *
 * The test is EVIDENCE, never the calendar: a workbook created in advance and
 * left empty must not become current, or the site would follow an empty sheet
 * for weeks. It becomes current once it holds a posting NEWER than anything in
 * the workbook it replaces — which is what "the new cycle has started" means.
 *
 * Returns the entry it moved to, or null.
 */
export function rollRegistry(registry, { now = new Date() } = {}) {
  const all = registry.sheets || [];
  const cur = all.find((s) => s.id === registry.current);
  let moved = null;

  for (const s of all) {
    if (s.id === registry.current || !s.rows || !s.newestPosted) continue;
    if (cur && cur.newestPosted && s.newestPosted <= cur.newestPosted) continue;
    if (!moved || s.newestPosted > moved.newestPosted) moved = s;
  }

  if (moved) {
    registry.previous = registry.current;
    registry.current = moved.id;
    registry.rolledAt = isoStamp(now);
  }
  return moved;
}

/* --------------------------------------------------------------- selftest */

if (import.meta.url === `file://${process.argv[1]}`) {
  // the whole suite — runSelftest()'s subset covers none of this file
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath: toPath } = await import('node:url');
  const here = toPath(new URL('.', import.meta.url));
  const r = spawnSync(process.execPath, [here + 'selftest.mjs'], { stdio: 'inherit' });
  process.exit(r.status === 0 ? 0 : 1);
}
