/* ---------------------------------------------------------------------------
   Operations Academia — the candidate profile row model.

   ONE definition of what a row in v2/data/candidates.json is, shared by
   everything that writes one:

     build-candidates.mjs   Firestore submissions -> rows     (the live path)
     (a future sheet import would go through this too)

   The same discipline as jobs-model.mjs, which this file leans on rather than
   copies: the generic sanitisers and the merge identity (text/url/day/slug/
   ownerTag/keyOf/uniqueIds) are IMPORTED, so a fix there fixes both datasets.
   Only what is genuinely candidate-shaped lives here.

   THE ONE RULE THAT IS DIFFERENT FROM JOBS: a candidate row is a PERSON, and
   the old display tab published every candidate's e-mail address. That is the
   disclosure this rebuild retires — `email` reaches the served file ONLY when
   the candidate ticked `emailPublic` on their own submission, and nothing
   else personally identifying (uid, authEmail, the private note) is in
   CANDIDATE_PUBLIC_FIELDS at all.

   Every function is PURE and needs no network, so build-candidates.mjs
   --selftest can cover the whole model offline.
   --------------------------------------------------------------------------- */

import { createRequire } from 'node:module';

import {
  text, url, day, slug, pickList, ownerTag, keyOf, uniqueIds,
  marketYear, isoDay, isoStamp, canonColumns,
} from './jobs-model.mjs';

/* WHEN the profiles go public is decided in ONE place, assets/oa-reveal.js,
   a dual-mode file the pages load too (the oa-jobnav.js shape). The gate
   below is a thin caller of it, so the build, the front page's note, the
   Admin area's held/live split and the mailers cannot disagree about whether
   a profile is out yet. */
const require = createRequire(import.meta.url);
const OAReveal = require('../assets/oa-reveal.js');

/** The published fields, in the order they are written. Anything not listed
    here never reaches data/candidates.json — which is how `uid`, `authEmail`,
    `emailPublic`, `personalEmail` (the durable address the form asks for so
    the maintainer can reach a candidate after their school address dies with
    the affiliation — NEVER published, owner 2026-08-24) and the private note
    stay out of a public repository. `rsUrl` stays listed although the form
    stopped asking for a research summary (2026-08-24): profiles filed while
    it still did keep their link.

    `email` IS listed, and that is not a leak: publicCandidateRow() only ever
    carries a value into it when the candidate opted in (rowFromCandidate-
    Submission blanks it otherwise), and an empty one is skipped entirely.

    `addedAt` means the same ONE thing as in jobs-model: the moment the row
    entered this dataset — the e-mail alerts' cursor — never the day the
    candidate says they posted (that is `posted`).

    `updatedAt` (owner, 2026-09-04) is the DAY the candidate last edited the
    profile, cut from the stamp the edit form writes: a day, because the
    card says "Profile updated on 2 October 2026" and nothing reads the hour.
    It is skipped when empty, like `ref`, so a profile never edited carries
    no line. It is NOT an alerts cursor: the candidates topic lists by
    `addedAt` alone, so an edit never re-announces a profile. */
export const CANDIDATE_PUBLIC_FIELDS = [
  'id', 'year', 'posted', 'first', 'last', 'name', 'affiliation', 'position',
  'researchAreas', 'informsDays', 'cvUrl', 'rsUrl', 'webUrl', 'email',
  'source', 'addedAt', 'updatedAt', 'ref', 'owner',
];

/* The days an INFORMS Annual Meeting runs, PINNED. The old sheet's display
   tab had to clean this column on the way out — drop `Saturday`, expand
   legacy session codes like `SB15, TA10, TC22` into day names — because the
   raw column accepted anything. Pinning the vocabulary at ingest is the same
   cleaning done once, in one place: the form offers exactly these values,
   and anything else (a session code, a typo, `Saturday`) is dropped by
   pickList rather than published for the page's Day filter to choke on. */
export const INFORMS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday'];

const MAXLEN = {
  first: 100, last: 100, affiliation: 220, position: 160,
  institution: 160, school: 160, unit: 160,
  cvUrl: 500, rsUrl: 500, webUrl: 500, email: 160,
};

/**
 * The affiliation's three parts -> the ONE published line (owner, 2026-08-24:
 * the form asks university / school / department separately, the way the job
 * form does). Joined smallest-first — "Operations, Kellogg School of
 * Management, Northwestern University" — the shape the site's candidate data
 * has always used ("Wharton, University of Pennsylvania"), so the cards, the
 * alert matcher and the universities page's affiliation deep links read it
 * unchanged. Through the SAME canonColumns() every other ingest uses, so a
 * candidate's spelling and the postings' spelling cannot part company; empty
 * when no part is given, so the caller can fall back to a legacy free-text
 * `affiliation`.
 */
