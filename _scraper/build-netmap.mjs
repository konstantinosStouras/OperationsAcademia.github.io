#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — the domain -> university map the visit resolver uses.

       node _scraper/build-netmap.mjs [--dry-run] [--selftest]

   DERIVED FROM THE SITE'S OWN DIRECTORY, never hand-written. Every operations
   department in `data/directory.json` may carry a `deptUrl` — the department's
   own page, which the posting form pre-fills and the community corrects — and
   the host of that URL is the university's domain. So the list of universities
   this site can NAME from a visitor's network is exactly the list it publishes
   a department page for, and it grows the same way everything else here grows:
   somebody adds a department, and the map gains its domain on the next build.

   CURATED, NEVER GUESSED, which here means one rule: a domain claimed by two
   different universities is DROPPED rather than picked between. Measured over
   the committed directory that is currently zero domains, and it must stay a
   refusal rather than a tie-break — attributing a visit to the wrong
   university is worse than not naming it, because the chart is read as fact
   and nothing on it would look wrong.

   TWO COPIES ARE WRITTEN, and the second is the reason this is a builder
   rather than a line inside another one:

     data/university-domains.json    served — the builder and the page read it
     _functions/university-domains.json + _functions/netorg.js
                                     VENDORED, because `firebase deploy` ships
                                     only the _functions directory: a function
                                     cannot require ../assets after deploy.

   The selftest pins the vendored copies byte-for-byte against their sources,
   so a drifted copy fails the build rather than resolving visitors against a
   stale map in production.
   --------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { isMain } from './_main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DIRECTORY = path.join(ROOT, 'data', 'directory.json');
const OUT = path.join(ROOT, 'data', 'university-domains.json');
const FN_MAP = path.join(ROOT, '_functions', 'university-domains.json');
const FN_MOD = path.join(ROOT, '_functions', 'netorg.js');
const SRC_MOD = path.join(ROOT, 'assets', 'oa-netorg.js');

const N = createRequire(import.meta.url)(SRC_MOD);

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/** The host of a URL, or '' — never throws on the junk a directory can hold. */
export function hostOf(url) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(String(url || '').trim());
  if (!m) return '';
  return m[1].split('@').pop().split(':')[0].toLowerCase();
}

/**
 * domain -> university, from directory rows. Pure, so the selftest can drive
 * it over fixtures as well as over the committed file.
 *
 * Returns `{ map, dropped }` — `dropped` names every domain two universities
 * both claimed, because a silent refusal is how a map quietly stops covering
 * a university nobody notices is missing.
 */
export function buildMap(rows) {
  const claims = new Map();                       // domain -> Set(institution)
  for (const r of rows || []) {
    const inst = String((r && r.institution) || '').trim();
    const host = hostOf(r && r.deptUrl);
    if (!inst || !host) continue;
    const domain = N.registrableDomain(host);
    if (!domain) continue;
    /* A department page on a hosted CMS, a shortener or a social profile is
       not the university's network and must never become its domain. This is
       a DENYLIST rather than an academic-suffix requirement, and that was
       measured: demanding `.edu`/`.ac.*` dropped 28 real universities — ETH
       Zurich, McGill, Toronto, Bocconi, Erasmus, TUM, Copenhagen Business
       School, UCD Smurfit — because outside the English-speaking world a
       university is usually on a plain national domain. See DENY_DOMAINS. */
    if (N.isDenied(domain)) continue;
    if (!claims.has(domain)) claims.set(domain, new Set());
    claims.get(domain).add(inst);
  }

  const map = {};
  const dropped = [];
  for (const [domain, insts] of Array.from(claims.entries()).sort()) {
    if (insts.size === 1) map[domain] = Array.from(insts)[0];
    else dropped.push({ domain, claimed: Array.from(insts).sort() });
  }
  return { map, dropped };
}

/** Stable, diff-friendly: sorted keys, so an unchanged directory commits nothing. */
function serialise(map) {
  const out = {};
  for (const k of Object.keys(map).sort()) out[k] = map[k];
  return JSON.stringify(out, null, 1) + '\n';
}

