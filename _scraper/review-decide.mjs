/* ---------------------------------------------------------------------------
   Operations Academia — decide a crawled posting from the Actions tab.

     node _scraper/review-decide.mjs                         list the turned-down queue
     node _scraper/review-decide.mjs --status=pending        list another status
     node _scraper/review-decide.mjs --id=<rowId> --status=approved --write
     node _scraper/review-decide.mjs --id=<rowId> --status=pending --write

   WHY IT EXISTS. The sheet sync drops a fresh crawled row as "the same
   advertisement" as a live posting WITHOUT queueing it (CLAUDE.md, "The same
   advertisement twice is not a decision to make"), and a dropped row is
   REJECTED, never deleted, so the Admin area, which lists pending documents
   alone, never shows it. On 2026-10-28 a Georgia Gwinnett College posting was
   dropped that way because it links the careers portal of the University
   System of Georgia, the same address a 2025 Valdosta State posting carries,
   and the only road back to it was the Firestore console. This writes the
   same `jobReviews` document the review card's buttons write: `status`,
   `reviewedAt`, and a `note` saying the decision came from here.

   WHAT IT DOES NOT DO. It invents no row: a document must exist, since the
   row it publishes is the crawler's own. Approving a workbook row publishes
   it at the next sheet read (partition() takes an approved document to
   `publish`, the build follows), exactly as the card's Approve does; the
   build then writes the posting's edit handle (the mirror) on its own.

   THE PLAN IS THE DEFAULT. Without --write the run says what the document
   says now and what it would say. The log is public: it prints posting ids,
   statuses and the notes the sync wrote, which name postings and never a
   person, and it never prints a row's contact fields (a crawled row has none).
   --------------------------------------------------------------------------- */

import { firestore } from './_mail.mjs';
import { isMain } from './_main.mjs';
import { COLLECTION, PENDING, APPROVED, REJECTED } from './jobreview.mjs';

export const STATUSES = [APPROVED, PENDING, REJECTED];

/** The argv the run was given. Listing the turned-down queue is the default;
    writing is not. */
export function optionsFrom(argv) {
  const val = (name) => {
    const hit = (argv || []).find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3).trim() : '';
  };
  return {
    id: val('id'),
    status: val('status') || (val('id') ? APPROVED : REJECTED),
    write: (argv || []).includes('--write'),
  };
}

/** Why the arguments cannot be acted on, or '' when they can. */
export function refusalFor(o) {
  if (!STATUSES.includes(o.status)) {
    return `--status must be one of ${STATUSES.join(', ')}, not ${JSON.stringify(o.status)}`;
  }
  if (o.id && !/^[A-Za-z0-9._~-]+$/.test(o.id)) {
    return `--id must be a posting id as the queue names it, not ${JSON.stringify(o.id)}`;
  }
  return '';
}

/** The patch a decision writes: what the review card's own buttons write,
    plus a note saying where the decision was made. Nothing else moves. */
export function patchFor(status, { now = new Date() } = {}) {
  const at = now.toISOString();
  return {
    status,
    reviewedAt: at,
    note: `Decided from the Actions tab (review-decide.mjs) on ${at.slice(0, 10)}: ${status}.`,
  };
}

/** One line per document for the LIST mode: the id, when it was decided and
    the note the sync or the card left on it. */
export function describe(doc) {
  const row = (doc && doc.row) || {};
  return `${doc.rowId}  ${doc.status}  ${String(doc.reviewedAt || doc.queuedAt || '').slice(0, 16)}  ` +
    `${row.posted || ''}  ${row.institution || ''}` +
    (row.department ? ' — ' + row.department : '') +
    (doc.note ? `\n      ${String(doc.note).replace(/\s+/g, ' ').slice(0, 220)}` : '');
}

/* ------------------------------------------------------------------ main */

