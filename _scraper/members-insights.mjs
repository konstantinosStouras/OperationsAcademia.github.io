/* ---------------------------------------------------------------------------
   Operations Academia — who the registered members are, ANONYMOUSLY, and
   only from what they told the site themselves.

   Owner, 2026-10-01: "add (anonymous and very interesting) insights/
   statistics about the characteristics of our users: gender, affiliation
   histogram/table, etc.", and then, the same day: "don't make guesses, it's
   risky. use only information actually provided from the users themselves."

   This file is the pure half: it turns what the roster sync reads with the
   Admin SDK (the Auth record and the profile of every account) into COUNTS,
   and nothing but counts reaches the served file, data/users-insights.json,
   which the analytics page draws.

   NOTHING IS INFERRED ABOUT A PERSON. Every figure is a count of something a
   member stated or did on the site:

     affiliation   what they typed on their profile, matched to a university
                   the site lists ONLY by name: the site's own canon and its
                   curated aliases, a curated short form (SHORT_FORMS), a
                   school the site lists under exactly one university, the
                   acronym a university's own listed name declares ("(MIT)"),
                   or the university's full name written in what they typed.
                   Anything else is counted as "another affiliation", never
                   placed and never sorted into a kind by its words.
     country       the country of the university they named (the site's own
                   directory says where its universities are), or a country
                   they wrote as the last part of their affiliation. Never
                   from an e-mail address.
     sign-in       the ways they chose to sign in.
     ORCID iD      whether they put one on their profile or signed in with it.
     roles         whether they hold a live candidate profile for the season
                   under way, and whether they have posted a job.

   THERE IS NO GENDER FIGURE, deliberately. The site has never asked anybody
   their gender, and reading it off a first name is a guess about a person,
   which the owner ruled out. If gender is ever to be shown it has to be asked,
   as an optional question on the profile, and counted from the answers.

   THE PERSON NEVER LEAVES MEMORY. `memberFacts` reads one account and keeps
   only a university KEY, a country name, whether an affiliation was given,
   the sign-in methods and whether an ORCID iD is on file. No name, no
   address, no affiliation as typed. `membersInsights` counts those facts; the
   uid they carry is the join key to the tally and the role sets and is
   dropped before anything is written.

   FOUR RULES KEEP THE SERVED FILE ANONYMOUS, each pinned by the selftest:

   1. COUNTS ONLY. No name, no e-mail address, no uid, no free text a member
      typed. A university or a country is named only by the site's own name.
   2. NO GROUP SMALLER THAN K_MIN (3) IS NAMED. A university or a country with
      one or two members is folded into "the rest", so no row can stand for
      one person.
   3. NO CROSS-TABULATION. Every figure counts one fact over everybody.
   4. BELOW MIN_MEMBERS (20) NOTHING IS PUBLISHED AT ALL.
   --------------------------------------------------------------------------- */

import { createRequire } from 'node:module';
import { campusCountries } from './vocab.mjs';

const require = createRequire(import.meta.url);
const SCHOOLS = require('../assets/oa-schools.js');
const COUNTRIES = require('../assets/oa-countries.js');
const AFFILIATION = require('../assets/oa-affiliation.js');
const NAV = require('../assets/oa-jobnav.js');

/** The smallest group a named row of the served file may stand for. */
export const K_MIN = 3;
/** Fewer members than this and nothing is published. */
export const MIN_MEMBERS = 20;
/** The most universities the table names (all of them at K_MIN or more). */
export const MAX_UNIVERSITIES = 40;
/** EXACTLY the keys the served file carries, in order (pinned by the selftest). */
export const INSIGHTS_KEYS = ['generated', 'members', 'k', 'affiliation', 'universities',
  'countries', 'signIn', 'roles', 'profile'];
/** The keys memberFacts keeps about one account, and nothing else. */
export const FACT_KEYS = ['uid', 'disabled', 'affiliation', 'university', 'country', 'methods', 'orcid'];
/** A candidate profile the build publishes is live: the candidates build's
    own query, and assets/oa-users.js's CANDIDATE_LIVE (pinned both ways). */
export const CANDIDATE_LIVE = ['queued', 'published'];
/** The sign-in providers the site offers, by Firebase's provider id. */
export const PROVIDERS = { 'google.com': 'google', 'password': 'password', 'oidc.orcid': 'orcid' };

