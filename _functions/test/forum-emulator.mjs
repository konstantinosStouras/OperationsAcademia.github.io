#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia: the forum's Cloud Functions and Security Rules,
   against the REAL Firebase emulator (Auth + Firestore + Functions).

       firebase emulators:exec --project demo-oa-forum --only auth,firestore,functions \
         "node _functions/test/forum-emulator.mjs"

   from the repository root, with FORUM_SECRET_TEST and FORUM_SECRET_TEST_2
   in the environment (any two different strings). Needs Java and
   firebase-tools; SKIPS with a message when either is missing, and under CI
   that same skip exits 1 (page-test's rule: the workflow installs both, so
   the only thing a skip could mean there is that an install broke).

   What it pins, end to end and against the real thing:

     the rules      a current candidate reads both rooms; a verified account
                    with no profile reads the open room only; a signed-in but
                    unverified password account reads nothing; a client write
                    to any forum path is refused, the maintainer's browser
                    included; nobody, the maintainer included, reads a vote or
                    forumNames; the maintainer reads forumHandles.
     the callables  join is idempotent and gives one handle per season; the
                    maintainer joins with no profile and enters both rooms; a
                    thread, a reply with a verified quote (a copy), an edit
                    inside the window, a vote up / down / withdrawn with the
                    counts and the first post's score following, own-post
                    refused, the guide seeded once per room and refused twice,
                    every guard fixture refused with its reason, a wrong quote
                    refused, an archived season refused, and two secret
                    versions giving two handles for one uid.
     the deletion   the accountDeletions rules, which are not the forum's but
                    are the one destructive feature here whose boundary can
                    be exercised against the real engine: who may file an order,
                    that nobody updates one from a browser, and that cancelling
                    stops the moment the sweep starts.
     the privacy    R7: every stored stamp is a whole minute. R10: after the
                    scenario every document under forumSeasons, forumTags,
                    forumHandles and forumNames is walked and fails on any test
                    uid, e-mail address, candidateSubmissions id, or 64-hex
                    string outside forumHandles ids, votes ids and
                    forumNames.key; candidateMarkers is walked apart for
                    e-mail and hash only, since it carries a uid and a profile
                    id by design.
   --------------------------------------------------------------------------- */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const requireFn = createRequire(path.join(ROOT, '_functions', 'package.json'));

const PROJECT = 'demo-oa-forum';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FIRESTORE = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const FUNCTIONS = '127.0.0.1:5001';

function have(cmd, args) {
  try { return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0; } catch { return false; }
}
function skip(why) {
  console.log('SKIPPED: ' + why);
  process.exit(process.env.CI ? 1 : 0);
}
if (!have('java', ['-version'])) skip('Java is not installed, so the Firestore emulator cannot run.');
if (!have('firebase', ['--version'])) skip('firebase-tools is not installed (npm i -g firebase-tools).');
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST && !process.env.FIRESTORE_EMULATOR_HOST) {
  skip('not running under firebase emulators:exec (no emulator hosts in the environment).');
}
if (!process.env.FORUM_SECRET_TEST || !process.env.FORUM_SECRET_TEST_2) {
  console.error('FORUM_SECRET_TEST and FORUM_SECRET_TEST_2 must both be set');
  process.exit(1);
}

process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH;
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE;

const { initializeApp } = requireFn('firebase-admin/app');
const { getFirestore } = requireFn('firebase-admin/firestore');
const { getAuth } = requireFn('firebase-admin/auth');
const RUT = requireFn('@firebase/rules-unit-testing');
const NAV = requireFn(path.join(ROOT, '_functions', 'jobnav.js'));
const M = requireFn(path.join(ROOT, '_functions', 'forum-model.js'));

initializeApp({ projectId: PROJECT });
const admin = getFirestore();
const auth = getAuth();
const Y = NAV.marketYear();
const ADMIN_EMAIL = 'kstouras@gmail.com';

let checks = 0, fails = 0;
const ok = (c, m, extra) => {
  checks++;
  if (c) console.log('  ok   ' + m);
  else { fails++; console.log('  FAIL ' + m + (extra ? '\n         ' + String(extra).slice(0, 400) : '')); }
};

/* ------------------------------------------------------------------ people */

const people = {
  cand: { uid: 'cand-uid-0000000000000001', email: 'cand.one@example.edu', verified: true },
  open: { uid: 'open-uid-0000000000000002', email: 'open.reader@example.org', verified: true },
  pend: { uid: 'pend-uid-0000000000000003', email: 'pending.person@example.net', verified: false },
  adm: { uid: 'admin-uid-000000000000004', email: ADMIN_EMAIL, verified: true },
};
const PASSWORD = 'emulator-pass-12345';

