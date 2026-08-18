/* ---------------------------------------------------------------------------
   Operations Academia — reading a HigherEdJobs advertisement.

   A large share of the postings the maintainer's tracking sheet carries link
   to https://www.higheredjobs.com/. The sheet has no deadline column for most
   of them, so those rows reach the site as "Until filled." — which is the
   sheet's own default (see the note on applyBy in jobmarket-sheet.mjs), NOT
   something anyone checked. The advertisement itself states the deadline
   plainly, in a field of its own, so it can be read rather than guessed at.

   This module is the PURE half: given the HTML of one advertisement it says
   what that advertisement claims, and given a set of postings and a cache of
   what was read it says how the postings change. It fetches nothing. The
   fetching half is higheredjobs-verify.mjs, which runs on the GitHub Actions
   runners — this build environment's egress policy denies higheredjobs.com
   (403 at the proxy), the same situation as docs.google.com in
   sync-jobmarket-sheet.mjs.

   THE ONE TRAP, and the reason this file exists rather than a three-line
   regex: a HigherEdJobs page carries a schema.org JobPosting block whose
   `validThrough` looks exactly like a deadline and is not one. It is when the
   ADVERTISEMENT stops being listed, which HigherEdJobs sets ~18 months out:
   the Utah Valley University lecturer post that closes on 20 August 2026
   carries `validThrough: 2028-02-06`. Reading that field would publish a
   deadline eighteen months after the search has closed — worse than the
   "Until filled." it replaced, because it looks specific. The deadline is the
   page's own "Application Due:" field, corroborated by the "Closing:" line
   the employer writes into the description. `validThrough` is deliberately
   never read; DEADLINE_FIELDS below is the whole list of what is.
   --------------------------------------------------------------------------- */

import { text, url, longDate, OPEN_ENDED_RX } from './jobs-model.mjs';

/** Hosts whose /faculty/details.cfm pages this module knows how to read. */
const HOSTS = new Set(['higheredjobs.com', 'www.higheredjobs.com']);

/** How the advertisement's own deadline is found, in order of authority.
    "Application Due" is HigherEdJobs' structured field — it is what the
    employer filled in, and what the site prints at the top of the page.
    The others are the employer's own prose in the description body, used
    only when the structured field is empty. `validThrough` is NOT here; see
    the header. */
export const DEADLINE_FIELDS = [
  'Application Due',
  'Closing',
  'Closing Date',
  'Application Deadline',
  'Deadline',
];

/** A listing that has come down. HigherEdJobs keeps the URL alive and answers
    with a notice rather than a 404, so an expired advertisement has to be
    recognised from its text or it reads as an unparseable page. */
const GONE_RX =
  /(no longer (?:available|accepting|being accepted)|has expired|this (?:job|position|posting) (?:is closed|has been (?:removed|filled)))/i;

/* ------------------------------------------------------------------- urls */

/** Is this one of ours? Host-validated rather than matched as a substring, so
    a URL that merely MENTIONS higheredjobs.com cannot be fetched as one. */
