/* ---------------------------------------------------------------------------
   Operations Academia — the Universities DIRECTORY model (pure).

   WHAT THIS BUILDS. One flat table, data/directory.json — a row per
   (university, school, department) with an Operations presence — merged from
   every place the site already knows a school from:

     1. data/universities.json    the curated archive (addresses, faculty
                                  links, the map's pins — the rows seeded from
                                  the OM list years ago), source 'directory';
     2. assets/oa-institutions.js the curated seed of the world's OM/SCM
                                  schools, source 'seed';
     3. data/jobs.json +          every posting ever made here — which is what
        data/past-postings.json   keeps the rule the owner set: A JOB POSTING
                                  ALWAYS FITS UNDER A CARD. A posting from a
                                  place no source lists CREATES its row (and
                                  with it a new card on universities.html)
                                  from the posting's own three names, source
                                  'postings'.

   universities.html groups these rows into ONE CARD PER UNIVERSITY (schools
   inside the card, departments inside each school). The card-vs-department
   question was settled by the owner (2026-08-24): grouping is the point —
   "who does Operations at Michigan?" is one card, not three.

   EVERY NAME GOES THROUGH canonColumns(), so a seeded place and a place that
   has actually posted land on ONE row — the same discipline as the
   vocabulary, and the reason a posting can be matched to a card at all.
   The committed output is DETERMINISTIC (sorted, no timestamps): a build over
   unchanged inputs is byte-identical and commits nothing.

   IDS ARE HOW EDITS FIND THEIR ROW. A signed-in user's correction is a
   Firestore `directoryEdits/{rowId}` document overlaid at read time
   (assets/oa-directory.js — the rowOverrides pattern, opened to every
   registered user per the owner, 2026-08-24), so `rowKey` must be STABLE
   across rebuilds: it is derived from the folded names, never from array
   position, and follows a name only when the canonical spelling itself moves
   — the same trade the vocabulary already accepts.
   --------------------------------------------------------------------------- */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SCHOOLS = require('../assets/oa-schools.js');
const COUNTRIES = require('../assets/oa-countries.js');

/* One address-part slug, matching the shape of the archive's own row ids
   ('aalto-university-school-of-business'): folded, hyphenated, bounded. */
export function slugPart(s) {
  return SCHOOLS.fold(String(s || '')).replace(/\s+/g, '-').slice(0, 60);
}

/** The stable id an edit document is keyed on. The UNIVERSITY part folds
    through institutionKey, so "The University of Texas at Dallas (UTD)" and
    "University of Texas at Dallas" key one row — exactly the join the
    vocabulary uses — while the school and department parts fold spelling
    only. Never empty: a university row with no school and no department is
    the university part alone. */
export function rowKey(institution, school, unit) {
  const parts = [
    slugPart(SCHOOLS.institutionKey(institution || '')),
    slugPart(school),
    slugPart(unit),
  ];
  return parts.join('__').replace(/__+$/, '') || 'row';
}

/* The three names of one source row, canonicalised the one way. Three
   separate columns, so canonColumns and never canonPlace — see CLAUDE.md. */
function names(institution, school, unit) {
  return SCHOOLS.canonColumns({
    institution: String(institution || '').trim(),
    school: String(school || '').trim(),
    unit: String(unit || '').trim(),
  });
}

/* 'Business School' | 'University' | '' — the NAMES state the answer first
   (typeGuess, the browser twin of the pipeline's typeFromNames): this is a
   directory of schools, and "Woodbury School of Business" is a business
   school whatever type the posting that introduced it was filed under. A
   stored posting type only fills a row whose names state nothing. '' is
   honest — never guessed beyond that. */
function typeOf(stored, institution, school, unit) {
  const guessed = SCHOOLS.typeGuess(institution, school, unit);
  if (guessed) return guessed;
  const t = String(stored || '').trim();
  return (t === 'Business School' || t === 'University') ? t : '';
}

function newRow(id, n) {
  return {
    id,
    institution: n.institution,
    school: n.school,
    department: n.unit,
    type: '',
    country: '',
    address: '',
    lat: undefined,
    lng: undefined,
    mapUrl: '',
    facultyUrl: '',
    deptUrl: '',
    sources: [],
    n: 0,
    lastPosted: '',
    countryVotes: Object.create(null),
  };
}

function addSource(row, source) {
  if (row.sources.indexOf(source) === -1) row.sources.push(source);
}

