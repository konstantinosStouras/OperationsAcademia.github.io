#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — read the job market tracking sheet, every day.

       the tracking workbook  ->  THIS  ->  data/jobmarket.json
                                                 |
                          build-jobs.mjs merges it beside the Firestore
                          postings  ->  data/jobs.json  ->  the jobs page

   Run by .github/workflows/oa-jobmarket-sheet.yml. What it does, in order:

     1. reads the workbook's HTML view once, for its TAB NAMES and for any
        link to ANOTHER workbook (the intro tab's pointer at next year's
        sheet, which the CSV export cannot see because it is a hyperlink on
        ordinary text);
     2. fetches each year tab as CSV and maps it to published rows;
     3. writes data/jobmarket.json, its meta file, and the registry of known
        workbooks — rolling `current` on to the successor once that successor
        is actually carrying the market;
     4. e-mails the maintainer when the sheet has gone quiet, or cannot be
        read at all.

   THREE RULES ABOUT WRITING, each of which exists because the opposite loses
   data:

     - IF ANY WORKBOOK IN SCOPE COULD NOT BE READ, NOTHING IS WRITTEN. Rows
       are removed from the site by being absent from this file, so a failed
       fetch that still wrote would delete every posting that workbook holds.
     - A READ THAT COMES BACK SUSPICIOUSLY SMALL IS REFUSED (see SHRINK_FLOOR).
       Google answers an unshared sheet with a sign-in page rather than an
       error, and a "successful" read of nothing looks exactly like a sheet
       that was emptied.
     - THE DATASET IS WRITTEN BEFORE THE REGISTRY IS ROLLED, so a run that
       dies in between simply repeats itself. Nothing here is destructive.

   Modes:
     --scan          report what would be read, fetch nothing, write nothing
     --dry-run       do everything, print the diff, write nothing
     --no-mail       never send the warning e-mail (it is printed instead)
     --sheet <id>    read this workbook instead of the registry's
     --min-year <n>  the oldest MARKET year to keep (default: marketFloor())
     --selftest      offline checks, no network, no credentials

   NOTE. This build environment's egress blocks docs.google.com (403), so a
   real read only happens on the GitHub Actions runners — the same situation
   as the scholarly APIs in the sibling repositories.
   --------------------------------------------------------------------------- */

import { isMain } from './_main.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  marketFloor, isoStamp, healPlace, healReviewDate, stripRowEmails, withMarketYears,
} from './jobs-model.mjs';
import {
  SEED_SHEET_ID, STALE_DAYS, STALE_REPEAT_DAYS,
  sheetCsvUrl, sheetHtmlUrl, sheetEditUrl, sheetId,
  tabsFromHtml, sheetIdsFromHtml, classifyTab, isIntroTab, conventionalTabs,
  rowsFromTab, collectRows, stampAddedAt, carryUnreadColumns, serialiseSheetRows, buildSheetMeta,
  stalenessOf, shouldWarn, emptyRegistry, adoptSheets, activeSheets, rollRegistry,
} from './jobmarket-sheet.mjs';
import { applyVerified, emptyCache } from './higheredjobs.mjs';
import { applyAdverts, emptyCache as emptyAdvertsCache } from './adverts.mjs';
import {
  COLLECTION as REVIEW_COL, partition, needMail, PENDING, REJECTED,
  duplicatesOf, sameDups, businessCheck, sameBiz,
  advertRepeat, findAdvertRepeats, repeatNote,
} from './jobreview.mjs';
import { fillSchoolFromDirectory, campusCountries, healCountry } from './vocab.mjs';
import { shell, esc, send, transport, toPlain, firestore, SITE, CONTACT } from './_mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const ROWS_FILE = path.join(DATA, 'jobmarket.json');
const META_FILE = path.join(DATA, 'jobmarket-meta.json');
const REG_FILE = path.join(DATA, 'jobmarket-sheets.json');
const VERIFIED_FILE = path.join(DATA, 'higheredjobs.json');
const ADVERTS_FILE = path.join(DATA, 'adverts.json');
/* The postings the site is showing, whatever their source — what a crawled
   row is checked against for DUPLICATES before the maintainer is asked about
   it. Read leniently: no file just means no flags, never a failed run. */
const JOBS_FILE = path.join(DATA, 'jobs.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const DRY = has('--dry-run');
const SCAN = has('--scan');
const NO_MAIL = has('--no-mail');

/** A read returning less than this share of what is already committed is
    refused. Postings are added far more often than removed, and a workbook
    losing half its rows overnight is a broken read, not an edit. */
const SHRINK_FLOOR = 0.5;

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));
const err = (...a) => console.log('::error::' + a.join(' '));

/* ------------------------------------------------------------------ network */

const UA = 'operationsacademia.org job-market sheet sync (+https://www.operationsacademia.org)';

/** One GET, with a timeout and two retries. Google occasionally answers a
    burst of tab requests with a 429 or a 500; a run that gave up on the first
    would look exactly like a sheet that had gone quiet. */
