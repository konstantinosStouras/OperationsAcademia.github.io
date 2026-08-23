/* ---------------------------------------------------------------------------
   Operations Academia — what has been posted through the site and not yet
   looked at.

   THE GAP THIS FILLS. Two queues reach the maintainer and only one of them
   ever said anything. A posting crawled from the tracking sheet is held in
   `jobReviews` and e-mailed about (see jobreview.mjs); a posting or a
   candidate profile made through the site's OWN forms went straight into
   Firestore, was published by the next build, and nobody was told. Nothing was
   broken — it is the design, and it is right that a poster's own posting does
   not wait on anybody — but "nobody was told" is not the same thing as "nobody
   needed to know", and for candidates it was worse than that: their profiles
   are held behind the reveal date (data/candidates-reveal.json), so they are
   in no served file, draw no card anywhere on the site, and the maintainer had
   no screen that could show them at all.

   SO: THE SUBMISSION ITSELF CARRIES THE BOOKKEEPING. Not a new collection —
   `jobSubmissions` and `candidateSubmissions` are already admin-readable and
   admin-writable in _firestore.rules, so the queue is a QUERY, not a copy, and
   nothing here needs the rules redeployed. Two stamps:

     announcedAt   the mailer's high-water mark. Set only after an e-mail has
                   actually been handed to a transport, so a run that cannot
                   send announces the same submission next time rather than
                   losing it.
     reviewedAt    the maintainer pressed "Reviewed" on the Admin area. It
                   takes the card off the list and nothing else — the posting
                   was already live, this is a to-do list, not a gate.

   WHY NOT A GATE. Withholding a poster's own posting until somebody approves
   it would break a promise the forms make in as many words ("within a few
   minutes"), and it is not what was asked for. What was asked for is to be
   TOLD, and to have somewhere to look.

   THE PURE HALF. Given documents and the served files it says which
   submissions are waiting, which need announcing, and what each one is — no
   Firestore, no network, so selftest.mjs drives all of it offline.
   --------------------------------------------------------------------------- */

import { rowFromSubmission, MIRROR_STATUS } from './jobs-model.mjs';
import { rowFromCandidateSubmission } from './candidates-model.mjs';

/**
 * The one-off grandfather date.
 *
 * THE FEATURE ARRIVING IS NOT A REASON TO SEND A HUNDRED E-MAILS. Everything
 * ever posted through the site is live and unannounced by definition on the
 * first run, and announcing the lot would bury the thing the maintainer
 * actually wants to see. Anything created before this date that the site is
 * ALREADY SHOWING is stamped without an e-mail — already public is already
 * past the point where being told helps.
 *
 * BOTH CONDITIONS, and the date is what makes the pair safe. "Already on the
 * site" ALONE would swallow a genuinely new posting, because the build
 * publishes within about a minute of it arriving and this runs every quarter
 * of an hour — the posting would reach the served file first and be silently
 * written off. With the date, that check can only ever apply to the backlog.
 *
 * A submission from before the date that is NOT on the site is announced,
 * which is deliberate and is the case that prompted all this: the candidate
 * profiles held behind the reveal date are exactly that.
 */
export const SINCE = '2026-08-19';

/** The stamps. Named here so the mailer, the panel and the rules cannot
    drift on them; selftest.mjs pins the browser panel against these. */
export const ANNOUNCED_AT = 'announcedAt';
export const REVIEWED_AT = 'reviewedAt';

/* The statuses a submission is LIVE in — the same pair every build reads
   (`where('status', 'in', ['queued', 'published'])`). A withdrawn, hidden or
   removed submission is not waiting for anything, and a `sheet` mirror is the
   tracking sheet's own row, which has its own queue. */
const LIVE = ['queued', 'published'];

/**
 * The two kinds, and everything that differs between them.
 *
 * One table rather than two code paths: a third kind (placements) is an entry
 * here and nothing else. `summarise` returns what both the e-mail and the
 * panel show, so neither can invent a field the other does not have.
 */
