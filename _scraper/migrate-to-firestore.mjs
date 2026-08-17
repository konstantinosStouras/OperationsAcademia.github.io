#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — move the postings INTO the database.

   WHY. Until now `data/jobs.json` was a projection of the Google Sheet: the
   sheet was the store, and the sync rebuilt the file from it every 20 minutes.
   That made a posting uneditable in practice — an edit to a sheet-imported row
   would be silently reverted at the next sync, with no error anywhere.

   So the sheet is retired and the postings become the database. This script is
   the one-off that gets them there: every row in `data/jobs.json` that has no
   document yet becomes one in `jobSubmissions`, after which build-jobs.mjs
   generates the served file from Firestore alone and an edit is just an edit.

   IT IS SAFE TO RUN AGAIN. Documents are keyed by the row's own id, so a second
   run creates nothing and changes nothing. Nothing is ever deleted here.

   IT DOES NOT REWRITE CONTENT. Each document is built by inverting the
   published row (`submissionFromRow`), and the selftest asserts over the REAL
   committed file that re-publishing every document reproduces the row it came
   from, field by field. The one allowed difference is a documented
   normalisation of a hyphen separator in two rows.

       node v2/_scraper/migrate-to-firestore.mjs --scan      # what would happen
       node v2/_scraper/migrate-to-firestore.mjs --dry-run   # ditto, verbosely
       node v2/_scraper/migrate-to-firestore.mjs             # do it

   A posting migrated from the sheet has NO OWNER — there is no account behind
   it — so `uid` is null and only the maintainer can edit it. A poster who
   later claims it can be given ownership by setting `uid`.
   --------------------------------------------------------------------------- */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { submissionFromRow, rowFromSubmission, publicRow } from './jobs-model.mjs';
import { SOURCE as SHEET_SOURCE } from './jobmarket-sheet.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOBS = path.join(HERE, '..', 'data', 'jobs.json');

/**
 * Which published rows this migration is about.
 *
 * NOT the ones that come from the job market tracking SHEET. Those are
 * rebuilt from the workbook on every run of sync-jobmarket-sheet.mjs, which
 * is what makes an edit in the sheet — and a row DELETED from it — reach the
 * site at all. Giving one a document would break both directions: the
 * document would win over the sheet at the next build (the very trap that
 * retired the old form-sheet sync), and a posting removed from the sheet
 * could never leave the site, because its document would keep republishing
 * it.
 *
 * Exported because selftest.mjs asserts the round trip over exactly this set:
 * the guard and the migration must agree about what is being migrated, or the
 * guard fails on rows nothing would ever migrate.
 */
export function migratable(row) {
  return !!row && row.source !== SHEET_SOURCE;
}

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const SCAN = argv.has('--scan');

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/* The document id IS the row id. That is what makes the script idempotent —
   there is no "have I already migrated this?" bookkeeping to get wrong — and it
   makes a posting addressable from the page without a lookup table. Firestore
   ids may not contain "/", which a row id never does (it is built from a slug
   and a date), but it is checked rather than assumed. */
export function docIdFor(row) {
  const id = String(row.id || '');
  return /^[A-Za-z0-9._~-]+$/.test(id) ? id : '';
}

/** The document a published row becomes. Pure, so the selftest can check it. */
export function migrationDoc(row, { now = new Date() } = {}) {
  const sub = submissionFromRow(row, { uid: null, status: 'published' });
  return {
    ...sub,
    // provenance, so a migrated posting is distinguishable from one posted here
    migratedFrom: 'jobs.json',
    migratedAt: now.toISOString(),
    createdAt: row.addedAt || now.toISOString(),
    updatedAt: row.addedAt || now.toISOString(),
  };
}

/** Re-publishing the document must reproduce the row. Returns a list of the
    fields that would change, ignoring the documented hyphen normalisation. */