async function fetchText(url, { tries = 3, timeoutMs = 30000 } = {}) {
  let last = '';
  for (let i = 1; i <= tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': UA },
      });
      const body = await res.text();
      if (res.ok) return { ok: true, body, status: res.status };
      last = `HTTP ${res.status}`;
      // a missing tab is a 400 and will never succeed — do not retry it
      if (res.status === 400 || res.status === 404) return { ok: false, body, error: last };
    } catch (e) {
      last = e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message;
    } finally {
      clearTimeout(timer);
    }
    if (i < tries) await sleep(1500 * i);
  }
  return { ok: false, body: '', error: last || 'unknown error' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One tab as CSV.
 *
 * Google answers a workbook that is not shared with a sign-in PAGE and HTTP
 * 200, so the body has to be inspected as well as the status — otherwise an
 * unshared sheet reads as a sheet with no postings, which is the difference
 * between "tell the maintainer" and "delete everything".
 */
async function fetchCsv(id, tab) {
  const got = await fetchText(sheetCsvUrl(id, tab));
  if (!got.ok) return got;
  if (/^\s*</.test(got.body)) {
    return { ok: false, body: '', error: 'Google returned a web page rather than CSV — ' +
      'the workbook is not readable by anyone with the link' };
  }
  return got;
}

/* ------------------------------------------------------------ review queue */

/**
 * What the maintainer has already decided about, from Firestore.
 *
 * `{ ok, db, docs, error }`. `ok` is false when there is no database to ask —
 * no credentials, or a read that failed — and the caller then leaves the
 * published file untouched rather than guessing in either direction.
 */
async function loadReviewQueue() {
  let db;
  try {
    db = await firestore();
  } catch (e) {
    return { ok: false, db: null, docs: [], error: e.message };
  }
  if (!db) {
    return { ok: false, db: null, docs: [],
             error: 'no Firebase credentials in this environment' };
  }
  try {
    const snap = await db.collection(REVIEW_COL).get();
    return { ok: true, db, docs: snap.docs.map((d) => d.data()), error: '' };
  } catch (e) {
    return { ok: false, db: null, docs: [], error: e.message };
  }
}

/**
 * Put newly-found postings into the queue, and bring already-queued ones up to
 * date with the sheet.
 *
 * Written one document at a time with `set(..., { merge: true })` on the
 * refresh path, so a maintainer editing a posting in the browser while this
 * runs cannot have their decision overwritten by a sheet re-read — `refreshQueued`
 * only ever carries the `row`, never `status` or `edits`.
 */
async function writeQueue(db, split, reflag = []) {
  const col = db.collection(REVIEW_COL);
  let queued = 0, refreshed = 0, reflagged = 0;

  for (const doc of split.queue) {
    /* create(), not set(): if a document appeared since the read above — the
       maintainer approving something mid-run — this must not overwrite their
       decision with a fresh `pending`. */
    try {
      await col.doc(doc.rowId).create(doc);
      queued++;
    } catch (e) {
      if (e && e.code === 6) continue;      // ALREADY_EXISTS: theirs wins
      warn(`could not queue ${doc.rowId}: ${e.message}`);
    }
  }

  for (const doc of split.refresh) {
    try {
      await col.doc(doc.rowId).set({ row: doc.row }, { merge: true });
      refreshed++;
    } catch (e) {
      warn(`could not refresh ${doc.rowId}: ${e.message}`);
    }
  }

  /* The flags on already-queued postings — `dup` and `biz` — kept true
     against the site and the sheet: a posting taken down clears its duplicate
     flag on the next sync, one newly made through the form raises it, and a
     row that gains or loses its business-school evidence moves its flag with
     it. Only the flag fields are written, and only where they changed —
     never the decision, never the edits. */
  for (const { rowId, patch } of reflag) {
    try {
      await col.doc(rowId).set(patch, { merge: true });
      reflagged++;
    } catch (e) {
      warn(`could not re-flag ${rowId}: ${e.message}`);
    }
  }

  if (queued) log(`queued ${queued} posting(s) for review`);
  if (refreshed) log(`${refreshed} queued posting(s) caught up with the sheet`);
  if (reflagged) log(`${reflagged} queued posting(s) had their flags brought up to date`);
}

/**
 * Drop postings ALREADY in the queue that advertise a vacancy already listed.
 *
 * A fresh crawled repeat is refused in the document that would have created it
 * (`create()` below writes it already rejected); one that has been WAITING has
 * a document of its own, so it is moved out of PENDING here.
 *
 * IN A TRANSACTION, and only from PENDING. Every other write in this file is
 * careful never to overwrite a decision made in the browser while the run was
 * in flight — `refreshQueued` carries only the `row`, the re-flags only the
 * flag fields — and this one writes a DECISION, so it has to check first. A
 * posting the maintainer approved a second ago is theirs, and is left alone.
 */
async function rejectRepeats(db, rejects) {
  const col = db.collection(REVIEW_COL);
  let n = 0;
  for (const { rowId, patch } of rejects) {
    const ref = col.doc(rowId);
    try {
      const wrote = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        if (((snap.data() || {}).status || '') !== PENDING) return false;
        tx.set(ref, patch, { merge: true });
        return true;
      });
      if (wrote) n++;
    } catch (e) {
      warn(`could not drop ${rowId}: ${e.message}`);
    }
  }
  if (n) log(`${n} posting(s) under review dropped as one advertisement twice`);
  return n;
}

/* -------------------------------------------------------------------- files */

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    warn(`could not parse ${path.basename(file)} (${e.message}) — starting from empty`);
    return fallback;
  }
}

/** The committed rows, strictly: an unreadable dataset must stop the run
    rather than stand in for an empty one, because "empty" here means every
    sheet-sourced posting is re-stamped as new and re-announced by e-mail. */
