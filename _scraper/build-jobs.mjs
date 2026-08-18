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
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  rowFromSubmission, mergeRows, buildMeta, serialise, publicRow, displayOrder, assignIds,
  marketYear, inCurrentMarket, collectChanges, renderChangesHtml,
  MIRROR_STATUS, sheetMirrorDoc, mirrorDiffers, sheetHandover, removalSpecs, buildOwned,
  specMatches,
} from './jobs-model.mjs';
import { SOURCE as SHEET_SOURCE } from './jobmarket-sheet.mjs';
import { buildVocab, serialiseVocab } from './vocab.mjs';

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

/* ------------------------------------------- the tracking sheet's mirrors

   Keeps one inert document per workbook row, so the maintainer has an Edit
   button on every posting the site shows. See jobs-model.mjs above
   `sheetMirrorDoc` for what a mirror is and why the status alone carries the
   hand-over.

   THREE RULES, and the reasoning for each:

   CREATE only where nothing exists. The document id is the row's own id — the
   same convention migrate-to-firestore.mjs uses, so a posting that is later
   migrated is the same document rather than a second one — and an id is
   reused only after a `get()` proves it free. A blind `set()` would overwrite
   whatever happened to share the id, which for this collection means somebody
   else's advertisement.

   REFRESH only a mirror. The workbook goes on maintaining a posting nobody has
   edited, so a mirror is rewritten whenever the row moved under it. A document
   with any other status has been taken over and is never touched: that is the
   hand-over, and rewriting it would be the sheet reverting the maintainer's
   own edit — exactly the failure that retired the old form-sheet sync.

   DELETE a mirror whose row has left the workbook. Nothing published depends
   on it (an unedited row publishes from the sheet), so it is pure litter, and
   leaving it would put an Edit button on a posting that is no longer there. */
