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

   WHERE THE OPTIONS COME FROM. The postings themselves — `data/jobs.json`.
   Every writer of that file also writes `data/vocab.json`, so a name entered
   today is on tomorrow's list without anyone curating anything. That is the
   whole "add it to the list automatically" mechanism: there is no second store
   to keep in step, and a name that stops being used stops being offered.

   Everything here is PURE and needs no network, so the selftest covers it.
   --------------------------------------------------------------------------- */

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
    "operations management " are one entry rather than two. */
export function vocabKey(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Distinct values with usage counts, most-used first then alphabetical. The
    spelling kept is the one used most; a tie goes to the longer form, which is
    almost always the fuller name ("Dept" vs "Department"). */
function tally(values) {
  const by = new Map();
  for (const raw of values) {
    const v = tidy(raw);
    if (!v) continue;
    const k = vocabKey(v);
    if (!k) continue;
    const e = by.get(k) || { v, n: 0, forms: new Map() };
    e.n++;
    e.forms.set(v, (e.forms.get(v) || 0) + 1);
    by.set(k, e);
  }
  const out = [];
  for (const e of by.values()) {
    const best = [...e.forms.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
    out.push({ v: best[0], n: e.n });
  }
  return out.sort((a, b) => b.n - a.n || a.v.localeCompare(b.v));
}

/**
 * The option lists the form offers, derived from the published postings.
 *
 * `byUniversity` is what makes the lists useful rather than merely long: with
 * a university chosen, the schools and units already seen at that university
 * are offered first. It is a HINT, never a restriction — a school can open a
 * new department, and the form must not make that unpostable.
 */
export function buildVocab(rows, { generated = '' } = {}) {
  const parts = rows.map((r) => {
    const school = r.school !== undefined || r.unit !== undefined
      ? { school: tidy(r.school), unit: tidy(r.unit) }
      : splitDepartment(r.department);
    return { institution: tidy(r.institution), ...school };
  });

  const byUniversity = {};
  for (const p of parts) {
    if (!p.institution) continue;
    const e = byUniversity[p.institution] || (byUniversity[p.institution] = { schools: [], units: [] });
    if (p.school && !e.schools.includes(p.school)) e.schools.push(p.school);
    if (p.unit && !e.units.includes(p.unit)) e.units.push(p.unit);
  }
  for (const e of Object.values(byUniversity)) {
    e.schools.sort((a, b) => a.localeCompare(b));
    e.units.sort((a, b) => a.localeCompare(b));
  }

  return {
    generated,
    universities: tally(parts.map((p) => p.institution)),
    schools: tally(parts.map((p) => p.school)),
    units: tally(parts.map((p) => p.unit)),
    byUniversity: Object.fromEntries(Object.entries(byUniversity).sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

/** Stable JSON with a trailing newline, so a diff shows the names that changed. */
export function serialiseVocab(vocab) {
  return JSON.stringify(vocab, null, 1) + '\n';
}
