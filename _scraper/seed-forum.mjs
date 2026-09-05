#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Carry a Q&A archive into the forum, as threads and replies under drawn
   handles. Written for the owner's 2026-09-05 instruction to pre-populate
   /forum from the tracking workbook's "2026 Q&A" tab.

     node _scraper/seed-forum.mjs --selftest    the pure halves, offline
     node _scraper/seed-forum.mjs               PLAN it: what would be written
     node _scraper/seed-forum.mjs --write       write it

   WHY A SCRIPT AND NOT AN op ON forumModerate. A callable would be inert
   until somebody ran `firebase deploy --only functions` by hand, and this
   file has twice recorded what that costs: a feature that needs a manual
   step to become real looks installed and is not. FIREBASE_SERVICE_ACCOUNT
   has been a secret here for months, so this road is live on merge. The
   Admin SDK bypasses the rules, which is the ONLY way any forum document is
   ever written — every content path in _firestore.rules is `allow write: if
   false`, the maintainer's browser included.

   THE SEED IS COMMITTED, NOT FETCHED. forum-seed-2026-qa.json is a snapshot
   of a tab no pipeline reads, so what will be posted is reviewable in the
   diff before the button is pressed, and a re-run cannot pick up a workbook
   that has moved on underneath it. It is under _scraper/ and not data/,
   because everything under data/ is served to anyone who asks and these
   threads belong to the room that decides who reads them.

   IT WRITES ONLY KEYS THE MODEL NAMES. assets/oa-forum-model.js is the one
   definition of a forum document's shape (KEYS), and `shapeOk` below holds
   every document this file builds to it — the same discipline the selftest
   applies to the @doc blocks in _functions/forum/*.js, applied to the one
   writer that lives outside them. It never writes a season head: only
   identity.js may, because `secretVersion` must be minted from Secret
   Manager on the season's first real join.

   THE GUARD IS RE-RUN HERE. Every title and body goes through
   assets/oa-forum-guard.js at write time, so a text the site's own rule
   refuses cannot be smuggled in through the committed file. What it refuses
   is REPORTED and skipped, never weakened away.

   IDEMPOTENT BY DOCUMENT ID. A thread is `<prefix>-r<row>` and a post
   `<prefix>-r<row>-p<n>`, so a second press writes nothing: the run reads
   each thread first and skips the ones already there, which is also what
   keeps the tag tally from being counted twice.

   AN UPVOTE COUNT IS THE SHEET'S OWN RECORD, NOT AN INVENTED ONE. A trailing
   `xN` in a Q&A cell is N people upvoting the post it follows (owner,
   2026-09-05), so it is carried as `up` and the marker leaves the words; a
   cell that is only `xN` is a vote count rather than a post. No `votes/{H}`
   document is written for them, and that is right rather than a shortcut:
   those documents record WHO voted so a member can change their own vote,
   the sheet records no voter, and a reader's own vote still increments and
   decrements from the seeded count exactly as it would from any other.

   NO ACCOUNT IS BEHIND A SEEDED HANDLE. A real handle's id is
   HMAC(FORUM_SECRET, season + ':' + uid); a seeded one is a digest of its
   own post id and NOTHING else — no uid, no secret, no clock — so no forum
   document here can be joined to a person. Each seeded handle claims its
   slug in forumNames, or forumJoin could draw a name a seeded post already
   speaks under.
   --------------------------------------------------------------------------- */

import path from 'node:path';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { firestore } from './_mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const M = require('../assets/oa-forum-model.js');
const GUARD = require('../assets/oa-forum-guard.js');
const NAV = require('../assets/oa-jobnav.js');
const WORDS = require('../_functions/forum/words.js');

export const SEED_FILE = 'forum-seed-2026-qa.json';

/* ------------------------------------------------------------------ pure */

/** The digest a seeded handle is keyed on: its own post id, and nothing
    else. Never a uid, never the forum secret — the two things that make a
    real handle re-derivable are both absent here by construction. */
