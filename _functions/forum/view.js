/* ---------------------------------------------------------------------------
   forumView({ room, tid }) -> { views }

   One more reader has opened the thread (owner, 2026-09-08: "add views per
   question thread, similar to Stackexchange"). The thread's `views` moves by
   one with FieldValue.increment, and NOTHING ELSE is written: no document
   under the thread, no key on the handle, no stamp. A view count is the one
   forum figure that would be a record of WHO READS WHAT if it were kept per
   member, and this forum is built so that nothing records that; so the
   dedupe lives in the browser instead (assets/oa-forum.js, `countView`: one
   count per thread per device per UTC day, in the same local store as the
   seen-marks), and the server keeps a number. That also means the number is
   a convenience rather than a fact anyone should act on, which is why no
   rate counter is spent on it: the handle document is not touched, so this
   is the one callable that leaves the day's counters exactly as it found
   them.

   The preamble runs whole, so only an admitted member of the room counts,
   and only for the season under way (an archive keeps the count it had at
   the roll). A hidden thread is refused with `locked`, the reason forumVote
   already answers for one; a thread the room does not hold with `thread`.
   --------------------------------------------------------------------------- */

'use strict';

const { onCall } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const P = require('./member.js');

exports.forumView = onCall(P.OPTS, async (req) => {
  const d = req.data || {};
  const m = await P.member(req, d.room);
  const { D, Y } = m;
  const threadRef = D.collection('forumSeasons').doc(String(Y)).collection('rooms').doc(d.room)
    .collection('threads').doc(String(d.tid || ''));
  let views = 0;
  await P.run(D, async (tx) => {
    const th = await tx.get(threadRef);
    if (!th.exists) P.refuse('not-found', 'thread');
    const tv = th.data();
    if (tv.hidden) P.refuse('failed-precondition', 'locked');
    views = (Number(tv.views) || 0) + 1;
    /* @doc thread */
    const viewPatch = {
      views: FieldValue.increment(1),
    };
    /* @end */
    tx.update(threadRef, viewPatch);
  });
  return { views };
});
