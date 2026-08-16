#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — port the live site's pages into /v2/.

       node v2/_scraper/port-pages.mjs            # write v2/<page>.html
       node v2/_scraper/port-pages.mjs --check    # fail if any is out of date
       node v2/_scraper/port-pages.mjs --page faqs
       node v2/_scraper/port-pages.mjs --list

   WHY THIS IS A SCRIPT AND NOT SIXTEEN HAND EDITS
   -----------------------------------------------
   /v2/ can only replace the live site once EVERY page exists there and looks
   and behaves the same. Sixteen hand-ported pages drift: one keeps a relative
   asset path, another loses the account chip, a third links back out to the
   live site and quietly ends the preview. So the port is one deterministic,
   idempotent transform, re-runnable whenever a live page changes, and
   `--check` runs in CI so a change to a live page that has not been carried
   across fails the build instead of being noticed months later.

   WHAT IT CHANGES, AND NOTHING ELSE
   ---------------------------------
   The page body — its copy, its markup, its inline styles, its Google Form
   links, its Google Sheets iframes, its Awesome Table widgets — is carried
   across VERBATIM. Only the chrome moves:

     1. asset URLs are absolutised (`assets/…` -> `/assets/…`, `images/…` ->
        `/images/…`, including the `content=` of og:image), because a v2 page
        sits one directory down;
     2. `assets/js/navigationMenu.js` -> `assets/oa-nav.js`, the same menu with
        hrefs that resolve inside /v2/;
     3. internal page links point at their /v2/ counterpart — written relative
        (`href="contact"`) or as this site's own full URL
        (`href="https://www.operationsacademia.org/contact"`) — so the preview is
        a closed site: a reader can never fall out of it by clicking;
     4. the footer include points at v2's own copy of the partial (same markup,
        v2 links);
     5. the head gains `noindex` and `assets/oa-ui.css`;
     6. the header gains the Feedback button and the account chip that
        jobs.html, post-a-job.html, alerts.html and feedback.html already have;
     7. `assets/oa-firebase.js` + `assets/oa-accounts.js` load at the foot, so
        the account chip works;
     8. the Awesome Tables script tag is dropped from pages that carry NO
        Awesome Table widget. It is a leaf dependency — with no
        `data-type="AwesomeTableView"` element on the page it renders nothing —
        so this is invisible to a reader, and dropping the vendor is the point
        of the rebuild. Pages that DO carry a widget keep the script and the
        widget untouched.

   Every output file carries a provenance comment naming its source and the
   sha256 of that source; `--check` re-derives the file and compares, so an
   edit to either side is caught.
   --------------------------------------------------------------------------- */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');   // repository root
const V2 = path.join(ROOT, 'v2');

/* --------------------------------------------------------------- the pages */

/* Every live page, and where it lands under /v2/.

   `jobs` is absent on purpose: v2 has its OWN jobs.html, the rebuilt list that
   replaces the Awesome Table view. `jobs - Copy.html` is absent too — it is an
   unreferenced backup of an older jobs page (no link anywhere, not in
   sitemap.xml), so porting it would publish a page the live site does not
   serve. */
export const PAGES = [
  'index',
  'analytics',
  'candidates',
  'contact',
  'directors-and-contributors',
  'faqs',
  'informed_consent_statement',
  'placements',
  'previous-markets',
  'privacy-policy',
  'recent-faculty',
  'resources-for-candidates',
  'survey',
  'survey-faqs',
  'terms-and-conditions',
  'universities',
];

/* Pages v2 builds itself; a link to one of these must point at the v2 file
   rather than at a ported copy of a live page. */
const V2_OWN = {
  jobs: 'jobs.html',
  feedback: 'feedback.html',
};

/* Slugs the live pages link to, written every way they are written there:
   bare (`href="faqs"`), rooted (`href="/faqs"`) and with the extension.

   `informed-consent-statement` is in here with HYPHENS because survey-faqs.html
   links it that way while the file is `informed_consent_statement.html`. That
   link 404s on the live site. The port resolves it to the real page rather than
   carrying a broken link across. */
