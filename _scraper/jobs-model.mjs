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
import { createRequire } from 'node:module';

import { splitDepartment, joinDepartment } from './vocab.mjs';

/* One spelling per country, shared with the browser (assets/oa-countries.js is
   a dual-mode file, like oa-alert-match.js). Applied at EVERY ingest below, so
   a submission that says "USA" is published as "United States" and the jobs
   page's Location filter has one entry per country rather than one per
   spelling. Re-exported so the importers use the same function. */
const require = createRequire(import.meta.url);
export const { canon: canonCountry } = require('../assets/oa-countries.js');

/* One spelling per university, school and department, on exactly the same
   terms (assets/oa-schools.js). Applied at EVERY ingest below, so "Freeman
   School of Business, Management Sciences Area" and "A.B. Freeman School of
   Business, Management Science Department" are one department in the filters
   rather than two — and the archive's fused one-column rows are taken apart
   into the three fields the form now asks for. Re-exported so the importers
   use the same function. */
export const { canonPlace, canonColumns, canonSchool, canonUnit, canonInstitution,
  normalizeFixes, fixPlace } = require('../assets/oa-schools.js');

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
  'id', 'year', 'years', 'posted', 'institution', 'department', 'school', 'unit', 'type', 'levels',
  'applyBy', 'applyByDate', 'reviewDate', 'comments', 'country',
  'adUrl', 'adPending', 'adLabel', 'postedAtUrl', 'postedAtLabel', 'furtherInfoUrl',
  'characteristics', 'featured', 'source', 'addedAt', 'ref', 'owner',
];

/* Prose that means the search stays open. ONE definition: import-sheet.mjs
   clears parsed dates with it, rowFromSubmission clears stored dates with it,
   and the selftest rejects any served row whose applyBy matches it while a
   date is set — the page buckets "Until filled" purely on the date being
   empty, so a row carrying both would sort as dated and read as open-ended. */
export const OPEN_ENDED_RX = /until\s*filled|open\s*until|rolling/i;

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

/* An e-mail address, with or without its local part — the guard in
   selftest.mjs matches the bare `@domain.tld` tail, so the strip has to
   catch at least everything the guard does or a stripped row could still
   stop the publish. */
const EMAIL_RX = /[A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * Free text with any e-mail address removed.
 *
 * NOTHING UNDER data/ MAY CARRY AN E-MAIL — CI greps for it, and the
 * selftest's own copy of that guard refuses to let the build commit a
 * dataset holding one. That is right (a served file is a disclosure and a
 * harvest target), and it had a failure mode this repository documents
 * twice over: a guard firing on a LEGITIMATE row stops the whole site
 * publishing. On 2026-08-24 one posting arrived from Firestore with a
 * contact address in its text and every build from 03:14 committed
 * nothing. The address is the one thing the site will not serve, so it is
 * removed AT INGEST — the advertisement link carries the contact anyway —
 * and the marker says something was there rather than silently shortening
 * the sentence. Pure and idempotent, so every build re-applies it.
 */
export function stripEmails(v) {
  return String(v ?? '').replace(EMAIL_RX, '[e-mail removed]');
}

/**
 * A whole row, its free text stripped of e-mail addresses.
 *
 * Every own string field except the URLs: an address EMBEDDED in a stored
 * https link is vanishingly rare and rewriting one would break the link —
 * if it ever happens the guard still fires and a person decides, which is
 * the right order for a one-off. Applied at every ingest (rowFromSubmission,
 * the review queue's applyEdits) and to the whole merged set in build-jobs
 * and the sheet sync, the healCountry pattern, so a row from ANY writer is
 * clean on every rebuild.
 */
export function stripRowEmails(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== 'string' || /Url$/.test(k)) continue;
    if (v.includes('@')) out[k] = stripEmails(v);
  }
  return out;
}

/**
 * Put a verify pass's freshly-filled deadlines onto data/jobs.json's copies
 * of the sheet's rows — ONLY the rows the pass changed, and ONLY the three
 * deadline fields.
 *
 * The verify passes (higheredjobs-verify.mjs, adverts-verify.mjs) used to put
 * the whole jobmarket.json row back over every sheet-sourced jobs.json row,
 * and that clobbered what it did not know how to redo: jobs.json is
 * build-jobs' output, healed over the MERGED set (healPlace, fixPlace,
 * healReviewDate's suggested/final split), while jobmarket.json can lawfully
 * disagree — UCLA's row carries the maintainer's typed October 5 there while
 * the built row carries the text's own stated final date, November 5, with
 * October 5 as the suggested one. The wholesale copy reverted that split and
 * the mirror guard stopped the whole commit. A changed row's deadline fields
 * are the pass's own fact; everything else on the row stays the build's, and
 * an unchanged row is not touched at all.
 */
