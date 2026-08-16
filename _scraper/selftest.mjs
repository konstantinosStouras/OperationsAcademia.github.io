#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — offline checks for the job pipeline.

   No network, no credentials, no Firebase. Runs in CI on every push and is the
   thing that keeps the submission path, the migration path and the served file
   agreeing about what a row is.

       node v2/_scraper/selftest.mjs
   --------------------------------------------------------------------------- */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  text, url, day, slug, pickList, jobId, rowFromSubmission, mergeRows,
  buildMeta, serialise, publicRow, displayOrder, longDate,
  marketYear, marketLabel, marketFloor, collapseSameDay, MARKET_WINDOW, MARKET_ROLL_MONTH,
  submissionFromRow, composeApplyBy, assignIds, inCurrentMarket, marketStart,
  diffRows, collectChanges, renderChangesHtml,
  PUBLIC_FIELDS, LEVELS, CHARACTERISTICS, TYPES,
} from './jobs-model.mjs';
import { splitDepartment, joinDepartment, buildVocab, vocabKey } from './vocab.mjs';
import { docIdFor, migrationDoc, lostFields } from './migrate-to-firestore.mjs';
import {
  folderFor, isConfigured, auditFolders, isFolderId, isPlaceholder,
  resourceKeyFor, resourceKeyHeader, KINDS,
} from './drive-folders.mjs';
import { safeName, driveFileName, explain, multipartBody } from './drive-upload.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOBS = path.join(HERE, '..', 'data', 'jobs.json');

let pass = 0;
const fails = [];

function ok(cond, what) {
  if (cond) pass++;
  else fails.push(what);
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(a === b, `${what}\n      expected ${b}\n      got      ${a}`);
}

/* ------------------------------------------------------------- sanitisers */

function testSanitisers() {
  eq(text('  a   b  '), 'a b', 'text collapses whitespace');
  eq(text('a\u0000b\u001fc'), 'abc', 'text strips control characters');
  eq(text('abcdef', 3), 'abc', 'text truncates');
  eq(text(null), '', 'text of null is empty');

  eq(url('https://example.edu/x'), 'https://example.edu/x', 'https URL kept');
  eq(url('http://example.edu/x'), 'http://example.edu/x', 'http URL kept');
  eq(url('javascript:alert(1)'), '', 'javascript: URL dropped');
  eq(url('data:text/html,<script>'), '', 'data: URL dropped');
  eq(url('  https://a.b/c  '), 'https://a.b/c', 'URL trimmed');
  eq(url('example.edu'), '', 'bare host is not a URL');
  eq(url('https://exa mple.edu'), '', 'URL with a space dropped');

  eq(day('2025-11-01'), '2025-11-01', 'ISO day');
  eq(day('11/1/2025'), '2025-11-01', 'US day, as Google Forms wrote it');
  eq(day('November 1, 2025'), '2025-11-01', 'long day, as the display sheet wrote it');
  eq(day('Nov 1, 2025'), '2025-11-01', 'abbreviated month');
  eq(day('Until filled.'), '', 'prose is not a day');
  eq(day('2025-02-31'), '', 'an impossible day is rejected');
  eq(day('2025-13-01'), '', 'month 13 is rejected');
  eq(day(''), '', 'empty day');

  eq(slug('The Chinese University of Hong Kong, Shenzhen'),
    'the-chinese-university-of-hong-kong-shenzhen', 'slug');
  eq(slug('Université Paris-Saclay'), 'universite-paris-saclay', 'slug folds diacritics');
  eq(slug('---'), '', 'slug of punctuation only');

  eq(pickList(['PhD', 'MBA', 'PhD', 'Nonsense'], CHARACTERISTICS), ['PhD', 'MBA'],
    'pickList keeps allowed values, dedupes, drops the rest');
  eq(pickList('PhD', CHARACTERISTICS), ['PhD'], 'pickList accepts a scalar');
  eq(pickList(undefined, CHARACTERISTICS), [], 'pickList of undefined');

  eq(longDate('2025-12-31'), 'December 31, 2025', 'longDate');
}

/* ------------------------------------------------------- submission -> row */

const GOOD = {
  ref: 'OA-JOB-260815-ABCD',
  year: 2026,
  institution: 'University College Dublin',
  department: 'UCD Smurfit School, Management Science Group',
  type: 'Business School',
  levels: ['Assistant Professor', 'Post-Doc'],
  country: 'Ireland',
  applyByDate: '2025-11-30',
  applyByNote: 'Early submissions are encouraged.',
  comments: 'We will be interviewing at INFORMS.',
  postedAtUrl: 'https://apply.interfolio.com/999999',
  adUrl: 'https://example.edu/ad.pdf',
  characteristics: ['PhD', 'Research seminars'],
  createdAt: new Date('2025-08-14T09:00:00Z'),
  // things that must NEVER reach the served file
  email: 'poster@example.edu',
  authEmail: 'poster@example.edu',
  chairName: 'A Chair',
  chairEmail: 'chair@example.edu',
  firstName: 'Konstantinos',
  lastName: 'Stouras',
  note: 'private note to the maintainer',
  uid: 'u_secret',
  status: 'queued',
};

function testMapping() {
  const r = rowFromSubmission(GOOD);
  ok(r !== null, 'a complete submission maps to a row');
  eq(r.institution, 'University College Dublin', 'institution carried');
  eq(r.levels, ['Assistant Professor', 'Post-Doc'], 'levels carried');
  eq(r.posted, '2025-08-14', 'posted comes from createdAt');
  eq(r.applyByDate, '2025-11-30', 'applyByDate carried');
  eq(r.applyBy, 'November 30, 2025. Early submissions are encouraged.',
    'applyBy recombines the date and the note the way the sheet did');
  eq(r.id, '2026-university-college-dublin-20250814', 'id');
  eq(r.featured, false, 'featured defaults false');
  eq(r.source, 'oa-form', 'source stamped');

  // THE privacy invariant
  const published = JSON.stringify(publicRow(r));
  ok(!/@/.test(published), 'no e-mail address reaches the published row');
  for (const leak of ['chairName', 'chairEmail', 'firstName', 'lastName', 'note', 'uid',
    'status', 'authEmail', 'email']) {
    ok(!(leak in publicRow(r)), `private field "${leak}" is not published`);
  }
  eq(Object.keys(publicRow(r)).filter((k) => !PUBLIC_FIELDS.includes(k)), [],
    'publicRow emits only declared fields');

  // a client cannot smuggle a script into a link
  const evil = rowFromSubmission({
    ...GOOD, adUrl: 'javascript:alert(1)', postedAtUrl: 'data:text/html,x',
  });
  eq(evil.adUrl, '', 'a javascript: adUrl is dropped');
  eq(evil.postedAtUrl, '', 'a data: postedAtUrl is dropped');

  // a client cannot invent a level or a type
  const forged = rowFromSubmission({ ...GOOD, levels: ['Dean', 'Assistant Professor'], type: 'Hedge Fund' });
  ok(forged === null, 'an unknown type is rejected outright');
  const forged2 = rowFromSubmission({ ...GOOD, levels: ['Dean', 'Assistant Professor'] });
  eq(forged2.levels, ['Assistant Professor'], 'an unknown level is dropped');

  // "until filled"
  const uf = rowFromSubmission({ ...GOOD, untilFilled: true, applyByDate: '2025-11-30' });
  eq(uf.applyByDate, '', 'until-filled clears the date');
  eq(uf.applyBy, 'Until filled. Early submissions are encouraged.', 'until-filled wording');

  // incomplete submissions
  for (const missing of ['institution', 'department', 'country', 'type']) {
    ok(rowFromSubmission({ ...GOOD, [missing]: '' }) === null,
      `a submission with no ${missing} is not published`);
  }
  ok(rowFromSubmission({ ...GOOD, levels: [] }) === null,
    'a submission with no entry level is not published');

  // the mapping is deterministic
  eq(rowFromSubmission(GOOD), rowFromSubmission(GOOD), 'mapping is deterministic');
}

/* ------------------------------ ownership, open-endedness, the pending advert

   Three rules the FIRST real signed-in posting exposed at once (OA-JOB-260816-
   BK7Q, 2026-08-16): every migrated row has uid null, an applyBy shape the
   committed file already agreed with, and no upload — so none of these paths
   had ever run against live data until that posting failed the publish gate. */

