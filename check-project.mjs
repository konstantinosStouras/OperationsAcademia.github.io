#!/usr/bin/env node
/* ==========================================================================
   Operations Academia · check-project.mjs
   A predeploy guard: refuse to deploy this project's rules or Functions into
   a Firebase project that is not this one.

   WHY THIS EXISTS, and it is not hypothetical — it has now happened twice.
   This repository and its sibling konstantinosStouras.github.io hold seven
   unrelated Firebase projects side by side. The
   Firebase CLI resolves the target from, in order: the --project flag, the
   FIREBASE_PROJECT env var, the "active project" it remembers PER DIRECTORY
   in its own global config, and only then the default alias in .firebaserc.
   The remembered active project wins over .firebaserc, is invisible in the
   repository, and survives between sessions — so `firebase deploy --only
   firestore:rules` run in THIS directory can publish THIS file set into
   ANOTHER project's database and report a clean success.

   Twice the victim was Answer Arena: once from search-v2, and once from
   OperationsAcademia.github.io, whose rules end in a deny-all catch-all and
   named none of Answer Arena's collections — so every read and write in that
   app was refused until its own rules were re-published.

   The CLI exports GCLOUD_PROJECT to every predeploy hook, so the target is
   knowable before anything is uploaded. This compares it with the default
   alias in .firebaserc and exits non-zero on a mismatch, which aborts the
   deploy. An older CLI that exports nothing is allowed through with a warning
   rather than blocking a legitimate deploy.

   Run standalone to see what this directory would deploy to:
     node check-project.mjs
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

function expected() {
  const rc = JSON.parse(readFileSync(join(root, '.firebaserc'), 'utf8'));
  const id = rc && rc.projects && rc.projects.default;
  if (!id) throw new Error('.firebaserc has no default project');
  return id;
}

const want = expected();
const got = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || '';

if (!got) {
  console.warn('check-project: the CLI exported no project id, so the target could not be verified.');
  console.warn('check-project: expected "' + want + '" — pass --project ' + want + ' to be certain.');
  process.exit(0);
}

if (got !== want) {
  console.error('');
  console.error('  ✗ DEPLOY REFUSED — wrong Firebase project.');
  console.error('');
  console.error('      this directory belongs to : ' + want);
  console.error('      the deploy is targeting   : ' + got);
  console.error('');
  console.error('  Publishing here would overwrite another project\'s rules or functions.');
  console.error('  The CLI is remembering a different active project for this folder.');
  console.error('  Fix it, then deploy:');
  console.error('');
  console.error('      firebase use ' + want);
  console.error('      firebase deploy --only firestore:rules --project ' + want);
  console.error('');
  process.exit(1);
}

console.log('check-project: deploying to ' + got + ' ✓');
