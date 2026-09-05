/* ---------------------------------------------------------------------------
   forumJoin({}) -> { season, handle, guideAt, banned, rooms, rollsOn }

   Idempotent, and what the page calls once per session. A caller with no
   handle yet gets one drawn at random inside a transaction that claims its
   slug in forumNames (retried on a collision, up to CLAIM_TRIES); an account
   holding a current-season profile also gets its membership marker written
   (candidateMarkers/{uid}, the document the rules re-read to admit them to
   the candidates room). The maintainer is admitted to both rooms with no
   profile and gets an ordinary random handle like anyone else.

   `rooms` says which of the two the caller may enter, so the page draws the
   tabs from the function's answer rather than deciding for itself.
   --------------------------------------------------------------------------- */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const M = require('../forum-model.js');
const identity = require('./identity.js');
const P = require('./member.js');

const CLAIM_TRIES = 20;

class Collision extends Error {}

/** Draw a handle and claim it, inside one transaction; a taken or reserved
    slug is a collision and the caller draws again. */
async function claimHandle(D, ref, Y) {
  for (let attempt = 0; attempt < CLAIM_TRIES; attempt++) {
    try {
      return await D.runTransaction(async (tx) => {
        const have = await tx.get(ref);
        if (have.exists) return have.data();
        const handle = identity.drawHandle();
        const slug = M.slug(handle);
        if (identity.reserved(slug)) throw new Collision();
        const nameRef = D.collection('forumNames').doc(slug);
        const taken = await tx.get(nameRef);
        if (taken.exists) throw new Collision();
        const now = M.minute();
        /* @doc name */
        const name = {
          season: Y,
          key: ref.id,
        };
        /* @end */
        /* @doc handle */
        const doc = {
          season: Y,
          handle,
          joinedAt: now,
          guideAt: 0,
          status: 'ok',
          warnings: 0,
          day: M.today(now),
          dayThreads: 0,
          dayPosts: 0,
          dayVotes: 0,
          lastPostAt: 0,
        };
        /* @end */
        tx.set(nameRef, name);
        tx.set(ref, doc);
        return doc;
      });
    } catch (e) {
      if (!(e instanceof Collision)) throw e;
    }
  }
  throw new HttpsError('resource-exhausted', P.ERRORS.busy, { reason: 'busy' });
}

/** The membership marker, written when absent or pointing at another
    season's or another profile. */
async function writeMarker(D, uid, sub, Y) {
  const ref = D.collection('candidateMarkers').doc(uid);
  const snap = await ref.get();
  const have = snap.exists ? snap.data() : null;
  if (have && Number(have.year) === Number(Y) && have.sub === sub) return;
  /* @doc marker */
  const marker = {
    sub,
    year: Y,
    joinedAt: M.minute(),
  };
  /* @end */
  await ref.set(marker);
}

exports.forumJoin = onCall(P.OPTS, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.', { reason: 'auth' });
  const token = req.auth.token || {};
  const uid = req.auth.uid;
  const D = P.db();
  const Y = P.season();
  const admin = P.adminToken(token);
  const verified = P.verifiedToken(token);
  if (!verified && !admin) P.refuse('permission-denied', 'verified');

  const profile = await P.currentCandidate(D, uid, Y);
  const rooms = { candidates: admin || !!profile, open: verified || admin };

  const secret = await identity.secretForSeason(D, Y);
  const H = identity.hashFor(secret, Y, uid);
  const ref = D.collection('forumHandles').doc(H);
  let snap = await ref.get();
  let doc = snap.exists ? snap.data() : null;
  if (!doc) doc = await claimHandle(D, ref, Y);
  if (profile) await writeMarker(D, uid, profile.id, Y);

  return {
    season: Y,
    handle: doc.handle,
    guideAt: doc.guideAt || 0,
    banned: doc.status === 'banned',
    rooms,
    rollsOn: Y + '-07-01',
  };
});
