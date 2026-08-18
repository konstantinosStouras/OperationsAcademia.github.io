#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — check each HigherEdJobs posting against its own ad.

       data/jobmarket.json  ->  THIS  ->  data/higheredjobs.json
             (the tracking sheet's postings)      (what each ad says)
                       |                                  |
                       +----------- applyVerified --------+
                                          |
                       data/jobmarket.json + data/jobs.json

   WHY. Most of the tracking sheet's postings link to higheredjobs.com and the
   sheet has no deadline for them, so they reach the site as "Until filled." —
   which is the sheet ingest's default for an empty cell, not a fact anyone
   checked (see the note on applyBy in jobmarket-sheet.mjs). The advertisement
   states the deadline in a field of its own. This reads it.

   WHAT IT WILL NOT DO. It never overwrites a deadline the maintainer typed
   into the sheet: a disagreement is reported so the SHEET can be corrected,
   which fixes it at the source. It never removes a posting, never edits how
   one is described, and an advertisement it cannot read changes nothing at
   all. See applyVerified in higheredjobs.mjs for the rules.

   Modes:
     --scan          list what would be fetched, fetch nothing, write nothing
     --dry-run       fetch and parse, print the diff, write nothing
     --apply-only    write nothing but re-apply the committed cache (the
                     push-retry replay, and the way to re-apply after a
                     hand-edit of the cache)
     --force         ignore the freshness rule and re-read every ad
     --limit <n>     read at most n ads this run (default 60)
     --ttl <days>    re-read an ad this many days after the last read (7)
     --selftest      offline checks, no network

   NOTE. This build environment's egress policy denies higheredjobs.com (403
   at the proxy), so a real read only happens on the GitHub Actions runners —
   the same situation as docs.google.com in sync-jobmarket-sheet.mjs. Run it
   with --apply-only or --selftest locally.
   --------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isoStamp, longDate } from './jobs-model.mjs';
import { SOURCE as SHEET_SOURCE } from './jobmarket-sheet.mjs';
import {
  parseAd, cacheEntry, emptyCache, needFetch, applyVerified,
  jobCodeOf, detailsUrl, isHigherEdJobsUrl, hejDate, labelledFields, deadlineOf,
} from './higheredjobs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const SHEET_FILE = path.join(DATA, 'jobmarket.json');
const JOBS_FILE = path.join(DATA, 'jobs.json');
const CACHE_FILE = path.join(DATA, 'higheredjobs.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const SCAN = has('--scan');
const DRY = has('--dry-run');
const APPLY_ONLY = has('--apply-only');
const FORCE = has('--force');
const LIMIT = Math.max(1, Number(opt('--limit', '60')) || 60);
const TTL_DAYS = Math.max(0, Number(opt('--ttl', '7')) || 7);

/** Between requests. HigherEdJobs is a small publisher being read on someone
    else's behalf; a handful of pages a day at human pace costs them nothing.
    A run reads at most LIMIT of them, so the whole thing is bounded. */
const PACE_MS = 1500;

const UA = 'operationsacademia.org posting check (+https://www.operationsacademia.org)';

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));
const err = (...a) => console.log('::error::' + a.join(' '));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- network */

/** One GET, with a timeout and two retries. A failure returns rather than
    throws: this whole pass is an enrichment and must never be the reason a
    scheduled run fails. */
async function fetchAd(url, { tries = 3, timeoutMs = 30000 } = {}) {
  let last = '';
  for (let i = 1; i <= tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow', signal: ctl.signal,
        headers: { 'user-agent': UA, accept: 'text/html' },
      });
      const body = await res.text();
      if (res.ok) return { ok: true, body };
      last = `HTTP ${res.status}`;
      // a listing that is gone answers 404 and will never succeed
      if (res.status === 404 || res.status === 410) return { ok: false, gone: true, error: last };
    } catch (e) {
      last = e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message;
    } finally {
      clearTimeout(timer);
    }
    if (i < tries) await sleep(1500 * i);
  }
  return { ok: false, error: last || 'unknown error' };
}

/* -------------------------------------------------------------------- io */

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    warn(`${path.basename(file)} could not be parsed (${e.message}) — treating it as empty`);
    return fallback;
  }
}

async function readCache() {
  const c = await readJson(CACHE_FILE, null);
  return (c && c.ads && typeof c.ads === 'object') ? c : emptyCache();
}

/** The cache, written with its keys in a stable order so an unchanged run
    produces a byte-identical file and commits nothing. */