export function patchDeadlines(jobsRows, applied, source) {
  if (!Array.isArray(jobsRows)) return jobsRows;
  const changed = new Set((applied.changed || []).map((c) => c.id));
  const byId = new Map((applied.rows || []).map((r) => [r.id, r]));
  return jobsRows.map((r) => {
    if (!r || r.source !== source || !changed.has(r.id) || !byId.has(r.id)) return r;
    const fresh = byId.get(r.id);
    const next = { ...r, applyBy: fresh.applyBy, applyByDate: fresh.applyByDate };
    /* healReviewDate ran over the filled row, so its verdict on the suggested
       date is authoritative for it — including "there is none". */
    if (fresh.reviewDate) next.reviewDate = fresh.reviewDate;
    else delete next.reviewDate;
    return next;
  });
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

/** The site's own "Further info" link for a university. */
export function universitiesLink(institution) {
  return `https://www.operationsacademia.org/universities?filterA=${encodeURIComponent(institution)}`;
}

/** True when a stored link is one WE generated, and so ours to regenerate. */
export function ownUniversitiesLink(v) {
  return /^https?:\/\/(www\.)?operationsacademia\.org\/universities\?filterA=/i.test(String(v ?? ''));
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

/* ------------------------------------------------------- WHO posted a posting

   Two roads reach the jobs page and only a person walks one of them: a poster
   fills the form in on post-a-job.html, or the crawler reads a row out of the
   maintainer's tracking workbook. From the maintainer's inbox the two were
   indistinguishable — the review e-mail and the submission e-mail carried the
   same fields and neither said where the posting had come from, so "did
   somebody send this, and who?" could only be answered by opening the Admin
   area and finding the card (owner, 2026-08-29).

   ONE DEFINITION, because both mailers need the same answer and two copies of
   one rule disagree silently — the reason `oa-countries.js`, `oa-schools.js`
   and `oa-jobnav.js` all exist. It lives here because this file already owns
   `source`, which is the field that settles it.

   IT IS FOR THE MAINTAINER'S EYES AND NOTHING ELSE. The address it returns is
   the one the poster typed so the site could reach them; PUBLIC_FIELDS is what
   keeps it out of data/, `stripRowEmails` is what keeps it out of the text
   there, and the only callers are the two mailers addressed to the maintainer.
   It must never be rendered into a served file, a public page, or the e-mail
   the POSTER receives — an address quoted back at its own owner tells them
   nothing and teaches the habit of putting one in a message that could be
   forwarded.

   THE SOURCE WINS OVER THE DOCUMENT. A tracking-sheet MIRROR is an ordinary
   `jobSubmissions` document once the maintainer edits it (sheetMirrorDoc /
   sheetHandover below), so "the document exists, therefore a person made it"
   would report the workbook's rows as somebody's submission. A source this
   pipeline knows to be a crawler is a crawler whatever else the document
   carries; only then is a person looked for.                                */

/** The crawlers, and what to call each one in a sentence. A source not listed
    here is either the site's own form or something new — see `postedBy`. */
export const CRAWLER_SOURCES = {
  'jobmarket-sheet': 'the OM Job Market tracking sheet (Google Sheets)',
  'sheet-import': 'the legacy Google Form response sheet',
  'legacy-import': 'the legacy Awesome Tables spreadsheets',
};

/** The source the site's own posting form stamps. */
export const FORM_SOURCE = 'oa-form';

/** Every source, in the words a message uses. The crawlers plus the form —
    which is deliberately NOT in CRAWLER_SOURCES, because that map is what
    DECIDES whether a posting was made by a machine. */
export const SOURCE_LABELS = {
  ...CRAWLER_SOURCES,
  [FORM_SOURCE]: 'the posting form on the site',
};

/** What to call a source in a sentence — its own name when it is not one this
    pipeline knows, so a source added tomorrow reads as itself rather than
    disappearing. */
export function sourceLabel(source) {
  const s = text(source, 40);
  if (!s) return '';
  return SOURCE_LABELS[s] || s;
}

/**
 * An address a person actually gave, or ''.
 *
 * The address the poster typed for us to reach them (`email`) first, then the
 * account they signed in with (`authEmail`) — the form pre-fills the first
 * from the second, so they are usually the same and the typed one is the one
 * they chose. Shape-checked rather than trusted: it becomes an href and, in
 * the live pass below, an envelope recipient.
 */
export function contactEmail(doc) {
  for (const k of ['email', 'authEmail']) {
    const v = text(doc && doc[k], 200);
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return v;
  }
  return '';
}

/**
 * Who put this posting on the site.
 *
 * `{ kind, name, email, source, label, text }` — `kind` is 'user' or
 * 'crawler', `text` the one line an e-mail prints. `doc` is the submission or
 * review document; `row` is the posting, consulted only for its `source` when
 * the document has none (a `jobReviews` document keeps the source inside its
 * snapshot of the row).
 */
export function postedBy(doc, row = null) {
  const d = doc || {};
  const source = text(d.source, 40) || text(row && row.source, 40);

  if (source && CRAWLER_SOURCES[source]) {
    const label = sourceLabel(source);
    return { kind: 'crawler', name: '', email: '', source, label,
             text: `auto-crawler from ${label}` };
  }

  const name = [text(d.firstName, 100), text(d.lastName, 100)].filter(Boolean).join(' ');
  const email = contactEmail(d);
  if (name || email) {
    return { kind: 'user', name, email, source, label: sourceLabel(source),
             text: [name, email].filter(Boolean).join(' ') };
  }

  /* No person on the document and a source nobody here recognises. Saying
     "auto-crawler" would be a guess and saying nothing would leave the line
     blank in a message whose whole point is to answer this question. */
  const label = sourceLabel(source);
  return { kind: 'crawler', name: '', email: '', source, label,
           text: label ? `auto-crawler from ${label}` : 'not recorded' };
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

/* ------------------------------------------- WHICH SEASON A POSTING IS FOR

   THE DEADLINE, NOT THE DAY IT WENT UP (owner, 2026-08-26). The market year
   used to be read off the POSTING date, which is the day the advertisement
   appeared and not the thing a season is about. A school that advertises in
   May for a search closing in September is recruiting for the season that
   opens in July, and every one of its postings filed under the season that
   had just closed — the one page they are of no use on.

   So the deadline decides, and the cascade is exactly the owner's:

     1. the FINAL apply-by (`applyByDate`) — the hard closing date;
     2. failing that, the SUGGESTED apply-by (`reviewDate`) — the
        first-review / full-consideration date;
     3. failing both, the POSTING date, which is where this started.

   Step 1 fails precisely when the search is open-ended. `applyByDate` is
   empty exactly then — "Until filled." is the ABSENCE of a closing date, not
   a date (`deadlineOpen` above turns on the same reading) — so "if that
   field is Until filled" and "if that field is empty" are one test, and the
   cascade needs no separate look at the prose.

   IT ONLY EVER MOVES A POSTING FORWARD, which is what makes it safe to apply
   over a season that has already been imported: a deadline is on or after
   the day the advertisement went up, `marketYear` rises with the date, so
   the answer is never EARLIER than the posting date's own. The tracking
   sheet's tab cycle stays a floor on top of it for the same reason it always
   was (jobmarket-sheet.mjs) — and measured over the 543 served postings the
   two AGREE on fourteen of the seventeen rows whose deadline outruns their
   posting date, so the deadline generalises the floor rather than fighting
   it.

   AND A POSTING CAN BE IN TWO SEASONS AT ONCE, BECAUSE THE SEASONS OVERLAP
   (owner, 2026-08-27). Reading the deadline decides which season a posting is
   FOR; it does not make that the only season it belongs IN. A school
   advertising in May for a search closing in September is recruiting for the
   season opening in July AND is advertising right now, in the season under
   way — "there is overlap between the two years" — so it belongs to both, and
   a model that can only name one has to be wrong about one of them.

   So `year` stays exactly what it was: ONE season, decided by the cascade at
   birth, and never moved afterwards. It is half a row's `id` (`jobId`) —
   a card's anchor, the Edit button's join key, and, through `keyOf`, the
   thing that keeps `mergeRows` from re-stamping `addedAt` and re-alerting
   every subscriber — so an id that moves publishes the posting TWICE, once
   as an orphan nobody can reach.

   `years` is the whole span (`marketYearsOf` below): every season the posting
   touches, from the one it was advertised in, through the one it is filed
   under, to the one its deadline falls in. It is DERIVED on every build from
   fields the row already publishes, so it needs no decision, no document and
   no migration — and it is what the archive's "Job market year" filter reads,
   so a spanning posting is listed under both seasons rather than only the
   later one.

   THE REPORT STILL HAS A JOB, AND THE OVERLAP CHANGES WHAT IT MEANS. A search
   advertised in September that stays open until the following July has a
   deadline a few weeks past the roll, and reading it literally would file a
   plainly 2025-2026 search under 2026-2027 (Nanyang, posted 2025-09-24 closing
   2026-07-28; Tulane, 2025-09-04 closing 2026-07-01). Nothing here can tell
   those apart from a genuine early advertisement without guessing, so the
   disagreement is REPORTED to the maintainer (`marketYearReview` below, drawn
   on /admin-area, settled per posting in `yearChecks/{id}`).

   What the overlap changes is the STAKE. The flagged posting is no longer
   missing from the season its dates name — it is listed under both — so the
   card reports a disagreement to read rather than a posting to rescue, and
   "leave it where it is" is a complete answer. That is what makes settling
   one, rather than moving it, the ordinary outcome.                        */

/**
 * The market year a posting belongs to, and which of its dates said so.
 *
 * Returns `{ year, from }` where `from` is `'final'`, `'review'` or
 * `'posted'` — the report on /admin-area names it, so a flagged posting says
 * WHY it should move rather than only that it should.
 *
 * `now` is the last resort, for a row carrying no date at all.
 */
export function marketYearOf(row, { now = new Date() } = {}) {
  const at = (v) => {
    const d = day(v);
    return d ? marketYear(new Date(`${d}T12:00:00Z`)) : 0;
  };
  const final = at(row && row.applyByDate);
  if (final) return { year: final, from: 'final' };
  const review = at(row && row.reviewDate);
  if (review) return { year: review, from: 'review' };
  const posted = at(row && row.posted);
  if (posted) return { year: posted, from: 'posted' };
  return { year: marketYear(now), from: 'posted' };
}

/** What the cascade calls this row, never below the floor it already has.
    The floor is the whole safety argument above: forward only, so no
    published posting is pulled back into a season that has closed. */
export function marketYearAtLeast(row, floor = 0, opts = {}) {
  const { year, from } = marketYearOf(row, opts);
  const f = Number(floor);
  return Number.isFinite(f) && f > year ? { year: Math.trunc(f), from: 'floor' } : { year, from };
}

/**
 * How many seasons a single posting may be listed under. THREE, and it is a
 * guard against junk rather than a policy: measured over the 569 served
 * postings the widest real span is TWO, and it cannot honestly be much more —
 * `deadlineDay` refuses a closing date more than DEADLINE_WINDOW_DAYS (730)
 * from the posting date, so a span of four would need dates no ingest lets
 * through. A row that manages it anyway is listed under the seasons its own
 * three dates name, without the years between them filled in.
 */
export const MARKET_SPAN_MAX = 3;

/**
 * EVERY season this posting belongs to, ascending — the overlap.
 *
 * Three dates can each name a season and they need not agree, which is the
 * whole point:
 *
 *   the season it was ADVERTISED in   `posted`
 *   the season it is FILED under      `year`, the cascade's answer at birth
 *   the season its DEADLINE falls in  the cascade over the two apply-by dates
 *
 * The span runs from the earliest of those to the latest, filling the seasons
 * between (a search open across a whole year is open during it), because that
 * is what "which seasons is this posting in" means to a reader browsing one.
 *
 * PURE, and deliberately free of `now`: it reads only what the row itself
 * carries. A row with no dates at all is listed under its stored year alone —
 * never under today's season, which is what `marketYearOf`'s last-resort
 * fallback would have made of a 2014 posting on every rebuild.
 *
 * Always contains `year` where the row has one, so nothing a consumer already
 * filed under the primary season can fall out of it.
 */
export function marketYearsOf(row) {
  const at = (v) => {
    const d = day(v);
    return d ? marketYear(new Date(`${d}T12:00:00Z`)) : 0;
  };
  const stored = Math.trunc(Number(row && row.year)) || 0;
  const deadline = at(row && row.applyByDate) || at(row && row.reviewDate);
  const advertised = at(row && row.posted);

  const named = [stored, deadline, advertised].filter((y) => y > 0);
  if (!named.length) return [];

  const lo = Math.min(...named);
  const hi = Math.max(...named);
  if (hi - lo + 1 > MARKET_SPAN_MAX) return [...new Set(named)].sort((a, b) => a - b);

  const out = [];
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}

/**
 * The row with its span written on it — the one place `years` is set.
 *
 * Pure and IDEMPOTENT, so every writer can apply it and the build can apply
 * it again over the merged set: a row already carrying the right span comes
 * back byte-identical and the rebuild commits nothing. That is the
 * `healCountry`/`healPlace` discipline, and it is what makes a carried
 * ORPHAN — a posting with no document behind it, which never goes back
 * through an ingest — gain its span like everything else.
 */
export function withMarketYears(row) {
  if (!row) return row;
  const years = marketYearsOf(row);
  if (!years.length) return row;
  const have = Array.isArray(row.years) ? row.years : null;
  if (have && have.length === years.length && have.every((y, i) => y === years[i])) return row;
  /* written straight after `year`, not appended. publicRow reorders the served
     postings anyway, but data/past-postings.json is serialised as it stands —
     and a derived field landing after the addedAt stamp makes a diff that has
     to be read twice. */
  const out = {};
  let placed = false;
  for (const [k, v] of Object.entries(row)) {
    if (k === 'years') continue;
    out[k] = v;
    if (k === 'year') { out.years = years; placed = true; }
  }
  if (!placed) out.years = years;
  return out;
}

/** How the report words the date that decided. */
export const MARKET_YEAR_SOURCE = {
  final: 'its final apply-by date',
  review: 'its suggested apply-by date',
  posted: 'the date it was posted',
  floor: 'the season it was filed under',
};

/**
 * The published postings whose stored market year is BEHIND what their own
 * dates say — the review list the owner asked for: "postings that were
 * possibly posted under the previous job market year and were actually
 * belonging to the current job market year".
 *
 * FORWARD ONLY, and deliberately. A row whose stored year is AHEAD of the
 * cascade is the tracking sheet's tab cycle (or a poster's own tag) doing
 * its documented job, and pulling it back would move a live posting into a
 * closed season — the one direction this rule promises never to take.
 *
 * Pure and deterministic, so build-jobs.mjs may write it on every run and an
 * unchanged corpus commits nothing.
 */
export function marketYearReview(rows, { now = new Date() } = {}) {
  const out = [];
  for (const r of rows || []) {
    const stored = Math.trunc(Number(r.year) || 0);
    const { year, from } = marketYearOf(r, { now });
    if (!stored || year <= stored) continue;
    out.push({
      id: String(r.id || ''),
      ref: String(r.ref || ''),
      institution: String(r.institution || ''),
      department: String(r.department || ''),
      posted: String(r.posted || ''),
      applyByDate: String(r.applyByDate || ''),
      reviewDate: String(r.reviewDate || ''),
      stored,
      should: year,
      from,
      current: year >= marketYear(now),
    });
  }
  /* the ones that belong to the season under way first — those are the
     postings a reader is looking at today — then newest advertisement first */
  return out.sort((a, b) => Number(b.current) - Number(a.current)
    || b.should - a.should
    || String(b.posted).localeCompare(String(a.posted))
    || String(a.id).localeCompare(String(b.id)));
}

/**
 * Is this posting still open for applications at `now`?
 *
 * The deadline DATE is the only signal. `applyByDate` is empty exactly when
 * the search is open-ended ("Until filled", per OPEN_ENDED_RX) or no deadline
 * was given at all — so an empty date is not an open deadline here, it is the
 * ABSENCE of one, and cannot keep a posting on the page for ever.
 *
 * A deadline falling today still counts: applications close at the end of the
 * day named, not at the midnight before it.
 */
export function deadlineOpen(row, now = new Date()) {
  const day = String(row.applyByDate || '');
  return !!day && day >= now.toISOString().slice(0, 10);
}

/**
 * Does this row belong on THE JOBS PAGE, which shows only the market year
 * under way? (Owner decision 2026-08-16, superseding the two-season window:
 * the previous seasons live at /v1 and in the git history, not on the page.)
 *
 * A row qualifies ANY way it can say so:
 *   - its DEADLINE has not passed — the advertisement is still open, and an
 *     open advertisement is the one thing this page exists to show; or
 *   - it was POSTED inside the current market year (on or after 1 July), or
 *   - its poster TAGGED it for the current market year or a later one.
 *
 * All three legs are needed. Posting date alone would drop a posting filed in
 * May for the season starting in September (the 2028 Kansas row); the tag
 * alone would drop postings still being filed under the previous season's
 * label weeks after the roll (the July Mannheim row) — the poster picks that
 * field by hand and is often a season behind.
 *
 * THE DEADLINE LEG IS WHAT THE ROLL TURNS ON (owner, 2026-08-17). Without it,
 * 1 July swept away every posting of the season just ended even when its
 * closing date was still weeks away: a job advertised in May 2027 with a
 * 30 September deadline vanished from the site on 2 July, while applications
 * were still open. With it, such a posting stays until its date passes, and
 * a posting with NO fixed deadline is cleared by the roll — which is the
 * intended asymmetry: an "until filled" advertisement from a season that has
 * ended is stale by definition, and belongs in the past-market archive.
 *
 * That archive is exactly the complement of this predicate
 * (previous-markets.html filters on `!inCurrentMarket`), so every row is on
 * one page or the other — never both, never neither.
 *
 * Note MARKET_WINDOW above still governs the SHEET IMPORT's reach, on
 * purpose: the import must capture late filings under the old label so this
 * predicate — not the import's scope — is what decides the page.
 */
export function inCurrentMarket(row, now = new Date()) {
  return deadlineOpen(row, now)
      || String(row.posted || '') >= marketStart(now)
      || Number(row.year) >= marketYear(now);
}

/* --------------------------------------------- healing a row that is carried

   A posting with no document behind it is carried from the previous
   data/jobs.json unchanged — which is right for its content, and wrong for
   its NAMES. `assets/oa-schools.js` gains an alias whenever a new spelling
   turns up ("Rotman School of Management" is Toronto's Joseph L. Rotman),
   and a carried row never went back through an ingest to hear about it. So
   the site published one school under two names for ever, and — worse — the
   selftest's "every posting names its place the one way" guard went red,
   which by design STOPS the build committing anything at all.

   Re-canonicalising on the way through is the fix, and it is safe because
   canonPlace is pure and idempotent: a row already canonical comes back
   identical, so a run with no new alias writes nothing.

   The `department` line is rebuilt with it (the card and the filters read
   that, not the two parts), and a "Further info" link the site generated is
   regenerated — the poster's own link is never touched, exactly as
   `ownUniversitiesLink` decides elsewhere. The `id` deliberately FOLLOWS the
   name: it is derived from the institution slug, so leaving it would strand
   the row under a name no longer on the site — the same call the canon made
   when Penn State became The Pennsylvania State University.                 */
export function healPlace(row, fixes = []) {
  /* the approved name corrections (data/name-fixes.json) ride the same heal:
     an OVERLAY after canon, never a second canon — normalizeFixes made every
     target canonical, so a fixed row still satisfies the "every posting names
     its place the one way" guard whether or not it has heard of the fix */
  const canoned = canonPlace({
    institution: row.institution,
    school: row.school || '',
    unit: row.unit || '',
  });
  const place = fixes.length ? fixPlace(canoned, fixes) : canoned;
  const department = joinDepartment(place.school, place.unit);
  /* A STALE LINK IS A REASON TO HEAL ON ITS OWN. The early return used to
     test the three names alone, so a row whose names were already canonical
     but whose own Universities link still asked for an earlier spelling —
     written before the name was corrected — was returned untouched, and the
     "no posting links to a university under a name it does not use" guard
     stayed red with nothing left to heal it. */
  const ownLink = ownUniversitiesLink(row.furtherInfoUrl);
  const freshLink = (ownLink && place.institution) ? universitiesLink(place.institution) : '';
  if (place.institution === row.institution
      && place.school === (row.school || '')
      && place.unit === (row.unit || '')
      && department === (row.department || '')
      && (!freshLink || row.furtherInfoUrl === freshLink)) return row;

  const healed = { ...row, ...place, department };
  /* A key only where there is a value — keyed on what the canon PRODUCED, not
     on what the row arrived with. Keyed on the row, a posting whose school the
     canon had just lifted out of its university field ("University of Houston
     (Bauer Human-Centered AI Institute)") lost that school again on the way
     out, leaving a `department` line with nothing behind it. */
  if (!place.school) delete healed.school;
  if (!place.unit) delete healed.unit;
  if (freshLink) healed.furtherInfoUrl = freshLink;
  if (row.id && row.id === jobId(row)) healed.id = jobId(healed);
  return healed;
}

/* ------------------------------------------------------------- the mapping */

/**
 * A Firestore `jobSubmissions` document -> a published row, or null when the
 * submission is not publishable. The client already validated; this validates
 * AGAIN because the client is not trusted with what reaches a served file.
 */
export function rowFromSubmission(doc, { now = new Date(), fixes = [] } = {}) {
  const country = canonCountry(text(doc.country, MAXLEN.country));
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

  /* …and then all three names are canonicalised together, because which of
     the three a name belongs in is part of what canon() decides — and the
     approved name corrections are laid on top, the same overlay healPlace
     applies to a carried row, so a fresh submission typed under a corrected
     spelling publishes under the corrected one. */
  const canoned = canonPlace({
    institution: text(doc.institution, MAXLEN.institution),
    school: parts.school,
    unit: parts.unit,
  });
  const place = fixes.length ? fixPlace(canoned, fixes) : canoned;
  const institution = text(place.institution, MAXLEN.institution);
  const school = text(place.school, MAXLEN.school);
  const unit = text(place.unit, MAXLEN.unit);
  const department = text(joinDepartment(school, unit), MAXLEN.department);

  // the minimum a card needs to be worth rendering
  if (!institution || !department || !country || !type || !levels.length) return null;

  /* `posted` is the page's primary sort key, so a value the client picks is a
     value the client can use to pin its own card to the top of the list for
     ever. The form does not send `postedOn` and the rules do not mention it,
     so it is honoured only when it is no LATER than the moment the submission
     was actually stored — a poster may say a posting went up earlier, never
     that it goes up in 2100. */
  const stamped = isoDay(tsToDate(doc.createdAt) || now);
  const asked = day(doc.postedOn);
  const posted = asked && asked <= stamped ? asked : stamped;
  let applyByDate = doc.untilFilled ? '' : day(doc.applyByDate);

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

  /* THE OPEN-ENDED RULE, applied at the LAST writer. The page buckets a
     posting "Until filled" purely on `applyByDate` being empty, so prose that
     says the search stays open ("until filled", "open until", "rolling") must
     win over a parsed date — import-sheet.mjs has always enforced this, and
     the served-file check in selftest.mjs rejects any row violating it. It has
     to be enforced HERE too, not only at import: six documents were migrated
     before the committed dates were blanked and still carry the date their own
     prose contradicts, so the first database rebuild resurrected all six dates
     and the selftest gate stopped the whole publish. Healing at read makes the
     stored shape irrelevant. */
  if (applyByDate && OPEN_ENDED_RX.test(applyBy)) applyByDate = '';

  /* WHICH SEASON THIS POSTING IS FOR. A stored year WINS OUTRIGHT, and that
     is not deference to the client — it is `jobId`. The year is half a row's
     id, the id is a card's anchor and the Edit button's join key, and a row
     whose id moves is a row `mergeRows` cannot match: the old one is carried
     on as an orphan and the posting is published TWICE. So a posting that
     already has a season keeps it — and a posting whose dates name ANOTHER
     season is listed under that one too rather than moved into it, which is
     `years` a few lines down (`marketYearsOf`, the overlap). The disagreement
     itself is still reported to the maintainer (`marketYearReview`, drawn on
     /admin-area), which is where a posting that really was mis-filed is
     settled.

     The cascade below is therefore for a document that has NO season — a
     migrated row, anything not written by the form — and it is the same one
     the form itself now applies before it sends (`postingYear` in
     assets/oa-jobform.js), so the two agree at birth. It reads the dates as
     they stand after the open-ended heal a few lines up, which is where
     "Until filled" becomes an EMPTY `applyByDate` and so the point at which
     step 1 of the cascade correctly fails. */
  const stored = Number.isFinite(+doc.year) && +doc.year >= 2000 && +doc.year <= 2100
    ? Math.trunc(+doc.year)
    : 0;
  const year = stored || marketYearOf(
    { applyByDate, reviewDate: day(doc.reviewDate), posted }, { now }).year;

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
    /* The SUGGESTED apply-by — the first-review / full-consideration date.
       The form's own field first; healReviewDate below then validates it
       against the final date and, for a document made before the field
       existed (every mirror and migrated posting), reads it out of the
       apply-by prose itself. */
    reviewDate: day(doc.reviewDate),
    comments: text(doc.comments, MAXLEN.comments),
    country,
    adUrl: url(doc.adUrl),
    /* The poster uploaded an advert that has not been filed into Drive yet
       (the build files it, normally in the same run — see transferUploads).
       The card shows "soon to be available" instead of nothing, so a posting
       is never held back by its file: the posting publishes NOW, the link
       replaces the note at whichever run manages the transfer. */
    adPending: !url(doc.adUrl) && (!!doc.adUploadPath || doc.adPending === true),
    /* These four were fixed values, which was right while every posting came
       from this form. The migration off the Google Sheet makes a document out
       of an EXISTING row, so they have to survive the round trip: the sheet
       carries its own link labels ("Operations Academia"), its own
       further-info URL, and a source that is not this form. Each still
       defaults to what it always was. */
    adLabel: text(doc.adLabel, MAXLEN.adLabel) || 'link to Job ad',
    postedAtUrl: url(doc.postedAtUrl),
    postedAtLabel: text(doc.postedAtLabel, MAXLEN.postedAtLabel) || 'link',
    /* The poster's own link, or ours — and OURS FOLLOWS THE NAME. This is the
       site's "Further info" link into the Universities page, generated from
       the institution; a stored one that still names the spelling a posting
       was made under stops finding the university the moment the name is
       canonicalised (six postings, four of them landing on nothing). A link
       the poster actually gave is never touched. */
    furtherInfoUrl: ownUniversitiesLink(doc.furtherInfoUrl)
      ? universitiesLink(institution)
      : (url(doc.furtherInfoUrl) || universitiesLink(institution)),
    characteristics: pickList(doc.characteristics, CHARACTERISTICS),
    featured: doc.featured === true,
    source: text(doc.source, 40) || 'oa-form',
    addedAt: isoStamp(tsToDate(doc.createdAt) || now),
    ref: text(doc.ref, 40),
    /* Normally derived from the account behind the document. The fallback is
       the ROUND TRIP's: submissionFromRow cannot invert a hash back into a
       uid, so it carries the published tag itself, and a document that has no
       account (uid null) but a carried tag keeps the row's ownership rather
       than silently orphaning it. A client cannot forge this — the rules
       refuse any client-written document carrying an `owner` key. */
    owner: ownerTag(doc.uid) || text(doc.owner, 64),
  };
  row.id = jobId(row);
  /* `years` LAST: healReviewDate is what settles the suggested date (and can
     read one out of the apply-by prose), and the span is read off the dates
     as they finally stand. */
  return withMarketYears(stripRowEmails(healReviewDate(row)));
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
    // `adPending` is the same: meaningful only while true, noise on every
    // other row — and so is `reviewDate`, which most postings never state.
    //
    // `years` is written on EVERY row on purpose, even where it is the stored
    // year said once. The archive's "Job market year" filter reads it as a
    // multi-valued field, and a row that omitted it would answer no year at
    // all rather than its own.
    if ((k === 'ref' || k === 'adPending' || k === 'reviewDate') && !row[k]) continue;
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

/* -------------------------------------------- the two deadlines a search has

   MANY SEARCHES HAVE NO CLOSING DATE AND STILL NAME A DATE THAT MATTERS
   (owner, 2026-08-23): the day the committee starts reading. Kansas writes
   "First review of applications will begin on September 8, 2026, and will
   continue until the position has been filled"; UCLA gives a whole window
   ("Next review date: Oct 5, 2026 … Final date: Nov 5, 2026"). Both published
   as a bare "Until filled." — true, and the least informative true thing the
   card could say.

   So a posting carries TWO dates now:

     reviewDate    the SUGGESTED apply-by — the first-review / full-
                   consideration date. Apply by this day to be in the pile the
                   committee reads first. Empty when the posting names none.
     applyByDate   the FINAL apply-by — the hard closing date, exactly as
                   before. Empty means "Until filled.", and it alone drives
                   the market roll (deadlineOpen): a review date passing does
                   not close a search.

   `extractReviewDate` reads the suggested date out of the PROSE the sources
   already carry, because that is where it lives — the sheet's deadline cell,
   a poster's own note. Deliberately HIGH-PRECISION, the deadlineDay
   discipline: every pattern demands the reviewing/consideration context AND a
   date with a four-digit year, an ambiguous 10/12/2026 is refused rather than
   guessed, and a posting the extractor is unsure of keeps reading exactly as
   it did ("Until filled."). `healReviewDate` applies it to a whole row —
   fill-empty, idempotent, applied at every ingest and on every build like
   healPlace — and cuts the captured sentence out of the `applyBy` line, so
   the Kansas card reads "Suggested apply by: September 8, 2026 · Final apply
   by: Until filled." instead of carrying the sentence twice.               */

/** The written-out dates the sources use: "September 8, 2026",
    "Monday, Oct 5, 2026", "Oct 12th 2025", "20 February 2026", ISO, and the
    slash form. `\b` after the year keeps a typo'd "12014" from half-matching. */
const PROSE_DATE =
  '(?:(?:mon|tues?|wednes|thurs?|fri|satur|sun)day,?\\s+)?' +
  '(?:[a-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}' +
  '|\\d{1,2}(?:st|nd|rd|th)?\\s+[a-z]{3,9}\\.?,?\\s+\\d{4}' +
  '|\\d{4}-\\d{2}-\\d{2}' +
  '|\\d{1,2}/\\d{1,2}/\\d{4})\\b';

/** A prose date -> ISO day, or ''. Stricter than day() about ambiguity: an
    all-numeric cell both of whose parts could be the month ("10/12/2026") is
    refused — a suggested deadline the pipeline is unsure of is not published,
    the same rule deadlineDay applies to the final one. */
export function parseProseDay(v) {
  const s = String(v ?? '').trim().toLowerCase()
    .replace(/^(?:mon|tues?|wednes|thurs?|fri|satur|sun)day,?\s+/, '')
    .replace(/(\d{1,2})(?:st|nd|rd|th)\b/, '$1')
    .replace(/[.,]/g, '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return valid(m[1], m[2], m[3]);
  m = s.match(/^([a-z]{3,9})\s+(\d{1,2})\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3)) + 1;
    return mo ? valid(m[3], String(mo), m[2]) : '';
  }
  m = s.match(/^(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3)) + 1;
    return mo ? valid(m[3], String(mo), m[1]) : '';
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a <= 12 && b <= 12 && a !== b) return '';   // could be read either way
    if (a > 12) return valid(m[3], m[2], m[1]);     // day-first, forced
    return valid(m[3], m[1], m[2]);                 // US, forced (or a == b)
  }
  return '';
}

