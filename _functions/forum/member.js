/* ---------------------------------------------------------------------------
   The shared preamble every forum callable runs: who is calling, which room,
   whether they may be in it, which handle is theirs, and the limits.

   WHO MAY ENTER. The open room takes any sign-in the rules call verified():
   an e-mail address that has been confirmed, or a provider other than the
   password one (Google confirms the address itself; ORCID carries none).
   The candidates room takes an account holding a candidate profile for the
   season under way (queued or published, re-read on every call, so a
   withdrawal ends access at once) or the maintainer, who enters both rooms
   as an ordinary member (owner, 2026-09-05: "the admin should be able to have
   access to all forums"). ADMIN below is the one literal shared with
   isAdmin() in _firestore.rules; the selftest pins the two together.

   ONE REFUSAL FOR TWO CAUSES. The candidates room answers permission-denied
   {reason:'candidate'} whether the caller is unverified or simply holds no
   profile, so a caller learns nothing about the profile database from the
   error; only the open room names 'verified'. Every reason string lives in
   ERRORS, and a refusal's details carry the reason and NOTHING else: never a
   count, never another member's anything.

   RATE LIMITS are per handle per UTC day (RATE in forum-model.js) plus a gap
   between posts, counted on the handle document inside the same transaction
   as the write they guard.
   --------------------------------------------------------------------------- */

'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const NAV = require('../jobnav.js');
const M = require('../forum-model.js');
const guard = require('../forum-guard.js');
const identity = require('./identity.js');

/** The maintainer's address. Keep in sync with isAdmin() in _firestore.rules. */
const ADMIN = 'kstouras@gmail.com';

const FORUM_SECRET = defineSecret('FORUM_SECRET');

/** The options every forum callable is declared with. */
const OPTS = {
  region: 'us-central1',
  enforceAppCheck: false,
  secrets: [FORUM_SECRET],
  maxInstances: 10,
  timeoutSeconds: 30,
};

/** Every reason a forum callable can refuse with, and the sentence the page
    may show for it. The details object carries `reason` and only `reason`. */
const ERRORS = {
  room: 'That room does not exist.',
  verified: 'Confirm your e-mail address to use the forum.',
  candidate: 'The Candidates\' room opens to accounts holding a candidate profile for the season under way.',
  banned: 'This handle is banned for the season.',
  join: 'Join the forum first.',
  admin: 'Only the maintainer may do that.',
  guide: 'Accept the forum guide before your first post.',
  locked: 'This thread is locked.',
  thread: 'No such thread or post.',
  archive: 'This season is an archive and is read-only.',
  author: 'Only the author may change their own post.',
  answered: 'A question that has been answered cannot be deleted.',
  window: 'The fifteen-minute edit window has closed. You can still delete the post.',
  own: 'You cannot vote on your own post.',
  busy: 'The forum is busy. Try again in a moment.',
  bounds: 'That is too long, or empty.',
  tags: 'Choose one to five tags of letters, digits and hyphens.',
  quote: 'The quote must be a passage of the post it names, as it stands now.',
  threads: 'That is enough new threads for today.',
  posts: 'That is enough posts for today.',
  votes: 'That is enough votes for today.',
  gap: 'Wait a little between posts.',
  email: guard.WHY.email,
  phone: guard.WHY.phone,
  orcid: guard.WHY.orcid,
};

function refuse(code, reason) {
  throw new HttpsError(code, ERRORS[reason] || 'Refused.', { reason });
}

function db() {
  /* By NAME, never by count: the functions library holds a named app of its
     own for token verification, so getApps() is non-empty inside every
     callable while the default app may still be missing (the
     sendVerificationEmail outage of 2026-09-05; see adminApp in index.js). */
  if (!getApps().some((a) => a.name === '[DEFAULT]')) initializeApp();
  return getFirestore();
}

/** The season under way, the site's one roll rule (jobnav.js, vendored). */
function season() {
  return NAV.marketYear();
}

/** Mirrors verified() in _firestore.rules, both halves. */
function verifiedToken(token) {
  const t = token || {};
  return t.email_verified === true
    || (!!t.firebase && typeof t.firebase.sign_in_provider === 'string'
        && t.firebase.sign_in_provider !== 'password');
}

/** Mirrors isAdmin() in _firestore.rules. */
function adminToken(token) {
  const t = token || {};
  return t.email === ADMIN && t.email_verified === true;
}

/** The caller's current-season profile, or null: `{ id, data }`, the newest
    `createdAt` where several exist (the candidate form's own one-profile
    reading). */
