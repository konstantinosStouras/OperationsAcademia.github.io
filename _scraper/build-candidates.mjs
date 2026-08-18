#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — publish queued candidate profiles into
   v2/data/candidates.json.

   The candidates twin of build-jobs.mjs, which is the file to read first —
   the pipeline, the ordering guarantees and the failure handling are the
   same, and the comments there carry the full reasoning:

       post-a-candidate.html -> Firestore candidateSubmissions -> THIS
                                        -> data/candidates.json
                                              |
                        candidates.html lazy-loads it -+

   Run on a schedule (see the workflow handoff in the change that adds this
   file). It is a NO-OP until FIREBASE_SERVICE_ACCOUNT is set, so it can be
   committed and scheduled before the Firebase project exists.

   It writes the dataset BEFORE stamping Firestore. If the run dies in
   between, the next run re-publishes the same rows (mergeCandidateRows
   replaces by reference, so this is idempotent) — whereas stamping first
   could lose a profile entirely.

   Modes:
     --dry-run    do everything, write nothing, print the diff
     --scan       report what is queued and exit
     --selftest   offline checks over the candidate model, no network
   --------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rowFromCandidateSubmission, mergeCandidateRows, buildCandidatesMeta,
  serialiseCandidates, publicCandidateRow, candidateDisplayOrder,
  assignCandidateIds, collapseSameCandidate, candidateId, freeList,
  CANDIDATE_PUBLIC_FIELDS, INFORMS_DAYS,
  revealGate,
} from './candidates-model.mjs';
import { marketYear, inCurrentMarket, ownerTag, removalSpecs, specMatches } from './jobs-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const CANDS = path.join(DATA, 'candidates.json');
const META = path.join(DATA, 'candidates-meta.json');

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

/** candidates.json, strictly — same reasoning as build-jobs' readJobsStrict:
    an UNREADABLE dataset must abort the run, because a parse error read as []
    means "no orphans" and the whole back-catalogue silently drops from the
    next write. A missing file is genuinely empty. */