/** lower case, accents and punctuation gone, single spaces */
const norm = (s) => SCHOOLS.fold(s);
const STOP = new Set(['of', 'the', 'and', 'at', 'in', 'for', 'de', 'la', 'le', 'des', 'del', 'di', 'du', 'und', 'y', 'et', 'a']);

/** Short forms members type that the site's own data does not spell, each to
    the full name the site lists. CURATED: an entry is a decision, made once,
    for a short form nobody could mean otherwise; it is never derived. The
    selftest holds every target to a university the committed index carries.

    THE TABLE LIVES IN assets/oa-affiliation.js since 2026-10-01, because the
    registration form's affiliation picker and the daily pass that
    standardises members' affiliations read the same short forms these counts
    do: two copies of one curated table drift, silently. Re-exported here so
    every caller of this module reads it where it always did. */
export const SHORT_FORMS = AFFILIATION.SHORT_FORMS;
/** Federations whose member schools are institutions in their own right
    ("London Business School" is listed under the University of London): a
    name is never folded INTO one of these. */
export const FEDERATIONS = new Set(['university of london', 'university of california',
  'state university of new york', 'city university of new york']);

function addTo(map, k, v) {
  if (!k) return;
  if (!map.has(k)) map.set(k, new Set());
  map.get(k).add(v);
}

/** The acronym a listed name DECLARES in brackets at its end: "(MIT)" ->
    "MIT". Never one worked out from a name's initials. */
function declaredAcronym(name) {
  const m = String(name || '').match(/\(([A-Z][A-Za-z&./]{1,9})\)\s*$/);
  if (!m) return '';
  return (m[1].match(/[A-Z]/g) || []).length >= 2 ? m[1].replace(/[./]/g, '').toUpperCase() : '';
}

/** A name with stop words and a declared acronym gone, so "University of
    North Carolina at Chapel Hill" and "University of North Carolina (UNC)
    Chapel Hill" read as the same name. */
function looseKey(name) {
  return norm(String(name || '').replace(/\(([^)]*)\)/g, (m, inner) =>
    ((inner.match(/[A-Z]/g) || []).length >= 2 && !/[a-z]{3,}/.test(inner) ? ' ' : ' ' + inner + ' ')))
    .split(' ').filter((w) => w && !STOP.has(w)).join(' ');
}

/**
 * Everything an affiliation is matched against, built once from the files the
 * checkout already carries:
 *   vocab         data/vocab.json        (universities, their schools)
 *   directory     data/directory.json    (the Universities directory)
 *   universities  data/universities.json (the archive, with addresses)
 *
 * ONE UNIVERSITY, ONE ROW. Those files list some universities a second time,
 * under the name a posting was made with ("MIT Sloan", "Columbia Business
 * School", "Cornell University/ Cornell Tech"). Such a name is folded into the
 * university the site's OWN DATA says it belongs to, by four routes and no
 * others: the same name spelled two ways (looseKey); a curated short form; a
 * school the site lists under exactly one university; and a university's full
 * listed name followed by a suffix in brackets or after a slash ("Indiana
 * University (Kelley)"). Nothing is folded into a federation. A name none of
 * these reaches stays its own row.
 */