/* The shapes the committed postings actually use, most specific first. Every
   one demands its context IN THE SAME SENTENCE as the date ([^.;] gaps), so a
   date mentioned near the word "review" is never enough on its own. */
const REVIEW_PATTERNS = [
  // "First review/consideration/screening of applications will begin on <date>"
  '(?:first\\s+|initial\\s+|formal\\s+)?(?:review|consideration|screening)s?\\s+of\\s+' +
    '(?:the\\s+)?applica[a-z]*[^.;:]{0,60}?\\b(?:begin|commence|start)(?:s|ning)?\\s+' +
    '(?:formally\\s+)?(?:on\\s+|approximately\\s+|around\\s+|about\\s+)?%D%',
  // "the committee will begin (formally) reviewing applications on <date>"
  '(?:begin|commence|start)s?\\s+(?:formally\\s+)?(?:review|screen|consider)ing\\s+' +
    '(?:of\\s+)?applications?\\s+(?:on\\s+|approximately\\s+)?%D%',
  // "(application) review will begin on <date>"
  '(?:application\\s+)?review\\s+(?:will\\s+|shall\\s+)?begins?\\s+' +
    '(?:on\\s+|approximately\\s+)?%D%',
  // "Next review date: <date>" — the UCLA application-window shape
  '(?:next\\s+|first\\s+)?review\\s+date:?\\s+%D%',
  // "for/to ensure full consideration … (apply) by <date>"
  '(?:for|to\\s+(?:ensure|receive|guarantee))\\s+(?:full(?:\\s+and\\s+timely)?\\s+)?' +
    'consideration[^.;]{0,120}?\\bby:?\\s+%D%',
  // "…received/submitted by <date> … full consideration / given priority"
  '(?:received|submitted|submit|completed|apply|applications?)[^.;]{0,60}?' +
    '\\b(?:by|on\\s+or\\s+before)\\s+%D%[^.;]{0,80}?' +
    '\\b(?:full(?:\\s+and\\s+timely)?\\s+consideration|given\\s+priority|priority\\s+(?:review|consideration))',
  // "priority will be given to … received by <date>"
  'priority\\s+(?:will\\s+be\\s+)?given\\s+to[^.;]{0,80}?\\breceived\\s+by\\s+%D%',
  // "apply before <date> for first-round interviews"
  'apply\\s+(?:before|by)\\s+%D%[^.;]{0,60}?\\bfirst[-\\s]round',
];

