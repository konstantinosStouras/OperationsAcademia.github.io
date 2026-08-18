/* ---------------------------------------------------------------------------
   Operations Academia — the confirmed-placement row model.

   ONE definition of what a row in v2/data/placements.json is, shared by
   everything that writes one:

     build-placements.mjs   Firestore submissions -> rows      (the live path)
     (a future sheet import would join this list, exactly as import-sheet.mjs
      joined jobs-model.mjs — the shape is defined HERE so the two paths
      cannot drift into subtly different rows)

   The generic machinery — sanitisers, the market-year rule, the owner tag,
   the merge identity — is IMPORTED from jobs-model.mjs rather than copied:
   a second copy of text()/url()/marketYear() is a second thing to keep in
   sync, and the failure it invites (two datasets disagreeing about what a
   valid URL or the current market year is) is silent.

   Every function is PURE and needs no network, so build-placements.mjs
   --selftest can cover the whole model offline.
   --------------------------------------------------------------------------- */

import {
  text, url, slug, ownerTag, marketYear, isoStamp, keyOf, uniqueIds,
} from './jobs-model.mjs';

/** The published fields, in the order they are written. Anything not listed
    here never reaches data/placements.json — which is how the reporter's
    contact e-mail, their auth e-mail, their uid and their private note to the
    maintainer stay out of a public repository. (`note` IS public on the jobs
    dataset's audit shape; here it is the "anything you would like to tell us"
    box and is deliberately private — the owner's requirement.)

    `addedAt` means the same ONE thing it means in jobs.json: the moment the
    row entered this dataset, never a date the reporter typed. It is the sort
    tiebreaker and, should placements ever join the e-mail alerts, their only
    cursor — so no writer may back-date it. */
export const PLACEMENT_PUBLIC_FIELDS = [
  'id', 'year', 'first', 'last', 'name',
  'phdInstitution', 'undergradInstitution',
  'joiningInstitution', 'joiningPosition',
  'webUrl', 'source', 'addedAt', 'ref', 'owner',
];

/* Mirrors of the bounds in v2/_firestore.rules (plShapeOk). The rules are the
   ceiling; these are what the build actually keeps, and they must never exceed
   the rules or a submission the rules accepted would be truncated differently
   here and in the client. */
const MAXLEN = {
  first: 100, last: 100,
  phdInstitution: 220, undergradInstitution: 220,
  joiningInstitution: 220, joiningPosition: 160,
};

/* -------------------------------------------------------------------- ids */

/** 'YYYY-slug(last)-slug(first)'. Year first so the file reads season by
    season; the name because that is what a placement IS — one person, one
    market year. Two people sharing a name in one year collide, which
    assignPlacementIds/uniqueIds disambiguate with a stable suffix. */
export function placementId(row) {
  return `${row.year}-${slug(row.last)}-${slug(row.first)}`;
}

/**
 * Give every row a distinct id, deterministically — the same discipline as
 * jobs-model's assignIds, for the same reason: two rows deriving one id must
 * not silently overwrite each other in the merge. Entries are `{ key, row }`
 * where `key` is the Firestore document id; sorting by it before assigning is
 * what keeps the suffix on the SAME row on every build, rather than on
 * whichever document Firestore happened to return first.
 */
export function assignPlacementIds(entries) {
  const ordered = entries.slice().sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const seen = new Set();
  for (const e of ordered) {
    const base = placementId(e.row);
    let id = base, n = 2;
    while (seen.has(id)) id = `${base}-${n++}`;
    e.row.id = id;
    seen.add(id);
  }
  return entries;
}

/* --------------------------------------------------------------- rendering */

/** The "joining" line the card shows: position first, then institution —
    "Assistant Professor, INSEAD". Skipping empties matters (the audit's
    "must not emit the leading ', '"): older imported rows may carry only one
    half, and a line starting with a comma is the tell of a join that trusted
    both halves to exist. */
export function joiningLine(position, institution) {
  return [text(position, MAXLEN.joiningPosition), text(institution, MAXLEN.joiningInstitution)]
    .filter(Boolean).join(', ');
}

/* ------------------------------------------------------------- the mapping */

/** Any of the three shapes a stored timestamp arrives in, or null. TOTAL, for
    the reason jobs-model.mjs documents on its own (unexported) copy: a plain
    number like 1e16 survives `new Date()` as an Invalid Date and then throws
    RangeError out of toISOString(), killing the whole publish run on one
    document — which stays queued, so every later run dies on it too. */