export function joinCandidateAffiliation(doc) {
  const place = canonColumns({
    institution: text(doc.institution, MAXLEN.institution),
    school: text(doc.school, MAXLEN.school),
    unit: text(doc.unit, MAXLEN.unit),
  });
  return [place.unit, place.school, place.institution]
    .filter(Boolean).join(', ').slice(0, MAXLEN.affiliation);
}

/* How many research areas one profile may carry, and how long each may be.
   The Firestore rule (`list('researchAreas', 10)`) bounds the LENGTH of the
   list only — the rules language has no per-item predicate — so the item
   bound lives here, where every writer passes. */
const AREAS_MAX = 10;
const AREA_LEN = 80;

/**
 * A sanitised list of FREE-TEXT values: research areas. Deliberately NOT
 * pickList against a pinned vocabulary, the way informsDays is — the form
 * offers a curated set of areas, but research areas are not a closed set the
 * way weekdays are, and a future import (or the maintainer fixing a profile
 * by hand) must be able to carry an area the form never offered. The page
 * builds its filter facet from whatever values exist, so a new area simply
 * appears. Each value is still text()-scrubbed, deduplicated and bounded.
 */
export function freeList(v, { max = AREAS_MAX, itemMax = AREA_LEN } = {}) {
  const seen = new Set();
  return (Array.isArray(v) ? v : [v])
    .map((x) => text(x, itemMax))
    .filter((x) => x && !seen.has(x) && seen.add(x))
    .slice(0, max);
}

/**
 * The row id: 'YYYY-slug(last)-slug(first)' — 2027-doe-jane. Year first so an
 * id says which market the profile belongs to, surname first because that is
 * what anyone scanning a list of academics is scanning for. Two candidates
 * sharing a name in one year collide by construction; assignCandidateIds /
 * uniqueIds suffix the second deterministically, exactly as jobId collisions
 * are handled.
 */
export function candidateId(row) {
  return `${row.year}-${slug(row.last)}-${slug(row.first)}`;
}

/** A copy of jobs-model's private tsToDate, with the same TOTAL-ness: an
    Invalid Date must come back as null, never escape into toISOString() —
    see the RangeError note on the original. (Private there on purpose; the
    six lines are duplicated rather than exporting an internal.) */
