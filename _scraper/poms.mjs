/* ---------------------------------------------------------------------------
   Operations Academia — the POMS job postings page, as postings to review.

       https://www.poms.org/opportunities  ->  poms-crawl.mjs  ->  jobReviews
                                                  (this is its pure half)

   THE OWNER'S ASK (2026-09-23): "Create a crawler of this website so that any
   new job is auto-added to my jobs under review. For each new job posting,
   the crawler should be able to enter View Posting (which leads to either a
   PDF or Interfolio website or a university website) and process the
   information there to fill up my own job posting form with as much
   information as possible. I will then review it on OA website and add the
   rest."

   WHAT THE PAGE IS. A Drupal Views table — Position, University, Date, View
   — 381 rows on 2026-09-23, dated back to July 2023, never pruned. The View
   link is the advertisement: 347 of the 381 are PDFs the school uploaded to
   poms.org itself, five are apply.interfolio.com pages, and the rest are a
   long tail of applicant-tracking systems (Workday, SmartRecruiters,
   PeopleAdmin, Cornerstone…). So "process the information there" is first of
   all reading a PDF, which pdf-text.mjs does; the Interfolio question the
   owner asked is answered in render-page.mjs and in _SETUP-POMS-CRAWL.md.

   THE SAME GATE AS THE TRACKING SHEET, AND THAT IS THE WHOLE DESIGN. A row
   found here becomes a `jobReviews` document exactly as a workbook row does
   (jobreview.mjs's queueDoc, with dup, biz and ad beside it), so it is read
   on the same review card, announced by the same mailer, counted in the same
   badge and approved with the same button. Two things differ, and each is
   said where it bites:

     - what the page KEEPS is not existence. The workbook is the record of a
       posting's life — a row deleted there takes the posting down — while
       POMS lists a 2023 posting beside this week's and removes nothing. So
       an approved POMS posting publishes FROM ITS QUEUE DOCUMENT (build-
       jobs.mjs reads the approved queue and carries these without the
       workbook's window), and the document, not the page, is what a later
       take-down changes. There is no data/poms.json, on purpose: a pending
       posting must not sit under data/, and an approved one needs no second
       copy of what the document already holds.
     - "new" is judged by the ADVERTISEMENT LINK, never by the row's date
       alone: a link the queue already holds (any status), or the site
       already publishes, or the workbook already carries, is a posting the
       maintainer has already seen or will see from the other crawler. A
       window on the date (WINDOW_DAYS, widened by --since) is what keeps the
       first run from queueing three years of the page, and what keeps a
       posting the page lists late from being asked about twice.

   CURATED, NEVER GUESSED — the rule every ingest here is held to. A name is
   put through the same canon the posting form uses; a university is matched
   to the site's own vocabulary before its acronym is trusted; a deadline is
   believed only against the day POMS listed the posting (believableDeadline,
   the guard both advert passes share); the position type is read by the
   workbook's own `levelsFromRank`; the type by its `typeFromNames`; and a
   posting whose advertisement could not be read still queues, carrying what
   the table itself said and saying so in its comments, because a card the
   maintainer completes beats a posting nobody hears about.
   --------------------------------------------------------------------------- */

import { createRequire } from 'node:module';

import {
  text, url, longDate, jobId, isoStamp, universitiesLink, marketYearOf, OPEN_ENDED_RX,
  healReviewDate, withMarketYears, withCountries, stripRowEmails, canonColumns, POMS_SOURCE,
} from './jobs-model.mjs';
import { levelsFromRank, typeFromNames, sheetDay, daysBetween, BACKDATE_DAYS } from './jobmarket-sheet.mjs';
import { believableDeadline } from './higheredjobs.mjs';
import { decodeEntities } from './adverts.mjs';
import { splitDepartment, joinDepartment, fillSchoolFromDirectory, SCHOOLS } from './vocab.mjs';
import { dupEntry } from './jobreview.mjs';

const require = createRequire(import.meta.url);
const COUNTRIES = require('../assets/oa-countries.js');

/** The source stamped on every row — jobs-model's own name for it, so
    `postedBy` calls these the crawler's and the build knows whose they are. */
export const SOURCE = POMS_SOURCE;

export const PAGE_URL = 'https://www.poms.org/opportunities';
export const ORIGIN = 'https://www.poms.org';

/** How far back the page is read on a run. The page is never pruned, so
    without a window the first run would queue three years of postings, most
    of them long closed and most of the rest already on the site through the
    tracking sheet. Thirty days, widened by `--since` when the maintainer
    wants a backfill. */
