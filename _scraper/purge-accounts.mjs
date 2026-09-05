#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia: carry out the account deletions that have been asked
   for.

   WHY THIS EXISTS. Owner, 2026-09-05: "There is no option for a user to
   completely delete their profile … Also, the admin should be able to delete
   a user." A person can do nearly all of their own deletion in their own
   browser, because _firestore.rules already lets an owner withdraw their
   postings and delete their alerts, their profile, their registeredUsers mark
   and their roster row, and Firebase lets a session delete its own sign-in.
   THE MAINTAINER CAN DO ALMOST NONE OF IT: `users/{uid}/**` is owner-only
   with no admin clause, so no browser can delete somebody else's e-mail
   alerts, and an alert left behind mails a person who no longer exists FOR
   EVER (the lesson the account merge is built around); `profiles`,
   `registeredUsers` and `userDirectory` are owner-delete too; and no browser
   can delete another account's Auth record at all.

   So a deletion is a WORK ORDER, `accountDeletions/{uid}` — written by the
   account page or by the maintainer's roster, both through
   assets/oa-account-delete.js, which is the one definition of its shape — and
   this job carries it out with the Admin SDK, which bypasses the rules.

   A CALLABLE CLOUD FUNCTION WOULD HAVE BEEN FASTER AND WAS REJECTED. It would
   be inert until somebody ran `firebase deploy --only functions` by hand, and
   this repository has twice written down what that costs: "a feature that
   needs a manual step to become real looks installed and is not", and "a
   doorbell that was never deployed looks exactly like a site that is simply
   slow". FIREBASE_SERVICE_ACCOUNT has been a secret here for months, so this
   road is live the day it merges.

   TWO STAGES, AND THE SECOND ONE HAS TO WAIT.

     CLEARING  everything that is the account: the postings are WITHDRAWN (a
               status change, never a delete — see below), the alerts, the
               profile, the tally mark, the roster row, the message thread,
               the identity keys, the usage records and the Storage landing
               strip go, and the Auth sign-in is deleted. From this point the
               person cannot sign in and nothing can reach them.

     DONE      the submissions' own documents are deleted, and the work order
               is REDACTED down to a uid, a date and counts. This may only
               happen once the site has actually stopped showing the postings,
               and that is MEASURED against the served files rather than
               assumed: `owner` is a digest of the uid and is published on
               every row of all three datasets, so the files can be asked the
               question directly.

   WHY NOT JUST DELETE THE DOCUMENTS. Because build-jobs.mjs says, in as many
   words, that a row whose document has gone is an ORPHAN it carries forward
   unchanged: "taking a posting down is a STATUS CHANGE (withdrawn/hidden),
   never deleting its document. Deleting the document would leave the row
   orphaned and therefore preserved — the opposite of what was intended."
   Delete the document first and the posting is on the site for ever, beyond
   the reach of the poster, the maintainer and this job alike.

   NOT SURE MEANS DO NOTHING. Every step is idempotent and nothing is stamped
   that did not happen: a work order whose postings are still served stays in
   `clearing` and is looked at again next run, and a step that throws leaves
   the order where it was rather than marking it finished. A deletion delayed
   is a bug report; a deletion recorded as done that was not is a promise
   broken.

   WHAT A PUBLIC LOG MAY CARRY. This prints into the Actions log of a public
   repository, so a line names an account by its uid and a REDACTED address
   and never by name, the rule the roster sync already follows.

   Modes:
     --dry-run    say what would be done, change nothing
     --selftest   offline checks, no network, no credentials
     (none)       carry the orders out
   --------------------------------------------------------------------------- */

import { isMain } from './_main.mjs';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { firebaseAdmin, redact } from './_mail.mjs';
import { ownerTag } from './jobs-model.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');

/* THE ONE DEFINITION of what a work order is, shared with the two browsers
   that write one. A second copy of these keys would disagree silently, which
   is the drift oa-countries.js, oa-schools.js and oa-jobnav.js all exist to
   prevent. */
const AD = require(path.join(HERE, '..', 'assets', 'oa-account-delete.js'));

export const COLLECTION = AD.COLLECTION;

/* The same bucket build-jobs.mjs names for the upload landing strip; pinned
   against that file by the selftest, since two spellings of one bucket would
   leave a CV sitting in Storage after the account that uploaded it had gone. */
export const BUCKET = 'operations-academia.firebasestorage.app';

