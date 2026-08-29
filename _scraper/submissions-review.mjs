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
   nothing here needs the rules redeployed. Three stamps, one per thing that
   can happen to a submission, and NEVER shared:

     announcedAt   the mailer's high-water mark for the MAINTAINER's e-mail.
                   Set only after an e-mail has actually been handed to a
                   transport, so a run that cannot send announces the same
                   submission next time rather than losing it.
     reviewedAt    the maintainer pressed "Reviewed" on the Admin area. It
                   takes the card off the list and nothing else — the posting
                   was already live, this is a to-do list, not a gate.
     liveMailedAt  the POSTER was told their posting is publicly shown (owner,
                   2026-08-29 — see `partitionLive` at the foot of this file).

   Three marks rather than one because they answer three questions with three
   different failure modes: an SMTP hiccup on the maintainer's copy must not
   make the poster unthankable, a tick on the Admin area must not silence
   either e-mail, and a correction that re-publishes a posting must not thank
   its poster a second time.

   WHY NOT A GATE. Withholding a poster's own posting until somebody approves
   it would break a promise the forms make in as many words ("within a few
   minutes"), and it is not what was asked for. What was asked for is to be
   TOLD, and to have somewhere to look.

   THE PURE HALF. Given documents and the served files it says which
   submissions are waiting, which need announcing, and what each one is — no
   Firestore, no network, so selftest.mjs drives all of it offline.
   --------------------------------------------------------------------------- */

import { rowFromSubmission, MIRROR_STATUS, contactEmail } from './jobs-model.mjs';
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
    /* The poster is written to when this becomes publicly shown — see
       `partitionLive` below. A capability rather than a branch in the mailer,
       and false for candidates because their profiles are HELD until the
       reveal date, which is a different message with a different trigger. */
    tellsPoster: true,
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

/* ------------------------------------- and the POSTER hears when it goes live

   Owner, 2026-08-29: *"any user who submits a job posting should receive an
   email with the details of their posting once it becomes publicly shown on
   the website, and thank them for using OperationsAcademia.org and wishing
   them all the best to fill their position."*

   The site told the poster nothing after the thank-you screen — which said, in
   as many words, that no confirmation e-mail would be sent. They had a
   reference number and a promise of "a few minutes", and no way to know the
   minutes had passed short of going and looking.

   "PUBLICLY SHOWN" IS MEASURED, NEVER ASSUMED. The condition is that the
   posting's row is in the served `data/jobs.json` this run has just read — the
   same set `partitionSubmissions` already reads for its grandfather rule. So
   the e-mail cannot go out ahead of the build, cannot go out for a posting a
   guard held back, and cannot claim a link that would 404: the row it names is
   the row the reader will be shown, and the details it prints are the ones the
   site is printing.

   ITS OWN HIGH-WATER MARK, `liveMailedAt`, stamped only after a send succeeds
   — so a run that cannot send tries again next time, and a poster is thanked
   exactly once. That is what makes the EDIT path safe: correcting a posting
   sets its status back to 'queued' and re-publishes it, and the stamp is
   already there, so nobody is thanked twice for one job. Withdrawing and
   re-posting is the same document too.

   NO RULES CHANGE. `jobSubmissions` has no `hasOnly()` and its update rule
   places no ceiling on the key count, so a stamp written by the Admin SDK
   cannot freeze the document against its own owner — the trap
   `sync-user-directory.mjs` records. `announcedAt` and `reviewedAt` are
   already written the same way, and selftest.mjs pins that this stays true.

   JOB POSTINGS ONLY, and deliberately. A candidate profile is HELD until the
   reveal date and appears with everyone else's on the day; "your profile is
   live" is a different message with a different trigger, and the owner asked
   for the posting one. The capability is a field on the kind, so a second kind
   is one entry here rather than a branch in the mailer.                     */

/** The one-off grandfather date for the poster's e-mail — the day it shipped.
    Every posting ever made through the form is live and unthanked on the first
    run, and thanking a year of them at once would be a mail-out nobody asked
    for from an address that has never written to them. Anything created before
    this is stamped silently; everything after it is thanked when it appears.

    SEPARATE from `SINCE`, which grandfathers the MAINTAINER's announcement and
    was set when that shipped. One date cannot do both jobs: they are two
    features with two ship dates, and sharing the older one would have this
    mailer thank ten days of postings on its first run. */
export const LIVE_SINCE = '2026-08-29';

/** The poster's own high-water mark. */
export const LIVE_MAILED_AT = 'liveMailedAt';

/**
 * The served rows, keyed by id — `idsOf`'s companion.
 *
 * The live pass needs the ROW and not merely its id: the e-mail shows the
 * poster what the SITE says, not what their document said, so a heal or a
 * canonicalisation the build applied on the way out is what they read.
 */
export function rowsById(rows) {
  const out = new Map();
  for (const r of rows || []) if (r && r.id) out.set(r.id, r);
  return out;
}

/**
 * Split live submissions of one kind into `{ mail, grandfather }` for the
 * poster's "it is on the site now" e-mail.
 *
 * `mail` carries `{ id, data, row, published, to }` — `published` being the
 * served row, `to` the address to write to. `grandfather` is stamped and not
 * written to (see LIVE_SINCE).
 *
 * A submission with no reachable address is skipped ENTIRELY — neither mailed
 * nor stamped — because the address can be added by a later correction, and a
 * stamp would make that correction unthankable for ever.
 */
export function partitionLive(kind, entries, { since = LIVE_SINCE, published = null, now = new Date() } = {}) {
  const rows = published instanceof Map ? published : rowsById(published || []);
  const mail = [];
  const grandfather = [];

  if (!kind || !kind.tellsPoster) return { mail, grandfather };

  for (const e of entries || []) {
    const doc = e.data || {};
    if (!isLive(doc) || doc[LIVE_MAILED_AT]) continue;

    const to = contactEmail(doc);
    if (!to) continue;

    let row = null;
    try { row = kind.row(doc, { now }); } catch { row = null; }
    const shown = row && rows.get(row.id);
    if (!shown) continue;                       // not publicly shown yet

    const day = createdDay(doc);
    if (!day || day < since) grandfather.push({ ...e, row, published: shown, to });
    else mail.push({ ...e, row, published: shown, to });
  }

  const byDay = (a, b) =>
    String(createdDay(a.data) || '').localeCompare(String(createdDay(b.data) || ''))
    || String(a.id).localeCompare(String(b.id));
  mail.sort(byDay);
  grandfather.sort(byDay);

  return { mail, grandfather };
}
