/* ---------------------------------------------------------------------------
   Operations Academia — the vocabulary the posting form offers.

   WHY THIS EXISTS. The old Google Form asked for the institution and the
   "School, department/area or group" as free text, so the same place arrived
   spelled a dozen ways: "Freeman School of Business", "Freeman School of
   Business, Management Science" and "Freeman School of Business, Management
   Sciences Area" are three rows for one department, and the filters treat them
   as three institutions' worth of distinct values. The form now offers what
   has been posted before and lets a poster type something new only when it
   genuinely is new.

   WHERE THE OPTIONS COME FROM. Two files, and neither is a list anybody
   curates by hand:

     data/jobs.json          the postings themselves — so a name entered today
                             is on tomorrow's list, and a name that stops being
                             used stops being offered. These CARRY A COUNT.
     data/universities.json  the site's own Universities directory: 254 curated
                             (institution, school, department) rows. It is what
                             makes the cascade work for a university that has
                             never posted here — a first-time poster from Aalto
                             is offered "School of Business" and "Department of
                             Information and Service Economy" rather than a
                             blank page. Directory rows count for NOTHING (the
                             "4 postings" note stays a posting count) but they
                             name places and, more importantly, they say WHICH
                             DEPARTMENT SITS IN WHICH SCHOOL.

   data/past-postings.json is deliberately NOT a source. Its legacy free-text
   rows never had the institution separated from the school and the department
   ("University of Wisconsin-Milwaukee (Sheldon B. Lubar School of Business),
   Supply Chain, Operations Management & Business Statistics Department" is one
   `institution`), so feeding it in would put exactly the mess this file exists
   to end into the university picker.

   THE CASCADE. `byUniversity[uni].bySchool[school]` is the third level: the
   departments seen IN that school AT that university. Choosing Tulane narrows
   the school list to Tulane's schools; choosing its Freeman school narrows the
   department list to that school's departments. A HINT, never a restriction —
   a school can open a department tomorrow and the form must not make that
   unpostable.

   ONE SPELLING PER PLACE is assets/oa-schools.js's job, not this file's: every
   name is put through its canonPlace() on the way in, so the lists offer what
   the postings are published under and a directory row spelled differently
   joins the same entry rather than starting a second one.

   Everything here is PURE and needs no network, so the selftest covers it.
   --------------------------------------------------------------------------- */

import { createRequire } from 'node:module';

/* One spelling per university, school and department (assets/oa-schools.js),
   the same module jobs-model.mjs canonicalises every posting with. Used here
   so the option lists, the cascade and the postings all name a place
   identically — including the Universities directory, whose rows have never
   been through an ingest. */
const require = createRequire(import.meta.url);
export const SCHOOLS = require('../assets/oa-schools.js');
/* one spelling per country, and the address reader the campus-country
   authority below is built on — see `campusCountries` */
export const COUNTRIES = require('../assets/oa-countries.js');
const { canonPlace, canonColumns, institutionKey, fold: nameFold } = SCHOOLS;

/* --------------------------------------------------- school vs. unit

   The legacy field fused two things a poster now picks separately, and the
   separator is not reliable: a comma divides school from department in
   "NUS Business School, Department of Analytics and Operations" but sits
   INSIDE the name in "Department of Decisions, Operations and Technology"
   and "Analytics, Information, and Operations Management Department".

   So the split is by VOCABULARY, not punctuation. A comma-separated segment
   belongs to the school for as long as it names one — "School", "College",
   "Faculty" and friends — and the first segment that does not begins the
   unit. That reads all five shapes in the committed data correctly, including
   the ones where a comma is part of a name.                                  */

/** Words that mark a segment as naming a school/college/faculty. */
const SCHOOL_WORDS = [
  'school', 'college', 'faculty', 'academy', 'institute of technology',
];

/** Words that mark a segment as naming a department/area/group. */
const UNIT_WORDS = [
  'department', 'dept', 'area', 'group', 'division', 'unit', 'section',
  'programme', 'program', 'chair', 'initiative', 'centre', 'center',
  'laboratory', 'lab', 'institute',
];

/** Whole-word test, so "Groups" matches and "Programmatic" does not. */
function hasWord(text, words) {
  const s = ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return words.some((w) => s.includes(` ${w} `) || s.includes(` ${w}s `));
}

