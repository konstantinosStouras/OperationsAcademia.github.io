#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Retire a CLOSED forum season: delete its membership markers, its handle
   documents and its reverse index, and record that its secret version was
   destroyed. The forum's step-2 housekeeping, written on 2026-09-06 for the
   privacy gap the second review sweep of that day confirmed.

     node _scraper/roll-forum-season.mjs --selftest                 offline
     node _scraper/roll-forum-season.mjs                            PLAN, for the season before the one under way
     node _scraper/roll-forum-season.mjs --season=2027              PLAN, for that closed season
     node _scraper/roll-forum-season.mjs --season=2027 --write      delete
     node _scraper/roll-forum-season.mjs --season=2027 --write --destroyed=3   ...and stamp the destruction of version 3

   WHY THIS EXISTS. Firestore stamps every document with a server-side
   createTime, at nanosecond precision, that no field carries and no key list
   can see. forumJoin creates forumHandles/{H} and candidateMarkers/{uid} in
   ONE call, so the two carry the same instant: anyone holding the Admin
   credential can list both collections with their metadata and pair a handle
   with an account, with no secret, and after the season's version has been
   destroyed, which is the moment the Privacy Policy promises nobody can. The
   model dropped the marker's own `joinedAt` for exactly this join (R7), and
   the metadata is the same join in a place no writer scan reaches.

   THE PROMISE IS KEPT BY NOT KEEPING THE RECORDS. Once a season is closed its
   markers name a profile the rules no longer admit, its handle documents have
   ids nothing can derive, and its names are a map from a slug to a hash
   nobody can compute. All three are dead weight, and dead weight with a
   timestamp on it is a join. So, for the closed season named and no other:
     candidateMarkers/{uid}   every marker whose `year` is that season or earlier
                              (one with no year predates the field; the next
                              join rewrites it for a current candidate)
     forumHandles/{H}         where season == Y
     forumNames/{slug}        where season == Y
   What stays: the threads, the posts, the votes and the tallies. The archive
   is readable by design; a post carries its author's handle as a word, and
   with the names gone that word maps to nothing.

   IT NEVER TOUCHES THE SEASON UNDER WAY. The season must be earlier than the
   one the site's own roll rule names, and the run refuses otherwise: a
   current candidate's marker is what admits them to their room.

   THE STAMP NEEDS THE NUMBER. `--destroyed=<N>` says the gcloud command in the
   runbook (_SETUP-INSTANT-PUBLISH.md, "The forum secret") has been run for
   version N. The run checks N against the closed season's own `secretVersion`
   and against the season under way's (the runbook's June trap: a version both
   seasons name must not be destroyed, and its destruction must not be
   recorded), and stamps `secretDestroyedAt` only then. Deleting without the
   stamp is allowed and the run says the destruction is still owed.

   THE LOG IS PUBLIC. Counts only: never a uid, never a hash, never a slug.

   WHY A SCRIPT AND NOT A FUNCTION: the seeder's and the remover's reason. A
   scheduled function is inert until deployed by hand; FIREBASE_SERVICE_ACCOUNT
   has been a secret here for months, so this road is live on merge. Nothing
   here is scheduled either: no cron may touch the forum, and 1 August is a
   day the maintainer presses a button on, after running gcloud.
   --------------------------------------------------------------------------- */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { firestore } from './_mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const M = require('../assets/oa-forum-model.js');
const NAV = require('../assets/oa-jobnav.js');

/** How many deletes go in one batch. Firestore's ceiling is 500. */
export const BATCH = 400;

/* ------------------------------------------------------------------ pure */

export function optionsFrom(argv, now) {
  const val = (name) => {
    const hit = (argv || []).find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : '';
  };
  const current = NAV.marketYear(now);
  const seasonArg = val('season');
  return {
    current,
    season: seasonArg ? Number(seasonArg) : current - 1,
    write: (argv || []).includes('--write'),
    destroyed: val('destroyed'),
  };
}