/* A hard closing date stated as prose rather than as a bare cell — the other
   half of UCLA's window ("Final date: Thursday, Nov 5, 2026"). ONLY an
   explicit label counts: a bare "deadline" heading three clauses away from a
   date is exactly the mis-read the sheet ingest's header lesson records. */
const FINAL_PATTERNS = [
  '(?:final|closing)\\s+(?:date|deadline)\\s*(?:is\\s+|:\\s*|[-–—]\\s*)%D%',
  'applications?\\s+(?:will\\s+be\\s+)?accepted\\s+(?:until|through)\\s+%D%',
];

function firstDateMatch(text, patterns) {
  const s = String(text ?? '');
  if (!s) return null;
  for (const p of patterns) {
    const m = new RegExp(p.replace('%D%', '(' + PROSE_DATE + ')'), 'i').exec(s);
    if (!m) continue;
    const date = parseProseDay(m[1]);
    if (date) return { date, from: m.index, to: m.index + m[0].length };
  }
  return null;
}

/** The text with the sentence holding [from, to) removed — how the captured
    review sentence leaves the `applyBy` line without touching its neighbours. */
function withoutSentence(text, from, to) {
  let a = 0;
  for (let i = from - 1; i > 0; i--) {
    const c = text[i];
    if ((c === '.' || c === ';') && /\s/.test(text[i + 1] || '')) { a = i + 1; break; }
  }
  let b = text.length;
  for (let i = to; i < text.length; i++) {
    const c = text[i];
    if (c === '.' || c === ';') { b = i + 1; break; }
  }
  return (text.slice(0, a) + ' ' + text.slice(b)).replace(/\s+/g, ' ').trim();
}