/**
 * Words a unit name STARTS with. Only these can split a segment that names
 * both a school and a unit, as "Robinson College of Business-Department of
 * Management" does with a hyphen where others use a comma.
 *
 * Deliberately a subset of UNIT_WORDS: "area", "group" and "unit" are trailing
 * qualifiers — "Operations Management Area" — so splitting at one strands it
 * as a unit called "Area", which is what "Naveen Jindal School of
 * Management/Healthcare Management Area" did before this list existed.
 */
const UNIT_HEAD_WORDS = [
  'department', 'dept', 'division', 'centre', 'center', 'institute',
  'programme', 'program', 'chair', 'initiative', 'laboratory',
];

/** Index of the first unit HEAD word in a segment, or -1. */
function unitWordAt(segment) {
  let best = -1;
  for (const w of UNIT_HEAD_WORDS) {
    const m = new RegExp(`\\b${w}s?\\b`, 'i').exec(segment);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

function tidy(s) {
  return String(s ?? '').replace(/\s+/g, ' ').replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '').trim();
}

/**
 * "Fuqua School of Business, Operations Management group"
 *   -> { school: 'Fuqua School of Business', unit: 'Operations Management group' }
 *
 * A value naming only one of the two returns the other empty, and a value
 * naming neither is treated as a UNIT — it is the more specific field, and
 * "Operations Management" on its own is a group, not a school.
 */
export function splitDepartment(value) {
  const whole = tidy(value);
  if (!whole) return { school: '', unit: '' };

  const segments = whole.split(',');
  const school = [];
  let i = 0;

  for (; i < segments.length; i++) {
    const seg = segments[i];
    if (!hasWord(seg, SCHOOL_WORDS)) break;

    // names both: "Robinson College of Business-Department of Management"
    const at = unitWordAt(seg);
    if (at > 0 && hasWord(seg.slice(0, at), SCHOOL_WORDS)) {
      school.push(seg.slice(0, at));
      return {
        school: tidy(school.join(',')),
        unit: tidy([seg.slice(at), ...segments.slice(i + 1)].join(',')),
      };
    }
    school.push(seg);
  }

  return {
    school: tidy(school.join(',')),
    unit: tidy(segments.slice(i).join(',')),
  };
}

/** The published `department` line, rebuilt from the two parts a poster now
    picks separately. One definition, so the card, the filters and the sheet
    import cannot disagree about how the two are joined. */
export function joinDepartment(school, unit) {
  return [tidy(school), tidy(unit)].filter(Boolean).join(', ');
}

/* ------------------------------------------------------------- the vocabulary */

/** Case- and punctuation-insensitive identity, so "Operations Management" and
    "operations management " are one entry rather than two. Names reach the
    tally already canonicalised (assets/oa-schools.js), so this is only the
    last-ditch fold that keeps two spellings of one canonical name together. */
export function vocabKey(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Which spelling to offer, among the ones that survived canonPlace() as one
 * name. Usually there is only one — that is the point of canonicalising on the
 * way in — so this is a tie-break, not a policy: the most-posted spelling, then
 * the most-written, then the fullest, then alphabetical, so the result never
 * depends on the order rows arrive in.
 */
function pickForm(forms) {
  return [...forms.entries()].sort((a, b) =>
    (b[1].w - a[1].w) ||
    (b[1].c - a[1].c) ||
    (b[0].length - a[0].length) ||
    a[0].localeCompare(b[0]))[0][0];
}

/**
 * The identity a name is grouped under.
 *
 * fold() keeps only [a-z0-9], so a name written in a script it does not know —
 * 香港中文大學, Πανεπιστήμιο, МГУ — folds to NOTHING. Dropping those is not an
 * option: a university whose name the form cannot offer is the same bug this
 * file exists to end, and one arriving in a submission used to take the whole
 * daily build down with it (the tally dropped the name, the tree did not, and
 * the lookup between them found nothing). So the tidied name stands in for its
 * own fold, which groups it with itself and nothing else.
 */
function keyOf(v) {
  const s = tidy(v);
  return nameFold(s) || s.toLowerCase();
}

/** The same, for a UNIVERSITY: one entry however the name is written, so a
    university listed twice in the directory does not offer half its schools
    from one entry and half from the other. It groups; it never publishes. */
function uniKeyOf(v) {
  const s = tidy(v);
  return institutionKey(s) || keyOf(s);
}

/**
 * Group spellings of one name, count the POSTINGS behind each (directory rows
 * carry no count) and keep one spelling per place. Returns a Map keyed by
 * keyOf so a caller can look a raw value up; `n` is a posting count, which is
 * what the form's "4 postings" note means.
 */
function tally(items, key = keyOf) {
  const by = new Map();
  for (const it of items) {
    const v = tidy(it.v);
    if (!v) continue;
    const k = key(v);
    if (!k) continue;
    const e = by.get(k) || { n: 0, forms: new Map() };
    e.n += it.w;
    const f = e.forms.get(v) || { w: 0, c: 0 };
    f.w += it.w;
    f.c += 1;
    e.forms.set(v, f);
    by.set(k, e);
  }
  const out = new Map();
  for (const [k, e] of by) out.set(k, { v: pickForm(e.forms), n: e.n });
  return out;
}

/** A tally as the form reads it: most-used first, then alphabetical. */
function listOf(t) {
  return [...t.values()]
    .map(({ v, n }) => ({ v, n }))
    .sort((a, b) => b.n - a.n || a.v.localeCompare(b.v));
}

/** The spelling `t` keeps for a raw value, or the value tidied if it is new. */
function formOf(t, v) {
  const k = keyOf(v);
  const hit = k && t.get(k);
  return hit ? hit.v : tidy(v);
}

/**
 * One (institution, school, unit) triple, in the spelling the site publishes.
 *
 * A posting has been through canonPlace() at ingest already; a DIRECTORY row
 * has not, and it names its department in `department` beside its own `school`
 * field. Running everything through canonPlace() here is what makes the
 * directory's "Management Science Department" the same entry as a posting's
 * "Management Science" instead of a second one — and it is idempotent, so
 * doing it to a posting again costs nothing.
 */
function partOf(r, w, fixes = []) {
  /* the approved name corrections (data/name-fixes.json), applied AFTER canon
     exactly as every row ingest applies them — so the option lists offer the
     corrected spelling and the old one stops being offered at all */
  const overlay = (place) => (fixes.length ? SCHOOLS.fixPlace(place, fixes) : place);
  /* A DIRECTORY row already has its three names in three columns (its
     department sits in `department`, there being no `unit`), so each is
     canonicalised ON ITS OWN.

     canonPlace() must NOT be used on one: its job is to take apart a value
     that names more than one thing, and a column that is already separate
     only loses by it — "School of Business-Camden" is Rutgers' campus, not a
     department, and "College of Engineering, Computing and Applied Sciences"
     is one college's name, but read as fused values they became a department
     called "Camden, Operations Management" and one called "Computing and
     Applied Sciences, Industrial Engineering". Both were offered by the form
     before this. A directory row often repeats the school in its department
     column too ("McDonough School of Business, Operations and Information
     Management Area"), which would publish the school twice on the card. */
  if (r.unit === undefined && r.department !== undefined && r.school !== undefined) {
    let unit = tidy(r.department);
    const lead = unit.split(',')[0];
    if (r.school && nameFold(lead) === nameFold(r.school)) unit = tidy(unit.slice(lead.length + 1));
    const place = overlay(canonColumns({ institution: r.institution, school: r.school, unit }));
    return { institution: place.institution, school: place.school, unit: place.unit, w };
  }

  /* A POSTING has been through canonPlace() at ingest already; running it
     again is idempotent and costs nothing, and it is what puts a row from
     anywhere else — a test fixture, an older file — on the same terms. */
  const split = (r.school !== undefined || r.unit !== undefined)
    ? { school: tidy(r.school), unit: tidy(r.unit) }
    : splitDepartment(r.department);
  const place = overlay(
    canonPlace({ institution: r.institution, school: split.school, unit: split.unit }));
  return { institution: place.institution, school: place.school, unit: place.unit, w };
}

const sortNames = (a, b) => a.localeCompare(b);

/** {school: Set(unit)} -> {school: [unit, ...]}, both sides sorted. */
function fromPairs(pairs) {
  const out = {};
  for (const k of [...pairs.keys()].sort(sortNames)) {
    const units = [...pairs.get(k)].sort(sortNames);
    if (units.length) out[k] = units;
  }
  return out;
}

/**
 * The option lists the form offers, derived from the published postings and
 * from the site's own Universities directory.
 *
 * `byUniversity` is what makes the lists useful rather than merely long, and
 * `bySchool` inside it is the third level of the cascade: with a university
 * chosen the form offers that university's schools, and with one of those
 * chosen it offers THAT school's departments. Both are HINTS, never
 * restrictions — a school can open a new department, and the form must not
 * make that unpostable.
 *
 * Every name is offered in ONE spelling (see pickForm), chosen inside the
 * scope it is offered in: a university's own list keeps that university's
 * spelling, which is not always the one the whole site uses most.
 */
export function buildVocab(rows, { generated = '', directory = [], fixes = [] } = {}) {
  // a directory that is not a list of rows is no directory at all, and must
  // not take the build down on its way to being reported
  const dir = Array.isArray(directory) ? directory : [];
  const parts = [
    ...rows.map((r) => partOf(r, 1, fixes)),
    ...dir.map((r) => partOf(r, 0, fixes)),
  ];

  const universities = tally(parts.map((p) => ({ v: p.institution, w: p.w })), uniKeyOf);
  const schools = tally(parts.map((p) => ({ v: p.school, w: p.w })));
  const units = tally(parts.map((p) => ({ v: p.unit, w: p.w })));

  /* every school's departments, across the site: the fallback the form uses
     when the university is one nobody has posted from yet */
  const bySchool = new Map();
  for (const p of parts) {
    if (!p.school || !p.unit) continue;
    const s = formOf(schools, p.school);
    if (!bySchool.has(s)) bySchool.set(s, new Set());
    bySchool.get(s).add(formOf(units, p.unit));
  }

  const grouped = new Map();
  for (const p of parts) {
    if (!p.institution) continue;
    const k = uniKeyOf(p.institution);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(p);
  }

  const byUniversity = {};
  for (const [k, own] of grouped) {
    const name = universities.get(k).v;
    const ownSchools = tally(own.map((p) => ({ v: p.school, w: p.w })));
    const ownUnits = tally(own.map((p) => ({ v: p.unit, w: p.w })));

    /* '' is a real key: the departments posted at this university WITHOUT a
       school, which is what the form offers while the school field is empty */
    const pairs = new Map();
    for (const p of own) {
      if (!p.unit) continue;
      const s = p.school ? formOf(ownSchools, p.school) : '';
      if (!pairs.has(s)) pairs.set(s, new Set());
      pairs.get(s).add(formOf(ownUnits, p.unit));
    }

    byUniversity[name] = {
      schools: [...ownSchools.values()].map((e) => e.v).sort(sortNames),
      units: [...ownUnits.values()].map((e) => e.v).sort(sortNames),
      bySchool: fromPairs(pairs),
    };
  }

  return {
    generated,
    universities: listOf(universities),
    schools: listOf(schools),
    units: listOf(units),
    byUniversity: Object.fromEntries(Object.entries(byUniversity).sort((a, b) => sortNames(a[0], b[0]))),
    bySchool: fromPairs(bySchool),
  };
}

/* --------------------------------- the school a posting never named

   THE PROBLEM, measured on the live workbook: fifteen of its sixteen postings
   reached the site with a department and NO SCHOOL — "University of California,
   Berkeley" and "Operations and Information Technology Management", with Haas
   missing; "University of Virginia" and "Technology and Operations Management",
   with Darden missing. The tracking sheet has one column for the hiring unit
   and contributors fill it with the department, which is the more specific of
   the two and the one the advert names.

   AND THE SITE ALREADY KNEW. `data/universities.json` is 254 curated
   (university, school, department) rows and its whole reason for existing is to
   say WHICH DEPARTMENT SITS IN WHICH SCHOOL — the third level of the posting
   form's cascade. It answers for five of those sixteen straight away, and for
   every future posting whose department the site has already seen.

   CURATED, NEVER GUESSED, and the same three guards `assemble()` in
   oa-schools.js applies to the fills it makes:

     - only when the school field is EMPTY. A row that named its school is
       never overruled, whatever the directory thinks;
     - only when EXACTLY ONE school at that university carries the department.
       Two is an ambiguity, not a fact, and the maintainer settles it on the
       review card;
     - the '' key is skipped. It means "departments at this university with no
       school on record", which is the absence being filled, not a school.

   It is the offline twin of `inferSchool` in assets/oa-place-picker.js — the
   same question, asked of the same file — so a posting the maintainer would
   have been offered the school for gets it without being asked.               */

/**
 * The one school at `institution` whose departments include `unit`, or ''.
 *
 * `vocab` is a built vocabulary (or the served data/vocab.json). `schools` is
 * assets/oa-schools.js, passed in rather than imported so this stays usable
 * from a shard that vendors its own copy.
 */
export function schoolForUnit(vocab, institution, unit, schools = SCHOOLS) {
  if (!institution || !unit) return '';
  const byUniversity = (vocab && vocab.byUniversity) || {};

  /* However the university is spelled: institutionKey is what the vocabulary
     itself groups by, so a posting saying "UC Berkeley" finds the entry filed
     under "University of California, Berkeley". */
  const want = schools.institutionKey(institution);
  let own = null;
  for (const name of Object.keys(byUniversity)) {
    if (schools.institutionKey(name) !== want) continue;
    own = byUniversity[name];
    break;
  }
  if (!own || !own.bySchool) return '';

  const key = (v) => schools.fold(schools.canonUnit(v, institution));
  const k = key(unit);
  if (!k) return '';

  const hits = Object.keys(own.bySchool).filter((s) =>
    s && own.bySchool[s].some((u) => key(u) === k));
  return hits.length === 1 ? hits[0] : '';
}

/**
 * A row with the school the directory says its department sits in.
 *
 * Returns the row unchanged when there is nothing to add — pure and
 * idempotent, so every writer can apply it on every run. The `department`
 * line is rebuilt with it, because that is what the card shows and what the
 * selftest asserts equals its two parts joined.
 */
export function fillSchoolFromDirectory(row, vocab, schools = SCHOOLS) {
  if (!row || row.school || !row.unit) return row;
  const school = schoolForUnit(vocab, row.institution, row.unit, schools);
  if (!school) return row;
  return { ...row, school, department: joinDepartment(school, row.unit) };
}

/* ------------------------------------------- where a university actually IS

   WHY A COUNTRY NEEDS AN AUTHORITY AT ALL. `country` is free text on the
   posting form and it drives the jobs page's Location filter, so a wrong one
   files a posting under a country it has nothing to do with — and nobody
   filtering by the right country ever sees it. Nine live postings were
   published under GREECE: American, Canadian and Singaporean universities,
   every one of them, while the workbook those postings came from said what it
   has always said. The cause was the Edit form's `country` box, which carried
   no `autocomplete` attribute and is called "country" — so the browser filled
   it from the EDITOR'S OWN address profile the moment they opened a posting to
   correct something else, and saving published it. That box is now
   `autocomplete="off"` (post-a-job.html), which stops it happening again; this
   is what repairs what already happened, on every build, without anyone having
   to remember.

   THE AUTHORITY IS THE SITE'S OWN Universities directory. Every row of
   data/universities.json carries the campus's POSTAL ADDRESS, and the last
   administrative part of an address is a country — `countryFromAddress` in
   assets/oa-countries.js reads it, and returns '' rather than a guess for the
   rows whose address is a map-URL fragment or a bare postcode.

   A UNIVERSITY WITH TWO COUNTRIES IS NEVER HEALED. INSEAD is in France and in
   Singapore, and a posting at either campus is right; so a university whose
   directory rows disagree about the country has no answer here at all, which
   is the same discipline `schoolForUnit` applies to a department two schools
   both claim. That guard is what makes correcting the others safe.           */

/** Curated campus countries for universities the Universities directory does
    not carry. The directory answers 197 of them; these are the ones that have
    POSTED here without ever being mapped, so the audit would otherwise have
    nothing to check them against.

    GROW THIS LIST, exactly as oa-institutions.js is grown — one line per
    university, and only where the campus country is not in doubt. A university
    with campuses in two countries belongs in neither this list nor the heal:
    leave it out and the audit stays quiet about it. */
export const CAMPUS_COUNTRY = {
  'Morgan State University': 'United States',        // Baltimore, Maryland
  'Rollins College': 'United States',                // Winter Park, Florida
  "St. John's University": 'United States',          // Queens, New York
  'University of California, Davis': 'United States', // Davis, California
};

/**
 * Which country each university's campus is in — the directory's addresses,
 * plus the curated list above.
 *
 * Keyed by `institutionKey`, so "The University of X" and "University of X"
 * are one university, exactly as the vocabulary groups them. A university
 * whose rows disagree is deliberately ABSENT rather than resolved.
 */
export function campusCountries(directory = [], schools = SCHOOLS) {
  const seen = new Map();

  const add = (institution, country) => {
    if (!institution || !country) return;
    const k = schools.institutionKey(institution);
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k).add(country);
  };

  for (const r of directory || []) {
    if (!r || !r.institution) continue;
    add(r.institution, COUNTRIES.countryFromAddress(r.address));
  }
  for (const [institution, country] of Object.entries(CAMPUS_COUNTRY)) {
    add(institution, country);
  }

  const out = new Map();
  for (const [k, set] of seen) if (set.size === 1) out.set(k, [...set][0]);
  return out;
}

/**
 * A row whose country contradicts where its university is, corrected.
 *
 * Returns the row unchanged when there is nothing to correct — pure and
 * idempotent, like `fillSchoolFromDirectory`, so every writer applies it on
 * every run and a run with nothing wrong writes nothing.
 *
 * It only ever CORRECTS a disagreement: a row whose country is already right,
 * or whose university this map has no single answer for, is returned as it
 * came. An EMPTY country is filled for the same reason a wrong one is
 * replaced — the Location filter cannot show a posting that names no place.
 */
export function healCountry(row, byUni, schools = SCHOOLS) {
  if (!row || !row.institution || !byUni) return row;
  const want = byUni.get(schools.institutionKey(row.institution));
  if (!want || want === row.country) return row;
  return { ...row, country: want };
}

/* --------------------------------- which school is the BUSINESS school

   THE QUESTION THE REVIEW CARD ASKS (owner, 2026-08-23): a crawled posting
   that mentions "business" is flagged under Type: Business School, and the
   card should then NAME the business school the site already knows at that
   university — "University of California, Berkeley" advertising a
   business-flavoured post is Haas's posting, and the site's own directory
   (data/vocab.json, fed by oa-institutions.js and universities.json) says so.

   ANSWERED FROM THE NAMES, never from a guess: a school IS the business
   school when its own name says business — "Walter A. Haas School of
   Business", "C. T. Bauer College of Business", "Kellogg School of
   Management" — and a university offering two such names is an ambiguity the
   maintainer settles, exactly as schoolForUnit treats two schools carrying
   one department. A school the pattern cannot read ("The Wharton School")
   simply is not named, which costs a mention and never a wrong one.        */

/** A school NAME that declares itself the business school. Deliberately wider
    than the posting-text patterns in jobmarket-sheet.mjs — a school with
    "business" anywhere in its NAME is business-related ("Bayes Business
    School", "Faculty of Business and Economics"), and the management/commerce
    forms cover the ones that never say the word. */
export const BUSINESS_SCHOOL_NAME_RX =
  /\bbusiness\b|school of management|management school|faculty of management|school of commerce/i;

/**
 * The one school at `institution` whose name says it is the business school,
 * or ''.
 *
 * The same lookup discipline as `schoolForUnit`: the university is found
 * through `institutionKey`, so any spelling the site canonicalises reaches
 * the entry, and only an UNAMBIGUOUS answer is given — none, or two, is ''.
 */
export function businessSchoolOf(vocab, institution, schools = SCHOOLS) {
  if (!institution) return '';
  const byUniversity = (vocab && vocab.byUniversity) || {};

  const want = schools.institutionKey(institution);
  let own = null;
  for (const name of Object.keys(byUniversity)) {
    if (schools.institutionKey(name) !== want) continue;
    own = byUniversity[name];
    break;
  }
  if (!own || !Array.isArray(own.schools)) return '';

  const hits = own.schools.filter((s) => s && BUSINESS_SCHOOL_NAME_RX.test(s));
  return hits.length === 1 ? hits[0] : '';
}

/**
 * The one university whose school list carries `name`, as
 * `{ institution, school }` — or null.
 *
 * The inverse of `businessSchoolOf`, with the same lookup discipline: the
 * name is canonicalised first (so "Sloan School of Management" reaches the
 * entry filed under the full official name), compared FOLDED, and only an
 * UNAMBIGUOUS answer is given — a school name two universities both use
 * ("College of Business") identifies neither. This is what lets an
 * advertisement whose hiring organisation is a SCHOOL ("Harvard Business
 * School", the Interfolio shape) be filed under its university.
 */
export function universityForSchool(vocab, name, schools = SCHOOLS) {
  const want = schools.fold(schools.canonSchool(String(name || '')));
  if (!want) return null;
  const byUniversity = (vocab && vocab.byUniversity) || {};

  const hits = [];
  for (const uni of Object.keys(byUniversity)) {
    const own = byUniversity[uni];
    const names = Array.isArray(own && own.schools) ? own.schools
      : Object.keys((own && own.bySchool) || {});
    for (const s of names) {
      if (s && schools.fold(schools.canonSchool(s)) === want) {
        hits.push({ institution: uni, school: s });
        break;
      }
    }
    if (hits.length > 1) return null;
  }
  return hits.length === 1 ? hits[0] : null;
}

/** Stable JSON with a trailing newline, so a diff shows the names that changed. */
export function serialiseVocab(vocab) {
  return JSON.stringify(vocab, null, 1) + '\n';
}
