#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — publish queued job postings into v2/data/jobs.json.

   The live half of the pipeline that replaced Awesome Tables:

       post-a-job.html  ->  Firestore jobSubmissions  ->  THIS  ->  data/jobs.json
                                                                      |
                                              jobs.html lazy-loads it -+

   Run by .github/workflows/oa-jobs-build.yml on a schedule. It is a NO-OP
   until FIREBASE_SERVICE_ACCOUNT is set, so it can be committed and scheduled
   before the Firebase project exists — the same discipline /lit/'s mailers use.

   It writes the dataset BEFORE stamping Firestore. If the run dies in between,
   the next run simply re-publishes the same rows (mergeRows replaces by
   reference, so this is idempotent) — whereas stamping first could lose a
   posting entirely.

   Modes:
     --dry-run    do everything, write nothing, print the diff
     --scan       report what is queued and exit
     --selftest   offline checks, no network, no credentials
   --------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rowFromSubmission, mergeRows, buildMeta, serialise, publicRow, displayOrder, assignIds,
} from './jobs-model.mjs';
import { buildVocab, serialiseVocab } from './vocab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const JOBS = path.join(DATA, 'jobs.json');
const META = path.join(DATA, 'jobs-meta.json');
const VOCAB = path.join(DATA, 'vocab.json');

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const SCAN = argv.has('--scan');

/* ------------------------------------------------------------------ helpers */

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    warn(`could not parse ${path.basename(file)} (${e.message}) — starting from empty`);
    return fallback;
  }
}

/** jobs.json, strictly. An UNREADABLE dataset must abort the run, not stand in
    for an empty one: before the migration has run, the orphan-carry below is
    the only thing keeping the file's rows alive, and a parse error read as []
    means no orphans — the whole back-catalogue silently dropped from the next
    write, with every gate still green. A missing file is genuinely empty. */
async function readJobsStrict(file) {
  if (!existsSync(file)) return [];
  return JSON.parse(await readFile(file, 'utf8'));   // a SyntaxError kills the run, loudly
}

/* ------------------------------------------------------------------ firebase */

/** The Admin SDK, or null when this environment has no credentials. */
async function firestore() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !raw.trim()) return null;

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    // the secret is commonly pasted base64-encoded
    try {
      creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      warn('FIREBASE_SERVICE_ACCOUNT is set but is neither JSON nor base64 JSON');
      return null;
    }
  }

  let admin;
  try {
    admin = await import('firebase-admin');
  } catch {
    warn('firebase-admin is not installed — run `npm i firebase-admin` in the workflow');
    return null;
  }
  const app = admin.default || admin;
  if (!app.apps.length) {
    app.initializeApp({ credential: app.credential.cert(creds) });
  }
  return app.firestore();
}

/* ---------------------------------------------------------------------- main */

