/* ---------------------------------------------------------------------------
   Operations Academia — reading an advertisement that is only TEXT.

   adverts.mjs reads an advertisement from its MARKUP: the JSON-LD block, the
   <strong>Label:</strong> pairs, the <th>/<td> tables. Two kinds of
   advertisement the POMS job postings page links to have no markup at all:

     - a PDF (347 of the 381 postings on the page on 2026-09-23), whose text
       arrives as lines in reading order from pdf-text.mjs;
     - a JavaScript shell such as apply.interfolio.com, whose HTML carries
       nothing (every one of the 42 Interfolio pages in data/adverts.json is
       recorded as `unreadable`) and whose CONTENT only exists once a browser
       has run it — render-page.mjs hands that back as the page's innerText.

   This is the one reading of such text, in adverts.mjs's own parse shape, so
   the queue document's `ad` block, the review card and the review e-mail draw
   a PDF's facts exactly as they draw a web page's. The date rules are the
   ones every other ingest here applies, and they are IMPORTED rather than
   copied: `deadlineFrom` and `advertDate` (adverts.mjs) for a labelled or
   phrased closing date, `extractReviewDate` and `extractFinalDate`
   (jobs-model.mjs) for a first-review date and a labelled final one. A date
   this cannot read is not a date, which is the deadlineDay discipline: prose
   is carried, never guessed at.

   PURE. It reads no file and no network, so selftest.mjs drives it offline.
   --------------------------------------------------------------------------- */

import { createRequire } from 'node:module';

import { text, extractReviewDate, extractFinalDate } from './jobs-model.mjs';
import {
  deadlineFrom, advertDate, DEADLINE_LABELS, LISTING_END_LABELS,
  SCHOOL_LABELS, DEPARTMENT_LABELS,
} from './adverts.mjs';

const require = createRequire(import.meta.url);
const COUNTRIES = require('../assets/oa-countries.js');

/* ---------------------------------------------------------------- labels */

/** The labels a text advertisement states its facts under, beside the ones
    adverts.mjs already knows. Lower-cased, matched exactly against a line's
    own label — never against prose. */
export const TEXT_LABELS = [
  ...DEADLINE_LABELS, ...LISTING_END_LABELS, ...SCHOOL_LABELS, ...DEPARTMENT_LABELS,
  'location', 'city', 'country', 'campus',
  'open date', 'posted', 'date posted', 'posting date', 'date',
  'position title', 'job title', 'title', 'position',
  'institution', 'university', 'employer', 'hiring organization', 'organization',
  'rank', 'position type', 'employment type', 'type',
  'priority deadline', 'review date', 'application review date', 'review begins',
];

const LABEL_SET = new Set(TEXT_LABELS);

/** The non-empty lines of a text, trimmed and with runs of blanks folded. */
export function textLines(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Every `Label: value` pair the text states, as a Map keyed by lower-cased
 * label — the text twin of adverts.mjs's `labelledPairs`.
 *
 * Two shapes, because that is how a PDF and a rendered page write a fact:
 *
 *     Application deadline: October 15, 2026      (one line)
 *     Open Date                                   (the label alone…)
 *     Sep 17, 2026                                (…and the value under it)
 *
 * The second is Interfolio's own layout, and it is read ONLY for a label this
 * module knows: a line that happens to end in a colon is not a field, and a
 * heading followed by a paragraph ("Description" / "The Division of…") must
 * not be read as one either. First statement wins, as in the markup reader.
 */
export function labelledLines(lines) {
  const fields = new Map();
  const put = (label, value) => {
    const k = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/:$/, '');
    const v = text(value, 300);
    if (k && v && !fields.has(k)) fields.set(k, v);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z][A-Za-z /&'()-]{1,40}?)\s*:\s+(.{1,300})$/);
    if (m && LABEL_SET.has(m[1].trim().toLowerCase())) { put(m[1], m[2]); continue; }
    const bare = line.replace(/:$/, '').trim().toLowerCase();
    if (LABEL_SET.has(bare) && i + 1 < lines.length) {
      const next = lines[i + 1];
      /* the value is a short line that is not itself a label */
      if (next.length <= 200 && !LABEL_SET.has(next.replace(/:$/, '').trim().toLowerCase())) {
        put(bare, next);
      }
    }
  }
  return fields;
}

