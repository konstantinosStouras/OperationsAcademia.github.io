#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — archive the OLD site at /v1/, verbatim. [RETIRED:
   the 2026-08-16 cutover ran; v1/ exists and this script refuses to rewrite it.]

       node v2/_scraper/archive-v1.mjs            # write v1/ from the root pages
       node v2/_scraper/archive-v1.mjs --check    # fail if the archive drifted

   RUN BEFORE THE CUTOVER, NEVER AFTER. This reads the pages at the repository
   ROOT — which, until the cutover, are the old live site — and copies them
   into v1/ so the Awesome-Tables era stays reachable after the root is
   replaced. Run after the cutover it would "archive" the new site.
   cutover.mjs enforces the order by refusing to run while v1/ is absent.

   WHAT AN ARCHIVE IS. The pages are carried VERBATIM — Awesome Tables,
   Google Form links, Sheets iframes and all; that is the point of keeping
   them. Only what is needed for the pages to WORK from /v1/ changes:

     1. asset and image URLs are absolutised (they resolve against /v1/
        otherwise, where no assets live). /assets and /images stay at the
        root after the cutover, navigationMenu.js included, so everything
        the old pages load keeps existing;
     2. the shared footer include points at v1's OWN copy of the old footer
        (the root partial becomes the new site's at cutover, and its links
        would walk an archive reader into pages the archive does not have);
     3. the head gains `noindex` — the archive must not compete with the
        live pages in search — and a slim banner says where the reader is,
        with the way back. Everything else is byte-for-byte the old page;
     4. the page's canonical and `og:url` are re-pointed at its OWN /v1/
        address, and its `og:image` is absolutised. THIS RULE WAS MISSING
        UNTIL 2026-08-18 and it cost the live site its link preview. Left
        alone, all 17 archived pages went on declaring `og:url` = the home
        page — so eighteen served files, seventeen of them carrying
        `noindex,nofollow`, claimed one Open Graph identity, and a crawler
        that reached any of them attached a refusal to the address of the
        page people actually share. archive-v2.mjs' rule 5 says the same
        thing about /v2/ and was written on promotion day; nobody backported
        it two days. Because this script is retired (below), the committed
        archive was patched directly to what the rule produces — the rule
        lives here so a revival cannot lose it again.

   NONE OF THAT CONTRADICTS "verbatim". The promise is about the page's
   CONTENT — its tables, its forms, its prose. An address is not content: a
   copy that sits under /v1/ and still calls itself the root is not a faithful
   record, it is a broken one.

   The navigation menu needs NO rewrite: navigationMenu.js writes relative,
   extension-less hrefs ("jobs"), and GitHub Pages resolves /v1/jobs to
   /v1/jobs.html — the same mechanism the old site relied on at the root.
   (A plain static server does not do that; the archive is for Pages.)
   --------------------------------------------------------------------------- */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const V1 = path.join(ROOT, 'v1');

/* Every page of the old site. `jobs - Copy.html` is left behind on purpose —
   an unreferenced backup, not a page the site served. */
const PAGES = [
  'index', 'analytics', 'candidates', 'contact', 'directors-and-contributors',
  'faqs', 'informed_consent_statement', 'jobs', 'placements',
  'previous-markets', 'privacy-policy', 'recent-faculty',
  'resources-for-candidates', 'survey', 'survey-faqs',
  'terms-and-conditions', 'universities',
];

const BANNER = [
  '<div style="background:#313a45;color:#fff;font:14px/1.5 \'Source Sans Pro\',sans-serif;',
  'text-align:center;padding:9px 14px;position:relative;z-index:20000">',
  'This is the ARCHIVED previous version of Operations Academia, kept for reference. ',
  '<a href="/" style="color:#9cc7ee;text-decoration:underline">Go to the current site</a>.',
  '</div>',
].join('');

function sha(s) { return createHash('sha256').update(s).digest('hex').slice(0, 16); }

const SITE = 'https://www.operationsacademia.org';

