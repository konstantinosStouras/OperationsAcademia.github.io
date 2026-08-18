#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — keep the /v2/ archive honest.

       node _scraper/archive-v2.mjs           # apply the archive rules
       node _scraper/archive-v2.mjs --check   # fail if any of them slipped

   WHAT /v2/ IS. The design the site served between the 2026-08-16 cutover and
   the 2026-08-17 swap: the vendor-free rebuild, multi-page, blue chrome. It was
   promoted to the root on 16 August and archived here on 17 August when the
   single-page redesign took the root. The pages are the LIVE ones, moved with
   `git mv` — history intact — not copies, so this script does not create the
   archive the way archive-v1.mjs created /v1/. It only enforces the four rules
   an archive under a sub-directory has to keep:

     1. `noindex,nofollow` — an archive must never compete in search with the
        page that replaced it. (/v1/ carries the same tag for the same reason.)
     2. A banner saying where the reader is, with the way back to the root.
     3. Shared, root-served things stay ABSOLUTE: /data, /changelog.json,
        /assets/leaflet, /assets/css, /assets/js, /images. The pages moved down
        one directory, so a relative `data/jobs.json` would ask for
        /v2/data/jobs.json and 404 — the list would render its "could not be
        loaded" state and nothing would say why.
        AN og:image IS THE SAME PROBLEM WITH NO SYMPTOM. Open Graph requires a
        FULL absolute URL; a crawler given `/images/OA_logo_1200x294.png` — a
        path, not a URL — ignores it, and the card comes out without a picture
        while the page itself looks perfectly healthy. Fifteen of these pages
        carried exactly that, and one carried `OA_logo_1200x294` with no
        directory and no extension at all, inherited from the 2014 site. So
        og:image, og:image:secure_url and twitter:image are given the site's
        own origin here, the same as /v1/ was on 2026-08-18.
     4. The archive's OWN chrome stays relative: v2/assets/oa-*.js|css are this
        design's copies, deliberately frozen at what it shipped with, so the
        root is free to move on. Its page-to-page links stay relative too, so a
        reader who walks the archive stays in it.
     5. No page still CLAIMS to be the root. These pages were the root until
        17 August, so their canonical and og:url said so; left alone, an
        archived copy would tell every crawler and every link preview that it
        is the live home page. Both are re-pointed at the page's own /v2/ URL.

   Rule 3 applies to v2/assets/*.js as well: those scripts run from /v2/assets/,
   so their own fetches must name the shared files absolutely.
   --------------------------------------------------------------------------- */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V2 = path.join(ROOT, 'v2');

const CHECK = process.argv.includes('--check');

const SITE = 'https://www.operationsacademia.org';

const NOINDEX = '<meta name="robots" content="noindex,nofollow">';

const BANNER = [
  '<div style="background:#313a45;color:#fff;font:14px/1.5 \'Source Sans Pro\',sans-serif;',
  'text-align:center;padding:9px 14px;position:relative;z-index:20000">',
  'This is the ARCHIVED 2026 version of Operations Academia, kept for reference. ',
  '<a href="/" style="color:#9cc7ee;text-decoration:underline">Go to the current site</a>.',
  '</div>',
].join('');

/* The files that live at the ROOT and are shared by every version of the site.
   Anything under these names must be reached absolutely from /v2/. */
const SHARED = [
  [/(['"])data\//g, '$1/data/'],
  [/(['"])changelog\.json/g, '$1/changelog.json'],
  [/(["'])assets\/leaflet\//g, '$1/assets/leaflet/'],
];

const problems = [];
let changed = 0;

/* partials/ holds FRAGMENTS the pages include, not pages: no <head> to carry a
   robots tag and no <body> to head with a banner. Rule 3 still applies. */
function patchFragment(file, src) {
  return patchJs(file, src);
}

function patchHtml(file, src) {
  let out = src;

  // 1. noindex, right after the charset declaration the pages all carry
  if (out.indexOf('name="robots"') === -1) {
    out = out.replace(/(<meta charset="utf-8">)/i, `$1\n    ${NOINDEX}`);
    if (out.indexOf('name="robots"') === -1) problems.push(`${file}: no <meta charset> to anchor the noindex tag to`);
  }

  // 2. the banner, first thing inside <body>
  if (out.indexOf('ARCHIVED 2026 version') === -1) {
    out = out.replace(/(<body[^>]*>)/i, `$1\n    ${BANNER}`);
    if (out.indexOf('ARCHIVED 2026 version') === -1) problems.push(`${file}: no <body> to anchor the banner to`);
  }

  // 3. shared, root-served things
  for (const [re, to] of SHARED) out = out.replace(re, to);

  // 3b. an og:image is a URL, not a path (see rule 3 above)
  out = out.replace(
    /(<meta (?:property="og:image(?::secure_url)?"|name="twitter:image") content=")(?!https?:)([^"]*)(")/gi,
    (_m, a, v, z) => {
      let f = v.trim().replace(/^\/+/, '');
      if (!/\.(png|jpe?g|gif|webp)$/i.test(f)) f += '.png';   // the extensionless one
      if (!f.startsWith('images/')) f = 'images/' + f;
      return a + SITE + '/' + f + z;
    });

  // 5. the page's own address, not the root's
  const self = SITE + '/v2/' + path.basename(file);
  out = out
    .replace(/(<link rel="canonical" href=")[^"]*(")/i, `$1${self}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/i, `$1${self}$2`);

  return out;
}

function patchJs(file, src) {
  let out = src;
  for (const [re, to] of SHARED) out = out.replace(re, to);
  return out;
}

function walk(dir, fn) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walk(full, fn);
    else fn(full);
  }
}

walk(V2, (full) => {
  const rel = path.relative(ROOT, full);
  const ext = path.extname(full);
  if (ext !== '.html' && ext !== '.js') return;
  const src = readFileSync(full, 'utf8');
  const fragment = rel.split(path.sep).indexOf('partials') !== -1;
  /* A redirect stub is not a page a reader ever sees — it carries the reader
     somewhere else in the same tick. Banner and robots tag would both be
     addressed to nobody, and the stub says where it is going in its own head. */
  const stub = /http-equiv="refresh"/i.test(src);
  const out = ext !== '.html' ? patchJs(rel, src)
    : (fragment || stub) ? patchFragment(rel, src)
      : patchHtml(rel, src);
  if (out === src) return;
  changed++;
  if (CHECK) problems.push(`${rel}: archive rules not applied (run without --check)`);
  else writeFileSync(full, out);
});

if (problems.length) {
  console.error('archive-v2: FAILED\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(CHECK
  ? 'archive-v2: /v2/ holds to the archive rules'
  : `archive-v2: ${changed} file(s) brought in line`);
