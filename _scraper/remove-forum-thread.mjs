#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Take one forum thread off the site, whole: its votes, its posts, the thread
   document, and its share of the room's tag tally. Written for the owner's
   2026-09-05 instruction to remove a thread entirely.

     node _scraper/remove-forum-thread.mjs --selftest      the pure halves, offline
     node _scraper/remove-forum-thread.mjs                 LIST the room, to find the id
     node _scraper/remove-forum-thread.mjs --thread=<id>   PLAN it: what would go
     node _scraper/remove-forum-thread.mjs --thread=<id> --write    remove it

   WHY A SCRIPT AND NOT AN op ON forumModerate. The seeder's argument, for the
   same reason: a callable is inert until somebody runs `firebase deploy --only
   functions` by hand, and CLAUDE.md has recorded twice what that costs -- a
   feature that needs a manual step to become real looks installed and is not.
   FIREBASE_SERVICE_ACCOUNT has been a secret here for months, so this road is
   live on merge. The Admin SDK bypasses the rules, which is the only way any
   forum document is ever written: every content path in _firestore.rules is
   `allow write: if false`, the maintainer's browser included.

   IT PRINTS NO WORDS. A dispatched run prints into the Actions log of a PUBLIC
   repository, and the Candidates' room decides who reads what is in it. So a
   thread is named by its ID, its tags, its counts and its days -- never a
   title, never a body, never a handle. That is also what makes the LIST mode
   usable: `opener-deleted` says which thread is which without publishing
   anybody's words to the world.

   IT IS PERMANENT, AND THE PLAN IS THE SAFETY. Elsewhere on this site hiding is
   never a one-way door, because those are controls a reader presses. This is
   the maintainer's own tool, "remove entirely" is what it is for, and what
   stands in for a Restore is that nothing happens until --write: the plan says
   exactly what would go, and the run refuses anything it was not asked for.

   THE TALLY IS DECREMENTED, or the room's Popular tags goes on counting a
   thread nobody can open -- forumTags/{Y}_{room} is an `increment` tally and is
   the one thing here that cannot be recomputed from what is stored. It is read
   and written back floored at zero rather than incremented by -1, so a tally
   already short cannot be driven negative.

   WHAT IT NEVER TOUCHES. forumHandles/{H} and forumNames/{slug} are the
   account's handle for the SEASON and are shared by every thread it has posted
   in, so removing a thread must not remove them. Neither is candidateMarkers,
   which is the membership marker. And the room's GUIDE thread is refused
   outright: forumSeasons/{Y}.guides.{room} points at it, and a room whose guide
   has gone can never be seeded again.
   --------------------------------------------------------------------------- */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { firestore } from './_mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const M = require('../assets/oa-forum-model.js');
const NAV = require('../assets/oa-jobnav.js');

/** How many writes go in one batch. Firestore's own ceiling is 500; a thread
    with hundreds of votes is chunked rather than refused. */
export const BATCH = 400;

/* ------------------------------------------------------------------ pure */

/**
 * The room's tally with one thread's tags taken off it: only the tags being
 * removed appear, each floored at zero. Never `increment(-1)` -- a tally that
 * is already short (a tag past TAG_COUNT_CAP was never counted, so a thread
 * carrying one has nothing here to give back) would go negative and the
 * Popular tags panel would print it.
 */
export function tallyAfter(counts, tags) {
  const now = counts && typeof counts === 'object' ? counts : {};
  const out = {};
  for (const tag of tags || []) {
    if (!M.tagOk(tag)) continue;
    const had = Number(now[tag]);
    if (!Number.isFinite(had) || had <= 0) continue;
    out[tag] = had - 1;
  }
  return out;
}

/**
 * Why this thread may not be removed, or '' if it may. Today there is one
 * reason and it is the room's own guide: the season head names it
 * (`guides.{room}`), the seed button is drawn only while that field is empty,
 * so a removed guide is a room that can never have one again.
 */
export function refusalFor(tid, head, room) {
  const guides = (head && head.guides) || {};
  if (String(guides[room] || '') === String(tid)) {
    return `${tid} is the ${room} room's guide thread; forumSeasons names it and the room could never be seeded again`;
  }
  return '';
}

