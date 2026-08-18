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
import { createRequire } from 'node:module';

import {
  text, url, day, slug, pickList, jobId, rowFromSubmission, mergeRows,
  buildMeta, serialise, publicRow, displayOrder, longDate,
  marketYear, marketLabel, marketFloor, collapseSameDay, MARKET_WINDOW, MARKET_ROLL_MONTH,
  submissionFromRow, composeApplyBy, assignIds, inCurrentMarket, deadlineOpen, marketStart,
  diffRows, collectChanges, renderChangesHtml,
  PUBLIC_FIELDS, LEVELS, CHARACTERISTICS, TYPES,
} from './jobs-model.mjs';
import { splitDepartment, joinDepartment, buildVocab, vocabKey } from './vocab.mjs';
import { docIdFor, migrationDoc, lostFields, migratable } from './migrate-to-firestore.mjs';
import {
  sheetDay, daysBetween, classifyTab, isIntroTab, conventionalTabs, normHeader, mapColumns,
  inferColumns, resolveColumns, levelsFromRank, typeFromNames, rowsFromTab, collectRows,
  stampAddedAt, serialiseSheetRows, buildSheetMeta, stalenessOf, shouldWarn,
  tabsFromHtml, sheetIdsFromHtml, sheetId, sheetCsvUrl, sheetHtmlUrl,
  emptyRegistry, adoptSheets, activeSheets, rollRegistry,
  SOURCE as SHEET_SOURCE, SEED_SHEET_ID, STALE_DAYS,
} from './jobmarket-sheet.mjs';
import {
  folderFor, isConfigured, auditFolders, isFolderId, isPlaceholder,
  resourceKeyFor, resourceKeyHeader, KINDS,
} from './drive-folders.mjs';
import {
  parseAd, cacheEntry, needFetch, applyVerified, deadlineOf, labelledFields,
  isHigherEdJobsUrl, jobCodeOf, detailsUrl, hejDate, DEADLINE_FIELDS,
} from './higheredjobs.mjs';
import { safeName, driveFileName, explain, multipartBody } from './drive-upload.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the dual-mode browser modules (oa-countries.js, oa-alert-match.js) are the
// SAME files the pages load — required here rather than re-implemented
const require = createRequire(import.meta.url);
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
  // the model's own predicate, all three legs
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

  /* THE DEADLINE LEG (owner, 2026-08-17). An advertisement whose closing date
     has not passed stays on the page across the roll; one with no fixed
     deadline is cleared by it. Read the four together — they are the rule. */
  ok(deadlineOpen({ applyByDate: '2026-09-30' }, NOWM), 'a future deadline is open');
  ok(deadlineOpen({ applyByDate: '2026-08-16' }, NOWM),
    'a deadline falling TODAY is still open — applications close at the end of the day');
  ok(!deadlineOpen({ applyByDate: '2026-08-15' }, NOWM), 'yesterday is closed');
  ok(!deadlineOpen({ applyByDate: '' }, NOWM),
    'an empty date is the ABSENCE of a deadline ("Until filled"), never an open one');

  // the season has rolled (market 2028) and these were filed in the one before
  const AFTER = new Date('2027-07-02T12:00:00Z');
  ok(inCurrentMarket({ posted: '2027-05-10', year: 2027, applyByDate: '2027-09-30' }, AFTER),
    'a posting still open for applications survives the roll');
  ok(!inCurrentMarket({ posted: '2027-05-10', year: 2027, applyByDate: '' }, AFTER),
    'an "until filled" posting from the season just ended is cleared by the roll');
  ok(!inCurrentMarket({ posted: '2027-05-10', year: 2027, applyByDate: '2027-06-01' }, AFTER),
    'and so is one whose deadline has passed');

  /* The archive is the exact complement, so every row lands on one page or
     the other. previous-markets.html filters on !inCurrentMarket, and its
     inline copy has to carry the deadline leg too — without it a posting that
     is still open would be listed as a PAST market while the jobs page shows
     it as current. */
  const pastHtml = await readFile(path.join(HERE, '..', 'previous-markets.html'), 'utf8');
  ok(/!inCurrentMarket\(r\)/.test(pastHtml),
    'the past-markets archive is the complement of the jobs page');
  /* Every page carrying an inline copy of the rule, in BOTH designs the site
     serves: the live one at the root (whose one-pager holds the jobs teaser,
     so it carries the rule as well as jobs.html does) and the 2026 design
     archived at /v2/, whose pages still filter by season. */
  for (const [rel, html] of [
    ['jobs.html', jobsHtml],
    ['previous-markets.html', pastHtml],
    ['index.html', await readFile(path.join(HERE, '..', 'index.html'), 'utf8')],
    ['v2/jobs.html', await readFile(path.join(HERE, '..', 'v2', 'jobs.html'), 'utf8')],
    ['v2/previous-markets.html',
      await readFile(path.join(HERE, '..', 'v2', 'previous-markets.html'), 'utf8')],
  ]) {
    ok(/var deadline = String\(row\.applyByDate \|\| ''\);/.test(html) &&
       /deadline >= (?:d|new Date\(\))\.toISOString\(\)\.slice\(0, 10\)/.test(html),
      `${rel}: its inline copy carries the deadline leg, like the model`);
  }

  /* The candidates list mirrors the same two inline rules the jobs list does —
     the derived heading season and the current-market filter. It is a SECTION
     of the one-pager on the live site and a page of its own in the archive;
     both copies are pinned. */
  for (const rel of ['index.html', 'v2/candidates.html']) {
    const candHtml = await readFile(path.join(HERE, '..', ...rel.split('/')), 'utf8');
    ok(/getUTCMonth\(\)\s*>=\s*6/.test(candHtml),
      `${rel}: the candidates list derives its season with the July roll`);
    ok(/function inCurrentMarket\(row\)/.test(candHtml) && candHtml.includes("'-07-01'"),
      `${rel}: it filters to the current market with the model's own rule`);
  }

  /* oa-nav.js derives its menu label from the SAME market-roll month as
     marketYear(). It belongs to the archived design — the live site's nav is
     flat keywords with no season in it — so it is read from /v2/, beside the
     pages that load it. */
  const nav = await readFile(path.join(HERE, '..', 'v2', 'assets', 'oa-nav.js'), 'utf8');
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
  /* The rule this started as ("no absolute /v2/ links") was written while /v2/
     was the unpromoted preview and an absolute link into it would break the
     moment it moved up. It moved up, and then down again to /v2/ as the
     archive. What still has to hold is the same thing said properly: a live
     page may open an archive's FRONT DOOR and nothing deeper, so a promotion
     stays a directory move. The whole-site version of this — every internal
     link in all three trees, both directions — is _scraper/link-check.mjs. */
  for (const m of page.matchAll(/(?:href|src)="(\/v\d+\/[^"]*)"/g)) {
    ok(/^\/v\d+\/(index\.html)?$/.test(m[1]),
      `my-postings.html links ${m[1]} — a live page may only open an archive's front door`);
  }
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

  // The HAND-OVER. A posting is a top-level document owned by a uid field:
  // without this branch a merged-away account's postings are stranded, and
  // with a loose one the merge becomes a way to edit a posting behind the
  // rules that normally bound it.
  ok(/affectedKeys\(\)\.hasOnly\(\['uid', 'mergedFrom', 'mergedAt'\]\)/.test(rules),
    'a hand-over may change ownership and nothing else about a posting');
  ok(/request\.resource\.data\.mergedFrom == request\.auth\.uid/.test(rules),
    'and is stamped with the account it came from');
  ok(/allow update: if isOwner\(resource\.data\.uid\)[\s\S]{0,400}?affectedKeys/.test(rules),
    'only the posting\'s current owner may hand it over');

  // ALL THREE posting collections hand over, in the rules AND in the client.
  // The rules carried the candidate/placement clauses from the start, but the
  // client only moved jobSubmissions — so a merge quietly stranded the
  // duplicate's candidate profile and placement reports under a sign-in that
  // no longer existed. Rules first:
  eq((rules.match(/affectedKeys\(\)\.hasOnly\(\['uid', 'mergedFrom', 'mergedAt'\]\)/g) || []).length, 3,
    'the merge clause exists for jobs, candidates AND placements');
  // …then the client: the survey must enumerate all three (an unread
  // collection must stop the merge), and the hand-over must move all three.
  for (const col of ['jobSubmissions', 'candidateSubmissions', 'placementSubmissions']) {
    ok(accounts.includes(`postingsOf(OAFB.col.${col})`),
      `the merge survey reads ${col}`);
    ok(accounts.includes(`handOver(OAFB.col.${col}`),
      `and the merge hands ${col} over`);
  }

  // The merge deletes the duplicate's alerts. Firebase deleting a SIGN-IN does
  // not delete its Firestore data, and the mailer reads every alert in the
  // database by collection group — so an alert left behind sends the user two
  // of everything, for ever, with nothing on screen to explain it.
  ok(/alertsCol\.doc\(a\.id\)\.delete\(\)/.test(accounts),
    'the merge deletes the merged-away account\'s alerts, or they keep sending');
  ok(/allow delete: if isOwner\(uid\);/.test(rules),
    'an account can withdraw its own registered-users mark, so the tally counts people');

  // Order: nothing is deleted until everything has been copied. Asserted by
  // the position of the chain's own call sites, because a reordering is
  // exactly the edit that would lose data.
  const copyAt = accounts.indexOf('keptAlerts.doc(a.id).set(');
  const handAt = accounts.indexOf('return handOver(OAFB.col.jobSubmissions');
  const dropAt = accounts.indexOf('alertsCol.doc(a.id).delete()');
  const killAt = accounts.indexOf('return deleteCurrentSignIn(fb)');
  ok(copyAt > 0 && handAt > copyAt && dropAt > handAt && killAt > dropAt,
    'the merge copies, then hands over, then deletes — in that order');

  // A postings list we could not read must stop the merge, or the last step
  // removes the only sign-in that could ever reach them again. postingsOk is
  // the AND over all three collections — jobsOk alone let a merge run while
  // the candidate/placement reads had failed.
  ok(/if \(!survey\.postingsOk\)/.test(accounts),
    'a merge refuses to run when any posting collection could not be listed');

  /* The /v2/ archive keeps its own frozen copy of oa-accounts.js — its pages
     load it, and a signed-in reader can still merge duplicate accounts from
     there. Presentation may differ between the two designs; the merge
     machinery may not, or the same person repairs their duplicate accounts
     differently depending on which URL they happened to open. Byte-equality of
     the whole merge region is the cheapest strong statement of that. */
  const v2accounts = await readFile(
    path.join(HERE, '..', 'v2', 'assets', 'oa-accounts.js'), 'utf8');
  const mergeRegion = (src) => {
    const from = src.indexOf('var MERGE_APP');
    const to = src.indexOf('function signOut');
    return from > 0 && to > from ? src.slice(from, to) : null;
  };
  const rootRegion = mergeRegion(accounts), v2Region = mergeRegion(v2accounts);
  ok(rootRegion && v2Region && rootRegion === v2Region,
    'the archived copy carries the SAME merge machinery as the live one, byte for byte');

  // The mailer's high-water marks travel with a copied alert. Without them the
  // alert looks brand new and newJobsFor() with an empty `since` matches the
  // whole catalogue — one enormous e-mail as the reward for merging.
  const fields = (accounts.match(/var ALERT_FIELDS = \[[\s\S]*?\];/) || [''])[0];
  for (const f of ['lastSentAt', 'lastCheckedAt', 'lastUpdateDate', 'criteria', 'enabled']) {
    ok(fields.includes(`'${f}'`), `a copied alert carries ${f}`);
  }
}

