/* ---------------------------------------------------------------------------
   Operations Academia — reading ANY job advertisement the crawler points at.

   The tracking sheet's postings link to some hundred and twenty different
   hosts. higheredjobs.mjs reads the biggest of them (156 of 449 rows) and is
   deliberately host-specific — its layout, its one trap, its JobCode
   identity. This module is the OTHER HALF: the Interfolio / Chronicle /
   Inside Higher Ed / INFORMS boards and the long tail of university
   applicant-tracking systems (Workday, PeopleAdmin, Cornerstone, Taleo,
   Oracle…), read with one high-precision generic parser plus the one adapter
   a host actually needs (Workday, whose pages are a JS shell over a public
   JSON API).

   This is the PURE half: given the HTML (or Workday JSON) of one
   advertisement it says what that advertisement claims — the position's
   title, who is hiring, where, when it was posted, and above all the
   CLOSING DATE — and given a set of postings and a cache of what was read it
   says how the postings change. It fetches nothing. The fetching half is
   adverts-verify.mjs, which runs on the GitHub Actions runners — this build
   environment's egress policy denies every one of these hosts (403 at the
   proxy), the same situation as higheredjobs.com and docs.google.com.

   THE HIGHEREDJOBS LESSON, GENERALISED. A page's schema.org JobPosting block
   carries `validThrough`, which looks exactly like a deadline and on a job
   BOARD is not one: it is when the board stops listing the advertisement,
   which HigherEdJobs sets ~18 months out and the Madgex boards (Chronicle,
   Inside Higher Ed) set to the paid listing's end. So `validThrough` — and
   every labelled field that names the LISTING's end rather than the
   application's ("End date", "Expires") — is NEVER read as a deadline
   anywhere in this module. It is recorded separately, as `listedUntil`, and
   shown to the maintainer labelled as what it is. A deadline comes only from
   a field the employer labelled as one (DEADLINE_LABELS below), exactly the
   discipline higheredjobs.mjs already applies to its own host. selftest.mjs
   pins this.

   AND A SECOND ONE, FROM THE SHEET INGEST. An all-numeric date whose day and
   month are both ≤ 12 is ambiguous, and these pages are written on both
   sides of the Atlantic — Warwick and Bath write day-first, Utah month-first.
   `deadlineDay` in jobmarket-sheet.mjs repairs an ambiguous cell against the
   posting date because a spreadsheet cell has to be read somehow; a scraped
   page does not. `advertDate` REFUSES the ambiguous form (returns ''), and
   the page's own words are still carried as prose — "no date" beats a date
   that is wrong half the time.
   --------------------------------------------------------------------------- */

import {
  text, url, longDate, OPEN_ENDED_RX, healReviewDate, canonColumns, withMarketYears,
  stripEmails } from './jobs-model.mjs';
/* believableDeadline is ONE definition, shared with the pass it was written
   for: the same guard on both roads, or the two disagree about what an
   advertisement could have meant. */
import { isHigherEdJobsUrl, believableDeadline } from './higheredjobs.mjs';
import { universityForSchool, schoolForUnit, SCHOOLS } from './vocab.mjs';

/* fold(), for "is this stated name the organisation repeated?" — the same
   grouping-not-publishing use jobreview.mjs makes of it. */
const foldName = (v) => SCHOOLS.fold(String(v || ''));

/** How an advertisement's own deadline is labelled, in order of authority.
    Every one of these names the APPLICATION's end, never the listing's —
    'End date' and 'Expires' are deliberately absent (see the header; they
    feed `listedUntil` instead). Lower-cased, matched exactly against the
    label a page states. When an employer labels the closing date some new
    way, add it HERE — never hand-edit data/, which is rebuilt every morning. */
export const DEADLINE_LABELS = [
  'application due',
  'application deadline',
  'application closing date',
  'application close date',
  'applications close',
  'application period ends',
  'closing date',
  'close date',
  'closes',
  'closing',
  'deadline',
  'apply by',
  'apply before',
  'submission deadline',
];

/** Labels that state when the LISTING comes down — information, but not the
    deadline (the validThrough lesson). Recorded as `listedUntil`. */
export const LISTING_END_LABELS = ['end date', 'expires', 'expiry date', 'expiration date'];

/** Hosts this pass never fetches, each for its own reason. higheredjobs.com
    has its own pipeline (one URL, one owner — two caches for one ad would
    disagree silently); the Google-Docs forms are sign-in walls that answer
    with a login page; LinkedIn answers automation with a login wall; our own
    home page is what a sheet row carries when it names no ad at all. */
const SKIP_HOST_RX = [
  /(^|\.)docs\.google\.com$/,
  /(^|\.)drive\.google\.com$/,
  /(^|\.)linkedin\.com$/,
  /(^|\.)operationsacademia\.org$/,
];

