#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — publish queued placement reports into
   v2/data/placements.json.

   The placements twin of build-jobs.mjs, minus the Drive leg (a placement has
   no file uploads):

       post-a-placement.html -> Firestore placementSubmissions -> THIS
                                        -> data/placements.json
                                             |
                       placements.html lazy-loads it -+

   Run on a schedule beside the jobs build. It is a NO-OP until
   FIREBASE_SERVICE_ACCOUNT is set, so it can be committed and scheduled
   before the Firebase project exists — the same discipline build-jobs.mjs
   and /lit/'s mailers use.

   It writes the dataset BEFORE stamping Firestore. If the run dies in
   between, the next run simply re-publishes the same rows
   (mergePlacementRows replaces by reference, so this is idempotent) —
   whereas stamping first could lose a report entirely.

   Modes:
     --dry-run    do everything, write nothing, print the diff
     --scan       report what is queued and exit
     --selftest   offline checks, no network, no credentials
   --------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rowFromPlacementSubmission, mergePlacementRows, buildPlacementsMeta, serialise,
  publicPlacementRow, assignPlacementIds, placementId, placementOrder,
  collapseSamePerson, samePersonKey, joiningLine, PLACEMENT_PUBLIC_FIELDS,
} from './placements-model.mjs';
import { marketYear, keyOf } from './jobs-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const PLACEMENTS = path.join(DATA, 'placements.json');
const META = path.join(DATA, 'placements-meta.json');

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

/** placements.json, strictly. An UNREADABLE dataset must abort the run, not
    stand in for an empty one: the orphan-carry below is what keeps rows with
    no live document alive, and a parse error read as [] means no orphans —
    the whole back-catalogue silently dropped from the next write, with every
    gate still green. A missing file is genuinely empty. */
async function readPlacementsStrict(file) {
  if (!existsSync(file)) return [];
  return JSON.parse(await readFile(file, 'utf8'));   // a SyntaxError kills the run, loudly
}

/* ------------------------------------------------------------------ firebase */

/** The Admin SDK, or null when this environment has no credentials. The same
    tolerant credential handling as build-jobs.mjs: the secret is commonly
    pasted base64-encoded, and a missing SDK is a warning, not a crash. */
