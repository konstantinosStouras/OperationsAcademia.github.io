#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — read every crawled posting's own advertisement.

       data/jobmarket.json  ->  THIS  ->  data/adverts.json
        (the approved crawled postings)    (what each ad says)
                  |                                |
                  +---------- applyAdverts --------+
                                    |
                  data/jobmarket.json + data/jobs.json

       …and the PENDING review queue (Firestore `jobReviews`)  ->  THIS
                  ->  an `ad` block on each pending document, drawn on the
                      review card so the maintainer reads what the
                      advertisement says while deciding.

   WHY. higheredjobs-verify.mjs reads the 156 postings advertised on
   higheredjobs.com; the other ~120 hosts the tracking sheet links to were
   never read at all, so their postings publish "Until filled." — the
   ingest's default for an empty cell, not a fact anyone checked — and their
   review cards ask the maintainer to open every advertisement by hand. This
   pass reads them: one generic high-precision parser (JSON-LD + labelled
   fields) plus a Workday adapter, in _scraper/adverts.mjs.

   WHAT IT WILL NOT DO — the same contract as the HigherEdJobs pass. It never
   overwrites a deadline the maintainer typed (a disagreement is reported so
   the SHEET is corrected); it never removes a posting or edits how one is
   described; a page it cannot read changes nothing at all; and `validThrough`
   is NEVER read as a deadline (see the header of adverts.mjs). On the queue
   it writes ONLY the `ad` block — never the decision, never the edits — the
   same discipline as the sync's `dup`/`biz` re-flagging.

   TWO STORES, AND WHY. What an ad for a PUBLISHED posting says is cached in
   data/adverts.json, exactly like data/higheredjobs.json. A PENDING posting
   is by definition not public, and everything under data/ is served to
   anyone who asks — so its advertisement's reading lives on the queue
   document alone (admin-only), and the served cache learns the ad only once
   the posting is approved and published.

   Modes:
     --scan          list what would be fetched, fetch nothing, write nothing
     --dry-run       fetch and parse, print the diff, write nothing
     --apply-only    write nothing but re-apply the committed cache (the
                     push-retry replay)
     --force         ignore the freshness rule and re-read every ad
     --limit <n>     read at most n ads this run, both passes together (40)
     --ttl <days>    re-read an ad this many days after the last read (7)
     --no-queue      skip the Firestore queue pass
     --hosts         list the distinct websites this and last market year's
                     postings are advertised on (drive/docs links excluded —
                     user-uploaded copies, not job boards); --write also
                     refreshes the _ADVERT-HOSTS.md snapshot. Offline.
     --selftest      offline checks, no network, no credentials

   NOTE. This build environment's egress policy denies every one of these
   hosts (403 at the proxy), so a real read only happens on the GitHub
   Actions runners — the same situation as higheredjobs.com and
   docs.google.com. Run it with --apply-only or --selftest locally. The
   queue pass is a no-op until FIREBASE_SERVICE_ACCOUNT is set, like the
   mailers.
   --------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isoStamp, longDate, marketYear, patchDeadlines } from './jobs-model.mjs';
import { SOURCE as SHEET_SOURCE } from './jobmarket-sheet.mjs';
import { firestore } from './_mail.mjs';
import { COLLECTION as REVIEW_COL, PENDING } from './jobreview.mjs';
import {
  parseAd as parseHejAd, jobCodeOf, detailsUrl, isHigherEdJobsUrl,
} from './higheredjobs.mjs';
import {
  parseAdvert, parseWorkdayJson, workdayApiUrl, cacheEntry, emptyCache,
  needFetch, applyAdverts, advertKeyOf, isAdvertUrl, adBlock, sameAdInfo,
  queueNeedsFetch, advertPlace, advertHostsReport,
} from './adverts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const SHEET_FILE = path.join(DATA, 'jobmarket.json');
const JOBS_FILE = path.join(DATA, 'jobs.json');
const CACHE_FILE = path.join(DATA, 'adverts.json');
const VOCAB_FILE = path.join(DATA, 'vocab.json');
const HOSTS_FILE = path.join(HERE, '..', '_ADVERT-HOSTS.md');

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
const NO_QUEUE = has('--no-queue');
const HOSTS = has('--hosts');
const WRITE = has('--write');
const LIMIT = Math.max(1, Number(opt('--limit', '40')) || 40);
const TTL_DAYS = Math.max(0, Number(opt('--ttl', '7')) || 7);