function testOwnershipAndPending() {
  // The owner tag survives the round trip. It is a one-way hash of the uid,
  // so submissionFromRow cannot recover the account — it must carry the tag
  // itself, or the first rebuild of an owned posting silently orphans it
  // (and the round-trip gate stops the whole publish, which is how this was
  // found).
  const owned = rowFromSubmission(GOOD);
  ok(/^[0-9a-f]{16}$/.test(owned.owner), 'a signed-in posting carries an owner tag');
  eq(rowFromSubmission(submissionFromRow(owned)).owner, owned.owner,
    'the owner tag survives the round trip when the account is not known');
  eq(rowFromSubmission({ ...submissionFromRow(owned), uid: 'u_secret' }).owner, owned.owner,
    'and a real uid derives the same tag rather than deferring to the carried one');

  /* The open-ended rule heals a STALE document: six postings were migrated
     before their committed dates were blanked, so their documents still carry
     the date their own prose contradicts. Rebuilt through rowFromSubmission
     they must serve date-free — the page buckets "Until filled" purely on the
     date being empty. */
  const healed = rowFromSubmission({
    ...GOOD, untilFilled: false, applyByDate: '2025-12-12',
    applyByText: 'December 12, 2025. Position will remain open until filled.',
  });
  eq(healed.applyByDate, '', 'prose that says "open until filled" wins over a stored date');
  eq(healed.applyBy, 'December 12, 2025. Position will remain open until filled.',
    'while the prose itself is untouched');
  const rolling = rowFromSubmission({
    ...GOOD, applyByDate: '2026-03-16',
    applyByNote: 'Applications will be reviewed on a rolling basis.',
  });
  eq(rolling.applyByDate, '', '"rolling" is open-ended too');
  eq(rowFromSubmission(GOOD).applyByDate, '2025-11-30',
    'a dated posting with ordinary prose keeps its date');

  /* An uploaded-but-not-yet-filed advert NEVER holds the posting back (owner,
     2026-08-16): the row publishes at once, flagged pending, and the public
     card says the file is coming. The flag flipping when the build files the
     upload is bookkeeping, not an edit. */
  const pend = rowFromSubmission({
    ...GOOD, adUrl: '', adUploadPath: 'uploads/u_secret/jobs/1-ad.pdf',
  });
  eq(pend.adPending, true, 'an unfiled upload marks the row pending');
  eq(publicRow(pend).adPending, true, 'and the flag is published');
  eq(rowFromSubmission(submissionFromRow(pend)).adPending, true,
    'and survives the round trip');
  ok(!('adPending' in publicRow(rowFromSubmission(GOOD))),
    'a row with a filed advert publishes no adPending noise');
  eq(diffRows(publicRow(pend), publicRow({ ...pend, adPending: false })), [],
    'the flag flipping is never a change e-mail on its own');
}

/* ------------------------------------------------------------------ merge */

function testMerge() {
  const a = rowFromSubmission(GOOD);
  const b = rowFromSubmission({
    ...GOOD, ref: 'OA-JOB-260815-EFGH', institution: 'Trinity College Dublin',
    createdAt: new Date('2025-08-15T09:00:00Z'),
  });

  let m = mergeRows([], [a, b]);
  eq(m.added, 2, 'both rows are new');
  eq(m.rows.length, 2, 'both kept');
  eq(m.rows[0].institution, 'Trinity College Dublin', 'newest posting leads');

  // a poster corrects their posting: same ref, new text
  const aFixed = rowFromSubmission({ ...GOOD, department: 'UCD Smurfit School, Operations' });
  m = mergeRows(m.rows, [aFixed]);
  eq(m.added, 0, 'a correction adds nothing');
  eq(m.updated, 1, 'a correction updates in place');
  eq(m.rows.length, 2, 'a correction does not duplicate the posting');
  eq(m.rows.find((r) => r.ref === GOOD.ref).department,
    'UCD Smurfit School, Operations', 'the correction won');

  // withdrawal
  m = mergeRows(m.rows, [], [GOOD.ref]);
  eq(m.removed, 1, 'a withdrawn posting is removed');
  eq(m.rows.length, 1, 'and is gone from the file');

  // featured leads regardless of date
  const feat = rowFromSubmission({
    ...GOOD, ref: 'OA-JOB-OLD', featured: true, createdAt: new Date('2020-01-01T00:00:00Z'),
  });
  feat.featured = true;
  const sorted = [b, feat].sort(displayOrder);
  eq(sorted[0].ref, 'OA-JOB-OLD', 'a featured posting leads even when older');

  // republishing the same queue twice changes nothing — the idempotence the
  // write-before-stamp ordering relies on
  const once = mergeRows([], [a, b]);
  const twice = mergeRows(once.rows, [a, b]);
  eq(serialise(twice.rows), serialise(once.rows), 're-publishing the same rows is a no-op');
}

/* --------------------------------------------------------- the served file */

async function testServedFile() {
  if (!existsSync(JOBS)) {
    fails.push('v2/data/jobs.json is missing');
    return;
  }
  const rows = JSON.parse(await readFile(JOBS, 'utf8'));
  ok(Array.isArray(rows), 'jobs.json is an array');
  ok(rows.length > 0, 'jobs.json is not empty');

  const ids = new Set();
  let bad = 0;
  for (const r of rows) {
    if (!r.id || ids.has(r.id)) bad++;
    ids.add(r.id);
  }
  eq(bad, 0, 'every row has a unique id');

  const blob = JSON.stringify(rows);
  ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(blob),
    'the served file contains no e-mail address');
  ok(!/javascript:|data:text/i.test(blob), 'the served file contains no script URL');

  for (const r of rows) {
    ok(!r.type || TYPES.includes(r.type), `row ${r.id}: type "${r.type}" is known`);
    for (const l of r.levels || []) {
      ok(LEVELS.includes(l), `row ${r.id}: level "${l}" is known`);
    }
    for (const c of r.characteristics || []) {
      ok(CHARACTERISTICS.includes(c), `row ${r.id}: characteristic "${c}" is known`);
    }
    ok(!r.applyByDate || /^\d{4}-\d{2}-\d{2}$/.test(r.applyByDate),
      `row ${r.id}: applyByDate is ISO or empty`);
    ok(!r.posted || /^\d{4}-\d{2}-\d{2}$/.test(r.posted), `row ${r.id}: posted is ISO`);
    ok(!r.adUrl || url(r.adUrl) === r.adUrl, `row ${r.id}: adUrl is a safe URL`);
    ok(!r.postedAtUrl || url(r.postedAtUrl) === r.postedAtUrl,
      `row ${r.id}: postedAtUrl is a safe URL`);
  }

  // the file is already in the order the page renders
  const sorted = [...rows].sort(displayOrder);
  eq(sorted.map((r) => r.id), rows.map((r) => r.id),
    'jobs.json is stored in display order');

  const meta = buildMeta(rows, { generated: 'x' });
  eq(meta.count, rows.length, 'meta count matches');
  ok(Object.keys(meta.countries).length > 1, 'meta has a country vocabulary');
}

/* -------------------------------------------------------------------- run */

export function runSelftest() {
  testSanitisers();
  testMapping();
  testMerge();
  return finish();
}

function finish() {
  if (fails.length) {
    console.log(`\n${fails.length} FAILED, ${pass} passed\n`);
    for (const f of fails) console.log('  FAIL  ' + f);
    return false;
  }
  console.log(`selftest: ${pass} checks passed`);
  return true;
}

/* ------------------------------------------------- the market year, and its
   third copy on the page

   The rule lives once in jobs-model.mjs, but jobs.html ships no build step and
   cannot import it, so the page carries its own two lines. That copy is what
   drifted a whole season last time — as a hand-typed literal — so it is pinned
   here against the model rather than trusted.                                */