const LINK_ALIASES = {
  'informed-consent-statement': 'informed_consent_statement',
};

/* ------------------------------------------------------------- the transform */

const RX_ATTR = /(\b(?:href|src|data-include)\s*=\s*")([^"]*)(")/g;

/* A handful of the live pages hard-code their OWN origin instead of writing the
   link relative: faqs.html's "contact us", the opening sentence of
   privacy-policy.html and informed_consent_statement.html, and the footer's
   logo. Those are the only same-site links the transform used to leave alone,
   and inside /v2/ each one is an exit door — a reader evaluating the rebuild
   clicks it and is silently dropped back onto the site v2 replaces. Rewritten
   they are still correct after cutover, because the replacement is relative.

   ONLY inside an <a>. og:url and rel=canonical also name this origin, but they
   declare the page's identity to a crawler rather than offering a click, and a
   relative canonical would point the live site's SEO at /v2/. */
const RX_OWN_ORIGIN =
  /^https?:\/\/(?:www\.)?operationsacademia\.org(\/[^?#]*)?((?:[?#].*)?)$/i;

/** The tag an attribute at index `i` belongs to, lower-cased ('a', 'link', …). */
function tagAt(html, i) {
  const lt = html.lastIndexOf('<', i);
  if (lt === -1) return '';
  const m = /^<\s*([a-z][a-z0-9-]*)/i.exec(html.slice(lt, lt + 24));
  return m ? m[1].toLowerCase() : '';
}

/** Run RX_ATTR over a document, telling rewriteValue which tag it is in. */
function rewriteAttrs(html) {
  return html.replace(RX_ATTR, (m, pre, val, post, offset) =>
    pre + rewriteValue(val, tagAt(html, offset)) + post);
}

/** Every link target that resolves to a page of this site, mapped to its v2 path. */
function pageTarget(raw) {
  const [pathPart, ...rest] = raw.split(/(?=[?#])/);
  const tail = rest.join('');
  let slug = pathPart.replace(/^\/+/, '').replace(/\.html$/i, '');
  if (slug === '' || slug === 'index') return './' + tail;
  slug = LINK_ALIASES[slug] || slug;
  if (V2_OWN[slug]) return V2_OWN[slug] + tail;
  if (PAGES.includes(slug)) return slug + '.html' + tail;
  return null;
}

/** Rewrite one attribute value. Returns the value to emit. */
function rewriteValue(v, tag) {
  const t = v.trim();
  if (!t) return v;

  // a link the reader can click that names this site by its full URL
  const own = tag === 'a' && RX_OWN_ORIGIN.exec(t);
  if (own) {
    const page = pageTarget((own[1] || '/') + (own[2] || ''));
    return page === null ? v : page;   // e.g. /images/… is not a page: leave it
  }

  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(t)) return v;   // absolute, protocol-relative, anchor

  // the shared footer partial: v2 keeps its own copy, with v2 links
  if (t === '/partials/footer.html' || t === 'partials/footer.html') return 'partials/footer.html';

  // the site's own scripts and stylesheets live at the repository root
  if (/^\/?assets\//.test(t)) {
    const abs = '/' + t.replace(/^\/+/, '');
    // the navigation menu is the one asset v2 replaces
    if (abs === '/assets/js/navigationMenu.js') return 'assets/oa-nav.js';
    return abs;
  }
  if (/^\/?images\//.test(t)) return '/' + t.replace(/^\/+/, '');

  const page = pageTarget(t);
  return page === null ? v : page;
}

const AT_SCRIPT =
  /[ \t]*<script src="https:\/\/awesome-table\.com\/AwesomeTableInclude\.js">\s*<\/script>[ \t]*\n?/g;

const HEADNAV = [
  '',
  '          <div id="oa-headnav">',
  '            <a class="oa-headbtn" href="feedback.html">',
  '              <span aria-hidden="true">&#128172;</span> Feedback</a>',
  '            <div id="oa-account"></div>',
  '          </div>',
].join('\n');

const V2_SCRIPTS = [
  '',
  '    <!-- v2: the account chip in the header. Inert until a Firebase project',
  '         is configured, exactly as on the rebuilt pages. -->',
  '    <script src="assets/oa-firebase.js"></script>',
  '    <script src="assets/oa-accounts.js"></script>',
].join('\n');

function sha256(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * Port one live page's HTML into its /v2/ form.
 * Pure: same input, same output. Exported so the selftest can drive it.
 */
export function portPage(html, { source }) {
  /* Line endings are normalised to LF FIRST, and the provenance hash is taken
     of the normalised source. The live pages were committed with CRLF; `*
     text=auto` in .gitattributes normalises anything added since to LF. So the
     bytes a checkout hands this script differ from the bytes it would write,
     and `--check` would fail on a fresh clone while passing on the machine that
     ran the port. Normalising both sides makes the transform depend on the
     page, not on how git happened to check it out. HTML does not care. */
  html = html.replace(/\r\n/g, '\n');
  let out = html;

  // 1. every href/src/data-include
  out = rewriteAttrs(out);

  /* 1b. the Open Graph image, which is rule 1's `images/… -> /images/…` again
     but lives in `content=` and so was missed. A scraper resolves a relative
     og:image against the page URL, so from /v2/<page>.html the live pages'
     `images/OA_logo_1200x294.png` names /v2/images/…, and there is no v2/images
     directory at all: a v2 link pasted into Slack or LinkedIn unfurls with no
     card image where the live link unfurls with the logo. The rooted form is
     what v2's own jobs.html already writes, and it survives cutover unchanged.
     terms-and-conditions.html's `content="OA_logo_1200x294"` (no directory, no
     extension) is broken on the live page too and is deliberately NOT matched:
     the port carries the live page across, it does not improve it. */
  out = out.replace(
    /(<meta\s+property="og:image(?::secure_url)?"\s+content=")(images\/[^"]*)(")/gi,
    (m, pre, val, post) => pre + '/' + val + post);

  // 2. the vendor script, on pages with no vendor widget
  const hasWidget = /data-type\s*=\s*"AwesomeTableView"/i.test(
    // a commented-out widget (placements.html) is not a widget
    out.replace(/<!--[\s\S]*?-->/g, ''));
  if (!hasWidget) out = out.replace(AT_SCRIPT, '');

  // 3. head: noindex + v2's own stylesheet, right after the site stylesheet
  if (!/name="robots"/i.test(out)) {
    out = out.replace(/(<link href="\/assets\/css\/main\.css" rel="stylesheet">)/,
      '<meta name="robots" content="noindex,nofollow">\n    $1');
  }
  if (!/assets\/oa-ui\.css/.test(out)) {
    out = out.replace(/(<link href="\/assets\/css\/main\.css" rel="stylesheet">)/,
      '$1\n    <link href="assets/oa-ui.css" rel="stylesheet">');
  }

  // 4. Google Forms are not part of the new site (owner, 2026-08-16). The
  //    live pages' call-to-action buttons ("Create your Job Market Profile!",
  //    "Post a Placement!", "Add a junior faculty!") all point at
  //    docs.google.com/forms; each rebuilt dataset brings its own form, the
  //    way post-a-job.html replaced the jobs one. Until then the ported page
  //    simply carries no submission button — an absent feature reads better
  //    than a link into the machinery this rebuild exists to retire. The
  //    <a> element is removed whole; the centred wrapper div it sat in stays,
  //    which renders as nothing.
  out = out.replace(/<a\b[^>]*docs\.google\.com\/forms[^>]*>[\s\S]*?<\/a>/gi, '');

  // 4b. header: the Feedback button and the account chip
  if (!/id="oa-headnav"/.test(out)) {
    out = out.replace(/(<nav id="nav">\s*<\/nav>)/, '$1\n' + HEADNAV);
  }

  // 5. foot: the scripts the account chip needs
  if (!/oa-accounts\.js/.test(out)) {
    out = out.replace(/(\n\s*<\/body>)/, V2_SCRIPTS + '$1');
  }

  // 6. provenance
  const banner =
    '<!-- Ported from ' + source + ' (source sha256:' + sha256(html) + ') by\n' +
    '     v2/_scraper/port-pages.mjs. DO NOT EDIT BY HAND: re-run the script.\n' +
    '     The page body is the live page verbatim; only the chrome is v2\'s. -->\n';
  out = out.replace(/^(<!DOCTYPE html>\s*\n)/i, '$1' + banner);

  return out;
}

/* --------------------------------------------------------------- the footer */

/** The shared footer, with its links pointing inside /v2/. */
export function portFooter(html) {
  html = html.replace(/\r\n/g, '\n');   // see portPage
  let out = rewriteAttrs(html);

  /* The live footer's "Feedback" goes to UserVoice, a service the site no
     longer runs. v2 has its own feedback page — the one the header button and
     the navigation menu already point at — so the footer points there too. */
  out = out.replace(
    /<a class="box-no-padding" href="https:\/\/operationsacademia\.uservoice\.com\/"[^>]*>Feedback<\/a>/,
    '<a class="box-no-padding" href="feedback.html" ' +
    'onclick="ga(\'send\',\'pageview\',\'feedbackFooterWasClicked\');">Feedback</a>');

  return '<!-- Ported from partials/footer.html (source sha256:' + sha256(html) + ') by\n' +
    '     v2/_scraper/port-pages.mjs. DO NOT EDIT BY HAND: re-run the script. -->\n' + out;
}

/* ------------------------------------------------------------------- driver */

function build() {
  const files = [];

  for (const slug of PAGES) {
    const src = path.join(ROOT, slug + '.html');
    if (!existsSync(src)) throw new Error('missing live page: ' + src);
    files.push({
      out: path.join(V2, slug + '.html'),
      body: portPage(readFileSync(src, 'utf8'), { source: '/' + slug + '.html' }),
      label: 'v2/' + slug + '.html',
    });
  }

  const footSrc = path.join(ROOT, 'partials', 'footer.html');
  files.push({
    out: path.join(V2, 'partials', 'footer.html'),
    body: portFooter(readFileSync(footSrc, 'utf8')),
    label: 'v2/partials/footer.html',
  });

  return files;
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const only = argv.includes('--page') ? argv[argv.indexOf('--page') + 1] : null;

  if (argv.includes('--list')) {
    for (const s of PAGES) console.log(s);
    return;
  }

  let files = build();
  if (only) files = files.filter((f) => f.label.includes(only));
  if (!files.length) { console.error('no such page: ' + only); process.exit(2); }

  const stale = [];
  for (const f of files) {
    const cur = existsSync(f.out) ? readFileSync(f.out, 'utf8') : null;
    if (cur === f.body) continue;
    stale.push(f.label);
    if (!check) {
      mkdirSync(path.dirname(f.out), { recursive: true });
      writeFileSync(f.out, f.body);
    }
  }

  if (check) {
    if (stale.length) {
      console.error('port-pages --check: out of date:\n  ' + stale.join('\n  '));
      console.error('\nrun: node v2/_scraper/port-pages.mjs');
      process.exit(1);
    }
    console.log('port-pages: ' + files.length + ' files are up to date');
    return;
  }

  console.log(stale.length
    ? 'port-pages: wrote ' + stale.length + ' file(s):\n  ' + stale.join('\n  ')
    : 'port-pages: ' + files.length + ' files already up to date');
}

if (import.meta.url === 'file://' + process.argv[1]) main();