/** Query parameters that are tracking decoration, not identity — two links
    to one advertisement can differ in them, and one request per ad is the
    point of keying on the URL. */
const TRACKING_PARAM_RX = /^(utm_[a-z]+|linksource|mc_cid|mc_eid|fbclid|gclid)$/i;

/** A listing that has come down. Kept generic and high-precision: every
    phrase here is one an applicant-facing notice actually uses, and a page
    matching none of them is parsed normally. */
const GONE_RX =
  /(no longer (?:available|active|accepting|being accepted|posted)|has (?:expired|been (?:removed|filled|closed|cancell?ed))|this (?:job|position|posting|vacancy|requisition) (?:is (?:closed|no longer)|has been)|position (?:has been )?filled|job (?:posting )?not found)/i;

/**
 * "...and will continue until the position has been filled" is the OPEN-ENDED
 * search phrase, and it is on a LIVE advertisement — it is the very sentence
 * the two-deadlines rule reads a first-review date out of. GONE_RX matched it
 * twice over ("has been filled", "position has been filled"), so any ad
 * carrying it and no JobPosting block parsed as `gone` — and `gone` FREEZES an
 * advertisement in `needFetch`, which means the closing date is never read
 * again and the posting stays "Until filled." for ever.
 *
 * Struck out of the text before the closure test rather than narrowed into
 * GONE_RX itself, so the phrases stay readable one per line and a page that
 * really says "The position has been filled." still answers gone. Its sibling
 * in higheredjobs.mjs never had the hole: every branch there demands the word
 * "this" in front.
 */
const OPEN_ENDED_CLAUSE_RX =
  /\b(?:until|till)\s+(?:such\s+time\s+as\s+)?(?:the\s+)?(?:position|positions|posting|vacancy|vacancies|role|roles|job|opening|openings)\s+(?:is|are|has\s+been|have\s+been)\s+filled/gi;

/* -------------------------------------------------------------------- urls */

/** Is this an advertisement THIS pass reads? Host-validated, http(s) only,
    and never one of the hosts above. */
export function isAdvertUrl(u) {
  const s = url(u);
  if (!s) return false;
  if (isHigherEdJobsUrl(s)) return false;
  try {
    const host = new URL(s).hostname.toLowerCase();
    return !SKIP_HOST_RX.some((rx) => rx.test(host));
  } catch {
    return false;
  }
}

/**
 * The advertisement's identity — the key everything here is cached under.
 *
 * The URL, normalised: scheme and `www.` folded away, the fragment dropped,
 * tracking parameters removed and the rest sorted, a trailing slash trimmed.
 * Two sheet rows linking one ad through different tracking tails therefore
 * cost one request, exactly as `jobCodeOf` does for HigherEdJobs.
 */
