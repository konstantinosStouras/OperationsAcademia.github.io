/* ---------------------------------------------------------------------------
   Operations Academia — the review queue for the tracking sheet's postings.

   THE PROBLEM THIS SOLVES. The maintainer's job market workbook is read every
   morning and everything in it went straight onto the public site. That is
   fine when the sheet is the whole truth, but it is not: the pipeline DERIVES
   things the sheet never said — the market year, the type of institution, the
   canonical country, the entry level, and now the closing date read off the
   HigherEdJobs advertisement. Those derivations reached visitors before anyone
   had looked at them.

   So a posting crawled from the sheet is no longer published on sight. It is
   QUEUED for the maintainer, who sees it as it would appear, corrects anything
   wrong, and approves it. Only then does it go live.

   WHERE THE QUEUE LIVES, AND WHY NOT IN data/. Everything under data/ is
   served by GitHub Pages to anyone who asks — that is the whole point of the
   directory, and CI has a check that no e-mail address ever reaches it. A
   posting "not yet public" therefore cannot sit there in any form. The queue
   is a Firestore collection, `jobReviews`, readable and writable by the
   maintainer alone (see _firestore.rules). data/jobmarket.json becomes what it
   always claimed to be: the APPROVED postings, and nothing else.

   THIS FILE IS THE PURE HALF — given the sheet's rows and the queue's
   documents it says which rows are publishable, what a queued document should
   contain, and what a posting looks like once the maintainer's edits are
   applied. It touches neither Firestore nor the network, which is what lets
   selftest.mjs drive all of it offline.
   --------------------------------------------------------------------------- */

import { createRequire } from 'node:module';

import {
  text, url, longDate, LEVELS, TYPES, canonCountry, canonColumns,
  ownUniversitiesLink, universitiesLink, stripRowEmails,
} from './jobs-model.mjs';
import { joinDepartment, businessSchoolOf, BUSINESS_SCHOOL_NAME_RX } from './vocab.mjs';

/* "Is this the same university?" — GROUPING, not publishing, exactly as the
   vocabulary uses it (see oa-schools.js institutionKey). The duplicate check
   below has to fold "The University of X" onto "University of X" or a posting
   made under one and crawled under the other would never be flagged. */
const require = createRequire(import.meta.url);
const { institutionKey, fold: foldName } = require('../assets/oa-schools.js');

/** The Firestore collection. Named here so the pipeline, the mailer and the
    page cannot drift apart on it. */
export const COLLECTION = 'jobReviews';

export const PENDING = 'pending';
export const APPROVED = 'approved';
export const REJECTED = 'rejected';

const STATUSES = [PENDING, APPROVED, REJECTED];

/**
 * What the maintainer may change, and how far.
 *
 * A SUBSET of what a posting holds, deliberately. `id`, `year`, `posted`,
 * `source` and `addedAt` are the row's identity and its bookkeeping: editing
 * them would either detach the posting from the sheet row it came from (so the
 * next sync would queue it all over again as new) or move it to another market
 * year behind the site's own roll rule. Those are corrected in the sheet.
 *
 * The caps mirror _firestore.rules, and selftest.mjs pins the two together —
 * a field added here without a rule would be refused by the database rather
 * than silently dropped.
 *
 * `department` is `derived`, which is a different thing from editable and from
 * forbidden. It is the LINE THE CARD SHOWS — the school and the department
 * joined (`joinDepartment`) — so offering it beside the two names it is made
 * of gave the review card FOUR boxes for a place that has three, and let the
 * three disagree: nothing recomputed it, so correcting the school published a
 * row whose `department` still said what the workbook had said. That is not a
 * cosmetic fault. `selftest.mjs` asserts over the whole served file that the
 * line equals its two parts joined, and a red selftest by design stops
 * `oa-jobs-build.yml` committing ANYTHING — so one corrected school would have
 * stopped the entire site publishing. It is therefore no longer drawn (the
 * card offers the posting form's own three boxes) and no longer read from a
 * fresh edit; `applyEdits` derives it. It stays in this list, and in the
 * rules, because a document written before this change may still carry one —
 * see the fallback there.
 *
 * `applyBy` is `derived` for exactly the same reason, and it took exactly the
 * same course before anyone noticed. It is the LINE THE CARD SHOWS for the
 * closing date, and the card offered it beside the date it is made of — two
 * boxes for one fact, with nothing keeping them in step. One posting was
 * approved with that box emptied and its closing date left behind, and
 * `selftest.mjs` asserts over the served file that the date shown and the date
 * filtered on are the same date: the sheet read went red, so the approved
 * postings were never written to `data/jobmarket.json`, and the build went red
 * behind it, so NOTHING published at all. `applyEdits` derives the line now
 * (`settleDeadline`); the maintainer sets the closing date and reads the line
 * back under it, and words that belong to a search with no closing date go in
 * the comments, which are editable.
 *
 * The labels are the posting form's own words (post-a-job.html), so the
 * maintainer reads the same question the poster answered.
 */