/* --------------------------------------------------- the derived market year

   "Job market year" was a required dropdown on all three forms. Its answer is
   a function of the calendar, so on the two forms where the filing date IS the
   answer it is now derived and merely stated (owner, 2026-08-17).

   The placement form KEEPS its picker deliberately: a placement accepted in
   the spring and reported after the 1 July roll belongs to the market it was
   accepted in, which no date on the submission can tell us.

   Two failure modes are pinned here. A form that still asks would be the
   change not landing; a form that RE-STAMPS the year when an old posting is
   edited would silently move it into the current market — which is what the
   defaulted dropdown did, and is why edit mode keeps the stored value. */

async function testDerivedMarketYear() {
  for (const [page, script, noun] of [
    ['post-a-job.html', 'oa-jobform.js', 'posting'],
    ['post-a-candidate.html', 'oa-candidateform.js', 'profile'],
  ]) {
    for (const dir of [[], ['v2']]) {
      const where = [...dir, page].join('/');
      const html = await readFile(path.join(HERE, '..', ...dir, page), 'utf8');
      ok(!/id="f-year"/.test(html), `${where}: the year dropdown is gone`);
      ok(!/Job market year/.test(html), `${where}: and so is the question`);
      ok(/id="oa-year-note"/.test(html),
        `${where}: the season is stated instead, so nothing is hidden from the ${noun}`);

      const js = await readFile(
        path.join(HERE, '..', ...dir, 'assets', script), 'utf8');
      ok(/out\.year = postingYear\(\);/.test(js),
        `${where}: the year is derived, not read from the form`);
      ok(/return \(EDIT_ID && EDIT_YEAR\) \|\| jobMarketYears\(\)\.current;/.test(js),
        `${where}: an edit keeps the season it was filed in, a new one takes today's`);
      ok(/EDIT_YEAR = Number\(v\.year\) \|\| 0;/.test(js),
        `${where}: and the stored season is captured when the document loads`);
      ok(!/\$\('f-year'\)/.test(js), `${where}: nothing still reads the removed field`);
    }
  }

  // the placement form is deliberately untouched — assert that, so a later
  // tidy-up does not take its picker away along with the other two
  for (const dir of [[], ['v2']]) {
    const where = [...dir, 'post-a-placement.html'].join('/');
    const html = await readFile(path.join(HERE, '..', ...dir, 'post-a-placement.html'), 'utf8');
    ok(/id="f-year"/.test(html) && /Job market year/.test(html),
      `${where}: KEEPS its picker — the report date cannot tell us the season`);
  }
}

/* ------------------------------------------------------------- countries

   ONE SPELLING PER COUNTRY (owner, 2026-08-17). The country is free text on
   the form and was free text in the spreadsheets the archive came from, so one
   country arrived under several names — 142 rows said "USA", 12 said "UK" and
   4 "United Kingdom", plus "Hong Kong SAR", "The Netherlands", "Republic of
   Korea", "Russian Federation", "China (Shanghai)" and "Shenzhen, China".
   Each was its OWN entry in the jobs page's Location filter, so filtering on
   United Kingdom showed a quarter of the British postings.

   assets/oa-countries.js is the one definition, loaded by the browser and
   required by the build. What is pinned here is every way the fix could come
   undone: the module's own decisions, the data drifting back, an ingest point
   that forgets to canonicalise, and — the one that would be silent — an
   e-mail alert saved under the old spelling quietly matching nothing. */