/**
 * One line about a thread that publishes none of its words: what it is called,
 * who wrote it and what it says are all members-only, and this prints into a
 * public log. What is left still tells two threads apart.
 */
export function describe(tid, thread, posts) {
  const v = thread || {};
  const tags = Array.isArray(v.tags) ? v.tags.filter(M.tagOk) : [];
  const opener = (posts || []).find((p) => Number(p.n) === 1);
  const marks = [];
  if (opener && opener.hidden) marks.push('opener-deleted');
  if (v.hidden) marks.push('hidden');
  if (v.pinned) marks.push('pinned');
  if (v.locked) marks.push('locked');
  return `${tid}  posts=${(posts || []).length}  [${tags.join(' ') || '-'}]`
    + `  asked ${M.today(Number(v.t) || 0)}  active ${M.today(Number(v.lastAt) || 0)}`
    + (marks.length ? '  ' + marks.join(' ') : '');
}

/** The argv the run was given, with the season defaulting to the one under way. */
export function optionsFrom(argv) {
  const val = (name) => {
    const hit = (argv || []).find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : '';
  };
  const room = val('room') || 'candidates';
  const seasonArg = val('season');
  return {
    room,
    season: seasonArg ? Number(seasonArg) : NAV.marketYear(),
    tid: val('thread'),
    write: (argv || []).includes('--write'),
  };
}

/* ----------------------------------------------------------------- write */

function refs(D, ctx) {
  const seasonRef = D.collection('forumSeasons').doc(String(ctx.season));
  const roomRef = seasonRef.collection('rooms').doc(ctx.room);
  return {
    season: () => seasonRef,
    threads: () => roomRef.collection('threads'),
    thread: (tid) => roomRef.collection('threads').doc(tid),
    tags: () => D.collection('forumTags').doc(ctx.season + '_' + ctx.room),
  };
}

/** Every thread in the room, described without its words, newest first. */
export async function listThreads(D, ctx) {
  const R = refs(D, ctx);
  const snap = await R.threads().orderBy('lastAt', 'desc').limit(200).get();
  const out = [];
  for (const doc of snap.docs) {
    const posts = await doc.ref.collection('posts').get();
    out.push({ tid: doc.id, line: describe(doc.id, doc.data() || {}, posts.docs.map((p) => p.data() || {})) });
  }
  return out;
}

/**
 * What removing this thread would take with it. Reads the thread, its posts and
 * every post's votes, and reports counts alone.
 */
export async function planFor(D, ctx, tid) {
  const R = refs(D, ctx);
  const th = await R.thread(tid).get();
  if (!th.exists) return { found: false };
  const thread = th.data() || {};
  const postsSnap = await th.ref.collection('posts').get();
  const posts = postsSnap.docs.map((p) => p.data() || {});
  let votes = 0;
  const voteRefs = [];
  for (const p of postsSnap.docs) {
    const vs = await p.ref.collection('votes').listDocuments();
    votes += vs.length;
    for (const v of vs) voteRefs.push(v);
  }
  const head = await R.season().get();
  const refusal = refusalFor(tid, head.exists ? head.data() : {}, ctx.room);
  const tags = Array.isArray(thread.tags) ? thread.tags.filter(M.tagOk) : [];
  const tallySnap = await R.tags().get();
  const counts = (tallySnap.exists && tallySnap.data().counts) || {};
  return {
    found: true,
    refusal,
    line: describe(tid, thread, posts),
    posts: postsSnap.docs.length,
    votes,
    tags,
    tally: tallyAfter(counts, tags),
    refsFor: { thread: th.ref, posts: postsSnap.docs.map((p) => p.ref), votes: voteRefs },
  };
}

/**
 * Remove it. The POSTS and their votes go first and the thread document LAST,
 * so a run interrupted half way leaves the thread standing and a second press
 * finishes it -- the other order would leave posts under a thread nothing can
 * reach. The tally is settled after the deletes, so a thread that failed to go
 * is never subtracted from it.
 */