export const EDITABLE = [
  { key: 'institution', label: 'University / Institution', max: 220 },
  { key: 'department', label: 'School / department', max: 260, derived: true },
  { key: 'school', label: 'School, faculty or college', max: 200 },
  { key: 'unit', label: 'Department, area or group', max: 200 },
  { key: 'type', label: 'Type of institution', max: 40, oneOf: TYPES },
  { key: 'levels', label: 'Entry level', list: true, oneOf: LEVELS },
  { key: 'country', label: 'Country', max: 80 },
  { key: 'applyBy', label: 'Apply by', max: 400, derived: true },
  { key: 'applyByDate', label: 'Closing date', max: 10, date: true },
  { key: 'reviewDate', label: 'Suggested apply by', max: 10, date: true },
  { key: 'comments', label: 'Comments', max: 1500 },
  { key: 'adUrl', label: 'Link to the advert', max: 600, url: true },
  { key: 'postedAtUrl', label: 'Posted at', max: 600, url: true },
  { key: 'furtherInfoUrl', label: 'Further info', max: 600, url: true },
];

const EDITABLE_KEYS = EDITABLE.map((f) => f.key);

/** What the review card actually draws — everything but the derived line.
    Exported so selftest.mjs can pin the panel against it rather than
    against EDITABLE, which is the wider set the RULES have to allow. */
export const SHOWN = EDITABLE.filter((f) => !f.derived);

/** Every key a `jobReviews` document may carry. `ad` is what the posting's
    own advertisement says — title, closing date, whether the listing is
    still up — written by adverts-verify.mjs's queue pass and drawn on the
    review card. Like `dup` and `biz` it is RAISED, never decided: the card's
    button only fills the closing-date box, and nothing publishes until the
    maintainer approves. */
export const DOC_KEYS = [
  'rowId', 'status', 'row', 'edits',
  'queuedAt', 'reviewedAt', 'mailedAt', 'note', 'dup', 'biz', 'ad',
];

/* ------------------------------------------------------------------ queue */

/**
 * The document for a row the queue has not seen: pending, carrying the row as
 * the pipeline derived it.
 *
 * The row is SNAPSHOT into the document rather than left in data/ because the
 * queue is the only place a not-yet-public posting may exist (see the header).
 * It is refreshed by `refreshQueued` whenever the sheet changes underneath.
 */
export function queueDoc(row, { now = '', dup = [], biz = null } = {}) {
  return {
    rowId: row.id,
    status: PENDING,
    row: publishableRow(row),
    edits: {},
    queuedAt: now,
    reviewedAt: '',
    mailedAt: '',
    note: '',
    dup,
    biz,
  };
}