export async function syncSheetMirrors(col, sheetRows, mirrorDocs, claimed, { now = new Date() } = {}) {
  const mirrors = new Map();
  for (const d of mirrorDocs) mirrors.set(d.data().sheetId || d.id, d);

  let created = 0, refreshed = 0, deleted = 0, skipped = 0;

  for (const row of sheetRows) {
    if (claimed.has(row.id)) continue;                 // taken over; not ours to touch
    const id = String(row.id || '');
    // Firestore ids may not contain '/', which a row id never does (it is a
    // slug and a date) — checked rather than assumed, as the migration does.
    if (!/^[A-Za-z0-9._~-]+$/.test(id)) { skipped++; continue; }

    const fresh = sheetMirrorDoc(row, { now });
    const have = mirrors.get(row.id);

    if (have) {
      if (mirrorDiffers(have.data(), fresh)) {
        await col.doc(have.id).set(fresh);
        refreshed++;
      }
      continue;
    }

    /* Nothing mirrors this row yet. The id may still be in use by a document
       no query above returned — one already stamped `removed`, say — so it is
       probed before it is claimed. */
    const existing = await col.doc(id).get();
    if (existing.exists) { skipped++; continue; }
    await col.doc(id).set(fresh);
    created++;
  }

  const rowIds = new Set(sheetRows.map((r) => r.id));
  for (const [sid, d] of mirrors) {
    if (rowIds.has(sid)) continue;
    await col.doc(d.id).delete();
    deleted++;
  }

  if (created || refreshed || deleted) {
    log(`the tracking sheet's edit handles: +${created} new, ${refreshed} refreshed, ` +
        `${deleted} removed`);
  }
  if (skipped) {
    warn(`${skipped} of the tracking sheet's postings could not be given an edit handle ` +
         '(their id is already a document, or is not usable as one)');
  }
  return { created, refreshed, deleted, skipped };
}

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
  /* The third read is the tracking sheet's MIRRORS — the inert documents that
     give the maintainer an Edit button on a posting the workbook publishes
     (jobs-model.mjs, `sheetMirrorDoc`). They are deliberately outside the two
     queries above: a mirror publishes nothing and is never stamped, so it can
     only ever be read HERE, to decide whether it still matches the workbook. */
  const [liveSnap, pulledSnap, mirrorSnap] = db ? await Promise.all([
    col.where('status', 'in', ['queued', 'published']).get(),
    col.where('status', 'in', ['withdrawn', 'hidden']).get(),
    col.where('status', '==', MIRROR_STATUS).get(),
  ]) : [{ docs: [] }, { docs: [] }, { docs: [] }];

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

  /* ------------------------------------------ the job market tracking sheet

     Read BEFORE the submissions are turned into rows, because two decisions
     below need it: which of the workbook's rows the maintainer has taken over
     (those publish from their document instead), and which documents stand for
     a row the workbook no longer carries (those publish not at all — the sheet
     keeps saying which postings EXIST, whoever edits them).

     A MISSING FILE IS NOT AN EMPTY SHEET: before the first sync has run — or
     if the file were ever lost — the sheet's postings are carried like any
     other orphan rather than deleted. Only a file that EXISTS and no longer
     lists a posting removes it, and for the same reason a missing file claims
     nothing and hands nothing over. */
  const sheetPresent = existsSync(SHEET);
  const sheetRows = sheetPresent ? await readJson(SHEET, []) : [];
  const fromSheet = (r) => r.source === SHEET_SOURCE;
  const sheetIds = new Set(sheetRows.map((r) => r.id));

  /* ---------------------------------------- an editing handle on every row

     WHY THIS EXISTS: the Edit and Take down controls are drawn only where the
     page can name a document (oa-jobedit.js docIdFor), so the postings the
     workbook publishes — which had no document by design — carried no controls
     at all, and the maintainer could edit every posting on the site EXCEPT
     those. A mirror is an inert document (status `sheet`) that fixes precisely
     that and nothing else; the full reasoning is in jobs-model.mjs above
     `sheetMirrorDoc`.

     Non-fatal by construction: a failure here leaves the postings exactly as
     they are and only costs the maintainer the buttons until the next run. */
  const sheetDocs = new Map();   // sheet row id -> the document that stands for it
  for (const d of [...live, ...pulled]) {
    // `sheetId` is honoured only where the build wrote it — see `buildOwned`
    // in jobs-model.mjs. A submission a browser made carries a uid, and a
    // sheetId on one is a stranger claiming a workbook row's identity.
    const sid = buildOwned(d.data()) ? d.data().sheetId : '';
    if (sid) sheetDocs.set(sid, d);
  }
  /* Two different questions, and they are NOT the same set.

     `claimedSheetIds` — every workbook row that has a document of its own —
     answers "is this mirror still the sheet's to refresh?". It must be the
     WIDE set: a document the maintainer has taken over is never written by the
     workbook again, whatever state it is in.

     Which rows the workbook still PUBLISHES is answered later, from the rows
     that were actually built (`publishedFromDoc` below). The two were one set
     at first, and that was a way to lose a posting: a taken-over document that
     failed to build — an edit that cleared a required field, an unreadable
     document, a Firestore hiccup — produced no row, while its workbook copy
     had already been dropped, and the posting simply vanished from the site
     with only a warning in the log. A hand-over that cannot publish falls back
     to the workbook instead. */
  const claimedSheetIds = new Set(sheetDocs.keys());
  if (db && sheetPresent) {
    try {
      await syncSheetMirrors(col, sheetRows, mirrorSnap.docs, claimedSheetIds, { now });
    } catch (e) {
      warn(`the tracking sheet's edit handles could not be refreshed (${e.message}) — ` +
           'the postings publish regardless');
    }
  }

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
  const goneFromSheetDocs = [];
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
    /* A document the maintainer took over from the workbook still belongs to
       the workbook for one purpose: EXISTENCE. A row deleted there takes its
       posting off the site, edited or not — the property that made copying
       these rows into the database unsafe in the first place, kept here rather
       than given up. The document is left alone, so putting the row back in
       the workbook brings the maintainer's edit back with it. */
    const sid = buildOwned(d.data()) ? d.data().sheetId : '';
    if (sid && sheetPresent && !sheetIds.has(sid)) {
      goneFromSheetDocs.push(sid);
      continue;
    }
    if (row) {
      // `fixedId` is honoured by assignIds BEFORE it derives the others, so a
      // taken-over workbook posting keeps the workbook's own id without ever
      // colliding with a row this run derived.
      fresh.push({ id: d.id, key: d.id, row, sheetId: sid || '', fixedId: sid || '',
                   queued: d.data().status === 'queued' });
    } else rejected.push({ id: d.id, ref: d.data().ref || d.id });
  }

  for (const r of rejected) {
    warn(`submission ${r.ref} is missing required fields — left queued for review`);
  }

  /* Distinct ids, stably. Without this two postings from one institution on one
     day derive the same id and the second overwrites the first — which is how
     Tulane's and Houston's second departments disappeared. */
  assignIds(fresh);

  const existing = await readJobsStrict(JOBS);
  /* WHAT A TAKEDOWN IS KEYED ON, and why it is not only the reference.

     `ref` is the number the FORM issues. Nothing else does: the 94 postings the
     legacy import migrated and the 16 the tracking sheet publishes have none —
     which today is every single row in data/jobs.json. So the removal set was
     empty for all of them, the row was carried on as an ORPHAN (a row no live
     document accounts for is preserved, deliberately), and Take down marked
     the document hidden, said "Taken down", and left the posting on the site
     for ever.

     `removalSpecs` (jobs-model.mjs) decides whose word to take: a reference is
     scoped to its owner, and an id is honoured only on a document the build
     itself wrote. Both halves matter — the ids and the references alike are
     published in data/jobs.json, so an unscoped removal is a signed-in
     stranger deleting somebody else's advertisement. */
  const { specs: removeSpecs } = removalSpecs(pulled);

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
  if (sheetPresent) {
    const goneFromSheet = existing.filter(fromSheet).length -
      existing.filter((r) => fromSheet(r) && sheetRows.some((s) => s.id === r.id)).length;
    log(`the tracking sheet carries ${sheetRows.length} posting(s)` +
        (goneFromSheet > 0 ? `; ${goneFromSheet} previously published are no longer in it` : ''));
  }

  /* THE HAND-OVER. A row the maintainer has taken over publishes from its
     DOCUMENT, so the workbook's own copy is dropped here — rather than left to
     win the merge by arriving last, which is what it used to do and what would
     have made an edit look saved and change nothing.

     Dropped only where the document ACTUALLY ACCOUNTS FOR THE ROW, though:
     because it built one, or because it was deliberately taken down. Anything
     else — a document that failed to build, or one whose row the workbook has
     since dropped — leaves the workbook's copy in place, so the site keeps the
     posting it had rather than losing it to a bad edit. */
  const handover = sheetHandover({
    sheetRows,
    builtSheetIds: fresh.map((f) => f.sheetId).filter(Boolean),
    /* `buildOwned` HERE TOO. This was the one read of `sheetId` the provenance
       guard had been left off, and it is enough on its own: a withdrawn
       document naming a workbook row makes sheetHandover treat that row as
       handed over, so the workbook's copy is dropped — while the document
       publishes nothing, because every OTHER read of sheetId is guarded. The
       posting simply disappears, and `stranded` cannot even report it, since
       the row was never claimed. */
    pulledSheetIds: pulled.map((d) => (buildOwned(d.data()) ? d.data().sheetId : ''))
      .filter(Boolean),
    claimedSheetIds,
  });
  const { publishedFromDoc, stranded } = handover;

  const freshVisible = fresh.map((f) => f.row)
    .concat(handover.rows)
    .filter((r) => !hidden.has(r.ref) && !hidden.has(r.id));

  if (stranded.length) {
    warn(`${stranded.length} posting(s) the maintainer had taken over could not be built from ` +
         'their document — the tracking sheet\'s own copy is published instead, so nothing ' +
         `is lost: ${stranded.slice(0, 5).join(', ')}`);
  }
  if (publishedFromDoc.size) {
    log(`${publishedFromDoc.size} of the tracking sheet's postings are maintained here now ` +
        '(the maintainer edited or took them down); the workbook still decides whether they exist');
  }
  if (goneFromSheetDocs.length) {
    log(`${goneFromSheetDocs.length} posting(s) the maintainer had edited are no longer in the ` +
        'workbook — taken off the site with the rest of its removals');
  }

  /* A REMOVAL MUST NEVER TAKE A ROW SOMETHING ELSE JUST BUILT.

     Row ids are DERIVED — year, institution slug, posting date — and the `-2`
     that separates two postings from one school on one day is assigned among
     the rows built THAT RUN. So the moment one of a same-day pair is taken
     down, the survivor stops being `X-2` and becomes `X` … which is exactly
     the id the hidden document names. Reproduced end to end: taking down one
     Tulane posting deleted the OTHER one, silently and for good.

     A live document accounts for the row it built, so an id one of them now
     occupies is not a takedown, whatever a withdrawn document says about it. */
  const builtIds = new Set(freshVisible.map((r) => r.id));
  const applicable = removeSpecs.filter((x) => !x.id || !builtIds.has(x.id));
  const shadowed = removeSpecs.filter((x) => x.id && builtIds.has(x.id));
  if (shadowed.length) {
    log(`${shadowed.length} takedown(s) name an id a posting still being published now ` +
        'carries — a same-day sibling was renumbered; they are left alone');
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
    !applicable.some((x) => specMatches(x, r)));
  if (orphans.length) {
    warn(`${orphans.length} posting(s) in jobs.json have no document yet — carried ` +
         'unchanged. Run migrate-to-firestore.mjs to make them editable.');
  }

  const merged = mergeRows(orphans, freshVisible, applicable);
  const rows = merged.rows.filter((r) => !hidden.has(r.id) && !hidden.has(r.ref));

  /* ------------------------------------- the form's option lists

     Built from the postings themselves plus the site's own Universities
     directory, so a name a poster entered today is offered to the next poster
     tomorrow with nobody curating a list — and a university's schools, and
     each school's departments, are offered as a cascade rather than as three
     flat lists of everything.

     The names are already one-spelling-per-place: every posting went through
     oa-schools.js's canonPlace() at ingest, and buildVocab puts the directory
     rows — which have never been through an ingest — through the same
     function. */
  const directory = await readJson(DIRECTORY, null);
  if (!Array.isArray(directory) || !directory.length) {
    warn(`${path.relative(process.cwd(), DIRECTORY)} is missing or unreadable — the ` +
         'posting form will only offer the universities that have posted here.');
  }
  const vocab = buildVocab(rows, { generated: now.toISOString(), directory });

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
  const changes = collectChanges(existing, freshVisible, [],
    existing.filter((r) => applicable.some((x) => specMatches(x, r))).map((r) => r.id));

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

  /* A WITHDRAWAL IS RETIRED ONLY ONCE IT HAS ACTUALLY TAKEN EFFECT. `removed`
     takes the document out of the `withdrawn`/`hidden` query — it is the only
     handle the build has on that removal — so stamping one whose row is still
     published makes the failure PERMANENT, and silent: no later run can
     retry, and nothing anywhere says why the posting is still there. It used
     to be stamped unconditionally, which is what turned an owner-tag mismatch
     from one bad build into a posting that could never be taken down. */
  const stillThere = [];
  for (const d of pulled) {
    if (d.data().status !== 'withdrawn') continue;   // 'hidden' stays hidden
    const mine = removeSpecs.filter((x) => x.docId === d.id);
    if (mine.length && rows.some((r) => mine.some((x) => specMatches(x, r)))) {
      stillThere.push(d.data().ref || d.id);
      continue;
    }
    writes.push([d.id, { status: 'removed', removedAt: new Date() }]);
  }
  if (stillThere.length) {
    warn(`${stillThere.length} withdrawal(s) did not reach their posting and are left to ` +
         `retry rather than marked done: ${stillThere.slice(0, 5).join(', ')}`);
  }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const [id, patch] of writes.slice(i, i + 400)) batch.update(col.doc(id), patch);
    await batch.commit();
  }
  if (writes.length) log(`stamped ${writes.length} submission(s) in Firestore`);
}

/* Run only as the entry point, so the selftest can import syncSheetMirrors and
   drive it against a stand-in collection — the same guard migrate-to-firestore
   already uses. Importing this file used to RUN the build. */
/* `pathToFileURL`, not a template string: a raw path and a file URL are not the
   same text the moment the path holds a space or anything else a URL escapes
   (this repository already carries a directory called `back up`). Compared as
   strings, the two differ, main() is never called, and the process exits 0
   having printed nothing — a scheduled publish that goes green while
   publishing nothing, which is the worst failure available to it.

   The argv[1] guard is for `node -e`, where there is no entry script at all:
   pathToFileURL(undefined) throws, and this file is IMPORTED by the selftest
   as well as run. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // A build failure must not wedge the workflow into a red state forever; the
    // next scheduled run retries from the same queue.
    console.error('build-jobs failed:', err);
    process.exit(1);
  });
}