function tsToDate(ts) {
  if (!ts) return null;
  let d;
  if (ts instanceof Date) d = ts;
  else if (typeof ts.toDate === 'function') d = ts.toDate();        // Firestore Timestamp
  else d = new Date(ts);
  return d instanceof Date && !Number.isNaN(+d) ? d : null;
}

/**
 * A Firestore `placementSubmissions` document -> a published row, or null
 * when the submission is not publishable. The client already validated; this
 * validates AGAIN because the client is never trusted with what reaches a
 * served file.
 *
 * Note what is NOT read: `email`, `authEmail`, `note`, `uid` (beyond its
 * digest). They never even land on the row object, so no later serialisation
 * bug can leak them — PLACEMENT_PUBLIC_FIELDS is the second fence, not the
 * only one.
 */
export function rowFromPlacementSubmission(doc, { now = new Date() } = {}) {
  const first = text(doc.first, MAXLEN.first);
  const last = text(doc.last, MAXLEN.last);
  const phdInstitution = text(doc.phdInstitution, MAXLEN.phdInstitution);
  const joiningInstitution = text(doc.joiningInstitution, MAXLEN.joiningInstitution);

  /* The minimum a card needs to be worth rendering: who, from which PhD,
     joining where. The position is NOT required here — older imported rows
     can carry an institution with no rank, and the render never emits the
     leading ", " (see joiningLine) — but the form does require it, so a
     submission made through the site always has one. */
  if (!first || !last || !phdInstitution || !joiningInstitution) return null;

  const year = Number.isFinite(+doc.year) && +doc.year >= 2000 && +doc.year <= 2100
    ? Math.trunc(+doc.year)
    : marketYear(now);

  const row = {
    id: '',
    year,
    first,
    last,
    // one derived display name, so the page and any export agree on it
    name: `${first} ${last}`,
    phdInstitution,
    undergradInstitution: text(doc.undergradInstitution, MAXLEN.undergradInstitution),
    joiningInstitution,
    joiningPosition: text(doc.joiningPosition, MAXLEN.joiningPosition),
    webUrl: url(doc.webUrl),
    source: text(doc.source, 40) || 'oa-form',
    addedAt: isoStamp(tsToDate(doc.createdAt) || now),
    ref: text(doc.ref, 40),
    owner: ownerTag(doc.uid),
  };
  row.id = placementId(row);
  return row;
}

/** Only the published fields, in a stable key order, so a rebuild that
    changes nothing produces a byte-identical file and commits nothing.
    `ref`/`owner` are elided when empty (a future import's rows have neither,
    and pages of `"ref": ""` are noise in a file whose diff should read as
    the placements that changed). */
export function publicPlacementRow(row) {
  const out = {};
  for (const k of PLACEMENT_PUBLIC_FIELDS) {
    if (row[k] === undefined) continue;
    if ((k === 'ref' || k === 'owner') && !row[k]) continue;
    out[k] = row[k];
  }
  return out;
}

/* -------------------------------------------------------- repeat reports

   The Google-form era had no edit step, so the sheet holds the same person
   twice where they re-submitted to fix a typo — exactly the jobs dataset's
   same-day problem in another shape. Here the identity is not (institution,
   day) but the PERSON: one candidate places once per market year.          */

/* Uncapped normalisation for identity keys. slug() truncates at 48 characters
   to keep an id short, which is fine for an id but wrong for identity —
   jobs-model learned this the hard way with long department names — and a
   PhD-institution name can easily pass 48 characters. */
function normKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Same market year + same name + same PhD institution = provably the same
    person's placement. The PhD institution is deliberately part of the key:
    two real people CAN share a name in one market year, and their alma mater
    is the field that tells them apart — without it a genuine namesake would
    be silently dropped as a repeat. */
export function samePersonKey(row) {
  return [row.year, normKey(row.last), normKey(row.first), normKey(row.phdInstitution)].join('|');
}

/** How much a row carries, so the fullest of a set of repeats is the one
    kept. The website link counts extra: it is the enrichment a reader can
    actually follow. */
function fullness(row) {
  let n = 0;
  for (const k of PLACEMENT_PUBLIC_FIELDS) {
    const v = row[k];
    if (v !== '' && v !== null && v !== undefined && v !== false) n++;
  }
  if (row.webUrl) n += 1;
  return n;
}

