#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — each candidate's PRIVATE view statistics: how often
   their own profile card was opened on the site and how often its CV link
   was clicked, this season and per day.

       node _scraper/build-candidate-stats.mjs [--dry-run] [--selftest]

   WHERE THE NUMBERS COME FROM. The site's own first-party usage record
   (assets/oa-usage.js, Firestore `usageSessions`, the source build-analytics
   already reads): every click on a list card carries the card's element id
   (`c`, 'job-<row id>') and, when the click OPENED the card, `o: 1`. A card
   open is therefore a click with `c` naming the candidate's card and `o` set;
   a CV click is an `a` whose href IS the profile's cvUrl, or a link inside
   the card whose label reads CV.

   WHICH CARD IS THEIRS is decided the way build-candidates.mjs decides it,
   through the model and never a copy: rowFromCandidateSubmission over every
   live document and assignCandidateIds keyed on the document id, so two
   people sharing a name in one season take the same `-2` here as on the
   site. And the SERVED file is asked first, by `ref` — the reference the form
   issues, unique per submission, the one key here that identifies a
   submission rather than a name and a year (the `matchServed` lesson in
   submissions-review.mjs). A card that is not in data/candidates.json was
   never on the site, so there is nothing to count for it — which is also
   what makes the reveal gate honest: before the reveal day the served file
   is empty, nothing is counted, and the owner's panel says so.

   WHOSE CLICKS DO NOT COUNT. Sessions filed under the profile's own account
   (its uid, and the uid it was merged from) — a candidate re-reading their
   own card is not a hiring committee; and the maintainer's, by the admin
   address usageSessions carries for a signed-in session. Anonymous sessions
   count: a reader who has not signed in still opened the card.

   WHERE THE NUMBERS GO. Onto the candidate's OWN candidateSubmissions
   document, as a bounded `stats` map — the owner can already read that one
   document and nobody else can, so there is no new collection, no new read
   rule, and nothing reaches data/, which Pages serves to anyone who asks.
   The rules let an owner CARRY the map through their own edits and never
   write it (statsUntouched in _firestore.rules). A stamp lands only on a
   document the build has marked 'published': the Cloud Function that rings
   the build ignores that state, so a daily stamp never rings anything.

   Inert without FIREBASE_SERVICE_ACCOUNT, like every builder here. NOT in
   build-all.mjs's BUILDERS: it writes no data/ file, and it is called from
   oa-analytics.yml beside the read it shares.
   --------------------------------------------------------------------------- */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMain } from './_main.mjs';
import { rowFromCandidateSubmission, assignCandidateIds } from './candidates-model.mjs';
import { marketStart } from './jobs-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CANDS = path.join(ROOT, 'data', 'candidates.json');

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/** How many days the per-day map keeps: the newest DAY_CAP. The season totals
    are NOT capped — they count every click since the season began. */
export const DAY_CAP = 120;

/** The maintainer, whose own sessions are never counted. Keep in sync with
    isAdmin() in _firestore.rules. */
export const ADMIN_EMAILS = ['kstouras@gmail.com'];

/** How many session documents one run reads at most (the analytics build's
    own ceiling). Hitting it is reported, never silent. */
export const READ_CAP = 50000;

export const isoDay = (ms) => {
  const d = new Date(Number(ms));
  return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
};

const str = (v) => (v == null ? '' : String(v)).trim();

/* --------------------------------------------------------------- the cards */

/**
 * Which card, and which CV link, belongs to each document.
 *
 *   docs    [{ id, data }]  the live candidateSubmissions documents
 *   served  the rows of data/candidates.json
 *
 * Returns a Map docId -> { ids:Set, cvUrls:Set, uids:Set, published:bool }.
 * `ids` holds the ONE card id the document answers for on the site; it is
 * empty (and `published` false) when the card is not in the served file, or
 * when the derived id is held in the served file by a DIFFERENT submission
 * (a name collision the build resolved the other way) — "not sure" means
 * count nothing, never count somebody else's card.
 */