/**
 * The sheet has been re-read: bring a queued document's copy of the row up to
 * date WITHOUT touching the maintainer's decision or their edits.
 *
 * This is the case that makes the queue survive a sheet that keeps moving. A
 * posting queued on Monday whose department is corrected in the workbook on
 * Tuesday must show Tuesday's department when it is finally reviewed — but it
 * must still be pending, and any wording the maintainer has already typed must
 * still be theirs. Returns null when nothing changed, so an unchanged sync
 * writes nothing at all.
 */
export function refreshQueued(doc, row) {
  const next = publishableRow(row);
  if (JSON.stringify(next) === JSON.stringify(doc.row || {})) return null;
  return { ...doc, row: next };
}

/** The fields of a row that the queue carries. Everything a card renders, and
    nothing else — a document is not a place to accumulate pipeline internals
    (the `_tab`/`_sheet` provenance keys are dropped here, as publicRow drops
    them from the served file). */
export function publishableRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

/* ----------------------------------------------------------------- edits */

/**
 * One field the maintainer typed, cleaned — or undefined when it is not
 * something they may set.
 *
 * Every value is passed through the same sanitisers the ingest uses, so an
 * edit cannot introduce something a sheet row could not contain: a URL must
 * be a URL (`url()` host-validates and drops a `javascript:` scheme), a
 * country is canonicalised so an edit cannot re-fork the Location filter, a
 * type or an entry level must be one the site knows, and a closing date must
 * be an ISO day.
 */