export function affiliationIndex({ vocab, directory, universities } = {}) {
  const byKey = new Map();          // institutionKey -> display name
  const bySchool = new Map();       // norm(canonSchool(school)) -> Set(key)
  const byAcronym = new Map();      // DECLARED acronym -> Set(key)
  const spellings = new Map();      // key -> Set(name as written somewhere)

  const keyOf = (name) => SCHOOLS.institutionKey(name);
  const addUni = (name) => {
    const n = String(name || '').trim();
    if (!n) return '';
    const k = keyOf(n);
    if (!k) return '';
    if (!byKey.has(k)) byKey.set(k, SCHOOLS.canonInstitution(n));
    addTo(spellings, k, n);
    return k;
  };
  const addSchool = (k, school) => {
    const s = String(school || '').trim();
    if (k && s) addTo(bySchool, norm(SCHOOLS.canonSchool(s)), k);
  };

  const bu = (vocab && vocab.byUniversity) || {};
  for (const u of Object.keys(bu)) {
    const k = addUni(u);
    const own = bu[u] || {};
    for (const s of own.schools || []) addSchool(k, s);
    for (const s of Object.keys(own.bySchool || {})) addSchool(k, s);
  }
  for (const r of directory || []) {
    const k = addUni(r && r.institution);
    if (r && r.school) addSchool(k, r.school);
  }
  for (const r of universities || []) {
    const k = addUni(r && r.institution);
    if (r && r.school) addSchool(k, r.school);
  }
  for (const [k, names] of spellings) for (const n of names) addTo(byAcronym, declaredAcronym(n), k);

  /* the full names a typed affiliation may CONTAIN, longest first, so
     "University of California, Berkeley" is found before "University of
     California". Two words at least: one word inside a sentence is not the
     member having named that university. */
  const contained = [];
  for (const [k, names] of spellings) {
    for (const n of names) {
      const f = norm(n);
      if (f.length >= 8 && f.split(' ').length >= 2) contained.push([f, k]);
    }
  }
  contained.sort((a, b) => b[0].length - a[0].length);

  /* where each university is: the archive's addresses (campusCountries, the
     build's own rule), then the directory's own single country */
  const country = new Map();
  for (const [k, c] of campusCountries(universities || [])) if (c) country.set(k, c);
  const dirCountries = new Map();
  for (const r of directory || []) {
    if (!r || !r.institution || !r.country) continue;
    addTo(dirCountries, keyOf(r.institution), r.country);
  }
  for (const [k, set] of dirCountries) if (!country.has(k) && set.size === 1) country.set(k, [...set][0]);

  const idx = { byKey, bySchool, byAcronym, contained, country, parent: new Map(), canon: new Map() };
  for (const k of byKey.keys()) {
    const p = findParent(k, idx);
    if (p) idx.parent.set(k, p);
  }
  for (const k of byKey.keys()) {
    let top = k;
    const seen = new Set([top]);
    while (idx.parent.has(top) && !seen.has(idx.parent.get(top))) {
      top = idx.parent.get(top);
      seen.add(top);
    }
    idx.canon.set(k, top);
  }
  /* a folded row's country: its own, else what every name under it agrees on */
  const kids = new Map();
  for (const [k, top] of idx.canon) if (country.has(k)) addTo(kids, top, country.get(k));
  for (const [top, set] of kids) if (!country.has(top) && set.size === 1) country.set(top, [...set][0]);
  return idx;
}

/** For any listed name, the KEY of the university the index folds it under,
    or '' where it is its own: the rule the registration form's affiliation
    list folds a duplicate card by (build-directory.mjs), so the list and
    these counts agree about what one university is. */
export function parentKeyOf(idx) {
  return (name) => {
    const k = SCHOOLS.institutionKey(name);
    const top = idx && idx.canon ? idx.canon.get(k) : '';
    return top && top !== k ? top : '';
  };
}

/** The university the site's own data says a listed name belongs to, or ''.
    See affiliationIndex for the four routes. */
