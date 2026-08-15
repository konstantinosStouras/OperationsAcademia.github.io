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
  marketYear, marketLabel, marketFloor, collapseSameDay, MARKET_WINDOW,
  PUBLIC_FIELDS, LEVELS, CHARACTERISTICS, TYPES,
} from './jobs-model.mjs';

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

  eq(at('2026-08-15T00:00:00Z'), 2027, 'August 2026 is in market 2027');
  eq(at('2026-06-01T00:00:00Z'), 2027, 'the market rolls on 1 June');
  eq(at('2026-05-31T23:59:59Z'), 2026, 'the day before, it has not');
  eq(at('2026-01-15T00:00:00Z'), 2026, 'January stays in the season under way');
  eq(at('2025-12-31T23:59:59Z'), 2026, 'and so does New Year\'s Eve');

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
  if (m) eq(Number(m[1]), 5, 'the page rolls in the same month as marketYear()');

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

if (import.meta.url === `file://${process.argv[1]}`) {
  testSanitisers();
  testMapping();
  testMerge();
  testMarketYear();
  testCollapseSameDay();
  await testPageHeadingRule();
  await testServedFile();
  process.exit(finish() ? 0 : 1);
}