export function cleanEdit(key, value) {
  const field = EDITABLE.find((f) => f.key === key);
  if (!field) return undefined;

  if (field.list) {
    const want = Array.isArray(value) ? value : [value];
    const kept = want.map((v) => text(v, 80)).filter((v) => field.oneOf.includes(v));
    return kept.length ? Array.from(new Set(kept)) : undefined;
  }

  let v = text(value, field.max);
  if (field.url) v = url(v);
  if (field.key === 'country') v = canonCountry(v);
  if (field.oneOf && v && !field.oneOf.includes(v)) return undefined;
  if (field.date && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  return v;
}

/** A whole edit map, cleaned. Unknown keys are dropped, not refused: the
    maintainer's browser is not the authority on what a posting holds, and a
    field this build does not know about is a field it must not publish. */
export function cleanEdits(edits) {
  const out = {};
  for (const [k, v] of Object.entries(edits || {})) {
    const clean = cleanEdit(k, v);
    if (clean !== undefined) out[k] = clean;
  }
  return out;
}

/**
 * The posting as it should be published: the row the sheet gave, with the
 * maintainer's edits on top.
 *
 * THE TWO DEADLINE FIELDS MOVE TOGETHER, exactly as they do in the
 * HigherEdJobs apply and for the same reason: the jobs page buckets a posting
 * as open-ended on the DATE being empty (assets/oa-list.js), so a date shown
 * on the card while the filter still called it "Until filled" would be the
 * worst of both. Editing one therefore settles the other unless the maintainer
 * set it too.
 *
 * THE THREE NAMES MOVE TOGETHER TOO, and that one is not a nicety. See
 * `settlePlace` below.
 */
export function applyEdits(row, edits) {
  const clean = cleanEdits(edits);
  const out = { ...row, ...clean };

  /* A line the maintainer wrote that says the search stays open takes the date
     with it — the one direction where their words, not the date, are the fact
     being stated. Everything else is settled by `settleDeadline`. */
  if ('applyBy' in clean && !('applyByDate' in clean) && OPEN_ENDED.test(clean.applyBy)) {
    out.applyByDate = '';
  }
  /* The SUGGESTED apply-by keeps healReviewDate's rule wherever it is set:
     a first-review date on or after the closing date is the closing date said
     twice, or a contradiction, and is not published — whichever of the two
     boxes the maintainer moved. */
  if (out.reviewDate && out.applyByDate && out.reviewDate >= out.applyByDate) {
    out.reviewDate = '';
  }
  /* NOTHING UNDER data/ MAY CARRY AN E-MAIL, and an approved queue document
     is a writer of data/: an address typed into the comments while reviewing
     — or carried in from the workbook's notes — stopped every build from
     committing on 2026-08-24 (the served-file guard, doing its job on the
     wrong target). Stripped here, at the ingest, like rowFromSubmission. */
  return stripRowEmails(settlePlace(settleDeadline(out), row));
}

/** A line that says the search has no closing date rather than naming one. */
const OPEN_ENDED = /until\s*filled|open\s*until|rolling/i;

/**
 * The closing date and the line the card shows for it, settled against each
 * other — the deadline's `settlePlace`.
 *
 * THE LINE IS DERIVED, never edited. The jobs page buckets a posting as
 * open-ended on the DATE being empty (assets/oa-list.js) while the card prints
 * the LINE, so the two disagreeing is the worst of both: a date on the card
 * that the Deadline filter does not know about, or the reverse. `selftest.mjs`
 * says so over the whole served file — "the date shown and the date filtered
 * on are the same date" — and a red selftest by design stops the sheet read
 * and the build from committing ANYTHING.
 *
 * That is not hypothetical. One approved posting carried a closing date of
 * 2026-10-05 and an EMPTY line, because the review card offered a box for each
 * and emptying one left the other behind. Both workflows went red on it and
 * 449 approved postings never reached the site.
 *
 * So: a date is shown as its own long form, and a row with no date says what
 * it said about staying open, or "Until filled." — the ingest's own default
 * for an empty deadline cell, and what the page's filter already calls it.
 * Pure and idempotent, so every build may re-apply it.
 */
export function settleDeadline(row) {
  const date = text(row.applyByDate, 10);
  const line = text(row.applyBy, 400);
  if (date) return { ...row, applyByDate: date, applyBy: longDate(date) };
  return { ...row, applyByDate: '', applyBy: OPEN_ENDED.test(line) ? line : 'Until filled.' };
}

/**
 * The university, the school, the department and the line the card shows,
 * settled against each other.
 *
 * TWO THINGS, and each of them was a way for one edit to stop the whole site
 * publishing.
 *
 * ONE SPELLING PER PLACE. `cleanEdit` canonicalised the country and nothing
 * else, so a school typed here reached `data/jobs.json` exactly as typed —
 * while `selftest.mjs` asserts over that file that every posting names its
 * place the way `canonPlace` names it, and a red selftest stops the build
 * committing. So the three go through `canonColumns()`, the same function the
 * posting form's three boxes go through (never `canonPlace`, which is for the
 * archive's single column and would read a lone university as a university and
 * a department). It is pure and idempotent — over the live sheet rows it
 * changes nothing — so it also HEALS: an alias added to oa-schools.js today
 * reaches a posting queued last week, the same reasoning as `healPlace`.
 *
 * THE LINE IS DERIVED, never edited. `department` is `school, unit` joined, and
 * the selftest asserts exactly that over the served file. With three
 * independent boxes, correcting the school left the line saying what the
 * workbook had said, and the two disagreed in public.
 *
 * The one row shape that has no parts is the sheet's own fallback
 * (`jobmarket-sheet.mjs` publishes `joinDepartment(...) || area`, so a row
 * whose area canonicalised away to nothing keeps its raw line). Such a row is
 * left with the line it arrived with — deriving would blank it, and the card,
 * the University search and the alert matcher all read it. A row that HAD
 * parts and no longer has any is a deliberate clearing and gets an empty line,
 * which keeps the file self-consistent either way.
 */
export function settlePlace(out, row = {}) {
  const place = canonColumns({
    institution: out.institution || '',
    school: out.school || '',
    unit: out.unit || '',
  });

  const settled = { ...out, ...place };
  const line = joinDepartment(place.school, place.unit);
  settled.department = line
    || ((row.school || row.unit) ? '' : (out.department || ''));

  /* THE SITE'S OWN LINK FOLLOWS THE NAME, here as everywhere. The workbook's
     ingest builds the "Further info" link from the institution AS THE SHEET
     WROTE IT, so a review edit that corrects the name ("MIT Sloan" ->
     "Massachusetts Institute of Technology (MIT)") left the stored link asking
     the Universities page for a spelling no posting uses any more — and the
     selftest's "no posting links to a university under a name it does not use"
     guard went red on the freshly-built jobs.json, which by design stops the
     build committing ANYTHING. Three approved postings held the whole site's
     publishing for a day exactly this way (NUS, Chicago Booth, MIT Sloan,
     2026-08-23). Ours is ours to regenerate; a link the sheet's contributor
     actually gave is left alone — the same rule as healPlace. */
  if (place.institution && ownUniversitiesLink(settled.furtherInfoUrl)) {
    settled.furtherInfoUrl = universitiesLink(place.institution);
  }
  return settled;
}

/**
 * The row an APPROVED document publishes — the maintainer's edits applied,
 * and the posting DATED FROM ITS APPROVAL.
 *
 * `addedAt` is what the e-mail alerts window on ("new postings since the last
 * digest"), and for a gate-held posting the queue's copy carries the day the
 * CRAWLER first saw it — which can be days before anybody could read it on
 * the site. Dated that way, a posting approved after a subscriber's last
 * digest but crawled before it fell OUTSIDE every window and was announced to
 * nobody. The day it reached the site is the day it was approved, so that is
 * the day it is dated from.
 *
 * Grandfathered documents are exempt, and the discriminator is exact:
 * `partition` stamps their `reviewedAt` and `queuedAt` from the same instant,
 * while a real decision's `reviewedAt` is the browser's own later write. The
 * sixteen postings that were public before the gate existed were already
 * announced, and re-dating them would blast every subscriber about postings
 * they were told about weeks ago.
 *
 * Deterministic from the document alone, so the two writers that publish an
 * approval — the sheet sync's `partition` and build-jobs' direct read of the
 * queue — cannot disagree and the served file cannot flap between them.
 */
export function approvedRow(row, doc) {
  const out = applyEdits(row, doc && doc.edits);
  const reviewed = String((doc && doc.reviewedAt) || '');
  const queued = String((doc && doc.queuedAt) || '');
  if (reviewed && reviewed !== queued) {
    const t = Date.parse(reviewed);
    if (!Number.isNaN(t)) {
      const stamp = new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
      if (!out.addedAt || out.addedAt < stamp) out.addedAt = stamp;
    }
  }
  return out;
}

/* ------------------------------------------------------------- duplicates */

/** The advertisement a row points at, normalised for comparison. Our own home
    page is what a sheet row carries when it names no ad at all, so it
    identifies nothing — the same reading as `adKey` in jobs-model.mjs. */
function dupLinks(row) {
  return [row.adUrl, row.postedAtUrl]
    .map((v) => String(v || '').trim().toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, ''))
    .filter((v) => v && !/^operationsacademia\.org$/.test(v));
}

