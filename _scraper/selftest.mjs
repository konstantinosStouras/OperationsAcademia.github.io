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
  universitiesLink, ownUniversitiesLink,
  buildMeta, serialise, publicRow, displayOrder, longDate,
  marketYear, marketLabel, marketFloor, collapseSameDay, MARKET_WINDOW, MARKET_ROLL_MONTH,
  submissionFromRow, composeApplyBy, assignIds, inCurrentMarket, deadlineOpen, marketStart,
  diffRows, collectChanges, renderChangesHtml,
  MIRROR_STATUS, sheetMirrorDoc, mirrorDiffers, unclaimedSheetRows, sheetHandover,
  removalSpecs, buildOwned, ownerTag, specMatches, healPlace,
  parseProseDay, extractReviewDate, extractFinalDate, healReviewDate,
  PUBLIC_FIELDS, LEVELS, CHARACTERISTICS, TYPES,
} from './jobs-model.mjs';
import {
  splitDepartment, joinDepartment, buildVocab, serialiseVocab, vocabKey, businessSchoolOf,
  campusCountries, healCountry, SCHOOLS,
} from './vocab.mjs';
import { docIdFor, migrationDoc, lostFields, migratable } from './migrate-to-firestore.mjs';
import { syncSheetMirrors } from './build-jobs.mjs';
import {
  sheetDay, daysBetween, deadlineDay, classifyTab, isIntroTab, conventionalTabs,
  normHeader, mapColumns,
  inferColumns, resolveColumns, looksLikeData, repairColumns, institutionColumn,
  levelsFromRank, typeFromNames, rowsFromTab, collectRows,
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
import {
  parseAdvert, advertDate, advertKeyOf, isAdvertUrl, workdayApiUrl,
  applyAdverts, cacheEntry as advertCacheEntry, needFetch as advertNeedFetch,
  adBlock, sameAdInfo, queueNeedsFetch,
  DEADLINE_LABELS as ADVERT_DEADLINE_LABELS, LISTING_END_LABELS,
} from './adverts.mjs';
import {
  COLLECTION as REVIEW_COL, EDITABLE, SHOWN, DOC_KEYS, PENDING, APPROVED, REJECTED,
  queueDoc, refreshQueued, cleanEdit, cleanEdits, applyEdits, partition,
  needMail, changedKeys, approvedRow, duplicatesOf, sameDups, businessCheck, sameBiz,
} from './jobreview.mjs';
import {
  KINDS as SUB_KINDS, ANNOUNCED_AT as SUB_ANNOUNCED_AT,
  REVIEWED_AT as SUB_REVIEWED_AT, partitionSubmissions, isWaiting, createdDay,
} from './submissions-review.mjs';
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

/* --------------------------------------------- what a red selftest COSTS

   This file has two jobs and they carry very different consequences.

   As a PR CHECK (oa-checks.yml) it guards the repository: red means somebody
   reads the failure and fixes it before merging, and nothing on the live site
   moves either way.

   As the BUILD'S RE-CHECK (oa-jobs-build.yml, oa-jobmarket-sheet.yml) it
   guards what is about to be committed — and red there means the build
   commits NOTHING. Not the offending row: nothing. Every posting the site
   would have gained, every correction, every approval, held back until
   somebody notices, with no error anywhere that a reader could see. CLAUDE.md
   records that outcome twice, and it happened again the morning 449 approved
   postings arrived: sixteen pairs of department names the workbook writes
   short ("OM" beside "OM/SCM") took the whole site's data offline-stale.

   So a guard that is about TIDINESS rather than about the data being right is
   reported in that role instead of failing it. `--publishing` says which role
   this run is in; the pairs are named in the log either way, and the PR check
   still fails on them, which is where a naming duplicate is actually fixed. */
const PUBLISHING = process.argv.includes('--publishing');

/** A finding that must not stop the site publishing: fatal in the PR check,
    a named warning in the build's re-check. */
function tidy(list, what) {
  if (!list.length || !PUBLISHING) { eq(list, [], what); return; }
  pass++;
  console.log(`::warning::${what} — ${list.length} to settle: ${list.join('; ')}`);
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
    /* the SUGGESTED apply-by: ISO where present, and always BEFORE the final
       date — equal is the deadline said twice, later contradicts it
       (healReviewDate, which the build applies to every row) */
    ok(!r.reviewDate || /^\d{4}-\d{2}-\d{2}$/.test(r.reviewDate),
      `row ${r.id}: reviewDate is ISO or absent`);
    ok(!r.reviewDate || !r.applyByDate || r.reviewDate < r.applyByDate,
      `row ${r.id}: the suggested apply-by falls before the final one`);
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

  /* …AND SO ARE TWO ADVERTISEMENTS FROM ONE DEPARTMENT ON ONE DAY. Houston's
     Bauer College really did this on 2025-09-23: Assistant/Associate/Full
     "until filled", and Assistant only closing 15 October, each with its own
     ad link. They survived for a year only BY ACCIDENT — one of them had
     omitted its school, so the two `department` lines differed — and the
     moment both were canonicalised onto the same department this function
     dropped one of them. A key of (place, day) assumes a department
     advertises at most one post a day, and that is not true.

     A missing link still contradicts nothing: the repeat-submission case
     above is exactly a row with no ad merging into the fuller one. */
  const advert = { ...base, adUrl: 'https://uh.edu/assistant-associate-full', applyBy: 'Until filled' };
  const other = { ...base, adUrl: 'https://uh.edu/assistant-only', applyByDate: '2025-10-15' };
  c = collapseSameDay([advert, other]);
  eq(c.rows.length, 2, 'two advertisements from one department on one day are two postings');
  eq(c.collapsed, 0, 'and neither is reported as a repeat');

  c = collapseSameDay([advert, { ...advert }]);
  eq(c.rows.length, 1, 'while the SAME advertisement twice is still one posting');

  /* our own home page is what a sheet row carries when it names no ad at all,
     so it must not be read as an identity — two such rows are still repeats */
  const homey = { ...base, postedAtUrl: 'http://www.operationsacademia.org/' };
  c = collapseSameDay([homey, { ...base }]);
  eq(c.rows.length, 1, 'a row pointing only at our own home page names no advertisement');


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
  for (const f of ['lastSentAt', 'lastCheckedAt', 'lastUpdateDate', 'lastCandidateAt',
    'criteria', 'enabled']) {
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

  /* ------------------------------- A US CITY IS NOT THE COUNTRY IT IS NAMED AFTER

     canon() reads a comma-separated value from the RIGHT, because the last part
     of an address is its most administrative one — and it used to walk past the
     state to match a town. St. John's University is in Jamaica, New York, and
     the site published it under the country JAMAICA. A US state settles it. */
  for (const [given, want] of [
    ['Jamaica, NY', 'United States'],
    ['Jamaica, New York', 'United States'],
    ['Davis, CA', 'United States'],
    ['Winter Park, Florida', 'United States'],
    ['Baltimore, Maryland, United States', 'United States'],
    ['Atlanta, GA', 'United States'],
  ]) {
    eq(C.canon(given), want, `"${given}" is published as "${want}"`);
  }
  /* ...and the one state canon() must NOT settle by name, because guessing is
     worse than leaving it: Georgia is a country too. */
  eq(C.canon('Athens, Georgia'), 'Georgia',
    'a name that is both a state and a country is never guessed at');
  eq(C.canon('Georgia'), 'Georgia', 'and the country keeps its own name');
  ok(C.US_STATES.some((r) => r[1] === 'GA'),
    'while its ABBREVIATION still settles an address — dropping GA with the '
    + 'name left Emory unreadable');
  eq(C.canon('Victoria, Australia'), 'Australia', 'a country still wins where it is one');

  /* ------------------------------- the address is the site's answer to "where"

     data/universities.json carries a postal address per campus, and that is
     what a posting's country is audited against (_scraper/country-audit.mjs).
     It NEVER INVENTS: an address the parser cannot read has no answer, and the
     audit then says nothing about that university rather than guessing one. */
  for (const [address, want] of [
    ['Runeberginkatu 14-16, 00100 Helsinki, Finland', 'Finland'],
    ['100 Main St, Cambridge, MA 02142', 'United States'],
    ['1300 Clifton Rd, Atlanta, GA 30322', 'United States'],
    ['21 Lower Kent Ridge Rd, Singapore 119077', 'Singapore'],
    ['Lidasan Building WuJiaoChang, Yangpu Qu, Shanghai Shi China', 'China'],
    ['15z/data=!4m2!3m1!1s0x0:0x30816f9ab195bb29?sa=X&ved=0ahUK', ''],
    ['', ''],
  ]) {
    eq(C.countryFromAddress(address), want,
      `the address ending "${address.slice(-28) || '(empty)'}" reads as "${want}"`);
  }

  /* --------------------------------- and every posting names the country it is in

     THE FAULT THIS CATCHES. `country` drives the Location filter, so a wrong
     one does not look wrong — the posting just files itself somewhere it has
     nothing to do with and stops being findable. Nine live postings were
     published under Greece because the Edit form's country box had no
     `autocomplete` attribute and a browser filled it from the editor's own
     address profile.

     Asserted over data/jobs.json ALONE, deliberately: that is the file
     build-jobs.mjs heals before it writes (healCountry), so this guard asserts
     a rule the publisher itself guarantees and cannot fire on a legitimate new
     posting — the failure mode CLAUDE.md records twice. The archive, which has
     no daily build, is swept by country-audit.mjs in the checks workflow. */
  const byUni = campusCountries(JSON.parse(
    await readFile(path.join(HERE, '..', 'data', 'universities.json'), 'utf8')));
  ok(byUni.size > 150, `the site can place ${byUni.size} universities from their own addresses`);
  ok(!byUni.has(SCHOOLS.institutionKey('INSEAD')),
    'a university with campuses in two countries has NO single answer, which is '
    + 'what makes correcting the others safe');

  /* BOTH FILES THE PIPELINE HEALS. data/jobmarket.json is served in its own
     right — the workbook's postings, which the jobs page filters by country
     like any other — and the sheet sync heals it on every read for the same
     reason build-jobs heals the merged set. Asserted only over the files a
     writer guarantees; the archive is country-audit.mjs's job. */
  for (const file of ['jobs.json', 'jobmarket.json']) {
    const rows = JSON.parse(await readFile(path.join(HERE, '..', 'data', file), 'utf8'));
    const wrongCountry = rows
      .filter((r) => byUni.has(SCHOOLS.institutionKey(r.institution || '')))
      .filter((r) => r.country !== byUni.get(SCHOOLS.institutionKey(r.institution)))
      .map((r) => `${r.id}: ${r.institution} says ${r.country || '(none)'}`);
    eq(wrongCountry, [], `data/${file}: every posting names the country its university is in`);
  }

  /* and BOTH writers really do heal it — read from the source, because a heal
     that only one of them applies is undone by whichever writes next */
  for (const writer of ['build-jobs.mjs', 'sync-jobmarket-sheet.mjs']) {
    const src = await readFile(path.join(HERE, writer), 'utf8');
    ok(/healCountry\(/.test(src) && /campusCountries\(/.test(src),
      `${writer} heals the country against the Universities directory`);
  }

  // the heal itself: corrects a disagreement, and is otherwise untouched
  const wrongRow = { institution: 'McGill University', country: 'Greece' };
  eq(healCountry(wrongRow, byUni).country, 'Canada', 'a contradicted country is corrected');
  const rightRow = { institution: 'McGill University', country: 'Canada' };
  ok(healCountry(rightRow, byUni) === rightRow,
    'and a row that already agrees is returned untouched');
  const unplaceable = { institution: 'INSEAD', country: 'Singapore' };
  ok(healCountry(unplaceable, byUni) === unplaceable,
    'a university the site cannot place is never rewritten');

  /* THE ROOT CAUSE, PINNED. A field called "country" on a form about somebody
     ELSE'S campus is exactly what a browser fills from the reader's own
     address profile, and the institution box had `autocomplete="organization"`
     — the poster's own employer, over the university they are advertising.
     Both are off. The poster's OWN name and e-mail keep their autofill, which
     is what those tokens are for. */
  const jobForm = await readFile(path.join(HERE, '..', 'post-a-job.html'), 'utf8');
  for (const id of ['f-country', 'f-institution']) {
    const at = jobForm.indexOf(`id="${id}"`);
    ok(at !== -1, `post-a-job.html offers ${id}`);
    const tag = jobForm.slice(at, jobForm.indexOf('>', at));
    ok(/autocomplete="off"/.test(tag),
      `post-a-job.html: ${id} is not filled from the reader's own address profile`);
  }
  ok(/autocomplete="email"/.test(jobForm),
    'while the poster’s own e-mail still autofills, which is what it is for');
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

  /* A SCHOOL TYPED INTO THE DEPARTMENT BOX. The live failure: a Tulane
     posting arrived with an empty School and "Freeman School of Business" in
     the Department field, so the site would have published a place with no
     school and a department that is one. Moved across, from the curated table
     only. */
  eq(S.canonPlace({ institution: 'Tulane University', school: '', unit: 'Freeman School of Business' }),
    { institution: 'Tulane University', school: 'A. B. Freeman School of Business', unit: '' },
    'a school left in the department box moves into the school field');
  eq(S.canonColumns({ institution: 'Tulane University', school: '', unit: 'Freeman School of Business' }),
    { institution: 'Tulane University', school: 'A. B. Freeman School of Business', unit: '' },
    'and the same from a form with three boxes');

  // …but a real department is never promoted, however school-ish it reads
  eq(S.canonPlace({ institution: 'Tulane University', school: '', unit: 'Management Science' }).unit,
    'Management Science', 'a department the school table does not know stays a department');
  eq(S.canonPlace({ institution: 'Duke University', school: '', unit: 'School of Wizardry' }).school,
    '', 'and neither is a school nobody has heard of — the table is the whole authority');

  // a row that named BOTH keeps both — only an empty school field is filled
  {
    const both = S.canonPlace({ institution: 'Tulane University',
      school: 'Freeman School of Business', unit: 'Management Science' });
    eq(both, { institution: 'Tulane University', school: 'A. B. Freeman School of Business',
      unit: 'Management Science' }, 'a row that names both keeps both');
  }

  {
    const moved = S.canonPlace({ institution: 'Tulane University', school: '', unit: 'Freeman School of Business' });
    eq(S.canonPlace(moved), moved, 'and the move is safe to run twice');
  }

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
  /* Every Tulane posting that NAMES a school names it this way. A row that
     names none is not a second spelling — it is a posting with a field left
     empty, which is allowed — and failing on one would stop the publish for
     every other posting on the site. (What used to arrive instead was the
     school typed into the department box; assemble() now moves it across, so
     the rows this guard was written for keep naming one school.) */
  eq([...new Set(tulane.map((r) => r.school))].filter(Boolean), ['A. B. Freeman School of Business'],
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

  /* The form applies it too, so a poster's own preview reads as it will
     publish — through canonCOLUMNS, because a form with three boxes has
     already said which name is which (see canonColumns' own header). */
  const form = await readFile(path.join(HERE, '..', 'assets', 'oa-jobform.js'), 'utf8');
  ok(/S\.canonColumns/.test(form),
    'oa-jobform.js: the form canonicalises what the poster typed');
  ok(!/canonPlace\(\{/.test(form) && !/OASchools\.canonPlace/.test(form),
    'and never through canonPlace, which would take a university apart');

  /* what that distinction is worth, measured on the names it decides */
  eq(S.canonColumns({ institution: 'University of California, Los Angeles (UCLA)', school: '', unit: '' }),
    { institution: 'University of California, Los Angeles (UCLA)', school: '', unit: '' },
    'a university typed into the University box stays that university');
  eq(S.canonPlace({ institution: 'University of California, Los Angeles (UCLA)' }).institution,
    'University of California',
    'while the archive\'s one-column value is still taken apart');
  eq(S.canonColumns({ institution: 'Rutgers University', school: 'School of Business-Camden', unit: 'Operations Management' }),
    { institution: 'Rutgers University', school: 'School of Business-Camden', unit: 'Operations Management' },
    'a campus in a school name is not a department');
  eq(S.canonColumns({ institution: 'Clemson University', school: 'College of Engineering, Computing and Applied Sciences', unit: 'Industrial Engineering' }).school,
    'College of Engineering, Computing and Applied Sciences',
    'nor is half a college name');
  eq(S.canonColumns({ institution: 'X', school: 'Ross School of Business Technology and Operations', unit: '' }),
    { institution: 'X', school: 'Stephen M. Ross School of Business', unit: 'Technology and Operations Management' },
    'but a pair somebody wrote down as naming both still names both');
  const page = await readFile(path.join(HERE, '..', 'post-a-job.html'), 'utf8');
  ok(page.indexOf('oa-schools.js') !== -1 &&
     page.indexOf('oa-schools.js') < page.indexOf('oa-jobform.js'),
    'post-a-job.html: and loads the module before the form');

  // the vocabulary the form offers is built from the canonical names
  const vocab = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'vocab.json'), 'utf8'));
  const badSchools = vocab.schools.map((e) => e.v).filter((v) => S.canonSchool(v) !== v);
  eq(badSchools, [], 'data/vocab.json: the form offers canonical school names');
  /* isCanonicalUnit, not `canonUnit(v) === v`: six schools name their own unit
     in a way the generic wrapper rule would strip ("Operations Management
     Area"), and asked WITHOUT a university that rule is all canonUnit has. */
  const badUnits = vocab.units.map((e) => e.v).filter((v) => !S.isCanonicalUnit(v));
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

  /* ------------------------------------------------- the cascade

     The reported bug, as a fixture: one Tulane school posted under two
     spellings and one department under three, which the form offered as five
     separate names. It is ONE school with ONE department, and the department
     is offered under the school it sits in.

     The spellings come from oa-schools.js, which every posting is already
     canonicalised by at ingest — the vocabulary re-applies it so a DIRECTORY
     row, which has never been through an ingest, joins the same entry rather
     than starting a second one.                                              */

  const tulane = buildVocab([
    { institution: 'Tulane University', school: 'Freeman School of Business', unit: 'Management Science' },
    { institution: 'Tulane University', school: 'Freeman School of Business', unit: 'Management Sciences Area' },
    { institution: 'Tulane University', school: 'A.B. Freeman School of Business', unit: 'Management Science Department' },
    { institution: 'Tulane University', school: 'Freeman School of Business', unit: '' },
  ], { directory: [
    { institution: 'Tulane University', school: 'A. B. Freeman School of Business',
      department: 'Management Science Department' },
    { institution: 'Aalto University', school: 'School of Business',
      department: 'Department of Information and Service Economy' },
  ] });

  eq(tulane.byUniversity['Tulane University'].schools, ['A. B. Freeman School of Business'],
    'one school, under the spelling the site publishes');
  eq(tulane.byUniversity['Tulane University'].units, ['Management Science'],
    'and one department');
  eq(tulane.byUniversity['Tulane University'].bySchool,
    { 'A. B. Freeman School of Business': ['Management Science'] },
    'which the cascade files under its school');
  eq(tulane.bySchool['A. B. Freeman School of Business'], ['Management Science'],
    'and offers again when the school is known but the university is not');

  eq(tulane.universities.find((u) => u.v === 'Tulane University').n, 4,
    'the count is of postings — all four, however they were spelled');
  eq(tulane.universities.find((u) => u.v === 'Aalto University').n, 0,
    'a university the directory names but nobody has posted from counts none');
  eq(tulane.byUniversity['Aalto University'].bySchool,
    { 'School of Business': ['Information and Service Economy'] },
    'and still cascades, which is the whole point of reading the directory');

  /* A department posted with NO school is a real case, and the form offers it
     while the school field is empty — so it is filed under '' rather than
     dropped or attached to a school nobody named. */
  const loose = buildVocab([
    { institution: 'X University', school: '', unit: 'Operations Management' },
    { institution: 'X University', school: 'Y School of Business', unit: 'Decision Sciences' },
  ]);
  eq(loose.byUniversity['X University'].bySchool,
    { '': ['Operations Management'], 'Y School of Business': ['Decision Sciences'] },
    'a department posted without a school is filed under no school, not under one');
  eq(loose.byUniversity['X University'].units, ['Decision Sciences', 'Operations Management'],
    'and the university still offers both');

  /* A DIRECTORY row's three names are already in three columns, so they are
     canonicalised one by one. Running canonPlace() over them takes apart
     values that are whole: Rutgers' campus and Clemson's college became
     departments called "Camden, Operations Management" and "Computing and
     Applied Sciences, Industrial Engineering", and the form offered both. */
  const columns = buildVocab([], { directory: [
    { institution: 'Rutgers University', school: 'School of Business-Camden',
      department: 'Operations Management' },
    { institution: 'Clemson University',
      school: 'College of Engineering, Computing and Applied Sciences',
      department: 'Industrial Engineering' },
  ] });
  eq(columns.byUniversity['Rutgers University'].bySchool,
    { 'School of Business-Camden': ['Operations Management'] },
    'a campus in a school name is not a department');
  eq(columns.byUniversity['Clemson University'].bySchool,
    { 'College of Engineering, Computing and Applied Sciences': ['Industrial Engineering'] },
    'nor is half a college name');

  /* ------------------------------- what must never take the build down

     buildVocab runs inside the daily build before anything is written, so a
     row it cannot digest stops the site publishing at all. Each of these was
     a real crash or a real malformed name, not a hypothetical. */

  // a name in a script fold() does not know still has an identity of its own
  const script = buildVocab([
    { institution: '香港中文大學', school: '', unit: 'Operations Management' },
    { institution: 'Πανεπιστήμιο Πειραιώς', school: '', unit: 'Operations' },
  ]);
  eq(script.universities.map((u) => u.v).sort(),
    ['Πανεπιστήμιο Πειραιώς', '香港中文大學'],
    'a university named in a non-Latin script is offered, not dropped and not fatal');
  eq(script.byUniversity['香港中文大學'].units, ['Operations Management'],
    'and it cascades like any other');

  // a directory that is not a list of rows is no directory at all
  eq(buildVocab([{ institution: 'X University', school: '', unit: 'Operations' }],
    { directory: { not: 'a list' } }).universities, [{ v: 'X University', n: 1 }],
    'a directory that is not a list is ignored rather than fatal');

  // a directory row that repeats its school in the department field
  const repeated = buildVocab([], { directory: [{
    institution: 'Georgetown University',
    school: 'McDonough School of Business',
    department: 'McDonough School of Business, Operations and Information Management Area',
  }] });
  eq(repeated.byUniversity['Georgetown University'].bySchool,
    { 'McDonough School of Business': ['Operations and Information Management'] },
    'a department that repeats its school is offered without it — or the card would name the school twice');

  // a directory row for a place nobody has posted from is still offered
  const empty = buildVocab([], { directory: [
    { institution: 'Aalto University', school: 'School of Business', department: 'Marketing' },
  ] });
  eq(empty.universities, [{ v: 'Aalto University', n: 0 }],
    'the directory alone can put a university on the list, with no postings behind it');

  /* WHICH SCHOOL IS THE BUSINESS SCHOOL (owner, 2026-08-23). Answered from
     the school's own NAME, only when the answer is unambiguous — the
     schoolForUnit discipline: none, or two, is no answer at all. */
  const biz = buildVocab([], { directory: [
    { institution: 'University of California, Berkeley',
      school: 'Walter A. Haas School of Business',
      department: 'Operations and Information Technology Management' },
    { institution: 'University of California, Berkeley',
      school: 'College of Engineering',
      department: 'Industrial Engineering and Operations Research' },
    { institution: 'Northwestern University',
      school: 'Kellogg School of Management', department: 'Operations' },
    { institution: 'Two Schools University', school: 'School of Business', department: 'OM' },
    { institution: 'Two Schools University',
      school: 'Faculty of Business and Economics', department: 'Economics' },
  ] });
  eq(businessSchoolOf(biz, 'University of California, Berkeley'),
    'Walter A. Haas School of Business',
    'the university\'s business school is named from its own name, past its other schools');
  eq(businessSchoolOf(biz, 'UC Berkeley'), 'Walter A. Haas School of Business',
    'however the university is spelled — the lookup goes through institutionKey');
  eq(businessSchoolOf(biz, 'Northwestern University'), 'Kellogg School of Management',
    'a school of management counts as one, though it never says the word');
  eq(businessSchoolOf(biz, 'Two Schools University'), '',
    'two candidate schools are an ambiguity, not an answer');
  eq(businessSchoolOf(biz, 'Nowhere University'), '',
    'a university the vocabulary does not know names nothing');
  eq(businessSchoolOf(null, 'University of California, Berkeley'), '',
    'and no vocabulary at all is never fatal');
}

/* ------------------------------- the site's own link follows the name

   Every posting carries a "Further info" link into the Universities page,
   generated from its institution. Canonicalising the name left six of them
   still asking for the spelling the posting was made under, four of which
   landed on nothing — a dead link on a live card. Ours is ours to regenerate;
   a link the poster actually gave is not. */

async function testFurtherInfoLink() {
  ok(ownUniversitiesLink('https://www.operationsacademia.org/universities?filterA=Penn%20State'),
    'the site\'s own Universities link is recognised as ours');
  ok(!ownUniversitiesLink('https://www.tulane.edu/jobs'),
    'and a link the poster gave is not');
  ok(!ownUniversitiesLink(''), 'nor is nothing');

  const made = rowFromSubmission({ ...GOOD, institution: 'Penn State',
    furtherInfoUrl: universitiesLink('Penn State') });
  eq(made.furtherInfoUrl, universitiesLink('The Pennsylvania State University'),
    'a stored link of ours is regenerated from the name the site publishes');

  const theirs = rowFromSubmission({ ...GOOD, institution: 'Penn State',
    furtherInfoUrl: 'https://www.psu.edu/careers' });
  eq(theirs.furtherInfoUrl, 'https://www.psu.edu/careers', 'and theirs is left alone');

  /* A REVIEW EDIT FOLLOWS THE SAME RULE. The workbook ingest builds the link
     from the institution as the sheet wrote it, so an approval whose edit
     corrects the name published a link asking for the old spelling — three of
     them ("MIT Sloan", "University of Chicago (Booth)", "NUS (IS)") turned
     this very guard red on 2026-08-23 and stopped every posting on the site
     from publishing for a day. */
  const sheetRow = { id: 'r', institution: 'MIT Sloan', school: '', unit: 'Operations Management',
    department: 'Operations Management', furtherInfoUrl: universitiesLink('MIT Sloan') };
  const approvedEdit = applyEdits(sheetRow,
    { institution: 'Massachusetts Institute of Technology (MIT)' });
  eq(approvedEdit.furtherInfoUrl,
    universitiesLink('Massachusetts Institute of Technology (MIT)'),
    'a review edit that corrects the name regenerates the site\'s own link with it');
  const sheetTheirs = applyEdits({ ...sheetRow, furtherInfoUrl: 'https://mitsloan.mit.edu/faculty' },
    { institution: 'Massachusetts Institute of Technology (MIT)' });
  eq(sheetTheirs.furtherInfoUrl, 'https://mitsloan.mit.edu/faculty',
    'while a link the sheet\'s contributor gave is never touched');

  /* AND A CARRIED ROW HEALS A STALE LINK ON ITS OWN. healPlace used to test
     the three names alone, so a row already canonical whose own link still
     asked for an earlier spelling came back untouched — red for ever, with
     nothing left to heal it. */
  const staleCarried = {
    id: 'c', institution: 'University of Chicago', school: 'Booth School of Business',
    unit: 'Operations Management', department: 'Booth School of Business, Operations Management',
    furtherInfoUrl: universitiesLink('University of Chicago (Booth)'),
  };
  eq(healPlace(staleCarried).furtherInfoUrl, universitiesLink('University of Chicago'),
    'a carried row with canonical names still heals a stale link of ours');
  const freshCarried = { ...staleCarried, furtherInfoUrl: universitiesLink('University of Chicago') };
  ok(healPlace(freshCarried) === freshCarried,
    'and a row whose names and link are both right is returned untouched');

  /* the served file, row by row: every one of our links names its own row */
  const rows = JSON.parse(await readFile(JOBS, 'utf8'));
  const wrong = rows.filter((r) => ownUniversitiesLink(r.furtherInfoUrl) &&
    r.furtherInfoUrl !== universitiesLink(r.institution)).map((r) => r.id);
  eq(wrong, [], 'data/jobs.json: no posting links to a university under a name it does not use');

  /* the three pages that read those links fold a search the same way, or a
     link that works on one lands on nothing on another */
  const RULE = "replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, '')";
  for (const f of ['oa-list.js', 'oa-alert-match.js', 'oa-uni-map.js']) {
    const src = await readFile(path.join(HERE, '..', 'assets', f), 'utf8');
    ok(src.includes(RULE), `${f}: folds a search the same way as the other pages`);
  }
}

/* ------------------------- naming rules the cascade leans on, and only it

   assets/oa-schools.js is master's, and testSchools() above covers what it
   publishes. These are the three things the CASCADE asked of it — each one a
   bug the Universities directory found the first time anything canonicalised
   its rows. */

function testNamesForTheCascade() {
  const S = require(path.join(HERE, '..', 'assets', 'oa-schools.js'));

  /* 1. GROUPING is not PUBLISHING. institutionKey merges the directory's
     several names for one university; canonInstitution must go on publishing
     each posting's own name, because its id and permalink are built from it. */
  const same = (a, b) => S.institutionKey(a) === S.institutionKey(b);
  ok(same('The University of Texas at Dallas', 'University of Texas at Dallas'),
    'a leading "The" does not make two universities');
  ok(same('The University of Hong Kong (HKU)', 'University of Hong Kong (HKU)'),
    'nor does it beside an acronym');
  ok(same('The Chinese University of Hong Kong (CUHK)', 'The Chinese University of Hong Kong'),
    'and a trailing acronym does not either');
  ok(!same('The Chinese University of Hong Kong', 'The Chinese University of Hong Kong, Shenzhen'),
    'while a campus that really is a different place stays one');
  ok(!same('University of Houston', 'University of Hong Kong'),
    'and two universities are two universities');

  eq(S.canonInstitution('Baruch College, The City University of New York (CUNY)'),
    'Baruch College, The City University of New York (CUNY)',
    'the published name keeps everything it was published with');
  eq(S.canonInstitution('Korea Advanced Institute of Science and Technology (KAIST)'),
    'Korea Advanced Institute of Science and Technology (KAIST)', 'acronym and all');

  /* 2. canonUnit has to be idempotent, or the vocabulary offers a name the
     ingest would not publish. A department ending in its own acronym lost the
     acronym but kept the wrapper word, because the wrapper is only stripped
     while it is last. */
  const twice = (v) => S.canonUnit(S.canonUnit(v));
  for (const v of [
    'Engineering Management, Information, and Systems Department (EMIS)',
    'Department of Industrial Engineering and Operations Research (IEOR)',
    'Operations Management Area',
  ]) {
    eq(twice(v), S.canonUnit(v), `canonUnit is idempotent: ${v}`);
  }

  /* 3. A lookup table must not answer for Object.prototype: "constructor"
     came back as the source of Object, and went on to become a posting's id. */
  for (const key of ['constructor', 'Constructor', 'toString', 'valueOf']) {
    ok(typeof S.canonUnit(key) === 'string' && !/native code/.test(S.canonUnit(key)),
      `canonUnit("${key}") is a name, not a prototype`);
    ok(typeof S.canonInstitution(key) === 'string',
      `canonInstitution("${key}") is a name, not a prototype`);
  }
}

/* ------------------------------------------ the cascade is actually wired

   The narrowing lives in three files that have to agree — the vocabulary's
   third level, the picker's scope, and the form that joins them — and a break
   in any of them shows up as a form that quietly stops narrowing rather than
   as an error anybody sees. The behaviour is driven in page-test.mjs; this is
   the part a browser is not needed for. */

async function testCascadeWiring() {
  const combo = await readFile(path.join(HERE, '..', 'assets', 'oa-combo.js'), 'utf8');
  ok(/function setScope\(/.test(combo) && /oa-combo-group/.test(combo),
    'oa-combo.js offers a scope under its own heading');

  /* ALPHABETICAL, AND THE WHOLE LIST. The picker used to rank by posting
     count and render 60 rows: right for the ten names it opened with, wrong
     for three hundred, where the reader knows the name they are looking for.
     A count-first order with a low cap is the worst pair of the two — the
     list ends in the C's and says "keep typing" to somebody who cannot tell
     whether their university is there at all. */
  ok(!/return b\.n - a\.n;/.test(combo),
    'oa-combo.js no longer orders the list by how often a name has been posted');
  ok(/function cmpName\(/.test(combo) && /sensitivity: 'base'/.test(combo),
    'and sorts A-Z with accents folded onto their base letter');
  ok(/max: opts\.max \|\| ([1-9]\d\d+)/.test(combo),
    'rendering enough rows that an alphabetical list reaches the end of the alphabet');
  ok(/var nameKey = typeof opts\.key === 'function' \? opts\.key : fold;/.test(combo),
    'and takes its idea of "the same name" from the caller, so it needs no name rules of its own');

  /* A PICKER MOUNTED INTO MARKUP THAT IS LATER THROWN AWAY HAS TO BE GIVEN
     BACK. Each mount adds a listener to `document` — the only way to see a
     click land outside its own list — and the review queue redraws its whole
     card list on a year tab. Without this the listeners accumulate, each
     holding a detached card and the whole vocabulary. */
  ok(/function destroy\(\)/.test(combo)
     && /document\.removeEventListener\('mousedown', offClick\)/.test(combo),
    'and can be taken off an input again, for a list of cards that is re-rendered');

  /* THE CASCADE IS ONE FILE, AND BOTH PAGES MOUNT IT. It used to live inside
     oa-jobform.js, bound to three ids on the posting form — and the review
     queue asks the maintainer the same three questions about the same three
     names. A copy is the drift every other shared module in this repository
     exists to prevent, and no test could have told the two apart. */
  const pick = await readFile(path.join(HERE, '..', 'assets', 'oa-place-picker.js'), 'utf8');
  ok(/setScope\(/.test(pick) && /bySchool/.test(pick),
    'oa-place-picker.js drives the cascade from byUniversity and bySchool');
  ok(/var S = window\.OASchools;/.test(pick) && /if \(!S\) return;/.test(pick),
    'and the three lists still work on a page that never loaded oa-schools.js');
  ok(/S\.canonColumns\(\{/.test(pick),
    'the fields are put into the published spelling by the SAME canon the submission uses');
  ok(/unit: S\.canonUnit\(v, val\(inst\)\) \}\)\.unit;/.test(pick)
     && /publishAs: S \? function \(v\) \{/.test(pick),
    'a name not on the list is offered as it will be published — canon, then the ' +
    'approved corrections overlay (fixedPlace), the same order every ingest applies');
  ok(/S\.canonUnit\(v, val\(inst\)\)/.test(pick) && /var keyUnit = S \? function \(v\)/.test(pick),
    'and the department picker groups by the university too, so a scoped name is not folded away');
  ok(/canonColumns\(\{/.test(pick) && !/canonPlace\(\{/.test(pick),
    'but a lone institution is not read as one of the archive’s fused one-column values');
  ok(/destroy: function \(\) \{/.test(pick) && /combos\[k\]\.destroy\(\)/.test(pick),
    'and the whole cascade can be unmounted, pickers and listeners together');
  /* One request per file per page is the site-wide rule, and a queue of forty
     cards would otherwise ask for the vocabulary forty times. */
  ok(/var pending = Object\.create\(null\);/.test(pick)
     && /if \(!pending\[key\]\)/.test(pick),
    'and the vocabulary is fetched once however many cards mount it');
  ok(/delete pending\[key\];/.test(pick),
    'a failed read is not remembered, so one flaky request is not inherited by every later mount');

  const form = await readFile(path.join(HERE, '..', 'assets', 'oa-jobform.js'), 'utf8');
  ok(/OAPlacePicker\.wire\(/.test(form),
    'the posting form mounts the shared cascade rather than carrying its own');
  ok(!/byUniversity/.test(form),
    'and no longer walks the vocabulary itself — one implementation, not two');
  ok(!/'f-institution', 'f-school'\].forEach\(function \(id\) \{\n\s*var el = \$\(id\);\n\s*if \(el\) el\.dispatchEvent\(new Event\('change'/.test(form),
    'and an edit does not settle the INSTITUTION, whose spelling a permalink is built from');

  const panel = await readFile(path.join(HERE, '..', 'assets', 'oa-jobreview.js'), 'utf8');
  ok(/OAPlacePicker\.wire\(/.test(panel),
    'the review card mounts the same cascade the posting form does');
  ok(/unmountPickers\(\)/.test(panel) && /m\.destroy\(\)/.test(panel),
    'and gives its pickers back before it redraws the queue');

  /* Deferred scripts run in document order, so the names module and the picker
     have to be listed before whatever mounts them. */
  /* admin-area.html, not feedback.html: the review panel — and with it the
     cascade — moved to the Admin area when it gathered every review queue. */
  for (const page of ['post-a-job.html', 'admin-area.html']) {
    const html = await readFile(path.join(HERE, '..', page), 'utf8');
    const at = html.indexOf('oa-schools.js');
    ok(at !== -1 && at < html.indexOf('oa-combo.js'),
      `${page}: loads the names module before the picker`);
    const cascade = html.indexOf('oa-place-picker.js');
    ok(cascade !== -1 && cascade > html.indexOf('oa-combo.js'),
      `${page}: loads the cascade after the picker it mounts`);
  }
  const adminArea = await readFile(path.join(HERE, '..', 'admin-area.html'), 'utf8');
  // the SCRIPT TAGS, not the first mention — the page's own comments name the
  // modules long before the tags do
  ok(adminArea.indexOf('src="assets/oa-place-picker.js"') <
     adminArea.indexOf('src="assets/oa-jobreview.js"'),
    'admin-area.html: and before the review panel that asks for it');
}

/* --------------------------------- a renamed department keeps its readers

   Publishing one spelling per place MOVES a name: the site now says
   "Operations & Information Systems" where a posting said "Operations and
   Information Systems". A saved e-mail alert holds free text, not a name, so
   nothing can canonicalise it the way canonCountry does for countries — the
   text search itself has to be the forgiving side, on BOTH the site and the
   e-mails, or a subscriber quietly stops hearing from us. */

async function testRenamedNamesStillFound() {
  const M = require(path.join(HERE, '..', 'assets', 'oa-alert-match.js'));

  /* Against the REAL served postings, not an invented row: an invented one is
     how this guard first shipped asserting on a department no posting carries
     and that oa-schools.js would never publish. */
  const jobs = JSON.parse(await readFile(JOBS, 'utf8'));
  const matches = (text) => jobs.filter((r) => M.matchesJob(r, { topics: ['jobs'], text })).length;

  /* Each of these is a phrase the site published BEFORE the names were
     canonicalised, taken from the old file, and each one matched nothing
     afterwards. An alert holds free text, so nothing can rewrite what the
     subscriber saved — the search has to be the forgiving side. */
  const was = [
    ['Operations and Information Systems', 'an "and" the site now writes as "&"'],
    ['SCM', 'an abbreviation the site now spells out'],
    ['Penn State', 'a university under the name it was posted as'],
    ['IEOR', 'an acronym the site no longer prints, but the initials still spell'],
    ['DADS', 'and another'],
    ['TOM', 'and a three-letter one'],
    ['Management Sciences Area', 'a department with the house word it was posted with'],
  ];
  for (const [text, why] of was) {
    ok(matches(text) > 0, `an alert saved as "${text}" still matches — ${why}`);
  }

  ok(matches('Marketing') > 0, 'an ordinary word still matches');
  ok(matches('Wibble') === 0, 'a word nobody has posted still matches nothing');
  ok(matches('Systems Operations') === 0, 'and it is a substring search, not a bag of words');
  ok(matches('ZZQX') === 0, 'an acronym that spells no initials matches nothing');

  /* The jobs page and the e-mails must read a search the same way, or "what I
     see on the site" and "what I am e-mailed" mean different things — the
     reason oa-alert-match.js carries that comment over its own fold. Both
     rules, pinned in both files. */
  const RULES = [
    ["replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, '')", 'folds a search'],
    ['var ACRONYM = /^[A-Z]{2,6}$/;', 'takes an all-caps needle for an acronym'],
    ['function initials(s) {', 'and matches it against the initials'],
  ];
  for (const f of ['oa-list.js', 'oa-alert-match.js']) {
    const src = await readFile(path.join(HERE, '..', 'assets', f), 'utf8');
    for (const [rule, what] of RULES) {
      ok(src.includes(rule), `${f}: ${what} the same way as the other side`);
    }
  }

  /* and the page that runs the matcher has the names module it now asks */
  const alerts = await readFile(path.join(HERE, '..', 'alerts.html'), 'utf8');
  const at = alerts.indexOf('oa-schools.js');
  ok(at !== -1 && at < alerts.indexOf('oa-alert-match.js'),
    'alerts.html: loads the names module before the matcher');
}

/* ------------------------------ the six units their school names its own way

   The owner ruled on six pairs of names the site was carrying for ONE group
   (2026-08-18), and four of the answers keep a wrapper word the generic rule
   strips — "Operations Management Area", "Operations Department". The rule is
   right in general and wrong for these, so SCOPED_UNIT_ALIASES pins them by
   university and the answer is returned TERMINALLY, never re-stripped.

   Pinned name by name because these are somebody's decision, not a rule: a
   refactor that quietly reverted one would otherwise show up only as a school
   listed twice again, months later.                                          */

/* A DUPLICATE KEY IN AN OBJECT LITERAL IS SILENT. Adding a second
   'Stanford University' to SCOPED_SCHOOL_ALIASES did not merge with the first
   or raise anything — JavaScript kept the LAST and dropped the earlier rule
   entirely, so an alias that had been working for weeks stopped, and the only
   symptom was Stanford appearing twice in the school list. The tables are read
   from the SOURCE, because by the time the module has evaluated the evidence
   is gone. */
async function testNoDuplicateKeys() {
  const src = await readFile(path.join(HERE, '..', 'assets', 'oa-schools.js'), 'utf8');
  for (const table of ['INSTITUTION_ALIASES', 'SCHOOL_ALIASES', 'SCOPED_SCHOOL_ALIASES',
    'UNIT_ALIASES', 'SCOPED_UNIT_ALIASES', 'FUSED_SCHOOLS', 'FUSED_INSTITUTIONS']) {
    const at = src.indexOf(`var ${table} = {`);
    ok(at !== -1, `oa-schools.js declares ${table}`);
    if (at === -1) continue;

    /* the literal, brace-matched — these tables nest one level */
    let depth = 0, end = at;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    const body = src.slice(at, end);

    /* keys at the TOP level of this literal only: a nested table's keys are
       another scope and may legitimately repeat across universities */
    const keys = [];
    depth = 0;
    for (const line of body.split('\n')) {
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      const m = line.match(/^\s*'((?:[^'\\]|\\.)*)'\s*:/);
      if (m && depth === 1) keys.push(m[1]);
      depth += opens - closes;
    }
    const seen = new Set(), dupes = [];
    for (const k of keys) { if (seen.has(k)) dupes.push(k); else seen.add(k); }
    eq(dupes, [], `${table} names each of its ${keys.length} keys once`);
  }
}

/** A university's entry in the built vocabulary, found by its own IDENTITY.
    `byUniversity` is keyed by the spelling the site publishes most, and that
    moves with the postings — so anything asserting about a PLACE has to ask
    `institutionKey`, the same fold the vocabulary groups by. */
function uniEntry(vocab, name) {
  const S = require(path.join(HERE, '..', 'assets', 'oa-schools.js'));
  const want = S.institutionKey(name);
  const by = (vocab && vocab.byUniversity) || {};
  if (by[name]) return by[name];
  for (const [k, e] of Object.entries(by)) if (S.institutionKey(k) === want) return e;
  return null;
}

async function testScopedUnits() {
  const S = require(path.join(HERE, '..', 'assets', 'oa-schools.js'));

  const RULED = [
    ['Emory University', 'Goizueta Business School',
      ['Operations Management', 'Information Systems and Operations Management',
        'Information Systems & Operations Management'],
      'Information Systems & Operations Management'],
    ['Purdue University', 'Mitchell E. Daniels, Jr. School of Business',
      ['Operations Management', 'Operations Management Area', 'Supply Chain and Operations Management'],
      'Supply Chain and Operations Management Faculty'],
    ['The University of Texas at Dallas', 'Naveen Jindal School of Management',
      ['Operations Management', 'Supply Chain and Operations Management',
        'Supply Chain/Operations Management Department'],
      'Operations Management Area'],
    ['University College Dublin', 'Michael Smurfit Graduate Business School',
      ['Management', 'Operations Management', 'Operations Management Group'],
      'Management Area'],
    ['University of Miami', 'Miami Herbert Business School',
      ['Management', 'Management Science', 'Department of Management'],
      'Management Area'],
    ['Yale University', 'School of Management',
      ['Operations', 'Operations Management', 'Operations Management group'],
      'Operations Department'],
    ['Binghamton University', 'School of Management',
      ['Operations and Business Analytics', 'Business Analytics and Operations area'],
      'Business Analytics and Operations'],
    ['Stanford University', 'Stanford Graduate School of Business',
      ['Operations and Information Technology', 'Operations, Information and Technology',
        'Operations and Information Technology Department'],
      'Operations, Information, and Technology (OIT) area'],
    ['The University of Hong Kong', 'Faculty of Business and Economics',
      ['Innovation and Information Management', 'Innovation and Information Management Area'],
      'Information and Innovation Management'],
    ['Cornell University', 'Cornell SC Johnson College of Business',
      ['Operations, Technology and Information Management', 'Operations Management group'],
      'Operations, Technology, and Information Management Area'],
    ['UT San Antonio', 'Carlos Alvarez College of Business',
      ['Operations and Analytics'], 'Operations and Analytics Department'],
    /* one unit written short (owner, 2026-08-23) — the pair the review sweep
       raised when a form posting filed "Operations Management" beside the
       directory's full name */
    ['The Chinese University of Hong Kong, Shenzhen', 'School of Management and Economics',
      ['Operations Management'],
      'Information Systems and Operations Management'],
  ];

  const v = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'vocab.json'), 'utf8'));

  /* The lookup itself, pinned: a ruling names a university one way and the
     vocabulary files it under whichever spelling has the most postings. */
  eq(uniEntry({ byUniversity: { 'University of Texas at Dallas': { bySchool: { A: [] } } } },
    'The University of Texas at Dallas').bySchool.A, [],
  'a university is found however the vocabulary happens to spell it today');
  eq(uniEntry({ byUniversity: {} }, 'Nowhere University'), null,
    'and a university the vocabulary does not carry is simply absent');

  for (const [uni, school, variants, name] of RULED) {
    for (const variant of variants) {
      eq(S.canonUnit(variant, uni), name, `${uni}: "${variant}" publishes as "${name}"`);
    }
    eq(S.canonUnit(name, uni), name, `and "${name}" is already itself (idempotent)`);
    ok(S.isCanonicalUnit(name), `and canonical, though the generic rule would strip it`);

    /* the school really is the one the owner named, and really is the only
       school at that university carrying the name — which is what makes a
       table keyed by UNIVERSITY safe here.

       LOOKED UP BY THE UNIVERSITY'S KEY, not by the name this table writes.
       `byUniversity` is keyed by whichever SPELLING the site publishes most,
       which `pickForm` calls "a tie-break, not a policy" — so one new posting
       under "University of Texas at Dallas" moved the entry off "The
       University of Texas at Dallas" and this guard failed on a vocabulary
       with nothing wrong in it, while the build it was re-checking committed
       nothing. The ruling is about a PLACE; the spelling it is filed under is
       not part of it. */
    const bySchool = uniEntry(v, uni) && uniEntry(v, uni).bySchool;
    ok(bySchool && Array.isArray(bySchool[school]),
      `${uni} lists ${school}`);
    if (bySchool) {
      const elsewhere = Object.entries(bySchool)
        .filter(([s]) => s && s !== school)
        .filter(([, list]) => list.includes(name)).map(([s]) => s);
      eq(elsewhere, [], `and no other school at ${uni} claims "${name}"`);
      eq(bySchool[school].filter((u) => variants.slice(0, 2).includes(u)), [],
        `and the names it replaced are gone from ${school}`);
    }
  }

  /* THE SCHOOL A ROW NEVER NAMED. The tracking workbook has no column for it,
     so UT San Antonio's posting arrived as a university and a department with
     nothing between them — the card showed the department floating under the
     university and the school was missing from the filters entirely. UNIT_HOME
     supplies it, curated one line per (university, department) because a
     department name cannot imply its school and guessing would file postings
     under schools nobody named.

     The load-bearing half is the second check: a row that DOES name its school
     keeps it. A default that overrode what a poster wrote would be a rename,
     not a fill. */
  eq(S.canonPlace({ institution: 'University of Texas at San Antonio', school: '', unit: 'Operations and Analytics' }),
    { institution: 'UT San Antonio', school: 'Carlos Alvarez College of Business',
      unit: 'Operations and Analytics Department' },
  'a posting with no school gets the one its department sits in');
  eq(S.canonPlace({ institution: 'UT San Antonio', school: 'College of Engineering', unit: 'Operations and Analytics' }).school,
    'College of Engineering', 'and a posting that names its own school keeps it');
  eq(S.canonPlace({ institution: 'UT San Antonio', school: '', unit: '' }).school, '',
    'and a row with no department is given nothing to sit in');

  /* ELSEWHERE THE GENERIC RULE IS UNTOUCHED. This is the whole safety
     argument for a scoped table: a poster at any other school still gets the
     bare field name, so the wrapper word cannot start splitting one unit into
     three again. */
  for (const uni of ['Duke University', 'Michigan State University', '']) {
    eq(S.canonUnit('Operations Management Area', uni), 'Operations Management',
      `"Operations Management Area" is still just Operations Management at ${uni || 'no university'}`);
    eq(S.canonUnit('Operations Department', uni), 'Operations',
      `as "Operations Department" is Operations at ${uni || 'no university'}`);
  }
}

/* ------------------------------- the count beside "My postings"

   The menu named the pages but not how much was in them, so "My postings"
   read the same whether you had none or a dozen. The number is what tells a
   reader the page is worth opening — the shape /lit/'s account menu already
   uses.

   Cheap by construction, and these checks are what keep it that way: the
   badge paints from a cache, refreshes ONCE PER SESSION rather than per page
   (a menu on a static site is on every page), and the two pages that already
   hold the real list correct it for nothing.                                */

async function testAccountCounts() {
  const acct = await readFile(path.join(HERE, '..', 'assets', 'oa-accounts.js'), 'utf8');

  ok(/data-count="postings"/.test(acct) && /data-count="alerts"/.test(acct),
    'the account menu carries a count beside My postings and E-mail alerts');
  ok(/setCount: setCount/.test(acct),
    'and exports setCount, so a page holding the list can correct it');

  /* the honest-number rules, both of them */
  ok(/typeof n === 'number' && n > 0/.test(acct),
    'a count is shown only when we KNOW it and it is more than zero');
  ok(/COUNT_SESSION/.test(acct) && /sessionStorage/.test(acct),
    'and refreshed once per session, not once per page');
  ok(/ref\.count === 'function'/.test(acct),
    'using a count() aggregate — one read whatever the collection holds');

  /* signing out must not leave the next person the last one's numbers */
  ok(/removeItem\(COUNT_KEY\)/.test(acct),
    'signing out forgets the counts');

  /* and the account it belongs to is checked, so a cache cannot cross accounts */
  ok(/all\.uid === uid/.test(acct), 'the cache is keyed to its own account');
  ok(/state\.user\.uid !== uid/.test(acct),
    'and a read that lands after a sign-out is dropped');

  /* the maintainer's own badge, same rules */
  ok(/data-count="admin"/.test(acct),
    'the menu carries a count beside Admin area');
  ok(/adminish\(u\)/.test(acct) && /adminish\(state\.user\)/.test(acct),
    'drawn and refreshed only for the maintainer — every other visitor pays ' +
    'nothing for it');
  ok(/OAAdminArea\.pendingCounts\(\)/.test(acct),
    'and the number comes from OAAdminArea.pendingCounts — THE function the ' +
    'Admin area page draws its tiles from, so menu and page cannot disagree');

  for (const [file, what, n] of [['assets/oa-myjobs.js', 'postings', 'docs.length'],
    ['assets/oa-alerts.js', 'alerts', 'alerts.length'],
    ['assets/oa-adminarea.js', 'admin', 'total']]) {
    const js = await readFile(path.join(HERE, '..', file), 'utf8');
    ok(new RegExp(`setCount\\('${what}', ${n.replace('.', '\\.')}\\)`).test(js),
      `${file} corrects the ${what} count from the list it already loaded`);
  }
}

/* --------------------------- the same names on the map and the faculty list

   "Let's use the same consistent University Name, School Name, Department
   Name, across the entire website" (owner, 2026-08-18). The postings had been
   canonical for a while; the two datasets the IMPORTER writes had never been
   canonicalised at all — 213 of the map's 254 rows and 9 faculty placements
   named their place some other way, and the map is where a reader lands from
   every posting's "Further info" link.

   They have no daily build to heal them, which is exactly why they drifted, so
   they get `import-legacy-tables.mjs --heal-names` and this guard.            */

async function testEveryDatasetNamesPlacesTheSameWay() {
  const S = require(path.join(HERE, '..', 'assets', 'oa-schools.js'));
  const read = async (f) => JSON.parse(await readFile(path.join(HERE, '..', 'data', f), 'utf8'));

  const map = await read('universities.json');
  const off = map.filter((r) => {
    const p = S.canonColumns({ institution: r.institution, school: r.school, unit: r.department });
    return p.institution !== r.institution || p.school !== (r.school || '') || p.unit !== (r.department || '');
  }).map((r) => r.id);
  eq(off, [], 'data/universities.json: the map names every place the way the site does');

  /* the two DERIVED fields follow the three names, or the popup heading and
     its "School, Department" line would disagree with the row beneath them */
  const join = (a, b) => [a, b].filter(Boolean).join(', ');
  const loose = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
  const names = map.filter((r) => loose(r.name) !== loose(join(r.institution, r.school))
                               && loose(r.name) !== loose(r.institution)).map((r) => r.id);
  eq(names, [], 'and each row\'s display name is its university and school, joined');

  /* ids do NOT follow a rename: the maintainer's read-time corrections are
     stored against them (rowOverrides), so a moved id orphans every one */
  ok(map.every((r) => typeof r.id === 'string' && r.id), 'and every row still has its id');

  /* THE IMPORTER HEALS ON WRITE, not only in --heal-names. data/ is rewritten
     from the Google Sheets whenever the legacy import is dispatched, so a mode
     that fixes the committed file is not enough on its own: the next --fetch
     puts the sheet's own spellings back. CI caught exactly that — the import
     job fetched, wrote 254 raw rows, and the guard above went red on 213 of
     them — so every write path is pinned here, by name. */
  const importer = await readFile(path.join(HERE, 'import-legacy-tables.mjs'), 'utf8');
  for (const [call, what] of [
    [/await write\('universities\.json', uni,/, 'the map'],
    [/await write\('recent-faculty\.json', placements,/, 'the faculty list'],
    [/await write\('past-postings\.json', rows\.map\(healPlace\),/, 'the postings archive'],
  ]) {
    ok(call.test(importer), `import-legacy-tables.mjs canonicalises ${what} as it writes it`);
  }
  ok(/const uni = rows\.map\(healUniversity\)/.test(importer)
     && /const placements = rows\.map\(healFaculty\)/.test(importer),
  'and the healed rows are what its meta is built from, not the raw ones');

  const faculty = await read('recent-faculty.json');
  const badFac = [];
  for (const r of faculty) {
    for (const field of ['placement', 'almaMater', 'undergrad']) {
      if (r[field] && S.canonInstitution(r[field]) !== r[field]) badFac.push(`${r.id}.${field}`);
    }
  }
  eq(badFac, [], 'data/recent-faculty.json: and so does the recent-faculty list');

  /* THE TWO POSTINGS THE COLLAPSE BUG TOOK — pinned against the FUNCTION, in
     testCollapse above, and no longer against the served file.

     They were pinned against the file too, because that is where the loss
     would show. That worked while they were the only Houston postings of
     2025-09-23. They are not: the tracking workbook holds THREE of its own for
     that day, a posting's id is (year, institution, date) plus an ordinal, and
     ids are how the merge joins — so when the maintainer approved the season
     the workbook's rows took `…-20250923` and `…-20250923-2`, and the two
     legacy rows went with them, advertisement links and all. The guard then
     failed on rows it was never about, which stops the commit and therefore
     stops the whole site publishing.

     Naming the two ids did not survive that, and neither did naming their
     advertisements, because the rows carrying them are gone. There is nothing
     left in the file to assert ON — so the assertion belongs where the RULE
     is: `collapseSameDay` refusing to fold two rows that name different
     advertisements, which testCollapse says in the Houston case's own words.

     AND NOTHING REPLACES IT AT THE FILE LEVEL. The obvious candidate — no two
     postings name the same advertisement — was written, measured against the
     real data, and thrown away: City University of Hong Kong links its whole
     "current academic vacancies" page from two market years' postings, and UCD
     links one CoreHR endpoint from two. A shared link is not proof of a
     duplicate, so that rule would have failed on legitimate rows, which is the
     very fault this section is about.

     WHAT DISPLACED THEM IS WORTH KNOWING, and it is the maintainer's call (see
     CLAUDE.md): two sources minting the same id for one (year, institution,
     day) collide, and whichever writes later silently wins. */
  const jobs = await read('jobs.json');

  /* the tracking sheet's own file, which build-jobs republishes verbatim */
  const sheet = await read('jobmarket.json');
  const badSheet = sheet.filter((r) => {
    const p = S.canonPlace(r);
    return p.institution !== r.institution || p.school !== (r.school || '') || p.unit !== (r.unit || '');
  }).map((r) => r.id);
  eq(badSheet, [], 'data/jobmarket.json: and so do the tracking sheet\'s postings');
}

/* -------------------------------------------- the seed of the world's schools

   assets/oa-institutions.js says which places EXIST; assets/oa-schools.js says
   what each is CALLED. Two canon()s would be two answers to one question and
   the disagreement would be silent, so the seed holds no naming rules at all
   and every one of its rows goes through canonColumns on the way into the
   vocabulary.                                                                */

async function testInstitutionSeed() {
  const I = require(path.join(HERE, '..', 'assets', 'oa-institutions.js'));
  const S = require(path.join(HERE, '..', 'assets', 'oa-schools.js'));

  ok(I.LIST.length > 150, `the seed carries ${I.LIST.length} schools`);
  ok(typeof I.canon !== 'function' && !I.ALIASES,
    'and no canon of its own — oa-schools.js is the single definition of a name');

  /* the rows the build feeds buildVocab: three names, three columns */
  const rows = I.directoryRows();
  ok(rows.length >= I.LIST.length, `directoryRows() yields ${rows.length} (institution, school, department) rows`);
  eq(rows.filter((r) => !r.institution).length, 0, 'every seeded row names its university');
  eq(rows.filter((r) => typeof r.school !== 'string' || typeof r.department !== 'string').length, 0,
    'and carries both other columns, even when empty');

  /* The source is a BUSINESS-SCHOOL directory — one university, one school —
     so a second school for a university comes from the site's own directory
     beside it. The seed must therefore never be the only source consulted,
     and it never is: build-jobs.mjs concatenates it with universities.json.
     (The cascade that keeps two schools apart is tested on the built
     vocabulary, in testVocabFile, which is where it actually has to hold.) */
  /* A university that IS its own school carries neither (Kühne Logistics
     University), which is legitimate: it still adds the university to the
     picker, which is the whole point of the seed. What is not legitimate is
     a school with no university to hang it on. */
  eq(I.LIST.filter((r) => !r.u).length, 0, 'every seeded record names its university');
  ok(I.LIST.filter((r) => r.s || (r.d || []).length).length > I.LIST.length * 0.95,
    'and all but a handful name a school, a department, or both');

  /* alphabetical, accents folded — the order the file is read and edited in */
  const names = I.LIST.map((r) => r.u);
  const sorted = names.slice().sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  eq(names.findIndex((n, i) => n !== sorted[i]), -1, 'the seed is written in alphabetical order');

  /* and it publishes nothing of its own: every name it contributes is the
     name oa-schools.js would publish, or the vocabulary would list a place
     twice — once as the seed spells it, once as the site does */
  const odd = rows.filter((r) => {
    const p = S.canonColumns({ institution: r.institution, school: r.school, unit: r.department });
    return p.institution !== S.canonInstitution(r.institution);
  }).slice(0, 5);
  eq(odd, [], 'every seeded university name is stable under the canon');
}

/* ------------------------------------------ all three forms offer the list

   The owner's request was for the university, school and department lists in
   the JOB form, the CANDIDATE form and the PLACEMENT form. The job form has
   three cascading boxes; the placement form has three institution boxes; the
   candidate form has ONE free-text "Current affiliation" — deliberately, since
   a candidate writes "Wharton, University of Pennsylvania" and the published
   field, the card and the alert matcher have always carried that as one
   string. So it gets the picker WITHOUT being split.                        */

async function testFormsOfferVocab() {
  const read = async (f) => readFile(path.join(HERE, '..', f), 'utf8');
  for (const page of ['post-a-job.html', 'post-a-candidate.html', 'post-a-placement.html']) {
    const html = await read(page);
    const combo = html.indexOf('oa-combo.js');
    ok(combo !== -1, `${page}: loads the picker`);
    const schools = html.indexOf('oa-schools.js');
    ok(schools !== -1 && schools < combo,
      `${page}: loads the names module first, so two spellings group as one name`);
  }
  /* The job form's own vocabulary read moved into the shared cascade
     (assets/oa-place-picker.js) when the review queue started mounting the same
     three boxes — so the file that has to name vocab.json is that one. */
  for (const [file, what] of [['assets/oa-place-picker.js', 'cascade'],
    ['assets/oa-candidateform.js', 'candidate'], ['assets/oa-placementform.js', 'placement']]) {
    const js = await read(file);
    ok(/vocab\.json/.test(js), `the ${what} form fetches data/vocab.json`);
    ok(/institutionKey/.test(js), `and groups its universities the site's way`);
  }
}

/* ---------------------------------------------------- the picker in the dark

   The reported bug: with the dark theme on, the dropdown drew a white card and
   inherited `--ink` for its text — near-white on white. It was not a contrast
   NEAR-miss, it was an invisible list, and it happened because the panel named
   a colour for its background and none for its ink.

   The rule this pins is the general one: anything that paints its own ground
   must name its own ink, and both must come from the theme.                  */

async function testPickerTheme() {
  const css = await readFile(path.join(HERE, '..', 'assets', 'oa-ui.css'), 'utf8');
  const block = (sel) => {
    const at = css.indexOf(sel + ' {');
    return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  };

  for (const sel of ['.oa-combo-list', '.oa-combo-group']) {
    const b = block(sel);
    ok(b, `oa-ui.css declares ${sel}`);
    ok(!/background:\s*#/.test(b), `${sel} takes its background from the theme, not a fixed colour`);
  }
  ok(/color:\s*var\(--ink/.test(block('.oa-combo-list')),
    'and the panel names its own ink, so it cannot inherit the page\'s');

  /* the fallbacks matter: /v1/ and /v2/ are frozen trees that may load this
     file without v3.css's tokens, and must go on rendering as they did */
  for (const m of block('.oa-combo-list').match(/var\(--[a-z0-9-]+[^)]*\)/g) || []) {
    ok(/,\s*\S/.test(m), `${m} keeps a fallback for a page with no theme tokens`);
  }
}

/* ------------------------------------------- the served vocabulary file

   data/vocab.json is what the posting form fetches, and nothing else on the
   site reads it — so a shape mistake shows up as a form that quietly stops
   narrowing rather than as an error anybody sees. It is REBUILT here from the
   committed sources and compared, which also pins that the build is
   deterministic and that the two files are in step.                          */

async function testVocabFile() {
  const S0 = require(path.join(HERE, '..', 'assets', 'oa-schools.js'));
  const read = async (name) =>
    JSON.parse(await readFile(path.join(HERE, '..', 'data', name), 'utf8'));
  const v = await read('vocab.json');
  const jobs = await read('jobs.json');
  const directory = await read('universities.json');

  for (const key of ['universities', 'schools', 'units', 'byUniversity', 'bySchool']) {
    ok(v[key] !== undefined, `vocab.json carries ${key}`);
  }

  /* TWO directories, exactly as build-jobs.mjs feeds them: the site's own
     Universities page, and the seed of the world's operations and supply chain
     schools (assets/oa-institutions.js) that lets a first-time poster from a
     university nobody has posted from find their school already listed. */
  const seed = require(path.join(HERE, '..', 'assets', 'oa-institutions.js'));
  const rebuilt = buildVocab(jobs, {
    generated: v.generated,
    directory: [...directory, ...seed.directoryRows()],
  });
  eq(serialiseVocab(rebuilt), serialiseVocab(v),
    'vocab.json is exactly what the postings and the two directories rebuild');

  /* the seed's whole point: a place with no posting is offered anyway. Every
     one of its universities is on the list, and carries no posting count it
     did not earn. */
  const offered = new Map(v.universities.map((o) => [S0.institutionKey(o.v), o]));
  const missing = seed.universities().filter((u) => !offered.has(S0.institutionKey(u)));
  eq(missing, [], 'every seeded university is offered by the posting form');
  const jobUnis = new Set(jobs.map((r) => S0.institutionKey(r.institution || '')));
  const invented = seed.universities()
    .filter((u) => !jobUnis.has(S0.institutionKey(u)))
    .filter((u) => (offered.get(S0.institutionKey(u)) || {}).n !== 0)
    .slice(0, 5);
  eq(invented, [], 'and a seeded university nobody has posted from counts for nothing');

  /* the spelling the form offers is the spelling the site publishes: the
     analogue of testCountries' isCanonical pass over the served data */
  const S = S0;
  eq(v.schools.filter((o) => !S.isCanonicalSchool(o.v)).map((o) => o.v), [],
    'every school the form offers is the one the site publishes');
  eq(v.units.filter((o) => !S.isCanonicalUnit(o.v)).map((o) => o.v), [],
    'and every department is');
  eq(v.universities.filter((o) => S.canonInstitution(o.v) !== o.v).map((o) => o.v), [],
    'and every university');

  /* THE ARCHIVE READS THIS FILE TOO. /v2/ ships its own frozen oa-combo.js and
     oa-jobform.js, which read universities/schools/units and byUniversity's
     schools/units. Those four keys are therefore load-bearing for a tree
     nobody edits any more — bySchool was ADDED beside them, never instead. */
  const anyUni = Object.keys(v.byUniversity)[0];
  ok(Array.isArray(v.byUniversity[anyUni].schools) && Array.isArray(v.byUniversity[anyUni].units),
    '/v2/ still finds byUniversity[x].schools and .units');
  ok(v.universities.every((o) => typeof o.v === 'string' && typeof o.n === 'number'),
    'and the three flat lists are still {v, n}');

  /* A UNIVERSITY'S TWO SCHOOLS ARE TWO SCHOOLS — the one thing the merge must
     never do (the owner's words: a university may have a business school and
     an industrial engineering school; they have different departments and are
     not duplicates). Auburn is the canonical case: Supply Chain Management
     under Harbert, Industrial and Systems Engineering outside it. */
  const twoSchools = Object.entries(v.byUniversity)
    .filter(([, e]) => Object.keys(e.bySchool).filter(Boolean).length > 1);
  ok(twoSchools.length > 15,
    `${twoSchools.length} universities keep more than one school, each with its own departments`);
  const split = twoSchools.filter(([, e]) => {
    const lists = Object.entries(e.bySchool).filter(([k]) => k).map(([, l]) => l.join('|'));
    return new Set(lists).size > 1;
  });
  ok(split.length > 10, 'and their department lists differ, so the cascade is really narrowing');

  /* …AND NO UNIVERSITY LISTS ONE SCHOOL TWICE, which is the other half of the
     same request. Two hand-compiled sources name a school long and short —
     "Sloan School of Management" and "MIT Sloan School of Management" — and
     the picker showed both with the postings on one row and the departments
     on the other. oa-schools.js's scoped aliases are where that is settled. */
  /* TWO COMPARISONS, BECAUSE ONE OF THEM IS BLIND. A substring check finds
     "Haas" inside "Walter A. Haas School of Business" and misses the pairs
     that put the SAME WORDS IN A DIFFERENT ORDER — "Michael Smurfit Graduate
     Business School" vs "UCD Michael Smurfit Graduate School of Business",
     "Olin Business School" vs "Olin School of Business". Both went on being
     offered twice through a green suite that only looked one way.

     So the second comparison is the DISTINCTIVE WORDS as a set, dropping the
     generic ones ("school", "of", "business") and the university's own name
     and initials — otherwise "UCD" or "Business" would keep two spellings of
     one school apart for ever. */
  /** Every pair of names in `list` that is probably one name written twice —
      asked THROUGH the module (oa-schools.js similarNames), the same
      judgement the posting form's "did you mean" rows point a typed
      near-miss at, so the sweep and the form cannot disagree about what a
      duplicate is. STRICT tier deliberately: a pair this sweep flags fails
      the build, and the fuzzy suggestion tier ("Management" is CONTAINED in
      "Operations Management") is exactly what a build-failing assertion must
      not use — only the owner can say whether those are one group or two. */
  const samePair = (list, uni) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (S.similarNames(list[i], list[j], { university: uni })) {
          out.push([list[i], list[j]]);
        }
      }
    }
    return out;
  };

  const dupSchools = [];
  for (const [u, e] of Object.entries(v.byUniversity)) {
    for (const [a, b] of samePair(Object.keys(e.bySchool).filter(Boolean), u)) {
      dupSchools.push(`${u}: ${a} / ${b}`);
    }
  }
  tidy(dupSchools, 'and no university offers one school under two names');

  /* THE SAME, ONE LEVEL DOWN: two names for one department under one school.
     Each is a judgement only the owner can make — "Management" and
     "Operations Management" at one school may be one group or two — so the
     ones still awaiting an answer are NAMED here rather than silently
     tolerated or guessed at. A pair not on this list fails the build; a pair
     on it is reported by `node _scraper/selftest.mjs --open`. Delete the entry
     when the owner rules on it (the answer goes in SCOPED_UNIT_ALIASES). */
  const AWAITING_OWNER = new Set([
    /* THE WORKBOOK WRITES A FIELD WHERE THE SITE ASKS FOR A DEPARTMENT. Its
       hiring-unit column holds what the post is IN — "OM", "BA", "SCM/OM",
       "IS/BA" — and the pipeline publishes that as the department name, so one
       department arrives under an acronym, its expansion and every ordering of
       a slash pair. Fourteen such pairs came in with one batch of approvals.
       They are the owner's to rule on (the answer to each goes in
       SCOPED_UNIT_ALIASES), and the real remedy is upstream: name the
       department in the sheet, or teach the ingest that a field code is not a
       department. Listed here so they are not silently tolerated. */
    'Auburn University|BA|BA/IS',
    'Auburn University|BA|IS/BA',
    'Auburn University|BA/IS|IS/BA',
    'Chicago Booth|OM|OM/SCM',
    'Eastern New Mexico University|OM|Production and OM',
    'Middle Georgia State University|Management|Supply Chain Management',
    'Texas State University|Analytics|IS and Analytics',
    'Texas State University|IS|IS and Analytics',
    'University of California, Berkeley|IEOR|IEOR, decision analytics',
    'University of Houston|OM|OM/IS',
    'University of Houston|OM|OM/SCM',
    'University of Houston|OM|SCM/OM',
    'University of Houston|OM/SCM|SCM/OM',
    'University of Texas at Dallas|OM|OM/IS (Healthcare Management)',
    /* Two more pairs from the same batch of sheet approvals (2026-08-23,
       arrived on master with the 449-posting publish and left its own
       selftest red — which stops every build committing). Each is a
       judgement only the owner can make: St. John's may house Business
       Analytics inside a wider Business Analytics and Information Systems
       department or beside it, and Kansas's "Operations research" reads
       like the field tacked onto the department's own name. */
    "St. John's University|Business Analytics|Business Analytics and Information Systems",
    'University of Kansas|Analytics, Information, Operations|Analytics, Information, Operations research',
  ]);
  /* KEYED BY THE UNIVERSITY'S IDENTITY, not by the spelling the vocabulary
     files it under today — that is `pickForm`'s tie-break and it moves with
     the postings, which is exactly how the UTD ruling above stopped matching
     the morning one new posting dropped a "The". */
  const awaitingKey = (u, a, b) => `${S.institutionKey(u)}|${a}|${b}`;
  const awaiting = new Map();
  for (const entry of AWAITING_OWNER) {
    const [u, a, b] = entry.split('|');
    awaiting.set(awaitingKey(u, a, b), entry);
  }
  const dupUnits = [], openUnits = [], seenAwaiting = new Set();
  for (const [u, e] of Object.entries(v.byUniversity)) {
    for (const list of Object.values(e.bySchool)) {
      for (const [a, b] of samePair(list, u)) {
        /* looked up both ways round: which of the pair the sweep meets first
           depends on the order the vocabulary lists them, which moves as
           postings arrive, and an entry must not stop matching because two
           names swapped places */
        const key = awaiting.has(awaitingKey(u, a, b)) ? awaitingKey(u, a, b)
          : (awaiting.has(awaitingKey(u, b, a)) ? awaitingKey(u, b, a) : '');
        if (key) { openUnits.push(`${u}: ${a} / ${b}`); seenAwaiting.add(key); }
        else dupUnits.push(`${u}: ${a} / ${b}`);
      }
    }
  }
  tidy(dupUnits, 'and no school offers one department under two names, beyond the pairs awaiting a decision');
  /* An entry whose pair is NOT in the committed vocabulary is reported, never
     failed. It has to be listable AHEAD of the pair's arrival: the posting
     that introduces the pair sits in Firestore until the next GREEN build,
     and the old "still really there" equality made that build impossible —
     red before the entry was added (an unlisted pair) and red after it (an
     entry with no pair in yesterday's committed data). Listing it first is
     the only order that works, so the window is allowed and NAMED; an entry
     still on this report after its pair has shipped (or been settled) is
     stale and should be removed. */
  for (const [k, entry] of awaiting) {
    if (!seenAwaiting.has(k)) {
      console.log('  (awaiting-owner entry not (yet) in the committed vocabulary: ' + entry + ')');
    }
  }
  if (process.argv.includes('--open')) {
    for (const line of openUnits) console.log('  awaiting the owner: ' + line);
  }

  /* the same, one level up: one place, one row in the university picker */
  const byKey = new Map();
  const dupUnis = [];
  for (const o of v.universities) {
    const k = S.institutionKey(o.v);
    if (byKey.has(k)) dupUnis.push(`${byKey.get(k)} / ${o.v}`);
    else byKey.set(k, o.v);
  }
  eq(dupUnis, [], 'and each university is offered once');

  /* internal consistency: every name in the cascade is a name the flat lists
     offer, or the picker would show a scope value with no posting count */
  const N = { key: (x) => S.fold(x) };
  const known = (list) => new Set(list.map((o) => N.key(o.v)));
  const schools = known(v.schools), units = known(v.units);
  let loose = 0;
  for (const e of Object.values(v.byUniversity)) {
    for (const s of e.schools) if (!schools.has(N.key(s))) loose++;
    for (const u of e.units) if (!units.has(N.key(u))) loose++;
    for (const [s, list] of Object.entries(e.bySchool)) {
      if (s && !schools.has(N.key(s))) loose++;
      for (const u of list) if (!units.has(N.key(u))) loose++;
    }
  }
  eq(loose, 0, 'every school and department in the cascade is on the list the form offers');

  /* the university picker offers each place once — the bug in the report:
     "A.B. Freeman School of Business" and "Freeman School of Business" both
     on Tulane's list, from one school posted twice */
  const dup = (list) => list.length - new Set(list.map((x) => N.key(x.v || x))).size;
  eq(dup(v.universities), 0, 'no university is offered under two spellings');
  eq(dup(v.schools), 0, 'no school is');
  eq(dup(v.units), 0, 'nor any department');
  const twice = Object.entries(v.byUniversity)
    .filter(([, e]) => dup(e.schools) || dup(e.units)).map(([name]) => name);
  eq(twice, [], 'and no university lists one of its own twice');
}

function testSplitFields() {
  /* GOOD is a University College Dublin posting, and UCD is one of the six
     universities whose own name for its unit overrides the wrapper rule
     (SCOPED_UNIT_ALIASES). These cases are about the GENERIC rule, so they
     name the university whose school they were already using. */
  const GENERIC_UNI = { ...GOOD, institution: 'Duke University' };

  // the form now sends school + unit; department is derived from them
  const r = rowFromSubmission({ ...GENERIC_UNI, department: undefined,
    school: 'Fuqua School of Business', unit: 'Operations Management group' });
  eq(r.school, 'Fuqua School of Business', 'school carried');
  /* the wrapper word comes off on the way in — "group", "Area" and
     "Department" are three houses' words for one department (oa-schools.js) */
  eq(r.unit, 'Operations Management', 'unit carried, wrapper word off');
  eq(r.department, 'Fuqua School of Business, Operations Management',
    'department is derived from the two');

  // either alone is enough
  eq(rowFromSubmission({ ...GENERIC_UNI, department: undefined, school: 'Darden School of Business', unit: '' })
    .department, 'Darden School of Business', 'a school alone publishes');
  eq(rowFromSubmission({ ...GENERIC_UNI, department: undefined, school: '', unit: 'Operations Management' })
    .department, 'Operations Management', 'a unit alone publishes');

  /* …and the scoped name wins where the owner has given one. This is GOOD's
     own university, so it also pins that the fixtures above needed changing
     rather than the rule. */
  eq(rowFromSubmission({ ...GOOD, department: undefined,
    school: 'Michael Smurfit Graduate Business School', unit: 'Operations Management group' }).unit,
  'Management Area', 'a school that names its own unit keeps that name, wrapper and all');
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

  /* THE SDK IS NO LONGER PRELOADED, and that is the point of this check.

     It used to be, and the rule here was that the preload tags must name the
     EXACT scripts oa-firebase.js injects — a version bump on one side without
     the other fetches dead weight on every visit. That rule was right for what
     the page was then. Since the account chip is painted from the localStorage
     hint before the SDK is even asked for, NOTHING on screen waits for those
     ~700 KB, and preloading them put a high-priority third-party fetch beside
     the page's own stylesheet and data at exactly the moment the first paint
     is being assembled. So the tags are gone, the preconnect stays (it warms
     the connection at no bandwidth cost), and this asserts that state rather
     than the old one — a reinstated preload would be a silent regression of a
     decision, which is precisely the kind of thing a test is for. */
  const sdk = (fbjs.match(/var SDK = '([^']+)'/) || [])[1];
  ok(sdk, 'oa-firebase.js declares its SDK base URL');
  ok(!/rel="preload"[^>]*gstatic\.com\/firebasejs/.test(html),
    'post-a-job does not preload the Firebase SDK — nothing on screen waits for it');
  ok(html.includes('rel="preconnect" href="https://www.gstatic.com"'),
    'but still preconnects to the CDN, so it arrives promptly when it is asked for');
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

  /* A DEADLINE THE PIPELINE IS UNSURE OF IS NOT A DEADLINE (owner,
     2026-08-23). A parsed date is believed only when it is plausible against
     the day the posting went up; an ambiguous day/month whose US reading
     fails that test is re-read the other way round — the one honest repair —
     and a cell neither reading can save publishes NO date, which the page
     shows as "Until filled." */
  eq(deadlineDay('15-Nov-26', '2026-09-01'), '2026-11-15',
    'a deadline after the posting date is believed');
  eq(deadlineDay('15-Nov-24', '2026-09-01'), '',
    'one that had passed before the advertisement went up is a mis-entry, not a deadline');
  eq(deadlineDay('15-Nov-29', '2026-09-01'), '',
    'and one years out is a mis-typed year, not a plan');
  eq(deadlineDay('10/5/2026', '2026-09-01'), '2026-10-05',
    'a plausible US reading is trusted, as Google itself writes dates');
  eq(deadlineDay('5/10/2026', '2026-09-01'), '2026-10-05',
    'while an ambiguous cell whose US reading lands before the posting is read day-first');
  eq(deadlineDay('TBD', '2026-09-01'), '', 'prose is never a date');
  eq(deadlineDay('', '2026-09-01'), '', 'nor is an empty cell');
  eq(deadlineDay('15-Nov-26', ''), '2026-11-15',
    'with no posting date there is no evidence against a parsed deadline');

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

  /* THE EVIDENCE IS THE WHOLE POSTING (owner, 2026-08-23): a posting that
     says "business" ANYWHERE — the advertised title, the notes, the
     advertisement's own address — has to do with the university's business
     school and is flagged under Business School for the review card to
     confirm. */
  eq(typeFromNames('University of Utah', 'Operations',
    'Assistant Professor of Business Analytics'), 'Business School',
    'the bare word "business" anywhere in the posting flags it under Business School');
  eq(typeFromNames('University of Houston', 'OM', 'Assistant Professor',
    'the post sits in the Bauer College of Business'), 'Business School',
    'a note naming the college counts too');
  eq(typeFromNames('University of California Berkeley', 'Operations and IT Management',
    'Lecturer', '', 'https://business.academickeys.com/job/z8gs65qr/Lecturer'),
    'Business School',
    'as does the advertisement\'s own address — a business-faculty job board says ' +
    'what the post is');
  eq(typeFromNames('Clarkson University', 'Operations', 'Lecturer',
    'strong record in agribusiness studies'), 'University',
    'while a word merely CONTAINING business is not the word — the test is bounded');
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
    'posting belongs to the 2026-2027 market; the tab it sits on can only carry it ' +
    'FORWARD into its own cycle, never back (testJobMarketSheetTabCycle)');
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
    ['C School', 'USA', '1-Sep-26', '15-Oct-24'],
    ['D School', 'USA', '1-Sep-26', 'early December'],
    ['E School', 'USA', '1-Sep-26', '5/10/2026'],
  ]), { minYear: 2026 });
  eq(withDeadline.rows.find((r) => r.institution === 'A School').applyByDate, '2026-11-15',
    'a deadline is read as a date');
  eq(withDeadline.rows.find((r) => r.institution === 'A School').applyBy, 'November 15, 2026',
    'and shown the way the site writes dates');
  eq(withDeadline.rows.find((r) => r.institution === 'B School').applyByDate, '',
    'an open-ended search carries NO date — the page buckets "until filled" on ' +
    'the date being empty, so a row with both would read as dated');

  /* A DEADLINE THE PIPELINE IS UNSURE OF PUBLISHES AS "UNTIL FILLED.", with
     the cell's own words carried onto the card (owner, 2026-08-23) — never a
     guess presented as fact. */
  const cRow = withDeadline.rows.find((r) => r.institution === 'C School');
  eq(cRow.applyByDate, '',
    'a deadline that had passed before the advertisement went up is not believed');
  eq(cRow.applyBy, 'Until filled.', 'the posting reads "Until filled." instead');
  ok(cRow.comments.includes('Deadline as listed: 15-Oct-24'),
    'and the sheet\'s own words reach the card, so the maintainer can settle it');
  const dRow = withDeadline.rows.find((r) => r.institution === 'D School');
  eq(dRow.applyByDate, '', 'prose that is not a date sets no date');
  eq(dRow.applyBy, 'Until filled.', 'and reads "Until filled."');
  ok(dRow.comments.includes('Deadline as listed: early December'),
    'with the prose kept rather than silently dropped');
  eq(withDeadline.rows.find((r) => r.institution === 'E School').applyByDate, '2026-10-05',
    'an ambiguous day/month whose US reading lands before the posting is read day-first');
  ok(!withDeadline.rows.find((r) => r.institution === 'A School').comments
      .includes('Deadline as listed'),
    'a believed deadline leaves no note behind — the note is only for the unsure');

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

/* ------------------------------------------- a header that names one column
                                                wrongly

   THE LIVE FAILURE, kept as a fixture. The crowdsourced workbook's "2026 Jobs"
   tab — created by its contributors when the 2026-2027 market opened — heads
   its school column "Location", the same word it uses for the town beside it.
   No alias of `institution` reads "location", so the header was refused; the
   scan moved to the next row and took a POSTING as the header, because
   "University of Hong Kong" begins with an alias of `institution` and a
   comment reading "an expected start date of July 1, 2027" contains an alias
   of `posted`. The date was then read from a comment column that is empty on
   almost every row, so every row was skipped: the tab logged "0 posting(s),
   94 row(s) skipped" every morning for four months and none of the season's
   jobs ever reached the site.

   The shape below is that tab's, cut to five rows.                            */

const JMS_MISLABELLED_HEAD = [
  '#', 'Location', 'Location', 'Country', 'Date Added', 'Job Focus Area', 'Rank',
  'Deadline', 'Link', 'Comment  (virtual or onsite)',
];

const JMS_MISLABELLED_ROWS = [
  ['1', 'University of Hong Kong', 'Hong Kong', 'Hong Kong', '23-Apr-26', 'BA',
    'AP/Assoc/Full', '', 'https://www.higheredjobs.com/faculty/details.cfm?JobCode=179422894',
    'an expected start date of July 1, 2027'],
  ['2', 'University of Nevada Las Vegas', 'Las Vegas, NV', 'USA', '23-Apr-26', 'SCM',
    'AP', '', 'https://www.higheredjobs.com/faculty/details.cfm?JobCode=179416350',
    'an expected start date of July 1, 2027'],
  ['3', 'KU Leuven', 'Leuven', 'Belgium', '5-Jun-26', 'Information Systems Engineering',
    'AP/Assoc/Full', '20-Aug-26', 'https://academicpositions.com/ad/ku-leuven/249301', ''],
  ['4', 'Belmont University', 'Nashville, TN', 'USA', '5-Aug-26', 'SCM',
    'AP/Assoc/Full', '', 'https://belmont.csod.com/ux/ats/careersite/10/home', ''],
  ['5', 'Air Force Institute of Technology', 'Wright-Patterson AFB, Ohio', 'USA',
    '4-Jun-26', 'Logistics and SCM', 'AP/Assoc/Full', '30-Jun-26',
    'https://www.usajobs.gov/job/856638800', ''],
];

function testJobMarketSheetMislabelledHeader() {
  /* 1. A row of postings is never a header, however much of its prose reads
        like one. */
  ok(!looksLikeData(JMS_MISLABELLED_HEAD), 'a row of column names is a header');
  ok(looksLikeData(JMS_MISLABELLED_ROWS[0]),
    'a row carrying a link and a date is a posting, not a header');
  ok(looksLikeData(['Somewhere', '', '', '', '20-Jul-26']),
    'a date alone is enough: no column is NAMED after one');
  ok(looksLikeData(['Somewhere', 'https://example.com/ad']),
    'and so is a link');
  ok(!looksLikeData(['University', 'Country', 'Date Added', 'Deadline']),
    'a plain header carries neither, and is not mistaken for data');

  const map = mapColumns(JMS_MISLABELLED_HEAD);
  eq(map.missing, ['institution'],
    'the header itself names no institution — "Location" is the town everywhere else, ' +
    'and reading it as the school would mis-file every other tab');

  /* 2. The header is repaired rather than discarded: the one field it failed
        to name is settled from the rows underneath it. */
  const fixed = repairColumns(JMS_MISLABELLED_HEAD, JMS_MISLABELLED_ROWS);
  eq(fixed.missing, [], 'and with the rows to hand it can be settled');
  eq(fixed.index.institution, 1, 'the school column is the one holding school names');
  eq(fixed.index.city, 2,
    're-reading the header around it puts the town in the SECOND "Location" — ' +
    'until then an unclaimed duplicate');
  eq(fixed.index.deadline, 7,
    'and everything the header did name is untouched: inferring the whole tab ' +
    'instead would have lost the deadline, the link and the notes');
  eq(fixed.repaired.map((r) => [r.field, r.at, r.header]), [['institution', 1, 'Location']],
    'the repair is reported, so a run says which column it read and why');

  eq(institutionColumn(JMS_MISLABELLED_ROWS.map((r) => [r[2], r[3]])), -1,
    'a column of towns and countries never reads as the institution: the test is ' +
    'whether the values NAME institutions, and those name none');

  /* 3. End to end, which is the number that matters. */
  const out = rowsFromTab(csvOf([[], JMS_MISLABELLED_HEAD, ...JMS_MISLABELLED_ROWS]),
    { tab: '2026 Jobs', kind: 'jobs', minYear: 2026, cycleYear: 2027 });
  eq(out.rows.length, 5, 'every posting on the tab is read, where none was before');
  eq(out.skipped, 0, 'and none is skipped');
  ok(!out.inferred, 'by repairing the header, not by giving up on it');

  const hku = out.rows.find((r) => r.institution === 'University of Hong Kong');
  ok(hku, 'the school is published under its own name');
  eq(hku.comments, 'AP/Assoc/Full · Hong Kong · an expected start date of July 1, 2027',
    'the town is the town and the comment is the comment');
  eq(hku.country, 'Hong Kong', 'and the country column is still the country');

  const leuven = out.rows.find((r) => r.institution === 'KU Leuven');
  eq(leuven.applyByDate, '2026-08-20', 'a deadline the sheet states survives the repair');
  eq(leuven.applyBy, 'August 20, 2026', 'and is shown as a date');
}

function testJobMarketSheetTabCycle() {
  const rows = csvOf([JMS_MISLABELLED_HEAD, ...JMS_MISLABELLED_ROWS]);

  /* By date alone, a posting advertised in April 2026 belongs to the market
     that is closing — the one page it is of no use on. */
  const byDate = rowsFromTab(rows, { tab: '2026 Jobs', kind: 'jobs', minYear: 2026 });
  eq(byDate.rows.filter((r) => r.year === 2026).length, 4,
    'four of these five are dated before their own cycle opened, so by date alone ' +
    'they file under the market that has just closed');

  const byTab = rowsFromTab(rows, { tab: '2026 Jobs', kind: 'jobs', minYear: 2026,
    cycleYear: 2027 });
  eq(byTab.rows.every((r) => r.year === 2027), true,
    'the tab settles it: a tab created for the 2026-2027 market carries its ' +
    'postings into that market, whenever they were advertised');

  /* A FLOOR, never a ceiling — so nothing already published can move, and a
     row added late to an old tab keeps the later year its date gives it. */
  const late = rowsFromTab(csvOf([
    ['University', 'Country', 'Date'],
    ['Clarkson University', 'USA', '20-Jul-26'],
  ]), { tab: '2025 Jobs', kind: 'jobs', minYear: 2026, cycleYear: 2026 });
  eq(late.rows[0].year, 2027,
    'a July 2026 posting is a 2026-2027 posting even on the 2025 tab');
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

  /* THE FAILURE THAT HID FOR FOUR MONTHS. One tab reads as empty while the
     rest of the workbook is healthy, so every other signal here says the sheet
     is fine: it is being read, it is being updated, its newest posting is from
     this week — and a whole season of jobs is missing from the site. Checked
     BEFORE the age test, because from the outside it looks exactly like a
     quiet market and it is the one thing here a person has to go and fix. */
  const deadTab = stalenessOf({ ok: true, rows: 40, newestPosted: '2026-08-15',
    deadTabs: ['2026 Jobs'], now });
  ok(deadTab.stale && deadTab.reason === 'unread-tab',
    'a tab that was read and gave nothing is reported even when nothing else is wrong');
  ok(/2026 Jobs/.test(deadTab.detail), 'and the message names the tab');
  eq(deadTab.tabs, ['2026 Jobs'], 'so the e-mail can name it too');

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

/* ------------------------------ the tracking sheet's editing handles (mirrors)

   THE BUG THIS PINS. Edit and Take down are drawn only where the page can name
   a document for a row (oa-jobedit.js docIdFor), and the postings the workbook
   publishes deliberately had none — so a signed-in maintainer saw the controls
   on the 94 postings that came through the form or the legacy import and on
   none of the 16 the workbook had added. A mirror is the document that was
   missing; these checks hold the three properties the fix rests on. */
/* ---------------------------------- taking down a posting that has no reference

   THE BUG THIS PINS, and it applied to every posting the site serves. `ref` is
   the number the FORM issues; the 94 postings the legacy import migrated and
   the 16 the tracking sheet publishes have none — 110 of 110 rows in
   data/jobs.json carry `ref: ''`. Both the merge and the change report keyed a
   takedown on `ref` alone, so the maintainer pressing Take down marked the
   document hidden, was told "Taken down", and the posting stayed on the site
   for ever, with nothing anywhere saying why. */
/* ------------------ the mirror lifecycle, against a stand-in collection

   syncSheetMirrors is the only part of the fix that WRITES, so it is driven
   here end to end rather than pattern-matched: a collection object with the
   three methods it uses, and every operation recorded in the order it was
   issued. What is being checked is what cannot be seen from the page — that a
   quiet run writes nothing at all, that a document the maintainer has taken
   over is never rewritten (the workbook reverting an edit is the exact failure
   that retired the old form-sheet sync), and that an id already in use is
   probed rather than overwritten, because for this collection an overwrite
   means somebody else's advertisement. */
function fakeCollection(seed = {}) {
  const docs = new Map(Object.entries(seed));
  const ops = [];
  return {
    docs, ops,
    doc(id) {
      return {
        async get() {
          ops.push(['get', id]);
          return { exists: docs.has(id), id, data: () => docs.get(id) };
        },
        async set(v) { ops.push(['set', id]); docs.set(id, v); },
        async delete() { ops.push(['delete', id]); docs.delete(id); },
      };
    },
  };
}

/* ------------------------- the frozen archives' overrides (assets/oa-rowedit.js)

   data/past-postings.json, data/recent-faculty.json and data/universities.json
   are written once by the legacy import and committed — their workflow has no
   schedule — so those three pages had no write path at all and were read-only
   for everybody, the maintainer included. `rowOverrides` corrects a row at
   read time, the `newsOverrides` pattern generalised.

   The browser half is checked in page-test.mjs. What is pinned HERE is the
   agreement between the three files that have to say the same thing: a field
   the editor can write must be a field the rules accept (or the save is a
   permission-denied the maintainer cannot debug), a dataset it offers must be
   one the rules name AND a file that exists, and every page must actually load
   it — a page that does not is silently read-only again, which is the exact
   bug being fixed. */
/* --------------------------- a deploy can only reach THIS project's database

   THE INCIDENT. The Firebase CLI resolves its target from, in order:
   --project, FIREBASE_PROJECT, the "active project" it remembers PER
   DIRECTORY in its own global config, and only then the default alias in
   .firebaserc. The remembered one wins over .firebaserc, is invisible in the
   repository, and survives between sessions — so `firebase deploy --only
   firestore:rules` run HERE published THIS repository's rules into the
   `stouras-answerarena` database and printed "Deploy complete!". These rules
   end in a deny-all catch-all and name none of that app's collections, so
   every read and write in it was refused until its own rules were
   re-published. Nothing warned, at either end.

   check-project.mjs is the guard: the CLI exports GCLOUD_PROJECT to a
   predeploy hook, so the target is knowable before anything is uploaded, and
   a mismatch exits non-zero, which aborts the deploy. (The sibling
   konstantinosStouras.github.io carries the same guard in each of its six
   Firebase folders, checked by its own tools/deploy-guard-selftest.mjs.) */
async function testDeployGuard() {
  const root = path.join(HERE, '..');
  const guard = await readFile(path.join(root, 'check-project.mjs'), 'utf8');

  ok(guard.includes('GCLOUD_PROJECT'),
    'the guard reads the project the CLI is actually deploying to');
  ok(guard.includes('process.exit(1)'),
    'and exits non-zero on a mismatch, which is what aborts the deploy');
  /* Compared against .firebaserc rather than a literal: a hardcoded id is a
     second place for the truth to live, and it would go stale in silence. */
  ok(guard.includes('.firebaserc'),
    'taking the expected project from .firebaserc, not from a literal');
  const rc = JSON.parse(await readFile(path.join(root, '.firebaserc'), 'utf8'));
  const project = rc.projects.default;
  eq(project, 'operations-academia', 'which is this site\'s own project');
  ok(!guard.includes(`'${project}'`), 'and the guard does not hardcode it');

  /* EVERY DEPLOYABLE SECTION, not just the rules. `firebase deploy` with no
     --only runs all of them, so a guard on `firestore` alone still lets this
     repository's Storage rules and its Function land in another project. */
  const cfg = JSON.parse(await readFile(path.join(root, 'firebase.json'), 'utf8'));
  for (const section of ['firestore', 'functions', 'hosting', 'storage', 'database']) {
    if (!cfg[section] || typeof cfg[section] !== 'object') continue;
    const pre = [].concat(cfg[section].predeploy || []);
    ok(pre.some((c) => String(c).includes('check-project.mjs')),
      `the ${section} deploy runs the guard first`);
  }
  ok(cfg.firestore && cfg.storage && cfg.functions,
    'and all three of this repository\'s deployable sections are still configured');
}

async function testRowOverrides() {
  const js = await readFile(path.join(HERE, '..', 'assets', 'oa-rowedit.js'), 'utf8');
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');

  const block = rules.slice(rules.indexOf('match /rowOverrides/'));
  ok(block, 'the rules carry a rowOverrides block');
  ok(/allow read: if true;/.test(block.slice(0, 400)),
    'an override reaches EVERY visitor — a correction is not a maintainer-only view');
  ok(/allow write: if isAdmin\(\)/.test(block.slice(0, 900)),
    'and only the maintainer writes one');
  /* WITHOUT A DELETE, HIDING IS A ONE-WAY DOOR: `request.resource` is null on
     a delete, so an `allow write` condition that reads request.resource.data
     errors and evaluates false. */
  ok(/allow delete: if isAdmin\(\);/.test(block.slice(0, 3000)),
    'and can delete one, so hiding a row is not a one-way door');

  const allowed = new Set(
    (block.slice(block.indexOf('hasOnly(['), block.indexOf('])', block.indexOf('hasOnly([')))
      .match(/'[^']+'/g) || []).map((q) => q.slice(1, -1)));
  ok(allowed.size > 10, 'the rules enumerate the fields an override may carry');
  /* AND NOTHING BEYOND WHAT THE EDITOR WRITES. `levels`/`characteristics` were
     allowed and never read: dead keys, bounded only by item COUNT, so each
     element could be an arbitrary string — a megabyte of nothing in a document
     every visitor to the page downloads. */
  for (const dead of ['levels', 'characteristics']) {
    ok(!allowed.has(dead), `an override may not carry ${dead} — nothing reads it`);
  }
  for (const k of ['dataset', 'rowId', 'hidden', 't']) {
    ok(allowed.has(k), `an override may carry ${k}`);
  }

  /* Every field the editor offers, per dataset, taken from the module itself
     rather than restated here — a field added there without a rule would be
     refused at save time with nothing on screen explaining why. */
  const specs = js.slice(js.indexOf('var DATASETS'), js.indexOf('var COLLECTION'));
  for (const key of (specs.match(/key: '([^']+)'/g) || []).map((m) => m.slice(6, -1))) {
    ok(allowed.has(key), `oa-rowedit.js may write "${key}", and the rules allow it`);
  }

  /* AND EVERY FIELD save() PUTS ON THE DOCUMENT ITSELF. `dataset`, `rowId`,
     `hidden` and `t` are written there rather than declared in DATASETS, so
     deriving the list from DATASETS alone left that half unchecked: adding one
     bookkeeping field — `updatedBy`, say — would make the rules' hasOnly()
     refuse EVERY Edit, Take down and Restore on all three pages, with CI green
     and the module telling the maintainer to redeploy rules that are already
     deployed. Derived, not restated, so it cannot drift. */
  const saveBody = js.slice(js.indexOf('function save('), js.indexOf('/* ------', js.indexOf('function save(')));
  const written = new Set((saveBody.match(/\bdoc\.([A-Za-z_$][\w$]*)\s*=/g) || [])
    .map((m) => m.replace(/^doc\./, '').replace(/\s*=$/, '')));
  ok(written.size >= 3, 'the checks below read the fields save() writes from the source');
  for (const key of written) {
    ok(allowed.has(key), `oa-rowedit.js's save() writes "${key}", and the rules allow it`);
  }
  for (const k of ['dataset', 'rowId', 't']) {
    ok(written.has(k), `save() still writes ${k} — the rules pin the document id to it`);
  }

  /* THE EDITOR RECORDS ONLY WHAT CHANGED. Writing every field would PIN every
     field: a correction made today would mask tomorrow's upstream fix for ever,
     with nothing on the page saying why. */
  ok(js.includes("if (got !== asText(base[f.key])) patch[f.key] = got;"),
    'an override carries only the fields that differ from the file');
  ok(js.includes('{ replace: true }') && js.includes('ref.set(doc, { merge: true })'),
    'and a correction REPLACES the override, so a field corrected back stops being one');
  ok(js.includes('var base = row._oaBase || row;'),
    'a row with no override yet is its own base, so a first correction pins nothing else');

  /* THE EDITOR ONLY ACTS ON ROWS THE DATASET OWNS. previous-markets.html
     renders the archive AND the postings folded in from data/jobs.json; an
     override against one of those is read by nothing, so Take down would empty
     the card and leave the posting on the site. */
  ok(js.includes('function isOwn(dataset, row)'),
    'the editor knows which rows belong to its dataset');
  /* AT EVERY ENTRY POINT, not just declared. Removing the CALL is a one-token
     change that reinstates the whole failure; the declaration surviving proves
     nothing. (page-test.mjs drives the behaviour itself.) */
  eq((js.match(/!isOwn\(dataset, row\)/g) || []).length, 2,
    'and asks before drawing on a card and before drawing on a map pin');
  ok(js.includes('isOwn(dataset, r) ? s.rows[r && r.id] : null'),
    'and before overlaying a value onto a row that is not its own');
  const pm = await readFile(path.join(HERE, '..', 'previous-markets.html'), 'utf8');
  ok(/RowEdit\.own\('past-postings',/.test(pm),
    'and previous-markets.html names the archive\'s own rows, because it mixes two populations');

  const datasets = ['past-postings', 'recent-faculty', 'universities'];
  for (const d of datasets) {
    ok(specs.includes(`'${d}'`) || specs.includes(`${d}:`),
      `oa-rowedit.js offers the ${d} archive`);
    ok(block.includes(`'${d}'`), `and the rules name ${d} as a dataset`);
    ok(existsSync(path.join(HERE, '..', 'data', d + '.json')),
      `and data/${d}.json is the file it corrects`);
  }

  /* THE PAGES. A page that does not load the module is silently read-only —
     which is the bug, not a smaller version of it. */
  for (const [page, dataset] of [
    ['previous-markets.html', 'past-postings'],
    ['recent-faculty.html', 'recent-faculty'],
    ['universities.html', 'universities'],
  ]) {
    const html = await readFile(path.join(HERE, '..', page), 'utf8');
    ok(html.includes('assets/oa-rowedit.js'), `${page} loads the archive editor`);
    ok(html.includes(`RowEdit.attach('${dataset}'`), `${page} loads its overrides`);
    ok(html.includes(`RowEdit.apply('${dataset}'`), `${page} applies them to what it renders`);
    ok(html.includes(`RowEdit.onCard('${dataset}')`) ||
       html.includes(`RowEdit.onPopup('${dataset}')`),
      `${page} draws the maintainer's controls`);
    /* AND IT IS A SOFT DEPENDENCY. This is a PUBLIC page and the module is
       admin-only: if it fails to load, the page must render exactly what it
       renders for a visitor with no overrides — not an empty container. */
    ok(html.includes('window.OARowEdit || {'),
      `${page} still renders its data if the admin module never loads`);
  }

  /* previous-markets.html carries TWO kinds of row — the archive's own, and the
     postings folded in from data/jobs.json, which are real submissions. Those
     get the FULL form, and this is the ONLY page that reaches them: the jobs
     page and the one-pager both filter to the market under way. */
  const past = await readFile(path.join(HERE, '..', 'previous-markets.html'), 'utf8');
  ok(past.includes('assets/oa-jobedit.js') && past.includes('OAJobEdit.attach'),
    'previous-markets.html gives a real posting the full editor — the only page that can');

  /* The map is not an OAList page, so its half rides on hooks of its own. */
  const map = await readFile(path.join(HERE, '..', 'assets', 'oa-uni-map.js'), 'utf8');
  ok(map.includes('cfg.prepare'), 'the map lets a page correct the dataset before it is drawn');
  ok(map.includes('cfg.onPopup'), 'and add controls to a pin');
  ok(map.includes('refresh:'), 'and redraw when a correction arrives late');

  /* THE SAME ONE-WAY DOOR, on the feature this pattern came from. */
  const news = rules.slice(rules.indexOf('match /newsOverrides/'));
  ok(/allow delete: if isAdmin\(\);/.test(news.slice(0, 2400)),
    'newsOverrides can be deleted too — a decision is not permanent');
}

/* ------------------------------ the What's-new list (assets/oa-news.js)

   THREE THINGS THE OWNER ASKED FOR (2026-08-18), and they are only correct
   together:

     • a removed entry LEAVES the list — it used to stay on the page struck
       through, which is the clutter Remove was pressed to be rid of;
     • …and removing is still not a one-way door, so the removed ones sit in a
       collapsed panel below the list, drawn for the maintainer alone;
     • a NEW entry is not public on sight: changelog.json is committed by
       whoever ships a change, and the entry reached visitors AND the e-mail
       digests the moment it landed.

   The rules of that gate are pure and live in assets/oa-news.js, which the two
   pages, the alerts preview and the mailer all read through — the two pages
   used to carry a renderer each and had already drifted, and the mailer read
   the raw log, so an entry taken off the site was still e-mailed. What is
   pinned here is the gate itself, the agreement between the module and the
   rules about which keys a decision may carry, and that every consumer really
   goes through it. */
async function testNewsReview() {
  const News = require(path.join(HERE, '..', 'assets', 'oa-news.js'));
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  const block = rules.slice(rules.indexOf('match /newsOverrides/'));

  ok(/allow read: if true;/.test(block.slice(0, 400)),
    'a decision reaches EVERY visitor — the list is public, not a maintainer view');
  ok(/allow write: if isAdmin\(\)/.test(block.slice(0, 900)),
    'and only the maintainer makes one');

  /* EVERY KEY THE MODULE WRITES, taken from the module itself rather than
     restated here. A key with no rule is a permission-denied at save time and
     a maintainer told to redeploy rules that are already deployed. */
  const allowed = new Set(
    (block.slice(block.indexOf('hasOnly(['), block.indexOf('])', block.indexOf('hasOnly([')))
      .match(/'[^']+'/g) || []).map((q) => q.slice(1, -1)));
  for (const key of News.DOC_KEYS) {
    ok(allowed.has(key), `oa-news.js may write "${key}", and the rules allow it`);
  }
  eq([...allowed].sort(), [...News.DOC_KEYS].sort(),
    'and the rules allow nothing the module does not write');
  /* The three statuses are a closed set on both sides: a status the rules do
     not name is refused, and one the module does not know reads as "nothing
     was decided", which would put a removed entry back on the site. */
  for (const s of [News.APPROVED, News.PENDING, News.REMOVED]) {
    ok(block.slice(0, 1600).includes(`'${s}'`), `the rules name the "${s}" status`);
  }

  /* -------------------------------------------------------------- the gate */
  const e = (id, date) => ({ id, date, title: id, summary: 's', url: '' });
  const before = e('before', '2026-08-01');       // predates the gate
  const after = e('after', '2026-09-01');         // does not

  ok(News.statusOf(after, undefined) === News.PENDING,
    'ABSENCE MEANS WITHHOLD: an entry nobody has reviewed is not public');
  ok(News.statusOf(before, undefined) === News.APPROVED,
    'but the gate arriving is not a reason to retract what was already on the site');
  ok(News.REVIEW_FROM > '2026-08-17' && News.REVIEW_FROM < '2026-09-01',
    'and that cut is the day the gate shipped, not an arbitrary date');
  ok(News.statusOf(after, { status: News.APPROVED }) === News.APPROVED,
    'publishing one puts it on the site');
  ok(News.statusOf(before, { status: News.REMOVED }) === News.REMOVED,
    'and removing one takes it off, however old it is');

  /* THE DOCUMENTS WRITTEN BEFORE THE GATE said `hidden`, and they are read
     rather than migrated — nothing has to be run against the database, and a
     removal made from a page served out of an old cache still means removal. */
  ok(News.statusOf(before, { hidden: true }) === News.REMOVED,
    'a pre-gate {hidden:true} document still reads as removed');
  ok(News.statusOf(after, { hidden: false }) === News.APPROVED,
    'and a pre-gate restore still reads as published');
  ok(News.patchFor(News.REMOVED).hidden === true &&
     News.patchFor(News.APPROVED).hidden === false,
    'and a new decision keeps `hidden` in step, so an old page cannot disagree');

  /* WHAT IS PUBLIC IS WHAT IS PUBLISHED — the one list the mailer sends from
     and the alert preview shows, so neither can announce something nobody has
     reviewed or resurrect something taken down. */
  const log = [after, e('draft', '2026-09-02'), before, e('gone', '2026-08-02')];
  const docs = { after: { status: News.APPROVED }, gone: { status: News.REMOVED } };
  eq(News.publicUpdates(log, docs).map((u) => u.id), ['after', 'before'],
    'publicUpdates carries the published entries, newest first, and nothing else');
  const split = News.partition(log, docs);
  eq([split.approved.length, split.pending.length, split.removed.length], [2, 1, 1],
    'and partition accounts for every entry exactly once');

  /* AN EDIT IS A REWORDING LAID OVER THE ENTRY, never a rewrite of
     changelog.json — which the mailer also reads, and which is the record of
     what was actually shipped. */
  const worded = News.applied(before, { title: 'Reworded' });
  ok(worded.title === 'Reworded' && worded.summary === 's',
    'an edited title is shown and the rest of the entry is left alone');
  ok(News.applied(before, { title: '' }).title === 'before',
    'and an empty override is not an edit — it falls back to the entry itself');

  /* THE FILE ITSELF. Nothing validated changelog.json before, and the gate
     gives that teeth: an entry with no usable `id` cannot be reviewed (the
     document is keyed on it), and two entries sharing one would be decided
     together — one Remove taking down a second entry nobody touched. A
     malformed entry now fails CI, where it is a one-line fix, instead of
     stalling the announcements silently. */
  const shipped = JSON.parse(await readFile(path.join(HERE, '..', 'changelog.json'), 'utf8'));
  const entries = shipped.updates || [];
  ok(entries.length > 0, 'changelog.json carries entries');
  const ids = new Set();
  for (const u of entries) {
    ok(typeof u.id === 'string' && u.id.trim().length > 0,
      `every change-log entry has an id — "${u.title || '(untitled)'}" does not`);
    ok(!ids.has(u.id), `and it is unique — "${u.id}" is used twice`);
    ids.add(u.id);
    ok(/^\d{4}-\d{2}-\d{2}$/.test(String(u.date || '')),
      `every entry has a yyyy-mm-dd date — "${u.id}" has "${u.date}"`);
    ok(typeof u.title === 'string' && u.title.trim().length > 0,
      `and a title — "${u.id}" has none`);
  }
  /* AND THE GATE READS IT THE SAME WAY THE PAGES DO. If publicUpdates dropped
     an entry the pages render, the mailer would announce a different list. */
  eq(News.publicUpdates(entries, {}).length,
    entries.filter((u) => String(u.date) < News.REVIEW_FROM).length,
    'every pre-gate entry is public, and every entry since it is not');

  /* ------------------------------------------------------- every consumer */
  const js = await readFile(path.join(HERE, '..', 'assets', 'oa-news.js'), 'utf8');
  ok(js.includes('module.exports = factory()'),
    'oa-news.js is dual-mode, so the page and the mailer cannot drift apart');

  for (const [page, how] of [
    ['index.html', "OANews.mount({ list: '#v3-news'"],
    ['whats-new.html', "OANews.mount({ list: '#oa-whatsnew'"],
  ]) {
    const html = await readFile(path.join(HERE, '..', page), 'utf8');
    ok(html.includes('assets/oa-news.js'), `${page} loads the What's-new module`);
    ok(html.includes(how), `${page} renders its list through it`);
    ok(!/collection\('newsOverrides'\)/.test(html),
      `${page} reaches the decisions through the module, not around it — ` +
      'a page with its own reader is a page that drifts');
  }

  /* THE ALERTS PREVIEW promises "this is the e-mail you will get", so it has
     to read the log the way the mailer does. It showed the newest two entries
     straight from changelog.json. */
  const alertsJs = await readFile(path.join(HERE, '..', 'assets', 'oa-alerts.js'), 'utf8');
  ok(alertsJs.includes('OANews.publicUpdates') || alertsJs.includes('News.publicUpdates'),
    'the alert preview previews only what has actually been published');
  const alertsHtml = await readFile(path.join(HERE, '..', 'alerts.html'), 'utf8');
  ok(alertsHtml.includes('assets/oa-news.js'), 'and alerts.html loads the module it needs');

  /* AND THE MAILER, which is the half that cannot be taken back. */
  const mailer = await readFile(path.join(HERE, '..', '_scraper', 'alerts-mailer.mjs'), 'utf8');
  ok(mailer.includes("'oa-news.js'"), 'the mailer reads the same decisions');
  ok(mailer.includes('News.publicUpdates('),
    'and sends only published entries — an e-mail cannot be recalled');
  ok(/catch \(err\) \{[\s\S]{0,400}decisions = \{\}/.test(mailer),
    'a decision read that fails withholds rather than killing the job digests too');
  /* AND THE WINDOW FLOOR IS FROZEN, in BOTH branches an alert can take. A hold
     can outlast the 31-day cap a never-yet-sent subscriber's window starts at,
     and a floor that slides with the clock drops the held entry on the very day
     it is published — the run that should have delivered it. */
  ok(/const floor = \(!a\.lastUpdateDate/.test(mailer),
    'the update window floor is computed once per alert');
  ok(/idle\.lastUpdateDate = floor/.test(mailer),
    'and persisted when the run sends nothing…');
  ok(/if \(floor\) patch\.lastUpdateDate = floor;/.test(mailer),
    '…and when it sends, where a real send date then overrides it');

  /* AND THE ARCHIVE IS NOT A SIDE DOOR. /v2/ is served, and both its
     What's-new page and its alerts preview read /changelog.json straight —
     the SHARED file, so they would have shown an entry nobody had reviewed
     yet, in full, on a page anyone can open. An archive keeps its own frozen
     assets by design, so rather than carry a copy of the gate there, neither
     reads the live log any more. */
  for (const page of ['v2/whats-new.html', 'v2/assets/oa-alerts.js']) {
    const src = await readFile(path.join(HERE, '..', page), 'utf8');
    ok(!/fetch\('\/changelog\.json'/.test(src),
      `${page} does not serve the live update log — it cannot judge what is public`);
  }

  /* THE STATES HAVE TO LOOK LIKE SOMETHING. Each was set with no rule behind
     it once already (.v3-news-hidden), which is invisible until someone looks. */
  const css = await readFile(path.join(HERE, '..', 'assets', 'v3.css'), 'utf8');
  for (const cls of ['v3-news-pending', 'v3-news-removed', 'v3-news-note', 'v3-news-bin']) {
    ok(css.includes('.' + cls), `.${cls} is drawn, not just set`);
  }
  /* AND THEY HAVE TO WIN. `.v3-news li` and `.v3-news li::before` are (0,1,2),
     so a bare `.v3-news-pending::before` never paints — the same specificity
     trap the Leaflet attribution fix fell into. */
  ok(css.includes('.v3-news li.v3-news-pending::before'),
    'the pending mark outranks the rule it is overriding');
  ok(!css.includes('.v3-news-hidden'),
    'and the old hidden-in-place styling is gone with the behaviour it drew');
}

/* ----------------------------------- posters keep the name database clean

   Two halves, one discipline. The picker's "did you mean" rows stop a slight
   respelling of an existing place from being added as a second entry — the
   judgement is oa-schools.js's similarNames, the SAME function the duplicate
   sweep above holds the built vocabulary with, so the guard at the door and
   the audit behind it cannot disagree. And a name the site already publishes
   WRONGLY can be corrected by a signed-in poster: a `nameFixes` suggestion,
   pinned pending by the rules, approved on admin-area.html, written by the
   build into data/name-fixes.json and applied — after canon, never instead of
   it — to every posting and to the vocabulary. */
async function testNameFixes() {
  const S = require(path.join(HERE, '..', 'assets', 'oa-schools.js'));
  const NF = require(path.join(HERE, '..', 'assets', 'oa-namefix.js'));

  /* ------------------------------------------------- the same-name judgement */

  ok(S.similarNames('Olin Business School', 'Olin School of Business'),
    'similarNames: the same distinctive words in another order are one school');
  ok(S.similarNames('Michael Smurfit Graduate Business School',
    'UCD Michael Smurfit Graduate School of Business',
    { university: 'University College Dublin' }),
    'and the university\'s own name and initials are not distinctive within its lists');
  ok(!S.similarNames('Marketing', 'Operations Management'),
    'two genuinely different departments are not one');
  ok(!S.similarNames('Managment Science', 'Management Science'),
    'STRICT (the build-failing tier) does not chase typos');
  ok(S.similarNames('Managment Science', 'Management Science', { fuzzy: true }),
    'the FUZZY tier (a suggestion the poster can wave away) does');
  ok(S.similarNames('Operation Management', 'Operations Management', { fuzzy: true }),
    'and singular/plural');
  ok(S.similarNames('Booth School of Business',
    'The University of Chicago Booth School of Business', { fuzzy: true }),
    'and one name contained in the other');
  ok(!S.similarNames('Information Systems', 'Information Management', { fuzzy: true }),
    'but a different long word is a different department, even fuzzily');
  eq(S.findSimilar('Managment Science',
    ['Marketing', 'Management Science', 'Management Sciences Dept', 'Operations']),
    ['Management Science', 'Management Sciences Dept'],
    'findSimilar returns the near-misses, in list order');
  eq(S.findSimilar('Management Science', ['Management Science']), [],
    'and never the name itself — identical is not a suggestion');
  eq(S.findSimilar('x', ['xa', 'xb', 'xc', 'xd']).length <= 3, true,
    'capped, so a short needle cannot flood the picker');

  /* the picker wires the judgement in: the did-you-mean rows above the
     "new name" row, fed by the place picker from the same vocabulary */
  const combo = await readFile(path.join(HERE, '..', 'assets', 'oa-combo.js'), 'utf8');
  ok(/opts\.similar\(typed\)/.test(combo) && combo.includes('oa-combo-near'),
    'oa-combo.js draws the did-you-mean rows when the caller finds a near-miss');
  const pick = await readFile(path.join(HERE, '..', 'assets', 'oa-place-picker.js'), 'utf8');
  ok(/S\.findSimilar\(typed/.test(pick),
    'oa-place-picker.js answers it through oa-schools.js — one judgement, both halves');

  /* ------------------------------------ the type follows the chosen names */

  for (const [inst, more] of [
    ['Rutgers Business School–Newark', 'MS and IS'],
    ['Clarkson University', 'Operations'],
    ['Rollins College', 'SCM'],
    ['INSEAD', 'Technology and Operations Management'],
    ['Some Employer', 'Department of Business Administration'],
    ['University of Nevada, Las Vegas', 'Lee Business School'],
    ['KU Leuven', ''],
    ['ESMT Berlin', ''],
  ]) {
    eq(S.typeGuess(inst, more, ''), typeFromNames(inst, more),
      `typeGuess("${inst}") answers exactly as the pipeline's typeFromNames does`);
  }
  ok(/type: \$\('f-type'\)/.test(await readFile(
    path.join(HERE, '..', 'assets', 'oa-jobform.js'), 'utf8')),
    'the posting form hands the Type select to the cascade');
  ok(/data-oa-auto-type/.test(pick) && /if \(typeEl\.value && typeEl\.value !== auto\) return;/.test(pick),
    'which only ever fills an empty field or corrects its own earlier guess — ' +
    'a value the poster picked is never overruled');

  /* --------------------------------------------- the corrections themselves */

  const fixes = S.normalizeFixes([
    { kind: 'institution', from: 'Wibble Institute of Technology',
      to: 'Wobble Institute of Technology' },
    { kind: 'unit', from: 'Operations Managment', to: 'Operations Management Department',
      institution: 'Wobble Institute of Technology' },
    { kind: 'school', from: 'Nowhere School', to: 'Nowhere School' },   // renames nothing
    { kind: 'bogus', from: 'a', to: 'b' },                              // no such kind
    { kind: 'unit', from: '', to: 'Something' },                        // nothing to rename
  ]);
  eq(fixes.length, 2, 'normalizeFixes drops junk: unknown kinds, empty names, self-renames');
  eq(fixes.find((f) => f.kind === 'unit').to, 'Operations Management',
    'and canonicalises every TARGET — a fixed row stays canonical under the built-in ' +
    'rules, which is what keeps the "one way" guard green without it knowing the fix');

  eq(S.normalizeFixes([
    { kind: 'school', from: 'Old School', to: 'Mid School Name' },
    { kind: 'school', from: 'Mid School Name', to: 'Final School Name' },
  ]).map((f) => f.to), ['Final School Name', 'Final School Name'],
    'a chain resolves (A->B, B->C is A->C)');
  eq(S.normalizeFixes([
    { kind: 'school', from: 'Aaa School', to: 'Bbb School' },
    { kind: 'school', from: 'Bbb School', to: 'Aaa School' },
  ]), [], 'and a cycle cannot be honoured, so it is dropped whole');

  const fixed = S.fixPlace(
    { institution: 'Wibble Institute of Technology', school: '', unit: 'Operations Managment' },
    fixes);
  eq(fixed, { institution: 'Wobble Institute of Technology', school: '',
    unit: 'Operations Management' },
    'fixPlace renames the institution FIRST, so a fix scoped to the corrected ' +
    'university still reaches a row that carried the old spelling');
  eq(S.fixPlace(fixed, fixes), fixed, 'and is idempotent');
  eq(S.fixPlace(
    { institution: 'Elsewhere University', school: '', unit: 'Operations Managment' }, fixes),
    { institution: 'Elsewhere University', school: '', unit: 'Operations Managment' },
    'a SCOPED fix never fires at another university');
  const restated = S.canonColumns(fixed);
  eq({ institution: restated.institution, school: restated.school, unit: restated.unit },
    fixed, 'and a fixed place is a fixed point of canon — the overlay extends the ' +
    'spelling authority, it never argues with it');

  /* every ingest applies the overlay: a carried row, a fresh submission, the
     vocabulary — same fixes, same function, same order (canon first) */
  const stale = {
    id: '', year: 2026, posted: '2026-04-07',
    institution: 'Wibble Institute of Technology',
    unit: 'Operations Managment', department: 'Operations Managment',
    country: 'Ireland', furtherInfoUrl: universitiesLink('Wibble Institute of Technology'),
  };
  stale.id = jobId(stale);
  const healed = healPlace(stale, fixes);
  eq(healed.institution, 'Wobble Institute of Technology', 'healPlace renames a carried row');
  eq(healed.department, 'Operations Management', 'and rebuilds the line the card shows');
  eq(healed.id, jobId(healed), 'its derived id follows the name, as it did for Penn State');
  eq(healed.furtherInfoUrl, universitiesLink('Wobble Institute of Technology'),
    'and the site\'s own "Further info" link follows too');
  eq(healPlace(stale), stale,
    'with no fixes in force the row comes back UNTOUCHED — by identity, so a ' +
    'fix-free run is byte-identical');

  const sub = rowFromSubmission({ ...GOOD, department: undefined,
    institution: 'Wibble Institute of Technology', school: '',
    unit: 'Operations Managment' }, { now: new Date('2026-08-20'), fixes });
  eq(sub.institution, 'Wobble Institute of Technology',
    'a fresh submission typed under the old spelling publishes under the corrected one');
  eq(sub.department, 'Operations Management', 'department line included');

  const v = buildVocab([
    { institution: 'Wibble Institute of Technology', school: '', unit: 'Operations Managment' },
  ], {
    directory: [{ institution: 'Wibble Institute of Technology',
      school: 'Wibble School of Business', department: 'Operations Managment' }],
    fixes,
  });
  ok(v.universities.some((o) => o.v === 'Wobble Institute of Technology')
     && !v.universities.some((o) => o.v === 'Wibble Institute of Technology'),
    'the vocabulary offers the corrected spelling and stops offering the old one');
  ok(v.units.some((o) => o.v === 'Operations Management')
     && !v.units.some((o) => /Managment/.test(o.v)),
    'for directory rows too — the pickers cannot re-teach the mistake');

  /* ---------------------------------------- the queue, pinned to the rules */

  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  const block = rules.slice(rules.indexOf('match /nameFixes/'));
  ok(block.length > 100, 'the rules know the nameFixes collection');
  ok(/request\.resource\.data\.status == 'pending'/.test(block),
    'NOTHING RENAMES ITSELF: a suggestion is created pending, and only that');
  ok(/request\.resource\.data\.uid == request\.auth\.uid/.test(block),
    'and is pinned to the account that made it');

  /* every key the form writes has a rule, and the rules allow nothing more —
     both ways, the oa-news.js discipline */
  const createList = block.slice(block.indexOf('hasOnly('),
    block.indexOf('])', block.indexOf('hasOnly(')));
  const allowedCreate = [...new Set((createList.match(/'[^']+'/g) || [])
    .map((q) => q.slice(1, -1)))].sort();
  eq(allowedCreate, [...NF.DOC_KEYS].sort(),
    'the create rule and oa-namefix.js DOC_KEYS agree, both ways');

  const nf = await readFile(path.join(HERE, '..', 'assets', 'oa-namefix.js'), 'utf8');
  const addBlock = nf.slice(nf.indexOf('.add({'), nf.indexOf('})', nf.indexOf('.add({')));
  const written = [...new Set((addBlock.match(/^\s*(\w+):/gm) || [])
    .map((m) => m.trim().replace(':', '')))].sort();
  eq(written, [...NF.DOC_KEYS].sort(),
    'and DOC_KEYS is what the form actually writes, read from the source');

  /* the admin's update is tighter than isAdmin(): the decision, a reworded
     target, a note and the timestamp — never the suggester's identity or what
     they said was wrong */
  const at2 = block.indexOf('.affectedKeys().hasOnly(');
  const updList = block.slice(at2, block.indexOf('])', at2));
  const allowedUpdate = [...new Set((updList.match(/'[^']+'/g) || [])
    .map((q) => q.slice(1, -1)))].sort();
  eq(allowedUpdate, [...NF.ADMIN_EDIT_KEYS].sort(),
    'the update rule and ADMIN_EDIT_KEYS agree, both ways');

  const adminSrc = await readFile(path.join(HERE, '..', 'assets', 'oa-adminarea.js'), 'utf8');
  const patchBlock = adminSrc.slice(adminSrc.indexOf('var patch = {'),
    adminSrc.indexOf('};', adminSrc.indexOf('var patch = {')));
  const patched = [...new Set([
    ...(patchBlock.match(/^\s*(\w+):/gm) || []).map((m) => m.trim().replace(':', '')),
    ...(adminSrc.match(/patch\.(\w+) =/g) || []).map((m) => m.replace(/patch\.| =/g, '')),
  ])];
  for (const k of patched) {
    ok(NF.ADMIN_EDIT_KEYS.includes(k),
      `the panel writes "${k}", which the update rule allows`);
  }
  for (const s of [NF.PENDING, NF.APPROVED, NF.REJECTED]) {
    ok(block.slice(0, block.indexOf('allow delete')).includes(`'${s}'`),
      `the rules name the "${s}" status`);
  }

  /* the queue is drawn, counted, and applied */
  ok(/collection\('nameFixes'\)\.where\('status', '==', 'pending'\)/.test(adminSrc),
    'the Admin area badge counts the pending suggestions');
  ok(adminSrc.includes("key: 'names'"), 'and the summary strip has their tile');
  const adminHtml = await readFile(path.join(HERE, '..', 'admin-area.html'), 'utf8');
  ok(adminHtml.includes('id="oa-aa-names-list"'), 'admin-area.html carries the panel');

  const jobHtml = await readFile(path.join(HERE, '..', 'post-a-job.html'), 'utf8');
  ok(jobHtml.includes('id="oa-namefix"') && jobHtml.includes('id="nf-send"')
     && jobHtml.includes('assets/oa-namefix.js'),
    'and the posting form carries the suggestion card and its module');

  const build = await readFile(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(/collection\('nameFixes'\)\.where\('status', '==', 'approved'\)/.test(build),
    'the build reads what was APPROVED — a pending suggestion changes nothing');
  ok(/normalizeFixes/.test(build) && /buildVocab\(rows, \{ generated: now\.toISOString\(\), directory: seeded, fixes \}\)/.test(build),
    'normalises them once and hands them to the vocabulary build');
  ok(/if \(fixesFresh && fixesBare\(committedFixes\) !== fixesBare\(\{ fixes \}\)\)/.test(build),
    'and rewrites data/name-fixes.json only from a successful queue read that changed it — ' +
    'an unreachable queue changes nothing, in either direction');

  /* the served overlay file: names only, never who suggested them */
  const seedRaw = await readFile(path.join(HERE, '..', 'data', 'name-fixes.json'), 'utf8');
  const seed = JSON.parse(seedRaw);
  ok(Array.isArray(seed.fixes), 'data/name-fixes.json is committed (the form fetches it)');
  eq(S.normalizeFixes(seed.fixes), seed.fixes.map((f) => f),
    'and every committed fix survives normalisation unchanged — the build wrote ' +
    'what it will apply');
  ok(!/@/.test(seedRaw), 'and carries no e-mail address — data/ is served to anyone');

  ok(/FIXES_URL/.test(pick) && /S\.normalizeFixes/.test(pick) && /S\.fixPlace/.test(pick),
    'the browser overlays the same file through the same two functions, so the ' +
    'poster\'s preview and the build cannot disagree about what a fix does');
  ok(/OAPlacePicker\.fixedPlace\(place\)/.test(await readFile(
    path.join(HERE, '..', 'assets', 'oa-jobform.js'), 'utf8')),
    'the submission itself included');
}

/* --------------------------------- what a takedown must NOT reach, and when

   Five ways the removal machinery went wrong, each one reproduced before it
   was fixed. They are grouped because they share a cause: a row's id is
   DERIVED on every build, and a document's word about which row it is was
   taken at face value. */
async function testRemovalSafety() {
  const row = (id, over = {}) => ({
    id, year: 2026, posted: '2026-04-07', institution: 'Tulane University',
    department: 'Ops', school: '', unit: 'Ops', type: 'University',
    levels: ['Assistant Professor'], applyBy: 'Until filled.', applyByDate: '',
    comments: '', country: 'United States', adUrl: '', adLabel: '',
    postedAtUrl: '', postedAtLabel: '', furtherInfoUrl: '', characteristics: [],
    featured: false, source: 'sheet-import', addedAt: '2026-04-07T00:00:00Z',
    owner: '', ref: '', ...over,
  });

  /* (1) A MERGED ACCOUNT'S WITHDRAWAL. Merging moves a posting to a new uid
     WITHOUT republishing it, so the served row still carries the tag of the
     account merged away. Scoped to the new uid alone, the poster's next
     withdrawal matched nothing at all. */
  const oldUid = 'uid-before-the-merge-0001';
  const newUid = 'uid-after-the-merge-00002';
  const published = row('p-1', { ref: 'OA-JOB-1', owner: ownerTag(oldUid) });
  let r = removalSpecs([{ id: 'doc-1',
    data: () => ({ uid: newUid, mergedFrom: oldUid, ref: 'OA-JOB-1', status: 'withdrawn' }) }]);
  ok(r.specs.some((x) => specMatches(x, published)),
    'a poster who merged their accounts can still withdraw a posting made under the old one');
  eq(mergeRows([published], [], r.specs).removed, 1, 'and the row actually goes');

  /* …without widening it. The tag is PUBLISHED, so a document may not simply
     name one — and `mergedFrom` is trusted ONLY because the rules pin it to
     the account merge (`mergedFromUnchanged`). `accountKeys` maps an e-mail
     to a raw uid for anyone signed in, so without that rule this scoping is
     defeated by the very field it relies on. */
  const rules0 = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  ok(rules0.includes('function mergedFromUnchanged()'),
    'the rules pin mergedFrom, which is the only reason the build may read it');
  eq((rules0.match(/&& mergedFromUnchanged\(\)/g) || []).length, 3,
    'on all three posting collections\' correct/withdraw path');
  eq((rules0.match(/&& !\('mergedFrom' in request\.resource\.data\)/g) || []).length, 3,
    'and a new posting may not carry it at all');
  r = removalSpecs([{ id: 'doc-2',
    data: () => ({ uid: 'a-stranger-uid-000000001', ref: 'OA-JOB-1',
                   owner: ownerTag(oldUid), status: 'withdrawn' }) }]);
  eq(mergeRows([published], [], r.specs).removed, 0,
    'while quoting somebody else’s owner tag still removes nothing');

  /* (2) THE SAME-DAY SIBLING. Two Tulane postings on one day are `X` and
     `X-2`, and which is which is decided among the rows built THAT RUN — so
     taking one down renames the survivor onto the id the hidden document
     names. The survivor must not be deleted by it. */
  const hidden = { id: '2026-tulane-university-20260407',
                   data: () => ({ uid: null, status: 'hidden',
                                  publishedId: '2026-tulane-university-20260407' }) };
  const survivor = row('2026-tulane-university-20260407', { department: 'Finance' });
  const specs = removalSpecs([hidden]).specs;
  ok(specs.some((x) => specMatches(x, survivor)),
    'the hidden document does name the id the survivor was renumbered onto');
  // which is exactly why the build filters those specs out before the merge
  const builtIds = new Set([survivor.id]);
  const applicable = specs.filter((x) => !x.id || !builtIds.has(x.id));
  eq(applicable.length, 0, 'so a takedown naming a row still being published is set aside');
  eq(mergeRows([survivor], [survivor], applicable).rows.length, 1,
    'and the sibling that is still advertised stays on the site');

  /* (3) A WITHDRAWAL IS RETIRED ONLY WHEN IT WORKED. `removed` takes the
     document out of the query that finds it, so stamping one whose row is
     still published makes the failure permanent AND silent. */
  const build = await readFile(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(/const mine = removeSpecs\.filter\(\(x\) => x\.docId === d\.id\)/.test(build),
    'the stamp asks whether THIS document’s row is still published');
  ok(/stillThere\.push/.test(build) &&
     /did not reach their posting and are left to/.test(build.replace(/\s+/g, ' ')),
    'and leaves it to retry, saying so, rather than marking it done');

  /* (4) A PINNED ID IS CLAIMED BEFORE THE DERIVED ONES. Overwriting an id
     AFTER assignIds could drop it onto one already handed out this run, and
     mergeRows keys by id — the second row silently replaced the first. */
  const a = { key: 'zzz-random-doc-id', row: row('', { institution: 'KU Leuven', posted: '2026-07-02' }) };
  const b = { key: '2027-ku-leuven-20260702',
              fixedId: '2027-ku-leuven-20260702',
              row: row('', { institution: 'KU Leuven', posted: '2026-07-02', department: 'Other' }) };
  assignIds([a, b]);
  eq(b.row.id, '2027-ku-leuven-20260702', 'the workbook’s own id is kept');
  ok(a.row.id !== b.row.id, 'and the derived one is made to avoid it');
  eq(new Set([a.row.id, b.row.id]).size, 2, 'so two postings never share an id');

  /* (5) THE ENTRY-POINT GUARD. A raw path and a file URL are not the same text
     once the path holds a space — this repository carried a directory called
     `back up` until it was renamed `_backup`, and a checkout path can hold a
     space anywhere. Compared as strings, main() is never called
     and the process exits 0 having published nothing. */
  for (const f of ['build-jobs.mjs', 'migrate-to-firestore.mjs']) {
    const src = await readFile(path.join(HERE, f), 'utf8');
    ok(src.includes('pathToFileURL(process.argv[1]).href'),
      `${f} compares file URLs, so a path with a space still runs the build`);
    ok(!/`file:\/\/\$\{process\.argv\[1\]\}`/.test(src),
      `${f} no longer builds that URL by hand`);
  }
}

async function testMirrorLifecycle() {
  /* The sync REPORTS what it wrote, and one of its reports is a GitHub Actions
     `::warning::` annotation — which on a passing selftest would put a warning
     on the run for a case the test deliberately provokes. So the whole
     exercise runs with the log held. */
  const realLog = console.log;
  console.log = () => {};
  try {
    await runMirrorLifecycle();
  } finally {
    console.log = realLog;
  }
}

/** What `rowFromSubmission` will not publish a posting without — the same
    minimum a card needs to be worth rendering (jobs-model.mjs). `department`
    is the school and the unit joined, so a row that names neither has none. */
const SUBMISSION_NEEDS = ['institution', 'department', 'country', 'type', 'levels'];

async function runMirrorLifecycle() {
  const now = new Date('2026-08-18T00:00:00Z');
  const mk = (id, over = {}) => ({
    id, year: 2027, posted: '2026-08-15', institution: 'Utah Valley University',
    department: 'Operations & SCM', school: '', unit: 'Operations & SCM',
    type: 'University', levels: ['Non-tenure track (teaching) position'],
    applyBy: 'Until filled.', applyByDate: '', comments: '', country: 'United States',
    adUrl: '', adLabel: '', postedAtUrl: '', postedAtLabel: '', furtherInfoUrl: '',
    characteristics: [], featured: false, source: SHEET_SOURCE,
    addedAt: '2026-08-15T00:00:00Z', owner: '', ...over,
  });

  // A FIRST RUN gives every workbook row a handle.
  const rows = [mk('row-a'), mk('row-b', { comments: 'b' })];
  let col = fakeCollection();
  let r = await syncSheetMirrors(col, rows, [], new Set(), { now });
  eq(r.created, 2, 'a first run gives every workbook posting an editing handle');
  eq(col.docs.get('row-a').status, MIRROR_STATUS, 'and the handle is inert');
  eq(col.docs.get('row-a').sheetId, 'row-a', 'pinned to the row it stands for');
  eq(col.docs.get('row-a').uid, null, 'and owned by nobody, so no poster can read it');

  // A QUIET RUN writes nothing: the mirrors are already what the workbook says.
  const mirrorDocs = [...col.docs].map(([id, v]) => ({ id, data: () => v }));
  col = fakeCollection(Object.fromEntries(col.docs));
  r = await syncSheetMirrors(col, rows, mirrorDocs, new Set(), { now: new Date() });
  eq(r, { created: 0, refreshed: 0, deleted: 0, skipped: 0 },
    'a run that changes nothing writes nothing — not even a fresh timestamp');
  eq(col.ops.length, 0, 'and issues no operation at all');

  // THE WORKBOOK STILL MAINTAINS AN UNTOUCHED POSTING.
  const edited = [mk('row-a', { comments: 'now with a note' }), rows[1]];
  r = await syncSheetMirrors(col, edited, mirrorDocs, new Set(), { now });
  eq(r.refreshed, 1, 'a posting changed in the workbook is refreshed');
  eq(col.docs.get('row-a').comments, 'now with a note', 'with what the workbook now says');

  /* THE HAND-OVER. Once the maintainer has taken a posting over, the workbook
     must never write to it again — this is the whole point, and getting it
     wrong reverts their edit on the next build with nothing to show for it. */
  col = fakeCollection(Object.fromEntries(col.docs));
  r = await syncSheetMirrors(col, edited, mirrorDocs, new Set(['row-a']), { now });
  eq(col.ops.filter(([, id]) => id === 'row-a').length, 0,
    'a posting the maintainer took over is never written by the sheet again');
  eq(r.refreshed, 0, 'so the workbook reverts nothing');

  // A ROW THAT LEFT THE WORKBOOK takes its handle with it.
  col = fakeCollection(Object.fromEntries(col.docs));
  r = await syncSheetMirrors(col, [rows[1]], mirrorDocs, new Set(), { now });
  eq(r.deleted, 1, 'a handle is removed when its row leaves the workbook');
  ok(!col.docs.has('row-a'), 'so no Edit button is drawn on a posting that has gone');

  /* AN ID ALREADY IN USE IS PROBED, NEVER OVERWRITTEN. The handle's id is the
     row's own id, which is also what a migrated posting's document is keyed on,
     so a blind write here would replace a real advertisement. */
  col = fakeCollection({ 'row-c': { status: 'published', institution: 'Somebody else' } });
  r = await syncSheetMirrors(col, [mk('row-c')], [], new Set(), { now });
  eq(r.created, 0, 'an id already in use is not claimed');
  eq(r.skipped, 1, 'it is reported instead');
  eq(col.docs.get('row-c').institution, 'Somebody else',
    'and the document that was there is untouched');

  // An id Firestore could not carry is skipped rather than mangled.
  col = fakeCollection();
  r = await syncSheetMirrors(col, [mk('bad/id')], [], new Set(), { now });
  eq(r.created, 0, 'an id that is not usable as a document id is skipped');
  eq(r.skipped, 1, 'and reported');
}

async function testRefLessTakedown() {
  const row = (id, over = {}) => ({
    id, year: 2026, posted: '2025-09-01', institution: 'Somewhere', department: 'Ops',
    school: '', unit: 'Ops', type: 'University', levels: ['Assistant Professor'],
    applyBy: 'Until filled.', applyByDate: '', comments: '', country: 'United States',
    adUrl: '', adLabel: '', postedAtUrl: '', postedAtLabel: '', furtherInfoUrl: '',
    characteristics: [], featured: false, source: 'sheet-import',
    addedAt: '2025-09-01T00:00:00Z', owner: '', ref: '', ...over,
  });

  const served = [row('a-1'), row('a-2')];

  // what the build did BEFORE: nothing at all
  eq(mergeRows(served, [], ['']).removed, 0,
    'an empty reference removes nothing — which is what every served row had');

  // and what it does now
  const out = mergeRows(served, [], [{ id: 'a-1' }]);
  eq(out.removed, 1, 'a posting with no reference is taken down by its id');
  eq(out.rows.map((r) => r.id), ['a-2'], 'and only that one leaves');

  // a reference still works exactly as it did, so nothing regresses
  const withRef = [row('b-1', { ref: 'OA-JOB-1' }), row('b-2')];
  eq(mergeRows(withRef, [], ['OA-JOB-1']).rows.map((r) => r.id), ['b-2'],
    'a posting that HAS a reference is still taken down by it');
  // and an id that names nothing is simply not found
  eq(mergeRows(served, [], [{ id: 'not-a-row' }]).removed, 0,
    'an id that matches no row removes nothing');

  /* THE REPORT HAS TO AGREE WITH THE FILE. The admin is e-mailed every
     takedown; keyed on `ref` alone it reported none of them, so a posting
     could come off the site with no record that it had. */
  const ch = collectChanges(served, [], [], ['a-1']);
  eq(ch.takedowns.length, 1, 'and the change e-mail reports it');
  eq(ch.takedowns[0].before.id, 'a-1', 'naming the posting that went');
  eq(collectChanges(served, [], [], []).takedowns.length, 0,
    'while a run that took nothing down still reports nothing');

  /* EVERY read of `sheetId` is guarded, not most of them. The one left
     unguarded — the withdrawn documents handed to sheetHandover — was enough
     on its own to delete a workbook posting: the row is treated as handed
     over and dropped, while the document publishes nothing, and `stranded`
     cannot report it because the row was never claimed. */
  const build0 = await readFile(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  eq((build0.match(/buildOwned\(d\.data\(\)\)/g) || []).length, 3,
    'every place the build reads a document\'s sheetId asks whose word it is');
  ok(!/pulledSheetIds: pulled\.map\(\(d\) => d\.data\(\)\.sheetId\)/.test(build0),
    'including the withdrawn documents the hand-over reads');

  /* The build must collect those ids from the documents it pulled — by
     publishedId, by sheetId and by the document's own id, which for a migrated
     posting IS the row id (migrate-to-firestore.mjs). */
  const build = await readFile(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(/removalSpecs\(pulled\)/.test(build),
    'build-jobs.mjs keys takedowns on the id as well as the reference');
  ok(/!applicable\.some\(\(x\) => specMatches\(x, r\)\)\)/.test(build),
    'so a taken-down posting is no longer carried on as an orphan');
  ok(/const builtIds = new Set\(freshVisible/.test(build),
    'a takedown never takes a row a live document just built — a renumbered same-day sibling');
  /* AND THE MERGE IS GIVEN THE FILTERED SET. Declaring `applicable` and then
     handing `removeSpecs` to mergeRows — the obvious-looking variable, still in
     scope three lines either side — reinstates the silent deletion with every
     other check in this file green. The argument is the whole guard. */
  ok(/mergeRows\(\w+, freshVisible, applicable\)/.test(build),
    'and the merge is handed the filtered set, which is where that guard actually bites');
  /* The carried rows reach it through healPlace, so an alias added to
     oa-schools.js renames them instead of turning the "one way" guard below
     red — which, since the build runs this file before committing, would stop
     the site publishing anything at all. */
  ok(/orphans\.map\(\(r\) => healPlace\(r, fixes\)\)/.test(build) && /mergeRows\(healed,/.test(build),
    'and the postings it carries are re-canonicalised on the way through, approved ' +
    'name corrections included');
  ok(!/mergeRows\(orphans, freshVisible, removeSpecs\)/.test(build),
    'never the unfiltered one');
  ok(/stillThere\.push/.test(build),
    'and a withdrawal that did not reach its posting is left to retry, never marked done');

  /* WHOSE WORD THE BUILD TAKES. Every one of these ids is published in
     data/jobs.json and data/jobmarket.json, so an unscoped removal is a
     signed-in stranger deleting somebody else's advertisement. */
  const mine = { data: () => ({ uid: 'attacker-uid-1234567890', status: 'withdrawn',
                                publishedId: 'victims-row', sheetId: 'a-workbook-row' }),
                 id: 'random-doc-id' };
  let r = removalSpecs([mine]);
  eq([...r.ids], [],
    'a row id named by a submission a BROWSER made is never honoured');
  eq(r.specs, [], 'so it asks for no removal at all');

  const theirs = { data: () => ({ uid: 'attacker-uid-1234567890', status: 'withdrawn',
                                  ref: 'OA-JOB-SOMEBODY-ELSE' }), id: 'random-doc-id' };
  r = removalSpecs([theirs]);
  eq(r.specs.length, 1, 'a reference is still honoured');
  eq(r.specs[0].ref, 'OA-JOB-SOMEBODY-ELSE', 'as itself');
  ok(r.specs[0].owner, 'but SCOPED TO ITS OWNER — mergeRows keys ref:<owner>:<ref>');
  eq(r.specs[0].owner, ownerTag('attacker-uid-1234567890'),
    'by the same owner tag the published row carries');
  /* and therefore it cannot reach a row somebody else published */
  const victimRow = { id: 'v', ref: 'OA-JOB-SOMEBODY-ELSE', owner: ownerTag('the-real-owner-uid') };
  eq(mergeRows([victimRow], [], r.specs).removed, 0,
    'so withdrawing under a stolen reference removes nothing');
  eq(mergeRows([victimRow], [], removalSpecs([{ id: 'x',
    data: () => ({ uid: 'the-real-owner-uid', ref: 'OA-JOB-SOMEBODY-ELSE' }) }]).specs).removed, 1,
    'while the account that published it still takes its own posting down');

  /* A document the BUILD wrote — the migration's, and the mirrors — carries no
     uid, which the rules make impossible for a browser to produce. Those are
     the only ids the build takes at their word. */
  r = removalSpecs([{ id: '2026-somewhere-20250901',
                      data: () => ({ uid: null, status: 'hidden', sheetId: 'a-workbook-row' }) }]);
  ok(r.ids.has('2026-somewhere-20250901'), 'the migration\'s own document id is honoured');
  ok(r.ids.has('a-workbook-row'), 'and the mirror\'s sheetId');
  ok(!buildOwned({ uid: 'x' }), 'a submission with a uid is a browser\'s, never the build\'s');
  ok(buildOwned({ uid: null }), 'and one without is the build\'s');
  /* The rules are what make that true, so they are pinned here too. */
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  ok(rules.includes('request.resource.data.uid == request.auth.uid'),
    'a browser cannot create a submission without a uid');
  ok(rules.includes('request.resource.data.uid == resource.data.uid'),
    'nor clear the uid on one it owns');
}

async function testSheetMirrors() {
  const row = {
    id: '2027-utah-valley-university-20260815',
    year: 2027, posted: '2026-08-15',
    institution: 'Utah Valley University', department: 'Operations & SCM',
    school: '', unit: 'Operations & SCM', type: 'University',
    levels: ['Non-tenure track (teaching) position'],
    applyBy: 'Until filled.', applyByDate: '', comments: '', country: 'United States',
    adUrl: 'https://example.org/ad', adLabel: 'link to Job ad',
    postedAtUrl: '', postedAtLabel: 'link', furtherInfoUrl: '',
    characteristics: [], featured: false, source: SHEET_SOURCE,
    addedAt: '2026-08-15T00:00:00Z', owner: '',
  };

  const now = new Date('2026-08-18T00:00:00Z');
  const doc = sheetMirrorDoc(row, { now });

  eq(doc.status, MIRROR_STATUS, 'a mirror is inert — its status is one no query in the build reads');
  eq(doc.sheetId, row.id, 'and it names the workbook row it stands for');
  eq(doc.uid, null, 'a mirror belongs to nobody, so no poster can read or write it');
  eq(doc.institution, row.institution, 'it carries the posting itself, so the form opens filled in');
  ok(!['queued', 'published', 'withdrawn', 'hidden'].includes(doc.status),
    'and it can never be picked up by the publish, the takedown or the stamping queries');

  /* THE HAND-OVER IS THE STATUS AND NOTHING ELSE. post-a-job.html sets
     'queued' on every edit it saves — it always has — so the mirror becomes an
     ordinary live submission with no new field to remember and nothing that
     can disagree with itself. */
  const back = rowFromSubmission({ ...doc, status: 'queued' }, { now });
  ok(back, 'once the maintainer saves, the same document publishes as a posting');
  eq(back.institution, row.institution, 'and reproduces the row it mirrored');
  eq(back.applyBy, row.applyBy, 'including the deadline line, rebuilt from its parts');

  /* Every committed workbook posting must round-trip, or taking one over would
     quietly rewrite it. The ones that do not are the honest case, and it is
     wider than the `type` it was first written for: the workbook may leave ANY
     of the fields a submission needs blank — a row with no entry level, no
     country, no hiring unit at all — and the site publishes those, because the
     sheet's own row is what it publishes. A DOCUMENT cannot carry them, so
     such a posting stays the workbook's until the maintainer fills the gap in,
     which the posting form requires of them before it will save. Keyed on what
     is actually missing rather than on `type` alone: three legitimate postings
     (Leeds, McMaster, Caldwell) arrived short of a different field each and
     failed a guard that only knew about one, which stopped the build
     committing and took the whole site's data with it. */
  /* …and the list is pinned against the function rather than kept in step by
     hand: drop any one of these from a row that otherwise publishes and it
     must stop publishing, or the exemption above would quietly excuse a row
     the mirror really does break. */
  const whole = {
    ...sheetMirrorDoc(row, { now }), status: 'queued',
    school: 'Woodbury School of Business', unit: 'Operations & SCM', department: '',
  };
  ok(rowFromSubmission(whole, { now }), 'a row with everything a submission needs publishes');
  for (const f of SUBMISSION_NEEDS) {
    const less = { ...whole };
    if (f === 'department') { less.school = ''; less.unit = ''; less.department = ''; }
    else less[f] = Array.isArray(whole[f]) ? [] : '';
    ok(!rowFromSubmission(less, { now }),
      `and without a ${f} it does not — which is what the exemption is keyed on`);
  }

  const committed = JSON.parse(await readFile(JOBS, 'utf8')).filter((r) => r.source === SHEET_SOURCE);
  for (const r of committed) {
    const m = sheetMirrorDoc(r, { now });
    const out = rowFromSubmission({ ...m, status: 'queued' }, { now });
    const short = SUBMISSION_NEEDS.find((f) => !(Array.isArray(r[f]) ? r[f].length : r[f]));
    if (short) {
      ok(!out, `sheet row ${r.id}: a posting the workbook left without a ${short} cannot publish from a document`);
      continue;
    }
    ok(out, `sheet row ${r.id}: its mirror publishes`);
    if (!out) continue;
    for (const k of ['institution', 'department', 'country', 'type', 'applyBy', 'applyByDate']) {
      eq(out[k], r[k], `sheet row ${r.id}: ${k} survives the hand-over`);
    }
    eq(out.levels.join('|'), (r.levels || []).join('|'),
      `sheet row ${r.id}: the entry levels survive the hand-over`);
  }

  /* REFRESH ONLY ON A REAL CHANGE. Comparing whole documents would rewrite
     every mirror on every run — `mirroredAt` moves each time — which is a
     Firestore write per posting per build and a log that says nothing. */
  ok(!mirrorDiffers(doc, sheetMirrorDoc(row, { now: new Date('2027-01-01T00:00:00Z') })),
    'a mirror is not rewritten just because the clock moved');
  ok(mirrorDiffers(doc, sheetMirrorDoc({ ...row, comments: 'now with a note' }, { now })),
    'but it is rewritten the moment the workbook changes the posting');

  /* THE MERGE. The workbook's copy of a taken-over row has to be dropped
     BEFORE the merge: it used to arrive last, and last wins. */
  const rows = [row, { ...row, id: 'other' }];
  eq(unclaimedSheetRows(rows, new Set([row.id])).map((r) => r.id), ['other'],
    'the workbook does not re-publish a posting the maintainer has taken over');
  eq(unclaimedSheetRows(rows, new Set()).length, 2,
    'and publishes every row nobody has touched, exactly as before');
  eq(unclaimedSheetRows(rows, []).length, 2, 'an empty claim set changes nothing');

  /* THE WHOLE DECISION, as build-jobs.mjs makes it — the same function, not a
     restatement of it. Four states a workbook row can be in, and the fourth is
     the one that can lose a posting. */
  const A = row.id, B = 'other';

  // 1. nobody has touched either: the workbook publishes both, as it always did
  let h = sheetHandover({ sheetRows: rows });
  eq(h.rows.map((r) => r.id), [A, B], 'an untouched workbook publishes every row itself');
  eq(h.stranded, [], 'and strands nothing');

  // 2. the maintainer edited A, and the document built its row
  h = sheetHandover({ sheetRows: rows, builtSheetIds: [A], claimedSheetIds: [A] });
  eq(h.rows.map((r) => r.id), [B], 'an edited posting is published from its document');
  eq(h.stranded, [], 'nothing is stranded when the hand-over worked');

  // 3. the maintainer took A down: no row from either side, deliberately
  h = sheetHandover({ sheetRows: rows, pulledSheetIds: [A], claimedSheetIds: [A] });
  eq(h.rows.map((r) => r.id), [B], 'a posting taken down is published by neither');
  eq(h.stranded, [], 'and a takedown is not a stranding');

  /* 4. THE ONE THAT MATTERS. A has a document — the maintainer took it over —
     but it built no row: an edit cleared a required field, or the document
     could not be read. Dropping A here (which "every row that HAS a document"
     would do) means the posting vanishes from the site with nothing to
     replace it. */
  h = sheetHandover({ sheetRows: rows, claimedSheetIds: [A] });
  eq(h.rows.map((r) => r.id), [A, B],
    'a hand-over that could not be built falls back to the workbook — no posting is lost');
  eq(h.stranded, [A], 'and the run says which posting that happened to');

  // and a row the workbook has DROPPED is not stranded — it is meant to be gone
  h = sheetHandover({ sheetRows: [rows[1]], claimedSheetIds: [A] });
  eq(h.stranded, [], 'a posting the workbook no longer carries is not reported as stranded');
  eq(h.rows.map((r) => r.id), [B], 'and does not come back');

  /* And the rules have to allow the write the button makes. */
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  ok(/allow write: if isAdmin\(\);/.test(rules),
    'the maintainer may write any posting document — the buttons are only a UI hint');
}

async function testJobMarketSheetWiring() {
  /* The pipeline is three files that have to agree: the sync writes the
     dataset, the build merges it, and the workflow runs the sync. Each link is
     pinned here because a broken one fails SILENTLY — the site simply stops
     gaining postings, which looks exactly like a quiet market. */
  const build = await readFile(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(/data', 'jobmarket\.json'\)/.test(build) || build.includes("'jobmarket.json'"),
    'build-jobs.mjs reads the sheet dataset');
  ok(build.includes('.concat(sheetPublished)')
     && /handover\.rows\.map\(\(r\) => \{/.test(build)
     && /return h === r \? r : \{ \.\.\.h, id: r\.id \};/.test(build),
    'and merges its rows beside the postings from the database — through healPlace, ' +
    'so an approved name correction reaches the workbook\'s rows too, with the id PUT ' +
    'BACK: a sheet id is jobId-shaped and every join key (the workbook-existence ' +
    'check, the review queue, the mirror, the Edit button) names it');
  ok(build.includes('sheetHandover({'),
    'the hand-over decision is one function, exercised directly by the checks above');
  /* THE HAND-OVER. A workbook row the maintainer has edited or taken down
     publishes from its document instead, so the workbook's own copy must be
     dropped BEFORE the merge — left in, it arrives last and wins, which makes
     an edit look saved and change nothing. */
  ok(build.includes('claimedSheetIds'),
    'a posting the maintainer took over is published from its document, not the workbook');
  ok(/if \(sid && sheetPresent && !sheetIds\.has\(sid\)\)/.test(build),
    'and still leaves the site when its row leaves the workbook — the sheet keeps saying ' +
    'which postings exist');
  ok(build.includes('syncSheetMirrors'),
    'every workbook row gets an editing handle, so the maintainer can edit those postings too');
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


/* ------------------------------------------ every OTHER advertisement host */

/** A page in the shape the generic applicant-tracking systems serve: a
    JobPosting JSON-LD block wrapped in @graph — with the validThrough trap —
    and a PeopleAdmin-style details table naming the real closing date. */
const GENERIC_AD = `<!doctype html><html><head>
<title>Faculty openings</title>
<script type="application/ld+json">
{ "@context":"http://schema.org/", "@graph":[ {"@type":"WebSite","name":"x"},
  { "@type":"JobPosting",
    "title":"Assistant Professor of Operations Management",
    "datePosted":"2026-08-10",
    "validThrough":"2028-01-31",
    "hiringOrganization":{"@type":"Organization","name":"Example University"},
    "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress",
      "addressLocality":"Springfield","addressRegion":"IL","addressCountry":"US"}},
    "employmentType":"FULL_TIME" } ] }
</script></head><body>
<h1>Assistant Professor of Operations Management</h1>
<table>
  <tr><th>Open Date</th><td>08/10/2026</td></tr>
  <tr><th>Close Date</th><td>10/15/2026</td></tr>
</table>
</body></html>`;

function testAdvertsParsing() {
  const ad = parseAdvert(GENERIC_AD);

  ok(ad.ok, 'a generic applicant-tracking page parses');
  eq(ad.applyByDate, '2026-10-15', 'the deadline is the page\'s own labelled Close Date');
  eq(ad.title, 'Assistant Professor of Operations Management', 'the position is read');
  eq(ad.institution, 'Example University', 'and the employer');
  eq(ad.location, 'Springfield, IL, US', 'and where the post is');
  eq(ad.posted, '2026-08-10', 'and when it was advertised');

  /* THE HIGHEREDJOBS LESSON, GENERALISED — the reason this module is not a
     three-line JSON-LD reader. `validThrough` is when the LISTING comes
     down, ~18 months out on the boards, and it may never become a deadline
     anywhere. It is recorded separately, labelled as what it is. */
  eq(ad.listedUntil, '2028-01-31', 'validThrough is recorded as the listing\'s end');
  const ldOnly = parseAdvert(GENERIC_AD.replace(/<table>[\s\S]*?<\/table>/, ''));
  eq(ldOnly.applyByDate, '', 'and with no labelled deadline the posting gets NO date — ' +
    'validThrough is never one');
  eq(ldOnly.listedUntil, '2028-01-31', 'while the listing\'s end is still shown for what it is');
  ok(!ADVERT_DEADLINE_LABELS.some((l) => /valid\s*through|end date|expir/i.test(l)),
    'no listing-end label is in the list a deadline may come from');
  ok(LISTING_END_LABELS.every((l) => !ADVERT_DEADLINE_LABELS.includes(l)),
    'and the two label lists are disjoint');

  // the other two labelled shapes
  eq(parseAdvert('<h1>Post</h1><dl><dt>Closing date</dt><dd>15 October 2026</dd></dl>')
    .applyByDate, '2026-10-15', 'a dt/dd closing date is read');
  eq(parseAdvert('<h1>Post</h1><p><strong>Application deadline:</strong> October 15, 2026</p>')
    .applyByDate, '2026-10-15', 'and a bold-label one');

  // the employer's own sentence, believed only when it parses to a date
  const prose = parseAdvert('<h1>Post</h1><p>The application deadline is 15 October 2026.</p>');
  eq(prose.applyByDate, '2026-10-15', 'a deadline stated in prose is read');
  const openEnded = parseAdvert(
    '<h1>Post</h1><table><tr><th>Close Date</th><td>Open until filled</td></tr></table>');
  eq(openEnded.applyByDate, '', 'an open-ended search carries no date');
  ok(/until filled/i.test(openEnded.applyByProse), 'though what it said is kept');

  /* AN AMBIGUOUS ALL-NUMERIC DATE IS REFUSED, NOT GUESSED. These pages are
     written on both sides of the Atlantic; "05/10/2026" is the fifth of
     October in Coventry and the tenth of May in Salt Lake City, and unlike
     the sheet ingest this parser has no cell that has to mean something. */
  eq(advertDate('05/10/2026'), '', 'a date that could be either order is refused');
  eq(advertDate('25/10/2026'), '2026-10-25', 'one whose day settles the order is read');
  eq(advertDate('10/25/2026'), '2026-10-25', 'in either direction');
  eq(advertDate('2026-10-15 23:59'), '2026-10-15', 'ISO is read, with or without a time');
  eq(advertDate('15th October 2026'), '2026-10-15', 'and both wordy orders');
  eq(advertDate('October 15th, 2026'), '2026-10-15', 'with or without their ordinals');
  eq(advertDate('rolling'), '', 'and prose is not forced into a date');

  // a page in a shape this does not know changes nothing rather than half-read
  eq(parseAdvert('<html><body><p>Something else entirely</p></body></html>').ok, false,
    'an unrecognised page does not parse');
  ok(parseAdvert('<html><body>This position has been filled.</body></html>').gone,
    'and a listing that has come down is recognised as gone');

  /* ONE URL, ONE OWNER. higheredjobs.com has its own pipeline and cache; two
     caches for one advertisement would disagree silently. The other skips
     each have their reason in adverts.mjs. */
  ok(!isAdvertUrl('https://www.higheredjobs.com/faculty/details.cfm?JobCode=1'),
    'a HigherEdJobs link belongs to the HigherEdJobs pass, not this one');
  ok(!isAdvertUrl('https://docs.google.com/document/d/x.y'), 'a Google Doc is never fetched');
  ok(!isAdvertUrl('https://www.linkedin.com/jobs/view/123'), 'nor LinkedIn\'s login wall');
  ok(!isAdvertUrl('https://www.operationsacademia.org/'), 'nor our own home page');
  ok(!isAdvertUrl('javascript:alert(1)//x.y'), 'nor anything that is not an http(s) URL');
  ok(isAdvertUrl('https://jobs.chronicle.com/job/38018595/x/'), 'while a board link is');

  // the advertisement's identity: the URL, minus its tracking decoration
  eq(advertKeyOf('https://jobs.chronicle.com/job/1/x/?LinkSource=PremiumListing&utm_source=a#top'),
    advertKeyOf('https://www.jobs.chronicle.com/job/1/x'),
    'two links to one advertisement share one cache key');
  ok(advertKeyOf('https://www.higheredjobs.com/faculty/details.cfm?JobCode=1') === '',
    'and a URL this pass does not own gets no key at all');

  // Workday's pages are a JS shell over a public JSON endpoint
  eq(workdayApiUrl('https://psu.wd1.myworkdayjobs.com/en-US/PSU_Academic/job/Penn-State/Slug-1'),
    'https://psu.wd1.myworkdayjobs.com/wday/cxs/psu/PSU_Academic/job/Slug-1',
    'a Workday job URL maps to its tenant\'s CXS endpoint');
  eq(workdayApiUrl('https://umd.wd1.myworkdayjobs.com/exstaff/job/Campus/Title_JR100'),
    'https://umd.wd1.myworkdayjobs.com/wday/cxs/umd/exstaff/job/Title_JR100',
    'with or without the locale segment');
  eq(workdayApiUrl('https://utah.peopleadmin.com/postings/195629'), '',
    'and anything else is read as the ordinary page it is');
}

function testAdvertsApply() {
  const link = 'https://apply.example.com/12345?utm_source=x';
  const key = advertKeyOf(link);
  const cache = {
    generated: '', ads: {
      [key]: advertCacheEntry(parseAdvert(GENERIC_AD),
        { adUrl: link, checkedAt: '2026-08-18T00:00:00Z', via: 'page' }),
    },
  };

  /* The same three rules as the HigherEdJobs apply, pinned again here
     because this is a second implementation of them. */
  const openEnded = [{ id: 'a', adUrl: link, applyBy: 'Until filled.', applyByDate: '' }];
  const got = applyAdverts(openEnded, cache, { today: '2026-08-18' });
  eq(got.rows[0].applyByDate, '2026-10-15', 'an open-ended posting takes the ad\'s deadline');
  eq(got.rows[0].applyBy, longDate('2026-10-15'), 'shown the way the site writes a date');
  eq(got.changed.length, 1, 'and the correction is reported');
  const again = applyAdverts(got.rows, cache, { today: '2026-08-18' });
  eq(serialise(again.rows), serialise(got.rows), 're-applying is a no-op');

  const typed = [{ id: 'b', adUrl: link, applyBy: 'September 1, 2026', applyByDate: '2026-09-01' }];
  const kept = applyAdverts(typed, cache, { today: '2026-08-18' });
  eq(kept.rows[0].applyByDate, '2026-09-01', 'a deadline from the sheet wins over the ad');
  eq(kept.conflicts.length, 1, 'but the disagreement is reported');

  const unread = { ads: { [key]: { status: 'unreadable', applyByDate: '' } } };
  eq(serialise(applyAdverts(openEnded, unread, {}).rows), serialise(openEnded),
    'an unreadable advertisement leaves the posting exactly as it was');

  /* THE TWO PASSES SELECT DISJOINT ROWS — a HigherEdJobs posting is never
     touched by this one, so the order the sheet sync re-applies the two
     caches in cannot matter. */
  const hej = [{ id: 'c', adUrl: 'https://www.higheredjobs.com/faculty/details.cfm?JobCode=1',
    applyBy: 'Until filled.', applyByDate: '' }];
  eq(serialise(applyAdverts(hej, cache, {}).rows), serialise(hej),
    'a HigherEdJobs posting is left to the HigherEdJobs pass');

  // what is fetched, and what is left alone — the same four rules
  const row = { id: 'a', adUrl: link, posted: '2026-08-15' };
  eq(advertNeedFetch([row], { ads: {} }, { today: '2026-08-18' }).length, 1,
    'an advertisement never read is read');
  eq(advertNeedFetch([row], cache, { today: '2026-08-18', ttlDays: 7 }).length, 0,
    'one read a moment ago is left alone');
  eq(advertNeedFetch([row], cache, { today: '2026-11-30', ttlDays: 7 }).length, 0,
    'one whose deadline has passed is frozen — the search is over');
  eq(advertNeedFetch([row], cache, { today: '2026-08-18', force: true }).length, 1,
    '--force reads it anyway');

  /* The `ad` block a pending review document carries — RAISED, never
     decided, like dup and biz beside it. */
  const block = adBlock(cache.ads[key], { adUrl: link });
  eq(block.applyByDate, '2026-10-15', 'the queue block carries the deadline the ad states');
  eq(block.listedUntil, '2028-01-31', 'and the listing\'s end, labelled separately');
  ok(sameAdInfo(block, adBlock(cache.ads[key], { adUrl: link })),
    'two blocks that say the same thing compare equal — an unchanged run writes nothing');
  const doc = { rowId: 'x', status: 'pending', row: { adUrl: link }, ad: null };
  ok(queueNeedsFetch(doc, { today: '2026-08-18' }).fetch,
    'a pending posting with no block is read');
  ok(!queueNeedsFetch({ ...doc, ad: block, edits: {} }, { today: '2026-08-19', ttlDays: 7 }).fetch,
    'a fresh block is left alone');
  ok(queueNeedsFetch({ ...doc, ad: block, edits: { adUrl: 'https://other.example.com/2' } },
    { today: '2026-08-19' }).fetch, 'a re-linked advertisement is read again');
  ok(queueNeedsFetch({ rowId: 'y', status: 'pending',
    row: { adUrl: 'https://www.higheredjobs.com/faculty/details.cfm?JobCode=9' } },
    { today: '2026-08-19' }).fetch,
    'and on the QUEUE a HigherEdJobs advertisement is read too — the published ' +
    'HigherEdJobs pass only ever sees approved rows, so a pending card would ' +
    'otherwise show nothing');
}

async function testAdvertsWiring() {
  /* The same three-file agreement as the HigherEdJobs wiring, because a
     broken link between them fails the same silent way. */
  const sync = await readFile(path.join(HERE, 'sync-jobmarket-sheet.mjs'), 'utf8');
  ok(sync.includes('applyAdverts'),
    'the sheet sync re-applies what the advertisements said');
  ok(sync.includes('adverts.json'), 'reading it from the committed cache');

  const wf = await readFile(
    path.join(HERE, '..', '.github', 'workflows', 'oa-adverts-verify.yml'), 'utf8');
  ok(wf.includes('adverts-verify.mjs'), 'the workflow runs the check');
  ok(wf.includes('node _scraper/selftest.mjs'),
    'and re-checks the files it is about to commit, like every other writer of data/');
  ok(/group: oa-jobs-data-/.test(wf),
    'it shares the data/ concurrency group, so it never races the sheet read or the build');
  ok(wf.includes('--apply-only'),
    'and a rejected push re-applies onto the new tip rather than pushing over it');
  ok(wf.includes('FIREBASE_SERVICE_ACCOUNT'),
    'and it carries the credentials the review-queue pass needs');

  /* The queue pass writes the `ad` block and NOTHING else — never the
     decision, never the edits. Read from the source, like the panel pins. */
  const verify = await readFile(path.join(HERE, 'adverts-verify.mjs'), 'utf8');
  ok(verify.includes('.set({ ad: block }, { merge: true })'),
    'the queue pass writes only the ad block, by merge');
  eq((verify.match(/\.set\(/g) || []).length, 1,
    'and that merge is the ONLY document write in the file — never the ' +
    'decision, never the edits');
  ok(!verify.includes('.update(') && !verify.includes('.delete('),
    'no other write path exists');

  /* The block reaches both places the decision is made — the card and the
     e-mail — with the button that fills the box rather than deciding. */
  const panel = await readFile(path.join(HERE, '..', 'assets', 'oa-jobreview.js'), 'utf8');
  ok(panel.includes('data-advert'), 'the review card draws what the advertisement says');
  ok(panel.includes('data-ad-use'), 'with a button that fills the Closing-date box');
  ok(panel.includes("querySelector('[data-key=\"applyByDate\"]')"),
    'and the button fills exactly the box the card publishes from');
  const mailer = await readFile(path.join(HERE, 'jobreview-mailer.mjs'), 'utf8');
  ok(mailer.includes('advertHtml(doc)'), 'and the review e-mail says the same thing');

  /* The cache is data/, so it must survive a round trip like every other
     file there — and the served postings must still satisfy the served-file
     rules after the pass has touched them. */
  if (existsSync(path.join(HERE, '..', 'data', 'adverts.json'))) {
    const cache = JSON.parse(
      await readFile(path.join(HERE, '..', 'data', 'adverts.json'), 'utf8'));
    ok(cache && typeof cache.ads === 'object', 'the committed cache has the shape it should');
    for (const [k, ad] of Object.entries(cache.ads)) {
      ok(['ok', 'gone', 'unreadable'].includes(ad.status), `cache ${k}: a known status`);
      ok(!ad.applyByDate || /^\d{4}-\d{2}-\d{2}$/.test(ad.applyByDate),
        `cache ${k}: the deadline is ISO`);
      ok(advertKeyOf(ad.url) === k, `cache ${k}: its url names the same advertisement`);
    }
    const rows = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'jobmarket.json'), 'utf8'));
    const applied = applyAdverts(rows, cache, {});
    eq(serialise(applied.rows), serialise(rows),
      'the committed postings already carry what the advertisements said');
  }
}

/* ------------------------------------------------ the posting review queue */

const RV_ROW = {
  id: '2027-example-university-20260815', year: 2027, posted: '2026-08-15',
  institution: 'Example University', department: 'Operations', school: '', unit: 'Operations',
  type: 'University', levels: ['Assistant Professor'],
  applyBy: 'Until filled.', applyByDate: '', comments: 'Lecturer · Orem, UT',
  country: 'United States', adUrl: 'https://www.higheredjobs.com/faculty/details.cfm?JobCode=1',
  adLabel: 'link to Job ad', postedAtUrl: '', postedAtLabel: 'link',
  furtherInfoUrl: '', characteristics: [], featured: false,
  source: 'jobmarket-sheet', addedAt: '2026-08-15T00:00:00Z', owner: '',
  _tab: '2026 Jobs', _sheet: 'abc',
};

function testReviewQueue() {
  /* THE GATE ITSELF. A row the queue has never seen is NOT publishable — the
     rule is "absence means withhold", never "a rejection means withhold", so a
     queue that failed to write cannot leak a posting onto the site. */
  const fresh = partition([RV_ROW], [], { now: '2026-08-18T00:00:00Z' });
  eq(fresh.publish.length, 0, 'a posting the queue has not seen is not published');
  eq(fresh.queue.length, 1, 'it is queued for the maintainer instead');
  eq(fresh.queue[0].status, PENDING, 'as pending');
  eq(fresh.queue[0].rowId, RV_ROW.id, 'keyed by the row it came from');
  ok(!('_tab' in fresh.queue[0].row) && !('_sheet' in fresh.queue[0].row),
    'the pipeline\'s own provenance keys are not carried into the queue');

  // and every key it writes is one the rules allow
  for (const k of Object.keys(fresh.queue[0])) {
    ok(DOC_KEYS.includes(k), `queue document key "${k}" is one the rules allow`);
  }

  /* THE GATE ARRIVING IS NOT A REASON TO RETRACT. Sixteen of the sheet's
     postings were on the site before the queue existed, and the first morning
     it answered they would all have had no document and therefore come down —
     off the jobs page, after alerts about them had gone out. Already public is
     already reviewed in the only sense that matters here, so those rows enter
     the queue approved, with the reason written into them; rejecting one still
     takes it down. */
  const grand = partition([RV_ROW], [], { now: '2026-08-18T00:00:00Z',
    published: new Set([RV_ROW.id]) });
  eq(grand.publish.map((r) => r.id), [RV_ROW.id],
    'a posting the site is already showing stays on it');
  eq(grand.queue[0].status, APPROVED, 'and enters the queue approved');
  ok(/before the review gate/i.test(grand.queue[0].note), 'saying why');
  for (const k of Object.keys(grand.queue[0])) {
    ok(DOC_KEYS.includes(k), `grandfathered key "${k}" is one the rules allow`);
  }
  eq(partition([RV_ROW], [], { published: new Set(['something-else']) }).publish.length, 0,
    'anything the site is NOT already showing is still withheld — the gate is ' +
    'unchanged for every posting from here on');

  const approved = [{ rowId: RV_ROW.id, status: APPROVED, row: RV_ROW, edits: {} }];
  const live = partition([RV_ROW], approved, {});
  eq(live.publish.length, 1, 'an approved posting is published');
  eq(live.queue.length, 0, 'and is not queued again');

  /* A REJECTION IS REMEMBERED. Without this the next sync would queue it
     again, and the maintainer would be asked every morning about a posting
     they have already turned down. */
  const no = partition([RV_ROW], [{ rowId: RV_ROW.id, status: REJECTED, row: RV_ROW }], {});
  eq(no.publish.length, 0, 'a rejected posting stays off the site');
  eq(no.queue.length, 0, 'and is never re-queued');

  /* THE SHEET KEEPS MOVING UNDER THE QUEUE. A posting queued on Monday whose
     department is corrected on Tuesday must show Tuesday's department when it
     is finally reviewed — while staying pending, with the maintainer's own
     edits untouched. */
  const queued = queueDoc(RV_ROW, { now: '2026-08-18T00:00:00Z' });
  queued.edits = { comments: 'mine' };
  const moved = { ...RV_ROW, department: 'Operations and Analytics' };
  const split = partition([moved], [queued], {});
  eq(split.refresh.length, 1, 'a queued posting catches up with the sheet');
  eq(split.refresh[0].row.department, 'Operations and Analytics', 'taking the new content');
  eq(split.refresh[0].status, PENDING, 'while staying pending');
  eq(split.refresh[0].edits.comments, 'mine', 'and keeping what the maintainer typed');
  eq(refreshQueued(queued, RV_ROW), null, 'an unchanged sheet refreshes nothing');

  /* AN APPROVAL DATES THE POSTING FROM THE DAY IT COULD FIRST BE READ. The
     queue's copy carries the day the crawler first saw the row, which can be
     days before the maintainer approved it — and `addedAt` is what the e-mail
     alerts window on, so dated from the crawl a posting approved after a
     subscriber's last digest fell outside every window and was announced to
     nobody. Grandfathered documents are exempt (their reviewedAt and queuedAt
     are the same instant, stamped by partition itself): those postings were
     public and announced long before the gate existed, and re-dating them
     would blast every subscriber about postings they already know. */
  const decided = { rowId: RV_ROW.id, status: APPROVED, row: RV_ROW, edits: {},
    queuedAt: '2026-08-18T00:00:00Z', reviewedAt: '2026-08-22T09:30:00.123Z' };
  const published = partition([RV_ROW], [decided], {}).publish[0];
  eq(published.addedAt, '2026-08-22T09:30:00Z',
    'an approved posting is dated from its approval, not from the crawl');
  eq(approvedRow(RV_ROW, { ...decided, reviewedAt: '2026-08-18T00:00:00Z' }).addedAt,
    RV_ROW.addedAt,
    'a grandfathered document (reviewedAt == queuedAt) keeps the date it had');
  eq(approvedRow({ ...RV_ROW, addedAt: '2026-08-25T00:00:00Z' }, decided).addedAt,
    '2026-08-25T00:00:00Z',
    'and a date already later than the approval is never wound back');
  ok(approvedRow(RV_ROW, decided).addedAt ===
     approvedRow(RV_ROW, decided).addedAt &&
     JSON.stringify(approvedRow(RV_ROW, decided)) ===
     JSON.stringify(partition([RV_ROW], [decided], {}).publish[0]),
    'the sheet sync and the build publish an approval identically, so the file cannot flap');
}

function testReviewDuplicates() {
  /* THE SAME JOB, ALREADY POSTED. A school that advertises through the site's
     own form is routinely also entered in the tracking workbook, and the
     crawled copy then arrives in the queue as a fresh posting. It is FLAGGED
     against the site, never collapsed: the maintainer decides on the card. */
  const site = [
    { id: 'OA-1', ref: 'OA-JOB-260820-HLA8', source: 'oa-form', year: 2027,
      institution: 'University of Nevada, Las Vegas', school: 'Lee Business School',
      unit: 'Marketing', department: 'Lee Business School, Marketing',
      levels: ['Assistant Professor'], posted: '2026-08-20',
      adUrl: 'https://apply.interfolio.com/12345' },
  ];
  const crawled = { id: '2027-unlv-20260822', year: 2027,
    institution: 'The University of Nevada, Las Vegas', school: '',
    unit: 'Marketing', department: 'Marketing',
    levels: ['Assistant Professor'], posted: '2026-08-22', adUrl: '' };

  eq(duplicatesOf(crawled, site).map((d) => d.id), ['OA-1'],
    'a crawled posting naming the same department at the same university in the ' +
    'same market is flagged, across a "The" the two spellings do not share');

  eq(duplicatesOf({ ...crawled, unit: 'Finance', department: 'Finance' }, site), [],
    'a different department at the same school is not');
  eq(duplicatesOf({ ...crawled, year: 2026 }, site), [],
    'nor is the same department in a different market year');
  eq(duplicatesOf({ ...crawled, unit: '', department: '',
    adUrl: 'https://apply.interfolio.com/12345/' }, site).map((d) => d.id), ['OA-1'],
    'while the same advertisement link flags it whatever the names say');
  eq(duplicatesOf({ ...crawled, levels: ['Post-Doc'] }, site), [],
    'and two rows whose entry levels share nothing are two advertisements — ' +
    'the Houston lesson, honoured here too');
  eq(duplicatesOf({ ...crawled, adUrl: 'https://www.operationsacademia.org/',
    unit: '', department: '' }, site), [],
    'our own home page in the link column identifies nothing');

  const entry = duplicatesOf(crawled, site)[0];
  eq(Object.keys(entry).sort(),
    ['department', 'id', 'institution', 'posted', 'ref', 'source'],
    'a flag carries what the card needs to say and nothing else — never a whole row');

  ok(sameDups([entry], [entry]) && !sameDups([entry], []),
    'sameDups is what keeps an unchanged sync from writing at all');

  /* the sync computes the flags and writes them; the panel only draws them */
  const withDup = queueDoc(crawled, { now: '2026-08-22T00:00:00Z', dup: [entry] });
  eq(withDup.dup.length, 1, 'a fresh queue document carries its flags');
  for (const k of Object.keys(withDup)) {
    ok(DOC_KEYS.includes(k), `flagged queue document key "${k}" is one the rules allow`);
  }
}

function testReviewBusiness() {
  /* THE BUSINESS-SCHOOL FLAG (owner, 2026-08-23). A crawled posting whose
     text mentions "business" arrives typed Business School (typeFromNames),
     and its review card then NAMES the business school the site's own
     directory knows at that university — RAISED for the maintainer, never
     decided: nothing fills the School box until they press Use it, and
     nothing publishes until they approve. */
  const vocab = buildVocab([], { directory: [
    { institution: 'University of California, Berkeley',
      school: 'Walter A. Haas School of Business',
      department: 'Operations and Information Technology Management' },
  ] });
  const bizRow = { ...RV_ROW, type: 'Business School', school: '', unit: 'Operations',
    institution: 'University of California, Berkeley' };

  eq(businessCheck(bizRow, vocab), { school: 'Walter A. Haas School of Business' },
    'a business-typed posting is given the school the directory knows');
  eq(businessCheck(RV_ROW, vocab), null,
    'a posting whose text never said business raises no flag');
  eq(businessCheck({ ...bizRow, school: 'Rutgers Business School' }, vocab), null,
    'nor does one whose School box already names a business school — the card ' +
    'would only repeat what is in the box above it');
  eq(businessCheck({ ...bizRow, institution: 'Nowhere University' }, vocab),
    { school: '' },
    'a university the directory does not know still raises the flag, with no name — ' +
    'the card says the directory has none, and the fix is a row in oa-institutions.js');
  eq(businessCheck(bizRow, null), { school: '' },
    'no vocabulary at all degrades the same way, never fatally');

  ok(sameBiz(null, null) && sameBiz({ school: 'X' }, { school: 'X' })
     && !sameBiz(null, { school: 'X' }) && !sameBiz({ school: 'X' }, { school: 'Y' }),
    'sameBiz is what keeps an unchanged sync from writing at all');

  /* the sync computes it and writes it; the panel only draws it */
  const withBiz = queueDoc(bizRow, { now: '2026-08-23T00:00:00Z',
    biz: businessCheck(bizRow, vocab) });
  eq(withBiz.biz, { school: 'Walter A. Haas School of Business' },
    'a fresh queue document carries the flag');
  for (const k of Object.keys(withBiz)) {
    ok(DOC_KEYS.includes(k), `business-flagged queue document key "${k}" is one the rules allow`);
  }
}

function testReviewEdits() {
  /* An edit is sanitised exactly as an ingest would sanitise it: a browser is
     not the authority on what a posting may contain. */
  eq(cleanEdit('country', 'USA'), 'United States',
    'an edited country is canonicalised, so an edit cannot re-fork the Location filter');
  eq(cleanEdit('adUrl', 'javascript:alert(1)'), '',
    'a javascript: URL is refused');
  eq(cleanEdit('adUrl', 'https://example.org/x'), 'https://example.org/x',
    'a real URL is kept');
  eq(cleanEdit('type', 'Not A Type'), undefined, 'an unknown institution type is dropped');
  eq(cleanEdit('type', 'University'), 'University', 'a known one is kept');
  eq(cleanEdit('levels', ['Assistant Professor', 'Nonsense']), ['Assistant Professor'],
    'an unknown entry level is dropped from the list');
  eq(cleanEdit('applyByDate', '20/08/2026'), undefined, 'a non-ISO closing date is refused');
  eq(cleanEdit('applyByDate', '2026-08-20'), '2026-08-20', 'an ISO one is kept');
  eq(cleanEdit('id', 'something-else'), undefined,
    'the row id is not editable — it is what ties the posting to its sheet row');
  eq(cleanEdit('year', 2030), undefined, 'nor is the market year, which the site derives');
  eq(cleanEdits({ institution: 'X', id: 'y', bogus: 1 }), { institution: 'X' },
    'unknown keys are dropped rather than published');

  /* THE TWO DEADLINE FIELDS MOVE TOGETHER, for the same reason as in the
     HigherEdJobs apply: the page buckets a posting as open-ended on the DATE
     being empty, so a date on the card with "Until filled" in the filter would
     be the worst of both. */
  const dated = applyEdits(RV_ROW, { applyByDate: '2026-09-30' });
  eq(dated.applyByDate, '2026-09-30', 'an edited closing date is taken');
  eq(dated.applyBy, longDate('2026-09-30'), 'and the line shown follows it');

  const opened = applyEdits({ ...RV_ROW, applyBy: 'September 30, 2026', applyByDate: '2026-09-30' },
    { applyBy: 'Until filled.' });
  eq(opened.applyByDate, '', 'saying "until filled" clears the date');

  /* AND THE LINE IS DERIVED, never typed. A line the maintainer wrote used to
     win over the date beside it, which is a trap rather than a courtesy: the
     served file must satisfy "the date shown and the date filtered on are the
     same date", so "By 30 September" against a closing date of 2026-09-30
     would fail the sheet read AND the build, and neither commits on a failure.
     One posting proved it — approved with the line emptied and the date left
     behind, taking 449 approved postings off the site with it. */
  const both = applyEdits(RV_ROW, { applyByDate: '2026-09-30', applyBy: 'By 30 September' });
  eq(both.applyBy, longDate('2026-09-30'), 'a line typed beside a date is derived from the date');

  const cleared = applyEdits({ ...RV_ROW, applyBy: 'September 30, 2026', applyByDate: '2026-09-30' },
    { applyBy: '' });
  eq(cleared.applyBy, longDate('2026-09-30'),
    'and emptying the line rebuilds it rather than leaving the date unshown');
  eq(cleared.applyByDate, '2026-09-30', 'the date it is filtered on is untouched');

  const undated = applyEdits({ ...RV_ROW, applyBy: 'September 30, 2026', applyByDate: '2026-09-30' },
    { applyByDate: '' });
  eq(undated.applyBy, 'Until filled.',
    'clearing the date says what the page already calls a posting without one');

  /* Every combination leaves the pair coherent, which is the property the
     served-file guard actually asserts — pinned here over the model itself so
     a future edit path cannot reintroduce the shape. */
  for (const edit of [{}, { applyBy: '' }, { applyByDate: '' }, { applyBy: 'nonsense' },
    { applyByDate: '2027-01-09' }, { applyBy: 'Open until filled' },
    { applyBy: 'x', applyByDate: '2027-01-09' }]) {
    const out = applyEdits({ ...RV_ROW, applyBy: 'September 30, 2026', applyByDate: '2026-09-30' }, edit);
    ok(out.applyByDate ? out.applyBy === longDate(out.applyByDate) : !!out.applyBy,
      `edit ${JSON.stringify(edit)}: the date shown and the date filtered on stay one date`);
  }

  eq(applyEdits(RV_ROW, {}).institution, 'Example University',
    'an approved posting with no edits is the sheet row itself');
  eq(changedKeys(RV_ROW, { institution: 'Example University', department: 'Other' }),
    ['department'], 'only fields that differ count as edited');
}

/* ------------------------------------------- the two deadlines a search has

   Owner, 2026-08-23: many searches have no fixed closing date yet name the
   day the committee starts reading ("First review of applications will begin
   on September 8, 2026…"), and both were published as a bare "Until filled."
   A posting now carries reviewDate (the SUGGESTED apply-by) beside
   applyByDate (the FINAL apply-by); the extractor that reads it out of the
   sources' own prose is deliberately high-precision, and everything here
   holds it to that. */

function testTwoDeadlines() {
  // ---- the date forms the sources actually write
  eq(parseProseDay('September 8, 2026'), '2026-09-08', 'a written-out date parses');
  eq(parseProseDay('Monday, Oct 5, 2026'), '2026-10-05', 'a weekday prefix is stepped over');
  eq(parseProseDay('Oct 12th 2025'), '2025-10-12', 'an ordinal, comma-less date parses');
  eq(parseProseDay('20 February 2026'), '2026-02-20', 'and the day-first written form');
  eq(parseProseDay('2026-09-08'), '2026-09-08', 'ISO passes through');
  eq(parseProseDay('10/31/2025'), '2025-10-31', 'an all-numeric date with a day over 12 is forced');
  eq(parseProseDay('10/12/2025'), '',
    'an all-numeric date that could be read either way is REFUSED — a suggested ' +
    'deadline the pipeline is unsure of is not published, the deadlineDay rule');
  eq(parseProseDay('December 1, 12014'), '', 'a typo\'d year is not a date');
  eq(parseProseDay('October 10th'), '', 'and no year is no date at all');

  // ---- the extractor fires on the shapes the committed corpus holds…
  const kansas = 'Until filled. First review of applications will begin on ' +
    'September 8, 2026, and will continue until the position has been filled.';
  eq(extractReviewDate(kansas), { date: '2026-09-08', rest: 'Until filled.' },
    'the Kansas shape: the first-review date is read and its sentence leaves the line');
  eq(extractReviewDate('Until filled. For Full Consideration, apply by: August 27, 2026'),
    { date: '2026-08-27', rest: 'Until filled.' }, 'the full-consideration shape');
  eq(extractReviewDate('Next review date: Monday, Oct 5, 2026. Apply by this date.').date,
    '2026-10-05', 'the UCLA application-window shape');
  eq(extractReviewDate('review will begin on September 1, 2026.').date, '2026-09-01',
    'the bare "review will begin" shape the comments carry');
  eq(extractReviewDate('The search committee will begin reviewing applications on ' +
    'October 6, 2025.').date, '2025-10-06', 'the begin-reviewing shape');
  eq(extractReviewDate('Consideration of applications and nominations will commence ' +
    'on 20 February 2026 until the position is filled.').date, '2026-02-20',
    'the commence shape, day-first date included');
  eq(extractReviewDate('candidates who submit their application package by ' +
    'September 28, 2025, will be given priority.').date, '2025-09-28',
    'the given-priority shape');
  eq(extractReviewDate('Until filled. Apply before Oct 12th 2025 for first round ' +
    'Zoom interview (Oct 15 - Oct 20)'),
    { date: '2025-10-12', rest: 'Until filled.' }, 'the first-round-interview shape');

  // …and ONLY on those: a date near the word "review" is never enough
  eq(extractReviewDate('We advise candidates who are attending INFORMS to submit by ' +
    '30th September').date, '', 'no year, no fire');
  eq(extractReviewDate('Review of applications will begin on October 10th and will ' +
    'continue until the positions are filled.').date, '', 'even mid-pattern');
  eq(extractReviewDate('Priority will be given to completed applications received by ' +
    '10/12/2025.').date, '', 'an ambiguous all-numeric date does not fire either');
  eq(extractReviewDate('Applications will be reviewed on a rolling basis.').date, '',
    'rolling review names no date');
  eq(extractReviewDate('We strongly encourage candidates attending INFORMS to apply by ' +
    'October 9, 2026, and to include their presentation information.').date, '',
    'encouragement without a consideration clause is not a review date');
  const untouched = 'Until filled. Early submissions are encouraged.';
  eq(extractReviewDate(untouched).rest, untouched, 'a line nothing fired on keeps every word');

  // ---- the labelled FINAL date (the other half of UCLA's window)
  eq(extractFinalDate('Final date: Thursday, Nov 5, 2026'), '2026-11-05',
    'an explicitly labelled closing date is read');
  eq(extractFinalDate('Applications will be accepted until November 5, 2026.'),
    '2026-11-05', 'and the accepted-until form');
  eq(extractFinalDate('Application Deadline The search committee will begin reviewing ' +
    'applications on October 6, 2025.'), '',
    'a bare "deadline" heading clauses away from a date is NOT a closing date — ' +
    'the mislabelled-header lesson');
  eq(extractFinalDate('The deadline for applications is strict.'), '', 'nor is no date');

  // ---- healReviewDate: fill-empty, guarded, idempotent
  const base = {
    id: 'x', applyBy: kansas, applyByDate: '', reviewDate: '', comments: '',
  };
  const healed = healReviewDate(base);
  eq(healed.reviewDate, '2026-09-08', 'a row heals from its own apply-by prose');
  eq(healed.applyBy, 'Until filled.', 'and the captured sentence leaves the line');
  eq(healReviewDate(healed), healed, 'healing is idempotent — a second pass changes nothing');

  const fromComments = healReviewDate({
    id: 'x', applyBy: 'Until filled.', applyByDate: '',
    comments: 'Although this position will remain open until filled, review will ' +
      'begin on September 1, 2026.',
  });
  eq(fromComments.reviewDate, '2026-09-01', 'the comments are read too');
  ok(fromComments.comments.includes('review will begin'),
    'but never trimmed — they are the card\'s record of what the source said');

  eq(healReviewDate({ id: 'x', applyBy: 'November 1, 2025. For full consideration, ' +
    'applications should be received by November 1, 2025.', applyByDate: '2025-11-01' })
    .reviewDate, undefined,
    'a suggested date EQUAL to the final one is the deadline said twice, not news');

  /* THE UCLA WINDOW: the posting reached the site with its REVIEW date
     recorded as the closing date, while its own words on the same row named
     both. Both labels explicit AND agreeing with the stored date, so this can
     never fire on a date the maintainer simply typed. */
  const ucla = healReviewDate({
    id: 'x', applyBy: 'October 5, 2026', applyByDate: '2026-10-05',
    comments: 'Open date: August 21, 2026 Next review date: Monday, Oct 5, 2026 at ' +
      '11:59pm (Pacific Time) Apply by this date to ensure full consideration by the ' +
      'committee. Final date: Thursday, Nov 5, 2026 at 11:59pm (Pacific Time)',
  });
  eq(ucla.reviewDate, '2026-10-05',
    'a stored closing date that IS the text\'s own review date takes the suggested field');
  eq(ucla.applyByDate, '2026-11-05', 'and the text\'s labelled Final date becomes the closing one');
  eq(ucla.applyBy, 'November 5, 2026', 'shown as the line the filter agrees with');
  eq(healReviewDate(ucla), ucla, 'settling the window is idempotent too');
  eq(healReviewDate({ id: 'x', applyBy: 'October 5, 2026', applyByDate: '2026-10-05',
    comments: 'Review of applications will begin on October 5, 2026.' }).applyByDate,
    '2026-10-05',
    'with no labelled final date the stored closing date is never touched');
  eq(healReviewDate({ id: 'x', applyBy: 'Until filled.', applyByDate: '2026-09-01',
    reviewDate: '2026-10-01' }).reviewDate, undefined,
    'and one AFTER the final date contradicts it, wherever it was typed');
  eq(healReviewDate({ id: 'x', applyBy: 'Until filled.', applyByDate: '2026-12-01',
    reviewDate: '2026-10-01' }).reviewDate, '2026-10-01',
    'an explicit suggested date before the final one is kept as given');

  // ---- the mapping: the form's field, the legacy documents' prose
  const dated = rowFromSubmission({ ...GOOD, reviewDate: '2025-10-15' });
  eq(dated.reviewDate, '2025-10-15', 'a submission carries the form\'s suggested date');
  eq(rowFromSubmission({ ...GOOD, reviewDate: '2025-11-30' }).reviewDate, undefined,
    'unless it does not fall before the final date');
  const legacy = rowFromSubmission({ ...GOOD, untilFilled: true, applyByDate: '',
    applyByNote: 'First review of applications will begin on September 8, 2026.' });
  eq(legacy.reviewDate, '2026-09-08',
    'a document from before the field existed heals from its own prose');
  eq(legacy.applyBy, 'Until filled.', 'and its apply-by line reads clean');

  // the round trip — a healed row survives becoming a document and coming back
  const back = rowFromSubmission(submissionFromRow(dated), {});
  eq(back.reviewDate, dated.reviewDate, 'reviewDate survives the migration round trip');
  eq(back.applyBy, dated.applyBy, 'with the apply-by line intact');

  // ---- the sheet ingest: the same extraction at the same cell
  const sheet = rowsFromTab(csvOf([
    ['University', 'Country', 'Date', 'Deadline'],
    ['Kansas School', 'USA', '6-Aug-26', 'Until filled. First review of applications ' +
      'will begin on September 8, 2026, and will continue until the position has been filled.'],
    ['Window School', 'USA', '21-Aug-26', 'Next review date: Monday, Oct 5, 2026. Apply by ' +
      'this date to ensure full consideration. Final date: Thursday, Nov 5, 2026'],
    ['Plain School', 'USA', '1-Sep-26', '15-Nov-26'],
  ]), { minYear: 2026 });
  const ks = sheet.rows.find((r) => r.institution === 'Kansas School');
  eq(ks.reviewDate, '2026-09-08', 'a workbook cell yields the suggested apply-by');
  eq(ks.applyBy, 'Until filled.', 'the line keeps only what the extraction did not capture');
  eq(ks.applyByDate, '', 'and an open-ended search still carries no closing date');
  const win = sheet.rows.find((r) => r.institution === 'Window School');
  eq(win.reviewDate, '2026-10-05', 'an application-window cell yields the review date');
  eq(win.applyByDate, '2026-11-05', 'AND its labelled final date');
  eq(win.applyBy, 'November 5, 2026', 'shown the way the site writes dates');
  const plain = sheet.rows.find((r) => r.institution === 'Plain School');
  ok(!plain.reviewDate, 'a bare-date cell still reads exactly as it always did');
  ok(!('reviewDate' in publicRow(plain)),
    'and publishes no empty reviewDate key');
  eq(plain.applyByDate, '2026-11-15', 'with its deadline untouched');

  // ---- the review queue: the maintainer's box obeys the same rule
  const rvRow = { id: 'r', institution: 'X University', school: '', unit: 'Ops',
    department: 'Ops', applyBy: 'Until filled.', applyByDate: '' };
  eq(applyEdits(rvRow, { reviewDate: '2026-10-01' }).reviewDate, '2026-10-01',
    'the review card can set the suggested date');
  eq(applyEdits({ ...rvRow, reviewDate: '2026-10-01' }, { reviewDate: '' }).reviewDate, '',
    'and clear it');
  eq(applyEdits({ ...rvRow, reviewDate: '2026-10-01' },
    { applyByDate: '2026-09-15' }).reviewDate, '',
    'a closing date moved before the suggested one drops the suggestion — ' +
    'whichever box the maintainer touched');
  eq(cleanEdit('reviewDate', '20/08/2026'), undefined, 'a non-ISO suggested date is refused');

  // ---- the HigherEdJobs verify: a closing date arriving re-settles the pair
  const link = detailsUrl('1234567');
  const ad = { status: 'ok', applyByDate: '2026-08-20' };
  const kept = applyVerified(
    [{ id: 'a', adUrl: link, applyBy: 'Until filled.', applyByDate: '', reviewDate: '2026-08-01' }],
    { ads: { 1234567: ad } }, {});
  eq(kept.rows[0].reviewDate, '2026-08-01',
    'a review date before the advertisement\'s deadline survives it arriving');
  const dropped = applyVerified(
    [{ id: 'b', adUrl: link, applyBy: 'Until filled.', applyByDate: '', reviewDate: '2026-09-01' }],
    { ads: { 1234567: ad } }, {});
  eq(dropped.rows[0].reviewDate, undefined,
    'one on or after it is the contradiction healReviewDate always drops');
}

/* The pages, the form, the panel and the mailers all say the two dates the
   same way — read from the sources, the discipline every other wiring test
   here follows. */
async function testTwoDeadlinesWiring() {
  const read = (...p) => readFile(path.join(HERE, '..', ...p), 'utf8');

  const jobs = await read('jobs.html');
  ok(jobs.includes("key: 'review'") && jobs.includes("label: 'Suggested deadline'"),
    'jobs.html offers the Suggested deadline filter');
  ok(jobs.includes("label: 'Final deadline'") && jobs.includes("derive: 'deadline'"),
    'beside the Final deadline one');
  ok(jobs.includes("key: 'deadline'"),
    'whose URL key stays `deadline`, so every saved link keeps working');

  for (const page of ['jobs.html', 'index.html', 'previous-markets.html']) {
    const html = await read(page);
    ok(html.includes("label: 'Suggested apply by'") && html.includes('OAList.longDate'),
      `${page}: the card shows the suggested apply-by as a written-out date`);
    ok(html.includes("label: 'Final apply by'") && !/label: 'Apply by'/.test(html),
      `${page}: and the old single Apply-by row is gone`);
  }

  const list = await read('assets', 'oa-list.js');
  ok(/review:\s*function\s*\(row\)/.test(list) && list.includes("'No review date'"),
    'the engine derives the review buckets');
  ok(list.includes('longDate: longDate'), 'and exports the date formatter the cards use');

  const form = await read('post-a-job.html');
  ok(form.includes('id="f-reviewDate"'), 'the posting form asks for the suggested date');
  ok(form.includes('Suggested apply by') && form.includes('Final apply by'),
    'in the words the cards use');
  ok(!/<input type="date" id="f-reviewDate"[^>]*required/.test(form),
    'and the suggested date is OPTIONAL — most postings name none');

  const formJs = await read('assets', 'oa-jobform.js');
  ok(formJs.includes('out.reviewDate'), 'the form submits it');
  ok(formJs.includes("set('f-reviewDate', v.reviewDate)"),
    'and an edit opens with it filled in');

  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  ok(/str\('reviewDate', 20\)/.test(rules),
    'jobSubmissions accepts the field — a form key with no rule is a ' +
    'permission-denied at save time');

  // the alerts say both dates, in the same words, in the inbox and the preview
  const mailer = await readFile(path.join(HERE, 'alerts-mailer.mjs'), 'utf8');
  const preview = await read('assets', 'oa-alerts.js');
  for (const [name, src] of [['alerts-mailer.mjs', mailer], ['oa-alerts.js', preview]]) {
    ok(src.includes('suggested apply by') && src.includes('final apply by'),
      `${name}: names the suggested and the final apply-by alike`);
  }

  // the model's own list carries the field where the served file writes it
  ok(PUBLIC_FIELDS.includes('reviewDate'), 'reviewDate is a published field');
  ok(!('reviewDate' in publicRow({ id: 'x', reviewDate: '' })),
    'and an empty one is not written onto every row of the served file');
}

async function testReviewWiring() {
  /* The three places that must agree on what may be edited: the pure module,
     the browser panel, and the rules. A field in one and not the others is
     either refused by the database or silently dropped — both look to the
     maintainer like an edit that did not save. */
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  const panel = await readFile(path.join(HERE, '..', 'assets', 'oa-jobreview.js'), 'utf8');
  const block = rules.slice(rules.indexOf('match /jobReviews/'));

  for (const f of EDITABLE) {
    ok(block.includes(`'${f.key}'`), `_firestore.rules allows editing ${f.key}`);
  }
  /* The PANEL is pinned against SHOWN, not EDITABLE: `department` is the line
     the card publishes, derived from the two names beside it, and the rules
     still have to allow it because a document written before it was derived
     may carry one. Everything else the model accepts, the panel must ask. */
  for (const f of SHOWN) {
    ok(panel.includes(`key: '${f.key}'`), `the review panel offers ${f.key}`);
    ok(panel.includes(`label: '${f.label.replace(/'/g, "\\'")}'`),
      `and asks for ${f.key} in the same words the model names it`);
  }
  /* AND BOTH WAYS. A one-way pin let the panel offer a field the model does
     not accept, which is what "Associate Professor" was: a tick box that saved
     and then vanished, because `cleanEdit` drops anything outside LEVELS. */
  const offered = [...panel.matchAll(/\{ key: '([a-zA-Z]+)'/g)].map((m) => m[1]);
  for (const key of offered) {
    ok(SHOWN.some((f) => f.key === key),
      `the panel's ${key} box is a field the model actually accepts`);
  }
  ok(!offered.includes('department'),
    'and the card does not offer the derived line beside the two names it is made of');
  ok(!offered.includes('applyBy'),
    'nor the deadline line beside the date it is written from');

  /* The option lists are the site's own vocabularies, not a second copy typed
     into the browser. LEVELS is five; the panel used to offer seven, two of
     which the model silently dropped. */
  for (const l of LEVELS) {
    ok(new RegExp(`v: '${l.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}'`).test(panel),
      `the review panel offers the "${l}" entry level`);
  }
  ok((panel.match(/\{ v: '/g) || []).length === LEVELS.length,
    'and offers no entry level the site does not have');
  for (const t of TYPES) {
    ok(panel.includes(`'${t}'`), `the review panel offers the "${t}" institution type`);
  }

  for (const k of ['id', 'year', 'posted', 'source', 'addedAt']) {
    ok(!EDITABLE.some((f) => f.key === k),
      `${k} is NOT editable — it is the posting's identity, corrected in the sheet`);
  }

  /* THE LINE THE CARD SHOWS IS DERIVED, and that is a publishing guard rather
     than a tidiness one: testSchools asserts over the SERVED file that
     `department` equals its two parts joined, and a red selftest stops
     oa-jobs-build.yml committing anything at all. Three independent boxes and
     no derivation meant one corrected school could stop the whole site
     publishing. */
  {
    const row = {
      id: 'r', institution: 'University of California, Berkeley', school: '',
      unit: 'Operations and Information Technology Management',
      department: 'Operations and Information Technology Management',
    };
    const fixed = applyEdits(row, { school: 'Walter A. Haas School of Business' });
    eq(fixed.department,
      'Walter A. Haas School of Business, Operations and Information Technology Management',
      'correcting the school rebuilds the line the card shows');
    eq(applyEdits(row, {}).department, row.department,
      'and an untouched posting keeps exactly the line it arrived with');
    eq(applyEdits(row, { school: '', unit: '' }).department, '',
      'clearing both names clears the line, so the file stays self-consistent');
    /* The sheet publishes `joinDepartment(...) || area`, so a row whose area
       canonicalised away to nothing carries a line with no parts behind it.
       Deriving would blank it, and the card, the University search and the
       alert matcher all read it. */
    eq(applyEdits({ institution: 'X University', school: '', unit: '', department: 'Raw area' }, {})
      .department, 'Raw area',
      'a row that never had two names keeps the line the sheet gave it');

    /* One spelling per place, HERE TOO. cleanEdit canonicalised the country
       and nothing else, so a school typed into this panel reached
       data/jobs.json exactly as typed — while testSchools asserts over that
       file that every posting names its place the way canonPlace names it, and
       a red selftest stops the build committing. (An unknown spelling is still
       published as typed: canon() never invents. What it fixes is a name the
       site already knows under another form.) */
    const spelt = applyEdits(row, {
      institution: 'UC Berkeley',
      school: 'Haas School of Business',
      unit: 'Operations and Information Technology Management Department',
    });
    eq(spelt.institution, 'University of California, Berkeley',
      'an edited university is put into the spelling the site publishes');
    eq(spelt.school, 'Walter A. Haas School of Business',
      'and so is the school');
    eq(spelt.unit, 'Operations and Information Technology Management',
      'and the department keeps its bare field name');
    eq(spelt.department,
      'Walter A. Haas School of Business, Operations and Information Technology Management',
      'with the line rebuilt from the two of them');
  }

  /* A QUEUED POSTING IS NOT PUBLIC, which is the whole reason the queue is a
     Firestore collection rather than a file under data/. Everything in data/
     is served to anyone who asks. */
  ok(/match \/jobReviews\/\{id\}[\s\S]*?allow read: if isAdmin\(\)/.test(rules),
    'jobReviews is admin-read — a queued posting is not public');
  ok(!existsSync(path.join(HERE, '..', 'data', 'jobreviews.json')),
    'and no queue file is committed under data/, which is world-readable');

  const sync = await readFile(path.join(HERE, 'sync-jobmarket-sheet.mjs'), 'utf8');
  ok(sync.includes('partition('), 'the sheet sync applies the review gate');
  ok(sync.includes('rows = existing'),
    'and an unreachable queue leaves the published file exactly as it is — ' +
    'publishing everything would defeat the gate, publishing nothing would ' +
    'delete every posting on the site');
  ok(sync.includes('sheetRows'),
    'staleness is measured on the WHOLE sheet, not the approved subset, so a ' +
    'busy workbook with a full queue is not reported as gone quiet');

  /* A posting under review is not in the APPROVED file, so dating rows
     against that file alone would re-date every queued posting every morning —
     and once the file is empty, which is the state the gate starts in, every
     row would read as new on every run. The queue's own copy of the row is the
     other half of "already known". */
  ok(/const known = existing\.concat\(/.test(sync),
    'rows are dated against the published file AND the review queue');
  ok(sync.indexOf('const queue = await loadReviewQueue();') < sync.indexOf('stampAddedAt('),
    'which means the queue is read before the rows are dated');

  const build = await readFile(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(build.includes("where('status', '==', 'approved')"),
    'the build publishes an approval without waiting for the next sheet read');
  ok(/if \(byId\.has\(v\.row\.id\)\) continue;/.test(build),
    'and only ADDS a row the sheet file does not carry yet — the document\'s row is ' +
    'a snapshot frozen at approval, and replacing the file\'s fresher copy with it ' +
    'is what served five postings a mis-parsed country for weeks');

  /* THE GATE NEEDS A DATABASE, AND ITS WORKFLOW MUST GIVE IT ONE.
     Shipped without either of these and the first run said so and did nothing:
     `firestore()` returns null with no credentials OR no firebase-admin, the
     sync falls back to leaving the published file exactly as it is, and the
     result is a review queue that is never filled and postings that are never
     withheld — a feature that looks installed and is inert. Both halves are
     pinned because each alone is enough to cause it. */
  const sheetWf = await readFile(
    path.join(HERE, '..', '.github', 'workflows', 'oa-jobmarket-sheet.yml'), 'utf8');
  ok(/FIREBASE_SERVICE_ACCOUNT:\s*\$\{\{\s*secrets\.FIREBASE_SERVICE_ACCOUNT/.test(sheetWf),
    'the sheet sync is given the credentials the review queue needs');
  ok(/npm install[^\n]*firebase-admin/.test(sheetWf),
    'and the client it reads the queue with — without it the gate silently no-ops');

  const buildWf = await readFile(
    path.join(HERE, '..', '.github', 'workflows', 'oa-jobs-build.yml'), 'utf8');
  ok(/FIREBASE_SERVICE_ACCOUNT:\s*\$\{\{\s*secrets\.FIREBASE_SERVICE_ACCOUNT/.test(buildWf),
    'and so is the build, which is what publishes an approval');
  ok(/npm install[^\n]*firebase-admin/.test(buildWf),
    'with the same client');

  /* WHICH ROLE EACH RUN IS IN. A workflow that writes data/ commits nothing on
     a red selftest, so every selftest it runs — the precondition as well as
     the re-check — must be in the publishing role, where a tidiness finding is
     reported instead of stopping the site's data. The PR check is the one that
     must NOT be, because that is where a naming duplicate is meant to be
     caught and fixed. Pinned in both directions: the flag missing from a
     writer is the outage this file records, and the flag CREEPING INTO the PR
     check would leave nothing enforcing it anywhere. */
  const WRITERS = ['oa-jobs-build.yml', 'oa-jobmarket-sheet.yml', 'oa-higheredjobs-verify.yml',
    'oa-adverts-verify.yml', 'oa-jobs-sheet-sync.yml', 'oa-legacy-import.yml'];
  for (const name of WRITERS) {
    const src = await readFile(path.join(HERE, '..', '.github', 'workflows', name), 'utf8');
    const runs = [...src.matchAll(/node _scraper\/selftest\.mjs([^\n]*)/g)].map((m) => m[1]);
    ok(runs.length > 0, `${name} re-checks what it is about to commit`);
    ok(runs.every((rest) => rest.includes('--publishing')),
      `and does it in the publishing role, where a naming duplicate cannot stop the site`);
  }
  const prCheck = await readFile(
    path.join(HERE, '..', '.github', 'workflows', 'oa-checks.yml'), 'utf8');
  ok(/node _scraper\/selftest\.mjs\s*$/m.test(prCheck),
    'while the PR check runs it strict — the one place a naming duplicate is meant to fail');

  const wf = await readFile(
    path.join(HERE, '..', '.github', 'workflows', 'oa-jobreview-mail.yml'), 'utf8');
  ok(wf.includes('jobreview-mailer.mjs'), 'the workflow runs the mailer');
  ok(wf.includes('--selftest'), 'and checks it offline first');

  /* The review queue lives on the ADMIN AREA now (owner, 2026-08-21): a
     dedicated page for everything waiting on the maintainer, instead of admin
     panels stacked on top of the public feedback form. The promotion rule
     applies — the work is the move AND the sweep, so the old host is pinned
     to be clean of it. */
  const html = await readFile(path.join(HERE, '..', 'admin-area.html'), 'utf8');
  ok(html.includes('id="oa-review"'), 'the Admin area carries the review panel');
  ok(html.includes('oa-jobreview.js'), 'and loads the script that fills it');
  ok(html.indexOf('id="oa-review"') < html.indexOf('id="oa-inbox"'),
    'with the queue ABOVE the feedback inbox — a posting that is not on the ' +
    'site yet is the thing most worth doing first');
  ok(panel.includes('OAAccounts.isAdmin()'), 'the panel is drawn for the maintainer only');

  const fb = await readFile(path.join(HERE, '..', 'feedback.html'), 'utf8');
  ok(!fb.includes('id="oa-review"') && !fb.includes('id="oa-inbox"')
     && !fb.includes('oa-jobreview.js'),
    'and feedback.html is SWEPT of the admin panels — left in place, the same ' +
    'queue would be served from two pages and drift');

  const mailer = await readFile(path.join(HERE, 'jobreview-mailer.mjs'), 'utf8');
  ok(mailer.includes("site + '/admin-area'") && !mailer.includes("site + '/feedback'"),
    'the review e-mail points at the Admin area, not at the page the queue left');

  /* THE DOCUMENT AND THE RULES, PINNED BOTH WAYS — the news gate's own
     discipline, applied here: a key the module writes with no rule is a
     permission-denied at save time, and a rule with no key is a door nobody
     documented. The FIRST hasOnly list in the block is the document's; the
     second is the edits map's, pinned against EDITABLE above. */
  const docList = new Set(
    (block.slice(block.indexOf('hasOnly(['), block.indexOf('])', block.indexOf('hasOnly([')))
      .match(/'[a-zA-Z]+'/g) || []).map((s) => s.slice(1, -1)));
  eq([...docList].sort(), [...DOC_KEYS].sort(),
    'every key a jobReviews document may carry has a rule, and no rule allows a key ' +
    'the module does not know');

  /* THE DUPLICATE FLAGS REACH EVERY PLACE THE DECISION IS MADE. The sync
     computes them (the only writer), the card raises them where Approve and
     Reject are pressed, and the e-mail — the other place an approval is
     decided from — says the same thing. */
  ok(sync.includes('duplicatesOf('),
    'the sheet sync checks every queued posting against the site for duplicates');
  ok(sync.includes('sameDups('),
    'and re-checks pending ones without rewriting a flag that has not moved');
  ok(panel.includes('data-dup') && panel.includes('doc.dup'),
    'the review card raises a stored duplicate flag where the decision is made');
  ok(panel.includes('oa-note is-warn'),
    'as a warning panel that names its own colours, per the theme rules');
  ok(mailer.includes('Possibly already on the site'),
    'and the review e-mail warns about it too');

  /* THE BUSINESS-SCHOOL FLAG REACHES THE SAME PLACES, the same way (owner,
     2026-08-23): the sync computes it against the site's own vocabulary, the
     card mentions the school the directory knows beside a Use-it fill, and
     the e-mail says it where the decision is asked for. */
  ok(sync.includes('businessCheck('),
    'the sheet sync checks every queued posting for business-school evidence');
  ok(sync.includes('sameBiz('),
    'and re-checks pending ones without rewriting a flag that has not moved');
  ok(panel.includes('data-biz') && panel.includes('doc.biz'),
    'the review card mentions the business school the site knows, where the decision is made');
  ok(panel.includes('data-biz-use'),
    'with a Use-it button that fills the School box — an edit the maintainer still saves');
  ok(mailer.includes('Business school posting'),
    'and the review e-mail mentions it too');

  /* TWO SOURCES, ONE PANEL (owner, 2026-08-23). The crawled queue's cards are
     the gate; a "User-added jobs" tab beside them lists the postings made
     through the site's own form — the submissions model's documents, read
     with its LIVE pair and ticked off with its reviewedAt stamp, which
     testSubmissionNotices pins kind by kind. Here: the tabs exist, the page
     mounts them beside the market-year tabs it keeps, and one comparator
     ranks the NEXT market first in every tab. */
  ok(panel.includes('data-source') && panel.includes('Auto-crawled jobs')
     && panel.includes('User-added jobs'),
    'the panel splits by source — the crawled gate and the user-added to-do list');
  ok(html.includes('id="oa-review-sources"') && html.includes('id="oa-review-years"'),
    'and the page mounts the source tabs beside the market-year tabs it keeps');
  ok(panel.includes('function rankBy') && panel.includes('rankBy(SOURCES.crawled)')
     && panel.includes('rankBy(SOURCES.user)'),
    'one comparator ranks both tabs, the next market first');
  ok((panel.match(/data-act="approve"|data-act="reject"/g) || []).length > 0
     && !/userCardHtml[\s\S]*?data-act="approve"/.test(panel.slice(panel.indexOf('function userCardHtml'), panel.indexOf('function render(') )),
    'a user-added card offers no Approve — the posting is already live, there is nothing to gate');
}

/* --------------------------------------------------------- the Admin area

   One page for everything waiting on the maintainer (owner, 2026-08-21):
   job postings held for approval, candidate profiles — including the ones
   held back until the reveal, which the front page counted ("2 profiles have
   already been filed") while the maintainer had no way to SEE them — the
   feedback inbox, and updates awaiting publication. These pins hold the page
   to the properties that make it safe and honest, not to its wording. */

async function testAdminArea() {
  const page = await readFile(path.join(HERE, '..', 'admin-area.html'), 'utf8');
  const js = await readFile(path.join(HERE, '..', 'assets', 'oa-adminarea.js'), 'utf8');
  const acct = await readFile(path.join(HERE, '..', 'assets', 'oa-accounts.js'), 'utf8');
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');

  /* the page: maintainer-only, never indexed, never shared */
  ok(/name="robots" content="noindex,nofollow"/.test(page),
    'admin-area.html is noindex — the review desk is not a page to find');
  ok(page.includes('id="oa-aa-guest"') && !page.includes('property="og:'),
    'it explains itself to a stranger and carries no og:* identity to steal');

  /* all four queues, in to-do order: what is not on the site yet first */
  for (const id of ['oa-review', 'oa-aa-cands', 'oa-inbox', 'oa-aa-news']) {
    ok(page.includes(`id="${id}"`), `admin-area.html carries #${id}`);
  }
  ok(page.indexOf('id="oa-review"') < page.indexOf('id="oa-aa-cands"')
     && page.indexOf('id="oa-aa-cands"') < page.indexOf('id="oa-inbox"'),
    'postings to review, then held profiles, then feedback — the two queues ' +
    'that gate publication come before the one that does not');
  for (const src of ['oa-news.js', 'oa-jobreview.js', 'oa-feedback.js', 'oa-adminarea.js']) {
    ok(page.includes(`assets/${src}`), `and loads ${src}`);
  }

  /* the module: drawn for the admin alone, counting news THROUGH the module */
  ok(js.includes('OAAccounts.isAdmin()'),
    'oa-adminarea.js shows the desk to the maintainer only — the rules stay ' +
    'the authorisation');
  ok(/OANews\.partition\(/.test(js) && !/REVIEW_FROM\s*=/.test(js),
    'the pending-updates share is decided through OANews.partition, never a ' +
    'second reading of the review gate');
  ok(/\/\^https\?:\\\/\\\//.test(js) || js.includes('^https?:'),
    'a submitted link is host-checked before it becomes an href — this panel ' +
    'renders documents nobody has vetted');
  ok(js.includes('known ? total : null'),
    'a count where NOTHING answered is unknown, never a 0 \u2014 a fabricated zero ' +
    'would overwrite a cached badge that was honest (the menu-count rule)');
  ok(js.includes("'/data/candidates-meta.json'"),
    'the held-profiles number is read from the SAME file the front page ' +
    'announces "N profiles have already been filed" from, so the two agree');

  /* the Registered-users card (owner, 2026-08-23): a statistic beside the
     queues, and NEVER in the badge — the badge counts what is waiting, and a
     figure nobody can clear would inflate it for ever */
  ok(/collection\(OAFB\.col\.registered\)/.test(js),
    'the Registered-users card counts the registeredUsers tally — the marks ' +
    'every sign-in writes and the account merge retires');
  ok(js.includes("['jobs', 'candidates', 'feedback', 'news', 'names']"),
    'the badge sums exactly the five queues — the registered-user statistic ' +
    'is beside them, never among them');
  ok(!/r\[5\]|users:\s*r\[/.test(js.slice(js.indexOf('function pendingCounts'),
      js.indexOf('the summary strip'))),
    'pendingCounts stays the five queues — every page’s badge refresh must ' +
    'not pay a read for a number only the admin page shows');
  ok(/match \/registeredUsers\/\{uid\}[\s\S]*?allow read: if isAdmin\(\);/.test(rules),
    'registeredUsers is admin-read — the figure is the maintainer’s, not the ' +
    'public’s (owner, 2026-08-23), and nothing public ever consumed it');
  ok(/match \/registeredUsers\/\{uid\}[\s\S]*?allow delete: if isOwner\(uid\);/.test(rules),
    'and an account can still withdraw its OWN mark — the delete the merge ' +
    'depends on, so two merged profiles count as one person');

  /* the menu row goes where the page is */
  ok(/href="admin-area\.html"/.test(acct),
    'the account menu links the Admin area');

  /* the reads this page depends on are already allowed — no rules change
     rode along, which is worth pinning because an edit here that needed one
     would ship a panel that says permission-denied */
  ok(/match \/candidateSubmissions\/\{id\}[\s\S]*?allow read: if isOwner\(resource\.data\.uid\) \|\| isAdmin\(\);/.test(rules),
    'candidateSubmissions is admin-read — held profiles are the admin\u2019s to see');
  ok(/match \/feedback\/\{id\}[\s\S]*?allow read, update, delete: if isAdmin\(\);/.test(rules),
    'and the feedback inbox stays admin-read');

  /* the reveal grouping is the build's own semantics: before the date every
     queued profile is held, from the day itself queued means published */
  const fn = /function candGroupOf[\s\S]*?\n  }/.exec(js);
  ok(fn, 'candGroupOf is present');
  if (fn) {
    /* eslint-disable-next-line no-new-func */
    const candGroupOf = new Function('return (' + fn[0] + ')')();
    eq(candGroupOf({ status: 'queued' }, '2026-10-11', '2026-08-23'), 'held',
      'a queued profile before the reveal is HELD');
    eq(candGroupOf({ status: 'queued' }, '2026-10-11', '2026-10-11'), 'live',
      'and on the reveal day itself it is live — the same >= the page uses');
    eq(candGroupOf({ status: 'withdrawn' }, '2026-10-11', '2026-08-23'), 'withdrawn',
      'a withdrawal stays the candidate\u2019s own whatever the date');
    eq(candGroupOf({ status: 'hidden' }, '', '2026-08-23'), 'hidden',
      'and a takedown stays the maintainer\u2019s');
    eq(candGroupOf({}, '', '2026-08-23'), 'held',
      'no reveal date announced means EVERYTHING is held \u2014 the build\u2019s own ' +
      'revealGate (candidates-model.mjs) publishes nothing until a date is set');
    eq(candGroupOf({}, 'soon', '2026-08-23'), 'held',
      'and a malformed date holds too \u2014 the typo revealGate exists to survive ' +
      'must not read as \u201ceverything is public\u201d here');
  }
}

/* ------------------------------- what was posted through the site's own forms

   TWO QUEUES REACH THE MAINTAINER AND ONLY ONE OF THEM EVER SAID ANYTHING.
   The tracking sheet's postings are held and announced; a posting or a
   candidate profile made through the site's own forms went into Firestore, was
   published by the next build, and nothing told anybody. For candidates that
   was the worse half: their profiles are held behind the reveal date, so they
   reach no served file, draw no card anywhere on the site, and there was no
   screen that could show them at all.                                        */

async function testSubmissionNotices() {
  const read = async (f) => readFile(path.join(HERE, '..', f), 'utf8');
  const model = await read('_scraper/submissions-review.mjs');
  const mailer = await read('_scraper/submissions-mailer.mjs');
  const panel = await read('assets/oa-submissions.js');
  /* the Admin area, not feedback.html: the panel moved there with every
     other review surface, and feedback.html is pinned CLEAN of them */
  const html = await read('admin-area.html');

  /* The model and the browser panels have to agree about WHAT they are
     looking at and WHERE the bookkeeping is written, or a card ticked off in
     one is still announced by the other.

     ONE SURFACE PER KIND (owner, 2026-08-23): the user-added JOB half is
     drawn by the review panel's own "User-added jobs" tab now
     (assets/oa-jobreview.js), beside the crawled queue it belongs with; this
     panel keeps the candidate profiles. A second surface for one queue is
     the drift these modules exist to prevent, so the split is pinned BOTH
     ways — each kind has its panel, and the job kind is really gone from
     this one. */
  const jobPanel = await read('assets/oa-jobreview.js');
  for (const kind of SUB_KINDS) {
    const host = kind.key === 'job' ? jobPanel : panel;
    const name = kind.key === 'job' ? 'the review panel’s user-added tab'
      : 'the submissions panel';
    ok(host.includes(`'${kind.collection}'`),
      `${name} reads ${kind.collection}, the same collection the mailer announces`);
    ok(host.includes(kind.editPath),
      `and opens a ${kind.one} on the same form`);
    ok(mailer.includes('KINDS'), 'and the mailer takes its kinds from the model');
  }
  ok(!panel.includes(`'jobSubmissions'`),
    'the submissions panel no longer draws the job half — one queue, one surface');
  for (const [file, who] of [[panel, 'the submissions panel'],
    [jobPanel, 'the review panel’s user-added tab']]) {
    ok(file.includes(`var REVIEWED_AT = '${SUB_REVIEWED_AT}';`),
      `${who} stamps the field the model names`);
    ok(!new RegExp(`['"\`]${SUB_ANNOUNCED_AT}['"\`]\\s*\\]?\\s*[:=]`).test(file)
       && !file.includes(`'${SUB_ANNOUNCED_AT}'`),
      `${who} never writes the mailer's high-water mark`);
  }
  ok(jobPanel.includes(`var LIVE = ['queued', 'published'];`),
    'and the user-added tab lists the same LIVE pair the model reads');
  ok(model.includes(`export const ANNOUNCED_AT = '${SUB_ANNOUNCED_AT}';`),
    'the mailer stamps its own mark, so a tick and an announcement never overwrite each other');

  /* NO RULES CHANGE. Both collections are already admin-read and admin-write,
     which is what let this ship without a manual `firebase deploy` — a feature
     that needs one looks installed and is inert until somebody remembers. */
  const rules = await read('_firestore.rules');
  for (const kind of SUB_KINDS) {
    const block = rules.slice(rules.indexOf(`match /${kind.collection}/`));
    ok(/allow read: if isOwner\(resource\.data\.uid\) \|\| isAdmin\(\);/.test(block),
      `${kind.collection} is readable by the maintainer`);
    ok(/allow write: if isAdmin\(\);/.test(block),
      `and writable by them, so "mark reviewed" needs no new rule`);
  }

  /* IT IS NOT A GATE, and the copy has to say so. A posting made through the
     form is live within a minute because the form promises as much; telling
     the maintainer it is waiting on them would be false. */
  ok(/already live/.test(mailer), 'the e-mail says a posting is already live');
  ok(/held until/i.test(mailer) && /held until/i.test(panel),
    'and that a candidate profile is held until the reveal date, which is why it ' +
    'is nowhere on the site');

  /* A withdrawn submission is not waiting for anything, and a tracking-sheet
     mirror has its own queue directly above this panel. */
  ok(model.includes("const LIVE = ['queued', 'published'];"),
    'only live submissions are listed');
  ok(model.includes('doc.status === MIRROR_STATUS'),
    'and a tracking-sheet mirror is never one of them — it has its own queue');

  ok(html.includes('id="oa-subs"'), 'the Admin area carries the panel');
  ok(html.includes('oa-submissions.js'), 'and loads the script that fills it');
  ok(html.indexOf('id="oa-review"') < html.indexOf('id="oa-subs"'),
    'below the approval queue, which is the one thing that is actually blocked on them');
  ok(panel.includes('OAAccounts.isAdmin()'), 'and it is drawn for the maintainer only');

  const wf = await read('.github/workflows/oa-submissions-mail.yml');
  ok(wf.includes('submissions-mailer.mjs'), 'the workflow runs the mailer');
  ok(wf.includes('--selftest'), 'and checks it offline first');
  ok(/permissions:\s*\n\s*contents: read/.test(wf), 'a mailer commits nothing');
  ok(/group: oa-submissions-mail-/.test(wf),
    'and has its own concurrency group — it must never queue behind a data build');
  /* Every quarter of an hour, and never on the review mailer's own minutes. */
  const mine = (wf.match(/cron: '([^']+)'/) || [])[1] || '';
  const theirs = (await read('.github/workflows/oa-jobreview-mail.yml'))
    .match(/cron: '([^']+)'/)[1];
  ok(mine && mine !== theirs,
    'and does not fire on the same minutes as the review mailer');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testSanitisers();
  testMapping();
  testOwnershipAndPending();
  testMerge();
  testMarketYear();
  testVocab();
  await testFurtherInfoLink();
  testNamesForTheCascade();
  await testCascadeWiring();
  await testRenamedNamesStillFound();
  await testAccountCounts();
  await testEveryDatasetNamesPlacesTheSameWay();
  await testNoDuplicateKeys();
  await testScopedUnits();
  await testInstitutionSeed();
  await testFormsOfferVocab();
  await testPickerTheme();
  await testVocabFile();
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
  testJobMarketSheetMislabelledHeader();
  testJobMarketSheetTabCycle();
  testJobMarketSheetStaleness();
  await testJobMarketSheetChain();
  await testDeployGuard();
  await testRowOverrides();
  await testNewsReview();
  await testNameFixes();
  await testAdminArea();
  await testRemovalSafety();
  await testMirrorLifecycle();
  await testRefLessTakedown();
  await testSheetMirrors();
  await testJobMarketSheetWiring();
  testHigherEdJobsParsing();
  testHigherEdJobsApply();
  await testHigherEdJobsWiring();
  testAdvertsParsing();
  testAdvertsApply();
  await testAdvertsWiring();
  testReviewQueue();
  testReviewDuplicates();
  testReviewBusiness();
  testReviewEdits();
  await testReviewWiring();
  testTwoDeadlines();
  await testTwoDeadlinesWiring();
  await testSubmissionNotices();
  process.exit(finish() ? 0 : 1);
}