export function cardsFor(docs, served, { now = new Date() } = {}) {
  const fresh = [];
  for (const d of docs) {
    let row = null;
    try { row = rowFromCandidateSubmission(d.data || {}, { now }); } catch { row = null; }
    if (row) fresh.push({ key: d.id, row });
  }
  assignCandidateIds(fresh);
  const derived = new Map(fresh.map((f) => [f.key, f.row.id]));

  const byRef = new Map();
  const byId = new Map();
  for (const r of served || []) {
    if (!r || !r.id) continue;
    byId.set(String(r.id), r);
    if (r.ref) byRef.set(String(r.ref), r);
  }

  const out = new Map();
  for (const d of docs) {
    const v = d.data || {};
    const ids = new Set();
    const cvUrls = new Set();
    const uids = new Set([str(v.uid), str(v.mergedFrom)].filter(Boolean));

    let row = null;
    if (v.ref && byRef.has(str(v.ref))) {
      row = byRef.get(str(v.ref));
    } else {
      const id = derived.get(d.id);
      const held = id ? byId.get(id) : null;
      // a served row under this id that names ANOTHER submission's ref is not ours
      if (held && !(held.ref && v.ref && str(held.ref) !== str(v.ref)) &&
          !(held.ref && !v.ref)) row = held;
    }
    if (row) {
      ids.add(String(row.id));
      if (row.cvUrl) cvUrls.add(str(row.cvUrl));
    }
    if (v.cvUrl && ids.size) cvUrls.add(str(v.cvUrl));
    out.set(d.id, { ids, cvUrls, uids, published: ids.size > 0 });
  }
  return out;
}

/* -------------------------------------------------------------- attribution */

const CV_LABEL = /\bCV\b/;

/** The ROW id a click's card element id names: the engine gives every card
    the element id 'job-<row id>' (candidates included), and `c` carries the
    element id. Anything not of that shape names no card. */
export function cardIdOf(click) {
  const c = str(click && click.c);
  return c.startsWith('job-') ? c.slice(4) : '';
}

/** What ONE click means for ONE card: 'open', 'cv' or null. Pure. */
export function attribute(click, card) {
  if (!click || !card) return null;
  const c = cardIdOf(click);
  const inCard = !!c && card.ids.has(c);
  if (inCard && click.o === 1) return 'open';
  if (str(click.k) === 'a') {
    const h = str(click.h);
    if (h && card.cvUrls.has(h)) return 'cv';
    if (inCard && CV_LABEL.test(str(click.x))) return 'cv';
  }
  return null;
}

/**
 * Count the season for every card.
 *
 *   sessions  [{ uid, email, clicks:[{t,k,x,h,c,o}] }]
 *   cards     the Map cardsFor() returns
 *   from      epoch ms; clicks before it are ignored (the season start)
 *
 * Returns a Map docId -> { opens, cvClicks, days: { 'YYYY-MM-DD': [o, c] } }
 * for every PUBLISHED card, zeros included.
 */
export function tally(sessions, cards, { from = 0, adminEmails = ADMIN_EMAILS } = {}) {
  const out = new Map();
  const byCardId = new Map();
  const byCv = new Map();
  for (const [docId, card] of cards) {
    if (!card.published) continue;
    out.set(docId, { opens: 0, cvClicks: 0, days: {} });
    for (const id of card.ids) byCardId.set(id, docId);
    for (const u of card.cvUrls) byCv.set(u, docId);
  }
  const admins = new Set((adminEmails || []).map((e) => str(e).toLowerCase()));

  const bump = (docId, kind, t) => {
    const s = out.get(docId);
    const day = isoDay(t);
    if (!s || !day) return;
    const cell = s.days[day] || (s.days[day] = [0, 0]);
    if (kind === 'open') { s.opens++; cell[0]++; } else { s.cvClicks++; cell[1]++; }
  };

  for (const sess of sessions || []) {
    const uid = str(sess && sess.uid);
    const email = str(sess && sess.email).toLowerCase();
    if (email && admins.has(email)) continue;             // the maintainer
    for (const click of (sess && Array.isArray(sess.clicks)) ? sess.clicks : []) {
      const t = Number(click && click.t);
      if (!t || t < from) continue;
      const candidates = new Set();
      const c = cardIdOf(click);
      if (c && byCardId.has(c)) candidates.add(byCardId.get(c));
      const h = str(click.h);
      if (h && byCv.has(h)) candidates.add(byCv.get(h));
      for (const docId of candidates) {
        const card = cards.get(docId);
        if (card.uids.has(uid)) continue;                 // the candidate's own account
        const kind = attribute(click, card);
        if (kind) bump(docId, kind, t);
      }
    }
  }
  return out;
}

