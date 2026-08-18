#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — every internal link resolves, and no version of the
   site reaches into another one.

       node _scraper/link-check.mjs
       node _scraper/link-check.mjs --verbose

   WHY THIS EXISTS. The site is served as three trees at once: the live design
   at the root, the 2026 rebuild archived at /v2/, and the 2014-2026 site at
   /v1/. Each was, at some point, the root — so each is full of links that were
   written when its pages WERE the root pages. Promote a tree without sweeping
   them and the result is the failure this check is named for: a reader clicks
   "Universities" on the live site and lands on a page in the old design, with
   the old chrome, reading the old data — a page belonging to a version they
   were never meant to see. Nothing 404s, so nothing looks broken; the site
   just quietly becomes two sites.

   So there are two rules, and the second is the one a cutover breaks.

   1. EVERY internal href/src/data-include resolves to a file that exists.
      Extension-less links are allowed: GitHub Pages serves /jobs from
      jobs.html, which the old design's nav relied on and /v1/ still does.

   2. NO TREE NAVIGATES INTO ANOTHER TREE, except deliberately:
        - the live site may offer the archives, at their FRONT DOORS only
          (/v1/, /v2/) — that is what an archive is for. It may never link to
          an archived inner page: that is the failure above.
        - an archived page may point at the live site, which is how a reader
          who lands on one gets out. Every archived page carries a banner
          saying so, so this is signposted rather than silent.
        - an archive may never reach into ANOTHER archive.
      The shared substrate is not navigation and is exempt: /assets, /images,
      /data and /changelog.json are written once at the root and read by every
      version on purpose — that is the whole reason an archive keeps working.

   A fragment link is checked too when its target page is known: #candidates
   has to be an id that exists, or a nav keyword silently scrolls nowhere.
   --------------------------------------------------------------------------- */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

/* Trees that are versions of the site. Anything not under one of these is the
   live site at the root. */
const VERSIONS = ['v1', 'v2', 'v3'];

/* The only pages of a version tree the live site may link to. */
const ARCHIVE_DOORS = new Set(['/v1/', '/v1/index.html', '/v2/', '/v2/index.html',
  '/v3/', '/v3/index.html']);

/* Written once at the root, read by every version on purpose. Not navigation:
   nobody "lands" on a stylesheet. */
const SHARED = /^(assets|images|data)\/|^changelog\.json$|^(robots\.txt|sitemap\.xml|CNAME)$/;

/* Links that are BROKEN and stay broken, because fixing them would falsify an
   archive. /v1/ is a verbatim, sha256-stamped copy of the 2014-2026 site, and
   that site's own survey FAQ pointed at "informed-consent-statement" while the
   file it shipped was informed_consent_statement.html. The rebuild fixed it;
   the archive records what was actually served. `<page>|<href>`. */
const FROZEN_BREAKAGE = new Set([
  'v1/survey-faqs.html|informed-consent-statement',
]);

/* Directories with nothing served in them. `_backup` is exactly what it says —
   and it is spelled with the leading underscore for a reason. It was `back up`,
   which Jekyll happily published, so GitHub Pages was serving 51 old copies of
   this site's pages to anyone who asked for them: not linked from anywhere, not
   noindexed, and every one of them declaring `og:url` = the home page. This
   check believed the directory was unserved, which is what let that sit. A
   leading underscore makes the belief true, the same way it does for
   `_scraper` and `_functions` below.

   Every DOT-directory is skipped by the walk below rather than named here:
   `.git` was, and the same reasoning covers whatever tooling puts beside it.
   A review run checks its agents out into `.claude/worktrees/`, which is a
   copy of this whole repository INSIDE it — descending into one made this
   check report the archive's own pages as live-site failures. Nothing served
   by GitHub Pages lives under a leading dot. */
const SKIP_DIRS = new Set(['node_modules', '_backup', '_functions', '_scraper']);

const problems = [];
let links = 0;
let pages = 0;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.charAt(0) === '.' || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.html')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** Which tree a repo-relative path belongs to: 'v1' | 'v2' | 'v3' | '' (live). */
function treeOf(rel) {
  const first = rel.split('/')[0];
  return VERSIONS.includes(first) ? first : '';
}

/** Does this repo-relative path exist, allowing Pages' extension-less serving? */
function resolves(rel) {
  const full = path.join(ROOT, rel);
  if (existsSync(full)) {
    return statSync(full).isDirectory() ? existsSync(path.join(full, 'index.html')) : true;
  }
  return existsSync(full + '.html');
}