function findParent(k, idx) {
  const name = idx.byKey.get(k);
  const kn = norm(name);
  const ok = (p) => !!p && p !== k && idx.byKey.has(p) && !FEDERATIONS.has(p);

  /* 1. the same name spelled two ways: the one without brackets, then the
        longer, is the row */
  const lk = looseKey(name);
  const twins = [...idx.byKey.keys()].filter((o) => o !== k && looseKey(idx.byKey.get(o)) === lk);
  if (twins.length) {
    const all = [k, ...twins].sort((a, b) => {
      const ba = /\(/.test(idx.byKey.get(a)) ? 1 : 0;
      const bb = /\(/.test(idx.byKey.get(b)) ? 1 : 0;
      return ba - bb || idx.byKey.get(b).length - idx.byKey.get(a).length || (a < b ? -1 : 1);
    });
    if (all[0] !== k && ok(all[0])) return all[0];
  }
  /* 2. a curated short form */
  if (Object.prototype.hasOwnProperty.call(SHORT_FORMS, kn)) {
    const p = SCHOOLS.institutionKey(SHORT_FORMS[kn]);
    if (ok(p)) return p;
  }
  /* 3. a school the site lists under exactly one university */
  const schoolOf = [...(idx.bySchool.get(norm(SCHOOLS.canonSchool(name))) || [])].filter((x) => x !== k);
  if (schoolOf.length === 1 && ok(schoolOf[0])) return schoolOf[0];
  /* 4. a listed university's full name, then a suffix in brackets or after a
        slash ("Indiana University (Kelley)", "Cornell University/ Cornell Tech") */
  const m = String(name).match(/^(.*?)\s*(?:\(|\/)/);
  if (m && m[1]) {
    const p = SCHOOLS.institutionKey(m[1]);
    if (ok(p)) return p;
  }
  return '';
}

/** One hit from a set of candidates, or '' when there are none or several. */
function only(set) {
  return set && set.size === 1 ? [...set][0] : '';
}

/**
 * The university a member's typed affiliation NAMES, as the key of its row in
 * the index, or ''. By name only, segment by segment (a comma, a slash,
 * brackets, " at "): the site's own canon of the segment; a curated short
 * form; a school the site lists under exactly one university; the acronym a
 * listed name declares; and, last, a listed university's full name written
 * inside what they typed ("PhD student at Cornell University"). Nothing is
 * read off a single word, a city or the initials of anything: an affiliation
 * none of these names is "another affiliation".
 */
export function resolveAffiliation(text, idx) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || !idx) return '';
  const map = (k) => idx.canon.get(k) || k;
  const has = (k) => !!k && idx.byKey.has(k);
  const segs = [t, ...t.split(/\s*[,;|/()–—]\s*|\s+-\s+|\s+(?:at|@)\s+/i)]
    .map((s) => s.trim()).filter(Boolean);

  for (const s of segs) {
    const k = SCHOOLS.institutionKey(s);
    if (has(k)) return map(k);
  }
  for (const s of segs) {
    const n = norm(s);
    const full = Object.prototype.hasOwnProperty.call(SHORT_FORMS, n) ? SHORT_FORMS[n] : '';
    const k = full ? SCHOOLS.institutionKey(full) : '';
    if (has(k)) return map(k);
  }
  for (const s of segs) {
    const k = only(new Set([...(idx.bySchool.get(norm(SCHOOLS.canonSchool(s))) || [])].map(map)));
    if (k) return k;
  }
  for (const s of segs) {
    if (!/^[A-Z][A-Z&]{1,8}$/.test(s)) continue;
    const k = only(new Set([...(idx.byAcronym.get(s.replace(/&/g, '')) || [])].map(map)));
    if (k) return k;
  }
  const whole = ' ' + norm(t) + ' ';
  for (const [f, k] of idx.contained) {
    if (whole.includes(' ' + f + ' ')) return map(k);
  }
  return '';
}

/** A country the member WROTE as the last part of their affiliation
    ("University of Patras, Greece"), by the site's own country list, or ''.
    Never a state, a city or a word inside a name. */
export function statedCountry(text) {
  const t = String(text || '');
  if (t.indexOf(',') === -1) return '';
  const last = t.split(',').pop().trim();
  const c = last ? COUNTRIES.canon(last) : '';
  return c && COUNTRIES.LIST.indexOf(c) !== -1 ? c : '';
}

/* ------------------------------------------------------------- one member */

/**
 * The FACTS the figures need about one account, and nothing else (FACT_KEYS).
 * `user` is the Auth record (UserRecord or a plain object of the same shape),
 * `profile` its profiles/{uid} document. The affiliation as typed is read
 * here and never returned.
 */
export function memberFacts(user, profile, ctx) {
  const u = user || {};
  const p = profile || {};
  const idx = ctx && ctx.index;
  const methods = [...new Set((u.providerData || []).map((x) => PROVIDERS[x && x.providerId] || 'other'))].sort();
  const typed = String(p.affiliation || '').trim();
  const key = resolveAffiliation(typed, idx);
  const country = (key && idx ? idx.country.get(key) || '' : '') || statedCountry(typed);
  return {
    uid: String(u.uid || ''),
    disabled: !!u.disabled,
    affiliation: key ? 'listed' : typed ? 'other' : 'none',
    university: key,
    country,
    methods,
    orcid: !!p.orcid || methods.includes('orcid'),
  };
}

/* ------------------------------------------------------------- everybody */

function tally(list, pick) {
  const m = new Map();
  for (const f of list) {
    const v = pick(f);
    if (!v) continue;
    m.set(v, (m.get(v) || 0) + 1);
  }
  return m;
}

/** The ranked rows of a tally at K_MIN or more, and how many members the
    smaller groups hold between them. */
function named(map, max, extra) {
  const rows = [...map].filter(([, n]) => n >= K_MIN)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, max);
  const shown = new Set(rows.map(([k]) => k));
  let rest = 0;
  for (const [k, n] of map) if (!shown.has(k)) rest += n;
  return { rows: rows.map(([k, n]) => ({ ...extra(k), members: n })), rest };
}