export function seedHandleKey(season, room, postId) {
  return crypto.createHash('sha256')
    .update('oa-forum-seed:' + season + ':' + room + ':' + postId)
    .digest('hex');
}

export function threadId(prefix, row) {
  return `${prefix}-r${row}`;
}

export function postId(prefix, row, n) {
  return `${threadId(prefix, row)}-p${n}`;
}

/** The first BOUNDS.excerpt characters of a body, cut at a word — the same
    rule member.js applies, so a seeded card reads like every other one. */
export function excerptOf(body) {
  const s = String(body || '').replace(/\s+/g, ' ').trim();
  if (s.length <= M.BOUNDS.excerpt) return s;
  const cut = s.slice(0, M.BOUNDS.excerpt);
  const at = cut.lastIndexOf(' ');
  return (at > M.BOUNDS.excerpt / 2 ? cut.slice(0, at) : cut).trim();
}

/** A post's instant: the day the sheet recorded, at a fixed UTC hour, one
    minute per post so a thread reads in order. Minute-aligned, like every
    other clock a forum document carries (R7). */
export function instantOf(day, hour, n) {
  const t = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(t)) throw new Error('seed: unparsable day ' + day);
  return M.minute(t + hour * 3600000 + (n - 1) * 60000);
}

/** Every key `doc` carries must be one the model names for `kind`. The
    writer-against-model pin the selftest applies to the callables, applied
    to this one. */
export function shapeOk(kind, doc) {
  const allowed = M.KEYS[kind];
  if (!allowed) return ['unknown kind: ' + kind];
  return Object.keys(doc).filter((k) => !allowed.includes(k));
}

/** What the seed says, checked before anything is written: the season it was
    cut for, the room, every bound, every tag, and the guard over every text.
    Returns { plan, problems }; a problem is never written around. */
export function planFrom(seed, opts) {
  const o = opts || {};
  const problems = [];
  const room = o.room || seed.room;
  const season = Number(o.season != null ? o.season : seed.season);
  const prefix = String(seed.idPrefix || 'seed');
  const hour = Number(seed.postAtUtcHour != null ? seed.postAtUtcHour : 12);

  if (!M.isRoom(room)) problems.push(`room ${JSON.stringify(room)} is not one of ${M.ROOMS.join(', ')}`);
  if (!Number.isInteger(season)) problems.push('the seed names no season');
  if (!Array.isArray(seed.threads) || !seed.threads.length) problems.push('the seed carries no threads');

  const plan = [];
  const seenIds = new Set();
  for (const t of seed.threads || []) {
    const tid = threadId(prefix, t.row);
    if (seenIds.has(tid)) { problems.push(`${tid}: two threads claim one id`); continue; }
    seenIds.add(tid);
    if (!Array.isArray(t.posts) || !t.posts.length) { problems.push(`${tid}: no posts`); continue; }
    if (!t.title || t.title.length > M.BOUNDS.title) problems.push(`${tid}: the title is empty or past ${M.BOUNDS.title} characters`);
    if (!M.tagsOk(t.tags)) problems.push(`${tid}: tags must be ${M.TAG_MIN} to ${M.TAG_MAX} slugs`);
    const bad = GUARD.check(t.title);
    if (bad) problems.push(`${tid}: the forum guard refuses the title (${bad})`);

    const posts = [];
    t.posts.forEach((p, i) => {
      const n = i + 1;
      const pid = postId(prefix, t.row, n);
      if (!p.body || p.body.length > M.BOUNDS.body) problems.push(`${pid}: the body is empty or past ${M.BOUNDS.body} characters`);
      if (!p.by || p.by.length > M.BOUNDS.handle) problems.push(`${pid}: no handle, or one past ${M.BOUNDS.handle} characters`);
      if (M.slug(p.by) === M.slug(M.MODERATOR)) problems.push(`${pid}: ${M.MODERATOR} is reserved for the guide thread`);
      const hit = GUARD.check(p.body);
      if (hit) problems.push(`${pid}: the forum guard refuses the body (${hit})`);
      const up = Number(p.up || 0);
      if (!Number.isInteger(up) || up < 0) problems.push(`${pid}: up must be a count, not ${JSON.stringify(p.up)}`);
      posts.push({ pid, n, by: p.by, body: p.body, up, t: instantOf(t.date, hour, n),
        H: seedHandleKey(season, room, pid), slug: M.slug(p.by) });
    });
    plan.push({ tid, row: t.row, date: t.date, title: t.title, tags: t.tags.slice(), posts });
  }

  /* one handle per post, so a slug claimed twice would silently merge two
     posters into one member */
  const slugs = new Map();
  for (const th of plan) {
    for (const p of th.posts) {
      if (slugs.has(p.slug)) problems.push(`${p.pid}: the handle "${p.by}" is already ${slugs.get(p.slug)}'s`);
      else slugs.set(p.slug, p.pid);
    }
  }
  return { plan, problems, room, season, prefix, hour };
}