/**
 * Which of two repeats to keep — the same ordering jobs-model's better()
 * uses, because the reasoning transfers whole:
 *   - a row with a `ref` was made on the site and its author can correct or
 *     withdraw it through their account; dropping it for an anonymous
 *     imported row would strand them;
 *   - two refs from the SAME account: the later one is the correction;
 *   - two refs from DIFFERENT accounts: whoever reported first keeps the
 *     slot, or anyone could displace a report by re-submitting it;
 *   - otherwise the fuller row wins.
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

/** Collapse repeat reports of ONE person's placement, keeping the best.
    Returns { rows, collapsed } with rows in their original order. */
export function collapseSamePerson(rows) {
  const best = new Map();
  const order = [];
  for (const row of rows) {
    const k = samePersonKey(row);
    if (!best.has(k)) {
      best.set(k, row);
      order.push(k);
    } else {
      best.set(k, better(best.get(k), row));
    }
  }
  return { rows: order.map((k) => best.get(k)), collapsed: rows.length - order.length };
}

/* -------------------------------------------------------------------- merge */

/**
 * Merge freshly-built rows into the committed ones — jobs-model's mergeRows
 * shape, with the placements collapse in place of the same-day one. The merge
 * identity is keyOf() from jobs-model: (owner, ref) or id — the owner tag is
 * half the key on purpose, because `ref` alone is client-chosen AND published
 * in this very file, so keyed on it a stranger could replace or withdraw
 * somebody else's placement.
 *
 * A `remove` entry is either `{ ref, owner }` — a WITHDRAWAL, which may only
 * take down a row the same account published — or a bare reference string,
 * the maintainer's committed take-down list, trusted to reach a row whoever
 * reported it.
 *
 * Returns { rows, added, updated, removed, collapsed } in display order.
 */
export function mergePlacementRows(existing, fresh, remove = []) {
  const by = new Map();
  for (const r of existing) by.set(keyOf(r), r);

  let added = 0, updated = 0;
  for (const r of fresh) {
    const k = keyOf(r);
    const prev = by.get(k);
    if (prev) {
      updated++;
      // A replacement never re-stamps addedAt: it records when the dataset
      // FIRST saw this placement, and a correction is not a new placement.
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

  /* Collapse AFTER the merge, not only on the way in, so repeats already
     committed heal on the next run — they carry distinct keys (`<id>-2`), so
     the keyed merge alone can never remove them. */
  const { rows: kept, collapsed } = collapseSamePerson([...by.values()]);

  const rows = uniqueIds(kept.sort(placementOrder));
  return { rows, added, updated, removed, collapsed };
}

/** Newest market year first, then newest report first, then by name — the
    order the page also sorts by, so the file reads the way the site does. */
export function placementOrder(a, b) {
  const y = (Number(b.year) || 0) - (Number(a.year) || 0);
  if (y) return y;
  const d = String(b.addedAt || '').localeCompare(String(a.addedAt || ''));
  if (d) return d;
  return String(a.last || '').localeCompare(String(b.last || ''))
      || String(a.first || '').localeCompare(String(b.first || ''));
}

/* --------------------------------------------------------------- companions */

/** The small companion file a page can read without downloading every row:
    counts, and the value vocabularies behind each filter. */
export function buildPlacementsMeta(rows, { generated }) {
  const tally = (get) => {
    const c = Object.create(null);
    for (const r of rows) for (const v of [].concat(get(r) ?? [])) if (v) c[v] = (c[v] || 0) + 1;
    return Object.fromEntries(Object.entries(c).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])));
  };
  return {
    generated,
    count: rows.length,
    years: tally((r) => String(r.year)),
    phdInstitutions: tally((r) => r.phdInstitution),
    joiningInstitutions: tally((r) => r.joiningInstitution),
    newestAdded: rows.reduce((m, r) => (String(r.addedAt || '') > m ? r.addedAt : m), ''),
  };
}

/** Stable JSON, one row per line-group, with a trailing newline — so a diff
    shows the placements that changed and nothing else. Note serialise([]) is
    exactly "[]\n", which is the shape data/placements.json ships in. */
export function serialise(rows) {
  return JSON.stringify(rows.map(publicPlacementRow), null, 1) + '\n';
}
