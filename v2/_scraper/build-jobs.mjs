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
  rowFromSubmission, mergeRows, buildMeta, serialise, publicRow, displayOrder,
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

  // queued -> publish; withdrawn/hidden -> take back out of the file
  const [queuedSnap, pulledSnap] = await Promise.all([
    col.where('status', '==', 'queued').get(),
    col.where('status', 'in', ['withdrawn', 'hidden']).get(),
  ]);

  const queued = queuedSnap.docs;
  const pulled = pulledSnap.docs;

  if (SCAN) {
    log(`${queued.length} queued, ${pulled.length} withdrawn/hidden`);
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

  if (!queued.length && !pulled.length) {
    log('nothing queued and nothing withdrawn — no change.');
    return;
  }

  const now = new Date();
  const fresh = [];
  const rejected = [];
  for (const d of queued) {
    const row = rowFromSubmission(d.data(), { now });
    if (row) fresh.push({ id: d.id, row });
    else rejected.push({ id: d.id, ref: d.data().ref || d.id });
  }

  for (const r of rejected) {
    warn(`submission ${r.ref} is missing required fields — left queued for review`);
  }

  const existing = await readJson(JOBS, []);
  const removeRefs = pulled.map((d) => d.data().ref).filter(Boolean);

  // The maintainer's committed suppression list, honoured by every writer of
  // this file (see data/jobs-hidden.json). A posting listed here is withheld
  // even if it is still queued in Firestore.
  const hide = await readJson(path.join(DATA, 'jobs-hidden.json'), {});
  const hidden = new Set([].concat(hide.ids || [], hide.refs || []));

  const merged =
    mergeRows(existing, fresh.map((f) => f.row).filter((r) => !hidden.has(r.ref) && !hidden.has(r.id)),
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

  // Only now stamp Firestore. A failure here is recoverable: the row is already
  // in the file, and re-publishing it next run replaces it in place.
  const batch = db.batch();
  let stamped = 0;
  for (const f of fresh) {
    batch.update(col.doc(f.id), {
      status: 'published',
      publishedAt: new Date(),
      publishedId: f.row.id,
    });
    stamped++;
  }
  for (const d of pulled) {
    if (d.data().status !== 'withdrawn') continue;   // 'hidden' stays hidden
    batch.update(col.doc(d.id), { status: 'removed', removedAt: new Date() });
    stamped++;
  }
  if (stamped) {
    await batch.commit();
    log(`stamped ${stamped} submission(s) in Firestore`);
  }
}

main().catch((err) => {
  // A build failure must not wedge the workflow into a red state forever; the
  // next scheduled run retries from the same queue.
  console.error('build-jobs failed:', err);
  process.exit(1);
});
