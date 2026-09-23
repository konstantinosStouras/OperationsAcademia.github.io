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

import { isoStamp, marketFloor, LEVELS, TYPES, PUBLIC_FIELDS, stripRowEmails } from './jobs-model.mjs';
import { firestore } from './_mail.mjs';
import {
  COLLECTION as REVIEW_COL, PENDING, APPROVED, queueDoc, duplicatesOf, businessCheck,
  advertRepeat,
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
const LIMIT = Math.max(1, Number(opt('--limit', '40')) || 40);
/* How long the fetching may run before the run stops reading and writes
   what it has — the adverts pass's own clock, for its reason: LIMIT reads,
   each paced, each with retries of a long timeout, can outrun the workflow's
   thirty minutes, and a run killed by its cap has read for nothing. */
const READ_WINDOW_MS = Math.max(60_000, Number(opt('--read-window-ms', '')) || 20 * 60_000);
const PACE_MS = 1500;

const UA = 'operationsacademia.org posting check (+https://www.operationsacademia.org)';

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));
const err = (...a) => console.log('::error::' + a.join(' '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------- network */

/** One GET for BYTES, with a timeout and two retries — the sibling of
    adverts-verify's fetchOnce, which reads text and so cannot carry a PDF.
    A failure returns rather than throws: an advertisement that cannot be
    read is a posting queued with less, never a run that stops. */
export async function fetchBytes(u, { accept = '*/*', tries = 3, timeoutMs = 45000 } = {}) {
  let last = '';
  for (let i = 1; i <= tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(u, {
        redirect: 'follow', signal: ctl.signal,
        headers: { 'user-agent': UA, accept },
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      const type = String(res.headers.get('content-type') || '');
      if (res.ok) return { ok: true, bytes, type, status: res.status, error: '' };
      last = `HTTP ${res.status}`;
      if (res.status === 404 || res.status === 410) return { ok: false, gone: true, bytes, type, status: res.status, error: last };
      if (res.status === 403 || res.status === 401) return { ok: false, bytes, type, status: res.status, error: last };
    } catch (e) {
      last = e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message;
    } finally {
      clearTimeout(timer);
    }
    if (i < tries) await sleep(1500 * i);
  }
  return { ok: false, bytes: Buffer.alloc(0), type: '', status: 0, error: last || 'unknown error' };
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

/** The pending POMS documents whose advertisement is still to be read: no
    block, or one that says unreadable, and a last try older than the TTL. */
export function needReread(docs, { today = '', ttlDays = READ_TTL_DAYS } = {}) {
  return (docs || []).filter((d) => d && d.status === PENDING && d.row && d.row.source === SOURCE
    && d.row.adUrl && linkKind(d.row.adUrl) !== 'doc'
    && (!d.ad || d.ad.status === 'unreadable')
    && (!(d.ad && d.ad.checkedAt) || daysApart(d.ad.checkedAt, today) >= ttlDays));
}

/** What the advertisement said, in the two forms the run needs: the parse
    with its classification for the row builder, and the block the document
    carries. `null` for the row when the reading is not usable. */
function adForRow(parsed, via, { adUrl, vocab, now, previous = null }) {
  const entry = cacheEntry(parsed || parseAdvertText(''), { adUrl, checkedAt: isoStamp(now), previous, via: via || 'page' });
  const place = parsed && parsed.ok && vocab ? advertPlace(entry, vocab) : null;
  const block = adBlock(entry, { adUrl, place });
  const ad = parsed && parsed.ok ? { ...parsed, via, place } : null;
  return { ad, block };
}

async function main() {
  const now = new Date();
  const today = isoStamp(now).slice(0, 10);
  const since = /^\d{4}-\d{2}-\d{2}$/.test(opt('--since', '')) ? opt('--since') : sinceDay(now, WINDOW_DAYS);
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
    const read = await readOpportunityAd(opp, { render });
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

  /* ----------------------------------------- a second look at what was unread */

  let refreshed = 0, retried = 0;
  for (const d of needReread(queue.docs, { today })) {
    if (budget.left <= 0 || Date.now() > budget.until) break;
    budget.left--;
    retried++;
    const opp = { href: d.row.adUrl, kind: linkKind(d.row.adUrl), title: '', institution: d.row.institution, date: d.row.posted };
    const read = await readOpportunityAd(opp, { render });
    const { ad, block } = adForRow(read.parsed, read.via, { adUrl: d.row.adUrl, vocab, now, previous: d.ad || null });
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
    eq(p.country, 'United States', 'and the country of a US town with its state');
    ok(!looksLikePdf(Buffer.from('<html>')), 'HTML is not a PDF');
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
  eq((src.match(/\.set\(/g) || []).length, 1, 'one merge, on a pending document\'s row and ad block');
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