/* ------------------------------------------------------------- hierarchy */

/**
 * The "University: College: Division" line an Interfolio page puts under its
 * title — `{ institution, school, unit }`, or null.
 *
 * Only a line that is NOTHING BUT such a chain is read: two or three parts
 * separated by ": ", each a name (letters, a few punctuation marks, no
 * sentence), none longer than a name can be. A sentence with two colons in
 * it does not qualify, and a chain of two parts is read as the university
 * and its school, since that is how Interfolio writes a search run by the
 * school itself.
 */
export function hierarchyOf(lines) {
  for (const line of lines.slice(0, 20)) {
    if (!line.includes(': ')) continue;
    const parts = line.split(/:\s+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 4) continue;
    if (!parts.every((p) => p.length >= 3 && p.length <= 90
        && /^[A-Za-z][A-Za-z0-9 .,'&()\/-]*$/.test(p) && !/[.!?]$/.test(p))) continue;
    if (/\b(?:is|are|will|the following|please|apply)\b/i.test(parts[0])) continue;
    /* A "Label: value" line is NOT a hierarchy, and a PDF is full of them:
       "Application deadline: October 15, 2026" read as a university called
       "Application deadline" with a school called "October 15, 2026" (found
       by the 2026-09-23 review, on the crawler's own fixture). So every part
       must read as a NAME (never a label the reader knows, never a date, never
       mostly digits), and the first must name an institution. */
    if (!parts.every(looksLikeName)) continue;
    if (!INSTITUTION_WORD_RX.test(parts[0])) continue;
    const [institution, a, b] = parts;
    return parts.length === 2
      ? { institution, school: a, unit: '' }
      : { institution, school: a, unit: b };
  }
  return null;
}

/** A word that names a university, a school or an institute, in the
    languages the page's postings come in. The head of a hierarchy line must
    carry one; a label never does. */
const INSTITUTION_WORD_RX = /\b(?:universit(?:y|ies|[eä]t|[àé]|at|ad|eit)|college|school|institute|institut|polytechnic|academy|faculty|hochschule|escuela|école|ecole)\b/i;

/** Does one part of a hierarchy line read as a NAME rather than as a label
    or a value? A label the text reader knows, a date, and a run that is
    mostly digits are all refused. */
function looksLikeName(p) {
  const bare = String(p || '').trim().replace(/:$/, '').toLowerCase();
  if (!bare || LABEL_SET.has(bare)) return false;
  if (advertDate(p)) return false;
  const letters = (p.match(/[A-Za-z]/g) || []).length;
  const digits = (p.match(/\d/g) || []).length;
  return letters >= 3 && digits * 2 <= letters;
}

/* ----------------------------------------------------------------- place */

/* A school's name as an advertisement writes it in prose — "Michael F. Price
   College of Business", "Scheller College of Business", "Freeman College of
   Management", "the Smith School of Business" — and a department's. The
   captures stop at the first punctuation or connective, so "the Scheller
   College of Business at Georgia Tech invites" gives the college alone. */
/* A name is a run of capitalised words, joined by a connective or a plain
   space, that never reaches into the next sentence: the run stops at
   punctuation, at a line break (a PDF's own line ends are kept for exactly
   this), at a lower-case word, and at a word that names the UNIVERSITY
   rather than the school ("Scheller College of Business Georgia Institute
   of Technology" is a letterhead's two lines, not one name). */
const NAME_WORD = "(?!(?:University|Universit[eä]t|Institute|Universidad)\\b)[A-Z][A-Za-z&'-]*";
const NAME_RUN = `(?:${NAME_WORD}(?: +(?:and|&|of|for) +| +)?){1,5}`;
const STOP = '(?=[,.;:)]|\\n|$|\\s+(?:at|in|is|are|invites|seeks|has|and|within|the)\\b)';
/* The words in FRONT of "School of …" are the school's own name ("Michael
   F. Price", "Scheller") and nothing else: never a possessive ("Georgia
   Tech's"), never the capitalised word that happened to open the sentence
   ("Join", "The", "Position Summary"), never a rank ("Assistant Professor
   Smith School of Business"). An initial with its dot is one of them. Found
   by the 2026-09-23 review, on prose the page really writes. */
const PREFIX_STOP = "(?!(?:The|A|An|Join|Position|Summary|Description|Overview|About|Apply|Welcome|Visit|Contact|Title|Job|Posting|Our|At|In|For|With|Within|From|To|By|Assistant|Associate|Full|Visiting|Adjunct|Clinical|Professor|Professors|Lecturer|Lecturers|Faculty|Department|Division|Dean|Chair)\\b)";
const PREFIX_WORD = `${PREFIX_STOP}(?!(?:University|Universit[eä]t|Institute|Universidad)\\b)[A-Z](?:[A-Za-z&-]*|\\.)`;

const SCHOOL_RX = new RegExp(
  `\\b((?:${PREFIX_WORD} +){0,4}(?:School|College|Faculty) +of +${NAME_RUN})${STOP}`);
const UNIT_RX = new RegExp(
  `\\b(?:Department|Division|Area|Group) +of +(${NAME_RUN})${STOP}`);

/** The school and the department the prose names, dropped when they merely
    repeat the organisation. First mention of each, read over the text WITH
    its line breaks. */
export function placeFromText(s, institution = '') {
  const head = String(s || '').slice(0, 6000);
  const own = COUNTRIES.fold(String(institution || ''));
  const clean = (v) => {
    const t = text(v, 200).replace(/\s+(?:and|&|of|for)$/, '');
    return t && (!own || COUNTRIES.fold(t) !== own) ? t : '';
  };
  const sm = head.match(SCHOOL_RX);
  const um = head.match(UNIT_RX);
  return { school: sm ? clean(sm[1]) : '', department: um ? clean(um[1]) : '' };
}

/* --------------------------------------------------------------- country */

/**
 * The country a stated location is in, or '' — through the site's one
 * `canon()`, and NEVER a guess: a value canon hands straight back is not a
 * country the site lists, and "Atlanta, Georgia" is the US state, which
 * canon reads as the country of that name (its own recorded trap) — so the
 * one country that is also a US state's name is refused here unless the
 * location names no US town beside it.
 */
export function countryFromLocation(location) {
  const s = text(location, 160);
  if (!s) return '';
  const c = COUNTRIES.canon(s);
  if (!c || !COUNTRIES.LIST.includes(c)) return '';
  if (c === 'Georgia' && /,/.test(s)) return '';
  return c;
}

/* ------------------------------------------------------------------ parse */

function emptyParse() {
  return {
    ok: false, gone: false,
    title: '', institution: '', school: '', department: '',
    location: '', posted: '',
    applyByDate: '', applyByProse: '', listedUntil: '', employmentType: '',
    /* beyond adverts.mjs's shape, for the POMS row builder */
    reviewDate: '', country: '', hierarchy: null, description: '',
  };
}

/**
 * What one advertisement's TEXT says — the same contract as `parseAdvert`:
 * everything best-effort and independently optional, `ok` only when a FACT
 * about the job was stated (a first line alone is not one: every PDF has a
 * first line), and a text this cannot read yields `ok: false` so the caller
 * leaves the posting with what the POMS table itself said.
 */
/** A line that is a page's own chrome rather than the advertisement's words —
    what a rendered JavaScript shell puts above the content. Refused as a
    title, never as anything else. */
const CHROME_RX = /sign in|log in|already have an account|cookie|skip to|\bmenu\b|\?$/i;

/** "Department of X" -> "X": the site's department field is the bare field
    name (see canonUnit in oa-schools.js), and a hierarchy line writes the
    wrapper Interfolio's own tree uses. */
function bareUnit(v) {
  return text(v, 200).replace(/^(?:the\s+)?(?:department|division|area|group|section|unit)\s+(?:of|for)\s+/i, '');
}

/** The lines under a "Description" heading, up to the next heading a job
    page writes — the part of the page that describes the JOB, which is what
    the queue's comments excerpt is made of. The whole body when the page has
    no such section. */
export function descriptionOf(lines) {
  const at = lines.findIndex((l) => /^description:?$/i.test(l));
  if (at < 0) return lines;
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (/^(?:qualifications|required qualifications|preferred qualifications|application instructions|application process|how to apply|equal employment opportunity statement|equal opportunity|about (?:the|us)|benefits|salary|contact)\b.{0,40}:?$/i.test(l)) break;
    out.push(l);
  }
  return out.length ? out : lines;
}

export function parseAdvertText(s, { title: hint = '' } = {}) {
  const out = emptyParse();
  const lines = textLines(s);
  if (!lines.length) return out;

  const fields = labelledLines(lines);
  const body = lines.join('\n');
  const flat = body.replace(/\s+/g, ' ').slice(0, 40000);
  const get = (labels) => {
    for (const l of labels) {
      const v = fields.get(l);
      if (v) return v;
    }
    return '';
  };

  out.hierarchy = hierarchyOf(lines);
  const first = lines.find((l) => !CHROME_RX.test(l)) || '';
  out.title = text(get(['position title', 'job title', 'title']) || hint
    || (first.length <= 160 && !/:\s/.test(first) ? first : ''), 300);
  out.institution = text((out.hierarchy && out.hierarchy.institution)
    || get(['institution', 'university', 'employer', 'hiring organization', 'organization']), 200);

  const stated = placeFromText(body, out.institution);
  out.school = text((out.hierarchy && out.hierarchy.school)
    || get(SCHOOL_LABELS) || stated.school, 200);
  out.department = text(bareUnit((out.hierarchy && out.hierarchy.unit)
    || get(DEPARTMENT_LABELS) || stated.department), 200);

  out.location = text(get(['location', 'city', 'campus']), 160);
  out.country = COUNTRIES.LIST.includes(COUNTRIES.canon(get(['country'])))
    ? COUNTRIES.canon(get(['country']))
    : countryFromLocation(out.location);
  out.posted = advertDate(get(['open date', 'date posted', 'posting date', 'posted']));
  out.employmentType = text(get(['position type', 'employment type', 'type']), 60);

  /* The closing date: a labelled field first, then the employer's own
     sentence, then a labelled FINAL date in prose ("Final date: Thursday,
     Nov 5, 2026"), each through the parser that owns that reading. */
  const dl = deadlineFrom(fields, flat);
  out.applyByDate = dl.date || extractFinalDate(flat);
  out.applyByProse = dl.prose;
  out.listedUntil = advertDate(get(LISTING_END_LABELS));
  /* The SUGGESTED apply-by, read out of the prose by the shared extractor;
     a labelled review date is read too, through the same date parser. */
  out.reviewDate = extractReviewDate(flat).date
    || advertDate(get(['priority deadline', 'review date', 'application review date', 'review begins']));

  const desc = descriptionOf(lines).filter((l) => l !== out.title && !CHROME_RX.test(l));
  out.description = text(desc.join(' '), 4000);

  out.ok = !!(out.institution || out.applyByDate || out.applyByProse || out.reviewDate
    || out.posted || out.location || out.school || out.department || out.employmentType
    || out.listedUntil);
  return out;
}