/** Between requests. These are a hundred different small hosts being read a
    page or two each — a human pace costs none of them anything, and a run
    reads at most LIMIT pages in total, so the whole thing is bounded. */
const PACE_MS = 1500;

const UA = 'operationsacademia.org posting check (+https://www.operationsacademia.org)';

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));
const err = (...a) => console.log('::error::' + a.join(' '));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------- network */

/** One GET, with a timeout and two retries. A failure returns rather than
    throws: this whole pass is an enrichment and must never be the reason a
    scheduled run fails. */
async function fetchOnce(u, { accept, tries = 3, timeoutMs = 30000 } = {}) {
  let last = '';
  for (let i = 1; i <= tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(u, {
        redirect: 'follow', signal: ctl.signal,
        headers: { 'user-agent': UA, accept },
      });
      const body = await res.text();
      const type = String(res.headers.get('content-type') || '');
      if (res.ok) return { ok: true, body, type };
      last = `HTTP ${res.status}`;
      // a listing that is gone answers 404 and will never succeed
      if (res.status === 404 || res.status === 410) return { ok: false, gone: true, error: last };
      // a host that refuses automation outright will refuse it tomorrow too,
      // but cheaply — let the TTL retry it rather than burning the retries now
      if (res.status === 403 || res.status === 401) return { ok: false, error: last };
    } catch (e) {
      last = e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message;
    } finally {
      clearTimeout(timer);
    }
    if (i < tries) await sleep(1500 * i);
  }
  return { ok: false, error: last || 'unknown error' };
}

/**
 * Fetch and parse ONE advertisement, whatever it is hosted on:
 * `{ fetched, parsed, error }`. Workday URLs are answered from the tenant's
 * public JSON endpoint (the HTML is a JavaScript shell holding nothing);
 * higheredjobs.com URLs — which only ever reach here from the QUEUE pass,
 * the published pass never selects them — are read with that host's own
 * parser; everything else is read as HTML. A body that is not a page at all
 * (the PDFs some sheet rows link to) parses to `unreadable` and changes
 * nothing.
 */
async function readAdvert(u) {
  if (isHigherEdJobsUrl(u)) {
    const code = jobCodeOf(u);
    const target = code ? detailsUrl(code) : u;
    const res = await fetchOnce(target, { accept: 'text/html' });
    if (!res.ok) return { fetched: res, parsed: res.gone ? { ...parseHejAd(''), gone: true } : null };
    return { fetched: res, parsed: parseHejAd(res.body, { jobCode: code }) };
  }

  const api = workdayApiUrl(u);
  if (api) {
    const res = await fetchOnce(api, { accept: 'application/json' });
    if (!res.ok) return { fetched: res, parsed: res.gone ? { ...parseAdvert(''), gone: true } : null };
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* fall through to unreadable */ }
    return { fetched: res, parsed: json ? parseWorkdayJson(json) : parseAdvert('') };
  }

  const res = await fetchOnce(u, { accept: 'text/html' });
  if (!res.ok) return { fetched: res, parsed: res.gone ? { ...parseAdvert(''), gone: true } : null };
  if (/^%PDF/.test(res.body) || /application\/pdf/i.test(res.type)) {
    return { fetched: res, parsed: parseAdvert('') };   // a PDF is not a page: unreadable
  }
  return { fetched: res, parsed: parseAdvert(res.body) };
}

/* --------------------------------------------------------------------- io */

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
  for (const key of Object.keys(cache.ads).sort()) ads[key] = cache.ads[key];
  return JSON.stringify({ generated: cache.generated, ads }, null, 1) + '\n';
}

/* ------------------------------------------------------------- host report */

