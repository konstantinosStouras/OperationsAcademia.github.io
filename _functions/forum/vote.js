/* ---------------------------------------------------------------------------
   forumVote({ room, tid, pid, v: 1 | -1 | 0 })  -> { up, down }
   forumThreadVotes({ room, tid })                -> { votes: { pid: v } }

   One vote per handle per post, stored at posts/{pid}/votes/{H} as {v, t}
   and closed to every client in both directions: a vote beside a handle is a
   social fact nobody needs to read, and the voter's hash is the id, so
   nothing here sits beside a uid. The transaction adjusts the post's up and
   down tallies by the DELTA between the old vote and the new one (with
   FieldValue.increment, so a retried transaction never re-applies a stale
   absolute), and moves the thread head's `score` when the post is the first
   one, which is the net the list card shows without reading post 1 per card.
   A member may not vote on their own post. 60 votes per handle per day.

   The caller's own votes for a thread come back from forumThreadVotes in one
   round trip (getAll over the vote refs), so the page can highlight them.
   --------------------------------------------------------------------------- */

'use strict';

const { onCall } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const M = require('../forum-model.js');
const P = require('./member.js');

function threadRefFor(D, Y, room, tid) {
  return D.collection('forumSeasons').doc(String(Y)).collection('rooms').doc(room)
    .collection('threads').doc(String(tid || ''));
}

exports.forumVote = onCall(P.OPTS, async (req) => {
  const d = req.data || {};
  const m = await P.member(req, d.room);
  const { D, Y } = m;
  const v = Number(d.v);
  if (v !== 1 && v !== -1 && v !== 0) P.refuse('invalid-argument', 'bounds');
  const threadRef = threadRefFor(D, Y, d.room, d.tid);
  const postRef = threadRef.collection('posts').doc(String(d.pid || ''));
  const voteRef = postRef.collection('votes').doc(m.H);
  let out = { up: 0, down: 0 };

  await P.run(D, async (tx) => {
    const th = await tx.get(threadRef);
    const ps = await tx.get(postRef);
    if (!th.exists || !ps.exists) P.refuse('not-found', 'thread');
    const tv = th.data();
    const pv = ps.data();
    if (Number(tv.season) !== Number(Y)) P.refuse('failed-precondition', 'archive');
    if (tv.locked || tv.hidden || pv.hidden) P.refuse('failed-precondition', 'locked');
    if (pv.by === m.handle) P.refuse('failed-precondition', 'own');
    const old = await tx.get(voteRef);
    const was = old.exists ? Number(old.data().v) || 0 : 0;
    const up = Number(pv.up) || 0;
    const down = Number(pv.down) || 0;
    if (was === v) { out = { up, down }; return; }
    const hd = await tx.get(m.ref);
    const now = M.minute();
    const c = P.counters(hd.data() || {}, now);
    P.checkLimit(c, 'dayVotes', M.RATE.votes);
    const du = (v === 1 ? 1 : 0) - (was === 1 ? 1 : 0);
    const dd = (v === -1 ? 1 : 0) - (was === -1 ? 1 : 0);

    /* @doc post */
    const postPatch = {
      up: FieldValue.increment(du),
      down: FieldValue.increment(dd),
    };
    /* @end */
    tx.update(postRef, postPatch);
    if (Number(pv.n) === 1) {
      /* @doc thread */
      const threadPatch = {
        score: FieldValue.increment(du - dd),
      };
      /* @end */
      tx.update(threadRef, threadPatch);
    }
    if (v === 0) {
      tx.delete(voteRef);
    } else {
      /* @doc vote */
      const vote = {
        v,
        t: now,
      };
      /* @end */
      tx.set(voteRef, vote);
    }
    /* @doc handle */
    const handlePatch = {
      day: c.day,
      dayThreads: c.dayThreads,
      dayPosts: c.dayPosts,
      dayVotes: c.dayVotes + 1,
    };
    /* @end */
    tx.set(m.ref, handlePatch, { merge: true });
    out = { up: up + du, down: down + dd };
  });
  return out;
});

exports.forumThreadVotes = onCall(P.OPTS, async (req) => {
  const d = req.data || {};
  const m = await P.member(req, d.room);
  const { D, Y } = m;
  const threadRef = threadRefFor(D, Y, d.room, d.tid);
  const posts = await threadRef.collection('posts').orderBy('n').get();
  const refs = posts.docs.map((p) => p.ref.collection('votes').doc(m.H));
  const votes = {};
  if (refs.length) {
    const snaps = await D.getAll(...refs);
    snaps.forEach((s, i) => {
      if (s.exists) votes[posts.docs[i].id] = Number(s.data().v) || 0;
    });
  }
  return { votes };
});