function testMarketYear() {
  const at = (s) => marketYear(new Date(s));

  /* A market year runs 1 July of the previous year to 30 June of its own, and
     is numbered by the year it ends. Both ends of market 2026 are pinned —
     1 Jul 2025 and 30 Jun 2026 — because the rule is entirely a month
     boundary, and it was wrong by one month (rolling in June) until the owner
     said so on 2026-08-15. */
  eq(at('2025-07-01T00:00:00Z'), 2026, 'market 2026 opens on 1 July 2025');
  eq(at('2026-06-30T23:59:59Z'), 2026, 'and closes at the end of 30 June 2026');
  eq(at('2026-07-01T00:00:00Z'), 2027, 'market 2027 opens the very next day');
  eq(at('2025-06-30T23:59:59Z'), 2025, 'the day before it opened was still market 2025');

  eq(at('2026-08-15T00:00:00Z'), 2027, 'August 2026 is in market 2027');
  eq(at('2026-01-15T00:00:00Z'), 2026, 'January stays in the season under way');
  eq(at('2025-12-31T23:59:59Z'), 2026, 'and so does New Year\'s Eve');

  // the off-by-one that was here: June belongs to the season ENDING, not the
  // one about to start
  eq(at('2026-06-01T00:00:00Z'), 2026, 'June does not roll the market');
  eq(at('2026-06-15T12:00:00Z'), 2026, 'nor does mid-June');

  // every month lands in exactly one market, and the year advances once
  const months = Array.from({ length: 12 }, (_, i) =>
    at(`2026-${String(i + 1).padStart(2, '0')}-15T00:00:00Z`));
  eq(months.join(','), '2026,2026,2026,2026,2026,2026,2027,2027,2027,2027,2027,2027',
    'the calendar year splits Jan-Jun / Jul-Dec across two markets');

  eq(marketLabel(2027), '2026-2027', 'a market is labelled by the years it spans');
  eq(marketLabel('2026'), '2025-2026', 'a numeric string labels the same way');

  // the window, and what it is for
  eq(marketFloor(new Date('2026-08-15T00:00:00Z'), 1), 2027, 'a one-season window floors at the current market');
  eq(marketFloor(new Date('2026-08-15T00:00:00Z'), 2), 2026, 'two seasons reach back one market');
  eq(marketFloor(new Date('2026-08-15T00:00:00Z')), 2027 - (MARKET_WINDOW - 1),
    'the default floor follows MARKET_WINDOW');
  ok(marketFloor(new Date('2026-08-15T00:00:00Z')) <= 2026,
    'the shipped window still carries the previous season, whose "until filled" postings are live');

  // a submission with no year of its own is stamped with the market
  const r = rowFromSubmission({ ...GOOD, year: undefined }, { now: new Date('2026-08-15T00:00:00Z') });
  eq(r.year, 2027, 'an unyeared submission lands in the current market');
}

async function testPageHeadingRule() {
  const html = await readFile(path.join(HERE, '..', 'jobs.html'), 'utf8');

  const m = html.match(/getUTCFullYear\(\)\s*\+\s*\(\s*d\.getUTCMonth\(\)\s*>=\s*(\d+)\s*\?\s*1\s*:\s*0\s*\)/);
  ok(m, 'jobs.html derives the heading year rather than hard-coding a season');
  // read from the model, never written down again — the page's copy of the
  // rule is the one that drifts, so it is pinned to the constant itself
  if (m) eq(Number(m[1]), MARKET_ROLL_MONTH, 'the page rolls in the same month as marketYear()');

  ok(/id="oa-jobs-heading"/.test(html), 'the heading element is addressable');

  // the literal in the markup is only a no-JavaScript fallback, but a WRONG
  // fallback is worse than none — it is what a crawler and a reader with
  // scripts off will see.
  const fb = html.match(/id="oa-jobs-heading"[^>]*>\s*Job postings \((\d{4})-(\d{4})\)/);
  ok(fb, 'the fallback heading names a season');
  if (fb) {
    const now = marketYear(new Date());
    eq(Number(fb[2]), now, 'the fallback names the current market');
    eq(Number(fb[1]), now - 1, 'and spans the year before it');
    eq(`${fb[1]}-${fb[2]}`, marketLabel(now), 'in marketLabel() form');
  }
}

function testCollapseSameDay() {
  const base = {
    year: 2026, posted: '2025-06-05', institution: 'The Hong Kong Polytechnic University',
    department: 'Department of Logistics and Maritime Studies', type: 'University',
    levels: ['Assistant Professor'], country: 'Hong Kong', applyBy: '', applyByDate: '',
    comments: '', adUrl: '', postedAtUrl: '', furtherInfoUrl: '', characteristics: [],
    featured: false, source: 'sheet-import', addedAt: '',
  };

  // three submissions of one posting, the middle one carrying the most
  const full = { ...base, adUrl: 'https://example.edu/ad', comments: 'Interviewing at INFORMS' };
  let c = collapseSameDay([{ ...base }, full, { ...base }]);
  eq(c.rows.length, 1, 'three same-day repeats collapse to one');
  eq(c.collapsed, 2, 'and say how many went');
  eq(c.rows[0].adUrl, 'https://example.edu/ad', 'the fullest row is the one kept');

  // a different department on the same day is a different posting
  c = collapseSameDay([base, { ...base, department: 'School of Accounting and Finance' }]);
  eq(c.rows.length, 2, 'two departments on one day are two postings');

  // the same posting a fortnight later is a re-advertisement, not a repeat —
  // this is the "leave past duplicates alone" rule, asserted so a later
  // widening of the key cannot silently start merging them
  c = collapseSameDay([base, { ...base, posted: '2025-06-19' }]);
  eq(c.rows.length, 2, 'a later re-advertisement is kept');
  c = collapseSameDay([base, { ...base, year: 2027 }]);
  eq(c.rows.length, 2, 'the next market year is kept');

  // a site posting is owned — its author can correct or withdraw it — so it
  // outranks a fuller anonymous sheet row describing the same job
  const owned = { ...base, ref: 'OA-JOB-260815-ABCD' };
  const richer = { ...base, adUrl: 'https://example.edu/ad', comments: 'x', applyBy: 'y' };
  eq(collapseSameDay([richer, owned]).rows[0].ref, 'OA-JOB-260815-ABCD',
    'the owned posting survives a fuller anonymous repeat');
  eq(collapseSameDay([owned, richer]).rows[0].ref, 'OA-JOB-260815-ABCD',
    'and does so whichever order they arrive in');

  // committed repeats heal through the merge, which is the only path that ever
  // reaches an already-served file
  const m = mergeRows([{ ...base, id: 'x' }, { ...base, id: 'x-2' }], []);
  eq(m.rows.length, 1, 'a repeat already in the served file is collapsed by a merge');
  eq(m.collapsed, 1, 'and the merge reports it');

  // order is preserved, and an empty input is not a special case
  eq(collapseSameDay([]).rows.length, 0, 'nothing collapses to nothing');
  const order = collapseSameDay([
    { ...base, institution: 'A' }, { ...base, institution: 'B' }, { ...base, institution: 'A' },
  ]);
  eq(order.rows.map((r) => r.institution).join(''), 'AB', 'first-seen order is kept');
}

/* Pins for the 2026-08 fleet-review fixes. Each of these asserts the SHAPE of
   a fix that lives in a file this suite cannot execute (page scripts, the
   rules) or an invariant that spans two files — the cheapest guard that keeps
   a later edit from silently reopening the bug. */