async function currentCandidate(D, uid, Y) {
  const snap = await D.collection('candidateSubmissions').where('uid', '==', uid).get();
  let best = null;
  snap.forEach((d) => {
    const v = d.data() || {};
    if (Number(v.year) !== Number(Y)) return;
    if (v.status !== 'queued' && v.status !== 'published') return;
    const at = v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : Number(v.createdAt) || 0;
    if (!best || at > best.at) best = { id: d.id, data: v, at };
  });
  return best;
}

/** Whether this token may enter this room; throws the room's one refusal. */
async function admitted(D, token, uid, room, Y) {
  const admin = adminToken(token);
  if (room === 'open') {
    if (!verifiedToken(token)) refuse('permission-denied', 'verified');
    return { admin, profile: null };
  }
  /* candidates: the maintainer, or a verified account with a current profile.
     Both misses answer the same way. */
  if (admin) return { admin, profile: null };
  if (!verifiedToken(token)) refuse('permission-denied', 'candidate');
  const profile = await currentCandidate(D, uid, Y);
  if (!profile) refuse('permission-denied', 'candidate');
  return { admin, profile };
}

/**
 * The preamble. Returns everything a writer needs: the caller's uid, their
 * season hash H, their handle document (reference and data), the season and
 * the database handle.
 */
async function member(req, room) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.', { reason: 'auth' });
  if (!M.isRoom(room)) refuse('invalid-argument', 'room');
  const D = db();
  const Y = season();
  const uid = req.auth.uid;
  const token = req.auth.token || {};
  const who = await admitted(D, token, uid, room, Y);
  const secret = await identity.secretForSeason(D, Y);
  const H = identity.hashFor(secret, Y, uid);
  const ref = D.collection('forumHandles').doc(H);
  const snap = await ref.get();
  if (!snap.exists) refuse('failed-precondition', 'join');
  const doc = snap.data();
  if (doc.status === 'banned') refuse('permission-denied', 'banned');
  return { uid, H, ref, doc, handle: doc.handle, isAdmin: who.admin, Y, D };
}

/** The handle's counters, reset when the UTC day has moved on. */
function counters(doc, now) {
  const day = M.today(now);
  const same = doc && doc.day === day;
  return {
    day,
    dayThreads: same ? Number(doc.dayThreads) || 0 : 0,
    dayPosts: same ? Number(doc.dayPosts) || 0 : 0,
    dayVotes: same ? Number(doc.dayVotes) || 0 : 0,
    lastPostAt: Number(doc && doc.lastPostAt) || 0,
  };
}

/** Refuse when one more of `counter` would pass its limit. Carries the
    counter's name and never a number. */
function checkLimit(c, counter, limit) {
  if (c[counter] + 1 > limit) refuse('resource-exhausted', counter.replace(/^day/, '').toLowerCase());
}

function checkGap(c, now) {
  if (c.lastPostAt && now - c.lastPostAt < M.RATE.gapMs) refuse('resource-exhausted', 'gap');
}

/** A text field, bounded and guarded. `required` refuses an empty value. */
function textField(v, max, required) {
  const s = typeof v === 'string' ? v.trim() : '';
  if ((required && !s) || s.length > max) refuse('invalid-argument', 'bounds');
  const hit = guard.check(s);
  if (hit) refuse('invalid-argument', hit);
  return s;
}

/** The first BOUNDS.excerpt characters of a body, cut at a word. */
function excerptOf(body) {
  const s = String(body || '').replace(/\s+/g, ' ').trim();
  if (s.length <= M.BOUNDS.excerpt) return s;
  const cut = s.slice(0, M.BOUNDS.excerpt);
  const at = cut.lastIndexOf(' ');
  return (at > M.BOUNDS.excerpt / 2 ? cut.slice(0, at) : cut).trim();
}

/** Run a transaction, mapping Firestore's contention failure onto the one
    refusal the page can word ("try again in a moment"). */
async function run(D, fn) {
  try {
    return await D.runTransaction(fn);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    const code = e && (e.code === 10 || e.code === 'aborted' || /ABORTED|contention/i.test(String(e.message)));
    if (code) refuse('resource-exhausted', 'busy');
    throw e;
  }
}

module.exports = {
  ADMIN, OPTS, ERRORS, FORUM_SECRET,
  refuse, db, season, verifiedToken, adminToken, currentCandidate, admitted, member,
  counters, checkLimit, checkGap, textField, excerptOf, run,
};
