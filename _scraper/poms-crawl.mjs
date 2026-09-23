#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — crawl the POMS job postings page into the review
   queue.

       https://www.poms.org/opportunities
              |  THIS, daily (.github/workflows/oa-poms-crawl.yml)
              |  reads each new posting's own advertisement:
              |    a PDF on poms.org        -> pdf-text.mjs + advert-text.mjs
              |    a Workday / HigherEdJobs page -> the readers adverts-verify has
              |    any other page           -> adverts.mjs, and when that reads
              |                                 nothing, a real browser
              |                                 (render-page.mjs) + advert-text.mjs
              v
       Firestore `jobReviews`  ->  the review card on /admin-area
              |  Approve
              v
       build-jobs.mjs publishes the approved document  ->  data/jobs.json

   IT WRITES NOTHING UNDER data/. A posting nobody has approved is not public,
   and everything under data/ is served to anyone who asks — the reason the
   queue is a Firestore collection at all (jobreview.mjs). An approved POMS
   posting publishes from its document, so this run has no served file to
   commit and no publishing gate to pass; it needs the credential and nothing
   else. See poms.mjs for what a row is and how "new" is decided.

   WHAT A RUN WRITES, and no more: a `create()` per new posting (so a document
   the maintainer decided on while this ran is never overwritten — ALREADY_
   EXISTS is theirs); on a pending POMS document whose advertisement could not
   be read last time, a merge of `row` and `ad` once it can be — never the
   decision, never the edits, the sheet sync's own refresh rule.

   Modes:
     --scan          read the page, list what would be queued, fetch no advert
     --dry-run       read everything, print the documents, write nothing
     --since <day>   queue postings dated on or after this ISO day (default: the
                     last WINDOW_DAYS days; widen it to backfill)
     --limit <n>     read at most n advertisements this run (40)
     --no-render     never start a browser for a page the parser could not read
     --selftest      offline checks, no network, no credentials

   This build environment's egress denies poms.org and every advertisement
   host (403 at the proxy), so a real crawl only happens on the runners —
   the same situation as the sheet sync and both advert passes. The PR check
   spawns --selftest; the workflow runs it too, with the PDF engine present.
   --------------------------------------------------------------------------- */

import { isMain } from './_main.mjs';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup as dnsLookup } from 'node:dns/promises';