async function makeUser(p) {
  await auth.createUser({ uid: p.uid, email: p.email, emailVerified: p.verified, password: PASSWORD });
}

/** A real password sign-in against the Auth emulator, so the token carries
    sign_in_provider 'password' exactly as a browser's would. */
async function idToken(p) {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: p.email, password: PASSWORD, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error('no idToken for ' + p.uid + ': ' + JSON.stringify(j).slice(0, 200));
  return j.idToken;
}

async function call(name, token, data) {
  const r = await fetch(`http://${FUNCTIONS}/${PROJECT}/us-central1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ data: data || {} }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.error) return { error: j.error };
  return { result: j.result };
}
const reason = (res) => (res.error && res.error.details && res.error.details.reason) || '';
const status = (res) => (res.error && res.error.status) || '';

/* ------------------------------------------------------------------ set-up */

async function waitForFunctions() {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    try {
      const r = await call('forumJoin', null, {});
      if (r.error && r.error.status === 'UNAUTHENTICATED') return;
    } catch {}
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('the functions emulator never answered forumJoin');
}

async function main() {
  await waitForFunctions();
  for (const p of Object.values(people)) await makeUser(p);
  /* the candidate's profile, this season, queued */
  const profileRef = await admin.collection('candidateSubmissions').add({
    uid: people.cand.uid, year: Y, status: 'queued', first: 'Ada', last: 'Lovelace',
    email: people.cand.email, affiliation: 'Example University', createdAt: new Date(),
  });
  const PROFILE_ID = profileRef.id;
  const tokens = {};
  for (const [k, p] of Object.entries(people)) tokens[k] = await idToken(p);

  /* ---------------------------------------------------------- join */
  console.log('\nforumJoin');
  const j1 = await call('forumJoin', tokens.cand, {});
  ok(!j1.error && j1.result.handle && j1.result.rooms.candidates === true && j1.result.rooms.open === true,
    'a current candidate joins and may enter both rooms', JSON.stringify(j1));
  const j2 = await call('forumJoin', tokens.cand, {});
  ok(!j2.error && j2.result.handle === j1.result.handle, 'joining again gives the same handle (idempotent)');
  ok(/^[a-z]+ [a-z]+ \d\d$/.test(j1.result.handle || ''), 'the handle is adjective noun NN');
  const jo = await call('forumJoin', tokens.open, {});
  ok(!jo.error && jo.result.rooms.candidates === false && jo.result.rooms.open === true,
    'a verified account with no profile enters the open room only');
  const jp = await call('forumJoin', tokens.pend, {});
  ok(status(jp) === 'PERMISSION_DENIED' && reason(jp) === 'verified', 'an unverified password account is refused with reason verified');
  const ja = await call('forumJoin', tokens.adm, {});
  ok(!ja.error && ja.result.rooms.candidates === true && ja.result.rooms.open === true && ja.result.handle !== M.MODERATOR,
    'the maintainer joins with no profile, enters both rooms, and gets an ordinary handle');
  ok(j1.result.season === Y && j1.result.rollsOn === Y + '-07-01', 'the season and the roll date');
  const marker = await admin.collection('candidateMarkers').doc(people.cand.uid).get();
  ok(marker.exists && marker.data().sub === PROFILE_ID && marker.data().year === Y, 'the membership marker names the profile and the season');
  const noMarker = await admin.collection('candidateMarkers').doc(people.adm.uid).get();
  ok(!noMarker.exists, 'the maintainer gets no marker (no profile to point at)');

  /* ------------------------------------------------------- seed the guide */
  console.log('\nforumModerate seedGuide');
  const s1 = await call('forumModerate', tokens.adm, { op: 'seedGuide', room: 'candidates' });
  ok(!s1.error && s1.result.tid, 'the maintainer seeds the candidates room guide', JSON.stringify(s1));
  const s2 = await call('forumModerate', tokens.adm, { op: 'seedGuide', room: 'candidates' });
  ok(status(s2) === 'ALREADY_EXISTS', 'seeding the same room twice is refused');
  const s3 = await call('forumModerate', tokens.adm, { op: 'seedGuide', room: 'open' });
  ok(!s3.error && s3.result.tid && s3.result.tid !== s1.result.tid, 'the open room gets its own guide thread');
  const sc = await call('forumModerate', tokens.cand, { op: 'seedGuide', room: 'open' });
  ok(status(sc) === 'PERMISSION_DENIED' && reason(sc) === 'admin', 'a member cannot moderate');
  const guideThread = await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${s1.result.tid}`).get();
  ok(guideThread.data().pinned === true && guideThread.data().locked === true && guideThread.data().by === M.MODERATOR
     && JSON.stringify(guideThread.data().tags) === '["about"]', 'the guide thread is pinned, locked, by Moderator, tagged about');
  const season = await admin.doc(`forumSeasons/${Y}`).get();
  ok(season.data().guides.candidates === s1.result.tid && season.data().guides.open === s3.result.tid && season.data().secretVersion === 'env',
    'the season head names both guide threads and the emulator secret version');

  /* ------------------------------------------------------------- post */
  console.log('\nforumPost');
  const noGuide = await call('forumPost', tokens.cand, { room: 'candidates', title: 'First question', tags: ['offers'], body: 'Is a second-year release normal to ask for?', kind: 'first-hand' });
  ok(status(noGuide) === 'FAILED_PRECONDITION' && reason(noGuide) === 'guide', 'the first post needs acceptGuide');
  const t1 = await call('forumPost', tokens.cand, { room: 'candidates', title: 'First question', tags: ['Offers', 'negotiation', 'offers'], body: 'Is a second-year release normal to ask for? Two questions for people who have been through this.', kind: 'first-hand', acceptGuide: true });
  ok(!t1.error && t1.result.tid && t1.result.pid && t1.result.n === 1, 'a new thread opens', JSON.stringify(t1));
  const th1 = await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}`).get();
  ok(JSON.stringify(th1.data().tags) === '["offers","negotiation"]', 'tags are slugged and de-duplicated');
  ok(th1.data().by === j1.result.handle && th1.data().score === 0 && th1.data().n === 1, 'the head carries the handle, a zero score and n 1');
  const tally = await admin.doc(`forumTags/${Y}_candidates`).get();
  ok(tally.data().counts.offers === 1 && tally.data().counts.negotiation === 1 && tally.data().counts.about === 1, 'the tag tally counts the thread and the guide');
  const bad = [
    ['jane@mit.edu', 'email'], ['+1 617 253 1000', 'phone'],
    ['0000-0002-1825-0097', 'orcid'], ['(617) 253-1000', 'phone'],
  ];
  for (const [text, why] of bad) {
    const r = await call('forumPost', tokens.cand, { room: 'candidates', tid: t1.result.tid, body: 'see ' + text, kind: '' });
    ok(status(r) === 'INVALID_ARGUMENT' && reason(r) === why, `the guard refuses "${text}" as ${why}`);
  }
  /* a link posts (owner, 2026-09-05); the three the guard used to refuse are
     kept here as the positive control that the change reached the function */
  const fine = ['2026-2027', '$120,000-150,000', '10.1287/mnsc.2020.3745',
    'mit.edu/~jane', 'www.example.org', 'https://example.org/x'];
  let quoteSource = null;
  for (const text of fine) {
    /* the gap between posts is 20 s, so these are spaced by back-dating the handle */
    await admin.collection('forumHandles').where('season', '==', Y).get().then((s) =>
      Promise.all(s.docs.map((d) => d.ref.set({ lastPostAt: 0 }, { merge: true }))));
    const r = await call('forumPost', tokens.cand, { room: 'candidates', tid: t1.result.tid, body: 'A reply mentioning ' + text + ' and nothing else.', kind: 'rumour' });
    ok(!r.error, `the guard allows "${text}"`, JSON.stringify(r));
    if (!quoteSource && !r.error) quoteSource = r.result;
  }
  const badTags = await call('forumPost', tokens.cand, { room: 'candidates', title: 'T', tags: ['a', 'b', 'c', 'd', 'e', 'f'], body: 'body text', kind: '', acceptGuide: true });
  ok(status(badTags) === 'INVALID_ARGUMENT' && reason(badTags) === 'tags', 'six tags are refused');
  const noRoom = await call('forumPost', tokens.cand, { room: 'lobby', body: 'x', kind: '' });
  ok(status(noRoom) === 'INVALID_ARGUMENT' && reason(noRoom) === 'room', 'an unknown room is refused');
  const openByReader = await call('forumPost', tokens.open, { room: 'candidates', tid: t1.result.tid, body: 'hello', kind: '' });
  ok(status(openByReader) === 'PERMISSION_DENIED' && reason(openByReader) === 'candidate', 'a non-candidate cannot post in the candidates room, reason candidate');
  const pendPost = await call('forumPost', tokens.pend, { room: 'candidates', tid: t1.result.tid, body: 'hello', kind: '' });
  ok(reason(pendPost) === 'candidate', 'an unverified account gets the SAME reason for the candidates room (R5)');
  const locked = await call('forumPost', tokens.cand, { room: 'candidates', tid: s1.result.tid, body: 'hello', kind: '' });
  ok(status(locked) === 'FAILED_PRECONDITION' && reason(locked) === 'locked', 'a locked thread refuses a reply');

  /* ------------------------------------------------------------ quote */
  console.log('\nquote');
  await admin.collection('forumHandles').get().then((s) => Promise.all(s.docs.map((d) => d.ref.set({ lastPostAt: 0 }, { merge: true }))));
  const q1 = await call('forumPost', tokens.adm, { room: 'candidates', tid: t1.result.tid, body: 'Agreed, on the whole.', kind: '', acceptGuide: true, quote: { n: 1, text: 'second-year release' } });
  ok(!q1.error && q1.result.n > 1, 'the maintainer replies with a quote of post 1', JSON.stringify(q1));
  const qp = await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}/posts/${q1.result.pid}`).get();
  ok(qp.data().quote && qp.data().quote.n === 1 && qp.data().quote.by === j1.result.handle && qp.data().quote.text === 'second-year release',
    'the quote is stored as a copy {n, by, text}');
  const q2 = await call('forumPost', tokens.adm, { room: 'candidates', tid: t1.result.tid, body: 'x', kind: '', quote: { n: 1, text: 'not in the post' } });
  ok(status(q2) === 'INVALID_ARGUMENT' && reason(q2) === 'quote', 'a quote that is not a passage of post n is refused');
  const q3 = await call('forumPost', tokens.adm, { room: 'candidates', tid: t1.result.tid, body: 'x', kind: '', quote: { n: 99, text: 'a' } });
  ok(reason(q3) === 'quote', 'a quote of a post that does not exist is refused the same way');

  /* ------------------------------------------------------------- edit */
  console.log('\nforumEdit');
  const e1 = await call('forumEdit', tokens.cand, { room: 'candidates', tid: t1.result.tid, pid: t1.result.pid, body: 'Edited: is a second-year release normal to ask for?', kind: 'first-hand' });
  ok(!e1.error && e1.result.editedAt % 60000 === 0, 'the author edits within the window, stamp on the minute');
  const th1b = await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}`).get();
  ok(/^Edited:/.test(th1b.data().excerpt), 'editing post 1 recomputes the excerpt');
  const e2 = await call('forumEdit', tokens.adm, { room: 'candidates', tid: t1.result.tid, pid: t1.result.pid, body: 'not mine', kind: '' });
  ok(status(e2) === 'PERMISSION_DENIED' && reason(e2) === 'author', 'somebody else cannot edit it');
  await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}/posts/${t1.result.pid}`).update({ t: M.minute() - 16 * 60000 });
  const e3 = await call('forumEdit', tokens.cand, { room: 'candidates', tid: t1.result.tid, pid: t1.result.pid, body: 'too late', kind: '' });
  ok(status(e3) === 'FAILED_PRECONDITION' && reason(e3) === 'window', 'sixteen minutes on, the window has closed');

  /* ------------------------------------------------------------- vote */
  console.log('\nforumVote');
  const own = await call('forumVote', tokens.cand, { room: 'candidates', tid: t1.result.tid, pid: t1.result.pid, v: 1 });
  ok(status(own) === 'FAILED_PRECONDITION' && reason(own) === 'own', 'a member cannot vote on their own post');
  const v1 = await call('forumVote', tokens.adm, { room: 'candidates', tid: t1.result.tid, pid: t1.result.pid, v: 1 });
  ok(!v1.error && v1.result.up === 1 && v1.result.down === 0, 'an up vote counts', JSON.stringify(v1));
  const v2 = await call('forumVote', tokens.adm, { room: 'candidates', tid: t1.result.tid, pid: t1.result.pid, v: -1 });
  ok(!v2.error && v2.result.up === 0 && v2.result.down === 1, 'changing it to down moves both tallies');
  const th1c = await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}`).get();
  ok(th1c.data().score === -1, 'the first post\'s net follows onto the thread head as score');
  const tv = await call('forumThreadVotes', tokens.adm, { room: 'candidates', tid: t1.result.tid });
  ok(!tv.error && tv.result.votes[t1.result.pid] === -1 && Object.keys(tv.result.votes).length === 1, 'forumThreadVotes returns the caller\'s own votes only');
  const v3 = await call('forumVote', tokens.adm, { room: 'candidates', tid: t1.result.tid, pid: t1.result.pid, v: 0 });
  ok(!v3.error && v3.result.up === 0 && v3.result.down === 0, 'withdrawing the vote zeroes the tallies');
  const th1d = await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}`).get();
  ok(th1d.data().score === 0, 'and the score is back to zero');
  const votes = await admin.collection(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}/posts/${t1.result.pid}/votes`).get();
  ok(votes.empty, 'a withdrawn vote leaves no document');

  /* ----------------------------------------------------------- delete */
  console.log('\nforumDelete');
  const notMine = await call('forumDelete', tokens.adm, { room: 'candidates', tid: t1.result.tid, pid: t1.result.pid });
  ok(status(notMine) === 'PERMISSION_DENIED' && reason(notMine) === 'author', 'somebody else cannot delete it');
  /* the author's own reply, long past the edit window: there is no window */
  const rep = await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}/posts/${quoteSource.pid}`).get();
  const repN = rep.data().n;
  await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}/posts/${quoteSource.pid}`).update({ t: M.minute() - 99 * 60000 });
  const d1 = await call('forumDelete', tokens.cand, { room: 'candidates', tid: t1.result.tid, pid: quoteSource.pid });
  ok(!d1.error && d1.result.ok === true && d1.result.thread === false, 'the author deletes their own reply, window or no window', JSON.stringify(d1));
  const dp = await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}/posts/${quoteSource.pid}`).get();
  ok(dp.exists && dp.data().body === '' && dp.data().kind === '' && dp.data().hidden === true && dp.data().hiddenBy === 'author',
    'the words are erased in the database, not merely flagged');
  ok(dp.data().n === repN, 'and the slot keeps its number, so the replies still read');
  ok(dp.data().editedAt % 60000 === 0, 'the stamp is on the minute (R7)');
  const again = await call('forumDelete', tokens.cand, { room: 'candidates', tid: t1.result.tid, pid: quoteSource.pid });
  ok(!again.error, 'a second press is a success, not an error');
  /* a quote of a deleted post survives: forumPost stored a COPY */
  const qAfter = await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}/posts/${q1.result.pid}`).get();
  ok(qAfter.data().quote && qAfter.data().quote.text === 'second-year release', 'a quote of somebody else\'s post is a copy and survives their deletion');
  /* the OPENING post of a thread that HAS replies: the thread stands */
  const d2 = await call('forumDelete', tokens.cand, { room: 'candidates', tid: t1.result.tid, pid: t1.result.pid });
  ok(!d2.error && d2.result.thread === false, 'deleting the opening post of a thread with replies leaves the thread');
  const th1e = await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}`).get();
  ok(th1e.data().hidden === false && th1e.data().title === M.DELETED_TITLE && th1e.data().excerpt === '',
    'the title and the excerpt were the author\'s words too, and go with them');
  /* the OPENING post of a thread nobody has replied to: the thread goes */
  await admin.collection('forumHandles').get().then((s2) => Promise.all(s2.docs.map((d) => d.ref.set({ lastPostAt: 0 }, { merge: true }))));
  const solo = await call('forumPost', tokens.cand, { room: 'candidates', title: 'A question I will withdraw', tags: ['waiting'], body: 'Something I would rather not have asked after all.', kind: '' });
  ok(!solo.error, 'a fresh thread with no replies', JSON.stringify(solo));
  const d3 = await call('forumDelete', tokens.cand, { room: 'candidates', tid: solo.result.tid, pid: solo.result.pid });
  ok(!d3.error && d3.result.thread === true, 'deleting it takes the whole thread');
  const soloTh = await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${solo.result.tid}`).get();
  ok(soloTh.data().hidden === true, 'and the thread is hidden, off every list');

  /* ---------------------------------------------------------- archive */
  console.log('\narchive');
  await admin.doc(`forumSeasons/${Y - 1}`).set({ season: Y - 1, createdAt: M.minute(), secretVersion: 'env', guides: {} });
  const oldThread = await admin.collection(`forumSeasons/${Y - 1}/rooms/candidates/threads`).add({
    season: Y - 1, room: 'candidates', title: 'Old', tags: ['about'], by: 'old handle 11', t: 0, lastAt: 0, lastBy: 'old handle 11', n: 1, excerpt: '', score: 0, pinned: false, locked: false, hidden: false,
  });
  /* the functions address the CURRENT season by path, so an old thread id is
     simply not found there; the archive refusal fires on a season field that
     disagrees, which is what a stale copy under the current path would carry */
  await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${oldThread.id}`).set({
    season: Y - 1, room: 'candidates', title: 'Stale', tags: ['about'], by: 'old handle 11', t: 0, lastAt: 0, lastBy: 'old handle 11', n: 1, excerpt: '', score: 0, pinned: false, locked: false, hidden: false,
  });
  const ar = await call('forumPost', tokens.cand, { room: 'candidates', tid: oldThread.id, body: 'hello', kind: '' });
  ok(status(ar) === 'FAILED_PRECONDITION' && reason(ar) === 'archive', 'a thread of another season refuses a reply');
  /* and a deletion: once a season's secret version is destroyed its handles
     cannot be re-derived, so "the author" is not a question with an answer */
  const arDel = await call('forumDelete', tokens.cand, { room: 'candidates', tid: oldThread.id, pid: 'whatever' });
  ok(reason(arDel) === 'thread' || reason(arDel) === 'archive', 'and refuses a deletion');
  await admin.doc(`forumSeasons/${Y}/rooms/candidates/threads/${oldThread.id}`).delete();

  /* ------------------------------------------- two secret versions, one uid */
  console.log('\nsecret versions');
  const hs = await admin.collection('forumHandles').get();
  const handlesBefore = hs.docs.map((d) => d.id);
  await admin.doc(`forumSeasons/${Y}`).update({ secretVersion: 'env2' });
  const j3 = await call('forumJoin', tokens.open, {});
  ok(!j3.error && j3.result.handle !== jo.result.handle, 'under a second secret version the same uid gets a different handle');
  const hs2 = await admin.collection('forumHandles').get();
  const newIds = hs2.docs.map((d) => d.id).filter((id) => !handlesBefore.includes(id));
  ok(newIds.length === 1 && /^[0-9a-f]{64}$/.test(newIds[0]), 'a new 64-hex handle document was created for it');
  await admin.doc(`forumSeasons/${Y}`).update({ secretVersion: 'env' });

  /* -------------------------------------------------------------- rules */
  console.log('\nrules');
  const rules = readFileSync(path.join(ROOT, '_firestore.rules'), 'utf8');
  const env = await RUT.initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules, host: FIRESTORE.split(':')[0], port: Number(FIRESTORE.split(':')[1]) },
  });
  const ctx = (p) => env.authenticatedContext(p.uid, {
    email: p.email, email_verified: p.verified, firebase: { sign_in_provider: 'password' },
  }).firestore();
  const canRead = async (fs, pathStr) => {
    try { await fs.doc(pathStr).get(); return true; } catch { return false; }
  };
  const canList = async (fs, pathStr) => {
    try { await fs.collection(pathStr).get(); return true; } catch { return false; }
  };
  const threadPath = `forumSeasons/${Y}/rooms/candidates/threads/${t1.result.tid}`;
  const postPath = `${threadPath}/posts/${t1.result.pid}`;
  const openGuide = `forumSeasons/${Y}/rooms/open/threads/${s3.result.tid}`;
  ok(await canRead(ctx(people.cand), threadPath) && await canRead(ctx(people.cand), postPath), 'rules: a current candidate reads a candidates-room thread and post');
  ok(await canRead(ctx(people.cand), openGuide), 'rules: and the open room');
  ok(!(await canRead(ctx(people.open), threadPath)), 'rules: a verified account with no profile cannot read the candidates room');
  ok(await canRead(ctx(people.open), openGuide), 'rules: but reads the open room');
  ok(!(await canRead(ctx(people.pend), openGuide)) && !(await canRead(ctx(people.pend), threadPath)), 'rules: an unverified password account reads neither room');
  ok(await canRead(ctx(people.adm), threadPath) && await canRead(ctx(people.adm), openGuide), 'rules: the maintainer reads both rooms with no profile');
  ok(await canList(ctx(people.cand), `forumSeasons/${Y}/rooms/candidates/threads`), 'rules: a candidate LISTS the candidates room threads');
  ok(!(await canList(ctx(people.open), `forumSeasons/${Y}/rooms/candidates/threads`)), 'rules: a non-candidate cannot list them');
  ok(await canRead(ctx(people.open), `forumSeasons/${Y}`) && await canRead(ctx(people.open), `forumTags/${Y}_candidates`), 'rules: the season head and the tag tally are readable to any verified account');
  ok(!(await canRead(ctx(people.adm), `${postPath}/votes/${newIds[0]}`)), 'rules: nobody reads a vote, the maintainer included');
  ok(!(await canList(ctx(people.adm), `${postPath}/votes`)), 'rules: nor lists them');
  ok(!(await canList(ctx(people.adm), 'forumNames')), 'rules: nobody reads forumNames, the maintainer included');
  ok(await canList(ctx(people.adm), 'forumHandles') && !(await canList(ctx(people.cand), 'forumHandles')), 'rules: forumHandles is the maintainer\'s to read and nobody else\'s');
  ok(await canRead(ctx(people.cand), `candidateMarkers/${people.cand.uid}`) && !(await canRead(ctx(people.open), `candidateMarkers/${people.cand.uid}`)),
    'rules: a marker is its owner\'s (and the maintainer\'s) to read');
  const writes = [
    [people.adm, threadPath, { pinned: true }],
    [people.cand, postPath, { body: 'rewritten' }],
    [people.cand, `forumSeasons/${Y}`, { guides: {} }],
    [people.adm, `forumTags/${Y}_candidates`, { counts: {} }],
    [people.adm, `forumHandles/${newIds[0]}`, { status: 'banned' }],
    [people.cand, `candidateMarkers/${people.cand.uid}`, { year: Y }],
    [people.adm, `${postPath}/votes/${newIds[0]}`, { v: 1, t: 0 }],
    [people.cand, 'forumNames/quiet-heron-42', { season: Y, key: 'x' }],
  ];
  for (const [p, pth, data] of writes) {
    let refused = false;
    try { await ctx(p).doc(pth).set(data, { merge: true }); } catch { refused = true; }
    ok(refused, `rules: a client write to ${pth.replace(/\/[^/]{20,}/g, '/…')} is refused (${p === people.adm ? 'the maintainer' : 'a member'})`);
  }
  let delOk = false;
  try { await ctx(people.cand).doc(`candidateMarkers/${people.cand.uid}`).delete(); delOk = true; } catch {}
  ok(delOk, 'rules: an owner may delete their own marker');

  /* ------------------------------------------------- deleting an account

     Not the forum, and here on purpose: this is the one place in the
     repository where _firestore.rules is exercised against the real engine
     rather than by reading the file, and `accountDeletions` is the security
     boundary of a DESTRUCTIVE feature. A regex over the rules file cannot
     tell whether the clause it matched actually refuses anything.

     What is pinned is exactly what the block promises: a person files their
     own order and nobody else's, only as 'self'; the maintainer files
     anyone's, only as 'admin'; NOBODY updates one from a browser, which is
     what makes the sweep's own Admin-SDK stamps safe; and cancelling works
     while the order is queued and not once it is being carried out, because
     by then the alerts and the sign-in have already gone. */
  console.log('\naccount deletion rules');
  const AD = requireFn(path.join(ROOT, 'assets', 'oa-account-delete.js'));
  const order = (p, by) => AD.requestDoc({ uid: p.uid, by, email: p.email, name: 'Someone', now: 1 });
  const tryWrite = async (fs, pth, data, how) => {
    try {
      if (how === 'update') await fs.doc(pth).update(data);
      else if (how === 'delete') await fs.doc(pth).delete();
      else await fs.doc(pth).set(data);
      return true;
    } catch { return false; }
  };
  const adPath = (p) => `${AD.COLLECTION}/${p.uid}`;

  ok(!(await tryWrite(ctx(people.cand), adPath(people.open), order(people.open, 'self'))),
    'rules: a person cannot file somebody ELSE\'s deletion');
  ok(!(await tryWrite(ctx(people.cand), adPath(people.cand), order(people.cand, 'admin'))),
    'rules: …nor file one that reads as the maintainer\'s decision');
  ok(!(await tryWrite(ctx(people.pend), adPath(people.pend), order(people.pend, 'self'))),
    'rules: an unverified password account cannot file one at all');
  ok(await tryWrite(ctx(people.cand), adPath(people.cand), order(people.cand, 'self')),
    'rules: and a person files their OWN, as self');
  ok(await canRead(ctx(people.cand), adPath(people.cand)) &&
     await canRead(ctx(people.adm), adPath(people.cand)) &&
     !(await canRead(ctx(people.open), adPath(people.cand))),
    'rules: the person and the maintainer see it, and nobody else does');

  ok(!(await tryWrite(ctx(people.cand), adPath(people.cand), { status: 'done' }, 'update')) &&
     !(await tryWrite(ctx(people.adm), adPath(people.cand), { status: 'done' }, 'update')),
    'rules: NOBODY updates one from a browser, the maintainer included, which ' +
    'is what makes the sweep\'s own stamps safe to write with the Admin SDK');
  ok(!(await tryWrite(ctx(people.cand), adPath(people.cand), null, 'delete')),
    'rules: a person cannot call their own deletion off');
  ok(await tryWrite(ctx(people.adm), adPath(people.cand), null, 'delete'),
    'rules: the maintainer can, while it is still queued');

  /* THE OWNER'S OWN BUG, 2026-09-05: a first attempt filed the order, the
     password prompt stopped it part way, and every later attempt was refused,
     because a `set` over a document that already exists is an UPDATE and every
     browser update of one is refused. Pinned against the real engine, because
     it is the ENGINE's reading of `set` that caused it: the browser now reads
     the order first and carries on from it. */
  ok(await tryWrite(ctx(people.cand), adPath(people.cand), order(people.cand, 'self')),
    'rules: a person files their own order again after it was deleted');
  ok(!(await tryWrite(ctx(people.cand), adPath(people.cand), order(people.cand, 'self'))),
    'rules: …and filing the SAME order twice is refused, because a set over one ' +
    'that exists is an update, which is why the panel reads before it writes');
  await admin.doc(adPath(people.cand)).delete();

  ok(await tryWrite(ctx(people.adm), adPath(people.open), order(people.open, 'admin')),
    'rules: the maintainer files anyone\'s deletion');
  await admin.doc(adPath(people.open)).set({ status: 'clearing' }, { merge: true });
  ok(!(await tryWrite(ctx(people.adm), adPath(people.open), null, 'delete')),
    'rules: …and once the sweep has started it can no longer be called off, ' +
    'because "cancelled" would then be a lie');
  await admin.doc(adPath(people.open)).delete();

  await env.cleanup();

  /* --------------------------------------------- R7 and R10: the document walk */
  console.log('\nprivacy walk');
  const uids = Object.values(people).map((p) => p.uid);
  const emails = Object.values(people).map((p) => p.email);
  const HEX = /\b[0-9a-f]{64}\b/;
  let walked = 0, stampsChecked = 0;
  async function walk(docRef, allowHexField) {
    const snap = await docRef.get();
    if (snap.exists) {
      walked++;
      const data = snap.data();
      const json = JSON.stringify(data);
      for (const u of uids) ok(!json.includes(u), `no uid in ${docRef.path}`, u);
      for (const e of emails) ok(!json.includes(e), `no e-mail in ${docRef.path}`);
      ok(!json.includes(PROFILE_ID), `no profile id in ${docRef.path}`);
      const jsonNoKey = JSON.stringify(Object.fromEntries(Object.entries(data).filter(([k]) => k !== allowHexField)));
      ok(!HEX.test(jsonNoKey), `no 64-hex string in ${docRef.path} outside ${allowHexField || 'the id'}`);
      for (const k of ['t', 'lastAt', 'joinedAt', 'editedAt', 'createdAt', 'guideAt', 'lastPostAt']) {
        if (typeof data[k] === 'number' && data[k] > 0) { stampsChecked++; ok(data[k] % 60000 === 0, `${docRef.path}.${k} is a whole minute`); }
      }
    }
    const subs = await docRef.listCollections();
    for (const c of subs) {
      const docs = await c.listDocuments();
      for (const d of docs) await walk(d, c.id === 'votes' ? '' : allowHexField);
    }
  }
  for (const [col, allow] of [['forumSeasons', ''], ['forumTags', ''], ['forumHandles', ''], ['forumNames', 'key']]) {
    for (const d of await admin.collection(col).listDocuments()) await walk(d, allow);
  }
  ok(walked > 12, `the walk really covered the forum (${walked} documents)`);
  ok(stampsChecked > 10, `and checked ${stampsChecked} stamps for the minute rule`);
  /* ids: forumHandles and votes ids are the hashes, and nothing else is */
  for (const d of await admin.collection('forumHandles').listDocuments()) ok(/^[0-9a-f]{64}$/.test(d.id), 'a forumHandles id is a 64-hex hash');
  const threads = await admin.collection(`forumSeasons/${Y}/rooms/candidates/threads`).listDocuments();
  for (const d of threads) ok(!/^[0-9a-f]{64}$/.test(d.id) && d.id.length === 20, `a thread id is a Firestore auto-id (${d.id})`);
  /* candidateMarkers carries a uid and a profile id BY DESIGN: walked for
     e-mail and hash only */
  for (const d of await admin.collection('candidateMarkers').listDocuments()) {
    const json = JSON.stringify((await d.get()).data());
    for (const e of emails) ok(!json.includes(e), 'no e-mail on a marker');
    ok(!HEX.test(json), 'no hash on a marker');
  }

  console.log(`\n${checks} checks, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