function tsToDate(ts) {
  if (!ts) return null;
  let d;
  if (ts instanceof Date) d = ts;
  else if (typeof ts.toDate === 'function') d = ts.toDate();        // Firestore Timestamp
  else d = new Date(ts);
  return d instanceof Date && !Number.isNaN(+d) ? d : null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* ------------------------------------------------------------- the mapping */

/**
 * A Firestore `candidateSubmissions` document -> a published row, or null
 * when the submission is not publishable. The client already validated; this
 * validates AGAIN because the client is not trusted with what reaches a
 * served file.
 */
export function rowFromCandidateSubmission(doc, { now = new Date() } = {}) {
  const first = text(doc.first, MAXLEN.first);
  const last = text(doc.last, MAXLEN.last);
  /* the three parts win over the stored one-line `affiliation` where any is
     given — the client derives the line from them too, but the client is not
     trusted with what reaches a served file; a pre-split document carries
     only the free-text line, which is honoured as before */
  const affiliation = joinCandidateAffiliation(doc)
    || text(doc.affiliation, MAXLEN.affiliation);
  const position = text(doc.position, MAXLEN.position);

  // the minimum a card needs to be worth rendering: who, and where they are
  // now. Position is required too — the form's select refuses to submit
  // without one, so a document lacking it is malformed, not minimalist.
  if (!first || !last || !affiliation || !position) return null;

  const year = Number.isFinite(+doc.year) && +doc.year >= 2000 && +doc.year <= 2100
    ? Math.trunc(+doc.year)
    : marketYear(now);

  /* Same rule as jobs-model: `posted` is the page's sort key, so a value the
     client picks is a value the client could pin its card to the top with.
     The form never sends `postedOn` and the rules refuse the key outright; a
     future import (written with the Admin SDK, which bypasses the rules) may
     carry it, and it is honoured only when no LATER than the stored stamp. */
  const stamped = isoDay(tsToDate(doc.createdAt) || now);
  const asked = day(doc.postedOn);
  const posted = asked && asked <= stamped ? asked : stamped;

  /* THE OPT-IN. `emailPublic` must be literally `true` (the rules pin it to a
     bool when present, but an Admin-SDK writer could store anything), and the
     address itself must look like one — an opted-in junk value is dropped,
     not published. Everything else about the address stays private. */
  const email = doc.emailPublic === true && EMAIL_RE.test(String(doc.email || '').trim())
    ? text(doc.email, MAXLEN.email)
    : '';

  const row = {
    id: '',
    year,
    posted,
    first,
    last,
    name: `${first} ${last}`,
    affiliation,
    position,
    researchAreas: freeList(doc.researchAreas),
    informsDays: pickList(doc.informsDays, INFORMS_DAYS),
    /* The typed link is preferred over the Drive upload BY CONSTRUCTION, the
       way the old display tab's formula preferred it: the build only files an
       upload into Drive when the document has no cvUrl/rsUrl (see
       build-candidates.mjs transferUploads), and the form clears the link
       field when a file is chosen — so whichever the candidate gave last is
       what this reads. */
    cvUrl: url(doc.cvUrl),
    rsUrl: url(doc.rsUrl),
    webUrl: url(doc.webUrl),
    email,
    source: text(doc.source, 40) || 'oa-form',
    addedAt: isoStamp(tsToDate(doc.createdAt) || now),
    /* the day of the last edit: the form, the card's Take-down and the
       Admin area all write `updatedAt` as an ISO stamp; a document never
       edited has none and publishes none. Day-cut here, once, so the served
       file and the browser twin agree on the value to the byte. */
    updatedAt: (() => { const d = tsToDate(doc.updatedAt); return d ? isoDay(d) : ''; })(),
    ref: text(doc.ref, 40),
    owner: ownerTag(doc.uid),
  };
  row.id = candidateId(row);
  return row;
}

/**
 * Give every row a distinct id, deterministically — jobs-model's assignIds
 * for the candidate id. Two people genuinely sharing a name in one market
 * year derive the same id; sorting by document id before suffixing keeps the
 * SAME person on the SAME id across builds, rather than the `-2` landing on
 * whichever document Firestore returned first.
 */
export function assignCandidateIds(entries) {
  const ordered = entries.slice().sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const seen = new Set();
  for (const e of ordered) {
    const base = candidateId(e.row);
    let id = base, n = 2;
    while (seen.has(id)) id = `${base}-${n++}`;
    e.row.id = id;
    seen.add(id);
  }
  return entries;
}

/** Only the published fields, in a stable key order, so a rebuild that
    changes nothing produces a byte-identical file and commits nothing.
    `ref` is skipped when empty for the same diff-noise reason as jobs;
    `email` is skipped when empty so the file never carries a hundred
    `"email": ""` lines that read as a hundred near-disclosures. */
export function publicCandidateRow(row) {
  const out = {};
  for (const k of CANDIDATE_PUBLIC_FIELDS) {
    if (row[k] === undefined) continue;
    // `updatedAt` too: a profile never edited has no "updated on" line, and
    // an empty stamp on every row would be diff noise for nothing
    if ((k === 'ref' || k === 'email' || k === 'updatedAt') && !row[k]) continue;
    out[k] = row[k];
  }
  return out;
}

/* --------------------------------------------------------------- duplicates

   The old flow had no edit step, so a candidate who wanted to change their
   profile submitted the whole thing again — the same failure that put four
   Tulane rows on the jobs page. The new form CAN edit, but nothing stops a
   candidate posting twice instead, and one person must never appear twice on
   a page that is literally a list of people.

   The collapse key is (market year, full name): one person has ONE profile
   per market year. Two REAL people sharing a full name in one year would
   collapse too — accepted, exactly as jobs accepted the analogous risk on
   (institution, department, day), because `better()` below keeps whichever
   row carries more and the loser is a duplicate in every case observed in
   eight years of the sheet.                                                 */

/* Identity must not truncate — jobs-model learned this the hard way when
   slug()'s 48-character cap made two long department names agree. slug() is
   for IDS; this is the same fold with no cap. */
function normName(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function sameCandidateKey(row) {
  return [row.year, normName(row.name)].join('|');
}

/** How much a row carries, so the fullest of a set of repeats is kept. The
    CV counts double: it is the document a hiring committee came for.
    `updatedAt` counts like any other field since 2026-09-04: an edited
    profile is fuller than one never touched, which only ever moves a
    tie-break between two OWNERLESS repeats (owned rows are settled by
    account and stamp first, in `better`). */
function fullness(row) {
  let n = 0;
  for (const k of CANDIDATE_PUBLIC_FIELDS) {
    const v = row[k];
    if (Array.isArray(v) ? v.length : (v !== '' && v !== null && v !== undefined && v !== false)) n++;
  }
  if (row.cvUrl) n += 2;
  return n;
}

/**
 * Which of two repeats to keep — jobs-model's `better()` reasoning, applied
 * to people. Ownership FIRST: a profile made on the site carries a `ref` and
 * its author can correct or withdraw it; dropping it for an anonymous
 * imported row describing the same person would strand them. Between two
 * owned rows, the SAME account repeating itself is a correction (keep the
 * later), while two DIFFERENT accounts claiming one name is not — whoever
 * posted first keeps the slot, or anyone could displace a candidate's real
 * profile by submitting under their name. Only equals fall through to
 * fullness.
 */
function better(a, b) {
  if (!!a.ref !== !!b.ref) return a.ref ? a : b;

  if (a.ref && b.ref) {
    const at = String(a.addedAt || ''), bt = String(b.addedAt || '');
    if ((a.owner || '') === (b.owner || '')) return at >= bt ? a : b;
    return at <= bt ? a : b;
  }

  return fullness(a) >= fullness(b) ? a : b;
}

/** One collapse pass: rows sharing a key are folded onto the better one, in
    the original order; a row whose keyFn answers null is never folded. */
function collapseBy(rows, keyFn) {
  const best = new Map();
  const order = [];   // { k } for keyed slots, { row } for keyless rows

  for (const row of rows) {
    const k = keyFn(row);
    if (k == null) { order.push({ row }); continue; }
    if (!best.has(k)) {
      best.set(k, row);
      order.push({ k });
    } else {
      best.set(k, better(best.get(k), row));
    }
  }

  return {
    rows: order.map((e) => (e.k != null ? best.get(e.k) : e.row)),
    collapsed: rows.length - order.length,
  };
}

/** Collapse repeat profiles — TWO passes, because two rows can be repeats in
    two different ways:

    (1) ONE PERSON in one market year, keyed (year, name) — the original
        collapse: a candidate who posted twice instead of editing.
    (2) ONE ACCOUNT in one market year, keyed (year, owner) — the owner's rule
        (2026-08-24): a registered candidate has ONE profile per market year,
        full stop. The name key alone cannot enforce it — the same account
        posting under a corrected spelling ("Jane Doe" then "Jane A. Doe") is
        two names and was two cards. The form now redirects a signed-in
        candidate who already has a profile this season into EDITING it, and
        this pass is the backstop that heals whatever slipped past (a race,
        an offline import, a pre-rule duplicate). Keyed on `owner` (the uid
        digest), so an imported row with no owner is never touched.

    The same person re-appearing in the NEXT market year is a genuinely new
    profile and is left alone by both. Returns { rows, collapsed } in the
    original order. */
export function collapseSameCandidate(rows) {
  const byName = collapseBy(rows, sameCandidateKey);
  const byAccount = collapseBy(byName.rows,
    (r) => (r.owner ? `${r.year}|acct:${r.owner}` : null));
  return {
    rows: byAccount.rows,
    collapsed: byName.collapsed + byAccount.collapsed,
  };
}

/* -------------------------------------------------------------------- merge */

/**
 * Merge freshly-built rows into the committed ones — jobs-model's mergeRows
 * with the candidate collapse and the candidate display order. The identity
 * is jobs-model's keyOf, imported: (owner, ref) for a site-made row, id
 * otherwise, for exactly the reasons documented on ownerTag() there —
 * `ref` alone is client-chosen AND published in this very file, so keyed on
 * it a stranger could replace or withdraw somebody else's profile.
 *
 * A `remove` entry is either `{ ref, owner }` — a candidate WITHDRAWING
 * their own profile — or a bare reference string, the maintainer's committed
 * take-down list, trusted to reach a row whoever posted it.
 *
 * …and a THIRD shape, `{ id }`, which is how a row with NO reference is taken
 * down. `ref` is issued by the form and by nothing else, so every posting from
 * the legacy import and from the tracking sheet has none — today that is every
 * row served. Keyed on references alone this loop matched nothing at all and
 * the row was carried on as an orphan, so the takedown reported success and
 * changed nothing. A caller must build its specs with `removalSpecs`, which
 * decides whose word to take for each shape.
 */
export function mergeCandidateRows(existing, fresh, remove = []) {
  const by = new Map();
  for (const r of existing) by.set(keyOf(r), r);

  let added = 0, updated = 0;
  for (const r of fresh) {
    const k = keyOf(r);
    const prev = by.get(k);
    if (prev) {
      updated++;
      // `addedAt` is the alerts' cursor: a correction must not re-stamp it,
      // or every subscriber is alerted again about a profile they were sent.
      if (prev.addedAt) r.addedAt = prev.addedAt;
    } else {
      added++;
    }
    by.set(k, r);
  }

  let removed = 0;
  for (const spec of remove) {
    if (!spec) continue;
    if (typeof spec === 'string') {
      for (const [k, r] of [...by]) if (r.ref === spec) { by.delete(k); removed++; }
    } else if (spec.ref) {
      if (by.delete('ref:' + (spec.owner || '') + ':' + spec.ref)) removed++;
    } else if (spec.id) {
      /* Taking down a row that has NO reference — an imported one, or any row
         whose document the maintainer hid. `ref` is issued by the form and by
         nothing else, so keyed on it alone this loop matched nothing and the
         row was carried on as an orphan: the takedown said it had worked and
         changed nothing. jobs-model's keyOf keys a ref-less row by its id.
         (The same fix, and the same reasoning, as in mergeRows.) */
      if (by.delete('id:' + spec.id)) removed++;
    }
  }

  // Collapse AFTER the merge, so repeats already committed heal on the next
  // run — they carry distinct keys, so the merge alone cannot heal them.
  const { rows: kept, collapsed } = collapseSameCandidate([...by.values()]);

  const rows = uniqueIds(kept.sort(candidateDisplayOrder));
  return { rows, added, updated, removed, collapsed };
}

/** Newest profile first, then by name — the order the page also sorts by, so
    the file reads the way the site does. No `featured` here: candidates are
    people, and the site does not rank people. */
export function candidateDisplayOrder(a, b) {
  const d = String(b.posted || '').localeCompare(String(a.posted || ''));
  if (d) return d;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

/** The small companion file: counts and the value vocabulary behind each
    filter, mirroring buildMeta() for jobs. */
/**
 * The reveal gate (owner, 2026-08-16): profiles are COLLECTED continuously but
 * SHOWN all at once, on a date the admin sets in data/candidates-reveal.json.
 * Until the reveal INSTANT (14:00 UTC on that day, since 2026-09-04; see
 * assets/oa-reveal.js for why an instant rather than a day) the build
 * projects ZERO rows into the world-readable candidates.json: held-back means
 * not-written, never written-and-hidden. An empty or malformed date means
 * "not announced yet": hold everything, so a typo in the config can never
 * reveal early.
 *
 * Pure, clock-injected, so the boundary is unit-testable: `held` is true
 * strictly BEFORE the instant: 13:59:59Z holds, 14:00:00Z reveals. A thin
 * caller of OAReveal, keeping its name and return shape; `revealAt` is the
 * day it parsed, echoed so the log and the meta can name it.
 */
export function revealGate(revealAt, now = new Date()) {
  const at = OAReveal.revealDay(revealAt);
  return { revealAt: at, held: !OAReveal.isRevealed(at, now) };
}

export function buildCandidatesMeta(rows, { generated, revealAt = '', heldCount = 0 } = {}) {
  const tally = (get) => {
    const c = Object.create(null);
    for (const r of rows) for (const v of [].concat(get(r) ?? [])) if (v) c[v] = (c[v] || 0) + 1;
    return Object.fromEntries(Object.entries(c).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])));
  };
  return {
    generated,
    count: rows.length,
    years: tally((r) => String(r.year)),
    positions: tally((r) => r.position),
    researchAreas: tally((r) => r.researchAreas),
    informsDays: tally((r) => r.informsDays),
    withCv: rows.filter((r) => r.cvUrl).length,
    newestPosted: rows.reduce((m, r) => (r.posted > m ? r.posted : m), ''),
    /* the reveal, for the page to announce: the date, the instant it happens
       (14:00 UTC on that date, as an ISO stamp, the SAME instant the pages
       compute from the date through assets/oa-reveal.js, written here so a
       reader of the file needs no module to know it), and how many profiles
       are waiting behind it (a COUNT only — no name, no field, no PII) */
    revealAt,
    revealAtInstant: OAReveal.revealStamp(revealAt),
    heldCount,
  };
}

/** Stable JSON, one row per line-group, with a trailing newline — so a diff
    shows the profiles that changed and nothing else. */
export function serialiseCandidates(rows) {
  return JSON.stringify(rows.map(publicCandidateRow), null, 1) + '\n';
}