async function testFleetPins() {
  // jobs.html's inline inCurrentMarket() mirrors the model's — the page ships
  // no build step, so the copy is pinned here instead (like the heading rule).
  const jobsHtml = await readFile(path.join(HERE, '..', 'jobs.html'), 'utf8');
  ok(/function inCurrentMarket\(row\)/.test(jobsHtml),
    'jobs.html filters the list to the current market year');
  ok(jobsHtml.includes("'-07-01'"),
    "the page's market start is 1 July, the model's own roll day");
  ok(/prepare:\s*function \(rows\) \{ return rows\.filter\(inCurrentMarket\); \}/.test(jobsHtml),
    'and the filter is wired into the list as its prepare step');
  // the model's own predicate, both legs
  const NOWM = new Date('2026-08-16T12:00:00Z');
  ok(inCurrentMarket({ posted: '2026-07-20', year: 2026 }, NOWM),
    'posted after the roll counts, whatever the tag says');
  ok(inCurrentMarket({ posted: '2026-04-07', year: 2027 }, NOWM),
    'tagged for the current market counts, whenever it was posted');
  ok(inCurrentMarket({ posted: '2026-08-06', year: 2028 }, NOWM),
    'tagged for a FUTURE market counts too');
  ok(!inCurrentMarket({ posted: '2026-06-30', year: 2026 }, NOWM),
    'the previous season is out — posted before the roll, tagged before it');
  ok(marketStart(NOWM) === '2026-07-01', 'marketStart is 1 July of the season under way');

  // candidates.html mirrors the same two inline rules jobs.html does — the
  // derived heading and the current-market filter — pinned the same way.
  const candHtml = await readFile(path.join(HERE, '..', 'candidates.html'), 'utf8');
  ok(/getUTCMonth\(\)\s*>=\s*6/.test(candHtml),
    'candidates.html derives its heading season with the July roll');
  ok(/function inCurrentMarket\(row\)/.test(candHtml) && candHtml.includes("'-07-01'"),
    'candidates.html filters to the current market with the model\'s own rule');

  // oa-nav.js derives its menu label from the SAME market-roll month as
  // marketYear() — a third copy of the rule, pinned like jobs.html's.
  const nav = await readFile(path.join(HERE, '..', 'assets', 'oa-nav.js'), 'utf8');
  const navRoll = nav.match(/getUTCFullYear\(\)\s*\+\s*\(\s*d\.getUTCMonth\(\)\s*>=\s*(\d+)\s*\?\s*1\s*:\s*0\s*\)/);
  ok(navRoll, 'oa-nav.js derives its season label rather than hard-coding one');
  if (navRoll) eq(Number(navRoll[1]), MARKET_ROLL_MONTH, 'oa-nav.js rolls in the same month as marketYear()');

  // A replacement must never re-stamp addedAt: it is the e-mail alerts' only
  // cursor, and a moved stamp re-alerts every subscriber about a posting they
  // were already sent.
  const sub = { institution: 'U', department: 'D', country: 'USA',
    type: 'University', levels: ['Assistant Professor'], uid: 'u1', ref: 'OA-JOB-1' };
  const a = rowFromSubmission({ ...sub, createdAt: '2026-08-01T10:00:00Z' });
  const b = rowFromSubmission({ ...sub, createdAt: '2026-08-09T10:00:00Z', comments: 'corrected' });
  const merged = mergeRows([a], [b]);
  eq(merged.rows[0].addedAt, a.addedAt, 'a correction keeps the original addedAt');
  eq(merged.rows[0].comments, 'corrected', 'while the correction itself lands');

  // The open-ended-deadline rule lives in the WRITERS: the page buckets a row
  // "Until filled" purely on `applyByDate` being empty, so import-sheet.mjs
  // (this regex) and rowFromSubmission (`untilFilled ? '' : …`, tested above)
  // must guarantee an open-ended posting never carries a date — and no served
  // row may violate it.
  const RX_OPEN = 'until\\s*filled|open\\s*until|rolling';
  const sheet = await readFile(path.join(HERE, 'import-sheet.mjs'), 'utf8');
  ok(sheet.includes(RX_OPEN), 'import-sheet.mjs clears dates with the open-ended regex');
  if (existsSync(JOBS)) {
    const rows = JSON.parse(await readFile(JOBS, 'utf8'));
    const contradicts = rows.filter((r) =>
      r.applyByDate && new RegExp(RX_OPEN, 'i').test(r.applyBy || ''));
    eq(contradicts.map((r) => r.id).join(', '), '',
      'no served row carries both an "until filled" deadline and a date');
  }

  // Everything inside /v2/ links relative, so the pages survive the cutover's
  // move up one directory. The account menu was the last absolute holdout.
  const acct = await readFile(path.join(HERE, '..', 'assets', 'oa-accounts.js'), 'utf8');
  ok(!/href=["']\/v2\//.test(acct),
    'oa-accounts.js carries no absolute /v2/ link');

  // The public card never shows a poster an empty File row for an advert that
  // exists but has not reached Drive yet — the posting publishes first and the
  // link follows (owner, 2026-08-16).
  const jobsPage = await readFile(path.join(HERE, '..', 'jobs.html'), 'utf8');
  ok(/adPending/.test(jobsPage) && /soon to be available/.test(jobsPage),
    'the jobs card says a pending advert file is coming');

  // The feedback inbox renders attacker-writable `shots` strings; they must
  // be shape-validated (data:image only) and never interpolated raw.
  const fb = await readFile(path.join(HERE, '..', 'assets', 'oa-feedback.js'), 'utf8');
  ok(/DATA_IMAGE\s*=\s*\/\^data:image\\\//.test(fb),
    'oa-feedback.js pins screenshot URLs to a strict data:image shape');
  ok(fb.includes('safeShots(v.shots)'),
    'the inbox renders screenshots only through the safeShots() validator');
  ok(/function safeShots[\s\S]{0,220}DATA_IMAGE\.test\(u\)[\s\S]{0,80}\.map\(esc\)/.test(fb),
    'safeShots() both validates the shape and escapes what survives');
}

/* --------------------------------------- the mobile standard stays wired up

   _MOBILE-STANDARDS.md is the living standard for every table/list page on a
   phone, and it works through two hooks: CLAUDE.md tells the next builder to
   consult it, and page-test.mjs's MOBILE_PAGES loop enforces it. A broken
   link in that chain fails silently — a page built without the standard just
   ships — so the chain itself is pinned. */

async function testMobileStandards() {
  const std = await readFile(path.join(HERE, '..', '_MOBILE-STANDARDS.md'), 'utf8');
  ok(/max-width: 640px/.test(std) && /16px/.test(std),
    'the standards file names the breakpoint and the iOS 16px rule');

  const claude = await readFile(path.join(HERE, '..', 'CLAUDE.md'), 'utf8');
  ok(claude.includes('_MOBILE-STANDARDS.md'),
    'CLAUDE.md points the next builder at the mobile standards');

  const pt = await readFile(path.join(HERE, 'page-test.mjs'), 'utf8');
  const listed = /const MOBILE_PAGES = \[([^\]]*)\]/.exec(pt);
  ok(!!listed, 'page-test.mjs carries the MOBILE_PAGES gate');
  for (const p of ['jobs.html', 'candidates.html', 'placements.html',
    'previous-markets.html', 'recent-faculty.html']) {
    ok(listed && listed[1].includes(p), `${p} is under the mobile gate`);
  }
  // universities.html is a MAP, not a list — it cannot mount OAList, so it has
  // its own phone block in page-test.mjs instead of a MOBILE_PAGES entry
  ok(pt.includes('oa-uni-search'), 'the universities map has its own mobile gate');

  // the engine rules the standard leans on
  const css = await readFile(path.join(HERE, '..', 'assets', 'oa-list.css'), 'utf8');
  ok(/max-width: 640px/.test(css) && /font-size: 16px/.test(css),
    'oa-list.css implements the phone breakpoint with 16px inputs');
  const js = await readFile(path.join(HERE, '..', 'assets', 'oa-list.js'), 'utf8');
  ok(js.includes('oa-menu-right') && js.includes('pointer: coarse'),
    'oa-list.js keeps menus on screen and the keyboard off the options');
}

/* ----------------------------------------------- My postings (my-postings.html)

   The signed-in poster's own postings — pending, live and taken down — each
   editable through the same editor the public list's Edit button uses. Source
   assertions, because the page's behaviour is a Firestore read CI cannot make;
   each stands for a specific way the feature breaks. */

