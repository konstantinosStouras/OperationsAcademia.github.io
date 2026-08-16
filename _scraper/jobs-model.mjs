/* ---------------------------------------------------------------------------
   Operations Academia — the job posting row model.

   ONE definition of what a row in v2/data/jobs.json is, shared by everything
   that writes one:

     build-jobs.mjs    Firestore submissions -> rows          (the live path)
     import-sheet.mjs  the old Google Sheet CSV -> rows       (the migration)
     selftest.mjs      checks both against this

   Keeping it here is what stops the migration and the live path from drifting
   into two subtly different shapes — the failure that would only show up as
   cards that render differently depending on when they were posted.

   Every function is PURE and needs no network, so the selftest can cover the
   whole model offline.
   --------------------------------------------------------------------------- */

import { createHash } from 'node:crypto';

import { splitDepartment, joinDepartment } from './vocab.mjs';

/** The published fields, in the order they are written. Anything not listed
    here never reaches data/jobs.json — which is how submitter and chair
    e-mail addresses stay out of a public repository.

    `addedAt` means ONE thing in every writer: the moment the row entered this
    dataset, not the day the poster says they advertised (that is `posted`).
    It is the only cursor the e-mail alerts have — oa-alert-match.js keeps a
    row when `addedAt > lastSentAt` — so a writer that back-dates it to
    midnight hides every posting it adds from every subscriber whose last
    digest went out later that day, permanently. */
export const PUBLIC_FIELDS = [
  'id', 'year', 'posted', 'institution', 'department', 'school', 'unit', 'type', 'levels',
  'applyBy', 'applyByDate', 'comments', 'country',
  'adUrl', 'adLabel', 'postedAtUrl', 'postedAtLabel', 'furtherInfoUrl',
  'characteristics', 'featured', 'source', 'addedAt', 'ref', 'owner',
];

export const LEVELS = [
  'Assistant Professor',
  'Other Ranks',
  'Post-Doc',
  'Non-tenure track (teaching) position',
  'Visiting Faculty (various levels)',
];

export const CHARACTERISTICS = [
  'Research seminars', 'PhD', 'Masters', 'MBA', 'Undergrad', 'Exec Ed',
];

export const TYPES = ['Business School', 'University'];

const MAXLEN = {
  institution: 160, department: 220, school: 160, unit: 160, country: 60, applyBy: 400,
  comments: 1200, adUrl: 500, postedAtUrl: 500, furtherInfoUrl: 500,
  adLabel: 60, postedAtLabel: 60,
};

/* -------------------------------------------------------------- sanitisers */

