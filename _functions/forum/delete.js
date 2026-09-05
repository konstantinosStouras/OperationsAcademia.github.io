/* ---------------------------------------------------------------------------
   forumDelete({ room, tid, pid }) -> { ok: true, thread: boolean }

   Two people may delete a post: its AUTHOR, and the MAINTAINER.

   THE AUTHOR, at any time while the season is running (owner, 2026-09-05: "a
   user can delete a post anytime they want"). There is no window: forumEdit's
   fifteen minutes are about rewriting words other people may already have
   replied to, and taking your own words away is a different act with a
   different answer.

   BUT NOT A QUESTION SOMEBODY HAS ANSWERED (owner, same day: "a user cannot
   delete a question posted that has received at least one answer. If all
   answers are deleted, then the user who posted the respective question
   should be able to delete it"). The first build blanked such a question and
   left the thread standing, and the owner's screenshot of the result is the
   argument against it: a page headed "Deleted by its author" with no question
   under it and a reply hanging below reads as a broken thread, not a tidy
   one. So there are only two states now, and no third:

     no live reply     the whole thread goes, off every list
     a live reply      the question cannot be deleted at all

   "Live" is the point of the second sentence: a reply its own author (or the
   maintainer) has deleted no longer holds the question down, so a thread
   whose answers have all gone can be withdrawn by the person who asked it.
   The count is a query for posts that are not hidden, limited to two, since
   the only question being asked is whether ANY of them is a reply.

   THE MAINTAINER may delete any post in either room ("the admin should be
   able to delete any questions or answers"), and is not held by the rule
   above: deleting a question as moderation takes the thread with it, replies
   included, which is what removing a question means. `hiddenBy` says which
   of the two it was, so the page can say "deleted by its author" or "removed
   by the maintainer" rather than guessing.

   IT IS A TOMBSTONE, AND BOTH HALVES OF THAT ARE THE POINT. The words really
   go: `body` and `kind` are erased in the database, not merely flagged, or
   "delete" is a lie the page tells. The post's SLOT stays, because `n` is the
   post's name: replies quote by number (`#4`), the thread's `n` is the next
   number to hand out, and a hole in the sequence would renumber nothing and
   break both. So a deleted reply is drawn as removed and the thread reads on.

   A QUOTE OF IT SURVIVES, deliberately. `forumPost` stores a COPY of the
   quoted words on the reply, which is what already keeps an edit from
   rewriting somebody else's reply; the same rule means deleting your post
   does not blank the passage a reply was written about. The guide says the
   words are gone; it does not promise to reach into what other people wrote.

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
  const admin = P.adminToken(req.auth && req.auth.token ? req.auth.token : {});
  const { D, Y } = m;
  const threadRef = D.collection('forumSeasons').doc(String(Y)).collection('rooms').doc(d.room)
    .collection('threads').doc(String(d.tid || ''));
  const postsRef = threadRef.collection('posts');
  const postRef = postsRef.doc(String(d.pid || ''));
  /* whether ANY post that is not hidden is a reply: two is enough to know,
     since only one of them can be the question */
  const liveQuery = postsRef.where('hidden', '==', false).limit(2);
  let wholeThread = false;

  await P.run(D, async (tx) => {
    const th = await tx.get(threadRef);
    const ps = await tx.get(postRef);
    if (!th.exists || !ps.exists) P.refuse('not-found', 'thread');
    const tv = th.data();
    const pv = ps.data();
    if (Number(tv.season) !== Number(Y)) P.refuse('failed-precondition', 'archive');
    if (tv.hidden) P.refuse('failed-precondition', 'locked');
    if (!admin && pv.by !== m.handle) P.refuse('permission-denied', 'author');
    const isQuestion = Number(pv.n) === 1;
    /* Already gone. A second press is a SUCCESS rather than an error, and for
       a question there is one thing left to do: SHUT THE THREAD. Data written
       before the rule below existed carries a deleted question under a thread
       that still stands (owner's screenshot, 2026-09-05), and one press of
       Delete is what finishes it. */
    if (pv.hidden) {
      if (!isQuestion) return;
      wholeThread = true;
      /* @doc thread */
      const shutPatch = {
        hidden: true,
      };
      /* @end */
      tx.update(threadRef, shutPatch);
      return;
    }

    if (isQuestion) {
      if (!admin) {
        const live = await tx.get(liveQuery);
        const answered = live.docs.some((doc) => Number((doc.data() || {}).n) !== 1);
        if (answered) P.refuse('failed-precondition', 'answered');
      }
      wholeThread = true;
    }

    const now = M.minute();
    /* @doc post */
    const postPatch = {
      body: '',
      kind: '',
      hidden: true,
      hiddenBy: admin && pv.by !== m.handle ? 'admin' : 'author',
      editedAt: now,
    };
    /* @end */
    tx.update(postRef, postPatch);
    if (!isQuestion) return;
    /* @doc thread */
    const gonePatch = {
      hidden: true,
    };
    /* @end */
    tx.update(threadRef, gonePatch);
  });
  return { ok: true, thread: wholeThread };
});
