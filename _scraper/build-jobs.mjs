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
  marketYear, inCurrentMarket, collectChanges, renderChangesHtml,
} from './jobs-model.mjs';
import { SOURCE as SHEET_SOURCE } from './jobmarket-sheet.mjs';
import { buildVocab, canonicaliseNames, serialiseVocab } from './vocab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const JOBS = path.join(DATA, 'jobs.json');
const META = path.join(DATA, 'jobs-meta.json');
const VOCAB = path.join(DATA, 'vocab.json');
/* The maintainer's job market tracking sheet, read by sync-jobmarket-sheet.mjs
   into rows of exactly this file's shape. It is a SECOND source of postings,
   beside the database — see the block in main() that merges it. */
const SHEET = path.join(DATA, 'jobmarket.json');
/* The site's own Universities directory (data/universities.json, imported from
   the maintainer's universities sheet by import-legacy-tables.mjs). The posting
   form's cascading pickers read it through vocab.json: it is what knows which
   school a department sits in at a university that has never posted here. */
const DIRECTORY = path.join(DATA, 'universities.json');

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const SCAN = argv.has('--scan');

/* ------------------------------------------------------------------ helpers */

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/** Two vocabularies with the same names in them — `generated` aside, which
    moves on every run and would otherwise commit an identical file daily. */
function sameVocab(a, b) {
  if (!a || !b) return false;
  const bare = (v) => JSON.stringify({ ...v, generated: '' });
  return bare(a) === bare(b);
}

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