export function archivePage(html, { source }) {
  let out = html.replace(/\r\n/g, '\n');
  const self = SITE + '/v1/' + path.basename(source);

  // 1. root-relative assets and images, wherever they are referenced
  out = out.replace(/(\b(?:href|src)\s*=\s*")(?!\/|[a-z][a-z0-9+.-]*:|\/\/|#)(assets\/|images\/)/gi,
    '$1/$2');

  // 2. v1's own footer partial
  out = out.replace(/(\bdata-include\s*=\s*")\/?partials\/footer\.html(")/g,
    '$1/v1/partials/footer.html$2');

  // 3. noindex + the banner
  if (!/name="robots"/i.test(out)) {
    out = out.replace(/(<link href="\/?assets\/css\/main\.css" rel="stylesheet">)/,
      '<meta name="robots" content="noindex,nofollow">\n    $1');
  }
  out = out.replace(/(<body[^>]*>)/i, '$1\n    ' + BANNER);

  // 4. the page's own address, not the root's, and an og:image a crawler on
  //    /v1/ can actually fetch (a relative one resolves to /v1/images/…)
  out = out
    .replace(/(<link rel="canonical" href=")[^"]*(")/i, `$1${self}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/i, `$1${self}$2`)
    .replace(/(<meta (?:property="og:image(?::secure_url)?"|name="twitter:image") content=")(?!https?:)([^"]*)(")/gi,
      (_m, a, v, z) => {
        let f = v.trim().replace(/^\/+/, '');
        // one page of the 2014 site wrote the filename with no extension at all
        if (!/\.(png|jpe?g|gif|webp)$/i.test(f)) f += '.png';
        if (!f.startsWith('images/')) f = 'images/' + f;
        return a + SITE + '/' + f + z;
      });

  return '<!DOCTYPE html>\n' +
    '<!-- ARCHIVED copy of ' + source + ' (source sha256:' + sha(html) + ') made by\n' +
    '     v2/_scraper/archive-v1.mjs at the 2026-08-16 cutover. The old site,\n' +
    '     verbatim. DO NOT EDIT: it is a historical record, not a page to fix. -->\n' +
    out.replace(/^<!DOCTYPE html>\s*\n/i, '');
}

export function archiveFooter(html) {
  // absolutise the same way; the old footer's page links are already rooted
  // ("/jobs"), which after the cutover reach the NEW site — the right place
  // for a reader who clicks on: the archive is a reference, not a maze.
  return html.replace(/\r\n/g, '\n');
}

function build() {
  const files = [];
  for (const slug of PAGES) {
    const src = path.join(ROOT, slug + '.html');
    if (!existsSync(src)) throw new Error('missing live page: ' + src);
    files.push({
      out: path.join(V1, slug + '.html'),
      body: archivePage(readFileSync(src, 'utf8'), { source: '/' + slug + '.html' }),
    });
  }
  files.push({
    out: path.join(V1, 'partials', 'footer.html'),
    body: archiveFooter(readFileSync(path.join(ROOT, 'partials', 'footer.html'), 'utf8')),
  });
  return files;
}

function main() {
  const check = process.argv.includes('--check');

  /* ONE-SHOT. Once the archive exists the root pages are (or are about to
     become) the NEW site, and re-running would overwrite the historical
     record with it — the exact opposite of this script's purpose. There is
     deliberately no --force: restoring a damaged archive is `git checkout`,
     not a re-run. */
  if (!check && existsSync(V1) && readdirSync(V1).length) {
    console.error('archive-v1: v1/ already exists — the archive is a one-shot ' +
      'historical record and is never regenerated. To repair it, use git.');
    process.exit(1);
  }

  const stale = [];
  for (const f of build()) {
    const cur = existsSync(f.out) ? readFileSync(f.out, 'utf8') : null;
    if (cur === f.body) continue;
    stale.push(path.relative(ROOT, f.out));
    if (!check) {
      mkdirSync(path.dirname(f.out), { recursive: true });
      writeFileSync(f.out, f.body);
    }
  }
  if (check) {
    if (stale.length) {
      console.error('archive-v1 --check: out of date:\n  ' + stale.join('\n  '));
      process.exit(1);
    }
    console.log('archive-v1: up to date');
    return;
  }
  console.log(stale.length
    ? 'archive-v1: wrote ' + stale.length + ' file(s)'
    : 'archive-v1: already up to date');
}

if (import.meta.url === 'file://' + process.argv[1]) main();
