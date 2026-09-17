#!/usr/bin/env node
/**
 * THE RULES MUST FIT FIRESTORE'S EVALUATION BUDGET.
 *
 * Firestore evaluates at most 1000 expressions per request, and a request it
 * cannot finish evaluating is answered with **permission-denied** -- the same
 * answer a rule that refuses the write gives. So a ruleset that grows past
 * that ceiling does not fail loudly: every affected write starts bouncing, and
 * from the site it looks exactly like a rule saying no.
 *
 * That is what happened. `str()` resolved `request.resource.data[field]` four
 * times and was called two dozen times per write, so by 2026-09-17 a job
 * posting cost more than 1000 expressions and EVERY posting made through the
 * form was refused -- for two weeks, in every browser, whoever was signed in,
 * while the form reported a cause of its own invention. A candidate profile
 * was over the same ceiling. Nothing in the repository could see it: the
 * offline suite reads the rules as TEXT, and text cannot tell you what an
 * expression costs.
 *
 * Only the real engine can, so this asks it. For every collection the site
 * lets a person write, it builds the LARGEST document that form can produce --
 * every optional field present, every list at its cap, the nested talks map on
 * all four days -- and requires the create to be ACCEPTED. A field added to a
 * form, or a bound added to a rule, that pushes the cost back over the ceiling
 * fails here, which is a red check rather than a silent outage.
 *
 * It also asserts the negative on each collection: an unverified password
 * account must still be REFUSED. Without that this guard could be satisfied by
 * making the rules permissive, which is the opposite of the point.
 *
 * Run: firebase emulators:exec --project demo-oa-rules --only firestore \
 *        "node _functions/test/rules-budget.mjs"
 * Without Java or firebase-tools it prints SKIPPED and exits 0, except under
 * CI, where a skip is a failure (page-test.mjs's rule: a guard that reports
 * green having run nothing is worse than no guard).
 */

import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const requireFn = createRequire(import.meta.url);

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '';
if (!HOST) {
  console.log('rules-budget: SKIPPED (no FIRESTORE_EMULATOR_HOST; run under firebase emulators:exec)');
  if (process.env.CI) {
    console.log('::error::rules-budget skipped under CI: the emulator did not start.');
    process.exit(1);
  }
  process.exit(0);
}

let RUT, firebase;
try {
  RUT = requireFn('@firebase/rules-unit-testing');
  firebase = requireFn('firebase/compat/app');
  requireFn('firebase/compat/firestore');
} catch (err) {
  console.log('rules-budget: SKIPPED (npm ci --prefix _functions first)');
  if (process.env.CI) {
    console.log('::error::rules-budget skipped under CI: its dependencies are missing.');
    process.exit(1);
  }
  process.exit(0);
}

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-oa-rules';
const UID = 'budget-uid-00000000000000001';
const EMAIL = 'budget.person@example.edu';

let checks = 0, fails = 0;
const ok = (cond, what, extra) => {
  checks++;
  if (cond) console.log('  ok   ' + what);
  else { fails++; console.log('  FAIL ' + what + (extra ? '\n         ' + String(extra).slice(0, 300) : '')); }
};

const pad = (n) => 'x'.repeat(n);

/**
 * The largest document each form can send. Where a bound exists the value is
 * AT it, and every optional field is present: the guard is about the worst
 * case, since that is the one that goes over the ceiling first.
 */