async function testCountries() {
  const C = require(path.join(HERE, '..', 'assets', 'oa-countries.js'));

  // the list itself
  ok(C.LIST.length >= 190, `the canonical list covers the world (${C.LIST.length} countries)`);
  eq(C.LIST, C.LIST.slice().sort((a, b) => a.localeCompare(b, 'en')),
    'it is alphabetical, so a reader can find their country');
  eq(new Set(C.LIST).size, C.LIST.length, 'and holds no duplicate');
  const notCanon = C.LIST.filter((c) => !C.isCanonical(c));
  eq(notCanon, [], 'every name in the list is its own canonical form');

  // the full names the owner asked for, and no second spelling of them
  ok(C.LIST.includes('United States') && !C.LIST.includes('USA'),
    'the United States is listed under its full name');
  ok(C.LIST.includes('United Kingdom') && !C.LIST.includes('UK'),
    'and so is the United Kingdom');

  // every variant the two datasets actually contained
  for (const [given, want] of [
    ['USA', 'United States'], ['UK', 'United Kingdom'],
    ['The Netherlands', 'Netherlands'], ['Hong Kong SAR', 'Hong Kong'],
    ['Republic of Korea', 'South Korea'], ['Russian Federation', 'Russia'],
    ['China (Shanghai)', 'China'], ['Shenzhen, China', 'China'],
  ]) {
    eq(C.canon(given), want, `"${given}" is published as "${want}"`);
  }

  // shapes, not just the table: case, punctuation, spacing and the two
  // qualifier forms the spreadsheets used
  eq(C.canon('usa'), 'United States', 'the lookup ignores case');
  eq(C.canon('U.S.A.'), 'United States', 'and punctuation');
  eq(C.canon('  France  '), 'France', 'and surrounding space');
  eq(C.canon('Korea, South'), 'South Korea', 'a comma list is understood');

  // …and it NEVER invents one
  eq(C.canon('Ruritania'), 'Ruritania', 'a country it does not know is left exactly as given');
  eq(C.canon(''), '', 'and an empty value stays empty');
  eq(C.canon(null), '', 'as does a missing one');

  /* THE DATA. Both served datasets, and the tallies their filter counts come
     from, carry canonical names only — this is what would rot if a future
     import forgot to canonicalise. */
  for (const [rowsFile, metaFile] of [
    ['jobs.json', 'jobs-meta.json'],
    ['past-postings.json', 'past-postings-meta.json'],
  ]) {
    const rows = JSON.parse(await readFile(path.join(HERE, '..', 'data', rowsFile), 'utf8'));
    const bad = [...new Set(rows.map((r) => r.country).filter(Boolean))]
      .filter((c) => !C.isCanonical(c));
    eq(bad, [], `data/${rowsFile}: every posting names its country the one way`);

    const meta = JSON.parse(await readFile(path.join(HERE, '..', 'data', metaFile), 'utf8'));
    const badMeta = Object.keys(meta.countries || {}).filter((c) => !C.isCanonical(c));
    eq(badMeta, [], `data/${metaFile}: and so does the tally the filter counts come from`);
  }

  /* THE INGEST POINTS. The data is rebuilt from Firestore every day, so a
     one-off rewrite is worth nothing unless the writers canonicalise too. */
  const row = rowFromSubmission({
    institution: 'U', department: 'D', country: 'USA', type: 'University',
    levels: ['Assistant Professor'], uid: 'u1', ref: 'OA-JOB-1',
    createdAt: '2026-08-01T10:00:00Z',
  });
  eq(row.country, 'United States',
    'a submission that says "USA" is PUBLISHED as "United States"');
  const sheet = await readFile(path.join(HERE, 'import-sheet.mjs'), 'utf8');
  ok(/const country = canonCountry\(text\(/.test(sheet),
    'and so is a row imported from a spreadsheet');

  /* THE ALERTS — the silent one. A subscription saved when the site said
     "USA" holds that string for ever; without canonicalising both sides it
     would simply stop matching, and nobody would see anything wrong. */
  const M = require(path.join(HERE, '..', 'assets', 'oa-alert-match.js'));
  const usRow = { country: 'United States', type: 'University', institution: 'X',
    department: 'Y', levels: ['Assistant Professor'], characteristics: [] };
  ok(M.matchesJob(usRow, { topics: ['jobs'], country: ['USA'] }),
    'an alert saved under the old spelling still matches the postings it asked for');
  ok(M.matchesJob(usRow, { topics: ['jobs'], country: ['United States'] }),
    'and so does one saved under the new');
  ok(!M.matchesJob(usRow, { topics: ['jobs'], country: ['Canada'] }),
    'while a country the subscriber did not ask for is still excluded');
  eq(M.normalise({ topics: ['jobs'], country: ['USA', 'UK'] }).country,
    ['United States', 'United Kingdom'],
    'and the alerts form ticks the canonical boxes when that alert is opened to edit');

  /* THE PAGES. The form offers the shared list rather than a copy of it, and
     every page that needs the module loads it BEFORE its consumer. */
  for (const dir of [[], ['v2']]) {
    const form = await readFile(path.join(HERE, '..', ...dir, 'assets', 'oa-jobform.js'), 'utf8');
    ok(/var COUNTRIES = \(window\.OACountries && window\.OACountries\.LIST\) \|\| \[\];/.test(form),
      `${[...dir, 'oa-jobform.js'].join('/')}: the form offers the shared list, not its own copy`);
  }
  for (const [page, consumer] of [
    ['post-a-job.html', 'oa-jobform.js'],
    ['alerts.html', 'oa-alert-match.js'],
    ['jobs.html', 'oa-list.js'],
    ['previous-markets.html', 'oa-list.js'],
    [path.join('v2', 'post-a-job.html'), 'oa-jobform.js'],
    [path.join('v2', 'alerts.html'), 'oa-alert-match.js'],
    [path.join('v2', 'jobs.html'), 'oa-list.js'],
    [path.join('v2', 'previous-markets.html'), 'oa-list.js'],
  ]) {
    const html = await readFile(path.join(HERE, '..', page), 'utf8');
    const at = html.indexOf('oa-countries.js');
    ok(at !== -1 && at < html.indexOf(consumer),
      `${page}: loads the countries module before ${consumer}`);
  }

  // a link shared when the site said "USA" still selects the right country
  for (const page of ['jobs.html', 'previous-markets.html',
    path.join('v2', 'jobs.html'), path.join('v2', 'previous-markets.html')]) {
    const html = await readFile(path.join(HERE, '..', page), 'utf8');
    ok(/legacyValues: \(window\.OACountries \|\| \{\}\)\.ALIASES/.test(html),
      `${page}: an old ?country=USA link still selects the United States`);
  }
}


/* --------------------------------------- one spelling per school and unit

   assets/oa-schools.js, on exactly the terms oa-countries.js is held to: the
   module's own decisions, the committed data not drifting back, and every
   ingest point still canonicalising — because data/jobs.json is rebuilt from
   Firestore every morning, so a one-off rewrite is worth nothing on its own.

   The case that started it: Tulane's one department was published as five
   different places, so a reader filtering the archive on Tulane could not
   tell which of the five was the department they were looking at.           */

async function testSchools() {
  const S = require(path.join(HERE, '..', 'assets', 'oa-schools.js'));

  // Tulane: the five spellings the archive actually held, now one place
  for (const [school, unit] of [
    ['Freeman School of Business', 'Management Science'],
    ['Freeman School of Business', 'Management Sciences Area'],
    ['A.B. Freeman School of Business', 'Management Science Department'],
    ['A. B. Freeman School of Business / Management Sciecne', ''],
    ['A. B. Freeman School of Business', 'Management Science'],
  ]) {
    const p = S.canonPlace({ institution: 'Tulane University', school, unit });
    eq([p.school, p.unit], ['A. B. Freeman School of Business', 'Management Science'],
      `"${school}${unit ? ', ' + unit : ''}" is published as the one department`);
  }

  // the wrapper word is the house style, not the name
  for (const given of ['Department of Operations Management', 'Operations Management Department',
    'Operations Management Area', 'The Operations Management group', 'Area of Operations Management',
    'Operations Management Division']) {
    eq(S.canonUnit(given), 'Operations Management', `"${given}" names the same department`);
  }

  // spelling, abbreviations and the trailing short form
  eq(S.canonUnit('Analytics & Operations Group'), 'Analytics and Operations', '"&" joins names');
  eq(S.canonUnit('Department of Operations & Info Systems'), 'Operations and Information Systems',
    'and abbreviations are spelt out');
  eq(S.canonUnit('Department of Industrial Engineering and Operations Research (IEOR)'),
    'Industrial Engineering and Operations Research', 'a trailing acronym is not part of the name');
  eq(S.canonUnit('Department'), '', 'a wrapper word alone names nothing');

  // a school field naming the department too
  eq(S.canonPlace({ school: 'Kelley School of Business - Operations and Decision Technologies' }),
    { institution: '', school: 'Kelley School of Business', unit: 'Operations and Decision Technologies' },
    'a department fused into the school field is moved across');
  eq(S.canonPlace({ institution: 'Texas A&M University',
    school: 'Department of Information and Operations Management (INFO) at Mays Business School' }),
    { institution: 'Texas A&M University', school: 'Mays Business School',
      unit: 'Information and Operations Management' },
    'and so is one written the other way round');

  // the archive's one-column rows, split into the three fields the form asks for
  eq(S.canonPlace({ institution: 'University of Pennsylvania (The Wharton School), Operations and Information Management (OPIM) Department' }),
    { institution: 'University of Pennsylvania', school: 'Wharton School',
      unit: 'Operations and Information Management' },
    'a legacy row naming all three is taken apart');
  eq(S.canonPlace({ institution: 'University of California, Los Angeles (UCLA, Anderson School of Management), Decisions, Operations and Technology Management (DOTM)' }),
    { institution: 'University of California, Los Angeles', school: 'Anderson School of Management',
      unit: 'Decisions, Operations and Technology Management' },
    'including one whose campus and department both carry commas');

  // …and the names a comma is simply PART of are left alone
  for (const given of ['University of California, Berkeley', 'The Chinese University of Hong Kong, Shenzhen',
    'Baruch College, The City University of New York (CUNY)']) {
    eq(S.canonPlace({ institution: given }).institution, given,
      `"${given}" is one university's name, not a university and a department`);
  }
  eq(S.canonPlace({ school: 'Institut Mines-Télécom Business School' }).school,
    'Institut Mines-Télécom Business School', 'and a hyphen inside a name is not a separator');
  eq(S.canonPlace({ school: 'Bayes Business School, Faculty of Management' }).school,
    'Bayes Business School, Faculty of Management', 'nor is a comma between two school names');

  // …and it NEVER invents one
  eq(S.canonSchool('School of Wizardry'), 'School of Wizardry',
    'a school it does not know is left exactly as given');
  eq(S.canonUnit('Department of Wizardry'), 'Wizardry', 'and only its wrapper word comes off');
  eq(S.canonSchool(''), '', 'an empty value stays empty');
  eq(S.canonInstitution(null), '', 'as does a missing one');

  // it is safe to run twice — every writer applies it on every rebuild
  for (const row of [{ institution: 'Tulane University', school: 'Freeman School of Business', unit: 'Management Sciences Area' },
    { institution: 'University of Pennsylvania (The Wharton School), Operations and Information Management (OPIM) Department' }]) {
    const once = S.canonPlace(row);
    eq(S.canonPlace(once), once, 'canonicalising an already-canonical row changes nothing');
  }

  /* THE DATA. Both served datasets carry canonical names only, and the
     published `department` line is the two parts joined — the shape the card
     and the filters read. */
  for (const file of ['jobs.json', 'past-postings.json']) {
    const rows = JSON.parse(await readFile(path.join(HERE, '..', 'data', file), 'utf8'));
    const bad = rows.filter((r) => {
      const p = S.canonPlace(r);
      return p.institution !== r.institution || p.school !== (r.school || '') || p.unit !== (r.unit || '');
    }).map((r) => r.id);
    eq(bad, [], `data/${file}: every posting names its university, school and department the one way`);

    const line = rows.filter((r) => r.department !== joinDepartment(r.school, r.unit)).map((r) => r.id);
    eq(line, [], `data/${file}: and the line the card shows is those two, joined`);
  }

  /* THE PLACE THE COMPLAINT CAME FROM. previous-markets.html?university=tulane:
     five postings, one department. */
  const archive = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'past-postings.json'), 'utf8'));
  const jobs = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'jobs.json'), 'utf8'));
  const tulane = [...jobs, ...archive].filter((r) => /tulane/i.test(r.institution));
  ok(tulane.length >= 5, `the archive still holds every Tulane posting (${tulane.length})`);
  eq([...new Set(tulane.map((r) => r.school))], ['A. B. Freeman School of Business'],
    'and they all name one school');
  eq([...new Set(tulane.map((r) => r.unit))].filter(Boolean), ['Management Science'],
    'and one department');

  /* THE INGEST POINTS, all three, or tomorrow's build brings the spellings
     back. */
  const row = rowFromSubmission({
    institution: 'Tulane University', school: 'Freeman School of Business',
    unit: 'Management Sciences Area', country: 'United States', type: 'University',
    levels: ['Assistant Professor'], uid: 'u1', ref: 'OA-JOB-1',
    createdAt: '2026-08-01T10:00:00Z',
  });
  eq([row.school, row.unit], ['A. B. Freeman School of Business', 'Management Science'],
    'a submission is published under the canonical names');
  for (const file of ['import-sheet.mjs', 'jobmarket-sheet.mjs']) {
    const src = await readFile(path.join(HERE, file), 'utf8');
    ok(/canonPlace\(\{ institution/.test(src), `${file}: and so is a row read from a spreadsheet`);
  }

  // the form applies it too, so a poster's own preview reads as it will publish
  const form = await readFile(path.join(HERE, '..', 'assets', 'oa-jobform.js'), 'utf8');
  ok(/window\.OASchools\.canonPlace/.test(form),
    'oa-jobform.js: the form canonicalises what the poster typed');
  const page = await readFile(path.join(HERE, '..', 'post-a-job.html'), 'utf8');
  ok(page.indexOf('oa-schools.js') !== -1 &&
     page.indexOf('oa-schools.js') < page.indexOf('oa-jobform.js'),
    'post-a-job.html: and loads the module before the form');

  // the vocabulary the form offers is built from the canonical names
  const vocab = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'vocab.json'), 'utf8'));
  const badSchools = vocab.schools.map((e) => e.v).filter((v) => S.canonSchool(v) !== v);
  eq(badSchools, [], 'data/vocab.json: the form offers canonical school names');
  const badUnits = vocab.units.map((e) => e.v).filter((v) => S.canonUnit(v) !== v);
  eq(badUnits, [], 'and canonical department names');
}