export const WINDOW_DAYS = 30;

/** An advertisement that could not be read is tried again after this many
    days, on the pending document that carries it. */
export const READ_TTL_DAYS = 7;

/* ------------------------------------------------------------------- urls */

export function isPomsUrl(u) {
  const s = url(u);
  if (!s) return false;
  try {
    return /(^|\.)poms\.org$/i.test(new URL(s).hostname);
  } catch {
    return false;
  }
}

/** The page's own date column: MM/DD/YYYY, which is how a US Drupal site
    prints a date field. Read by the workbook's own reader, which takes that
    order first; '' when it is not a date. */
export function pomsDay(v) {
  return sheetDay(text(decodeEntities(v), 40));
}

/** A View link as an absolute, validated URL — the page writes its own
    files as site-relative paths and every external link double-encoded. */
export function absoluteUrl(href) {
  const raw = text(decodeEntities(String(href || '')), 600);
  if (!raw) return '';
  if (raw.startsWith('/')) return url(ORIGIN + raw);
  return url(raw);
}

/** What the link points at, by its path: 'pdf', 'doc' (a Word file, which
    nothing here reads), 'page', or '' for no link. */
export function linkKind(u) {
  const s = url(u);
  if (!s) return '';
  let p = '';
  try { p = decodeURIComponent(new URL(s).pathname).toLowerCase(); } catch { p = s.toLowerCase(); }
  if (/\.pdf$/.test(p)) return 'pdf';
  if (/\.docx?$/.test(p)) return 'doc';
  return 'page';
}

/** The link, normalised the way oa-advert-dup.js compares advertisements:
    lower-cased, scheme and `www.` folded away, a trailing slash trimmed.
    The key everything here uses to ask "is this advertisement known?". */
export function linkKey(u) {
  return String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ table */

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ');
}

function cellText(html) {
  return text(decodeEntities(stripTags(decodeEntities(html))).replace(/\s+/g, ' '), 300);
}

/**
 * The postings the page lists, in the page's own order (newest first):
 * `[{ title, institution, date, dateText, href, kind }]`.
 *
 * Read by the header ids the table's cells name — `views-field-field-pos`,
 * `views-field-field-position-university`, `views-field-field-position-date`,
 * `views-field-views-conditional-field` — never by column position, so a
 * column added to the view moves nothing. A row with no title and no
 * university is not a posting (the table's own empty tail).
 */
export function parseOpportunities(html) {
  const src = String(html || '');
  const out = [];
  const cell = (row, cls) => {
    const m = new RegExp('<td[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)</td>', 'i').exec(row);
    return m ? m[1] : '';
  };
  for (const m of src.matchAll(/<tr\b[^>]*class="[^"]*table__row[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = m[1];
    if (/<th\b/i.test(row)) continue;
    const title = cellText(cell(row, 'views-field-field-pos'));
    const institution = cellText(cell(row, 'views-field-field-position-university'));
    const dateText = cellText(cell(row, 'views-field-field-position-date'));
    const view = cell(row, 'views-field-views-conditional-field');
    const hm = /<a\b[^>]*href="([^"]*)"/i.exec(view);
    const href = hm ? absoluteUrl(hm[1]) : '';
    if (!title && !institution) continue;
    out.push({ title, institution, date: pomsDay(dateText), dateText, href, kind: linkKind(href) });
  }
  return out;
}

/* ------------------------------------------------------------ what is new */

/** A posting from a university, college or school, or for an academic
    post. The page also carries a defence contractor's programme-manager
    vacancies (September 2026), which are not this site's, and queueing
    them is noise the maintainer would only reject. Both halves are word
    tests, so a "Choctaw Global" advertising a "Quality Control Manager"
    fails both while "VinUniversity" advertising a "Faculty of Business"
    passes on either. */
export function looksAcademic(opp) {
  const inst = String((opp && opp.institution) || '');
  const title = String((opp && opp.title) || '');
  return /universit|college|institute|polytechnic|\bschool\b|\bacademy\b|faculty|hochschule|[ée]cole|\bIIT\b|\bIIM\b/i.test(inst)
    || /professor|lecturer|faculty|post.?doc|postdoctoral|instructor|\bfellow|\bchair\b|researcher|research (?:scientist|associate)|\bphd\b|academic|tenure/i.test(title);
}