/** `{ date, rest }`: the suggested apply-by a text states, and the text with
    that sentence removed — `rest` is the text unchanged when nothing fired. */
export function extractReviewDate(text) {
  const s = String(text ?? '');
  const m = firstDateMatch(s, REVIEW_PATTERNS);
  if (!m) return { date: '', rest: s };
  return { date: m.date, rest: withoutSentence(s, m.from, m.to) };
}

/** The labelled FINAL closing date a text states, or ''. The caller applies
    its own plausibility test, exactly as deadlineDay's callers do. */
export function extractFinalDate(text) {
  const m = firstDateMatch(text, FINAL_PATTERNS);
  return m ? m.date : '';
}

/**
 * A row's suggested apply-by, settled: an explicit `reviewDate` validated,
 * else extracted from the row's own `applyBy` prose (which then loses the
 * captured sentence), else from its comments (never trimmed — they are the
 * card's own record of what the source said).
 *
 * A suggested date ON OR AFTER the final one is dropped, in either source:
 * later contradicts the closing date, and equal is the deadline itself said
 * twice ("for full consideration apply by <the closing date>" — half the
 * corpus), which would put the same date on the card in two rows.
 *
 * Pure, idempotent and fill-empty, so every writer applies it on every pass —
 * the healPlace pattern: fresh submissions, the sheet ingest, carried orphans
 * and the committed files all heal the same way, and a run with nothing new
 * changes nothing.
 */
