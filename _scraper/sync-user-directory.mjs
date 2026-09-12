#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — seed the Admin area's roster from Firebase Auth.

   THE PROBLEM. The Admin area shows two numbers about the same people and they
   disagreed: "31 Registered users" in the summary strip, and ONE person in the
   roster below it (owner, 2026-08-25). Neither was wrong, and that is what
   made it unreadable:

     registeredUsers/{uid}   a contentless mark every sign-in writes; 31 of them
     userDirectory/{uid}     the roster row — name, address, first and last seen

   The roster row is written BY THE BROWSER, once per session, and the rules
   that permit that write were only published minutes earlier. So the roster
   held exactly the people who had signed in since — one — while the tally held
   everyone who had signed in since IT shipped. The panel's own copy says
   "everyone who has signed in since the roster shipped", which is honest and no
   help at all to a maintainer who wants to reach their users today.

   THE FIX IS THE ONE SOURCE THAT KNOWS EVERYBODY. The e-mail address is not in
   Firestore at all — it lives in the Auth record, which no browser can read for
   anyone but itself. The Admin SDK can: `listUsers()` returns every account with
   its display name, its address, when it was created and when it last signed in.
   That is the roster, more completely than the browser can ever write it, and it
   fills in the one field CLAUDE.md records as unobtainable — the TRUE joined
   date, Auth's own creationTime, rather than "first seen by this site".

   FIVE KEYS AND NO MORE, WHICH IS LOAD-BEARING. `rowOk()` in _firestore.rules
   pins a roster row to hasOnly(['name','email','first','seen','affiliation']).
   The Admin SDK bypasses the rules, so a key the rules do not name would be
   written happily — and then the OWNER could never update their own row
   again, because their merge produces a document carrying that key and
   `hasOnly` refuses it. A sync that quietly froze every row it touched would
   be a poor trade for a backfill. selftest.mjs pins the shape against the
   rules both ways. (The fifth, `affiliation`, arrived on 2026-09-08 WITH its
   rule, in one change, which is the only safe way a key ever joins this row.)

   THE AFFILIATION IS COPIED FROM THE PROFILE, not from Auth, which has no
   such field: profiles/{uid} is owner-only in the rules and the Admin SDK
   reads it regardless. The profile is the source and the roster row mirrors
   it — the browser writes the same value beside the name on every sign-in —
   and because this run REPLACES the row, a person who blanks the field on
   their profile card is un-placed by the next morning's run, which a browser
   merge could never do. A profiles read that FAILS keeps every row's
   affiliation as it is: unknown is not the same as none.

   IT NEVER MOVES A DATE BACKWARDS. The browser stamps `seen` on every session;
   Auth's lastSignInTime can lag it. The later of the two wins, so a sync run
   can only ever add what Auth knows and never contradict what the site saw.

   TWO SERVED FILES RIDE ON THE SAME READ (owner, 2026-09-05: the number of
   registered users belongs on the front page, as on /lit/, and the analytics
   page may show how it grew). Both hold COUNTS AND DATES AND NOTHING ELSE,
   because everything under data/ is served to anyone who asks:

     data/users-meta.json     { generated, count }
                              the registered users: every account Auth holds
                              that is not disabled AND carries a
                              registeredUsers mark (see below)
     data/users-growth.json   { generated, first, days: [[yyyy-mm-dd, n], ...] }
                              one point per UTC day from the first account's
                              creation day to the generated day, n = how many
                              of those accounts existed by the end of that day

   THE COUNT IS THE ADMIN AREA'S OWN, NOT AUTH'S. The first version counted
   every Auth account that was not disabled, and the front page said "130+"
   over an Admin area saying 106 (owner, 2026-09-05: "it should say 100+
   instead"). Auth holds every account ever CREATED, and a good many of
   those never became usable: a password registration whose address was
   never confirmed (the site gates such an account and it can write
   nothing), and accounts that were made and never signed in. The Admin
   area's tile counts `registeredUsers`, the contentless mark a usable
   sign-in writes, and that is what "registered users" has meant on this
   site since the tile shipped. So the two served files count the accounts
   Auth holds that CARRY that mark: the same people the tile counts, dated
   by Auth's creation time, which the mark does not carry (its `t` is last
   seen). A mark with no Auth account behind it (one deleted in the console)
   is not counted, so the front page can read at or below the tile and never
   above it. AND A MERGE TAKES ONE OFF (owner, 2026-09-05: "if two profiles
   merge, then the number of registered users should decrease by one too"):
   `runMerge` in oa-accounts.js deletes the duplicate's mark and then its
   Auth account, and the join drops the duplicate the moment the mark is
   gone, whether or not the account deletion behind it succeeded, so the
   count is of PEOPLE, exactly as the tile's is. A tally that cannot be
   read, or reads as empty, WRITES NOTHING:
   the committed files stand, the roster half still runs, and the run says
   so. An unreachable source changes nothing, as everywhere else here.

   `members`, `usersMeta` and `usersGrowth` are the pure halves. The
   collections stay admin-read; the served file is the public path to the one
   figure the owner made public, and it carries no identity of any kind. The workflow commits
   them with the rebuild-never-rebase retry the other data writers use; the
   growth file gains a point every day by construction, so the job commits
   daily, like data/analytics.json. The COMMITTED SEEDS are the valid empty
   shapes ({"generated":"","count":0} and {"generated":"","first":"","days":[]}):
   the page hides its tile and the chart is absent until a run with the
   credential writes real ones, and the selftest's shape pin is never vacuous.

   Modes:
     --scan       report what Auth holds and what would change, write nothing
     --dry-run    the same, said as a diff
     --selftest   offline checks over the pure mapping, no network
   --------------------------------------------------------------------------- */

import { isMain } from './_main.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { firebaseAdmin, redact } from './_mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
/** The two served files, named once. */
export const USERS_META = 'users-meta.json';
export const USERS_GROWTH = 'users-growth.json';

const argv = new Set(process.argv.slice(2));
const SCAN = argv.has('--scan');
const DRY = argv.has('--dry-run');
/* THE TWO SERVED FIGURES ALONE, WITHOUT THE ROSTER. The figures are read every
   hour and the roster once a day, because they cost very different things: the
   figures need the tally and Auth, while the roster needs `userDirectory` and
   `profiles` too, which is three whole collections rather than one. It is also
   what keeps the roster's own cadence honest: the Admin area, oa-users.js and
   _SETUP-FIREBASE.md all say `first` and the affiliation are filled DAILY from
   Auth, and they still are. */
const FIGURES = argv.has('--figures-only');

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/** The collection the Admin area's roster reads. Kept as a literal here and
    pinned against assets/oa-firebase.js by the selftest, the same way every
    other collection name in this repository is. */
export const DIRECTORY = 'userDirectory';

/** The contentless tally a usable sign-in writes (oa-accounts.js) and the
    Admin area's Registered-users tile counts. The two served files count the
    Auth accounts that carry one, so the front page and the tile agree. Pinned
    against assets/oa-firebase.js by the selftest like DIRECTORY. */
export const TALLY = 'registeredUsers';

/** EXACTLY the keys _firestore.rules allows on a roster row. A key the rules
    do not name would freeze the row against its own owner — see the header.
    `affiliation` joined on 2026-09-08 (owner: "show their affiliation in
    that list"), in the same change as the rule. */
export const ROW_KEYS = ['name', 'email', 'first', 'seen', 'affiliation',
  /* The address the person GAVE, where their sign-in shares none — ORCID's
     OIDC carries no e-mail claim, so `email` above can never hold one for
     those accounts and the roster had no way at all to reach them (owner,
     2026-09-12). Sixth key, with its rule, in one change: a key the rules do
     not name is written happily by the Admin SDK and then freezes the row
     against its own OWNER for ever, which is this file's own header trap. */
  'contactEmail'];

/** The collection the affiliation is read from. The profile is the person's
    own word about where they are and the browser mirrors it onto the roster
    row on every sign-in; the sync copies it the same way with the Admin SDK,
    so an account that never signs in again is still placed, and one that
    blanked its affiliation is un-placed by the next run. */
export const PROFILES = 'profiles';

/* ------------------------------------------------------------- pure mapping */

/** An Auth timestamp (an RFC-1123 string on UserMetadata) as epoch ms, or 0
    when it is absent or unreadable — never NaN, which the rules would refuse
    as not-a-number and which would sort a row to the top of "last seen". */
export function stamp(v) {
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

/**
 * One Auth record + whatever the browser has already written -> the row to
 * store, or NULL when nothing would change (so an unchanged account costs no
 * write, and a re-run of this job commits nothing).
 *
 * The merge rules, each for its own reason:
 *   name   Auth's displayName, but never OVER a name the site already holds —
 *          the browser writes the name the account shows itself under, which
 *          is derived from the profile and is the better one where they differ.
 *   email  Auth's address is authoritative: it is the one the account really
 *          signs in with, which is exactly what the client rule pins.
 *   first  the TRUE joined date — Auth's creationTime — in place of "first
 *          seen by this site". Earliest wins, so it can only ever correct a
 *          later guess backwards to the real one.
 *   seen   the LATER of Auth's last sign-in and what the site last saw.
 *   affiliation  the PROFILE's, whole: `profile` is that account's
 *          profiles/{uid} document, or NULL when the collection was read and
 *          holds none for it, or UNDEFINED when the collection could not be
 *          read at all. Read and empty means the person has none, and the
 *          key goes; unreadable means nothing is known, and what the row
 *          holds is kept — a failed read must not strip a hundred
 *          affiliations off the roster until the next morning.
 *   contactEmail  the PROFILE's too, read the same three ways, for an account
 *          whose sign-in shares no address of its own.
 */
export function rowFromAuthUser(user, existing, profile) {
  const had = existing || {};
  const meta = user.metadata || {};

  const authFirst = stamp(meta.creationTime);
  const authSeen = stamp(meta.lastSignInTime);
  const hadFirst = typeof had.first === 'number' ? had.first : 0;
  const hadSeen = typeof had.seen === 'number' ? had.seen : 0;

  /* AN EMPTY `email` IS NOT AN EMPTY STRING, IT IS NO KEY AT ALL. The rules
     pin the address to `request.auth.token.email`, and an ORCID sign-in
     carries no e-mail claim — so the BROWSER omits the key for such an
     account (`if (email) row.email = ...` in oa-accounts.js) and the rule's
     "not present, or equal" passes. Writing `email: ''` from the Admin SDK,
     which bypasses the rules, left `'' == null` in the merged document the
     owner's own next write sends: permission-denied, for ever, on the row
     they are supposed to keep current. That is the sync-user-directory trap
     this file's own header describes, sprung by a VALUE rather than by a
     fifth key. */
  const email = String(user.email || had.email || '').slice(0, 200);
  /* The same rule as the address: an EMPTY affiliation is no key at all, so
     the roster reads "—" for it and the owner's own merge never has to send
     an empty string back. */
  const affiliation = profile === undefined
    ? String(had.affiliation || '').trim().slice(0, 300)
    : String((profile && profile.affiliation) || '').trim().slice(0, 300);
  /* …and the contact address, by the same three-state rule: the profile's
     word, gone when the profile has none, and KEPT when the profiles
     collection could not be read. It is never folded into `email` above — the
     client rule pins that one to the caller's own auth token precisely so a
     roster row cannot lie about what an account signs in as, and this one is
     self-reported like the name and the affiliation beside it. */
  const contactEmail = profile === undefined
    ? String(had.contactEmail || '').trim().slice(0, 200)
    : String((profile && profile.contactEmail) || '').trim().slice(0, 200);
  const row = {
    name: String(had.name || user.displayName || '').slice(0, 200),
    ...(email ? { email } : {}),
    // earliest non-zero, so a row opened by the browser is corrected to the
    // real joined date rather than kept at the day the site first saw them
    first: [authFirst, hadFirst].filter(Boolean).sort((a, b) => a - b)[0] || 0,
    // never backwards
    seen: Math.max(authSeen, hadSeen),
    ...(affiliation ? { affiliation } : {}),
    ...(contactEmail ? { contactEmail } : {}),
  };

  /* An account with NO address and NO name is still a person and still gets a
     row — the roster shows "—", exactly as it does for a provider sign-in that
     carries no e-mail claim. But a row with nothing at all AND no dates is not
     worth writing. */
  if (!row.first && !row.seen && !row.email && !row.name) return null;

  /* `in` as well as the value, so a row that already holds the poisoned
     `email: ''` is seen as DIFFERENT from one that omits it and is healed on
     the next run rather than being read as already current. */
  const same = ROW_KEYS.every((k) => (k in had) === (k in row) && had[k] === row[k]);
  return same ? null : row;
}

/** What a run did, in one sentence — so a scheduled fire that changed nothing
    says so rather than printing nothing at all. */
export function summarise({ seen, written, skipped }) {
  return `${seen} account(s) in Auth: ${written} row(s) written, ` +
    `${skipped} already current.`;
}

/* -------------------------------------------------- the two served files */

/** yyyy-mm-dd in UTC from epoch ms. */
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The accounts a public count may include: everything Auth holds that is
    not disabled AND carries a registeredUsers mark, which is what the Admin
    area's tile counts (see the header). `marks` is the set of uids the tally
    holds; a disabled account is not a member, and neither is an account that
    never signed in usably, however long it has existed in Auth. */
export function members(users, marks) {
  const has = marks instanceof Set ? marks : new Set(marks || []);
  return (users || []).filter((u) => u && !u.disabled && has.has(u.uid));
}

/**
 * data/users-meta.json: how many registered users there are, and when that
 * was measured. Counts and a date, nothing else, since the file is public.
 */
export function usersMeta(users, now, marks) {
  const at = now instanceof Date ? now : new Date(now || Date.now());
  return { generated: at.toISOString(), count: members(users, marks).length };
}

/**
 * Whether a READER would see any difference between the document already
 * committed and the one this run built. `generated` is the run instant, so it
 * moves on every run and means nothing to anybody: the front page reads
 * `count`, the growth chart reads `days`, and nothing anywhere reads the
 * stamp. Leaving it out of the comparison is what lets a sync that runs every
 * hour write nothing -- and therefore commit nothing -- on the runs where the
 * figure has not moved. Key order is not part of the answer, since one side
 * has been through JSON.parse and the other has not.
 */
export function figuresMoved(before, after) {
  if (!before || typeof before !== 'object' || Array.isArray(before)) return true;
  const strip = (d) => JSON.stringify(Object.keys(d).filter((k) => k !== 'generated')
    .sort().map((k) => [k, d[k]]));
  return strip(before) !== strip(after);
}

/**
 * data/users-growth.json: the cumulative count, one point per UTC day from
 * the first account's creation day to the generated day. `n` for a day is
 * how many member accounts had been created by the end of it, so the
 * series never decreases and its last value is `usersMeta().count` whenever
 * every account carries a creation time. Accounts with no readable creation
 * time are counted from the first day (they exist; when is unknown), so the
 * two files never disagree about the total. With no accounts at all the
 * shape is the empty one the seed carries.
 */
export function usersGrowth(users, now, marks) {
  const at = now instanceof Date ? now : new Date(now || Date.now());
  const list = members(users, marks);
  const created = list.map((u) => stamp(u.metadata && u.metadata.creationTime));
  const known = created.filter(Boolean);
  if (!list.length) return { generated: at.toISOString(), first: '', days: [] };
  const undated = created.length - known.length;
  const firstMs = known.length ? Math.min(...known) : at.getTime();
  const first = utcDay(firstMs);
  const last = utcDay(at.getTime());
  const perDay = new Map();
  for (const t of known) {
    const d = utcDay(t);
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  const days = [];
  let running = undated;
  const cursor = new Date(first + 'T00:00:00Z');
  const end = new Date(last + 'T00:00:00Z');
  // a creation time after `now` (a clock skew) is folded into the last day
  let late = 0;
  for (const [d, n] of perDay) if (d > last) late += n;
  while (cursor.getTime() <= end.getTime()) {
    const d = cursor.toISOString().slice(0, 10);
    running += perDay.get(d) || 0;
    if (d === last) running += late;
    days.push([d, running]);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { generated: at.toISOString(), first, days };
}

/* -------------------------------------------------------------------- main */

/* `firebaseAdmin()` in _mail.mjs is the one definition of "the Admin SDK, or
   null" (credential parsing, the missing-package warning); it returns the
   Firestore AND the Auth handle, and this job needs both. */

/** Write a served file only when `figuresMoved` says a reader would see the
    difference, and answer whether it wrote. Otherwise the committed bytes are
    left exactly as they are, the stamp included, so `git status` is clean and
    the run commits nothing. */
async function writeServed(name, doc, body) {
  const file = path.join(DATA, name);
  let before = null;
  try { before = JSON.parse(await readFile(file, 'utf8')); } catch { before = null; }
  if (!figuresMoved(before, doc)) return false;
  await writeFile(file, body);
  return true;
}

async function main() {
  const fb = await firebaseAdmin();
  if (!fb) {
    log('no Firebase credentials in this environment — nothing to sync.');
    log('(this is the expected state until the project is set up: _SETUP-FIREBASE.md)');
    return;
  }

  const col = fb.db.collection(DIRECTORY);

  /* THE ROSTER'S OWN TWO READS, SKIPPED ON A FIGURES-ONLY RUN. Neither says
     anything about how many people have registered, so the hourly run pays for
     neither: `existing` and `profiles` exist for `rowFromAuthUser` and nothing
     else, and with no rows written there is nothing for them to merge into. */
  const existing = {};
  let profiles = null;
  if (FIGURES) {
    log('--figures-only: the two served files, from the tally and Auth alone; the roster is left as it is.');
  } else {
    /* What the roster already holds, read once: the merge needs the stored row
       to preserve a site-derived name and to leave an unchanged account alone. */
    (await col.get()).forEach((d) => { existing[d.id] = d.data() || {}; });
    log(`roster holds ${Object.keys(existing).length} row(s) before this run`);

    /* Every profile, read once, for the affiliation each row carries. NULL when
       the read fails: rowFromAuthUser then keeps whatever affiliation a row
       already holds rather than reading "could not be read" as "has none". */
    try {
      profiles = {};
      (await fb.db.collection(PROFILES).get()).forEach((d) => { profiles[d.id] = d.data() || {}; });
      log(`${PROFILES} holds ${Object.keys(profiles).length} document(s)`);
    } catch (e) {
      profiles = null;
      warn(`${PROFILES} could not be read: every row keeps the affiliation it already holds`);
    }
  }
  const profileOf = (uid) => (profiles ? (profiles[uid] || null) : undefined);

  /* The tally the Admin area's tile counts: the uids and nothing else (the
     documents carry only a timestamp anyway). A read that fails or answers
     empty leaves the two served files exactly as they are, since a count of
     nobody over a site with a hundred members is a failure, not a figure. */
  let marks = null;
  try {
    const ids = new Set();
    (await fb.db.collection(TALLY).get()).forEach((d) => ids.add(d.id));
    if (ids.size) marks = ids;
    else warn(`${TALLY} is empty: data/${USERS_META} and data/${USERS_GROWTH} are left as they are`);
  } catch (e) {
    warn(`${TALLY} could not be read: data/${USERS_META} and data/${USERS_GROWTH} are left as they are`);
  }
  log(`${TALLY} holds ${marks ? marks.size : 0} mark(s)`);

  let seen = 0, written = 0, skipped = 0;
  let pending = [];
  /* What the two served files are built from: the flags and the creation
     time of every account, never a name or an address. */
  const accounts = [];

  const flush = async () => {
    if (!pending.length || SCAN || DRY || FIGURES) { pending = []; return; }
    const batch = fb.db.batch();
    /* A REPLACE, NOT A MERGE, and that is what lets the key GO. `row` is the
       whole document — the rules bound it to exactly these five keys — so a
       merge could only ever add to it, and an `email: ''` already stored
       would survive every run and go on freezing that row against its own
       owner. It is also what takes an affiliation OFF a row once its owner
       has blanked the profile's field, which the browser's merge cannot. */
    for (const [uid, row] of pending) batch.set(col.doc(uid), row);
    await batch.commit();
    pending = [];
  };

  let token;
  do {
    // 1000 is the Admin SDK's maximum page
    const page = await fb.auth.listUsers(1000, token);
    for (const user of page.users) {
      seen++;
      accounts.push({ uid: user.uid, disabled: !!user.disabled, metadata: { creationTime: (user.metadata || {}).creationTime } });
      /* A FIGURES-ONLY RUN TOUCHES NO ROW AT ALL, and stops here rather than
         relying on `flush` to throw the work away: `existing` and `profiles`
         were never read, so every account would look new, and the summary
         below would then report a hundred and fifty rows written on a run that
         wrote none. The two served files need the flags and the creation time,
         which are already on `accounts`. */
      if (FIGURES) continue;
      const row = rowFromAuthUser(user, existing[user.uid], profileOf(user.uid));
      if (!row) { skipped++; continue; }
      written++;
      if (SCAN || DRY) {
        /* THE DOCUMENT, NEVER THE PERSON. This prints into the Actions log of
           a public repository (the workflow's scan button runs it), so the
           line carries the id and a REDACTED address and never the name: the
           id already says which row would change. */
        log(`  ${user.uid}  ${redact(row.email)}`);
      }
      pending.push([user.uid, row]);
      if (pending.length >= 400) await flush();
    }
    token = page.pageToken;
  } while (token);

  await flush();

  log(FIGURES
    ? `${seen} account(s) in Auth; the roster was not read or written on this run.`
    : summarise({ seen, written, skipped }));

  /* THE TWO SERVED FILES, FROM THE SAME READ, AND WRITTEN ONLY WHEN THE
     FIGURE HAS MOVED. This job used to run once a day and write both files
     whole on every run, since `generated` is the run instant -- so every run
     was a commit, and that was affordable exactly because there was one run.
     It runs every hour now (owner, 2026-09-09: the front page said 130+ while
     the maintainer's own tile said 142, because the number is rounded down to
     the nearest ten and a day of this market's growth is most of a decade), and
     twenty-four commits a day for a number that moves about ten times would
     run the whole check suite twenty-four times for nothing. So `writeServed`
     keeps the committed stamp whenever the rest of the document is identical
     and leaves the file byte for byte as it was: the workflow's "nothing
     changed" branch is the ORDINARY outcome now rather than the guard for a
     scan it used to be, and what `generated` records is the run that last
     MOVED the figure. Nothing reads it -- the front page reads `count`, the
     growth chart reads `days` -- so that is a change of meaning nobody sees. */
  const now = new Date();
  if (!marks) {
    log(`the tally was not read: data/${USERS_META} and data/${USERS_GROWTH} not written.`);
  } else {
    const meta = usersMeta(accounts, now, marks);
    const growth = usersGrowth(accounts, now, marks);
    const unmarked = accounts.filter((a) => !a.disabled && !marks.has(a.uid)).length;
    log(`${meta.count} registered users: ${accounts.length} account(s) in Auth, ` +
        `${unmarked} of them never signed in usably and ${accounts.length - unmarked - meta.count} disabled.`);
    /* WHY THE ADMIN AREA'S TILE CAN READ HIGHER, said in the log rather than
       left to be guessed at: the tile counts the TALLY, so a mark whose account
       is disabled or has since been deleted in the Firebase console is still
       one of its number, while the served count is the live Auth accounts
       behind those marks. Counts only, as everywhere in this run's log. */
    const live = new Set(accounts.filter((a) => !a.disabled).map((a) => a.uid));
    const orphans = [...marks].filter((uid) => !live.has(uid)).length;
    if (orphans) {
      log(`${orphans} mark(s) in ${TALLY} have no live account behind them, so the ` +
          `Admin area's tile reads ${marks.size} where the front page reads ${meta.count}.`);
    }
    if (!SCAN && !DRY) {
      const wrote = [];
      if (await writeServed(USERS_META, meta, JSON.stringify(meta, null, 2) + '\n')) {
        wrote.push(`data/${USERS_META} (${meta.count} registered users)`);
      }
      if (await writeServed(USERS_GROWTH, growth, JSON.stringify(growth) + '\n')) {
        wrote.push(`data/${USERS_GROWTH} (${growth.days.length} day(s) from ${growth.first || 'nothing'})`);
      }
      log(wrote.length
        ? `wrote ${wrote.join(' and ')}.`
        : `data/${USERS_META} and data/${USERS_GROWTH} already say ${meta.count}: nothing to commit.`);
    } else {
      log(`would write data/${USERS_META} with count ${meta.count} and ` +
          `data/${USERS_GROWTH} with ${growth.days.length} day(s).`);
    }
  }
  if (SCAN || DRY) log(SCAN ? '--scan: nothing written.' : '--dry-run: nothing written.');
}

/* ---------------------------------------------------------------- selftest */

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, what) => { if (c) pass++; else fails.push(what); };
  const eq = (got, want, what) => ok(JSON.stringify(got) === JSON.stringify(want),
    `${what}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);

  const JAN = 'Mon, 01 Jan 2026 00:00:00 GMT';
  const JUN = 'Mon, 01 Jun 2026 00:00:00 GMT';
  const user = (over) => Object.assign({
    uid: 'u1', email: 'a@b.edu', displayName: 'Ada Lovelace',
    metadata: { creationTime: JAN, lastSignInTime: JUN },
  }, over || {});

  /* --- timestamps -------------------------------------------------------- */
  eq(stamp(JAN), Date.parse(JAN), 'an Auth timestamp reads as epoch ms');
  eq(stamp(''), 0, 'an absent one is 0, never NaN');
  eq(stamp('not a date'), 0, 'and so is an unreadable one — the rules demand a number');

  /* --- the row ----------------------------------------------------------- */
  const fresh = rowFromAuthUser(user(), null,
    { affiliation: 'MIT Sloan', contactEmail: 'ada@orcid.example' });
  eq(Object.keys(fresh).sort(), ROW_KEYS.slice().sort(),
    'a row carries EXACTLY the keys the rules allow — one the rules do not ' +
    'name would freeze the row against its own owner');
  eq(fresh.email, 'a@b.edu', 'the address comes from Auth, which is authoritative');
  eq(fresh.first, Date.parse(JAN), 'first is the TRUE joined date, not "first seen"');
  eq(fresh.seen, Date.parse(JUN), 'and seen is the last sign-in');
  eq(fresh.affiliation, 'MIT Sloan', 'and the affiliation is the PROFILE\'s, which Auth has no field for');

  /* --- the affiliation: the profile's word, and unknown is not none ------ */
  const noAff = rowFromAuthUser(user(), null, null);
  ok(noAff && !('affiliation' in noAff),
    'a profile with no affiliation (or no profile at all) gives a row with NO affiliation key, ' +
    'never an empty string');
  ok(!('affiliation' in rowFromAuthUser(user(), null, { affiliation: '   ' })),
    'and blank space is no affiliation');
  eq(rowFromAuthUser(user(), { ...fresh }, { affiliation: 'Wharton' }).affiliation, 'Wharton',
    'the profile wins over what the row holds: a corrected affiliation reaches the roster');
  eq(rowFromAuthUser(user(), { ...fresh }, null), { name: fresh.name, email: fresh.email, first: fresh.first, seen: fresh.seen },
    'and a profile that has BLANKED its affiliation takes it off the row — the replace is what lets the key go');

  /* --- the contact address: the same three states, and never the pinned one */
  eq(fresh.contactEmail, 'ada@orcid.example',
    'the contact address is the PROFILE\'s, for an account whose sign-in shares none');
  ok(!('contactEmail' in rowFromAuthUser(user(), null, { affiliation: 'MIT Sloan' })),
    'a profile that gave no contact address gives a row with NO such key, never an empty string');
  ok(!('contactEmail' in rowFromAuthUser(user(), null, { contactEmail: '  ' })),
    'and blank space is no contact address');
  eq(rowFromAuthUser(user(), { ...fresh }, undefined), null,
    'a profiles read that FAILED keeps the contact address the row holds and writes nothing');
  const orcidish = rowFromAuthUser(
    user({ email: '' }), null, { contactEmail: 'ada@orcid.example' });
  ok(orcidish && !('email' in orcidish) && orcidish.contactEmail === 'ada@orcid.example',
    'an ORCID account — no e-mail claim at all — gets the address it GAVE and still no `email` key: ' +
    'the two are never folded together, because the client rule pins `email` to the auth token');
  eq(rowFromAuthUser(user(), { ...fresh }, undefined), null,
    'while a profiles read that FAILED (undefined, not null) keeps the affiliation the row holds and writes nothing');
  eq(rowFromAuthUser(user(), { ...noAff }, undefined), null,
    '…and keeps a row without one without one');
  eq(rowFromAuthUser(user(), null, { affiliation: 'x'.repeat(400) }).affiliation.length, 300,
    'bounded to the 300 characters the rules allow the profile\'s own field');

  /* --- merging with what the browser wrote -------------------------------- */
  const siteName = rowFromAuthUser(user(), { name: 'K. Stouras', first: 1, seen: 1 });
  eq(siteName.name, 'K. Stouras',
    'a name the site already holds is never overwritten by Auth displayName');
  eq(siteName.first, 1, 'an EARLIER stored first-seen wins — dates only correct backwards');

  const later = rowFromAuthUser(user(), { seen: Date.parse(JUN) + 9999 });
  eq(later.seen, Date.parse(JUN) + 9999,
    'a browser session newer than Auth\'s last sign-in is never moved backwards');

  eq(rowFromAuthUser(user({ displayName: '' }), null).name, '',
    'an account with no name still gets a row — the roster shows a dash');
  /* AN EMPTY ADDRESS IS NO KEY AT ALL. The rules pin `email` to
     `request.auth.token.email`, and an ORCID sign-in carries no claim — so
     the browser omits the key and the rule's "not present, or equal" passes.
     Writing `email: ''` from the Admin SDK, which bypasses the rules, left
     `'' == null` in the merged document the OWNER's next write sends:
     permission-denied for ever, on the row they are meant to keep current. */
  const noMail = rowFromAuthUser(user({ email: undefined }), null);
  ok(noMail && !('email' in noMail),
    'a provider sign-in carrying no e-mail claim gets a row with NO email key');
  ok(noMail && typeof noMail.name === 'string' && noMail.seen > 0,
    '…and everything else about it, so the roster still lists them');
  ok(!rowFromAuthUser(user({ email: undefined }), noMail),
    'and a run that changes nothing writes nothing');
  const poisoned = rowFromAuthUser(user({ email: undefined }), { ...noMail, email: '' });
  ok(poisoned && !('email' in poisoned),
    'a row already holding the poisoned empty string is HEALED rather than read as current');
  ok(/@/.test(rowFromAuthUser(user(), null).email || ''),
    'while an account that really has an address keeps it');

  /* --- the no-op, which is what makes a schedule cheap -------------------- */
  eq(rowFromAuthUser(user(), fresh,
    { affiliation: 'MIT Sloan', contactEmail: 'ada@orcid.example' }), null,
    'an account already current costs no write');
  ok(rowFromAuthUser(user({ email: 'new@b.edu' }), fresh, { affiliation: 'MIT Sloan' }) !== null,
    'a changed address does');
  ok(rowFromAuthUser(user(), fresh, { affiliation: 'Somewhere else' }) !== null,
    'and so does a changed affiliation');
  eq(rowFromAuthUser({ uid: 'x', metadata: {} }, null), null,
    'an account with no name, address or dates is not worth a row');

  ok(/3 row\(s\) written/.test(summarise({ seen: 10, written: 3, skipped: 7 })),
    'the run says what it did, so a quiet fire is not a silent one');

  /* --- the two served files: counts and dates, nothing else -------------- */
  const NOW = new Date('2026-09-05T12:00:00Z');
  let n = 0;
  const acc = (creation, disabled, uid) => ({ uid: uid || ('u' + (++n)), disabled: !!disabled,
    metadata: { creationTime: creation }, email: 'x@y.edu', displayName: 'Somebody' });
  const roster = [
    acc('Wed, 02 Sep 2026 08:00:00 GMT', false, 'a'),
    acc('Wed, 02 Sep 2026 21:00:00 GMT', false, 'b'),
    acc('Fri, 04 Sep 2026 03:00:00 GMT', false, 'c'),
    acc('Thu, 03 Sep 2026 03:00:00 GMT', true, 'd'),
    acc('Tue, 01 Sep 2026 03:00:00 GMT', false, 'never'),
  ];
  /* the tally: a, b, c and the disabled d carry a mark; `never` exists in
     Auth and never signed in usably; `gone` is a mark with no account */
  const marks = new Set(['a', 'b', 'c', 'd', 'gone']);
  const meta = usersMeta(roster, NOW, marks);
  eq(Object.keys(meta), ['generated', 'count'], 'users-meta carries generated and count and nothing else');
  eq(meta.count, 3, 'the count is every account that is not disabled AND carries a registeredUsers mark: ' +
    'what the Admin area\'s tile counts, never every account Auth holds');
  eq(usersMeta(roster, NOW, []).count, 0, 'with no marks nobody is counted: Auth alone is never the count');
  /* a MERGE takes one off (owner, 2026-09-05): runMerge deletes the
     duplicate's mark first and its Auth account after, so the count drops
     by one from the mark alone, whether or not the account is still there */
  const merged = new Set(marks); merged.delete('b');
  eq(usersMeta(roster, NOW, merged).count, 2, 'a merged duplicate (mark deleted, account still in Auth) leaves the count');
  eq(usersMeta(roster.filter((u) => u.uid !== 'b'), NOW, merged).count, 2, 'and the count is the same once its account is gone too');
  eq(members(roster, ['a', 'b', 'c', 'd', 'gone']).map((u) => u.uid), ['a', 'b', 'c'],
    'members takes a list as well as a Set, drops the disabled account and ignores a mark with no account behind it');
  eq(meta.generated, '2026-09-05T12:00:00.000Z', 'generated is the run instant, ISO');
  const growth = usersGrowth(roster, NOW, marks);
  eq(Object.keys(growth), ['generated', 'first', 'days'], 'users-growth carries generated, first and days and nothing else');
  eq(growth.first, '2026-09-02', 'first is the first MEMBER account\'s creation day, UTC (the unmarked older one does not move it)');
  eq(growth.days, [['2026-09-02', 2], ['2026-09-03', 2], ['2026-09-04', 3], ['2026-09-05', 3]],
    'one point per UTC day from the first day to the generated day, cumulative, the disabled and the unmarked account not counted');
  eq(growth.days[growth.days.length - 1][1], meta.count, 'the last point equals the count, so the two files agree');
  ok(growth.days.every(([d], i, a) => i === 0 || a[i - 1][0] < d) && growth.days.every(([, n], i, a) => i === 0 || a[i - 1][1] <= n),
    'days are sorted and never decrease');
  eq(usersGrowth([], NOW, marks), { generated: '2026-09-05T12:00:00.000Z', first: '', days: [] },
    'with no accounts the shape is the empty one the seed carries');
  eq(usersGrowth([acc(undefined, false, 'x')], NOW, ['x']).days, [['2026-09-05', 1]],
    'an account with no readable creation time is still counted (from the first day), so the total is never short');
  ok(!/@|Somebody|"uid"/.test(JSON.stringify(meta) + JSON.stringify(growth)),
    'neither file carries an address, a name or a uid, whatever the records held');

  /* --- written only when a reader would see the difference (2026-09-09) ----
     The job runs hourly now, so the stamp alone must not be a commit. */
  ok(!figuresMoved({ generated: 'ages ago', count: 3 }, { generated: NOW.toISOString(), count: 3 }),
    'a run that found the same count moves nothing: `generated` alone is not a difference a reader sees');
  ok(figuresMoved({ generated: 'ages ago', count: 3 }, { generated: 'ages ago', count: 4 }),
    'one more registered user IS a difference');
  ok(!figuresMoved({ count: 3, generated: 'ages ago' }, { generated: NOW.toISOString(), count: 3 }),
    'and key order is not part of the answer, since one side has been through JSON.parse');
  ok(figuresMoved({ generated: '', first: '2026-09-02', days: [['2026-09-02', 3]] },
                  { generated: '', first: '2026-09-02', days: [['2026-09-02', 3], ['2026-09-03', 3]] }),
    'the growth file gaining a day is a difference even where the count stands still, so the chart keeps its point a day');
  ok(figuresMoved(null, meta) && figuresMoved('not an object', meta) && figuresMoved([], meta),
    'a file that is missing, empty or not an object is always written: unknown is never "unchanged"');
  ok(!figuresMoved(JSON.parse(JSON.stringify(growth)), growth),
    'and a growth document really does compare equal to itself through JSON');

  /* THE ONE WAY THIS COULD STOP THE SITE PUBLISHING, pinned rather than
     reasoned about. The two files are written independently now, so a run can
     write one and not the other -- and selftest.mjs asserts over the COMMITTED
     pair that the growth file's last point equals the meta file's count. The
     case that does it is a UTC day turning over with nobody new: the count has
     not moved, so users-meta is left alone, while users-growth gains a point.
     It holds because that new point IS the count. */
  const two = [acc('Tue, 08 Sep 2026 10:00:00 GMT', false, 'p'),
               acc('Tue, 08 Sep 2026 11:00:00 GMT', false, 'q')];
  const twoMarks = new Set(['p', 'q']);
  const late = new Date('2026-09-09T23:41:00Z');
  const over = new Date('2026-09-10T00:41:00Z');
  const metaLate = usersMeta(two, late, twoMarks);
  const growthOver = usersGrowth(two, over, twoMarks);
  ok(!figuresMoved(metaLate, usersMeta(two, over, twoMarks)),
    'a day turning over with nobody new leaves users-meta alone');
  ok(figuresMoved(usersGrowth(two, late, twoMarks), growthOver),
    'while users-growth gains that day\'s point');
  eq(growthOver.days[growthOver.days.length - 1][1], metaLate.count,
    'and the committed pair still agrees about the count, which is the guard that would '
    + 'otherwise stop every data writer committing anything');

  /* the run writes nothing when the tally could not be read or is empty: the
     committed files stand, as with every unreachable source here */
  const runSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const run = runSrc.slice(runSrc.indexOf('async function main()'), runSrc.indexOf('/* ---------------------------------------------------------------- selftest */'));
  ok(/if \(ids\.size\) marks = ids;/.test(run) && /if \(!marks\) \{/.test(run)
     && run.indexOf('if (!marks) {') < run.indexOf('writeServed(USERS_META'),
    'an empty or unreadable tally leaves both served files as they are');
  ok(/writeServed\(USERS_META/.test(run) && /writeServed\(USERS_GROWTH/.test(run)
     && !/writeFile\(path\.join\(DATA, USERS_/.test(run),
    'both served files go through writeServed, so a run that moves nothing writes nothing');
  ok(/collection\(TALLY\)\.get\(\)/.test(run) && /usersMeta\(accounts, now, marks\)/.test(run) && /usersGrowth\(accounts, now, marks\)/.test(run),
    'and the files are built from the tally the Admin area counts');
  ok(/collection\(PROFILES\)\.get\(\)/.test(run) && /rowFromAuthUser\(user, existing\[user\.uid\], profileOf\(user\.uid\)\)/.test(run),
    'the run reads the profiles once and hands each row its own, so the affiliation is the profile\'s');
  ok(/profiles = null;[\s\S]{0,200}could not be read/.test(run)
     && /profiles \? \(profiles\[uid\] \|\| null\) : undefined/.test(run),
    'and a profiles read that fails hands rowFromAuthUser UNDEFINED, never null — unknown is not none');

  /* --- the run's own log, which prints into a PUBLIC Actions log ---------- */
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const mainAt = src.indexOf('async function main()');
  const mainEnd = src.indexOf('/* ---------------------------------------------------------------- selftest */');
  ok(mainAt > 0 && mainEnd > mainAt, 'main() was found');
  const body = src.slice(mainAt, mainEnd);
  ok(body.length > 1500, 'and is the right size, or the checks below are vacuous');
  const calls = body.match(/\b(log|warn)\(([\s\S]*?)\);\n/g) || [];
  ok(calls.length >= 5, 'the log lines were really found');
  ok(calls.every((l) => !/row\.name/.test(l) && !/user\.(email|displayName)/.test(l)
      && !/\.affiliation|profiles\[|profileOf\(/.test(l)
      && !/row\.email/.test(l.replace(/redact\(row\.email\)/g, '')) && !/e\.message/.test(l)),
    'no log line names a person: an address reaches it through redact() only, and a name or an affiliation never');
  ok(calls.some((l) => /redact\(row\.email\)/.test(l)), 'and the redact exemption is exercised, so the check is not vacuous');

  console.log(fails.length
    ? `sync-user-directory selftest: ${fails.length} FAILED, ${pass} passed\n\n  ${fails.join('\n  ')}`
    : `sync-user-directory selftest: ${pass} checks passed`);
  return fails.length === 0;
}

if (!isMain(import.meta.url)) {
  // imported: the pure halves above are the whole of it
} else if (argv.has('--selftest')) {
  process.exit(selftest() ? 0 : 1);
} else {
  main().catch((e) => {
    console.log('::error::user directory sync failed: ' + e.message);
    process.exit(1);
  });
}
