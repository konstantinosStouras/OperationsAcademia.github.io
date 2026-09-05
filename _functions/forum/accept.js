/* ---------------------------------------------------------------------------
   forumAccept({ room, tid, pid }) -> { accepted }

   The tick that says "this answered my question", and ONLY the member who
   asked it may put it there (owner, 2026-09-05: "a user who posts may tick an
   answer that they think answers their question"). `pid` empty clears it, a
   second answer moves it, and asking for the one already ticked changes
   nothing and says so, the way a repeated vote does.

   IT IS ONE FIELD ON ONE DOCUMENT. `accepted` lives on the THREAD and names
   the post; the post carries no flag of its own. That is what lets the list
   card mark an answered question from the row it already reads, and it is
   why the two can never disagree: there is nothing to keep in step.

   WHO, exactly: the handle on the thread head (`by`), which is the handle
   that asked. Not the maintainer, who is an ordinary member in both rooms
   and whose reading of somebody else's question is not moderation; not a
   member who happens to have answered. The refusal is `asker`.

   WHAT MAY BE TICKED: another post in the same thread, with words still in
   it. Never post 1, which is the question, and never a post its author has
   deleted, whose words are gone. Both answer `answer`.

   Refused on an ARCHIVED season (its handles cannot be re-derived once the
   secret version is destroyed, so "did this member ask it" has no answer
   there) and on a HIDDEN thread. A LOCKED thread is NOT refused, for
   forumDelete's reason: locking stops new posts, and saying which of the
   answers already written worked is not a new post. There is no rate limit
   and none is wanted: this writes one field on the caller's own thread and
   creates nothing, where the day counters exist to bound what a handle can
   ADD to the room.

   Its companion is in delete.js: an accepted answer whose author deletes it
   takes the tick with it, in the same transaction, or the thread would go on
   pointing at a tombstone.
   --------------------------------------------------------------------------- */

'use strict';

const { onCall } = require('firebase-functions/v2/https');
const P = require('./member.js');

exports.forumAccept = onCall(P.OPTS, async (req) => {
  const d = req.data || {};
  const m = await P.member(req, d.room);
  const { D, Y } = m;
  const threadRef = D.collection('forumSeasons').doc(String(Y)).collection('rooms').doc(d.room)
    .collection('threads').doc(String(d.tid || ''));
  const pid = String(d.pid || '');
  let out = '';

  await P.run(D, async (tx) => {
    const th = await tx.get(threadRef);
    if (!th.exists) P.refuse('not-found', 'thread');
    const tv = th.data();
    if (Number(tv.season) !== Number(Y)) P.refuse('failed-precondition', 'archive');
    if (tv.hidden) P.refuse('failed-precondition', 'locked');
    if (tv.by !== m.handle) P.refuse('permission-denied', 'asker');
    const was = String(tv.accepted || '');
    if (pid) {
      const ps = await tx.get(threadRef.collection('posts').doc(pid));
      if (!ps.exists) P.refuse('not-found', 'thread');
      const pv = ps.data();
      if (Number(pv.n) === 1 || pv.hidden) P.refuse('failed-precondition', 'answer');
    }
    out = pid;
    /* already where it is asked to be: a success that writes nothing */
    if (was === pid) return;
    /* @doc thread */
    const threadPatch = {
      accepted: pid,
    };
    /* @end */
    tx.update(threadRef, threadPatch);
  });
  return { accepted: out };
});
