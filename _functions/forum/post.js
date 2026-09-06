/* ---------------------------------------------------------------------------
   forumPost({ room, tid?, title?, tags?, body, quote?, acceptGuide? })
     -> { tid, pid, n }

   No `tid` opens a NEW THREAD: title, one to five tags, the first post
   (n: 1) and the room's tag tally, in one transaction. With `tid` it is a
   REPLY: n = thread.n + 1, the thread's lastAt/lastBy move, and an optional
   quote is verified against post n's body AS IT STANDS NOW and stored as a
   COPY {n, by, text} (null on a reply that quotes nothing), so a later edit
   or removal of the original never rewrites the reply. Thread and post ids are Firestore auto-ids.

   forumPost({ room, warm: true }) -> { warm: true }

   A WARM-UP, and nothing else. A callable is a Cloud Run service that goes
   cold after a few idle minutes, and this forum is quiet enough that most
   posts would otherwise land on a cold one: two to five seconds of module
   loading and a Secret Manager read before the post is even looked at. The
   page sends this the moment a reader starts writing, so the instance, its
   modules and the season's secret are ready by the time they press Post. It
   runs the whole preamble (who is calling, which room, which handle), then
   answers without reading or writing anything else; a refused caller is
   refused exactly as a post would be. Before this branch was deployed the
   same call was refused for its empty body, which warmed the instance just
   the same, so the page ignores whatever the answer is.

   The first post a member ever makes needs acceptGuide: true, which stamps
   guideAt on the handle. Every text goes through the guard; every write is
   refused on a locked or hidden thread, on a thread whose QUESTION has been
   deleted (which is closed, however the thread head reads), and on any season
   but the one under way. Rate limits: 3 threads and 40 posts per handle per
   UTC day, 20 s between posts.

   // step 2: ring('oa-forum-posted', {}) after a successful write, for the
   // follow digests; the payload stays empty by design.
   --------------------------------------------------------------------------- */

'use strict';

const { onCall } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const M = require('../forum-model.js');
const P = require('./member.js');

/** The tags as sent, each through slug(), duplicates dropped, then judged. */
function tagList(v) {
  const raw = Array.isArray(v) ? v : [];
  const out = [];
  for (const t of raw) {
    const s = M.slug(t);
    if (s && out.indexOf(s) === -1) out.push(s);
  }
  if (!M.tagsOk(out)) P.refuse('invalid-argument', 'tags');
  return out;
}

/** The tally patch for a room: every tag already counted, plus new ones
    while the document is under TAG_COUNT_CAP distinct slugs. */
function tallyPatch(existing, tags) {
  const counts = (existing && existing.counts) || {};
  let size = Object.keys(counts).length;
  const inc = {};
  for (const t of tags) {
    if (Object.prototype.hasOwnProperty.call(counts, t)) inc[t] = FieldValue.increment(1);
    else if (size < M.TAG_COUNT_CAP) { inc[t] = FieldValue.increment(1); size++; }
  }
  return inc;
}

function tagsRef(D, Y, room) {
  return D.collection('forumTags').doc(Y + '_' + room);
}