/**
 * data/users-insights.json, or NULL when there are too few members to say
 * anything about them (MIN_MEMBERS). `facts` is memberFacts for every Auth
 * account; only the MEMBERS count (not disabled, carrying a registeredUsers
 * mark: the same people the front page and the growth chart count).
 * `candidates` and `posters` are uid sets, or null when their read failed
 * (and then `roles` is null rather than a false zero).
 */
export function membersInsights(facts, { marks, candidates = null, posters = null, now, index } = {}) {
  const has = marks instanceof Set ? marks : new Set(marks || []);
  const list = (facts || []).filter((f) => f && !f.disabled && has.has(f.uid));
  if (list.length < MIN_MEMBERS) return null;
  const at = now instanceof Date ? now : new Date(now || Date.now());
  const count = (pred) => list.filter(pred).length;

  const affiliation = {
    listed: count((f) => f.affiliation === 'listed'),
    other: count((f) => f.affiliation === 'other'),
    none: count((f) => f.affiliation === 'none'),
  };

  const byUni = tally(list, (f) => f.university);
  const unis = named(byUni, MAX_UNIVERSITIES, (k) => ({
    name: (index && index.byKey.get(k)) || k,
    country: (index && index.country.get(k)) || '',
  }));
  const universities = { count: byUni.size, shown: unis.rows, rest: unis.rest };

  const byCountry = tally(list, (f) => f.country);
  const cs = named(byCountry, 60, (k) => ({ name: k }));
  const countries = { count: byCountry.size, shown: cs.rows, rest: cs.rest, unknown: count((f) => !f.country) };

  const one = (m) => (f) => f.methods.length === 1 && f.methods[0] === m;
  const signIn = {
    google: count(one('google')),
    password: count(one('password')),
    orcid: count(one('orcid')),
    several: count((f) => f.methods.length > 1),
  };

  const roles = candidates instanceof Set && posters instanceof Set
    ? { season: NAV.marketLabel(NAV.marketYear(at)), candidates: count((f) => candidates.has(f.uid)),
        posters: count((f) => posters.has(f.uid)) }
    : null;

  return {
    generated: at.toISOString(),
    members: list.length,
    k: K_MIN,
    affiliation,
    universities,
    countries,
    signIn,
    roles,
    profile: { orcid: count((f) => f.orcid) },
  };
}

/** The uids holding a LIVE candidate profile for the season under way, from
    candidateSubmissions documents ({ uid, year, status }). */
export function candidateUids(docs, now) {
  const year = NAV.marketYear(now instanceof Date ? now : new Date(now || Date.now()));
  const out = new Set();
  for (const d of docs || []) {
    if (!d || !d.uid || !CANDIDATE_LIVE.includes(d.status)) continue;
    if (Math.trunc(Number(d.year)) === year) out.add(String(d.uid));
  }
  return out;
}

/** The uids that have posted at least one job through the site's form, from
    jobSubmissions documents ({ uid, status }). A tracking-sheet MIRROR
    (status 'sheet') is the workbook's, not anybody's posting. */
export function posterUids(docs) {
  const out = new Set();
  for (const d of docs || []) {
    if (!d || !d.uid || d.status === 'sheet') continue;
    out.add(String(d.uid));
  }
  return out;
}

/** Is this a served insights document a reader may be shown? The exact keys,
    every count a whole number, every named row at K_MIN or more, and nothing
    shaped like an address anywhere in it. Used by the selftest over the
    committed file. The committed seed, { generated: '', members: 0 }, passes. */
export function insightsProblems(doc) {
  const out = [];
  if (!doc || typeof doc !== 'object') return ['not an object'];
  const keys = Object.keys(doc);
  const seed = keys.length === 2 && keys[0] === 'generated' && keys[1] === 'members' && doc.members === 0;
  if (!seed && JSON.stringify(keys) !== JSON.stringify(INSIGHTS_KEYS)) out.push('keys are ' + keys.join(','));
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(JSON.stringify(doc))) out.push('carries an address');
  const walk = (v, where) => {
    if (typeof v === 'number' && !(Number.isInteger(v) && v >= 0)) out.push(where + ' is not a whole number');
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, where + '[' + i + ']'));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, where + '.' + k);
  };
  walk(doc, 'doc');
  for (const part of ['universities', 'countries']) {
    for (const r of (doc[part] && doc[part].shown) || []) {
      if (!(r.members >= K_MIN)) out.push(part + ' names a group under ' + K_MIN);
    }
  }
  if (doc.members && doc.members < MIN_MEMBERS) out.push('fewer than ' + MIN_MEMBERS + ' members');
  return out;
}