export function advertKeyOf(u) {
  const s = url(u);
  if (!s || !isAdvertUrl(s)) return '';
  try {
    const p = new URL(s);
    const params = [...p.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM_RX.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const query = params.length
      ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&')
      : '';
    const host = p.hostname.toLowerCase().replace(/^www\./, '');
    const path = p.pathname.replace(/\/+$/, '') || '/';
    return host + path + query;
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------------- html */

function stripTags(s) {
  return String(s || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

/** Entity decoding to a fixed point, bounded — the same reasoning as
    higheredjobs.mjs: several of these systems embed the employer's markup
    inside a JSON string, so it arrives double-encoded. */
function decodeEntities(s) {
  let out = String(s || '');
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&');
    if (next === out) break;
    out = next;
  }
  return out;
}

function plain(s) {
  return stripTags(decodeEntities(stripTags(decodeEntities(s))))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every `Label: value` pair the page states, as a Map keyed by lower-cased
 * label — read from the MARKUP, never from flattened text, for the reason
 * higheredjobs.mjs documents at length: the tag says exactly where a label
 * starts and therefore where the previous value ended.
 *
 * Three shapes, because that is how these systems write a fact:
 *   <strong>Closing date:</strong> 15 October 2026     (boards, prose pages)
 *   <th>Close Date</th> … <td>10/15/2026</td>          (PeopleAdmin tables)
 *   <dt>Closing date</dt><dd>15 October 2026</dd>      (Madgex, gov boards)
 *
 * First statement wins, per shape precedence above: a summary block sits
 * above the description, and its fields are the ones the SYSTEM curates.
 */
export function labelledPairs(html) {
  const doc = decodeEntities(String(html || ''));
  const fields = new Map();
  const put = (label, value) => {
    const k = label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/:$/, '');
    const v = text(decodeEntities(stripTags(value)).replace(/\s+/g, ' ').trim(), 300);
    if (k && v && !fields.has(k)) fields.set(k, v);
  };

  const LABEL = '([A-Za-z][A-Za-z /&\'-]{1,40}?)';

  // <strong>Label:</strong> value — the colon inside the tag or just after it
  const STRONG = new RegExp(
    `<(strong|b)\\b[^>]*>\\s*${LABEL}\\s*:?\\s*</\\1>\\s*:?` +
    '([\\s\\S]{0,400}?)(?=<(?:strong|b)\\b|<br|</div|</p|</li|</td|</center|$)', 'gi');
  for (const m of doc.matchAll(STRONG)) put(m[2], m[3]);

  // <th>Label</th> … <td>value</td> — the header cell names its row's value
  const TH = new RegExp(
    `<th\\b[^>]*>\\s*${LABEL}\\s*:?\\s*</th>\\s*(?:<[^>]*>\\s*)*` +
    '<td\\b[^>]*>([\\s\\S]{0,400}?)</td>', 'gi');
  for (const m of doc.matchAll(TH)) put(m[1], m[2]);

  // <dt>Label</dt><dd>value</dd>
  const DT = new RegExp(
    `<dt\\b[^>]*>\\s*${LABEL}\\s*:?\\s*</dt>\\s*<dd\\b[^>]*>([\\s\\S]{0,400}?)</dd>`, 'gi');
  for (const m of doc.matchAll(DT)) put(m[1], m[2]);

  return fields;
}

/** One labelled value, by exact lower-cased name. */
export function pairValue(fields, label) {
  return (fields instanceof Map)
    ? (fields.get(String(label).toLowerCase()) || '')
    : '';
}

/* -------------------------------------------------------------------- dates */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoOf(y, m, d) {
  const yy = +y, mm = +m, dd = +d;
  if (!(yy >= 2000 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return '';
  const t = new Date(Date.UTC(yy, mm - 1, dd));
  if (t.getUTCMonth() !== mm - 1 || t.getUTCDate() !== dd) return '';
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/**
 * A date as an arbitrary advertisement writes it — or '' where believing one
 * would mean guessing.
 *
 * ISO and the two wordy orders are unambiguous and read. An ALL-NUMERIC date
 * is read only when one field is over 12 and settles the order; "05/10/2026"
 * is the fifth of October in Coventry and the tenth of May in Salt Lake City,
 * and unlike the sheet ingest (whose `deadlineDay` has a posting date to test
 * a repair against, and a cell that has to mean something) this parser can
 * afford the honest answer: no date, prose kept. NOT `hejDate`, which reads
 * month-first always because its host is one US site.
 */
export function advertDate(v) {
  const s = text(v, 80);
  if (!s) return '';
  let m;

  // 2026-10-15, with or without a time after it
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\b/))) return isoOf(m[1], m[2], m[3]);

  // October 15, 2026 / Oct 15 2026 / October 15th, 2026
  if ((m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/))) {
    const mo = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1;
    return mo ? isoOf(m[3], mo, m[2]) : '';
  }

  // 15 October 2026 / 15th Oct 2026
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})\b/))) {
    const mo = MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)) + 1;
    return mo ? isoOf(m[3], mo, m[1]) : '';
  }

  // all-numeric: only when one field settles the order
  if ((m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b/))) {
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) return isoOf(m[3], b, a);      // day-first, provably
    if (b > 12 && a <= 12) return isoOf(m[3], a, b);      // month-first, provably
    return '';                                            // ambiguous — refused
  }

  return '';
}

/* ------------------------------------------------------------------ JSON-LD */

/**
 * The page's schema.org JobPosting, if it carries one. Tolerant of the shapes
 * in the wild: a bare object, an array of things, and a `@graph` wrapper —
 * and of the broken-JSON case higheredjobs.mjs met, where the description is
 * embedded unescaped, by falling back to reading the few wanted fields
 * individually.
 */
export function jsonLdPosting(html) {
  for (const m of String(html || '').matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    if (!/"@type"\s*:\s*"JobPosting"/i.test(body)) continue;
    try {
      const parsed = JSON.parse(body);
      const found = findPosting(parsed);
      if (found) return found;
    } catch {
      return {
        title: strField(body, 'title'),
        datePosted: strField(body, 'datePosted'),
        validThrough: strField(body, 'validThrough'),
        employmentType: strField(body, 'employmentType'),
        hiringOrganization: { name: strField(body, 'name') },
        jobLocation: {
          address: {
            addressLocality: strField(body, 'addressLocality'),
            addressRegion: strField(body, 'addressRegion'),
            addressCountry: strField(body, 'addressCountry'),
          },
        },
      };
    }
  }
  return null;
}

function findPosting(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findPosting(n);
      if (f) return f;
    }
    return null;
  }
  if (String(node['@type']) === 'JobPosting') return node;
  if (node['@graph']) return findPosting(node['@graph']);
  return null;
}

