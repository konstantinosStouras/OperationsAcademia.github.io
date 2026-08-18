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
const { canonPlace, fold: nameFold } = SCHOOLS;

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
 * Group spellings of one name, count the POSTINGS behind each (directory rows
 * carry no count) and keep one spelling per place. Returns a Map keyed by the
 * fold so a caller can look a raw value up; `n` is a posting count, which is
 * what the form's "4 postings" note means.
 */
function tally(items) {
  const by = new Map();
  for (const it of items) {
    const v = tidy(it.v);
    if (!v) continue;
    const k = nameFold(v);
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
  const k = nameFold(v);
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
function partOf(r, w) {
  const split = (r.school !== undefined || r.unit !== undefined)
    ? { school: tidy(r.school), unit: tidy(r.unit) }
    : splitDepartment(r.department);
  // the directory has no `unit`: its department sits in `department`
  if (r.unit === undefined && r.department !== undefined && r.school !== undefined) {
    split.unit = tidy(r.department);
  }
  const place = canonPlace({ institution: r.institution, school: split.school, unit: split.unit });
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
export function buildVocab(rows, { generated = '', directory = [] } = {}) {
  const parts = [
    ...rows.map((r) => partOf(r, 1)),
    ...directory.map((r) => partOf(r, 0)),
  ];

  const universities = tally(parts.map((p) => ({ v: p.institution, w: p.w })));
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
    const k = nameFold(p.institution);
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

/** Stable JSON with a trailing newline, so a diff shows the names that changed. */
export function serialiseVocab(vocab) {
  return JSON.stringify(vocab, null, 1) + '\n';
}
