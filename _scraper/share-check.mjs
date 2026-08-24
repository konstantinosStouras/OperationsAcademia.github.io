#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — every page previews properly when somebody shares it.

       node _scraper/share-check.mjs
       node _scraper/share-check.mjs --verbose

   WHY THIS EXISTS. Somebody pasted this site's address into WhatsApp beside a
   link to another site of the maintainer's. The other one drew a card with a
   picture, a title and a sentence. This one drew the hostname twice and
   nothing else. Both are static sites on GitHub Pages; both had a complete
   Open Graph block in their home page's <head>. Two things were found, and
   NEITHER was visible from any check the repository had:

     1. TWENTY-FOUR of the twenty-five live pages carried no preview metadata
        at all. Sharing the job postings page — the page people actually send
        each other — produced a bare link. This was a REGRESSION: before the
        rebuild sixteen sub-pages carried og:* tags. They were defective tags,
        but they were tags, and nothing noticed them leaving.

     2. SIXTY-EIGHT SERVED FILES THAT WERE NOT THE HOME PAGE declared the
        home page's address. Facebook's crawler family — which serves
        WhatsApp, Messenger, Facebook, LinkedIn and Viber — keys a preview on
        `og:url`, not on the address that was pasted. Seventeen archived pages
        under /v1/, all `noindex,nofollow`, gave it as
        `https://www.operationsacademia.org`; fifty-one old copies under a
        directory called `back up` (a name Jekyll publishes quite happily)
        gave it as `http://operationsacademia.org`, the plain-http apex form
        of the same place. Sixty-nine files, counting the real one, for one
        address. /v2/ did not have this problem because archive-v2.mjs' rule 5
        re-points an archived page at its own address — a rule written on
        promotion day and never backported two days to /v1/.

   So this check asserts what neither selftest.mjs nor link-check.mjs did.
   Nothing here is a matter of taste; every rule below is a documented
   requirement of a real crawler, and the ones that look fussy are the ones
   that fail SILENTLY — a preview that does not render reports nothing to
   anybody, which is why it went unnoticed for months.

   THE RULES, and whose requirement each is:

     * every live page carries the whole block, and every live page is LISTED
       in PAGES below. A page added without an entry fails this check rather
       than shipping cardless — the same discipline _MOBILE-STANDARDS.md
       applies to a new list page;
     * og:url and <link rel="canonical"> AGREE, are absolute, https, and on
       www.operationsacademia.org. Meta picks unpredictably when they differ;
     * NO TWO SERVED FILES DECLARE THE SAME og:url. This is finding 2, and it
       is the rule the whole thing turns on. An archived page must name its
       own address;
     * EXACTLY ONE og:image per page. Multiple images are legal Open Graph and
       WhatsApp handles them badly;
     * og:image is absolute https, is a file that EXISTS in this repository
       (not a redirect, not a signed URL, not another host), is JPEG or PNG,
       and its declared og:image:width/height MATCH the file's real pixels.
       Meta lays the card out from the declared numbers before it has finished
       downloading the image, which is how the very first person to share a
       link gets a big card instead of a small one;
     * og:image stays under 300 KB. WhatsApp silently drops a heavier one and
       the card degrades to plain text with no error anywhere;
     * og:* uses property=, twitter:* uses name=. Backwards, they are invisible
       to the crawler that wanted them, and nothing warns;
     * <meta charset> is the FIRST thing in <head>, and the preview block sits
       before any stylesheet, preconnect or inline script. Slackbot reads the
       first 32 KB of a document and WhatsApp's parser gives up sooner than
       Facebook's; a fat head above the tags is a documented way to lose a
       card;
     * a description exists and is a sentence, not a fragment or an essay.
       WeChat and iMessage fall back to <title>, so that has to stand alone
       too;
     * the SQUARE thumbnail is offered through <link rel="image_src"> and
       <meta itemprop="image">. The Chinese clients centre-crop to 1:1 and the
       wide card loses its left and right thirds; see make-share-images.mjs.

   WHAT IT CANNOT CHECK, and this matters: whether the crawler can actually
   REACH the page. A GitHub Pages edge that answers facebookexternalhit with a
   403, a Meta-side domain flag, or a cached failed scrape all produce exactly
   the symptom this check is named for, and none of them is visible from the
   repository. The Facebook Sharing Debugger answers all three in one paste:
   https://developers.facebook.com/tools/debug/ — read "Response Code" and
   "Time Scraped".
   --------------------------------------------------------------------------- */