/**
 * `--hosts`: the distinct websites this and last market year's postings are
 * advertised on — the owner's own inventory question (2026-08-24), answered
 * from the committed data so it needs no network at all. Drive/Docs links are
 * excluded (user-uploaded copies whose address changes every time). With
 * `--write` the listing is also written to _ADVERT-HOSTS.md — an unserved,
 * regenerable snapshot; the underscore is what keeps Jekyll from publishing
 * it, like every other maintainer file here.
 */
async function hostsReport() {
  const jobs = await readJson(JOBS_FILE, []);
  const sheet = await readJson(SHEET_FILE, []);
  const byId = new Map();
  for (const r of [...(Array.isArray(jobs) ? jobs : []),
                   ...(Array.isArray(sheet) ? sheet : [])]) {
    if (r && r.id && !byId.has(r.id)) byId.set(r.id, r);
  }

  /* "This and last job market year" comes from the site's own roll rule,
     never from whatever years the data happens to hold — a single stray
     2028 posting must not displace the 900-row season under way. */
  const thisMarket = marketYear(new Date());
  const report = advertHostsReport([...byId.values()],
    { years: [thisMarket, thisMarket - 1] });
  const total = report.hosts.reduce((n, h) => n + h.postings, 0);
  log(`${report.hosts.length} distinct advertisement website(s) across ` +
      `${total} posting(s) in market years ${report.years.join(' and ')} ` +
      '(drive/docs links excluded — user-uploaded copies, not job boards):');
  for (const h of report.hosts) {
    log(`  ${String(h.postings).padStart(4)}  ${h.host}  [${h.read}]`);
  }

  if (WRITE) {
    const lines = [
      '# Where the postings\' advertisements live',
      '',
      'The distinct websites carrying the advertisements of the postings from',
      `market years **${report.years.join(' and ')}** — the owner's inventory`,
      'question (2026-08-24). Drive/Docs links are excluded: they are',
      'user-uploaded copies whose address changes every time, not job boards.',
      '',
      'A SNAPSHOT, regenerated by `node _scraper/adverts-verify.mjs --hosts',
      '--write` over the committed data — never hand-edited. `read` names the',
      'pipeline that covers each host; "generic" is the JSON-LD +',
      'labelled-field parser in `_scraper/adverts.mjs`, and a host it cannot',
      'read changes nothing (its postings keep what the tracking sheet said).',
      '',
      '| Postings | Website | Years | How it is read |',
      '|---:|---|---|---|',
      ...report.hosts.map((h) =>
        `| ${h.postings} | ${h.host} | ${h.years.join(', ')} | ${h.read} |`),
      '',
    ];
    await writeFile(HOSTS_FILE, lines.join('\n'));
    log(`wrote ${path.basename(HOSTS_FILE)}.`);
  }
  return 0;
}

/* ------------------------------------------------------- the published pass */

async function publishedPass(cache, { today, now, budget }) {
  const sheetRows = await readJson(SHEET_FILE, []);
  if (!Array.isArray(sheetRows) || !sheetRows.length) {
    log('data/jobmarket.json holds no postings — nothing to check.');
    return { sheetRows: [], read: 0 };
  }

  const covered = sheetRows.filter((r) => isAdvertUrl(r.adUrl));
  log(`${sheetRows.length} posting(s) from the tracking sheet, ` +
      `${covered.length} advertised on hosts this pass reads ` +
      '(HigherEdJobs has its own).');

  let read = 0, failed = 0;

  if (!APPLY_ONLY) {
    const queue = needFetch(sheetRows, cache, { today, ttlDays: TTL_DAYS, force: FORCE });
    const slice = queue.slice(0, Math.max(0, budget.left));

    if (queue.length > slice.length) {
      log(`${queue.length} advertisement(s) to read; taking the newest ${slice.length} ` +
          'this run — the rest are read by the next one.');
    } else {
      log(`${slice.length} advertisement(s) to read.`);
    }

    if (SCAN) {
      for (const q of slice) {
        log(`  ${q.row.institution}${q.row.department ? ' — ' + q.row.department : ''}`);
        log(`      ${q.row.adUrl}`);
      }
    } else {
      for (const q of slice) {
        const { fetched, parsed } = await readAdvert(q.row.adUrl);
        budget.left--;

        if (!parsed) {
          failed++;
          warn(`${q.key}: ${fetched.error} — left as it was`);
          await sleep(PACE_MS);
          continue;
        }

        cache.ads[q.key] = cacheEntry(parsed, {
          adUrl: q.row.adUrl, checkedAt: isoStamp(now), previous: q.had, via: 'page',
        });
        read++;

        log(`  ${q.key}  ${parsed.gone ? '(no longer listed)'
          : `${parsed.institution || parsed.title || '(unreadable)'} — ${parsed.applyByDate
              ? `due ${parsed.applyByDate}` : 'no closing date stated'}`}`);

        await sleep(PACE_MS);
      }
    }

    /* Stamped only when something was actually read — a run where every
       fetch failed knows nothing new, and bumping the date would commit and
       redeploy the site to say so. */
    if (read) cache.generated = isoStamp(now);
    if (failed) log(`${failed} advertisement(s) could not be read this run.`);
  } else {
    log('--apply-only: re-applying the committed cache, fetching nothing.');
  }

  return { sheetRows, read };
}