async function readRowsStrict() {
  if (!existsSync(ROWS_FILE)) return [];
  const rows = JSON.parse(await readFile(ROWS_FILE, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('data/jobmarket.json is not an array');
  return rows;
}

/** The verified-advertisement cache, or an empty one. Unlike the dataset
    above this is READ LENIENTLY: it is an enrichment, and a missing or
    malformed cache must leave the sheet's own rows untouched rather than stop
    the read of the workbook. */
async function readVerifiedCache() {
  try {
    const cache = JSON.parse(await readFile(VERIFIED_FILE, 'utf8'));
    return (cache && cache.ads) ? cache : emptyCache();
  } catch {
    return emptyCache();
  }
}

/** Its sibling for every OTHER advertisement host — data/adverts.json,
    written by adverts-verify.mjs. Read just as leniently, for the same
    reason. */
async function readAdvertsCache() {
  try {
    const cache = JSON.parse(await readFile(ADVERTS_FILE, 'utf8'));
    return (cache && cache.ads) ? cache : emptyAdvertsCache();
  } catch {
    return emptyAdvertsCache();
  }
}

/* ------------------------------------------------------------ one workbook */

/**
 * Read one workbook: its tabs, its rows, and any other workbook it links to.
 *
 * Returns `{ ok, id, rows, tabs, links, newestPosted, notes, error }`. `ok` is
 * false only when the workbook itself could not be reached — a single tab that
 * fails is noted and skipped, because a renamed tab must not take the rest of
 * the season down with it.
 */
async function readWorkbook(id, { minYear, now }) {
  const notes = [];
  const page = await fetchText(sheetHtmlUrl(id));

  let tabs = [];
  let links = [];
  if (page.ok && !/accounts\.google\.com|ServiceLogin/.test(page.body.slice(0, 4000))) {
    tabs = tabsFromHtml(page.body);
    links = sheetIdsFromHtml(page.body, { exclude: [id] });
  } else {
    notes.push(`the HTML view could not be read (${page.error || 'sign-in page'}) — ` +
               'falling back to the conventional tab names');
  }

  /* Which tabs to fetch. A tab is named for the year the cycle OPENS, and a
     cycle that opens in year Y is the site's market year Y+1 — so the oldest
     tab worth reading is one year behind the oldest market year in scope. */
  const minTabYear = minYear - 1;
  const wanted = [];
  for (const t of tabs) {
    const c = classifyTab(t.name);
    if (c && c.year >= minTabYear) wanted.push({ name: t.name, ...c });
  }

  if (!wanted.length) {
    // no readable tab strip, or a strip whose names we did not recognise
    const years = [];
    for (let y = minTabYear; y <= now.getUTCFullYear() + 1; y++) years.push(y);
    for (const name of conventionalTabs(years)) {
      const c = classifyTab(name);
      if (c) wanted.push({ name, ...c, guessed: true });
    }
    if (tabs.length) {
      notes.push(`none of this workbook's ${tabs.length} tab(s) is named for a year ` +
                 `(${tabs.map((t) => t.name).slice(0, 8).join(', ')}) — trying the usual names`);
    }
  }

  const perTab = [];
  const dead = [];
  let readAny = false;

  for (const t of wanted) {
    const got = await fetchCsv(id, t.name);
    if (!got.ok) {
      // a guessed name that does not exist is expected, not a problem
      if (!t.guessed) notes.push(`tab "${t.name}": ${got.error}`);
      continue;
    }
    readAny = true;
    const out = rowsFromTab(got.body, {
      /* A tab is named for the year its cycle OPENS, and a cycle opening in
         year Y is the site's market year Y+1 — the same arithmetic minTabYear
         does above, read the other way round. */
      tab: t.name, kind: t.kind, sheetId: id, minYear, cycleYear: t.year + 1,
    });
    perTab.push({ tab: t.name, kind: t.kind, ...out });

    if (out.missing.length) {
      notes.push(`tab "${t.name}": no institution/date columns could be found — ` +
                 'the tab was read but nothing in it could be used');
    }
    for (const r of out.repaired || []) {
      notes.push(`tab "${t.name}": its ${r.field} column is headed "${r.header}", which ` +
                 `names something else — column ${r.at + 1} was read as the ${r.field} ` +
                 'from its own rows instead');
    }

    /* A TAB THAT HOLDS ROWS AND YIELDS NO POSTING IS A FAULT, not a quiet
       tab. This is the state that hid for four months: "2026 Jobs" reported
       0 postings and 94 skipped rows every morning, in a log nobody reads,
       while the site showed none of the season's jobs. It is an error
       annotation AND a reason to write, below.

       SKIPPED ROWS ARE THE SIGNAL, because they are what says the tab had
       something in it: a row was recognisable as a posting and could not be
       used. A tab whose columns are unrecognisable reports no skips at all,
       and when its NAME was guessed — the tab strip could not be read, so the
       usual names are tried and most do not exist — that is the expected
       state, not a fault. Flagging those would e-mail the maintainer every
       half hour about "2027 NTT-PD", a tab nobody has ever made. */
    if (!out.rows.length && (out.skipped || (out.missing.length && !t.guessed))) {
      dead.push({ tab: t.name, skipped: out.skipped });
    }
    for (const u of out.unmapped) {
      notes.push(`tab "${t.name}": column "${u.header}" is not one this pipeline knows ` +
                 '(its values are ignored)');
    }
    if (out.unlinked) {
      notes.push(`tab "${t.name}": ${out.unlinked} row(s) hold something in the link ` +
                 'column that is not a plain URL (a hyperlink on text exports as its ' +
                 'label, so paste the address itself)');
    }
    log(`  ${id.slice(0, 8)}… "${t.name}": ${out.rows.length} posting(s)` +
        (out.inferred ? ' (columns inferred — no header row was recognised)' : '') +
        (out.skipped ? `, ${out.skipped} row(s) skipped` : ''));
  }

  /* The workbook is only "unreadable" when NOTHING came back: neither its HTML
     nor a single tab. That is the state that must never write. */
  if (!readAny) {
    return { ok: false, id, rows: [], tabs: tabs.map((t) => t.name), links, newestPosted: '',
             notes, dead, error: page.ok ? 'no tab could be read' : (page.error || 'unreachable') };
  }

  const rows = [].concat(...perTab.map((p) => p.rows));
  return {
    ok: true, id, rows, links, notes, dead,
    tabs: (wanted.length ? wanted : tabs).map((t) => t.name),
    /* how each tab was read — carryUnreadColumns needs to know which tabs
       fell to whole-tab inference and which columns that inference claimed */
    tabReads: perTab.map((p) => ({
      sheet: id, tab: p.tab, inferred: !!p.inferred, columns: p.columns || [],
    })),
    newestPosted: rows.reduce((m, r) => (r.posted > m ? r.posted : m), ''),
  };
}

/* --------------------------------------------------------------- the e-mail */

export function renderStaleEmail(check, { sheets = [], now = new Date() } = {}) {
  const links = sheets.map((id) =>
    `<li><a href="${esc(sheetEditUrl(id))}">${esc(id)}</a></li>`).join('\n');

  const why = {
    quiet: `The job market sheet has had no new posting for <strong>${check.days} days</strong>
            (the newest is dated ${esc(check.newestPosted || 'unknown')}). Either the market
            really is quiet, or the sheet has stopped being updated.`,
    unreadable: `The job market sheet could <strong>not be read at all</strong>:
                 <em>${esc(check.detail)}</em>. The usual cause is that its sharing was
                 changed — it has to be readable by anyone with the link.`,
    empty: `The job market sheet was read, but <strong>no posting could be taken from it</strong>.
            Its tabs may have been renamed, or its columns rearranged.`,
    'unread-tab': `The job market sheet is being updated, but
            <strong>${esc((check.tabs || []).join(', '))}</strong> gave no posting at all.
            The usual cause is a column heading: the pipeline finds the school and the
            date by name, and a tab that heads one of them differently — or that has had
            a column inserted above its headings — reads as empty however full it is.
            Everything on the other tabs is unaffected.`,
    undated: `The job market sheet was read, but <strong>no posting in it carries a usable
              date</strong>, and a posting without one cannot be published.`,
  }[check.reason] || esc(check.detail);

  const body = `
<p>Hello,</p>
<p>${why}</p>
<p>Until this is sorted out, no new postings from the sheet will reach
   <a href="${esc(SITE)}/jobs">${esc(SITE.replace(/^https?:\/\//, ''))}/jobs</a>.
   Everything already published stays exactly as it is — nothing is removed.</p>
<p>The workbook${sheets.length === 1 ? '' : 's'} being read:</p>
<ul>${links}</ul>
<p style="color:#666;font-size:13px;">
  Checked ${esc(now.toISOString().slice(0, 16).replace('T', ' '))} UTC.
  You will not get this message again for ${STALE_REPEAT_DAYS} days unless something
  different goes wrong. To change how patient it is, set
  <code>JOBMARKET_STALE_DAYS</code> (currently ${STALE_DAYS}) on the workflow.</p>`;

  const subject = check.reason === 'quiet'
    ? `The job market sheet has had nothing new for ${check.days} days`
    : 'The job market sheet could not be read';

  return { subject, html: shell({ title: subject, bodyHtml: body }) };
}

/* --------------------------------------------------------------------- main */

async function main() {
  const now = new Date();
  const minYear = Number(opt('--min-year', '')) || marketFloor(now);

  const registry = await readJson(REG_FILE, emptyRegistry());
  registry.sheets = registry.sheets || [];
  if (!registry.current) registry.current = SEED_SHEET_ID;

  const forced = sheetId(opt('--sheet', ''));
  if (forced) {
    adoptSheets(registry, [forced], { from: '', now });
    registry.current = forced;
  }

  const scope = has('--all-sheets')
    ? registry.sheets.map((s) => s.id)
    : activeSheets(registry);

  log(`job market sheet sync — market year ${minYear} and later, ` +
      `${scope.length} workbook(s) in scope`);
  for (const id of scope) log(`  ${id}  ${sheetEditUrl(id)}`);

  if (SCAN) {
    log('--scan: nothing was fetched.');
    return;
  }

  /* ------------------------------------------------------------- read them */

  const results = [];
  for (const id of scope) {
    const r = await readWorkbook(id, { minYear, now });
    results.push(r);
    for (const n of r.notes) warn(`${id.slice(0, 8)}…: ${n}`);

    const entry = registry.sheets.find((s) => s.id === id);
    if (entry && r.ok) {
      entry.lastReadAt = isoStamp(now);
      entry.rows = r.rows.length;
      entry.newestPosted = r.newestPosted;
      entry.tabs = r.tabs;
    }

    // the chain: whatever this workbook links to becomes known
    const added = adoptSheets(registry, r.links || [], { from: id, now });
    for (const a of added) {
      log(`  found a workbook this one links to: ${a.id}`);
      log(`    ${sheetEditUrl(a.id)}`);
    }
  }

  const failed = results.filter((r) => !r.ok);

  /* Tabs that were read and gave nothing. Loud, because the alternative is
     what actually happened: a season's worth of postings missing from the
     site with nothing anywhere saying so. */
  const dead = [].concat(...results.map((r) => (r.dead || [])
    .map((d) => ({ ...d, sheet: r.id }))));
  for (const d of dead) {
    err(`tab "${d.tab}" was read but yielded NO posting` +
        (d.skipped ? ` — all ${d.skipped} of its rows were skipped` : '') +
        '. Its columns have probably been renamed; see the warnings above.');
  }

  const existing = await readRowsStrict();

  /* ------------------------------------------------- decide whether to write

     A failed read is the dangerous case: a posting leaves the site by being
     ABSENT from this file, so writing a partial read would take down every
     posting the unread workbook holds. */
  let wrote = false;
  let rows = existing;
  let sheetRows = [];
  let fresh = 0;

  if (failed.length) {
    err(`${failed.length} of ${results.length} workbook(s) could not be read — ` +
        'the dataset was left exactly as it is.');
    for (const f of failed) err(`  ${f.id}: ${f.error}`);
  } else {
    const collected = collectRows(results.map((r) => ({ rows: r.rows })));
    if (collected.collapsed) {
      log(`${collected.collapsed} row(s) were the same posting listed twice — collapsed.`);
    }

    if (existing.length >= 10 && collected.rows.length < existing.length * SHRINK_FLOOR) {
      err(`the sheet now yields ${collected.rows.length} postings where the committed file ` +
          `holds ${existing.length} — refusing to write. Read the log above: a tab has ` +
          'probably been renamed, or the workbook\'s sharing changed.');
      failed.push({ id: registry.current, error: 'the read came back suspiciously small' });
    } else {
      /* The review queue is read BEFORE the rows are dated, because it is
         half of the answer to "have we seen this posting before".

         `stampAddedAt` gives a row the date it first appeared, and takes its
         baseline from what is already published. With the gate in place that
         baseline is the APPROVED file, which a posting under review is by
         definition not in — so a queued posting would be re-dated every
         morning, and once the file is empty (the state the gate starts in)
         every row would read as new on every run. The queue's own copy of the
         row carries the date it was first seen, so the two together are the
         real "already known" set. */
      const queue = await loadReviewQueue();
      const known = existing.concat(
        (queue.docs || []).map((d) => d.row).filter((r) => r && r.id));

      /* A TAB READ WITHOUT ITS HEADER MUST NOT UN-SAY WHAT THE HEADER SAID.
         The workbook is edited live, and a read that catches a tab mid-edit
         can fail to recognise its header row and fall to whole-tab inference
         — which structurally cannot see the deadline cell or the notes
         column. On 2026-09-01 exactly that published eight postings'
         deadlines back to "Until filled." for one run and e-mailed the
         maintainer an "edit" for each. A column the read could not find
         changes nothing: those fields are carried from what the site already
         knows — the committed file, or the queue's own copy of a pending row
         (carryUnreadColumns in jobmarket-sheet.mjs, where the read rules
         live). LOUD, because a degraded read the log never names is how the
         last one went out as eight phantom edits. */
      const tabReads = [].concat(...results.map((x) => x.tabReads || []));
      const carriedBack = carryUnreadColumns(collected.rows, known, tabReads);
      if (carriedBack.carried.length) {
        const tabsHit = [...new Set(carriedBack.carried.map((c) => c.tab))].join('", "');
        warn(`tab "${tabsHit}": read without its header (columns inferred) — ` +
             `${carriedBack.carried.length} posting(s) kept their deadline/notes ` +
             'from the previous read instead of losing them to a read that ' +
             'cannot see those columns');
      }

      /* THE SCHOOL THE WORKBOOK NEVER NAMED. Its hiring-unit column holds the
         department — the more specific of the two, and the one the advert
         names — so fifteen of its sixteen postings arrived with a department
         and no school: "University of California, Berkeley" and "Operations
         and Information Technology Management", with Haas missing. The site's
         own Universities directory already says which department sits in which
         school, and `fillSchoolFromDirectory` asks it. Only where the school is
         empty, only where the answer is unambiguous, and only from a name the
         site already publishes — see vocab.mjs.

         AFTER the same-day collapse, deliberately: making two postings' names
         agree can turn them into one, and this is a naming change. Applied
         before it, a row that gained a school could fold onto a sibling that
         had one all along, which is a row count moving for a reason nobody
         asked for. */
      const vocab = await loadVocab();
      let filled = 0;
      const placed = vocab
        ? carriedBack.rows.map((r) => {
          const out = fillSchoolFromDirectory(r, vocab);
          if (out !== r) filled++;
          return out;
        })
        : carriedBack.rows;
      if (filled) {
        log(`${filled} posting(s) gained the school their department sits in, ` +
            'from the site\'s own Universities directory');
      }

      /* AND THE COUNTRY THE UNIVERSITY IS ACTUALLY IN. Same authority, same
         discipline: every row of the Universities directory carries the
         campus's postal address, `campusCountries` turns that into one answer
         per university, and a row contradicting it is corrected. build-jobs
         already heals the merged set — but `data/jobmarket.json` is a SERVED
         file in its own right and the country drives the jobs page's Location
         filter, so a wrong one here files a posting under a place it has
         nothing to do with. A university whose directory rows disagree (INSEAD
         is in France and in Singapore) has no answer and is never healed. */
      const byCountry = campusCountries(await loadDirectory());
      let recountried = 0;
      const located = placed.map((r) => {
        const out = healCountry(r, byCountry);
        if (out !== r) recountried++;
        return out;
      });
      if (recountried) {
        log(`${recountried} posting(s) took the country their university is in, ` +
            'from the site\'s own Universities directory');
      }

      const stamped = stampAddedAt(located, known, { now });
      /* No e-mail address may reach a served file, and the workbook's notes
         column can carry a contact one — stripped here like every other
         ingest (see stripRowEmails in jobs-model.mjs), or the build's
         served-file guard stops the whole publish over it. */
      rows = stamped.rows.map(stripRowEmails);
      fresh = stamped.fresh;

      /* What the advertisements themselves say about their deadlines, read by
         higheredjobs-verify.mjs and committed in data/higheredjobs.json.
         RE-APPLIED HERE, on every read of the workbook, and that is the point:
         this file is rebuilt from the sheet each morning, so a deadline merely
         written into data/ once would be reverted by the next run — the same
         reason a country spelling is fixed in oa-countries.js rather than in
         the dataset. It only fills a row the sheet left open-ended, and it is
         wholly non-fatal: no cache, or an unreadable one, simply means the
         rows stay as the sheet wrote them. */
      const verified = applyVerified(rows, await readVerifiedCache(),
        { today: isoStamp(now).slice(0, 10) });
      rows = verified.rows;
      if (verified.changed.length) {
        log(`${verified.changed.length} posting(s) took the deadline their ` +
            'HigherEdJobs advertisement states');
      }
      for (const c of verified.conflicts) {
        warn(`${c.id}: the sheet says ${c.sheet}, the advertisement says ${c.ad} — ` +
             'the sheet wins; correct it there if the advertisement is right');
      }

      /* …and the same re-apply for every OTHER advertisement host, from
         data/adverts.json (adverts-verify.mjs). One cache per pipeline, one
         URL per owner — the two select disjoint rows, so the order of the
         two applies cannot matter. */
      const adverts = applyAdverts(rows, await readAdvertsCache(),
        { today: isoStamp(now).slice(0, 10) });
      rows = adverts.rows;
      if (adverts.changed.length) {
        log(`${adverts.changed.length} posting(s) took the deadline their ` +
            'own advertisement states');
      }
      for (const c of adverts.conflicts) {
        warn(`${c.id}: the sheet says ${c.sheet}, the advertisement says ${c.ad} — ` +
             'the sheet wins; correct it there if the advertisement is right');
      }
      if (stamped.backfill && fresh) {
        log(`first run: ${fresh} posting(s) were dated from the day they were advertised, ` +
            'so the backfill announces nothing by e-mail.');
      }

      /* THE REVIEW GATE. Everything above describes what the workbook says;
         what follows decides how much of it the public may see. A posting
         crawled from the sheet is queued for the maintainer and published only
         once they have approved it — see _scraper/jobreview.mjs for why the
         queue is a Firestore collection and not a file under data/.

         `sheetRows` keeps the FULL set, because the staleness check below asks
         "is the workbook still being updated", which has nothing to do with
         how much of it has been reviewed. Measuring that on the approved rows
         alone would e-mail the maintainer that their sheet had gone quiet
         while it was in fact busy and their own queue was the holdup. */
      sheetRows = rows;

      if (!queue.ok) {
        /* NO QUEUE IS NOT AN EMPTY QUEUE. Without it there is no way to know
           what was approved, and both answers are wrong: publishing everything
           defeats the gate, publishing nothing deletes every posting on the
           site. So the file is left exactly as it is — the same rule this
           script already applies to a workbook it cannot read. */
        warn(`the review queue is unreachable (${queue.error}) — ` +
             'data/jobmarket.json was left exactly as it is');
        rows = existing;
      } else {
        const split = partition(rows, queue.docs, {
          now: isoStamp(now),
          /* What the site is showing right now. Postings already public are
             grandfathered rather than retracted the first morning the queue
             answers — see partition(). */
          published: new Set(existing.map((r) => r.id)),
        });
        rows = split.publish;

        /* THE SAME JOB, ALREADY POSTED. A school that advertises on the site's
           own form is routinely also entered in the tracking workbook by its
           contributors, and the crawled copy then arrives here as a fresh
           posting. Each queued row is therefore checked against the postings
           the site is showing (data/jobs.json, every source) and the possible
           duplicates are written onto its queue document, where the review
           card raises them — flagged for the maintainer, never decided for
           them: approving still publishes, rejecting still keeps it off.
           Pending rows are re-checked every sync, so a flag appears when the
           duplicate is posted later and clears when it is taken down. */
        const site = await readJson(JOBS_FILE, []);

        /* THE SAME ADVERTISEMENT TWICE IS NOT A DECISION TO MAKE (owner,
           2026-08-26): "check the Link to the advert — if it already exists in
           a previous posting that is live or in the queue, then remove that
           new job from the queue". So a fresh crawled row that advertises a
           vacancy already listed is DROPPED here rather than queued, and the
           maintainer never sees it.

           What it is compared against is both halves of "already listed": the
           postings the site is showing AND the rows already waiting in the
           queue — plus the fresh rows this very run has just accepted, so the
           workbook listing one advertisement twice queues it once.

           Dropped means REJECTED, not deleted: `partition` re-queues a row
           whose document is gone, so deleting would re-drop it every sync for
           ever, while a rejection is the one state that both keeps it off the
           site and stays out of the pending list the panel draws. The reason
           goes in `note` and the posting it repeats in `dup` — both already
           allowed by the rules, so nothing here needs a redeploy.

           `advertRepeat` carries the guards (jobreview.mjs): same year, same
           university, and neither the departments nor the entry levels
           contradicting. Measured over the 542 served postings, NONE is judged
           a repeat of another — including UCD's two departments behind one
           CoreHR endpoint, the case this repository already learned from. */
        /* THE QUEUE IS SWEPT FIRST, then the fresh rows are measured against
           what survived it (owner, 2026-08-26: "Apply for all jobs under
           review"). Applying this only to newly-crawled rows would have left
           every repeat already waiting in the queue waiting for ever — every
           posting under review the day this shipped was crawled before the
           rule existed.

           `findAdvertRepeats` is what makes a SET safe to sweep, and a
           per-row check is not: two queued rows naming one advertisement are
           each a repeat of the other, so checking them independently against
           the same list would drop BOTH and lose the posting. It keeps the
           first it is given and measures the rest against it, so the rows go
           in OLDEST FIRST — the one that has been waiting longest is the one
           that stays. */
        const freshRowFor = new Map(split.refresh.map((d) => [d.rowId, d.row]));
        const pendingPairs = split.pending
          .slice()
          .sort((a, b) => String(a.queuedAt || '').localeCompare(String(b.queuedAt || '')))
          /* judged on the row the SHEET NOW GIVES, like the flags below */
          .map((doc) => ({ doc, row: freshRowFor.get(doc.rowId) || doc.row }));
        const docForRow = new Map(pendingPairs.map((p) => [p.row, p.doc]));
        /* WHAT COUNTS AS "ALREADY LISTED" IS NOT data/jobs.json ALONE (owner,
           2026-08-26). A posting the maintainer has APPROVED is out of the
           queue and not yet in the served file — the build publishes it
           minutes later — so for that window a twin of it was measured
           against a set holding NEITHER copy, and nothing could match. The
           DECISION is what makes a posting public, not the deployment, so
           this run's approved rows (`split.publish`, already through
           `approvedRow`) join the set. A row that has published is in both,
           and matches the same either way. */
        const listedNow = [...site, ...split.publish].filter(Boolean);
        const swept = findAdvertRepeats(pendingPairs.map((p) => p.row), listedNow);

        const dropped = [];
        const rejects = [];
        const droppedIds = new Set();
        for (const d of swept.drop) {
          const doc = docForRow.get(d.row);
          if (!doc) continue;
          droppedIds.add(doc.rowId);
          rejects.push({
            rowId: doc.rowId,
            patch: {
              status: REJECTED,
              reviewedAt: isoStamp(now),
              note: repeatNote(d.of),
              dup: [d.of],
            },
          });
          dropped.push({ rowId: doc.rowId, row: d.row, of: d.of, queued: true });
        }
        /* A posting being dropped is not also brought up to date with the
           sheet: refreshing the row of a document this same run rejects is a
           write that changes nothing anybody will read. */
        split.refresh = split.refresh.filter((d) => !droppedIds.has(d.rowId));

        /* Now the fresh rows, against everything already listed plus the
           queue that survived — plus each fresh row this run accepts, so the
           workbook listing one advertisement twice queues it once. */
        const listed = [...listedNow, ...swept.keep].filter(Boolean);
        for (const doc of split.queue) {
          if (doc.status === PENDING) {
            const repeat = advertRepeat(doc.row, listed);
            if (repeat) {
              doc.status = REJECTED;
              doc.reviewedAt = isoStamp(now);
              doc.note = repeatNote(repeat);
              doc.dup = [repeat];
              dropped.push({ rowId: doc.rowId, row: doc.row, of: repeat });
              continue;                       // never becomes something to review
            }
            /* Accepted, so a LATER fresh row repeating this one is dropped
               too — the workbook can list one advertisement twice. */
            listed.push(doc.row);
          }
          doc.dup = duplicatesOf(doc.row, site);
          /* THE BUSINESS-SCHOOL FLAG (owner, 2026-08-23): a posting whose
             text says "business" is typed Business School at ingest, and its
             card names the business school the site's directory knows at
             that university — computed here, drawn there, decided by the
             maintainer. The same vocabulary fillSchoolFromDirectory read. */
          doc.biz = businessCheck(doc.row, vocab);
        }
        for (const d of dropped) {
          log(`  x ${d.queued ? 'taken out of the queue' : 'dropped'}, same advertisement ` +
              `as ${d.of.ref || d.of.id}` +
              `  ${d.row.posted}  ${d.row.institution}` +
              (d.row.department ? ' — ' + d.row.department : ''));
        }
        if (dropped.length) {
          const q = dropped.filter((d) => d.queued).length;
          log(`${dropped.length} crawled posting(s) advertise a vacancy already listed` +
              (q ? ` — ${q} of them already under review` : '') +
              ' and were dropped rather than left for you to decide');
        }
        const flaggedFresh = split.queue.filter((d) => d.dup && d.dup.length
          && d.status === PENDING);

        /* Pending postings are re-checked every sync, JUDGED ON THE ROW THE
           SHEET NOW GIVES — the refreshed copy where one is being written
           this run, not the document's day-old snapshot, or a row that just
           gained its business-school evidence would wait a whole sync for
           its flag. */
        const freshRow = new Map(split.refresh.map((d) => [d.rowId, d.row]));
        const reflag = [];
        for (const doc of split.pending) {
          if (droppedIds.has(doc.rowId)) continue;   // leaving the queue, not being re-flagged
          const row = freshRow.get(doc.rowId) || doc.row;
          const patch = {};
          const dup = duplicatesOf(row, site);
          if (!sameDups(dup, doc.dup)) patch.dup = dup;
          const biz = businessCheck(row, vocab);
          if (!sameBiz(biz, doc.biz)) patch.biz = biz;
          if (Object.keys(patch).length) reflag.push({ rowId: doc.rowId, patch });
        }
        for (const d of flaggedFresh) {
          warn(`${d.rowId} may duplicate ${d.dup.map((x) => x.ref || x.id).join(', ')} — ` +
               'flagged on its review card');
        }

        if (split.queue.length || split.refresh.length || reflag.length || rejects.length) {
          if (DRY) {
            log(`--dry-run: would queue ${split.queue.length} posting(s) for review` +
                (split.refresh.length ? ` and refresh ${split.refresh.length}` : '') +
                (reflag.length ? ` and re-flag ${reflag.length}` : '') +
                (rejects.length ? ` and drop ${rejects.length} as one advertisement twice` : '') +
                '.');
          } else {
            await writeQueue(queue.db, split, reflag);
            if (rejects.length) await rejectRepeats(queue.db, rejects);
          }
        }
        /* Grandfathered rows are in `queue` (they get a document) AND in
           `publish` (the site is already showing them), so they are counted
           out of both lines below: printed as waiting, they would tell the
           maintainer they had sixteen more decisions to make than they do —
           and the first real run said "545 awaiting you" when 529 were. */
        const waiting = split.pending.filter((d) => !droppedIds.has(d.rowId)).length
          + split.queue.filter((d) => d.status === PENDING).length;

        for (const d of split.queue) {
          /* A dropped repeat is REJECTED too, and this line's else-branch reads
             "kept, already public" — which it is not. It has already been
             named above, so it is skipped rather than described wrongly. */
          if (d.status === REJECTED) continue;
          log(`  ${d.status === PENDING ? '~ queued for review' : '= kept, already public'}` +
              `  ${d.row.posted}  ${d.row.institution}` +
              (d.row.department ? ' — ' + d.row.department : ''));
        }
        log(`review queue: ${split.publish.length} approved, ` +
            `${waiting} awaiting you, ${split.rejected.length} turned down`);
        if (waiting) {
          log(`  review them at ${SITE}/admin-area`);
        }
      }

      const before = serialiseSheetRows(existing);
      const after = serialiseSheetRows(rows);

      if (before === after) {
        log(`the sheet dataset is already up to date (${rows.length} postings) — writing nothing.`);
      } else {
        log(`jobmarket.json: ${rows.length} postings (${fresh} not seen before)`);
        const known = new Set(existing.map((r) => r.id));
        for (const r of rows.filter((x) => !known.has(x.id)).slice(0, 40)) {
          log(`  + ${r.posted}  ${r.institution}${r.department ? ' — ' + r.department : ''}`);
        }
        if (DRY) {
          log('--dry-run: not writing.');
        } else {
          await writeFile(ROWS_FILE, after);
          await writeFile(META_FILE, JSON.stringify(buildSheetMeta(rows, {
            generated: now.toISOString(),
            sheets: scope,
            tabs: [].concat(...results.map((r) => r.tabs || [])),
          }), null, 1) + '\n');
          wrote = true;
          log(`wrote ${path.relative(process.cwd(), ROWS_FILE)} and jobmarket-meta.json`);
        }
      }
    }
  }

  /* --------------------------------------------------------------- the roll

     Only after the dataset is safe. `rollRegistry` moves `current` on when a
     successor is demonstrably carrying the market — never on a date. */
  if (!failed.length) {
    const moved = rollRegistry(registry, { now });
    if (moved) {
      log(`the market has moved on to a new workbook: ${moved.id}`);
      log(`  ${sheetEditUrl(moved.id)}`);
    }
  }

  /* ------------------------------------------------------------- staleness */

  /* The SHEET's newest posting, not the newest APPROVED one: the question
     this answers is whether the workbook is still being updated. */
  const newestPosted = (sheetRows.length ? sheetRows : rows)
    .reduce((m, r) => (r.posted > m ? r.posted : m), '');
  const check = stalenessOf({
    ok: !failed.length,
    error: failed.map((f) => `${f.id}: ${f.error}`).join('; '),
    rows: rows.length,
    newestPosted,
    deadTabs: dead.map((d) => d.tab),
    now,
    days: Number(process.env.JOBMARKET_STALE_DAYS) || STALE_DAYS,
  });

  const state = registry.staleness || {};
  state.lastCheckedAt = isoStamp(now);
  state.newestPosted = newestPosted;

  if (check.stale) {
    warn(`the job market sheet looks stale: ${check.detail}`);
    if (shouldWarn(state, check, {
      now, repeatDays: Number(process.env.JOBMARKET_STALE_REPEAT_DAYS) || STALE_REPEAT_DAYS,
    })) {
      const to = process.env.JOBMARKET_ALERT_TO || CONTACT;
      const { subject, html } = renderStaleEmail(check, { sheets: scope, now });
      const tx = NO_MAIL ? null : await transport();
      const sent = await send(tx, { to, subject, html, text: toPlain(html) }, { dryRun: DRY });
      /* Stamped only after a send SUCCEEDS, the mark every other mailer here
         is held to: `send` answers false when there is no SMTP transport, and
         stamping then would silence this for a week without a word having
         reached anybody. A run that cannot send says it again next time. */
      if (sent) {
        log(`told ${to} that the sheet needs looking at.`);
        state.lastWarnedAt = isoStamp(now);
        state.lastReason = check.reason;
      } else {
        log('could not send the staleness warning, so it stays due for the next run.');
      }
    } else {
      log(`(already warned about "${state.lastReason || check.reason}" on ` +
          `${state.lastWarnedAt} — not saying it again yet)`);
    }
  } else {
    if (state.lastWarnedAt) log('the sheet is being updated again — clearing the warning.');
    state.lastWarnedAt = '';
    state.lastReason = '';
  }
  registry.staleness = state;

  /* -------------------------------------------------------- the registry */

  registry.generated = isoStamp(now);
  const regText = JSON.stringify(registry, null, 1) + '\n';
  const regBefore = existsSync(REG_FILE) ? await readFile(REG_FILE, 'utf8') : '';
  if (regText !== regBefore && !DRY) {
    await writeFile(REG_FILE, regText);
    log(`wrote ${path.relative(process.cwd(), REG_FILE)}`);
  }

  if (failed.length) process.exitCode = 1;
  else log(`done. ${rows.length} postings from the sheet${wrote ? ' (file updated)' : ''}.`);
}

/* ---------------------------------------------------------- --heal-names

   The workbook's postings are canonicalised HERE, at ingest (canonPlace in
   jobmarket-sheet.mjs), and the file is rewritten from the workbook every
   morning — so an alias added to oa-schools.js today reaches them on the next
   sync and hand-editing data/ would be undone by it. That is the rule, and it
   has one gap: until that sync runs, data/jobmarket.json still names a place
   the old way, build-jobs.mjs republishes it, and the selftest's "every
   posting names its place the one way" guard goes red — which by design stops
   the build committing ANYTHING.

   So this re-applies the very same canon to the committed file, offline, with
   no workbook and no credentials: the same answer the next sync will produce,
   just sooner. Run it after adding an alias, exactly like the legacy
   importer's mode of the same name.                                         */
/**
 * The site's own vocabulary, or null.
 *
 * `data/vocab.json` is written by build-jobs.mjs from the postings AND from
 * the Universities directory, and is the same file the posting form's cascade
 * reads — so the school this pipeline fills in and the school the maintainer
 * would be offered on the review card are the same answer, from the same
 * place. Absent or unreadable means no fill, never a failed run.
 */
async function loadVocab() {
  const v = await readJson(path.join(DATA, 'vocab.json'), null);
  return v && v.byUniversity ? v : null;
}

/** The Universities directory, or an empty list. The addresses `campusCountries`
    reads to say which country a university's campus is in. */
async function loadDirectory() {
  const rows = await readJson(path.join(DATA, 'universities.json'), null);
  return Array.isArray(rows) ? rows : [];
}

async function healNames() {
  const rows = await readJson(ROWS_FILE, null);
  if (!Array.isArray(rows)) {
    console.error(`::error::${ROWS_FILE} is missing or unreadable — nothing to heal`);
    return false;
  }
  /* The same passes the sync itself makes, in the same order: put every
     name into the spelling the site publishes, give a posting the school
     its department sits in, and read the suggested apply-by out of its own
     deadline prose. All pure and idempotent, so a run with nothing to do
     writes nothing. */
  const vocab = await loadVocab();
  const byCountry = campusCountries(await loadDirectory());
  const healed = rows.map(healPlace)
    .map((r) => (vocab ? fillSchoolFromDirectory(r, vocab) : r))
    .map((r) => healCountry(r, byCountry))
    .map(healReviewDate)
    .map(stripRowEmails)
    /* …and the SEASONS it is listed under, last, off the dates as they finally
       stand — `rowsFromTab` writes it in exactly this position (owner,
       2026-08-27: a posting advertised in one season for a search closing in
       the next belongs to both). Idempotent like the rest, so this is also how
       the committed file gains the field without waiting for a workbook to
       change. */
    .map(withMarketYears);
  const changed = healed.filter((r, i) =>
    JSON.stringify(r) !== JSON.stringify(rows[i]));
  if (!changed.length) {
    log('data/jobmarket.json: every posting already names its place the one way');
    return true;
  }
  for (const r of changed.slice(0, 10)) log(`  ${r.id}: ${r.institution} — ${r.department}`);
  if (DRY) { log(`--dry-run: ${changed.length} posting(s) would be corrected`); return true; }
  await writeFile(ROWS_FILE, serialiseSheetRows(healed));
  /* the meta's `sheets` and `tabs` say WHICH WORKBOOK these postings came from,
     and only a real sync knows that — rebuilding the meta from scratch here
     emptied both, throwing away the provenance to record a rename. Carried. */
  const meta = await readJson(META_FILE, {});
  await writeFile(META_FILE, JSON.stringify(buildSheetMeta(healed, {
    generated: isoStamp(new Date()),
    sheets: meta.sheets || [],
    tabs: meta.tabs || [],
  }), null, 1) + '\n');
  log(`data/jobmarket.json: corrected ${changed.length} posting(s)`);
  return true;
}

if (isMain(import.meta.url)) {
  if (has('--heal-names')) process.exit(await healNames() ? 0 : 1);
  if (has('--selftest')) {
    /* The WHOLE suite, not runSelftest()'s three-suite subset — which does not
       include a single check of this pipeline, so the flag would print a
       passing total for a file it never looked at. build-jobs.mjs was fixed
       the same way, for the same reason. */
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(HERE, 'selftest.mjs')], { stdio: 'inherit' });
    process.exit(r.status === 0 ? 0 : 1);
  }
  await main();
}
