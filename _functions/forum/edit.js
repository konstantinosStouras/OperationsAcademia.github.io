/* ---------------------------------------------------------------------------
   forumEdit({ room, tid, pid, body, kind }) -> { editedAt }

   The author's own post, within EDIT_WINDOW_MS of the MINUTE it was stamped
   (so up to 59 seconds more than fifteen minutes; the function is the
   authority, the page only draws the countdown). Body and kind change,
   editedAt is stamped, and the first post's edit recomputes the thread's
   excerpt. Tags are fixed at creation and are not touched here, so the room
   tally never drifts.
   --------------------------------------------------------------------------- */

'use strict';

const { onCall } = require('firebase-functions/v2/https');
const M = require('../forum-model.js');
const P = require('./member.js');

exports.forumEdit = onCall(P.OPTS, async (req) => {
  const d = req.data || {};
  const m = await P.member(req, d.room);
  const { D, Y } = m;
  const body = P.textField(d.body, M.BOUNDS.body, true);
  const kind = P.kindField(d.kind);
  const threadRef = D.collection('forumSeasons').doc(String(Y)).collection('rooms').doc(d.room)
    .collection('threads').doc(String(d.tid || ''));
  const postRef = threadRef.collection('posts').doc(String(d.pid || ''));
  let editedAt = 0;

  await P.run(D, async (tx) => {
    const th = await tx.get(threadRef);
    const ps = await tx.get(postRef);
    if (!th.exists || !ps.exists) P.refuse('not-found', 'thread');
    const tv = th.data();
    const pv = ps.data();
    if (Number(tv.season) !== Number(Y)) P.refuse('failed-precondition', 'archive');
    if (tv.locked || tv.hidden || pv.hidden) P.refuse('failed-precondition', 'locked');
    if (pv.by !== m.handle) P.refuse('permission-denied', 'author');
    const now = M.minute();
    if (now >= Number(pv.t) + M.EDIT_WINDOW_MS) P.refuse('failed-precondition', 'window');
    editedAt = now;
    /* @doc post */
    const postPatch = {
      body,
      kind,
      editedAt,
    };
    /* @end */
    tx.update(postRef, postPatch);
    if (Number(pv.n) === 1) {
      /* @doc thread */
      const threadPatch = {
        excerpt: P.excerptOf(body),
      };
      /* @end */
      tx.update(threadRef, threadPatch);
    }
  });
  return { editedAt };
});