function serialiseCache(cache) {
  const ads = {};
  for (const code of Object.keys(cache.ads).sort()) ads[code] = cache.ads[code];
  return JSON.stringify({ generated: cache.generated, ads }, null, 1) + '\n';
}

/* ------------------------------------------------------------------- main */

async function main() {
  const now = new Date();
  const today = isoStamp(now).slice(0, 10);

  const sheetRows = await readJson(SHEET_FILE, []);
  if (!Array.isArray(sheetRows) || !sheetRows.length) {
    log('data/jobmarket.json holds no postings — nothing to check.');
    return 0;
  }

  const cache = await readCache();
  const linked = sheetRows.filter((r) => isHigherEdJobsUrl(r.adUrl));
  log(`${sheetRows.length} posting(s) from the tracking sheet, ` +
      `${linked.length} of them advertised on HigherEdJobs.`);

  /* ------------------------------------------------------------ the fetch */

  let read = 0, failed = 0;

  if (APPLY_ONLY) {
    log('--apply-only: re-applying the committed cache, fetching nothing.');
  } else {
    const queue = needFetch(sheetRows, cache, { today, ttlDays: TTL_DAYS, force: FORCE });
    const slice = queue.slice(0, LIMIT);

    if (queue.length > slice.length) {
      log(`${queue.length} advertisement(s) to read; taking the newest ${slice.length} ` +
          'this run — the rest are read by the next one.');
    } else {
      log(`${slice.length} advertisement(s) to read` +
          (linked.length - slice.length > 0
            ? ` (${linked.length - slice.length} already known and still fresh)` : '') + '.');
    }

    if (SCAN) {
      for (const q of slice) {
        log(`  ${q.jobCode}  ${q.row.institution}${q.row.department ? ' — ' + q.row.department : ''}`);
        log(`      ${detailsUrl(q.jobCode)}`);
      }
      log('--scan: fetched nothing, wrote nothing.');
      return 0;
    }

    for (const q of slice) {
      const url = detailsUrl(q.jobCode);
      const res = await fetchAd(url);

      if (!res.ok && !res.gone) {
        /* Left exactly as it was, deliberately: a network failure is not
           evidence that the advertisement changed, and stamping it would
           silence the retry for a week. */
        failed++;
        warn(`${q.jobCode}: ${res.error} — left as it was`);
        await sleep(PACE_MS);
        continue;
      }

      const parsed = res.gone
        ? { ...parseAd(''), gone: true, jobCode: q.jobCode }
        : parseAd(res.body, { jobCode: q.jobCode });

      if (!parsed.ok && !parsed.gone) {
        failed++;
        warn(`${q.jobCode}: the page was fetched but could not be read — ` +
             'the layout may have changed. Left as it was.');
        await sleep(PACE_MS);
        continue;
      }

      cache.ads[q.jobCode] = cacheEntry(parsed, {
        jobCode: q.jobCode, url, checkedAt: isoStamp(now),
        // what was known before, so a listing that has come down keeps the
        // closing date it stated while it was up
        previous: q.had, via: 'page',
      });
      read++;

      log(`  ${q.jobCode}  ${parsed.gone ? '(no longer listed)'
        : `${parsed.institution} — ${parsed.applyByDate
            ? `due ${parsed.applyByDate}` : 'no closing date stated'}`}`);

      await sleep(PACE_MS);
    }

    /* Stamped only when something was actually read. A run where every fetch
       failed knows nothing new, and bumping the date would rewrite the file —
       committing, and redeploying the site, to say so. */
    if (read) cache.generated = isoStamp(now);
    if (failed) log(`${failed} advertisement(s) could not be read this run.`);
  }

  /* ----------------------------------------------------------- the apply */

  const applied = applyVerified(sheetRows, cache, { today });

  for (const c of applied.changed) {
    log(`  ${c.id}: "${c.from}" -> "${c.to}"${c.past ? '  (that deadline has passed)' : ''}`);
  }
  for (const c of applied.conflicts) {
    warn(`${c.id}: the sheet says ${c.sheet}, the advertisement says ${c.ad} — ` +
         'the sheet wins. Correct the sheet if the advertisement is right.');
  }

  const sheetBefore = JSON.stringify(sheetRows, null, 1) + '\n';
  const sheetAfter = JSON.stringify(applied.rows, null, 1) + '\n';

  /* data/jobs.json carries the sheet's postings verbatim (build-jobs.mjs
     concatenates them), so the corrected rows are put back by id. Only rows
     the sheet owns are touched: a posting from the database belongs to whoever
     submitted it, and the next build would overwrite an edit here anyway. */
  const jobs = await readJson(JOBS_FILE, []);
  const byId = new Map(applied.rows.map((r) => [r.id, r]));
  const jobsNext = Array.isArray(jobs)
    ? jobs.map((r) => (r && r.source === SHEET_SOURCE && byId.has(r.id)) ? byId.get(r.id) : r)
    : jobs;
  const jobsBefore = JSON.stringify(jobs, null, 1) + '\n';
  const jobsAfter = JSON.stringify(jobsNext, null, 1) + '\n';

  const cacheBefore = existsSync(CACHE_FILE) ? await readFile(CACHE_FILE, 'utf8') : '';
  const cacheAfter = serialiseCache(cache);

  const changes = [
    cacheBefore !== cacheAfter ? 'data/higheredjobs.json' : '',
    sheetBefore !== sheetAfter ? 'data/jobmarket.json' : '',
    jobsBefore !== jobsAfter ? 'data/jobs.json' : '',
  ].filter(Boolean);

  if (!changes.length) {
    log('nothing changed — writing nothing.');
    return 0;
  }

  if (DRY) {
    log(`--dry-run: would have written ${changes.join(', ')}.`);
    return 0;
  }

  if (cacheBefore !== cacheAfter) await writeFile(CACHE_FILE, cacheAfter);
  if (sheetBefore !== sheetAfter) await writeFile(SHEET_FILE, sheetAfter);
  if (jobsBefore !== jobsAfter) await writeFile(JOBS_FILE, jobsAfter);
  log(`wrote ${changes.join(', ')}` +
      ` (${read} advertisement(s) read, ${applied.changed.length} deadline(s) corrected).`);
  return 0;
}