export function text(v, max = 400) {
  return String(v ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** An http(s) URL, or ''. Anything else — javascript:, data:, a bare word —
    is dropped rather than repaired: the page renders these as links. */
export function url(v) {
  const s = String(v ?? '').trim();
  if (!/^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/i.test(s)) return '';
  return s.slice(0, 500);
}

/** An ISO yyyy-mm-dd day, or ''. Accepts the forms the old sheet used. */
export function day(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return valid(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);           // US, as Forms wrote it
  if (m) return valid(m[3], m[1], m[2]);
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);       // "November 1, 2025"
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1;
    if (mo) return valid(m[3], String(mo), m[2]);
  }
  return '';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function valid(y, m, d) {
  const yy = +y, mm = +m, dd = +d;
  if (!(yy >= 1990 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return '';
  const t = new Date(Date.UTC(yy, mm - 1, dd));
  if (t.getUTCMonth() !== mm - 1 || t.getUTCDate() !== dd) return '';   // 31 Feb
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export function pickList(v, allowed) {
  const want = new Set(allowed);
  const seen = new Set();
  return (Array.isArray(v) ? v : [v])
    .map((x) => text(x, 80))
    .filter((x) => want.has(x) && !seen.has(x) && seen.add(x));
}

export function slug(s, n = 48) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, n)
    .replace(/-+$/, '');
}

export function jobId(row) {
  return `${row.year}-${slug(row.institution)}-${String(row.posted || '').replace(/-/g, '')}`;
}

/* ------------------------------------------------------------- who owns a row

   The ONE thing on a submission the browser cannot choose. `uid` is pinned by
   the security rules (`request.resource.data.uid == request.auth.uid`);
   everything else on the document — including `ref` — is whatever the poster's
   browser typed. So the merge identity is built from the uid, not from `ref`.

   It matters because `ref` is PUBLISHED in this very file. Keyed on `ref`
   alone, any signed-in account could read a reference out of data/jobs.json,
   create one submission carrying it, and REPLACE somebody else's advertisement
   — or flip that submission to 'withdrawn' (which the rules let its own owner
   do) and delete theirs.

   The uid itself is not published: it identifies a person across their
   postings, and PUBLIC_FIELDS exists to keep exactly that out of a public
   repository. A short digest is enough, because an attacker cannot choose
   their own uid — Firebase assigns it — so there is nothing to collide with.
   `ref` stays what it always was: a reference number the poster can quote.  */

export function ownerTag(uid) {
  const s = String(uid ?? '').trim();
  if (!s) return '';
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/* --------------------------------------------------------- the market year

   ONE definition, because there were two: rowFromSubmission derived the year
   for a submission that did not carry one, and import-sheet.mjs derived the
   same value again to decide what is in scope. Two copies of a rule that rolls
   once a year drift silently, and the page heading — a third copy, typed by
   hand — had already drifted a whole season behind by August 2026.           */

/**
 * The job-market year a moment falls in.
 *
 * A market year runs **1 July of the previous year to 30 June of its own**, and
 * is numbered by the year it ENDS — market 2027 is 1 Jul 2026 – 30 Jun 2027 —
 * matching the sheet's own "Job Market Year" column. So the roll is on 1 JULY,
 * and 30 June is the last day of the season under way.
 *
 * The month index is the whole rule, so it is spelled out: getUTCMonth() is
 * 0-based, JULY is 6.
 */
export const MARKET_ROLL_MONTH = 6; // July, 0-based

export function marketYear(now = new Date()) {
  return now.getUTCFullYear() + (now.getUTCMonth() >= MARKET_ROLL_MONTH ? 1 : 0);
}

/** 2027 -> "2026-2027", the way the page heading names a season. */
export function marketLabel(year) {
  const y = Math.trunc(Number(year));
  return `${y - 1}-${y}`;
}

/**
 * How many market years the jobs page carries, counting back from the current
 * one. TWO, deliberately, and this is the one number to change if that is
 * wrong.
 *
 * One season is what the page's title implies and what the vendor page did.
 * Measured against the real data on 2026-08-15 it would have cut the list from
 * 102 postings to 7, and 38 of the 95 dropped were still live — 2 open by
 * their own deadline and 36 "until filled". Postings are also still ARRIVING
 * tagged with the previous season (the newest market-2026 row was submitted
 * 2026-07-28, six weeks after the roll), because the poster picks that field
 * by hand. So a single-season window drops advertisements that are open for
 * applications, which is the one thing this page exists to show.
 */
export const MARKET_WINDOW = 2;

/** The oldest market year in scope at `now`. */
export function marketFloor(now = new Date(), window = MARKET_WINDOW) {
  return marketYear(now) - (Math.max(1, window) - 1);
}

/** The first day of the market year under way at `now`, as an ISO day —
    1 July of the year the season started. */
export function marketStart(now = new Date()) {
  return `${marketYear(now) - 1}-07-01`;
}

/**
 * Does this row belong on THE JOBS PAGE, which shows only the market year
 * under way? (Owner decision 2026-08-16, superseding the two-season window:
 * the previous seasons live at /v1 and in the git history, not on the page.)
 *
 * A row qualifies EITHER way it can say so:
 *   - it was POSTED inside the current market year (on or after 1 July), or
 *   - its poster TAGGED it for the current market year or a later one.
 *
 * Both legs are needed. Posting date alone would drop a posting filed in May
 * for the season starting in September (the 2028 Kansas row); the tag alone
 * would drop postings still being filed under the previous season's label
 * weeks after the roll (the July Mannheim row) — the poster picks that field
 * by hand and is often a season behind.
 *
 * Note MARKET_WINDOW above still governs the SHEET IMPORT's reach, on
 * purpose: the import must capture late filings under the old label so this
 * predicate — not the import's scope — is what decides the page.
 */
export function inCurrentMarket(row, now = new Date()) {
  return String(row.posted || '') >= marketStart(now)
      || Number(row.year) >= marketYear(now);
}

/* ------------------------------------------------------------- the mapping */

/**
 * A Firestore `jobSubmissions` document -> a published row, or null when the
 * submission is not publishable. The client already validated; this validates
 * AGAIN because the client is not trusted with what reaches a served file.
 */
export function rowFromSubmission(doc, { now = new Date() } = {}) {
  const institution = text(doc.institution, MAXLEN.institution);
  const country = text(doc.country, MAXLEN.country);
  const levels = pickList(doc.levels, LEVELS);
  const type = TYPES.includes(text(doc.type, 40)) ? text(doc.type, 40) : '';

  /* School and unit are now two fields the poster picks separately, and
     `department` is the line the card shows, derived from them. A submission
     made before the form was split — and every row imported from the sheet —
     carries only `department`, so it is taken apart instead. Either way a row
     ends up with all three, and the published line reads the same as it always
     did. */
  const given = text(doc.school, MAXLEN.school) || text(doc.unit, MAXLEN.unit);
  const parts = given
    ? { school: text(doc.school, MAXLEN.school), unit: text(doc.unit, MAXLEN.unit) }
    : splitDepartment(text(doc.department, MAXLEN.department));
  const school = text(parts.school, MAXLEN.school);
  const unit = text(parts.unit, MAXLEN.unit);
  const department = text(joinDepartment(school, unit), MAXLEN.department);

  // the minimum a card needs to be worth rendering
  if (!institution || !department || !country || !type || !levels.length) return null;

  const year = Number.isFinite(+doc.year) && +doc.year >= 2000 && +doc.year <= 2100
    ? Math.trunc(+doc.year)
    : marketYear(now);

  /* `posted` is the page's primary sort key, so a value the client picks is a
     value the client can use to pin its own card to the top of the list for
     ever. The form does not send `postedOn` and the rules do not mention it,
     so it is honoured only when it is no LATER than the moment the submission
     was actually stored — a poster may say a posting went up earlier, never
     that it goes up in 2100. */
  const stamped = isoDay(tsToDate(doc.createdAt) || now);
  const asked = day(doc.postedOn);
  const posted = asked && asked <= stamped ? asked : stamped;
  const applyByDate = doc.untilFilled ? '' : day(doc.applyByDate);

  // What the card shows on the "Apply by" line. The sheet stored this as one
  // free-text field ("November 1, 2025. Early submissions are encouraged."), so
  // the date and the note are recombined into the same shape.
  /* `applyByText` is a VERBATIM override, and exists for one reason: four
     postings imported from the sheet carry prose that disagrees with their own
     parsed date ("March 13, 2026. Please apply…" against an applyByDate of
     2026-03-14 — the importer read the date from the raw tab and the prose from
     the display tab). Re-composing those would quietly change the date a reader
     sees, so the migration carries the original line instead. A posting made
     through the form never sets it, and composition applies as it always did. */
  const applyBy = text(doc.applyByText, MAXLEN.applyBy) || composeApplyBy({
    untilFilled: doc.untilFilled, applyByDate, applyByNote: doc.applyByNote,
  });

  const row = {
    id: '',
    year,
    posted,
    institution,
    department,
    school,
    unit,
    type,
    levels,
    applyBy: text(applyBy, MAXLEN.applyBy),
    applyByDate,
    comments: text(doc.comments, MAXLEN.comments),
    country,
    adUrl: url(doc.adUrl),
    /* These four were fixed values, which was right while every posting came
       from this form. The migration off the Google Sheet makes a document out
       of an EXISTING row, so they have to survive the round trip: the sheet
       carries its own link labels ("Operations Academia"), its own
       further-info URL, and a source that is not this form. Each still
       defaults to what it always was. */
    adLabel: text(doc.adLabel, MAXLEN.adLabel) || 'link to Job ad',
    postedAtUrl: url(doc.postedAtUrl),
    postedAtLabel: text(doc.postedAtLabel, MAXLEN.postedAtLabel) || 'link',
    furtherInfoUrl: url(doc.furtherInfoUrl) ||
      `https://www.operationsacademia.org/universities?filterA=${encodeURIComponent(institution)}`,
    characteristics: pickList(doc.characteristics, CHARACTERISTICS),
    featured: doc.featured === true,
    source: text(doc.source, 40) || 'oa-form',
    addedAt: isoStamp(tsToDate(doc.createdAt) || now),
    ref: text(doc.ref, 40),
    owner: ownerTag(doc.uid),
  };
  row.id = jobId(row);
  return row;
}

/** Any of the three shapes a stored timestamp arrives in, or null.
    TOTAL, deliberately: the validity check used to guard only the string
    branch, so `createdAt: 1e16` — a plain number the rules place no bound on —
    survived as an Invalid Date and threw RangeError out of toISOString() a few
    lines later, killing the whole publish run on that one document. It stayed
    queued, so every later run died on it too. */
function tsToDate(ts) {
  if (!ts) return null;
  let d;
  if (ts instanceof Date) d = ts;
  else if (typeof ts.toDate === 'function') d = ts.toDate();        // Firestore Timestamp
  else d = new Date(ts);
  return d instanceof Date && !Number.isNaN(+d) ? d : null;
}

export function isoDay(d) { return d.toISOString().slice(0, 10); }
export function isoStamp(d) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); }

export function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${names[m - 1]} ${d}, ${y}`;
}

/** Only the published fields, in a stable key order, so a rebuild that
    changes nothing produces a byte-identical file and commits nothing. */
export function publicRow(row) {
  const out = {};
  for (const k of PUBLIC_FIELDS) {
    if (row[k] === undefined) continue;
    // `ref` addresses a posting made through the site; a posting migrated off
    // the sheet has none, and writing `"ref": ""` onto every one of those rows
    // is 90-odd lines of noise in a file whose diff is meant to be readable.
    if (k === 'ref' && !row[k]) continue;
    out[k] = row[k];
  }
  return out;
}

/**
 * The "Apply by" line, composed from the three things a poster actually gives.
 * ONE definition, because `submissionFromRow` has to invert it exactly.
 */
export function composeApplyBy({ untilFilled, applyByDate, applyByNote }) {
  const note = text(applyByNote, MAXLEN.applyBy);
  if (untilFilled) return note ? `Until filled. ${note}` : 'Until filled.';
  return [applyByDate ? longDate(applyByDate) : '', note].filter(Boolean).join('. ');
}

/**
 * Give every row a distinct id, deterministically.
 *
 * `jobId` is (year, institution, posting date) and does NOT include the
 * department, so two genuinely different postings from one institution on one
 * day derive the SAME id — Tulane advertised two Freeman departments on
 * 2026-04-07, and Houston two on 2025-09-23. The sheet importer had always
 * disambiguated those with a `-2` suffix; the Firestore build had no
 * equivalent, so the second row simply overwrote the first in the merge and
 * two real postings vanished from the site the moment it became the source of
 * truth.
 *
 * Entries are `{ key, row }` where `key` is the document id. Sorting by it
 * before assigning is what makes the result STABLE: the same posting keeps the
 * same id on every build, rather than the suffix landing on whichever document
 * Firestore happened to return first.
 */
export function assignIds(entries) {
  const ordered = entries.slice().sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const seen = new Set();
  for (const e of ordered) {
    const base = jobId(e.row);
    let id = base, n = 2;
    while (seen.has(id)) id = `${base}-${n++}`;
    e.row.id = id;
    seen.add(id);
  }
  return entries;
}

/* ------------------------------------------------ a row back into a submission

   The migration off the Google Sheet needs every existing posting to become a
   document that can be edited, and the only faithful way to build one is to
   invert the mapping above. Inverting it is also how the migration is CHECKED:
   `rowFromSubmission(submissionFromRow(row))` must reproduce the row, which the
   selftest asserts over every committed posting. A migration that cannot
   round-trip is one that silently rewrites the site's content.               */

/**
 * A published row -> the `jobSubmissions` document it would have come from.
 *
 * `applyBy` is the awkward one: the row keeps it as one line of prose that the
 * mapping BUILT from a date, a note and an until-filled flag, so those three
 * are recovered from it rather than guessed.
 */
export function submissionFromRow(row, { uid = null, status = 'published' } = {}) {
  const applyBy = String(row.applyBy || '');
  let untilFilled = false;
  let applyByNote = '';

  /* `&& !row.applyByDate` matters: one imported posting reads "Until filled…"
     yet carries a real deadline date too. Reading it as until-filled would make
     the mapping CLEAR that date, losing it — so a row with a date is never
     treated as until-filled, and its prose is carried verbatim instead. */
  if (/^until filled/i.test(applyBy.trim()) && !row.applyByDate) {
    untilFilled = true;
    applyByNote = applyBy.trim().replace(/^until filled\.?\s*/i, '');
  } else if (row.applyByDate) {
    const lead = longDate(row.applyByDate);
    applyByNote = applyBy.startsWith(lead)
      ? applyBy.slice(lead.length).replace(/^\.\s*/, '')
      : applyBy;
  } else {
    applyByNote = applyBy;
  }

  const composed = composeApplyBy({ untilFilled, applyByDate: row.applyByDate, applyByNote });

  return {
    ref: row.ref || '',
    uid,
    status,
    // only when the line cannot be rebuilt from its parts — see applyByText
    ...(composed === applyBy ? {} : { applyByText: applyBy }),
    year: row.year,
    postedOn: row.posted,
    institution: row.institution || '',
    school: row.school || '',
    unit: row.unit || '',
    department: row.department || '',
    type: row.type || '',
    levels: (row.levels || []).slice(),
    country: row.country || '',
    untilFilled,
    applyByDate: row.applyByDate || '',
    applyByNote,
    comments: row.comments || '',
    adUrl: row.adUrl || '',
    postedAtUrl: row.postedAtUrl || '',
    furtherInfoUrl: row.furtherInfoUrl || '',
    characteristics: (row.characteristics || []).slice(),
    featured: !!row.featured,
    source: row.source || 'sheet-import',
    adLabel: row.adLabel || '',
    postedAtLabel: row.postedAtLabel || '',
    createdAt: row.addedAt || '',
  };
}

/* --------------------------------------------------------- same-day repeats

   The Google Form has no edit step, so a poster who wanted to change something
   submitted the whole thing again. The sheet therefore holds four Tulane rows
   for 2026-04-07 and three Hong Kong PolyU rows for 2025-06-05, and the vendor
   page rendered every one of them — which is why the live list shows the same
   school three times in a row.                                                */

/** How much a row carries, so the fullest of a set of repeats is the one kept.
    An advertisement link counts double: it is the field a reader came for. */
function fullness(row) {
  let n = 0;
  for (const k of PUBLIC_FIELDS) {
    const v = row[k];
    if (Array.isArray(v) ? v.length : (v !== '' && v !== null && v !== undefined && v !== false)) n++;
  }
  if (row.adUrl) n += 2;
  if (row.featured) n += 1;
  return n;
}

/**
 * Which of two repeats to keep. Ownership FIRST, and not as a bonus that a
 * wordier row can outweigh: a posting made on the site carries a `ref`, and
 * its author can correct or withdraw it through their account. Dropping that
 * in favour of an anonymous sheet row describing the same job would strand
 * them — the posting would stay on the page with no way for them to touch it.
 * Only between two rows of equal standing does fullness decide.
 */
function better(a, b) {
  if (!!a.ref !== !!b.ref) return a.ref ? a : b;

  if (a.ref && b.ref) {
    const at = String(a.addedAt || ''), bt = String(b.addedAt || '');
    /* Two submissions from the SAME account for one posting on one day. There
       is no edit step — the form mints a fresh reference on every send — so
       sending it again is the only way a poster can correct anything, and the
       LATER one is by definition what they meant to say. Fullness cannot
       decide this: a correction that changes a value without adding a field
       (a wrong link, a typo'd deadline) ties, and the tie handed it to the
       stale row, which then stayed on the page. */
    if ((a.owner || '') === (b.owner || '')) return at >= bt ? a : b;
    /* Two DIFFERENT accounts describing one posting is not a correction —
       nobody can correct somebody else's advertisement. Whoever posted first
       keeps the slot, or anyone could displace a posting by submitting a
       wordier copy of it. */
    return at <= bt ? a : b;
  }

  return fullness(a) >= fullness(b) ? a : b;
}

/* The key is IDENTITY, so it must not be truncated. `slug()` caps at 48
   characters to keep an id short, and departments here are routinely written
   "<long school name>, Department of <field>" — 46 of the 94 shipped rows have
   a department slug at that cap — so two genuinely different departments
   agreed on the key and one advertisement was silently dropped as a repeat. */
function normKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function sameDayKey(row) {
  return [row.year, normKey(row.institution), normKey(row.department), row.posted].join('|');
}

/**
 * Collapse repeat submissions of ONE posting — same market year, institution,
 * department and posting date — keeping the fullest.
 *
 * Deliberately narrow: only the same DAY collapses. A school advertising again
 * weeks later, or in the next market year, is a genuinely different posting;
 * telling a re-advertisement from a correction needs a judgement this cannot
 * make, and merging them would silently drop a real advertisement. So the
 * spread-apart repeats in the data (UCL across September-November 2025,
 * Virginia across two seasons) are LEFT ALONE.
 *
 * Returns { rows, collapsed } with rows in their original order.
 */
export function collapseSameDay(rows) {
  const best = new Map();
  const order = [];

  for (const row of rows) {
    const k = sameDayKey(row);
    if (!best.has(k)) {
      best.set(k, row);
      order.push(k);
    } else {
      best.set(k, better(best.get(k), row));
    }
  }

  return { rows: order.map((k) => best.get(k)), collapsed: rows.length - order.length };
}

/* -------------------------------------------------------------------- merge */

/** Two rows are the same posting when the same ACCOUNT carries the same
    reference, or when they share an id. The owner tag is half the key on
    purpose — see ownerTag(): `ref` alone is client-chosen and published, so
    keyed on it a stranger's submission could replace or withdraw this row.
    A school re-posting the same job next year differs in `year`, so it is
    correctly a different row. */
export function keyOf(row) {
  return row.ref ? 'ref:' + (row.owner || '') + ':' + row.ref : 'id:' + row.id;
}

/**
 * Merge freshly-built rows into the committed ones.
 *   - a new row is appended
 *   - a row already present is REPLACED (a poster corrected their posting)
 *   - an entry in `remove` is dropped
 *
 * A `remove` entry is either `{ ref, owner }` — a WITHDRAWAL, which may only
 * take down a row the same account published — or a bare reference string,
 * which is the maintainer's committed take-down list (data/jobs-hidden.json)
 * and is trusted to reach a row whoever posted it.
 *
 * Returns { rows, added, updated, removed } with rows in display order.
 */
export function mergeRows(existing, fresh, remove = []) {
  const by = new Map();
  for (const r of existing) by.set(keyOf(r), r);

  let added = 0, updated = 0;
  for (const r of fresh) {
    const k = keyOf(r);
    const prev = by.get(k);
    if (prev) {
      updated++;
      /* `addedAt` records when this dataset FIRST saw the posting, and it is
         the only cursor the e-mail alerts have — a replacement (a same-day
         correction, a sheet re-read) must not re-stamp it, or every
         subscriber is alerted again about a posting they were already sent.
         import-sheet.mjs guards its own rows the same way (stampAddedAt). */
      if (prev.addedAt) r.addedAt = prev.addedAt;
    } else {
      added++;
    }
    by.set(k, r);
  }

  let removed = 0;
  for (const spec of remove) {
    if (!spec) continue;
    if (typeof spec === 'string') {
      for (const [k, r] of [...by]) if (r.ref === spec) { by.delete(k); removed++; }
    } else if (spec.ref) {
      if (by.delete('ref:' + (spec.owner || '') + ':' + spec.ref)) removed++;
    }
  }

  /* Collapse AFTER the merge, not only on the way in, so repeats already
     committed heal on the next run. They cannot heal themselves otherwise: a
     merge adds, replaces and removes by key, and the duplicates carry distinct
     keys (`<id>-2`, `<id>-3`) — which is precisely why eight of them sat in
     the served file. */
  const { rows: kept, collapsed } = collapseSameDay([...by.values()]);

  const rows = uniqueIds(kept.sort(displayOrder));
  return { rows, added, updated, removed, collapsed };
}

/**
 * Make every id unique, the way import-sheet.mjs already does on the way in.
 *
 * `jobId` carries year, institution and posting date but NOT department, so
 * two departments at one school advertising on one day produce the same id.
 * They are two real postings — collapseSameDay keeps both, correctly — and a
 * duplicate id is not cosmetic: the page keys each card's expanded state and
 * its DOM id on it, and selftest.mjs rejects the served file for it, AFTER the
 * build has already written the file and stamped Firestore. Deterministic,
 * because the input is already in display order.
 */
export function uniqueIds(rows) {
  const seen = new Set();
  return rows.map((r) => {
    if (!seen.has(r.id)) { seen.add(r.id); return r; }
    let id = r.id, n = 2;
    while (seen.has(id)) id = `${r.id}-${n++}`;
    seen.add(id);
    return { ...r, id };
  });
}

/** Featured first, then newest posting first, then institution — the order the
    page also sorts by, so the file reads the way the site does. */
export function displayOrder(a, b) {
  if (!!b.featured !== !!a.featured) return b.featured ? 1 : -1;
  const d = String(b.posted || '').localeCompare(String(a.posted || ''));
  if (d) return d;
  return String(a.institution || '').localeCompare(String(b.institution || ''));
}

/** The small companion file the page can read without downloading every row:
    counts, and the value vocabularies behind each filter. */
export function buildMeta(rows, { generated }) {
  const tally = (get) => {
    const c = Object.create(null);
    for (const r of rows) for (const v of [].concat(get(r) ?? [])) if (v) c[v] = (c[v] || 0) + 1;
    return Object.fromEntries(Object.entries(c).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])));
  };
  return {
    generated,
    count: rows.length,
    years: tally((r) => String(r.year)),
    types: tally((r) => r.type),
    levels: tally((r) => r.levels),
    countries: tally((r) => r.country),
    characteristics: tally((r) => r.characteristics),
    featured: rows.filter((r) => r.featured).length,
    newestPosted: rows.reduce((m, r) => (r.posted > m ? r.posted : m), ''),
  };
}

/** Stable JSON, one row per line-group, with a trailing newline — so a diff
    shows the postings that changed and nothing else. */
export function serialise(rows) {
  return JSON.stringify(rows.map(publicRow), null, 1) + '\n';
}