function maximal(FV) {
  return {
    jobSubmissions: {
      institution: pad(160), school: pad(160), unit: pad(160), department: pad(220),
      country: pad(60), type: 'Business School',
      levels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      characteristics: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'],
      applyByDate: '2026-11-15', untilFilled: false, reviewDate: '2026-10-01',
      year: 2027, applyByNote: pad(300), comments: pad(1200),
      chairName: pad(120), chairEmail: pad(150) + '@e.edu', note: pad(1200),
      firstName: pad(80), lastName: pad(80), email: pad(150) + '@e.edu',
      postedAtUrl: 'https://example.edu/' + pad(400),
      adUploadPath: 'jobAdverts/' + UID + '/' + pad(300) + '.pdf',
      adUploadName: pad(180) + '.pdf', adUploadType: 'application/pdf',
      adUploadSize: 2400000, adUrl: '',
      ref: 'OA-JOB-260917-AB12', uid: UID, authEmail: pad(150) + '@e.edu',
      status: 'queued', source: 'oa-form', createdAt: FV.serverTimestamp(),
    },
    candidateSubmissions: {
      first: pad(100), last: pad(100), affiliation: pad(220), position: pad(160),
      institution: pad(220), school: pad(220), unit: pad(220),
      researchAreas: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      informsDays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday'],
      /* every day a candidate can present on, each at its bounds: the most
         expensive shape the profile form can produce */
      talks: {
        Sunday: { at: '10:45', session: pad(40), room: pad(120), title: pad(200) },
        Monday: { at: '11:45', session: pad(40), room: pad(120), title: pad(200) },
        Tuesday: { at: '12:45', session: pad(40), room: pad(120), title: pad(200) },
        Wednesday: { at: '13:45', session: pad(40), room: pad(120), title: pad(200) },
      },
      cvUrl: 'https://example.edu/' + pad(400),
      rsUrl: 'https://example.edu/' + pad(400),
      webUrl: 'https://example.edu/' + pad(400),
      email: pad(150) + '@e.edu', personalEmail: pad(150) + '@e.edu',
      note: pad(1200), emailPublic: true, updatedAt: '2026-09-17',
      cvUploadPath: 'cvs/' + UID + '/' + pad(300) + '.pdf',
      cvUploadName: pad(180) + '.pdf', cvUploadType: 'application/pdf',
      rsUploadPath: 'rs/' + UID + '/' + pad(300) + '.pdf',
      rsUploadName: pad(180) + '.pdf', rsUploadType: 'application/pdf',
      year: 2027, ref: 'OA-CAND-260917-AB12', uid: UID,
      authEmail: pad(150) + '@e.edu', status: 'queued', source: 'oa-form',
      createdAt: FV.serverTimestamp(),
    },
    placementSubmissions: {
      first: pad(100), last: pad(100), phdInstitution: pad(220),
      undergradInstitution: pad(220), joiningInstitution: pad(220),
      joiningPosition: pad(160), webUrl: 'https://example.edu/' + pad(400),
      email: pad(150) + '@e.edu', note: pad(1200),
      year: 2027, ref: 'OA-PLAC-260917-AB12', uid: UID,
      authEmail: pad(150) + '@e.edu', status: 'queued', source: 'oa-form',
      createdAt: FV.serverTimestamp(),
    },
  };
}

async function main() {
  const rulesPath = path.join(ROOT, '_firestore.rules');
  if (!existsSync(rulesPath)) {
    console.log('::error::_firestore.rules not found');
    process.exit(1);
  }
  const rules = readFileSync(rulesPath, 'utf8');
  const [host, port] = HOST.split(':');
  const env = await RUT.initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules, host, port: Number(port) },
  });
  if (!firebase.apps.length) firebase.initializeApp({ projectId: PROJECT });
  const FV = firebase.firestore.FieldValue;

  const as = (verified) => env.authenticatedContext(UID, {
    email: EMAIL, email_verified: verified,
    firebase: { sign_in_provider: 'password' },
  }).firestore();

  const create = async (fs, coll, doc) => {
    try { await fs.collection(coll).add(doc); return null; }
    catch (err) { return (err && (err.code || err.message)) || String(err); }
  };

  console.log('rules-budget: the largest document each form can send');
  const docs = maximal(FV);
  for (const [coll, doc] of Object.entries(docs)) {
    const err = await create(as(true), coll, doc);
    ok(!err,
      `${coll}: a verified account may create its LARGEST document (${Object.keys(doc).length} keys)`,
      err && (err + ' — if this is permission-denied with no rule refusing it, the '
        + 'ruleset has gone past Firestore’s 1000-expression budget: make the '
        + 'shape checks cheaper (one map lookup per field), do not relax them'));
  }

  /* THE NEGATIVE, so the guard cannot be satisfied by permissive rules. */
  for (const [coll, doc] of Object.entries(docs)) {
    const err = await create(as(false), coll, doc);
    ok(!!err, `${coll}: and an UNVERIFIED password account still may not`);
  }

  await env.cleanup();
  console.log(`rules-budget: ${checks} checks, ${fails} failed`);
  if (fails) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