import { isoStamp, marketFloor, LEVELS, TYPES, PUBLIC_FIELDS, stripRowEmails } from './jobs-model.mjs';
import { firestore } from './_mail.mjs';
import {
  COLLECTION as REVIEW_COL, PENDING, APPROVED, queueDoc, duplicatesOf, businessCheck,
  advertRepeat, sameDups, sameBiz,
} from './jobreview.mjs';
import { parseAdvert, advertPlace, cacheEntry, adBlock, workdayApiUrl, GONE_RX } from './adverts.mjs';
import { readAdvert } from './adverts-verify.mjs';
import { isHigherEdJobsUrl } from './higheredjobs.mjs';
import { campusCountries, healCountry } from './vocab.mjs';
import { parseAdvertText } from './advert-text.mjs';
import { looksLikePdf, pdfText, pdfjsInstalled, linesFromItems } from './pdf-text.mjs';
import { renderedText } from './render-page.mjs';
import {
  SOURCE, PAGE_URL, WINDOW_DAYS, READ_TTL_DAYS,
  parseOpportunities, newOpportunities, knownLinks, sinceDay, rowFromOpportunity,
  uniqueId, nearbyPostings, refreshFromAd, linkKind, isPomsUrl,
} from './poms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const JOBS_FILE = path.join(DATA, 'jobs.json');
const SHEET_FILE = path.join(DATA, 'jobmarket.json');
const VOCAB_FILE = path.join(DATA, 'vocab.json');
const DIRECTORY_FILE = path.join(DATA, 'universities.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const SCAN = has('--scan');
const DRY = has('--dry-run');
const NO_RENDER = has('--no-render');
/* A LIMIT THAT IS NOT A WHOLE NUMBER ABOVE ZERO IS REFUSED OUT LOUD in main(),
   not quietly read as forty: "--limit 0" meant read none, and "ten" meant
   ten (the 2026-09-23 review). */
const LIMIT_RAW = opt('--limit', '');
const LIMIT_OK = /^[1-9]\d*$/.test(LIMIT_RAW);
const LIMIT = LIMIT_OK ? Number(LIMIT_RAW) : 40;
/* How long the fetching may run before the run stops reading and writes
   what it has — the adverts pass's own clock, for its reason: LIMIT reads,
   each paced, each with retries of a long timeout, can outrun the workflow's
   forty minutes, and a run killed by its cap has read for nothing. */
const READ_WINDOW_MS = Math.max(60_000, Number(opt('--read-window-ms', '')) || 20 * 60_000);
const PACE_MS = 1500;

const UA = 'operationsacademia.org posting check (+https://www.operationsacademia.org)';

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));
const err = (...a) => console.log('::error::' + a.join(' '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------- network */

/** A body larger than this is refused rather than read: an advertisement is
    kilobytes and the largest PDF on the page a few megabytes, and a run that
    buffered half a gigabyte and then asked for it as a string threw
    ERR_STRING_TOO_LONG out of the read loop, ending the run on that row every
    morning for the rest of the window (the 2026-09-23 review). */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

/** An address the runner must never fetch, pure over an IP as dns.lookup
    hands it back: loopback, link-local (where a cloud runner's metadata
    service answers), the private and shared ranges, multicast and the
    unspecified address. A View link's server can answer 302 to any of them,
    and `redirect: 'follow'` used to go there (the 2026-09-23 review). */
export function privateAddress(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return true;
  const v4 = s.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (s === '::' || s === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/.test(s) || /^fe[89ab][0-9a-f]$/.test(s)) return true;   // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;                                    // fc00::/7
  return false;
}

/** May this host be fetched? Every address it resolves to has to be public;
    a name that does not resolve, or "localhost" under any spelling, may not.
    The lookup is injectable so the rule can be driven without a network. */
export async function hostAllowed(hostname, { lookup = dnsLookup } = {}) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return false;
  if (/^[\d.]+$/.test(h) || h.includes(':')) return !privateAddress(h);
  try {
    const addrs = await lookup(h, { all: true });
    return Array.isArray(addrs) && addrs.length > 0 && addrs.every((a) => !privateAddress(a && a.address));
  } catch {
    return false;
  }
}

/** The body, chunk by chunk, up to `max` bytes; null once it runs past them
    (leaving the loop cancels the stream). */
async function readCapped(body, max) {
  if (!body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > max) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** One GET for BYTES, with a timeout and two retries — the sibling of
    adverts-verify's fetchOnce, which reads text and so cannot carry a PDF.
    A failure returns rather than throws: an advertisement that cannot be
    read is a posting queued with less, never a run that stops. Redirects are
    followed BY HAND, each hop held to `hostAllowed` and to http(s), and the
    body is read against `MAX_BODY_BYTES`; a refusal on either count is final
    and is not retried, since it is the address and not the network. */
/* The Accept header's "anything" is spelt with an escaped slash: the
   selftest reads this file with its comments stripped by a regex, and the
   literal star-slash-star opens a block comment to it that swallows the
   whole of fetchBytes, so every pin on this function passed by vacuity. */
export async function fetchBytes(u, { accept = '*\u002f*', tries = 3, timeoutMs = 45000, maxBytes = MAX_BODY_BYTES, hostCheck = hostAllowed } = {}) {
  const refuse = (why, status = 0, type = '') => ({ ok: false, refused: true, bytes: Buffer.alloc(0), type, status, error: why });
  let last = '';
  for (let i = 1; i <= tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let at = String(u);
      let res = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const target = new URL(at);
        if (!/^https?:$/.test(target.protocol)) return refuse(`refused a ${target.protocol} address`);
        if (!(await hostCheck(target.hostname))) return refuse(`refused ${target.hostname}: not a public host`);
        res = await fetch(at, {
          redirect: 'manual', signal: ctl.signal,
          headers: { 'user-agent': UA, accept },
        });
        if (![301, 302, 303, 307, 308].includes(res.status)) break;
        const loc = res.headers.get('location');
        if (!loc) break;
        if (res.body) await res.body.cancel().catch(() => {});
        at = new URL(loc, at).href;
        res = null;
      }
      if (!res) return refuse(`more than ${MAX_REDIRECTS} redirects`);
      const type = String(res.headers.get('content-type') || '');
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxBytes) {
        ctl.abort();
        return refuse(`too large (${len} bytes; the limit is ${maxBytes})`, res.status, type);
      }
      if (res.ok) {
        const bytes = await readCapped(res.body, maxBytes);
        if (!bytes) {
          ctl.abort();
          return refuse(`too large (over ${maxBytes} bytes)`, res.status, type);
        }
        return { ok: true, bytes, type, status: res.status, error: '' };
      }
      if (res.body) await res.body.cancel().catch(() => {});
      last = `HTTP ${res.status}`;
      if (res.status === 404 || res.status === 410) return { ok: false, gone: true, bytes: Buffer.alloc(0), type, status: res.status, error: last };
      if (res.status === 403 || res.status === 401) return { ok: false, bytes: Buffer.alloc(0), type, status: res.status, error: last };
    } catch (e) {
      last = e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message;
    } finally {
      clearTimeout(timer);
    }
    if (i < tries) await sleep(1500 * i);
  }
  return { ok: false, bytes: Buffer.alloc(0), type: '', status: 0, error: last || 'unknown error' };
}

