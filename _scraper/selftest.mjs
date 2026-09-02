#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — offline checks for the job pipeline.

   No network, no credentials, no Firebase. Runs in CI on every push and is the
   thing that keeps the submission path, the migration path and the served file
   agreeing about what a row is.

       node v2/_scraper/selftest.mjs
   --------------------------------------------------------------------------- */

import { isMain } from './_main.mjs';
import { BUILDERS, plan } from './build-all.mjs';
import * as NETMAP from './build-netmap.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  text, url, day, slug, pickList, jobId, rowFromSubmission, mergeRows,
  universitiesLink, ownUniversitiesLink,
  buildMeta, serialise, publicRow, displayOrder, longDate,
  marketYear, marketLabel, marketFloor, collapseSameDay, MARKET_WINDOW, MARKET_ROLL_MONTH,
  marketYearOf, marketYearAtLeast, marketYearReview, MARKET_YEAR_SOURCE,
  marketYearsOf, withMarketYears, MARKET_SPAN_MAX,
  submissionFromRow, composeApplyBy, assignIds, inCurrentMarket, deadlineOpen, marketStart,
  diffRows, collectChanges, renderChangesHtml,
  MIRROR_STATUS, sheetMirrorDoc, mirrorDiffers, unclaimedSheetRows, sheetHandover,
  removalSpecs, buildOwned, ownerTag, specMatches, healPlace,
  parseProseDay, extractReviewDate, extractFinalDate, healReviewDate,
  PUBLIC_FIELDS, LEVELS, CHARACTERISTICS, TYPES,
  stripEmails, stripRowEmails, patchDeadlines, canonColumns,
  postedBy, contactEmail, sourceLabel, CRAWLER_SOURCES, FORM_SOURCE,
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
  levelsFromRank, typeFromNames, rowsFromTab, collectRows, carryUnreadColumns,
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
  adBlock, sameAdInfo, queueNeedsFetch, advertPlace, advertHostsReport,
  DEADLINE_LABELS as ADVERT_DEADLINE_LABELS, LISTING_END_LABELS,
} from './adverts.mjs';
import {
  COLLECTION as REVIEW_COL, EDITABLE, SHOWN, DOC_KEYS, PENDING, APPROVED, REJECTED,
  queueDoc, refreshQueued, cleanEdit, cleanEdits, applyEdits, partition,
  needMail, changedKeys, approvedRow, duplicatesOf, sameDups, businessCheck, sameBiz,
  advertRepeat, findAdvertRepeats, repeatNote,
} from './jobreview.mjs';
import {
  KINDS as SUB_KINDS, ANNOUNCED_AT as SUB_ANNOUNCED_AT,
  REVIEWED_AT as SUB_REVIEWED_AT, LIVE_MAILED_AT as SUB_LIVE_MAILED_AT,
  LIVE_SINCE as SUB_LIVE_SINCE, SINCE as SUB_SINCE,
  partitionSubmissions, partitionLive, servedIndex, matchServed,
  isWaiting, createdDay,
} from './submissions-review.mjs';
import { safeName, driveFileName, explain, multipartBody } from './drive-upload.mjs';
import { unzipStore, sheetCells, lastRow } from './_xlsx-read.mjs';

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

  /* A SUBMISSION WITH NO YEAR OF ITS OWN IS FILED BY ITS DEADLINE, not by the
     day the build happened to run (owner, 2026-08-26). GOOD closes on
     2025-11-30, so it is a 2025-2026 posting however long it sits unbuilt —
     the old rule stamped it with `now` and made the answer depend on when the
     pipeline last ran. */
  const now26 = { now: new Date('2026-08-15T00:00:00Z') };
  const r = rowFromSubmission({ ...GOOD, year: undefined }, now26);
  eq(r.year, 2026, 'an unyeared submission is filed by its final apply-by date');

  eq(rowFromSubmission({ ...GOOD, year: undefined, applyByDate: '', untilFilled: true,
    reviewDate: '2026-09-08' }, now26).year, 2027,
    'no final date: the SUGGESTED apply-by decides — step 2 of the cascade');
  eq(rowFromSubmission({ ...GOOD, year: undefined, applyByDate: '', untilFilled: true,
    reviewDate: '' }, now26).year, 2026,
    'neither date: the posting date decides — step 3, where this used to start ' +
    '(GOOD was stored 2025-08-14, so an "until filled" search from then is 2025-2026)');
  eq(rowFromSubmission({ ...GOOD, applyByDate: '2026-09-08' }, now26).year, 2026,
    'a STORED year still wins outright: it is half the row id, and a row whose ' +
    'id moves is published twice (marketYearOf\'s header). The disagreement is ' +
    'reported by marketYearReview instead.');
}

