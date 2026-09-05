#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia: the browser modules the Cloud Functions also need,
   COPIED into _functions/ so a deploy can carry them.

       node _scraper/build-functions-vendor.mjs [--dry-run] [--check] [--selftest]

   `firebase deploy` ships only the _functions directory: a function cannot
   require ../assets after deploy. Four dual-mode modules are read on both
   sides of the forum, and each has ONE definition under assets/:

     assets/oa-jobnav.js        -> _functions/jobnav.js        the season (marketYear)
     assets/oa-forum-model.js   -> _functions/forum-model.js  rooms, keys, bounds, tags
     assets/oa-forum-guard.js   -> _functions/forum-guard.js  what a post may not contain
     assets/oa-forum-guide.js   -> _functions/forum-guide.js  the guide the seed op posts

   The copies are GENERATED, never edited: this builder writes them, the
   selftest pins each pair byte-for-byte (a drifted copy would have the
   functions refusing text the page allows, or deriving a season the page does
   not), and `--check` exits 1 on any drift so a CI step can hold the line.
   It sits in BUILDERS after build-netmap.mjs, offline and ungated, so every
   run of the jobs build re-copies whatever changed; an unchanged module
   commits nothing (`writeIfChanged`, the build-netmap.mjs shape).
   --------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMain } from './_main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** source (under assets/) -> vendored copy (under _functions/). The selftest
    reads this table, so a pair added here is pinned without a second list. */
export const PAIRS = [
  ['assets/oa-jobnav.js', '_functions/jobnav.js'],
  ['assets/oa-forum-model.js', '_functions/forum-model.js'],
  ['assets/oa-forum-guard.js', '_functions/forum-guard.js'],
  ['assets/oa-forum-guide.js', '_functions/forum-guide.js'],
];

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');

const log = (...a) => console.log(...a);

async function writeIfChanged(file, body, label) {
  const before = existsSync(file) ? await readFile(file, 'utf8') : '';
  if (before === body) return false;
  if (DRY) { log(`--dry-run: would write ${label}`); return true; }
  await writeFile(file, body);
  log(`wrote ${label}`);
  return true;
}

/** Which pairs differ right now. Pure over the filesystem; the selftest and
    `--check` both ask it. */
export async function drift(root = ROOT) {
  const out = [];
  for (const [src, vendored] of PAIRS) {
    const a = await readFile(path.join(root, src), 'utf8');
    const b = existsSync(path.join(root, vendored)) ? await readFile(path.join(root, vendored), 'utf8') : null;
    if (a !== b) out.push(vendored);
  }
  return out;
}

async function main() {
  if (argv.has('--selftest')) process.exit(selftest() ? 0 : 1);
  if (argv.has('--check')) {
    const d = await drift();
    if (d.length) {
      console.log(`::error::vendored copies out of date: ${d.join(', ')} (run node _scraper/build-functions-vendor.mjs)`);
      return 1;
    }
    log('every vendored module matches its source');
    return 0;
  }
  let n = 0;
  for (const [src, vendored] of PAIRS) {
    if (await writeIfChanged(path.join(ROOT, vendored), await readFile(path.join(ROOT, src), 'utf8'), vendored)) n++;
  }
  log(`${n} vendored module(s) ${DRY ? 'would change' : 'written'}, ${PAIRS.length - n} unchanged`);
  return 0;
}

/* ------------------------------------------------------------------ selftest */

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, m) => { if (c) pass++; else fails.push(m); };
  ok(PAIRS.length === 4, 'four pairs');
  ok(PAIRS.every(([s, v]) => s.startsWith('assets/oa-') && v.startsWith('_functions/') && !v.includes('/forum/')),
    'every pair copies an assets module to the top of _functions/, never into the forum directory the functions own');
  ok(new Set(PAIRS.map((p) => p[1])).size === PAIRS.length, 'no two sources land on one copy');
  for (const f of fails) console.log('  FAIL', f);
  console.log(`build-functions-vendor selftest: ${pass} passed, ${fails.length} failed`);
  return !fails.length;
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