exports.forumPost = onCall(P.OPTS, async (req) => {
  const d = req.data || {};
  const room = d.room;
  const m = await P.member(req, room);
  if (d.warm === true) return { warm: true };
  const { D, Y } = m;
  const body = P.textField(d.body, M.BOUNDS.body, true);
  const accept = d.acceptGuide === true;
  const roomRef = D.collection('forumSeasons').doc(String(Y)).collection('rooms').doc(room);

  if (!d.tid) {
    /* ------------------------------------------------------ a new thread */
    const title = P.textField(d.title, M.BOUNDS.title, true);
    const tags = tagList(d.tags);
    const threadRef = roomRef.collection('threads').doc();
    const postRef = threadRef.collection('posts').doc();
    const tRef = tagsRef(D, Y, room);

    await P.run(D, async (tx) => {
      const hd = await tx.get(m.ref);
      const hv = hd.data() || {};
      const tally = await tx.get(tRef);
      if (!hv.guideAt && !accept) P.refuse('failed-precondition', 'guide');
      const now = M.minute();
      const c = P.counters(hv, now);
      P.checkLimit(c, 'dayThreads', M.RATE.threads);
      P.checkLimit(c, 'dayPosts', M.RATE.posts);
      P.checkGap(c, now);

      /* @doc thread */
      const thread = {
        season: Y,
        room,
        title,
        tags,
        by: m.handle,
        t: now,
        lastAt: now,
        lastBy: m.handle,
        n: 1,
        excerpt: P.excerptOf(body),
        score: 0,
        accepted: '',
        pinned: false,
        locked: false,
        hidden: false,
      };
      /* @end */
      /* @doc post */
      const post = {
        season: Y,
        room,
        tid: threadRef.id,
        n: 1,
        by: m.handle,
        body,
        t: now,
        up: 0,
        down: 0,
        hidden: false,
        hiddenBy: '',
      };
      /* @end */
      /* @doc handle */
      const handlePatch = {
        day: c.day,
        dayThreads: c.dayThreads + 1,
        dayPosts: c.dayPosts + 1,
        lastPostAt: now,
        guideAt: hv.guideAt || now,
      };
      /* @end */
      /* @doc tags */
      const tagsPatch = {
        counts: tallyPatch(tally.exists ? tally.data() : null, tags),
      };
      /* @end */
      tx.set(threadRef, thread);
      tx.set(postRef, post);
      tx.set(m.ref, handlePatch, { merge: true });
      tx.set(tRef, tagsPatch, { merge: true });
    });
    return { tid: threadRef.id, pid: postRef.id, n: 1 };
  }

  /* ------------------------------------------------------------- a reply */
  const tid = String(d.tid);
  const threadRef = roomRef.collection('threads').doc(tid);
  const postRef = threadRef.collection('posts').doc();
  const q = d.quote && typeof d.quote === 'object' ? d.quote : null;
  let n = 0;

  await P.run(D, async (tx) => {
    const th = await tx.get(threadRef);
    if (!th.exists) P.refuse('not-found', 'thread');
    const tv = th.data();
    if (Number(tv.season) !== Number(Y)) P.refuse('failed-precondition', 'archive');
    if (tv.locked || tv.hidden) P.refuse('failed-precondition', 'locked');
    /* A THREAD WHOSE QUESTION HAS GONE IS CLOSED (owner, 2026-09-05: "noone
       should be able to reply in such a thread"). Deleting a question now
       hides its thread, so `tv.hidden` above already answers this for
       anything written since; the read is for the rows written before that
       rule, where a deleted question sits under a thread still standing. One
       document, inside the transaction that guards the write, so it cannot be
       raced by a deletion landing between the two. */
    const head = await tx.get(threadRef.collection('posts').where('n', '==', 1).limit(1));
    if (head.empty || (head.docs[0].data() || {}).hidden) P.refuse('failed-precondition', 'locked');

    let quote = null;
    if (q) {
      const qn = Number(q.n);
      const text = typeof q.text === 'string' ? q.text.trim() : '';
      if (!Number.isInteger(qn) || qn < 1 || !text || text.length > M.BOUNDS.quote) P.refuse('invalid-argument', 'quote');
      const found = await tx.get(threadRef.collection('posts').where('n', '==', qn).limit(1));
      const src = found.docs[0] ? found.docs[0].data() : null;
      if (!src || src.hidden || String(src.body).indexOf(text) === -1) P.refuse('invalid-argument', 'quote');
      /* @doc quote */
      quote = {
        n: qn,
        by: src.by,
        text,
      };
      /* @end */
    }

    const hd = await tx.get(m.ref);
    const hv = hd.data() || {};
    if (!hv.guideAt && !accept) P.refuse('failed-precondition', 'guide');
    const now = M.minute();
    const c = P.counters(hv, now);
    P.checkLimit(c, 'dayPosts', M.RATE.posts);
    P.checkGap(c, now);
    n = (Number(tv.n) || 0) + 1;

    /* @doc post */
    const post = {
      season: Y,
      room,
      tid,
      n,
      by: m.handle,
      body,
      t: now,
      up: 0,
      down: 0,
      quote,
      hidden: false,
      hiddenBy: '',
    };
    /* @end */
    /* @doc thread */
    const threadPatch = {
      n,
      lastAt: now,
      lastBy: m.handle,
    };
    /* @end */
    /* @doc handle */
    const handlePatch = {
      day: c.day,
      dayPosts: c.dayPosts + 1,
      lastPostAt: now,
      guideAt: hv.guideAt || now,
    };
    /* @end */
    tx.set(postRef, post);
    tx.update(threadRef, threadPatch);
    tx.set(m.ref, handlePatch, { merge: true });
  });
  return { tid, pid: postRef.id, n };
});