/** The default Storage bucket, or null. Callers treat null as "skip". */
async function storageBucket() {
  let admin;
  try { admin = await import('firebase-admin'); } catch { return null; }
  const app = admin.default || admin;
  if (!app.apps.length) return null;
  try {
    return app.storage().bucket('operations-academia.firebasestorage.app');
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- uploads */

async function transferUploads(db, live, { now }) {
  const pending = live.filter((d) => {
    const v = d.data() || {};
    return v.adUploadPath && !v.adUrl;
  });
  if (!pending.length) return;

  let drive, folders;
  try {
    drive = await import('./drive-upload.mjs');
    folders = await import('./drive-folders.mjs');
  } catch (e) {
    warn(`advert uploads: could not load the Drive client (${e.message}) — left for the next run`);
    return;
  }

  if (drive.missingCredentials().length) {
    warn(`advert uploads: ${pending.length} waiting, but ` +
      `${drive.missingCredentials().join(', ')} not set — left for the next run`);
    return;
  }

  const bucket = await storageBucket();
  if (!bucket) {
    warn('advert uploads: no Storage bucket available — left for the next run');
    return;
  }

  const config = JSON.parse(await readFile(path.join(DATA, 'drive-folders.json'), 'utf8'));
  const year = marketYear(now);

  let token;
  try {
    token = await drive.accessToken();
  } catch (e) {
    warn(`advert uploads: ${e.message} — left for the next run`);
    return;
  }

  for (const d of pending) {
    const v = d.data();
    try {
      /* The path is checked against the shape the Storage rules enforce
         (uploads/{uid}/{kind}/{name}) rather than trusted: the document field
         is client-writable, and an arbitrary path here would let a poster
         exfiltrate any object the service account can read into a public
         Drive link. */
      const m = /^uploads\/([^/]+)\/(jobs|candidates)\/([^/]+)$/.exec(String(v.adUploadPath));
      if (!m) {
        warn(`advert uploads: ${v.ref || d.id} has a malformed path — cleared`);
        await d.ref.update({ adUploadPath: null, adUploadName: null, adUploadType: null, adUploadSize: null });
        continue;
      }
      if (v.uid && m[1] !== v.uid) {
        warn(`advert uploads: ${v.ref || d.id} path does not belong to its poster — cleared`);
        await d.ref.update({ adUploadPath: null, adUploadName: null, adUploadType: null, adUploadSize: null });
        continue;
      }

      const file = bucket.file(v.adUploadPath);
      const [bytes] = await file.download();

      const name = drive.driveFileName({
        posted: (v.createdAt && v.createdAt.toDate
          ? v.createdAt.toDate() : now).toISOString().slice(0, 10),
        institution: v.institution,
        department: v.department || [v.school, v.unit].filter(Boolean).join(', '),
        ref: v.ref,
        original: v.adUploadName || m[3],
      });

      const uploaded = await drive.uploadFile({
        token,
        folderId: folders.folderFor(config, year, m[2]),
        resourceKey: folders.resourceKeyHeader(config, year, m[2]),
        name,
        bytes,
        contentType: v.adUploadType || 'application/pdf',
      });

      /* Write the link BEFORE deleting the landing-strip object: a crash in
         between leaves a stray object in Storage (harmless, cleaned by hand)
         rather than a filed-and-forgotten upload with no link anywhere. */
      await d.ref.update({
        adUrl: uploaded.webViewLink,
        adDriveId: uploaded.id,
        adUploadPath: null, adUploadName: null, adUploadType: null, adUploadSize: null,
      });
      await file.delete().catch(() => {});

      log(`  filed advert for ${v.ref || d.id}: ${uploaded.name}`);
    } catch (e) {
      warn(`advert uploads: ${v.ref || d.id}: ${e.message} — left for the next run`);
    }
  }
}

/* ---------------------------------------------------------------------- main */

async function main() {
  if (argv.has('--selftest')) {
    /* The WHOLE suite, not runSelftest()'s three-suite subset — running this
       flag used to skip the merge/served-file/migration checks while printing
       a passing total, which reads as covered when it is not. The suite's own
       entry point already runs everything, so run it as itself. */
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(HERE, 'selftest.mjs')], { stdio: 'inherit' });
    process.exit(r.status === 0 ? 0 : 1);
  }

  const db = await firestore();

  /* NO DATABASE IS NOT NOTHING TO DO. The postings now have two sources — the
     submissions in Firestore and the maintainer's tracking sheet — and only
     the first needs credentials. This used to return here, which would have
     meant a site with Firebase unconfigured (or a run whose secret had
     expired) silently stopped publishing the sheet as well. So the run
     continues with an empty submission set, and says so. */
  if (!db) {
    if (!existsSync(SHEET)) {
      log('no Firebase credentials in this environment — nothing to publish.');
      log('(this is the expected state until the project is set up: v2/_SETUP-FIREBASE.md)');
      return;
    }
    log('no Firebase credentials — publishing the tracking sheet only.');
  }

  const col = db ? db.collection('jobSubmissions') : null;

  /* THE DATABASE IS THE SOURCE OF TRUTH, and data/jobs.json is its projection.
     This used to read only what was newly `queued` and merge it into the file,
     which meant an edit to an ALREADY-PUBLISHED posting changed nothing: the
     document was never read again. Reading the whole live set instead is what
     makes editing work at all — a posting is rebuilt from its document on
     every run, so a correction reaches the page the same way a new posting
     does. */
  const [liveSnap, pulledSnap] = db ? await Promise.all([
    col.where('status', 'in', ['queued', 'published']).get(),
    col.where('status', 'in', ['withdrawn', 'hidden']).get(),
  ]) : [{ docs: [] }, { docs: [] }];

  const live = liveSnap.docs;
  const pulled = pulledSnap.docs;
  const queued = live.filter((d) => d.data().status === 'queued');

  if (SCAN) {
    const sheeted = existsSync(SHEET) ? (await readJson(SHEET, [])).length : 0;
    log(`${live.length} live (${queued.length} of them newly queued), ` +
        `${pulled.length} withdrawn/hidden, ${sheeted} from the tracking sheet`);
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

  /* -------------------------------------------- file the uploaded adverts

     A posting can carry an advert the poster uploaded to the Storage landing
     strip (adUploadPath — see oa-jobform.js and _storage.rules). Before rows
     are built, each one is moved into the season's "Jobs Files" folder in the
     operations.academia@gmail.com Drive and the document gains the Drive link
     as its adUrl — so the SAME build publishes the posting with its File link.

     Filed under the CURRENT market year's folder, deliberately: "Current JM"
     is where files that arrive now belong, exactly as the Drive has always
     been organised — a posting back-dated to last season still produces a file
     that arrives today.

     WHOLLY NON-FATAL. Drive being down, a missing credential, an unconfigured
     season — each is warned about and the posting publishes WITHOUT its File
     link; the upload stays in Storage and the next run retries. A failure here
     must never stop the postings pipeline. */
  if (db) await transferUploads(db, live, { now });

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

  /* -------------------------------------- the job market tracking sheet

     The maintainer's own workbook, read into rows of this exact shape by
     sync-jobmarket-sheet.mjs. It is merged here rather than written into
     jobs.json directly, so that ONE writer produces the served file and the
     merge, the collapse and the id rules apply to every posting whatever its
     source.

     Its rows are the sheet's to add AND TO REMOVE: a row deleted from the
     sheet is gone from data/jobmarket.json, and must therefore leave the site
     too — otherwise the only way to unlist a sheet posting would be to add it
     to jobs-hidden.json by hand, which is the kind of parallel bookkeeping
     that rots. That is why they are excluded from the orphan carry below.

     A MISSING FILE IS NOT AN EMPTY SHEET, though: before the first sync has
     run — or if the file were ever lost — the sheet's postings are carried
     like any other orphan rather than deleted. Only a file that EXISTS and no
     longer lists a posting removes it. */
  const sheetPresent = existsSync(SHEET);
  const sheetRows = sheetPresent ? await readJson(SHEET, []) : [];
  const fromSheet = (r) => r.source === SHEET_SOURCE;
  if (sheetPresent) {
    const goneFromSheet = existing.filter(fromSheet).length -
      existing.filter((r) => fromSheet(r) && sheetRows.some((s) => s.id === r.id)).length;
    log(`the tracking sheet carries ${sheetRows.length} posting(s)` +
        (goneFromSheet > 0 ? `; ${goneFromSheet} previously published are no longer in it` : ''));
  }

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
  const orphans = existing.filter((r) =>
    !live_ids.has(r.id) &&
    !(sheetPresent && fromSheet(r)) &&
    !removeRefs.includes(r.ref));
  if (orphans.length) {
    warn(`${orphans.length} posting(s) in jobs.json have no document yet — carried ` +
         'unchanged. Run migrate-to-firestore.mjs to make them editable.');
  }

  const freshVisible = fresh.map((f) => f.row)
    .concat(sheetRows)
    .filter((r) => !hidden.has(r.ref) && !hidden.has(r.id));

  const merged = mergeRows(orphans, freshVisible, removeRefs);
  const publishable = merged.rows.filter((r) => !hidden.has(r.id) && !hidden.has(r.ref));

  /* -------------------------------------------- one spelling per place

     The form's option lists come from the postings themselves plus the site's
     own Universities directory, so a name a poster entered today is offered to
     the next poster tomorrow with nobody curating a list — and a university's
     schools, and each school's departments, are offered as a cascade.

     Built here rather than at write time because the postings are also passed
     through it: "Freeman School of Business" and "A.B. Freeman School of
     Business" are one school, and the site should not show both. Only the two
     name parts and the line they compose are touched, never `institution` —
     a posting's id and permalink are derived from that. */
  const directory = await readJson(DIRECTORY, []);
  const vocab = buildVocab(publishable, { generated: now.toISOString(), directory });
  const named = canonicaliseNames(publishable, vocab);
  const rows = named.rows;
  for (const c of named.changed) log(`  ~ ${c.id}  ${c.from}  ->  ${c.to}`);
  if (named.changed.length) {
    log(`${named.changed.length} posting(s) renamed to the spelling the site publishes`);
  }

  /* THE PAGE shows only the market year under way (owner, 2026-08-16), but
     the FILE stays complete: it is the projection of every live document, the
     source the migration reads, and the archive previous seasons live in.
     The filtering is the page's (jobs.html mirrors inCurrentMarket(), and the
     selftest pins the two together) — the build only reports the split. */
  const onPage = rows.filter((r) => inCurrentMarket(r, now)).length;
  if (onPage < rows.length) {
    log(`${rows.length - onPage} of ${rows.length} posting(s) are previous-market and off the page`);
  }

  /* What changed AGAINST THE SERVED FILE — the comparison a reader of this log
     actually means. mergeRows' own counters compare against the orphan carry,
     so on a normal run ("every posting has a document") they read "+95 new"
     when one posting is new and six were edited. Computed once, used for both
     the log and the admin e-mail, so the two can never tell different
     stories. */
  const changes = collectChanges(existing, freshVisible, removeRefs);

  const before = serialise(existing);
  const after = serialise(rows);

  if (before === after) {
    log('the dataset is already up to date — writing nothing.');
  } else {
    log(`jobs.json: +${changes.added} new, ${changes.edits.length} edited, ` +
        `${changes.takedowns.length} taken down  (${rows.length} total)`);
    const known = new Set(existing.map((r) => (r.ref ? 'ref:' + r.ref : 'id:' + r.id)));
    for (const r of freshVisible) {
      if (!known.has(r.ref ? 'ref:' + r.ref : 'id:' + r.id)) {
        log(`  + ${r.ref || r.id}  ${r.institution}`);
      }
    }
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

  /* vocab.json is written on ITS OWN diff, not with jobs.json: it also reads
     the Universities directory, which the legacy import can change on a day no
     posting moved. `generated` is ignored in the comparison, so an unchanged
     vocabulary commits nothing. */
  const vocabText = serialiseVocab(vocab);
  if (sameVocab(await readJson(VOCAB, null), vocab)) {
    log('the posting form\'s vocabulary is unchanged.');
  } else if (DRY) {
    log('--dry-run: not writing vocab.json.');
  } else {
    await writeFile(VOCAB, vocabText);
    log(`wrote ${path.relative(process.cwd(), VOCAB)} ` +
        `(${vocab.universities.length} universities, ${vocab.schools.length} schools, ` +
        `${vocab.units.length} departments)`);
  }

  /* ------------------------------------------ tell the admin what changed

     Every EDIT to a published posting, and every takedown, goes to the admin
     as a before/after — the owner's request: an edit goes live automatically,
     and the human finds out rather than having to notice. Computed from the
     rows (PUBLIC_FIELDS), so bookkeeping writes never produce an e-mail.

     Best-effort by design: with SMTP unset the mail plumbing PRINTS the
     message into this log instead — the record still exists, just not in an
     inbox — and a send failure never stops the publish; the change is already
     live, which is the point. */
  if (before !== after && !DRY) {
    try {
      if (changes.edits.length || changes.takedowns.length) {
        const mail = await import('./_mail.mjs');
        const tx = await mail.transport();
        const what = [
          changes.edits.length && `${changes.edits.length} edited`,
          changes.takedowns.length && `${changes.takedowns.length} taken down`,
        ].filter(Boolean).join(', ');
        await mail.send(tx, {
          to: process.env.ADMIN_NOTIFY || 'kstouras@gmail.com',
          subject: `[OA] Job postings changed: ${what}`,
          html: mail.shell({
            title: 'Job postings changed',
            bodyHtml: renderChangesHtml(changes),
            manageUrl: null,
          }),
        });
        log(`change e-mail: ${what} -> ${process.env.ADMIN_NOTIFY || 'kstouras@gmail.com'}` +
            (tx ? '' : ' (printed only — SMTP is not configured)'));
      }
    } catch (e) {
      warn(`change e-mail failed (${e.message}) — the changes are live regardless`);
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