function strField(body, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(body);
  return m ? m[1] : '';
}

/* ------------------------------------------------------------------ workday */

/**
 * Workday's pages are a JavaScript shell — the HTML holds nothing — but each
 * job is served whole by the tenant's public CXS endpoint, no credentials
 * involved. From
 *   https://psu.wd1.myworkdayjobs.com/en-US/PSU_Academic/job/<place>/<slug>
 * the data is at
 *   https://psu.wd1.myworkdayjobs.com/wday/cxs/psu/PSU_Academic/job/<slug>
 * (tenant = the hostname's first label, site = the path segment after the
 * optional locale). '' for anything that is not a Workday job URL, and the
 * fetching half then treats the page as ordinary HTML.
 */
export function workdayApiUrl(u) {
  const s = url(u);
  if (!s) return '';
  try {
    const p = new URL(s);
    const hm = p.hostname.toLowerCase().match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
    if (!hm) return '';
    const segs = p.pathname.split('/').filter(Boolean);
    if (segs.length && /^[a-z]{2}-[A-Z]{2}$/i.test(segs[0])) segs.shift();
    const at = segs.indexOf('job');
    if (at < 1 || at === segs.length - 1) return '';
    const site = segs[at - 1];
    const slug = segs[segs.length - 1];
    return `https://${p.hostname}/wday/cxs/${hm[1]}/${site}/job/${encodeURIComponent(slug)}`;
  } catch {
    return '';
  }
}

/** What one Workday CXS answer says, in parseAdvert's shape. The deadline is
    searched for in the employer's own description prose — `endDate` is when
    the REQUISITION unposts, this module's validThrough, and feeds
    `listedUntil` only. */
export function parseWorkdayJson(json) {
  const info = (json && json.jobPostingInfo) || null;
  const out = emptyParse();
  if (!info) return out;

  out.title = text(decodeEntities(info.title || ''), 300);
  out.institution = text(decodeEntities(
    (json.hiringOrganization && json.hiringOrganization.name) || ''), 200);
  out.location = text(decodeEntities(info.location || ''), 160);
  out.posted = advertDate(info.startDate || '');
  out.listedUntil = advertDate(info.endDate || '');
  out.employmentType = text(info.timeType || '', 60);

  const desc = String(info.jobDescription || '');
  const fields = labelledPairs(desc);
  const { date, prose } = deadlineFrom(fields, plain(desc));
  out.applyByDate = date;
  out.applyByProse = prose;

  const stated = placeFieldsFrom(fields, out.institution);
  out.school = stated.school;
  out.department = stated.department;

  out.ok = !!(out.title || out.institution);
  return out;
}

/* ------------------------------------------------------------------ parsing */

function emptyParse() {
  return {
    ok: false, gone: false,
    title: '', institution: '', school: '', department: '',
    location: '', posted: '',
    applyByDate: '', applyByProse: '', listedUntil: '', employmentType: '',
  };
}

/** Labels under which these systems name the SCHOOL and the DEPARTMENT —
    PeopleAdmin's details table ("College", "Department"), the boards'
    dt/dd blocks. Read exact-key like the deadline labels, and kept apart
    from them: which of the three name questions a value answers is decided
    later, by `advertPlace`, against the site's own vocabulary. */
export const SCHOOL_LABELS = ['school', 'college', 'school/college', 'school or college', 'faculty'];
export const DEPARTMENT_LABELS = [
  'department', 'hiring department', 'department/organization',
  'academic unit', 'organizational unit', 'unit',
];

/** The school and department a page states, dropped when a value merely
    repeats the organisation's own name (Workday writes the university into
    half its fields). */
function placeFieldsFrom(fields, institution) {
  const own = foldName(String(institution || ''));
  const pick = (labels) => {
    for (const l of labels) {
      const v = text(pairValue(fields, l), 200);
      if (v && (!own || foldName(v) !== own)) return v;
    }
    return '';
  };
  return { school: pick(SCHOOL_LABELS), department: pick(DEPARTMENT_LABELS) };
}

/**
 * The deadline an advertisement states: `{ date, prose }`, DEADLINE_LABELS
 * consulted in order with the same precedence higheredjobs' `deadlineOf`
 * applies — the first labelled value wins, open-ended prose is reported
 * WITHOUT a date, and prose that parses to nothing is still carried, because
 * "Review of applications begins 1 October" is information even though it is
 * not a deadline.
 *
 * When the labels say nothing, the employer's own SENTENCE is tried: a
 * "application deadline … <date>" phrase in the description. The value fed to
 * the date parser is the 60 characters after the phrase, and only a PARSEABLE
 * date is believed — which is what makes reading flattened prose safe here
 * when it is not safe in general (higheredjobs.mjs explains the general
 * case): garbage after the phrase parses to nothing and claims nothing.
 */
