#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — does every posting name the country it is actually in?

   WHY THIS EXISTS. `country` is free text on the posting form and it is what
   the jobs page's Location filter groups by, so a wrong one does not look
   wrong: the posting simply files itself under a country it has nothing to do
   with, and nobody filtering by the right one ever sees it. Nine live postings
   were published under GREECE — American, Canadian and Singaporean
   universities — because the Edit form's `country` box carried no
   `autocomplete` attribute and a browser filled it from the editor's own
   address profile. Nothing on the site said so; the postings just quietly
   stopped being findable.

   THE AUTHORITY IS THE SITE'S OWN. data/universities.json carries each
   campus's postal address, and `countryFromAddress` reads the country off it;
   `campusCountries` in vocab.mjs turns that into one answer per university and
   deliberately has NO answer where a university's own rows disagree (INSEAD is
   in France and in Singapore). So this asks each posting a question the site
   can answer from what it already knows, and stays quiet about the rest.

   IT IS A REPORT, not a repair. build-jobs.mjs heals what it finds on every
   run (healCountry); this is how a person SEES the state of it — before a
   change, after one, or when a filter looks emptier than it should.

   Modes:
     (default)   report every disagreement, and exit 1 if there is one
     --all       also list the postings this has no authority for
     --json      machine-readable, for a workflow step
   --------------------------------------------------------------------------- */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { campusCountries, SCHOOLS } from './vocab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');

const argv = new Set(process.argv.slice(2));
const ALL = argv.has('--all');
const JSON_OUT = argv.has('--json');

/** Every served dataset that carries a country, in the order a reader meets
    them: the live postings first, then the workbook, then the archive. */
const FILES = ['jobs.json', 'jobmarket.json', 'past-postings.json'];

async function readRows(file) {
  const at = path.join(DATA, file);
  if (!existsSync(at)) return [];
  try {
    const parsed = JSON.parse(await readFile(at, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function main() {
  const directory = await readRows('universities.json');
  const byUni = campusCountries(directory);

  const wrong = [];
  const empty = [];
  const unknown = new Map();
  let checked = 0;

  for (const file of FILES) {
    for (const row of await readRows(file)) {
      const institution = row.institution || '';
      if (!institution) continue;
      const want = byUni.get(SCHOOLS.institutionKey(institution));
      if (!want) {
        const k = SCHOOLS.institutionKey(institution);
        if (!unknown.has(k)) unknown.set(k, { institution, rows: 0 });
        unknown.get(k).rows++;
        continue;
      }
      checked++;
      if (!row.country) empty.push({ file, id: row.id, institution, want });
      else if (row.country !== want) {
        wrong.push({ file, id: row.id, institution, says: row.country, want });
      }
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ checked, wrong, empty,
      unknown: [...unknown.values()] }, null, 1));
    return wrong.length ? 1 : 0;
  }

  console.log(`country audit: ${checked} posting(s) checked against ` +
              `${byUni.size} universities the site can place`);

  for (const w of wrong) {
    console.log(`::error::${w.file}: ${w.institution} is in ${w.want}, but the posting ` +
                `says ${w.says} (${w.id})`);
  }
  for (const e of empty) {
    console.log(`::warning::${e.file}: ${e.institution} names no country at all — ` +
                `it is in ${e.want} (${e.id})`);
  }

  if (ALL && unknown.size) {
    console.log(`\n${unknown.size} universities have no address on the site, so their ` +
                'postings cannot be checked. Map them in the Universities sheet, or add ' +
                'the campus country to CAMPUS_COUNTRY in _scraper/vocab.mjs:');
    for (const u of [...unknown.values()].sort((a, b) => b.rows - a.rows)) {
      console.log(`   ${u.institution}  (${u.rows} posting${u.rows === 1 ? '' : 's'})`);
    }
  }

  if (!wrong.length && !empty.length) {
    console.log('every posting the site can place names the country it is in.');
  }
  return wrong.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