async function testMyPostingsPage() {
  const page = await readFile(path.join(HERE, '..', 'my-postings.html'), 'utf8');
  ok(/assets\/oa-myjobs\.js/.test(page), 'the page loads its own script');
  ok(/assets\/oa-firebase\.js/.test(page) && /assets\/oa-accounts\.js/.test(page),
    'and the account plumbing before it');
  ok(page.indexOf('oa-firebase.js') < page.indexOf('oa-myjobs.js'),
    'in the right order');
  ok(!/(href|src)=["']\/v2\//.test(page),
    'no absolute /v2/ links — the page survives the cutover');
  ok(/id="oa-needauth"/.test(page) && /id="oa-offline"/.test(page),
    'the signed-out and not-configured states both have a box to appear in');

  const js = await readFile(path.join(HERE, '..', 'assets', 'oa-myjobs.js'), 'utf8');
  ok(/where\('uid',\s*'==',\s*user\.uid\)/.test(js),
    'the page reads ONLY the signed-in poster\'s own documents');
  ok(/status:\s*'withdrawn'/.test(js) && !/\.delete\(/.test(js),
    'taking down is a status change, never a document delete');
  ok(/post-a-job\.html\?edit=/.test(js),
    'Edit goes through the same editor as the public list');

  const acct = await readFile(path.join(HERE, '..', 'assets', 'oa-accounts.js'), 'utf8');
  ok((acct.match(/my-postings\.html/g) || []).length >= 2,
    'both account menus (header and phone panel) link My postings');
}

/* ------------------------------------------ merging two accounts into one

   The merge itself is browser code, exercised in page-test.mjs. What is
   checked HERE is the part that has no browser and no Firebase to run
   against, and that would fail silently rather than loudly: the security
   rules the merge depends on, and the two steps of it whose omission does
   damage nobody would notice for weeks.

   These are source-level assertions on purpose. Every one of them stands for
   a specific way the feature breaks, named in its message. */

async function testAccountMerge() {
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  const accounts = await readFile(path.join(HERE, '..', 'assets', 'oa-accounts.js'), 'utf8');

  // Duplicate DETECTION needs its collection, or every session's claim is
  // refused and two accounts are never noticed to be one person.
  ok(/match \/accountKeys\/\{key\}/.test(rules), 'the accountKeys collection has a rule');
  ok(/allow get: if signedIn\(\);/.test(rules),
    'an identity key can be looked up by someone signed in');
  ok(/allow list, delete: if false;/.test(rules),
    'but the identity keys cannot be enumerated — that would be the user list');
  ok(/email:<sha256/.test(rules) && /email:' \+ h/.test(accounts),
    'the e-mail identity key is hashed, so the collection is not a list of addresses');

  // The HAND-OVER. A job posting is a top-level document owned by a uid field:
  // without this branch a merged-away account's postings are stranded, and
  // with a loose one the merge becomes a way to edit a posting behind the
  // rules that normally bound it.
  ok(/affectedKeys\(\)\.hasOnly\(\['uid', 'mergedFrom', 'mergedAt'\]\)/.test(rules),
    'a hand-over may change ownership and nothing else about a posting');
  ok(/request\.resource\.data\.mergedFrom == request\.auth\.uid/.test(rules),
    'and is stamped with the account it came from');
  ok(/allow update: if isOwner\(resource\.data\.uid\)[\s\S]{0,400}?affectedKeys/.test(rules),
    'only the posting\'s current owner may hand it over');

  // The merge deletes the duplicate's alerts. Firebase deleting a SIGN-IN does
  // not delete its Firestore data, and the mailer reads every alert in the
  // database by collection group — so an alert left behind sends the user two
  // of everything, for ever, with nothing on screen to explain it.
  ok(/alertsCol\.doc\(a\.id\)\.delete\(\)/.test(accounts),
    'the merge deletes the merged-away account\'s alerts, or they keep sending');
  ok(/allow delete: if isOwner\(uid\);/.test(rules),
    'an account can withdraw its own registered-users mark, so the tally counts people');

  // Order: nothing is deleted until everything has been copied. Asserted by
  // position, because a reordering is exactly the edit that would lose data.
  const copyAt = accounts.indexOf('keptAlerts.doc(a.id).set(');
  const handAt = accounts.indexOf('jobSubmissions).doc(j.id).update(');
  const dropAt = accounts.indexOf('alertsCol.doc(a.id).delete()');
  const killAt = accounts.indexOf('return deleteCurrentSignIn(fb)');
  ok(copyAt > 0 && handAt > copyAt && dropAt > handAt && killAt > dropAt,
    'the merge copies, then hands over, then deletes — in that order');

  // A postings list we could not read must stop the merge, or the last step
  // removes the only sign-in that could ever reach them again.
  ok(/if \(!survey\.jobsOk\)/.test(accounts),
    'a merge refuses to run when the postings could not be listed');

  // The mailer's high-water marks travel with a copied alert. Without them the
  // alert looks brand new and newJobsFor() with an empty `since` matches the
  // whole catalogue — one enormous e-mail as the reward for merging.
  const fields = (accounts.match(/var ALERT_FIELDS = \[[\s\S]*?\];/) || [''])[0];
  for (const f of ['lastSentAt', 'lastCheckedAt', 'lastUpdateDate', 'criteria', 'enabled']) {
    ok(fields.includes(`'${f}'`), `a copied alert carries ${f}`);
  }
}

/* ------------------------------------------------- the posting vocabulary */

function testVocab() {
  const s = (v) => splitDepartment(v);

  // the five shapes the committed data actually holds
  eq(s('Fuqua School of Business, Operations Management group'),
    { school: 'Fuqua School of Business', unit: 'Operations Management group' },
    'school and unit, comma separated');
  eq(s('Darden School of Business'), { school: 'Darden School of Business', unit: '' },
    'a school on its own');
  eq(s('Operations Management'), { school: '', unit: 'Operations Management' },
    'a unit on its own is a unit, not a school');

  // THE case a naive comma split gets wrong: the comma is inside the name
  eq(s('Department of Decisions, Operations and Technology'),
    { school: '', unit: 'Department of Decisions, Operations and Technology' },
    'a comma inside a department name does not split it');
  eq(s('School of Business, Analytics, Information, and Operations Management Department'),
    { school: 'School of Business', unit: 'Analytics, Information, and Operations Management Department' },
    'the unit keeps its own commas');

  // a segment naming both, hyphenated
  eq(s('Robinson College of Business-Department of Management'),
    { school: 'Robinson College of Business', unit: 'Department of Management' },
    'a hyphen splits school from department');

  // "Area"/"Group" are TRAILING qualifiers — splitting at one strands the word
  eq(s('Naveen Jindal School of Management/Healthcare Management Area').unit, '',
    'a trailing "Area" is not treated as the start of a unit');
  eq(s('Desautels Faculty of Management, Operations Management Area'),
    { school: 'Desautels Faculty of Management', unit: 'Operations Management Area' },
    'but a comma still separates them');

  eq(s(''), { school: '', unit: '' }, 'nothing splits to nothing');
  eq(s('  ,  '), { school: '', unit: '' }, 'punctuation only splits to nothing');

  // joining is the inverse, and is what the card shows
  eq(joinDepartment('Fuqua School of Business', 'Operations Management group'),
    'Fuqua School of Business, Operations Management group', 'join');
  eq(joinDepartment('', 'Operations Management'), 'Operations Management', 'join with no school');
  eq(joinDepartment('Darden School of Business', ''), 'Darden School of Business', 'join with no unit');

  // one identity for spellings that differ only in case or punctuation
  eq(vocabKey('Operations Management'), vocabKey('operations  management!'), 'vocabKey folds');

  const v = buildVocab([
    { institution: 'Duke University', department: 'Fuqua School of Business, Operations Management' },
    { institution: 'Duke University', department: 'Fuqua School of Business, Operations Management' },
    { institution: 'Duke University', department: 'Fuqua School of Business, Decision Sciences' },
    { institution: 'Tulane University', department: 'Freeman School of Business' },
  ]);
  eq(v.universities[0], { v: 'Duke University', n: 3 }, 'the most-used university leads');
  eq(v.schools[0], { v: 'Fuqua School of Business', n: 3 }, 'schools are tallied across postings');
  eq(v.units.find((u) => u.v === 'Operations Management').n, 2, 'units are tallied');
  eq(v.byUniversity['Duke University'].units, ['Decision Sciences', 'Operations Management'],
    'a university carries the units seen at it, sorted');
  eq(v.byUniversity['Tulane University'].units, [], 'a school-only posting adds no unit');

  // a row that already carries the split is taken as given, not re-derived
  const given = buildVocab([{ institution: 'X', school: 'S', unit: 'U', department: 'ignored' }]);
  eq(given.schools[0].v, 'S', 'an explicit school is used as given');
  eq(given.units[0].v, 'U', 'an explicit unit is used as given');
}

function testSplitFields() {
  // the form now sends school + unit; department is derived from them
  const r = rowFromSubmission({ ...GOOD, department: undefined,
    school: 'Fuqua School of Business', unit: 'Operations Management group' });
  eq(r.school, 'Fuqua School of Business', 'school carried');
  eq(r.unit, 'Operations Management group', 'unit carried');
  eq(r.department, 'Fuqua School of Business, Operations Management group',
    'department is derived from the two');

  // either alone is enough
  eq(rowFromSubmission({ ...GOOD, department: undefined, school: 'Darden School of Business', unit: '' })
    .department, 'Darden School of Business', 'a school alone publishes');
  eq(rowFromSubmission({ ...GOOD, department: undefined, school: '', unit: 'Operations Management' })
    .department, 'Operations Management', 'a unit alone publishes');
  ok(rowFromSubmission({ ...GOOD, department: '', school: '', unit: '' }) === null,
    'neither is not publishable');

  // a legacy submission carrying only `department` is split for the vocabulary
  const legacy = rowFromSubmission({ ...GOOD, department: 'NUS Business School, Department of Analytics' });
  eq(legacy.school, 'NUS Business School', 'a legacy posting gains a school');
  eq(legacy.unit, 'Department of Analytics', 'and a unit');
  eq(legacy.department, 'NUS Business School, Department of Analytics',
    'and its published line is unchanged');

  ok(PUBLIC_FIELDS.includes('school') && PUBLIC_FIELDS.includes('unit'),
    'both parts are published');
}

/* ------------------------------------------- the migration off the sheet

   Every existing posting has to become a document that can be edited, and the
   only faithful way to build one is to invert the mapping. So the inverse is
   checked against the REAL committed file, field by field: a migration that
   rewrites the site's content while moving it is worse than no migration.   */

async function testMigrationRoundTrip() {
  const rows = JSON.parse(await readFile(JOBS, 'utf8'));
  ok(rows.length > 50, 'there are postings to migrate');

  /* The one difference allowed, and it is deliberate: `department` is now
     derived by joining school and unit with ", ", so the two rows that used a
     HYPHEN as the separator ("Robinson College of Business-Department of
     Management") come back normalised. Anything else is a loss. */
  const NORMALISED = (a, b) => String(a).replace(/\s*-\s*/g, ', ') === String(b);

  const lost = [];
  let verbatim = 0;
  for (const row of rows) {
    const sub = submissionFromRow(row);
    if (sub.applyByText) verbatim++;
    const back = rowFromSubmission(sub);
    if (!back) { lost.push(`${row.id}: no longer publishable`); continue; }
    const out = publicRow({ ...back, id: row.id });
    for (const k of Object.keys(row)) {
      if (JSON.stringify(row[k]) === JSON.stringify(out[k])) continue;
      if (k === 'department' && NORMALISED(row[k], out[k])) continue;
      lost.push(`${row.id}.${k}: ${JSON.stringify(row[k])} -> ${JSON.stringify(out[k])}`);
    }
  }
  eq(lost, [], 'every committed posting survives the round trip through a submission');

  /* Four rows carry prose that disagrees with their own parsed date, because
     the importer read the date from the raw tab and the prose from the display
     tab. They must be carried VERBATIM rather than re-composed, or the date a
     reader sees changes. */
  ok(verbatim > 0, 'the rows whose apply-by prose cannot be rebuilt are carried verbatim');
  ok(verbatim < rows.length / 10, 'and they are the exception, not the rule');

  // the composition rule itself
  eq(composeApplyBy({ untilFilled: true, applyByNote: '' }), 'Until filled.', 'until filled');
  eq(composeApplyBy({ untilFilled: true, applyByNote: 'Early applications welcome.' }),
    'Until filled. Early applications welcome.', 'until filled with a note');
  eq(composeApplyBy({ applyByDate: '2025-11-30', applyByNote: 'Early.' }),
    'November 30, 2025. Early.', 'a date and a note');
  eq(composeApplyBy({ applyByDate: '', applyByNote: 'See the advert.' }), 'See the advert.',
    'a note alone');

  // a verbatim line wins over composition, and only then
  eq(rowFromSubmission({ ...GOOD, applyByText: 'Whenever you like.' }).applyBy,
    'Whenever you like.', 'applyByText is used verbatim');
  eq(rowFromSubmission({ ...GOOD, applyByText: '' }).applyBy,
    'November 30, 2025. Early submissions are encouraged.',
    'an empty applyByText falls back to composition');

  // an empty ref is not written to every migrated row
  ok(!('ref' in publicRow({ ...rowFromSubmission({ ...GOOD, ref: '' }), id: 'x' })),
    'a posting with no reference publishes no empty ref field');
}

async function testMigrationDocs() {
  const rows = JSON.parse(await readFile(JOBS, 'utf8'));

  // every row must be addressable as a document id, or it cannot be migrated
  const unusable = rows.filter((r) => !docIdFor(r)).map((r) => r.id);
  eq(unusable, [], 'every posting id is usable as a Firestore document id');
  eq(new Set(rows.map(docIdFor)).size, rows.length, 'and they are distinct');

  // the gate the migration runs before writing anything
  const bad = [];
  for (const row of rows) for (const l of lostFields(row, migrationDoc(row))) bad.push(`${row.id}.${l}`);
  eq(bad, [], 'no posting changes when migrated into the database');

  const d = migrationDoc(rows[0], { now: new Date('2026-08-16T00:00:00Z') });
  eq(d.status, 'published', 'a migrated posting is published, not queued');
  eq(d.uid, null, 'and has no owner — there is no account behind a sheet posting');
  eq(d.migratedFrom, 'jobs.json', 'its provenance is recorded');
  ok(!('email' in d) && !('authEmail' in d) && !('chairEmail' in d),
    'no contact address is invented for a migrated posting');

  eq(docIdFor({ id: 'a/b' }), '', 'a slash is not usable as a document id');
  eq(docIdFor({ id: '' }), '', 'nor is nothing');
}

function testAssignIds() {
  /* THE BUG THIS EXISTS FOR: jobId is (year, institution, posting date) and
     carries no department, so two real postings from one institution on one day
     derive the same id. The sheet importer had always suffixed them; the
     Firestore build had not, so the second overwrote the first and two
     postings — Tulane's second Freeman department and Houston's — disappeared
     from the site the moment the database became the source of truth. */
  const row = (dept) => ({
    year: 2026, posted: '2026-04-07', institution: 'Tulane University',
    department: dept, school: 'Freeman School of Business', unit: dept,
  });

  const entries = [
    { key: '2026-tulane-university-20260407-2', row: row('Management Sciences Area') },
    { key: '2026-tulane-university-20260407', row: row('') },
  ];
  assignIds(entries);
  const ids = entries.map((e) => e.row.id);
  eq(new Set(ids).size, 2, 'two postings on one day keep two ids');
  ok(ids.includes('2026-tulane-university-20260407'), 'one takes the plain id');
  ok(ids.includes('2026-tulane-university-20260407-2'), 'the other is suffixed');

  // STABLE: the suffix follows the document id, not the order they arrived in
  const shuffled = [
    { key: '2026-tulane-university-20260407', row: row('') },
    { key: '2026-tulane-university-20260407-2', row: row('Management Sciences Area') },
  ];
  assignIds(shuffled);
  eq(shuffled.find((e) => e.key.endsWith('-2')).row.id, '2026-tulane-university-20260407-2',
    'the same document keeps the same id whichever order it is read in');
  eq(entries.find((e) => e.key.endsWith('-2')).row.id,
    shuffled.find((e) => e.key.endsWith('-2')).row.id, 'so a rebuild does not churn ids');

  // three of them, and the unrelated posting is untouched
  const three = [
    { key: 'c', row: row('A') }, { key: 'a', row: row('B') }, { key: 'b', row: row('C') },
    { key: 'z', row: { ...row('D'), institution: 'Duke University' } },
  ];
  assignIds(three);
  eq(new Set(three.map((e) => e.row.id)).size, 4, 'four distinct ids');
  eq(three[3].row.id, '2026-duke-university-20260407', 'a different institution needs no suffix');

  eq(assignIds([]).length, 0, 'nothing to assign is not a special case');
}

async function testDriveFolders() {
  const cfg = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'drive-folders.json'), 'utf8'));

  /* The season the site is CURRENTLY in must be configured, or an upload fails
     at the last step after someone has chosen a file. This is the check that
     fires each July when the market rolls and the new folders have not been
     added yet — deliberately, since the alternative is filing this season's
     CVs into last season's folder, which nobody notices. */
  const now = marketYear(new Date());
  eq(auditFolders(cfg, { years: [now] }), [],
    `the current market year (${now}) has both Drive folders configured`);

  for (const kind of KINDS) {
    ok(isConfigured(cfg, now, kind), `${kind} uploads are configured for ${now}`);
    ok(isFolderId(folderFor(cfg, now, kind)), `the ${kind} folder id is well formed`);
  }

  // the two folders must be DIFFERENT, or candidates' CVs land with job adverts
  ok(folderFor(cfg, now, 'jobs') !== folderFor(cfg, now, 'candidates'),
    'jobs and candidates are filed in different folders');

  // legacy folders carry a resource key; the header is "<id>/<key>"
  const key = resourceKeyFor(cfg, now, 'jobs');
  if (key) {
    eq(resourceKeyHeader(cfg, now, 'jobs'), folderFor(cfg, now, 'jobs') + '/' + key,
      'the resource-key header pairs the id with its key');
  }
  eq(resourceKeyFor({ byMarketYear: { 2027: { jobs: 'x'.repeat(30) } } }, 2027, 'jobs'), '',
    'a folder with no resource key reports none rather than undefined');

  // an unconfigured season REFUSES rather than falling back to another year
  const oneYear = { byMarketYear: { 2027: { jobs: 'a'.repeat(30), candidates: 'b'.repeat(30) } } };
  ok(!isConfigured(oneYear, 2028, 'jobs'), 'a season with no entry is not configured');
  let msg = '';
  try { folderFor(oneYear, 2028, 'jobs'); } catch (e) { msg = e.message; }
  ok(/market year 2028/.test(msg), 'and says which season is missing');
  ok(/1 July/.test(msg), 'and why that is expected');
  ok(/drive-folders\.json/.test(msg), 'and where to fix it');

  // a placeholder is not a folder id
  const unfilled = { byMarketYear: { 2027: { jobs: 'PASTE_JOBS_FILES_FOLDER_ID', candidates: 'b'.repeat(30) } } };
  ok(isPlaceholder('PASTE_X'), 'placeholders are recognised');
  ok(!isConfigured(unfilled, 2027, 'jobs'), 'an unfilled placeholder is not configured');
  try { folderFor(unfilled, 2027, 'jobs'); } catch (e) { msg = e.message; }
  ok(/Jobs Files/.test(msg), 'and the message names the Drive folder to open');

  // junk is rejected rather than sent to Drive to fail opaquely
  const junk = { byMarketYear: { 2027: { jobs: 'https://drive.google.com/drive/folders/abc', candidates: 'b'.repeat(30) } } };
  try { folderFor(junk, 2027, 'jobs'); } catch (e) { msg = e.message; }
  ok(/does not look like a Drive folder id/.test(msg), 'a pasted URL is refused');
  ok(!isFolderId('short'), 'a short string is not a folder id');
  ok(!isFolderId(''), 'nor is nothing');

  try { folderFor(cfg, now, 'nonsense'); } catch (e) { msg = e.message; }
  ok(/unknown upload kind/.test(msg), 'an unknown kind is refused');
}