export async function removeInto(D, ctx, plan, log) {
  const R = refs(D, ctx);
  const say = log || (() => {});
  const queue = [...plan.refsFor.votes, ...plan.refsFor.posts, plan.refsFor.thread];
  let done = 0;
  for (let i = 0; i < queue.length; i += BATCH) {
    const batch = D.batch();
    for (const ref of queue.slice(i, i + BATCH)) batch.delete(ref);
    await batch.commit();
    done += Math.min(BATCH, queue.length - i);
    say(`  deleted ${done}/${queue.length} document(s)`);
  }
  const patch = plan.tally;
  if (Object.keys(patch).length) {
    await R.tags().set({ counts: patch }, { merge: true });
    say(`  tag tally: ${Object.entries(patch).map(([k, n]) => `${k} -> ${n}`).join(', ')}`);
  }
  return { deleted: queue.length, tags: Object.keys(patch).length };
}

/* ------------------------------------------------------------------ main */

async function main(argv) {
  const o = optionsFrom(argv);
  if (!M.isRoom(o.room)) {
    console.log(`::error::remove-forum-thread: ${JSON.stringify(o.room)} is not one of ${M.ROOMS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(o.season)) {
    console.log('::error::remove-forum-thread: --season must be a year');
    process.exitCode = 1;
    return;
  }
  console.log(`remove-forum-thread: the ${o.room} room, season ${o.season}`);

  const D = await firestore();
  if (!D) {
    console.log('::warning::remove-forum-thread: FIREBASE_SERVICE_ACCOUNT is not set; nothing was read and nothing was written.');
    return;
  }

  if (!o.tid) {
    const rows = await listThreads(D, { room: o.room, season: o.season });
    console.log(`  ${rows.length} thread(s). Pass the id of the one to remove as --thread=<id>.`);
    console.log('  (ids only: a title, a body and a handle are the room\'s to read, and this log is public.)');
    for (const r of rows) console.log('  ' + r.line);
    return;
  }

  const plan = await planFor(D, { room: o.room, season: o.season }, o.tid);
  if (!plan.found) {
    console.log(`::error::remove-forum-thread: the ${o.room} room of season ${o.season} has no thread ${o.tid}.`);
    process.exitCode = 1;
    return;
  }
  if (plan.refusal) {
    console.log('::error::remove-forum-thread: ' + plan.refusal);
    process.exitCode = 1;
    return;
  }
  console.log('  ' + plan.line);
  console.log(`  would delete: 1 thread, ${plan.posts} post(s), ${plan.votes} vote(s)`);
  console.log(`  tag tally: ${Object.entries(plan.tally).map(([k, n]) => `${k} -> ${n}`).join(', ') || 'nothing to give back'}`);

  if (!o.write) {
    console.log('remove-forum-thread: a plan only. Pass --write to remove it. This cannot be undone.');
    return;
  }
  const { deleted, tags } = await removeInto(D, { room: o.room, season: o.season }, plan,
    (line) => console.log(line));
  console.log(`remove-forum-thread: removed ${o.tid} -- ${deleted} document(s) deleted, ${tags} tag(s) given back.`);
}

/* -------------------------------------------------------------- selftest */

async function selftest() {
  let n = 0;
  const ok = (c, why) => { n++; if (!c) { console.error('FAIL: ' + why); process.exitCode = 1; } };
  const eqs = (a, b, why) => ok(JSON.stringify(a) === JSON.stringify(b), `${why} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);

  /* --- the tally, which is the one thing that cannot be recomputed ------- */
  eqs(tallyAfter({ deadlines: 3, about: 1 }, ['deadlines']), { deadlines: 2 },
    'a removed tag is given back, one at a time');
  eqs(tallyAfter({ deadlines: 1, about: 1 }, ['deadlines', 'about']), { deadlines: 0, about: 0 },
    'every tag the thread carried, and only those');
  eqs(tallyAfter({ deadlines: 0 }, ['deadlines']), {},
    'a tally already at zero is left alone, never driven negative');
  eqs(tallyAfter({}, ['deadlines']), {},
    'and a tag the tally never counted (past TAG_COUNT_CAP) has nothing to give back');
  eqs(tallyAfter({ 'Not A Slug': 4 }, ['Not A Slug']), {},
    'a value that is not a tag slug is not written back');
  eqs(tallyAfter(null, ['deadlines']), {}, 'a missing tally document is not a crash');

  /* --- the guide thread is refused -------------------------------------- */
  const head = { guides: { candidates: 'g1', open: 'g2' } };
  ok(/guide/.test(refusalFor('g1', head, 'candidates')), 'the room\'s own guide thread is refused');
  ok(refusalFor('g2', head, 'candidates') === '', 'the OTHER room\'s guide is not this room\'s and is removable here');
  ok(refusalFor('t9', head, 'candidates') === '', 'an ordinary thread is not refused');
  ok(refusalFor('t9', {}, 'candidates') === '', 'a season with no guide yet refuses nothing');

  /* --- the log publishes no words --------------------------------------- */
  const words = { title: 'Who has heard back from Kellogg?', tags: ['deadlines'], by: 'jolly fern 38',
    t: Date.UTC(2026, 8, 4), lastAt: Date.UTC(2026, 8, 5), pinned: false, locked: false, hidden: false };
  const line = describe('abc123', words, [{ n: 1, hidden: true, by: 'jolly fern 38', body: 'secret' },
    { n: 2, hidden: false, by: 'quiet heron 7', body: 'also secret' }]);
  ok(line.includes('abc123'), 'the line names the thread by its id');
  ok(!/Kellogg|jolly|heron|secret/.test(line), 'and carries no title, no handle and no body: this log is public');
  ok(/posts=2/.test(line), 'it says how many posts would go');
  ok(/deadlines/.test(line), 'and which tags, which is what the tally gives back');
  ok(/opener-deleted/.test(line), 'a thread whose opening post its author deleted says so, which is how it is told apart');
  ok(!/opener-deleted/.test(describe('x', words, [{ n: 1, hidden: false }])),
    'and one whose opening post stands does not');
  ok(/hidden/.test(describe('x', { ...words, hidden: true }, [])), 'an already hidden thread says so');

  /* --- the arguments ----------------------------------------------------- */
  const dflt = optionsFrom([]);
  eqs([dflt.room, dflt.tid, dflt.write], ['candidates', '', false],
    'with nothing passed it lists the Candidates\' room and writes nothing');
  ok(Number.isInteger(dflt.season), 'and takes the season under way from the site\'s own roll rule');
  const asked = optionsFrom(['--room=open', '--season=2027', '--thread=abc123', '--write']);
  eqs([asked.room, asked.season, asked.tid, asked.write], ['open', 2027, 'abc123', true],
    'every option is read as given');
  ok(!optionsFrom(['--thread=abc123']).write, 'and --write is never implied by naming a thread');

  /* --- what the writer must never touch ----------------------------------

     THE SLICE IS BOUNDED AT BOTH ENDS AND ITS LENGTH ASSERTED. This file
     EXPLAINS the things it must not do -- it names forumHandles, FieldValue
     and initializeApp in the very assertions below -- so a scan over the
     whole of it would be satisfied by nothing but deleting the explanation,
     which is the trap CLAUDE.md records for the analytics page's own guard.
     What is scanned is the code ABOVE the selftest, with its comments gone. */
  const src = await (await import('node:fs/promises')).readFile(
    path.join(HERE, 'remove-forum-thread.mjs'), 'utf8');
  const cut = src.indexOf('async function selftest');
  const writerHalf = src.slice(src.indexOf("/* ---"), cut);
  ok(cut > 4000 && writerHalf.length > 3000, 'the scanned slice is the writer half, not an empty string');
  const code = writerHalf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/forumHandles|forumNames|candidateMarkers/.test(code),
    'it never reaches forumHandles, forumNames or candidateMarkers: a handle is the account\'s for the season and is shared by every thread it posted in');
  ok(/firestore\(\)/.test(code) && !/initializeApp/.test(code),
    'it takes its Admin SDK handle from _mail.mjs, the one definition');
  ok(!/\.set\(\s*\{\s*counts:\s*\{[^}]*increment/.test(code) && !/FieldValue/.test(code),
    'and the tally is written back as a value, never incremented by -1');
  /* the plan is the safety: nothing may delete before --write is read */
  const mainSrc = code.slice(code.indexOf('async function main'));
  ok(mainSrc.indexOf('if (!o.write)') < mainSrc.indexOf('removeInto('),
    'main() refuses to remove anything before it has read --write');

  console.log(`remove-forum-thread selftest: ${n} checks passed`);
}

/* Only when RUN, never when imported: the selftest imports this file for its
   pure halves, and a module that reaches for Firestore on import would list
   the room on every publishing run of selftest.mjs. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) await selftest();
  else await main(argv);
}
