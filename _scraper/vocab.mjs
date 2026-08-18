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

   ONE SPELLING PER PLACE. Names are grouped by assets/oa-names.js's key(), so
   "A.B. Freeman School of Business" and "Freeman School of Business" are one
   entry rather than two, and the spelling OFFERED is one somebody actually
   wrote: the directory's, where it knows the name, else the most-posted one.

   Everything here is PURE and needs no network, so the selftest covers it.
   --------------------------------------------------------------------------- */

import { createRequire } from 'node:module';

/* One spelling per university, school and department — shared with the
   browser, exactly as jobs-model.mjs shares oa-countries.js. key() decides
   when two spellings are one place; it is never displayed. */
const require = createRequire(import.meta.url);
export const NAMES = require('../assets/oa-names.js');
export const nameKey = NAMES.key;

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
    "operations management " are one entry rather than two. The LOOSER identity
    that also folds away "The", donor initials, "&"/"and", plurals and a
    trailing "Department"/"Area"/"Group" is nameKey (assets/oa-names.js). */
export function vocabKey(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Which spelling of a name the site publishes, among the ones it has seen.
 *
 * The DIRECTORY WINS where it knows the name — data/universities.json is
 * curated and barely moves, so anchoring on it is what keeps the offered
 * spelling stable instead of flipping the day a posting tips the count. After
 * that: the most-posted spelling, then the most-written, then the fullest
 * ("Department" over "Dept"), then alphabetical so the result never depends on
 * the order rows arrive in.
 */
function pickForm(forms) {
  return [...forms.entries()].sort((a, b) =>
    (b[1].dir - a[1].dir) ||
    (b[1].w - a[1].w) ||
    (b[1].c - a[1].c) ||
    (b[0].length - a[0].length) ||
    a[0].localeCompare(b[0]))[0][0];
}

/**
 * Group spellings of one name, count the POSTINGS behind each (directory rows
 * carry no count) and keep one spelling per place. Returns a Map keyed by
 * nameKey so a caller can look a raw value up; `n` is a posting count, which
 * is what the form's "4 postings" note means.
 */
function tally(items) {
  const by = new Map();
  for (const it of items) {
    const v = tidy(it.v);
    if (!v) continue;
    const k = nameKey(v);
    if (!k) continue;
    const e = by.get(k) || { n: 0, forms: new Map() };
    e.n += it.w;
    const f = e.forms.get(v) || { w: 0, c: 0, dir: false };
    f.w += it.w;
    f.c += 1;
    f.dir = f.dir || !!it.dir;
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
  const k = nameKey(v);
  const hit = k && t.get(k);
  return hit ? hit.v : tidy(v);
}

/** One (institution, school, unit) triple, however the row spells them. */
function partOf(r, w, dir) {
  const split = (r.school !== undefined || r.unit !== undefined)
    ? { school: tidy(r.school), unit: tidy(r.unit) }
    : splitDepartment(r.department);
  // the directory names the unit in `department`; only split when it is alone
  if (dir && r.school !== undefined) {
    split.school = tidy(r.school);
    split.unit = split.school ? tidy(r.department) : splitDepartment(r.department).unit;
    if (!split.school) split.school = splitDepartment(r.department).school;
  }
  return { institution: tidy(r.institution), school: split.school, unit: split.unit, w, dir };
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
    ...rows.map((r) => partOf(r, 1, false)),
    ...directory.map((r) => partOf(r, 0, true)),
  ];

  const universities = tally(parts.map((p) => ({ v: p.institution, w: p.w, dir: p.dir })));
  const schools = tally(parts.map((p) => ({ v: p.school, w: p.w, dir: p.dir })));
  const units = tally(parts.map((p) => ({ v: p.unit, w: p.w, dir: p.dir })));

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
    const k = nameKey(p.institution);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(p);
  }

  const byUniversity = {};
  for (const [k, own] of grouped) {
    const name = universities.get(k).v;
    const ownSchools = tally(own.map((p) => ({ v: p.school, w: p.w, dir: p.dir })));
    const ownUnits = tally(own.map((p) => ({ v: p.unit, w: p.w, dir: p.dir })));

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

/**
 * One spelling per place, applied to the postings themselves.
 *
 * The vocabulary decides which spelling the form OFFERS; this is what stops
 * the site from showing the other one on a card that was posted before the
 * lists existed. It rewrites nothing but the two name parts and the published
 * line they compose, and only where the spelling actually changes.
 *
 * `institution` is deliberately LEFT ALONE: a posting's id, its permalink and
 * its Universities-page link are all derived from it (jobs-model.jobId,
 * rowFromSubmission), so renaming one would break links that are already out
 * in the world. The university picker still offers a single spelling — that is
 * what keeps the next posting consistent.
 *
 * Pure, and idempotent: running it twice changes nothing the second time.
 */
export function canonicaliseNames(rows, vocab) {
  const byUni = new Map();
  for (const [name, e] of Object.entries(vocab.byUniversity || {})) {
    byUni.set(nameKey(name), {
      schools: NAMES.index(e.schools || []),
      units: NAMES.index(e.units || []),
    });
  }
  const allSchools = NAMES.index((vocab.schools || []).map((o) => o.v));
  const allUnits = NAMES.index((vocab.units || []).map((o) => o.v));

  const changed = [];
  const out = rows.map((row) => {
    const own = byUni.get(nameKey(row.institution)) || null;
    const school = NAMES.canon(row.school, (own && own.schools) || allSchools);
    const unit = NAMES.canon(row.unit, (own && own.units) || allUnits);
    if (school === tidy(row.school) && unit === tidy(row.unit)) return row;

    changed.push({
      id: row.id || row.ref || '',
      from: joinDepartment(row.school, row.unit),
      to: joinDepartment(school, unit),
    });
    return { ...row, school, unit, department: joinDepartment(school, unit) };
  });

  return { rows: out, changed };
}

/** Stable JSON with a trailing newline, so a diff shows the names that changed. */
export function serialiseVocab(vocab) {
  return JSON.stringify(vocab, null, 1) + '\n';
}