function testDriveUpload() {
  // Drive-hostile characters, and the control characters that would make the
  // request itself malformed
  eq(safeName('a/b:c*d?e"f<g>h|i'), 'a b c d e f g h i', 'path characters are stripped');
  eq(safeName('a\u0000b\u001fc'), 'a b c', 'control characters are stripped');
  eq(safeName('Université Paris-Saclay'), 'Universite Paris-Saclay',
    'diacritics are folded but a hyphenated name keeps its hyphen');
  eq(safeName('   '), '', 'whitespace only');
  eq(safeName(null), '', 'nothing');

  /* The name has to say what the file is without opening it: a folder of forty
     "advert.pdf" is not a filing system. Date first so the folder sorts
     chronologically, institution next, reference last so it traces back. */
  const name = driveFileName({
    posted: '2026-08-16', institution: 'Tulane University',
    department: 'Freeman School of Business', ref: 'OA-JOB-260816-ABCD',
    original: 'Job Advert.PDF',
  });
  eq(name, '2026-08-16 Tulane University — Freeman School of Business (OA-JOB-260816-ABCD).pdf',
    'the Drive filename says what the file is');
  ok(/^\d{4}-\d{2}-\d{2} /.test(name), 'it starts with the date, so a folder sorts by time');
  ok(/\.pdf$/.test(name), 'the extension is carried over, lower-cased');

  eq(driveFileName({ posted: '2026-08-16', institution: 'X', original: 'a.docx' }),
    '2026-08-16 X.docx', 'a Word file keeps its extension');
  eq(driveFileName({ posted: '2026-08-16', institution: 'X', original: 'no-extension' }),
    '2026-08-16 X', 'a file with no extension gets none invented');

  // every failure Drive can return says what to DO about it
  ok(/invalid_grant/.test(explain(400, { error: 'invalid_grant' })),
    'a dead refresh token is explained rather than thrown as a stack trace');
  ok(/revoking access invalidates the STORED token/.test(explain(400, { error: 'invalid_grant' })),
    'and says why this is expected between revoking and updating the secret');
  ok(/Testing/.test(explain(401, {})), '401 points at the 7-day Testing expiry');
  ok(/drive\.file/.test(explain(403, 'insufficientPermissions')), '403 names the missing scope');
  ok(/service account/i.test(explain(403, 'storage quota')), 'a quota 403 names the SA trap');
  ok(/did not create/.test(explain(404, {})), '404 distinguishes a wrong id from a scope limit');
  ok(/temporarily/.test(explain(503, {})), '5xx reads as transient');
  ok(/Retrying/.test(explain(429, {})), 'so does 429');

  // the multipart body Drive requires: metadata part, media part, closing boundary
  const body = multipartBody({ name: 'x' }, Buffer.from('hello'), 'text/plain', 'BOUND').toString();
  ok(body.startsWith('--BOUND\r\n'), 'the body opens with the boundary');
  ok(body.includes('application/json'), 'the metadata part declares JSON');
  ok(body.includes('{"name":"x"}'), 'and carries the metadata');
  ok(body.includes('Content-Type: text/plain'), 'the media part declares its type');
  ok(body.includes('hello'), 'and carries the bytes');
  ok(body.endsWith('--BOUND--\r\n'), 'and closes the multipart properly');
}