/* --------------------------------------------------------------- selftest */

/* The offline half. The parser's own checks live in selftest.mjs beside every
   other model check; these are the few that belong to this file: that its
   flags parse, and that the round trip through the cache is stable. */
function selftest() {
  let pass = 0; const fails = [];
  const ok = (c, what) => { if (c) pass++; else fails.push(what); };

  const HTML = `<h1 id="jobtitle-header">Lecturer, Operations</h1>
    <div class="job-inst"><a href="#">Example University</a></div>
    <div class="job-loc"><span class="at">in</span> Orem, UT</div>
    <div class="job-info"><strong>Type:</strong> Full-Time <br>
      <strong>Posted:</strong> 2 days ago <br>
      <strong>Application Due:</strong> 08/20/2026 <br></div>`;

  const p = parseAd(HTML, { jobCode: '1234567' });
  ok(p.ok, 'a page with a title and an employer parses');
  ok(p.applyByDate === '2026-08-20', 'and states its deadline as an ISO date');

  const entry = cacheEntry(p, { jobCode: '1234567', checkedAt: '2026-08-18T00:00:00Z' });
  const cache = { generated: '', ads: { 1234567: entry } };
  const rows = [{
    id: 'x', adUrl: detailsUrl('1234567'), applyBy: 'Until filled.', applyByDate: '',
  }];

  const once = applyVerified(rows, cache, { today: '2026-08-18' });
  ok(once.rows[0].applyByDate === '2026-08-20', 'an open-ended posting takes the ad\'s deadline');
  ok(once.rows[0].applyBy === longDate('2026-08-20'), 'and shows it the way the site writes dates');
  const twice = applyVerified(once.rows, cache, { today: '2026-08-18' });
  ok(JSON.stringify(twice.rows) === JSON.stringify(once.rows), 're-applying changes nothing');
  ok(twice.changed.length === 0, 'and reports no second correction');

  ok(serialiseCache(cache) === serialiseCache(JSON.parse(serialiseCache(cache))),
    'the cache round-trips byte-identically');

  const frozen = needFetch(rows.map((r) => ({ ...r, posted: '2026-08-15' })),
    { ads: { 1234567: { ...entry, applyByDate: '2026-08-01' } } },
    { today: '2026-08-18', ttlDays: 7 });
  ok(frozen.length === 0, 'an advertisement whose deadline has passed is not read again');

  console.log(fails.length
    ? `higheredjobs-verify selftest: ${pass} passed, ${fails.length} FAILED\n  ` + fails.join('\n  ')
    : `higheredjobs-verify selftest: ${pass} checks passed.`);
  return fails.length === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (has('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  } else {
    try {
      process.exit(await main());
    } catch (e) {
      err(`the check failed: ${e.stack || e.message}`);
      process.exit(1);
    }
  }
}
