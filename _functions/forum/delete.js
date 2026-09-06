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
   go: `body` is erased in the database, not merely flagged, or "delete" is a
   lie the page tells. The post's SLOT stays, because `n` is the post's name:
   replies quote by number (`#4`), the thread's `n` is the next number to hand
   out, and a hole in the sequence would renumber nothing and break both. So a
   deleted reply is drawn as removed and the thread reads on.

   A QUOTE OF IT SURVIVES, deliberately. `forumPost` stores a COPY of the
   quoted words on the reply, which is what already keeps an edit from
   rewriting somebody else's reply; the same rule means deleting your post
   does not blank the passage a reply was written about. The guide says the
   words are gone; it does not promise to reach into what other people wrote.

   AN ACCEPTED ANSWER TAKES THE TICK WITH IT. `accepted` on the thread names
   the post the asker ticked, so deleting that answer must clear it in the
   same transaction: a tick left pointing at a tombstone tells every reader,
   and every card in the list, that a question with no answer left in it has
   been answered. forumAccept is the other half.

   Refused on a HIDDEN thread (moderation has already removed it, so there is
   nothing here to act on) and on any season but the one under way: an
   archived season's handles cannot be re-derived once its secret version is
   destroyed, so "the author" is not a question that can be answered there.
   A LOCKED thread is not refused: locking stops new posts, it does not make
   somebody's own words un-deletable.

   WHEN THE THREAD GOES, TWO MORE THINGS GO WITH IT.

   THE WORDS ON THE THREAD HEAD. Erasing the post's `body` is not the whole
   of "the words really go" while `title` and `excerpt` sit beside it, and
   `excerpt` is a VERBATIM COPY of the body that was just erased. They are
   not private by being hidden either: the rules let any admitted member
   read this collection, so a `where('hidden','==',true)` query hands back
   every deleted question's title and its first 200 words, and the page's
   own list downloads all 200 threads and drops the hidden ones in the
   browser. Rule 13 of the guide promises "the words are then gone for
   good", so they are cleared here. The thread keeps its tags, its handle
   and its stamps, which is what the maintainer's removal tool reads.

   AND THE ANSWERS' OWN WORDS. The paragraph above argues that hiding is not
   erasing, because the rules let any admitted member read this collection --
   and that argument was applied to the thread head alone while every ANSWER
   under a removed question kept its body, `hidden: false`, one direct query
   away. "Deleting a question as moderation takes the thread with it, replies
   included" was true of what the page DRAWS and false of what the database
   HOLDS, which is the same lie the tombstone paragraph refuses one screen up.
   Their authors could not put it right either: a post under a hidden thread
   is refused with `locked`, so an answer to a question the maintainer removed
   was the one post on this forum its own author could never delete. So the
   thread taking its replies with it is what closing one now does. It is
   bounded at SWEEP_MAX for the write cap a transaction has; a thread bigger
   than that is refused with `big` and is the removal script's job, which is
   what that script is for and where it has no cap.

   THE ROOM'S GUIDE IS REFUSED OUTRIGHT, the one thread that is not the
   maintainer's to remove. `forumSeasons/{Y}.guides.{room}` names it and never
   clears, so a removed guide is a room that can never have one again: the
   panel's button reads "Update the guide" and takes the refresh branch, which
   writes the words back into a thread that is still hidden and invisible.
   _scraper/remove-forum-thread.mjs refuses it for exactly this reason; the
   maintainer's own Remove button had no such rule, and one press was all it
   took.

   THE TAG TALLY. `forumTags/{Y}_{room}` is an increment tally and the one
   thing here that cannot be recomputed from what is stored, so a thread
   that goes without giving its tags back leaves the Popular tags card
   counting questions nobody can open, the compose picker suggesting them,
   and a chip whose press yields an empty list. It is given back BY VALUE
   and floored at zero, never with increment(-1): a tag past
   TAG_COUNT_CAP was never counted and has nothing to give back, and the
   panel must never print a negative. That is the rule
   _scraper/remove-forum-thread.mjs was written around; this is the same
   rule, applied where the thread actually goes.
   --------------------------------------------------------------------------- */

'use strict';

const { onCall } = require('firebase-functions/v2/https');
const M = require('../forum-model.js');
const P = require('./member.js');

/** How many posts a closing thread may erase in its one transaction.
    Firestore caps a transaction at 500 writes and the thread head, the tally
    and the question itself take three of them; 400 leaves room to spare. A
    thread past it is refused rather than half-erased -- a partial sweep is
    the "merely flagged" answer wearing a success, and the maintainer's own
    removal script has no cap. */
const SWEEP_MAX = 400;

/** The tags a thread carried, given back to the room's tally by value and
    floored at zero. Answers null when there is nothing to give back, and
    the caller must then write nothing: an empty map handed to
    set({ merge: true }) REPLACES `counts` rather than leaving it alone
    (see the trap recorded in post.js). */
