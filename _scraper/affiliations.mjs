#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — members' affiliations, in the site's own names.

   Owner, 2026-10-01: "any new universities added should be added to our list
   of universities, and job posting drop down university name too. Then, we
   should try to update affiliations of registered users that match any of
   the already existing universities so that they match with the exact
   university name we refer to each university."

   TWO JOBS, ONE READ of every profile:

   1. STANDARDISE. An affiliation that names a university the Universities
      page lists is rewritten to that card's own title, on the profile and on
      the roster row beside it: "Rotman School of Management, University of
      Toronto" becomes "University of Toronto". Which text names which
      university is assets/oa-affiliation.js's `match`, the SAME rule the
      registration form's picker settles a typed box by, so the pass and the
      form cannot disagree. Text that names no listed university (a company,
      a lab, a prefix like "Stanford", two universities at once) is left
      exactly as it was: curated, never guessed.

   2. COLLECT. A university a registered member is at that nothing else lists
      ("Add other" on the form, or an affiliation typed before the list
      existed) is written to data/member-universities.json, names only. The
      jobs build reads that file twice: build-directory.mjs gives each name a
      card on universities.html, and build-jobs.mjs adds it to the posting
      form's university list. A name leaves the file the day no member names
      it any more, or the day a posting or the seed lists the place itself.

   WHAT THE PUBLIC LOG SAYS. It is printed into the Actions log of a public
   repository, so it carries COUNTS and the university names the served file
   is about to publish anyway, and never an account id beside an affiliation:
   which person is at which university is exactly what the profile card
   promises is never shown with their name.

   WHO COUNTS FOR (2). Only accounts that carry the registeredUsers mark a
   usable sign-in writes, the same set the registered-users figure counts: an
   account that never confirmed its address cannot put a card on a public
   page.

       node _scraper/affiliations.mjs            plan: read, report, write nothing
       node _scraper/affiliations.mjs --write    apply both
       node _scraper/affiliations.mjs --selftest

   An unreachable source changes nothing: no list, no profiles, nothing is
   written at all; a tally that cannot be read leaves the served file as it is
   (unknown is not "nobody"), while the standardising still runs, since it
   does not depend on who is a member.
   --------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { firebaseAdmin } from './_mail.mjs';
import { memberUniversities } from './directory-model.mjs';

const require = createRequire(import.meta.url);
const A = require('../assets/oa-affiliation.js');
const SCHOOLS = require('../assets/oa-schools.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');

export const PROFILES = 'profiles';
export const ROSTER = 'userDirectory';
export const TALLY = 'registeredUsers';
export const NAMES_FILE = 'university-names.json';
export const MEMBERS_FILE = 'member-universities.json';
/* the bound the rules put on both fields (str('affiliation', 300)) */
export const MAXLEN = 300;

const argv = new Set(process.argv.slice(2));
const WRITE = argv.has('--write');

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

const az = (a, b) => SCHOOLS.fold(a).localeCompare(SCHOOLS.fold(b)) || a.localeCompare(b);

/**
 * What the pass would do, from what it read. PURE.
 *
 *   profiles   { uid: profile }
 *   roster     { uid: roster row } (only the rows that exist)
 *   marks      Set of member uids, or null when the tally could not be read
 *   list       data/university-names.json
 *
 * Returns { changes: [{uid, to}], roster: [{uid, to}], universities, counts }.
 * `universities` is null when the tally could not be read: the served file
 * then stays as it is.
 */
export function plan({ profiles = {}, roster = {}, marks = null, list = {} } = {}) {
  const idx = A.index(list);
  const changes = [];
  const rosterChanges = [];
  const found = new Map();      // institutionKey -> name
  const counts = { profiles: 0, given: 0, already: 0, standardised: 0, other: 0, members: 0 };

  for (const uid of Object.keys(profiles).sort()) {
    counts.profiles += 1;
    const had = String((profiles[uid] || {}).affiliation || '');
    const text = A.tidy(had);
    if (!text) continue;
    counts.given += 1;
    const member = !!(marks && marks.has(uid));
    if (member) counts.members += 1;
    const m = A.match(text, idx);
    if (m) {
      const to = m.name.slice(0, MAXLEN);
      if (to === had) counts.already += 1;
      else {
        counts.standardised += 1;
        changes.push({ uid, to });
        const row = roster[uid];
        if (row && row.affiliation !== to) rosterChanges.push({ uid, to });
      }
      /* a card that exists only because members name it stays in the file
         for as long as one of them still does */
      if (member && idx.members[SCHOOLS.institutionKey(to)]) found.set(SCHOOLS.institutionKey(to), to);
      continue;
    }
    counts.other += 1;
    if (!member) continue;
    const name = A.newUniversity(text, idx);
    if (name) {
      const k = SCHOOLS.institutionKey(name);
      if (k && !found.has(k)) found.set(k, name);
    }
  }
  const universities = marks ? [...found.values()].sort(az) : null;
  return { changes, roster: rosterChanges, universities, counts };
}

