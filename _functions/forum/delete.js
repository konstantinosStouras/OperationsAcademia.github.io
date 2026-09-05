/* ---------------------------------------------------------------------------
   forumDelete({ room, tid, pid }) -> { ok: true, thread: boolean }

   The AUTHOR's own post, at any time while the season is running (owner,
   2026-09-05: "a user can delete a post anytime they want"). There is no
   window: forumEdit's fifteen minutes are about rewriting words other people
   may already have replied to, and taking your own words away is a different
   act with a different answer.

   IT IS A TOMBSTONE, AND BOTH HALVES OF THAT ARE THE POINT. The words really
   go: `body` and `kind` are erased in the database, not merely flagged, or
   "delete" would be a lie the page told on the maintainer's behalf. The
   post's SLOT stays, because `n` is the post's name: replies quote by number
   (`#4`), the thread's `n` is the next number to hand out, and a hole in the
   sequence would renumber nothing and break both. So the row is drawn as
   removed and the thread still reads.

   A QUOTE OF IT SURVIVES, deliberately. `forumPost` stores a COPY of the
   quoted words on the reply, which is what already keeps an edit from
   rewriting somebody else's reply; the same rule means deleting your post
   does not blank the passage a reply was written about. The guide says the
   words are gone; it does not promise to reach into what other people wrote.

   THE FIRST POST IS THE THREAD, up to a point:

     no replies yet   the whole thread is hidden, off every list. The title
                      and the question were the author's words too.
     replies exist    the opening post is blanked and the TITLE is replaced,
                      but the thread stands. Other members wrote those
                      replies, and one person changing their mind must not
                      take a dozen other people's words down with it.

   Refused on a HIDDEN thread (moderation has already removed it, so there is
   nothing here to act on) and on any season but the one under way: an
   archived season's handles cannot be re-derived once its secret version is
   destroyed, so "the author" is not a question that can be answered there.
   A LOCKED thread is not refused: locking stops new posts, it does not make
   somebody's own words un-deletable.
   --------------------------------------------------------------------------- */

'use strict';

const { onCall } = require('firebase-functions/v2/https');
const M = require('../forum-model.js');
const P = require('./member.js');

exports.forumDelete = onCall(P.OPTS, async (req) => {
  const d = req.data || {};
  const m = await P.member(req, d.room);
  const { D, Y } = m;
  const threadRef = D.collection('forumSeasons').doc(String(Y)).collection('rooms').doc(d.room)
    .collection('threads').doc(String(d.tid || ''));
  const postRef = threadRef.collection('posts').doc(String(d.pid || ''));
  let wholeThread = false;

  await P.run(D, async (tx) => {
    const th = await tx.get(threadRef);
    const ps = await tx.get(postRef);
    if (!th.exists || !ps.exists) P.refuse('not-found', 'thread');
    const tv = th.data();
    const pv = ps.data();
    if (Number(tv.season) !== Number(Y)) P.refuse('failed-precondition', 'archive');
    if (tv.hidden) P.refuse('failed-precondition', 'locked');
    if (pv.by !== m.handle) P.refuse('permission-denied', 'author');
    /* already gone: say so as a success, so a double press is not an error */
    if (pv.hidden) return;
    const now = M.minute();
    /* @doc post */
    const postPatch = {
      body: '',
      kind: '',
      hidden: true,
      hiddenBy: 'author',
      editedAt: now,
    };
    /* @end */
    tx.update(postRef, postPatch);
    if (Number(pv.n) !== 1) return;
    /* the opening post: the thread goes with it only if nobody has replied */
    if (Number(tv.n) <= 1) {
      wholeThread = true;
      /* @doc thread */
      const gonePatch = {
        hidden: true,
      };
      /* @end */
      tx.update(threadRef, gonePatch);
    } else {
      /* @doc thread */
      const titlePatch = {
        title: M.DELETED_TITLE,
        excerpt: '',
      };
      /* @end */
      tx.update(threadRef, titlePatch);
    }
  });
  return { ok: true, thread: wholeThread };
});