export function deadlineFrom(fields, bodyText = '') {
  let prose = '';
  for (const label of DEADLINE_LABELS) {
    const v = pairValue(fields, label);
    if (!v) continue;
    if (!prose) prose = v;
    if (OPEN_ENDED_RX.test(v)) return { date: '', prose: v };
    const date = advertDate(v);
    if (date) return { date, prose: v };
  }
  if (!prose && bodyText) {
    const m = String(bodyText).match(
      /(?:application\s+deadline|closing\s+date|deadline\s+for\s+applications?|apply\s+(?:by|before)|applications?\s+(?:must\s+be\s+(?:received|submitted)\s+by|close\s+on))\s*(?:is|:)?\s*([^.;]{2,60})/i);
    if (m) {
      const tail = m[1].trim().replace(/^(?:the|on|at)\s+/i, '');
      const date = advertDate(tail);
      if (date) return { date, prose: text(m[0], 200) };
      if (OPEN_ENDED_RX.test(m[0])) return { date: '', prose: text(m[0], 200) };
    }
  }
  return { date: '', prose };
}

/** The listing's own end — validThrough or an "End date" field. Information
    for the maintainer's eye, NEVER a deadline; see the header. */
function listingEndFrom(ld, fields) {
  const vt = advertDate((ld && ld.validThrough) || '');
  if (vt) return vt;
  for (const label of LISTING_END_LABELS) {
    const d = advertDate(pairValue(fields, label));
    if (d) return d;
  }
  return '';
}

function tagText(html, rx) {
  const m = rx.exec(String(html || ''));
  return m ? plain(m[1]) : '';
}