/** The served file's text: names only, sorted, no timestamp, so a run that
    found what the last one found writes byte for byte what is there. */
export function serialise(universities) {
  return JSON.stringify({ universities }, null, 1) + '\n';
}

async function readJson(name) {
  try { return JSON.parse(await readFile(path.join(DATA, name), 'utf8')); } catch { return null; }
}

async function main() {
  const list = await readJson(NAMES_FILE);
  if (!list || !Array.isArray(list.universities) || !list.universities.length) {
    warn(`data/${NAMES_FILE} is missing or empty: nothing can be matched, so nothing is changed.`);
    return;
  }
  const fb = await firebaseAdmin();
  if (!fb) {
    log('no Firebase credentials in this environment: nothing to read.');
    return;
  }

  const profiles = {};
  try {
    (await fb.db.collection(PROFILES).get()).forEach((d) => { profiles[d.id] = d.data() || {}; });
  } catch (e) {
    warn(`${PROFILES} could not be read: nothing is changed.`);
    return;
  }
  const roster = {};
  try {
    (await fb.db.collection(ROSTER).get()).forEach((d) => { roster[d.id] = d.data() || {}; });
  } catch (e) {
    warn(`${ROSTER} could not be read: the roster rows are left for the daily roster sync.`);
  }
  let marks = null;
  try {
    const ids = new Set();
    (await fb.db.collection(TALLY).get()).forEach((d) => ids.add(d.id));
    if (ids.size) marks = ids;
    else warn(`${TALLY} is empty: data/${MEMBERS_FILE} is left as it is.`);
  } catch (e) {
    warn(`${TALLY} could not be read: data/${MEMBERS_FILE} is left as it is.`);
  }

  const p = plan({ profiles, roster, marks, list });
  const c = p.counts;
  log(`${c.profiles} profile(s), ${c.given} with an affiliation: ` +
      `${c.already} already name a listed university exactly, ` +
      `${p.changes.length} would be standardised to one, ` +
      `${c.other} name none (left as they are).`);
  log(`${p.roster.length} roster row(s) follow their profile.`);

  const before = memberUniversities(await readJson(MEMBERS_FILE));
  if (p.universities) {
    const added = p.universities.filter((n) => !before.includes(n));
    const gone = before.filter((n) => !p.universities.includes(n));
    log(`data/${MEMBERS_FILE}: ${p.universities.length} universit(ies) only members name` +
        (added.length ? `; adding: ${added.join('; ')}` : '') +
        (gone.length ? `; dropping: ${gone.join('; ')}` : ''));
  }

  if (!WRITE) {
    log('plan only: nothing was written (pass --write to apply).');
    return;
  }

  /* ONE KEY, `affiliation`, on documents that already carry it: the profile's
     rules name it (str('affiliation', 300)) and so do the roster row's, so
     neither document is left in a shape its owner's next write would be
     refused for (the sync-user-directory trap). update(), never set(): the
     rest of the document is the owner's. */
  const writes = [
    ...p.changes.map((x) => ({ ref: fb.db.collection(PROFILES).doc(x.uid), to: x.to })),
    ...p.roster.map((x) => ({ ref: fb.db.collection(ROSTER).doc(x.uid), to: x.to })),
  ];
  let done = 0;
  for (let i = 0; i < writes.length; i += 400) {
    const batch = fb.db.batch();
    for (const w of writes.slice(i, i + 400)) batch.update(w.ref, { affiliation: w.to });
    await batch.commit();
    done += Math.min(400, writes.length - i);
  }
  log(`${done} document(s) updated.`);

  if (p.universities) {
    const body = serialise(p.universities);
    let had = '';
    try { had = await readFile(path.join(DATA, MEMBERS_FILE), 'utf8'); } catch { had = ''; }
    if (had !== body) {
      await writeFile(path.join(DATA, MEMBERS_FILE), body);
      log(`wrote data/${MEMBERS_FILE}`);
    }
  }
}

/* ------------------------------------------------------------------ selftest */

