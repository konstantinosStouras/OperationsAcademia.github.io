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

   FOUR KEYS AND NO MORE, WHICH IS LOAD-BEARING. `rowOk()` in _firestore.rules
   pins a roster row to hasOnly(['name','email','first','seen']). The Admin SDK
   bypasses the rules, so a fifth key would be written happily — and then the
   OWNER could never update their own row again, because their merge produces a
   document carrying that key and `hasOnly` refuses it. A sync that quietly
   froze every row it touched would be a poor trade for a backfill. selftest.mjs
   pins the shape against the rules both ways.

   IT NEVER MOVES A DATE BACKWARDS. The browser stamps `seen` on every session;
   Auth's lastSignInTime can lag it. The later of the two wins, so a sync run
   can only ever add what Auth knows and never contradict what the site saw.

   Modes:
     --scan       report what Auth holds and what would change, write nothing
     --dry-run    the same, said as a diff
     --selftest   offline checks over the pure mapping, no network
   --------------------------------------------------------------------------- */

import { isMain } from './_main.mjs';

const argv = new Set(process.argv.slice(2));
const SCAN = argv.has('--scan');
const DRY = argv.has('--dry-run');

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/** The collection the Admin area's roster reads. Kept as a literal here and
    pinned against assets/oa-firebase.js by the selftest, the same way every
    other collection name in this repository is. */
export const DIRECTORY = 'userDirectory';

/** EXACTLY the keys _firestore.rules allows on a roster row. A fifth would
    freeze the row against its own owner — see the header. */
export const ROW_KEYS = ['name', 'email', 'first', 'seen'];

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
 */
export function rowFromAuthUser(user, existing) {
  const had = existing || {};
  const meta = user.metadata || {};

  const authFirst = stamp(meta.creationTime);
  const authSeen = stamp(meta.lastSignInTime);
  const hadFirst = typeof had.first === 'number' ? had.first : 0;
  const hadSeen = typeof had.seen === 'number' ? had.seen : 0;

  const row = {
    name: String(had.name || user.displayName || '').slice(0, 200),
    email: String(user.email || had.email || '').slice(0, 200),
    // earliest non-zero, so a row opened by the browser is corrected to the
    // real joined date rather than kept at the day the site first saw them
    first: [authFirst, hadFirst].filter(Boolean).sort((a, b) => a - b)[0] || 0,
    // never backwards
    seen: Math.max(authSeen, hadSeen),
  };

  /* An account with NO address and NO name is still a person and still gets a
     row — the roster shows "—", exactly as it does for a provider sign-in that
     carries no e-mail claim. But a row with nothing at all AND no dates is not
     worth writing. */
  if (!row.first && !row.seen && !row.email && !row.name) return null;

  const same = ROW_KEYS.every((k) => had[k] === row[k]);
  return same ? null : row;
}

/** What a run did, in one sentence — so a scheduled fire that changed nothing
    says so rather than printing nothing at all. */
export function summarise({ seen, written, skipped }) {
  return `${seen} account(s) in Auth: ${written} row(s) written, ` +
    `${skipped} already current.`;
}

/* -------------------------------------------------------------------- main */

async function firestoreAndAuth() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !raw.trim()) return null;

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    try {
      creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      warn('FIREBASE_SERVICE_ACCOUNT is set but is neither JSON nor base64 JSON');
      return null;
    }
  }

  let admin;
  try {
    admin = await import('firebase-admin');
  } catch {
    warn('firebase-admin is not installed — run `npm i firebase-admin` in the workflow');
    return null;
  }
  const app = admin.default || admin;
  if (!app.apps.length) app.initializeApp({ credential: app.credential.cert(creds) });
  return { db: app.firestore(), auth: app.auth() };
}

async function main() {
  const fb = await firestoreAndAuth();
  if (!fb) {
    log('no Firebase credentials in this environment — nothing to sync.');
    log('(this is the expected state until the project is set up: _SETUP-FIREBASE.md)');
    return;
  }

  const col = fb.db.collection(DIRECTORY);

  /* What the roster already holds, read once: the merge needs the stored row
     to preserve a site-derived name and to leave an unchanged account alone. */
  const existing = {};
  (await col.get()).forEach((d) => { existing[d.id] = d.data() || {}; });
  log(`roster holds ${Object.keys(existing).length} row(s) before this run`);

  let seen = 0, written = 0, skipped = 0;
  let pending = [];

  const flush = async () => {
    if (!pending.length || SCAN || DRY) { pending = []; return; }
    const batch = fb.db.batch();
    for (const [uid, row] of pending) batch.set(col.doc(uid), row, { merge: true });
    await batch.commit();
    pending = [];
  };

  let token;
  do {
    // 1000 is the Admin SDK's maximum page
    const page = await fb.auth.listUsers(1000, token);
    for (const user of page.users) {
      seen++;
      const row = rowFromAuthUser(user, existing[user.uid]);
      if (!row) { skipped++; continue; }
      written++;
      if (SCAN || DRY) {
        log(`  ${user.uid}  ${row.email || '(no address)'}  ${row.name || '(no name)'}`);
      }
      pending.push([user.uid, row]);
      if (pending.length >= 400) await flush();
    }
    token = page.pageToken;
  } while (token);

  await flush();

  log(summarise({ seen, written, skipped }));
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
  const fresh = rowFromAuthUser(user(), null);
  eq(Object.keys(fresh).sort(), ROW_KEYS.slice().sort(),
    'a row carries EXACTLY the four keys the rules allow — a fifth would freeze ' +
    'the row against its own owner');
  eq(fresh.email, 'a@b.edu', 'the address comes from Auth, which is authoritative');
  eq(fresh.first, Date.parse(JAN), 'first is the TRUE joined date, not "first seen"');
  eq(fresh.seen, Date.parse(JUN), 'and seen is the last sign-in');

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
  eq(rowFromAuthUser(user({ email: undefined }), null).email, '',
    'and so does a provider sign-in carrying no e-mail claim');

  /* --- the no-op, which is what makes a schedule cheap -------------------- */
  eq(rowFromAuthUser(user(), fresh), null,
    'an account already current costs no write');
  ok(rowFromAuthUser(user({ email: 'new@b.edu' }), fresh) !== null,
    'a changed address does');
  eq(rowFromAuthUser({ uid: 'x', metadata: {} }, null), null,
    'an account with no name, address or dates is not worth a row');

  ok(/3 row\(s\) written/.test(summarise({ seen: 10, written: 3, skipped: 7 })),
    'the run says what it did, so a quiet fire is not a silent one');

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