/** The documents one thread becomes, all of them shape-checked. */
export function documentsFor(th, ctx) {
  const { room, season } = ctx;
  const last = th.posts[th.posts.length - 1];
  const docs = [];
  const thread = {
    season, room, title: th.title, tags: th.tags,
    by: th.posts[0].by, t: th.posts[0].t, lastAt: last.t, lastBy: last.by,
    n: th.posts.length, excerpt: excerptOf(th.posts[0].body),
    /* the card shows the OPENING post's net, which is what forumVote keeps
       here too, so a seeded thread sorts and reads like a posted one */
    score: th.posts[0].up, pinned: false, locked: false, hidden: false,
  };
  docs.push({ kind: 'thread', path: ['thread', th.tid], doc: thread });
  for (const p of th.posts) {
    const post = {
      season, room, tid: th.tid, n: p.n, by: p.by, body: p.body,
      t: p.t, up: p.up, down: 0, hidden: false, hiddenBy: '',
    };
    if (p.n > 1) post.quote = null;
    docs.push({ kind: 'post', path: ['post', th.tid, p.pid], doc: post });
    docs.push({ kind: 'handle', path: ['handle', p.H], doc: {
      season, handle: p.by, joinedAt: p.t, guideAt: p.t, status: 'ok', warnings: 0,
      day: M.today(p.t), dayThreads: p.n === 1 ? 1 : 0, dayPosts: 1, dayVotes: 0, lastPostAt: p.t,
    } });
    docs.push({ kind: 'name', path: ['name', p.slug], doc: { season, key: p.H } });
  }
  for (const d of docs) {
    const strays = shapeOk(d.kind, d.doc);
    if (strays.length) throw new Error(`seed: ${d.path.join('/')} writes keys the model does not name: ${strays.join(', ')}`);
  }
  return docs;
}

/* ----------------------------------------------------------------- write */

function refs(D, ctx) {
  const roomRef = D.collection('forumSeasons').doc(String(ctx.season)).collection('rooms').doc(ctx.room);
  return {
    thread: (tid) => roomRef.collection('threads').doc(tid),
    post: (tid, pid) => roomRef.collection('threads').doc(tid).collection('posts').doc(pid),
    handle: (H) => D.collection('forumHandles').doc(H),
    name: (slug) => D.collection('forumNames').doc(slug),
    tags: () => D.collection('forumTags').doc(ctx.season + '_' + ctx.room),
  };
}

/**
 * Post the plan, one BATCH per thread so a thread is all or nothing.
 *
 * IDEMPOTENT ON THE THREAD'S OWN DOCUMENT: present means this row has already
 * been carried over, and the row is skipped whole. That is also what keeps the
 * room's TAG TALLY honest, since `increment` would otherwise count a second
 * press again and the tally is the one thing here that cannot be recomputed
 * from what is stored.
 *
 * Takes its database handle and FieldValue rather than reaching for them, so
 * the selftest can drive the whole write against a stub.
 */