/** The three things a person can post, each with the served file that says
    whether it is still on the site. */
export const SUBMISSIONS = [
  { col: 'jobSubmissions', file: 'jobs.json', what: 'jobs' },
  { col: 'candidateSubmissions', file: 'candidates.json', what: 'cands' },
  { col: 'placementSubmissions', file: 'placements.json', what: 'places' },
];

/** Everything else keyed on the account, deleted whole. `users/{uid}` carries
    the alerts and the test-e-mail requests as subcollections and is walked
    rather than named, so a subcollection added later is not left behind. */
export const OWNED_DOCS = ['profiles', 'registeredUsers', 'userDirectory'];

/** …and the documents keyed on the account that NO client may touch in either
    direction, so only this job can ever remove them. `verifyMail/{uid}` is the
    sendVerificationEmail callable's own rate limit — counters and stamps, no
    address — and it is `allow read, write: if false`, which means a deletion
    that skipped it would leave the one uid-keyed document nothing could ever
    reach. It is kept out of OWNED_DOCS on purpose: that list is swept twice,
    and this one cannot be re-created by a client. */
export const CLOSED_DOCS = ['verifyMail'];

/** A build whose `data/jobs-meta.json` stamp is this far past the moment the
    postings were withdrawn STARTED after the withdrawal, so what it published
    reflects it. The idea is assets/oa-fresh.js's BUILD_GRACE_MS; the number is
    ten times larger, deliberately. There the cost of being early is a stale
    value on one screen for a minute; here it is a published row whose document
    has gone, which build-jobs.mjs then carries FOR EVER and nobody can reach.
    Waiting costs one more twenty-minute cycle. */
export const BUILD_GRACE_MS = 15 * 60 * 1000;

/** Deleting an Auth account revokes its refresh tokens but does NOT invalidate
    an ID token already minted, and Firestore rules read the token. So a tab
    the person left open can go on writing as themselves for up to an hour —
    long enough to re-create the registeredUsers mark and the roster row that
    were just deleted, which would put a deleted person back on the Admin area
    and back into the public count. The order is therefore not closed until an
    hour has passed AND the owned documents have been swept again. */
export const TOKEN_TTL_MS = 60 * 60 * 1000;

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/* --------------------------------------------------------------- pure parts */

/** The `accountKeys` documents an account holds, from its address and the
    ORCID iD on its profile. The address is HASHED exactly as the browser
    hashes it (assets/oa-accounts.js emailKey): lowercased, trimmed, sha256,
    hex. A key is only ever deleted when it still names THIS account, so a
    claim another account has since taken over is left alone. */
export function keysFor({ email, orcid }) {
  const out = [];
  const e = String(email || '').trim().toLowerCase();
  if (e) out.push('email:' + createHash('sha256').update(e).digest('hex'));
  const o = String(orcid || '').trim();
  if (o) out.push('orcid:' + o);
  return out;
}

/** Which of an account's postings the site is still showing. `rows` is a
    served file; `spec` is the account's owner tag plus every ref and id its
    documents carry. Delegated to the shared module so the browser's own
    account of what is published and this one cannot differ. */
export function stillServed(rows, spec) {
  return AD.stillPublished(rows, spec);
}

/** What one document contributes to that spec. */
export function specOf(uid, docs) {
  const refs = [], ids = [];
  for (const d of docs || []) {
    const v = d.data || {};
    if (v.ref) refs.push(String(v.ref));
    for (const k of [v.publishedId, v.sheetId, d.id]) if (k) ids.push(String(k));
  }
  return { owner: ownerTag(uid), refs, ids };
}

/** The line a run prints about one order. The uid and a redacted address, and
    never a name: this is a public log. */
export function orderLine(uid, order, note) {
  return `  ${uid}  ${redact((order && order.email) || '')}  ${note}`;
}

/* ------------------------------------------------------------------- the run */

async function servedRows(file) {
  try {
    const raw = JSON.parse(await readFile(path.join(DATA, file), 'utf8'));
    return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.rows) ? raw.rows : null);
  } catch {
    /* UNREADABLE IS NOT EMPTY. An empty list would read as "nothing of this
       account is published any more" and would let the documents be deleted
       under rows that are still on the site — the orphan this whole job is
       shaped to avoid. */
    return null;
  }
}