/* ------------------------------------------------------------ the queue pass */

/**
 * Read the advertisement of every PENDING review-queue posting and put what
 * it says onto the document as `ad` — where the review card draws it. Wholly
 * non-fatal, wholly optional: no credentials, an unreachable queue, or a
 * page that cannot be read each just mean the card shows nothing new.
 */
async function queuePass({ today, now, budget }) {
  if (NO_QUEUE) { log('--no-queue: skipping the review queue.'); return; }

  /* The vocabulary, for classifying the ad's stated names into the site's
     own three — university, school, department (`advertPlace`). Read
     leniently: no vocabulary just means the block carries the stated names
     and no classification. */
  const vocab = await readJson(VOCAB_FILE, null);

  let db = null;
  try { db = await firestore(); } catch (e) { warn(`no queue pass: ${e.message}`); }
  if (!db) {
    log('no Firebase credentials in this environment — the review-queue pass is skipped.');
    return;
  }

  let docs = [];
  try {
    const snap = await db.collection(REVIEW_COL).where('status', '==', PENDING).get();
    docs = snap.docs.map((d) => d.data());
  } catch (e) {
    warn(`the review queue could not be read (${e.message}) — skipping it.`);
    return;
  }

  const want = [];
  for (const doc of docs) {
    const need = queueNeedsFetch(doc, { today, ttlDays: TTL_DAYS, force: FORCE });
    if (need.fetch) want.push({ doc, url: need.url });
  }
  log(`${docs.length} pending posting(s) in the review queue, ` +
      `${want.length} advertisement(s) to read.`);

  if (SCAN) {
    for (const w of want.slice(0, Math.max(0, budget.left))) {
      log(`  ${w.doc.rowId}  ${w.url}`);
    }
    return;
  }

  let wrote = 0;
  for (const w of want) {
    if (budget.left <= 0) {
      log('the read budget for this run is spent — the rest wait for the next one.');
      break;
    }
    const { fetched, parsed } = await readAdvert(w.url);
    budget.left--;

    if (!parsed) {
      warn(`${w.doc.rowId}: ${fetched.error} — the card keeps what it had`);
      await sleep(PACE_MS);
      continue;
    }

    const entry = cacheEntry(parsed, {
      adUrl: w.url, checkedAt: isoStamp(now), previous: w.doc.ad || null, via: 'page',
    });
    const block = adBlock(entry, {
      adUrl: w.url,
      place: vocab ? advertPlace(entry, vocab) : null,
    });

    if (sameAdInfo(block, w.doc.ad)) {
      await sleep(PACE_MS);
      continue;
    }

    if (DRY) {
      log(`  ${w.doc.rowId}: would record ${block.applyByDate
        ? `deadline ${block.applyByDate}` : (block.status === 'gone'
          ? 'that the listing is down' : 'what the page states')}`);
    } else {
      try {
        /* Only the `ad` block — never the decision, never the edits — and by
           merge, so a maintainer working the queue right now loses nothing.
           The same shape as the sync's dup/biz re-flagging. */
        await db.collection(REVIEW_COL).doc(w.doc.rowId).set({ ad: block }, { merge: true });
        wrote++;
        log(`  ${w.doc.rowId}: ${block.applyByDate
          ? `the advertisement closes ${block.applyByDate}`
          : (block.status === 'gone' ? 'the advertisement is no longer up'
            : 'recorded what the page states')}`);
      } catch (e) {
        warn(`could not write the ad block for ${w.doc.rowId}: ${e.message}`);
      }
    }
    await sleep(PACE_MS);
  }
  if (wrote) log(`${wrote} pending posting(s) had their advertisement recorded.`);
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (HOSTS) return hostsReport();

  const now = new Date();
  const today = isoStamp(now).slice(0, 10);
  const budget = { left: LIMIT };

  const cache = await readCache();

  /* The QUEUE pass runs first (owner, 2026-08-24): the pending postings are
     the ones the maintainer is actively deciding, so a busy morning spends
     its budget on their cards before topping up the published rows — whose
     deadlines, once filled, are frozen anyway. */
  if (!APPLY_ONLY) await queuePass({ today, now, budget });

  const { sheetRows } = await publishedPass(cache, { today, now, budget });

  if (SCAN) {
    log('--scan: fetched nothing, wrote nothing.');
    return 0;
  }

  /* ------------------------------------------------------------ the apply */

  const applied = applyAdverts(sheetRows, cache, { today });

  for (const c of applied.changed) {
    log(`  ${c.id}: "${c.from}" -> "${c.to}"${c.past ? '  (that deadline has passed)' : ''}`);
  }
  for (const c of applied.conflicts) {
    warn(`${c.id}: the sheet says ${c.sheet}, the advertisement says ${c.ad} — ` +
         'the sheet wins. Correct the sheet if the advertisement is right.');
  }

  const sheetBefore = JSON.stringify(sheetRows, null, 1) + '\n';
  const sheetAfter = JSON.stringify(applied.rows, null, 1) + '\n';

  /* data/jobs.json takes ONLY the deadlines this run filled, onto ONLY the
     rows it filled them for (patchDeadlines in jobs-model.mjs) — exactly as
     higheredjobs-verify.mjs does, and for the reason recorded there: the
     wholesale row copy reverted build-jobs' own heals on rows this pass
     never touched, and the mirror guard stopped the whole commit. */
  const jobs = await readJson(JOBS_FILE, []);
  const jobsNext = patchDeadlines(jobs, applied, SHEET_SOURCE);
  const jobsBefore = JSON.stringify(jobs, null, 1) + '\n';
  const jobsAfter = JSON.stringify(jobsNext, null, 1) + '\n';

  const cacheBefore = existsSync(CACHE_FILE) ? await readFile(CACHE_FILE, 'utf8') : '';
  const cacheAfter = serialiseCache(cache);

  const changes = [
    cacheBefore !== cacheAfter ? 'data/adverts.json' : '',
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
  log(`wrote ${changes.join(', ')} (${applied.changed.length} deadline(s) filled).`);
  return 0;
}

/* ----------------------------------------------------------------- selftest */

/* The offline half. The parser's own checks live in selftest.mjs beside every
   other model check; these are the few that belong to this file: that its
   flags parse, and that the round trip through the cache is stable. */
function selftest() {
  let pass = 0; const fails = [];
  const ok = (c, what) => { if (c) pass++; else fails.push(what); };

  const HTML = `<h1>Assistant Professor of Operations</h1>
    <script type="application/ld+json">{"@type":"JobPosting","title":
    "Assistant Professor of Operations","datePosted":"2026-08-10",
    "validThrough":"2028-02-06","hiringOrganization":{"@type":"Organization",
    "name":"Example University"}}</script>
    <dl><dt>Closing date</dt><dd>15 October 2026</dd></dl>`;

  const p = parseAdvert(HTML);
  ok(p.ok, 'a page with a JobPosting block parses');
  ok(p.applyByDate === '2026-10-15', 'the labelled closing date is the deadline');
  ok(p.listedUntil === '2028-02-06',
    'and validThrough is only ever the listing\'s end — never the deadline');

  const u = 'https://apply.example.com/12345?utm_source=x';
  const entry = cacheEntry(p, { adUrl: u, checkedAt: '2026-08-18T00:00:00Z' });
  const key = advertKeyOf(u);
  const cache = { generated: '', ads: { [key]: entry } };
  const rows = [{ id: 'x', adUrl: u, applyBy: 'Until filled.', applyByDate: '', posted: '2026-08-10' }];

  const once = applyAdverts(rows, cache, { today: '2026-08-18' });
  ok(once.rows[0].applyByDate === '2026-10-15', 'an open-ended posting takes the ad\'s deadline');
  ok(once.rows[0].applyBy === longDate('2026-10-15'), 'and shows it the way the site writes dates');
  const twice = applyAdverts(once.rows, cache, { today: '2026-08-18' });
  ok(JSON.stringify(twice.rows) === JSON.stringify(once.rows), 're-applying changes nothing');
  ok(twice.changed.length === 0, 'and reports no second correction');

  ok(serialiseCache(cache) === serialiseCache(JSON.parse(serialiseCache(cache))),
    'the cache round-trips byte-identically');

  const frozen = needFetch(rows,
    { ads: { [key]: { ...entry, applyByDate: '2026-08-01' } } },
    { today: '2026-08-18', ttlDays: 7 });
  ok(frozen.length === 0, 'an advertisement whose deadline has passed is not read again');

  const doc = { rowId: 'x', status: 'pending', row: { adUrl: u }, ad: null };
  ok(queueNeedsFetch(doc, { today: '2026-08-18' }).fetch === true,
    'a pending posting with no ad block is read');
  const fresh = { ...doc, ad: { ...adBlock(entry, { adUrl: u }) } };
  ok(queueNeedsFetch(fresh, { today: '2026-08-19', ttlDays: 7 }).fetch === false,
    'a fresh block is left alone');
  ok(queueNeedsFetch({ ...fresh, edits: { adUrl: 'https://other.example.com/9' } },
    { today: '2026-08-19' }).fetch === true, 'a re-linked advertisement is read again');
  ok(queueNeedsFetch({ rowId: 'y', row: { adUrl: 'https://docs.google.com/x.y' } },
    { today: '2026-08-19' }).fetch === false, 'a host this pass never fetches is never fetched');

  ok(workdayApiUrl('https://psu.wd1.myworkdayjobs.com/en-US/PSU_Academic/job/Penn-State/Slug_REQ-1')
    === 'https://psu.wd1.myworkdayjobs.com/wday/cxs/psu/PSU_Academic/job/Slug_REQ-1',
    'a Workday page is answered from its public JSON endpoint');

  const wd = parseWorkdayJson({
    jobPostingInfo: {
      title: 'Assistant Professor', location: 'Erie, PA',
      startDate: '2026-08-01', endDate: '2027-08-01',
      jobDescription: '<p><b>Application deadline:</b> October 15, 2026</p>' +
        '<p><b>College:</b> Black School of Business</p>' +
        '<p><b>Department:</b> Project and Supply Chain Management</p>',
    },
    hiringOrganization: { name: 'Penn State' },
  });
  ok(wd.ok && wd.applyByDate === '2026-10-15',
    'a Workday description states its deadline and it is read');
  ok(wd.listedUntil === '2027-08-01', 'while endDate stays the listing\'s end');
  ok(wd.school === 'Black School of Business'
    && wd.department === 'Project and Supply Chain Management',
    'and the college and department it names are read too');

  const place = advertPlace({ institution: 'Haas School of Business' }, {
    byUniversity: { 'University of California, Berkeley': {
      schools: ['Haas School of Business'], bySchool: {} } },
  });
  ok(place && place.institution === 'University of California, Berkeley',
    'a hiring organisation that is a school is filed under its university');

  console.log(fails.length
    ? `adverts-verify selftest: ${pass} passed, ${fails.length} FAILED\n  ` + fails.join('\n  ')
    : `adverts-verify selftest: ${pass} checks passed.`);
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
