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
  ownerTag, keyOf, sameDayKey,
} from './jobs-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const JOBS = path.join(DATA, 'jobs.json');
const META = path.join(DATA, 'jobs-meta.json');

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const SCAN = argv.has('--scan');

/* ------------------------------------------------------------------ helpers */

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/**
 * A committed JSON file, or `fallback` when it is genuinely ABSENT.
 *
 * A file that exists but does not parse is an ERROR, not an empty dataset.
 * Falling back to `[]` there meant a truncated jobs.json — a hand-resolved
 * merge conflict, an interrupted write — made the run rebuild the catalogue
 * from nothing but whatever happened to be queued, exit 0, and let the
 * workflow commit the deletion of every live advertisement. The post-build
 * check cannot catch it either: the wiped file is still a well-formed array.
 */
async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  const raw = await readFile(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${path.basename(file)} exists but is not valid JSON (${e.message}) — ` +
      'refusing to rebuild the dataset from an empty file');
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
    /* The WHOLE offline suite, not the subset runSelftest() exports. That
       subset skips the market-roll rule, the same-day collapse and every
       invariant of the very file this script writes, yet printed "69 checks
       passed" — which reads as a full pass. selftest.mjs runs its full list
       from its own entry-point guard, so it is run as one, in a child
       process; still offline, still no credentials. */
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(HERE, 'selftest.mjs')], { stdio: 'inherit' });
    process.exit(r.status === null ? 1 : r.status);
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

  /* NO early return on an empty queue. The maintainer's suppression list is
     a committed file, so a take-down committed while nothing happens to be
     queued — the queue's normal state — has to take effect on the very next
     run. Returning here first meant it only ever applied as a side effect of
     unrelated traffic, and the same return skipped the committed-duplicate
     self-heal mergeRows promises. Nothing is written when nothing changes,
     which is what makes running the merge every time free. */

  const now = new Date();
  const fresh = [];
  const rejected = [];
  for (const d of queued) {
    let row = null;
    try {
      row = rowFromSubmission(d.data(), { now });
    } catch (e) {
      // One unreadable document must not kill the run: it stays queued, so
      // without this the next scheduled run dies on it too and no posting is
      // ever published again until a human finds it.
      warn(`submission ${d.data().ref || d.id} could not be read (${e.message}) — left queued`);
      continue;
    }
    if (row) fresh.push({ id: d.id, row });
    else rejected.push({ id: d.id, ref: d.data().ref || d.id });
  }

  for (const r of rejected) {
    warn(`submission ${r.ref} is missing required fields — left queued for review`);
  }

  const existing = await readJson(JOBS, []);

  /* A withdrawal may only take down a row the SAME ACCOUNT published. The uid
     is pinned by the security rules; `ref` is not, and it is published in
     jobs.json, so a bare reference is not proof of ownership — see ownerTag()
     in jobs-model.mjs. */
  const removeSpecs = pulled
    .map((d) => d.data())
    .filter((v) => v.ref)
    .map((v) => ({ ref: v.ref, owner: ownerTag(v.uid) }));

  // The maintainer's committed suppression list, honoured by every writer of
  // this file (see data/jobs-hidden.json). A posting listed here is withheld
  // even if it is still queued in Firestore.
  const hide = await readJson(path.join(DATA, 'jobs-hidden.json'), {});
  const hidden = new Set([].concat(hide.ids || [], hide.refs || []));
  const isHidden = (r) => hidden.has(r.id) || hidden.has(r.ref);

  const merged = mergeRows(
    existing, fresh.filter((f) => !isHidden(f.row)).map((f) => f.row), removeSpecs);
  const { added, updated, removed, collapsed } = merged;
  const rows = merged.rows.filter((r) => !isHidden(r));
  const withdrawnByList = merged.rows.length - rows.length;

  /* A rebuild only ever loses rows it can account for: withdrawn, withheld, or
     collapsed as a repeat. Anything beyond that is the dataset disappearing
     under us, and committing it would take live advertisements off the site. */
  const loss = existing.length - rows.length;
  const explained = removed + withdrawnByList + collapsed;
  if (loss > explained) {
    throw new Error(
      `refusing to write: ${rows.length} rows would replace ${existing.length}, ` +
      `and only ${explained} of the ${loss} lost are accounted for ` +
      `(${removed} withdrawn, ${withdrawnByList} withheld, ${collapsed} collapsed)`);
  }

  const before = serialise(existing);
  const after = serialise(rows);

  if (before === after) {
    log('the dataset is already up to date — writing nothing.');
  } else {
    log(`jobs.json: +${added} new, ${updated} updated, ${removed} removed, ` +
        `${withdrawnByList} withheld  (${rows.length} total)`);
    for (const f of fresh) log(`  + ${f.row.ref || f.row.id}  ${f.row.institution}`);
    if (DRY) {
      log('--dry-run: not writing.');
    } else {
      await writeFile(JOBS, after);
      await writeFile(
        META,
        JSON.stringify(buildMeta(rows, { generated: now.toISOString() }), null, 1) + '\n'
      );
      log(`wrote ${path.relative(process.cwd(), JOBS)} and jobs-meta.json`);
    }
  }

  if (DRY) return;

  /* Only now stamp Firestore, and stamp only what actually reached the file.
     The loop used to run over every queued submission, so one that was
     withheld by jobs-hidden.json — or dropped as a same-day repeat — was
     marked 'published' with a publishedId pointing at some other row. That
     took it out of the `status == 'queued'` query for good: removing it from
     the suppression list later could never bring it back, and a withdrawal
     quoting its reference removed nothing.

     A failure here is recoverable: the row is already in the file, and
     re-publishing it next run replaces it in place. */
  const survived = new Map(rows.map((r) => [keyOf(r), r]));
  const byDay = new Map(rows.map((r) => [sameDayKey(r), r]));
  const writes = [];

  for (const f of fresh) {
    if (isHidden(f.row)) {
      log(`  · withheld by jobs-hidden.json: ${f.row.ref || f.row.id} — left queued`);
      continue;
    }
    const kept = survived.get(keyOf(f.row));
    if (kept) {
      writes.push([f.id, { status: 'published', publishedAt: new Date(), publishedId: kept.id }]);
      continue;
    }
    // Collapsed against another submission of the same posting on the same
    // day — the poster's correction, or their earlier attempt at it.
    const winner = byDay.get(sameDayKey(f.row));
    log(`  · superseded: ${f.row.ref || f.row.id} -> ${winner ? (winner.ref || winner.id) : '(withdrawn)'}`);
    writes.push([f.id, {
      status: 'superseded',
      supersededAt: new Date(),
      supersededBy: winner ? (winner.ref || winner.id) : '',
    }]);
  }

  for (const d of pulled) {
    if (d.data().status !== 'withdrawn') continue;   // 'hidden' stays hidden
    writes.push([d.id, { status: 'removed', removedAt: new Date() }]);
  }

  /* Firestore caps a batched write at 500 documents, and one oversized batch
     threw on commit — after the file had been written — so nothing was
     stamped, the queue stayed exactly as big, and every later run failed the
     same way. Chunked, a backlog drains instead of wedging the workflow red. */
  const CHUNK = 450;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const [id, patch] of writes.slice(i, i + CHUNK)) batch.update(col.doc(id), patch);
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