function voteCountry(row, country) {
  const c = COUNTRIES.canon(String(country || '').trim());
  if (!c) return;
  row.countryVotes[c] = (row.countryVotes[c] || 0) + 1;
}

/**
 * Merge the sources into the flat directory table.
 *
 *   buildDirectory({ archive, seed, jobs, past })
 *     → { rows, names: Map(instKey → display name) }
 *
 * `archive` rows are data/universities.json's shape (institution / school /
 * department / address / lat / lng / mapUrl / facultyUrl); `seed` rows are
 * oa-institutions.directoryRows(); `jobs` and `past` are the two postings
 * files. PURE — reads its arguments, touches nothing on disk.
 */
export function buildDirectory({ archive = [], seed = [], jobs = [], past = [] } = {}) {
  const rows = new Map();          // id → row
  const display = new Map();       // instKey → { name, rank } — the card title
  const RANK = { directory: 3, seed: 2, postings: 1 };

  function claimName(institution, source) {
    const key = SCHOOLS.institutionKey(institution);
    if (!key) return;
    const held = display.get(key);
    // The archive's spelling wins, then the seed's, then the postings' —
    // first-writer within a rank, so the output cannot flap between two
    // spellings of equal standing.
    if (!held || RANK[source] > held.rank) {
      display.set(key, { name: institution, rank: RANK[source] });
    }
  }

  function rowFor(institution, school, unit, source) {
    const n = names(institution, school, unit);
    if (!n.institution) return null;
    claimName(n.institution, source);
    const id = rowKey(n.institution, n.school, n.unit);
    let row = rows.get(id);
    if (!row) {
      row = newRow(id, n);
      rows.set(id, row);
    }
    addSource(row, source);
    return row;
  }

  for (const r of archive) {
    const row = rowFor(r.institution || r.name, r.school, r.department, 'directory');
    if (!row) continue;
    // The archive is the only source that knows WHERE a campus is and where
    // its faculty list lives; a value already merged is never overwritten, so
    // two archive rows for one place keep the first (the file is sorted).
    if (!row.address && r.address) row.address = String(r.address);
    if (!isFinite(row.lat) && isFinite(r.lat)) { row.lat = r.lat; row.lng = r.lng; }
    if (!row.mapUrl && r.mapUrl) row.mapUrl = String(r.mapUrl);
    if (!row.facultyUrl && r.facultyUrl) row.facultyUrl = String(r.facultyUrl);
    voteCountry(row, COUNTRIES.countryFromAddress(String(r.address || '')));
  }

  for (const r of seed) {
    rowFor(r.institution, r.school, r.department, 'seed');
  }

  for (const r of [...jobs, ...past]) {
    const row = rowFor(r.institution, r.school, r.unit, 'postings');
    if (!row) continue;
    row.n += 1;
    const day = String(r.posted || '');
    if (day > row.lastPosted) row.lastPosted = day;
    voteCountry(row, r.country);
    const t = String(r.type || '').trim();
    if (!row.storedType && (t === 'Business School' || t === 'University')) row.storedType = t;
  }

  /* A POSTING WITH NO SCHOOL JOINS THE ROW THAT NAMES ONE — the offline twin
     of fillSchoolFromDirectory, under the same discipline: only where the
     school is empty, only where exactly ONE schooled row at that university
     carries the department, never invented. Without it Berkeley's "IEOR"
     postings (school left blank on the form) would stand as a second card row
     beside the archive's "College of Engineering — IEOR". */
  const byUnitHome = new Map();    // instKey || unit-fold → [schooled rows]
  for (const row of rows.values()) {
    if (!row.school || !row.department) continue;
    const k = SCHOOLS.institutionKey(row.institution) + '||' + SCHOOLS.fold(row.department);
    if (!byUnitHome.has(k)) byUnitHome.set(k, []);
    byUnitHome.get(k).push(row);
  }
  for (const [id, row] of [...rows.entries()]) {
    if (row.school || !row.department) continue;
    const k = SCHOOLS.institutionKey(row.institution) + '||' + SCHOOLS.fold(row.department);
    const homes = byUnitHome.get(k) || [];
    if (homes.length !== 1) continue;
    const home = homes[0];
    home.n += row.n;
    if (row.lastPosted > home.lastPosted) home.lastPosted = row.lastPosted;
    for (const s of row.sources) addSource(home, s);
    for (const c in row.countryVotes) {
      home.countryVotes[c] = (home.countryVotes[c] || 0) + row.countryVotes[c];
    }
    if (!home.facultyUrl && row.facultyUrl) home.facultyUrl = row.facultyUrl;
    rows.delete(id);
  }

  /* AN ACRONYM DEPARTMENT FOLDS INTO ITS EXPANSION — "IEOR" into "Industrial
     Engineering and Operations Research", "IOE" into "Industrial and
     Operations Engineering" — under the SAME initials rule the site's search
     and the alert matcher already apply (oa-list.js / oa-alert-match.js: an
     ALL-CAPS needle matches the initials of the words that remain, skipping
     the joining words an acronym skips). Deterministic and bounded: only a
     bare 2-6 letter all-caps department, only within one university, and only
     when EXACTLY ONE row's initials spell it — two candidates is ambiguity,
     which is the owner's call, made through the page's editor. */
  const ACRONYM = /^[A-Z]{2,6}$/;
  const JOINERS = ' and of the for in a an at on to ';
  const initialsOf = (s) => String(s || '').replace(/&/g, ' and ').split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !JOINERS.includes(' ' + w.toLowerCase() + ' '))
    .map((w) => w.charAt(0).toLowerCase()).join('');
  for (const [id, row] of [...rows.entries()]) {
    if (!ACRONYM.test(row.department)) continue;
    const acr = row.department.toLowerCase();
    const instKey = SCHOOLS.institutionKey(row.institution);
    const homes = [...rows.values()].filter((h) =>
      h !== row && h.department && !ACRONYM.test(h.department)
      && SCHOOLS.institutionKey(h.institution) === instKey
      && initialsOf(h.department) === acr);
    if (homes.length !== 1) continue;
    const home = homes[0];
    home.n += row.n;
    if (row.lastPosted > home.lastPosted) home.lastPosted = row.lastPosted;
    for (const s of row.sources) addSource(home, s);
    for (const c in row.countryVotes) {
      home.countryVotes[c] = (home.countryVotes[c] || 0) + row.countryVotes[c];
    }
    rows.delete(id);
  }

  const out = [...rows.values()].map((row) => {
    // the country the row's own evidence names — most votes wins, a tie is
    // no answer at all (the healCountry discipline: never invent)
    const votes = Object.entries(row.countryVotes).sort((a, b) => b[1] - a[1]);
    const country = votes.length && (votes.length === 1 || votes[0][1] > votes[1][1])
      ? votes[0][0] : '';
    row.type = typeOf(row.storedType, row.institution, row.school, row.department);
    const rec = {
      id: row.id,
      institution: row.institution,
      school: row.school,
      department: row.department,
      type: row.type,
      country,
      address: row.address,
      mapUrl: row.mapUrl,
      facultyUrl: row.facultyUrl,
      deptUrl: row.deptUrl,
      sources: row.sources.slice().sort(),
      n: row.n,
      lastPosted: row.lastPosted,
    };
    if (isFinite(row.lat)) { rec.lat = row.lat; rec.lng = row.lng; }
    // an empty field is skipped, the PUBLIC_FIELDS rule — the file is served
    // to every visitor and half a megabyte of '' is pure weight
    for (const k of Object.keys(rec)) {
      if (rec[k] === '' || rec[k] === 0 || (Array.isArray(rec[k]) && !rec[k].length)) {
        if (k !== 'institution') delete rec[k];
      }
    }
    return rec;
  });

  out.sort((a, b) =>
    SCHOOLS.fold(a.institution).localeCompare(SCHOOLS.fold(b.institution))
    || SCHOOLS.fold(a.school || '').localeCompare(SCHOOLS.fold(b.school || ''))
    || SCHOOLS.fold(a.department || '').localeCompare(SCHOOLS.fold(b.department || '')));

  const nameMap = new Map();
  for (const [key, v] of display) nameMap.set(key, v.name);
  return { rows: out, names: nameMap };
}

/** The card-level summary the page's meta file carries: how many universities
    and departments the table holds. Counted the way the PAGE groups —
    institutionKey — so the two can never disagree. */
export function directoryStats(rows) {
  const unis = new Set();
  let depts = 0;
  for (const r of rows) {
    unis.add(SCHOOLS.institutionKey(r.institution));
    if (r.department) depts += 1;
  }
  return { count: rows.length, universities: unis.size, departments: depts };
}