/** A name folded for "is this the same department?" — diacritics and
    punctuation dropped, "&" read as "and", via oa-schools' own fold(). */
function foldedName(v) {
  return foldName(String(v || ''));
}

/** What a duplicate entry carries onto the queue document: enough for the
    review card to say which posting it might repeat, and nothing else — a
    document is not a place to copy whole rows into. */
function dupEntry(r) {
  return {
    id: String(r.id || ''),
    ref: String(r.ref || ''),
    source: String(r.source || ''),
    institution: String(r.institution || ''),
    department: String(r.department || ''),
    posted: String(r.posted || ''),
  };
}

/**
 * The postings already on the site that a crawled row may DUPLICATE — the
 * same job, posted through the site's own form (or an earlier import) before
 * the crawler found it.
 *
 * A FLAG, never a collapse: the maintainer decides on the review card, which
 * is why the rules here are looser than `collapseSameDay`'s (that one silently
 * drops a row, so it demands the same DAY; a person reading a warning does
 * not). Two rows are flagged when they share the market year and the
 * university AND either point at the same advertisement or name the same
 * department. The one contradiction honoured is the Houston lesson: both rows
 * carrying entry levels with none in common are two different advertisements
 * from one department, not one posting twice.
 */
export function duplicatesOf(row, siteRows, { max = 3 } = {}) {
  if (!row || !row.institution) return [];
  const key = institutionKey(row.institution);
  const links = dupLinks(row);
  const unit = foldedName(row.unit);
  const line = foldedName(row.department);
  const levels = Array.isArray(row.levels) ? row.levels : [];

  const out = [];
  for (const s of siteRows || []) {
    if (!s || !s.institution || String(s.id || '') === String(row.id || '')) continue;
    if (Number(s.year) !== Number(row.year)) continue;
    if (institutionKey(s.institution) !== key) continue;

    const sLevels = Array.isArray(s.levels) ? s.levels : [];
    if (levels.length && sLevels.length && !levels.some((l) => sLevels.includes(l))) continue;

    const sameAd = dupLinks(s).some((l) => links.includes(l));
    const sameUnit = !!unit && foldedName(s.unit) === unit;
    const sameLine = !!line && foldedName(s.department) === line;
    if (sameAd || sameUnit || sameLine) out.push(dupEntry(s));
    if (out.length >= max) break;
  }
  return out;
}