function tallyBack(existing, tags) {
  const counts = (existing && existing.counts) || {};
  const back = {};
  let any = false;
  for (const t of (Array.isArray(tags) ? tags : [])) {
    if (!Object.prototype.hasOwnProperty.call(counts, String(t))) continue;
    back[String(t)] = Math.max(0, (Number(counts[String(t)]) || 0) - 1);
    any = true;
  }
  return any ? back : null;
}

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
  /* every post whose words are still there, for the sweep a closing thread
     does; one more than the cap, so "there are too many" is answerable */
  const sweepQuery = postsRef.where('hidden', '==', false).limit(SWEEP_MAX + 1);
  const tagsRef = D.collection('forumTags').doc(Y + '_' + d.room);
  const seasonRef = D.collection('forumSeasons').doc(String(Y));
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
    /* EVERY READ BEFORE THE FIRST WRITE. Firestore refuses a transaction
       that reads after it has written, and both branches below write. The
       tally, the season head and the sweep are only needed when the thread
       is going, which is exactly when the post under the cursor is the
       question. */
    const tally = isQuestion ? await tx.get(tagsRef) : null;
    const head = isQuestion ? await tx.get(seasonRef) : null;
    if (isQuestion) {
      /* THE ROOM'S GUIDE IS NOT REMOVABLE. Its id is stamped on the season
         and never cleared, so the seed button takes the refresh branch for
         ever after and writes the words back into a hidden thread. One press
         would cost the room its guide for the season with no route back --
         the rule _scraper/remove-forum-thread.mjs already refuses on. */
      const guides = (head && head.exists && head.data().guides) || {};
      if (String(guides[d.room] || '') === threadRef.id) {
        /* `guidethread`, not `guide`: that word is already taken by "tick the
           box to say you have read the guide", which is nonsense addressed to
           somebody pressing Remove. One reason word, one sentence. */
        P.refuse('failed-precondition', 'guidethread');
      }
    }
    /* THE SWEEP IS THE MAINTAINER'S, and only theirs. "The admin may delete
       any post" is the authority that erases somebody else's words; an author
       has authority over their own alone. A fresh question with a live answer
       is already refused to its author, and one with none has nothing to
       sweep -- but a LEGACY headless thread (a question blanked before the
       rule below existed) can still be closed by its asker with other
       people's answers standing under it, and erasing those would be this
       forum's one way to take another member's words away. The maintainer
       finishes those. */
    const sweep = isQuestion && admin ? await tx.get(sweepQuery) : null;
    if (sweep && sweep.size > SWEEP_MAX) P.refuse('failed-precondition', 'big');
    /* A QUESTION IS REFUSED TO ITS ASKER WHILE ANY REPLY STILL STANDS, and
       the maintainer is not held by it. ONE check for both roads below: the
       fresh delete, and the second press that shuts a legacy headless thread.
       The second road used to skip it, and that was the hole: an asker could
       CLOSE such a thread over other people's live answers, the sweep above
       is the maintainer's alone so nothing erased them, and `tv.hidden` then
       refused everyone on the thread, the maintainer included -- the answers
       stayed readable to any admitted member for ever and deletable by
       nobody, which is the defect the sweep was written to remove. Refusing
       the asker keeps the thread open, so the answers' own authors can still
       take their words back and the maintainer's Remove still sweeps. */
    const refuseIfAnswered = async () => {
      if (admin) return;
      const live = await tx.get(liveQuery);
      const answered = live.docs.some((doc) => Number((doc.data() || {}).n) !== 1);
      if (answered) P.refuse('failed-precondition', 'answered');
    };

    /** What a thread that is going leaves behind: no words, and its tags
        handed back to the room. */
    const closeThread = () => {
      /* @doc thread */
      const gonePatch = {
        hidden: true,
        title: '',
        excerpt: '',
      };
      /* @end */
      tx.update(threadRef, gonePatch);
      /* THE REPLIES GO WITH IT, in the database and not only on the page.
         The question itself is erased by the patch below, so it is skipped
         here rather than written twice. */
      for (const doc of (sweep ? sweep.docs : [])) {
        if (doc.id === postRef.id) continue;
        /* @doc post */
        const sweptPatch = {
          body: '',
          hidden: true,
          hiddenBy: 'admin',
          editedAt: M.minute(),
        };
        /* @end */
        tx.update(doc.ref, sweptPatch);
      }
      const back = tallyBack(tally && tally.exists ? tally.data() : null, tv.tags);
      /* @doc tags */
      const tagsPatch = {
        counts: back,
      };
      /* @end */
      if (back) tx.set(tagsRef, tagsPatch, { merge: true });
    };

    /* Already gone. A second press is a SUCCESS rather than an error, and for
       a question there is one thing left to do: SHUT THE THREAD. Data written
       before the rule below existed carries a deleted question under a thread
       that still stands (owner's screenshot, 2026-09-05), and one press of
       Delete is what finishes it. */
    if (pv.hidden) {
      if (!isQuestion) return;
      await refuseIfAnswered();
      wholeThread = true;
      closeThread();
      return;
    }

    if (isQuestion) {
      await refuseIfAnswered();
      wholeThread = true;
    }

    const now = M.minute();
    /* @doc post */
    const postPatch = {
      body: '',
      hidden: true,
      hiddenBy: admin && pv.by !== m.handle ? 'admin' : 'author',
      editedAt: now,
    };
    /* @end */
    tx.update(postRef, postPatch);
    if (String(tv.accepted || '') === postRef.id) {
      /* @doc thread */
      const untick = {
        accepted: '',
      };
      /* @end */
      tx.update(threadRef, untick);
    }
    if (!isQuestion) return;
    closeThread();
  });
  return { ok: true, thread: wholeThread };
});