import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

export const SITE = 'https://www.operationsacademia.org';
export const CARD = '/images/og-card.jpg';       // 1200x630, the wide card
export const SQUARE = '/images/share-square.jpg'; // 800x800, the Chinese clients

/* WhatsApp silently drops a thumbnail over roughly this size. Meta's own
   documentation says 600 KB; the reproduced field threshold is lower, and
   there is no reason to sit between the two. */
const MAX_CARD_BYTES = 300 * 1024;

/* ALT TEXT DESCRIBES THE PICTURE, NOT THE PAGE. Every page shares one card, so
   every page shares one alt — the first draft of this change generated "Job
   postings in Operations — Operations Academia" for a picture of the logo over
   a tagline, which is a caption for the wrong thing and is what gets read
   aloud to somebody who cannot see it. */
export const CARD_ALT = 'Operations Academia — matching supply with demand in the Operations job market.';

/* ---------------------------------------------------------------------------
   EVERY PAGE THE SITE SERVES AT THE ROOT, and what its card says.

   `card: false` is a DELIBERATE opt-out and each one carries its reason. The
   six section stubs are the interesting case: they are `noindex` pages whose
   canonical names a fragment of the home page, so any og:url they carried
   would resolve to the home page's Open Graph identity — which is finding 2,
   recreated six times over. They therefore carry no og:* at all, which is
   exactly the shape the sibling site's redirect stubs have and the reason its
   cards never broke.
   --------------------------------------------------------------------------- */