export async function seedInto(D, FieldValue, plan, ctx, log) {
  const R = refs(D, ctx);
  const say = log || (() => {});
  let wrote = 0, already = 0;
  for (const th of plan) {
    if ((await R.thread(th.tid).get()).exists) { already++; continue; }
    const batch = D.batch();
    for (const d of documentsFor(th, ctx)) {
      if (d.kind === 'thread') batch.set(R.thread(d.path[1]), d.doc);
      else if (d.kind === 'post') batch.set(R.post(d.path[1], d.path[2]), d.doc);
      else if (d.kind === 'handle') batch.set(R.handle(d.path[1]), d.doc);
      else if (d.kind === 'name') batch.set(R.name(d.path[1]), d.doc);
      else throw new Error('seed: no writer for kind ' + d.kind);
    }
    const counts = {};
    for (const tag of th.tags) counts[tag] = FieldValue.increment(1);
    batch.set(R.tags(), { counts }, { merge: true });
    await batch.commit();
    wrote++;
    say(`  posted ${th.tid} (${th.posts.length} post(s))`);
  }
  return { wrote, already };
}

async function main(argv) {
  const write = argv.includes('--write');
  const roomArg = (argv.find((a) => a.startsWith('--room=')) || '').split('=')[1];
  const force = argv.includes('--force-season');

  const seed = JSON.parse(await readFile(path.join(HERE, SEED_FILE), 'utf8'));
  const { plan, problems, room, season, prefix } = planFrom(seed, { room: roomArg });

  console.log(`seed-forum: ${seed.source.tab} of "${seed.source.workbook}" -> the ${room} room, season ${season}`);
  console.log(`  ${plan.length} thread(s), ${plan.reduce((n, t) => n + t.posts.length, 0)} post(s), ${plan.reduce((n, t) => n + t.posts.length, 0)} handle(s)`);
  for (const s of seed.skipped || []) console.log(`  not carried over (${s.why}): row ${s.row} ${s.key}`);

  if (problems.length) {
    for (const p of problems) console.log('::error::seed-forum: ' + p);
    console.log('seed-forum: nothing was written.');
    process.exitCode = 1;
    return;
  }

  /* the season the seed was cut for, or the run says so rather than filing a
     closed season's questions under the one now under way */
  const now = NAV.marketYear();
  if (season !== now) {
    const say = `the seed is for season ${season} and the season under way is ${now}`;
    if (!force) {
      console.log(`::error::seed-forum: ${say}. Re-cut the seed, or pass --force-season if that is really meant.`);
      process.exitCode = 1;
      return;
    }
    console.log(`::warning::seed-forum: ${say} (--force-season)`);
  }

  if (!write) {
    for (const th of plan) {
      console.log(`  ${th.tid}  ${th.date}  [${th.tags.join(' ')}]  ${th.title}`);
      for (const p of th.posts) console.log(`      #${p.n} ${p.by}: ${p.body.slice(0, 70)}${p.body.length > 70 ? '…' : ''}`);
    }
    console.log('seed-forum: a plan only. Pass --write to post it.');
    return;
  }

  const D = await firestore();
  if (!D) {
    console.log('::warning::seed-forum: FIREBASE_SERVICE_ACCOUNT is not set; nothing was written.');
    return;
  }
  const admin = await import('firebase-admin');
  const FieldValue = (admin.default || admin).firestore.FieldValue;
  const { wrote, already } = await seedInto(D, FieldValue, plan, { room, season, prefix },
    (line) => console.log(line));
  console.log(`seed-forum: ${wrote} thread(s) posted, ${already} already there.`);
}

/* -------------------------------------------------------------- selftest */

