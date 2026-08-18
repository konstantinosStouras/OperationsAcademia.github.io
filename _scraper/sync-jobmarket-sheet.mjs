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

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { marketFloor, isoStamp } from './jobs-model.mjs';
import {
  SEED_SHEET_ID, STALE_DAYS, STALE_REPEAT_DAYS,
  sheetCsvUrl, sheetHtmlUrl, sheetEditUrl, sheetId,
  tabsFromHtml, sheetIdsFromHtml, classifyTab, isIntroTab, conventionalTabs,
  rowsFromTab, collectRows, stampAddedAt, serialiseSheetRows, buildSheetMeta,
  stalenessOf, shouldWarn, emptyRegistry, adoptSheets, activeSheets, rollRegistry,
} from './jobmarket-sheet.mjs';
import { applyVerified, emptyCache } from './higheredjobs.mjs';
import { shell, esc, send, transport, toPlain, SITE, CONTACT } from './_mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const ROWS_FILE = path.join(DATA, 'jobmarket.json');
const META_FILE = path.join(DATA, 'jobmarket-meta.json');
const REG_FILE = path.join(DATA, 'jobmarket-sheets.json');
const VERIFIED_FILE = path.join(DATA, 'higheredjobs.json');

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
      tab: t.name, kind: t.kind, sheetId: id, minYear,
    });
    perTab.push({ tab: t.name, kind: t.kind, ...out });

    if (out.missing.length) {
      notes.push(`tab "${t.name}": no institution/date columns could be found — ` +
                 'the tab was read but nothing in it could be used');
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
             notes, error: page.ok ? 'no tab could be read' : (page.error || 'unreachable') };
  }

  const rows = [].concat(...perTab.map((p) => p.rows));
  return {
    ok: true, id, rows, links, notes,
    tabs: (wanted.length ? wanted : tabs).map((t) => t.name),
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
  const existing = await readRowsStrict();

  /* ------------------------------------------------- decide whether to write

     A failed read is the dangerous case: a posting leaves the site by being
     ABSENT from this file, so writing a partial read would take down every
     posting the unread workbook holds. */
  let wrote = false;
  let rows = existing;
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
      const stamped = stampAddedAt(collected.rows, existing, { now });
      rows = stamped.rows;
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
      if (stamped.backfill && fresh) {
        log(`first run: ${fresh} posting(s) were dated from the day they were advertised, ` +
            'so the backfill announces nothing by e-mail.');
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

  const newestPosted = rows.reduce((m, r) => (r.posted > m ? r.posted : m), '');
  const check = stalenessOf({
    ok: !failed.length,
    error: failed.map((f) => `${f.id}: ${f.error}`).join('; '),
    rows: rows.length,
    newestPosted,
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
      if (sent) log(`told ${to} that the sheet needs looking at.`);
      state.lastWarnedAt = isoStamp(now);
      state.lastReason = check.reason;
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