/** The newest `cap` days of a per-day map, keys sorted. Pure. */
export function capDays(days, cap = DAY_CAP) {
  const keys = Object.keys(days || {}).sort();
  const kept = keys.slice(Math.max(0, keys.length - cap));
  const out = {};
  for (const k of kept) out[k] = days[k];
  return out;
}

/** The bounded map written onto the candidate's document. */
export function statsFor(t, { now = new Date(), cap = DAY_CAP } = {}) {
  return {
    opens: Number(t && t.opens) || 0,
    cvClicks: Number(t && t.cvClicks) || 0,
    days: capDays((t && t.days) || {}, cap),
    updatedAt: now.toISOString(),
  };
}

/** Two stats maps carrying the same figures (`updatedAt` aside). */
export function sameFigures(a, b) {
  const strip = (s) => JSON.stringify({
    opens: Number(s && s.opens) || 0,
    cvClicks: Number(s && s.cvClicks) || 0,
    days: capDays((s && s.days) || {}),
  });
  return strip(a) === strip(b);
}

/* ---------------------------------------------------------------- firestore */

/** The same credential handling as build-analytics.mjs. */
function creds(envName) {
  const raw = process.env[envName];
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      warn(`${envName} is set but is neither JSON nor base64 JSON`);
      return null;
    }
  }
}

async function firestore() {
  const c = creds('FIREBASE_SERVICE_ACCOUNT');
  if (!c) return null;
  let admin;
  try {
    admin = await import('firebase-admin');
  } catch {
    warn('firebase-admin is not installed — run `npm i firebase-admin` in the workflow');
    return null;
  }
  const app = admin.default || admin;
  const apps = Array.isArray(app.apps) ? app.apps : [];
  if (!apps.length) app.initializeApp({ credential: app.credential.cert(c) });
  return app.firestore();
}