async function main() {
  if (argv.has('--selftest')) {
    const { runSelftest } = await import('./selftest.mjs');
    process.exit(runSelftest() ? 0 : 1);
  }

  const db = await firestore();
  if (!db) {
    log('no Firebase credentials in this environment — nothing to publish.');
    log('(this is the expected state until the project is set up: v2/_SETUP-FIREBASE.md)');
    return;
  }

  const col = db.collection('jobSubmissions');

  /* THE DATABASE IS THE SOURCE OF TRUTH, and data/jobs.json is its projection.
     This used to read only what was newly `queued` and merge it into the file,
     which meant an edit to an ALREADY-PUBLISHED posting changed nothing: the
     document was never read again. Reading the whole live set instead is what
     makes editing work at all — a posting is rebuilt from its document on
     every run, so a correction reaches the page the same way a new posting
     does. */
  const [liveSnap, pulledSnap] = await Promise.all([
    col.where('status', 'in', ['queued', 'published']).get(),
    col.where('status', 'in', ['withdrawn', 'hidden']).get(),
  ]);

  const live = liveSnap.docs;
  const pulled = pulledSnap.docs;
  const queued = live.filter((d) => d.data().status === 'queued');

  if (SCAN) {
    log(`${live.length} live (${queued.length} of them newly queued), ` +
        `${pulled.length} withdrawn/hidden`);
    for (const d of queued) {
      const v = d.data();
      log(`  queued  ${v.ref || d.id}  ${v.institution} — ${v.department}`);
    }
    for (const d of pulled) {
      const v = d.data();
      log(`  pulled  ${v.ref || d.id}  ${v.institution}  (${v.status})`);
    }
    return;
  }

  const now = new Date();
  const fresh = [];
  const rejected = [];
  for (const d of live) {
    let row = null;
    try {
      row = rowFromSubmission(d.data(), { now });
    } catch (e) {
      // One unreadable document must not kill the run: it stays as it is, so
      // without this the next scheduled run dies on it too and no posting is
      // ever published again until a human finds it.
      warn(`submission ${d.data().ref || d.id} could not be read (${e.message}) — skipped`);
      continue;
    }
    if (row) fresh.push({ id: d.id, key: d.id, row, queued: d.data().status === 'queued' });
    else rejected.push({ id: d.id, ref: d.data().ref || d.id });
  }

  for (const r of rejected) {
    warn(`submission ${r.ref} is missing required fields — left queued for review`);
  }

  /* Distinct ids, stably. Without this two postings from one institution on one
     day derive the same id and the second overwrites the first — which is how
     Tulane's and Houston's second departments disappeared. */
  assignIds(fresh);

  const existing = await readJobsStrict(JOBS);
  const removeRefs = pulled.map((d) => d.data().ref).filter(Boolean);

  // The maintainer's committed suppression list, honoured by every writer of
  // this file (see data/jobs-hidden.json). A posting listed here is withheld
  // even if it is still queued in Firestore.
  const hide = await readJson(path.join(DATA, 'jobs-hidden.json'), {});
  const hidden = new Set([].concat(hide.ids || [], hide.refs || []));

  /* ORPHANS — rows in the served file that no live document accounts for.

     Before the migration has run, that is every posting still only in the
     file, and rebuilding from the database alone would DELETE them. So they
     are carried instead, and reported: the file only ever shrinks because a
     posting was withdrawn or hidden, never because a document is missing.

     The consequence, which is deliberate: taking a posting down is a STATUS
     CHANGE (withdrawn/hidden), never deleting its document. Deleting the
     document would leave the row orphaned and therefore preserved — the
     opposite of what was intended. The rules reflect this: a poster may
     withdraw their own posting, and only the maintainer may delete outright. */
  const live_ids = new Set(fresh.map((f) => f.row.id));
  const orphans = existing.filter((r) => !live_ids.has(r.id) && !removeRefs.includes(r.ref));
  if (orphans.length) {
    warn(`${orphans.length} posting(s) in jobs.json have no document yet — carried ` +
         'unchanged. Run migrate-to-firestore.mjs to make them editable.');
  }

  const merged =
    mergeRows(orphans, fresh.map((f) => f.row).filter((r) => !hidden.has(r.ref) && !hidden.has(r.id)),
      removeRefs);
  const { added, updated, removed } = merged;
  const rows = merged.rows.filter((r) => !hidden.has(r.id) && !hidden.has(r.ref));

  const before = serialise(existing);
  const after = serialise(rows);

  if (before === after) {
    log('the dataset is already up to date — writing nothing.');
  } else {
    log(`jobs.json: +${added} new, ${updated} updated, ${removed} removed  (${rows.length} total)`);
    for (const f of fresh) log(`  + ${f.row.ref || f.row.id}  ${f.row.institution}`);
    if (DRY) {
      log('--dry-run: not writing.');
    } else {
      await writeFile(JOBS, after);
      await writeFile(
        META,
        JSON.stringify(buildMeta(rows, { generated: now.toISOString() }), null, 1) + '\n'
      );
      /* The form's option lists come from the postings themselves, so a name
         a poster entered today is offered to the next poster tomorrow with
         nobody curating a list. Rewritten with the dataset, never apart from
         it. */
      await writeFile(VOCAB, serialiseVocab(buildVocab(rows, { generated: now.toISOString() })));
      log(`wrote ${path.relative(process.cwd(), JOBS)}, jobs-meta.json and vocab.json`);
    }
  }

  if (DRY) return;

  /* Only now stamp Firestore. A failure here is recoverable: the row is
     already in the file, and re-publishing it next run replaces it in place.

     CHUNKED, because Firestore caps a batched write at 500 documents: one
     batch would collect a whole backlog and then throw on commit — AFTER the
     file was written — leaving every submission queued and re-collected
     forever. */
  const writes = [];
  for (const f of fresh.filter((x) => x.queued)) {
    writes.push([f.id, {
      status: 'published',
      publishedAt: new Date(),
      publishedId: f.row.id,
    }]);
  }
  for (const d of pulled) {
    if (d.data().status !== 'withdrawn') continue;   // 'hidden' stays hidden
    writes.push([d.id, { status: 'removed', removedAt: new Date() }]);
  }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const [id, patch] of writes.slice(i, i + 400)) batch.update(col.doc(id), patch);
    await batch.commit();
  }
  if (writes.length) log(`stamped ${writes.length} submission(s) in Firestore`);
}

main().catch((err) => {
  // A build failure must not wedge the workflow into a red state forever; the
  // next scheduled run retries from the same queue.
  console.error('build-jobs failed:', err);
  process.exit(1);
});