export function isHigherEdJobsUrl(u) {
  const s = url(u);
  if (!s) return false;
  try {
    return HOSTS.has(new URL(s).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** The JobCode a details URL names — the advertisement's identity, and the
    key everything here is cached under. The sheet's links carry a `Title`
    query parameter too, which is decoration: two links to the same posting
    can differ in it (the title gets re-encoded), so it is never part of the
    key. */
export function jobCodeOf(u) {
  if (!isHigherEdJobsUrl(u)) return '';
  try {
    const code = new URL(url(u)).searchParams.get('JobCode') || '';
    return /^\d{4,12}$/.test(code) ? code : '';
  } catch {
    return '';
  }
}

/** The canonical page for a JobCode — what the verifier fetches. Without the
    Title parameter: it is not needed to serve the page, and dropping it keeps
    one request per advertisement however the sheet spelled the link. */
export function detailsUrl(jobCode) {
  const code = String(jobCode || '').trim();
  return /^\d{4,12}$/.test(code)
    ? `https://www.higheredjobs.com/faculty/details.cfm?JobCode=${code}`
    : '';
}

/* ------------------------------------------------------------------- html */

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ');
}

/** Entity decoding, run to a fixed point. HigherEdJobs embeds the employer's
    description inside a JSON string inside a script tag, so its markup arrives
    DOUBLE encoded ("&amp;lt;b&amp;gt;") and one pass would leave literal
    "&lt;b&gt;" in the text. Bounded so a pathological input cannot spin. */
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

/** Tags out, entities decoded, whitespace collapsed — in that order, twice
    over, because the markup is only revealed once the entities are decoded. */
function plain(s) {
  return stripTags(decodeEntities(stripTags(decodeEntities(s))))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every `Label: value` pair the page states, as a Map keyed by lower-cased
 * label.
 *
 * The same fact is written twice on one page, and both shapes are MARKUP:
 * at the top, in the summary block, `<strong>Application Due:</strong>
 * 08/20/2026`; in the description body, inside the JSON-LD string and so
 * double-encoded, `&lt;b&gt;Closing:&lt;/b&gt; 8/20/2026 11:59 PM Mountain`.
 * Decoding the document first (see `decodeEntities`) turns the second into
 * the first, so one matcher reads both.
 *
 * READ FROM THE MARKUP, NOT FROM FLATTENED TEXT, and that is the whole point
 * of doing it this way. Flattened, the page reads "... Salary: Depends on
 * Qualifications Job Type: FT Faculty ...", and no rule over that text can
 * tell where the salary ends: "Qualifications" is a capitalised word directly
 * against the next label, so a "value ends at the next Capitalised Word plus
 * colon" rule truncates it to "Depends on", and a "Type" lookup matches the
 * tail of "Job Type". The bold tag says exactly where each label starts and
 * therefore exactly where the previous value ended, and it distinguishes
 * "Type" from "Job Type" because each is a key of its own.
 *
 * A value runs to the next label, the next line break, or the end of its
 * block — whichever comes first.
 */
export function labelledFields(html) {
  const doc = decodeEntities(String(html || ''));
  const fields = new Map();

  const RX = new RegExp(
    // <strong>Label:</strong>  — the colon inside the tag or just after it
    '<(strong|b)\\b[^>]*>\\s*([A-Za-z][A-Za-z /&\'-]{1,40}?)\\s*:?\\s*</\\1>\\s*:?' +
    // ... the value, up to the next label / line break / end of block
    '([\\s\\S]{0,600}?)(?=<(?:strong|b)\\b|<br|</div|</p|</center|</td|$)',
    'gi');

  for (const m of doc.matchAll(RX)) {
    const label = m[2].replace(/\s+/g, ' ').trim().toLowerCase();
    const value = text(decodeEntities(stripTags(m[3])).replace(/\s+/g, ' ').trim(), 300);
    // first statement wins: the summary block is above the description, and
    // its fields are the ones HigherEdJobs itself curates
    if (label && value && !fields.has(label)) fields.set(label, value);
  }

  return fields;
}

/** One labelled value, by name. Exact-key, so "Type" cannot be answered with
    "Job Type"'s value. */
export function fieldValue(fields, label) {
  return (fields instanceof Map)
    ? (fields.get(String(label).toLowerCase()) || '')
    : '';
}

/* ------------------------------------------------------------------ dates */

/**
 * A date as HigherEdJobs writes it, which is US order and nothing else.
 *
 * Deliberately NOT jobmarket-sheet's `sheetDay`: that one has to survive a
 * hand-kept spreadsheet, so it guesses at ambiguous input (a first field over
 * 12 is read as a day). Here the format is a US site's fixed one, and guessing
 * would turn 05/06/2026 into the sixth of May on one page and the fifth of
 * June on another. A shape it does not recognise returns '' and the caller
 * falls back to the prose — never to a guess.
 */
export function hejDate(v) {
  const s = text(v, 60);
  if (!s) return '';

  const iso = (y, m, d) =>
    (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)
      ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      : '';

  let m;

  // 2026-08-20 (the JSON-LD's own shape, with or without a time after it)
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\b/))) return iso(+m[1], +m[2], +m[3]);

  // 08/20/2026 and 8/20/26 — month first, always
  if ((m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/))) {
    const y = +m[3];
    return iso(y < 100 ? 2000 + y : y, +m[1], +m[2]);
  }

  // August 20, 2026 — some employers write the closing line out in words
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  if ((m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/))) {
    const mo = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1;
    return mo ? iso(+m[3], mo, +m[2]) : '';
  }

  return '';
}

