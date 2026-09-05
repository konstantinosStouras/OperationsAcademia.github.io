/* ---------------------------------------------------------------------------
   forumModerate({ op: 'seedGuide' | 'pin' | 'lock', room, tid?, on? })
     -> { ok: true, tid? }

   The maintainer alone (adminToken, the mirror of isAdmin() in the rules);
   everyone else is refused with permission-denied {reason:'admin'}. Step 1
   ops only; the report ops arrive with the report queue.

   seedGuide renders the guide ITSELF (forum-guide.js, vendored) as the first
   post of a pinned, locked thread under the reserved handle `Moderator`, one
   per room per season, and stamps forumSeasons/{Y}.guides.{room}. It takes
   no body, so the panel on the page and the thread are one text and nobody
   can seed a body of their own. pin and lock flip one boolean on a thread.
   --------------------------------------------------------------------------- */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const M = require('../forum-model.js');
const guide = require('../forum-guide.js');
const identity = require('./identity.js');
const P = require('./member.js');

exports.forumModerate = onCall(P.OPTS, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.', { reason: 'auth' });
  if (!P.adminToken(req.auth.token || {})) P.refuse('permission-denied', 'admin');
  const d = req.data || {};
  const room = d.room;
  if (!M.isRoom(room)) P.refuse('invalid-argument', 'room');
  const D = P.db();
  const Y = P.season();
  const seasonRef = D.collection('forumSeasons').doc(String(Y));
  const roomRef = seasonRef.collection('rooms').doc(room);

  if (d.op === 'seedGuide') {
    const head = await identity.ensureSeason(D, Y);
    if (head.guides && head.guides[room]) {
      throw new HttpsError('already-exists', 'This room already has its guide thread.', { reason: 'guide' });
    }
    const threadRef = roomRef.collection('threads').doc();
    const postRef = threadRef.collection('posts').doc();
    const tRef = D.collection('forumTags').doc(Y + '_' + room);
    const body = guide.text();
    await P.run(D, async (tx) => {
      const again = await tx.get(seasonRef);
      const gv = (again.exists && again.data().guides) || {};
      if (gv[room]) throw new HttpsError('already-exists', 'This room already has its guide thread.', { reason: 'guide' });
      const now = M.minute();
      /* @doc thread */
      const thread = {
        season: Y,
        room,
        title: guide.TITLE,
        tags: ['about'],
        by: M.MODERATOR,
        t: now,
        lastAt: now,
        lastBy: M.MODERATOR,
        n: 1,
        excerpt: P.excerptOf(body),
        score: 0,
        accepted: '',
        pinned: true,
        locked: true,
        hidden: false,
      };
      /* @end */
      /* @doc post */
      const post = {
        season: Y,
        room,
        tid: threadRef.id,
        n: 1,
        by: M.MODERATOR,
        body,
        kind: '',
        t: now,
        up: 0,
        down: 0,
        hidden: false,
        hiddenBy: '',
      };
      /* @end */
      /* @doc season */
      const seasonPatch = {
        guides: { [room]: threadRef.id },
      };
      /* @end */
      /* @doc tags */
      const tagsPatch = {
        counts: { about: FieldValue.increment(1) },
      };
      /* @end */
      tx.set(threadRef, thread);
      tx.set(postRef, post);
      tx.set(seasonRef, seasonPatch, { merge: true });
      tx.set(tRef, tagsPatch, { merge: true });
    });
    return { ok: true, tid: threadRef.id };
  }

  if (d.op === 'pin' || d.op === 'lock') {
    const threadRef = roomRef.collection('threads').doc(String(d.tid || ''));
    const on = d.on === true;
    await P.run(D, async (tx) => {
      const th = await tx.get(threadRef);
      if (!th.exists) throw new HttpsError('not-found', 'No such thread.', { reason: 'thread' });
      if (d.op === 'pin') {
        /* @doc thread */
        const pinPatch = {
          pinned: on,
        };
        /* @end */
        tx.update(threadRef, pinPatch);
      } else {
        /* @doc thread */
        const lockPatch = {
          locked: on,
        };
        /* @end */
        tx.update(threadRef, lockPatch);
      }
    });
    return { ok: true, tid: threadRef.id };
  }

  P.refuse('invalid-argument', 'bounds');
  return { ok: false };
});