function metaContent(html, name) {
  const rx = new RegExp(
    `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i');
  const alt = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i');
  const m = rx.exec(String(html || '')) || alt.exec(String(html || ''));
  return m ? text(decodeEntities(m[1]), 300) : '';
}

/**
 * What one advertisement page says.
 *
 * Everything is best-effort and independently optional, and `ok` demands the
 * page actually identified itself — a title or an employer from a structured
 * source. A page that answers with a layout this cannot read yields
 * `ok: false` rather than a row of empty strings presented as fact, and the
 * caller leaves the posting exactly as it found it.
 */
export function parseAdvert(html) {
  const raw = String(html || '');
  const out = emptyParse();
  if (!raw) return out;

  const ld = jsonLdPosting(raw);
  const fields = labelledPairs(raw);
  const body = plain(raw).slice(0, 40000);

  /* A page that says the listing has come down — checked before anything is
     believed, like higheredjobs' GONE_RX, and only when no JobPosting block
     contradicts it (a live posting whose description QUOTES such a phrase
     stays live). */
  if (GONE_RX.test(body.replace(OPEN_ENDED_CLAUSE_RX, ' ')) && !ld) {
    out.gone = true;
    return out;
  }

  out.title = text(decodeEntities(
    (ld && ld.title)
    || metaContent(raw, 'og:title')
    || tagText(raw, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i)), 300);

  out.institution = text(decodeEntities(
    (ld && ld.hiringOrganization && ld.hiringOrganization.name) || ''), 200);

  const addr = (ld && ld.jobLocation && ld.jobLocation.address) || {};
  out.location = text(decodeEntities([
    addr.addressLocality, addr.addressRegion, addr.addressCountry,
  ].filter(Boolean).join(', ')), 160)
    || text(pairValue(fields, 'location'), 160);

  out.posted = advertDate((ld && ld.datePosted) || '')
    || advertDate(pairValue(fields, 'posted'));
  out.employmentType = text((ld && ld.employmentType) || pairValue(fields, 'type'), 60);

  const stated = placeFieldsFrom(fields, out.institution);
  out.school = stated.school;
  out.department = stated.department;

  const { date, prose } = deadlineFrom(fields, body);
  out.applyByDate = date;
  out.applyByProse = prose;
  out.listedUntil = listingEndFrom(ld, fields);

  /* READ means the page stated a FACT ABOUT THE JOB. A title alone does not:
     every page has an <h1> or an og:title, so a bot wall headed "Careers" and
     a JavaScript shell headed with the tenant's name both parsed `ok`, were
     cached as read with no closing date, and were then left alone for the
     whole TTL. `unreadable` is the honest answer — it changes nothing
     (applyAdverts ignores it, and `keep` above now holds what was known), and
     the ad is re-read on the next pass. The title still counts BESIDE a fact,
     which is what keeps a sparse but genuinely parsed ad readable. */
  const facts = !!(out.institution || out.applyByDate || out.applyByProse
    || out.posted || out.location || out.school || out.department
    || out.employmentType || out.listedUntil);
  out.ok = facts;
  return out;
}

/* -------------------------------------------------------------------- cache */

/** The shape of data/adverts.json. Keyed by `advertKeyOf`, because that is
    the advertisement's identity — a posting can be re-linked with a fresh
    tracking tail without becoming a different advertisement. */
export function emptyCache() {
  return { generated: '', ads: {} };
}

/**
 * One cache entry from a parse. Same contract as higheredjobs' `cacheEntry`:
 * `status` distinguishes a page that could not be READ (retried) from one
 * that states no deadline (not), `via: 'page'` marks an entry read at the
 * source, and WHEN A LISTING HAS COME DOWN WHAT WAS KNOWN IS KEPT — a closed
 * search still had a closing date, and dropping it would quietly return the
 * posting to "Until filled.", the one statement now known to be wrong.
 */
export function cacheEntry(parsed, { adUrl = '', checkedAt = '', previous = null, via = 'page' } = {}) {
  const prev = previous || {};
  /* A page that could not be READ carries nothing, so it must not un-say what
     an earlier read of the same advertisement learnt: the run would blank the
     closing date, `sync-jobmarket-sheet.mjs` would stop re-applying it, and the
     posting would silently return to "Until filled." — the one statement now
     known to be wrong. This is the file's own "an ad that cannot be read
     changes nothing", which held for a failed FETCH (the caller leaves the
     entry alone) and not for a page fetched and not understood. A readable
     page that simply no longer states a field still clears it: there the page
     is the authority. */
  /* NOTHING UNDER data/ MAY CARRY AN E-MAIL, and this cache is served like
     everything else there: CI greps the whole directory, and one address in a
     captured sentence ("apply to hr@example.edu by 15 October 2026") turns
     the checks red on master with the writer having already committed it.
     Stripped where the text is stored, the stripRowEmails rule applied to the
     one other place free prose reaches a served file; the URL is left alone,
     exactly as there. */
  const keep = (now, before) => stripEmails(
    ((parsed.gone || !parsed.ok) && !now) ? (before || '') : (now || ''));

  return {
    url: adUrl,
    status: parsed.gone ? 'gone' : (parsed.ok ? 'ok' : 'unreadable'),
    via,
    title: keep(parsed.title, prev.title),
    institution: keep(parsed.institution, prev.institution),
    school: keep(parsed.school, prev.school),
    department: keep(parsed.department, prev.department),
    location: keep(parsed.location, prev.location),
    posted: keep(parsed.posted, prev.posted),
    applyByDate: keep(parsed.applyByDate, prev.applyByDate),
    applyByProse: keep(parsed.applyByProse, prev.applyByProse),
    listedUntil: keep(parsed.listedUntil, prev.listedUntil),
    employmentType: keep(parsed.employmentType, prev.employmentType),
    checkedAt: checkedAt || '',
  };
}

/**
 * Which advertisements a run should fetch, newest posting first — the same
 * four rules as higheredjobs' `needFetch`, for the same reasons: never read →
 * fetched; not read from the page → fetched whatever its age; fresh within
 * `ttlDays` → left alone; deadline passed or listing gone → frozen (the
 * search is over and the page will not change again). `--force` lifts all
 * four.
 */
export function needFetch(rows, cache, { today = '', ttlDays = 7, force = false } = {}) {
  const ads = (cache && cache.ads) || {};
  const seen = new Set();
  const out = [];

  for (const r of rows || []) {
    const key = advertKeyOf(r && r.adUrl);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const had = ads[key];
    if (force || !had) { out.push({ key, row: r, had: had || null }); continue; }
    if (had.via && had.via !== 'page') { out.push({ key, row: r, had }); continue; }
    if (had.status === 'gone') continue;
    if (today && had.applyByDate && had.applyByDate < today) continue;
    if (today && had.checkedAt && daysApart(had.checkedAt.slice(0, 10), today) < ttlDays) continue;
    out.push({ key, row: r, had });
  }

  out.sort((a, b) => String(b.row.posted || '').localeCompare(String(a.row.posted || '')));
  return out;
}

function daysApart(a, b) {
  const t1 = Date.parse(`${a}T00:00:00Z`), t2 = Date.parse(`${b}T00:00:00Z`);
  return (Number.isFinite(t1) && Number.isFinite(t2))
    ? Math.abs(t2 - t1) / 86400000 : Infinity;
}

/* ----------------------------------------------------------------- applying */

/**
 * Put what was read onto the postings: `{ rows, changed, conflicts }` —
 * higheredjobs' `applyVerified`, for every other host. PURE, and re-applied
 * on every build, because data/jobmarket.json is rebuilt from the workbook
 * each morning and a one-off patch would be gone by the next run.
 *
 * The same three rules, unchanged: a posting with NO deadline takes the
 * advertisement's (both fields move together — the page buckets "Until
 * filled" on the DATE being empty); one that already carries a date keeps
 * it, the disagreement REPORTED so the sheet is corrected at the source; and
 * nothing else about a posting is touched — the maintainer's names, levels
 * and comments are theirs.
 */
export function applyAdverts(rows, cache, { today = '' } = {}) {
  const ads = (cache && cache.ads) || {};
  const changed = [];
  const conflicts = [];

  const out = (rows || []).map((row) => {
    const key = advertKeyOf(row && row.adUrl);
    const ad = key ? ads[key] : null;
    /* 'gone' counts alongside 'ok': the entry then carries what the page said
       while it was up (see cacheEntry). 'unreadable' carries nothing. */
    if (!ad || (ad.status !== 'ok' && ad.status !== 'gone') || !ad.applyByDate) return row;

    if (row.applyByDate) {
      if (row.applyByDate !== ad.applyByDate) {
        conflicts.push({ id: row.id, key, sheet: row.applyByDate, ad: ad.applyByDate });
      }
      return row;
    }

    /* AND IT HAS TO BE A DATE THE ADVERTISEMENT COULD HAVE MEANT — the same
       guard the HigherEdJobs apply uses, from the same function, because a
       date mis-read into the past is published, rolls the posting out of the
       market it is recruiting for, and is then frozen by `needFetch` for ever
       ("the search is over and the page will not change again"). Refused, the
       posting stays open-ended, which is what it already said. */
    if (!believableDeadline(row.posted, ad.applyByDate)) {
      conflicts.push({
        id: row.id, key, sheet: row.applyByDate || '(none)', ad: ad.applyByDate,
        implausible: true, posted: row.posted || '',
      });
      return row;
    }

    /* …and the SUGGESTED date is re-settled against the date that just
       arrived (healReviewDate, exactly as the HigherEdJobs apply does): a
       first-review date on or after the ad's closing date is the closing
       date said twice, or a contradiction. */
    /* AND THE SPAN IS RE-DERIVED, because `years` is derived FROM the two
       apply-by dates and this is where one of them arrives. The served file
       this writes is held by the publishing gate to stating the seasons each
       posting is listed under, so a closing date that reaches into the next
       season and leaves the stored span behind turns the whole suite red and
       stops every data writer committing. See patchDeadlines in
       jobs-model.mjs, which carries the same correction for data/jobs.json. */
    const next = withMarketYears(healReviewDate(
      { ...row, applyBy: longDate(ad.applyByDate), applyByDate: ad.applyByDate }));
    changed.push({
      id: row.id, key, from: row.applyBy, to: next.applyBy,
      past: !!(today && ad.applyByDate < today),
    });
    return next;
  });

  return { rows: out, changed, conflicts };
}

/* -------------------------------------------------------------- queue block */

/**
 * WHERE a posting sits, classified from what the advertisement stated —
 * `{ institution, school, unit }` in the site's own three-name shape, or
 * null when the page stated nothing usable.
 *
 * CURATED, NEVER GUESSED, at every step, because these three names are the
 * site's most-fought-over vocabulary (see "One spelling per university,
 * school and department" in CLAUDE.md):
 *
 *   - a hiring organisation that is really a SCHOOL — "Harvard Business
 *     School", the Interfolio shape — is filed under its university ONLY
 *     when the site's own directory names exactly one home for it
 *     (`universityForSchool`);
 *   - the three names then go through `canonColumns()`, the same function
 *     the posting form's three boxes go through, so what the card offers is
 *     the spelling the site already publishes;
 *   - an EMPTY school whose department the directory can place at that
 *     university is filled from the directory (`schoolForUnit`, the
 *     `fillSchoolFromDirectory` discipline — one school, or nothing).
 *
 * A name the vocabulary has never seen is still RETURNED, exactly as stated
 * — the maintainer decides on the card, and `settlePlace` canonicalises
 * whatever they adopt — but nothing here ever invents a pairing the
 * directory does not know.
 */
export function advertPlace(ad, vocab, schools = SCHOOLS) {
  const inst = text(ad && ad.institution, 200);
  const sch = text(ad && ad.school, 200);
  const unit = text(ad && ad.department, 200);
  if (!inst && !sch && !unit) return null;

  let institution = inst;
  let school = sch;

  if (inst && !sch) {
    const home = universityForSchool(vocab, inst, schools);
    if (home) { institution = home.institution; school = home.school; }
  }
  if (!institution && school) {
    const home = universityForSchool(vocab, school, schools);
    if (home) { institution = home.institution; school = home.school; }
  }

  const place = canonColumns({ institution, school, unit });
  if (place.institution && !place.school && place.unit) {
    const housed = schoolForUnit(vocab, place.institution, place.unit, schools);
    if (housed) place.school = housed;
  }

  const out = {
    institution: place.institution || '',
    school: place.school || '',
    unit: place.unit || '',
  };
  return (out.institution || out.school || out.unit) ? out : null;
}

/**
 * The `ad` block a pending review document carries — what the advertisement
 * itself says, put where the maintainer decides. RAISED, NEVER DECIDED, like
 * `dup` and `biz` beside it: the review card draws it with buttons that only
 * fill the boxes, and nothing publishes until Approve. `listedUntil` rides
 * along labelled as what it is; `place` is `advertPlace`'s classification of
 * the stated names against the site's own vocabulary.
 */
export function adBlock(entry, { adUrl = '', place = null } = {}) {
  if (!entry) return null;
  return {
    url: adUrl || entry.url || '',
    status: entry.status || 'unreadable',
    title: entry.title || '',
    institution: entry.institution || '',
    school: entry.school || '',
    department: entry.department || '',
    place: place || null,
    location: entry.location || '',
    posted: entry.posted || '',
    applyByDate: entry.applyByDate || '',
    applyByProse: entry.applyByProse || '',
    listedUntil: entry.listedUntil || '',
    checkedAt: entry.checkedAt || '',
  };
}

/** Two ad blocks that say the same thing — the `sameDups` rule, so a run
    with nothing new writes nothing to the document. */
export function sameAdInfo(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/* ------------------------------------------------------------ host report */

/**
 * The distinct websites the postings' advertisements live on, for the given
 * market years (default: the two newest in the rows): one entry per host,
 * `{ host, postings, years, read }` — `read` naming which pipeline covers it.
 * Drive/Docs links are EXCLUDED BY THE OWNER'S OWN RULE (2026-08-24): they
 * are user-uploaded copies whose address changes every time, so a host list
 * carrying them would name storage, not a job board. Our own home page — a
 * sheet row that names no ad — is likewise nothing.
 */
export function advertHostsReport(rows, { years = null } = {}) {
  const all = (rows || []).filter((r) => r && r.adUrl);
  const wanted = years && years.length ? years.map(Number)
    : [...new Set(all.map((r) => Number(r.year)).filter(Boolean))]
      .sort((a, b) => b - a).slice(0, 2);

  const byHost = new Map();
  for (const r of all) {
    if (!wanted.includes(Number(r.year))) continue;
    let host;
    try {
      host = new URL(url(r.adUrl)).hostname.toLowerCase().replace(/^www\./, '');
    } catch { continue; }
    if (!host) continue;
    if (/(^|\.)(drive|docs)\.google\.com$/.test(host)) continue;
    if (/(^|\.)operationsacademia\.org$/.test(host)) continue;

    const read = isHigherEdJobsUrl(r.adUrl) ? 'higheredjobs pipeline'
      : workdayApiUrl(r.adUrl) ? 'adverts pipeline (Workday JSON)'
      : !isAdvertUrl(r.adUrl) ? 'never fetched (login wall)'
      : /\.pdf(\?|$)/i.test(r.adUrl) ? 'adverts pipeline (PDF — unreadable)'
      : 'adverts pipeline (generic)';

    const e = byHost.get(host) || { host, postings: 0, years: new Set(), read };
    e.postings++;
    e.years.add(Number(r.year));
    byHost.set(host, e);
  }

  return {
    years: wanted,
    hosts: [...byHost.values()]
      .map((e) => ({ ...e, years: [...e.years].sort() }))
      .sort((a, b) => b.postings - a.postings || a.host.localeCompare(b.host)),
  };
}

/**
 * Does a pending document's advertisement need (re)reading? Pure, so the
 * verify's own selftest can drive it. The document's existing block is its
 * own cache: fresh within `ttlDays` and still describing the SAME URL, it is
 * left alone; a re-linked advert or a stale read is fetched again. A block
 * whose deadline has passed is NOT frozen here, unlike the published cache —
 * a pending review is exactly where "this closed last week" must stay
 * current rather than stand still.
 */
export function queueNeedsFetch(doc, { today = '', ttlDays = 7, force = false } = {}) {
  const effUrl = ((doc && doc.edits && doc.edits.adUrl) || (doc && doc.row && doc.row.adUrl) || '');
  if (!isAdvertUrl(effUrl) && !isHigherEdJobsUrl(effUrl)) return { fetch: false, url: '' };
  const ad = doc && doc.ad;
  if (force || !ad || !ad.checkedAt) return { fetch: true, url: effUrl };
  if (String(ad.url || '') !== String(effUrl)) return { fetch: true, url: effUrl };
  if (today && daysApart(String(ad.checkedAt).slice(0, 10), today) >= ttlDays) {
    return { fetch: true, url: effUrl };
  }
  return { fetch: false, url: effUrl };
}