async function readServed() {
  if (!existsSync(CANDS)) return [];
  try {
    const rows = JSON.parse(await readFile(CANDS, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    warn(`could not parse data/candidates.json (${e.message}) — counting nothing this run`);
    return null;
  }
}

async function main() {
  if (argv.has('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }

  const db = await firestore();
  if (!db) {
    log('candidate stats: no FIREBASE_SERVICE_ACCOUNT in this environment — nothing to do.');
    return;
  }

  const served = await readServed();
  if (served === null) return;          // an unreadable served file changes nothing

  const now = new Date();
  const from = Date.parse(marketStart(now) + 'T00:00:00Z');

  const liveSnap = await db.collection('candidateSubmissions')
    .where('status', 'in', ['queued', 'published']).get();
  const docs = liveSnap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
  const cards = cardsFor(docs, served, { now });
  const published = [...cards.values()].filter((c) => c.published).length;
  log(`candidate stats: ${docs.length} live profile(s), ${published} on the site ` +
      `(${served.length} served row(s)); counting from ${marketStart(now)}`);
  if (!published) {
    log('nothing is on the site yet — nothing to count, nothing written.');
    return;
  }

  const snap = await db.collection('usageSessions')
    .orderBy('start').where('start', '>=', from).limit(READ_CAP).get();
  if (snap.size >= READ_CAP) {
    warn(`usageSessions: the read hit its ${READ_CAP}-document ceiling — the season's ` +
         'earliest sessions may be missing from the totals');
  }
  const sessions = snap.docs.map((d) => d.data() || {});
  const counts = tally(sessions, cards, { from });
  log(`read ${sessions.length} session(s)`);

  /* Only a document the build has marked 'published' is stamped: a client
     state (queued, withdrawn, hidden) is what publishOnCandidateChange rings
     the build on, and a daily bookkeeping write must ring nothing. A profile
     mid-edit is simply counted next run. */
  const writes = [];
  for (const d of docs) {
    const t = counts.get(d.id);
    if (!t) continue;
    if (str(d.data.status) !== 'published') {
      log(`  ${d.data.ref || d.id}: ${t.opens} open(s), ${t.cvClicks} CV click(s) — ` +
          `status ${d.data.status}, stamped next run`);
      continue;
    }
    const stats = statsFor(t, { now });
    const changed = !sameFigures(d.data.stats, stats);
    log(`  ${d.data.ref || d.id}: ${stats.opens} open(s), ${stats.cvClicks} CV click(s), ` +
        `${Object.keys(stats.days).length} day(s)${changed ? '' : ' (unchanged)'}`);
    writes.push([d.id, stats]);
  }

  if (DRY) {
    log(`--dry-run: ${writes.length} document(s) would be stamped; nothing written.`);
    return;
  }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const [id, stats] of writes.slice(i, i + 400)) {
      batch.update(db.collection('candidateSubmissions').doc(id), { stats });
    }
    await batch.commit();
  }
  log(`stamped ${writes.length} document(s).`);
}

/* ------------------------------------------------------------------ selftest */

export function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (cond, what) => { if (cond) pass++; else fails.push(what); };
  const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b),
    `${what}\n     got:  ${JSON.stringify(a)}\n     want: ${JSON.stringify(b)}`);

  const now = new Date('2026-10-20T12:00:00Z');
  const base = {
    uid: 'cand-uid-1', status: 'published', ref: 'OA-CAND-260901-AAAA',
    first: 'Jane', last: 'Doe', affiliation: 'Test University', position: 'PhD Candidate',
    year: 2027, cvUrl: 'https://drive.example/jane-cv', createdAt: '2026-09-01T00:00:00Z',
  };
  const twin = { ...base, uid: 'cand-uid-2', ref: 'OA-CAND-260902-BBBB',
    cvUrl: 'https://drive.example/other-jane-cv', createdAt: '2026-09-02T00:00:00Z' };
  const docs = [{ id: 'docB', data: twin }, { id: 'docA', data: base }];
  const served = [
    { id: '2027-doe-jane', ref: base.ref, cvUrl: base.cvUrl },
    { id: '2027-doe-jane-2', ref: twin.ref, cvUrl: twin.cvUrl },
  ];

  /* --- the card each document answers for ------------------------------- */
  const cards = cardsFor(docs, served, { now });
  eq([...cards.get('docA').ids], ['2027-doe-jane'],
    'the first document (by document id) keeps the base id, as assignCandidateIds gives it');
  eq([...cards.get('docB').ids], ['2027-doe-jane-2'],
    'and its namesake takes -2, exactly as on the site');
  ok(cards.get('docA').cvUrls.has(base.cvUrl) && cards.get('docB').cvUrls.has(twin.cvUrl),
    'each carries its own CV link');
  // the served file wins by ref where the build resolved a collision the other way
  const swapped = cardsFor(docs, [
    { id: '2027-doe-jane', ref: twin.ref }, { id: '2027-doe-jane-2', ref: base.ref },
  ], { now });
  eq([...swapped.get('docA').ids], ['2027-doe-jane-2'],
    'the served row found by REF wins over the derived id');
  // a served row under the derived id that belongs to ANOTHER ref is not ours
  const foreign = cardsFor([{ id: 'docA', data: { ...base, ref: 'OA-CAND-260903-CCCC' } }],
    [{ id: '2027-doe-jane', ref: 'OA-CAND-000000-XXXX' }], { now });
  eq(foreign.get('docA').published, false,
    'a card held by a different submission is not counted — not sure means nothing');
  // nothing served (the reveal gate): nothing published
  const held = cardsFor(docs, [], { now });
  ok(!held.get('docA').published && !held.get('docB').published,
    'with an empty served file (before the reveal) no card is published');
  eq(cardsFor([{ id: 'x', data: { first: '', last: '' } }], served, { now }).get('x').published, false,
    'an unpublishable document is carried as not published, never a throw');

  /* --- attribution ------------------------------------------------------- */
  const card = cards.get('docA');
  eq(attribute({ k: 'button', c: 'job-2027-doe-jane', o: 1 }, card), 'open', 'head + o:1 is an open');
  eq(attribute({ k: 'button', c: 'job-2027-doe-jane' }, card), null,
    'the head without o (a close, or a locked card) is not');
  eq(attribute({ k: 'button', c: 'job-2027-doe-jane-2', o: 1 }, card), null,
    'the namesake\'s card is not this candidate\'s');
  eq(attribute({ k: 'a', h: base.cvUrl }, card), 'cv', 'a link to the CV is a CV click');
  eq(attribute({ k: 'a', h: twin.cvUrl }, card), null, 'a link to somebody else\'s CV is not');
  eq(attribute({ k: 'a', c: 'job-2027-doe-jane', x: 'CV', h: 'https://elsewhere.example/x' }, card),
    'cv', 'a link inside the card labelled CV is a CV click');
  eq(attribute({ k: 'a', c: 'job-2027-doe-jane', x: 'Website', h: 'https://elsewhere.example/x' }, card),
    null, 'another link inside the card is not');
  eq(attribute({ k: 'button', c: 'job-2027-doe-jane', x: 'CV' }, card), null,
    'a button reading CV is not a link');
  eq(attribute({ k: 'a', h: '' }, { ids: new Set(), cvUrls: new Set(['']) }), null,
    'an empty href never matches an empty cvUrl');
  eq([cardIdOf({ c: 'job-2027-doe-jane' }), cardIdOf({ c: 'oa-body-x' }), cardIdOf({})],
    ['2027-doe-jane', '', ''], 'only a job-<id> element id names a card');

  /* --- the tally --------------------------------------------------------- */
  const T = (day, h = 12) => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00Z`);
  const from = Date.parse('2026-07-01T00:00:00Z');
  const sessions = [
    { uid: 'anon:abc', email: '', clicks: [
      { t: T('2026-10-10'), k: 'button', c: 'job-2027-doe-jane', o: 1 },
      { t: T('2026-10-10'), k: 'a', c: 'job-2027-doe-jane', h: base.cvUrl, x: 'Open CV' },
      { t: T('2026-10-10'), k: 'button', c: 'job-2027-doe-jane' },        // the close
      { t: T('2026-10-11'), k: 'button', c: 'job-2027-doe-jane-2', o: 1 },
    ] },
    { uid: 'reader-1', email: 'reader@example.edu', clicks: [
      { t: T('2026-10-12'), k: 'button', c: 'job-2027-doe-jane', o: 1 },
      { t: T('2026-06-30'), k: 'button', c: 'job-2027-doe-jane', o: 1 },  // last season
    ] },
    { uid: 'cand-uid-1', email: 'jane@example.edu', clicks: [
      { t: T('2026-10-12'), k: 'button', c: 'job-2027-doe-jane', o: 1 },  // her own
      { t: T('2026-10-12'), k: 'a', h: base.cvUrl },
      { t: T('2026-10-12'), k: 'button', c: 'job-2027-doe-jane-2', o: 1 },  // the twin's: counts
    ] },
    { uid: 'admin-uid', email: 'KStouras@gmail.com', clicks: [
      { t: T('2026-10-13'), k: 'button', c: 'job-2027-doe-jane', o: 1 },  // the maintainer
    ] },
    { uid: 'anon:zzz', clicks: 'not a list' },
  ];
  const counts = tally(sessions, cards, { from });
  eq(counts.get('docA'), { opens: 2, cvClicks: 1, days: { '2026-10-10': [1, 1], '2026-10-12': [1, 0] } },
    'opens: the anonymous one and the signed-in reader; not the close, not her own, not the ' +
    'maintainer\'s, not last season\'s; the CV once');
  eq(counts.get('docB'), { opens: 2, cvClicks: 0, days: { '2026-10-11': [1, 0], '2026-10-12': [1, 0] } },
    'the namesake counts its own two opens — one of them from the other Jane\'s account');
  eq(tally(sessions, held, { from }).size, 0, 'nothing published, nothing tallied');

  /* --- the cap, the map ------------------------------------------------- */
  const many = {};
  for (let i = 0; i < 130; i++) many[isoDay(T('2026-01-01') + i * 86400000)] = [1, 0];
  const capped = capDays(many, DAY_CAP);
  eq(Object.keys(capped).length, DAY_CAP, `the day map keeps ${DAY_CAP} days`);
  eq(Object.keys(capped)[0], '2026-01-11', 'and they are the NEWEST ones');
  const stats = statsFor({ opens: 130, cvClicks: 3, days: many }, { now });
  eq([stats.opens, stats.cvClicks, Object.keys(stats.days).length, stats.updatedAt],
    [130, 3, DAY_CAP, '2026-10-20T12:00:00.000Z'],
    'the totals are not capped, the map is, and updatedAt is the run');
  ok(sameFigures(stats, { ...stats, updatedAt: 'other' }), 'sameFigures ignores updatedAt');
  ok(!sameFigures(stats, { ...stats, opens: 1 }), 'and sees a changed count');
  eq(statsFor(null, { now }).opens, 0, 'no tally is zeros, never a throw');

  for (const f of fails) console.log('  FAIL', f);
  console.log(`build-candidate-stats selftest: ${pass} passed, ${fails.length} failed`);
  return fails.length === 0;
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('::error::' + (e && e.stack || e));
    process.exit(1);
  });
}