/** `days` days before `now`, as an ISO day — the default window's edge. */
export function sinceDay(now = new Date(), days = WINDOW_DAYS) {
  return new Date(now.getTime() - Math.max(0, days) * 86400e3).toISOString().slice(0, 10);
}

/**
 * Every advertisement link the site already knows: the queue's rows (any
 * status, the maintainer's re-linking edit included), the served postings
 * and the workbook's own rows. A POMS row pointing at one of these is not
 * new, whatever its date says.
 */
export function knownLinks({ docs = [], rows = [] } = {}) {
  const out = new Set();
  const add = (u) => { const k = linkKey(u); if (k && !/^operationsacademia\.org$/.test(k)) out.add(k); };
  for (const d of docs) {
    if (!d) continue;
    add(d.row && d.row.adUrl);
    add(d.edits && d.edits.adUrl);
  }
  for (const r of rows) if (r) add(r.adUrl);
  return out;
}

/**
 * Which of the page's rows to queue: `{ fresh, skipped }`, where each skip
 * names its reason so the run's log can count them —
 *
 *   no-date          the date cell could not be read (half the row's identity)
 *   before-window    older than `since`
 *   closed-season    a market year the site no longer carries (`minYear`)
 *   not-academic     see looksAcademic
 *   no-link          no View link at all: nothing to read and nothing to compare
 *   already-known    its advertisement is in the queue, on the site or in the workbook
 *   repeated-on-page the page lists the same file twice
 */
export function newOpportunities(opps, { since = '', minYear = 0, known = new Set(), now = new Date() } = {}) {
  const fresh = [];
  const skipped = [];
  const seen = new Set();
  for (const opp of opps || []) {
    const why = (w) => skipped.push({ opp, why: w });
    if (!opp.date) { why('no-date'); continue; }
    if (since && opp.date < since) { why('before-window'); continue; }
    if (minYear && marketYearOf({ posted: opp.date }, { now }).year < minYear) { why('closed-season'); continue; }
    if (!looksAcademic(opp)) { why('not-academic'); continue; }
    if (!opp.href) { why('no-link'); continue; }
    const k = linkKey(opp.href);
    if (known.has(k)) { why('already-known'); continue; }
    if (seen.has(k)) { why('repeated-on-page'); continue; }
    seen.add(k);
    fresh.push(opp);
  }
  return { fresh, skipped };
}

/* ----------------------------------------------------------------- names */

/**
 * A university's name without the acronym the page appends — "University of
 * Oklahoma (OU)", "California State University, Stanislaus (CSU, Stanislaus)",
 * "Pennsylvania State University (University Park, PA)". Only a trailing
 * parenthesis that reads as an acronym or a campus note is dropped, and only
 * from a name that keeps two words without it; "Baruch College, The City
 * University of New York (CUNY)" is published whole by the site's own canon
 * and reaches it through the vocabulary lookup below before this is tried.
 */
export function stripAcronym(name) {
  const s = text(name, 200);
  const m = s.match(/^(.*\S)\s*\(([^()]{1,60})\)$/);
  if (!m) return s;
  const inner = m[2].trim();
  const words = inner.split(/\s+/);
  const acronymish = /^[A-Z][A-Z&.-]+$/.test(words[0]) || inner.includes(',') || /\b(?:campus|park)\b/i.test(inner);
  if (words.length <= 5 && acronymish && m[1].trim().split(/\s+/).length >= 2) return m[1].trim();
  return s;
}

/** The name the site's vocabulary files this university under, or ''. The
    lookup is by `institutionKey` — the grouping the vocabulary itself uses,
    which already folds a leading "The" and a trailing acronym away. */
export function vocabName(name, vocab) {
  const by = vocab && vocab.byUniversity;
  if (!by || !name) return '';
  const want = SCHOOLS.institutionKey(name);
  if (!want) return '';
  for (const u of Object.keys(by)) if (SCHOOLS.institutionKey(u) === want) return u;
  return '';
}

/** The university as the site publishes it: the vocabulary's own spelling
    where it has one (with or without the page's acronym), else the bare
    name through the posting form's canon. */
export function institutionName(raw, vocab = null) {
  const whole = text(decodeEntities(raw), 160);
  if (!whole) return '';
  const bare = stripAcronym(whole);
  return vocabName(whole, vocab) || vocabName(bare, vocab)
    || canonColumns({ institution: bare || whole, school: '', unit: '' }).institution
    || whole;
}

const RANK_WORDS = /professor|lecturer|faculty|\brank\b|track|position|tenure|chair|dean|instructor|fellow|post.?doc|clinical|practice/i;