/** Two duplicate lists that say the same thing — so a sync with nothing new
    to report writes nothing at all. */
export function sameDups(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

/* ------------------------------------------- the same advertisement, twice */

/* ONE DEFINITION, SHARED WITH THE BROWSER. The rule that decides whether a
   crawled posting is simply a repeat of one already listed lives in
   `assets/oa-advert-dup.js`, a dual-mode module, because TWO things act on it
   and must never disagree: this pipeline (the sheet sync drops a repeat rather
   than queueing it) and the Admin area's "Check for duplicate adverts" button,
   which sweeps the queue on demand. A browser copy would drift the first time
   either was corrected — the drift every other shared module here exists to
   prevent — so both read the same file and the selftest pins them together.

   The guards, and the measurement that scoped them, are in that file's header.
   Re-exported under the same names, so nothing that imported them moved. */
export const {
  advertLink, advertRepeat, findAdvertRepeats, repeatNote,
} = require('../assets/oa-advert-dup.js');

/* -------------------------------------------------------- business school */

/**
 * The business-school flag on a queue document (owner, 2026-08-23): a crawled
 * posting whose text mentions "business" is typed Business School at ingest
 * (typeFromNames in jobmarket-sheet.mjs), and its review card should then
 * NAME the business school the site's own directory knows at that university
 * — so the maintainer confirms Haas is the school doing the hiring instead of
 * looking it up.
 *
 * `null` when there is nothing to raise: the posting is not business-typed,
 * or its School field already names a business school itself, in which case
 * the card would only be repeating what is in the box above it. Otherwise
 * `{ school }` — the directory's answer, or '' when the directory has none
 * (the card still raises the flag, and says the directory does not know; the
 * fix, as everywhere, is a row in assets/oa-institutions.js, never a guess).
 *
 * A MENTION, never a fill: `fillSchoolFromDirectory` fills a school only on
 * the evidence of the department it houses; "the posting says business" is
 * evidence about the POSTING, and the maintainer decides on the card.
 */
export function businessCheck(row, vocab, schools = null) {
  if (!row || row.type !== 'Business School') return null;
  if (BUSINESS_SCHOOL_NAME_RX.test(String(row.school || ''))) return null;
  return {
    school: schools
      ? businessSchoolOf(vocab, row.institution, schools)
      : businessSchoolOf(vocab, row.institution),
  };
}

/** Two flags that say the same thing — the `sameDups` rule, for `biz`, so an
    unchanged sync writes nothing. */
export function sameBiz(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/* --------------------------------------------------------------- deciding */

/**
 * Split the sheet's rows by what the queue says about each:
 * `{ publish, queue, refresh, rejected, pending }`.
 *
 * - `publish`  rows the maintainer has approved, with their edits applied —
 *              what data/jobmarket.json is allowed to hold.
 * - `queue`    rows the queue has never seen, as documents to write.
 * - `refresh`  queued rows whose sheet content has moved since.
 * - `rejected` rows the maintainer turned down; they stay out and are NOT
 *              re-queued, or every sync would ask again about a posting they
 *              have already said no to.
 *
 * A row with no document is NEVER publishable. That is the whole gate, and it
 * is expressed as "absence means withhold" rather than "presence of a
 * rejection means withhold" so that a queue that fails to write cannot leak a
 * posting onto the site.
 *
 * `published` is the one exception, and it is about the gate ARRIVING rather
 * than about what it does: pass the ids the site is already showing and they
 * are grandfathered in (see below) instead of being retracted.
 */
export function partition(rows, docs, { now = '', published = null } = {}) {
  const byId = new Map();
  for (const d of docs || []) if (d && d.rowId) byId.set(d.rowId, d);
  const live = published instanceof Set ? published : new Set(published || []);

  const publish = [];
  const queue = [];
  const refresh = [];
  const rejected = [];
  const pending = [];

  for (const row of rows || []) {
    const doc = byId.get(row.id);

    if (!doc) {
      /* ALREADY PUBLIC IS ALREADY REVIEWED, in the only sense that matters:
         people can read it on the site today, and alerts about it have gone
         out. The gate exists to stop a posting reaching visitors before the
         maintainer has seen what the pipeline DERIVED for it, which cannot be
         undone by taking sixteen live postings down on the morning the queue
         first answers. So a row the site is already showing enters the queue
         approved, with the reason written into it — visible in the list,
         editable, and still rejectable, which takes it down.

         Anything the site is NOT already showing is queued pending, which is
         the whole of the gate for every posting from here on. */
      const fresh = queueDoc(row, { now });
      if (live.has(row.id)) {
        fresh.status = APPROVED;
        fresh.reviewedAt = now;
        fresh.note = 'Published before the review gate existed, so it was kept on the site. '
          + 'Reject it to take it down.';
        publish.push(row);
      }
      queue.push(fresh);
      continue;
    }

    if (doc.status === APPROVED) {
      publish.push(approvedRow(row, doc));
      continue;
    }

    if (doc.status === REJECTED) { rejected.push(row); continue; }

    pending.push(doc);
    const moved = refreshQueued(doc, row);
    if (moved) refresh.push(moved);
  }

  return { publish, queue, refresh, rejected, pending };
}

/** Is this a status the site knows? Anything else is treated as pending —
    withholding, which is the safe direction. */
export function isStatus(s) { return STATUSES.includes(s); }

/**
 * The postings queued and never mailed about, in the order they should be
 * announced (oldest first, so a backlog is worked through in the order it
 * arrived rather than newest-first like the review list).
 */
export function needMail(docs) {
  return (docs || [])
    .filter((d) => d && d.status === PENDING && !d.mailedAt)
    .sort((a, b) => String(a.queuedAt || '').localeCompare(String(b.queuedAt || '')));
}

/** The keys of an edit map that actually change the row — used to show the
    maintainer what they have altered, and to keep an empty edit out of the
    document. */
export function changedKeys(row, edits) {
  const clean = cleanEdits(edits);
  return EDITABLE_KEYS.filter((k) => k in clean
    && JSON.stringify(clean[k]) !== JSON.stringify(row ? row[k] : undefined));
}