async function firestore() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !raw.trim()) return null;

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
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
    process.exit(selftest() ? 0 : 1);
  }

  const db = await firestore();
  if (!db) {
    log('no Firebase credentials in this environment — nothing to publish.');
    log('(this is the expected state until the project is set up: v2/_SETUP-FIREBASE.md)');
    return;
  }

  const col = db.collection('placementSubmissions');

  /* THE DATABASE IS THE SOURCE OF TRUTH, and data/placements.json is its
     projection — the whole live set is read on every run, not just what is
     newly queued, because that is what makes EDITING work: a corrected
     report reaches the page the same way a new one does. (build-jobs.mjs
     documents the failure the narrower read caused.) */
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
      log(`  queued  ${v.ref || d.id}  ${v.first} ${v.last} — ${v.joiningInstitution}`);
    }
    for (const d of pulled) {
      const v = d.data();
      log(`  pulled  ${v.ref || d.id}  ${v.first} ${v.last}  (${v.status})`);
    }
    return;
  }

  const now = new Date();

  const fresh = [];
  const rejected = [];
  for (const d of live) {
    let row = null;
    try {
      row = rowFromPlacementSubmission(d.data(), { now });
    } catch (e) {
      // One unreadable document must not kill the run: it stays as it is, so
      // without this the next scheduled run dies on it too and no placement
      // is ever published again until a human finds it.
      warn(`submission ${d.data().ref || d.id} could not be read (${e.message}) — skipped`);
      continue;
    }
    if (row) fresh.push({ id: d.id, key: d.id, row, queued: d.data().status === 'queued' });
    else rejected.push({ id: d.id, ref: d.data().ref || d.id });
  }

  for (const r of rejected) {
    warn(`submission ${r.ref} is missing required fields — left queued for review`);
  }

  /* Distinct ids, stably: two people sharing a name in one market year derive
     the same id, and without this the second would overwrite the first in the
     merge — the jobs pipeline's Tulane/Houston failure in another shape. */
  assignPlacementIds(fresh);

  const existing = await readPlacementsStrict(PLACEMENTS);
  const removeRefs = pulled.map((d) => d.data().ref).filter(Boolean);

  /* The maintainer's take-down list, honoured if it ever exists. The file is
     NOT shipped — data/placements-hidden.json is created only when first
     needed — so the fallback {} is the normal state, and adding the file is
     all it takes to withhold a row (same contract as data/jobs-hidden.json). */
  const hide = await readJson(path.join(DATA, 'placements-hidden.json'), {});
  const hidden = new Set([].concat(hide.ids || [], hide.refs || []));

  /* ORPHANS — rows in the served file that no live document accounts for
     (imported rows before any migration has minted documents for them).
     Carried, and reported: the file only ever shrinks because a placement was
     withdrawn or hidden, never because a document is missing. The
     consequence, deliberate as in build-jobs.mjs: taking a placement down is
     a STATUS CHANGE, never deleting its document — a deleted document leaves
     its row orphaned and therefore preserved, the opposite of the intent. */
  const liveIds = new Set(fresh.map((f) => f.row.id));
  const orphans = existing.filter((r) => !liveIds.has(r.id) && !removeRefs.includes(r.ref));
  if (orphans.length) {
    warn(`${orphans.length} placement(s) in placements.json have no document yet — carried unchanged.`);
  }

  const merged = mergePlacementRows(
    orphans,
    fresh.map((f) => f.row).filter((r) => !hidden.has(r.ref) && !hidden.has(r.id)),
    removeRefs);
  const { added, updated, removed } = merged;
  const rows = merged.rows.filter((r) => !hidden.has(r.id) && !hidden.has(r.ref));

  const before = serialise(existing);
  const after = serialise(rows);

  if (before === after) {
    log('the dataset is already up to date — writing nothing.');
  } else {
    log(`placements.json: +${added} new, ${updated} updated, ${removed} removed  (${rows.length} total)`);
    for (const f of fresh) log(`  + ${f.row.ref || f.row.id}  ${f.row.name} -> ${f.row.joiningInstitution}`);
    if (DRY) {
      log('--dry-run: not writing.');
    } else {
      await writeFile(PLACEMENTS, after);
      await writeFile(
        META,
        JSON.stringify(buildPlacementsMeta(rows, { generated: now.toISOString() }), null, 1) + '\n'
      );
      log(`wrote ${path.relative(process.cwd(), PLACEMENTS)} and placements-meta.json`);
    }
  }

  if (DRY) return;

  /* Only now stamp Firestore. A failure here is recoverable: the row is
     already in the file, and re-publishing it next run replaces it in place.
     CHUNKED, because Firestore caps a batched write at 500 documents — one
     batch would collect a whole backlog and then throw on commit, AFTER the
     file was written, leaving every submission queued and re-collected
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

/* ------------------------------------------------------------------ selftest

   Offline, no network, no credentials — the placements twin of the checks
   selftest.mjs runs for jobs. The shared machinery (text/url/marketYear/
   keyOf/uniqueIds) is already covered there; these cover what THIS pipeline
   adds: the mapping, the privacy fence, the id minting, the person collapse
   and the merge semantics.                                                  */

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (cond, what) => { if (cond) pass++; else fails.push(what); };
  const eq = (actual, expected, what) => {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    ok(a === b, `${what}\n      expected ${b}\n      got      ${a}`);
  };

  const NOW = new Date('2026-08-16T12:00:00Z');

  const GOOD = {
    ref: 'OA-PLAC-260816-ABCD',
    year: 2027,
    first: 'Ada',
    last: 'Lovelace',
    phdInstitution: 'University College London',
    undergradInstitution: 'University of Cambridge',
    joiningInstitution: 'INSEAD',
    joiningPosition: 'Assistant Professor',
    webUrl: 'https://example.edu/~ada',
    createdAt: new Date('2026-08-15T09:00:00Z'),
    // things that must NEVER reach the served file
    email: 'ada@example.edu',
    authEmail: 'ada@example.edu',
    note: 'private note to the maintainer',
    uid: 'u_secret_uid_value',
    status: 'queued',
    source: 'oa-form',
  };

  /* ------------------------------------------------------------ the mapping */

  const r = rowFromPlacementSubmission(GOOD, { now: NOW });
  ok(r !== null, 'a complete submission maps to a row');
  eq(r.name, 'Ada Lovelace', 'name is derived from first + last');
  eq(r.id, '2027-lovelace-ada', "placementId is 'YYYY-slug(last)-slug(first)'");
  eq(r.year, 2027, 'year carried');
  eq(r.addedAt, '2026-08-15T09:00:00Z', 'addedAt comes from createdAt');
  eq(r.webUrl, 'https://example.edu/~ada', 'website carried');
  eq(r.owner.length, 16, 'owner is the 16-hex uid digest, never the uid');
  ok(r.owner !== GOOD.uid, 'the raw uid is not the owner tag');

  // the privacy fence, both layers: not on the row, not in the public row
  ok(!('email' in r) && !('authEmail' in r) && !('note' in r) && !('uid' in r),
    'email/authEmail/note/uid never land on the row object');
  const pub = JSON.stringify(publicPlacementRow(r));
  ok(!pub.includes('ada@example.edu') && !pub.includes('private note') &&
     !pub.includes('u_secret'),
    'nothing private reaches the serialised public row');

  // each required field, absent, kills the row rather than a broken card
  for (const k of ['first', 'last', 'phdInstitution', 'joiningInstitution']) {
    ok(rowFromPlacementSubmission({ ...GOOD, [k]: '  ' }, { now: NOW }) === null,
      `a submission without ${k} is not publishable`);
  }
  ok(rowFromPlacementSubmission({ ...GOOD, joiningPosition: '' }, { now: NOW }) !== null,
    'a missing position does not kill the row (older imports have none)');

  eq(rowFromPlacementSubmission({ ...GOOD, year: 'nonsense' }, { now: NOW }).year,
    marketYear(NOW), 'a bad year falls back to the market year under way');
  eq(rowFromPlacementSubmission({ ...GOOD, webUrl: 'javascript:alert(1)' }, { now: NOW }).webUrl,
    '', 'a javascript: website is dropped, not repaired');

  // the total-timestamp guard: a bogus createdAt must not kill the run
  let bogus = null;
  try {
    bogus = rowFromPlacementSubmission({ ...GOOD, createdAt: 1e16 }, { now: NOW });
  } catch (e) {
    ok(false, 'createdAt: 1e16 must not throw (' + e.message + ')');
  }
  ok(bogus && bogus.addedAt === NOW.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'an unreadable createdAt falls back to now');

  /* ------------------------------------------------------------- rendering */

  eq(joiningLine('Assistant Professor', 'INSEAD'), 'Assistant Professor, INSEAD',
    'joining line joins position and institution');
  eq(joiningLine('', 'INSEAD'), 'INSEAD', "no leading ', ' when the position is empty");
  eq(joiningLine('Assistant Professor', ''), 'Assistant Professor',
    'no trailing comma when the institution is empty');

  /* ------------------------------------------------------------------- ids */

  const twins = [
    { key: 'docB', row: rowFromPlacementSubmission({ ...GOOD, phdInstitution: 'MIT' }, { now: NOW }) },
    { key: 'docA', row: rowFromPlacementSubmission(GOOD, { now: NOW }) },
  ];
  assignPlacementIds(twins);
  const ids = twins.map((t) => t.row.id).sort();
  eq(ids, ['2027-lovelace-ada', '2027-lovelace-ada-2'],
    'namesakes get distinct ids');
  // stability: the suffix follows the document id, not arrival order
  const again = [
    { key: 'docA', row: rowFromPlacementSubmission(GOOD, { now: NOW }) },
    { key: 'docB', row: rowFromPlacementSubmission({ ...GOOD, phdInstitution: 'MIT' }, { now: NOW }) },
  ];
  assignPlacementIds(again);
  eq(again.find((t) => t.key === 'docB').row.id,
    twins.find((t) => t.key === 'docB').row.id,
    'the same document keeps the same id whichever order Firestore returns');

  /* ---------------------------------------------------------- the collapse */

  const early = { ...rowFromPlacementSubmission(GOOD, { now: NOW }), addedAt: '2026-08-10T00:00:00Z' };
  const late = { ...rowFromPlacementSubmission(GOOD, { now: NOW }), addedAt: '2026-08-15T00:00:00Z' };
  late.ref = 'OA-PLAC-260815-LATE';
  {
    const { rows, collapsed } = collapseSamePerson([early, late]);
    eq(collapsed, 1, 'the same person twice collapses to one row');
    eq(rows[0].ref, 'OA-PLAC-260815-LATE',
      'same account, later report wins — the correction is what they meant');
  }
  {
    const stranger = { ...late, owner: 'somebody-else-16h', ref: 'OA-PLAC-260815-XXXX' };
    const { rows } = collapseSamePerson([early, stranger]);
    eq(rows[0].ref, GOOD.ref,
      'different accounts: whoever reported first keeps the slot');
  }
  {
    const namesake = rowFromPlacementSubmission({ ...GOOD, phdInstitution: 'MIT' }, { now: NOW });
    const { collapsed } = collapseSamePerson([rowFromPlacementSubmission(GOOD, { now: NOW }), namesake]);
    eq(collapsed, 0, 'a namesake from another PhD is a different person — kept');
  }
  ok(samePersonKey({ year: 2027, last: 'Löv', first: 'Ada', phdInstitution: 'UCL' })
     === samePersonKey({ year: 2027, last: 'Lov', first: 'ADA', phdInstitution: 'ucl' }),
    'the person key folds case and diacritics');

  /* -------------------------------------------------------------- the merge */

  const committed = [rowFromPlacementSubmission(GOOD, { now: NOW })];
  const corrected = rowFromPlacementSubmission(
    { ...GOOD, joiningPosition: 'Assistant Professor of Operations', createdAt: NOW }, { now: NOW });
  {
    const m = mergePlacementRows(committed, [corrected]);
    eq(m.updated, 1, 'a correction replaces by (owner, ref)');
    eq(m.rows[0].joiningPosition, 'Assistant Professor of Operations', 'the correction lands');
    eq(m.rows[0].addedAt, '2026-08-15T09:00:00Z',
      'a replacement never re-stamps addedAt');
  }
  {
    // a stranger carrying the published ref must not replace the row
    const thief = { ...corrected, owner: 'attacker-owner16', last: 'Thief',
      name: 'Ada Thief', id: '2027-thief-ada' };
    const m = mergePlacementRows(committed, [thief]);
    eq(m.added, 1, "someone else's submission with a stolen ref is a NEW row, not a replacement");
    ok(m.rows.some((x) => x.last === 'Lovelace'), 'the original row survives');
  }
  {
    const m = mergePlacementRows(committed, [], [{ ref: GOOD.ref, owner: committed[0].owner }]);
    eq(m.removed, 1, 'the owner can withdraw their placement');
    eq(m.rows.length, 0, 'and the row leaves the file');
  }
  {
    const m = mergePlacementRows(committed, [], [{ ref: GOOD.ref, owner: 'someone-else' }]);
    eq(m.removed, 0, "a stranger's withdrawal removes nothing");
  }
  {
    const m = mergePlacementRows(committed, [], [GOOD.ref]);
    eq(m.removed, 1, "the maintainer's bare-ref take-down reaches the row whoever posted it");
  }
  {
    // orphan-carry is the caller's job; the merge must simply keep existing
    // rows it was handed and that no fresh row replaces — a DIFFERENT person,
    // or the person collapse would (rightly) fold the two into one
    const orphan = { ...committed[0], ref: '', owner: '', first: 'Grace', last: 'Hopper',
      name: 'Grace Hopper', id: '2027-hopper-grace' };
    const m = mergePlacementRows([orphan], [corrected]);
    eq(m.rows.length, 2, 'an orphan row without a document survives the merge');
    // and the same person arriving as document AND orphan heals into one row
    const healed = mergePlacementRows([{ ...committed[0], ref: '', owner: '', id: 'x' }], [corrected]);
    eq(healed.rows.length, 1,
      'the same person as orphan + document collapses to the fuller row');
  }

  /* --------------------------------------------------------------- ordering */

  const y26 = { ...rowFromPlacementSubmission({ ...GOOD, year: 2026 }, { now: NOW }), addedAt: '2026-08-15T09:00:00Z' };
  const y27 = rowFromPlacementSubmission(GOOD, { now: NOW });
  eq([y26, y27].sort(placementOrder)[0].year, 2027, 'newest market year first');
  ok(placementOrder(early, late) > 0, 'within a year, newest report first');

  /* ------------------------------------------------------------- companions */

  const meta = buildPlacementsMeta([y26, y27], { generated: NOW.toISOString() });
  eq(meta.count, 2, 'meta count');
  eq(meta.years, { 2026: 1, 2027: 1 }, 'meta year tally');
  eq(meta.newestAdded, '2026-08-15T09:00:00Z', 'meta newestAdded');

  /* ---------------------------------------------------------- serialisation */

  eq(serialise([]), '[]\n',
    'an empty dataset serialises to exactly the shipped placeholder');
  const s1 = serialise([y27]);
  ok(s1 === serialise([y27]), 'serialisation is stable — same rows, same bytes');
  ok(s1.endsWith('\n'), 'the file ends with a newline');
  const parsed = JSON.parse(s1);
  eq(Object.keys(parsed[0]),
    PLACEMENT_PUBLIC_FIELDS.filter((k) => parsed[0][k] !== undefined),
    'public rows keep the declared field order');
  {
    const noRef = { ...y27, ref: '', owner: '' };
    const p = JSON.parse(serialise([noRef]))[0];
    ok(!('ref' in p) && !('owner' in p),
      'an empty ref/owner is elided rather than written as ""');
  }

  /* ------------------------------------------------ the shipped file itself */

  try {
    const raw = existsSync(PLACEMENTS) ? readFileSync(PLACEMENTS, 'utf8') : '[]\n';
    const rows = JSON.parse(raw);
    ok(Array.isArray(rows), 'data/placements.json is an array');
    const seen = new Set();
    ok(rows.every((x) => x.id && !seen.has(x.id) && seen.add(x.id)),
      'every committed row has a distinct id');
    ok(!/"email"|"authEmail"|"uid"|"note"/.test(raw),
      'the committed file carries nothing private');
  } catch (e) {
    ok(false, 'data/placements.json is readable (' + e.message + ')');
  }

  console.log(fails.length
    ? `placements selftest: ${pass} passed, ${fails.length} FAILED`
    : `placements selftest: all ${pass} checks passed`);
  for (const f of fails) console.log('  FAIL ' + f);
  return fails.length === 0;
}

main().catch((err) => {
  // A build failure must not wedge the workflow into a red state forever; the
  // next scheduled run retries from the same queue.
  console.error('build-placements failed:', err);
  process.exit(1);
});