function titleCase(s) {
  const small = new Set(['and', 'of', 'in', 'for', 'the', '&']);
  return s.split(/\s+/).map((w, i) => {
    const l = w.toLowerCase();
    return (i && small.has(l)) ? l : l.charAt(0).toUpperCase() + l.slice(1);
  }).join(' ');
}

/**
 * The field a title names — "Assistant Professor OF Supply Chain Management",
 * "Tenure-Track Faculty Position IN Operations Management", "Open Rank,
 * Professional Track Faculty, BUSINESS ANALYTICS" — as `{ school, unit }`,
 * both empty when the title names none.
 *
 * The site's department field is a bare field name and the workbook's own
 * hiring-unit column is routinely a field ("OM"), so this is the same reading
 * the maintainer already gets from the sheet, offered for correction on the
 * card. A one-word field is taken only when the vocabulary lists it (so
 * "Business" alone, from "Professor – Business (Operations)", is refused),
 * and a title that names a school ("Faculty of Business & Management") is
 * read as one through `splitDepartment`.
 */
export function fieldFromTitle(title, vocab = null) {
  let t = text(decodeEntities(title), 200).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { school: '', unit: '' };
  // A title that IS a school's name ("Faculty of Business & Management", a
  // whole faculty advertising at once) names the school, not a field; the
  // rank test below cannot be used here because "faculty" is in it.
  if (/^(?:the\s+)?(?:school|college|faculty)\s+of\s+\S/i.test(t)
      && !/professor|lecturer|position|tenure|chair|dean|instructor|fellow|post.?doc|\brank\b/i.test(t)) {
    return splitDepartment(t);
  }
  let field = '';
  let m = t.match(/\b(?:professors?|professorship|lecturers?|faculty|positions?|chairs?|fellows?|instructors?)\s+(?:of|in)\s+(.+)$/i);
  if (!m) m = t.match(/\b(?:in|of)\s+([A-Z].+)$/);
  if (m) field = m[1];
  if (!field && t.includes(',')) {
    const last = t.split(',').pop().trim();
    if (!RANK_WORDS.test(last)) field = last;
  }
  field = text(field, 120).replace(/^(?:the\s+)?(?:department|division|area|group)\s+of\s+/i, '').replace(/[.\s]+$/, '');
  if (!field || RANK_WORDS.test(field)) return { school: '', unit: '' };
  if (field === field.toUpperCase() && /[A-Z]/.test(field)) field = titleCase(field);
  if (/\b(?:school|college|faculty)\b/i.test(field)) return splitDepartment(field);
  const units = ((vocab && vocab.units) || []).map((u) => (u && u.v) || u).filter(Boolean);
  const known = units.some((u) => SCHOOLS.fold(String(u)) === SCHOOLS.fold(field));
  if (field.split(/\s+/).length < 2 && !known) return { school: '', unit: '' };
  return { school: '', unit: field };
}

/* -------------------------------------------------------------- comments */

/** The first sentences of a description, up to about `max` characters and
    never cut mid-sentence except when the first sentence alone is longer. */
export function excerptOf(description, max = 600) {
  const s = text(description, 4000);
  if (!s) return '';
  const sentences = s.split(/(?<=[.!?])\s+/);
  let out = '';
  for (const sen of sentences) {
    if (out && (out + ' ' + sen).length > max) break;
    out = out ? out + ' ' + sen : sen;
  }
  return out.length > max + 80 ? out.slice(0, max).replace(/\s+\S*$/, '') + '…' : out;
}

/**
 * The comments a queued POMS posting carries — the posting's DESCRIPTION,
 * which is what the field is for (owner, 2026-08-26, of the workbook's
 * rows): the advertised title, which the site has no other field for; the
 * deadline as the advertisement worded it where no date could be believed
 * (the workbook's own "Deadline as listed" line); an excerpt of the
 * description; and one sentence saying where the words came from, so the
 * maintainer knows what to check. A posting whose advertisement could not
 * be read says so instead, which is the honest form of an empty box.
 */