export function lostFields(row, doc) {
  const back = rowFromSubmission(doc);
  if (!back) return ['<the document would not publish at all>'];
  const out = publicRow({ ...back, id: row.id });
  const lost = [];
  for (const k of Object.keys(row)) {
    if (JSON.stringify(row[k]) === JSON.stringify(out[k])) continue;
    if (k === 'department' && String(row[k]).replace(/\s*-\s*/g, ', ') === String(out[k])) continue;
    lost.push(`${k}: ${JSON.stringify(row[k])} -> ${JSON.stringify(out[k])}`);
  }
  return lost;
}

async function firestore() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !raw.trim()) return null;
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    try { creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { warn('FIREBASE_SERVICE_ACCOUNT is neither JSON nor base64 JSON'); return null; }
  }
  let admin;
  try { admin = await import('firebase-admin'); }
  catch { warn('firebase-admin is not installed'); return null; }
  const app = admin.default || admin;
  if (!app.apps.length) app.initializeApp({ credential: app.credential.cert(creds) });
  return app.firestore();
}

async function main() {
  if (!existsSync(JOBS)) { log('no data/jobs.json — nothing to migrate.'); return; }
  const all = JSON.parse(await readFile(JOBS, 'utf8'));
  const rows = all.filter(migratable);
  if (rows.length !== all.length) {
    log(`${all.length - rows.length} posting(s) come from the job market tracking sheet ` +
        'and are left alone — the sheet is where they are maintained.');
  }
  const now = new Date();

  /* THE GATE. Check every row round-trips BEFORE writing anything: a migration
     that quietly rewrites the site's content is worse than one that refuses. */
  const problems = [];
  for (const row of rows) {
    const id = docIdFor(row);
    if (!id) { problems.push(`${row.id}: not usable as a document id`); continue; }
    const lost = lostFields(row, migrationDoc(row, { now }));
    for (const l of lost) problems.push(`${row.id}.${l}`);
  }
  if (problems.length) {
    log(`::error::${problems.length} posting(s) would change if migrated — refusing.`);
    for (const p of problems.slice(0, 20)) log('  ' + p);
    process.exit(1);
  }
  log(`${rows.length} postings round-trip cleanly.`);

  if (SCAN) {
    const owned = rows.filter((r) => r.ref).length;
    log(`${rows.length} to consider: ${owned} were posted through the site (they have a`);
    log(`reference and an owner), ${rows.length - owned} came from the sheet and will be`);
    log('maintainer-editable only.');
    return;
  }

  const db = await firestore();
  if (!db) {
    log('no Firebase credentials in this environment — nothing was written.');
    log('(expected locally; this runs in CI, see v2/_SETUP-FIREBASE.md)');
    return;
  }

  const col = db.collection('jobSubmissions');

  /* Which rows already have a document. Read by id in chunks rather than
     listing the collection, so the cost is proportional to what is being
     migrated and a partly-migrated collection resumes cleanly. */
  const existing = new Set();
  for (let i = 0; i < rows.length; i += 300) {
    const refs = rows.slice(i, i + 300).map((r) => col.doc(docIdFor(r)));
    const snaps = await db.getAll(...refs);
    for (const s of snaps) if (s.exists) existing.add(s.id);
  }

  const todo = rows.filter((r) => !existing.has(docIdFor(r)));
  log(`${existing.size} already in the database, ${todo.length} to add.`);
  if (!todo.length) { log('nothing to do.'); return; }

  if (DRY) {
    for (const r of todo.slice(0, 30)) log(`  + ${docIdFor(r)}  ${r.institution}`);
    if (todo.length > 30) log(`  … and ${todo.length - 30} more`);
    log('--dry-run: nothing written.');
    return;
  }

  let written = 0;
  for (let i = 0; i < todo.length; i += 400) {
    const batch = db.batch();
    for (const row of todo.slice(i, i + 400)) {
      batch.create(col.doc(docIdFor(row)), migrationDoc(row, { now }));
    }
    await batch.commit();
    written += Math.min(400, todo.length - i);
    log(`  wrote ${written}/${todo.length}`);
  }
  log(`migrated ${written} postings into jobSubmissions.`);
  log('The Google Sheet is no longer read. Edits now happen in the database.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (argv.has('--selftest')) {
    const { runSelftest } = await import('./selftest.mjs');
    process.exit(runSelftest() ? 0 : 1);
  }
  await main();
}