export const PAGES = [
  {
    file: 'index.html', url: '/',
    title: 'Operations Academia',
    ogTitle: 'Operations Academia',
    description: 'Matching supply with demand in the Operations job market — academic job postings, candidates, placements and the annual survey, in one place.',
    ogDescription: 'Matching supply with demand in the Operations job market — the academic job market hub for Operations Management, Operations Research and Analytics.',
    alt: 'Operations Academia — matching supply with demand in the Operations job market.',
  },
  {
    file: 'jobs.html', url: '/jobs.html',
    title: 'Job postings — Operations Academia',
    ogTitle: 'Job postings in Operations',
    description: 'Every academic opening the community has posted for the job market year under way — searchable by university, country, level and department.',
  },
  {
    file: 'universities.html', url: '/universities.html',
    title: 'Universities — Operations Academia',
    ogTitle: 'Universities & schools with Operations departments',
    description: 'The searchable directory of 500+ universities and schools with Operations departments — grouped by university, with each school, department and link. Search it, or explore the map.',
  },
  {
    file: 'recent-faculty.html', url: '/recent-faculty.html',
    title: 'Recent faculty — Operations Academia',
    ogTitle: 'Recently hired faculty in Operations',
    description: 'Recently hired junior faculty in Operations, broadly defined — where the field’s newest academics went, and from which doctoral programmes.',
  },
  {
    file: 'previous-markets.html', url: '/previous-markets.html',
    title: 'Previous job markets — Operations Academia',
    ogTitle: 'Previous job markets',
    description: 'Past academic job postings in Operations, season by season, back through the site’s archive — what was advertised, and by whom.',
  },
  {
    file: 'analytics.html', url: '/analytics.html',
    title: 'Analytics — Operations Academia',
    ogTitle: 'How Operations Academia is used',
    description: 'Representative metrics of how Operations Academia is used — which universities visit, how often, and which pages they read.',
  },
  {
    file: 'survey.html', url: '/survey.html',
    title: 'Annual Job Market Survey — Operations Academia',
    ogTitle: 'The Annual Operations Job Market Survey',
    description: 'The first job market survey ever conducted for candidates in Operations Management and Operations Research — what candidates went through, in their own numbers.',
  },
  {
    file: 'survey-faqs.html', url: '/survey-faqs.html',
    title: 'Survey FAQs — Operations Academia',
    ogTitle: 'Survey FAQs',
    description: 'Frequently asked questions about the Annual Job Market Survey in Operations — who should answer it, what is asked, and what happens to the answers.',
  },
  {
    file: 'informed_consent_statement.html', url: '/informed_consent_statement.html',
    title: 'Informed Consent Statement — Operations Academia',
    ogTitle: 'Informed Consent Statement',
    description: 'The informed consent statement for the Annual Operations Job Market Survey — what participation involves, and how your responses are protected.',
  },
  {
    file: 'post-a-job.html', url: '/post-a-job.html',
    title: 'Post a job — Operations Academia',
    ogTitle: 'Post a job — it’s free',
    description: 'Posting an academic job in Operations is free. It appears on the job postings page within a few minutes and stays there for the rest of the market year.',
  },
  {
    file: 'post-a-candidate.html', url: '/post-a-candidate.html',
    title: 'Post your candidacy — Operations Academia',
    ogTitle: 'Post your candidacy',
    description: 'Creating a candidate profile is free. It stays private until the reveal date announced on the candidates page, when every profile appears at once.',
  },
  {
    file: 'post-a-placement.html', url: '/post-a-placement.html',
    title: 'Report a placement — Operations Academia',
    ogTitle: 'Report a placement',
    description: 'Reporting your placement is free and takes a minute. It appears on the confirmed placements page within the hour, where it encourages the peers still on the market.',
  },
  {
    file: 'alerts.html', url: '/alerts.html',
    title: 'E-mail alerts — Operations Academia',
    ogTitle: 'E-mail alerts',
    description: 'Be told when a new job posting matches your filters, or when the site changes. You choose what and how often; every message carries a one-click unsubscribe.',
  },
  {
    file: 'account.html', url: '/account.html',
    title: 'My personal area — Operations Academia',
    ogTitle: 'My personal area',
    description: 'Your Operations Academia account — the postings you have made, the alerts you subscribe to, and the details kept against your name.',
  },
  {
    file: 'my-postings.html', url: '/my-postings.html',
    title: 'My postings — Operations Academia',
    ogTitle: 'My postings',
    description: 'The job postings, candidate profiles and placements you have submitted to Operations Academia — edit any of them, or take one down.',
  },
  {
    file: 'feedback.html', url: '/feedback.html',
    title: 'Feedback — Operations Academia',
    ogTitle: 'Feedback',
    description: 'Tell us what to improve on Operations Academia — something broken, something missing, or something that could be clearer.',
  },
  {
    file: 'whats-new.html', url: '/whats-new.html',
    title: 'What’s new — Operations Academia',
    ogTitle: 'What’s new on Operations Academia',
    description: 'What changed on Operations Academia — new features and site updates, newest first, from the same record the e-mail digests are sent from.',
  },
  {
    file: 'privacy-policy.html', url: '/privacy-policy.html',
    title: 'Privacy Policy — Operations Academia',
    ogTitle: 'Privacy Policy',
    description: 'How Operations Academia uses and protects the information obtained from those visiting and posting on the site.',
  },
  {
    file: 'terms-and-conditions.html', url: '/terms-and-conditions.html',
    title: 'Terms and Conditions — Operations Academia',
    ogTitle: 'Terms and Conditions',
    description: 'The terms and conditions governing the use of Operations Academia.',
  },

  /* The six sections that were absorbed into the one-pager on 2026-08-17.
     Each is `noindex` + a meta refresh, and its canonical is a FRAGMENT of the
     home page. Giving one an og:url would put a noindexed page back on the
     home page's Open Graph identity, which is the whole defect this file
     exists to prevent. They stay bare, deliberately. */
  { file: 'admin-area.html', card: false,
    why: "maintainer-only review desk (noindex) — a page nobody shares, and an og:url on it would claim an Open Graph identity for a page that answers only the admin" },
  { file: 'candidates.html', card: false, why: 'redirect stub → /#candidates' },
  { file: 'placements.html', card: false, why: 'redirect stub → /#placements' },
  { file: 'faqs.html', card: false, why: 'redirect stub → /#faq' },
  { file: 'contact.html', card: false, why: 'redirect stub → /#contact' },
  { file: 'directors-and-contributors.html', card: false, why: 'redirect stub → /#about' },
  { file: 'resources-for-candidates.html', card: false, why: 'redirect stub → /#resources' },
];

/* --------------------------------------------------------------- the pixels */

/* Both repositories avoid dependencies, so the image is measured by reading
   its own bytes. PNG states its size in the IHDR chunk, always at offset 16.
   JPEG hides it in whichever SOFn frame header comes first, which means
   walking the marker chain — and the walk has two traps: the standalone
   markers (SOI/EOI and the RSTn restarts) carry NO length field, so stepping
   over a length that is not there desynchronises everything after it; and
   0xC4 (Huffman tables), 0xC8 and 0xCC are numerically inside the SOFn range
   without being frame headers. */