async function selftest() {
  let n = 0;
  const ok = (c, why) => { n++; if (!c) { console.error('FAIL: ' + why); process.exitCode = 1; } };
  const eqs = (a, b, why) => ok(JSON.stringify(a) === JSON.stringify(b), `${why} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);

  /* the digest is of the post id and nothing else: no uid, no secret, no clock */
  const k1 = seedHandleKey(2027, 'candidates', 'qa2026-r1-p1');
  ok(/^[0-9a-f]{64}$/.test(k1), 'a seeded handle id is 64 hex, the shape forumHandles keys carry');
  ok(k1 === seedHandleKey(2027, 'candidates', 'qa2026-r1-p1'), 'it is deterministic, so a re-run reaches the same handle');
  ok(k1 !== seedHandleKey(2027, 'candidates', 'qa2026-r1-p2'), 'and one per post');
  ok(k1 !== seedHandleKey(2027, 'open', 'qa2026-r1-p1'), 'and one per room');
  /* THE SOURCE SCANS READ THE CODE, NOT THE PROSE. This file EXPLAINS the
     HMAC it does not compute and the `allow write: if false` it does not
     change, and a guard that could not tell the explanation from the thing
     could only be satisfied by deleting the explanation (the rebase step's
     own lesson). It would also match the needles in the checks below, which
     live in this same file. So the scans run over a slice bounded at BOTH
     ends, with the comments stripped, and its length is asserted. */
  const src = await readFile(path.join(HERE, 'seed-forum.mjs'), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const from = src.indexOf('export function seedHandleKey');
  const to = src.indexOf('async function selftest()');
  ok(from > 0 && to > from, 'the scanned slice is bounded at both ends');
  const code = strip(src.slice(from, to));
  ok(code.length > 2000, `and it really is the file's code (${code.length} characters)`);

  const body = strip(src.slice(from, src.indexOf('export function threadId')));
  ok(!/uid|FORUM_SECRET|Date\.now/.test(body), 'seedHandleKey names no uid, no secret and no clock');
  ok(!/createHmac/.test(code), 'the seeder computes no HMAC: the one HMAC is identity.js\'s');

  /* ids, and that they are stable */
  eqs(threadId('qa2026', 7), 'qa2026-r7', 'a thread id names its source row');
  eqs(postId('qa2026', 7, 3), 'qa2026-r7-p3', 'and a post id its slot');

  /* the clock is minute-aligned (R7) and ordered within a thread */
  const t1 = instantOf('2026-09-04', 12, 1);
  const t2 = instantOf('2026-09-04', 12, 2);
  ok(t1 % 60000 === 0 && t2 % 60000 === 0, 'every seeded stamp is a whole minute');
  ok(t2 - t1 === 60000, 'a post is a minute after the one before it');
  eqs(new Date(t1).toISOString(), '2026-09-04T12:00:00.000Z', 'and lands on the day the sheet recorded');

  /* the model is the shape */
  eqs(shapeOk('thread', { season: 1, room: 'open', nope: 1 }), ['nope'], 'a key the model does not name is a stray');
  eqs(shapeOk('post', { season: 1, body: 'x' }), [], 'and one it does is not');

  /* the committed seed passes its own guards */
  const seed = JSON.parse(await readFile(path.join(HERE, SEED_FILE), 'utf8'));
  const { plan, problems, room, season } = planFrom(seed);
  eqs(problems, [], 'the committed seed carries no problem');
  ok(plan.length > 0 && plan.every((t) => t.posts.length > 0), 'and every thread in it has a post');
  eqs(room, 'candidates', 'it is cut for the Candidates\' room');
  ok(M.isRoom(room), 'which is a room the model knows');
  ok(Number.isInteger(season), 'and names its season');

  /* every document it would write is one the model's KEYS allow */
  for (const th of plan) {
    for (const d of documentsFor(th, { room, season })) {
      eqs(shapeOk(d.kind, d.doc), [], `${d.path.join('/')} writes only keys the model names for ${d.kind}`);
    }
  }
  /* and none of them carries a uid, an address, a name or a profile id */
  const all = JSON.stringify(plan.map((th) => documentsFor(th, { room, season })));
  ok(!/"uid"|"email"|"sub"|"name":/.test(all), 'no seeded document carries a uid, an e-mail, a name or a profile id');
  ok(!GUARD.check(plan.map((t) => t.title + ' ' + t.posts.map((p) => p.body).join(' ')).join(' ')),
    'and the whole seed passes the forum guard');

  /* the guard is re-run here rather than trusted from the file */
  const withEmail = { ...seed, threads: [{ row: 99, date: '2026-09-04', title: 'Hi', tags: ['about'], posts: [{ by: 'quiet heron 42', body: 'write to me at a@b.edu' }] }] };
  ok(planFrom(withEmail).problems.some((p) => /guard refuses/.test(p)), 'a body the guard refuses is a problem, not a write');
  const twice = { ...seed, threads: [
    { row: 98, date: '2026-09-04', title: 'A', tags: ['about'], posts: [{ by: 'quiet heron 42', body: 'a' }] },
    { row: 97, date: '2026-09-04', title: 'B', tags: ['about'], posts: [{ by: 'Quiet Heron 42', body: 'b' }] }] };
  ok(planFrom(twice).problems.some((p) => /already/.test(p)), 'one handle speaking for two posters is a problem');
  const mod = { ...seed, threads: [{ row: 96, date: '2026-09-04', title: 'A', tags: ['about'], posts: [{ by: M.MODERATOR, body: 'a' }] }] };
  ok(planFrom(mod).problems.some((p) => /reserved/.test(p)), 'and Moderator is refused: it is the guide thread\'s');

  /* the handles are drawable ones, so a seeded poster reads like a member */
  const adjs = new Set(WORDS.ADJ), nouns = new Set(WORDS.NOUN);
  for (const th of plan) for (const p of th.posts) {
    const bits = p.by.split(' ');
    ok(bits.length === 3 && adjs.has(bits[0]) && nouns.has(bits[1]) && /^\d\d$/.test(bits[2]),
      `${p.by} is a handle the word lists could have drawn`);
  }

  /* --- the WRITE path, driven against a stub -------------------------------
     A tiny Firestore: every set() lands in one map keyed by the document's
     full path, and a batch commits atomically. What is under test is the one
     property a re-run depends on and no shape check can see: the second press
     writes NOTHING, the tag tally included. */
  const store = new Map();
  const inc = (by) => ({ __inc: by });
  const FieldValueStub = { increment: (by) => inc(by) };
  /* a document reference at any depth: collection/doc/collection/doc/... */
  const mkRef = (p) => ({
    path: p,
    get: async () => ({ exists: store.has(p), data: () => store.get(p) }),
    collection: (c) => ({ doc: (id) => mkRef(p + '/' + c + '/' + id) }),
  });
  const stubDb = {
    collection: (c) => ({ doc: (id) => mkRef(c + '/' + id) }),
    batch: () => {
      const ops = [];
      return {
        set: (ref, doc, o) => ops.push([ref.path, doc, o]),
        commit: async () => {
          for (const [p2, doc, o] of ops) {
            if (o && o.merge) {
              const was = store.get(p2) || {};
              const counts = { ...(was.counts || {}) };
              for (const [k, v] of Object.entries(doc.counts || {})) {
                counts[k] = (counts[k] || 0) + (v.__inc || 0);
              }
              store.set(p2, { ...was, ...doc, counts });
            } else store.set(p2, doc);
          }
        },
      };
    },
  };

  const ctx = { room, season, prefix: 'qa2026' };
  const first = await seedInto(stubDb, FieldValueStub, plan, ctx);
  eqs([first.wrote, first.already], [plan.length, 0], 'the first press posts every thread');

  const posts = plan.reduce((k, t) => k + t.posts.length, 0);
  const paths = [...store.keys()];
  eqs(paths.filter((p2) => /\/threads\/[^/]+$/.test(p2)).length, plan.length, 'one document per thread');
  eqs(paths.filter((p2) => /\/posts\/[^/]+$/.test(p2)).length, posts, 'one per post');
  eqs(paths.filter((p2) => p2.startsWith('forumHandles/')).length, posts, 'a handle per post');
  eqs(paths.filter((p2) => p2.startsWith('forumNames/')).length, posts, 'and a name claimed for each');
  ok(paths.every((p2) => !/^forumSeasons\/\d+$/.test(p2)), 'and no season head');
  ok(store.has(`forumTags/${season}_${room}`), 'the room\'s tag tally is written');
  const tally = store.get(`forumTags/${season}_${room}`).counts;
  eqs(tally['2026-q-a'], plan.length, 'and counts the owner\'s tag once per thread');

  /* every stored document is still only what the model names */
  for (const [p2, doc] of store) {
    const kind = /\/posts\/[^/]+$/.test(p2) ? 'post'
      : /\/threads\/[^/]+$/.test(p2) ? 'thread'
      : p2.startsWith('forumHandles/') ? 'handle'
      : p2.startsWith('forumNames/') ? 'name' : 'tags';
    eqs(shapeOk(kind, doc), [], `${p2} stores only keys the model names for ${kind}`);
  }
  /* the sheet's upvote counts travel, and the marker does not */
  for (const th of plan) {
    for (const p2 of th.posts) {
      ok(Number.isInteger(p2.up) && p2.up >= 0, `${p2.pid} carries a count`);
      ok(!/\s[xX]\s?\d+$/.test(p2.body), `${p2.pid} does not still end in an xN marker`);
      ok(!/^[xX]\s?\d+$/.test(p2.body.trim()), `${p2.pid} is a post and not a bare vote count`);
      const stored = store.get(`forumSeasons/${season}/rooms/${room}/threads/${th.tid}/posts/${p2.pid}`);
      eqs(stored.up, p2.up, `${p2.pid} stores the count the sheet recorded`);
      eqs(stored.down, 0, `${p2.pid} stores no dislikes: the sheet records none`);
    }
    const head = store.get(`forumSeasons/${season}/rooms/${room}/threads/${th.tid}`);
    eqs(head.score, th.posts[0].up, `${th.tid} scores its opening post's net, as forumVote keeps it`);
  }
  ok(plan.some((t) => t.posts.some((p2) => p2.up > 0)), 'and some post really did carry one, so this is not vacuous');
  /* no vote document is invented: the sheet records no voter */
  ok(![...store.keys()].some((p2) => /\/votes\//.test(p2)), 'no votes/{H} document is written');

  /* a thread's stamps agree with its posts */
  for (const th of plan) {
    const stored = store.get(`forumSeasons/${season}/rooms/${room}/threads/${th.tid}`);
    eqs(stored.n, th.posts.length, `${th.tid} says how many posts it has`);
    eqs(stored.lastAt, th.posts[th.posts.length - 1].t, `${th.tid} lastAt is its newest post`);
    eqs(stored.lastBy, th.posts[th.posts.length - 1].by, `${th.tid} lastBy is who wrote it`);
    ok(stored.t <= stored.lastAt, `${th.tid} opened no later than it was last posted to`);
  }

  const before = store.size;
  const again = await seedInto(stubDb, FieldValueStub, plan, ctx);
  eqs([again.wrote, again.already], [0, plan.length], 'a second press posts nothing');
  eqs(store.size, before, 'and writes no document');
  eqs(store.get(`forumTags/${season}_${room}`).counts['2026-q-a'], plan.length,
    'and the tag tally is not counted twice');

  /* it never writes a season head: secretVersion is identity.js's to mint */
  ok(!/batch\.set\(R\.season|'season',\s*\{|kind === 'season'/.test(code),
    'the seeder never writes a season head, so secretVersion stays identity.js\'s to mint');
  const kinds = new Set();
  for (const th of plan) for (const d of documentsFor(th, { room, season })) kinds.add(d.kind);
  eqs([...kinds].sort(), ['handle', 'name', 'post', 'thread'],
    'and it builds exactly four kinds of document, the season head not among them');
  ok(!/allow write/.test(code), 'it changes no rule');

  console.log(`seed-forum selftest: ${n} checks passed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) await selftest();
  else await main(argv);
}