async function readCandidatesStrict(file) {
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

/* -------------------------------------------------------------- uploads

   A profile carries up to TWO uploads — the CV and the research summary —
   where a job posting carries one advert. Each is its own slot with its own
   field family; a slot is filed independently, so a CV that transfers fine
   is not held hostage by a research summary that fails.                     */

const SLOTS = [
  { label: 'CV', url: 'cvUrl', driveId: 'cvDriveId',
    path: 'cvUploadPath', name: 'cvUploadName', type: 'cvUploadType', size: 'cvUploadSize' },
  { label: 'Research summary', url: 'rsUrl', driveId: 'rsDriveId',
    path: 'rsUploadPath', name: 'rsUploadName', type: 'rsUploadType', size: 'rsUploadSize' },
];

/** The update that clears one slot's landing-strip fields. */
function clearedSlot(slot) {
  return { [slot.path]: null, [slot.name]: null, [slot.type]: null, [slot.size]: null };
}

async function transferUploads(db, live, { now }) {
  // a document is pending when ANY slot has an upload waiting and no link —
  // the same "prefer the typed link" rule the old display tab's formula had:
  // a slot that already carries a URL is never overwritten by the upload.
  const pending = live.filter((d) => {
    const v = d.data() || {};
    return SLOTS.some((s) => v[s.path] && !v[s.url]);
  });
  if (!pending.length) return;

  let drive, folders;
  try {
    drive = await import('./drive-upload.mjs');
    folders = await import('./drive-folders.mjs');
  } catch (e) {
    warn(`candidate uploads: could not load the Drive client (${e.message}) — left for the next run`);
    return;
  }

  if (drive.missingCredentials().length) {
    warn(`candidate uploads: ${pending.length} waiting, but ` +
      `${drive.missingCredentials().join(', ')} not set — left for the next run`);
    return;
  }

  const bucket = await storageBucket();
  if (!bucket) {
    warn('candidate uploads: no Storage bucket available — left for the next run');
    return;
  }

  const config = JSON.parse(await readFile(path.join(DATA, 'drive-folders.json'), 'utf8'));
  const year = marketYear(now);

  let token;
  try {
    token = await drive.accessToken();
  } catch (e) {
    warn(`candidate uploads: ${e.message} — left for the next run`);
    return;
  }

  for (const d of pending) {
    const v = d.data();
    for (const slot of SLOTS) {
      if (!v[slot.path] || v[slot.url]) continue;
      try {
        /* The path is checked against the shape the Storage rules enforce
           rather than trusted — the field is client-writable, and an
           arbitrary path would let a poster exfiltrate any object the
           service account can read into a public Drive link. Pinned to the
           `candidates` kind (narrower than build-jobs' jobs|candidates):
           this document IS a candidate profile, so a path claiming to be a
           jobs upload is a mismatch, not a choice. */
        const m = /^uploads\/([^/]+)\/candidates\/([^/]+)$/.exec(String(v[slot.path]));
        if (!m) {
          warn(`candidate uploads: ${v.ref || d.id} has a malformed ${slot.label} path — cleared`);
          await d.ref.update(clearedSlot(slot));
          continue;
        }
        if (v.uid && m[1] !== v.uid) {
          warn(`candidate uploads: ${v.ref || d.id} ${slot.label} path does not belong to its poster — cleared`);
          await d.ref.update(clearedSlot(slot));
          continue;
        }

        const file = bucket.file(v[slot.path]);
        const [bytes] = await file.download();

        /* driveFileName's parameter names are jobs-shaped but its output is
           just "date  who — what  (ref)": here who is the candidate and what
           is which of their two documents this is, so the season's folder
           reads "2026-10-02 Jane Doe — CV (OA-CAND-…).pdf". */
        const name = drive.driveFileName({
          posted: (v.createdAt && v.createdAt.toDate
            ? v.createdAt.toDate() : now).toISOString().slice(0, 10),
          institution: [v.first, v.last].filter(Boolean).join(' '),
          department: slot.label,
          ref: v.ref,
          original: v[slot.name] || m[2],
        });

        const uploaded = await drive.uploadFile({
          token,
          folderId: folders.folderFor(config, year, 'candidates'),
          resourceKey: folders.resourceKeyHeader(config, year, 'candidates'),
          name,
          bytes,
          contentType: v[slot.type] || 'application/pdf',
        });

        /* Write the link BEFORE deleting the landing-strip object: a crash in
           between leaves a stray object in Storage (harmless, cleaned by
           hand) rather than a filed-and-forgotten upload with no link. */
        await d.ref.update({
          [slot.url]: uploaded.webViewLink,
          [slot.driveId]: uploaded.id,
          ...clearedSlot(slot),
        });
        await file.delete().catch(() => {});

        log(`  filed ${slot.label} for ${v.ref || d.id}: ${uploaded.name}`);
      } catch (e) {
        warn(`candidate uploads: ${v.ref || d.id} ${slot.label}: ${e.message} — left for the next run`);
      }
    }
  }
}

/* ---------------------------------------------------------------------- main */

async function main() {
  if (argv.has('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }

  const db = await firestore();
  if (!db) {
    log('no Firebase credentials in this environment — nothing to publish.');
    log('(this is the expected state until the project is set up: v2/_SETUP-FIREBASE.md)');
    return;
  }

  const col = db.collection('candidateSubmissions');

  /* THE DATABASE IS THE SOURCE OF TRUTH, and data/candidates.json is its
     projection — the whole live set is read on every run so an edit to an
     already-published profile is rebuilt from its document, exactly like a
     new one. See the long note in build-jobs.mjs. */
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
      log(`  queued  ${v.ref || d.id}  ${v.first} ${v.last} — ${v.affiliation}`);
    }
    for (const d of pulled) {
      const v = d.data();
      log(`  pulled  ${v.ref || d.id}  ${v.first} ${v.last}  (${v.status})`);
    }
    return;
  }

  const now = new Date();

  /* File the uploaded CVs and research summaries into the season's
     "Candidates Files" folder first, so the SAME build publishes each profile
     with its links. WHOLLY NON-FATAL — Drive down, a missing credential, an
     unconfigured season each warn and the profile publishes without that
     link; the upload stays in Storage and the next run retries. */
  await transferUploads(db, live, { now });

  const fresh = [];
  const rejected = [];
  for (const d of live) {
    let row = null;
    try {
      row = rowFromCandidateSubmission(d.data(), { now });
    } catch (e) {
      // One unreadable document must not kill the run — see build-jobs.mjs.
      warn(`submission ${d.data().ref || d.id} could not be read (${e.message}) — skipped`);
      continue;
    }
    if (row) fresh.push({ id: d.id, key: d.id, row, queued: d.data().status === 'queued' });
    else rejected.push({ id: d.id, ref: d.data().ref || d.id });
  }

  for (const r of rejected) {
    warn(`submission ${r.ref} is missing required fields — left queued for review`);
  }

  // Distinct ids, stably — two candidates sharing a name in one year.
  assignCandidateIds(fresh);

  const existing = await readCandidatesStrict(CANDS);
  /* Takedowns are keyed on the id as well as the reference — `ref` is issued
     by the FORM, so an imported row has none and hiding one used to change
     nothing at all. `removalSpecs` decides whose word to take: a reference is
     scoped to its owner, and an id is honoured only on a document the build
     itself wrote, because both are published and either one unscoped is a
     signed-in stranger taking down somebody else's row. The long note is in
     jobs-model.mjs; this is the same fix in the twin pipeline. */
  const { specs: removeSpecs, ids: removeIds } = removalSpecs(pulled);

  /* ONE predicate for "this run takes that row down" — a reference is only a
     takedown for the account that published the row. */
  const isRemoved = (r) => removeSpecs.some((x) => specMatches(x, r));


  // The maintainer's committed suppression list, same shape as
  // data/jobs-hidden.json ({refs:[], ids:[]}). Absent until first needed.
  const hide = await readJson(path.join(DATA, 'candidates-hidden.json'), {});
  const hidden = new Set([].concat(hide.ids || [], hide.refs || []));

  /* ORPHANS — rows in the served file no live document accounts for. Carried,
     not deleted, and reported: the file only ever shrinks because a profile
     was withdrawn or hidden. The consequence is the same as for jobs: taking
     a profile down is a STATUS CHANGE, never a document delete. */
  const liveIds = new Set(fresh.map((f) => f.row.id));
  const orphans = existing.filter((r) =>
    !liveIds.has(r.id) && !isRemoved(r));
  if (orphans.length) {
    warn(`${orphans.length} profile(s) in candidates.json have no document — carried unchanged.`);
  }

  const merged = mergeCandidateRows(
    orphans,
    fresh.map((f) => f.row).filter((r) => !hidden.has(r.ref) && !hidden.has(r.id)),
    removeSpecs);
  const { added, updated, removed } = merged;
  const rows = merged.rows.filter((r) => !hidden.has(r.id) && !hidden.has(r.ref));

  /* THE PAGE shows only the market year under way — the same predicate as
     jobs (inCurrentMarket reads only posted/year, so it applies verbatim).
     The FILE stays complete: it is the projection of every live document and
     the archive previous seasons live in. */
  const onPage = rows.filter((r) => inCurrentMarket(r, now)).length;
  if (onPage < rows.length) {
    log(`${rows.length - onPage} of ${rows.length} profile(s) are previous-market and off the page`);
  }

  /* THE REVEAL GATE (owner, 2026-08-16). Until the admin's date in
     data/candidates-reveal.json, the served file carries NO rows — it is
     world-readable, so a held-back profile must not be written into it at
     all. On the day, everyone appears at once. The meta still announces the
     date and how many profiles are waiting (a count, nothing else), which is
     what candidates.html shows in place of the list. */
  const reveal = revealGate(
    (await readJson(path.join(DATA, 'candidates-reveal.json'), {})).revealAt, now);
  const waiting = rows.filter((r) => inCurrentMarket(r, now));
  const projected = reveal.held ? [] : rows;
  if (reveal.held) {
    log(`reveal gate: ${waiting.length} profile(s) held until ` +
        (reveal.revealAt || '(no date announced yet)'));
  }

  const before = serialiseCandidates(existing);
  const after = serialiseCandidates(projected);

  if (before === after) {
    log('the dataset is already up to date — writing nothing.');
  } else {
    log(`candidates.json: +${added} new, ${updated} updated, ${removed} removed  (${projected.length} served)`);
    for (const f of fresh) log(`  + ${f.row.ref || f.row.id}  ${f.row.name}`);
    if (DRY) {
      log('--dry-run: not writing.');
    } else {
      await writeFile(CANDS, after);
      log(`wrote ${path.relative(process.cwd(), CANDS)}`);
    }
  }

  /* The meta is written on its OWN change, not the dataset's: during the held
     phase the dataset is a constant [] while heldCount moves with every new
     profile — and heldCount is what the page announces. */
  const meta = buildCandidatesMeta(projected, {
    generated: now.toISOString(),
    revealAt: reveal.revealAt,
    heldCount: reveal.held ? waiting.length : 0,
  });
  if (!DRY) {
    const prevMeta = await readJson(META, null);
    const changed = !prevMeta ||
      JSON.stringify({ ...prevMeta, generated: '' }) !== JSON.stringify({ ...meta, generated: '' });
    if (changed) {
      await writeFile(META, JSON.stringify(meta, null, 1) + '\n');
      log('wrote candidates-meta.json');
    }
  }

  if (DRY) return;

  /* Only now stamp Firestore — recoverable if it fails, and CHUNKED under
     Firestore's 500-writes-per-batch cap. See build-jobs.mjs. */
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

/* ------------------------------------------------------------------ selftest

   Offline checks over the candidate model — pure functions, no network, no
   credentials. The jobs suite (selftest.mjs) stays the jobs suite; these are
   the candidate-shaped assertions, runnable anywhere with
   `node v2/_scraper/build-candidates.mjs --selftest`.                        */

function selftest() {
  let passed = 0;
  const fails = [];
  const ok = (cond, what) => { if (cond) passed++; else fails.push(what); };
  const eq = (got, want, what) =>
    ok(JSON.stringify(got) === JSON.stringify(want),
      `${what}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);

  const now = new Date('2026-10-05T12:00:00Z');
  const base = {
    uid: 'uid-alpha-0001', ref: 'OA-CAND-261005-AAAA', status: 'queued',
    createdAt: new Date('2026-10-02T09:30:00Z'),
    year: 2027, first: 'Jane', last: 'Doe',
    affiliation: 'Wharton, University of Pennsylvania', position: 'PhD Candidate',
    researchAreas: ['Supply Chain Management', 'Behavioral Operations'],
    informsDays: ['Sunday', 'Tuesday'],
    cvUrl: 'https://example.org/jane-doe-cv.pdf',
    rsUrl: '', webUrl: 'https://janedoe.example.org',
    email: 'jane@example.org', emailPublic: false,
    note: 'private note for the maintainer', authEmail: 'jane@example.org',
  };

  /* ------------------------------------------------- mapping + sanitising */

  const row = rowFromCandidateSubmission(base, { now });
  ok(row, 'a complete submission maps to a row');
  eq(row.id, '2027-doe-jane', 'the id is YYYY-slug(last)-slug(first)');
  eq(row.name, 'Jane Doe', 'name is composed from first + last');
  eq(row.posted, '2026-10-02', 'posted comes from createdAt, never the client');
  eq(row.addedAt, '2026-10-02T09:30:00Z', 'addedAt is the second-resolution stamp');
  eq(row.owner, ownerTag('uid-alpha-0001'), 'owner is the uid digest, not the uid');

  // the disclosure gate: email reaches the row ONLY on an explicit opt-in
  eq(row.email, '', 'email is blank without the opt-in');
  eq(rowFromCandidateSubmission({ ...base, emailPublic: true }, { now }).email,
    'jane@example.org', 'email is carried with emailPublic === true');
  eq(rowFromCandidateSubmission({ ...base, emailPublic: 1 }, { now }).email, '',
    'a truthy non-boolean emailPublic is NOT an opt-in');
  eq(rowFromCandidateSubmission({ ...base, emailPublic: true, email: 'not an address' }, { now }).email,
    '', 'an opted-in junk address is dropped, not published');

  // links: dropped, never repaired
  const evil = rowFromCandidateSubmission({
    ...base,
    cvUrl: 'javascript:alert(1)',
    rsUrl: 'data:text/html,x',
    webUrl: 'ftp://example.org/cv.pdf',
  }, { now });
  eq([evil.cvUrl, evil.rsUrl, evil.webUrl], ['', '', ''],
    'javascript:/data:/ftp: links are dropped');

  // required fields: no card without who + where
  for (const k of ['first', 'last', 'affiliation', 'position']) {
    ok(rowFromCandidateSubmission({ ...base, [k]: '  ' }, { now }) === null,
      `a submission without ${k} is not publishable`);
  }

  // the vocabulary rules: days pinned, areas free but scrubbed and bounded
  const messy = rowFromCandidateSubmission({
    ...base,
    informsDays: ['Sunday', 'Saturday', 'SB15', 'Sunday', 'Tuesday'],
    researchAreas: ['  Queueing  Theory  ', 'Queueing Theory',
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
  }, { now });
  eq(messy.informsDays, ['Sunday', 'Tuesday'],
    'Saturday and legacy session codes are dropped from informsDays');
  eq(messy.researchAreas.length, 10, 'researchAreas is capped at 10');
  eq(messy.researchAreas[0], 'Queueing Theory',
    'areas are text()-scrubbed and deduplicated');

  // junk year falls back to the market year of the run
  eq(rowFromCandidateSubmission({ ...base, year: 200 }, { now }).year, marketYear(now),
    'a junk year falls back to the current market year');

  // postedOn (an Admin-SDK import) is honoured only when not later than stamped
  eq(rowFromCandidateSubmission({ ...base, postedOn: '2026-09-01' }, { now }).posted,
    '2026-09-01', 'an earlier postedOn is honoured');
  eq(rowFromCandidateSubmission({ ...base, postedOn: '2099-01-01' }, { now }).posted,
    '2026-10-02', 'a future postedOn cannot pin a card to the top');

  // a bogus createdAt (the 1e16 trap jobs hit) must not throw
  ok(rowFromCandidateSubmission({ ...base, createdAt: 1e16 }, { now }) !== undefined,
    'an unreadable createdAt does not throw');

  /* ------------------------------------------------------------- privacy */

  const pub = publicCandidateRow(row);
  for (const k of ['uid', 'authEmail', 'note', 'emailPublic', 'cvUploadPath',
    'rsUploadPath', 'status', 'createdAt']) {
    ok(!(k in pub), `publicCandidateRow never carries ${k}`);
  }
  ok(Object.keys(pub).every((k) => CANDIDATE_PUBLIC_FIELDS.includes(k)),
    'every published key is in CANDIDATE_PUBLIC_FIELDS');
  ok(!('email' in pub), 'an un-opted-in email is skipped entirely, not written empty');
  ok('email' in publicCandidateRow(
    rowFromCandidateSubmission({ ...base, emailPublic: true }, { now })),
    'an opted-in email is published');

  /* ---------------------------------------------------------------- merge */

  const rowB = rowFromCandidateSubmission({
    ...base, uid: 'uid-beta-0002', ref: 'OA-CAND-261003-BBBB',
    first: 'Ann', last: 'Lee', affiliation: 'MIT Sloan',
    createdAt: new Date('2026-10-03T10:00:00Z'),
  }, { now });

  let m = mergeCandidateRows([], [row, rowB]);
  eq([m.added, m.updated, m.removed], [2, 0, 0], 'two new rows are added');
  eq(m.rows.map((r) => r.id), ['2027-lee-ann', '2027-doe-jane'],
    'display order is newest posted first');

  // a correction replaces in place and keeps addedAt (the alerts cursor)
  const corrected = { ...row, position: 'Post-Doctoral Researcher', addedAt: '2026-10-05T00:00:00Z' };
  m = mergeCandidateRows(m.rows, [corrected]);
  eq([m.added, m.updated], [0, 1], 'a correction is an update, not an add');
  eq(m.rows.find((r) => r.id === '2027-doe-jane').addedAt, '2026-10-02T09:30:00Z',
    'a correction does not re-stamp addedAt');
  eq(m.rows.find((r) => r.id === '2027-doe-jane').position, 'Post-Doctoral Researcher',
    'the corrected field is what is kept');

  // withdrawal: only the owning account's {ref, owner} pair reaches the row
  m = mergeCandidateRows(m.rows, [], [{ ref: row.ref, owner: 'not-the-owner' }]);
  eq(m.removed, 0, 'a stranger cannot withdraw somebody else’s profile');
  m = mergeCandidateRows(m.rows, [], [{ ref: row.ref, owner: row.owner }]);
  eq(m.removed, 1, 'the owner’s withdrawal removes the row');

  // the maintainer's bare-string take-down reaches a row whoever posted it
  m = mergeCandidateRows([rowB], [], ['OA-CAND-261003-BBBB']);
  eq(m.removed, 1, 'the committed hidden list removes by bare ref');

  /* ------------------------------------------------------------- collapse */

  // same account, same person, posted twice: the later submission wins
  const again = rowFromCandidateSubmission({
    ...base, ref: 'OA-CAND-261004-CCCC',
    createdAt: new Date('2026-10-04T09:00:00Z'),
  }, { now });
  let c = collapseSameCandidate([row, again]);
  eq(c.collapsed, 1, 'one person twice in one year collapses to one row');
  eq(c.rows[0].ref, 'OA-CAND-261004-CCCC', 'the later submission is the one kept');

  // two DIFFERENT accounts claiming one name: first keeps the slot
  const imposter = rowFromCandidateSubmission({
    ...base, uid: 'uid-imposter-9', ref: 'OA-CAND-261005-DDDD',
    createdAt: new Date('2026-10-05T09:00:00Z'),
  }, { now });
  c = collapseSameCandidate([row, imposter]);
  eq(c.rows[0].ref, row.ref, 'a later account cannot displace an existing profile');

  // a site-made row (ref) beats an anonymous imported one, however full
  const imported = { ...row, ref: '', owner: '', note: undefined };
  c = collapseSameCandidate([imported, again]);
  eq(c.rows[0].ref, 'OA-CAND-261004-CCCC', 'an owned row beats an imported one');

  // the same person NEXT year is a new profile, left alone
  c = collapseSameCandidate([row, { ...row, year: 2028, id: '2028-doe-jane' }]);
  eq(c.collapsed, 0, 'a profile in the next market year does not collapse');

  /* -------------------------------------------------- ids + serialisation */

  // two real people sharing a name in one year: distinct, stable ids
  const twinA = { id: 'docA', key: 'docA', row: rowFromCandidateSubmission({ ...base, uid: 'u1', ref: 'R1' }, { now }) };
  const twinB = { id: 'docB', key: 'docB', row: rowFromCandidateSubmission({ ...base, uid: 'u2', ref: 'R2' }, { now }) };
  assignCandidateIds([twinB, twinA]);   // order of arrival must not matter
  eq([twinA.row.id, twinB.row.id], ['2027-doe-jane', '2027-doe-jane-2'],
    'name collisions suffix deterministically by document id');

  eq(candidateId({ year: 2027, first: 'Zoë', last: 'Núñez' }), '2027-nunez-zoe',
    'ids fold diacritics');

  const ser = serialiseCandidates(m.rows);
  eq(ser, serialiseCandidates(m.rows), 'serialisation is stable');
  ok(ser.endsWith('\n'), 'the file ends with a newline');
  eq(serialiseCandidates([]), '[]\n', 'the empty dataset is the committed placeholder');

  /* ----------------------------------------------------------------- meta */

  const meta = buildCandidatesMeta([row, rowB], { generated: 'g' });
  eq(meta.count, 2, 'meta counts the rows');
  eq(meta.years['2027'], 2, 'meta tallies years');
  eq(meta.newestPosted, '2026-10-03', 'meta carries the newest posting date');
  eq(meta.withCv, 2, 'meta counts profiles with a CV');

  /* -------------------------------------------------------------- helpers */

  /* ------------------------------------------------------ the reveal gate */

  const AUG = new Date('2026-08-16T12:00:00Z');
  eq(revealGate('2026-10-11', AUG).held, true, 'before the reveal date, profiles are held');
  eq(revealGate('2026-10-11', new Date('2026-10-10T23:59:59Z')).held, true,
    'held through the last second of the day before');
  eq(revealGate('2026-10-11', new Date('2026-10-11T00:00:00Z')).held, false,
    'ON the reveal day, everyone appears');
  eq(revealGate('2026-10-11', new Date('2027-01-01T00:00:00Z')).held, false,
    'and stays visible after');
  eq(revealGate('', AUG).held, true, 'no date announced = hold everything');
  eq(revealGate('soon', AUG).held, true, 'a malformed date can never reveal early');
  eq(revealGate('2026-10-11', AUG).revealAt, '2026-10-11', 'the gate echoes the date it parsed');
  const heldMeta = buildCandidatesMeta([], { generated: 'g', revealAt: '2026-10-11', heldCount: 7 });
  eq(heldMeta.heldCount, 7, 'the meta carries the waiting count for the page to announce');
  eq(heldMeta.revealAt, '2026-10-11', 'and the date');
  eq(heldMeta.count, 0, 'while the served row count is zero');

  eq(freeList('one value'), ['one value'], 'freeList accepts a scalar');
  eq(INFORMS_DAYS.length, 4, 'the INFORMS day vocabulary is Sunday-Wednesday');
  eq(candidateDisplayOrder({ posted: '2026-01-02' }, { posted: '2026-01-01' }) < 0, true,
    'newer posted sorts first');

  console.log(`build-candidates selftest: ${passed} checks passed` +
    (fails.length ? `, ${fails.length} FAILED` : ''));
  for (const f of fails) console.log('  FAIL  ' + f);
  return fails.length === 0;
}

main().catch((err) => {
  // A build failure must not wedge the workflow into a red state forever; the
  // next scheduled run retries from the same queue.
  console.error('build-candidates failed:', err);
  process.exit(1);
});