/** The file an internal link lands on, or '' when it is not a page we hold. */
function pageFor(rel) {
  const full = path.join(ROOT, rel);
  if (existsSync(full) && statSync(full).isDirectory()) return path.join(rel, 'index.html');
  if (existsSync(full)) return rel;
  if (existsSync(full + '.html')) return rel + '.html';
  return '';
}

const idCache = new Map();
function idsOf(rel) {
  if (!idCache.has(rel)) {
    let ids = new Set();
    try {
      const src = readFileSync(path.join(ROOT, rel), 'utf8');
      for (const m of src.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
      for (const m of src.matchAll(/\sname="([^"]+)"/g)) ids.add(m[1]);
    } catch { /* unreadable — treated as "no ids", reported by the caller */ }
    idCache.set(rel, ids);
  }
  return idCache.get(rel);
}

const ATTR = /\s(?:href|src|data-include)="([^"]*)"/g;

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const tree = treeOf(rel);
  /* A file under partials/ is a FRAGMENT: it is never fetched as a page, it is
     spliced into a page one directory up, and the browser resolves its
     relative links against THAT page's URL. Resolving them against the
     fragment's own directory would report every one of them as missing. */
  const dir = path.posix.dirname(/(^|\/)partials\//.test(rel) ? path.posix.dirname(rel) : rel);
  const src = readFileSync(file, 'utf8');
  pages++;

  for (const m of src.matchAll(ATTR)) {
    const raw = m[1].trim();
    if (!raw) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;   // external / data: / mailto:
    /* An href ASSEMBLED at runtime — a page that renders cards writes
       `href="' + esc(u) + '"` inside a script. There is no static target to
       resolve; those links are covered by the browser tests instead. */
    if (/[+{}$<>]|\s\+|'|`/.test(raw)) continue;
    if (FROZEN_BREAKAGE.has(`${rel}|${raw}`)) continue;
    links++;

    const [pathPart, frag] = raw.split('#');

    // a bare "#id" points into the page it is written on
    let target = rel;
    if (pathPart) {
      const clean = pathPart.split('?')[0];
      const abs = clean.startsWith('/')
        ? clean.slice(1)
        : path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, clean));
      if (abs.startsWith('..')) { problems.push(`${rel}: "${raw}" escapes the repository`); continue; }

      if (!resolves(abs)) { problems.push(`${rel}: "${raw}" → ${abs || '/'} does not exist`); continue; }

      // rule 2 — tree boundaries (navigation only; the shared substrate is not)
      const targetTree = treeOf(abs);
      if (targetTree !== tree && !SHARED.test(abs)) {
        const door = '/' + abs.replace(/index\.html$/, '');
        const allowed = tree === ''
          // the live site may open an archive's front door, nothing deeper
          ? ARCHIVE_DOORS.has(door) || ARCHIVE_DOORS.has('/' + abs)
          // an archive may point back at the live site, and only there
          : targetTree === '';
        if (!allowed) {
          problems.push(`${rel}: "${raw}" reaches into ${targetTree ? '/' + targetTree + '/' : 'the live site'}`
            + ` — a reader would land in a different version of the site`);
          continue;
        }
      }
      target = pageFor(abs);
    }

    if (frag && target && target.endsWith('.html')) {
      if (frag !== 'top' && !idsOf(target).has(frag)) {
        problems.push(`${rel}: "${raw}" → #${frag} is not an id on ${target}`);
      }
    }
  }
}

/* A version tree must stay out of search results; the live site must not. */
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const src = readFileSync(file, 'utf8');
  const noindex = /name="robots"[^>]*noindex/i.test(src);
  const stub = /http-equiv="refresh"/i.test(src);
  if (treeOf(rel) && !noindex && !/partials\//.test(rel)) {
    problems.push(`${rel}: an archived page must carry noindex or it competes with the live one`);
  }
  if (!treeOf(rel) && noindex && !stub) {
    problems.push(`${rel}: a live page must NOT carry noindex`);
  }
}

if (VERBOSE) console.log(`link-check: ${links} internal links across ${pages} pages`);
if (problems.length) {
  console.error(`link-check: ${problems.length} problem(s)\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`link-check: ${links} internal links across ${pages} pages, all sound`);