export function healReviewDate(row) {
  let finalDay = String(row.applyByDate || '');
  let applyBy = String(row.applyBy || '');
  const believable = (d) => !!d && (!finalDay || d < finalDay);
  let review = day(row.reviewDate);
  if (review && !believable(review)) review = '';

  /* THE SOURCE'S OWN LABELLED WINDOW CAN SETTLE BOTH DATES. UCLA's posting
     reached the site with its REVIEW date recorded as the closing date —
     "Apply by: October 5, 2026" — while its own words, carried on the same
     row, said "Next review date: Oct 5, 2026 … Final date: Nov 5, 2026".
     Where the stored closing date IS the text's own stated review date and
     the SAME text labels a final date after it, the stated final date wins
     and the review date takes its own field. Both labels must be explicit
     and must agree with the stored date, so this can never fire on a date
     the maintainer simply typed. */
  const window = (text) => {
    if (!finalDay) return null;
    const found = extractReviewDate(text);
    if (!found.date || found.date !== finalDay) return null;
    const final = extractFinalDate(text);
    return final && final > found.date ? { review: found.date, final } : null;
  };

  if (!review) {
    const found = extractReviewDate(applyBy);
    if (believable(found.date)) {
      review = found.date;
      applyBy = found.rest || (finalDay ? longDate(finalDay) : 'Until filled.');
    }
  }
  if (!review) {
    const w = window(applyBy) || window(String(row.comments || ''));
    if (w) {
      review = w.review;
      finalDay = w.final;
      applyBy = longDate(w.final);
    }
  }
  if (!review) {
    const found = extractReviewDate(String(row.comments || ''));
    if (believable(found.date)) review = found.date;
  }
  if (review === String(row.reviewDate || '') && applyBy === String(row.applyBy || '')
      && finalDay === String(row.applyByDate || '')) {
    return row;
  }
  const healed = { ...row, applyBy, applyByDate: finalDay };
  if (review) healed.reviewDate = review;
  else delete healed.reviewDate;
  return healed;
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

  /* A PINNED ID IS NOT OURS TO DERIVE, so it is claimed first and the derived
     ones are then made to avoid it. A posting taken over from the tracking
     sheet keeps the id the workbook gave it — only the workbook knows which of
     two postings from one school on one day is the `-2`, and the id is the
     row's identity: its `addedAt` continuity, the anchor a card links to, the
     cursor the e-mail alerts read.

     Claiming it AFTER the derivation, which is what this did at first, is a
     way to lose a posting: the pinned id could land on one already handed to
     another row this run, and mergeRows keys by id, so the second silently
     replaced the first — the very failure this function exists to prevent. */
  for (const e of ordered) {
    if (!e.fixedId) continue;
    e.row.id = e.fixedId;
    seen.add(e.fixedId);
  }

  for (const e of ordered) {
    if (e.fixedId) continue;
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
    /* The published owner TAG, carried as itself: a hash cannot be inverted
       back into the uid it came from, so a row owned by an account keeps its
       ownership through the round trip even when the account is not known
       here (uid null). rowFromSubmission prefers a real uid when one exists. */
    ...(row.owner ? { owner: row.owner } : {}),
    ...(row.adPending ? { adPending: true } : {}),
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
    reviewDate: row.reviewDate || '',
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

/* -------------------------------------------- the tracking sheet's own rows

   THE MAINTAINER COULD NOT EDIT THE POSTINGS THE TRACKING SHEET PUBLISHES.
   Every control on a card — Edit, Take down — is drawn only when the page can
   name a `jobSubmissions` DOCUMENT for that row (oa-jobedit.js docIdFor), and
   the sheet's rows deliberately had none: they are maintained in the workbook,
   so migrate-to-firestore.mjs skips them. The consequence was invisible in the
   code and obvious on the page — a signed-in maintainer saw Edit on the 94
   postings that came through the form or the legacy import, and nothing at all
   on the 16 the sheet had added.

   The fix is a MIRROR: an inert document per sheet row, carrying the same
   submission the row would have come from, whose only job is to be an editing
   handle. It is inert because of its status — `sheet`, a value no query in the
   pipeline reads, so a mirror publishes nothing, alerts nobody and is never
   stamped. The build refreshes it from the workbook on every run, so the sheet
   goes on maintaining the posting exactly as before.

   THE MOMENT THE MAINTAINER SAVES AN EDIT the document's status becomes
   'queued' (post-a-job.html does that for every edit, and always has), and
   that ONE fact is the whole hand-over: a status other than `sheet` means the
   maintainer has taken the posting over, so build-jobs.mjs publishes the
   document and drops the workbook's row. Nothing new has to be remembered, and
   nothing can disagree with itself.

   What the sheet KEEPS is existence. A row deleted from the workbook takes its
   posting off the site whether or not a document exists for it — which is the
   property migrate-to-firestore.mjs's comment worried about losing, and the
   reason the mirrors are pinned to the sheet by `sheetId` rather than left to
   stand on their own. */

/** The status of a mirror: inert, and outside every query the build makes. */
export const MIRROR_STATUS = 'sheet';

/* --------------------------------------------------- WHOSE WORD TO TAKE

   THE RULE, and it is a security boundary, not a tidiness one: a field that
   NAMES A PUBLISHED ROW — `sheetId`, `publishedId`, and the document's own id
   — is honoured only on a document THE BUILD ITSELF WROTE. Anything else is a
   string a signed-in stranger chose.

   `uid` is what tells them apart, and the security rules make it decisive: a
   create is refused unless `uid == request.auth.uid` (a non-empty string), an
   update is refused unless `uid` is unchanged, and the account-merge branch
   demands a uid at least ten characters long. So a document a browser made
   ALWAYS carries a real uid, and only the Admin SDK — the migration, and
   `sheetMirrorDoc` here — can produce one with none.

   Without this, both halves of the takedown and hand-over machinery are a
   privilege escalation. Any signed-in account could post a submission
   carrying `publishedId: '<somebody else's row id>'`, withdraw it, and have
   the next build delete that posting; or carry `sheetId: '<a workbook row
   id>'` and have the build publish THEIR content in place of the workbook's.
   Both ids are readable straight out of the served data/jobs.json and
   data/jobmarket.json. */

/** Does this submission's own word about which row it is count? */
export function buildOwned(doc) {
  return !!doc && !doc.uid;
}

/**
 * Does a removal spec name this row? ONE definition, because three places ask
 * — the merge that drops the row, the orphan carry that must not re-add it,
 * and the stamp that retires the document. They disagreed once, and the result
 * was a document marked `removed` for a row still on the site: the withdrawal
 * could then never be retried, because that stamp is what takes the document
 * out of the query that finds it.
 */
export function specMatches(spec, row) {
  if (!spec || !row) return false;
  if (typeof spec === 'string') return !!row.ref && row.ref === spec;
  if (spec.ref) return !!row.ref && row.ref === spec.ref && (spec.owner || '') === (row.owner || '');
  if (spec.id) return row.id === spec.id;
  return false;
}

/**
 * The removal specs a set of withdrawn/hidden documents may ask for.
 *
 * A REFERENCE is scoped to its owner — `{ ref, owner }`, which mergeRows keys
 * as `ref:<owner>:<ref>`, exactly the contract mergeRows documents and that
 * this build was quietly not honouring: it passed bare reference strings,
 * which delete a row whoever posted it, and `ref` is published in
 * data/jobs.json for anyone to copy.
 *
 * An ID is taken only from a build-written document (see `buildOwned`), where
 * it is the migration's own document id, the mirror's `sheetId`, or the
 * `publishedId` this build stamped. That is the only way a ref-less row — the
 * legacy import's and the workbook's, which is every row served today — can be
 * addressed at all.
 */
export function removalSpecs(docs = []) {
  const out = [];
  const ids = new Set();
  for (const d of docs) {
    const v = (d && (typeof d.data === 'function' ? d.data() : d.data)) || {};
    const docId = (d && d.id) || '';

    /* WHICH OWNER TAG THE ROW WILL BE CARRYING. Not simply this document's,
       because MERGING TWO ACCOUNTS moves a posting to a new uid WITHOUT
       republishing it — the rules allow exactly that (`affectedKeys` limited
       to uid/mergedFrom/mergedAt) — so until the next build the served row
       still carries the tag of the account the poster merged AWAY. Scoped to
       the new uid alone, their next withdrawal matched nothing, removed
       nothing, and was then stamped `removed`, which retires the document from
       the query that finds it: the posting could never be taken down again.

       `owner` on the document is deliberately NOT trusted unless the build
       wrote it. It is a tag, the tags are published in data/jobs.json, and a
       browser can put anything in that field — trusting it would hand back the
       very hole the scoping exists to close.

       `mergedFrom` is trusted for one reason and one only: THE RULES PIN IT.
       `mergedFromUnchanged()` in _firestore.rules lets the account-merge
       branch write it and refuses it everywhere else, so no ordinary correct
       or withdraw can introduce or change it. It is NOT trusted because a raw
       uid is hard to come by — that was the first reasoning here and it was
       wrong: `accountKeys` is readable one document at a time by anyone
       signed in, and it maps an e-mail to exactly that uid. Without the rule,
       naming a victim's uid as `mergedFrom` on a submission carrying their
       published `ref` takes their posting off the site.

       So: REDEPLOY THE RULES. Until they are published this field is only as
       good as the browser that wrote it. */
    const owners = new Set();
    if (v.uid) {
      owners.add(ownerTag(v.uid));
      if (v.mergedFrom) owners.add(ownerTag(v.mergedFrom));
    } else {
      owners.add(text(v.owner, 64));       // build-written: it carries the tag itself
    }
    if (v.ref) for (const o of owners) out.push({ ref: v.ref, owner: o, docId });

    if (!buildOwned(v)) continue;
    for (const k of [v.publishedId, v.sheetId, docId]) {
      if (!k) continue;
      ids.add(String(k));
      out.push({ id: String(k), docId });
    }
  }
  return { specs: out, ids };
}

/**
 * The inert document that gives the maintainer an editing handle on a row the
 * job market tracking sheet publishes.
 *
 * `sheetId` is the pin: it names the workbook row this mirror stands for, and
 * it survives the hand-over, so a posting the maintainer has edited still
 * disappears when its row leaves the workbook.
 */
export function sheetMirrorDoc(row, { now = new Date() } = {}) {
  return {
    ...submissionFromRow(row, { uid: null, status: MIRROR_STATUS }),
    sheetId: row.id,
    mirroredAt: now.toISOString(),
  };
}

/* Everything on a mirror EXCEPT the housekeeping stamp. Comparing the whole
   document would rewrite all 16 of them on every run — `mirroredAt` moves
   every time — which is a Firestore write per row per build, and a change log
   that says nothing. */
const MIRROR_VOLATILE = new Set(['mirroredAt']);

/** Has the workbook changed this posting since the mirror was written? */
export function mirrorDiffers(stored, fresh) {
  const keys = new Set([...Object.keys(stored || {}), ...Object.keys(fresh || {})]);
  for (const k of keys) {
    if (MIRROR_VOLATILE.has(k)) continue;
    if (JSON.stringify((stored || {})[k]) !== JSON.stringify((fresh || {})[k])) return true;
  }
  return false;
}

/**
 * Which of the workbook's rows the build should publish itself.
 *
 * `claimed` is the set of sheet ids whose document the maintainer has taken
 * over — edited, or taken down. Those rows are published FROM THE DOCUMENT (or
 * not at all, when it was taken down), so the workbook's own copy is dropped
 * here rather than left to win the merge by arriving last.
 */
export function unclaimedSheetRows(sheetRows, claimed) {
  const owned = claimed instanceof Set ? claimed : new Set(claimed || []);
  return (sheetRows || []).filter((r) => !owned.has(r.id));
}

/**
 * THE HAND-OVER DECISION, whole and pure: given what the documents produced,
 * which of the workbook's rows the build still publishes itself.
 *
 *   builtSheetIds   sheet ids whose document BUILT a row this run
 *   pulledSheetIds  sheet ids whose document was taken down (no row, on purpose)
 *   claimedSheetIds every sheet id that has a document at all
 *
 * The distinction between the last two and the first is the one that matters,
 * and it is not cosmetic. Dropping the workbook's copy for every row that HAS
 * a document loses a posting whenever a taken-over document fails to build — a
 * bad edit that cleared a required field, an unreadable document, a Firestore
 * hiccup: no row from the document, no row from the workbook, and the posting
 * simply disappears with a warning in a log nobody reads. A hand-over that
 * cannot publish falls back to the workbook, and is REPORTED as `stranded`.
 */
export function sheetHandover({
  sheetRows = [], builtSheetIds = [], pulledSheetIds = [], claimedSheetIds = [],
} = {}) {
  const built = builtSheetIds instanceof Set ? builtSheetIds : new Set(builtSheetIds);
  const pulled = pulledSheetIds instanceof Set ? pulledSheetIds : new Set(pulledSheetIds);
  const claimed = claimedSheetIds instanceof Set ? claimedSheetIds : new Set(claimedSheetIds);

  const publishedFromDoc = new Set([...built, ...pulled]);
  const present = new Set(sheetRows.map((r) => r.id));
  return {
    publishedFromDoc,
    rows: unclaimedSheetRows(sheetRows, publishedFromDoc),
    // only a row the workbook STILL carries can be stranded; one it has dropped
    // is meant to be gone, and its document is meant to publish nothing
    stranded: [...claimed].filter((id) => !publishedFromDoc.has(id) && present.has(id)),
  };
}

/* ------------------------------------------------------- what an edit changed

   The admin is e-mailed a before/after of every change to a published posting
   (the owner\u2019s request: an edit goes live automatically, and the human
   finds out rather than having to notice). The diff is computed here, over
   PUBLIC_FIELDS — the fields a reader can actually see — so an internal
   bookkeeping write (a status stamp, a cleared upload path) never produces an
   e-mail claiming the posting changed.                                       */

/** Field-by-field difference between two rows, public fields only. */
export function diffRows(before, after) {
  const out = [];
  for (const k of PUBLIC_FIELDS) {
    // `adPending` flips as a side effect of the build filing an upload into
    // Drive — bookkeeping, not an edit the poster made, so it never produces
    // a change e-mail on its own.
    //
    // `addedAt` is the same kind of thing and was missing from this list: it
    // records when the DATASET first saw the posting, it is the only cursor
    // the e-mail alerts have, and mergeRows carries it over from the previous
    // row precisely so that a re-read never re-stamps it. Nobody edits it, so
    // an "edit" naming it is always noise — 17 of the 23 phantom edits in the
    // daily admin e-mail were exactly this (owner, 2026-08-25). The block that
    // sends that e-mail already claims "bookkeeping writes never produce an
    // e-mail"; this is half of what makes the claim true (build-jobs diffing
    // the rows it WRITES rather than the raw ones is the other half).
    //
    // `years` is the third: it is DERIVED from `posted`, `year` and the two
    // apply-by dates on every build (marketYearsOf), so it can only "change"
    // when one of those did — and each of those is itself in this list and
    // reports the edit properly. Diffing it would have reported all 569
    // postings as edited on the single run that first wrote the field.
    if (k === 'id' || k === 'adPending' || k === 'addedAt' || k === 'years') continue;
    const a = before ? before[k] : undefined;
    const b = after ? after[k] : undefined;
    const av = Array.isArray(a) ? a.join(', ') : (a === undefined || a === null ? '' : String(a));
    const bv = Array.isArray(b) ? b.join(', ') : (b === undefined || b === null ? '' : String(b));
    if (av !== bv) out.push({ field: k, before: av, after: bv });
  }
  return out;
}

/**
 * Everything a build run changed, against the previously served rows.
 *
 *   edits      rows present before AND after whose visible content differs
 *   takedowns  rows removed because their posting was withdrawn or hidden
 *   added      count only — new postings already have their own channel (the
 *              subscriber alerts); the admin e-mail exists for CHANGES
 */
export function collectChanges(existingRows, freshRows, removeRefs = [], removeIds = []) {
  const key = (r) => (r.ref ? 'ref:' + r.ref : 'id:' + r.id);
  const before = new Map();
  for (const r of existingRows) before.set(key(r), r);

  const edits = [];
  let added = 0;
  for (const r of freshRows) {
    const prev = before.get(key(r));
    if (!prev) { added++; continue; }
    const fields = diffRows(prev, r);
    if (fields.length) edits.push({ before: prev, after: r, fields });
  }

  /* A TAKEDOWN IS NOT ALWAYS A REFERENCE. `ref` is the number the FORM issues,
     so every posting that came from the legacy import or the tracking sheet has
     none — which is every row served today — and keying the report on it alone
     reported nothing while the build removed the row. The id is what those are
     taken down by (the callers derive them with `removalSpecs` above), so both
     are read here. */
  const takedowns = [];
  const goneRefs = new Set(removeRefs.filter(Boolean));
  const goneIds = new Set([...(removeIds || [])].filter(Boolean));
  for (const r of existingRows) {
    if ((r.ref && goneRefs.has(r.ref)) || goneIds.has(r.id)) takedowns.push({ before: r });
  }

  return { edits, takedowns, added };
}

/** The admin e-mail body: one section per changed posting, before/after per
    field. Self-contained HTML (its own escaping) so the model stays free of
    the mail plumbing. */
export function renderChangesHtml({ edits, takedowns, added }) {
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const section = (title, row, rowsHtml) =>
    `<h3 style="margin:18px 0 4px;font-size:16px;">${esc(title)}</h3>
     <p style="margin:0 0 8px;color:#555;">${esc(row.institution)}${row.department ? ' \u2014 ' + esc(row.department) : ''}
        ${row.ref ? ' \u00b7 ' + esc(row.ref) : ''}</p>${rowsHtml}`;

  const table = (fields) =>
    `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr style="background:#f2f5f8;"><th align="left">Field</th><th align="left">Before</th><th align="left">After</th></tr>
      ${fields.map((f) =>
        `<tr>
          <td style="border-top:1px solid #e5e9ee;white-space:nowrap;vertical-align:top;"><strong>${esc(f.field)}</strong></td>
          <td style="border-top:1px solid #e5e9ee;vertical-align:top;color:#a3364a;">${esc(f.before) || '<em>(empty)</em>'}</td>
          <td style="border-top:1px solid #e5e9ee;vertical-align:top;color:#2e6b4f;">${esc(f.after) || '<em>(empty)</em>'}</td>
        </tr>`).join('')}
    </table>`;

  const parts = [];
  for (const e of edits) parts.push(section('Edited', e.after, table(e.fields)));
  for (const t of takedowns) {
    parts.push(section('Taken down', t.before,
      '<p style="margin:0;color:#a3364a;">This posting was withdrawn or hidden and has been removed from the list.</p>'));
  }
  if (added) {
    parts.push(`<p style="margin:16px 0 0;color:#555;">${added} new posting${added === 1 ? '' : 's'} also published this run (new postings go out via the e-mail alerts; this message covers changes).</p>`);
  }
  return parts.join('\n');
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

/** The advertisement a row points at — the one thing that can tell two
    same-day postings from one department apart. */
function adKey(row) {
  const link = String(row.adUrl || '').trim() || String(row.postedAtUrl || '').trim();
  /* our own home page is what a sheet row carries when it names no ad at all,
     so it identifies nothing */
  if (/^https?:\/\/(www\.)?operationsacademia\.org\/?$/i.test(link)) return '';
  return link.toLowerCase().replace(/\/+$/, '');
}

/** Two rows may be one posting unless they name two different advertisements.
    An absent link contradicts nothing — that is the repeat-submission case
    this function exists for. */
function sameAdvertisement(a, b) {
  const x = adKey(a), y = adKey(b);
  return !x || !y || x === y;
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
  /* One SLOT per advertisement, not per (place, day). Keying on the place and
     the date alone assumes a department advertises at most one post a day, and
     Houston's Bauer College disproves it: two rows on 2025-09-23, one for
     Assistant/Associate/Full "until filled" and one for Assistant only closing
     15 October, each with its own ad link. They survived only because one of
     them had omitted its school, so their `department` lines differed — and
     the moment both were canonicalised to the same department, this function
     silently dropped a real advertisement. That is the failure `normKey`'s
     comment above already records once, from a truncated key.

     So a row joins an existing slot only if it does not CONTRADICT it about
     which advertisement it is. A missing link contradicts nothing, which
     keeps the repeat-submission case this exists for. */
  const slots = [];            // { key, ad, row } in the order first seen

  let collapsed = 0;
  for (const row of rows) {
    const k = sameDayKey(row);
    const slot = slots.find((sl) => sl.key === k && sameAdvertisement(sl.row, row));
    if (!slot) { slots.push({ key: k, row }); continue; }
    slot.row = better(slot.row, row);
    collapsed++;
  }

  return { rows: slots.map((sl) => sl.row), collapsed };
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
 *
 * …and a THIRD shape, `{ id }`, which is how a row with NO reference is taken
 * down. `ref` is issued by the form and by nothing else, so every posting from
 * the legacy import and from the tracking sheet has none — today that is every
 * row served. Keyed on references alone this loop matched nothing at all and
 * the row was carried on as an orphan, so the takedown reported success and
 * changed nothing. A caller must build its specs with `removalSpecs`, which
 * decides whose word to take for each shape.
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
      for (const [k, r] of [...by]) if (specMatches(spec, r)) { by.delete(k); removed++; }
    } else if (spec.ref) {
      if (by.delete('ref:' + (spec.owner || '') + ':' + spec.ref)) removed++;
    } else if (spec.id) {
      /* TAKING DOWN A POSTING THAT HAS NO REFERENCE. Every row served today is
         one: `ref` is issued by the form, and the 94 postings from the legacy
         import and the 16 from the tracking sheet never went through it. Keyed
         on `ref` alone this loop matched nothing, the row was carried on as an
         orphan, and Take down looked like it had worked and changed nothing.
         `keyOf` keys a ref-less row by its id, which is what this deletes. */
      if (by.delete('id:' + spec.id)) removed++;
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