export function commentsFor(opp, ad = null, { now = new Date() } = {}) {
  const parts = [];
  const title = text(decodeEntities(opp && opp.title), 200);
  if (title) parts.push(`Advertised as: ${title.replace(/[.\s]+$/, '')}.`);
  if (ad && ad.ok) {
    if (!ad.applyByDate && ad.applyByProse && /[A-Za-z0-9]/.test(ad.applyByProse)) {
      parts.push(`Deadline as listed: ${text(ad.applyByProse, 200)}`);
    }
    const excerpt = excerptOf(ad.description, 600);
    if (excerpt) parts.push(excerpt);
    parts.push(`(Read by the POMS crawler from the ${ad.via === 'pdf' ? 'PDF' : 'advertisement'} ` +
      `on ${isoStamp(now).slice(0, 10)}; open the advert for the full text.)`);
  } else {
    parts.push('The advertisement could not be read automatically; open it and complete the posting.');
  }
  return text(parts.join(' · '), 1200);
}

/* ------------------------------------------------------------------- row */

/** When the row entered the dataset — `stampAddedAt`'s own rule, for one
    row: a posting the page lists more than BACKDATE_DAYS after its date is a
    catch-up, not news, and is dated from the day it was advertised. */
export function addedStamp(posted, now = new Date()) {
  const cutoff = new Date(now.getTime() - BACKDATE_DAYS * 86400e3).toISOString().slice(0, 10);
  return posted && posted < cutoff ? `${posted}T00:00:00Z` : isoStamp(now);
}

/**
 * One posting from the page -> the site's row shape, the same shape
 * `rowsFromTab` builds for the workbook so build-jobs merges it beside every
 * other posting with no special case.
 *
 * `ad` is what the advertisement said (advert-text.mjs or adverts.mjs's
 * parse, with `place` — advertPlace's classification against the site's
 * vocabulary — and `via` beside it), or null when it could not be read. The
 * page's own row wins on identity (the university, the date, the link); the
 * advertisement fills what the page never said (the school, the department,
 * the closing date, the country); and the title fills the department only
 * where the advertisement named none.
 */
export function rowFromOpportunity(opp, { ad = null, vocab = null, now = new Date() } = {}) {
  const posted = String((opp && opp.date) || '');
  let institution = institutionName(opp && opp.institution, vocab);

  let school = '';
  let unit = '';
  const place = ad && ad.place;
  if (place) {
    /* the advertisement's own university only where the page's name found
       nothing in the vocabulary and the advertisement's did — "University
       of Oklahoma Norman Campus" must not displace "University of Oklahoma" */
    if (place.institution && !vocabName(institution, vocab) && vocabName(place.institution, vocab)) {
      institution = vocabName(place.institution, vocab);
    }
    school = place.school || '';
    unit = place.unit || '';
  }
  if (!school && ad && ad.school) school = ad.school;
  if (!unit && ad && ad.department) unit = ad.department;
  if (!unit) {
    const fromTitle = fieldFromTitle(opp && opp.title, vocab);
    if (!school) school = fromTitle.school;
    unit = fromTitle.unit;
  }
  const p = canonColumns({ institution, school, unit });
  const inst = p.institution || institution;

  /* a closing date is believed only against the day the page listed the
     posting — the guard both advertisement passes share; a suggested date
     must fall before it (healReviewDate's rule) */
  const deadline = ad && ad.applyByDate && believableDeadline(posted, ad.applyByDate) ? ad.applyByDate : '';
  const openEnded = !deadline && !!(ad && OPEN_ENDED_RX.test(String(ad.applyByProse || '')));
  const review = ad && ad.reviewDate && believableDeadline(posted, ad.reviewDate)
    && (!deadline || ad.reviewDate < deadline) ? ad.reviewDate : '';
  const year = marketYearOf({ applyByDate: deadline, reviewDate: review, posted }, { now }).year;

  const row = {
    id: '',
    year,
    posted,
    institution: inst,
    department: joinDepartment(p.school, p.unit),
    school: p.school,
    unit: p.unit,
    type: '',   // judged below, once the directory has had its say about the school
    levels: levelsFromRank(opp && opp.title),
    applyBy: openEnded ? text(ad.applyByProse, 400) : (deadline ? longDate(deadline) : 'Until filled.'),
    applyByDate: deadline,
    reviewDate: review,
    comments: commentsFor(opp, ad, { now }),
    country: (ad && ad.country) || '',
    adUrl: url(opp && opp.href),
    adLabel: (opp && opp.kind) === 'pdf' ? 'job ad (PDF)' : 'link to Job ad',
    postedAtUrl: PAGE_URL,
    postedAtLabel: 'POMS job postings',
    furtherInfoUrl: universitiesLink(inst),
    characteristics: [],
    featured: false,
    source: SOURCE,
    addedAt: addedStamp(posted, now),
    owner: '',
  };
  row.id = jobId(row);
  /* the school the directory says the department sits in — and only THEN
     the type, judged over the whole posting's names: a Georgia Tech posting
     in Operations Management is Scheller's, and Scheller says business */
  const filled = vocab ? fillSchoolFromDirectory(row, vocab) : row;
  const typed = {
    ...filled,
    type: typeFromNames(inst, filled.school, filled.unit, opp && opp.title,
      ad && ad.school, ad && ad.department),
  };
  return withCountries(withMarketYears(stripRowEmails(healReviewDate(typed))));
}