/* ----------------------------------------- the forms fit their create rules

   Each create rule bounds a submission's number of keys; each form writes a
   knowable maximum. The two live in different files, and their drifting apart
   is the bug this guard exists for: the job form grew to 31 keys — 27 always,
   plus the four adUpload* fields of an UPLOADED advert — while the rule still
   said 30, so a posting with an attached file, and only that one, was refused
   as permission-denied and reported as "the site is not accepting postings".

   The inventory is EXTRACTED from each form's source (every need()/urlFields
   key, `out.x =`, `doc.x =` and upload-slot field), so a field added to a
   form counts here automatically. It slightly overcounts — updatedAt is
   written only on the edit path, which has no ceiling — and overcounting is
   the safe direction for a guard that demands ceiling >= count. */

async function testSubmissionKeyCeilings() {
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');

  const ceilingOf = (col) => {
    const m = new RegExp(`match /${col}/\\{id\\} \\{[\\s\\S]*?keys\\(\\)\\.size\\(\\) <= (\\d+)`)
      .exec(rules);
    return m ? Number(m[1]) : null;
  };

  const keysOf = (src) => {
    const keys = new Set();
    for (const re of [
      /\bneed\('f-[A-Za-z]+',\s*'([A-Za-z]+)'/g,        // need('f-x', 'x', …)
      /\bout\.([A-Za-z]+)\s*=[^=]/g,                    // out.x = …
      /\[\s*'f-[A-Za-z]+',\s*'([A-Za-z]+)'\s*\]/g,      // the urlFields tuples
      /\bdoc\.([A-Za-z]+)\s*=[^=]/g,                    // doc.x = … at submit
    ]) for (const m of src.matchAll(re)) keys.add(m[1]);
    // the candidate form's two upload slots write their fields dynamically
    for (const m of src.matchAll(/doc\[prefix \+ '([A-Za-z]+)'\]\s*=/g)) {
      keys.add('cv' + m[1]);
      keys.add('rs' + m[1]);
    }
    return keys;
  };

  for (const [file, col] of [
    ['oa-jobform.js', 'jobSubmissions'],
    ['oa-candidateform.js', 'candidateSubmissions'],
    ['oa-placementform.js', 'placementSubmissions'],
  ]) {
    const ceiling = ceilingOf(col);
    ok(ceiling !== null, `${col}: the create rule bounds the number of keys`);
    for (const dir of [['assets'], ['v2', 'assets']]) {
      const src = await readFile(path.join(HERE, '..', ...dir, file), 'utf8');
      const n = keysOf(src).size;
      ok(n >= 10, `${dir.join('/')}/${file}: the key inventory extracted (${n} keys, sanity floor 10)`);
      ok(ceiling !== null && n <= ceiling,
        `${dir.join('/')}/${file} can write ${n} keys; the ${col} create rule allows ${ceiling}`);
    }
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
  /* the wrapper word comes off on the way in — "group", "Area" and
     "Department" are three houses' words for one department (oa-schools.js) */
  eq(r.unit, 'Operations Management', 'unit carried, wrapper word off');
  eq(r.department, 'Fuqua School of Business, Operations Management',
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
  eq(legacy.unit, 'Analytics', 'and a unit');
  eq(legacy.department, 'NUS Business School, Analytics',
    'and its published line reads as the canon publishes it');

  ok(PUBLIC_FIELDS.includes('school') && PUBLIC_FIELDS.includes('unit'),
    'both parts are published');
}

/* ------------------------------------------- the migration off the sheet

   Every existing posting has to become a document that can be edited, and the
   only faithful way to build one is to invert the mapping. So the inverse is
   checked against the REAL committed file, field by field: a migration that
   rewrites the site's content while moving it is worse than no migration.   */

async function testMigrationRoundTrip() {
  /* Only what the migration would actually touch. A posting from the job
     market tracking sheet is rebuilt from the workbook on every sync and is
     deliberately never given a document (see migratable()), so holding it to
     the round trip would fail this guard over rows nothing migrates — and the
     sheet cannot answer every question a submission asks (it has no "type of
     institution" column, and a row it does not answer publishes without one). */
  const rows = JSON.parse(await readFile(JOBS, 'utf8')).filter(migratable);
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
  const all = JSON.parse(await readFile(JOBS, 'utf8'));
  // the migration's own set — a sheet-sourced posting is never given a
  // document, see migratable()
  const rows = all.filter(migratable);

  /* Every row must be addressable as a document id — held to EVERY posting,
     sheet-sourced or not: the id is also the card's DOM id and the key the
     page stores its expanded state under, so a value that is not id-shaped is
     a bug wherever it came from. */
  const unusable = all.filter((r) => !docIdFor(r)).map((r) => r.id);
  eq(unusable, [], 'every posting id is usable as a Firestore document id');
  eq(new Set(all.map(docIdFor)).size, all.length, 'and they are distinct');

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
  /* The data files are written once at the root and read by every version of
     the site, so the pages name them absolutely — that is the rule
     archive-v2.mjs enforces for /v2/ and link-check.mjs exempts from the
     tree boundary. A relative path here would work at the root and break the
     moment this tree were previewed under a directory, which is exactly how
     the redesign was built. */
  const rfHtml = await readFile(path.join(HERE, '..', 'recent-faculty.html'), 'utf8');
  ok(rfHtml.includes("data: '/data/recent-faculty.json'"), 'recent-faculty.html reads its dataset');
  ok(rfHtml.includes("legacyParam: 'filterE'") && rfHtml.includes("legacyParam: 'filterF'"),
    'recent-faculty.html honours ?filterE (recent hires) and ?filterF (PhD alumni)');

  const pmHtml = await readFile(path.join(HERE, '..', 'previous-markets.html'), 'utf8');
  ok(pmHtml.includes("data: '/data/past-postings.json'"), 'previous-markets.html reads the archive');
  ok(pmHtml.includes("fetch('/data/jobs.json'"),
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

  /* EVERY link a school's popup offers must land PRE-FILTERED on that school.
     Four of the five reach pages, and their filter keys are pinned above. The
     fifth — the candidates list — is a SECTION of the one-pager here, so the
     engine's default (candidates.html?affiliation=…) would follow a redirect
     that drops the query and show every candidate instead of the school's.
     The page names the target; the key it names must be the one the
     one-pager's candidates mount actually reads, prefix included. */
  const idxHtml = await readFile(path.join(HERE, '..', 'index.html'), 'utf8');
  const candPrefix = (idxHtml.match(/mount: '#oa-candidates',[\s\S]{0,400}?urlPrefix: '([^']*)'/) || [])[1];
  ok(candPrefix !== undefined, 'index.html: the candidates mount declares its URL prefix');
  ok(/candidatesHref: function \(q\) \{ return '\.\/\?/.test(uniHtml),
    'universities.html names where the candidates list lives, rather than taking the default');
  ok(candPrefix !== undefined &&
     uniHtml.includes(`'./?${candPrefix}affiliation=' + q + '#candidates'`),
    `universities.html deep-links the candidates section on ${candPrefix}affiliation, the key it reads`);
  ok(/{ key: 'affiliation'/.test(idxHtml),
    'index.html: and the candidates mount carries an affiliation filter to receive it');
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

/* ------------------------------------------- the job market tracking sheet

   The workbook the maintainer keeps by hand — one per market cycle, a tab per
   kind of position — read by _scraper/jobmarket-sheet.mjs. Everything below is
   offline: the parsing, the mapping, the roll-over to next year's workbook and
   the decision to send the "this sheet has gone quiet" e-mail are all pure
   functions, precisely so that none of it needs the network to be checked.

   THE FIXTURE IS REAL DATA. The rows are the ones the owner pasted from the
   "2026 NTT/PD" tab, tabs and all, so a change to the mapping is measured
   against what the sheet actually holds rather than against a convenient
   invention.                                                                  */

const JMS_ROWS = [
  ['9', 'Clarkson University', 'Potsdam, NY', 'USA', '20-Jul-26',
    'Operations and Information Systems', 'Visiting Assistant Professor', '', '', '',
    'https://www.higheredjobs.com/faculty/details.cfm?JobCode=179504973', '1'],
  ['10', 'University of California Berkeley', 'Berkeley, CA', 'USA', '22-Jul-26',
    'Operations and IT Management', 'Lecturer', '', '', '',
    'https://business.academickeys.com/job/z8gs65qr/Lecturer', '1'],
  ['18', 'Princeton University', 'Princeton, NJ', 'USA', '8-Aug-26',
    'OR & Financial Engineering', 'Postdoctoral Research Associate', '', '', '',
    'https://www.higheredjobs.com/faculty/details.cfm?JobCode=179521035', ''],
  ['22', 'Rutgers Business School–Newark and New Brunswick', 'New Jersey ', 'USA', '12-Aug-26',
    'MS and IS', 'Assistant Professor of Professional Practice', '', '', '',
    'https://jobs.chronicle.com/job/38018595/', ''],
];

/* The last column is the one whose meaning is NOT known — the sheet carries a
   flag there ("1" on some rows, blank on others) that nothing here can safely
   interpret. It is named as something this pipeline does not recognise on
   purpose, so the tests below pin the two things that matter: it is REPORTED
   in the run's log, and its value never reaches a posting. */
const JMS_HEAD = ['#', 'University', 'City/State', 'Country', 'Date', 'Field', 'Position',
  '', '', '', 'Link', 'Checked'];

const csvOf = (rows) => rows
  .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
  .join('\n') + '\n';

function testJobMarketSheetParsing() {
  // the dates the sheet actually uses, and the ones a person might type
  eq(sheetDay('20-Jul-26'), '2026-07-20', 'the sheet\'s own date format');
  eq(sheetDay('8-Aug-26'), '2026-08-08', 'a single-digit day');
  eq(sheetDay('5-Aug-26'), '2026-08-05', 'and another');
  eq(sheetDay('2026-07-20'), '2026-07-20', 'ISO');
  eq(sheetDay('7/20/2026'), '2026-07-20', 'US order, which is what Google writes');
  eq(sheetDay('20/07/2026'), '2026-07-20',
    'a first field over 12 can only be a day, so day-first is read as meant');
  eq(sheetDay('20 July 2026'), '2026-07-20', 'a spelled-out month');
  eq(sheetDay('July 20, 2026'), '2026-07-20', 'month first');
  eq(sheetDay('30-Feb-26'), '', 'a day that does not exist is not a date');
  eq(sheetDay('until filled'), '', 'and neither is prose');
  eq(sheetDay(''), '', 'nor an empty cell');
  eq(daysBetween('2026-08-01', '2026-08-15'), 14, 'whole days between two days');

  // which tabs are read, and which are not
  eq(classifyTab('2026 Jobs'), { year: 2026, kind: 'jobs' }, 'a jobs tab');
  eq(classifyTab('2026 NTT/PD'), { year: 2026, kind: 'ntt-pd' }, 'an NTT/PD tab');
  eq(classifyTab('2027 NTT-PD'), { year: 2027, kind: 'ntt-pd' }, 'however it is punctuated');
  eq(classifyTab('Jobs 2026'), { year: 2026, kind: 'jobs' }, 'whichever way round it is written');
  eq(classifyTab('2026 NTT/PD Jobs'), { year: 2026, kind: 'ntt-pd' },
    'a tab naming both kinds is the NTT one — it says so first');
  eq(classifyTab('Intro'), null, 'the intro tab is not a data tab');
  eq(classifyTab('Placements'), null, 'nor is a tab with no year');
  eq(classifyTab(''), null, 'nor an unnamed one');
  ok(isIntroTab('intro') && isIntroTab('Introduction') && isIntroTab('Read me'),
    'the intro tab is recognised however it is spelled');
  ok(!isIntroTab('2026 Jobs'), 'and a data tab is not mistaken for it');
  ok(conventionalTabs([2026]).includes('2026 Jobs') &&
     conventionalTabs([2026]).includes('2026 NTT/PD'),
    'the fallback names cover both kinds of tab');

  // rank -> the five entry levels the site offers
  eq(levelsFromRank('Visiting Assistant Professor'), ['Visiting Faculty (various levels)'],
    'a visiting assistant professorship is a VISITING post, not an assistant professorship');
  eq(levelsFromRank('Postdoctoral Research Associate'), ['Post-Doc'], 'a post-doc');
  eq(levelsFromRank('Lecturer'), ['Non-tenure track (teaching) position'], 'a lecturer');
  eq(levelsFromRank('Professor of Practice - Decision & Information Sciences'),
    ['Non-tenure track (teaching) position'], 'a professor of practice');
  eq(levelsFromRank('Open-Rank Clinical Professor'), ['Non-tenure track (teaching) position'],
    'a clinical professorship, whatever its rank');
  eq(levelsFromRank('Assistant Professor'), ['Assistant Professor'], 'a tenure-track post');
  eq(levelsFromRank('Open Rank'), ['Other Ranks'], 'an open-rank search');
  eq(levelsFromRank('non TTAP'), ['Non-tenure track (teaching) position'],
    'the sheet\'s "non TTAP" is a NON-tenure-track post — it differs from the ' +
    'tenure-track one by that word alone');
  eq(levelsFromRank('TTAP'), ['Assistant Professor'], 'while "TTAP" is the tenure-track one');
  eq(levelsFromRank('Academic General Faculty'), ['Non-tenure track (teaching) position'],
    'Virginia\'s wording for a teaching post');
  eq(levelsFromRank('Professional in Residence'), ['Non-tenure track (teaching) position'],
    'and Utah Valley\'s');
  eq(levelsFromRank('', 'ntt-pd'), ['Non-tenure track (teaching) position'],
    'with no rank given, an NTT/PD tab asserts non-tenure-track by its own name');
  eq(levelsFromRank('', 'jobs'), ['Other Ranks'],
    'while a jobs tab asserts nothing about the rank');
  eq(levelsFromRank('Something nobody has heard of'), ['Other Ranks'],
    'and an unrecognised title is not silently dropped');

  // institution -> type of institution
  eq(typeFromNames('Rutgers Business School–Newark', 'MS and IS'), 'Business School',
    'a business school says so in its name');
  eq(typeFromNames('Clarkson University', 'Operations'), 'University', 'and a university in its');
  eq(typeFromNames('Rollins College', 'SCM'), 'University', 'as does a college');
  eq(typeFromNames('INSEAD', 'Technology and Operations Management'), '',
    'a name that answers neither leaves the type empty rather than guessing');
  eq(typeFromNames('Some Employer', 'Department of Business Administration'), 'Business School',
    'the field column can name the school when the institution does not');
}

function testJobMarketSheetColumns() {
  const head = mapColumns(JMS_HEAD);
  eq(head.missing, [], 'the sheet\'s own header row maps the columns it must have');
  eq(head.index.institution, 1, 'University is the institution');
  eq(head.index.city, 2, 'City/State is the town');
  eq(head.index.country, 3, 'Country is the country');
  eq(head.index.posted, 4, 'Date is the posting date');
  eq(head.index.area, 5, 'Field is the area');
  eq(head.index.rank, 6, 'Position is the rank');
  eq(head.index.link, 10, 'Link is the advertisement');

  /* "Location" is an alias of `city`, and also the word the OLD sheet used for
     the country. A workbook carrying both must not give the country column to
     whichever field asked first — exact matches are taken before loose ones. */
  const both = mapColumns(['University', 'Location', 'Country', 'Date']);
  eq(both.index.city, 1, 'a sheet with both Location and Country reads Location as the town');
  eq(both.index.country, 2, 'and Country as the country');

  // a column nobody recognises is REPORTED, never silently read as something
  const odd = mapColumns(['#', 'University', 'Date', 'Headcount']);
  eq(odd.unmapped.map((u) => u.header), ['Headcount'],
    'an unknown column is reported so it can be asked about');
  eq(odd.missing, [], 'and does not stop the tab being read');
  eq(mapColumns(['#', 'No', 'S/N']).unmapped, [],
    'a numbering column is not a field anybody is missing');

  eq(normHeader('Date (MM/DD/YY)'), 'date', 'a header is compared without its parenthetical');
  eq(mapColumns(['Foo', 'Bar']).missing, ['institution', 'posted'],
    'a header row that names neither is refused rather than half-read');

  /* NO HEADER AT ALL. A tracking sheet can start straight at the data, so the
     columns are inferred from evidence — dates parse, countries are countries,
     links are URLs — and the result must agree with what the header says. */
  const guess = inferColumns(JMS_ROWS);
  eq(guess.missing, [], 'a headerless tab still yields the columns it must have');
  eq(guess.index.posted, 4, 'the date column is the one holding dates');
  eq(guess.index.country, 3, 'the country column is the one holding countries');
  eq(guess.index.institution, 1, 'the institution is the first prose column, past the numbering');
  eq(guess.index.link, 10, 'the link column is the one holding URLs');
  eq(guess.index.area, 5, 'the area is the prose after the date');
  eq(guess.index.rank, 6, 'and the rank is the prose after that');

  eq(resolveColumns([JMS_HEAD, ...JMS_ROWS]).at, 0, 'a header row is found where there is one');
  eq(resolveColumns([JMS_HEAD, ...JMS_ROWS]).inferred, false, 'and inference is not needed');
  eq(resolveColumns(JMS_ROWS).at, -1, 'with no header, every row is data');
  eq(resolveColumns(JMS_ROWS).inferred, true, 'and the run says the columns were inferred');
}

function testJobMarketSheetRows() {
  const withHead = rowsFromTab(csvOf([JMS_HEAD, ...JMS_ROWS]),
    { tab: '2026 NTT/PD', kind: 'ntt-pd', minYear: 2026 });
  const headless = rowsFromTab(csvOf(JMS_ROWS),
    { tab: '2026 NTT/PD', kind: 'ntt-pd', minYear: 2026 });

  eq(withHead.rows.length, 4, 'every posting in the fixture is read');
  eq(withHead.rows.map((r) => r.id), headless.rows.map((r) => r.id),
    'and a tab with no header row reads exactly the same postings');

  const clarkson = withHead.rows.find((r) => r.institution === 'Clarkson University');
  eq(clarkson.posted, '2026-07-20', 'the posting date is the sheet\'s date');
  eq(clarkson.year, 2027,
    'and the market year is derived from it by the SITE\'s roll rule — a July 2026 ' +
    'posting belongs to the 2026-2027 market, whatever the tab is called');
  eq(clarkson.country, 'United States', '"USA" is published as "United States"');
  eq(clarkson.levels, ['Visiting Faculty (various levels)'], 'the rank becomes an entry level');
  eq(clarkson.department, 'Operations and Information Systems', 'the field becomes the department');
  eq(clarkson.comments, 'Visiting Assistant Professor · Potsdam, NY',
    'the job title as advertised and the town are kept — the row\'s shape has ' +
    'nowhere else to put them, and dropping them would lose the most useful part');
  eq(withHead.unmapped.map((u) => u.header), ['Checked'],
    'a column whose meaning is not known is reported in the run\'s log');
  ok(!/\bChecked\b|·\s*1\b/.test(clarkson.comments),
    'and its value is never published as though it meant something');
  eq(clarkson.source, SHEET_SOURCE, 'every row says where it came from');
  ok(clarkson.adUrl.startsWith('https://'), 'the advertisement link is carried');
  eq(clarkson.applyBy, 'Until filled.',
    'a sheet that gives no deadline reads "Until filled." — which is what the ' +
    'page\'s own Deadline filter already buckets a dateless posting as, so the ' +
    'card and the filter say the same thing');
  eq(clarkson.applyByDate, '', 'and NO date is stored, which is what puts it in that bucket');
  eq(clarkson.featured, false, 'nothing from the sheet is featured');
  eq(clarkson.id, '2027-clarkson-university-20260720', 'the id is the site\'s own shape');

  // the deadline column, when the sheet has one
  const withDeadline = rowsFromTab(csvOf([
    ['University', 'Country', 'Date', 'Deadline'],
    ['A School', 'USA', '1-Sep-26', '15-Nov-26'],
    ['B School', 'USA', '1-Sep-26', 'Until filled'],
  ]), { minYear: 2026 });
  eq(withDeadline.rows.find((r) => r.institution === 'A School').applyByDate, '2026-11-15',
    'a deadline is read as a date');
  eq(withDeadline.rows.find((r) => r.institution === 'A School').applyBy, 'November 15, 2026',
    'and shown the way the site writes dates');
  eq(withDeadline.rows.find((r) => r.institution === 'B School').applyByDate, '',
    'an open-ended search carries NO date — the page buckets "until filled" on ' +
    'the date being empty, so a row with both would read as dated');

  // rows that are not postings
  const messy = rowsFromTab(csvOf([
    JMS_HEAD,
    ...JMS_ROWS,
    ['', 'Total', '', '', '', '', '', '', '', '', '', ''],
    ['99', '', '', '', '1-Sep-26', '', '', '', '', '', '', ''],
  ]), { tab: '2026 Jobs', kind: 'jobs', minYear: 2026 });
  eq(messy.rows.length, 4, 'a legend or total line under the data is not a posting');
  eq(messy.skipped, 2, 'and the run says how many rows it stepped over');

  // a season the site no longer carries
  const old = rowsFromTab(csvOf([
    JMS_HEAD, ['1', 'Ancient University', 'X', 'USA', '20-Jul-19', 'OM', 'Lecturer',
      '', '', '', '', ''],
  ]), { minYear: 2026 });
  eq(old.rows.length, 0, 'a posting from a closed season is not republished');

  // nothing that would be a disclosure, or a script, reaches the dataset
  const nasty = rowsFromTab(csvOf([
    ['University', 'Country', 'Date', 'Field', 'Link'],
    ['A School', 'USA', '1-Sep-26', 'Apply to search@a.edu', 'javascript:alert(1)'],
    ['B School', 'USA', '2-Sep-26', 'OM', 'https://b.edu/apply?to=chair@b.edu'],
  ]), { minYear: 2026 });
  const blob = JSON.stringify(nasty.rows);
  ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(blob),
    'an e-mail address in the sheet never reaches the served file');
  ok(!/javascript:/i.test(blob), 'and neither does a script URL');
  eq(nasty.rows.find((r) => r.institution === 'B School').adUrl, '',
    'a link with an address in it is dropped rather than published');
  eq(nasty.unlinked, 2, 'and both are reported, so nothing goes missing silently');

  /* Two tabs of one workbook, the same school on the same day. jobId carries
     no department, so without the collapse-then-suffix these would be one row
     — which is how a real advertisement disappears. */
  const jobs = rowsFromTab(csvOf([
    ['University', 'Country', 'Date', 'Field', 'Position'],
    ['One University', 'USA', '1-Sep-26', 'Operations', 'Assistant Professor'],
  ]), { tab: '2026 Jobs', kind: 'jobs', minYear: 2026 });
  const ntt = rowsFromTab(csvOf([
    ['University', 'Country', 'Date', 'Field', 'Position'],
    ['One University', 'USA', '1-Sep-26', 'Marketing', 'Lecturer'],
  ]), { tab: '2026 NTT/PD', kind: 'ntt-pd', minYear: 2026 });
  const both = collectRows([jobs, ntt]);
  eq(both.rows.length, 2, 'two departments advertising on one day are two postings');
  eq(new Set(both.rows.map((r) => r.id)).size, 2, 'and they are given distinct ids');

  const same = collectRows([jobs, jobs]);
  eq(same.rows.length, 1, 'while the SAME posting read twice is one posting');

  // the served projection carries no bookkeeping
  const text = serialiseSheetRows(withHead.rows);
  ok(!text.includes('_tab') && !text.includes('_sheet'),
    'the provenance kept for the log stays out of the served file');
  ok(text.endsWith('\n'), 'the file ends with a newline, so a rebuild that changes ' +
    'nothing commits nothing');
  const meta = buildSheetMeta(withHead.rows, { generated: 'x' });
  eq(meta.count, 4, 'the meta file counts the postings');
  eq(meta.newestPosted, '2026-08-12', 'and knows the newest');
}

function testJobMarketSheetAddedAt() {
  const now = new Date('2026-08-17T09:00:00Z');
  const mk = (id, posted) => ({ id, posted, addedAt: '' });

  /* THE FIRST RUN IS A BACKFILL. `addedAt` is the only cursor the e-mail
     alerts have, so stamping a whole season with "now" would mail every
     subscriber a hundred postings at once. */
  const first = stampAddedAt([mk('a', '2026-07-20'), mk('b', '2026-08-16')], [], { now });
  eq(first.rows[0].addedAt, '2026-07-20T00:00:00Z', 'a backfilled row is dated when it was advertised');
  eq(first.rows[1].addedAt, '2026-08-16T00:00:00Z', 'every one of them, however recent');
  ok(first.backfill, 'and the run knows it was a backfill');

  // afterwards, a genuinely new posting is new
  const existing = [{ id: 'a', posted: '2026-07-20', addedAt: '2026-07-20T00:00:00Z' }];
  const later = stampAddedAt(
    [mk('a', '2026-07-20'), mk('c', '2026-08-16'), mk('d', '2026-05-01')], existing, { now });
  eq(later.rows[0].addedAt, '2026-07-20T00:00:00Z',
    'a row already in the dataset keeps its stamp — re-reading the sheet must ' +
    'never re-announce a posting');
  eq(later.rows[1].addedAt, '2026-08-17T09:00:00Z', 'a new posting is stamped now, and is announced');
  eq(later.rows[2].addedAt, '2026-05-01T00:00:00Z',
    'while one advertised months ago is a catch-up, not news');
  eq(later.fresh, 2, 'the run reports how many it had not seen before');
}

function testJobMarketSheetStaleness() {
  const now = new Date('2026-08-17T09:00:00Z');

  eq(stalenessOf({ ok: true, rows: 40, newestPosted: '2026-08-15', now }).stale, false,
    'a sheet with a posting from two days ago is fine');
  const quiet = stalenessOf({ ok: true, rows: 40, newestPosted: '2026-07-01', now });
  ok(quiet.stale && quiet.reason === 'quiet', 'a sheet with nothing new for weeks is not');
  eq(quiet.days, 47, 'and the message can say how long it has been');

  eq(stalenessOf({ ok: false, error: 'HTTP 403', rows: 0, now }).reason, 'unreadable',
    'a sheet that cannot be read at all is the most urgent case');
  eq(stalenessOf({ ok: true, rows: 0, now }).reason, 'empty',
    'a sheet that reads as empty is reported rather than published');
  eq(stalenessOf({ ok: true, rows: 5, newestPosted: '', now }).reason, 'undated',
    'and so is one whose postings carry no usable date');

  // said once, then not again for a week — but a DIFFERENT failure is news
  const check = stalenessOf({ ok: true, rows: 40, newestPosted: '2026-07-01', now });
  ok(shouldWarn({}, check, { now }), 'the first warning goes out');
  ok(!shouldWarn({ lastWarnedAt: '2026-08-16T09:00:00Z', lastReason: 'quiet' }, check, { now }),
    'and is not repeated the next day');
  ok(shouldWarn({ lastWarnedAt: '2026-08-01T09:00:00Z', lastReason: 'quiet' }, check, { now }),
    'but is said again after a week');
  ok(shouldWarn({ lastWarnedAt: '2026-08-16T09:00:00Z', lastReason: 'quiet' },
    stalenessOf({ ok: false, error: 'HTTP 403', now }), { now }),
    'a different kind of failure is new information and goes out at once');
  ok(!shouldWarn({}, stalenessOf({ ok: true, rows: 40, newestPosted: '2026-08-15', now }), { now }),
    'a healthy sheet sends nothing');
}

async function testJobMarketSheetChain() {
  /* THE ROLL. At the end of a cycle the intro tab links to next year's
     workbook. The link is a HYPERLINK on ordinary text, so it is not in the
     CSV export at all — it is read out of the HTML view, where Google wraps an
     external address in its own redirector. */
  const NEXT = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-x';
  const html = `
    <ul>
      <li id="sheet-button-0" class="sheet-button">Intro</li>
      <li id="sheet-button-1514861818" class="sheet-button">2026 NTT/PD</li>
      <li id="sheet-button-99" class="sheet-button">2026 Jobs</li>
    </ul>
    <td>Next year&#39;s sheet is
      <a href="https://www.google.com/url?q=https%3A%2F%2Fdocs.google.com%2Fspreadsheets%2Fd%2F${NEXT}%2Fedit&amp;sa=D">here</a>
    </td>`;

  eq(tabsFromHtml(html).map((t) => t.name), ['Intro', '2026 NTT/PD', '2026 Jobs'],
    'the tab names are read from the HTML view — the CSV endpoint cannot list them');
  eq(sheetIdsFromHtml(html, { exclude: [SEED_SHEET_ID] }), [NEXT],
    'and so is the link to next year\'s workbook, through Google\'s redirector');
  eq(sheetIdsFromHtml(html, { exclude: [SEED_SHEET_ID, NEXT] }), [],
    'a workbook already known is not adopted twice');
  eq(sheetId('too-short'), '', 'a fragment of a URL is not mistaken for a workbook id');
  ok(sheetCsvUrl('abc', '2026 NTT/PD').includes('sheet=2026%20NTT%2FPD'),
    'a tab name with a slash in it is addressed correctly');
  ok(sheetHtmlUrl('abc').endsWith('/htmlview'), 'the HTML view is where the links are');

  const reg = emptyRegistry();
  eq(reg.current, SEED_SHEET_ID, 'the registry starts at the workbook in use today');
  eq(adoptSheets(reg, [NEXT], { from: SEED_SHEET_ID }).length, 1, 'a linked workbook is adopted');
  eq(adoptSheets(reg, [NEXT], { from: SEED_SHEET_ID }).length, 0, 'and only once');
  ok(activeSheets(reg).includes(NEXT),
    'a newly-found workbook is read at once, so nothing waits for a date');

  /* IT BECOMES CURRENT ON EVIDENCE, NEVER ON THE CALENDAR. A workbook created
     in advance and left empty must not take over, or the site would follow an
     empty sheet for weeks. */
  reg.sheets.find((s) => s.id === SEED_SHEET_ID).rows = 120;
  reg.sheets.find((s) => s.id === SEED_SHEET_ID).newestPosted = '2027-06-02';
  const empty = reg.sheets.find((s) => s.id === NEXT);
  eq(rollRegistry(reg), null, 'an empty successor does not take over');
  eq(reg.current, SEED_SHEET_ID, 'the workbook carrying the market stays current');

  empty.rows = 3;
  empty.newestPosted = '2027-07-04';
  ok(rollRegistry(reg), 'once the successor holds a newer posting, it takes over');
  eq(reg.current, NEXT, 'and becomes the current workbook');
  eq(reg.previous, SEED_SHEET_ID, 'the one it replaced is remembered');
  ok(activeSheets(reg).includes(SEED_SHEET_ID),
    'and is still read — the last postings of a season are filed weeks after the roll');
}

async function testJobMarketSheetWiring() {
  /* The pipeline is three files that have to agree: the sync writes the
     dataset, the build merges it, and the workflow runs the sync. Each link is
     pinned here because a broken one fails SILENTLY — the site simply stops
     gaining postings, which looks exactly like a quiet market. */
  const build = await readFile(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(/data', 'jobmarket\.json'\)/.test(build) || build.includes("'jobmarket.json'"),
    'build-jobs.mjs reads the sheet dataset');
  ok(build.includes('.concat(sheetRows)'),
    'and merges its rows beside the postings from the database');
  ok(/!\(sheetPresent && fromSheet\(r\)\)/.test(build),
    'a posting deleted from the sheet leaves the site — it is not carried as an orphan');
  ok(build.includes('sheetPresent = existsSync(SHEET)'),
    'though a MISSING file is not an empty sheet, and removes nothing');

  const sync = await readFile(path.join(HERE, 'sync-jobmarket-sheet.mjs'), 'utf8');
  ok(sync.includes('the dataset was left exactly as it is'),
    'a workbook that cannot be read writes nothing at all');
  ok(sync.includes('SHRINK_FLOOR'), 'and a read that comes back suspiciously small is refused');

  const wf = await readFile(
    path.join(HERE, '..', '.github', 'workflows', 'oa-jobmarket-sheet.yml'), 'utf8');
  ok(wf.includes('sync-jobmarket-sheet.mjs'), 'the workflow runs the sync');
  ok(wf.includes('node _scraper/selftest.mjs'),
    'and re-checks the file it is about to commit, like every other writer of data/');
  ok(/group: oa-jobs-data-/.test(wf),
    'it shares the data/ concurrency group, so it never races the postings build');

  /* The rows the sheet produces must satisfy the same served-file rules as
     every other posting — this is the check that would catch a mapping change
     that starts emitting an unknown entry level or an un-canonical country. */
  const rows = rowsFromTab(csvOf([JMS_HEAD, ...JMS_ROWS]),
    { tab: '2026 NTT/PD', kind: 'ntt-pd', minYear: 2026 }).rows;
  const C = require(path.join(HERE, '..', 'assets', 'oa-countries.js'));
  for (const r of rows) {
    ok(!r.type || TYPES.includes(r.type), `sheet row ${r.id}: type is known`);
    for (const l of r.levels) ok(LEVELS.includes(l), `sheet row ${r.id}: level "${l}" is known`);
    ok(C.isCanonical(r.country), `sheet row ${r.id}: the country is named the one way`);
    ok(/^\d{4}-\d{2}-\d{2}$/.test(r.posted), `sheet row ${r.id}: the posting date is ISO`);
    ok(!r.applyByDate || !/until\s*filled/i.test(r.applyBy),
      `sheet row ${r.id}: an open-ended deadline carries no date`);
  }

  // and they merge into the served file like any other posting
  const merged = mergeRows([], rows, []);
  eq(merged.rows.length, rows.length, 'the sheet\'s postings merge into the dataset');
  eq(merged.added, rows.length, 'as additions');
  const again = mergeRows(merged.rows, rows, []);
  eq(again.added, 0, 'and re-reading the sheet adds nothing a second time');
  eq(serialise(merged.rows), serialise(again.rows),
    'a rebuild that changes nothing produces a byte-identical file');
}

/* ------------------------------------------------ the HigherEdJobs postings */

/** A page in the shape HigherEdJobs actually serves: the summary block at the
    top, the employer's own description below with its markup double-encoded
    inside the JSON-LD string, and — the trap — a `validThrough` eighteen
    months past the closing date. Trimmed from the real advertisement for
    JobCode 179529368 (Utah Valley University), which closes on 20 August 2026
    and is listed until 6 February 2028. */
const HEJ_AD = `<!doctype html><html><head>
<script type="application/ld+json">
{ "@context":"http://schema.org/", "@type":"JobPosting",
  "title":"Faculty - Lecturer, Non-Tenure Track - Strategic Management &amp;amp; Operations",
  "description":"&lt;center&gt;&lt;b&gt;Faculty - Lecturer&lt;/b&gt;&lt;/center&gt;&lt;br&gt;&lt;b&gt;Salary:&lt;/b&gt; Depends on Qualifications&lt;br&gt;&lt;br&gt;&lt;b&gt;Job Type:&lt;/b&gt; FT Faculty&lt;br&gt;&lt;br&gt;&lt;b&gt;Job Number:&lt;/b&gt; FY2706368&lt;br&gt;&lt;br&gt;&lt;b&gt;Closing:&lt;/b&gt; 8/20/2026 11:59 PM Mountain&lt;br&gt;&lt;br&gt;&lt;b&gt;Location:&lt;/b&gt; Main Campus - Orem&lt;br&gt;",
  "datePosted":"2026-08-15 15:46:07.45",
  "validThrough":"2028-02-06 23:59:59.9",
  "hiringOrganization":{"@type":"Organization","name":"Utah Valley University"},
  "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress",
    "addressLocality":"Orem","addressRegion":"UT","addressCountry":"US"}},
  "employmentType":"FULL_TIME" }
</script></head><body>
<h1 id="jobtitle-header"> Faculty - Lecturer, Non-Tenure Track - Strategic Management &amp; Operations</h1>
<div id="jobLocation">
  <div class="job-inst"><a href="http://www.uvu.edu/" target="_blank">Utah Valley University</a></div>
  <div class="job-loc"><span class="at">in</span> Orem, UT </div>
</div>
<div class="job-info">
  <strong>Type:</strong> Full-Time <br>
  <strong>Posted:</strong> 2 days ago <br>
  <strong>Application Due:</strong> 08/20/2026 <br>
  <strong>Category:</strong> <a class="job-cat" href="/faculty/search.cfm?JobCat=46">Management</a> <br>
</div></body></html>`;

function testHigherEdJobsParsing() {
  const ad = parseAd(HEJ_AD, { jobCode: '179529368' });

  ok(ad.ok, 'a HigherEdJobs advertisement parses');
  eq(ad.applyByDate, '2026-08-20', 'the deadline is the page\'s own "Application Due"');

  /* THE ONE THAT MATTERS. `validThrough` is when the ADVERTISEMENT stops being
     listed — HigherEdJobs sets it ~18 months out — and reading it as the
     deadline would publish "6 February 2028" for a search that closes in five
     days. Worse than the "Until filled." it replaced, because it looks
     specific. It must never appear anywhere in a parse. */
  ok(!JSON.stringify(ad).includes('2028'),
    'and never schema.org validThrough, which is when the AD expires');
  ok(!DEADLINE_FIELDS.some((f) => /valid\s*through/i.test(f)),
    'validThrough is not in the list of fields a deadline may come from');

  eq(ad.title, 'Faculty - Lecturer, Non-Tenure Track - Strategic Management & Operations',
    'the title is read from the page heading, entities decoded');
  eq(ad.institution, 'Utah Valley University', 'and the employer from the page');
  eq(ad.location, 'Orem, UT', 'and where the post is');
  eq(ad.posted, '2026-08-15',
    'the posting date comes from the timestamp, not from "2 days ago" — ' +
    'relative text is only true on the day it was fetched');

  /* Labels are read from the MARKUP, not from flattened text. Flattened, this
     page reads "... Salary: Depends on Qualifications Job Type: FT Faculty
     ...", where no rule can tell where the salary ends and no "Type" lookup
     can avoid matching the tail of "Job Type". */
  eq(ad.salary, 'Depends on Qualifications', 'a value is not truncated by the next label');
  eq(ad.type, 'Full-Time', 'and "Type" is not answered with "Job Type"');
  eq(ad.jobType, 'FT Faculty', 'which is a field of its own');
  eq(ad.jobNumber, 'FY2706368', 'read out of the description\'s double-encoded markup');
  eq(ad.category, 'Management', 'with the markup inside a value stripped');

  // dates: US order, always, because that is the only order this site writes
  eq(hejDate('08/20/2026'), '2026-08-20', 'a US date is read as written');
  eq(hejDate('5/6/2026'), '2026-05-06',
    'an ambiguous one is NOT guessed at — this site writes month first');
  eq(hejDate('August 20, 2026'), '2026-08-20', 'a date written out in words is read too');
  eq(hejDate('rolling'), '', 'and prose is not forced into a date');

  // an open-ended search is reported as one, with no date
  const open = parseAd(HEJ_AD.replace('08/20/2026', 'Open until filled'));
  eq(open.applyByDate, '', 'a search that stays open carries no deadline date');
  ok(/until filled/i.test(open.applyByProse), 'though what it said is kept');

  // a page in a shape this does not know changes nothing rather than half-read
  eq(parseAd('<html><body><p>Something else entirely</p></body></html>').ok, false,
    'an unrecognised page does not parse');
  ok(parseAd('<html><body>This job is no longer available.</body></html>').gone,
    'and a listing that has come down is recognised as gone');

  // urls: host-validated, and keyed by JobCode alone
  const link = 'https://www.higheredjobs.com/faculty/details.cfm?JobCode=179529368&Title=Faculty%20-%20Lecturer';
  ok(isHigherEdJobsUrl(link), 'a HigherEdJobs link is recognised');
  ok(!isHigherEdJobsUrl('https://evil.example.com/www.higheredjobs.com/?JobCode=1'),
    'and a look-alike host is not — the hostname is checked, not the string');
  eq(jobCodeOf(link), '179529368', 'the JobCode is the advertisement\'s identity');
  eq(detailsUrl('179529368'),
    'https://www.higheredjobs.com/faculty/details.cfm?JobCode=179529368',
    'and the Title parameter is decoration, dropped from the page fetched');
}

function testHigherEdJobsApply() {
  const cache = {
    generated: '', ads: {
      179529368: cacheEntry(parseAd(HEJ_AD, { jobCode: '179529368' }),
        { jobCode: '179529368', checkedAt: '2026-08-18T00:00:00Z', via: 'page' }),
    },
  };
  const link = 'https://www.higheredjobs.com/faculty/details.cfm?JobCode=179529368&Title=x';

  /* A posting the sheet left open-ended takes the advertisement's deadline —
     the whole point of the pass. Both fields move together: the page buckets a
     posting as open-ended on the DATE being empty, so a date shown on the card
     while the filter still called it "Until filled" would be the worst of
     both. */
  const openEnded = [{ id: 'a', adUrl: link, applyBy: 'Until filled.', applyByDate: '' }];
  const got = applyVerified(openEnded, cache, { today: '2026-08-18' });
  eq(got.rows[0].applyByDate, '2026-08-20', 'an open-ended posting takes the ad\'s deadline');
  eq(got.rows[0].applyBy, longDate('2026-08-20'), 'shown the way the site writes a date');
  eq(got.changed.length, 1, 'and the correction is reported');

  const again = applyVerified(got.rows, cache, { today: '2026-08-18' });
  eq(serialise(again.rows), serialise(got.rows), 're-applying is a no-op');
  eq(again.changed.length, 0, 'and reports nothing the second time');

  /* A DEADLINE THE MAINTAINER TYPED IS NEVER OVERWRITTEN. The tracking sheet
     is their own record and a typed date is a decision; silently replacing it
     every morning would fight them. The disagreement is reported so the SHEET
     can be corrected, which fixes it at the source. */
  const typed = [{ id: 'b', adUrl: link, applyBy: 'September 1, 2026', applyByDate: '2026-09-01' }];
  const kept = applyVerified(typed, cache, { today: '2026-08-18' });
  eq(kept.rows[0].applyByDate, '2026-09-01', 'a deadline from the sheet wins over the ad');
  eq(kept.changed.length, 0, 'nothing is changed behind the maintainer');
  eq(kept.conflicts.length, 1, 'but the disagreement is reported');

  // an advertisement that could not be read changes nothing at all
  const unread = { ads: { 179529368: { status: 'unreadable', applyByDate: '' } } };
  eq(serialise(applyVerified(openEnded, unread, {}).rows), serialise(openEnded),
    'an unreadable advertisement leaves the posting exactly as it was');
  eq(serialise(applyVerified(openEnded, null, {}).rows), serialise(openEnded),
    'and so does a missing cache');

  // a posting that is not advertised on HigherEdJobs is not touched
  const elsewhere = [{ id: 'c', adUrl: 'https://jobs.chronicle.com/job/1', applyBy: 'Until filled.', applyByDate: '' }];
  eq(serialise(applyVerified(elsewhere, cache, {}).rows), serialise(elsewhere),
    'a posting advertised elsewhere is left alone');

  /* A LISTING THAT HAS COME DOWN KEEPS THE DATE IT STATED. A closed search
     still had a closing date, and that is the true thing to show about it —
     dropping it would return the posting to "Until filled.", the one statement
     now known to be wrong. */
  const gone = cacheEntry({ ok: false, gone: true }, {
    jobCode: '179529368', checkedAt: '2026-09-01T00:00:00Z',
    previous: cache.ads['179529368'], via: 'page',
  });
  eq(gone.applyByDate, '2026-08-20', 'a gone listing keeps the deadline it stated');
  eq(applyVerified(openEnded, { ads: { 179529368: gone } }, {}).rows[0].applyByDate,
    '2026-08-20', 'and the posting still shows it');

  /* WHAT IS FETCHED, AND WHAT IS LEFT ALONE. */
  const row = { id: 'a', adUrl: link, posted: '2026-08-15' };
  eq(needFetch([row], { ads: {} }, { today: '2026-08-18' }).length, 1,
    'an advertisement never read is read');
  eq(needFetch([row], cache, { today: '2026-08-18', ttlDays: 7 }).length, 0,
    'one read a moment ago is left alone');
  eq(needFetch([row], cache, { today: '2026-08-18', ttlDays: 7, force: true }).length, 1,
    '--force reads it anyway');
  eq(needFetch([row], cache, { today: '2026-09-30', ttlDays: 7 }).length, 0,
    'one whose deadline has passed is frozen — the search is over');
  eq(needFetch([row], {
    ads: { 179529368: { ...cache.ads['179529368'], via: 'report' } },
  }, { today: '2026-09-30', ttlDays: 7 }).length, 1,
    'but one not read from the PAGE is always re-read, however old — a ' +
    'stand-in exists to be replaced by the advertisement itself');
}

async function testHigherEdJobsWiring() {
  /* Three files have to agree, and a broken link between them fails SILENTLY:
     the postings simply keep saying "Until filled.", which is what they said
     before anyone noticed. */
  const sync = await readFile(path.join(HERE, 'sync-jobmarket-sheet.mjs'), 'utf8');
  ok(sync.includes('applyVerified'),
    'the sheet sync re-applies what the advertisements said');
  ok(sync.includes('higheredjobs.json'), 'reading it from the committed cache');
  /* THE POINT OF DOING IT THERE. data/jobmarket.json is rebuilt from the
     workbook every morning, so a deadline merely written into the file once
     would be reverted by the next run — the same reason a country spelling is
     fixed in oa-countries.js and not in the dataset. */
  ok(/rebuilt from the sheet each morning/.test(sync),
    'and says why: a one-off patch of the dataset would not survive the next read');

  const wf = await readFile(
    path.join(HERE, '..', '.github', 'workflows', 'oa-higheredjobs-verify.yml'), 'utf8');
  ok(wf.includes('higheredjobs-verify.mjs'), 'the workflow runs the check');
  ok(wf.includes('node _scraper/selftest.mjs'),
    'and re-checks the files it is about to commit, like every other writer of data/');
  ok(/group: oa-jobs-data-/.test(wf),
    'it shares the data/ concurrency group, so it never races the sheet read or the build');
  ok(wf.includes('--apply-only'),
    'and a rejected push re-applies onto the new tip rather than pushing over it');

  /* The cache is data/, so it must survive a round trip like every other file
     there — and the served postings must still satisfy the served-file rules
     after the pass has touched them. */
  if (existsSync(path.join(HERE, '..', 'data', 'higheredjobs.json'))) {
    const cache = JSON.parse(
      await readFile(path.join(HERE, '..', 'data', 'higheredjobs.json'), 'utf8'));
    ok(cache && typeof cache.ads === 'object', 'the committed cache has the shape it should');
    for (const [code, ad] of Object.entries(cache.ads)) {
      ok(/^\d{4,12}$/.test(code), `cache ${code}: keyed by JobCode`);
      ok(['ok', 'gone', 'unreadable'].includes(ad.status), `cache ${code}: a known status`);
      ok(!ad.applyByDate || /^\d{4}-\d{2}-\d{2}$/.test(ad.applyByDate),
        `cache ${code}: the deadline is ISO`);
      ok(jobCodeOf(ad.url) === code, `cache ${code}: its url names the same advertisement`);
    }

    const rows = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'jobmarket.json'), 'utf8'));
    const applied = applyVerified(rows, cache, {});
    eq(serialise(applied.rows), serialise(rows),
      'the committed postings already carry what the advertisements said');
    for (const r of applied.rows) {
      ok(!r.applyByDate || !/until\s*filled/i.test(r.applyBy),
        `${r.id}: a dated posting does not also say "until filled"`);
      ok(!r.applyByDate || r.applyBy === longDate(r.applyByDate),
        `${r.id}: the date shown and the date filtered on are the same date`);
    }
  }
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
  await testDerivedMarketYear();
  await testCountries();
  await testSchools();
  await testSubmissionKeyCeilings();
  testJobMarketSheetParsing();
  testJobMarketSheetColumns();
  testJobMarketSheetRows();
  testJobMarketSheetAddedAt();
  testJobMarketSheetStaleness();
  await testJobMarketSheetChain();
  await testJobMarketSheetWiring();
  testHigherEdJobsParsing();
  testHigherEdJobsApply();
  await testHigherEdJobsWiring();
  process.exit(finish() ? 0 : 1);
}