export function pixels(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'image/png' };
  }
  if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i + 3 < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xFF) { i++; continue; }                       // fill byte
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (m === 0xD9 || m === 0xDA) break;                     // EOI, start of scan
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), type: 'image/jpeg' };
      }
      i += 2 + len;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- the check */

/* Run only as the entry point, so the PAGES table above can be imported —
   by the selftest, or by anything that writes the block into the pages —
   without the check running and calling process.exit. `pathToFileURL`, not a
   template string: compared as raw strings a path and a file URL differ the
   moment the path holds a space, and then main() is never called and the
   process exits 0 having checked nothing. The same guard, for the same
   reason, as build-jobs.mjs. */
export function main() {

  const problems = [];
  const notes = [];
  const bad = (file, msg) => problems.push(`${file}: ${msg}`);

  /* The <head>, with COMMENTS REMOVED. A commented-out tag is not a tag, and
     without this a page whose whole preview block had been commented out
     passed green — the block's own explanatory comment names og: properties
     in prose, so the readers below cannot simply be trusted to ignore them. */
  const head = (src) => {
    const i = src.toLowerCase().indexOf('</head>');
    return (i === -1 ? src : src.slice(0, i)).replace(/<!--[\s\S]*?-->/g, '');
  };

  /* An attribute is HTML, so `&` reaches the file as `&amp;`. A crawler decodes
   it before it renders the card and before it counts the characters, so the
   check has to as well — otherwise "Universities & schools" reads as five
   characters longer than it is and never matches the table. */
const decode = (s) => (s === null || s === undefined ? s : s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&amp;/g, '&'));

