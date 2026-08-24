/* ---------------------------------------------------------------------------
   Operations Academia — build data/directory.json, the Universities directory.

   OFFLINE AND DETERMINISTIC. It reads only files already committed —
   data/universities.json (the curated archive), data/jobs.json and
   data/past-postings.json (every posting), and the oa-institutions.js seed —
   so it needs no credentials, runs in any environment, and a run over
   unchanged inputs writes byte-identical files and commits nothing. The
   model (what merges with what, and why) lives in directory-model.mjs.

   It runs as the last step of oa-jobs-build.yml: the build has just rewritten
   jobs.json, so a posting from a university the directory does not carry
   creates its row — and with it a new card on universities.html — in the same
   run that published the posting. That is the owner's rule (2026-08-24):
   every job posting fits under a pre-existing card, and if none fits, a new
   card is created from the posting's own information.

       node _scraper/build-directory.mjs [--dry-run]

   WHAT IT DELIBERATELY DOES NOT READ: Firestore. The signed-in corrections
   (`directoryEdits`) are an overlay the PAGE applies at read time
   (assets/oa-directory.js), exactly like rowOverrides on the frozen archives
   — the committed file stays the source of truth, and rebuilding it can
   never undo anyone's correction.
   --------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildDirectory, directoryStats } from './directory-model.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DRY = process.argv.includes('--dry-run');

async function readJson(rel, fallback) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));
  } catch (err) {
    if (fallback !== undefined) {
      console.warn(`::warning::build-directory: could not read ${rel} (${err.message}) — continuing without it`);
      return fallback;
    }
    throw err;
  }
}

async function main() {
  // the archive is REQUIRED — without it the directory would silently shrink
  // to the postings alone and the map's pins would lose their rows' twins
  const archive = await readJson('data/universities.json');
  const jobs = await readJson('data/jobs.json', []);
  const past = await readJson('data/past-postings.json', []);
  const seed = require('../assets/oa-institutions.js').directoryRows();
  const omlist = require('../assets/oa-omlist.js').directoryRows();

  const { rows } = buildDirectory({ archive, seed, jobs, past, omlist });
  const stats = directoryStats(rows);

  const body = JSON.stringify(rows, null, 1) + '\n';
  const meta = JSON.stringify(stats, null, 1) + '\n';

  console.log(`directory: ${stats.count} rows — ${stats.universities} universities, ` +
    `${stats.departments} department rows`);

  if (DRY) {
    console.log('dry run — nothing written');
    return;
  }
  await writeFile(path.join(ROOT, 'data', 'directory.json'), body);
  await writeFile(path.join(ROOT, 'data', 'directory-meta.json'), meta);
}

main().catch((err) => {
  console.error('::error::build-directory failed: ' + (err && err.stack || err));
  process.exit(1);
});
