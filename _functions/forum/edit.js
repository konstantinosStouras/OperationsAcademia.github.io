/* ---------------------------------------------------------------------------
   forumEdit({ room, tid, pid, body }) -> { editedAt }

   The author's own post, at ANY time while the season is running (owner,
   2026-09-06: "the user can delete and edit the post any time"). There used
   to be a fifteen-minute window here, drawn as a countdown on the page; it
   is gone from the model as well as from this file, so nothing measures
   against it. The body changes, editedAt is stamped, and the first post's
   edit recomputes the thread's excerpt. Tags are fixed at creation and are
   not touched here, so the room tally never drifts. What still refuses an
   edit: somebody else's post, a deleted one, a locked or hidden thread, and
   an archived season.
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
    editedAt = M.minute();
    /* @doc post */
    const postPatch = {
      body,
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