/** Why the run may not go ahead at all, or '' when it may. */
export function refusalFor(o) {
  if (!Number.isInteger(o.season)) return '--season must be a year';
  if (o.season >= o.current) {
    return `season ${o.season} is not closed: the season under way is ${o.current}, and a current ` +
      'candidate\'s marker is what admits them to their room';
  }
  return '';
}

/**
 * Whether the destruction may be recorded: `--destroyed=<N>` must name the
 * closed season's own version, and that version must not be the one the
 * season under way names. Answers { stamp, why }: stamp false with an empty
 * why means nothing was asked for.
 */
export function stampDecision(o, closedHead, currentHead) {
  if (!o.destroyed) return { stamp: false, why: '' };
  const n = String(o.destroyed).trim();
  const own = closedHead ? String(closedHead.secretVersion || '') : '';
  const live = currentHead ? String(currentHead.secretVersion || '') : '';
  if (!/^\d+$/.test(n) && n !== 'env' && n !== 'env2') return { stamp: false, why: `--destroyed=${n} is not a version number` };
  if (!own) return { stamp: false, why: `season ${o.season} has no secretVersion on record, so there is nothing to record as destroyed` };
  if (n !== own) return { stamp: false, why: `--destroyed=${n} is not the version season ${o.season} names (${own}); read it off the season document` };
  if (live && live === own) {
    return { stamp: false, why: `version ${n} is the one the season under way (${o.current}) names too: destroying it ` +
      'would leave the live forum unable to derive a handle. Rotate first (the runbook\'s June step).' };
  }
  if (closedHead && closedHead.secretDestroyedAt) return { stamp: false, why: `season ${o.season} already records its destruction` };
  return { stamp: true, why: '' };
}

/** Whether a marker belongs to the closed season or an earlier one. */
export function markerIsRetired(data, season) {
  const y = Number((data || {}).year);
  return !Number.isFinite(y) || y <= season;
}

export function describe(season, plan) {
  return `season ${season}: ${plan.markers} marker(s), ${plan.handles} handle document(s), ` +
    `${plan.names} name(s) would go; ${plan.kept} current marker(s) stay`;
}

/* ------------------------------------------------------------------ plan */

export async function planFor(D, o) {
  const closedRef = D.collection('forumSeasons').doc(String(o.season));
  const currentRef = D.collection('forumSeasons').doc(String(o.current));
  const [closed, current, markers, handles, names] = await Promise.all([
    closedRef.get(),
    currentRef.get(),
    D.collection('candidateMarkers').get(),
    D.collection('forumHandles').where('season', '==', o.season).get(),
    D.collection('forumNames').where('season', '==', o.season).get(),
  ]);
  const gone = [];
  let kept = 0;
  for (const doc of markers.docs) {
    if (markerIsRetired(doc.data(), o.season)) gone.push(doc.ref); else kept++;
  }
  for (const doc of handles.docs) gone.push(doc.ref);
  for (const doc of names.docs) gone.push(doc.ref);
  return {
    closedHead: closed.exists ? closed.data() : null,
    currentHead: current.exists ? current.data() : null,
    closedRef,
    refs: gone,
    markers: gone.length - handles.size - names.size,
    handles: handles.size,
    names: names.size,
    kept,
  };
}

/* ----------------------------------------------------------------- write */

export async function retireInto(D, o, plan, decision, log) {
  const say = log || (() => {});
  let done = 0;
  for (let i = 0; i < plan.refs.length; i += BATCH) {
    const batch = D.batch();
    for (const ref of plan.refs.slice(i, i + BATCH)) batch.delete(ref);
    await batch.commit();
    done += Math.min(BATCH, plan.refs.length - i);
    say(`  deleted ${done}/${plan.refs.length} document(s)`);
  }
  if (decision.stamp) {
    /* @doc season */
    const stamp = {
      secretDestroyedAt: M.minute(),
    };
    /* @end */
    await plan.closedRef.set(stamp, { merge: true });
    say(`  season ${o.season} now records that version ${o.destroyed} was destroyed`);
  }
  return { deleted: plan.refs.length, stamped: !!decision.stamp };
}

