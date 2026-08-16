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
  submissionFromRow, composeApplyBy,
  PUBLIC_FIELDS, LEVELS, CHARACTERISTICS, TYPES,
} from './jobs-model.mjs';
import { splitDepartment, joinDepartment, buildVocab, vocabKey } from './vocab.mjs';
import { docIdFor, migrationDoc, lostFields } from './migrate-to-firestore.mjs';

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

if (import.meta.url === `file://${process.argv[1]}`) {
  testSanitisers();
  testMapping();
  testMerge();
  testMarketYear();
  testVocab();
  testSplitFields();
  testCollapseSameDay();
  await testPageHeadingRule();
  await testMigrationRoundTrip();
  await testMigrationDocs();
  await testServedFile();
  process.exit(finish() ? 0 : 1);
}