export async function main(argv) {
  const o = optionsFrom(argv);
  const refusal = refusalFor(o);
  if (refusal) {
    console.log('::error::review-decide: ' + refusal);
    process.exitCode = 1;
    return;
  }
  const D = await firestore();
  if (!D) {
    console.log('::warning::review-decide: FIREBASE_SERVICE_ACCOUNT is not set; nothing was read and nothing was written.');
    return;
  }
  const col = D.collection(COLLECTION);

  if (!o.id) {
    const snap = await col.where('status', '==', o.status).get();
    const docs = snap.docs.map((d) => d.data())
      .sort((a, b) => String(b.reviewedAt || b.queuedAt || '').localeCompare(String(a.reviewedAt || a.queuedAt || '')));
    console.log(`review-decide: ${docs.length} document(s) with status ${o.status}. ` +
      'Pass --id=<posting id> --status=<approved|pending|rejected> to decide one.');
    for (const d of docs) console.log('  ' + describe(d));
    return;
  }

  const ref = col.doc(o.id);
  const before = await ref.get();
  if (!before.exists) {
    console.log(`::error::review-decide: the queue holds no document ${o.id}; nothing to decide. ` +
      'Run without --id to list the turned-down queue.');
    process.exitCode = 1;
    return;
  }
  const doc = before.data();
  console.log('  ' + describe(doc));
  if (doc.status === o.status) {
    console.log(`review-decide: ${o.id} is already ${o.status}; nothing to write.`);
    return;
  }
  const patch = patchFor(o.status);
  if (!o.write) {
    console.log(`review-decide: PLAN — would set ${o.id} from ${doc.status} to ${o.status}. ` +
      'Pass --write to do it.');
    return;
  }
  await ref.set(patch, { merge: true });
  console.log(`review-decide: ${o.id} is now ${o.status}` +
    (o.status === APPROVED ? '; the next sheet read publishes it and the build follows.' : '.'));
}

/* ------------------------------------------------------------------ selftest */

export function selftest() {
  let n = 0;
  const ok = (c, m) => { n++; if (!c) { console.log('FAIL ' + m); process.exitCode = 1; } };
  const o = optionsFrom(['--id=2027-x-20261028', '--status=approved', '--write']);
  ok(o.id === '2027-x-20261028' && o.status === 'approved' && o.write, 'arguments are read');
  ok(optionsFrom([]).status === REJECTED && !optionsFrom([]).write, 'no arguments lists the turned-down queue, as a plan');
  ok(optionsFrom(['--id=a']).status === APPROVED, 'an id alone means approve');
  ok(refusalFor({ status: 'live', id: '' }) !== '', 'an unknown status is refused');
  ok(refusalFor({ status: APPROVED, id: 'a b' }) !== '', 'an id with a space is refused');
  ok(refusalFor({ status: APPROVED, id: '2027-georgia-gwinnett-college-20261028' }) === '', 'a posting id is accepted');
  const p = patchFor(APPROVED, { now: new Date('2026-11-02T16:00:00Z') });
  ok(p.status === APPROVED && p.reviewedAt === '2026-11-02T16:00:00.000Z' && /2026-11-02/.test(p.note), 'the patch is status, stamp and note');
  ok(Object.keys(p).sort().join() === 'note,reviewedAt,status', 'and nothing beside them');
  const line = describe({ rowId: 'r', status: REJECTED, reviewedAt: '2026-10-28T21:52:00Z',
    row: { posted: '2026-10-28', institution: 'Georgia Gwinnett College', department: 'SCM', chairEmail: 'x@y.edu' }, note: 'why' });
  ok(/Georgia Gwinnett College — SCM/.test(line) && /why/.test(line) && !/x@y\.edu/.test(line), 'a listed line names the posting and no address');
  console.log(`review-decide selftest: ${n} checks${process.exitCode ? ' with failures' : ' passed'}.`);
}

if (isMain(import.meta.url)) {
  if (process.argv.includes('--selftest')) selftest();
  else main(process.argv.slice(2)).catch((e) => { console.error('review-decide failed:', e); process.exit(1); });
}