async function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, what) => { if (c) pass++; else fails.push(what); };
  const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b),
    `${what}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`);

  const list = {
    universities: ['Foo Member University', 'Massachusetts Institute of Technology (MIT)',
      'Northwestern University', 'Stanford University', 'University of Toronto'],
    fromMembers: ['Foo Member University'],
    schools: [['Kellogg School of Management', 'Northwestern University']],
  };
  const profiles = {
    a: { affiliation: 'Rotman School of Management, University of Toronto' },
    b: { affiliation: 'Stanford University' },
    c: { affiliation: 'Kellogg School of Management' },
    d: { affiliation: 'Acme Analytics' },
    e: { affiliation: 'Bar Polytechnic University' },
    f: { affiliation: 'Baz University' },
    g: { affiliation: 'Foo Member University' },
    h: { affiliation: 'Stanf' },
    l: { affiliation: 'stanford' },
    i: { affiliation: 'PhD, Stanford University; visiting at University of Toronto' },
    j: {},
    k: { affiliation: 'MIT' },
  };
  const roster = { a: { affiliation: 'Rotman School of Management, University of Toronto' }, k: { affiliation: 'MIT' } };
  const marks = new Set(['a', 'b', 'c', 'd', 'e', 'g', 'h', 'i', 'k', 'l']);   // f is not a member
  const p = plan({ profiles, roster, marks, list });

  eq(p.changes, [
    { uid: 'a', to: 'University of Toronto' },
    { uid: 'c', to: 'Northwestern University' },
    { uid: 'k', to: 'Massachusetts Institute of Technology (MIT)' },
    { uid: 'l', to: 'Stanford University' },
  ], 'standardised: a line naming one listed university, a school that vouches for one, the acronym a card carries, ' +
     'and a curated short form');
  eq(p.roster, [
    { uid: 'a', to: 'University of Toronto' },
    { uid: 'k', to: 'Massachusetts Institute of Technology (MIT)' },
  ], 'the roster row follows its profile where there is one');
  ok(!p.changes.some((x) => x.uid === 'b'), 'an affiliation already exact is not written');
  ok(!p.changes.some((x) => x.uid === 'h'), 'a prefix alone ("Stanf") is never taken for a university');
  ok(!p.changes.some((x) => x.uid === 'i'), 'two universities in one line is a person\'s call, never this pass\'s');
  ok(!p.changes.some((x) => x.uid === 'd'), 'a company is left exactly as it was');
  eq(p.universities, ['Bar Polytechnic University', 'Foo Member University'],
    'the served list: a member\'s new university, and a member-only card a member still names; ' +
    'never a non-member\'s, never a company');
  eq(p.counts.given, 11, 'counted: eleven profiles carry an affiliation');
  eq(plan({ profiles, roster, marks: null, list }).universities, null,
    'a tally that could not be read leaves the served file as it is (null), never empty');
  eq(plan({ profiles, roster, marks: null, list }).changes.length, 4,
    '…while the standardising still runs, which does not depend on who is a member');
  ok(p.changes.every((x) => x.to.length <= MAXLEN), 'every value fits the rules\' bound');
  eq(serialise(['B', 'A']), '{\n "universities": [\n  "B",\n  "A"\n ]\n}\n', 'the file carries names and nothing else');

  /* the source: what the public log may print, and what a write may touch */
  const src = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const run = src.slice(src.indexOf('async function main()'), src.indexOf('/* ------------------------------------------------------------------ selftest */'));
  ok(run.length > 1500, 'the run half was found');
  const logLines = run.split('\n').filter((l) => /\blog\(|\bwarn\(/.test(l) || /^\s*`/.test(l));
  ok(logLines.length >= 6 && !logLines.some((l) => /\buid\b|\.to\b|\.affiliation\b|profiles\[|\.changes\.map|\.roster\.map/.test(l)),
    'no log line names an account beside an affiliation');
  ok(/batch\.update\(w\.ref, \{ affiliation: w\.to \}\)/.test(run) && !/\.set\(/.test(run) && !/\.delete\(/.test(run),
    'a write is one key, affiliation, by update(): never a set and never a delete');
  ok(run.indexOf("if (!WRITE)") > 0 && run.indexOf("if (!WRITE)") < run.indexOf('batch.update('),
    'a plan writes nothing: the WRITE gate stands before the first write');
  ok(run.indexOf('if (!WRITE)') < run.indexOf('writeFile('),
    '…including the served file');

  for (const f of fails) console.log('FAIL  ' + f);
  console.log(`affiliations selftest: ${pass} checks passed, ${fails.length} failed`);
  if (fails.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (argv.has('--selftest') ? selftest() : main()).catch((err) => {
    console.log('::error::affiliations: ' + (err && err.message || err));
    process.exitCode = 1;
  });
}