/* ------------------------------------------------------------------ main */

async function main(argv) {
  const o = optionsFrom(argv);
  const refusal = refusalFor(o);
  if (refusal) {
    console.log('::error::roll-forum-season: ' + refusal);
    process.exitCode = 1;
    return;
  }
  console.log(`roll-forum-season: retiring season ${o.season} (the season under way is ${o.current})`);

  const D = await firestore();
  if (!D) {
    console.log('::warning::roll-forum-season: FIREBASE_SERVICE_ACCOUNT is not set; nothing was read and nothing was written.');
    return;
  }

  const plan = await planFor(D, o);
  console.log('  ' + describe(o.season, plan));
  const decision = stampDecision(o, plan.closedHead, plan.currentHead);
  if (decision.why) {
    console.log((o.destroyed ? '::error::' : '::warning::') + 'roll-forum-season: ' + decision.why);
    if (o.destroyed) { process.exitCode = 1; return; }
  }
  if (!o.destroyed) {
    const own = plan.closedHead ? String(plan.closedHead.secretVersion || '') : '';
    console.log(plan.closedHead && plan.closedHead.secretDestroyedAt
      ? `  season ${o.season} already records its destruction`
      : `  the destruction is still to be recorded: after \`gcloud secrets versions destroy ${own || '<N>'} ` +
        `--secret FORUM_SECRET --project operations-academia\`, run again with --destroyed=${own || '<N>'}`);
  }

  if (!o.write) {
    console.log('roll-forum-season: a plan only. Pass --write to delete. This cannot be undone.');
    return;
  }
  const { deleted, stamped } = await retireInto(D, o, plan, decision, (line) => console.log(line));
  console.log(`roll-forum-season: season ${o.season} retired; ${deleted} document(s) deleted` +
    (stamped ? ', and the destruction recorded.' : '.'));
}

/* -------------------------------------------------------------- selftest */