async function testPageHeadingRule() {
  const html = await readFile(path.join(HERE, '..', 'jobs.html'), 'utf8');

  /* The page no longer carries the roll rule; it reads it, from
     assets/oa-jobnav.js, which testJobNavModule() pins against marketYear()
     and inCurrentMarket() themselves. A copy of a rule on a page this suite
     cannot execute is the copy that drifts, so the fix is to delete the copy
     rather than to keep pinning it. */
  ok(/var NAV = window\.OAJobNav;/.test(html) && /NAV\.marketYear\(\)/.test(html),
    'jobs.html derives the heading year from the shared market rule');
  ok(!/getUTCMonth\(\)/.test(html),
    'and carries no copy of the roll month of its own');

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
  /* jobs.html filters the list to the current market year — through the
     SHARED rule (assets/oa-jobnav.js), not a copy of its own. See
     testJobNavModule(), which pins that module against the two functions
     below over every posting the site serves. */
  const jobsHtml = await readFile(path.join(HERE, '..', 'jobs.html'), 'utf8');
  ok(/function inCurrentMarket\(row\) \{ return NAV\.inCurrentMarket\(row\); \}/.test(jobsHtml),
    'jobs.html filters the list to the current market year, through the shared rule');
  ok(!jobsHtml.includes("'-07-01'"),
    'and writes the roll day down nowhere of its own');
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

  /* THE LIVE PAGES READ THE RULE; THEY DO NOT CARRY IT. The three that filter
     by season — jobs.html, previous-markets.html and the one-pager's jobs
     teaser — had a byte-identical copy of marketYear() and inCurrentMarket()
     each, and /admin-area's market-year report needed a fourth to say WHICH
     page a flagged posting is on. Four copies of one answer is what
     oa-countries.js, oa-schools.js and oa-news.js all exist to prevent, so
     there is one now and the pages read it. */
  for (const [rel, html] of [
    ['jobs.html', jobsHtml],
    ['previous-markets.html', pastHtml],
    ['index.html', await readFile(path.join(HERE, '..', 'index.html'), 'utf8')],
  ]) {
    ok(html.includes('assets/oa-jobnav.js'), `${rel}: loads the shared market rule`);
    ok(/function inCurrentMarket\(row\) \{ return NAV\.inCurrentMarket\(row\); \}/.test(html),
      `${rel}: and filters through it rather than through a copy`);
    ok(!/var deadline = String\(row\.applyByDate \|\| ''\);/.test(html),
      `${rel}: so the deadline leg is written down here nowhere`);
  }
  /* The 2026 design ARCHIVED at /v2/ keeps its own frozen assets, by the rule
     the three trees are held to — so its pages keep their inline copies, and
     those are still pinned. */
  for (const rel of ['v2/jobs.html', 'v2/previous-markets.html']) {
    const html = await readFile(path.join(HERE, '..', ...rel.split('/')), 'utf8');
    ok(/var deadline = String\(row\.applyByDate \|\| ''\);/.test(html) &&
       /deadline >= (?:d|new Date\(\))\.toISOString\(\)\.slice\(0, 10\)/.test(html),
      `${rel}: the archive's frozen copy carries the deadline leg, like the model`);
  }

  /* The candidates list mirrors the same two inline rules the jobs list does —
     the derived heading season and the current-market filter. It is a SECTION
     of the one-pager on the live site and a page of its own in the archive;
     both copies are pinned. */
  {
    const candHtml = await readFile(path.join(HERE, '..', 'index.html'), 'utf8');
    ok(/function marketLabel\(\) \{ return NAV\.marketLabel\(NAV\.marketYear\(\)\); \}/.test(candHtml),
      'index.html: the candidates list derives its season from the shared rule');
    ok(/function inCurrentMarket\(row\) \{ return NAV\.inCurrentMarket\(row\); \}/.test(candHtml),
      'index.html: and filters to the current market through it');
  }
  {
    const candHtml = await readFile(path.join(HERE, '..', 'v2', 'candidates.html'), 'utf8');
    ok(/getUTCMonth\(\)\s*>=\s*6/.test(candHtml),
      'v2/candidates.html: the archive derives its season with the July roll');
    ok(/function inCurrentMarket\(row\)/.test(candHtml) && candHtml.includes("'-07-01'"),
      "v2/candidates.html: and filters with the model's own rule");
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
  for (const f of ['lastSentAt', 'lastJobAt', 'lastCheckedAt', 'lastUpdateDate',
    'lastCandidateAt', 'criteria', 'enabled']) {
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

/* ------------------------------------------ which season a posting is FOR

   THE DEADLINE, NOT THE DAY IT WENT UP (owner, 2026-08-26): "the Final apply
   by deadline should be the key date that determines the job market year a
   job posting belongs to … if that field is Until filled, then check the date
   in Suggested apply by … if both fail, then check the posting date."

   AND THE SEASONS OVERLAP, so a posting can be in two at once (owner,
   2026-08-27): "a school advertising in May for a search that closes in
   September should be posted in the current job market year immediately
   public on the website AND also continue to be shown for the next job market
   year, since there is overlap between the two years."

   Four things are pinned here, and the last is the one that keeps the site
   publishing: the cascade itself, that it only ever moves a posting FORWARD,
   the SPAN each posting is listed under, and that a posting already published
   is REPORTED rather than re-filed to get any of it. */

async function testMarketYearCascade() {
  const now = new Date('2026-08-26T12:00:00Z');
  const served = JSON.parse(await readFile(JOBS, 'utf8'));

  // 1. the cascade, in the owner's own order
  eq(marketYearOf({ applyByDate: '2026-10-15', reviewDate: '2026-09-08', posted: '2026-05-01' }, { now }),
    { year: 2027, from: 'final' },
    'the FINAL apply-by decides, over both the suggested date and the posting date');
  eq(marketYearOf({ applyByDate: '', reviewDate: '2026-09-08', posted: '2026-05-01' }, { now }),
    { year: 2027, from: 'review' },
    '"Until filled" is an EMPTY final date, so step 2 reads the suggested one');
  eq(marketYearOf({ applyByDate: '', reviewDate: '', posted: '2026-05-01' }, { now }),
    { year: 2026, from: 'posted' },
    'neither date: the posting date, which is where this rule used to start');
  eq(marketYearOf({}, { now }).year, marketYear(now),
    'and a row with no date at all falls back to the season under way');

  // the roll itself is the shared one — 1 July, numbered by the year it ends
  eq(marketYearOf({ applyByDate: '2026-06-30' }, { now }).year, 2026,
    '30 June closes the season it is in');
  eq(marketYearOf({ applyByDate: '2026-07-01' }, { now }).year, 2027,
    'and 1 July opens the next one, the same roll marketYear() applies');

  /* THE CASE THE OWNER DESCRIBED, end to end: a school advertising in May for
     a search that closes in September. By its posting date it filed under the
     season that had just closed — the one page it is of no use on. */
  eq(marketYearOf({ applyByDate: '2026-09-08', posted: '2026-05-04' }, { now }),
    { year: 2027, from: 'final' },
    'advertised in May, closing in September: a 2026-2027 posting');

  // 2. forward only — the whole safety argument for applying it at ingest
  for (const r of served) {
    const posted = String(r.posted || '');
    if (!posted) continue;
    ok(marketYearOf(r, { now }).year >= marketYear(new Date(posted + 'T12:00:00Z')),
      `${r.id}: the cascade never files a posting EARLIER than its posting date`);
  }
  eq(marketYearAtLeast({ applyByDate: '2026-09-08' }, 2028).year, 2028,
    'a floor above the cascade wins — the tracking sheet tab keeps its say');
  eq(marketYearAtLeast({ applyByDate: '2026-09-08' }, 2028).from, 'floor',
    'and says so, so a report can name what decided');
  eq(marketYearAtLeast({ applyByDate: '2026-09-08' }, 2026).year, 2027,
    'a floor BELOW it never pulls a posting back into a closed season');
  eq(marketYearAtLeast({ applyByDate: '2026-09-08' }, 0).year, 2027,
    'and no floor at all is the bare cascade');

  /* 3. what is already published is REPORTED, never moved. `year` is half a
     row's `id` (jobId), `keyOf` keys a ref-less row by that id, and mergeRows
     therefore could not match a row whose season changed: the old one is
     carried on as an orphan beside the new and the posting is published
     TWICE. So rowFromSubmission honours a stored year outright. */
  const doc = { institution: 'Test University', department: 'Operations Management',
    country: 'United States', type: 'University', levels: ['Assistant Professor'],
    createdAt: new Date('2026-05-04T09:00:00Z'), applyByDate: '2026-09-08' };
  eq(rowFromSubmission({ ...doc, year: 2026 }, { now }).year, 2026,
    'a stored season is kept, whatever the dates now say');
  eq(rowFromSubmission(doc, { now }).year, 2027,
    'a document with NO season is filed by the cascade');
  eq(rowFromSubmission({ ...doc, year: 1200 }, { now }).year, 2027,
    'and so is one whose stored season is out of the range the rules allow');

  const flagged = marketYearReview([
    { id: 'a', year: 2026, posted: '2026-07-28', applyByDate: '2026-10-15' },
    { id: 'b', year: 2027, posted: '2026-07-28', applyByDate: '2026-10-15' },
    { id: 'c', year: 2028, posted: '2026-08-06', reviewDate: '2026-09-08' },
    { id: 'd', posted: '2026-07-28', applyByDate: '2026-10-15' },
  ], { now });
  eq(flagged.map((f) => f.id), ['a'],
    'only a posting filed BEHIND its own dates is reported: one already right ' +
    'is silent, one AHEAD is the tab cycle doing its job, and one with no ' +
    'stored season is not a disagreement');
  eq(flagged[0].stored, 2026, 'the report names the season it is filed under');
  eq(flagged[0].should, 2027, 'and the one its dates give it');
  eq(flagged[0].from, 'final', 'and which date decided, so the card can say why');
  ok(MARKET_YEAR_SOURCE[flagged[0].from],
    'every source the cascade can return has words for the report');
  for (const k of ['final', 'review', 'posted', 'floor']) {
    ok(MARKET_YEAR_SOURCE[k], `MARKET_YEAR_SOURCE covers "${k}"`);
  }
  /* …and the PANEL has words for every source the REPORT can carry. Its
     YEAR_FROM is deliberately three keys, not four: marketYearReview calls
     marketYearOf, never marketYearAtLeast, so `floor` cannot reach a card and
     a fourth entry would describe a state that does not exist. Switching the
     report to the floor-aware call would make the card read "its own dates"
     for those rows — silently — so the two are pinned to each other here. */
  const yfSrc = (await readFile(path.join(HERE, '..', 'assets', 'oa-adminarea.js'), 'utf8'));
  const yearFrom = yfSrc.slice(yfSrc.indexOf('var YEAR_FROM = {'),
    yfSrc.indexOf('};', yfSrc.indexOf('var YEAR_FROM = {')));
  const drawn = new Set((yearFrom.match(/^\s*(\w+):/gm) || [])
    .map((m) => m.trim().replace(':', '')));
  const reachable = new Set(marketYearReview(served, { now }).map((f) => f.from)
    .concat(['final', 'review', 'posted']));
  eq([...drawn].sort(), [...reachable].sort(),
    'the panel words exactly the sources the report can carry — both ways');

  // the season under way is what a reader is looking at, so it sorts first
  const order = marketYearReview([
    { id: 'old', year: 2025, posted: '2025-01-01', applyByDate: '2025-09-01' },
    { id: 'new', year: 2026, posted: '2026-07-28', applyByDate: '2026-10-15' },
  ], { now });
  eq(order.map((f) => f.id), ['new', 'old'],
    'the current season is reported first — those are the postings on the page today');

  /* Pure and deterministic: the build writes the file on its own diff, so a
     second pass over the same rows must produce the same list. */
  eq(JSON.stringify(marketYearReview(served, { now })),
    JSON.stringify(marketYearReview(served, { now })),
    'the report is deterministic, so an unchanged corpus commits nothing');

  /* 4. the served report, and what it may carry. Everything under data/ is
     public, so this file holds only what data/jobs.json already publishes. */
  const check = JSON.parse(await readFile(
    path.join(HERE, '..', 'data', 'jobs-yearcheck.json'), 'utf8'));
  ok(Array.isArray(check.postings), 'data/jobs-yearcheck.json lists postings');
  const KEYS = ['id', 'ref', 'institution', 'department', 'posted', 'applyByDate',
    'reviewDate', 'stored', 'should', 'from', 'current'];
  const byId = new Map(served.map((r) => [r.id, r]));
  for (const p of check.postings) {
    eq(Object.keys(p).sort(), KEYS.slice().sort(),
      `${p.id}: the report carries the pinned fields and nothing else`);
    ok(byId.has(p.id), `${p.id}: every reported posting is one the site publishes`);
    ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(JSON.stringify(p)),
      `${p.id}: nothing under data/ may carry an e-mail address`);
    ok(!/javascript:|data:text/i.test(JSON.stringify(p)),
      `${p.id}: nor a script URL — the panel renders this to the maintainer`);
    ok(p.should > p.stored, `${p.id}: reported only where the season should move FORWARD`);
  }

  // 5. the wiring — the build writes it, the panel draws it, neither counts it
  //    into the badge (a served-file read must not ride pendingCounts).
  const build = await readFile(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(/marketYearReview\(rows, \{ now \}\)/.test(build),
    'build-jobs reports over the rows it is about to WRITE, not the raw ones');
  ok(/jobs-yearcheck\.json/.test(build), 'and writes the report beside jobs.json');

  const panel = await readFile(path.join(HERE, '..', 'assets', 'oa-adminarea.js'), 'utf8');
  ok(/data\/jobs-yearcheck\.json/.test(panel), 'the Admin area reads that same file');
  ok(/lastYearCheck/.test(panel) && !/yearCheck: /.test(panel),
    'and paints its tile from its own read, never through pendingCounts');
  const counts = panel.slice(panel.indexOf('function pendingCounts'),
    panel.indexOf('function registeredCount'));
  ok(!/yearcheck/i.test(counts),
    'nothing in pendingCounts fetches it — that function runs on EVERY page ' +
    'for the account-menu badge, and a figure only this page shows must not ' +
    'make every page pay a read for it (the Registered-users rule)');

  const page = await readFile(path.join(HERE, '..', 'admin-area.html'), 'utf8');
  ok(/id="oa-aa-yc"/.test(page) && /id="oa-aa-yc-list"/.test(page),
    'admin-area.html carries the panel the renderer mounts into');
  ok(/Nothing has been moved/.test(page),
    'and says outright that nothing was re-filed behind the maintainer\'s back');
  /* …and that the panel does not leave the reader thinking a flagged posting
     is MISSING from the season its dates name. It is listed under both, and
     the card is the only place that could say so. */
  ok(/listed under both/i.test(page),
    'and that the posting it flags is listed under both seasons — the overlap');

  /* 6. THE OVERLAP. `year` names the season a posting is FOR; `years` names
     every season it is IN, which is what a reader browsing one of them wants
     and what the cascade alone could not say. */
  eq(marketYearsOf({ year: 2027, posted: '2026-05-04', applyByDate: '2026-09-08' }),
    [2026, 2027],
    'the owner\'s case: advertised in May, closing in September — the season ' +
    'under way AND the one that opens in July, not one or the other');
  eq(marketYearsOf({ year: 2026, posted: '2025-09-24', applyByDate: '2026-07-28' }),
    [2026, 2027],
    'and the other way round: a September search open past the roll is listed ' +
    'in the season that follows it too — which is what the report above now ' +
    'reports a disagreement about, rather than a posting to rescue');
  eq(marketYearsOf({ year: 2028, posted: '2026-08-06', reviewDate: '2026-09-08' }),
    [2027, 2028],
    'a tab-cycle floor ahead of the dates spans as readily as one behind them — ' +
    'the Kansas row is live now and is FOR the season after next');
  eq(marketYearsOf({ year: 2026, posted: '2025-10-01', applyByDate: '2025-11-30' }),
    [2026], 'an ordinary posting names one season, said once');
  eq(marketYearsOf({ year: 2020 }), [2020],
    'a row with no dates at all is listed under its stored season — NEVER ' +
    'today\'s, which is what marketYearOf\'s last-resort fallback would have ' +
    'made of a 2014 posting on every rebuild');
  eq(marketYearsOf({}), [], 'and a row that names no season at all claims none');
  eq(marketYearsOf({ year: 2026, posted: '2025-09-24', applyByDate: '2027-09-01' }),
    [2026, 2027, 2028],
    'the seasons BETWEEN are filled in: a search open across a whole year was ' +
    'open during it');
  eq(marketYearsOf({ year: 2000, posted: '2025-09-24', applyByDate: '2026-09-01' }),
    [2000, 2026, 2027],
    `a span wider than MARKET_SPAN_MAX (${MARKET_SPAN_MAX}) falls back to the ` +
    'years its own dates name rather than filling in a quarter-century');

  for (const r of served) {
    const ys = marketYearsOf(r);
    ok(ys.includes(Number(r.year)),
      `${r.id}: the span always contains the season the posting is filed under`);
    eq(ys.slice().sort((a, b) => a - b), ys, `${r.id}: ascending`);
    eq(ys.length, new Set(ys).size, `${r.id}: and each season named once`);
  }

  /* 7. `withMarketYears` is the ONE writer of the field, and is pure,
     idempotent and by-value — every ingest applies it and the build applies
     it again over the merged set, so a rebuild that changes nothing must
     produce a byte-identical file and commit nothing. */
  const spanned = withMarketYears({ year: 2027, posted: '2026-05-04', applyByDate: '2026-09-08' });
  eq(spanned.years, [2026, 2027], 'it writes the span it computed');
  eq(Object.keys(spanned).indexOf('years'), Object.keys(spanned).indexOf('year') + 1,
    'straight after `year`, so a diff of data/past-postings.json reads in order');
  eq(withMarketYears(spanned), spanned,
    'a row already carrying the right span comes back ITSELF, not a copy — ' +
    'which is what the build\'s change count and its e-mail read');
  eq(withMarketYears({ year: 2027, years: [2027], posted: '2026-05-04', applyByDate: '2026-09-08' }).years,
    [2026, 2027], 'and a stale span is rewritten rather than trusted');
  const noYear = { institution: 'X' };
  eq(withMarketYears(noYear), noYear, 'a row that names no season is left exactly alone');

  /* 8. what rowFromSubmission publishes: the stored season kept, the span
     derived beside it. */
  const spanDoc = rowFromSubmission(
    { ...doc, year: 2027, createdAt: new Date('2026-05-04T09:00:00Z') }, { now });
  eq(spanDoc.year, 2027, 'the season it is FOR');
  eq(spanDoc.years, [2026, 2027], 'and both seasons it is listed under');
  ok(PUBLIC_FIELDS.includes('years'), 'which is a published field');
  eq(PUBLIC_FIELDS.indexOf('years'), PUBLIC_FIELDS.indexOf('year') + 1,
    'written beside the season it widens');
  eq(publicRow(spanDoc).years, [2026, 2027], 'and reaches the served file');

  /* 9. EVERY SERVED FILE STATES IT, and states the same thing — three writers
     produce these rows (the build, the sheet sync, the legacy import) and a
     field only one of them wrote is undone by whichever writes next, which is
     the healCountry lesson. */
  for (const file of ['jobs.json', 'jobmarket.json', 'past-postings.json']) {
    const rows = JSON.parse(await readFile(path.join(HERE, '..', 'data', file), 'utf8'));
    const wrong = rows.filter((r) => JSON.stringify(r.years) !== JSON.stringify(marketYearsOf(r)));
    eq(wrong.slice(0, 4).map((r) => `${r.id}: ${JSON.stringify(r.years)}`), [],
      `data/${file}: every posting states the seasons it is listed under`);
  }

  /* 10. THE WIRING, read from the source. */
  ok(/healedRows\.map\(withMarketYears\)/.test(build),
    'build-jobs spans the MERGED set — a carried orphan never goes back ' +
    'through an ingest, so this is the only place it can gain one');
  const sheet = await readFile(path.join(HERE, 'jobmarket-sheet.mjs'), 'utf8');
  ok(/withMarketYears\(healReviewDate\(row\)\)/.test(sheet),
    'the tracking sheet\'s own rows are spanned as they are read');
  const legacy = await readFile(path.join(HERE, 'import-legacy-tables.mjs'), 'utf8');
  ok(/withMarketYears\(healPlace\(r\)\)/.test(legacy),
    'and so is the archive, which has no daily build to heal it');
  const sync = await readFile(path.join(HERE, 'sync-jobmarket-sheet.mjs'), 'utf8');
  ok(/\.map\(withMarketYears\)/.test(sync),
    'and --heal-names can give the committed file the field without waiting ' +
    'for the workbook to change');

  const archive = await readFile(path.join(HERE, '..', 'previous-markets.html'), 'utf8');
  ok(/label: 'Job market year', field: 'years'/.test(archive),
    'the archive\'s year filter reads the SPAN, so a posting open across the ' +
    'roll is found under either season');
  ok(/legacyParam: 'filterB'/.test(archive),
    'and keeps its deep-link name — the values are the same year strings');

  /* 11. the derived field is never an EDIT. It is computed from `posted`,
     `year` and the two apply-by dates on every build, so diffing it would
     have reported every posting as edited on the run that first wrote it —
     the phantom-edit e-mail, again (owner, 2026-08-25). */
  eq(diffRows({ id: 'x', year: 2026, years: [2026] },
    { id: 'x', year: 2026, years: [2026, 2027] }), [],
    'a span that widened is not an edit anyone made');
  eq(diffRows({ id: 'x', year: 2026, years: [2026] },
    { id: 'x', year: 2027, years: [2026, 2027] }).map((d) => d.field), ['year'],
    'the field it was derived FROM still reports, so nothing is hidden');
}

/* THE BROWSER TWIN. `postingYear()` in assets/oa-jobform.js applies the same
   cascade before the form SENDS `year`, and a stored year then wins in the
   pipeline — so if the two disagreed, the pipeline could never correct it.
   Pinned over one fixture list, the way typeGuess/typeFromNames are. */
async function testFormMarketYearParity() {
  const now = new Date('2026-08-26T12:00:00Z');
  const js = await readFile(path.join(HERE, '..', 'assets', 'oa-jobform.js'), 'utf8');
  const src = js.slice(js.indexOf('function marketYearOfDay'), js.indexOf('function yearNoteWhy'));
  ok(src.includes('function postingYear') && src.includes('function val'),
    'the fixture runs the FORM\'s own source, not a copy of it');

  const fields = {};
  const build = (editId, editYear, editPosted = '', pick = 'postingYear') => new Function(
    '$', 'EDIT_ID', 'EDIT_YEAR', 'EDIT_POSTED', 'jobMarketYears',
    src + `\nreturn ${pick};`)(
    (id) => (id in fields ? { value: fields[id], checked: fields[id] === true } : null),
    editId, editYear, editPosted, () => ({ current: 2099 }));
  const postingYear = build('', 0);

  /* EVERY CASE MUST SEPARATE THE STEP THAT ANSWERS IT FROM THE ONES THAT DO
     NOT — a fixture whose three answers coincide passes a form that reads the
     wrong date, which is exactly what the first draft of this test did. So
     the final date, the suggested date and the fallback name three DIFFERENT
     seasons wherever the case is about which of them wins, and "today" is
     pinned somewhere no real date could reach. */
  const FALLBACK = 2099;
  const CASES = [
    // the final date wins over a suggested date naming another season
    { applyByDate: '2026-10-15', reviewDate: '2025-10-15', want: 2027 },
    // ... and over one naming a LATER season, so it is not merely "the max"
    { applyByDate: '2026-10-15', reviewDate: '2027-10-15', want: 2027 },
    // no final date: the suggested one, not the fallback
    { applyByDate: '', reviewDate: '2026-09-08', want: 2027 },
    { applyByDate: '', reviewDate: '2025-09-08', want: 2026 },
    // neither: the fallback, and nothing else
    { applyByDate: '', reviewDate: '', want: FALLBACK },
    // the roll itself, on both sides of 1 July
    { applyByDate: '2026-06-30', reviewDate: '', want: 2026 },
    { applyByDate: '2026-07-01', reviewDate: '', want: 2027 },
  ];
  for (const c of CASES) {
    fields['f-applyByDate'] = c.applyByDate;
    fields['f-reviewDate'] = c.reviewDate;
    fields['f-untilFilled'] = !c.applyByDate;
    const label = JSON.stringify({ final: c.applyByDate, review: c.reviewDate });
    eq(postingYear(), c.want, `the form files ${label} under ${c.want}`);
    /* AND THE PIPELINE AGREES. The form has no posting date to read — a new
       posting is stamped with the moment it is stored — so the pipeline is
       asked the same question with `now` standing in for step 3. */
    if (c.want !== FALLBACK) {
      eq(marketYearOf({ applyByDate: c.applyByDate, reviewDate: c.reviewDate },
        { now }).year, c.want, `and _scraper/jobs-model.mjs says the same for ${label}`);
    }
  }

  /* A TICKED "until filled" IS THE ABSENCE OF A CLOSING DATE, even when the
     box beside it still holds one — the form disables it rather than clearing
     it on every path, and the pipeline reads `untilFilled` the same way. */
  fields['f-applyByDate'] = '2026-10-15';
  fields['f-reviewDate'] = '2025-09-08';
  fields['f-untilFilled'] = true;
  eq(postingYear(), 2026,
    'a ticked "until filled" drops to the suggested date, whatever the date box holds');

  // an EDIT is the one case the form must never re-derive
  fields['f-applyByDate'] = '2027-10-15';
  fields['f-reviewDate'] = '';
  fields['f-untilFilled'] = false;
  eq(build('doc1', 2026)(), 2026,
    'an edit keeps the season it was filed under — the year is half the row id');

  /* AND THE SPAN, the same way. `postingYears()` is what the note promises
     before the posting is sent, and `marketYearsOf` is what the build then
     writes — so the two are asked the same question about the same row. The
     form has no posting date for a NEW posting (the pipeline stamps it when
     the submission is stored), so `posted` here is the day the poster is
     typing, which is exactly what the form's third leg reads. */
  const TODAY = '2026-05-04';                 // a spring day, the owner's case
  const spanBuild = (editId, editYear, editPosted) =>
    build(editId, editYear, editPosted, 'postingYears');
  const SPANS = [
    // advertised in May, closing in September: the season under way AND the next
    { applyByDate: '2026-09-08', reviewDate: '', want: [2026, 2027] },
    // …and by the suggested date alone, once the search runs until filled
    { applyByDate: '', reviewDate: '2026-09-08', untilFilled: true, want: [2026, 2027] },
    // an autumn posting closing inside its own season names it once
    { applyByDate: '2026-12-01', reviewDate: '', posted: '2026-10-01', want: [2027] },
    // no date at all: the season being typed in, and nothing else
    { applyByDate: '', reviewDate: '', untilFilled: true, want: [2026] },
  ];
  for (const c of SPANS) {
    const posted = c.posted || TODAY;
    const today = new Date(`${posted}T12:00:00Z`);
    fields['f-applyByDate'] = c.applyByDate;
    fields['f-reviewDate'] = c.reviewDate;
    fields['f-untilFilled'] = !!c.untilFilled;
    /* BOTH halves of the form built against the SAME day, or the fallback
       leg — "today, until you give an apply-by date" — answers two different
       questions and the comparison below is measuring the stub. */
    const asOf = (pick) => new Function(
      '$', 'EDIT_ID', 'EDIT_YEAR', 'EDIT_POSTED', 'jobMarketYears',
      src + `\nreturn ${pick};`)(
      (id) => (id in fields ? { value: fields[id], checked: fields[id] === true } : null),
      '', 0, '', () => ({ current: marketYear(today) }))();
    const years = asOf('postingYears');
    const label = JSON.stringify({ ...c, posted });
    eq(years, c.want, `the form promises ${JSON.stringify(c.want)} for ${label}`);
    /* THE PIPELINE WRITES THE SAME. `year` is what the form sends, so the row
       the build sees carries the cascade's own answer beside the dates. */
    const row = { year: asOf('postingYear'), posted,
      applyByDate: c.untilFilled ? '' : c.applyByDate, reviewDate: c.reviewDate };
    eq(marketYearsOf(row), c.want,
      `and _scraper/jobs-model.mjs writes the same for ${label}`);
  }

  /* An EDIT reads the day the posting went up where the document carries one
     — a mirror or a migrated row — and the span then spells out what the
     build will write for it. */
  fields['f-applyByDate'] = '2026-09-08';
  fields['f-reviewDate'] = '';
  fields['f-untilFilled'] = false;
  eq(spanBuild('doc1', 2027, '2026-05-04')(), [2026, 2027],
    'an edit spans the season it went up in and the season it closes in');
  eq(spanBuild('doc1', 2027, '')(), [2027],
    'and a document that does not say when it went up promises only what it knows');
}

/* ---------------------------------------------------- ONE market rule, shared

   assets/oa-jobnav.js is the browser's copy of the two questions the pipeline
   answers in _scraper/jobs-model.mjs: which season is under way, and which of
   the two list pages a posting is on. It exists because there were FOUR
   copies of that rule — jobs.html, previous-markets.html, the one-pager's
   jobs teaser, and /admin-area was about to need a fourth to say which page a
   flagged posting could be opened on. This suite is what makes the copy safe:
   the parity is measured over every posting the site actually serves, not
   over a fixture list, because the two halves disagreeing is exactly the
   failure the module was written to remove. */
async function testJobNavModule() {
  const NAV = require(path.join(HERE, '..', 'assets', 'oa-jobnav.js'));
  const served = JSON.parse(await readFile(JOBS, 'utf8'));

  // 1. the roll, against the constant rather than against a written-down 6
  eq(NAV.MARKET_ROLL_MONTH, MARKET_ROLL_MONTH,
    'the browser rule rolls in the month marketYear() rolls in');
  eq(NAV.marketLabel(2027), marketLabel(2027),
    'and spells a season the way the data does — a hyphen, byte for byte');

  /* 2. PARITY, over every served posting at four instants: two ordinary days,
     and the two sides of the roll itself, where an off-by-one would show. */
  const WHEN = ['2026-08-27T12:00:00Z', '2025-12-01T12:00:00Z',
    '2026-06-30T23:00:00Z', '2026-07-01T00:00:00Z'];
  let checked = 0;
  for (const iso of WHEN) {
    const now = new Date(iso);
    eq(NAV.marketYear(now), marketYear(now), `${iso}: the season under way agrees`);
    eq(NAV.marketStart(now), marketStart(now), `${iso}: and so does the day it opened`);
    for (const r of served) {
      if (NAV.inCurrentMarket(r, now) !== inCurrentMarket(r, now)) {
        eq(NAV.inCurrentMarket(r, now), inCurrentMarket(r, now),
          `${iso} ${r.id}: the browser and the pipeline place it on the same page`);
      }
      if (NAV.deadlineOpen(r, now) !== deadlineOpen(r, now)) {
        eq(NAV.deadlineOpen(r, now), deadlineOpen(r, now),
          `${iso} ${r.id}: and read its deadline the same way`);
      }
      checked++;
    }
  }
  ok(checked === served.length * WHEN.length,
    `every one of the ${served.length} served postings agrees at all ${WHEN.length} instants`);

  /* 3. WHICH PAGE, AND THE LINK TO IT — the owner's own report (2026-08-27).
     Nanyang is filed under 2025-2026 with a deadline that has passed, so it
     is on Previous markets; the market-year report linked it as
     `jobs.html#job-<id>`, which opened a list that could not contain it. */
  const NOW = new Date('2026-08-27T12:00:00Z');
  const NANYANG = { id: '2026-nanyang-technological-university-20250924',
    posted: '2025-09-24', applyByDate: '2026-07-28', year: 2026 };
  const MCGILL = { id: '2026-mcgill-university-20260728',
    posted: '2026-07-28', applyByDate: '', year: 2026 };
  eq(NAV.pageFor(NANYANG, NOW), 'previous-markets.html',
    'a posting whose season has closed is opened on Previous markets');
  eq(NAV.pageFor(MCGILL, NOW), 'jobs.html',
    'and one still in the season under way on the jobs page');
  eq(NAV.hrefFor(NANYANG, NOW),
    'previous-markets.html?job=2026-nanyang-technological-university-20250924',
    'the link names the page AND the one posting — never a bare list');
  ok(!NAV.hrefFor(NANYANG, NOW).includes('#'),
    'and never a fragment: a card only exists while it is on the page being ' +
    'shown, one of ten, in a list built after the browser has looked for it');
  eq(NAV.pageLabelFor(NANYANG, NOW), 'Previous markets',
    'and the card can say where it is sending the maintainer');
  eq(NAV.otherPage('/previous-markets.html'), 'jobs.html',
    'each page can name the other for the "not here" message');
  eq(NAV.otherPage('/jobs.html'), 'previous-markets.html', 'both ways');

  // an id is a query VALUE, so it is encoded — a row id is built from a name
  ok(NAV.hrefFor({ id: 'a b&c', posted: '2026-08-01', year: 2026 }, NOW)
    .endsWith('?job=a%20b%26c'), 'the id is encoded into the link, never interpolated');
  eq(NAV.FOCUS_PARAM, 'job', 'and the parameter has one name, shared with the engine');

  /* 4. THE WIRING. The engine owns the parameter, the pages declare it, and
     the report links through the module. */
  const list = await readFile(path.join(HERE, '..', 'assets', 'oa-list.js'), 'utf8');
  ok(/cfg\.focusParam/.test(list) && /function focusRow\(\)/.test(list),
    'the list engine implements the one-posting focus');
  ok(/view = one \? \[one\] : \[\];/.test(list),
    'and takes the row ahead of every filter, so a search cannot hide it');
  ok(/focusMissing/.test(list),
    'with an empty state of its own — not "try removing a filter", beside a bar ' +
    'the focus has already hidden');
  ok(/focusDropHash = \/\^#job-\.\/\.test\(location\.hash\);/.test(list),
    'the legacy fragment is dropped by its SHAPE — deriving the flag from ' +
    'which source won leaves it on a URL carrying both, and a reload after ' +
    '"Show all postings" would focus again, on the OTHER posting');
  ok(/function focusOtherLink\(\)/.test(list) && /encodeURIComponent\(focusId\)/.test(list),
    'and the "not on this page" way out carries the id, so the recovery path ' +
    'is not the bare list this whole mode exists to stop landing people on');
  for (const [rel, other] of [
    ['jobs.html', 'previous-markets.html'],
    ['previous-markets.html', 'jobs.html'],
  ]) {
    const html = await readFile(path.join(HERE, '..', rel), 'utf8');
    ok(/focusParam: NAV\.FOCUS_PARAM/.test(html),
      `${rel}: declares the focus parameter from the shared name`);
    ok(new RegExp("focusOther: \\{ href: '" + other + "'").test(html),
      `${rel}: and names the OTHER page itself — the engine cannot know it`);
    ok(/focusMissingHint:/.test(html) &&
       !/focusMissingHint:[\s\S]{0,400}?<a href=/.test(html),
      `${rel}: the hint is prose; the LINK is the engine's, or it would carry ` +
      'no posting id');
  }
  const panelSrc = await readFile(path.join(HERE, '..', 'assets', 'oa-adminarea.js'), 'utf8');
  ok(/var wasOpen = !!\(list\.querySelector\('\.oa-aa-yc-done'\) \|\| \{\}\)\.open;/
    .test(panelSrc),
    'the settled panel stays open across a re-render — "Bring it back" is only ' +
    'reachable from inside it, and every write re-renders');
  /* THE HIDING RULE LIVES IN v3.css, and that is measured rather than
     preferred: `body.v3 .oa-filters { display: grid }` is one specificity
     point above anything oa-list.css can write, so the same rule there is
     silently inert — which is how previous-markets.html showed its filter bar
     over a single-posting view while jobs.html did not (there the LOCK
     WRAPPER was what got hidden). Both selectors are needed for the same
     reason the empty-dataset rule beside it needs both. */
  const v3css = await readFile(path.join(HERE, '..', 'assets', 'v3.css'), 'utf8');
  for (const sel of ['.oa-focus .oa-filters', '.oa-focus .v3-lock',
    '.oa-data-empty .v3-lock']) {
    ok(v3css.includes('body.v3 ' + sel),
      `v3.css hides "${sel}" at a specificity that can win`);
  }
  const css = await readFile(path.join(HERE, '..', 'assets', 'oa-list.css'), 'utf8');
  ok(!/^\s*\.oa-focus \.oa-filters/m.test(css),
    'and oa-list.css does not try to, where it would lose');
  ok(/\.oa-focus-clear/.test(css),
    'while the way back is styled with the engine\'s own chrome — outside all ' +
    'three, so a signed-out reader can press it');

  const panel = await readFile(path.join(HERE, '..', 'assets', 'oa-adminarea.js'), 'utf8');
  ok(/NAV\.hrefFor\(row\)/.test(panel),
    'the market-year report asks the module where a posting can be opened');
  /* read with the comments stripped: the panel still EXPLAINS the fragment it
     no longer emits, and a guard that could not tell the explanation from the
     link would have to be satisfied by deleting the explanation */
  ok(!/jobs\.html#job-/.test(panel.replace(/\/\*[\s\S]*?\*\//g, '')),
    'and no longer links a fragment on a page half these postings are not on');
  const admin = await readFile(path.join(HERE, '..', 'admin-area.html'), 'utf8');
  ok(admin.includes('assets/oa-jobnav.js'), 'admin-area.html loads the module');
}

/* ------------------------------------------- clearing the market-year report

   The report is DERIVED and stays derived. What is stored is what the
   maintainer has READ: `yearChecks/{posting id}`, keyed on the pair of
   seasons the card showed. Before it there was no way to clear the list at
   all (owner, 2026-08-27) — its two exits moved a posting that was usually
   filed correctly, or waited for a deadline that was not what put it there. */
async function testYearCheckDecisions() {
  const YC = require(path.join(HERE, '..', 'assets', 'oa-yearcheck.js'));
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  const block = rules.slice(rules.indexOf('match /yearChecks/'));
  ok(rules.includes('match /yearChecks/'), 'the rules carry the collection');

  ok(/allow read: if isAdmin\(\);/.test(block.slice(0, 300)),
    'only the maintainer reads it — nothing public consumes a note about their desk');
  ok(/allow write: if isAdmin\(\)/.test(block.slice(0, 700)),
    'and only the maintainer writes one');
  ok(/allow delete: if isAdmin\(\);/.test(block.slice(0, 2000)),
    'with a delete of its own, or Bring it back would be a one-way door — ' +
    '`request.resource` is null on a delete, so `allow write` cannot cover one');

  /* EVERY KEY THE MODULE WRITES, taken from the module rather than restated:
     a key with no rule is a permission-denied at save time and a maintainer
     told to redeploy rules that are already deployed. */
  const allowed = new Set(
    (block.slice(block.indexOf('hasOnly(['), block.indexOf('])', block.indexOf('hasOnly([')))
      .match(/'[^']+'/g) || []).map((q) => q.slice(1, -1)));
  for (const key of YC.DOC_KEYS) {
    ok(allowed.has(key), `oa-yearcheck.js may write "${key}", and the rules allow it`);
  }
  eq([...allowed].sort(), [...YC.DOC_KEYS].sort(),
    'and the rules allow nothing the module does not write');
  ok(block.slice(0, 1400).includes(`'${YC.SETTLED}'`),
    `the rules name the "${YC.SETTLED}" status, the only decision there is`);

  /* …and DOC_KEYS is what settlementFor() ACTUALLY produces. Pinning the
     rules against a declared list leaves that half unchecked (testRowOverrides
     and testUsersAndMessages record the same lesson). */
  const P = { id: '2026-x-20260101', stored: 2026, should: 2027 };
  const body = YC.settlementFor(P, new Date('2026-08-27T09:30:00Z'));
  eq(Object.keys(body).sort(), [...YC.DOC_KEYS].sort(),
    'and DOC_KEYS is what a settlement really carries, read from the function');
  eq(body.status, YC.SETTLED, 'a settlement says it settles');
  eq([body.stored, body.should], [2026, 2027],
    'and records the pair of seasons the maintainer answered');
  ok(body.should > body.stored,
    'should is always the LATER season — the shape marketYearReview can produce, ' +
    'and what the rules refuse a document without');
  ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(JSON.stringify(body)),
    'and nothing that could be a person');

  /* THE DECISION IS KEYED ON THE DISAGREEMENT. Correct a deadline afterwards
     and the report asks a different question, so the posting comes back. */
  ok(YC.covers(body, P), 'a settled posting is settled while the report says the same');
  ok(!YC.covers(body, { ...P, should: 2028 }),
    'a posting whose dates have moved is a disagreement nobody has read');
  ok(!YC.covers(body, { ...P, stored: 2025 }), 'either way round');
  ok(!YC.covers({ ...body, status: 'something-else' }, P),
    'and a document that does not say "settled" settles nothing');
  ok(!YC.covers(null, P), 'ABSENCE MEANS SHOW — the opposite way round from the ' +
    'review queue, because these postings are already published: the risk here ' +
    'is hiding a disagreement, not leaking one');

  const REPORT = [P, { id: 'b', stored: 2026, should: 2028 }, { id: 'c', stored: 2026, should: 2027 }];
  const split = YC.partition(REPORT, { [P.id]: body, b: body });
  eq(split.settled.map((r) => r.p.id), [P.id], 'a settled posting leaves the list');
  eq(split.open.map((r) => r.p.id), ['b', 'c'], 'and the rest are still waiting');
  ok(split.open[0].resettled,
    'one that was settled and has since changed says so, rather than looking ' +
    'like a decision that was ignored');
  ok(!split.open[1].resettled, 'and one nobody has read yet does not');
  eq(YC.partition(REPORT, null).open.length, REPORT.length,
    'a decisions read that failed leaves every posting open, never an empty list');
  eq(YC.partition(REPORT, {}).settled.length, 0, 'as does one that found nothing');
  ok(YC.partition(null, {}).open.length === 0, 'and no report is no rows, not a throw');

  /* THE PANEL. It draws the settle controls only when it could read the
     decisions, counts only what is WAITING into its tile, and keeps both
     reads out of pendingCounts() — that function runs on EVERY page for the
     account-menu badge (the Registered-users rule). */
  const panel = await readFile(path.join(HERE, '..', 'assets', 'oa-adminarea.js'), 'utf8');
  ok(/OAYearCheck\.COLLECTION/.test(panel) && !/collection\('yearChecks'\)/.test(panel),
    'the panel names the collection through the module, never a literal');
  ok(/lastYearCheck = split\.open\.length;/.test(panel),
    'the tile counts what is still waiting, not what has ever been reported');
  ok(/data-act="settle"/.test(panel) && /data-act="unsettle"/.test(panel),
    'it offers both the decision and the way back');
  ok(/yearActions\s*$|yearActions$|yearActions/m.test(panel) &&
     /yearActions = !!docs/.test(panel),
    'and offers neither while the decisions could not be read');
  ok(/oa-aa-yc-done/.test(panel),
    'a settled posting goes into a collapsed panel below the list, one click ' +
    'from back — the newsOverrides rule: never a one-way door');
  const counts = panel.slice(panel.indexOf('function pendingCounts'),
    panel.indexOf('function registeredCount'));
  ok(!/yearcheck/i.test(counts) && !/yearChecks/.test(counts),
    'neither the report nor its decisions rides the every-page badge read');

  const admin = await readFile(path.join(HERE, '..', 'admin-area.html'), 'utf8');
  ok(admin.includes('assets/oa-yearcheck.js'), 'admin-area.html loads the module');
  ok(/Reviewed &mdash; leave it here/.test(admin),
    'and the panel copy names the button the maintainer is looking for');

  const js = await readFile(path.join(HERE, '..', 'assets', 'oa-yearcheck.js'), 'utf8');
  ok(js.includes('module.exports = factory()'),
    'the module is dual-mode, so this suite runs the browser\'s own code');

  /* NOTHING UNDER data/ CHANGED. The report is still the derived file the
     build writes, and no decision may reach it — everything there is served
     to anyone who asks. */
  ok(!existsSync(path.join(HERE, '..', 'data', 'yearchecks.json')),
    'the decisions are not a served file — they are the maintainer\'s, not the public\'s');
  const build = await readFile(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(!/yearChecks/.test(build),
    'and the build knows nothing about them: what is FLAGGED stays derived');
}

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
      /* An EDIT keeps the season it was filed in — everywhere, and this is
         the load-bearing half: a row's `year` is half its `id`, so a
         published posting whose season moved would be published twice.

         What a NEW one takes differs by form, and by tree. The live posting
         form reads its APPLY-BY DATES (owner, 2026-08-26); the candidate
         form has no such date and keeps the calendar; and `/v2/` is a frozen
         archive, so its copies keep exactly what they shipped with. */
      const cascade = page === 'post-a-job.html' && !dir.length;
      ok(/if \(EDIT_ID && EDIT_YEAR\) return EDIT_YEAR;/.test(js)
        || /return \(EDIT_ID && EDIT_YEAR\) \|\|/.test(js),
        `${where}: an edit keeps the season it was filed in`);
      if (cascade) {
        ok(/marketYearOfDay\(final\)/.test(js) && /marketYearOfDay\(val\('f-reviewDate'\)\)/.test(js),
          `${where}: a new posting is filed by its final apply-by, then its suggested one`);
        ok(/jobMarketYears\(\)\.current;/.test(js),
          `${where}: and only then by today — step 3 of the cascade`);
      } else {
        ok(/return \(EDIT_ID && EDIT_YEAR\) \|\| jobMarketYears\(\)\.current;/.test(js),
          `${where}: a new one takes today's season — it has no apply-by date to read`);
      }
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
  /* WHAT THE REPAIR PROMISED, AND WHAT IT DID NOT. The complaint was one
     place reading as five, so the promise is that the five REPORTED SPELLINGS
     never come back — not that Tulane may only ever have the one school and
     the one department it had that day.

     Pinned the second way this fired on 2026-08-25: a Tulane posting arrived
     naming Information Systems, which is a second DEPARTMENT and not a second
     spelling of Management Science, and the whole site stopped publishing —
     the fourth outage of this exact shape CLAUDE.md records. An empty field
     was already excused here for the same reason; a genuinely new name needed
     excusing too, and the rule is the one this file states for every guard
     over a live file: assert something any legitimate row satisfies.

     So: the canonical names are still THERE (the repair reached the data),
     the retired spellings are still GONE (it has not come undone), and a
     school or department nobody had heard of that morning is free to arrive.
     That the five collapse onto the canonical pair at all is the alias
     table's own job and is tested on fixtures above, where new data cannot
     reach it. */
  const tulaneSchools = [...new Set(tulane.map((r) => r.school))].filter(Boolean);
  const tulaneUnits = [...new Set(tulane.map((r) => r.unit))].filter(Boolean);
  ok(tulaneSchools.includes('A. B. Freeman School of Business'),
    'and they name the school the one way the site publishes it');
  ok(tulaneUnits.includes('Management Science'),
    'and the department the five spellings collapsed into is still on the site');
  /* The spellings the complaint named, each of which used to be its own entry
     in every filter. `school` and `unit` are checked against BOTH fields
     because what used to arrive was the school typed into the department box. */
  const RETIRED_TULANE = [
    'Freeman School of Business', 'AB Freeman School of Business',
    'A.B. Freeman School of Business', 'Management Sciences Area',
    'Management Science Department', 'Management Sciecne',
  ];
  eq(tulane.filter((r) => RETIRED_TULANE.some((n) => n === r.school || n === r.unit))
    .map((r) => r.id), [],
  'and no Tulane posting names one of the retired spellings');

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
  /* …unless the alias tables say the acronym IS the name: KAIST has been the
     university's official name since 2008, the site's own card and the OM
     list both use it, and the long form was standing as a second card
     (aliased 2026-08-24, with the OM-list merge). */
  eq(S.canonInstitution('Korea Advanced Institute of Science and Technology (KAIST)'),
    'KAIST', 'and the long form of a university whose acronym IS its name folds onto it');

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
    /* …and the archive's rows carry their SPAN out of the same call — it has
       no daily build to heal it, so a --fetch that wrote the names without
       `years` would take the year filter's answer away for every row it
       rewrote. */
    [/await write\('past-postings\.json', rows\.map\(\(r\) => withMarketYears\(healPlace\(r\)\)\),/,
      'the postings archive'],
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
   three cascading boxes; the placement form has three institution boxes; and
   since 2026-08-24 the candidate form asks the SAME three name questions the
   job form does (owner: university / school / department, with an example
   each — Northwestern University, Kellogg School of Management, Operations),
   replacing its old single free-text "Current affiliation". What PUBLISHES is
   still one `affiliation` line, derived by joining the three smallest-first,
   so the card, the alert matcher and the universities page's affiliation
   deep links read exactly what they always did.                            */

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

  /* The candidate form mounts the SHARED cascade over its three name fields —
     never a combo of its own, which would be the second-cascade drift
     oa-place-picker.js exists to prevent. The page must load the module, the
     form must wire it, and the three fields must be the job form's own ids so
     the cascade asks its questions the one way. */
  const candHtml = await read('post-a-candidate.html');
  ok(/oa-place-picker\.js/.test(candHtml),
    'post-a-candidate.html loads the shared cascade');
  for (const id of ['f-institution', 'f-school', 'f-unit']) {
    ok(candHtml.includes(`id="${id}"`),
      `post-a-candidate.html asks for ${id} — the three names, separately`);
  }
  ok(!/id="f-affiliation"/.test(candHtml),
    'and the old single affiliation box is gone');
  const candJs = await read('assets/oa-candidateform.js');
  ok(/OAPlacePicker\.wire/.test(candJs),
    'oa-candidateform.js mounts the shared cascade over the three fields');
  ok(/canonColumns/.test(candJs) && /joinAffiliation/.test(candJs),
    'and derives the ONE published affiliation line from them, canonicalised');

  /* The job form's own vocabulary read moved into the shared cascade
     (assets/oa-place-picker.js) when the review queue started mounting the same
     three boxes — so the file that has to name vocab.json is that one. The
     candidate form joined the cascade on 2026-08-24, so it left this list. */
  for (const [file, what] of [['assets/oa-place-picker.js', 'cascade'],
    ['assets/oa-placementform.js', 'placement']]) {
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

  /* THREE directories, exactly as build-jobs.mjs feeds them: the site's own
     Universities page, the seed of the world's operations and supply chain
     schools (assets/oa-institutions.js) that lets a first-time poster from a
     university nobody has posted from find their school already listed, and
     the OM list's departments (assets/oa-omlist.js) — so the posting form's
     cascade offers the full database (owner, 2026-08-24). */
  const seed = require(path.join(HERE, '..', 'assets', 'oa-institutions.js'));
  const om = require(path.join(HERE, '..', 'assets', 'oa-omlist.js'));
  const rebuilt = buildVocab(jobs, {
    generated: v.generated,
    directory: [...directory, ...seed.directoryRows(), ...om.directoryRows()],
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

  /* ---- WHO edited it (owner, 2026-09-02) ------------------------------

     "for each edit (1) the name and email of user who edited". The message
     listed eight "Edited" sections and named nobody, so a run in which the
     tracking-sheet crawler republished a degraded read read exactly like
     eight people editing postings. The line is the shared `postedBy` rule,
     as in the review and submission mailers, so the three cannot disagree
     about what a crawled posting is. */
  const changed = collectChanges([a], [edited], []);
  const byUser = renderChangesHtml(changed, {
    whoFor: () => postedBy({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.edu' }),
  });
  ok(/Posted by:/.test(byUser), 'each section says who put the posting on the site');
  ok(/Ada Lovelace/.test(byUser) && /ada@x\.edu/.test(byUser),
    'a person is named, with the address they gave');
  ok(/mailto:ada@x\.edu/.test(byUser), 'as a mailto, so replying is one click');

  const byCrawler = renderChangesHtml(changed, {
    whoFor: (row) => postedBy({ source: 'jobmarket-sheet' }, row),
  });
  ok(/auto-crawler from the OM Job Market tracking sheet/.test(byCrawler),
    'and a crawled posting reads as the crawler — the eight the owner was sent');
  ok(!/Posted by:[\s\S]{0,80}@/.test(byCrawler),
    'never as a nameless person: a workbook row has no submitter to name');

  ok(!/Posted by:/.test(renderChangesHtml(changed)),
    'a caller that cannot answer says nothing rather than guessing');

  const tookDown = renderChangesHtml(collectChanges([a], [], ['OA-JOB-1']), {
    whoFor: () => postedBy({ firstName: 'Ada', email: 'ada@x.edu' }),
  });
  ok(/Posted by:/.test(tookDown), 'a takedown answers the same question');

  const nasty = renderChangesHtml(changed, {
    whoFor: () => ({ kind: 'user', name: '<script>x</script>', email: 'a"b@x.edu',
                     text: 'x' }),
  });
  ok(!/<script>/.test(nasty), 'a name carrying markup is rendered inert');

  /* The wiring, because the join needs Firestore to run for real: `ref` is
     issued by the FORM and by nothing else, so it is the only key that can
     find the POSTER's own document rather than a place and a day. */
  const whoSrc = readFileSync(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(/renderChangesHtml\(changes, \{ whoFor \}\)/.test(whoSrc),
    'the build passes the attribution into the message it sends');
  ok(/docByRef\.set\(v\.ref, v\)/.test(whoSrc),
    'joined on the reference the form issues, never on a derived id');

  /* ---- "22 edited" every day, and nobody had edited anything ----------

     The owner was getting a daily "[OA] Job postings changed: 22 edited"
     for postings no human had touched (2026-08-25). Two causes, both here.

     ONE: `addedAt` was diffed. It records when the DATASET first saw the
     posting, mergeRows carries it over from the previous row precisely so a
     re-read never re-stamps it, and nobody edits it — 17 of the 23 phantom
     edits were this one field. It belongs with `id` and `adPending` in the
     list diffRows skips, and the block that sends the e-mail already claimed
     "bookkeeping writes never produce an e-mail". */
  eq(diffRows(a, { ...a, addedAt: '2026-08-25T09:00:00.000Z' }).length, 0,
    'addedAt is bookkeeping, not an edit — it never produces a change e-mail');
  ok(diffRows(a, { ...a, comments: 'new' }).length === 1,
    'while a field a person can actually change still is one');

  /* TWO: build-jobs diffed the RAW rows read from the sources against the
     served file, not the rows it was about to WRITE. Every heal the build
     applies on the way out (healCountry, healReviewDate, stripRowEmails,
     healPlace) therefore reported itself as a fresh edit on every write, for
     ever, because the source keeps saying what it always said. Pinned at the
     source, because reproducing it needs Firestore and the workbook. */
  const buildSrc = readFileSync(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(/collectChanges\(existing,\s*rows,/.test(buildSrc),
    'the change e-mail diffs the rows the build WRITES, not the raw ones it read');
  ok(!/collectChanges\(existing,\s*freshVisible/.test(buildSrc),
    'and never freshVisible again — that is what mailed 23 phantom edits a day');

  /* The behavioural half of the same claim: a rebuild that changes nothing
     reports nothing. `rows` on an unchanged run IS the served file, so this
     is the exact comparison build-jobs now makes. */
  const served = [a, { ...a, id: 'y', ref: 'OA-JOB-2', institution: 'Emory University' }];
  eq(collectChanges(served, served, [], []).edits.length, 0,
    'an unchanged rebuild reports no edits at all');
  eq(collectChanges(served, served, [], []).added, 0, 'and nothing new');

  /* The same slip made the LOG overcount in the other direction: it counted a
     row that the collapse then folded away, so a run that added 3 postings
     announced "+12 new". Counting what is written cannot do that. */
  const collapsedAway = [a];
  eq(collectChanges(served, collapsedAway, [], []).added, 0,
    'a row that never reaches the written set is never counted as new');
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
  ok(pmHtml.includes('assets/oa-jobnav.js') &&
     /function marketYear\(\) \{ return NAV\.marketYear\(\); \}/.test(pmHtml),
    'previous-markets.html reads the market-roll rule the jobs page reads');

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

  /* A SEARCH ADVERTISED ACROSS RANKS TICKS BOTH BOXES (owner, 2026-08-26),
     because it is open to both kinds of candidate — and the workbook writes
     that half a dozen ways, mostly WITHOUT the word "Professor" beside the
     senior rank, which is why the tokens below are matched bare. */
  eq(levelsFromRank('AP'), ['Assistant Professor'],
    'the sheet\'s "AP" is an assistant professorship — its own shorthand');
  eq(levelsFromRank('Open Rank'), ['Assistant Professor', 'Other Ranks'],
    'an open-rank search is open to an entry-level candidate too');
  eq(levelsFromRank('Assistant/ Associate'), ['Assistant Professor', 'Other Ranks'],
    'as is one advertised at two ranks with neither spelled out');
  eq(levelsFromRank('Assistant/Open rank'), ['Assistant Professor', 'Other Ranks'],
    'however the two are joined');
  eq(levelsFromRank('Assistant/ Associate Professor'), ['Assistant Professor', 'Other Ranks'],
    'and with the rank spelled out once');
  eq(levelsFromRank('AP/Assoc/Full'), ['Assistant Professor', 'Other Ranks'],
    'the tab\'s commonest wording, all three ranks abbreviated');
  eq(levelsFromRank('Junior level (Assistant or untenured Associate Professor)'),
    ['Assistant Professor', 'Other Ranks'],
    'and the long way round, which names neither rank adjacently');

  /* THE INVARIANT THE COLLECTION MUST NOT COST: a post advertised ONLY at
     entry level never carries Other Ranks, or the Entry level filter stops
     narrowing anything. */
  eq(levelsFromRank('Assistant Professor of Operations Management'), ['Assistant Professor'],
    'a plain assistant professorship is not also filed under Other Ranks');
  eq(levelsFromRank('Full-time Assistant Professor'), ['Assistant Professor'],
    'and "full-time" is a contract, not a rank');
  eq(levelsFromRank('Full'), ['Other Ranks'], 'while a full professorship is senior alone');
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
  /* THE COMMENTS ARE THE POSTING'S DESCRIPTION (owner, 2026-08-26). This row
     says nothing about the job beyond its rank and its town, and NEITHER of
     those belongs here any more: the rank is the Entry level asserted two
     lines above, and the town is the university's. The card used to open
     "Visiting Assistant Professor · Potsdam, NY". */
  eq(clarkson.comments, '',
    'the rank column and the town are no longer carried as prose — a row with ' +
    'nothing to say about the job says nothing');
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

/* ------------------- a read without its header cannot un-say what it said

   The 2026-09-01 02:01 read caught the crowdsourced "2026 Jobs" tab mid-edit:
   the header row was momentarily unrecognisable, the read fell to whole-tab
   inference — which structurally cannot find the deadline cell or the notes
   column — and eight served postings had their deadlines published back to
   "Until filled." for one run. The admin was e-mailed an "edit" for each,
   which is how it was noticed at all (owner, 2026-09-02: "you are not editing
   these jobs all the time, right?" territory again, one layer down). The
   23:23 read before and the 17:26 read after both saw the header.

   The rule under test: A COLUMN THE READ COULD NOT FIND CHANGES NOTHING. */
function testJobMarketSheetCarry() {
  const HEAD = ['University', 'Country', 'Date', 'Field', 'Position', 'Deadline', 'Comment'];
  const BODY = [
    ['Alpha University', 'USA', '25-Aug-26', 'OM', 'AP', '20-Oct-26', ''],
    ['Beta University', 'USA', '26-Aug-26', 'SCM', 'AP', '', 'Teaching post, two years'],
    ['Gamma University', 'USA', '27-Aug-26', 'BA', 'AP', '', ''],
  ];
  const at = { tab: '2026 Jobs', kind: 'jobs', sheetId: 'S', minYear: 2026 };

  const good = rowsFromTab(csvOf([HEAD, ...BODY]), at);
  ok(!good.inferred, 'the fixture header is recognised');
  ok(good.columns.includes('deadline') && good.columns.includes('notes'),
    'and names the deadline and the notes — a recognised header is the tab\'s own word');

  const bad = rowsFromTab(csvOf(BODY), at);
  ok(bad.inferred, 'the same tab without its header falls to whole-tab inference');
  ok(!bad.columns.includes('deadline') && !bad.columns.includes('notes'),
    'which structurally cannot find the deadline cell or the notes column');
  eq(bad.rows.map((r) => r.id), good.rows.map((r) => r.id),
    'while the rows keep their identity, which is what the carry joins on');
  eq(bad.rows.find((r) => r.institution === 'Alpha University').applyBy, 'Until filled.',
    'so the degraded read, published as it stands, un-says every deadline — the defect');

  const reads = [{ sheet: 'S', tab: '2026 Jobs', inferred: bad.inferred, columns: bad.columns }];
  const { rows: kept, carried } = carryUnreadColumns(bad.rows, good.rows, reads);

  const alpha = kept.find((r) => r.institution === 'Alpha University');
  eq(alpha.applyByDate, '2026-10-20', 'the deadline the header-read published is kept');
  eq(alpha.applyBy, 'October 20, 2026', 'with its display line');
  eq(alpha.years, good.rows.find((r) => r.institution === 'Alpha University').years,
    'and the market-year span is re-read off the dates as they finally stand');
  eq(kept.find((r) => r.institution === 'Beta University').comments,
    'Teaching post, two years', 'the notes column is kept the same way');
  const gAt = bad.rows.findIndex((r) => r.institution === 'Gamma University');
  ok(kept[gAt] === bad.rows[gAt],
    'a row with nothing to carry is the same object — by value, the healCountry shape');
  eq(carried.length, 2, 'and the carry reports exactly what it kept, for the log');

  eq(carryUnreadColumns(kept, good.rows, reads).carried.length, 0,
    'idempotent: a second pass carries nothing more');
  eq(carryUnreadColumns(bad.rows, good.rows,
    [{ sheet: 'S', tab: '2026 Jobs', inferred: false, columns: good.columns }]).carried.length, 0,
    'a tab whose header WAS read carries nothing — a deadline genuinely cleared ' +
    'in the workbook still clears');
  eq(carryUnreadColumns(bad.rows, [], reads).carried.length, 0,
    'and a posting the site does not know yet has nothing to carry from');
  ok(carryUnreadColumns(bad.rows, good.rows, []).rows === bad.rows,
    'no inferred tab, no work at all');
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
  eq(hku.comments, 'an expected start date of July 1, 2027',
    'the comment column is the comment, and the rank and the town — read from ' +
    'the repaired header exactly as before — are kept OFF it');
  eq(hku.levels, ['Assistant Professor', 'Other Ranks'],
    'and "AP/Assoc/Full" ticks both boxes (testJobMarketSheetParsing)');
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
  eq(byDate.rows.filter((r) => r.year === 2026).length, 3,
    'three of these five are dated before their own cycle opened AND name no ' +
    'deadline that outruns it, so with no tab to go on they file under the ' +
    'market that has just closed');
  eq(byDate.rows.find((r) => r.institution === 'KU Leuven').year, 2027,
    'the fourth needs no tab at all: advertised 5 June 2026 and closing on ' +
    '20 August, its own deadline says which season it is for (owner, 2026-08-26)');

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

/* ------------------------------------- the rules publish themselves now

   "Nothing in CI deploys rules — it needs an interactive login" was half true
   and cost six features: they shipped inert behind rules that were committed
   and never published, and the Admin area's roster is what finally showed it
   (owner, 2026-08-24 — a panel listing nobody under a red line telling the
   maintainer to go and run a command). `firebase deploy` needs a login;
   RELEASING A RULESET does not, and the service account eight workflows here
   already use can do it.

   What is pinned is what makes that safe to automate: the same wrong-project
   guard the CLI road carries, a refusal to publish the neighbouring file, and
   the run sitting BEHIND the offline checks rather than on a raw push.       */

async function testRulesDeploy() {
  const root = path.join(HERE, '..');
  const src = await readFile(path.join(root, '_scraper', 'deploy-rules.mjs'), 'utf8');
  const wf = await readFile(
    path.join(root, '.github', 'workflows', 'oa-deploy-rules.yml'), 'utf8');

  /* Importing a deploy script must not deploy. Every CLI here is guarded, and
     on this one the guard is the difference between a module the checks can
     read and one that publishes the moment anything touches it. */
  ok(/isMain\(import\.meta\.url\)/.test(src),
    'deploy-rules is guarded by isMain — importing it publishes nothing');
  ok(!/\bfileURLToPath\(import\.meta\.url\)\s*===/.test(src),
    'and through _main.mjs, never the Windows-broken comparison');

  /* The pure guards, against the module itself rather than a copy of its
     rules — the same both-ways discipline every other pairing here follows. */
  const mod = await import('./deploy-rules.mjs');
  eq(mod.projectMismatch('operations-academia', 'operations-academia'), '',
    'a credential for this project publishes');
  ok(mod.projectMismatch('stouras-answerarena', 'operations-academia') !== '',
    'a credential for the project this folder has twice mis-deployed into is REFUSED');
  ok(mod.projectMismatch('operations-academia', '') !== '',
    'and an unreadable .firebaserc never falls back to a default');

  /* The expected project comes from .firebaserc, never a literal — the rule
     testDeployGuard holds check-project.mjs to, applied to this road. */
  const rc = JSON.parse(await readFile(path.join(root, '.firebaserc'), 'utf8'));
  ok(src.includes('.firebaserc'), 'the deploy reads its target from .firebaserc');
  /* Measured over the code that RESOLVES the target, not over the fixtures
     below it: the selftest's wrong-project case names the real sibling project
     this folder was twice mis-deployed into, which is worth keeping. */
  const logic = src.slice(0, src.indexOf('function selftest('));
  ok(logic.length > 1000 && !logic.includes(`'${rc.projects.default}'`),
    'and does not hardcode the project id');

  /* The two files sit side by side and differ by one word in an argument. */
  const rules = await readFile(path.join(root, '_firestore.rules'), 'utf8');
  const storage = await readFile(path.join(root, '_storage.rules'), 'utf8');
  eq(mod.sourceProblem(rules), '',
    'the committed Firestore rules are publishable as they stand');
  ok(mod.sourceProblem(storage) !== '',
    'and the STORAGE rules are refused — a different service, one argument away');
  ok(mod.sourceProblem('') !== '', 'an empty read never publishes');

  /* Identical rules are a no-op, which is what makes a run per check cheap. */
  eq(mod.sameSource([{ name: 'firestore.rules', content: rules }], rules), true,
    'live rules identical to the repository publish nothing, whatever the file is named');
  eq(mod.sameSource([], rules), false,
    'and no live ruleset at all is never read as "already published"');

  /* BEHIND the checks, never on a raw push: publishing is the one action here
     the next run cannot undo, and the offline guards are what prove the rules
     agree with the modules that write those collections. */
  ok(/workflow_run:/.test(wf) && /workflows: \["OA — checks"\]/.test(wf),
    'the workflow runs after the offline checks, not on the push itself');
  ok(/conclusion == 'success'/.test(wf) && /head_branch == 'master'/.test(wf),
    'and only when they PASSED, on master');
  ok(!/^\s*push:/m.test(wf), 'there is no raw push trigger');
  ok(/workflow_dispatch:/.test(wf) && /dry_run/.test(wf),
    'and the maintainer can fire it by hand, dry-run included');
  ok(/deploy-rules\.mjs --selftest/.test(wf),
    'the run proves its own guards before it publishes anything');
  ok(/FIREBASE_SERVICE_ACCOUNT/.test(wf),
    'it publishes with the service account this repository already holds');

  /* The panels tell the maintainer what to press. The old wording sent them to
     install a CLI and log in, which is the reason this was never done. */
  const users = await readFile(path.join(root, 'assets', 'oa-users.js'), 'utf8');
  ok(/publish the Firestore rules/.test(users),
    'the roster panel names the workflow that fixes it');

  /* And the two documents that told everybody the opposite. */
  for (const [file, what] of [['CLAUDE.md', 'the repository conventions'],
    ['_SETUP-FIREBASE.md', 'the setup page']]) {
    const doc = await readFile(path.join(root, file), 'utf8');
    ok(!/Nothing in CI deploys rules\./.test(doc),
      `${what} no longer claims nothing in CI can deploy rules`);
    ok(/oa-deploy-rules/.test(doc), `${what} names the workflow instead`);
  }
}

/* ------------------------------- the roster is seeded from Auth

   "31 Registered users" over a roster listing ONE person (owner, 2026-08-25).
   Both numbers were right: the tally is a mark every sign-in writes, while a
   roster ROW is written by the BROWSER once per session — so the roster held
   only the people who had signed in since its rules were published, minutes
   earlier. Firebase Auth knows all of them and only the Admin SDK can ask.

   What is pinned is the constraint that makes the backfill safe to run: the
   Admin SDK bypasses the rules, so a row it writes with a FIFTH key would be
   accepted — and would then freeze that row against its own owner for ever,
   because the browser's merge produces a document `hasOnly` refuses.         */

async function testUserDirectorySync() {
  const root = path.join(HERE, '..');
  const mod = await import('./sync-user-directory.mjs');
  const rules = await readFile(path.join(root, '_firestore.rules'), 'utf8');

  /* The rules' own list for a roster row, read out of the file rather than
     copied — the both-ways discipline every other pairing here follows. */
  const block = rules.slice(rules.indexOf('match /userDirectory/{uid}'));
  const hasOnly = /hasOnly\(\[([^\]]*)\]\)/.exec(block);
  ok(hasOnly, '_firestore.rules bounds a roster row with hasOnly');
  const allowed = (hasOnly ? hasOnly[1] : '')
    .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  eq(mod.ROW_KEYS.slice().sort(), allowed.slice().sort(),
    'the sync writes EXACTLY the keys the rules allow — a fifth would freeze the ' +
    'row against its own owner');

  /* And what it actually writes obeys that, not just what it declares. */
  const row = mod.rowFromAuthUser({
    uid: 'u', email: 'a@b.edu', displayName: 'A B',
    metadata: { creationTime: 'Mon, 01 Jan 2026 00:00:00 GMT',
      lastSignInTime: 'Mon, 01 Jun 2026 00:00:00 GMT' },
  }, null);
  eq(Object.keys(row).sort(), allowed.slice().sort(),
    'and a row it builds carries those keys and no others');
  ok(typeof row.first === 'number' && typeof row.seen === 'number',
    'with the two dates as NUMBERS, which is what the rules demand');

  /* Dates only ever correct backwards / forwards in the safe direction. */
  eq(mod.rowFromAuthUser({ uid: 'u', email: 'a@b.edu', metadata: {} },
    { name: '', email: 'a@b.edu', first: 5, seen: 9 }), null,
  'an account already current costs no write, so a daily fire commits nothing');

  /* The collection name is the one the panel reads. */
  const fbjs = await readFile(path.join(root, 'assets', 'oa-firebase.js'), 'utf8');
  ok(fbjs.includes(`userDirectory: '${mod.DIRECTORY}'`),
    'the sync writes the collection the Admin area actually reads');

  const wf = await readFile(
    path.join(root, '.github', 'workflows', 'oa-user-directory.yml'), 'utf8');
  ok(/FIREBASE_SERVICE_ACCOUNT/.test(wf), 'the workflow passes the service account');
  ok(/sync-user-directory\.mjs --selftest/.test(wf),
    'and proves the mapping before it writes anything');
  ok(/workflow_dispatch:/.test(wf) && /schedule:/.test(wf),
    'it runs daily and on demand — the dispatch is for right after a rules deploy');

  const src = await readFile(path.join(root, '_scraper', 'sync-user-directory.mjs'), 'utf8');
  ok(/isMain\(import\.meta\.url\)/.test(src),
    'and importing it syncs nothing');
}

/* ------------------------------ the Universities directory (owner, 2026-08-24)

   data/directory.json is the flat table universities.html groups into one
   card per university — merged by _scraper/build-directory.mjs from the
   curated archive, the oa-institutions.js seed and every posting, so a
   posting always fits under a card and a posting from a place no source
   lists creates one. `directoryEdits` is its read-time overlay, the
   rowOverrides pattern with the write opened to every registered user;
   the model tests pin the merge rules, the wiring test pins the module,
   the rules, the served file and every page that has to agree. */
async function testDirectoryModel() {
  const { buildDirectory, rowKey, directoryStats } = await import('./directory-model.mjs');

  eq(rowKey('The University of Texas at Dallas (UTD)', 'Naveen Jindal School of Management', 'Operations Management Area'),
    rowKey('University of Texas at Dallas', 'Naveen Jindal School of Management', 'Operations Management Area'),
    'directory: two spellings of one university key one row — the institutionKey join');

  const archive = [{
    institution: 'Testland University', school: 'Testland School of Business',
    department: 'Operations Management', address: '1 Test St, Testville, France',
    lat: 1, lng: 2, mapUrl: 'https://maps.example/x',
    facultyUrl: 'https://test.example/faculty',
  }];
  const seed = [{ institution: 'Testland University', school: 'Testland School of Business', department: 'Operations Management' }];
  const jobs = [
    { institution: 'Testland University', school: 'Testland School of Business', unit: 'Operations Management', posted: '2026-08-01', country: 'France', type: 'University' },
    // the form's school box left empty — the offline twin of
    // fillSchoolFromDirectory settles it onto the ONE schooled row
    { institution: 'Testland University', school: '', unit: 'Operations Management', posted: '2026-08-10', country: 'France' },
    // …and an acronym department folds into its expansion, the same
    // initials rule the site's search and the alert matcher apply
    { institution: 'Testland University', school: '', unit: 'OM', posted: '2026-08-14', country: 'France' },
    { institution: 'Brand New University', school: '', unit: 'Supply Chain Management', posted: '2026-08-12', country: 'Ireland', type: 'University' },
  ];
  const { rows } = buildDirectory({ archive, seed, jobs, past: [] });

  const tl = rows.filter((r) => r.institution === 'Testland University');
  eq(tl.length, 1, 'directory: the archive, the seed and three postings merge into ONE row');
  eq(tl[0].n, 3, 'directory: the school-less and the acronym posting both fold into the schooled row');
  eq(tl[0].lastPosted, '2026-08-14', 'directory: lastPosted is the newest across everything folded');
  eq(tl[0].sources, ['directory', 'postings', 'seed'], 'directory: provenance is the union');
  eq(tl[0].type, 'Business School',
    'directory: a school NAMED "…School of Business" is a business school, whatever type the posting was filed under');
  eq(tl[0].country, 'France', 'directory: the row\'s own evidence names its country');
  eq(tl[0].facultyUrl, 'https://test.example/faculty', 'directory: the archive keeps the links');

  const fresh = rows.find((r) => r.institution === 'Brand New University');
  ok(fresh && fresh.n === 1 && fresh.sources.join() === 'postings',
    'directory: a posting from a place NO source lists creates its row — and with it a new card');
  eq(directoryStats(rows).universities, 2, 'directory: the meta counts universities the way the page groups them');

  /* THE OM LIST ENRICHES, NEVER LISTS (owner, 2026-08-24). Its records fill
     `deptUrl` on the row they join and add the departments the other sources
     missed, under the same card — and a university only the OM list knows
     adds NO card, so growing the site's list stays the seed's job. */
  const om = buildDirectory({
    archive, seed, jobs: [], past: [],
    omlist: [
      { institution: 'Testland University', school: 'Testland School of Business',
        department: 'Operations Management', deptUrl: 'https://test.example/om#faculty' },
      { institution: 'Testland University', school: 'Testland School of Business',
        department: 'Decision Sciences', deptUrl: 'https://test.example/ds#faculty' },
      { institution: 'Omlist Only University', school: 'School of Business',
        department: 'Operations', deptUrl: 'https://only.example/om' },
    ],
  });
  const omTl = om.rows.filter((r) => r.institution === 'Testland University');
  eq(omTl.length, 2,
    'directory: the OM list adds the department the sources missed, under the same card');
  eq(omTl.find((r) => r.department === 'Operations Management').deptUrl,
    'https://test.example/om#faculty',
    'directory: the OM list fills deptUrl on the row it joins — the link the cards draw');
  ok(omTl.every((r) => r.sources.indexOf('omlist') !== -1),
    'directory: an OM-list row carries its provenance');
  eq(om.rows.filter((r) => r.institution === 'Omlist Only University').length, 0,
    'directory: a university only the OM list knows adds NO card — enrich, never list');

  /* THE ROW ID IS THE ONE DEFINITION IN oa-schools.js. The posting form
     files a poster's department-link correction against the same id
     (assets/oa-uniinfo.js), so the build's copy is a re-export, never a
     twin — a browser copy that drifted by one character would file
     corrections against rows that do not exist, silently, for ever. */
  eq(rowKey, SCHOOLS.directoryRowKey,
    'directory: rowKey IS OASchools.directoryRowKey — one definition, both writers');

  /* A UNIVERSITY WITH CAMPUSES IN TWO COUNTRIES NAMES NO SINGLE COUNTRY
     (owner, 2026-08-24: INSEAD's country must stay the poster's to settle).
     Campus evidence — the archive's addresses — outranks the posting votes
     and follows the campusCountries discipline: one campus country settles
     the row, several are published as `countries` with NO `country`, so a
     posting-vote majority can never dress an ambiguity up as an answer. */
  const multi = buildDirectory({
    archive: [
      { institution: 'Spanning University', school: '', department: 'Operations',
        address: '1 Rue de Test, 77300 Fontainebleau, France' },
      { institution: 'Spanning University', school: '', department: 'Operations',
        address: '1 Test Ave, Singapore 138676' },
    ],
    seed: [{ institution: 'Spanning University', school: 'School of Business', department: 'Operations' }],
    jobs: [
      // two French postings OUTVOTE the Singapore campus — and must not win
      { institution: 'Spanning University', school: '', unit: 'Operations', posted: '2026-08-01', country: 'France' },
      { institution: 'Spanning University', school: '', unit: 'Operations', posted: '2026-08-02', country: 'France' },
    ],
    past: [],
  });
  const span = multi.rows.filter((r) => r.institution === 'Spanning University');
  eq(span.length, 1, 'directory: the two campuses and the seed merge into ONE row');
  ok(!span[0].country,
    'directory: a multi-campus university has NO single country, whatever the postings vote');
  eq(span[0].countries, ['France', 'Singapore'],
    'directory: …and lists EVERY campus country instead, so each finds it in the filter');
  const one = buildDirectory({
    archive: [{ institution: 'Single Campus University', school: '', department: 'Operations',
      address: '2 Test St, Dublin, Ireland' }],
    seed: [], jobs: [], past: [],
  }).rows[0];
  eq(one.country, 'Ireland', 'directory: one campus country settles the row');
  ok(!one.countries, 'directory: …and a settled row carries no countries list');

  /* THE NEWEST POSTING'S WORD ON WHAT THE SCHOOL OFFERS — the form's
     checklist reaches the directory row, latest wins WHOLE (a school that
     stopped its PhD programme says so by unticking the box), and the
     school-less fold carries it to the schooled home. */
  const chars = buildDirectory({
    archive, seed,
    jobs: [
      { institution: 'Testland University', school: 'Testland School of Business',
        unit: 'Operations Management', posted: '2026-08-01', country: 'France',
        characteristics: ['Research seminars', 'PhD'] },
      { institution: 'Testland University', school: '',
        unit: 'Operations Management', posted: '2026-08-10', country: 'France',
        characteristics: ['Research seminars', 'MBA'] },
    ],
    past: [],
  });
  eq(chars.rows.find((r) => r.institution === 'Testland University').characteristics,
    ['Research seminars', 'MBA'],
    'directory: the checklist is the NEWEST posting\'s, whole — carried through the school-less fold');
}

/* The registered-users roster and the maintainer<->account message threads
   (owner, 2026-08-24). Two collections, two surfaces and one badge, so this
   pins: the rules against what the modules write BOTH WAYS, the address that
   cannot be forged, the queue/statistic split the badge depends on, and the
   wiring on all four pages. */
async function testUsersAndMessages() {
  const U = require(path.join(HERE, '..', 'assets', 'oa-users.js'));
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  const users = await readFile(path.join(HERE, '..', 'assets', 'oa-users.js'), 'utf8');
  const msgs = await readFile(path.join(HERE, '..', 'assets', 'oa-messages.js'), 'utf8');
  const accts = await readFile(path.join(HERE, '..', 'assets', 'oa-accounts.js'), 'utf8');
  const area = await readFile(path.join(HERE, '..', 'assets', 'oa-adminarea.js'), 'utf8');

  const keysOf = (block, from) => new Set(
    (block.slice(block.indexOf('hasOnly([', from), block.indexOf('])', block.indexOf('hasOnly([', from)))
      .match(/'[^']+'/g) || []).map((q) => q.slice(1, -1)));

  /* ------------------------------------------------------ the roster row */

  const dir = rules.slice(rules.indexOf('match /userDirectory/'),
    rules.indexOf('// ------------------------------------------------------------ messages'));
  ok(dir.length > 200, 'the rules carry a userDirectory block');
  ok(/allow read: if isAdmin\(\) \|\| isOwner\(uid\);/.test(dir),
    'the maintainer reads the roster; a person reads the one row about themselves ' +
    '— which is also what lets the browser send `first` back unchanged');
  ok(/request\.resource\.data\.email == request\.auth\.token\.email/.test(dir),
    'THE ADDRESS CANNOT BE FORGED: `email` is pinned to the caller’s own auth ' +
    'token, so a roster row says what the account really signs in as');
  ok(/request\.resource\.data\.first == resource\.data\.first/.test(dir),
    '`first` is write-once — a client cannot back-date itself in the roster');
  ok(/allow delete: if isOwner\(uid\);/.test(dir),
    'an account withdraws its OWN row and only its own, exactly as it does its ' +
    'registeredUsers mark, so the roster lists people rather than sign-ins');

  const dirKeys = keysOf(dir, 0);
  for (const k of U.ROW_KEYS) {
    ok(dirKeys.has(k), `oa-users.js reads userDirectory."${k}", and the rules allow writing it`);
  }
  eq([...dirKeys].sort(), [...U.ROW_KEYS].sort(),
    'the userDirectory rule allows exactly the roster’s four fields — a key with ' +
    'no rule is a permission-denied nobody can debug, a rule with no writer is dead');

  /* …and what the WRITER actually writes, read out of its own source. Pinning
     the rules against a declared list leaves that half unchecked: the list
     could agree with the rules perfectly while syncDirectoryRow had stopped
     sending one of them (testRowOverrides records the same lesson). */
  const syncSrc = accts.slice(accts.indexOf('function syncDirectoryRow'),
    accts.indexOf('function loadProfile'));
  ok(syncSrc.length > 200, 'the roster writer is where this thinks it is');
  for (const k of U.ROW_KEYS) {
    ok(new RegExp('(^|[{;\\s])' + k + ':|row\\.' + k + '\\s*=').test(syncSrc),
      `syncDirectoryRow really writes "${k}" — not merely declares it`);
  }

  /* ---------------------------------------------------------- the threads */

  const thr = rules.slice(rules.indexOf('match /messages/{uid}'),
    rules.indexOf('// ------------------------------------------------------ identity keys'));
  ok(thr.length > 400, 'the rules carry a messages block');
  ok(/allow read: if isAdmin\(\) \|\| isOwner\(uid\);/.test(thr),
    'a thread is readable by its two parties and nobody else');

  const threadKeys = keysOf(thr, 0);
  eq([...threadKeys].sort(), [...U.THREAD_KEYS].sort(),
    'the thread head allows exactly what oa-users.js writes on it');

  const itemsAt = thr.indexOf('match /items/');
  ok(itemsAt > 0, 'the messages themselves are a subcollection of their thread');
  const itemKeys = keysOf(thr, itemsAt);
  eq([...itemKeys].sort(), [...U.ITEM_KEYS].sort(),
    'a message allows exactly {from, body, t}');

  const items = thr.slice(itemsAt);
  ok(/isAdmin\(\) && request\.resource\.data\.from == 'admin'/.test(items)
    && /isOwner\(uid\) && request\.resource\.data\.from == 'user'/.test(items),
    '`from` is pinned to whoever is actually writing — neither side can put ' +
    'words in the other’s mouth');
  ok(/allow delete: if isAdmin\(\);/.test(items),
    'only the maintainer may RETRACT a message: a thread whose history either ' +
    'party can rewrite is not a record of anything');

  /* ------------- a reader may take a message off their OWN list ----------- */

  /* THE OWNER'S UPDATE IS ONE KEY WIDE. `hasOnly` on the diff is what keeps
     "remove it from my list" from becoming "edit what you said to me": the
     body, `from` and the timestamp are all outside it, so the maintainer's
     copy of the conversation cannot be rewritten by the person reading it. */
  const ownerItem = items.slice(items.indexOf('allow update'));
  ok(/isOwner\(uid\)/.test(ownerItem)
    && /affectedKeys\(\)\s*\n?\s*\.hasOnly\(\['hiddenForUser'\]\)/.test(ownerItem),
    'a reader may take a message off their own list \u2014 and may touch NOTHING ' +
    'else on it: not the body, not `from`, not the timestamp');
  ok(/request\.resource\.data\.hiddenForUser is bool/.test(ownerItem),
    '\u2026and it is always a BOOLEAN, never a deleted field \u2014 restoring by ' +
    'deleting the key would be refused, and "you can always put it back" ' +
    'would be false exactly once');
  eq([...keysOf(items, items.indexOf('allow update'))].sort(),
    [...U.ITEM_OWNER_KEYS].sort(),
    'the owner\u2019s branch allows exactly the one key oa-messages.js writes there');

  /* REMOVING IS A HIDE, NOT A DELETE \u2014 the whole shape of the feature, and
     the rules are where that is true rather than only in the copy. */
  ok(!/isOwner\(uid\)/.test(items.slice(items.indexOf('allow delete'))),
    'a reader can never DELETE a message: removing is a hide, so the words ' +
    'stay where they were said and the maintainer keeps the record');

  ok(/hiddenForUser: !!hide/.test(msgs) && !/FieldValue|deleteField/.test(msgs),
    'the page writes the boolean the rules test for, and never a field ' +
    'deletion the rules would refuse');
  ok(/hiddenForUser === true \? removed : kept/.test(msgs),
    '\u2026and splits the thread into what is on the list and what has been ' +
    'taken off it');

  /* HIDING IS NEVER A ONE-WAY DOOR \u2014 the trap newsOverrides and rowOverrides
     both record. Filtered off the page entirely there would be nothing left
     to press, so the removed ones sit in a collapsed panel with Restore. */
  ok(/oa-msg-removed/.test(msgs) && /Removed messages \(/.test(msgs)
    && /Restore/.test(msgs),
    'HIDING IS NEVER A ONE-WAY DOOR: the removed messages sit in a collapsed ' +
    'panel below the list, one click from Restore');

  /* A reader who removes everything still has a thread and must still be able
     to answer in it \u2014 so the reply box is drawn OUTSIDE the list. */
  ok(msgs.indexOf('oa-msg-reply') > msgs.indexOf('oa-msg-removed'),
    'the reply box is drawn after the removed panel, outside the list: a ' +
    'reader who has removed every message can still answer');
  ok(/id="oa-msg-body"/.test(msgs.slice(msgs.indexOf('oa-msg-reply'))),
    '\u2026and it really is the reply box that sits there');

  /* Remove is keyed on the DOCUMENT id read off the snapshot, never on a
     position in the list \u2014 a message arriving mid-read must not be able to
     point a button at its neighbour. */
  ok(/m\.id = d\.id/.test(msgs) && /data-id="' \+ esc\(m\.id\)/.test(msgs),
    'Remove is keyed on the message\u2019s own document id, taken from the ' +
    'snapshot rather than from an index');

  /* The maintainer's copy is the RECORD, and their panel says what the other
     person can still see \u2014 quoting back a message they no longer have is
     talking past them. */
  const ui = await readFile(path.join(HERE, '..', 'assets', 'oa-ui.css'), 'utf8');
  ok(/m\.hiddenForUser === true/.test(users) && /Removed from their list/.test(users),
    'the Admin area still shows a removed message, faded and labelled as ' +
    'exactly that: the maintainer can see what the other person no longer has');
  ok(/is-gone/.test(users) && /\.oa-u-msg\.is-gone/.test(ui),
    '\u2026at the same 0.55 .oa-dir-hidden uses, so "set aside" looks the same ' +
    'wherever this site says it');
  ok(/\.oa-msg-removed \{/.test(ui) && /background: var\(--bg-3/.test(
      ui.slice(ui.indexOf('.oa-msg-removed {'))),
    'and the removed panel paints its own ground, so it names its own ink \u2014 ' +
    'the rule oa-ui.css\u2019s own header states');
  ok(/exists\(\/databases\/\$\(database\)\/documents\/messages\/\$\(uid\)\)/.test(items),
    'A REPLY NEEDS A THREAD TO REPLY TO — without it an owner could write ' +
    'unbounded documents under their own uid that no thread head points at, ' +
    'invisible on a page that lists threads');
  ok(/allow delete: if isAdmin\(\);/.test(thr.slice(0, itemsAt)),
    'and the maintainer can remove an orphaned conversation, which the ghost ' +
    'panel offers a button for');
  ok(/oa-u-del/.test(users) && /function deleteThread/.test(users),
    '…a button that exists: the panel used to say "open one to read or delete ' +
    'it" with no delete control anywhere');
  ok(/\(!\('email' in request\.resource\.data\)/.test(dir),
    'a sign-in with no e-mail claim still gets a roster row — demanding one ' +
    'would silently omit exactly those accounts');
  ok(dir.indexOf('function rowOk()') < dir.indexOf('allow create'),
    'rowOk() is declared before the allow statements that call it');
  ok(/needsAdmin: !!\(prev && prev\.needsAdmin\)/.test(users),
    'A BROADCAST IS NOT AN ANSWER: sending to somebody who has replied leaves ' +
    'them in the queue — only reading the thread clears it');
  ok(/d\.batch\(\)/.test(users),
    'the message and its bookkeeping are ONE write — half of them landing ' +
    'would leave a message the roster does not know about');
  ok(/var draft = \(\$\('oa-u-body'\) \|\| \{\}\)\.value/.test(users),
    'and ticking a recipient does not throw away the message already typed');
  ok(/request\.resource\.data\.body\.size\(\) <= 5000/.test(items)
    && U.MAXLEN.body === 5000,
    'the body cap in the rules and the one both compose boxes enforce are the same number');

  /* The owner's two narrowed updates. THE QUEUE CANNOT BE EMPTIED BY THE
     PERSON WAITING IN IT: a reply may only RAISE needsAdmin, and marking a
     thread read may touch nothing but userUnread. */
  ok(/affectedKeys\(\)\s*\n?\s*\.hasOnly\(\['userUnread'\]\)/.test(thr)
    && /request\.resource\.data\.userUnread == 0/.test(thr),
    'the owner may mark their thread read — userUnread to zero, and nothing else');
  ok(/hasOnly\(\['lastAt', 'lastFrom', 'needsAdmin'\]\)/.test(thr)
    && /request\.resource\.data\.lastFrom == 'user'/.test(thr)
    && /request\.resource\.data\.needsAdmin == true/.test(thr),
    'and may record a reply, which must say it came from them and must RAISE ' +
    'the maintainer’s flag — never lower it');

  /* NOT under users/{uid}: Firestore ORs matching rules, so the blanket
     owner-write there could only ever be widened, and a user could forge a
     maintainer message in their own inbox. */
  ok(!/match \/users\/\{uid\}\/messages/.test(rules),
    'the threads are TOP-LEVEL — under users/{uid} the blanket owner-write ' +
    'could not be narrowed and a reply-only constraint would be unenforceable');

  /* ------------------------------------------ a statistic is not a queue */

  ok(/collection\(OAFB\.col\.messages\)\.where\('needsAdmin', '==', true\)/.test(area),
    'the badge counts the people WAITING for a reply — one equality filter, so ' +
    'no composite index');
  ok(!/collection\(OAFB\.col\.userDirectory\)/.test(area),
    'and never the roster itself: a figure nobody can clear must not inflate the badge');

  /* ---------------------------------------------------- what a CSV cannot do */

  eq(U.csvCell('=cmd|calc'), '"\'=cmd|calc"',
    'a CSV cell defuses a leading = — these are names people typed, and a ' +
    'spreadsheet would otherwise EXECUTE one');
  for (const c of ['+', '-', '@']) {
    ok(U.csvCell(c + 'x').indexOf('"\'' + c) === 0, `…and a leading ${c}`);
  }
  eq(U.csvCell('a"b'), '"a""b"', 'and doubles an internal quote');

  /* ------------------------------------------------- what a sort cannot do */

  const rows = [{ n: 'b', v: 2 }, { n: 'a', v: null }, { n: 'c', v: 1 }];
  eq(U.sortRows(rows, (r) => r.v, 'asc').map((r) => r.n).join(''), 'cba',
    'sortRows: ascending, and the unknown value LAST');
  eq(U.sortRows(rows, (r) => r.v, 'desc').map((r) => r.n).join(''), 'bca',
    'sortRows: descending, and the unknown value last in THAT direction too — ' +
    'an account with no name has nothing to compare, which is not "sorts first"');
  eq(U.fold('École'), 'ecole', 'names fold for sorting, accents and all');

  /* ------------------------------------------------------------- the wiring */

  const admin = await readFile(path.join(HERE, '..', 'admin-area.html'), 'utf8');
  ok(admin.includes('id="oa-aa-users"') && admin.includes('assets/oa-users.js'),
    'the Admin area carries the roster panel and loads the module that draws it');
  ok(/<script defer src="assets\/oa-users\.js">/.test(admin),
    '…deferred, like every other script on the page');
  ok(!/loadScript\('assets\/oa-users\.js'/.test(accts)
    && !/renderTable|csvOf|oa-u-table/.test(area),
    'the roster lives in its OWN file and the badge path never fetches it: ' +
    'oa-accounts.js pulls oa-adminarea.js into EVERY page in the maintainer’s ' +
    'browser, and roster rendering, sorting and CSV do not belong in that download');

  const page = await readFile(path.join(HERE, '..', 'messages.html'), 'utf8');
  ok(page.includes('assets/oa-messages.js') && page.includes('id="oa-msg-list"'),
    'messages.html mounts the reader’s side');
  ok(page.includes('My personal area'),
    'and is a personal-area page, with that area’s own kicker');
  ok(/OAAccounts\.setCount\('messages'/.test(msgs),
    'the page corrects the badge from the thread it has already loaded — the ' +
    'exact-where-the-data-is-loaded rule my-postings and alerts follow');
  ok(/data-count="messages"/.test(accts),
    'the account menu carries the Messages badge');
  ok(/href="messages\.html">Messages<\/a>/.test(accts),
    'and the mobile sheet does too — a menu change missed there hides the ' +
    'feature entirely on a phone');
  ok(/col\.userDirectory\)[\s\S]{0,80}\.doc\(dupUid\)\.delete\(\)/.test(accts)
    || /userDirectory'\)\s*\n?\s*\.doc\(dupUid\)\.delete\(\)/.test(accts),
    'the account merge retires the duplicate’s roster row, or one person is ' +
    'listed twice for ever — the reason its registeredUsers mark goes too');

  ok(/userDirectory: 'userDirectory'/.test(
    await readFile(path.join(HERE, '..', 'assets', 'oa-firebase.js'), 'utf8')),
    'both collection names live in OAFB.col, so a rename is one line there and ' +
    'one in the rules');

  /* Disclosed, like usageSessions before it: this is identity the maintainer
     can read, and a privacy policy that does not say so is wrong. */
  const priv = await readFile(path.join(HERE, '..', 'privacy-policy.html'), 'utf8');
  ok(/sign\s+in\s+with,\s+and\s+when\s+your\s+account\s+was\s+first\s+and\s+last\s+seen/
    .test(priv),
    'the Privacy Policy discloses the roster');
  ok(/Messages/.test(priv), '…and the messages');
}

async function testDirectoryWiring() {
  const js = await readFile(path.join(HERE, '..', 'assets', 'oa-directory.js'), 'utf8');
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');

  const block = rules.slice(rules.indexOf('match /directoryEdits/'));
  ok(block.length > 100, 'the rules carry a directoryEdits block');
  ok(/allow read: if true;/.test(block.slice(0, 400)),
    'an edit reaches EVERY visitor — a correction is not an editor-only view');
  ok(/allow create, update: if signedIn\(\)/.test(block.slice(0, 900)),
    'and ANY registered user may write one (owner, 2026-08-24)');
  ok(/request\.resource\.data\.by == request\.auth\.uid/.test(block.slice(0, 1200)),
    'attribution cannot be forged: `by` is pinned to the writing account');
  ok(/'hidden' in request\.resource\.data[\s\S]{0,220}isAdmin\(\)/.test(block),
    'hiding a row — the merge\'s takedown half — stays the maintainer\'s alone');
  ok(/allow delete: if isAdmin\(\);/.test(block.slice(0, 3200)),
    'and only the maintainer resets an edit back to the committed file');

  /* the module and the rules agree BOTH WAYS, the testRowOverrides shape:
     a field the editor writes with no rule is a permission-denied nobody can
     debug; a rule with no writer is a dead key bounded only by its cap */
  const allowed = new Set(
    (block.slice(block.indexOf('hasOnly(['), block.indexOf('])', block.indexOf('hasOnly([')))
      .match(/'[^']+'/g) || []).map((q) => q.slice(1, -1)));
  const fieldSpec = js.slice(js.indexOf('var FIELDS'), js.indexOf('var TYPE_LABEL'));
  const fieldKeys = (fieldSpec.match(/key: '([^']+)'/g) || []).map((m) => m.slice(6, -1));
  ok(fieldKeys.length >= 7, 'the editor offers the seven directory fields');
  for (const key of fieldKeys) {
    ok(allowed.has(key), `oa-directory.js may write "${key}", and the rules allow it`);
  }
  const saveBody = js.slice(js.indexOf('function save('), js.indexOf('function saveFailed('));
  const written = new Set((saveBody.match(/\bdoc\.([A-Za-z_$][\w$]*)\s*=/g) || [])
    .map((m) => m.replace(/^doc\./, '').replace(/\s*=$/, '')));
  ok(written.size >= 4, 'the bookkeeping fields save() writes are read from the source');
  for (const key of written) {
    ok(allowed.has(key), `oa-directory.js's save() writes "${key}", and the rules allow it`);
  }
  eq([...allowed].sort(),
    [...new Set([...fieldKeys, ...written, 'rowId', 'add', 'hidden', 'by', 'name', 't'])].sort(),
    'the rules allow exactly what the editor writes — nothing dead, nothing refused');

  /* the served file: unique ids (they are what an edit is keyed on) and the
     one-spelling-per-place rule every dataset holds */
  const dir = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'directory.json'), 'utf8'));
  ok(dir.length > 500, `data/directory.json holds the merged table (${dir.length} rows)`);
  eq(new Set(dir.map((r) => r.id)).size, dir.length,
    'directory row ids are unique — an edit document names exactly one row');
  const off = dir.filter((r) => {
    const c = SCHOOLS.canonColumns({
      institution: r.institution, school: r.school || '', unit: r.department || '',
    });
    return c.institution !== r.institution || c.school !== (r.school || '')
      || c.unit !== (r.department || '');
  }).map((r) => r.id);
  eq(off, [], 'data/directory.json: every row names its place the way the site does');
  const meta = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'directory-meta.json'), 'utf8'));
  const { directoryStats } = await import('./directory-model.mjs');
  eq(meta, directoryStats(dir), 'directory-meta.json agrees with the table it describes');

  /* the page mounts the whole of it, and the gates cover the page */
  const page = await readFile(path.join(HERE, '..', 'universities.html'), 'utf8');
  for (const need of ['assets/oa-list.js', 'assets/oa-list.css', 'assets/oa-directory.js',
    'assets/oa-directory.css', 'OADirectory.mount', 'oa-dir-viewmap',
    'assets/oa-uni-map.js', 'assets/oa-rowedit.js']) {
    ok(page.includes(need), `universities.html carries ${need}`);
  }
  const pt = await readFile(path.join(HERE, 'page-test.mjs'), 'utf8');
  ok(/MOBILE_PAGES = \[[^\]]*'universities\.html'/.test(pt),
    'universities.html mounts OAList now, so it is in MOBILE_PAGES — the standards\' own gate');
  /* THROUGH THE ONE DEFINITION OF THE BUILD. The workflow used to name the
     four builders as four steps; it calls build-all.mjs now, so the claim is
     followed one level down rather than weakened — the run that publishes the
     postings still rebuilds the directory, and still does it LAST, over the
     files the others just wrote. */
  const wf = await readFile(path.join(HERE, '..', '.github', 'workflows', 'oa-jobs-build.yml'), 'utf8');
  ok(wf.includes('build-all.mjs'), 'oa-jobs-build.yml runs the whole build through build-all.mjs');
  const names = BUILDERS.map((b) => b.script);
  ok(names.includes('build-directory.mjs'),
    'oa-jobs-build.yml rebuilds the directory in the run that publishes the postings');
  /* AFTER every builder that reads Firestore, because it reads the files they
     just rewrote. Stated as the dependency rather than as "last", so a builder
     that depends on the DIRECTORY in turn (build-netmap.mjs does) can be added
     after it without this guard having to be weakened to let it. */
  const lastFirebase = names.lastIndexOf(
    BUILDERS.filter((b) => b.needsFirebase).slice(-1)[0].script);
  ok(names.indexOf('build-directory.mjs') > lastFirebase,
    'and does it after the Firestore builders — it reads the files they just rewrote');
  ok(names.indexOf('build-netmap.mjs') > names.indexOf('build-directory.mjs'),
    'the university domain map is built after the directory it is derived from');

  /* THE OM-LIST ENRICHMENT IS WIRED END TO END (owner, 2026-08-24): the
     curated module is name-clean under the site's own canon, the build feeds
     it, the served file carries the links it exists to supply, and the map's
     popups draw the SAME records the cards were built from. */
  const OM = require('../assets/oa-omlist.js');
  ok(OM.LIST.length >= 180, `oa-omlist.js carries the OM list (${OM.LIST.length} universities)`);
  /* Like the seed, the module stores the OM list's OWN spellings and the
     canon maps them — so the claim is about the OUTCOME: each record's school
     lands as ONE school group on its university's card, and never puts a
     near-duplicate group beside one the site already carries (the failure the
     module header's seven curated normalisations exist to prevent — remove
     one on a regeneration and this is the test that goes red). */
  const dirSchools = new Map();
  for (const r of dir) {
    const k = SCHOOLS.institutionKey(r.institution);
    if (!dirSchools.has(k)) dirSchools.set(k, new Set());
    if (r.school) dirSchools.get(k).add(r.school);
  }
  const omMisses = [];
  for (const r of OM.directoryRows()) {
    const c = SCHOOLS.canonColumns({
      institution: r.institution, school: r.school, unit: r.department,
    });
    const held = dirSchools.get(SCHOOLS.institutionKey(c.institution));
    if (!held || !c.school) continue;   // not listed on the site (skipped by design), or a standalone school
    if (!held.has(c.school)) {
      omMisses.push(c.institution + ': "' + c.school + '" reached no school group');
      continue;
    }
    for (const s of held) {
      if (s !== c.school && SCHOOLS.similarNames(c.school, s, { university: c.institution })) {
        omMisses.push(c.institution + ': "' + c.school + '" beside "' + s + '"');
      }
    }
  }
  /* THE THIRD NAMING SWEEP, and it was the one left able to stop the site.

     `dirSchools` is built from data/directory.json, which build-directory.mjs
     merges from the POSTINGS — so a person posting a job names a school and
     this list grows. On 2026-08-25 somebody posted at The Hong Kong
     Polytechnic University and named its school "Faculty of Business", which
     is what the faculty is actually called; the OM list carries the same
     faculty under its own annotated spelling, "Faculty of Business (incl.
     Logistics and Maritime Studies)"; `similarNames` correctly reported the
     pair — and because this sweep alone was still on `eq`, the build's
     re-check went red and COMMITTED NOTHING. Three user-added postings and
     nine postings the maintainer had just approved sat unpublished through
     five consecutive builds, with the site showing neither and no reader able
     to tell why.

     It is the same finding as its two siblings above (`dupSchools`,
     `dupUnits`) — one place spelled two ways, judged by the same
     `similarNames` — and it is about TIDINESS, not about a posting being
     wrong: neither spelling makes the advertisement any less true, and the
     card renders identically either way. So it reports in the publishing
     role and fails in the PR check, exactly as they do. That is where a
     naming duplicate is meant to be settled — by an alias in oa-schools.js
     or a normalisation in oa-omlist.js — and it is settled without a queue of
     real postings being held hostage to it in the meantime. */
  tidy(omMisses,
    'every OM-list school lands on ONE school group — never a near-duplicate beside an existing one');
  for (const r of OM.directoryRows()) {
    ok(!r.deptUrl || /^https?:\/\//.test(r.deptUrl),
      `an OM-list department link is absolute http(s) or absent (${r.institution})`);
  }
  const build = await readFile(path.join(HERE, 'build-directory.mjs'), 'utf8');
  ok(build.includes("require('../assets/oa-omlist.js')") && build.includes('omlist'),
    'build-directory.mjs feeds the OM list into the merge');
  ok(dir.filter((r) => r.deptUrl).length >= 150,
    'data/directory.json carries the department links the OM list supplies');
  ok(page.includes('assets/oa-omlist.js') && page.includes('addOmDepartments'),
    'universities.html loads the module and appends its departments to the map\'s popups');
}

/* ------------------------------------------------------------------------
   The posting form's pre-fill from the site's own records, and the link
   write-back into the Universities directory (assets/oa-uniinfo.js;
   owner, 2026-08-24: "when a user enters e.g. INSEAD … fields without a
   definite answer should be left empty; other fields with unique answers
   should be pre-filled"). The pure half is pinned here; who actually SEES
   the fills is measured in page-test.mjs.                                */
async function testUniInfo() {
  const U = require('../assets/oa-uniinfo.js');

  /* fixtures shaped like INSEAD's own directory rows: one school, TWO
     departments, campuses in three countries */
  const rows = [
    { id: 'insead__school-of-business__technology-and-operations-management',
      institution: 'INSEAD', school: 'School of Business',
      department: 'Technology and Operations Management', type: 'Business School',
      countries: ['France', 'Singapore', 'United Arab Emirates'],
      deptUrl: 'https://www.insead.edu/tom',
      characteristics: ['Research seminars', 'PhD'] },
    { id: 'insead__school-of-business__decision-sciences',
      institution: 'INSEAD', school: 'School of Business',
      department: 'Decision Sciences', type: 'Business School' },
    { id: 'one-dept-college____operations',
      institution: 'One Dept College', school: '', department: 'Operations',
      type: 'University', country: 'Ireland',
      deptUrl: 'https://odc.example/ops', characteristics: ['MBA'] },
  ];

  const insead = U.facts(rows, { institution: 'INSEAD' }, SCHOOLS);
  eq(insead.school, 'School of Business',
    'uniinfo: the ONE school at the university is a definite answer — filled');
  eq(insead.unit, '', 'uniinfo: two departments on record — the poster settles it');
  eq(insead.type, 'Business School', 'uniinfo: a unanimous type is filled');
  eq(insead.country, '',
    'uniinfo: campuses in three countries — no single country, whatever any row says');
  ok(!insead.row, 'uniinfo: no row is matched while the department is unsettled');

  const tom = U.facts(rows,
    { institution: 'INSEAD', unit: 'Technology and Operations Management' }, SCHOOLS);
  ok(!!tom.row, 'uniinfo: naming the department identifies its row');
  eq(tom.rowId, 'insead__school-of-business__technology-and-operations-management',
    'uniinfo: a school-less ask finds its schooled home — the build\'s own fold');
  eq(tom.deptUrl, 'https://www.insead.edu/tom', 'uniinfo: …and serves its recorded link');
  eq(tom.characteristics, ['Research seminars', 'PhD'],
    'uniinfo: …and its recorded checklist');

  const odc = U.facts(rows, { institution: 'One Dept College' }, SCHOOLS);
  eq(odc.unit, 'Operations',
    'uniinfo: a single-department university fills the department too');
  eq(odc.country, 'Ireland', 'uniinfo: a single-country record fills the country');
  ok(!!odc.row, 'uniinfo: …and the unique fills identify the row on their own');

  const hidden = U.facts(rows.map((r) =>
    r.id === 'one-dept-college____operations' ? { ...r, _hidden: true } : r),
  { institution: 'One Dept College' }, SCHOOLS);
  ok(!hidden.row && !hidden.unit,
    'uniinfo: a row the maintainer took down answers nothing');

  const fresh = U.facts(rows,
    { institution: 'INSEAD', school: 'School of Business', unit: 'Marketing' }, SCHOOLS);
  ok(!fresh.row, 'uniinfo: a department no source lists matches no row');
  eq(fresh.rowId, SCHOOLS.directoryRowKey('INSEAD', 'School of Business', 'Marketing'),
    'uniinfo: …but a correction still knows where to file — the id the build WILL mint');

  /* the write decision: an empty field never erases, the record's own value
     needs no write, a difference is the correction */
  eq(U.deptUrlPatch('https://a.example', ''), '',
    'uniinfo: an empty link field never erases a recorded link');
  eq(U.deptUrlPatch('https://a.example', 'https://a.example'), '',
    'uniinfo: confirming the record writes nothing');
  eq(U.deptUrlPatch('https://a.example', 'https://b.example'), 'https://b.example',
    'uniinfo: a changed link is the correction');
  eq(U.deptUrlPatch('', 'https://b.example'), 'https://b.example',
    'uniinfo: a link where none was recorded is one too');

  /* the overlay: the SAME read-time correction layer universities.html
     applies, so the record offered to the next poster is the record the
     site actually shows */
  const over = U.overlay(rows, {
    'insead__school-of-business__technology-and-operations-management': {
      rowId: 'insead__school-of-business__technology-and-operations-management',
      by: 'u1', name: 'A User', t: 5,
      deptUrl: 'https://corrected.example/tom', country: 'France',
    },
  });
  const oTom = over.find((r) =>
    r.id === 'insead__school-of-business__technology-and-operations-management');
  eq(oTom.deptUrl, 'https://corrected.example/tom',
    'uniinfo: an edit overrides the committed link');
  ok(!oTom.countries,
    'uniinfo: an editor who NAMED a country retires the multi-campus abstention');
  eq(U.facts(over,
    { institution: 'INSEAD', unit: 'Technology and Operations Management' },
    SCHOOLS).deptUrl,
  'https://corrected.example/tom',
  'uniinfo: the facts read the OVERLAID record — a correction reaches the next poster');

  /* the module and the directory page cannot disagree about what an edit
     may change — pinned against oa-directory.js's own FIELDS list */
  const dirJs = await readFile(path.join(HERE, '..', 'assets', 'oa-directory.js'), 'utf8');
  const fieldSpec = dirJs.slice(dirJs.indexOf('var FIELDS'), dirJs.indexOf('var TYPE_LABEL'));
  const fieldKeys = (fieldSpec.match(/key: '([^']+)'/g) || []).map((m) => m.slice(6, -1));
  eq(U.EDIT_FIELDS.slice().sort(), fieldKeys.slice().sort(),
    'uniinfo: the form-side overlay reads exactly the fields the directory page edits');

  /* the write stays inside the rules: every key commit() puts on the
     document has a directoryEdits rule, and the write is a MERGE so a
     document holding somebody's other corrections keeps them */
  const src = await readFile(path.join(HERE, '..', 'assets', 'oa-uniinfo.js'), 'utf8');
  const rules = await readFile(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  const block = rules.slice(rules.indexOf('match /directoryEdits/'));
  const allowed = new Set(
    (block.slice(block.indexOf('hasOnly(['), block.indexOf('])', block.indexOf('hasOnly([')))
      .match(/'[^']+'/g) || []).map((q) => q.slice(1, -1)));
  const commitBody = src.slice(src.indexOf('function commit('),
    src.indexOf('return {', src.indexOf('function commit(')));
  const docLit = /var doc = \{([\s\S]*?)\};/.exec(commitBody);
  ok(!!docLit, 'uniinfo: commit() builds one document literal the test can read');
  const written = (docLit[1].match(/(\w+):/g) || []).map((m) => m.slice(0, -1));
  ok(written.length >= 5, 'uniinfo: the document carries the link and its bookkeeping');
  for (const key of written) {
    ok(allowed.has(key), `uniinfo: commit() writes "${key}", and the rules allow it`);
  }
  ok(/\{ merge: true \}/.test(commitBody),
    'uniinfo: the write is a MERGE — other corrections on the document survive');
  eq(U.COLLECTION, 'directoryEdits',
    'uniinfo: the write lands in the collection the directory page reads');

  /* the wiring: the page carries the field and the module, the form mounts
     the pre-fill, files the correction, and never lets the link into the
     submission document (whose rules pin its field set) */
  const page = await readFile(path.join(HERE, '..', 'post-a-job.html'), 'utf8');
  for (const need of ['assets/oa-uniinfo.js', 'id="f-deptUrl"',
    'id="f-deptUrl-note"', 'id="f-chars-note"']) {
    ok(page.includes(need), `post-a-job.html carries ${need}`);
  }
  const form = await readFile(path.join(HERE, '..', 'assets', 'oa-jobform.js'), 'utf8');
  ok(form.includes('OAUniInfo.wire'),
    'oa-jobform.js mounts the records pre-fill beside the cascade');
  ok(form.includes('OAUniInfo.commit'),
    'oa-jobform.js files the link correction after a posting is accepted');
  ok(!/\bout\.deptUrl\b/.test(form),
    'the link never joins the submission document — jobSubmissions\' rules pin its field set');
  ok(/fillNames: !EDIT_ID/.test(form),
    'edit mode never fills a name field — a posting whose owner left the school ' +
    'off must not gain one because the form was opened');
}

/* The school, the department, the department's own page, at least one
   characteristic, and the area coordinator / chair pair are MANDATORY FOR A
   NEW POSTING (owner, 2026-09-02) — and only there. An EDIT is exempt by
   design: every posting that predates the rule, the crawled mirrors among
   them, must stay correctable without inventing a chair nobody named — which
   is also what keeps the maintainer's sheet-mirror hand-over saveable.
   Pinned here from the sources; the browser halves — the refusal with an
   error on each of the six, and an old posting still saving with the marks
   lifted — are measured in page-test.mjs.

   AND A SCHOOL THAT REPEATS THE UNIVERSITY IS NO SCHOOL. Asking for a school
   on every posting meets the places that have none — INSEAD, IE Business
   School — and the owner's answer is that they repeat the institution's name
   in the School box, which must not publish twice. `schoolRepeatsInstitution`
   in oa-schools.js is the ONE rule, and assemble() applies it as the last word
   of every canon path, so the form's preview, the review card, the build and
   the directory cannot disagree about it. */
async function testMandatoryPostingFields() {
  const page = await readFile(path.join(HERE, '..', 'post-a-job.html'), 'utf8');
  const tagOf = (id) => {
    const at = page.indexOf(`id="${id}"`);
    ok(at > -1, `post-a-job.html carries #${id}`);
    return page.slice(page.lastIndexOf('<', at), page.indexOf('>', at) + 1);
  };
  for (const id of ['f-school', 'f-unit', 'f-deptUrl', 'f-chairName', 'f-chairEmail']) {
    ok(/\brequired\b/.test(tagOf(id)),
      `post-a-job.html: #${id} is marked required for a new posting`);
  }
  /* the CLASS ATTRIBUTE is counted, not the bare string — the page's own
     comment explains the marks by name, and a guard that cannot tell the
     explanation from the thing is this file's recorded trap */
  eq((page.match(/class="oa-req oa-req-new"/g) || []).length, 6,
    'exactly the six new-posting-only fields carry the oa-req-new mark ' +
    '— the class enterEditMode() lifts, so a field marked with the plain ' +
    'oa-req would stay starred on an edit it does not bind');
  ok(/oa-req-new/.test(page.slice(page.indexOf('id="lbl-chars"'),
    page.indexOf('</span>', page.indexOf('id="lbl-chars"')))),
    'the characteristics GROUP is one of the six — no required attribute ' +
    'can sit on a checkbox group, so the mark is the whole of its declaration');
  ok(/repeat the institution&rsquo;s name here/.test(page),
    'the School hint tells a place with no separate school what to type');

  const form = await readFile(path.join(HERE, '..', 'assets', 'oa-jobform.js'), 'utf8');
  const collect = form.slice(form.indexOf('function collect('),
    form.indexOf('function makeRef('));
  for (const msg of [
    'Please give the school.',
    'Please give the department, area or group.',
    "Please give your department's own web page.",
    'Please tick at least one characteristic.',
    'Please name the area coordinator or department chair.',
    'Please give their e-mail address.',
  ]) {
    const at = collect.indexOf(msg);
    ok(at > -1, `collect() refuses a new posting without: "${msg}"`);
    ok(/EDIT_ID/.test(collect.slice(Math.max(0, at - 400), at)),
      `…and that requirement is scoped to a NEW posting (EDIT_ID exempts ` +
      `an edit): "${msg}"`);
  }
  ok(collect.includes("'Please give a school, department, area or group.'"),
    'an EDIT keeps the older either-or rule on the two name fields');

  const editMode = form.slice(form.indexOf('function enterEditMode('),
    form.indexOf('function boot('));
  ok(editMode.includes('.oa-req-new'),
    'enterEditMode() lifts the new-posting-only * marks');
  ok(editMode.includes("removeAttribute('required')") &&
     editMode.includes("'f-school', 'f-unit'"),
    '…and the required attributes with them, the two name fields included, ' +
    'so the document never claims a requirement collect() does not enforce there');

  /* the repeated school, judged by the shared rule */
  const S = require(path.join(HERE, '..', 'assets', 'oa-schools.js'));
  ok(S.schoolRepeatsInstitution('INSEAD', 'INSEAD'), 'INSEAD said twice is a repeat');
  ok(S.schoolRepeatsInstitution('ie business school', 'IE Business School'),
    'case does not hide one');
  ok(S.schoolRepeatsInstitution('Indian School of Business', 'Indian School of Business (ISB)'),
    'nor a trailing acronym');
  ok(S.schoolRepeatsInstitution('University of Hong Kong', 'The University of Hong Kong'),
    'nor a leading The');
  ok(!S.schoolRepeatsInstitution('ESSEC Business School', 'ESSEC'),
    'ESSEC Business School at ESSEC is a real school, not a repeat — the alias-aware ' +
    'institutionKey reads it as ESSEC itself, which is why the rule is a LITERAL fold');
  ok(!S.schoolRepeatsInstitution('', 'INSEAD') && !S.schoolRepeatsInstitution('INSEAD', ''),
    'an empty name repeats nothing');

  const folded = S.canonColumns({ institution: 'IE Business School', school: 'IE Business School', unit: 'Operations' });
  eq([folded.institution, folded.school, folded.unit], ['IE Business School', '', 'Operations'],
    'canonColumns() drops the repeated school and keeps the rest');
  eq(S.canonPlace(folded), folded, 'and a second pass changes nothing');
  eq(S.canonPlace({ institution: 'ETH Zurich', school: 'ETH Zurich', unit: 'Management, Technology and Economics' }).school, '',
    'canonPlace() folds it too, AFTER the curated school fill that would put ' +
    'ETH Zurich\u2019s own name back — the fold is the last word');
  eq(S.canonColumns({ institution: 'ESSEC', school: 'ESSEC Business School', unit: 'Operations' }).school,
    'ESSEC Business School', 'while a school of the same family name is kept');

  /* THE BUILD IS THE TWIN: a document whose school repeats its institution
     publishes the line ONCE, so the card never reads "INSEAD — INSEAD, …" */
  const twin = rowFromSubmission({ ...GOOD, institution: 'INSEAD', school: 'INSEAD', unit: 'Decision Sciences', department: '' });
  ok(!!twin, 'the build still publishes a posting whose school repeated its institution');
  eq([twin.school || '', twin.department], ['', 'Decision Sciences'],
    'rowFromSubmission() publishes the department line without the repeated name');

  ok(/S\.schoolRepeatsInstitution\(s,/.test(form),
    'the form\u2019s own preview reads the SAME rule, so what the poster is shown ' +
    'is what will publish');
  ok(/not repeated as the school/.test(form),
    '…and says so in words, because the poster was told to type it');

  /* THE PICKER MUST NOT UNDO IT ON BLUR. snapPlace() writes the canon's
     answer back into the boxes as a field is left, and the canon's answer
     for a repeated school is '' — which would blank the box the hint had
     just asked the poster to fill, and the mandatory check would refuse it
     a moment later. The box keeps the typed repeat; the fold happens on
     send, and the browser half measures exactly that. */
  const picker = await readFile(path.join(HERE, '..', 'assets', 'oa-place-picker.js'), 'utf8');
  const snap = picker.slice(picker.indexOf('function snapPlace('), picker.indexOf('function inferSchool('));
  ok(/schoolRepeatsInstitution/.test(snap),
    'the place picker’s settle-on-blur keeps a school that repeats the institution in the box');

  /* …and the REVIEW CARD's own twin of the join folds it too, or the
     maintainer's heading, edit preview and approval echo would all read the
     name twice while settlePlace publishes it once. */
  const panel = await readFile(path.join(HERE, '..', 'assets', 'oa-jobreview.js'), 'utf8');
  const cardJoin = panel.slice(panel.indexOf('function joinDepartment('), panel.indexOf('function $('));
  ok(/schoolRepeatsInstitution/.test(cardJoin),
    'the review card’s preview of the line folds a repeated school as settlePlace will on save');
  const calls = [];
  for (let at = panel.indexOf('joinDepartment(', panel.indexOf('function $(')); at > -1;
    at = panel.indexOf('joinDepartment(', at + 1)) calls.push(panel.slice(at, at + 160));
  ok(calls.length >= 4, `the card joins the line in ${calls.length} places`);
  for (const c of calls) {
    ok(/institution|inst\.value/.test(c),
      `…and each passes the institution, so no surface joins the raw boxes: ${c.split('\n')[0]}`);
  }
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

  /* …and the same rule ONE COLUMN AT A TIME: a tab read without its header
     cannot see the deadline cell or the notes column, so those are carried
     rather than published as empty (testJobMarketSheetCarry has the defect
     itself). Wiring, because the sync needs the workbook to run for real. */
  ok(/carryUnreadColumns\(collected\.rows, known, tabReads\)/.test(sync),
    'the sync carries the columns a degraded read could not see');
  ok(/carriedBack\.rows/.test(sync) && !/fillSchoolFromDirectory\(r, vocab\)[\s\S]{0,120}collected\.rows\n/.test(sync),
    'and everything downstream reads the CARRIED rows — a carry nothing consumes ' +
    'is a fix that is not applied');
  ok(/tabReads: perTab\.map/.test(sync),
    'the read reports how each tab was read, which is what says a carry is needed');
  ok(/read without its header/.test(sync),
    'and a degraded read is named in the log — the last one went out as eight ' +
    'phantom edits with nothing anywhere saying why');

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
  <tr><th>College</th><td>College of Business</td></tr>
  <tr><th>Department</th><td>Management Sciences</td></tr>
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

  // where the page files the post — the school and department it states
  eq(ad.school, 'College of Business', 'the labelled College is read as the school');
  eq(ad.department, 'Management Sciences', 'and the labelled Department as the department');
  const orgEcho = parseAdvert('<h1>Post</h1>' +
    '<script type="application/ld+json">{"@type":"JobPosting","title":"Post",' +
    '"hiringOrganization":{"@type":"Organization","name":"Example University"}}</script>' +
    '<table><tr><th>Department</th><td>Example University</td></tr></table>');
  eq(orgEcho.department, '',
    'a "department" that merely repeats the organisation\'s own name is nothing');
}

function testAdvertsPlace() {
  /* Classifying the ad's stated names into the site's three — university,
     school, department — against the site's own vocabulary. CURATED, NEVER
     GUESSED: every resolution below either comes from the directory
     unambiguously or leaves the name exactly as stated. */
  const VOCAB = { byUniversity: {
    'University of California, Berkeley': {
      schools: ['Haas School of Business'],
      bySchool: { 'Haas School of Business': ['Operations and Information Technology Management'] },
    },
    'Example University': {
      schools: ['College of Business'],
      bySchool: { 'College of Business': ['Management Sciences'] },
    },
    'Other University': {
      schools: ['College of Business'],
      bySchool: { 'College of Business': [] },
    },
  } };

  /* THE INTERFOLIO SHAPE: the hiring organisation IS the school. The
     directory names exactly one home for Haas, so the classification says
     which university the posting belongs to — the owner's "categorize the
     University correctly" case. */
  const haas = advertPlace({ institution: 'Haas School of Business' }, VOCAB);
  eq(haas.institution, 'University of California, Berkeley',
    'a hiring organisation that is a school is filed under its university');
  eq(haas.school, 'Walter A. Haas School of Business',
    'with itself as the school, in the site\'s own canonical spelling');

  /* A school name TWO universities use identifies neither. */
  const shared = advertPlace({ institution: 'College of Business' }, VOCAB);
  eq(shared.school, '', 'a school name two universities share resolves no pairing');

  /* An empty school settled from the directory by the department it houses —
     the fillSchoolFromDirectory discipline. */
  const housed = advertPlace({
    institution: 'University of California, Berkeley',
    department: 'Operations and Information Technology Management',
  }, VOCAB);
  eq(housed.school, 'Haas School of Business',
    'an empty school is settled from the directory by its department');
  eq(housed.unit, 'Operations and Information Technology Management',
    'and the department keeps its own field');

  /* The stated three pass through canonColumns — the posting form's own
     canon — so the card offers the spelling the site publishes. */
  const stated = advertPlace({
    institution: 'Example University', school: 'College of Business',
    department: 'Management Sciences',
  }, VOCAB);
  eq(stated.institution, 'Example University', 'the university is kept');
  eq(stated.school, 'College of Business', 'the school is kept');
  ok(advertPlace({}, VOCAB) === null, 'a page that stated nothing classifies to nothing');

  /* The host inventory — the owner's first question (2026-08-24): the
     distinct websites this and last market year's postings are advertised
     on, drive/docs links EXCLUDED (user-uploaded copies whose address
     changes every time, not job boards). */
  const rows = [
    { id: 'a', year: 2027, adUrl: 'https://www.jobs.chronicle.com/job/1/' },
    { id: 'b', year: 2026, adUrl: 'https://jobs.chronicle.com/job/2/' },
    { id: 'c', year: 2026, adUrl: 'https://drive.google.com/file/d/x/view' },
    { id: 'd', year: 2026, adUrl: 'https://docs.google.com/document/d/y' },
    { id: 'e', year: 2026, adUrl: 'https://www.higheredjobs.com/faculty/details.cfm?JobCode=1' },
    { id: 'f', year: 2025, adUrl: 'https://old.example.edu/ad' },
    { id: 'g', year: 2026, adUrl: 'https://psu.wd1.myworkdayjobs.com/en-US/S/job/P/Slug-1' },
    { id: 'h', year: 2026, adUrl: '' },
  ];
  const report = advertHostsReport(rows, { years: [2027, 2026] });
  const hosts = report.hosts.map((h) => h.host);
  ok(hosts.includes('jobs.chronicle.com'), 'a board the postings link is listed');
  eq(report.hosts.find((h) => h.host === 'jobs.chronicle.com').postings, 2,
    'counted once per posting, www folded onto the bare host');
  ok(!hosts.some((h) => /google\.com$/.test(h)),
    'drive and docs links are excluded — user-uploaded copies, not job boards');
  ok(!hosts.includes('old.example.edu'), 'a year outside the window is not counted');
  eq(report.hosts.find((h) => h.host === 'higheredjobs.com').read, 'higheredjobs pipeline',
    'each host names the pipeline that reads it');
  ok(/Workday/.test(report.hosts.find((h) => h.host === 'psu.wd1.myworkdayjobs.com').read),
    'a Workday tenant is marked as read from its JSON endpoint');
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
  eq(block.school, 'College of Business', 'and the school the page states');
  eq(block.department, 'Management Sciences', 'and its department');
  const classified = adBlock(cache.ads[key], { adUrl: link,
    place: { institution: 'Example University', school: 'College of Business', unit: 'Management Sciences' } });
  eq(classified.place.institution, 'Example University',
    'and the vocabulary\'s classification rides on the block for the card to offer');
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
  eq((verify.match(/\.doc\([^)]*\)\.set\(/g) || []).length, 1,
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
  ok(panel.includes('data-ad-place'),
    'the vocabulary\'s classification gets its adopt-the-names button');
  ok(panel.includes('data-ad-use-school') && panel.includes('data-ad-use-unit'),
    'and the stated school and department get a button each');
  const mailer = await readFile(path.join(HERE, 'jobreview-mailer.mjs'), 'utf8');
  ok(mailer.includes('advertHtml(doc)'), 'and the review e-mail says the same thing');
  ok(mailer.includes('vocabulary files it as'),
    'the classification included — the e-mail informs the same decision');
  /* The pending queue is what the maintainer is actively deciding, so the
     queue pass spends the run's budget FIRST (owner, 2026-08-24). */
  ok(verify.indexOf('await queuePass') < verify.indexOf('await publishedPass'),
    'the queue pass runs before the published one — pending cards first');

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

/* ------------------------------- "am I the script being run?", on Windows too */

async function testCliMainGuards() {
  /* Every CLI here used to gate its main block by gluing "file://" onto
     process.argv[1] and comparing that to import.meta.url — true on the
     Linux runners, NEVER true on Windows (a URL glued from a backslashed
     path is not the module's URL), so on the maintainer's own machine every
     local mode — the selftest included — loaded, matched nothing, and
     exited 0 in silence. A no-op with a green exit code. The comparison
     lives in ONE place now (_main.mjs, both sides converted to paths, win32
     case-folded), and the glued pattern is pinned out of the whole
     directory. The needle is assembled, not written, so this check cannot
     catch its own description — the lesson the private-key guard's comment
     records. */
  const NEEDLE = 'file://' + '${process.' + 'argv[1]}';
  const dir = (await import('node:fs/promises')).readdir;
  for (const name of (await dir(HERE)).filter((n) => n.endsWith('.mjs'))) {
    const src = await readFile(path.join(HERE, name), 'utf8');
    ok(!src.includes(NEEDLE),
      `${name}: no hand-glued file:// comparison — it is never true on Windows`);
    if (name !== '_main.mjs' && src.includes('isMain(import.meta.url)')) {
      ok(src.includes("from './_main.mjs'"),
        `${name}: the guard is the shared one, not a copy`);
    }
  }

  /* The helper itself, driven in-process: the script node was asked to run
     answers true — through the same conversion on every platform — an
     imported module answers false, and garbage answers false rather than
     throwing inside its host. */
  const { pathToFileURL } = await import('node:url');
  ok(isMain(pathToFileURL(path.resolve(process.argv[1])).href),
    'the running script knows it is the running script');
  ok(!isMain(pathToFileURL(path.join(HERE, 'jobs-model.mjs')).href),
    'an imported module knows it is not');
  ok(!isMain('not a url') && !isMain('https://example.org/x.mjs'),
    'and nothing here can throw inside a module that imports it');
}

/* -------------------------- the edit you just saved, shown before the build */

async function testFreshEcho() {
  const F = require(path.join(HERE, '..', 'assets', 'oa-fresh.js'));

  /* THE ECHO MAY ONLY SAY WHAT THE BUILD WOULD PUBLISH. Its field list is a
     subset of the served row's, its Apply-by line is composed by a browser
     twin of composeApplyBy, and its link rules are browser twins of
     jobs-model's — parity-pinned here, like every vendored copy. */
  eq(F.FIELDS.filter((k) => !PUBLIC_FIELDS.includes(k)), [],
    'every field the echo may set is one the served row carries');
  for (const k of ['id', 'year', 'posted', 'addedAt', 'source', 'ref', 'owner', 'featured']) {
    ok(!F.FIELDS.includes(k), `and the posting's identity/bookkeeping (${k}) is not echoable`);
  }
  for (const c of [
    { untilFilled: true, applyByNote: '' },
    { untilFilled: true, applyByNote: 'Early applications welcome.' },
    { untilFilled: false, applyByDate: '2026-10-15', applyByNote: '' },
    { untilFilled: false, applyByDate: '2026-10-15', applyByNote: 'CV and two letters.' },
    { untilFilled: false, applyByDate: '', applyByNote: 'Rolling review.' },
  ]) {
    eq(F.composeApplyBy(c), composeApplyBy(c),
      'the echoed Apply-by line is the line the build will publish');
  }
  /* ---- AND THE POSTING JUST APPROVED, which the echo ADDS ---------------

     Owner, 2026-08-26: "when I press a job under review to become public, it
     should immediately show up in the list of job postings available to the
     public." Approving writes Firestore; the BUILD turns that into a row, and
     until it runs the posting is in neither place — out of the queue and not
     yet on the site, which reads exactly like an approval that did not save.

     So the panel echoes the row. That is only defensible while the echoed row
     IS the row the build publishes, so `OAFresh.approvedRow` is pinned against
     jobreview.mjs's own over a case table covering every branch it has. A
     mismatch here is a private fiction shown to the maintainer for a build,
     which is what this module's third promise forbids. */
  const APPROVE_CASES = [
    ['a plain posting', { id: 'p-1', year: 2027, posted: '2026-08-21',
      institution: 'Stanford University', school: 'School of Engineering',
      unit: 'Management Science and Engineering', department: 'stale',
      levels: ['Assistant Professor'], country: 'United States',
      applyByDate: '2026-10-05', applyBy: '', comments: 'Two letters.',
      source: 'jobmarket-sheet' }, {}],
    ['no closing date at all', { id: 'p-2', year: 2026, posted: '2026-01-02',
      institution: 'Tulane University', school: '', unit: 'Management Science',
      department: 'Management Science', applyBy: '' }, {}],
    ['its own open-ended words kept', { id: 'p-3', year: 2026, posted: '2026-01-02',
      institution: 'Emory University', school: '', unit: '', department: 'OM',
      applyBy: 'Open until filled. Apply early.' }, {}],
    ['an edit moves the names, and our link follows', { id: 'p-4', year: 2026,
      posted: '2026-01-02', institution: 'MIT Sloan', school: '',
      unit: 'Operations Management', department: 'OM',
      furtherInfoUrl: universitiesLink('MIT Sloan') },
      { edits: { institution: 'Massachusetts Institute of Technology (MIT)' } }],
    ['a review date on the closing date is dropped', { id: 'p-5', year: 2026,
      posted: '2026-01-02', institution: 'Duke University', school: '', unit: 'OM',
      applyByDate: '2026-05-01', reviewDate: '2026-05-01' }, {}],
    ['a review date before it is kept', { id: 'p-6', year: 2026, posted: '2026-01-02',
      institution: 'Duke University', school: '', unit: 'OM',
      applyByDate: '2026-05-01', reviewDate: '2026-04-01' }, {}],
    ['an e-mail never reaches the echo either', { id: 'p-7', year: 2026,
      posted: '2026-01-02', institution: 'Yale University', school: '', unit: 'Operations',
      comments: 'Write to dean@yale.edu about it', adUrl: 'https://x.example/a@b' }, {}],
    ['dated from the approval', { id: 'p-8', year: 2026, posted: '2026-01-02',
      institution: 'Duke University', school: '', unit: 'OM', addedAt: '2026-08-01T00:00:00Z' },
      { queuedAt: '2026-08-02T00:00:00Z', reviewedAt: '2026-08-26T10:40:00.000Z' }],
    ['a grandfathered document keeps its date', { id: 'p-9', year: 2026,
      posted: '2026-01-02', institution: 'Duke University', school: '', unit: 'OM',
      addedAt: '2026-08-01T00:00:00Z' },
      { queuedAt: '2026-08-02T00:00:00Z', reviewedAt: '2026-08-02T00:00:00Z' }],
    ['an edited line saying "until filled" takes the date with it', { id: 'p-10',
      year: 2026, posted: '2026-01-02', institution: 'Duke University', school: '',
      unit: 'OM', applyByDate: '2026-05-01' }, { edits: { applyBy: 'Until filled.' } }],
    ['a row with no parts keeps the line it arrived with', { id: 'p-11', year: 2026,
      posted: '2026-01-02', institution: 'Duke University', school: '', unit: '',
      department: 'OM/SCM' }, {}],
    ['edited entry levels', { id: 'p-12', year: 2026, posted: '2026-01-02',
      institution: 'Duke University', school: '', unit: 'OM', levels: ['Other Ranks'] },
      { edits: { levels: ['Assistant Professor'] } }],
  ];
  for (const [name, row, doc] of APPROVE_CASES) {
    const want = approvedRow(row, doc);
    const got = F.approvedRow(row, doc, { canonColumns });
    eq(JSON.stringify(got, Object.keys(want).sort()),
      JSON.stringify(want, Object.keys(want).sort()),
      `the echoed approved row is the row the build publishes — ${name}`);
    eq(Object.keys(got).filter((k) => !(k in want)), [],
      `and carries nothing the build would not — ${name}`);
  }

  /* An added echo INSERTS; it stands down the moment the build serves the
     row, which is the same bargain every other echo here makes. */
  {
    const NOW = Date.parse('2026-08-26T12:00:00Z');
    const added = { id: 'p-add', year: 2026, institution: 'Late University' };
    const map = { 'p-add': { t: NOW - 1000, ref: '', removed: false, added, f: {} } };
    const before = [{ id: 'other', institution: 'Already Served' }];
    const got = F.overlay(before, JSON.parse(JSON.stringify(map)), { now: NOW });
    eq(got.rows.length, 2, 'an approved posting the build has not served yet is ADDED');
    eq(got.spent, [], 'and the echo stays until it has');
    const served = F.overlay(before.concat([{ id: 'p-add', institution: 'Late University' }]),
      JSON.parse(JSON.stringify(map)), { now: NOW });
    eq(served.rows.length, 2, 'once the build serves it the echo adds nothing');
    eq(served.spent, ['p-add'], 'and is spent');
    /* A build that STARTED comfortably after the approval — past
       BUILD_GRACE_MS — has the last word, as for every echo here. */
    const older = { 'p-add': { ...map['p-add'], t: NOW - 5 * 60 * 1000 } };
    const late = F.overlay(before, JSON.parse(JSON.stringify(older)),
      { now: NOW, builtAt: new Date(NOW - 60 * 1000).toISOString() });
    eq(late.spent, ['p-add'],
      'a build that STARTED after the approval has the last word, as for every echo');
    eq(late.rows.length, 1, 'and the echo adds nothing once it has stood down');
  }

  eq(F.universitiesLink('Penn State'), universitiesLink('Penn State'),
    'the regenerated Further-info link is the build\'s own');
  for (const u of [universitiesLink('X'), 'https://example.edu/jobs/1', '']) {
    eq(F.ownUniversitiesLink(u), ownUniversitiesLink(u),
      'and "is this link ours to regenerate" answers the same both sides');
  }

  /* echoFields: the published shape of what the form wrote — and a document
     carrying a fresh FILE upload echoes no advert link, because the build
     replaces it with the Drive link. */
  const doc = {
    institution: 'Example University', school: 'School of Business',
    unit: 'Operations', department: 'School of Business, Operations',
    type: 'University', levels: ['Assistant Professor'], country: 'United States',
    untilFilled: false, applyByDate: '2026-10-15', applyByNote: '',
    reviewDate: '2026-09-01', comments: 'Two positions.', characteristics: ['PhD'],
    adUrl: 'https://example.edu/ad', postedAtUrl: '',
  };
  const echoed = F.echoFields(doc);
  eq(echoed.applyBy, composeApplyBy(doc), 'the line rides with its date');
  eq(echoed.adUrl, 'https://example.edu/ad', 'a linked advert is echoed');
  ok(!('adUrl' in F.echoFields({ ...doc, adUploadPath: 'up/x.pdf' })),
    'while a fresh file upload echoes no link at all');
  eq(Object.keys(echoed).filter((k) => !F.FIELDS.includes(k)), [],
    'and echoFields emits nothing outside the pinned list');

  /* THE OVERLAY, driven pure. A saved edit shows at once; a takedown removes
     the row; and the echo STANDS DOWN the moment its job is done — the served
     row already agrees, a build begun after the save has published (its word
     wins even where it disagrees), or an hour has passed. */
  const store = (() => {
    let bag = {};
    return { getItem: (k) => bag[k] || null, setItem: (k, v) => { bag[k] = v; } };
  })();
  const T0 = 1_000_000_000_000;
  F.stash({ docId: 'doc-1', ref: 'OA-JOB-260101-XXXX', fields: echoed },
    { store, now: T0 });
  F.stash({ docId: '2026-old-university-20250901', removed: true }, { store, now: T0 });

  const served = [
    { id: '2026-example-university-20250901', ref: 'OA-JOB-260101-XXXX',
      institution: 'Exmaple Univresity', applyBy: 'Until filled.', applyByDate: '',
      furtherInfoUrl: universitiesLink('Exmaple Univresity') },
    { id: '2026-old-university-20250901', institution: 'Old University' },
    { id: '2026-other-university-20250901', institution: 'Other University',
      furtherInfoUrl: 'https://example.edu/about' },
  ];
  const map = JSON.parse(store.getItem(F.KEY));
  const got = F.overlay(served.map((r) => ({ ...r })), map, { now: T0 + 5000, builtAt: '' });
  const hit = got.rows.find((r) => r.ref === 'OA-JOB-260101-XXXX');
  eq(hit.institution, 'Example University', 'the saved edit shows immediately');
  eq(hit.applyByDate, '2026-10-15', 'its deadline with it');
  eq(hit.applyBy, composeApplyBy(doc), 'and the line the page prints');
  eq(hit.furtherInfoUrl, universitiesLink('Example University'),
    'our own Further-info link follows the corrected name');
  ok(!got.rows.some((r) => r.id === '2026-old-university-20250901'),
    'a taken-down posting is off the list at once');
  eq(got.rows.find((r) => r.id === '2026-other-university-20250901').furtherInfoUrl,
    'https://example.edu/about', 'a link the poster gave is never touched');
  eq(got.spent, [], 'and nothing stands down while the build has not landed');

  // the row the poster gave a link: institution echo must not regenerate it
  const posterLink = F.overlay(
    [{ id: 'x', ref: 'OA-JOB-260101-XXXX', furtherInfoUrl: 'https://example.edu/about' }],
    map, { now: T0 + 5000, builtAt: '' });
  eq(posterLink.rows[0].furtherInfoUrl, 'https://example.edu/about',
    'even when the echo renames the institution');

  // published: the served row now carries every echoed value
  const landedRow = { id: 'y', ref: 'OA-JOB-260101-XXXX', ...echoed,
    furtherInfoUrl: universitiesLink('Example University') };
  const landed = F.overlay([{ ...landedRow }], map, { now: T0 + 5000, builtAt: '' });
  ok(landed.spent.includes('doc-1'), 'an echo the build has published stands down');

  // superseded: a build GENERATED comfortably after the save wins outright
  const later = F.overlay(served.map((r) => ({ ...r })), map,
    { now: T0 + 300000, builtAt: new Date(T0 + F.BUILD_GRACE_MS + 1000).toISOString() });
  ok(later.spent.includes('doc-1'),
    'a build begun after the save has the last word, even where it disagrees');
  eq(later.rows.find((r) => r.ref === 'OA-JOB-260101-XXXX').institution,
    'Exmaple Univresity', 'and the served value stands');

  // aged out: an hour on, the echo stands down whatever happened
  const aged = F.overlay(served.map((r) => ({ ...r })), map,
    { now: T0 + F.TTL_MS + 1, builtAt: '' });
  ok(aged.spent.includes('doc-1'), 'an echo an hour old stands down');

  // a takedown whose row the build already removed is spent, not kept for ever
  const removedGone = F.overlay([{ id: 'z' }], map, { now: T0 + 5000, builtAt: '' });
  ok(removedGone.spent.includes('2026-old-university-20250901'),
    'a removal the build has published stands down');

  ok(!F.isJobsUrl('/data/placements.json') && F.isJobsUrl('/data/jobs.json'),
    'the echo overlays the jobs dataset and nothing else');

  /* THE WIRING, read from the source — a stash nobody applies, or an apply
     nobody feeds, is the silent failure this feature exists to end. */
  const list = await readFile(path.join(HERE, '..', 'assets', 'oa-list.js'), 'utf8');
  ok(list.includes('OAFresh.apply(url, data)'),
    'every dataset read through OAList.load passes through the echo');
  const form = await readFile(path.join(HERE, '..', 'assets', 'oa-jobform.js'), 'utf8');
  ok(form.includes('OAFresh.stash(') && form.includes('OAFresh.echoFields(doc)'),
    'the edit form stashes what it just saved');
  ok(/already shows your\s+.?edit on this device/.test(form.replace(/['+]/g, '')),
    'and its confirmation claims exactly what the echo delivers — this device, now');
  const editBtns = await readFile(path.join(HERE, '..', 'assets', 'oa-jobedit.js'), 'utf8');
  ok(editBtns.includes('removed: true'), 'a takedown echoes as a removal');
  for (const page of ['jobs.html', 'index.html', 'previous-markets.html', 'post-a-job.html']) {
    const html = await readFile(path.join(HERE, '..', page), 'utf8');
    ok(html.includes('assets/oa-fresh.js'), `${page} loads the echo module`);
  }
  const pm = await readFile(path.join(HERE, '..', 'previous-markets.html'), 'utf8');
  ok(pm.includes("OAFresh.apply('/data/jobs.json', jobs)"),
    'previous-markets, which fetches jobs.json itself, applies the echo itself');
}

/* ------------------ the two guards that stopped publishing on 2026-08-24 */

async function testGuardRepairs() {
  /* A: NO E-MAIL REACHES A SERVED FILE — settled at INGEST, not by outage.
     The served-file guard is right to refuse a dataset holding one, and one
     contact address in a fresh submission's text stopped every build from
     03:14 that morning. The address is removed where the row is made, so a
     legitimate posting can never stop the site again. */
  eq(stripEmails('write to jane.doe@uni.edu today'), 'write to [e-mail removed] today',
    'an e-mail address in free text is removed, with a marker in its place');
  eq(stripEmails('reach me @gmail.com'), 'reach me [e-mail removed]',
    'including the bare @domain tail, which is all the guard needs to fire');
  eq(stripEmails(stripEmails('a@b.co and c@d.org')), stripEmails('a@b.co and c@d.org'),
    'stripping is idempotent, so every build may re-apply it');
  ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(stripEmails('x a@b.co y, then @d.org too')),
    'nothing the served-file guard matches survives the strip');

  const struck = stripRowEmails({
    comments: 'Contact: chair@uni.edu with questions.',
    adUrl: 'https://x.edu/path?owner=a@b.co',
    levels: ['Assistant Professor'],
  });
  ok(!struck.comments.includes('@'), 'a row\'s free text is stripped');
  eq(struck.adUrl, 'https://x.edu/path?owner=a@b.co',
    'while a stored URL is never rewritten — breaking a link is worse, and ' +
    'the guard still stands over that one-off');
  eq(struck.levels, ['Assistant Professor'], 'and nothing else about the row moves');

  const sub = rowFromSubmission({
    ...GOOD, comments: 'We interview at INFORMS — write to chair@example.edu.',
  });
  ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(JSON.stringify(publicRow(sub))),
    'a submission whose comments carry an address publishes without it');
  const edited = applyEdits(RV_ROW, { comments: 'ask soandso@uni.edu first' });
  ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(String(edited.comments)),
    'and so does a queue posting whose review edit typed one in');

  /* B: A VERIFY PASS PATCHES DEADLINES, IT NEVER CLOBBERS THE BUILT ROW.
     data/jobs.json is build-jobs' output, healed over the merged set;
     data/jobmarket.json can lawfully disagree (UCLA: the maintainer's typed
     October 5 there, the text's own November 5 final + October 5 suggested
     in the built row). The verify passes used to copy every sheet row
     wholesale and reverted that split; the mirror guard then stopped the
     commit. Only changed rows, only the deadline fields. */
  const jobsRows = [
    { id: 'u1', source: SHEET_SOURCE, applyBy: 'November 5, 2026',
      applyByDate: '2026-11-05', reviewDate: '2026-10-05', school: 'Healed School' },
    { id: 'u2', source: SHEET_SOURCE, applyBy: 'Until filled.', applyByDate: '',
      reviewDate: '2026-09-01', school: 'Kept School' },
    { id: 'u3', source: 'oa-form', applyBy: 'Until filled.', applyByDate: '' },
  ];
  const applied = {
    rows: [
      { id: 'u1', applyBy: 'October 5, 2026', applyByDate: '2026-10-05' },
      { id: 'u2', applyBy: longDate('2026-12-01'), applyByDate: '2026-12-01' },
      { id: 'u3', applyBy: longDate('2026-12-01'), applyByDate: '2026-12-01' },
    ],
    changed: [{ id: 'u2' }, { id: 'u3' }],
  };
  const next = patchDeadlines(jobsRows, applied, SHEET_SOURCE);
  eq(next[0], jobsRows[0],
    'a row the pass did not change keeps the built suggested/final split, ' +
    'even where the sheet file disagrees — the UCLA case');
  eq(next[1].applyByDate, '2026-12-01', 'a filled row takes its new closing date');
  eq(next[1].applyBy, longDate('2026-12-01'), 'both fields moving together');
  eq(next[1].school, 'Kept School', 'and keeps everything else the build gave it');
  ok(!('reviewDate' in next[1]),
    'its suggested date follows healReviewDate\'s verdict on the filled row — ' +
    'including "there is none"');
  eq(next[2], jobsRows[2], 'a posting the sheet does not own is never touched');

  /* The wiring, read from the source — a strip only one writer applies is
     undone by whichever writes next, the healCountry lesson. */
  const bj = await readFile(path.join(HERE, 'build-jobs.mjs'), 'utf8');
  ok(bj.includes('stripRowEmails('), 'build-jobs strips the merged set');
  const sync = await readFile(path.join(HERE, 'sync-jobmarket-sheet.mjs'), 'utf8');
  ok(sync.includes('stripRowEmails'), 'the sheet sync strips what it writes');
  for (const f of ['higheredjobs-verify.mjs', 'adverts-verify.mjs']) {
    const src = await readFile(path.join(HERE, f), 'utf8');
    ok(src.includes('patchDeadlines('), `${f} patches deadlines onto jobs.json`);
    ok(!src.includes('byId.get(r.id) : r'),
      `and the wholesale row copy is gone from ${f}`);
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

  /* …AND THE POSTING REACHES THE SUBSCRIBERS WHO ASKED FOR IT (owner,
     2026-08-27: "when I approve any of them and become public, they should be
     sent to those users with email alerts").

     The dating above is only half of the promise, and the halves were tested
     apart: the queue knew a posting was dated from its approval, the matcher
     knew how to window, and nothing anywhere joined the two. So this drives
     the whole path in one — approve, publish, window, match — against the same
     matcher the browser and the mailer both read.

     The subscriber's last digest went out BETWEEN the crawl and the approval,
     which is exactly the shape that used to reach nobody: dated from the
     crawl the posting was already behind their mark. */
  const AM = require(path.join(HERE, '..', 'assets', 'oa-alert-match.js'));
  const lastDigest = '2026-08-20T00:00:00Z';           // crawled 18th, approved 22nd
  ok(String(RV_ROW.addedAt) < lastDigest,
    'the fixture really is a posting crawled before the subscriber last heard from us');
  ok(AM.newJobsFor([published], { topics: ['jobs'] }, lastDigest).length === 1,
    'an approved posting is announced to an alert whose last digest predates the approval');
  ok(AM.newJobsFor([RV_ROW], { topics: ['jobs'] }, lastDigest).length === 0,
    'and dated from the CRAWL instead it would have reached nobody — the bug, reproduced');

  /* A rejection is not an announcement, and a grandfathered approval is not a
     re-announcement: sixteen postings were public before the gate existed and
     re-dating them would blast every subscriber about postings they know. */
  ok(partition([RV_ROW], [{ ...decided, status: REJECTED }], {}).publish.length === 0,
    'a rejected posting is published to nobody, so nothing can announce it');
  ok(AM.newJobsFor(
    [approvedRow(RV_ROW, { ...decided, reviewedAt: decided.queuedAt })],
    { topics: ['jobs'] }, lastDigest).length === 0,
    'a grandfathered posting is not re-announced');
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

  /* ---- THE SAME ADVERTISEMENT TWICE IS DROPPED, NOT FLAGGED -------------

     Owner, 2026-08-26: "check the Link to the advert — if it already exists in
     a previous posting that is live or in the queue, then remove that new job
     from the queue." `duplicatesOf` raises a flag; `advertRepeat` decides, so
     its guards are what keep a real posting out of the bin. */
  const sameAd = { ...crawled, adUrl: 'https://apply.interfolio.com/12345' };
  ok(!!advertRepeat(sameAd, site), 'a crawled row advertising a listed vacancy is a repeat');
  eq(advertRepeat(sameAd, site).id, 'OA-1', 'and it names the posting it repeats');

  eq(advertRepeat({ ...sameAd, year: 2026 }, site), null,
    'the SAME link in another market year is not — CityU links one vacancies ' +
    'page from two seasons, the case this rule was once abandoned over');
  eq(advertRepeat({ ...sameAd, unit: 'Supply Chain Management',
    department: 'Supply Chain Management' }, site), null,
    'nor is a different department behind one endpoint — the UCD CoreHR case, ' +
    'the only shared link in the whole served corpus');
  eq(advertRepeat({ ...sameAd, levels: ['Post-Doc'] }, site), null,
    'nor two searches whose entry levels share nothing — the Houston lesson');
  eq(advertRepeat({ ...sameAd, institution: 'Emory University' }, site), null,
    'nor the same link at another university');
  eq(advertRepeat({ ...crawled, adUrl: '' }, site), null,
    'a row naming no advertisement is never dropped');
  eq(advertRepeat({ ...crawled, adUrl: 'https://www.operationsacademia.org/' },
    [{ ...site[0], adUrl: 'https://operationsacademia.org' }]), null,
    'and our own home page identifies nothing, so it drops nothing');

  /* The DECIDING half reads only the advertisement link, never "posted at" —
     `duplicatesOf` can afford the wider net because a person reads its
     answer. */
  eq(advertRepeat({ ...crawled, adUrl: '', postedAtUrl: 'https://apply.interfolio.com/12345' },
    site), null,
    'the drop keys on the advert link alone, not on where it was posted');

  /* A row already IN THE QUEUE counts as listed, not only a live one — half
     the owner's sentence, and the half a site-only comparison would miss. */
  const queued = [{ ...site[0], id: 'Q-1', ref: '', source: SHEET_SOURCE }];
  eq(advertRepeat(sameAd, queued).id, 'Q-1',
    'a vacancy already waiting in the queue is "already listed" too');

  ok(/already live or already in the queue/.test(repeatNote(site[0])),
    'the dropped document says why it went');
  ok(repeatNote(site[0]).includes('OA-JOB-260820-HLA8'),
    'and names the posting it repeats, so the maintainer can find it');
  ok(repeatNote(null).length > 0 && repeatNote(null).length < 1000,
    'and stays inside the note field the rules already allow, even with nothing to name');

  /* ---- SWEEPING A WHOLE SET, not one row at a time ---------------------

     Owner, 2026-08-26: "Apply for ALL jobs under review". A per-row check
     cannot do that on its own — two queued rows naming one advertisement are
     each a repeat of the OTHER, so checking them independently against the
     same list drops both and loses the posting altogether. `findAdvertRepeats`
     keeps what it has already kept, so exactly one survives; and the caller
     hands the rows over oldest-first, so the survivor is the one that has been
     waiting longest. */
  const q1 = { ...sameAd, id: 'Q-A' };
  const q2 = { ...sameAd, id: 'Q-B' };
  const both = findAdvertRepeats([q1, q2], []);
  eq(both.keep.map((r) => r.id), ['Q-A'],
    'two queued rows naming one advertisement leave exactly one — never zero');
  eq(both.drop.map((d) => d.row.id), ['Q-B'],
    'and the one dropped is the later of the two, because the caller passes them oldest first');
  eq(both.drop[0].of.id, 'Q-A', 'the drop names the row that survived it');

  eq(findAdvertRepeats([q1], site).drop.map((d) => d.of.id), ['OA-1'],
    'a queued row repeating something LIVE is dropped against the site, as before');
  eq(findAdvertRepeats([q1], site).keep, [],
    'and does not then join the list the rest are measured against');
  eq(findAdvertRepeats([{ ...crawled, adUrl: '' },
    { ...crawled, id: 'X-2', adUrl: '' }], []).drop, [],
    'rows naming no advertisement are never swept together');
  eq(findAdvertRepeats([], site).drop, [],
    'and an empty queue sweeps to nothing');

  /* AND THE DROP SURVIVES THE ENTRY LEVELS MOVING UNDER IT. Two of its four
     contradictions are read off the row (the department and the levels), and
     `levelsFromRank` now ticks BOTH boxes for every open-rank search (owner,
     2026-08-26) — so postings that used to share no level share one today,
     and the guard that kept them apart is weaker than it was when the corpus
     was measured. Measured again the other way round: with EVERY served
     posting ticking both levels, so the levels contradiction can never fire,
     the whole corpus still holds not one repeat. The rule stands on the year,
     the university and the department, which is what the CityU and UCD cases
     always said it stood on. */
  const servedJobs = JSON.parse(readFileSync(JOBS, 'utf8'));
  const levelBlind = servedJobs.map((r) => ({ ...r, levels: ['Assistant Professor', 'Other Ranks'] }));
  const repeats = levelBlind.filter((r) => advertRepeat(r, levelBlind));
  eq(repeats.map((r) => r.id), [],
    'no served posting is judged a repeat of another even with the entry-level ' +
    'contradiction taken away — so a search now ticking two boxes cannot start ' +
    'dropping real postings');
  eq(findAdvertRepeats(levelBlind, []).drop.map((d) => d.row.id), [],
    'and the whole-queue sweep, which is what actually drops one, sweeps the ' +
    'same corpus to nothing');

  /* THE WIRING: the sync drops rather than queues, and REJECTS rather than
     deletes — `partition` re-queues a row whose document is gone, so a delete
     would re-drop it every sync for ever. Read from the source, because
     reproducing it needs the workbook and Firestore. */
  const syncSrc = readFileSync(path.join(HERE, 'sync-jobmarket-sheet.mjs'), 'utf8');
  ok(/advertRepeat\(doc\.row, listed\)/.test(syncSrc),
    'the sheet sync checks every fresh queue document for a repeated advertisement');
  ok(/doc\.status = REJECTED/.test(syncSrc),
    'and drops it by REJECTING it, which keeps it out of the pending list for good');
  ok(/findAdvertRepeats\(pendingPairs\.map/.test(syncSrc),
    'the postings ALREADY under review are swept too, not only the fresh ones');
  ok(/\.sort\(\(a, b\) => String\(a\.queuedAt \|\| ''\)/.test(syncSrc),
    'oldest first, so the one that has been waiting longest is the one that stays');
  ok(/\[\.\.\.site, \.\.\.split\.publish\]/.test(syncSrc),
    'a posting the maintainer APPROVED counts as already listed, though the ' +
    'build has not published it yet — the decision, not the deployment');
  ok(/findAdvertRepeats\(pendingPairs\.map\(\(p\) => p\.row\), listedNow\)/.test(syncSrc),
    'and the queue sweep measures against that set, not against the served file alone');
  ok(/\[\.\.\.listedNow, \.\.\.swept\.keep\]/.test(syncSrc),
    'comparing against what is listed AND what survived in the queue');
  ok(/listed\.push\(doc\.row\)/.test(syncSrc),
    'and against the fresh rows it has just accepted, so one advertisement ' +
    'listed twice in the workbook is queued once');
  ok(/status: REJECTED[\s\S]{0,200}?note: repeatNote\(d\.of\)/.test(syncSrc),
    'a swept queue document is rejected with the reason in its note');
  ok(/runTransaction[\s\S]{0,400}?!== PENDING\) return false/.test(syncSrc),
    'and only from PENDING, in a transaction — a decision made in the browser ' +
    'mid-run is the maintainer\'s and is never overwritten');
  ok(/if \(droppedIds\.has\(doc\.rowId\)\) continue/.test(syncSrc),
    'a posting on its way out of the queue is not also re-flagged');
  ok(/split\.pending\.filter\(\(d\) => !droppedIds\.has\(d\.rowId\)\)\.length/.test(syncSrc),
    'and is not counted among the decisions still waiting on the maintainer');
  ok(!/doc\.status = REJECTED[\s\S]{0,400}?\bdelete\b/.test(syncSrc),
    'nothing deletes the document');

  /* ---- AND THE BUTTON, which must read the SAME FILE -------------------

     Owner, 2026-08-26: "Create a button to check for such duplicates in the
     future." The rule therefore has two callers, and a browser COPY of it
     would drift from the pipeline's the first time either was corrected — the
     drift every shared module in this repository exists to prevent. So it is
     ONE dual-mode file (assets/oa-advert-dup.js) that jobreview.mjs
     re-exports, pinned here from both ends. */
  const dupSrc = readFileSync(path.join(HERE, '..', 'assets', 'oa-advert-dup.js'), 'utf8');
  ok(/module\.exports = factory\(require\('\.\/oa-schools\.js'\)\)/.test(dupSrc)
     && /root\.OAAdvertDup = factory\(root\.OASchools\)/.test(dupSrc),
    'the advert-repeat rule is one dual-mode file, Node and browser');
  const jrSrc = readFileSync(path.join(HERE, 'jobreview.mjs'), 'utf8');
  ok(/require\(['"]\.\.\/assets\/oa-advert-dup\.js['"]\)/.test(jrSrc),
    'and the pipeline RE-EXPORTS it rather than carrying its own copy');
  for (const name of ['advertLink', 'advertRepeat', 'findAdvertRepeats', 'repeatNote']) {
    ok(new RegExp('\\b' + name + '\\b').test(jrSrc.slice(0, jrSrc.indexOf('oa-advert-dup'))
      + jrSrc.slice(jrSrc.indexOf('oa-advert-dup'))),
      `${name} reaches the pipeline through that one re-export`);
  }

  const rvSrc = readFileSync(path.join(HERE, '..', 'assets', 'oa-jobreview.js'), 'utf8');
  ok(/OAAdvertDup\.findAdvertRepeats\(/.test(rvSrc),
    'the Admin-area button decides with the shared rule, never a copy of it');
  ok(!/function advertRepeat\b/.test(rvSrc),
    'and the panel defines no rule of its own');
  ok(/fetch\('data\/jobs\.json', \{ cache: 'no-cache' \}\)/.test(rvSrc),
    'it re-reads what is LIVE, revalidated — Pages serves data/ with ten ' +
    'minutes of freshness and a stale copy would keep a repeat');
  ok(/window\.confirm\([\s\S]{0,600}?lines/.test(rvSrc),
    'it names every posting it would remove before it removes any');
  ok(/status: 'rejected'[\s\S]{0,200}?note: OAAdvertDup\.repeatNote\(d\.of\)/.test(rvSrc),
    'and rejects with the same fields the sync writes — never a delete');
  ok(/state\.crawled\.slice\(\)\.sort\(/.test(rvSrc),
    'over the WHOLE crawled queue, oldest first, not just the page on screen');
  /* THE STANFORD MS&E CASE (owner, 2026-08-26): one of two identical postings
     was approved, and the button then failed to catch the other. An approved
     posting is out of the queue (the panel lists PENDING only) and not yet in
     the served file, so its twin was measured against a set holding neither
     copy. The set has to be what the maintainer has DECIDED is public, which
     `data/jobs.json` only becomes a build later. */
  ok(/where\('status', '==', 'approved'\)/.test(rvSrc),
    'the sweep counts an APPROVED posting as already listed, though the build ' +
    'has not published it yet — the Stanford MS&E case');
  ok(/got\[0\]\.concat\(got\[1\]\)/.test(rvSrc),
    'the served file and the approved queue are ONE comparison set');
  ok(/\.catch\(function \(\) \{ return \[\]; \}\)/.test(rvSrc),
    'and a refused approved-queue read degrades to the served file alone, ' +
    'never to a lost sweep');
  ok(/var dupOn = source === 'crawled' && state\.crawled\.length > 0/.test(rvSrc),
    'drawn on the crawled tab alone — a user-added posting is already live — ' +
    'and for ONE posting too, which can repeat something already published');

  /* ---- AND AN APPROVAL SHOWS AT ONCE (owner, 2026-08-26) --------------

     The card has been wrong in BOTH directions, so the pin names the cadence
     rather than a side of it. It first said "publishing starts now" while the
     doorbell function was undeployed and the posting waited for the schedule;
     the correction said "at the next build" — and the functions went live on
     2026-08-27 (the `oa-jobreview-decided` dispatch, which only
     `publishOnReview` sends, has fired on every decision since), after which
     "the next build" UNDER-promised a two-minute chain and read as the
     doorbell still being dead. Copy that promises a time changes with the
     cadence — this repository's own rule — so what is pinned is today's:
     the echo for the maintainer at once, the chain for everyone else in a
     couple of minutes, and neither stale wording anywhere the maintainer
     reads. */
  ok(/echoApproval\(doc, edits, patch\.reviewedAt\)/.test(rvSrc),
    'approving one posting echoes the row the build will publish');
  ok(/echoApproval\(doc, edits, reviewedAt\)/.test(rvSrc),
    'and so does approving the whole page');
  ok(/OAFresh\.approvedRow\(row, \{/.test(rvSrc)
     && /canonColumns: OASchools\.canonColumns/.test(rvSrc),
    'through the parity-pinned twin, given the site\'s own canonColumns');
  ok(/catch \(e\) \{ \/\* an echo is a courtesy: never let it cost the approval \*\/ \}/
    .test(rvSrc),
    'and an echo that throws never costs the approval itself');
  /* The COPY, not the commentary: the comment above the card's message quotes
     BOTH retired wordings to say why each went, and a naive search finds
     them. */
  const rvCopy = rvSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/publishing starts now|publishing starts the moment you approve/.test(rvCopy),
    'the card never claims an instant nothing measures — the promise is a time');
  ok(!/at the next build/.test(rvCopy),
    'and never the retired under-promise, which read as the doorbell being dead');
  for (const claim of ['on your own jobs page straight away',
    'within a couple of minutes']) {
    ok(rvCopy.indexOf(claim) >= 0, `the card says what is true instead: "${claim}"`);
  }
  /* BOTH decision paths carry it — approve-one and Approve-all each end on
     their own message, and a cadence corrected on one alone would have the
     panel disagreeing with itself. */
  eq((rvCopy.match(/within a couple of minutes/g) || []).length, 2,
    'both the single approval and Approve-all promise the same cadence');

  const adminPage = readFileSync(path.join(HERE, '..', 'admin-area.html'), 'utf8');
  ok(/<script defer src="assets\/oa-fresh\.js">/.test(adminPage),
    'the Admin area loads the echo module');
  ok(adminPage.indexOf('<script defer src="assets/oa-fresh.js">')
     < adminPage.indexOf('<script defer src="assets/oa-jobreview.js">'),
    'before the panel that stashes into it');
  ok(/id="oa-review-dupes"/.test(adminPage), 'the Admin area carries the button');
  /* SCRIPT TAGS, not the first mention: the panel is named in a comment two
     hundred lines above its own tag, so a bare indexOf compares a sentence
     with a script. */
  const tagAt = (f) => adminPage.indexOf('<script defer src="assets/' + f + '">');
  ok(tagAt('oa-advert-dup.js') > tagAt('oa-schools.js'),
    'and loads the rule after oa-schools.js, whose institutionKey it folds names with');
  ok(tagAt('oa-advert-dup.js') < tagAt('oa-jobreview.js'),
    'and before the panel that calls it');
  ok(/<script defer src="assets\/oa-advert-dup\.js">/.test(adminPage),
    'deferred, like every other script on the page');

  /* AND IT NEEDS NO RULES REDEPLOY. The sync writes with the Admin SDK, which
     bypasses the rules; the BUTTON writes from a browser, so every key it
     sends has to be one `jobReviews` already allows — `note` and `dup` were
     chosen for exactly that. A feature that needs a manual step to become real
     looks installed and is not, which is the failure shape this repository
     names everywhere else. */
  const rulesSrc = readFileSync(path.join(HERE, '..', '_firestore.rules'), 'utf8');
  const jrRule = rulesSrc.slice(rulesSrc.indexOf('match /jobReviews/{id}'));
  const jrAllowed = (jrRule.slice(jrRule.indexOf('hasOnly(['),
    jrRule.indexOf('])', jrRule.indexOf('hasOnly(['))).match(/'([^']+)'/g) || [])
    .map((x) => x.replace(/'/g, ''));
  for (const k of ['status', 'reviewedAt', 'note', 'dup']) {
    ok(jrAllowed.indexOf(k) >= 0,
      `the button's "${k}" is already allowed on a jobReviews document — no redeploy`);
  }
  ok(/'rejected'/.test(jrRule.slice(0, jrRule.indexOf('hasOnly('))),
    'and "rejected" is a status the rules accept from the browser');
  ok(repeatNote(site[0]).length < 1000,
    'and the reason fits the note field the rules cap at 1000 characters');

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

  /* ------------------------------- ONE EVENT, ONE BUILD (2026-08-26)

     `oa-jobs-build.yml` is chained to the sheet read by `workflow_run`, AND
     the sheet read used to `curl` a `repository_dispatch` at the end of its
     own run. Both fired: one sheet read started two builds three seconds
     apart, from the same base, doing identical work. The shared
     `oa-jobs-data-*` concurrency group cannot dedupe them — with
     `cancel-in-progress: false` the second QUEUES rather than being dropped —
     so the loser rebuilt data/, had its push rejected, and its rebase
     conflicted in the generated data/jobs-meta.json.

     Pinned as a RULE rather than as "the sheet has no curl": a workflow the
     build already listens to must not also ring its doorbell, whichever
     workflow that turns out to be. */
  const wfDir = path.join(HERE, '..', '.github', 'workflows');
  const buildSrc = await readFile(path.join(wfDir, 'oa-jobs-build.yml'), 'utf8');

  const chainedNames = [...buildSrc.matchAll(/workflows:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => m[1].split(',')
      .map((v) => v.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean));
  ok(chainedNames.length > 0,
    'oa-jobs-build is chained to the sheet read by workflow_run — that IS the doorbell');

  for (const file of (await readdir(wfDir)).filter((f) => f.endsWith('.yml'))) {
    const src = await readFile(path.join(wfDir, file), 'utf8');
    const name = (src.match(/^name:\s*(.+)$/m) || [])[1];
    if (!name || !chainedNames.includes(name.trim())) continue;
    ok(!/"event_type"\s*:\s*"oa-jobs-changed"/.test(src),
      `${file} is already chained to oa-jobs-build by workflow_run, so it must ` +
      'not ALSO dispatch oa-jobs-changed — that fires the build twice for one event');
  }

  /* …and the build KEEPS that dispatch trigger, which is a different producer:
     the Cloud Function's doorbell for a posting made or edited on the site. It
     READ as dead code through the months when nothing sent it; the functions
     were deployed on 2026-08-27 and it has carried real traffic since, so
     tidying it away would now break the instant path outright. */
  ok(/repository_dispatch:\s*\n\s*types:\s*\[oa-jobs-changed\]/.test(buildSrc),
    'oa-jobs-build still answers oa-jobs-changed — the Cloud Function\'s own doorbell');

  /* ---------------------- NOTHING STILL CALLS THE DOORBELLS UNDEPLOYED

     A claim about the world OUTSIDE this repository cannot be tested here, so
     it goes stale in silence — and this one went stale in the direction that
     costs an afternoon: six files asserted that the three instant-publish
     functions had never been deployed, for three days after they were. The
     evidence is one filter away (this repository's Actions, event
     `repository_dispatch`, read the ACTOR: `oa-jobreview-decided` has no
     sender but `_functions/index.js`), and nobody looks at a fact already
     written down.

     PRESENT-TENSE ONLY, exactly as with the university figures further down:
     every one of these files RECOUNTS the old state in order to explain what
     changed, and a guard that could not tell the explanation from the claim
     could only be satisfied by deleting the explanation. So what is forbidden
     is a file still ASSERTING it.

     And the recordVisit claim aged the same way WITHIN A DAY: the morning of
     2026-08-30 this comment excused it as the one honest "not deployed", and
     that afternoon a deploy from a pulled checkout created the function. So
     the sweep covers it too — the failure is identical, only faster. */
  /* Two fragments are CONCATENATED rather than written out, because this file
     is one of the six swept and a pattern that spells its own claim in full
     matches itself. The alternatives carrying a group cannot. */
  const DOORBELL_STALE = new RegExp([
    '(the |those )?(cloud )?functions (are|is) undeployed',
    '(cloud )?functions have never ' + 'been deployed',
    'doorbells?( above)? (is|are) undeployed',
    'has never ' + 'rung',
    'dispatch has (\\*\\*)?zero runs, ever',
    'neither\\s+is deployed',
    'that function has never ' + 'fired here',
    'recordVisit[,`]* (is|remains|which is)( genuinely| still)? not ' + '(deployed|live)',
    'the one function nobody has ' + 'switched on',
    'this fourth function has never ' + 'reached production',
  ].join('|'), 'i');
  for (const f of ['CLAUDE.md', '_SETUP-INSTANT-PUBLISH.md', '_SETUP-ANALYTICS.md',
    'assets/oa-jobreview.js', '_functions/index.js', '_scraper/selftest.mjs']) {
    const t = await readFile(path.join(HERE, '..', f), 'utf8');
    ok(!DOORBELL_STALE.test(t),
      `${f} no longer asserts the instant-publish doorbells are ` + `undeployed — ` +
      'they have fired on every decision since 2026-08-27, and a warning left ' +
      'standing after its fact expired sends the next reader chasing a delay ' +
      'nobody has');
  }

  /* …and the ONE operational lesson that outlives the date: a deploy runs on
     the working copy, so a clone a few commits behind deploys the older set
     and prints "Deploy complete!" over it. That is how the first 2026-08-30
     deploy missed `recordVisit` — a second, from a pulled checkout, created
     it the same day. */
  const instantSetup =
    await readFile(path.join(HERE, '..', '_SETUP-INSTANT-PUBLISH.md'), 'utf8');
  ok(/read the deployed list back/i.test(instantSetup)
     && /_functions\/index\.js/.test(instantSetup),
    'the setup guide says to count the deployed functions back against ' +
    '_functions/index.js — the check that would have caught the missing one');

  /* ---------------------- A CHAINED BUILD STARTS FROM THE BRANCH TIP

     `actions/checkout` defaults to `github.sha`, and on a `workflow_run` event
     that is the head of the run that TRIGGERED it. The producer commits before
     it finishes, so that SHA is already stale: the build rebuilt data/ from it
     and its push was rejected. Both of the 2026-08-26 failures were on this
     path. Naming the ref the Commit step pushes to makes the push a
     fast-forward. */
  /* …and it is not only the WRITERS that this catches. A workflow chained to a
     data build READS what that build committed, and `github.sha` is the commit
     BEFORE it: `oa-alerts-mail.yml` therefore announced, on every instant fire,
     a `data/jobs.json` that by construction could not hold the postings it had
     just been fired about. So the rule is about every consumer of data/, in
     either direction — a stale read is as silent as a stale base, and here it
     was worse, because an alert that also carried updates sent its digest from
     that read and moved its own high-water mark past the approval.

     `oa-deploy-rules.yml` is deliberately NOT in this list: it is chained to
     the CHECKS, which commit nothing, and publishing the ruleset that was
     actually tested is the point of it. Its head_sha IS the commit under
     test. */
  const DATA_CHAINED = [...WRITERS, 'oa-alerts-mail.yml', 'oa-submissions-mail.yml'];
  for (const name of DATA_CHAINED) {
    const src = await readFile(path.join(wfDir, name), 'utf8');
    if (!/^\s*workflow_run:/m.test(src)) continue;
    const checkout = src.match(/uses: actions\/checkout@[^\n]*\n([\s\S]*?)(?=\n\s*- )/);
    ok(checkout && /ref:\s*\$\{\{\s*github\.ref_name\s*\}\}/.test(checkout[1]),
      `${name} runs on workflow_run, so its checkout must name the branch tip ` +
      '(github.ref_name) — the default github.sha is the TRIGGERING run\'s head');
  }

  /* ---- ONE NODE VERSION, AND THE FUNCTIONS RUN ON IT TOO ----------------

     Google decommissions a Cloud Functions runtime on a DATE — Node 20's is
     2026-10-30, after which nothing deploys at all — and the deploy log is
     the only place that says so. That is this repository's own recurring
     failure shape wearing a calendar: a warning nobody reads until the thing
     stops.

     A guard pinning "22" would go stale the same way, so what is pinned is a
     RELATIONSHIP that does not rot: the runtime the Functions declare is the
     one CI actually runs the code on. Deploying code tested on one Node to a
     runtime on another is the real defect, and it is checkable offline for
     ever. It was true only by luck until 2026-08-30 — `_functions` said 20
     while fifteen of the sixteen workflows said 22, and the sixteenth
     (oa-analytics.yml, the newest) said 20 as well. */
  const wfFiles = (await readdir(wfDir)).filter((f) => /\.ya?ml$/.test(f));
  const nodeVersions = new Set();
  for (const name of wfFiles) {
    const src = await readFile(path.join(wfDir, name), 'utf8');
    for (const m of src.matchAll(/node-version:\s*'?([0-9.]+)'?/g)) nodeVersions.add(m[1]);
  }
  eq([...nodeVersions].sort(), ['22'],
    'every workflow runs ONE Node version — an odd one out is drift nobody sees ' +
    'until a version-specific failure appears in exactly one job');
  const fnPkg = JSON.parse(
    await readFile(path.join(HERE, '..', '_functions', 'package.json'), 'utf8'));
  eq(fnPkg.engines && fnPkg.engines.node, [...nodeVersions][0],
    'and the Cloud Functions declare that same runtime — code tested on one ' +
    'Node and deployed to another is the defect a decommission date turns fatal');

  /* AND THE CHAIN ITSELF: the alerts mailer must go on answering the build's
     completion. Losing that trigger costs an hour rather than a posting (the
     hourly cron is the safety net), but "as soon as something appears" is what
     the alerts page promises a subscriber. */
  const alertsWf = await readFile(path.join(wfDir, 'oa-alerts-mail.yml'), 'utf8');
  const buildName = (buildSrc.match(/^name:\s*(.+)$/m) || [])[1];
  ok(buildName && alertsWf.includes(`workflows: ["${buildName.trim()}"]`),
    'the alerts mailer is chained to the build BY ITS CURRENT NAME — renaming a ' +
    'workflow silently unchains every workflow_run listening for it');

  /* …AND SO IS THE SUBMISSIONS MAILER, for a promise the schedule cannot keep
     on its own. post-a-job.html tells a poster they will hear "as soon as it
     is publicly shown", and "publicly shown" is decided by whether the row is
     in the checkout's data/jobs.json — which is exactly what the build has
     just committed. The cron asks for 96 fires a day and GitHub delivers about
     five (mean gap six hours, worst twelve, measured 2026-08-30), so without
     this chain the promise is missed by most of a day. */
  const subsWf = await readFile(path.join(wfDir, 'oa-submissions-mail.yml'), 'utf8');
  ok(buildName && subsWf.includes(`workflows: ["${buildName.trim()}"]`),
    'the submissions mailer is chained to the build by its current name too — it is ' +
    'what makes the poster\'s "as soon as it is publicly shown" true');
  ok(/conclusion == 'success'/.test(subsWf),
    '…and only to a SUCCESSFUL build: a failed one committed nothing, so it published ' +
    'no posting and there is nobody new to tell');

  /* ------------- A REJECTED PUSH IS REBUILT, NEVER REBASED (2026-08-26)

     Everything under data/ is a build OUTPUT, so a rejected push has nothing
     to reconcile. `git pull --rebase` sat here and asked git to merge two
     independently GENERATED copies of the same file: data/jobs-meta.json
     carries a `generated` timestamp, so the same lines always differ and the
     rebase conflicted BY CONSTRUCTION — and where it had SUCCEEDED it would
     have been worse, pushing a snapshot built BEFORE the other writer's
     commit and dropping their rows with nothing to show it.

     The recovery that suits generated files is to throw our own commit away,
     take their tip, and rebuild on top of it. Four things have to hold for
     that, and each alone is enough to break it, so each is pinned. */
  const commitStep = (buildSrc.match(/\n      - name: Commit\n([\s\S]*)$/) || [])[1] || '';
  ok(commitStep, 'oa-jobs-build.yml has a Commit step to read');
  /* read with the comments stripped: the step EXPLAINS the rebase it no longer
     does, and a guard that cannot tell the explanation from the command would
     have to be satisfied by deleting the explanation. */
  const commitScript = commitStep.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  ok(!/git\s+(?:pull|rebase)\b/.test(commitScript),
    'the retry never rebases data/ — a generated file has no common history to ' +
    'reconcile, and the conflict lands in whichever line carries the timestamp');
  ok(/git reset --hard FETCH_HEAD/.test(commitStep),
    'it discards our commit and takes the other writer\'s tip instead');
  ok(/node _scraper\/build-all\.mjs/.test(commitStep),
    'then REBUILDS on it — which is only possible because the build is one ' +
    'script: a workflow step cannot re-run the steps before it, so while "what ' +
    'a build is" lived in four YAML steps the retry could not perform one');
  ok(/node _scraper\/selftest\.mjs --publishing/.test(commitStep),
    'and puts the rebuilt dataset through the same gate the first pass passed — ' +
    'a retry that skipped it could commit exactly what that gate exists to refuse');

  /* THE REBUILD NEEDS THE BUILD'S OWN CREDENTIALS, and losing them would fail
     SILENTLY rather than loudly: without FIREBASE_SERVICE_ACCOUNT the three
     Firestore builders are skipped (see plan() below), so the rebuild would
     leave the other writer's data/ exactly as it found it, find nothing to
     commit, and exit 0 reporting "the other writer published it all" — while
     this run's postings went nowhere. */
  const envOf = (step) => {
    const m = step.match(/(?:^|\n) {8}env:\n([\s\S]*?)\n {8}run:/);
    return m ? [...m[1].matchAll(/^ +([A-Z][A-Z0-9_]*):/gm)].map((x) => x[1]).sort() : [];
  };
  const buildStep =
    (buildSrc.match(/\n      - name: Publish everything queued\n([\s\S]*?)\n      - name: /) || [])[1] || '';
  ok(envOf(buildStep).includes('FIREBASE_SERVICE_ACCOUNT'),
    'the build step is given the credential that decides whether anything is read at all');
  eq(envOf(commitStep), envOf(buildStep),
    'and the Commit step carries exactly the same set — its retry rebuilds, and a ' +
    'rebuild reads Firestore, Drive and SMTP just as the first pass did');

  /* AND THE GATE THE FOUR STEPS USED TO CARRY IS STILL A GATE. Each build
     step had `if: steps.gate.outputs.ready == 'true'` except the directory
     one, which reads only committed files and therefore always ran. Folding
     them into one script had to keep that distinction: drop it one way and a
     run without the secret tries to read Firestore with nothing to read it
     with, drop it the other and a posting's new card waits for a secret its
     build never needed. */
  eq(plan({ firebase: false }).map((b) => b.script),
    ['build-directory.mjs', 'build-netmap.mjs'],
    'without the service account only the two OFFLINE builders run');
  eq(plan({ firebase: true }).map((b) => b.script), BUILDERS.map((b) => b.script),
    'with it, the whole build does');

  /* A BUILDER NOBODY CALLS IS A FILE THAT SILENTLY STOPS RUNNING — the whole
     point of this check, and the only symptom would be a dataset that quietly
     stopped moving. So every build-*.mjs must have a caller, and there are
     exactly two legitimate kinds:

       - it is in BUILDERS, and oa-jobs-build.yml runs the lot; or
       - it has a WORKFLOW OF ITS OWN that names it.

     The second is not a loophole, it is the case build-analytics.mjs is:
     a once-a-day read of a whole collection, which folded into BUILDERS would
     make every posting's publish wait on it and share its failure. What the
     rule actually forbids is a builder with NO caller, and it still does. */
  const builderFiles = (await readdir(HERE))
    .filter((f) => /^build-.*\.mjs$/.test(f) && f !== 'build-all.mjs').sort();
  const inBuilders = BUILDERS.map((b) => b.script);
  const wfText = (await Promise.all((await readdir(wfDir))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => readFile(path.join(wfDir, f), 'utf8')))).join('\n');
  const orphans = builderFiles.filter(
    (f) => !inBuilders.includes(f) && !wfText.includes(f));
  eq(orphans, [], 'every builder in _scraper has a caller — BUILDERS, or a workflow naming it');

  /* …and the two kinds do not OVERLAP. A builder that is in BUILDERS *and*
     named by a workflow would run twice on one event, from two bases, racing
     its own commit — which is exactly the duplicate-doorbell outage recorded
     in CLAUDE.md, one layer down. */
  const doubled = inBuilders.filter((f) => wfText.includes(f));
  eq(doubled, [], 'a builder is called by BUILDERS or by its own workflow, never both');

  /* AND EVERY NAMING SWEEP IS IN THAT ROLE — the half the flag cannot deliver
     on its own.

     `--publishing` only decides what `tidy` DOES; a sweep left on `eq` fails
     in both roles and stops the site's data whatever the flag says. That is
     not hypothetical: two of the three near-duplicate sweeps were moved to
     `tidy` when the 449-posting approval went red, the OM-list one was not,
     and on 2026-08-25 it took five consecutive builds down over one school
     spelled two ways — while the sibling sweep beside it reported the SAME
     pair as a warning and passed.

     So the rule is pinned where it is actually decided: an assertion that
     says two names are one place is a `tidy` call. Read from this file's own
     source, because by the time it has run the distinction has evaporated.
     The count is pinned too — deleting a sweep must be a deliberate act, not
     a way to make this quiet. */
  const selfSrc = await readFile(path.join(HERE, 'selftest.mjs'), 'utf8');
  const NAMING_FINDING = /two names|near-duplicate/;
  const ASSERTION =
    /\b(tidy|eq|ok)\(\s*([A-Za-z_$][\w$]*)\s*,\s*(?:\[\s*\]\s*,\s*)?\n?\s*'((?:[^'\\]|\\.)*)'/g;
  const namingSweeps = [];
  for (let m = ASSERTION.exec(selfSrc); m; m = ASSERTION.exec(selfSrc)) {
    if (NAMING_FINDING.test(m[3])) namingSweeps.push({ fn: m[1], list: m[2], what: m[3] });
  }
  ok(namingSweeps.length >= 3,
    `every near-duplicate NAME sweep is accounted for (${namingSweeps.length} found)`);
  eq(namingSweeps.filter((s) => s.fn !== 'tidy').map((s) => s.list + ': ' + s.what), [],
    'and each reports in the publishing role rather than stopping the site — a naming ' +
    'duplicate is settled by an alias, never by holding real postings back');

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
  ok(js.includes("['jobs', 'candidates', 'feedback', 'news', 'names', 'messages']"),
    'the badge sums exactly the six queues — the registered-user statistic ' +
    'is beside them, never among them');
  ok(!/users:\s*r\[/.test(js.slice(js.indexOf('function pendingCounts'),
      js.indexOf('the summary strip'))),
    'pendingCounts stays QUEUES only — every page’s badge refresh must ' +
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

/* --------------------------------------- WHO posted it, and the poster's own e-mail

   Owner, 2026-08-29, two requests in one message:

     "include to the email sent to the admin (and only) who made such a posting.
      If it was a user show their name and email … else show 'Posted by:
      auto-crawler from..' e.g. the JM Google Sheet"

     "any user who submits a job posting, should receive an email with the
      details of their posting once it becomes publicly shown on the website,
      and thank them for using OperationsAcademia.org and wishing them all the
      best to fill their position."

   The "(and only)" is the half a test has to hold: the poster's address is the
   maintainer's to see and nobody else's, so it may reach exactly one message.
   Everything else here is the two rules that make the second one honest —
   "publicly shown" is measured against the served file, and a poster is
   thanked once.                                                             */

async function testPostedByAndLiveEmail() {
  const read = async (f) => readFile(path.join(HERE, '..', f), 'utf8');
  const subMailer = await read('_scraper/submissions-mailer.mjs');
  const revMailer = await read('_scraper/jobreview-mailer.mjs');
  const model = await read('_scraper/submissions-review.mjs');

  /* ---- one definition of who posted a posting -------------------------- */

  const person = { source: FORM_SOURCE, firstName: 'Ada', lastName: 'Lovelace',
                   email: 'ada@x.edu' };
  eq(postedBy(person).kind, 'user', 'a form posting was made by a person');
  eq(postedBy(person).text, 'Ada Lovelace ada@x.edu', 'named, with the address they gave');
  eq(postedBy({ source: 'jobmarket-sheet' }).kind, 'crawler',
    'a tracking-sheet row was not');
  ok(/auto-crawler from the OM Job Market tracking sheet/
     .test(postedBy({ source: 'jobmarket-sheet' }).text),
    'and says which crawler, in the owner’s own words');
  eq(postedBy({}, { source: 'jobmarket-sheet' }).kind, 'crawler',
    'the source may live on the ROW — a jobReviews document keeps it there');

  /* THE SOURCE WINS. A tracking-sheet MIRROR the maintainer has edited is an
     ordinary jobSubmissions document, so "a document exists, therefore a
     person made it" would report the workbook's own rows as somebody's
     submission. */
  eq(postedBy({ source: 'jobmarket-sheet', firstName: 'Ada', email: 'ada@x.edu' }).kind,
    'crawler', 'a claimed sheet mirror is still the crawler’s row, whatever else it carries');

  /* …and a source nobody here knows reads as ITSELF rather than vanishing or
     being guessed at as a person. */
  ok(/auto-crawler from brand-new-thing/.test(postedBy({ source: 'brand-new-thing' }).text),
    'an unknown source is named, never invented');
  eq(postedBy({}).text, 'not recorded',
    'and nothing at all says so rather than leaving the line blank');

  eq(contactEmail({ email: 'not an address' }), '', 'a malformed address is no address');
  eq(contactEmail({ authEmail: 'a@b.co' }), 'a@b.co',
    'the sign-in address is the fallback when no other was typed');
  eq(contactEmail({ email: 'typed@x.edu', authEmail: 'a@b.co' }), 'typed@x.edu',
    'and the one they TYPED wins — it is the one they chose to be reached at');

  ok(!CRAWLER_SOURCES[FORM_SOURCE],
    'the form is not a crawler — that map is what DECIDES, so it must not list it');
  ok(sourceLabel(FORM_SOURCE) && sourceLabel(FORM_SOURCE) !== FORM_SOURCE,
    'though it still has a name fit for a sentence');

  /* ---- the maintainer's two e-mails both answer it ---------------------- */

  for (const [file, who] of [[subMailer, 'the submissions mailer'],
    [revMailer, 'the review mailer']]) {
    ok(/Posted by:/.test(file), `${who} prints the line`);
    ok(/postedBy\(/.test(file), 'through the shared rule, never its own copy');
  }

  /* AND ONLY THERE. `postedBy` returns an address, so the one thing a test has
     to hold is where that address may go: the maintainer's message. Not the
     poster's own (it tells them nothing and it is a message people forward),
     not a served file, not a page. */
  /* A SLICE TAKEN ON THE WRONG MARKER PASSES EVERY NEGATIVE CHECK BY VACUITY,
     and this file's own selftest fixtures name `chairEmail` a few hundred
     lines further down — so the slice is bounded at BOTH ends and its length
     is asserted, or "the poster's e-mail carries no address" would be a claim
     about an empty string. */
  const from = subMailer.indexOf('export function renderLivePostingEmail');
  const posterHalf = subMailer.slice(from, subMailer.indexOf('\n}\n', from));
  ok(from > 0 && posterHalf.length > 500,
    'the poster’s renderer is where this thinks it is');
  ok(!/postedBy\(/.test(posterHalf),
    'the poster’s e-mail never renders who posted it — it is written TO them');
  ok(!/chairEmail|chairName|doc\.email|doc\.authEmail|doc\.note/.test(posterHalf),
    'and reaches for no admin-only field: it is built from the SERVED row, so the ' +
    'chair’s details, the private note and the poster’s own address cannot be in it');

  ok(!PUBLIC_FIELDS.includes('email') && !PUBLIC_FIELDS.includes('firstName')
     && !PUBLIC_FIELDS.includes('chairEmail'),
    'none of the contact fields is published, which is what makes the row safe to print');

  /* ---- "publicly shown" is measured, not assumed ------------------------ */

  const job = SUB_KINDS.find((k) => k.key === 'job');
  const cand = SUB_KINDS.find((k) => k.key === 'candidate');
  ok(job.tellsPoster === true, 'a job posting tells its poster when it goes live');
  ok(!cand.tellsPoster,
    'a candidate profile does not — it is HELD until the reveal date, which is a ' +
    'different message with a different trigger');

  const doc = {
    id: 'p1',
    data: { status: 'queued', createdAt: SUB_LIVE_SINCE + 'T09:00:00Z', ref: 'OA-JOB-9',
      source: FORM_SOURCE, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.edu',
      institution: 'Tulane University', school: 'A. B. Freeman School of Business',
      unit: 'Management Science', country: 'United States', type: 'Business School',
      levels: ['Assistant Professor'], untilFilled: true, year: 2027 },
  };
  const row = job.row(doc.data);

  eq(partitionLive(job, [doc], { published: servedIndex([]) }).mail.length, 0,
    'a posting the served file does not carry is not announced as live');
  eq(partitionLive(job, [doc], { published: servedIndex([row]) }).mail.length, 1,
    '…and one it does carry is');

  /* THE JOIN KEY IS THE FORM'S OWN REFERENCE, NOT A RE-DERIVED ID.
     `jobId` is (market year, institution, posting date) and names no
     department, so colleagues at one school posting on one day derive ONE
     id and the build renumbers them; a pass that re-derived it sent each of
     them the first one's posting. FOUR of the thirteen form postings the
     site is showing today carry such a suffix, from two same-day groups six
     days apart — so this is the ordinary case, not a corner. */
  const sibDocs = ['Information Systems', 'Management Science'].map((unit, i) => ({
    id: 's' + i,
    data: { ...doc.data, unit, ref: 'OA-JOB-S' + i, email: `s${i}@x.edu` },
  }));
  const sibRows = assignIds(sibDocs.map((d) => ({ row: job.row(d.data) }))).map((e) => e.row || e);
  eq(new Set(sibRows.map((r) => r.id)).size, 2,
    'the build gives same-day siblings distinct ids');
  eq(job.row(sibDocs[0].data).id === job.row(sibDocs[1].data).id, true,
    '…which the submissions themselves cannot derive: both derive ONE id');
  const sibMail = partitionLive(job, sibDocs, { published: servedIndex(sibRows) }).mail;
  eq(sibMail.length, 2, 'both siblings are due');
  eq(sibMail.every((m) => m.published.ref === m.data.ref), true,
    'and each is matched to its OWN row, by the reference the form issued');

  /* NOT SURE MEANS DO NOTHING. A reference the file does not carry is a
     posting that has not published yet (or that collapseSameDay folded into
     a sibling) — never an invitation to fall back to a key that can pick the
     wrong row, and never a stamp, so a later run can still get it right. */
  const miss = partitionLive(job, [{ id: 'm1', data: { ...doc.data, ref: 'OA-JOB-NOPE' } }],
    { published: servedIndex(sibRows) });
  eq(miss.mail.length + miss.grandfather.length, 0,
    'a submission whose reference is not in the served file is passed over entirely');

  eq(matchServed({ ref: 'OA-JOB-S1' }, null, servedIndex(sibRows)).ref, 'OA-JOB-S1',
    'matchServed resolves by reference with no row at all');
  eq(matchServed({ ref: '', publishedId: sibRows[1].id }, null, servedIndex(sibRows)).id,
    sibRows[1].id, 'and by the publishedId the build stamped, for a document with no reference');
  eq(matchServed({ ref: '' }, sibRows[0], servedIndex(sibRows)), null,
    'but never onto a row carrying a reference of its own — that row is somebody else\'s');

  /* A CRAWLED POSTING THANKS NOBODY. Once the maintainer edits a
     tracking-sheet mirror it is an ordinary submission carrying THEIR
     address, and "thank you for using OperationsAcademia.org" would be sent
     to the person who runs the site about a row read out of a spreadsheet. */
  eq(partitionLive(job, [{ id: 'mir', data: { ...doc.data, source: 'jobmarket-sheet' } }],
    { published: servedIndex([row]) }).mail.length, 0,
    'a claimed tracking-sheet mirror is never thanked for posting anything');

  /* THE ROW IT PRINTS IS THE ROW THE SITE PRINTS. `partitionLive` hands the
     SERVED row on, so a name the build canonicalised or a deadline it healed
     reads in the e-mail exactly as a visitor reads it. */
  const served = { ...row, institution: 'Tulane University (healed)' };
  eq(partitionLive(job, [doc], { published: servedIndex([served]) }).mail[0].published.institution,
    'Tulane University (healed)',
    'and what it carries is the SERVED row, not the poster’s own document');

  /* ---- exactly once, which is what makes an EDIT safe -------------------- */
  eq(partitionLive(job, [{ ...doc, data: { ...doc.data, [SUB_LIVE_MAILED_AT]: 'x' } }],
    { published: servedIndex([row]) }).mail.length, 0,
    'a poster already thanked is never thanked again — correcting a posting sets its ' +
    'status back to queued and re-publishes it, and that must not send a second e-mail');

  ok(SUB_LIVE_MAILED_AT !== SUB_ANNOUNCED_AT && SUB_LIVE_MAILED_AT !== SUB_REVIEWED_AT,
    'the poster’s mark is its own: an SMTP failure on the maintainer’s copy must ' +
    'not make the poster unthankable, nor a tick on the Admin area silence either');
  ok(SUB_LIVE_SINCE !== SUB_SINCE,
    'and so is its grandfather date — two features with two ship dates');

  /* ---- an address that is not there yet is not written off --------------- */
  const noAddr = partitionLive(job, [{ id: 'p2', data: { ...doc.data, email: '', authEmail: '' } }],
    { published: servedIndex([row]) });
  ok(!noAddr.mail.length && !noAddr.grandfather.length,
    'a submission with no reachable address is skipped ENTIRELY — a stamp would make ' +
    'an address added by a later correction unthankable for ever');

  /* ---- NO RULES CHANGE, and that is a claim worth pinning ---------------- */
  const rules = await read('_firestore.rules');
  const block = rules.slice(rules.indexOf('match /jobSubmissions/'),
                            rules.indexOf('match /candidateSubmissions/'));
  ok(/allow write: if isAdmin\(\);/.test(block),
    'the mailer’s stamp is an admin write the rules already allow');
  ok(!/keys\(\)\.hasOnly\(/.test(block),
    'and no rule pins jobSubmissions to a fixed key SET, so an admin-written stamp ' +
    'cannot freeze a posting against its OWN owner — the sync-user-directory trap ' +
    '(the merge rule’s affectedKeys().hasOnly is a diff, not a shape)');
  const ownerUpdate = block.slice(block.indexOf('allow update: if isOwner'));
  ok(!/keys\(\)\.size\(\)/.test(ownerUpdate.slice(0, ownerUpdate.indexOf('allow update',
    1) + 1 || ownerUpdate.length)),
    'nor is there a key ceiling on the owner’s own correct-and-withdraw update, which ' +
    'is the write a stamp could otherwise push past it');

  /* ---- the copy no longer promises silence ------------------------------ */
  const form = await read('post-a-job.html');
  ok(!/do not send a confirmation/i.test(form),
    'the thank-you screen no longer says no e-mail is sent — it is now');
  ok(/we will e-mail you/i.test(form),
    'and says what actually happens instead');
  const policy = await read('privacy-policy.html');
  ok(/publicly shown/.test(policy) && /post a job/i.test(policy),
    'the Privacy Policy discloses the message, because a site that sends one and says ' +
    'so nowhere is wrong whatever its rules allow');

  /* ---- the wiring -------------------------------------------------------- */
  ok(model.includes(`export const LIVE_MAILED_AT = '${SUB_LIVE_MAILED_AT}';`),
    'the model names the stamp, so the mailer cannot spell it differently');
  ok(/renderLivePostingEmail|thankPosters/.test(subMailer),
    'the mailer really sends it');
  ok(subMailer.includes(SUB_LIVE_MAILED_AT), 'and stamps what the model named');
  ok(/oa-jobnav\.js/.test(subMailer),
    'the link is built by the site’s own page rule — a rolled season is on the archive');
  ok(/name-fixes\.json/.test(subMailer) && /fixes\s*\}\)/.test(subMailer),
    'and the mailer derives a row under the SAME approved name corrections the build applies, ' +
    'so the fallback join cannot silently diverge from what was published');
  ok(/replyTo: CONTACT/.test(subMailer),
    'and a reply from the poster reaches a person, not the sending mailbox');

  /* A DISPATCHED --dry-run PRINTS INTO A PUBLIC ACTIONS LOG, so it may not
     name the recipient — the same "nothing public carries an address" rule
     the served files are held to, applied to the one line here that held a
     real person's e-mail. */
  const dryLine = (subMailer.match(/log\(`\\n--- would send to the poster[^`]*`\)/) || [])[0] || '';
  ok(dryLine, 'the dry run still says what it would send');
  ok(!/entry\.to|\bto\b\s*\}/.test(dryLine),
    'but names the DOCUMENT, never the address — a dispatched dry run is a public log');

  /* The panels must not learn the poster's mark: it is the mailer's, and a
     browser writing it would silence an e-mail that had never been sent. */
  for (const f of ['assets/oa-submissions.js', 'assets/oa-jobreview.js']) {
    ok(!(await read(f)).includes(SUB_LIVE_MAILED_AT),
      `${f} never writes the poster’s high-water mark`);
  }
}

/* --------------------------------------- the candidate profile policy

   Owner, 2026-08-24: a registered candidate has ONE profile per market year,
   and the "Post confirmed placement" invite on a candidates card is the
   CANDIDATE's own control — drawn only on their own card, for them alone.
   The browser halves are measured in page-test.mjs where they can be; these
   pin the wiring that a browser run cannot cheaply reach (the card control
   is on a list the committed dataset ships empty, so page-test has no card
   to click until the first reveal). */

async function testCandidateProfilePolicy() {
  const read = (...p) => readFile(path.join(HERE, '..', ...p), 'utf8');

  /* the form sends an account that already has a profile this season to EDIT
     it — the create path is never offered twice */
  const form = await read('assets', 'oa-candidateform.js');
  ok(/redirectToOwnProfile/.test(form) &&
     /where\('uid', '==', user\.uid\)/.test(form),
    'oa-candidateform: an existing profile is looked up by the OWNER, not by name');
  ok(/location\.replace\('post-a-candidate\.html\?edit='/.test(form),
    'and found, the form reopens it for editing instead of creating a second');

  /* the model backstop: one account, one market year, one row — whatever the
     names say (the detail the name key cannot see) */
  const model = await read('_scraper', 'candidates-model.mjs');
  ok(/\|acct:/.test(model),
    'candidates-model: the collapse has an ACCOUNT pass keyed (year, owner)');
  ok(/r\.owner \? /.test(model),
    'which never touches an imported row that has no owner');

  /* the card invite is the candidate's own: keyed on the uid itself, so the
     admin's broad read cannot draw it on everyone else's card */
  const cards = await read('assets', 'oa-candidateedit.js');
  ok(/Post confirmed placement/.test(cards),
    'oa-candidateedit: the candidate card offers "Post confirmed placement"');
  const gate = cards.indexOf('perm.own[id]');
  const invite = cards.indexOf("button('Post confirmed placement'");
  ok(gate !== -1 && invite !== -1 && gate < invite,
    'and it is gated on perm.own — the signed-in candidate’s OWN profile');
  ok(/v\.uid && v\.uid === perm\.uid/.test(cards),
    'own is keyed on the uid itself, never on admin privilege');

  /* the replacement rule: filing a new upload retires the Drive file it
     supersedes, best-effort, AFTER the document points at the new one */
  const build = await read('_scraper', 'build-candidates.mjs');
  const point = build.indexOf('[slot.driveId]: uploaded.id');
  const retire = build.indexOf('drive.deleteFile({ token, id: supersededId })');
  ok(point !== -1 && retire !== -1 && point < retire,
    'build-candidates: a superseded upload is removed from Drive only after ' +
    'the profile points at its replacement');
  ok(/supersededId !== uploaded\.id/.test(build),
    'and never the file just filed');
}

/* ------------------------------------------------- the Excel download

   A registered reader may download the postings the jobs page is showing as a
   real .xlsx (owner, 2026-08-26). Two things have to be true and neither is
   visible from a page: that a poster's CONTACT DETAILS cannot reach the file,
   and that a file this repository writes by hand is one Excel will actually
   open. So the workbook is BUILT here from the real data/jobs.json and read
   back out of its own bytes.

   The zip is written STORE (assets/oa-xlsx.js says why), so reading it needs
   no inflate — which is what lets this check be offline and dependency-free
   like everything else in this file. */

async function testJobExport() {
  const X = require(path.join(HERE, '..', 'assets', 'oa-xlsx.js'));
  const E = require(path.join(HERE, '..', 'assets', 'oa-jobexport.js'));

  /* ---- the writer: dates, links, types, and Excel's own limits ---------- */

  /* The epoch is 1899-12-30 and the reason is the phantom 29 February 1900
     Excel inherited from Lotus. Anchor it on days Excel itself is known for
     rather than on a formula restated here, or the check just repeats the
     code. */
  eq(X.dateSerial('1900-01-01'), 2, 'xlsx: 1 January 1900 is serial 2');
  eq(X.dateSerial('1900-03-01'), 61, 'xlsx: 1 March 1900 is serial 61');
  eq(X.dateSerial('2026-09-08'), 46273, 'xlsx: a real deadline is its own serial');
  eq(X.dateSerial('2025-12-31') + 1, X.dateSerial('2026-01-01'),
    'xlsx: consecutive days are consecutive serials');
  eq(X.dateSerial('2025-02-31'), null, 'xlsx: an impossible day is refused, never rolled over');
  eq(X.dateSerial('until filled'), null, 'xlsx: prose is not a date');
  eq(X.dateSerial(''), null, 'xlsx: an empty day is not a date');

  eq(X.safeUrl('https://example.edu/ad'), 'https://example.edu/ad', 'xlsx: an https target');
  eq(X.safeUrl('javascript:alert(1)'), '', 'xlsx: a javascript: URL is never a hyperlink');
  eq(X.safeUrl('/jobs.html'), '', 'xlsx: a hyperlink must be absolute — a workbook has no origin');
  eq(X.colLetter(0) + X.colLetter(25) + X.colLetter(26), 'AZAA', 'xlsx: column letters');
  eq(X.sheetNames([{ name: 'Data' }, { name: 'Data' }]), ['Data', 'Data (2)'],
    'xlsx: two sheets may not share a name — Excel refuses the file');
  eq(X.sheetNames([{ name: 'A[b]c*d?e:f/g\\h' }]), ['A b c d e f g h'],
    'xlsx: the characters Excel forbids in a tab name are dropped');

  const probe = X.build([{
    name: 'Probe',
    rows: [
      ['Header'],
      [{ date: '2026-09-08' }, { link: 'https://example.edu/ad', text: 'the ad' },
        true, 42, '', { link: 'javascript:alert(1)', text: 'nope' }],
    ],
  }]);
  eq(Array.from(probe.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04], 'xlsx: the file is a zip');
  const parts = unzipStore(probe);
  for (const need of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
    'xl/worksheets/_rels/sheet1.xml.rels']) {
    ok(parts[need], `xlsx: the package carries ${need}`);
  }
  const probeCells = sheetCells(parts['xl/worksheets/sheet1.xml']);
  eq(probeCells.A2.v, '46273', 'xlsx: a date cell holds the serial, not the text');
  eq(probeCells.A2.t, 'n', 'xlsx: …as a NUMBER, which is what makes it a date to Excel');
  ok(parts['xl/styles.xml'].includes('numFmtId="164"') &&
     /numFmtId="164"[^>]*formatCode="yyyy/.test(parts['xl/styles.xml']),
    'xlsx: and it is drawn under an ISO date format, which no locale can misread');
  eq(probeCells.B2.v, 'the ad', 'xlsx: a link cell shows its label');
  ok(parts['xl/worksheets/sheet1.xml'].includes('<hyperlink ref="B2"'),
    'xlsx: …and is a real hyperlink, so it is clickable in Excel');
  ok(parts['xl/worksheets/_rels/sheet1.xml.rels'].includes('Target="https://example.edu/ad"') &&
     parts['xl/worksheets/_rels/sheet1.xml.rels'].includes('TargetMode="External"'),
    'xlsx: …pointing at the advertisement itself');
  eq(probeCells.C2.t, 'b', 'xlsx: a boolean is a real Excel boolean, not 1/0');
  eq(probeCells.D2.v, '42', 'xlsx: a number is a number');
  ok(!probeCells.E2, 'xlsx: an empty value is an EMPTY cell, never a 0');
  eq(probeCells.F2.v, 'nope', 'xlsx: a refused URL degrades to its label');
  ok(!parts['xl/worksheets/_rels/sheet1.xml.rels'].includes('javascript'),
    'xlsx: …and NOTHING in the package points at it — a workbook opens outside the sandbox');
  /* autoFilter before hyperlinks: CT_Worksheet is a SEQUENCE, and Excel
     rejects a worksheet whose children are out of order. */
  const wsXml = parts['xl/worksheets/sheet1.xml'];
  ok(wsXml.indexOf('<autoFilter') < wsXml.indexOf('<hyperlinks>'),
    'xlsx: the worksheet children are in the schema\'s own order');

  const long = X.build([{ name: 'L', rows: [['h'], ['x'.repeat(X.MAX_CELL_CHARS + 500)]] }]);
  eq(sheetCells(unzipStore(long)['xl/worksheets/sheet1.xml']).A2.v.length, X.MAX_CELL_CHARS,
    'xlsx: a cell is truncated to what Excel can hold rather than corrupting the file');

  /* ---- the columns: what may be exported, pinned BOTH ways -------------- */

  const froms = new Set();
  E.COLUMNS.forEach((c) => (c.from || []).forEach((f) => froms.add(f)));
  const headers = E.COLUMNS.map((c) => c.header);

  eq([...froms].filter((f) => !PUBLIC_FIELDS.includes(f)), [],
    'export: every column reads a field the BUILD publishes (PUBLIC_FIELDS)');
  eq([...froms].filter((f) => E.CONTACT_FIELDS.includes(f)), [],
    'export: and not one of them is a Contact detail');
  eq([...froms].filter((f) => E.WITHHELD.includes(f)), [],
    'export: nor one of the three public fields deliberately withheld');
  eq(E.CONTACT_FIELDS.filter((f) => PUBLIC_FIELDS.includes(f)), [],
    'export: the contact block is not in PUBLIC_FIELDS either — the file it reads cannot carry one');
  eq(headers.length, new Set(headers).size, 'export: no two columns share a heading');
  eq(E.COLUMNS.filter((c) => !c.note || !c.type || !c.from || !c.from.length).map((c) => c.header),
    [], 'export: every column says what it is, what type it is and what it reads');

  /* The three derived buckets are computed against TODAY, so a workbook saved
     in September would still say "Closing soon" in December. None of them may
     be exported — the real dates are, which is what makes the file honest a
     month later. */
  eq(headers.filter((h) => /closing soon|expired|until filled|review ahead|last 7 days/i.test(h)),
    [], 'export: no column is one of the page\'s own today-relative buckets');

  /* ---- the workbook, over the REAL served file -------------------------- */

  const rows = JSON.parse(await readFile(JOBS, 'utf8'));
  const meta = { at: new Date('2026-08-26T09:30:00Z'), market: '2026-2027',
    total: rows.length, filters: [{ label: 'Location', values: ['Ireland', 'France'] }] };
  const sheets = E.sheets(rows, meta);

  eq(sheets.map((s) => s.name), ['Job postings', 'Columns', 'About this file'],
    'export: the DATA is the first sheet — read_excel and read_xlsx both default to it');
  eq(sheets[0].rows.length, rows.length + 1, 'export: one row per posting, under one header row');
  eq(sheets[0].rows[0], headers, 'export: the header row is the columns');
  eq(sheets[1].rows.length, E.COLUMNS.length + 1,
    'export: the dictionary describes every column, and only them');

  const book = X.build(sheets);
  const files = unzipStore(book);
  const data = sheetCells(files['xl/worksheets/sheet1.xml']);
  const dateCols = E.COLUMNS.map((c, i) => (c.type === 'Date' ? X.colLetter(i) : null))
    .filter(Boolean);
  ok(dateCols.length >= 3, 'export: the deadlines and the posting date are date columns');

  /* Every value in a date column is either an EMPTY cell (the posting names no
     such date) or a real date — never text that Excel would re-read under the
     reader's own locale, which is the whole reason this is a workbook. */
  const dateStyle = String(sheetCells(unzipStore(X.build([{ name: 'd',
    rows: [['h'], [{ date: '2026-01-01' }]] }]))['xl/worksheets/sheet1.xml']).A2.s);
  const badDates = [];
  for (let r = 2; r <= rows.length + 1; r++) {
    for (const col of dateCols) {
      const cell = data[col + r];
      if (!cell) continue;
      if (cell.t !== 'n' || cell.s !== dateStyle || !/^\d+$/.test(cell.v)) {
        badDates.push(col + r);
      }
    }
  }
  eq(badDates.slice(0, 5), [], 'export: every deadline in the file is a real Excel date');

  let dated = 0;
  E.COLUMNS.forEach((c, i) => {
    if (c.type !== 'Date') return;
    for (let r = 2; r <= rows.length + 1; r++) if (data[X.colLetter(i) + r]) dated++;
  });
  ok(dated > 100, `export: and the corpus really exercises them (${dated} dated cells)`);

  ok(files['xl/worksheets/_rels/sheet1.xml.rels'] &&
     files['xl/worksheets/_rels/sheet1.xml.rels'].includes('TargetMode="External"'),
    'export: the advertisement links are clickable');

  /* NOTHING THAT LOOKS LIKE AN ADDRESS, anywhere in the package. The build
     already strips one out of a posting's prose (stripRowEmails) and the
     contact block never reaches the served file at all — this is the check
     that says so about the thing the reader actually receives. */
  const EMAILISH = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const leaks = Object.keys(files).filter((n) => /worksheets\/sheet/.test(n) &&
    EMAILISH.test(files[n]));
  eq(leaks, [], 'export: no e-mail address anywhere in the workbook');

  const about = sheetCells(files['xl/worksheets/sheet3.xml']);
  const aboutText = Object.keys(about).map((k) => about[k].v).join(' | ');
  ok(/Contact details/.test(aboutText) && /never published/.test(aboutText),
    'export: and the file SAYS what it does not carry, rather than leaving it to be assumed');
  ok(aboutText.includes('Ireland  or  France'),
    'export: the About sheet names the filters that were in force');
  ok(aboutText.includes(String(rows.length)),
    'export: …and how many postings the page held in all');

  const none = E.sheets(rows.slice(0, 3), { at: meta.at, market: '2026-2027', total: 3, filters: [] });
  ok(JSON.stringify(none[2].rows).includes('None — this is every posting'),
    'export: with nothing filtering, it says so rather than leaving the row blank');

  eq(E.fileName({ at: new Date('2026-08-26T09:30:00Z'), market: '2026-2027' }),
    'operations-academia-job-postings-2026-2027-2026-08-26.xlsx',
    'export: the file names itself by market and by the day it was taken');

  /* An empty result set is still a valid workbook — a reader who has filtered
     down to nothing must get a file that opens, not a repair dialog. */
  const empty = unzipStore(X.build(E.sheets([], { market: '2026-2027', total: rows.length })));
  ok(empty['xl/worksheets/sheet1.xml'], 'export: a filtered-to-nothing download is still a workbook');
}

/* --------------------------------------------------- …and how it is wired */

async function testJobExportWiring() {
  const jobs = await readFile(path.join(HERE, '..', 'jobs.html'), 'utf8');
  const list = await readFile(path.join(HERE, '..', 'assets', 'oa-list.js'), 'utf8');
  const listCss = await readFile(path.join(HERE, '..', 'assets', 'oa-list.css'), 'utf8');
  const v3css = await readFile(path.join(HERE, '..', 'assets', 'v3.css'), 'utf8');
  const mod = await readFile(path.join(HERE, '..', 'assets', 'oa-jobexport.js'), 'utf8');

  for (const src of ['assets/oa-xlsx.js', 'assets/oa-jobexport.js']) {
    ok(jobs.includes(`<script defer src="${src}"></script>`),
      `export: jobs.html loads ${src}, deferred like every other script on it`);
  }
  ok(/actions:\s*window\.OAJobExport/.test(jobs),
    'export: the jobs mount declares the action');

  /* The ENGINE renders it, and that is not a style choice: buildBar() empties
     the bar whenever the filters are cleared, so a button the page appended
     for itself would disappear at the first press of Clear. */
  ok(/cfg\.actions/.test(list) && /actionsCell\.appendChild\(btn\)/.test(list),
    'export: the engine renders page-declared actions into the filter bar itself');
  ok(/actionEls\s*=\s*\[\]/.test(list),
    'export: …and rebuilds them with the bar, so Clear filters cannot lose one');
  ok(/a\.def\.refresh\(a\.btn, snap\)/.test(list),
    'export: render() refreshes an action, so its count is never a step behind the list');
  ok(/view:\s*function\s*\(\)\s*\{\s*return view\.slice\(\)/.test(list),
    'export: the engine exposes what the list is SHOWING, which is what gets downloaded');

  /* The gate. The bar is already covered by the page's sign-in lock, but a
     nudge is not an authorisation — the module refuses on its own. */
  ok(/whenSignedIn/.test(mod),
    'export: the download goes through the site\'s own signed-in gate');
  ok(!/OAAccounts\.hint\(\)\s*===\s*'in'\s*\)\s*\{[^}]*download/.test(mod),
    'export: …and never on the localStorage hint alone');

  /* A BUTTON, not a caption (owner, 2026-08-27). Both halves are asserted:
     the label carries the verb — "Excel" alone named a format and never the
     act — and the rule paints a green border, a ground and its own ink. What
     a reader actually SEES is measured in page-test.mjs, in both themes; this
     is the pin that the intent survives an edit to either stylesheet. */
  ok(/label:\s*'↓ Download Excel'/.test(mod),
    'export: the button says what it DOES, not just what format it writes');
  ok(/\.oa-action\s*\{[\s\S]{0,320}?border:\s*1px solid var\(--ok/.test(listCss),
    'export: it wears a green border, so it reads as something to press');
  ok(/\.oa-action\s*\{/.test(listCss) && /color:\s*var\(--ok/.test(listCss),
    'export: the button names its own ink as well as its ground (CLAUDE.md)');
  ok(/body\.v3 \.oa-action\s*\{[\s\S]{0,500}?border:\s*1px solid var\(--ok\)/.test(v3css),
    'export: …and is themed green for the live design too');
  ok(/max-width:\s*640px[\s\S]{0,2200}?\.oa-action\s*\{[\s\S]{0,220}?height:\s*42px/.test(listCss),
    'export: on a phone it is a 42px target like every other control in the bar');
  ok(/\.oa-clear,\s*\.oa-action\s*\{\s*display:\s*none/.test(listCss),
    'export: and it does not print');

  /* CLEAR FILTERS IS RED, in both stylesheets — the engine's own and the live
     design's override, which is the one the jobs page actually paints. A fix
     applied to only one of them is invisible on the site (oa-list.css) or
     lost on any page that mounts the engine without v3.css (v3.css alone). */
  ok(/\.oa-clear\s*\{[\s\S]{0,340}?border:\s*1px solid var\(--err/.test(listCss) &&
     /\.oa-clear\s*\{[\s\S]{0,340}?color:\s*var\(--err/.test(listCss),
    'clear filters: red border and red ink in the engine stylesheet');
  ok(/body\.v3 \.oa-clear\s*\{[\s\S]{0,200}?border:\s*1px solid var\(--err\)/.test(v3css),
    'clear filters: …and in the live design, which is what the site paints');
  /* A disabled control must not light up on hover: with nothing selected
     there is nothing to clear, and the old rule promised otherwise. */
  ok(/\.oa-clear:hover:not\(\[disabled\]\)/.test(listCss),
    'clear filters: its hover state is gated on the button doing anything');

  /* Both washes are DEFINED in both themes, or the button paints no ground at
     all in one of them and the fallback in oa-list.css — a light hex — would
     land on a dark card. */
  for (const tok of ['--err-soft', '--ok-soft']) {
    eq(v3css.split(tok + ':').length - 1, 2,
      `palette: ${tok} is defined in the light theme and the dark one`);
  }
}

/* ------------------------------------------------- WHO SPONSORED THE SITE

   assets/oa-sponsors.js records that a department paid for this site over a
   named period, and the two things that follow from it: their postings LEAD
   the jobs page and carry a "Sponsored" badge (owner, 2026-08-29 — CUHK
   Business School's Department of Decisions, Operations and Technology, 1
   September 2025 to 1 September 2027, "professional and discrete but visible
   to all users of the website").

   This suite is what makes a curated table safe. Three things are pinned and
   each of them is a way the feature could be quietly WRONG rather than
   broken:

     - it must say NO. A sponsor mark is a claim the site makes on somebody's
       behalf, so the expensive failure is a badge on a posting that has not
       earned one — and the site carries four other CUHK-ish postings, three
       of them a DIFFERENT UNIVERSITY (…, Shenzhen), which is precisely the
       shape a careless match would sweep in;
     - it must EXPIRE. The whole reason this is read in the browser rather
       than stamped into data/jobs.json is that a sponsorship ends on a date;
       if that is not measured, "it expires by itself" is a claim nobody has
       checked and the badge outlives the deal;
     - the badge must be PAINTED, in both stylesheets. oa-list.css is the
       engine's and v3.css is the live design's override, and a rule in only
       one of them is either invisible on the site or lost on the next page —
       CLAUDE.md records that trap under the Excel button. */
/* --------------------------------- what a reader who has not registered SEES

   Owner, 2026-08-29, from two screenshots of the site signed out: an
   unregistered reader may see the sponsor's posting and the universities
   behind the ones beside it — and a candidate's name — and nothing more. The
   card does not open on them, the details are drawn as an unreadable strip,
   and expanding a posting in place belongs to a registered reader who has
   opened the full list.

   THE ONE THING THIS BLOCK MUST NOT LET ANYBODY CLAIM is that it is security.
   Every dataset here is a served file on GitHub Pages that anybody may fetch,
   and no rule in this repository can change that without a backend to put it
   behind — so this is a decision about what the site SHOWS, and the pinned
   copy below is what keeps the pages from promising more than that. It is the
   same honesty the sign-in lock over the filter bar was written with; what
   changed is that its old last sentence ("Everything below stays readable
   either way") became false the moment the cards stopped opening.

   Who actually sees which shape is measured in a real browser by
   page-test.mjs — this pins the decision, the wiring and the words.         */
async function testReaderGate() {
  const GATE = require(path.join(HERE, '..', 'assets', 'oa-gate.js'));

  /* ---- the decision ----------------------------------------------------- */

  /* In Node there is no window and no accounts module, which is the "cannot
     tell" case: it says NO. A gate that unlocked when it could not find out
     would unlock for every reader whose CDN is blocked, which is the
     "fallback that is right most of the time" shape oa-sponsors.js was
     caught by and this repository now refuses everywhere. */
  eq(GATE.signedIn(), false, 'gate: with nothing to ask, it says the reader is not signed in');
  eq(GATE.locked(), true, 'gate: …so the reader is locked');
  eq(GATE.unavailable(), true, 'gate: …and it knows nobody can sign in from here');

  const rows = [{ id: 'a', institution: 'Somewhere' }];
  const lockedShape = GATE.cardOpen({ note: 'Sign in to read this posting' })(rows[0]);
  ok(lockedShape && lockedShape.blur === true,
    'gate: a locked card draws the blurred strip');
  eq(lockedShape.note, GATE.NOTE_UNAVAILABLE,
    'gate: …and with no way to sign in it says so, rather than offering a dead control');
  eq(lockedShape.run, null,
    'gate: a note with nothing behind it carries no click — the head is disabled instead');

  /* The test hook, which is what lets the browser checks put a reader on
     either side of this without a Firebase to sign them in. */
  GATE.__setForTest(true);
  eq([GATE.locked(), GATE.unavailable()], [true, false],
    'gate: forced locked — and then a sign-in IS offered, since the block is the test');
  const forcedLock = GATE.cardOpen({ note: 'Sign in to read this posting' })(rows[0]);
  eq(forcedLock.note, 'Sign in to read this posting',
    'gate: …so the page\'s own wording is what the strip carries');
  ok(typeof forcedLock.run === 'function', 'gate: …and pressing it does something');

  GATE.__setForTest(false);
  eq(GATE.locked(), false, 'gate: forced unlocked');
  eq(GATE.cardOpen({})(rows[0]), null,
    'gate: a signed-in reader with no fuller list opens the card where it stands');

  /* THE TEASER (owner: "it should only expand when a user is registered and
     has opened the full list"). Signed in, a card on the one-pager is a way
     IN to the posting rather than the posting: it carries the reader to the
     full list with that posting open. No padlock, no blur — nothing is
     locked for them. */
  const full = GATE.cardOpen({ full: (r) => 'jobs.html?job=' + r.id })(rows[0]);
  ok(full && full.blur === false,
    'gate: the signed-in teaser card is gated but NOT locked — nothing is blurred');
  eq(full.note, GATE.NOTE_FULL, 'gate: …and it says where the click goes');
  /* A row the page cannot name a page for falls back to opening in place,
     rather than to a click that navigates nowhere. */
  eq(GATE.cardOpen({ full: () => '' })(rows[0]), null,
    'gate: …and with no href to offer it simply opens the card here');
  GATE.__setForTest(null);

  /* ---- ONE PENDING ID, SEVERAL LISTS ------------------------------------

     `pending` is one variable in one module, and the one-pager mounts TWO
     gated lists that both watch the same auth state. Consuming it
     unconditionally meant whichever list was notified FIRST swallowed an id
     belonging to the other — press a candidate card signed out, sign in, and
     the profile you pressed stayed shut. Measured in a real browser by
     page-test.mjs; this pins the rule itself.

     Driven against a fresh instance with a `window` in place, since the
     module captures its global once at load and Node has none. The cache
     entry is dropped on both sides so no other check inherits either the
     instance or the global. */
  {
    const gatePath = require.resolve(path.join(HERE, '..', 'assets', 'oa-gate.js'));
    delete require.cache[gatePath];
    const hadWindow = 'window' in globalThis;
    const listeners = [];
    globalThis.window = {
      OAAccounts: {
        resolved: () => true,
        user: () => null,
        hint: () => 'out',
        failed: () => false,
        whenSignedIn: () => {},
        onChange: (fn) => listeners.push(fn),
      },
    };
    try {
      const G2 = require(gatePath);
      // a list that owns nothing, and one that owns the pressed row
      const opened = [];
      const mkList = (owns) => ({
        rerendered: 0,
        rerender() { this.rerendered += 1; },
        open(id) {
          if (!owns.includes(id)) return false;
          opened.push(id); return true;
        },
      });
      const teaser = mkList(['job-1']);          // notified FIRST, owns other rows
      const cands = mkList(['cand-1']);          // owns the row that was pressed
      G2.watch(teaser);
      G2.watch(cands);
      eq(listeners.length, 2, 'gate: both lists on a page watch the auth state');

      // the reader presses the CANDIDATE card, then signs in
      G2.cardOpen({})({ id: 'cand-1' }).run({ id: 'cand-1' });
      listeners.forEach((fn) => fn({ uid: 'u1' }));
      eq(opened, ['cand-1'],
        'gate: the pending card is opened by the list that OWNS it, not the one notified first');
      eq([teaser.rerendered, cands.rerendered], [1, 1],
        'gate: …while both lists still re-render, which is what the watch is for');

      // …and it is spent: a second sign-in event opens nothing again
      opened.length = 0;
      listeners.forEach((fn) => fn({ uid: 'u1' }));
      eq(opened, [], 'gate: …and the id is spent once it has been claimed');

      /* Signing OUT drops it: an id pressed in one session must never open a
         card for whoever signs in next on the same machine. */
      G2.cardOpen({})({ id: 'cand-1' }).run({ id: 'cand-1' });
      listeners.forEach((fn) => fn(null));
      opened.length = 0;
      listeners.forEach((fn) => fn({ uid: 'u2' }));
      eq(opened, [], 'gate: a sign-out drops the pending card rather than holding it for the next reader');
    } finally {
      if (!hadWindow) delete globalThis.window;
      delete require.cache[gatePath];
    }
  }

  /* ---- the ENGINE ------------------------------------------------------- */

  const engine = await readFile(path.join(HERE, '..', 'assets', 'oa-list.js'), 'utf8');
  /* THE VALUES ARE NEVER PUT INTO THE DOCUMENT. A blurred copy of the real
     text is a picture of a lock rather than a lock, and it would also be
     selectable, copyable and readable in one keystroke of devtools — so the
     locked branch returns before the table is built, and what it previews is
     the row LABELS. Read from the source because the alternative is to prove
     a negative in a browser about markup that is not there. */
  const locked = engine.slice(engine.indexOf('THE LOCKED CARD'),
    engine.indexOf("var table = el('table', { class: 'oa-kv' });"));
  ok(locked.length > 500, 'gate: the engine\'s locked branch is where this expects it');
  ok(!/kv\.value|kv\.html/.test(locked),
    'gate: the locked card never reads a row\'s VALUE — only the labels it would have shown');
  ok(/lockPreview/.test(locked) && /aria-hidden/.test(locked),
    'gate: the blurred strip is decoration and says so to assistive technology');
  ok(/return lockedLi/.test(locked),
    'gate: …and it returns before the details table is built at all');
  ok(/'aria-expanded': gate \? null/.test(engine) && /'aria-controls': gate \? null/.test(engine),
    'gate: a head that no longer discloses anything stops claiming to');

  /* `open(id)` ANSWERS whether it opened, and only for a row this list has —
     the other half of the claim rule above. Without the membership test a
     list would report success for an id it does not carry, which is exactly
     how the teaser swallowed the candidates' pending card. */
  const openFn = engine.slice(engine.indexOf('      open: function (id) {'),
    engine.indexOf('      rows: function ()'));
  ok(openFn.length > 200 && openFn.length < 1200,
    'gate: the engine\'s open() is where this expects it');
  ok(/return false/.test(openFn) && /return true/.test(openFn),
    'gate: open() says whether it opened the card');
  ok(/rows\[i\]/.test(openFn),
    'gate: …and only ever for a row this list actually carries');

  /* ---- BOTH stylesheets ------------------------------------------------- */

  /* oa-list.css is the engine's own and v3.css overrides it for the live
     design: a rule written in only one of them is either invisible on the
     site or lost on the next page. The Excel button, the sponsor rail and
     the Leaflet attribution box are all here for this reason. */
  const listCss = await readFile(path.join(HERE, '..', 'assets', 'oa-list.css'), 'utf8');
  const v3Css = await readFile(path.join(HERE, '..', 'assets', 'v3.css'), 'utf8');
  ok(/\.oa-card-lock-blur\s*\{[^}]*filter:\s*blur\(/.test(listCss),
    'gate: oa-list.css blurs the strip');
  ok(/\.oa-card-lock-blur\s*\{[^}]*user-select:\s*none/.test(listCss),
    'gate: …and it does not select, because decoration that highlights reads as a fault');
  ok(/body\.v3 \.oa-card-lock-blur/.test(v3Css) && /body\.v3 \.oa-card-lock-note/.test(v3Css),
    'gate: v3.css carries the live design\'s half of the same rule');
  /* THE PADLOCK IS ON THE LOCKED NOTE ONLY. The same strip carries the
     one-pager's "Open it on the full list", which a SIGNED-IN reader sees —
     a padlock in front of that says something untrue. */
  ok(/\.oa-card-lock\.is-blurred \.oa-card-lock-note::before/.test(listCss),
    'gate: the padlock is drawn only where something really is locked');
  ok(!/^\s*\.oa-card-lock-note::before/m.test(listCss),
    'gate: …never on the strip\'s note as such');
  ok(/@media print[\s\S]{0,700}?\.oa-card-lock \{ display: none/.test(listCss),
    'gate: a blurred run of labels is not printed — it is mush on paper');

  /* ---- the WIRING ------------------------------------------------------- */

  const jobs = await readFile(path.join(HERE, '..', 'jobs.html'), 'utf8');
  const home = await readFile(path.join(HERE, '..', 'index.html'), 'utf8');
  const past = await readFile(path.join(HERE, '..', 'previous-markets.html'), 'utf8');

  for (const [rel, html] of [['jobs.html', jobs], ['index.html', home],
    ['previous-markets.html', past]]) {
    ok(html.includes('<script defer src="assets/oa-gate.js"></script>'),
      `gate: ${rel} loads the module, deferred like every other script on it`);
    /* It asks OAAccounts who is reading, so it has to be loaded after it —
       the load-order half of the sponsors lesson, where a module handed an
       undefined dependency went on passing every check in Node. */
    ok(html.indexOf('assets/oa-accounts.js') < html.indexOf('assets/oa-gate.js'),
      `gate: ${rel} loads the accounts module before the gate that asks it`);
    ok(/cardOpen:\s*OAGate\.cardOpen\(/.test(html),
      `gate: ${rel} declares the gate on its list, through the module`);
    /* The gate is painted from the auth hint before the session restores, so
       every list HAS to be able to change shape late. Without this a
       signed-in reader keeps the locked cards until they navigate. */
    ok(/OAGate\.watch\(/.test(html),
      `gate: ${rel} re-renders its list when the auth state finally resolves`);
  }
  /* EVERY list a job posting or a candidate is drawn in. Read as a set rather
     than one page at a time: the archive is where postings GO when a season
     rolls, and leaving it open would have made the gate on the jobs page a
     matter of waiting rather than of registering. */
  eq((home.match(/cardOpen:\s*OAGate\.cardOpen\(/g) || []).length, 2,
    'gate: the one-pager gates BOTH its lists — the job teaser and the candidates');
  /* …and the teaser is the one that sends a signed-in reader to the full
     list, through the site's single answer to "which page carries this
     posting" rather than a fourth copy of that rule. */
  ok(/full:\s*function\s*\(r\)\s*\{\s*return NAV\.hrefFor\(r\);/.test(home),
    'gate: the teaser opens a posting on the page OAJobNav says carries it');
  ok(!/cardOpen[\s\S]{0,400}?full:/.test(jobs) && !/cardOpen[\s\S]{0,400}?full:/.test(past),
    'gate: the full lists open a posting where it stands — they ARE the full list');

  /* ---- NOTHING MERELY HIDDEN COUNTS AS WITHHELD -------------------------

     alerts.html's example e-mail carries REAL postings — a university, its
     department, the entry level, the country and both apply-by dates. The
     whole app is `hidden` when nobody is signed in, but the preview was built
     anyway (applyNewsDecisions re-renders it whenever the change-log
     decisions land, which is every page load), so all of it sat in the
     document of a signed-out reader. Hidden is not absent: it is the same
     picture-of-a-lock the cards refuse to draw. */
  const alertsJs = await readFile(path.join(HERE, '..', 'assets', 'oa-alerts.js'), 'utf8');
  const alertsHtml = await readFile(path.join(HERE, '..', 'alerts.html'), 'utf8');
  const preview = alertsJs.slice(alertsJs.indexOf('function renderPreview()'),
    alertsJs.indexOf('M.hasIntent(c)'));
  ok(preview.length > 200 && preview.length < 2500,
    'gate: the alerts preview is where this expects it');
  ok(/OAGate\.locked\(\)/.test(preview) && /return;/.test(preview),
    'gate: …and it draws nothing at all while the reader is not signed in');
  ok(alertsHtml.includes('<script defer src="assets/oa-gate.js"></script>'),
    'gate: alerts.html loads the module it asks');
  ok(alertsHtml.indexOf('assets/oa-accounts.js') < alertsHtml.indexOf('assets/oa-gate.js'),
    'gate: …after the accounts module the gate itself asks');
  /* The gate is the ONE definition; a second reading of the auth state here
     would be the drift every shared module in this repository exists to
     prevent. */
  ok(!/hint\(\)\s*===\s*'in'/.test(alertsJs),
    'gate: the alerts page keeps no private copy of "is this reader signed in"');

  /* ---- ONE definition of "is this reader signed in" --------------------- */

  const exp = await readFile(path.join(HERE, '..', 'assets', 'oa-jobexport.js'), 'utf8');
  ok(/function signedIn\(\)\s*\{[\s\S]{0,200}?G\.OAGate[\s\S]{0,120}?\}/.test(exp),
    'gate: the Excel download asks the gate who is signed in, not its own copy');
  ok(!/A\.hint\(\)\s*===\s*'in'/.test(exp),
    'gate: …so the button and the cards can never disagree about who is reading');
  ok(jobs.indexOf('assets/oa-gate.js') < jobs.indexOf('assets/oa-jobexport.js'),
    'gate: jobs.html loads the gate before the export that reads it');

  /* ---- THE COPY, which is the part that could quietly become a lie ------ */

  /* READ WITH THE COMMENTS STRIPPED, and bounded at BOTH ends. The block
     above the card EXPLAINS the sentence it no longer says, and quotes it to
     do so — a guard that could not tell the explanation from the copy would
     have to be satisfied by deleting the explanation, which is the shape
     CLAUDE.md records under the no-rebase check. And the first draft of this
     slice ended at the first `v3-cta-row`, which is in the HERO, hundreds of
     lines ABOVE the card: it came back empty and every check below it passed
     on nothing. Hence the length assertion, which is what caught it. */
  const jobsCopy = jobs.replace(/<!--[\s\S]*?-->/g, '');
  const card = jobsCopy.slice(jobsCopy.indexOf('class="v3-lock-card"'),
    jobsCopy.indexOf('<div id="oa-jobs">'));
  ok(card.length > 200 && card.length < 2000,
    'gate: the sign-in card is where this expects it');
  ok(!/stays readable either way/i.test(jobsCopy),
    'gate: the sign-in card no longer promises the postings stay readable — they do not');
  ok(/universities hiring this season are listed below/i.test(card),
    'gate: …it says what a reader without an account DOES get');
  ok(/Excel/i.test(card),
    'gate: …and still names the download, the only place a signed-out reader is told of it');
  /* NOTHING may describe this as security. The data is public and stays
     public; a page that implied otherwise would be making a promise the
     architecture cannot keep. */
  for (const [rel, html] of [['jobs.html', jobs], ['index.html', home],
    ['previous-markets.html', past]]) {
    const prose = html.replace(/<!--[\s\S]*?-->/g, '');
    ok(!/(private|secure|protected|confidential)/i.test(
      prose.slice(prose.indexOf('v3-lock-card') >= 0 ? prose.indexOf('v3-lock-card') : 0,
        prose.indexOf('v3-lock-card') >= 0 ? prose.indexOf('v3-lock-card') + 1200 : 0)),
      `gate: ${rel} never calls the gate privacy or security — the files are served to anybody`);
  }
  const gateSrc = await readFile(path.join(HERE, '..', 'assets', 'oa-gate.js'), 'utf8');
  ok(/NOT AN ACCESS CONTROL/.test(gateSrc),
    'gate: and the module itself says so at the top, where the next reader will look');
}

async function testSponsors() {
  const SP = require(path.join(HERE, '..', 'assets', 'oa-sponsors.js'));
  const served = JSON.parse(await readFile(JOBS, 'utf8'));

  /* ---- the record itself ------------------------------------------------ */

  ok(SP.SPONSORS.length >= 1, 'sponsors: the table names at least one sponsor');
  for (const s of SP.SPONSORS) {
    ok(/^\d{4}-\d{2}-\d{2}$/.test(s.from) && /^\d{4}-\d{2}-\d{2}$/.test(s.to),
      `sponsors: ${s.institution} names both ends of its window as ISO days`);
    ok(s.from < s.to, `sponsors: ${s.institution}'s window runs forwards`);
    ok(Array.isArray(s.units) && s.units.length > 0,
      `sponsors: ${s.institution} names the department(s) it sponsors from`);
    /* The university must be one the site can actually resolve, or the entry
       silently matches nothing for ever — a table that says a place is a
       sponsor and never marks one of its postings is worse than no table. */
    ok(!!SCHOOLS.institutionKey(s.institution),
      `sponsors: ${s.institution} resolves to an institution key`);
  }

  /* ---- WHO IT MARKS, over the file the site actually serves -------------- */

  const INSIDE = '2026-08-29';          // a day inside the CUHK window
  const marked = served.filter((r) => SP.isSponsored(r, INSIDE));
  eq(marked.length, 1, 'sponsors: exactly one served posting is sponsored today');
  eq(marked[0].id, '2027-the-chinese-university-of-hong-kong-20260827',
    'sponsors: …and it is the CUHK Decisions, Operations and Technology posting');

  /* THE ONE THAT MATTERS. institutionKey folds "The", resolves the acronym
     and keeps a separately-named campus separate — so a Shenzhen posting is a
     different university and must never be swept in. If institutionKey ever
     stops keeping them apart, three innocent postings start claiming a
     sponsorship, and nothing else in this repository would notice. */
  const shenzhen = served.filter(
    (r) => /hong kong,\s*shenzhen/i.test(r.institution || ''));
  ok(shenzhen.length >= 1, 'sponsors: the served file still carries a Shenzhen posting to test against');
  eq(shenzhen.filter((r) => SP.isSponsored(r, INSIDE)).map((r) => r.id), [],
    'sponsors: CUHK Shenzhen is a DIFFERENT university and is never marked');

  /* Same university, a department the record does not name. The tracking
     workbook writes a field code ("OM/IS") where the site asks for a
     department, and guessing that one names the other is exactly the
     "curated, never guessed" line every other table here is held to. */
  const omis = served.find((r) => (r.unit || r.department) === 'OM/IS' &&
    SCHOOLS.institutionKey(r.institution) === SCHOOLS.institutionKey(
      'The Chinese University of Hong Kong'));
  if (omis) {
    ok(!SP.isSponsored(omis, INSIDE),
      'sponsors: a department the record does not name is not marked, however close');
  }

  /* ---- IT EXPIRES, which is the whole reason it is read in the browser --- */

  const CUHK = marked[0];
  eq(SP.isSponsored(CUHK, '2025-08-31'), false,
    'sponsors: nothing is marked the day BEFORE the sponsorship begins');
  eq(SP.isSponsored(CUHK, '2025-09-01'), true,
    'sponsors: …and it is marked from its first day (`from` is inclusive)');
  eq(SP.isSponsored(CUHK, '2027-08-31'), true,
    'sponsors: still marked on the last day of the window');
  eq(SP.isSponsored(CUHK, '2027-09-01'), false,
    'sponsors: and NOT on the day it ends (`to` is exclusive) — it expires by itself');

  /* The second gate: a posting advertised before they became a sponsor is not
     retrospectively one of theirs, and a row with no date is never guessed at. */
  eq(SP.isSponsored({ ...CUHK, posted: '2025-08-31' }, INSIDE), false,
    'sponsors: a posting made before the window is not marked inside it');
  eq(SP.isSponsored({ ...CUHK, posted: '' }, INSIDE), false,
    'sponsors: a posting with no date is never marked — this says no when it cannot tell');

  /* ---- the matching is FOLDED, not literal ------------------------------ */

  for (const name of ['CUHK', 'Chinese University of Hong Kong',
    'The Chinese University of Hong Kong']) {
    ok(SP.isSponsored({ ...CUHK, institution: name }, INSIDE),
      `sponsors: "${name}" reaches the record — one spelling per place, as everywhere`);
  }
  ok(SP.isSponsored({ ...CUHK, unit: 'Decisions, Operations & Technology' }, INSIDE),
    'sponsors: "&" reads as "and", the same reading the site\'s own search takes');
  ok(SP.isSponsored({ ...CUHK, unit: '', department: 'Decisions, Operations and Technology' }, INSIDE),
    'sponsors: a row that names its department in the joined field is read too');
  ok(!SP.isSponsored({ ...CUHK, institution: 'University of Hong Kong' }, INSIDE),
    'sponsors: a DIFFERENT Hong Kong university is not a near-enough match');

  /* ---- the ORDER --------------------------------------------------------- */

  const older = { id: 'x', institution: 'Somewhere', unit: 'OM', posted: '2026-08-28' };
  eq(SP.compare(CUHK, older, INSIDE) < 0, true,
    'sponsors: a sponsored posting leads a NEWER unsponsored one');
  eq(SP.compare(older, CUHK, INSIDE) > 0, true, 'sponsors: …in either argument order');
  eq(SP.compare(CUHK, { ...older, featured: true }, INSIDE) < 0, true,
    'sponsors: a sponsorship outranks the maintainer\'s own Featured flag');
  eq(SP.compare({ ...older, featured: true }, { ...older, id: 'y' }, INSIDE) < 0, true,
    'sponsors: and Featured still leads everything below it');
  eq(SP.compare({ ...older, id: 'a', posted: '2026-01-01' },
    { ...older, id: 'b', posted: '2026-06-01' }, INSIDE) > 0, true,
    'sponsors: with neither, the newest posting still leads');
  /* Once the window closes the comparator must fall back to exactly what the
     page did before this shipped, or the jobs page keeps a stale lead row. */
  eq(SP.compare(CUHK, older, '2027-09-02') > 0, true,
    'sponsors: after the window the sponsor no longer leads — the order simply reverts');

  /* A comparator that is not ANTISYMMETRIC sorts differently in different
     engines, and Array#sort is free to do anything at all with one. Drive
     every pair of the real list through it rather than a fixture: ties are
     ties (two postings of the same day rank equal, which is what leaves the
     stable sort to keep them in the order they arrived), but no pair may
     ever claim BOTH that a leads b and that b leads a. */
  const sample = served.slice(0, 40);
  const broken = [];
  for (let i = 0; i < sample.length; i++) {
    for (let j = 0; j < sample.length; j++) {
      const ab = SP.compare(sample[i], sample[j], INSIDE);
      const ba = SP.compare(sample[j], sample[i], INSIDE);
      if (Math.sign(ab) !== -Math.sign(ba)) broken.push(sample[i].id + ' vs ' + sample[j].id);
    }
  }
  eq(broken.slice(0, 3), [], 'sponsors: the comparator is antisymmetric over the real list');
  /* …and sorting an already-sorted list changes nothing, which is the
     property a reader actually sees: the page does not reshuffle itself. */
  const sorted = sample.slice().sort((a, b) => SP.compare(a, b, INSIDE)).map((r) => r.id);
  const again = sample.slice().sort((a, b) => SP.compare(a, b, INSIDE))
    .sort((a, b) => SP.compare(a, b, INSIDE)).map((r) => r.id);
  eq(again, sorted, 'sponsors: …so sorting is idempotent');

  /* ---- the BADGE, and that the module owns the word --------------------- */

  eq(SP.badge(CUHK, INSIDE), { text: 'Sponsored', cls: 'oa-label-sponsor' },
    'sponsors: the badge is the owner\'s word and the class the stylesheets paint');
  eq(SP.badge(older, INSIDE), null, 'sponsors: …and nothing at all for everyone else');

  /* ---- the WIRING ------------------------------------------------------- */

  const jobs = await readFile(path.join(HERE, '..', 'jobs.html'), 'utf8');
  const home = await readFile(path.join(HERE, '..', 'index.html'), 'utf8');

  for (const [rel, html] of [['jobs.html', jobs], ['index.html', home]]) {
    ok(html.includes('<script defer src="assets/oa-sponsors.js"></script>'),
      `sponsors: ${rel} loads the module, deferred like every other script on it`);
    /* The windows are generous on purpose: both pages carry a paragraph of
       reasoning between the hook and the call, and a guard that could only be
       satisfied by DELETING the explanation is the shape CLAUDE.md records
       under the no-rebase check. What is pinned is that the badge comes from
       the module inside the badges callback, not how tersely it is written. */
    ok(/badges:\s*function[\s\S]{0,900}?OASponsors\.badge\(r\)/.test(html),
      `sponsors: ${rel} draws the badge THROUGH the module, never its own copy of the word`);
    ok(/onCard:\s*function[\s\S]{0,600}?OASponsors\.markCard\(li, r\)/.test(html),
      `sponsors: ${rel} puts the rail on the card`);
    ok(!/['"]Sponsored['"]/.test(html.replace(/OASponsors/g, '')),
      `sponsors: ${rel} never writes the badge's own text — one definition, like every other`);
  }

  /* BOTH lists lead with the sponsor (owner, 2026-08-29, from a screenshot of
     the one-pager: the mark was on the card and the card was second). The
     first build left the teaser date-ordered on the reasoning that "the ten
     most recent postings" would become false — but that heading names WHICH
     ten, not what order they are in, and the teaser's `prepare` still selects
     them by date before this comparator ever runs. So a posting outside the
     newest ten is still not shown, and the heading stays true. */
  for (const [rel, html] of [['jobs.html', jobs], ['index.html', home]]) {
    ok(/sort:\s*function\s*\(a, b\)\s*\{\s*return OASponsors\.compare\(a, b\);/.test(html),
      `sponsors: ${rel} sorts through the module`);
  }
  /* …and the teaser's SELECTION is still by date, which is what keeps its own
     heading honest. */
  ok(/prepare:[\s\S]{0,400}?localeCompare\(a\.posted[\s\S]{0,80}?slice\(0, 10\)/.test(home),
    'sponsors: the teaser still SELECTS the ten most recent by date before ordering them');
  ok(!/b\.featured\s*\?\s*1\s*:\s*-1/.test(jobs),
    'sponsors: …and the jobs page kept no second, private copy of the Featured rule');

  /* The module must be loaded BEFORE the export reads it: oa-jobexport.js
     takes it as a factory argument, and a UMD factory handed `undefined`
     silently exports a column that answers "no" for everybody. */
  ok(jobs.indexOf('assets/oa-sponsors.js') < jobs.indexOf('assets/oa-jobexport.js'),
    'sponsors: jobs.html loads the module before the export that reads it');

  /* ---- AND THE SAME FOR ITS OWN DEPENDENCY, which is the one this suite
     was green without.

     oa-sponsors.js asks oa-schools.js whether two spellings are one
     university. NEITHER of these pages loaded that file — only the forms,
     the alerts page, /admin-area and the directory did — so in the browser
     the factory was handed `undefined`. The first draft fell back to a plain
     fold, which still matched "The Chinese University of Hong Kong" against
     itself: every check in this suite passed (Node resolves the dependency
     through require) while the SITE silently stopped recognising "CUHK",
     "Chinese University of Hong Kong" and "The Chinese University of Hong
     Kong (CUHK)". Three spellings, marked in the tests and unmarked on the
     page, with nothing anywhere to say so.

     So both halves are pinned: the pages load it FIRST, and the module says
     nothing at all without it. */
  for (const [rel, html] of [['jobs.html', jobs], ['index.html', home]]) {
    ok(html.includes('<script defer src="assets/oa-schools.js"></script>'),
      `sponsors: ${rel} loads oa-schools.js, which the sponsor rule is built on`);
    ok(html.indexOf('assets/oa-schools.js') < html.indexOf('assets/oa-sponsors.js'),
      `sponsors: …BEFORE oa-sponsors.js, whose factory is handed it`);
  }

  /* Drive the BROWSER branch: evaluate the file with no OASchools on the root
     and check it refuses to answer rather than answering badly. Reading the
     source for a `return fold(v)` would pass the moment somebody wrote the
     same fallback a different way; this measures the behaviour. */
  const sponsorSrc = await readFile(path.join(HERE, '..', 'assets', 'oa-sponsors.js'), 'utf8');
  const bare = {};
  // eslint-disable-next-line no-new-func
  new Function('self', sponsorSrc)(bare);
  const NOSCHOOLS = bare.OASponsors;
  ok(!!NOSCHOOLS, 'sponsors: the module still LOADS without oa-schools.js — it must not throw on a page that forgot it');
  eq(NOSCHOOLS.isSponsored(CUHK, INSIDE), false,
    'sponsors: …but marks nothing at all, rather than half-recognising some spellings');
  for (const name of ['CUHK', 'Chinese University of Hong Kong']) {
    eq(NOSCHOOLS.isSponsored({ ...CUHK, institution: name }, INSIDE), false,
      `sponsors: …including "${name}", the exact spelling a silent fold used to drop`);
  }

  /* ---- the CSS, in BOTH stylesheets ------------------------------------- */

  const listCss = await readFile(path.join(HERE, '..', 'assets', 'oa-list.css'), 'utf8');
  const v3css = await readFile(path.join(HERE, '..', 'assets', 'v3.css'), 'utf8');

  /* It paints its own ground, so it must name its own ink — the base
     .oa-label sets #fff, which on a pale purple wash is invisible. This is
     the rule CLAUDE.md states three times over. */
  for (const [name, css, sel] of [
    ['oa-list.css', listCss, '\\.oa-label-sponsor'],
    ['v3.css', v3css, 'body\\.v3 \\.oa-label-sponsor'],
  ]) {
    const rule = new RegExp(sel + '\\s*\\{[\\s\\S]{0,400}?\\}');
    const m = rule.exec(css);
    ok(!!m, `sponsors: ${name} paints the badge`);
    if (m) {
      ok(/background-color:\s*var\(--sponsor-soft/.test(m[0]),
        `sponsors: ${name} gives the badge its ground`);
      ok(/[^-]color:\s*var\(--sponsor[,)]/.test(m[0]),
        `sponsors: …and names its own ink (CLAUDE.md: anything that paints a ground must)`);
      ok(/border:\s*1px solid var\(--sponsor-line/.test(m[0]),
        `sponsors: …and its hairline, which is what makes it an OUTLINE pill and not a second Featured`);
      ok(!/[^-]background:\s/.test(m[0]),
        `sponsors: ${name} uses background-color, never the shorthand that blanks a background-image`);
    }
  }
  ok(/\.oa-card\.oa-sponsored\s*\{[\s\S]{0,160}?border-left:\s*3px solid var\(--sponsor/.test(listCss),
    'sponsors: the rail down the card edge, in the engine stylesheet');
  ok(/body\.v3 \.oa-card\.oa-sponsored\s*\{[\s\S]{0,160}?border-left:\s*3px solid var\(--sponsor\)/.test(v3css),
    'sponsors: …and in the live design, which is the one the site paints');
  /* AND INSIDE A PANEL. `body.v3 .v3-panel .oa-card { border: 0 }` has the
     SAME specificity as the rule above (0,3,1 each) and sits ~600 lines
     later, so load order silently blanked the rail on the one-pager's teaser
     while it worked on the jobs page. A rule that can be beaten by a rule of
     equal weight further down the file is not a rule. */
  ok(/body\.v3 \.v3-panel \.oa-card\.oa-sponsored\s*\{[\s\S]{0,160}?border-left:\s*3px solid var\(--sponsor\)/.test(v3css),
    'sponsors: the rail survives the panel card reset, which blanks every border');
  ok(v3css.indexOf('body.v3 .v3-panel .oa-card.oa-sponsored') >
     v3css.indexOf('body.v3 .v3-panel .oa-card {'),
    'sponsors: …and is declared AFTER the reset it has to beat');

  /* Every token defined in BOTH themes, or the badge paints no ground at all
     in one of them and oa-list.css's light-hex fallback lands on a dark card. */
  for (const tok of ['--sponsor', '--sponsor-soft', '--sponsor-line']) {
    eq(v3css.split(tok + ':').length - 1, 2,
      `palette: ${tok} is defined in the light theme and the dark one`);
  }

  /* ---- the EXPORT ------------------------------------------------------- */

  const E = require(path.join(HERE, '..', 'assets', 'oa-jobexport.js'));
  const col = E.COLUMNS.find((c) => c.header === 'Sponsored');
  ok(!!col, 'sponsors: the Excel download carries a Sponsored column');
  if (col) {
    eq(col.cell(CUHK), true, 'sponsors: …TRUE for the sponsor\'s posting');
    eq(col.cell(older), false, 'sponsors: …and a real boolean FALSE for everyone else');
    /* Its `from` names the published fields the answer is DERIVED from —
       there is no `sponsored` in data/jobs.json and deliberately never will
       be. testJobExport pins every `from` against PUBLIC_FIELDS, so naming a
       field that does not exist would fail there rather than here. */
    ok((col.from || []).length > 0 && col.from.every((f) => PUBLIC_FIELDS.includes(f)),
      'sponsors: …reading only fields the build actually publishes');
  }
  ok(!PUBLIC_FIELDS.includes('sponsored'),
    'sponsors: nothing is stamped into data/jobs.json — a sponsorship expires, a built field cannot');

  /* ---- the FROZEN ARCHIVES do not move ---------------------------------- */

  for (const rel of ['v1', 'v2']) {
    const dir = path.join(HERE, '..', rel);
    const hits = [];
    for (const f of await readdir(dir, { recursive: true }).catch(() => [])) {
      if (typeof f === 'string' && /oa-sponsors\.js$/.test(f)) hits.push(f);
    }
    eq(hits, [], `sponsors: /${rel}/ does not carry the module — an archive does not move`);
  }
}

/* --------------------------------------------------------------- analytics

   The page was four Google Sheets <iframe>s and they had been dead since 2023
   (Universal Analytics was switched off in July that year and its properties
   deleted the next). A dead embed renders as an empty box, so what is pinned
   here is mostly the honesty the replacement is built for: that a day is never
   counted twice, that an unreachable source cannot shorten the history, and
   that nothing on the page claims the frozen archive is current. */
async function testAnalytics() {
  const A = require(path.join(HERE, '..', 'assets', 'oa-analytics-model.js'));

  /* --- a day belongs to exactly ONE source ------------------------------- */

  const days = {};
  A.mergeDays(days, { '2026-08-02': [5, 6, 14], '2026-08-01': [10, 12, 30] }, 'ga4');
  A.mergeDays(days, { '2026-08-02': [99, 99, 99], '2026-08-03': [7, 8, 20] }, 'usage');
  eq(days['2026-08-02'], [5, 6, 14],
    'the higher-authority source keeps a day two sources both measured');
  eq(A.summarise(A.series(days)).visitors, 22,
    'a contested day is counted ONCE — summing two measurements of one Tuesday ' +
    'would double every day of the overlap, and the chart would look fine');

  /* THE ORDER IS PART OF THE COOKIELESS DECISION, not a detail. GA4 runs with
     `client_storage: 'none'` so that the site needs no consent banner, and a
     browser storing nothing cannot recognise a returning visitor — so GA4's
     "users" is nearer "sessions", and it must not own a day the first-party
     record also measured. Pinned here against the tag's own setting below, so
     the two cannot drift apart silently. */
  eq(A.SOURCE_ORDER, ['usage', 'ga4', 'history'],
    'the first-party record outranks cookieless GA4 for a day both measured');

  /* a row of three zeroes is DROPPED rather than stored — the file would
     otherwise carry a decade of days that only say "we have no idea", and the
     charts would plot them as real zeroes */
  ok(A.dayRow(0, 0, 0) === null, 'a day with no measurement in it is not a day');
  eq(A.dayRow(3, 0, 0), [3, 0, 0], 'a day with any measurement is kept');

  /* --- the series is SORTED, whatever order the file holds --------------- */

  const jumbled = { '2026-08-03': [3, 3, 3], '2026-08-01': [1, 1, 1], '2026-08-02': [2, 2, 2] };
  eq(A.series(jumbled).map((r) => r.day), ['2026-08-01', '2026-08-02', '2026-08-03'],
    'the series sorts by day — JSON key order is an implementation detail, and a ' +
    'chart plotted in insertion order would be scribble');
  eq(A.series(jumbled, { from: '2026-08-02' }).map((r) => r.day),
    ['2026-08-02', '2026-08-03'], 'and clips to a range');

  /* --- the rolling mean is TRAILING, and says so by emitting null -------- */

  eq(A.rollingMean([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5],
    'the mean is trailing and emits null until it has a full window — a centred ' +
    'one would need days that have not happened, so the line would droop at the ' +
    'right-hand end, which is exactly where a reader looks');

  /* --- the weekday bucket reads the day in UTC --------------------------- */

  /* 2026-08-03 IS a Monday. Read with `new Date('2026-08-03')` and rendered in
     a local zone, every reader west of Greenwich gets the day before and the
     whole chart shifts by one bar — silently, and only for some readers. */
  const wk = A.byWeekday([{ day: '2026-08-03', visitors: 10, sessions: 0, pageviews: 0 }]);
  eq(wk[0].name, 'Monday', 'the weekday buckets start on Monday');
  eq(wk[0].total, 10, 'and a Monday lands in the Monday bucket, read in UTC');
  eq(wk.reduce((n, b) => n + b.days, 0), 1, 'each day is counted in exactly one bucket');

  /* it is a MEAN, not a total: a range rarely holds the same number of each
     weekday, and a total would rank the weekdays by how many the range had */
  const twoMondays = A.byWeekday([
    { day: '2026-08-03', visitors: 10, sessions: 0, pageviews: 0 },
    { day: '2026-08-10', visitors: 20, sessions: 0, pageviews: 0 },
    { day: '2026-08-04', visitors: 30, sessions: 0, pageviews: 0 },
  ]);
  eq(twoMondays[0].mean, 15, 'two Mondays average rather than sum');
  eq(twoMondays[1].mean, 30, 'and one Tuesday does not out-rank them merely by being one');

  const mo = A.byMonth([{ day: '2026-09-15', visitors: 7, sessions: 0, pageviews: 0 }]);
  eq(mo[8].name, 'September', 'the months are in calendar order');
  eq(mo[8].total, 7, 'and September lands in September');

  /* --- staleness: the failure this whole page exists to make visible ----- */

  const fresh = { days: { '2026-08-28': [1, 1, 1] } };
  ok(A.staleness(fresh, Date.parse('2026-08-29T00:00:00Z')) === null,
    'a dataset that gained a day yesterday is not stale');
  const old = A.staleness({ days: { '2026-01-01': [1, 1, 1] } },
    Date.parse('2026-08-29T00:00:00Z'));
  ok(old && old.age > A.STALE_DAYS,
    'one that stopped in January is, and the page says so — a pipeline that has ' +
    'quietly stopped and a site nobody visits look identical from outside, which ' +
    'is how the old charts stayed dead for three years');
  ok(A.staleness({ days: {} }, Date.now()) === null,
    'but an EMPTY dataset is unconfigured, not stale — a different sentence');

  /* --- the served file is valid before anything is configured ------------ */

  const served = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'analytics.json'), 'utf8'));
  eq(served.dayFields, A.DAY_FIELDS,
    'the served file names its own day fields — self-describing rather than ' +
    'something a reader has to read the model to learn');
  /* `frozen` means "an ARCHIVE of a closed period", not "unrecoverable". The
     figures came from UA's networkDomain and GA4 has no such dimension, from
     which it was once concluded here that they could never be shown again —
     wrong, and corrected on 2026-08-29: a browser cannot see its own
     reverse-DNS, but this site's own Cloud Function can. So what is pinned is
     the INVARIANT rather than the flag's current value: a section carrying
     live coverage counts is never labelled an archive. */
  ok(served.universities && typeof served.universities.frozen === 'boolean',
    'the served universities section says whether it is an archive or the current record');
  ok(!(served.universities.seen > 0) || served.universities.frozen === false,
    'a section fed by the live resolver is never marked frozen');
  ok(typeof served.version === 'number' && served.days && served.totals,
    'and it is a complete, valid dataset even with every source switched off');

  /* nothing under data/ may carry an address — the rule every served file
     here is held to, and this one is built from a collection of sessions */
  const rawServed = await readFile(path.join(HERE, '..', 'data', 'analytics.json'), 'utf8');
  ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(rawServed),
    'the analytics file carries no e-mail address');
  ok(!/[?&]/.test(Object.keys(served.days).join('')), 'the day keys are plain dates');

  /* --- the page's wiring ------------------------------------------------- */

  const html = await readFile(path.join(HERE, '..', 'analytics.html'), 'utf8');
  /* READ WITH THE COMMENTS STRIPPED. The page still EXPLAINS the four embeds
     it no longer has, and a guard that could not tell the explanation from the
     thing would have to be satisfied by deleting the explanation — the rule
     the no-rebase check in testReviewWiring already had to learn. */
  const htmlLive = html.replace(/<!--[\s\S]*?-->/g, '');
  ok(!/<iframe/i.test(htmlLive),
    'analytics.html embeds nothing — the four dead Google Sheets charts are gone');
  ok(!/docs\.google\.com/.test(htmlLive),
    'and it names no spreadsheet: those stopped being fed when UA was retired');
  ok(/<iframe/i.test(html) && /Universal Analytics/.test(html),
    'but the page still records WHY they went — the comment is the explanation, ' +
    'and the check above must never be satisfiable by deleting it');
  for (const src of ['assets/oa-analytics-model.js', 'assets/oa-charts.js', 'assets/oa-analytics.js']) {
    ok(new RegExp('<script defer src="' + src.replace(/[/.]/g, '\\$&') + '"').test(html),
      `analytics.html loads ${src}, deferred like every other script on this site`);
  }
  ok(/<link href="assets\/oa-analytics\.css" rel="stylesheet">/.test(html),
    'and its stylesheet');
  ok(/id="oa-analytics"/.test(html), 'the mount point is present');
  ok(/<noscript>/.test(html),
    'and a noscript state, because the figures are drawn in the browser');

  /* the lede must not still apologise for an embed's own styling */
  ok(!/render in their own light styling/.test(html),
    'the apology for the embeds\' fixed light styling went with the embeds');

  /* --- the page module ---------------------------------------------------*/

  const page = await readFile(path.join(HERE, '..', 'assets', 'oa-analytics.js'), 'utf8');
  ok(/cache: 'no-cache'/.test(page),
    'it fetches data/ with no-cache — Pages serves data/ with ten minutes of ' +
    'freshness, so without it a returning reader is shown what they already had');
  ok(/OAAnalytics/.test(page) && /OACharts/.test(page),
    'and reads the shared model rather than carrying its own copy of the rules');

  /* ------------------------------ nothing non-public reaches a served file

     Owner, 2026-08-29: no admin pages, no past-version pages, no test pages,
     no admin-related data shown to public visitors. The first build leaked all
     three — /admin-area.html (87 views) and /admin-area (6), /v3/ and
     /v3/post-a-job.html — into data/analytics.json, which Pages serves to
     anyone who asks. */

  eq(A.normPath('/admin-area'), A.normPath('/admin-area.html'),
    'both spellings of one page fold to one path — Pages serves a file under ' +
    'each, and a filter matching only the spelling somebody thought of would ' +
    'have leaked the admin desk under its other name');
  eq(A.normPath('/index.html'), '/', 'the home page is one row, not two');
  eq(A.normPath('/jobs'), '/jobs.html',
    'the canonical form is the one the pages own canonical tags name');
  eq(A.normPath('/post-a-job.html?ref=abc123'), '/post-a-job.html',
    'a query string never survives — it can carry a posting id and this file is public');

  for (const bad of ['/admin-area', '/admin-area.html', '/admin-area/', '/ADMIN-AREA',
    '/v1/', '/v2/index.html', '/v3/post-a-job.html', '/v9/anything',
    '/test/x', '/preview/y', '/staging/z', '/_scraper/build.mjs']) {
    ok(!A.isPublicPath(bad), `withheld from the public file: ${bad}`);
  }
  for (const good of ['/', '/index.html', '/jobs', '/jobs.html', '/universities.html',
    '/post-a-job.html', '/previous-markets.html', '/analytics.html']) {
    ok(A.isPublicPath(good), `still published: ${good}`);
  }
  /* the guard must not swallow a legitimate page that merely starts the same */
  ok(A.isPublicPath('/version-history.html'),
    'a page whose name merely begins like an archive is not an archive');
  ok(A.isPublicPath('/testimonials.html'),
    'and one that merely begins with "test" is not a test page');

  /* the CHOKEPOINT: a source that forgot to filter still cannot leak */
  const leaky = A.mergePages(new Map(), [
    { path: '/admin-area.html', views: 87 },
    { path: '/v3/', views: 21 },
    { path: '/jobs', views: 467 },
    { path: '/jobs.html', views: 1 },
  ]);
  const got = Array.from(leaky.keys()).sort();
  eq(got, ['/jobs.html'],
    'mergePages is the chokepoint every source funnels through — a leg that ' +
    'forgets to filter, or one added later, still cannot put an admin or ' +
    'archived path into a world-readable file');

  /* WITHIN one source, two spellings of a page are ONE page and their views
     ADD. Pages serves /jobs and /jobs.html from one file, and the first build
     recorded 467 and 211 — a plain first-claim-wins published 467, losing a
     third of the count in the direction nobody checks, because the row is
     still there and still looks sensible. */
  eq(leaky.get('/jobs.html').views, 468,
    'two spellings of one page inside a source SUM rather than one winning');
  const weighted = A.mergePages(new Map(), [
    { path: '/jobs.html', views: 400, avgSec: 100 },
    { path: '/jobs', views: 100, avgSec: 50 },
  ]).get('/jobs.html');
  eq(weighted.avgSec, 90,
    '…and the average time is re-weighted by views, so a spelling with three ' +
    'visits does not drag the mean as hard as one with three hundred');

  /* ACROSS sources the rule is the opposite and must stay so: the first claim
     stands whole, because two sources measuring one page are two measurements
     of one number and adding them would double it. */
  const twoSources = A.mergePages(new Map(), [{ path: '/jobs.html', views: 400, avgSec: 10 }]);
  A.mergePages(twoSources, [{ path: '/jobs.html', views: 9999, avgSec: 1 }]);
  eq(twoSources.get('/jobs.html').views, 400,
    'but ACROSS sources the first claim stands — adding them would double the page');

  /* AND THE SERVED FILE ITSELF. The check that would have caught the leak. */
  for (const row of served.pages || []) {
    ok(A.isPublicPath(row.path),
      `data/analytics.json publishes only public paths — found ${row.path}`);
    eq(row.path, A.normPath(row.path),
      `…each already normalised, so one page is one row — ${row.path}`);
  }
  const paths = (served.pages || []).map((r) => r.path);
  eq(paths.length, new Set(paths).size, 'and no path is listed twice');

  /* the page defends itself too, for a file cached before this shipped */
  ok(/isPublicPath/.test(page),
    'the page filters as a second line — the builder is the defence, but a ' +
    'reader may still hold a copy fetched before it shipped');
  ok(/var publicPages = \(data\.pages \|\| \[\]\)\.filter/.test(page),
    '…and filters BEFORE deciding the figure exists, or a cached file of only ' +
    'admin rows would draw a heading over an empty chart');

  /* ------------------------------------ the dimensions, and where each may come from

     Owner, 2026-08-29: several more plots, using Google Analytics. The day
     rows answer "how many, and when"; these answer "who, from where, on what,
     and at what hour" — and the rule that keeps them honest is the day rule
     again, one notch stricter. */

  const CH = require(path.join(HERE, '..', 'assets', 'oa-charts.js'));

  /* ONE SOURCE OWNS A DIMENSION, WHOLE. Two analytics systems counting the
     same Tuesday at least agree about what a Tuesday is; two systems counting
     "visits from Germany" disagree about the boundary of a session, the
     meaning of a country and the clock an hour is read on, so an assembled
     answer measures nothing. */
  const dims = {};
  ok(A.mergeBreakdown(dims, 'countries',
    A.breakdown('countries', { source: 'ga4', items: [{ name: 'Ireland', value: 3 }] })),
    'a dimension record is taken from the source that answered for it');
  ok(!A.mergeBreakdown(dims, 'countries',
    A.breakdown('countries', { source: 'usage', items: [{ name: 'Nowhere', value: 999 }] })),
    '…and a second claim on it is refused — never merged, never summed, and ' +
    'never preferred for being larger');
  eq(dims.countries.items[0].name, 'Ireland', '…the first claim standing whole');

  ok(A.breakdown('whatever', { source: 'ga4', items: [{ name: 'x', value: 1 }] }) === null,
    'a dimension nobody declared is never built — this file is world-readable, ' +
    'and "whatever a source sent" is not a shape anybody has checked');
  ok(A.breakdown('countries', { source: 'ga4', items: [] }) === null,
    'and a record with nothing in it is null rather than an empty chart');

  /* A SHARE IS A SHARE OF THE WHOLE. `total` is summed before the cut, so the
     leader of a top-ten is not reported as a proportion of the ten that fitted
     — the classic way such a chart comes to overstate its leader. */
  const cut = A.breakdown('countries', {
    source: 'ga4', limit: 2,
    items: [{ name: 'United States', value: 400 }, { name: 'Ireland', value: 120 },
      { name: 'Germany', value: 90 }, { name: 'Singapore', value: 390 }],
  });
  eq(cut.total, 1000, 'the total counts every row the source returned, not the ones shown');
  eq(cut.items.length, 2, '…while only the top rows are served');
  eq(Math.round(A.withShare(cut)[0].share * 100), 40,
    '…so the leader reads 40%, not the 51% it would be over the visible rows');

  /* hours are a CLOCK; everything else is a ranking */
  const hb = A.hourBuckets();
  hb[9].value = 12; hb[3].value = 40;
  const hrs = A.breakdown('hours', { source: 'usage', items: hb, limit: 24 });
  eq(hrs.items.map((h) => h.name).slice(0, 3), ['00', '01', '02'],
    'the hours stay in clock order — ranking them would make the chart unreadable');
  eq(hrs.items[9].value, 12, '…each bucket where it belongs');

  /* the labels come out of somebody else's traffic, and land in a public file */
  eq(A.cleanLabel('  Hong  Kong\n'), 'Hong Kong', 'a label is tidied before it is served');
  eq(A.cleanLabel('mail@example.com'), '',
    'and one shaped like an address is dropped WHOLE — nothing under data/ may ' +
    'carry one, and a truncated address is still an address');
  eq(A.cleanLabel('x'.repeat(200)).length, 60, 'a label is capped');
  eq(A.prettyLabel('(direct)'), 'Typed or bookmarked',
    'Google\'s house style for "no referrer" is said in English');
  eq(A.prettyLabel('(not set)'), 'Not recorded',
    '…and "we could not tell" is not dressed up as a place');

  /* an address-shaped label contributes nothing to the total either, or the
     shares of everything else would be quietly wrong */
  const withBad = A.breakdown('referrers', {
    source: 'ga4', items: [{ name: 'google', value: 10 }, { name: 'a@b.com', value: 90 }],
  });
  eq(withBad.total, 10, 'a dropped label takes its count with it');

  /* --- seconds, said the way a person says them ------------------------- */

  /* Owner, 2026-08-29: "convert seconds to e.g. hours, minute, seconds if
     seconds is too long". 1,952 is the real figure the page was printing raw
     under its most-read pages. */
  eq(CH.duration(1952), '32m 32s', 'a long average is said in minutes and seconds');
  eq(CH.duration(45), '45s', 'and a short one is still said in seconds, which is its unit');
  eq(CH.duration(60), '1m', 'a round minute carries no trailing zero seconds');
  eq(CH.duration(3660), '1h 01m',
    'the smaller unit is zero-padded, so "1h 1m" cannot be misread as "1h 10m" ' +
    'and a column of these stays aligned');
  eq(CH.duration(7325), '2h 02m',
    'and seconds are dropped once hours are involved — carrying them would imply ' +
    'a precision an average session length does not have');
  eq(CH.duration(0), '0s', 'nothing is said as nothing, never as an empty string');
  eq(CH.durationLong(1952), '32 minutes 32 seconds', 'and spelled out where there is room');
  eq(CH.pct(0.4), '40%', 'a share is said as a percentage');
  eq(CH.pct(0.0004), '<0.1%',
    'and a category too small to round to a tenth is not reported as absent');

  ok(/C\.duration\(/.test(page),
    'the page says its times through that one formatter rather than printing ' +
    'raw seconds — the defect the owner reported');

  /* --- the axis cannot lie, and the marks are never stretched ------------ */

  const charts = await readFile(path.join(HERE, '..', 'assets', 'oa-charts.js'), 'utf8');
  const cssText = await readFile(path.join(HERE, '..', 'assets', 'oa-analytics.css'), 'utf8');
  ok(!/preserveAspectRatio: 'none'/.test(charts.replace(/\/\*[\s\S]*?\*\//g, '')),
    'no chart declares preserveAspectRatio none any more — that one attribute ' +
    'scaled a fixed 900-unit drawing NON-UNIFORMLY into whatever box it landed ' +
    'in (measured: scaleX 0.28 at a 320px viewport against scaleY 1.0), which ' +
    'is the stretch the owner reported');
  ok(/function plotWidth\(/.test(charts) && /plotWidth\(wrap\)/.test(charts),
    'the charts are DRAWN at the width they are shown at instead — one user ' +
    'unit is one CSS pixel');
  ok(/addEventListener\('resize'/.test(page) && /drawnAt/.test(page),
    'and the page redraws when the width changes, debounced, through the one ' +
    'draw() everything already goes through — no observer per chart to leak');

  eq(CH.compact(999999), '1M',
    'compact() rounds at the scale it displays — 999,999 used to fall through ' +
    'the megabyte gate and print "1000.0K"');
  eq(CH.compact(9990), '10K', '…and a decimal that rounds away is dropped, not printed as ".0"');
  eq(CH.compact(12914), '12.9K', '…while a decimal that means something is kept');
  ok(/function tickVal\(/.test(charts) && /tickVal\(\(top \/ 4\)/.test(charts) &&
     /tickVal\(\(top \/ 3\)/.test(charts),
    'both axes settle each tick VALUE first and draw the gridline AT it — a ' +
    'top of 2.5 used to draw lines at 0.83 and 1.67 labelled "1" and "2", and ' +
    'a top of 1 read 0, 0, 1, 1');
  ok(!/all\.reduce\(\(n, i\) => n \+ \(Number\(i\.value\) \|\| 0\), 0\)/.test(
    charts.slice(charts.indexOf('function bars('), charts.indexOf('function share('))),
    'bars() no longer invents a total by summing the rows it was handed — a ' +
    'share is offered only against a stated whole, so the most-visited-pages ' +
    'leader is never reported as a share of the 25 rows that fitted');
  ok(/Math\.max\(1\.5,/.test(charts) === false,
    'and the 1.5% bar-length floor is gone — a small row was drawn up to ' +
    'fifteen times its true length; visibility is a 2px CSS min-width now');
  ok(/min-width: 2px/.test(cssText), '…which the stylesheet carries');
  ok(/function unitFor\(/.test(charts),
    'a unit agrees with its number — "1 visit", never "1 visits"');
  eq(A.rollingMean([1, null, 3, 4], 2), [null, null, null, 3.5],
    'a rolling window with a hole in it has no mean — the page hands the ' +
    'daily chart calendar-continuous values with null where the record has a ' +
    'gap, and an average over five known days and two unknowns is not a ' +
    '7-day average');

  /* --- the numbers mean what their labels say ---------------------------- */

  ok(!/id: 'sessions'/.test(page),
    'the daily chart does not offer a "Visits" metric: the site\'s own record ' +
    'files one document per page opened, so for every day it owns the session ' +
    'count IS the pageview count, and a Visits line would be the Pageviews ' +
    'line wearing a wrong label');
  ok(/Time on a page/.test(page) && /eng\.source === 'usage'/.test(page),
    'the engagement tile says what its number is a length OF: the first-party ' +
    'record measures time on a PAGE (its pages-per-visit is identically 1 by ' +
    'construction), so only a source that can really measure a visit gets the ' +
    '"Typical visit" framing and the depth');
  ok(/counted per day/.test(page),
    'and the headline Visitors tile says it is counted per day — the served ' +
    'file has no cross-day identity, so a reader returning on ten days counts ' +
    'ten times and a bare "Visitors" would claim a distinct count nothing ' +
    'here can compute');
  ok(/withGaps/.test(page) && /dayShift/.test(page),
    'the ranges clip by DATE and the daily line breaks over a calendar gap ' +
    'instead of running straight through a collection outage as if it were ' +
    'one ordinary day');
  ok(/total: pagesTotal/.test(page) && /win\.views/.test(page),
    'the pages figure passes the window\'s WHOLE pageview count as the share ' +
    'denominator, from the file, and offers no share without it');
  ok(/Everything else/.test(charts),
    'a share bar\'s unlisted tail is a NAMED muted part, never an unexplained ' +
    'blank stretch of track — and never silently renormalised away');
  ok(/--oa-cat-rest/.test(cssText),
    '…painted from its own token, defined in both themes like the six real ones');
  /* READ WITH THE COMMENTS STRIPPED. The page still records WHAT it used to
     print and why that was wrong, and a guard that could not tell the
     explanation from the thing would have to be satisfied by deleting the
     explanation — the rule the no-iframe check above already had to learn. */
  ok(!/seconds on average/.test(page.replace(/\/\*[\s\S]*?\*\//g, '')),
    'and the sentence that printed them is gone from the page itself');
  ok(/seconds on average/.test(page),
    '…while the page still records what it used to say, so the check above can ' +
    'never be satisfied by deleting the explanation');

  /* --- the page and the model name the SAME dimensions ------------------ */

  /* Two lists of what this page draws would drift the first time one was added
     to, and the symptom would be a figure the file carries and the page never
     shows — invisible to everybody. So they are pinned against each other,
     both ways. */
  const drawn = [...page.matchAll(/^\s*id: '([a-z]+)', kind: '(\w+)',$/gm)].map((m) => m[1]);
  eq(drawn.slice().sort(), A.BREAKDOWN_IDS.slice().sort(),
    'every dimension the model may carry is drawn by the page, and every ' +
    'dimension the page draws is one the model may carry');
  /* THE "WHERE THESE FIGURES COME FROM" SECTION IS GONE, BY OWNER DECISION
     (2026-08-30): how the site is measured is not the readers' business. Read
     with the comments stripped, because the page deliberately still RECORDS
     what was removed and why — the guard must never be satisfiable by
     deleting the explanation. What that section also did is not lost: a
     figure with no source is still simply not drawn, which the second pin
     holds. */
  const pageLive = page.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/Where these figures come from/.test(pageLive) && !/renderProvenance/.test(pageLive),
    'the provenance section is removed — owner, 2026-08-30 — and only the ' +
    'comment recording the removal still names it');
  ok(/Where these figures come from/.test(page),
    '…while the page still records WHAT was removed and why, so the check ' +
    'above cannot be satisfied by deleting the explanation');
  ok(/if (!def || !rec || !rec.items || !rec.items.length) return;/.test(page) ||
     /!rec\.items\.length\) return;/.test(page),
    'and a dimension with no record still draws NOTHING — an empty axis is ' +
    'the shape of the defect this page is a rebuild of');

  /* --- each dimension is asked of the source that can answer it ---------- */

  const builder = await readFile(path.join(HERE, 'build-analytics.mjs'), 'utf8');
  for (const asked of ['country', 'deviceCategory', 'sessionDefaultChannelGroup', 'sessionSource']) {
    ok(new RegExp("dimension\\('" + asked + "'").test(builder),
      `the GA4 leg asks for ${asked} — the first-party record has no such field`);
  }
  ok(/hours: A\.breakdown\('hours'[\s\S]{0,400}source: 'usage'/.test(builder),
    'the HOURS come from the site\'s own record, which stamps the instant a ' +
    'session began');
  ok(!/dimension\('hour'/.test(builder),
    '…and are deliberately NOT also asked of GA4, which reports them on the ' +
    'property\'s own clock: one chart whose meaning changed time zone with its ' +
    'source would be worse than no chart');
  ok(/newVsReturning/.test(builder) && !/dimension\('newVsReturning'/.test(builder),
    'new-versus-returning is EXPLAINED as absent rather than silently missing: ' +
    'cookieless GA4 reports nearly every session as new, and the first-party ' +
    'record could only answer it with the unbounded read the incremental query ' +
    'is shaped to avoid');
  ok(/windowFrom/.test(builder) && /BREAKDOWN_DAYS/.test(builder),
    'the tallies are recomputed over a stated window every run — they cannot be ' +
    'accumulated across runs the way days can, or the overlap would be counted twice');

  /* --- what the served file may carry ------------------------------------ */

  for (const id of Object.keys(served.breakdowns || {})) {
    ok(A.BREAKDOWN_IDS.includes(id), `data/analytics.json carries only declared dimensions — ${id}`);
    const rec = served.breakdowns[id];
    ok(rec && Array.isArray(rec.items) && rec.total > 0, `…and ${id} is a complete record`);
    ok(rec.metric !== 'visitors',
      `${id} counts VISITS, never visitors: running cookieless, GA4 keeps no ` +
      'identifier on the device and cannot tell a returning reader from a new one');
    for (const it of rec.items) {
      eq(A.cleanLabel(it.name), it.name, `…each label already tidy — ${id}: ${it.name}`);
    }
  }
  ok(!served.engagement || served.engagement.avgSessionSec >= 0,
    'the engagement record is a set of scalars or absent, never a zero pretending ' +
    'to be a measurement');

  /* --- the categorical ramp ---------------------------------------------- */
  /* --- the colour that had to be re-stepped ------------------------------ */

  const css = await readFile(path.join(HERE, '..', 'assets', 'oa-analytics.css'), 'utf8');
  ok(/\[data-theme='dark'\][\s\S]*--oa-chart-accent/.test(css),
    'the dark theme re-steps the chart accent: --brand and --gold separate at ' +
    'delta-E 31.6 in light and collapse to 14.9 in dark, below the floor at which ' +
    'two overlaid lines can be told apart even with full colour vision');
  ok(!/#fff\b|#ffffff\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')),
    'and nothing in it paints a hardcoded white — anything that paints its own ' +
    'ground must name its own ink, in both themes');

  /* The share bars need a categorical ramp, and it is re-stepped in dark for
     exactly the reason the accent is: the light ramp on #15181d reads as six
     identical blocks. A token defined in only one theme is the "anything that
     paints its own ground must name its own ink" rule wearing a hat. */
  const darkBlock = (css.match(/\[data-theme='dark'\]\s*\{[\s\S]*?\}/) || [''])[0];
  for (let i = 1; i <= 6; i++) {
    ok(new RegExp('--oa-cat-' + i + ':').test(css),
      `the categorical ramp defines --oa-cat-${i}`);
    ok(new RegExp('--oa-cat-' + i + ':').test(darkBlock),
      `…and re-steps it for the dark surface — --oa-cat-${i}`);
  }
  ok(/oa-share-seg/.test(css) && /oa-bar-row:focus-visible/.test(css),
    'and the new marks carry their own hover and focus states: a figure that ' +
    'answers a pointer must answer a keyboard, and a focus nobody can see is ' +
    'not an answer');

  /* --- the setup guide names what is actually needed --------------------- */

  const setup = await readFile(path.join(HERE, '..', '_SETUP-ANALYTICS.md'), 'utf8');
  for (const needed of ['GA4_PROPERTY_ID', 'GA4_SERVICE_ACCOUNT', 'FIREBASE_SERVICE_ACCOUNT']) {
    ok(setup.includes(needed), `_SETUP-ANALYTICS.md names ${needed}`);
  }
  ok(/networkDomain/.test(setup),
    'and explains where the university figures used to come from');
  ok(/recordVisit/.test(setup) && /firebase deploy --only functions/.test(setup),
    '…and what has replaced it, including the one command that switches it on — ' +
    'a function nobody deployed looks exactly like a site nothing visits');

  /* --- the workflow ------------------------------------------------------ */

  const wf = await readFile(
    path.join(HERE, '..', '.github', 'workflows', 'oa-analytics.yml'), 'utf8');
  ok(/ref: \$\{\{ github\.ref_name \}\}/.test(wf),
    'the analytics workflow checks out the branch TIP, never github.sha — the ' +
    'stale-checkout trap this repository has now hit twice');
  ok(!/pull --rebase/.test(wf.replace(/#.*$/gm, '')),
    'and never rebases: data/ is a build output, so a rejected push is REBUILT');
  ok(/GA4_PROPERTY_ID/.test(wf) && /FIREBASE_SERVICE_ACCOUNT/.test(wf),
    'it passes every gated source its credential');
}

/* ------------------------------------------------------- the GA4 tag

   Added 2026-08-29 on the owner's instruction: GA4 yes, consent banner no.
   Those two are only compatible because the tag stores NOTHING on the
   visitor's device, so what is pinned here is mostly that pairing — a future
   edit that re-enables cookies without a banner would be a compliance
   problem no test elsewhere would notice. */
async function testGa4Tag() {
  const tag = await readFile(path.join(HERE, '..', 'assets', 'oa-ga4.js'), 'utf8');

  ok(/client_storage:\s*COOKIELESS\s*\?\s*'none'/.test(tag),
    'the tag can run cookieless at all');
  /* THE ID IS LIVE, and a tag that stops collecting reports nothing to
     anybody — the exact failure that let the old charts sit dead for three
     years. So the shape is pinned: blanking it, or mistyping it back to a
     placeholder, fails here rather than silently going quiet. */
  const mid = (tag.match(/var MEASUREMENT_ID = '([^']*)'/) || [])[1];
  ok(/^G-[A-Z0-9]{10}$/.test(mid || ''),
    'the Measurement ID is present and well-formed — an inert tag collects ' +
    'nothing and says so nowhere, which is how three years went by last time');

  ok(/var COOKIELESS = true;/.test(tag),
    'AND IT IS SWITCHED ON. This is what stands in for a consent banner: the ' +
    'ePrivacy rule is about storing things on a device, so storing nothing is ' +
    'what makes "GA4 without a banner" coherent. Flipping this to false ' +
    're-introduces the _ga cookie and with it the consent requirement.');
  ok(/allow_google_signals:\s*false/.test(tag) &&
     /allow_ad_personalization_signals:\s*false/.test(tag),
    'no advertising audiences or cross-device profiles are built from it');
  ok(/globalPrivacyControl/.test(tag) && /doNotTrack/.test(tag),
    'a visitor asking not to be tracked is not tracked — and gtag is never ' +
    'even fetched, rather than fetched and asked to behave');
  ok(/HOSTS\.indexOf\(location\.hostname\) === -1/.test(tag),
    'it only reports from the real site: page-test.mjs opens every page in a ' +
    'real browser, so without this guard every CI run would post hits to the ' +
    'live property, indistinguishable from real ones for ever');
  ok(/anonymize_ip/.test(tag) && !/anonymize_ip:/.test(tag),
    'anonymize_ip is EXPLAINED as a Universal Analytics parameter GA4 ignores, ' +
    'and deliberately not passed — carrying it would imply a choice not made');

  /* THE ORDER AND THE COOKIELESS FLAG ARE ONE DECISION. A browser storing
     nothing cannot recognise a returning visitor, so GA4's "users" is nearer
     "sessions" and must not own a day the first-party record also measured.
     Pinned together here so neither half can move alone. */
  const A = require(path.join(HERE, '..', 'assets', 'oa-analytics-model.js'));
  ok(A.SOURCE_ORDER.indexOf('usage') < A.SOURCE_ORDER.indexOf('ga4'),
    'while the tag is cookieless the first-party record outranks GA4');

  /* --- every real page carries it, and no redirect stub does --------------- */

  const root = path.join(HERE, '..');
  const pages = (await readdir(root)).filter((f) => f.endsWith('.html')).sort();
  const missing = [];
  const onStub = [];
  for (const f of pages) {
    const html = await readFile(path.join(root, f), 'utf8');
    const isStub = /http-equiv=["']?refresh/i.test(html);
    const tagged = html.includes('assets/oa-ga4.js');
    if (isStub && tagged) onStub.push(f);
    if (!isStub && !tagged) missing.push(f);
  }
  eq(missing, [],
    'every served page carries the tag — a page added without it measures ' +
    'nothing, and the only symptom is a gap in the figures nobody can see');
  eq(onStub, [],
    'and no redirect stub does: those meta-refresh to a fragment of the home ' +
    'page within a moment, so a hit there would double-count the page they go to');
  ok(pages.filter((f) => f !== 'index.html').length > 10 && missing.length === 0,
    'the sweep really walked the site rather than passing on an empty list');

  /* deferred, like every script on this site — the rule CLAUDE.md states as
     "adding a script tag means adding defer to it" */
  const idx = await readFile(path.join(root, 'index.html'), 'utf8');
  ok(/<script defer src="assets\/oa-ga4\.js"><\/script>/.test(idx),
    'the tag is deferred: nothing on screen waits for third-party JavaScript');

  /* --- the Privacy Policy says what actually happens ---------------------- */

  const pp = await readFile(path.join(root, 'privacy-policy.html'), 'utf8');
  ok(/Google Analytics 4/.test(pp),
    'the Privacy Policy names GA4 — it described Universal Analytics for the ' +
    'three years after that tag stopped existing');
  ok(/client_storage/.test(pp) && /no analytics cookie/i.test(pp),
    'and states that nothing is stored on the device, which is the reason no ' +
    'banner is shown — a policy silent on that is the one thing that would ' +
    'make the absence of a banner look like an oversight');
  ok(/Global Privacy Control/.test(pp),
    'and that a do-not-track signal is honoured');
  ok(/Google Signals|Google signals/.test(pp),
    'and that advertising features are off');
}

/* ------------------------------------------ which universities are visiting

   THE CLAIM THIS CORRECTS. The old "which universities visited" charts came
   from Universal Analytics' `networkDomain` — a reverse-DNS lookup of the
   visitor's address. GA4 has no such dimension, and from that it was
   concluded here, written into four files and told to the owner, that the
   figures could never be shown again. The owner said otherwise, and was
   right: what is true is that a BROWSER cannot see its own reverse-DNS, and
   nothing said the browser had to. A server can, this site has Cloud
   Functions, so the site now does for itself what UA used to do for it.

   The privacy shape is where the care goes, so most of what is pinned here
   is about what must NOT happen: the address is never stored, an ISP is never
   counted, a stranger's page cannot ring the endpoint, and the admin desk
   feeds none of it. */
async function testUniversityVisits() {
  const root = path.join(HERE, '..');
  const N = require(path.join(root, 'assets', 'oa-netorg.js'));
  const MAP = JSON.parse(await readFile(path.join(root, 'data', 'university-domains.json'), 'utf8'));

  /* --- the registrable domain, which is what everything else keys on ----- */

  eq(N.registrableDomain('www.sbs.ox.ac.uk'), 'ox.ac.uk',
    'a multi-part academic suffix leaves the UNIVERSITY as the domain — without ' +
    'the suffix list every British university would collapse into one entry');
  eq(N.registrableDomain('MIT.EDU'), 'mit.edu', 'the answer is case-insensitive');
  eq(N.registrableDomain('host.nus.edu.sg.'), 'nus.edu.sg', "a PTR record's trailing dot is not a label");
  eq(N.registrableDomain('ac.uk'), '', 'the bare suffix is nobody');
  eq(N.registrableDomain('1.2.3.4'), '', 'an address is not a name');
  eq(N.registrableDomain('evil.com/path'), '', 'and neither is anything with a path in it');

  /* --- classification: three answers, and the third is the important one -- */

  const fixture = { 'ox.ac.uk': 'University of Oxford', 'mit.edu': 'Massachusetts Institute of Technology' };
  eq(N.classify('gateway.sbs.ox.ac.uk', fixture).university, 'University of Oxford',
    'a subdomain of a known university resolves to it');
  ok(!N.classify('notmit.edu', fixture).university,
    'A SUBDOMAIN NEVER MATCHES A DIFFERENT UNIVERSITY: the lookup is on the ' +
    'registrable domain alone, so no suffix or substring search can let ' +
    '"notmit.edu" be counted as MIT');
  eq(N.classify('notmit.edu', fixture).academic, true,
    '…it is an academic network this site has no page for, which is a different ' +
    'fact from "not a university" and is counted apart');
  eq(N.classify('dsl-12.telecom.example.com', fixture), null,
    'AN ISP IS NEVER COUNTED. "one visit from BT Broadband" narrows a person far ' +
    'harder than "one visit from Oxford", and it answers no question this chart asks');
  eq(N.classify('', fixture), null, 'a host that never resolved is counted as nothing');
  eq(N.classify('www.academia.edu', fixture), null,
    'academia.edu ends in .edu and is a company — the case that makes the ' +
    'denylist necessary rather than tidy');

  /* --- the address, and the entry a spoof cannot forge ------------------- */

  eq(N.clientIp('203.0.113.7'), '203.0.113.7', 'a single address is read straight');
  eq(N.clientIp('1.2.3.4, 203.0.113.7'), '203.0.113.7',
    'THE LAST routable entry, not the first: Cloud Run APPENDS the address it ' +
    'saw to whatever the client sent, so reading from the left would take ' +
    'whatever a visitor wrote in their own X-Forwarded-For');
  eq(N.clientIp('203.0.113.7, 10.0.0.1'), '203.0.113.7',
    'the private hop between is skipped rather than taken as the visitor');
  eq(N.clientIp('  198.51.100.9:4433 '), '198.51.100.9', 'a port is not part of the address');
  eq(N.clientIp('[2001:db8::1]:443'), '2001:db8::1', 'and a bracketed IPv6 port is stripped correctly');
  eq(N.clientIp('2001:db8::1'), '2001:db8::1',
    'while an unbracketed IPv6 address keeps every one of its colons');
  eq(N.clientIp(''), '', 'no header, no address');
  eq(N.clientIp('127.0.0.1, ::1'), '', 'and a request that only ever saw loopback yields nothing');
  for (const priv of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', 'fd00::1', 'fe80::1']) {
    ok(!N.isPublicIp(priv), `${priv} is not a routable visitor address`);
  }
  ok(N.isPublicIp('8.8.8.8') && N.isPublicIp('2001:db8::1'), 'a routable address is');

  /* --- the map is DERIVED, and says no when it cannot tell --------------- */

  const dir = JSON.parse(await readFile(path.join(root, 'data', 'directory.json'), 'utf8'));
  const { map, dropped } = NETMAP.buildMap(dir);
  eq(JSON.stringify(map), JSON.stringify(MAP),
    'data/university-domains.json is exactly what the committed directory derives — ' +
    'hand-editing it would be undone by the next build, the rule every generated ' +
    'file here is held to');
  ok(Object.keys(MAP).length > 100,
    `the map covers the directory (${Object.keys(MAP).length} domains)`);
  eq(dropped.filter((d) => d.claimed.length < 2), [],
    'a domain is only ever dropped for being CLAIMED TWICE');
  const denied = Object.keys(MAP).filter((d) => N.isDenied(d));
  eq(denied, [],
    'no hosted CMS, shortener or social profile became a university domain: a ' +
    'department page on wordpress.com is not the university\'s network');
  /* the denylist direction was measured — an academic-suffix ALLOWLIST
     dropped 28 real universities, which is the quieter and worse failure */
  ok(Object.keys(MAP).some((d) => !N.looksAcademic(d)),
    'universities on plain national domains (ethz.ch, mcgill.ca, sdabocconi.it) are ' +
    'KEPT — outside the English-speaking world that is the normal shape');

  /* --- the vendored copies, which are what the deployed function reads --- */

  for (const [src, vendored] of [
    ['assets/oa-netorg.js', '_functions/netorg.js'],
    ['data/university-domains.json', '_functions/university-domains.json'],
  ]) {
    eq(await readFile(path.join(root, vendored), 'utf8'),
      await readFile(path.join(root, src), 'utf8'),
      `${vendored} is byte-identical to ${src} — \`firebase deploy\` ships only ` +
      '_functions, so a drifted copy would resolve visitors against a stale map ' +
      'in production with nothing anywhere saying so');
  }

  /* --- the function: what it must never do ------------------------------- */

  const fn = await readFile(path.join(root, '_functions', 'index.js'), 'utf8');
  const body = fn.slice(fn.indexOf('exports.recordVisit'));
  ok(body.length > 500, 'the recordVisit handler was really found (or the checks below are vacuous)');

  ok(/const patch = \{ day, t: Date\.now\(\), seen: inc \}/.test(body),
    'the document is COUNTERS ONLY — a day, a stamp and tallies');
  /* A SLICE TAKEN ON A MARKER THAT MOVED PASSES BY VACUITY, and `indexOf`
     returning -1 would make `slice(-1)` the file's LAST CHARACTER — a check
     of nothing that reports green. So the marker is asserted before it is
     used, the rule this file already carries for every other source slice. */
  const patchAt = body.indexOf('const patch = {');
  ok(patchAt > 0, 'the counters block was found (or the address check below is vacuous)');
  const afterPatch = body.slice(patchAt);
  ok(afterPatch.length > 200 && !/\bip\b/.test(afterPatch),
    'THE ADDRESS IS NEVER WRITTEN. It is resolved in memory and goes out of ' +
    'scope; nothing below the lookup so much as names it');
  ok(!/logger\.(info|log)\([^)]*ip/.test(body),
    '…and it is never logged either, which would be the same disclosure by ' +
    'another route');
  ok(/patch\.unis = \{ \[hit\.university\]: inc \}/.test(body),
    'the tally is a NESTED MAP, never a dotted field path: this site\'s own ' +
    'directory carries names with full stops in them ("St. John\'s University"), ' +
    'and a dotted path would be read as three fields');
  ok(/if \(!VISIT_ORIGINS\.includes\(origin\)\) return done\(\)/.test(body),
    'only this site\'s own pages may ring it');
  ok(/sec-gpc.*dnt|dnt.*sec-gpc/s.test(body),
    'a Global Privacy Control or Do Not Track header is honoured SERVER-SIDE too — ' +
    'a signal a server trusts the client to have obeyed is not being honoured');
  ok(/res\.status\(204\)/.test(body) && !/res\.json\(/.test(body),
    'and it answers 204 whatever happened: a reply that varied would turn a ' +
    'private server-side lookup into one any page could perform');

  const pkg = JSON.parse(await readFile(path.join(root, '_functions', 'package.json'), 'utf8'));
  ok(pkg.dependencies && pkg.dependencies['firebase-admin'],
    'the functions declare firebase-admin — without it the deploy fails at runtime');

  /* --- the rules: no client, in either direction ------------------------- */

  const rules = await readFile(path.join(root, '_firestore.rules'), 'utf8');
  ok(/match \/universityVisits\/\{day\} \{\s*allow read, write: if false;/.test(rules),
    'universityVisits is closed to every client: a counter a browser could ' +
    'increment is a published chart a browser could write');

  /* --- the ping: on every public page, and structurally not on the desk -- */

  const ping = await readFile(path.join(root, 'assets', 'oa-visit.js'), 'utf8');
  ok(/sessionStorage/.test(ping) && /oaVisitPinged/.test(ping),
    'ONCE PER SESSION, not once per page — the chart counts visits, and a ' +
    'reader who opens six postings made one visit');
  ok(/HOSTS\.indexOf\(location\.hostname\) === -1\) return/.test(ping),
    'and only from the live site: page-test.mjs opens every page in a real ' +
    'browser on every CI run, and each of those would otherwise file a visit');
  ok(/globalPrivacyControl/.test(ping) && /doNotTrack/.test(ping),
    'a refusal to be measured is honoured by NOT ASKING');
  ok(/credentials: 'omit'/.test(ping),
    'no cookies in either direction, matching the cookieless posture of the tag beside it');
  ok(!/body:/.test(ping),
    'and it sends NOTHING — no identifier, no path, no body. The whole of the ' +
    'request is that it happened');

  const pages = (await readdir(root)).filter((f) => f.endsWith('.html')).sort();
  const missing = [];
  const shouldNot = [];
  for (const f of pages) {
    const html = await readFile(path.join(root, f), 'utf8');
    const stub = /http-equiv=["']?refresh/i.test(html);
    const has = html.includes('assets/oa-visit.js');
    /* THE ADMIN DESK IS EXCLUDED STRUCTURALLY (owner, 2026-08-29: no admin
       page feeds the public figures). A page that never runs the ping cannot
       be filtered wrongly by a rule that drifts — which is a stronger
       guarantee than the path predicate the pages list is filtered by, and
       needs no second copy of that predicate in the browser. */
    if ((stub || f === 'admin-area.html') && has) shouldNot.push(f);
    if (!stub && f !== 'admin-area.html' && !has) missing.push(f);
  }
  eq(missing, [], 'every public page carries the visit ping');
  eq(shouldNot, [],
    'and neither the admin desk nor any redirect stub does — the exclusion is ' +
    'the absence of a script tag, not a runtime check that could drift');
  ok(pages.length > 20 && !missing.length,
    'the sweep really walked the site rather than passing on an empty list');
  const idx = await readFile(path.join(root, 'index.html'), 'utf8');
  ok(/<script defer src="assets\/oa-visit\.js"><\/script>/.test(idx),
    'it is deferred like every script here');

  /* --- and the false claim is gone from everything a person reads -------- */

  /* PRESENT-TENSE ONLY, and that is the point rather than a loosening. Each
     of these files now RECOUNTS the wrong conclusion in order to correct it —
     "it was concluded that they could never be shown again" — and a guard
     that could not tell the explanation from the claim could only be
     satisfied by deleting the explanation, which is a trap this repository
     has already walked into once (the analytics page's "no iframes" check).
     So what is forbidden is a file still ASSERTING it. */
  const CLAIM = /\b(can never|cannot|will never|could not ever) be (brought up to date|shown again|revived|measured)|no analytics product has replaced|gone for good/i;
  for (const f of ['assets/oa-analytics.js', 'assets/oa-analytics-model.js',
    '_scraper/build-analytics.mjs', '_SETUP-ANALYTICS.md', 'changelog.json']) {
    const t = await readFile(path.join(root, f), 'utf8');
    ok(!CLAIM.test(t),
      `${f} no longer says the university figures can never come back — they can, ` +
      'and saying otherwise is what nearly kept them from being rebuilt');
  }

  /* --- NO FIGURE'S CAPTION NAMES ANOTHER FIGURE -------------------------
     Two optional figures cannot promise each other. "Where readers are" comes
     from a GA4 breakdown and "Which universities visited" from the site's own
     resolver, and they are drawn on INDEPENDENT conditions — so a caption that
     cross-referenced the other one produced, on the live shape of the data
     (GA4 configured, the Cloud Functions not yet deployed), a page saying "see
     the figure below" directly above its own note listing that figure under
     "Not on this page yet". Measured in a browser, then removed. */
  const pagejsRaw = await readFile(path.join(root, 'assets', 'oa-analytics.js'), 'utf8');
  /* READ WITH THE COMMENTS STRIPPED. Both blocks below now EXPLAIN the defect
     they no longer have, and a guard that cannot tell the explanation from the
     thing can only be satisfied by deleting the explanation — the trap this
     repository already records for the analytics page's "no iframes" check,
     walked into twice on the very checks that removed these two. */
  const pagejs = pagejsRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  const dimBlock = pagejs.slice(pagejs.indexOf('var DIMENSIONS = ['),
    pagejs.indexOf('var state = {'));
  ok(dimBlock.length > 500, 'the DIMENSIONS table was found (or the check below is vacuous)');
  ok(!/Which universities visited/.test(dimBlock),
    'no DIMENSION caption names the universities figure — the two are drawn on ' +
    'independent conditions, so a cross-reference is a promise the page cannot keep');
  const uniFn = pagejs.slice(pagejs.indexOf('function renderUniversities'));
  ok(uniFn.length > 500, 'renderUniversities was found');
  /* Bounded on CODE, never on a comment: `pagejs` above is read with comments
     STRIPPED, so a comment marker cannot be found in it at all and the slice
     would silently run to the end of the file and pass by accident.
     renderUniversities became the last function on the page when the
     provenance note was removed, so the fetch that boots it is the boundary. */
  const uniEnd = uniFn.indexOf("fetch('data/analytics.json'");
  ok(uniEnd > 400, 'the universities renderer was bounded (or the checks below are vacuous)');
  const uniBody = uniFn.slice(0, uniEnd);
  for (const other of ['Where readers are', 'How readers arrive', 'What they read it on']) {
    ok(!uniBody.includes(other),
      `…and the universities caption names no other figure either (${other})`);
  }

  /* --- AND THE TILE STRIP STAYS AT FIVE ----------------------------------
     A sixth tile lands alone on a second row at 1400px, 1180px and 1024px —
     which is why the length and the depth of a visit were folded into one.
     "Universities seen" was the sixth the moment that tile arrived, so the
     count moved into the universities figure's own caption. */
  const tiles = pagejs.slice(pagejs.indexOf('function renderTiles'),
    pagejs.indexOf('/* ---------------------------------------------------------------- figures'));
  ok(tiles.length > 500, 'renderTiles was found (or the count below is vacuous)');
  const tileCalls = (tiles.match(/html \+= tile\(/g) || []).length;
  ok(tileCalls <= 5,
    `the headline strip draws at most five tiles (found ${tileCalls}) — a sixth ` +
    'orphans onto a row of its own at every width the page is read at');
  ok(!/Universities seen/.test(tiles),
    '…and the universities count is not one of them: it is a fact about ONE ' +
    'figure rather than a headline about the corpus, and its caption carries it');
  ok(/universit/i.test(uniBody) && /u\.all\.length/.test(uniBody),
    '…which the caption really does — the count is not simply lost');

  /* --- the Privacy Policy discloses what is derived from an address ------- */

  const pp = await readFile(path.join(root, 'privacy-policy.html'), 'utf8');
  ok(/reverse|network/i.test(pp) && /universit/i.test(pp),
    'the Privacy Policy says the visitor\'s network is turned into a university name');
  ok(/not stored|never stored|not kept|never kept/i.test(pp),
    '…and that the address itself is not kept — a site that derives something ' +
    'from an IP and says so nowhere is wrong whatever its rules allow');
}

if (isMain(import.meta.url)) {
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
  await testJobNavModule();
  await testYearCheckDecisions();
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
  await testMarketYearCascade();
  await testFormMarketYearParity();
  await testCountries();
  await testSchools();
  await testSubmissionKeyCeilings();
  testJobMarketSheetParsing();
  testJobMarketSheetColumns();
  testJobMarketSheetRows();
  testJobMarketSheetCarry();
  testJobMarketSheetAddedAt();
  testJobMarketSheetMislabelledHeader();
  testJobMarketSheetTabCycle();
  testJobMarketSheetStaleness();
  await testJobMarketSheetChain();
  await testDeployGuard();
  await testRulesDeploy();
  await testUserDirectorySync();
  await testDirectoryModel();
  await testDirectoryWiring();
  await testUniInfo();
  await testMandatoryPostingFields();
  await testRowOverrides();
  await testNewsReview();
  await testNameFixes();
  await testAdminArea();
  await testUsersAndMessages();
  await testRemovalSafety();
  await testMirrorLifecycle();
  await testRefLessTakedown();
  await testSheetMirrors();
  await testJobMarketSheetWiring();
  testHigherEdJobsParsing();
  testHigherEdJobsApply();
  await testHigherEdJobsWiring();
  testAdvertsParsing();
  testAdvertsPlace();
  testAdvertsApply();
  await testAdvertsWiring();
  await testCliMainGuards();
  await testFreshEcho();
  await testGuardRepairs();
  testReviewQueue();
  testReviewDuplicates();
  testReviewBusiness();
  testReviewEdits();
  await testReviewWiring();
  testTwoDeadlines();
  await testTwoDeadlinesWiring();
  await testSubmissionNotices();
  await testPostedByAndLiveEmail();
  await testCandidateProfilePolicy();
  await testJobExport();
  await testJobExportWiring();
  await testSponsors();
  await testReaderGate();
  await testAnalytics();
  await testGa4Tag();
  await testUniversityVisits();
  process.exit(finish() ? 0 : 1);
}