export const KINDS = [
  {
    key: 'job',
    collection: 'jobSubmissions',
    one: 'job posting',
    many: 'job postings',
    editPath: 'post-a-job.html?edit=',
    dataset: 'jobs.json',
    row: (doc, opts) => rowFromSubmission(doc, opts),
    summarise: (doc, row) => [
      ['Institution', (row && row.institution) || doc.institution || ''],
      ['School / department', (row && row.department) || doc.department || ''],
      ['Entry level', ((row && row.levels) || doc.levels || []).join(', ')],
      ['Country', (row && row.country) || doc.country || ''],
      ['Suggested apply by', (row && row.reviewDate) || doc.reviewDate || ''],
      ['Final apply by', (row && row.applyBy) || doc.applyBy || ''],
      ['Advertisement', (row && row.adUrl) || doc.adUrl || ''],
    ],
    headline: (doc, row) => [(row && row.institution) || doc.institution || 'a posting',
      (row && row.department) || doc.department || ''].filter(Boolean).join(' — '),
  },
  {
    key: 'candidate',
    collection: 'candidateSubmissions',
    one: 'candidate profile',
    many: 'candidate profiles',
    editPath: 'post-a-candidate.html?edit=',
    dataset: 'candidates.json',
    row: (doc, opts) => rowFromCandidateSubmission(doc, opts),
    summarise: (doc, row) => [
      ['Name', (row && row.name) || [doc.first, doc.last].filter(Boolean).join(' ')],
      ['Now at', (row && row.affiliation) || doc.affiliation || ''],
      ['Position', (row && row.position) || doc.position || ''],
      ['Research areas', ((row && row.researchAreas) || doc.researchAreas || []).join(', ')],
      ['CV', (row && row.cvUrl) || doc.cvUrl || ''],
      ['Website', (row && row.webUrl) || doc.webUrl || ''],
    ],
    headline: (doc, row) => [
      (row && row.name) || [doc.first, doc.last].filter(Boolean).join(' ') || 'a profile',
      (row && row.affiliation) || doc.affiliation || ''].filter(Boolean).join(' — '),
  },
];

export function kindOf(key) {
  return KINDS.find((k) => k.key === key) || null;
}

/** The day a submission was stored, as YYYY-MM-DD — Firestore Timestamp, Date
    or ISO string alike. Empty when the document carries no stamp at all,
    which reads as "before everything" and is the safe direction here: an
    undated submission is treated as backlog rather than announced twice. */
export function createdDay(doc) {
  const v = doc && doc.createdAt;
  if (!v) return '';
  const d = typeof v.toDate === 'function' ? v.toDate()
    : (v instanceof Date ? v : new Date(v));
  return d instanceof Date && !Number.isNaN(+d) ? d.toISOString().slice(0, 10) : '';
}

/** Live, and neither withdrawn nor a tracking-sheet mirror. */
export function isLive(doc) {
  if (!doc) return false;
  if (doc.status === MIRROR_STATUS) return false;
  return LIVE.includes(doc.status);
}

/** Live and not yet ticked off by the maintainer — what the panel lists. */
export function isWaiting(doc) {
  return isLive(doc) && !doc[REVIEWED_AT];
}

/**
 * Split live submissions of one kind into `{ announce, grandfather }`.
 *
 * `announce`  e-mail these, oldest first, so a backlog is worked through in
 *             the order it arrived — the same choice `needMail` makes for the
 *             tracking sheet's queue.
 * `grandfather` stamp these as announced and send nothing: the backlog the
 *             site is already showing (see SINCE).
 *
 * `publishedIds` is the set of row ids the served dataset carries. Pass it as
 * a Set of ids; an empty one simply means nothing is grandfathered.
 */
export function partitionSubmissions(kind, entries, { since = SINCE, publishedIds = null, now = new Date() } = {}) {
  const live = publishedIds instanceof Set ? publishedIds : new Set(publishedIds || []);
  const announce = [];
  const grandfather = [];

  for (const e of entries || []) {
    const doc = e.data || {};
    if (!isLive(doc) || doc[ANNOUNCED_AT]) continue;

    const day = createdDay(doc);
    const old = !day || day < since;
    let row = null;
    try { row = kind.row(doc, { now }); } catch { row = null; }

    if (old && row && live.has(row.id)) {
      grandfather.push({ ...e, row });
      continue;
    }
    announce.push({ ...e, row });
  }

  announce.sort((a, b) =>
    String(createdDay(a.data) || '').localeCompare(String(createdDay(b.data) || ''))
    || String(a.id).localeCompare(String(b.id)));

  return { announce, grandfather };
}

/** The ids a served dataset carries, for `publishedIds` above. */
export function idsOf(rows) {
  return new Set((rows || []).map((r) => r && r.id).filter(Boolean));
}