/* -------------------------------------------- the admin\u2019s change e-mail */

function testChanges() {
  const a = { id: 'x', ref: 'OA-JOB-1', institution: 'Tulane University',
    department: 'Freeman School of Business', applyBy: 'November 1, 2026.',
    levels: ['Assistant Professor'], comments: '', adUrl: '' };

  // an edit is the same posting with different VISIBLE content
  const edited = { ...a, applyBy: 'December 1, 2026.', adUrl: 'https://drive.google.com/x' };
  let c = collectChanges([a], [edited], []);
  eq(c.edits.length, 1, 'a changed posting is an edit');
  eq(c.edits[0].fields.map((f) => f.field).sort(), ['adUrl', 'applyBy'],
    'and exactly the changed fields are reported');
  eq(c.added, 0, 'nothing counted as new');

  // field values render as before -> after
  const d = diffRows(a, edited);
  eq(d.find((f) => f.field === 'applyBy').before, 'November 1, 2026.', 'before is kept');
  eq(d.find((f) => f.field === 'applyBy').after, 'December 1, 2026.', 'after is kept');

  // an identical row is NOT an edit — this is what keeps the build's own
  // bookkeeping writes (status stamps, cleared upload paths) out of the inbox
  c = collectChanges([a], [{ ...a }], []);
  eq(c.edits.length, 0, 'an unchanged posting produces no e-mail');

  // lists compare by content, not identity
  c = collectChanges([a], [{ ...a, levels: ['Assistant Professor'] }], []);
  eq(c.edits.length, 0, 'an equal list is not a change');

  // a new posting is counted, never diffed against nothing
  c = collectChanges([a], [edited, { ...a, id: 'y', ref: 'OA-JOB-2' }], []);
  eq(c.added, 1, 'a new posting is a count, not a diff');

  // a takedown names the posting that left
  c = collectChanges([a], [], ['OA-JOB-1']);
  eq(c.takedowns.length, 1, 'a withdrawn posting is a takedown');
  eq(c.takedowns[0].before.institution, 'Tulane University', 'and carries what it was');

  // the rendering is complete and escaped
  const html = renderChangesHtml(collectChanges(
    [{ ...a, institution: 'A & B <School>' }],
    [{ ...a, institution: 'A & B <School>', applyBy: 'later' }], []));
  ok(html.includes('A &amp; B &lt;School&gt;'), 'HTML in a field value is escaped');
  ok(html.includes('November 1, 2026.') && html.includes('later'),
    'both sides of the change are shown');
  ok(!renderChangesHtml({ edits: [], takedowns: [], added: 0 }),
    'nothing changed renders as nothing');
}

/* -------------------------------------------- the posting page loads fast */