/** A row id nobody holds: the base, else `-2`, `-3`… — the suffix rule
    `uniqueIds` and `collectRows` apply, against the ids the queue and the
    served files already carry. */
export function uniqueId(base, taken) {
  const has = (id) => (taken instanceof Set ? taken.has(id) : (taken || []).includes(id));
  let id = base;
  let n = 2;
  while (has(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * The postings on the site (or in the queue) that a POMS row probably
 * REPEATS without sharing a link or a department line: the same university,
 * advertised within `days` of each other, with a position type in common.
 * The tracking sheet and this page draw on the same advertisements, so a
 * posting routinely arrives from both a few days apart under different
 * wording, and `duplicatesOf` (which asks for the same link or the same
 * department) cannot see it. A FLAG for the card, like `duplicatesOf`,
 * never a decision; an entry marked `pending` names a posting still under
 * review rather than one the site is showing.
 */
export function nearbyPostings(row, siteRows, { days = 21, max = 3 } = {}) {
  if (!row || !row.institution || !row.posted) return [];
  const key = SCHOOLS.institutionKey(row.institution);
  const levels = Array.isArray(row.levels) ? row.levels : [];
  const out = [];
  for (const s of siteRows || []) {
    if (!s || !s.institution || !s.posted || String(s.id || '') === String(row.id || '')) continue;
    if (SCHOOLS.institutionKey(s.institution) !== key) continue;
    const gap = daysBetween(s.posted, row.posted);
    if (gap == null || Math.abs(gap) > days) continue;
    const sl = Array.isArray(s.levels) ? s.levels : [];
    if (levels.length && sl.length && !levels.some((l) => sl.includes(l))) continue;
    out.push(s._pending ? { ...dupEntry(s), pending: true } : dupEntry(s));
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A pending row whose advertisement has since been read: the fields the
 * first run had to leave EMPTY, filled from the new reading — fill-empty,
 * by value, idempotent, so a document whose advertisement stays unreadable
 * is never rewritten and one the maintainer has edited keeps its edits (an
 * edit sits on top of the row, whatever the row says). The date fields move
 * together, as everywhere. Returns the row itself when nothing changes.
 */
export function refreshFromAd(row, ad, { vocab = null, now = new Date() } = {}) {
  if (!row || !ad || !ad.ok) return row;
  const title = (String(row.comments || '').match(/^Advertised as: (.+?)\.(?: · |$)/) || [])[1] || '';
  const fresh = rowFromOpportunity({
    title, institution: row.institution, date: row.posted, href: row.adUrl,
    kind: linkKind(row.adUrl),
  }, { ad, vocab, now });
  const out = { ...row };
  for (const k of ['school', 'unit', 'country', 'countries', 'type']) {
    const empty = Array.isArray(out[k]) ? !out[k].length : !out[k];
    if (empty && fresh[k] && (!Array.isArray(fresh[k]) || fresh[k].length)) out[k] = fresh[k];
  }
  // "Until filled." on a row whose advertisement was never read is the
  // crawler's own default, not something the advertisement said, so a later
  // reading may replace it; a line that says the search stays open on a row
  // that WAS read is the advertisement's word and is kept.
  const unread = /could not be read automatically/.test(String(row.comments || ''));
  if (!out.applyByDate && fresh.applyByDate && (unread || !OPEN_ENDED_RX.test(String(out.applyBy || '')))) {
    out.applyByDate = fresh.applyByDate;
    out.applyBy = fresh.applyBy;
  }
  if (!out.reviewDate && fresh.reviewDate && (!out.applyByDate || fresh.reviewDate < out.applyByDate)) {
    out.reviewDate = fresh.reviewDate;
  }
  if (/could not be read automatically/.test(String(out.comments || ''))) out.comments = fresh.comments;
  out.department = joinDepartment(out.school, out.unit);
  const next = withCountries(withMarketYears(stripRowEmails(healReviewDate(out))));
  return JSON.stringify(next) === JSON.stringify(row) ? row : next;
}