/* One attribute reader for both families, because the families differ in
     exactly the way that breaks them: og:* is RDFa and is addressed by
     `property`, twitter:* is a plain meta and is addressed by `name`. */
  function metas(src, attr) {
    const out = new Map();
    const re = new RegExp(`<meta\\s+[^>]*${attr}=["']([^"']+)["'][^>]*>`, 'gi');
    for (const m of src.matchAll(re)) {
      const content = /content=["']([^"']*)["']/i.exec(m[0]);
      const key = m[1].toLowerCase();
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(content ? decode(content[1]) : null);
    }
    return out;
  }

  function linkHref(src, rel) {
    const re = new RegExp(`<link\\s+[^>]*rel=["']${rel}["'][^>]*>`, 'i');
    const tag = re.exec(src);
    if (!tag) return null;
    const href = /href=["']([^"']*)["']/i.exec(tag[0]);
    return href ? decode(href[1]) : null;
  }

  /* Every file GitHub Pages actually publishes. Jekyll skips a name beginning
     with `_` or `.`, which is the whole reason `back up` was renamed `_backup`
     and the reason this walk can simply mirror that rule.

     AND THE RULE HAS A SWITCH. A `.nojekyll` file turns Jekyll off, and with
     it the underscore exclusion: every `_`-prefixed directory becomes public
     again, which would put fifty-one copies of this site back on the web, each
     declaring og:url = the home page. A walk that HARDCODES the rule would not
     see them and would go on reporting green over exactly the defect this file
     exists to prevent — so it READS the switch instead. With `.nojekyll`
     present, everything is walked. */
  const NO_JEKYLL = existsSync(path.join(ROOT, '.nojekyll'));

  function served(dir, rel = '', out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (e.name.startsWith('_') && !NO_JEKYLL) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) served(full, r, out);
      else if (e.name.endsWith('.html')) out.push(r);
    }
    return out;
  }

  const ALL = served(ROOT);
  const imageCache = new Map();

  function imageOf(url, file) {
    if (!url.startsWith(SITE + '/')) { bad(file, `og:image is not an absolute https URL on ${SITE}: ${url}`); return null; }
    const rel = url.slice(SITE.length + 1).split(/[?#]/)[0];
    if (imageCache.has(rel)) return imageCache.get(rel);
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) { bad(file, `og:image names a file this repository does not have: /${rel}`); imageCache.set(rel, null); return null; }
    const buf = readFileSync(abs);
    let px = null;
    try { px = pixels(buf); }
    catch { bad(file, `og:image /${rel} is truncated or malformed — its own header could not be read`); }
    const info = px ? { ...px, bytes: buf.length, rel } : null;
    if (!info) bad(file, `og:image is not a JPEG or a PNG: /${rel}`);
    imageCache.set(rel, info);
    return info;
  }

  /* 1. every root page is accounted for, in both directions */
  const listed = new Set(PAGES.map(p => p.file));
  for (const f of ALL) {
    if (f.includes('/')) continue;
    if (!listed.has(f)) bad(f, 'is served at the root and is not listed in PAGES — add it, with a card or a reason not to have one');
  }
  for (const p of PAGES) {
    if (!existsSync(path.join(ROOT, p.file))) bad(p.file, 'is listed in PAGES and does not exist');
  }

  /* 2. the per-page block */
  for (const p of PAGES) {
    const abs = path.join(ROOT, p.file);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    const h = head(src);
    const og = metas(h, 'property');
    const tw = metas(h, 'name');
    const item = metas(h, 'itemprop');

    /* charset first — a declaration past the first 1024 bytes, or after a tag
       that carries text, mangles an em-dash in the description */
    const firstTag = /<head[^>]*>\s*(<[^>]+>)/i.exec(src);
    if (!firstTag || !/^<meta\s+charset=/i.test(firstTag[1])) {
      bad(p.file, '<meta charset> is not the first element in <head>');
    }

    /* og:* addressed as name=, or twitter:* as property=, is invisible */
    for (const k of tw.keys()) if (k.startsWith('og:')) bad(p.file, `${k} is emitted with name= — Open Graph is RDFa and needs property=`);
    for (const k of og.keys()) if (k.startsWith('twitter:')) bad(p.file, `${k} is emitted with property= — Twitter cards need name=`);

    if (p.card === false) {
      if (og.size) bad(p.file, `is a ${p.why} and must carry no og:* tags — one would claim an Open Graph identity that belongs to another page`);
      continue;
    }

    /* the title the fallback chain lands on */
    const title = /<title>([\s\S]*?)<\/title>/i.exec(h);
    if (!title) bad(p.file, 'has no <title>');
    else if (p.title && decode(title[1].trim()) !== p.title) bad(p.file, `<title> is "${title[1].trim()}", PAGES says "${p.title}"`);

    const desc = (tw.get('description') || [])[0];
    if (!desc) bad(p.file, 'has no <meta name="description"> — the tag WeChat and Google read');
    else if (desc.length < 50 || desc.length > 300) bad(p.file, `description is ${desc.length} characters; keep it between 50 and 300`);
    else if (p.description && desc !== p.description) bad(p.file, 'description does not match PAGES');

    const canonical = linkHref(h, 'canonical');
    const want = SITE + (p.url === '/' ? '/' : p.url);
    if (canonical !== want) bad(p.file, `canonical is ${canonical}, expected ${want}`);

    for (const [key, expected] of [
      ['og:type', 'website'], ['og:site_name', 'Operations Academia'], ['og:locale', 'en_GB'],
    ]) {
      const v = (og.get(key) || [])[0];
      if (v !== expected) bad(p.file, `${key} is ${v === undefined ? 'missing' : `"${v}"`}, expected "${expected}"`);
    }

    const ogUrl = (og.get('og:url') || [])[0];
    if (ogUrl !== want) bad(p.file, `og:url is ${ogUrl}, expected ${want} — it must agree with the canonical`);

    const ogTitle = (og.get('og:title') || [])[0];
    if (!ogTitle) bad(p.file, 'has no og:title');
    else if (ogTitle.length > 90) bad(p.file, `og:title is ${ogTitle.length} characters; platforms truncate past about 90`);
    else if (p.ogTitle && ogTitle !== p.ogTitle) bad(p.file, 'og:title does not match PAGES');

    const ogDesc = (og.get('og:description') || [])[0];
    if (!ogDesc) bad(p.file, 'has no og:description');
    else if (ogDesc.length < 50 || ogDesc.length > 300) bad(p.file, `og:description is ${ogDesc.length} characters; keep it between 50 and 300`);

    /* EXACTLY one og:image. More is legal Open Graph and WhatsApp mishandles it. */
    const imgs = og.get('og:image') || [];
    if (imgs.length !== 1) bad(p.file, `declares ${imgs.length} og:image tags; WhatsApp needs exactly one`);
    const img = imgs[0];
    if (img) {
      const info = imageOf(img, p.file);
      if (info) {
        const w = Number((og.get('og:image:width') || [])[0]);
        const hh = Number((og.get('og:image:height') || [])[0]);
        if (w !== info.w || hh !== info.h) {
          bad(p.file, `declares og:image ${w}x${hh}; /${info.rel} is really ${info.w}x${info.h} — Meta lays the card out from the declared numbers before it downloads the file`);
        }
        const type = (og.get('og:image:type') || [])[0];
        if (type !== info.type) bad(p.file, `og:image:type is "${type}", the file is ${info.type}`);
        if (info.bytes > MAX_CARD_BYTES) {
          bad(p.file, `og:image is ${Math.round(info.bytes / 1024)} KB; WhatsApp silently drops a thumbnail over ${MAX_CARD_BYTES / 1024} KB`);
        }
        if ((og.get('og:image:secure_url') || [])[0] !== img) bad(p.file, 'og:image:secure_url does not repeat og:image');
        if ((og.get('og:image:alt') || [])[0] !== CARD_ALT) bad(p.file, 'og:image:alt must describe the CARD, not the page — see CARD_ALT');
      }
    }

    /* twitter:card is the one preview tag with no Open Graph equivalent: without
       it X can never render the large card, whatever og:image says */
    if ((tw.get('twitter:card') || [])[0] !== 'summary_large_image') bad(p.file, 'twitter:card is not summary_large_image');
    for (const k of ['twitter:title', 'twitter:description', 'twitter:image']) {
      if (!((tw.get(k) || [])[0] || '').trim()) bad(p.file, `has no ${k}`);
    }
    if ((tw.get('twitter:image:alt') || [])[0] !== CARD_ALT) bad(p.file, 'twitter:image:alt must describe the CARD, not the page — see CARD_ALT');
    if ((tw.get('twitter:image') || [])[0] !== img) bad(p.file, 'twitter:image does not name the wide card');

    /* the square, for the clients that crop to 1:1 */
    const squareUrl = SITE + SQUARE;
    if (linkHref(h, 'image_src') !== squareUrl) bad(p.file, `has no <link rel="image_src"> naming ${SQUARE}`);
    if ((item.get('image') || [])[0] !== squareUrl) bad(p.file, `has no <meta itemprop="image"> naming ${SQUARE}`);
    for (const k of ['name', 'description']) {
      if (!((item.get(k) || [])[0] || '').trim()) bad(p.file, `has no <meta itemprop="${k}">`);
    }
    const sq = imageOf(squareUrl, p.file);
    if (sq && sq.w !== sq.h) bad(p.file, `the image_src thumbnail is ${sq.w}x${sq.h}; the clients that read it centre-crop to 1:1, so it has to be square`);
    /* The square exists BECAUSE the wide card is the wrong shape and too heavy
       for a tile drawn at about 64 px. A heavy square has no purpose, and a
       small one is skipped outright by the clients it is for. */
    if (sq && sq.bytes > 100 * 1024) bad(p.file, `the square thumbnail is ${Math.round(sq.bytes / 1024)} KB; keep it under 100 KB`);
    if (sq && sq.w < 300) bad(p.file, `the square thumbnail is ${sq.w}px; the clients that read it skip anything under 300px`);

    /* Slackbot reads the first 32 KB; WhatsApp's parser gives up sooner. The
       block has to be above the stylesheets, the preconnects and the theme
       script, not merely somewhere in the head. */
    const at = src.indexOf('property="og:title"');
    const firstHeavy = Math.min(
      ...['<link rel="stylesheet"', '<link href="assets/', '<link rel="preconnect"', '<link rel="preload"', '<script']
        .map(s => { const i = src.indexOf(s); return i === -1 ? Infinity : i; })
    );
    if (at > firstHeavy) bad(p.file, 'the preview block sits after a stylesheet, preconnect or script — put it directly under the <title>');
    if (at > 4096) bad(p.file, `og:title is ${at} bytes into the document; keep the preview block inside the first 4 KB`);
  }

  /* 2b. THE SITEMAP NAMES THE SAME ADDRESS THE PAGE DOES.
         Pages serves /jobs and /jobs.html alike, so a sitemap listing one form
         while the canonical and og:url declare the other is not broken — it is
         two addresses for one page, which is exactly the split this file's
         main rule is about. Every listed URL must be a managed page's own. */
  const sitemapFile = path.join(ROOT, 'sitemap.xml');
  if (existsSync(sitemapFile)) {
    const listed = [...readFileSync(sitemapFile, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
    const own = new Set(PAGES.filter(p => p.card !== false).map(p => SITE + (p.url === '/' ? '/' : p.url)));
    for (const u of listed) {
      if (!own.has(u)) problems.push(`sitemap.xml lists "${u}", which is not the canonical address of any page carrying a card`);
    }
    for (const u of own) {
      if (!listed.includes(u)) notes.push(`sitemap.xml does not list ${u}`);
    }
  }

  /* 3. NO TWO SERVED FILES CLAIM ONE OPEN GRAPH IDENTITY.
        This is the rule the home page's card was lost to. */
  const claims = new Map();
  for (const f of ALL) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    const url = (metas(head(src), 'property').get('og:url') || [])[0];
    if (!url) continue;
    if (!claims.has(url)) claims.set(url, []);
    claims.get(url).push(f);
  }
  for (const [url, files] of claims) {
    if (files.length > 1) {
      problems.push(`${files.length} served files declare og:url "${url}" — ${files.join(', ')}. ` +
        'Facebook keys a preview on og:url, not on the address that was pasted, so whichever of these it scrapes last is the card everybody gets.');
    }
    if (!url.startsWith(SITE + '/') && url !== SITE + '/') {
      problems.push(`${files[0]} declares og:url "${url}", which is not an https URL on ${SITE}`);
    }
  }

  /* 3b. an ARCHIVED page's picture is checked too. /v2/ spent two days
         declaring `og:image` as `/images/OA_logo_1200x294.png` — a path, not
         a URL, which Open Graph requires and a crawler therefore ignores —
         and one of its pages named a file with no extension at all. The
         per-page loop above only reads the live PAGES table, so nothing saw
         it. Archives are read here instead: only that the URL is absolute,
         https, on this host, and names a file that exists. Their WORDS are
         the old site's and are none of this check's business. */
  for (const f of ALL) {
    if (!/^v\d+\//.test(f)) continue;
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    for (const [key, urls] of metas(head(src), 'property')) {
      if (key !== 'og:image' && key !== 'og:image:secure_url') continue;
      for (const u of urls) {
        if (!u) continue;
        if (!u.startsWith(SITE + '/')) { bad(f, `${key} is "${u}" — Open Graph needs a full absolute https URL, not a path`); continue; }
        if (!existsSync(path.join(ROOT, u.slice(SITE.length + 1).split(/[?#]/)[0]))) bad(f, `${key} names a file this repository does not have: ${u}`);
      }
    }
  }

  /* 4. an archived page names its OWN address. Rule 5 of archive-v2.mjs,
        generalised to every version tree — the rule /v1/ was missing. */
  for (const [url, files] of claims) {
    for (const f of files) {
      const tree = /^(v\d+)\//.exec(f);
      if (!tree) continue;
      const own = `${SITE}/${f}`;
      if (url !== own) {
        problems.push(`${f} is archived under /${tree[1]}/ and declares og:url "${url}" instead of "${own}" — ` +
          'an archive that calls itself the live page hands its noindex to the live page’s preview.');
      }
    }
  }

  /* ----------------------------------------------------------------- the word */

  if (VERBOSE) {
    const withCard = PAGES.filter(p => p.card !== false).length;
    notes.push(`${ALL.length} served pages walked; ${withCard} live pages carry a card, ` +
      `${PAGES.length - withCard} deliberately do not; ${claims.size} distinct og:url values.`);
    for (const [rel, info] of imageCache) {
      if (info) notes.push(`  ${rel} — ${info.w}x${info.h} ${info.type} ${Math.round(info.bytes / 1024)} KB`);
    }
    for (const n of notes) console.log(n);
  }

  if (problems.length) {
    for (const p of problems) console.log('::error::share-check: ' + p);
    console.log(`\nshare-check: ${problems.length} problem(s).`);
    process.exit(1);
  }
  console.log(`share-check: ${ALL.length} served pages, every card complete and no two claiming one address`);
}

/* realpathSync, because a symlinked entry point compares unequal and the check
   would exit 0 having checked nothing — the silent-pass failure mode this whole
   file is about. */
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