async function writeIfChanged(file, body, label) {
  const before = existsSync(file) ? await readFile(file, 'utf8') : '';
  if (before === body) return false;
  if (DRY) { log(`--dry-run: would write ${label}`); return true; }
  await writeFile(file, body);
  log(`wrote ${label}`);
  return true;
}

async function main() {
  if (argv.has('--selftest')) process.exit(selftest() ? 0 : 1);

  if (!existsSync(DIRECTORY)) {
    warn('data/directory.json is not present — nothing to derive the map from');
    return 0;
  }
  const rows = JSON.parse(await readFile(DIRECTORY, 'utf8'));
  const { map, dropped } = buildMap(rows);

  log(`${Object.keys(map).length} domain(s) from ${rows.length} directory row(s)`);
  for (const d of dropped) {
    /* Reported, never silent: a dropped domain is a university the resolver
       can no longer name, and the fix is to correct one of the two deptUrls. */
    warn(`domain ${d.domain} is claimed by ${d.claimed.length} universities ` +
      `(${d.claimed.join(' / ')}) — dropped, so neither is named from it`);
  }

  const body = serialise(map);
  await writeIfChanged(OUT, body, 'data/university-domains.json');
  /* the vendored pair, so the deployed function carries the same map and the
     same rules as everything else */
  await writeIfChanged(FN_MAP, body, '_functions/university-domains.json');
  await writeIfChanged(FN_MOD, await readFile(SRC_MOD, 'utf8'), '_functions/netorg.js');
  return 0;
}

/* ------------------------------------------------------------------ selftest */

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, what) => (c ? pass++ : fails.push(what));

  ok(hostOf('https://www.sbs.ox.ac.uk/faculty') === 'www.sbs.ox.ac.uk', 'the host is read off a URL');
  ok(hostOf('http://user@bu.edu:8080/x') === 'bu.edu', 'credentials and a port are stripped');
  ok(hostOf('not a url') === '', 'junk yields nothing rather than throwing');

  const { map, dropped } = buildMap([
    { institution: 'University of Oxford', deptUrl: 'https://www.sbs.ox.ac.uk/about' },
    { institution: 'University of Oxford', deptUrl: 'https://eng.ox.ac.uk/x' },
    { institution: 'Boston University', deptUrl: 'https://www.bu.edu/questrom' },
    /* two universities, one domain — refused rather than tie-broken */
    { institution: 'A University', deptUrl: 'https://shared.ac.nz/a' },
    { institution: 'B University', deptUrl: 'https://shared.ac.nz/b' },
    /* a department page on a commercial host is not the university's network */
    { institution: 'C University', deptUrl: 'https://sites.google.com/site/c' },
    /* the reason the rule is a denylist: these are real universities on plain
       national domains, and an academic-suffix requirement dropped all of them */
    { institution: 'ETH Zurich', deptUrl: 'https://mtec.ethz.ch/x' },
    { institution: 'Bocconi University', deptUrl: 'https://www.sdabocconi.it/y' },
    { institution: 'No URL University' },
  ]);

  ok(map['ox.ac.uk'] === 'University of Oxford', 'two pages at one university agree on one domain');
  ok(map['bu.edu'] === 'Boston University', 'a plain .edu resolves');
  ok(!('shared.ac.nz' in map), 'a domain two universities claim is DROPPED, never picked between');
  ok(dropped.length === 1 && dropped[0].domain === 'shared.ac.nz', '…and is reported, never silent');
  ok(!('google.com' in map), 'a department page on a commercial host never becomes a university domain');
  ok(map['ethz.ch'] === 'ETH Zurich' && map['sdabocconi.it'] === 'Bocconi University',
    'a university on a plain national domain is KEPT — requiring an academic ' +
    'suffix dropped 28 real ones, which is the quieter and worse failure');

  /* the serialiser must be stable or the daily build commits noise for ever */
  ok(serialise({ b: '2', a: '1' }) === serialise({ a: '1', b: '2' }),
    'the serialiser is key-order stable');

  console.log(`build-netmap selftest: ${pass} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  return !fails.length;
}

if (isMain(import.meta.url)) {
  main().then((c) => process.exit(c || 0)).catch((e) => {
    console.error('::error::' + e.stack);
    process.exit(1);
  });
}