async function testPageSpeedWiring() {
  const html = await readFile(path.join(HERE, '..', 'post-a-job.html'), 'utf8');
  const fbjs = await readFile(path.join(HERE, '..', 'assets', 'oa-firebase.js'), 'utf8');

  /* The preloads only help while they name the EXACT scripts oa-firebase.js
     injects. A version bump there without one here would fetch dead weight on
     every visit and silently lose the head start. */
  const sdk = (fbjs.match(/var SDK = '([^']+)'/) || [])[1];
  ok(sdk, 'oa-firebase.js declares its SDK base URL');
  const parts = (fbjs.match(/var PARTS = \[([^\]]+)\]/) || [])[1] || '';
  for (const part of parts.match(/'[^']+'/g).map((x) => x.slice(1, -1))) {
    ok(html.includes(`<link rel="preload" as="script" href="${sdk}${part}">`),
      `post-a-job preloads ${part} at the version the code loads`);
  }
  ok(html.includes('rel="preconnect" href="https://www.gstatic.com"'),
    'and preconnects to the CDN');
}

/* ------------------------------------- the legacy Awesome Table datasets

   universities.json, recent-faculty.json and past-postings.json replaced the
   site's last three vendor tables (import-legacy-tables.mjs is the writer;
   its own --selftest covers the mapping). What is pinned HERE is the served
   files themselves — the same discipline as testServedFile — plus the
   keep-in-sync points that would fail silently: the pages reading the files,
   the legacy ?filter deep links, and the vendor script being gone. */

async function testLegacyTables() {
  const { ARCHIVE_MAX_YEAR } = await import('./import-legacy-tables.mjs');
  const read = async (name) =>
    JSON.parse(await readFile(path.join(HERE, '..', 'data', name), 'utf8'));

  for (const name of ['universities.json', 'recent-faculty.json', 'past-postings.json']) {
    if (!existsSync(path.join(HERE, '..', 'data', name))) {
      fails.push(`data/${name} is missing`);
      continue;
    }
    const rows = await read(name);
    ok(Array.isArray(rows) && rows.length > 0, `${name} is a non-empty array`);
    const ids = new Set();
    let dup = 0;
    for (const r of rows) { if (!r.id || ids.has(r.id)) dup++; ids.add(r.id); }
    eq(dup, 0, `${name}: every row has a unique id`);
    const blob = JSON.stringify(rows);
    ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(blob), `${name} contains no e-mail address`);
    ok(!/javascript:|data:text/i.test(blob), `${name} contains no script URL`);
  }

  const unis = await read('universities.json');
  let badUni = 0;
  for (const r of unis) {
    if (!r.name || !r.institution) badUni++;
    if (!(Number.isFinite(r.lat) && Math.abs(r.lat) <= 90 &&
          Number.isFinite(r.lng) && Math.abs(r.lng) <= 180)) badUni++;
    if (r.mapUrl && url(r.mapUrl) !== r.mapUrl) badUni++;
    if (r.facultyUrl && url(r.facultyUrl) !== r.facultyUrl) badUni++;
  }
  eq(badUni, 0, 'every university row has a name and plottable coordinates, and safe links');

  const rf = await read('recent-faculty.json');
  let badRf = 0;
  for (const r of rf) {
    if (!r.name || !r.last) badRf++;
    if (r.posted && !/^\d{4}-\d{2}-\d{2}$/.test(r.posted)) badRf++;
    if (r.year !== undefined && !(r.year >= 2000 && r.year <= 2100)) badRf++;
    if (r.webUrl && url(r.webUrl) !== r.webUrl) badRf++;
  }
  eq(badRf, 0, 'every recent-faculty row is a named person with sane fields');
  const rfSorted = [...rf].sort((a, b) =>
    a.last.localeCompare(b.last, 'en', { sensitivity: 'base' }) ||
    a.name.localeCompare(b.name));
  eq(rfSorted.map((r) => r.id), rf.map((r) => r.id),
    'recent-faculty.json is stored in the page order (alphabetical by last name)');

  const past = await read('past-postings.json');
  let badPast = 0;
  for (const r of past) {
    if (!(r.year >= 2000 && r.year <= ARCHIVE_MAX_YEAR)) badPast++;
    if (r.posted && !/^\d{4}-\d{2}-\d{2}$/.test(r.posted)) badPast++;
    if (r.adUrl && url(r.adUrl) !== r.adUrl) badPast++;
    if (r.postedAtUrl && url(r.postedAtUrl) !== r.postedAtUrl) badPast++;
    for (const l of r.levels || []) if (!LEVELS.includes(l)) badPast++;
    if (r.type && !TYPES.includes(r.type)) badPast++;
  }
  eq(badPast, 0,
    `every archived posting is a jobs-shaped row from a market ≤ ${ARCHIVE_MAX_YEAR}`);
  const pastSorted = [...past].sort((a, b) =>
    (b.year - a.year) || String(b.posted).localeCompare(String(a.posted)) ||
    a.institution.localeCompare(b.institution));
  eq(pastSorted.map((r) => r.id), past.map((r) => r.id),
    'past-postings.json is stored newest market first');

  /* the pages read the files, and honour the vendor's own deep links —
     the Universities map and every posting's "Further info" link depend on
     these staying wired */
  const rfHtml = await readFile(path.join(HERE, '..', 'recent-faculty.html'), 'utf8');
  ok(rfHtml.includes("data: 'data/recent-faculty.json'"), 'recent-faculty.html reads its dataset');
  ok(rfHtml.includes("legacyParam: 'filterE'") && rfHtml.includes("legacyParam: 'filterF'"),
    'recent-faculty.html honours ?filterE (recent hires) and ?filterF (PhD alumni)');

  const pmHtml = await readFile(path.join(HERE, '..', 'previous-markets.html'), 'utf8');
  ok(pmHtml.includes("data: 'data/past-postings.json'"), 'previous-markets.html reads the archive');
  ok(pmHtml.includes("fetch('data/jobs.json'"),
    'previous-markets.html folds in the jobs rows that left the current market');
  ok(pmHtml.includes("legacyParam: 'filterD'"), 'previous-markets.html honours ?filterD');
  ok(pmHtml.includes('getUTCMonth() >= 6'),
    'previous-markets.html carries the market-roll rule the jobs page uses');

  const uniHtml = await readFile(path.join(HERE, '..', 'universities.html'), 'utf8');
  ok(uniHtml.includes('assets/leaflet/leaflet.js') && uniHtml.includes('OAUniMap.mount'),
    'universities.html mounts the vendored map');
  const uniJs = await readFile(path.join(HERE, '..', 'assets', 'oa-uni-map.js'), 'utf8');
  ok(uniJs.includes("'filterA'") || uniJs.includes('filterA'),
    'the map honours the ?filterA deep link every posting’s Further-info column emits');
  for (const f of ['leaflet.js', 'leaflet.css', 'leaflet.markercluster.js',
    'MarkerCluster.css', 'MarkerCluster.Default.css', 'images/marker-icon.png']) {
    ok(existsSync(path.join(HERE, '..', 'assets', 'leaflet', f)), `assets/leaflet/${f} is vendored`);
  }

  /* the point of the whole change: no served page loads the vendor any more */
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(path.join(HERE, '..'))) {
    if (!f.endsWith('.html')) continue;
    const html = await readFile(path.join(HERE, '..', f), 'utf8');
    ok(!/awesome-table\.com|AwesomeTableView/i.test(html),
      `${f} no longer embeds Awesome Table`);
  }

  // the re-import path stays runnable: the workflow names the importer
  const wf = await readFile(
    path.join(HERE, '..', '.github', 'workflows', 'oa-legacy-import.yml'), 'utf8');
  ok(wf.includes('import-legacy-tables.mjs --fetch'),
    'the legacy-import workflow runs the importer');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testSanitisers();
  testMapping();
  testOwnershipAndPending();
  testMerge();
  testMarketYear();
  testVocab();
  testSplitFields();
  testCollapseSameDay();
  testAssignIds();
  testChanges();
  await testPageHeadingRule();
  await testPageSpeedWiring();
  await testFleetPins();
  await testMigrationRoundTrip();
  await testMigrationDocs();
  await testDriveFolders();
  testDriveUpload();
  await testServedFile();
  await testLegacyTables();
  await testMobileStandards();
  await testMyPostingsPage();
  await testAccountMerge();
  process.exit(finish() ? 0 : 1);
}