async function selftest() {
  let n = 0;
  const ok = (c, why) => { n++; if (!c) { console.error('FAIL: ' + why); process.exitCode = 1; } };
  const eqs = (a, b, why) => ok(JSON.stringify(a) === JSON.stringify(b), `${why} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
  const NOW = new Date('2027-09-06T12:00:00Z');

  /* --- the arguments ----------------------------------------------------- */
  const dflt = optionsFrom([], NOW);
  eqs([dflt.current, dflt.season, dflt.write, dflt.destroyed], [2028, 2027, false, ''],
    'with nothing passed it plans the season before the one under way and writes nothing');
  const asked = optionsFrom(['--season=2026', '--write', '--destroyed=3'], NOW);
  eqs([asked.season, asked.write, asked.destroyed], [2026, true, '3'], 'every option is read as given');
  ok(!optionsFrom(['--season=2026', '--destroyed=3'], NOW).write, '--write is never implied by --destroyed');

  /* --- never the season under way ---------------------------------------- */
  ok(refusalFor({ season: 2028, current: 2028 }) !== '', 'the season under way is refused');
  ok(refusalFor({ season: 2029, current: 2028 }) !== '', 'and so is a season that has not started');
  ok(refusalFor({ season: NaN, current: 2028 }) !== '', 'and a season that is not a year');
  ok(refusalFor({ season: 2027, current: 2028 }) === '', 'a closed season is retired');

  /* --- the stamp needs the number ---------------------------------------- */
  const closed = { secretVersion: '3' };
  const live = { secretVersion: '4' };
  eqs(stampDecision({ destroyed: '' }, closed, live), { stamp: false, why: '' }, 'nothing asked, nothing stamped, nothing said');
  ok(stampDecision({ season: 2027, current: 2028, destroyed: '3' }, closed, live).stamp, 'the closed season\'s own version stamps');
  ok(!stampDecision({ season: 2027, current: 2028, destroyed: '2' }, closed, live).stamp, 'any other number is refused');
  ok(/Rotate first/.test(stampDecision({ season: 2027, current: 2028, destroyed: '3' }, closed, { secretVersion: '3' }).why),
    'a version the season under way also names is refused, with the runbook\'s June step named');
  ok(stampDecision({ season: 2027, current: 2028, destroyed: '3' }, closed, null).stamp,
    'no season under way on record (nobody has joined yet) does not block the stamp');
  ok(/already records/.test(stampDecision({ season: 2027, current: 2028, destroyed: '3' }, { ...closed, secretDestroyedAt: 1 }, live).why),
    'a season already stamped is not stamped twice');
  ok(/nothing to record/.test(stampDecision({ season: 2027, current: 2028, destroyed: '3' }, null, live).why),
    'a season with no document has nothing to record');

  /* --- which markers go -------------------------------------------------- */
  ok(markerIsRetired({ year: 2027 }, 2027), 'a marker of the closed season goes');
  ok(markerIsRetired({ year: 2026 }, 2027), 'and one of an earlier season');
  ok(markerIsRetired({}, 2027), 'and one with no year, which predates the field');
  ok(!markerIsRetired({ year: 2028 }, 2027), 'a current candidate\'s marker stays');

  /* --- the log publishes no identifier ----------------------------------- */
  const line = describe(2027, { markers: 143, handles: 210, names: 210, kept: 12 });
  ok(/143 marker/.test(line) && /210 handle/.test(line) && /12 current/.test(line), 'counts, and which season');

  /* --- what the writer must never touch ----------------------------------
     THE SLICE IS BOUNDED AT BOTH ENDS AND ITS LENGTH ASSERTED. This file
     explains the things it must not do, so a scan over the whole of it would
     be satisfied only by deleting the explanation. */
  const src = await (await import('node:fs/promises')).readFile(path.join(HERE, 'roll-forum-season.mjs'), 'utf8');
  const cut = src.indexOf('async function selftest');
  const writerHalf = src.slice(src.indexOf('/* ---'), cut);
  ok(cut > 3000 && writerHalf.length > 2500, 'the scanned slice is the writer half, not an empty string');
  const code = writerHalf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/threads|posts|votes|forumTags|jobSubmissions|candidateSubmissions/.test(code),
    'it never reaches a thread, a post, a vote, a tally or a posting: the archive stays readable');
  ok(/firestore\(\)/.test(code) && !/initializeApp/.test(code), 'it takes its Admin SDK handle from _mail.mjs, the one definition');
  ok(/batch\.delete\(ref\)/.test(code) && (code.match(/\.set\(/g) || []).length === 1,
    'everything it touches it deletes, but the one document it writes: the closed season\'s stamp');
  ok(/secretDestroyedAt: M\.minute\(\)/.test(code), 'and the stamp is a whole minute (R7)');
  const mainSrc = code.slice(code.indexOf('async function main'));
  ok(mainSrc.indexOf('const refusal = refusalFor(o)') < mainSrc.indexOf('await firestore()'),
    'main() refuses a season that is not closed before it opens a connection');
  ok(mainSrc.indexOf('if (!o.write)') < mainSrc.indexOf('retireInto('), 'main() deletes nothing before it has read --write');
  ok(!/console\.log\([^)]*\b(uid|doc\.id|slug|handle)\b/.test(code), 'no log line carries a uid, a hash or a slug');

  console.log(`roll-forum-season selftest: ${n} checks passed`);
}

/* Only when RUN, never when imported: selftest.mjs imports the pure halves. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) await selftest();
  else await main(argv);
}