/* ----------------------------------------------------------------- parsing */

/**
 * What one advertisement says.
 *
 * Returns `{ ok, gone, jobCode, title, institution, location, city, state,
 * country, type, posted, applyByDate, applyByProse, category, salary,
 * jobNumber, jobType }`. Everything is best-effort and independently
 * optional: a page that has moved to a layout this does not know yields
 * `ok: false` rather than a row of empty strings presented as fact, and the
 * caller then leaves the posting exactly as it found it.
 */
export function parseAd(html, { jobCode = '' } = {}) {
  const raw = String(html || '');
  const out = {
    ok: false, gone: false, jobCode: String(jobCode || ''),
    title: '', institution: '', location: '', city: '', state: '', country: '',
    type: '', posted: '', applyByDate: '', applyByProse: '',
    category: '', salary: '', jobNumber: '', jobType: '',
  };
  if (!raw) return out;

  const ld = jsonLdPosting(raw);
  const fields = labelledFields(raw);

  /* An advertisement that has come down. Checked BEFORE anything is believed:
     the notice page keeps the site's chrome, so a field read off it would be
     the previous visitor's, not this posting's. */
  if (GONE_RX.test(plain(raw)) && !ld) {
    out.gone = true;
    return out;
  }

  out.title = text(decodeEntities(
    tagText(raw, /<h1[^>]*id=["']jobtitle-header["'][^>]*>([\s\S]*?)<\/h1>/i)
    || ld?.title || ''), 300);

  out.institution = text(decodeEntities(
    tagText(raw, /<div[^>]*class=["'][^"']*job-inst[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
    || ld?.hiringOrganization?.name || ''), 200);

  const loc = tagText(raw, /<div[^>]*class=["'][^"']*job-loc[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
    .replace(/^\s*in\s+/i, '');
  const addr = ld?.jobLocation?.address || {};
  out.city = text(decodeEntities(addr.addressLocality || ''), 120);
  out.state = text(decodeEntities(addr.addressRegion || ''), 60);
  out.country = text(decodeEntities(addr.addressCountry || ''), 60);
  out.location = text(decodeEntities(loc), 160)
    || [out.city, out.state].filter(Boolean).join(', ');

  out.type = fieldValue(fields, 'Type') || employmentType(ld?.employmentType);
  out.category = fieldValue(fields, 'Category');
  out.salary = fieldValue(fields, 'Salary');
  out.jobNumber = fieldValue(fields, 'Job Number');
  out.jobType = fieldValue(fields, 'Job Type');

  /* The posted date comes from the JSON-LD, which carries a timestamp, rather
     than from the page's "Posted: 2 days ago" — relative text is only true on
     the day it was fetched, and a cache is read long afterwards. */
  out.posted = hejDate(ld?.datePosted || '');

  const { date, prose } = deadlineOf(fields);
  out.applyByDate = date;
  out.applyByProse = prose;

  out.jobCode = out.jobCode
    || (raw.match(/JobCode=(\d{4,12})/) || [])[1] || '';

  /* "Parsed" means the page identified itself as a posting AND named the
     employer — the two things every layout has had. Without both, whatever
     else was scraped is not to be trusted onto the site. */
  out.ok = !!(out.institution && (out.title || ld));
  return out;
}

/**
 * The deadline the advertisement states: `{ date, prose }`.
 *
 * `date` is ISO and empty when the page states no closing date; `prose` is
 * what it actually said, kept because "Open until filled" and "Review begins
 * 1 October" are information even though neither is a date.
 *
 * The fields are consulted in DEADLINE_FIELDS order and the first that yields
 * a date wins, so the employer's structured answer beats their prose. Prose
 * that says the search stays open is reported WITHOUT a date even if a later
 * field carries one — the same precedence the sheet ingest applies, so a
 * posting cannot end up dated and open-ended at once.
 */
export function deadlineOf(fields) {
  let prose = '';
  for (const label of DEADLINE_FIELDS) {
    const v = fieldValue(fields, label);
    if (!v) continue;
    if (!prose) prose = v;
    if (OPEN_ENDED_RX.test(v)) return { date: '', prose: v };
    const date = hejDate(v);
    if (date) return { date, prose: v };
  }
  return { date: '', prose };
}

function employmentType(v) {
  const s = String(v || '').toUpperCase();
  if (s.includes('FULL')) return 'Full-Time';
  if (s.includes('PART')) return 'Part-Time';
  return '';
}

function tagText(html, rx) {
  const m = rx.exec(String(html || ''));
  return m ? stripTags(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** The page's schema.org JobPosting block, if it has one. A page carries
    several ld+json blocks (the organisation, the site search) — the one
    wanted is the block whose @type is JobPosting. */
function jsonLdPosting(html) {
  for (const m of String(html).matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    if (!/"@type"\s*:\s*"JobPosting"/i.test(body)) continue;
    try {
      return JSON.parse(body);
    } catch {
      /* HigherEdJobs writes the description into this string unescaped often
         enough that JSON.parse fails on a real page. The few fields wanted are
         then read individually, which is why nothing here depends on the block
         parsing as a whole. */
      return {
        title: strField(body, 'title'),
        datePosted: strField(body, 'datePosted'),
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

function strField(body, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(body);
  return m ? m[1] : '';
}

/* ------------------------------------------------------------------ cache */

/** The shape of data/higheredjobs.json. Keyed by JobCode, because that is the
    advertisement's identity — a posting can be re-linked or re-titled in the
    sheet without becoming a different advertisement. */
export function emptyCache() {
  return { generated: '', ads: {} };
}

/**
 * One cache entry from a parse.
 *
 * `checkedAt` is what the freshness rule reads. `status` records what the
 * fetch found, so a page that could not be READ is distinguishable from one
 * that carries no deadline — the first is retried, the second is not.
 *
 * `via` says where the entry came from: `'page'` when it was read from the
 * advertisement itself, anything else when it was taken from a report of the
 * advertisement. Only `'page'` is ever frozen (see `needFetch`), so a value
 * that was not read at the source is always replaced by one that was.
 *
 * WHEN A LISTING HAS COME DOWN, WHAT WAS KNOWN IS KEPT. A closed search still
 * had a closing date, and that date is the true thing to show about it —
 * dropping it because the page has gone would quietly return the posting to
 * "Until filled.", which is the one statement we now know to be wrong.
 */
export function cacheEntry(parsed, { jobCode, url: u, checkedAt, previous = null, via = 'page' } = {}) {
  const prev = previous || {};
  const keep = (now, before) => (parsed.gone && !now) ? (before || '') : (now || '');

  return {
    url: u || detailsUrl(jobCode),
    status: parsed.gone ? 'gone' : (parsed.ok ? 'ok' : 'unreadable'),
    via,
    title: keep(parsed.title, prev.title),
    institution: keep(parsed.institution, prev.institution),
    location: keep(parsed.location, prev.location),
    type: keep(parsed.type, prev.type),
    posted: keep(parsed.posted, prev.posted),
    applyByDate: keep(parsed.applyByDate, prev.applyByDate),
    applyByProse: keep(parsed.applyByProse, prev.applyByProse),
    category: keep(parsed.category, prev.category),
    salary: keep(parsed.salary, prev.salary),
    jobNumber: keep(parsed.jobNumber, prev.jobNumber),
    checkedAt: checkedAt || '',
  };
}

/**
 * Which advertisements a run should fetch, newest posting first.
 *
 * Four rules, each of which exists to keep the daily run small and polite:
 *   - an advertisement never read is always fetched;
 *   - one not read from the PAGE is always fetched, whatever its age — an
 *     entry taken from a report of the advertisement is a stand-in, and the
 *     point of a stand-in is that it is replaced;
 *   - one read within `ttlDays` is left alone;
 *   - one whose deadline has PASSED is frozen — the search is over, the page
 *     will not change again, and re-reading it every morning for the rest of
 *     the market year buys nothing. `--force` lifts all four.
 */
export function needFetch(rows, cache, { today = '', ttlDays = 7, force = false } = {}) {
  const ads = (cache && cache.ads) || {};
  const seen = new Set();
  const out = [];

  for (const r of rows) {
    const code = jobCodeOf(r && r.adUrl);
    if (!code || seen.has(code)) continue;
    seen.add(code);

    const had = ads[code];
    if (force || !had) { out.push({ jobCode: code, row: r, had: had || null }); continue; }
    if (had.via && had.via !== 'page') { out.push({ jobCode: code, row: r, had }); continue; }
    if (had.status === 'gone') continue;
    if (today && had.applyByDate && had.applyByDate < today) continue;
    if (today && had.checkedAt && daysApart(had.checkedAt.slice(0, 10), today) < ttlDays) continue;
    out.push({ jobCode: code, row: r, had });
  }

  out.sort((a, b) => String(b.row.posted || '').localeCompare(String(a.row.posted || '')));
  return out;
}

function daysApart(a, b) {
  const t1 = Date.parse(`${a}T00:00:00Z`), t2 = Date.parse(`${b}T00:00:00Z`);
  return (Number.isFinite(t1) && Number.isFinite(t2))
    ? Math.abs(t2 - t1) / 86400000 : Infinity;
}

/* ---------------------------------------------------------------- applying */

/**
 * Put what was read onto the postings: `{ rows, changed, conflicts }`.
 *
 * PURE, and re-applied on every build rather than written once — the sheet
 * sync rebuilds data/jobmarket.json from the workbook every morning, so a
 * one-off patch of the file would be gone by the next run (the same rule the
 * repository states for country spellings).
 *
 * WHAT IT MAY CHANGE, and what it may not:
 *
 *   - A posting with NO deadline date takes the advertisement's. That is the
 *     whole point: those rows read "Until filled." only because the sheet has
 *     no deadline column for them, and the advertisement knows better.
 *   - A posting that ALREADY carries a date keeps it, and a disagreement is
 *     REPORTED instead. The tracking sheet is the maintainer's own record and
 *     a typed deadline is a decision; overwriting it here would fight them
 *     silently every morning. The conflict names both dates so the sheet can
 *     be corrected — which fixes it at the source, permanently.
 *   - Nothing else is touched. Institution, department, entry level and the
 *     comments line are the maintainer's, and are how they want the posting
 *     described; the advertisement's title is already in `comments` from the
 *     sheet's own Rank column.
 *
 * An advertisement whose page could not be read changes nothing at all.
 */
export function applyVerified(rows, cache, { today = '' } = {}) {
  const ads = (cache && cache.ads) || {};
  const changed = [];
  const conflicts = [];

  const out = (rows || []).map((row) => {
    const code = jobCodeOf(row && row.adUrl);
    const ad = code ? ads[code] : null;
    /* 'gone' counts alongside 'ok': the entry then carries what the page said
       while it was up (see cacheEntry), and a search that has closed still
       closed on a date. 'unreadable' does not — it carries nothing. */
    if (!ad || (ad.status !== 'ok' && ad.status !== 'gone') || !ad.applyByDate) return row;

    if (row.applyByDate) {
      if (row.applyByDate !== ad.applyByDate) {
        conflicts.push({ id: row.id, jobCode: code, sheet: row.applyByDate, ad: ad.applyByDate });
      }
      return row;
    }

    /* The sheet said nothing about a deadline and the advertisement does. Both
       fields move together: the page buckets a posting as open-ended on the
       DATE being empty, so setting one without the other would show a date on
       the card and file it under "Until filled" in the filter. */
    const next = { ...row, applyBy: longDate(ad.applyByDate), applyByDate: ad.applyByDate };
    changed.push({
      id: row.id, jobCode: code, from: row.applyBy, to: next.applyBy,
      past: !!(today && ad.applyByDate < today),
    });
    return next;
  });

  return { rows: out, changed, conflicts };
}
