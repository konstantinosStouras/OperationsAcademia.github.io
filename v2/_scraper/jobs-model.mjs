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

/** The published fields, in the order they are written. Anything not listed
    here never reaches data/jobs.json — which is how submitter and chair
    e-mail addresses stay out of a public repository. */
export const PUBLIC_FIELDS = [
  'id', 'year', 'posted', 'institution', 'department', 'type', 'levels',
  'applyBy', 'applyByDate', 'comments', 'country',
  'adUrl', 'adLabel', 'postedAtUrl', 'postedAtLabel', 'furtherInfoUrl',
  'characteristics', 'featured', 'source', 'addedAt', 'ref',
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
  institution: 160, department: 220, country: 60, applyBy: 400,
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

/* ------------------------------------------------------------- the mapping */

/**
 * A Firestore `jobSubmissions` document -> a published row, or null when the
 * submission is not publishable. The client already validated; this validates
 * AGAIN because the client is not trusted with what reaches a served file.
 */
export function rowFromSubmission(doc, { now = new Date() } = {}) {
  const institution = text(doc.institution, MAXLEN.institution);
  const department = text(doc.department, MAXLEN.department);
  const country = text(doc.country, MAXLEN.country);
  const levels = pickList(doc.levels, LEVELS);
  const type = TYPES.includes(text(doc.type, 40)) ? text(doc.type, 40) : '';

  // the minimum a card needs to be worth rendering
  if (!institution || !department || !country || !type || !levels.length) return null;

  const year = Number.isFinite(+doc.year) && +doc.year >= 2000 && +doc.year <= 2100
    ? Math.trunc(+doc.year)
    : marketYear(now);

  const posted = day(doc.postedOn) || isoDay(tsToDate(doc.createdAt) || now);
  const applyByDate = doc.untilFilled ? '' : day(doc.applyByDate);

  // What the card shows on the "Apply by" line. The sheet stored this as one
  // free-text field ("November 1, 2025. Early submissions are encouraged."), so
  // the date and the note are recombined into the same shape.
  const note = text(doc.applyByNote, MAXLEN.applyBy);
  const applyBy = doc.untilFilled
    ? (note ? `Until filled. ${note}` : 'Until filled.')
    : [applyByDate ? longDate(applyByDate) : '', note].filter(Boolean).join('. ');

  const row = {
    id: '',
    year,
    posted,
    institution,
    department,
    type,
    levels,
    applyBy: text(applyBy, MAXLEN.applyBy),
    applyByDate,
    comments: text(doc.comments, MAXLEN.comments),
    country,
    adUrl: url(doc.adUrl),
    adLabel: 'link to Job ad',
    postedAtUrl: url(doc.postedAtUrl),
    postedAtLabel: 'link',
    furtherInfoUrl: `https://www.operationsacademia.org/universities?filterA=${encodeURIComponent(institution)}`,
    characteristics: pickList(doc.characteristics, CHARACTERISTICS),
    featured: doc.featured === true,
    source: 'oa-form',
    addedAt: isoStamp(tsToDate(doc.createdAt) || now),
    ref: text(doc.ref, 40),
  };
  row.id = jobId(row);
  return row;
}

function tsToDate(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof ts.toDate === 'function') return ts.toDate();          // Firestore Timestamp
  if (typeof ts === 'number') return new Date(ts);
  const d = new Date(ts);
  return Number.isNaN(+d) ? null : d;
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
  for (const k of PUBLIC_FIELDS) if (row[k] !== undefined) out[k] = row[k];
  return out;
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
  return fullness(a) >= fullness(b) ? a : b;
}

function sameDayKey(row) {
  return [row.year, slug(row.institution), slug(row.department), row.posted].join('|');
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

/** Two rows are the same posting when they carry the same reference, or the
    same id. A school re-posting the same job next year differs in `year`, so
    it is correctly a different row. */
function keyOf(row) {
  return row.ref ? 'ref:' + row.ref : 'id:' + row.id;
}

/**
 * Merge freshly-built rows into the committed ones.
 *   - a new row is appended
 *   - a row already present is REPLACED (a poster corrected their posting)
 *   - a ref listed in `remove` is dropped (withdrawn, or hidden by the maintainer)
 * Returns { rows, added, updated, removed } with rows in display order.
 */
export function mergeRows(existing, fresh, remove = []) {
  const drop = new Set(remove.filter(Boolean).map((r) => 'ref:' + r));
  const by = new Map();
  for (const r of existing) by.set(keyOf(r), r);

  let added = 0, updated = 0;
  for (const r of fresh) {
    const k = keyOf(r);
    if (by.has(k)) updated++; else added++;
    by.set(k, r);
  }

  let removed = 0;
  for (const k of drop) if (by.delete(k)) removed++;

  /* Collapse AFTER the merge, not only on the way in, so repeats already
     committed heal on the next run. They cannot heal themselves otherwise: a
     merge adds, replaces and removes by key, and the duplicates carry distinct
     keys (`<id>-2`, `<id>-3`) — which is precisely why eight of them sat in
     the served file. */
  const { rows: kept, collapsed } = collapseSameDay([...by.values()]);

  const rows = kept.sort(displayOrder);
  return { rows, added, updated, removed, collapsed };
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
