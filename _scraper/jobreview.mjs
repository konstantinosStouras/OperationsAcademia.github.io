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

import {
  text, url, longDate, LEVELS, TYPES, canonCountry, canonColumns,
} from './jobs-model.mjs';
import { joinDepartment } from './vocab.mjs';

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
  { key: 'applyBy', label: 'Apply by', max: 400 },
  { key: 'applyByDate', label: 'Closing date', max: 10, date: true },
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

/** Every key a `jobReviews` document may carry. */
export const DOC_KEYS = [
  'rowId', 'status', 'row', 'edits',
  'queuedAt', 'reviewedAt', 'mailedAt', 'note',
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
export function queueDoc(row, { now = '' } = {}) {
  return {
    rowId: row.id,
    status: PENDING,
    row: publishableRow(row),
    edits: {},
    queuedAt: now,
    reviewedAt: '',
    mailedAt: '',
    note: '',
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

  if ('applyByDate' in clean && !('applyBy' in clean)) {
    out.applyBy = clean.applyByDate ? longDate(clean.applyByDate) : 'Until filled.';
  }
  if ('applyBy' in clean && !('applyByDate' in clean)
      && /until\s*filled|open\s*until|rolling/i.test(clean.applyBy)) {
    out.applyByDate = '';
  }
  return settlePlace(out, row);
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
  return settled;
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
      publish.push(applyEdits(row, doc.edits));
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