/** When the build last wrote the served files. `data/jobs-meta.json` is
    written by the FIRST of the three builders build-all.mjs runs, so a stamp
    that is late enough there is late enough for the candidates and placements
    files it wrote afterwards. Null when it cannot be read, which reads as "not
    fresh enough" and holds the purge. */
async function builtAt() {
  try {
    const meta = JSON.parse(await readFile(path.join(DATA, 'jobs-meta.json'), 'utf8'));
    const t = Date.parse(meta.generated || '');
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** THE GOOGLE DRIVE COPIES. A job advertisement and a candidate's CV are
    uploaded to a Storage landing strip and then FILED INTO DRIVE by the build,
    which writes the Drive id onto the document and clears the strip. The id
    lives nowhere else, and the credential's `drive.file` scope cannot see
    anything it did not create — so it cannot list the folder to find an
    orphan. Delete the document first and that file, whose name carries the
    person's own name, sits in the shared Drive for ever with no automated
    route to it. So the copies go BEFORE the documents, and a failure here
    holds the purge rather than being swallowed. */
async function killDriveCopies(held) {
  const ids = [];
  for (const s of SUBMISSIONS) {
    for (const d of held[s.col] || []) {
      for (const k of ['adDriveId', 'cvDriveId', 'rsDriveId']) {
        if (d.data[k]) ids.push(String(d.data[k]));
      }
    }
  }
  if (!ids.length) return 0;
  let drive;
  try {
    drive = await import('./drive-upload.mjs');
  } catch (e) {
    warn(`the Drive client could not be loaded (${e.code || e.name || 'error'})`);
    return null;
  }
  const missing = drive.missingCredentials();
  if (missing.length) {
    warn(`${ids.length} file(s) are filed in Drive and GDRIVE_* is not set here, so ` +
      'the documents that name them are kept: their ids live nowhere else');
    return null;
  }
  let token;
  try {
    token = await drive.accessToken();
  } catch (e) {
    warn(`no Drive access token (${e.code || e.name || 'error'})`);
    return null;
  }
  for (const id of ids) {
    try {
      await drive.deleteFile({ token, id });
    } catch (e) {
      warn(`a Drive file could not be deleted (${e.code || e.name || 'error'})`);
      return null;
    }
  }
  return ids.length;
}

/** Delete every document under a collection reference, in batches. */
async function killAll(db, refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
  }
  return refs.length;
}

/** The whole of `users/{uid}`, subcollections included. Walked rather than
    named: the alerts are what MUST go (the mailer reads every alert in the
    database by collection group, so one left behind writes to a person who
    no longer exists for ever), and a subcollection added later would be left
    behind by a hard-coded list. */
async function killUserSubtree(db, uid) {
  const root = db.collection('users').doc(uid);
  let n = 0;
  let subs = [];
  try { subs = await root.listCollections(); } catch { subs = []; }
  for (const sub of subs) {
    const snap = await sub.get();
    n += await killAll(db, snap.docs.map((d) => d.ref));
  }
  await root.delete().catch(() => {});
  return n;
}

const USAGE_PAGE = 2000;

/** The per-session usage records, which carry the uid AND the address. Bounded
    per pass rather than unbounded: a heavy reader can hold thousands of them,
    and a single run that tried to clear them all could time out having stamped
    nothing. What is not reached this run is reached on the next, because the
    order is not closed while a full page is still coming back. */
async function killUsage(db, uid) {
  const snap = await db.collection('usageSessions').where('uid', '==', uid)
    .limit(USAGE_PAGE).get();
  return killAll(db, snap.docs.map((d) => d.ref));
}

async function killThread(db, uid) {
  const head = db.collection('messages').doc(uid);
  const items = await head.collection('items').get();
  await killAll(db, items.docs.map((d) => d.ref));
  await head.delete().catch(() => {});
  return items.size;
}

async function killKeys(db, uid, keys) {
  let n = 0;
  for (const key of keys) {
    const ref = db.collection('accountKeys').doc(key);
    const got = await ref.get().catch(() => null);
    /* ONLY WHILE IT STILL NAMES THIS ACCOUNT. A claim can be taken over by
       another signed-in account — that is how the ghost claim left behind by
       a merge heals — and deleting one that has moved on would un-notice
       somebody else's second account. */
    if (got && got.exists && (got.data() || {}).uid === uid) {
      await ref.delete();
      n++;
    }
  }
  return n;
}

/**
 * WHAT IS NOT DELETED BUT ANONYMISED, because it is a contribution to
 * something shared rather than a record of the person.
 *
 *   directoryEdits  a correction to the Universities directory. The document
 *                   is PUBLIC-READ and its `name` is printed on the card as
 *                   "Last edited by <name> on <date>", so a deleted person's
 *                   name would go on being shown to every visitor. Deleting
 *                   the document instead would revert a correction the
 *                   community relies on and could republish a duplicate row,
 *                   so the name goes and the correction stays: oa-directory.js
 *                   already falls back to "a registered user" when there is
 *                   none. `by` is left as it is — it is an opaque uid, and
 *                   after this run nothing anywhere maps it back to a person,
 *                   since the identity keys have gone too.
 *
 *   nameFixes       a suggested spelling correction. Admin-read only, but it
 *                   carries `authEmail`, which is a real address; the
 *                   suggestion itself is what the maintainer is deciding on.
 *
 * `feedback` is deliberately left alone and said so in the Privacy Policy: it
 * carries no uid at all (the rules' own key list has none), it can be sent by
 * a signed-out visitor, and joining it to an account by the address typed into
 * a public form would be a guess.
 */
async function anonymiseContributions(db, uid) {
  let n = 0;
  for (const [col, blanks] of [['directoryEdits', ['name']], ['nameFixes', ['authEmail']]]) {
    const field = col === 'directoryEdits' ? 'by' : 'uid';
    let snap;
    try {
      snap = await db.collection(col).where(field, '==', uid).get();
    } catch (e) {
      warn(`${col} could not be read for ${uid} (${e.code || e.name || 'error'})`);
      continue;
    }
    const todo = snap.docs.filter((d) => blanks.some((k) => (d.data() || {})[k]));
    for (let i = 0; i < todo.length; i += 400) {
      const batch = db.batch();
      for (const d of todo.slice(i, i + 400)) {
        /* Written as an EMPTY STRING, never deleted as a field: the rules
           bound these keys with str(), and a document whose key has gone is a
           different shape from one whose value is blank. The same reason
           `hiddenForUser` is always written as a boolean. */
        batch.update(d.ref, Object.fromEntries(blanks.map((k) => [k, ''])));
      }
      await batch.commit();
      n += Math.min(400, todo.length - i);
    }
  }
  return n;
}

async function killUploads(fb, uid) {
  if (!fb.bucket) return 0;
  try {
    const [files] = await fb.bucket.getFiles({ prefix: `uploads/${uid}/` });
    for (const f of files) await f.delete().catch(() => {});
    return files.length;
  } catch (e) {
    warn(`uploads for ${uid} could not be cleared (${e.code || e.name || 'error'})`);
    return 0;
  }
}

/** Everything this account has posted, as {col -> [{id, data}]}. */
async function submissionsOf(db, uid) {
  const out = {};
  for (const s of SUBMISSIONS) {
    const snap = await db.collection(s.col).where('uid', '==', uid).get();
    out[s.col] = snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
  }
  return out;
}

/**
 * STAGE ONE. Take the postings down, remove everything that is the account,
 * and delete the sign-in. The order is the merge's own and for the merge's
 * own reason: the sign-in goes LAST, because a session that has gone cannot
 * write and anything still owed at that point is owed for ever.
 */
async function clearAccount(fb, uid, order, held) {
  const db = fb.db;
  const removed = { jobs: 0, cands: 0, places: 0, alerts: 0, messages: 0, keys: 0,
    usage: 0, uploads: 0, anon: 0, owned: 0 };

  /* 0. WHAT WE NEED BEFORE ANYTHING GOES. The ORCID iD is on the profile and
        the address is on the Auth record, and both are about to be deleted;
        the identity keys are derived from them. A work order usually carries
        the address already, but an admin-filed one for an account with no
        roster row may not. */
  let orcid = '';
  try {
    orcid = ((await db.collection('profiles').doc(uid).get()).data() || {}).orcid || '';
  } catch { orcid = ''; }
  let email = order.email || '';
  try {
    if (!email) email = (await fb.auth.getUser(uid)).email || '';
  } catch { /* already gone, or never had one */ }

  /* 1. THE SIGN-IN FIRST, and this is the OPPOSITE of the order the browser
        uses, for a reason that is the mirror image of the browser's. A browser
        must keep its session to write at all, so it deletes the sign-in last.
        This job writes with the Admin SDK, which needs no session — and while
        the sign-in exists, a tab the person left open goes on minting work:
        enterSession re-creates the registeredUsers mark and syncDirectoryRow
        re-creates the roster row, each latched per TAB, so a second tab would
        put a deleted person straight back on the Admin area and into the
        public count. Deleting it first stops any NEW token being issued; the
        ones already out live up to an hour, which is what the finishing step
        waits out.
        `user-not-found` is the successful outcome, not a failure: a person
        deleting their own account has usually taken the sign-in with them. */
  try {
    await fb.auth.deleteUser(uid);
  } catch (e) {
    if (e && e.code !== 'auth/user-not-found') throw e;
  }

  /* 2. the postings: a status change, never a delete. A document already
        `removed` has had its row taken off and is left alone. */
  for (const s of SUBMISSIONS) {
    const docs = held[s.col] || [];
    const live = docs.filter((d) => d.data.status !== 'removed');
    for (let i = 0; i < live.length; i += 400) {
      const batch = db.batch();
      for (const d of live.slice(i, i + 400)) {
        batch.update(db.collection(s.col).doc(d.id), {
          status: 'withdrawn',
          updatedAt: new Date().toISOString(),
        });
      }
      await batch.commit();
    }
    removed[s.what] = docs.length;
  }

  /* 3. THE ALERTS, and they matter more than anything else here. The mailer
        enumerates every subscription in the database by collection group and
        writes to the address stored on the document; unsubscribing needs a
        sign-in, which this account no longer has; and users/{uid}/** has no
        admin clause, so no browser can ever clear it. One left behind is an
        unstoppable mailing to somebody who asked to be forgotten. */
  removed.alerts = await killUserSubtree(db, uid);

  /* 4. the details, the tally and the roster row */
  removed.owned = await sweepOwned(db, uid);

  /* 5. the conversation. The maintainer's copy of a thread is a record of
        something said, and it is deleted here for the same reason the address
        is: the person it was with has asked to be gone. (A merge deliberately
        KEEPS one, because a merged account's person is still here and their
        conversation is still theirs; a deletion is the case that is not.) */
  removed.messages = await killThread(db, uid);

  /* 6. …and the documents no client can reach in either direction */
  for (const col of CLOSED_DOCS) await db.collection(col).doc(uid).delete().catch(() => {});

  /* 7. the identity keys, the usage records and the upload landing strip */
  removed.keys = await killKeys(db, uid, keysFor({ email, orcid }));
  removed.usage = await killUsage(db, uid);
  removed.uploads = await killUploads(fb, uid);
  removed.anon = await anonymiseContributions(db, uid);

  return removed;
}

/** The three documents an account owns outright. Swept on the clearing pass
    AND again before the order is closed, because a tab holding a token minted
    before the sign-in was deleted can re-create two of them for up to an
    hour. */
async function sweepOwned(db, uid) {
  let n = 0;
  for (const col of OWNED_DOCS) {
    const ref = db.collection(col).doc(uid);
    const got = await ref.get().catch(() => null);
    if (got && got.exists) { await ref.delete().catch(() => {}); n++; }
  }
  return n;
}

/**
 * STAGE TWO. Delete the submissions' own documents, and only then. Answers a
 * REASON rather than a count when it will not act, so the run's log says why
 * a deletion is still open instead of leaving it to be guessed at.
 *
 * Four things must all be true, and each of them is a way this could go
 * permanently wrong:
 *
 *   the build has run SINCE the withdrawal   or the served file we are about
 *     to read is the one from before it, and a row still on its way onto the
 *     site would be published a moment after its document went;
 *   no served file still names this account  measured through the `owner`
 *     digest every row publishes, plus every ref and id its documents carry;
 *   the Drive copies are gone               their ids live only on the
 *     documents, and the credential cannot list the folder to find an orphan;
 *   an hour has passed since the sign-in went   so no ID token minted before
 *     it can still be writing.
 */
async function purgeSubmissions(fb, uid, order, held) {
  const db = fb.db;
  const cleared = Number(order.clearedAt) || 0;
  const built = await builtAt();
  if (built === null) return { done: false, why: 'data/jobs-meta.json could not be read' };
  if (built < cleared + BUILD_GRACE_MS) {
    return { done: false, why: 'the site has not been rebuilt since their postings were taken down' };
  }

  for (const s of SUBMISSIONS) {
    const docs = held[s.col] || [];
    if (!docs.length) continue;
    const rows = await servedRows(s.file);
    if (rows === null) return { done: false, why: `data/${s.file} could not be read` };
    if (stillServed(rows, specOf(uid, docs)).length) {
      return { done: false, why: `the site is still showing something in data/${s.file}` };
    }
  }

  const drive = await killDriveCopies(held);
  if (drive === null) return { done: false, why: 'a file filed in Google Drive is still there' };

  if (Date.now() < cleared + TOKEN_TTL_MS) {
    return { done: false, why: 'waiting an hour from the sign-in going, so no token it ' +
      'left behind can still be writing' };
  }
  /* …and sweep the three owned documents once more, in case one of those
     tokens re-created the tally mark or the roster row while we waited. */
  const again = await sweepOwned(db, uid);
  if (again) warn(`${uid}: ${again} document(s) had come back and were removed again`);

  /* …and the usage records, which are deleted a page at a time. A FULL page
     means there may be more, so the order stays open rather than closing over
     documents that still carry this person's address. */
  const usage = await killUsage(db, uid);
  if (usage >= USAGE_PAGE) {
    return { done: false, why: `${usage} usage records cleared, and there may be more` };
  }

  let deleted = 0;
  for (const s of SUBMISSIONS) {
    const docs = held[s.col] || [];
    if (docs.length) {
      deleted += await killAll(db, docs.map((d) => db.collection(s.col).doc(d.id)));
    }
  }
  return { done: true, deleted, drive: drive || 0, again };
}

async function main() {
  const fb = await firebaseAdmin();
  if (!fb) {
    log('no Firebase credentials in this environment — nothing to purge.');
    log('(this is the expected state until the project is set up: _SETUP-FIREBASE.md)');
    return 0;
  }
  try {
    const admin = await import('firebase-admin');
    const app = admin.default || admin;
    fb.bucket = app.storage().bucket(BUCKET);
  } catch {
    fb.bucket = null;
    warn('Storage is unavailable — an upload still on the landing strip is left there');
  }

  const db = fb.db;
  let orders = [];
  try {
    const snap = await db.collection(COLLECTION).get();
    snap.forEach((d) => orders.push({ uid: d.id, data: d.data() || {} }));
  } catch (e) {
    warn(`${COLLECTION} could not be read (${e.code || e.name || 'error'}) — nothing done`);
    return 0;
  }
  orders = orders.filter((o) => o.data.status !== 'done');
  log(`${orders.length} account deletion(s) to carry out.`);
  if (!orders.length) return 0;

  let cleared = 0, finished = 0, waiting = 0;
  for (const { uid, data } of orders) {
    const held = await submissionsOf(db, uid);
    const counts = Object.fromEntries(SUBMISSIONS.map((s) => [s.what, (held[s.col] || []).length]));

    if (DRY) {
      log(orderLine(uid, data, `would ${data.status === 'clearing' ? 'finish' : 'clear'}: ` +
        `${counts.jobs} job(s), ${counts.cands} profile(s), ${counts.places} placement(s)`));
      continue;
    }

    let removed = data.removed || null;
    let clearedAt = Number(data.clearedAt) || 0;
    if (data.status !== 'clearing') {
      removed = await clearAccount(fb, uid, data, held);
      clearedAt = Date.now();
      await db.collection(COLLECTION).doc(uid).set(
        { status: 'clearing', clearedAt, removed }, { merge: true });
      cleared++;
      log(orderLine(uid, data, 'cleared: the account and its sign-in are gone'));
    }

    /* …and the second stage is attempted on the SAME run, which is not
       optimism: it is what finishes an order whose postings had already gone
       (a person who posted nothing) once the hour is up. Its four gates say no
       on the run that cleared, every time, and say why. */
    const purged = await purgeSubmissions(fb, uid, { ...data, clearedAt }, held);
    if (!purged.done) {
      waiting++;
      log(orderLine(uid, data, `finishing on a later run: ${purged.why}`));
      continue;
    }
    /* REDACTED, not kept. A record that an account was deleted on a day is
       worth keeping; a record of a deleted person that still carries their
       name and their address is the thing the deletion was for. */
    await db.collection(COLLECTION).doc(uid).set(
      AD.redacted({ ...data, clearedAt, removed: removed || data.removed }, Date.now()));
    finished++;
    log(orderLine(uid, data, `done: ${purged.deleted} document(s) deleted` +
      (purged.drive ? `, ${purged.drive} file(s) removed from Drive` : '')));
  }

  if (DRY) { log('--dry-run: nothing written.'); return 0; }
  log(`${cleared} account(s) cleared, ${finished} finished, ${waiting} still open ` +
      '(each line above says why).');
  return 0;
}

/* ---------------------------------------------------------------- selftest */

async function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, what) => { if (c) pass++; else fails.push(what); };

  /* the shared shape */
  ok(COLLECTION === 'accountDeletions', 'the work order lives in accountDeletions');
  ok(AD.REQUEST_KEYS.every((k) => !AD.SWEEP_KEYS.includes(k)),
    'what a browser writes and what this job stamps are disjoint sets');

  /* the served-file test */
  const rows = [
    { id: 'a', ref: 'R1', owner: ownerTag('u1') },
    { id: 'b', ref: 'R2', owner: ownerTag('u2') },
    { id: 'c', owner: '' },
  ];
  const spec = specOf('u1', [{ id: 'doc1', data: { ref: 'R1' } }]);
  ok(stillServed(rows, spec).length === 1, 'a row carrying the account’s own tag is still served');
  ok(stillServed(rows, specOf('u3', [])).length === 0,
    'and an account with nothing published matches nothing');
  ok(stillServed(rows, { owner: '', refs: ['R2'], ids: [] })[0].id === 'b',
    'a ref matches even where the tag does not — the removalSpecs belt and braces');
  ok(stillServed(rows, { owner: '', refs: [], ids: ['c'] })[0].id === 'c',
    '…and so does an id');

  /* specOf reads every key a row can be joined on */
  const s2 = specOf('u1', [{ id: 'd1', data: { ref: 'R', publishedId: 'p1', sheetId: 's1' } }]);
  ok(s2.ids.includes('p1') && s2.ids.includes('s1') && s2.ids.includes('d1'),
    'specOf carries the published id, the sheet id and the document id');
  ok(s2.owner === ownerTag('u1'), 'and the owner digest the served rows publish');

  /* the identity keys */
  const keys = keysFor({ email: '  Foo@Bar.COM ', orcid: '0000-1' });
  ok(keys[0] === 'email:' + createHash('sha256').update('foo@bar.com').digest('hex'),
    'the address key is the lowercased, trimmed sha256 the browser writes');
  ok(keys[1] === 'orcid:0000-1', 'and the ORCID key is the iD itself');
  ok(keysFor({}).length === 0, 'an account with neither has no keys to remove');

  /* the log */
  const line = orderLine('u1', { email: 'someone@example.edu' }, 'x');
  ok(line.includes('so***@example.edu'),
    'the log line carries a REDACTED address, the way every other public log here does');
  ok(!line.includes('someone@example.edu'),
    '…and never the address itself: this prints into a public repository’s Actions log');
  ok(!orderLine('u1', { email: 'a@b.c', name: 'Ada Lovelace' }, 'x').includes('Ada'),
    'and never the person’s name');

  /* the bucket, against the file that already names it */
  const build = await readFile(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(build.includes(BUCKET),
    'the Storage bucket is the one build-jobs.mjs names — two spellings would ' +
    'leave a CV on the landing strip after the account had gone');

  /* THE SOURCE'S OWN PROMISES, READ WITH THE COMMENTS STRIPPED. This file
     explains the defects it avoids in the same words the guards below look
     for, so a negative check over the raw text could be satisfied by deleting
     the explanation — the trap recorded for the Commit step's rebase and for
     the analytics page's iframes. */
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const src = strip(await readFile(fileURLToPath(import.meta.url), 'utf8'));
  const clearSrc = src.slice(src.indexOf('async function clearAccount'),
    src.indexOf('async function purgeSubmissions'));
  ok(clearSrc.length > 500 && clearSrc.length < 6000,
    'clearAccount was really sliced, at both ends');
  ok(clearSrc.indexOf('deleteUser') < clearSrc.indexOf('killUserSubtree'),
    'the sign-in goes FIRST here, the OPPOSITE of the browser’s order and for ' +
    'the mirror-image reason: this job needs no session, and while the sign-in ' +
    'exists a tab the person left open re-creates the tally mark and the roster ' +
    'row it has just deleted');
  ok(clearSrc.indexOf("collection('profiles').doc(uid).get()") < clearSrc.indexOf('deleteUser') &&
     clearSrc.indexOf('auth.getUser') < clearSrc.indexOf('deleteUser'),
    '…and the ORCID iD and the address are read BEFORE either record goes: the ' +
    'identity keys are derived from them and live nowhere else');
  ok(/status: 'withdrawn'/.test(clearSrc) && !/collection\(s\.col\)\.doc\(d\.id\)\.delete/.test(clearSrc),
    'stage one WITHDRAWS a posting and never deletes its document — deleting it ' +
    'leaves the published row an orphan the build carries for ever');
  ok(/directoryEdits/.test(clearSrc) || /anonymiseContributions/.test(clearSrc),
    'a contribution to the shared directory is anonymised rather than deleted, so a ' +
    'deleted person’s name stops being printed on a public card without the ' +
    'correction being reverted');
  const anonSrc = src.slice(src.indexOf('async function anonymiseContributions'),
    src.indexOf('async function killUploads'));
  ok(anonSrc.length > 300 && anonSrc.length < 3000,
    'the anonymise pass was really sliced — a slice taken on a wrong marker comes ' +
    'back empty and every check below it passes on nothing');
  ok(/\[k, ''\]/.test(anonSrc) && !/FieldValue\.delete/.test(anonSrc),
    'and it BLANKS the field rather than deleting it: the rules bound these keys ' +
    'with str(), and a key that has gone is a different shape from a blank one');
  ok(CLOSED_DOCS.includes('verifyMail') && new RegExp('CLOSED_DOCS').test(clearSrc),
    'the verification mailer’s own rate-limit document goes too: it is keyed on ' +
    'the account and closed to every client, so nothing else could ever reach it');
  ok(!/collection\('feedback'\)/.test(src),
    'feedback is left alone — it carries no uid, a signed-out visitor can send one, ' +
    'and joining it by the address typed into a public form would be a guess');

  const purgeSrc = src.slice(src.indexOf('async function purgeSubmissions'),
    src.indexOf('async function main'));
  ok(purgeSrc.length > 500 && purgeSrc.length < 5000, 'stage two was really sliced');
  ok(/rows === null/.test(purgeSrc) && /done: false/.test(purgeSrc),
    'an unreadable served file is ABSENT, never empty: it stops the purge rather ' +
    'than letting a document go while its row is still on the site');
  ok(/built < cleared \+ BUILD_GRACE_MS/.test(purgeSrc),
    'a document is not deleted until the site has been REBUILT since the ' +
    'withdrawal — the served file from before it would say a row is gone that ' +
    'is about to be published');
  ok(/killDriveCopies/.test(purgeSrc) && purgeSrc.indexOf('killDriveCopies') < purgeSrc.indexOf('killAll'),
    'the Google Drive copies go BEFORE the documents that name them: their ids ' +
    'live nowhere else and the credential cannot list the folder to find an orphan');
  ok(/killUsage\(db, uid\)/.test(purgeSrc) && /USAGE_PAGE/.test(purgeSrc),
    'the usage records are cleared a page at a time and a FULL page holds the ' +
    'order open, so it never closes over documents that still carry the address');
  ok(/TOKEN_TTL_MS/.test(purgeSrc) && /sweepOwned/.test(purgeSrc),
    'and the order is not closed until an ID token minted before the sign-in ' +
    'went has expired, with the owned documents swept once more in case one of ' +
    'them put something back');
  ok(BUILD_GRACE_MS > 10 * 60 * 1000 && TOKEN_TTL_MS === 60 * 60 * 1000,
    'the two waits are long enough to mean what they say');

  console.log(fails.length
    ? `purge-accounts selftest: ${fails.length} FAILED, ${pass} passed\n\n  ${fails.join('\n  ')}`
    : `purge-accounts selftest: ${pass} checks passed`);
  return fails.length === 0;
}

if (!isMain(import.meta.url)) {
  // imported: the pure halves above are the whole of it
} else if (argv.has('--selftest')) {
  process.exit((await selftest()) ? 0 : 1);
} else {
  main().then((code) => process.exit(code)).catch((e) => {
    /* the code, never the message text: a public log, and an error's message
       can quote an address or a document path in full */
    console.log('::error::account purge failed: ' + (e.code || e.name || 'error'));
    process.exit(1);
  });
}
