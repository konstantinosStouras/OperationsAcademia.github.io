/* ---------------------------------------------------------------------------
   Operations Academia — the whole data build, in ONE place.

       node _scraper/build-all.mjs [--dry-run]

   It runs the builders in the order they depend on each other: the three
   that read Firestore (postings, candidates, placements), then the
   Universities directory, which is offline and reads the files they just
   rewrote, then the university domain map, which is derived from the
   directory in turn.

   WHY THIS EXISTS, rather than four steps in oa-jobs-build.yml as before.
   The commit step has to be able to RE-RUN the build. `data/` is generated,
   so when a concurrent writer moves the branch on and our push is rejected
   there is nothing to rebase: the recovery is to discard our commit, take
   their tip, and rebuild on top of it. A workflow step cannot re-run the
   steps before it — so as long as "what a build is" lived in the YAML, the
   retry could not perform one, and it reached for `git pull --rebase`
   instead. That asks git to reconcile two independently GENERATED copies of
   data/jobs-meta.json, which carries a timestamp: the same lines always
   differ, so it conflicted by construction (2026-08-26), and where it had
   SUCCEEDED it would have been worse — pushing a snapshot built before the
   other writer's commit, dropping their rows.

   So the build is one script and the workflow calls it twice: once as its
   own step, and again from inside the retry loop. One definition, no drift.

   RE-RUNNING IS SAFE, and not by luck — the build already runs on a
   20-minute schedule, on a repository_dispatch and on a workflow_run, so
   running it twice in quick succession is its ordinary life:
     - every builder REPLACES data/ from its sources, so a second pass over
       unchanged inputs writes byte-identical files and commits nothing;
     - `transferUploads` files an advert into Drive only while the document
       still has `adUploadPath && !adUrl`, so a transferred file is not
       pending on the next pass;
     - the "what changed" e-mail diffs the PREVIOUS SERVED FILE against the
       one about to be written, so rebuilding on the new tip makes it more
       accurate rather than duplicating it: what the other writer already
       published is no longer a change.

   THE FIREBASE GATE IS THE WORKFLOW'S, KEPT: without the service account the
   three Firestore builders have nothing to read and are skipped, while the
   directory build — which reads only committed files — always runs. That is
   exactly the `if: steps.gate.outputs.ready == 'true'` the four steps
   carried, moved into the one place that now decides.
   --------------------------------------------------------------------------- */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMain } from './_main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The build, in dependency order. `needsFirebase` mirrors the workflow gate
    each of these steps used to carry. */
export const BUILDERS = [
  { script: 'build-jobs.mjs', label: 'job postings', needsFirebase: true },
  { script: 'build-candidates.mjs', label: 'candidate profiles', needsFirebase: true },
  { script: 'build-placements.mjs', label: 'confirmed placements', needsFirebase: true },
  /* AFTER THE THREE, and never gated: it reads only the files they just
     rewrote plus the committed archive and seed, so a posting from a
     university the directory does not carry creates its card in the same run
     that published the posting. */
  { script: 'build-directory.mjs', label: 'the Universities directory', needsFirebase: false },
  /* AFTER the directory, because it is DERIVED from it: the domain a visitor's
     network is matched against is the host of a department's own page, so a
     university that gained a card in this very run can be recognised from its
     network from this run on. Offline and ungated for the same reason as the
     directory — it reads a committed file and writes two. */
  { script: 'build-netmap.mjs', label: 'the university domain map', needsFirebase: false },
  /* The browser modules the Cloud Functions also read (the season rule, the
     forum's shape, guard and guide), COPIED under _functions/ because a
     deploy ships that directory alone. Offline and ungated; an unchanged
     module writes nothing. The selftest pins every pair byte-for-byte. */
  { script: 'build-functions-vendor.mjs', label: 'the vendored Functions modules', needsFirebase: false },
];

/** Which builders a given environment can actually run. Pure, so the selftest
    can hold it to the gate the workflow used to apply per step. */
export function plan({ firebase = false } = {}) {
  return BUILDERS.filter((b) => !b.needsFirebase || firebase);
}

export function buildAll(args = [], { firebase = false, run = null } = {}) {
  const chosen = plan({ firebase });
  const skipped = BUILDERS.length - chosen.length;
  if (skipped) {
    console.log(`Firebase is not configured — skipping ${skipped} builder(s) that ` +
      'read Firestore. See _SETUP-FIREBASE.md');
  }

  for (const b of chosen) {
    /* A heading per builder, because folding four workflow steps into one
       costs the four headings the Actions UI drew. The log is what anyone
       reads when a build misbehaves; it must not get harder to follow. */
    console.log(`\n=== ${b.label} (${b.script}) ===`);
    const res = (run || spawnSync)(
      process.execPath, [path.join(HERE, b.script), ...args], { stdio: 'inherit' });
    /* A builder that could not be STARTED (spawn error) is a failure too —
       `status` is null there, and treating null as "not non-zero" would
       report a build that never ran as a success, which is this
       repository's least favourite failure shape. */
    if (res.error) {
      console.error(`::error::${b.script} could not be started: ${res.error.message}`);
      return 1;
    }
    if (res.status !== 0) {
      console.error(`::error::${b.script} exited ${res.status ?? 'on a signal'} — ` +
        'the build is incomplete, so nothing should be committed');
      return res.status || 1;
    }
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(buildAll(process.argv.slice(2), {
    firebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
  }));
}