/** readOpportunityAd, and never a throw: one advertisement that breaks its
    reader is a posting queued with less, not a run that ends with every row
    after it unread and the same row first tomorrow (the 2026-09-23 review). */
export async function safeRead(opp, opts) {
  try {
    return await readOpportunityAd(opp, opts);
  } catch (e) {
    return { parsed: null, via: 'page', error: `the reader failed: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * Read ONE posting's advertisement, whatever it is: `{ parsed, via, error }`.
 * `parsed` is null when nothing could be fetched; otherwise a parse in
 * adverts.mjs's shape (ok false when the page or file was fetched and not
 * understood), and `via` names the road it came by — 'pdf', 'page' or
 * 'render' — which the queue document and the comments both say.
 */
export async function readOpportunityAd(opp, { render = true } = {}) {
  const u = opp.href;
  if (opp.kind === 'doc') return { parsed: null, via: '', error: 'a Word file, which nothing here reads' };

  /* the two hosts that have readers of their own */
  if (isHigherEdJobsUrl(u) || workdayApiUrl(u)) {
    const r = await readAdvert(u);
    return { parsed: r.parsed, via: 'page', error: r.parsed ? '' : (r.fetched && r.fetched.error) || '' };
  }

  const got = await fetchBytes(u);
  if (!got.ok) {
    return { parsed: got.gone ? { ...parseAdvertText(''), gone: true } : null, via: 'page', error: got.error };
  }

  if (looksLikePdf(got.bytes) || /application\/pdf/i.test(got.type)) {
    const t = await pdfText(got.bytes);
    if (!t.ok) return { parsed: parseAdvertText(''), via: 'pdf', error: t.error };
    return { parsed: parseAdvertText(t.text), via: 'pdf', error: '' };
  }

  const html = got.bytes.toString('utf8');
  let parsed = parseAdvert(html);
  let via = 'page';
  let error = '';
  /* A page the markup reader found nothing on is, nine times in ten, a
     JavaScript shell — the Interfolio shape. A browser reads it as a person
     would; the words it shows go through the text reader a PDF goes through. */
  if (!parsed.ok && !parsed.gone && render) {
    const r = await renderedText(u);
    if (r.ok) {
      const p = parseAdvertText(r.text, { title: r.h1 });
      if (GONE_RX.test(r.text.slice(0, 3000)) && !p.applyByDate && !p.posted) p.gone = true;
      if (p.ok || p.gone) { parsed = p; via = 'render'; }
    } else {
      error = r.error;
    }
  }
  return { parsed, via, error };
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

async function fetchPage(u) {
  const got = await fetchBytes(u, { accept: 'text/html' });
  return got.ok ? { ok: true, html: got.bytes.toString('utf8') } : { ok: false, error: got.error };
}

async function loadQueue() {
  let db;
  try {
    db = await firestore();
  } catch (e) {
    return { ok: false, db: null, docs: [], error: e.message };
  }
  if (!db) return { ok: false, db: null, docs: [], error: 'no Firebase credentials in this environment' };
  try {
    const snap = await db.collection(REVIEW_COL).get();
    return { ok: true, db, docs: snap.docs.map((d) => d.data()).filter((d) => d && d.rowId), error: '' };
  } catch (e) {
    return { ok: false, db: null, docs: [], error: e.message };
  }
}

/* ------------------------------------------------------------------- pass */

function daysApart(a, b) {
  const t1 = Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`);
  const t2 = Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`);
  return (Number.isFinite(t1) && Number.isFinite(t2)) ? Math.abs(t2 - t1) / 86400000 : Infinity;
}

/** The advertisement a queue document is READ FROM: the link the maintainer
    corrected on the card where they did, else the one the page gave. The
    same `edits.adUrl || row.adUrl` the advert pass reads for a sheet document
    (queueNeedsFetch), which stands down on a POMS document, so nothing but
    this crawler ever follows a corrected POMS link (the 2026-09-23 review). */
export function effectiveLink(d) {
  return String((d && d.edits && d.edits.adUrl) || (d && d.row && d.row.adUrl) || '');
}

/** The pending POMS documents whose advertisement is still to be read: the
    link was corrected since the last reading (read now, whatever the block
    says), or there is no block, or it says unreadable and the last try is
    older than the TTL. */
export function needReread(docs, { today = '', ttlDays = READ_TTL_DAYS } = {}) {
  return (docs || []).filter((d) => {
    if (!(d && d.status === PENDING && d.row && d.row.source === SOURCE)) return false;
    const link = effectiveLink(d);
    if (!link || linkKind(link) === 'doc') return false;
    if (d.ad && d.ad.url && d.ad.url !== link) return true;
    if (d.ad && d.ad.status !== 'unreadable') return false;
    return !(d.ad && d.ad.checkedAt) || daysApart(d.ad.checkedAt, today) >= ttlDays;
  });
}

/** What the advertisement said, in the two forms the run needs: the parse
    with its classification for the row builder, and the block the document
    carries. `null` for the row when the reading is not usable. The block
    names the road the reading came by (`via`: pdf, page or render), which
    `adBlock` does not copy from the cache entry, so the document really says
    what the header above promises. */
export function adForRow(parsed, via, { adUrl, vocab, now, previous = null }) {
  const road = via || 'page';
  const entry = cacheEntry(parsed || parseAdvertText(''), { adUrl, checkedAt: isoStamp(now), previous, via: road });
  const place = parsed && parsed.ok && vocab ? advertPlace(entry, vocab) : null;
  const block = { ...adBlock(entry, { adUrl, place }), via: road };
  const ad = parsed && parsed.ok ? { ...parsed, via, place } : null;
  return { ad, block };
}

async function main() {
  const now = new Date();
  const today = isoStamp(now).slice(0, 10);
  /* A SINCE THAT IS NOT A DAY IS SAID, not silently replaced by the default:
     a dispatch typed "2026-7-1" read the last thirty days and the only trace
     was the effective date in the first log line (the 2026-09-23 review). */
  const sinceGiven = opt('--since', '');
  const since = /^\d{4}-\d{2}-\d{2}$/.test(sinceGiven) ? sinceGiven : sinceDay(now, WINDOW_DAYS);
  if (sinceGiven && since !== sinceGiven) {
    warn(`--since "${sinceGiven}" is not a day written YYYY-MM-DD — reading the last ${WINDOW_DAYS} days instead`);
  }
  if (LIMIT_RAW && !LIMIT_OK) {
    warn(`--limit "${LIMIT_RAW}" is not a whole number above zero — reading up to ${LIMIT} advertisements`);
  }
  const minYear = marketFloor(now);
  const render = !NO_RENDER;
  const budget = { left: LIMIT, until: Date.now() + READ_WINDOW_MS };

  log(`POMS job postings crawl — postings dated ${since} or later, market year ${minYear} and later` +
      (pdfjsInstalled() ? '' : ' (pdfjs-dist is not installed: PDFs will not be read)') +
      (render ? '' : ' (--no-render: no browser for JavaScript pages)'));

  const page = await fetchPage(PAGE_URL);
  if (!page.ok) {
    err(`${PAGE_URL} could not be read (${page.error}) — nothing was queued. ` +
        'If this persists, the page has moved or the host refuses automation.');
    return 1;
  }
  const opps = parseOpportunities(page.html);
  if (!opps.length) {
    err('the POMS page was read but no posting table was found in it — its layout has changed; ' +
        'see parseOpportunities in _scraper/poms.mjs');
    return 1;
  }
  log(`${opps.length} posting(s) listed on the page, newest ${opps[0].date || '?'}`);

  const site = await readJson(JOBS_FILE, []);
  const sheet = await readJson(SHEET_FILE, []);
  const vocab = await readJson(VOCAB_FILE, null);
  const byCountry = campusCountries(await readJson(DIRECTORY_FILE, []));

  const queue = await loadQueue();
  if (!queue.ok) {
    warn(`the review queue is unreachable (${queue.error}) — nothing can be queued this run.`);
    /* --scan still says what WOULD be new against the served files alone */
    if (!SCAN) return 0;
  }

  const known = knownLinks({ docs: queue.docs, rows: [...(Array.isArray(site) ? site : []), ...(Array.isArray(sheet) ? sheet : [])] });
  const { fresh, skipped } = newOpportunities(opps, { since, minYear, known, now });
  const why = {};
  for (const s of skipped) why[s.why] = (why[s.why] || 0) + 1;
  log(`${fresh.length} new posting(s) to read` +
      (skipped.length ? `; ${skipped.length} skipped (${Object.entries(why).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''));
  for (const s of skipped.filter((x) => x.why === 'not-academic')) {
    log(`  - not an academic posting, left alone: ${s.opp.date}  ${s.opp.institution} — ${s.opp.title}`);
  }

  if (SCAN) {
    for (const o of fresh) log(`  ~ ${o.date}  ${o.institution} — ${o.title}\n      ${o.href} (${o.kind})`);
    log('--scan: fetched no advertisement, wrote nothing.');
    return 0;
  }

  /* what "already listed" means for the flags: the served postings, this
     queue's approved rows, and its pending ones (marked, so the card can say
     "under review" rather than "already published") */
  const approvedRows = queue.docs.filter((d) => d.status === APPROVED && d.row).map((d) => d.row);
  const pendingRows = queue.docs.filter((d) => d.status === PENDING && d.row)
    .map((d) => ({ ...d.row, _pending: true }));
  const listedNow = [...(Array.isArray(site) ? site : []), ...approvedRows];
  const compared = [...listedNow, ...pendingRows];

  const taken = new Set([
    ...queue.docs.map((d) => d.rowId),
    ...(Array.isArray(site) ? site : []).map((r) => r.id),
    ...(Array.isArray(sheet) ? sheet : []).map((r) => r.id),
  ].filter(Boolean));

  const col = queue.db ? queue.db.collection(REVIEW_COL) : null;
  let queued = 0, unread = 0, skippedIds = 0;

  for (const opp of fresh) {
    if (budget.left <= 0 || Date.now() > budget.until) {
      log('the read budget for this run is spent — the rest wait for the next run.');
      break;
    }
    budget.left--;
    const read = await safeRead(opp, { render });
    const { ad, block } = adForRow(read.parsed, read.via, { adUrl: opp.href, vocab, now });
    if (!ad) {
      unread++;
      warn(`${opp.institution} — ${opp.title}: the advertisement could not be read` +
           (read.error ? ` (${read.error})` : '') + '; queued with what the page said');
    }

    let row = rowFromOpportunity(opp, { ad, vocab, now });
    row = healCountry(row, byCountry);
    row = stripRowEmails(row);
    const id = uniqueId(row.id, taken);
    if (id !== row.id) row = { ...row, id };
    taken.add(id);

    /* the same advertisement already listed is never a decision to make —
       the link check above catches nearly all of these before the read */
    const repeat = advertRepeat(row, compared);
    if (repeat) {
      skippedIds++;
      log(`  x same advertisement as ${repeat.ref || repeat.id} — not queued: ${row.posted}  ${row.institution}`);
      await sleep(PACE_MS);
      continue;
    }

    let dup = duplicatesOf(row, compared);
    if (!dup.length) dup = nearbyPostings(row, compared);
    const biz = businessCheck(row, vocab);
    const doc = queueDoc(row, { now: isoStamp(now), dup, biz });
    doc.ad = block;

    log(`  ~ ${row.posted}  ${row.institution}${row.department ? ' — ' + row.department : ''}` +
        `  [${row.levels.join(', ')}; ${row.applyBy}${row.country ? '; ' + row.country : ''}]` +
        (dup.length ? `  ⚠ may repeat ${dup.map((d) => d.ref || d.id).join(', ')}` : '') +
        `  via ${read.via || 'nothing'}`);

    if (DRY) {
      log('    ' + JSON.stringify({ id, row: doc.row, ad: doc.ad, dup: doc.dup, biz: doc.biz }));
    } else if (col) {
      try {
        await col.doc(id).create(doc);
        queued++;
      } catch (e) {
        if (e && e.code === 6) { skippedIds++; log(`  = ${id} is already in the queue — left as it is`); }
        else warn(`could not queue ${id}: ${e.message}`);
      }
    }
    await sleep(PACE_MS);
  }

  /* ------------------------------------------ the flags on what is waiting */

  /* RE-CHECKED EVERY RUN, the sheet sync's own rule for its documents ("a flag
     appears when the duplicate is posted later and clears when it is taken
     down"): the sync's re-flag loop visits the workbook's documents alone and
     the second look below patches the reading and the row, so nothing ever
     moved `dup` or `biz` on a POMS document, and a card went on saying "still
     under review" of a posting approved a week earlier (the 2026-09-23
     review). Judged against the same set a fresh row is judged against, and
     written only where the flags moved: never the decision, never the edits,
     never the row. */
  let reflagged = 0;
  for (const d of queue.docs.filter((x) => x && x.status === PENDING && x.row && x.row.source === SOURCE)) {
    let dup = duplicatesOf(d.row, compared);
    if (!dup.length) dup = nearbyPostings(d.row, compared);
    const biz = businessCheck(d.row, vocab);
    const flags = {};
    if (!sameDups(dup, d.dup)) flags.dup = dup;
    if (!sameBiz(biz, d.biz)) flags.biz = biz;
    if (!Object.keys(flags).length) continue;
    reflagged++;
    if (DRY) {
      log(`  ${d.rowId}: would re-flag (${Object.keys(flags).join(', ')})`);
    } else if (col) {
      try {
        await col.doc(d.rowId).set(flags, { merge: true });
      } catch (e) {
        warn(`could not re-flag ${d.rowId}: ${e.message}`);
      }
    }
  }
  if (reflagged) log(`${DRY ? 'would re-flag' : 're-flagged'} ${reflagged} pending POMS posting(s) against what is listed now`);

  /* ----------------------------------------- a second look at what was unread */

  let refreshed = 0, retried = 0;
  for (const d of needReread(queue.docs, { today })) {
    if (budget.left <= 0 || Date.now() > budget.until) break;
    budget.left--;
    retried++;
    /* the link the maintainer corrected on the card, where they did; a
       block read from another link carries nothing forward */
    const link = effectiveLink(d);
    const opp = { href: link, kind: linkKind(link), title: '', institution: d.row.institution, date: d.row.posted };
    const read = await safeRead(opp, { render });
    const previous = d.ad && d.ad.url === link ? d.ad : null;
    const { ad, block } = adForRow(read.parsed, read.via, { adUrl: link, vocab, now, previous });
    const row = ad ? healCountry(refreshFromAd(d.row, ad, { vocab, now }), byCountry) : d.row;
    const patch = { ad: block };
    if (row !== d.row) patch.row = row;
    if (DRY) {
      log(`  ${d.rowId}: would ${ad ? 'record what the advertisement says' + (patch.row ? ' and fill the row' : '') : 'note another unreadable try'}`);
    } else if (col) {
      try {
        /* the row and the ad block only — never the decision, never the edits */
        await col.doc(d.rowId).set(patch, { merge: true });
        if (patch.row) refreshed++;
      } catch (e) {
        warn(`could not refresh ${d.rowId}: ${e.message}`);
      }
    }
    await sleep(PACE_MS);
  }

  const waiting = queue.docs.filter((d) => d.status === PENDING).length + (DRY ? 0 : queued);
  log((DRY ? `--dry-run: would have queued ${fresh.length - skippedIds} posting(s)` : `queued ${queued} posting(s) for review`) +
      (unread ? `, ${unread} with an advertisement that could not be read` : '') +
      (retried ? `; ${retried} earlier posting(s) had their advertisement tried again, ${refreshed} filled in` : '') + '.');
  if (waiting) log(`  ${waiting} posting(s) awaiting you at https://www.operationsacademia.org/admin-area`);
  return 0;
}

/* ----------------------------------------------------------------- selftest */

/** A one-page PDF holding `lines`, written by hand so the check needs no
    generator: a catalog, a page, a content stream of Tj operators in
    Helvetica, and an xref table. pdf.js reads it like any other. */
export function tinyPdf(lines) {
  const esc = (l) => l.replace(/[()\\]/g, '\\$&');
  const content = 'BT /F1 12 Tf 50 750 Td 14 TL ' + lines.map((l) => `(${esc(l)}) Tj T*`).join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const FIXTURE_HTML = `<table class="table views-table views-view-table cols-5">
<thead><tr class="table__row"><th class="views-field views-field-field-pos">Position</th></tr></thead>
<tbody class="table__body">
<tr class="table__row odd">
<td headers="view-field-pos-table-column" class="views-field views-field-field-pos views-align-left table__cell">Open Rank, Professional Track Faculty, Business Analytics          </td>
<td headers="view-field-position-university-table-column" class="views-field views-field-field-position-university views-align-left table__cell">Bucknell University          </td>
<td headers="view-field-position-date-table-column" class="views-field views-field-field-position-date views-align-left table__cell">09/22/2026          </td>
<td headers="view-views-conditional-field-table-column" class="views-field views-field-views-conditional-field table__cell"><a href="/sites/default/files/2026-09/9828288.pdf" target="_blank">View Posting</a>          </td>
<td class="views-field views-field-edit-node table__cell">          </td>
</tr>
<tr class="table__row even">
<td headers="view-field-pos-table-column" class="views-field views-field-field-pos views-align-left table__cell">Assistant or Associate Professor of Marketing and Supply Chain Management          </td>
<td headers="view-field-position-university-table-column" class="views-field views-field-field-position-university views-align-left table__cell">University of Oklahoma (OU)          </td>
<td headers="view-field-position-date-table-column" class="views-field views-field-field-position-date views-align-left table__cell">09/21/2026          </td>
<td headers="view-views-conditional-field-table-column" class="views-field views-field-views-conditional-field table__cell"><a href="https://apply.interfolio.com/193265">View Posting</a>          </td>
<td class="views-field views-field-edit-node table__cell">          </td>
</tr>
<tr class="table__row odd">
<td headers="view-field-pos-table-column" class="views-field views-field-field-pos views-align-left table__cell">Faculty of Business &amp;amp; Management          </td>
<td headers="view-field-position-university-table-column" class="views-field views-field-field-position-university views-align-left table__cell">VinUniversity          </td>
<td headers="view-field-position-date-table-column" class="views-field views-field-field-position-date views-align-left table__cell">04/07/2026          </td>
<td headers="view-views-conditional-field-table-column" class="views-field views-field-views-conditional-field table__cell"><a href="https://vinuni.talent.vn/job/faculty-of-business-management-8965?utm_source=referral&amp;amp;utm_campaign=x">View Posting</a>          </td>
<td class="views-field views-field-edit-node table__cell">          </td>
</tr>
<tr class="table__row even">
<td headers="view-field-pos-table-column" class="views-field views-field-field-pos views-align-left table__cell">Quality Control Manager - Base Ops &amp; Maint. (Stewart)          </td>
<td headers="view-field-position-university-table-column" class="views-field views-field-field-position-university views-align-left table__cell">Choctaw Global, Hinesville, Georgia          </td>
<td headers="view-field-position-date-table-column" class="views-field views-field-field-position-date views-align-left table__cell">09/02/2026          </td>
<td headers="view-views-conditional-field-table-column" class="views-field views-field-views-conditional-field table__cell"><a href="/sites/default/files/2026-09/286806130.pdf" target="_blank">View Posting</a>          </td>
<td class="views-field views-field-edit-node table__cell">          </td>
</tr>
</tbody></table>`;

export { FIXTURE_HTML };

async function selftest() {
  let pass = 0; const fails = [];
  const ok = (c, what) => { if (c) pass++; else fails.push(what); };
  const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`);
  const now = new Date('2026-09-23T12:00:00Z');

  /* ---- the page ---------------------------------------------------- */
  const opps = parseOpportunities(FIXTURE_HTML);
  eq(opps.length, 4, 'every row of the table is read, the header row is not');
  eq(opps[0].date, '2026-09-22', 'the date column (MM/DD/YYYY) is read as an ISO day');
  eq(opps[0].href, 'https://www.poms.org/sites/default/files/2026-09/9828288.pdf', 'a site-relative file becomes an absolute link');
  eq(opps[0].kind, 'pdf', '…and is known to be a PDF');
  eq(opps[1].institution, 'University of Oklahoma (OU)', 'the university cell, trailing spaces trimmed');
  eq(opps[2].title, 'Faculty of Business & Management', 'a double-encoded entity is decoded');
  ok(opps[2].href.includes('utm_campaign=x') && !opps[2].href.includes('&amp;'),
    'a double-encoded query string is decoded, so the link points somewhere');
  ok(isPomsUrl(opps[0].href) && !isPomsUrl(opps[1].href), 'isPomsUrl tells the page\'s own files apart');

  const fresh = newOpportunities(opps, { since: '2026-09-01', minYear: 2026, known: new Set(), now });
  eq(fresh.fresh.map((o) => o.institution), ['Bucknell University', 'University of Oklahoma (OU)'],
    'within the window, academic, unknown: queued; the contractor\'s vacancy and April\'s row are not');
  eq(fresh.skipped.map((s) => s.why).sort(), ['before-window', 'not-academic'], 'and each skip says why');
  ok(privateAddress('169.254.169.254') && privateAddress('127.0.0.1') && !privateAddress('8.8.8.8'),
    'a private or link-local address is one the runner never fetches');
  ok(!(await hostAllowed('localhost')) && (await hostAllowed('example.edu', { lookup: async () => [{ address: '93.184.216.34' }] })),
    'and a host is fetched only when every address it resolves to is public');

  /* ---- the reader, when the engine is here ------------------------- */
  const want = process.env.POMS_REQUIRE_PDF === '1';
  if (pdfjsInstalled() || want) {
    const lines = ['Assistant Professor of Operations Management',
      'Department of Supply Chain Management, Smith School of Business',
      'Application deadline: October 15, 2026',
      'Location: Norman, OK'];
    const t = await pdfText(tinyPdf(lines));
    ok(t.ok, `a hand-built PDF is read (${t.error || 'ok'})`);
    ok(/Application deadline: October 15, 2026/.test(t.text), 'with its lines in reading order');
    const p = parseAdvertText(t.text);
    eq(p.applyByDate, '2026-10-15', 'and the text reader finds the labelled deadline in it');
    eq(p.department, 'Supply Chain Management', 'the department the prose names');
    eq(p.school, 'Smith School of Business', 'and the school beside it');
    eq(p.institution, '', 'the institution is not read off a labelled line (the 2026-09-23 review: it read "Application deadline")');
    eq(p.country, 'United States', 'and the country of a US town with its state');
    ok(!looksLikePdf(Buffer.from('<html>')), 'HTML is not a PDF');
    const slow = await pdfText(tinyPdf(lines), { timeoutMs: 1 });
    ok(!slow.ok && /timed out/.test(slow.error), 'and a PDF that outruns its clock is unreadable rather than a run that never ends');
  } else {
    log('pdfjs-dist is not installed here — the PDF round trip is checked where it is (the workflow).');
  }
  eq(linesFromItems([
    { str: 'Second', transform: [1, 0, 0, 1, 50, 700], width: 40 },
    { str: 'First', transform: [1, 0, 0, 1, 50, 720], width: 30 },
    { str: 'line', transform: [1, 0, 0, 1, 92, 720], width: 20 },
    { str: 'ing', transform: [1, 0, 0, 1, 80.5, 720], width: 3 },
  ]), ['Firsting line', 'Second'], 'glyph runs on one baseline join into a line, apart runs get a space, lines read top down');

  /* ---- the row ------------------------------------------------------ */
  const row = rowFromOpportunity(opps[1], { ad: null, vocab: null, now });
  ok(row.id === '2027-university-of-oklahoma-ou-20260921' || /^2027-university-of-oklahoma/.test(row.id),
    'the id is the season, the university and the day');
  eq(row.source, SOURCE, 'stamped with the POMS source');
  eq(row.postedAtUrl, PAGE_URL, 'and posted-at is the page');
  ok(row.levels.every((l) => LEVELS.includes(l)) && (!row.type || TYPES.includes(row.type)),
    'levels and type are ones the site knows');
  ok(Object.keys(row).every((k) => PUBLIC_FIELDS.includes(k)), 'nothing but published fields');
  ok(/Advertised as: Assistant or Associate Professor/.test(row.comments) && /could not be read/.test(row.comments),
    'an unread advertisement is said in the comments');
  eq(row.applyBy, 'Until filled.', 'and the deadline is open-ended, never invented');

  /* ---- what a run may write, read from this file's own source ------- */
  const src = (await readFile(fileURLToPath(import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(/col\.doc\(id\)\.create\(doc\)/.test(src), 'a new posting is CREATED, never set — a decision made mid-run wins');
  ok(!/\.update\(/.test(src) && !/\.delete\(/.test(src), 'nothing is updated or deleted');
  eq((src.match(/\.set\(/g) || []).length, 2, 'two merges: a pending document\'s row and ad block, and its flags');
  ok(/const patch = \{ ad: block \};/.test(src) && /patch\.row = row;/.test(src) && !/patch\.status/.test(src) && !/patch\.edits/.test(src),
    '…and that merge carries the row and the ad, never the decision or the edits');
  ok(!/writeFile\(/.test(src), 'this run writes no file');
  ok(/if \(DRY\)/.test(src) && src.indexOf('if (DRY)') < src.indexOf('col.doc(id).create(doc)'),
    'a dry run prints instead of creating');

  console.log(fails.length
    ? `poms-crawl selftest: ${pass} passed, ${fails.length} FAILED\n  ` + fails.join('\n  ')
    : `poms-crawl selftest: ${pass} checks passed.`);
  return fails.length === 0;
}

if (isMain(import.meta.url)) {
  if (has('--selftest')) {
    process.exit((await selftest()) ? 0 : 1);
  } else {
    try {
      process.exit(await main());
    } catch (e) {
      err(`the crawl failed: ${e.stack || e.message}`);
      process.exit(1);
    }
  }
}
